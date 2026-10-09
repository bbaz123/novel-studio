#!/usr/bin/env node
/**
 * verify-phase-map.mjs —— 「哪个阶段改了哪些文件、怎么独立回滚」的**可核对映射**。
 *
 * 为什么需要：目标里写着「每阶段独立验收与回滚」，但此前只有一个整体快照——
 * 没人能回答「我只想撤回 P3，要动哪里」。而手写的阶段清单**必然腐烂**（源码一改就对不上）。
 * 所以这里让映射与检查**同源**：
 *   - 阶段数据写在本文件里（唯一来源）；
 *   - `docs/phase-map.md` 由它**生成**，不手写；
 *   - 每次运行都拿真实改动集对账，出现「没归属的改动」即失败。
 *
 * 三条判据：
 *   1. **完整性**：真实改动集里每个文件都必须被某个阶段认领（否则没人知道怎么回滚它）；
 *   2. **存在性**：映射里提到的路径/证据必须真的存在（防止清单指向空气）；
 *   3. **可回滚性**：每个阶段都要标注回滚方式，并说明是否**可独立回滚**。
 *
 * 用法:
 *   node .p1-baseline/verify-phase-map.mjs            # 只校验（含与 docs/phase-map.md 对账）
 *   node .p1-baseline/verify-phase-map.mjs --write     # 重新生成文档
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isExcluded } from '../.p6-cutover/snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const DOC = path.join(REPO, 'docs', 'phase-map.md');

/**
 * 阶段 → 改动面。`files` 支持：精确路径、`目录/` 前缀、以及末段 `*` 通配。
 * `rollback` 只有两种取值，因为这是事实而非愿望：
 *   - 'independent'：回滚只涉及新增模块与少量挂钩点，可以单独撤回；
 *   - 'shared'：与其它阶段共用同一文件（改在同一批函数里），只能整体回滚。
 */
