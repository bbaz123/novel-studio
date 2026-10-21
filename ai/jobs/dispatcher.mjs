/**
 * ai/jobs/dispatcher.mjs —— 持久化分析队列的**执行侧**（S04）。
 *
 * ── 它补上 F01/F02/F03 的第二半 ────────────────────────────────────────────
 * `queue-store.mjs` 只提供"载体"（意图落库、领取、租约、reconciliation）。
 * 真正的修复要在这里：**执行不再由保存事务里的 setTimeout 驱动**，
 * 而是由本模块在事务**外**领取到期任务并执行。于是：
 *   · 进程重启 → 意图还在库里（F01 的载体），启动 reconciliation 后能继续跑；
 *   · 防抖由 `not_before_ms` 决定（F02），不是"第一次保存后的 timer"；
 *   · 保存事务只写意图，不再产生定时副作用（F03）。
 *
 * ── 为什么把"领取 → 执行 → 回写"写成一个 `tick()` ──────────────────────────
 * 定时循环很难测：真实的 `setInterval` 会让测试变成"等一会儿看看"。
 * 所以把一次完整动作收成一个**纯异步函数**：它自己跑完"领一个 → 执行 → 回写"，
 * 返回结构化结果。测试可以直接 `await tick()`，不必等真实时钟；
 * 生产循环只是"隔一段时间 tick 一次"的薄壳。
 *
 * ── 不自动重发 ─────────────────────────────────────────────────────────────
 * 执行**之前**先 `markSent`（登记"请求可能已经发出"）。若进程在模型调用中崩溃，
 * reconciliation 会把这条任务判成 `unknown` 而**不是**回 queued——
 * 自动重发一个可能已计费的真实模型请求，等于在作者不知情的情况下重复花钱。
 */
import * as Q from './queue-store.mjs';

/** 一次 tick 的可能结果（全部结构化，便于断言与日志）。 */
export const TICK = Object.freeze({
  IDLE: 'idle',                 // 没有到期任务
  DONE: 'done',                 // 领到并成功执行
  FAILED: 'failed',             // 领到但执行失败（已回写 failed）
  FENCED: 'fenced',             // 执行完了但租约已被别人接管 → 回写被拒（丢弃结果，不覆盖）
  NO_HANDLER: 'no_handler',     // 领到了但没有对应 kind 的执行器 → 记 failed（不静默丢）
  REARMED: 'rearmed',           // 执行器说"等新修订"（stale 等）→ 回到 queued 推迟重试，**不当作完成**
  NOT_RUN: 'not_run',           // 未运行（无模型配置 / 关闭自动分析）→ 如实记录，不宣称 AI 成功
});

/**
 * R2（2026-10-16 修）：**唯一的执行结果分类函数**。
 *
 * 修改前 tick() 只对 stale/no_content/running 做特殊处理，**其余返回一律 `finishOk`** ——
 * 于是 `{ ok:false, status:'failed', reason:'provider unavailable' }` 会被记成 **done**。
 * 尤其危险的是 `finishAnalysis()` 用 `{ ok:true, status:'failed' }` 表示"失败状态**记录成功写入**"，
 * 那个 `ok` 是"写入成功"，**不是"分析成功"**。
 *
 * 这里把"业务结果"与"传输状态"分开：
 *   · done        → 真的分析成功（才允许 finishOk）
 *   · wait        → 等新修订（stale / running / no_content）→ rearm，**不算完成**
 *   · not_run     → 未运行（无模型配置 / 作者关闭自动分析）→ 如实记录，不宣称 AI 成功
 *   · failed      → 业务失败（ok:false 或 status:failed）→ finishFailed
 *   · unknown     → 结果不可判定 → 保守失败，保留可诊断摘要（禁止静默当成功）
 */
