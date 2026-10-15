# NSDSH · 阶段状态

> 规则：只有「代码/文档 + 生产接线（如适用）+ 真实测试实跑」同时满足才可标 **DONE**；**SKIP ≠ PASS**。
> 每个阶段把原始输出留在 `.nsdsh/reports/`（本地、已忽略），本文件只放**脱敏摘要**。
> 阶段清单与命令的机器可读版本见 [`stages.json`](stages.json)。

- 基线 HEAD：`b7919f75624c4e788fd3ffe916f2339ec8f04913`
- 最近更新：2026-10-15（S01）

## 阶段总览

| 阶段 | 批次 | 状态 | 说明 |
|---|---|---|---|
| S00 冻结真实基线 | NS-A | **DONE** | `baseline.md` + `adr-001-boundaries.md` + `PLAN.md` + 阶段台账条目 `NS0` |
| S01 隔离测试 / 阶段运行器 / 备份演练 | NS-A | **DONE（1 项环境阻断）** | `scripts/nsdsh/*`（含 `lib/`）+ `tests/nsdsh/*` + `docs/nsdsh/stages.json`；专项 45 断言全绿 |
| S02 复现风险并固定行为契约 | NS-A | **DONE** | F01–F12 + D1–D6 全部行为表征；`known-issues.json` 18 条登记；专项 **88 断言**全绿 |
| S03 渐进拆分入口（并修 D1/D2/D3/D5） | NS-C | **DONE** | 四用例判据抽到 `server/services/temporal-services.mjs`；D1/D2/D3/D5 已修（台账 4 条转 `fixed_locally`）；专项 **100 断言**全绿 |
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

---

## S01 · 建立可重复的隔离测试基础（DONE，2026-10-15）

**结论**：`状态 PARTIAL —— 1 项环境阻断；通过 9，未通过 0`。所有必需的脚本、测试与前置证据校验都通过；
唯一未通过的一项（"guard 不得拦掉合法回环"的阴性对照）**不是代码缺陷，也不是回归**，见下"环境事实"。

### 实际完成的变更

| 文件 | 动作 |
|---|---|
| `docs/nsdsh/stages.json` | 新增：S00–S18 阶段清单（依赖/允许改动区/必需测试/命令 argv/网络策略/验收项/回退说明）+ `frozenArtifacts` |
| `scripts/nsdsh/preflight.mjs` | 新增：环境/版本/路径/隔离前置检查（不调用模型），`--offline --json` |
| `scripts/nsdsh/check-stage.mjs` | 新增：阶段门禁（必需文件与测试存在、0 tests 判失败、前置证据校验、PASS/PARTIAL/FAIL/BLOCKED 四态、写 `.nsdsh/reports/`） |
| `scripts/nsdsh/isolated-run.mjs` | 新增：临时数据/home/端口/fake provider/网络拒绝/退出清理（复用 `ci-isolated-run.mjs`，不重造） |
| `scripts/nsdsh/backup-restore-check.mjs` | 新增：只在测试库做备份-恢复比对（`VACUUM INTO` 一致快照 + 阴性对照） |
| `scripts/nsdsh/lib/{report,gate,isolate,egress}.mjs`、`lib/network-guard.cjs` | 新增：报告骨架/子进程出口/隔离夹具/出网探针（CJS 供 `--require` 注入） |
| `scripts/nsdsh/lib/bootstrap-s00-report.mjs` | 新增：为**已完成的 S00** 补阶段报告（一次性、幂等、`--force` 才覆盖） |
| `scripts/run-nsdsh-tests.mjs` | 新增：nsdsh 专项套件总入口（显式清单、空清单非零退出、同进程回退、`NSDSH-SUMMARY` 机器标记） |
| `tests/nsdsh/{isolation,stage-runner,backup-restore}.test.mjs` | 新增：11 / 28（同步 24 + 异步 4）/ 6 条断言 |
| `scripts/ci-offline-checks.mjs` | 修改：登记 `NSDSH 阶段门禁` 一条 |
| `.p1-baseline/verify-phase-map.mjs` | 修改：`NS0` 条目补齐 S01 的脚本与测试；重新生成 `docs/phase-map.md` |

