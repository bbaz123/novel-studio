import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const ch = db.prepare('SELECT id, blueprint_json, substr(content,1,120) AS head FROM chapters WHERE id = 119').get();
const bp = JSON.parse(ch.blueprint_json || '{}');
console.log('ch119 蓝图字段：');
for (const [k, v] of Object.entries(bp)) console.log(`  ${k}: ${String(v).slice(0, 120)}`);
db.close();
