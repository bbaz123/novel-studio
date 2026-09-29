#!/usr/bin/env node
/**
 * test-direction-retrieval.mjs —— 「方向驱动检索 + 索引层」的隔离集成测试
 * （零计费：不调用任何真实模型；记忆库用本地 stub）。
 *
 * 覆盖本次三个集成点：
 *   ① 缓存键 = direction hash + 索引版本（含 schema）——
 *     同方向命中、方向变了不命中、索引内容变化后不命中（装配缓存与召回微缓存两层都验）；
 *   ② 检索计划先汇总后装配——novel_index 开/关时 assembled 与 manifest 逐字节一致（E5 保守），
 *     retrieval_plan 只是审计与候选定位，不新增上下文层、不并行直塞；
 *   ③ 「资料召回次数」与「索引查询次数」分开计——
 *     同一响应里 library_recall.searches（真实召回）与 index_queries.total（索引查询）
 *     必须能分别读出：一次召回可以伴随 0 次或多次索引查询，两数不得混算。
 * 另测：defer 不查库、library_enabled=0 时方向不产生任何召回、方向超长按 400 码点截断并进哈希、
 * 恶意 direction 不越权、模型侧不能开关/重建索引（403）。
 *
 * 隔离配方：临时数据目录 + 空闲端口 + 本地 OV stub（find 按 target_uri 分流，绝不外联）。
 * 用法: node .p1-baseline/test-direction-retrieval.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SHARED_LIBRARY_ROOT } from '../ai/library/library-roots.mjs';
import {
  normalizeDirection, directionHashOf, contextCacheKeyOf, contextExternalVersionStringOf,
  normalizeRequestId, normalizeLibraryRecallPhase,
} from '../ai/direction.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PORT = await new Promise((resolvePort) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePort(6700 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
  }).catch(() => resolvePort(6700 + (process.pid % 300)));
});
const OV_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-direction-'));
const SRC_DIR = mkdtempSync(join(tmpdir(), 'novel-direction-src-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════ 0. 纯函数：方向 / 缓存键 / 外部版本串（集成点①的字符串级证明） ══════════════════
// 为什么在集成测试里也钉这一层：缓存键漏掉「索引 schema 版本」这类缺陷，端到端用例未必恰好
// 触发（schema 是模块常量，E2E 里很难改），但键的**组成**可以在这里逐段断言。
console.log('【0. 纯函数：方向规范化 / 哈希 / 缓存键 / 外部版本串（集成点①）】');
{
  ok('C0.1 方向规范化：非字符串视为未提供；控制字符/空白折叠、首尾去空',
    normalizeDirection(null) === '' && normalizeDirection(42) === '' && normalizeDirection('  \u0007甲\n\n乙\t ') === '甲 乙');
  const longDir = Array.from(normalizeDirection('🀄'.repeat(500)));
  ok('C0.2 方向超长按 400 码点截断（代理对不撕裂）', longDir.length === 400 && longDir[399] === '🀄');
  ok('C0.3 方向哈希稳定、可区分（16 hex；空串 → 空串）',
    /^[0-9a-f]{16}$/.test(directionHashOf('甲')) && directionHashOf('甲') === directionHashOf('甲')
      && directionHashOf('甲') !== directionHashOf('乙') && directionHashOf('') === '');
  const dirHash = directionHashOf('甲方向');
  ok('C0.4 装配缓存键：无方向+default 保持旧键形态；有方向/阶段则含 phase 与方向哈希',
    contextCacheKeyOf({ workId: 5, chapterId: 7, mode: 'full' }) === 'novel:5:7:full'
      && contextCacheKeyOf({ workId: 5, chapterId: 7, mode: 'full', phase: 'direction', directionHash: dirHash }) === `novel:5:7:full:direction:${dirHash}`
      && contextCacheKeyOf({ workId: 5, chapterId: 7, mode: 'full', phase: 'defer' }) === 'novel:5:7:full:defer:-');
  ok('C0.5 外部版本串固定含 ov/li/ls/ni/ns 五段（li=资料索引版本、ls=schema；ni/ns 同）',
    contextExternalVersionStringOf({ ovIndexedAt: 'T', libraryIndexVersion: 3, libraryIndexSchema: 1, novelIndexVersion: 2, novelIndexSchema: 1 })
      === 'ov:T|li:3|ls:1|ni:2|ns:1');
  const rid = normalizeRequestId('r\u0007' + '🀄'.repeat(80));
  ok('C0.6 request_id 清理控制字符并按码点截断（64 码点、不撕裂代理对）',
    normalizeRequestId(42) === '' && Array.from(rid).length === 64 && Array.from(rid)[63] === '🀄'
      && normalizeLibraryRecallPhase('bogus') === 'default' && normalizeLibraryRecallPhase('defer') === 'defer');
}

async function jfetch(path, { method = 'GET', body, headers = {}, base = BASE } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/** 组装 /api/novel/context 的查询串（中文一律 URL 编码）。 */
function ctxQuery({ workId, chapterId, direction, phase, source, requestId, mode } = {}) {
  const p = new URLSearchParams();
  if (workId) p.set('work_id', String(workId));
  if (chapterId) p.set('chapter_id', String(chapterId));
  if (mode) p.set('mode', mode);
  if (direction !== undefined) p.set('direction', direction);
  if (phase) p.set('library_recall_phase', phase);
  if (source) p.set('direction_source', source);
  if (requestId) p.set('request_id', requestId);
  return p.toString();
}
const manifestIds = (resp) => (resp.data.context_manifest || []).map((m) => m.id);

