# implementation-report —— 问题 → 代码变化 → 测试用例 → 结果

> 《叙事性专项修复》§10.1 要求的逐条映射。**工程通过**与**文学效果确认**是两个状态；
> 本文只声明前者，并且只声明**本机跑出来的**结果。真实模型评测未运行（见 test-report）。

## 0. 本轮实际做了什么（一句话）

把"按确认清单局部改稿"这条路的**执行正确性**做对：补丁协议 v2（显式删除、精确跨度、严格 schema）、
组合门禁（单条安全 ≠ 整组合起来安全）、以及**去掉"失败就自动整章重写"**这条会付费且没有补丁级门禁的逃逸路径，
并给失败一个**作者显式选择**的出口。其余 E02—E06 的剩余项按实际状态登记为待办（不假装已完成）。

## 1. 覆盖表（Cxx / Nxx / Lxx / Pxx → 代码变化 → 测试 → 结果）

| 条目 | 代码变化（真实文件与函数） | 测试用例 | 结果 |
|---|---|---|---|
| C04 补丁失败不扩大为整章重写 | `public/app.js`：`refineByChecklist` 删除"回退整章重写"分支；新增 `showRevisionUnresolved`（显式二选一）与 `refineByFullRewrite`（只由作者动作触发） | `frontend-test.mjs` 94x / 94y / 94z；`tests/narrative-repair/01` P13d | passed（工程） |
| C05 显式删除 + 精确 span（不再"少许定位授权整段"） | 新增 `public/revision-patch.js`（`decodePatchOutput` 的 `op:'delete'`、`planPatchApplication` 的逐字跨度校验、`applyPlan` 的后向切片重建）；`buildAIRevisionPatchPrompt` 改为下发授权跨度目录 + 协议 v2 | `tests/narrative-repair/01` P01 / P01b / P01c / P06 / P06b / P06c；`frontend-test.mjs` 94t | passed（工程） |
| P02 缺字段/类型错误 ≠ 删除 | `revision-patch.js` `decodePatchOutput`：`replace` 要求非空、`delete` 要求显式 `""`、缺 `replacement` 一律 `schema_error`；数值/null 一律类型错误 | 01 P02 / P02b / P02c | passed（工程）——⚠️ **适用范围限定为协议 v2 载荷**：旧格式（含 `"anchor"`）会先被 `salvageLegacyRevisionPatches` 抢救，仍按旧宽松语义走（`frontend-test 94d/94e` 依赖这一行为） |
| P04 坏元素不得折叠成"合法空补丁" | `decodePatchOutput` 的 `dropped` 计数 → `schema_error`；严格 JSON（拒绝重复 key）；多份冲突 JSON 拒绝；`parseRevisionPatchesDetailed` 把它交给调用方如实展示 | 01 P04 / P04b / P04c；`frontend-test.mjs` 94v | passed（工程）——这是本次修掉的最危险的一条：旧实现会把一次解析事故显示成"模型判断无需修改" |
| P05 重复原句不猜第一处 | `planPatchApplication`：`span_id` + `original` 逐字相等是唯一定位依据；不匹配即 `anchor_mismatch` | 01 P05 / P05b | passed（工程） |
| P07 重叠 / 同跨度不一致 | `planPatchApplication`：同跨度不同内容 → 整批拒绝并报冲突；跨跨度重叠 → 整批拒绝 | 01 P07 / P07b / P07c | passed（工程） |
| P08 组合门禁 | `revision-patch.js` `verifyCombinedCandidate` + `combinedDeletionFindings`：把**组合后**的全文当作 `deletionRisks` 的证据面 | 01 P08-PRE / P08 / P08b / P08c / P08d | passed（工程）——前提断言证明这两条删除**单独**都安全，组合后被门禁抓到 |
| P09 越权引用 | `planPatchApplication`：`issue_ids ⊆ 已选`、context-only 跨度、别章跨度一律拒绝；协议里**没有**"批准"这个输入 | 01 P09 / P09b / P09c / P09d / **P18 / P18b** | passed（工程）——2026-10-09 修复：跨度改按**快照章**打标，"别章"判据才真的可判；`app.js` 的接回进度调用点补传 ctx（此前该路径跳过未选问题校验） |
| P10 源稿过期 | `revision-patch.js` `staleCheck` + 快照 `snapshot_id`/`base_hash` 校验；不匹配即 `stale`，不猜位置 | 01 P10 / P10b；`frontend-test.mjs` 94w | passed（工程） |
| P11 取消/恢复/重复采纳 | `createRetryBudget`（共享有界预算）、`idempotencyKey`（含快照+选择集） | 01 P11 / P11b / P11c | **部分**：`createRetryBudget` 已于 2026-10-09 接进 `refineByChecklist`（一次仅格式重试，`94K2` 实测）；`idempotencyKey` / `staleCheck` / `selectionHash` **仍是未接线的模块原语**（采纳幂等属 E03/E05 范围） |
| P12 门禁不可用/抛错/畸形 | `verifyCombinedCandidate` 的三种姿态都标"未核验"，绝不写"已验证"；逐条门禁沿用既有"放行但明示" | 01 P12 / P12b / P12c / P12d | passed（工程） |
| P13 三种"没改成"可区分，都不扩大 | `runRevisionPipeline` 返回 `blocked` / `unresolved`（`anchor_mismatch`）/ 依赖组原子失败（同组整组不进候选且未完成项可见） | 01 P13 / P13b / P13c / P13d | passed（工程） |
| P14 快照口径（Unicode/CRLF/空行/段合并） | `buildSpans` 的 UTF-16 `[start,end)` 偏移、段尾分隔符并进段跨度、`mergeAdjacentSpans` 显式授权连续跨度 | 01 P14 / P14b / P14c / P14d | passed（工程） |
| N05（"然后她不一样了。"）可真正删除 | 同上（`op:'delete'`），无需为满足非空值编造替代句 | 01 P01 / P01b | passed（工程，样本来自冻结 fixture 的同型句子） |
| L01/L03 类局部用词修正 | 精确句跨度替换只改该句 | 01 P06 / P06b | passed（工程） |
| R01 冻结两版样本 | `scripts/materialize-narrative-fixtures.mjs`（按任务书 C.2 逐字实现，不覆盖已有基线） | 02 R01-a…f | passed（hash / 字符数 / 六组重建全部一致） |
| R12 样本来源标签 | 只读 fixtures，不做任何"登记成作者基线"的动作 | 02 R12 / R12-b | passed（工程；E03/E04 里的风格来源字段仍未实现） |

