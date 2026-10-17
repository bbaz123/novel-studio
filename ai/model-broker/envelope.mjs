/**
 * ai/model-broker/envelope.mjs —— S10：不可变 TaskEnvelope 与调用预算。
 *
 * 为什么需要"信封"：任务一旦发出，就不该在中途被改写（换模型、换作品、放宽预算）。
 * 否则"这次到底用哪个模型、给哪本书、允许多少次"永远说不清 —— 与 F04 是同一类问题。
 * 因此 `createTaskEnvelope()` 返回**冻结对象**，任何写入都会在严格模式下抛错。
 *
 * 为什么预算要管"总请求数 + 期限"（S10 动作 7）：
 * 只限制**单次输出 token** 是很危险的 —— 一个 agent 循环可以发起**无限次**请求，
 * 每次都合规，总量却失控。所以预算必须同时约束：总请求数、总 token、总期限。
 *
 * 纪律：纯函数 + 冻结对象，不发请求、不读环境。
 */

export const ENVELOPE_VERSION = 'env-v1';

export const DEFAULT_BUDGET = Object.freeze({
  maxRequests: 8,        // 一次任务最多发多少次请求（防"每次都合规但次数无限"）
  maxTotalTokens: 60_000, // 兜底总 token（输出上限之和的上界）
  deadlineMs: 120_000,   // 从信封创建起的硬期限
});

export class BudgetExceeded extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'BudgetExceeded';
    this.code = code;
    this.detail = detail;
  }
}

function positiveInt(v, fallback, label) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`INVALID_${label}`);
  return n;
}

/**
 * 创建不可变任务信封。
 *
 * @param workId      作品（0 表示不带作品，例如全局工具任务）
 * @param purpose     用途（必须能通过 routing.normalizePurpose）
 * @param route       路由结果（resolveRoute 的返回值；NO_ROUTE 也要如实带上）
 * @param taskId/revisionId/chapterId 任务上下文（0/null 表示不适用）
 * @param budget      预算覆盖（不传用 DEFAULT_BUDGET）
 * @param now         时钟（测试注入）
 */
export function createTaskEnvelope({
  workId = 0, purpose = 'analysis', route = null,
  taskId = 0, chapterId = 0, revisionId = '',
  budget = {}, now = Date.now,
} = {}) {
  if (!route || typeof route !== 'object') throw new TypeError('MISSING_ROUTE');
  if (!route.ok) throw new TypeError(`UNROUTABLE:${route.reason || 'UNKNOWN'}`);
  const config = route.config || {};
  const envelope = {
    version: ENVELOPE_VERSION,
    work_id: Number(workId) || 0,
    purpose: String(purpose || ''),
    // 路由快照：记录下来就不必"以后再算一次"（算了就可能变）
    route: Object.freeze({
      source: String((route.route && route.route.source) || ''),
      purpose: String(route.purpose || ''),
      api_config_id: Number((route.route && route.route.api_config_id) || (config.id || 0)),
    }),
    model: Object.freeze({
      provider: String(config.name || ''),
      base_url: String(config.base_url || ''),
      model: String(config.model || ''),
      // ⚠️ api_key 不进信封：信封要能被日志/事件携带，密钥不该出现在可记录对象里
      needs_api_key: route.needs_api_key === true,
    }),
    context: Object.freeze({
      task_id: Number(taskId) || 0,
      chapter_id: Number(chapterId) || 0,
      revision_id: String(revisionId || ''),
    }),
    budget: Object.freeze({
      max_requests: positiveInt(budget.maxRequests, DEFAULT_BUDGET.maxRequests, 'MAX_REQUESTS'),
      max_total_tokens: positiveInt(budget.maxTotalTokens, DEFAULT_BUDGET.maxTotalTokens, 'MAX_TOTAL_TOKENS'),
      deadline_ms: positiveInt(budget.deadlineMs, DEFAULT_BUDGET.deadlineMs, 'DEADLINE_MS'),
    }),
    created_at_ms: Number(now()),
  };
  return Object.freeze(envelope);
}

/**
 * 预算账本：**只增不减**地记账，任何越界立即抛 BudgetExceeded。
 * 为什么不做"够了就返回 false"：静默返回 false 会让调用方继续跑，
 * 最终从"没超预算"变成"超了但没人知道"。这里让越界变成**异常**。
 */
export function createBudgetLedger(envelope, { now = Date.now } = {}) {
  if (!envelope || !envelope.budget) throw new TypeError('MISSING_ENVELOPE');
  const b = envelope.budget;
  const startedAt = Number(envelope.created_at_ms || now());
  const state = { requests: 0, totalTokens: 0, startedAt };

  function checkDeadline() {
    const elapsed = Number(now()) - startedAt;
    if (elapsed > b.deadline_ms) {
      throw new BudgetExceeded('DEADLINE_EXCEEDED', `已耗时 ${elapsed}ms，超过期限 ${b.deadline_ms}ms`);
    }
  }

  /** 每次发起请求前调用：先查期限，再占一个请求名额。 */
  function takeRequest({ note = '' } = {}) {
    checkDeadline();
    if (state.requests + 1 > b.max_requests) {
      throw new BudgetExceeded('MAX_REQUESTS_EXCEEDED', `已发 ${state.requests} 次，上限 ${b.max_requests}${note ? `（${note}）` : ''}`);
    }
    state.requests += 1;
    return state.requests;
  }

  /** 收到 usage 后记账（超总量立即抛，而不是等下一次）。 */
  function recordUsage(usage = {}) {
    const n = Number(usage.total_tokens ?? (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0)));
    const add = Number.isFinite(n) && n > 0 ? n : 0;
    state.totalTokens += add;
    if (state.totalTokens > b.max_total_tokens) {
      throw new BudgetExceeded('MAX_TOTAL_TOKENS_EXCEEDED', `累计 ${state.totalTokens} token，上限 ${b.max_total_tokens}`);
    }
    return state.totalTokens;
  }

  function snapshot() {
    return Object.freeze({
      version: ENVELOPE_VERSION,
      requests: state.requests,
      total_tokens: state.totalTokens,
      elapsed_ms: Number(now()) - startedAt,
      limits: Object.freeze({ ...b }),
    });
  }

  return { takeRequest, recordUsage, snapshot, checkDeadline };
}
