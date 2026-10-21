/**
 * novel_quality_status —— 只读状态：还缺什么、上次错误是什么。
 * 给模型一个"自查"入口，避免它靠猜"是不是已经成功"。
 */
import { requireActive } from '../auth.js';
import { notApplicableText } from '../env.js';

export function statusTool({ client, env, state }) {
  return {
    name: 'novel_quality_status',
    description: '只读：返回本次审计的状态、阶段、缺失要求与上次错误。不会推进状态。',
    parameters: {},
    async execute() {
      if (!env.active) return notApplicableText(env);
      requireActive(env);
      const data = await client.request(`/api/novel/quality-audits/${encodeURIComponent(env.auditId)}/status`);
      state.terminal = Boolean(data.terminal);
      return JSON.stringify({
        ok: true,
        audit_id: data.audit_id,
        kind: data.kind,
        status: data.status,
        status_label: data.status_label,
        phase: data.phase,
        missing_requirements: data.missing_requirements,
        last_error: data.last_error,
        counts: data.counts,
        terminal: data.terminal,
        local_state: { blind_submitted: Boolean(state.blindSubmitted), final_submitted: Boolean(state.finalSubmitted) },
      });
    },
  };
}
