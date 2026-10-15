/**
 * tests/nsdsh/historical-trust.test.mjs —— NSDSH S02「历史 / 来源 / 信任不得混淆」表征面。
 *
 * 三条必须分开的东西（把它们混起来就是本文件要钉住的回归）：
 *   · **业务状态内容**（state_content_hash）—— "现在的内容是不是一样"；
 *   · **来源 lineage**（lineage_hash）—— "这份内容是从哪条修订/事件集/提交来的"；
 *   · **信任**（binding.validity + 提交级覆盖 story_binding_trust）—— "在哪一次提交上才算数"。
 *
 * 覆盖（与 docs/nsdsh/baseline.md §3/§4/§5 对应）：
 *   1. 历史提交在自己的边界上可读（读到的是那次提交的状态，不是最新的）；
 *   2. 同 state hash、不同 lineage ⇒ 不是同一个东西（不得因为内容相同就跳过 lineage 校验）；
 *   3. 信任是**提交级**的：A 处可信的绑定在 B 处可以不可信，反之亦然（不互相继承）；
 *   4. 历史读取看不到未来事实（含投影/面板路径；对应 S07 的"第 20 章不得取得第 80 章事实"）；
 *   5. 作者更正产生**新提交**，不改写历史（旧提交仍逐字可读）；
 *   6. 旧格式兼容投影不会凭空发明信任：候选（pending）事实不得被抬升为已确认；
 *      并钉住 F09（按名称关联）的同名/别名两种表现（F09 → S05 修）。
 *
 * 隔离顺序（本夹具有一个**真实坑**，实测确认）：
 *   `makeIsolatedEnv().install()` 会把 TMPDIR/TEMP/TMP 一并重定向到 `<root>/tmp`，
 *   而 `assertIsolated()` 用 `os.tmpdir()` 判定「数据目录必须在临时目录内」——
 *   install() 之后再断言，就是把 `<root>/data` 与 `<root>/tmp` 比较，必然被拒绝。
 *   所以本文件固定顺序：makeIsolatedEnv → 只设 NOVELSTUDIO_DATA_DIR → assertIsolated() → install()。
 *
 * 用法：node tests/nsdsh/historical-trust.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, assertIsolated, makeIsolatedEnv } from '../../scripts/nsdsh/lib/isolate.mjs';

const SYSTEM_TMP = os.tmpdir();                    // install() 之前取，之后 os.tmpdir() 会变
const env = makeIsolatedEnv({ label: 'nsdsh-historical-trust' });
process.env.NOVELSTUDIO_DATA_DIR = env.dataDir;    // 先只设数据目录，让守卫能在 install 之前裁决
assertIsolated();                                  // 未设置 / 指向 <repo>/data / 不在临时目录 → 这里响亮失败
env.install();

// 只在 install() 之后、import db.js / ai/* 之前。内核只从 index.mjs 进入（项目纪律）。
const T = await import('../../ai/story-state/temporal/index.mjs');
const { db } = await import('../../db.js');

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
const headOf = (workId) => T.temporalOverview(workId).head_commit_id;

function confirmChapter({ workId, chapterId, contentHtml = null, ops, quote = '' }) {
  if (contentHtml) T.recordContentSave({ workId, chapterId, contentHtml, origin: { kind: 'nsdsh_seed' } });
  const revision = T.latestRevisionOf(chapterId);
  assert.ok(revision, '确认前必须有正文修订');
  return T.applyChapterEvents({
    workId, chapterId,
    events: [{ cursor: T.cursorOfChapter(workId, chapterId), ops, evidence: [{ revision_id: revision.id, quote, narrative: 'present' }] }],
  });
}
/** 确认一章「一个 world_fact 内容N」，返回确认回执。 */
function confirmContent(workId, chapterId, n) {
  return confirmChapter({
    workId, chapterId,
    contentHtml: `<p>第${n}章 内容${n}</p>`,
    ops: [setOp(cell('world_fact', `内容${n}`, 'v'), 'v1')],
    quote: `内容${n}`,
  });
}
const contentKey = (n) => keyOf('world_fact', `内容${n}`, 'v');
const hasContent = (view, n) => Object.prototype.hasOwnProperty.call(view.state_json, contentKey(n));

