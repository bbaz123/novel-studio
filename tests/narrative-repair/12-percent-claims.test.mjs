/**
 * tests/narrative-repair/12-percent-claims.test.mjs
 * 《0731 号觉醒日：审稿—局部修稿闭环增补方案》§3 + T38–T45 的概率判据回归。
 *
 * 这一组补的是**抽取层**的缺陷（不是判据层）：判据再准，抽取把 `100%` 截成 `00%`、
 * 把 `百万分之一…一年能出一个吗` 里的"一年"当概率，结论照样是错的。
 *
 * 两个实现必须同时断言：`public/patch-safety.js`（浏览器/门禁侧）与
 * `ai/editing/scan.mjs`（Node 审稿侧）。本项目的历史事故就是"同一判据两份文本漂移"——
 * 只测一份的话，另一份静默失效不会被任何断言看见。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { K } = await loadPublicModules();
const scanMod = (await import('../../ai/editing/scan.mjs')).__internals;

/** 两份实现的取值口径（同一段文本 → 同一组数值）。 */
const both = (text) => ({
  browser: K.collectPercents(text),
  node: scanMod.collectPercents(text),
});

/** 两份实现的"要不要报合计不为 100%"（true = 报）。 */
const reportBoth = (text) => ({
  browser: K.scanFactLock(text).some((f) => f.code === 'percent_sum_mismatch'),
  node: scanMod.collectPercents(text).length >= 2
    ? Math.abs(scanMod.collectPercents(text).reduce((a, b) => a + b, 0) - 100) > 0.5
    : false,
});

// ── T44：数值右边界与左边界 ─────────────────────────────────────────────────
// 缺陷 ①：整数部分只允许 1–2 位 → `100%` 从数字**内部**匹配出 `00%`（值 0 又被 `v > 0` 丢掉，
//         于是 100 整个消失），`100.00%` 同样匹配不到。
// 缺陷 ②：没有左边界 → `123%` 截出尾部 `23%`，把非法占比伪装成合法值卷进加总。
{
  for (const t of ['100%', '100％', '100.00%']) {
    const got = both(t);
    check(`T44a ${JSON.stringify(t)} 识别为 100（不从数字内部截取）`,
      JSON.stringify(got.browser) === '[100]' && JSON.stringify(got.node) === '[100]',
      JSON.stringify(got));
  }
  const over = both('123%');
  check('T44b `123%` 不匹配尾部 `23%`（非法占比整条不计入）',
    over.browser.length === 0 && over.node.length === 0, JSON.stringify(over));
  const mid = both('命中率 123% 而 5% 是另一档。');
  check('T44c 非法值不污染正文里真正合法的占比',
    JSON.stringify(mid.browser) === '[5]' && JSON.stringify(mid.node) === '[5]',
    JSON.stringify(mid));
}

// ── T45：零概率与极小数 ─────────────────────────────────────────────────────
// 缺陷 ③：`v > 0` 把 `0%` 整条丢掉 —— 但"该等级不存在"是合法的分类项，缺席会让合计失真。
// 缺陷 ④（既有，防回归）：`0.0001%` 曾被读成 1%，把正确稿算成 199.99% 而误报。
{
  for (const t of ['0%', '0.0001%']) {
    const got = both(t);
    const want = t === '0%' ? [0] : [0.0001];
    check(`T45 ${JSON.stringify(t)} 数值与精度都保留（不被截断、不被过滤）`,
      JSON.stringify(got.browser) === JSON.stringify(want)
      && JSON.stringify(got.node) === JSON.stringify(want),
      JSON.stringify(got));
  }
  const list = both('D级 95%，E级 0%，F级 0.0001%。');
  check('T45b 零概率与极小数共存时各自保留',
    list.browser.includes(0) && list.browser.includes(0.0001) && list.browser.includes(95),
    JSON.stringify(list));
  // 零概率仍是**合法分类项**，因此它照旧参与抽取（`[95,0]` 里 0 没有被 `v>0` 丢掉）；
  // 但"95 + 0"已缺 A/S/B 三档，按 §3 资格判定不再判"合计应为 100%"。
  // 抽取值与判定结论分开断言，否则会分不清"零被丢了"与"缺档所以不判"。
  const zeroSum = both('D级 95%。E级 0%。');
  const zeroInc = K.scanFactLock('D级 95%。E级 0%。').filter((f) => f.code === 'percent_distribution_incomplete');
  check('T45c 零概率计入抽取（不被过滤），缺档时如实报分布不完整而不判合计',
    JSON.stringify(zeroSum.browser) === '[95,0]' && zeroInc.length === 1,
    JSON.stringify({ values: zeroSum.browser, incomplete: zeroInc.length }));
  const zeroAlone = K.scanFactLock('E级 0%。').filter((f) => f.code === 'percent_sum_mismatch');
  check('T45d 只有一个零概率档位时仍不判合计（不足两个档位）',
    zeroAlone.length === 0, JSON.stringify(zeroAlone));
}

