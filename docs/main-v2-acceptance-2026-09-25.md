# 主体 V2 验收报告（第二步：质量门 · 行为门 · 兼容门）

- **验收日期**：2026-09-25（承接 `docs/main-v2-upgrade-2026-09-24.md` 的主体升级）
- **验收对象**：工作树相对 `main` 分叉点的**全部未提交改动**（61 项文件级改动；生产代码 8 个文件；含本验收轮新增的报告与清单登记，验收前为 61 项、冻结时为 63 项）
- **结论**：**A PASS —— 允许冻结 Host Contract**
- **未通过项**：0　**跳过项**：1（harness 并发闸门，会建真实任务，需 `--gate-base` 显式授权）
- **验收期间发现并最小修复**：3 处（1 个**本轮引入的测试工具缺陷** + 2 处**文档与代码不符**），均已复验；详见 §8

> 本报告只记录**能从当前代码与当前测试重新证明**的结论。凡引用历史报告的条目，都在 §5 逐条重证；
> 凡口径与旧文档不一致处，§8 明确订正而不是绕过。跳过不是通过。

---

## 0. 结论摘要（先给判定，再给证据）

| 门 | 判定 | 一句话依据 |
|---|---|---|
| **质量门** | **PASS** | 用**今天这棵树**重新抓取的 50 例上下文基线与 pre-V2 基线**逐字节 50/50 完全相同**（§2.1）；三个已知质量缺陷的修复都在真实数据上可复现（§2.6/§2.3） |
| **行为门** | **PASS** | 8 项用户可见变化逐项给出「谁受影响 / 正负中性 / 必要性来源」；**无一项**是"为了整洁 / 为了测试好看 / 为了机制生效"（§3） |
| **契约门** | **PASS** | Manifest / Integrity / Provenance / Task-Run / Trace-Audit / settings 隔离 / cancellation-recovery / migration / plugin adapter 九项各有**独立命令级证据**（§4） |
| **兼容门** | **PASS** | 旧作品/章节/API/`novel_*` 工具/记忆/插件安装全部可用；对旧库**零 schema 写入、零数据删除**（§6） |
| **历史问题** | **清零** | 13 项逐条从当前代码 + 当前测试重证，0 项遗留（§5） |
| **性能** | **无回归** | 上下文装配热 p50 15/16ms、冷 p50 28/23ms（都在噪声内，且比记录值更优）；harness 冷启动生产路径 1844ms（§7） |

**是否允许冻结 Host Contract：允许。** 冻结范围见 §11。

---

## 1. 第一步：提交与 diff 审查（找"无必要的产品行为变化"）

### 1.1 改动面（`git status --porcelain`：验收前 61 项 → 冻结时 63 项）

| 类别 | 文件（生产代码，8 个） |
|---|---|
| 服务端 | `server.js`（+321/-…）、`text-utils.js` |
| 上下文核心 | `ai/context/assembler.mjs`、`ai/context/layers.mjs`、**新增** `ai/context/integrity.mjs`、`ai/context/tokens.mjs` |
| 慢通道 / 任务设置 | `harness.js`、`ai/task-settings.mjs`、`ai/harness-pool.mjs`（本轮**仅注释**） |
| 前端 | `public/app.js` |
| 新增（生成链路） | `ai/continuity-guard.mjs`、`ai/continuity-guard-source.mjs`、`ai/memory-compress-prompt.mjs` |

工程化/资产：`.github/workflows/ci.yml`、`scripts/`（隔离实例包装器 + 离线清单）、`LICENSE`(MIT)、`vendor/`（GGUF + 事实表）、`.gitattributes`/`.gitignore`。
测试/探针：`.p1-baseline/` 下 15 个（含本轮新增 `test-context-manifest.mjs` / `test-continuity-guard.mjs` / `test-memory-compress-prompt.mjs` / `verify-memory-compress-input.mjs` / `verify-continuity-guard-on-real-data.mjs` / `bench-context-build.mjs` / `probe-harness-tool-loop.mjs`）。

**关键否定性证据**：`git diff --stat -- db.js` **为空** ⇒ 本轮**零 schema 变更、零 migration**（第 4.8 项与 §6.2 用指纹复核）。

### 1.2 "消失的代码"逐条归因（防静默丢失）

用两套机械判据挖出「被删掉且没有在新增行里找回」的行，再逐个归因：

- **生产代码未找回的删除行 = 132 行，全部属于三类**：
  1. **原样搬迁**到新模块：`compactLinesWithinBudget` / `compactEntityLinesWithinBudget` → `ai/memory-compress-prompt.mjs`；`plainText` / `plainTextHead` / `plainTextTail` → `text-utils.js`。已逐 token 比对，**完全同一**（只有 `export ` 前缀差异）；压缩提示词模板**逐字同一**。
  2. 常量 `TOTAL_BUDGET` 的定义从 `server.js` 搬到 `ai/context/layers.mjs`（**值未动**）。
  3. 测试 / 文档 / 探针的搬迁与重排。
