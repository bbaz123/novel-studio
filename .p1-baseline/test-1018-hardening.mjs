#!/usr/bin/env node
/**
 * test-1018-hardening.mjs —— v1.2.0 修复的回归总入口（P01–P16，零计费、离线）。
 *
 * 为什么是"总入口 + 分套件"而不是把所有断言塞进一个文件：
 *   · 每项修复的观察面不同（HTTP 隔离实例 / 纯函数 / 命令退出码 / in-memory SQLite），
 *     分开才能让失败精确定位到某一项；
 *   · 与 `scripts/test-narrative-repair.mjs` 同一纪律：子套件任一失败即非零退出，
 *     **skipped 不算 passed**，也不允许因为"某项没跑起来"而记通过。
 *
 * 纪律（与 ci-offline-checks 一致）：
 *   · 只信退出码，不信文案；
 *   · 失败的套件打印其输出尾部，方便直接定位；
 *   · 受限沙箱里 `spawnSync` + `stdio:'pipe'` 会被拒（EPERM）→ 退到"文件重定向"，
 *     只换传输方式，断言与退出码判定一个字不改。
 *
 * 用法:
 *   node .p1-baseline/test-1018-hardening.mjs
 *   node .p1-baseline/test-1018-hardening.mjs --only 授权
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 每项修复对应一个分套件；顺序与方案 §8 的实施顺序一致。 */
const SUITES = [
  { name: 'P03 权限矩阵 + P02 记忆回滚边界', file: 'test-1018-auth-and-memory.mjs' },
  { name: 'P01 伏笔状态/回收/审批同事务', file: 'test-1018-foreshadow-atomic.mjs' },
  { name: 'P04 Origin/Host + P05 请求体解析中止', file: 'test-1018-http-entry.mjs' },
  { name: 'P13 迁移 fail-fast + P07 就绪 + P06 启动脚本', file: 'test-1018-startup-readiness.mjs' },
  { name: 'P12 投影 outbox 租约与恢复', file: 'test-1018-projection-outbox.mjs' },
  { name: 'P08 分析 fencing', file: 'test-1018-analysis-fencing.mjs' },
  { name: 'P09 AI 限额 + P10 追踪脱敏', file: 'test-1018-ai-privacy-limits.mjs' },
  { name: 'P11 输入校验 + P15 检索完整性', file: 'test-1018-input-search.mjs' },
  { name: 'P16 provider 边界 + 重定向保护', file: 'test-1018-ai-provider-boundary.mjs' },
];

function runSuite(file) {
  const rel = path.join('.p1-baseline', file);
  const piped = spawnSync(process.execPath, [rel], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (!(piped.status === null && piped.error && piped.error.code === 'EPERM')) {
    return { status: piped.status, stdout: piped.stdout || '', stderr: piped.stderr || '' };
  }
  // 受限沙箱：管道被拒 → 文件重定向（子进程照常真实执行，退出码照常参与判定）。
  const dir = fs.mkdtempSync(path.join(REPO, '.ci-out-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  try {
    const out = fs.openSync(outPath, 'w');
    const err = fs.openSync(errPath, 'w');
    const r = spawnSync(process.execPath, [rel], { cwd: REPO, stdio: ['ignore', out, err], encoding: 'utf8' });
    fs.closeSync(out);
    fs.closeSync(err);
    const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    return { status: r.status, stdout: readOr(outPath), stderr: readOr(errPath) || (r.error ? `spawn ${r.error.code || r.error.message}` : '') };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖结果 */ }
  }
}

const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
const list = only ? SUITES.filter((s) => s.name.includes(only)) : SUITES;
if (!list.length) {
  console.error(`没有匹配 --only ${only} 的套件`);
  process.exit(1);
}

const results = [];
for (const s of list) {
  const t0 = Date.now();
  const r = runSuite(s.file);
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ ...s, ok, ms });
  console.log(`${ok ? '✓' : '✗'} ${s.name}（${ms}ms）`);
  if (!ok) {
    const tail = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join('\n    ');
    console.log(`    ${tail}`);
    const err = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ');
    if (err) console.log(`    stderr: ${err.slice(0, 400)}`);
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\nv1.2.0 修复回归：通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 项，零计费）`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.name).join('; '));
process.exitCode = bad.length ? 1 : 0;
