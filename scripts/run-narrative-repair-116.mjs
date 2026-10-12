#!/usr/bin/env node
/**
 * run-narrative-repair-116.mjs —— 《修复.md》E00.3 / E07 的**离线验收运行器**（零计费）。
 *
 * 为什么要有它（而不是把命令抄进文档）：
 *   · E00.3 要求"修改前"基线，E07 要求"修改后"同一批命令；两份手抄的命令清单必然漂移，
 *     最后没人知道"通过"是对着哪一组命令说的；
 *   · 交付要求**真实退出码 + 断言数**，而人肉抄录的退出码不可复核。这里由进程自己记录：
 *     spawnSync 的真实 status、stdout/stderr 落盘位置、从汇总行解析出的断言数。
 *
 * 纪律（与 .p1-baseline/verify-all.mjs、scripts/ci-offline-checks.mjs 一致）：
 *   · 只信退出码，不信输出文案；
 *   · 「0 tests / 无匹配」永远不算 passed（断言数为 0 时判 failed）；
 *   · 需要活实例或真实模型的检查不在这里（零计费是硬约束）；
 *   · 失败继续跑完（一次看清全部红灯），最后非零退出。
 *
 * 用法:
 *   node scripts/run-narrative-repair-116.mjs --label baseline
 *   node scripts/run-narrative-repair-116.mjs --label after
 *   node scripts/run-narrative-repair-116.mjs --label after --only 协议
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO, '.narrative-repair-116');

/**
 * `countRe` 用于从各套件自己的汇总行里取断言数。三种口径都在仓库里真实存在：
 *   · tests/narrative-repair：`[标签] 通过 X / 未通过 Y（共 Z 条，零计费）`
 *   · frontend-test：`通过 X / 未通过 Y`（分节汇总，取最后一次出现）
 *   · .p1-baseline/*：`通过 X / 未通过 Y / 跳过 Z`
 */
export const CHECKS = [
  {
    id: 'E00-narrative-repair-suite',
    label: '叙事性专项离线套件（补丁协议 v2 / 夹具 / 阶段规则 / 叙事扫描 / 编辑计划 / 报告 / 审稿结构）',
    cmd: ['scripts/test-narrative-repair.mjs'],
    why: 'E01/E02/E04/E05 的判定面：显式删除、精确跨度、越权与 stale、阶段化规则都在这里',
  },
  {
    id: 'E00-narrative-acceptance',
    label: '叙事性专项验收运行器（E07 退出码判定）',
    cmd: ['scripts/run-narrative-acceptance.mjs'],
    why: 'E07 的机器可读清单：按退出码判定而不是按文案',
  },
  {
    id: 'E00-frontend',
    label: '前端执行验证（vm + DOM 桩，界面契约）',
    cmd: ['frontend-test.mjs'],
    why: 'app.js 的接线改动只能在这里被真实执行到（修稿入口、差异预览、采纳）',
  },
  {
    id: 'E00-editing-rules',
    label: '编辑规则（隔离实例：规则进请求 / 题材门控 / 确定性扫描）',
    cmd: ['.p1-baseline/test-editing-rules.mjs'],
    why: 'E05 阶段规则与通道对账的既有证据面',
  },
  {
    id: 'E00-plugin-tools',
    label: '插件工具面与版本一致',
    cmd: ['.p1-baseline/verify-plugin-tools.mjs'],
    why: 'Host 侧工具契约不得因本轮改动漂移',
  },
  {
    id: 'E00-preset-copy',
    label: '预设拷贝一致性',
    cmd: ['.p1-baseline/verify-preset-copy.mjs'],
    why: 'E05 的 DSH preset 通道：拷贝与激活的版本必须一致',
  },
];

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const label = arg('--label', 'run');
const only = arg('--only', '');
const list = only ? CHECKS.filter((c) => c.label.includes(only) || c.id.includes(only)) : CHECKS;

fs.mkdirSync(OUT_DIR, { recursive: true });
const logDir = path.join(OUT_DIR, `logs-${label}`);
fs.mkdirSync(logDir, { recursive: true });

/**
 * 取汇总行的断言数；取不到就返回 null。
 *
 * 为什么允许"取不到"：本仓库的汇总行有三种口径（`通过 X / 未通过 Y`、`... / 跳过 Z`、
 * `=== ALL PASS ===` + 退出码），强求统一格式只会把"没有解析器"误报成"测试失败"。
 * 所以判定分两层：**先看退出码**；再单独识别"零用例陷阱"（把"没有测试"当通过）。
 */
