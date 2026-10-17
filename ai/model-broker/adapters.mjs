/**
 * ai/model-broker/adapters.mjs —— S10：RuntimeAdapter 契约（direct / legacy 同一结果契约）。
 *
 * 为什么需要适配器：项目里同时存在"直连模型"（callAI 打 HTTP）与"旧 DSH 包装"（子进程）。
 * 两条路径若各自返回各自的形状，上层就得写两份分支，迟早漂移。
 * 这里定义一个**最小结果契约**，两个适配器都必须满足：
 *
 *   { ok:boolean, status:'done'|'failed'|'not_run'|'unknown',
 *     text:string, usage:{prompt_tokens,completion_tokens,total_tokens}|null,
 *     provider:string, model:string, error:string, attempts:number }
 *
 * 契约的三条硬要求（S10 验收）：
 *   ① **同一份输入 → 同一形状**（无论 direct 还是 legacy）；
 *   ② **不抛异常**：失败也返回 `ok:false` 的对象（上层据此决定重试/放弃）；
 *   ③ `not_run` 是**独立状态**，不能与 `failed` 混用 —— "没有模型"与"模型坏了"是两件事。
 *
 * 纪律：适配器只做"调用 + 归一化"，不做重试策略、不做预算（预算在 envelope 里）。
 */

export const ADAPTER_CONTRACT_VERSION = 'adapter-v1';

export const RESULT_STATUS = Object.freeze(['done', 'failed', 'not_run', 'unknown']);

/** 归一化结果：任何适配器都必须用它产出返回值。 */
export function makeResult({
  ok = false, status = 'unknown', text = '', usage = null,
  provider = '', model = '', error = '', attempts = 1,
} = {}) {
  const s = RESULT_STATUS.includes(String(status)) ? String(status) : 'unknown';
  // ok 与 status 必须自洽：只有 done 才能 ok
  const okFinal = s === 'done' ? ok === true : false;
  let normUsage = null;
  if (usage && typeof usage === 'object') {
    const p = Number(usage.prompt_tokens) || 0;
    const c = Number(usage.completion_tokens) || 0;
    const t = Number(usage.total_tokens) || (p + c);
    normUsage = Object.freeze({ prompt_tokens: p, completion_tokens: c, total_tokens: t });
  }
  return Object.freeze({
    contract: ADAPTER_CONTRACT_VERSION,
    ok: okFinal,
    status: s,
    text: String(text == null ? '' : text),
    usage: normUsage,
    provider: String(provider || ''),
    model: String(model || ''),
    error: String(error || ''),
    attempts: Number(attempts) || 1,
  });
}

/** 契约自检：供测试断言"这个返回值符合契约"。 */
export function assertResultContract(r) {
  const problems = [];
  if (!r || typeof r !== 'object') return ['NOT_AN_OBJECT'];
  if (r.contract !== ADAPTER_CONTRACT_VERSION) problems.push('WRONG_CONTRACT');
  if (!RESULT_STATUS.includes(r.status)) problems.push('INVALID_STATUS');
  if (typeof r.ok !== 'boolean') problems.push('INVALID_OK');
  if (r.ok && r.status !== 'done') problems.push('OK_WITHOUT_DONE');
  if (!r.ok && r.status === 'done') problems.push('DONE_WITHOUT_OK');
  if (typeof r.text !== 'string') problems.push('INVALID_TEXT');
  if (r.usage !== null && (typeof r.usage !== 'object' || typeof r.usage.total_tokens !== 'number')) problems.push('INVALID_USAGE');
  if (typeof r.attempts !== 'number' || r.attempts < 1) problems.push('INVALID_ATTEMPTS');
  return problems;
}

/**
 * direct 适配器：把 `callAI`（注入）包成契约。
 * 注入式设计使它能离线单测（注入 fake callAI），无需真实网络。
 */
export function createDirectAdapter({ callAI } = {}) {
  if (typeof callAI !== 'function') throw new TypeError('MISSING_CALL_AI');
  return {
    kind: 'direct',
    async run(envelope, { messages, signal = null } = {}) {
      const cfg = { base_url: envelope.model.base_url, api_key: '', model: envelope.model.model };
      try {
        const r = await callAI(cfg, messages, { signal, envelope });
        const text = typeof r === 'string' ? r : String((r && (r.text ?? r.content)) || '');
        return makeResult({
          ok: true, status: 'done', text,
          usage: r && r.usage ? r.usage : null,
          provider: 'direct', model: envelope.model.model, attempts: 1,
        });
      } catch (e) {
        return makeResult({
          ok: false, status: 'failed', error: String((e && e.message) || e),
          provider: 'direct', model: envelope.model.model,
        });
      }
    },
  };
}

/**
 * legacy 适配器：把旧的 DSH 包装（注入）包成**同一契约**。
 * 关键点：旧包装失败/超时/未配置时，也要映射成 `failed` / `not_run`，而不是抛出去。
 */
