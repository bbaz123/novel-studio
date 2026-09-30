/**
 * T1 领域测试：reducer 前置条件、两种哈希、验证结论矩阵、唯一章序服务。
 * 覆盖 AC-01/03 的纯函数前提与 AC-30 的章序部分。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from './harness.mjs';
isolatedDir('ns-temporal-pure-');
const T = await import('../../ai/story-state/temporal/index.mjs');
const { db } = await import('../../db.js');
function cell(domain, entityId, predicate, scope = 'canon', holderId = null) {
  return { domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) };
}
function ev(id, ops) {
  return { id, ops: ops.map((op) => T.normalizeOp(op)) };
}
suite('temporal/01-pure', [
  ['cellKey 拒绝非法域与缺失 holder', () => {
    assert.throws(() => T.cellKey(cell('nonsense', 'a', 'p')), /INVALID_DOMAIN_OR_SCOPE/);
    assert.throws(() => T.cellKey(cell('knowledge', 'a', 'p', 'character')), /INVALID_HOLDER_ID/);
    const key = T.cellKey(cell('knowledge', 'fact:1', 'state', 'character', '主角'));
    assert.ok(key.includes('主角'));
  }],
  ['normalizeOp 必须带 expected（不许偷偷补写）', () => {
    assert.throws(() => T.normalizeOp({ type: 'set', cell: cell('character', 'a', 'alive'), value: true }), /EXPECTED_VALUE_REQUIRED/);
    const op = T.normalizeOp({ type: 'set', cell: cell('character', 'a', 'alive'), expected: { kind: 'missing' }, value: true });
    assert.equal(op.expected.kind, 'missing');
    assert.equal(op._key, T.cellKey(cell('character', 'a', 'alive')));
  }],
  ['reduceBatch：前置条件失败 → PRECONDITION_FAILED 且 before 不被污染', () => {
    const before = new Map();
    const e1 = ev('e1', [{ type: 'set', cell: cell('character', '王师傅', 'alive'), expected: { kind: 'missing' }, value: true }]);
    const next = T.reduceBatch(before, [e1]);
    assert.equal(next.get(T.cellKey(cell('character', '王师傅', 'alive'))), true);
    assert.equal(before.size, 0, 'before 必须保持空');
    const e2 = ev('e2', [{ type: 'set', cell: cell('character', '王师傅', 'alive'), expected: { kind: 'value', value: false }, value: true }]);
    assert.throws(() => T.reduceBatch(next, [e2]), (e) => e.code === 'PRECONDITION_FAILED');
    assert.equal(next.get(T.cellKey(cell('character', '王师傅', 'alive'))), true, '失败批次不得留下半成品');
  }],
  ['reduceBatch：unset 需要 expected=value 且批内原子', () => {
    const before = new Map([[T.cellKey(cell('task', '寻找王师傅', 'state')), '进行中']]);
    const ok = ev('e1', [
      { type: 'set', cell: cell('task', '寻找王师傅', 'state'), expected: { kind: 'value', value: '进行中' }, value: '完成' },
      { type: 'unset', cell: cell('task', '寻找王师傅', 'state'), expected: { kind: 'value', value: '完成' } },
    ]);
    const after = T.reduceBatch(before, [ok]);
    assert.equal(after.size, 0);
    const bad = ev('e2', [
      { type: 'set', cell: cell('task', 'x', 'state'), expected: { kind: 'missing' }, value: 1 },
      { type: 'set', cell: cell('task', 'y', 'state'), expected: { kind: 'value', value: 999 }, value: 1 },
    ]);
    assert.throws(() => T.reduceBatch(before, [bad]), (e) => e.code === 'PRECONDITION_FAILED');
  }],
  ['state_content_hash 与 lineage_hash 严格分开（AC-31 的基础）', () => {
    const state = new Map([[T.cellKey(cell('character', '王师傅', 'alive')), true]]);
    const h1 = T.stateContentHash(state);
    const l1 = T.lineageHash({ commitId: 'c1', revisionIds: ['r1'], eventHashes: ['e1'], orderVersionId: 'o1', algorithmVersion: 'v1' });
    const l2 = T.lineageHash({ commitId: 'c2', revisionIds: ['r2'], eventHashes: ['e1'], orderVersionId: 'o1', algorithmVersion: 'v1' });
    assert.equal(h1, T.stateContentHash(state), '同内容同哈希');
    assert.notEqual(l1, l2, '来源改变 → lineage 改变');
  }],
  ['validationDecision：缺检查/上游不可信都不得当 valid', () => {
    assert.equal(T.validationDecision({ upstreamTrusted: false, coverageComplete: true }), 'blocked');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: true, conflicts: [{ code: 'X' }] }), 'conflict');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: false, unresolved: [] }), 'needs_review');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: true, unresolved: [{ code: 'X' }] }), 'needs_review');
    assert.equal(T.validationDecision({ upstreamTrusted: true, coverageComplete: true }), 'valid');
  }],
  ['唯一章序：卷→根章节→场景（含跨卷与未分卷兜底）', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('序测试', now, now);
    const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
    db.prepare('INSERT INTO volumes (work_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '卷一', 0, now, now);
    const v1 = Number(db.prepare('SELECT id FROM volumes ORDER BY id DESC LIMIT 1').get().id);
    db.prepare('INSERT INTO volumes (work_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '卷二', 1, now, now);
    const v2 = Number(db.prepare('SELECT id FROM volumes ORDER BY id DESC LIMIT 1').get().id);
    const mk = (title, volumeId, parentId, position) => {
      db.prepare('INSERT INTO chapters (work_id, volume_id, parent_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(workId, volumeId, parentId, title, '', position, now, now);
      return Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
    };
    const A = mk('A', v1, null, 0);
    const B = mk('B', v1, null, 1);
    const C = mk('C', v2, null, 0);
    const D = mk('D', null, null, 0);
    const A1 = mk('A-1', v1, A, 0);
    const A2 = mk('A-2', v1, A, 1);
    const A1a = mk('A-1-a', v1, A1, 0);
    const order = T.listOrder(workId);
    assert.deepEqual(order.chapters, [A, B, C, D], '章序 = 卷内根章节 → 未分卷兜底');
    assert.deepEqual(order.scenes[String(A)], [A1, A1a, A2], '场景深度优先（position,id）');
    assert.equal(T.chapterOrderIndexOf(workId, A2), 0, '场景归到父章节');
    assert.deepEqual(T.cursorOfChapter(workId, A2), { chapter_index: 0, scene_index: 2, chapter_id: A2 });
    const v1st = T.ensureOrderVersion(workId);
    const v1again = T.ensureOrderVersion(workId);
    assert.equal(v1again.reused, true, '顺序未变 → 幂等复用');
    // 跨卷移动：把卷二移到卷零 → 顺序变化生成新版本，旧版本保持原样。
    db.prepare('UPDATE volumes SET position = ? WHERE id = ?').run(0, v2);
    db.prepare('UPDATE volumes SET position = ? WHERE id = ?').run(1, v1);
    const v2nd = T.ensureOrderVersion(workId);
    assert.equal(v2nd.reused, false, '顺序变化 → 新版本');
    assert.notEqual(v2nd.id, v1st.id);
    assert.deepEqual(T.getOrderVersion(v1st.id).parsed.chapters, [A, B, C, D], '旧版本不被新顺序改写');
    assert.deepEqual(T.getOrderVersion(v2nd.id).parsed.chapters, [C, A, B, D], '新版本按新卷序');
  }],
  ['orderOfCommit 使用提交自己的章序版本（历史不被改写）', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('序测试2', now, now);
    const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
    const mk = (title, position) => {
      db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(workId, title, '', position, now, now);
      return Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
    };
    const a = mk('a', 0);
    const b = mk('b', 1);
    T.setTemporalConfig(workId, { temporal_enabled: true });
    const commit = T.ensureMainCommit(workId);
    const orderV1 = T.orderOfCommit(commit);
    assert.deepEqual(orderV1.chapters, [a, b]);
    const c = mk('c', 0);
    db.prepare('UPDATE chapters SET position = ? WHERE id = ?').run(1, a);
    db.prepare('UPDATE chapters SET position = ? WHERE id = ?').run(2, b);
    assert.deepEqual(T.orderOfCommit(T.getCommit(commit.id)).chapters, [a, b], '旧提交仍按旧顺序');
    void c;
  }],
]);
