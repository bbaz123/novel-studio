/**
 * server/services/projection-outbox.mjs —— 投影 outbox 的租约、认领与排空（P12，2026-10-18）。
 *
 * 抽出来的原因（与 P17 的方向一致，但这一步是**缺陷修复的必需层**，不是架构重写）：
 *   · 「认领 / 完成 / 失败 / 恢复」这四件事的判据必须能被离线断言；
 *   · server.js 里它们与 syncWorkFull、日志、HTTP 缠在一起，只能靠"起一个真实例 + 真外部服务"
 *     观察——而外部服务不可用时，队列的真实行为（是否会串行覆盖、是否会永久悬挂）根本测不到。
 *
 * 契约：
 *   · pending → running 是**条件更新**（`WHERE id = ? AND status = 'pending'`）：并发认领只有一方成功；
 *   · done / failed 必须带**同一个 worker_token** 才能写回：崩溃前的旧 worker 不能覆盖新 worker 的结果；
 *   · running 项带 `lease_expires_at`；租约过期后由重启路径 `recoverStale()` 复位为 pending；
 *   · `drain()` 连续分批推进，直到「无 pending / 预算用尽 / 某批没有推进（外部失败退避）」——
 *     不忙循环，也不会因为一次只处理 5 条而让 50/100 条队列永远排不空。
 */
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_RETRY = 5;

/** @returns {{claim: Function, recoverStale: Function, markDone: Function, markFailed: Function, summary: Function, drain: Function}} */
export function createProjectionOutbox({ db, workerToken, leaseMs = DEFAULT_LEASE_MS, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('createProjectionOutbox: 需要 db（node:sqlite DatabaseSync 或同形状对象）');
  if (!workerToken) throw new Error('createProjectionOutbox: 需要 workerToken');
  const q = (sql) => db.prepare(sql);
  const lease = Math.max(1000, Number(leaseMs) || DEFAULT_LEASE_MS);

  /** 原子认领一条 pending；没有可领的返回 null。竞争失败会重新挑选（最多 5 次）。 */
  function claim() {
    for (let i = 0; i < DEFAULT_RETRY; i += 1) {
      const row = q(`SELECT * FROM projection_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT 1`).get();
      if (!row) return null;
      const expiresAt = new Date(Date.now() + lease).toISOString();
      const info = q(`
        UPDATE projection_outbox SET status = 'running', worker_token = ?, lease_expires_at = ?,
          attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(workerToken, expiresAt, now(), row.id);
      if (Number(info.changes) === 1) {
        return { ...row, worker_token: workerToken, lease_expires_at: expiresAt, attempts: (Number(row.attempts) || 0) + 1 };
      }
    }
    return null;
  }

  /** 租约过期的 running → pending（崩溃/被杀后的唯一恢复入口）。 */
  function recoverStale() {
    const stamp = now();
    const info = q(`
      UPDATE projection_outbox
      SET status = 'pending', worker_token = '', lease_expires_at = '',
          last_error = CASE WHEN last_error = '' THEN '进程崩溃时处于 running（租约过期，已重新排队）' ELSE last_error END,
          updated_at = ?
      WHERE status = 'running' AND (lease_expires_at = '' OR lease_expires_at <= ?)
    `).run(stamp, stamp);
    return Number(info.changes) || 0;
  }

  /** 带 token 的完成写入；token 不符返回 0（调用方如实报 stale，不覆盖别人）。 */
  function markDone(id, token) {
    const info = q(`
      UPDATE projection_outbox SET status = 'done', last_error = '', worker_token = '', lease_expires_at = '', updated_at = ?
      WHERE id = ? AND worker_token = ? AND status = 'running'
    `).run(now(), Number(id), String(token || ''));
    return Number(info.changes) || 0;
  }

  /** 带 token 的失败写入（last_error 可见、可 retry）。 */
  function markFailed(id, token, message) {
    const info = q(`
      UPDATE projection_outbox SET status = 'failed', last_error = ?, worker_token = '', lease_expires_at = '', updated_at = ?
      WHERE id = ? AND worker_token = ? AND status = 'running'
    `).run(String(message || '').slice(0, 500), now(), Number(id), String(token || ''));
    return Number(info.changes) || 0;
  }

  /** 状态计数（workId=0 时统计全库）。 */
  function summary(workId = 0) {
    const rows = Number(workId) > 0
      ? q('SELECT status, COUNT(*) AS n FROM projection_outbox WHERE work_id = ? GROUP BY status').all(Number(workId))
      : q('SELECT status, COUNT(*) AS n FROM projection_outbox GROUP BY status').all();
    const by = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of rows) by[r.status] = Number(r.n) || 0;
    return by;
  }

  /**
   * 连续分批排空。
   * @param {{run:(row:object)=>Promise<void>, limit?:number, budgetMs?:number}} opts
   *        run 抛错 = 该条失败（记 failed 并停止本批，等下次 retry / 周期）
   */
  async function drain({ run, limit = 5, budgetMs = 0 } = {}) {
    if (typeof run !== 'function') throw new Error('drain: 需要 run(row)');
    const results = [];
    const max = Math.max(1, Number(limit) || 5);
    const deadline = Number(budgetMs) > 0 ? Date.now() + Number(budgetMs) : 0;
    for (let i = 0; i < max; i += 1) {
      if (deadline && Date.now() > deadline) { results.push({ id: 0, ok: false, deferred: true }); break; }
      const row = claim();
      if (!row) break;
      try {
        await run(row);
        const n = markDone(row.id, row.worker_token);
        results.push(n === 1 ? { id: row.id, ok: true } : { id: row.id, ok: false, stale: true, error: '租约已失效（另一个 worker 已接管），本轮结果不写回' });
      } catch (e) {
        const message = String((e && e.message) || e || '投影失败').slice(0, 500);
        const n = markFailed(row.id, row.worker_token, message);
        results.push(n === 1 ? { id: row.id, ok: false, error: message } : { id: row.id, ok: false, stale: true, error: message });
        break; // 外部失败：不在同一批里继续重试，交给 retry / 下个周期
      }
    }
    return { drained: results.length, results, pending: summary().pending, failed: summary().failed };
  }

  return { claim, recoverStale, markDone, markFailed, summary, drain, workerToken };
}

/**
 * 连续分批调度（在 drain 之上）：无 pending / 预算用尽 / 无推进 时停止。
 * 每批之间让出事件循环，避免长时间占满 CPU 或死锁 SQLite 写锁。
 */
export async function drainUntilIdle(outbox, { run, budgetMs = 20_000, batch = 25 } = {}) {
  outbox.recoverStale();
  const started = Date.now();
  let drained = 0;
  let stopped = 'idle';
  while (Date.now() - started < budgetMs) {
    if (outbox.summary().pending === 0) { stopped = 'drained'; break; }
    const r = await outbox.drain({ run, limit: batch, budgetMs: Math.max(1000, budgetMs - (Date.now() - started)) });
    drained += r.drained;
    if (outbox.summary().pending === 0) { stopped = 'drained'; break; }
    if (r.drained === 0) { stopped = 'no-progress'; break; }
    if ((r.results || []).some((x) => x.ok === false && !x.deferred)) { stopped = 'backoff'; break; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const s = outbox.summary();
  return { drained, stopped, pending: s.pending, failed: s.failed, elapsed_ms: Date.now() - started };
}
