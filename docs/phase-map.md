# 阶段 → 改动面 → 回滚（自动生成，请勿手改）

> 由 `.p1-baseline/verify-phase-map.mjs` 生成：`node .p1-baseline/verify-phase-map.mjs --write`。
> 每次运行都会拿**真实改动集**对账——出现「没归属的改动」即失败，
> 这样"我只想撤回某个阶段，要动哪里"永远有答案，清单也不会腐烂。
>
> 注：本文档自身也在改动集里（归在 X），所以**首次生成**后计数会 +1，此后稳定。

## 一、可独立回滚性总览

> 「回滚」这一列**不是手写的判断，而是从真实依赖推导的**，三档：
> - ✅ **independent**：无共享文件、也没被任何东西 import → 撤掉不影响别人；
> - 🟡 **tool-only**：只被**验收工具** import → 可单独撤，代价是工具会响亮地失效（需同步修）；
> - ⚠️ **shared**：与别的阶段改在同一文件里，或**被生产代码**（server/harness/db/public/ai/插件）import
>   → 撤掉会打断线上路径，只能整体回滚。
>
> 判据来自真实 `import` 图与真实改动集；推导结果与数据里声明的值必须一致，否则核对失败。

| 阶段 | 主题 | 回滚 |
|---|---|---|
| **P0** | 专用 dsh profile（novel）与插件 bundle 化 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **P1** | 冻结上下文契约 + 基线 + 压力数据 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **P2** | 唯一上下文装配器（预算自动核算 + 裁剪清单） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **P3** | 检索覆盖面 + 凡裁剪必可查回（I4） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **P4** | 通道收敛 + 单点策略表 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **P5** | 记忆语义压缩 + 效果埋点 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **P6** | 一次性切换（工具就绪，**未执行**） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **D8** | 不足清单修复（D8-#1…#8） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **X** | 跨阶段：总纲与工具入口 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **S** | 2026-09-18 会话：模型统一 V4.1 Flash + 写作路径提速 + 环境自检接线 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **T** | 2026-09-19 轮：全仓代码审查与修复（Q1/Q2/Q4 + R1/R2 + O1/O2/C1/F1） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **U** | 2026-09-20 轮：接管被中断的第二轮审查（护栏作用范围 + 下限自适应 + 兼容性检查） | ✅ 可独立回滚 |
| **V** | 2026-09-21 轮：双稿对照诊断 + 写作机制补齐（terms 层/未来章标记/场景预算/质检扩面） + 第 6 章定稿 | ✅ 可独立回滚 |
| **W** | 2026-09-21 轮：仓库展示面与开源文档（README 首页重写 + 社区文件 + 仓库级 Topics/Description） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **W2** | 2026-09-26 轮：开源展示面优化（Why 对比表 + 架构数据流 + 英文关键词 + License 检测修正） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Y** | 2026-09-22 轮：按复核报告落地「确定性连续性预检」（审稿前先算掉机器能判的部分） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Z0** | 2026-09-24 轮：OpenViking 本地向量模型随源码分发（vendor） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Z1** | 2026-09-24 轮：DSH 0.1.7 迁移（默认模型改走补丁层 + 一次性导入的诊断） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Z2** | 2026-09-24/25 轮：主体 V2 —— 上下文身份/完整性/溯源 + 压缩输入修复 + CI | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Z3** | 2026-09-26 轮：确定性故事状态内核（门控层 + 10 张新表 + 18 条状态路由 + 8 工具）+ 第五步 Golden Novel 联合回归 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Z4** | 2026-09-25 轮：DSH 0.1.7-rc.1 → rc.2 兼容性审查（报告 + 只读探针） | ✅ 可独立回滚 |
| **Z5** | 2026-09-25 轮：成文耗时测量层（口径 A 机器时间 / 口径 B 交付时间 的埋点补真） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |

**可独立回滚的阶段：U、V、Z4。**其余阶段要么与别的阶段改在同一批代码里，要么被生产代码 import——**要回滚就一起回滚**，或用 `.p6-cutover/snapshot.mjs` 的整体快照。

## 二、逐阶段明细

### P0 · 专用 dsh profile（novel）与插件 bundle 化

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p0-recon/capture-dsh-request.mjs 同时属于 P0/Z1——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/ENGINE.md 同时属于 P0/Z1/Z3——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/cordis.patch.yml 同时属于 P0/Z1——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/novel-tools.mjs 同时属于 P0/Z3——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/package.json 同时属于 P0/Z3——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/plugin.json 同时属于 P0/Z3——改动改在同一批代码里，撤不干净
- **说明**：harness.js 同时被 P4/P6 改过；profile 本身的回滚是卸掉 novel profile 与 bundle 接线（install-profile.mjs 反向操作）。
- **验收证据**：`.p0-recon/README.md`、`.p0-recon/verify-harness-profile.mjs`、`.p0-recon/compare-composed.mjs`、`.p0-recon/novel.p3.txt`、`.p0-recon/capture-dsh-request.mjs`
- **本阶段认领的文件**（36 个）：
  - `.p0-recon/.gitignore`
  - `.p0-recon/README.md`
  - `.p0-recon/capture-dsh-request.mjs`
  - `.p0-recon/compare-composed.mjs`
  - `.p0-recon/headless-sim.p6.err.txt`
  - `.p0-recon/headless-sim.p6.txt`
  - `.p0-recon/headless.composed.txt`
  - `.p0-recon/headless.help.err.txt`
  - `.p0-recon/headless.help.txt`
  - `.p0-recon/headless.srcrepo.err.txt`
  - `.p0-recon/headless.srcrepo.txt`
  - `.p0-recon/negative-control.patch.yml`
  - `.p0-recon/negctl.err.txt`
  - `.p0-recon/negctl.out.txt`
  - `.p0-recon/novel.bundle.err.txt`
  - `.p0-recon/novel.bundle.txt`
  - `.p0-recon/novel.help.err.txt`
  - `.p0-recon/novel.help.txt`
  - `.p0-recon/novel.p3.err.txt`
  - `.p0-recon/novel.p3.txt`
  - `.p0-recon/novel.srcrepo.err.txt`
  - `.p0-recon/novel.srcrepo.txt`
  - `.p0-recon/verify-harness-profile.mjs`
  - `harness-plugins/novel-writing/ENGINE.md`
  - `harness-plugins/novel-writing/NATIVE_PLUGIN_GUIDE.md`
  - `harness-plugins/novel-writing/README.md`
  - `harness-plugins/novel-writing/agent.cordis.yml`
  - `harness-plugins/novel-writing/cordis.patch.yml`
  - `harness-plugins/novel-writing/headless-cordis.patch.yml`
  - `harness-plugins/novel-writing/install-profile.mjs`
  - `harness-plugins/novel-writing/install.ps1`
  - `harness-plugins/novel-writing/novel-tools.mjs`
  - `harness-plugins/novel-writing/package.json`
  - `harness-plugins/novel-writing/plugin.json`
  - `harness-plugins/novel-writing/test/smoke.mjs`
  - `harness.js`