// ── 同步段 ───────────────────────────────────────────────────────────────────
await suite('nsdsh/historical-trust', [
  ['历史提交在自己的边界上可读：读到的是那次提交的状态，不是最新的', () => {
    const { workId, chapterIds } = seedWork('边界提交', 10);
    enable(workId);
    for (let i = 0; i < 5; i += 1) {
      const r = confirmContent(workId, chapterIds[i], i + 1);
      assert.equal(r.ok, true, `第 ${i + 1} 章：${r.reason || ''}`);
    }
    const commit5 = headOf(workId);
    for (let i = 5; i < 10; i += 1) {
      const r = confirmContent(workId, chapterIds[i], i + 1);
      assert.equal(r.ok, true, `第 ${i + 1} 章：${r.reason || ''}`);
    }
    // 第 5 章随后被改写：最新提交里内容5 = v2，而 commit5 里它必须是 v1。
    const rewrite = confirmChapter({
      workId, chapterId: chapterIds[4],
      contentHtml: '<p>第五章 内容5 改</p>',
      ops: [setOp(cell('world_fact', '内容5', 'v'), 'v2')],
      quote: '内容5 改',
    });
    assert.equal(rewrite.ok, true, rewrite.reason || '');
    assert.notEqual(rewrite.commit_id, commit5);

    const at5Commit5 = T.stateAt({ workId, chapterId: chapterIds[4], boundary: 'after', commitId: commit5 });
    assert.equal(at5Commit5.commit_id, commit5, '必须解析到指定的那次提交');
    assert.equal(at5Commit5.applied, 5, '只归约那次提交清单里的 5 章');
    assert.equal(at5Commit5.validity, 'valid');
    assert.equal(at5Commit5.trusted, true);
    assert.equal(at5Commit5.state_json[contentKey(5)], 'v1', '读到的是那次提交的状态');
    assert.equal(hasContent(at5Commit5, 10), false, '那次提交里没有第 10 章的事实');

    const at5Latest = T.stateAt({ workId, chapterId: chapterIds[4], boundary: 'after' });
    assert.notEqual(at5Latest.commit_id, commit5, '不带 commitId 的读取走最新提交');
    assert.equal(at5Latest.state_json[contentKey(5)], 'v2', '最新提交里是改写后的值');
    assert.equal(hasContent(at5Latest, 10), false, '边界读取不得越过第 5 章');

    // 那次提交里"以后才确认的章节"必须如实报 missing，而不是拿最新状态冒充。
    const at10Commit5 = T.stateAt({ workId, chapterId: chapterIds[9], boundary: 'after', commitId: commit5 });
    assert.equal(at10Commit5.validity, 'missing');
    assert.equal(at10Commit5.applied, 5);
    assert.equal(at10Commit5.state_json[contentKey(10)], undefined);
    assert.equal(at10Commit5.stop && at10Commit5.stop.reason, 'missing');

    // 章前边界同样用那次提交的章序：第 5 章章前只有 4 章。
    const before5Commit5 = T.stateAt({ workId, chapterId: chapterIds[4], boundary: 'before', commitId: commit5 });
    assert.equal(before5Commit5.applied, 4);
    assert.equal(before5Commit5.state_json[contentKey(5)], undefined);
  }],

  ['同 state hash、不同 lineage ⇒ 不是同一个东西（不得因内容相同跳过 lineage）', () => {
    const { workId, chapterIds } = seedWork('同内容不同来源', 1);
    enable(workId);
    const ch = chapterIds[0];
    const state = new Map([[keyOf('world_fact', 'SAME', 'v'), 'identical']]);
    // 同一作品里，两份**内容完全相同**的快照，来源（提交 id）不同。
    const lineageA = { orderVersionId: 'ord_nsdsh_x', commitId: 'cmt_lineage_a', revisionIds: ['rev_a'], eventHashes: ['ev_a'] };
    const s1 = T.saveSnapshot({ workId, chapterId: ch, state, ...lineageA });
    const s2 = T.saveSnapshot({ workId, chapterId: ch, state: new Map(state), ...lineageA, commitId: 'cmt_lineage_b' });
    assert.equal(s1.state_content_hash, s2.state_content_hash, '业务内容相同 → content hash 相同');
    assert.notEqual(s1.lineage_hash, s2.lineage_hash, '来源不同 → lineage 必须不同');
    assert.notEqual(s1.id, s2.id, '同内容不同来源必须是两条记录，不能被"内容相同"合并');

    const listed = T.listSnapshots(workId, 100).map((r) => String(r.id));
    assert.ok(listed.includes(s1.id) && listed.includes(s2.id), '两条快照都必须真实存在（内容相同也各自留档）');

    // 事件集顺序也是 lineage 的一部分：同一集合不同顺序 = 不同批次。
    assert.notEqual(T.hashEventSet(['e1', 'e2']), T.hashEventSet(['e2', 'e1']));
    const l1 = T.lineageHash({ commitId: 'c', revisionIds: ['r1'], eventHashes: ['e1', 'e2'], orderVersionId: 'o', algorithmVersion: 'a' });
    const l2 = T.lineageHash({ commitId: 'c', revisionIds: ['r1'], eventHashes: ['e2', 'e1'], orderVersionId: 'o', algorithmVersion: 'a' });
    assert.notEqual(l1, l2, 'lineage 对事件集顺序敏感');

    // 真实路径：两个作品的正式状态内容一字不差，但提交/修订/快照 lineage 全部不同 → 可区分。
    const A = seedWork('同内容 A', 1);
    const B = seedWork('同内容 B', 1);
    enable(A.workId); enable(B.workId);
    const ra = confirmChapter({ workId: A.workId, chapterId: A.chapterIds[0], contentHtml: '<p>第一章 一样的内容</p>', ops: [setOp(cell('world_fact', 'X', 'v'), 1)], quote: '一样的内容' });
    const rb = confirmChapter({ workId: B.workId, chapterId: B.chapterIds[0], contentHtml: '<p>第一章 一样的内容</p>', ops: [setOp(cell('world_fact', 'X', 'v'), 1)], quote: '一样的内容' });
    assert.equal(ra.ok, true, ra.reason || '');
    assert.equal(rb.ok, true, rb.reason || '');
    const va = T.stateAt({ workId: A.workId, chapterId: A.chapterIds[0], boundary: 'after' });
    const vb = T.stateAt({ workId: B.workId, chapterId: B.chapterIds[0], boundary: 'after' });
    assert.equal(va.state_content_hash, vb.state_content_hash, '两个作品的业务状态完全一致');
    const sa = T.getSnapshot(ra.output_snapshot_id);
    const sb = T.getSnapshot(rb.output_snapshot_id);
    assert.notEqual(sa.lineage_hash, sb.lineage_hash);
    assert.notEqual(sa.id, sb.id);
    assert.notEqual(ra.commit_id, rb.commit_id);
    assert.notEqual(T.getBinding(ra.binding_id).revision_id, T.getBinding(rb.binding_id).revision_id);
    assert.notEqual(
      T.getCommit(ra.commit_id).manifest_hash,
      T.getCommit(rb.commit_id).manifest_hash,
      '内容相同也不代表同一份来源：清单哈希同样不同',
    );
  }],

  ['信任是提交级的：A 处可信、B 处不可信，互不继承', () => {
    const { workId, chapterIds } = seedWork('提交级信任', 5);
    enable(workId);
    for (let i = 0; i < 5; i += 1) {
      const r = confirmChapter({ workId, chapterId: chapterIds[i], contentHtml: `<p>第${i + 1}章 事实${i + 1}</p>`, ops: [setOp(cell('world_fact', `事实${i + 1}`, 'v'), i + 1)], quote: `事实${i + 1}` });
      assert.equal(r.ok, true, `第 ${i + 1} 章：${r.reason || ''}`);
    }
    const commitA = headOf(workId);
    const bindingC3 = T.manifestOf(T.getCommit(commitA)).chapters[String(chapterIds[2])];

    // 改写第 1 章 → 新提交 B；第 3 章在 B 上被保守失效。
    const rewrite = confirmChapter({ workId, chapterId: chapterIds[0], contentHtml: '<p>第一章 事实1 改</p>', ops: [setOp(cell('world_fact', '事实1', 'v'), 'changed')], quote: '事实1 改' });
    const commitB = rewrite.commit_id;
    assert.equal(rewrite.ok, true, rewrite.reason || '');
    assert.notEqual(commitA, commitB);

    // 绑定行本身没被翻脸（指针可变、记录不删）；差别只在提交级覆盖上。
    assert.equal(T.getBinding(bindingC3).validity, 'valid');
    assert.equal(T.getBindingTrust(commitA, bindingC3), null, '提交 A 上根本没有覆盖行 → 按 binding 自身 validity 回放');
    const trustB = T.getBindingTrust(commitB, bindingC3);
    assert.equal(trustB && trustB.validity, 'stale', '提交 B 上才有 stale 覆盖');
    assert.equal((trustB.detail || {}).invalidated_by_chapter, chapterIds[0]);

    // 历史读取在 A 上**不得**被 B 的失效污染。
    const atA = T.stateAt({ workId, chapterId: chapterIds[2], boundary: 'after', commitId: commitA });
    assert.equal(atA.validity, 'valid');
    assert.equal(atA.trusted, true);
    const reportA = T.trustReport({ workId, commitId: commitA });
    assert.equal(reportA.trusted_through, 4);
    assert.equal(reportA.totals.valid, 5);
    assert.equal(reportA.totals.stale, 0);
    assert.equal(reportA.chapters[2].own_validity, 'valid');
    assert.equal(reportA.chapters[2].validity, 'valid');

    // 最新提交（B）不得继承 A 的信任。
    const atB = T.stateAt({ workId, chapterId: chapterIds[2], boundary: 'after' });
    assert.equal(atB.validity, 'stale');
    assert.equal(atB.trusted, false);
    const reportB = T.trustReport({ workId });
    assert.equal(reportB.trusted_through, 0);
    assert.equal(reportB.totals.stale, 4);
    assert.equal(reportB.chapters[2].validity, 'stale');
    assert.equal(reportB.chapters[2].own_validity, 'valid', 'own_validity 与 validity 的差别正是提交级覆盖');
  }],

  ['历史读取看不到未来事实（含投影/面板路径）', () => {
    const { workId, chapterIds } = seedWork('未来事实', 10);
    enable(workId);
    for (let i = 0; i < 10; i += 1) {
      const r = confirmContent(workId, chapterIds[i], i + 1);
      assert.equal(r.ok, true, `第 ${i + 1} 章：${r.reason || ''}`);
    }
    const at5 = T.stateAt({ workId, chapterId: chapterIds[4], boundary: 'after' });
    assert.equal(at5.validity, 'valid');
    assert.equal(at5.trusted, true);
    assert.equal(at5.applied, 5);
    assert.equal(hasContent(at5, 10), false, '第 10 章的事实不得出现在第 5 章边界上');
    assert.equal(hasContent(at5, 6), false);
    assert.equal(at5.state_json[contentKey(5)], 'v1');

    // 章前边界同理（写作第 10 章时不得拿到第 10 章自己的事实）。
    const before10 = T.stateBefore({ workId, chapterId: chapterIds[9] });
    assert.equal(before10.applied, 9);
    assert.equal(hasContent(before10, 10), false);
    assert.equal(hasContent(before10, 9), true);

    // 第 9 章边界也看不到第 10 章。
    const at9 = T.stateAt({ workId, chapterId: chapterIds[8], boundary: 'after' });
    assert.equal(hasContent(at9, 10), false);

    // 面板是另一条读取路径（投影）：必须与 stateAt 同一边界，且不得泄漏未来事实。
    const panel5 = T.chapterPanel({ workId, chapterId: chapterIds[4], includeFull: true });
    assert.equal(panel5.validity, 'valid');
    assert.equal(panel5.state_content_hash, at5.state_content_hash, '面板与 stateAt 必须是同一份状态');
    assert.equal(Object.prototype.hasOwnProperty.call(panel5.full_state, contentKey(10)), false, '面板不得泄漏未来事实');
    assert.equal(Object.prototype.hasOwnProperty.call(panel5.full_state, contentKey(6)), false);

    // 到了第 10 章才可见（阴性对照：不是"永远读不到"）。
    const at10 = T.stateAt({ workId, chapterId: chapterIds[9], boundary: 'after' });
    assert.equal(hasContent(at10, 10), true);
  }],

  ['作者更正产生新提交，不改写历史（旧提交与旧修订逐字可读）', () => {
    const { workId, chapterIds } = seedWork('更正留史', 3);
    enable(workId);
    const [c1, c2] = chapterIds;
    const r1 = confirmChapter({ workId, chapterId: c1, contentHtml: '<p>第一章 王师傅存活</p>', ops: [setOp(cell('character', '王师傅', 'status'), '存活')], quote: '王师傅存活' });
    const r2 = confirmChapter({ workId, chapterId: c2, contentHtml: '<p>第二章 赶路</p>', ops: [setOp(cell('world_fact', '赶路', 'v'), 1)], quote: '赶路' });
    assert.equal(r1.ok, true, r1.reason || '');
    assert.equal(r2.ok, true, r2.reason || '');

    const commitOld = headOf(workId);
    const oldManifest = T.manifestOf(T.getCommit(commitOld)).chapters;
    const oldBindingId = oldManifest[String(c2)];
    const oldRevisionId = T.getBinding(oldBindingId).revision_id;
    const oldRevisionHtml = T.getRevision(oldRevisionId).content_html;
    const commitsBefore = countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId);

    const corr = T.correctAuthorState({
      workId, chapterId: c2,
      corrections: [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '受伤' }],
      note: 'nsdsh 表征：作者更正',
    });
    assert.equal(corr.ok, true, corr.reason || '');
    assert.equal(corr.correction, true);
    const commitNew = headOf(workId);
    assert.notEqual(commitNew, commitOld, '更正必须产生新提交，而不是改写旧提交');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_commits WHERE work_id = ?', workId), commitsBefore + 1);

    // 旧提交：状态与清单原样；新提交：更正后的值。
    const oldRead = T.stateAt({ workId, chapterId: c2, boundary: 'after', commitId: commitOld });
    const newRead = T.stateAt({ workId, chapterId: c2, boundary: 'after' });
    assert.equal(oldRead.state_json[keyOf('character', '王师傅', 'status')], '存活', '旧提交必须仍是更正前的值');
    assert.equal(newRead.state_json[keyOf('character', '王师傅', 'status')], '受伤');
    assert.equal(T.manifestOf(T.getCommit(commitOld)).chapters[String(c2)], oldBindingId, '旧提交的清单指针不得被改写');

    // 旧绑定仍是 valid（审计记录保留）；旧修订与正文原样可读。
    assert.equal(T.getBinding(oldBindingId).validity, 'valid');
    assert.equal(T.getBinding(oldBindingId).revision_id, oldRevisionId);
    assert.equal(T.getRevision(oldRevisionId).content_html, oldRevisionHtml, '旧修订正文不得被更正改动');
    // 更正留下 author_correction 审计。
    const newBindingId = T.manifestOf(T.getCommit(commitNew)).chapters[String(c2)];
    assert.notEqual(newBindingId, oldBindingId);
    assert.ok(
      T.listBindings(workId, { chapterId: c2, limit: 20 }).some((b) => (b.contract_ref || {}).source === 'author_correction'),
      '更正必须留 author_correction 审计',
    );
  }],

  ['F09（S05 修）钉住：兼容投影按名称关联 —— 同名两行被一起改写，别名实体断链', () => {
    const { workId, chapterIds } = seedWork('F09 名称关联', 2);
    enable(workId);
    const now = new Date().toISOString();
    // characters 表在 (work_id, name) 上没有唯一约束：项目里可能真的存在两个同名行。
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '王师傅', '甲', now, now);
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '王师傅', '乙', now, now);
    const rows = () => db.prepare('SELECT status FROM characters WHERE work_id = ? AND name = ? ORDER BY id').all(workId, '王师傅').map((r) => String(r.status));

    const r1 = confirmChapter({ workId, chapterId: chapterIds[0], contentHtml: '<p>第一章 王师傅受伤</p>', ops: [setOp(cell('character', '王师傅', 'status'), '受伤')], quote: '王师傅受伤' });
    assert.equal(r1.ok, true, r1.reason || '');
    // F09 现象一：`UPDATE characters … WHERE work_id = ? AND name = ?` 一次命中两行 —— 无法区分两个实体。
    assert.equal(r1.compat.characters_updated, 2, 'F09：同名两行会被一起投影');
    assert.deepEqual(rows(), ['受伤', '受伤']);

    // F09 现象二：正式状态里换了名字/别名（改名、别名、异写）→ 按精确名称匹配不到 → 投影断链。
    const r2 = confirmChapter({ workId, chapterId: chapterIds[1], contentHtml: '<p>第二章 王师傅的师父受伤</p>', ops: [setOp(cell('character', '王师傅（师父）', 'status'), '受伤')], quote: '师父受伤' });
    assert.equal(r2.ok, true, r2.reason || '');
    assert.equal(r2.compat.characters_updated, 0, 'F09：别名实体匹配不到 characters.name');
    assert.equal(
      T.stateAt({ workId, chapterId: chapterIds[1], boundary: 'after' }).state_json[keyOf('character', '王师傅（师父）', 'status')],
      '受伤',
      '正式状态确实有这条事实 —— 断的是兼容投影（F09），不是确认',
    );
    assert.deepEqual(rows(), ['受伤', '受伤'], '别名实体没有把旧字段改错，只是完全没投影');
  }],
]);