| E02 阶段化编译（P0） | **已实现**（headline 冲突另计） | `ai/editing/rules.mjs` 升 **v1.5.0**：`fiction-humanizer` / `dialogue-editor` 增加 `stage_rules`（draft / verify_style / rewrite），`buildEditingRuleBlock(selection, {task, stage})` 选阶段变体并返回 `audit`；不传 stage 时逐字用基础 `rule`（03 E02-a）。`server.js`：装配器按 `contextOpts.task/stage` 编译，两个 HTTP 端点的 `stage` 参数进**缓存键**，`/api/novel/editing/rules` + PUT 也接受 stage。`public/app.js`：`loadAIContext({stage})`（白名单 + 客户端 key + URL），蓝图/成文/扩写/人设/细纲/批量成文 → draft、润色 → rewrite；新增 `WRITING_DISCIPLINE_REVIEW`（同一纪律 + 诊断/反证口径）与 `writingStageAudit()`。 | 03 E02-a…q（17/17）；frontend-test 94B—94G（含**真实请求 URL** 带 `stage=verify_style`、白名单外不加）；`.p1-baseline/test-editing-rules.mjs` 62/0 | passed（工程） |
| E02 headline 冲突（"每个场面必须补齐构件"） | **already_satisfied** | 该段是 2026-10-08 第五批改的（"场面写法：功能驱动"），本轮复跑未改；蓝图情节点本轮改成"身体动作只在确实发生或构成关键因果时写" | frontend-test 94F；119b 既有断言 | passed（工程） |

| E04 面向功能的叙事诊断（P1） | **确定性层 + 协议层已实现并接线到扫描端点**；语义层未运行 | 新增 `ai/editing/narrative-scan.mjs`（四类诊断的候选信号：**消费** `scan.mjs` 的 `process-shape-repeat` / `crowd-function-repeat` / `camera-outside-media` / `duplicate-*`，只自建三类**结构**测量——段内 3-gram 重复、相邻段 bigram 包含度、相邻句骨架重复，全部用**文档频率**判通用、不维护词表）与 `ai/editing/narrative-review.mjs`（ReviewV2 finding 的引用核验 / 反证降级 / `auto_eligible` / 三类保护分区 / §9.2 提示词）；`POST /api/novel/editing/scan` 在启用 `story-shape` 时返回 `narrative`（`semantic_status:'not_run'`）。**未做**：前端开关与报告渲染（E06）、真实模型语义审稿（付费未授权） | 04 E04-a…r（24/24，含阴性对照与引用核验）；`.p1-baseline/test-editing-rules.mjs` E12—E14（**路由级**：候选随扫描返回 / 只给 condense+check / 未启用不返回） | passed（确定性层）；语义层未运行 |

