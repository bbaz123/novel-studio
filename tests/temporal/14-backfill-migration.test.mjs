#!/usr/bin/env node
/**
 * tests/temporal/14-backfill-migration.test.mjs —— T7「存量重建、迁移、开关与回退」模块级证据
 * （进程内真实服务 + 临时隔离库；零模型、零计费）。
 *
 * 覆盖：
 *   M1 迁移自检与版本登记：新库表+索引齐备、登记幂等；缺索引 / 缺表一律响亮拒绝（不吞错误继续跑）；
 *   M2 AC-39 存量重建计划：按真实叙事顺序逐章给出状态与出处（reconstructed / generation_context=unknown），
 *      冻结修订不改写正文；没有模型结果时不生成假历史；
 *   M3 AC-39 逐章确认：候选先记（不写正式状态）→ 作者确认 → 章边界快照 + 事后依赖（unknown）→ 可信前缀前进；
 *   M4 AC-40 旧字段最新值 → 待确认 bootstrap 候选（不自动回填成开篇状态）；作者确认才进入初始状态；
 *      拒绝不写任何状态；
 *   M5 AC-41 未启用作品零写入、零模型调用（开关未开时 step / 候选扫描一律拒绝）；启用前告知预算与范围；
 *   M6 AC-42 没有模型结果 → 待分析任务保留（语义状态不得伪装完成）；确定性路径（历史查询 / 保存 / 拒绝）可用；
 *   M7 顺序强制：跳章确认被拒（上游不可信）；补齐后可继续；重复确认幂等；
 *   M8 中途失败可恢复：缺表 → 拒绝开启；恢复对象后继续可用（不重建、不丢数据）。
 *
 * 纪律：NOVELSTUDIO_DATA_DIR 指向 mkdtemp 临时目录；不调用任何真实模型端点；全部作品自建。
 */
import assert from 'node:assert/strict';
import { isolatedDir, seedWork, suiteAsync } from './harness.mjs';

isolatedDir('ns-temporal-backfill-');
const T = await import('../../ai/story-state/temporal/index.mjs');
const M = await import('../../ai/story-state/temporal/migration.mjs');
const { db } = await import('../../db.js');

const now = () => new Date().toISOString();
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const key = (domain, entityId, predicate, scope = 'canon', holderId = null) => T.cellKey(cell(domain, entityId, predicate, scope, holderId));
const setOp = (c, value, expected = { kind: 'missing' }, quote = '') => ({ type: 'set', cell: c, expected, value, evidence: [{ quote, narrative: 'present' }] });
const fakeResponse = (ops) => JSON.stringify({ events: [{ ops }] });
const countOf = (sql, ...p) => Number(db.prepare(sql).get(...p).n);

function setup(title, chapters = 3, { enable = true } = {}) {
  const { workId, chapterIds } = seedWork(db, { title, chapters });
  if (enable) T.setTemporalConfig(workId, { temporal_enabled: true });
  return { workId, chapterIds, c1: chapterIds[0], c2: chapterIds[1], c3: chapterIds[2] };
}

