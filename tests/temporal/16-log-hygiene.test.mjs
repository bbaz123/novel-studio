#!/usr/bin/env node
/**
 * tests/temporal/16-log-hygiene.test.mjs —— T8/AC-46：日志、API 错误与运行追踪的卫生验收。
 *
 * 覆盖（真实 HTTP 端点 → 真实生产调用链；默认自托管隔离实例，也可 --base 指向 ci-isolated-run）：
 *   G0  素材：作品 + 章节 + 时态引擎（自动分析）+ 本机假模型（API key 为唯一哨兵）+ 作者样文（样文哨兵）
 *   G1  基础流水与正控：保存 → 自动分析携带正文哨兵；创作上下文装配携带样文哨兵（内容真的进过链路）
 *   G2  录制窗口：debug/start → 保存 + 自动分析 + 创作上下文装配 → debug/stop（会话文件落盘）
 *   G3  追踪卫生：会话 JSONL 有真实节点（buildNovelContext / callAI 正控），但无正文/样文/API key/完整 prompt
 *   G4  业务日志卫生：app_logs 查询 + data/logs/*.log 文件均无正文/样文/API key/完整 prompt
 *   G5  失败诊断可见：模型 500 → 保存不受影响、提案 analysis.status=failed 且带错误原因；
 *       失败提案不能被确认（返回拒绝理由）；/api/ai/test 失败 → ai_errors 有可定位记录（action/endpoint）；
 *       失败路径的日志/错误历史仍然无哨兵泄漏。
 *
 * 正控（positive control）：每个哨兵都先证明「确实进过真实链路」再扫日志——
 *   否则「日志里没有」可能只是「根本没发生过」。模型请求由本机 stub 捕获，请求不出本机、零计费。
 *
 * 用法：
 *   node tests/temporal/16-log-hygiene.test.mjs                      # 自托管隔离实例
 *   node scripts/ci-isolated-run.mjs --port 3760 -- node tests/temporal/16-log-hygiene.test.mjs --base http://127.0.0.1:3760
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
let BASE = arg('--base', '');
let child = null;
let DATA_DIR = '';

// ── 哨兵：唯一命中的合成字符串；任何一处日志/追踪落盘都算泄漏 ────────────────
const BODY_SENTINEL = '青岚镇日志卫生正文哨兵甲7f3a';
const BODY2_SENTINEL = '黑风谷日志卫生正文哨兵丙2b8e';
const BODY_TAIL = '正文尾部哨兵乙9c1d';
const SAMPLE_SENTINEL = '样文哨兵铁匠铺炉火4f2e';
const KEY_SENTINEL = 'sk-hygiene-74f2e-not-billed';
const REMOTE_ERR = '日志卫生测试-远端拒绝-5a7c';
// 抽取 prompt 的两处稳定标记（系统提示词常量 + 用户提示词段落标题）。
const SYS_PROMPT_MARK = '状态记账员';
const USER_PROMPT_MARK = '章前状态（chapter 前一刻，权威来源）';

const SENTINELS = [BODY_SENTINEL, BODY2_SENTINEL, BODY_TAIL, SAMPLE_SENTINEL, KEY_SENTINEL];
const hitsAny = (text, list) => list.some((s) => String(text || '').includes(s));

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const proposalGroups = (workId, chapterId) => api('GET', `/api/novel/state/proposal-groups?work_id=${workId}&chapter_id=${chapterId}`);

/** 轮询：等某章提案达到条件（分析是后台任务，产生时机不确定）。 */
async function waitProposal(workId, chapterId, accept, { timeout = 25000 } = {}) {
  const t0 = Date.now();
  let last = '(none)';
  while (Date.now() - t0 < timeout) {
    const r = await proposalGroups(workId, chapterId);
    const ps = (r.json && r.json.proposals) || [];
    last = ps.map((p) => `${p.status}`).join(',') || '(none)';
    const hit = ps.find(accept);
    if (hit) return { proposal: hit, last };
    await sleep(250);
  }
  return { proposal: null, last };
}

/** 合成正文：哨兵在开头与结尾各一处，中间是纯虚构填充。 */
function longBody(marker) {
  const filler = '青云镇外山道起雾，驿站灯火未熄，行人沿着石阶往前赶。'.repeat(6);
  return `<p>${marker}${filler}${BODY_TAIL}</p>`;
}

/** 本机脚本化假模型（零计费）。__httpError 脚本让这次请求返回失败（用于失败诊断）。 */
function startFakeModel() {
  const state = { hits: 0, scripts: [], last: { events: [] }, seen: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      state.hits += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 空体 */ }
      const user = String(((body.messages || []).find((m) => m.role === 'user') || {}).content || '');
      state.seen.push({ path: String(req.url || ''), chars: user.length, text: user });
      const payload = state.scripts.length ? state.scripts.shift() : state.last;
      if (payload && payload.__httpError) {
        res.writeHead(payload.__httpError, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(payload.message || 'stub error') } }));
        return;
      }
      state.last = payload;
      const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub', object: 'chat.completion', model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(5600 + (process.pid % 400)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

