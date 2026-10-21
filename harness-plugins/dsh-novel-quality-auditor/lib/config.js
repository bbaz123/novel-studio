/**
 * 插件配置：只接受 baseUrl 这种"安装期"设置；审计身份一律来自环境变量。
 * 为什么把两者分开：baseUrl 可以写进 profile patch（安装时确定），
 * 而 audit_id/token 是**每次任务**的，写进配置就等于把它们持久化到磁盘。
 */
export const DEFAULTS = Object.freeze({ baseUrl: 'http://127.0.0.1:3737', requestTimeoutMs: 20000 });

export function normalizeConfig(config = {}) {
  return {
    baseUrl: String((config && config.baseUrl) || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    requestTimeoutMs: Number(config && config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : DEFAULTS.requestTimeoutMs,
  };
}