// ── 异步段：真实分析通道（注入式 fake，绝不触网、不计费）────────────────────
await suiteAsync('nsdsh/historical-trust（异步：注入式分析通道）', [
  ['兼容投影不发明信任：候选（pending）事实不得被抬升为已确认', async () => {
    const { workId, chapterIds } = seedWork('投影不发明信任', 1);
    enable(workId);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO characters (work_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '王师傅', '', now, now);
    const ch = chapterIds[0];
    const status = () => String(db.prepare('SELECT status FROM characters WHERE work_id = ? AND name = ?').get(workId, '王师傅').status);
    const charRows = () => countOf('SELECT COUNT(*) n FROM characters WHERE work_id = ?', workId);

    T.recordContentSave({ workId, chapterId: ch, contentHtml: '<p>第一章 王师傅受了伤</p>', origin: { kind: 'manual_save' } });
    const analysed = await T.analyzeChapter({
      workId, chapterId: ch, provider: 'nsdsh-fake', force: true,
      generate: () => JSON.stringify({ events: [{ ops: [setOp(cell('character', '王师傅', 'status'), '受伤')], evidence: [{ quote: '王师傅受了伤', narrative: 'present' }] }] }),
    });
    assert.equal(analysed.ok, true, analysed.reason || '');
    assert.equal(T.getBinding(analysed.binding_id).validity, 'pending', '前提：候选仍是 pending');

    // 投影是"把给定 state 单向写出去"的纯读函数：它**不查库里的 pending 绑定**。
    // 因此即使库里有候选事件，用章前（空）状态调用也只会更新 0 行 —— 候选不会被顺手抬升。
    const before = T.stateAt({ workId, chapterId: ch, boundary: 'before' });
    const projected = T.refreshCompatProjection({ workId, state: before.state, commitId: 'cmt_nsdsh_probe' });
    assert.equal(projected.ok, true);
    assert.equal(projected.characters_updated, 0, '空/候选状态不得产生任何旧字段更新');
    assert.equal(status(), '', '候选阶段 characters.status 必须原样不动');
    assert.equal(T.stateAt({ workId, chapterId: ch, boundary: 'after' }).validity, 'pending', '正式状态仍是 pending');

    const rowsBefore = charRows();
    const confirmed = T.confirmBinding({ workId, chapterId: ch, bindingId: analysed.binding_id });
    assert.equal(confirmed.ok, true, confirmed.reason || '');
    // 只有"已确认状态"这条路径会把候选变成旧字段的值。
    assert.equal(confirmed.compat.characters_updated, 1);
    assert.equal(status(), '受伤');
    assert.equal(charRows(), rowsBefore, '投影不得新建角色行（只写已存在的实体）');
  }],
]);

// ── 收尾：关闭句柄 + 删除临时目录 ────────────────────────────────────────────
let closed = '';
try { db.close(); closed = 'ok'; } catch (e) { closed = `failed: ${(e && e.message) || e}`; }
await suite('nsdsh/historical-trust（收尾）', [
  ['db.close() 之后临时数据目录被真正删除，且没有非回环出网记录', () => {
    assert.equal(closed, 'ok', `关闭隔离库失败：${closed}`);
    assert.equal(env.cleanup(), true, `临时目录未被删除：${env.root}`);
    assert.equal(fs.existsSync(env.root), false);
    // 诚实边界：同进程没有装 guard 补丁（NODE_OPTIONS 只对子进程生效），"日志为空"只证明没有留下
    // 拒绝记录；本套件的无网证据是"内核不 import 网络通道 + 模型适配器注入 fake"。
    env.assertNoEgress();
  }],
]);
