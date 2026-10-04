import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const r = db.prepare("SELECT ts, layer, kind, substr(message,1,70) AS msg FROM app_logs ORDER BY id DESC LIMIT 2").get();
console.log('最新日志:', JSON.stringify(r));
db.close();
