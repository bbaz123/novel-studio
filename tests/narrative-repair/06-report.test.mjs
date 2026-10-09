/**
 * tests/narrative-repair/06-report.test.mjs —— E06：可解释报告的**确定性部分**（离线、零计费）。
 *
 * 界面渲染在 frontend-test（DOM 桩）里验；这里验两件必须与界面共用同一实现的东西：
 *   · `candidateWithoutIssue`：每个补丁带问题 ID、且能**单独撤销**（按位置从后往前重建，
 *     缺位置/与原稿不一致时如实失败，不部分应用）；
 *   · `comparisonVerdict`：**相对改善结论必须先读实际 diff**，未读 diff 时不得下结论。
 * 另外把"设置开关默认关闭不改变行为"钉在计划层（condense 需开关 + host 批准两道门）。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { RP } = await loadPublicModules();
await import(new URL('../../public/revision-plan.js', import.meta.url).href);
const PL = globalThis.NovelRevisionPlan;

const base = '第一段：陈默走进雨里。\n\n第二段：他站着没动。\n\n第三段：雨还在下。';
// 位置一律**算出来**（不手写偏移：手写过的 start/end 与真实文档不符，会把断言测成"位置校验失败"）。
const at = (s) => ({ start: base.indexOf(s), end: base.indexOf(s) + s.length });
const applied = [
  { issue: 1, op: 'replace', original: '第一段：陈默走进雨里。', replacement: '第一段：陈默撑着伞走进雨里。', ...at('第一段：陈默走进雨里。') },
  { issue: 2, op: 'replace', original: '第二段：他站着没动。', replacement: '第二段：他把伞收了。', ...at('第二段：他站着没动。') },
];

// ── 单独撤销一处 ────────────────────────────────────────────────────────────
{
  const one = PL.candidateWithoutIssue(base, applied, '2');
  check('E06-a 按问题 ID 单独撤销：只去掉那一处，其余改动保持不变',
    one.ok === true && one.dropped === 1 && one.remaining === 1
    && one.text.includes('撑着伞走进雨里') && one.text.includes('第二段：他站着没动。'),
    JSON.stringify(one.text));
  const none = PL.candidateWithoutIssue(base, applied, '9');
  check('E06-a2 撤销不存在的问题 → 明确失败（不静默返回原稿当成功）',
    none.ok === false && /没有找到/.test(none.reason));
  const missingPos = PL.candidateWithoutIssue(base, [
    { issue: 1, op: 'replace', original: '第一段：陈默走进雨里。', replacement: 'x' },
    { issue: 2, op: 'replace', original: '第二段：他站着没动。', replacement: 'y', start: 13, end: 22 },
  ], '2');
  check('E06-a3', '保留的补丁缺位置信息 → 拒绝重建（不部分应用、不猜位置）',
    missingPos.ok === false && /缺少位置信息/.test(missingPos.reason), JSON.stringify(missingPos));
  const keepFirst = PL.candidateWithoutIssue(base, applied, '2');
  const wrongOffset = PL.candidateWithoutIssue('完全不同的正文。', [
    { issue: 2, op: 'replace', original: '第二段：他站着没动。', replacement: 'y', start: 13, end: 22 },
    { issue: 9, op: 'replace', original: '不存在。', replacement: 'z', start: 0, end: 3 },
  ], '9');
  check('E06-a4', '保留的补丁位置与原稿不一致（源稿已变）→ 拒绝重建（明确理由）',
    keepFirst.ok === true && keepFirst.text.includes('撑着伞走进雨里')
    && wrongOffset.ok === false && /与原稿不一致/.test(wrongOffset.reason),
    JSON.stringify(wrongOffset));
  const delSeg = '第三段：雨还在下。';
  const del = PL.candidateWithoutIssue(base, [
    { issue: 1, op: 'replace', original: '第一段：陈默走进雨里。', replacement: '第一段：陈默撑着伞走进雨里。', ...at('第一段：陈默走进雨里。') },
    { issue: 3, op: 'delete', original: delSeg, replacement: '', ...at(delSeg) },
  ], '1');
  check('E06-a5', '撤销一处后，剩余的删除仍按原位置生效（跨操作类型也不串位）',
    del.ok === true && !del.text.includes(delSeg) && del.text.includes('第一段：陈默走进雨里。'),
    JSON.stringify(del.text));
}

// ── 相对改善必须有 diff ─────────────────────────────────────────────────────
{
  const noDiff = PL.comparisonVerdict({ metricDelta: -12, diffRead: false });
  check('E06-b 未读 diff 时不得给"改善"结论（只返回需要先看 diff）',
    noDiff.verdict === 'needs_diff_review' && /未读 diff/.test(noDiff.reason) && noDiff.metric_delta === -12);
  const readZero = PL.comparisonVerdict({ metricDelta: 0, diffRead: true });
  check('E06-b2 指标没变化时不得用"指标缺席"充当改善', readZero.verdict === 'consistent_no_metric_change');
  const improved = PL.comparisonVerdict({ metricDelta: -8, diffRead: true });
  check('E06-b3 读过 diff 也只能给"相对"观察，需作者确认（不写"质量已提升"）',
    improved.verdict === 'metric_improved_needs_author_confirmation' && /相对/.test(improved.reason) && /不得写成/.test(improved.reason));
  const empty = PL.comparisonVerdict({ metricDelta: -3, diffRead: true, diffEmpty: true });
  check('E06-b4 没有文本差异时不构成"改善"也不构成"变差"',
    empty.verdict === 'no_change' && /没有任何文本差异/.test(empty.reason));
}

// ── 开关默认关闭 → 行为不变（计划层） ───────────────────────────────────────
{
  const snap = RP.snapshotOf(base, { chapter_id: 3 });
  const find = [{ id: '1', text: '请压缩「第二段：他站着没动。」', suggested_action: 'condense' }];
  const off = PL.buildRevisionPlan({ snapshot: snap, findings: find });
  const onOnly = PL.buildRevisionPlan({ snapshot: snap, findings: find, allowCondense: true });
  // 跨句压缩（片段覆盖同一段里的两个句子）→ 需要 host 显式批准连续跨度。
  const wideText = '甲句。乙句。丙句。';
  const wideSnap = RP.snapshotOf(wideText, { chapter_id: 4 });
  const wideFind = [{ id: '2', text: '请压缩「乙句。丙句。」', suggested_action: 'condense' }];
  const spanAcross = PL.buildRevisionPlan({ snapshot: wideSnap, findings: wideFind, allowCondense: true });
  const onApproved = PL.buildRevisionPlan({
    snapshot: wideSnap,
    allowCondense: true,
    findings: wideFind.map((f) => ({ ...f, merged_span_approved: true })),
  });
  check('E06-c 默认关闭时 condense 一律 refused；单跨度压缩不需要额外批准，跨句压缩需要 host 显式批准',
    off.coverage[0].status === 'refused' && /允许对已选问题局部压缩/.test(off.coverage[0].reason)
    && onOnly.coverage[0].status === 'planned'
    && spanAcross.coverage[0].status === 'refused' && /merged_span_approved/.test(spanAcross.coverage[0].reason)
    && onApproved.coverage[0].status === 'planned',
    JSON.stringify([off.coverage[0].status, onOnly.coverage[0].status, spanAcross.coverage[0].status, onApproved.coverage[0].status]));
  const protectedRun = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: '1', text: '「第二段：他站着没动。」这句要改', suggested_action: 'replace' }],
    protectedSpans: ['第二段：他站着没动。'],
  });
  check('E06-d 「保护选中文本」生效时：目标落在保护范围内 → refused（修稿器不得命中）',
    protectedRun.hotspots.length === 0 && protectedRun.coverage[0].status === 'refused'
    && /受保护/.test(protectedRun.coverage[0].reason),
    JSON.stringify(protectedRun.coverage));
  const unprotected = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: '1', text: '「第二段：他站着没动。」这句要改', suggested_action: 'replace' }],
  });
  check('E06-d2 开关关闭（不传保护项）时同一处正常进计划 —— 默认行为未被改变',
    unprotected.hotspots.length === 1 && unprotected.coverage[0].status === 'planned');
}

// ── 对照视图的样本量守卫（E06："避免小样本过拟合"） ─────────────────────────
{
  const few = PL.revisionSampleGuard({ reviews: 1, runs: 2 });
  check('E06-f 样本不足时只允许看单次明细：不得据此判断趋势或写"改善"',
    few.enough === false && /样本不足/.test(few.note) && /不得据此判断趋势/.test(few.note) && few.reviews === 1 && few.runs === 2);
  const enough = PL.revisionSampleGuard({ reviews: 3, runs: 4 });
  check('E06-f2 样本够时也只给"相对观察"（不写成质量结论）',
    enough.enough === true && /相对观察/.test(enough.note) && !/质量已提升/.test(enough.note));
  check('E06-f3 缺参数/负数一律按 0 处理（守卫不因脏输入放行）',
    PL.revisionSampleGuard({}).enough === false && PL.revisionSampleGuard({ reviews: -5, runs: -1 }).enough === false);
}

// ── 覆盖表契约（界面与报告共用） ───────────────────────────────────────────
{
  const snap = RP.snapshotOf(base, { chapter_id: 3 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [
      { id: '1', text: '「第二段：他站着没动。」要改', suggested_action: 'replace' },
      { id: '2', text: '整体感觉不太好', suggested_action: 'replace' },
    ],
  });
  const table = PL.planCoverageTable(plan);
  check('E06-e 覆盖表逐项给出 issue_id / 是否计划了补丁 / 状态 / 理由（界面直接可用）',
    table.length === 2 && table[0].issue_id === '1' && table[0].patch_planned === true
    && table[1].status === 'needs_scope' && table[1].patch_planned === false
    && table.every((r) => typeof r.reason === 'string'));
}

finish('06-report');