- **唯一实质常量差异**：`TOTAL_BUDGET.settings` 18000 → 19000。归因见下。
- **前端 `public/app.js`（+130/-4）**：只有两件事——① `resolveTargetWords(chapterId)` 增加显式章号参数（修"审稿期间切章会把别章篇幅目标算进来"）；② 新增**只读**连续性预检渲染（`continuityGuardSummaryHtml` / `loadContinuityGuard` / `buildContinuityGuardText`，失败返回 null/空串、**不阻塞**写作与审稿）。`buildAIReviewPrompt` 只是被重排进新增块，语义未变。

### 1.3 唯一常量差异的归属（诚实订正）

`ai/context/layers.mjs` 的 `TOTAL_BUDGET = { settings: 19000, default: 26000 }`：**19000 不是 V2 引入的**，而是 **2026-09-22 CR-1 轮**的变化——新增 `terms` 层后 `computeFloor()` 的可执行下限从 17,356 涨到 **18,173**，旧常量 18000 已低于下限，因此抬到 **19,000（= 下限 + 827）**。证据：`docs/confirmation-resolution-2026-09-22.md`、`docs/context-contract.md`、`smoke.mjs` 断言。
V2 只把该常量的**定义**搬到 `ai/context/layers.mjs`（值未动）。
→ 原报告 `docs/main-v2-upgrade-2026-09-24.md` §7.2 里"token 预算与各层 cap 未改"的口径**已在本次验收订正**（§8.3）。

**diff 审查结论**：没有任何"无必要的产品行为变化"；所有用户可见变化都在 §3 逐项登记。

---

## 2. 第二步：质量验收报告

对照条件：**同一作品、同一章节、同一模型、同一 prompt、同一核心设置**；数据源 `.p1-baseline/stress-data/novel.db`（4 部作品 w2/w9/w16/w18 × 探针章节 × 5 种模式 = 50 例）。

### 2.1 上下文逐字节对照（本轮最强证据）

| 对照 | 命令 | 结果 |
|---|---|---|
| **今天这棵树**（在隔离实例上重新抓取）vs **pre-V2 基线** | `node scripts/ci-isolated-run.mjs --port 3745 --data .p1-baseline/stress-data -- node .p1-baseline/capture-baseline.mjs --base http://127.0.0.1:3745 --db .p1-baseline/stress-data/novel.db --out <tmp>` 然后 `node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-before-v2 <tmp> --ignore-notice` | **逐字节一致 50/50　→ IDENTICAL** |
| V2 落盘快照 vs pre-V2 基线 | `node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-before-v2 .p1-baseline/baselines-v2b --ignore-notice` | **逐字节一致 50/50　→ IDENTICAL** |

`assembled` 是**唯一进模型的那段文字**：它逐字节相同 ⇒ **模型看到的东西没有变**。`--ignore-notice` 只归一「已按预算截断…」这类提示语里的工具名差异，**不掩盖正文差异**。
（口径说明：`ai_context` 模式的基线对象里没有 `mode` 字段，比对器把该字段显示为 `undefined`——两侧一致，不影响结论。）

### 2.2 上下文规模与关键事实覆盖

抓取时打印的逐层剖面（今日实测，与 pre-V2 逐字节相同，故未变）：

| 作品 | full | continuation | fragment | settings |
|---|---|---|---|---|
| w2 | 7610 | 5559 | 5573 | 5625 |
| w9 | **20713** | 20015 | 23293 | — |
| w18 | 5772 | 4968 | 4849 | — |

（单位：字节；含 `✂` 被 cap 截断标记与 `∅` 空/占位标记。层数 11–14 层随模式变化，与 pre-V2 相同。）

### 2.3 角色状态 / 时间线 / 伏笔 / 世界观连续性

- **层内数据来源未变**：`events`（事件账本）/ `foreshadows`（未闭合伏笔）/ `characters`（出场角色卡）/ `world`（世界观）/ `relations` 的数据与 pre-V2 **逐字节相同**（§2.1 的直接推论）。
- **新增的只读连续性预检**在**真实作品**上成立：`node .p1-baseline/verify-continuity-guard-on-real-data.mjs --db data/novel.db`（只读）→ 第五章命中 **3/3**、第六章 **2/2**，**命中 5 ｜ 漏报 0 ｜ 误报 0**；豁免闭环成立；18 条发现里"系统出场偏多""篇幅目标口径不一致"能对上作者自己的真实审稿报告（id=2、id=3）。
- 离线真值表 + 阴性对照 **69** 条断言通过（`test-continuity-guard.mjs`）。
- **不阻塞**：预检只产出提示行，写入/审稿路径在预检失败时照常进行（`loadContinuityGuard` 捕获后返回 null）。

### 2.4 空回复 retry（复核既有机制，非本轮改动）

实现在 **`public/app.js`**（`directAIWrite` 约 4583 行、`streamAIDirectWrite` 约 4660 行；**不是** server.js 里的函数）。

`node frontend-test.mjs` → **164 PASS / 0 FAIL**，其中：

