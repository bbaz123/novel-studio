#!/usr/bin/env node
/**
 * 装配器单元测试（P5 补齐）。
 *
 * 为什么需要：在此之前，装配器只有「在真实/压力数据上跑基线」这一种验证——
 * 那覆盖的是**典型路径**。以下边界从未被测过：
 *   · `context_overflow`（压到下限仍超预算）—— 我在 P2/P4 报告里承认它"从未被真实用例触发过"；
 *   · 没有查回路径的层，截断提示是否正确如实说明（而不是编一个查不到的工具名）；
 *   · 弹性层收缩是否**只**动弹性层、且按 FLEX_ORDER 顺序；
 *   · `computeFloor()` 与 `renderedCapOf()` 两条核算路径是否自洽。
 *
 * 纯离线、零依赖、不碰数据库。用法: node .p1-baseline/test-assembler.mjs
 */
import {
  LAYERS, FLEX_ORDER, FLEX_CAPS, TOTAL_BUDGET, RETRIEVAL,
  computeFloor, renderedCapOf, capOf, truncationNotice, headerOf, EMPTY_PLACEHOLDER,
} from '../ai/context/layers.mjs';
import { assemble, renderSection } from '../ai/context/assembler.mjs';

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ── renderSection ───────────────────────────────────────────────────────
console.log('\n【renderSection】');
{
  const empty = renderSection('测试层', '', 100);
  check('空正文渲染为占位符', empty.text === `${headerOf('测试层')}${EMPTY_PLACEHOLDER}` && empty.empty === true);

  const fits = renderSection('测试层', 'x'.repeat(50), 100);
  check('正文未超 cap 时不截断', fits.truncated === false && fits.emitted === 50);

  const over = renderSection('测试层', 'x'.repeat(500), 100, { retrievalTool: 'novel_events' });
  check('正文超 cap 时正文严格等于 cap', over.emitted === 100 && over.truncated === true);
  check('截断提示写明声明的查回工具', over.text.includes('novel_events'), over.text.slice(-60));

  const noTool = renderSection('测试层', 'x'.repeat(500), 100, { retrievalTool: '' });
  check('无查回路径时如实说明（不编造工具名）',
    noTool.text.includes('没有查回路径') && !/novel_/.test(noTool.text), noTool.text.slice(-60));

  const inf = renderSection('测试层', 'x'.repeat(500), Infinity);
  check('cap=Infinity 不截断（角色卡层的行为）', inf.truncated === false && inf.emitted === 500);
}

// ── assemble：常规路径 ──────────────────────────────────────────────────
console.log('\n【assemble · 常规】');
{
  const layers = [
    { id: 'work', label: '作品', kind: 'fixed', cap: 900, text: 'w'.repeat(100) },
    { id: 'memory', label: '长期记忆（已发生的故事摘要）', kind: 'fixed', cap: 2200, text: 'm'.repeat(100) },
  ];
  const r = assemble(layers, { mode: 'full' });
  check('文本 = 各段以空行相连', r.text === `${headerOf('作品')}${'w'.repeat(100)}\n\n${headerOf('长期记忆（已发生的故事摘要）')}${'m'.repeat(100)}`);
  check('未超预算时无 overflow', r.overflow === null);
  check('manifest 与文本自洽', r.manifest.reduce((n, m) => n + m.renderedLength, 0) + (r.manifest.length - 1) * 2 === r.text.length);
  check('空层被过滤（不产生空段）', assemble([null, undefined, { id: 'work', label: '作品', kind: 'fixed', cap: 900, text: 'a' }]).manifest.length === 1);
}

// ── assemble：收敛只动弹性层 ────────────────────────────────────────────
console.log('\n【assemble · 收敛】');
{
  const layers = [
    { id: 'memory', label: '长期记忆（已发生的故事摘要）', kind: 'fixed', cap: 2200, text: 'm'.repeat(2200) },
    { id: 'story_tail', label: '前文衔接', kind: 'flex', cap: 1600, text: 't'.repeat(4000) },
    { id: 'redlines', label: '写作风格红线', kind: 'fixed', cap: 4000, text: 'r'.repeat(4000) },
  ];
  // 预算刚好卡在：fixed 合计 6200 + 弹性层原样会超 → 必须压 story_tail
  const budget = 7000;
  const r = assemble(layers, { mode: 'full', totalBudget: budget });
  const mem = r.manifest.find((m) => m.id === 'memory');
  const red = r.manifest.find((m) => m.id === 'redlines');
  const tail = r.manifest.find((m) => m.id === 'story_tail');
  check('零损失层未被收缩（I3）', mem.emitted === 2200 && red.emitted === 4000);
  check('弹性层被收缩', tail.emitted < 1600, `emitted=${tail.emitted}`);
  check('收缩后仍在预算内', r.text.length <= budget, `${r.text.length} vs ${budget}`);
  check('收缩档位来自 FLEX_CAPS',
    FLEX_CAPS.includes(tail.emitted) || tail.emitted === 1600, `emitted=${tail.emitted}`);
}

