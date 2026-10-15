/**
 * ai/jobs/queue-store.mjs —— **持久化**分析任务队列（S04）。
 *
 * ── 它替换了什么 ────────────────────────────────────────────────────────────
 * 改造前：`server.js` 里 `temporalAnalysisQueue = new Map()` + `setTimeout`（F01/F03）。
 * 两个后果都是实打实的：
 *   · **重启即丢意图**——进程结束后队列没了，库里也没有任何载体，作者以为任务在排队；
 *   · **定时副作用在保存事务内部**——事务回滚后定时器还活着。
 *
 * 现在：保存事务只写**一行意图**（本模块的 `recordIntent`），
 * 由独立 dispatcher 在事务**外**领取（`claimNext`）并执行。
 * 因此"有没有待分析的任务"变成一个可查询的事实，而不是进程内存里的状态。
 *
 * ── F02：到底是不是 trailing debounce ───────────────────────────────────────
 * 改造前的 `scheduleTemporalAnalysis` 开头是 `if (temporalAnalysisQueue.has(key)) return ...`
 * ——同一章已有待执行任务时**直接返回旧 timer**，所以它是"**第一次**保存后 N 秒跑"，
 * 而不是"**最后一次**保存后 N 秒跑"。停笔越晚，分析越早发生，很容易在作者还在写的时候就跑。
 *
 * 本模块给出两个明确语义，缺一不可：
 *   · `notBeforeMs` 每次保存都往后推（trailing）；
 *   · `deadlineMs` 是**首次**排队时算出的硬上限，怎么推都不会超过它（cap）。
 * 第二条同样重要：只有 trailing 而没有 cap 时，作者持续敲字就能**无限推迟**分析。
 *
 * ── D1 的教训在这里的复现 ───────────────────────────────────────────────────
 * 领取用**行级 CAS**（`UPDATE … WHERE id = ? AND lease_generation = ?`），
 * 回写前校验 `lease_owner + lease_generation`，因此"旧 worker 拿着过期租约回写"会被拒，
 * 而不是覆盖新修订的结果。这正是 D1 那类"读-比-写窗口"的正确形态。
 */

/** 默认参数：与方案稿 §4.1 一致；调用方可以覆盖（测试会用很小的时间值）。 */
export const JOB_DEFAULTS = Object.freeze({
  debounceMs: 15_000,
  maxWaitMs: 300_000,
  leaseMs: 120_000,
});

const openStates = "('queued','running')";

/**
 * 保存时的意图登记（**必须在调用方的事务里执行** —— 它与正文、修订同生共死）。
 *
 * @returns {{task: object, created: boolean, notBeforeMs: number, deadlineMs: number}}
 */
