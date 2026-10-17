#!/usr/bin/env node
/**
 * scripts/nsdsh/compare-runtime-bc.mjs —— R02：B/C **两个独立进程**的动态行为等价。
 *
 * 为什么这一步不能省（方案 §1.1 点名的要害）：
 *   `build-runtime.mjs --fixture` 的 B/C "等价"是把同一个签名 `{methods, entry, version}`
 *   赋给两边、于是 `equal: true` 来自**构造**，不来自任何一次真实运行。
 *   本脚本改成正向的证据：
 *
 *     B = 完整构建（`../deepseek-harness/apps/cli/lib/bin.js`）
 *     C = 裁剪发行物（从 zip 解压出来的 `apps/cli/lib/bin.js`）
 *
 *   两者各起**一个独立进程**、用**同一份** prompt 与同一个本机假 provider 跑一轮，
 *   然后比较：真实工具清单、发往模型的消息序列（归一化后）、终态、退出码。
 *   任何一项不同 → 不等价 → 退出码 1。
 *
 * 归一化只去掉**语义无关**的易变项（临时路径、会话 id、随机 id、时间戳），
 * 不去掉工具名、角色序列、正文内容 —— 那些正是要比较的东西。
 *
 * 用法：node scripts/nsdsh/compare-runtime-bc.mjs --artifact <zip> [--json]
 *       node scripts/nsdsh/compare-runtime-bc.mjs --baseline <dir> --candidate <dir>
 */

import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { extractTo, readZipEntries } from './lib/zip-archive.mjs';
import { buildChildEnv, spawnReal } from '../../ai/runtime/sdk-process.mjs';
import { createStdioTransport } from '../../ai/runtime/sdk-stdio-transport.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const USE_JSON = process.argv.includes('--json');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PROMPT = 'B/C 等价性对照：请只回复 B/C-OK 两个词。';

