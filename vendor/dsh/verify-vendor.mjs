#!/usr/bin/env node
/**
 * vendor/dsh/verify-vendor.mjs —— S11：校验"固定的上游基线"确实是那个提交。
 *
 * 为什么需要它：把上游源码当成依赖用时，最容易悄悄漂移的不是代码，而是**来源**——
 * 有人在那棵树里 `git pull`、改了文件、换了 tag，而所有测试仍然绿（因为测试跑的是改动后的树）。
 * 所以"基线是哪个提交、是否干净、许可是否在、lockfile 是不是那一份"必须能被**机器复核**。
 *
 * 默认**只读校验**（不 clone、不 install、不 build）：
 *   node vendor/dsh/verify-vendor.mjs                       # 校验默认路径的基线
 *   node vendor/dsh/verify-vendor.mjs --path <dir>          # 校验指定目录
 *   node vendor/dsh/verify-vendor.mjs --json                # 机器可读
 *
 * 退出码：0 = 基线符合期望；1 = 不符（门禁应据此判红）；2 = 用法错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <repo>/vendor/dsh
const REPO_ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** 期望的基线（与 vendor/dsh/PROVENANCE.md 必须一致；改这里就要改那里）。 */
export const EXPECTED = Object.freeze({
  origin: 'https://github.com/deepseek-ai/deepseek-harness',
  upstream_tag: 'dsh-v0.1.7-rc.1',
  upstream_commit: '46a7f68b',
  vendor_commit: '7e06df2',
  package_version: '0.1.7-rc.1',
  license_file: 'LICENSE',
  lockfile: 'pnpm-lock.yaml',
});

function sh(argsArr, cwd) {
  return execFileSync('git', argsArr, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

export function verify() {
  const onlyJson = has('--json');
  // 默认基线位置：<repo>/../deepseek-harness（与 novel-studio 同级），
  // 以脚本自身位置推导，而不是用 cwd —— 否则从不同目录运行会指错地方。
  const target = path.resolve(val('--path', path.resolve(REPO_ROOT, '..', 'deepseek-harness')));
  const problems = [];
  const out = { version: 'vendor-v1', path: target, expected: EXPECTED, actual: {}, problems };

  if (!fs.existsSync(target)) {
    problems.push(`基线目录不存在：${target}（用 --path 指定）`);
    return out;
  }
  const isGit = fs.existsSync(path.join(target, '.git'));
  out.actual.is_git = isGit;

  const pkgPath = path.join(target, 'package.json');
  if (!fs.existsSync(pkgPath)) problems.push('缺少 package.json（不是 DSH 基线？）');
  else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    out.actual.package_version = String(pkg.version || '');
    if (out.actual.package_version !== EXPECTED.package_version) {
      problems.push(`package version 不符：期望 ${EXPECTED.package_version}，实际 ${out.actual.package_version}`);
    }
    out.actual.build_scripts = ['build', 'typecheck', 'lint'].filter((s) => pkg.scripts && pkg.scripts[s]);
    if (out.actual.build_scripts.length !== 3) {
      problems.push(`缺少构建脚本：${['build', 'typecheck', 'lint'].filter((s) => !(pkg.scripts && pkg.scripts[s])).join(', ')}`);
    }
  }

  // 许可必须存在且非空（"来源和许可齐全"是本阶段的验收项）
  const licPath = path.join(target, EXPECTED.license_file);
  if (!fs.existsSync(licPath)) problems.push(`缺少 ${EXPECTED.license_file}（许可证必须随基线保留）`);
  else {
    const bytes = fs.statSync(licPath).size;
    out.actual.license_bytes = bytes;
    if (bytes < 100) problems.push(`许可证文件过小（${bytes} 字节），疑似被替换`);
  }

  // lockfile 必须存在，并记录其摘要（"保留 lockfile"要能对账）
  const lockPath = path.join(target, EXPECTED.lockfile);
  if (!fs.existsSync(lockPath)) problems.push(`缺少 ${EXPECTED.lockfile}（必须保留 lockfile）`);
  else out.actual.lockfile_sha256 = sha256File(lockPath);

  if (isGit) {
    try {
      out.actual.head = sh(['rev-parse', '--short=7', 'HEAD'], target);
      out.actual.head_full = sh(['rev-parse', 'HEAD'], target);
      out.actual.tag = (() => { try { return sh(['describe', '--tags', '--always'], target); } catch { return ''; } })();
      out.actual.dirty = sh(['status', '--porcelain'], target) !== '';
      out.actual.origin = (() => { try { return sh(['remote', 'get-url', 'origin'], target); } catch { return ''; } })();
      if (!out.actual.head_full.startsWith(EXPECTED.vendor_commit)) {
        problems.push(`HEAD 不符：期望以 ${EXPECTED.vendor_commit} 开头，实际 ${out.actual.head_full}`);
      }
      if (out.actual.dirty) problems.push('基线工作树不干净（有人在那棵树里改过东西，来源已不可信）');
      if (!String(out.actual.origin).includes('deepseek-harness')) {
        problems.push(`origin 不指向上游：${out.actual.origin}`);
      }
    } catch (e) {
      problems.push(`git 校验失败：${(e && e.message) || e}`);
    }
  } else {
    // 允许"拷贝式基线"（没有 .git）：此时必须至少有 PROVENANCE 记录，且由上层检查
    out.actual.note = '不是 git 工作树：只能校验文件层面的完整性';
  }

  return out;
}

const result = verify();

/**
 * 只有**直接运行**时才执行+退出。
 * 为什么：这个文件同时被 tests/nsdsh/dsh-vendor-provenance.test.mjs import 来做静态对账；
 * 若 import 时就 process.exit，会把测试进程直接杀掉（实测：套件一行输出都没有）。
 */
function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
if (has('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`DSH 基线校验：${result.path}`);
  console.log(`  期望：tag ${EXPECTED.upstream_tag} / vendor commit ${EXPECTED.vendor_commit} / 包 ${EXPECTED.package_version}`);
  console.log(`  实际：HEAD ${result.actual.head || '(无)'} / tag ${result.actual.tag || '(无)'} / 包 ${result.actual.package_version || '(无)'}`);
  console.log(`  许可：${result.actual.license_bytes ? result.actual.license_bytes + ' 字节' : '(缺)'}；lockfile sha256 ${String(result.actual.lockfile_sha256 || '(缺)').slice(0, 16)}…`);
  console.log(`  构建脚本：${(result.actual.build_scripts || []).join('/') || '(缺)'}；工作树${result.actual.dirty ? '不干净 ✗' : '干净 ✓'}`);
  if (result.problems.length) {
    console.log('  ✗ 问题：');
    for (const p of result.problems) console.log('    - ' + p);
  } else {
    console.log('  ✓ 基线与 PROVENANCE 记录一致（可复核、可回滚）');
  }
}
process.exit(result.problems.length ? 1 : 0);
}
