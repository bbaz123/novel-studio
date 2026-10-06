// 只读探针（2026-10-05 第四支）：找出修稿作业记录，并把修稿产出与当前正文做血统比对。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log('=== 所有表 ===');
console.log(q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((t) => t.name).join('\n'));

const jobTables = q("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%job%' OR name LIKE '%harness%' OR name LIKE '%task%')").map((t) => t.name);
console.log('\n=== 疑似作业表 ===', jobTables.join(', '));

for (const t of jobTables) {
  try {
    const cols = q(`PRAGMA table_info(${t})`).map((c) => c.name);
    console.log(`\n-- ${t}: ${cols.join(', ')}`);
    const rows = q(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 5`);
    for (const r of rows) {
      const o = {};
      for (const k of Object.keys(r)) {
        const v = r[k];
        o[k] = typeof v === 'string' && v.length > 220 ? v.slice(0, 220) + ` …[共${v.length}字符]` : v;
      }
      console.log('   ' + JSON.stringify(o));
    }
  } catch (e) { console.log(`-- ${t}: ${e.message}`); }
}
db.close();
