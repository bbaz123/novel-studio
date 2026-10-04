import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('=== 11:30Z 之后的日志（本地 19:30+）===');
for (const r of db.prepare(`SELECT id, ts, layer, level, kind, substr(message,1,110) AS msg FROM app_logs WHERE ts >= '2026-10-04T11:30:00' ORDER BY id`).all()) {
  console.log(`#${r.id} ${r.ts} [${r.layer}/${r.level}/${r.kind}] ${r.msg}`);
}
console.log('\n=== 今天的 harness_jobs（≥11:30Z）===');
for (const r of db.prepare(`SELECT id, chapter_id, kind, stage, status, created_at, length(output) AS n, substr(output,1,90) AS head FROM harness_jobs WHERE created_at >= '2026-10-04T11:30:00' ORDER BY created_at`).all()) {
  console.log(`#${String(r.id).slice(0,8)} ch=${r.chapter_id} ${r.kind} ${r.stage} ${r.status} ${r.created_at} n=${r.n}\n   ${String(r.head).replace(/\n/g,' ⏎ ')}`);
}
console.log('\n=== ch119 现状 + 今天的草稿 ===');
console.log(JSON.stringify(db.prepare('SELECT id, length(content) AS len, updated_at FROM chapters WHERE id = 119').get()));
for (const r of db.prepare(`SELECT id, chapter_id, kind, draft_applied, draft_dismissed, length(content) AS len, created_at FROM chapter_save_versions WHERE created_at >= '2026-10-04T11:00:00' ORDER BY id`).all()) {
  console.log(` draft#${r.id} ch=${r.chapter_id} applied=${r.draft_applied} dismissed=${r.draft_dismissed} len=${r.len} ${r.created_at}`);
}
db.close();
