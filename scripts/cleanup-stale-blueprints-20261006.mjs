#!/usr/bin/env node
/**
 * 一次性存量清理（2026-10-06，章节蓝图生命周期改造的第一轮）：删除**已经写完正文**的章节遗留的
 * 章节蓝图，让它们不再被检索索引（server.js 的 queryRows('chapters', …, blueprint_json)）喂给模型。
 *
 * 背景（作者报障）：第一章的旧蓝图（写着"觉醒日一整天"）在它的正文还没落地时就一直在库里，
 * 而第二章的蓝图同样覆盖"觉醒日的夜里"——两章在夜里那段重叠。规划新章时模型读到**别的章节的旧蓝图**，
 * 就拿着旧计划反过来问作者"到底按哪一版写"。
 *
 * 判据（刻意保守）：
 *   · `readableChars(content) > 0` → 这一章已经有真正的正文 → 它的蓝图已完成使命，整章删除；
 *   · 正文为空（含只有 <p><br></p> 这类空标签）→ **保留**：那正是作者接下来要按它成文的现行计划。
 * 所以脚本对"正在写作中的章节"是零操作的。
 *
 * 幂等：只删"有正文 且 还有蓝图"的行；重复运行第二次就是 0 改动。
 *
 * 用法：
 *   node scripts/cleanup-stale-blueprints-20261006.mjs            # 只报告（dry-run）
 *   node scripts/cleanup-stale-blueprints-20261006.mjs --apply    # 真的删除
 *
 * 运行前必须有可回滚备份（本仓库 data/backups/blueprint-rework-<时间戳>/ 下已含逐字节副本 + VACUUM 快照）。
 */
import { db, withTransaction } from '../db.js';

const APPLY = process.argv.includes('--apply');

/** 与前端 readableCharCount / 服务端 readableChars 同一口径：去掉标签与实体后还剩多少可见字符。 */
function readableChars(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, '')
    .length;
}

const rows = db.prepare(`
  SELECT c.id, c.work_id, c.title, c.content,
         (SELECT COUNT(*) FROM chapter_blueprints b WHERE b.chapter_id = c.id) AS bp_rows
  FROM chapters c
  WHERE length(c.blueprint_json) > 0
     OR EXISTS (SELECT 1 FROM chapter_blueprints b WHERE b.chapter_id = c.id)
  ORDER BY c.work_id, c.id
`).all();

const done = [];      // 有正文 → 删
const keep = [];      // 无正文 → 留
for (const r of rows) {
  (readableChars(r.content) > 0 ? done : keep).push(r);
}

console.log(`扫描：有蓝图痕迹的章节 ${rows.length} 章`);
console.log(`  · 已有正文（要删蓝图）：${done.length} 章`);
for (const r of done) console.log(`      #${r.id} work${r.work_id} ${r.title}（历史表 ${r.bp_rows} 行 + 镜像）`);
console.log(`  · 正文为空（保留现行计划）：${keep.length} 章`);
for (const r of keep) console.log(`      #${r.id} work${r.work_id} ${r.title}（历史表 ${r.bp_rows} 行）`);

if (!APPLY) {
  console.log('\n这是 dry-run：加 --apply 才会真的删除。');
  process.exit(0);
}

const result = withTransaction(() => {
  let rowsDeleted = 0;
  let mirrorsCleared = 0;
  for (const r of done) {
    rowsDeleted += Number(db.prepare('DELETE FROM chapter_blueprints WHERE chapter_id = ?').run(r.id).changes) || 0;
    // 镜像（检索索引读的就是这一列）与历史表一起清；刻意不动 updated_at（它是编辑器乐观锁基线）。
    mirrorsCleared += Number(db.prepare("UPDATE chapters SET blueprint_json = '' WHERE id = ? AND blueprint_json <> ''").run(r.id).changes) || 0;
  }
  return { rowsDeleted, mirrorsCleared };
});

console.log(`\n已清理：chapter_blueprints 删除 ${result.rowsDeleted} 行；chapters.blueprint_json 清空 ${result.mirrorsCleared} 章。`);

// 收尾自检：清理后不应再有"有正文却仍带蓝图"的章节。
const left = db.prepare(`
  SELECT c.id, c.title FROM chapters c
  WHERE (length(c.blueprint_json) > 0 OR EXISTS (SELECT 1 FROM chapter_blueprints b WHERE b.chapter_id = c.id))
`).all().filter((r) => {
  const content = db.prepare('SELECT content FROM chapters WHERE id = ?').get(r.id)?.content || '';
  return readableChars(content) > 0;
});
console.log(left.length === 0
  ? '自检通过：已无"有正文却仍留着蓝图"的章节。'
  : `自检未过：仍有 ${left.length} 章 → ${left.map((r) => `#${r.id} ${r.title}`).join('、')}`);
process.exit(left.length === 0 ? 0 : 1);
