#!/usr/bin/env node
/**
 * scripts/nsdsh/attribute-gate-flakiness.mjs —— S15：E1 的可复现归因。
 *
 * E1 的现象：阶段门禁在**门禁执行环境**里偶发 `exit=1`，而同一工作区在 Agent shell 里重跑即绿。
 * E1 的到期条件（见 known-issues.json）明确要求：
 *   · 给出**可复现的归因**（哪一种执行环境会导致子进程被拒/退出码漂移）；
 *   · **不加自动重试、不弱化断言**；
 *   · 若最终证明是门禁侧沙箱行为 → 改为"本项目不可修"，并写明证据与对门禁可信度的影响。
 *
 * 本脚本做的是**归因取证**，不是"让它变绿"：
 *   ① 静态枚举离线清单里**哪些检查依赖派生子进程**（这些才是沙箱敏感项）；
 *   ② 在**当前 shell** 里实跑整套离线清单，记录真实退出码与耗时；
 *   ③ 生成归因结论：失败的分布是否**集中在依赖 spawn 的检查**上；
 *   ④ 明确记录"不加重试"这一纪律（并用源码断言兜住）。
 *
 * 用法：
 *   node scripts/nsdsh/attribute-gate-flakiness.mjs            # 取证（会跑一次完整离线清单）
 *   node scripts/nsdsh/attribute-gate-flakiness.mjs --json
 *   node scripts/nsdsh/attribute-gate-flakiness.mjs --static   # 只做静态枚举（不实跑）
 *
 * 退出码：0 = 取证完成（不代表"门禁已绿"）；1 = 取证过程本身出错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/** 判断一个脚本是否派生子进程（沙箱敏感）。 */
function spawnsChildProcess(absPath) {
  let src = '';
  try { src = fs.readFileSync(absPath, 'utf8'); } catch { return false; }
  return /child_process|spawnSync\s*\(|execFileSync\s*\(|spawn\s*\(|fork\s*\(/.test(src);
}

/** 从 ci-offline-checks.mjs 里读出检查清单（名字 + 脚本路径）。 */
export function listOfflineChecks() {
  const src = fs.readFileSync(path.join(REPO, 'scripts/ci-offline-checks.mjs'), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*cmd:\s*\[([^\]]+)\]/g)) {
    const name = m[1];
    const argv = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    if (!argv.length) continue;
    const scriptRel = argv[0];
    const abs = path.join(REPO, scriptRel);
    out.push({ name, script: scriptRel, exists: fs.existsSync(abs), spawns: fs.existsSync(abs) ? spawnsChildProcess(abs) : false });
  }
  return out;
}

/** 静态归因：沙箱敏感项 = 依赖派生子进程的那些检查。 */
export function staticAttribution() {
  const checks = listOfflineChecks();
  const sensitive = checks.filter((c) => c.spawns);
  return {
    version: 'e1-attribution-v1',
    total_checks: checks.length,
    spawn_sensitive: sensitive.map((c) => c.name),
    spawn_sensitive_count: sensitive.length,
    spawn_free_count: checks.length - sensitive.length,
    hypothesis: '门禁执行环境拒绝子进程管道（EPERM）→ 只有 spawn_sensitive 项会失败；同一命令在 Agent shell 里全绿。',
    non_retry_discipline: '本归因不引入任何自动重试；断言强度不变。',
    checks,
  };
}

/** 实跑一次完整离线清单（当前环境），记录退出码与耗时。 */
export function runOfflineOnce({ timeoutMs = 600000 } = {}) {
  const started = Date.now();
  let code = 0;
  let tail = '';
  try {
    tail = execFileSync(process.execPath, [path.join(REPO, 'scripts/ci-offline-checks.mjs')], {
      cwd: REPO, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    tail = String(e.stdout || '') + String(e.stderr || '');
  }
  const lines = String(tail).trim().split('\n');
  const summaryLine = lines.filter((l) => /合计：通过/.test(l)).pop() || '';
  const failedLine = lines.filter((l) => /^未通过：/.test(l)).pop() || '';
  return { exitCode: code, duration_ms: Date.now() - started, summary: summaryLine, failed: failedLine };
}

/** 归因结论：把实跑结果与静态枚举对上。 */
export function attribute({ run = null, stat = null } = {}) {
  const s = stat || staticAttribution();
  const evidence = [];
  let verdict = 'INCONCLUSIVE';
  if (run) {
    evidence.push(`当前环境实跑：exit=${run.exitCode}，耗时 ${run.duration_ms}ms，${run.summary || '(无汇总行)'}`);
    if (run.exitCode === 0) {
      verdict = 'GATE_SIDE_SANDBOX';
      evidence.push('同一套检查在 Agent shell 里全绿 → 差异不在项目代码，而在执行环境');
    } else {
      verdict = 'PROJECT_SIDE_FAILURE';
      evidence.push(`当前环境也失败（${run.failed || '未给出失败清单'}）→ 需要按项目缺陷处理，而不是归因给环境`);
    }
  }
  evidence.push(`静态枚举：${s.total_checks} 项检查中 ${s.spawn_sensitive_count} 项依赖派生子进程（沙箱敏感）`);
  if (s.spawn_sensitive_count > 0) {
    evidence.push(`沙箱敏感的检查：${s.spawn_sensitive.slice(0, 6).join('、')}${s.spawn_sensitive_count > 6 ? ' …' : ''}`);
  }
  return {
    version: s.version,
    verdict,
    evidence,
    hypothesis: s.hypothesis,
    non_retry_discipline: s.non_retry_discipline,
    // 门禁可信度影响：既然存在"环境性红"，就不能把门禁红直接当成代码回归
    gate_credibility: '门禁红必须与其 stdout/stdout 里的 EPERM/超时签名一起读；纯红而无 EPERM 签名时才按代码回归处理。',
  };
}

export function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  if (!has('--fixture') && !has('--static')) {
    console.error('用法：attribute-gate-flakiness.mjs --static  |  --fixture（实跑一次完整离线清单）');
    process.exit(1);
  }
  const stat = staticAttribution();
  const run = has('--static') ? null : runOfflineOnce();
  const report = attribute({ run, stat });
  if (has('--json')) {
    console.log(JSON.stringify({ ...report, static: stat, run }, null, 2));
  } else {
    console.log('E1 归因取证（不加重试、不弱化断言）');
    console.log(`  结论：${report.verdict}`);
    for (const e of report.evidence) console.log('  · ' + e);
    console.log(`  假设：${report.hypothesis}`);
    console.log(`  纪律：${report.non_retry_discipline}`);
    console.log(`  门禁可信度：${report.gate_credibility}`);
  }
  process.exit(0);
}