| E05 受约束的局部编辑计划（P1） | **已实现并接进修稿提示词** | 新增 `public/revision-plan.js`（UMD v1.0.0）：`buildRevisionPlan` 把已选问题编译成 **hotspots（片段级授权跨度 + 只读上下文 + must_keep/do_not_add + 依赖组）**、`groups`（同段或上下文重叠者合并，原子应用，**跨度不变**）、`coverage`（planned/needs_scope/refused）、`needs_explicit_widening`（预算不够**举手**，含候选范围，绝不自动放宽）、`selection_hash`/`plan_hash`/`isPlanStale`（勾选变更即作废）、`dry_run:true`；`buildRevisionPatchPromptFromPlan` 只列授权跨度与不变量（无"通读全部"暗示）。`app.js`：`revisionPlanFor` 从问题描述里的引号片段定位片段级跨度，**有计划时把整章跨度目录收窄到热点段落**，定位不到则如实退回整章并写明原因 | 05 E05-0…n（18/18）；frontend-test `94L/94L2/94L3/94L4` | passed（工程）——边界：`condense` 需要 Host 显式批准连续跨度（`merged_span_approved`），当前应用层尚未传它，因此 condense 会被 refused（如实拒绝，不静默降级） |

| E06 设置与可解释报告（P1） | **主要部分已实现** | ①**两个可选授权开关**加在审稿报告弹窗（作者做决定的那一步）：`允许对已选问题局部压缩`、`把编辑器里选中的文字列为保护`；默认关闭、存本机 localStorage（与 `ns_protected_content` 同约定）、只在点「按确认清单修稿」时落盘，**不改变生成行为**；②**可解释报告**：差异预览新增「本次改动（每条带问题 ID / 改动前 / 改动后 / 理由 / 撤销这一处）」「校验状态（已验证 / 未核验 / 被拦下 + 未完成项 + 核验发现）」「相对结论」；③**单处撤销**：`revision-plan.js` 的 `candidateWithoutIssue` 按原稿位置从后往前重建候选（缺位置/源稿变了就拒绝，不部分应用），预览里的按钮重建并刷新；④**相对改善必须先读 diff**：`comparisonVerdict` 在未读 diff 时只返回 `needs_diff_review`（未读 diff 不得写"改善"）。修掉两个实现缺陷：`tryApplyRevisionOutput` 没带 `start/end`（导致撤销必然"缺少位置信息"）、撤销分支误用不存在的变量 `target`（撤销静默失效） | 06 E06-a…e（13/13）；frontend-test `94M/94N/94O/94P/94P2/94Q/94Q2` | passed（本轮范围）；未做：**对比视图**（模型诊断 vs 人工复判 vs 结构指标，需先有 E03 的人工复判落库） |

| E03 审稿结果与作者选择的端到端保真（P0） | **已实现** | ①**审稿结构化 + 引用核验**：`narrative-review.mjs` 新增 `structureReviewReport`（复用 E04 的 `normalizeNarrativeFindings`）——结构化 findings 的引用必须能**逐字定位**（定位不到/出现多次则拒收并给出理由）、反证缺失降级 hypothesis；`issues` 兼容清单**由结构化结论派生**（带 id、理由、逐字引用），旧的"每行一条"口径逐字不变；②`novel_review` 增加 `findings` 参数（JSON 字符串），提示词写明引用与反证要求；③`PUT /api/novel/review` 走结构化并返回 `structure/findings_accepted/findings_rejected/rejected`；④**独立选择记录**：新表 `revision_selections`（work_id/chapter_id/review_id/snapshot_id/base_hash/selection_hash/plan_hash/selected_issue_ids/source）+ `PUT/GET /api/novel/revision/selection`（空勾选拒绝；每章留最近 20 次）；⑤修稿前必写选择记录（失败会明确告知"本次勾选无法事后复核"）；⑥**取回路径**读选择记录并用它收窄 `selectedIssueIds`，读不到时如实显示"只按快照与章号校验" | 07 E03-a…f（10/10）；`.p1-baseline/test-editing-rules.mjs` E15—E17b（**路由级**：结构化落库 / 记录往返 / 最新选择生效 / 空勾选拒绝）；frontend-test `94K4/94K5`（修稿前真的写了记录） | passed（工程）——边界：模型侧是否真的产出合规 findings 需要真实审稿（未授权付费），离线只验"给了就核验" |

