// 只读探针（2026-10-05 第二支）：还原第 119 章那次「合并到正文」的采纳台账。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });

console.log('=== adoption_operations 列 ===');
console.log(db.prepare('PRAGMA table_info(adoption_operations)').all().map((c) => c.name).join(', '));

console.log('\n=== 第 119 章最近的采纳操作 ===');
const rows = db.prepare('SELECT * FROM adoption_operations WHERE chapter_id = 119 ORDER BY rowid DESC LIMIT 5').all();
for (const r of rows) {
  const o = { ...r };
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'string' && o[k].length > 900) o[k] = o[k].slice(0, 900) + ' …[截断]';
  }
  console.log(JSON.stringify(o, null, 1));
}

console.log('\n=== 今天的 chapter_reviews / 审稿记录 ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%review%' OR name LIKE '%draft%')").all().map((t) => t.name);
console.log('相关表:', tables.join(', '));
for (const t of tables) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const timeCol = cols.includes('created_at') ? 'created_at' : (cols.includes('updated_at') ? 'updated_at' : null);
    const sel = cols.includes('chapter_id') ? `SELECT * FROM ${t} WHERE chapter_id = 119 ORDER BY rowid DESC LIMIT 3` : null;
    if (!sel) { console.log(`\n-- ${t}: 无 chapter_id，跳过`); continue; }
    console.log(`\n-- ${t} (${cols.join(',')})`);
    for (const r of db.prepare(sel).all()) {
      const o = { ...r };
      for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].length > 160) o[k] = o[k].slice(0, 160) + '…';
      console.log('   ' + JSON.stringify(o));
    }
    void timeCol;
  } catch (e) { console.log(`\n-- ${t}: ${e.message}`); }
}
db.close();