### P1 · 冻结上下文契约 + 基线 + 压力数据

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 ai/context/layers.mjs 同时属于 P1/Z2/Z3——改动改在同一批代码里，撤不干净
  - ai/context/layers.mjs 被 .p1-baseline/golden-novel.mjs（验收工具，Z3）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-assembler.mjs（验收工具，P2）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-context-manifest.mjs（验收工具，Z2/Z3）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-recall-gap.mjs（验收工具，D8/Z2）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/verify-all.mjs（验收工具，X/Z2/Z3）import——撤掉会让该工具失效
- **说明**：层规格是新增模块；但**不能单独撤回**——装配器（P2）与 server.js 都 import 它，撤掉会当场打断它们。
- **验收证据**：`docs/context-contract.md`、`.p1-baseline/README.md`、`.p1-baseline/context-floor.mjs`、`.p1-baseline/make-stress.mjs`
- **本阶段认领的文件**（14 个）：
  - `.p1-baseline/capture-baseline.mjs`
  - `.p1-baseline/compare-baseline.mjs`
  - `.p1-baseline/context-floor.mjs`
  - `.p1-baseline/make-stress.mjs`
  - `.p1-baseline/probe-ov-find.mjs`
  - `.p1-baseline/probe-ov-recall-chain.mjs`
  - `.p1-baseline/probe-recall-direct.mjs`
  - `.p1-baseline/probe-recall-query.mjs`
  - `.p1-baseline/probe-recall.mjs`
  - `.p1-baseline/probe-retrieval.mjs`
  - `.p1-baseline/schema-dump.mjs`
  - `.p1-baseline/survey.mjs`
  - `ai/context/layers.mjs`
  - `docs/context-contract.md`

### P2 · 唯一上下文装配器（预算自动核算 + 裁剪清单）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 ai/context/assembler.mjs 同时属于 P2/Z2/Z3——改动改在同一批代码里，撤不干净
  - ai/context/assembler.mjs 被 .p1-baseline/test-context-manifest.mjs（验收工具，Z2/Z3）import——撤掉会让该工具失效
  - ai/context/assembler.mjs 被**生产代码** server.js（P3/P4/P5/Z2/Z3）import——撤掉会打断线上路径
  - 文件 docs/ai-core.md 同时属于 P2/Z1/Z2——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3——改动改在同一批代码里，撤不干净
- **说明**：改动集中在 server.js 的 buildNovelContext 与路由；与 P3/P4/P5 同处一个大文件，**无法只撤 P2**。
- **验收证据**：`docs/p2-assembler-verification.md`、`docs/ai-core.md`、`.p1-baseline/verify-invariants.mjs`、`.p1-baseline/test-assembler.mjs`
- **本阶段认领的文件**（7 个）：
  - `.p1-baseline/test-assembler.mjs`
  - `.p1-baseline/verify-invariants.mjs`
  - `.p1-baseline/verify-p3-unified.mjs`
  - `ai/context/assembler.mjs`
  - `docs/ai-core.md`
  - `docs/p2-assembler-verification.md`
  - `server.js`

### P3 · 检索覆盖面 + 凡裁剪必可查回（I4）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3——改动改在同一批代码里，撤不干净
- **说明**：检索桶加在 server.js 的 search()、查回路径在 layers.mjs 的 RETRIEVAL；分别与 P2/P5 共享文件。
- **验收证据**：`docs/p3-retrieval-verification.md`、`.p1-baseline/verify-retrieval.mjs`、`.p1-baseline/verify-plugin-tools.mjs`
- **本阶段认领的文件**（5 个）：
  - `.p1-baseline/verify-plugin-tools.mjs`
  - `.p1-baseline/verify-retrieval.mjs`
  - `docs/p3-retrieval-verification.md`
  - `public/app.js`
  - `server.js`

### P4 · 通道收敛 + 单点策略表

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - ai/policy.mjs 被**生产代码** db.js（P5/Z3）import——撤掉会打断线上路径
  - ai/policy.mjs 被**生产代码** harness.js（P0/Z1）import——撤掉会打断线上路径
  - ai/policy.mjs 被**生产代码** server.js（P2/P3/P5/Z2/Z3）import——撤掉会打断线上路径
  - 文件 docs/p4-policy-verification.md 同时属于 P4/S——改动改在同一批代码里，撤不干净
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3——改动改在同一批代码里，撤不干净
- **说明**：策略单点化本身可撤（恢复各处字面量），但 ai/policy.mjs 被 harness.js 与 server.js import，前端与 server.js 又被 P3/P5 共同修改 → 无法只撤 P4。
- **验收证据**：`docs/p4-policy-verification.md`、`ai/policy.mjs`、`.p1-baseline/verify-ai-branches.mjs`、`.p1-baseline/test-model-switch-gate.mjs`
- **本阶段认领的文件**（6 个）：
  - `.p1-baseline/test-model-switch-gate.mjs`
  - `.p1-baseline/verify-ai-branches.mjs`
  - `ai/policy.mjs`
  - `docs/p4-policy-verification.md`
  - `public/app.js`
  - `server.js`

