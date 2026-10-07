// 只读探针：查活库里 pending 的长期记忆提案 / 事件提案，以及采纳时会被零损失护栏判成什么样。
// 只读打开数据库，不改任何一行。用法：node .p1-baseline/probe-adopt-blocked-20261006.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'novel.db'), { readOnly: true });

const works = db.prepare('SELECT id, title FROM works ORDER BY id').all();
console.log('作品：', works.map((w) => `${w.id}:${w.title}`).join(' | '));

for (const w of works) {
  const mem = db.prepare(`SELECT id, work_id, status, guard, length(summary) AS len, length(delta) AS dlen, substr(summary,1,80) AS head, created_at
                          FROM story_memory_proposals WHERE work_id = ? ORDER BY id`).all(w.id);
  const ev = db.prepare(`SELECT id, work_id, status, kind, substr(summary,1,60) AS head, created_at
                         FROM story_event_proposals WHERE work_id = ? ORDER BY id`).all(w.id);
  if (!mem.length && !ev.length) continue;
  console.log(`\n=== 作品 #${w.id} ${w.title} ===`);
  console.log('记忆提案：');
  for (const m of mem) console.log(`  #${m.id} status=${m.status} guard=${JSON.stringify(m.guard)} summaryLen=${m.len} deltaLen=${m.dlen} at=${m.created_at} :: ${m.head}`);
  console.log('事件提案：');
  for (const e of ev) console.log(`  #${e.id} status=${e.status} kind=${e.kind} at=${e.created_at} :: ${e.head}`);
}
db.close();