export function recordIntent(db, { workId, chapterId, kind = 'analysis', revisionId = '', payload = {}, nowMs, debounceMs = JOB_DEFAULTS.debounceMs, maxWaitMs = JOB_DEFAULTS.maxWaitMs }) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('recordIntent: 缺少 workId / chapterId');
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const existing = db.prepare(
    `SELECT * FROM story_analysis_tasks WHERE work_id = ? AND chapter_id = ? AND kind = ? AND status IN ${openStates} ORDER BY id DESC LIMIT 1`,
  ).get(w, c, kind);

  const ideal = now + Math.max(0, Number(debounceMs) || 0);
  if (existing) {
    // trailing：每次保存都把"最早可执行时刻"往后推；但不得超过首次排队时定下的硬上限。
    const deadline = Number(existing.max_wait_ms) || (now + Math.max(0, Number(maxWaitMs) || 0));
    const notBefore = Math.min(Math.max(ideal, now), deadline);
    db.prepare(
      `UPDATE story_analysis_tasks
         SET not_before_ms = ?, revision_id = ?, payload_json = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(notBefore, String(revisionId || ''), JSON.stringify(payload || {}), now, existing.id);
    return {
      task: db.prepare('SELECT * FROM story_analysis_tasks WHERE id = ?').get(existing.id),
      created: false,
      notBeforeMs: notBefore,
      deadlineMs: deadline,
    };
  }

  const deadline = now + Math.max(0, Number(maxWaitMs) || 0);
  const notBefore = Math.min(ideal, deadline);
  const info = db.prepare(
    `INSERT INTO story_analysis_tasks
       (work_id, chapter_id, kind, status, revision_id, payload_json, not_before_ms, max_wait_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  ).run(w, c, kind, String(revisionId || ''), JSON.stringify(payload || {}), notBefore, deadline, now, now);
  const id = Number(info.lastInsertRowid);
  return { task: db.prepare('SELECT * FROM story_analysis_tasks WHERE id = ?').get(id), created: true, notBeforeMs: notBefore, deadlineMs: deadline };
}

/**
 * 领取下一个到期任务（**行级 CAS + 租约代际**）。
 *
 * 为什么不是"先 SELECT 再 UPDATE"：
 *   那样两个 dispatcher 会选中同一行，后写者把先写者的租约覆盖掉（D1 的同族缺陷）。
 * 这里先用一条**带条件的 UPDATE** 抢租约，再读回自己那一行；
 * `changes === 1` 才说明这一轮租约真的归我，且 `lease_generation` 已自增
 * —— 旧 worker 回写时会因为代际对不上而被 `finish*` 拒绝。
 *
 * @returns {object|null} 领到的任务行（含本次的 lease_generation / lease_owner），没有到期任务则 null
 */
export function claimNext(db, { owner, nowMs, leaseMs = JOB_DEFAULTS.leaseMs, kind = null, workId = 0 } = {}) {
  const who = String(owner || '').trim();
  if (!who) throw new Error('claimNext: 缺少 owner（租约必须可归属到具体执行者）');
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const clauses = [];
  const args = [];
  if (kind) { clauses.push('AND kind = ?'); args.push(kind); }
  // workId 过滤是**生产需要**（一个实例可能管多部作品），顺带让测试能按作品隔离。
  if (Number(workId)) { clauses.push('AND work_id = ?'); args.push(Number(workId)); }
  const candidate = db.prepare(
    `SELECT id, lease_generation FROM story_analysis_tasks
      WHERE status = 'queued' AND not_before_ms <= ? ${clauses.join(' ')}
      ORDER BY not_before_ms ASC, id ASC LIMIT 1`,
  ).get(now, ...args);
  if (!candidate) return null;
  const info = db.prepare(
    `UPDATE story_analysis_tasks
        SET status = 'running', lease_owner = ?, lease_generation = lease_generation + 1,
            lease_expires_at_ms = ?, attempts = attempts + 1, updated_at_ms = ?
      WHERE id = ? AND status = 'queued' AND lease_generation = ?`,
  ).run(who, now + Math.max(0, Number(leaseMs) || 0), now, candidate.id, candidate.lease_generation);
  if (info.changes !== 1) return null; // 被别的 dispatcher 抢走了：本轮不领任何东西
  const task = db.prepare('SELECT * FROM story_analysis_tasks WHERE id = ?').get(candidate.id);
  db.prepare(
    `INSERT INTO story_analysis_attempts (task_id, lease_owner, lease_generation, status, started_at_ms)
     VALUES (?, ?, ?, 'running', ?)`,
  ).run(task.id, who, task.lease_generation, now);
  return task;
}

/** 续租：只有**当前代际的持有者**能续。 */
export function renewLease(db, { taskId, owner, generation, nowMs, leaseMs = JOB_DEFAULTS.leaseMs }) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const info = db.prepare(
    `UPDATE story_analysis_tasks SET lease_expires_at_ms = ?, updated_at_ms = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND status = 'running'`,
  ).run(now + Math.max(0, Number(leaseMs) || 0), now, Number(taskId) || 0, String(owner || ''), Number(generation) || 0);
  return info.changes === 1;
}

/**
 * 带租约校验的终态写入。**所有**完成/失败路径都必须走这里，
 * 否则旧 worker 就能覆盖新结果（F01 的核心风险）。
 *
 * @returns {{ok: true} | {ok: false, reason: 'FENCED'|'NOT_FOUND'}}
 */
function finishWithFence(db, { taskId, owner, generation, status, error = '', nowMs, transportState = null }) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const info = transportState
    ? db.prepare(
      `UPDATE story_analysis_tasks SET status = ?, last_error = ?, transport_state = ?, lease_owner = '', lease_expires_at_ms = 0, updated_at_ms = ?
        WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND status = 'running'`,
    ).run(status, String(error || ''), transportState, now, Number(taskId) || 0, String(owner || ''), Number(generation) || 0)
    : db.prepare(
      `UPDATE story_analysis_tasks SET status = ?, last_error = ?, lease_owner = '', lease_expires_at_ms = 0, updated_at_ms = ?
        WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND status = 'running'`,
    ).run(status, String(error || ''), now, Number(taskId) || 0, String(owner || ''), Number(generation) || 0);
  if (info.changes !== 1) return { ok: false, reason: 'FENCED' };
  db.prepare(
    `UPDATE story_analysis_attempts SET status = ?, error = ?, finished_at_ms = ?
      WHERE task_id = ? AND lease_generation = ? AND status = 'running'`,
  ).run(status === 'done' ? 'ok' : 'failed', String(error || ''), now, Number(taskId) || 0, Number(generation) || 0);
  return { ok: true };
}

export function finishOk(db, { taskId, owner, generation, nowMs }) {
  return finishWithFence(db, { taskId, owner, generation, status: 'done', nowMs });
}

export function finishFailed(db, { taskId, owner, generation, error = '', nowMs }) {
  return finishWithFence(db, { taskId, owner, generation, status: 'failed', error, nowMs });
}

/** 记录"模型请求可能已经发出"：进 unknown，**不自动重发**（可能已经计费，交作者决定）。 */
export function markUnknown(db, { taskId, owner, generation, error = '', nowMs }) {
  return finishWithFence(db, { taskId, owner, generation, status: 'unknown', error, nowMs, transportState: 'unknown' });
}

