#!/usr/bin/env node
/**
 * ci-offline-checks.mjs —— CI 用的**离线**检查清单（唯一来源）。
 *
 * 为什么要有这个文件：这些命令本来散在 `.p1-baseline/verify-all.mjs` 的调用点里，
 * 而 verify-all 里**大部分检查需要活实例或作者私有数据**（真实库、压力数据、基线 JSON），
 * 那些东西在 CI 里不存在，也不该存在。如果把这些命令直接抄进 workflow 的 YAML，
 * 两个清单会各改各的、必然腐烂。所以这里只列**确实不需要私有数据**的那一批，
 * 由 workflow 与本地 `node scripts/ci-offline-checks.mjs` 共用。
 *
 * 纪律（与 verify-all 一致）：
 *   - 只信退出码，不信输出文案；
 *   - 逐条打印耗时，失败继续跑完（一次看清全部红灯，而不是改一条跑一次）；
 *   - 需要活实例的检查**不在这里**（它们是 `scripts/ci-isolated-run.mjs` 的活）；
 *   - 本清单**不含任何会调用真实 LLM 的检查**（零计费）。
 *
 * 用法:
 *   node scripts/ci-offline-checks.mjs
 *   node scripts/ci-offline-checks.mjs --only 上下文   # 只跑名字含该子串的检查
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{name: string, cmd: string[], why: string}[]} */
export const CHECKS = [
  { name: '装配器单元测试（边界与溢出分支）', cmd: ['.p1-baseline/test-assembler.mjs'], why: '上下文装配的唯一入口' },
  { name: '上下文清单/完整性/溯源（含阴性对照）', cmd: ['.p1-baseline/test-context-manifest.mjs'], why: '清单必须与真实发送的上下文一致' },
  { name: '记忆压缩提示词输入（含阴性对照）', cmd: ['.p1-baseline/test-memory-compress-prompt.mjs'], why: '压缩输入不得只剩标题' },
  { name: '记忆压缩零损失护栏', cmd: ['.p1-baseline/test-memory-compress-guard.mjs'], why: '实体覆盖率下限' },
  { name: '模型自压缩的零损失护栏', cmd: ['.p1-baseline/test-agent-memory-guard.mjs'], why: '人设/工具描述同源' },
  { name: '确定性连续性预检（真值表 + 阴性对照）', cmd: ['.p1-baseline/test-continuity-guard.mjs'], why: '机器能判的部分先算掉' },
  { name: '每任务独立默认模型（吞吐回到 2 的前提）', cmd: ['.p1-baseline/test-task-settings.mjs'], why: 'dsh 0.1.7 的补丁层语义' },
  { name: '常驻热备池（协议 + 池策略，注入假 dsh）', cmd: ['.p1-baseline/test-harness-pool.mjs'], why: '冷启动重叠' },
  { name: 'dsh 启动路径（预构建优先 + 防陈旧）', cmd: ['.p1-baseline/test-dsh-launch.mjs'], why: '启动耗时与正确性' },
  { name: '编辑距离离线测试', cmd: ['.p1-baseline/test-edit-distance.mjs'], why: '记忆采纳效果度量' },
  { name: '召回缺口不得静默', cmd: ['.p1-baseline/test-recall-gap.mjs'], why: '缺口要显式占位' },
  { name: '同步闸门（在途同步 vs 移除的竞态）', cmd: ['.p1-baseline/test-sync-gate.mjs'], why: '孤儿记忆目录' },
  { name: '上下文缓存按外部状态失效', cmd: ['.p1-baseline/test-context-cache.mjs'], why: '缓存不得给出陈旧上下文' },
  { name: '模型档位·强度补偿·长任务超时', cmd: ['.p1-baseline/test-policy-tiers.mjs'], why: '策略单点' },
  { name: '模型切换互斥语义', cmd: ['.p1-baseline/test-model-switch-gate.mjs'], why: '决定实际吞吐 1 还是 2' },
  { name: '闸门断言离线阴性对照', cmd: ['.p1-baseline/test-gate-assert.mjs'], why: '隔离断言本身要能被验证' },
  { name: 'harness 子进程环境契约（隔离实例不得回落 3737）', cmd: ['.p1-baseline/test-harness-env.mjs'], why: '测试不得打到作者实例' },
  { name: '查回路径静态核对（每层声明 + 工具真实存在）', cmd: ['.p1-baseline/verify-retrieval-map.mjs'], why: '凡裁剪必可查回' },
  { name: '层规格常量单点核对', cmd: ['.p1-baseline/verify-layer-constants.mjs'], why: '常量不得各写一份' },
  { name: 'AI 全分支核对（0 处绕过策略）', cmd: ['.p1-baseline/verify-ai-branches.mjs'], why: '路由必须走策略表' },
  { name: '命名任务的作业接线（静态）', cmd: ['.p1-baseline/verify-named-jobs.mjs'], why: '进度/取消/落库' },
  { name: '自动压缩开关（默认关闭，"不打开不花钱"）', cmd: ['.p1-baseline/verify-auto-compress.mjs'], why: '默认行为不得悄悄改' },
  { name: '插件工具面与版本一致', cmd: ['.p1-baseline/verify-plugin-tools.mjs'], why: '插件契约' },
  { name: 'Host Contract 契约测试（代码↔契约 / 文档↔契约 / 边界 / 旧库兼容）', cmd: ['.p1-baseline/test-host-contract.mjs'], why: '冻结的宿主契约不得漂移' },
  { name: '编码检查判据自检（含阴性对照）', cmd: ['.p1-baseline/check-utf8.mjs', '--self-test'], why: '中文仓库的编码纪律' },
  { name: '日志差集归因判据自检', cmd: ['.p1-baseline/diff-log-noise.mjs', '--self-test'], why: '正常增长不得判红' },
  { name: '花钱总闸归属判据自检（本地假端点自证 / 未归属判红）', cmd: ['.p1-baseline/audit-llm-calls.mjs', '--self-test'], why: '零计费探针不得被误判成花钱，未归属的调用不得放过' },
  { name: '回滚矩阵工具自检', cmd: ['.p1-baseline/revert-matrix.mjs', '--self-test'], why: '认得出冲突才算可用' },
  { name: 'P6 切换器离线测试', cmd: ['.p6-cutover/test-cutover.mjs'], why: '锚点对账 + 幂等' },
  { name: '全量快照工具离线测试', cmd: ['.p6-cutover/test-snapshot.mjs'], why: '快照自洽' },
  // ⚠️ 阶段映射核对**故意不在这里**（实测证据，2026-09-24）：它的判据是「相对基线的改动集」，
  // 而 CI 的检出要么是合并后的树（改动集为空）、要么没有 origin/main 可比（退回 HEAD），
  // 于是全仓改动集=0 → 推导出的回滚档全变 independent，与声明的 shared 冲突 → 恒红 7 条。
  // 它是**提交前**的核对工具（需要「未提交的工作区」这个前提），跑在 verify-all 与本地流程里。
  { name: '前端执行验证（vm + DOM 桩）', cmd: ['frontend-test.mjs'], why: '界面契约' },
  { name: '工具与环境配置链（OpenViking 凭证 / dsh 仓库 / 全局写入）', cmd: ['env-tools-test.mjs'], why: '环境自检卡' },
];

const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
const list = only ? CHECKS.filter((c) => c.name.includes(only)) : CHECKS;

const results = [];
for (const c of list) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, c.cmd, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ ...c, ok, ms });
  const tail = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  console.log(`${ok ? '✓' : '✗'} ${c.name}（${ms}ms）`);
  if (!ok) {
    console.log(`    └ ${tail.slice(0, 200)}`);
    const err = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' | ');
    if (err) console.log(`    └ stderr: ${err.slice(0, 300)}`);
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n合计：通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 条，零计费）`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.name).join('; '));
process.exitCode = bad.length ? 1 : 0;