export function createLegacyAdapter({ runLegacy } = {}) {
  if (typeof runLegacy !== 'function') throw new TypeError('MISSING_RUN_LEGACY');
  return {
    kind: 'legacy',
    async run(envelope, { prompt = '', signal = null } = {}) {
      try {
        const r = await runLegacy({ prompt, envelope, signal });
        // 旧包装可能返回 {ok,text}、也可能返回字符串 —— 都要归一化
        if (typeof r === 'string') {
          return makeResult({ ok: true, status: 'done', text: r, provider: 'legacy', model: envelope.model.model });
        }
        if (!r || typeof r !== 'object') {
          return makeResult({ ok: false, status: 'unknown', error: 'legacy 返回了不可识别的结果', provider: 'legacy', model: envelope.model.model });
        }
        if (r.status === 'not_run') {
          return makeResult({ ok: false, status: 'not_run', text: String(r.text || ''), error: String(r.error || r.reason || ''), provider: 'legacy', model: envelope.model.model });
        }
        if (r.ok === false) {
          return makeResult({ ok: false, status: 'failed', text: String(r.text || ''), error: String(r.error || r.reason || 'legacy 执行失败'), provider: 'legacy', model: envelope.model.model });
        }
        return makeResult({
          ok: true, status: 'done', text: String(r.text || ''),
          usage: r.usage || undefined, provider: 'legacy', model: envelope.model.model,
        });
      } catch (e) {
        return makeResult({
          ok: false, status: 'failed', error: String((e && e.message) || e),
          provider: 'legacy', model: envelope.model.model,
        });
      }
    },
  };
}

/** 选择适配器：按信封里的路由来源决定（direct 优先，legacy 兜底）。 */
export function pickAdapter({ direct, legacy, sdk } = {}, envelope) {
  const source = String((envelope && envelope.route && envelope.route.source) || '');
  if (source === 'sdk') {
    // 显式请求了 SDK 路由：**只有在接入点上真实可用时才用它**，
    // 否则如实降级并把降级原因带回去（不能让人以为走的是 SDK）。
    if (sdk && sdk.available) return sdk;
    const fallback = direct || legacy || null;
    if (fallback) {
      return Object.freeze({
        ...fallback,
        degradedFrom: 'sdk',
        degradedReason: (sdk && sdk.unavailableReason) || 'SDK_ROUTE_UNAVAILABLE',
      });
    }
    return null;
  }
  if (source === 'legacy' && legacy) return legacy;
  if (direct) return direct;
  if (legacy) return legacy;
  return null;
}

/**
 * SDK 适配器（R01）：把真实 DSH 子进程运行时包成**同一结果契约**。
 *
 * 三个刻意的设计：
 *   ① **默认关闭**。`enabled` 必须由显式配置打开（`NOVELSTUDIO_SDK_ROUTE`），
 *      不允许"因为代码存在就自动走 SDK"。
 *   ② 关闭时返回 `not_run`（不是 `failed`）：**"没启用"与"坏了"是两件事**。
 *   ③ 真实运行时的 `unknown` 原样透传：外部请求已发、结果不明时，
 *      上层必须看到 `unknown` 而不是被抹成 `failed` 或 `done`。
 *
 * @param runtime   `createSdkRuntimeAdapter()` 的返回值
 * @param enabled   显式开关（默认 false）
 * @param env       `{ envAllow, envExtra, cwd }`，转发给子进程的环境白名单
 */
export function createSdkAdapter({ runtime = null, enabled = false, env = {} } = {}) {
  return {
    kind: 'sdk',
    get available() { return enabled === true && !!runtime; },
    get unavailableReason() {
      if (enabled !== true) return 'SDK_ROUTE_DISABLED';
      if (!runtime) return 'SDK_RUNTIME_NOT_WIRED';
      return '';
    },
    async run(envelope, { prompt = '', signal = null } = {}) {
      const model = String((envelope && envelope.model && envelope.model.model) || '');
      if (enabled !== true) {
        return makeResult({ ok: false, status: 'not_run', error: 'SDK_ROUTE_DISABLED', provider: 'sdk', model });
      }
      if (!runtime) {
        return makeResult({ ok: false, status: 'not_run', error: 'SDK_RUNTIME_NOT_WIRED', provider: 'sdk', model });
      }
      const taskId = String((envelope && envelope.route && envelope.route.task_id) || `sdk-${Date.now().toString(36)}`);
      const sessionId = String((envelope && envelope.route && envelope.route.session_id) || '');
      const provider = String((envelope && envelope.model && envelope.model.provider) || '');
      if (!sessionId || !provider) {
        return makeResult({ ok: false, status: 'not_run', error: 'MISSING_PROVIDER_OR_SESSION', provider: 'sdk', model });
      }
      try {
        const r = await runtime.runTask({
          taskId, sessionId, prompt,
          provider, model,
          cwd: env.cwd,
          envAllow: env.envAllow || [],
          envExtra: env.envExtra || {},
          ...(signal ? {} : {}),
        });
        const status = r.terminal === 'done' ? 'done' : (r.terminal === 'unknown' ? 'unknown' : 'failed');
        return makeResult({
          ok: status === 'done',
          status,
          text: r.text || '',
          usage: r.usage || null,
          provider: 'sdk',
          model,
          error: r.error || '',
          attempts: 1,
        });
      } catch (e) {
        // 契约 ②：不抛异常
        return makeResult({ ok: false, status: 'failed', error: String((e && e.message) || e), provider: 'sdk', model });
      }
    },
  };
}
