/**
 * ai/quality-auditor/security.mjs —— 审计 API 的**本机边界**与一次性 token。
 *
 * 威胁模型（方案 §7.1）：
 *   · 审计 API 只应被本机的 Novel Studio 与它拉起的 DSH 子进程访问；
 *   · token 只注入那一个子进程的环境，数据库只保存 hash；
 *   · 比较必须 timing-safe（避免用响应时间猜 token）；
 *   · 跨作品读取要拒绝（token 绑定 work_id/chapter_id/operation）。
 *
 * 为什么 Host/Origin 也要查：服务只监听回环地址并不阻止 DNS rebinding ——
 * 浏览器里的恶意页面可以把 `evil.example` 解析到 127.0.0.1，然后用非本机 Origin 发请求。
 * 本机策略 + token 双层，才是"外部页面拿不到正文"的实际保证。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from './contracts.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/** 从 `host[:port]` 取出主机名；IPv6 字面量保留方括号。 */
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(0, end + 1) : raw;
  }
  const colon = raw.lastIndexOf(':');
  return colon > 0 && /^\d+$/.test(raw.slice(colon + 1)) ? raw.slice(0, colon) : raw;
}

export function isLocalHostHeader(hostHeader) {
  const h = hostnameOf(hostHeader);
  return LOCAL_HOSTS.has(h);
}

/** Origin 为空（同源请求/非浏览器客户端）按本机处理；有值必须是本机。 */
export function isLocalOrigin(originHeader) {
  const raw = String(originHeader || '').trim();
  if (!raw) return true;
  if (raw === 'null') return false;
  try {
    const u = new URL(raw);
    return LOCAL_HOSTS.has(u.hostname.toLowerCase()) && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

/**
 * 审计相关请求的本机校验。
 * @returns {{ok:true}|{ok:false, code:string, detail:string}}
 */
export function checkAuditRequest(req) {
  const host = req && req.headers ? req.headers.host : '';
  const origin = req && req.headers ? req.headers.origin : '';
  if (!isLocalHostHeader(host)) {
    return { ok: false, code: ERROR_CODES.AUDIT_FORBIDDEN_ORIGIN, detail: `Host 非本机：${String(host || '(空)').slice(0, 80)}` };
  }
  if (!isLocalOrigin(origin)) {
    return { ok: false, code: ERROR_CODES.AUDIT_FORBIDDEN_ORIGIN, detail: `Origin 非本机：${String(origin).slice(0, 120)}` };
  }
  return { ok: true };
}

/** 32 字节随机 token（base64url，无填充）。 */
export function createAuditToken() {
  return randomBytes(32).toString('base64url');
}

/** 数据库只存这个。 */
export function tokenDigest(token) {
  return 'sha256:' + createHash('sha256').update(String(token == null ? '' : token), 'utf8').digest('hex');
}

/** timing-safe 比较两个 hex/base64 字符串；长度不同直接 false（长度本身不敏感）。 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

/** 校验 token digest 是否匹配（不抛错、不记录 token 本身）。 */
export function tokenMatches(expectedDigest, presentedToken) {
  if (!expectedDigest) return false;
  return safeEqual(expectedDigest, tokenDigest(presentedToken));
}

/** token 是否过期（ISO 字符串；空串视为无期限，由调用方决定是否允许）。 */
export function tokenExpired(expiresAt, now = Date.now()) {
  const s = String(expiresAt || '').trim();
  if (!s) return false;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return true;
  return t <= now;
}
