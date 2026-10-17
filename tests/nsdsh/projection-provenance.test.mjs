/**
 * tests/nsdsh/projection-provenance.test.mjs —— S07：投影溯源。
 *
 * 验收要求"历史/当前/草案视图可区分"，那么每份状态都必须能回答：
 *   它来自**哪个提交**、**哪个边界**、**哪一版投影**、**哪个查询契约版本**。
 * 没有这四样，就分不清"第 20 章看到的"和"第 80 章看到的"是不是同一份东西。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const Q = await import('../../ai/story-state/temporal/state-query.mjs');

suite('nsdsh/projection-provenance', [
  ['S07-P1 成功查询必须带齐四样溯源（提交/世界线/边界/投影版本）', () => {
    const deps = { stateAt: (a) => ({ ok: true, commit_id: 'c-77', worldline_id: 'wl-main', state: {}, validity: 'valid', trusted: true, verified_through: 5, stop: null }) };
    const r = Q.queryState(deps, { workId: 1, chapterId: 7, view: 'current', worldlineId: 'wl-main' });
    assert.equal(r.ok, true);
    const p = r.provenance;
    assert.equal(p.commit_id, 'c-77');
    assert.equal(p.worldline_id, 'wl-main');
    assert.equal(p.boundary, 'after');
    assert.equal(p.chapter_id, 7);
    assert.equal(p.projection_version, Q.PROJECTION_VERSION);
    assert.equal(p.query_version, Q.STATE_QUERY_VERSION);
    assert.equal(r.version, Q.STATE_QUERY_VERSION, '顶层也要能读出契约版本');
    assert.equal(r.projection_version, Q.PROJECTION_VERSION);
  }],

  ['S07-P2 边界必须如实反映请求（before/after 不得被静默改成同一个）', () => {
    const calls = [];
    const deps = { stateAt: (a) => { calls.push(a); return { ok: true, commit_id: 'c', worldline_id: 'wl', state: {}, validity: 'valid', trusted: true, verified_through: 0, stop: null }; } };
    const before = Q.queryState(deps, { workId: 1, chapterId: 3, view: 'current', boundary: 'before' });
    const after = Q.queryState(deps, { workId: 1, chapterId: 3, view: 'current', boundary: 'after' });
    assert.equal(before.provenance.boundary, 'before');
    assert.equal(after.provenance.boundary, 'after');
    assert.equal(calls[0].boundary, 'before', '底层必须真的收到 before');
    assert.equal(calls[1].boundary, 'after');
  }],

  ['S07-P3 历史视图的溯源必须指向它自己钉的提交（不是主线 HEAD）', () => {
    const deps = { stateAt: (a) => ({ ok: true, commit_id: a.commitId || 'c-head', worldline_id: 'wl-main', state: {}, validity: 'valid', trusted: true, verified_through: 1, stop: null }) };
    const hist = Q.queryState(deps, { workId: 1, chapterId: 4, view: 'historical', commitId: 'c-old-42' });
    assert.equal(hist.provenance.commit_id, 'c-old-42', '历史视图溯源必须是钉住的旧提交');
    assert.notEqual(hist.provenance.commit_id, 'c-head');
    // 历史视图不继承主线 worldline（否则读者会以为它跟当前线有关）
    assert.equal(hist.provenance.worldline_id, 'wl-main', 'worldline 由底层提交给出，但 commitId 必须是旧的');
  }],

  ['S07-P4 失败也要带溯源：便于回答"这次到底查了什么"', () => {
    const deps = { stateAt: () => ({ ok: false, commit_id: 'c-x', validity: 'blocked', note: '章节不在章序' }) };
    const r = Q.queryState(deps, { workId: 1, chapterId: 9, view: 'current' });
    assert.equal(r.ok, false);
    assert.equal(r.provenance.chapter_id, 9, '失败时也要记录查的是哪一章');
    assert.equal(r.provenance.projection_version, Q.PROJECTION_VERSION);
    assert.equal(r.state, null);
  }],

  ['S07-P5 契约版本是显式常量（改动必须可见，不是"隐式行为变了"）', () => {
    assert.match(Q.PROJECTION_VERSION, /^proj-v\d+$/);
    assert.match(Q.STATE_QUERY_VERSION, /^q-v\d+$/);
    assert.deepEqual([...Q.VIEWS], ['historical', 'current', 'draft'], '视图集合必须固定且可枚举');
  }],
]);
