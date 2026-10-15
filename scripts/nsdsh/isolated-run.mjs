#!/usr/bin/env node
/**
 * nsdsh/isolated-run.mjs —— 可复用的**隔离运行器**（S01）。
 *
 * 与既有的 `scripts/ci-isolated-run.mjs` 的分工（**不重造，只叠加**）：
 *   · ci-isolated-run.mjs 负责"起一个隔离实例 + 在里面跑一条命令"，端口/数据目录是它的参数；
 *   · 本文件把 S01 需要但那里没有的三件事补上：**假模型端点**（零计费）、
 *     **出网拒绝断言**（NSDSH_EGRESS_LOG 必须为空）、**假模型请求捕获**（证明模型真的收到了什么）。
 *   需要起实例时本文件**委派**给它，绝不自己再写第三份启动逻辑。
 *
 * 隔离配方（每条对应一类污染）：
 *   NOVELSTUDIO_DATA_DIR=<临时>   库隔离（绝不指向真实 data/）
 *   NOVELSTUDIO_DSH_HOME=<临时>   不写用户全局 ~/.dsh
 *   PORT=<38100–38200 的空闲端口> 实例隔离（**绝不默认 3737**：那可能是作者的活实例）
 *   NOVELSTUDIO_OV_DISABLED=1     不写记忆库
 *   NSDSH_EGRESS_LOG + network-guard  非回环出网即拒绝并留证
 *
 * 用法:
 *   node scripts/nsdsh/isolated-run.mjs [选项] -- <命令> [参数...]
 *   --data-dir <目录>     --dsh-home <目录>    --port <端口>
 *   --egress-log <文件>   --fake-model[=<回复JSON>]
 *   --network loopback-only|deny-all           --timeout <毫秒>
 *   --json                --keep
 *
 * 退出码：被跑命令的退出码；setup 失败 2；有出网违规 1（违规由本文件断言，不靠人看日志）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './lib/gate.mjs';
import { GUARD_CJS, pickFreePort, startFakeModel } from './lib/isolate.mjs';
import { REPO } from './lib/report.mjs';

const USAGE = 'node scripts/nsdsh/isolated-run.mjs [--data-dir d] [--dsh-home h] [--port p] [--egress-log f] '
  + '[--fake-model[=reply]] [--network loopback-only|deny-all] [--timeout ms] [--json] [--keep] -- <命令> [参数...]';

/** 极简参数解析：只认本文件声明的开关，遇到不认识的一律用法错误（不静默忽略）。 */
export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) return { usageError: '缺少 `--` 之后的被跑命令' };
  const head = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  const out = {
    dataDir: '', dshHome: '', port: null, egressLog: '', fakeModel: false, fakeReply: '{"ok":true}',
    network: 'loopback-only', timeoutMs: 20 * 60 * 1000, json: false, keep: false, command,
  };
  for (let i = 0; i < head.length; i += 1) {
    const a = head[i];
    const need = (name) => {
      const v = head[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${name} 缺少取值`);
      i += 1;
      return v;
    };
    if (a === '--data-dir') out.dataDir = need(a);
    else if (a === '--dsh-home') out.dshHome = need(a);
    else if (a === '--port') out.port = Number(need(a));
    else if (a === '--egress-log') out.egressLog = need(a);
    else if (a === '--timeout') out.timeoutMs = Number(need(a));
    else if (a.startsWith('--fake-model=')) { out.fakeModel = true; out.fakeReply = a.slice('--fake-model='.length); }
    else if (a === '--fake-model') out.fakeModel = true;
    else if (a === '--network') {
      const v = need(a);
      if (!['loopback-only', 'deny-all'].includes(v)) throw new Error(`--network 只支持 loopback-only|deny-all，收到 ${v}`);
      out.network = v;
    } else if (a === '--json') out.json = true;
    else if (a === '--keep') out.keep = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (!Number.isFinite(out.port) && out.port !== null) throw new Error('--port 必须是数字');
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) throw new Error('--timeout 必须是正数毫秒');
  return out;
}

/**
 * 假模型的**请求捕获落盘**。
 *
 * 为什么不把 `model.requests` 直接交给子进程：子进程拿不到父进程的内存。而"模型实际收到了什么"
 * 是 S02/S06/S10 要反复核对的证据，所以每次请求都**追加一行 JSONL**，路径通过环境变量给子进程。
 * 回调里刻意不抛异常：捕获失败不能让被测命令的结果失真。
 */
function attachRequestLog(model, logPath) {
  fs.writeFileSync(logPath, '', 'utf8');
  const orig = model.requests.push.bind(model.requests);
  let n = 0;
  model.requests.push = (...items) => {
    for (const it of items) {
      n += 1;
      try { fs.appendFileSync(logPath, `${JSON.stringify(it)}\n`, 'utf8'); } catch (_) { /* 见上 */ }
    }
    return orig(...items);
  };
  return () => n;
}

/** 读取捕获到的请求（子进程或本文件收尾时都用它，避免两套解析）。 */
export function readCapturedRequests(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } });
  } catch (_) { return []; }
}

/** 出网违规：guard 写进 NSDSH_EGRESS_LOG 的行。非空即违规（空是"没有观察到出网"的证据）。 */
export function readEgressViolations(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (_) { return []; }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}\n用法: ${USAGE}`);
    process.exit(2);
  }
  if (args.usageError) {
    console.error(`✗ ${args.usageError}\n用法: ${USAGE}`);
    process.exit(2);
  }

  const created = [];
  const mk = (p) => { fs.mkdirSync(p, { recursive: true }); created.push(p); return p; };
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const root = mk(path.join(os.tmpdir(), `nsdsh-iso-${stamp}`));
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : mk(path.join(root, 'data'));
  const dshHome = args.dshHome ? path.resolve(args.dshHome) : mk(path.join(root, 'dsh-home'));
  const egressLog = args.egressLog ? path.resolve(args.egressLog) : path.join(root, 'egress.jsonl');
  const requestLog = path.join(root, 'fake-model-requests.jsonl');
  if (args.dataDir) mk(dataDir);
  if (args.dshHome) mk(dshHome);
  if (args.egressLog) fs.mkdirSync(path.dirname(path.resolve(args.egressLog)), { recursive: true });
  fs.writeFileSync(egressLog, '', 'utf8');

  // 端口：显式给了就用；没给就从 38100–38200 里挑一个空闲的。
  // **绝不默认 3737**：那是作者活实例的端口，测试打上去就不再是隔离测试了。
  let port = args.port;
  if (port === null) {
    try { port = pickFreePort(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  }
  if (port === 3737) {
    console.error('✗ 拒绝使用 3737：那是作者活实例的默认端口，隔离测试不得指向它');
    process.exit(2);
  }

  const env = { ...process.env, NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_DSH_HOME: dshHome, PORT: String(port) };
  // 隔离姿态开关：清空所有业务环境变量后再注入。这样"没被显式声明的变量"不会从父进程漏进来
  // （例如某个会话里留着的 NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1 —— 那会让测试真的去起模型）。
  for (const k of Object.keys(env)) {
    if (k.startsWith('NOVELSTUDIO_') && !['NOVELSTUDIO_DATA_DIR', 'NOVELSTUDIO_DSH_HOME'].includes(k)) delete env[k];
  }
  env.NOVELSTUDIO_OV_DISABLED = '1';
  env.NOVELSTUDIO_ISOLATED = '1';
  env.NSDSH_ISOLATED_ROOT = root;
  env.NSDSH_EGRESS_LOG = egressLog;
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS || '', `--require=${GUARD_CJS}`].filter(Boolean).join(' ');
  delete env.NSDSH_OFFLINE;

  let model = null;
  let requestCount = () => readCapturedRequests(requestLog).length;
  if (args.fakeModel && args.network !== 'deny-all') {
    try {
      model = await startFakeModel({ reply: args.fakeReply });
      requestCount = attachRequestLog(model, requestLog);
      env.NOVELSTUDIO_FAKE_MODEL_BASE_URL = model.baseUrl;
      env.NSDSH_FAKE_MODEL_REQUESTS = requestLog;
      env.NOVELSTUDIO_MODEL_BASE_URL = model.baseUrl;
    } catch (e) {
      console.error(`✗ 假模型启动失败：${e.message}`);
      process.exit(2);
    }
  } else if (args.network === 'deny-all') {
    // deny-all 下不起假模型：连回环的模型端点都不该存在（guard 仍会拦住一切非回环目标）。
    env.NSDSH_FAKE_MODEL_REQUESTS = requestLog;
    fs.writeFileSync(requestLog, '', 'utf8');
  }

  const r = runCommand(args.command, { cwd: REPO, env, timeoutMs: args.timeoutMs });

  const egressViolations = readEgressViolations(egressLog);
  const requests = readCapturedRequests(requestLog);
  const cleanup = () => {
    if (!args.keep) {
      for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理失败不掩盖结果 */ } }
    }
  };
  if (model) { try { await model.stop(); } catch (_) { /* 已关闭 */ } }

  // 有出网违规时不允许悄悄以 0 退出：隔离测试的意义就在于"没有外网"，违规必须让调用方看见。
  const exitCode = egressViolations.length ? 1 : (r.status === null ? 2 : r.status);

  const summary = {
    exitCode,
    childExitCode: r.status,
    transport: r.transport,
    ms: r.ms,
    port,
    network: args.network,
    fakeModel: !!model,
    fakeModelBaseUrl: model ? model.baseUrl : null,
    fakeModelRequests: requests.length,
    requestLog,
    egressViolations,
    dataDir,
    dshHome,
    egressLog,
    tempRoot: root,
    // runCommand 是**同步**执行（spawnSync）：返回时子进程已经结束，因此这里没有"遗留子进程"
    // 需要登记。如实写出来，而不是留一个有字段没数据的假实现。
    leftoverChildPids: [],
    ...(r.error ? { error: r.error } : {}),
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, stdout: r.stdout || '', stderr: r.stderr || '' }, null, 2)}\n`);
  } else {
    console.log(`隔离运行：${args.command.join(' ')}`);
    console.log(`  端口 ${port}（绝不 3737）· 网络 ${args.network} · 数据目录 ${dataDir}`);
    console.log(`  transport=${r.transport} exit=${r.status} ${r.ms}ms`);
    if (model) console.log(`  假模型 ${model.baseUrl}：捕获请求 ${requests.length} 条（${requestLog}）`);
    console.log(`  出网违规 ${egressViolations.length} 条${egressViolations.length ? `：${egressViolations[0]}` : '（NSDSH_EGRESS_LOG 为空）'}`);
    if (r.stdout) console.log(`--- stdout ---\n${r.stdout}`);
    if (r.stderr) console.log(`--- stderr ---\n${r.stderr}`);
    console.log(egressViolations.length ? '✗ 存在非回环出网：隔离失败' : '✓ 无出网违规');
  }

  cleanup();
  process.exit(exitCode);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked && (invoked === self || invoked.endsWith(path.sep + path.basename(self)))) {
  await main();
}
