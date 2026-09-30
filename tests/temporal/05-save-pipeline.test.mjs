/**
 * T2 保存流水线测试：保存 → 统一提案 → 注入式分析（零计费 fake）→ 作者一次确认原子应用 → 手工更正。
 *
 * 覆盖：AC-13 / AC-22 / AC-25 / AC-29 / AC-42 / AC-43 / AC-44 / AC-45 的模块级证据。
 * HTTP/生产入口（W1–W8）接线证据在 tests/temporal/06-http-save-entries.test.mjs。
 */
import assert from 'node:assert/strict';
import { isolatedDir, seedWork, suiteAsync } from './harness.mjs';

isolatedDir('ns-temporal-save-');
const T = await import('../../ai/story-state/temporal/index.mjs');
const { db } = await import('../../db.js');

const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const key = (domain, entityId, predicate, scope = 'canon', holderId = null) => T.cellKey(cell(domain, entityId, predicate, scope, holderId));
const setOp = (c, value, expected = { kind: 'missing' }, quote = '') => ({ type: 'set', cell: c, expected, value, evidence: [{ quote, narrative: 'present' }] });
const fakeResponse = (ops) => JSON.stringify({ events: [{ ops }] });

function setup(title, chapters = 3) {
  const { workId, chapterIds } = seedWork(db, { title, chapters });
  T.setTemporalConfig(workId, { temporal_enabled: true, auto_analysis_enabled: true });
  return { workId, chapterIds, c1: chapterIds[0], c2: chapterIds[1] };
}
const countOf = (sql, ...params) => Number(db.prepare(sql).get(...params).n);