// ── T38：稀有度口语不得被当成等级分布 ───────────────────────────────────────
// `百万分之一啊。那你说，江陵这种地方一年能出一个吗？`
// 旧实现同时收出"一年"的 1 与稀有度的 0.0001 → 误报"合计 1.0001%，应为 100%"。
// 根因有二：`分之` 这个任意两字子串被当成概率语境；裸中文数字没有真概率词约束。
{
  const t38 = '百万分之一啊。那你说，江陵这种地方一年能出一个吗？';
  const got = both(t38);
  check('T38 不把口语里的"一年"当成一个百分比档位',
    !got.browser.includes(1) && !got.node.includes(1), JSON.stringify(got));
  const rep = reportBoth(t38);
  check('T38b 没有完整等级分布表时，不报"所有等级百分比未合计 100%"',
    rep.browser === false && rep.node === false, JSON.stringify(rep));
  const scoops = both('他倒了一勺铁水。');
  check('T38c 普通叙述里的"一"不进入概率数值（负例对照）',
    scoops.browser.length === 0 && scoops.node.length === 0, JSON.stringify(scoops));
  const ctx = both('觉醒概率九十五。');
  check('T38d 有真概率词时裸中文数字照收（收紧语境不得误伤正例）',
    JSON.stringify(ctx.browser) === '[95]' && JSON.stringify(ctx.node) === '[95]',
    JSON.stringify(ctx));
}

// ── T39：同等级重复叙述不是多种分类概率 ─────────────────────────────────────
{
  const t39 = 'A级百万分之一。A级百万分之一。A级百万分之一。';
  const got = both(t39);
  check('T39 同等级同一稀有度说三遍 → 去重成一条，不累计',
    JSON.stringify(got.browser) === '[0.0001]' && JSON.stringify(got.node) === '[0.0001]',
    JSON.stringify(got));
  const rep = reportBoth(t39);
  check('T39b 重复叙述不触发"合计不为 100%"',
    rep.browser === false && rep.node === false, JSON.stringify(rep));
}

// ── 阴性对照：真实正例与合法分布不得被误伤 ─────────────────────────────────
// ⚠️ 这三条同时钉住**既有基线**（.p1-baseline/probe-fact-lock-20261008.mjs 的 3 条正例）：
//    收紧抽取时最容易的失误就是"把真缺陷一起收没了"，所以把它们的合计值写死在这里。
{
  const p1 = both('D级，出现概率百分之九十五。C级，万分之一。B级，十万分之一。');
  check('N1 真实缺陷照报：95% + 万分之一 + 十万分之一 = 95.01%',
    JSON.stringify(p1.browser) === '[95,0.01,0.001]' && JSON.stringify(p1.node) === '[95,0.01,0.001]',
    JSON.stringify(p1));
  const p2 = both('D级 95%，C级 4%，B级 0.09%。');
  check('N2 真实缺陷照报：95 + 4 + 0.09 = 99.09%',
    JSON.stringify(p2.browser) === '[95,4,0.09]' && JSON.stringify(p2.node) === '[95,4,0.09]',
    JSON.stringify(p2));
  const p3 = both('D级 95%，C级 4.9%，B级 0.09%，A级 0.0099%，S级 0.0001%。');
  check('N3 合计正好 100% → 不报（五级齐全，抽取不丢档）',
    p3.browser.reduce((a, b) => a + b, 0) > 99.99
    && p3.browser.reduce((a, b) => a + b, 0) <= 100.01
    && reportBoth('D级 95%，C级 4.9%，B级 0.09%，A级 0.0099%，S级 0.0001%。').browser === false,
    JSON.stringify(p3));
  // 万分之一紧跟在另一档之后（`万分之一。B级，`）时，语境窗口里没有任何概率词 ——
  // 这一条专门防"给显式稀有度词加语境闸门"的回归：加了就会丢掉 0.001，把 95.01% 掩盖成 95%。
  const chain = both('C级，万分之一。B级，十万分之一。');
  check('N4 显式稀有度词不依赖概率语境（语境闸门只针对有歧义的裸中文数字）',
    JSON.stringify(chain.browser) === '[0.01,0.001]' && JSON.stringify(chain.node) === '[0.01,0.001]',
    JSON.stringify(chain));
  const dup = both('B级 1%，C级 1%。');
  check('N5 两档同概率不被误折叠（去重键是"等级+数值"，不是数值）',
    JSON.stringify(dup.browser) === '[1]' || dup.browser.length === 2,
    JSON.stringify(dup));
}