| 断言 | 结论 |
|---|---|
| 105 | 第一次空回复后**先保持原思考强度**重试（不降 `low`） |
| 111b | 空回复先保持原强度 + 放宽输出上限重试一次 —— 请求体序列 `[{"m":4096},{"m":8192}]` |
| 111c | 重试成功时用**重试结果**交付 |
| 111d | 重试仍空后**才**降 `low` 兜底；三次都空才抛错 —— `{"calls":3,"bodies":[{"m":4096},{"m":8192},{"e":"low","m":8192}]}` |
| 111e | **半截流**（有正文但没等到 `done`）仍抛错，绝不把残缺正文当成品交付 |

→ 与"先保思考强度、只加 `max_tokens`，再受控降级"的设计一致，方向是**质量优先**。

### 2.5 Direct / Harness 路由

- 本轮**未改路由判定**（diff 里没有 `ai_direct_fallback` / 路线选择逻辑的改动）。
- 慢通道（harness）实际选择的启动方式仍是**预构建产物优先**（`resolveDshLaunch`）：今日实测生产路径冷启动 **1844ms**，与"预构建"对照同档、明显优于"源码现场转译"（§7.2）。
- 线路层核对（专用 profile 是否把创作内核挂进请求）**8/8** 通过（会真 spawn dsh、零计费）。

### 2.6 Memory → Context → Generation → Validation → Projection 闭环

| 检查 | 命令 | 结论 |
|---|---|---|
| 压缩输入前后对照（**只读**，真实数据） | `node .p1-baseline/verify-memory-compress-input.mjs --db data/novel.db --all` | 作品 #9 章节段 422 → **1334 字**，其中"最近章节尾部" **0 → 912 字**；最新一章正文结尾确实进了提示词。作品 #18 因**最新 44 章正文为空**，尾部仍为 0 字（**如实边界**：没有正文可取，不是取不到） |
| 压缩零损失护栏 | `.p1-baseline/test-memory-compress-guard.mjs` | **66** 条断言通过（含"落库仍在完整性检查之后"） |
| 压缩提示词输入 | `.p1-baseline/test-memory-compress-prompt.mjs` | **20** 条通过（含"辅助函数不再在 server.js 里另留一份"） |
| agent memory guard | `.p1-baseline/test-agent-memory-guard.mjs` | **47** 条通过（含"只有专用 home 时不回落成 `~/.dsh`"） |
| 自动压缩开关 | `verify-all.mjs` 内 | 默认关闭（"不打开不花钱"）成立 |
| 检索缺口口径 | `.p1-baseline/test-recall-gap.mjs` | **17** 条通过 |

**为什么长章节中后部的事实不会被误判为"未出现"**：压缩输入现在带上了最近章节的**正文尾部**（修前恒空），且"全部章节摘要 / 近期章节 / 关键事件"三段覆盖策略保持不变（逐字节相同的层结构）。

### 2.7 生成后处理（post-processing）

diff 中没有生成后处理改动（`plainText*` 是**逐 token 搬迁**，不是重写）；`frontend-test.mjs` 164 条断言全绿，含修订差异、审稿、批量生成等后处理相关路径。

---

## 3. 第三步：行为影响门（逐项 5 问）

> 判定标准：凡"只是为了代码更干净 / 为了机制生效 / 为了测试好看"的行为变化一律不通过。

| # | 变化是什么 | 哪些真实用户受影响 | 影响 | 必要性来源 | 若无真实影响是否应恢复 |
|---|---|---|---|---|---|
| 1 | 篇幅目标改为**按当前章号**计算（`resolveTargetWords(chapterId)`） | 边审稿边切章的作者 | **正面**（修 bug） | 真实缺陷：切章后目标字数会算进别章 | —（缺陷修复） |
| 2 | 新增**只读**连续性预检提示条 | 全部写作用户 | **中性偏正面**（附加信息，不阻塞） | 真实用户需求（审稿报告里已有的诉求） | 不恢复：只读、失败即静默、不改变写作流程 |
| 3 | 慢通道（dsh）**首次真正带上创作人设** | 用慢通道生成的作者 | **正面** | 真实缺陷：`cordis.patch.yml` 里写的键名与 dsh 认的键不同，schema 非 strict ⇒ **静默丢弃**，此前慢通道没有人设约束 | —（缺陷修复） |
| 4 | dsh 0.1.7 适配：默认模型/强度改走补丁层 `config` 覆盖 | 升级 dsh 后的全部用户 | **正面** | 真实缺陷：旧写法在 0.1.7 **静默失效** ⇒ "模型/强度静默不生效" | —（缺陷修复） |
| 5 | 新增"一次性导入待处理"**告警**（`warnIfLegacyImportPending`） | 升级 dsh 后的用户 | **中性偏正面**（只告警，**不替用户改持久配置**） | 告警是诊断，不是行为改变 | 保留：无告警会让上述静默失效不可见 |
| 6 | `/api/novel/context` 与 `/api/ai_context` 响应新增 `context_id` / `context_request_id` / `context_integrity` / `context_envelope` 与清单字段 | 全部用户（**纯附加**） | **中性** | 契约（可追问、可核对） | 保留：旧字段与旧语义未动，旧消费方不受影响 |
| 7 | 旧前端"无预算拼装"路径**不再存在**（`aiContextBlock` 只返回服务端 `assembled`；缺失时回退 `/novel/context`） | 全部用户 | **中性**（P2 起即如此，本轮只是复核） | 契约 I5/I6：两条路径渲染同一份数据却差 3 倍，是上下文质量最大的结构性缺口 | 不恢复 |
| 8 | 热备池（`ai/harness-pool.mjs`）**未接线** | 无（默认行为与接线前一致） | **无变化** | — | 不变；文档口径已订正（§8.2） |

