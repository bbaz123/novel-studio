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
| **R** | 2026-09-27 增强交付 R01—R12（导入安全与导入后重建 / 剧情分支沙盘 / 披露派生视图 / 作者样文与三级意图 / 编辑规则 / 长正文处理 / 审批与整次采纳 / OV 召回来源边界 / 运行时上下文贡献记录） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **PI** | 2026-09-27 落地后独立重审（001.txt）：本轮修复 + 审计证据 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **L** | 2026-09-28 知识库专项：跨作品共享写作资料库（门控层 library + 导入链 + 模型侧查回） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **Z6** | 2026-09-29 方向驱动检索 + 索引层化（A–E）：direction 检索输入 / 资料索引 / 小说资产索引 / 检索计划 / 两类计数分开 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **G1** | 2026-09-29 轮：GitHub 增长面优化（英文 README 成为首页 + 中文 README 逐节对齐 + 真实界面截图 + 社区健康度文件） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **TT** | 时态故事状态重构（T0–T8：版本化状态底座、保存接线、影响分析、逐章重建、上下文与界面） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **V1** | 2026-10-02 轮：v1.0.0 审计修复轮的取证材料与新增离线门禁（文档 + 测试，不含产品代码） | ✅ 可独立回滚 |
| **G2** | 2026-10-02 轮：第二次 GitHub 展示面 / 增长优化（Description + Topics + 中英 README 首屏 + 文档索引与贡献者入口） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **SE** | 2026-10-07 第三批：Safe Editing 修稿安全门禁（确定性结构依赖 + 删除依赖 + 修后核验） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **SE4** | 2026-10-08 第四批：一致性判据（事实锁 / 跨段整句重复 / 转场桥）+ 保护规则接线 + 允许人味 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **SE5** | 2026-10-08 第五批：叙事结构机械感（同形流程 / 时间轴 / 群众反应 / 镜头越界）+ P0 场景要求矛盾修复 | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |
| **SE6** | 2026-10-09 第六批：叙事性专项修复（E00—E07：局部补丁执行正确性 / 阶段化规则 / 审稿与选择保真 / 叙事诊断 / 编辑计划 / 可解释报告） | ⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚 |

**可独立回滚的阶段：U、V、Z4、V1。**其余阶段要么与别的阶段改在同一批代码里，要么被生产代码 import——**要回滚就一起回滚**，或用 `.p6-cutover/snapshot.mjs` 的整体快照。

## 二、逐阶段明细

### P0 · 专用 dsh profile（novel）与插件 bundle 化

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p0-recon/capture-dsh-request.mjs 同时属于 P0/Z1——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/ENGINE.md 同时属于 P0/Z1/Z3/L/Z6——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/NATIVE_PLUGIN_GUIDE.md 同时属于 P0/L/Z6——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/README.md 同时属于 P0/L/Z6——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/agent.cordis.yml 同时属于 P0/L/Z6/SE5——改动改在同一批代码里，撤不干净
  - 文件 harness-plugins/novel-writing/cordis.patch.yml 同时属于 P0/Z1/L/Z6——改动改在同一批代码里，撤不干净
- **说明**：harness.js 同时被 P4/P6 改过；profile 本身的回滚是卸掉 novel profile 与 bundle 接线（install-profile.mjs 反向操作）。
- **验收证据**：`.p0-recon/README.md`、`.p0-recon/verify-harness-profile.mjs`、`.p0-recon/compare-composed.mjs`、`.p0-recon/novel.p3.txt`、`.p0-recon/capture-dsh-request.mjs`
- **本阶段认领的文件**（37 个）：
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
  - `.p0-recon/verify-fix-blueprint-vs-prose.mjs`
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
  - 文件 ai/context/layers.mjs 同时属于 P1/Z2/Z3/L——改动改在同一批代码里，撤不干净
  - ai/context/layers.mjs 被 .p1-baseline/golden-novel.mjs（验收工具，Z3）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-assembler.mjs（验收工具，P2）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-context-manifest.mjs（验收工具，Z2/Z3）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-recall-gap.mjs（验收工具，D8/Z2）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/verify-all.mjs（验收工具，X/Z2/Z3/TT）import——撤掉会让该工具失效
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
  - ai/context/assembler.mjs 被 .p1-baseline/test-context-shrink-cap.mjs（验收工具，V1）import——撤掉会让该工具失效
  - ai/context/assembler.mjs 被**生产代码** server.js（P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
  - 文件 docs/ai-core.md 同时属于 P2/Z1/Z2——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6——改动改在同一批代码里，撤不干净
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
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6——改动改在同一批代码里，撤不干净
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
  - ai/policy.mjs 被**生产代码** db.js（P5/Z3/L/Z6/TT/SE6）import——撤掉会打断线上路径
  - ai/policy.mjs 被**生产代码** harness.js（P0/Z1）import——撤掉会打断线上路径
  - ai/policy.mjs 被**生产代码** server.js（P2/P3/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
  - 文件 docs/p4-policy-verification.md 同时属于 P4/S——改动改在同一批代码里，撤不干净
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6——改动改在同一批代码里，撤不干净
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
  - ai/edit-distance.mjs 被**生产代码** server.js（P2/P3/P4/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
  - 文件 db.js 同时属于 P5/Z3/L/Z6/TT/SE6——改动改在同一批代码里，撤不干净
  - db.js 被 .p1-baseline/bench-library-index.mjs（验收工具，Z6）import——撤掉会让该工具失效
  - db.js 被 .p1-baseline/probe-recall-direct.mjs（验收工具，P1）import——撤掉会让该工具失效
  - db.js 被 .p1-baseline/test-library-index.mjs（验收工具，Z6）import——撤掉会让该工具失效
  - db.js 被**生产代码** ai/branch/store.mjs（R）import——撤掉会打断线上路径
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
  - .p6-cutover/snapshot.mjs 被 .p1-baseline/verify-phase-map.mjs（验收工具，X/Z3/TT/G2/SE/SE4/SE5/SE6）import——撤掉会让该工具失效
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
  - ai/context/cache.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
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
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/verify-all.mjs（验收工具，Z2/Z3/TT）import——撤掉会让该工具失效
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
  - debug-trace.js 被**生产代码** openviking-sync.js（D8/L/Z6）import——撤掉会打断线上路径
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
  - zip-reader.mjs 被 .p1-baseline/test-import-guard.mjs（验收工具，R）import——撤掉会让该工具失效
  - zip-reader.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
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
  - 文件 .github/ISSUE_TEMPLATE/config.yml 同时属于 W/G1——改动改在同一批代码里，撤不干净
  - 文件 CONTRIBUTING.md 同时属于 W/Z2/G1/G2——改动改在同一批代码里，撤不干净
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
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
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
  - ai/continuity-guard-source.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
  - ai/continuity-guard.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
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
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 docs/README.md 同时属于 X/Z0/Z2/Z5/Z6/G1/TT/G2——改动改在同一批代码里，撤不干净
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
  - .p1-baseline/audit-llm-calls.mjs 被 .p1-baseline/verify-all.mjs（验收工具，X/Z3/TT）import——撤掉会让该工具失效
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
  - 文件 .p1-baseline/test-host-contract.mjs 同时属于 Z2/Z3/TT——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-all.mjs 同时属于 X/Z2/Z3/TT——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 ai/context/assembler.mjs 同时属于 P2/Z2/Z3——改动改在同一批代码里，撤不干净
  - ai/context/assembler.mjs 被 .p1-baseline/test-assembler.mjs（验收工具，P2）import——撤掉会让该工具失效