**未改动**：任何业务代码、数据库 schema、`server.js`、`harness.js`、`ai/`、`public/`、插件、`data/`。

### 真实执行的命令与结果

| 命令 | 结果 |
|---|---|
| `node scripts/nsdsh/check-stage.mjs S00 --offline` | **PASS**：通过 3 / 未通过 0（S00 证据有效） |
| `node scripts/nsdsh/check-stage.mjs S01 --offline --write-report --force` | **PARTIAL**：通过 9 / 未通过 0；3 条命令全 PASS（`tests-nsdsh`/`preflight`/`utf8`） |
| `node scripts/run-nsdsh-tests.mjs` | **PASS**：3 个套件全过，**45 条断言**（`isolation` 11 + `stage-runner` 24+4=28 + `backup-restore` 6；机器标记 `NSDSH-SUMMARY: suites=3 suitesFailed=0 passed=45 failed=0 total=45`） |
| `node scripts/nsdsh/preflight.mjs --offline --json` | **PASS**：`ok=true`，13 项 ok + 1 项 BLOCKED（回环阴性对照） |
| `node scripts/nsdsh/backup-restore-check.mjs --fixture` | **PASS 8 / 0**：备份与恢复清单一致；**阴性对照**（篡改 1 行）确实报出差异 |
| `node scripts/ci-offline-checks.mjs` | **通过 55 / 未通过 0**（共 55 条，零计费）—— 新增的 NSDSH 条目通过；**S00 记录的 17 条环境阻断在无沙箱环境下全部转绿** |
| `node .p1-baseline/verify-phase-map.mjs --write` → 无参复跑 | **PASS**：**614** 个改动全部有归属、未归属 0；`NS0` 推导=`shared`、声明=`shared`；已重新生成 `docs/phase-map.md` |
| `node .p1-baseline/check-utf8.mjs` | **PASS**：非法 UTF-8 0 个 |

### 环境事实（本轮新增，影响后续阶段的设计）

**子进程向"父进程托管的回环 HTTP 服务"取不到响应。** 对照实验（2026-10-15，两次环境都复现）：

1. 同一进程内 `fetch` 自己的回环服务 → **成功**（`FETCH-OK 200`）；
2. 子进程里 `net.connect` 到父进程的回环端口 → **成功**（`TCP_OK`）；
3. 子进程 `fetch` 父进程的回环服务 → **超时**（`HTTP_TIMEOUT`），**把网络 guard 完全去掉也一样**；
4. 换成 `danger-full-access`、无文件沙箱后，现象**不变**。

因此：这既**不是** guard 误拦合法流量（代码缺陷），也**不只是**受限沙箱的现象。
**对后续阶段的硬约束**：S06/S10 要"捕获假模型实际收到的请求"时，被测服务与假模型必须落在
**同一进程树里的同一侧**，不能靠"父进程起假模型、子进程去连"。
（本项目既有的「自托管隔离实例 + 本机假模型」路线天然满足这个约束——`scripts/ci-offline-checks.mjs`
里 `时态故事状态重构总入口` 66.6s 全绿，正是这条路线可用的证据。）

### 本轮自查发现并修复的自身缺陷

| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| 1 | `stages.json` 的 S03–S06 依赖链写错（我把 S03 挂到 S04、S06 挂到 S01） | 与方案稿 §14 的 `依赖：` 逐条比对 | 改为 S03←S02、S04←S03、S05←S04、S06←S05，并把拓扑序校验跑通 |
| 2 | 前置证据校验绑定了**全部**交付物摘指纹 | `STATUS.md` 按设计要贯穿 S00–S18 追加 → 一追加就会把 S00 判成失效 | 引入 `frozenArtifacts`：只对"完成后不得再变"的文件做摘指纹绑定 |
| 3 | 编辑 `stages.json` 时把 `frozenArtifacts` 键整段替换掉，JSON 语法损坏 | `JSON.parse` 报 `Expected ':' ... position 2826` | 重建该段；用 `JSON.parse` + 文件存在性 + 依赖可达性三项校验确认修复 |
| 4 | `pickFreePort()` 是"绑上就关"，端口不进 TIME_WAIT，连续调用**恒返回同一个号**；`startFakeModel` 因此在同一进程里第二次调用就 `EADDRINUSE` 崩掉 | `pickFreePort() ×5 → 38100 ×5`；`startFakeModel` 连开两个 → `EADDRINUSE 127.0.0.1:38100` | `startFakeModel` 改为"先试再退"：失败换号重试（排除试过的号），仍失败则响亮抛错。复验：两个假模型分获 `38100`/`38101` |
| 5 | `lib/egress.mjs` 未登记进阶段清单与阶段台账 | `verify-phase-map.mjs` 报 `.probe-loopback.mjs` 之外的归属问题；清单里也没有它 | 登记进 `stages.json`（required + frozen）与 `verify-phase-map.mjs` 的 `NS0` |

### 已知限制与未验证项（如实记录）

1. **回环阴性对照仍未取得证据**（`network-guard 允许回环` = BLOCKED）。该项已归因为执行环境限制，
   **不是** guard 缺陷；但它确实意味着"guard 是否误拦合法回环"这一条**在本机没有被证明过**。
   同一环境限制下的正向证据（非回环 fetch 被拒）是有的。
2. S02–S18 的 `commands` 仍是空数组：`check-stage` 对这些阶段会报 **BLOCKED**（"运行器尚未为该阶段实现"），
   这是**刻意的**——不允许用"执行了就算通过"冒充验收。（S00/S01 的 `commands` 已完成实测。）
3. `check-stage` 的退出码约定：`0`=PASS、`1`=FAIL、`3`=PARTIAL/BLOCKED。CI 可用它区分"回归"与"环境阻断"。
4. **阶段报告的 `head` 只是运行时刻的信息性字段**（本轮提交被 `--amend` 后它与当前 HEAD 就不再相等）。
   证据的有效性**绑定在内容上**：`frozenArtifacts` 的逐文件 SHA256（`frozenDigest`）+ 逐条 `artifactChecks`。
   因此不要用"报告里的提交号 == 当前 HEAD"来判定证据是否有效——那会因为一次合法的 amend 而误判失效。
   复核方式：`node scripts/nsdsh/check-stage.mjs S01 --offline`（它内部走 `verifyPrerequisite`）。
5. `check-stage` 对**每个套件**只读取**第一处**汇总行，所以它在验收项里显示 `stage-runner.test.mjs 通过 24`；
   而该文件有两段汇总（同步 24 + 异步 4），顶层 runner 会把两段**累加**为 28。两个数字都对，
   含义不同（"第一条汇总行" vs "该套件全部断言的合计"），45 这个总数取自套件累加。


### 下一步（S02）

1. 为 F01–F12 建最小可复现用例（或记录"本地已修复"的证据），D1–D6 每条绑定修复阶段与到期条件。
2. 固定"保存→pending→分析→确认"状态机；补 `baseline-contract` / `regression-findings` / `historical-trust` 三个套件。
3. 产出 `docs/nsdsh/known-issues.json`，并把 S02 的 `commands` 填成可执行命令。

---

## S02 · 先复现，再重构（DONE，2026-10-15）

**结论**：`状态 PASS —— 全部产物、前置证据与命令检查通过；通过 6 / 未通过 0`。
2 条命令全 PASS（`known-issues`、`tests-nsdsh`），4 条验收项全部由机器判定通过。

### 实际完成的变更

