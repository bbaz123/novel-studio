#!/usr/bin/env node
/**
 * ci-isolated-run.mjs —— 「起一个**隔离实例**、在里面跑命令、跑完关掉」的可移植封装。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 项目里有两条检查**必须对着一个活实例**跑（`api-test-suite.mjs` 硬编码 3738、
 * novel-writing 插件的冒烟测试），而它们都必须跑在**隔离实例**上——2026-09-15 那次事故的
 * 教训就是「测试打到了不受控的实例」。手工分步搭建（起实例 → 设变量 → 跑测试）在 CI 里
 * 尤其容易写成某个平台专属的 shell 语法。这里把三件事合成一条命令，Windows / macOS / Linux
 * 用同一套 Node 代码。
 *
 * 隔离配方（每条都对应一类污染）：
 *   NOVELSTUDIO_DATA_DIR=<临时目录>     数据库隔离（绝不指向作者的真实库）
 *   PORT=<端口>                         实例隔离
 *   NOVELSTUDIO_OV_DISABLED=1           停用服务端 OpenViking 集成（不写记忆库目录）
 *   NOVELSTUDIO_OPENVIKING_PEER_ID=ci   把 dsh 的记忆写入限到测试 peer
 *
 * 用法:
 *   node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs
 *   node scripts/ci-isolated-run.mjs --port 3738 --keep -- node api-test-suite.mjs   # 排障：跑完不关实例
 *   node scripts/ci-isolated-run.mjs --port 3738 --data .ci-data -- bash -c 'echo hi'
 *
 * 退出码 = 被跑命令的退出码（实例起不来则 2）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const sep = process.argv.indexOf('--');
if (sep < 0 || sep === process.argv.length - 1) {
  console.error('用法: node scripts/ci-isolated-run.mjs [--port 3738] [--data <目录>] [--keep] [--egress-guard] -- <命令> [参数...]');
  console.error('  --egress-guard  给所有 Node 子进程加出口沙箱（默认拒绝非白名单出站，回环放行）');
  process.exit(2);
}
const PORT = Number(arg('--port', '3738')) || 3738;
const KEEP = process.argv.includes('--keep');
const DATA_DIR = path.resolve(arg('--data', path.join(os.tmpdir(), `novel-studio-ci-${PORT}-${process.pid}`)));
const CMD = process.argv.slice(sep + 1);

// 出口沙箱（宿主编排层的 sandbox 半边）：`--egress-guard` 或 NOVELSTUDIO_EGRESS_GUARD=1 时，
// 给所有 Node 子进程加 `--import` 预加载，在业务代码之前拒绝非白名单出站。
// 只影响 Node 进程；外部 curl 之类由插件半边（harness-plugins/novel-writing/egress-guard.mjs）在工具层拦。
const EGRESS_GUARD = process.argv.includes('--egress-guard') || process.env.NOVELSTUDIO_EGRESS_GUARD === '1';
if (EGRESS_GUARD) {
  const preload = path.join(HERE, '..', 'harness-plugins', 'novel-writing', 'sandbox', 'install.mjs');
  // Windows 下 `--import` 只认 URL，不认盘符路径（实测 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVELSTUDIO_DATA_DIR: DATA_DIR,
    NOVELSTUDIO_OV_DISABLED: '1',
    NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1',
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'ci-isolated-peer',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const stop = () => { try { child.kill(); } catch { /* 已退出 */ } };
process.on('exit', () => { if (!KEEP) stop(); });

async function waitReady(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/works`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const ready = await waitReady();
if (!ready) {
  console.error(`✗ 隔离实例未能在超时内启动（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
  console.error(serverLog.slice(-2000));
  stop();
  process.exit(2);
}
console.log(`✓ 隔离实例已就绪：http://127.0.0.1:${PORT}（数据目录 ${DATA_DIR}）`);

const code = await new Promise((resolve) => {
  const c = spawn(CMD[0], CMD.slice(1), {
    cwd: REPO,
    stdio: 'inherit',
    // ⚠️ 被跑的命令**必须**看到同一套隔离变量（实测缺陷，2026-09-24）：
    // api-test-suite.mjs 的封卷断言（I3ac/I3ad/I3ae）要读「本次会话的 JSONL」，
    // 而它按约定从 NOVELSTUDIO_DATA_DIR 拼路径——只把变量给服务端、不给命令，
    // 命令就会退回到 cwd 下的 .test-data-trace，读一个**空的**目录，
    // 于是三条断言全报 ENOENT（在隔离实例里恒红，与产品行为无关）。
    // 这里把实例的变量一并传给命令：测试与实例看的是同一份数据目录。
    env: {
      ...process.env,
      PORT: String(PORT),
      NOVELSTUDIO_DATA_DIR: DATA_DIR,
      SMOKE_TARGET_BASE: process.env.SMOKE_TARGET_BASE || `http://127.0.0.1:${PORT}`,
    },
    shell: process.platform === 'win32',
  });
  c.on('exit', (code2) => resolve(code2 ?? 1));
  c.on('error', (e) => { console.error(`✗ 命令启动失败：${e.message}`); resolve(1); });
});

if (KEEP) {
  console.log(`--keep：实例仍在运行（PID ${child.pid}，端口 ${PORT}）`);
} else {
  stop();
  console.log(`已关闭隔离实例（退出码 ${code}）`);
}
process.exit(code);