// ── assemble：溢出必须显式报告（此前从未被触发过）────────────────────────
console.log('\n【assemble · 溢出（P2 起一直是"防御性、未触发"的分支）】');
{
  // 不收缩层本身就超预算 → 弹性层压到下限也无济于事 → 必须报 overflow，不得静默
  const layers = [
    { id: 'memory', label: '长期记忆（已发生的故事摘要）', kind: 'fixed', cap: 2200, text: 'm'.repeat(2200) },
    { id: 'events', label: '最近事件（事件账本）', kind: 'fixed', cap: 1800, text: 'e'.repeat(1800) },
  ];
  const budget = 1000; // 远低于不收缩层之和
  const r = assemble(layers, { mode: 'full', totalBudget: budget });
  check('超预算时产出 overflow 标记', r.overflow !== null);
  check('overflow 带预算/实际/超出量',
    r.overflow && r.overflow.budget === budget && r.overflow.actual === r.text.length && r.overflow.over === r.text.length - budget,
    JSON.stringify(r.overflow));
  check('overflow 时正文未被静默截断（零损失层不动）',
    r.manifest.every((m) => m.kind !== 'fixed' || m.emitted === m.bodyLength));
  check('overflow 时给出可执行的提示', !!(r.overflow && r.overflow.hint));

  // 反向：压得动的时候不应误报 overflow
  const ok = assemble([
    { id: 'story_tail', label: '前文衔接', kind: 'flex', cap: 1600, text: 't'.repeat(1600) },
  ], { mode: 'full', totalBudget: 600 });
  check('压得动时不误报 overflow', ok.overflow === null && ok.text.length <= 600);
}

// ── 预算核算自洽 ────────────────────────────────────────────────────────
console.log('\n【预算核算】');
{
  for (const mode of ['full', 'continuation', 'fragment', 'settings']) {
    const f = computeFloor(mode);
    const budget = mode === 'settings' ? TOTAL_BUDGET.settings : TOTAL_BUDGET.default;
    check(`[${mode}] 可执行下限 < 总预算（预算可达）`, f.floor < budget, `floor=${f.floor} budget=${budget}`);
  }
  check('continuation 的下限与 full 相同（只有弹性层 cap 变化）',
    computeFloor('continuation').floor === computeFloor('full').floor);
  check('settings 的层数少于 full',
    computeFloor('settings').headerTotal < computeFloor('full').headerTotal);

  // renderedCapOf 必须 ≥ 任何真实渲染结果——否则 I2 的核算上界失去意义
  let boundHolds = true;
  for (const spec of LAYERS) {
    const mode = 'full';
    const cap = capOf(spec, mode);
    const body = 'x'.repeat(Number.isFinite(cap) ? cap + 5000 : 5000);
    const rendered = renderSection(spec.label, body, cap, { retrievalTool: (RETRIEVAL[spec.id] || {}).tool || '' }).text.length;
    const bound = renderedCapOf(spec, mode);
    if (Number.isFinite(bound) && rendered > bound) { boundHolds = false; failures.push({ name: `renderedCapOf 上界被突破: ${spec.id}`, detail: `${rendered} > ${bound}` }); }
  }
  check('renderedCapOf 是所有层真实渲染长度的上界', boundHolds);
}

// ── 层规格自身的一致性 ──────────────────────────────────────────────────
console.log('\n【层规格一致性】');
{
  check('FLEX_ORDER 里的每个 id 都存在且是 flex 层',
    FLEX_ORDER.every((id) => { const s = LAYERS.find((l) => l.id === id); return s && s.kind === 'flex'; }));
  check('每个 flex 层都声明了 floor', LAYERS.filter((l) => l.kind === 'flex').every((l) => Number.isFinite(l.floor)));
  check('FLEX_CAPS 单调递减', FLEX_CAPS.every((c, i) => i === 0 || c < FLEX_CAPS[i - 1]));
  check('每个层 id 都有 RETRIEVAL 声明', LAYERS.every((l) => RETRIEVAL[l.id] !== undefined),
    LAYERS.filter((l) => !RETRIEVAL[l.id]).map((l) => l.id).join(','));
  check('声明了 tool 的层其 endpoint 或 note 至少有一个',
    LAYERS.every((l) => { const r = RETRIEVAL[l.id]; return !r.tool || r.endpoint || r.note || r.gap; }));
  check('截断提示句由工具名参数化（不再写死）',
    truncationNotice(100, 'novel_events').includes('novel_events') && !truncationNotice(100, 'x').includes('novel_lookup'));
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`装配器单元测试：通过 ${passed} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
}
process.exitCode = failures.length ? 1 : 0;