### P5 · 记忆语义压缩 + 效果埋点

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - ai/edit-distance.mjs 被**生产代码** server.js（P2/P3/P4/Z2/Z3）import——撤掉会打断线上路径
  - 文件 db.js 同时属于 P5/Z3——改动改在同一批代码里，撤不干净
  - db.js 被 .p1-baseline/probe-recall-direct.mjs（验收工具，P1）import——撤掉会让该工具失效
  - db.js 被**生产代码** ai/story-state/store.mjs（Z3）import——撤掉会打断线上路径
  - db.js 被**生产代码** openviking-sync.js（D8）import——撤掉会打断线上路径
  - db.js 被**生产代码** server.js（P2/P3/P4/Z2/Z3）import——撤掉会打断线上路径
- **说明**：建表是增量迁移（向后兼容），但埋点挂钩落在 server.js 与 public/app.js（与 P3/P4 共享），ai/edit-distance.mjs 还被 server.js import → 无法只撤 P5。
- **验收证据**：`docs/p5-memory-eval-verification.md`、`ai/edit-distance.mjs`、`.p1-baseline/test-edit-distance.mjs`、`.p1-baseline/verify-eval-metric.mjs`
- **本阶段认领的文件**（7 个）：
  - `.p1-baseline/test-edit-distance.mjs`
  - `.p1-baseline/verify-eval-metric.mjs`
  - `ai/edit-distance.mjs`
  - `db.js`
  - `docs/p5-memory-eval-verification.md`
  - `public/app.js`
  - `server.js`

### P6 · 一次性切换（工具就绪，**未执行**）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - .p6-cutover/snapshot.mjs 被 .p1-baseline/verify-phase-map.mjs（验收工具，X/Z3）import——撤掉会让该工具失效
  - ai/harness-env.mjs 被 .p1-baseline/exp-concurrent-models.mjs（验收工具，D8/Z1）import——撤掉会让该工具失效
  - ai/harness-env.mjs 被 .p1-baseline/test-agent-memory-guard.mjs（验收工具，D8）import——撤掉会让该工具失效
  - ai/harness-env.mjs 被 .p1-baseline/test-harness-env.mjs（验收工具，X）import——撤掉会让该工具失效
  - ai/harness-env.mjs 被**生产代码** harness.js（P0/Z1）import——撤掉会打断线上路径
- **说明**：切换器与快照工具本身是自足的、可单独移除；但 P6 还含 ai/harness-env.mjs，而它被 harness.js 与 .p1-baseline/test-harness-env.mjs import → 整段仍无法单独撤回。 harness.js 的默认 profile 仍是 headless（未切换）。
- **验收证据**：`.p6-cutover/cutover.mjs`、`.p6-cutover/snapshot.mjs`、`.p6-cutover/smoke.mjs`、`.p6-cutover/README.md`、`docs/p6-cutover-runbook.md`
- **本阶段认领的文件**（10 个）：
  - `.p6-cutover/.gitignore`
  - `.p6-cutover/README.md`
  - `.p6-cutover/cutover.mjs`
  - `.p6-cutover/smoke.mjs`
  - `.p6-cutover/snapshot.mjs`
  - `.p6-cutover/test-cutover.mjs`
  - `.p6-cutover/test-snapshot.mjs`
  - `ai/harness-env.mjs`
  - `docs/p6-cutover-runbook.md`
  - `docs/self-review-p0-p6.md`

### D8 · 不足清单修复（D8-#1…#8）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/exp-concurrent-models.mjs 同时属于 D8/Z1——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-memory-compress-guard.mjs 同时属于 D8/Z2——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-recall-gap.mjs 同时属于 D8/Z2——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-task-settings.mjs 同时属于 D8/Z1——改动改在同一批代码里，撤不干净
  - ai/context/cache.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3）import——撤掉会打断线上路径
  - ai/memory-compress-guard.mjs 被 .p1-baseline/test-memory-compress-guard.mjs（验收工具，Z2）import——撤掉会让该工具失效
- **说明**：D8 是对"不足清单"的逐条修复，与 P0–P6 同处一批文件：server.js 已被 P2–P5 认领，ai/context/layers.mjs 属 P1，所以 D8 的代码同样**不能单独撤回**。 它独有认领的只有 openviking-sync.js（此前无人认领）与两个新内核模块。
- **验收证据**：`.p1-baseline/test-recall-gap.mjs`、`.p1-baseline/test-sync-gate.mjs`、`.p1-baseline/test-context-cache.mjs`、`.p1-baseline/exp-per-task-settings.mjs`、`.p1-baseline/revert-matrix.mjs`
- **本阶段认领的文件**（32 个）：
  - `.p1-baseline/b-novel-home-20260916131653.json`
  - `.p1-baseline/blind-ab.mjs`
  - `.p1-baseline/check-utf8.mjs`
  - `.p1-baseline/compare-runtime-trees.mjs`
  - `.p1-baseline/d7-orphan-manifest-20260916124031.json`
  - `.p1-baseline/d7-purge-orphans.mjs`
  - `.p1-baseline/d7-purge-result-20260916124031.json`
  - `.p1-baseline/exp-concurrent-models.mjs`
  - `.p1-baseline/exp-per-task-settings.mjs`
  - `.p1-baseline/extract-session-lines.mjs`
  - `.p1-baseline/install-novel-home.mjs`
  - `.p1-baseline/probe-d7-and-cast.mjs`
  - `.p1-baseline/probe-entity-variants.mjs`
  - `.p1-baseline/probe-ov-indexed-at.mjs`
  - `.p1-baseline/quality-sentinel.mjs`
  - `.p1-baseline/revert-matrix.mjs`
  - `.p1-baseline/scan-session-keywords.mjs`
  - `.p1-baseline/test-agent-memory-guard.mjs`
  - `.p1-baseline/test-context-cache.mjs`
  - `.p1-baseline/test-memory-compress-guard.mjs`
  - `.p1-baseline/test-recall-gap.mjs`
  - `.p1-baseline/test-sync-gate.mjs`
  - `.p1-baseline/test-task-settings.mjs`
  - `.p1-baseline/verify-auto-compress.mjs`
  - `.p1-baseline/verify-guard-on-real-output.mjs`
  - `.p1-baseline/verify-named-jobs.mjs`
  - `ai/context/cache.mjs`
  - `ai/memory-compress-guard.mjs`
  - `ai/sync-gate.mjs`
  - `ai/task-settings.mjs`
  - `docs/self-review-2026-09-16.md`
  - `openviking-sync.js`

