/**
 * tests/nsdsh/task-fencing.test.mjs —— R1–R4 的回归断言（S04，2026-10-16）。
 *
 * 这四条是缺陷压缩包独立发现的 S04 **实现**缺陷（不在原 19 条台账里），
 * 它们都属于"队列自己把意图搞丢/把失败当成功"这类**静默**错误 ——
 * 所以每条都必须有"修复前失败、修复后通过"的行为断言，不能靠读码确认。
 *
 *   R1 运行中任务被改写 → 旧 worker 完成后把已代表新修订的行标 done → 新修订从未执行
 *   R2 执行器返回失败对象，却被记作 done
 *   R3 重排把已经延后的防抖截止时间**提前**
 *   R4 重排不重置传输态 → 新一轮尚未发送却按"上一轮已 sent"进 unknown
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from '../temporal/harness.mjs';

isolatedDir('nsdsh-task-fencing-');
const { db } = await import('../../db.js');
const Q = await import('../../ai/jobs/queue-store.mjs');
const D = await import('../../ai/jobs/dispatcher.mjs');

let seedSeq = 0;
function seed() {
  seedSeq += 1;
  const nowIso = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(`fencing-${seedSeq}`, nowIso, nowIso);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workId, '第1章', '<p>x</p>', 0, nowIso, nowIso);
  const chapterId = Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
  return { workId, chapterId };
}

/** 假时钟：显式推进，绝不依赖真实时间。 */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, add: (d) => { t += d; return t; } };
}

const T0 = 1_000_000;