await suiteAsync('temporal/05-save-pipeline', [
  ['AC-13：保存正文才产生待确认提案；重复保存不产生新修订/新提案', async () => {
    const s = setup('T2-去重');
    const html = '<p>第一章 风起</p>';
    const r1 = T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: html, origin: { kind: 'manual_save' } });
    assert.equal(r1.recorded, true);
    assert.equal(r1.dedup, false);
    assert.equal(T.analysisTarget({ workId: s.workId, chapterId: s.c1 }).status, 'pending');
    const again = T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: html, origin: { kind: 'autosave' } });
    assert.equal(again.recorded, false);
    assert.equal(again.dedup, true);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_chapter_revisions WHERE chapter_id = ?', s.c1), 1);
    assert.equal(countOf("SELECT COUNT(*) n FROM story_chapter_bindings WHERE chapter_id = ? AND validity = 'pending'", s.c1), 1);
    const view = T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' });
    assert.equal(view.validity, 'pending');
    const panel = T.chapterPanel({ workId: s.workId, chapterId: s.c1 });
    assert.equal(panel.binding_validity, 'pending');
  }],

  ['AC-29：纯格式修改（文本哈希不变）沿用既有事件，不重复跑分析', async () => {
    const s = setup('T2-格式');
    const text = '第一章 甲与乙相遇';
    T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: `<p>${text}</p>`, origin: { kind: 'manual_save' } });
    let calls = 0;
    const fake = () => {
      calls += 1;
      return fakeResponse([setOp(cell('world_fact', '甲', 'exists'), true, { kind: 'missing' }, '甲与乙相遇')]);
    };
    const a1 = await T.analyzeChapter({ workId: s.workId, chapterId: s.c1, generate: fake, provider: 'fake' });
    assert.equal(a1.ok, true);
    assert.equal(a1.ran, true);
    assert.equal(calls, 1);
    const conf1 = T.confirmBinding({ workId: s.workId, chapterId: s.c1, bindingId: a1.binding_id });
    assert.equal(conf1.ok, true, conf1.reason || '');
    const fmt = T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: `<p><em>${text}</em></p>`, origin: { kind: 'manual_save' } });
    assert.equal(fmt.recorded, true);
    assert.equal(fmt.format_only, true);
    assert.equal(fmt.carried_events, 1);
    const target = T.analysisTarget({ workId: s.workId, chapterId: s.c1 });
    assert.equal(target.status, 'done');
    const a2 = await T.analyzeChapter({ workId: s.workId, chapterId: s.c1, generate: fake, provider: 'fake' });
    assert.equal(a2.ran, false);
    assert.equal(calls, 1, '格式修改不得重复调用模型');
    const conf2 = T.confirmBinding({ workId: s.workId, chapterId: s.c1, bindingId: target.binding.id });
    assert.equal(conf2.ok, true, conf2.reason || '');
    assert.equal(T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' }).state_json[key('world_fact', '甲', 'exists')], true);
  }],

  ['AC-25：分析结果只是提案（未确认前不写正式状态）；可疑证据只能 needs_review', async () => {
    const s = setup('T2-提案');
    const text = '第一章 王师傅站在青云镇口，主角向他问路。';
    T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: `<p>${text}</p>`, origin: { kind: 'manual_save' } });
    const good = await T.analyzeChapter({
      workId: s.workId, chapterId: s.c1, provider: 'fake', force: true,
      generate: () => fakeResponse([setOp(cell('character', '王师傅', 'location'), '青云镇', { kind: 'missing' }, '王师傅站在青云镇口')]),
    });
    assert.equal(good.ok, true, good.reason || '');
    assert.equal(good.proposal.events, 1);
    const pendingView = T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' });
    assert.equal(pendingView.validity, 'pending', '未确认前不得写正式状态');
    assert.equal(pendingView.state_json[key('character', '王师傅', 'location')], undefined);
    const groups = T.listProposalGroups({ workId: s.workId, chapterId: s.c1 });
    assert.equal(groups.proposals.length, 1);
    assert.equal(groups.proposals[0].status, 'done');
    assert.equal(groups.proposals[0].proposal.by_domain.character, 1);
    const conf = T.confirmBinding({ workId: s.workId, chapterId: s.c1, bindingId: groups.proposals[0].binding_id });
    assert.equal(conf.ok, true, conf.reason || '');
    assert.equal(T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' }).state_json[key('character', '王师傅', 'location')], '青云镇');
    // 第二段：引文找不到 → 逐条报错，确认只能 needs_review，不能自动进正史。
    T.recordContentSave({ workId: s.workId, chapterId: s.c2, contentHtml: '<p>第二章 主角独自赶路。</p>', origin: { kind: 'manual_save' } });
    const bad = await T.analyzeChapter({
      workId: s.workId, chapterId: s.c2, provider: 'fake', force: true,
      generate: () => fakeResponse([setOp(cell('world_fact', '黑风谷', 'exists'), true, { kind: 'missing' }, '这句引文不在正文里')]),
    });
    assert.equal(bad.ok, true, bad.reason || '');
    assert.ok(bad.issues.some((i) => i.code === 'EVIDENCE_QUOTE_NOT_FOUND'), '必须报告引文锚点问题');
    const rejected = T.confirmBinding({ workId: s.workId, chapterId: s.c2, bindingId: bad.binding_id });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.decision, 'needs_review');
    assert.equal(T.stateAt({ workId: s.workId, chapterId: s.c2, boundary: 'after' }).validity, 'pending');
  }],

  ['AC-43：保存新正文后，过期分析结果不得回写', async () => {
    const s = setup('T2-过期');
    T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: '<p>第一章 旧稿</p>', origin: { kind: 'manual_save' } });
    const begun = T.beginAnalysis({ workId: s.workId, chapterId: s.c1 });
    assert.equal(begun.ok, true, begun.reason || '');
    assert.equal(T.analysisTarget({ workId: s.workId, chapterId: s.c1 }).status, 'running');
    T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: '<p>第一章 新稿</p>', origin: { kind: 'manual_save' } });
    const stale = T.completeAnalysis({
      workId: s.workId, chapterId: s.c1, bindingId: begun.binding_id,
      events: [setOp(cell('world_fact', '旧稿事实', 'exists'), true)],
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.decision, 'stale');
    assert.equal(countOf("SELECT COUNT(*) n FROM story_state_events WHERE chapter_id = ?", s.c1), 0, '过期分析不得留下事件');
    assert.equal(T.analysisTarget({ workId: s.workId, chapterId: s.c1 }).status, 'pending', '新稿提案保持待分析');
  }],

  ['AC-44：确认失败不落任何提交（原子回滚）', async () => {
    const s = setup('T2-原子');
    T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: '<p>第一章 空镇</p>', origin: { kind: 'manual_save' } });
    const head0 = T.ensureMainCommit(s.workId).id;
    const a = await T.analyzeChapter({
      workId: s.workId, chapterId: s.c1, provider: 'fake', force: true,
      generate: () => fakeResponse([setOp(cell('world_fact', '甲', 'exists'), true, { kind: 'value', value: true }, '空镇')]),
    });
    assert.equal(a.ok, true, a.reason || '');
    const snapsBefore = countOf('SELECT COUNT(*) n FROM chapter_state_snapshots WHERE chapter_id = ?', s.c1);
    const conf = T.confirmBinding({ workId: s.workId, chapterId: s.c1, bindingId: a.binding_id });
    assert.equal(conf.ok, false);
    assert.equal(conf.decision, 'conflict');
    assert.equal(T.ensureMainCommit(s.workId).id, head0, '失败确认不得推进 HEAD');
    assert.equal(countOf("SELECT COUNT(*) n FROM story_chapter_bindings WHERE chapter_id = ? AND validity = 'valid'", s.c1), 0);
    // T2 起：保存时会落「输入快照」作为提案绑定（§6.1）；失败的确认不得再新增任何快照。
    assert.equal(countOf('SELECT COUNT(*) n FROM chapter_state_snapshots WHERE chapter_id = ?', s.c1), snapsBefore, '失败确认不得新增快照');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_chapter_dependencies WHERE work_id = ?', s.workId), 0);
  }],

  ['AC-45：手工更正走统一命令入口（author_correction），与正文确认同一套校验/提交', async () => {
    const s = setup('T2-更正');
    T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: '<p>第一章 王师傅在青云镇</p>', origin: { kind: 'manual_save' } });
    const corr = T.correctAuthorState({
      workId: s.workId, chapterId: s.c1,
      corrections: [
        { kind: 'character', entity_id: '王师傅', predicate: 'location', value: '青云镇' },
        { kind: 'character', entity_id: '王师傅', predicate: 'alive', value: true },
      ],
      note: '作者在面板上手工更正',
    });
    assert.equal(corr.ok, true, corr.reason || '');
    assert.equal(corr.decision, 'valid');
    assert.equal(corr.correction, true);
    const view = T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' });
    assert.equal(view.validity, 'valid');
    assert.equal(view.state_json[key('character', '王师傅', 'location')], '青云镇');
    assert.equal(view.state_json[key('character', '王师傅', 'alive')], true);
    const bindings = T.listBindings(s.workId, { chapterId: s.c1 });
    assert.ok(bindings.some((b) => (b.contract_ref || {}).source === 'author_correction'), '更正必须留 author_correction 审计');
    const nEvents = countOf('SELECT COUNT(*) n FROM story_state_events WHERE chapter_id = ?', s.c1);
    assert.equal(nEvents, 1);
    const bad = T.correctAuthorState({ workId: s.workId, chapterId: s.c1, corrections: [{ kind: 'unsupported', entity_id: 'x', value: 1 }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.decision, 'rejected');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_state_events WHERE chapter_id = ?', s.c1), nEvents, '被拒更正不得写事件');
  }],

  ['未开启引擎的作品：所有入口 enabled:false 且零写入', async () => {
    const { workId, chapterIds } = seedWork(db, { title: 'T2-未开启', chapters: 2 });
    const r = T.recordContentSave({ workId, chapterId: chapterIds[0], contentHtml: '<p>不应写入</p>' });
    assert.equal(r.enabled, false);
    assert.equal(r.recorded, false);
    const a = await T.analyzeChapter({ workId, chapterId: chapterIds[0], generate: () => '{}' });
    assert.equal(a.enabled, false);
    const conf = T.confirmBinding({ workId, chapterId: chapterIds[0], bindingId: 'bnd_x' });
    assert.equal(conf.enabled, false);
    const corr = T.correctAuthorState({ workId, chapterId: chapterIds[0], corrections: [] });
    assert.equal(corr.enabled, false);
    for (const table of ['story_chapter_revisions', 'story_chapter_bindings', 'story_state_events', 'story_commits', 'chapter_state_snapshots']) {
      assert.equal(countOf(`SELECT COUNT(*) n FROM ${table} WHERE work_id = ?`, workId), 0, `${table} 必须零写入`);
    }
  }],

  ['无模型可用：分析记 not_run（保存与提案不受影响），有模型后可重试', async () => {
    const s = setup('T2-无模型');
    const r = T.recordContentSave({ workId: s.workId, chapterId: s.c1, contentHtml: '<p>第一章 等待模型</p>', origin: { kind: 'manual_save' } });
    assert.equal(r.recorded, true);
    const a = await T.analyzeChapter({ workId: s.workId, chapterId: s.c1, force: true });
    assert.equal(a.ran, false);
    assert.equal(a.status, 'not_run');
    assert.equal(T.analysisTarget({ workId: s.workId, chapterId: s.c1 }).status, 'not_run');
    const panel = T.chapterPanel({ workId: s.workId, chapterId: s.c1 });
    assert.equal(panel.binding_validity, 'pending');
    const retry = await T.analyzeChapter({
      workId: s.workId, chapterId: s.c1, provider: 'fake', force: true,
      generate: () => fakeResponse([setOp(cell('world_fact', '甲', 'exists'), true, { kind: 'missing' }, '等待模型')]),
    });
    assert.equal(retry.ran, true);
    assert.equal(retry.status, 'done');
  }],
]);