export const PHASES = [
  {
    id: 'P0',
    title: '专用 dsh profile（novel）与插件 bundle 化',
    files: [
      'harness-plugins/novel-writing/',
      '.p0-recon/',
      'harness.js',
    ],
    evidence: [
      '.p0-recon/README.md', '.p0-recon/verify-harness-profile.mjs',
      '.p0-recon/compare-composed.mjs', '.p0-recon/novel.p3.txt',
      '.p0-recon/capture-dsh-request.mjs',
    ],
    rollback: 'shared',
    note: 'harness.js 同时被 P4/P6 改过；profile 本身的回滚是卸掉 novel profile 与 bundle 接线（install-profile.mjs 反向操作）。',
  },
  {
    id: 'P1',
    title: '冻结上下文契约 + 基线 + 压力数据',
    files: [
      'ai/context/layers.mjs',
      'docs/context-contract.md',
      '.p1-baseline/context-floor.mjs',
      '.p1-baseline/capture-baseline.mjs',
      '.p1-baseline/compare-baseline.mjs',
      '.p1-baseline/make-stress.mjs',
      '.p1-baseline/survey.mjs',
      '.p1-baseline/schema-dump.mjs',
      // 精确到具体探测脚本，不再用 `probe-*.mjs` 整片通配——
      // 那会把 probe-live.mjs 也吞进来，与 X 的认领重叠，污染回滚判定（推导器立刻报出来了）。
      '.p1-baseline/probe-recall.mjs',
      '.p1-baseline/probe-recall-direct.mjs',
      '.p1-baseline/probe-recall-query.mjs',
      '.p1-baseline/probe-ov-find.mjs',
      '.p1-baseline/probe-ov-recall-chain.mjs',
      '.p1-baseline/probe-retrieval.mjs',
    ],
    evidence: [
      'docs/context-contract.md', '.p1-baseline/README.md',
      '.p1-baseline/context-floor.mjs', '.p1-baseline/make-stress.mjs',
    ],
    note: '层规格是新增模块；但**不能单独撤回**——装配器（P2）与 server.js 都 import 它，撤掉会当场打断它们。',
  },
  {
    id: 'P2',
    title: '唯一上下文装配器（预算自动核算 + 裁剪清单）',
    files: [
      'ai/context/assembler.mjs',
      'server.js',
      '.p1-baseline/verify-invariants.mjs',
      '.p1-baseline/verify-p3-unified.mjs',
      '.p1-baseline/test-assembler.mjs',
      'docs/p2-assembler-verification.md',
      'docs/ai-core.md',
    ],
    evidence: [
      'docs/p2-assembler-verification.md', 'docs/ai-core.md',
      '.p1-baseline/verify-invariants.mjs', '.p1-baseline/test-assembler.mjs',
    ],
    rollback: 'shared',
    note: '改动集中在 server.js 的 buildNovelContext 与路由；与 P3/P4/P5 同处一个大文件，**无法只撤 P2**。',
  },
  {
    id: 'P3',
    title: '检索覆盖面 + 凡裁剪必可查回（I4）',
    files: [
      '.p1-baseline/verify-retrieval.mjs',
      '.p1-baseline/verify-plugin-tools.mjs',
      'docs/p3-retrieval-verification.md',
      'public/app.js',
      // P3 的检索桶加在 server.js 的 search() 里——早先漏记，会让"改动面"失真。
      'server.js',
    ],
    evidence: [
      'docs/p3-retrieval-verification.md',
      '.p1-baseline/verify-retrieval.mjs', '.p1-baseline/verify-plugin-tools.mjs',
    ],
    rollback: 'shared',
    note: '检索桶加在 server.js 的 search()、查回路径在 layers.mjs 的 RETRIEVAL；分别与 P2/P5 共享文件。',
  },
  {
    id: 'P4',
    title: '通道收敛 + 单点策略表',
    files: [
      'ai/policy.mjs',
      '.p1-baseline/verify-ai-branches.mjs',
      '.p1-baseline/test-model-switch-gate.mjs',
      'docs/p4-policy-verification.md',
      // ⚠️ 早先漏了这两个：P4 同时改了前端（策略取值）与 server.js（策略端点 + 并发闸门）。
      // 漏记会让"改动面"清单失真，也会让回滚判定偏乐观（推导器一跑就露）。
      'public/app.js',
      'server.js',
    ],
    evidence: [
      'docs/p4-policy-verification.md', 'ai/policy.mjs',
      '.p1-baseline/verify-ai-branches.mjs', '.p1-baseline/test-model-switch-gate.mjs',
    ],
    note: '策略单点化本身可撤（恢复各处字面量），但 ai/policy.mjs 被 harness.js 与 server.js import，'
      + '前端与 server.js 又被 P3/P5 共同修改 → 无法只撤 P4。',
  },
  {
    id: 'P5',
    title: '记忆语义压缩 + 效果埋点',
    files: [
      'ai/edit-distance.mjs',
      'db.js',
      '.p1-baseline/test-edit-distance.mjs',
      '.p1-baseline/verify-eval-metric.mjs',
      'docs/p5-memory-eval-verification.md',
      // ⚠️ 同 P4：P5 的埋点挂钩也在前端与 server.js 里（漏记过）。
      'public/app.js',
      'server.js',
    ],
    evidence: [
      'docs/p5-memory-eval-verification.md', 'ai/edit-distance.mjs',
      '.p1-baseline/test-edit-distance.mjs', '.p1-baseline/verify-eval-metric.mjs',
    ],
    note: '建表是增量迁移（向后兼容），但埋点挂钩落在 server.js 与 public/app.js（与 P3/P4 共享），'
      + 'ai/edit-distance.mjs 还被 server.js import → 无法只撤 P5。',
  },
  {
    id: 'P6',
    title: '一次性切换（工具就绪，**未执行**）',
    files: [
      '.p6-cutover/',
      'docs/p6-cutover-runbook.md',
      'docs/self-review-p0-p6.md',
      'ai/harness-env.mjs',
    ],
    evidence: [
      '.p6-cutover/cutover.mjs', '.p6-cutover/snapshot.mjs', '.p6-cutover/smoke.mjs',
      '.p6-cutover/README.md', 'docs/p6-cutover-runbook.md',
    ],
    note: '切换器与快照工具本身是自足的、可单独移除；但 P6 还含 ai/harness-env.mjs，'
      + '而它被 harness.js 与 .p1-baseline/test-harness-env.mjs import → 整段仍无法单独撤回。'
      + ' harness.js 的默认 profile 仍是 headless（未切换）。',
  },
  {
    id: 'D8',
    title: '不足清单修复（D8-#1…#8）',
    files: [
      // 这一条是 D8 独有的生产文件：`openviking-sync.js` 此前不属于任何阶段。
      'openviking-sync.js',
      'ai/sync-gate.mjs',
      'ai/context/cache.mjs',
      '.p1-baseline/exp-per-task-settings.mjs',
      '.p1-baseline/test-recall-gap.mjs',
      '.p1-baseline/test-sync-gate.mjs',
      '.p1-baseline/test-context-cache.mjs',
      // D8-#1：回滚矩阵（实测哪些提交能单独 revert；自带阴性对照）
      '.p1-baseline/revert-matrix.mjs',
      // D8-#7 的补证探针：确认外部信号 ov_indexed_at 在真实库里确实有值
      '.p1-baseline/probe-ov-indexed-at.mjs',
      // D8-#2：每任务独立 settings 的内核模块与两条证据（离线单测 + 并发端到端实验）
      'ai/task-settings.mjs',
      '.p1-baseline/test-task-settings.mjs',
      '.p1-baseline/exp-concurrent-models.mjs',
      // D8-#8：质量信号哨兵（客观指标；只调端点不自己写 SQL）
      '.p1-baseline/quality-sentinel.mjs',
      // D8-#4：命名任务并入作业设施的验收（静态接线 + 活体三段：进度/取消/落库）
      '.p1-baseline/verify-named-jobs.mjs',
      // D8-#3：记忆压缩的零损失护栏（实体变体 + 覆盖率下限）与其探针
      'ai/memory-compress-guard.mjs',
      '.p1-baseline/test-memory-compress-guard.mjs',
      '.p1-baseline/probe-entity-variants.mjs',
      // D8-#3 续：用**已付费的真实产出**验证护栏改版（零成本）
      '.p1-baseline/verify-guard-on-real-output.mjs',
      // D8-#3：自动压缩开关的验收（含"不打开不花钱"的阴性对照）
      '.p1-baseline/verify-auto-compress.mjs',
      // D8-#3 续（2026-09-18）：**模型自压缩**也走同一零损失护栏。
      // 判据真值表 + 变异体对照 + 跨模块字面量契约；人设/工具描述的同步改动
      // 落在 P0 认领的插件文件里（所以那条路仍然只能整体回滚）。
      '.p1-baseline/test-agent-memory-guard.mjs',
      // D8-#8 后半：关键改动的人工盲测工具（花钱需显式确认）
      '.p1-baseline/blind-ab.mjs',
      // D7：孤儿记忆目录清理（干跑默认；--execute 需令牌；删前后对活目录逐文件哈希）
      '.p1-baseline/d7-purge-orphans.mjs',
      '.p1-baseline/probe-d7-and-cast.mjs',
      // D7 的留档证据：清单（删之前）与执行结果（删之后）。用通配认领，
      // 否则每跑一次都会多出一个"没人认领"的文件——阶段映射会立刻报出来。
      '.p1-baseline/d7-orphan-manifest-*.json',
      '.p1-baseline/d7-purge-result-*.json',
      // 决策 B：写作任务的专用 DSH_HOME（安装器 + 执行记录）
      '.p1-baseline/install-novel-home.mjs',
      '.p1-baseline/b-novel-home-*.json',
      // 判断他人改法时用的会话导出分析工具
      '.p1-baseline/extract-session-lines.mjs',
      '.p1-baseline/scan-session-keywords.mjs',
      '.p1-baseline/compare-runtime-trees.mjs',
      // 自审用：全库扫描非法 UTF-8（抓混编码损坏）
      '.p1-baseline/check-utf8.mjs',
      // 自审报告（本轮改动全量重审 + 犯错根因清单）
      'docs/self-review-2026-09-16.md',
    ],
    evidence: [
      '.p1-baseline/test-recall-gap.mjs', '.p1-baseline/test-sync-gate.mjs',
      '.p1-baseline/test-context-cache.mjs', '.p1-baseline/exp-per-task-settings.mjs',
      '.p1-baseline/revert-matrix.mjs',
    ],
    note: 'D8 是对"不足清单"的逐条修复，与 P0–P6 同处一批文件：server.js 已被 P2–P5 认领，'
      + 'ai/context/layers.mjs 属 P1，所以 D8 的代码同样**不能单独撤回**。'
      + ' 它独有认领的只有 openviking-sync.js（此前无人认领）与两个新内核模块。',
  },
  {
    id: 'X',
    title: '跨阶段：总纲与工具入口',
    files: [
      'README.md',
      'docs/README.md',
      'docs/phase-map.md',
      'docs/pending-decisions.md',
      'docs/final-acceptance-p0-p6.md',
      '.p1-baseline/README.md',
      '.p1-baseline/.gitignore',
      '.p1-baseline/verify-phase-map.mjs',
      'ai/README.md',
      'ai/context/README.md',
      '.p1-baseline/diff-real-db.mjs',
      '.p1-baseline/diff-log-noise.mjs',
      '.p1-baseline/incident-evidence-app-log-2026-09-15.md',
      '.p1-baseline/incident-evidence-app-log-2026-09-15.raw.txt',
      '.p1-baseline/census.mjs',
      '.p1-baseline/probe-live.mjs',
      '.p1-baseline/read-dsh-session.mjs',
      '.p1-baseline/audit-llm-calls.mjs',
      '.p1-baseline/blackhole.mjs',
      '.p1-baseline/gate-env.mjs',
      '.p1-baseline/verify-harness-gate.mjs',
      '.p1-baseline/test-gate-assert.mjs',
      '.p1-baseline/test-harness-env.mjs',
      '.p1-baseline/verify-memory-hint.mjs',
      '.p1-baseline/compare-memory-hint.mjs',
      '.p1-baseline/verify-retrieval-map.mjs',
      '.p1-baseline/verify-layer-constants.mjs',
      '.p1-baseline/verify-all.mjs',
      // 决策 D4（模型槽位可观测性）的验收工具。D4 的**代码**改动都落在
      // 已被 P0/P2–P5 认领的共享文件里（harness.js / server.js / public/app.js），
      // 所以这里只需认领新增的工具本身——与 D5 把事故证据归入 X 同一处理。
      '.p1-baseline/verify-model-slot.mjs',
      // 主实例重启后的对照检查（只读、零计费）：证明"代码提交了"≠"实例生效了"。
      '.p1-baseline/verify-main-instance.mjs',
      // 插件完全适配时**附带**修掉的"Node 门槛"一致性缺陷（上一轮列出但未处理）：
      // 启动器原本只比主版本 ≥22，而 node:sqlite 到 22.13 才免 --experimental-sqlite,
      // 于是 22.5~22.12 会**通过检查再崩在启动**。现在改为**直接探测能力**
      //（比任何数字比较都准，且不随版本表腐烂），engines 同步到 >=22.13.0。
      'package.json',
      'start-novel-studio.cmd',
      // 新手引导改造轮（ae53e73 / 9c2b423）：面向 GitHub 访客的入口文档与真实截图。
      // 它们此前一直没被认领——因为**中文文件名**曾被 git 八进制转义、匹配不上任何模式
      //（见上面 git() 里的 core.quotePath 修复），属于"清单漏记"而非"不该记"。
      'docs/新手入门.md',
      'assets/screenshot-writing.png',
    ],
    evidence: ['.p1-baseline/verify-all.mjs', '.p1-baseline/README.md', 'docs/README.md'],
    note: '验收工具与总纲；单独撤回只会让验收能力变弱，不影响线上行为——'
      + '但注意 X 内部彼此 import（verify-all ↔ 各工具），且被 .p0-recon 的线路层工具引用。',
  },
  {
    id: 'S',
    title: '2026-09-18 会话：模型统一 V4.1 Flash + 写作路径提速 + 环境自检接线',
    files: [
      // —— 模型/强度/超时的单点化：策略表本身已在 P4，这里认领它的**新证据与消费点** ——
      '.p1-baseline/test-policy-tiers.mjs',
      // —— 新手引导与「环境自检」卡的离线验收（OpenViking 凭证链 / dsh 仓库 / 全局配置写入）——
      'env-tools-test.mjs',
      // —— 新增的生产文件（此前不属于任何阶段）——
      'openviking.js',        // AI 设置页「OpenViking 记忆库」卡 + 与插件对齐的凭证链
      // —— 被本会话改过、且此前无人认领的既有文件 ——
      'logger.js',
      'debug-trace.js',
      'public/index.html',
      'public/styles.css',
      'frontend-test.mjs',
      'api-test-suite.mjs',
      'docs/CHANGELOG.md',
      // 四份历史报告被追加了「2026-09-18 变更注记」（模型口径以当前代码为准），
      // 注记本身是**留痕**，不是重写历史结论。
      'docs/agent-change-review-2026-09-13.md',
      'docs/context-memory-analysis-report.md',
      'docs/context-optimization-review-report.md',
      'docs/p4-policy-verification.md',
      // 本会话第四轮重审的报告（与 OpenViking 上的同名报告同源）
      'docs/self-review-2026-09-18.md',
      // —— 常驻 dsh 热备池：把每任务 ≈17–18 秒冷启动从"串行等待"改成"后台重叠" ——
      // 协议层与池策略刻意不 spawn、不碰文件系统，所以能注入**进程内假 dsh** 离线断言
      // （不需要 dsh、零成本）；变异锚点由同目录的 mutation-check 实际执行。
      'ai/harness-pool.mjs',
      '.p1-baseline/test-harness-pool.mjs',
      '.p1-baseline/mutation-check-harness-pool.mjs',
      // 零成本假 LLM 端点：黑洞端点只能证明"请求真的发出去了"，证明不了"任务能跑完"。
      // 这个会**真的回一个应答**，于是"常驻池端到端跑通"可以在零计费下被验收。
      '.p1-baseline/fake-llm.mjs',
      // 常驻运行时的接线件：profile 生成器（照 novel 派生，只换 bundles 里的一行）、
      // 真实子进程适配器（spawn + initialize 握手）、零计费端到端探测脚本。
      // ⚠️ 探测脚本当前**故意是红的**：它精确报出"本机 dsh 源码仓库（0.1.1-rc.2）没有
      // sdk-app bundle"——那不是脚本坏，而是"这个能力在当前 dsh 版本上不存在"的证据。
      '.p1-baseline/setup-novel-sdk-profile.mjs',
      'ai/harness-sdk-worker.mjs',
      '.p1-baseline/probe-sdk-runtime.mjs',
      // —— dsh 启动路径：**优先预构建产物**（本轮最大的单点提速）——
      // 源码仓库的 scripts.dsh 是 `node --import tsx/esm …`，每个任务现场转译一遍 TS；
      // 实测冷启动 12.6s → 用已构建的 apps/cli/lib/bin.js 只要 1.9s，而两条路径
      // `--dump-config` 逐字相同（398 行 0 差异）。产出：改 harness.js 的 resolveDshLaunch
      // + 两个纯函数判据（防"改了源码没重建"）+ 一条把对照实验做实的探测脚本。
      '.p1-baseline/probe-cold-start.mjs',
      '.p1-baseline/test-dsh-launch.mjs',
    ],
    evidence: [
      '.p1-baseline/test-policy-tiers.mjs',
      'env-tools-test.mjs',
      '.p1-baseline/test-harness-pool.mjs',
      '.p1-baseline/mutation-check-harness-pool.mjs',
      'docs/self-review-2026-09-18.md',
    ],
    rollback: 'shared',
    note: '本会话改动落在已被 P0–P6/D8 认领的共享文件里（server.js / public/app.js / harness.js / '
      + 'ai/policy.mjs / db.js），所以**不能单独回滚**：撤掉 openviking.js 会打断 server.js 的启动路径，'
      + '撤掉 logger.js/debug-trace.js 会打断全仓日志与追踪。完整回滚用改动前的快照'
      + '（data/backup-model-flash-*、data/backup-novice-guide-*、data/backup-batchD-*）。',
  },
  {
    id: 'T',
    title: '2026-09-19 轮：全仓代码审查与修复（Q1/Q2/Q4 + R1/R2 + O1/O2/C1/F1）',
    files: [
      // —— 本轮唯一"首次获得归属"的生产文件 ——
      // 此前它不属于任何阶段：EPUB/ZIP 解压一直**没有解压后大小上限**（只按压缩包字节数
      // 限制），而 deflate 的高压缩比能让小包解出超大内容。现在按中央目录的声明大小先拒绝
      // （单条目 128MB / 整包 256MB），inflate 另加 maxOutputLength，解压后再核一次实际长度。
      'zip-reader.mjs',
      // —— 本轮第 1 步的审查报告与 5 步总结 ——
      // 交付时由工作区根目录的 `C-第一次代码审查报告.md` / `C-代码审查总结.md` 原样归档进
      // docs/（正文未改，只补了文首归档注记与两处指向自身路径的清单项）。它们是**验收记录**
      // 而不是产物，但按判据 1「每个改动都要有人能说清怎么回滚」仍必须认领。
      'docs/code-review-2026-09-19.md',
      'docs/code-review-2026-09-19-summary.md',
    ],
    evidence: ['docs/code-review-2026-09-19-summary.md'],
    rollback: 'shared',
    note: '本轮改动的主体落在**已被 P2–P5 认领的共享文件**里（server.js 的 compressStoryMemory / '
      + 'agentMemoryGuardOf / getPath，public/app.js 的 directAIWrite / streamAIDirectWrite / '
      + 'loadAIContext / aiContextBlock）与**已被 S 认领的** frontend-test.mjs，所以主体**不能单独回滚**：'
      + '撤掉 Q1/Q2 会退回"出场判定只读章节头部"，压缩摘要可以静默丢实体、并喂给之后每一章；'
      + '撤掉 Q4 会让前端重新拿无预算的旧拼装喂进约 7.4 万字。本阶段唯一可单独撤的是 zip-reader.mjs '
      + '的两个上限常量（撤掉=回到无上限解压，不影响其它阶段）。'
      + '完整回滚用改动前的快照 `data/backup-review-v096-*`（12 个受影响文件，逐文件同构还原；'
      + '该目录在 .gitignore 内，不进仓库）。',
  },
  {
    id: 'U',
    title: '2026-09-20 轮：接管被中断的第二轮审查（护栏作用范围 + 下限自适应 + 兼容性检查）',
    files: [
      // 本轮**唯一**首次获得归属的文件。其余改动都落在已被 P2–P5 / S / D8 认领的共享文件里
      // （server.js 的 settleProposals / addMemoryProposal / agentMemoryGuardOf / compressStoryMemory、
      //  db.js 的 story_memory_proposals 迁移、public/app.js 的 applySelectedProposals、
      //  frontend-test.mjs、test/smoke.mjs、ai/memory-compress-guard.mjs），
      // 所以按判据 1「每个改动都要有人能说清怎么回滚」在此只认领新增的验收记录。
      //
      // ⚠️ 与 T 阶段**不可互相替代**：T 的结论是"出场判定读头尾各 2000 字"，
      //    本轮改成"读完整正文"，且 T 没有 guard 列、没有自适应下限。
      'docs/code-review-2026-09-19-round2-summary.md',
    ],
    evidence: ['docs/code-review-2026-09-19-round2-summary.md'],
    // ⚠️ 这个 'independent' 描述的是**本阶段自己认领的文件**（一份验收记录，没有任何东西 import 它），
    //    **不是**说本轮的行为变更可以独立回滚——那部分永远撤不干净（见 note 第一句）。
    //    别把它读成"这轮能单独撤"：判据是"这个文件撤掉影不影响别人"，不是"这轮改动撤不撤得干净"。
    rollback: 'independent',
    note: '⚠️ **本轮含一处真正的产品行为变更，不能单独回滚**：AI 自压缩的长期记忆摘要，'
      + '字数下限不再固定 100 字，改为按作品规模自适应（`minCharsForStory`：篇幅分档 100→640，'
      + '与"必须保留实体数 × 16 字"取 max，封顶 640 以不超过下游"≤800 字"产出目标）。'
      + '撤掉它 = 长篇可以"名字全写上、剧情/伏笔/角色状态全丢光"照样过闸——那正是用户 2026-09-20 '
      + '判定不成立的旧行为。另两处同属本轮的改动也在这条线上：`settleProposals` 只对带 '
      + '`guard=\'agent\'` 的提案设闸（此前对所有提案设闸，把普通短提案一并拒掉），'
      + '以及 `db.js` 给 `story_memory_proposals` 增加 `guard` 列（来源标记必须跨落库存活）。'
      + '完整回滚用改动后快照 `data/backup-round2-final-*`（5 个文件逐字节副本）；'
      + '只回到"第 2 步已验证版本"用 `data/backup-step3-preopt-*`。两个目录都在 .gitignore 内。',
  },
  {
    id: 'V',
    title: '2026-09-21 轮：双稿对照诊断 + 写作机制补齐（terms 层/未来章标记/场景预算/质检扩面） + 第 6 章定稿',
    files: [
      // 本轮唯一**首次获得归属**的文件：七项章节验收清单（批 2 固化产物）。
      'docs/chapter-acceptance-checklist.md',
    ],
    evidence: ['docs/chapter-acceptance-checklist.md'],
    // 'independent' 只描述这份清单本身（没有任何东西 import 它，可单独删除）；
    // 本轮的机制改动都落在已被 P1–P5 / S / T / U 认领的共享文件里
    // （ai/context/layers.mjs、server.js、public/app.js、harness-plugins/novel-writing/novel-tools.mjs、
    //  frontend-test.mjs、test/smoke.mjs、docs/ai-core.md、docs/context-contract.md 等），
    // 所以行为变更**不能单独回滚**——回滚用改动前快照或逐项对照 2026-09-21 双稿诊断报告。
    rollback: 'independent',
    note: 'terms 上下文层（cap 800、关键词/优先级抽选、查回路径）、未来章【禁止写入】标记式渲染、'
      + '成文轮场景预算（3–5 场景）与质检扩面（未来章/未登记实体/有效场景数）、'
      + 'style_positive 新增两条（物件密度/系统独白≤3 句）、七项验收清单固化为 docs/chapter-acceptance-checklist.md；'
      + '作品 18 第 6 章已按 3800–4200 字合成定稿（3897 字，4 处冲突清零）。'
      + '两份来源 docx 未改动；未提交 git。',
  },
  {
    id: 'W',
    title: '2026-09-21 轮：仓库展示面与开源文档（README 首页重写 + 社区文件 + 仓库级 Topics/Description）',
    files: [
      // 本轮**首次获得归属**的文件：社区健康度文件（对应 GitHub「Community Standards」清单）。
      'CONTRIBUTING.md',
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml',
      '.github/ISSUE_TEMPLATE/config.yml',
      '.github/pull_request_template.md',
    ],
    evidence: ['CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/bug_report.yml'],
    // 声明改成 shared（2026-09-25）：CONTRIBUTING.md 随后被 Z2 改过（许可证段落 = MIT），
    // 于是「撤掉 W 的这 5 个文件」会把 Z2 的改动一起卷走——文件级回滚不再干净。
    // 原先写 independent 描述的是"它们不被任何生产代码 import"，那一点仍然成立；
    // 但推导器按文件粒度判定，声明以推导为准（这是纪律，不是偏好）。
    rollback: 'shared',
    // 注意：剩下 4 个 issue/PR 模板仍可独立删（只影响 GitHub 展示面）；共享只发生在 CONTRIBUTING.md 这一个文件上。
    note: '仓库展示面优化：README 首页重写（第一屏改为「30 秒讲清价值 + 它不做什么」，'
      + '安装步骤紧随其后；原 30 行的「分支说明」块压到 2 行；新增环境变量配置表、Roadmap、'
      + '参与贡献、License 说明与目录），旧 README 里写法成熟的章节按行**原样**保留'
      + '（用重组脚本拼接，不手抄，避免中文正文抄写漂移）。README.md 已由更早阶段认领，故不重复列出；'
      + '仓库级 Description 与 Topics 通过 GitHub API 写入，属于仓库设置而非文件，不进 git。',
  },
  {
    id: 'W2',
    title: '2026-09-26 轮：开源展示面优化（Why 对比表 + 架构数据流 + 英文关键词 + License 检测修正）',
    files: [
      // 本轮改到的展示面文件。README.md 此前已由 X / Z0 / Z2 认领（各加过一段），
      // 属于"改在同一批文件里"，故本轮同样只能整体回滚。
      'README.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'vendor/README.md',
    ],
    // 2026-09-26 追加：LICENSE 收敛为**纯 MIT 全文**——实测 GitHub 的 licensee 在
    // 追加一段中文第三方说明后会把整个仓库判成 spdx=NOASSERTION（页面显示 Other），
    // 即使 MIT 正文逐字正确。第三方说明改由 THIRD-PARTY-NOTICES.md 承载（README 已指路）。
    evidence: ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
    rollback: 'shared',
    note: '展示面优化：README 新增「为什么是这套机制」对比表（通用对话式工具 vs 本项目）与「一次成文请求的数据流」架构图、'
      + '第一屏加英文关键词行（GitHub 搜索与英文读者理解）、补上此前未被引用的 assets/preview.png 截图、'
      + '把 CI 条数口径从 31 校正为实测 32；'
      + '把第三方组件声明从 LICENSE 移出到 THIRD-PARTY-NOTICES.md——原因是附加中文声明会让 GitHub licensee '
      + '把整个仓库判成 spdx=NOASSERTION（显示 "Other" 而不是 MIT），移出后 LICENSE 只含标准 MIT 全文。'
      + '仓库级 Description 与 Topics 经 GitHub API 写入，属仓库设置而非文件，不进 git。',
  },
  {
    id: 'Y',
    title: '2026-09-22 轮：按复核报告落地「确定性连续性预检」（审稿前先算掉机器能判的部分）',
    files: [
      // —— 本轮唯一首次获得归属的文件 ——
      // 判据（纯函数、零依赖）与装配层（靠注入 `{all,get}`，不 import db）刻意分成两个模块：
      // 前者能离线跑真值表与阴性对照，后者保证「服务端端点 / 验收脚本 / 将来的提示词路径」
      // 三处共用同一套 SQL，不再各写一遍（字数口径漂移的教训）。
      'ai/continuity-guard.mjs',
      'ai/continuity-guard-source.mjs',
      // 两条证据：离线单测（67 条断言，含"缺判据时不猜"的阴性对照）与**真实作品**上的
      // 命中率验收（第 5/6 章命中 5、漏报 0、误报 0、豁免闭环成立）。
      '.p1-baseline/test-continuity-guard.mjs',
      '.p1-baseline/verify-continuity-guard-on-real-data.mjs',
      // 判据口径、阈值默认值与覆盖入口（`continuity_thresholds:<workId>`）的说明书。
      'docs/continuity-guard.md',
      // 按《03 · DSH 待确认事项决策规范》对上一轮**全部待确认项**（含三盏红灯）的裁决记录：
      // 逐项 QUALITY_IMPACT / USER_IMPACT_IF_UNCHANGED / ACTION / 所选方案 / 执行范围 + 验收证据。
      'docs/confirmation-resolution-2026-09-22.md',
    ],
    evidence: [
      'docs/continuity-guard.md',
      '.p1-baseline/test-continuity-guard.mjs',
      '.p1-baseline/verify-continuity-guard-on-real-data.mjs',
    ],
    note: '本轮的**行为改动**落在已被 P2–P5 认领的 `server.js`（两条端点 + `app_settings` 读写）、'
      + '已被 S 认领的 `public/app.js`（预检块 + 内联进审稿提示词）与 `api-test-suite.mjs`（F11–F16）里，'
      + '所以整轮**不能单独回滚**：撤掉 `ai/continuity-guard*.mjs` 会让 server.js 的 import 当场失败'
      + '（启动即崩）。可单独撤的只有那份说明书本身。'
      + ' 另外这轮**刻意不改任何作品数据**：`chapters.target_words`、角色卡状态、风格文本一律原样——'
      + '判据里报出来的「口径冲突」正是要交回作者决定的事（报告 C6），工具只负责把冲突摆到台面上。',
  },
  {
    id: 'Z0',
    title: '2026-09-24 轮：OpenViking 本地向量模型随源码分发（vendor）',
    files: [
      // 本轮**唯一**首次获得归属的东西：一个 47.9MB 的 GGUF 模型 + 拉取/校验脚本 + 配置说明。
      // 为什么把它放进源码：本机网络环境下 huggingface.co 不可达（握手超时），
      // 而 OpenViking 的默认行为是「首次启动自己去下模型」——于是整条记忆链路上
      // 唯一必须联网、且必然失败的环节就是它。随源码带一份，服务端就再也不需要联网下模型。
      'vendor/',
      'scripts/fetch-embedding-model.mjs',
      'docs/openviking-embedding-setup.md',
      // 这两处是它的配套：.gitattributes 给二进制资产关掉行尾/编码转换（转换会直接毁掉 GGUF），
      // .gitignore 只忽略下载半成品（*.part），并**显式写明 vendor/ 不进忽略规则**。
      '.gitattributes',
      '.gitignore',
      'docs/README.md',      // 文档索引里加一行指路
      'README.md',           // 首页「记忆库」一节指向这份配置说明
    ],
    evidence: ['vendor/README.md', 'docs/openviking-embedding-setup.md', 'scripts/fetch-embedding-model.mjs'],
    // 声明改成 shared（原先写 independent，推导器立刻报不一致——实测撞到）：
    // 资产本身确实可以干净撤掉，但 README.md / docs/README.md 与 X/Z2 **同文件**（各加一行指路），
    // 文件级回滚会把别人的改动一起卷走，所以这一列只能填 shared。判据以推导器为准，不以印象为准。
    rollback: 'shared',
    note: '回滚口径（诚实版，分两层）：① **资产层可独立撤**——这几个文件不被任何生产代码 import'
      + '（只有文档引用路径），删掉 vendor/ 与拉取脚本后产品照常启动，代价只是'
      + '「服务端不需要联网下模型」这条能力消失'
      + '（OpenViking 会退回它自己的默认行为：首次启动去 HuggingFace 下载，本机必然失败）。'
      + '② **文件层不可单独回滚**——README.md / docs/README.md 与 X/Z2 改在同一批文件里，'
      + '而且撤掉资产后那两行指路会变成死链，必须同批处理。'
      + ' 校验口径以 vendor/README.md 里那张表为准（SHA256）；镜像返回的 ETag 与真实内容**不一致**，'
      + '别拿 ETag 当校验。**已定案（2026-09-25）：该二进制随仓库提交**（代价：每次 clone +47.9MB；'
      + '本轮提交时一并 `git add`；不想要就删掉 `vendor/models/`，产品照常启动，只是「离线可用」这条能力随之消失）。',
  },
  {
    id: 'Z1',
    title: '2026-09-24 轮：DSH 0.1.7 迁移（默认模型改走补丁层 + 一次性导入的诊断）',
    files: [
      // 本轮的**行为改动**都落在已被别的阶段认领的共享文件里：
      //   harness.js            —— materializeTaskSettings 从「重定向 settings 文档」改为「覆盖 agent-default-model 条目」；
      //                           新增 resolveDefaultSelection / warnIfLegacyImportPending（一次性导入缺陷的告警）
      //   ai/task-settings.mjs  —— 纯函数层：buildModelOverridePatch（provider 必填 + config 整体替换）、三级取值
      'harness.js',
      'ai/task-settings.mjs',
      //   profile 补丁层的写法：0.1.7 删掉了 settings-file 插件，默认模型改由 profile 的补丁层决定
      'harness-plugins/novel-writing/cordis.patch.yml',
      'harness-plugins/novel-writing/ENGINE.md',
      // 本轮新增/更新的证据（离线断言 + 并发端到端实验 + dsh 升级侦察脚本）
      '.p1-baseline/test-task-settings.mjs',
      '.p1-baseline/exp-concurrent-models.mjs',
      '.p0-recon/capture-dsh-request.mjs',
      // 文档留痕（口径以当前代码为准，不重写历史结论）
      'docs/ai-core.md',
      'ai/README.md',
      'docs/context-memory-analysis-report.md',
      'docs/phase-map.md',
    ],
    evidence: ['.p1-baseline/test-task-settings.mjs', '.p1-baseline/exp-concurrent-models.mjs', 'ai/task-settings.mjs'],
    rollback: 'shared',
    note: '**不能单独回滚**：harness.js 被 server.js 的 AI 路径 import，ai/task-settings.mjs 被 harness.js import，'
      + '而这两个文件同时被 P0/D8 改过（同一批函数）。撤掉它 = 退回「改写全局 settings + 互斥」的旧路径——'
      + '那会让服务端允许 2 并发而实际吞吐只有 1，而且任务崩在中间时用户的默认模型会停在被改写状态。'
      + ' 0.1.7 的**两处硬语义**（写成想当然就会静默不生效）：① 补丁层对 config 是**整体替换**不是深合并；'
      + '② provider 是 agent-default-model 的**必填**字段。另外上游有个实测复现的缺陷：启动时带着覆盖'
      + ' agent-default-model 的补丁层，settings.yaml → profile 的一次性导入会**静默失败**（原值只剩在'
      + ' .imported 里）——工坊只**告警**不擅自迁移（改用户的持久配置是 dsh 的职责）。'
      + ' 完整回滚用改动前快照（取证与清单见 .dsh-upgrade-recon/00-SUMMARY.md）。',
  },
  {
    id: 'Z2',
    title: '2026-09-24/25 轮：主体 V2 —— 上下文身份/完整性/溯源 + 压缩输入修复 + CI',
    files: [
      // ── 本轮新增的生产模块（纯函数、可离线断言、零依赖）──
      'ai/context/tokens.mjs',            // 规模估算（CJK 感知；**不参与**预算/裁剪决策）
      'ai/context/integrity.mjs',         // 完整性判定 C1–C8 + 内容哈希（清单必须与文字自洽）
      'ai/memory-compress-prompt.mjs',    // 压缩提示词模板（从 server.js 抽出，模板逐字未改）
      'text-utils.js',                    // + plainText / plainTextHead / plainTextTail
      // ── 本轮改到的共享文件（行为改动都在这几处）──
      'ai/context/layers.mjs',            // + PROVENANCE（每层六件事）/ provenanceOf / trimPriorityOf（从 FLEX_ORDER 派生）
      'ai/context/assembler.mjs',         // 产出 contextId / integrity / envelope；每层带 sourceIds / scores / recoveryPath
      'server.js',                        // 每层给真实 sourceIds；未 PASS 时 error/warn 日志；两条端点下发身份与信封
      'harness-plugins/novel-writing/test/smoke.mjs',
                                          // 外部实例模式下改用该实例的数据目录（否则日志断言读空气：ENOENT）
      '.p1-baseline/audit-llm-calls.mjs', // + assertZstdAvailable：缺 zstd 能力时**响亮失败**，不静默报 0
      '.p1-baseline/fake-llm.mjs',        // + Messages 形状（dsh 0.1.7 改走它）+ 每条请求留痕 hits[]
      '.p1-baseline/probe-cold-start.mjs',// 测不到冷启动时说清原因（走错端点 ≠ 没连上）
      '.p1-baseline/probe-harness-tool-loop.mjs',
                                          // 「模型 → 工具 → 模型」循环的零计费证据（此前只能靠推断）
      '.p1-baseline/fake-llm.mjs',        // ↑ 同批：+ 可选的一轮 tool_use/tool_calls
      '.p1-baseline/test-recall-gap.mjs', // 断言改为形态无关（钉意图，不钉调用形态的字节）
      // ── 本轮新增/更新的验收与工程化 ──
      '.p1-baseline/test-context-manifest.mjs',
      '.p1-baseline/test-memory-compress-prompt.mjs',
      '.p1-baseline/verify-memory-compress-input.mjs',
      '.p1-baseline/bench-context-build.mjs',
      '.p1-baseline/test-memory-compress-guard.mjs',
      '.p1-baseline/verify-all.mjs',
      'scripts/ci-isolated-run.mjs',      // 隔离实例包装器：被跑的命令也必须拿到同一套隔离变量
      'scripts/ci-offline-checks.mjs',    // CI 离线检查清单（唯一来源，YAML 里不再抄一遍）
      '.github/workflows/ci.yml',         // 首次接入 CI（离线 / 依赖下限 / 活实例三档）
      // —— 仓库级决定（2026-09-25 定案，按"质量红线"选型）——
      'LICENSE',                          // MIT（此前"未声明"=默认保留所有权利，与"能长期自己掌控"的目标相悖）
      'CONTRIBUTING.md',                  // 许可证段落改为 MIT
      'vendor/README.md',                 // 写清"这份资产随仓库提交"、代价、以及不想要时怎么删
      'docs/context-contract.md',         // §八：身份 · 完整性 · 溯源 · 信封
      'docs/ai-core.md',
      'docs/main-v2-upgrade-2026-09-24.md',
      'docs/main-v2-acceptance-2026-09-25.md', // 第二步验收报告（质量门/行为门/兼容门；结论 A PASS）
      'docs/host-contract.md',            // 第三步：Host Contract 1.0.0（冻结接口/边界/不变条件）
      'docs/host-contract.v1.json',       // 机读契约面（由真实代码导出；契约测试的比对基准）
      '.p1-baseline/test-host-contract.mjs', // 契约测试（含负向对照）
      'server.js',                        // + HOST_CONTRACT_VERSION + ping.host_contract（附加字段）
      'ai/harness-pool.mjs',              // 头注释订正：热备池未接线、无环境变量开关（无行为变化）
      'README.md',
      'docs/README.md',
    ],
    evidence: [
      'docs/context-contract.md', '.p1-baseline/test-context-manifest.mjs',
      '.p1-baseline/test-memory-compress-prompt.mjs', '.github/workflows/ci.yml',
      'scripts/ci-offline-checks.mjs', 'docs/main-v2-upgrade-2026-09-24.md',
    ],
    rollback: 'shared',
    note: '**不能单独回滚**：integrity.mjs / tokens.mjs 被装配器与 server.js import，装配器与 server.js'
      + ' 又被 P2–P5 改过（同一批函数）。撤掉会让启动路径当场失败。'
      + ' 本轮的**意图**是「同样的上下文内容，但可被追问、可被核对」：① 每层有溯源与查回路径；'
      + '② 清单与真正发出去的文字逐字节对齐（C1）+ 内容哈希（C6）；③ 身份（内容哈希 / 请求 id）随两条端点下发；'
      + '④ 顺带修掉一个真实缺陷——压缩提示词引用了已被删除的 SQL 别名（content_head/content_tail），'
      + '导致「最近章节正文」**恒为空**，无摘要章节只剩标题。'
      + ' 质量红线：这轮**没有**改模型、prompt 语义、reasoning effort、token 预算，也没有减少任何上下文；'
      + '逐字节基线 50/50 相同（对照副本是改动前的整树快照，核对完即删；'
      + '可复现的那份是 .p1-baseline/baselines-before-v2/ 与 baselines-v2b/）。'
      + '详见 docs/main-v2-upgrade-2026-09-24.md。',
  },
  {
    id: 'Z3',
    title: '2026-09-26 轮：确定性故事状态内核（门控层 + 10 张新表 + 18 条状态路由 + 8 工具）+ 第五步 Golden Novel 联合回归',
    files: [
      // 新增的生产模块（故事状态内核；門控能力，默认关闭）
      'ai/story-state/',
      // 本轮改到的共享文件（行为改动都在这几处）
      'db.js',                            // +10 张表 / +16 个索引（全附加式）
      'ai/context/layers.mjs',            // + 第 15 层 story_state（gated: true，排在 redlines 前）
      'ai/context/assembler.mjs',         // excluded 过滤门控层（未开启时不属于这套层）
      'server.js',                        // 门控构建故事状态层 + 17 条端点 + apply/rollback 失效缓存
      'harness-plugins/novel-writing/novel-tools.mjs',
      'harness-plugins/novel-writing/plugin.json',
      'harness-plugins/novel-writing/package.json',
      'harness-plugins/novel-writing/ENGINE.md',
      // 本轮新增/更新的验收与契约
      '.p1-baseline/test-story-state-api.mjs',
      '.p1-baseline/test-host-contract.mjs',
      '.p1-baseline/test-context-manifest.mjs',
      '.p1-baseline/golden-novel.mjs',     // 第五步：Golden Novel 联合回归（19 类难 case，零计费）
      '.p1-baseline/golden-out.json',      // 该回归最近一次的机器可读结果（关键指标同时进报告）
      'docs/golden-novel-regression-2026-09-26.md',   // 第五步终验报告（Golden Novel 联合回归）
      '.p1-baseline/verify-all.mjs',
      '.p1-baseline/verify-phase-map.mjs',
      'docs/host-contract.md',
      'docs/host-contract.v1.json',
      'docs/host-contract-1.1-2026-09-26.md',
      'docs/story-state-kernel-2026-09-26.md',
      'docs/phase-map.md',
    ],
    evidence: [
      'docs/story-state-kernel-2026-09-26.md',
      'docs/host-contract-1.1-2026-09-26.md',
      '.p1-baseline/test-story-state-api.mjs',
      '.p1-baseline/golden-novel.mjs',
      '.p1-baseline/golden-out.json',
      'docs/golden-novel-regression-2026-09-26.md',
      'docs/host-contract.v1.json',
    ],
    rollback: 'shared',
    note: '**不能单独回滚**：内核被 server.js、层规格与插件工具面同时引用，而那三处又是 P1–P6 / Z2 改过的同一批函数。'
      + ' 本轮的**设计前提**是「机制生效 ≠ 强制接入」：作品开关 story_state_config.enabled 默认 0，未开启时该层不进 manifest、不进 excluded、不计入可执行下限（floor(settings) 仍 = 18173）。'
      + ' 质量红线：本轮**没有**改模型、prompt 语义、reasoning effort、token 预算、层顺序与默认 AI route；'
      + '逐字节上下文基线 **50/50 相同**；活实例断言「开启后只多一层且其余各层 emitted 逐层相同」。'
      + ' 详见 docs/story-state-kernel-2026-09-26.md。'
      + ' 第五步 Golden Novel 联合回归（19 类难 case）另抓到并修掉两处真实缺陷：'
      + '① character_knowledge 的 upsert 少了部分唯一索引的 WHERE 谓词 → 角色知识边界整条路不可用（S14 回归 + 变异对照）；'
      + '② knowledgeOf 的 unknown/suspected/false_belief 可见窗口方向反了 → 最需要提醒的章节反而看不见（S15 回归 + 变异对照）。'
      + ' 另补 GET /api/novel/state/facts（契约 1.1.0 → 1.2.0，附加式）。详见 docs/golden-novel-regression-2026-09-26.md。',
  },
  {
    id: 'Z4',
    title: '2026-09-25 轮：DSH 0.1.7-rc.1 → rc.2 兼容性审查（报告 + 只读探针）',
    files: [
      'docs/DSH_0.1.7_RC1_RC2_API_DIFF.md',
      'docs/DSH_0.1.7_RC1_RC2_COMPATIBILITY_MATRIX.md',
      'docs/DSH_0.1.7_RC1_RC2_NOVEL_COMPATIBILITY_REPORT.md',
      'docs/DSH_0.1.7_RC1_RC2_NOVEL_PLUGIN_TEST_REPORT.md',
      'docs/DSH_RC1_COMPATIBILITY_BASELINE.md',
      'docs/RC1_vs_RC2_CAPABILITY_MATRIX.md',
      '.p1-baseline/.realtest/probe-config.mjs',
      '.p1-baseline/.realtest/probe-schema.mjs',
    ],
    evidence: [
      'docs/DSH_0.1.7_RC1_RC2_NOVEL_COMPATIBILITY_REPORT.md',
      '.p1-baseline/.realtest/probe-config.mjs',
    ],
    rollback: 'independent',
    note: '纯文档 + 只读探针，**不碰产品代码**：整批删除后工坊行为逐字节不变，故可独立回滚。'
      + ' 内容是把 dsh 0.1.7-rc.1 → rc.2 的能力差异、插件面、novel_* 工具面与工作坊兼容性实测逐条落到文档，供后续升级引用。'
      + ' ⚠️ 其中一条结论的前提**不是 stock RC.2**：全局 RC.2 的 cordis.patch.yml 被本地追加了 npm 上 404 的私有包'
      + ' （@deepseek-ai/dsh-operation-security），引用这批结论时必须单列这一条。'
      + ' 同轮的产品侧修复（超长 prompt 走 stdin）另记在 docs/HARNESS_ARGV_LIMIT_FIX.md 与 Z5 相邻的条目里。',
  },
  {
    id: 'Z5',
    title: '2026-09-25 轮：成文耗时测量层（口径 A 机器时间 / 口径 B 交付时间 的埋点补真）',
    files: [
      'public/app.js',
      'frontend-test.mjs',
      'docs/ai-write-latency-plan.md',
      'docs/HARNESS_ARGV_LIMIT_FIX.md',
      'docs/README.md',
    ],
    evidence: [
      'docs/ai-write-latency-plan.md',
      'docs/HARNESS_ARGV_LIMIT_FIX.md',
      'frontend-test.mjs',
    ],
    rollback: 'shared',
    note: '**不能单独回滚**：public/app.js 是 P2–P5 / Z2 / Z3 反复改过的同一个文件。'
      + ' 本轮两件事，都是附加式：'
      + '① 成文耗时测量层——新增 newWriteTiming() 分轮耗时账本；streamAIDirectWrite 多返回 ms/ttftMs；'
      + ' runHarnessJob 多返回客户端观测 ms；三处 showAIWritingResult 传入真实 channel/model/ms/timing'
      + ' （此前从未传过，导致 ai_eval_events 的 ms 恒为 0、channel/model 恒为空串），'
      + ' 并附加一条 app_logs kind=ai_write_timing（含分轮明细与 draft_key）；'
      + '② 超长 prompt 走 argv 触发 spawn ENAMETOOLONG 的修复（仅 Windows、仅超长时改走 dsh --profile novel - + stdin）——'
      + '短/中文本与非 Windows 路径逐字不变，回滚只需把 useStdinPrompt 置 false。'
      + ' 质量红线：**没有**改模型、prompt 语义、上下文、reasoning effort、token 预算，也没有改任何生成分支的判断条件——'
      + ' 测量值不参与决策，全部是附加字段。之所以走 app_logs 而不给 ai_eval_events 加列：避免 schema 迁移'
      + ' 与已冻结的 Host Contract 表清单变更（零迁移、零契约变更、零回滚风险）。'
      + ' 证据：frontend-test.mjs 新增 108h / 112a / 112b / 112c 四条断言（**既有期望值一字未改**）钉住'
      + ' "埋点落库请求里就是真值"；任务设置离线 49/49、离线清单 32/32、API 186/190（0 失败）、插件冒烟 39/39 全绿。'
      + ' 详见 docs/ai-write-latency-plan.md 与 docs/HARNESS_ARGV_LIMIT_FIX.md。',
  },
  {
    id: 'R',
    title: '2026-09-27 增强交付 R01—R12（导入安全与导入后重建 / 剧情分支沙盘 / 披露派生视图 / 作者样文与三级意图 / 编辑规则 / 长正文处理 / 审批与整次采纳 / OV 召回来源边界 / 运行时上下文贡献记录）',
    files: [
      // 新增内核模块（R12 导入安全与重建、R11 分支沙盘、R10 披露、R09 样式、R07 编辑规则、R04 召回来源、R05 贡献记录、R08 长正文前端）——
      // 每个文件都是本批次新建，不与既有阶段重叠；但它们**被生产代码 import**（server.js / public/app.js 等，属 P2–P5/Z2/Z3），
      // 所以整体声明的回滚级别是 shared（见 note）。
      'ai/import/guard.mjs',
      'ai/import/rebuild.mjs',
      'ai/import/rebuild-store.mjs',
      'ai/branch/sandbox.mjs',
      'ai/branch/store.mjs',
      'ai/context/contributions.mjs',
      'ai/editing/rules.mjs',
      'ai/editing/scan.mjs',
      'ai/openviking/recall-meta.mjs',
      'ai/style/store.mjs',
      'ai/style/author-profile.mjs',
      'public/long-text.js',
      // 新增离线验收（每条都进 scripts/ci-offline-checks.mjs 的检查清单，零计费）
      '.p1-baseline/test-agent-write-boundary.mjs',
      '.p1-baseline/test-approval-boundary.mjs',
      '.p1-baseline/test-adopt-atomic.mjs',
      '.p1-baseline/test-ov-recall-boundary.mjs',
      '.p1-baseline/test-context-contributions.mjs',
      '.p1-baseline/test-editing-rules.mjs',
      '.p1-baseline/test-long-text.mjs',
      '.p1-baseline/test-author-style.mjs',
      '.p1-baseline/test-disclosure.mjs',
      '.p1-baseline/test-branch-sandbox.mjs',
      '.p1-baseline/test-import-guard.mjs',
      '.p1-baseline/test-import-rebuild.mjs',
      '.p1-baseline/test-migration-idempotent.mjs',
      // 交付文档与机器可读账本
      'docs/enhancement-audit.md',
      'docs/enhancement-acceptance.md',
      'docs/enhancement-progress.json',
      'docs/plugin-runtime-map.md',
      'docs/openviking-call-map.md',
      // 手动实机验收（有限预算；不进 CI）：探针本体 + 两份机读证据（日志由 snapshot 排除规则过滤）
      '.p1-baseline/probe-live-capabilities.mjs',
      '.verify-enh/live-capabilities-2026-09-27.json',
      '.verify-enh/smoke-chain-2026-09-27.usage.json',
    ],
    evidence: [
      'docs/enhancement-acceptance.md',
      'docs/enhancement-progress.json',
      'docs/plugin-runtime-map.md',
      'docs/openviking-call-map.md',
      '.verify-enh/live-capabilities-2026-09-27.json',
      '.verify-enh/smoke-chain-2026-09-27.usage.json',
      '.p1-baseline/test-import-guard.mjs',
      '.p1-baseline/test-import-rebuild.mjs',
      '.p1-baseline/test-branch-sandbox.mjs',
    ],
    rollback: 'shared',
    note: '**不能单独回滚**：本阶段只新增文件，但这些新模块被**生产代码**import（server.js / public/app.js / ai/context/* 等），'
      + ' 撤掉它们必须先撤掉那些挂钩点，而挂钩点与 P2–P5 / Z2 / Z3 / T 改在同一批文件里。'
      + ' 交付内容是**附加式**的：新能力全部门控或按需触发（导入安全校验只作用于导入；重建流程只有作者显式规划才建表；'
      + ' 分支沙盘 / 样文 / 编辑规则 / 披露视图都默认不参与既有作品的装配），既有作品在功能关闭时装配与默认生成路径逐字节不变。'
      + ' 证据链：scripts/ci-offline-checks.mjs（45 条，含导入安全、导入重建与迁移幂等三条离线检查）、frontend-test.mjs、docs/enhancement-acceptance.md；'
      + ' 另有用户授权预算内的实机验收（能力探针 7/0 + 整链写作冒烟 7/0，8 次调用 ≈¥0.035，见验收报告 §6.2）。',
  },
  {
    id: 'PI',
    title: '2026-09-27 落地后独立重审（001.txt）：本轮修复 + 审计证据',
    files: [
      // 本轮修复触及的产品/测试文件（与 R / Z5 / P2–P5 改在同一批文件里——无法单独回滚）
      'server.js',
      'public/app.js',
      'frontend-test.mjs',
      // 审计证据与交付文档（纯证据；整目录删除即可回滚，不影响产品）
      '.verify-post/',
      'docs/post-implementation-audit.md',
      'docs/post-implementation-acceptance.md',
      'docs/post-implementation-issues.md',
      'docs/post-implementation-results.json',
    ],
    evidence: [
      'docs/post-implementation-audit.md',
      'docs/post-implementation-acceptance.md',
      'docs/post-implementation-issues.md',
      'docs/post-implementation-results.json',
    ],
    rollback: 'shared',
    note: '独立重审（不继承上一轮 PASS）发现并修复的缺陷：'
      + '① ISSUE-02：server.js 漏 import sampleSetHash，作品尚无文风档案时 GET /api/novel/style/profile 必 500 → 前端作者样文/档案/意图整卡降级；'
      + '② ISSUE-03：R08 长文本单请求路径三处缺陷——revision_patch 的 parse 依赖 segment（单请求必抛 TypeError，「先审稿再应用→按清单修稿」永远出不了差异预览）；'
      + 'review / 按清单修稿 / 写作精修三类调用在单请求路径会先把模型跑一遍再让老路径跑第二遍（同一次任务双倍计费、双倍等待）；'
      + 'AI 写作草稿链的差异合并指纹以草稿为基准比对正文，永远拒绝合并。'
      + ' 修复全是最小改动（补齐 import / 单请求路径 singleRunByCaller 交回调用方 / 合并以审稿启动时的正文指纹为基准），'
      + ' 未改 prompt 语义、模型路由、预算与任何注入字节。frontend-test.mjs 新增 58ad/58ae/58af 三条断言（先复现红，再转绿）。'
      + ' 证据：.verify-post/（本轮全部脚本与日志，可整体删除）。',
  },
  {
    id: 'L',
    title: '2026-09-28 知识库专项：跨作品共享写作资料库（门控层 library + 导入链 + 模型侧查回）',
    files: [
      // 新增内核模块（纯函数 + 登记表读写；被 server.js / openviking-sync.js import，属生产代码）
      'ai/library/',
      // 改造的生产文件（与 P2–P5 / R / PI 改在同一批文件里——无法单独回滚）
      'server.js',
      'openviking-sync.js',
      'ai/context/layers.mjs',
      'ai/openviking/recall-meta.mjs',
      'db.js',
      'harness-plugins/novel-writing/',
      // 契约、离线验收与真机证据（离线项全部进 scripts/ci-offline-checks.mjs；真机项不进 CI）
      '.p1-baseline/probe-library-p0.mjs',
      '.p1-baseline/probe-library-p0.result.json',
      '.p1-baseline/verify-library-identity.mjs',
      '.p1-baseline/library-identity-before.json',
      '.p1-baseline/verify-library-realmachine.mjs',
      '.p1-baseline/verify-library-realmachine.result.json',
      '.p1-baseline/test-library-import.mjs',
      '.p1-baseline/test-ov-recall-boundary.mjs',
      'scripts/ci-offline-checks.mjs',
      'docs/host-contract.md',
      'docs/host-contract.v1.json',
      'docs/openviking-call-map.md',
      'README.md',
    ],
    evidence: [
      'docs/host-contract.md',
      '.p1-baseline/test-library-import.mjs',
      '.p1-baseline/verify-library-identity.mjs',
      '.p1-baseline/verify-library-realmachine.result.json',
      '.p1-baseline/probe-library-p0.result.json',
      '.p1-baseline/test-ov-recall-boundary.mjs',
      'docs/openviking-call-map.md',
    ],
    rollback: 'shared',
    note: '**不能单独回滚**：`ai/library/` 被 server.js（P2–P5/Z2/Z3/PI）与 openviking-sync.js 直接 import，'
      + ' 且层规格 / 来源校验 / 登记表分别改在 ai/context/layers.mjs（P1/Z2/Z3）、ai/openviking/recall-meta.mjs（R）、db.js（P5/Z3）里。'
      + ' 本轮全部为附加式：新增门控层 `library`（默认关闭；`library_enabled=0` 的作品 assembled/manifest 与接入前**逐字节一致**，'
      + ' 见 `.p1-baseline/verify-library-identity.mjs` 的 4/4）、新增登记表 `library_docs`（纯 CREATE TABLE IF NOT EXISTS，旧 46 张表零改动）、'
      + ' 新增 7 条端点与工具 `novel_library`（写操作模型侧 403）。'
      + ' 关闭开关即恢复旧行为，不需要动数据。'
      + ' 证据链：离线 `.p1-baseline/test-library-import.mjs`（34/34，隔离实例 + OV stub）与 `test-ov-recall-boundary.mjs`（54/54，含资料根用例）；'
      + ' 真机 `.p1-baseline/verify-library-realmachine.mjs`（18/18，真实 OV v0.4.21 + 隔离实例，写共享资料根 3 篇后清理，根零残留）；'
      + ' 契约见 docs/host-contract.md §20；调用链见 docs/openviking-call-map.md 链 C。',
  },
  {
    id: 'Z6',
    title: '2026-09-29 方向驱动检索 + 索引层化（A–E）：direction 检索输入 / 资料索引 / 小说资产索引 / 检索计划 / 两类计数分开',
    files: [
      // 本批次新建的生产模块（被 server.js / openviking-sync.js / db.js import，属生产代码）
      'ai/direction.mjs',
      'ai/retrieval-stats.mjs',
      'ai/novel-index/',
      // 本批次新建的离线验收（已进 scripts/ci-offline-checks.mjs，零计费）
      '.p1-baseline/test-retrieval-plan.mjs',
      '.p1-baseline/test-direction-retrieval.mjs',
      '.p1-baseline/test-library-index.mjs',
      '.p1-baseline/bench-library-index.mjs',
      // 改在与 L / R / PI / Z5 共享的文件里（含 ai/library/library-index.mjs，归 L 的 ai/library/ 前缀）——无法单独回滚
      'db.js',
      'openviking-sync.js',
      'server.js',
      'public/app.js',
      'frontend-test.mjs',
      'harness-plugins/novel-writing/',
      'scripts/ci-offline-checks.mjs',
      'docs/host-contract.md',
      'docs/host-contract.v1.json',
      'docs/plugin-runtime-map.md',
      'docs/README.md',
      'README.md',
      '.p1-baseline/test-migration-idempotent.mjs',
    ],
    evidence: [
      '.p1-baseline/test-direction-retrieval.mjs',
      '.p1-baseline/test-retrieval-plan.mjs',
      'docs/host-contract.md',
    ],
    rollback: 'shared',
    note: '**不能单独回滚**：新模块 `ai/direction.mjs` / `ai/retrieval-stats.mjs` / `ai/novel-index/` 被 server.js / openviking-sync.js / db.js 直接 import，'
      + ' 且行为改动落在与 L / R / PI / Z5 共享的文件里（含 `ai/library/library-index.mjs`，归 L 的 `ai/library/` 前缀）。'
      + ' 本轮全部为**附加式**：direction 只是**检索数据**（不解析其中的指令、不写作品、不新增任何规划 / 裁决模型调用）；'
      + ' 资料索引（`library_index` + 可选 FTS5）与小说资产索引（12 张 `novel_index_*`）默认关闭（`library_index_enabled=0` / `novel_index_enabled=0`），'
      + ' 关闭时 `retrieval_stats.index_queries.total=0`，assembled / manifest / context_id 与 1.11.0 逐字节一致'
      + ' （`.p1-baseline/verify-library-identity.mjs` 4/4、`test-direction-retrieval.mjs` 的 E5 用例）。'
      + ' 检索计划并发查多个索引，但**先汇总后装配**——只给 buildNovelContext 准备输入，不新增编排层、不绕过唯一装配器；'
      + ' `retrieval_stats` 把「资料召回次数」与「索引查询次数」分开统计（任何消费方不得合并）。'
      + ' ⚠️ E5 为**保守落地**：计划开启不改变既有层内容（assembled 与关闭时逐字节一致），只增加审计字段；'
      + ' 「用索引替代全量读取」按梯队后续推进，未声称已达成。'
      + ' 自审（同日）：召回微缓存命中时把本次 searches/index_queries/timings 归零（缓存命中不是一次检索）、空查询不写微缓存（恢复旧行为）、'
      + ' FTS 候选改为先按 bm25 排序再截断并修正 lexical_score 方向、finalize 输出补 request_id——都有对应断言。'
      + ' 终审补修：计划缓存命中不把上一次的 by_index 重复计入本次（只记 cached，「索引查询次数」= 本次实际发生的次数；E6b/6.1/7.4）、'
      + ' request_id 截断改按码点（不撕裂代理对；C0.6）——同样各有断言。'
      + ' 证据链：`.p1-baseline/test-retrieval-plan.mjs`（65/65）、`.p1-baseline/test-direction-retrieval.mjs`（47/47）、'
      + ' `.p1-baseline/test-library-index.mjs`（19/19）、docs/host-contract.md 的 1.12.0 行。',
  },
  {
    id: 'G1',
    title: '2026-09-29 轮：GitHub 增长面优化（英文 README 成为首页 + 中文 README 逐节对齐 + 真实界面截图 + 社区健康度文件）',
    files: [
      // —— 本轮首次获得归属的文件 ——
      // README 首次拆成中英两份：英文版占用 README.md（GitHub 首页与仓库搜索权重最高的一份），
      // 中文正文**原样**迁到 README.zh-CN.md（用脚本搬运，不手抄，避免中文正文抄写漂移）；
      // 中文版随后重排成与英文版一致的章节顺序，并按英文版补齐「功能特性 / 使用 / 致谢」三节。
      'README.zh-CN.md',
      // README 首次引用的真实界面截图（此前只有一张 writing 截图）。截图由
      // .verify-post/tools/gen-readme-shots.mjs 在**隔离实例**上重放示例作品《雾都缝匠》后采集，
      // 不碰作者真实数据库；采集脚本本身在被忽略目录内，不进 git。
      'assets/screenshot-home.png',
      'assets/screenshot-overview.png',
      'assets/screenshot-settings-characters.png',
      'assets/screenshot-settings-terms.png',
      // 社区健康度文件（GitHub「Community Standards」清单里此前唯一缺失的两项）。
      // SECURITY.md 只描述**真实的**安全模型（本地单人、仅监听 127.0.0.1、data/ 内含明文密钥），
      // 不承诺做不到的事；CODE_OF_CONDUCT.md 采用 Contributor Covenant 2.1 并写明报告渠道。
      'SECURITY.md',
      'CODE_OF_CONDUCT.md',
      // —— 改在与其它阶段共享的文件里（无法单独回滚）——
      'README.md',
      'CONTRIBUTING.md',
      'docs/README.md',
      '.github/ISSUE_TEMPLATE/config.yml',
    ],
    evidence: [
      'README.md', 'README.zh-CN.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
      'assets/screenshot-settings-characters.png',
    ],
    rollback: 'shared',
    note: '**展示面 / 增长轮，不触碰任何生产路径**（0 处 import 变化、0 处运行时行为变化）——'
      + ' 但 README.md / docs/README.md / CONTRIBUTING.md 与 X / W / W2 / Z2 / L / Z6 共享，'
      + ' 按文件粒度判定只能整体回滚，故声明为 shared。'
      + ' 内容要点：① 英文 README 成为仓库首页，中文正文迁到 README.zh-CN.md（脚本搬运，不手抄）；'
      + ' 随后把中文版重排为与英文版逐节对齐的章节顺序（新增「⭐ 功能特性」「💻 使用」「🙏 致谢」三节，'
      + ' 标题与英文版一一对应，原有正文内容照搬未改写）；'
      + ' ② 修正一处**既有的事实错误**——旧 README 把 assets/preview.png（图标多尺寸预览，供 novel-studio-icon.ps1 生成 .ico）'
      + ' 配文成「深色护眼主题下的作品总览与设定管理」，它其实**不是**界面截图；'
      + ' ③ 社区健康度补齐 SECURITY.md 与 CODE_OF_CONDUCT.md；'
      + ' ④ .github/ISSUE_TEMPLATE/config.yml 的链接由写死分支名 blob/refactor/p0-p6 改为 blob/HEAD'
      + ' （分支改名不再失效），并补英文入口；'
      + ' ⑤ CONTRIBUTING.md 增英文段，原中文段整段保留、仅降一级标题。'
      + ' 仓库级 Description 与 Topics 经 GitHub API 写入，属**仓库设置而非文件**，不进 git（与 W / W2 同例）。',
  },
  {
    id: 'TT',
    title: '时态故事状态重构（T0–T8：版本化状态底座、保存接线、影响分析、逐章重建、上下文与界面）',
    files: [
      // 新增模块（目录级：整个目录都是本阶段新建，不与其他阶段共享）
      'ai/story-state/temporal/',
      'ai/repair/',
      'tests/temporal/',
      'scripts/test-temporal-refactor.mjs',
      // T8 专用性能基线（AC-48；合成数据、临时目录、零计费）与验收映射文档。
      'scripts/perf-temporal-baseline.mjs',
      'docs/temporal-refactor-acceptance.md',
      // 文档
      'docs/temporal-refactor-audit.md', 'docs/temporal-state-contract.md',
      'docs/temporal-refactor-progress.md', 'docs/temporal-refactor-progress.json',
      // 既有文件（全部改在生产路径上；与旧阶段共享同一文件 → 只能整体回滚）
      'db.js', 'server.js',
      'ai/story-state/index.mjs', 'ai/story-state/approval.mjs',
      'public/app.js', 'public/styles.css', 'frontend-test.mjs',
      'docs/host-contract.v1.json', 'docs/host-contract.md', 'docs/README.md', 'docs/plugin-runtime-map.md',
      'scripts/ci-offline-checks.mjs',
      '.p1-baseline/verify-all.mjs', '.p1-baseline/verify-phase-map.mjs', '.p1-baseline/test-host-contract.mjs',
    ],
    evidence: [
      'docs/temporal-refactor-audit.md', 'docs/temporal-refactor-progress.md',
      'scripts/test-temporal-refactor.mjs', 'tests/temporal/01-pure.test.mjs',
    ],
    rollback: 'shared',
    note: 'T0–T8 的时态状态重构：新增 11 张表与三个作品级开关（默认 0，未启用作品零影响），'
      + '唯一权威来源 = 不可变正文修订 + 已认可事件 + 提交清单 + 章序版本；旧字段降级为兼容投影。'
      + 'db.js / server.js / public/app.js 与 P2–P5、R、Z 系列共享同一文件，且新模块被生产代码 import，'
      + '按文件粒度只能整体回滚；回滚前必须先关闭 temporal_enabled（关闭即回到旧路径，不删历史）。',
  },
  {
    id: 'V1',
    title: '2026-10-02 轮：v1.0.0 审计修复轮的取证材料与新增离线门禁（文档 + 测试，不含产品代码）',
    files: [
      '.audit-2026/A1-ai-pipeline.md', '.audit-2026/A2-state-data.md', '.audit-2026/A3-frontend-security.md',
      '.audit-2026/api-run.txt',
      '.p1-baseline/test-api-key-mask.mjs', '.p1-baseline/test-context-shrink-cap.mjs',
      '.p1-baseline/test-host-guard.mjs', '.p1-baseline/test-memory-segments.mjs',
      '缺点及修复报告.md', '缺陷修复报告-20261002.md', '缺陷修复报告.md',
    ],
    evidence: [
      '缺陷修复报告-20261002.md',
      '.audit-2026/A1-ai-pipeline.md',
      '.p1-baseline/test-api-key-mask.mjs', '.p1-baseline/test-host-guard.mjs',
    ],
    rollback: 'independent',
    note: '这一组是**取证材料 + 新增离线门禁**，本身不含产品代码，整批删掉后工坊行为逐字节不变，故可独立回滚。'
      + ' ⚠️ 但它**记录的那些被修缺陷不在这组文件里**：P1-01/03/04/06/07/08 改的是 server.js / public/app.js /'
      + ' ai/ 与 9 个既有门禁脚本，那些文件由 P2–P6 / R / TT / Z 系列共同拥有，按文件粒度只能整体回滚。'
      + ' 也就是说，回滚这一组只回滚「证据与新增检查」，**不会**回滚报告里描述的那些修复。'
      + ' 四个新增门禁都是自托管隔离实例（临时数据目录 + 本机假模型端点），零计费；'
      + ' `.audit-2026/api-run.txt` 是修复前的原始输出（190 PASS / 1 FAIL，那条 FAIL 就是报告里的 B4 请求体上限漂移），'
      + ' 保留原样作为对照证据。',
  },
  {
    id: 'G2',
    title: '2026-10-02 轮：第二次 GitHub 展示面 / 增长优化（Description + Topics + 中英 README 首屏 + 文档索引与贡献者入口）',
    files: [
      // —— 文档索引与贡献者入口（本轮新增的内容）——
      'CONTRIBUTING.md',
      'docs/README.md',
      // —— 中英 README（与 X / W / W2 / Z2 / L / Z6 / G1 / TT 共享同一文件）——
      'README.md',
      'README.zh-CN.md',
      // 阶段映射生成器自身：本阶段新增 G2 条目（与 TT 等共享同一文件）。
      '.p1-baseline/verify-phase-map.mjs',
    ],
    evidence: [
      'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'docs/README.md',
    ],
    rollback: 'shared',
    note: '**展示面 / 增长轮，不触碰任何生产路径**（0 处 import 变化、0 处运行时行为变化）——'
      + ' 但 README.md / README.zh-CN.md / CONTRIBUTING.md / docs/README.md 与 G1 / X / W / W2 / Z2 / L / Z6 / TT'
      + ' 共享同一文件，按文件粒度判定只能整体回滚，故声明为 shared。'
      + ' 内容要点：① 英文与中文 README 首屏重写为「问题 → 价值主张 → 受众」结构，并新增「Who it\'s for / Who it\'s not for」'
      + ' 与「Where it fits」对比表（覆盖 Sudowrite / Novelcrafter / Obsidian+Longform / novelWriter / Manuskript /'
      + ' SillyTavern / Open WebUI 等替代品检索词），英文版新增可折叠目录（Contents）；'
      + ' ② **修掉三处既有的事实错误**——英文 README 写「49 checks」、中文 README 两处写「49 条」，'
      + ' 而 `scripts/ci-offline-checks.mjs` 实际是 **50 条**（离线套件实跑 50/50 佐证）；'
      + ' ③ `docs/README.md` 的 Host Contract 版本由 1.19.0 更正为 **1.20.0**、条目数 20 更正为 **21**'
      + '（唯一真源 `server.js` 的 `HOST_CONTRACT_VERSION`），并新增「一之再补、v1.0.0 轮」小节，'
      + ' 把此前**未被索引**的 21 份文档（含时态重构四件、DSH rc1→rc2 六件、`post-implementation-audit.md`）'
      + ' 与仓库根的 `.audit-2026/` 与三份中文报告一并登记；'
      + ' ④ `CONTRIBUTING.md` 中英两半各新增「怎么找到该看的地方」（架构入口表）与「该跑哪一套？」'
      + '（区分 50 条离线套件与 `verify-all`，并写明成本纪律与成本总闸）。'
      + ' 仓库级 Description 与 Topics 经 GitHub REST API 写入，属**仓库设置而非文件**，不进 git（与 G1 / W / W2 同例）。'
      + ' ⚠️ 写 Topics 走的是专用端点 `PUT /repos/{owner}/{repo}/topics`：实测仓库 PATCH 即使返回 200 也**不会**改 topics，'
      + ' 必须写后回读校验。',
  },
  {
    id: 'SE',
    title: '2026-10-07 第三批：Safe Editing 修稿安全门禁（确定性结构依赖 + 删除依赖 + 修后核验）',
    files: [
      // —— 本轮新增的确定性模块与交付文档（可独立撤回）——
      'public/patch-safety.js',
      'docs/safe-editing-gate-20261007.md',
      // —— 接线点（与 P 系列 / R / TT 等共享同一文件，按文件粒度整体回滚）——
      'public/app.js',
      'public/index.html',
      'frontend-test.mjs',
      // 阶段映射生成器自身：本阶段新增 SE 条目（与 G2 / TT 等共享同一文件）。
      '.p1-baseline/verify-phase-map.mjs',
    ],
    evidence: [
      'public/patch-safety.js',
      'docs/safe-editing-gate-20261007.md',
    ],
    rollback: 'shared',
    note: '**只加一层确定性门禁，不改任何模型契约**：补丁 JSON 仍是 `{"patches":[{issue,anchor,revised}]}`，'
      + ' 提示词字段一字未动（文档 §15 里需要改模型输出契约的 `fact_delta` 自报属未选中的批次）。'
      + ' 门禁做的事：对每条补丁判定 `protected_content / story_fact / object_provenance / reference_anchor / scene_anchor`'
      + '（外加只报告的 `causal_bridge_break`），命中的那一条**不进差异稿**，同批其余补丁照旧应用。'
      + ' 失败姿态是**放行**并在差异预览里写明 `safety_unavailable`——门禁不能阻塞作者修稿。'
      + ' 证据：`node frontend-test.mjs` 的 `94a`–`94r`（含文档 §14 五条用例与两组阴性对照）全绿，'
      + ' 旧的 `87/88/89/90/90a/90b/90c/58ad` 一并保持通过。'
      + ' `public/app.js`、`public/index.html`、`frontend-test.mjs` 与其它阶段共用，故 `rollback = shared`；'
      + ' `public/patch-safety.js` 与交付文档本身可以单独撤回（删文件即回到旧行为）。',
  },
  {
    id: 'SE4',
    title: '2026-10-08 第四批：一致性判据（事实锁 / 跨段整句重复 / 转场桥）+ 保护规则接线 + 允许人味',
    files: [
      // —— 本批新增的探针与交付文档（可独立撤回）——
      '.p1-baseline/probe-fact-lock-20261008.mjs',
      '.p1-baseline/probe-scan-round4-20261008.mjs',
      'docs/deai-source-fix-round4-20261008.md',
      // —— 判据与规则层（本批改动集中在这里；与 SE / R07 / P0 批次共享同一文件，按文件粒度整体回滚）——
      'ai/editing/rules.mjs',
      'ai/editing/scan.mjs',
      'ai/writing/policy.mjs',
      // —— 能力逐项 fixture 与派生护栏（加了能力必须同步这里，否则 C0 当场变红）——
      '.p1-baseline/test-editing-rules.mjs',
      // —— 接线点与版本号 ——
      'public/patch-safety.js',
      'public/app.js',
      'frontend-test.mjs',
      'package.json',
      'README.md',
      'README.zh-CN.md',
      'docs/CHANGELOG.md',
      // 阶段映射生成器自身：本阶段新增 SE4 条目（与 G2 / TT / SE 等共享同一文件）。
      '.p1-baseline/verify-phase-map.mjs',
    ],
    evidence: [
      'docs/deai-source-fix-round4-20261008.md',
      '.p1-baseline/probe-fact-lock-20261008.mjs',
      '.p1-baseline/probe-scan-round4-20261008.mjs',
    ],
    rollback: 'shared',
    note: '**只加判据与规则，不改任何模型契约**：补丁 JSON 仍是 `{"patches":[{issue,anchor,revised}]}`，'
      + ' 审稿 JSON 形状与提示词字段一字未动。本批做的事：'
      + ' ① `public/patch-safety.js` 升 v1.1.0，新增 `fact_lock_conflict`（**进 HARD_CODES**：同一实体两个编号 /'
      + ' 同一编号两个主人 / 补丁让有主人的编号整体消失）、`scene_bridge`、`cross_paragraph_duplicate`、'
      + ' `percent_sum_mismatch`；'
      + ' ② `ai/editing/scan.mjs` 新增四条判据（其中 `duplicate-sentence` **与能力开关无关**）'
      + ' 与 `scanned.promise` 测量值；`ai/editing/rules.mjs` 升 v1.3.0，新增'
      + ' `number-lock / scene-bridge / promise-identity` 三项**默认关闭、只报告**的能力，'
      + ' `PROTECTION_RULES` 增第 8 条（数字锁）与第 9 条（转场桥）；'
      + ' ③ **接线**：保护规则此前只被 `task:"write"` 的上下文层使用，润色与两条修稿提示词从没收到过它 ——'
      + ' 现在注入 `buildAIPolishMessages / buildAIRevisionPatchPrompt / buildAIRevisionPrompt`，'
      + ' 与 `edit_rules_enabled` 无关（保真底线不是创作偏好）；'
      + ' ④ `ai/writing/policy.mjs` 增 `allow_human_slack`（成文/扩写）与 `protect_human_slack`（修稿）'
      + ' 一对偏好，**不加配额**（配额化即 AI 味的结构性来源）；`public/app.js` 的兜底常量同文同步。'
      + ' 证据：`node .p1-baseline/probe-fact-lock-20261008.mjs`（25/25）、'
      + ' `node .p1-baseline/probe-scan-round4-20261008.mjs`（20/20，语料是作者真实的两版正文）、'
      + ' `node frontend-test.mjs` ALL PASS（含新增 118a–118n）。'
      + ' 本轮抓出并修掉七个自身缺陷（两遍 `labelFromWindow` 覆盖、编号前置式不认、后缀取错位置、'
      + ' 百分比正则在小数上错配、稀有度词重叠计数、外景词含单字"下"、百分比容差过松），逐条留痕在交付文档里。'
      + ' `public/app.js`、`frontend-test.mjs`、`ai/editing/*`、`ai/writing/policy.mjs` 与其它阶段共用，'
      + ' 故 `rollback = shared`；两个探针脚本与交付文档本身可以单独撤回。',
  },
  {
    id: 'SE5',
    title: '2026-10-08 第五批：叙事结构机械感（同形流程 / 时间轴 / 群众反应 / 镜头越界）+ P0 场景要求矛盾修复',
    files: [
      // —— 本批新增的探针、语料与交付文档（可独立撤回）——
      '.p1-baseline/probe-story-shape-20261008.mjs',
      '.p1-baseline/calibrate-story-shape-20261008.mjs',
      '.p1-baseline/fixtures/ch1-juexingri-v1.txt',
      '.p1-baseline/fixtures/ch1-juexingri-v2.txt',
      'docs/deai-source-fix-round5-20261008.md',
      // —— 判据与规则层 ——
      'ai/editing/scan.mjs',
      'ai/editing/rules.mjs',
      'ai/writing/policy.mjs',
      // —— 能力逐项 fixture 与派生护栏 ——
      '.p1-baseline/test-editing-rules.mjs',
      // —— 提示词接线（P0 根因在这里）与接口字段 ——
      'public/app.js',
      'server.js',
      'harness-plugins/novel-writing/agent.cordis.yml',
      'harness-plugins/novel-writing/novel-tools.mjs',
      'frontend-test.mjs',
      'package.json',
      'README.md',
      'README.zh-CN.md',
      'docs/CHANGELOG.md',
      // 阶段映射生成器自身：本阶段新增 SE5 条目。
      '.p1-baseline/verify-phase-map.mjs',
    ],
    evidence: [
      'docs/deai-source-fix-round5-20261008.md',
      '.p1-baseline/probe-story-shape-20261008.mjs',
      '.p1-baseline/calibrate-story-shape-20261008.mjs',
    ],
    rollback: 'shared',
    note: '**只加判据与字段、不改任何模型契约**：修稿补丁 JSON 仍是 `{"patches":[{issue,anchor,revised}]}`，'
      + ' `novel_consistency` 的返回是**追加** `checklist.style_diagnosis`（现有字段一字未动）。本批做的事：'
      + ' ① **P0 根因**：`buildAIWritingProsePrompt` 里"每个场面必须有明确地点/人物/动作/冲突，再补环境、动作、心理、对话与节奏"'
      + ' 与写作策略源 `avoid_repeated_full_mechanism`（同一机制不要完整复现第二遍）**直接冲突** ——'
      + ' 模型只能选后者，这就是"觉醒检测流程完整演示 4 次"的来源；改为**功能驱动**（关键场面展开／过渡场面可略写／'
      + ' 同类流程第二次只写结果差异与反应／第一次要写足）。'
      + ' ② `ai/editing/scan.mjs` 新增 `scanStoryShape` 与常驻测量值 `scanned.style_shape`（**与能力开关无关**）：'
      + ' 时间锚点（含"绑定钟点才算推进""时长不算""纯参照不算"三条筛）、同形流程簇、匿名群众反应段、'
      + ' 非转播上下文的镜头词、主视角看/听与主动动作比值；'
      + ' `ai/editing/rules.mjs` 升 v1.4.0，新增 `story-shape`（默认关闭、只报告），`PROTECTION_RULES` 增第 10 条'
      + '（同类机制只完整演示一次，**第一次必须保留**）；'
      + ' ③ `ai/writing/policy.mjs` 升 2026-10-08.2，只补**真正缺的**三条（`first_showing_stays_complete`、'
      + ' `prefer_progressive_revelation`、`prefer_result_over_repeated_process`）与 `diag_timeline_density`；'
      + ' 方案原列的其余 6 条诊断与 3 条偏好**已存在**（`diag_repeated_mechanism`／`diag_functional_redundancy`／'
      + ' `diag_negative_explanation`／`diag_over_explanation`／`allow_human_slack`／`protect_human_slack`／'
      + ' `avoid_repeated_full_mechanism`），故不新建 —— 同一判据两份文本必然漂移；'
      + ' ④ `server.js` 的 `/api/novel/consistency` 追加 `checklist.style_diagnosis`（自己显式打开 story-shape 跑一次，'
      + ' 不依赖作者是否启用了该能力），`novel-tools.mjs` 渲染为第 ⑨ 项自检 + 结构诊断区块，'
      + ' `agent.cordis.yml` 只追加**一条总原则**（控制规则数量，不加几十条）。'
      + ' 证据：`node .p1-baseline/probe-story-shape-20261008.mjs`（41/41，语料是作者真实的两版正文，'
      + ' 含正例/负例/静默姿态三类断言）、`node .p1-baseline/calibrate-story-shape-20261008.mjs`（阈值实测来源）、'
      + ' `node .p1-baseline/test-editing-rules.mjs`（含新增派生护栏 C0c）。'
      + ' 本轮在**真实语料上**抓出并修掉六处判据缺陷（时长守卫误删真锚点、`vagueOnlyRe` 被定义却从未使用、'
      + ' 同段两时间词误判过密、镜头上下文只看前一段、`MEDIA_CONTEXT_RE` 自我实现、'
      + ' 群众反应按动词分簇导致正例漏报），逐条留痕在交付文档里。'
      + ' `public/app.js`、`server.js`、`frontend-test.mjs`、`ai/editing/*`、`ai/writing/policy.mjs`、'
      + ' 两个 harness 插件文件与其它阶段共用，故 `rollback = shared`；探针、语料与交付文档可单独撤回。'
      + ' ⚠️ 已知边界：本章可复算的"同形流程再现"只有 2 组（不是审稿人目测的 4 次完整复现），'
      + ' 时间锚点 4–5 个、匿名群众反应 1 段、镜头越界 0 段 —— 即 S1/S3/S5 在本章是**倾向**而非硬性缺陷，'
      + ' 判据据此保持静默（零误报纪律），这是刻意的能力边界而非漏检。',
  },
  {
    id: 'SE6',
    title: '2026-10-09 第六批：叙事性专项修复（E00—E07：局部补丁执行正确性 / 阶段化规则 / 审稿与选择保真 / 叙事诊断 / 编辑计划 / 可解释报告）',
    files: [
      // —— 本批新增的模块（可单独撤回：不支持新模块时上层有回落姿态）——
      'public/revision-patch.js',
      'public/revision-plan.js',
      'ai/editing/narrative-scan.mjs',
      'ai/editing/narrative-review.mjs',
      // —— 本批新增的测试、冻结样本与交付文档（可独立撤回）——
      'tests/narrative-repair/',
      'docs/narrative-repair/',
      'scripts/test-narrative-repair.mjs',
      'scripts/materialize-narrative-fixtures.mjs',
      'scripts/run-narrative-acceptance.mjs',
      '.p1-baseline/verify-preset-copy.mjs',
      '.narrative-repair/',
      '叙事性专项修复.md',
      // —— 共用文件的改动（与其它阶段重叠，见 note）——
      'public/app.js',
      'public/index.html',
      'ai/editing/rules.mjs',
      'server.js',
      'db.js',
      'frontend-test.mjs',
      'scripts/ci-offline-checks.mjs',
      '.p1-baseline/test-editing-rules.mjs',
      '.p1-baseline/test-migration-idempotent.mjs',
      'harness-plugins/novel-writing/novel-tools.mjs',
      'docs/host-contract.md',
      'docs/host-contract.v1.json',
      // 阶段映射生成器自身：本阶段新增 SE6 条目。
      '.p1-baseline/verify-phase-map.mjs',
    ],
    evidence: [
      'docs/narrative-repair/implementation-report.md',
      'docs/narrative-repair/test-report.md',
      'docs/narrative-repair/e07-run-manifest.json',
      'docs/narrative-repair/coverage-report.json',
      'docs/narrative-repair/rollback.md',
      'scripts/run-narrative-acceptance.mjs',
    ],
    rollback: 'shared',
    note: '**只加机制与字段、不改既有模型契约**：修稿补丁 JSON 升到**可选** v2（`schema_version:2` + `span_id` + 逐字 `original`；'
      + ' 旧 `{patches:[{issue,anchor,revised}]}` 仍被接受，走 `salvageLegacyRevisionPatches`），'
      + ' `PUT /api/novel/review` 追加 additive 返回字段 `structure`/`findings_accepted`/`findings_rejected`/`rejected`，'
      + ' 新增只读端点 `GET /api/novel/revision/selection` 与 `GET /api/novel/revision/comparison`，'
      + ' 新增表 `revision_selections`（契约升 1.22.0），`/api/ai_context` 追加 additive `edit_rules`。'
      + ' 本批做的事：① **E01 补丁执行正确性**（显式 delete、精确跨度、段落级门禁输入、组合核验、失败不扩大为整章重写）；'
      + ' ② **E02 阶段化规则编译**（`rules.mjs` v1.5.0 的 `stage_rules` + `stageRuleFor` + 审计；直连与 Harness 同阶段等价，'
      + ' Harness 侧由 `novel_write_pipeline` 带 `stage=draft` 实现）；'
      + ' ③ **E03 审稿与选择保真**（`structureReviewReport` 引用核验 + 独立选择记录 + 取回按记录收窄）；'
      + ' ④ **E04 叙事诊断**（确定性候选层消费 `scan.mjs`，不复制词表；只给 condense/check，语义层标记 `not_run`）；'
      + ' ⑤ **E05 局部编辑计划**（片段级授权跨度 + 不变量 + 依赖组 + 预算举手）；'
      + ' ⑥ **E06 可解释报告**（逐条改动/校验状态/单处撤销/相对结论守卫/对照视图 + 样本量守卫）；'
      + ' ⑦ **E07 验收运行器**（`scripts/run-narrative-acceptance.mjs`：按退出码判定，产出 e07-run-manifest.json）。'
      + ' `public/app.js`、`public/index.html`、`server.js`、`ai/editing/rules.mjs`、`harness-plugins/novel-writing/novel-tools.mjs`、'
      + ' `frontend-test.mjs`、`scripts/ci-offline-checks.mjs`、`.p1-baseline/test-editing-rules.mjs`、`docs/host-contract.*`'
      + ' 与其它阶段共用，故 `rollback = shared`；新增模块、专项套件、冻结样本与交付文档**可单独撤回**'
      + '（撤回后：`index.html` 去掉两个 `<script>` → 修稿按"协议模块未加载"如实拒绝，不静默降级；'
      + ' 关掉 `edit_rules_enabled` → 生成行为与接入前逐字节一致）。'
      + ' ⚠️ 已知边界：真实模型语义审稿与文学效果评测未执行（`SKIPPED: paid_evaluation_not_authorized`），'
      + ' 故交付文档只写"机制已实现、文学效果待评测"。',
  },
];

