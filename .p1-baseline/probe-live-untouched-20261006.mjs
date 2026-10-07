// 只读核对：证明端到端验证没有写进活库（活库只读打开）。
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/novel.db', { readOnly: true });
const g = (sql, ...p) => d.prepare(sql).get(...p);
console.log('ch119:', JSON.stringify(g('SELECT id, length(content) AS n, substr(content,1,40) AS head FROM chapters WHERE id = 119')));
console.log('e2e 采纳记录数:', g("SELECT count(*) AS n FROM adoption_operations WHERE idempotency_key LIKE 'e2e-guard-%'").n);
console.log('含 E2E 标记的章数:', g("SELECT count(*) AS n FROM chapters WHERE content LIKE '%E2E 护栏不挡正文验证%'").n);
console.log('work18 pending 事件提案:', g("SELECT count(*) AS n FROM story_event_proposals WHERE work_id = 18 AND status = 'pending'").n);
console.log('work18 pending 记忆提案:', g("SELECT count(*) AS n FROM story_memory_proposals WHERE work_id = 18 AND status = 'pending'").n);
d.close();