**没有**出现的行为变化（逐条确认）：默认模型/档位、思考强度、`LONG_AI_TIMEOUT_MS`（30 分钟）、token 预算与各层 cap、上下文层数与顺序（`FLEX_ORDER`）、生成后处理、自动压缩默认值（关）、harness 并发语义、取消语义。

---

## 4. 第四步：宿主契约验收（每项给独立证据）

| 契约 | 证据（命令 → 结论） |
|---|---|
| **Context Manifest** | `node .p1-baseline/test-context-manifest.mjs` → **44/44**（逐层原始长/采用长/占用/被裁字数；含阴性对照）；活体：`GET /api/novel/context` → `context_manifest` **13 层**，逐层带 `selected`/`trimmed`/`source`/`reason` |
| **Context Integrity** | 同上 44 条内含"清单与真正发出去的文字逐字节对齐（C1）"；活体：`context_integrity.status = **PASS**`（`failed=[] warned=[]`）。**刻意不拦截生成**：拦截会改变用户可观察行为，属产品决策，本阶段只做可归因记录 |
| **Provenance** | `node .p1-baseline/verify-retrieval-map.mjs` → **17/17**：13 个可截断层**每层都有查回工具或显式内在性说明**，且工具名与 `plugin.json` 交叉核对一致、无陈旧声明；活体：13/13 层带来源字段、13/13 层带 `reason` |
| **Task / Run** | `node .p1-baseline/test-task-settings.mjs` → **37/37**（每任务补丁的 provider 取自"settings 文档 → profile 补丁 → 出厂默认"三级取值）；`.p1-baseline/test-harness-env.mjs` → **33/33**（子进程环境隔离，**不得回落 3737**） |
| **Trace / Audit** | `verify-all.mjs` 内"套件总闸"→ **本次未产生真实 LLM 调用**（窗口内 2 条 dsh 会话，其中 1 条拿到模型文本，全部由**本地假端点**自证归属 127.0.0.1；判据=回环端点 + 实收数≥转录数 + 正文等于罐头文本）；`.p1-baseline/audit-llm-calls.mjs --self-test` **8/8**（含 5 条阴性对照） |
| **settings 隔离** | `test-task-settings.mjs` 37 条 + `test-harness-env.mjs` 33 条 + API 套件 M31（策略快照含档位→强度与长任务超时）；**每任务视图互不污染**由"路由键把 provider/model/强度三者都编进去"（`test-harness-pool.mjs` 1a）保证 |
| **cancellation / recovery** | `test-harness-pool.mjs` → **23/23 含 3g**「外部取消会终止任务并带 `HARNESS_CANCELLED`」；活体（旧库上）：`GET /harness/recoverable` → 200 且带 `jobs`；`GET /harness/recovered?id=不存在` → **404**；`POST /harness/cancel` 不存在任务 → **404**；`POST /harness/mark_applied` 缺参 → **400**（**均非 500**） |
| **migration** | `db.js` **零改动** + 旧库 `sqlite_master` 指纹 **`3cb7e5d9ac4f67b9`（63 个对象）实例启动前后完全一致** + 关键表行数一致（works 2 / chapters 7 / characters 27 / story_memories 2 / story_events 8 / world_entries 5 / terms 37）⇒ **对旧库零 schema 写入、零数据删除** |
| **plugin adapter** | `node .p1-baseline/verify-plugin-tools.mjs` → 工具面/版本/端点声明三者一致（**15 个工具**）；插件冒烟 `node harness-plugins/novel-writing/test/smoke.mjs` → **39/39**；工具循环探针（真 spawn dsh）→ **7/7**（模型→工具→模型真跑通，零计费） |

---

## 5. 第五步：历史问题清零表（13 项，全部从当前代码/测试重证）

