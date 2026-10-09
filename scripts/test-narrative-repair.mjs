#!/usr/bin/env node
/**
 * test-narrative-repair.mjs —— 《叙事性专项修复》专项套件的**总入口**（零依赖、零计费）。
 *
 * 纪律（与 scripts/test-temporal-refactor.mjs 一致）：
 *   · 显式清单，不用跨平台不一致的 shell glob；
 *   · 每个子套件以子进程执行，只信退出码；失败继续跑完，最后一次看清全部红灯；
 *   · 清单为空、或 `--only` 匹配到零个用例 → **非零退出**（不许把"没找到测试"当成功）；
 *   · 不连真实模型、不读生产密钥、不触碰真实作品数据（只读 tests/narrative-repair/fixtures）。
 *
 * 用法：node scripts/test-narrative-repair.mjs [--only 01]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 显式清单：新增叙事专项套件必须登记在这里（并同步进 scripts/ci-offline-checks.mjs）。 */
export const NARRATIVE_REPAIR_TESTS = [
  // P 类：局部补丁协议 v2（P01—P09、P14 的模块级判定面）
  'tests/narrative-repair/01-patch-protocol.test.mjs',
  // R 类：冻结样本与来源标签（R01 / R12）
  'tests/narrative-repair/02-fixtures.test.mjs',
  // E02：阶段化规则编译（同一能力在不同阶段注入不同内容；审计摘要可核对）
  'tests/narrative-repair/03-stage-rules.test.mjs',
  // E04：叙事诊断的确定性候选层 + 审稿协议层（引用核验 / 反证要求 / 保护分区；正例与阴性对照）
  'tests/narrative-repair/04-narrative-scan.test.mjs',
  // E05：受约束的局部编辑计划（热点/授权跨度/不变量/依赖组/预算；不自动扩大、勾选变更即作废）
  'tests/narrative-repair/05-revision-plan.test.mjs',
  // E06：可解释报告的确定性部分（单独撤销 / 相对结论必须先读 diff / 开关默认关闭）
  'tests/narrative-repair/06-report.test.mjs',
  // E03：审稿报告结构化与引用核验（逐字定位 / 重复引用拒收 / 反证降级 / 旧口径不变）
  'tests/narrative-repair/07-review-structure.test.mjs',
];

const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
if (!NARRATIVE_REPAIR_TESTS.length) {
  console.error('✗ 叙事专项测试清单为空：拒绝把"没有测试"当作通过。');
  process.exit(2);
}
const list = only ? NARRATIVE_REPAIR_TESTS.filter((f) => f.includes(only)) : NARRATIVE_REPAIR_TESTS;
if (!list.length) {
  console.error(`✗ --only ${only} 没有匹配任何叙事专项测试。`);
  process.exit(2);
}

const results = [];
for (const rel of list) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [rel], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const out = String(r.stdout || '');
  const summary = (out.split(/\r?\n/).filter((l) => l.includes('通过') && l.includes('未通过')).pop() || '').trim();
  const ok = r.status === 0;
  results.push({ rel, ok, ms, summary });
  console.log(`${ok ? '✓' : '✗'} ${rel}（${ms}ms）${summary ? ` ${summary}` : ''}`);
  if (!ok) {
    out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 10).forEach((l) => console.log(`    └ ${l.trim()}`));
    const err = String(r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' | ');
    if (err) console.log(`    └ stderr: ${err.slice(0, 300)}`);
  }
}
const bad = results.filter((r) => !r.ok);
console.log(`\n合计：通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 个套件，零计费）`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.rel).join('; '));
process.exitCode = bad.length ? 1 : 0;