export function classifyResult(result) {
  if (!result || typeof result !== 'object') return { kind: 'unknown', reason: '执行器没有返回结构化结果' };
  const status = String(result.status || '');
  if (status === 'done' && result.ok === true) return { kind: 'done' };
  if (status === 'stale' || status === 'running' || status === 'no_content') return { kind: 'wait', reason: status };
  if (status === 'not_run') return { kind: 'not_run', reason: String(result.reason || '未运行') };
  if (status === 'failed' || result.ok === false) return { kind: 'failed', reason: String(result.reason || status || '执行器报告失败') };
  if (status === 'unknown') return { kind: 'unknown', reason: String(result.reason || '结果不可判定') };
  // 未知 status / 空结果：**保守失败**，不允许静默当成功。
  return { kind: 'unknown', reason: `无法识别的执行结果 status=${JSON.stringify(status)} ok=${JSON.stringify(result.ok)}` };
}

/**
 * @param {object} deps
 * @param {object} deps.db            数据库句柄（注入，便于测试）
 * @param {(task: object, ctx: object) => Promise<any>} deps.runAnalysis
 * @param {(task: object, ctx: object) => Promise<any>} [deps.runImpact]
 * @param {string} [deps.owner]       租约归属名（默认带 pid，便于区分进程）
 * @param {() => number} [deps.now]   时钟（默认 Date.now；测试可注入假时钟）
 * @param {(e: object) => void} [deps.log]
 */
