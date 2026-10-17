/**
 * tests/nsdsh/entity-identity.test.mjs —— S05：稳定实体身份（修 F09）。
 *
 * F09 的病灶是"兼容投影按名称关联"：改名丢投影、同名把两个人的状态写到一起。
 * 这里钉住三件事：
 *   ① 改名不改变身份（旧名作为别名仍解析到同一个 canonical 实体）；
 *   ② 同名不误合并（结果必须是 ambiguous，且**不返回**任何 entityId）；
 *   ③ 解析不到就是 missing，不许猜。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from '../temporal/harness.mjs';

isolatedDir('nsdsh-entity-identity-');
const { db } = await import('../../db.js');
const ID = await import('../../ai/story-state/temporal/identity.mjs');

let seq = 0;
function newWork() {
  seq += 1;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(`identity-${seq}`, now, now);
  return Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
}
function addEntity(workId, name, kind = 'character') {
  db.prepare("INSERT INTO story_entities (work_id, kind, canonical_name, status) VALUES (?, ?, ?, 'active')").run(workId, kind, name);
  return Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
}
function addAlias(workId, entityId, alias, { from = null, to = null, kind = 'alias' } = {}) {
  db.prepare(
    'INSERT INTO story_entity_aliases (work_id, entity_id, alias, normalized, kind, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(workId, entityId, alias, ID.normalizeEntityName(alias), kind, from, to);
}

suite('nsdsh/entity-identity', [
  ['S05-01 uid 编解码：ent:<id> 与自增 id 一一对应，非法输入响亮失败', () => {
    assert.equal(ID.entityUidOf(7), 'ent:7');
    assert.equal(ID.parseEntityUid('ent:7'), 7);
    for (const bad of ['7', 'ent:0', 'ent:-1', 'ent:', 'ENT:7', 'ent:7x']) {
      assert.throws(() => ID.parseEntityUid(bad), `应拒绝 ${bad}`);
    }
    for (const bad of [0, -1, 1.5, 'x']) {
      assert.throws(() => ID.entityUidOf(bad), `应拒绝 entityId=${bad}`);
    }
  }],

  ['S05-02 改名不改变身份：旧名走别名仍解析到同一个 canonical 实体', () => {
    const w = newWork();
    const eid = addEntity(w, '老王');
    addAlias(w, eid, '王师傅');
    // 规范名
    const byCanonical = ID.resolveEntity(db, { workId: w, name: '老王' });
    assert.equal(byCanonical.status, 'unique');
    assert.equal(byCanonical.entityId, eid);
    assert.equal(byCanonical.via, 'canonical_name');
    // 旧名（别名）→ **同一个身份**，这是 F09 的核心诉求
    const byAlias = ID.resolveEntity(db, { workId: w, name: '王师傅' });
    assert.equal(byAlias.status, 'unique');
    assert.equal(byAlias.entityId, eid, '改名后旧名必须仍指向同一实体');
    assert.equal(byAlias.uid, byCanonical.uid);
    assert.equal(byAlias.via, 'alias');
    // 规范化对大小写/空白/全角半角不敏感
    assert.equal(ID.resolveEntity(db, { workId: w, name: '  王师傅  ' }).entityId, eid);
  }],

  ['S05-03 同名不误合并：必须 ambiguous，且不得返回 entityId', () => {
    const w = newWork();
    const a = addEntity(w, '小李');
    const b = addEntity(w, '小李');
    assert.notEqual(a, b);
    const r = ID.resolveEntity(db, { workId: w, name: '小李' });
    assert.equal(r.status, 'ambiguous', '同名不同人必须是 ambiguous');
    assert.equal(r.entityId, null, 'F09：歧义时绝不能自动择一（否则两人状态写到一起）');
    assert.equal(r.uid, null);
    assert.deepEqual(r.candidates, [a, b].sort((x, y) => x - y));
  }],

  ['S05-04 解析不到就是 missing，不许猜', () => {
    const w = newWork();
    addEntity(w, '老赵');
    const r = ID.resolveEntity(db, { workId: w, name: '查无此人' });
    assert.equal(r.status, 'missing');
    assert.equal(r.entityId, null);
    assert.deepEqual(r.candidates, []);
    // 空名字也不许崩，如实 missing
    assert.equal(ID.resolveEntity(db, { workId: w, name: '   ' }).status, 'missing');
    // 缺 workId 必须响亮失败
    assert.throws(() => ID.resolveEntity(db, { workId: 0, name: 'x' }), /MISSING_WORK_ID/);
  }],

  ['S05-05 别名只在有效章节区间内可解析（不能用未来的改名解释过去的事件）', () => {
    const w = newWork();
    const eid = addEntity(w, '老张');
    addAlias(w, eid, '张师傅', { from: 10, to: null });
    assert.equal(ID.resolveEntity(db, { workId: w, name: '张师傅', chapterIndex: 3 }).status, 'missing',
      '第 3 章时这个别名还不存在');
    assert.equal(ID.resolveEntity(db, { workId: w, name: '张师傅', chapterIndex: 10 }).status, 'unique');
    assert.equal(ID.resolveEntity(db, { workId: w, name: '张师傅', chapterIndex: 99 }).status, 'unique');
  }],

  ['S05-06 合并（merged_into）后名字归属合并后的实体，而不是被合并的那条', () => {
    const w = newWork();
    const keeper = addEntity(w, '老王');
    const dup = addEntity(w, '王师傅');
    db.prepare('UPDATE story_entities SET merged_into = ? WHERE id = ?').run(keeper, dup);
    const r = ID.resolveEntity(db, { workId: w, name: '王师傅' });
    assert.equal(r.status, 'unique');
    assert.equal(r.entityId, keeper, '合并后应归到存活实体');
    // 合并链不允许成环导致死循环
    db.prepare('UPDATE story_entities SET merged_into = ? WHERE id = ?').run(dup, keeper);
    assert.doesNotThrow(() => ID.resolveEntity(db, { workId: w, name: '老王' }));
  }],

  ['S05-07 旧表行 ↔ 稳定身份是显式绑定，不按名称兜底', () => {
    const w = newWork();
    const eid = addEntity(w, '周掌柜');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO characters (work_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(w, '周掌柜', now, now);
    const cid = Number(db.prepare('SELECT id FROM characters ORDER BY id DESC LIMIT 1').get().id);

    // 未绑定时：不按名字猜
    assert.equal(ID.entityOfLegacyRef(db, { workId: w, refTable: 'characters', refId: cid }), null);
    const link = ID.linkLegacyRef(db, { workId: w, entityId: eid, refTable: 'characters', refId: cid });
    assert.equal(link.ok, true);
    const back = ID.entityOfLegacyRef(db, { workId: w, refTable: 'characters', refId: cid });
    assert.equal(back.entityId, eid);
    assert.equal(back.uid, ID.entityUidOf(eid));
    // 已绑定的不允许被改绑（return ok:false，而不是静默覆盖）
    const again = ID.linkLegacyRef(db, { workId: w, entityId: eid, refTable: 'characters', refId: cid + 999 });
    assert.equal(again.ok, false);
    // 非法 ref_table 必须拒绝
    assert.throws(() => ID.linkLegacyRef(db, { workId: w, entityId: eid, refTable: 'works', refId: 1 }), /INVALID_REF_TABLE/);
  }],
]);