| 文件 | 动作 |
|---|---|
| `tests/nsdsh/regression-findings.test.mjs` | 新增：**18 条断言 / 151 处 `assert`**，逐条钉住 F01–F12 与 D1–D6 的现状 |
| `tests/nsdsh/baseline-contract.test.mjs` | 新增：16 条断言（保存→pending→分析→确认状态机、幂等、跨作品隔离、保守失效、哈希两向分离、审批单次消费） |
| `tests/nsdsh/historical-trust.test.mjs` | 新增：8 条断言（历史边界、lineage vs 状态哈希、提交级信任、未来事实不可见、作者更正留旧提交） |
| `docs/nsdsh/known-issues.json` | 新增：**18 条**已知缺陷登记（7 高 / 10 中 / 1 低），每条绑定 `behaviorTest` + `fixStage` + 到期条件 |
| `scripts/nsdsh/check-known-issues.mjs` | 新增：台账结构自检（`summary` 必须等于明细复算；每条必须有 `fixStage` 与到期条件） |
| `scripts/nsdsh/check-stage.mjs` | 修改：新增 S02 的四条机器判定；`blocked` 的验收项不再判为失败 |
| `scripts/nsdsh/lib/report.mjs` | 修改：`verifyPrerequisite` 区分"未通过"与"环境阻断"（见下"设计订正"） |
| `scripts/run-nsdsh-tests.mjs` | 修改：`NSDSH_TESTS` 登记 S02 三个新套件（漏登记会让门禁**静默跳过**整个套件） |
| `scripts/nsdsh/lib/isolate.mjs` | 修改：修掉 `install()` 与 `assertIsolated()` 的顺序不兼容（见下"自身缺陷 #6"） |
| `docs/nsdsh/baseline.md` | 修改：F12 归属订正 + D3 符号位置订正 + 新增 §3.1 说明为何订正后要重新生成 S00 报告 |
| `docs/nsdsh/stages.json` / `docs/phase-map.md` | 修改：S02 置 done、补 `frozenArtifacts`、登记新文件；重新生成阶段映射 |

**未改动**：任何业务代码、数据库 schema、`server.js`、`harness.js`、`ai/`、`public/`、插件、`data/`。
S02 是**纯表征阶段**——它只描述现状（含缺陷），一个业务行为都没改。

### 真实执行的命令与结果

| 命令 | 结果 |
|---|---|
| `node scripts/nsdsh/check-stage.mjs S02 --offline --write-report --force` | **PASS**：通过 6 / 未通过 0 |
| `node scripts/run-nsdsh-tests.mjs` | **PASS**：**6 个套件 / 88 条断言 / 0 失败**（`NSDSH-SUMMARY: suites=6 suitesFailed=0 passed=88 failed=0 total=88`） |
| `node scripts/nsdsh/check-known-issues.mjs` | **PASS 1 / 0**：18 条登记；summary 与明细复算一致；按修复阶段 S03(5) S04(3) S05(1) S06(5) S09(2) S10(1) S14(1) |
| `node scripts/nsdsh/check-stage.mjs S01 --offline --write-report --force` | **PARTIAL**：通过 9 / 未通过 0（唯一 BLOCKED 项仍是执行环境限制，不阻断链） |
| `node scripts/nsdsh/check-stage.mjs S00 --offline` | **PASS**：通过 3 / 未通过 0（订正 `baseline.md` 后已重新生成 S00 报告） |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | **PASS**：**627** 个改动全部有归属；文档对账一致 |
| `node .p1-baseline/check-utf8.mjs` | **PASS**：非法 UTF-8 0 个 |

### F01–F12 / D1–D6 的表征方式（诚实口径）

**动态行为表征**（真跑内核 + 临时库）：F05、F06、F07、F08、F09、D1（单线程两路径，**非并发**）、D2、D5。
**静态源码/结构表征**（`server.js`/`harness.js` 无法无副作用 import，故只能文本断言）：F01（含真库表清单）、F02、F03、F04、F10、F11、F12、D3、D4、D6。