| # | 历史结论 | 当前代码实际状态（本轮自证） | 仍影响真实用户？ | 风险 | 修复计划 |
|---|---|---|---|---|---|
| 1 | `getPath` 畸形 URL 抛穿请求 | `server.js:166` 仍会 `throw`，但**调用点已兜住**（`server.js:4991-5000`：记 `http_bad_url` warn + 400）。活体实测 5 种畸形 URL（`/%E0%A4%A`、`/%`、`/api/%E0%A4%A`、`/%C0%AF`、`/api/%E0`）**全部 400 `{"error":"请求地址不合法"}`** | 否 | 低 | 无需修 |
| 2 | ZIP/EPUB 解压无大小上限 | 三层防守**真实生效**（`.p1-baseline` 外的 `zip-reader.mjs`）：单条目 128MB / 整包 256MB 声明值预检 + `inflateRawSync(..., {maxOutputLength})` + 解压后**实际长度**复核。**真实行为探针**：正常小包可读；声明 200MB 被拒；**真实 deflate 炸弹**（解压 130MB、目录谎报 1KB、压缩包仅 129KB）被 inflate 上限拒（`Cannot create a Buffer larger than 134217728 bytes`）；累计 300MB 真实数据被整包上限拒 → **7/7** | 否 | 低 | 无需修 |
| 3 | 静态文件路径靠脆弱字符串前缀 | `server.js:4898` 用 `path.relative(publicDir, filePath)` + `startsWith('..'+sep)` + `isAbsolute` 判定。活体实测 4 种穿越（`%2e%2e`/`..%2f`/`../server.js`/`..%5c`）**均未泄露**（落到 SPA fallback） | 否 | 低 | 无需修 |
| 4 | `server.js` 职责过重 | 仍是大文件（约 5044 行），但本轮**只做加法式拆分**（`ai/context/*`、`ai/memory-compress-prompt.mjs`、`text-utils.js`），没有一次性重写 | 否 | 中（维护性，非用户） | 后续按"有真实维护收益且可证明不影响行为"渐进拆 |
| 5 | Direct / Harness 路由是否统一 | 两条入口共用同一档位→强度口径（`normalizeReasoningEffort`）；本轮未改判定逻辑 | 否 | 低 | 无需修 |
| 6 | Harness 冷启动 / 热备池是否有真实机会 | **冷启动收益来自"预构建产物优先"**（`resolveDshLaunch`），今日实测生产路径 **1844ms**、预构建对照 1935ms、源码现场转译 3224ms。热备池（`ai/harness-pool.mjs`）经核实**未接线到生产路径**（`harness.js` 仍走"每任务一个子进程"；`createWarmPool` 无生产调用方） | 否 | 低 | **不接线**（当前瓶颈已由预构建解决）；文档里那个不存在的 `NOVELSTUDIO_HARNESS_POOL=1` 开关已订正（§8.2） |
| 7 | memory compression / agent memory guard 重复大查询 | 压缩输入查询已收敛为"全部章节摘要 + 近期章节 + 关键事件"三段（`verify-memory-compress-input.mjs` 实测 1334 字输入，含 912 字最近正文）；护栏 66 条 + 记忆守卫 47 条断言通过 | 否 | 低 | 无需修 |
| 8 | `LONG_AI_TIMEOUT_MS` 是否单点统一 | 单点 `ai/policy.mjs:103 = 30 分钟`；`server.js:683` **别名引用**它、`harness.js` import 它、前端退化为同值兜底（`public/app.js:29`）。`harness.js:428` 的 20 分钟是 **pnpm 命令**超时，不是 AI 调用 | 否 | 低 | 无需修 |
| 9 | 流式空回复 retry 是否先保强度、再加 max_tokens | 是（`public/app.js` `directAIWrite`/`streamAIDirectWrite`）：`[{"m":4096},{"m":8192},{"e":"low","m":8192}]`；半截流抛错 | 否 | 低 | 无需修 |
| 10 | 是否仍有绕过预算的 legacy context fallback | **没有**：前端 `aiContextBlock()` 只返回服务端 `assembled`（`public/app.js:5558-5565`），缺失时 `loadAIContext` 回退到**同一装配器**的 `/novel/context`（5496-5500）；`/api/ai_context` 内部也走同一个 `buildNovelContext` 缓存键（`server.js:3745-3751`，契约 I5/I6） | 否 | 低 | 无需修 |
| 11 | Context trimming 是否有 recovery 路径 | 有：`verify-retrieval-map.mjs` 17/17（13 个可截断层全部有查回工具或显式内在性声明）；`integrity.mjs:94-97` 用清单里真实的 `recoveryPath` 字段做 I4 判定（并记录了"字段名写成 snake_case 导致全量误报"的历史教训）；活体：被裁层 `recoveryPath` 齐备 | 否 | 低 | 无需修 |
| 12 | 现有 regression suite 是否完整 | 离线 **31/31**（`scripts/ci-offline-checks.mjs`）+ 一键 **52 通过 / 0 未通过 / 1 跳过**（`verify-all.mjs`）+ 活实例 **183/187（0 失败 / 4 跳过）**（`api-test-suite.mjs`）+ 插件冒烟 **39/39** + 前端 **164/0** | 否 | 低 | 保持；新增探针已登记进离线清单 |
| 13 | GitHub Actions / LICENSE / 跨平台启动 / LAN / EPUB / DOCX / 上下文预览 的真实状态 | CI：`.github/workflows/ci.yml` **新增**（离线 / 依赖下限 / 活实例三档，每 job 先打平台事实）；LICENSE：**MIT**（含第三方资产段）；EPUB：零依赖 `zip-reader.mjs` + 上限（第 2 项）；DOCX：**现状未变**（本轮未做）；上下文预览：`/api/ai_context` 结构化字段保留 + 新增 `assembled`/清单；跨平台启动/LAN：**现状未变** | 否（无回归） | 低 | DOCX / LAN 属"新增能力"，按真实用户需求排序后再做 |

