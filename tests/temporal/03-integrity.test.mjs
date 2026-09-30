/**
 * T1 完整性测试：
 *   AC-11 多域同批演进；AC-09/10 知识不自动补写、关系不因死亡删除；
 *   所有事件只能由合法 binding 进入投影（未绑定事件/pending 绑定都不进）；
 *   校验门：前置条件冲突 / 叙述类型待复核 / 上游 pending 阻塞 → 不提交；
 *   AC-31 状态哈希相同但来源改变 → 下游仍失效；AC-30 章序变化从最早差异失效；
 *   AC-37 未来角色不泄漏；未启用作品零写入（不被接管）。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite, seedWork } from './harness.mjs';
isolatedDir('ns-temporal-integrity-');
const T = await import('../../ai/story-state/temporal/index.mjs');
const { db } = await import('../../db.js');
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const setOp = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });
const key = (domain, entityId, predicate, scope = 'canon', holderId = null) => T.cellKey(cell(domain, entityId, predicate, scope, holderId));
function enable(workId) { T.setTemporalConfig(workId, { temporal_enabled: true }); }
function confirm(workId, chapterId, contentHtml, ops, quote = '内容', narrative = 'present') {
  if (contentHtml) T.recordContentSave({ workId, chapterId, contentHtml, origin: { kind: 'test_seed' } });
  const revision = T.latestRevisionOf(chapterId);
  return T.applyChapterEvents({
    workId, chapterId,
    events: [{ cursor: T.cursorOfChapter(workId, chapterId), ops, evidence: [{ revision_id: revision.id, quote, narrative }] }],
  });
}
function story(n, title) {
  const { workId, chapterIds } = seedWork(db, { title, chapters: n });
  enable(workId);
  return { workId, c: chapterIds };
}
function fill(w, c, n, opFor) {
  for (let i = 0; i < n; i += 1) {
    const r = confirm(w, c[i], `<p>第${i + 1}章 内容</p>`, opFor(i), '内容');
    assert.equal(r.ok, true, `第 ${i + 1} 章：${r.reason || ''}`);
  }
}
suite('temporal/03-integrity', [
  ['AC-11：物品/知识/剧情线/伏笔/势力/披露同批确认后，状态与快照一致', () => {
    const { workId, c } = story(3, '多域');
    fill(workId, c, 3, (i) => [setOp(cell('character', `角色${i}`, 'alive'), true)]);
    const ops = [
      setOp(cell('character', '主角', 'condition'), '受伤'),
      setOp(cell('item', '玉佩', 'owner'), { owner: '主角' }),
      setOp(cell('knowledge', '王师傅的死', 'state', 'character', '主角'), 'unknown'),
      setOp(cell('disclosure', '王师傅的死', 'disclosed', 'reader'), false),
      setOp(cell('plotline', '黑风谷任务', 'state'), '失败'),
      setOp(cell('foreshadow', '王师傅的承诺', 'state'), 'open'),
      setOp(cell('faction', '青云镇', 'state'), '戒备'),
    ];
    const r = confirm(workId, c[2], '<p>第三章 多域同批</p><p>主角受伤，玉佩仍在，承诺未了</p>', ops, '多域同批', 'present');
    assert.equal(r.ok, true, r.reason || '');
    const view = T.stateAt({ workId, chapterId: c[2], boundary: 'after' });
    assert.equal(view.state_json[key('item', '玉佩', 'owner')].owner, '主角');
    assert.equal(view.state_json[key('knowledge', '王师傅的死', 'state', 'character', '主角')], 'unknown');
    assert.equal(view.state_json[key('disclosure', '王师傅的死', 'disclosed', 'reader')], false);
    assert.equal(view.state_json[key('plotline', '黑风谷任务', 'state')], '失败');
    assert.equal(view.state_json[key('foreshadow', '王师傅的承诺', 'state')], 'open');
    assert.equal(view.state_json[key('faction', '青云镇', 'state')], '戒备');
    const snap = T.getSnapshot(T.getBinding(r.binding_id).output_snapshot_id);
    assert.equal(snap.state_content_hash, view.state_content_hash, '快照与投影一致');
    const panel = T.chapterPanel({ workId, chapterId: c[2] });
    assert.ok(panel.changes.length >= ops.length, '面板逐条列出本章变化');
    assert.equal(panel.binding_validity, 'valid');
  }],
  ['AC-09/AC-10：死亡不自动写入"主角已知"，也不删除师徒关系', () => {
    const { workId, c } = story(5, '死亡边界');
    fill(workId, c, 4, (i) => (i === 0
      ? [
        setOp(cell('relation', '主角|王师傅', '师徒'), { from: '主角', to: '王师傅', label: '师徒' }),
        setOp(cell('character', '王师傅', 'alive'), true),
        setOp(cell('character', '王师傅', 'status'), '存活'),
        setOp(cell('character', '主角', 'alive'), true),
      ]
      : [setOp(cell('world_fact', `背景${i}`, 'v'), i)]));
    const r = confirm(workId, c[4], '<p>第五章 王师傅战死</p>', [
      setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }),
      setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }),
      setOp(cell('foreshadow', '王师傅的承诺', 'state'), 'open'),
    ], '王师傅战死');
    assert.equal(r.ok, true, r.reason || '');
    const view = T.stateAt({ workId, chapterId: c[4], boundary: 'after' });
    assert.equal(view.state_json[key('relation', '主角|王师傅', '师徒')].label, '师徒', '师徒关系必须保留');
    assert.ok(!Object.prototype.hasOwnProperty.call(view.state_json, key('knowledge', '王师傅的死', 'state', 'character', '主角')), '不得自动补写主角已知');
    assert.ok(!Object.keys(view.state_json).some((k) => k.includes('"knowledge"') && k.includes('主角')), '没有任何自动知识项');
    assert.equal(view.state_json[key('foreshadow', '王师傅的承诺', 'state')], 'open', '未闭合伏笔保留');
  }],
  ['事件只能由合法 binding 进入投影：未绑定/pending 事件都不进', () => {
    const { workId, c } = story(3, '绑定边界');
    fill(workId, c, 2, (i) => [setOp(cell('world_fact', `已确认${i}`, 'v'), 1)]);
    T.recordContentSave({ workId, chapterId: c[1], contentHtml: '<p>第2章 内容</p>', origin: { kind: 'test_seed' } });
    const revision = T.latestRevisionOf(c[1]);
    const [stray] = T.createEvents([{ cursor: T.cursorOfChapter(workId, c[1]), ops: [setOp(cell('world_fact', '未绑定', 'v'), 1)], evidence: [{ revision_id: revision.id, quote: '内容', narrative: 'present' }] }], { workId, chapterId: c[1], revisionId: revision.id });
    assert.ok(T.getEvent(stray.id), '事件行存在');
    const pending = T.createBinding({ workId, chapterId: c[1], revisionId: revision.id, eventIds: [stray.id], validity: 'pending', validation: { kind: 'save' }, contractRef: { kind: 'test_pending' } });
    const save = T.recordContentSave({ workId, chapterId: c[1], contentHtml: '<p>第2章 保存后的新稿</p>', origin: { kind: 'test_seed' } }); // 制造真实 pending 保存（内容必须变化）
    assert.equal(save.recorded, true);
    const view2 = T.stateAt({ workId, chapterId: c[1], boundary: 'after' });
    assert.equal(view2.validity, 'pending');
    assert.ok(!Object.prototype.hasOwnProperty.call(view2.state_json, key('world_fact', '未绑定', 'v')), 'pending 事件不得进入投影');
    const after1 = T.stateAt({ workId, chapterId: c[0], boundary: 'after' });
    assert.ok(!Object.prototype.hasOwnProperty.call(after1.state_json, key('world_fact', '未绑定', 'v')), '未绑定事件不得进入投影');
    void pending;
  }],
  ['校验门：前置条件冲突 / 叙述类型待复核 / 上游 pending → 拒绝提交且 HEAD 不变', () => {
    const { workId, c } = story(4, '校验门');
    fill(workId, c, 2, (i) => (i === 0
      ? [setOp(cell('character', '王师傅', 'alive'), true), setOp(cell('character', '王师傅', 'status'), '存活')]
      : [setOp(cell('world_fact', '背景', 'v'), 1)]));
    const head0 = T.temporalOverview(workId).head_commit_id;
    const conflict = confirm(workId, c[2], '<p>第三章 内容</p>', [setOp(cell('character', '王师傅', 'alive'), false, { kind: 'missing' })], '内容');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.decision, 'conflict');
    const review = confirm(workId, c[2], '<p>第三章 梦境内容</p>', [setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true })], '梦境内容', 'dream');
    assert.equal(review.ok, false);
    assert.equal(review.decision, 'needs_review');
    const quoteMiss = confirm(workId, c[2], '<p>第三章 内容</p>', [setOp(cell('character', '王师傅', 'status'), '受伤', { kind: 'value', value: '存活' })], '这句话不在正文里');
    assert.equal(quoteMiss.ok, false);
    assert.equal(quoteMiss.decision, 'needs_review');
    assert.equal(T.temporalOverview(workId).head_commit_id, head0, '任何拒绝都不得推进 HEAD');
    // 上游 pending：第 3 章保存了新正文未确认 → 第 4 章确认被阻塞。
    T.recordContentSave({ workId, chapterId: c[2], contentHtml: '<p>第三章 新稿</p>', origin: { kind: 'manual_save' } });
    const blocked = confirm(workId, c[3], '<p>第四章 内容</p>', [setOp(cell('world_fact', 'x', 'v'), 1)], '内容');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.decision, 'blocked');
    assert.equal(T.temporalOverview(workId).head_commit_id, head0);
  }],
  ['AC-31：状态哈希相同但来源改变 → 下游仍失效（不跳过）', () => {
    const { workId, c } = story(8, '同哈希');
    fill(workId, c, 8, (i) => [setOp(cell('world_fact', `事实${i}`, 'v'), 1)]);
    const head = T.temporalOverview(workId).head_commit_id;
    const plan = T.invalidationPlan({ workId, fromChapterId: c[2], commitId: head, changedCells: [], sameStateHash: true });
    assert.equal(plan.actions.length, 5, '第 4–8 章都在计划中');
    assert.ok(plan.actions.every((a) => a.to === 'stale'), '全部先 stale');
    assert.ok(plan.actions.every((a) => a.reason === 'lineage_changed_state_hash_same'), '哈希相同也按 lineage 处理');
    const applied = T.applyInvalidationPlan(plan);
    assert.equal(applied.changed, 5);
    const overlay = T.trustOverlayOfCommit(head);
    assert.equal(overlay.size, 5, '覆盖行写在**该提交**上，不翻全局 binding');
    for (const chapterId of c.slice(3)) {
      const bindingId = T.manifestOf(T.getCommit(head)).chapters[String(chapterId)];
      assert.equal(T.getBinding(bindingId).validity, 'valid', 'binding 行本身保持 valid（旧提交不受影响）');
    }
    const report = T.trustReport({ workId, commitId: head });
    assert.equal(report.trusted_through, 2);
    assert.equal(report.totals.stale, 5);
  }],
  ['AC-30：跨卷移动 → 新章序版本；从最早差异处失效', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('章序失效', now, now);
    const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
    const mkVol = (title, position) => {
      db.prepare('INSERT INTO volumes (work_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, title, position, now, now);
      return Number(db.prepare('SELECT id FROM volumes ORDER BY id DESC LIMIT 1').get().id);
    };
    const v1 = mkVol('卷一', 0);
    const v2 = mkVol('卷二', 1);
    const mk = (title, volumeId, position) => {
      db.prepare('INSERT INTO chapters (work_id, volume_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(workId, volumeId, title, '<p>内容</p>', position, now, now);
      return Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
    };
    const a = mk('卷一第一章', v1, 0);
    const b = mk('卷一第二章', v1, 1);
    const c1 = mk('卷二第一章', v2, 0);
    enable(workId);
    fill(workId, [a, b, c1], 3, (i) => [setOp(cell('world_fact', `事实${i}`, 'v'), i)]);
    const head = T.temporalOverview(workId).head_commit_id;
    const oldOrder = T.orderOfCommit(T.getCommit(head)).chapters;
    assert.deepEqual(oldOrder, [a, b, c1]);
    db.prepare('UPDATE volumes SET position = ? WHERE id = ?').run(0, v2);
    db.prepare('UPDATE volumes SET position = ? WHERE id = ?').run(1, v1);
    const newOrder = T.listOrder(workId).chapters;
    assert.deepEqual(newOrder, [c1, a, b], '卷序变化 → 章序变化');
    assert.deepEqual(T.orderOfCommit(T.getCommit(head)).chapters, [a, b, c1], '旧提交章序不变');
    const diff = T.earliestOrderDifference(oldOrder, newOrder);
    assert.deepEqual({ index: diff.index, chapter_id: diff.chapter_id }, { index: 0, chapter_id: c1 }, '最早差异 = 位置 0');
    const plan = T.invalidationPlan({ workId, fromChapterId: diff.chapter_id, commitId: head, reason: 'order_changed' });
    assert.equal(plan.from_index, 2, '按提交旧章序定位差异章节');
    const planNew = T.invalidationPlan({ workId, fromChapterId: diff.chapter_id, commitId: head, reason: 'order_changed', orderChapters: newOrder });
    assert.equal(planNew.from_index, 0);
    assert.equal(planNew.totals.will_stale, 2, '按新章序：差异点之后已有绑定的章节进入 stale');
    const v2nd = T.ensureOrderVersion(workId);
    assert.equal(v2nd.reused, false);
  }],
  ['AC-37：未来才登记的角色不出现在更早章节的状态里', () => {
    const { workId, c } = story(6, '未来泄漏');
    fill(workId, c, 6, (i) => (i === 5
      ? [setOp(cell('character', '未来角色', 'alive'), true)]
      : [setOp(cell('world_fact', `事实${i}`, 'v'), i)]));
    const before6 = T.stateBefore({ workId, chapterId: c[5] });
    assert.ok(!Object.keys(before6.state_json).some((k) => k.includes('未来角色')), '第 6 章前不得出现未来角色');
    const after5 = T.stateAt({ workId, chapterId: c[4], boundary: 'after' });
    assert.ok(!Object.keys(after5.state_json).some((k) => k.includes('未来角色')));
    const panel5 = T.chapterPanel({ workId, chapterId: c[4] });
    assert.ok(!panel5.characters.some((x) => x.entity_id === '未来角色'));
    const after6 = T.stateAt({ workId, chapterId: c[5], boundary: 'after' });
    assert.equal(after6.state_json[key('character', '未来角色', 'alive')], true, '第 6 章后才可见');
  }],
  ['未启用作品：零写入、零接管', () => {
    const { workId, chapterIds } = seedWork(db, { title: '未启用', chapters: 2 });
    const r = T.recordContentSave({ workId, chapterId: chapterIds[0], contentHtml: '<p>新</p>', origin: { kind: 'manual' } });
    assert.equal(r.enabled, false);
    assert.equal(r.recorded, false);
    const a = T.applyChapterEvents({ workId, chapterId: chapterIds[0], events: [setOp(cell('world_fact', 'x', 'v'), 1)] });
    assert.equal(a.ok, false);
    assert.equal(a.decision, 'disabled');
    const panel = T.chapterPanel({ workId, chapterId: chapterIds[0] });
    assert.equal(panel.enabled, false);
    for (const table of ['story_chapter_revisions', 'story_state_events', 'story_chapter_bindings', 'story_commits', 'story_chapter_order_versions', 'chapter_state_snapshots']) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE work_id = ?`).get(workId).n;
      assert.equal(Number(n), 0, `${table} 不得有该作品的行`);
    }
    assert.equal(T.assertTemporalSchema().ok, true, '时态表结构必须存在');
  }],
]);
