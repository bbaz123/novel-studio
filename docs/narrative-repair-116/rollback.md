# rollback.md｜怎么撤销本轮代码修改，且不破坏用户作品 / 旧报告 / 版本历史

> 本轮**没有**任何 git 写操作（未 commit / push / reset / clean / stash）。所有改动都在工作树里，
> 文件清单可由 `git status --porcelain` 与下表逐条核对。

## 1. 隔离边界（先说不会伤到什么）

| 资产 | 本轮是否触碰 | 回滚方式 |
|---|---|---|
| `data/`（真实作品库、章节正文、API Key） | **完全没有**（未打开、未读写） | 不需要回滚 |
| 章节历史版本 `chapter_reviews` / `adoption_operations` / `revision_selections` 中的既有行 | **完全没有**（只读代码，未执行迁移，未连生产库） | 不需要回滚 |
| 作者手工编辑、普通保存、版本恢复、明确覆盖（合并到正文） | 行为**未改变**（见 implementation-report `not_changed`） | 不需要回滚 |
| 旧专项证据 `docs/narrative-repair/`、旧冻结样本 `tests/narrative-repair/fixtures/before.txt|after.txt|manifest.json` | **未覆盖**（新样本另建 `fixtures/new-3751-spring/`，并有断言钉住旧哈希） | 不需要回滚 |
| 旧格式（legacy）存量报告的可读性 | **保留**：`parseRevisionPatchesDetailed(raw)` 默认仍读 legacy，`salvageLegacyRevisionPatches` 仍在 | 不需要回滚 |
| Harness 内核、DSH 全局配置、`harness-plugins/` | **未修改** | 不需要回滚 |

## 2. 按"责任单元"回滚（推荐，粒度最小）

本轮的改动都是**加机制 + 收紧授权**，每一块都可以单独撤回：

### 2.1 只回滚"授权表强制"（K2 / E01-B）

1. `public/revision-patch.js`：删除 `planPatchApplication` 里 `if (opts.authorization) { ... }` 这一段，并删除 `authorizationEntryMatches` / `authorizationRangeHit` / `resolveAuthorizedRange` 三个函数；
2. `public/app.js`：把 `tryApplyRevisionOutput` 调用点的 `authorization,` 与 `revision_patch` 分片 `parse` 里的 `authorization: authFor(),` 去掉；
3. 效果：修稿回到"只校验 issue 属于已选"，**越权面重新打开**（本轮的 E01-1 / E01-1c / 116E-a 会立刻变红）。

### 2.2 只回滚"定位歧义拒绝"（K3 / E01-C）

`public/revision-plan.js` 的 `locateFragment` 去掉出现次数核验那几行（保留 `opts.span_id` 分支）；`buildRevisionPlan` 里 `ambiguous` 分支随之失效（会回到"取第一处"）。

### 2.3 只回滚"新任务不吃 legacy"（K4 / E01-D）

`public/revision-patch.js` 的 `decodePatchOutput` 去掉 `INCOMPATIBLE_LEGACY` 返回块；`public/app.js` 的 `parseRevisionPatchesDetailed` 把 `legacyAllowed` 恒为 true、`tryApplyRevisionOutput` 去掉 `expectedSchemaVersion` 判断。

### 2.4 只回滚"review_id / 稳定编号"（K5 / E02）

`public/app.js` 的 `refineByChecklist` 恢复 `state.pendingReview = null` 之后读 `state.pendingReview.review_id`、并恢复 `selectedIssueIds = confirmed.map((_, i) => String(i + 1))`。

### 2.5 只回滚"information_truncation"（E03）

`public/patch-safety.js` 删除 `informationTruncationRisks` 与 `deletionRisks` 末条 `risks.push(...)`，并从导出表去掉它；`public/app.js` 的 `patchSafetyNotesHtml` 可保留新标题（纯文案），也可一并回退。

### 2.6 只回滚"重试预算持久化"（E05-B）

`public/app.js` 删除 `REVISION_RETRY_MAX/REVISION_RETRY_KEY/revisionRetryBudgetKey/revisionRetryBudgetFor`，并把调用点改回 `revisionPatchEngine().createRetryBudget({ max: 1 })`；顺手清掉 localStorage 键 `ns_revision_retry_budget`。

## 3. 整体回滚（一次性）

```powershell
# 1) 先看清改了什么（不要在没看清之前动手）
git status --porcelain
git diff --stat
git diff -- public/revision-patch.js public/revision-plan.js public/app.js public/patch-safety.js frontend-test.mjs scripts/test-narrative-repair.mjs .p1-baseline/verify-phase-map.mjs

# 2) 撤回**文件级**改动（只撤本轮列出的文件，不要用 git checkout . ）
git checkout -- public/revision-patch.js public/revision-plan.js public/app.js public/patch-safety.js frontend-test.mjs scripts/test-narrative-repair.mjs .p1-baseline/verify-phase-map.mjs docs/narrative-repair/e07-run-manifest.json

# 3) 删除本轮新增（全部是新增文件/目录，删掉不影响运行）
Remove-Item -Recurse -Force docs/narrative-repair-116, .narrative-repair-116, tests/narrative-repair/fixtures/new-3751-spring
Remove-Item -Force scripts/run-narrative-repair-116.mjs, tests/narrative-repair/08-authorization.test.mjs, tests/narrative-repair/09-information-truncation.test.mjs, tests/narrative-repair/10-new-sample.test.mjs

# 4) 清掉本机状态键（可选）
#    浏览器控制台：localStorage.removeItem('ns_revision_retry_budget')
```

> ⚠️ 注意：`docs/narrative-repair/e07-run-manifest.json` 被 E00.3 要求的验收运行器**按设计覆写**过。
> 它的 HEAD 版本是上一轮一次全项 `exit -1` 的失败运行记录（见 `baseline.json` 的 `pre_existing_red`）。
> 若要恢复 HEAD 版本，用上面的 `git checkout --` 那一行即可；`git show HEAD:docs/narrative-repair/e07-run-manifest.json` 可随时查阅原内容。

## 4. 回滚后应当看到什么（自检）

```powershell
node scripts/test-narrative-repair.mjs   # 期望：7 个套件全绿（新套件已随文件删除）
node frontend-test.mjs                  # 期望：=== ALL PASS ===（116E-* 断言随文件回退消失）
git status --porcelain                  # 期望：只剩 ?? 修复.md
```

## 5. 不可回滚 / 需要注意的点

- `.narrative-repair-116/` 里保留了**基线**与**修后**两套日志（`baseline-*.log` / `after-*`）。删掉它们不影响功能，但会丢掉"改动前后真实退出码"的原始证据。
- 本轮没有数据库迁移，因此不存在"回滚代码但库结构已变"的问题。
- 若已经用新版修稿写过正文：那部分正文是**作者点「合并到正文」**的自愿操作（旧稿已进本章历史版本），回滚代码**不会**回退正文 —— 需要时用界面上的「历史版本」恢复。
