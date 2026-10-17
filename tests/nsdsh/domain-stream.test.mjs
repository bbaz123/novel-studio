/**
 * tests/nsdsh/domain-stream.test.mjs —— S08：领域事件流（cursor 补读 / watermark / resync / 去重）。
 *
 * 三条验收逐条钉住：
 *   ① **断线不漏确认**：事件来自持久 outbox，按 cursor 补读能拿到断线期间的全部事件；
 *   ② **重复事件不重复渲染业务动作**：重放幂等；
 *   ③ **切章后旧结果不更新新章节卡片**：修订守卫丢弃 CHAPTER_MISMATCH。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from '../temporal/harness.mjs';

isolatedDir('nsdsh-domain-stream-');
const { db } = await import('../../db.js');
const S = await import('../../ai/story-state/domain-stream.mjs');

let seq = 0;
function newWork() {
  seq += 1;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(`stream-${seq}`, now, now);
  return Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
}
function addEvent(workId, { chapterId = null, kind = 'commit_confirmed', dedupKey = '', payload = {} } = {}) {
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO projection_outbox (work_id, chapter_id, kind, dedup_key, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(workId, chapterId, kind, dedupKey, JSON.stringify(payload), now, now);
  return Number(info.lastInsertRowid);
}

suite('nsdsh/domain-stream', [
  ['S08-S1 按作品过滤 + cursor 补读：断线期间的事件一条不漏', () => {
    const w1 = newWork();
    const w2 = newWork();
    const a = addEvent(w1, { chapterId: null, kind: 'commit_confirmed', payload: { commit_id: 'c1' } });
    const b = addEvent(w1, { chapterId: null, kind: 'analysis_done' });
    addEvent(w2, { chapterId: null, kind: 'commit_confirmed', payload: { commit_id: 'w2c' } }); // 别的作品
    const c = addEvent(w1, { chapterId: null, kind: 'stale_invalidated' });

    const all = S.readDomainEvents(db, { workId: w1, afterCursor: 0 });
    assert.deepEqual(all.events.map((e) => e.id), [a, b, c], '必须只包含该作品的事件，且按 id 升序');
    assert.equal(all.next_cursor, c);

    // 模拟"只收到 a,b 就断线"，重连后从 cursor=b 补读 → 必须拿到 c
    const after = S.readDomainEvents(db, { workId: w1, afterCursor: b });
    assert.deepEqual(after.events.map((e) => e.id), [c], '断线期间的确认事件不得漏掉');
    // 补读到末尾后没有更多
    assert.equal(S.readDomainEvents(db, { workId: w1, afterCursor: c }).events.length, 0);
  }],

  ['S08-S2 watermark：快照之前的旧事件直接跳过（消除初始化窗口）', () => {
    const w = newWork();
    addEvent(w, { kind: 'commit_confirmed' });
    addEvent(w, { kind: 'analysis_done' });
    const wm = S.snapshotWatermark(db, { workId: w });
    assert.ok(wm > 0);
    // 快照已包含 watermark 之前的全部事件 → 只读 watermark 之后的
    const after = S.readDomainEvents(db, { workId: w, afterCursor: wm });
    assert.equal(after.events.length, 0, 'watermark 之后没有新事件');
    // 新来一条 → 只有它需要渲染
    const n = addEvent(w, { kind: 'stale_invalidated' });
    assert.deepEqual(S.readDomainEvents(db, { workId: w, afterCursor: wm }).events.map((e) => e.id), [n]);
  }],

  ['S08-S3 resync 决策：落后太多/游标超前/无游标都必须 resync（宁可重取，不可漏）', () => {
    assert.equal(S.resyncPlan({ clientCursor: 10, serverWatermark: 10 }).action, 'idle');
    assert.equal(S.resyncPlan({ clientCursor: 8, serverWatermark: 10 }).action, 'catch_up');
    assert.equal(S.resyncPlan({ clientCursor: 0, serverWatermark: 10 }).action, 'snapshot');
    const far = S.resyncPlan({ clientCursor: 1, serverWatermark: 10000 });
    assert.equal(far.action, 'resync');
    assert.equal(far.reason, 'TOO_FAR_BEHIND');
    assert.equal(S.resyncPlan({ clientCursor: 20, serverWatermark: 10 }).reason, 'CURSOR_AHEAD');
    assert.equal(S.resyncPlan({ clientCursor: 9, serverWatermark: 10, force: true }).action, 'resync');
  }],

  ['S08-S4 去重：重放同一批事件不得产生第二次业务动作', () => {
    const evs = [{ id: 1, dedup_key: 'k1' }, { id: 2, dedup_key: 'k2' }];
    const first = S.dedupeEvents([], evs);
    assert.deepEqual(first.fresh.map((e) => e.id), [1, 2]);
    // 重放：把上一次的完整状态（id + key）一起带进来，全部被丢弃
    const replay = S.dedupeEvents(first, evs);
    assert.equal(replay.fresh.length, 0, '重复事件不得重复渲染');
    assert.equal(replay.duplicates.length, 2);
    // 同一逻辑变更换了 id 但 dedup_key 相同 → 仍然丢弃
    const sameKey = S.dedupeEvents(first, [{ id: 99, dedup_key: 'k1' }]);
    assert.equal(sameKey.fresh.length, 0, 'dedup_key 兜底必须生效');
    assert.equal(sameKey.duplicates[0].reason, 'DUPLICATE_KEY');
  }],

  ['S08-S5 修订守卫：切章后旧结果不得更新新章节卡片', () => {
    const card = { chapter_id: 2, state: 'pending', cursor: 10 };
    const oldOtherChapter = S.isUpdateApplicable({ event: { id: 11, chapter_id: 1, state: 'confirmed' }, card });
    assert.equal(oldOtherChapter.applicable, false);
    assert.equal(oldOtherChapter.reason, 'CHAPTER_MISMATCH', '第 1 章的结果不许写进第 2 章的卡片');

    // 同章但事件更旧 → 丢弃
    assert.equal(S.isUpdateApplicable({ event: { id: 9, chapter_id: 2, state: 'confirmed' }, card }).reason, 'STALE_EVENT');
    // 已确认不得倒退成待确认
    assert.equal(
      S.isUpdateApplicable({ event: { id: 12, chapter_id: 2, state: 'pending' }, card: { chapter_id: 2, state: 'confirmed', cursor: 11 } }).reason,
      'NO_BACKWARD_FROM_CONFIRMED',
    );
    // 同章、更新、前进 → 可以应用
    assert.equal(S.isUpdateApplicable({ event: { id: 12, chapter_id: 2, state: 'confirmed' }, card }).applicable, true);
    // 作品级事件（无 chapter_id）对任何卡片都适用
    assert.equal(S.isUpdateApplicable({ event: { id: 13, chapter_id: null, state: 'saved' }, card }).applicable, true);
  }],

  ['S08-S6 kind → 状态映射：未识别的 kind 不得当成成功态', () => {
    assert.equal(S.stateOfKind('commit_confirmed'), 'confirmed');
    assert.equal(S.stateOfKind('analysis_done'), 'analyzing');
    assert.equal(S.stateOfKind('proposal_pending'), 'pending');
    assert.equal(S.stateOfKind('stale_invalidated'), 'stale');
    assert.equal(S.stateOfKind('revision_saved'), 'saved');
    assert.equal(S.stateOfKind('totally_unknown_kind'), 'failed', '未知 kind 保守判失败，不冒充成功');
    assert.equal(S.normalizeTemporalState('CONFIRMED'), 'confirmed');
    assert.equal(S.normalizeTemporalState('bogus'), 'failed');
  }],
]);
