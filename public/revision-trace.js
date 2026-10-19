/*
 * 修稿结构化追踪（revision-trace）—— 纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要（v1.2.5 方案 §4.2 / §7.3 / P1-01「运行诊断/追踪体系」）：
 *   这一次的真实经过是"8 条全选，修完仍 6/1/1"——但事后无法回答第 3 项停在哪道关口：
 *   是没进计划？补丁被门禁拒绝？语义没跑？还是模型说 pass？现有界面只给最终差异。
 *   本模块把每一轮、每条问题的**状态跃迁**落成可串联的事件：
 *     run_id + issue_id + round + event 唯一标识生命周期；
 *     每个事件只带 ID / hash / 原因码 / 计数，**绝不含正文与提示词**。
 *
 * 设计纪律（写死在实现里）：
 *   ① 事件只记录必要哈希、ID 与原因码，不写 quote、不写 prompt、不写审批凭据；
 *   ② 每条问题每轮必须有一个终态事件（即使状态是 BLOCKED / UNVERIFIED）；
 *   ③ 时间戳由调用方注入（测试可保持确定性），本模块不读 Date.now。
 *
 * 本模块不写任何文件、不调用模型；持久化由调用方决定。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionTrace = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const SCHEMA = 'revision-trace.v1';

  /** 预算状态（方案 §4.2 的 budget_status 字段：只允许这三个稳定值）。 */
  const BUDGET_STATUS = { WITHIN_LIMIT: 'WITHIN_LIMIT', UNKNOWN: 'UNKNOWN', EXHAUSTED: 'EXHAUSTED' };

  /** 事件名（稳定枚举；界面与回执按它筛选，不解析自由文本）。 */
  const EVENT = {
    RUN_FINALIZED: 'run_finalized',
    ISSUE_VERDICT: 'issue_verdict',
    SEMANTIC_VERDICT: 'semantic_verdict',
    PATCH_APPLIED: 'patch_applied',
  };

  const textOf = (x) => String(x == null ? '' : x);

  function budgetStatusOf({ costKnown, estimateCents, remainingCents } = {}) {
    if (costKnown === false || estimateCents == null) return BUDGET_STATUS.UNKNOWN;
    const remaining = Number(remainingCents);
    if (Number.isFinite(remaining) && remaining <= 0) return BUDGET_STATUS.EXHAUSTED;
    if (Number.isFinite(remaining) && Number(estimateCents) > remaining) return BUDGET_STATUS.EXHAUSTED;
    return BUDGET_STATUS.WITHIN_LIMIT;
  }

  function baseEvent(cand, round, timestamp, budgetStatus) {
    return {
      schema: SCHEMA,
      run_id: textOf(cand && cand.revision_run_id),
      chapter_id: textOf(cand && cand.chapter_id),
      base_hash: textOf(cand && cand.original_hash),
      candidate_hash: textOf(cand && cand.candidate_hash),
      round: Number.isInteger(Number(round)) && Number(round) > 0 ? Number(round) : 1,
      budget_status: Object.values(BUDGET_STATUS).includes(budgetStatus) ? budgetStatus : BUDGET_STATUS.UNKNOWN,
      timestamp: textOf(timestamp),
    };
  }

  /**
   * 由 `finalizeRevisionCandidate()` 的结果确定性生成事件。
   * @param {object} result 终审结果（status / rows / summary / candidate）
   * @param {{round?:number, timestamp?:string, budgetStatus?:string}} [opts]
   * @returns {Array<object>} revision-trace.v1 事件（run_finalized 一条 + 每问题一条）
   */
  function buildTraceEvents(result, opts = {}) {
    const r = result && typeof result === 'object' ? result : {};
    const rows = Array.isArray(r.rows) ? r.rows : [];
    const summary = r.summary && typeof r.summary === 'object' ? r.summary : {};
    const cand = r.candidate && typeof r.candidate === 'object' ? r.candidate : {};
    const budgetStatus = opts.budgetStatus || budgetStatusOf({ costKnown: opts.costKnown, estimateCents: opts.estimateCents, remainingCents: opts.remainingCents });
    const common = baseEvent(cand, opts.round, opts.timestamp, budgetStatus);
    const events = [{
      ...common,
      issue_id: '',
      event: EVENT.RUN_FINALIZED,
      state: textOf(r.status) || 'NOT_RUN',
      reason_code: '',
      selected_count: rows.length,
      verified: Number(summary.verified) || 0,
      partial: Number(summary.partial) || 0,
      failed: Number(summary.unresolved) || 0,
      unverified: Number(summary.awaiting_semantic) || 0,
      blocked: Number(summary.canon_conflict) || 0,
      coverage_complete: !!(r.coverage && r.coverage.complete),
      evidence_ids: [],
      patch_ids: [],
      actual_change: false,
    }];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      events.push({
        ...common,
        issue_id: textOf(row.issue_id),
        event: EVENT.ISSUE_VERDICT,
        state: textOf(row.final_status) || 'AWAITING_SEMANTIC',
        reason_code: textOf(row.reason_code),
        evidence_ids: (Array.isArray(row.evidence_ids) ? row.evidence_ids : []).map(textOf),
        patch_ids: (Array.isArray(row.patch_ids) ? row.patch_ids : []).map(textOf),
        actual_change: row.actual_change === true,
        semantic_status: textOf(row.semantic_status) || 'not_run',
        coverage_status: textOf(row.coverage_status),
      });
    }
    return events;
  }

  /** 一条事件里允许出现的字符串长度上限：原因码/ID/状态都远小于它，正文引文则不会通过。 */
  const MAX_STRING = 160;

  /**
   * 脱敏自检：事件里不得出现正文片段（方案 §4.2 "完整正文/提示词不写入常规日志"）。
   * 做法是从正文里抽 24 字窗口做包含判定 —— 短于 24 字的正文/引文不参与，
   * 避免把"拿着喝"这种正常 ID 片段误判为泄露。
   * @returns {{ok:boolean, offenders:Array<{path:string, sample:string}>}}
   */
  function checkRedaction(events, bodyText) {
    const body = textOf(bodyText);
    const needles = [];
    if (body.length >= 24) {
      const step = Math.max(1, Math.floor(body.length / 64));
      for (let i = 0; i + 24 <= body.length; i += step) needles.push(body.slice(i, i + 24));
    }
    const offenders = [];
    const walk = (value, path) => {
      if (typeof value === 'string') {
        if (value.length > MAX_STRING) offenders.push({ path, sample: `${value.slice(0, 32)}…` });
        for (const needle of needles) {
          if (value.includes(needle)) { offenders.push({ path, sample: needle }); break; }
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(events, 'events');
    return { ok: offenders.length === 0, offenders: offenders.slice(0, 8) };
  }

  /** 汇总：给回执/界面一句话，不新增第二套计数口径（直接复用事件里的数字）。 */
  function summarizeTrace(events) {
    const list = Array.isArray(events) ? events : [];
    const run = list.find((e) => e && e.event === EVENT.RUN_FINALIZED) || null;
    return {
      schema: SCHEMA,
      run_id: run ? run.run_id : '',
      state: run ? run.state : 'NOT_RUN',
      selected: run ? run.selected_count : 0,
      verified: run ? run.verified : 0,
      partial: run ? run.partial : 0,
      failed: run ? run.failed : 0,
      unverified: run ? run.unverified : 0,
      issues: list.filter((e) => e && e.event === EVENT.ISSUE_VERDICT).length,
    };
  }

  return {
    VERSION,
    SCHEMA,
    BUDGET_STATUS,
    EVENT,
    MAX_STRING,
    budgetStatusOf,
    buildTraceEvents,
    checkRedaction,
    summarizeTrace,
  };
});
