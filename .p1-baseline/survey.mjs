#!/usr/bin/env node
/**
 * 数据库体检：确认作品/章节规模，用于选取基线数据。
 * 用法: node survey.mjs [dbPath]
 *
 * ⚠️ **只读打开**（2026-09-16 改）：这是纯诊断工具，只会 SELECT，
 * 但此前用 `new DatabaseSync(path)` 默认是**读写**打开——在真实库上会拿写锁、
 * 还可能创建 `-wal`/`-shm` 边车文件。诊断工具不该对数据有任何写权限。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const dbPath = process.argv[2] || '.p1-baseline/data/novel.db';
if (!fs.existsSync(dbPath)) {
  console.error(`库不存在：${dbPath}`);
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`库: ${dbPath}`);
console.log(`表(${tables.length}): ${tables.join(', ')}\n`);

const countOf = (t) => {
  if (!tables.includes(t)) return '(无此表)';
  return db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
};

const interesting = [
  'works', 'volumes', 'plotlines', 'chapters', 'characters', 'character_relations',
  'world_entries', 'story_events', 'story_memories', 'memory_versions',
  'story_memory_proposals', 'chapter_reviews', 'chapter_save_versions', 'harness_jobs',
];
for (const t of interesting) console.log(`  ${t.padEnd(24)} ${countOf(t)}`);

console.log('\n--- works ---');
for (const w of db.prepare('SELECT * FROM works ORDER BY id').all()) {
  console.log(`  #${w.id}  ${w.title}`);
  console.log(`      created=${w.created_at}  updated=${w.updated_at}  目标字数=${w.default_chapter_words}  总章数=${w.total_chapters}`);
  const c = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(content)),0) AS n FROM chapters WHERE work_id = ?').get(w.id);
  const ch = db.prepare('SELECT COUNT(*) AS c FROM characters WHERE work_id = ?').get(w.id);
  const we = db.prepare('SELECT COUNT(*) AS c FROM world_entries WHERE work_id = ?').get(w.id);
  const ev = db.prepare('SELECT COUNT(*) AS c FROM story_events WHERE work_id = ?').get(w.id);
  console.log(`      章节 ${c.c} 篇 / 正文 ${c.n} 字 ｜ 角色 ${ch.c} ｜ 词条 ${we.c} ｜ 事件 ${ev.c}`);
}

console.log('\n--- chapters ---');
for (const c of db.prepare('SELECT id, work_id, position, title, LENGTH(content) AS n FROM chapters ORDER BY work_id, position').all()) {
  console.log(`  work#${c.work_id} pos${String(c.position).padStart(3)}  chapter#${String(c.id).padStart(4)}  ${String(c.n).padStart(6)} 字  ${c.title}`);
}

if (tables.includes('chapter_reviews')) {
  console.log('\n--- chapter_reviews（最近 10）---');
  for (const r of db.prepare('SELECT id, work_id, chapter_id, status, created_at FROM chapter_reviews ORDER BY id DESC LIMIT 10').all()) {
    console.log(`  #${r.id} work#${r.work_id} chapter#${r.chapter_id} status=${r.status} ${r.created_at}`);
  }
}
if (tables.includes('harness_jobs')) {
  console.log('\n--- harness_jobs（最近 10）---');
  for (const r of db.prepare('SELECT id, work_id, chapter_id, status, kind, created_at FROM harness_jobs ORDER BY id DESC LIMIT 10').all()) {
    console.log(`  #${r.id} work#${r.work_id} chapter#${r.chapter_id} ${r.status} kind=${r.kind} ${r.created_at}`);
  }
}

if (tables.includes('app_settings')) {
  console.log('\n--- OpenViking 索引状态 ---');
  console.log('  works.ov_uri:');
  for (const w of db.prepare('SELECT id, title, ov_uri FROM works ORDER BY id').all()) {
    console.log(`    #${w.id}  ov_uri=${JSON.stringify(w.ov_uri)}  ${w.title}`);
  }
  console.log('  app_settings:');
  for (const r of db.prepare('SELECT key, value FROM app_settings ORDER BY key').all()) {
    console.log(`    ${r.key} = ${String(r.value).slice(0, 100)}`);
  }
}

// ── 埋点表的孤儿行诊断（2026-09-15 自审发现）─────────────────────────────
// `ai_eval_events.work_id/chapter_id` 是**裸 INTEGER**，没有像其它作品域表那样写
// `REFERENCES works(id) ON DELETE CASCADE`。后果：删作品后埋点行留下，谁也够不到它们，
// 而 `GET /api/ai/eval`（不带 work_id）会把它们算进全局采纳率/平均编辑距离 → 数字被不存在的作品带偏。
// 这里只**诊断不判定**：删作品是否该连带删埋点属语义选择，等作者决定（见 docs/pending-decisions.md）。
if (tables.includes('ai_eval_events')) {
  console.log('\n--- ai_eval_events（埋点）---');
  const total = countOf('ai_eval_events');
  const orphanWork = db.prepare(
    'SELECT COUNT(*) AS c FROM ai_eval_events WHERE work_id IS NOT NULL AND work_id NOT IN (SELECT id FROM works)'
  ).get().c;
  const orphanChapter = tables.includes('chapters') ? db.prepare(
    'SELECT COUNT(*) AS c FROM ai_eval_events WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT id FROM chapters)'
  ).get().c : 0;
  console.log(`  总行数 ${total}　孤儿(作品已删) ${orphanWork}　孤儿(章节已删) ${orphanChapter}`);
  console.log(`  行动统计: ${db.prepare("SELECT action, COUNT(*) AS c FROM ai_eval_events GROUP BY action").all().map((r) => `${r.action}=${r.c}`).join(' ') || '(空)'}`);
  if (orphanWork || orphanChapter) {
    console.log('  ⚠ 有孤儿行：全局聚合（不带 work_id）会把它们算进去。详见 docs/pending-decisions.md D6。');
  } else {
    console.log('  ✓ 无孤儿行');
  }
}

db.close();
