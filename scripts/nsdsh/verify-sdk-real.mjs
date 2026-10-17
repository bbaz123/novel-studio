#!/usr/bin/env node
/**
 * scripts/nsdsh/verify-sdk-real.mjs —— R01：**真实 DSH 子进程**端到端验收。
 *
 * 它和 `runtime-smoke.mjs` 的区别就是 R01 存在的理由：
 *   · `runtime-smoke.mjs` 只做静态/纯函数校验，**不 spawn**，工具清单来自代码扫描；
 *   · 本脚本**真的启动锁定的 DSH 构建产物**，用本机假模型端点跑一轮真实协议，
 *     抓取"模型实际收到了什么工具、什么消息"，并验证取消、隔离、退出与孤儿扫描。
 *
 * 零计费：假 provider 是本地 127.0.0.1 的 HTTP/SSE 服务，**不发任何真实请求**，
 * 不需要真实 API key（写入的是固定假 key，只用于让适配器通过它自己的校验）。
 *
 * 所有子进程都在**临时 DSH_HOME** 下运行，绝不读写作者的 `~/.dsh` 与真实作品库。
 *
 * 用法：
 *   node scripts/nsdsh/verify-sdk-real.mjs           # 人读输出
 *   node scripts/nsdsh/verify-sdk-real.mjs --json     # 机器可读
 * 退出码：0 = 全部场景 PASS；1 = 有 FAIL（绝不因为"大部分过了"而放行）。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildChildEnv, resolveDshLaunch, scanProcess,
} from '../../ai/runtime/sdk-process.mjs';
import { createSdkRuntimeAdapter, SDKTASK } from '../../ai/runtime/sdk-adapter.mjs';
import { createStdioTransport } from '../../ai/runtime/sdk-stdio-transport.mjs';
import { TOOL_CAPABILITIES } from '../../harness-plugins/novel-writing/capabilities.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(REPO, 'vendor/dsh/runtime-manifest.json');
const USE_JSON = process.argv.includes('--json');

/** 所有起飞过的 PID，收尾统一做孤儿扫描。 */
const PID_LOG = [];
const TMP_DIRS = [];

