/**
 * tests/nsdsh/state-query-boundary.test.mjs —— S07：统一查询契约与边界（历史/当前/草案可区分）。
 *
 * 硬验收：**第 20 章不会从投影或检索获得第 80 章事实**。
 * 另外钉住三条失败纪律：
 *   ① 历史视图必须钉提交（否则"历史=当前"，那就不是历史视图）；
 *   ② 失败时 `state` 必须是 **null**，绝不回退最新值、也不返回 `{}`（`{}` 会被读成"这章什么都没有"）；
 *   ③ 边界上界与 before/after 必须自洽，不自洽就不可见。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const Q = await import('../../ai/story-state/temporal/state-query.mjs');

/** 假 stateAt：只回显被请求的章节与边界，便于观察契约是否被正确传递。 */
function makeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    stateAt: (args) => {
      calls.push(args);
      return {
        ok: true, commit_id: args.commitId || 'c-head', worldline_id: args.worldlineId || 'wl-main',
        state: { asked_chapter: args.chapterId, boundary: args.boundary },
        validity: 'valid', trusted: true, verified_through: 19, stop: null,
        ...overrides,
      };
    },
  };
}

suite('nsdsh/state-query-boundary', [
  ['S07-Q1 三种视图可区分：historical 必须钉提交，current 走主线，draft 额外标注 pending', () => {
    const deps = makeDeps();
    const cur = Q.queryState(deps, { workId: 1, chapterId: 20, view: 'current' });
    assert.equal(cur.ok, true);
    assert.equal(cur.view, 'current');
    assert.equal(deps.calls.at(-1).commitId, null, '当前视图不应钉提交');
    assert.equal(cur.draft_pending, false);

    const hist = Q.queryState(deps, { workId: 1, chapterId: 20, view: 'historical', commitId: 'c-123' });
    assert.equal(hist.ok, true);
    assert.equal(hist.provenance.commit_id, 'c-123', '历史视图必须把它钉的那个提交带进溯源');
    assert.equal(deps.calls.at(-1).commitId, 'c-123');

    const draft = Q.queryState(deps, { workId: 1, chapterId: 20, view: 'draft' });
    assert.equal(draft.ok, true);
    assert.equal(draft.draft_pending, true, '草案视图必须显式标注 pending 性质');
    // 草案**不得**篡改 state（正式事实仍来自 stateAt 的可信前缀）
    assert.deepEqual(draft.state, cur.state);

    assert.throws(() => Q.normalizeView('vague'), /INVALID_VIEW/);
  }],

  ['S07-Q2 历史视图缺 commitId → 类型化失败，不回退最新', () => {
    const deps = makeDeps();
    const r = Q.queryState(deps, { workId: 1, chapterId: 20, view: 'historical' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'HISTORICAL_REQUIRES_COMMIT_ID');
    assert.equal(r.state, null, '失败时不得返回任何状态（更不能是最新值）');
    assert.equal(deps.calls.length, 0, '不合法查询不应触发底层读取');
  }],

  ['S07-Q3 底层不可查询时：ok=false 且 state=null（不是 {}、不是最新值）', () => {
    for (const overrides of [{ ok: false, state: {}, validity: 'blocked', note: '章节不在章序' }, { ok: false, stop: { reason: 'no_commit', detail: '尚无提交' } }]) {
      const deps = makeDeps(overrides);
      const r = Q.queryState(deps, { workId: 1, chapterId: 20, view: 'current' });
      assert.equal(r.ok, false);
      assert.equal(r.state, null, '失败必须 state=null');
      assert.equal(r.trusted, false);
      assert.equal(r.reason, 'STATE_NOT_QUERYABLE');
      assert.ok(r.provenance && r.provenance.projection_version, '失败也要带溯源信息（便于诊断）');
    }
  }],

  ['S07-Q4 stateAt 抛错（提交不存在/不属于该作品）→ 类型化失败，不回退', () => {
    const deps = { stateAt: () => { throw new Error('提交 c-x 不存在'); } };
    const r = Q.queryState(deps, { workId: 1, chapterId: 20, view: 'historical', commitId: 'c-x' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'QUERY_FAILED');
    assert.equal(r.state, null);
    assert.match(r.detail, /不存在/);
  }],

  ['S07-Q5 硬验收：第 20 章看不到第 80 章事实', () => {
    // 读第 20 章（after）→ 排他上界 21
    const v80 = Q.factVisibleAt({ factChapterIndex: 80, boundaryExclusive: 21, readChapterIndex: 20, boundary: 'after' });
    assert.equal(v80.visible, false, '第 80 章的事实不得出现在第 20 章的读取里');
    assert.equal(v80.reason, 'BEYOND_BOUNDARY');
    // 边界内的事实可见
    assert.equal(Q.factVisibleAt({ factChapterIndex: 0, boundaryExclusive: 21, readChapterIndex: 20 }).visible, true);
    assert.equal(Q.factVisibleAt({ factChapterIndex: 19, boundaryExclusive: 21, readChapterIndex: 20 }).visible, true);
    // 恰好等于上界 → 不可见（半开区间）
    assert.equal(Q.factVisibleAt({ factChapterIndex: 20, boundaryExclusive: 21, readChapterIndex: 20, boundary: 'after' }).visible, true,
      'after 读第 20 章时，第 20 章自己的事实是可见的');
    assert.equal(Q.factVisibleAt({ factChapterIndex: 21, boundaryExclusive: 21 }).visible, false, '上界本身不可见');

    // 批量裁剪：80 章事实必须被丢掉且给出理由
    const facts = [
      { chapter_index: 1, label: '开头' },
      { chapter_index: 19, label: '上章' },
      { chapter_index: 20, label: '本章' },
      { chapter_index: 80, label: '未来' },
    ];
    const out = Q.filterFactsByBoundary(facts, { boundaryExclusive: 21, readChapterIndex: 20, boundary: 'after' });
    assert.deepEqual(out.kept.map((f) => f.label), ['开头', '上章', '本章']);
    assert.deepEqual(out.dropped.map((d) => d.fact.label), ['未来']);
    assert.equal(out.dropped[0].reason, 'BEYOND_BOUNDARY');
  }],

  ['S07-Q6 边界上界与 before/after 不自洽 → 不可见（宁可少给）', () => {
    // after@20 的合法上界是 21；传 30 就是不自洽
    const bad = Q.factVisibleAt({ factChapterIndex: 25, boundaryExclusive: 30, readChapterIndex: 20, boundary: 'after' });
    assert.equal(bad.visible, false);
    assert.equal(bad.reason, 'BOUNDARY_MISMATCH');
    // before@20 的合法上界是 20
    assert.equal(Q.factVisibleAt({ factChapterIndex: 19, boundaryExclusive: 20, readChapterIndex: 20, boundary: 'before' }).visible, true);
    assert.equal(Q.factVisibleAt({ factChapterIndex: 20, boundaryExclusive: 20, readChapterIndex: 20, boundary: 'before' }).visible, false,
      'before 读第 20 章时，第 20 章自己的事实还不可见');
    // 缺 index 一律不可见
    assert.equal(Q.factVisibleAt({ factChapterIndex: null, boundaryExclusive: 21 }).visible, false);
    assert.equal(Q.factVisibleAt({ factChapterIndex: 5, boundaryExclusive: null }).reason, 'BOUNDARY_INDEX_UNKNOWN');
  }],
]);
