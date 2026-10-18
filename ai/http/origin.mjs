/**
 * ai/http/origin.mjs —— 写请求的来源校验（2026-10-18，P04）。
 *
 * 为什么必须抽出来单测：旧实现只比较 `new URL(origin).hostname` 是否属于
 * localhost/127.0.0.1/::1。于是**同在本机、但换一个端口**的页面（例如本地起的
 * 5173 开发服务器、或被注入的 iframe）也能作为"作者"向工作台发写请求——"来自本机"
 * 不等于"就是本工作台这一页"。判据必须含协议与端口，且 Host 缺失不能当作可信。
 *
 * 契约：
 *   · 非写方法（GET/HEAD/OPTIONS）直接放行；本模块只处理 POST/PUT/DELETE/PATCH。
 *   · Host 头必须存在、主机名为本机名、端口等于服务实际监听端口。
 *   · 带 Origin 的浏览器请求：完整比较协议 + 主机 + 端口（端口由 URL 解析，缺省按协议默认端口）。
 *   · 不带 Origin 的非浏览器客户端（curl / dsh 工具 / 插件）：仅校验 Host，
 *     因为它们的"凭据"是宿主注入的能力令牌（X-Novel-Agent-Token），不是浏览器会话。
 *
 * 本模块不持有任何状态，纯函数，可离线断言。
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
export const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Host / Origin 的主机名是否为本机名（大小写不敏感；IPv6 方括号归一）。 */
export function isLocalHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (LOCAL_HOSTNAMES.has(h)) return true;
  // URL 解析后 IPv6 主机名以 `[::1]` 形式给出；手工传入 `::1` 也接受。
  return LOCAL_HOSTNAMES.has(`[${h}]`);
}

/**
 * 解析 Host 头为 { hostname, port }；端口缺省按 HTTP 默认 80。
 * 非法返回 null（调用方必须把它当作拒绝，而不是"没有端口就当 80 放行"）。
 */
export function parseHostHeader(host) {
  const raw = String(host || '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    const hostname = raw.slice(0, end + 1).toLowerCase();
    const rest = raw.slice(end + 1);
    if (!rest) return { hostname, port: 80 };
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? { hostname, port } : null;
  }
  const idx = raw.lastIndexOf(':');
  if (idx >= 0) {
    const port = Number(raw.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: raw.slice(0, idx).toLowerCase(), port };
  }
  return { hostname: raw.toLowerCase(), port: 80 };
}

/**
 * 判定一个写请求是否来自本工作台。
 *
 * @param {{method?:string, headers?:object}} req 只读取 method 与 headers（node:http 的 req 也可）
 * @param {{port:number}} opts port = 服务实际监听端口（server.js 的 PORT）
 * @returns {{ok:boolean, reason?:string, code?:string}}
 */
export function checkWriteOrigin(req, { port } = {}) {
  const method = String((req && req.method) || '').toUpperCase();
  if (!MUTATING_METHODS.has(method)) return { ok: true };
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    // 端口本身不合法时无法做精确比较：拒绝写请求（fail-closed），而不是回退到"只看主机名"。
    return { ok: false, code: 'BAD_LISTEN_PORT', reason: '服务监听端口非法，无法校验来源' };
  }
  const headers = (req && req.headers) || {};
  const hostHeader = String(headers.host || '').trim();
  if (!hostHeader) return { ok: false, code: 'MISSING_HOST', reason: '缺少 Host 头：写请求必须能证明目标就是本工作台' };
  const parsedHost = parseHostHeader(hostHeader);
  if (!parsedHost) return { ok: false, code: 'BAD_HOST', reason: 'Host 头不合法' };
  if (!isLocalHostname(parsedHost.hostname)) {
    return { ok: false, code: 'FOREIGN_HOST', reason: 'Host 不是本机地址（可能是 DNS rebinding）' };
  }
  if (parsedHost.port !== listenPort) {
    return { ok: false, code: 'HOST_PORT_MISMATCH', reason: `Host 端口与工作台端口不一致（Host ${parsedHost.port} ≠ ${listenPort}）` };
  }

  const origin = String(headers.origin || '').trim();
  if (!origin) return { ok: true }; // 非浏览器客户端：Host 已证明目标，身份由能力令牌裁决
  let url;
  try { url = new URL(origin); } catch {
    return { ok: false, code: 'BAD_ORIGIN', reason: 'Origin 不合法' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'BAD_ORIGIN_PROTOCOL', reason: `Origin 协议不支持：${url.protocol}` };
  }
  if (!isLocalHostname(url.hostname)) {
    return { ok: false, code: 'FOREIGN_ORIGIN', reason: 'Origin 不是本机地址' };
  }
  const originPort = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (originPort !== listenPort) {
    return { ok: false, code: 'ORIGIN_PORT_MISMATCH', reason: `跨源写请求被拒绝：Origin 端口 ${originPort} ≠ 工作台端口 ${listenPort}` };
  }
  return { ok: true };
}
