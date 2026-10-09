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
  { name: '模型侧写入边界（非法 action / 组合 / 未知字段，含阴性对照）', cmd: ['.p1-baseline/test-agent-write-boundary.mjs'], why: '未知动作不得落入写入；审批边界的前置' },
  { name: '作者审批执行边界（HTTP 隔离实例：单次消费/过期/撤销/基线/跨书/事务原子）', cmd: ['.p1-baseline/test-approval-boundary.mjs'], why: '模型侧写入必须有可校验的授权边界' },
  { name: '整次采纳原子边界（HTTP 隔离实例：单事务/幂等键/回滚/outbox 恢复）', cmd: ['.p1-baseline/test-adopt-atomic.mjs'], why: '正文+提案+投影必须同生共死' },
  { name: 'OV 召回来源边界（HTTP 隔离实例 + 本地 OV stub：跨书/未来章/候选/rebuild 范围证明）', cmd: ['.p1-baseline/test-ov-recall-boundary.mjs'], why: '召回内容进上下文前必须证明来源，破坏性操作必须证明范围' },
  { name: '运行时上下文贡献记录（隔离实例 + OV stub：结构可审计/来源感知去重/默认行为不变）', cmd: ['.p1-baseline/test-context-contributions.mjs'], why: '最终请求里有什么、为什么有、占多少必须可核对' },
  { name: '编辑规则（隔离实例：规则进请求/关闭不进/题材门控/模型侧只读/确定性扫描）', cmd: ['.p1-baseline/test-editing-rules.mjs'], why: '三档编辑与七项能力必须有真实请求证据，不能只看开关' },
  { name: '叙事结构判据（真实两版正文：正例 / 负例 / 静默姿态）', cmd: ['.p1-baseline/probe-story-shape-20261008.mjs'], why: '叙事结构判据必须在作者真实语料上取证：正例要响、负例与静默姿态要不响，三类缺一不可（只跑负例证明不了规则是活的）' },
  { name: '修稿安全门禁事实锁（正例 / 负例 / 门禁姿态）', cmd: ['.p1-baseline/probe-fact-lock-20261008.mjs'], why: '编号撞号与单点改名必须硬拦，同时不得误拦合法补丁（底稿自带矛盾不拦、无人物卡时判据静默）' },
  { name: '第四批确定性判据（作者真实两版正文）', cmd: ['.p1-baseline/probe-scan-round4-20261008.mjs'], why: '跨 ≥3 段重复 / 编号冲突 / 百分比合计 / 转场桥不得在真实文本上误报或漏报' },
  { name: '长正文分段（计划/覆盖清单/断点续跑/越界拒绝，零计费）', cmd: ['.p1-baseline/test-long-text.mjs'], why: '整章目标正文不得被 slice，且必须能证明处理完整' },
  { name: '作者样文/文风档案/三级意图（隔离实例：上限/过期/证据预算/冲突呈现/模型侧只读/不进事实）', cmd: ['.p1-baseline/test-author-style.mjs'], why: '样文是风格证据，绝不能变成本书事实' },
  { name: '披露派生视图（隔离实例：分层/角色知识边界/时点/回滚/指纹，零计费）', cmd: ['.p1-baseline/test-disclosure.mjs'], why: '读者知道什么必须按角色与时点重算，不能笼统外推' },
  { name: '剧情分支沙盘（隔离实例：候选形状/差异判据/知识边界/采纳只写蓝图/stale 复核/取消恢复，零计费）', cmd: ['.p1-baseline/test-branch-sandbox.mjs'], why: '候选不是本书事实：未采纳不得进正典，重新采纳必须先复核' },
  { name: '导入安全隔离（隔离实例：TXT/MD/EPUB 基线不倒退 + 路径穿越/symlink/压缩炸弹/编码/上限安全失败 + 零半导入 + 传输层 413 可见，零计费）', cmd: ['.p1-baseline/test-import-guard.mjs'], why: '导入文件是不可信输入：先校验后写入，失败不得留下半导入状态' },
  { name: '导入后重建（隔离实例：分批规划/批次基线/断点续跑或重试/候选不落正式状态/确认按批原子/只读 SQLite 阴性对照，零计费）', cmd: ['.p1-baseline/test-import-rebuild.mjs'], why: '重建结果先是候选；确认必须是作者动作且按批原子，不留半套状态' },
  { name: '共享资料库导入链（隔离实例 + OV stub：扫描/计划/开关/dry-run→confirm/幂等/查回/删除/总闸关闭，零计费）', cmd: ['.p1-baseline/test-library-import.mjs'], why: '资料是共享资料而非本书事实：导入必须先计划后确认，模型侧不可写' },
  { name: '检索计划（离线单测：确定性/有界/白名单拒绝/分批先汇总后装配/失败隔离/缓存键含索引 schema 版本/两类计数分开，零计费）', cmd: ['.p1-baseline/test-retrieval-plan.mjs'], why: '计划只准备 buildNovelContext 的输入：先汇总后装配，不得并行直塞；索引查询次数与资料召回次数不得混算' },
  { name: '方向驱动检索集成（隔离实例 + OV stub：A–F 全链路：默认零召回 / defer 不查 / 方向单次召回 / 索引版本驱动缓存失效 / 计划不改装配 / 两组计数分离，零计费）', cmd: ['.p1-baseline/test-direction-retrieval.mjs'], why: '缓存键必须含方向 hash 与索引版本；E 不得绕过唯一装配；C 与 D/E 的计数分开计' },
  { name: '资料索引单测（离线：候选最相关优先 / 截断在排序之后 / 上限有界 / 词法分数方向 / sha 增量与跳过 / 重建幂等 / 空查询状态码，零计费）', cmd: ['.p1-baseline/test-library-index.mjs'], why: '「先廉价缩小候选」的排序方向与截断顺序必须可离线复现：LIMIT 先于排序、分数方向写反这类缺陷不会让集成测试变红' },
  { name: '迁移幂等与损坏库（空库建表 73 张 / 重复启动不漂移不丢行 / 旧库只读指纹 / 损坏库响亮失败不篡改原文件，零计费）', cmd: ['.p1-baseline/test-migration-idempotent.mjs'], why: '新 migration 必须在空库、重复启动与失败场景下都正确' },
  { name: 'Host Contract 契约测试（代码↔契约 / 文档↔契约 / 边界 / 旧库兼容）', cmd: ['.p1-baseline/test-host-contract.mjs'], why: '冻结的宿主契约不得漂移' },
  { name: '时态故事状态重构总入口（离线：reducer/原子归约/章序/历史隔离/完整性/保存接线（自托管隔离实例 + 本机假模型）/未启用零写入，零计费）', cmd: ['scripts/test-temporal-refactor.mjs'], why: 'T1–T8 的统一状态底座：清单为空或任一子套件失败必须非零退出；保存入口接线证据不许用 mock 冒充（06 走真实 HTTP + 真实后台调度，模型端点指向本机假模型）' },
  { name: '叙事性专项修复总入口（离线：补丁协议 v2 的 P/E02/R 类 + 冻结样本 + 2026-10-09 审查回归，零计费）', cmd: ['scripts/test-narrative-repair.mjs'], why: '《叙事性专项修复》E01/E02 与审查修复的判定面：显式删除、精确跨度、按段落级门禁、schema 严格性、组合门禁、越权与 stale、阶段化规则、协议模块缺失姿态，都必须在离线可复现；清单为空必须非零退出' },
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
