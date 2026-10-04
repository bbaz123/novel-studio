import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const ch = db.prepare('SELECT * FROM chapters WHERE id = 121').get();
console.log('== chapter 121 ==');
console.log('title:', ch.title, '| work:', ch.work_id, '| updated_at:', ch.updated_at, '| created:', ch.created_at);
console.log('content len:', String(ch.content || '').length, '| RAW >>>' + String(ch.content || '') + '<<<');
console.log('\n== ALL versions of 121 ==');
for (const v of q('SELECT id, kind, draft_applied, created_at, LENGTH(content) AS len FROM chapter_save_versions WHERE chapter_id = 121 ORDER BY id DESC LIMIT 40')) {
  console.log(`#${v.id} kind=${v.kind} applied=${v.draft_applied} ${v.created_at} len=${v.len}`);
}
console.log('\n== chapters in work 18 (len) ==');
for (const c of q("SELECT id, title, LENGTH(COALESCE(content,'')) AS len, updated_at FROM chapters WHERE work_id = 18 ORDER BY id")) {
  console.log(`#${c.id} len=${String(c.len).padStart(6)} ${c.updated_at} ${c.title}`);
}
console.log('\n== app_logs since 2026-10-02T13:00 ==');
for (const r of q("SELECT id, ts, level, kind, substr(message,1,150) AS m FROM app_logs WHERE ts >= '2026-10-02T13:00' ORDER BY id ASC LIMIT 120")) {
  console.log(`#${r.id} ${r.ts} [${r.level}] ${r.kind} :: ${r.m}`);
}
console.log('\n== tables mentioning revision/history ==');
console.log(q("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%revision%' OR name LIKE '%version%' OR name LIKE '%recover%' OR name LIKE '%snapshot%')").map((r) => r.name).join(', '));
db.close();
