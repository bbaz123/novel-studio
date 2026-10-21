/**
 * turn-stopping 兜底：**只提醒一次**，第二次让任务真实失败（方案 §4.6）。
 *
 * 它不是主触发器：主触发是 Novel Studio 明确启动审计任务 + 任务 prompt 明确要求提交。
 * 它存在的唯一理由：模型有时会在自然语言里说"已完成"却没调用 submit。
 * 因此条件是三重与：有 active audit、run 未终态、本 turn 没有成功 final submit。
 */
export const REMINDER_TEXT = '审计尚未结构化提交；请检查缺失字段并调用 novel_quality_submit(final)。';

/**
 * 纯决策函数（可离线断言）。
 * @returns {{action:'none'|'steer'|'fail', reason:string, text?:string}}
 */
export function decideTurnAction({ active, terminal, finalSubmitted, reminderCount }) {
  if (!active) return { action: 'none', reason: 'NOT_AN_AUDIT' };
  if (terminal) return { action: 'none', reason: 'AUDIT_TERMINAL' };
  if (finalSubmitted) return { action: 'none', reason: 'ALREADY_SUBMITTED' };
  if (Number(reminderCount) >= 1) return { action: 'fail', reason: 'AUDIT_NOT_SUBMITTED' };
  return { action: 'steer', reason: 'REMIND_ONCE', text: REMINDER_TEXT };
}

/**
 * 注册监听器（宿主没有该事件时安全跳过）。
 * 只在本插件被显式装载的 profile 里生效；普通写作任务 env.active=false → 永远 none。
 */
export function registerTurnGuard(ctx, deps) {
  if (!ctx || typeof ctx.on !== 'function') return { registered: false, reason: 'NO_AGENT_EVENT_BUS' };
  try {
    ctx.on('agent/turn-stopping', async (agent) => {
      const env = deps.env || {};
      const state = deps.state || {};
      const decision = decideTurnAction({
        active: Boolean(env.active),
        terminal: Boolean(state.terminal),
        finalSubmitted: Boolean(state.finalSubmitted),
        reminderCount: Number(state.reminderCount) || 0,
      });
      if (decision.action === 'none') return;
      if (decision.action === 'steer') {
        state.reminderCount = (Number(state.reminderCount) || 0) + 1;
        if (agent && typeof agent.steer === 'function') agent.steer(decision.text);
        return;
      }
      // 第二次仍未提交：让任务真实失败，不无限续轮。
      state.terminal = true;
      state.failed = true;
      if (agent && typeof agent.fail === 'function') agent.fail('AUDIT_NOT_SUBMITTED');
    });
    return { registered: true };
  } catch (e) {
    return { registered: false, reason: String(e && e.message || e) };
  }
}
