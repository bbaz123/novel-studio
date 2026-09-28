#!/usr/bin/env node
/**
 * test-ov-recall-boundary.mjs —— R04「OpenViking 召回来源 fail-closed + retry/replay/rebuild」
 * 的隔离测试（零计费、零真实记忆库写入）。
 *
 * 隔离配方：
 *   · 独立临时数据目录（NOVELSTUDIO_DATA_DIR）+ 独立端口；
 *   · 用**本地 stub** 冒充 OpenViking 服务器（OPENVIKING_URL=127.0.0.1:<stub>），
 *     断言所有 /api/v1/* 请求都命中 stub —— 不碰作者真实记忆库、不发外部网络请求；
 *   · 不设 NOVELSTUDIO_OV_DISABLED（本测试要真跑召回链）。
 *
 * 覆盖：
 *   A. 纯模块：命名空间 / 已知布局 / 正典状态 / 未来章节 / 章节 id 残留 / 缺 URI
 *   A-L. 纯模块：资料根注册表（形状/保留前缀）、资料条目永不 canon、资料层与作品召回互不混层、rebuild 拒绝资料根
 *   B. HTTP：装配器里的召回层——放行合法命中，拦下跨书、未来章、候选、布局不明，并留 omitted 原因
 *   C. HTTP：全部被拦 → status=filtered（显式缺口，不静默成 no-hits）
 *   F. HTTP：资料库门控层——开关打开才有层（独立 find / 条目标注 / ≤300 字）、未开启零影响（连检索都不发起）、
 *      零命中不插占位、资料条目不得进作品召回层、被拦条目留审计
 *   D. HTTP：replay 投递投影；rebuild 默认 dry-run（不删任何东西）、范围证明失败即拒绝、
 *      服务不可用即拒绝（绝不"先删再重建"）、confirm 后才逐条删除并重建、审计可读
 *   E. 模型侧 rebuild → 403
 *
 * 用法: node .p1-baseline/test-ov-recall-boundary.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseRecallUri, validateRecallItem, filterRecallItems, revalidateRecallPayload, planRebuild, canonStatusOfRel } from '../ai/openviking/recall-meta.mjs';
import { SHARED_LIBRARY_ROOT, libraryRelOf, isLibraryUri, checkLibraryShape } from '../ai/library/library-roots.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(5600 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(5600 + (process.pid % 300)));
});
const OV_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-ov-boundary-'));
const AGENT = { 'x-novel-agent': '1' };

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

async function jfetch(path, { method = 'GET', body, headers = {}, timeout = 15000, base = BASE } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// ══════════════════ A. 纯模块 ══════════════════
console.log('【A. 召回来源校验（纯模块）】');
const SCOPE = 'viking://user/default/resources/novel-studio/abc123';
{
  const parsed = parseRecallUri(`${SCOPE}/chapters/5.md`, SCOPE);
  ok('A1 作品命名空间内的章节文件可解析（kind/canon/chapterId 齐全）',
    parsed.inScope && parsed.rel === 'chapters/5.md' && parsed.kind === '章节正文' && parsed.canon === 'canon' && parsed.chapterId === '5',
    JSON.stringify(parsed));
  ok('A2 跨作品 URI 不在本作品命名空间（前缀相似也不行）',
    parseRecallUri('viking://user/default/resources/novel-studio/abc1234/chapters/5.md', SCOPE).inScope === false);
  ok('A3 候选前缀一律视为非正典', canonStatusOfRel('candidates/branch-1.md') === 'candidate' && canonStatusOfRel('drafts/x.md') === 'candidate');
  ok('A4 未知布局 → unknown（fail-closed 的输入）', canonStatusOfRel('notes/anything.md') === 'unknown');

  // order = 章序位次（position ASC, id ASC 的排名），不是原始 position 值。
  const ctx = { workUri: SCOPE, currentChapterOrder: 3, chapterOrderById: { 5: 3, 6: 4 } };
  const allowed = validateRecallItem({ uri: `${SCOPE}/chapters/5.md` }, ctx);
  ok('A5 当前章的命中放行', allowed.ok && allowed.meta.chapter_order === 3, JSON.stringify(allowed));
  const future = validateRecallItem({ uri: `${SCOPE}/chapters/6.md` }, ctx);
  ok('A6 未来章节 → future_chapter（不提前泄密）', !future.ok && future.code === 'future_chapter', JSON.stringify(future));
  const residual = validateRecallItem({ uri: `${SCOPE}/chapters/999.md` }, ctx);
  ok('A7 章节 id 不在本作品（索引残留）→ unknown_chapter', !residual.ok && residual.code === 'unknown_chapter', JSON.stringify(residual));
  const cross = validateRecallItem({ uri: 'viking://user/default/resources/novel-studio/other/chapters/1.md' }, ctx);
  ok('A8 跨书命中 → out_of_scope', !cross.ok && cross.code === 'out_of_scope', JSON.stringify(cross));
  const cand = validateRecallItem({ uri: `${SCOPE}/candidates/plan.md` }, ctx);
  ok('A9 候选内容 → non_canon', !cand.ok && cand.code === 'non_canon', JSON.stringify(cand));
  const unknown = validateRecallItem({ uri: `${SCOPE}/misc/whatever.md` }, ctx);
  ok('A10 布局不明 → unknown_source', !unknown.ok && unknown.code === 'unknown_source', JSON.stringify(unknown));
  const noUri = validateRecallItem({ label: '没有来源的条目' }, ctx);
  ok('A11 缺 URI → missing_uri（证明不了来源就不放行）', !noUri.ok && noUri.code === 'missing_uri', JSON.stringify(noUri));
  const root = validateRecallItem({ uri: SCOPE }, ctx);
  ok('A12 指向作品目录本身 → scope_root', !root.ok && root.code === 'scope_root');

  const mixed = filterRecallItems([
    { uri: `${SCOPE}/long-memory.md`, label: '长期记忆', score: 80, text: '# 记忆\n甲' },
    { uri: `${SCOPE}/chapters/6.md`, label: '未来章', score: 70, text: '# 六\n乙' },
    { uri: 'viking://user/default/resources/novel-studio/zzz/chapters/1.md', label: '别的书', score: 60, text: '# 一\n丙' },
  ], ctx);
  ok('A13 批量裁决：kept 与 dropped 分开、被拦者带 code', mixed.kept.length === 1 && mixed.dropped.length === 2
    && mixed.dropped.map((d) => d.code).sort().join(',') === 'future_chapter,out_of_scope',
    JSON.stringify({ kept: mixed.kept.length, dropped: mixed.dropped.map((d) => d.code) }));

  const allBad = revalidateRecallPayload({ status: 'ok', hits: [{ uri: 'viking://elsewhere/x.md' }], text: '旧文本' }, ctx);
  ok('A14 全部被拦 → status=filtered、text 清空（显式缺口而非假 no-hits）',
    allBad.payload.status === 'filtered' && allBad.payload.text === '' && allBad.payload.omitted.length === 1,
    JSON.stringify({ status: allBad.payload.status, omitted: allBad.payload.omitted.length }));
  const partial = revalidateRecallPayload({
    status: 'ok', meta_validated: true,
    hits: [{ uri: `${SCOPE}/meta.md`, label: '作品', score: 90, text: '# 作品\n合法', source_meta: { rel: 'meta.md' } }, { uri: `${SCOPE}/notes/x.md`, label: 'x', score: 10, text: 'y' }],
    text: '旧的合并文本',
  }, ctx);
  ok('A15 部分被拦 → 文本由 kept 重建（沿用旧 text 会把被拦内容带进请求）',
    partial.changed && partial.payload.text.includes('合法') && !partial.payload.text.includes('y'),
    JSON.stringify(partial.payload.text));

  const scope = SCOPE;
  const planBad = planRebuild({ workUri: scope, expectedUris: [`${scope}/meta.md`], actualUris: [`${scope}/meta.md`, 'viking://user/default/resources/novel-studio/other/chapters/1.md'] });
  ok('A16 范围证明：命名空间外条目 → 拒绝执行（foreign）', !planBad.ok && planBad.code === 'foreign_entries' && planBad.deletable.length === 0, JSON.stringify(planBad));
  const planShape = planRebuild({ workUri: scope, expectedUris: [`${scope}/meta.md`], actualUris: [`${scope}/meta.md`, `${scope}/evil.exe`] });
  ok('A17 范围证明：形状不明的条目 → 拒绝执行', !planShape.ok && planShape.code === 'unexpected_entries', JSON.stringify(planShape));
  const planOk = planRebuild({ workUri: scope, expectedUris: [`${scope}/meta.md`, `${scope}/chapters/1.md`], actualUris: [`${scope}/meta.md`, `${scope}/chapters/1.md`, `${scope}/chapters/old-99.md`], actualDirs: [`${scope}/chapters`] });
  ok('A18 范围证明：合法文件 + 旧版本遗留（形状合规）→ 可删集合只含文件、可审计',
    planOk.ok && planOk.deletable.length === 3 && planOk.deletable.every((u) => !u.endsWith('/chapters')),
    JSON.stringify(planOk));
}

// ══════════════════ A-L. 资料库来源边界（纯模块，2026-09-28） ══════════════════
console.log('【A-L. 资料库来源校验（纯模块）】');
{
  const LIB = SHARED_LIBRARY_ROOT;
  const libDoc = `${LIB}/方法/冲突设计.md`;
  const inLibScope = { allowLibrary: true, libraryWorkId: 'abc123' };

  ok('AL1 资料形状：两层 <分类>/<slug>.md 放行', checkLibraryShape('方法/冲突设计.md').ok === true);
  ok('AL2 资料形状：保留前缀（任意层级，含 OV 伴随文件）/ 根目录 / 层级 / 扩展名不合一律拒绝',
    checkLibraryShape('_probe/x.md').code === 'library_reserved'
      && checkLibraryShape('方法/.abstract.md').code === 'library_reserved'
      && checkLibraryShape('.overview.md').code === 'library_reserved'
      && checkLibraryShape('').code === 'library_root'
      && checkLibraryShape('单层.md').code === 'library_bad_shape'
      && checkLibraryShape('方法/正文.txt').code === 'library_not_md',
    JSON.stringify([checkLibraryShape('_probe/x.md').code, checkLibraryShape('方法/.abstract.md').code, checkLibraryShape('.overview.md').code, checkLibraryShape('').code, checkLibraryShape('单层.md').code, checkLibraryShape('方法/正文.txt').code]));
  ok('AL3 根判定：共享根内是资料、作品子树不是（前缀相似的兄弟目录也不是）',
    isLibraryUri(libDoc) === true && libraryRelOf(libDoc).scope === 'shared'
      && isLibraryUri(`${SCOPE}/chapters/5.md`) === false
      && isLibraryUri(`${LIB}-evil/x.md`) === false);

  const inRecall = validateRecallItem({ uri: libDoc }, { workUri: SCOPE, currentChapterOrder: 3, chapterOrderById: { 5: 3 } });
  ok('AL4 普通召回路径遇到资料条目 → library_out_of_scope（不混层）',
    !inRecall.ok && inRecall.code === 'library_out_of_scope', JSON.stringify(inRecall));

  const inLib = validateRecallItem({ uri: libDoc }, inLibScope);
  ok('AL5 资料层放行且永不 canon（meta.canon=reference、kind=参考资料）',
    inLib.ok && inLib.meta.canon === 'reference' && inLib.meta.kind === '参考资料' && inLib.meta.library_scope === 'shared',
    JSON.stringify(inLib));

  const novelInLib = validateRecallItem({ uri: `${SCOPE}/chapters/5.md` }, inLibScope);
  ok('AL6 资料层遇到作品条目 → not_library_item（反向也不混层）',
    !novelInLib.ok && novelInLib.code === 'not_library_item', JSON.stringify(novelInLib));

  const reservedInLib = validateRecallItem({ uri: `${LIB}/_probe/tmp.md` }, inLibScope);
  ok('AL7 资料层内形状不合（保留前缀）照样拦下',
    !reservedInLib.ok && reservedInLib.code === 'library_reserved', JSON.stringify(reservedInLib));

  const rebuilt = revalidateRecallPayload({
    status: 'ok', meta_validated: true, text: '旧文本',
    hits: [
      { uri: libDoc, label: '参考资料｜冲突设计', score: 62, text: '# 冲突设计\n合法资料' },
      { uri: `${SCOPE}/chapters/5.md`, label: '混入的作品条目', score: 55, text: '作品内容' },
    ],
  }, inLibScope);
  ok('AL8 宿主再校验：资料层只重建保留下来的资料文本（作品条目被拦且可归因）',
    rebuilt.changed && rebuilt.payload.text.includes('合法资料') && !rebuilt.payload.text.includes('作品内容')
      && rebuilt.dropped.length === 1 && rebuilt.dropped[0].code === 'not_library_item',
    JSON.stringify({ dropped: rebuilt.dropped, text: rebuilt.payload.text }));

  const planLib = planRebuild({ workUri: LIB, expectedUris: [libDoc], actualUris: [libDoc] });
  const planLibSub = planRebuild({ workUri: `${LIB}/方法`, expectedUris: [libDoc], actualUris: [libDoc] });
  ok('AL9 范围证明：以资料根（或其子路径）为重建范围 → library_scope 拒绝、零可删',
    !planLib.ok && planLib.code === 'library_scope' && planLib.deletable.length === 0
      && !planLibSub.ok && planLibSub.code === 'library_scope',
    JSON.stringify([planLib.code, planLibSub.code]));
}

// ══════════════════ OV stub ══════════════════
const stubState = { hits: [], libraryHits: [], reads: new Map(), ls: [], lsOk: true, deletes: [], writes: [], findCalls: 0, libraryFindCalls: 0 };
const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${OV_PORT}`);
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/health') return send({ status: 'ok', result: { ok: true } });
  if (url.pathname === '/api/v1/search/find') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 空/坏 body 按普通召回处理 */ }
      const isLibrary = body.target_uri === SHARED_LIBRARY_ROOT;
      if (isLibrary) stubState.libraryFindCalls += 1; else stubState.findCalls += 1;
      const hits = isLibrary ? stubState.libraryHits : stubState.hits;
      send({ status: 'ok', result: { memories: hits.map((h) => ({ uri: h.uri, score: h.score, abstract: h.abstract || '' })), resources: [], skills: [] } });
    });
    return;
  }
  if (url.pathname === '/api/v1/content/read') {
    const uri = url.searchParams.get('uri');
    return send({ status: 'ok', result: stubState.reads.get(uri) || '' });
  }
  if (url.pathname === '/api/v1/content/write') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { stubState.writes.push(JSON.parse(body || '{}')); send({ status: 'ok', result: { ok: true } }); });
    return;
  }
  if (url.pathname === '/api/v1/fs/ls') {
    if (!stubState.lsOk) return send({ status: 'error', error: { message: 'stub: 记忆服务不可用' } });
    return send({ status: 'ok', result: stubState.ls });
  }
  if (req.method === 'DELETE') {
    stubState.deletes.push(decodeURIComponent(url.searchParams.get('uri') || ''));
    return send({ status: 'ok', result: { ok: true } });
  }
  return send({ status: 'ok', result: {} });
});
await new Promise((r) => stub.listen(OV_PORT, '127.0.0.1', r));