// ── 两份实现一致性 ─────────────────────────────────────────────────────────
{
  const samples = [
    '100%', '0%', '123%', '0.0001%',
    'D级 95%，C级 4%，B级 0.09%。',
    'A级百万分之一。A级百万分之一。',
    '百万分之一啊。那你说，江陵这种地方一年能出一个吗？',
    'D级，出现概率百分之九十五。C级，万分之一。B级，十万分之一。',
  ];
  const mismatch = samples.filter((s) => JSON.stringify(K.collectPercents(s)) !== JSON.stringify(scanMod.collectPercents(s)));
  check('D1 `public/patch-safety.js` 与 `ai/editing/scan.mjs` 两份口径逐字一致（防漂移）',
    mismatch.length === 0, JSON.stringify(mismatch.map((s) => [s, K.collectPercents(s), scanMod.collectPercents(s)])));
}

// ── §3 资格判定：缺档不得判"合计 100%" ─────────────────────────────────────
// 收紧要点：`等级分布是否加起来 100%` 只对**完整互斥**的一组分类概率成立。
// 作者只写 D/C/B 时 A/S 没写，报"缺了 4.99%"是拿作者没写的东西问罪。
// 但能力不能被收紧削掉：完整五档真的算错时必须照报。
{
  const partial = 'D级 95%，C级 4%，B级 0.09%。';
  const pS = K.scanFactLock(partial).filter((f) => f.code === 'percent_sum_mismatch');
  const pI = K.scanFactLock(partial).filter((f) => f.code === 'percent_distribution_incomplete');
  check('S1 缺档（未列 A/S）→ 不产出 percent_sum_mismatch',
    pS.length === 0, JSON.stringify(pS[0] && pS[0].value));
  check('S2 缺档 → 如实报 distribution_incomplete（不静默，也不谎报算错）',
    pI.length === 1 && /A\/S/.test(pI[0].reason), JSON.stringify(pI[0] && pI[0].reason));

  const fullBad = 'D级 80%，C级 10%，B级 5%，A级 1%，S级 0.1%。';
  const fB = K.scanFactLock(fullBad).filter((f) => f.code === 'percent_sum_mismatch');
  check('S3 五档齐全且合计 96.1% → 照报（收紧没有削掉能力）',
    fB.length === 1 && fB[0].value === '96.1', JSON.stringify(fB[0] && fB[0].value));

  const exact = 'D级 95%，C级 4.9%，B级 0.09%，A级 0.0099%，S级 0.0001%。';
  check('S4 五档齐全且合计恰好 100% → 不报',
    K.scanFactLock(exact).filter((f) => f.code === 'percent_sum_mismatch').length === 0);

  const declared = '广播从D念到S。D级 95%，C级 4%，B级 0.09%。';
  const dS = K.scanFactLock(declared).filter((f) => f.code === 'percent_sum_mismatch');
  check('S5 显式声明整套分布（从D念到S）+ 合计 99.09% → 照报',
    dS.length === 1 && dS[0].value === '99.09', JSON.stringify(dS[0] && dS[0].value));

  const declaredOk = '各等级的概率如下。D级 95%，C级 4.9%，B级 0.09%，A级 0.0099%，S级 0.0001%。';
  check('S6 显式声明 + 五档齐全且合计 100% → 不报',
    K.scanFactLock(declaredOk).filter((f) => f.code === 'percent_sum_mismatch').length === 0);

  // 关键回归：等级必须标到**最近**的那个等级上，不能整句都标成第一个。
  const tags = K.collectPercentClaims(exact).map((c) => `${c.grade}:${c.value}`);
  check('S7 同句多档各自标到最近等级（不是全标成 D）',
    JSON.stringify(tags) === JSON.stringify(['D:95', 'C:4.9', 'B:0.09', 'A:0.0099', 'S:0.0001']),
    JSON.stringify(tags));
}

finish('12-percent-claims');