/** 末段 `*` 通配 + 目录前缀 + 精确路径。 */
export function matchesPattern(rel, pattern) {
  const p = rel.replace(/\\/g, '/');
  if (pattern.endsWith('/')) return p.startsWith(pattern);
  if (pattern.includes('*')) {
    const rx = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return rx.test(p);
  }
  return p === pattern;
}

/**
 * 扫出「谁 import 了谁」（仓库内相对路径）。
 *
 * 为什么要它：`rollback` 那一列原先是我**手写的判断**，而它从未被检验过——
 * 实测就写错了：`ai/context/layers.mjs` 是 P1 的文件，却被装配器（P2）与 `server.js` import，
 * 单独撤掉 P1 会当场打断 P2。所以这一列必须**从真实依赖推导**，而不是靠印象。
 */
export function scanImports(files) {
  /** @type {Map<string, Set<string>>} 目标文件 → 引用它的文件 */
  const importers = new Map();
  const add = (target, from) => {
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(from);
  };
  for (const rel of files) {
    if (!/\.(mjs|cjs|js)$/.test(rel)) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const dir = path.posix.dirname(rel);
    for (const m of src.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g)) {
      let target = path.posix.normalize(path.posix.join(dir, m[1]));
      // 逐个候选补后缀/补 index，命中真实文件才算
      const cands = [target, `${target}.mjs`, `${target}.cjs`, `${target}.js`, `${target}/index.mjs`, `${target}/index.js`];
      const hit = cands.find((c) => fs.existsSync(path.join(REPO, c)));
      if (hit) add(hit, rel);
    }
  }
  return importers;
}

