# docs/ 索引

> 🇬🇧 **English readers — start here**
>
> - [`ai-core.md`](ai-core.md) — the AI kernel: architecture, the data flow of one drafting request, how to verify it, known gaps
> - [`context-contract.md`](context-contract.md) — the context contract and its invariants I1–I7
> - [`host-contract.md`](host-contract.md) — the host / plugin / server boundary and the actual load paths
> - [`phase-map.md`](phase-map.md) — which phase changed which files, and how each one can be rolled back
> - [`pending-decisions.md`](pending-decisions.md) — the open backlog
> - Project overview: [**README.md**](../README.md) · `README.zh-CN.md`
>
> Everything else in this folder is a **Chinese-language** verification report or design note.
> Two batches are mixed together here: notes from the 2026-09-15 AI-kernel refactor (P0–P6) and
> later rounds describe the **current** code, while reports from 2026-09-06 ~ 09-14 describe the
> **pre-refactor** code — their line numbers and function layout are stale, so find code by
> symbol name rather than by line.

> 🧑💻 **第一次用这个项目、只想尽快跑起来？** 请看 **[新手入门.md](新手入门.md)** ——
> 装 Node.js → 下载 → 双击启动 → 写出第一章 → 出错了怎么查，全在里面。
>
> 📌 **本页是面向开发者的文档索引**：收录的基本都是各轮重构的验收报告、验证记录与自审材料，
> 对"只想用起来"的读者没有帮助，不必往下看。

---

⚠️ **先读这一条**：本目录混有**两批**文档，它们描述的是**不同版本的代码**。

- **本次 AI 内核重构（2026-09-15，P0–P6）与 P6 之后各轮（2026-09-24 ~ 09-28）** —— 描述**当前**代码，引用的模块与符号有效。
- **历史报告（2026-09-06 ~ 09-14）** —— 描述**重构前**的代码。里面的行号、函数分布
  （上下文预算与收敛当时还在 `server.js` 里）**已经过时**，只能当"当时发生了什么"的证据读，
  不要照着它找代码。

---

## 一、本次重构（P0–P6）· 描述当前代码

按建议阅读顺序：

