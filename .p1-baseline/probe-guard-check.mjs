import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
console.log('ch119 最新草稿行:');
for (const r of db.prepare("SELECT id, kind, created_at, length(content) AS len, substr(content,1,40) AS head FROM chapter_save_versions WHERE chapter_id = 119 AND kind='draft' ORDER BY id DESC LIMIT 3").all()) console.log(` #${r.id} ${r.created_at} len=${r.len} ${String(r.head).replace(/\n/g,' ')}`);
db.close();
