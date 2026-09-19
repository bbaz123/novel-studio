/**
 * harness-sdk-worker.mjs —— 把"启动一条常驻 dsh 进程并完成握手"这件事收成一个函数，
 * 供热备池当作 `spawnWorker(route)` 使用。
 *
 * 它是 `ai/harness-pool.mjs` 与真实世界之间**唯一**的一层：池只认 `{worker, dispose}`，
 * 协议只认 `{send, onData, onExit, kill}`，其余（怎么起进程、握手参数怎么来）都在这里。
 *
 * ⚠️ 与 `harness.js` 的关系：启动方式的解析（dsh 仓库 package.json 的 `scripts.dsh`）
 * 在 harness.js 里是**内部函数**，没有导出。这里保留同一套解析，并由
 * `.p1-baseline/probe-sdk-runtime.mjs` 用真实 dsh 端到端验证它 —— 而不是靠"读起来一样"。
 * 之所以不去导出 harness.js 的内部函数：那一 import 会连带拉起 logger/db 的模块级副作用
 * （见 docs 的隔离与验证教训 §一），为一个纯解析引入这层耦合不划算。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorker } from './harness-pool.mjs';

/** 与 harness.js 的 `resolveDshLaunch()` 同一套解析：`scripts.dsh` 形如 `node --import tsx/esm apps/cli/src/bin.ts`。 */
export function resolveDshLaunch(harnessDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(harnessDir, 'package.json'), 'utf8'));
    const script = String((pkg.scripts && pkg.scripts.dsh) || '').trim();
    const m = script.match(/^node\s+([\s\S]+)$/);
    if (!m) return null;
    const parts = m[1].trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const entry = parts[parts.length - 1];
    const resolved = entry.startsWith('.') || !entry.includes(':') ? path.join(harnessDir, entry) : entry;
    return { args: [...parts.slice(0, -1), resolved], cwd: harnessDir };
  } catch {
    return null;
  }
}

/** 强杀进程树（Windows 下 `taskkill /T`），与 harness.js 的 killChildTree 同语义。 */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已经退出 */ }
  try { child.kill(); } catch { /* 兜底 */ }
}

/**
 * 造一个 `spawnWorker(route)`：起一条常驻 dsh、完成 `initialize` 握手、返回池要的形状。
 *
 * @param {{
 *   harnessDir: string, profile: string, env: Record<string,string>,
 *   readyTimeoutMs?: number, log?: (level:string, kind:string, message:string, ctx?:object)=>void,
 * }} o
 */
export function createSpawnWorker({ harnessDir, profile, env, readyTimeoutMs = 120000, log = () => {}, launch: launchOverride = null }) {
  return async function spawnWorker(route) {
    // `launch` 可注入：源码仓库那份 dsh 用 `scripts.dsh` 启动；**包式安装**（npm 全局）没有
    // `scripts.dsh`，只能 `node <pkg>/lib/bin.js`。把启动方式做成可注入，才能在两者之间做对照实验
    // （本轮正是靠它把"协议/池写错了"与"启动的是哪一份构建"区分开）。
    const launch = launchOverride || resolveDshLaunch(harnessDir);
    if (!launch) throw new Error(`无法从 ${harnessDir} 解析 dsh 启动方式（package.json 的 scripts.dsh）`);
    const child = spawn(process.execPath, [...launch.args, '--profile', String(profile)], {
      cwd: launch.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-4000); });
    // stdin 出错（对端已死）不能变成未捕获异常。
    child.stdin.on('error', () => { /* 由 onExit 统一收场 */ });

    const worker = createWorker({
      send: (line) => child.stdin.write(line),
      onData: (cb) => child.stdout.on('data', (d) => cb(String(d))),
      onExit: (cb) => {
        child.on('close', (code, signal) => cb({ code, signal, stderrTail }));
        child.on('error', (e) => cb({ error: e.message, stderrTail }));
      },
      kill: () => killTree(child),
    }, { defaultTimeoutMs: readyTimeoutMs });

    const dispose = () => {
      try { worker.kill(); } catch { /* 已退出 */ }
      try { child.stdin.end(); } catch { /* 已关闭 */ }
    };

    try {
      const params = {
        cwd: launch.cwd,
        provider: String(route.provider || ''),
        model: String(route.model || ''),
      };
      // `reasoningEffort` 必须非空字符串、`maxTokens` 必须是正安全整数，否则握手直接失败
      // （协议取证：空串会被 TypeError 拒掉）。所以**空值一律不下发**，而不是发一个空串。
      if (route.reasoningEffort) params.reasoningEffort = String(route.reasoningEffort);
      if (Number.isSafeInteger(route.maxTokens) && route.maxTokens > 0) params.maxTokens = route.maxTokens;
      const res = await worker.request('initialize', params, readyTimeoutMs);
      const name = res && res.serverInfo && res.serverInfo.name;
      if (name !== 'deepseek-harness-sdk-runtime') {
        throw new Error(`握手返回了意外的 serverInfo：${JSON.stringify(res)}`);
      }
      log('info', 'sdk_worker_ready', `常驻 dsh 已就绪（profile=${profile}，pid=${child.pid}，路由 ${params.provider}|${params.model}|${params.reasoningEffort || ''}）`);
    } catch (e) {
      // 握手失败必须**把进程收掉**：否则每次失败都在后台留一条常驻 dsh。
      dispose();
      e.stderrTail = stderrTail;
      throw e;
    }

    return { worker, dispose, stderrTail: () => stderrTail, pid: child.pid };
  };
}