| 文档 | 内容 |
|---|---|
| **`ai-core.md`** | **入口。** AI 内核的现状：一张图、四个组成、一次成文请求的数据流、怎么验证、已知缺口 |
| `context-contract.md` | 上下文契约与不变量 I1–I7；四条装配路径；层规格；可执行下限；偏离清单与处置状态 |
| `p2-assembler-verification.md` | P2 验收：装配器抽取（55/55 逐字节等价）、主成文路径统一（−73% 输入）、缓存 TTL |
| `p3-retrieval-verification.md` | P3 验收：I4「凡裁剪必可查回」端到端成立；**记忆库内容缺失**的排查证据 |
| `p4-policy-verification.md` | P4 验收：模型策略单点化（0 处绕过）、全分支核对表 |
| `p5-memory-eval-verification.md` | P5 验收：截断提示改为指向真实可用工具；AI 效果埋点 |
| `p6-cutover-runbook.md` | P6 切换手册：前置、彩排结果、执行步骤、回滚、待决事项（**待批准执行**） |
| `self-review-p0-p6.md` | 全量自审：项目原生三套件结果、既有失败的对照实验、发现并修复的问题 |
| **`final-acceptance-p0-p6.md`** | **最终验收报告**：P0–P6 逐条对账、I1–I7 状态、**回滚真相**（无可独立回滚的阶段 → 提交粒度）、约束遵守情况、遗留事项；含一次性完整验收结果（29 通过 / 0 未通过 / 0 跳过，零计费双重佐证） |
| **`phase-map.md`** | **阶段 → 改动面 → 回滚**（自动生成）：哪些阶段可独立回滚、哪些共享文件只能整体回滚；由 `verify-phase-map.mjs` 与真实改动集对账 |
| **`pending-decisions.md`** | **待决事项**：P0–P6 收尾六件（提交、P6 执行、索引重建、吞吐对齐、日志噪声、埋点孤儿）+ 2026-09-22 追加的**连续性预检口径四件**（D9–D12）与**三盏红灯的自动裁决**（D13）——各列现状/选项/影响代价/建议；刻意不复制数字，避免漂移 |
| **`confirmation-resolution-2026-09-22.md`** | **待确认事项裁决记录**（按《03 · DSH 待确认事项决策规范》自动判定）：7 项逐条给 QUALITY_IMPACT / USER_IMPACT_IF_UNCHANGED / ACTION / 所选方案 / 执行范围 / 状态，附 §16 矩阵对照、验收证据与「没做的事」自查；规则版本 `confirmation_resolution_v1` |
| `continuity-guard.md` | **确定性连续性预检（2026-09-22 落地）**：四项检查（角色卡时点 / 系统出场 / 篇幅 / 剧情线）、阈值与豁免的覆盖入口、真实作品上的通过线、刻意不做的清单 |
| `code-review-2026-09-19.md` | 2026-09-19 全仓**只读**审查（第 1 步，未改代码）：5 处质量问题 Q1–Q5（含"压缩出场判定只读章节头部"这一高项）与 3 处健壮性 R1–R3 的定位与建议方案；**引用的是审查当时的位置，见文首归档注记** |
| `code-review-2026-09-19-summary.md` | 同轮 5 步闭环的总结（对应 v0.9.6）：Q1/Q2/Q4/R1/R2 已修、O1/O2/C1/F1 已优化、遗留 Q5/R3，附逐项验证结果与修改文件清单 |
| `chapter-acceptance-checklist.md` | **一章一审固定表（2026-09-21 定稿）**：七项验收、批 1～2 机制对应的检查点、第 6 章对照基线 |
| **`openviking-embedding-setup.md`** | **OpenViking 记忆库与向量模型**：完整下载地址（含本机可达性实测）、`ov.conf` 配置方法（按 0.4.17.1 实际字段核对）、源码内 `vendor/models/` 那一份怎么用、验证清单、未验证项 |
| **`main-v2-upgrade-2026-09-24.md`** | **主体 V2 交付报告（2026-09-24/25）**：上下文身份/完整性/溯源三件与信封字段、历史问题清零表（19 项逐条回真实代码）、本轮修掉的 5 个真实缺陷（含压缩输入恒空、审计工具静默报 0、隔离包装器不传变量）、性能前后数据、生成质量回归（50/50 逐字节相同）、用户可见行为变化（无）、未完成项与风险 |
| **`main-v2-acceptance-2026-09-25.md`** | **主体 V2 验收报告（第二步：质量门/行为门/兼容门）**：结论 A PASS（允许冻结 Host Contract）；今天这棵树重新抓取的 50 例上下文与 pre-V2 **逐字节 50/50 相同**；13 项历史问题逐条从当前代码重证；9 项宿主契约各有命令级证据；旧库零 schema 写入；性能对照；验收期间发现并最小修复的 3 处（含 1 个本轮引入的测试工具缺陷）与 4 项残余风险 |
| **`host-contract.md`** + **`host-contract.v1.json`** | **Host Contract 1.20.0（冻结 · 插件阶段的稳定地面）**：10 份契约（Context/Task-Run/Trace-Audit/Settings 隔离/取消恢复/DB 迁移/插件 adapter/AI route/错误重试/兼容策略）各自的输入输出、状态、错误码、retryable、可观测字段与不变条件；插件可用接口白名单（26 工具 / 75 端点 / 71 张表）与不得绕过的边界；契约版本三处互锁与验证方式（`test-host-contract.mjs`，含负向对照）；`contract_history` 记 1.0.0–1.20.0 共 21 条（**唯一真源是 `server.js` 的 `HOST_CONTRACT_VERSION`，本行数字以它为准**） |
| **`story-state-kernel-2026-09-26.md`** | **第四步交付报告：确定性故事状态内核**（门控层 `story_state` + 10 张新表 + 17 端点（当时契约 1.2.0 再追加 1 条只读事实端点 = 18）+ 8 插件工具）：方法（先基线后改动）、实际修改文件、schema migration（25→35 表、+16 索引）、18 相位状态机与提案/快照/回滚语义、上下文接入与真实渲染样本、**验收期抓到并修掉的 5 个真实缺陷**、测试结果（逐字节 50/50、端到端 59/0/0、契约 28/0/0、离线 32/32、一键 54/0/1）、性能对照、兼容性与未完成项 |
| **`host-contract-1.1-2026-09-26.md`** | **Host Contract 变更说明 1.0.0 → 1.1.0（附加式）**：层 14→15、表 25→35、工具 15→23、端点 26→43 的逐项差异与兼容性论证（默认关闭、未开启逐字节 50/50、开启后只 +1 层且其余层逐层相同）、契约测试结果、插件侧新能力与边界 |
| **`golden-novel-regression-2026-09-26.md`** | **第五步终验报告：Golden Novel 联合回归（主体 + 插件 + 真实生成质量）**：12 章 / 19 类难 case 的联合夹具（119 条断言 0 失败）、一次运行抓到并修掉的 4 个真实缺陷（含「角色知识边界」整条路不可用与知识可见窗口方向反了，附**变异对照**证明回归真的能抓住）、Host Contract **当时 1.2.0** 的附加式变更、逐字节 20/20 与压力 50 用例 0 异常、性能实测（32/14/12 ms、净 +393 字）、用户行为变化表 8 项、17 项历史问题从当前代码逐条重证、7 条风险与 5 项未验证（**真实模型文本质量未验证** → 判定 B. PASS WITH FOLLOW-UP） |
| **`ai-write-latency-plan.md`** | **成文时间全方位缩短 · 方案（口径 A 机器时间 + 口径 B 交付时间）**：先测量后优化——真实库实测（直连成文 30–42s、慢通道中位 65s、冷启动仅 1844ms 约占 2%、7 次空回复、每轮重放 1.3–1.5 万字上下文）指出三处真正的肥肉（空回复烧掉整轮再回退慢通道、不必要的慢通道轮次、可合并的轮次）；P0 三条零质量风险（空回复同轮续跑 / 轮询改流式 / 超时取消不再丢正文）、P1 四条需 A/B（减轮次 / 同流续写 / 前缀缓存友好化 / 预检前置）、P2 四条结构性；**P0-4 埋点补真已落地**（含口径 A/B 的查询 SQL、已知缺口与回滚点） |
| **`HARNESS_ARGV_LIMIT_FIX.md`** | **工坊缺陷修复（2026-09-25）：超长 prompt 走 argv 触发 `spawn ENAMETOOLONG`**——慢通道把整个任务文本放进子进程 argv，而 Windows 命令行上限是 32767 个 UTF-16 码元（实测 32650 成功 / **32700 失败**，4 万字必失败）。改为**仅 Windows、仅超长时**走 `dsh … -` + stdin，其余路径逐字不变。含：边界探针、通道与逐字一致实测、EPIPE 阴性对照 + **变异对照**（去掉那行 error 处理 → `UNCAUGHT EOF`，证明它承重）、真 dsh + 假端点端到端（12 万字全文逐字送达模型）、一键验收 52/2/1 中 2 条既有红灯的归因、1 行回滚 |
### 一之补、P6 之后各轮（2026-09-24 ~ 09-28）· 同样描述当前代码