suite('nsdsh/task-fencing', [
  // ── R1：running 不可变；新修订另建 queued；旧 worker 不得吞掉它 ──────────────
  ['R1-01 分析 A 时保存 B：B 必须是独立 queued，且 A 完成不得把 B 标成 done', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const a = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 10_000 });
    assert.equal(a.revision_id, 'revA', '前置：A 已领取');

    // 保存 B —— running 的 A **不得**被改写
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revB', nowMs: T0 + 10, debounceMs: 0, maxWaitMs: 1000 });
    const aAfter = Q.getTask ? Q.getTask(a.id) : db.prepare('SELECT * FROM story_analysis_tasks WHERE id = ?').get(a.id);
    assert.equal(aAfter.revision_id, 'revA', 'R1：running 任务的 revision_id 不得被新保存改写');
    assert.equal(aAfter.status, 'running');

    const rows = db.prepare('SELECT * FROM story_analysis_tasks WHERE chapter_id = ? ORDER BY id').all(chapterId);
    assert.equal(rows.length, 2, 'R1：必须是两条（running A + queued B），而不是把一行改成 B');
    const b = rows.find((r) => r.id !== a.id);
    assert.equal(b.status, 'queued');
    assert.equal(b.revision_id, 'revB');

    // A 完成 → 只能终结 A
    const fin = Q.finishOk(db, { taskId: a.id, owner: 'w1', generation: a.lease_generation, nowMs: T0 + 20 });
    assert.equal(fin.ok, true);
    assert.equal(db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(a.id).status, 'done');
    assert.equal(db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(b.id).status, 'queued',
      'R1 核心：A 的完成绝不能把 B 标成 done（B 从未执行）');
    assert.equal(db.prepare('SELECT revision_id FROM story_analysis_tasks WHERE id = ?').get(b.id).revision_id, 'revB');
  }],

  ['R1-02 A 运行时连存 B、C：合并进同一条 queued，最终有效意图是 C', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 5000 });
    const a = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 10_000 });
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revB', nowMs: T0 + 10, debounceMs: 0, maxWaitMs: 5000 });
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revC', nowMs: T0 + 20, debounceMs: 0, maxWaitMs: 5000 });
    const rows = db.prepare("SELECT * FROM story_analysis_tasks WHERE chapter_id = ? AND status = 'queued'").all(chapterId);
    assert.equal(rows.length, 1, 'R1：同章同类最多一个 queued（trailing 合并）');
    assert.equal(rows[0].revision_id, 'revC', '合并后应指向最新修订 C');
    assert.notEqual(rows[0].id, a.id, 'B/C 的意图不能落在正在跑的 A 那一行上');
  }],

  ['R1-05 跨作品：W1 的 A 与 W2 的 B 互不消费', () => {
    const x = seed();
    const y = seed();
    Q.recordIntent(db, { workId: x.workId, chapterId: x.chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    Q.recordIntent(db, { workId: y.workId, chapterId: y.chapterId, revisionId: 'revB', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const a = Q.claimNext(db, { owner: 'w1', workId: x.workId, nowMs: T0, leaseMs: 1000 });
    assert.equal(a.revision_id, 'revA');
    const b = Q.claimNext(db, { owner: 'w2', workId: y.workId, nowMs: T0, leaseMs: 1000 });
    assert.equal(b.revision_id, 'revB');
    // W1 再保存不得改动 W2 的任务
    Q.recordIntent(db, { workId: x.workId, chapterId: x.chapterId, revisionId: 'revA2', nowMs: T0 + 5, debounceMs: 0, maxWaitMs: 1000 });
    assert.equal(db.prepare('SELECT revision_id FROM story_analysis_tasks WHERE id = ?').get(b.id).revision_id, 'revB');
  }],

  // ── R2：失败不得伪装成完成 ────────────────────────────────────────────────
  ['R2 classifyResult：失败/未运行/未知都不得归为 done', () => {
    assert.equal(D.classifyResult({ ok: true, status: 'done' }).kind, 'done');
    assert.equal(D.classifyResult({ ok: false, status: 'failed', reason: 'provider unavailable' }).kind, 'failed',
      'R2：ok:false + status:failed 不得算成功');
    assert.equal(D.classifyResult({ ok: true, status: 'failed' }).kind, 'failed',
      'R2：ok:true 只表示"失败状态写入成功"，不等于分析成功');
    assert.equal(D.classifyResult({ ok: false, status: 'not_run' }).kind, 'not_run');
    assert.equal(D.classifyResult({ ok: false, status: 'stale' }).kind, 'wait');
    assert.equal(D.classifyResult(null).kind, 'unknown', 'R2：空结果保守失败');
    assert.equal(D.classifyResult({ ok: true, status: 'something_new' }).kind, 'unknown',
      'R2：未知 status 保守失败，不许静默当成功');
  }],

  ['R2 tick：执行器返回失败对象 → 任务与 attempt 都不是成功态', async () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const disp = D.createDispatcher({
      db, owner: 'w1', now: () => T0,
      runAnalysis: async () => ({ ok: false, status: 'failed', reason: 'provider unavailable' }),
    });
    const r = await disp.tick({ workId });
    assert.equal(r.outcome, D.TICK.FAILED, `期望 failed，实际 ${r.outcome}`);
    const t = db.prepare('SELECT * FROM story_analysis_tasks WHERE chapter_id = ?').get(chapterId);
    assert.equal(t.status, 'failed', 'R2：任务必须是 failed，不能是 done');
    const att = db.prepare('SELECT * FROM story_analysis_attempts WHERE task_id = ?').get(t.id);
    assert.equal(att.status, 'failed', 'R2：attempt 也必须是非成功态');
    assert.match(String(t.last_error), /provider unavailable/);
  }],

  ['R2 tick：not_run 如实记录，不冒充 AI 成功', async () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const disp = D.createDispatcher({
      db, owner: 'w1', now: () => T0,
      runAnalysis: async () => ({ ok: false, status: 'not_run', reason: '自动分析未开启' }),
    });
    const r = await disp.tick({ workId });
    assert.equal(r.outcome, D.TICK.NOT_RUN);
    const t = db.prepare('SELECT * FROM story_analysis_tasks WHERE chapter_id = ?').get(chapterId);
    assert.notEqual(t.status, 'done');
    assert.match(String(t.last_error), /NOT_RUN/);
  }],

  // ── R3：重排不得把防抖截止时间提前 ────────────────────────────────────────
  ['R3 rearm：not_before 只能往后，不得早于既有截止时间', () => {
    const { workId, chapterId } = seed();
    // 首次排队：debounce 很大 → not_before 在 T0+16200
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 16_200, maxWaitMs: 100_000 });
    const before = db.prepare('SELECT * FROM story_analysis_tasks WHERE chapter_id = ?').get(chapterId);
    assert.equal(Number(before.not_before_ms), T0 + 16_200);
    // 人为把它弄成 running 再 rearm（rearmDelay 很小）
    db.prepare("UPDATE story_analysis_tasks SET status = 'running', lease_owner = 'w1', lease_generation = 1, lease_expires_at_ms = ? WHERE id = ?")
      .run(T0 + 100_000, before.id);
    const r = Q.rearm(db, { taskId: before.id, owner: 'w1', generation: 1, nowMs: T0 + 20_000, rearmDelayMs: 800 });
    assert.equal(r.ok, true);
    const after = db.prepare('SELECT * FROM story_analysis_tasks WHERE id = ?').get(before.id);
    assert.ok(Number(after.not_before_ms) >= Number(before.not_before_ms),
      `R3：重排不得把截止时间提前（before=${before.not_before_ms} after=${after.not_before_ms}）`);
    assert.ok(Number(after.not_before_ms) >= T0 + 20_000, 'R3：也不得早于 now');
    assert.equal(after.status, 'queued');
  }],

  ['R3 rearm：租约不是自己的 → 必须 FENCED，不得虚报已重排', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const t = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 1000 });
    const r = Q.rearm(db, { taskId: t.id, owner: 'w2', generation: t.lease_generation, nowMs: T0 + 10, rearmDelayMs: 800 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'FENCED');
    assert.equal(db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(t.id).status, 'running', '被拒时不得改动状态');
  }],

  // ── R4：传输态按尝试轮次管理 ──────────────────────────────────────────────
  ['R4 rearm 必须把 transport_state 复位为 not_sent（新轮次还没发出）', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const t = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 10_000 });
    // 第一轮：标记"可能已发出"
    assert.equal(Q.markSent(db, { taskId: t.id, owner: 'w1', generation: t.lease_generation, nowMs: T0 + 5 }), true);
    assert.equal(db.prepare('SELECT transport_state FROM story_analysis_tasks WHERE id = ?').get(t.id).transport_state, 'sent');
    // 重排（例如 stale）
    const r = Q.rearm(db, { taskId: t.id, owner: 'w1', generation: t.lease_generation, nowMs: T0 + 10, rearmDelayMs: 800 });
    assert.equal(r.ok, true);
    assert.equal(db.prepare('SELECT transport_state FROM story_analysis_tasks WHERE id = ?').get(t.id).transport_state, 'not_sent',
      'R4：新一轮尚未发送，传输态必须是 not_sent（否则恢复时会被误判成 unknown）');
  }],

  ['R4 重排后崩溃：reconciliation 必须判 not_sent（可安全重跑），而不是 unknown', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'revA', nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const t = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 10_000 });
    Q.markSent(db, { taskId: t.id, owner: 'w1', generation: t.lease_generation, nowMs: T0 + 5 });
    Q.rearm(db, { taskId: t.id, owner: 'w1', generation: t.lease_generation, nowMs: T0 + 10, rearmDelayMs: 800 });
    // 第二轮领取后**尚未发送**就"崩溃"（租约过期）
    const t2 = Q.claimNext(db, { owner: 'w2', workId, nowMs: T0 + 2_000, leaseMs: 100 });
    assert.ok(t2, '第二轮应能领取');
    assert.equal(t2.transport_state, 'not_sent');
    const plan = Q.planReconciliation(db, { nowMs: T0 + 2_200, workId });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, 'requeue', 'R4：第二轮未发送 → 可安全重跑');
  }],
]);
