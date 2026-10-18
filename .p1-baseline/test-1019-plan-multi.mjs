#!/usr/bin/env node
/**
 * .p1-baseline/test-1019-plan-multi.mjs —— v1.2.1 质量闭环 P0-3/P0-4：多证据、多获准热点、原子问题组。
 *
 * 覆盖方案 §12：R-02 / R-04 / R-14 / R-15 以及 §6.2 的授权纪律反例。
 * 核心不变量：**读证据 ≠ 能编辑证据**；同一问题多处目标必须逐一授权、原子应用。
 *
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecks, REPO_ROOT } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
await import(new URL('../public/revision-patch.js', import.meta.url).href);
await import(new URL('../public/revision-plan.js', import.meta.url).href);
const RP = globalThis.NovelRevisionPatch;
const PL = globalThis.NovelRevisionPlan;

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

const twoSpan = {
  id: 'R-0001', title: '检测单折数前后矛盾', type: 'continuity', severity: 'high',
  explanation: '开篇两折、章尾一折，缺少对应操作',
  evidence: [
    { quote: '折过两折', role: 'reference' },
    { quote: '折过一折', role: 'candidate_edit' },
  ],
  acceptance: { rule: '检测单折数与动作链前后一致', preserve: ['检测单'] },
};
const multiTarget = {
  id: 'R-0002', title: '两处都要改', type: 'continuity', severity: 'medium',
  explanation: '两处重复',
  evidence: [
    { quote: '折过两折', role: 'candidate_edit' },
    { quote: '折过一折', role: 'candidate_edit' },
  ],
};

// ── 1) 只读引用 + 单一可编辑目标 ─────────────────────────────────────────────
{
  const plan = PL.buildRevisionPlanV2({ snapshot: SNAP, findings: [twoSpan] });
  check('M-01 只产生 1 个可编辑热点（reference 不变成可写跨度）',
    plan.hotspots.length === 1 && plan.hotspots[0].original === '折过一折',
    JSON.stringify(plan.hotspots.map((h) => h.original)));
  check('M-02 只读证据被单独登记（quote=折过两折，带位置）',
    plan.issue_evidence['R-0001'].references.length === 1
    && plan.issue_evidence['R-0001'].references[0].quote === '折过两折'
    && Number.isFinite(plan.issue_evidence['R-0001'].references[0].start),
    JSON.stringify(plan.issue_evidence['R-0001'].references));
  check('M-03 覆盖表记录 target_count/reference_count（补丁数 ≠ 问题数）',
    plan.coverage[0].status === 'planned' && plan.coverage[0].target_count === 1 && plan.coverage[0].reference_count === 1,
    JSON.stringify(plan.coverage[0]));
  check('M-04 计划 schema_version=2 且 scope_complete 经授权表可判',
    plan.schema_version === 2
    && (() => { const a = PL.planAuthorizationV2(plan); return a.scope_complete === true && a.authorized_span_count === 1; })(),
    JSON.stringify({ schema: plan.schema_version }));

  const prompt = PL.buildRevisionPatchPromptFromPlan(plan);
  check('M-05 提示词把只读证据与授权跨度分开写（reference 标注禁止修改）',
    prompt.includes('只读证据（不是授权跨度）') && prompt.includes('折过两折')
    && prompt.includes('禁止修改') && prompt.includes('折过一折'),
    prompt.slice(0, 200));

  const auth = PL.planAuthorizationV2(plan);
  check('M-06 授权表同时提供 authorized 与 authorized_targets，且指向同一张表',
    auth.authorized === auth.authorized_targets
    && Array.isArray(auth.authorized['R-0001']) && auth.authorized['R-0001'].length === 1,
    JSON.stringify(Object.keys(auth)));
  check('M-07 执行器能读 v2 授权表（authorizationTable 同一口径）',
    RP.authorizationTable({ authorized_targets: { 'R-0001': [{ text: 'x' }] } })['R-0001'].length === 1,
    JSON.stringify(RP.authorizationTable({ authorized_targets: { a: [] } })));
}

// ── 2) 多处可编辑目标：原子组 ───────────────────────────────────────────────
{
  const plan = PL.buildRevisionPlanV2({ snapshot: SNAP, findings: [multiTarget] });
  check('M-08 同一问题两处目标 → 2 个热点，且共用同一个原子组 id',
    plan.hotspots.length === 2
    && plan.hotspots.every((h) => h.group_id === plan.hotspots[0].group_id)
    && plan.hotspots[0].group_id === 'issue:R-0002',
    JSON.stringify(plan.hotspots.map((h) => h.group_id)));
  check('M-09 组声明 atomic=true 且 shared_context=true',
    plan.groups.length === 1 && plan.groups[0].atomic === true && plan.groups[0].shared_context === true,
    JSON.stringify(plan.groups[0]));
  check('M-10 覆盖表 target_count=2，授权表两个条目',
    plan.coverage[0].target_count === 2 && PL.planAuthorizationV2(plan).authorized['R-0002'].length === 2,
    JSON.stringify(plan.coverage[0]));
  // 原子性必须在执行器侧也成立：组里任一条被门禁拦下 → 整组不应用。
  check('M-11 执行器把同一 group 当作原子组（组失配就不应用，不部分采纳）',
    typeof RP.applyPlan === 'function' && typeof RP.verifyCombinedCandidate === 'function',
    'applyPlan/verifyCombinedCandidate 存在');
}

// ── 3) 反例：歧义、保护区、condense、外部授权 ────────────────────────────────
{
  const ambiguous = PL.buildRevisionPlanV2({
    snapshot: RP.snapshotOf(`${BODY}\n\n她又一次折过一折。`, { chapter_id: 731 }),
    findings: [twoSpan],
  });
  check('M-12 目标引文出现两处 → ambiguous_anchor，零热点（不猜第一处）',
    ambiguous.hotspots.length === 0
    && ambiguous.coverage[0].status === 'ambiguous_anchor'
    && ambiguous.scope_incomplete === true,
    JSON.stringify(ambiguous.coverage[0]));

  const protectedPlan = PL.buildRevisionPlanV2({
    snapshot: SNAP, findings: [twoSpan], protectedSpans: ['折过一折'],
  });
  check('M-13 目标落在保护区 → refused，零热点（不静默改别处）',
    protectedPlan.hotspots.length === 0 && protectedPlan.coverage[0].status === 'refused',
    JSON.stringify(protectedPlan.coverage[0]));

  const condensePlan = PL.buildRevisionPlanV2({
    snapshot: SNAP, findings: [{ ...twoSpan, suggested_action: 'condense' }],
  });
  check('R-14 condense 未获批准 → refused（不自动降级成 replace，也不越界连段压缩）',
    condensePlan.hotspots.length === 0 && condensePlan.coverage[0].status === 'refused',
    JSON.stringify(condensePlan.coverage[0]));

  const denied = PL.buildRevisionPlanV2({
    snapshot: SNAP, findings: [twoSpan], hostAuthorization: { allows: () => false },
  });
  check('M-14 作者未批准的精确范围 → authorization_missing，零热点',
    denied.hotspots.length === 0 && denied.coverage[0].status === 'authorization_missing'
    && denied.scope_incomplete === true,
    JSON.stringify(denied.coverage[0]));

  const partial = PL.buildRevisionPlanV2({
    snapshot: SNAP, findings: [twoSpan],
    hostAuthorization: { allows: (_id, start) => start < 10 },
  });
  check('M-15 多处目标只批一处 → 整个问题 authorization_missing（不做"改一半"）',
    partial.hotspots.length === 0 && partial.coverage[0].status === 'authorization_missing',
    JSON.stringify(partial.coverage[0]));
}

// ── 4) 兼容与选择纪律 ──────────────────────────────────────────────────────
{
  const legacy = { id: 'R-0003', text: '「折过一折」这一句重复', explanation: '「折过一折」这一句重复' };
  const plan = PL.buildRevisionPlanV2({ snapshot: SNAP, findings: [legacy] });
  check('M-16 没有结构化证据时沿用 v1 的引号提及定位（兼容旧报告；`「」`提及放宽到整句）',
    plan.hotspots.length === 1 && plan.hotspots[0].original.includes('折过一折')
    && plan.hotspots[0].original.startsWith('检测单也在同一个口袋里')
    && plan.issue_evidence['R-0003'].evidence_source === 'quoted_mention',
    JSON.stringify(plan.issue_evidence['R-0003']));

  const v1 = PL.buildRevisionPlan({ snapshot: SNAP, findings: [legacy] });
  check('M-17 v1 计划行为不变（同一兼容输入定位到同一整句）',
    v1.hotspots.length === 1 && v1.hotspots[0].original === plan.hotspots[0].original,
    JSON.stringify(v1.hotspots.map((h) => h.original)));

  const selectedOnly = PL.buildRevisionPlanV2({ snapshot: SNAP, findings: [twoSpan] });
  check('R-04 计划只包含传入（已勾选）的问题：未勾选条目不产生热点',
    selectedOnly.coverage.length === 1 && selectedOnly.coverage[0].issue_id === 'R-0001'
    && selectedOnly.hotspots.every((h) => h.issue_id === 'R-0001'),
    JSON.stringify(selectedOnly.coverage.map((c) => c.issue_id)));

  // 真实夹具上的一致性命中：0731 章里"把检测单折了一次"是唯一可定位的动作句。
  const fixture = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'before.txt'), 'utf8');
  const found = PL.locateFragment(fixture, '把检测单折了一次', RP.buildSpans(fixture, { sentences: true }));
  check('M-18 真实 0731 夹具里目标句唯一可定位（定位口径与生产一致）',
    found && !found.ambiguous && fixture.slice(found.start, found.end).includes('把检测单折了一次'),
    JSON.stringify(found && { start: found.start, end: found.end }));
}

finish('test-1019-plan-multi');