| 文档 | 内容 |
|---|---|
| **`enhancement-acceptance.md`** | **创作内核增强交付验收（2026-09-27，R01–R12）**：七类新能力（运行时贡献记录 / 编辑规则 / 作者样文与文风档案 / 披露派生视图 / 剧情分支沙盘 / 导入安全与导入后重建 / 完整长篇处理）逐项状态与证据、离线检查、真实模型的有限预算实测、以及如实标注的 BLOCKED 项 |
| **`enhancement-audit.md`** | 同轮的**开工前审计快照**：R01–R12 的缺口清单与开工时基线（文中「32 条 / v0.10.0 / 契约 v1.2.0」是**开工时**的事实，按原样保留不改写） |
| **`post-implementation-acceptance.md`** | **落地后独立重审（2026-09-28，不继承上一轮 PASS）**：基线重取、107 条机器可读账本（`post-implementation-results.json`）、逐项运行证据、真实浏览器 E2E 19/19、真机 DeepSeek 有限预算实测 |
| **`post-implementation-issues.md`** | 同轮**问题清单**：观察项 OBS-01 ~ 06 与本轮修掉的 ISSUE-01/02/03，每条含严重度 / 根因 / 复现 / 影响 / 修复 / 回归 / 残余风险 |
| **`plugin-runtime-map.md`** | **宿主 / DSH bundle / 服务端的边界与实际加载路径**：谁加载谁、实际跑的是哪一份代码、模型侧能写什么、逐条复验命令 |
| **`openviking-call-map.md`** | **OpenViking 三条调用链**（作品资源链 / 会话链 / 共享资料链）：配置来源、scope 边界、失败重试语义，以及哪些结论离线可复验、哪些仍是 BLOCKED |
| `story-state-kernel-2026-09-26.md` / `golden-novel-regression-2026-09-26.md` | 故事状态内核与 Golden Novel 联合回归（见上表，同属描述当前代码的一批） |

