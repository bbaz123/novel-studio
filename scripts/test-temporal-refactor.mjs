#!/usr/bin/env node
/**
 * test-temporal-refactor.mjs —— 时态故事状态重构的**总测试入口**（零依赖、零计费）。
 *
 * 纪律：
 *   · 显式清单，不用跨平台不一致的 shell glob；清单为空 → 直接非零退出（不许"没找到测试"当成功）；
 *   · 逐个子套件以子进程执行，每个子套件用 tests/temporal/harness.mjs 自建临时数据目录——
 *     绝不触碰真实 data/；
 *   · 只信退出码；失败继续跑完，最后汇总并返回非零。
 *
 * 用法：node scripts/test-temporal-refactor.mjs [--only 02]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 显式清单：新增 temporal 测试必须登记在这里（并同步 .p1-baseline/verify-phase-map.mjs）。 */
export const TEMPORAL_TESTS = [
  'tests/temporal/01-pure.test.mjs',
  'tests/temporal/02-history.test.mjs',
  'tests/temporal/03-integrity.test.mjs',
  'tests/temporal/05-save-pipeline.test.mjs',
  // 06 自托管隔离实例 + 本机假模型（零计费）：保存入口生产接线证据，离线即可跑。
  'tests/temporal/06-http-save-entries.test.mjs',
  // 07 提案输入绑定 / 服务端复核 / 一次性审批边界 / 兼容投影（自托管隔离实例，零计费）。
  'tests/temporal/07-proposal-binding.test.mjs',
  // 08 T3 全下游失效 / 隐性因果夹具 A–E / 变异对照（进程内真实服务 + 临时隔离库，零计费零生成）。
  'tests/temporal/08-impact-analysis.test.mjs',
  // 09 T3 HTTP 生产接线：作者更正后自动触发 analyze 运行、GET/POST impact、模型侧 403、未开启作品零写入。
  'tests/temporal/09-impact-http.test.mjs',
  // 10 T4 逐章重建（进程内）：AC-15..27 模块级 + 任务书 §8.5 注入（取消/回滚/审批失败/旧 worker/fencing/恢复/用户中途编辑）。
  'tests/temporal/10-repair-runner.test.mjs',
  // 11 T4 HTTP 生产接线：审批绑定 / start 后台驱动 / ready_gate / apply 原子切换 + 版本备份 / revert / 幂等 / 模型侧 403。
  'tests/temporal/11-repair-http.test.mjs',
  // 12 T5 上下文时态边界：同 cursor 统一装配（章前/章后 / 视角 POV / 工具过滤 / 未启用逐字节不变）。
  'tests/temporal/12-context-temporal.test.mjs',
  // 13 T5 缓存不串线：外部版本串含时态版本；进程外推进可失效缓存；未确认新稿的旧索引被拦（unconfirmed_index）。
  'tests/temporal/13-context-cache.test.mjs',
  // 14 T7 存量迁移与 bootstrap（进程内）：迁移门禁 / 逐章按序 / 事后重建出处 / 未确认不回填（零计费）。
  'tests/temporal/14-backfill-migration.test.mjs',
  // 15 T7 HTTP 生产接线：enable_scope 预算 / step→confirm 可信前缀 / bootstrap 候选确认与拒绝 / 模型侧 403。
  'tests/temporal/15-backfill-http.test.mjs',
  // 16 T8/AC-46 日志与运行追踪卫生：正文/样文/API key/完整 prompt 不落盘；失败诊断（分析失败/审批拒绝/AI 错误）可见。
  'tests/temporal/16-log-hygiene.test.mjs',
];
// 04 需要外部活实例（本轮起在 ci-isolated-run 里跑）：node scripts/ci-isolated-run.mjs --port 3756 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3756
export const TEMPORAL_HTTP_TEST = 'tests/temporal/04-http.test.mjs';
const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();

const base = (() => { const i = process.argv.indexOf('--base'); return i >= 0 ? process.argv[i + 1] : ''; })();

const httpSelected = !!base && (!only || TEMPORAL_HTTP_TEST.includes(only));
const list = (only ? TEMPORAL_TESTS.filter((f) => f.includes(only)) : TEMPORAL_TESTS)
  .map((rel) => ({ rel, args: [] }))
  .concat(httpSelected ? [{ rel: TEMPORAL_HTTP_TEST, args: ['--base', base] }] : []);
if (!base) {
  console.log(`– ${TEMPORAL_HTTP_TEST}（需要活实例，未计入本清单：node scripts/ci-isolated-run.mjs --port 3756 -- node ${TEMPORAL_HTTP_TEST} --base http://127.0.0.1:3756）`);
}
if (!TEMPORAL_TESTS.length) {
  console.error('✗ temporal 测试清单为空：拒绝把"没有测试"当作通过。');
  process.exit(2);
}
if (!list.length) {
  console.error(`✗ --only ${only} 没有匹配任何 temporal 测试。`);
  process.exit(2);
}
const results = [];
for (const { rel, args } of list) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [rel, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NOVELSTUDIO_OV_DISABLED: '1' },
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ rel, ok, ms });
  const summary = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  console.log(`${ok ? '✓' : '✗'} ${rel}（${ms}ms）`);
  if (!ok) {
    const lines = (r.stdout || '').split(/\r?\n/).filter((l) => l.includes('FAIL') || l.startsWith('----')).slice(0, 6);
    for (const l of lines) console.log(`    └ ${l.trim().slice(0, 220)}`);
    const err = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' | ');
    if (err) console.log(`    └ stderr: ${err.slice(0, 400)}`);
  } else if (summary) {
    console.log(`    └ ${summary}`);
  }
}
const bad = results.filter((r) => !r.ok);
console.log(`\ntemporal 合计：通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 个子套件，零计费）`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.rel).join('; '));
process.exitCode = bad.length ? 1 : 0;
