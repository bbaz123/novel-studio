# v118 0317 专项 · 实施报告（implementation-report）

> 本轮把《Novel Studio v1.1.8｜3月17日觉醒日：审稿与修稿新样本专项增补》§2–§6 的八处缺口
> 落成**窄而可否决**的确定层候选，并补上"不许提前宣布解决"的结论闸。
> 全部改动都在判据层与测试层：**没有**改故事、没有改真实章节、没有改协议 schema、没有调用模型。

## 0. 一句话结论

本批没有让任何一条真实问题"消失"，它让**机器不能再无声地把它们抹掉**：
未批准的制度事实会进候选、报告里的虚构引号会被标出来、修后老引文不见不再等于问题解决、
未选中的问题不会被算作"已改"或"失败"。

## 1. 逐条实施记录

### §2 P0 · `new_workflow_rule`（V118-01 / V118-02 / V118-14）

- **变更文件 / 函数**：`public/patch-safety.js` → 新增 `WORKFLOW_PATTERNS`、`WORKFLOW_LINK`、
  `workflowRuleCandidates()`；`classifyEditScope()` 接入。
- **失败前**：`classifyEditScope('走出检测中心大门的时候，天色已经暗了。', '下午的号按学校分批往下叫，…；走出检测中心大门的时候，天色已经暗了。', {baseText: 中午两段})`
  → `{"scope":"wording","signals":[]}`（探针实测）。也就是这条新增制度事实**会被当成纯表达自动应用**。
- **成功后**：`{"scope":"story_fact","signals":[{"code":"new_workflow_rule","evidence":"按学校分批","needs_fact_authorization":true}, …]}`。
- **判据边界（为什么不会滥报）**：
  - 只看 `revised` 相对 `anchor` 的**新增片段**（纯删除/替换形态的新增为空 → 永不报）；
  - 必须同时出现"制度性叫号语"（`号|叫|排|批次|名单|单`）；
  - 新增机制**已存在于 `baseText`（= 已批准世界）**时不再报 → 蓝图已经批准的"学校分批"不会被永久硬拦（V118-02）；
  - 落入 `story_fact` → 只输出建议，**不自动应用**。
- **根因**：`story_fact` 的判据只认**实体词形**（等级/机构/分区/编号/人物）+ "大幅扩写"门槛。
  "按学校分批"没有任何实体词形，长度也远不到扩写门槛 → 三条路全部漏过。

### §2 P0 · `temporal_causal_bridge`（V118-03 / V118-14）

- **变更文件 / 函数**：`public/patch-safety.js` → 新增 `TIME_ADVANCE`、`EVENT_CLOSES`、`assessTemporalBridge()`；
  `classifyEditScope()` 接入。
- **失败前**：完全没有这条判据；`classifyEditScope` 对 R01 的补丁只给 `wording`。
- **成功后**：`{"code":"time_gap_unresolved","resolved":false,"time_advance":"天色","close":"测完","added":"下午的号按学校分批往下叫，…"}`。
- **判据边界**：只认"底稿已收束（走了/测完/散场/结束）+ 改后出现墙面钟（天色/入夜/傍晚…）"这一形状；
  新增内容若是**有来源的等待事件**（`陪王磊…交回去复核了一趟`）→ `bridged_by_sourced_event`，**不报**（阴性对照 V118-03-c）。
- **不做的事**：不选故事修法。把"中午"挪到傍晚、或由作者批准一个有来源的事件，都是**作者决策**；
  模块只负责"不许静默采纳一个无来源的时间桥"。
- **根因**：确定性层只比"字面还在不在"，没有任何"时间跨度与因果是否闭合"的判断位置。

### §3 P0 · `auditReviewQuotes`（V118-06 / V118-07 / V118-08）

- **变更文件 / 函数**：`ai/editing/narrative-review.mjs` → 新增 `QUOTED_SPAN_RE`、`QUOTE_EDGE_PUNCT`、
  `auditReviewQuotes()`；`structureReviewReport()` 的 `withConsistency()` 在**每条返回路径**上附加
  `quote_audit` 与 `strength_audit`。
- **失败前**：`structureReviewReport(...).quote_audit === undefined`；strengths 里的虚构台词不带任何标记。
- **成功后**：`{"quote":"你就不能配合一下气氛","status":"quote_not_found","found":false, …}`（V118-06）；
  `「算了。你上去吧。」` 逐字命中 → `verbatim_ok`（V118-08）；不带引号的概括 → **零核验项**（V118-08-b）。
- **判据边界**：
  - **只**核验"用引号表示逐字原文"的地方；概括与文学分析不参与核验，也不被要求附原话；
  - 引号边界先剥除（`：。，` 等收尾标点可容忍），但台词内部的词与次序**一律不归一**；
  - 找不到时只标 `quote_not_found` 并要求"删引号改为概括 / 人工核对"，**不删掉整条优点评价**。
