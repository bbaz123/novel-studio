/**
 * 运行环境：审计身份只从**环境变量**来（未知则明确不可用）。
 *
 * 为什么不在工具参数里收 audit_id/token：那会让模型有机会"自选一个审计"，
 * 与"一次子进程只服务一次审计"的边界冲突。范围由启动器注入，插件只读。
 */
const REQUIRED = ['NOVELSTUDIO_AUDIT_ID', 'NOVELSTUDIO_AUDIT_TOKEN', 'NOVELSTUDIO_AUDIT_KIND'];

export function readEnv(env = process.env) {
  const auditId = String(env.NOVELSTUDIO_AUDIT_ID || '').trim();
  const auditToken = String(env.NOVELSTUDIO_AUDIT_TOKEN || '').trim();
  const kind = String(env.NOVELSTUDIO_AUDIT_KIND || '').trim();
  // 不用默认值：任务注入的地址优先于安装期 config（多实例/隔离实例时不能回落 3737）。
  const baseUrl = String(env.NOVELSTUDIO_BASE_URL || '').replace(/\/+$/, '');
  const mode = String(env.NOVELSTUDIO_MODE || '').trim();
  const missing = REQUIRED.filter((k) => !String(env[k] || '').trim());
  return {
    auditId, auditToken, kind, baseUrl, mode,
    workId: String(env.NOVELSTUDIO_WORK_ID || '').trim(),
    chapterId: String(env.NOVELSTUDIO_CHAPTER_ID || '').trim(),
    active: mode === 'quality_audit' && !missing.length,
    missing,
  };
}

/** 普通写作任务（没有 audit env）时工具必须 NOT_APPLICABLE，不干扰 novel-writing。 */
export function notApplicableText(env) {
  return JSON.stringify({
    ok: false,
    applicable: false,
    code: 'NOT_APPLICABLE',
    message: '当前任务不是质量审计（缺少 NOVELSTUDIO_MODE=quality_audit 或审计身份）：novel_quality_* 工具不可用。普通写作任务请继续使用 novel_* 工具。',
    missing: env.missing,
  });
}