| E06 剩余（对比视图） | **已实现** | `GET /api/novel/revision/comparison?chapter_id=` 返回三类证据的**原始计数**（模型诊断：审稿份数 + 最近一份的结构化通过与拒收条数；人工复判：确认/忽略/选择记录份数与最近一次；结构指标：段落/字数/对白占比/叙事候选数）；比例是否可看由界面按 `revisionSampleGuard`（`public/revision-plan.js`）决定——**样本不足时只允许看单次明细，不得据此判断趋势**；入口在审稿报告弹窗（「📊 模型/人工/结构对照」） | 06 E06-f…f3（16/16）；`.p1-baseline/test-editing-rules.mjs` E18—E18c（**路由级**）；frontend-test `94R—94R6` | passed（本轮范围） |

| E02 剩余（通道等价 + 部署拷贝） | **已实现** | ①**Harness 侧补阶段**：`novel_write_pipeline`（写作编排入口）的装配请求现在带 `stage=draft`——此前它不带阶段，于是**同样点一次成文，直连（前端成文轮传 `stage=draft`）与慢通道注入的规则集合不同**；`novel_context` 增加可选 `stage`（白名单同宿主口径：非法值不透传）。②**直连侧可自证**：`/api/ai_context` 追加 additive 字段 `edit_rules`（此前只有 `/api/novel/context` 有），两条通道因此都能回答"这一轮注入了哪一版规则"。③**证据**：同参数下两条端点给出**同一份 assembled 与同一 rule-block hash**（路由输入级，不是字符串搜索）；draft 无诊断判据/逐项评分；verify_style 有完整判据 + 反证要求且 hash 与 draft 不同；不传阶段 = 旧行为；三个阶段都仍带写作红线层；直连成文提示词仍写明"不要编造与既有设定冲突的内容"且不含诊断内容；Harness 预设同样仍写明事实限制与"允许略写"、不含诊断阈值。④**部署拷贝核对（只读）**：新增 `.p1-baseline/verify-preset-copy.mjs` —— 实测两个活跃 profile 都通过 junction 指向仓库（源文件即部署文件），遗留的 `~/.dsh/.agent-presets/novel-writing` 是 2026-09-18 的旧拷贝（2 个文件不同）、**无任何活跃通道加载**；工具只输出结论与命令，不写用户全局目录 | `.p1-baseline/test-editing-rules.mjs` E19—E19e（79/0）；`.p1-baseline/verify-plugin-tools.mjs` 7 项通道检查（含**变异测试**：拿掉 stage → 变红）；frontend-test 96c—96e；`.p1-baseline/verify-preset-copy.mjs`（结论 `junction_ok`） | passed |

## 1b. 问题 → 代码变化 → 测试用例 → 结果（任务书 §10.1 要求的逐条映射）

`Cxx` = 任务书 §3.2 的"已核到的实现"条目，`Nxx` = §4 的叙事编辑候选，`Lxx` = §4 的文字/感知逻辑疑点。
**"机制已实现"≠"文学效果已验证"**：后者需要真实模型评测（本轮 `SKIPPED: paid_evaluation_not_authorized`）。

