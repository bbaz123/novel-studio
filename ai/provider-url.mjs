/**
 * ai/provider-url.mjs —— AI provider 地址的信任边界（P16，2026-10-18）。
 *
 * 产品决策（写在 docs/v1.2.0-p16-p14-decisions.md，此处是它的可执行部分）：
 *   · **作者**直连任意 OpenAI 兼容服务是受支持功能（本地 Ollama / LM Studio / 自建网关），
 *     所以不按"私网/localhost"一刀切拦截；
 *   · 但合法的本地服务不等于任意协议/任意凭证位置：只允许 http/https，
 *     不允许把用户名密码写进 URL（那会把凭证带进日志与错误文案）；
 *   · **模型通道**不得自带 base_url / api_key —— 凭证只能来自作者配置；
 *   · 请求**不跟随重定向**（callAI 设置 `redirect: 'error'`）：否则 provider 可以把
 *     `Authorization` 转发到另一个主机，等于绕过"凭证只发给作者配置的目标"。
 *
 * 纯函数、无副作用、可离线断言。
 */

/**
 * 校验 provider base_url。
 * @param {string} raw
 * @returns {{ok:true, value:string} | {ok:false, reason:string}}
 */
export function validateProviderBaseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: '' };
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    return { ok: false, reason: `provider 地址不是合法 URL：${text.slice(0, 120)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `provider 地址只允许 http/https（当前 ${url.protocol}）` };
  }
  if (url.username || url.password) {
    // 凭证必须走 Authorization 头（只发给配置里的目标），不能藏在 URL 里进日志。
    return { ok: false, reason: 'provider 地址不能内嵌用户名/密码：请把凭证填在 API Key 字段' };
  }
  return { ok: true, value: text };
}

/**
 * 模型通道（X-Novel-Agent）的 provider 选择限制：
 * 只允许引用作者已保存的配置（config_id），不得在请求里自带地址或凭证。
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function assertModelChannelProvider(body = {}) {
  if (body && (body.base_url !== undefined && body.base_url !== null && String(body.base_url).trim() !== '')) {
    return { ok: false, reason: '模型通道不能自带 base_url：请使用作者配置的 config_id' };
  }
  if (body && (body.api_key !== undefined && body.api_key !== null && String(body.api_key).trim() !== '')) {
    return { ok: false, reason: '模型通道不能自带 api_key：凭证只能由作者配置' };
  }
  return { ok: true };
}

/**
 * 模型通道的消息体积限制（防"把整本书塞进一次请求"造成费用与内存失控）。
 * @returns {{ok:true, totalBytes:number, count:number} | {ok:false, reason:string, totalBytes:number, count:number}}
 */
export function checkAgentMessages(messages, { maxCount = 50, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Array.isArray(messages)) return { ok: true, totalBytes: 0, count: 0 };
  let totalBytes = 0;
  for (const m of messages) {
    totalBytes += Buffer.byteLength(String((m && m.content) || ''), 'utf8');
  }
  if (messages.length > maxCount) {
    return { ok: false, totalBytes, count: messages.length, reason: `模型通道一次最多 ${maxCount} 条消息（当前 ${messages.length}）` };
  }
  if (totalBytes > maxBytes) {
    return { ok: false, totalBytes, count: messages.length, reason: `模型通道消息体过大（${totalBytes} 字节 > 上限 ${maxBytes} 字节）` };
  }
  return { ok: true, totalBytes, count: messages.length };
}
