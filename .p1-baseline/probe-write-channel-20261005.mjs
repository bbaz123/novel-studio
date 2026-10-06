// 只读探针（2026-10-05 第三支）：确认 10:32:19 那次写入到底是"编辑器保存"还是"采纳/合并"。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const cut = (s, n = 200) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

console.log('=== ai_eval_events 第 119 章最近 8 条 ===');
console.log(q('PRAGMA table_info(ai_eval_events)').map((c) => c.name).join(', '));
for (const r of q(`SELECT * FROM ai_eval_events WHERE chapter_id = 119 ORDER BY id DESC LIMIT 8`)) {
  const o = {}; for (const k of Object.keys(r)) o[k] = cut(r[k]);
  console.log(JSON.stringify(o));
}

console.log('\n=== 投影 outbox 最近 8 条 ===');
try {
  for (const r of q(`SELECT * FROM projection_outbox ORDER BY rowid DESC LIMIT 8`)) {
    const o = {}; for (const k of Object.keys(r)) o[k] = cut(r[k], 260);
    console.log(JSON.stringify(o));
  }
} catch (e) { console.log('读取失败: ' + e.message); }

console.log('\n=== 日志表里 10:32:1x 附近的全层日志 ===');
for (const r of q(`SELECT id, ts, layer, level, kind, substr(message,1,160) AS msg FROM app_logs
                   WHERE ts >= '2026-10-05T10:31' AND ts <= '2026-10-05T10:35' ORDER BY id ASC`)) {
  console.log(`#${r.id} ${r.ts} ${r.layer}/${r.level} ${r.kind} :: ${r.msg}`);
}

console.log('\n=== chapters 119 与同作品其它章的 updated_at 分布（今天写入过哪些章）===');
for (const r of q(`SELECT id, title, length(content) AS bytes, updated_at FROM chapters
                   WHERE work_id = 18 AND updated_at >= '2026-10-05' ORDER BY updated_at DESC LIMIT 10`)) {
  console.log(JSON.stringify(r));
}
db.close();
