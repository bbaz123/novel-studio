/**
 * ai/quality-auditor/usage.mjs —— 审计**真实用量**的归一与结清（纯函数，零 IO）。
 *
 * 背景（2026-10-22 真实演练）：`budget_charged_microunits` 从来没有写入方，
 * 于是跑完的审计在界面上显示"实际 ¥0.00"。第一版修法是"未知就写未知"——
 * 那只是不再谎报，钱仍然记不上账。这一步补上真正的结清链路：
 *
 *   审计子进程（dsh）侧的真实用量 → 提交时随 `usage` 回传 → 服务端按**可信价目表**折算 → 落账。
 *
 * 三条纪律（与 budget.mjs 同一立场）：
 *   1. **没有价目就不算钱**：`priceTable` 缺失/没有该型号 → 未知，绝不"按字数猜价格"；
 *   2. **没有用量就不算钱**：`usage` 缺失 → 未知，不把"没报"当成"免费"；
 *   3. **来源必须写清**：`source ∈ {reported_cost, usage_table}`，让事后能审计这笔钱是怎么来的。
 *
 * 关于 `reported_cost`：如果子进程/插件直接报了一个金额（它自己可能知道），
 * 我们接受它**并标明来源**，但不会把它当成"官方账单"——它是"对方说花了这么多"。
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => String(v == null ? '' : v).trim();

/** 用量归一：接受几种常见形状，非法/缺失一律返回 null（不猜）。 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = num(raw.input_tokens != null ? raw.input_tokens : raw.prompt_tokens);
  const output = num(raw.output_tokens != null ? raw.output_tokens : raw.completion_tokens);
  const model = str(raw.model);
  const cost = num(raw.cost_cny != null ? raw.cost_cny : raw.reported_cost_cny);
  if (cost == null && (input == null || input < 0) && (output == null || output < 0)) return null;
  return {
    input_tokens: input != null && input >= 0 ? Math.round(input) : null,
    output_tokens: output != null && output >= 0 ? Math.round(output) : null,
    model,
    reported_cost_cny: cost != null && cost >= 0 ? cost : null,
  };
}

/**
 * 价目表校验：`{ "<model>": { input_cny_per_1k, output_cny_per_1k } }`。
 * 任何一项不是有限非负数就整体判为不可用（半张价目表比没有更危险）。
 */
export function normalizePriceTable(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [model, p] of Object.entries(raw)) {
    const key = str(model);
    if (!key || !p || typeof p !== 'object') continue;
    const i = num(p.input_cny_per_1k);
    const o = num(p.output_cny_per_1k);
    if (i == null || o == null || i < 0 || o < 0) continue;
    out[key] = { input_cny_per_1k: i, output_cny_per_1k: o };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 结清判定。
 *
 * @param {{usage?:object, priceTable?:object}} input
 * @returns {{known:boolean, micro_units:number|null, cny:number|null, source:string, detail:string}}
 *   source ∈ reported_cost / usage_table / unknown
 */
export function settleChargeFrom({ usage, priceTable } = {}) {
  const u = normalizeUsage(usage);
  if (!u) {
    return { known: false, micro_units: null, cny: null, source: 'unknown', detail: '没有回传真实用量（tokens 或金额），不按 0 记账' };
  }
  if (u.reported_cost_cny != null) {
    const mu = Math.round(u.reported_cost_cny * 1_000_000);
    return { known: true, micro_units: mu, cny: u.reported_cost_cny, source: 'reported_cost', detail: `子进程自报金额 ¥${u.reported_cost_cny.toFixed(2)}` };
  }
  const table = normalizePriceTable(priceTable);
  if (!table) {
    return { known: false, micro_units: null, cny: null, source: 'unknown', detail: '有 token 用量但未配置可信价目表（audit_price_table）：不按字数猜价格' };
  }
  const model = u.model || Object.keys(table)[0];
  const p = table[model];
  if (!p) {
    return { known: false, micro_units: null, cny: null, source: 'unknown', detail: `价目表里没有型号 ${model || '(空)'}` };
  }
  const inTokens = u.input_tokens == null ? 0 : u.input_tokens;
  const outTokens = u.output_tokens == null ? 0 : u.output_tokens;
  const cny = (inTokens / 1000) * p.input_cny_per_1k + (outTokens / 1000) * p.output_cny_per_1k;
  const mu = Math.round(cny * 1_000_000);
  return {
    known: true, micro_units: mu, cny,
    source: 'usage_table',
    detail: `${model}：入 ${inTokens} tok × ¥${p.input_cny_per_1k}/1k + 出 ${outTokens} tok × ¥${p.output_cny_per_1k}/1k`,
  };
}

/** 一行给人看的说明（界面/日志共用）。 */
export function chargeLineOf(settled) {
  const s = settled && typeof settled === 'object' ? settled : {};
  if (s.known !== true) return `实际费用未知：${str(s.detail) || '没有可用的计量来源'}`;
  return `实际 ¥${(Number(s.cny) || 0).toFixed(2)}（${s.source === 'reported_cost' ? '子进程自报' : '按价目表折算'}）`;
}
