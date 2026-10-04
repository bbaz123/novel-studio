import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const rows = db.prepare(`SELECT id, ts, layer, level, kind, substr(context,1,900) AS ctx FROM app_logs WHERE ts >= '2026-10-04' AND kind IN ('context_contributions','dsh_rules_contributions','ai_write_timing','task_start','task_done','context_shift') ORDER BY id DESC LIMIT 12`).all();
for (const r of rows) console.log(`#${r.id} ${r.ts} [${r.layer}/${r.kind}] ${r.ctx}`);
console.log('\n=== 最近 20 条日志（任意 kind）===')
for (const r of db.prepare(`SELECT id, ts, layer, kind, substr(message,1,90) AS msg FROM app_logs WHERE ts >= '2026-10-04T10:00:00' ORDER BY id DESC LIMIT 20`).all()) console.log(`#${r.id} ${r.ts} [${r.layer}/${r.kind}] ${r.msg}`);
db.close();
