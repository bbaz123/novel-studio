/**
 * tests/nsdsh/baseline-contract.test.mjs —— NSDSH S02「基线契约」表征面（零依赖、零计费、零网络）。
 *
 * 目的：把**不得回退的状态机与不变量**钉在**真实离线时态内核**上，而不是钉在方案稿的期望上。
 * 因此这里断言的是当前工作区的**真实行为**：凡是现状与目标不一致的地方（例如 D5 的重放路径），
 * 用例断言的也是现状，并在注释里写明登记编号与修复阶段 —— 「已描述旧行为」不等于「目标正确性已通过」。
 *
 * 覆盖（与 docs/nsdsh/baseline.md §3/§4/§5 对应）：
 *   1. 保存 → pending → 分析 → 确认 的状态机；分析路径**永远到不了** confirmed；
 *   2. 未经确认什么也不应用（正式状态 / HEAD / 兼容投影 / 提交数全不动）；
 *      被拒绝的确认目前**会**留下孤儿事件行（D2，S03 修）—— 如实钉住，不假装已修；
 *   3. 重复应用为 0（幂等重放）；D5 的"重放先于输入/信任复核"如实钉住；
 *   4. 跨作品隔离：A 的状态对 B 既不可见也不可应用；
 *   5. 下游失效保守：无显式依赖也一律先 stale（宁多勿少）；
 *   6. state_content_hash 与 lineage_hash 严格分离（两个方向 + 真实路径）；
 *   7. validationDecision 真值表（含负例）与 validateEventSet 的负例；
 *   8. 作者审批单次消费（模块级；并表征"单次"的原子裁决是受守卫 UPDATE 的受影响行数）。
 *
 * 隔离顺序（本夹具有一个**真实坑**，实测确认）：
 *   `makeIsolatedEnv().install()` 会把 TMPDIR/TEMP/TMP 一并重定向到 `<root>/tmp`，
 *   而 `assertIsolated()` 用 `os.tmpdir()` 判定「数据目录必须在临时目录内」——
 *   install() 之后再断言，就是把 `<root>/data` 与 `<root>/tmp` 比较，必然被拒绝。
 *   所以本文件固定顺序：makeIsolatedEnv → 只设 NOVELSTUDIO_DATA_DIR → assertIsolated() → install()。
 *
 * 用法：node tests/nsdsh/baseline-contract.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, assertIsolated, makeIsolatedEnv } from '../../scripts/nsdsh/lib/isolate.mjs';

const SYSTEM_TMP = os.tmpdir();                    // install() 之前取，之后 os.tmpdir() 会变
const env = makeIsolatedEnv({ label: 'nsdsh-baseline-contract' });
process.env.NOVELSTUDIO_DATA_DIR = env.dataDir;    // 先只设数据目录，让守卫能在 install 之前裁决
assertIsolated();                                  // 未设置 / 指向 <repo>/data / 不在临时目录 → 这里响亮失败
env.install();

// 只在 install() 之后、import db.js / ai/* 之前：这两个模块在 import 时解析数据目录并打开库。
const T = await import('../../ai/story-state/temporal/index.mjs');
const Approvals = await import('../../ai/story-state/approval.mjs');
const { db } = await import('../../db.js');

/** 同步用例；返回 thenable 说明用例其实是异步的——那会让断言抛在汇总之后（计数显示通过、进程却红）。 */
function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') throw new Error('异步用例必须放进 suiteAsync()');
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

/** 异步用例版（analyzeChapter 是 async；语义与 suite 相同）。 */
async function suiteAsync(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────
/** 建一部最小作品（未分卷 → 章序 = position 顺序）；返回稳定 id。 */
function seedWork(title, chapters = 3) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(title, now, now);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  const chapterIds = [];
  for (let i = 0; i < chapters; i += 1) {
    const t = `第${i + 1}章`;
    db.prepare('INSERT INTO chapters (work_id, volume_id, title, content, position, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)')
      .run(workId, t, `<p>${t}</p>`, i, now, now);
    chapterIds.push(Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id));
  }
  return { workId, chapterIds };
}
function enable(workId) { T.setTemporalConfig(workId, { temporal_enabled: true }); }
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const keyOf = (domain, entityId, predicate, scope = 'canon', holderId = null) => T.cellKey(cell(domain, entityId, predicate, scope, holderId));
const setOp = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });
const countOf = (sql, ...params) => Number(db.prepare(sql).get(...params).n);

/** 作者确认一批事件（章前状态为输入；expected 相对章前状态，而不是本章之后）。 */
function confirmChapter({ workId, chapterId, contentHtml = null, ops, quote = '' }) {
  if (contentHtml) T.recordContentSave({ workId, chapterId, contentHtml, origin: { kind: 'nsdsh_seed' } });
  const revision = T.latestRevisionOf(chapterId);
  assert.ok(revision, '确认前必须有正文修订');
  return T.applyChapterEvents({
    workId, chapterId,
    events: [{ cursor: T.cursorOfChapter(workId, chapterId), ops, evidence: [{ revision_id: revision.id, quote, narrative: 'present' }] }],
  });
}
/** 保存 + 确认一章「一个 world_fact」，返回确认回执。 */
function confirmFact(workId, chapterId, n) {
  return confirmChapter({
    workId, chapterId,
    contentHtml: `<p>第${n}章 事实${n}</p>`,
    ops: [setOp(cell('world_fact', `事实${n}`, 'v'), n)],
    quote: `事实${n}`,
  });
}