function parseCounts(stdout) {
  const text = String(stdout || '');
  let m = null;
  let last = null;
  const re = /通过\s*(\d+)\s*\/\s*未通过\s*(\d+)(?:\s*\/\s*跳过\s*(\d+))?/g;
  while ((m = re.exec(text))) last = m;
  if (!last) return null;
  const passed = Number(last[1]);
  const failed = Number(last[2]);
  const skipped = last[3] == null ? 0 : Number(last[3]);
  return { passed, failed, skipped, total: passed + failed + skipped };
}

/**
 * 零用例陷阱：退出码 0 但实际一条断言都没跑（`--only` 没匹配、清单为空、`0 tests`）。
 * 只识别**明确**的零值声明；识别不到就不判 —— 不把"格式不认识"当成"没跑测试"。
 */
const ZERO_TRAP = [
  /共\s*0\s*(?:条|个|项)/,
  /通过\s*0\s*\/\s*未通过\s*0/,
  /\b0\s+tests?\b/i,
  /零用例/,
];
function zeroTrap(text) {
  const t = String(text || '');
  return ZERO_TRAP.some((re) => re.test(t)) ? (t.match(ZERO_TRAP.find((re) => re.test(t))) || ['零用例'])[0] : null;
}

const results = [];
for (const c of list) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, c.cmd, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NARRATIVE_REPAIR_116_LABEL: label },
  });
  const ms = Date.now() - t0;
  const status = r.status == null ? `signal:${r.signal || 'unknown'}` : r.status;
  const counts = parseCounts(r.stdout) || parseCounts(r.stderr);
  const logName = `${c.id}.log`;
  fs.writeFileSync(path.join(logDir, logName), [
    `# 命令: node ${c.cmd.join(' ')}`,
    `# cwd: ${REPO}`,
    `# 时间: ${new Date().toISOString()}`,
    `# 退出码: ${status}  耗时: ${ms}ms`,
    `# ── stdout ──`,
    String(r.stdout || ''),
    `# ── stderr ──`,
    String(r.stderr || ''),
  ].join('\n'), 'utf8');

  // 判定：退出码 0 **且**没有命中"零用例陷阱"才算 passed（"0 tests / 无匹配"不算通过）。
  const trap = zeroTrap(r.stdout) || zeroTrap(r.stderr);
  const zeroCounts = counts ? counts.total === 0 : false;
  const passed = status === 0 && !trap && !zeroCounts;
  results.push({
    id: c.id, label: c.label, cmd: `node ${c.cmd.join(' ')}`, why: c.why,
    exit_code: status, ms, counts, counts_parsed: !!counts,
    zero_assertion_evidence: trap || (zeroCounts ? '断言总数为 0' : null),
    verdict: passed ? 'passed' : 'failed',
    evidence: path.relative(REPO, path.join(logDir, logName)).replace(/\\/g, '/'),
  });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${c.id}  exit=${status}${counts ? `  断言 ${counts.passed}/${counts.total}（未通过 ${counts.failed}${counts.skipped ? `，跳过 ${counts.skipped}` : ''}）` : '  汇总行非标准（以退出码判定）'}`);
  if (!passed) {
    const tail = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-4).join(' | ');
    console.log(`      └ ${trap ? `零用例陷阱：${trap}｜` : ''}${tail.slice(0, 300)}`);
    const err = String(r.stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | ');
    if (err) console.log(`      └ stderr: ${err.slice(0, 300)}`);
  }
}

const bad = results.filter((x) => x.verdict !== 'passed');
const manifest = {
  label,
  generated_at: new Date().toISOString(),
  node: process.version,
  cwd: REPO,
  note: '退出码 0 且断言数非零才算 passed；skipped 不算 passed。零计费（不调用真实模型）。',
  totals: { checks: results.length, passed: results.length - bad.length, failed: bad.length },
  results,
};
const outFile = path.join(OUT_DIR, `${label}-run.json`);
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n[${label}] 通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 条，零计费）`);
console.log(`清单：${path.relative(REPO, outFile).replace(/\\/g, '/')}`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.id).join('; '));
process.exitCode = bad.length ? 1 : 0;