const results = [];
function record(id, name, ok, detail, observations = null) {
  results.push({ id, name, ok, detail: String(detail || ''), ...(observations ? { observations } : {}) });
  if (!USE_JSON) console.log(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenario(id, name, fn) {
  try {
    const r = await fn();
    record(id, name, r.ok === true, r.detail, r.observations);
  } catch (e) {
    // 场景抛异常 = 失败，不掩盖（也不把异常文本当成"已处理"）
    record(id, name, false, `EXCEPTION: ${String((e && e.message) || e)}`);
  }
}

function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}

function sha256File(p) {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

/** 假模型端点：Messages 兼容的 HTTP/SSE，行为可控。 */
async function startFakeProvider({ behavior = 'ok', text = 'fake-model-ok' } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = { unparsed: body.slice(0, 200) }; }
      requests.push(parsed);
      if (behavior === 'stall') return; // 永不响应：用于测取消
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseText(text, 'end_turn'));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    requests,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function sseText(text, stopReason) {
  const frames = [
    { type: 'message_start', message: { id: 'fake-msg', model: 'deepseek-v4-pro', usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return frames.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/**
 * 起真实子进程之前的**硬守卫**：环境里必须同时满足
 *   ① `DSH_HOME` 指向本次的临时目录（否则 DSH 会读写作者的 `~/.dsh`）
 *   ② `DEEPSEEK_BASE_URL` 指向 127.0.0.1（否则可能打到真实计费端点）
 * 任一条不满足就直接抛错让场景失败 —— **绝不"大概是本地"**。
 *
 * 这条守卫是踩坑之后加的：S9 曾经把 `{env,passed,withheld}` 整个对象当成 env 传下去，
 * 结果子进程拿不到 DSH_HOME 与 BASE_URL，用作者真实配置起了会话（详见 R01 文档的事故记录）。
 */
function assertSandboxedEnv(env, { home }) {
  const expectedHome = path.resolve(path.join(home, '.dsh'));
  const gotHome = env.DSH_HOME ? path.resolve(env.DSH_HOME) : '';
  if (gotHome !== expectedHome) {
    throw new Error(`ENV_GUARD_DSH_HOME：期望 ${expectedHome}，实际 ${gotHome || '(缺失)'}`);
  }
  const base = String(env.DEEPSEEK_BASE_URL || '');
  if (!/^http:\/\/127\.0\.0\.1:\d+/.test(base)) {
    throw new Error(`ENV_GUARD_BASE_URL：必须是本机假 provider，实际 ${base || '(缺失)'}`);
  }
  return true;
}

/** 启动一个真实子进程并跟踪 PID。 */
function launchEnv({ home, fakeProviderUrl, extra = {} }) {
  return buildChildEnv({
    allow: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED', 'DSH_SYSTEM_PROMPT'],
    extra: {
      DEEPSEEK_API_KEY: 'fake-key-not-billed',
      DEEPSEEK_BASE_URL: fakeProviderUrl,
      DSH_HOME: path.join(home, '.dsh'),
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      ...extra,
    },
  });
}

/** 组合出真正要交给 `runTask()` 的 env（并在同一处过守卫）。 */
function sandboxedRunEnv({ home, fakeProviderUrl, extra = {} }) {
  const built = launchEnv({ home, fakeProviderUrl, extra });
  assertSandboxedEnv(built.env, { home });
  return built;
}

function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

export async function verifySdkReal() {
  results.length = 0;
  const launch = resolveDshLaunch({ manifestPath: MANIFEST, repoRoot: REPO, profile: 'sdk' });

  // ── S1 入口解析：只从 manifest 来 ───────────────────────────────────────────
  await scenario('S1', '入口由 manifest 解析且不发明命令（真实构建产物）', async () => {
    if (!launch.ok) return { ok: false, detail: `解析失败 ${launch.reason}: ${launch.detail}` };
    const okEntry = fs.existsSync(launch.entryPath) && launch.entryPath.endsWith(path.join('apps', 'cli', 'lib', 'bin.js'));
    const sameVersion = launch.pkgVersion === launch.expectVersion;
    const noInventedCmd = !launch.args.some((a) => /--stdio/.test(a))
      && launch.args.includes('--profile') && launch.args.includes('sdk')
      && !String(launch.args[0]).includes('dsh-sdk');
    return {
      ok: okEntry && sameVersion && noInventedCmd,
      detail: `entry=${path.basename(launch.entryPath)} pkg=${launch.pkgVersion} args=[${launch.args.slice(1).join(' ')}]`,
      observations: { entryExists: okEntry, sameVersion, noInventedCmd, vendorCommit: launch.vendorCommit },
    };
  });

  // ── S2 manifest 错配必须拒绝（不降级）──────────────────────────────────────
  await scenario('S2', '入口缺失时 fail-closed 拒绝启动（不降级到源码/全局包）', async () => {
    const bad = path.join(tmpDir('ns-sdk-bad-'), 'runtime-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    manifest.entry = { ...manifest.entry, path: 'apps/cli/lib/does-not-exist.js' };
    fs.writeFileSync(bad, JSON.stringify(manifest));
    const badLaunch = resolveDshLaunch({ manifestPath: bad, repoRoot: REPO });
    const refused = badLaunch.ok === false && /ENTRY_MISSING/.test(String(badLaunch.reason));
    return {
      ok: refused,
      detail: `reason=${badLaunch.reason}`,
      observations: { refused, commandMustBeNull: badLaunch.command === null },
    };
  });

  // ── S3 环境白名单：敏感键默认不外泄 ────────────────────────────────────────
  await scenario('S3', '子进程环境显式枚举：敏感键不在白名单就不传', async () => {
    const fakeEnv = {
      PATH: '/usr/bin', SystemRoot: 'C:\\Windows', HOME: '/home/x',
      MY_API_KEY: 'super-secret', SOME_TOKEN: 'tok', USER_PASSWORD: 'pw',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    };
    const withheldRun = buildChildEnv({ allow: ['DEEPSEEK_BASE_URL'], extra: {}, sourceEnv: fakeEnv });
    const leaked = ['MY_API_KEY', 'SOME_TOKEN', 'USER_PASSWORD'].filter((k) => withheldRun.env[k] !== undefined);
    const allowedClean = withheldRun.env.DEEPSEEK_BASE_URL === 'http://127.0.0.1:1';
    // 显式 allow 时才允许传（且只传那一个）
    const allowedRun = buildChildEnv({ allow: ['MY_API_KEY'], extra: {}, sourceEnv: fakeEnv });
    const explicitWorks = allowedRun.env.MY_API_KEY === 'super-secret'
      && allowedRun.env.SOME_TOKEN === undefined;
    // 整体展开的旧写法会把它们全带出去 —— 这里直接反证
    const naive = Object.keys({ ...fakeEnv }).filter((k) => /API_KEY|TOKEN|PASSWORD/.test(k));
    return {
      ok: leaked.length === 0 && allowedClean && explicitWorks && naive.length === 3,
      detail: `泄漏=${leaked.length === 0 ? '无' : leaked.join(',')} 显式allow生效=${explicitWorks}`,
      observations: { withheld: withheldRun.withheld, passedCount: withheldRun.passed.length },
    };
  });

  // ── S4 真实启动 + 真协议 + 真终态 ──────────────────────────────────────────
  const provider = await startFakeProvider({ text: 'R01-real-subprocess-ok' });
  const homeA = tmpDir('ns-sdk-a-');
  const settingsBefore = sha256File(path.join(os.homedir(), '.dsh', 'settings.yaml'));
  const adapter = createSdkRuntimeAdapter({ launch, turnTimeoutMs: 90_000 });
  const runA = await (async () => {
    const envBuilt = sandboxedRunEnv({ home: homeA, fakeProviderUrl: provider.baseUrl });
    const r = await adapter.runTask({
      taskId: 'real-A', sessionId: 'ns:7:3:real-a', prompt: 'R01 真实子进程探针',
      provider: 'deepseek-official', model: 'deepseek-v4-pro', cwd: homeA,
      envAllow: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED'],
      envExtra: envBuilt.env, turnTimeoutMs: 90_000,
    });
    PID_LOG.push({ pid: r.pid, taskId: 'real-A' });
    return r;
  })();

  await scenario('S4', '真实子进程：真实 PID / initialize 真响应 / turn/end 终态 / 受控退出', async () => {
    const realPid = Number(runA.pid) > 0;
    const handshake = runA.serverInfo && runA.serverInfo.name === 'deepseek-harness-sdk-runtime';
    const accepted = typeof runA.messageId === 'string' && runA.messageId.length > 0;
    const terminal = runA.terminal === 'done' && runA.eventTypes.includes('turn/end');
    const exit = runA.exitCode === 0 && runA.exitedCleanly === true;
    const text = runA.text === 'R01-real-subprocess-ok';
    return {
      ok: realPid && handshake && accepted && terminal && exit && text,
      detail: `pid=${runA.pid} serverInfo=${runA.serverInfo && runA.serverInfo.name}@${runA.serverInfo && runA.serverInfo.version} terminal=${runA.terminal} exit=${runA.exitCode} shutdown=${runA.shutdownRequested} events=${runA.eventTypes.length}`,
      observations: { realPid, handshake, accepted, terminal, exit, text, usage: runA.usage },
    };
  });

  // ── S5 假模型端点实际收到了什么 ────────────────────────────────────────────
  await scenario('S5', '假 provider 捕获：工具数组 / 消息序列 / 终态文本', async () => {
    const req = provider.requests[0];
    if (!req) return { ok: false, detail: '假 provider 一次请求都没收到（说明协议/端点没接通）' };
    const tools = Array.isArray(req.tools) ? req.tools.map((t) => t.name) : null;
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const hasPrompt = JSON.stringify(messages).includes('R01 真实子进程探针');
    return {
      ok: Array.isArray(tools) && tools.length > 0 && hasPrompt,
      detail: `tools=${tools ? tools.length : 'null'} messages=${messages.length} promptSeen=${hasPrompt}`,
      observations: { toolCount: tools ? tools.length : 0, requestCount: provider.requests.length },
    };
  });

  // ── S6 工具面由 profile 真实决定（不是代码扫描）────────────────────────────
  let minimalTools = null;
  await scenario('S6', '受限 profile 的真实工具面：sdk-minimal 只给 shell，且无 author_confirm 工具', async () => {
    const minimalLaunch = resolveDshLaunch({ manifestPath: MANIFEST, repoRoot: REPO, profile: 'sdk-minimal' });
    if (!minimalLaunch.ok) return { ok: false, detail: `sdk-minimal 解析失败：${minimalLaunch.reason}` };
    const mp = await startFakeProvider({ text: 'minimal-ok' });
    const homeM = tmpDir('ns-sdk-min-');
    const built = sandboxedRunEnv({ home: homeM, fakeProviderUrl: mp.baseUrl, extra: { DSH_SYSTEM_PROMPT: 'Minimal allowlist prompt.' } });
    const ad = createSdkRuntimeAdapter({ launch: minimalLaunch, turnTimeoutMs: 90_000 });
    try {
      const r = await ad.runTask({
        taskId: 'minimal-1', sessionId: 'ns:1:1:min', prompt: 'list tools',
        provider: 'deepseek-official', model: 'deepseek-v4-pro', cwd: homeM,
        envAllow: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_SYSTEM_PROMPT'],
        envExtra: built.env, turnTimeoutMs: 90_000,
      });
      PID_LOG.push({ pid: r.pid, taskId: 'minimal-1' });
      const tools = ((mp.requests[0] || {}).tools || []).map((t) => t.name);
      minimalTools = tools;
      const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
      const exactlyShell = tools.length === 1 && tools[0] === shell;
      const authorConfirm = Object.entries(TOOL_CAPABILITIES).filter(([, v]) => v === 'author_confirm').map(([k]) => k);
      const noAuthorConfirm = !tools.some((t) => authorConfirm.includes(t));
      return {
        ok: r.terminal === 'done' && exactlyShell && noAuthorConfirm,
        detail: `sdk-minimal tools=[${tools.join(',')}] 期望=[${shell}] terminal=${r.terminal} exit=${r.exitCode} 请求数=${mp.requests.length}${r.error ? ` err=${String(r.error).slice(0, 60)}` : ''} authorConfirm工具=${authorConfirm.length} 泄漏=${!noAuthorConfirm}`,
        observations: { tools, authorConfirmNames: authorConfirm, terminal: r.terminal, requestCount: mp.requests.length },
      };
    } finally {
      await mp.close();
    }
  });

  // ── S7 不得发明 session/cancel ─────────────────────────────────────────────
  await scenario('S7', '上游没有 session/cancel：发送它必须被对端拒绝（不是静默成功）', async () => {
    const mp = await startFakeProvider({ text: 'x' });
    const homeC = tmpDir('ns-sdk-cancel-method-');
    const built = sandboxedRunEnv({ home: homeC, fakeProviderUrl: mp.baseUrl });
    const { spawnReal } = await import('../../ai/runtime/sdk-process.mjs');
    const child = spawnReal({ command: launch.command, args: launch.args, cwd: homeC, env: built.env });
    PID_LOG.push({ pid: child.pid, taskId: 'S7' });
    const tr = createStdioTransport({ input: child.stdoutStream, output: child.stdinStream });
    try {
      await tr.request('initialize', { cwd: homeC, provider: 'deepseek-official', model: 'deepseek-v4-pro' }, { timeoutMs: 25_000 });
      let rejected = false;
      let errText = '';
      try {
        await tr.request('session/cancel', { sessionId: 'anything' }, { timeoutMs: 10_000 });
      } catch (e) {
        rejected = true;
        errText = `${e.name}:${e.code}:${String(e.message).slice(0, 80)}`;
      }
      return {
        ok: rejected,
        detail: rejected ? `被拒绝：${errText}` : '对端竟然接受了 session/cancel（说明我们记错了协议面）',
        observations: { rejected },
      };
    } finally {
      tr.close('S7_DONE');
      child.kill('SIGTERM');
      await child.waitExit(8000);
      await mp.close();
    }
  });

  // ── S8 取消：真进程必须真的退出，且不再占槽 ───────────────────────────────
  await scenario('S8', '取消 = 终止独占进程并确认退出（不残留、不占槽）', async () => {
    const mp = await startFakeProvider({ behavior: 'stall' });
    const homeK = tmpDir('ns-sdk-cancel-');
    const built = sandboxedRunEnv({ home: homeK, fakeProviderUrl: mp.baseUrl });
    const ad = createSdkRuntimeAdapter({ launch, turnTimeoutMs: 60_000 });
    try {
      const running = ad.runTask({
        taskId: 'cancel-1', sessionId: 'ns:2:2:cancel', prompt: '会挂住的任务',
        provider: 'deepseek-official', model: 'deepseek-v4-pro', cwd: homeK,
        envAllow: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED'],
        envExtra: built.env, turnTimeoutMs: 60_000,
      });
      // 等它真的起来并进到 running（最多 20s）
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const t = ad.get('cancel-1');
        if (t && (t.state === SDKTASK.RUNNING || t.state === SDKTASK.HANDSHAKING)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const pidBefore = (ad.get('cancel-1') || {}).handle ? ad.get('cancel-1').handle.pid : 0;
      PID_LOG.push({ pid: pidBefore, taskId: 'cancel-1' });
      const cancelled = await ad.cancelTask({ taskId: 'cancel-1', reason: 'verify-script' });
      const result = await running;
      const alive = pidBefore ? scanProcess(pidBefore).alive : null;
      const noNewTask = ad.canStartNewTask();
      return {
        ok: cancelled.type === 'cancelled' && result.terminal === 'cancelled' && alive === false && noNewTask.ok === true,
        detail: `cancel=${cancelled.type} result=${result.terminal} pid=${pidBefore} 仍存活=${alive} 可新建=${noNewTask.ok}`,
        observations: { cancelled: cancelled.type, terminal: result.terminal, alive, canStartNew: noNewTask.ok },
      };
    } finally {
      await mp.close();
    }
  });

  // ── S9 双会话隔离：同一进程两个 session 的事件绝不交叉 ─────────────────────
  await scenario('S9', '多作品隔离：同一子进程内 A/B 两 session 事件不交叉（默认无池化）', async () => {
    const mp = await startFakeProvider({ text: 'iso-ok' });
    const homeI = tmpDir('ns-sdk-iso-');
    const built = sandboxedRunEnv({ home: homeI, fakeProviderUrl: mp.baseUrl });
    const { spawnReal } = await import('../../ai/runtime/sdk-process.mjs');
    const child = spawnReal({ command: launch.command, args: launch.args, cwd: homeI, env: built.env });
    PID_LOG.push({ pid: child.pid, taskId: 'S9' });
    const tr = createStdioTransport({ input: child.stdoutStream, output: child.stdinStream });
    const seen = [];
    tr.onNotification((m, p) => {
      if (m === 'session.event') seen.push(`${String(p.sessionId)}/${String((p.event || {}).type)}`);
    });
    try {
      await tr.request('initialize', { cwd: homeI, provider: 'deepseek-official', model: 'deepseek-v4-pro' }, { timeoutMs: 25_000 });
      await tr.request('session/prompt', { sessionId: 'work-A', contentBlocks: [{ type: 'text', text: 'A 的提示' }] }, { timeoutMs: 15_000 });
      await tr.request('session/prompt', { sessionId: 'work-B', contentBlocks: [{ type: 'text', text: 'B 的提示' }] }, { timeoutMs: 15_000 });
      const deadline = Date.now() + 45_000;
      const ends = () => seen.filter((s) => s.endsWith('/turn/end')).length;
      while (Date.now() < deadline && ends() < 2) await new Promise((r) => setTimeout(r, 50));
      const a = seen.filter((s) => s.startsWith('work-A/')).length;
      const b = seen.filter((s) => s.startsWith('work-B/')).length;
      const other = seen.length - a - b;
      const aEnd = seen.filter((s) => s === 'work-A/turn/end').length;
      const bEnd = seen.filter((s) => s === 'work-B/turn/end').length;
      return {
        ok: a > 0 && b > 0 && other === 0 && aEnd === 1 && bEnd === 1,
        detail: `work-A=${a} work-B=${b} 其它session=${other} turn/end A=${aEnd} B=${bEnd}`,
        observations: { a, b, other, aEnd, bEnd },
      };
    } finally {
      tr.close('S9_DONE');
      child.kill('SIGTERM');
      await child.waitExit(8000);
      await mp.close();
    }
  });

  // ── S10 作者全局设置不得被碰 ──────────────────────────────────────────────
  await scenario('S10', '不触碰作者真实 DSH 配置：~/.dsh/settings.yaml 前后哈希一致', async () => {
    const settingsAfter = sha256File(path.join(os.homedir(), '.dsh', 'settings.yaml'));
    const userSettings = path.join(os.homedir(), '.dsh', 'settings.yaml');
    const exists = fs.existsSync(userSettings);
    const same = settingsBefore === settingsAfter;
    const tempHomeUsed = fs.existsSync(path.join(homeA, '.dsh'));
    return {
      ok: same && tempHomeUsed,
      detail: exists
        ? `作者 settings.yaml sha256 前后一致=${same}`
        : '作者本机没有 ~/.dsh/settings.yaml（无文件即无变化，另以临时 DSH_HOME 已创建为准）',
      observations: { settingsExisted: exists, sameHash: same, tempHomeUsed },
    };
  });

  // ── S11 孤儿扫描 ──────────────────────────────────────────────────────────
  await scenario('S11', '孤儿进程扫描：本次起飞的所有 PID 都已消失', async () => {
    const rows = PID_LOG.map((p) => ({ ...p, ...scanProcess(p.pid) }));
    const alive = rows.filter((r) => r.alive === true);
    return {
      ok: alive.length === 0,
      detail: `${rows.length} 个 PID 全部已退出=${alive.length === 0}${alive.length ? `（仍存活：${alive.map((r) => r.pid).join(',')}）` : ''}`,
      observations: { pids: rows.map((r) => ({ pid: r.pid, alive: r.alive })) },
    };
  });

  // ── S12 传输分帧（纯函数，不需要子进程）──────────────────────────────────
  await scenario('S12', '传输分帧：分块到达 / CRLF / 非 JSON 噪音 / 超大帧', async () => {
    const out = [];
    const input = new (await import('node:stream')).PassThrough();
    const output = new (await import('node:stream')).PassThrough();
    output.resume();
    const tr = createStdioTransport({ input, output, maxFrameBytes: 256 });
    const p = tr.request('initialize', { a: 1 }, { timeoutMs: 5000 });
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id: 'req_1', result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } })}\r\n`;
    // ① 一上来先塞一行非 JSON 噪音：必须被忽略，而不是把连接弄死
    input.write('not-json-noise\n');
    // ② 再把**一帧完整响应**拆成三段：验证"一次 data ≠ 一条完整帧"
    input.write(frame.slice(0, 10));
    input.write(frame.slice(10, 30));
    input.write(frame.slice(30));
    const r = await p;
    out.push(r && r.serverInfo && r.serverInfo.name === 'deepseek-harness-sdk-runtime');
    // 超大帧：超过 256 字节且没有换行 → 传输判死并拒绝挂起请求
    const big = tr.request('shutdown', undefined, { timeoutMs: 5000 }).then(() => 'resolved').catch((e) => e.name);
    input.write('x'.repeat(400));
    const bigOutcome = await big;
    const ok = out[0] === true && bigOutcome === 'SdkFrameTooLarge';
    tr.close('S12_DONE');
    return {
      ok,
      detail: `拆分帧正确关联=${out[0]} 超大帧拒绝=${bigOutcome}`,
      observations: { splitFrame: out[0], oversized: bigOutcome, stats: tr.stats() },
    };
  });

  await provider.close();
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录清理失败不改变结论 */ } }

  const failed = results.filter((r) => r.ok !== true);
  return {
    version: 'verify-sdk-real-v1',
    ok: failed.length === 0,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    launch: {
      ok: launch.ok, entry: launch.entryPath, profile: launch.profile,
      pkgVersion: launch.pkgVersion, expectVersion: launch.expectVersion,
      vendorCommit: launch.vendorCommit, upstreamTag: launch.upstreamTag,
      platform: launch.platform, nodeVersion: launch.nodeVersion,
    },
    minimalProfileTools: minimalTools,
    results,
    generated_at: new Date().toISOString(),
  };
}

if (isDirectRun()) {
  console.log('R01 真实 DSH 子进程验收（零计费 / 临时 DSH_HOME / 本机假 provider）');
  const r = await verifySdkReal();
  if (USE_JSON) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('');
    console.log(`  入口：${r.launch.entry}`);
    console.log(`  基线：${r.launch.upstreamTag} / ${r.launch.vendorCommit} / 包版本 ${r.launch.pkgVersion}`);
    console.log(`  平台：${r.launch.platform} / node ${r.launch.nodeVersion}`);
    console.log(`  sdk-minimal 真实工具面：${JSON.stringify(r.minimalProfileTools)}`);
    console.log('');
    console.log(r.ok
      ? `  合计：通过 ${r.passed} / 未通过 0（共 ${r.total} 个场景）`
      : `  合计：通过 ${r.passed} / 未通过 ${r.failed}（共 ${r.total} 个场景）`);
    for (const f of r.results.filter((x) => x.ok !== true)) console.log(`  ✗ ${f.id} ${f.name} — ${f.detail}`);
  }
  process.exit(r.ok ? 0 : 1);
}

export { pathToFileURL };