export function createDispatcher({ db, runAnalysis, runImpact = null, owner = `dispatcher-${process.pid}`, now = Date.now, log = () => {} } = {}) {
  if (!db) throw new Error('createDispatcher: 缺少 db');
  if (typeof runAnalysis !== 'function') throw new Error('createDispatcher: 缺少 runAnalysis');
  const handlers = { analysis: runAnalysis, ...(runImpact ? { impact: runImpact } : {}) };

  /**
   * 领一个到期任务并执行完（含回写）。**一次只做一个**，便于串行与断言。
   * @returns {Promise<{outcome: string, taskId?: number, detail?: string}>}
   */
  async function tick({ kind = null, workId = 0, leaseMs, maxAttempts = 5, rearmDelayMs = 1500 } = {}) {
    const t0 = Number(now());
    const task = Q.claimNext(db, { owner, nowMs: t0, leaseMs, kind, workId });
    if (!task) return { outcome: TICK.IDLE };

    const ctx = { owner, generation: task.lease_generation, taskId: task.id, attempt: task.attempts };
    const handler = handlers[task.kind];
    if (!handler) {
      // 领到了却没有执行器：必须**留痕**，不能静默丢弃（否则任务会一直卡在 running）。
      const res = Q.finishFailed(db, { taskId: task.id, owner, generation: task.lease_generation, error: `NO_HANDLER:${task.kind}`, nowMs: Number(now()) });
      return { outcome: res.ok ? TICK.NO_HANDLER : TICK.FENCED, taskId: task.id, detail: `无执行器：${task.kind}` };
    }

    // 先登记"可能已发出"：此后若崩溃，reconciliation 判 unknown 而不是重发。
    // R4/§6.2-4：markSent 失败（租约已易主）时**必须停止**，不能再打真实模型调用。
    const sentOk = Q.markSent(db, { taskId: task.id, owner, generation: task.lease_generation, nowMs: Number(now()) });
    if (!sentOk) {
      return { outcome: TICK.FENCED, taskId: task.id, detail: 'markSent 被拒（租约已易主）：未发起模型调用' };
    }

    try {
      const result = await handler(task, ctx);
      const verdict = classifyResult(result);

      // ── 「等新修订」不是完成，而是**重新武装**（R2/R3）────────────────────────
      if (verdict.kind === 'wait') {
        const attempts = Number(task.attempts) || 0;
        if (attempts >= maxAttempts) {
          const exhausted = Q.finishFailed(db, { taskId: task.id, owner, generation: task.lease_generation, error: `REARM_EXHAUSTED:${verdict.reason}`, nowMs: Number(now()) });
          return { outcome: exhausted.ok ? TICK.FAILED : TICK.FENCED, taskId: task.id, detail: `等待新修订超过 ${maxAttempts} 次（${verdict.reason}）` };
        }
        // R3：not_before 只往后不提前；R4：复位本轮传输态。判定失败即 FENCED，不虚报 REARMED。
        const r = Q.rearm(db, { taskId: task.id, owner, generation: task.lease_generation, nowMs: Number(now()), rearmDelayMs });
        if (!r.ok) return { outcome: TICK.FENCED, taskId: task.id, detail: r.reason };
        // 2026-10-21：已经有更新的 queued 时，本轮不能也回 queued（唯一索引），
        // 于是它按"被取代"收尾 —— 意图仍在队列里（那条 queued），不能报成 FENCED/FAILED。
        return {
          outcome: TICK.REARMED,
          taskId: task.id,
          detail: r.superseded ? `${verdict.reason} → 已由更新的排队任务 #${r.supersededBy} 取代` : verdict.reason,
        };
      }

      // ── 「未运行」：如实记录，**不宣称 AI 分析成功**（R2）──────────────────────
      if (verdict.kind === 'not_run') {
        const res = Q.finishFailed(db, { taskId: task.id, owner, generation: task.lease_generation, error: `NOT_RUN:${verdict.reason}`, nowMs: Number(now()) });
        return { outcome: res.ok ? TICK.NOT_RUN : TICK.FENCED, taskId: task.id, detail: verdict.reason };
      }

      // ── 失败 / 不可判定：保守失败，保留可诊断摘要（R2）────────────────────────
      if (verdict.kind === 'failed' || verdict.kind === 'unknown') {
        const res = Q.finishFailed(db, { taskId: task.id, owner, generation: task.lease_generation, error: `${verdict.kind.toUpperCase()}:${verdict.reason}`, nowMs: Number(now()) });
        log({ level: 'warn', kind: 'job_failed', message: `分析任务未成功（${verdict.kind}）：${verdict.reason}`, context: { task_id: task.id } });
        return { outcome: res.ok ? TICK.FAILED : TICK.FENCED, taskId: task.id, detail: verdict.reason };
      }

      // verdict.kind === 'done'：只有明确成功才写 done。
      const res = Q.finishOk(db, { taskId: task.id, owner, generation: task.lease_generation, nowMs: Number(now()) });
      if (!res.ok) {
        // 执行成功了，但租约已被接管（例如执行期间超时被 reconciliation 收走）→ 丢弃结果。
        // 这就是 fencing 的意义：不让"过期的成功"覆盖新状态。
        log({ level: 'warn', kind: 'job_fenced', message: `任务 ${task.id} 回写被拒（租约已过期或易主）`, context: { task_id: task.id, generation: task.lease_generation } });
        return { outcome: TICK.FENCED, taskId: task.id, detail: res.reason };
      }
      return { outcome: TICK.DONE, taskId: task.id, detail: String(result.status || 'done') };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const res = Q.finishFailed(db, { taskId: task.id, owner, generation: task.lease_generation, error: msg, nowMs: Number(now()) });
      log({ level: 'warn', kind: 'job_failed', message: `分析任务失败：${msg}`, context: { task_id: task.id } });
      return { outcome: res.ok ? TICK.FAILED : TICK.FENCED, taskId: task.id, detail: msg };
    }
  }

  /**
   * 连续 tick 直到没有到期任务（有上限，避免一批积压把进程占死）。
   * @returns {Promise<{processed: number, outcomes: string[]}>}
   */
  async function drain({ max = 20, kind = null, workId = 0 } = {}) {
    const outcomes = [];
    for (let i = 0; i < max; i += 1) {
      const r = await tick({ kind, workId });
      if (r.outcome === TICK.IDLE) break;
      outcomes.push(r.outcome);
    }
    return { processed: outcomes.length, outcomes };
  }

  return { owner, tick, drain };
}

/**
 * 启动时的**清障**：先 reconciliation，再把恢复出来的任务交给 dispatcher。
 *
 * 顺序很重要——必须先 reconciliation 再开始 tick，
 * 否则过期租约的 `running` 任务永远不被重新领取（`claimNext` 只取 `queued`）。
 *
 * @returns {{plan: object[], applied: object[]}}
 */
export function reconcileOnStart(db, { now, workId = 0 } = {}) {
  const nowMs = typeof now === 'function' ? Number(now()) : Number(now);
  const plan = Q.planReconciliation(db, { nowMs, workId });
  const applied = plan.length ? Q.applyReconciliation(db, { nowMs, workId }) : [];
  return { plan, applied };
}
