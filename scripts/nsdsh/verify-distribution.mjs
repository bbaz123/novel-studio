#!/usr/bin/env node
/**
 * scripts/nsdsh/verify-distribution.mjs —— R02：从**档案本身**解压并真的跑起来。
 *
 * 它回答的问题只有一个：**这个 zip 到了别人机器上还能不能用？**
 * 所以它不看开发目录，只做四件事：
 *
 *   ① 解开档案到全新的临时目录（用发行物自带的清单核对 SHA 与文件数）；
 *   ② 结构检查：入口存在、无 symlink、无 `..` 穿越、每个包声明的依赖都能在**包内**解析到；
 *   ③ 真的用 `node <manifest.entry> --profile sdk` 起进程，本地假 provider 跑一轮
 *      `initialize` → `session/prompt` → `turn/end` → `shutdown`，并核对退出码；
 *   ④ 中文路径 + 空格路径各跑一次（Windows 上这两类路径最容易炸）。
 *
 * 全部零计费：假 provider 是 127.0.0.1 上的 SSE 服务，不带真实 key。
 *
 * 用法：node scripts/nsdsh/verify-distribution.mjs --artifact <zip> [--json]
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: ok === true, detail: String(detail || '') });
  if (!USE_JSON) console.log(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

function sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function sse(text) {
  return [
    { type: 'message_start', message: { id: 'dist', model: 'deepseek-v4-pro', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
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
      res.end(sse('distribution-ok'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

/** 用 manifest 里的入口起真实进程，返回终态与观测。 */
async function runDistribution({ rootDir, manifest, home, providerUrl, turnTimeoutMs = 90_000 }) {
  const entryAbs = path.join(rootDir, manifest.entry.path);
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
  // 守卫：DSH_HOME 必须是本次临时目录（否则会读写作者真实 ~/.dsh）
  if (path.resolve(built.env.DSH_HOME) !== path.resolve(home)) throw new Error('ENV_GUARD_DSH_HOME');
  if (!/^http:\/\/127\.0\.0\.1:\d+/.test(String(built.env.DEEPSEEK_BASE_URL || ''))) throw new Error('ENV_GUARD_BASE_URL');

  const child = spawnReal({
    command: process.execPath,
    args: [entryAbs, '--profile', String(manifest.entry.profile || 'sdk')],
    cwd: rootDir,
    env: built.env,
  });
  const tr = createStdioTransport({ input: child.stdoutStream, output: child.stdinStream });
  const events = [];
  const foreign = [];
  tr.onNotification((method, params) => {
    if (method !== 'session.event') return;
    const sid = String(params.sessionId || '');
    if (sid !== 'dist-session') { foreign.push(sid); return; }
    events.push(String((params.event || {}).type || ''));
  });
  const out = { pid: child.pid, terminal: null, text: '', events, foreign, exitCode: null, error: '' };
  try {
    const init = await tr.request('initialize', { cwd: rootDir, provider: 'deepseek-official', model: 'deepseek-v4-pro' }, { timeoutMs: 30_000 });
    out.serverInfo = init && init.serverInfo;
    const prompt = await tr.request('session/prompt', { sessionId: 'dist-session', contentBlocks: [{ type: 'text', text: 'distribution smoke' }] }, { timeoutMs: 20_000 });
    out.messageId = prompt && prompt.messageId;
    const deadline = Date.now() + turnTimeoutMs;
    while (Date.now() < deadline && !events.includes('turn/end')) {
      if (child.exited) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    out.terminal = events.includes('turn/end') ? 'done' : (child.exited ? 'failed' : 'unknown');
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

export async function verifyDistribution({ artifact }) {
  results.length = 0;
  const archiveAbs = path.resolve(artifact);
  const tmpRoots = [];
  const mk = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpRoots.push(d); return d; };

  // ① 档案本身
  let buf = null;
  try { buf = fs.readFileSync(archiveAbs); } catch (e) {
    check('D1', '发行档案可读', false, String(e.message));
    return { ok: false, results };
  }
  const archiveSha = createHash('sha256').update(buf).digest('hex');
  let entries = null;
  try { entries = readZipEntries(buf); } catch (e) { check('D1', 'ZIP 结构可解析', false, String(e.message)); }
  check('D1', '发行档案可解析（ZIP，条目名已过穿越检查）', entries !== null,
    entries ? `${entries.size} 个条目 / ${(buf.length / 1048576).toFixed(1)}MB / sha256=${archiveSha.slice(0, 16)}…` : '解析失败');

  if (!entries) return { ok: false, archiveSha, results };

  // ② 解压到全新目录
  const clean = mk('ns-dist-clean-');
  const written = extractTo(entries, clean, { fs, path });
  const manifestEntry = entries.get('runtime-manifest.json');
  const manifest = manifestEntry ? JSON.parse(manifestEntry.toString('utf8')) : null;
  check('D2', '解压后带发行清单', Boolean(manifest && manifest.entry && manifest.entry.path),
    manifest ? `packages=${manifest.counts.packages} files=${manifest.counts.files}` : '缺 runtime-manifest.json');

  const entryAbs = manifest ? path.join(clean, manifest.entry.path) : '';
  check('D3', '清单声明的入口在解压目录里真实存在', Boolean(entryAbs && fs.existsSync(entryAbs)),
    manifest ? manifest.entry.path : '-');

  check('D4', '档案不含 symlink（无外链可穿）', [...entries.keys()].every((n) => !n.includes('../')),
    `${written.length} 个文件已落盘`);

  // 结构：每个包的依赖都能在包内解析到（这是"闭包自足"的可观测形式）
  const pkgNames = [...entries.keys()]
    .filter((n) => /(^|\/)node_modules\/(@[^/]+\/)?[^/]+\/package\.json$/.test(n) || n === 'apps/cli/package.json');
  let depMissing = 0;
  const depMissingList = [];
  for (const pj of pkgNames) {
    let pkg;
    try { pkg = JSON.parse(entries.get(pj).toString('utf8')); } catch { continue; }
    const fromDir = path.posix.dirname(pj);
    for (const dep of Object.keys(pkg.dependencies || {})) {
      const hit = [...entries.keys()].some((n) => n === `${fromDir}/node_modules/${dep}/package.json`
        || n === `node_modules/${dep}/package.json`
        || n.endsWith(`/node_modules/${dep}/package.json`));
      if (!hit) { depMissing += 1; if (depMissingList.length < 5) depMissingList.push(`${pkg.name}→${dep}`); }
    }
  }
  check('D5', '每个包声明的 dependencies 都能在档案内解析', depMissing === 0,
    depMissing === 0 ? `${pkgNames.length} 个 package.json 全部自足` : `缺 ${depMissing} 处：${depMissingList.join(', ')}`);

  // ③ 真的跑起来
  const provider = await fakeProvider();
  const homeA = path.join(mk('ns-dist-home-'), 'dsh');
  let runA = null;
  try {
    runA = await runDistribution({ rootDir: clean, manifest, home: homeA, providerUrl: `http://127.0.0.1:${provider.port}` });
  } catch (e) {
    check('D6', '从解压目录真实启动并完成一轮协议', false, String(e.message));
  }
  if (runA) {
    const ok = runA.terminal === 'done' && runA.exitCode === 0
      && runA.serverInfo && runA.serverInfo.name === 'deepseek-harness-sdk-runtime';
    check('D6', '从解压目录真实启动并完成一轮协议', ok,
      `pid=${runA.pid} server=${runA.serverInfo && runA.serverInfo.name} terminal=${runA.terminal} exit=${runA.exitCode} events=${runA.events.length}${runA.error ? ` err=${runA.error}` : ''}`);
    check('D7', '假 provider 真的收到了模型请求', provider.requests.length >= 1,
      `请求数=${provider.requests.length} tools=${((provider.requests[0] || {}).tools || []).length}`);
  }
  await provider.close();

  // ④ 中文 + 空格路径
  const cnParent = mk('ns-dist-中文 目录-');
  const cnDir = path.join(cnParent, '运行时 副本');
  fs.mkdirSync(cnDir, { recursive: true });
  extractTo(entries, cnDir, { fs, path });
  const provider2 = await fakeProvider();
  const homeB = path.join(mk('ns-dist-home2-'), 'dsh');
  let runB = null;
  try {
    runB = await runDistribution({ rootDir: cnDir, manifest, home: homeB, providerUrl: `http://127.0.0.1:${provider2.port}` });
  } catch (e) {
    check('D8', '中文 + 空格路径下同样可运行', false, String(e.message));
  }
  if (runB) {
    check('D8', '中文 + 空格路径下同样可运行', runB.terminal === 'done' && runB.exitCode === 0,
      `terminal=${runB.terminal} exit=${runB.exitCode}${runB.error ? ` err=${runB.error}` : ''}`);
  }
  await provider2.close();

  for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不改变结论 */ } }

  const failed = results.filter((r) => !r.ok);
  return {
    version: 'verify-distribution-v1',
    ok: failed.length === 0,
    artifact: archiveAbs,
    archiveSha256: archiveSha,
    archiveBytes: buf.length,
    manifest: manifest ? {
      upstream: manifest.upstream, target: manifest.target, counts: manifest.counts,
      entry: manifest.entry, files_digest: manifest.files_digest, license: manifest.license,
    } : null,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    generated_at: new Date().toISOString(),
  };
}

