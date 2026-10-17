/**
 * tests/nsdsh/identity-migration.test.mjs —— S05：身份迁移 **dry-run** 的行为。
 *
 * 迁移是危险动作，所以钉住的三件事都是"不许越界"：
 *   ① dry-run **不写库**（行数前后完全一致）；
 *   ② 歧义/缺失必须进**阻断项**，不能静默跳过、更不能自动择一；
 *   ③ 等价校验和是**确定性**的（同一份数据两次扫描必须一致），否则无法判断"迁移中途被改名"。
 */
import assert from 'node:assert/strict';
import { isolatedDir, suite } from '../temporal/harness.mjs';

isolatedDir('nsdsh-identity-migration-');
const { db } = await import('../../db.js');
const ID = await import('../../ai/story-state/temporal/identity.mjs');

/** 与 scripts/nsdsh/identity-migration.mjs 的 fixture 同构（这里直接建库，不 spawn 子进程）。 */
function buildFixture() {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('mig-fixture', now, now);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  const addEnt = db.prepare("INSERT INTO story_entities (work_id, kind, canonical_name, status) VALUES (?, 'character', ?, 'active')");
  const addAlias = db.prepare('INSERT INTO story_entity_aliases (work_id, entity_id, alias, normalized, kind, valid_from, valid_to) VALUES (?, ?, ?, ?, \'alias\', ?, ?)');
  addEnt.run(workId, '老王');
  const renamed = Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
  addAlias.run(workId, renamed, '王师傅', ID.normalizeEntityName('王师傅'), 0, 5);
  addEnt.run(workId, '小李');
  addEnt.run(workId, '小李'); // 同名不同人
  addEnt.run(workId, '老张');
  const zhang = Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
  addAlias.run(workId, zhang, '张师傅', ID.normalizeEntityName('张师傅'), 10, null);
  return workId;
}

/** 与脚本同一套扫描逻辑（同一份实现语义，便于断言）。 */
function sweep(workId) {
  const probes = [];
  for (const e of db.prepare('SELECT id, canonical_name FROM story_entities WHERE work_id = ? ORDER BY id').all(workId)) {
    probes.push({ source: 'canonical_name', raw: e.canonical_name, expect: Number(e.id) });
  }
  for (const a of db.prepare('SELECT entity_id, alias FROM story_entity_aliases WHERE work_id = ? ORDER BY id').all(workId)) {
    probes.push({ source: 'alias', raw: a.alias, expect: Number(a.entity_id) });
  }
  const blockers = [];
  const preview = [];
  for (const p of probes) {
    const r = ID.resolveEntity(db, { workId, name: p.raw, chapterIndex: null });
    if (r.status === 'ambiguous') blockers.push({ kind: 'AMBIGUOUS', raw: p.raw });
    else if (r.status === 'missing') blockers.push({ kind: 'MISSING', raw: p.raw });
    else if (p.expect && r.entityId !== p.expect) blockers.push({ kind: 'WRONG_TARGET', raw: p.raw });
    else preview.push({ raw: p.raw, to: r.uid });
  }
  const checksum = preview.map((x) => `${x.raw}=>${x.to}`).sort().join('|');
  return { probes, blockers, preview, checksum };
}

function counts() {
  const t = (s) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${s}`).get().n);
  return { entities: t('story_entities'), aliases: t('story_entity_aliases') };
}

suite('nsdsh/identity-migration', [
  ['S05-M1 fixture 扫描结果：改名解析到同一身份、同名进阻断', () => {
    const w = buildFixture();
    const r = sweep(w);
    assert.equal(r.probes.length, 6, `探针数：${r.probes.length}`);
    const byRaw = Object.fromEntries(r.preview.map((p) => [p.raw, p.to]));
    assert.ok(byRaw['老王'] && byRaw['王师傅'], '改名前后都应能解析');
    assert.equal(byRaw['老王'], byRaw['王师傅'], '改名不改变身份');
    assert.equal(r.blockers.filter((b) => b.raw === '小李').length, 2, '两个"小李"都必须阻断');
    assert.ok(!r.preview.some((p) => p.raw === '小李'), '歧义项绝不能进入预览（那等于已经择一了）');
  }],

  ['S05-M2 dry-run 不写库：扫描前后行数完全一致', () => {
    const w = buildFixture();
    const before = counts();
    sweep(w); sweep(w);
    const after = counts();
    assert.deepEqual(after, before, 'dry-run 必须零写入');
  }],

  ['S05-M3 等价校验和是确定性的（同数据两次一致、改名后变化）', () => {
    const w = buildFixture();
    const a = sweep(w).checksum;
    const b = sweep(w).checksum;
    assert.equal(a, b, '同一份数据两次扫描必须得到同一个校验和');
    // 把"张师傅"改成规范名 → 校验和必须变（证明它真的反映身份映射，而不是常量）
    const zhang = db.prepare("SELECT entity_id FROM story_entity_aliases WHERE alias = '张师傅'").get();
    db.prepare("UPDATE story_entity_aliases SET alias = '张老板', normalized = ? WHERE alias = '张师傅'").run(ID.normalizeEntityName('张老板'));
    const c = sweep(w).checksum;
    assert.notEqual(c, a, '身份映射变化后校验和必须变化');
    assert.ok(zhang);
  }],

  ['S05-M4 阻断项为 0 的干净数据：不产生误报', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('mig-clean', now, now);
    const w = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
    db.prepare("INSERT INTO story_entities (work_id, kind, canonical_name, status) VALUES (?, 'character', '甲', 'active')").run(w);
    db.prepare("INSERT INTO story_entities (work_id, kind, canonical_name, status) VALUES (?, 'character', '乙', 'active')").run(w);
    const r = sweep(w);
    assert.equal(r.blockers.length, 0, `干净数据不该有阻断：${JSON.stringify(r.blockers)}`);
    assert.equal(r.preview.length, 2);
    assert.equal(new Set(r.preview.map((p) => p.to)).size, 2, '两个不同实体必须是两个不同 uid');
  }],
]);
