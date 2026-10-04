import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
fs.writeFileSync(process.argv[2] + '/ch121-before.txt', String(db.prepare('SELECT content FROM chapters WHERE id = 121').get().content || ''), 'utf8');
console.log('content snapshot written');
db.close();