| 编号 | 代码变化（真实路径） | 测试用例 | 结果 |
|---|---|---|---|
| C01 | `ai/writing/policy.mjs` 未改（复用其阶段作用域/允许略写/场面不设配额） | `test-editing-rules` E19 系列（装配实际文本）；`frontend-test` 96c—96e | already_satisfied（复用，未新建第二套） |
| C02 | `ai/editing/rules.mjs`（v1.5.0：`stage_rules` + `stageRuleFor` + `buildEditingRuleBlock(task,stage)`/audit）；`public/app.js` 成文提示词；`harness-plugins/.../novel-tools.mjs`（装配带 `stage=draft`） | `03-stage-rules`（17）；`test-editing-rules` E19—E19e；`frontend-test` 96c/96d；`verify-plugin-tools`（路由输入级） | passed（机制）；文学效果待评测 |
| C03 | `rules.mjs`：保留旧能力 ID，用阶段化编译区分生成/诊断；`STAGE_ALIASES`；非法阶段回落 `base` 并标 `base_fallback` | `03-stage-rules`；`test-editing-rules` E19b/E19c/E19d | passed |
| C04 | `public/app.js` `refineByChecklist`：失败/零命中不再自动整章重写（失败出口给作者显式选择；零勾选在付费前拦截） | `frontend-test` 94t/94K/94K2/94K3（运行时证据：POST 里不含"完整正文"） | passed |
| C05 | `public/revision-patch.js` v2.0.0（显式 `delete`、`span_id`+逐字 `original`、空 `revised` 拒绝、精确跨度替换） | `01-patch-protocol`（P01/P02/P05/P06 等，65 条） | passed |
| C06 | `public/revision-patch.js` `gatePlanPatches`（按**段落级真实 before/after** 重放）+ `verifyCombinedCandidate`（组合裂断）+ `patch-safety.js` 复用 | `01` P16—P21（含组合门禁 P08 形状）；`frontend-test` 94h—94l | passed |
| C07 | `ai/editing/narrative-scan.mjs`：消费 `scan.mjs` 的确定性统计当**候选线索**，只给 `condense/check`，从不定罪 | `04-narrative-scan`（24）；`07`/`06` 相关项 | passed（候选层）；语义层未运行 |
| C08 | 未新建分析器；本轮在 `narrative-scan` 侧给出 `semantic_status:'not_run'` 与 `measured` 原样透出 | `04` E04-a/j2 | **partial**：任务书 §3.2 C08 要求"增加样本来源与按阶段使用"，本轮未做样本来源标注（不属 P0/P1 闭环必需） |
| C09 | `harness-plugins/.../novel-tools.mjs` `novel_review` 新增 `findings`；`ai/editing/narrative-review.mjs` `structureReviewReport`（引用核验）；`server.js` PUT `/novel/review` 结构化落库 | `07-review-structure`（10）；`test-editing-rules` E15/E15b | passed |
| C10 | 未改：模型与强度继续走 `policyModel()`/`policyEffortForTier()` 单一来源 | `frontend-test`（模型字面量不散落，既有断言） | already_satisfied |
| L01 | 候选层只给"压缩/核对"建议；物件用词属语义判断 | `04` E04-b2/g（不定罪）；词表侧 `scan.mjs` 既有 | 机制已实现，**文学结论待评测** |
| L02—L05 | 待核对项走 `deferred`/`insufficient_data`，不硬判、不补设定 | `07` E03-a/c；`04` E04-h/i | 机制已实现，**待评测** |
| L06 | 事实增量由已批准设定/授权决定；`must_keep`/`do_not_add` 走计划不变量 | `05` E05-b（不变量进计划与提示词） | 机制已实现，**待评测** |
| N01 | 诊断候选 + 计划 + 报告链路（观察者/机制复现类走 `repeated_mechanism`） | `04` E04-d（消费 `process-shape-repeat`）；`05`；`06` | 机制已实现，**待评测** |
| N02 | `repeated_mechanism` 候选（保留"第二个"的计数前提由语义层负责） | `04` E04-d/E04-d2 | 机制已实现，**待评测** |
| N03 | `spectacle_redundancy` 候选（骨架重复；默认保留地点与规模，只建议合并） | `04` E04-c/E04-c2（引用覆盖多个落点，`suggested_action='condense'`） | 机制已实现，**待评测** |
| N04 | `redundant_explanation` 候选（段内非通用 3-gram 重复；相邻段包含度） | `04` E04-b（"没关系"×2 形成候选且引用真实） | 机制已实现，**待评测** |
| N05 | `delete` 操作 + 精确跨度（"然后她不一样了。"可整段删除不动其它） | `01` P01；`05` E05-f 例A；`frontend-test` 94t | 机制已实现，**待评测** |
| N06 | 保护与依赖分析（相邻动作链不机械删除；面板/门禁拦截物件来源断裂） | `01` P16d；`frontend-test` 94h/94m/94n | 机制已实现，**待评测** |
| N07 | 对白/设定重叠属语义层；候选层不给"必改" | `04` E04-e/g（阴性对照不误报） | 机制已实现，**待评测** |
| N08 | 章尾不作重点重写：保护项与 `keep_reason` 随报告交付 | `04` E04-o（三类保护 + `kept`）；`06`（保留理由进覆盖表） | 机制已实现，**待评测** |

