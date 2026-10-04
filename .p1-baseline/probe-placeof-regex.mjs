const PLACE_OF = /([^，。！？、\s]{1,8}?)(?:还|仍|就)?在(书包|背包|包|口袋|兜|抽屉|鞋柜|柜子|箱子|主袋|侧袋)(夹层|内侧|底层|最深|更深|里面一点|最里面)(?:里|中|内)?|([^，。！？、\s]{1,8}?)(?:还|仍|就)?在(书包|背包|包|口袋|兜|抽屉|鞋柜|柜子|箱子|主袋|侧袋)(?:里|中|内)/g;
const sents = [
  '剑在书包里，和卷子挤在一起。',
  '他把手往书包更深的地方探进去，摸到一个硬的东西。',
  '剑在书包夹层里。',
  '那东西在书包夹层里。',
  '剑在主袋里，和卷子挤在一起。',
  '写卷子的时候，笔在书包里压断了。',
];
for (const s of sents) {
  const hits = [...s.matchAll(new RegExp(PLACE_OF.source, 'g'))].map((m) => (m[1] !== undefined
    ? { obj: m[1], container: m[2], level: m[3], whole: m[0] }
    : { obj: m[4], container: m[5], level: '一般层', whole: m[0] }));
  console.log(`${hits.length ? 'HIT ' : 'miss'} ${s}`);
  for (const h of hits) console.log(`     obj=${h.obj} container=${h.container} level=${h.level} whole=${h.whole}`);
}
