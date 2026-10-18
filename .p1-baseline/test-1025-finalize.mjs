#!/usr/bin/env node
/**
 * .p1-baseline/test-1025-finalize.mjs —— v1.2.4 P0C / P0D：
 * 单请求与分段**同一个最终验收出口**，语义覆盖必须完备，结论只允许沿状态机跃迁。
 *
 * 钉住的不变式（方案 §4.1 / §4.3 / §4.4 / §6.2 / §6.3 / §14.4）：
 *   Q-02 语义核验未运行 ⇒ `awaiting`，通过数不虚报；
 *   Q-10 single 与 segmented 的终审结果**等价**（成本/模型输出允许不同，判据不允许不同）；
 *   Q-11 同一 issue 横跨多片 ⇒ 合并后只认一个 final verdict；
 *   Q-12 分段合并不完整 ⇒ 不得 VERIFIED_CANDIDATE（fail-closed）；
 *   Q-13 全部通过但未入库 ⇒ VERIFIED_CANDIDATE，不是 PERSISTED_VERIFIED；
 *   Q-14 只有真写回并复核一致才 PERSISTED_VERIFIED；底稿变了 → BLOCKED。
 *
 * 另外覆盖 P0E/P0F 的两个纯函数模块（审稿工作区 / 时态设置页）的判据：
 *   顶部统计不许把"应用了几个补丁"说成"修好了几条"；底栏只给当前能执行的按钮。
 *
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
const asUrl = (rel) => new URL('../' + rel, import.meta.url).href;
await import(asUrl('public/revision-semantic-verifier.js'));
await import(asUrl('public/revision-closure.js'));
await import(asUrl('public/revision-finalize.js'));
await import(asUrl('public/review-workspace.js'));
await import(asUrl('public/revision-archive.js'));
await import(asUrl('public/temporal-settings.js'));
const SV = globalThis.NovelRevisionSemanticVerifier;
const CL = globalThis.NovelRevisionClosure;
const FZ = globalThis.NovelRevisionFinalize;
const RW = globalThis.NovelRevisionWorkspace;
const AR = globalThis.NovelRevisionArchive;
const TS = globalThis.NovelTemporalSettings;

const check1 = (id, desc, cond, detail = '') => check(id, desc, cond, detail);

// ── 素材：一段两小节正文 + 两条问题（B01 改了一处，B06 没改）────────────────
const PART1 = '开头：他把检测单折过两折。';
const PART2 = '结尾：检测单在口袋里折过一折。';
const BASE = `${PART1}\n\n${PART2}`;
const NEW2 = '结尾：检测单在口袋里折过两折。';
const AFTER = `${PART1}\n\n${NEW2}`;
const FINDINGS = [
  {
    id: 'B01', title: '折数前后不符', type: 'object_state',
    evidence: [
      { quote: '折过两折', role: 'reference' },
      { quote: '折过一折', role: 'candidate_edit' },
    ],
    acceptance: { rule: '折数一致', preserve: ['检测单'] },
  },
  {
    id: 'B06', title: '光照重复', type: 'narrative_style',
    evidence: [
      { quote: '上午的太阳照得人发暖', role: 'candidate_edit' },
    ],
    acceptance: { rule: '纯布景重复删减' },
  },
];
const SELECTED = ['B01', 'B06'];
const COVERAGE = [
  { issue_id: 'B01', status: 'patched', target_count: 1, reference_count: 1 },
  { issue_id: 'B06', status: 'deferred', target_count: 0, reference_count: 0 },
];
const singleApplied = [{
  issue_ids: ['B01'], span_id: 'p2s1', op: 'replace',
  original: '折过一折', replacement: '折过两折',
  start: BASE.indexOf('折过一折'), end: BASE.indexOf('折过一折') + 4,
}];

const single = FZ.finalizeRevisionCandidate({
  mode: 'single', originalText: BASE, candidateText: AFTER,
  selectedIssueIds: SELECTED, applied: singleApplied, coverage: COVERAGE, findings: FINDINGS,
});
const segmented = FZ.finalizeRevisionCandidate({
  mode: 'segmented', originalText: BASE, candidateText: AFTER,
  selectedIssueIds: SELECTED,
  // 分段没有整章偏移：按"片 + issue"记账；重建证明由 segments + mergeComplete 给
  applied: [
    { issue_ids: ['B01'], segment_id: 'seg-2', op: 'replace', original: '', replacement: '' },
  ],
  coverage: [],
  // 分段覆盖表是各片处置的并集：与单请求路径必须等价
  segmentCoverage: COVERAGE,
  segments: [
    { segment_id: 'seg-1', status: 'done', proof_ok: true, issue_ids: [], patch_count: 0 },
    { segment_id: 'seg-2', status: 'done', proof_ok: true, issue_ids: ['B01'], patch_count: 1 },
  ],
  mergeComplete: true,
  findings: FINDINGS,
});

// ── Q-10：两条路径的终审结果必须等价 ────────────────────────────────────────
check1('FZ-01 Q-10 single 与 segmented 的终审结论等价（同一份素材、同一套判据）',
  single.parity.key === segmented.parity.key && single.status === segmented.status
    && JSON.stringify(single.rows.map((r) => [r.issue_id, r.final_status, r.reason_code]))
      === JSON.stringify(segmented.rows.map((r) => [r.issue_id, r.final_status, r.reason_code])),
  JSON.stringify({ single: single.parity.key, segmented: segmented.parity.key }));

check1('FZ-02 Q-02 语义核验未运行 ⇒ 状态停在 AWAITING_SEMANTIC，verified 恒为 0',
  single.status === 'AWAITING_SEMANTIC' && single.summary.verified === 0
    && single.summary.awaiting_semantic === 2 && single.coverage.complete === false,
  JSON.stringify(single.summary));

check1('FZ-03 Q-11 同一 issue 横跨多片时只认一个 final verdict（不会变成两个"各自通过"）',
  segmented.rows.filter((r) => r.issue_id === 'B01').length === 1
    && segmented.rows.length === SELECTED.length,
  JSON.stringify(segmented.rows.map((r) => r.issue_id)));

// ── Q-12：分段证明缺失/有片失败 ⇒ BLOCKED，绝不产出 VERIFIED_CANDIDATE ──────
{
  const unproven = FZ.finalizeRevisionCandidate({
    mode: 'segmented', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: [], coverage: [],
    segments: [{ segment_id: 'seg-1', status: 'done', proof_ok: true }],
    mergeComplete: false, findings: FINDINGS,
  });
  check1('FZ-04 Q-12 分段合并没有证明 ⇒ BLOCKED（fail-closed），每条都是 UNRESOLVED',
    unproven.status === 'BLOCKED' && unproven.rows.every((r) => r.final_status === 'UNRESOLVED')
      && unproven.rows.every((r) => r.reason_code === 'SEGMENT_MERGE_UNPROVEN'),
    JSON.stringify({ status: unproven.status, codes: unproven.rows.map((r) => r.reason_code) }));

  const failedSeg = FZ.finalizeRevisionCandidate({
    mode: 'segmented', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: [], coverage: [],
    segments: [
      { segment_id: 'seg-1', status: 'done', proof_ok: true },
      { segment_id: 'seg-2', status: 'failed', proof_ok: false },
    ],
    mergeComplete: true, findings: FINDINGS,
  });
  check1('FZ-05 Q-12 有片失败/越界 ⇒ BLOCKED（SEGMENT_SEGMENT_FAILED），不得冒充全章完成',
    failedSeg.status === 'BLOCKED'
      && failedSeg.rows.every((r) => r.reason_code === 'SEGMENT_SEGMENT_FAILED'),
    JSON.stringify({ status: failedSeg.status, codes: failedSeg.rows.map((r) => r.reason_code) }));

  const segNoProof = FZ.finalizeRevisionCandidate({
    mode: 'segmented', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: [], coverage: [],
    segments: [{ segment_id: 'seg-1', status: 'done', proof_ok: false }],
    mergeComplete: true, findings: FINDINGS,
  });
  check1('FZ-06 Q-12 某一片的"补丁能重建片输出"证明失败 ⇒ 同样 BLOCKED（片内对不上就不许往下走）',
    segNoProof.status === 'BLOCKED', JSON.stringify({ status: segNoProof.status }));
}

// ── §4.3 语义覆盖完备性 ─────────────────────────────────────────────────────
{
  const cov = FZ.semanticCoverageComplete(['B01', 'B02', 'B03'], [
    { issue_id: 'B01', verdict: 'pass' },
    { issue_id: 'B02', verdict: 'fail' },
  ]);
  check1('FZ-07 §4.3 覆盖完备性：缺失与"有行但没结论"要分开报（missing/pending 不能混为一谈）',
    cov.complete === false && cov.missing.join(',') === 'B03' && cov.covered.length === 2
      && cov.pending.length === 0,
    JSON.stringify(cov));

  const cov2 = FZ.semanticCoverageComplete(['B01', 'B03'], [
    { issue_id: 'B01', verdict: 'pass' },
    { issue_id: 'B03', verdict: 'not_run' },
  ]);
  check1('FZ-08 §4.3 `not_run` 不是一个 verdict：它在 pending 里，不算覆盖',
    cov2.complete === false && cov2.pending.join(',') === 'B03' && cov2.covered.join(',') === 'B01',
    JSON.stringify(cov2));

  const cov3 = FZ.semanticCoverageComplete(['B01', 'B02', 'B03'], [
    { issue_id: 'B01', verdict: 'pass' },
    { issue_id: 'B02', verdict: 'fail' },
    { issue_id: 'B03', verdict: 'need_context' },
  ]);
  check1('FZ-09 §4.3 pass/fail/need_context 都算"被回答过"（才能进复修/待裁决分支）',
    cov3.complete === true, JSON.stringify(cov3));
}

// ── §4.1 状态跃迁：只有独立事实才允许"通过/入库" ────────────────────────────
{
  const verifiedSemantic = Object.fromEntries(FINDINGS.map((f) => [f.id, { status: 'pass', reason: '逐条通过' }]));
  const allPass = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: singleApplied, coverage: COVERAGE, findings: FINDINGS,
    semanticByIssue: verifiedSemantic,
  });
  check1('FZ-10 Q-13 全部通过但作者没合并 ⇒ VERIFIED_CANDIDATE（候选稿，不是已入库定稿）',
    allPass.status === 'VERIFIED_CANDIDATE' && allPass.summary.verified === 2
      && allPass.next_action.code === 'AWAIT_AUTHOR_COMMIT',
    JSON.stringify({ status: allPass.status, next: allPass.next_action.code }));

  const persisted = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: singleApplied, coverage: COVERAGE, findings: FINDINGS,
    semanticByIssue: verifiedSemantic, persisted: true, baseMatches: true,
  });
  check1('FZ-11 Q-14 真写回且保存后版本一致 ⇒ PERSISTED_VERIFIED',
    persisted.status === 'PERSISTED_VERIFIED' && persisted.next_action.code === 'DONE',
    JSON.stringify({ status: persisted.status }));

  const stale = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: singleApplied, coverage: COVERAGE, findings: FINDINGS,
    semanticByIssue: verifiedSemantic, persisted: true, baseMatches: false,
  });
  check1('FZ-12 写回后版本对不上（BASE_STALE）⇒ BLOCKED，不能宣称"已入库验证"',
    // 注意：这不是"这一项没修好"，而是"入库核对失败"——因此逐条结论保持原样（不伪造失败），
    // 整体状态必须停在 BLOCKED 并给出原因。
    stale.status === 'BLOCKED' && /底稿|BASE_STALE/.test(String(stale.reasons.join('；')))
      && stale.next_action.code === 'FIX_BLOCKER',
    JSON.stringify({ status: stale.status, reason: stale.reasons[0] }));

  const noSafety = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: SELECTED, applied: singleApplied, coverage: COVERAGE, findings: FINDINGS,
    safetyAvailable: false,
  });
  check1('FZ-13 安全门禁不可用 ⇒ BLOCKED（SAFETY_UNAVAILABLE），任何一条都不许"看起来修好了"',
    noSafety.status === 'BLOCKED'
      && noSafety.rows.every((r) => r.reason_code === 'SAFETY_UNAVAILABLE'),
    JSON.stringify({ status: noSafety.status, codes: noSafety.rows.map((r) => r.reason_code) }));
}

// ── 勾选清单是权威：8 项全选但只给了 7 条 findings 也要 8 行 ──────────────────
{
  const eight = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08'];
  const seven = FINDINGS.slice(0, 1);
  const r = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: AFTER,
    selectedIssueIds: eight, applied: singleApplied, coverage: COVERAGE, findings: seven,
  });
  check1('FZ-14 勾选的 8 项必须有 8 行结论（没有 finding 的条目也不能消失）',
    r.rows.length === 8 && r.rows.every((x) => x.final_status !== 'ISSUE_VERIFIED'),
    JSON.stringify(r.rows.map((x) => `${x.issue_id}:${x.final_status}`)));
  const noFindingNoCoverage = r.rows.filter((x) => !['B01', 'B06'].includes(x.issue_id));
  check1('FZ-15 没有验收记录且覆盖表也没回答的条目 ⇒ UNACCOUNTED（既不通过，也不冒充"待复验"）',
    noFindingNoCoverage.length === 6
      && noFindingNoCoverage.every((x) => x.final_status === 'UNRESOLVED' && x.reason_code === 'UNACCOUNTED'),
    JSON.stringify(noFindingNoCoverage.map((x) => [x.issue_id, x.reason_code])));
  check1('FZ-15b 没有 finding 但覆盖表已回答（B06 deferred）⇒ AWAITING_SEMANTIC + MODEL_KEEP',
    r.rows.find((x) => x.issue_id === 'B06').final_status === 'AWAITING_SEMANTIC'
      && r.rows.find((x) => x.issue_id === 'B06').reason_code === 'MODEL_KEEP',
    JSON.stringify(r.rows.find((x) => x.issue_id === 'B06')));
}

// ── §3.3 运行记录：只放 hash/计数/原因码，不放正文 ──────────────────────────
{
  const rec = FZ.runRecordOf(single, { lastUpdate: '2026-10-18T00:00:00.000Z' });
  const json = JSON.stringify(rec);
  check1('FZ-16 §3.3 运行记录含 run_id/base_hash/candidate_hash/mode/逐项计数，且 author_commit=NOT_RUN',
    rec.schema_version === '1.2.4' && rec.revision_run_id.startsWith('run:')
      && rec.base_hash === single.candidate.original_hash && rec.mode === 'single'
      && rec.author_commit === 'NOT_RUN' && Array.isArray(rec.issues) && rec.issues.length === 2,
    JSON.stringify({ run: rec.revision_run_id.slice(0, 24), mode: rec.mode }));
  check1('FZ-17 运行记录不含正文（诊断日志不能把作者稿子抄进去）',
    !json.includes('折过一折') && !json.includes('检测单在口袋里'),
    json.slice(0, 120));
  check1('FZ-18 记录里每条 issue 都有 evidence/target/patch/gate/semantic/final 六个字段',
    rec.issues.every((i) => ['evidence_count', 'authorized_target_count', 'patch_count', 'gate_status', 'semantic_status', 'final_status', 'reason_code'].every((k) => k in i)),
    JSON.stringify(rec.issues[0]));
}

// ── 闭环状态与终审状态必须一致（不许两套口径）────────────────────────────────
{
  check1('FZ-19 终审 status 与闭环 verdict 在"未全通过"时都不宣称完成',
    single.status === 'AWAITING_SEMANTIC' && single.closure
      && single.closure.verdict.status === 'PARTIAL'
      && single.closure.semantic_coverage_complete === false,
    JSON.stringify({ stage: single.status, closure: single.closure && single.closure.verdict.status }));
  check1('FZ-20 闭环报告把"待语义"单列，不会并进"已解决"',
    /待复核：2 条/.test(single.closure.text) && /语义验收通过：0 条/.test(single.closure.text),
    String(single.closure.text).split('\n').find((l) => l.includes('语义')) || '');
}

// ══════════════════════════════════════════════════════════════════════════
// P0E：审稿工作区（纯函数）
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = single.rows;
  const line = RW.summaryLine({ chapterTitle: '第一章', rows, patchedCount: 1 });
  check1('WS-01 顶部统计只报"已验证/待复验"，未复验时绝不出现"通过 N"',
    line.includes('已选 2') && !/已验证\s*[1-9]/.test(line) && !/通过\s*[1-9]/.test(line)
      && line.includes('已应用 1 补丁'),
    line);

  const issueRows = RW.issueRowsOf({ rows });
  check1('WS-02 左侧问题行两行以内：编号 + 标题 + 文字状态（颜色只是辅助）',
    issueRows.length === 2 && issueRows[0].ordinal && issueRows[0].status_text
      && issueRows.every((r) => ['ok', 'warn', 'bad', 'wait', 'muted'].includes(r.tone)),
    JSON.stringify(issueRows.map((r) => [r.ordinal, r.status_text])));

  check1('WS-03 筛选：待处理包含 AWAITING/UNRESOLVED/PARTIAL，已验证只含 ISSUE_VERIFIED',
    RW.filterRows(issueRows, 'pending').length === 2 && RW.filterRows(issueRows, 'verified').length === 0,
    JSON.stringify({ pending: RW.filterRows(issueRows, 'pending').length }));

  check1('WS-04 ↑/↓ 切换是循环的、且不改 issue 顺序（编号稳定）',
    RW.stepIssue(issueRows, 'B06', 1).issue_id === 'B01'
      && RW.stepIssue(issueRows, 'B01', -1).issue_id === 'B06',
    JSON.stringify([RW.stepIssue(issueRows, 'B06', 1).issue_id]));

  const ev = RW.evidenceOf(FINDINGS[0], BASE, AFTER);
  check1('WS-05 证据定位给出"修前/修后"两段上下文；可编辑锚点在修后消失要如实说明',
    ev.length === 2 && ev[0].before.found && ev[1].before.found && ev[1].after.found === false,
    JSON.stringify(ev.map((e) => [e.role, e.before.found, e.after.found])));

  check1('WS-06 引文不在正文里 ⇒ found=false + 原因（不假装高亮）',
    RW.locateQuote(BASE, '不存在的一句话').found === false
      && RW.locateQuote(BASE, '不存在的一句话').reason.includes('不在'),
    String(RW.locateQuote(BASE, '不存在的一句话').reason));

  const dupBody = '折过一折。后来还是折过一折。';
  const dup = RW.locateQuote(dupBody, '折过一折');
  check1('WS-07 同一引文出现多次 ⇒ 标 ambiguous，界面不默认第一处',
    dup.found === true && dup.ambiguous === true && dup.occurrence.includes('多处'),
    JSON.stringify({ ambiguous: dup.ambiguous }));

  const blocks = RW.diffBlocks(BASE, AFTER);
  check1('WS-08 差异块按段落配对：changed=1，其余 same；默认只显示差异',
    RW.diffSummary(blocks).changed === 1
      && RW.visibleBlocks(blocks, 'diff').length === 1
      && RW.visibleBlocks(blocks, 'full').length === blocks.length,
    JSON.stringify(RW.diffSummary(blocks)));

  const awaitingActions = RW.actionsOf({ stage: 'AWAITING_SEMANTIC', rows, semanticRuns: 0 });
  check1('WS-09 底栏按状态给按钮：待复验给"运行语义复验"，不给"合并到正文"',
    awaitingActions.some((a) => a.action === 'semantic-verify')
      && !awaitingActions.some((a) => a.action === 'merge'),
    JSON.stringify(awaitingActions.map((a) => a.action)));

  const verifiedActions = RW.actionsOf({ stage: 'VERIFIED_CANDIDATE', rows, semanticRuns: 1 });
  check1('WS-10 全部通过给"申请合并正文"；同一份候选不再提供重复付费复验',
    verifiedActions.some((a) => a.action === 'merge')
      && !verifiedActions.some((a) => a.action === 'semantic-verify'),
    JSON.stringify(verifiedActions.map((a) => a.action)));

  // 一条确定没通过 + 一条待复验：这正是"5 通过、3 待处理"这类真实形态
  const mixedRows = [
    { issue_id: 'B01', final_status: 'ISSUE_VERIFIED', title: '折数' },
    { issue_id: 'B03', final_status: 'UNRESOLVED', title: '母亲行程' },
    { issue_id: 'B06', final_status: 'AWAITING_SEMANTIC', title: '光照' },
  ];
  const partialActions = RW.actionsOf({ stage: 'PARTIAL_CANDIDATE', rows: mixedRows, semanticRuns: 1 });
  check1('WS-11 部分完成时合并按钮**明写剩余未通过数**（不伪称全通过）',
    partialActions.some((a) => a.action === 'merge-partial' && /仍有\s*1\s*条未通过/.test(a.label)),
    JSON.stringify(partialActions.map((a) => a.label)));

  const blockedActions = RW.actionsOf({ stage: 'BLOCKED', rows, semanticRuns: 0 });
  check1('WS-12 受阻时只给"返回/先处理阻塞"，不给任何执行型按钮',
    blockedActions.length === 1 && blockedActions[0].action === 'back',
    JSON.stringify(blockedActions.map((a) => a.action)));

  check1('WS-13 底部说明把"为什么现在不能合并"说清楚（列出未通过编号）',
    /未通过：#B01、#B06|未通过：.*B01/.test(RW.blockerText({ stage: 'PARTIAL_CANDIDATE', rows })),
    RW.blockerText({ stage: 'PARTIAL_CANDIDATE', rows }));

  const txt = RW.pendingChecklistText({ summaryLine: line, rows });
  check1('WS-14 导出待处理清单不含正文（只含编号/状态/原因/下一步）',
    txt.includes('#B01') && !txt.includes('检测单在口袋里') && txt.split('\n').length >= 3,
    txt.split('\n').slice(0, 3).join(' | '));

  check1('WS-15 阶段标签是文字（不是只有颜色）：六种阶段都有中文说明',
    ['AWAITING_SEMANTIC', 'PARTIAL_CANDIDATE', 'BLOCKED', 'VERIFIED_CANDIDATE', 'PERSISTED_VERIFIED', 'PERSISTED_UNVERIFIED']
      .every((s) => RW.stageOf(s).text && RW.stageOf(s).text.length > 2),
    RW.stageOf('AWAITING_SEMANTIC').text);

  // ── 2026-10-18 作者授权："跳过复验直接合并" + 复验进度条 + 合并后档位 ──────���
  const forced = awaitingActions.filter((a) => a.action === 'merge-forced');
  const forceWarn = RW.forcedMergeWarning();
  check1('WS-16 待复验档位给"跳过复验直接合并"次按钮，后果文案写明三条（无结论 / 可回退 / 不能再复验）',
    forced.length === 1 && forced[0].primary === false && forced[0].danger === true
      && forced[0].help === 'review_merge_forced'
      && /没有任何结论/.test(forceWarn.body) && /历史版本/.test(forceWarn.body)
      && /不能再对它做语义复验/.test(forceWarn.body) && forceWarn.title.includes('跳过'),
    JSON.stringify({ actions: awaitingActions.map((a) => a.action), title: forceWarn.title }));

  const busyActions = RW.actionsOf({ stage: 'AWAITING_SEMANTIC', rows, semanticRuns: 0, busy: true });
  check1('WS-17 复验进行中：按钮全置灰、主按钮改文案、且不再给"跳过合并"（结果落地前不给下一步）',
    busyActions.every((a) => a.disabled === true)
      && busyActions.some((a) => a.action === 'semantic-verify' && /正在复验/.test(a.label))
      && !busyActions.some((a) => a.action === 'merge-forced'),
    JSON.stringify(busyActions.map((a) => ({ a: a.action, d: !!a.disabled }))));

  const prog1 = RW.progressOf({ startedAt: 1000, now: 1000 + 12000, count: 8 });
  const prog2 = RW.progressOf({ startedAt: 1000, now: 1000 + 70000, count: 8 });
  check1('WS-18 进度条如实：不确定进度（不编百分比）+ 已用时间 + 阶段推进 + 明说拿不到内部进度',
    prog1.indeterminate === true && prog1.percent === null && /已用 0:12/.test(prog1.text)
      && /8 条问题/.test(prog1.text) && /拿不到模型内部进度/.test(prog1.text)
      && prog2.clock === '1:10' && prog1.phase !== prog2.phase,
    JSON.stringify({ a: prog1.text, b: prog2.text }));

  const afterSkip = RW.actionsOf({ stage: 'PERSISTED_UNVERIFIED', rows, semanticRuns: 0 });
  check1('WS-19 跳过复验合并后：能补跑一次复验（不是死路），也如实写"未做语义复验"（不冒充已复核）',
    afterSkip.some((a) => a.action === 'semantic-verify' && !a.disabled)
      && afterSkip.some((a) => a.action === 'back')
      && !afterSkip.some((a) => ['merge', 'merge-partial', 'merge-forced'].includes(a.action))
      && RW.stageOf('PERSISTED_UNVERIFIED').text.includes('未做语义复验')
      && RW.stageOf('PERSISTED_UNVERIFIED').tone === 'warn'
      && RW.blockerText({ stage: 'PERSISTED_UNVERIFIED', rows }).includes('没有结论'),
    JSON.stringify({ actions: afterSkip.map((a) => a.action), stage: RW.stageOf('PERSISTED_UNVERIFIED') }));

  // ── 2026-10-18 作者要求：三份存档 + 补验后仍可反悔 ─────────────────────────
  const AR_BASE = '审稿前原文';
  const AR_UNVER = '候选（未复验）';
  const AR_VER = '候选（已复验）';
  const unverifiedSlots = AR.buildSlots({ article: AR_BASE, candidateText: AR_UNVER, verified: false });
  const verifiedSlots = AR.buildSlots({ article: AR_BASE, candidateText: AR_VER, verified: true });
  check1('AR-01 存档三个槽位分开且不混淆：未复验候选只进 unverified 槽，已复验候选只进 verified 槽',
    unverifiedSlots.map((s) => s.id).join(',') === 'base,unverified'
      && verifiedSlots.map((s) => s.id).join(',') === 'base,verified'
      && unverifiedSlots.every((s) => s.content !== AR_VER)
      && verifiedSlots.every((s) => s.content !== AR_UNVER)
      && AR.slotOf('verified').title.includes('已语义复验'),
    JSON.stringify({ a: unverifiedSlots.map((s) => s.id), b: verifiedSlots.map((s) => s.id) }));

  const mem = {
    _m: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };
  let recs = AR.load(mem, 7);
  check1('AR-02 同一槽位同一内容不重复存（去重按内容指纹）；内容变了才允许再存一份',
    AR.hasSlot(recs, 'base', AR.hashOf(AR_BASE)) === false,
    JSON.stringify(recs));
  recs = AR.remember(mem, 7, 'base', { hash: AR.hashOf(AR_BASE), versionId: 11, at: '2026-10-18T20:00:00Z' });
  recs = AR.remember(mem, 7, 'unverified', { hash: AR.hashOf(AR_UNVER), versionId: 12, at: '2026-10-18T20:01:00Z' });
  check1('AR-03 存档索引记录版本 id，摘要如实报"已存 2 份、还缺已复验候选"（不吹成三份齐全）',
    AR.hasSlot(recs, 'base', AR.hashOf(AR_BASE)) && recs.base.version_id === 11
      && AR.summaryOf(recs).count === 2
      && /还没有：已复验候选/.test(AR.summaryOf(recs).line),
    AR.summaryOf(recs).line);

  recs = AR.remember(mem, 7, 'verified', { hash: AR.hashOf(AR_VER), versionId: 13, at: '2026-10-18T20:02:00Z' });
  check1('AR-04 三份齐全时摘要列出三种版本，且按章隔离（另一章读不到这一章的存档）',
    AR.summaryOf(recs).count === 3
      && /审稿前原文 \/ 未复验候选 \/ 已复验候选/.test(AR.summaryOf(recs).line)
      && AR.summaryOf(AR.load(mem, 8)).count === 0,
    JSON.stringify({ same: AR.summaryOf(recs).line, other: AR.summaryOf(AR.load(mem, 8)).line }));

  const verifiedActions2 = RW.actionsOf({ stage: 'VERIFIED_CANDIDATE', rows, semanticRuns: 1, archiveCount: 3 });
  const noArchive = RW.actionsOf({ stage: 'VERIFIED_CANDIDATE', rows, semanticRuns: 1, archiveCount: 0 });
  check1('AR-05 有存档才给"查看/回退"入口（0 份时不画一个点了没东西的按钮）',
    verifiedActions2.some((a) => a.action === 'archive' && /修稿存档 3 份/.test(a.label))
      && !noArchive.some((a) => a.action === 'archive'),
    JSON.stringify({ with: verifiedActions2.map((a) => a.action), without: noArchive.map((a) => a.action) }));
}

// ══════════════════════════════════════════════════════════════════════════
// P0F：时态引擎设置页（纯函数）
// ══════════════════════════════════════════════════════════════════════════
{
  const html = TS.groupsHtml({ runtime: '<div id="runtime-body">R</div>', rebuild: '<div id="rebuild-body">B</div>', migrate: '<div id="migrate-body">M</div>' }, 'runtime');
  const opened = (html.match(/<details[^>]*\bopen\b/g) || []).length;
  check1('TS-01 设置页分组：默认只展开一组（长列表不一次占满屏幕）',
    opened === 1 && html.includes('id="ts-group-runtime"') && /id="ts-group-runtime"[^>]*open/.test(html),
    `opened=${opened}`);

  check1('TS-02 分组标题/说明齐全，且三个分组都在（运行状态 / 重建 / 迁移回填）',
    TS.GROUPS.length === 3 && html.includes('运行状态与开关') && html.includes('影响分析与逐章重建')
      && html.includes('迁移 / 存量回填 / 校验'),
    JSON.stringify(TS.GROUPS.map((g) => g.id)));

  check1('TS-03 设置页有"返回故事状态"的普通视图跳转（不是弹窗关闭）',
    TS.headHtml({ statusText: '引擎未开启' }).includes('data-action="go-view"')
      && TS.headHtml({}).includes('data-view="ai-board"'),
    TS.headHtml({}).slice(0, 80));

  check1('TS-04 故事状态页只留一个"⚙ 时态引擎设置"入口',
    TS.entryButtonHtml().includes('temporal-settings')
      && /时态引擎设置/.test(TS.entryButtonHtml()),
    TS.entryButtonHtml().slice(0, 70));

  const summary = TS.storyStateSummaryHtml({ enabled: true, facts: 12, timeline: 3, knowledge: 40, proposals_pending: 2 });
  check1('TS-05 故事状态页一行摘要：开关状态 + 计数，不含长列表',
    summary.includes('时态引擎已开启') && summary.includes('正典事实 12') && !summary.includes('<ul'),
    summary.slice(0, 100));

  const compact = TS.characterSummaryHtml({ name: '林昭', known: 3, unknown: 1, suspected: 2, false_beliefs: 1, actionable: 3, undetermined: 4 });
  check1('TS-06 角色紧凑行：名字 + 各类计数默认可见，完整清单在 <details> 里按需展开',
    compact.startsWith('<details') && compact.includes('<summary') && compact.includes('林昭')
      && compact.includes('误信 1') && compact.includes('有误信/怀疑'),
    compact.slice(0, 90));

  check1('TS-07 不靠 zoom / transform:scale 解决拥挤（结构拆分而不是缩放）',
    !/zoom\s*:/.test(compact + html + summary) && !/transform:\s*scale/.test(compact + html + summary),
    'no zoom/scale');
}

finish('test-1025 统一终验出口 / 语义覆盖 / 审稿工作区 / 时态设置');