/** 标记"请求已发出"（在真正调用模型之前登记，供崩溃后判断能不能安全重发）。 */
export function markSent(db, { taskId, owner, generation, nowMs }) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const info = db.prepare(
    `UPDATE story_analysis_tasks SET transport_state = 'sent', updated_at_ms = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND status = 'running'`,
  ).run(now, Number(taskId) || 0, String(owner || ''), Number(generation) || 0);
  return info.changes === 1;
}

export function cancel(db, { taskId, nowMs }) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const info = db.prepare(
    `UPDATE story_analysis_tasks SET status = 'cancelled', lease_owner = '', lease_expires_at_ms = 0, updated_at_ms = ?
      WHERE id = ? AND status IN ${openStates}`,
  ).run(now, Number(taskId) || 0);
  return info.changes === 1;
}

/**
 * 启动 reconciliation（**只在这里做恢复决策**）。
 *
 * 规划与执行的边界很重要：
 *   · `planReconciliation` 只**读**并给出计划，默认不写（对应将来的 `reconcile-tasks.mjs --dry-run`）；
 *   · `applyReconciliation` 执行计划。
 * 判别依据是 `transport_state`：
 *   · `not_sent` —— 请求肯定没发出去 → 安全回到 `queued`（可以重跑）；
 *   · `sent`     —— 可能已经发出（**可能已经计费**）→ 进 `unknown`，**不自动重发**；
 *   · `unknown`  —— 已经是未知态，保持不动，等作者处理。
 * 这条"不自动重发已发送的请求"是本模块最关键的保守性：
 * 自动重发一个可能已经计费的请求，等于在作者不知情的情况下重复花钱。
 */
export function planReconciliation(db, { nowMs, workId = 0 } = {}) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const wClause = Number(workId) ? 'AND work_id = ?' : '';
  const expired = db.prepare(
    `SELECT * FROM story_analysis_tasks WHERE status = 'running' AND lease_expires_at_ms > 0 AND lease_expires_at_ms <= ? ${wClause} ORDER BY id ASC`,
  ).all(...(Number(workId) ? [now, Number(workId)] : [now]));
  const plan = [];
  for (const t of expired) {
    if (t.transport_state === 'not_sent') plan.push({ taskId: t.id, action: 'requeue', reason: '租约过期且请求未发出 → 可安全重跑' });
    else if (t.transport_state === 'sent') plan.push({ taskId: t.id, action: 'mark_unknown', reason: '租约过期但请求可能已发出（可能已计费）→ 不自动重发' });
    else plan.push({ taskId: t.id, action: 'leave', reason: '已是 unknown → 保持不变，等作者处理' });
  }
  return plan;
}

/** 执行 reconciliation 计划；返回逐条实际结果（`dryRun` 时只回计划）。 */
export function applyReconciliation(db, { nowMs, dryRun = false, workId = 0 } = {}) {
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const plan = planReconciliation(db, { nowMs: now, workId });
  if (dryRun) return plan.map((p) => ({ ...p, applied: false }));
  const out = [];
  for (const p of plan) {
    if (p.action === 'requeue') {
      db.prepare(
        `UPDATE story_analysis_tasks SET status = 'queued', lease_owner = '', lease_expires_at_ms = 0, updated_at_ms = ?
          WHERE id = ? AND status = 'running'`,
      ).run(now, p.taskId);
      db.prepare(`UPDATE story_analysis_attempts SET status = 'abandoned', finished_at_ms = ? WHERE task_id = ? AND status = 'running'`).run(now, p.taskId);
    } else if (p.action === 'mark_unknown') {
      db.prepare(
        `UPDATE story_analysis_tasks SET status = 'unknown', transport_state = 'unknown', lease_owner = '', lease_expires_at_ms = 0, updated_at_ms = ?
          WHERE id = ? AND status = 'running'`,
      ).run(now, p.taskId);
      db.prepare(`UPDATE story_analysis_attempts SET status = 'abandoned', finished_at_ms = ? WHERE task_id = ? AND status = 'running'`).run(now, p.taskId);
    }
    out.push({ ...p, applied: true });
  }
  return out;
}

/** 只读快照（供 dry-run 报告与测试断言）。 */
export function overview(db, { workId = 0 } = {}) {
  const w = Number(workId) || 0;
  const where = w ? 'WHERE work_id = ?' : '';
  const args = w ? [w] : [];
  const rows = db.prepare(`SELECT status, transport_state, COUNT(*) AS n FROM story_analysis_tasks ${where} GROUP BY status, transport_state`).all(...args);
  const out = { total: 0, byStatus: {}, byTransport: {} };
  for (const r of rows) {
    out.total += Number(r.n);
    out.byStatus[r.status] = (out.byStatus[r.status] || 0) + Number(r.n);
    out.byTransport[r.transport_state] = (out.byTransport[r.transport_state] || 0) + Number(r.n);
  }
  return out;
}
