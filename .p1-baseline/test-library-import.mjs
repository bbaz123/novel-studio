#!/usr/bin/env node
/**
 * test-library-import.mjs —— 资料库导入链的隔离测试（零计费、零真实记忆库写入）。
 *
 * 隔离配方：临时数据目录 + 空闲端口 + 本地 OV stub（find 按 target_uri 分流到资料命中）。
 * 覆盖：
 *   P. 纯模块：目录扫描（白名单 / 隐藏 / 忽略目录 / 单文件上限 / 严格 UTF-8 / 不跟符号链接）
 *      与导入计划（add / update / skip-unchanged / duplicate_target；计划不携带正文）
 *   A. HTTP：开关（作者侧 PUT；模型侧 403）→ 开关真的影响 status
 *   B. HTTP：import 默认 dry-run（零写入）→ confirm 才写（逐条写 OV + 登记行 + 索引时间）
 *   C. HTTP：重导幂等（未变即 skip）；改动后 dry-run 报 update
 *   D. HTTP：search / doc 只读查回（只认登记表 + 形状闸门；未登记条文不返回；模型侧可用）
 *   E. HTTP：删除默认只标记；confirm 后删记忆库文件 + 删登记行；模型侧 403
 *   F. HTTP：跨源写请求被拒；模型侧不能读本机目录；缺 dir 400
 *   G. HTTP：总闸关闭（NOVELSTUDIO_OV_DISABLED=1）——dry-run 可用 / confirm 409 零写入 /
 *      search 关键词兜底 / 即便开着资料开关，装配里也没有 library 层
 *
 * 用法: node .p1-baseline/test-library-import.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { scanLibraryDir, planLibraryImport } from '../ai/library/library-ingest.mjs';
import { SHARED_LIBRARY_ROOT } from '../ai/library/library-roots.mjs';
import { slugifyLibraryName } from '../ai/library/library-doc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PORT = await new Promise((resolvePort) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePort(6600 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
  }).catch(() => resolvePort(6600 + (process.pid % 300)));
});
const OV_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-library-import-'));
const SRC_DIR = mkdtempSync(join(tmpdir(), 'novel-library-src-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

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

// ══════════════════ P. 纯模块：扫描 + 计划 ══════════════════
console.log('【P. 目录扫描与导入计划（纯模块）】');
{
  mkdirSync(join(SRC_DIR, 'sub'), { recursive: true });
  mkdirSync(join(SRC_DIR, '_tmp'), { recursive: true });
  mkdirSync(join(SRC_DIR, 'node_modules'), { recursive: true });
  writeFileSync(join(SRC_DIR, 'a.md'), '# 冲突设计\n一句话结论：两难选择。\n\n## 是什么\n目标 + 阻力 + 代价。\n', 'utf8');
  writeFileSync(join(SRC_DIR, 'sub', 'b.txt'), 'b 文本：节奏控制。\n', 'utf8');
  writeFileSync(join(SRC_DIR, '.hidden.md'), '# 隐藏\n不应导入。\n', 'utf8');
  writeFileSync(join(SRC_DIR, '_tmp', 'c.md'), '# 下划线目录\n不应导入。\n', 'utf8');
  writeFileSync(join(SRC_DIR, 'node_modules', 'd.md'), '# 依赖目录\n不应导入。\n', 'utf8');
  writeFileSync(join(SRC_DIR, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(SRC_DIR, 'big.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  writeFileSync(join(SRC_DIR, 'bad.md'), Buffer.from([0xff, 0xfe, 0x41, 0x42]));
  let symlinked = false;
  try { symlinkSync(join(SRC_DIR, 'a.md'), join(SRC_DIR, 'link.md')); symlinked = true; } catch { /* Windows 无权限：该项跳过 */ }

  const scan = scanLibraryDir(SRC_DIR);
  const rels = scan.entries.map((e) => e.rel_path);
  ok('P1 白名单收 .md/.txt（含子目录）', rels.includes('a.md') && rels.includes('sub/b.txt'), JSON.stringify(rels));
  ok('P2 隐藏项 / 保留目录 / 忽略目录不深入', !rels.some((r) => r.includes('hidden') || r.includes('_tmp') || r.includes('node_modules')));
  const codes = (scan.skipped_counts || {});
  ok('P3 跳过清单带原因（扩展名 / 隐藏 / 忽略目录 / 上限 / 编码）',
    codes.ext_not_allowed >= 1 && codes.hidden >= 1 && codes.ignored_dir >= 2 && codes.too_large >= 1 && codes.bad_encoding >= 1,
    JSON.stringify(codes));
  ok('P4 严格 UTF-8：非法编码安全失败（不猜、不替换）', scan.entries.every((e) => !e.rel_path.includes('bad.md')));
  ok('P5 b.txt 规范化后自动包一级标题', (scan.entries.find((e) => e.rel_path === 'sub/b.txt') || {}).text.startsWith('# b'));
  if (symlinked) {
    ok('P6 符号链接不跟随（跳过且给原因）', codes.symlink >= 1 && !rels.includes('link.md'), JSON.stringify(codes));
  } else {
    console.log('  – P6 符号链接：本机无权创建链接，跳过（跳过≠通过）');
  }
  const plan = planLibraryImport(scan, {});
  ok('P7 计划不含正文（dry-run 报告不带全文）', plan.items.every((i) => i.text === undefined) && plan.items.every((i) => i.action === 'add'));
  const dupScan = { ...scan, entries: [...scan.entries, { rel_path: 'sub/b.txt', text: 'x', bytes: 1, sha256: 'z', title: 'b', stats: { est_chunks: 1, warnings: [] } }] };
  const dupPlan = planLibraryImport(dupScan, {});
  ok('P8 同一入库路径的重复来源：后来的被标 duplicate_target', dupPlan.skipped.some((s) => s.code === 'duplicate_target'));
  const relA = slugifyLibraryName('a.md').rel;
  const relB = slugifyLibraryName('sub/b.txt').rel;
  const shaB = (scan.entries.find((e) => e.rel_path === 'sub/b.txt') || {}).sha256;
  const changed = planLibraryImport(scan, { [`${SHARED_LIBRARY_ROOT}/${relA}`]: { sha256: 'different' }, [`${SHARED_LIBRARY_ROOT}/${relB}`]: { sha256: shaB } });
  ok('P9 计划能区分 update（sha 变）与 skip（未变）',
    changed.items.some((i) => i.action === 'update') && changed.items.some((i) => i.action === 'skip'),
    JSON.stringify(changed.items.map((i) => [i.rel, i.action])));
}