- **说明**：**不能单独回滚**：内核被 server.js、层规格与插件工具面同时引用，而那三处又是 P1–P6 / Z2 改过的同一批函数。 本轮的**设计前提**是「机制生效 ≠ 强制接入」：作品开关 story_state_config.enabled 默认 0，未开启时该层不进 manifest、不进 excluded、不计入可执行下限（floor(settings) 仍 = 18173）。 质量红线：本轮**没有**改模型、prompt 语义、reasoning effort、token 预算、层顺序与默认 AI route；逐字节上下文基线 **50/50 相同**；活实例断言「开启后只多一层且其余各层 emitted 逐层相同」。 详见 docs/story-state-kernel-2026-09-26.md。 第五步 Golden Novel 联合回归（19 类难 case）另抓到并修掉两处真实缺陷：① character_knowledge 的 upsert 少了部分唯一索引的 WHERE 谓词 → 角色知识边界整条路不可用（S14 回归 + 变异对照）；② knowledgeOf 的 unknown/suspected/false_belief 可见窗口方向反了 → 最需要提醒的章节反而看不见（S15 回归 + 变异对照）。 另补 GET /api/novel/state/facts（契约 1.1.0 → 1.2.0，附加式）。详见 docs/golden-novel-regression-2026-09-26.md。
- **验收证据**：`docs/story-state-kernel-2026-09-26.md`、`docs/host-contract-1.1-2026-09-26.md`、`.p1-baseline/test-story-state-api.mjs`、`.p1-baseline/golden-novel.mjs`、`.p1-baseline/golden-out.json`、`docs/golden-novel-regression-2026-09-26.md`、`docs/host-contract.v1.json`
- **本阶段认领的文件**（59 个）：
  - `.p1-baseline/golden-novel.mjs`
  - `.p1-baseline/golden-out.json`
  - `.p1-baseline/test-context-manifest.mjs`
  - `.p1-baseline/test-host-contract.mjs`
  - `.p1-baseline/test-story-state-api.mjs`
  - `.p1-baseline/verify-all.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `ai/context/assembler.mjs`
  - `ai/context/layers.mjs`
  - `ai/story-state/approval.mjs`
  - `ai/story-state/canon.mjs`
  - `ai/story-state/contract.mjs`
  - `ai/story-state/disclosure.mjs`
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
  - `ai/story-state/temporal/analysis.mjs`
  - `ai/story-state/temporal/compat.mjs`
  - `ai/story-state/temporal/config.mjs`
  - `ai/story-state/temporal/context-provider.mjs`
  - `ai/story-state/temporal/dependencies.mjs`
  - `ai/story-state/temporal/event-store.mjs`
  - `ai/story-state/temporal/extraction.mjs`
  - `ai/story-state/temporal/history.mjs`
  - `ai/story-state/temporal/impact.mjs`
  - `ai/story-state/temporal/index.mjs`
  - `ai/story-state/temporal/migration.mjs`
  - `ai/story-state/temporal/order.mjs`
  - `ai/story-state/temporal/projection.mjs`
  - `ai/story-state/temporal/reducer.mjs`
  - `ai/story-state/temporal/revision-store.mjs`
  - `ai/story-state/temporal/schema.mjs`
  - `ai/story-state/temporal/service.mjs`
  - `ai/story-state/temporal/snapshot.mjs`
  - `ai/story-state/temporal/stmt.mjs`
  - `ai/story-state/temporal/validation.mjs`
  - `ai/story-state/temporal/worldline-store.mjs`
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
  - 文件 docs/README.md 同时属于 X/Z0/Z2/Z5/Z6/G1/TT/G2——改动改在同一批代码里，撤不干净
  - 文件 frontend-test.mjs 同时属于 S/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
- **说明**：**不能单独回滚**：public/app.js 是 P2–P5 / Z2 / Z3 反复改过的同一个文件。 本轮两件事，都是附加式：① 成文耗时测量层——新增 newWriteTiming() 分轮耗时账本；streamAIDirectWrite 多返回 ms/ttftMs； runHarnessJob 多返回客户端观测 ms；三处 showAIWritingResult 传入真实 channel/model/ms/timing （此前从未传过，导致 ai_eval_events 的 ms 恒为 0、channel/model 恒为空串）， 并附加一条 app_logs kind=ai_write_timing（含分轮明细与 draft_key）；② 超长 prompt 走 argv 触发 spawn ENAMETOOLONG 的修复（仅 Windows、仅超长时改走 dsh --profile novel - + stdin）——短/中文本与非 Windows 路径逐字不变，回滚只需把 useStdinPrompt 置 false。 质量红线：**没有**改模型、prompt 语义、上下文、reasoning effort、token 预算，也没有改任何生成分支的判断条件—— 测量值不参与决策，全部是附加字段。之所以走 app_logs 而不给 ai_eval_events 加列：避免 schema 迁移 与已冻结的 Host Contract 表清单变更（零迁移、零契约变更、零回滚风险）。 证据：frontend-test.mjs 新增 108h / 112a / 112b / 112c 四条断言（**既有期望值一字未改**）钉住 "埋点落库请求里就是真值"；任务设置离线 49/49、离线清单 32/32、API 186/190（0 失败）、插件冒烟 39/39 全绿。 详见 docs/ai-write-latency-plan.md 与 docs/HARNESS_ARGV_LIMIT_FIX.md。
- **验收证据**：`docs/ai-write-latency-plan.md`、`docs/HARNESS_ARGV_LIMIT_FIX.md`、`frontend-test.mjs`
- **本阶段认领的文件**（5 个）：
  - `docs/HARNESS_ARGV_LIMIT_FIX.md`
  - `docs/README.md`
  - `docs/ai-write-latency-plan.md`
  - `frontend-test.mjs`
  - `public/app.js`

### R · 2026-09-27 增强交付 R01—R12（导入安全与导入后重建 / 剧情分支沙盘 / 披露派生视图 / 作者样文与三级意图 / 编辑规则 / 长正文处理 / 审批与整次采纳 / OV 召回来源边界 / 运行时上下文贡献记录）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-editing-rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-migration-idempotent.mjs 同时属于 R/Z6/SE6——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-ov-recall-boundary.mjs 同时属于 R/L——改动改在同一批代码里，撤不干净
  - ai/branch/sandbox.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
  - ai/branch/store.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
  - ai/context/contributions.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6）import——撤掉会打断线上路径
- **说明**：**不能单独回滚**：本阶段只新增文件，但这些新模块被**生产代码**import（server.js / public/app.js / ai/context/* 等）， 撤掉它们必须先撤掉那些挂钩点，而挂钩点与 P2–P5 / Z2 / Z3 / T 改在同一批文件里。 交付内容是**附加式**的：新能力全部门控或按需触发（导入安全校验只作用于导入；重建流程只有作者显式规划才建表； 分支沙盘 / 样文 / 编辑规则 / 披露视图都默认不参与既有作品的装配），既有作品在功能关闭时装配与默认生成路径逐字节不变。 证据链：scripts/ci-offline-checks.mjs（45 条，含导入安全、导入重建与迁移幂等三条离线检查）、frontend-test.mjs、docs/enhancement-acceptance.md； 另有用户授权预算内的实机验收（能力探针 7/0 + 整链写作冒烟 7/0，8 次调用 ≈¥0.035，见验收报告 §6.2）。
- **验收证据**：`docs/enhancement-acceptance.md`、`docs/enhancement-progress.json`、`docs/plugin-runtime-map.md`、`docs/openviking-call-map.md`、`.verify-enh/live-capabilities-2026-09-27.json`、`.verify-enh/smoke-chain-2026-09-27.usage.json`、`.p1-baseline/test-import-guard.mjs`、`.p1-baseline/test-import-rebuild.mjs`、`.p1-baseline/test-branch-sandbox.mjs`
- **本阶段认领的文件**（31 个）：
  - `.p1-baseline/probe-live-capabilities.mjs`
  - `.p1-baseline/test-adopt-atomic.mjs`
  - `.p1-baseline/test-agent-write-boundary.mjs`
  - `.p1-baseline/test-approval-boundary.mjs`
  - `.p1-baseline/test-author-style.mjs`
  - `.p1-baseline/test-branch-sandbox.mjs`
  - `.p1-baseline/test-context-contributions.mjs`
  - `.p1-baseline/test-disclosure.mjs`
  - `.p1-baseline/test-editing-rules.mjs`
  - `.p1-baseline/test-import-guard.mjs`
  - `.p1-baseline/test-import-rebuild.mjs`
  - `.p1-baseline/test-long-text.mjs`
  - `.p1-baseline/test-migration-idempotent.mjs`
  - `.p1-baseline/test-ov-recall-boundary.mjs`
  - `ai/branch/sandbox.mjs`
  - `ai/branch/store.mjs`
  - `ai/context/contributions.mjs`
  - `ai/editing/rules.mjs`
  - `ai/editing/scan.mjs`
  - `ai/import/guard.mjs`
  - `ai/import/rebuild-store.mjs`
  - `ai/import/rebuild.mjs`
  - `ai/openviking/recall-meta.mjs`
  - `ai/style/author-profile.mjs`
  - `ai/style/store.mjs`
  - `docs/enhancement-acceptance.md`
  - `docs/enhancement-audit.md`
  - `docs/enhancement-progress.json`
  - `docs/openviking-call-map.md`
  - `docs/plugin-runtime-map.md`
  - `public/long-text.js`

### PI · 2026-09-27 落地后独立重审（001.txt）：本轮修复 + 审计证据

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 frontend-test.mjs 同时属于 S/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5/SE6——改动改在同一批代码里，撤不干净
- **说明**：独立重审（不继承上一轮 PASS）发现并修复的缺陷：① ISSUE-02：server.js 漏 import sampleSetHash，作品尚无文风档案时 GET /api/novel/style/profile 必 500 → 前端作者样文/档案/意图整卡降级；② ISSUE-03：R08 长文本单请求路径三处缺陷——revision_patch 的 parse 依赖 segment（单请求必抛 TypeError，「先审稿再应用→按清单修稿」永远出不了差异预览）；review / 按清单修稿 / 写作精修三类调用在单请求路径会先把模型跑一遍再让老路径跑第二遍（同一次任务双倍计费、双倍等待）；AI 写作草稿链的差异合并指纹以草稿为基准比对正文，永远拒绝合并。 修复全是最小改动（补齐 import / 单请求路径 singleRunByCaller 交回调用方 / 合并以审稿启动时的正文指纹为基准）， 未改 prompt 语义、模型路由、预算与任何注入字节。frontend-test.mjs 新增 58ad/58ae/58af 三条断言（先复现红，再转绿）。 证据：.verify-post/（本轮全部脚本与日志，可整体删除）。
- **验收证据**：`docs/post-implementation-audit.md`、`docs/post-implementation-acceptance.md`、`docs/post-implementation-issues.md`、`docs/post-implementation-results.json`
- **本阶段认领的文件**（7 个）：
  - `docs/post-implementation-acceptance.md`
  - `docs/post-implementation-audit.md`
  - `docs/post-implementation-issues.md`
  - `docs/post-implementation-results.json`
  - `frontend-test.mjs`
  - `public/app.js`
  - `server.js`

### L · 2026-09-28 知识库专项：跨作品共享写作资料库（门控层 library + 导入链 + 模型侧查回）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-ov-recall-boundary.mjs 同时属于 R/L——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 ai/context/layers.mjs 同时属于 P1/Z2/Z3/L——改动改在同一批代码里，撤不干净
  - ai/context/layers.mjs 被 .p1-baseline/compare-baseline.mjs（验收工具，P1）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/golden-novel.mjs（验收工具，Z3）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-assembler.mjs（验收工具，P2）import——撤掉会让该工具失效
- **说明**：**不能单独回滚**：`ai/library/` 被 server.js（P2–P5/Z2/Z3/PI）与 openviking-sync.js 直接 import， 且层规格 / 来源校验 / 登记表分别改在 ai/context/layers.mjs（P1/Z2/Z3）、ai/openviking/recall-meta.mjs（R）、db.js（P5/Z3）里。 本轮全部为附加式：新增门控层 `library`（默认关闭；`library_enabled=0` 的作品 assembled/manifest 与接入前**逐字节一致**， 见 `.p1-baseline/verify-library-identity.mjs` 的 4/4）、新增登记表 `library_docs`（纯 CREATE TABLE IF NOT EXISTS，旧 46 张表零改动）、 新增 7 条端点与工具 `novel_library`（写操作模型侧 403）。 关闭开关即恢复旧行为，不需要动数据。 证据链：离线 `.p1-baseline/test-library-import.mjs`（34/34，隔离实例 + OV stub）与 `test-ov-recall-boundary.mjs`（54/54，含资料根用例）； 真机 `.p1-baseline/verify-library-realmachine.mjs`（18/18，真实 OV v0.4.21 + 隔离实例，写共享资料根 3 篇后清理，根零残留）； 契约见 docs/host-contract.md §20；调用链见 docs/openviking-call-map.md 链 C。
- **验收证据**：`docs/host-contract.md`、`.p1-baseline/test-library-import.mjs`、`.p1-baseline/verify-library-identity.mjs`、`.p1-baseline/verify-library-realmachine.result.json`、`.p1-baseline/probe-library-p0.result.json`、`.p1-baseline/test-ov-recall-boundary.mjs`、`docs/openviking-call-map.md`
- **本阶段认领的文件**（36 个）：
  - `.p1-baseline/library-identity-before.json`
  - `.p1-baseline/probe-library-p0.mjs`
  - `.p1-baseline/probe-library-p0.result.json`
  - `.p1-baseline/test-library-import.mjs`
  - `.p1-baseline/test-ov-recall-boundary.mjs`
  - `.p1-baseline/verify-library-identity.mjs`
  - `.p1-baseline/verify-library-realmachine.mjs`
  - `.p1-baseline/verify-library-realmachine.result.json`
  - `README.md`
  - `ai/context/layers.mjs`
  - `ai/library/library-doc.mjs`
  - `ai/library/library-index.mjs`
  - `ai/library/library-ingest.mjs`
  - `ai/library/library-recall.mjs`
  - `ai/library/library-roots.mjs`
  - `ai/library/store.mjs`
  - `ai/openviking/recall-meta.mjs`
  - `db.js`
  - `docs/host-contract.md`
  - `docs/host-contract.v1.json`
  - `docs/openviking-call-map.md`
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
  - `openviking-sync.js`
  - `scripts/ci-offline-checks.mjs`
  - `server.js`

### Z6 · 2026-09-29 方向驱动检索 + 索引层化（A–E）：direction 检索输入 / 资料索引 / 小说资产索引 / 检索计划 / 两类计数分开

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-migration-idempotent.mjs 同时属于 R/Z6/SE6——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - ai/direction.mjs 被**生产代码** openviking-sync.js（D8/L）import——撤掉会打断线上路径
  - ai/direction.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/TT/SE5/SE6）import——撤掉会打断线上路径
  - ai/novel-index/plan.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/TT/SE5/SE6）import——撤掉会打断线上路径
  - ai/novel-index/store.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/TT/SE5/SE6）import——撤掉会打断线上路径
- **说明**：**不能单独回滚**：新模块 `ai/direction.mjs` / `ai/retrieval-stats.mjs` / `ai/novel-index/` 被 server.js / openviking-sync.js / db.js 直接 import， 且行为改动落在与 L / R / PI / Z5 共享的文件里（含 `ai/library/library-index.mjs`，归 L 的 `ai/library/` 前缀）。 本轮全部为**附加式**：direction 只是**检索数据**（不解析其中的指令、不写作品、不新增任何规划 / 裁决模型调用）； 资料索引（`library_index` + 可选 FTS5）与小说资产索引（12 张 `novel_index_*`）默认关闭（`library_index_enabled=0` / `novel_index_enabled=0`）， 关闭时 `retrieval_stats.index_queries.total=0`，assembled / manifest / context_id 与 1.11.0 逐字节一致 （`.p1-baseline/verify-library-identity.mjs` 4/4、`test-direction-retrieval.mjs` 的 E5 用例）。 检索计划并发查多个索引，但**先汇总后装配**——只给 buildNovelContext 准备输入，不新增编排层、不绕过唯一装配器； `retrieval_stats` 把「资料召回次数」与「索引查询次数」分开统计（任何消费方不得合并）。 ⚠️ E5 为**保守落地**：计划开启不改变既有层内容（assembled 与关闭时逐字节一致），只增加审计字段； 「用索引替代全量读取」按梯队后续推进，未声称已达成。 自审（同日）：召回微缓存命中时把本次 searches/index_queries/timings 归零（缓存命中不是一次检索）、空查询不写微缓存（恢复旧行为）、 FTS 候选改为先按 bm25 排序再截断并修正 lexical_score 方向、finalize 输出补 request_id——都有对应断言。 终审补修：计划缓存命中不把上一次的 by_index 重复计入本次（只记 cached，「索引查询次数」= 本次实际发生的次数；E6b/6.1/7.4）、 request_id 截断改按码点（不撕裂代理对；C0.6）——同样各有断言。 证据链：`.p1-baseline/test-retrieval-plan.mjs`（65/65）、`.p1-baseline/test-direction-retrieval.mjs`（47/47）、 `.p1-baseline/test-library-index.mjs`（19/19）、docs/host-contract.md 的 1.12.0 行。
- **验收证据**：`.p1-baseline/test-direction-retrieval.mjs`、`.p1-baseline/test-retrieval-plan.mjs`、`docs/host-contract.md`
- **本阶段认领的文件**（32 个）：
  - `.p1-baseline/bench-library-index.mjs`
  - `.p1-baseline/test-direction-retrieval.mjs`
  - `.p1-baseline/test-library-index.mjs`
  - `.p1-baseline/test-migration-idempotent.mjs`
  - `.p1-baseline/test-retrieval-plan.mjs`
  - `README.md`
  - `ai/direction.mjs`
  - `ai/novel-index/plan.mjs`
  - `ai/novel-index/store.mjs`
  - `ai/retrieval-stats.mjs`
  - `db.js`
  - `docs/README.md`
  - `docs/host-contract.md`
  - `docs/host-contract.v1.json`
  - `docs/plugin-runtime-map.md`
  - `frontend-test.mjs`
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
  - `openviking-sync.js`
  - `public/app.js`
  - `scripts/ci-offline-checks.mjs`
  - `server.js`

### G1 · 2026-09-29 轮：GitHub 增长面优化（英文 README 成为首页 + 中文 README 逐节对齐 + 真实界面截图 + 社区健康度文件）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .github/ISSUE_TEMPLATE/config.yml 同时属于 W/G1——改动改在同一批代码里，撤不干净
  - 文件 CONTRIBUTING.md 同时属于 W/Z2/G1/G2——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 README.zh-CN.md 同时属于 G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 docs/README.md 同时属于 X/Z0/Z2/Z5/Z6/G1/TT/G2——改动改在同一批代码里，撤不干净
- **说明**：**展示面 / 增长轮，不触碰任何生产路径**（0 处 import 变化、0 处运行时行为变化）—— 但 README.md / docs/README.md / CONTRIBUTING.md 与 X / W / W2 / Z2 / L / Z6 共享， 按文件粒度判定只能整体回滚，故声明为 shared。 内容要点：① 英文 README 成为仓库首页，中文正文迁到 README.zh-CN.md（脚本搬运，不手抄）； 随后把中文版重排为与英文版逐节对齐的章节顺序（新增「⭐ 功能特性」「💻 使用」「🙏 致谢」三节， 标题与英文版一一对应，原有正文内容照搬未改写）； ② 修正一处**既有的事实错误**——旧 README 把 assets/preview.png（图标多尺寸预览，供 novel-studio-icon.ps1 生成 .ico） 配文成「深色护眼主题下的作品总览与设定管理」，它其实**不是**界面截图； ③ 社区健康度补齐 SECURITY.md 与 CODE_OF_CONDUCT.md； ④ .github/ISSUE_TEMPLATE/config.yml 的链接由写死分支名 blob/refactor/p0-p6 改为 blob/HEAD （分支改名不再失效），并补英文入口； ⑤ CONTRIBUTING.md 增英文段，原中文段整段保留、仅降一级标题。 仓库级 Description 与 Topics 经 GitHub API 写入，属**仓库设置而非文件**，不进 git（与 W / W2 同例）。
- **验收证据**：`README.md`、`README.zh-CN.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`assets/screenshot-settings-characters.png`
- **本阶段认领的文件**（11 个）：
  - `.github/ISSUE_TEMPLATE/config.yml`
  - `CODE_OF_CONDUCT.md`
  - `CONTRIBUTING.md`
  - `README.md`
  - `README.zh-CN.md`
  - `SECURITY.md`
  - `assets/screenshot-home.png`
  - `assets/screenshot-overview.png`
  - `assets/screenshot-settings-characters.png`
  - `assets/screenshot-settings-terms.png`
  - `docs/README.md`

