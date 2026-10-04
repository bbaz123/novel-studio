import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const html = String(db.prepare('SELECT content FROM chapters WHERE id = 121').get().content || '');
db.close();
const text = html.replace(/<\/p>/g, '\n').replace(/<[^>]*>/g, '').replace(/\n{2,}/g, '\n').trim();
const CONTAINER_RE = /(书包|背包|包|口袋|兜|抽屉|书桌|桌上|鞋柜|冰箱|柜子|箱子|侧袋|主袋)/;
const DEEPER_RE = /(?:更深|里面|里面一点|内侧|夹层|底层|最底下|最里面)/;
const DEEP_CONTAINER_NAME = /(侧袋|主袋|夹层|内袋|口袋)/;
const DEPTH_WORD = /(?:更深|里面一点|内侧|夹层|底层|最底下|最里面)/;
const PLAIN_PLACE = new RegExp(
  `(?:在|放进|塞进|放回|收进|夹在|藏在|搁在)[^。！？\\n]{0,6}${CONTAINER_RE.source}[^。！？\\n]{0,3}(?:里|中|内)`
  + `|${CONTAINER_RE.source}(?:里|中|内)[^。！？\\n]{0,3}(?:是|有|放着|装着|摆着|搁着)`
);
console.log('PLAIN_PLACE =', PLAIN_PLACE.source.slice(0, 80), '...\n');
const sents = text.split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean);
for (const s of sents) {
  if (!CONTAINER_RE.test(s)) continue;
  const names = [...new Set([...s.matchAll(new RegExp(CONTAINER_RE.source, 'g'))].map((m) => m[1]))];
  console.log(`${DEEP_CONTAINER_NAME.test(names[0]) ? '[格]' : '[主]'} deep=${DEPTH_WORD.test(s) ? 'Y' : 'n'} plain=${PLAIN_PLACE.test(s) ? 'Y' : 'n'} :: ${s.slice(0, 60)}`);
}
