// 只读探针（2026-10-05 第九支）：正文里有没有"不属于 AI 稿 / 也不属于修订"的作者文字。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const one = (s, ...a) => db.prepare(s).get(...a);
const squash = (s) => String(s || '').replace(/\s+/g, '');
const parasOf = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\u0001')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .split('\u0001').map(squash).filter((s) => s.length > 3);

const body = parasOf(one('SELECT content FROM chapters WHERE id = 119').content);
const ai = new Set(parasOf(one('SELECT content FROM chapter_save_versions WHERE id = 71').content));
const revRow = one("SELECT output FROM harness_jobs WHERE kind LIKE 'revision%' AND chapter_id = 119");
const patches = JSON.parse(revRow.output).patches || [];
const R = new Set(patches.map((p) => squash(p.revised)));
const A = new Set(patches.map((p) => squash(p.anchor)));

let unknown = 0, cntAI = 0, cntA = 0, cntR = 0;
for (const p of body) {
  if (R.has(p)) cntR++;
  else if (A.has(p)) cntA++;
  else if (ai.has(p)) cntAI++;
  else { unknown++; console.log('UNKNOWN: ' + p.slice(0, 120)); }
}
console.log(`正文段落 ${body.length}：AI原文 ${cntAI} / 修订前锚点 ${cntA} / 修订后 ${cntR} / 未归类 ${unknown}`);

// 正确合并结果 = 用补丁把锚点整段替换掉（复刻 applyRevisionPatches 的语义）
function applyPatches(article, list) {
  const paras = String(article || '').split(/\n{2,}/);
  const original = paras.slice();
  const used = new Set(); const applied = []; const unresolved = [];
  const norm = (s) => String(s || '').trim();
  for (const p of list) {
    const anchor = norm(p.anchor), revised = norm(p.revised);
    if (!anchor || !revised) { unresolved.push({ anchor, reason: 'missing' }); continue; }
    const exact = [];
    for (let i = 0; i < original.length; i++) if (norm(original[i]) === anchor) exact.push(i);
    let idx = -1;
    if (exact.length === 1) idx = exact[0];
    else if (exact.length > 1) { unresolved.push({ anchor, reason: 'dup' }); continue; }
    else if (anchor.length >= 8) {
      const cands = [];
      for (let i = 0; i < original.length; i++) if (norm(original[i]).includes(anchor)) cands.push(i);
      if (cands.length === 1) idx = cands[0];
      else if (cands.length > 1) { unresolved.push({ anchor, reason: 'ambiguous' }); continue; }
    }
    if (idx < 0) { unresolved.push({ anchor, reason: 'not-found' }); continue; }
    if (used.has(idx)) { unresolved.push({ anchor, reason: 'overlap' }); continue; }
    used.add(idx); paras[idx] = revised; applied.push({ anchor, revised, paraIndex: idx });
  }
  return { text: paras.join('\n\n'), applied, unresolved };
}

const aiText = String(one('SELECT content FROM chapter_save_versions WHERE id = 71').content)
  .replace(/<\/p>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ').split('\n').map((s) => s.trim()).filter(Boolean).join('\n\n');

const fixed = applyPatches(aiText, patches);
console.log(`\n重建的合并稿：${fixed.text.length} 字符 / ${fixed.text.split(/\n{2,}/).length} 段；applied=${fixed.applied.length} unresolved=${fixed.unresolved.length}`);
for (const u of fixed.unresolved.slice(0, 8)) console.log('   unresolved: ' + u.reason + ' | ' + String(u.anchor).slice(0, 40));
console.log('重建稿里是否还残留锚点：' + fixed.text.split('\n\n').filter((p) => A.has(squash(p))).length + ' 段');
db.close();