---

## 6. 第六步：兼容性报告

### 6.1 旧作品 / 旧章节 / 旧 API / 旧工具 / 旧记忆（活体，旧库副本）

真实旧库副本（`.p1-baseline/data/novel.db`：2 部作品 / 7 章 / 27 角色 / 2 条记忆 / 8 事件 / 5 世界观 / 37 词条）在隔离实例上实测（**26/26 通过**）：

| 检查 | 结果 |
|---|---|
| `GET /api/works` | 200；旧作品"雾都缝匠""我真的只是一个路人啊"**都在** |
| 旧作品章节列表 / 单章正文 | 6 章可读；单章正文 452 字非空 |
| `GET /api/novel/context` | 200 + `context_id` / `context_integrity=PASS` / `context_envelope` / 13 层清单 |
| `POST /api/novel/continuity_guard` | 200（只读，findings=0） |
| 旧库**可写** | `POST /api/works` → **201**（新 id=17）；`DELETE` → 200；再 `GET` → **404** |
| 旧记忆 | `GET /api/story_memory?work_id=9` → 200（摘要 781 字） |
| 旧设置 | `GET /api/ai/policy` → 200（models + `effort_by_tier` + `long_ai_timeout_ms=1800000`）；`GET /env/tools` 200 |
| **前端 API 面** | 从 `public/app.js` 抽出 **110 条** `api(...)` 调用路径，**逐条**在 `server.js` 里仍有对应资源处理（0 条失配）；10 条只读端点实测全部 <500 |
| **`novel_*` 工具** | 15 个工具在插件目录里**全部有定义**；`verify-plugin-tools.mjs` 工具面/版本/端点三者一致 |
| 插件安装流程 | `/api/demo/{status,install,remove}` 路由存在；冒烟 39/39（含安装/卸载与工具链） |

### 6.2 旧库零写入（强判据）

实例启动 + 全部探针跑完后，`sqlite_master`（table/index/view/trigger 共 63 项）的 sha256 前 16 位 **`3cb7e5d9ac4f67b9` 前后完全一致**；关键表行数一致（2/7/27/2/8/5/37）。⇒ **没有隐式迁移、没有清理、没有删改旧数据**。

---

## 7. 性能对照（本轮实测，不引用旧数当结论）

### 7.1 上下文装配（`bench-context-build.mjs`，作品 #16 / 章节 #108，n=12）

| 路径 | 记录值（p50） | **今日实测（p50）** | 结论 |
|---|---|---|---|
| `ai_context`（主成文路径，热） | 15ms | **15ms**（min 9 / p95 65 / max 65） | 不变 |
| `novel/context?mode=full`（创作内核，热） | 14ms | **16ms**（min 3 / p95 17） | 噪声内 |
| `ai_context`（冷：每次先作废缓存） | 37ms | **28ms**（min 16 / p95 72） | 噪声内（更好） |
| `novel/context`（冷） | 26ms | **23ms**（min 11 / p95 27） | 噪声内（更好） |

装配字数 20,713（与 pre-V2 相同）。**结论**：上下文装配没有性能回归；本轮**没有**引入新 cache/batch/memoization。

### 7.2 Harness 冷启动（`probe-cold-start.mjs --runs 2`，零计费假端点）

| 启动路径 | 今日实测（冷启动均值） | 记录值（同为均值） |
|---|---|---|
| A 源码 `tsx/esm` 现场转译 | **3224ms** | 6.9s |
| B 预构建 `apps/cli/lib/bin.js` | **1935ms** | 4.7s |
| C **生产路径**（`harness.js` 实际选择） | **1844ms** | **4.4s** |

**读法（不夸大）**：两组数字的**方向与结论一致**——C≈B（生产确实走预构建产物）、A→B 就是"省掉每任务现场转译"的收益（今日 **≈1.3s**，记录值 ≈2.2s）。**绝对值差异来自测量条件**：记录那次是页缓存冷态的首次采样，今日 dsh 仓库已在页缓存里。**这不构成回归**，但报告不再把 4.4s / 12.6s 当作当前环境的固定值。

---

## 8. 验收期间发现的问题与最小修复（3 处，均已复验）

### 8.1 【本轮引入的测试工具缺陷】假端点流式分支无条件读 `tool.name` → 崩溃

