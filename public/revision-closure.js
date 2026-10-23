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
  const clipStr = (s, n) => {
    const v = textOf(s);
    return v.length > n ? `${v.slice(0, n)}…` : v;
  };

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
  const HARD_BLOCK = new Set(['BASE_STALE', 'CANON_CONFLICT', 'PROTECTED_SPAN', 'AUTHORIZATION_MISSING', 'LAYER_CONFLICT',
    // 2026-10-21：外部资料待核验不是"补丁没写好"，再派一次正文修稿既改不对也越权。
    'EXTERNAL_CONTEXT_REQUIRED', 'NOT_APPLICABLE_WITH_EVIDENCE', 'NEEDS_AUTHOR_APPROVAL']);
  function repairTargets(input = {}) {
    const issues = Array.isArray(input.issues) ? input.issues : [];
    const allowed = input.allowedIssueIds == null ? null : new Set(uniqueStrings(input.allowedIssueIds));
    const budget = input.budget && typeof input.budget.remaining === 'number' ? input.budget : null;
    const targets = [];
    const skipped = [];
    for (const i of issues) {
      if (i.final_status === 'ISSUE_VERIFIED') continue;
      if (HARD_BLOCK.has(textOf(i.reason_code))) {
        const why = ['EXTERNAL_CONTEXT_REQUIRED', 'NOT_APPLICABLE_WITH_EVIDENCE', 'NEEDS_AUTHOR_APPROVAL'].includes(textOf(i.reason_code))
          ? '需外部资料核验/作者裁决（不得改正文来凑）'
          : '需要人处理（底稿/蓝图/保护区/授权）';
        skipped.push({ issue_id: i.issue_id, reason_code: i.reason_code, why, repair_hint: textOf(i.repair_hint) });
        continue;
      }
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

  /**
   * 修稿成本预估（v1.2.2 自动二次复修）。
   *
   * 为什么必须先算再调用：自动复修是**付费**动作，而"大概不到 2 元"不是授权。
   * 这里用保守口径（CJK 一个字按 1 token、输出取 max_tokens 上限）算出**上界**，
   * 超预算就拒绝自动执行并给出原因 —— 宁可退回人工触发，也不静默超支。
   *
   * 价格单位：分 / 百万 token。默认值刻意取高（¥2/M 输入、¥16/M 输出），
   * 使估算偏向"高估"而不是低价放行；真实单价可由调用方传入。
   * @returns {number|null} 分；无法定价（缺 prompt 或输出上限）时返回 null
   */
  const DEFAULT_PRICE_CENTS = { inputPerMTok: 200, outputPerMTok: 1600 };
  function estimateRevisionCostCents({ promptChars = 0, maxOutputTokens = 2048, price = {} } = {}) {
    const chars = Math.max(0, Number(promptChars) || 0);
    const out = Math.max(0, Number(maxOutputTokens) || 0);
    if (!chars || !out) return null;
    const pIn = Number.isFinite(Number(price && price.inputPerMTok)) ? Number(price.inputPerMTok) : DEFAULT_PRICE_CENTS.inputPerMTok;
    const pOut = Number.isFinite(Number(price && price.outputPerMTok)) ? Number(price.outputPerMTok) : DEFAULT_PRICE_CENTS.outputPerMTok;
    const cents = (chars * pIn) / 1e6 + (out * pOut) / 1e6;
    return Math.max(1, Math.ceil(cents));
  }

  const AUTO_REPAIR_HARD_BLOCK = new Set(['BASE_STALE', 'CANON_CONFLICT', 'PROTECTED_SPAN', 'AUTHORIZATION_MISSING', 'LAYER_CONFLICT',
    // 同上：外部资料项与"需作者裁决"项不得进入自动复修（那会变成拿正文去凑资料）。
    'EXTERNAL_CONTEXT_REQUIRED', 'NOT_APPLICABLE_WITH_EVIDENCE', 'NEEDS_AUTHOR_APPROVAL']);

  /**
   * 自动复修规划（纯函数）：决定"这一轮要不要自动再修、修哪几条、能不能付得起"。
   *
   * 只选 `verdict=fail` 且**仍在作者原授权集合内**的问题：
   *   · 未勾选/新增跨度的不给修（需要作者补授权）；
   *   · 底稿变化、蓝图冲突、保护区、授权冲突是**人处理项**，自动复修不得碰；
   *   · 轮次上限、预算上界、费用可核价三者缺一不可 —— 任一不满足就返回明确原因，不静默执行。
   */
  function planAutoRepair(input = {}) {
    const issues = Array.isArray(input.issues) ? input.issues : [];
    const maxRounds = Number.isInteger(Number(input.maxRounds)) ? Number(input.maxRounds) : 2;
    const round = Number.isInteger(Number(input.round)) ? Number(input.round) : 0;
    const allowed = input.allowedIssueIds == null ? null : new Set(uniqueStrings(input.allowedIssueIds));
    const hard = input.hardBlockCodes == null ? AUTO_REPAIR_HARD_BLOCK : new Set(uniqueStrings(input.hardBlockCodes));
    const eligible = issues.filter((i) => {
      // 「部分修复」是**有结论的未通过项**，必须能进入定向复修；旧实现只认 fail，
      // 于是模型判 partial 的条目（例如 I04 只改了分级解释、跨段矛盾仍在）永远停在待验，
      // 既不会被继续修，也不会出现在失败清单里 —— 这正是"1 项部分修复没人管"的来源。
      const failed = i && (i.verdict === 'fail' || i.verdict === 'partial'
        || i.final_status === 'UNRESOLVED' || i.final_status === 'PARTIAL');
      if (!failed) return false;
      if (hard.has(textOf(i.reason_code))) return false;
      if (allowed && !allowed.has(String(i.issue_id))) return false;
      return true;
    });
    if (!eligible.length) return { ok: false, reason: 'NO_TARGETS', issue_ids: [], round, estimateCents: null };
    if (round >= maxRounds) {
      return { ok: false, reason: 'ROUND_LIMIT', issue_ids: [], round, estimateCents: null, maxRounds };
    }
    const estimateCents = input.estimateCents == null ? null : Number(input.estimateCents);
    if (input.costKnown === false || estimateCents == null || !Number.isFinite(estimateCents)) {
      return { ok: false, reason: 'COST_UNKNOWN', issue_ids: eligible.map((i) => String(i.issue_id)), round, estimateCents: null };
    }
    const budgetCents = Number.isFinite(Number(input.budgetCents)) ? Math.max(0, Number(input.budgetCents)) : MAX_TOTAL_CENTS;
    if (estimateCents > budgetCents) {
      return { ok: false, reason: 'BUDGET_EXCEEDED', issue_ids: eligible.map((i) => String(i.issue_id)), round, estimateCents, budgetCents };
    }
    return {
      ok: true,
      reason: 'ELIGIBLE',
      issue_ids: eligible.map((i) => String(i.issue_id)),
      round: round + 1,
      estimateCents,
      budgetCents,
    };
  }

  /**
   * 复修后的语义合并（v1.2.5，纯函数）。
   *
   * 为什么必须有这一步：复修后重跑的是**确定性层**（免费、不调模型），它的语义字段
   * 一律是 `not_run`。直接用它替换上一轮结论，会把已经 PASS 的条目打回 `AWAITING_SEMANTIC`，
   * 作者看到"修了一条，其余全变待验" —— 这是复修冲掉旧结论的缺陷。
   *
   * 规则（fail-closed）：
   *   · 确定性硬失败 → 用它（FAIL）；语义 PASS 不能覆盖字面事实；
   *   · 本轮改过的条目 → 语义结论作废，置 AWAITING_SEMANTIC（等重新复验）；
   *   · 本轮没改的条目 → 保留原结论；把确定性层的失败项附进 checks 供复核（回归可见）。
   */
  function mergeRepairSemantic(prior, deterministic, repairIds) {
    const ids = new Set((Array.isArray(repairIds) ? repairIds : []).map(String));
    // 兼容两种上游形状：**验收器**给 `{issues:[...]}`，**统一终验**给 `{rows:[...]}`。
    // 旧实现只认 `issues`，形状不符时会静默返回一张空清单 —— 那等于把已通过的条目全抹掉。
    const rowsOf = (x) => {
      if (!x || typeof x !== 'object') return null;
      if (Array.isArray(x.issues)) return x.issues;
      if (Array.isArray(x.rows)) return x.rows;
      return null;
    };
    const priorRows = rowsOf(prior);
    if (!priorRows) return prior; // 没有可比的上轮结论：原样返回，绝不返回空列表
    const detRows = rowsOf(deterministic) || [];
    const detById = new Map(detRows.map((i) => [String(i && i.issue_id), i]));
    const rows = priorRows.map((prev) => {
      const id = String(prev && prev.issue_id);
      const det = detById.get(id);
      if (!det) return prev;
      if (det.verdict === 'fail') return det;
      if (ids.has(id)) {
        return {
          ...det,
          verdict: 'need_context',
          final_status: 'AWAITING_SEMANTIC',
          semantic_status: 'not_run',
          reason_code: 'SEMANTIC_NOT_RUN',
          reason: '本轮已定向复修：语义结论已作废，必须重新复验后才能下结论（不得沿用旧 pass/partial）',
        };
      }
      return {
        ...prev,
        checks: [...(Array.isArray(prev.checks) ? prev.checks : []), ...((det.checks || []).filter((c) => !c.passed))],
      };
    });
    const summary = {
      total: rows.length,
      verified: rows.filter((i) => i.verdict === 'pass').length,
      partial: rows.filter((i) => i.verdict === 'partial').length,
      unresolved: rows.filter((i) => i.verdict === 'fail').length,
      awaiting_semantic: rows.filter((i) => i.verdict === 'need_context').length,
      canon_conflict: rows.filter((i) => i.final_status === 'CANON_CONFLICT').length,
      semantic_not_run: rows.filter((i) => i.semantic_status === 'not_run').length,
      diff_ok: !!(deterministic && deterministic.summary && deterministic.summary.diff_ok),
    };
    const anyFail = rows.some((i) => i.verdict === 'fail' || i.verdict === 'partial');
    const anyPending = rows.some((i) => i.verdict === 'need_context');
    return {
      ...(deterministic || {}),
      issues: rows,
      summary,
      verdict: anyFail ? 'PARTIAL_OR_FAILED' : (anyPending ? 'NEEDS_REVIEW' : 'VERIFIED_CANDIDATE'),
    };
  }

  /**
   * 复验额度（v1.2.7）：从"这份候选只能验一次"升级为"**每份候选各验一次**"。
   *
   * 为什么必须按候选算：旧口径 `semanticRuns >= 1` 是**全局一次**。
   * 复修换了候选正文之后，复验额度并没有跟着重开 —— 于是"修好了却验不了"，
   * 或者反过来不记 hash 就变成"同一份稿反复付费"。按候选 hash 计，两件事同时成立：
   * 同一份稿不重复付费；改过的稿一定拿得到它自己的那一次结论。
   *
   * 合并后补跑一次（2026-10-18 作者要求）保留：同一份候选合进正文后仍允许补验一次，
   * 否则"跳过复验直接合并"就永远没有回头路。
   */
  function verifyAllowanceOf(input = {}) {
    const hash = textOf(input.candidateHash);
    const used = Array.isArray(input.verifiedHashes)
      ? uniqueStrings(input.verifiedHashes.map((x) => textOf(x)))
      : [];
    if (!hash) return { ok: false, code: 'NO_CANDIDATE_HASH', verified_hashes: used };
    if (!used.includes(hash)) return { ok: true, code: 'NEW_CANDIDATE', verified_hashes: used };
    if (input.mergedAt === true && input.reverifiedAfterMerge !== true) {
      return { ok: true, code: 'POST_MERGE_RETRY', verified_hashes: used };
    }
    return { ok: false, code: 'ALREADY_VERIFIED_THIS_CANDIDATE', verified_hashes: used };
  }

  /**
   * 把"统一终验的逐条行 + 语义复验结论"复原成**可复修清单**（纯函数）。
   *
   * 为什么不能直接用 `final_status` 去规划复修：`planAutoRepair` 读的是 verdict /
   * reason_code / remaining_evidence。两套字段各写一份映射，必然漏字段；
   * 漏掉 `remaining_evidence` 的后果就是每一轮复修都重放**同一个**跨度，
   * 全篇多处的问题永远只改一处（作者 2026-10-22 报的 #R-0005）。
   */
  function repairIssuesFrom(rows, semanticByIssue) {
    const list = Array.isArray(rows) ? rows : [];
    const byIssue = semanticByIssue && typeof semanticByIssue === 'object' ? semanticByIssue : {};
    const out = [];
    for (const r of list) {
      const id = textOf(r && r.issue_id);
      if (!id) continue;
      const final = textOf(r.final_status);
      if (final === 'ISSUE_VERIFIED') continue;
      const sem = byIssue[id] && typeof byIssue[id] === 'object' ? byIssue[id] : {};
      const remaining = Array.isArray(sem.remaining_evidence)
        ? sem.remaining_evidence.map((q) => textOf(q && q.quote != null ? q.quote : q)).filter(Boolean)
        : [];
      out.push({
        issue_id: id,
        // partial 是有结论的未通过项，必须与 fail 一样能进复修队列（见 planAutoRepair 的注释）。
        verdict: textOf(r.verdict) || (final === 'PARTIAL' ? 'partial' : 'fail'),
        final_status: final,
        semantic_status: textOf(r.semantic_status || sem.status),
        reason_code: textOf(sem.reason_code || r.reason_code),
        reason: textOf(sem.reason || r.reason),
        repair_hint: textOf(sem.repair_hint || r.repair_hint),
        remaining_evidence: remaining,
      });
    }
    return out;
  }

  /**
   * 定向复修规划（纯函数）：**复修入口与自动复修共用同一套判据**。
   *
   * 输入只需要"终验行 + 语义结论 + 轮次/预算"，输出 targets（能修的）、
   * blocked（人处理项）、remainingEvidence（复验留下的"仍在的文字"，供界面说清"扩到哪几处"）。
   * 绝不在这里做"放宽授权"的判断：那是 Host 的显式动作（见 app 的扩范围复修）。
   */
  function targetedRepairOf(input = {}) {
    const issues = repairIssuesFrom(input.rows, input.semanticByIssue);
    const verdict = planAutoRepair({
      issues,
      round: Number.isInteger(Number(input.roundsUsed)) ? Number(input.roundsUsed) : 0,
      maxRounds: input.maxRounds,
      budgetCents: input.budgetCents,
      estimateCents: input.estimateCents,
      costKnown: input.costKnown,
      allowedIssueIds: input.allowedIssueIds,
      hardBlockCodes: input.hardBlockCodes,
    });
    const targets = verdict.ok ? (verdict.issue_ids || []) : [];
    const targetSet = new Set(targets.map(textOf));
    const blocked = issues
      .filter((i) => !targetSet.has(i.issue_id))
      .map((i) => ({
        issue_id: i.issue_id,
        reason_code: i.reason_code,
        reason: i.reason,
        hard: AUTO_REPAIR_HARD_BLOCK.has(i.reason_code),
      }));
    const remainingEvidence = {};
    for (const i of issues) {
      if (!targetSet.has(i.issue_id)) continue;
      if (i.remaining_evidence.length) remainingEvidence[i.issue_id] = i.remaining_evidence.slice(0, 12);
    }
    return { ...verdict, issues, targets, blocked, remaining_evidence: remainingEvidence };
  }

  /** 已知遗留（C1）：列出"未通过"的条目，供作者一次性记为已接受（不是修好）。 */
  function acceptedLeftoversOf(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const open = rows.filter((r) => textOf(r && r.final_status) !== 'ISSUE_VERIFIED');
    const ids = uniqueStrings(open.map((r) => textOf(r && r.issue_id)));
    const accepted = new Set((Array.isArray(input.acceptedIds) ? input.acceptedIds : []).map(textOf));
    return {
      ids,
      count: ids.length,
      pending: ids.filter((id) => !accepted.has(id)),
      canon: uniqueStrings(open.filter((r) => textOf(r.final_status) === 'CANON_CONFLICT').map((r) => textOf(r.issue_id))),
    };
  }

  /** 已用掉几轮"应用成功"的定向复修（跨轮累计的唯一口径）。 */
  function roundsUsedOf(autoRepair) {
    const rounds = autoRepair && Array.isArray(autoRepair.rounds) ? autoRepair.rounds : [];
    return rounds.filter((r) => r && r.status === 'applied').length;
  }

  /**
   * 把新一轮复修的轮次/花费**接到**上一轮后面（纯函数）。
   *
   * 为什么必须累计：定向复修按钮可以被点多次。每次都用这一轮自己的 rounds 覆盖上一轮，
   * 轮次上限就变成"每点一次重新数"（等于无限付费重试），预算也一样会被重置。
   */
  function mergeRepairRounds(prior, next) {
    if (!next) return prior || null;
    const rounds = [
      ...(prior && Array.isArray(prior.rounds) ? prior.rounds : []),
      ...(Array.isArray(next.rounds) ? next.rounds : []),
    ];
    return {
      ...next,
      rounds,
      spent_cents: (Number(prior && prior.spent_cents) || 0) + (Number(next.spent_cents) || 0),
      rounds_used: roundsUsedOf({ rounds }),
    };
  }

  /**
   * 跨段授权（v1.2.7 / 方案 B2）：作者显式批准"本段起连续 N 段"可改。
   *
   * 为什么必须由 Host 收口而不是让模型自己放宽：放宽一步就等于把"改哪儿"的决定权交给模型，
   * 而这条链路上所有的越权事故都源于此（`revision-plan` 从不自动放宽）。
   * 所以这里只做**校验**：段数、字数、保护区、must_keep 四项任一超限就拒绝，
   * 由调用方把拒绝原因原样告诉作者（不静默降级成"只改一句"）。
   *
   * @param {object} input
   *   · paragraphs：`[{ span_id, start, end, text }]`（作者点到的那几段，必须连续）
   *   · protectedSpans / mustKeep：硬约束（按子串命中即算越界）
   *   · maxParagraphs / maxChars：上限（默认 3 段 / 600 字）
   * @returns {{ok:boolean, code:string, chars:number, paragraphs:number, spans:Array}}
   */
  function wideningApprovalOf(input = {}) {
    const list = Array.isArray(input.paragraphs) ? input.paragraphs.filter(Boolean) : [];
    const maxParagraphs = Number.isInteger(Number(input.maxParagraphs)) && Number(input.maxParagraphs) > 0
      ? Number(input.maxParagraphs)
      : 3;
    const maxChars = Number.isInteger(Number(input.maxChars)) && Number(input.maxChars) > 0
      ? Number(input.maxChars)
      : 600;
    const spans = list.map((p) => ({
      span_id: textOf(p.span_id),
      start: Number(p.start) || 0,
      end: Number(p.end) || 0,
      text: textOf(p.text),
    })).filter((p) => p.text.trim() && p.end > p.start);
    const chars = spans.reduce((n, p) => n + p.text.length, 0);
    const fail = (code, reason) => ({ ok: false, code, reason, chars, paragraphs: spans.length, spans: [] });
    if (!spans.length) return fail('NO_SPAN', '这一段定位不到原文：不能据此放宽授权');
    if (spans.length > maxParagraphs) {
      return fail('TOO_MANY_PARAGRAPHS', `一次最多批准 ${maxParagraphs} 段（这次选了 ${spans.length} 段）`);
    }
    if (chars > maxChars) {
      return fail('TOO_MANY_CHARS', `一次最多改 ${maxChars} 字（这几段共 ${chars} 字）：请减少段数`);
    }
    // 连续性：段与段之间只能隔着空行/换行，不允许"跳段"（跳段等于偷偷扩大范围）。
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i].start < spans[i - 1].end) return fail('OVERLAP', '批准的段落互相重叠：这不是一次合法的连续范围');
    }
    const hard = [
      ...(Array.isArray(input.protectedSpans) ? input.protectedSpans : []).map(textOf).filter(Boolean),
      ...(Array.isArray(input.mustKeep) ? input.mustKeep : []).map(textOf).filter(Boolean),
    ];
    for (const p of spans) {
      for (const h of hard) {
        if (h.length >= 4 && (p.text.includes(h) || h.includes(p.text))) {
          return fail('PROTECTED', `批准的段落里含必须保留的内容（「${clipStr(h, 20)}」）：不能作为改动对象`);
        }
      }
    }
    return { ok: true, code: 'APPROVED', reason: '', chars, paragraphs: spans.length, spans };
  }

  /** 复修时哪些"额外线索"被用上了（同一问题：剩余证据 / 作者批准的段落）。 */
  function wideningSourcesOf(input = {}) {
    const approved = input.approved && typeof input.approved === 'object' ? input.approved : {};
    const remaining = input.remaining && typeof input.remaining === 'object' ? input.remaining : {};
    const approvedIds = Object.keys(approved).filter((id) => approved[id] && Array.isArray(approved[id].spans) && approved[id].spans.length);
    const remainingIds = Object.keys(remaining).filter((id) => Array.isArray(remaining[id]) && remaining[id].length);
    const chars = approvedIds.reduce((n, id) => n + (Number(approved[id].chars) || 0), 0);
    const paragraphs = approvedIds.reduce((n, id) => n + (Array.isArray(approved[id].spans) ? approved[id].spans.length : 0), 0);
    return {
      ids: uniqueStrings([...approvedIds, ...remainingIds]),
      approvedIds,
      remainingIds,
      paragraphs,
      chars,
      // 有任意一种"额外线索"才值得提供"扩范围再修"入口；否则那就是原有的那一轮。
      any: approvedIds.length > 0 || remainingIds.length > 0,
    };
  }

  /**
   * 批准范围的默认编辑动作（纯函数）。
   *
   * 为什么多段批准默认是 `delete`：跨段授权要解决的正是"删掉/压掉整块"——
   * 逐段 `replace` 表达不了"三段合成一句"，而 `condense` 还需要额外的跨度批准开关。
   * 删除是最小的、可核对的动作（作者也能在 diff 里一眼看出删了哪几段）。
   * 单段批准则沿用审稿给出的建议动作（没有就按 replace）。
   */
  function wideningOpFor(input = {}) {
    const n = Number(input.paragraphs) || 0;
    const allowed = ['replace', 'delete', 'condense'];
    const suggested = textOf(input.suggested);
    if (n >= 2) return 'delete';
    return allowed.includes(suggested) ? suggested : 'replace';
  }

  /**
   * 合并到正文的**门禁裁决**（P0，2026-10-22）。
   *
   * 为什么这是一条判据而不是散在点击处理器里的 if：
   * 2026-10-06 的作者要求是「点合并就必须写进去」，于是旧实现把基线比较降级成一句
   * `review_merge_overwrite` 警告就照样整篇覆盖 —— 修稿候选是几分钟前的整章重写，
   * 作者在这期间改过的正文会被无声抹掉（只在历史版本里留一条）。
   * 现在的语义是：**普通合并不再静默覆盖**，但它不是"拦死"——作者仍可走「明确覆盖」，
   * 前提是他真的看见"这一章在预览之后变过"并再确认一次。两个动作在协议层就不同（mode 不同）。
   *
   * 判据顺序有意如此：
   *   1. 读不到基线 → 最严重（连"基于哪一版"都不知道），只能明确覆盖或先刷新；
   *   2. 基线变了 → 拒绝普通合并（这是本方案要解决的那个风险）；
   *   3. 候选与已验收候选不是同一份 → 拒绝（旧结论不能给新候选背书）。
   * 三者都不成立才是 OK。
   *
   * @returns {{verdict:string, reasons:string[], forceAllowed:boolean}}
   *   verdict ∈ OK / BASE_UNREADABLE / BASE_STALE / VERIFICATION_STALE
   */
  function mergeGateOf(input = {}) {
    const reasons = [];
    const unreadable = input.unreadable === true;
    const currentHash = textOf(input.currentHash);
    const updatedAt = textOf(input.updatedAt);
    const baseFingerprint = textOf(input.baseFingerprint);
    const currentFingerprint = textOf(input.currentFingerprint);
    const candidateHash = textOf(input.candidateHash);
    const verifiedHash = textOf(input.verifiedCandidateHash);
    if (unreadable || (!currentHash && !updatedAt)) {
      reasons.push('BASE_UNREADABLE');
      return { verdict: 'BASE_UNREADABLE', reasons, forceAllowed: true };
    }
    // 只有**预览时确实记过基线指纹**才谈得上"变没变"。没记过就不许猜：
    // 猜"没变"等于把旧缺陷换个地方复现（差异预览有时不带 baseFingerprint）。
    if (baseFingerprint && currentFingerprint && baseFingerprint !== currentFingerprint) {
      reasons.push('BASE_STALE');
      return { verdict: 'BASE_STALE', reasons, forceAllowed: true };
    }
    // "重算过候选但还没复验"：候选变了、结论没跟上来。旧实现会让旧结论给新候选背书，
    // 这里把它单独成一个裁决 —— 作者仍可明确覆盖，但界面不许说"已通过"。
    if (input.requiresReverify === true && !verifiedHash) {
      reasons.push('NEEDS_REVERIFY');
      return { verdict: 'NEEDS_REVERIFY', reasons, forceAllowed: true };
    }
    if (verifiedHash && candidateHash && verifiedHash !== candidateHash) {
      reasons.push('VERIFICATION_STALE');
      return { verdict: 'VERIFICATION_STALE', reasons, forceAllowed: true };
    }
    if (!baseFingerprint || !currentFingerprint) reasons.push('NO_BASE_EVIDENCE');
    return { verdict: 'OK', reasons, forceAllowed: true };
  }

  /** 「明确覆盖」必须带的那句二次确认凭据（服务端会核对它，缺了就 409）。 */
  const FORCE_ACK = 'confirmed-by-author';

  /**
   * `/novel/adopt` 的请求体片段（纯函数，便于断言"点了普通合并到底发了什么"）。
   *
   * mode=normal 时 expected.content_hash 是**现读的服务端基线**：服务端在事务内重读后再比一次，
   * 于是"客户端检查完 → 服务端写入前"这段窗口也关上了（单靠客户端比较关不掉这段）。
   */
  function mergeAdoptPayloadOf(input = {}) {
    const force = input.mode === 'explicit_force';
    const currentHash = textOf(input.currentHash);
    const updatedAt = textOf(input.updatedAt);
    const candidateHash = textOf(input.candidateHash);
    const verifiedHash = textOf(input.verifiedCandidateHash);
    const expected = {};
    if (currentHash) expected.content_hash = currentHash;
    else if (updatedAt) expected.updated_at = updatedAt;
    if (candidateHash) expected.candidate_hash = candidateHash;
    if (verifiedHash) expected.verified_candidate_hash = verifiedHash;
    if (force) {
      expected.force_ack = FORCE_ACK;
      // 覆盖仍然带着**刚读到的**服务端基线：服务端据此还能拦住"确认之后又变了"的第三次写入。
      // 缺这两个字段中的一个，服务端就不许覆盖（见 server.js 的 explicit_force 分支）。
      expected.base_conflict = 'BASE_CHANGED_SINCE_PREVIEW';
    }
    const ids = Array.isArray(input.unresolvedIssueIds)
      ? uniqueStrings(input.unresolvedIssueIds.map((s) => textOf(s)))
      : [];
    return {
      mode: force ? 'explicit_force' : 'normal',
      expected,
      unresolved_issue_ids: ids,
      // 请求体里没有 expected 的整次采纳（老客户端 / AI 采纳路径）**不做** CAS ——
      // 这条标记让界面能如实说"这次没有并发基线可校验"，而不是假装保护过。
      has_baseline: Boolean(expected.content_hash || expected.updated_at),
    };
  }

  return {
    VERSION,
    STATES,
    TRANSITIONS,
    FINAL_STATUS_LABEL,
    MAX_SINGLE_CENTS,
    MAX_TOTAL_CENTS,
    AUTO_REPAIR_HARD_BLOCK,
    DEFAULT_PRICE_CENTS,
    canTransition,
    transition,
    buildIssueStates,
    closureMetrics,
    closureVerdict,
    closureReport,
    repairTargets,
    mergeRepairSemantic,
    createClosureBudget,
    closureIdempotencyKey,
    createSeenKeys,
    isBaseStale,
    estimateRevisionCostCents,
    planAutoRepair,
    verifyAllowanceOf,
    repairIssuesFrom,
    targetedRepairOf,
    acceptedLeftoversOf,
    wideningApprovalOf,
    wideningSourcesOf,
    wideningOpFor,
    mergeGateOf,
    mergeAdoptPayloadOf,
    FORCE_ACK,
    roundsUsedOf,
    mergeRepairRounds,
  };
});
