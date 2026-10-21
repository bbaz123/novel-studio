/**
 * 审计 API 的 HTTP 客户端：唯一出口，token 只在这里出现。
 *
 * 约束：
 *   · token 走 header（`x-audit-token`），不进 URL、不进日志；
 *   · 连接失败/超时/非 2xx 都映射成带 code 的错误（上层据此决定是否重试）；
 *   · 响应体异常时只保留前 200 字符，避免把正文/大段 JSON 灌进上下文。
 */
import { AuditToolError, errorFromResponse } from './errors.js';
import { redactText } from './redaction.js';

export function createClient({ baseUrl, token }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  async function request(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 20000));
    try {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-audit-token': String(token || '') },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
      if (!res.ok) throw errorFromResponse(res.status, data);
      return data;
    } catch (e) {
      if (e instanceof AuditToolError) throw e;
      if (e && e.name === 'AbortError') {
        throw new AuditToolError('AUDIT_TIMEOUT', `审计请求超时（${timeoutMs}ms）：${path}`, { retryable: true });
      }
      throw new AuditToolError('AUDIT_NETWORK', `无法连接 Novel Studio（${base}）：${redactText(e && e.message || e, { maxChars: 160 })}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return { request, baseUrl: base };
}
