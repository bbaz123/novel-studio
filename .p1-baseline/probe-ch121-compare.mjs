import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const strip = (h) => String(h || '').replace(/<[^>]*>/g, '');
const dump = (id, file) => {
  const row = db.prepare('SELECT * FROM chapter_save_versions WHERE id = ?').get(id);
  fs.writeFileSync(file, String(row.content || ''), 'utf8');
  return row;
};
const a = dump(49, '.p1-baseline/ch121-v49-draft.txt');
const b = dump(48, '.p1-baseline/ch121-v48-manual.txt');
const ta = strip(a.content).replace(/\s+/g, '');
const tb = strip(b.content).replace(/\s+/g, '');
console.log('#49 draft   text=', ta.length, 'paragraphs=', (a.content.match(/<p/g) || []).length);
console.log('#48 manual  text=', tb.length, 'paragraphs=', (b.content.match(/<p/g) || []).length);
console.log('same text?', ta === tb);
// LCS-ish quick diff at line level
const linesA = strip(a.content).split('\n').map((s) => s.trim()).filter(Boolean);
const linesB = strip(b.content).split('\n').map((s) => s.trim()).filter(Boolean);
console.log('\n#49 first 6 lines:');
linesA.slice(0, 6).forEach((l, i) => console.log(`  A${i}: ${l.slice(0, 90)}`));
console.log('#48 first 6 lines:');
linesB.slice(0, 6).forEach((l, i) => console.log(`  B${i}: ${l.slice(0, 90)}`));
console.log('\n#49 last 4 lines:');
linesA.slice(-4).forEach((l, i) => console.log(`  A: ${l.slice(0, 90)}`));
console.log('#48 last 4 lines:');
linesB.slice(-4).forEach((l, i) => console.log(`  B: ${l.slice(0, 90)}`));
// crude similarity: shared 12-char shingles
const sh = (t) => { const s = new Set(); for (let i = 0; i + 12 <= t.length; i += 6) s.add(t.slice(i, i + 12)); return s; };
const sa = sh(ta), sb = sh(tb);
let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
console.log('\nshingle overlap: A=', sa.size, 'B=', sb.size, 'common=', inter, `(${Math.round(100 * inter / Math.max(1, Math.min(sa.size, sb.size)))}% of smaller)`);
db.close();
