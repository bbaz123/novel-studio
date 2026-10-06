// 只读探针（2026-10-05 第七支）：用 T2 修订台账还原 10:32:19 那次正文写入的来源通道。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log('=== story_chapter_revisions 列 ===');
console.log(q('PRAGMA table_info(story_chapter_revisions)').map((c) => c.name).join(', '));

console.log('\n=== 第 119 章最近的修订记录（今天）===');
for (const r of q(`SELECT * FROM story_chapter_revisions WHERE chapter_id = 119 ORDER BY rowid DESC LIMIT 12`)) {
  const o = {};
  for (const k of Object.keys(r)) o[k] = typeof r[k] === 'string' && r[k].length > 120 ? r[k].slice(0, 120) + '…' : r[k];
  console.log(JSON.stringify(o));
}

console.log('\n=== 全作品今天是否有其它写正文通道 ===');
for (const r of q(`SELECT chapter_id, source, COUNT(*) AS n, MAX(created_at) AS latest FROM story_chapter_revisions
                   WHERE created_at >= '2026-10-05' GROUP BY chapter_id, source ORDER BY latest DESC LIMIT 20`)) {
  console.log(JSON.stringify(r));
}
db.close();
