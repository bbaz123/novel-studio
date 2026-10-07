/**
 * 第四批判据探针（2026-10-08）——零计费、纯离线。
 *
 * 目的：在接进界面之前，先证明三件事（依据 docs/deai-source-fix-round4-* 的纪律：
 * 「只跑负例（不报）无法证明一条规则是活的，只跑正例无法证明它不会误伤」）：
 *   ① 正例真的会响（作者复核稿里的四处真实事故）；
 *   ② 负例真的不响（正确稿、正常复沓、动作句）；
 *   ③ 门禁真的会拦下"新制造的"矛盾，而底稿自带的矛盾不会把整批补丁拦死。
 *
 * 语料：本文件内联的**作者原文与复核稿**片段（不再从库里读，避免把探针绑到某一章）。
 *
 * 运行：node .p1-baseline/probe-fact-lock-20261008.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ 这个仓库的 package.json 是 `"type": "module"`，而 patch-safety.js 是 UMD：
// 在 ESM 下 `module.exports = api` 不会成为 require() 的返回值（实测拿到空对象 {}），
// 但 UMD 的 `root.NovelPatchSafety = api` 一定生效。所以**从 globalThis 取**——
// 这也正是浏览器里 app.js 的 `patchSafetyEngine()` 取值方式（两侧同一入口，不是两套）。
await import('file://' + path.join(REPO, 'public', 'patch-safety.js').replace(/\\/g, '/'));
const K = globalThis.NovelPatchSafety;
if (!K) {
  console.error('patch-safety.js 未挂到 globalThis.NovelPatchSafety（UMD 入口失效）');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
};

console.log(`patch-safety v${K.VERSION}（HARD_CODES 含 fact_lock_conflict：${K.HARD_CODES.includes('fact_lock_conflict')}）`);

// ── 正例 1：同一实体两个编号（作者复核稿的真实事故，剥离成最小复现） ─────────────
console.log('\n1. 事实锁 · 同一实体两个编号');
{
  const bad = [
    '岳宸炎的排号纸是1736。',
    '岳宸炎的排号纸是1738。',
  ].join('\n\n');
  const facts = K.scanFactLock(bad).filter((f) => f.code === 'fact_lock_conflict');
  check('正例：同一实体写成 1736/1738 → 命中', facts.length >= 1, JSON.stringify(facts[0] || null));
  check('命中理由必须同时指出两个编号', /\d{4}.*\d{4}/.test(String(facts[0] && facts[0].reason)), String(facts[0] && facts[0].reason));

  const good = [
    '岳宸炎的排号纸是1736。',
    '1736号，岳宸炎——',
    '工作人员撕下结果单，递给岳宸炎。',
  ].join('\n\n');
  check('负例：同一编号被复述两次（1736/1736）→ 不报', K.scanFactLock(good).filter((f) => f.code === 'fact_lock_conflict').length === 0);
}

// ── 正例 2：同一编号挂在两个人名下 ───────────────────────────────────────────
console.log('\n2. 事实锁 · 同一编号两个主人（需要人物卡名字才判定）');
{
  const bad = [
    '岳宸炎的排号纸是1736。',
    '广播叫到1736号，王磊走上检测台。',
  ].join('\n\n');
  const withChars = K.scanFactLock(bad, { characters: ['岳宸炎', '王磊'] }).filter((f) => f.code === 'fact_lock_conflict');
  const noChars = K.scanFactLock(bad).filter((f) => f.code === 'fact_lock_conflict');
  check('正例：1736 同时挂在岳宸炎与王磊名下 → 命中', withChars.length >= 1, JSON.stringify(withChars[0] || null));
  check('负例：没给人物卡名字时不猜主人（宁可不响）', noChars.length === 0, JSON.stringify(noChars));

  const fine = [
    '岳宸炎的排号纸是1736。',
    '1736号，岳宸炎——',
  ].join('\n\n');
  check('负例：同一个人 + 同一个号 → 不报', K.scanFactLock(fine, { characters: ['岳宸炎', '王磊'] }).filter((f) => f.code === 'fact_lock_conflict').length === 0);
}

// ── 正例 3：百分比合计 ───────────────────────────────────────────────────────
console.log('\n3. 事实锁 · 百分比合计');
{
  const bad = 'D级，出现概率百分之九十五。C级，万分之一。B级，十万分之一。';
  const p1 = K.scanFactLock(bad).filter((f) => f.code === 'percent_sum_mismatch');
  const bad2 = 'D级 95%，C级 4%，B级 0.09%。';
  const p2 = K.scanFactLock(bad2).filter((f) => f.code === 'percent_sum_mismatch');
  const good = 'D级 95%，C级 4.9%，B级 0.09%，A级 0.0099%，S级 0.0001%。';
  const p3 = K.scanFactLock(good).filter((f) => f.code === 'percent_sum_mismatch');
  check('正例：95% + 4% + 0.09% = 99.09% → 命中', p2.length === 1, JSON.stringify(p2[0] || null));
  check('正例：中文百分比（百分之九十五）也能认出来', p1.length === 1, JSON.stringify(p1[0] || null));
  check('负例：合计正好 100% → 不报', p3.length === 0, JSON.stringify(p3[0] || null));
  check('负例：只有一个百分比时不判合计', K.scanFactLock('D级 95%。').filter((f) => f.code === 'percent_sum_mismatch').length === 0);
}

// ── 正/负例 4：跨段整句重复 ─────────────────────────────────────────────────
console.log('\n4. 跨段整句重复');
{
  const dup = [
    '岳宸炎把手从石板上拿开。',
    '岳宸炎把手从石板上拿开。',
    '岳宸炎把手从石板上拿开。',
  ].join('\n\n');
  const hits = K.scanCrossParagraphDuplicates(dup);
  check('正例：同一句出现在 3 段 → 命中', hits.length === 1, JSON.stringify(hits[0] || null));
  const twice = [
    '岳宸炎把手从石板上拿开。',
    '岳宸炎把手从石板上拿开。',
  ].join('\n\n');
  check('负例：只重复一次（2 段）→ 不报（避开合法复沓）', K.scanCrossParagraphDuplicates(twice).length === 0);
  const shortRepeat = ['嗯。', '嗯。', '嗯。'].join('\n\n');
  check('负例：短句重复 → 不报（正常节奏）', K.scanCrossParagraphDuplicates(shortRepeat).length === 0);
}

// ── 正/负例 5：转场桥 ───────────────────────────────────────────────────────
console.log('\n5. 转场桥（删掉唯一场景来源 + 后文直接写外景）');
{
  const withBridge = [
    '画面上方挂着一行字：海澜市觉醒中心。',
    '那块石头亮起来的时候，整个画面都白了。',
    '画面没再切回检测台，直接切回了江陵本地的队伍。',
    '外面在下雪。',
  ].join('\n\n');
  const withoutBridge = [
    '画面上方挂着一行字：海澜市觉醒中心。',
    '那块石头亮起来的时候，整个画面都白了。',
    '外面在下雪。',
  ].join('\n\n');
  const patch = { anchor: withBridge.split('\n\n')[2], revised: '' };
  const base = withBridge;
  const after = withoutBridge;
  const risks = K.sceneBridgeRisks(after, patch.anchor, '', 2, {});
  check('正例：删掉「画面切回…队伍」→ 后文「外面在下雪」→ 命中', risks.length === 1, JSON.stringify(risks[0] || null));

  // ⚠️ 这里刻意做成**有外景的正例**：删除动作与后文外景在文本上是同一件事，
  //    所以"后文没有外景词"要用另一份样本构造（见下面 noExteriorLine）。
  const noExteriorLine = [
    '画面上方挂着一行字：海澜市觉醒中心。',
    '那块石头亮起来的时候，整个画面都白了。',
    '画面没再切回检测台，直接切回了江陵本地的队伍。',
    '大屏幕重新开始滚动名单。',
  ].join('\n\n');
  const noExterior = K.sceneBridgeRisks(noExteriorLine, patch.anchor, '', 2, {});
  check('负例：后文没有外景词 → 不报', noExterior.length === 0, JSON.stringify(noExterior));
  const noScene = K.sceneBridgeRisks(after, '他把手从石板上拿开。', '', 2, {});
  check('负例：被删句里没有场景来源词 → 不报', noScene.length === 0);
}

// ── 6. 门禁姿态：新制造的矛盾才拦，底稿自带的矛盾不拦死整批 ──────────────────
console.log('\n6. 门禁姿态（gatePatches）');
{
  // ⚠️ 底稿刻意只保留 1738 这一处编号：如果底稿里同时有「1736号，王磊」，
  //    冲突在改动**之前**就已存在，门禁按"是否新增"判定时不会拦这条补丁
  //    （这是设计如此：底稿自带的历史遗留由诊断层报给作者，不该把门禁变成不可用状态）。
  const base = [
    '岳宸炎站在队伍中间，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1738。',
    '李拓把手掌按上去。',
  ].join('\n\n');
  // 坏补丁：把 1738 改成 1736（正是复核稿里那次单点修改：改完就与后文撞号）。
  // ⚠️ 门禁的事实锁判据要**人物卡名字**才生效（"谁被改了号"必须有主人可指）——
  //    界面侧由 patchSafetyOptions(chapterId) 从 state.characters 自动带上；
  //    没有人物卡时判据静默（宁可漏，也不猜主人）。
  const chars = { characters: ['岳宸炎', '王磊', '李拓'] };
  const patch = [{
    issue: 1,
    anchor: '岳宸炎站在队伍中间，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1738。',
    revised: '岳宸炎站在队伍中间，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1736。',
  }];
  const bad = K.gatePatches(base, patch, chars);
  check('坏补丁被拦（不进差异稿）', bad.blocked.length === 1 && bad.blocked[0].code === 'fact_lock_conflict', JSON.stringify(bad.blocked[0] || null));
  check('拦下的理由里并列两处冲突位置', /第 \d+ 段/.test(String(bad.blocked[0] && bad.blocked[0].conflict)), String(bad.blocked[0] && bad.blocked[0].conflict));
  const noChars = K.gatePatches(base, patch, {});
  check('负例：没有人物卡名字时判据静默（不猜主人）', noChars.blocked.length === 0, JSON.stringify(noChars.blocked));

  // 好补丁：只压缩描写，不动编号
  const ok = K.gatePatches(base, [{ issue: 2, anchor: '李拓把手掌按上去。', revised: '李拓把手按上去。' }], chars);
  check('好补丁照常放行', ok.allowed.length === 1 && ok.blocked.length === 0, JSON.stringify(ok.blocked));

  // 底稿自带矛盾：不因为历史遗留就把整批补丁拦死
  const dirtyBase = [
    '岳宸炎的排号纸是1736。',
    '岳宸炎的排号纸是1738。',
    '李拓把手掌按上去。',
  ].join('\n\n');
  const stillOk = K.gatePatches(dirtyBase, [{ issue: 3, anchor: '李拓把手掌按上去。', revised: '李拓把手按上去。' }], chars);
  check('底稿自带矛盾时，无关补丁仍可应用（不把门禁变成不可用）', stillOk.allowed.length === 1 && stillOk.blocked.length === 0, JSON.stringify(stillOk.blocked));

  // 修后核验：整章重写路径也能报出冲突
  const v = K.verifyPatchedText(base, dirtyBase, chars);
  check('修后核验（整章重写兜底路径）报出事实锁冲突', v.findings.some((f) => f.code === 'fact_lock_conflict'), JSON.stringify(v.findings.map((f) => f.code)));
  const v2 = K.verifyPatchedText(base, base, chars);
  check('负例：原文没动时修后核验零发现', v2.findings.length === 0, JSON.stringify(v2.findings));
}

// ── 7. 负例：真实正确稿整体跑一遍（防误报） ─────────────────────────────────
console.log('\n7. 正确稿整体负例');
{
  const good = [
    '王磊从前面探回头来。“还剩多少个？”',
    '岳宸炎抬头看了一眼屏幕。“一百二十。”',
    '“1736号，王磊——”',
    '王磊整个人顿了一下。',
    '检测石亮起青绿色。光从石心的纹路里渗出来，像一块浸了水的玉石。',
    '“1721号，李拓——”',
    '金红色从石面往外烧，像有人往石头里倒了一勺铁水。',
    '“1720号，岳宸炎——”',
    '岳宸炎把手掌放上去。石头是凉的。',
    '检测石亮了起来。暗黄色。',
    '他把结果单对折，再对折，塞进书包侧袋。',
  ].join('\n\n');
  const facts = K.scanFactLock(good, { characters: ['岳宸炎', '王磊', '李拓'] });
  check('正确稿：零事实锁冲突', facts.filter((f) => f.code === 'fact_lock_conflict').length === 0, JSON.stringify(facts));
  check('正确稿：零跨段整句重复', K.scanCrossParagraphDuplicates(good).length === 0, JSON.stringify(K.scanCrossParagraphDuplicates(good)));
}

console.log(`\n=== ${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（${pass} passed / ${fail} failed）===`);
process.exit(fail === 0 ? 0 : 1);
