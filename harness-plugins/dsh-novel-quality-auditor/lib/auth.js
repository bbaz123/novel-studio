/**
 * 鉴权与范围：插件侧只做"本地前置检查"，真正的判定在服务端。
 *
 * 为什么本地还要查一次：token 缺失/审计不存在时，直接发请求会得到一个
 * 语义模糊的 401；先查一次能让模型立刻看到"这次任务没有审计身份，别乱试"。
 * 注意：本地检查**不替代**服务端校验，越权判定仍以服务端为准。
 */
import { AuditToolError } from './errors.js';

export function requireActive(env) {
  if (!env.active) {
    throw new AuditToolError('NOT_APPLICABLE', `不是质量审计任务（缺少：${env.missing.join('、') || 'NOVELSTUDIO_MODE'}）`, { status: 0 });
  }
  return env;
}

export function assertKind(env, expected) {
  const want = String(expected || '');
  if (want && String(env.kind) !== want) {
    throw new AuditToolError('AUDIT_PHASE_INVALID', `本次审计是 ${env.kind || '(未知)'}，不能执行 ${want} 专属动作`);
  }
}
