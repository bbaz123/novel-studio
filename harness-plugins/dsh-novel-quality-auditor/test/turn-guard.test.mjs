import { createChecks } from '../../../tests/narrative-repair/harness.mjs';
import { decideTurnAction, registerTurnGuard, REMINDER_TEXT } from '../lib/turn-guard.js';

const { check, finish } = createChecks();
const base = { active: true, terminal: false, finalSubmitted: false, reminderCount: 0 };
check('T1', '普通任务（无 active audit）永远不动 turn', decideTurnAction({ ...base, active: false }).action === 'none');
check('T2', '已终态 / 已提交 final：不提醒', decideTurnAction({ ...base, terminal: true }).action === 'none' && decideTurnAction({ ...base, finalSubmitted: true }).action === 'none');
check('T3', '第一次未提交：steer 一次，文案指向 submit(final)',
  decideTurnAction(base).action === 'steer' && decideTurnAction(base).text === REMINDER_TEXT && /novel_quality_submit/.test(REMINDER_TEXT));
check('T4', '第二次仍未提交：真实失败（AUDIT_NOT_SUBMITTED），不无限续轮',
  decideTurnAction({ ...base, reminderCount: 1 }).action === 'fail'
    && decideTurnAction({ ...base, reminderCount: 1 }).reason === 'AUDIT_NOT_SUBMITTED'
    && decideTurnAction({ ...base, reminderCount: 9 }).action === 'fail');
check('T5', '宿主没有事件总线时安全跳过', registerTurnGuard({}, {}).registered === false);
let t6 = false;
{
  // ⚠️ 不能把 async 函数直接交给 check：Promise 恒真，会变成假绿。
  let handler = null; const events = [];
  const ctx = { on(evt, fn) { events.push(evt); handler = fn; } };
  const state = { reminderCount: 0, finalSubmitted: false, terminal: false };
  const r = registerTurnGuard(ctx, { env: { active: true }, state });
  const steered = [];
  await handler({ steer: (t) => steered.push(t), fail: (c) => steered.push('FAIL:' + c) });
  await handler({ steer: (t) => steered.push(t), fail: (c) => steered.push('FAIL:' + c) });
  t6 = r.registered && events.join(',') === 'agent/turn-stopping'
    && steered.length === 2 && steered[0] === REMINDER_TEXT && steered[1] === 'FAIL:AUDIT_NOT_SUBMITTED';
}
check('T6', '有事件总线时只注册 turn-stopping，并在第二次调用 fail', t6);
finish('turn 兜底');