## 2. 明确**没有**做的事（不许被上面的 passed 掩盖）

| 条目 | 状态 | 原因/证据 |
|---|---|---|
| E02 剩余：审稿路径的阶段装配 | **未接线** | 阶段已能下发（HTTP 参数 + 前端 URL），但审稿请求仍复用上一次装配结果——为它单独再取一次装配会多一次成本，属需要作者决定的行为改动 |
| E02 剩余：慢通道 preset 与直连的等价规则集合对照 | **未验证** | preset 人设是另一份文件，本轮未做对照 |
| `idempotencyKey` / `staleCheck`(采纳时) / `selectionHash` 接线 | **未接线** | 仅模块原语 + 单测；采纳幂等与"采纳前复核源版本"属 E03/E05/E06 的采纳路径 |
| 跨刷新共享重试预算 | **部分** | 一次性仅格式重试已实现（`createRetryBudget({max:1})`），但计数器没落库，刷新后不共享（§6.6 要求的"跨刷新共享同一预算"未完全落实） |
| E03 ReviewV2 端到端保真 | **已实现** | 见 §1 的 E03 行：结构化审稿（引用核验）+ 独立选择记录表与端点 + 修稿前写记录 + 取回路径按记录收窄 |
| E05 受约束的局部编辑计划 | **已实现** | 见 §1 的 E05 行（`public/revision-plan.js` + `app.js` 的收窄接线） |
| E05 剩余 | **部分** | `condense` 需要 Host 显式给 `merged_span_approved`（把两个相邻跨度合成一个获批连续跨度）——应用层目前没有这个入口，所以 condense 一律 refused（不是静默降级）；`must_keep`/`do_not_add` 的**数据来源**要等 E03 的结构化 finding 与作者显式保护项，当前只支持调用方传入 |
| E06 剩余 | **已实现（对比视图）** | 见 §1 的 E06 剩余行：`/api/novel/revision/comparison` + `revisionSampleGuard` + 审稿报告入口。仍未做：设置页卡片（两个开关在审稿弹窗里）、`must_keep / do_not_add` 的数据来源 |
| E07 真实模型评测 | **SKIPPED** | `SKIPPED: paid_evaluation_not_authorized`（无独立授权与预算） |
| K01 保护清单 / 4.10 各保护项 | **未做** | 保护项若要落成机器可判的硬约束，需要 E05 的 EditPlan（`must_keep`/`do_not_add`）承接；本轮只保留了既有 `patch-safety` 与 `PROTECTION_RULES` |

## 3. 2026-10-09 复审（自审 + 独立复查）与修复

完整清单（12 条，含严重度、旧行为实测、修复位置、回归断言）见 [test-report.md](./test-report.md) §2b。
一句话总结：**高严重度的那一条正好抵销 E01 想交付的能力** —— 逐条门禁把"句级精确改动"按"整段替换/删除"模拟，
于是安全的精确修改被 `object_provenance`/`reference_anchor` 误拦（`applied=0`），而同一改动用段跨度就放行；
更隐蔽的是整批被拦会让组合核验走早退分支，没人纠正这个误判。修复后：门禁按**段落级真实 before/after** 收输入，
并补一条**跨度级**"事实增量过大"判据防止开缺口（`01 P16/P16d/P17` 同时钉住两侧）。
同轮还修了：组合核验的空白段坐标错位、空补丁时的错误文案与缺失的覆盖表、接回进度未传 ctx、
分段路径丢勾选、"别章"判据自证式、删除分隔符归属、多份 JSON 静默挑一份、协议模块缺失的归因与前置拒绝、
一次仅格式重试接线，以及一批文档过期/不实之处。

## 4. 与"最小必要修改"的关系

- 只新增一个前端模块（`public/revision-patch.js`）与一个入口脚本；没有新增打包器、没有换模型、没有动数据库结构、没有动 Harness 内核。
- `public/index.html` 只加了一行 `<script>`；作者自己的侧栏改动**原样保留**（备份里有改动前副本，diff 可核）。
- legacy（`anchor/revised`）路径**整段保留**：旧报告、旧响应、旧测试（80c/80d/81/82/85/90a-90c）都继续可读。
  代价是"包含式退位后替换整段"的旧语义在兼容路径上仍然存在 —— 这一点在 test-report 与本文都已明说，
  新请求一律走 v2，因此新链路不再经过它。
