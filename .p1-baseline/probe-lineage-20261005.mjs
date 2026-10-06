// 只读探针（2026-10-05 第五支）：把当前正文与"修稿前正文 / AI 稿 / 修稿产出"做血统比对。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);

const plain = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>|<\/div>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/[ \t\u3000]+/g, '')
  .replace(/\n+/g, '\n')
  .trim();

const bigrams = (s) => { const m = new Map(); const t = s.replace(/\n/g, ''); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
const dice = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0, total = 0;
  for (const [g, n] of A) { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const [, n] of B) total += n;
  return (2 * inter / total);
};

const cur = one('SELECT content FROM chapters WHERE id = 119').content;
const curT = plain(cur);
const v70 = one("SELECT content, created_at FROM chapter_save_versions WHERE id = 70");
const v71 = one("SELECT content, created_at FROM chapter_save_versions WHERE id = 71");
const v68 = one("SELECT content FROM chapter_save_versions WHERE id = 68");
const prose = one("SELECT output FROM harness_jobs WHERE kind LIKE 'prose:applied%' AND chapter_id = 119 AND created_at >= '2026-10-05'");
const revision = one("SELECT output, kind, updated_at FROM harness_jobs WHERE kind LIKE 'revision%' AND chapter_id = 119");

const cases = {
  '当前正文': cur,
  '版本#70 (10-04 12:51 manual, 4939B)': v70.content,
  '版本#71 (10-05 10:25 AI 写作文稿, 5209B)': v71.content,
  '版本#68 (10-04 12:06 draft, 4939B)': v68.content,
  'prose 作业产出 (AI 成文 4747 字符)': prose ? prose.output : ''
};
console.log('当前正文：' + cur.length + ' 字节 / ' + curT.length + ' 可读字符');
console.log('开头 80 字：' + curT.slice(0, 80));
console.log('结尾 60 字：' + curT.slice(-60));
console.log('\n=== 与当前正文的 bigram-dice 相似度 ===');
for (const [label, html] of Object.entries(cases)) {
  const t = plain(html);
  console.log(`  ${(dice(curT, t) * 100).toFixed(1)}%  ${label}  [${t.length} 字符]`);
}

console.log('\n=== 版本#70 与 #71 的相似度 ===');
console.log('  #70 vs #71: ' + (dice(plain(v70.content), plain(v71.content)) * 100).toFixed(1) + '%');
console.log('  当前 vs #70文本拼接#71: n/a');

console.log('\n=== 修稿作业（patches）===');
if (revision) {
  const r = revision.output;
  console.log('kind=' + revision.kind + ' updated=' + revision.updated_at + ' 长度=' + r.length);
  let patches = [];
  try { patches = JSON.parse(r).patches || []; } catch (e) { console.log('  解析失败: ' + e.message); }
  console.log('patch 条数: ' + patches.length);
  let hit = 0;
  for (const p of patches) {
    const a = String(p.anchor || '').replace(/\s+/g, '');
    const rv = String(p.revised || '').replace(/\s+/g, '');
    const hasAnchor = a && curT.replace(/\n/g, '').includes(a);
    const hasRevised = rv && curT.replace(/\n/g, '').includes(rv);
    if (hasRevised && !hasAnchor) hit++;
    if (patches.length <= 12) console.log(`   anchor在正文中=${hasAnchor} revised在正文中=${hasRevised}  ${rv.slice(0, 26)}`);
  }
  console.log(`  已把 revised 改入正文、且原 anchor 已消失的条数: ${hit}/${patches.length}`);
}
db.close();
