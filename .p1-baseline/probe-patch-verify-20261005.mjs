// 只读探针（2026-10-05 第六支）：逐条核对 28 条修订是否已进入正文，并做段落级差异。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);

const plain = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/[ \t\u3000]+/g, '')
  .replace(/\n{2,}/g, '\n').trim();

const squash = (s) => String(s || '').replace(/\s+/g, '');

const curT = plain(one('SELECT content FROM chapters WHERE id = 119').content);
const aiT = plain(one("SELECT content FROM chapter_save_versions WHERE id = 71").content);
const rev = one("SELECT output FROM harness_jobs WHERE kind LIKE 'revision%' AND chapter_id = 119");
const patches = JSON.parse(rev.output).patches || [];

console.log(`正文 ${curT.length} 字符 / AI 稿 ${aiT.length} 字符 / 补齐 ${curT.length - aiT.length}`);
console.log('\n=== 28 条修订逐条核对（anchor 是否还在 / revised 是否已进正文）===');
let inBody = 0, anchorGone = 0;
patches.forEach((p, i) => {
  const a = squash(p.anchor), r = squash(p.revised);
  const aInBody = a && squash(curT).includes(a);
  const rInBody = r && squash(curT).includes(r);
  const aInAI = a && squash(aiT).includes(a);
  if (rInBody) inBody++;
  if (aInAI && !aInBody) anchorGone++;
  console.log(`#${String(i + 1).padStart(2)} anchor在AI稿=${aInAI ? 'Y' : 'n'} anchor在正文=${aInBody ? 'Y' : 'n'} revised在正文=${rInBody ? 'Y' : 'n'} | ${r.slice(0, 30)}`);
});
console.log(`\nrevised 已在正文: ${inBody}/${patches.length}；anchor 被替换掉: ${anchorGone}/${patches.length}`);

console.log('\n=== 段落级差异（AI 稿 → 当前正文）===');
const paras = (t) => t.split('\n').map((s) => squash(s)).filter((s) => s.length > 4);
const A = paras(aiT), B = paras(curT);
const setA = new Set(A), setB = new Set(B);
const onlyB = B.filter((p) => !setA.has(p));
const onlyA = A.filter((p) => !setB.has(p));
console.log(`AI 稿段落 ${A.length}，正文段落 ${B.length}`);
console.log(`仅存在于正文的段落 ${onlyB.length} 段（合计 ${onlyB.reduce((n, s) => n + s.length, 0)} 字符）：`);
for (const p of onlyB.slice(0, 14)) console.log('   + ' + p.slice(0, 70));
console.log(`仅存在于 AI 稿的段落 ${onlyA.length} 段（合计 ${onlyA.reduce((n, s) => n + s.length, 0)} 字符）：`);
for (const p of onlyA.slice(0, 14)) console.log('   - ' + p.slice(0, 70));
db.close();
