/**
 * ai/quality-auditor/harness-task.mjs —— 启动一次 DSH 审计任务（真实子进程）。
 *
 * 与 novel-writing 的写作任务共用同一个 spawn 出口（`harness.js` 的
 * `runHarnessTaskWithProgress`），因此继承它已有的：专用 DSH_HOME、profile、超时与进程树终止、
 * 环境变量白名单、以及"任务文本走 argv 还是 stdin"的长度处理。
 *
 * 这里只多做一件事：把本次审计的**一次性 token** 与范围注入子进程环境。
 * 注意：token 只在环境里，不进命令行、不进日志。
 */
import { runHarnessTaskWithProgress } from '../../harness.js';
import { MODELS, effortForTier } from '../policy.mjs';
import { auditTaskPrompt } from './prompts.mjs';

/**
 * 子进程环境（方案 §8.1 的变量名逐字实现）。
 * @returns {Record<string,string>}
 */
export function auditChildEnv({ auditId, auditToken, kind, workId, chapterId, baseUrl, extraEnv = {} }) {
  return {
    NOVELSTUDIO_MODE: 'quality_audit',
    NOVELSTUDIO_AUDIT_ID: String(auditId || ''),
    NOVELSTUDIO_AUDIT_TOKEN: String(auditToken || ''),
    NOVELSTUDIO_AUDIT_KIND: String(kind || ''),
    NOVELSTUDIO_WORK_ID: String(workId == null ? '' : workId),
    NOVELSTUDIO_CHAPTER_ID: String(chapterId == null ? '' : chapterId),
    NOVELSTUDIO_BASE_URL: String(baseUrl || 'http://127.0.0.1:3737').replace(/\/+$/, ''),
    NOVELSTUDIO_DSH_PROFILE: String(process.env.NOVELSTUDIO_DSH_PROFILE || 'novel'),
    ...extraEnv,
  };
}

/**
 * 跑一次审计任务。**不判定成功** —— 成功与否只看 Novel Studio 账本里是否收到 final 提交
 * （方案 §8.2）。这里返回子进程的输出尾部，只用于诊断。
 */
export async function runNovelQualityAuditTask({
  auditId, auditToken, kind, workId, chapterId, baseUrl,
  timeoutMs, signal, onChunk, env, repairHint = '',
} = {}) {
  const base = auditTaskPrompt({ kind });
  // 第二次尝试（契约修复）追加一句：只针对**格式**，不改变审计结论。
  const prompt = repairHint ? base + String.fromCharCode(10, 10) + '【格式修复】' + repairHint : base;
  const startedAt = Date.now();
  try {
    const output = await runHarnessTaskWithProgress(prompt, {
      timeout: timeoutMs,
      model: MODELS.quality || MODELS.fast,
      reasoning_effort: effortForTier ? effortForTier('quality') : undefined,
      env: auditChildEnv({ auditId, auditToken, kind, workId, chapterId, baseUrl, extraEnv: env }),
      signal,
    }, onChunk);
    return { ok: true, output: String(output == null ? '' : output), durationMs: Date.now() - startedAt };
  } catch (e) {
    return {
      ok: false,
      error_code: e && e.code ? String(e.code) : 'HARNESS_FAILED',
      // 把**子进程 stderr 尾部**一起带回：审计失败时"进程退出 1"本身没有诊断价值，
      // 真正的信息在 dsh 打出来的那一行（例如配置/模型/工具错误）。
      error_message: [
        e && e.message ? String(e.message) : String(e),
        e && e.stderr ? `stderr: ${String(e.stderr).slice(-800)}` : '',
        e && e.stdoutTail ? `stdout: ${String(e.stdoutTail).slice(-400)}` : '',
      ].filter(Boolean).join(' | '),
      durationMs: Date.now() - startedAt,
    };
  }
}
