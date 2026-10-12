# source-map.md｜本地 1.1.6 的真实源码映射与调用链

> 目标工作区：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`
> HEAD：`6f9a14b0d1f7e11117b68d0536aee5ca238969cd`｜分支：`Experimental-Version-v1.0`｜`package.json` version：**1.1.6**｜Node：`v24.19.0`
> 纪律：本文件只写**实际存在的文件与函数**；任务书 §2 的"公开源码观察"一律经本地复核后才下结论。

## 1. 与本轮责任相关的真实文件

| 责任 | 文件 | 关键函数/常量 |
|---|---|---|
| 修稿入口、结果预览、采纳 | `public/app.js`（15165+ 行，单文件前端） | `refineByChecklist`、`tryApplyRevisionOutput`、`buildAIRevisionPatchPrompt`、`revisionPlanFor`、`revisionSnapshotFor`、`revisionSpanCatalogue`、`showReviewDiff`、`showRevisionUnresolved`、`patchSafetyNotesHtml`、`mergeReviewDiff`、`longTextKindMeta('revision_patch')` |
| 精确补丁协议 v2 | `public/revision-patch.js`（UMD，浏览器与 Node 共用） | `decodePatchOutput`、`planPatchApplication`、`runRevisionPipeline`、`applyPlan`、`gatePlanPatches`、`verifyCombinedCandidate`、`textFingerprint`、`snapshotOf`、`buildSpans`、`createRetryBudget` |
| 局部编辑计划 EditPlan | `public/revision-plan.js`（UMD） | `buildRevisionPlan`、`locateFragment`、`buildRevisionPatchPromptFromPlan`、`isPlanStale`、`planCoverageTable`、`candidateWithoutIssue`、`comparisonVerdict` |
| 修稿安全门禁 / 修后核验 | `public/patch-safety.js`（UMD，v1.1.0） | `deletionRisks`、`gatePatches`、`verifyPatchedText`、`classifyEditScope`、`scanFactLock`、`HARD_CODES` |
| 叙事诊断（确定性候选） | `ai/editing/narrative-scan.mjs` | `narrativeCandidateSignals`、`DIAGNOSTICS`、`narrativeParagraphsOf` |
| 叙事审稿协议（引用核验） | `ai/editing/narrative-review.mjs` | `normalizeNarrativeFindings`、`validateNarrativeFinding`、`locateQuote`、`partitionProtections`、`buildNarrativeReviewPrompt` |
| 阶段化规则编译 | `ai/editing/rules.mjs`、`ai/writing/policy.mjs` | `compileStageRules`/`stageRuleFor`（`stage_rules`）、`writingStageAudit` |
| 审稿/选择记录存储 | `server.js`、`db.js` | `saveReview`、`saveRevisionSelection`、`latestRevisionSelection`、表 `chapter_reviews`、`revision_selections`、`adoption_operations` |
| 整次采纳幂等 | `server.js`（`POST /api/novel/adopt`） | `operation_key` → `adoption_operations.idempotency_key`（同键原样重放返回原结果；同键不同内容 409） |
| 插件工具面 | `harness-plugins/novel-writing/novel-tools.mjs`、`plugin.json` | `novel_review`、`novel_chapter_save` 等 26 个工具 |
| 离线验收 | `scripts/ci-offline-checks.mjs`、`scripts/test-narrative-repair.mjs`、`scripts/run-narrative-acceptance.mjs`、`frontend-test.mjs`、`.p1-baseline/*` | 见 `test-report.md` |

## 2. 真实调用链（带文件与函数）

```
审稿按钮（app.js handleAction → runArticleReview）
  → 上下文阶段装配（ai/editing/rules.mjs stage_rules + ai/context/assembler.mjs）
  → Harness 请求（runHarnessJob → POST /api/harness/run）/ 直连（directAIWrite）
  → 审稿原始输出（parseReviewText / structureReviewReport）
  → ReviewV2 校验（ai/editing/narrative-review.mjs validateNarrativeFinding + locateQuote 逐字唯一核验）
  → 报告持久化（PUT /api/novel/review → server.js saveReview → chapter_reviews）
  → UI 问题 ID 与勾选（app.js showReviewReport：data-review-issue=<报告原始序号>）
  → EditPlan（app.js revisionPlanFor → public/revision-plan.js buildRevisionPlan）
  → Host 授权表（public/revision-plan.js planAuthorization）
  → PatchV2 请求（app.js buildAIRevisionPatchPrompt → runHarnessJob，携带 plan/authorization/稳定编号）
  → 解析/跨度/授权白名单（public/revision-patch.js decodePatchOutput → planPatchApplication）
  → 单条门禁（public/revision-patch.js gatePlanPatches → patch-safety.gatePatches）
  → 组合门禁（public/revision-patch.js verifyCombinedCandidate → deletionRisks/sceneBridgeRisks/scanFactLock）
  → 差异预览（app.js showReviewDiff：覆盖表 + 逐条改动 + 校验状态 + 安全门禁/修后核验两段）
  → 作者采纳（app.js mergeReviewDiff → POST /api/novel/adopt，operation_key 幂等）
  → 版本历史（服务端采纳事务写 chapter 历史版本 + adopted 记账）
```

单列路径（本轮均有复核）：

- **长文分片**：`app.js longTextRunTask('revision_patch')` → `ai/... long-text.js runSegmentedTask`；分片提示词与校验使用**同一份** `plan/authorization`（本轮改动，见 implementation-report）。
- **取消**：`runHarnessJob` 内部 `cancelled` 标志（"即使任务刚巧完成也不再采纳结果"，`public/app.js` 第 7903–7976 行）+ `longTextCancelRun` 置位。
- **任务恢复**：`longTextLoadRun` / `longTextSaveRun`（localStorage）+ `state.pendingReview` 固化闭包。
- **无选中项**：`refineByChecklist` 在**付费之前**判空并 toast（本轮未改这条）。
- **旧存量报告**：`parseRevisionPatchesDetailed(raw)` 默认仍可读 legacy；`allowLegacy` 是独立通道。
- **手工覆盖**：`mergeReviewDiff` 按作者既有裁决**不做拦阻**，只观测并写历史版本（本轮未改）。

## 3. 数据库与插件字段（真实存在）

- 表 `chapter_reviews`：`work_id / chapter_id / report_json / checklist_json / status / dismissed`。
- 表 `revision_selections`：`work_id / chapter_id / review_id / snapshot_id / base_hash / selection_hash / plan_hash / selected_issue_ids_json / source`（`server.js saveRevisionSelection`；每章保留最近 20 条）。
- 表 `adoption_operations`：`idempotency_key / payload_hash / work_id / chapter_id / result_json`。
- 端点：`PUT /api/novel/review`、`PUT /api/novel/revision/selection`（`server.js` 第 9043–9062 行附近写入）、`GET /api/novel/revision/selection`、`GET /api/novel/revision/comparison`、`POST /api/novel/adopt`。
- 插件工具：`novel_review`、`novel_chapter_save`、`novel_scan`、`novel_write_pipeline` 等共 26 个（`plugin.json` 与实现一致，`.p1-baseline/verify-plugin-tools.mjs` 断言）。

## 4. E00.2 搜索指令的真实结果（摘要）

```
rg -n "refineByChecklist|tryApplyRevisionOutput|revisionPlanFor|revisionSpanCatalogue|applyRevisionPatches|runRevisionPipeline|planPatchApplication|locateFragment|showReviewDiff"
  → 全部命中，位置见上表（函数名与任务书 §2 一致；路径一致）
rg -n "ReviewV2|structureReviewReport|selected_issue_ids|review_id|selection_hash|plan_hash|revision/selection|novel_review"
  → 命中：app.js（选择记录/审稿保存）、server.js（两个端点与 saveRevisionSelection）、db.js（两张表）
rg -n "fallback|full.rewrite|legacy|allow_legacy|format.retry|createRetryBudget|staleCheck|idempotencyKey"
  → fallback/full rewrite：refineByChecklist 的显式选择界面（不再自动整章重写）
  → legacy：app.js parseRevisionPatchesDetailed / salvageLegacyRevisionPatches
  → format retry：app.js 有界格式重试 + revision-patch.js createRetryBudget
  → staleCheck / idempotencyKey：revision-patch.js 导出，mergeReviewDiff 走 operation_key
```

工具缺失说明：本机无 `rg` 时改用仓库内 Node 只读扫描（grep 工具），结论同上。

## 5. 本地 1.1.4 → 1.1.6 的差异要点（只列影响本轮结论的）

- 本地已有目录 `docs/narrative-repair/`（上一轮 SE6 的 E00—E07 证据）与 `tests/narrative-repair/`（7 个套件 / 159 条断言）。本轮**不覆盖**它，另建 `docs/narrative-repair-116/` 与新增 3 个套件。
- 本地 `revision-plan.js` 的 `locateFragment` 对 exact 句用 `spans.find(...)`：**K3 在本地同样存在**（已复现）。
- 本地 `runRevisionPipeline` 的可见形参中**没有** issue→span 授权白名单：**K2 在本地同样存在**（已复现）。
- 本地 `decodePatchOutput` 无 `expected_schema_version` 约束、`tryApplyRevisionOutput` 会把 legacy 交给旧路径：**K4 在本地部分存在**（新任务的 prompt 已是 v2，但没有强制；已修复）。
- 本地 `refineByChecklist` 在 `state.pendingReview = null` 之后读 `state.pendingReview.review_id`：**K5 在本地存在，且该字段读法本身也是错的**（`review_id` 挂在 `review` 上）；已修复并端到端断言。
- 本地 K1：计划为 null / 无热点时 `revisionSpanCatalogue` 回退整章目录；已删除该退位分支（新修稿路径）。
- 本地 K6 残项复核：①"审稿专属阶段装配"已有 `stage_rules`（`03-stage-rules` 覆盖）→ already_satisfied；②"采纳 stale/幂等原语未接线"→ `operation_key` 已接线，且作者既有裁决明确**不拦阻合并**（见 implementation-report 的 not_changed 段）；③"重试预算未跨刷新持久化"→ **本轮修复**；④`must_keep/do_not_add` 来源已在计划不变量中接通（`05-revision-plan` 覆盖）。