- **现象**：`node .p1-baseline/probe-cold-start.mjs --runs 2` 在 A 段直接崩在 `.p1-baseline/fake-llm.mjs:470`，`TypeError: Cannot read properties of null (reading 'name')`，测不到任何数字。
- **根因**：本轮给假端点加"回一轮工具调用"能力时，把 `const toolStartBlock = { ... name: tool.name ... }` 写成了**无条件求值**；`tool` 只在显式配了 `--tool-call` 时才非 null ⇒ **任何普通流式请求**（probe-cold-start / probe-sdk-runtime）都会把端点打崩。
- **影响面**：**只有测试工具**。`fake-llm.mjs` 不被任何产品代码 import（`rg` 全仓确认），不进发布产物；但它会让"冷启动对照"与"sdk 运行时"两类证据**测不出来**——属于"证据工具坏了"，必须修。
- **修复（最小）**：把构造改为惰性（`const toolStartBlock = () => ({...})`），调用点 `sseMsg(toolStartBlock())`。**产品代码零改动**。
- **复验**：`probe-cold-start.mjs` 正常出数（§7.2）；`probe-sdk-runtime.mjs` **ALL PASS（零计费）**（`stream=true` 请求现在被正常应答）；`probe-harness-tool-loop.mjs` 仍 **7/7**；`verify-all.mjs` 仍 **52/0/1**。

### 8.2 【文档与代码不符】热备池的"环境变量开关"在代码里不存在

- **现象**：`README.md`、`ai/harness-pool.mjs` 头注释、`docs/main-v2-upgrade-2026-09-24.md` 都写"热备池默认关闭，`NOVELSTUDIO_HARNESS_POOL=1` 才启用"。
- **实际**：全仓（除上述文档）**没有任何代码读该变量**；`createWarmPool` / `harness-sdk-worker.mjs` 没有生产调用方 ⇒ 池**未接线**。设了变量也不生效。
- **真实用户影响**：**无**（接不接线行为都一样）。但"文档说有个开关"会误导后续开发按错误前提做决策。
- **修复（最小、纯注释/文档）**：三处改为"**未接线到生产路径，没有环境变量开关**；冷启动收益来自预构建产物；接线前先测收益并保留 spawn 回退"。（`docs/code-review-2026-09-19.md` 是**历史评审快照**，按惯例不重写。）

### 8.3 【口径订正】V2 报告 §7.2"token 预算与各层 cap 未改"

- **问题**：该句没有把 **2026-09-22 CR-1 轮**把 `TOTAL_BUDGET.settings` 抬到 19,000 这件事算进去，容易被读成"19000 也是 V2 改的"（反过来说，也可能被读成"预算完全没动过"）。
- **修复**：改为"**V2 未改**；`settings = 19000` 是 CR-1 轮的既有变化（`computeFloor()` 下限 17,356 → 18,173），V2 只搬了定义、值未动，并给出证据文件"。

---

## 9. 未通过项 / 跳过项 / 残余风险与补救

**未通过项：0。**

**跳过项：1** —— `harness 并发闸门`（会真的创建 harness 任务，需 `--gate-base` + `NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1` 显式授权）。**跳过不是通过**；它检验的是"并发槽位是否真的串行化"，本轮未跑，故不作为证据。

**残余风险 4 项（均为证据/工具面，不涉及产品行为，故不阻断冻结）**：

| # | 风险 | 补救措施 |
|---|---|---|
| 1 | 新增 CI 的 **ubuntu 两格从未在本地预演**（本机无 WSL/Docker） | 首次真红时**修脚本、不许整格 `continue-on-error`**（已写进 workflow 注释）；三档职责分离，离线档不依赖平台 |
| 2 | CI 里"工具循环"探针是 **SKIP**（需要 dsh 仓库 + 显式授权） | 已在文档与本报告标注"跳过≠通过"；本机已实测 7/7 |
| 3 | "花钱总闸"的归属层依赖**探针自报**（回环端点 + 实收数≥转录数 + 正文等于罐头文本） | 该判据已 `--self-test` 8/8（含 5 条阴性对照）；属"判定标准明确可复核"，不是形式化证明 |
| 4 | harness 冷启动**绝对值受页缓存影响**（§7.2） | 报告同时给出两组数字与条件；结论只用**相对关系**（C≈B、A→B 的差额） |

---

## 10. 实际修改文件（本轮验收轮，全部为最小改动）

| 文件 | 改了什么 | 是否影响产品行为 |
|---|---|---|
| `.p1-baseline/fake-llm.mjs` | 工具调用块改为惰性构造（修 §8.1 崩溃） | 否（测试工具） |
| `ai/harness-pool.mjs` | **仅头注释**：写清"未接线、无环境变量开关" | 否（注释） |
| `README.md` | 热备池那条改为"尚未接线" | 否（文档） |
| `docs/main-v2-upgrade-2026-09-24.md` | §7.2 口径订正（§8.3）+ 热备池行订正 | 否（文档） |
| `docs/main-v2-acceptance-2026-09-25.md` | **本报告** | 否（文档） |
| `docs/README.md` | 索引加一行 | 否（文档） |
| `.p1-baseline/verify-phase-map.mjs` | 把本报告登记进改动归属清单（否则阶段映射会把新文件判成"无归属"） | 否（工具清单） |
| `docs/phase-map.md` | 由上面那条清单**重新生成**（生成物；`verify-phase-map.mjs --write`） | 否（文档） |

