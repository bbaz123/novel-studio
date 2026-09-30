#!/usr/bin/env node
/**
 * tests/temporal/13-context-cache.test.mjs —— T5「缓存不串线 / 过期索引不回灌」证据
 * （隔离实例 + 本机 OV stub；零计费、零外部网络）。
 *
 * 覆盖：
 *   D1 同一请求命中同一装配（context_id 稳定）；
 *   D2 进程外状态推进（测试进程直写隔离库的时态更正，不经过服务端 touchWork）后，
 *      同一请求必须重新装配：外部版本串含时态状态版本，缓存不得返回陈旧状态（AC-33/34）；
 *   D3 本作品语义索引里仍有旧稿命中（外部索引尚未更新/本章有新保存未确认）时，
 *      命中被识别并拦下（unconfirmed_index），旧稿内容不得回灌（AC-34）；
 *   D4 召回层仍受章序约束：章前查询不得召回本章旧稿（future_chapter）。
 *
 * 纪律：NOVELSTUDIO_DATA_DIR 指向 mkdtemp 临时目录；OV 只连本机 stub；全部作品自建自清理。
 */
import { createServer } from 'node:http';
import { createAssert, createClient, startIsolatedServer } from './http-harness.mjs';

const a = createAssert();

// ── 本机 OV stub（只认 /health、find、content/read）────────────────────────
const stubState = { hits: [], reads: new Map(), findCalls: 0 };
const stub = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/health') return send({ status: 'ok', result: { ok: true } });
  if (url.pathname === '/api/v1/search/find') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      stubState.findCalls += 1;
      send({ status: 'ok', result: { memories: stubState.hits.map((h) => ({ uri: h.uri, score: h.score, abstract: h.abstract || '' })), resources: [], skills: [] } });
    });
    return;
  }
  if (url.pathname === '/api/v1/content/read') {
    const uri = url.searchParams.get('uri');
    return send({ status: 'ok', result: stubState.reads.get(uri) || '' });
  }
  return send({ status: 'ok', result: {} });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

const server = await startIsolatedServer({
  tag: 't5-cache',
  env: {
    NOVELSTUDIO_OV_DISABLED: '0',
    NOVELSTUDIO_OV_AUTOINDEX: '0',
    OPENVIKING_URL: `http://127.0.0.1:${stubPort}`,
    OPENVIKING_CREDENTIAL_SOURCE: 'env',
    OPENVIKING_API_KEY: '',
    OPENVIKING_BEARER_TOKEN: '',
    NOVELSTUDIO_OPENVIKING_PEER_ID: 't5-cache-test',
  },
});
const client = createClient(server.base);

