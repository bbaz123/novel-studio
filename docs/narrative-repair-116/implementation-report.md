# implementation-report.md｜问题（K1–K6 / A01–A08）→ 改动文件 → 回归 ID

> 每一行都对应**真实改过的代码**；没改的写 `already_satisfied` 或 `not_changed`，并给出证据位置。
> 证据总表见 `test-report.md`；风险编号沿用《修复.md》§2.1 与 §1.1。

## 一、K1–K6（工程风险）

| 编号 | 本地 1.1.6 复现结论 | 实际修改 | 回归 ID |
|---|---|---|---|
| **K1** 计划缺失扩大编辑目录 | **存在**。`revisionPlanFor` 捕获异常返回 `null`，`buildAIRevisionPatchPrompt` 在计划为 null / 无热点时下发**整章跨度目录**（并附一句"引用仍必须逐字相等"），等于把整章交给模型自由修改。 | `public/revision-plan.js`：新增 `scope_incomplete`；`planAuthorization()`（无热点 → 空授权 + `scope_complete:false`）。`public/app.js`：`revisionPlanFor` 编译失败不再"退回整章"而是如实返回 null；`buildAIRevisionPatchPrompt` 在调用方**给了计划**（含 null）时不再下发整章目录，改为显式声明"本次没有任何被授权的可编辑跨度"；`refineByChecklist` 在**付费调用之前**判 `authorization.authorized_span_count === 0` → 拒绝并发起显式选择界面（含作者出口"整章重写"）。 | E01-3 / E01-3b / E01-3d / E01-3e / 116E-a / 116E-b / 94L3 |
| **K2** "问题被选中" ≠ "这个跨度被选中" | **存在**。`planPatchApplication` 只校验 `issue_ids ⊆ 已选`；模型填一个已选 issue 即可改**这一章的另一段**（测试 E01-1 复现：原文被改成"乙走了。"）。 | `public/revision-patch.js`：`planPatchApplication(opts.authorization)` 增加 Host 授权表强制（span_id / 精确 start-end / 逐字 text 三选一，`ops` 限定操作类型），未授权跨度一律 `out_of_scope`；`protected` 条目按区间相交拒绝；`span_id` 与显式 `span:{start,end}` 互相矛盾时拒绝。`public/revision-plan.js`：`planAuthorization()` 把计划编译成"issue → 允许改的跨度"。`public/app.js`：`tryApplyRevisionOutput` / `revision_patch` 分片路径都传入授权表。 | E01-0 / E01-1 / E01-1b / E01-1c / E01-1d / 116E-f |
| **K2′**（本轮新发现，同类缺口） | **存在**。计划把授权跨度收紧到"那一刻文字"时，`span_id` 是 `${包含跨度}~${偏移}`（例如 `p1s1~11`），执行器 `spans.get(...)` 必然找不到 → **最窄、最该被允许的那类补丁一条也执行不了**（整段跨度反而能用）。 | `public/revision-patch.js`：新增 `resolveAuthorizedRange()` —— 只有 **Host 授权表登记过** 的同名条目才算数，并要求 `text.slice(start,end) === entry.text === patch.original` 三者逐字相等。 | E03-1 / E03-1d / E03-1e / E03-2 |
| **K3** 重复原文取首处 | **存在**。`locateFragment` 对 exact 句用 `spans.find(...)`（首处），子串候选排序取第一个。 | `public/revision-plan.js`：`locateFragment` 先做**全文出现次数**核验，>1 直接返回 `{ambiguous:true,count,starts}`；只有 Host 显式给出唯一 `span_id` 才允许改那一处；`buildRevisionPlan` 对歧义引用落 `ambiguous_anchor`（换更短/更长的引文仍唯一时不放弃）。 | E01-2 / E01-2b / E01-2c |
| **K4** 新请求仍走 legacy 应用 | **部分存在**。新提示词已只索取 v2，但 `decodePatchOutput` 无版本约束、`tryApplyRevisionOutput` 会把 legacy 交给"anchor 唯一包含 → 替换整段"的旧路径，且 `parseRevisionPatchesDetailed` 还会用 `salvageLegacyRevisionPatches` 兜底。 | `public/revision-patch.js`：`decodePatchOutput(raw, {expectedSchemaVersion, allowLegacy})` —— 新任务收到 legacy 返回 `incompatible_legacy_format`；`runRevisionPipeline` 透传并在 `allowLegacy:false` 时双保险拒绝。`public/app.js`：`parseRevisionPatchesDetailed(raw, opts)` 透传并**只在允许兼容时**才走抢救层；`tryApplyRevisionOutput` 在新作业（`expectedSchemaVersion:2`）下遇到非 v2 返回 `null` → 走"一次仅格式重试 → 显式选择"。 | E01-4 / E01-4b / E01-4c / E01-4d / 58ad / 58ad2 |
| **K5** review_id / 选择 ID 关联 | **存在，且比任务书描述的更严重**。`refineByChecklist` 先 `state.pendingReview = null`，之后读 `state.pendingReview.review_id` —— 该字段既已被清空、又挂错了对象（`review_id` 在 `review` 上），因此**恒为 undefined**；且 `selectedIssueIds = confirmed.map((_, i) => String(i + 1))` 会把"只勾第 3/7 项"重编成 1/2。 | `public/app.js`：函数开头（清空之前）取 `reviewId = review.review_id || info.review_id`；勾选时用 `el.dataset.reviewIssue`（报告原始序号）经 `issueStableId()` 得**稳定编号**；`revisionPlanFor`/`buildAIRevisionPatchPrompt` 新增 `issueIds` 走稳定编号；`showRevisionUnresolved` 增加 `confirmedIds` 让重试路径不重编编号。 | 116E-c / 116E-d / 116E-e / 94K4 / 94K5 |
| **K6** 旧报告承认的残项 | 逐项复核见 `source-map.md` §5：①阶段装配 `already_satisfied`（`03-stage-rules` 17 条断言）；②采纳 stale/幂等 → `operation_key` 已接线（见下方 `not_changed`）；③**重试预算未跨刷新持久化 → 本轮修复**；④`must_keep/do_not_add` 已接通（`05-revision-plan`）。 | `public/app.js`：新增 `REVISION_RETRY_MAX/REVISION_RETRY_KEY`、`revisionRetryBudgetKey`、`revisionRetryBudgetFor`（键 = `章号｜快照｜勾选集合`，落 localStorage，刷新共用同一份额度）。 | 116E-i / 116E-j / 116E-k / P11 |