// ══════════════════ OV stub（本地；绝不外联） ══════════════════
const stubState = { writes: [], libraryHits: [], novelHits: [], reads: new Map(), libraryFindCalls: 0, allFindCalls: 0, lastLibraryQuery: '' };
const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${OV_PORT}`);
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/health') return send({ status: 'ok', result: { ok: true } });
  if (url.pathname === '/api/v1/search/find') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 非 JSON：按普通召回处理 */ }
      stubState.allFindCalls += 1;
      const isLibrary = body.target_uri === SHARED_LIBRARY_ROOT;
      if (isLibrary) { stubState.libraryFindCalls += 1; stubState.lastLibraryQuery = String(body.query || ''); }
      const hits = isLibrary ? stubState.libraryHits : stubState.novelHits;
      send({ status: 'ok', result: { memories: hits.map((h) => ({ uri: h.uri, score: h.score, abstract: h.abstract || '' })), resources: [], skills: [] } });
    });
    return;
  }
  if (url.pathname === '/api/v1/content/read') return send({ status: 'ok', result: stubState.reads.get(url.searchParams.get('uri')) || '' });
  if (url.pathname === '/api/v1/content/write') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      stubState.writes.push(body);
      stubState.reads.set(body.uri, String(body.content || ''));
      send({ status: 'ok', result: { ok: true } });
    });
    return;
  }
  if (req.method === 'DELETE') return send({ status: 'ok', result: { ok: true } });
  return send({ status: 'ok', result: {} });
});
await new Promise((r) => stub.listen(OV_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVELSTUDIO_DATA_DIR: DATA_DIR,
    NOVELSTUDIO_OV_DISABLED: '0',
    NOVELSTUDIO_OV_AUTOINDEX: '0',
    OPENVIKING_URL: `http://127.0.0.1:${OV_PORT}`,
    OPENVIKING_CREDENTIAL_SOURCE: 'env',
    OPENVIKING_API_KEY: '',
    OPENVIKING_BEARER_TOKEN: '',
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'direction-retrieval-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { stub.close(); } catch { /* 已关闭 */ }
  for (const dir of [DATA_DIR, SRC_DIR]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ } }
};

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await jfetch('/api/novel/ping'); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await sleep(300);
}
if (!ready) {
  console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-1500));
  cleanup();
  process.exit(2);
}

const dbGet = (sql, ...params) => {
  const d = new DatabaseSync(join(DATA_DIR, 'novel.db'));
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...params); } finally { d.close(); }
};
const dbRun = (sql, ...params) => {
  const d = new DatabaseSync(join(DATA_DIR, 'novel.db'));
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).run(...params); } finally { d.close(); }
};

