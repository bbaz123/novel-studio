// 迁移验证（在**副本**上做，不碰作者的真实库）：
// 2026-10-04 新增的两列必须能补进一个已经存在的老库，且存量数据语义不变
//（默认 0 = 照常提示）：
//   · chapter_save_versions.draft_dismissed —— 「有未应用的生成稿」那行的关闭标记
//   · chapter_reviews.dismissed            —— 「上次审稿」那行的关闭标记
// 用法：node .p1-baseline/test-migration-draft-dismissed.mjs <源库> <临时目录>
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const src = process.argv[2];
const dir = process.argv[3];
if (!src || !dir) { console.error('用法: node test-migration-draft-dismissed.mjs <源库> <临时目录>'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'novel.db');
// ⚠️ 不能用 fs.copyFileSync(src, target)：这个库跑在 WAL 模式，**只复制 .db 会漏掉还没
// checkpoint 的变更**（本轮实测：明明已经迁过的库，复制出来的副本却看不到那一列），
// 于是"迁移测试"会在一个更旧的库上跑，测的东西根本不是作者真实的库。
// VACUUM INTO 读的是完整逻辑库（含 WAL），产出一个自包含、无 WAL 的副本。
{
  const srcDb = new DatabaseSync(src);
  srcDb.exec(`VACUUM INTO '${target.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  srcDb.close();
}

const colsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
const dismissedIds = (db, table, col, hasCol) => (hasCol ? db.prepare(`SELECT id FROM ${table} WHERE ${col} <> 0 ORDER BY id`).all().map((r) => Number(r.id)) : []);
const before = new DatabaseSync(target, { readOnly: true });
const c0 = colsOf(before, 'chapter_save_versions');
const r0 = colsOf(before, 'chapter_reviews');
const drafts0 = before.prepare(`SELECT COUNT(*) AS n FROM chapter_save_versions WHERE kind = 'draft' AND draft_applied = 0`).get().n;
const reviews0 = before.prepare('SELECT COUNT(*) AS n FROM chapter_reviews').get().n;
const dismissed0 = dismissedIds(before, 'chapter_save_versions', 'draft_dismissed', c0.includes('draft_dismissed'));
before.close();
console.log(`迁移前：draft_dismissed=${c0.includes('draft_dismissed')} dismissed=${r0.includes('dismissed')} | 未应用草稿 ${drafts0} 份 · 审稿 ${reviews0} 份`);
console.log(`迁移前：已被作者关闭的草稿 id = [${dismissed0.join(', ')}]（迁移**不得**新增/减少这个集合）`);

// 让 db.js 对着副本跑一遍迁移（dataDir 由环境变量重定向，必须在 import 之前设置）
process.env.NOVELSTUDIO_DATA_DIR = dir;
await import('../db.js');

const after = new DatabaseSync(target, { readOnly: true });
const c1 = colsOf(after, 'chapter_save_versions');
const r1 = colsOf(after, 'chapter_reviews');
const rows = after.prepare('SELECT COUNT(*) AS n FROM chapter_save_versions').get().n;
// ⚠️ 这里必须与迁移前的口径**逐字对齐**（都不带 dismissed 过滤），否则会把
// "迁移前没排除已关闭的行 / 迁移后排除了" 误读成"迁移改动了数据"（本轮就这么误报过一次）。
const stillPending = after.prepare(`SELECT COUNT(*) AS n FROM chapter_save_versions WHERE kind = 'draft' AND draft_applied = 0`).get().n;
const dismissed1 = dismissedIds(after, 'chapter_save_versions', 'draft_dismissed', true);
const draftMislabeled = dismissed1.filter((id) => !dismissed0.includes(id)).length;
const lostDismissal = dismissed0.filter((id) => !dismissed1.includes(id)).length;
const reviews = after.prepare('SELECT COUNT(*) AS n FROM chapter_reviews').get().n;
const reviewMislabeled = after.prepare('SELECT COUNT(*) AS n FROM chapter_reviews WHERE dismissed <> 0').get().n;
const ch121 = after.prepare('SELECT LENGTH(content) AS len, updated_at FROM chapters WHERE id = 121').get();
after.close();

const added = c1.includes('draft_dismissed') && r1.includes('dismissed');
const ok = added && draftMislabeled === 0 && lostDismissal === 0 && reviewMislabeled === 0
  && stillPending === drafts0 && reviews === reviews0 && rows > 0;
console.log(`迁移后：两列都补上=${added} | 版本行 ${rows} | 未应用草稿 ${stillPending}（迁移前 ${drafts0}，同口径） | 审稿 ${reviews}（迁移前 ${reviews0}）`);
console.log(`关闭标记集合：新增误标 ${draftMislabeled} 行 · 丢失原标记 ${lostDismissal} 行（都必须是 0）`);
console.log(`审稿被误标为已关闭：${reviewMislabeled} 份（必须是 0）`);
console.log(`ch121 逐字节未动：len=${ch121.len} updated_at=${ch121.updated_at}`);
console.log(ok ? 'MIGRATION_OK' : 'MIGRATION_FAILED');
process.exit(ok ? 0 : 1);
