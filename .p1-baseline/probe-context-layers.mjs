import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('=== 今天的服务生命周期（pid / 启动时刻）===')
for (const r of db.prepare(`SELECT id, ts, substr(message,1,40) AS msg, context FROM app_logs WHERE ts >= '2026-10-04' AND kind = 'lifecycle' ORDER BY id`).all()) console.log(`#${r.id} ${r.ts} ${r.msg} ${r.context}`);
console.log('\n=== 今天 chapter 119 的所有装配记录（含层数与是否带 blueprint）===')
for (const r of db.prepare(`SELECT id, ts, message, context FROM app_logs WHERE ts >= '2026-10-04' AND kind = 'context_contributions' ORDER BY id`).all()) {
  const ctx = JSON.parse(r.context || '{}');
  const ids = (ctx.sources || []).filter((s) => s.source === 'host_context_layer').map((s) => s.id);
  console.log(`#${r.id} ${r.ts} ch=${ctx.chapter_id} phase=${ctx.phase || '-'} 层=${ids.length} 含blueprint=${ids.includes('blueprint')} : ${ids.join(',')}`);
}
db.close();
