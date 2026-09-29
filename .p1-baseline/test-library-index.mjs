#!/usr/bin/env node
/**
 * test-library-index.mjs —— 资料索引（D 模块）的离线单测（零计费、零外联、不连 OpenViking）。
 *
 * 为什么要有它：D 模块「先廉价缩小候选」的关键行为（候选必须按相关性取最相关的前 N 条、
 * 词法分数方向正确、sha256 增量维护、重建幂等）在集成测试里只以计数形式出现；
 * 这里直接对模块断言，防止「LIMIT 先于排序」与「分数方向写反」这类
 * 不会让集成测试变红的缺陷（本次自审抓到并修复过一次）。
 *
 * ⚠️ 语料形状（踩过）：FTS5 的 bm25 使用 IDF=log((N-n+0.5)/(n+0.5))，并在
 * 「目标词出现在过半条目里」时坍缩为 ~1e-6（本地实测）——那时所有分数都≈0、tie-break
 * 落到 uri，测不出排序方向。所以语料必须让目标词是**少数派**：40 篇不含目标词的填充条目
 * 打底，目标词只出现在少数条目里。
 *
 * 覆盖：FTS 可用性探测 / 候选最相关优先（bm25 越负越相关 → lexical_score 越大越相关）/
 * 候选上限有界（≤ candidateLimit，不随库增长）/ 截断发生在相关性排序之后 /
 * 候选只含元数据 + 分数（无正文/摘要/关键词）/ sha256 未变不重写 / 删除同步删 FTS 行 /
 * 重建幂等 / 来源不可读保留 / 非 active 登记行不漏出 / 空查询与无命中的稳定状态码。
 *
 * 用法: node .p1-baseline/test-library-index.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-libindex-'));
process.env.NOVELSTUDIO_DATA_DIR = DIR;
process.env.NOVELSTUDIO_OV_DISABLED = '1'; // 本模块不触网；显式关总闸防意外外联

const { db } = await import('../db.js');
const Index = await import('../ai/library/library-index.mjs');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const insertDoc = db.prepare("INSERT INTO library_docs (scope, work_id, uri, rel, category, slug, title, sha256, bytes, chars, est_chunks, source_path, status, indexed_at) VALUES ('shared', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
let seq = 0;
function addDoc(title, body, { status = 'active' } = {}) {
  seq += 1;
  const uri = `shared/libindex-test/${seq}.md`;
  const info = insertDoc.run(uri, `libindex-test/${seq}.md`, 'reference', `d${seq}`, title, sha(body), Buffer.byteLength(body), body.length, 1);
  const row = Number(info.lastInsertRowid);
  if (status !== 'active') db.prepare('UPDATE library_docs SET status = ? WHERE id = ?').run(status, row);
  return { id: row, uri, title, sha256: sha(body), body, status, category: 'reference', tags: '' };
}
const indexOne = (d) => Index.upsertEntry({ docId: d.id, uri: d.uri, sha256: d.sha256, title: d.title, category: d.category, text: d.body });

console.log('\n【A. FTS 可用性与增量维护】');
const fts = Index.libraryFtsAvailable();
ok('A1 FTS5 可用性可探测（node:sqlite 官方构建应可用；不可用时后续按降级路径断言）', typeof fts === 'boolean', String(fts));

// 语料：40 篇填充（让目标词是少数派，脱离 IDF 退化区）+ 高频/低频目标词条目 + 英文专名条目。
const fillers = [];
for (let i = 0; i < 40; i += 1) fillers.push(addDoc(`填充资料 ${i}`, `第 ${i} 号采风记录：航路、潮汐与灯位，无目标词。`));
const high = addDoc('灵灯采风笔记（高频）', '灵灯 灵灯 灵灯 灵灯 是重点素材。');
const low = addDoc('灵灯侧记（低频）', '灵灯 只在附注里出现一次。');
const named = addDoc('ZQ-EMBER-7 专名档案', '英文专名与中文混合：ZQ-EMBER-7 用于锚点测试。');
const inactive = addDoc('失效条目', 'ZQX9 只在非活跃登记行里出现。', { status: 'missing' });
for (const d of fillers) indexOne(d);

const up1 = indexOne(high);
ok('A2 首写索引：indexed 且版本前进', up1.ok === true && up1.status === 'indexed' && Number(up1.version) >= 1, JSON.stringify(up1));
const versionAfterFirst = Index.libraryIndexVersionInfo().version;
const up2 = indexOne(high);
ok('A3 sha256 未变：跳过重写（D3/F29）且版本不前进',
  up2.ok === true && up2.skipped === true && up2.status === 'unchanged'
    && Index.libraryIndexVersionInfo().version === versionAfterFirst,
  JSON.stringify({ up2, version: Index.libraryIndexVersionInfo().version }));
ok('A4 内容变更（sha 变化）才更新该条并前进版本', (() => {
  const before = Index.libraryIndexVersionInfo().version;
  const nextBody = high.body + ' 新增一行触发 sha 变化。';
  const r = Index.upsertEntry({ docId: high.id, uri: high.uri, sha256: sha(nextBody), title: high.title, category: high.category, text: nextBody });
  return r.ok === true && r.status === 'indexed' && Index.libraryIndexVersionInfo().version > before;
})());
indexOne(low); indexOne(named); indexOne(inactive);

console.log('\n【B. 候选发现：相关性排序、上限、字段面】');
if (!fts) {
  const degraded = Index.queryCandidates({ query: '灵灯' });
  ok('B0 FTS 不可用时的降级路径：index_unavailable、无候选、不抛错',
    degraded.ok === false && degraded.status === 'index_unavailable' && degraded.candidates.length === 0);
} else {
  const q1 = Index.queryCandidates({ query: '灵灯', limit: 12 });
  ok('B1 词法命中只返回含该词的条目（无关填充条目不入候选）',
    q1.ok === true && q1.candidates.length === 2
      && q1.candidates.every((c) => c.doc_id === high.id || c.doc_id === low.id),
    JSON.stringify(q1.candidates.map((c) => c.doc_id)));
  // 排序基准取 FTS5 的原始 bm25（越小越相关 = 越负越相关）：候选顺序必须与它一致，
  // 且 lexical_score 沿该顺序单调递减——这正是「分数方向写反」会失败的断言。
  const rawRankOf = (docId) => Number(db.prepare(`SELECT bm25(library_index_fts) AS r FROM library_index_fts WHERE library_index_fts MATCH ? AND doc_id = ?`).get('"灵灯"', docId).r);
  const expectBestFirst = [high.id, low.id].sort((a, b) => rawRankOf(a) - rawRankOf(b));
  ok('B2 候选顺序 = bm25 最相关优先（越小越相关），且 lexical_score 沿该顺序单调递减、> 0（分数方向回归）',
    q1.candidates.length === 2
      && q1.candidates.map((c) => c.doc_id).join(',') === expectBestFirst.join(',')
      && q1.candidates[0].lexical_score > q1.candidates[1].lexical_score
      && q1.candidates[0].lexical_score > 0.1,
    JSON.stringify({ got: q1.candidates.map((c) => [c.doc_id, c.lexical_score]), expect: expectBestFirst, raw: expectBestFirst.map(rawRankOf) }));
  ok('B3 候选只含元数据 + 分数（不含正文/摘要/关键词：D5 不进入模型输入）',
    q1.candidates.every((c) => Object.keys(c).sort().join(',') === 'category,doc_id,lexical_score,title,uri'),
    JSON.stringify(Object.keys(q1.candidates[0] || {})));

  // 截断发生在排序之后：limit=2 时必须返回**最相关的两条**（star + high），而不是任意两条。
  const star = addDoc('灵灯总纲（最高相关）', '灵灯 灵灯 灵灯 灵灯 灵灯 灵灯 灵灯 灵灯 灵灯 灵灯 核心条目。');
  indexOne(star);
  const qTop = Index.queryCandidates({ query: '灵灯', limit: 2 });
  const expectTop2 = [high.id, low.id, star.id].sort((a, b) => rawRankOf(a) - rawRankOf(b)).slice(0, 2);
  ok('B4 截断前先按相关性排序：limit=2 取到最相关的两条且顺序正确（回归：LIMIT 先于 ORDER BY）',
    qTop.ok === true && qTop.candidates.length === 2
      && qTop.candidates.map((c) => c.doc_id).join(',') === expectTop2.join(','),
    JSON.stringify({ got: qTop.candidates.map((c) => [c.doc_id, c.lexical_score]), expect: expectTop2, raw: expectTop2.map(rawRankOf) }));

  // 上限有界：调用方给再大的 limit 也只能拿到 ≤ candidateLimit 条（不随库增长）。
  const qCap = Index.queryCandidates({ query: '采风', limit: 999 });
  ok('B5 候选上限有界（≤ candidateLimit，不随库增长）',
    qCap.ok === true && qCap.candidates.length === Index.LIBRARY_INDEX.candidateLimit,
    JSON.stringify({ n: qCap.candidates.length, limit: Index.LIBRARY_INDEX.candidateLimit }));

  const qEn = Index.queryCandidates({ query: 'ZQ-EMBER-7' });
  ok('B6 中英混合 / 专名精确匹配：英文专名条目命中且排第一',
    qEn.ok === true && qEn.candidates.length > 0 && qEn.candidates[0].doc_id === named.id,
    JSON.stringify(qEn.candidates.slice(0, 3)));

  const qInactive = Index.queryCandidates({ query: 'ZQX9' });
  ok('B7 非 active 登记行不会从索引侧漏出（JOIN library_docs.status）', qInactive.candidates.length === 0);
}

console.log('\n【C. 删除与重建（幂等）】');
const beforeRemove = Index.libraryIndexVersionInfo().version;
const rm = Index.removeEntry(low.id);
ok('C1 删除同步删索引行与 FTS 行（删除后查询不再命中）',
  rm.ok === true && rm.removed === 1
    && !Index.queryCandidates({ query: '灵灯' }).candidates.some((c) => c.doc_id === low.id));
ok('C2 删除使版本前进（缓存失效判据）', Index.libraryIndexVersionInfo().version > beforeRemove);

const registry = [high, named].map((d) => ({ ...d, status: 'active' }));
const r1 = Index.rebuildFromRegistry(registry, { readText: (d) => d.body });
const vAfterFirst = Index.libraryIndexVersionInfo().version;
const r2 = Index.rebuildFromRegistry(registry, { readText: (d) => d.body });
ok('C3 重建幂等：第一次会清掉不在登记表的行；第二次内容未变时零写入、版本不前进',
  r1.ok === true && r2.ok === true && r2.indexed === registry.length && r2.removed === 0 && r2.kept === 0
    && Index.libraryIndexVersionInfo().version === vAfterFirst,
  JSON.stringify({ r1, r2, vAfterFirst, now: Index.libraryIndexVersionInfo().version }));
ok('C4 来源不可读：保留既有索引行，不假装更新（kept，不误报 indexed）', (() => {
  const r = Index.rebuildFromRegistry(registry, { readText: () => null });
  return r.ok === true && r.kept === registry.length && r.degraded === 0;
})());
ok('C5 登记表收缩：重建清掉不在登记表里的索引行（主表与 FTS 同步）', (() => {
  const r = Index.rebuildFromRegistry([registry[0]], { readText: (d) => d.body });
  const goneMain = !db.prepare('SELECT 1 FROM library_index WHERE doc_id = ?').get(registry[1].id);
  const goneFts = !db.prepare('SELECT 1 FROM library_index_fts WHERE doc_id = ?').get(registry[1].id);
  return r.ok === true && r.removed >= 1 && goneMain && goneFts;
})());

console.log('\n【D. 降级与空结果状态码】');
const qEmpty = Index.queryCandidates({ query: '   ' });
ok('D1 空查询：ok + status=empty + 无候选（不报错、不伪装成 no_hits）',
  qEmpty.ok === true && qEmpty.status === 'empty' && qEmpty.candidates.length === 0, JSON.stringify({ status: qEmpty.status }));
const qNo = Index.queryCandidates({ query: '不存在的检索词 XYZQ' });
ok('D2 无命中：ok + status=no_hits + 无候选',
  qNo.ok === true && qNo.status === 'no_hits' && qNo.candidates.length === 0, JSON.stringify({ status: qNo.status }));
ok('D3 版本信息与 schema 可对账（缓存键判据：schema 取模块常量）', (() => {
  const v = Index.libraryIndexVersionInfo();
  return v.schema === Index.LIBRARY_INDEX_SCHEMA_VERSION && typeof v.version === 'number';
})());

console.log('\n' + '─'.repeat(64));
try { db.close(); } catch { /* 已关闭 */ }
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* Windows 文件锁：留给系统临时目录 */ }
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${pass} 项）`);