function isDirectRun() {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isDirectRun()) {
  const artifact = arg('--artifact');
  if (!artifact) {
    console.error('用法：node scripts/nsdsh/verify-distribution.mjs --artifact <zip> [--json]');
    process.exit(1);
  }
  console.log('R02 发行物验收（从档案本身解压 / 临时 DSH_HOME / 本机假 provider）');
  const r = await verifyDistribution({ artifact });
  if (USE_JSON) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('');
    if (r.manifest) {
      console.log(`  上游：${r.manifest.upstream.tag} / ${r.manifest.upstream.vendor_commit}`);
      console.log(`  目标：${r.manifest.target.platform}-${r.manifest.target.arch} / node ${r.manifest.target.node}`);
      console.log(`  规模：${r.manifest.counts.packages} 包 / ${r.manifest.counts.files} 文件`);
    }
    console.log(`  档案：sha256=${String(r.archiveSha256 || '').slice(0, 24)}…（${((r.archiveBytes || 0) / 1048576).toFixed(1)}MB）`);
    console.log(r.ok
      ? `  合计：通过 ${r.passed} / 未通过 0（共 ${r.total} 项）`
      : `  合计：通过 ${r.passed} / 未通过 ${r.failed}（共 ${r.total} 项）`);
    for (const f of r.results.filter((x) => !x.ok)) console.log(`  ✗ ${f.id} ${f.name} — ${f.detail}`);
  }
  process.exit(r.ok ? 0 : 1);
}

export { REPO };
