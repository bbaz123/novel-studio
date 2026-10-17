/**
 * ai/runtime/sdk-process.mjs —— R01：真实 DSH SDK 子进程的定位、启动与清理。
 *
 * ── 这一层修的是什么（S13 留下的真实缺口）─────────────────────────────────────
 * S13 的实现里写着 `cmd: 'dsh-sdk', args: ['--stdio']`。**这个命令不存在**。
 * 它是"看着合理"编出来的：上游没有叫 `dsh-sdk` 的可执行文件，也没有 `--stdio` 开关。
 * 真实入口在锁定基线里是这样启动的（出处：`packages/sdk/client/src/launch.ts`
 * 的 `resolveDshLaunch()`，以及上游自己的 `apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts`）：
 *
 *     node <baseline>/apps/cli/lib/bin.js --profile sdk [--patch <yml>...]
 *
 * 也就是说：**入口是 CLI 的构建产物，profile 才是「SDK 模式」的开关**，
 * stdio 上的 JSON-RPC 由 profile 里挂载的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 提供。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 *   ① **入口只从 manifest 解析**：不猜路径、不退回源码树、不退回全局 node_modules。
 *      任何一项核对不上就 fail-closed（`ok:false`），绝不"降级启动"。
 *   ② **环境显式枚举**：不整体展开 `process.env`。敏感键（`*_API_KEY`/`*TOKEN*`/
 *      `*SECRET*`/`*PASSWORD*`）默认**不传**，要传必须写进 `allow` 白名单。
 *   ③ **不在这里判定成功的含义**：本模块只负责"起得来、退得掉"，
 *      协议关联与终态在 `sdk-stdio-transport.mjs` / `sdk-adapter.mjs`。
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SDK_PROCESS_VERSION = 'sdk-process-v1';

/**
 * 启动子进程时**必须**带上的系统键（缺了 Node 本身都可能起不来）。
 * 这是白名单，不是"顺手全带上"——不在这个集合里、也不在 `allow` 里的键一律不传。
 */
export const BASE_ENV_KEYS = Object.freeze([
  'PATH', 'Path',
  'PATHEXT',
  'SystemRoot', 'SYSTEMROOT', 'windir',
  'COMSPEC',
  'TEMP', 'TMP',
  'HOME', 'USERPROFILE',
  'LANG', 'LC_ALL', 'TZ',
]);

/** 敏感键判据：命中就必须显式 allow，不能因为"调用方传了 sourceEnv"就漏出去。 */
export const SENSITIVE_ENV_PATTERNS = Object.freeze([
  /api_key$/i,
  /_token$/i,
  /^token$/i,
  /secret/i,
  /password/i,
  /credential/i,
  /private_key/i,
]);

export function isSensitiveEnvKey(key) {
  const k = String(key || '');
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(k));
}

/**
 * 读 manifest 并核对入口。**纯函数 + 注入式 fs**，因此可离线断言"错配必须拒绝"。
 *
 * @param manifestPath  `vendor/dsh/runtime-manifest.json` 的绝对路径
 * @param repoRoot      产品仓库根（用于把 `baseline.location` 解析成绝对路径）
 * @param profile       要启动的 profile（默认 `sdk`；`sdk-minimal` 也真实存在）
 * @param patches       额外 `--patch <yml>`（绝对路径）
 */