// ── 同步段：幂等 / 隔离 / 失效 / 哈希 / 判据 / 审批 ───────────────────────────
await suite('nsdsh/baseline-contract', [
  ['隔离前置：数据目录在系统临时目录内，且绝不是 <repo>/data', () => {
    assert.ok(env.dataDir.toLowerCase().startsWith(SYSTEM_TMP.toLowerCase()), `数据目录不在临时目录：${env.dataDir}`);
    assert.notEqual(path.resolve(env.dataDir).toLowerCase(), path.resolve(REPO, 'data').toLowerCase(), '不得指向作者真实库');
    assert.equal(path.resolve(process.env.NOVELSTUDIO_DATA_DIR), path.resolve(env.dataDir));
    assert.equal(env.env.NOVELSTUDIO_OV_DISABLED, '1', '隔离时停用 OpenViking');
  }],

  ['重复应用为 0：同一确认重放不第二次应用正式状态（幂等）', () => {
    const { workId, chapterIds } = seedWork('重复应用', 2);
    enable(workId);
    const c1 = chapterIds[0];
    T.recordContentSave({ workId, chapterId: c1, contentHtml: '<p>第一章 王师傅在青云镇</p>', origin: { kind: 'manual_save' } });
    const pendingId = T.analysisTarget({ workId, chapterId: c1 }).binding.id;
    const done = T.completeAnalysis({
      workId, chapterId: c1, bindingId: pendingId, provider: 'fake',
      events: [{ cursor: T.cursorOfChapter(workId, c1), ops: [setOp(cell('character', '王师傅', 'status'), '在青云镇')], evidence: [{ narrative: 'present' }] }],
    });
    assert.equal(done.ok, true, done.reason || '');
    const first = T.confirmBinding({ workId, chapterId: c1, bindingId: pendingId });
    assert.equal(first.ok, true, first.reason || '');
    assert.equal(first.decision, 'valid');
    const hashAfterFirst = T.stateAt({ workId, chapterId: c1, boundary: 'after' }).state_content_hash;
    const commitsAfterFirst = countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId);
    assert.equal(T.getBinding(pendingId).validity, 'superseded', '确认后旧 pending 绑定转为 superseded（记录不删）');

    // 客户端持有的是**旧提案 id**：重放走 superseded 分支 → 命中同内容同事件集的 valid 绑定。
    const second = T.confirmBinding({ workId, chapterId: c1, bindingId: pendingId });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true, '重放必须走复用回执');
    assert.equal(second.binding_id, first.binding_id, '复用必须指向那个已确认的绑定');
    assert.equal(second.commit_id, first.commit_id, '复用必须指向同一提交');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commitsAfterFirst, '重放不得产生第二个提交');
    assert.equal(T.stateAt({ workId, chapterId: c1, boundary: 'after' }).state_content_hash, hashAfterFirst, '重放不得改变正式状态');

    // 直接拿**已 valid 的绑定**重放：走另一条分支，同样 0 应用。
    const third = T.confirmBinding({ workId, chapterId: c1, bindingId: first.binding_id });
    assert.equal(third.reused, true);
    assert.equal(third.commit_id, first.commit_id);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commitsAfterFirst);
  }],

  ['D5（登记在案，S03 修）：valid 绑定的重放回执先于输入/信任复核返回', () => {
    const { workId, chapterIds } = seedWork('D5 重放', 3);
    enable(workId);
    const [c1, c2] = chapterIds;
    const r1 = confirmFact(workId, c1, 1);
    const r2 = confirmFact(workId, c2, 2);
    assert.equal(r1.ok, true, r1.reason || '');
    assert.equal(r2.ok, true, r2.reason || '');
    assert.notEqual(r1.binding_id, r2.binding_id);

    // 上游第 1 章保存了新正文但尚未确认 → 第 2 章的章前状态已不在连续可信前缀内。
    const save = T.recordContentSave({ workId, chapterId: c1, contentHtml: '<p>第一章 事实1 改</p>', origin: { kind: 'manual_save' } });
    assert.equal(save.recorded, true);
    const before2 = T.stateBefore({ workId, chapterId: c2 });
    assert.equal(before2.trusted, false, '前提：上游已不可信');
    assert.equal(before2.stop && before2.stop.reason, 'pending');

    // 现状（D5 的证据）：重放仍拿到 ok + reused，且**没有**任何输入/信任复核。
    const commits0 = countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId);
    const replay = T.confirmBinding({ workId, chapterId: c2, bindingId: r2.binding_id });
    assert.equal(replay.ok, true);
    assert.equal(replay.reused, true);
    assert.equal(replay.decision, 'valid');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commits0, '重放本身不写库（重复应用仍为 0）');

    // 同一时刻的**新提案**（同样的输入条件）必须被上游阻塞 —— 两条路径结论不一致，就是 D5 本身。
    const fresh = T.recordContentSave({ workId, chapterId: c2, contentHtml: '<p>第二章 事实2 改</p>', origin: { kind: 'manual_save' } });
    assert.equal(fresh.pending_context.input_trusted, false, '新提案如实记录"输入不可信"');
    const freshDone = T.completeAnalysis({
      workId, chapterId: c2, bindingId: fresh.binding_id, provider: 'fake',
      events: [{ cursor: T.cursorOfChapter(workId, c2), ops: [setOp(cell('world_fact', '事实2b', 'v'), 1)], evidence: [{ narrative: 'present' }] }],
    });
    assert.equal(freshDone.ok, true, freshDone.reason || '');
    const blocked = T.confirmBinding({ workId, chapterId: c2, bindingId: fresh.binding_id });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.decision, 'blocked');
    assert.ok((blocked.issues || []).some((i) => i.code === 'UPSTREAM_UNTRUSTED'), JSON.stringify(blocked.issues));
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commits0, '被阻塞的确认不得推进 HEAD');
  }],

  ['D2（S03 已修）：被拒绝的确认整体回滚 —— 零孤儿事件行，且对外回执形状不变', () => {
    // 修改前：applyChapterEvents() 先 insertEvents()，随后 validateEventSet() 失败时**返回对象**而不是抛异常，
    // 事务照常提交 → 库里留下没有 binding 引用的事件行（历史回放看不到它）。
    // S03 之后：同一条路径改为"抛出 → 整体回滚 → 把同一份结论转回调用方"，
    // 因此这里断言两件事同时成立：**回执形状不变** + **一行都没留下**。
    const { workId, chapterIds } = seedWork('D2 孤儿事件', 1);
    enable(workId);
    const ch = chapterIds[0];
    T.recordContentSave({ workId, chapterId: ch, contentHtml: '<p>第一章 事实</p>', origin: { kind: 'manual_save' } });
    const revision = T.latestRevisionOf(ch);
    const head0 = T.temporalOverview(workId).head_commit_id;
    const eventsBefore = countOf('SELECT COUNT(*) n FROM story_state_events WHERE chapter_id = ?', ch);

    const rejected = T.applyChapterEvents({
      workId, chapterId: ch,
      events: [{
        cursor: T.cursorOfChapter(workId, ch),
        // expected 说"当前值是 99"，实际该 cell 不存在 → PRECONDITION_FAILED（硬冲突）。
        ops: [setOp(cell('world_fact', 'P', 'v'), 1, { kind: 'value', value: 99 })],
        evidence: [{ revision_id: revision.id, narrative: 'present' }],
      }],
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.decision, 'conflict');

    // S03 已修的证据：事件行**一行都没多**，HEAD 也没动。
    const eventsAfter = countOf('SELECT COUNT(*) n FROM story_state_events WHERE chapter_id = ?', ch);
    assert.equal(eventsAfter, eventsBefore, 'D2 已修：被拒绝的确认不得留下任何事件行');
    // S03 已修的后半段：既然事件行整体回滚了，就不该再有任何孤儿行 —— 一个都没有。
    const referenced = new Set(T.listBindings(workId, { chapterId: ch, limit: 50 }).flatMap((b) => b.event_ids || []));
    const orphans = db.prepare('SELECT id FROM story_state_events WHERE chapter_id = ?').all(ch)
      .map((r) => String(r.id)).filter((id) => !referenced.has(id));
    assert.deepEqual(orphans, [], 'D2 已修：不得存在任何孤儿事件行');
    // 回执仍然带回它**本会**写入的事件 id（契约形状不变），但这些 id 在库里查不到。
    assert.ok(Array.isArray(rejected.event_ids), 'D2：回执保留 event_ids 字段');
    for (const id of rejected.event_ids) {
      assert.equal(countOf('SELECT COUNT(*) n FROM story_state_events WHERE id = ?', id), 0,
        `D2 已修：回执里的 ${id} 不得真的落库`);
    }

    // 阴性对照：正式状态与 HEAD 都没有被这次失败改动（"没应用"这一半目前是对的）。
    assert.equal(T.temporalOverview(workId).head_commit_id, head0);
    assert.equal(T.stateAt({ workId, chapterId: ch, boundary: 'after' }).validity, 'pending');
    assert.equal(countOf("SELECT COUNT(*) n FROM story_chapter_bindings WHERE chapter_id = ? AND validity = 'valid'", ch), 0);
  }],

  ['跨作品隔离：A 的正式状态对 B 既不可见也不可应用', () => {
    const A = seedWork('隔离 A', 2);
    const B = seedWork('隔离 B', 2);
    enable(A.workId); enable(B.workId);
    const ra = confirmChapter({ workId: A.workId, chapterId: A.chapterIds[0], contentHtml: '<p>第一章 甲</p>', ops: [setOp(cell('world_fact', 'A事实', 'v'), 1)], quote: '第一章 甲' });
    const rb = confirmChapter({ workId: B.workId, chapterId: B.chapterIds[0], contentHtml: '<p>第一章 乙</p>', ops: [setOp(cell('world_fact', 'B事实', 'v'), 2)], quote: '第一章 乙' });
    assert.equal(ra.ok, true, ra.reason || '');
    assert.equal(rb.ok, true, rb.reason || '');

    const sa = T.stateAt({ workId: A.workId, chapterId: A.chapterIds[0], boundary: 'after' });
    const sb = T.stateAt({ workId: B.workId, chapterId: B.chapterIds[0], boundary: 'after' });
    assert.equal(sa.state_json[keyOf('world_fact', 'A事实', 'v')], 1);
    assert.equal(sa.state_json[keyOf('world_fact', 'B事实', 'v')], undefined, 'A 不得看到 B 的事实');
    assert.equal(sb.state_json[keyOf('world_fact', 'B事实', 'v')], 2);
    assert.equal(sb.state_json[keyOf('world_fact', 'A事实', 'v')], undefined, 'B 不得看到 A 的事实');
    assert.notEqual(sa.commit_id, sb.commit_id);
    assert.notEqual(sa.state_content_hash, sb.state_content_hash);

    // 绑定不能跨作品应用；章节也不能跨作品读。
    const headB = T.temporalOverview(B.workId).head_commit_id;
    const cross = T.confirmBinding({ workId: B.workId, chapterId: B.chapterIds[0], bindingId: ra.binding_id });
    assert.equal(cross.ok, false);
    assert.equal(cross.decision, 'rejected');
    assert.equal(T.temporalOverview(B.workId).head_commit_id, headB, '跨作品应用不得推进 B 的 HEAD');
    assert.equal(T.getBinding(ra.binding_id).work_id, A.workId);
    assert.throws(() => T.stateAt({ workId: B.workId, chapterId: A.chapterIds[0], boundary: 'after' }), /章节不属于该作品/);

    // A 的清单里不得出现 B 的章节键。
    const manifestA = T.manifestOf(T.getCommit(T.temporalOverview(A.workId).head_commit_id)).chapters;
    for (const id of B.chapterIds) assert.equal(manifestA[String(id)] === undefined, true, `A 的清单不得包含 B 的章节 ${id}`);
  }],

  ['下游失效保守：无显式依赖也一律先 stale（宁多勿少，绝不静默沿用）', () => {
    const { workId, chapterIds } = seedWork('下游保守失效', 5);
    enable(workId);
    for (let i = 0; i < 5; i += 1) {
      const r = confirmFact(workId, chapterIds[i], i + 1);
      assert.equal(r.ok, true, `第 ${i + 1} 章：${r.reason || ''}`);
    }
    const head0 = T.temporalOverview(workId).head_commit_id;

    // 计划层面：4 个下游全 stale，且没有任何一个命中显式依赖 —— 这就是"保守"的方向。
    const plan = T.invalidationPlan({ workId, fromChapterId: chapterIds[0], commitId: head0, changedCells: [keyOf('world_fact', '事实1', 'v')] });
    assert.equal(plan.totals.downstream, 4);
    assert.equal(plan.totals.will_stale, 4);
    assert.equal(plan.totals.explicit_hits, 0, '没有任何下游章节显式依赖被改的 cell');
    assert.ok(plan.actions.every((a) => a.to === 'stale'), '下游只能先 stale，不能保持 trusted');
    assert.ok(plan.actions.every((a) => a.reason === 'conservative_all_downstream'), JSON.stringify(plan.actions.map((a) => a.reason)));

    // 真正改上游第 1 章（expected 相对章前状态 = 空）。
    const r = confirmChapter({
      workId, chapterId: chapterIds[0],
      contentHtml: '<p>第一章 事实1 改</p>',
      ops: [setOp(cell('world_fact', '事实1', 'v'), 'changed')],
      quote: '事实1 改',
    });
    assert.equal(r.ok, true, r.reason || '');
    assert.equal(r.invalidated.changed, 4, '4 个下游章节被写为 stale');

    // 信任覆盖写在**新提交**上：旧提交不被翻脸（AC-02）。
    assert.equal(T.trustOverlayOfCommit(head0).size, 0, '旧提交没有失效覆盖行');
    assert.equal(T.trustOverlayOfCommit(r.commit_id).size, 4, '失效只挂在新提交的覆盖表上');

    const report = T.trustReport({ workId });
    assert.deepEqual(report.chapters.map((c) => c.validity), ['valid', 'stale', 'stale', 'stale', 'stale']);
    assert.equal(report.trusted_through, 0, '可信前缀断在第 1 章');
    assert.equal(report.totals.valid, 1);
    assert.equal(report.totals.stale, 4);

    // 读取层面：被失效的章节如实报 stale，trusted=false（不得用旧状态冒充）。
    const v3 = T.stateAt({ workId, chapterId: chapterIds[2], boundary: 'after' });
    assert.equal(v3.validity, 'stale');
    assert.equal(v3.trusted, false);
    assert.equal(v3.stop && v3.stop.reason, 'stale');

    // 另一面：旧提交仍然全绿（历史不被改写）。
    const old = T.trustReport({ workId, commitId: head0 });
    assert.equal(old.trusted_through, 4);
    assert.equal(old.totals.valid, 5);
  }],

  ['state_content_hash 与 lineage_hash 分离（同内容不同来源 / 同来源不同内容）', () => {
    const { workId, chapterIds } = seedWork('哈希分离', 1);
    enable(workId);
    const ch = chapterIds[0];
    const base = new Map([[keyOf('world_fact', 'H', 'v'), 1]]);
    const lineageArgs = { orderVersionId: 'ord_nsdsh_probe', commitId: 'cmt_a', revisionIds: ['r1'], eventHashes: ['e1'] };
    const s1 = T.saveSnapshot({ workId, chapterId: ch, state: base, ...lineageArgs });
    const s2 = T.saveSnapshot({ workId, chapterId: ch, state: new Map(base), ...lineageArgs, commitId: 'cmt_b' });
    // ① 同业务内容 + 不同来源
    assert.equal(s1.state_content_hash, s2.state_content_hash, '内容相同 → state hash 相同');
    assert.notEqual(s1.lineage_hash, s2.lineage_hash, '来源不同 → lineage 必须不同');
    assert.notEqual(s1.id, s2.id, '同内容不同来源的快照必须是两条记录');

    // ② 同来源 + 不同业务内容
    const different = new Map([[keyOf('world_fact', 'H', 'v'), 2]]);
    const s3 = T.saveSnapshot({ workId, chapterId: ch, state: different, ...lineageArgs });
    assert.equal(s1.lineage_hash, s3.lineage_hash, '来源相同 → lineage 相同');
    assert.notEqual(s1.state_content_hash, s3.state_content_hash, '内容不同 → state hash 必须不同');

    // ③ 同一输入幂等复用（同内容同来源 → 同 id、reused）
    const s1b = T.saveSnapshot({ workId, chapterId: ch, state: new Map(base), ...lineageArgs });
    assert.equal(s1b.id, s1.id);
    assert.equal(s1b.reused, true);

    // ④ 事件集顺序进入 lineage（同一集合不同顺序 = 不同批次）
    const l1 = T.lineageHash({ commitId: 'c', revisionIds: ['r1', 'r2'], eventHashes: ['e1', 'e2'], orderVersionId: 'o', algorithmVersion: 'a' });
    const l2 = T.lineageHash({ commitId: 'c', revisionIds: ['r2', 'r1'], eventHashes: ['e1', 'e2'], orderVersionId: 'o', algorithmVersion: 'a' });
    assert.notEqual(l1, l2, 'lineage 对顺序敏感');
    assert.equal(T.lineageHash({ orderVersionId: 'o' }), T.lineageHash({ orderVersionId: 'o' }), 'lineageHash 本身是确定性的');
  }],

  ['真实路径：两个作品的正式状态内容相同、lineage 不同（不得只看内容哈希）', () => {
    const A = seedWork('同哈希 A', 1);
    const B = seedWork('同哈希 B', 1);
    enable(A.workId); enable(B.workId);
    const ra = confirmChapter({ workId: A.workId, chapterId: A.chapterIds[0], contentHtml: '<p>第一章 事实</p>', ops: [setOp(cell('world_fact', 'X', 'v'), 1)], quote: '事实' });
    const rb = confirmChapter({ workId: B.workId, chapterId: B.chapterIds[0], contentHtml: '<p>第一章 事实</p>', ops: [setOp(cell('world_fact', 'X', 'v'), 1)], quote: '事实' });
    assert.equal(ra.ok, true, ra.reason || '');
    assert.equal(rb.ok, true, rb.reason || '');
    assert.equal(
      T.stateAt({ workId: A.workId, chapterId: A.chapterIds[0], boundary: 'after' }).state_content_hash,
      T.stateAt({ workId: B.workId, chapterId: B.chapterIds[0], boundary: 'after' }).state_content_hash,
      '业务状态完全一致 → 内容哈希相同',
    );
    const sa = T.getSnapshot(ra.output_snapshot_id);
    const sb = T.getSnapshot(rb.output_snapshot_id);
    assert.notEqual(sa.lineage_hash, sb.lineage_hash, '来源不同 → lineage 必须能区分');
    assert.notEqual(sa.id, sb.id);
    assert.notEqual(ra.commit_id, rb.commit_id);
    assert.notEqual(T.getBinding(ra.binding_id).revision_id, T.getBinding(rb.binding_id).revision_id);
  }],

  ['validationDecision 真值表（含负例：未检查完 / 上游不可信都不得为 valid）', () => {
    assert.equal(T.validationDecision({ upstreamTrusted: false, coverageComplete: true }), 'blocked');
    assert.equal(T.validationDecision({ upstreamTrusted: false, coverageComplete: false }), 'blocked');
    assert.equal(T.validationDecision({ upstreamTrusted: undefined, coverageComplete: true }), 'blocked', '未声明信任 ≠ 已信任');
    assert.equal(T.validationDecision({ upstreamTrusted: null, coverageComplete: true }), 'blocked');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: true, conflicts: [{ code: 'X' }] }), 'conflict');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: false, conflicts: [{ code: 'X' }] }), 'conflict', '硬冲突优先于覆盖率');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: false }), 'needs_review');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: 'yes' }), 'needs_review', '非布尔覆盖率不得当 valid');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: true, unresolved: [{ code: 'U' }] }), 'needs_review');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: true }), 'valid');
    assert.throws(() => T.validationDecision({ upstreamTrusted: true, coverageComplete: true, conflicts: null }), /INVALID_VALIDATION_REPORT/);
  }],

  ['validateEventSet 负例：上游不可信 / 缺证据 / 前置条件冲突 / 回忆叙述', () => {
    const { workId, chapterIds } = seedWork('校验负例', 1);
    enable(workId);
    const ch = chapterIds[0];
    T.recordContentSave({ workId, chapterId: ch, contentHtml: '<p>第一章 事实</p>', origin: { kind: 'manual_save' } });
    const revision = T.latestRevisionOf(ch);
    const store = (ops, narrative = 'present', withEvidence = true) => T.createEvents(
      [{ cursor: T.cursorOfChapter(workId, ch), ops, evidence: withEvidence ? [{ revision_id: revision.id, narrative }] : [] }],
      { workId, chapterId: ch, revisionId: revision.id },
    )[0].id;

    const okEvent = T.getEvent(store([setOp(cell('world_fact', 'P', 'v'), 1)]));
    const okReport = T.validateEventSet({ workId, chapterId: ch, revision, events: [okEvent], inputState: new Map(), upstreamTrusted: true });
    assert.equal(okReport.decision, 'valid');
    assert.equal(okReport.coverage_complete, true);
    assert.equal(okReport.policy.model_self_report_accepted, false, '不采信模型自报布尔值');

    const blocked = T.validateEventSet({ workId, chapterId: ch, revision, events: [okEvent], inputState: new Map(), upstreamTrusted: false });
    assert.equal(blocked.decision, 'blocked', '上游不可信时即使事件完全合法也不得 valid');
    assert.equal(blocked.ok, false);

    const conflict = T.validateEventSet({
      workId, chapterId: ch, revision, events: [okEvent],
      inputState: new Map([[keyOf('world_fact', 'P', 'v'), 99]]), upstreamTrusted: true,
    });
    assert.equal(conflict.decision, 'conflict');
    assert.ok(conflict.conflicts.some((c) => c.code === 'PRECONDITION_FAILED'), JSON.stringify(conflict.conflicts.map((c) => c.code)));

    const noEvidence = T.validateEventSet({
      workId, chapterId: ch, revision, events: [T.getEvent(store([setOp(cell('world_fact', 'Q', 'v'), 1)], 'present', false))],
      inputState: new Map(), upstreamTrusted: true,
    });
    assert.equal(noEvidence.decision, 'needs_review');
    assert.equal(noEvidence.coverage_complete, false, '缺证据 → 覆盖率不成立');
    assert.ok(noEvidence.unresolved.some((u) => u.code === 'EVIDENCE_MISSING'));

    const dream = T.validateEventSet({
      workId, chapterId: ch, revision, events: [T.getEvent(store([setOp(cell('world_fact', 'D', 'v'), 1)], 'dream'))],
      inputState: new Map(), upstreamTrusted: true,
    });
    assert.equal(dream.decision, 'needs_review', '梦境/回忆不得当作当前事实');
    assert.ok(dream.unresolved.some((u) => u.code === 'NARRATIVE_NOT_ASSERTIVE'));
  }],

  ['作者审批单次消费：第二次使用必须被拒绝（模块级，离线、零 HTTP）', () => {
    const { workId, chapterIds } = seedWork('审批单次', 1);
    const c1 = chapterIds[0];
    const ap = Approvals.createApproval({ workId, chapterId: c1, op: 'temporal_apply', baselineHash: 'base-1', binding: { binding_id: 'bnd_probe' }, note: 'nsdsh' });
    assert.equal(ap.status, 'active');
    const need = { op: 'temporal_apply', workId, chapterId: c1, baselineHash: 'base-1', binding: { binding_id: 'bnd_probe' } };

    const first = Approvals.consumeApproval(ap.id, need);
    assert.equal(first.ok, true, first.reason || '');
    const row = Approvals.getApproval(ap.id);
    assert.equal(row.status, 'consumed');
    assert.ok(row.consumed_at, '消费必须留时间戳（审计）');

    const second = Approvals.consumeApproval(ap.id, need);
    assert.equal(second.ok, false, '第二次使用必须被拒绝');
    assert.equal(second.code, 'consumed');
    assert.match(second.reason, /单次|已消费|消费/);

    // 撤销过的审批同样不可用（不同拒绝码，但结论一致）。
    const ap2 = Approvals.createApproval({ workId, chapterId: c1, op: 'temporal_apply', baselineHash: 'base-2', binding: { binding_id: 'bnd_probe' } });
    assert.equal(Approvals.revokeApproval(ap2.id).ok, true);
    const revoked = Approvals.consumeApproval(ap2.id, { ...need, baselineHash: 'base-2' });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.code, 'revoked');
  }],

  ['失败/不匹配的消费不得烧掉审批（op / 作品 / 章节 / 基线逐项拒绝）', () => {
    const { workId, chapterIds } = seedWork('审批不匹配', 2);
    const other = seedWork('审批不匹配-另一部', 1);
    const [c1, c2] = chapterIds;
    const ap = Approvals.createApproval({ workId, chapterId: c1, op: 'temporal_apply', baselineHash: 'base-x', binding: { binding_id: 'bnd_probe' } });
    const gone = () => assert.equal(Approvals.getApproval(ap.id).status, 'active', '失败的消费不得改变状态');
    const attempt = (over) => Approvals.consumeApproval(ap.id, { op: 'temporal_apply', workId, chapterId: c1, baselineHash: 'base-x', binding: { binding_id: 'bnd_probe' }, ...over });

    assert.equal(attempt({ op: 'temporal_correction' }).code, 'op_mismatch'); gone();
    assert.equal(attempt({ workId: other.workId, chapterId: c1 }).code, 'work_mismatch'); gone();
    assert.equal(attempt({ chapterId: c2 }).code, 'chapter_mismatch'); gone();
    assert.equal(attempt({ baselineHash: 'base-changed' }).code, 'baseline_mismatch'); gone();
    assert.equal(attempt({ binding: { binding_id: 'bnd_other' } }).code, 'binding_mismatch'); gone();
    // 一路被拒之后，正确的一次仍然可用（证明前面那些拒绝没有消耗掉它）。
    const good = attempt({});
    assert.equal(good.ok, true, good.reason || '');
    assert.equal(Approvals.getApproval(ap.id).status, 'consumed');
  }],

  ['单次消费的原子裁决 = 受守卫 UPDATE 的受影响行数（SQL 形状表征，**不是**并发复现）', () => {
    // 诚实边界：单线程同步进程里 `getApproval` 读到 active 与随后的 UPDATE 之间无法插入别的写入，
    // 所以 `raced` 分支（受影响行数 = 0）**离线不可达**；本用例只表征"原子裁决就是那条受守卫的
    // UPDATE"，不声称复现了并发抢用。真正的并发/集群复现留给 S04（持久任务 + 租约）。
    const src = fs.readFileSync(fileURLToPath(new URL('../../ai/story-state/approval.mjs', import.meta.url)), 'utf8');
    const guarded = src.match(/UPDATE\s+author_approvals\s+SET\s+[^`]*?WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*'active'/g) || [];
    assert.ok(guarded.length >= 2, `受守卫的状态迁移至少应有 consumed / revoked 两处，实际 ${guarded.length}`);
    assert.ok(guarded.some((s) => s.includes("status = 'consumed'")), '消费必须经 WHERE status=\'active\' 守卫');
    assert.ok(guarded.some((s) => s.includes("status = 'revoked'")), '撤销也必须经同一守卫');
  }],
]);

// ── 异步段：真实分析通道（注入式 fake，绝不触网、不计费）────────────────────
await suiteAsync('nsdsh/baseline-contract（异步：注入式分析通道）', [
  ['状态机：保存 → pending → 分析 → 确认；模型/分析路径永远到不了 confirmed', async () => {
    const { workId, chapterIds } = seedWork('状态机', 2);
    enable(workId);
    const c1 = chapterIds[0];
    assert.equal(T.analysisTarget({ workId, chapterId: c1 }).status, 'no_content', '没有正文时没有可分析对象');

    const text = '第一章 王师傅在青云镇';
    const save = T.recordContentSave({ workId, chapterId: c1, contentHtml: `<p>${text}</p>`, origin: { kind: 'manual_save' } });
    assert.equal(save.recorded, true);
    assert.ok(save.revision_id, '保存必须产生不可变修订');
    assert.ok(save.binding_id, '保存必须产生待确认绑定');
    assert.equal(T.getBinding(save.binding_id).validity, 'pending');
    assert.equal(T.analysisTarget({ workId, chapterId: c1 }).status, 'pending');

    // 分析：走与生产同一条 analyzeChapter 通道（模型适配器注入，零计费）。
    const head0 = T.temporalOverview(workId).head_commit_id;
    const analysed = await T.analyzeChapter({
      workId, chapterId: c1, provider: 'nsdsh-fake', force: true,
      generate: () => JSON.stringify({ events: [{ ops: [setOp(cell('character', '王师傅', 'status'), '在青云镇')], evidence: [{ quote: '王师傅在青云镇', narrative: 'present' }] }] }),
    });
    assert.equal(analysed.ok, true, analysed.reason || '');
    assert.equal(analysed.status, 'done');
    assert.equal(analysed.ran, true);
    assert.equal('decision' in analysed, false, 'completeAnalysis 只返回分析状态，没有 valid/confirmed 这种结论字段');
    assert.equal(T.analysisTarget({ workId, chapterId: c1 }).status, 'done');
    assert.equal(T.getBinding(analysed.binding_id).validity, 'pending', '分析只产生候选，绑定仍是 pending');

    // 未确认期间：没有任何 valid 绑定，也没有 confirmed 这个状态存在过。
    const validities = T.listBindings(workId, { chapterId: c1, limit: 20 }).map((b) => b.validity);
    assert.ok(!validities.includes('valid'), `分析路径不得产出 valid 绑定：${JSON.stringify(validities)}`);
    assert.ok(!validities.includes('confirmed'), '绑定状态里不存在 confirmed（confirmed 只能是作者确认的结果）');
    assert.equal(T.stateAt({ workId, chapterId: c1, boundary: 'after' }).validity, 'pending');
    assert.equal(T.temporalOverview(workId).head_commit_id, head0, '分析与候选不得推进 HEAD');

    // 作者确认：唯一能把状态推进到 valid 的入口。
    const confirmed = T.confirmBinding({ workId, chapterId: c1, bindingId: analysed.binding_id });
    assert.equal(confirmed.ok, true, confirmed.reason || '');
    assert.equal(confirmed.decision, 'valid');
    assert.notEqual(T.temporalOverview(workId).head_commit_id, head0, '确认必须推进 HEAD');
    const view = T.stateAt({ workId, chapterId: c1, boundary: 'after' });
    assert.equal(view.validity, 'valid');
    assert.equal(view.state_json[keyOf('character', '王师傅', 'status')], '在青云镇');
    assert.equal(T.analysisTarget({ workId, chapterId: c1 }).status, 'up_to_date', '确认后没有待确认提案');
  }],

  ['未经确认什么也不应用：正式状态 / 提交数 / HEAD / 兼容投影全不动', async () => {
    const { workId, chapterIds, } = seedWork('未确认不落地', 2);
    enable(workId);
    const c1 = chapterIds[0];
    const now = new Date().toISOString();
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '王师傅', '', now, now);

    T.recordContentSave({ workId, chapterId: c1, contentHtml: '<p>第一章 王师傅受了伤</p>', origin: { kind: 'manual_save' } });
    const before = T.stateAt({ workId, chapterId: c1, boundary: 'before' });
    const commits0 = countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId);
    const head0 = T.temporalOverview(workId).head_commit_id;

    const analysed = await T.analyzeChapter({
      workId, chapterId: c1, provider: 'nsdsh-fake', force: true,
      generate: () => JSON.stringify({ events: [{ ops: [setOp(cell('character', '王师傅', 'status'), '受伤')], evidence: [{ quote: '王师傅受了伤', narrative: 'present' }] }] }),
    });
    assert.equal(analysed.ok, true, analysed.reason || '');

    const after = T.stateAt({ workId, chapterId: c1, boundary: 'after' });
    assert.equal(after.validity, 'pending');
    assert.equal(after.state_json[keyOf('character', '王师傅', 'status')], undefined, '候选事实不得进入正式状态');
    assert.equal(after.state_content_hash, before.state_content_hash, '正式状态的内容哈希必须一字不变');
    assert.equal(T.temporalOverview(workId).head_commit_id, head0);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commits0, '分析不得产生提交');
    assert.equal(countOf("SELECT COUNT(*) n FROM story_chapter_bindings WHERE chapter_id = ? AND validity = 'valid'", c1), 0, '分析不得产出 valid 绑定');
    assert.ok(countOf("SELECT COUNT(*) n FROM story_chapter_bindings WHERE chapter_id = ? AND validity = 'pending'", c1) >= 1, '待确认绑定必须仍在');

    // 兼容旧字段（characters.status）是**已确认状态**的单向投影：候选阶段不得刷新。
    assert.equal(String(db.prepare('SELECT status FROM characters WHERE work_id = ? AND name = ?').get(workId, '王师傅').status), '', '候选阶段不得改写旧字段');
    assert.equal(T.trustReport({ workId }).chapters[0].validity, 'pending');

    // 作者确认之后，同一个字段才被投影。
    const confirmed = T.confirmBinding({ workId, chapterId: c1, bindingId: analysed.binding_id });
    assert.equal(confirmed.ok, true, confirmed.reason || '');
    assert.equal(confirmed.compat.characters_updated, 1);
    assert.equal(String(db.prepare('SELECT status FROM characters WHERE work_id = ? AND name = ?').get(workId, '王师傅').status), '受伤');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commits0 + 1);
  }],
]);

// ── 收尾：关闭句柄 + 删除临时目录（Windows 下句柄不关就删不掉）──────────────
let closed = '';
try { db.close(); closed = 'ok'; } catch (e) { closed = `failed: ${(e && e.message) || e}`; }
await suite('nsdsh/baseline-contract（收尾）', [
  ['db.close() 之后临时数据目录被真正删除，且没有非回环出网记录', () => {
    assert.equal(closed, 'ok', `关闭隔离库失败：${closed}`);
    assert.equal(env.cleanup(), true, `临时目录未被删除：${env.root}`);
    assert.equal(fs.existsSync(env.root), false);
    // 诚实边界：同进程没有装 guard 补丁（NODE_OPTIONS 只对子进程生效），所以"日志为空"
    // 只证明没有留下拒绝记录，不等于"已证明无外网访问"；本套件的无网证据是"从不 import 网络通道 + 注入式 fake"。
    env.assertNoEgress();
  }],
]);