### not_changed（有意不改，附理由）

- **`mergeReviewDiff` 不在"预览后正文变过"时拦阻合并**：这是作者 2026-10-06 的**明确裁决**（"无论什么时候，只要是用户执行，就直接强制合并到正文"），代码里保留了观测 + 写历史版本。任务书 E02-B 要求"按 stale 或显式冲突流程处理"，与作者的既有裁决冲突；按"不修改作者现有明确采纳行为"的上位约束，本轮**不改**，只保留既有观测日志 `review_merge_overwrite`。→ `already_satisfied_with_author_policy`。
- **`mergeReviewDiff` 的 `operation_key` 幂等**：预览打开时生成一次并随 `state.pendingReviewDiff` 保存，重复点击/超时重发落到同一个键，服务端 `adoption_operations.idempotency_key` 原样重放返回原结果（同键不同内容 409）。→ `already_satisfied`（证据：`server.js` 第 7388–7391 行 + P11c）。
- **取消后晚到响应**：`runHarnessJob` 已有"用户已点停止：即使任务刚巧完成也不再采纳结果"（`public/app.js` 第 7903–7976 行，`cancelled` 标志 + `cancelledErr()`）。→ `already_satisfied`（本次未新增，仅记录证据）。
- **`_p1-baseline/verify-phase-map.mjs` 的 97 个未归属改动**：全部是本轮改动之前就存在的旧探针/基线数据，与本次责任无关，未清理（清理属"无关大范围改动"）。

## 二、A01–A08（文本问题 → 处理方式）

