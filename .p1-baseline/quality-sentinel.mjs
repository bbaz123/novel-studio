#!/usr/bin/env node
/**
 * quality-sentinel.mjs —— 质量信号的**客观指标哨兵**（决策 D8-#8 的零成本那一半）。
 *
 * ── 它是干什么的，以及它**不是**干什么的 ──────────────────────────────────────
 * 它衡量的是「**你改了多少**」——采纳率、编辑距离、输入/输出体量、耗时。
 * 它**不衡量「写得好不好」**。这两件事必须分清，否则最容易发生的是：
 * 指标变好看（改动变少、采纳率上升）被当成"质量提升"，而读者体验其实在变差。
 *
 * 分工（用户 2026-09-16 的决定）：
 *   · **日常哨兵** = 本工具，零成本，改完就跑，用来发现"是不是变差了"；
 *   · **关键改动的盲测** = 另一个人工对照流程（要花钱），用来判断"是不是更好了"。
 *
 * ── 为什么不自己写 SQL ────────────────────────────────────────────────────────
 * 汇总口径的唯一来源是 `server.js` 的 `summarizeAIEval()`（经 `GET /api/ai/eval`）。
 * 在这里重写一遍就是"同一个查询抄两份"——本项目已经因为这类拷贝栽过几次
 * （`entityCap` 三份、强度白名单两份）。所以本工具**只调端点**，不碰数据库。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────────
 *   node .p1-baseline/quality-sentinel.mjs                        # 看当前指标
 *   node .p1-baseline/quality-sentinel.mjs --work 2               # 只看某部作品
 *   node .p1-baseline/quality-sentinel.mjs --save baseline.json   # 存一份基线
 *   node .p1-baseline/quality-sentinel.mjs --compare baseline.json  # 与基线比（哨兵的核心用途）
 *
 * 只读 GET，不触发任何 AI 调用 → 零计费。
 */
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('--base', 'http://127.0.0.1:3737');
const WORK = arg('--work', '');
const SAVE = arg('--save', '');
const COMPARE = arg('--compare', '');

/**
 * 样本量下限：低于它就不下结论。
 * 理由：这套指标是**比率**（采纳率）与**均值**（编辑距离），两三条样本的波动
 * 远大于任何改动的影响——"样本少时不要下结论"必须由工具强制，而不是靠自觉。
 */
const MIN_SAMPLES = Number(arg('--min-samples', '10'));

async function fetchMetrics() {
  const url = `${BASE}/api/ai/eval${WORK ? `?work_id=${encodeURIComponent(WORK)}` : ''}`;
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.error(`✗ 连不上 ${BASE}：${e.message}`);
    console.error('  哨兵需要活实例（它刻意复用服务端的汇总口径，不自己写 SQL）。');
    process.exit(2);
  }
  if (!r.ok) { console.error(`✗ ${url} → HTTP ${r.status}`); process.exit(2); }
  const j = await r.json();
  if (!j || j.ok !== true) { console.error(`✗ 响应不像汇总结果：${JSON.stringify(j).slice(0, 200)}`); process.exit(2); }
  return j;
}

const fmt = (v) => (v == null ? '—' : String(v));
const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

const m = await fetchMetrics();
console.log('═══ 质量信号哨兵（客观指标；衡量"你改了多少"，不衡量"写得好不好"）═══');
console.log(`目标：${BASE}${WORK ? `　作品：#${WORK}` : '　（全部作品）'}`);
console.log(`时间：${new Date().toISOString()}\n`);
console.log(`  生成次数        ${fmt(m.generations)}`);
console.log(`  采纳次数        ${fmt(m.adopts)}　（丢弃 ${fmt(m.discards)}）`);
console.log(`  采纳率          ${pct(m.adoption_rate)}`);
console.log(`  平均输入字数    ${fmt(m.avg_chars_in)}`);
console.log(`  平均输出字数    ${fmt(m.avg_chars_out)}`);
console.log(`  平均耗时        ${m.avg_ms == null ? '—' : `${(m.avg_ms / 1000).toFixed(1)} 秒`}`);
console.log(`  平均编辑距离    ${fmt(m.avg_edit_distance)}　（采纳后作者还改了多少字）`);
console.log(`  事件总数        ${fmt(m.total)}`);

if (SAVE) {
  fs.writeFileSync(SAVE, JSON.stringify({ savedAt: new Date().toISOString(), base: BASE, work: WORK || null, metrics: m }, null, 2), 'utf8');
  console.log(`\n✓ 已存基线：${SAVE}`);
}

if (COMPARE) {
  if (!fs.existsSync(COMPARE)) { console.error(`\n✗ 找不到基线文件：${COMPARE}`); process.exit(2); }
  const prev = JSON.parse(fs.readFileSync(COMPARE, 'utf8'));
  const p = prev.metrics || {};
  console.log(`\n═══ 与基线比较（基线存于 ${prev.savedAt}）═══\n`);
  const rows = [
    ['生成次数', p.generations, m.generations],
    ['采纳率', p.adoption_rate, m.adoption_rate],
    ['平均输入字数', p.avg_chars_in, m.avg_chars_in],
    ['平均输出字数', p.avg_chars_out, m.avg_chars_out],
    ['平均编辑距离', p.avg_edit_distance, m.avg_edit_distance],
    ['平均耗时(ms)', p.avg_ms, m.avg_ms],
  ];
  for (const [name, a, b] of rows) {
    const shown = name === '采纳率' ? `${pct(a)} → ${pct(b)}` : `${fmt(a)} → ${fmt(b)}`;
    let delta = '';
    if (a != null && b != null && Number(a) !== 0) {
      const d = ((Number(b) - Number(a)) / Math.abs(Number(a))) * 100;
      delta = `　${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
    }
    console.log(`  ${name.padEnd(14, '　')} ${shown}${delta}`);
  }

  // 样本量闸：不够就不给结论。这是本工具最重要的一条——否则会拿噪声当信号。
  const nNow = Number(m.generations) || 0;
  const nPrev = Number(p.generations) || 0;
  const fresh = nNow - nPrev;
  console.log('');
  if (fresh < MIN_SAMPLES) {
    console.log(`⚠ 新增样本只有 ${fresh} 条（下限 ${MIN_SAMPLES}）——**不下结论**。`);
    console.log('  这套指标是比率与均值，几条样本的波动远大于任何改动的影响。');
    console.log('  继续用，积累够样本再比。');
    process.exitCode = 0;
  } else {
    console.log(`✓ 新增样本 ${fresh} 条（≥ ${MIN_SAMPLES}），可以看趋势。`);
    console.log('  提醒：指标变好只说明"作者改动更少/更快"，**不等于**小说更好看。');
    console.log('  要判断"更好"，需要关键改动时的人工盲测。');
  }
}
