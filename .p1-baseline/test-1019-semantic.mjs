#!/usr/bin/env node
/**
 * .p1-baseline/test-1019-semantic.mjs —— v1.2.1 质量闭环 P0-6：逐条确定性 + 语义验收。
 *
 * 覆盖方案 §12：R-05 / R-06 / R-07 / R-13 / R-16 / R-17 / R-22 及"两层冲突"反例。
 * 核心契约：语义未运行 → 永不 pass；语义 pass 不能覆盖确定性 fail；无 diff 不算已改。
 *
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
await import(new URL('../public/revision-patch.js', import.meta.url).href);
await import(new URL('../public/revision-plan.js', import.meta.url).href);
await import(new URL('../public/revision-semantic-verifier.js', import.meta.url).href);
const RP = globalThis.NovelRevisionPatch;
const PL = globalThis.NovelRevisionPlan;
const SV = globalThis.NovelRevisionSemanticVerifier;

const BODY = [
  '岳宸炎把检测单折过两折，纸边对齐得很仔细。',
  '',
  '王磊把单子拍在桌上，职业方向那一栏印着“基础战斗能力”。',
  '',
  '林清雪把袖口往上拢了拢，细白的手腕露出来。',
  '',
  '检测单也在同一个口袋里，折过一折。',
].join('\n');
const SNAP = RP.snapshotOf(BODY, { chapter_id: 731 });
const findSpan = (fragment) => {
  const at = BODY.indexOf(fragment);
  if (at < 0) throw new Error(`fixture 里没有 ${fragment}`);
  return { start: at, end: at + fragment.length };
};
const patchFor = (issueId, fragment, replacement) => {
  const sp = findSpan(fragment);
  return { issue_ids: [issueId], span_id: `p1s1~0`, op: 'replace', original: fragment, replacement, start: sp.start, end: sp.end };
};
const applyPatches = (patches) => {
  let out = BODY;
  for (const p of patches.slice().sort((a, b) => b.start - a.start)) {
    out = out.slice(0, p.start) + p.replacement + out.slice(p.end);
  }
  return out;
};

const finding = {
  id: 'R-0001', title: '检测单折数', type: 'continuity',
  explanation: '开篇两折、章尾一折',
  evidence: [
    { quote: '折过两折', role: 'reference' },
    { quote: '折过一折', role: 'candidate_edit' },
  ],
  acceptance: { rule: '折数与动作链一致', preserve: ['检测单'] },
};
const plan = PL.buildRevisionPlanV2({ snapshot: SNAP, findings: [finding] });
const goodPatch = patchFor('R-0001', '折过一折', '已经展开过');
const revised = applyPatches([goodPatch]);
const coverage = (status = 'patched') => ({ issue_id: 'R-0001', status });

// ── R-06 / 语义通过 ─────────────────────────────────────────────────────────
{
  const one = SV.verifyIssue({
    finding, baseText: BODY, revisedText: revised, applied: [goodPatch], plan,
    coverage: coverage('patched'), invariants: { must_keep: ['检测单'] },
    semantic: { status: 'pass', reason: '动作链自洽', confidence: 'high', checks: [{ criterion: '折数与动作一致', passed: true, evidence: ['两折→展开'] }] },
  });
  check('R-06a 合规局部修改 + 语义通过 → verdict=pass / ISSUE_VERIFIED',
    one.verdict === 'pass' && one.final_status === 'ISSUE_VERIFIED',
    JSON.stringify({ verdict: one.verdict, final: one.final_status }));
  check('R-06b 确定性检查全部通过（证据角色 + 保留项）',
    one.checks.every((c) => c.passed === true) && one.checks.length >= 3,
    JSON.stringify(one.checks.map((c) => `${c.passed}:${c.criterion}`)));
  check('R-06c 语义层结论被保留（confidence/reason 可追溯）',
    one.confidence === 'high' && one.reason.includes('动作链'),
    JSON.stringify({ confidence: one.confidence }));
}

// ── R-16 / 语义未运行：最多待复核 ───────────────────────────────────────────
{
  const one = SV.verifyIssue({
    finding, baseText: BODY, revisedText: revised, applied: [goodPatch], plan,
    coverage: coverage('patched'), invariants: { must_keep: ['检测单'] },
  });
  check('R-16a 补丁过门禁但语义核验没跑 → need_context（不得判为已解决）',
    one.verdict === 'need_context' && one.final_status === 'AWAITING_SEMANTIC'
    && one.semantic_status === 'not_run' && one.reason_code === 'SEMANTIC_NOT_RUN',
    JSON.stringify(one));
  check('R-16b 界面可直接引用的理由写明"确定性层不证明问题解决"',
    /不证明|不能证明|不得判为已解决/.test(one.reason),
    one.reason);
}

// ── R-05 / 冲突仍在：语义失败或证据残留都不得通过 ───────────────────────────
{
  const stillThere = SV.verifyIssue({
    finding, baseText: BODY, revisedText: BODY, applied: [], plan,
    coverage: coverage('patched'), invariants: { must_keep: [] },
  });
  check('R-05a 正文没变却声称已改 → NO_DIFF 失败（not ISSUE_VERIFIED）',
    stillThere.verdict === 'fail' && stillThere.final_status === 'UNRESOLVED'
    && stillThere.checks.some((c) => c.code === 'NO_DIFF' && !c.passed),
    JSON.stringify(stillThere.reason_code));

  const semanticFail = SV.verifyIssue({
    finding, baseText: BODY, revisedText: revised, applied: [goodPatch], plan,
    coverage: coverage('patched'), invariants: { must_keep: [] },
    semantic: { status: 'fail', reason: '章尾仍是“一折”，只是换了说法', repair_hint: '只在章尾热点内调整' },
  });
  check('R-05b 语义判失败 → UNRESOLVED，并带定向复修提示',
    semanticFail.verdict === 'fail' && semanticFail.final_status === 'UNRESOLVED'
    && semanticFail.reason_code === 'SEMANTIC_FAILED' && semanticFail.repair_hint.length > 0,
    JSON.stringify({ code: semanticFail.reason_code, hint: semanticFail.repair_hint }));
}

// ── 两层冲突：确定性 fail 不得被语义 pass 覆盖 ──────────────────────────────
{
  // 模型只改了句子里的无关部分，"折过一折"仍原样存在 → 确定性 fail；语义层却自报通过。
  const partial = applyPatches([patchFor('R-0001', '同一个口袋里', '口袋深处')]);
  const conflict = SV.verifyIssue({
    finding, baseText: BODY, revisedText: partial, applied: [patchFor('R-0001', '同一个口袋里', '口袋深处')], plan,
    coverage: coverage('patched'), invariants: { must_keep: [] },
    semantic: { status: 'pass', reason: '模型自报已修好' },
  });
  check('Y-01 确定性 fail + 语义 pass → need_context（LAYER_CONFLICT，不择一看运气）',
    conflict.verdict === 'need_context' && conflict.reason_code === 'LAYER_CONFLICT',
    JSON.stringify(conflict.reason_code));
  check('Y-02 冲突时 final_status 不是 ISSUE_VERIFIED',
    conflict.final_status !== 'ISSUE_VERIFIED', conflict.final_status);
}

// ── R-07 / R-13 / 证据角色 ─────────────────────────────────────────────────
{
  // R-13：删掉"细白的手腕"，保留"拢袖口"动作。
  const f8 = {
    id: 'R-0008', title: '外貌模板', type: 'style',
    evidence: [{ quote: '细白的手腕', role: 'candidate_edit' }],
    acceptance: { rule: '不再出现模板形容且保留动作', preserve: ['把袖口往上拢了拢'] },
  };
  const p8 = patchFor('R-0008', '细白的手腕', '袖口松了一截');
  const r8 = applyPatches([p8]);
  const one = SV.verifyIssue({
    finding: f8, baseText: BODY, revisedText: r8, applied: [p8],
    plan: null, coverage: { issue_id: 'R-0008', status: 'patched' },
    semantic: { status: 'pass', reason: '动作与伏笔保留' },
  });
  check('R-13a 删模板形容但保留动作 → 确定性通过 + 可判 ISSUE_VERIFIED',
    one.verdict === 'pass' && one.final_status === 'ISSUE_VERIFIED',
    JSON.stringify(one.checks.map((c) => `${c.passed}:${c.criterion}`)));

  const destroyed = SV.verifyIssue({
    finding: { ...f8, acceptance: { rule: '', preserve: [] } },
    baseText: BODY, revisedText: applyPatches([patchFor('R-0008', '细白的手腕', ''), patchFor('R-0008', '把袖口往上拢了拢', '')]),
    applied: [patchFor('R-0008', '细白的手腕', ''), patchFor('R-0008', '把袖口往上拢了拢', '')],
    plan: null, coverage: { issue_id: 'R-0008', status: 'patched' },
    semantic: { status: 'pass', reason: '模型自报' },
    invariants: { must_keep: ['把袖口往上拢了拢'] },
  });
  check('R-13b 把"必须保留"的动作一起删掉 → 确定性 fail（语义 pass 也被冲突挡住）',
    destroyed.verdict === 'need_context' && destroyed.checks.some((c) => c.code === undefined && !c.passed && /必须保留/.test(c.criterion)),
    JSON.stringify(destroyed.checks.filter((c) => !c.passed).map((c) => c.criterion)));
}

// ── R-07：字段/角色错配由语义层判失败（确定性层不装懂语义）─────────────────
{
  const f2 = {
    id: 'R-0002', title: '栏位错填', type: 'canon',
    evidence: [{ quote: '基础战斗能力', role: 'candidate_edit' }],
    acceptance: { rule: '“基础战斗能力”不得作为职业方向栏的值', preserve: ['职业方向'] },
  };
  const p2 = patchFor('R-0002', '基础战斗能力', '战斗系·见习');
  const r2 = applyPatches([p2]);
  const pass = SV.verifyIssue({
    finding: f2, baseText: BODY, revisedText: r2, applied: [p2], plan: null,
    coverage: { issue_id: 'R-0002', status: 'patched' },
    semantic: { status: 'pass', reason: '等级评价不再填入职业方向' },
  });
  check('R-07a 证据消失 + 语义确认 → ISSUE_VERIFIED（确定性层不越权判语义）',
    pass.verdict === 'pass' && pass.final_status === 'ISSUE_VERIFIED');
  const fail = SV.verifyIssue({
    finding: f2, baseText: BODY, revisedText: r2, applied: [p2], plan: null,
    coverage: { issue_id: 'R-0002', status: 'patched' },
    semantic: { status: 'fail', reason: '只是把短语删了，“职业方向”栏仍然没有合法值' },
  });
  check('R-07b 语义判"删短语蒙混"不成立 → UNRESOLVED',
    fail.verdict === 'fail' && fail.reason_code === 'SEMANTIC_FAILED');
}

// ── R-22 / 越权 / 重建不一致 ────────────────────────────────────────────────
{
  const outOfScope = SV.verifyIssue({
    finding, baseText: BODY, revisedText: applyPatches([patchFor('R-0001', '职业方向', '职业')]),
    applied: [patchFor('R-0001', '职业方向', '职业')], plan,
    coverage: coverage('patched'), semantic: { status: 'pass' },
  });
  check('R-22a 补丁改到授权热点之外 → OUT_OF_SCOPE，不因语义 pass 而通过',
    outOfScope.verdict !== 'pass' && outOfScope.checks.some((c) => c.code === 'OUT_OF_SCOPE' && !c.passed),
    JSON.stringify(outOfScope.reason_code));

  const stale = SV.verifyIssue({
    finding, baseText: BODY, revisedText: revised, applied: [goodPatch], plan,
    coverage: coverage('patched'), currentBaseHash: 'other-hash',
    semantic: { status: 'pass' },
  });
  check('R-22b 底稿哈希与计划快照不一致 → BASE_STALE 检查失败',
    stale.verdict !== 'pass' && stale.checks.some((c) => c.code === 'BASE_STALE' && !c.passed),
    JSON.stringify(stale.checks.filter((c) => !c.passed).map((c) => c.criterion)));

  const scrambled = SV.verifyIssues({
    findings: [finding], baseText: BODY,
    // 候选稿里有一处**没有补丁记录**的改动 → 全局重建失败。
    revisedText: `${BODY}\n\n多出来的一行。`,
    applied: [goodPatch], plan,
    coverage: [coverage('patched')],
    semanticByIssue: { 'R-0001': { status: 'pass' } },
  });
  check('R-17 全局 diff 与补丁重建不一致 → 所有条目按 DIFF_MISMATCH 失败',
    scrambled.issues[0].verdict === 'fail' && scrambled.issues[0].reason_code === 'DIFF_MISMATCH'
    && scrambled.summary.diff_ok === false,
    JSON.stringify(scrambled.issues[0].reason_code));
}

// ── 汇总状态与 CANON_CONFLICT ───────────────────────────────────────────────
{
  const batch = SV.verifyIssues({
    findings: [finding], baseText: BODY, revisedText: revised, applied: [goodPatch], plan,
    coverage: [coverage('patched')], invariants: { must_keep: ['检测单'] },
  });
  check('R-16c 批量裁决在语义缺失时整体为 NEEDS_REVIEW（不是 VERIFIED_CANDIDATE）',
    batch.verdict === 'NEEDS_REVIEW' && batch.summary.awaiting_semantic === 1 && batch.summary.verified === 0,
    JSON.stringify(batch.summary));

  const canon = SV.verifyIssues({
    findings: [finding], baseText: BODY, revisedText: revised, applied: [goodPatch], plan,
    coverage: [coverage('patched')], canonConflictIds: ['R-0001'],
    semanticByIssue: { 'R-0001': { status: 'pass' } },
  });
  check('R-10 蓝图冲突优先于语义通过 → final_status=CANON_CONFLICT',
    canon.issues[0].final_status === 'CANON_CONFLICT' && canon.verdict === 'CANON_CONFLICT',
    JSON.stringify({ final: canon.issues[0].final_status, verdict: canon.verdict }));
}

finish('test-1019-semantic');
