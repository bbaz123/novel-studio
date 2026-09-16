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
| **X** | 跨阶段：总纲与工具入口 | 🟡 可单独撤，但会让若干验收工具失效（需同步修） |

**可独立回滚的阶段：（无）。**仅会让验收工具失效的：X。其余阶段要么与别的阶段改在同一批代码里，要么被生产代码 import——**要回滚就一起回滚**，或用 `.p6-cutover/snapshot.mjs` 的整体快照。

## 二、逐阶段明细

### P0 · 专用 dsh profile（novel）与插件 bundle 化

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - harness.js 被 .p1-baseline/test-model-switch-gate.mjs（验收工具，P4）import——撤掉会让该工具失效
  - harness.js 被**生产代码** server.js（P2/P3/P4/P5）import——撤掉会打断线上路径
- **说明**：harness.js 同时被 P4/P6 改过；profile 本身的回滚是卸掉 novel profile 与 bundle 接线（install-profile.mjs 反向操作）。
- **验收证据**：`.p0-recon/README.md`、`.p0-recon/verify-harness-profile.mjs`、`.p0-recon/compare-composed.mjs`、`.p0-recon/novel.p3.txt`、`.p0-recon/capture-dsh-request.mjs`
- **本阶段认领的文件**（35 个）：
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
  - `harness.js`

### P1 · 冻结上下文契约 + 基线 + 压力数据

- **回滚方式**：只能整体回滚
- **阻断原因（推导得出）**：
  - ai/context/layers.mjs 被 .p1-baseline/test-assembler.mjs（验收工具，P2）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/test-recall-gap.mjs（验收工具，X）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/verify-all.mjs（验收工具，X）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/verify-invariants.mjs（验收工具，P2）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/verify-layer-constants.mjs（验收工具，X）import——撤掉会让该工具失效
  - ai/context/layers.mjs 被 .p1-baseline/verify-retrieval-map.mjs（验收工具，X）import——撤掉会让该工具失效
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
  - ai/context/assembler.mjs 被**生产代码** server.js（P3/P4/P5）import——撤掉会打断线上路径
  - 文件 server.js 同时属于 P2/P3/P4/P5——改动改在同一批代码里，撤不干净
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
  - 文件 public/app.js 同时属于 P3/P4/P5——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5——改动改在同一批代码里，撤不干净
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
  - ai/policy.mjs 被**生产代码** harness.js（P0）import——撤掉会打断线上路径
  - ai/policy.mjs 被**生产代码** server.js（P2/P3/P5）import——撤掉会打断线上路径
  - 文件 public/app.js 同时属于 P3/P4/P5——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5——改动改在同一批代码里，撤不干净
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
  - ai/edit-distance.mjs 被**生产代码** server.js（P2/P3/P4）import——撤掉会打断线上路径
  - db.js 被 .p1-baseline/probe-recall-direct.mjs（验收工具，P1）import——撤掉会让该工具失效
  - db.js 被**生产代码** server.js（P2/P3/P4）import——撤掉会打断线上路径
  - 文件 public/app.js 同时属于 P3/P4/P5——改动改在同一批代码里，撤不干净
  - 文件 server.js 同时属于 P2/P3/P4/P5——改动改在同一批代码里，撤不干净
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
  - .p6-cutover/snapshot.mjs 被 .p1-baseline/verify-phase-map.mjs（验收工具，X）import——撤掉会让该工具失效
  - ai/harness-env.mjs 被 .p1-baseline/test-harness-env.mjs（验收工具，X）import——撤掉会让该工具失效
  - ai/harness-env.mjs 被**生产代码** harness.js（P0）import——撤掉会打断线上路径
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

### X · 跨阶段：总纲与工具入口

- **回滚方式**：可单独撤，但会让若干验收工具失效（需同步修）
- **阻断原因（推导得出）**：
  - .p1-baseline/audit-llm-calls.mjs 被 .p0-recon/capture-dsh-request.mjs（验收工具，P0）import——撤掉会让该工具失效
  - .p1-baseline/blackhole.mjs 被 .p0-recon/capture-dsh-request.mjs（验收工具，P0）import——撤掉会让该工具失效
- **说明**：验收工具与总纲；单独撤回只会让验收能力变弱，不影响线上行为——但注意 X 内部彼此 import（verify-all ↔ 各工具），且被 .p0-recon 的线路层工具引用。
- **验收证据**：`.p1-baseline/verify-all.mjs`、`.p1-baseline/README.md`、`docs/README.md`
- **本阶段认领的文件**（32 个）：
  - `.p1-baseline/.gitignore`
  - `.p1-baseline/README.md`
  - `.p1-baseline/audit-llm-calls.mjs`
  - `.p1-baseline/blackhole.mjs`
  - `.p1-baseline/census.mjs`
  - `.p1-baseline/compare-memory-hint.mjs`
  - `.p1-baseline/diff-log-noise.mjs`
  - `.p1-baseline/diff-real-db.mjs`
  - `.p1-baseline/exp-per-task-settings.mjs`
  - `.p1-baseline/gate-env.mjs`
  - `.p1-baseline/incident-evidence-app-log-2026-09-15.md`
  - `.p1-baseline/incident-evidence-app-log-2026-09-15.raw.txt`
  - `.p1-baseline/probe-live.mjs`
  - `.p1-baseline/read-dsh-session.mjs`
  - `.p1-baseline/test-gate-assert.mjs`
  - `.p1-baseline/test-harness-env.mjs`
  - `.p1-baseline/test-recall-gap.mjs`
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
  - `docs/README.md`
  - `docs/final-acceptance-p0-p6.md`
  - `docs/pending-decisions.md`
  - `docs/phase-map.md`

## 三、归属核对

- 真实改动集：**111** 个文件
- 未被任何阶段认领：**0** 个

✓ 全部改动都有归属。