### 一之再补、v1.0.0 轮（2026-09-30 ~ 10-02）· 同样描述当前代码

这一批是**当前默认分支**（`Experimental-Version-v1.0`）上的最新材料：时态故事状态重构 + 一轮独立审计驱动的修复。
**取证材料不在 `docs/` 里**，而在仓库根的 [`.audit-2026/`](../.audit-2026/A1-ai-pipeline.md) —— 见下表。

| 文档 | 内容 |
|---|---|
| **`temporal-state-contract.md`** | **时态故事状态契约**：T0–T8 的不变量与语义（逐章时点、历史隔离、原子归约），是这一层"什么算对"的判据来源 |
| **`temporal-refactor-audit.md`** | 时态重构**开工前审计**（T0 基线）：缺口清单与当时的代码事实 |
| **`temporal-refactor-acceptance.md`** | 时态重构**验收**：T0–T8 逐项状态与证据、逐字节等价对照 |
| **`temporal-refactor-progress.md`** / `temporal-refactor-progress.json` | 逐相位进度（人读版 + 机器可读账本） |
| **`post-implementation-audit.md`** | 落地后**独立重审**（不继承上一轮 PASS）的审计快照 |
| **`code-review-2026-09-19-round2-summary.md`** | 第二轮回审总结（第一轮为 `code-review-2026-09-19-summary.md`） |
| **`self-review-2026-09-16.md`** / **`self-review-2026-09-18.md`** | 主体 V2 期间的两轮自审记录 |
| **`DSH_0.1.7_RC1_RC2_*`（4 份）** / `DSH_RC1_COMPATIBILITY_BASELINE.md` / `RC1_vs_RC2_CAPABILITY_MATRIX.md` | 宿主 DSH 0.1.7-rc1 → rc2 升级的 API 差异、兼容矩阵、插件实测与能力对照（升级兼容性的取证材料） |

**仓库根目录的审计与缺陷材料（不在 `docs/`，但对理解 v1.0.0 是必需的）：**

| 路径 | 内容 |
|---|---|
| **[`.audit-2026/A1-ai-pipeline.md`](../.audit-2026/A1-ai-pipeline.md)** | A1 专项审计：AI 流水线（含质量门、直连/慢通道、上下文装配） |
| **[`.audit-2026/A2-state-data.md`](../.audit-2026/A2-state-data.md)** | A2 专项审计：故事状态与数据层 |
| **[`.audit-2026/A3-frontend-security.md`](../.audit-2026/A3-frontend-security.md)** | A3 专项审计：前端编辑器 / AI 修改安全 / AI UX / 性能 |
| `../.audit-2026/api-run.txt` | 接口套件**修复前**的原始输出（190 PASS / 1 FAIL，其中 FAIL 即报告里的 B4 请求体上限漂移） |
| **[`../缺陷修复报告-20261002.md`](../缺陷修复报告-20261002.md)** | v1.0.0 修复轮的**逐条对照清单**：每条含"改了什么 / 未改什么 / 为什么 / 证据" |
| **[`../缺点及修复报告.md`](../缺点及修复报告.md)** | 审计**总表**（§40 Phase 0 + Phase 1 高杠杆项来源）与验收方案 |
| `../缺陷修复报告.md` | 上一轮（v0.9.x）的修复报告，作为历史对照保留 |

