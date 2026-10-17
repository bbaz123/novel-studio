/**
 * tests/nsdsh/frontend-revision-guard.test.mjs —— S08：前端流消费者的修订守卫与幂等。
 *
 * 为什么必须测前端这一层：后端 `isUpdateApplicable()` 只是**判据**，
 * 真正决定"会不会重复渲染 / 会不会把旧章结果画到新章卡片上"的是**消费者**。
 * 这里用 `public/temporal-stream.js`（**无 DOM 依赖**，可在 Node 直接跑）验证：
 *   ① 断线补读后状态正确；
 *   ② 重复事件不产生第二次业务动作（applied 不重复）；
 *   ③ 切章后旧事件被丢弃，新章卡片不被污染；
 *   ④ 前后端判据**同构**（同一输入必须给出同一个结论，否则会出现"后端认为该丢、前端照渲染"）。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const FE = await import('../../public/temporal-stream.js');
const BE = await import('../../ai/story-state/domain-stream.mjs');

suite('nsdsh/frontend-revision-guard', [
  ['S08-F1 快照 watermark 之前的事件不再渲染（消除初始化窗口）', () => {
    const s = FE.createStreamConsumer();
    s.applySnapshot({ watermark: 100 });
    const r = s.ingest([
      { id: 99, chapter_id: 1, state: 'saved' },   // 已在快照里
      { id: 101, chapter_id: 1, state: 'confirmed' },
    ]);
    assert.deepEqual(r.applied.map((e) => e.id), [101], 'watermark 之前的事件不应再次渲染');
    assert.equal(s.state.cursor, 101);
  }],

  ['S08-F2 重复事件不产生第二次业务动作（幂等）', () => {
    const s = FE.createStreamConsumer();
    s.applySnapshot({ watermark: 0 });
    const batch = [{ id: 5, chapter_id: 1, state: 'pending', dedup_key: 'k-5' }];
    const first = s.ingest(batch);
    assert.equal(first.applied.length, 1);
    const second = s.ingest(batch);
    assert.equal(second.applied.length, 0, '重放不得触发第二次渲染');
    assert.ok(second.dropped.some((d) => d.reason === 'DUPLICATE_ID'));
    // 切到别的章再切回来，重放仍然被丢弃
    s.ingest([{ id: 6, chapter_id: 2, state: 'saved' }]);
    assert.equal(s.ingest(batch).applied.length, 0, '来回切章后重放仍须幂等');
  }],

  ['S08-F3 切章后旧结果不更新新章节卡片', () => {
    const s = FE.createStreamConsumer();
    s.applySnapshot({ watermark: 0 });
    s.ingest([{ id: 10, chapter_id: 2, state: 'pending' }]);
    assert.equal(s.cardOf(2).state, 'pending');

    // 第 1 章的迟到确认事件（单卡片模式：当前在看第 2 章）
    const late = s.ingest([{ id: 11, chapter_id: 1, state: 'confirmed' }], { activeChapterId: 2 });
    // 作品级事件可以应用；章节级且章不匹配 → 丢弃
    assert.equal(late.dropped.some((d) => d.reason === 'CHAPTER_MISMATCH'), true,
      '第 1 章的结果不得写进第 2 章的卡片');
    assert.equal(s.cardOf(2).state, 'pending', '第 2 章卡片状态不得被第 1 章事件改写');
    assert.equal(s.cardOf(1), null, '也不应凭空创建第 1 章卡片');
  }],

  ['S08-F4 已确认不得倒退（卡片状态只前进）', () => {
    const s = FE.createStreamConsumer();
    s.applySnapshot({ watermark: 0 });
    s.ingest([{ id: 20, chapter_id: 3, state: 'confirmed' }]);
    assert.equal(s.cardOf(3).state, 'confirmed');
    const back = s.ingest([{ id: 21, chapter_id: 3, state: 'pending' }]);
    assert.equal(back.applied.length, 0);
    assert.equal(back.dropped[0].reason, 'NO_BACKWARD_FROM_CONFIRMED');
    assert.equal(s.cardOf(3).state, 'confirmed', '不得从已确认退回待确认');
    // 但过时（stale）是允许的——上游变了必须能让作者看到
    const stale = s.ingest([{ id: 22, chapter_id: 3, state: 'stale' }]);
    assert.equal(stale.applied.length, 1);
    assert.equal(s.cardOf(3).state, 'stale');
  }],

  ['S08-F5 前后端判据同构：同一输入必须得到同一结论', () => {
    const cases = [
      [{ event: { id: 11, chapter_id: 1, state: 'confirmed' }, card: { chapter_id: 2, state: 'pending', cursor: 10 } }],
      [{ event: { id: 9, chapter_id: 2, state: 'confirmed' }, card: { chapter_id: 2, state: 'pending', cursor: 10 } }],
      [{ event: { id: 12, chapter_id: 2, state: 'pending' }, card: { chapter_id: 2, state: 'confirmed', cursor: 11 } }],
      [{ event: { id: 12, chapter_id: 2, state: 'confirmed' }, card: { chapter_id: 2, state: 'pending', cursor: 11 } }],
      [{ event: { id: 13, chapter_id: null, state: 'saved' }, card: { chapter_id: 2, state: 'pending', cursor: 10 } }],
    ];
    for (const [{ event, card }] of cases) {
      const be = BE.isUpdateApplicable({ event, card });
      const fe = FE.isUpdateApplicable(event, card);
      assert.equal(fe.applicable, be.applicable, `判据不一致：${be.reason} vs ${fe.reason}`);
      assert.equal(fe.reason, be.reason, '理由也必须一致，便于诊断');
    }
    assert.deepEqual([...FE.TEMPORAL_STATES], [...BE.TEMPORAL_STATES], '状态集合必须一致');
  }],

  ['S08-F6 重连决策与后端 resyncPlan 同构', () => {
    const cases = [
      { cursor: 0, wm: 10 }, { cursor: 10, wm: 10 }, { cursor: 8, wm: 10 },
      { cursor: 1, wm: 10000 }, { cursor: 20, wm: 10 },
    ];
    for (const { cursor, wm } of cases) {
      const s = FE.createStreamConsumer({ initialCursor: cursor });
      const fe = s.planReconnect({ serverWatermark: wm });
      const be = BE.resyncPlan({ clientCursor: cursor, serverWatermark: wm });
      assert.equal(fe.action, be.action, `cursor=${cursor} wm=${wm}: ${fe.action} vs ${be.action}`);
    }
  }],
]);