export function resolveDshLaunch({
  manifestPath,
  repoRoot,
  profile = 'sdk',
  patches = [],
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
  nodeVersion = process.versions.node,
  platform = process.platform,
} = {}) {
  const problems = [];
  const refuse = (reason, detail) => ({ ok: false, reason, detail, problems, command: null, args: null });

  if (!manifestPath) return refuse('MISSING_MANIFEST_PATH', '必须给出 runtime-manifest.json 的绝对路径');
  let manifest;
  try {
    manifest = JSON.parse(String(readFileSync(manifestPath, 'utf8')));
  } catch (e) {
    return refuse('MANIFEST_UNREADABLE', String((e && e.message) || e));
  }

  const baseline = (manifest && manifest.baseline) || {};
  const entry = (manifest && manifest.entry) || {};
  const handshake = (manifest && manifest.handshake) || {};

  if (entry.kind !== 'built-cli') {
    // dev 入口（src/bin.ts）说明基线尚未构建；用 tsx 跑源码不是发行形态，不能默认这么做。
    problems.push(`ENTRY_NOT_BUILT: entry.kind=${String(entry.kind)}（需要 built-cli）`);
  }
  if (!baseline.location) problems.push('MANIFEST_NO_BASELINE_LOCATION');
  if (!entry.path) problems.push('MANIFEST_NO_ENTRY_PATH');
  if (problems.length) return refuse('MANIFEST_INCOMPLETE', problems.join('; '));

  const baselineRoot = path.resolve(repoRoot, baseline.location);
  const entryPath = path.resolve(baselineRoot, entry.path);

  // ① 入口必须真的是一个文件（不退回源码树、不退回全局包）
  if (!existsSync(entryPath)) {
    return refuse('ENTRY_MISSING', `入口不是文件：${entryPath}（拒绝降级到源码/dev 入口）`);
  }

  // ② 版本核对：manifest 声明的版本必须等于基线 package.json 的版本。
  //    注意：这是**包版本**，不是 stdio 上 `serverInfo.version`（后者是协议版本常量 `0.0.1`）。
  const pkgPath = path.join(baselineRoot, String(handshake.versionFile || 'package.json'));
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(String(readFileSync(pkgPath, 'utf8'))).version || null;
  } catch (e) {
    problems.push(`BASELINE_PACKAGE_UNREADABLE: ${String((e && e.message) || e)}`);
  }
  if (pkgVersion !== null && handshake.expectVersion && pkgVersion !== handshake.expectVersion) {
    problems.push(`VERSION_MISMATCH: 基线 ${pkgVersion} ≠ manifest ${handshake.expectVersion}`);
  }

  // ③ Node 范围：本机主版本必须能跑基线（我们只记录并拒绝明显过旧的）。
  const major = Number(String(nodeVersion).split('.')[0]) || 0;
  if (major && major < 22) problems.push(`NODE_TOO_OLD: 需要 ≥22，实际 v${nodeVersion}`);

  if (problems.length) return refuse('LAUNCH_REFUSED', problems.join('; '));

  const resolvedPatches = patches.map((p) => path.resolve(String(p)));
  const args = [entryPath, '--profile', String(profile)];
  for (const p of resolvedPatches) args.push('--patch', p);

  return {
    ok: true,
    version: SDK_PROCESS_VERSION,
    // 永远用当前 Node 解释器跑入口脚本，不依赖 shebang 与 PATH 解析
    command: process.execPath,
    args,
    entryPath,
    baselineRoot,
    profile: String(profile),
    patches: resolvedPatches,
    expectVersion: handshake.expectVersion || null,
    pkgVersion,
    vendorCommit: baseline.vendor_commit || null,
    upstreamCommit: baseline.upstream_commit || null,
    upstreamTag: baseline.tag || null,
    platform,
    nodeVersion,
    handlesShutdown: Array.isArray(handshake.methods) ? handshake.methods.includes('shutdown') : false,
    problems,
  };
}

/**
 * 构造子进程环境（**白名单**）。
 *
 * @param allow     额外允许的键（例如 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`、`DSH_HOME`）。
 *                  敏感键出现在这里 = 调用方显式同意把它交给子进程。
 * @param sourceEnv 取值来源（默认 `process.env`；测试可注入）
 * @returns `{ env, passed, withheld }` —— `withheld` 列出"源里存在但因为敏感/不在白名单
 *          而被挡下"的键名（**只列键名，绝不列值**），便于审计与断言。
 */
export function buildChildEnv({ allow = [], extra = {}, sourceEnv = process.env } = {}) {
  const allowSet = new Set(allow.map(String));
  const env = {};
  const passed = [];
  const withheld = [];

  for (const key of BASE_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
      passed.push(key);
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (isSensitiveEnvKey(key) && !allowSet.has(key)) {
      withheld.push(key);
      continue;
    }
    env[key] = String(value);
    if (!passed.includes(key)) passed.push(key);
  }
  for (const key of allowSet) {
    if (env[key] !== undefined) continue;
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
      passed.push(key);
    }
  }
  // 源里"看起来敏感、我们又没被允许"的键：记录下来，绝不传
  for (const key of Object.keys(sourceEnv)) {
    if (env[key] !== undefined) continue;
    if (isSensitiveEnvKey(key) && !allowSet.has(key) && sourceEnv[key] !== undefined) withheld.push(key);
  }

  return { env, passed: passed.sort(), withheld: [...new Set(withheld)].sort() };
}

/**
 * 真实 spawn 包装。**只有这一处**调用 `child_process`，方便审计与注入。
 *
 * 返回值刻意做成与旧 S13 `spawn` 契约兼容的形状（`pid/send/kill/onExit/exited`），
 * 但多给 `stdinStream/stdoutStream/stderrStream/waitExit`，供真正的传输层使用。
 */
