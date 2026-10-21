/**
 * ai/quality-auditor/budget.mjs —— 费用门禁（方案 §13 / CO-04 / CO-05）。
 *
 * 硬规则：
 *   · 单次收费调用 ≤ ¥2；本次任务累计默认 ≤ ¥2；
 *   · 不拆单规避（同一个 operation_key 的多次调用按累计算，见 in-flight 记录）；
 *   · **无法可靠计量时不得虚构费用**：`cost_known=false`，界面显示"估算不可用"，
 *     并且不允许自动重试（只有"契约修复"这一次显式重试例外，它由调用方显式标记）。
 *
 * 为什么这里不做"按字数猜价格"：猜测值一旦进入门禁，就会出现"看起来在预算内"的
 * 假保证 —— 那比"不知道"更危险。未知就如实标未知，让作者决定是否继续。
 */

export const MICROUNITS_PER_CNY = 1_000_000;
export const MAX_SINGLE_CNY = 2;
export const MAX_TOTAL_CNY = 2;

export const cnyToMicrounits = (cny) => Math.round((Number(cny) || 0) * MICROUNITS_PER_CNY);
export const microunitsToCny = (mu) => Math.round(Number(mu) || 0) / MICROUNITS_PER_CNY;

/**
 * 预算放行判定。
 * @param {object} input
 * @param {number|null} input.estimatedCny 本次预估费用（null/undefined = 无法可靠计量）
 * @param {number} [input.authorizedCny] 已授权的单次额度（缺省用默认上限）
 * @param {number} [input.chargedCny] 本次已计费
 * @param {number} [input.spentTotalCny] 本次任务累计已花费
 * @returns {{ok:boolean, code:string, detail:string, cost_known:boolean, estimated_cny:number|null, limits:object}}
 */
export function budgetGuard({ estimatedCny, authorizedCny, chargedCny = 0, spentTotalCny = 0 } = {}) {
  const singleLimit = Math.min(MAX_SINGLE_CNY, Number.isFinite(Number(authorizedCny)) && Number(authorizedCny) > 0 ? Number(authorizedCny) : MAX_SINGLE_CNY);
  const totalLimit = MAX_TOTAL_CNY;
  const known = Number.isFinite(Number(estimatedCny)) && Number(estimatedCny) >= 0;
  const est = known ? Number(estimatedCny) : null;
  const spent = Number(spentTotalCny) || 0;
  const charged = Number(chargedCny) || 0;
  const limits = { single_cny: singleLimit, total_cny: totalLimit, spent_cny: spent, charged_cny: charged };

  if (spent + charged >= totalLimit) {
    return { ok: false, code: 'AUDIT_BUDGET_EXCEEDED', detail: `累计已达上限 ¥${totalLimit}（已花 ¥${(spent + charged).toFixed(2)}）`, cost_known: known, estimated_cny: est, limits };
  }
  if (known && est > singleLimit) {
    return { ok: false, code: 'AUDIT_BUDGET_EXCEEDED', detail: `单次预估 ¥${est.toFixed(2)} 超过上限 ¥${singleLimit}`, cost_known: true, estimated_cny: est, limits };
  }
  if (known && spent + charged + est > totalLimit) {
    return { ok: false, code: 'AUDIT_BUDGET_EXCEEDED', detail: `本次会把累计推到 ¥${(spent + charged + est).toFixed(2)}，超过上限 ¥${totalLimit}`, cost_known: true, estimated_cny: est, limits };
  }
  return {
    ok: true,
    code: 'OK',
    // 未知费用不阻断启动（否则整套功能在未配置价格时完全不可用），但界面必须显示"估算不可用"。
    detail: known ? `预估 ¥${est.toFixed(2)}，在 ¥${singleLimit} 单次上限内` : '费用无法可靠计量：不做自动重试，显示"估算不可用"',
    cost_known: known,
    estimated_cny: est,
    limits,
  };
}

/**
 * 同一 input hash 不重复付费（方案 §13）。
 * @param {object} input { inputHash, existing: [{input_hash, status, audit_id}] }
 */
export function reuseDecision({ inputHash, existing = [] } = {}) {
  const hash = String(inputHash || '');
  if (!hash) return { ok: true, reuse: false };
  const hit = (Array.isArray(existing) ? existing : []).find((r) => String(r && r.input_hash) === hash
    && ['RESULT_RECEIVED', 'HOST_VERIFIED', 'MERGED', 'COMPLETED', 'BLIND_SUBMITTED'].includes(String(r && r.status)));
  if (hit) return { ok: true, reuse: true, audit_id: String(hit.audit_id || ''), status: String(hit.status) };
  return { ok: true, reuse: false };
}
