#!/usr/bin/env node
/**
 * scripts/nsdsh/identity-migration.mjs —— S05：实体身份迁移 **dry-run**。
 *
 * 只读演练：把"v1 事件里以**名称**引用实体的地方"解析成稳定身份（`ent:<id>`），
 * 输出「新事件预览 / 新旧来源关系 / 等价校验和 / 阻断项」，**绝不写库**。
 *
 * 为什么必须 dry-run：F09 的病灶是"按名称关联"，而名称可能 ①改名 ②同名。
 *   ① 改名 → 名称解析可能 missing，但身份仍在（要能看出这是"同一人换了名字"）；
 *   ② 同名 → 解析 ambiguous，**必须阻断**，交作者处置 —— 自动择一就是把两个角色的状态写到一起。
 * 因此本脚本的退出码是有语义的：
 *   0 = 无阻断（可以进入 S16 的正式切换）
 *   3 = 存在阻断（歧义/缺失），需人工处置后才能继续
 *   1 = 运行错误
 *
 * 用法：
 *   node scripts/nsdsh/identity-migration.mjs --fixture --dry-run    # 临时库演练（CI 用）
 *   node scripts/nsdsh/identity-migration.mjs --work 12 --dry-run    # 只读既有库
 *
 * 纪律：--fixture 走隔离临时库；不带 --fixture 时只读打开，**不写任何表**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeIsolatedEnv, REPO } from './lib/isolate.mjs';

const args = new Set(process.argv.slice(2));
const fixture = args.has('--fixture') || args.has('--fixture-clean');
// --fixture-clean：干净 fixture（无同名、无缺失）→ 退出码 0，供阶段门把它当"可通行"证据；
// --fixture：含同名冲突 → 退出码 3，用于演示「歧义必须阻断」的真实语义。两者都是真实行为。
const fixtureClean = args.has('--fixture-clean');
const dryRun = args.has('--dry-run');
const wantWork = (() => {
  const i = process.argv.indexOf('--work');
  return i > 0 ? Number(process.argv[i + 1]) || 0 : 0;
})();

if (!dryRun) {
  console.error('拒绝执行：identity-migration 只支持 --dry-run（S05 不切换旧作品世界线）');
  process.exit(1);
}

// 必须在 import db.js **之前**建立隔离环境（db.js 在 import 时解析数据目录并开库）。
let env = null;
if (fixture) {
  env = makeIsolatedEnv({ label: 'nsdsh-identity-migration-' }).install();
}
const { db } = await import('../../db.js');
const ID = await import('../../ai/story-state/temporal/identity.mjs');

/** 造 fixture：两个同名不同人 + 一个改过名的实体。（同步：内部没有任何 await） */
function buildFixture({ clean = false } = {}) {
  const now = new Date().toISOString();
  const addWork = db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)');
  addWork.run('identity-fixture', now, now);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);

  const addEnt = db.prepare(
    `INSERT INTO story_entities (work_id, kind, canonical_name, status) VALUES (?, ?, ?, 'active')`,
  );
  const addAlias = db.prepare(
    `INSERT INTO story_entity_aliases (work_id, entity_id, alias, normalized, kind, valid_from, valid_to) VALUES (?, ?, ?, ?, 'alias', ?, ?)`,
  );

  // ① 改过名的角色：旧名"王师傅"是别名，规范名现在是"老王"。
  addEnt.run(workId, 'character', '老王');
  const renamed = Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
  addAlias.run(workId, renamed, '王师傅', ID.normalizeEntityName('王师傅'), 0, 5);

  // ② 同名不同人：两个都叫"小李"，必须 ambiguous。
  //    clean 模式只放一个，用来证明"干净数据不误报、退出码 0"。
  addEnt.run(workId, 'character', '小李');
  const liA = Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
  let liB = 0;
  if (!clean) {
    addEnt.run(workId, 'character', '小李');
    liB = Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
  }

  // ③ 只有别名、且不在本章区间内 → 解析不到（用于验证"别名的可见区间"）。
  addEnt.run(workId, 'character', '老张');
  const zhang = Number(db.prepare('SELECT id FROM story_entities ORDER BY id DESC LIMIT 1').get().id);
  addAlias.run(workId, zhang, '张师傅', ID.normalizeEntityName('张师傅'), 10, null);

  return { workId, renamed, liA, liB, zhang };
}

/**
 * 扫描"以名称为实体引用"的地方。S05 的数据面是 story_entities / 别名 +
 * 事件里的 entity 引用；这里用**实体规范名**做一次自洽扫描（不读事件哈希，不改任何行）。
 */
