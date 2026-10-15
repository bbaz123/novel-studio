# NSDSH · 阶段状态

> 规则：只有「代码/文档 + 生产接线（如适用）+ 真实测试实跑」同时满足才可标 **DONE**；**SKIP ≠ PASS**。
> 每个阶段把原始输出留在 `.nsdsh/reports/`（本地、已忽略），本文件只放**脱敏摘要**。
> 阶段清单与命令的机器可读版本见 [`stages.json`](stages.json)。

- 基线 HEAD：`b7919f75624c4e788fd3ffe916f2339ec8f04913`
- 最近更新：2026-10-15（S00）

## 阶段总览

| 阶段 | 批次 | 状态 | 说明 |
|---|---|---|---|
| S00 冻结真实基线 | NS-A | **DONE** | `baseline.md` + `adr-001-boundaries.md` + `PLAN.md` + 阶段台账条目 `NS0` |
| S01 隔离测试 / 阶段运行器 / 备份演练 | NS-A | PENDING | 新增 `scripts/nsdsh/*` 与 `tests/nsdsh/*`（复用既有隔离配方，不重造） |
| S02 复现风险并固定行为契约 | NS-A | PENDING | F01–F12 最小复现 + D1–D6 表征测试 + `known-issues.json` |
| S03 渐进拆分入口（并修 D1/D2/D3/D5） | NS-C | PENDING | |
| S04 持久任务 / 租约 / outbox / 恢复 | NS-B | PENDING | 最高价值项 |
| S05 稳定身份解析 + 迁移 dry-run | NS-C | PENDING | |
| S06 完整抽取 / 覆盖 / 摘要（修 D4） | NS-B | PENDING | |
| S07 时点读取溯源（能力已存在） | NS-C | PENDING | 只补溯源与证据，不重做 T5 |
| S08 领域事件流与前端闭环 | NS-C | PENDING | |
| S09 工具能力与作者权限（修 D6） | NS-C | PENDING | |
| S10 统一 broker 与运行时接口 | NS-B | PENDING | |
| S11 vendor 上游固定提交 | NS-D | PENDING | 固定 `7e06df2`（0.1.7-rc.1） |
| S12 小说专用 bundle / profile | NS-D | PENDING | |
| S13 SDK 适配 / 会话隔离 / 取消 | NS-D | PENDING | 热备池已有，需接线 |
| S14 发行物裁剪与依赖闭包（修 F10） | NS-D | PENDING | |
| S15 全矩阵 / 跨平台 / 性能 | NS-E | PENDING | |
| S16 迁移演练与灰度 | NS-E | PENDING | 只在真实库**拷贝**上演练 |
| S17 清理旧桥接与上游维护纪律 | NS-E | PENDING | |
| S18 最终验收与交付 | NS-E | PENDING | |

---

## S00 · 冻结真实基线（DONE，2026-10-15）

### 实际完成的变更

| 文件 | 动作 |
|---|---|
| `docs/nsdsh/baseline.md` | 新增：版本与来源清单、工作区状态、F01–F12 逐条核对、D1–D6、既有能力清单、S00–S18 真实状态、改动前门禁基线、执行环境事实 |
| `docs/nsdsh/adr-001-boundaries.md` | 新增：允许/禁止改动的范围、上游固定提交取哪条线、文档公开范围、冲突处置 |
| `docs/nsdsh/PLAN.md` | 新增：仓库内执行版计划（目标/判据/差异/批次/关键设计/强约束/纪律） |
| `docs/nsdsh/STATUS.md` | 新增：本文件 |
| `.p1-baseline/verify-phase-map.mjs` | 修改：新增阶段条目 `NS0`（21 项改动面，逐条列明） |
| `.p6-cutover/snapshot.mjs` | 修改：`EXCLUDES` 增加 `.nsdsh/`（纵深防御：隔离库副本绝不进快照） |
| `.gitignore` | 修改：忽略第三方方案稿（按任务书处理）与 `.nsdsh/` |
| `docs/README.md` | 修改：新增「一之三补、NSDSH 架构优化轮」段 |
| `docs/phase-map.md` | 重新生成（由 `verify-phase-map.mjs --write`） |
| `data/backup-nsdsh-s00-20261015183148/` | 改动前备份边界（本地，已忽略） |

