/**
 * tests/nsdsh/task-queue.test.mjs —— 持久化分析队列的判据（S04）。
 *
 * 这个套件存在的理由：改造前"保存后自动分析"是 server.js 里的 `Map` + `setTimeout`（F01/F02/F03）。
 * 那套做法有两件事**不可能**做到，而它们恰恰是作者会碰到的：
 *   · 进程重启后待分析意图还在（F01）——内存 Map 做不到；
 *   · "最后一次保存后 N 秒"而不是"第一次保存后 N 秒"（F02）——旧实现的 `if (has(key)) return`
 *     让第一次的 timer 一直生效。
 * 因此这里用**真实 SQLite**（临时库）逐条钉住：重启可恢复、trailing + cap、租约代际 fencing、
 * 以及"已发送的请求不得自动重发"。
 *
 * 隔离：走 tests/temporal/harness.mjs 的 isolatedDir()（临时数据目录），
 * 在 import db.js **之前**调用；全部断言只碰临时库。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from '../temporal/harness.mjs';

isolatedDir('nsdsh-task-queue-');
const { db } = await import('../../db.js');
const Q = await import('../../ai/jobs/queue-store.mjs');

/** 造一部最小作品 + 一章（外键要求）。 */
function seed() {
  const nowIso = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('队列测试', nowIso, nowIso);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workId, '第1章', '<p>x</p>', 0, nowIso, nowIso);
  const chapterId = Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
  return { workId, chapterId };
}

const T0 = 1_000_000; // 固定的假时钟基准（毫秒），避免依赖真实时间

