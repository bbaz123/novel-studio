# source-map —— Novel Studio 生成—审稿—局部修稿链路的真实映射（E00）

> 依据：《叙事性专项修复》§7 E00。本文只记录**本次在本机仓库实际读到的**代码位置，
> 不沿用任务书里基于公开分支的行号（那些只用于定位）。行号是 2026-10-09 本机工作区的实测值，
> 会随编辑漂移；稳定的是**职责与函数名**。

## 0. 仓库与版本（E00 只读检查结果）

| 项 | 实测值 |
|---|---|
| `git rev-parse --show-toplevel` | `C:/Users/a1941/Desktop/DeepSeek/novel-studio` |
| `git rev-parse HEAD` | `10f964664e5d405f29e8afb351765dd489c128c7` |
| `git branch --show-current` | `Experimental-Version-v1.0` |
| `git status --short`（改动前） | ` M public/index.html`、` M public/styles.css`（**作者自己的侧栏 GitHub 入口改动，未提交**） |
| `node --version` | `v24.19.0`（`package.json` engines 要求 `>=22.13.0`） |
| `package.json` name / version | `novel-studio` / `1.1.6` |
| `package.json` scripts | `start: node server.js`、`dev: node --watch server.js`（**没有 `npm test`**，与任务书 §8.5 一致） |
| 项目级 `AGENTS.md` | **不存在**（全仓 glob `**/AGENTS.md` 零命中）；开发说明见 `README.md`、`docs/README.md` |
| 离线检查真源 | `scripts/ci-offline-checks.mjs`（53 条，零计费） |

工作区有作者未提交改动时按 E00 要求：**不 reset、不 clean、不 stash、不切分支**；
改动前把相关文件做了时间戳备份（`data/backup-narrative-repair-20261009181433/`）。

## 1. 端到端链路（浏览器 → 服务端 → 模型 → 回写）

```
浏览器（public/app.js）
  ├ 提示词编译
  │   ├ buildAIWritingBlueprintPrompt()   蓝图       ← WRITING_DISCIPLINE + BLUEPRINT_EXTRA_DISCIPLINE
  │   ├ buildAIWritingProsePrompt()       成文       ← WRITING_DISCIPLINE + 场面功能驱动段 + writingPolicyLines('draft')
  │   ├ buildAIReviewPrompt()             审稿       ← WRITING_DISCIPLINE + 红线扫描 + 连续性预检 + 篇幅口径
  │   ├ buildAIRevisionPrompt()           修稿（整章，兜底/作者显式）
  │   └ buildAIRevisionPatchPrompt()      修稿（按段，主路径）← PROTECTION_RULES + 授权跨度目录 + 协议 v2
  ├ 任务路由
  │   ├ runHarnessJob()                   命名作业（服务端排队/进度/取消/落库）
  │   └ longTextRunTask()（public/long-text.js） 长正文分段：片号由内容 hash 得出、覆盖清单、断点续跑
  ├ 响应解析与写回
  │   ├ parseRevisionPatchesDetailed()    「补丁输出唯一入口」（v2 严格解码 → legacy 抢救）
  │   ├ applyRevisionPatches()            旧格式 `anchor/revised` 的定位与逐段写回（兼容路径）
  │   ├ patchSafetyGate()                 → public/patch-safety.js `gatePatches()` 逐条门禁
  │   ├ revisionPatchEngine()             → public/revision-patch.js（**协议 v2**：跨度/删除/组合核验）
  │   ├ tryApplyRevisionOutput()          修稿产出统一入口（v2 走协议引擎，legacy 走兼容路径）
  │   ├ showReviewDiff()                  差异预览（含安全门禁分区、未完成项）
  │   └ textFingerprint()/contentHashOf() 版本指纹（预览期间源稿是否被动过）
  └ 作者操作
      ├ 审稿清单勾选 → refineByChecklist()（一条都没勾选**不发请求**）
      └ 失败时 showRevisionUnresolved()：重试补丁 / **显式**选择整章重写（refineByFullRewrite）

服务端（server.js）
  ├ AI 分支路由（`ai/policy.mjs` 的 MODELS / EFFORT_BY_TIER 单点策略；fast/quality 共用 deepseek-flash）
  ├ 写作策略快照 `GET /api/ai/writing-policy` ← ai/writing/policy.mjs（WRITING_POLICY_VERSION）
  ├ 编辑规则 `resolveEditingSelection()` / `buildEditingRuleBlock()` ← ai/editing/rules.mjs
  ├ 确定性扫描（红线/密度/事实锁/转场桥/叙事结构）← ai/editing/scan.mjs
  ├ 审稿报告存储：`chapter_reviews(work_id, chapter_id, report_json, checklist_json, status)`（server.js 约 4123）
  └ 采纳/审批边界：`/api/novel/review`、审批执行边界（`.p1-baseline/test-approval-boundary.mjs` 有隔离实例证据）

Harness 通道（harness-plugins/novel-writing/）
  ├ agent.cordis.yml      人设 + 工具装配（复制到 ~/.dsh 预设，无法相对 import）
  └ novel-tools.mjs       `novel_review`（约 656 行）：`issues` 按 `\n` 切成**字符串数组**后 POST /api/novel/review
```