**明确没有做到的**（不得被读成"已复现"）：
- **D1 未做并发复现**：只在单线程把"缺省 expectedHead 时覆盖 HEAD 不抛"与"给过时值则抛 `HEAD_CAS_MISMATCH`"两条路径钉住。并发竞态仍属读码推断。
- **D3 的"500 而非 409"是推断**：只断言了"零 HTTP 处理点 + 通用 500 出口存在"，没起服务打端点。
- **F11 未加载组合后的 bundle**：只证明 `plugin.json` / `novel-tools.mjs` / `cordis.patch.yml` / `agent.cordis.yml` 四层各自的事实。
- **审批 `raced` 分支（UPDATE 影响 0 行）离线不可达**：单线程内无法在"读 active"与"UPDATE"之间插入写入；已退到模块级不变量 + 一处 SQL 形状表征，并在用例里写明"不是并发复现"。

### 本轮自查发现并修复的自身缺陷（承接 S01 的 5 条，本轮新增 3 条）

| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| 6 | **`makeIsolatedEnv().install()` 与 `assertIsolated()` 顺序不兼容**：`install()` 会把 `TMPDIR/TEMP/TMP` 指向 `<root>/tmp`，而 `assertIsolated()` 用 `os.tmpdir()` 判定"数据目录必须在临时目录内" → `<root>/data` 必然被拒 | 两个 S02 套件各自撞到并各自绕行（`backup-restore-check.mjs` 与 `regression-findings.test.mjs` 用了两套不同绕法，说明坑已知但未固化） | `isolate.mjs` 改为保存**模块加载时**的系统临时根 `SYSTEM_TMP_ROOT` 作判据，并额外接受"落在本次隔离根之下"；实测 `install()` 之后再 `assertIsolated()` 通过 |
| 7 | **`verifyPrerequisite` 把"环境阻断"当成"验收未通过"** → S01 的一项 BLOCKED 让 S02 被判"前置证据无效"，连命令都不执行 | `check-stage S02` 首跑报 `前置阶段 S01 证据无效：S01 验收项未通过：network-guard 允许回环（阴性对照）` | 改为 `!passed && !blocked` 才算失败；BLOCKED 仍留在报告里并在理由中列明数量。**并补了一条对照断言**（未通过但无 `blocked` 标记仍然拒绝），防止这条改动变成静默放宽 |
| 8 | **`run-nsdsh-tests.mjs` 的 `NSDSH_TESTS` 漏登记 S02 三个套件** | 门禁命令是 `scripts/run-nsdsh-tests.mjs`，清单不含新套件 → 整套断言会被**静默跳过**且门禁仍绿 | 登记三个新套件；断言数从 45 → 88，套件数 3 → 6 |

### 设计订正（本轮最重要的一条）

`frozenArtifacts` 抓到了一次真实改动：订正 `baseline.md`（F12 归属、D3 符号位置）后，`verifyPrerequisite('S00')` 正确地报"冻结交付物被改动"。
**处置不是把 freeze 去掉，而是重新生成 S00 报告**（重新判定三条验收项 + 写入新摘指纹），并在 `baseline.md` §3.1 记录订正内容与理由。
→ 结论：**`frozenArtifacts` 的语义是"任何改动都必须显式记录并重新出报告"，不是"永不可改"。** 直接手改而不重出报告，会让后续阶段的前置证据静默失真。

### 下一步（S03）

S03 = 渐进拆分入口 + 修 D1/D2/D3/D5（**本批次最后一步 NS-A 已完成，S03 属 NS-C**）。
注意 `stages.json` 里的依赖链：S03 依赖 S02（已满足）；S04 依赖 S03；S06 依赖 S05。
S03 的 `commands` 仍是空数组，因此它会先报 **BLOCKED**——这是刻意的，需要先把 `commands` 与验收判定接上。
⚠️ 硬约束（`known-issues.json` 的到期条件）：**D1 必须先写并发复现用例再修**，不得直接改代码。