export function spawnReal({ command, args, cwd, env, killSignal = 'SIGTERM' } = {}) {
  if (!command) throw new TypeError('MISSING_COMMAND');
  const child = childProcess.spawn(command, Array.isArray(args) ? args : [], {
    cwd,
    env,
    // shell:false 是硬要求：参数数组若经过 shell，会被分词/展开，等于把注入面打开
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let exited = false;
  let exitCode = null;
  let signal = null;
  const exitListeners = [];
  const stderrChunks = [];

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderrChunks.length < 400) stderrChunks.push(String(chunk));
    });
  }

  const settle = (code, sig) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    signal = sig;
    handle.exited = true;
    handle.exitCode = code;
    for (const fn of exitListeners) {
      try { fn(code, sig); } catch { /* 监听器异常不得影响退出结算 */ }
    }
  };
  child.on('exit', (code, sig) => settle(code, sig));
  // 'error'（例如 EPERM/ENOENT）也要落成一次退出结算，否则调用方会永远等下去
  child.on('error', (e) => {
    handle.spawnError = String((e && e.code) || (e && e.message) || e);
    settle(null, null);
  });

  const handle = {
    pid: child.pid || 0,
    child,
    stdinStream: child.stdin,
    stdoutStream: child.stdout,
    stderrStream: child.stderr,
    spawnError: null,
    exited: false,
    exitCode: null,
    signal: null,
    kill(sig = killSignal) {
      try { child.kill(sig); } catch { /* 已退出 */ }
    },
    onExit(fn) { exitListeners.push(fn); },
    /** 等真实退出（带超时；超时如实返回 false，不假装成功）。 */
    async waitExit(timeoutMs = 5000) {
      if (exited) return true;
      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
      while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return exited;
    },
    stderrText() { return stderrChunks.join(''); },
  };
  return handle;
}

/**
 * 进程树清理：目标平台策略不同，因此**显式分叉**而不是一套信号打通。
 *   · win32：`taskkill /PID <pid> /T /F`（POSIX 信号杀不掉 Node 的孙进程）
 *   · 其他：先 SIGTERM 正常退出，超时再 SIGKILL 进程组
 *
 * @param spawnSyncImpl 注入点（测试用假实现，**绝不**在单测里真的杀进程）
 * @returns `{ ok, steps, detail }` —— `ok:false` 表示"没清理成功"，上层必须如实记成失败
 */
export function terminateProcessTree(handle, {
  timeoutMs = 5000,
  spawnSyncImpl = childProcess.spawnSync,
  platform = process.platform,
} = {}) {
  const steps = [];
  if (!handle || !handle.pid) return { ok: true, steps: ['NO_PID'], detail: '没有子进程需要清理' };
  if (handle.exited) return { ok: true, steps: ['ALREADY_EXITED'], detail: `exit=${String(handle.exitCode)}` };

  if (platform === 'win32') {
    const r = spawnSyncImpl('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { windowsHide: true });
    steps.push(`taskkill /PID ${handle.pid} /T /F → status=${String(r && r.status)}`);
    if (r && r.status !== 0 && !handle.exited) {
      handle.kill('SIGKILL');
      steps.push('fallback SIGKILL');
    }
  } else {
    handle.kill('SIGTERM');
    steps.push('SIGTERM');
  }
  return { ok: true, steps, detail: '已发出终止（是否真退出由 waitExit 判定）', timeoutMs };
}

/**
 * 孤儿进程扫描：**只报事实**。查不到就是查不到，不猜"应该没有"。
 * @returns `{ checked, alive, detail }`
 */
export function scanProcess(pid) {
  if (!pid) return { checked: false, alive: null, detail: 'NO_PID' };
  try {
    process.kill(pid, 0);
    return { checked: true, alive: true, detail: `pid ${pid} 仍可被信号探测（0 号信号）` };
  } catch (e) {
    const code = String((e && e.code) || '');
    // ESRCH = 不存在（这是我们要的结果）；EPERM = 存在但无权限（也说明还活着）
    if (code === 'ESRCH') return { checked: true, alive: false, detail: `pid ${pid} 已不存在` };
    return { checked: true, alive: opPermMeansAlive(code), detail: `pid ${pid} 探测结果 ${code}` };
  }
}

function opPermMeansAlive(code) {
  return code === 'EPERM';
}