await suiteAsync('temporal/14-backfill-migration', [
  ['M1 迁移自检：表+索引齐备才算 ok；缺索引时响亮拒绝且不制造登记记录', async () => {
    const st0 = M.migrationStatus();
    assert.equal(st0.ok, true, JSON.stringify(st0));
    assert.equal(st0.applied, false);
    const r1 = M.recordMigration({ note: 'M1' });
    assert.equal(r1.applied, true);
    const r2 = M.recordMigration({ note: 'M1-again' });
    assert.equal(r2.applied, true);
    assert.equal(r2.recorded_version, M.TEMPORAL_MIGRATION_VERSION);
    db.exec('DROP INDEX idx_temporal_binding_validity');
    const st1 = M.migrationStatus();
    assert.equal(st1.ok, false);
    assert.deepEqual(st1.missing_indexes, ['idx_temporal_binding_validity']);
    assert.throws(() => M.recordMigration({ note: 'should-fail' }), /TEMPORAL_MIGRATION_INCOMPLETE/);
    const blocked = M.planBackfill({ workId: 1 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.decision, 'blocked');
    db.exec('CREATE INDEX IF NOT EXISTS idx_temporal_binding_validity ON story_chapter_bindings(work_id, validity)');
    assert.equal(M.migrationStatus().ok, true);
    assert.equal(M.recordMigration({ note: 'M1-restored' }).applied, true);
  }],

  ['M2 AC-39 存量重建计划：按叙事顺序 + 出处标注；冻结修订不改写正文；无模型结果不生成假历史', async () => {
    const s = setup('T7-存量计划', 3);
    const before = db.prepare('SELECT content FROM chapters WHERE id = ?').get(s.c1).content;
    const plan = M.planBackfill({ workId: s.workId });
    assert.equal(plan.ok, true);
    assert.equal(plan.totals.chapters, 3);
    assert.equal(plan.totals.missing_revision, 3);
    assert.equal(plan.next_chapter_id, s.c1);
    assert.deepEqual(plan.chapters.map((c) => c.chapter_id), s.chapterIds);
    const first = plan.chapters[0];
    assert.equal(first.provenance.manuscript, 'needs_freeze');
    assert.equal(first.provenance.generation_context, 'unknown');
    assert.equal(first.provenance.support, 'reconstructed');
    assert.match(first.provenance.note, /不伪造原始创作记录/);
    const step = M.backfillStep({ workId: s.workId, chapterId: s.c1 });
    assert.equal(step.ok, true);
    assert.equal(step.status, 'awaiting_extraction');
    assert.equal(step.provenance.generation_context, 'unknown');
    assert.ok(step.prompt && typeof step.prompt.user === 'string' && step.prompt.user.length > 0);
    assert.equal(db.prepare('SELECT content FROM chapters WHERE id = ?').get(s.c1).content, before);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_state_events WHERE work_id = ?', s.workId), 0);
    assert.equal(T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' }).validity, 'pending');
    const plan2 = M.planBackfill({ workId: s.workId });
    assert.equal(plan2.totals.valid, 0);
    assert.equal(plan2.chapters[0].state, 'pending_analysis');
    assert.equal(plan2.chapters[0].provenance.manuscript, 'frozen');
  }],
  ['M3 AC-39 逐章确认：候选不写正式状态 → 作者确认 → 章边界快照 + 事后依赖 → 可信前缀前进', async () => {
    const s = setup('T7-逐章', 3);
    const st = M.backfillStep({
      workId: s.workId, chapterId: s.c1,
      result: fakeResponse([setOp(cell('world_fact', '甲', 'exists'), true, { kind: 'missing' }, '第1章')]),
      provider: 'fake-local',
    });
    assert.equal(st.ok, true, st.reason || '');
    assert.equal(st.status, 'pending_confirm');
    assert.ok(st.proposal && st.proposal.events >= 1);
    const v1 = T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' });
    assert.equal(v1.validity, 'pending');
    assert.equal(v1.state.size, 0);
    const conf = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c1 });
    assert.equal(conf.ok, true, conf.reason || '');
    assert.equal(conf.provenance.support, 'reconstructed');
    assert.equal(conf.trusted_through, 0);
    assert.equal(conf.next_chapter_id, s.c2);
    const v2 = T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' });
    assert.equal(v2.validity, 'valid');
    assert.equal(v2.state.get(key('world_fact', '甲', 'exists')), true);
    assert.ok(countOf('SELECT COUNT(*) n FROM chapter_state_snapshots WHERE work_id = ? AND chapter_id = ?', s.workId, s.c1) >= 2);
    const deps = T.dependenciesOfChapter(s.workId, s.c1);
    const postHoc = deps.find((d) => d.resource_key === 'generation_input:' + s.c1);
    assert.ok(postHoc, '必须记录事后重建依赖');
    assert.equal(postHoc.kind, 'unknown');
    assert.equal(postHoc.dependency.provenance, 'reconstructed');
    assert.match(String(postHoc.dependency.note), /不伪造原始创作记录/);
  }],

  ['M4 AC-40 旧字段最新值只是待确认候选；作者确认（opening）才进入初始状态；拒绝不写状态', async () => {
    const { workId, chapterIds } = seedWork(db, { title: 'T7-bootstrap', chapters: 3 });
    T.setTemporalConfig(workId, { temporal_enabled: true });
    const c1 = chapterIds[0];
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '王师傅', '已战死', now(), now());
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '主角', '存活', now(), now());
    const heroId = Number(db.prepare('SELECT id FROM characters WHERE work_id = ? AND name = ?').get(workId, '主角').id);
    const wangId = Number(db.prepare('SELECT id FROM characters WHERE work_id = ? AND name = ?').get(workId, '王师傅').id);
    db.prepare('INSERT INTO character_relations (work_id, from_character_id, to_character_id, relation, description) VALUES (?, ?, ?, ?, ?)')
      .run(workId, heroId, wangId, '师徒', '练刀之约');
    M.backfillStep({ workId, chapterId: c1 });
    const p = M.planBootstrapCandidates({ workId });
    assert.equal(p.ok, true, p.reason || '');
    assert.equal(p.found, 3);
    assert.equal(p.created, 3);
    assert.equal(p.candidates.filter((c) => c.status === 'pending').length, 3);
    // 关键：没有任何状态被自动写入（第 10 章才死的角色不得变成开篇已死）
    assert.equal(T.stateAt({ workId, chapterId: c1, boundary: 'before' }).state.size, 0);
    assert.equal(T.stateAt({ workId, chapterId: chapterIds[2], boundary: 'after' }).state.size, 0);
    const p2 = M.planBootstrapCandidates({ workId });
    assert.equal(p2.created, 0);
    assert.equal(p2.found, 3);
    const wang = p.candidates.find((c) => c.entity_id === '王师傅');
    assert.equal(wang.status, 'pending');
    assert.equal(wang.value, '已战死');
    const dec = M.decideBootstrapCandidate({ workId, candidateId: wang.candidate_id, decision: 'confirm', effective: 'opening' });
    assert.equal(dec.ok, true, dec.reason || '');
    assert.equal(dec.decision, 'confirmed');
    const initState = T.stateAt({ workId, chapterId: c1, boundary: 'before' });
    assert.equal(initState.initial.applied, true);
    assert.equal(initState.state.get(key('character', '王师傅', 'status')), '已战死');
    assert.equal(T.stateAt({ workId, chapterId: c1, boundary: 'after' }).state.get(key('character', '王师傅', 'status')), '已战死');
    const rel = p.candidates.find((c) => c.domain === 'relation');
    const rej = M.decideBootstrapCandidate({ workId, candidateId: rel.candidate_id, decision: 'reject' });
    assert.equal(rej.ok, true);
    assert.equal(rej.decision, 'rejected');
    assert.equal(T.stateAt({ workId, chapterId: c1, boundary: 'before' }).state.get(key('relation', '主角|王师傅', 'relation')), undefined);
    const again = M.decideBootstrapCandidate({ workId, candidateId: wang.candidate_id, decision: 'confirm' });
    assert.equal(again.reused, true);
  }],
  ['M5 AC-41 未启用作品：零写入、零接管；启用前告知预算与待重建范围', async () => {
    const { workId, chapterIds } = seedWork(db, { title: 'T7-未启用', chapters: 2 });
    const step = M.backfillStep({ workId, chapterId: chapterIds[0] });
    assert.equal(step.ok, false);
    assert.equal(step.enabled, false);
    const boot = M.planBootstrapCandidates({ workId });
    assert.equal(boot.ok, false);
    assert.equal(boot.enabled, false);
    assert.equal(M.backfillStatus({ workId }).config.enabled, false);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_chapter_revisions WHERE work_id = ?', workId), 0);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_state_events WHERE work_id = ?', workId), 0);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_chapter_bindings WHERE work_id = ?', workId), 0);
    const scope = M.enableScope({ workId });
    assert.equal(scope.ok, true);
    assert.equal(scope.config.enabled, false);
    assert.equal(scope.budget.chapters_total, 2);
    assert.equal(scope.budget.model_calls_estimated, 2);
    assert.equal(scope.budget.auto_analysis_default, 'off');
    assert.equal(scope.bootstrap_pending, 0);
    assert.ok(scope.notes.join('').includes('未启用作品'));
    assert.equal(scope.upcoming.length, 2);
  }],

  ['M6 AC-42 没有模型结果 → 待分析任务保留（语义未运行不伪装完成）；确定性路径可用', async () => {
    const s = setup('T7-模型缺失', 2);
    const step = M.backfillStep({ workId: s.workId, chapterId: s.c1 });
    assert.equal(step.status, 'awaiting_extraction');
    assert.equal(step.input_trusted, true);
    const target = T.analysisTarget({ workId: s.workId, chapterId: s.c1 });
    assert.equal(target.status, 'pending');
    assert.notEqual(target.status, 'done');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_state_events WHERE work_id = ?', s.workId), 0);
    const conf = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c1 });
    assert.equal(conf.ok, false);
    assert.equal(conf.decision, 'needs_review');
    const hist = T.stateAt({ workId: s.workId, chapterId: s.c1, boundary: 'after' });
    assert.equal(hist.ok, true);
    assert.equal(hist.validity, 'pending');
    assert.equal(T.migrationStatus().ok, true);
  }],

  ['M7 顺序强制：跳章确认被拒；补齐上游后可继续；重复确认幂等', async () => {
    const s = setup('T7-顺序', 3);
    M.backfillStep({ workId: s.workId, chapterId: s.c1, result: fakeResponse([setOp(cell('world_fact', '甲', 'exists'), true, { kind: 'missing' }, '第1章')]) });
    M.backfillStep({ workId: s.workId, chapterId: s.c3, result: fakeResponse([setOp(cell('world_fact', '丙', 'exists'), true, { kind: 'missing' }, '第3章')]) });
    const jump = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c3 });
    assert.equal(jump.ok, false);
    assert.match(String(jump.reason), /上游|不可信/);
    const c1 = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c1 });
    assert.equal(c1.ok, true, c1.reason || '');
    const anyway = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c3 });
    assert.equal(anyway.ok, false);
    // 顺序：先补第 2 章（冻结 → 抽取 → 确认），再回到第 3 章
    const st2 = M.backfillStep({ workId: s.workId, chapterId: s.c2, result: fakeResponse([setOp(cell('world_fact', '乙', 'exists'), true, { kind: 'missing' }, '第2章')]) });
    assert.equal(st2.ok, true, st2.reason || '');
    const c2 = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c2 });
    assert.equal(c2.ok, true, c2.reason || '');
    const refresh = M.backfillStep({ workId: s.workId, chapterId: s.c3 });
    assert.equal(refresh.status, 'awaiting_extraction');
    assert.equal(refresh.input_trusted, true);
    const st3 = M.backfillStep({ workId: s.workId, chapterId: s.c3, result: fakeResponse([setOp(cell('world_fact', '丙', 'exists'), true, { kind: 'missing' }, '第3章')]) });
    assert.equal(st3.ok, true, st3.reason || '');
    const c3 = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c3 });
    assert.equal(c3.ok, true, c3.reason || '');
    assert.equal(c3.trusted_through >= 1, true);
    const dup = M.confirmBackfillChapter({ workId: s.workId, chapterId: s.c1 });
    assert.equal(dup.ok, true);
    assert.equal(dup.reused, true);
  }],

  ['M8 中途失败可恢复：缺表一律拒绝；恢复对象后继续可用（不重建、不丢数据）', async () => {
    db.exec('ALTER TABLE story_repair_steps RENAME TO story_repair_steps_backup');
    try {
      const st = M.migrationStatus();
      assert.equal(st.ok, false);
      assert.deepEqual(st.missing_tables, ['story_repair_steps']);
      const s = setup('T7-部分迁移', 1);
      const step = M.backfillStep({ workId: s.workId, chapterId: s.c1 });
      assert.equal(step.ok, false);
      assert.equal(step.decision, 'blocked');
      const boot = M.planBootstrapCandidates({ workId: s.workId });
      assert.equal(boot.ok, false);
    } finally {
      db.exec('ALTER TABLE story_repair_steps_backup RENAME TO story_repair_steps');
    }
    assert.equal(M.migrationStatus().ok, true);
    const s2 = setup('T7-部分迁移恢复', 1);
    const ok = M.backfillStep({ workId: s2.workId, chapterId: s2.c1 });
    assert.equal(ok.ok, true, ok.reason || '');
  }],
]);
