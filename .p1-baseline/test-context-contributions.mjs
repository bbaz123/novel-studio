#!/usr/bin/env node
/**
 * test-context-contributions.mjs —— R05「运行时上下文贡献记录 + 来源感知去重」隔离测试（零计费）。
 *
 * 覆盖：
 *   A. 纯模块：贡献条目形状（unit=char、hash、无 body 字段）、重复判定、去重标注/删除语义、
 *      记录聚合（预算/超限/重复数/省下字数）、DSH bundle 规则读取
 *   B. HTTP（OV stub）：装配后记录可读；宿主层与召回的来源/hash/长度齐全；
 *      与宿主层重复的召回**默认只标注不删除**（旧行为不变）；打开 ov_recall_dedup 后从上下文去掉并记账
 *   C. 记录与日志里**没有正文**（只记结构）；未装配过的章节 → 404（不编造）
 *   D. DSH 请求路径：创建 harness 任务即写入规则贡献（用假 dsh 目录，任务本身失败但记录真实）
 *
 * 用法: node .p1-baseline/test-context-contributions.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  layerContribution, recallHitContribution, omittedRecallContribution, dshContribution,
  buildContributionRecord, dedupeContributions, findDuplicateLayer, dshBundleRuleEntries, contentHash,
} from '../ai/context/contributions.mjs';
import { sha16 } from '../ai/story-state/hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PLUGIN_VERSION_EXPECTED = JSON.parse(readFileSync(join(REPO, 'harness-plugins', 'novel-writing', 'plugin.json'), 'utf8')).version;
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(6100 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(6100 + (process.pid % 300)));
});
const OV_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-contrib-'));
const FAKE_DSH = mkdtempSync(join(tmpdir(), 'novel-fake-dsh-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ══════════════════ A. 纯模块 ══════════════════
console.log('【A. 贡献记录（纯模块）】');
{
  const text = '这是一段用于贡献记录的测试文本。';
  const entry = layerContribution({ id: 'memory', emitted: 123, estimatedTokens: 80, outcomeReason: '完整进入上下文' }, { workId: 7, chapterId: 9, mode: 'full', text });
  ok('A1 宿主层条目：unit=char / hash 与内容一致 / 带 work+chapter',
    entry.unit === 'char' && entry.content_hash === sha16(text) && entry.work_id === 7 && entry.chapter_id === 9 && entry.chars === 123,
    JSON.stringify({ unit: entry.unit, hash: entry.content_hash }));
  ok('A2 条目里没有正文字段（只记结构）', !('text' in entry) && !JSON.stringify(entry).includes(text.slice(0, 8)));

  const recall = recallHitContribution({ uri: 'viking://x/1.md', text: '召回文本', source_meta: { rel: 'chapters/1.md', canon: 'canon' } }, { workId: 7 });
  ok('A3 召回条目：source=openviking_recall / dedup_id=ov:<uri> / chars=文本长度',
    recall.source === 'openviking_recall' && recall.dedup_id === 'ov:viking://x/1.md' && recall.chars === 4 && recall.dedup === true);
  const omitted = omittedRecallContribution({ uri: 'viking://y.md', code: 'out_of_scope', reason: '跨书' }, { workId: 7 });
  ok('A4 被拦条目：used=false 且带原因', omitted.used === false && omitted.omitted_reason === '跨书');

  const dupLayer = findDuplicateLayer('重复的段落内容', [{ id: 'memory', text: '这里是…重复的段落内容…的上下文' }], { minChars: 3 });
  ok('A5 重复判定：命中宿主层 id', dupLayer === 'memory');
  ok('A6 重复判定：过短片段不算重复（避免噪声）', findDuplicateLayer('短', [{ id: 'memory', text: '短' }]) === null);
  ok('A7 重复判定：无关内容不算重复', findDuplicateLayer('完全无关的一段话', [{ id: 'memory', text: '另一段话' }], { minChars: 3 }) === null);

  const dupEntries = [
    { used: true, chars: 100, dedup: true, content_hash: 'h1', dedup_id: 'layer:memory', omitted_reason: '' },
    { used: true, chars: 90, dedup: true, content_hash: 'h1', dedup_id: 'ov:a', omitted_reason: '' },
  ];
  const marked = dedupeContributions(dupEntries, { apply: false });
  ok('A8 默认只标注：重复条目仍 used=true，但写入 duplicate_of',
    marked.entries[1].used === true && marked.entries[1].duplicate_of === 'layer:memory' && marked.duplicates.length === 1 && marked.saved_chars === 0);
  const dropped = dedupeContributions(dupEntries, { apply: true });
  ok('A9 打开去重：重复条目 used=false，省下字数入账',
    dropped.entries[1].used === false && dropped.saved_chars === 90 && dropped.entries[1].dedup_action === 'dropped');

  const record = buildContributionRecord({
    workId: 7, chapterId: 9, mode: 'full', requestId: 'req-1', contextId: 'ctx-1', session: 's1',
    manifest: [{ id: 'memory' }, { id: 'recall' }], stats: { budget: 1000, length: 900, layerCount: 2, truncatedLayers: 0, droppedChars: 0, estimatedTokens: 450 },
    entries: [entry], overflow: null,
  });
  ok('A10 记录聚合：预算/长度/层 id/session/单位可核对',
    record.budget === 1000 && record.length === 900 && record.layer_ids.join(',') === 'memory,recall'
      && record.session === 's1' && record.unit === 'char' && record.over_budget === false);

  const real = dshBundleRuleEntries(join(REPO, 'harness-plugins', 'novel-writing'));
  const ids = real.map((e) => e.id);
  ok('A11 DSH 规则读取：persona/patch/tools 齐全且带 bundle 版本',
    ids.includes('agent.cordis.yml') && ids.includes('cordis.patch.yml') && ids.includes('plugin.tools')
      && real.every((e) => e.version === PLUGIN_VERSION_EXPECTED),
    JSON.stringify(ids));
  const dshEntry = dshContribution(real[0], { workId: 7, chapterId: 9, session: 's1' });
  ok('A12 DSH 条目：带内容 hash 与长度，规则版本可追踪（正文只用于取 hash）',
    dshEntry.content_hash === contentHash(real[0].text) && dshEntry.chars === real[0].text.length && dshEntry.rule_version === PLUGIN_VERSION_EXPECTED && !('text' in dshEntry));
}

// ══════════════════ 隔离实例 + OV stub ══════════════════
const stubState = { hits: [], reads: new Map() };
const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${OV_PORT}`);
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/health') return send({ status: 'ok', result: { ok: true } });
  if (url.pathname === '/api/v1/search/find') return send({ status: 'ok', result: { memories: stubState.hits, resources: [], skills: [] } });
  if (url.pathname === '/api/v1/content/read') return send({ status: 'ok', result: stubState.reads.get(url.searchParams.get('uri')) || '' });
  if (url.pathname === '/api/v1/content/write') { req.resume(); return send({ status: 'ok', result: { ok: true } }); }
  if (url.pathname === '/api/v1/fs/ls') return send({ status: 'ok', result: [] });
  if (req.method === 'DELETE') return send({ status: 'ok', result: { ok: true } });
  return send({ status: 'ok', result: {} });
});
await new Promise((r) => stub.listen(OV_PORT, '127.0.0.1', r));

// 假 dsh 目录：有 package.json（isHarnessAvailable=true）但没有构建产物 → 任务会失败，但**不会**发模型请求。
mkdirSync(FAKE_DSH, { recursive: true });
writeFileSync(join(FAKE_DSH, 'package.json'), JSON.stringify({ name: 'fake-dsh', version: '0.0.0', private: true, scripts: { build: 'node -e "process.exit(1)"' } }), 'utf8');

console.log(`\n贡献记录隔离测试（端口 ${PORT}，OV stub ${OV_PORT}，数据目录 ${DATA_DIR}）`);
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
    NOVELSTUDIO_DSH_REPO: FAKE_DSH,
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'enh-contrib-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { stub.close(); } catch { /* 已关闭 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { rmSync(FAKE_DSH, { recursive: true, force: true }); } catch { /* 忽略 */ }
};

