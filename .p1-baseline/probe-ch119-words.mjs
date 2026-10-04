import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const c = String(db.prepare('SELECT content FROM chapters WHERE id = 119').get().content || '');
for (const k of ['宿主符合绑定条件', '火焰法师', '江陵市第三检测中心', '林清雪', '李拓']) console.log(`  ${k}: ${c.includes(k) ? '正文里有' : '正文里没有'}`);
console.log('  正文长度:', c.length);
db.close();