### X · 跨阶段：总纲与工具入口

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/audit-llm-calls.mjs 同时属于 X/Z2——改动改在同一批代码里，撤不干净
  - .p1-baseline/audit-llm-calls.mjs 被 .p0-recon/capture-dsh-request.mjs（验收工具，P0/Z1）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/audit-llm-calls.mjs（验收工具，Z2）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/verify-all.mjs（验收工具，Z2/Z3）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/verify-guard-on-real-output.mjs（验收工具，D8）import——撤掉会让该工具失效
  - .p1-baseline/blackhole.mjs 被 .p0-recon/capture-dsh-request.mjs（验收工具，P0/Z1）import——撤掉会让该工具失效
- **说明**：验收工具与总纲；单独撤回只会让验收能力变弱，不影响线上行为——但注意 X 内部彼此 import（verify-all ↔ 各工具），且被 .p0-recon 的线路层工具引用。
- **验收证据**：`.p1-baseline/verify-all.mjs`、`.p1-baseline/README.md`、`docs/README.md`
- **本阶段认领的文件**（34 个）：
  - `.p1-baseline/.gitignore`
  - `.p1-baseline/README.md`
  - `.p1-baseline/audit-llm-calls.mjs`
  - `.p1-baseline/blackhole.mjs`
  - `.p1-baseline/census.mjs`
  - `.p1-baseline/compare-memory-hint.mjs`
  - `.p1-baseline/diff-log-noise.mjs`
  - `.p1-baseline/diff-real-db.mjs`
  - `.p1-baseline/gate-env.mjs`
  - `.p1-baseline/incident-evidence-app-log-2026-09-15.md`
  - `.p1-baseline/incident-evidence-app-log-2026-09-15.raw.txt`
  - `.p1-baseline/probe-live.mjs`
  - `.p1-baseline/read-dsh-session.mjs`
  - `.p1-baseline/test-gate-assert.mjs`
  - `.p1-baseline/test-harness-env.mjs`
  - `.p1-baseline/verify-all.mjs`
  - `.p1-baseline/verify-harness-gate.mjs`
  - `.p1-baseline/verify-layer-constants.mjs`
  - `.p1-baseline/verify-main-instance.mjs`
  - `.p1-baseline/verify-memory-hint.mjs`
  - `.p1-baseline/verify-model-slot.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `.p1-baseline/verify-retrieval-map.mjs`
  - `README.md`
  - `ai/README.md`
  - `ai/context/README.md`
  - `assets/screenshot-writing.png`
  - `docs/README.md`
  - `docs/final-acceptance-p0-p6.md`
  - `docs/pending-decisions.md`
  - `docs/phase-map.md`
  - `docs/新手入门.md`
  - `package.json`
  - `start-novel-studio.cmd`

### S · 2026-09-18 会话：模型统一 V4.1 Flash + 写作路径提速 + 环境自检接线

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/fake-llm.mjs 同时属于 S/Z2——改动改在同一批代码里，撤不干净
  - .p1-baseline/fake-llm.mjs 被 .p1-baseline/golden-novel.mjs（验收工具，Z3）import——撤掉会让该工具失效
  - 文件 .p1-baseline/probe-cold-start.mjs 同时属于 S/Z2——改动改在同一批代码里，撤不干净
  - 文件 ai/harness-pool.mjs 同时属于 S/Z2——改动改在同一批代码里，撤不干净
  - debug-trace.js 被**生产代码** harness.js（P0/Z1）import——撤掉会打断线上路径
  - debug-trace.js 被**生产代码** openviking-sync.js（D8）import——撤掉会打断线上路径
- **说明**：本会话改动落在已被 P0–P6/D8 认领的共享文件里（server.js / public/app.js / harness.js / ai/policy.mjs / db.js），所以**不能单独回滚**：撤掉 openviking.js 会打断 server.js 的启动路径，撤掉 logger.js/debug-trace.js 会打断全仓日志与追踪。完整回滚用改动前的快照（data/backup-model-flash-*、data/backup-novice-guide-*、data/backup-batchD-*）。
- **验收证据**：`.p1-baseline/test-policy-tiers.mjs`、`env-tools-test.mjs`、`.p1-baseline/test-harness-pool.mjs`、`.p1-baseline/mutation-check-harness-pool.mjs`、`docs/self-review-2026-09-18.md`
- **本阶段认领的文件**（24 个）：
  - `.p1-baseline/fake-llm.mjs`
  - `.p1-baseline/mutation-check-harness-pool.mjs`
  - `.p1-baseline/probe-cold-start.mjs`
  - `.p1-baseline/probe-sdk-runtime.mjs`
  - `.p1-baseline/setup-novel-sdk-profile.mjs`
  - `.p1-baseline/test-dsh-launch.mjs`
  - `.p1-baseline/test-harness-pool.mjs`
  - `.p1-baseline/test-policy-tiers.mjs`
  - `ai/harness-pool.mjs`
  - `ai/harness-sdk-worker.mjs`
  - `api-test-suite.mjs`
  - `debug-trace.js`
  - `docs/CHANGELOG.md`
  - `docs/agent-change-review-2026-09-13.md`
  - `docs/context-memory-analysis-report.md`
  - `docs/context-optimization-review-report.md`
  - `docs/p4-policy-verification.md`
  - `docs/self-review-2026-09-18.md`
  - `env-tools-test.mjs`
  - `frontend-test.mjs`
  - `logger.js`
  - `openviking.js`
  - `public/index.html`
  - `public/styles.css`

### T · 2026-09-19 轮：全仓代码审查与修复（Q1/Q2/Q4 + R1/R2 + O1/O2/C1/F1）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - zip-reader.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3）import——撤掉会打断线上路径
- **说明**：本轮改动的主体落在**已被 P2–P5 认领的共享文件**里（server.js 的 compressStoryMemory / agentMemoryGuardOf / getPath，public/app.js 的 directAIWrite / streamAIDirectWrite / loadAIContext / aiContextBlock）与**已被 S 认领的** frontend-test.mjs，所以主体**不能单独回滚**：撤掉 Q1/Q2 会退回"出场判定只读章节头部"，压缩摘要可以静默丢实体、并喂给之后每一章；撤掉 Q4 会让前端重新拿无预算的旧拼装喂进约 7.4 万字。本阶段唯一可单独撤的是 zip-reader.mjs 的两个上限常量（撤掉=回到无上限解压，不影响其它阶段）。完整回滚用改动前的快照 `data/backup-review-v096-*`（12 个受影响文件，逐文件同构还原；该目录在 .gitignore 内，不进仓库）。
- **验收证据**：`docs/code-review-2026-09-19-summary.md`
- **本阶段认领的文件**（3 个）：
  - `docs/code-review-2026-09-19-summary.md`
  - `docs/code-review-2026-09-19.md`
  - `zip-reader.mjs`

### U · 2026-09-20 轮：接管被中断的第二轮审查（护栏作用范围 + 下限自适应 + 兼容性检查）

- **回滚方式**：可独立回滚
- **说明**：⚠️ **本轮含一处真正的产品行为变更，不能单独回滚**：AI 自压缩的长期记忆摘要，字数下限不再固定 100 字，改为按作品规模自适应（`minCharsForStory`：篇幅分档 100→640，与"必须保留实体数 × 16 字"取 max，封顶 640 以不超过下游"≤800 字"产出目标）。撤掉它 = 长篇可以"名字全写上、剧情/伏笔/角色状态全丢光"照样过闸——那正是用户 2026-09-20 判定不成立的旧行为。另两处同属本轮的改动也在这条线上：`settleProposals` 只对带 `guard='agent'` 的提案设闸（此前对所有提案设闸，把普通短提案一并拒掉），以及 `db.js` 给 `story_memory_proposals` 增加 `guard` 列（来源标记必须跨落库存活）。完整回滚用改动后快照 `data/backup-round2-final-*`（5 个文件逐字节副本）；只回到"第 2 步已验证版本"用 `data/backup-step3-preopt-*`。两个目录都在 .gitignore 内。
- **验收证据**：`docs/code-review-2026-09-19-round2-summary.md`
- **本阶段认领的文件**（1 个）：
  - `docs/code-review-2026-09-19-round2-summary.md`

### V · 2026-09-21 轮：双稿对照诊断 + 写作机制补齐（terms 层/未来章标记/场景预算/质检扩面） + 第 6 章定稿

- **回滚方式**：可独立回滚
- **说明**：terms 上下文层（cap 800、关键词/优先级抽选、查回路径）、未来章【禁止写入】标记式渲染、成文轮场景预算（3–5 场景）与质检扩面（未来章/未登记实体/有效场景数）、style_positive 新增两条（物件密度/系统独白≤3 句）、七项验收清单固化为 docs/chapter-acceptance-checklist.md；作品 18 第 6 章已按 3800–4200 字合成定稿（3897 字，4 处冲突清零）。两份来源 docx 未改动；未提交 git。
- **验收证据**：`docs/chapter-acceptance-checklist.md`
- **本阶段认领的文件**（1 个）：
  - `docs/chapter-acceptance-checklist.md`

### W · 2026-09-21 轮：仓库展示面与开源文档（README 首页重写 + 社区文件 + 仓库级 Topics/Description）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 CONTRIBUTING.md 同时属于 W/Z2——改动改在同一批代码里，撤不干净
- **说明**：仓库展示面优化：README 首页重写（第一屏改为「30 秒讲清价值 + 它不做什么」，安装步骤紧随其后；原 30 行的「分支说明」块压到 2 行；新增环境变量配置表、Roadmap、参与贡献、License 说明与目录），旧 README 里写法成熟的章节按行**原样**保留（用重组脚本拼接，不手抄，避免中文正文抄写漂移）。README.md 已由更早阶段认领，故不重复列出；仓库级 Description 与 Topics 通过 GitHub API 写入，属于仓库设置而非文件，不进 git。
- **验收证据**：`CONTRIBUTING.md`、`.github/ISSUE_TEMPLATE/bug_report.yml`
- **本阶段认领的文件**（5 个）：
  - `.github/ISSUE_TEMPLATE/bug_report.yml`
  - `.github/ISSUE_TEMPLATE/config.yml`
  - `.github/ISSUE_TEMPLATE/feature_request.yml`
  - `.github/pull_request_template.md`
  - `CONTRIBUTING.md`

### W2 · 2026-09-26 轮：开源展示面优化（Why 对比表 + 架构数据流 + 英文关键词 + License 检测修正）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 LICENSE 同时属于 W2/Z2——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2——改动改在同一批代码里，撤不干净
  - 文件 vendor/README.md 同时属于 W2/Z0/Z2——改动改在同一批代码里，撤不干净
- **说明**：展示面优化：README 新增「为什么是这套机制」对比表（通用对话式工具 vs 本项目）与「一次成文请求的数据流」架构图、第一屏加英文关键词行（GitHub 搜索与英文读者理解）、补上此前未被引用的 assets/preview.png 截图、把 CI 条数口径从 31 校正为实测 32；把第三方组件声明从 LICENSE 移出到 THIRD-PARTY-NOTICES.md——原因是附加中文声明会让 GitHub licensee 把整个仓库判成 spdx=NOASSERTION（显示 "Other" 而不是 MIT），移出后 LICENSE 只含标准 MIT 全文。仓库级 Description 与 Topics 经 GitHub API 写入，属仓库设置而非文件，不进 git。
- **验收证据**：`README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`
- **本阶段认领的文件**（4 个）：
  - `LICENSE`
  - `README.md`
  - `THIRD-PARTY-NOTICES.md`
  - `vendor/README.md`

### Y · 2026-09-22 轮：按复核报告落地「确定性连续性预检」（审稿前先算掉机器能判的部分）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - ai/continuity-guard-source.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3）import——撤掉会打断线上路径
  - ai/continuity-guard.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3）import——撤掉会打断线上路径
- **说明**：本轮的**行为改动**落在已被 P2–P5 认领的 `server.js`（两条端点 + `app_settings` 读写）、已被 S 认领的 `public/app.js`（预检块 + 内联进审稿提示词）与 `api-test-suite.mjs`（F11–F16）里，所以整轮**不能单独回滚**：撤掉 `ai/continuity-guard*.mjs` 会让 server.js 的 import 当场失败（启动即崩）。可单独撤的只有那份说明书本身。 另外这轮**刻意不改任何作品数据**：`chapters.target_words`、角色卡状态、风格文本一律原样——判据里报出来的「口径冲突」正是要交回作者决定的事（报告 C6），工具只负责把冲突摆到台面上。
- **验收证据**：`docs/continuity-guard.md`、`.p1-baseline/test-continuity-guard.mjs`、`.p1-baseline/verify-continuity-guard-on-real-data.mjs`
- **本阶段认领的文件**（6 个）：
  - `.p1-baseline/test-continuity-guard.mjs`
  - `.p1-baseline/verify-continuity-guard-on-real-data.mjs`
  - `ai/continuity-guard-source.mjs`
  - `ai/continuity-guard.mjs`
  - `docs/confirmation-resolution-2026-09-22.md`
  - `docs/continuity-guard.md`

### Z0 · 2026-09-24 轮：OpenViking 本地向量模型随源码分发（vendor）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 README.md 同时属于 X/W2/Z0/Z2——改动改在同一批代码里，撤不干净
  - 文件 docs/README.md 同时属于 X/Z0/Z2/Z5——改动改在同一批代码里，撤不干净
  - 文件 vendor/README.md 同时属于 W2/Z0/Z2——改动改在同一批代码里，撤不干净
- **说明**：回滚口径（诚实版，分两层）：① **资产层可独立撤**——这几个文件不被任何生产代码 import（只有文档引用路径），删掉 vendor/ 与拉取脚本后产品照常启动，代价只是「服务端不需要联网下模型」这条能力消失（OpenViking 会退回它自己的默认行为：首次启动去 HuggingFace 下载，本机必然失败）。② **文件层不可单独回滚**——README.md / docs/README.md 与 X/Z2 改在同一批文件里，而且撤掉资产后那两行指路会变成死链，必须同批处理。 校验口径以 vendor/README.md 里那张表为准（SHA256）；镜像返回的 ETag 与真实内容**不一致**，别拿 ETag 当校验。**已定案（2026-09-25）：该二进制随仓库提交**（代价：每次 clone +47.9MB；本轮提交时一并 `git add`；不想要就删掉 `vendor/models/`，产品照常启动，只是「离线可用」这条能力随之消失）。
- **验收证据**：`vendor/README.md`、`docs/openviking-embedding-setup.md`、`scripts/fetch-embedding-model.mjs`
- **本阶段认领的文件**（8 个）：
  - `.gitattributes`
  - `.gitignore`
  - `README.md`
  - `docs/README.md`
  - `docs/openviking-embedding-setup.md`
  - `scripts/fetch-embedding-model.mjs`
  - `vendor/README.md`
  - `vendor/models/bge-small-zh-v1.5-f16.gguf`

### Z1 · 2026-09-24 轮：DSH 0.1.7 迁移（默认模型改走补丁层 + 一次性导入的诊断）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p0-recon/capture-dsh-request.mjs 同时属于 P0/Z1——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/exp-concurrent-models.mjs 同时属于 D8/Z1——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-task-settings.mjs 同时属于 D8/Z1——改动改在同一批代码里，撤不干净
  - 文件 ai/README.md 同时属于 X/Z1——改动改在同一批代码里，撤不干净
  - 文件 ai/task-settings.mjs 同时属于 D8/Z1——改动改在同一批代码里，撤不干净
  - ai/task-settings.mjs 被 .p1-baseline/exp-concurrent-models.mjs（验收工具，D8）import——撤掉会让该工具失效
- **说明**：**不能单独回滚**：harness.js 被 server.js 的 AI 路径 import，ai/task-settings.mjs 被 harness.js import，而这两个文件同时被 P0/D8 改过（同一批函数）。撤掉它 = 退回「改写全局 settings + 互斥」的旧路径——那会让服务端允许 2 并发而实际吞吐只有 1，而且任务崩在中间时用户的默认模型会停在被改写状态。 0.1.7 的**两处硬语义**（写成想当然就会静默不生效）：① 补丁层对 config 是**整体替换**不是深合并；② provider 是 agent-default-model 的**必填**字段。另外上游有个实测复现的缺陷：启动时带着覆盖 agent-default-model 的补丁层，settings.yaml → profile 的一次性导入会**静默失败**（原值只剩在 .imported 里）——工坊只**告警**不擅自迁移（改用户的持久配置是 dsh 的职责）。 完整回滚用改动前快照（取证与清单见 .dsh-upgrade-recon/00-SUMMARY.md）。
- **验收证据**：`.p1-baseline/test-task-settings.mjs`、`.p1-baseline/exp-concurrent-models.mjs`、`ai/task-settings.mjs`
- **本阶段认领的文件**（11 个）：
  - `.p0-recon/capture-dsh-request.mjs`
  - `.p1-baseline/exp-concurrent-models.mjs`
  - `.p1-baseline/test-task-settings.mjs`
  - `ai/README.md`
  - `ai/task-settings.mjs`
  - `docs/ai-core.md`
  - `docs/context-memory-analysis-report.md`
  - `docs/phase-map.md`
  - `harness-plugins/novel-writing/ENGINE.md`
  - `harness-plugins/novel-writing/cordis.patch.yml`
  - `harness.js`

### Z2 · 2026-09-24/25 轮：主体 V2 —— 上下文身份/完整性/溯源 + 压缩输入修复 + CI

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/audit-llm-calls.mjs 同时属于 X/Z2——改动改在同一批代码里，撤不干净
  - .p1-baseline/audit-llm-calls.mjs 被 .p0-recon/capture-dsh-request.mjs（验收工具，P0/Z1）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/audit-llm-calls.mjs（验收工具，X）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/test-gate-assert.mjs（验收工具，X）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/verify-all.mjs（验收工具，X/Z3）import——撤掉会让该工具失效
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/verify-guard-on-real-output.mjs（验收工具，D8）import——撤掉会让该工具失效
- **说明**：**不能单独回滚**：integrity.mjs / tokens.mjs 被装配器与 server.js import，装配器与 server.js 又被 P2–P5 改过（同一批函数）。撤掉会让启动路径当场失败。 本轮的**意图**是「同样的上下文内容，但可被追问、可被核对」：① 每层有溯源与查回路径；② 清单与真正发出去的文字逐字节对齐（C1）+ 内容哈希（C6）；③ 身份（内容哈希 / 请求 id）随两条端点下发；④ 顺带修掉一个真实缺陷——压缩提示词引用了已被删除的 SQL 别名（content_head/content_tail），导致「最近章节正文」**恒为空**，无摘要章节只剩标题。 质量红线：这轮**没有**改模型、prompt 语义、reasoning effort、token 预算，也没有减少任何上下文；逐字节基线 50/50 相同（对照副本是改动前的整树快照，核对完即删；可复现的那份是 .p1-baseline/baselines-before-v2/ 与 baselines-v2b/）。详见 docs/main-v2-upgrade-2026-09-24.md。
- **验收证据**：`docs/context-contract.md`、`.p1-baseline/test-context-manifest.mjs`、`.p1-baseline/test-memory-compress-prompt.mjs`、`.github/workflows/ci.yml`、`scripts/ci-offline-checks.mjs`、`docs/main-v2-upgrade-2026-09-24.md`
- **本阶段认领的文件**（35 个）：
  - `.github/workflows/ci.yml`
  - `.p1-baseline/audit-llm-calls.mjs`
  - `.p1-baseline/bench-context-build.mjs`
  - `.p1-baseline/fake-llm.mjs`
  - `.p1-baseline/probe-cold-start.mjs`
  - `.p1-baseline/probe-harness-tool-loop.mjs`
  - `.p1-baseline/test-context-manifest.mjs`
  - `.p1-baseline/test-host-contract.mjs`
  - `.p1-baseline/test-memory-compress-guard.mjs`
  - `.p1-baseline/test-memory-compress-prompt.mjs`
  - `.p1-baseline/test-recall-gap.mjs`
  - `.p1-baseline/verify-all.mjs`
  - `.p1-baseline/verify-memory-compress-input.mjs`
  - `CONTRIBUTING.md`
  - `LICENSE`
  - `README.md`
  - `ai/context/assembler.mjs`
  - `ai/context/integrity.mjs`
  - `ai/context/layers.mjs`
  - `ai/context/tokens.mjs`
  - `ai/harness-pool.mjs`
  - `ai/memory-compress-prompt.mjs`
  - `docs/README.md`
  - `docs/ai-core.md`
  - `docs/context-contract.md`
  - `docs/host-contract.md`
  - `docs/host-contract.v1.json`
  - `docs/main-v2-acceptance-2026-09-25.md`
  - `docs/main-v2-upgrade-2026-09-24.md`
  - `harness-plugins/novel-writing/test/smoke.mjs`
  - `scripts/ci-isolated-run.mjs`
  - `scripts/ci-offline-checks.mjs`
  - `server.js`
  - `text-utils.js`
  - `vendor/README.md`

### Z3 · 2026-09-26 轮：确定性故事状态内核（门控层 + 10 张新表 + 18 条状态路由 + 8 工具）+ 第五步 Golden Novel 联合回归

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-context-manifest.mjs 同时属于 Z2/Z3——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-host-contract.mjs 同时属于 Z2/Z3——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-all.mjs 同时属于 X/Z2/Z3——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3——改动改在同一批代码里，撤不干净
  - 文件 ai/context/assembler.mjs 同时属于 P2/Z2/Z3——改动改在同一批代码里，撤不干净
  - ai/context/assembler.mjs 被 .p1-baseline/test-assembler.mjs（验收工具，P2）import——撤掉会让该工具失效
- **说明**：**不能单独回滚**：内核被 server.js、层规格与插件工具面同时引用，而那三处又是 P1–P6 / Z2 改过的同一批函数。 本轮的**设计前提**是「机制生效 ≠ 强制接入」：作品开关 story_state_config.enabled 默认 0，未开启时该层不进 manifest、不进 excluded、不计入可执行下限（floor(settings) 仍 = 18173）。 质量红线：本轮**没有**改模型、prompt 语义、reasoning effort、token 预算、层顺序与默认 AI route；逐字节上下文基线 **50/50 相同**；活实例断言「开启后只多一层且其余各层 emitted 逐层相同」。 详见 docs/story-state-kernel-2026-09-26.md。 第五步 Golden Novel 联合回归（19 类难 case）另抓到并修掉两处真实缺陷：① character_knowledge 的 upsert 少了部分唯一索引的 WHERE 谓词 → 角色知识边界整条路不可用（S14 回归 + 变异对照）；② knowledgeOf 的 unknown/suspected/false_belief 可见窗口方向反了 → 最需要提醒的章节反而看不见（S15 回归 + 变异对照）。 另补 GET /api/novel/state/facts（契约 1.1.0 → 1.2.0，附加式）。详见 docs/golden-novel-regression-2026-09-26.md。
- **验收证据**：`docs/story-state-kernel-2026-09-26.md`、`docs/host-contract-1.1-2026-09-26.md`、`.p1-baseline/test-story-state-api.mjs`、`.p1-baseline/golden-novel.mjs`、`.p1-baseline/golden-out.json`、`docs/golden-novel-regression-2026-09-26.md`、`docs/host-contract.v1.json`
- **本阶段认领的文件**（36 个）：
  - `.p1-baseline/golden-novel.mjs`
  - `.p1-baseline/golden-out.json`
  - `.p1-baseline/test-context-manifest.mjs`
  - `.p1-baseline/test-host-contract.mjs`
  - `.p1-baseline/test-story-state-api.mjs`
  - `.p1-baseline/verify-all.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `ai/context/assembler.mjs`
  - `ai/context/layers.mjs`
  - `ai/story-state/canon.mjs`
  - `ai/story-state/contract.mjs`
  - `ai/story-state/entities.mjs`
  - `ai/story-state/foreshadow.mjs`
  - `ai/story-state/hash.mjs`
  - `ai/story-state/index.mjs`
  - `ai/story-state/injection.mjs`
  - `ai/story-state/knowledge.mjs`
  - `ai/story-state/preflight.mjs`
  - `ai/story-state/proposal.mjs`
  - `ai/story-state/semantic-context.mjs`
  - `ai/story-state/state-machine.mjs`
  - `ai/story-state/store.mjs`
  - `ai/story-state/style-quality.mjs`
  - `ai/story-state/timeline.mjs`
  - `db.js`
  - `docs/golden-novel-regression-2026-09-26.md`
  - `docs/host-contract-1.1-2026-09-26.md`
  - `docs/host-contract.md`
  - `docs/host-contract.v1.json`
  - `docs/phase-map.md`
  - `docs/story-state-kernel-2026-09-26.md`
  - `harness-plugins/novel-writing/ENGINE.md`
  - `harness-plugins/novel-writing/novel-tools.mjs`
  - `harness-plugins/novel-writing/package.json`
  - `harness-plugins/novel-writing/plugin.json`
  - `server.js`

