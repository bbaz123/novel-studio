import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const strip = (h) => String(h || '').replace(/<[^>]*>/g, '');
const plain = (h) => strip(h).replace(/\s+/g, '');
const cur = db.prepare('SELECT id, title, content, updated_at FROM chapters WHERE id = 121').get();
const v48 = db.prepare('SELECT content FROM chapter_save_versions WHERE id = 48').get();
const v49 = db.prepare('SELECT content FROM chapter_save_versions WHERE id = 49').get();
console.log(`now : ${plain(cur.content).length} 字 (${String(cur.content).length} bytes) updated_at=${cur.updated_at}`);
console.log(`#48 : ${plain(v48.content).length} 字`);
console.log(`#49 : ${plain(v49.content).length} 字`);
console.log(`now === #48 ? ${String(cur.content) === String(v48.content)}`);
// 作者在评的那版里明确提到/引用的字串：用来判定"我现在手里的是不是他读的那一版"
const markers = [
  '你要脸吗', '协议不要求我有脸', '你真的不说', '不告诉你',
  '凉的、暗黄的、惋惜的', '剑身比鞘还暗', '他把脸凑过去',
  '保温杯里的水倒掉', '方的纸，0731'
];
console.log('\n--- markers in current ---');
for (const m of markers) console.log(`${cur.content.includes(m) ? 'Y' : 'n'} ${m}`);
console.log('\n--- markers in #49 (AI draft) ---');
for (const m of markers) console.log(`${String(v49.content).includes(m) ? 'Y' : 'n'} ${m}`);
fs.writeFileSync('.p1-baseline/ch121-current.txt', String(cur.content || ''), 'utf8');
console.log('\nwritten .p1-baseline/ch121-current.txt');
db.close();
