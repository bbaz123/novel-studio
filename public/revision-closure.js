/*
 * 修稿质量闭环状态（revision-closure）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么单独一层（v1.2.1 质量闭环方案 §3.4 / §5.1 / §5.6 / §10.2）：
 *   旧界面把"应用了几个补丁"当成"修好了几条问题"。两件事必须分开：
 *     勾选条数 / 准确定位条数 / 应用补丁数 / 门禁通过数 / 语义验收通过数 / 未解决条数。
 *   同时"候选稿（VERIFIED_CANDIDATE）"与"已入库（PERSISTED_VERIFIED）"是两个不同终态：
 *   作者没点合并、或没有一次性写入批准时，只能停在候选态，**不得**说成已定稿。
 *
 * 本模块只算状态，不写任何东西、不调用模型、不接触作者审批凭据。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionClosure = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const VERSION = '1.0.0';

  /** 方案 §5.1 的状态机（含失败分支）。推进只允许沿这里声明的边，禁止跳步。 */
  const STATES = {
    REVIEWED: 'REVIEWED',
    SELECTED: 'SELECTED',
    EVIDENCE_MAPPED: 'EVIDENCE_MAPPED',
    PATCH_PLANNED: 'PATCH_PLANNED',
    CANDIDATE_GENERATED: 'CANDIDATE_GENERATED',
    SAFETY_GATE: 'SAFETY_GATE',
    SEMANTIC_VERIFY: 'SEMANTIC_VERIFY',
    TARGETED_REPAIR: 'TARGETED_REPAIR',
    NEEDS_SCOPE: 'NEEDS_SCOPE',
    GATE_BLOCKED: 'GATE_BLOCKED',
    CANON_CONFLICT: 'CANON_CONFLICT',
    BUDGET_BLOCKED: 'BUDGET_BLOCKED',
    NEEDS_REVIEW: 'NEEDS_REVIEW',
    VERIFIED_CANDIDATE: 'VERIFIED_CANDIDATE',
    AUTHOR_COMMIT_APPROVAL: 'AUTHOR_COMMIT_APPROVAL',
    PERSISTED_VERIFIED: 'PERSISTED_VERIFIED',
  };

  const TRANSITIONS = {
    REVIEWED: ['SELECTED'],
    SELECTED: ['EVIDENCE_MAPPED'],
    EVIDENCE_MAPPED: ['PATCH_PLANNED', 'NEEDS_SCOPE', 'CANON_CONFLICT'],
    PATCH_PLANNED: ['CANDIDATE_GENERATED'],
    CANDIDATE_GENERATED: ['SAFETY_GATE'],
    SAFETY_GATE: ['SEMANTIC_VERIFY', 'GATE_BLOCKED'],
    SEMANTIC_VERIFY: ['VERIFIED_CANDIDATE', 'TARGETED_REPAIR', 'NEEDS_REVIEW', 'BUDGET_BLOCKED'],
    TARGETED_REPAIR: ['SAFETY_GATE', 'BUDGET_BLOCKED', 'NEEDS_REVIEW'],
    VERIFIED_CANDIDATE: ['AUTHOR_COMMIT_APPROVAL'],
    AUTHOR_COMMIT_APPROVAL: ['PERSISTED_VERIFIED'],
  };

  const FINAL_STATUS_LABEL = {
    ISSUE_VERIFIED: '已解决（语义层通过）',
    PARTIAL: '只解决局部',
    UNRESOLVED: '未解决',
    AWAITING_SEMANTIC: '待语义复核（不得当作已解决）',
    CANON_CONFLICT: '蓝图/词条冲突，待作者决定',
    NOT_SELECTED: '未勾选（不算失败）',
  };

  const MAX_SINGLE_CENTS = 200;
  const MAX_TOTAL_CENTS = 200;

  const textOf = (x) => String(x == null ? '' : x);
  const uniqueStrings = (list) => [...new Set((Array.isArray(list) ? list : []).map(textOf).filter(Boolean))];

  function canTransition(from, to) {
    const edges = TRANSITIONS[textOf(from)];
    return Array.isArray(edges) && edges.includes(textOf(to));
  }

  /** 推进状态；不合法就**不动**并返回原因（不做"尽力而为"的跳步）。 */
  function transition(from, to) {
    const f = textOf(from);
    const t = textOf(to);
    if (f === t) return { ok: true, state: t, changed: false };
    if (!TRANSITIONS[f]) return { ok: false, state: f, reason: `未知状态：${f}` };
    if (!canTransition(f, t)) return { ok: false, state: f, reason: `不允许从 ${f} 跳到 ${t}` };
    return { ok: true, state: t, changed: true };
  }

  const SCOPE_STATUS = {
    planned: 'AUTHORIZED',
    needs_scope: 'NEEDS_SCOPE',
    ambiguous_anchor: 'NEEDS_SCOPE',
    authorization_missing: 'NEEDS_SCOPE',
    refused: 'REFUSED',
  };

  /**
   * 逐条问题状态（方案 §10.1）：把"处置/安全/语义/最终"分成四个字段。
   *
   * 绝不从 `patch_status=APPLIED` 推断 `final_status=ISSUE_VERIFIED` —— 后者只来自语义验收器。
   */
  function buildIssueStates(input = {}) {
    const selected = uniqueStrings(input.selectedIssueIds);
    const coverageRows = Array.isArray(input.coverage) ? input.coverage : [];
    const coverageById = new Map(coverageRows.map((c) => [String(c && c.issue_id), c]));
    const applied = Array.isArray(input.applied) ? input.applied : [];
    const verification = input.verification && typeof input.verification === 'object' ? input.verification : null;
    const verifiedById = new Map((Array.isArray(verification && verification.issues) ? verification.issues : [])
      .map((i) => [String(i && i.issue_id), i]));
    const gateBlocked = new Set((Array.isArray(input.blocked) ? input.blocked : [])
      .flatMap((b) => (Array.isArray(b && b.issue_ids) ? b.issue_ids : []).map(String)));
    const safetyAvailable = input.safety_available !== false;
    // 覆盖表状态 → 原因码：每个未完成项都必须落到一个可复核的原因，而不是空字符串。
    const COVERAGE_CODE = {
      needs_scope: 'EVIDENCE_MISSING',
      ambiguous_anchor: 'AMBIGUOUS_ANCHOR',
      authorization_missing: 'AUTHORIZATION_MISSING',
      refused: 'PROTECTED_SPAN',
      blocked: 'GATE_BLOCKED',
      keep: 'MODEL_KEEP',
      deferred: 'MODEL_KEEP',
      unaccounted: 'UNACCOUNTED',
    };

    return selected.map((issueId) => {
      const cov = coverageById.get(issueId) || null;
      const scopeStatus = cov ? (SCOPE_STATUS[cov.status] || 'UNKNOWN') : 'NEEDS_SCOPE';
      const issuePatches = applied.filter((p) => (Array.isArray(p.issue_ids) ? p.issue_ids : []).map(String).includes(issueId));
      let patchStatus = 'NOT_ATTEMPTED';
      if (issuePatches.length) patchStatus = 'APPLIED';
      else if (gateBlocked.has(issueId)) patchStatus = 'BLOCKED';
      else if (cov && ['keep', 'deferred'].includes(cov.status)) patchStatus = 'NO_OP';
      else if (cov && ['blocked', 'refused', 'needs_scope', 'ambiguous_anchor', 'authorization_missing'].includes(cov.status)) patchStatus = 'BLOCKED';
      const safetyStatus = !safetyAvailable ? 'UNAVAILABLE' : (gateBlocked.has(issueId) ? 'FAIL' : (issuePatches.length ? 'PASS' : 'NOT_RUN'));
      const v = verifiedById.get(issueId) || null;
      const semanticStatus = v ? textOf(v.semantic_status) || 'not_run' : 'not_run';
      let finalStatus;
      if (v && v.final_status) finalStatus = textOf(v.final_status);
      else if (patchStatus === 'APPLIED') finalStatus = 'AWAITING_SEMANTIC';
      else if (cov && cov.status === 'refused') finalStatus = 'PARTIAL';
      else finalStatus = 'UNRESOLVED';
      return {
        issue_id: issueId,
        selected: true,
        scope_status: scopeStatus,
        patch_status: patchStatus,
        safety_status: safetyStatus,
        semantic_status: semanticStatus,
        final_status: finalStatus,
        reason_code: (v && v.reason_code) || (cov && COVERAGE_CODE[cov.status]) || '',
        reason: (v && v.reason) || (cov && cov.reason) || '',
        repair_hint: (v && v.repair_hint) || '',
        patch_count: issuePatches.length,
        target_count: cov && Number(cov.target_count) > 0 ? Number(cov.target_count) : 0,
        reference_count: cov && Number(cov.reference_count) > 0 ? Number(cov.reference_count) : 0,
      };
    });
  }

  /**
   * 指标（方案 §3.4）：每个数字都直接从本轮真实产物算，**不接受调用方传"已修好"结论**。
   */
  function closureMetrics(input = {}) {
    const issues = Array.isArray(input.issues) ? input.issues : buildIssueStates(input);
    const applied = Array.isArray(input.applied) ? input.applied : [];
    const coverage = Array.isArray(input.coverage) ? input.coverage : [];
    const metrics = {
      selection_count: issues.length,
      plan_located_count: issues.filter((i) => i.scope_status === 'AUTHORIZED').length,
      scope_missing_count: issues.filter((i) => i.scope_status === 'NEEDS_SCOPE').length,
      refused_count: issues.filter((i) => i.scope_status === 'REFUSED').length,
      target_count: issues.reduce((n, i) => n + i.target_count, 0),
      reference_count: issues.reduce((n, i) => n + i.reference_count, 0),
      patch_applied_count: applied.length,
      issue_patched_count: issues.filter((i) => i.patch_status === 'APPLIED').length,
      gate_passed_count: issues.filter((i) => i.safety_status === 'PASS').length,
      gate_blocked_count: issues.filter((i) => i.safety_status === 'FAIL').length,
      semantic_verified_count: issues.filter((i) => i.final_status === 'ISSUE_VERIFIED').length,
      partial_count: issues.filter((i) => i.final_status === 'PARTIAL').length,
      unresolved_count: issues.filter((i) => !['ISSUE_VERIFIED'].includes(i.final_status) && i.final_status !== 'NOT_SELECTED').length,
      awaiting_semantic_count: issues.filter((i) => i.final_status === 'AWAITING_SEMANTIC').length,
      canon_conflict_count: issues.filter((i) => i.final_status === 'CANON_CONFLICT').length,
      unplanned_count: coverage.filter((c) => c && !['planned', 'patched', 'partially_resolved'].includes(c.status)).length,
    };
    return { metrics, issues };
  }

  /**
   * 整体结论（方案 §10.2）：安全/蓝图没过 → BLOCKED；有未解决 → PARTIAL；
   * 全部语义通过但未入库 → VERIFIED_CANDIDATE；入库且版本一致 → PERSISTED_VERIFIED。
   */
  function closureVerdict(input = {}) {
    const issues = Array.isArray(input.issues) ? input.issues : [];
    const safetyPassed = input.safetyPassed === true;
    const canonPassed = input.canonPassed !== false;
    if (!safetyPassed || !canonPassed) {
      return {
        status: 'BLOCKED',
        reason: !safetyPassed ? '安全门禁未通过或不可用：不得产出"已修好"结论' : '蓝图/词条冲突未解决',
        unresolved_ids: issues.filter((i) => i.final_status !== 'ISSUE_VERIFIED').map((i) => i.issue_id),
      };
    }
    const unresolved = issues.filter((i) => i.final_status !== 'ISSUE_VERIFIED');
    if (unresolved.length) {
      return {
        status: 'PARTIAL',
        reason: `${unresolved.length} 条已选问题尚未通过语义验收：候选稿不是"全部修好"`,
        unresolved_ids: unresolved.map((i) => i.issue_id),
      };
    }
    if (input.persisted !== true) {
      return {
        status: 'VERIFIED_CANDIDATE',
        reason: '所有已选问题都通过语义验收，但作者尚未批准写回：这是候选稿，不是已入库定稿',
        unresolved_ids: [],
      };
    }
    if (input.baseMatches === false) {
      return { status: 'PARTIAL', reason: '写回后版本核对不一致（BASE_STALE）：不能宣称已入库验证', unresolved_ids: issues.map((i) => i.issue_id) };
    }
    return { status: 'PERSISTED_VERIFIED', reason: '已选问题全部通过语义验收，写回成功且保存后版本一致', unresolved_ids: [] };
  }

  /**
   * 质量报告（方案 §5.6）：所有数字来自本轮真实产物。
   * 注意：这里**不写**"修好了 N 条"之外的总结性结论 —— 结论由 closureVerdict 给。
   */
  function closureReport(input = {}) {
    const { metrics, issues } = closureMetrics(input);
    const verdict = input.verdict || closureVerdict({
      issues,
      safetyPassed: input.safetyPassed === true,
      canonPassed: input.canonPassed !== false,
      persisted: input.persisted === true,
      baseMatches: input.baseMatches,
    });
    const statusLabel = {
      BLOCKED: 'BLOCKED（安全/蓝图未通过）',
      PARTIAL: 'PARTIAL_VERIFIED（不宣称全部修好）',
      VERIFIED_CANDIDATE: 'VERIFIED_CANDIDATE（等待作者批准写回）',
      PERSISTED_VERIFIED: 'PERSISTED_VERIFIED（已入库并复核）',
    }[verdict.status] || verdict.status;
    const lines = [
      `审稿确认：${metrics.selection_count} 条`,
      `本次授权：${metrics.plan_located_count + metrics.scope_missing_count + metrics.refused_count} 条（准确定位 ${metrics.plan_located_count}；待补范围 ${metrics.scope_missing_count}；拒绝/保护区 ${metrics.refused_count}）`,
      `生成局部补丁：${metrics.patch_applied_count} 个（覆盖 ${metrics.issue_patched_count} 条问题，${metrics.target_count} 个授权目标）`,
      `安全门禁通过：${metrics.gate_passed_count} 条；拦截：${metrics.gate_blocked_count} 条`,
      `语义验收通过：${metrics.semantic_verified_count} 条；部分处理：${metrics.partial_count} 条；未通过：${metrics.unresolved_count - metrics.awaiting_semantic_count - metrics.partial_count - metrics.canon_conflict_count} 条；待复核：${metrics.awaiting_semantic_count} 条`,
      `蓝图/词条冲突：${metrics.canon_conflict_count} 条`,
      `候选稿状态：${statusLabel}`,
      `正文入库状态：${verdict.status === 'PERSISTED_VERIFIED' ? '已写回并复核' : 'AWAITING_AUTHOR_COMMIT（未入库）'}`,
      `下一步：${nextStepOf(verdict, metrics)}`,
    ];
    return { metrics, issues, verdict, lines, text: lines.join('\n') };
  }

  function nextStepOf(verdict, metrics) {
    if (verdict.status === 'BLOCKED') return '按门禁/蓝图原因修复后重跑；不得绕过安全检查';
    if (verdict.status === 'PARTIAL') {
      if (metrics.scope_missing_count) return '仅针对剩余问题申请精确授权/继续定向复修';
      if (metrics.awaiting_semantic_count) return '对剩余问题运行独立语义复验';
      return '按未解决原因定向复修（只在已授权热点内）';
    }
    if (verdict.status === 'VERIFIED_CANDIDATE') return '等待作者按现有审批流程合并到正文';
    return '无（已完成）';
  }

  /**
   * 二次复修目标（方案 §5.5）：只挑"失败且仍在原授权范围内"的问题。
   * 硬阻塞（底稿变化/蓝图冲突/保护区）**不**放进复修队列 —— 那些需要人处理。
   */
  const HARD_BLOCK = new Set(['BASE_STALE', 'CANON_CONFLICT', 'PROTECTED_SPAN', 'AUTHORIZATION_MISSING', 'LAYER_CONFLICT']);
  function repairTargets(input = {}) {
    const issues = Array.isArray(input.issues) ? input.issues : [];
    const allowed = input.allowedIssueIds == null ? null : new Set(uniqueStrings(input.allowedIssueIds));
    const budget = input.budget && typeof input.budget.remaining === 'number' ? input.budget : null;
    const targets = [];
    const skipped = [];
    for (const i of issues) {
      if (i.final_status === 'ISSUE_VERIFIED') continue;
      if (HARD_BLOCK.has(textOf(i.reason_code))) { skipped.push({ issue_id: i.issue_id, reason_code: i.reason_code, why: '需要人处理（底稿/蓝图/保护区/授权）' }); continue; }
      if (allowed && !allowed.has(i.issue_id)) { skipped.push({ issue_id: i.issue_id, reason_code: 'NEEDS_SCOPE', why: '不在本轮已授权范围' }); continue; }
      if (budget && budget.remaining <= 0) { skipped.push({ issue_id: i.issue_id, reason_code: 'BUDGET_BLOCKED', why: '预算已用尽' }); continue; }
      targets.push({ issue_id: i.issue_id, reason_code: i.reason_code || 'SEMANTIC_FAILED', repair_hint: i.repair_hint || '' });
    }
    return { targets, skipped };
  }

  /**
   * 闭环预算：**整数分**（方案 §10.3 的浮点提醒），单次与累计都不超过 2 元。
   * 费用不可靠确定（unknown=true / 非整数）时拒绝放行 —— "大概不到 2 元"不是授权。
   */
  function createClosureBudget(opts = {}) {
    const limitCents = Number.isInteger(opts.limitCents) && opts.limitCents >= 0 ? opts.limitCents : MAX_TOTAL_CENTS;
    const singleCents = Number.isInteger(opts.singleLimitCents) && opts.singleLimitCents >= 0 ? opts.singleLimitCents : MAX_SINGLE_CENTS;
    const maxRounds = Number.isInteger(opts.maxRounds) && opts.maxRounds > 0 ? opts.maxRounds : 2;
    let totalCents = Number.isInteger(opts.spentCents) && opts.spentCents > 0 ? opts.spentCents : 0;
    let rounds = 0;
    return {
      limitCents,
      singleLimitCents: singleCents,
      maxRounds,
      get totalCents() { return totalCents; },
      get remainingCents() { return Math.max(0, limitCents - totalCents); },
      get remaining() { return this.remainingCents; },
      get roundsUsed() { return rounds; },
      get roundsRemaining() { return Math.max(0, maxRounds - rounds); },
      beginRound() {
        if (rounds >= maxRounds) return { ok: false, reason: 'ROUND_LIMIT', rounds };
        rounds += 1;
        return { ok: true, rounds };
      },
      charge(cents, opts2 = {}) {
        if (opts2.known === false) return { ok: false, reason: 'COST_UNKNOWN' };
        const c = Number(cents);
        if (!Number.isInteger(c) || c < 0) return { ok: false, reason: 'COST_INVALID' };
        if (c > singleCents) return { ok: false, reason: 'SINGLE_LIMIT' };
        if (totalCents + c > limitCents) return { ok: false, reason: 'TOTAL_LIMIT' };
        totalCents += c;
        return { ok: true, totalCents, remainingCents: limitCents - totalCents };
      },
      snapshot() {
        return {
          limitCents, singleLimitCents: singleCents, maxRounds,
          totalCents, remainingCents: Math.max(0, limitCents - totalCents),
          rounds, roundsRemaining: Math.max(0, maxRounds - rounds),
        };
      },
    };
  }

  /** 幂等键：同一 run + 轮次 + 问题 + 底稿只允许一次付费/写回（方案 §10.4）。 */
  function closureIdempotencyKey({ runId, round, issueId, baseHash }) {
    return [textOf(runId), Number.isInteger(Number(round)) ? Number(round) : 0, textOf(issueId), textOf(baseHash)].join('|');
  }

  function createSeenKeys(keys = []) {
    const seen = new Set((Array.isArray(keys) ? keys : []).map(textOf));
    return {
      has: (key) => seen.has(textOf(key)),
      add: (key) => {
        const k = textOf(key);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      },
      size: () => seen.size,
    };
  }

  function isBaseStale({ plannedBaseHash, currentBaseHash } = {}) {
    const a = textOf(plannedBaseHash);
    const b = textOf(currentBaseHash);
    if (!a || !b) return { stale: false, unknown: true, reason: '缺少底稿哈希：不能声称版本一致' };
    if (a === b) return { stale: false };
    return { stale: true, reason: '底稿已变化：旧授权/旧候选不得复用（BASE_STALE）' };
  }

  return {
    VERSION,
    STATES,
    TRANSITIONS,
    FINAL_STATUS_LABEL,
    MAX_SINGLE_CENTS,
    MAX_TOTAL_CENTS,
    canTransition,
    transition,
    buildIssueStates,
    closureMetrics,
    closureVerdict,
    closureReport,
    repairTargets,
    createClosureBudget,
    closureIdempotencyKey,
    createSeenKeys,
    isBaseStale,
  };
});