async function startIsolatedServer() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'ns-temporal-hygiene-'));
  child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'ci-temporal-16' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  BASE = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (child.exitCode !== null) throw new Error('隔离实例提前退出：' + log.slice(-800));
    try {
      const r = await fetch(`${BASE}/api/works`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return { port, dataDir };
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('隔离实例未在超时内就绪：' + log.slice(-800));
}

/** 读隔离数据目录里的滚动日志文件（服务端 logger 的 JSONL 落盘）。 */
function readLogFiles(dataDir) {
  const dir = path.join(dataDir, 'logs');
  if (!fs.existsSync(dir)) return { raw: '', files: [] };
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('app-') && f.endsWith('.log'));
  return { raw: files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'), files };
}

/** 读运行追踪会话文件（debug-trace 的 JSONL 落盘）。 */
function readTraceFiles(dataDir) {
  const dir = path.join(dataDir, 'debug');
  if (!fs.existsSync(dir)) return { raw: '', files: [] };
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('trace-') && f.endsWith('.jsonl'));
  return { raw: files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'), files };
}

async function main() {
  if (!BASE) {
    const info = await startIsolatedServer();
    DATA_DIR = info.dataDir;
    console.log(`✓ 自托管隔离实例已就绪：${BASE}（数据目录 ${info.dataDir}）`);
  }
  console.log(`T8 日志/追踪卫生与失败诊断 @ ${BASE}\n`);

  const fake = await startFakeModel();
  const works = [];
  try {
    // ── G0 素材 ────────────────────────────────────────────────────────────────
    console.log('【G0 素材：作品 / 章节 / 引擎 / 假模型 / 样文】');
    const w = await api('POST', '/api/works', { title: 'T8 日志卫生《合成验收》', description: '自动化测试作品（自清理）' });
    if (w.status >= 300) { console.error('建作品失败', w.status, w.text.slice(0, 200)); process.exit(2); }
    const workId = w.json.id; works.push(workId);
    const c1 = (await api('POST', '/api/chapters', { work_id: workId, title: '第1章 青云镇' })).json.id;
    const c2 = (await api('POST', '/api/chapters', { work_id: workId, title: '第2章 黑风谷' })).json.id;
    const on = await api('PUT', '/api/novel/state/temporal', { work_id: workId, temporal_enabled: true, auto_analysis_enabled: true });
    ok('G0a 开启时态引擎 + 自动分析（schema 自检通过）', on.status === 200 && on.json.config?.enabled === true && on.json.schema_ok === true, `status=${on.status} ${on.text.slice(0, 160)}`);
    const cfg = await api('POST', '/api/api_configs', { name: 'T8 本机假模型（零计费）', base_url: `http://127.0.0.1:${fake.port}/v1`, api_key: KEY_SENTINEL, model: 'deepseek-chat' });
    ok('G0b 假模型配置已建立（API key 为唯一哨兵值）', cfg.status === 201 && cfg.json?.id > 0, `status=${cfg.status}`);
    const cfgId = cfg.json?.id || 0;
    const sampleText = `${SAMPLE_SENTINEL}炉火映着铁砧，老匠人把钳子伸进红煤里翻动，火星落在青石地面上碎了又暗下去。他抬头看了一眼门外的雪，把铁锤放回架上，记下明日要打的活计。`;
    const smp = await api('POST', '/api/novel/style/samples', { work_id: workId, title: 'T8 样文哨兵', text: sampleText });
    ok('G0c 作者样文入库（样文哨兵作为风格证据）', smp.status === 200 && smp.json?.sample?.id > 0, `status=${smp.status} ${smp.text.slice(0, 140)}`);

    // ── G1 基础流水 + 正控 ─────────────────────────────────────────────────────
    console.log('【G1 基础流水：保存 → 自动分析 → 创作上下文装配（正控）】');
    fake.state.scripts.push({
      events: [{
        ops: [{ type: 'set', cell: { domain: 'character', entityId: '主角', predicate: 'status', scope: 'canon', holderId: null }, expected: { kind: 'missing' }, value: '待命' }],
        evidence: [{ quote: `${BODY_SENTINEL}青云镇外山道起雾`, narrative: 'present' }],
      }],
    });
    const save1 = await api('PUT', `/api/chapters/${c1}`, { content: longBody(BODY_SENTINEL) });
    ok('G1a 第 1 章正文保存成功（真实 PUT 保存入口）', save1.status === 200, `status=${save1.status}`);
    const w1 = await waitProposal(workId, c1, (p) => p.status === 'done');
    ok('G1b 保存后自动分析完成（本机假模型）', !!w1.proposal, `last=${w1.last}`);
    ok('G1c 正控：分析请求确实携带了正文哨兵（内容真的进过链路）', fake.state.seen.some((s) => s.text.includes(BODY_SENTINEL)), `hits=${fake.state.hits}`);
    const ctx1 = await api('GET', `/api/ai_context?chapter_id=${c1}`);
    ok('G1d 正控：样文哨兵确实进入创作上下文装配（风格证据层）', ctx1.status === 200 && String(ctx1.json?.assembled || '').includes(SAMPLE_SENTINEL), `chars=${String(ctx1.json?.assembled || '').length}`);

    // ── G2 录制窗口：真实操作全部在追踪下发生 ─────────────────────────────────
    console.log('【G2 录制窗口：保存 / 分析 / 上下文装配】');
    const recStart = await api('POST', '/api/debug/start', { from: 'test', work_id: workId });
    ok('G2a 开启运行追踪（debug/start）', recStart.status === 200 && recStart.json?.ok === true, `status=${recStart.status}`);
    fake.state.scripts.push({
      events: [{
        ops: [{ type: 'set', cell: { domain: 'character', entityId: '主角', predicate: 'status', scope: 'canon', holderId: null }, expected: { kind: 'missing' }, value: '巡逻' }],
        evidence: [{ quote: `${BODY2_SENTINEL}黑风谷夜巡`, narrative: 'present' }],
      }],
    });
    const save2 = await api('PUT', `/api/chapters/${c2}`, { content: longBody(BODY2_SENTINEL) });
    const w2 = await waitProposal(workId, c2, (p) => p.status === 'done');
    ok('G2b 录制窗口内：保存 + 自动分析走通真实生产链', save2.status === 200 && !!w2.proposal, `last=${w2.last}`);
    const ctx2 = await api('GET', `/api/ai_context?chapter_id=${c2}`);
    ok('G2c 录制窗口内：创作上下文装配（样文层）完成', ctx2.status === 200 && String(ctx2.json?.assembled || '').includes(SAMPLE_SENTINEL));
    await sleep(500);
    const recStop = await api('POST', '/api/debug/stop', {});
    ok('G2d 停止录制（会话文件封卷落盘）', recStop.status === 200 && recStop.json?.ok === true, `status=${recStop.status}`);

    // ── G3 追踪卫生 ────────────────────────────────────────────────────────────
    console.log('【G3 运行追踪：有节点，无正文 / 样文 / key / 完整 prompt】');
    const trace = readTraceFiles(DATA_DIR);
    ok('G3a 追踪会话文件已生成（非空）', trace.files.length >= 1 && trace.raw.length > 0, `files=${trace.files.join(',')} bytes=${trace.raw.length}`);
    ok('G3b 正控：追踪记录了创作上下文装配节点（录制真的在工作）', trace.raw.includes('buildNovelContext'));
    ok('G3c 正控：追踪记录了真实 AI 调用节点（callAI）', trace.raw.includes('callAI'));
    ok('G3d 追踪不含正文哨兵（甲/乙/丙）', !hitsAny(trace.raw, [BODY_SENTINEL, BODY2_SENTINEL, BODY_TAIL]));
    ok('G3e 追踪不含样文哨兵', !trace.raw.includes(SAMPLE_SENTINEL));
    ok('G3f 追踪不含 API key 哨兵', !trace.raw.includes(KEY_SENTINEL));
    ok('G3g 追踪不含抽取 prompt（系统/用户提示词标记）', !trace.raw.includes(SYS_PROMPT_MARK) && !trace.raw.includes(USER_PROMPT_MARK));

    // ── G4 业务日志卫生 ───────────────────────────────────────────────────────
    console.log('【G4 业务日志：app_logs 查询 + 滚动日志文件】');
    const logs1 = await api('GET', '/api/logs?limit=500');
    const logs1Raw = JSON.stringify(logs1.json || {});
    ok('G4a 日志查询可用（正控：有真实条目）', logs1.status === 200 && Array.isArray(logs1.json?.entries) && logs1.json.entries.length > 0, `entries=${(logs1.json?.entries || []).length}`);
    ok('G4b app_logs 不含正文哨兵', !hitsAny(logs1Raw, [BODY_SENTINEL, BODY2_SENTINEL, BODY_TAIL]));
    ok('G4c app_logs 不含样文哨兵', !logs1Raw.includes(SAMPLE_SENTINEL));
    ok('G4d app_logs 不含 API key 哨兵', !logs1Raw.includes(KEY_SENTINEL));
    ok('G4e app_logs 不含抽取 prompt 标记', !logs1Raw.includes(SYS_PROMPT_MARK) && !logs1Raw.includes(USER_PROMPT_MARK));
    const logFiles1 = readLogFiles(DATA_DIR);
    ok('G4f 滚动日志文件存在且同样干净', logFiles1.files.length >= 1 && !hitsAny(logFiles1.raw, SENTINELS) && !logFiles1.raw.includes(SYS_PROMPT_MARK) && !logFiles1.raw.includes(USER_PROMPT_MARK), `files=${logFiles1.files.join(',')}`);

    // ── G5 失败诊断可见 + 失败路径仍无泄漏 ────────────────────────────────────
    console.log('【G5 失败诊断可见：分析失败 / 审批拒绝 / AI 错误】');
    fake.state.scripts.push({ __httpError: 500, message: REMOTE_ERR });
    const save3 = await api('PUT', `/api/chapters/${c2}`, { content: longBody(BODY2_SENTINEL).replace(BODY_TAIL, BODY_TAIL + '·改') });
    ok('G5a 模型失败不影响保存（正文照常落库）', save3.status === 200, `status=${save3.status}`);
    const w3 = await waitProposal(workId, c2, (p) => p.status === 'failed');
    ok('G5b 分析失败可见：提案 analysis.status=failed 且带错误原因', !!w3.proposal && String(w3.proposal.analysis?.error || '').length > 0, `last=${w3.last} err=${String(w3.proposal?.analysis?.error || '').slice(0, 120)}`);
    const apply3 = await api('POST', `/api/novel/state/proposal-groups/${encodeURIComponent(String(w3.proposal?.binding_id || 'bnd_none'))}/apply`, { work_id: workId, chapter_id: c2 });
    ok('G5c 审批失败可见：失败的提案不能被确认，返回拒绝理由', apply3.status === 200 && apply3.json?.ok === false && String(apply3.json?.reason || apply3.json?.decision || '').length > 0, apply3.text.slice(0, 180));
    fake.state.scripts.push({ __httpError: 500, message: REMOTE_ERR });
    const aiHit = await api('POST', '/api/ai/test', { config_id: cfgId });
    ok('G5d AI 错误路径真实可触发（返回错误 + 可读消息）', aiHit.status >= 400 && aiHit.text.includes(REMOTE_ERR), `status=${aiHit.status} ${aiHit.text.slice(0, 140)}`);
    const errs = await api('GET', '/api/ai_errors');
    const errsRaw = JSON.stringify(errs.json || {});
    ok('G5e AI 错误有可见诊断入口（ai_errors 记录本次失败）', errs.status === 200 && Array.isArray(errs.json) && errs.json.length > 0, `n=${Array.isArray(errs.json) ? errs.json.length : 'n/a'}`);
    const logs2 = await api('GET', '/api/logs?limit=500');
    const aiErrEntry = ((logs2.json || {}).entries || []).find((e) => e.kind === 'ai_error');
    ok('G5f ai_error 记录带 action/endpoint 上下文（可定位到具体入口）', !!aiErrEntry && !!aiErrEntry.context && aiErrEntry.context.endpoint === '/api/ai/test', JSON.stringify(aiErrEntry?.context || {}).slice(0, 160));
    ok('G5g 错误历史（ai_errors）不含正文/样文/key 哨兵', !hitsAny(errsRaw, SENTINELS));
    const logs2Raw = JSON.stringify(logs2.json || {});
    ok('G5h 失败路径后的 app_logs 仍不含四类哨兵', !hitsAny(logs2Raw, SENTINELS) && !logs2Raw.includes(SYS_PROMPT_MARK) && !logs2Raw.includes(USER_PROMPT_MARK));
    const logFiles2 = readLogFiles(DATA_DIR);
    ok('G5i 失败路径后的滚动日志文件仍不含四类哨兵', logFiles2.files.length >= 1 && !hitsAny(logFiles2.raw, SENTINELS) && !logFiles2.raw.includes(SYS_PROMPT_MARK) && !logFiles2.raw.includes(USER_PROMPT_MARK));

  } finally {
    for (const id of works) { try { await api('DELETE', `/api/works/${id}`); } catch { /* 自清理 */ } }
    try { fake.server.close(); } catch { /* 已关闭 */ }
    if (child) { try { child.kill(); } catch { /* 已退出 */ } }
  }
  console.log('\n' + '─'.repeat(46));
  console.log(`T8 日志/追踪卫生与失败诊断：通过 ${pass} / 失败 ${fails.length}`);
  if (fails.length) { for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? '  — ' + f.detail : ''}`); process.exit(1); }
}

main().catch((e) => { console.error('测试异常：', e); if (child) { try { child.kill(); } catch { /* noop */ } } process.exit(1); });
