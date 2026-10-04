import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('== work 18 章节正文长度（找有没有被清空的） ==');
const rows = db.prepare(`SELECT id, title, LENGTH(COALESCE(content,'')) AS bytes, updated_at FROM chapters WHERE work_id = 18 AND parent_id IS NULL ORDER BY position, id`).all();
for (const r of rows) console.log(` ch${r.id} ${String(r.title).slice(0,28).padEnd(30)} bytes=${String(r.bytes).padStart(6)} updated=${r.updated_at}`);
console.log('\n== 最近的 auto 快照（护栏兜底产物） ==');
const snaps = db.prepare(`SELECT id, chapter_id, kind, created_at, LENGTH(content) AS len FROM chapter_save_versions WHERE created_at >= '2026-10-04' ORDER BY created_at DESC LIMIT 15`).all();
for (const s of snaps) console.log(` #${s.id} ch=${s.chapter_id} ${s.kind} ${s.created_at} len=${s.len}`);
db.close();