/**
 * 推导某阶段能否**独立回滚**。三种结果：
 *
 *   independent  没有共享文件，也没有被任何东西 import → 撤掉不影响别人
 *   tool-only    只被**验收工具**（.p0-recon / .p1-baseline / .p6-cutover）import
 *                → 可单独撤，代价是若干工具会失效（**会响亮地报错**，需同步修）
 *   shared       与别的阶段改在同一文件里，或**被生产代码**（server/harness/db/public/ai/插件）import
 *                → 撤掉会静默打断线上路径，只能整体回滚
 *
 * 为什么要分生产/工具：两者严重性不同。被 `server.js` import 撤了就断线上；
 * 被 `test-*.mjs` import 撤了只是测试跑不起来——后者是"响亮失败"，前者可能静默。
 */
export function computeRollback(phase, phases, importers) {
  const reasons = [];
  let hasProdBlocker = false;
  let hasToolBlocker = false;
  const isTool = (f) => /^\.(p0-recon|p1-baseline|p6-cutover)\//.test(f);

  for (const f of phase.ownedFiles) {
    const owners = phases.filter((p) => p.files.some((pat) => matchesPattern(f, pat))).map((p) => p.id);
    if (owners.length > 1) {
      hasProdBlocker = true;   // 同一文件被多阶段改 = 改动交织，撤不干净
      reasons.push(`文件 ${f} 同时属于 ${owners.join('/')}——改动改在同一批代码里，撤不干净`);
    }
    for (const imp of (importers.get(f) || [])) {
      const impOwners = phases.filter((p) => p !== phase && p.files.some((pat) => matchesPattern(imp, pat)));
      if (!impOwners.length) continue;
      if (isTool(imp)) {
        hasToolBlocker = true;
        reasons.push(`${f} 被 ${imp}（验收工具，${impOwners.map((p) => p.id).join('/')}）import——撤掉会让该工具失效`);
      } else {
        hasProdBlocker = true;
        reasons.push(`${f} 被**生产代码** ${imp}（${impOwners.map((p) => p.id).join('/')}）import——撤掉会打断线上路径`);
      }
    }
  }
  const rollback = hasProdBlocker ? 'shared' : (hasToolBlocker ? 'tool-only' : 'independent');
  return { rollback, reasons: [...new Set(reasons)].slice(0, 6) };
}