async function jfetch(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await jfetch('/api/novel/ping', { timeout: 2000 }); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000)); cleanup(); process.exit(2); }

try {
  const MEM = '长期记忆的唯一句子：主角在雨夜抵达城门，守军点燃了烽火，远处传来钟声三响；'
    + '他把湿透的斗篷交给驿卒，独自登上城墙，看见北面的山脊像一条沉睡的龙，'
    + '而城下的火把在雨里排成一条细长的线，一直延伸到看不见的地方。';
  const BODY = '章节正文的唯一句子：他推开门，屋里只有一盏灯。';
  const w = (await jfetch('/api/works', { method: 'POST', body: { title: '贡献记录·甲书' } })).data.id;
  const c1 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: w, title: '第一章' } })).data.id;
  const c2 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: w, title: '第二章' } })).data.id;
  await jfetch('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: c1, content: `<p>${BODY}</p>` } });
  await jfetch('/api/story_memory', { method: 'PUT', body: { work_id: w, summary: MEM } });
  const scope = `viking://user/default/resources/novel-studio/${(() => { const d = new DatabaseSync(join(DATA_DIR, 'novel.db')); try { d.exec('PRAGMA busy_timeout = 5000'); } catch {} try { return d.prepare('SELECT ov_uri FROM works WHERE id = ?').get(w).ov_uri; } finally { d.close(); } })()}`;
  stubState.hits = [{ uri: `${scope}/chapters/${c1}.md`, score: 0.9, abstract: MEM }];
  // 记忆库里的文件带标题行（生产路径按首个 # 行取 label；无标题行会被当噪声跳过）。
  stubState.reads.set(`${scope}/chapters/${c1}.md`, `# 第一章 雨夜\n${MEM}`);
  ok('准备：作品 + 两章 + 正文 + 长期记忆 + OV 命中（与长期记忆逐字相同）', !!(w && c1 && c2));

  // ── B1 默认：标注重复但不删除（旧行为不变）──
  await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c1}&mode=full`);
  const sem1 = (await jfetch('/api/novel/semantic')).data;
  ok('B1 去重开关默认关闭（旧作品行为不变）', sem1.dedup_recall === false, JSON.stringify(sem1));
  const rec1 = (await jfetch(`/api/novel/context/contributions?work_id=${w}&chapter_id=${c1}`)).data.record;
  ok('B2 装配后可读到贡献记录（含预算/长度/层清单）',
    !!rec1 && rec1.unit === 'char' && rec1.budget > 0 && rec1.length > 0 && rec1.length <= rec1.budget && rec1.over_budget === false,
    JSON.stringify(rec1 && { budget: rec1.budget, length: rec1.length }));
  ok('B3 宿主层来源齐全（每层有 id/长度/hash）',
    ['work', 'memory', 'recall'].every((id) => rec1.layer_ids.includes(id))
      && rec1.entries.filter((e) => e.source === 'host_context_layer').every((e) => e.rule_id && e.chars >= 0 && /^[0-9a-f]{16}$/.test(e.content_hash)),
    JSON.stringify(rec1.layer_ids));
  const recallEntry1 = rec1.entries.find((e) => e.source === 'openviking_recall');
  ok('B4 与宿主层重复的召回被标注（duplicate_of=layer:memory）但仍在使用（只标注不删除）',
    !!recallEntry1 && recallEntry1.duplicate_of === 'layer:memory' && recallEntry1.used === true && recallEntry1.dedup_action === 'marked',
    JSON.stringify(recallEntry1));
  ok('B5 记录里没有正文（只有 hash/长度/来源）',
    !JSON.stringify(rec1).includes('唯一句子'), JSON.stringify(rec1).slice(0, 160));
  ok('B6 默认日志同样不落正文',
    !serverLog.includes('唯一句子'), serverLog.includes('唯一句子') ? serverLog.slice(0, 200) : '');

  // ── B2 打开去重 → 重复召回从上下文去掉并记账 ──
  const toggled = (await jfetch('/api/novel/semantic', { method: 'PUT', body: { enabled: true, dedup_recall: true } })).data;
  ok('B7 去重开关可打开并回读', toggled.dedup_recall === true);
  const ctx2 = (await jfetch(`/api/novel/context?work_id=${w}&chapter_id=${c2}&mode=full`)).data;
  const rec2 = (await jfetch(`/api/novel/context/contributions?work_id=${w}&chapter_id=${c2}`)).data.record;
  const recallEntry2 = rec2.entries.find((e) => e.source === 'openviking_recall');
  const countInCtx = String(ctx2.assembled).split(MEM).length - 1;
  ok('B8 打开去重后：重复召回不再进入上下文（该句只出现一次，来自宿主层）',
    countInCtx === 1, `出现 ${countInCtx} 次`);
  ok('B9 去重行为入账：used=false / dedup_action=dropped / 省下字数>0',
    !!recallEntry2 && recallEntry2.used === false && recallEntry2.duplicate_of === 'layer:memory'
      && recallEntry2.dedup_action === 'dropped' && rec2.saved_chars >= 40,
    JSON.stringify(recallEntry2 && { used: recallEntry2.used, action: recallEntry2.dedup_action, saved: rec2.saved_chars }));

  // ── C. 未装配过的章节 → 404；全量列表可读 ──
  const none = await jfetch(`/api/novel/context/contributions?work_id=${w}&chapter_id=99999`);
  ok('C1 未装配过的章节 → 404（不编造记录）', none.status === 404, `实际 ${none.status}`);
  const all = (await jfetch('/api/novel/context/contributions?work_id=0&all=1')).data.records;
  ok('C2 ?all=1 返回记录列表（含两条装配记录）', Array.isArray(all) && all.length >= 2, `len=${all.length}`);

  // ── D. DSH 请求路径：创建任务即记录规则贡献 ──
  const job = await jfetch('/api/harness/run', { method: 'POST', body: { prompt: '测试任务', work_id: w, chapter_id: c1, session: 'sess-contrib', kind: 'test' } });
  ok('D1 harness 任务创建成功（202）', job.status === 202 && job.data.job_id, JSON.stringify(job.data));
  const dshRec = (await jfetch(`/api/novel/context/contributions?work_id=${w}&chapter_id=${c1}&session=sess-contrib`)).data.record;
  ok('D2 创建任务即写入 DSH 规则贡献（persona/patch/工具面 + 版本 + hash）',
    !!dshRec && dshRec.mode === 'harness_request' && dshRec.session === 'sess-contrib'
      && dshRec.entries.some((e) => e.source === 'dsh_bundle_rules' && e.rule_id === 'agent.cordis.yml' && e.rule_version === PLUGIN_VERSION_EXPECTED && /^[0-9a-f]{16}$/.test(e.content_hash)),
    JSON.stringify(dshRec && dshRec.entries.map((e) => [e.rule_id, e.rule_version])));
  ok('D3 DSH 记录里没有规则正文（只记 hash/长度）',
    !!dshRec && !JSON.stringify(dshRec).includes('组合原则：只做会话级贡献'),
    '');
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n上下文贡献记录：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