console.log(`\n召回边界隔离测试（服务端口 ${PORT}，OV stub ${OV_PORT}，数据目录 ${DATA_DIR}）`);
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
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'enh-ov-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { stub.close(); } catch { /* 已关闭 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 文件锁：留给临时目录清理 */ }
};

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try {
    const r = await jfetch('/api/novel/ping', { timeout: 2000 });
    if (r.status === 200) ready = true;
  } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) {
  console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000));
  cleanup();
  process.exit(2);
}

function dbGet(sql, ...params) {
  const d = new DatabaseSync(join(DATA_DIR, 'novel.db'));
  try { d.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本无此 PRAGMA */ }
  try { return d.prepare(sql).get(...params); } finally { d.close(); }
}

function dbSet(sql, ...params) {
  const d = new DatabaseSync(join(DATA_DIR, 'novel.db'));
  try { d.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本无此 PRAGMA */ }
  try { return d.prepare(sql).run(...params); } finally { d.close(); }
}

try {
  const authorReq = (p, o = {}) => jfetch(p, o);
  const agentReq = (p, o = {}) => jfetch(p, { ...o, headers: { ...AGENT, ...(o.headers || {}) } });

  // 准备工作：两部作品 × 各自 3 章（position 0/1/2）
  const w1 = (await authorReq('/api/works', { method: 'POST', body: { title: '召回边界·甲书' } })).data.id;
  const w2 = (await authorReq('/api/works', { method: 'POST', body: { title: '召回边界·乙书' } })).data.id;
  const mkCh = async (workId, title) => (await authorReq('/api/chapters', { method: 'POST', body: { work_id: workId, title } })).data.id;
  const a1 = await mkCh(w1, '甲一'); const a2 = await mkCh(w1, '甲二'); const a3 = await mkCh(w1, '甲三');
  const b1 = await mkCh(w2, '乙一'); const b2 = await mkCh(w2, '乙二'); const b3 = await mkCh(w2, '乙三');
  const b4 = await mkCh(w2, '乙四'); // F3b 专用（先过滤后截断：伴随文件不得挤占名额）
  ok('准备：两部作品 × 各 3 章', !!(w1 && w2 && a1 && a2 && a3 && b1 && b2 && b3));
  const scope1 = `viking://user/default/resources/novel-studio/${dbGet('SELECT ov_uri FROM works WHERE id = ?', w1).ov_uri}`;
  const scope2 = `viking://user/default/resources/novel-studio/${dbGet('SELECT ov_uri FROM works WHERE id = ?', w2).ov_uri}`;

  // ── B. 混合命中：放行合法、拦下其余，omitted 有原因 ──
  stubState.hits = [
    { uri: `${scope1}/chapters/${a1}.md`, score: 0.93, abstract: '本章已有内容' },
    { uri: `${scope2}/chapters/${b1}.md`, score: 0.88, abstract: '另一本书的内容' },
    { uri: `${scope1}/chapters/${a3}.md`, score: 0.81, abstract: '未来章节内容' },
    { uri: `${scope1}/candidates/branch-1.md`, score: 0.74, abstract: '候选方向' },
    { uri: `${scope1}/notes/scratch.md`, score: 0.62, abstract: '布局不明' },
  ];
  stubState.reads = new Map([
    [`${scope1}/chapters/${a1}.md`, '# 甲一\n允许进入上下文的召回-甲'],
    [`${scope2}/chapters/${b1}.md`, '# 乙一\n跨书内容-乙'],
    [`${scope1}/chapters/${a3}.md`, '# 甲三\n未来章节内容-丙'],
    [`${scope1}/candidates/branch-1.md`, '# 候选\n候选方向内容-丁'],
    [`${scope1}/notes/scratch.md`, '# 杂项\n布局不明内容-戊'],
  ]);
  const ctxRes = await authorReq(`/api/novel/context?work_id=${w1}&chapter_id=${a1}&mode=full`);
  const ctx = ctxRes.data || {};
  const assembled = String(ctx.assembled || '');
  const omitted = (ctx.semantic_recall && ctx.semantic_recall.omitted) || [];
  ok('B1 合法命中进入 assembled', assembled.includes('允许进入上下文的召回-甲'), assembled.includes('召回') ? '' : '找不到召回层');
  ok('B2 跨书命中未进入 assembled', !assembled.includes('跨书内容-乙'));
  ok('B3 未来章命中未进入 assembled（不提前泄密）', !assembled.includes('未来章节内容-丙'));
  ok('B4 候选内容未进入 assembled', !assembled.includes('候选方向内容-丁'));
  ok('B5 布局不明未进入 assembled', !assembled.includes('布局不明内容-戊'));
  const codes = omitted.map((o) => o.code).sort();
  ok('B6 被拦条目留审计原因（out_of_scope/future_chapter/non_canon/unknown_source）',
    codes.join(',') === 'future_chapter,non_canon,out_of_scope,unknown_source', JSON.stringify(codes));
  ok('B7 全部请求确实打在 OV stub 上（零外部网络）', stubState.findCalls > 0, `find 调用 ${stubState.findCalls}`);

  // ── C. 全部被拦 → filtered 缺口，而不是 no-hits ──
  stubState.hits = [{ uri: `${scope2}/chapters/${b1}.md`, score: 0.9, abstract: '全是别的书' }];
  stubState.reads = new Map([[`${scope2}/chapters/${b1}.md`, '# 乙一\n全是别的书的内容']]);
  const ctxRes2 = await authorReq(`/api/novel/context?work_id=${w1}&chapter_id=${a2}&mode=full`);
  const sr2 = (ctxRes2.data && ctxRes2.data.semantic_recall) || {};
  ok('C1 全部被拦 → status=filtered', sr2.status === 'filtered', JSON.stringify({ status: sr2.status }));
  ok('C2 缺口说明如实解释（来源校验），不谎报"没有命中"', String(sr2.gap_reason || '').includes('来源校验'), String(sr2.gap_reason || ''));
  ok('C3 被拦内容不在 assembled，但缺口占位在', !String(ctxRes2.data.assembled || '').includes('全是别的书的内容') && String(ctxRes2.data.assembled || '').includes('来源校验'));

  // ── F. 共享资料库层（门控；检索全走 stub，零真实库写入）──
  // 打开开关：直接写隔离库的 app_settings——开关语义就是这一个键（HTTP 写入口属 P2）。
  const libDoc1 = `${SHARED_LIBRARY_ROOT}/方法/冲突设计.md`;
  const libDoc2 = `${SHARED_LIBRARY_ROOT}/方法/节奏控制.md`;
  dbSet("INSERT INTO app_settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value", `library_enabled:${w2}`);
  stubState.libraryHits = [
    { uri: libDoc1, score: 0.62, abstract: '冲突设计资料摘要' },
    { uri: `${SHARED_LIBRARY_ROOT}/_probe/tmp.md`, score: 0.58, abstract: '探针残留（保留前缀）' },
    { uri: `${scope1}/chapters/${a1}.md`, score: 0.55, abstract: '作品正文混入资料层' },
  ];
  stubState.reads = new Map([
    ...stubState.reads,
    [`${SHARED_LIBRARY_ROOT}/_probe/tmp.md`, '# 探针残留\n不该进上下文的资料残留-甲'],
    [libDoc1, '# 冲突设计\n一句话结论：冲突设计资料标记-乙。\n\n## 适用场景\n仅用于隔离测试。'],
    [`${scope1}/chapters/${a1}.md`, '# 甲一\n作品正文-混入资料层的对照'],
  ]);
  stubState.hits = [];
  const libCtx = await authorReq(`/api/novel/context?work_id=${w2}&chapter_id=${b1}&mode=full`);
  const libRec = (libCtx.data && libCtx.data.library_recall) || {};
  const libAssembled = String((libCtx.data && libCtx.data.assembled) || '');
  ok('F1 开关打开 → 资料层出现、命中内容正确、检索打在独立 find（target_uri=共享根）',
    libRec.status === 'ok' && (libRec.hits || []).length === 1 && libRec.hits[0].uri === libDoc1
      && libAssembled.includes('参考资料（非本书事实）') && libAssembled.includes('冲突设计资料标记-乙')
      && stubState.libraryFindCalls >= 1,
    JSON.stringify({ status: libRec.status, hits: (libRec.hits || []).map((h) => h.uri), libraryFinds: stubState.libraryFindCalls }));
  ok('F2 条目形状：label 带「参考资料｜」前缀、canon 记 reference（永不 canon）、文本 ≤300 字',
    String((libRec.hits[0] || {}).label).startsWith('参考资料｜')
      && ((libRec.hits[0] || {}).source_meta || {}).canon === 'reference'
      && String((libRec.hits[0] || {}).text || '').length <= 301,
    JSON.stringify({ label: (libRec.hits[0] || {}).label, canon: ((libRec.hits[0] || {}).source_meta || {}).canon }));
  const libOmitted = libRec.omitted || [];
  ok('F3 资料层内混入的作品条目与保留前缀被拦下（not_library_item / library_reserved），内容不进 assembled',
    libOmitted.some((o) => o.code === 'not_library_item') && libOmitted.some((o) => o.code === 'library_reserved')
      && !libAssembled.includes('不该进上下文的资料残留-甲'),
    JSON.stringify(libOmitted.map((o) => o.code)));

  // F3b P1 真机实测回归：OV 伴随文件（.abstract/.overview）分数更高，也不得挤掉真资料
  stubState.libraryHits = [
    { uri: `${SHARED_LIBRARY_ROOT}/方法/.abstract.md`, score: 0.93, abstract: '目录摘要（伴随文件）' },
    { uri: `${SHARED_LIBRARY_ROOT}/方法/.overview.md`, score: 0.88, abstract: '目录总览（伴随文件）' },
    { uri: libDoc1, score: 0.5, abstract: '合法资料' },
    { uri: libDoc2, score: 0.48, abstract: '合法资料' },
  ];
  stubState.reads = new Map([...stubState.reads, [libDoc2, '# 节奏控制\n一句话结论：节奏控制资料标记-丙。']]);
  const preCtx = await authorReq(`/api/novel/context?work_id=${w2}&chapter_id=${b4}&mode=full`);
  const preRec = (preCtx.data && preCtx.data.library_recall) || {};
  const preAssembled = String((preCtx.data && preCtx.data.assembled) || '');
  ok('F3b 伴随文件分数更高也不挤占名额：先过滤再截断，两篇真资料都进层、伴随文件带 library_reserved 归因',
    (preRec.hits || []).length === 2 && preRec.hits.every((h) => h.uri === libDoc1 || h.uri === libDoc2)
      && (preRec.omitted || []).filter((o) => o.code === 'library_reserved').length === 2
      && !preAssembled.includes('目录摘要（伴随文件）'),
    JSON.stringify({ hits: (preRec.hits || []).map((h) => h.uri), omitted: (preRec.omitted || []).map((o) => o.code) }));

  const offFindCalls = stubState.libraryFindCalls;
  stubState.libraryHits = [{ uri: libDoc2, score: 0.66, abstract: '节奏控制资料摘要' }];
  stubState.reads = new Map([...stubState.reads, [libDoc2, '# 节奏控制\n一句话结论：节奏控制资料标记-丙。']]);
  const offCtx = await authorReq(`/api/novel/context?work_id=${w1}&chapter_id=${a3}&mode=full`);
  const offRec = (offCtx.data && offCtx.data.library_recall) || {};
  const offAssembled = String((offCtx.data && offCtx.data.assembled) || '');
  ok('F4 未开开关的作品零影响：enabled=false、层不存在、资料内容不出现、连检索都不发起',
    offRec.enabled === false && !offAssembled.includes('节奏控制资料标记-丙')
      && !offAssembled.includes('参考资料（非本书事实）') && stubState.libraryFindCalls === offFindCalls,
    JSON.stringify({ enabled: offRec.enabled, status: offRec.status, finds: stubState.libraryFindCalls - offFindCalls }));

  stubState.libraryHits = [];
  const b2Ctx = await authorReq(`/api/novel/context?work_id=${w2}&chapter_id=${b2}&mode=full`);
  const b2Rec = (b2Ctx.data && b2Ctx.data.library_recall) || {};
  const b2Assembled = String((b2Ctx.data && b2Ctx.data.assembled) || '');
  ok('F5 开关打开但零命中 → status=no-hits、层不出现、不插占位（有意区别于 recall）',
    b2Rec.status === 'no-hits' && (b2Rec.hits || []).length === 0 && !b2Assembled.includes('参考资料（非本书事实）'),
    JSON.stringify({ status: b2Rec.status }));

  stubState.hits = [{ uri: libDoc2, score: 0.91, abstract: '资料混进作品召回' }];
  const crossCtx = await authorReq(`/api/novel/context?work_id=${w2}&chapter_id=${b3}&mode=full`);
  const cross = (crossCtx.data && crossCtx.data.semantic_recall) || {};
  const crossAssembled = String((crossCtx.data && crossCtx.data.assembled) || '');
  ok('F6 资料条目不得进作品召回层：filtered + omitted 归因（library_out_of_scope）、缺口显式可见',
    cross.status === 'filtered' && (cross.omitted || []).some((o) => o.code === 'library_out_of_scope')
      && (cross.hits || []).length === 0 && crossAssembled.includes('来源校验'),
    JSON.stringify({ status: cross.status, omitted: (cross.omitted || []).map((o) => o.code) }));

  // ── D. replay / rebuild / audit ──
  stubState.lsOk = true;
  stubState.ls = [
    { uri: `${scope1}/meta.md`, rel_path: 'meta.md', isDir: false },
    { uri: `${scope1}/chapters`, rel_path: 'chapters', isDir: true },
    { uri: `${scope1}/chapters/${a1}.md`, rel_path: `chapters/${a1}.md`, isDir: false },
    { uri: `${scope1}/chapters/old-77.md`, rel_path: 'chapters/old-77.md', isDir: false },
  ];
  const replay = await authorReq('/api/novel/projections/replay', { method: 'POST', body: { work_id: w1, reason: 'test_replay' } });
  ok('D1 replay 投递投影任务（走既有 outbox，幂等键可见）',
    replay.status === 200 && replay.data.ok && replay.data.projection_id > 0 && String(replay.data.dedup_key).startsWith(`replay:${w1}:`),
    JSON.stringify(replay.data));
  await new Promise((r) => setTimeout(r, 400)); // 让 drain 跑完（stub 全成功）
  const projList = (await authorReq(`/api/novel/projections?work_id=${w1}`)).data;
  ok('D2 replay 的投影可查询且未被当成失败',
    Array.isArray(projList.projections) && projList.projections.some((p) => p.kind === 'ov_work_sync' && p.status === 'done')
      && Number(projList.summary.done) >= 1 && Number(projList.summary.failed) === 0,
    JSON.stringify(projList.summary));

  const delBefore = stubState.deletes.length;
  const dry = await authorReq('/api/novel/projections/rebuild', { method: 'POST', body: { work_id: w1 } });
  ok('D3 rebuild 默认 dry-run：返回待删除集合，且未发出任何删除请求',
    dry.status === 200 && dry.data.dry_run === true && dry.data.deletable.length === 3 && stubState.deletes.length === delBefore,
    JSON.stringify({ status: dry.status, data: dry.data, deletes: stubState.deletes.length }));

  stubState.ls = [...stubState.ls, { uri: `${scope1}/evil.exe`, rel_path: 'evil.exe', isDir: false }];
  const refused = await authorReq('/api/novel/projections/rebuild', { method: 'POST', body: { work_id: w1, confirm: true, dry_run: false } });
  ok('D4 范围证明失败（形状不明条目）→ 拒绝执行、零删除',
    refused.status === 409 && String(refused.data.error || '').includes('拒绝') && stubState.deletes.length === delBefore,
    JSON.stringify({ status: refused.status, error: refused.data.error }));

  stubState.ls = stubState.ls.filter((e) => !e.uri.endsWith('evil.exe'));
  const executed = await authorReq('/api/novel/projections/rebuild', { method: 'POST', body: { work_id: w1, confirm: true, dry_run: false } });
  ok('D5 confirm 后执行：逐条删除计划内条目并重建同步',
    executed.status === 200 && executed.data.ok && executed.data.removed === 3 && stubState.deletes.length >= delBefore + 3,
    JSON.stringify({ status: executed.status, data: executed.data, deletes: stubState.deletes.length }));
  ok('D6 删除的正是范围证明里的集合（没多删）',
    stubState.deletes.slice(delBefore).every((u) => u.startsWith(scope1)),
    JSON.stringify(stubState.deletes.slice(delBefore)));

  stubState.lsOk = false;
  const delBefore2 = stubState.deletes.length;
  const unavailable = await authorReq('/api/novel/projections/rebuild', { method: 'POST', body: { work_id: w1, confirm: true, dry_run: false } });
  ok('D7 记忆服务不可用 → 拒绝执行、零删除、明确报错（绝不"先删再重建"）',
    unavailable.status === 409 && String(unavailable.data.error || '').includes('未执行任何删除') && stubState.deletes.length === delBefore2,
    JSON.stringify({ status: unavailable.status, error: unavailable.data.error }));
  stubState.lsOk = true;

  const audit = (await authorReq(`/api/novel/projections/audit?work_id=${w1}`)).data.audit || [];
  ok('D8 审计可读：dry-run/拒绝/执行/不可用 都有记录且带范围',
    audit.length >= 4
      && audit.some((a) => a.status === 'planned')
      && audit.some((a) => a.status === 'refused')
      && audit.some((a) => a.status === 'done')
      && audit.some((a) => a.status === 'blocked')
      && audit.every((a) => String(a.scope_uri).startsWith('viking://')),
    JSON.stringify(audit.map((a) => [a.op, a.status])));

  const agentRebuild = await agentReq('/api/novel/projections/rebuild', { method: 'POST', body: { work_id: w1, confirm: true, dry_run: false } });
  ok('E1 模型侧 rebuild → 403（破坏性操作不接受 X-Novel-Agent）', agentRebuild.status === 403, `实际 ${agentRebuild.status}`);
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n召回来源边界：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