| ID | 处理 | 落点 | 回归 ID |
|---|---|---|---|
| **A01** `职业方向——…` 被削成 `职业方向。` | 新增**修后核验候选** `information_truncation`（`subtype: orphaned_label`）：原稿存在「引导语 + 分隔符 + 具体内容」、改后内容消失、引导语仍在且自成一句 → 报出**具体丢了什么**。刻意是 **soft 码**（不进 `HARD_CODES`）：改动仍进候选，作者裁决，不强制回滚正式稿。同时修正差异预览的分区标题（旧标题把"已生效的提醒"写成"没有进这一版正文"）。 | `public/patch-safety.js` `informationTruncationRisks` + `deletionRisks` 第 ⑤ 条信号；`public/app.js` `patchSafetyNotesHtml` | E03-1 / E03-1b / E03-1c / E03-1d / E03-3 / E03-3b / T16 |
| **A02** 删"耳机挂在脖子上晃" | 阴性对照：不报 `information_truncation`，不被硬拦；等待时长/出场/登记表逐字保留。 | 同上（判据覆盖） | E03-2 / E03-2b / T17 |
| **A03** `今天这条街两个A级，一个S级` | `hypothesis`：本轮**不改正文**；测试断言不得自动发明"江陵的 S 级"（扫描候选里不出现该地名引用）。 | `ai/editing/narrative-scan.mjs`（未改；用测试固化为阴性对照） | E04-d |
| **A04** `球板` / **A05** `也不动人` | 用词候选，**不作为词表规则**；本轮不新增任何强制替换。 | 无代码改动 | （见 E03-3 的阴性对照纪律） |
| **A06** 重复解释（女生看手后又复述） | 确定性层产出 `redundant_explanation` 候选（只给 condense/check、`requires_semantic_check: true`），并保护"主角注意到掌心异常"的悬念。 | `ai/editing/narrative-scan.mjs`（复用；测试固化） | E04-b / E04-b2 / E04-b3 |
| **A07** S→SS→中断 | 阴性对照：不产生 `spectacle_redundancy` 候选，不为"减 AI 味"硬删。 | 同上 | E04-c / T18 |
| **A08** 王磊/岳宸炎的辨识度 | 保护候选：本轮不新增任何"改平人物"的判据；`buildAIRevisionPatchPrompt` 既有第 7 条纪律（对白不适用"重复即删"）保持不变。 | 无代码改动 | 116E-h（提示词不含诊断阈值） |

## 三、E01-D / E05 相关的"顺手收紧"（同一责任域，最小必要）

- `spanObj.chapter_id` 由调用方传入的 `chapterId` 改为**快照所属章** `spanChapter`：旧写法让"别章跨度"判据恒不触发（跨度章 == 调用章）。
- `planPatchApplication` 中 `span_id` 与显式 `span:{start,end}` 同时出现且不一致 → `out_of_scope`（旧写法取 span 的偏移、却保留 span_id 的身份，身份与位置可以各说各话）。

## 四、改动文件清单

| 文件 | 类型 | 行数变化（`git diff --stat`） |
|---|---|---|
| `public/revision-patch.js` | 改 | +155 / −7 |
| `public/revision-plan.js` | 改 | +125 / −16 |
| `public/app.js` | 改 | +302 / −118 |
| `public/patch-safety.js` | 改 | +68 |
| `frontend-test.mjs` | 改（测试） | +158 / −4 |
| `scripts/test-narrative-repair.mjs` | 改（测试入口） | +6 |
| `.p1-baseline/verify-phase-map.mjs` | 改（新增 SE7 阶段） | +33 |
| `docs/narrative-repair/e07-run-manifest.json` | 改（由 E00.3 要求的验收运行器自动重写） | +67 / −67 |
| `scripts/run-narrative-repair-116.mjs` | 新增 | 156 行 |
| `tests/narrative-repair/08-authorization.test.mjs` | 新增 | 218 行 |
| `tests/narrative-repair/09-information-truncation.test.mjs` | 新增 | 112 行 |
| `tests/narrative-repair/10-new-sample.test.mjs` | 新增 | 76 行 |
| `tests/narrative-repair/fixtures/new-3751-spring/*` | 新增 | 9 个文件（8 夹具 + manifest） |
| `docs/narrative-repair-116/*` | 新增 | 本交付目录 |

**不碰作者数据的证明**：本轮全部修改落在 `public/`（前端纯函数与接线）、`tests/`、`scripts/`、`.p1-baseline/`、`docs/`；未打开 `data/`（真实作品库与密钥），未读写任何章节正文，未改 `harness-plugins/`、未改 DSH 安装目录，未执行任何 git 写操作。