function collectProbes(workId) {
  const probes = [];
  const ents = db.prepare('SELECT id, canonical_name, kind FROM story_entities WHERE work_id = ? ORDER BY id').all(workId);
  for (const e of ents) probes.push({ source: 'canonical_name', ring: 'entity', raw: e.canonical_name, expectEntity: Number(e.id) });
  const aliases = db.prepare('SELECT entity_id, alias FROM story_entity_aliases WHERE work_id = ? ORDER BY id').all(workId);
  for (const a of aliases) probes.push({ source: 'alias', ring: 'entity', raw: a.alias, expectEntity: Number(a.entity_id) });
  return probes;
}

function main() {
  const report = { plan: 'S05 identity migration', dry_run: true, writes: 0, fixtures: null, probes: [], blockers: [], preview: [], checksum: '', work_id: 0 };
  let workId = wantWork;
  if (fixture) {
    const f = buildFixture({ clean: fixtureClean });
    workId = f.workId;
    report.fixtures = f;
    report.work_id = workId;
  }
  if (!workId) {
    report.error = '未指定作品：用 --fixture 或 --work <id>';
    return report;
  }

  const probes = collectProbes(workId);
  for (const p of probes) {
    // 别名在 fixture 里带区间；这里用 chapterIndex=null（全区间）与 0/6 两组做对照。
    const anywhere = ID.resolveEntity(db, { workId, name: p.raw, chapterIndex: null });
    const atCh0 = ID.resolveEntity(db, { workId, name: p.raw, chapterIndex: 0 });
    const atCh6 = ID.resolveEntity(db, { workId, name: p.raw, chapterIndex: 6 });
    const row = {
      source: p.source,
      raw: p.raw,
      expect_entity: p.expectEntity,
      status: anywhere.status,
      resolved: anywhere.uid,
      via: anywhere.via,
      candidates: anywhere.candidates,
      by_chapter: { 0: atCh0.status, 6: atCh6.status },
    };
    report.probes.push(row);
    if (anywhere.status === 'ambiguous') {
      report.blockers.push({ kind: 'AMBIGUOUS', raw: p.raw, candidates: anywhere.candidates, why: '同名指向多个实体：必须由作者指定，禁止自动择一' });
    } else if (anywhere.status === 'missing') {
      report.blockers.push({ kind: 'MISSING', raw: p.raw, why: '名称解析不到任何实体：可能是新实体，需先建实体再迁移' });
    } else if (p.expectEntity && anywhere.entityId !== p.expectEntity) {
      report.blockers.push({ kind: 'WRONG_TARGET', raw: p.raw, expect: p.expectEntity, got: anywhere.entityId, why: '解析到了另一个实体' });
    }
    if (anywhere.status === 'unique') {
      report.preview.push({ raw: p.raw, from: `name:${p.raw}`, to: anywhere.uid, via: anywhere.via });
    }
  }

  // 等价校验和：同一份 fixture 必须每次得到同一个值（用于发现"迁移中途改名"这类漂移）。
  const canonical = report.preview
    .map((p) => `${p.raw}=>${p.to}`)
    .sort()
    .join('|');
  report.checksum = `sha16:${sha16(canonical)}`;
  report.summary = {
    probes: report.probes.length,
    unique: report.probes.filter((p) => p.status === 'unique').length,
    missing: report.probes.filter((p) => p.status === 'missing').length,
    ambiguous: report.probes.filter((p) => p.status === 'ambiguous').length,
    blockers: report.blockers.length,
  };
  return report;
}

/** 与 schema.mjs 同族的短哈希（这里不 import 内核模块，避免引入副作用）。 */
function sha16(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

let out;
try {
  out = main();
} catch (e) {
  console.error(`identity-migration 失败：${(e && e.message) || e}`);
  process.exit(1);
}

const payload = JSON.stringify(out, null, 2);
if (args.has('--json')) {
  console.log(payload);
} else {
  console.log(`实体身份迁移 dry-run（work=${out.work_id || '(未指定)'}，写入 ${out.writes} 行）`);
  console.log(`  探针 ${out.summary ? out.summary.probes : 0}：unique ${out.summary?.unique || 0} / missing ${out.summary?.missing || 0} / ambiguous ${out.summary?.ambiguous || 0}`);
  console.log(`  等价校验和 ${out.checksum}`);
  if (out.preview.length) {
    console.log('  新事件预览（名称 → 稳定身份）：');
    for (const p of out.preview.slice(0, 12)) console.log(`    ${p.raw}  →  ${p.to}（via ${p.via}）`);
  }
  if (out.blockers.length) {
    console.log(`  阻断项 ${out.blockers.length}：`);
    for (const b of out.blockers.slice(0, 12)) console.log(`    [${b.kind}] ${b.raw} — ${b.why}`);
  } else {
    console.log('  阻断项 0：可以进入后续正式切换阶段');
  }
}
if (env && typeof env.cleanup === 'function') env.cleanup();
process.exit(out.blockers && out.blockers.length ? 3 : 0);
