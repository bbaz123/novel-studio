#!/usr/bin/env node
/**
 * .p1-baseline/test-1019-closure.mjs —— v1.2.1 质量闭环 P0-7：状态机、指标口径、预算与报告。
 *
 * 覆盖方案 §12：R-19 / R-20 / R-21 / R-23 / R-28 / R-29 与 §3.4 的指标分离。
 * 核心契约：补丁数 ≠ 修复数；候选稿 ≠ 已入库；未知费用不放行；预算用整数分。
 *
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
await import(new URL('../public/revision-closure.js', import.meta.url).href);
const CL = globalThis.NovelRevisionClosure;

const verified = (id) => ({ issue_id: id, verdict: 'pass', final_status: 'ISSUE_VERIFIED', semantic_status: 'pass', reason_code: 'ISSUE_VERIFIED', reason: '语义通过' });
const awaiting = (id) => ({ issue_id: id, verdict: 'need_context', final_status: 'AWAITING_SEMANTIC', semantic_status: 'not_run', reason_code: 'SEMANTIC_NOT_RUN', reason: '语义未运行' });
const failed = (id, code = 'SEMANTIC_FAILED') => ({ issue_id: id, verdict: 'fail', final_status: 'UNRESOLVED', semantic_status: 'fail', reason_code: code, reason: '未通过', repair_hint: '只在已授权热点内重写' });

// ── 指标分离（§3.4）────────────────────────────────────────────────────────
{
  const input = {
    selectedIssueIds: ['R-1', 'R-2', 'R-3'],
    coverage: [
      { issue_id: 'R-1', status: 'planned', target_count: 2, reference_count: 1 },
      { issue_id: 'R-2', status: 'planned', target_count: 1, reference_count: 0 },
      { issue_id: 'R-3', status: 'needs_scope' },
    ],
    applied: [
      { issue_ids: ['R-1'], original: 'a', start: 0, end: 1, op: 'replace' },
      { issue_ids: ['R-1'], original: 'b', start: 5, end: 6, op: 'replace' },
      { issue_ids: ['R-2'], original: 'c', start: 9, end: 10, op: 'replace' },
      { issue_ids: ['R-2'], original: 'd', start: 12, end: 13, op: 'delete' },
    ],
    verification: { issues: [verified('R-1'), awaiting('R-2')] },
    safety_available: true,
  };
  const { metrics, issues } = CL.closureMetrics(input);
  check('K-01 勾选/定位/补丁/门禁/语义五个数字严格分开',
    metrics.selection_count === 3 && metrics.plan_located_count === 2 && metrics.scope_missing_count === 1
    && metrics.patch_applied_count === 4 && metrics.issue_patched_count === 2
    && metrics.gate_passed_count === 2 && metrics.semantic_verified_count === 1,
    JSON.stringify(metrics));
  check('K-02 同一问题多处补丁不会被算成"多条已修好"（patch_applied=4 > verified=1）',
    metrics.patch_applied_count === 4 && metrics.semantic_verified_count === 1);
  check('K-03 补丁已应用但语义未运行 → final=AWAITING_SEMANTIC（不是 ISSUE_VERIFIED）',
    issues.find((i) => i.issue_id === 'R-2').final_status === 'AWAITING_SEMANTIC'
    && issues.find((i) => i.issue_id === 'R-2').patch_status === 'APPLIED',
    JSON.stringify(issues.find((i) => i.issue_id === 'R-2')));
  check('K-04 未定位条目 scope_status=NEEDS_SCOPE / patch_status=BLOCKED',
    issues.find((i) => i.issue_id === 'R-3').scope_status === 'NEEDS_SCOPE'
    && issues.find((i) => i.issue_id === 'R-3').patch_status === 'BLOCKED',
    JSON.stringify(issues.find((i) => i.issue_id === 'R-3')));
  check('K-05 unresolved_count 包含待语义复核项（不会因为"有补丁"就消失）',
    metrics.unresolved_count === 2 && metrics.awaiting_semantic_count === 1,
    JSON.stringify({ unresolved: metrics.unresolved_count }));
}

// ── R-19：新一轮不得继承历史 PASS ──────────────────────────────────────────
{
  // 第二轮不注入任何语义结果：即便上一轮这条已通过，本轮也必须重新待复核。
  const round2 = CL.closureMetrics({
    selectedIssueIds: ['R-1'],
    coverage: [{ issue_id: 'R-1', status: 'planned', target_count: 1 }],
    applied: [{ issue_ids: ['R-1'], original: 'x', start: 0, end: 1, op: 'replace' }],
    verification: null,
    previousVerifiedIds: ['R-1'],
  });
  check('R-19 新一轮（无本次语义结果）→ 该条转 AWAITING_SEMANTIC，不保留历史 PASS',
    round2.issues[0].final_status === 'AWAITING_SEMANTIC' && round2.metrics.semantic_verified_count === 0,
    JSON.stringify(round2.issues[0]));
}

// ── R-20：预算（整数分、单笔/累计、未知费用）───────────────────────────────
{
  const b = CL.createClosureBudget({ limitCents: 200, singleLimitCents: 200, maxRounds: 2 });
  check('R-20a 单笔 200 分可放行（上限 2 元）', b.charge(120).ok === true && b.charge(80).ok === true,
    JSON.stringify(b.snapshot()));
  check('R-20b 累计超额 → TOTAL_LIMIT（不拆单绕限）', b.charge(1).ok === false && b.charge(1).reason === 'TOTAL_LIMIT');
  check('R-20c 单笔超过 200 分 → SINGLE_LIMIT',
    CL.createClosureBudget().charge(201).reason === 'SINGLE_LIMIT');
  check('R-20d 未知费用 → COST_UNKNOWN（"大概不到 2 元"不是授权）',
    CL.createClosureBudget().charge(10, { known: false }).reason === 'COST_UNKNOWN'
    && CL.createClosureBudget().charge(1.5).reason === 'COST_INVALID');
  const rounds = CL.createClosureBudget({ maxRounds: 2 });
  rounds.beginRound(); rounds.beginRound();
  check('R-20e 轮次上限：第 3 轮 BEGIN 被拒（不无限复修）',
    rounds.beginRound().ok === false && rounds.beginRound().reason === 'ROUND_LIMIT',
    JSON.stringify(rounds.snapshot()));
}

// ── R-21 / R-28：候选稿 vs 已入库 ──────────────────────────────────────────
{
  const issues = [
    { issue_id: 'R-1', final_status: 'ISSUE_VERIFIED' },
    { issue_id: 'R-2', final_status: 'ISSUE_VERIFIED' },
  ];
  const candidate = CL.closureVerdict({ issues, safetyPassed: true, canonPassed: true, persisted: false });
  check('R-21 作者未批准写回 → VERIFIED_CANDIDATE（不是 PERSISTED_VERIFIED）',
    candidate.status === 'VERIFIED_CANDIDATE' && /候选稿/.test(candidate.reason),
    JSON.stringify(candidate));
  const persisted = CL.closureVerdict({ issues, safetyPassed: true, canonPassed: true, persisted: true, baseMatches: true });
  check('R-28 全部通过 + 写回成功 + 保存后版本一致 → PERSISTED_VERIFIED',
    persisted.status === 'PERSISTED_VERIFIED', JSON.stringify(persisted));
  const staleAfterSave = CL.closureVerdict({ issues, safetyPassed: true, canonPassed: true, persisted: true, baseMatches: false });
  check('R-28b 写回后版本不一致 → 不得宣称已入库验证',
    staleAfterSave.status === 'PARTIAL' && /BASE_STALE|不一致/.test(staleAfterSave.reason),
    JSON.stringify(staleAfterSave));
}

// ── R-29：全部被拦/未定位 → BLOCKED/PARTIAL，不是成功 ──────────────────────
{
  const blocked = CL.closureVerdict({
    issues: [{ issue_id: 'R-1', final_status: 'UNRESOLVED' }],
    safetyPassed: false, canonPassed: true, persisted: false,
  });
  check('R-29a 安全门禁不可用 → BLOCKED（不是"无修改"）',
    blocked.status === 'BLOCKED' && /安全/.test(blocked.reason), JSON.stringify(blocked));
  const partial = CL.closureVerdict({
    issues: [
      { issue_id: 'R-1', final_status: 'ISSUE_VERIFIED' },
      { issue_id: 'R-2', final_status: 'UNRESOLVED' },
    ],
    safetyPassed: true, canonPassed: true, persisted: false,
  });
  check('R-29b 部分未解决 → PARTIAL 并列出未解决 ID',
    partial.status === 'PARTIAL' && partial.unresolved_ids.includes('R-2'),
    JSON.stringify(partial.unresolved_ids));
}

// ── 报告文案：数字来自真实产物 ─────────────────────────────────────────────
{
  const report = CL.closureReport({
    selectedIssueIds: ['R-1', 'R-2'],
    coverage: [{ issue_id: 'R-1', status: 'planned', target_count: 1 }, { issue_id: 'R-2', status: 'refused' }],
    applied: [{ issue_ids: ['R-1'], original: 'x', start: 0, end: 1, op: 'replace' }],
    verification: { issues: [verified('R-1')] },
    safetyPassed: true, persisted: false,
  });
  check('K-06 报告写明"候选稿 / 未入库"，不出现"已全部修好并存盘"',
    /候选稿/.test(report.text) && /AWAITING_AUTHOR_COMMIT/.test(report.text)
    && !/已全部修好/.test(report.text) && !/已入库并复核/.test(report.text),
    report.text);
  check('K-07 报告数字随真实计数变化（不是静态样例）',
    report.text.includes('本次授权：2 条') && report.text.includes('语义验收通过：1 条')
    && report.text.includes('拒绝/保护区 1'),
    report.text.split('\n').slice(0, 5).join(' | '));
  check('K-08 下一步给出可执行动作（授权/复验/定向复修/合并），不是"继续优化"',
    /申请精确授权|运行独立语义复验|合并到正文|定向复修/.test(report.text),
    report.lines[report.lines.length - 1]);
  check('K-09 closureReport 的结论与 closureVerdict 同一判据',
    report.verdict.status === 'PARTIAL', report.verdict.status);
}

// ── R-23：幂等键 / 重放保护 ────────────────────────────────────────────────
{
  const key = CL.closureIdempotencyKey({ runId: 'run-1', round: 2, issueId: 'R-1', baseHash: 'h1' });
  check('R-23a 幂等键包含 run/round/issue/base（同键不重复付费）',
    key === 'run-1|2|R-1|h1', key);
  const seen = CL.createSeenKeys([key]);
  check('R-23b 重放同一键 → 第二次被拒（不重复写回/扣费）',
    seen.add(key) === false && seen.add('run-1|3|R-1|h1') === true, JSON.stringify(seen.size()));
  const stale = CL.isBaseStale({ plannedBaseHash: 'h1', currentBaseHash: 'h2' });
  check('R-23c 底稿变化 → BASE_STALE；缺哈希时不得声称版本一致',
    stale.stale === true && /BASE_STALE/.test(stale.reason)
    && CL.isBaseStale({}).stale === false && CL.isBaseStale({}).unknown === true,
    JSON.stringify(stale));
}

// ── 定向复修队列 ───────────────────────────────────────────────────────────
{
  const issues = [
    { issue_id: 'R-1', final_status: 'UNRESOLVED', reason_code: 'SEMANTIC_FAILED', repair_hint: 'hint' },
    { issue_id: 'R-2', final_status: 'CANON_CONFLICT', reason_code: 'CANON_CONFLICT' },
    { issue_id: 'R-3', final_status: 'UNRESOLVED', reason_code: 'SEMANTIC_FAILED' },
    { issue_id: 'R-4', final_status: 'ISSUE_VERIFIED', reason_code: 'ISSUE_VERIFIED' },
  ];
  const { targets, skipped } = CL.repairTargets({ issues, allowedIssueIds: ['R-1', 'R-2'] });
  check('P-01 只把"失败且仍在原授权范围"的问题放进二次复修',
    targets.length === 1 && targets[0].issue_id === 'R-1',
    JSON.stringify(targets.map((t) => t.issue_id)));
  check('P-02 蓝图冲突/授权外的问题不进自动复修队列',
    skipped.some((s) => s.issue_id === 'R-2' && s.reason_code === 'CANON_CONFLICT')
    && skipped.some((s) => s.issue_id === 'R-3'),
    JSON.stringify(skipped));
  const noBudget = CL.repairTargets({ issues, budget: CL.createClosureBudget({ limitCents: 0 }) });
  check('P-03 预算用尽 → 复修队列为空（不擅自继续付费）',
    noBudget.targets.length === 0 && noBudget.skipped.some((s) => s.reason_code === 'BUDGET_BLOCKED'),
    JSON.stringify(noBudget.skipped));
}

// ── 状态机：不跳步 ────────────────────────────────────────────────────────
{
  check('S-01 合法推进：REVIEWED → SELECTED → EVIDENCE_MAPPED',
    CL.transition('REVIEWED', 'SELECTED').ok && CL.transition('SELECTED', 'EVIDENCE_MAPPED').ok);
  check('S-02 非法跳步被拒：REVIEWED → PERSISTED_VERIFIED',
    CL.transition('REVIEWED', 'PERSISTED_VERIFIED').ok === false
    && /不允许/.test(CL.transition('REVIEWED', 'PERSISTED_VERIFIED').reason),
    JSON.stringify(CL.transition('REVIEWED', 'PERSISTED_VERIFIED')));
  check('S-03 复修回路存在：TARGETED_REPAIR → SAFETY_GATE',
    CL.transition('TARGETED_REPAIR', 'SAFETY_GATE').ok === true);
  check('S-04 候选稿不能直接跳到已入库（必须先经过作者批准节点）',
    CL.transition('VERIFIED_CANDIDATE', 'PERSISTED_VERIFIED').ok === false
    && CL.transition('VERIFIED_CANDIDATE', 'AUTHOR_COMMIT_APPROVAL').ok === true);
}

// ── v1.2.2 自动二次复修：成本上界 + 规划器 ─────────────────────────────────
{
  const est = CL.estimateRevisionCostCents({ promptChars: 20000, maxOutputTokens: 2048 });
  check('A-01 成本按"字符=token 上界 + 输出上限"保守估算（20000 字 + 2048 输出 → 8 分）',
    est === 8, String(est));
  check('A-02 无法定价（缺 prompt/输出上限）→ null，绝不返回 0 冒充免费',
    CL.estimateRevisionCostCents({}) === null
    && CL.estimateRevisionCostCents({ promptChars: 100, maxOutputTokens: 0 }) === null);

  const issues = [
    { issue_id: 'R-1', final_status: 'UNRESOLVED', verdict: 'fail', reason_code: 'SEMANTIC_FAILED' },
    { issue_id: 'R-2', final_status: 'UNRESOLVED', verdict: 'fail', reason_code: 'CANON_CONFLICT' },
    { issue_id: 'R-3', final_status: 'ISSUE_VERIFIED', verdict: 'pass', reason_code: 'ISSUE_VERIFIED' },
    { issue_id: 'R-4', final_status: 'AWAITING_SEMANTIC', verdict: 'need_context', reason_code: 'SEMANTIC_NOT_RUN' },
  ];
  const plan1 = CL.planAutoRepair({ issues, round: 0, estimateCents: 8, budgetCents: 200, allowedIssueIds: ['R-1', 'R-2'] });
  check('A-03 只选 fail 且在原授权集合内、且非硬阻塞的条目（R-1）',
    plan1.ok === true && plan1.issue_ids.join(',') === 'R-1' && plan1.round === 1,
    JSON.stringify(plan1));
  check('A-04 蓝图冲突（CANON_CONFLICT）不自动复修',
    CL.planAutoRepair({ issues, round: 0, estimateCents: 8, budgetCents: 200 }).issue_ids.join(',') === 'R-1');
  check('A-05 轮次上限：第 3 轮拒绝（maxRounds=2）',
    CL.planAutoRepair({ issues, round: 2, estimateCents: 8, budgetCents: 200 }).reason === 'ROUND_LIMIT');
  check('A-06 费用无法核价 → COST_UNKNOWN（不自动付费）',
    CL.planAutoRepair({ issues, round: 0, estimateCents: null, budgetCents: 200 }).reason === 'COST_UNKNOWN');
  check('A-07 上界超预算 → BUDGET_EXCEEDED（不拆轮绕限）',
    CL.planAutoRepair({ issues, round: 0, estimateCents: 300, budgetCents: 200 }).reason === 'BUDGET_EXCEEDED');
  check('A-08 没有失败条目 → NO_TARGETS（不空跑付费调用）',
    CL.planAutoRepair({ issues: [issues[2], issues[3]], round: 0, estimateCents: 8 }).reason === 'NO_TARGETS');
  check('A-09 不在原授权集合内的失败条目不自动修（需要作者补授权）',
    CL.planAutoRepair({ issues, round: 0, estimateCents: 8, budgetCents: 200, allowedIssueIds: ['R-9'] }).reason === 'NO_TARGETS');
}

finish('test-1019-closure');
