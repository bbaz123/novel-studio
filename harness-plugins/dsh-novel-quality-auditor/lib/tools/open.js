/**
 * novel_quality_open —— 打开本次审计，返回资源清单（**不含正文**）。
 * 为什么不在 open 里返回正文：几万字会挤爆上下文，而且无法证明"全文被读过"。
 * 正文必须通过 novel_quality_read 分页读取（有覆盖记录）。
 */
import { requireActive } from '../auth.js';
import { notApplicableText } from '../env.js';

export function openTool({ client, env }) {
  return {
    name: 'novel_quality_open',
    description: [
      '打开本次质量审计，返回资源清单（名称/字数/hash/页数）与当前阶段。',
      '不会返回正文：正文请用 novel_quality_read 分页读取。',
      '普通写作任务（没有审计环境）返回 NOT_APPLICABLE。',
    ].join('\n'),
    parameters: {
      audit_id: { type: 'string', description: '可选：必须与本次任务注入的 audit_id 一致；不一致会被拒绝。' },
    },
    async execute(args = {}) {
      if (!env.active) return notApplicableText(env);
      requireActive(env);
      const claimed = String(args.audit_id || '').trim();
      if (claimed && claimed !== env.auditId) {
        return JSON.stringify({ ok: false, code: 'AUDIT_SCOPE_MISMATCH', message: `本次任务绑定的是 ${env.auditId}，不能打开 ${claimed}` });
      }
      const data = await client.request(`/api/novel/quality-audits/${encodeURIComponent(env.auditId)}/input-manifest`, { timeoutMs: 20000 });
      return JSON.stringify({
        ok: true,
        audit_id: data.audit_id,
        kind: data.kind,
        phase: data.phase,
        contract_version: data.contract_version,
        resources: data.resources,
        required_outputs: data.required_outputs,
        next: data.phase === 'blind'
          ? '先读 article/blueprint/context，提交 blind_draft；提交前不要尝试读 initial_review。'
          : '可以读 initial_review 做逐条对照，然后提交 final。',
      });
    },
  };
}