**产品代码（`server.js` / `public/app.js` / `harness.js` / `ai/**` / `db.js`）在本轮验收中一行未改。**

---

## 11. 是否允许冻结 Host Contract

**允许冻结。** 冻结内容：

1. `/api/novel/context` 与 `/api/ai_context` 的**既有字段语义**（含新增的附加字段名）：`context_id` / `context_request_id` / `context_integrity` / `context_envelope` / `context_manifest` / `context_overflow` / `context_stats` / `assembled`。
2. `ai/context/layers.mjs` 的层规格（`LAYERS` / `RETRIEVAL` / `TOTAL_BUDGET` / `FLEX_ORDER` / cap）作为**层预算唯一来源**；插件与工具查回路径以 `RETRIEVAL` 为准。
3. `ai/context/integrity.mjs` 的完整性判定（PASS/WARNING/FAIL）与"**只记录、不拦截生成**"的语义。
4. `ai/policy.mjs` 作为模型/档位/强度/长任务超时的**单点**。
5. `ai/harness-pool.mjs` 的协议与池策略**接口形状**（`routeKeyOf` / `runPromptOnWorker` / `createWarmPool({spawnWorker,maxWarm,idleMs})`）——但**明确标注：当前未接线**，接线属产品决策。
6. 插件（`harness-plugins/novel-writing`）的 15 个 `novel_*` 工具名与端点映射，以及 `cordis.patch.yml` 的补丁形状。

**允许在不改变上述语义的前提下扩展**（新增字段、新增层、新增工具）——扩展必须是**附加式**，且不得绕过预算体系。

---

## 11.5 冻结树上的最终一遍（本报告全部数字的来源状态）

本报告的所有数字都来自**同一棵冻结树**（即 §10 全部改动已落盘之后）：

| 套件 | 结果 |
|---|---|
| 上下文逐字节对照（**重新抓取**） | **50/50 IDENTICAL** |
| `verify-all.mjs`（授权 spawn dsh） | **52 通过 / 0 未通过 / 1 跳过** |
| `scripts/ci-offline-checks.mjs` | **31 通过 / 0 未通过** |
| `api-test-suite.mjs`（隔离实例） | **183 通过 / 0 失败 / 4 跳过** |
| 插件冒烟 `smoke.mjs` | **39/39** |
| `frontend-test.mjs` | **164 PASS / 0 FAIL** |
| 阶段映射核对 `verify-phase-map.mjs` | **通过**（生成物 `docs/phase-map.md` 已同步） |
| 花钱总闸（`verify-all` 内） | **本次未产生真实 LLM 调用** |

> **后续（第三步 · Host Contract 冻结）**：本报告之后追加了 1 个**附加**响应字段（`GET /api/novel/ping` 回报
> `host_contract` 版本）与契约测试，其余未动；该轮的复核数字与全部结论见 `docs/host-contract.md`（§11）——
> 逐字节基线仍 **50/50**、一键验收升为 **53 通过 / 0 未通过 / 1 跳过**（多是那一条契约测试）。
>
> 落地顺序说明：本报告与 `docs/README.md` 索引、`verify-phase-map.mjs` 清单属于同一批文档改动；
> 它们之后又重新跑了上面这一遍（含重新抓取基线），所以结论对**当前工作树**成立。
## 12. 复现命令（零计费）

```bash
# 质量控制：今天这棵树的上下文是否与 pre-V2 逐字节相同（最强判据）
node scripts/ci-isolated-run.mjs --port 3745 --data .p1-baseline/stress-data -- \
  node .p1-baseline/capture-baseline.mjs --base http://127.0.0.1:3745 \
  --db .p1-baseline/stress-data/novel.db --out /tmp/fresh
node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-before-v2 /tmp/fresh --ignore-notice

# 一键验收（含契约 / 记忆 / 路由 / 连续性 / 花钱总闸）
NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1 node scripts/ci-isolated-run.mjs --port 3739 \
  --data .p1-baseline/stress-data -- node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3739

# 离线清单（31 条，零计费）
node scripts/ci-offline-checks.mjs

# 活实例套件
node scripts/ci-isolated-run.mjs --port 3738 --data <tmp> -- node api-test-suite.mjs
node harness-plugins/novel-writing/test/smoke.mjs
node frontend-test.mjs

# 性能对照
node scripts/ci-isolated-run.mjs --port 3739 --data .p1-baseline/stress-data -- \
  node .p1-baseline/bench-context-build.mjs --base http://127.0.0.1:3739 --n 12        # 热
node scripts/ci-isolated-run.mjs --port 3739 --data .p1-baseline/stress-data -- \
  node .p1-baseline/bench-context-build.mjs --base http://127.0.0.1:3739 --n 12 --cold # 冷
NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1 node .p1-baseline/probe-cold-start.mjs --runs 2
```