function sse(text) {
  return [
    { type: 'message_start', message: { id: 'bc', model: 'deepseek-v4-pro', usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

async function fakeProvider() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push({ unparsed: true }); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse('B/C-OK'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

/** 跑一个运行时（B 或 C），返回可比较的观测。 */
async function runOne({ label, rootDir, entryRel, home, providerUrl, profile = 'sdk', workDir = null }) {
  const entryAbs = path.join(rootDir, entryRel);
  const cwd = workDir || rootDir;
  const built = buildChildEnv({
    allow: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED'],
    extra: {
      DEEPSEEK_API_KEY: 'fake-key-not-billed',
      DEEPSEEK_BASE_URL: providerUrl,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    },
  });
  if (path.resolve(built.env.DSH_HOME) !== path.resolve(home)) throw new Error('ENV_GUARD_DSH_HOME');
  if (!/^http:\/\/127\.0\.0\.1:\d+/.test(String(built.env.DEEPSEEK_BASE_URL || ''))) throw new Error('ENV_GUARD_BASE_URL');

  const child = spawnReal({ command: process.execPath, args: [entryAbs, '--profile', profile], cwd, env: built.env });
  const tr = createStdioTransport({ input: child.stdoutStream, output: child.stdinStream });
  const types = [];
  const sessionEvents = [];
  tr.onNotification((method, params) => {
    if (method !== 'session.event') return;
    const sid = String(params.sessionId || '');
    const type = String((params.event || {}).type || '');
    types.push(type);
    if (sid !== 'bc') sessionEvents.push({ sid, type });
  });
  const out = { label, home, pid: child.pid, serverInfo: null, terminal: null, exitCode: null, error: '', events: types, foreign: sessionEvents.length, text: '' };
  try {
    out.serverInfo = await tr.request('initialize', { cwd, provider: 'deepseek-official', model: 'deepseek-v4-pro' }, { timeoutMs: 30_000 }).then((r) => r && r.serverInfo);
    await tr.request('session/prompt', { sessionId: 'bc', contentBlocks: [{ type: 'text', text: PROMPT }] }, { timeoutMs: 20_000 });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !types.includes('turn/end') && !child.exited) await new Promise((r) => setTimeout(r, 20));
    out.terminal = types.includes('turn/end') ? 'done' : (child.exited ? 'failed' : 'unknown');
    try { await tr.request('shutdown', undefined, { timeoutMs: 8000 }); } catch { out.error = 'SHUTDOWN_FAILED'; }
    await child.waitExit(10_000);
    out.exitCode = child.exitCode;
  } catch (e) {
    out.error = String((e && e.message) || e);
    child.kill('SIGTERM');
    await child.waitExit(8000);
    out.exitCode = child.exitCode;
  } finally {
    tr.close('DONE');
  }
  return out;
}

/** 找出前若干个差异路径（用于把"不等"变成可诊断的具体位置）。 */
export function diffPaths(a, b, prefix = '', out = []) {
  if (out.length >= 4) return out;
  const bothObj = a && b && typeof a === 'object' && typeof b === 'object';
  if (!bothObj) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const short = (v) => String(JSON.stringify(v)).slice(0, 120);
      out.push(`${prefix}: ${short(a)} ≠ ${short(b)}`);
    }
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (out.length >= 4) break;
    diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** 归一化：只去语义无关的易变项。 */
export function normalizeRequest(request, { roots = [] } = {}) {
  const clone = JSON.parse(JSON.stringify(request));
  const scrub = (value) => {
    if (typeof value === 'string') {
      let s = value;
      for (const root of roots) {
        // 临时目录绝对路径不该影响"行为是否等价"
        s = s.split(root).join('<ROOT>');
        s = s.split(root.replaceAll('\\', '/')).join('<ROOT>');
      }
      // 随机 UUID（消息 id / 事件 id）属于方案允许规范化的"随机 session ID"一类；
      // 它每次运行都不同，但它**不是**行为差异。
      s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
      return s;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        // 协议里这些键是可变的（时间戳 / 随机 id / 缓存键），不构成行为差异
        if (/^(metadata|user_id|x-session|timestamp|time|ts|created_?at|updated_?at|request_?id|trace_?id|session_?id)$/i.test(k)) continue;
        out[k] = scrub(v);
      }
      return out;
    }
    return value;
  };
  return scrub(clone);
}

export async function compareRuntimeBC({ artifact = null, baseline = null, candidate = null } = {}) {
  const tmpRoots = [];
  const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpRoots.push(d); return d; };
  const checks = [];
  const add = (id, name, ok, detail = '') => checks.push({ id, name, ok: ok === true, detail: String(detail || '') });

  // 解析 B / C
  let bDir = baseline;
  let cDir = candidate;
  const baselineManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'vendor/dsh/runtime-manifest.json'), 'utf8'));
  const baselineRoot = path.resolve(REPO, baselineManifest.baseline.location);
  const entryRel = baselineManifest.entry.path;
  if (!bDir) bDir = baselineRoot;
  let distManifest = null;
  if (artifact) {
    const entries = readZipEntries(fs.readFileSync(path.resolve(artifact)));
    distManifest = JSON.parse(entries.get('runtime-manifest.json').toString('utf8'));
    cDir = path.join(mk('ns-bc-c-'), 'c');
    fs.mkdirSync(cDir, { recursive: true });
    extractTo(entries, cDir, { fs, path });
  }
  if (!cDir) return { ok: false, reason: 'MISSING_CANDIDATE', checks };

  // B/C 必须跑在**同一个中立工作目录**上：否则 cwd 里的 AGENTS.md / skills / 目录结构不同，
  // 注入给模型的 context 本来就该不同，比较就失去意义（第一版 BC3 假红正是这个原因）。
  const sharedCwd = path.join(mk('ns-bc-cwd-'), 'work');
  fs.mkdirSync(sharedCwd, { recursive: true });
  const provider = await fakeProvider();
  const bHome = path.join(mk('ns-bc-hb-'), 'dsh');
  const b = await runOne({ label: 'B(完整构建)', rootDir: bDir, entryRel, home: bHome, workDir: sharedCwd, providerUrl: `http://127.0.0.1:${provider.port}` });
  const cHome = path.join(mk('ns-bc-hc-'), 'dsh');
  const c = await runOne({ label: 'C(裁剪发行物)', rootDir: cDir, entryRel, home: cHome, workDir: sharedCwd, providerUrl: `http://127.0.0.1:${provider.port}` });
  const [bReq, cReq] = provider.requests;
  await provider.close();

  add('BC1', 'B 与 C 都真的启动并跑到终态',
    b.terminal === 'done' && c.terminal === 'done' && b.exitCode === 0 && c.exitCode === 0,
    `B: ${b.terminal}/exit=${b.exitCode} pid=${b.pid}；C: ${c.terminal}/exit=${c.exitCode} pid=${c.pid}`);

  const bTools = ((bReq || {}).tools || []).map((t) => t.name);
  const cTools = ((cReq || {}).tools || []).map((t) => t.name);
  add('BC2', '模型实际收到的工具清单逐项一致（顺序也一致）',
    bTools.length > 0 && JSON.stringify(bTools) === JSON.stringify(cTools),
    `B=${bTools.length} 个 / C=${cTools.length} 个${JSON.stringify(bTools) === JSON.stringify(cTools) ? '' : `；B=[${bTools.join(',')}] C=[${cTools.join(',')}]`}`);

  // 归一化要覆盖**两边的全部临时根**：工作目录、DSH_HOME、以及它们的父目录。
  // 只归一化 bDir/cDir 会剩下 "C:\Users\...\ns-bc-hb-xxxx" 这类只差随机名的路径，
  // 于是 BC3 会假红（第一版就是这样）。
  const roots = [bDir, cDir, bHome, cHome, sharedCwd, path.dirname(bHome), path.dirname(cHome), path.dirname(sharedCwd)];
  const bNorm = normalizeRequest(bReq || {}, { roots });
  const cNorm = normalizeRequest(cReq || {}, { roots });
  const bHash = createHash('sha256').update(JSON.stringify(bNorm)).digest('hex');
  const cHash = createHash('sha256').update(JSON.stringify(cNorm)).digest('hex');
  const diffs = bHash === cHash ? [] : diffPaths(bNorm, cNorm);
  add('BC3', '发往模型的消息序列归一化后一致', bHash === cHash,
    bHash === cHash ? `共同摘要 ${bHash.slice(0, 16)}…` : `B=${bHash.slice(0, 12)} C=${cHash.slice(0, 12)}；差异：${diffs.join(' | ') || '(仅摘要不同)'}`);

  const bRoles = ((bReq || {}).messages || []).map((m) => m.role).join(',');
  const cRoles = ((cReq || {}).messages || []).map((m) => m.role).join(',');
  add('BC4', '消息角色序列一致', bRoles === cRoles && bRoles.length > 0, `B=[${bRoles}] C=[${cRoles}]`);

  const bFinal = new Set(b.events.filter((t) => t === 'turn/end' || t === 'assistant/message'));
  const cFinal = new Set(c.events.filter((t) => t === 'turn/end' || t === 'assistant/message'));
  add('BC5', '终态事件集合一致（turn/end + assistant/message）',
    [...bFinal].sort().join(',') === [...cFinal].sort().join(',') && bFinal.size > 0,
    `B=[${[...bFinal].sort().join(',')}] C=[${[...cFinal].sort().join(',')}]`);

  add('BC6', '两边都只收到本会话事件（无跨会话串扰）',
    b.foreign <= b.events.length && c.foreign <= c.events.length && b.foreign === 0 && c.foreign === 0,
    `B foreign=${b.foreign} C foreign=${c.foreign}`);

  if (distManifest) {
    const counts = distManifest.counts || {};
    add('BC7', 'C 来自裁剪档案且体积确实更小（不是把开发树当 C）',
      Number(counts.packages) > 0 && cDir !== bDir,
      `C: ${counts.packages} 包 / ${counts.files} 文件；B 源：${path.basename(bDir)}`);
  }

  for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不改结论 */ } }

  const failed = checks.filter((x) => !x.ok);
  return {
    version: 'compare-runtime-bc-v1',
    ok: failed.length === 0,
    // ⚠️ equal 只由**实测比较**产生；两份进程观测不一致时这里必然是 false
    equal: failed.length === 0,
    baseline: { dir: bDir, entry: entryRel, pid: b.pid, terminal: b.terminal, exitCode: b.exitCode, tools: bTools.length },
    candidate: { dir: cDir, entry: entryRel, pid: c.pid, terminal: c.terminal, exitCode: c.exitCode, tools: cTools.length },
    toolNames: cTools,
    message_sha256: { b: bHash, c: cHash },
    message_diffs: diffs,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
    generated_at: new Date().toISOString(),
  };
}

function isDirectRun() {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isDirectRun()) {
  console.log('R02 B/C 动态行为等价（两个独立进程 / 同一 prompt / 同一本机假 provider）');
  const r = await compareRuntimeBC({
    artifact: arg('--artifact'),
    baseline: arg('--baseline'),
    candidate: arg('--candidate'),
  });
  if (USE_JSON) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const c of r.checks || []) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    console.log('');
    if (r.baseline) {
      console.log(`  B：${r.baseline.pid} / ${r.baseline.terminal} / exit=${r.baseline.exitCode} / ${r.baseline.tools} 工具`);
      console.log(`  C：${r.candidate.pid} / ${r.candidate.terminal} / exit=${r.candidate.exitCode} / ${r.candidate.tools} 工具`);
      if (r.message_sha256) console.log(`  消息摘要：B=${r.message_sha256.b.slice(0, 16)}… C=${r.message_sha256.c.slice(0, 16)}…`);
    }
    console.log(r.ok ? `  合计：通过 ${r.passed} / 未通过 0（共 ${r.total} 项）—— equal 来自实测比较`
      : `  合计：通过 ${r.passed} / 未通过 ${r.failed}（共 ${r.total} 项）`);
  }
  process.exit(r.ok ? 0 : 1);
}
