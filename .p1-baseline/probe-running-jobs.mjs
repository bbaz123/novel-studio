import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('== harness_jobs 最近的（未收尾的在前）==');
for (const r of db.prepare("SELECT id, kind, stage, status, work_id, chapter_id, created_at FROM harness_jobs WHERE status IN ('running','queued') ORDER BY created_at DESC LIMIT 10").all()) {
  console.log(`RUNNING #${r.id} ${r.kind} ${r.stage} work=${r.work_id} ch=${r.chapter_id} ${r.created_at}`);
}
console.log('--- 最近 5 条全部状态 ---');
for (const r of db.prepare("SELECT id, kind, stage, status, created_at FROM harness_jobs ORDER BY created_at DESC LIMIT 5").all()) {
  console.log(`${r.status.padEnd(9)} ${r.created_at} ${r.kind} ${String(r.stage || '').slice(0, 30)}`);
}
db.close();
