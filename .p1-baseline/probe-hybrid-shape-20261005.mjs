// 只读探针（2026-10-05 第八支）：看"多出来的 28 段"在正文里的位置——是插在锚点旁，还是追加在末尾。
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);

const plain = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/[ \t\u3000]+/g, '');
const squash = (s) => String(s || '').replace(/\s+/g, '');

const curRaw = one('SELECT content FROM chapters WHERE id = 119').content;
const aiRaw = one("SELECT content FROM chapter_save_versions WHERE id = 71").content;
const rev = one("SELECT output FROM harness_jobs WHERE kind LIKE 'revision%' AND chapter_id = 119");
const patches = JSON.parse(rev.output).patches || [];

// 保留段落顺序：正文按 </div>/</p> 切段
const parasOf = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\u0001')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .split('\u0001').map((s) => squash(s)).filter((s) => s.length > 3);

const body = parasOf(curRaw);
const ai = parasOf(aiRaw);
const aiSet = new Set(ai);
const revisedSet = new Set(patches.map((p) => squash(p.revised)));
const anchorSet = new Set(patches.map((p) => squash(p.anchor)));

console.log(`正文段落 ${body.length} / AI 稿段落 ${ai.length}`);
console.log('\n=== 正文逐段标注（[ANCHOR]=修订前原句，[REVISED]=模型给的改后句，[AI]=AI 稿原文，空=其它）===');
body.forEach((p, i) => {
  const tag = revisedSet.has(p) ? '[REVISED]' : anchorSet.has(p) ? '[ANCHOR ]' : aiSet.has(p) ? '[AI     ]' : '[?      ]';
  console.log(`${String(i + 1).padStart(3)} ${tag} ${p.slice(0, 46)}`);
});
db.close();
