// 只读探针（2026-10-05）：取证「修稿合并报未保存错误」——查前端日志、正文行、版本与冲突痕迹。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });

const q = (sql, ...args) => db.prepare(sql).all(...args);

console.log('=== 1) 今天(2026-10-05)的前端日志 ===');
for (const r of q(`SELECT id, ts, level, kind, substr(message,1,220) AS msg, substr(COALESCE(context,''),1,300) AS ctx
                   FROM app_logs WHERE ts >= '2026-10-05' AND layer='frontend' ORDER BY id ASC LIMIT 60`)) {
  console.log(`#${r.id} ${r.ts} [${r.level}] ${r.kind}\n   ${r.msg}\n   ${r.ctx}`);
}

const readable = (html) => String(html || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, '')
  .length;

console.log('\n=== 2) 第 119 章正文行 ===');
for (const r of q(`SELECT id, work_id, title, length(content) AS bytes, content, updated_at
                   FROM chapters WHERE id=119`)) {
  console.log(JSON.stringify({ id: r.id, work_id: r.work_id, title: r.title, bytes: r.bytes, readable: readable(r.content), updated_at: r.updated_at }));
  console.log('   head: ' + String(r.content).slice(0, 120).replace(/\n/g, '\\n'));
}

console.log('\n=== 3) 第 119 章今天的版本记录 ===');
for (const r of q(`SELECT id, kind, title, length(content) AS bytes, content, draft_applied, draft_dismissed, created_at
                   FROM chapter_save_versions WHERE chapter_id=119 AND created_at >= '2026-10-05' ORDER BY id ASC`)) {
  console.log(JSON.stringify({ id: r.id, kind: r.kind, title: r.title, bytes: r.bytes, readable: readable(r.content), draft_applied: r.draft_applied, draft_dismissed: r.draft_dismissed, created_at: r.created_at }));
}

console.log('\n=== 4) app_logs 今天的 warn/error（全层）===');
for (const r of q(`SELECT id, ts, layer, level, kind, substr(message,1,200) AS msg
                   FROM app_logs WHERE ts >= '2026-10-05' AND level IN ('warn','error') ORDER BY id ASC LIMIT 40`)) {
  console.log(`#${r.id} ${r.ts} ${r.layer}/${r.level} ${r.kind} :: ${r.msg}`);
}

console.log('\n=== 5) 今天含"冲突/未保存/合并"字样的日志 ===');
for (const r of q(`SELECT id, ts, layer, level, kind, substr(message,1,240) AS msg
                   FROM app_logs WHERE ts >= '2026-10-05'
                     AND (message LIKE '%冲突%' OR message LIKE '%未保存%' OR message LIKE '%合并%')
                   ORDER BY id ASC LIMIT 40`)) {
  console.log(`#${r.id} ${r.ts} ${r.layer}/${r.level} ${r.kind} :: ${r.msg}`);
}
db.close();
