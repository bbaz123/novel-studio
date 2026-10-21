/**
 * 插件侧错误：带**机器可读 code** 与"是否值得重试"。
 *
 * 为什么不像 novel-tools 那样直接 throw new Error(文本)：审计的失败要按真实错误码
 * 显示/重试（AUDIT_TOKEN_EXPIRED 可以续 token，AUDIT_PHASE_INVALID 重试一万次也没用）。
 * 纯文本错误会让模型自己猜"要不要再来一次"，而它没有这个信息。
 */
export class AuditToolError extends Error {
  constructor(code, message, { retryable = false, status = 0, detail = '' } = {}) {
    super(message || code);
    this.name = 'AuditToolError';
    this.code = String(code || 'AUDIT_TOOL_ERROR');
    this.retryable = Boolean(retryable);
    this.status = Number(status) || 0;
    this.detail = String(detail || '');
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, status: this.status };
  }
}

export const RETRYABLE = new Set([
  'AUDIT_TOKEN_EXPIRED', 'AUDIT_NOT_FOUND', 'AUDIT_RESULT_CONFLICT',
]);

/** 把 HTTP 响应映射成错误（没有 code 时给一个可读的兜底，不吞掉状态码）。 */
export function errorFromResponse(status, data, fallback = 'AUDIT_TOOL_ERROR') {
  const code = String((data && data.code) || fallback);
  const message = String((data && (data.error || data.detail)) || `HTTP ${status}`);
  return new AuditToolError(code, message, { status, retryable: RETRYABLE.has(code) || status >= 500 });
}