const DIRECTION = '林寻在剑冢面对旧约，决定是否公开真相';try {
  console.log('\n【A. 方向参数：资料库关闭时零召回、零索引查询】');
  const w1 = (await jfetch('/api/works', { method: 'POST', body: { title: '方向检索隔离测试' } })).data.id;
  ok('A0 作品与章节就绪', Number(w1) > 0);
  const ch = await jfetch('/api/chapters', { method: 'POST', body: { work_id: w1, title: '第一章 剑冢对峙', summary: '林寻在剑冢面对旧约', position: 1 } });
  const chapterId = Number(ch.data.id) || 0;
  ok('A0b 章节就绪（REST 创建返回 201）', ch.status === 201 && chapterId > 0, JSON.stringify({ status: ch.status }));
  await jfetch('/api/characters', { method: 'POST', body: { work_id: w1, name: '林寻', aliases: '小寻' } });
  await jfetch('/api/world_entries', { method: 'POST', body: { work_id: w1, title: '旧约', keywords: '剑冢,誓约' } });
  await jfetch('/api/plotlines', { method: 'POST', body: { work_id: w1, title: '剑冢誓约', position: 1 } });

  const off = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: DIRECTION, phase: 'direction', source: 'confirmed_blueprint', requestId: 'req-off' })}`);
  // 未开启的层根本没被尝试 → status=unknown（'disabled' 表示"开关关闭但调用发生了"）。
  ok('A1 资料库关闭：方向不触发召回（enabled=false / searches=0 / find 0 次）',
    off.status === 200 && off.data.library_recall.enabled === false && off.data.library_recall.status === 'unknown'
      && off.data.retrieval_stats.library_recall.searches === 0 && stubState.libraryFindCalls === 0,
    JSON.stringify({ status: off.data.library_recall && off.data.library_recall.status, searches: off.data.retrieval_stats && off.data.retrieval_stats.library_recall.searches, finds: stubState.libraryFindCalls }));
  ok('A2 方向被规范化并审计（used/hash/chars/source 四件套）',
    off.data.retrieval_stats.direction.used === true && /^[0-9a-f]{16}$/.test(off.data.retrieval_stats.direction.hash)
      && off.data.retrieval_stats.direction.chars === Array.from(DIRECTION).length && off.data.retrieval_stats.direction.source === 'confirmed_blueprint',
    JSON.stringify(off.data.retrieval_stats.direction));
  ok('A3 索引查询次数独立为 0（与召回次数不混算）',
    off.data.retrieval_stats.index_queries.total === 0 && typeof off.data.retrieval_stats.index_queries.by_index === 'object');
  ok('A4 资料库关闭 → manifest 里没有 library 层', !manifestIds(off).includes('library'));
  // 必须换一个方向：装配缓存键只含 phase+方向哈希、不含 source——否则会命中 A1 的缓存、看不到本次规范化。
  const unknownSource = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: '来源规范化测试：林寻与旧约', phase: 'direction', source: 'admin_override_please' })}`);
  ok('A5 未知来源不被伪装成已知来源（回退空串）', unknownSource.data.retrieval_stats.direction.source === '');
  const longDir = '很长方向'.repeat(120);
  const expected = Array.from(longDir).slice(0, 400).join('');
  const longResp = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: longDir, phase: 'direction' })}`);
  const longStats = longResp.data.retrieval_stats.direction;
  ok('A6 超长方向截到 400 码点，且哈希是对截断后文本的哈希',
    longStats.chars === 400 && longStats.hash === createHash('sha256').update(expected, 'utf8').digest('hex').slice(0, 16),
    JSON.stringify(longStats));
  const evil = "林寻'; DROP TABLE works; --";
  const evilResp = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: evil, phase: 'direction' })}`);
  const worksList = await jfetch('/api/works');
  ok('A7 恶意 direction 不执行、不回显、不破坏正典（响应 200、无 SQL 片段、作品仍在）',
    evilResp.status === 200 && Array.isArray(worksList.data) && worksList.data.some((x) => x.id === w1)
      && !JSON.stringify(evilResp.data).includes('DROP TABLE') && stubState.libraryFindCalls === 0,
    JSON.stringify({ evilStatus: evilResp.status }));

  console.log('\n【B. defer 阶段：方向在场也不查库】');
  const enable = await jfetch('/api/novel/library/enabled', { method: 'PUT', body: { work_id: w1, enabled: true } });
  ok('B1 作者侧可开资料层', enable.status === 200 && enable.data.enabled === true);
  const findBefore = stubState.libraryFindCalls;
  const deferred = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: DIRECTION, phase: 'defer' })}`);
  ok('B2 defer：不查记忆库、不写缓存、searches=0（find 次数不变）',
    deferred.data.library_recall.status === 'deferred' && deferred.data.retrieval_stats.library_recall.searches === 0
      && deferred.data.retrieval_stats.library_recall.phase === 'defer'
      && stubState.libraryFindCalls === findBefore && !manifestIds(deferred).includes('library'),
    JSON.stringify({ status: deferred.data.library_recall.status, finds: stubState.libraryFindCalls - findBefore }));
  const defaultPhase = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: DIRECTION })}`);
  ok('B3 旧调用（不带 phase）仍然工作：default 阶段照常召回一次',
    defaultPhase.data.retrieval_stats.library_recall.searches === 1 && stubState.libraryFindCalls === findBefore + 1,
    JSON.stringify({ searches: defaultPhase.data.retrieval_stats.library_recall.searches, finds: stubState.libraryFindCalls - findBefore }));
  // B2c：空查询是正常空结果且**不写微缓存**（§九-11，恢复旧行为）。
  // 触发条件：作品标题/简介/作者注全空 + 不带 chapter_id（否则「当前章节」段恒非空）
  // + 无事件 + 无方向。两次不同 mode 的装配各有自己的装配缓存键，否则第二次会被装配
  // 缓存整体拦下、观察不到召回微缓存——若空结果被写入微缓存，第二次必现 cached=true。
  const wEmpty = (await jfetch('/api/works', { method: 'POST', body: { title: '空查询微缓存测试' } })).data.id;
  dbRun(`UPDATE works SET title = '' WHERE id = ?`, wEmpty);
  const enEmpty = await jfetch('/api/novel/library/enabled', { method: 'PUT', body: { work_id: wEmpty, enabled: true } });
  const findsEmpty = stubState.libraryFindCalls;
  const empty1 = await jfetch(`/api/novel/context?${ctxQuery({ workId: wEmpty, mode: 'full' })}`);
  const empty2 = await jfetch(`/api/novel/context?${ctxQuery({ workId: wEmpty, mode: 'settings' })}`);
  ok('B2c 空查询：status=empty、不写微缓存（第二次独立装配 cached=false、不发 find）',
    enEmpty.status === 200 && empty1.status === 200 && empty1.data.library_recall.status === 'empty'
      && empty1.data.retrieval_stats.library_recall.cached === false && empty1.data.retrieval_stats.library_recall.searches === 0
      && empty2.status === 200 && empty2.data.library_recall.status === 'empty'
      && empty2.data.retrieval_stats.library_recall.cached === false
      && stubState.libraryFindCalls === findsEmpty,
    JSON.stringify({ s1: empty1.data.library_recall && empty1.data.library_recall.status, cached2: empty2.data.retrieval_stats && empty2.data.retrieval_stats.library_recall.cached, finds: stubState.libraryFindCalls - findsEmpty }));
  console.log('\n【C. direction 阶段：一次真实召回 + 两层缓存命中】');
  const findsB = stubState.libraryFindCalls;
  const c1 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: DIRECTION, phase: 'direction', source: 'saved_blueprint' })}`);
  ok('C1 方向阶段真查一次记忆库（searches=1，find +1；来源=saved_blueprint）',
    c1.data.retrieval_stats.library_recall.searches === 1 && c1.data.retrieval_stats.library_recall.phase === 'direction'
      && c1.data.retrieval_stats.direction.source === 'saved_blueprint' && stubState.libraryFindCalls === findsB + 1,
    JSON.stringify({ searches: c1.data.retrieval_stats.library_recall.searches, finds: stubState.libraryFindCalls - findsB }));
  ok('C2 方向确实进了召回查询文本（不是摆设）', stubState.lastLibraryQuery.includes('林寻'));
  const c3 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: DIRECTION, phase: 'direction', source: 'saved_blueprint' })}`);
  ok('C3 完全相同的装配请求：命中装配缓存（request_id 沿用，find 不再发生）',
    c3.data.context_request_id === c1.data.context_request_id && stubState.libraryFindCalls === findsB + 1,
    JSON.stringify({ rid: c3.data.context_request_id, finds: stubState.libraryFindCalls - findsB }));
  const c4 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: DIRECTION, phase: 'direction', source: 'saved_blueprint', mode: 'settings' })}`);
  ok('C4 模式不同的重新装配：召回微缓存命中（cached=true、本次 searches=0（没有真实检索）、index_queries=0、find 不增）',
    c4.data.retrieval_stats.library_recall.cached === true && c4.data.retrieval_stats.library_recall.searches === 0
      && c4.data.retrieval_stats.library_recall.index_queries === 0
      && stubState.libraryFindCalls === findsB + 1,
    JSON.stringify({ cached: c4.data.retrieval_stats.library_recall.cached, searches: c4.data.retrieval_stats.library_recall.searches, finds: stubState.libraryFindCalls - findsB }));
  const c5 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: '完全不同的方向：改写为喜剧结局', phase: 'direction' })}`);
  ok('C5 方向变化 → 不命中旧结果（find +1、方向哈希不同）',
    stubState.libraryFindCalls === findsB + 2 && c5.data.retrieval_stats.direction.hash !== c1.data.retrieval_stats.direction.hash);
  const viaAi = await jfetch(`/api/ai_context?chapter_id=${chapterId}&${ctxQuery({ direction: DIRECTION, phase: 'direction', source: 'saved_blueprint' })}`);
  ok('C6 主成文端点与上下文端点共享同一份装配缓存（同 request_id、find 不增）',
    viaAi.status === 200 && viaAi.data.context_request_id === c1.data.context_request_id && stubState.libraryFindCalls === findsB + 2,
    JSON.stringify({ status: viaAi.status, rid: viaAi.data.context_request_id }));

  console.log('\n【D. 资料索引：只做候选发现；索引内容变化 → 缓存失效】');
  ok('D0 模型侧不能开关资料索引（PUT → 403）',
    (await jfetch('/api/novel/library/index/enabled', { method: 'PUT', body: { enabled: true }, headers: { 'x-novel-agent': '1' } })).status === 403);
  const idx0 = await jfetch('/api/novel/library/index');
  ok('D1 索引默认关闭且状态可读（含 schema/version）',
    idx0.status === 200 && idx0.data.enabled === false && Number(idx0.data.version.schema) >= 1,
    JSON.stringify(idx0.data.version));
  writeFileSync(join(SRC_DIR, '方向测试资料.md'), '# 方向测试资料\n关键锚点：ZQ-EMBER-7 用于验证词法候选发现。\n冲突设计：林寻与旧约的抉择，目标 + 阻力 + 代价。\n结论：索引只做候选发现，不放宽语义阈值。\n', 'utf8');
  const dry = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR } });
  const confirm = await jfetch('/api/novel/library/import/confirm', { method: 'POST', body: { dir: SRC_DIR } });
  ok('D2 资料导入完成（dry-run + confirm 写入 1 篇）', dry.status === 200 && confirm.status === 200 && confirm.data.summary.written === 1,
    JSON.stringify({ confirm: confirm.data.summary }));
  const doc = dbGet(`SELECT * FROM library_docs WHERE status = 'active' ORDER BY id LIMIT 1`);
  ok('D3 登记行与记忆库 URI 就绪', !!doc && String(doc.uri).startsWith(SHARED_LIBRARY_ROOT));
  const idxPut = await jfetch('/api/novel/library/index/enabled', { method: 'PUT', body: { enabled: true } });
  await jfetch('/api/novel/library/index/rebuild', { method: 'POST', body: {} });
  const idx1 = await jfetch('/api/novel/library/index');
  ok('D4 作者侧开索引；导入已维护索引行（版本前进、entries ≥ 1）',
    idxPut.status === 200 && idxPut.data.enabled === true
      && Number(idx1.data.version.version) > Number(idx0.data.version.version) && Number(idx1.data.stats.entries) >= 1,
    JSON.stringify({ version: idx1.data.version, entries: idx1.data.stats.entries }));
  stubState.libraryHits = [{ uri: doc.uri, score: 0.61, abstract: '锚点资料' }];
  const findsD = stubState.libraryFindCalls;
  const d5 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: 'ZQ-EMBER-7 与林寻的旧约', phase: 'direction' })}`);
  const ia = d5.data.library_recall.index_assist;
  ok('D5 索引开启：index_assist 只暴露审计摘要（无候选清单/关键词/摘要正文）',
    d5.status === 200 && !!ia && Object.keys(ia).sort().join(',') === 'candidates,expansion_terms,status,timings_ms'
      && typeof ia.candidates === 'number' && ia.candidates >= 1
      && !JSON.stringify(d5.data.library_recall).includes('keywords') && !('summary' in d5.data.library_recall),
    JSON.stringify(ia));
  ok('D6 集成点③：资料召回 1 次 与 索引查询 ≥1 次 分开可读（各归各的字段）',
    d5.data.retrieval_stats.library_recall.searches === 1 && d5.data.retrieval_stats.index_queries.total >= 1
      && d5.data.retrieval_stats.index_queries.by_index.library >= 1
      && d5.data.retrieval_stats.library_recall.index_queries === d5.data.retrieval_stats.index_queries.by_index.library
      && stubState.libraryFindCalls === findsD + 1,
    JSON.stringify({ stats: d5.data.retrieval_stats }));
  ok('D7 有命中时资料层照常进入上下文（正文来自资料、分数口径不变）',
    d5.data.library_recall.status === 'ok' && manifestIds(d5).includes('library')
      && String(d5.data.assembled).includes('ZQ-EMBER-7'));
  writeFileSync(join(SRC_DIR, '方向测试资料.md'), '# 方向测试资料（改版）\n关键锚点：ZQ-EMBER-7 与林寻；新增一行触发 sha 变化。\n结论：索引内容变化必须让旧缓存失效。\n', 'utf8');
  const dry2 = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR } });
  const confirm2 = await jfetch('/api/novel/library/import/confirm', { method: 'POST', body: { dir: SRC_DIR } });
  const idx2 = await jfetch('/api/novel/library/index');
  const findsD2 = stubState.libraryFindCalls;
  const d8 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: 'ZQ-EMBER-7 与林寻的旧约', phase: 'direction' })}`);
  ok('D8 索引内容变化 → 版本前进 → 召回微缓存不命中（find +1、新装配身份）',
    dry2.data.summary.update === 1 && confirm2.data.summary.written === 1
      && Number(idx2.data.version.version) > Number(idx1.data.version.version)
      && stubState.libraryFindCalls === findsD2 + 1 && d8.data.context_request_id !== d5.data.context_request_id,
    JSON.stringify({ version: idx2.data.version, finds: stubState.libraryFindCalls - findsD2 }));  console.log('\n【E. 小说资产索引 + 检索计划：先汇总后装配（E5 保守）】');
  ok('E0 模型侧不能开关小说索引（PUT → 403；GET 可读）',
    (await jfetch('/api/novel/novel_index', { method: 'PUT', body: { enabled: true }, headers: { 'x-novel-agent': '1' } })).status === 403
      && (await jfetch('/api/novel/novel_index?work_id=' + w1)).status === 200);
  const e1 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: '林寻在剑冢面对旧约', phase: 'direction' })}`);
  ok('E1 索引关闭：没有检索计划（retrieval_plan=null），assembled 为基线',
    e1.data.retrieval_plan === null && String(e1.data.assembled).length > 0);
  const e2 = await jfetch('/api/novel/novel_index', { method: 'PUT', body: { enabled: true } });
  const e3 = await jfetch(`/api/novel/novel_index/rebuild?work_id=${w1}`, { method: 'POST' });
  ok('E2 作者侧开启并重建索引（幂等；版本键就绪）',
    e2.status === 200 && e2.data.enabled === true && e3.status === 200 && String(e3.data.version_key).length > 0,
    JSON.stringify({ version_key: e3.data.version_key }));
  const e4 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: '林寻在剑冢面对旧约', phase: 'direction' })}`);
  ok('E3 计划出现且真正定位到正典资产（林寻命中 character）',
    !!e4.data.retrieval_plan && e4.data.retrieval_plan.status === 'ok' && e4.data.retrieval_plan.queries >= 4
      && e4.data.retrieval_plan.matched.characters === true && e4.data.retrieval_plan.assets_count.character_ids >= 1,
    JSON.stringify(e4.data.retrieval_plan));
  ok('E4 E5 保守：计划开启后 assembled 与 manifest 逐字节一致（计划不新增层、不并行直塞）',
    e4.data.assembled === e1.data.assembled
      && JSON.stringify(e4.data.context_manifest) === JSON.stringify(e1.data.context_manifest),
    JSON.stringify({ len1: String(e1.data.assembled).length, len2: String(e4.data.assembled).length }));
  ok('E5 索引查询次数 ≥5 且逐索引可归因（character/relation/event/world/…）',
    e4.data.retrieval_stats.index_queries.total >= 5 && e4.data.retrieval_stats.index_queries.by_index.character >= 1
      && e4.data.retrieval_stats.index_queries.by_index.relation >= 1 && e4.data.retrieval_stats.index_queries.by_index.event >= 1,
    JSON.stringify(e4.data.retrieval_stats.index_queries));
  // e4 的召回是微缓存命中（与 E1 同方向同阶段）：本次没有真实检索，但资产索引查询照常发生——
  // 这正是「两组计数互不掩盖」的极端样本（0 次召回 + ≥5 次索引查询）。
  ok('E6a 微缓存命中的装配：searches=0（本次无真实检索）、cached=true，但索引查询仍 ≥5（不漏计）',
    e4.data.retrieval_stats.library_recall.searches === 0 && e4.data.retrieval_stats.library_recall.cached === true
      && e4.data.retrieval_stats.index_queries.total >= 5,
    JSON.stringify({ searches: e4.data.retrieval_stats.library_recall.searches, cached: e4.data.retrieval_stats.library_recall.cached, index: e4.data.retrieval_stats.index_queries.total }));
  // E6b：同一方向在「作者动作作废装配缓存」之后重新请求 → 计划缓存命中：
  // 本次没有真的查索引（index_queries.total=0）必须与「上次执行过 5 次」区分开——
  // 只有 cached 显式记 1，不能把上次的 by_index 重复计入本次（集成点③的边界样本）。
  await jfetch('/api/novel/novel_index', { method: 'PUT', body: { enabled: true } }); // 作者动作 → contextCache.invalidateAll()
  const e4c = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: '林寻在剑冢面对旧约', phase: 'direction' })}`);
  ok('E6b 计划缓存命中：本次索引查询计 0（不重复计入）、cached 显式记 ≥1；召回侧独立可读',
    e4c.data.retrieval_stats.index_queries.total === 0 && e4c.data.retrieval_stats.index_queries.cached >= 1
      && e4c.data.retrieval_stats.library_recall.searches === 0
      && !!e4c.data.retrieval_plan && e4c.data.retrieval_plan.status === 'ok',
    JSON.stringify({ iq: e4c.data.retrieval_stats.index_queries, lr: e4c.data.retrieval_stats.library_recall }));
  // 换一条**新方向**：召回微缓存不命中 → 一次真实召回 + 一次全新计划（索引查询 ≥5），
  // 同一响应里两组计数必须分别可读。
  const e4b = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: '林寻在剑冢面对旧约：公开真相的代价', phase: 'direction' })}`);
  ok('E6 集成点③：同一响应里「召回 1 次」与「索引查询 ≥5 次」分开可读（不是混算的一个数）',
    e4b.data.retrieval_stats.library_recall.searches === 1 && e4b.data.retrieval_stats.library_recall.cached === false
      && e4b.data.retrieval_stats.index_queries.total >= 5
      && e4b.data.retrieval_stats.library_recall.searches !== e4b.data.retrieval_stats.index_queries.total,
    JSON.stringify({ searches: e4b.data.retrieval_stats.library_recall.searches, index: e4b.data.retrieval_stats.index_queries.total }));
  const evil2 = await jfetch(`/api/novel/context?${ctxQuery({ workId: w1, chapterId, direction: "林寻'; DROP TABLE novel_index_characters; --", phase: 'direction' })}`);
  ok('E7 恶意 direction 不进入计划（无匹配即不生成非法查询；白名单结构不变）',
    evil2.status === 200 && !!evil2.data.retrieval_plan && evil2.data.retrieval_plan.queries <= 12
      && !JSON.stringify(evil2.data).includes('DROP TABLE'));
  const worksFinal = await jfetch('/api/works');
  ok('E8 全程零真实模型调用（只动本地 SQLite 与本地 stub）：正典完好',
    Array.isArray(worksFinal.data) && worksFinal.data.some((x) => x.id === w1));

  console.log('\n【F. 收口：两组计数结构上分离】');
  const rs = e4.data.retrieval_stats;
  ok('F1 retrieval_stats 同时提供两组独立字段（library_recall.searches / index_queries.total）',
    typeof rs.library_recall.searches === 'number' && typeof rs.index_queries.total === 'number'
      && typeof rs.index_queries.by_index === 'object' && rs.library_recall.phase === 'direction');
  ok('F2 资料侧镜像只镜像资料索引（资产索引不冒充资料召回）',
    rs.library_recall.index_queries === (rs.index_queries.by_index.library || 0),
    JSON.stringify({ mirror: rs.library_recall.index_queries, by_index: rs.index_queries.by_index }));
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
}

console.log('\n' + '─'.repeat(64));
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log(`   - ${f}`);
  cleanup();
  process.exit(1);
}
console.log(`✓ 全部通过（${pass} 项）`);
cleanup();
