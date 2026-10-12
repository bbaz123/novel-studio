/**
 * 一次性探针（不入库、不被 CI 引用）：在**真实夹具**上试跑两类新候选的判据，
 * 先量出"会不会在既有阴性对照/冻结样本上误报"，再决定默认开关。
 * 目的：避免"加了新诊断 → 既有绿测变红"这种用新功能换回归的写法。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const FIX = path.join(REPO, 'tests', 'narrative-repair', 'fixtures');

const BODY = /(?:[。！？；\n]|^)\s*([^。！？；\n]{2,140}?)[。！？；]/g;
function sentences(text) {
  const s = String(text || '');
  const out = [];
  let m;
  BODY.lastIndex = 0;
  while ((m = BODY.exec(s))) out.push({ text: m[1], start: m.index + m[0].length - m[1].length - 1 });
  return out;
}
/** 语境窗口取**原始文本**切片，而不是"抽出的整句"：句末标点为逗号的从句不会被丢弃。 */
function rawContextBefore(s, at, n = 80) {
  return String(s || '').slice(Math.max(0, at - n), at);
}

// ⚠️ 不认裸"级"：`他的成绩是C级` 里的"级"是**等级名**，不是异象；只有明确的奇观事实才算降噪依据。
const SPECTACLE = /[SA]级|异象|SS级|光柱|灵体|风暴|帝王|地震|爆炸|直播|大屏/;
// ① 必须**以全体量词起头**（"全都/所有/全场…"），且必须带"停住/静/愣"这类中止动作。
//    "动作跟前面所有人都一样"（比较句）不是全体反应，故量词只认句首/分句首。
const UNIVERSAL_HEAD = /^(?:可|却|但|而|于是|结果)?(?:全都|全|所有|整个大厅|全场|一片|候检大厅|大厅)/;
const HALTS = /停住|停下|静了下?来|安静|没声|哑了|愣住|僵住/;
// ② 病因/背景被标为"平常"或"非特殊"：反应与成因不匹配才是疑点（F08 形状）。
const ORDINARY_CAUSE = /本来|平常|常见|普通|寻常|不算什么|没什么稀奇|见惯|早就|一直/;

const TACTILE = /按|摸|抚|捏|抵|触|握|攥/;
const TACTILE_ASSERT = /密度|硬度|材质|成分|重量|内部结构|构造|成分|年代|材质/;
// 触觉动词与"从触觉得不到的性质"必须在同段内紧邻出现（4—40 字以内），避免跨话题误连。
const PERCEPT = /知道|明白|感觉|感到|看出|察觉|意识|残留|觉出|发现|感受到/;
const DISTANCE = /隔着|远处|对面|另一头|隔了|千米|公里|米外/;

const isQuote = (s) => /^\s*[「“"']/.test(String(s || ''));

const reactionCandidates = (text) => {
  const ss = sentences(text);
  const out = [];
  for (const item of ss) {
    const s = item.text;
    if (!HALTS.test(s) || SPECTACLE.test(s) || isQuote(s)) continue;
    const clause = s.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
    const universal = clause.some((c) => UNIVERSAL_HEAD.test(c));
    if (!universal) continue;
    // 反证通道：语境里一但把成因标为"普通/平常"，反应与成因就不匹配 → 值得提疑点。
    const context = rawContextBefore(text, item.start);
    const ordinary = ORDINARY_CAUSE.test(context + s);
    if (!ordinary) continue;
    out.push({
      diagnostic: 'reaction_causality',
      quote: s,
      evidence: `语境「${context.slice(-28)}」把成因标为普通，却紧跟「${s}」这样的全体中止反应`,
      counter: '若该等级被反复铺垫为异常，或这是有意的舞台化描写，则不成立',
    });
  }
  return out;
};

const focalCandidates = (text) => {
  const paras = String(text || '').split(/\n{2,}/);
  const out = [];
  for (const p of paras) {
    const q = p.replace(/[「“"'][^」”"']*[」”"']/g, '（对白）');
    const tm = TACTILE.exec(q);
    if (tm) {
      const near = q.slice(Math.max(0, tm.index - 6), tm.index + 42);
      const am = TACTILE_ASSERT.exec(q);
      if (am && Math.abs(am.index - tm.index) <= 40) {
        out.push({ diagnostic: 'focalization_limit', quote: p.slice(0, 80), evidence: `触觉动词「${tm[0]}」之后直接断言「${am[0]}」（触觉得不到该性质）`, counter: '若角色有已确立的特殊感知（如系统提示、特殊天赋），则不成立' });
        continue;
      }
    }
    if (DISTANCE.test(q) && PERCEPT.test(q)) {
      const word = PERCEPT.exec(q)[0];
      out.push({ diagnostic: 'focalization_limit', quote: p.slice(0, 80), evidence: `隔着距离（${DISTANCE.exec(q)[0]}）却用「${word}」给出对方身上的信息`, counter: '若该信息来自可见的视觉线索（如光效），则观察来源成立' });
    }
  }
  return out;
};

const targets = [
  ['frozen before', fs.readFileSync(path.join(FIX, 'before.txt'), 'utf8')],
  ['frozen after', fs.readFileSync(path.join(FIX, 'after.txt'), 'utf8')],
];
for (const f of fs.readdirSync(path.join(FIX, 'new-3751-spring'))) {
  if (!f.endsWith('.json') || f === 'manifest.json') continue;
  const j = JSON.parse(fs.readFileSync(path.join(FIX, 'new-3751-spring', f), 'utf8'));
  if (j.text) targets.push([f, j.text]);
  if (j.positive_group && j.positive_group.text) targets.push([f + ':pos', j.positive_group.text]);
  if (j.negative_group && j.negative_group.text) targets.push([f + ':neg', j.negative_group.text]);
  if (j.body) targets.push([f + ':body', j.body]);
}
const manifestPath = path.join(FIX, 'new-3751-spring', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const item of manifest.items || []) {
  if (item.before) targets.push([`manifest:${item.id}:before`, item.before]);
}

// 计划里的 F08 / M01 / M02 / M03 形状（预期：应当给出候选）
const PLAN_SHAPES = [
  ['F08 全场静止（C 级普通）', '他的成绩是C级。C级本来就常见，队伍里没什么反应。\n\n可大厅里安静了。靠在墙边打盹的考生全都停住了。'],
  ['M02 触觉→密度断言', '他把右手按在石板上。石板的密度比普通石头高。'],
  ['M03 隔队伍知掌心余温', '他隔着队伍看了一眼李拓，李拓掌心还残留着一点金色的余温。'],
];

let noise = 0;
let hits = 0;
for (const [name, text] of targets) {
  const rc = reactionCandidates(text);
  const fc = focalCandidates(text);
  if (rc.length || fc.length) {
    noise += rc.length + fc.length;
    console.log(`NOISE ${name}: ${JSON.stringify([...rc, ...fc].map((c) => `${c.diagnostic}|${c.quote.slice(0, 30)}`))}`);
  }
}
console.log('--- plan shapes (expected to fire) ---');
for (const [name, text] of PLAN_SHAPES) {
  const rc = reactionCandidates(text);
  const fc = focalCandidates(text);
  hits += rc.length + fc.length;
  console.log(`${name}: ${JSON.stringify([...rc, ...fc].map((c) => `${c.diagnostic}|${c.quote.slice(0, 40)}`))}`);
}
console.log(JSON.stringify({ fixture_noise_candidates: noise, plan_shape_candidates: hits, targets: targets.length }, null, 2));
