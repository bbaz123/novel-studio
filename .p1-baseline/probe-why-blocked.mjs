import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('== ch121 现状 ==');
const c = db.prepare('SELECT LENGTH(content) AS n, updated_at FROM chapters WHERE id = 121').get();
console.log(`${c.n} bytes / updated_at=${c.updated_at}`);
console.log('\n== ch121 版本表（最近 8 条）==');
for (const v of db.prepare("SELECT id, kind, draft_applied, created_at, LENGTH(content) AS len FROM chapter_save_versions WHERE chapter_id = 121 ORDER BY id DESC LIMIT 8").all()) {
  console.log(`#${v.id} ${v.kind} applied=${v.draft_applied} ${v.created_at} len=${v.len}`);
}
console.log('\n== 最近的 app_logs（22:2x 之后，看有没有空内容拒绝/暂停记录）==');
for (const r of db.prepare("SELECT id, ts, level, kind, substr(message,1,110) AS m FROM app_logs WHERE ts >= '2026-10-02T14:20' ORDER BY id DESC LIMIT 25").all()) {
  console.log(`#${r.id} ${r.ts} [${r.level}] ${r.kind} :: ${r.m}`);
}
db.close();
