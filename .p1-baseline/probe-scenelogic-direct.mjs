import { scanEditing } from '../ai/editing/scan.mjs';

const text = ['剑在书包里，和卷子挤在一起。', '他把手往书包更深的地方探进去，摸到一个硬的东西。', '剑在书包夹层里。'].join('\n');
const r = scanEditing(text, { abilities: ['scene-logic'], genre: 'urban', task: 'review' });
console.log('findings:', JSON.stringify(r.findings, null, 1));
console.log('skipped:', JSON.stringify(r.skipped));
console.log('scanned.density:', r.scanned.density ? 'present' : 'null');

// 直接复算判据里的每一步
const PLACE_DEEP = /([^，。！？、\s]{1,8}?)(?:还|仍|就)?在(书包|背包|包|口袋|兜|抽屉|鞋柜|柜子|箱子|主袋|侧袋)(夹层|内侧|底层|最深|更深|里面一点|最里面)(?:里|中|内)?/g;
const PLACE_PLAIN = /([^，。！？、\s]{1,8}?)(?:还|仍|就)?在(书包|背包|包|口袋|兜|抽屉|鞋柜|柜子|箱子|主袋|侧袋)(?:里|中|内)/g;
const DEPTH_HINT = /(更深|更深的地方|再往里|往里面|最里面|里侧)/;
for (const s of text.split(/\n+/)) {
  const deep = [...s.matchAll(PLACE_DEEP)].map((m) => [m[1], m[2], m[3]]);
  const plain = [...s.matchAll(PLACE_PLAIN)].map((m) => [m[1], m[2]]);
  console.log(`s="${s}"\n   deep=${JSON.stringify(deep)} plain=${JSON.stringify(plain)} depthHint=${DEPTH_HINT.test(s)}`);
}

// 复算 byObject 的累积过程（与扫描器同逻辑）
const byObject = new Map();
const record = (obj, container, level) => {
  const e = byObject.get(obj) || { obj, places: new Map() };
  e.places.set(`${container}/${level}`, (e.places.get(`${container}/${level}`) || 0) + 1);
  byObject.set(obj, e);
};
for (const s of text.split(/\n+/)) {
  const seen = new Set();
  for (const m of s.matchAll(PLACE_DEEP)) { if (m[1].length < 2 || seen.has(m[1])) continue; seen.add(m[1]); record(m[1], m[2], m[3]); }
  for (const m of s.matchAll(PLACE_PLAIN)) { if (m[1].length < 2 || seen.has(m[1])) continue; if (DEPTH_HINT.test(s)) continue; seen.add(m[1]); record(m[1], m[2], '一般层'); }
}
for (const e of byObject.values()) {
  const levels = new Set([...e.places.keys()].map((k) => k.split('/')[1]));
  const containers = new Set([...e.places.keys()].map((k) => k.split('/')[0]));
  console.log(`obj=${e.obj} places=${[...e.places.keys()].join(' | ')} levels=${[...levels].join(',')} containers=${[...containers].join(',')} conflicting=${levels.size > 1 || containers.size > 1} size=${e.places.size}`);
}