**未改动**：任何业务代码、数据库 schema、`server.js`、`harness.js`、`ai/`、`public/`、插件。
**未触碰**：作者真实库 `data/novel.db`、用户全局 `~/.dsh`、同级上游 checkout、全局 npm 安装、作者未提交的 `README.zh-CN.md`。

### 真实执行的命令与结果

| 命令 | 结果 |
|---|---|
| `node scripts/ci-offline-checks.mjs`（**受限沙箱内**首跑） | 通过 37 / 未通过 17（共 54 条）。17 条全部是"需要起子进程"的检查，报错签名统一为 `spawn EPERM` / `errno -4048` / `exit=-1` |
| `node scripts/ci-offline-checks.mjs`（**管道 stdio 可用**时复跑） | **通过 54 / 未通过 0（共 54 条，零计费）** —— 首跑的 17 条红灯经实测确认为执行环境限制，**不是回归**。真实门禁基线 = **54/54 全绿** |
| `node .p1-baseline/check-utf8.mjs` | **PASS**：扫描 6525 个文本文件，非法 UTF-8 0 个，缺 BOM 的 `.ps1` 0 个 |
| `node scripts/test-narrative-repair.mjs` | **PASS**：通过 17 / 未通过 0 个套件（零计费） |
| `node frontend-test.mjs` | **PASS**：在离线清单里作为「前端执行验证（vm + DOM 桩）」通过（8,082ms） |
| `node tests/temporal/01-pure.test.mjs`（单独直跑，绕开总入口的 `spawnSync`） | **PASS 8 / FAIL 0** —— 首跑时用于反向证明总入口的失败来自管道边界 |
| `node .p1-baseline/test-assembler.mjs`（不需要子进程的对照组） | **PASS 通过 32 / 失败 0** |
| `node .p1-baseline/verify-phase-map.mjs --write` → 再跑无参核对 | **PASS**：真实改动集 **607** 个文件、未归属 **0**；38 个阶段的存在性全在、可回滚性推导与声明全部一致；`NS0` 推导=`shared`、声明=`shared`；【4. 文档与数据是否一致】**✓**（78,545 字符 / 111,246 字节）；已重新生成 `docs/phase-map.md` |

### 已知限制与未验证项（如实记录）

1. 首跑的 17 条红灯已用第二次实跑**证实**为环境限制（沙箱禁止子进程管道 stdio），**不是回归**；
   两次实跑与逐条归因见 `baseline.md` §7。
2. 若后续会话再次处于**受限**文件策略下：阶段台账门禁与隔离实例检查跑不动时标 **BLOCKED**，
   **不得**标 PASS，也**不得**当成回归。
3. F01–F12 的核对是**读码结论**；把它们变成可执行的行为表征测试是 S02 的工作。
4. D1（HEAD CAS 竞态）是**读码推断**，未并发复现——必须在 S03 先写复现用例再修。
5. 上游固定提交取 `7e06df2`（0.1.7-rc.1）是**基于现有集成面向 0.1.7 的判断**；S11 vendor 时会再次核对。

### 下一步（S01）

1. 新增 `scripts/nsdsh/{preflight,check-stage,isolated-run,backup-restore-check}.mjs` 与 `docs/nsdsh/stages.json`。
2. 新增 `tests/nsdsh/{isolation,stage-runner,backup-restore}.test.mjs`。
3. 把 nsdsh 门禁自检登记进 `scripts/ci-offline-checks.mjs`。
4. 取得 S01 的门禁基线（当前策略下可直接实跑）。
