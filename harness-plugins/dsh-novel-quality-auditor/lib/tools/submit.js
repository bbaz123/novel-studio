/**
 * novel_quality_submit —— 结构化提交（唯一完成凭证）。
 *
 * blind_draft：review 的盲审结论；提交后冻结，run 进入 compare。
 * final：review 的对照结论 / revision 的逐项终验。
 *
 * 只有本工具成功返回 ok:true，才算这次审计有产出；自然语言总结不算（PL-09）。
 */
import { requireActive } from '../auth.js';
import { notApplicableText } from '../env.js';
import { assertSubmitArgs } from '../contracts.js';
import { payloadDigest } from '../idempotency.js';

export function submitTool({ client, env, state, idempotency }) {
  return {
    name: 'novel_quality_submit',
    description: [
      '提交审计结果。operation=blind_draft（盲审，review 专用）或 final（对照结论 / 修稿逐项终验）。',
      '服务端会校验 schema、逐字引用、candidate/base hash、coverage 与"已选项是否都有终态"。',
      '相同摘要重复提交是幂等的；不同摘要会被拒绝（AUDIT_RESULT_CONFLICT）。',
      '完成审计必须成功调用 final；这是唯一的完成凭证。',
    ].join('\n'),
    parameters: {
      operation: { type: 'string', description: 'blind_draft 或 final。' },
      payload: { type: 'object', description: '结构化结果对象（见任务 prompt 的字段说明）。' },
    },
    async execute(args = {}) {
      if (!env.active) return notApplicableText(env);
      requireActive(env);
      const check = assertSubmitArgs(args);
      if (!check.ok) return JSON.stringify({ ok: false, code: check.code, message: check.detail });
      if (check.operation === 'blind_draft' && env.kind !== 'review') {
        return JSON.stringify({ ok: false, code: 'AUDIT_PHASE_INVALID', message: 'blind_draft 只适用于 review 审计' });
      }
      if (idempotency.has(check.operation, check.payload)) {
        return JSON.stringify({
          ok: true, audit_id: env.auditId, operation: check.operation,
          idempotent: true, note: '同一份结果已经提交过，本次没有重复发送',
          digest: payloadDigest(check.payload),
        });
      }
      const data = await client.request(`/api/novel/quality-audits/${encodeURIComponent(env.auditId)}/submissions`, {
        method: 'POST',
        body: { operation: check.operation, payload: check.payload },
        timeoutMs: 30000,
      });
      idempotency.remember(check.operation, check.payload);
      if (check.operation === 'blind_draft') state.blindSubmitted = true;
      if (check.operation === 'final') {
        state.finalSubmitted = true;
        state.terminal = true;
      }
      return JSON.stringify({
        ok: true,
        audit_id: data.audit_id,
        operation: check.operation,
        status: data.status,
        idempotent: Boolean(data.idempotent),
        next: check.operation === 'blind_draft'
          ? '盲审已冻结；现在可以读取 initial_review 做逐条对照，然后提交 final。'
          : '已收到；等待 Novel Studio 主机校验与合并。',
      });
    },
  };
}
