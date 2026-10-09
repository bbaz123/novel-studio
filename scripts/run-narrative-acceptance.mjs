#!/usr/bin/env node
/**
 * E07 验收运行器（《叙事性专项修复》§7 E07 + §8.5 + §10.2）。
 *
 * 为什么需要它：E07 的通过条件是"必做工程测试无新增失败 + 每个机制有可复现测试 + 运行证据齐全"。
 * 靠人手工贴命令与结果不可复现，也容易被"输出里出现了'通过'两个字"骗过去（任务书 §8.5 明确禁止）。
 * 本运行器因此：
 *   · **按退出码判定**（不看输出里有没有"通过"）；
 *   · 逐条记录：完整命令、cwd、开始/结束时间、退出码、解析到的通过/失败数、日志路径；
 *   · 输出机器可读清单 `docs/narrative-repair/e07-run-manifest.json` 与人类可读表格；
 *   · 零用例 = 失败（沿用脚本自身的零匹配非零退出约定）。
 *
 * 分类：
 *   · required      —— 必须绿；任一失败 → 本运行器非零退出。
 *   · informational —— 结果照实记录但不阻断（例如提交前的 phase-map 登记门禁：本轮不提交，
 *                       它预期会报"新文件未登记"，那是提交前要做的动作，不是测试失败）。
 *
 * 用法: node scripts/run-narrative-acceptance.mjs [--only <id>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const LOG_DIR = path.join(REPO, '.narrative-repair');
const OUT_JSON = path.join(REPO, 'docs', 'narrative-repair', 'e07-run-manifest.json');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
})();
const asJson = process.argv.includes('--json');

const COMMANDS = [
  { id: 'ci-offline', kind: 'required', args: ['scripts/ci-offline-checks.mjs'], why: '工程离线检查唯一真源（含迁移幂等、Host 契约、插件工具面、前端、隔离实例）' },
  { id: 'narrative-suites', kind: 'required', args: ['scripts/test-narrative-repair.mjs'], why: '专项套件总入口（补齐协议/冻结样本/阶段规则/叙事诊断/编辑计划/报告/审稿结构化）' },
  { id: 'frontend', kind: 'required', args: ['frontend-test.mjs'], why: '应用层接线（协议精确跨度、阶段 URL、覆盖表、单处撤销、选择记录、对照视图）' },
  { id: 'instance-editing', kind: 'required', args: ['.p1-baseline/test-editing-rules.mjs'], why: '隔离实例端到端：编辑规则 + E02 通道等价 + E03 选择记录 + E04 候选 + E06 对照' },
  { id: 'instance-migration', kind: 'required', args: ['.p1-baseline/test-migration-idempotent.mjs'], why: '空库建表 / 重复启动 / 旧库只读 / 损坏库响亮失败（回滚与兼容的机器证据）' },
  { id: 'host-contract', kind: 'required', args: ['.p1-baseline/test-host-contract.mjs'], why: '冻结契约 ↔ 代码/文档/边界/旧库一致（1.22.0）' },
  { id: 'plugin-tools', kind: 'required', args: ['.p1-baseline/verify-plugin-tools.mjs'], why: '插件工具面/版本/端点 + Harness 通道阶段参数（路由输入级）+ 预设事实限制' },
  { id: 'preset-copy', kind: 'required', args: ['.p1-baseline/verify-preset-copy.mjs'], why: '部署拷贝核对：活跃通道是否指向仓库（无副本漂移）' },
  { id: 'fixture-regen', kind: 'required', args: ['scripts/materialize-narrative-fixtures.mjs', '叙事性专项修复.md'], why: '冻结样本可复算（导出后由专项套件复核 hash 与六组重建）' },
  { id: 'phase-map', kind: 'informational', args: ['.p1-baseline/verify-phase-map.mjs'], why: '提交前的 phase-map 登记门禁（本轮不提交；未登记属预期，需在提交前处理）' },
];

const parseCounts = (text) => {
  const out = { passed: null, failed: null, skipped: null, checks: null };
  const patterns = [
    /通过\s*(\d+)\s*[\/／]\s*未通过\s*(\d+)/,
    /通过\s*(\d+)\s*[\/／]\s*失败\s*(\d+)/,
    /(\d+)\s*PASS\s*[/／]\s*(\d+)\s*FAIL/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) { out.passed = Number(m[1]); out.failed = Number(m[2]); break; }
  }
  const checks = /通过\s*(\d+)\s*[\/／]\s*未通过\s*(\d+)\s*（共\s*(\d+)\s*条/.exec(text);
  if (checks) out.checks = Number(checks[3]);
  const skip = /跳过\s*(\d+)/.exec(text);
  if (skip) out.skipped = Number(skip[1]);
  return out;
};

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const rows = [];
for (const c of COMMANDS) {
  if (only && c.id !== only) continue;
  const startedAt = new Date().toISOString();
  const logPath = path.join(LOG_DIR, `e07-${c.id}.log`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, c.args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const stdout = String(res.stdout || '');
  const stderr = String(res.stderr || '');
  const text = `${stdout}\n${stderr}`;
  fs.writeFileSync(logPath, `$ node ${c.args.join(' ')}\n# cwd: ${REPO}\n# started: ${startedAt}\n\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`, 'utf8');
  const counts = parseCounts(text);
  const code = res.status === null ? -1 : res.status;
  rows.push({
    id: c.id, kind: c.kind, cmd: `node ${c.args.join(' ')}`, cwd: REPO,
    started_at: startedAt, ms, exit_code: code,
    passed: counts.passed, failed: counts.failed, skipped: counts.skipped, checks: counts.checks,
    log: path.relative(REPO, logPath).replace(/\\/g, '/'),
    why: c.why,
    verdict: code === 0 ? 'pass' : (c.kind === 'informational' ? 'noted' : 'fail'),
    tail: text.trim().split('\n').slice(-3).join(' ⏎ ').slice(0, 300),
  });
}

const required = rows.filter((r) => r.kind === 'required');
const failedRequired = required.filter((r) => r.exit_code !== 0);
const manifest = {
  task_id: 'narrative-repair-e07',
  generated_at: new Date().toISOString(),
  host: `${os.platform()} ${os.release()} / node ${process.version}`,
  repo: REPO,
  base_commit: (() => { const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }); return String(r.stdout || '').trim(); })(),
  worktree_dirty: (() => { const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }); return String(r.stdout || '').trim().split('\n').filter(Boolean).length; })(),
  paid_calls: 0,
  paid_evaluation: 'SKIPPED: paid_evaluation_not_authorized',
  generation_experiment: 'SKIPPED: missing_frozen_blueprint',
  commands: rows,
  summary: {
    total: rows.length,
    required: required.length,
    required_passed: required.length - failedRequired.length,
    required_failed: failedRequired.length,
    informational: rows.length - required.length,
  },
};
fs.writeFileSync(OUT_JSON, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

if (!asJson) {
  console.log(`E07 验收运行（cwd=${REPO}，base_commit=${manifest.base_commit.slice(0, 10)}，未提交改动 ${manifest.worktree_dirty} 项）\n`);
  console.log('id'.padEnd(18) + 'kind'.padEnd(15) + 'exit'.padEnd(6) + '通过/失败'.padEnd(12) + '耗时'.padEnd(9) + '日志');
  for (const r of rows) {
    const counts = `${r.passed == null ? '-' : r.passed}/${r.failed == null ? '-' : r.failed}`;
    console.log(`${r.id.padEnd(18)}${r.kind.padEnd(15)}${String(r.exit_code).padEnd(6)}${counts.padEnd(12)}${(r.ms + 'ms').padEnd(9)}${r.log}`);
  }
  console.log(`\n必做命令 ${required.length} 条：通过 ${required.length - failedRequired.length} / 失败 ${failedRequired.length}`);
  for (const r of failedRequired) console.log(`  ✗ ${r.id}: ${r.tail}`);
  for (const r of rows.filter((x) => x.kind === 'informational')) console.log(`  ℹ ${r.id}（不阻断）：exit ${r.exit_code}｜${r.tail.slice(0, 120)}`);
  console.log(`\n付费调用：${manifest.paid_calls} 次｜${manifest.paid_evaluation}｜${manifest.generation_experiment}`);
  console.log(`清单：${path.relative(REPO, OUT_JSON).replace(/\\/g, '/')}`);
}
if (failedRequired.length) process.exit(1);
console.log(failedRequired.length === 0 ? '✓ 必做验收命令全部通过（按退出码判定）' : '');