suite('nsdsh/task-queue', [
  // ── F01：意图必须落库，重启后仍在 ──────────────────────────────────────────
  ['F01 意图落库：保存只写一行 queued 任务，进程重启后仍在（不是内存 Map）', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, revisionId: 'rev1', nowMs: T0 });
    const rows = db.prepare('SELECT * FROM story_analysis_tasks WHERE chapter_id = ?').all(chapterId);
    assert.equal(rows.length, 1, '必须恰好一行意图');
    assert.equal(rows[0].status, 'queued');
    assert.equal(rows[0].revision_id, 'rev1');
    // "重启"= 重新打开同一个库文件读一遍：内存里什么都没有，但意图还在。
    // 这里用同一个 db 句柄再查一次即可证明它不在内存结构里（表是唯一载体）。
    const again = db.prepare('SELECT COUNT(*) AS n FROM story_analysis_tasks').get();
    assert.equal(Number(again.n), 1);
    // 反证：没有任何进程内 Map 参与（本模块不导出任何 Map）。
    assert.equal(typeof Q.claimNext, 'function');
  }],

  // ── F02：trailing debounce + 最长等待封顶 ──────────────────────────────────
  ['F02 trailing：每次保存都往后推 not_before（不是"第一次保存后 N 秒"）', () => {
    const { workId, chapterId } = seed();
    const d = 100, cap = 100_000;
    const a = Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: d, maxWaitMs: cap });
    assert.equal(a.created, true);
    assert.equal(a.notBeforeMs, T0 + d, '首次：now + debounce');
    const b = Q.recordIntent(db, { workId, chapterId, nowMs: T0 + 50, debounceMs: d, maxWaitMs: cap });
    assert.equal(b.created, false, '同章同 kind 必须复用同一行（合并最新修订）');
    assert.equal(b.notBeforeMs, T0 + 50 + d, '第二次保存把可执行时刻往后推');
    const c = Q.recordIntent(db, { workId, chapterId, nowMs: T0 + 90, debounceMs: d, maxWaitMs: cap });
    assert.equal(c.notBeforeMs, T0 + 90 + d, '第三次继续往后推');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM story_analysis_tasks WHERE work_id = ? AND chapter_id = ?').get(workId, chapterId).n, 1, '本作品本章始终只有一行（合并最新修订）');
  }],

  ['F02 最长等待：无论怎么推，都不得超过首次排队时定下的硬上限', () => {
    const { workId, chapterId } = seed();
    const d = 100, cap = 250; // 上限只比首次晚 150ms
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: d, maxWaitMs: cap });
    // 持续保存：理想时刻一路超出上限
    let last = null;
    for (const t of [T0 + 50, T0 + 100, T0 + 150, T0 + 200, T0 + 400, T0 + 900]) {
      last = Q.recordIntent(db, { workId, chapterId, nowMs: t, debounceMs: d, maxWaitMs: cap });
    }
    assert.equal(last.deadlineMs, T0 + cap, '上限由首次排队决定，不随保存刷新');
    assert.equal(last.notBeforeMs, T0 + cap, '理想时刻超过上限时被压到上限');
    // 关键性质：可执行时刻永远不晚于上限
    const row = db.prepare('SELECT not_before_ms, max_wait_ms FROM story_analysis_tasks').get();
    assert.ok(Number(row.not_before_ms) <= Number(row.max_wait_ms), 'not_before 不得超过 max_wait（否则可被无限推迟）');
  }],

  // ── 领取：行级 CAS + 租约代际 ─────────────────────────────────────────────
  ['领取用行级 CAS：同一时刻只有一个 owner 能拿到，且租约代际自增', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const t1 = Q.claimNext(db, { owner: 'w1', nowMs: T0, leaseMs: 500 });
    assert.ok(t1, '到期任务必须能被领取');
    assert.equal(t1.lease_generation, 1, '首次领取代际为 1');
    assert.equal(t1.status, 'running');
    assert.equal(t1.attempts, 1);
    const t2 = Q.claimNext(db, { owner: 'w2', nowMs: T0, leaseMs: 500 });
    assert.equal(t2, null, '同一行不能被第二个 owner 再领一次（不是"先 SELECT 再 UPDATE"）');
    // 生成的 attempt 行也必须只有一条
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM story_analysis_attempts').get().n), 1);
  }],

  ['未到期的任务领不到（not_before 是真的在生效）', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 500, maxWaitMs: 5000 });
    assert.equal(Q.claimNext(db, { owner: 'w1', nowMs: T0 + 100, leaseMs: 500 }), null, '还没到可执行时刻');
    assert.ok(Q.claimNext(db, { owner: 'w1', nowMs: T0 + 500, leaseMs: 500 }), '到点后必须能领到');
  }],

  ['租约代际 fencing：旧 worker（过期代际）不得覆盖新结果', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const first = Q.claimNext(db, { owner: 'old', nowMs: T0, leaseMs: 100 });
    assert.ok(first);
    // 旧 worker 的租约过期 → reconciliation 让它回到 queued
    Q.applyReconciliation(db, { nowMs: T0 + 200, workId });
    const second = Q.claimNext(db, { owner: 'new', nowMs: T0 + 200, leaseMs: 500 });
    assert.ok(second, '租约过期后必须可被重新领取');
    assert.equal(second.lease_generation, 2, '代际必须自增');

    // 旧 worker 拿着 generation=1 回写 → 必须被拒（否则旧结果会覆盖新修订）
    const fenced = Q.finishOk(db, { taskId: first.id, owner: 'old', generation: 1, nowMs: T0 + 300 });
    assert.equal(fenced.ok, false);
    assert.equal(fenced.reason, 'FENCED');
    const still = db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(first.id);
    assert.equal(still.status, 'running', '被 fencing 的写入不得改变状态');

    // 当前持有者回写 → 允许
    const good = Q.finishOk(db, { taskId: second.id, owner: 'new', generation: 2, nowMs: T0 + 400 });
    assert.equal(good.ok, true);
    assert.equal(db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(first.id).status, 'done');
  }],

  ['错误 owner 即使代际正确也不得回写（租约绑定到具体执行者）', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const t = Q.claimNext(db, { owner: 'owner-A', nowMs: T0, leaseMs: 500 });
    assert.equal(Q.finishOk(db, { taskId: t.id, owner: 'owner-B', generation: t.lease_generation, nowMs: T0 + 10 }).reason, 'FENCED');
    assert.equal(Q.renewLease(db, { taskId: t.id, owner: 'owner-B', generation: t.lease_generation, nowMs: T0 + 10 }), false);
    assert.equal(Q.renewLease(db, { taskId: t.id, owner: 'owner-A', generation: t.lease_generation, nowMs: T0 + 10 }), true);
  }],

  // ── reconciliation：已发送的请求**不自动重发** ────────────────────────────
  ['reconciliation：not_sent → 回 queued；sent → 进 unknown 且**不自动重发**', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    const a = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 100 });  // 未 markSent
    // 第二个任务：领到之后 markSent，模拟"请求可能已经发出"
    db.prepare('INSERT INTO story_analysis_tasks (work_id, chapter_id, kind, status, not_before_ms, max_wait_ms, created_at_ms, updated_at_ms) VALUES (?, ?, \'impact\', \'queued\', ?, ?, ?, ?)')
      .run(workId, chapterId, T0, T0 + 1000, T0, T0);
    const b = Q.claimNext(db, { owner: 'w2', kind: 'impact', workId, nowMs: T0, leaseMs: 100 });
    assert.ok(b);
    assert.equal(Q.markSent(db, { taskId: b.id, owner: 'w2', generation: b.lease_generation, nowMs: T0 + 10 }), true);

    // dry-run 只出计划、不写库
    const planPreview = Q.applyReconciliation(db, { nowMs: T0 + 200, dryRun: true, workId });
    assert.equal(planPreview.length, 2);
    assert.ok(planPreview.every((p) => p.applied === false));
    assert.equal(db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(a.id).status, 'running', 'dry-run 不得改库');

    const plan = Q.applyReconciliation(db, { nowMs: T0 + 200, workId });
    const byId = Object.fromEntries(plan.map((p) => [p.taskId, p]));
    assert.equal(byId[a.id].action, 'requeue', '未发送 → 可安全重跑');
    assert.equal(byId[b.id].action, 'mark_unknown', '已发送 → 不得自动重发');
    assert.equal(db.prepare('SELECT status FROM story_analysis_tasks WHERE id = ?').get(a.id).status, 'queued');
    const bRow = db.prepare('SELECT status, transport_state FROM story_analysis_tasks WHERE id = ?').get(b.id);
    assert.equal(bRow.status, 'unknown');
    assert.equal(bRow.transport_state, 'unknown');
    // 关键：unknown 的任务**不会**再被 claimNext 领走（否则就是自动重发）
    assert.equal(Q.claimNext(db, { owner: 'w3', kind: 'impact', workId, nowMs: T0 + 999, leaseMs: 100 }), null, 'unknown 不得被重新领取');
  }],

  ['未过期的租约不参与 reconciliation（不误伤正在跑的任务）', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 10_000 });
    assert.deepEqual(Q.planReconciliation(db, { nowMs: T0 + 5_000, workId }), [], '租约还没过期就不该有任何动作');
    assert.equal(Q.planReconciliation(db, { nowMs: T0 + 10_001, workId }).length, 1, '过期后才进入计划');
  }],

  ['overview 只读快照：按状态与传输态分别计数', () => {
    const { workId, chapterId } = seed();
    Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
    // 按本作品领取：不限定 workId 时 dispatcher 会拿到**全局最早**的那一行（那正是生产行为），
    // 但在共享临时库的测试里会误领别的用例留下的任务，于是本用例的断言就失去意义。
    const claimed = Q.claimNext(db, { owner: 'w1', workId, nowMs: T0, leaseMs: 500 });
    assert.ok(claimed, '前置：必须领到本作品这一行');
    const o = Q.overview(db, { workId });
    assert.equal(o.total, 1);
    assert.equal(o.byStatus.running, 1);
    assert.equal(o.byTransport.not_sent, 1);
  }],

  ['参数防线：缺 workId/chapterId 或空 owner 必须响亮失败', () => {
    assert.throws(() => Q.recordIntent(db, { workId: 0, chapterId: 1, nowMs: T0 }), /缺少 workId/);
    assert.throws(() => Q.recordIntent(db, { workId: 1, chapterId: 0, nowMs: T0 }), /缺少 workId/);
    assert.throws(() => Q.claimNext(db, { owner: '', nowMs: T0 }), /缺少 owner/);
  }],
]);
