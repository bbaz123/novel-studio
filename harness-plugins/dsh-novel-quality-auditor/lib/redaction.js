/**
 * 脱敏：插件永远不把 token、正文、完整 findings 写进日志/错误文本。
 *
 * 为什么单独一个模块：错误对象会被上层打印、会被 DSH 记进会话。
 * "只在写日志的地方记得脱敏"是不可执行的约束 —— 把脱敏做成**返回值**，
 * 调用点就没法忘记。
 */
const TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

export function redactText(text, { maxChars = 300 } = {}) {
  let s = String(text == null ? '' : text);
  const token = String(process.env.NOVELSTUDIO_AUDIT_TOKEN || '');
  if (token && token.length > 8) s = s.split(token).join('[REDACTED_TOKEN]');
  s = s.replace(TOKEN_RE, '[REDACTED]');
  if (s.length > maxChars) s = s.slice(0, maxChars) + '…';
  return s;
}

/** 只留"形状"：字段名 + 长度，不留内容。 */
export function shapeOf(value, depth = 0) {
  if (depth > 2) return '…';
  if (Array.isArray(value)) return { array: value.length, sample: value.length ? shapeOf(value[0], depth + 1) : null };
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'string' ? { chars: v.length } : shapeOf(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return { chars: value.length };
  return typeof value;
}

export function safeErrorPayload(err) {
  return {
    code: String(err && err.code || 'AUDIT_TOOL_ERROR'),
    message: redactText(err && err.message || err, { maxChars: 200 }),
    retryable: Boolean(err && err.retryable),
  };
}