配套的可复现验证工具在 `.p0-recon/`、`.p1-baseline/` 与 `.p6-cutover/`（各有 README）。
一键跑全部验证：`node .p1-baseline/verify-all.mjs`。

**要跑齐全部检查，需要这三种前置**（缺哪个，套件就把对应项标成「跳过」而**不是**通过）：

```powershell
# ① 活实例 → 解锁 I4 可查回、主成文路径同源、编辑距离端到端、压缩提示自发现
node .p1-baseline/gate-env.mjs --data-dir .p1-baseline/stress-data   # 前台；隔离变量一次配齐（八项，见 runbook §八）
# ② 显式授权 → 解锁三条会真的 spawn dsh 的检查（零计费，且自带跑后审计）
#    $env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'
# ③ 闸门并发验证 → 另需 --gate-base 且 NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1
node .p1-baseline/gate-env.mjs --stop                                 # 收工
```

**成本自证**：任何一段跑完都可以核对「到底有没有花钱」：

```powershell
node .p1-baseline/audit-llm-calls.mjs --since 2026-09-15T00:00Z   # 真实调用清单（含提示词与模型）
```

**项目原生三套测试**的复现方式（含 3738 端口与 `.test-data-trace` 的前置）见
`docs/self-review-p0-p6.md` §一·补。隔离环境与成本纪律详见 `docs/p6-cutover-runbook.md` §八
与 `.p1-baseline/README.md` §六。

> **P6 切换已工具化**：S1 备份与 S3 翻转收进 `node .p6-cutover/cutover.mjs`
> （预检 → 彩排 → 令牌确认 → 执行 → 可回滚）。彩排 10/10、离线单测 32/32 通过；
> **真实切换未执行**（`harness.js` 仍是 `pre-cutover`）。

> ⚠️ **成本纪律（2026-09-15 事故后新增）**：`verify-all.mjs` 默认**不跑**任何会创建
> harness 任务或调起 dsh 的检查——那些路径可能产生**真实计费调用**。需要显式授权
> （`NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1` / `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`）。
> 套件最后一条是**总闸**：本次窗口内检出任何真实调用即判未通过。
> 事故经过与硬约束见 `.p1-baseline/README.md` §六。**别再假定「死端口 = 零成本」**。

---

## 二、历史报告 · 描述重构前的代码

保留作为"当时发生了什么"的证据，**其中的行号与函数分布已过时**。

### 上下文与记忆
- `context-memory-analysis-report.md` —— 重构前的上下文/记忆四层架构逐层精读
- `context-optimization-plan.md` / `-implementation-report.md` / `-review-report.md` —— 2026-09-13 那轮
  上下文优化（**复盘出的 5 处失误见 OpenViking 偏好记忆**：预算常量不核算下限、规模断言用小数据、
  字符串匹配未限定层边界、新增枚举不同步描述、把"质量优先"写成会伤质量的机制）

### 代码审查与走查
- `code-review-report.md` —— 2026-09-06 全库审查（161 个问题）
- `professional-experience-report.md` / `novice-experience-report.md` —— 专业与新人体验走查
- `fix-summary-2026-09-06.md` / `-novice.md` —— 对应的修复清单

### 运行追踪
- `run-trace-review-2026-09-14.md` / `-round2` / `-round3` —— 三轮追踪复核（缺陷 D1–D5）
- `change-review-2026-09-14-round2.md` / `-round3.md` —— 对应改动复审
- `ov-append-section.md` / `-round2.md` —— OpenViking 附加章节

### 其它
- `agent-change-review-2026-09-13.md` —— 模型路由改造的自审（含"注释只写主路径"的教训来源）
- `CHANGELOG.md` —— 版本记录
