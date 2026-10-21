/**
 * 插件侧的最小契约：只做"形状不对就别发请求"的前置检查。
 * 完整校验在服务端（quote/hash/coverage），这里重复实现会漂移 —— 所以只检查必填键。
 */
export const DIMENSIONS = [
  'blueprint', 'continuity', 'character', 'causality', 'repetition',
  'style', 'pacing_hook', 'temporal_foreshadowing', 'evidence_integrity',
];

export const OPERATIONS = ['blind_draft', 'final'];
export const RESOURCES = ['article', 'base_article', 'blueprint', 'context', 'initial_review', 'candidate', 'selected_findings', 'patch_trace'];
export const MAX_LIMIT = 20000;

export function assertSubmitArgs(args) {
  const operation = String(args && args.operation || '');
  if (!OPERATIONS.includes(operation)) {
    return { ok: false, code: 'AUDIT_CONTRACT_INVALID', detail: `operation 必须是 ${OPERATIONS.join(' / ')}` };
  }
  const payload = args && args.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'AUDIT_CONTRACT_INVALID', detail: 'payload 必须是对象' };
  }
  return { ok: true, operation, payload };
}

export function assertReadArgs(args) {
  const resource = String(args && args.resource || '');
  if (!RESOURCES.includes(resource)) {
    return { ok: false, code: 'AUDIT_SCOPE_MISMATCH', detail: `resource 必须是 ${RESOURCES.join(' / ')}` };
  }
  const cursor = Math.max(0, Math.floor(Number(args && args.cursor) || 0));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(args && args.limit) || 16000)));
  return { ok: true, resource, cursor, limit };
}