### Z4 · 2026-09-25 轮：DSH 0.1.7-rc.1 → rc.2 兼容性审查（报告 + 只读探针）

- **回滚方式**：可独立回滚
- **说明**：纯文档 + 只读探针，**不碰产品代码**：整批删除后工坊行为逐字节不变，故可独立回滚。 内容是把 dsh 0.1.7-rc.1 → rc.2 的能力差异、插件面、novel_* 工具面与工作坊兼容性实测逐条落到文档，供后续升级引用。 ⚠️ 其中一条结论的前提**不是 stock RC.2**：全局 RC.2 的 cordis.patch.yml 被本地追加了 npm 上 404 的私有包 （@deepseek-ai/dsh-operation-security），引用这批结论时必须单列这一条。 同轮的产品侧修复（超长 prompt 走 stdin）另记在 docs/HARNESS_ARGV_LIMIT_FIX.md 与 Z5 相邻的条目里。
- **验收证据**：`docs/DSH_0.1.7_RC1_RC2_NOVEL_COMPATIBILITY_REPORT.md`、`.p1-baseline/.realtest/probe-config.mjs`
- **本阶段认领的文件**（8 个）：
  - `.p1-baseline/.realtest/probe-config.mjs`
  - `.p1-baseline/.realtest/probe-schema.mjs`
  - `docs/DSH_0.1.7_RC1_RC2_API_DIFF.md`
  - `docs/DSH_0.1.7_RC1_RC2_COMPATIBILITY_MATRIX.md`
  - `docs/DSH_0.1.7_RC1_RC2_NOVEL_COMPATIBILITY_REPORT.md`
  - `docs/DSH_0.1.7_RC1_RC2_NOVEL_PLUGIN_TEST_REPORT.md`
  - `docs/DSH_RC1_COMPATIBILITY_BASELINE.md`
  - `docs/RC1_vs_RC2_CAPABILITY_MATRIX.md`