- **根因**：`validateNarrativeFinding` 只管 `findings[].evidence[].quote`；
  `summary / strengths / issues` 的行内引号从未进入任何核验路径 → 虚构台词可以直达作者眼前。

### §4 P0 · `coverageVerdict`（V118-12 / V118-04 / V118-05）

- **变更文件 / 函数**：`public/revision-patch.js` → 新增 `coverageVerdict()`；`issueCoverageCandidates()`
  的候选补 `claimed_resolved` 字段。
- **失败前**：旧实现里"旧引文不在修后正文"就自然不再出现在候选列表中，
  调用方很容易把"没告警"读成"已解决"；`coverageVerdict` **不存在**。
- **成功后**：
  - 语义未跑 → `{"status":"changed_but_unverified","semantic_status":"not_run"}`（永不 `resolved`）；
  - 语义跑过且 `pass` → 允许 `resolved`（V118-12-c 的反例证明不是"永远不许 resolved"）；
  - 语义跑了但失败 → `needs_review`。
- **判据边界**：`coverageVerdict` 不自己判断语义，它只回答"**现有证据够不够说 resolved**"。
- **根因（本批最重要的一条）**："旧引文消失"是**阴性提示**，被当成了**阳性结论**。
  R01 的新时间句 original 消失、因果缺口仍在；R07 去掉"二十米"、空间关系未被证明。

### §5 P1 · `strength_qualifications`（V118-09）

- **变更文件 / 函数**：`ai/editing/narrative-review.mjs` → `checkReportConsistency()` 内新增
  `ABSENT_FAMILIES`、`ABSOLUTE_LIMIT` 与 `qualifications` 收集；返回值新增
  `strength_qualifications`，`note` 同步说明。
- **失败前**：`checkReportConsistency` 只认 `ABSOLUTE_CLAIM`（不再/完全没有/从未…）且**仅**在
  "解释"这一族上给冲突；"完全没有内心独白""唯一一次"**一律 `status:ok`**（探针实测）。
- **成功后**：`[{"code":"strengths_needs_qualification","family":"psychology","evidence":"他从小觉得人应该是这样。", …}]`。
- **判据边界（不按硬词表机械删句）**：
  - 只在**能指出正文反例**时才报（没有反例就不报，宁可不响）；
  - 只进 `strength_qualifications`（"请加限定"），**不改 `status`、不删句子**；
  - 不带绝对措辞的优点不受影响（阴性对照 V118-09-c）。
- **根因**：自洽性检查只覆盖"解释/说明/交代"一族，且没有把"绝对局限措辞"当成需要限定的断言形态。

### §6 P1 · `propStateCandidates`（V118-10）

- **变更文件 / 函数**：`public/patch-safety.js` → 新增 `PROP_STATE_VERBS`、`PROP_RESET_VERBS`、
  `propStateCandidates()`（并导出）。
- **失败前**：`typeof PS.propStateCandidates === 'undefined'`（探针实测）。
- **成功后**：`{"code":"prop_state_possible_overlap","prop":"手机","evidence":"…先在「悬在」…随后又在「举起」…中间没有复位动作","counterevidence":"…"}`。
- **判据边界**：同一物件名 + 前后相邻句 + 两次**不同**状态动词 + 中间**没有**复位动词（放下/收回/塞回/揣回…）
  才报；同一状态重复不报；已复位不报（阴性对照 V118-10-d）。**只提疑点，不定罪。**
- **根因**：确有"物件来源被删"（`object_provenance`）判据，但没有"同一物件状态被两次置位"的位置。

### §6 P1 · 未选中问题的处置（V118-11）

- **变更文件 / 函数**：`public/revision-patch.js` → 新增 `selectionOf()`；`issueCoverageCandidates()`
  支持 `selectedIssues`，返回 `unaccounted` / `unaccounted_count`。
- **失败前**：`issueCoverageCandidates({issues:[R04,R05], coverage:[unaccounted…]})` → `{"candidates":[],"count":0}`
  且**没有任何字段说明这两条去哪了**（探针实测）——未选中项凭空消失，报告很容易被读成"没变化 = 改失败"。
- **成功后**：`unaccounted` 两条，`disposition:'not_selected'`、`selection_status:'not_selected'`（显式空集合时）。
- **判据边界（诚实性）**：**未提供**勾选集合 ≠ 未选中。此时标 `selection_unspecified`，
  不得反过来把"我不确定它选没选"说成"作者没选"（阴性对照 V118-11-c）。
- **根因**：旧实现把"没有覆盖记录"直接 `continue`，等于让未处置项**静默消失**；
  而"无变化"与"未选中"是两件完全不同的事。