## 2. 任务书点名的每个符号在本机的真实位置

| 符号 | 真实位置 | 备注 |
|---|---|---|
| `compileWritingRules` | `ai/writing/policy.mjs`（约 245） | 已按 scope 过滤，`WRITING_SCOPES` 见 `ai/writing/scopes.mjs` |
| 策略快照 | `ai/writing/policy.mjs` `writingPolicySnapshot()` | `WRITING_POLICY_VERSION = '2026-10-08.2'` |
| 阶段规则编译 | `ai/writing/compile.mjs` | 只有 preference/diagnostic/fact 三个取数函数（**没有**阶段审计摘要；审计摘要落在 `public/app.js` 的 `writingStageAudit()`） |
| 编辑能力的阶段变体 | `ai/editing/rules.mjs`：`stageRuleFor()`（约 92）、`buildEditingRuleBlock()`（约 410） | 本轮新增（v1.5.0）：draft / verify_style / rewrite 三版文本 + `audit` 摘要；不传 stage 时逐字用基础 `rule` |
| 装配侧阶段参数 | `server.js` `normalizeStage()` / `stageCacheSuffix()` / `buildNovelContext(..., {task, stage})` | 本轮新增：白名单 + 进缓存键（默认无 → 键与旧版逐字节相同） |
| `WRITING_DISCIPLINE` | `public/app.js`（约 9912） | 常量，蓝图/成文两处共用；**审稿轮**改用 `WRITING_DISCIPLINE_REVIEW`（同一份纪律 + 诊断/反证口径，本轮新增） |
| `buildAIWritingProsePrompt` | `public/app.js`（约 10007） | 已含"场面写法：功能驱动"段（2026-10-08 第五批） |
| `buildAIReviewPrompt` | `public/app.js`（约 10851） | 内联 `WRITING_DISCIPLINE_REVIEW` + 红线扫描 + 连续性预检 |
| `resolveEditingSelection` / `buildEditingRuleBlock` | `ai/editing/rules.mjs`（约 351 / 410） | `ABILITY.tasks` 区分 write/review；**本轮**给能力加了 `stage_rules`（阶段内容）与 `audit`（审计摘要） |
| `fiction-humanizer` | `ai/editing/rules.mjs`（约 113） | `tasks: ['write','review']`，本轮新增 `stage_rules: {draft, verify_style, rewrite}`（旧能力 ID 与既有勾选值不变） |
| `refineByChecklist` | `public/app.js`（约 11150） | 勾选为空 / 底稿为空 / **协议模块未加载**都在**付费调用之前**拦住 |
| `buildAIRevisionPatchPrompt` | `public/app.js`（本次改为协议 v2） | 下发授权跨度目录 + `schema_version:2` 契约 + 可选的"仅格式重试"块（§6.6） |
| `parseRevisionPatches` | `public/app.js` | 本次改为 `parseRevisionPatchesDetailed` 的兼容包装（含 `schema_unavailable`） |
| `applyRevisionPatches` | `public/app.js` | **兼容路径**：`anchor` 逐字唯一 → 包含退让 → 重叠拒绝 |
| `tryApplyRevisionOutput` | `public/app.js`（约 11788） | 本次改为"v2 走协议引擎 / legacy 走兼容路径"；三处调用点现已全部传 ctx（含接回进度） |
| `revisionCoverageHtml` / `showRevisionDispositions` | `public/app.js`（约 11719 / 11734） | 本轮新增：问题覆盖表（§6.7）与"只展示处置"的弹窗（空补丁/全被拦时用） |
| `NovelRevisionPatch` | `public/revision-patch.js`（v2.0.0） | `buildSpans`（约 260）、`decodePatchOutput`（约 375）、`planPatchApplication`（约 629）、`verifyCombinedCandidate`（约 903）、`combinedDeletionFindings`（约 1005）、`gatePlanPatches`（约 1133，**按段落级 before/after 构造门禁输入**） |
| `narrativeCandidateSignals` | `ai/editing/narrative-scan.mjs`（E04，本轮新增） | 四类诊断的确定性候选；**消费** `scanEditing` 的 findings，自建三类结构测量（段内 3-gram 重复 / 相邻段 bigram 包含度 / 相邻句骨架重复），通用度用文档频率而非词表 |
| `normalizeNarrativeFindings` / `validateNarrativeFinding` / `partitionProtections` / `buildNarrativeReviewPrompt` | `ai/editing/narrative-review.mjs`（E04，本轮新增） | ReviewV2 引用核验、反证降级、`auto_eligible`、三类保护分区、§9.2 提示词 |
| 叙事候选的 HTTP 出口 | `server.js` `POST /api/novel/editing/scan` | 启用 `story-shape` 时返回 `narrative`（`semantic_status:'not_run'`）；未启用时不返回 |
| `candidateWithoutIssue` / `comparisonVerdict` / `planCoverageTable` | `public/revision-plan.js`（E06，本轮新增） | 单处撤销的位置重建（缺位置/源稿变了 → 拒绝）、相对结论守卫（未读 diff → `needs_diff_review`）、覆盖表契约 |
| E06 报告与开关 | `public/app.js` | `revisionAppliedHtml`（逐条改动 + 撤销入口）、`revisionVerificationHtml`（校验状态/未完成项/核验发现）、`revisionPreference`/`setRevisionPreference`（两个可选授权，本机持久化）、`rememberProtectedContent`/`editorSelectionPlainText`、`patchSafetyOptions(chapterId, extraProtected)`、`case 'diff-drop-issue'`（撤销后重建并刷新预览；参数名是 `actionEl`） |
| ReviewV2 字段与提示词 | `ai/editing/narrative-review.mjs`（E04） | `validateNarrativeFinding` / `normalizeNarrativeFindings` / `partitionProtections` / `buildNarrativeReviewPrompt` / `REVIEW_V2_FIELDS` |
| E03 结构化审稿与选择记录 | `ai/editing/narrative-review.mjs` 的 `structureReviewReport`；`db.js` 的 `revision_selections`；`server.js` 的 `PUT /api/novel/review`（结构化+核验）与 `PUT/GET /api/novel/revision/selection`、`saveRevisionSelection` / `latestRevisionSelection`；`harness-plugins/novel-writing/novel-tools.mjs` 的 `novel_review`（新增 `findings` 参数）；`public/app.js` 的 `refineByChecklist`（修稿前写记录）与取回路径（读记录收窄 `selectedIssueIds`） |
| E02 通道等价与部署核对 | `harness-plugins/novel-writing/novel-tools.mjs`（`novel_write_pipeline` 装配带 `stage=draft`；`novel_context` 可选 `stage`）；`server.js`（`/api/ai_context` 追加 additive `edit_rules`）；`.p1-baseline/verify-plugin-tools.mjs`（通道等价 + 预设检查，含变异测试）；`.p1-baseline/verify-preset-copy.mjs`（只读部署拷贝核对：junction vs 遗留拷贝） |
| `NovelPatchSafety` | `public/patch-safety.js`（v1.1.0，974 行） | `gatePatches`（逐条）、`verifyPatchedText`（修后核验） |
| 新增 `NovelRevisionPatch` | `public/revision-patch.js`（v2.0.0，本次新增） | 协议 v2：严格解码/跨度校验/组合核验/幂等/预算 |
| `novel_review` | `harness-plugins/novel-writing/novel-tools.mjs`（约 656） | `issues` 是**换行分隔字符串**（C09 的真实形态） |
| `scanStyleDensity` / `DENSITY` | `ai/editing/scan.mjs`（约 963 / 18） | 默认关闭的能力之一，按能力开关进入请求 |

