import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const rows = db.prepare(`SELECT id, chapter_id, kind, stage, status, created_at, updated_at, length(output) AS n, substr(output,1,300) AS head FROM harness_jobs WHERE created_at >= '2026-10-04' ORDER BY created_at`).all();
for (const r of rows) console.log(`#${String(r.id).slice(0,8)} ch=${r.chapter_id} ${r.kind} ${r.status} ${r.created_at} n=${r.n}\n   ${String(r.head).replace(/\n/g,' ⏎ ').slice(0,260)}\n`);
console.log('=== 哪些输出里含「现有的蓝图」 ===')
for (const r of db.prepare(`SELECT id, chapter_id, created_at, substr(output,1,400) AS head FROM harness_jobs WHERE output LIKE '%现有的蓝图%' ORDER BY created_at`).all()) {
  console.log(`#${String(r.id).slice(0,8)} ch=${r.chapter_id} ${r.created_at}\n${r.head}\n---`);
}
db.close();