try {
  const wk = await client.createWork('T5 缓存与时态版本');
  const W = Number(wk.json.id);
  const ids = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await client.createChapter(W, `第${i}章`, { content: `<p>第${i}章 占位。</p>` });
    ids.push(Number(r.json.id));
  }
  const [c1, c2, c3] = ids;
  const on = await client.setTemporal(W, { temporal_enabled: true, auto_analysis_enabled: false, repair_enabled: false });
  a.ok('D0 时态引擎开启', on.status === 200 && !!on.json.schema_ok);
  const CONTENT = {
    1: '<p>第1章 王师傅在青云镇教主角练刀。</p>',
    2: '<p>第2章 主角与王师傅同行。</p>',
    3: '<p>第3章 两人抵达黑风谷口，停下休整。</p>',
  };
  let seedErr = '';
  for (let i = 1; i <= 3; i += 1) {
    const r = await client.api('PUT', `/api/chapters/${ids[i - 1]}`, { title: `第${i}章`, content: CONTENT[i] });
    if (r.status !== 200) { seedErr = `保存第${i}章失败：${r.status}`; break; }
    const fixes = [{ kind: 'plotline', entity_id: '主线进度', predicate: 'state', value: `第${i}章：推进` }];
    if (i === 1) {
      fixes.push({ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '在青云镇' });
      fixes.push({ kind: 'character', entity_id: '主角', predicate: 'status', value: '存活' });
    }
    const cr = await client.correct(W, ids[i - 1], fixes);
    if (!cr.json || cr.json.ok !== true) { seedErr = `更正第${i}章失败：${cr.status} ${cr.text.slice(0, 160)}`; break; }
  }
  a.ok('D0 可信前缀（逐章保存 + 作者更正）', seedErr === '', seedErr);

  // ── OV stub：写入本作品子树的两条命中（第 1 章＝前情；第 3 章＝本章旧稿/未来相对章前）──
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = `${server.dataDir}/novel.db`;
  let scope = '';
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT ov_uri FROM works WHERE id = ?').get(W);
    scope = `viking://user/default/resources/novel-studio/${row && row.ov_uri}`;
    db.close();
  } catch (e) {
    a.ok('D0 读取作品 ov_uri（供 stub 构造 URI）', false, String(e && e.message));
  }
  a.ok('D0 隔离库读到 ov_uri', scope.startsWith('viking://') && !scope.endsWith('undefined'), scope);
  const ALPHA_TEXT = '前情标记 alpha 的正文片段';
  const BETA_TEXT = '本章旧稿标记 beta 的旧稿内容';
  stubState.hits = [
    { uri: `${scope}/chapters/${c1}.md`, score: 0.95, abstract: '前情标记 alpha' },
    { uri: `${scope}/chapters/${c3}.md`, score: 0.9, abstract: '本章旧稿标记 beta' },
  ];
  stubState.reads.set(`${scope}/chapters/${c1}.md`, `# 第1章回顾\n${ALPHA_TEXT}`);
  stubState.reads.set(`${scope}/chapters/${c3}.md`, `# 第3章旧稿\n${BETA_TEXT}`);

  // ── D1/D4：章前装配：只保留前情，本章旧稿不得当作既发生事实回灌 ──────────
  const url = `/api/novel/context?work_id=${W}&chapter_id=${c3}&mode=full`;
  const ctx1 = await client.api('GET', url);
  const j1 = ctx1.json || {};
  const asm1 = String(j1.assembled || '');
  a.ok('D1 装配 200 且召回层启用', ctx1.status === 200 && j1.semantic_recall && j1.semantic_recall.enabled === true, `status=${ctx1.status} recall=${JSON.stringify(j1.semantic_recall && j1.semantic_recall.status)}`);
  a.ok('D1 前情命中进入了召回层', asm1.includes('alpha'), asm1.slice(0, 300));
  a.ok('D4 本章旧稿命中被拦（章前边界 / future_chapter）', !asm1.includes('beta') && (j1.semantic_recall.omitted || []).some((d) => d.code === 'future_chapter' && String(d.uri).includes('/chapters/' + c3 + '.md')), JSON.stringify(j1.semantic_recall.omitted || []));
  a.ok('D1 召回只保留 1 条（另一条被拦）', Array.isArray(j1.semantic_recall.hits) && j1.semantic_recall.hits.length === 1, String(j1.semantic_recall.hits.length));

  const ctx1b = await client.api('GET', url);
  a.ok('D1 相同请求命中同一装配（context_id / request_id 相同）', ctx1b.json && ctx1b.json.context_id === j1.context_id && ctx1b.json.context_request_id === j1.context_request_id, `${j1.context_id} vs ${ctx1b.json && ctx1b.json.context_id}`);

  // ── D2：进程外状态推进（越过服务端 touchWork）→ 缓存必须因时态版本失效 ────
  process.env.NOVELSTUDIO_DATA_DIR = server.dataDir;
  const StoryState = await import('../../ai/story-state/index.mjs');
  const T = StoryState.Temporal;
  const v1 = T.temporalVersionOf(W);
  const direct = T.correctAuthorState({ workId: W, chapterId: c2, corrections: [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '旧伤复发' }] });
  a.ok('D2 进程外更正成功（不经过服务端 Http/通知路径）', direct && direct.ok === true, JSON.stringify(direct && direct.decision));
  const v2 = T.temporalVersionOf(W);
  a.ok('D2 时态版本串发生变化（缓存外部版本可观察到）', v1 !== v2 && v2.length > 0, `${v1} -> ${v2}`);
  const ctx2 = await client.api('GET', url);
  const asm2 = String((ctx2.json || {}).assembled || '');
  a.ok('D2 同请求重新装配（context_id 变化，未返回陈旧状态）', ctx2.json && ctx2.json.context_id !== j1.context_id, `${j1.context_id} vs ${ctx2.json && ctx2.json.context_id}`);
  a.ok('D2 新状态进入装配（旧伤复发，截至第 3 章章前）', asm2.includes('旧伤复发'), asm2.slice(0, 300));

  // ── D3：本章有未确认的新保存 → 索引旧稿命中被识别并拦下（unconfirmed_index）──
  const saved = await client.api('PUT', `/api/chapters/${c3}`, { title: '第3章', content: '<p>第3章 修订中的新稿 beta2 标记。</p>' });
  a.ok('D3 第 3 章保存新正文（形成 pending 修订）', saved.status === 200, `status=${saved.status}`);
  const urlAfter = `/api/novel/context?work_id=${W}&chapter_id=${c3}&mode=full&boundary=after`;
  const ctx3 = await client.api('GET', urlAfter);
  const j3 = ctx3.json || {};
  const asm3 = String(j3.assembled || '');
  a.ok('D3 游标识别「本章有未确认新正文」', ctx3.status === 200 && j3.temporal_context && j3.temporal_context.cursor.pending_on_boundary === true, JSON.stringify(j3.temporal_context && j3.temporal_context.cursor));
  a.ok('D3 旧索引命中被拦（unconfirmed_index），不得回灌旧稿', !asm3.includes('beta') && (j3.semantic_recall.omitted || []).some((d) => d.code === 'unconfirmed_index' && String(d.uri).includes('/chapters/' + c3 + '.md')), JSON.stringify(j3.semantic_recall.omitted || []));
  a.ok('D3 前情命中仍保留（只拦可疑来源，不误伤）', asm3.includes('alpha'));

  await client.deleteWork(W);
  a.ok('D5 清理完成（隔离库，临时目录）', true);
} finally {
  server.stop();
  stub.close();
}

const fails = a.summary('T5 上下文缓存与时态版本（13-context-cache）');
process.exit(fails ? 1 : 0);
