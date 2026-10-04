import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const t = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '');
const cur = db.prepare('SELECT content FROM chapters WHERE id = 121').get().content;
const v54 = db.prepare('SELECT content FROM chapter_save_versions WHERE id = 54').get().content; // draft 5188
const v55 = db.prepare('SELECT content FROM chapter_save_versions WHERE id = 55').get().content; // 4294
const v56 = db.prepare('SELECT content FROM chapter_save_versions WHERE id = 56').get().content; // 5638
const sh = (s) => { const o = new Set(); for (let i = 0; i + 12 <= s.length; i += 6) o.add(s.slice(i, i + 12)); return o; };
const sim = (a, b) => { const A = sh(a), B = sh(b); let n = 0; for (const x of A) if (B.has(x)) n++; return Math.round(100 * n / Math.max(1, Math.min(A.size, B.size))); };
const rows = [['current', t(cur)], ['#56(5638旧)', t(v56)], ['#55(4294)', t(v55)], ['#54(draft5188)', t(v54)]];
console.log('长度：', rows.map(([k, v]) => `${k}=${v.length}`).join('  '));
console.log('\n相似度矩阵（12 字切片重合率）：');
for (const [k1, v1] of rows) console.log('  ' + rows.map(([k2, v2]) => `${k1}~${k2}:${sim(v1, v2)}%`).join('  '));
console.log('\ncurrent 开头 60 字：', t(cur).slice(0, 60));
console.log('#54(draft5188) 开头 60 字：', t(v54).slice(0, 60));
console.log('#55(4294) 开头 60 字：', t(v55).slice(0, 60));
console.log('\ncurrent 结尾 40 字：', t(cur).slice(-40));
console.log('#54 结尾 40 字：', t(v54).slice(-40));
db.close();