### §6 P1 · `anchorStatus`（V118-13）

- **变更文件 / 函数**：`public/patch-safety.js` → 新增 `anchorStatus()`（并导出）。
- **失败前**：`typeof PS.anchorStatus === 'undefined'`（探针实测）。
- **成功后**：`{"status":"unknown_anchor","hard_conflict":false,"vague_mention":true, …}`；
  正文明写 `0731 号` 时 → `confirmed`（阴性对照 V118-13-c）。
- **判据边界**：**不判硬冲突**（硬冲突需要一个与它冲突的明写值）、**不自动补数**；
  只回答"这个锚在正文里是否可见"。
- **根因**："伏笔锚未公开"与"伏笔锚矛盾"从未被区分开。

### §6 P1 · `reaction_causality` 的稀有度通道（V118-15）

- **变更文件 / 函数**：`ai/editing/narrative-scan.mjs` → `UNIVERSAL_HEAD` 补现场地点词、
  新增 `COMMON_RARITY` 与 `GRADE_RESULT_RE`、`reactionCausalityCandidates(text, opts)` 支持
  `opts.gradeRarity`；调用点改为 `reactionCausalityCandidates(raw, opts)`。
- **失败前**：`narrativeCandidateSignals('…D级。外场安静了。…', {gradeRarity:{D:'common'}}).candidates → []`
  （探针实测）——整句在 `UNIVERSAL_HEAD` 第一步就被丢弃。
- **成功后**：`candidates` 含 `reaction_causality:外场安静了`，带 `counterevidence_hint` 且
  `requires_semantic_check:true`；`gradeRarity:{D:'rare'}` 时**不报**（阴性对照 V118-15-c）。
- **判据边界**：旧词表通道（`ORDINARY_CAUSE`）保持原样；新通道要求"被标为常见的结果等级出现在**同一窗口**"，
  避免把远处的 A 级标记错配到这一句上。**绝不据此删改"安静了"这类反应描写。**
- **根因**：设定事实（"D 级是绝大多数人的结果"）住在正文之外，而判据只在正文里找"本来/平常"这类词。

## 2. 根因归纳（写成可执行规则，而不是"粗心"）

| 现象 | 可执行根因 | 规则 |
|---|---|---|
| R01 的制度事实被当纯表达自动应用 | 判据只认**实体词形**，机制/流程类事实没有词形落点 | 新增事实形态时，先问"它有没有词形？没有的话落在哪条判据？"——没有落点就是缺口 |
| `reaction_causality` 整句漏报 | 词表（`UNIVERSAL_HEAD`）写窄，失败姿态是**零候选** | 判据零命中时，必须能区分"确实没问题"与"词表没覆盖"；用真样本句做一次探针 |
| "旧引文消失"被读成"问题解决" | 把**阴性证据**当**阳性结论** | 任何"已解决"结论都必须指名它的证据来自哪一层；确定性层只能说"字还在不在" |
| 未选中项凭空消失 | 无记录时 `continue`，没有 disposition 字段 | 缺记录必须是**显式状态**（`unaccounted`），不能是"不出现" |
| 报告引用虚构台词 | 行内引号不在任何核验路径上 | 核验要覆盖**所有**"声称是原文"的位置，而不只是结构化字段 |

## 3. 与 UI / 作者编辑 / 整章重写的边界（本轮硬要求）

| 通道 | 是否受新门禁影响 | 依据 |
|---|---|---|
| UI 保存 | **不受影响** | 本批未改 `server.js` / `db.js` / 任何保存端点 |
| 作者手工编辑 | **不受影响** | 新判据只在 `gatePatches`（机器局部补丁通道）与审稿报告渲染上生效；手工编辑不经该通道 |
| 明确整章重写授权 | **不受影响** | 未改 `revision_full` 通道与 `verifyPatchedText` 的整章路径；时间锚类候选在 `authorApprovedTimeAnchors` 下直接放行 |
| 机器局部补丁 | **收紧** | 新制度事实 / 未闭合时间桥 → `story_fact`（建议而非自动应用） |

## 4. 本批**没有**做的事（明确非目标）

1. 未改补丁协议 schema（无 `reason` 新字段、无新 op）。
2. 未接线上：`coverageVerdict` 与 `propStateCandidates` / `anchorStatus` 目前是**已导出、可断言**的判据，
   `app.js` 的渲染接线留待作者确认展示方式（界面上"未选中/待核对/需限定"该怎么呈现属 UI 决策）。
3. 未对真实章节跑任何修改；未重放 0317 的真实审稿任务。
4. 未跑语义模型（`semantic_status:not_run`）。
5. 未重新生成 `docs/phase-map.md`（沙箱 git 不可用，见 `test-report.md` §4）。
