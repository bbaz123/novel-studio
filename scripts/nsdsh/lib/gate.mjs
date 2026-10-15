/**
 * nsdsh/lib/gate.mjs —— 起子进程的**统一出口**（S01）。
 *
 * 为什么不能只写一行 `spawnSync(..., {stdio:'pipe'})`：
 *   DSH 的文件沙箱（Windows）禁止子进程**打开管道**（EPERM / errno -4048）。
 *   在受限环境里 `spawnSync` 返回 `status: null` + `error.code === 'EPERM'`，
 *   而本项目的判定是 `status === 0` —— 于是几十条检查会在 0–1ms 内全部变红，
 *   看起来像"被测代码大面积回归"，实际是"检查根本没跑起来"。本项目已经因此误判过两次
 *   （2026-10-12 的 54 条全红；2026-10-15 的 37/17）。
 *
 * 处置原则（与 scripts/ci-offline-checks.mjs、scripts/test-narrative-repair.mjs 一致）：
 *   **只换传输方式，绝不改断言**。管道被拒时退到"文件重定向"，子进程照常真实执行、
 *   退出码照常参与判定。这一层保证的只是"检查真的跑了"，不是"检查一定通过"。
 *
 * 另外这里集中处理"**环境阻断**"的识别：子进程**自己**再起子进程时，沙箱仍会拒绝它的管道，
 * 现象是子进程输出里出现 `spawn EPERM` / `errno -4048`。这种失败记 BLOCKED（环境），
 * 不记 FAIL（回归），也不记 PASS。三个状态必须分开，否则报告会撒谎。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 已知的"环境阻断"指纹：出现即判 BLOCKED，不判回归。 */
export const ENV_BLOCKED_SIGNATURES = [
  /spawn EPERM/i,
  /spawnSync EPERM/i,
  /errno:\s*-4048/,
  /EACCES.*pipe/i,
  /EPERM.*pipe/i,
];

export function looksEnvironmentBlocked(text) {
  const s = String(text || '');
  return ENV_BLOCKED_SIGNATURES.some((re) => re.test(s));
}

/**
 * 跑一条命令。返回：
 *   { status, stdout, stderr, ms, transport, environmentBlocked, error }
 * `status === null` 表示**没有跑起来**（不是失败，也不是通过）。
 */
export function runCommand(argv, {
  cwd = process.cwd(),
  env = null,
  timeoutMs = 20 * 60 * 1000,
  maxBuffer = 128 * 1024 * 1024,
} = {}) {
  const t0 = Date.now();
  const base = { cwd, encoding: 'utf8', maxBuffer, timeout: timeoutMs, env: env ? { ...process.env, ...env } : process.env };

  // ① 正常路径：管道。可用时与仓库既有写法逐字节等价。
  const piped = spawnSync(argv[0], argv.slice(1), { ...base, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!(piped.status === null && piped.error && piped.error.code === 'EPERM')) {
    const stdout = piped.stdout || '';
    const stderr = piped.stderr || '';
    return finish({ status: piped.status, stdout, stderr, transport: 'pipe', error: piped.error || null }, t0);
  }

  // ② 回退路径：全文件描述符（一个管道都不开）。临时文件建在系统临时目录，避免污染工作区。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsdsh-run-'));
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  try {
    const out = fs.openSync(outPath, 'w');
    const err = fs.openSync(errPath, 'w');
    const r = spawnSync(argv[0], argv.slice(1), { ...base, stdio: ['ignore', out, err] });
    fs.closeSync(out);
    fs.closeSync(err);
    const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };
    return finish({
      status: r.status,
      stdout: read(outPath),
      stderr: read(errPath) || (r.error ? `spawn ${r.error.code || r.error.message}` : ''),
      transport: 'file-redirect',
      error: r.error || null,
    }, t0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不掩盖结果 */ }
  }
}

function finish(r, t0) {
  const environmentBlocked = r.status === null || looksEnvironmentBlocked(`${r.stderr}\n${r.stdout}`);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    ms: Date.now() - t0,
    transport: r.transport,
    environmentBlocked,
    error: r.error ? (r.error.code || r.error.message) : null,
  };
}

/**
 * 从子进程输出里解析"跑了多少条测试"。
 * 仓库里真实存在的汇总行有三种写法（实测 grep 全仓得到）：
 *   `通过 N / 未通过 M`、`通过 N / 失败 M`、`通过 N，失败 M`，另可带 `/ 跳过 K`。
 * 解析不出来 → 返回 null（调用方据此判定"无法证明测试数量"，而不是默认通过）。
 */
export function parseTestCounts(text) {
  const s = String(text || '');
  const counts = { passed: null, failed: null, skipped: null, total: null };
  let m = s.match(/PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/i);
  if (m) {
    counts.passed = Number(m[1]);
    counts.failed = Number(m[2]);
  } else {
    m = s.match(/通过\s*(\d+)\s*[/，,]\s*(?:未通过|失败)\s*(\d+)/);
    if (m) {
      counts.passed = Number(m[1]);
      counts.failed = Number(m[2]);
    }
  }
  const sk = s.match(/跳过\s*(\d+)/);
  if (sk) counts.skipped = Number(sk[1]);
  if (counts.passed !== null || counts.failed !== null) {
    counts.total = (counts.passed || 0) + (counts.failed || 0) + (counts.skipped || 0);
  }
  return counts;
}
