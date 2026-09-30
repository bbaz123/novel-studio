/**
 * T1 存储/历史测试：真实 SQLite 中验证
 *   AC-01 第 5 章存活 / 第 10 章战死两个历史查询结果不同；
 *   AC-02 新稿把死亡改到第 5 章，新稿第 5 章死亡、原历史提交仍显示存活；
 *   AC-03 写作章前与阅读章后；保存后未确认时默认查询停在 pending。
 *   AC-12 原事件被改写删除后，新事件集不含旧事件、旧历史仍可回放。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite, seedWork } from './harness.mjs';
isolatedDir('ns-temporal-history-');
const T = await import('../../ai/story-state/temporal/index.mjs');
const { db } = await import('../../db.js');
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const setOp = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });
function confirm(workId, chapterId, contentHtml, ops, quote) {
  if (contentHtml) T.recordContentSave({ workId, chapterId, contentHtml, origin: { kind: 'test_seed' } });
  const revision = T.latestRevisionOf(chapterId);
  assert.ok(revision, '确认前必须有修订');
  return T.applyChapterEvents({
    workId, chapterId,
    events: [{ cursor: T.cursorOfChapter(workId, chapterId), ops, evidence: [{ revision_id: revision.id, quote, narrative: 'present' }] }],
  });
}
const key = (domain, entityId, predicate, scope = 'canon', holderId = null) => T.cellKey(cell(domain, entityId, predicate, scope, holderId));
function buildStoryA() {
  const { workId, chapterIds } = seedWork(db, { title: '王师傅', chapters: 10 });
  T.setTemporalConfig(workId, { temporal_enabled: true });
  const c = chapterIds;
  const contents = {
    0: '<p>第一章 青云镇的清晨</p>',
    1: '<p>第二章 黑风谷任务开始</p>',
    2: '<p>第三章 主角拜王师傅为师</p>',
    3: '<p>第四章 王师傅留在青云镇</p>',
    4: '<p>第五章 主角在青云镇等待</p>',
    5: '<p>第六章 有人答应接应</p>',
    6: '<p>第七章 主角寻找王师傅</p>',
    7: '<p>第八章 主角决定守护青云镇</p>',
    8: '<p>第九章 黑风谷的地形</p>',
    9: '<p>第十章 王师傅战死沙场</p>',
  };
  const ops = {
    0: [setOp(cell('world_fact', '青云镇', 'exists'), true)],
    1: [setOp(cell('plotline', '黑风谷任务', 'state'), '进行中')],
    2: [setOp(cell('relation', '主角|王师傅', '师徒'), { from: '主角', to: '王师傅', label: '师徒' })],
    3: [setOp(cell('character', '王师傅', 'alive'), true), setOp(cell('character', '王师傅', 'status'), '存活'), setOp(cell('character', '王师傅', 'location'), '青云镇')],
    4: [setOp(cell('character', '主角', 'alive'), true), setOp(cell('character', '主角', 'location'), '青云镇')],
    5: [setOp(cell('plotline', '黑风谷任务', 'summary'), '等待王师傅接应')],
    6: [setOp(cell('task', '寻找王师傅', 'state'), '进行中')],
    7: [setOp(cell('goal', '守护青云镇', 'state'), 'active')],
    8: [setOp(cell('location', '黑风谷', 'known'), true)],
    9: [setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }), setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }), setOp(cell('character', '王师傅', 'death_reason'), '战死')],
  };
  for (let i = 0; i < 10; i += 1) {
    const r = confirm(workId, c[i], contents[i], ops[i], contents[i].replace(/<\/?p>/g, '').replace(/^第.章 /, ''));
    assert.equal(r.ok, true, `第 ${i + 1} 章确认应成功：${r.reason || ''} ${JSON.stringify(r.issues || []).slice(0, 300)}`);
  }
  return { workId, c, commitC1: T.temporalOverview(workId).head_commit_id };
}
suite('temporal/02-history', [
  ['AC-01：第 5 章存活 / 第 10 章战死，两个历史查询结果不同', () => {
    const { workId, c } = buildStoryA();
    const after5 = T.stateAt({ workId, chapterId: c[4], boundary: 'after' });
    const after10 = T.stateAt({ workId, chapterId: c[9], boundary: 'after' });
    assert.equal(after5.state_json[key('character', '王师傅', 'alive')], true);
    assert.equal(after10.state_json[key('character', '王师傅', 'alive')], false);
    assert.equal(after10.state_json[key('character', '王师傅', 'status')], '战死');
    assert.notEqual(after5.state_content_hash, after10.state_content_hash, '两个历史快照必须不同');
    assert.equal(after5.trusted, true);
    assert.equal(after10.trusted, true);
  }],
  ['AC-03：章前不含本章结尾事件；章后才有', () => {
    const { workId, c } = buildStoryA();
    const before5 = T.stateBefore({ workId, chapterId: c[4] });
    const after5 = T.stateAt({ workId, chapterId: c[4], boundary: 'after' });
    assert.equal(before5.state_json[key('character', '主角', 'alive')], undefined, '第 5 章写作输入不得含本章尚未发生的事');
    assert.equal(after5.state_json[key('character', '主角', 'alive')], true);
    assert.equal(before5.state_json[key('character', '王师傅', 'alive')], true, '第 5 章前王师傅仍存活');
  }],
  ['AC-02：新稿把死亡改到第 5 章；新稿死亡、原历史提交仍存活', () => {
    const { workId, c, commitC1 } = buildStoryA();
    const newContent = '<p>第五章 王师傅在青云镇战死</p>';
    const r = confirm(workId, c[4], newContent, [
      setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }),
      setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }),
      setOp(cell('character', '王师傅', 'death_reason'), '战死'),
    ], '王师傅在青云镇战死');
    assert.equal(r.ok, true, r.reason || '');
    const commitC2 = T.temporalOverview(workId).head_commit_id;
    assert.notEqual(commitC1, commitC2, '确认后必须推进 HEAD');
    const now5 = T.stateAt({ workId, chapterId: c[4], boundary: 'after' });
    assert.equal(now5.state_json[key('character', '王师傅', 'alive')], false, '新稿第 5 章死亡');
    const old5 = T.stateAt({ workId, chapterId: c[4], boundary: 'after', commitId: commitC1 });
    assert.equal(old5.state_json[key('character', '王师傅', 'alive')], true, '原历史提交仍显示存活');
    const old10 = T.stateAt({ workId, chapterId: c[9], boundary: 'after', commitId: commitC1 });
    assert.equal(old10.state_json[key('character', '王师傅', 'alive')], false, '旧提交第 10 章仍是战死');
    // 新提交中第 6 章起未重新验证 → 一律 stale，不用旧状态冒充新稿。
    const c6 = T.stateAt({ workId, chapterId: c[5], boundary: 'after' });
    assert.equal(c6.validity, 'stale');
    assert.equal(c6.stop && c6.stop.reason, 'stale');
    assert.equal(c6.state_json[key('character', '王师傅', 'alive')], false, 'staleness 之前是第 5 章的新事实');
    // 旧提交的第 6 章不受新提交影响。
    const old6 = T.stateAt({ workId, chapterId: c[5], boundary: 'after', commitId: commitC1 });
    assert.equal(old6.validity, 'valid');
    assert.equal(old6.state_json[key('plotline', '黑风谷任务', 'summary')], '等待王师傅接应');
  }],
  ['保存后未确认：默认查询停在 pending，不显示旧状态冒充最新', () => {
    const { workId, c } = buildStoryA();
    const r = T.recordContentSave({ workId, chapterId: c[4], contentHtml: '<p>第五章 王师傅战死的新稿</p>', origin: { kind: 'manual_save' } });
    assert.equal(r.recorded, true);
    const view = T.stateAt({ workId, chapterId: c[4], boundary: 'after' });
    assert.equal(view.validity, 'pending');
    assert.equal(view.state_json[key('character', '王师傅', 'alive')], true, '未确认时只能显示章前事实');
    const panel = T.chapterPanel({ workId, chapterId: c[4] });
    assert.equal(panel.binding_validity, 'pending');
    assert.equal(panel.state_scope, 'through_previous_chapter');
    // 内容未变化 → 不产生新修订、不触发 pending（去重）。
    const again = T.recordContentSave({ workId, chapterId: c[4], contentHtml: '<p>第五章 王师傅战死的新稿</p>', origin: { kind: 'manual_save' } });
    assert.equal(again.recorded, false);
    assert.equal(again.dedup, true);
  }],
  ['AC-12：改写删除旧事件 → 新事件集不含旧事件，旧提交仍可回放', () => {
    const { workId, chapterIds: c } = seedWork(db, { title: '事件替换', chapters: 8 });
    T.setTemporalConfig(workId, { temporal_enabled: true });
    for (let i = 0; i < 8; i += 1) {
      const content = `<p>第${i + 1}章 内容</p>`;
      const ops = i === 6
        ? [setOp(cell('task', '寻找王师傅', 'state'), '进行中')]
        : [setOp(cell('world_fact', `事实${i + 1}`, 'value'), i + 1)];
      const r = confirm(workId, c[i], content, ops, '内容');
      assert.equal(r.ok, true, r.reason || '');
    }
    const commitOld = T.temporalOverview(workId).head_commit_id;
    const oldBinding = T.manifestOf(T.getCommit(commitOld)).chapters[String(c[6])];
    const oldEventIds = T.getBinding(oldBinding).event_ids;
    const r2 = confirm(workId, c[6], '<p>第七章 主角在路口留下记号</p>', [setOp(cell('task', '放置记号', 'state'), 'done')], '主角在路口留下记号');
    assert.equal(r2.ok, true, r2.reason || '');
    const commitNew = T.temporalOverview(workId).head_commit_id;
    assert.notEqual(commitOld, commitNew);
    const newBinding = T.manifestOf(T.getCommit(commitNew)).chapters[String(c[6])];
    const newEventIds = T.getBinding(newBinding).event_ids;
    for (const id of oldEventIds) assert.ok(!newEventIds.includes(id), '新事件集不得包含旧事件');
    const new7 = T.stateAt({ workId, chapterId: c[6], boundary: 'after' });
    assert.equal(new7.state_json[key('task', '放置记号', 'state')], 'done');
    assert.equal(new7.state_json[key('task', '寻找王师傅', 'state')], undefined);
    const old7 = T.stateAt({ workId, chapterId: c[6], boundary: 'after', commitId: commitOld });
    assert.equal(old7.state_json[key('task', '寻找王师傅', 'state')], '进行中', '旧历史仍可回放');
  }],
  ['逐章信任报告：新提交在第 6 章断链，旧提交全部可读', () => {
    const { workId, c, commitC1 } = buildStoryA();
    const r = confirm(workId, c[4], '<p>第五章 王师傅战死（用于信任报告）</p>', [
      setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }),
      setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }),
    ], '王师傅战死');
    assert.equal(r.ok, true, r.reason || '');
    const report = T.trustReport({ workId });
    assert.equal(report.chapters[0].validity, 'valid');
    assert.equal(report.chapters[4].validity, 'valid');
    assert.equal(report.chapters[5].validity, 'stale');
    assert.equal(report.trusted_through, 4, '可信前缀 = 前 5 章');
    const oldReport = T.trustReport({ workId, commitId: commitC1 });
    assert.equal(oldReport.totals.valid, 10);
    assert.equal(oldReport.trusted_through, 9);
  }],
]);