function git(args) {
  // stderr 显式丢弃：`git diff/status` 在 CRLF 工作副本上会打一堆
  // 「warning: in the working copy of 'server.js', CRLF will be replaced...」。
  // 这些警告会**污染套件汇总表里的证据行**（它取的是最后一行）——实测过，非常误导。
  // stdio[1]='pipe' 保证仍能拿到 stdout。
  //
  // ⚠️ `-c core.quotePath=false` 是必须的（2026-09-18 修）：git 默认把**非 ASCII 路径**
  // 按八进制转义输出（`docs/新手入门.md` → `"docs//346/226/260/…"`），
  // 而 stripQuotes 只剥引号、不反转义，于是**任何中文名文件都会被判成"没有归属"**。
  // 这个缺陷一直在，只是直到 X 认领的目录里真的出现中文名文件才暴露出来。
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** 真实改动集：相对某个**基线提交**的改动 + 未跟踪源码（沿用快照工具的排除规则）。 */
export function changedFiles(base) {
  const set = new Set();
  const args = base ? ['diff', '--name-only', base] : ['diff', '--name-only', 'HEAD'];
  for (const rel of git(args).split('\n').map((s) => s.trim()).filter(Boolean)) {
    const p = rel.replace(/\\/g, '/');
    // ⚠️ 排除规则必须作用于**两支**来源。早先只过滤"未跟踪"那一支，
    // 于是 D1 把 `baselines*/summary.json` 提交进来之后，它们突然成了 21 个"无归属改动"——
    // 实测撞到过。派生数据无论是否已提交，都不该算进"阶段的改动面"。
    if (isExcluded(p)) continue;
    set.add(p);
  }
  const out = git(['status', '--porcelain', '-uall']);
  for (const line of out.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    let rel = line.slice(3).trim();
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    rel = rel.replace(/\\/g, '/');
    if (isExcluded(rel)) continue;
    set.add(rel);
  }
  return [...set].sort();
}

/**
 * 默认基线：**当前分支与主线的分叉点**（`git merge-base HEAD <main>`）。
 *
 * 为什么不能用 HEAD：D1 把整个重构提交之后，`git diff HEAD` 只剩当天的新改动，
 * 于是 P0/P1 的文件"消失"在改动集之外，推导就把它们误判成 `independent`——
 * 实测撞到过（提交前 P0=shared，提交后突然=independent）。
 * 用分叉点则天然表达"这次重构改了哪些东西"，且**不写死提交号**（不会腐烂）。
 * 主线分支名可用 `--main <name>` 覆盖；拿不到时退回 HEAD 并在输出里说明。
 */
export function defaultBase(mainBranch = 'main') {
  // ⚠️ 2026-09-18：候选里**必须**包含 `origin/<main>`。
  // 本地 `main` 分支已被刻意删除（加固：让磁盘上不存在"可误切回重构前"的检出目标），
  // 于是 `git merge-base HEAD main` 直接 fatal，工具退回 HEAD —— 而那个基线
  // **系统性偏乐观**：P0/P1 的文件落在改动集之外，推导会把本该 shared 的阶段报成
  // "可独立回滚"（本文件上面那段注释记的正是这个假阴性，实测又撞了一次）。
  // 有远端就一定能拿到分叉点，不该因为"本地分支被删"而让回滚判定失真。
  for (const ref of [...new Set([mainBranch, `origin/${mainBranch}`, `refs/remotes/origin/${mainBranch}`])]) {
    try {
      const mb = git(['merge-base', 'HEAD', ref]).trim();
      if (mb) return mb;
    } catch { /* 该 ref 不存在，试下一个 */ }
  }
  return '';
}

/** 生成文档正文（文档由数据派生，避免手写漂移）。 */
export function renderDoc(phases, changed, verdicts) {
  const lines = [];
  lines.push('# 阶段 → 改动面 → 回滚（自动生成，请勿手改）');
  lines.push('');
  lines.push('> 由 `.p1-baseline/verify-phase-map.mjs` 生成：`node .p1-baseline/verify-phase-map.mjs --write`。');
  lines.push('> 每次运行都会拿**真实改动集**对账——出现「没归属的改动」即失败，');
  lines.push('> 这样"我只想撤回某个阶段，要动哪里"永远有答案，清单也不会腐烂。');
  lines.push('>');
  lines.push('> 注：本文档自身也在改动集里（归在 X），所以**首次生成**后计数会 +1，此后稳定。');
  lines.push('');
  lines.push('## 一、可独立回滚性总览');
  lines.push('');
  lines.push('> 「回滚」这一列**不是手写的判断，而是从真实依赖推导的**，三档：');
  lines.push('> - ✅ **independent**：无共享文件、也没被任何东西 import → 撤掉不影响别人；');
  lines.push('> - 🟡 **tool-only**：只被**验收工具** import → 可单独撤，代价是工具会响亮地失效（需同步修）；');
  lines.push('> - ⚠️ **shared**：与别的阶段改在同一文件里，或**被生产代码**（server/harness/db/public/ai/插件）import');
  lines.push('>   → 撤掉会打断线上路径，只能整体回滚。');
  lines.push('>');
  lines.push('> 判据来自真实 `import` 图与真实改动集；推导结果与数据里声明的值必须一致，否则核对失败。');
  lines.push('');
  lines.push('| 阶段 | 主题 | 回滚 |');
  lines.push('|---|---|---|');
  for (const p of phases) {
    const v = verdicts.get(p.id);
    const label = v.rollback === 'independent' ? '✅ 可独立回滚'
      : (v.rollback === 'tool-only' ? '🟡 可单独撤，但会让若干验收工具失效（需同步修）'
        : '⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚');
    lines.push(`| **${p.id}** | ${p.title} | ${label} |`);
  }
  const indep = phases.filter((p) => verdicts.get(p.id).rollback === 'independent');
  const toolOnly = phases.filter((p) => verdicts.get(p.id).rollback === 'tool-only');
  lines.push('');
  lines.push(`**可独立回滚的阶段：${indep.length ? indep.map((p) => p.id).join('、') : '（无）'}。**`
    + (toolOnly.length ? `仅会让验收工具失效的：${toolOnly.map((p) => p.id).join('、')}。` : '')
    + '其余阶段要么与别的阶段改在同一批代码里，要么被生产代码 import——**要回滚就一起回滚**，'
    + '或用 `.p6-cutover/snapshot.mjs` 的整体快照。');
  lines.push('');
  lines.push('## 二、逐阶段明细');
  for (const p of phases) {
    const v = verdicts.get(p.id);
    lines.push('');
    lines.push(`### ${p.id} · ${p.title}`);
    lines.push('');
    lines.push(`- **回滚方式**：${v.rollback === 'independent' ? '可独立回滚'
      : (v.rollback === 'tool-only' ? '可单独撤，但会让若干验收工具失效（需同步修）' : '只能整体回滚')}`);
    if (v.reasons.length) {
      lines.push('- **阻断原因（推导得出）**：');
      for (const r of v.reasons) lines.push(`  - ${r}`);
    }
    lines.push(`- **说明**：${p.note}`);
    lines.push(`- **验收证据**：${p.evidence.map((e) => `\`${e}\``).join('、')}`);
    const owned = changed.filter((f) => p.files.some((pat) => matchesPattern(f, pat)));
    lines.push(`- **本阶段认领的文件**（${owned.length} 个）：`);
    for (const f of owned) lines.push(`  - \`${f}\``);
  }
  const orphans = changed.filter((f) => !phases.some((p) => p.files.some((pat) => matchesPattern(f, pat))));
  lines.push('');
  lines.push('## 三、归属核对');
  lines.push('');
  lines.push(`- 真实改动集：**${changed.length}** 个文件`);
  lines.push(`- 未被任何阶段认领：**${orphans.length}** 个`);
  if (orphans.length) {
    lines.push('');
    lines.push('⚠️ 以下改动没有归属——没人能说清怎么回滚它们：');
    for (const o of orphans) lines.push(`  - \`${o}\``);
  } else {
    lines.push('');
    lines.push('✓ 全部改动都有归属。');
  }
  lines.push('');
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argOf = (n, d = '') => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const MAIN_BRANCH = argOf('--main', 'main');
  const BASE = argOf('--since', '') || defaultBase(MAIN_BRANCH);
  const changed = changedFiles(BASE);
  let bad = 0;
  const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };

  console.log('═══ 阶段映射核对 ═══\n');
  console.log(`基线：${BASE ? `${BASE.slice(0, 8)}（与 ${MAIN_BRANCH} 的分叉点${argOf('--since') ? '，由 --since 指定' : ''}）` : 'HEAD（拿不到分叉点，退回 HEAD）'}`);
  console.log(`真实改动集：${changed.length} 个文件\n`);
  if (changed.length === 0) {
    console.log('（与基线相比没有改动——没有可归属的东西。若你刚把分支合进主线，这是正常的。）');
  }

  // 1) 完整性：每个改动都要有归属
  const orphans = changed.filter((f) => !PHASES.some((p) => p.files.some((pat) => matchesPattern(f, pat))));
  console.log('【1. 完整性：改动是否都有归属】');
  say(orphans.length === 0, orphans.length
    ? `${orphans.length} 个改动没有归属（没人能说清怎么回滚）：`
    : `全部 ${changed.length} 个改动都有归属`);
  for (const o of orphans.slice(0, 15)) console.log(`      · ${o}`);
  if (orphans.length > 15) console.log(`      · …其余 ${orphans.length - 15} 项`);

  // 2) 存在性：映射里提到的证据路径必须真的存在
  console.log('\n【2. 存在性：映射指向的文件是否真的在】');
  for (const p of PHASES) {
    const missing = p.evidence.filter((e) => !fs.existsSync(path.join(REPO, e)));
    say(missing.length === 0, `${p.id} 的 ${p.evidence.length} 项证据都在`
      + (missing.length ? `（缺：${missing.join('、')}）` : ''));
  }

  // 3) 可回滚性：**由真实依赖推导**，并要求数据里的声明与推导一致
  console.log('\n【3. 可回滚性：从真实依赖推导（不是手写判断）】');
  for (const p of PHASES) p.ownedFiles = changed.filter((f) => p.files.some((pat) => matchesPattern(f, pat)));
  const importers = scanImports(changed);
  const verdicts = new Map();
  for (const p of PHASES) {
    const v = computeRollback(p, PHASES, importers);
    verdicts.set(p.id, v);
    const declared = p.rollback;
    const agree = declared === undefined || declared === v.rollback;
    say(agree, `${p.id} 推导=${v.rollback}`
      + (declared === undefined ? '（数据未声明，以推导为准）' : `　声明=${declared}`));
    for (const r of v.reasons.slice(0, 2)) console.log(`      · ${r}`);
    if (!agree) console.log(`      ← 声明与推导不一致：要么改数据，要么改归属（清单漏记会让判定偏乐观）`);
  }
  const indep = PHASES.filter((p) => verdicts.get(p.id).rollback === 'independent').map((p) => p.id);
  console.log(`\n  可独立回滚的阶段：${indep.length ? indep.join('、') : '（无）'}`
    + `${indep.length ? '' : ' —— 要回滚只能整体回滚，或用 snapshot.mjs 的整体快照'}`);

  // 4) 文档对账（或生成）
  const rendered = renderDoc(PHASES, changed, verdicts);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(DOC), { recursive: true });
    fs.writeFileSync(DOC, rendered);
    console.log(`\n✓ 已生成 ${path.relative(REPO, DOC)}`);
  } else {
    console.log('\n【4. 文档与数据是否一致】');
    const onDisk = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
    if (onDisk === rendered) {
      say(true, `docs/phase-map.md 与阶段数据一致（${rendered.length} 字节）`);
    } else if (!onDisk) {
      say(false, 'docs/phase-map.md 不存在 —— 跑 --write 生成');
    } else {
      const a = onDisk.split('\n');
      const b = rendered.split('\n');
      const firstDiff = a.findIndex((l, i) => l !== b[i]);
      say(false, `docs/phase-map.md 已过期（首个差异在第 ${firstDiff + 1} 行）—— 跑 --write 重新生成`);
      console.log(`      磁盘: ${String(a[firstDiff] ?? '(缺行)').slice(0, 100)}`);
      console.log(`      应然: ${String(b[firstDiff] ?? '(缺行)').slice(0, 100)}`);
    }
  }

  console.log(`\n${bad ? `✗ 阶段映射核对未通过（${bad} 处问题）` : '✓ 阶段映射核对通过'}`);
  process.exitCode = bad ? 1 : 0;
}
