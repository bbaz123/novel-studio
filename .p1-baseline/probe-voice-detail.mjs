import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const strip = (h) => String(h || '').replace(/<[^>]*>/g, '');
for (const id of [119, 120, 121]) {
  const c = db.prepare('SELECT title, content FROM chapters WHERE id = ?').get(id);
  const t = strip(c.content);
  console.log(`=== #${id} ${c.title} (${t.replace(/\s+/g,'').length} 字) ===`);
  const hits = [];
  for (const kw of ['D级', '惋惜', '口罩', '检测中心', '0731', '暗夜猎手']) {
    let i = -1; let n = 0;
    while ((i = t.indexOf(kw, i + 1)) !== -1 && n < 4) {
      hits.push(`  [${kw}] …${t.slice(Math.max(0, i - 26), i + 26).replace(/\n/g, ' ')}…`);
      n += 1;
    }
  }
  console.log(hits.join('\n') || '  （无命中）');
}
db.close();