## 3. 关键调用关系（本次改动依赖的）

- `refineByChecklist` → `longTextRunTask('revision_patch')`（长正文）→ `tryApplyRevisionOutput`（**逐片**底稿）→ `patchSafetyGate` → `applyRevisionPatches`。
- `refineByChecklist` 单请求路径 → `runHarnessJob` → `tryApplyRevisionOutput` → `showReviewDiff`。
- "接回进度 / 查看上次审稿" 的恢复路径与正常流程**共用** `tryApplyRevisionOutput`（这也是本次把协议判定全部收在那个入口里的原因）。
- 门禁失败姿态：`patchSafetyGate` 在模块缺失/抛错时**放行但明示**（`safety_unavailable`）；协议 v2 的 `verifyCombinedCandidate` 在同一情形下标"未核验"，绝不写"已验证"。

## 4. 本次改动涉及的文件（源码改动全部落在这些职责点）

| 文件 | 改动性质 |
|---|---|
| `public/revision-patch.js` | **新增**：补丁协议 v2 纯函数模块（含按段落级构造门禁输入、组合核验、覆盖表） |
| `public/app.js` | 协议 v2 下发与执行接线；去掉"失败→整章重写"回退；新增显式失败选择弹窗、`refineByFullRewrite`、问题覆盖表与处置弹窗、一次仅格式重试、协议模块前置校验；**E02**：`loadAIContext({stage})`、`WRITING_DISCIPLINE_REVIEW`、`writingStageAudit()`、蓝图情节点措辞 |
| `ai/editing/rules.mjs` | **E02**：升 v1.5.0，能力增加 `stage_rules` + `stageRuleFor()`，`buildEditingRuleBlock` 接收 stage 并返回 `audit` |
| `ai/editing/narrative-scan.mjs` / `narrative-review.mjs` | **新增（E04）**：叙事诊断的确定性候选层与审稿协议层 |
| `public/revision-plan.js` | **新增（E05/E06）**：局部编辑计划（热点/授权跨度/不变量/依赖组/预算）、计划提示词、单处撤销、相对结论守卫 |
| `tests/narrative-repair/harness.mjs` | **改（2026-10-09）**：`check` 形状自适应（`(id, desc, cond, detail)` 与 `('id 描述', cond, detail)` 都正确取 `cond`）——消除"描述进 id 位"造成的假绿 |
| `server.js` | **E02**：`normalizeStage`/`stageCacheSuffix`，装配器按 `contextOpts.task/stage` 编译规则块，两个 context 端点与 editing 端点接受 stage；**E04**：扫描端点返回 `narrative` 候选 |
| `public/index.html` | `<script src="/revision-patch.js">`（在 app.js 之前，含"缺了它不会退回旧路径"的说明）；未触碰作者自己的侧栏改动 |
| `scripts/materialize-narrative-fixtures.mjs` | **新增**：按任务书 C.2 的脚本导出冻结样本 |
| `scripts/test-narrative-repair.mjs` | **新增**：专项套件总入口（3 个套件） |
| `scripts/ci-offline-checks.mjs` | 登记专项总入口（唯一真源） |
| `tests/narrative-repair/**` | **新增**：P/R/E02 类离线套件（65 + 8 + 17 条断言）与冻结 fixtures |
| `frontend-test.mjs` | 加载 v2 模块 + 探针 + 9c/9d/9e 接线断言；三条旧断言按新规格更新（见 test-report §3） |
| `docs/narrative-repair/**` | 本次交付文档（source-map / baseline / execution-state / implementation-report / test-report / coverage-report / rollback） |