### Z5 · 2026-09-25 轮：成文耗时测量层（口径 A 机器时间 / 口径 B 交付时间 的埋点补真）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 docs/README.md 同时属于 X/Z0/Z2/Z5——改动改在同一批代码里，撤不干净
  - 文件 frontend-test.mjs 同时属于 S/Z5——改动改在同一批代码里，撤不干净
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5——改动改在同一批代码里，撤不干净
- **说明**：**不能单独回滚**：public/app.js 是 P2–P5 / Z2 / Z3 反复改过的同一个文件。 本轮两件事，都是附加式：① 成文耗时测量层——新增 newWriteTiming() 分轮耗时账本；streamAIDirectWrite 多返回 ms/ttftMs； runHarnessJob 多返回客户端观测 ms；三处 showAIWritingResult 传入真实 channel/model/ms/timing （此前从未传过，导致 ai_eval_events 的 ms 恒为 0、channel/model 恒为空串）， 并附加一条 app_logs kind=ai_write_timing（含分轮明细与 draft_key）；② 超长 prompt 走 argv 触发 spawn ENAMETOOLONG 的修复（仅 Windows、仅超长时改走 dsh --profile novel - + stdin）——短/中文本与非 Windows 路径逐字不变，回滚只需把 useStdinPrompt 置 false。 质量红线：**没有**改模型、prompt 语义、上下文、reasoning effort、token 预算，也没有改任何生成分支的判断条件—— 测量值不参与决策，全部是附加字段。之所以走 app_logs 而不给 ai_eval_events 加列：避免 schema 迁移 与已冻结的 Host Contract 表清单变更（零迁移、零契约变更、零回滚风险）。 证据：frontend-test.mjs 新增 108h / 112a / 112b / 112c 四条断言（**既有期望值一字未改**）钉住 "埋点落库请求里就是真值"；任务设置离线 49/49、离线清单 32/32、API 186/190（0 失败）、插件冒烟 39/39 全绿。 详见 docs/ai-write-latency-plan.md 与 docs/HARNESS_ARGV_LIMIT_FIX.md。
- **验收证据**：`docs/ai-write-latency-plan.md`、`docs/HARNESS_ARGV_LIMIT_FIX.md`、`frontend-test.mjs`
- **本阶段认领的文件**（5 个）：
  - `docs/HARNESS_ARGV_LIMIT_FIX.md`
  - `docs/README.md`
  - `docs/ai-write-latency-plan.md`
  - `frontend-test.mjs`
  - `public/app.js`

## 三、归属核对

- 真实改动集：**241** 个文件
- 未被任何阶段认领：**0** 个

✓ 全部改动都有归属。
