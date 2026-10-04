import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const r = db.prepare("SELECT id, chapter_id, created_at, length(content) AS len, substr(content,1,400) AS head FROM chapter_save_versions WHERE id = 66").get();
console.log(`draft#66 ch=${r.chapter_id} ${r.created_at} len=${r.len}\n--- 开头 400 字 ---\n${String(r.head).replace(/\n/g, ' ⏎ ')}`);
console.log('\n--- 今天 11:40Z 之后有没有别的版本/草稿行 ---');
for (const v of db.prepare("SELECT id, chapter_id, kind, created_at, length(content) AS len FROM chapter_save_versions WHERE created_at >= '2026-10-04T11:40:00' ORDER BY id").all()) console.log(` #${v.id} ch=${v.chapter_id} ${v.kind} ${v.created_at} len=${v.len}`);
db.close();
