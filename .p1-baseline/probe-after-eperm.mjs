import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('== 最近的 ai_error_logs ==');
for (const r of db.prepare('SELECT id, action, error_code, endpoint, created_at FROM ai_error_logs ORDER BY id DESC LIMIT 5').all()) {
  console.log(`#${r.id} ${r.created_at} ${r.action} ${r.error_code} ${r.endpoint}`);
}
console.log('\n== ch121 ==');
const c = db.prepare('SELECT LENGTH(content) AS n, updated_at FROM chapters WHERE id = 121').get();
console.log(`${c.n} bytes, updated_at=${c.updated_at}`);
console.log('\n== 最近 harness 作业（失败原因）==');
for (const r of db.prepare("SELECT id, kind, status, substr(COALESCE(error,''),1,60) AS err, created_at FROM harness_jobs ORDER BY id DESC LIMIT 5").all()) {
  console.log(`#${r.id} ${r.created_at} ${r.kind} ${r.status} ${r.err}`);
}
db.close();