// ══════════════════ OV stub ══════════════════
const stubState = { writes: [], deletes: [], libraryHits: [], novelHits: [], reads: new Map(), libraryFindCalls: 0, findCalls: 0 };
const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${OV_PORT}`);
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/health') return send({ status: 'ok', result: { ok: true } });
  if (url.pathname === '/api/v1/search/find') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 普通召回 */ }
      const isLibrary = body.target_uri === SHARED_LIBRARY_ROOT;
      if (isLibrary) stubState.libraryFindCalls += 1; else stubState.findCalls += 1;
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
  if (req.method === 'DELETE') {
    stubState.deletes.push(decodeURIComponent(url.searchParams.get('uri') || ''));
    return send({ status: 'ok', result: { ok: true } });
  }
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
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'library-import-test',
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
  try {
    const r = await jfetch('/api/novel/ping', { base: BASE });
    if (r.status === 200) ready = true;
  } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
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

try {
  console.log('\n【A. 开关（作者侧）】');
  const w1 = (await jfetch('/api/works', { method: 'POST', body: { title: '资料库导入测试' } })).data.id;
  ok('A0 作品创建成功', Number(w1) > 0);
  const off = await jfetch(`/api/novel/library/status?work_id=${w1}`);
  ok('A1 默认关闭：status.enabled=false，且没有任何资料', off.data.enabled === false && off.data.summary.total === 0);
  const agentPut = await jfetch('/api/novel/library/enabled', { method: 'PUT', body: { work_id: w1, enabled: true }, headers: { 'x-novel-agent': '1' } });
  ok('A2 模型侧不能开资料层（PUT enabled → 403）', agentPut.status === 403, String(agentPut.status));
  const put = await jfetch('/api/novel/library/enabled', { method: 'PUT', body: { work_id: w1, enabled: true } });
  const on = await jfetch(`/api/novel/library/status?work_id=${w1}`);
  ok('A3 作者侧开关生效且可读回', put.status === 200 && on.data.enabled === true && dbGet("SELECT value FROM app_settings WHERE key = ?", `library_enabled:${w1}`).value === '1');

  console.log('\n【B. 导入：dry-run → confirm】');
  const writesBefore = stubState.writes.length;
  const libWritesSeen = () => stubState.writes.filter((w) => String(w.uri || '').startsWith(SHARED_LIBRARY_ROOT)).length;
  const libWritesBefore = libWritesSeen();
  const dry = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR } });
  ok('B1 dry-run 返回计划与规则，且零写入', dry.status === 200 && dry.data.dry_run === true && dry.data.summary.add === 2
    && String(dry.data.rules.version).length > 0 && libWritesSeen() === libWritesBefore,
    JSON.stringify({ status: dry.status, summary: dry.data.summary, lib_writes: libWritesSeen() - libWritesBefore }));
  const confirm = await jfetch('/api/novel/library/import/confirm', { method: 'POST', body: { dir: SRC_DIR } });
  const writtenUris = stubState.writes.slice(writesBefore).map((w) => w.uri).filter((u) => u.startsWith(SHARED_LIBRARY_ROOT));
  ok('B2 confirm 真的写入 2 篇（共享资料根内的 URI）', confirm.status === 200 && confirm.data.executed === true && confirm.data.summary.written === 2 && writtenUris.length === 2,
    JSON.stringify({ status: confirm.status, written: confirm.data.summary && confirm.data.summary.written, uris: writtenUris }));
  const row = dbGet('SELECT * FROM library_docs ORDER BY id LIMIT 1');
  const status2 = await jfetch(`/api/novel/library/status?work_id=${w1}`);
  ok('B3 登记行落库（scope=shared / sha256 / 字数 / est_chunks）', !!row && row.scope === 'shared' && /^[0-9a-f]{64}$/.test(row.sha256) && row.chars > 0 && row.est_chunks >= 1, JSON.stringify(row && { sha: row.sha256.slice(0, 8), chars: row.chars, est: row.est_chunks }));
  ok('B4 索引时间可见（ov_indexed_at:library + status.index）',
    String(dbGet("SELECT value FROM app_settings WHERE key = 'ov_indexed_at:library'").value || '').length > 10
      && String(status2.data.index.last_indexed_at).length > 10);
  ok('B5 分类计数按目录聚合', status2.data.summary.categories.some((c) => c.category === '未分类') || status2.data.summary.categories.length >= 1, JSON.stringify(status2.data.summary.categories));

  console.log('\n【C. 重导幂等】');
  const dry2 = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR } });
  ok('C1 内容未变 → 两篇都 skip（will_write=0）', dry2.data.summary.will_write === 0 && dry2.data.summary.skip_unchanged === 2, JSON.stringify(dry2.data.summary));
  writeFileSync(join(SRC_DIR, 'a.md'), '# 冲突设计（改写）\n一句话结论：两难选择 + 代价兑现。\n', 'utf8');
  const dry3 = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR } });
  ok('C2 改动后 → update=1、skip=1', dry3.data.summary.update === 1 && dry3.data.summary.skip_unchanged === 1, JSON.stringify(dry3.data.summary));
  const confirm2 = await jfetch('/api/novel/library/import/confirm', { method: 'POST', body: { dir: SRC_DIR } });
  ok('C3 重导不产生重复登记行', confirm2.data.summary.written === 1 && Number(dbGet('SELECT COUNT(*) AS n FROM library_docs').n) === 2);

  console.log('\n【D. 查回（模型侧可用）】');
  const doc1 = dbGet('SELECT * FROM library_docs ORDER BY id LIMIT 1');
  const strayUri = `${SHARED_LIBRARY_ROOT}/未登记.md`;
  stubState.libraryHits = [
    { uri: doc1.uri, score: 0.61, abstract: '登记表的资料' },
    { uri: strayUri, score: 0.55, abstract: '未登记的散文件' },
  ];
  const search = await jfetch('/api/novel/library/search?q=冲突设计&limit=5');
  ok('D1 search 命中带 id/分类/标题/分数', search.status === 200 && search.data.hits.length === 1
    && search.data.hits[0].id === doc1.id && search.data.hits[0].category === doc1.category && typeof search.data.hits[0].score === 'number',
    JSON.stringify(search.data.hits));
  ok('D2 未登记的散文件不返回（查回只认登记表）', !search.data.hits.some((h) => String(h.title || '').includes('未登记')) && search.data.hits.length === 1);
  const unlisted = await jfetch('/api/novel/library/search?q=');
  ok('D3 无关键词 → 列表模式（含登记的两篇）', unlisted.data.mode === 'list' && unlisted.data.hits.length === 2);
  stubState.reads.set(doc1.uri, '# 冲突设计\n一句话结论：两难选择。\n\n## 是什么\n目标 + 阻力 + 代价。\n');
  const readDoc = await jfetch(`/api/novel/library/doc?id=${doc1.id}&offset=0&limit=30`);
  ok('D4 doc 读回原文窗口（带 doc 元数据与正文）', readDoc.status === 200 && readDoc.data.doc.id === doc1.id
    && readDoc.data.doc.total_chars === doc1.chars && String(readDoc.data.text).includes('目标 + 阻力 + 代价'));

  console.log('\n【E. 删除：标记 → 确认】');
  const agentDel = await jfetch(`/api/novel/library/doc/${doc1.id}`, { method: 'DELETE', headers: { 'x-novel-agent': '1' } });
  ok('E1 模型侧不能删资料（DELETE → 403）', agentDel.status === 403, String(agentDel.status));
  const mark = await jfetch(`/api/novel/library/doc/${doc1.id}`, { method: 'DELETE' });
  const afterMark = await jfetch(`/api/novel/library/status?work_id=${w1}`);
  ok('E2 默认只标记缺失（不删文件、不删登记行）',
    mark.status === 200 && mark.data.marked_missing === true && stubState.deletes.length === 0
      && afterMark.data.summary.marked_missing === 1 && afterMark.data.summary.active === 1,
    JSON.stringify({ deletes: stubState.deletes.length, summary: afterMark.data.summary }));
  const del = await jfetch(`/api/novel/library/doc/${doc1.id}?confirm=1`, { method: 'DELETE' });
  ok('E3 confirm 后删记忆库文件 + 删登记行', del.status === 200 && del.data.removed === doc1.uri
    && stubState.deletes.includes(doc1.uri) && !dbGet('SELECT id FROM library_docs WHERE id = ?', doc1.id));

  console.log('\n【F. 边界】');
  const cross = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR }, headers: { origin: 'http://evil.example.com' } });
  ok('F1 跨源写请求被拒（Origin 非本机）', cross.status === 403, String(cross.status));
  const agentImport = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR }, headers: { 'x-novel-agent': '1' } });
  ok('F2 模型侧不能读本机目录（import → 403）', agentImport.status === 403, String(agentImport.status));
  const noDir = await jfetch('/api/novel/library/import', { method: 'POST', body: {} });
  ok('F3 缺 dir → 400（不是静默空计划）', noDir.status === 400, String(noDir.status));
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
}

// ── G. 总闸关闭：confirm 拒绝、dry-run 仍可用、search 走关键词兜底、装配无资料层 ──
try {
  console.log('\n【G. 总闸关闭（NOVELSTUDIO_OV_DISABLED=1）】');
  const dirOff = mkdtempSync(join(tmpdir(), 'novel-library-off-'));
  const portOff = PORT + 7;
  const serverOff = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(portOff), NOVELSTUDIO_DATA_DIR: dirOff, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OV_AUTOINDEX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logOff = '';
  serverOff.stdout.on('data', (c) => { logOff += c; });
  serverOff.stderr.on('data', (c) => { logOff += c; });
  const baseOff = `http://127.0.0.1:${portOff}`;
  let readyOff = false;
  for (let i = 0; i < 120 && !readyOff; i += 1) {
    try { if ((await jfetch('/api/novel/ping', { base: baseOff })).status === 200) readyOff = true; } catch { /* 未就绪 */ }
    if (!readyOff) await new Promise((r) => setTimeout(r, 300));
  }
  try {
    if (!readyOff) throw new Error('总闸隔离实例未就绪：' + logOff.slice(-800));
    const w2 = (await jfetch('/api/works', { method: 'POST', body: { title: '总闸关闭' }, base: baseOff })).data.id;
    const dbGetOff = (sql, ...params) => {
      const d = new DatabaseSync(join(dirOff, 'novel.db'));
      try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...params); } finally { d.close(); }
    };
    const dryOff = await jfetch('/api/novel/library/import', { method: 'POST', body: { dir: SRC_DIR }, base: baseOff });
    const confirmOff = await jfetch('/api/novel/library/import/confirm', { method: 'POST', body: { dir: SRC_DIR }, base: baseOff });
    const searchOff = await jfetch('/api/novel/library/search?q=冲突', { base: baseOff });
    ok('G1 总闸关闭：dry-run 可用（本地扫描不依赖记忆库）', dryOff.status === 200 && dryOff.data.summary.add === 2);
    ok('G2 总闸关闭：confirm 拒绝（409）且不写任何东西', confirmOff.status === 409 && Number(dbGetOff('SELECT COUNT(*) AS n FROM library_docs').n) === 0,
      JSON.stringify({ status: confirmOff.status, rows: Number(dbGetOff('SELECT COUNT(*) AS n FROM library_docs').n) }));
    ok('G3 总闸关闭：search 走关键词兜底且不报错', searchOff.status === 200 && Array.isArray(searchOff.data.hits));
    const enableOff = await jfetch('/api/novel/library/enabled', { method: 'PUT', body: { work_id: w2, enabled: true }, base: baseOff });
    const ctxOff = await jfetch(`/api/novel/context?work_id=${w2}`, { base: baseOff });
    const layerIdsOff = ((ctxOff.data && ctxOff.data.manifest) || []).map((m) => m.id);
    ok('G4 总闸关闭：即便开着资料开关，装配里也没有 library 层（链完全消失、无报错）',
      enableOff.status === 200 && ctxOff.status === 200 && !layerIdsOff.includes('library')
        && !String(ctxOff.data.assembled || '').includes('参考资料（非本书事实）'),
      JSON.stringify({ enable: enableOff.status, ctx: ctxOff.status, layers: layerIdsOff }));
  } finally {
    try { serverOff.kill(); } catch { /* 已退出 */ }
    try { rmSync(dirOff, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
  }
} catch (e) {
  fails.push('总闸冒烟异常');
  console.error('✗ 总闸冒烟异常：', e && e.stack ? e.stack : e);
}

cleanup();
console.log(`\n资料库导入链：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