### TT · 时态故事状态重构（T0–T8：版本化状态底座、保存接线、影响分析、逐章重建、上下文与界面）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-host-contract.mjs 同时属于 Z2/Z3/TT——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-all.mjs 同时属于 X/Z2/Z3/TT——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - ai/repair/analyzer.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/SE5/SE6）import——撤掉会打断线上路径
  - ai/repair/runner.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/SE5/SE6）import——撤掉会打断线上路径
  - 文件 ai/story-state/approval.mjs 同时属于 Z3/TT——改动改在同一批代码里，撤不干净
- **说明**：T0–T8 的时态状态重构：新增 11 张表与三个作品级开关（默认 0，未启用作品零影响），唯一权威来源 = 不可变正文修订 + 已认可事件 + 提交清单 + 章序版本；旧字段降级为兼容投影。db.js / server.js / public/app.js 与 P2–P5、R、Z 系列共享同一文件，且新模块被生产代码 import，按文件粒度只能整体回滚；回滚前必须先关闭 temporal_enabled（关闭即回到旧路径，不删历史）。
- **验收证据**：`docs/temporal-refactor-audit.md`、`docs/temporal-refactor-progress.md`、`scripts/test-temporal-refactor.mjs`、`tests/temporal/01-pure.test.mjs`
- **本阶段认领的文件**（64 个）：
  - `.p1-baseline/test-host-contract.mjs`
  - `.p1-baseline/verify-all.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `ai/repair/analyzer.mjs`
  - `ai/repair/runner.mjs`
  - `ai/repair/store.mjs`
  - `ai/story-state/approval.mjs`
  - `ai/story-state/index.mjs`
  - `ai/story-state/temporal/analysis.mjs`
  - `ai/story-state/temporal/compat.mjs`
  - `ai/story-state/temporal/config.mjs`
  - `ai/story-state/temporal/context-provider.mjs`
  - `ai/story-state/temporal/dependencies.mjs`
  - `ai/story-state/temporal/event-store.mjs`
  - `ai/story-state/temporal/extraction.mjs`
  - `ai/story-state/temporal/history.mjs`
  - `ai/story-state/temporal/impact.mjs`
  - `ai/story-state/temporal/index.mjs`
  - `ai/story-state/temporal/migration.mjs`
  - `ai/story-state/temporal/order.mjs`
  - `ai/story-state/temporal/projection.mjs`
  - `ai/story-state/temporal/reducer.mjs`
  - `ai/story-state/temporal/revision-store.mjs`
  - `ai/story-state/temporal/schema.mjs`
  - `ai/story-state/temporal/service.mjs`
  - `ai/story-state/temporal/snapshot.mjs`
  - `ai/story-state/temporal/stmt.mjs`
  - `ai/story-state/temporal/validation.mjs`
  - `ai/story-state/temporal/worldline-store.mjs`
  - `db.js`
  - `docs/README.md`
  - `docs/host-contract.md`
  - `docs/host-contract.v1.json`
  - `docs/plugin-runtime-map.md`
  - `docs/temporal-refactor-acceptance.md`
  - `docs/temporal-refactor-audit.md`
  - `docs/temporal-refactor-progress.json`
  - `docs/temporal-refactor-progress.md`
  - `docs/temporal-state-contract.md`
  - `frontend-test.mjs`
  - `public/app.js`
  - `public/styles.css`
  - `scripts/ci-offline-checks.mjs`
  - `scripts/perf-temporal-baseline.mjs`
  - `scripts/test-temporal-refactor.mjs`
  - `server.js`
  - `tests/temporal/01-pure.test.mjs`
  - `tests/temporal/02-history.test.mjs`
  - `tests/temporal/03-integrity.test.mjs`
  - `tests/temporal/04-http.test.mjs`
  - `tests/temporal/05-save-pipeline.test.mjs`
  - `tests/temporal/06-http-save-entries.test.mjs`
  - `tests/temporal/07-proposal-binding.test.mjs`
  - `tests/temporal/08-impact-analysis.test.mjs`
  - `tests/temporal/09-impact-http.test.mjs`
  - `tests/temporal/10-repair-runner.test.mjs`
  - `tests/temporal/11-repair-http.test.mjs`
  - `tests/temporal/12-context-temporal.test.mjs`
  - `tests/temporal/13-context-cache.test.mjs`
  - `tests/temporal/14-backfill-migration.test.mjs`
  - `tests/temporal/15-backfill-http.test.mjs`
  - `tests/temporal/16-log-hygiene.test.mjs`
  - `tests/temporal/harness.mjs`
  - `tests/temporal/http-harness.mjs`

### V1 · 2026-10-02 轮：v1.0.0 审计修复轮的取证材料与新增离线门禁（文档 + 测试，不含产品代码）

- **回滚方式**：可独立回滚
- **说明**：这一组是**取证材料 + 新增离线门禁**，本身不含产品代码，整批删掉后工坊行为逐字节不变，故可独立回滚。 ⚠️ 但它**记录的那些被修缺陷不在这组文件里**：P1-01/03/04/06/07/08 改的是 server.js / public/app.js / ai/ 与 9 个既有门禁脚本，那些文件由 P2–P6 / R / TT / Z 系列共同拥有，按文件粒度只能整体回滚。 也就是说，回滚这一组只回滚「证据与新增检查」，**不会**回滚报告里描述的那些修复。 四个新增门禁都是自托管隔离实例（临时数据目录 + 本机假模型端点），零计费； `.audit-2026/api-run.txt` 是修复前的原始输出（190 PASS / 1 FAIL，那条 FAIL 就是报告里的 B4 请求体上限漂移）， 保留原样作为对照证据。
- **验收证据**：`缺陷修复报告-20261002.md`、`.audit-2026/A1-ai-pipeline.md`、`.p1-baseline/test-api-key-mask.mjs`、`.p1-baseline/test-host-guard.mjs`
- **本阶段认领的文件**（11 个）：
  - `.audit-2026/A1-ai-pipeline.md`
  - `.audit-2026/A2-state-data.md`
  - `.audit-2026/A3-frontend-security.md`
  - `.audit-2026/api-run.txt`
  - `.p1-baseline/test-api-key-mask.mjs`
  - `.p1-baseline/test-context-shrink-cap.mjs`
  - `.p1-baseline/test-host-guard.mjs`
  - `.p1-baseline/test-memory-segments.mjs`
  - `缺点及修复报告.md`
  - `缺陷修复报告-20261002.md`
  - `缺陷修复报告.md`

### G2 · 2026-10-02 轮：第二次 GitHub 展示面 / 增长优化（Description + Topics + 中英 README 首屏 + 文档索引与贡献者入口）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 CONTRIBUTING.md 同时属于 W/Z2/G1/G2——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 README.zh-CN.md 同时属于 G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 docs/README.md 同时属于 X/Z0/Z2/Z5/Z6/G1/TT/G2——改动改在同一批代码里，撤不干净
- **说明**：**展示面 / 增长轮，不触碰任何生产路径**（0 处 import 变化、0 处运行时行为变化）—— 但 README.md / README.zh-CN.md / CONTRIBUTING.md / docs/README.md 与 G1 / X / W / W2 / Z2 / L / Z6 / TT 共享同一文件，按文件粒度判定只能整体回滚，故声明为 shared。 内容要点：① 英文与中文 README 首屏重写为「问题 → 价值主张 → 受众」结构，并新增「Who it's for / Who it's not for」 与「Where it fits」对比表（覆盖 Sudowrite / Novelcrafter / Obsidian+Longform / novelWriter / Manuskript / SillyTavern / Open WebUI 等替代品检索词），英文版新增可折叠目录（Contents）； ② **修掉三处既有的事实错误**——英文 README 写「49 checks」、中文 README 两处写「49 条」， 而 `scripts/ci-offline-checks.mjs` 实际是 **50 条**（离线套件实跑 50/50 佐证）； ③ `docs/README.md` 的 Host Contract 版本由 1.19.0 更正为 **1.20.0**、条目数 20 更正为 **21**（唯一真源 `server.js` 的 `HOST_CONTRACT_VERSION`），并新增「一之再补、v1.0.0 轮」小节， 把此前**未被索引**的 21 份文档（含时态重构四件、DSH rc1→rc2 六件、`post-implementation-audit.md`） 与仓库根的 `.audit-2026/` 与三份中文报告一并登记； ④ `CONTRIBUTING.md` 中英两半各新增「怎么找到该看的地方」（架构入口表）与「该跑哪一套？」（区分 50 条离线套件与 `verify-all`，并写明成本纪律与成本总闸）。 仓库级 Description 与 Topics 经 GitHub REST API 写入，属**仓库设置而非文件**，不进 git（与 G1 / W / W2 同例）。 ⚠️ 写 Topics 走的是专用端点 `PUT /repos/{owner}/{repo}/topics`：实测仓库 PATCH 即使返回 200 也**不会**改 topics， 必须写后回读校验。
- **验收证据**：`README.md`、`README.zh-CN.md`、`CONTRIBUTING.md`、`docs/README.md`
- **本阶段认领的文件**（5 个）：
  - `.p1-baseline/verify-phase-map.mjs`
  - `CONTRIBUTING.md`
  - `README.md`
  - `README.zh-CN.md`
  - `docs/README.md`

### SE · 2026-10-07 第三批：Safe Editing 修稿安全门禁（确定性结构依赖 + 删除依赖 + 修后核验）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 frontend-test.mjs 同时属于 S/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 public/app.js 同时属于 P3/P4/P5/Z5/PI/Z6/TT/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 public/index.html 同时属于 S/SE/SE6——改动改在同一批代码里，撤不干净
  - 文件 public/patch-safety.js 同时属于 SE/SE4——改动改在同一批代码里，撤不干净
- **说明**：**只加一层确定性门禁，不改任何模型契约**：补丁 JSON 仍是 `{"patches":[{issue,anchor,revised}]}`， 提示词字段一字未动（文档 §15 里需要改模型输出契约的 `fact_delta` 自报属未选中的批次）。 门禁做的事：对每条补丁判定 `protected_content / story_fact / object_provenance / reference_anchor / scene_anchor`（外加只报告的 `causal_bridge_break`），命中的那一条**不进差异稿**，同批其余补丁照旧应用。 失败姿态是**放行**并在差异预览里写明 `safety_unavailable`——门禁不能阻塞作者修稿。 证据：`node frontend-test.mjs` 的 `94a`–`94r`（含文档 §14 五条用例与两组阴性对照）全绿， 旧的 `87/88/89/90/90a/90b/90c/58ad` 一并保持通过。 `public/app.js`、`public/index.html`、`frontend-test.mjs` 与其它阶段共用，故 `rollback = shared`； `public/patch-safety.js` 与交付文档本身可以单独撤回（删文件即回到旧行为）。
- **验收证据**：`public/patch-safety.js`、`docs/safe-editing-gate-20261007.md`
- **本阶段认领的文件**（6 个）：
  - `.p1-baseline/verify-phase-map.mjs`
  - `docs/safe-editing-gate-20261007.md`
  - `frontend-test.mjs`
  - `public/app.js`
  - `public/index.html`
  - `public/patch-safety.js`

### SE4 · 2026-10-08 第四批：一致性判据（事实锁 / 跨段整句重复 / 转场桥）+ 保护规则接线 + 允许人味

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-editing-rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 README.zh-CN.md 同时属于 G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 ai/editing/rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - ai/editing/rules.mjs 被 .p1-baseline/test-editing-rules.mjs（验收工具，R/SE5/SE6）import——撤掉会让该工具失效
- **说明**：**只加判据与规则，不改任何模型契约**：补丁 JSON 仍是 `{"patches":[{issue,anchor,revised}]}`， 审稿 JSON 形状与提示词字段一字未动。本批做的事： ① `public/patch-safety.js` 升 v1.1.0，新增 `fact_lock_conflict`（**进 HARD_CODES**：同一实体两个编号 / 同一编号两个主人 / 补丁让有主人的编号整体消失）、`scene_bridge`、`cross_paragraph_duplicate`、 `percent_sum_mismatch`； ② `ai/editing/scan.mjs` 新增四条判据（其中 `duplicate-sentence` **与能力开关无关**） 与 `scanned.promise` 测量值；`ai/editing/rules.mjs` 升 v1.3.0，新增 `number-lock / scene-bridge / promise-identity` 三项**默认关闭、只报告**的能力， `PROTECTION_RULES` 增第 8 条（数字锁）与第 9 条（转场桥）； ③ **接线**：保护规则此前只被 `task:"write"` 的上下文层使用，润色与两条修稿提示词从没收到过它 —— 现在注入 `buildAIPolishMessages / buildAIRevisionPatchPrompt / buildAIRevisionPrompt`， 与 `edit_rules_enabled` 无关（保真底线不是创作偏好）； ④ `ai/writing/policy.mjs` 增 `allow_human_slack`（成文/扩写）与 `protect_human_slack`（修稿） 一对偏好，**不加配额**（配额化即 AI 味的结构性来源）；`public/app.js` 的兜底常量同文同步。 证据：`node .p1-baseline/probe-fact-lock-20261008.mjs`（25/25）、 `node .p1-baseline/probe-scan-round4-20261008.mjs`（20/20，语料是作者真实的两版正文）、 `node frontend-test.mjs` ALL PASS（含新增 118a–118n）。 本轮抓出并修掉七个自身缺陷（两遍 `labelFromWindow` 覆盖、编号前置式不认、后缀取错位置、 百分比正则在小数上错配、稀有度词重叠计数、外景词含单字"下"、百分比容差过松），逐条留痕在交付文档里。 `public/app.js`、`frontend-test.mjs`、`ai/editing/*`、`ai/writing/policy.mjs` 与其它阶段共用， 故 `rollback = shared`；两个探针脚本与交付文档本身可以单独撤回。
- **验收证据**：`docs/deai-source-fix-round4-20261008.md`、`.p1-baseline/probe-fact-lock-20261008.mjs`、`.p1-baseline/probe-scan-round4-20261008.mjs`
- **本阶段认领的文件**（15 个）：
  - `.p1-baseline/probe-fact-lock-20261008.mjs`
  - `.p1-baseline/probe-scan-round4-20261008.mjs`
  - `.p1-baseline/test-editing-rules.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `README.md`
  - `README.zh-CN.md`
  - `ai/editing/rules.mjs`
  - `ai/editing/scan.mjs`
  - `ai/writing/policy.mjs`
  - `docs/CHANGELOG.md`
  - `docs/deai-source-fix-round4-20261008.md`
  - `frontend-test.mjs`
  - `package.json`
  - `public/app.js`
  - `public/patch-safety.js`

### SE5 · 2026-10-08 第五批：叙事结构机械感（同形流程 / 时间轴 / 群众反应 / 镜头越界）+ P0 场景要求矛盾修复

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-editing-rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 README.md 同时属于 X/W2/Z0/Z2/L/Z6/G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 README.zh-CN.md 同时属于 G1/G2/SE4/SE5——改动改在同一批代码里，撤不干净
  - 文件 ai/editing/rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - ai/editing/rules.mjs 被 .p1-baseline/test-editing-rules.mjs（验收工具，R/SE4/SE6）import——撤掉会让该工具失效
- **说明**：**只加判据与字段、不改任何模型契约**：修稿补丁 JSON 仍是 `{"patches":[{issue,anchor,revised}]}`， `novel_consistency` 的返回是**追加** `checklist.style_diagnosis`（现有字段一字未动）。本批做的事： ① **P0 根因**：`buildAIWritingProsePrompt` 里"每个场面必须有明确地点/人物/动作/冲突，再补环境、动作、心理、对话与节奏" 与写作策略源 `avoid_repeated_full_mechanism`（同一机制不要完整复现第二遍）**直接冲突** —— 模型只能选后者，这就是"觉醒检测流程完整演示 4 次"的来源；改为**功能驱动**（关键场面展开／过渡场面可略写／ 同类流程第二次只写结果差异与反应／第一次要写足）。 ② `ai/editing/scan.mjs` 新增 `scanStoryShape` 与常驻测量值 `scanned.style_shape`（**与能力开关无关**）： 时间锚点（含"绑定钟点才算推进""时长不算""纯参照不算"三条筛）、同形流程簇、匿名群众反应段、 非转播上下文的镜头词、主视角看/听与主动动作比值； `ai/editing/rules.mjs` 升 v1.4.0，新增 `story-shape`（默认关闭、只报告），`PROTECTION_RULES` 增第 10 条（同类机制只完整演示一次，**第一次必须保留**）； ③ `ai/writing/policy.mjs` 升 2026-10-08.2，只补**真正缺的**三条（`first_showing_stays_complete`、 `prefer_progressive_revelation`、`prefer_result_over_repeated_process`）与 `diag_timeline_density`； 方案原列的其余 6 条诊断与 3 条偏好**已存在**（`diag_repeated_mechanism`／`diag_functional_redundancy`／ `diag_negative_explanation`／`diag_over_explanation`／`allow_human_slack`／`protect_human_slack`／ `avoid_repeated_full_mechanism`），故不新建 —— 同一判据两份文本必然漂移； ④ `server.js` 的 `/api/novel/consistency` 追加 `checklist.style_diagnosis`（自己显式打开 story-shape 跑一次， 不依赖作者是否启用了该能力），`novel-tools.mjs` 渲染为第 ⑨ 项自检 + 结构诊断区块， `agent.cordis.yml` 只追加**一条总原则**（控制规则数量，不加几十条）。 证据：`node .p1-baseline/probe-story-shape-20261008.mjs`（41/41，语料是作者真实的两版正文， 含正例/负例/静默姿态三类断言）、`node .p1-baseline/calibrate-story-shape-20261008.mjs`（阈值实测来源）、 `node .p1-baseline/test-editing-rules.mjs`（含新增派生护栏 C0c）。 本轮在**真实语料上**抓出并修掉六处判据缺陷（时长守卫误删真锚点、`vagueOnlyRe` 被定义却从未使用、 同段两时间词误判过密、镜头上下文只看前一段、`MEDIA_CONTEXT_RE` 自我实现、 群众反应按动词分簇导致正例漏报），逐条留痕在交付文档里。 `public/app.js`、`server.js`、`frontend-test.mjs`、`ai/editing/*`、`ai/writing/policy.mjs`、 两个 harness 插件文件与其它阶段共用，故 `rollback = shared`；探针、语料与交付文档可单独撤回。 ⚠️ 已知边界：本章可复算的"同形流程再现"只有 2 组（不是审稿人目测的 4 次完整复现）， 时间锚点 4–5 个、匿名群众反应 1 段、镜头越界 0 段 —— 即 S1/S3/S5 在本章是**倾向**而非硬性缺陷， 判据据此保持静默（零误报纪律），这是刻意的能力边界而非漏检。
- **验收证据**：`docs/deai-source-fix-round5-20261008.md`、`.p1-baseline/probe-story-shape-20261008.mjs`、`.p1-baseline/calibrate-story-shape-20261008.mjs`
- **本阶段认领的文件**（19 个）：
  - `.p1-baseline/calibrate-story-shape-20261008.mjs`
  - `.p1-baseline/fixtures/ch1-juexingri-v1.txt`
  - `.p1-baseline/fixtures/ch1-juexingri-v2.txt`
  - `.p1-baseline/probe-story-shape-20261008.mjs`
  - `.p1-baseline/test-editing-rules.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `README.md`
  - `README.zh-CN.md`
  - `ai/editing/rules.mjs`
  - `ai/editing/scan.mjs`
  - `ai/writing/policy.mjs`
  - `docs/CHANGELOG.md`
  - `docs/deai-source-fix-round5-20261008.md`
  - `frontend-test.mjs`
  - `harness-plugins/novel-writing/agent.cordis.yml`
  - `harness-plugins/novel-writing/novel-tools.mjs`
  - `package.json`
  - `public/app.js`
  - `server.js`

### SE6 · 2026-10-09 第六批：叙事性专项修复（E00—E07：局部补丁执行正确性 / 阶段化规则 / 审稿与选择保真 / 叙事诊断 / 编辑计划 / 可解释报告）

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - 文件 .p1-baseline/test-editing-rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/test-migration-idempotent.mjs 同时属于 R/Z6/SE6——改动改在同一批代码里，撤不干净
  - 文件 .p1-baseline/verify-phase-map.mjs 同时属于 X/Z3/TT/G2/SE/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
  - ai/editing/narrative-review.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5）import——撤掉会打断线上路径
  - ai/editing/narrative-scan.mjs 被**生产代码** server.js（P2/P3/P4/P5/Z2/Z3/PI/L/Z6/TT/SE5）import——撤掉会打断线上路径
  - 文件 ai/editing/rules.mjs 同时属于 R/SE4/SE5/SE6——改动改在同一批代码里，撤不干净
- **说明**：**只加机制与字段、不改既有模型契约**：修稿补丁 JSON 升到**可选** v2（`schema_version:2` + `span_id` + 逐字 `original`； 旧 `{patches:[{issue,anchor,revised}]}` 仍被接受，走 `salvageLegacyRevisionPatches`）， `PUT /api/novel/review` 追加 additive 返回字段 `structure`/`findings_accepted`/`findings_rejected`/`rejected`， 新增只读端点 `GET /api/novel/revision/selection` 与 `GET /api/novel/revision/comparison`， 新增表 `revision_selections`（契约升 1.22.0），`/api/ai_context` 追加 additive `edit_rules`。 本批做的事：① **E01 补丁执行正确性**（显式 delete、精确跨度、段落级门禁输入、组合核验、失败不扩大为整章重写）； ② **E02 阶段化规则编译**（`rules.mjs` v1.5.0 的 `stage_rules` + `stageRuleFor` + 审计；直连与 Harness 同阶段等价， Harness 侧由 `novel_write_pipeline` 带 `stage=draft` 实现）； ③ **E03 审稿与选择保真**（`structureReviewReport` 引用核验 + 独立选择记录 + 取回按记录收窄）； ④ **E04 叙事诊断**（确定性候选层消费 `scan.mjs`，不复制词表；只给 condense/check，语义层标记 `not_run`）； ⑤ **E05 局部编辑计划**（片段级授权跨度 + 不变量 + 依赖组 + 预算举手）； ⑥ **E06 可解释报告**（逐条改动/校验状态/单处撤销/相对结论守卫/对照视图 + 样本量守卫）； ⑦ **E07 验收运行器**（`scripts/run-narrative-acceptance.mjs`：按退出码判定，产出 e07-run-manifest.json）。 `public/app.js`、`public/index.html`、`server.js`、`ai/editing/rules.mjs`、`harness-plugins/novel-writing/novel-tools.mjs`、 `frontend-test.mjs`、`scripts/ci-offline-checks.mjs`、`.p1-baseline/test-editing-rules.mjs`、`docs/host-contract.*` 与其它阶段共用，故 `rollback = shared`；新增模块、专项套件、冻结样本与交付文档**可单独撤回**（撤回后：`index.html` 去掉两个 `<script>` → 修稿按"协议模块未加载"如实拒绝，不静默降级； 关掉 `edit_rules_enabled` → 生成行为与接入前逐字节一致）。 ⚠️ 已知边界：真实模型语义审稿与文学效果评测未执行（`SKIPPED: paid_evaluation_not_authorized`）， 故交付文档只写"机制已实现、文学效果待评测"。
- **验收证据**：`docs/narrative-repair/implementation-report.md`、`docs/narrative-repair/test-report.md`、`docs/narrative-repair/e07-run-manifest.json`、`docs/narrative-repair/coverage-report.json`、`docs/narrative-repair/rollback.md`、`scripts/run-narrative-acceptance.mjs`
- **本阶段认领的文件**（42 个）：
  - `.p1-baseline/test-editing-rules.mjs`
  - `.p1-baseline/test-migration-idempotent.mjs`
  - `.p1-baseline/verify-phase-map.mjs`
  - `.p1-baseline/verify-preset-copy.mjs`
  - `ai/editing/narrative-review.mjs`
  - `ai/editing/narrative-scan.mjs`
  - `ai/editing/rules.mjs`
  - `db.js`
  - `docs/host-contract.md`
  - `docs/host-contract.v1.json`
  - `docs/narrative-repair/acceptance-report.md`
  - `docs/narrative-repair/baseline.json`
  - `docs/narrative-repair/coverage-report.json`
  - `docs/narrative-repair/e07-run-manifest.json`
  - `docs/narrative-repair/execution-state.json`
  - `docs/narrative-repair/implementation-report.md`
  - `docs/narrative-repair/rollback.md`
  - `docs/narrative-repair/source-map.md`
  - `docs/narrative-repair/test-report.md`
  - `frontend-test.mjs`
  - `harness-plugins/novel-writing/novel-tools.mjs`
  - `public/app.js`
  - `public/index.html`
  - `public/revision-patch.js`
  - `public/revision-plan.js`
  - `scripts/ci-offline-checks.mjs`
  - `scripts/materialize-narrative-fixtures.mjs`
  - `scripts/run-narrative-acceptance.mjs`
  - `scripts/test-narrative-repair.mjs`
  - `server.js`
  - `tests/narrative-repair/01-patch-protocol.test.mjs`
  - `tests/narrative-repair/02-fixtures.test.mjs`
  - `tests/narrative-repair/03-stage-rules.test.mjs`
  - `tests/narrative-repair/04-narrative-scan.test.mjs`
  - `tests/narrative-repair/05-revision-plan.test.mjs`
  - `tests/narrative-repair/06-report.test.mjs`
  - `tests/narrative-repair/07-review-structure.test.mjs`
  - `tests/narrative-repair/fixtures/after.txt`
  - `tests/narrative-repair/fixtures/before.txt`
  - `tests/narrative-repair/fixtures/manifest.json`
  - `tests/narrative-repair/harness.mjs`
  - `叙事性专项修复.md`

## 三、归属核对

- 真实改动集：**503** 个文件
- 未被任何阶段认领：**96** 个

⚠️ 以下改动没有归属——没人能说清怎么回滚它们：
  - `.p1-baseline/_split-own-diff-20261006.mjs`
  - `.p1-baseline/ch121-current.txt`
  - `.p1-baseline/ch121-v48-manual.txt`
  - `.p1-baseline/ch121-v49-draft.txt`
  - `.p1-baseline/cleanup-my-draft67.mjs`
  - `.p1-baseline/dump-ch121.mjs`
  - `.p1-baseline/e2e-adopt-realdata-20261006.mjs`
  - `.p1-baseline/gen-recompute-ch119.mjs`
  - `.p1-baseline/gen-regress-merge-20261005.mjs`
  - `.p1-baseline/list-cards.mjs`
  - `.p1-baseline/make-clean-backup.mjs`
  - `.p1-baseline/probe-adopt-blocked-20261006.mjs`
  - `.p1-baseline/probe-adopt-ledger-20261005.mjs`
  - `.p1-baseline/probe-after-eperm.mjs`
  - `.p1-baseline/probe-ch119-bp.mjs`
  - `.p1-baseline/probe-ch119-words.mjs`
  - `.p1-baseline/probe-ch121-compare.mjs`
  - `.p1-baseline/probe-ch121-lineage.mjs`
  - `.p1-baseline/probe-ch121-recovery.mjs`
  - `.p1-baseline/probe-ch121-state-20261002.mjs`
  - `.p1-baseline/probe-ch121-which-version.mjs`
  - `.p1-baseline/probe-chapter-bodies.mjs`
  - `.p1-baseline/probe-context-layers.mjs`
  - `.p1-baseline/probe-draft66.mjs`
  - `.p1-baseline/probe-final.mjs`
  - `.p1-baseline/probe-fork-from-server.mjs`
  - `.p1-baseline/probe-guard-check.mjs`
  - `.p1-baseline/probe-guard-verdict-20261006.mjs`
  - `.p1-baseline/probe-harness-spawn.mjs`
  - `.p1-baseline/probe-hybrid-shape-20261005.mjs`
  - `.p1-baseline/probe-job-tables-20261005.mjs`
  - `.p1-baseline/probe-jobs-today.mjs`
  - `.p1-baseline/probe-last-log.mjs`
  - `.p1-baseline/probe-leak-detail.mjs`
  - `.p1-baseline/probe-leak-layers.mjs`
  - `.p1-baseline/probe-leak-words2.mjs`
  - `.p1-baseline/probe-lineage-20261005.mjs`
  - `.p1-baseline/probe-live-untouched-20261006.mjs`
  - `.p1-baseline/probe-longtext-plan.mjs`
  - `.p1-baseline/probe-merge-block-20261005.mjs`
  - `.p1-baseline/probe-merge-fingerprint-2-20261006.mjs`
  - `.p1-baseline/probe-merge-fingerprint-20261006.mjs`
  - `.p1-baseline/probe-merge-fingerprint-3-20261006.mjs`
  - `.p1-baseline/probe-new-rules.mjs`
  - `.p1-baseline/probe-new-rules2.mjs`
  - `.p1-baseline/probe-patch-verify-20261005.mjs`
  - `.p1-baseline/probe-placement-cases.mjs`
  - `.p1-baseline/probe-placement.mjs`
  - `.p1-baseline/probe-placeof-regex.mjs`
  - `.p1-baseline/probe-rebuild-20261005.mjs`
  - `.p1-baseline/probe-recent-ai-logs.mjs`
  - `.p1-baseline/probe-regex-min.mjs`
  - `.p1-baseline/probe-repro-14-13-20261006.mjs`
  - `.p1-baseline/probe-revisions-20261005.mjs`
  - `.p1-baseline/probe-rewrite-mode.mjs`
  - `.p1-baseline/probe-rules-catalog.mjs`
  - `.p1-baseline/probe-run-1930.mjs`
  - `.p1-baseline/probe-running-jobs.mjs`
  - `.p1-baseline/probe-scenelogic-direct.mjs`
  - `.p1-baseline/probe-spawn-child.mjs`
  - `.p1-baseline/probe-spawn-job.mjs`
  - `.p1-baseline/probe-spawn-sandbox.mjs`
  - `.p1-baseline/probe-voice-detail.mjs`
  - `.p1-baseline/probe-why-blocked.mjs`
  - `.p1-baseline/probe-write-channel-20261005.mjs`
  - `.p1-baseline/probe-yaml.mjs`
  - `.p1-baseline/restore-ch121-v48.mjs`
  - `.p1-baseline/smoke-draft-dismiss.mjs`
  - `.p1-baseline/smoke-empty-guard.mjs`
  - `.p1-baseline/smoke-review-dismiss.mjs`
  - `.p1-baseline/spawn-attempt.txt`
  - `.p1-baseline/spawn-capability.txt`
  - `.p1-baseline/test-migration-draft-dismissed.mjs`
  - `.p1-baseline/verify-adopt-fix-20261002.mjs`
  - `.p1-baseline/verify-backups.mjs`
  - `.p1-baseline/verify-ch121-untouched.mjs`
  - `.p1-baseline/verify-ch121-untouched2.mjs`
  - `.p1-baseline/verify-thinking-heartbeat-20261002.mjs`
  - `ai/writing/compile.mjs`
  - `ai/writing/scopes.mjs`
  - `docs/adopt-guard-20261006.md`
  - `docs/blueprint-regenerate-20261004.md`
  - `docs/ch121-cast-fix-20261002.md`
  - `docs/ch121-ledger-proposals-fix-20261002.md`
  - `docs/character-timing-checklist.md`
  - `docs/deai-round2-diagnostics-20261006.md`
  - `docs/deai-source-fix-round3-20261002.md`
  - `docs/deai-trace-baseline-20261002.md`
  - `docs/draft-dismiss-20261004.md`
  - `docs/empty-guard-no-exit-20261004.md`
  - `docs/review-merge-empty-body-20261006.md`
  - `docs/review-merge-force-20261006.md`
  - `docs/save-incident-20261002.md`
  - `docs/spawn-eperm-20261002.md`
  - `docs/wiring-fix-20261008.md`
  - `scripts/cleanup-stale-blueprints-20261006.mjs`
