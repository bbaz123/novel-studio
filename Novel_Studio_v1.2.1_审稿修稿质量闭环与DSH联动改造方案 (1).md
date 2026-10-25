# Novel Studio v1.2.1 审稿发现问题却未充分修复：源码级根因分析、质量闭环与 DSH 插件联动改造方案

> **版本**：1.0（技术方案）  
> **分析日期**：2026-10-18  
> **分析目标**：`bbaz123/novel-studio`，用户指定版本 **1.2.1**；`deepseek-ai/deepseek-harness` **0.2.0-rc.2**；拟开发 `dsh-auto-plan-executor`；现有 `dsh-confirmation-resolution`  
> **源码依据**：GitHub `Experimental-Version-v1.0` 分支的公开代码，其 `package.json` 显示 `version: 1.2.1`。**并未读取你的本机运行日志、数据库、实际勾选记录或本地未推送修改。** 因此，能确认的是源码行为及文本差异；“某一次为什么被拦”须按本方案抓取执行证据才能定案。  
> **本文件性质**：完整、可交给 DSH 执行的改造与测试方案，**不是已完成的软件修补或真实本机联调报告**。不能把计划项 `NOT_RUN` 写成测试通过。  
> **安全与作者意图**：不删除原有精确编辑、安全门禁、作者确认与一次性审批机制；不通过提高模型自由度或绕过门禁“解决”修复率问题。

---

## 目录

1. 结论及重要发现
2. 用所给章节逐项复盘
3. v1.2.1 源码路径与高可信度原因
4. 不确定根因的现场取证办法
5. Novel Studio 内部质量闭环（P0）
6. 跨位置、多热点的安全修复设计（P0）
7. `dsh-auto-plan-executor` 的写作质量闭环接入（P0/P1）
8. `dsh-confirmation-resolution` 的边界与兼容（P0）
9. 更值得追加的创作质量增强功能（P1/P2）
10. 接口、数据结构与算法示意
11. 修改文件、开发顺序和安全迁移
12. 逐条可执行的回归用例
13. 目标环境检测、真实联调、验收与回滚
14. 交给 DSH 的完整实施指令
15. 参考源码位置及限制

---

## 1. 结论及重要发现

### 1.1 为什么“审稿能找到，修稿却没完全改”

**这是由几条不同链路叠加造成的“闭环不完整”，而不是能从两版文章直接证明的一处单点 Bug。**

按照当前公开代码：

| 机制 | v1.2.1 实际情况 | 对本章的潜在影响 |
|---|---|---|
| 审稿模型发现问题 | 能输出自然语言 `issues` | 读得懂问题不等于机器拿到了精确操作目标 |
| 问题→授权范围 | `buildRevisionPlan()` 按引文定位精确 hotspot | 一条跨两处文字的错误，通常只得到**一个**热点 |
| 授权限制 | 保护区/歧义引文/跨度不足均不擅自扩大 | 多处矛盾有时因定位、scope 或权限而不修改 |
| 模型产出补丁 | 必须符合严格 JSON 协议及精确跨度 | 模型可能只改一部分、选择 keep、输出无效补丁 |
| 安全门禁 | 补丁校验、逐项安全门禁、组合核验 | 有效的部分能应用；未过门禁的部分不进入候选 |
| `coverage_ok` | 判断是否存在 `unaccounted`，**不是**“已选择的问题全部解决” | `blocked/keep/partially_resolved` 不会自动转成修好 |
| 语义验收 | `coverageVerdict()` 已有语义通过才可 `resolved` 的原则 | 预览调用把 `semantic` 传为 `null`，缺少真实复验闭环 |
| 自动再次修复 | 已有针对**输出格式失败**的有界重试 | 不是“原缺陷仍存在→再精准修复”的语义闭环 |
| 编辑器写回 | 存在作者“合并到正文”等显式操作 | 预览候选、实际入库、最终验收是三个不同状态 |

### 1.2 可以直接确认的四处设计缺口

**缺口 A：审稿输出协议不足。** 前端 `buildAIReviewPrompt()` 主要让模型输出：

```json
{
  "summary": "...",
  "issues": [{"text": "..."}],
  "deferred": [],
  "strengths": []
}
```

但后续修稿器更需要稳定 `finding.id`、`evidence[].quote`、问题涉及的**全部位置**以及**成功判据**。当模型仅输出自由文本 `issues` 时，后续只能靠引号提取与局部定位推断修稿热点。这是数据契约的断层。

**缺口 B：一条问题只取第一个可定位引文。** `public/revision-plan.js` 中 `buildRevisionPlan()` 遍历候选引文，命中后 `break`，给该问题只添加一个 `hotspot`。例如“检测单开头两折，结尾一折”需要至少关联**两处证据**，但编辑许可不一定覆盖两处。必须设计“跨位置联合验收”和多 hotspot 的局部授权，而不是宽松地开放整章。

**缺口 C：应用成功与问题修复成功没有贯通。** `public/revision-patch.js` 的 `coverage_ok` 只是排除 `unaccounted`；不排除 `blocked`、`keep` 等状态。`verified` 对应补丁安全/组合校验，并不是原审稿问题被语义修复。应用 3 处补丁 ≠ 已解决 3 条审稿问题。

**缺口 D：语义闸已存在，但 UI 路径未实际完成其输入。** `coverageVerdict()` 明确：`semantic:'not_run'` 不得判 `resolved`。然而预览 `revisionCoverageHtml(coverage,{ issueCoverage, semantic:null })`；用户可能看到成功 toast 或合并按钮，但没有自动进行针对原缺陷的语义核验与针对性二次修复。

### 1.3 不应误判为 Bug 的情况

- 作者可能**只勾选了部分审稿问题**：未勾选的问题本就不该修改。
- 两个修稿授权开关默认关闭；尤其 `condense` 没被批准时，重复信息的跨句压缩不能自动放行。
- 受保护的选区/内容、无法唯一定位的引文、强制性安全门禁被拒绝，是正确的保护行为。
- 因原蓝图、词条与审稿建议冲突而保留内容，不等于“模型偷懒”；该冲突应进入 `CANON_CONFLICT`，而非擅自改世界观。
- 当前材料没有提供实际授权勾选集、补丁 JSON、`coverage`、`gate.blocked`、实际入库记录，不能断言此次 8 条均获得授权，或把所有未修稿归咎于某个具体函数。

**工程上应改进的是：修不了就报明白原因；修过必须复验；依旧不通过就只针对缺口再修；不能以“补丁生效数”替代“已修复问题数”。**

---

## 2. 用你提供的正文逐项复盘

以你贴出的**审稿前→审稿后**文本逐字对比。下列状态是**文本层面**可见结果，不等于确定具体未修改原因。

| # | 审稿意见 | 修后观察 | 文本层状态 | 建议验收器 |
|---|---|---|---|---|
| 1 | 检测单开头两折，结尾一折 | 最后一段仍“折过一折”，中途没有足够清楚的再折动作 | 未解决 | 跨段道具状态检查 + 联合引文 |
| 2 | “基础战斗能力”填入“职业方向” | 王磊的单子仍写“职业方向那一栏印着‘基础战斗能力’” | 未解决 | 栏位角色/等级评价字典 |
| 3 | D 级评价与词条冲突 | “普通作业类”改“普通职业”，但“D级·无战斗能力”等评价口径仍需与词条同步 | 部分处理 | 世界观词条优先级 + 术语一致性 |
| 4 | 检测规则多次重复 | 规则概述、工作人员解释、两次实测仍基本保留 | 未解决 | 机制演示次数/节奏语义核验 |
| 5 | 低等级城市同日两个 A 级 | 仍保留两个 A 级，没有额外异常性解释 | 未解决或蓝图约束冲突 | 稀缺度＋蓝图不可变项交叉核验 |
| 6 | 匿名群众反应堆叠 | 删除眼镜男拍摄、几个女生议论等描述 | 部分处理 | 保留有叙事功能的最少反应 |
| 7 | 否定句与无信息动作重复 | 王磊摸兜等被删；其他“没接话/没去管”仍保留 | 部分处理 | 逐条对齐剩余案例 |
| 8 | “细白的手腕”外貌模板 | 已改为“她右袖口松了一截” | 已解决（文本可见） | 简单证据 + 复核动作完整性 |

**本章最典型的问题类型：**

1. **跨位置矛盾**（#1）：需要同时读开头、结尾和中间操作链。
2. **术语/栏位关系错误**（#2、#3）：不能只替换一个词；要理解“等级评价≠职业方向”。
3. **设定冲突**（#5）：自动修复不能擅自违背原蓝图。“保留两个 A 级，同时把稀有异常写得可信”与“把第二个改成 B 级”是不同叙事决策；需把原蓝图约束带入。
4. **节奏压缩**（#4、#6、#7）：需合法的连续跨度授权或多个分别许可的局部补丁，默认不扩大改写范围。
5. **单点表述调整**（#8）：最容易被精确引文+一个热点修好。

**验收的例子（仅供模型决策，不应硬编码替换全部文本）：**
- #1：读者能从文本中确认最终检测单的折叠状态与先前动作相符；不能简单删掉最早的“两折”就算完。
- #2：“基础战斗能力”不能再作为“职业方向”的值；若具体方向词条没有提供，不要自行发明，进入缺少词条信息状态。
- #5：原蓝图若强制“连续两个 A 级”，则两位 A 都必须保留，需说明稀缺事件的异常性，避免反应像常态；具体是否需要词条补充必须按原蓝图。
- #4：减少重复规则讲解，但至少一次完整演示；李拓、风暴者、林清雪与主角的叙事作用不能损失。
- #8：删掉模板化形容时仍保留“拢袖口”和“看掌心”动作及相关伏笔。

---

## 3. v1.2.1 源码路径与高可信度原因

### 3.1 审稿输出：缺机器可用的验收合同

**位置**：`public/app.js`，`buildAIReviewPrompt()`（约 L10583–L10589）；审稿解析/分段合并沿同一 `review` 对象传递。

实际提示词显式规定 `issues:[{text}]`，没有把每条问题的唯一 ID、多个原文证据 `evidence[]`、影响级别、范围、接受条件作为强制输出字段。后端/插件支持结构化 finding 的地方存在，但**并不是所有审稿路径都保证输出**。

**为什么影响修复**：审稿报告写得好只保证“人能读懂”；编辑算法要求“原文在哪个字节区间、批准可以改哪一处”。如果发现阶段不产出对应字段，后面靠正则从问题文本里提取引号就容易漏。

**修复原则**：将标准输出统一为 `review.findings[]`，并保留旧 `issues[]` 用于展示和兼容。旧报告由适配器转换为“有待补充引文”的条目，而不是声称已取得精准授权。

### 3.2 修稿定位：每条 finding 只形成一个热点

**位置**：`public/revision-plan.js`，`buildRevisionPlan()`（约 L184–L257）。

当前优先取结构化 `evidence[].quote`，其次 `quote`，最后自由文本引号。对每条 finding 找到**第一个**可定位候选后 `break`。然后为该 finding 创建**一个** `hotspot`。

这是保守授权的设计，不是随意漏修，但会带来功能缺口：

- 一条问题有两个不相邻位置，可能只允许修改一处；
- 修第一处并不一定解决另一处因果矛盾；
- 如果作者期望“一条复审意见=一条完整修复”，需要模型先理解多个证据与验收条件，而不是只命中最容易找的一句。

`locateFragment()` 会拒绝同一引文多处出现的歧义（`ambiguous_anchor`）——**应保留该防护**，用明确 `span_id` 或足够独特的上下文来化解。

### 3.3 授权门禁：不应为了修复率关闭

**位置**：`public/revision-plan.js`，`planAuthorization()`、`scope_incomplete`；`public/revision-patch.js`，`gatePlanPatches()`、`runRevisionPipeline()`。

- 定位不到：`needs_scope`；
- 同样引文多处：`ambiguous_anchor`；
- 保护区内：`refused`；
- 未打开“允许局部压缩”：`condense` 必须拒绝；
- 补丁越出授权范围：安全门禁拦下；
- 同组补丁失败：整组候选不能部分冒险应用。

这些机制保护作品、避免整章被模型悄悄重写。建议修改的是“作者如何精准补授权”“每项受阻如何解释”和“如何产生合法的多个热点”，而不是把 `refused` 映射为继续执行或无条件放行。

### 3.4 `coverage_ok` 不等于所有问题通过

**位置**：`public/revision-patch.js`，`runRevisionPipeline()`（约 L1695–L1815，特别是 L1751–L1765）。

源码存在如下语义：

```js
coverage_ok: coverage.every((c) => c.status !== 'unaccounted')
```

它只表示模型对被选中事项都有**可记录的处置**，而非全部 `resolved`。`blocked`、`keep`、`deferred` 等仍可能存在。

因此改造前应在数据结构里把以下指标严格分开：

- `selection_count`：作者实际勾选几项。
- `plan_located_count`：几项获得合法热点定位。
- `patch_applied_count`：实际应用几个补丁（可能一项多个）。
- `gate_passed_count`：几项的必要安全检查通过。
- `semantic_verified_count`：**几条审稿问题经修后独立判定确实解决**。
- `unresolved_count`：已批准但仍未解决的事项数。

只有后两者能构成质量闭环的核心指标。

### 3.5 语义验收函数已有原则，但没有形成自动循环

**位置**：
- `public/revision-patch.js`：`coverageVerdict()`，约 L197–L239。
- `public/app.js`：`revisionCoverageHtml()`、`showReviewDiff()`，约 L11848–L11859、L12215–L12224。
- `public/app.js`：`refineByChecklist()`，约 L10921–L11209。

`coverageVerdict()` 明确规定“旧引文消失≠解决”，无实际语义判定最多 `needs_review / partially_resolved`。

而候选预览调用的是：

```js
revisionCoverageHtml(coverage, { issueCoverage, semantic: null })
```

也就是**没有交给它真正的修后语义复验结果**。

同一 UI 路径会出现“已按清单改好 N 处”的 toast，成功口径是补丁应用数量，而不是“已验证解决 N 条”。

**建议**：这句 toast 改成“本次应用 N 个局部补丁；已选 X 项，独立核验通过 Y 项，待处理 Z 项”；核验未运行时必须显示“尚未复验”，不能提示“全部修好”。

### 3.6 重试预算不等于质量闭环

**位置**：`public/app.js`，`REVISION_RETRY_MAX=1`，约 L11470–L11483。

现有有界重试重点控制坏格式、同快照/勾选组合的成本与副作用，不能替代这样的流程：

> “修后发现第2、5项仍违反既有词条/蓝图 → 仅重新修这两项 → 再跑验收 → 决定能否定稿”。

不能简单把现有重试上限改为无限。应新建独立“**语义复修轮次**”，与“模型输出格式重试”分别计数，且两者共同受全局预算限制。

### 3.7 写回审批不能越过

**位置**：`harness-plugins/novel-writing/novel-tools.mjs`，`novel_chapter_save` 约 L726 起，`novel_approvals` 约 L1093 起。

源码规定 AI 真正写回章节需要**作者在界面确认后颁发的一次性 `approval_id`**，模型不能创建，且不能把一句自然语言“同意”替代正式凭据。

因此引入 DSH 自动方案插件后，也只能让“生成安全候选稿→自动验证→展示待作者批准的稿件”自动化；若要真正保存到受保护的作品库，必须遵守原审批模型。用户勾选审稿问题只授权**针对所选范围提出编辑候选**，不自动等于同意所有内容写回。

---

## 4. 本次修稿为什么漏：现场取证办法

### 4.1 优先采集的记录（单章一次修稿运行）

不要靠猜。建议新增一次修稿的 `revision_run_id`，并保存以下**脱敏结构化元数据**：

```json
{
  "revision_run_id": "uuid",
  "work_id": "opaque-id",
  "chapter_id": "opaque-id",
  "review_id": "stable-review-id",
  "base_hash": "sha256-or-reliable-content-version",
  "author_selected_issue_ids": ["1", "2", "3"],
  "review_findings": [
    {
      "id": "1",
      "evidence_quote_count": 2,
      "evidence_located_count": 1,
      "required_target_count": 2
    }
  ],
  "edit_plan": {
    "scope_incomplete": true,
    "hotspots": 2,
    "authorized_span_count": 2,
    "refused_issue_ids": [],
    "needs_scope_issue_ids": ["1"]
  },
  "model_response": {
    "parsed": true,
    "patch_count": 2,
    "dispositions": []
  },
  "safety": {
    "gate_available": true,
    "blocked_count": 0,
    "combined_verified": true
  },
  "semantic": {
    "status": "not_run",
    "verified_issue_ids": []
  },
  "persistence": {
    "preview_shown": true,
    "author_merge_approved": false,
    "saved_version": null
  }
}
```

**注意**：以上 JSON 是**建议记录格式示例**，不是项目当前实际执行结果。不能直接把示例当测试证据。

### 4.2 对每个未修项给出“单一可追溯原因 + 允许的下一步”

| 原因代码 | 触发依据 | 后续处理 |
|---|---|---|
| `NOT_SELECTED` | UI 勾选集中没有此 ID | 不修改，不算当前轮失败 |
| `EVIDENCE_MISSING` | 无逐字引文 | 将问题转为等待精确定位；可给用户候选定位供确认 |
| `AMBIGUOUS_ANCHOR` | 同样引文出现在多处 | 用上下文和真实 span 识别，严禁猜第一处 |
| `MULTI_TARGET_INCOMPLETE` | 一项需多处关联，实际只批准了一处 | 组合成精确多热点计划，不扩大全章 |
| `PROTECTED_SPAN` | 区间在保护清单里 | 保留原文，尝试从其他获准跨度修复；否则待作者选择 |
| `CONDENSE_DISABLED` | 需要压缩但选项关闭 | 尝试同跨度 `replace`；若仍需跨句压缩，申请作者批准对应连续跨度 |
| `PATCH_FORMAT_INVALID` | 补丁协议或 JSON 失败 | 格式专用有界重试 |
| `GATE_BLOCKED` | 安全/不变量不通过 | 精确反馈门禁错误，重写安全补丁；不得绕过 |
| `MODEL_KEEP/DEFERRED` | 模型明确不修改 | 判断是否与原目标冲突；冲突则报未解决，不静默算通过 |
| `CANON_CONFLICT` | 审稿建议与固定蓝图/词条冲突 | 保留蓝图，给替代候选；涉及改核心方向则待作者 |
| `SEMANTIC_NOT_RUN` | 没有独立验收 | 启动复验；预算不足则明确挂起 |
| `SEMANTIC_FAILED` | 独立复验不通过 | 在仍允许的热点里精准二次修复 |
| `MERGE_NOT_APPROVED` | 候选已通过但作者未批准写回 | 保持为已验证候选，不当成已入库定稿 |
| `BASE_STALE` | 审稿底稿 hash 与当前正文不一致 | 重新定位/获取作者新批准，不套用旧跨度 |

### 4.3 单章故障定位的推荐顺序

1. 从原 UI 审稿记录恢复**实际**勾选的 issue IDs（不是审稿报告的全部 8 条）。
2. 判断 `review.findings` 是否包含精确引用；如只有 `issues[{text}]`，确认 fallback 路径。
3. 对照 `buildRevisionPlan.coverage`：多少个 `planned/needs_scope/ambiguous_anchor/refused`？
4. 对照 `planAuthorization.authorized_span_count`、`scope_complete` 和 `protected_spans`。
5. 收集模型原始补丁 JSON 的**敏感信息保护后的摘要**和 `dispositions`。
6. 对照安全门禁 `gate.blocked`、`group_failures`、`combined.verified`。
7. 对照 `coverage`、`issue_coverage` 和 `coverageVerdict` 是否真的运行语义检查。
8. 核对差异预览、用户是否点击合并、章节实际保存版本。
9. 每个未完成项最后必须落到明确原因代码，而非笼统的“模型判断无需修改”。

> **本项完成标准**：能够对这篇小说的 #1–#8 每条给出一份`selected? / located? / patched? / gate? / semantic? / persisted?` 的证据链。

---

## 5. Novel Studio 内部的质量闭环（P0，优先改这里）

**工程原则：质量闭环的拥有者必须是 Novel Studio 本身，而不是把未修复的问题交给外部 DSH 无限重试。** 因为 Studio 才掌握作者勾选、权限、编辑器版本、原方案蓝图、受保护区、DB 写回和风险门禁。DSH 可以编排跨项目任务，不应绕开 Studio 的事实来源。

### 5.1 新状态机

```text
REVIEWED
   ↓
SELECTED (作者真实勾选；确立 scope)
   ↓
EVIDENCE_MAPPED (逐项引文/位置/验收条件)
   ├── NEEDS_SCOPE / PROTECTED / CANON_CONFLICT
   ↓
PATCH_PLANNED (精确多热点计划)
   ↓
CANDIDATE_GENERATED
   ↓
SAFETY_GATE (授权/保护/组合/固定设定)
   ├── GATE_BLOCKED
   ↓
SEMANTIC_VERIFY (逐问题独立复审)
   ├── PASS → ISSUE_VERIFIED
   ├── FAIL → TARGETED_REPAIR（有界，单问题/问题组）
   ├── UNKNOWN → NEEDS_REVIEW
   └── BUDGET_BLOCKED
   ↓
VERIFIED_CANDIDATE（所有被选且必须解决的问题过关）
   ↓
AUTHOR_COMMIT_APPROVAL（如现有写回流程要求）
   ↓
PERSISTED_VERIFIED（版本一致 + 写回成功 + 入库复核）
```

**必须区分 3 种完成：**
1. `PATCH_APPLIED`：局部字符串替换在候选稿中成功。
2. `ISSUE_VERIFIED`：审稿问题确实消除，并通过固定约束检查。
3. `PERSISTED_VERIFIED`：作者按现有权限模型批准合并，数据库保存完成，保存后的文本重新核验版本。

UI 可以展示前两种，但不能把它们合并成“已全部修好并存盘”。

### 5.2 新增完整问题契约 `finding.v2`

建议先用双写方式逐步迁移：

```json
{
  "id": "R-0001",
  "title": "检测单折数前后矛盾",
  "severity": "high",
  "type": "cross_span_consistency",
  "explanation": "开篇为两折，章尾为一折，缺少对应操作",
  "evidence": [
    {
      "quote": "折过两折，纸边对齐得很仔细",
      "role": "reference",
      "required": true
    },
    {
      "quote": "检测单也在同一个口袋里，折过一折",
      "role": "candidate_edit",
      "required": true
    }
  ],
  "acceptance": {
    "rule": "同一道具的持有状态与动作链前后一致",
    "preserve": ["检测单", "编号0731", "章尾系统只出场一次"],
    "scope": "仅该问题已定位且经作者批准的跨度"
  },
  "status": "selected"
}
```

补充：
- `quote` 必须逐字来自当前正文；不得让模型编造“看起来相似”的片段。
- `role: reference` 表示**只读证据**，不自动获得写入权；`candidate_edit` 也必须通过 Host 精确范围授权。
- `acceptance` 应同时包含“要达到什么”和“不能破坏什么”。
- `severity`、`type`、`acceptance` 初始可由模型建议，最终由确定性校验和作者批准流程约束。
- 对已有 `issues[{text}]`，可从 `findings` 适配显示；历史报告没有证据时不伪造证据。

### 5.3 审稿生成协议

将 `buildAIReviewPrompt()` 升级为：

```json
{
  "summary": "...",
  "findings": [
    {
      "id": "R-0001",
      "title": "...",
      "type": "continuity|canon|repetition|style|causality|other",
      "severity": "high|medium|low",
      "explanation": "...",
      "evidence": [{"quote": "实际逐字引用", "role": "reference|candidate_edit"}],
      "acceptance": {
        "rule": "修后可客观检查的目标",
        "preserve": ["不得丢失的蓝图/伏笔/人物状态"]
      }
    }
  ],
  "issues": [{"text": "向旧 UI 兼容的人类可读描述"}],
  "deferred": [],
  "strengths": []
}
```

在模型输出后由 Host 做验证：
1. `id` 唯一且稳定。
2. 每条 `quote` 必须在底稿出现，且提供出现次数/可唯一定位情况。
3. 跨位置问题至少包含被比较的多个 `evidence`，而非只给一个场景。
4. 验收目标明确且不与原蓝图 `must_keep` 冲突。
5. 找不到原句可重试**提取证据**，不默认扩大授权或直接整章改写。
6. 兼容现有 review ID、分段审稿与历史报告回放。

### 5.4 逐条语义验收器

新建 `revision-semantic-verifier`，输入是：

- 本轮选中的原始 finding（稳定 ID、理由、全部 evidence）；
- 当前候选稿、上一版稿的必要差异；
- 相关世界观词条、角色卡、章节蓝图；
- 不变量、受保护区与已确认伏笔；
- `safety_verified`；
- 成本与剩余资源；
- 本轮操作的 `plan_hash`、`base_hash`。

优先**确定性规则**：
- #1 对比道具状态和相关动作记录；
- #2 把 `基础战斗能力` 与“职业方向”归属做角色校验；
- #3 按有版本的世界观词条检查 D 级词条；
- 被授权片段外的字节逐字不变；
- 章节编号/伏笔未被误删；
- 模型声称的补丁 ID 与实际 diff 关联。

然后运行**语义核验模型**（仅在需要、费用允许时）：
- 检查 #4 的重复是否仍影响节奏；
- 检查 #5 罕见事件是否被当作异常处理，且不违反蓝图；
- 检查 #6/#7 的冗余是否真正减少、人物反应是否仍成立；
- 检查 #8 改法是否保留动作、人物氛围和伏笔。

语义核验必须输出严格结构：

```json
{
  "issue_id": "R-0001",
  "verdict": "pass|fail|need_context",
  "checks": [
    {
      "criterion": "折数与动作链一致",
      "passed": false,
      "evidence": ["开头：...", "结尾：..."]
    }
  ],
  "reason": "...",
  "repair_hint": "仅针对已允许的局部跨度调整...",
  "confidence": "high|medium|low"
}
```

**注意**：核验模型的 `pass` 也不能覆盖确定性 fail、权限失败、词条缺失或 safety fail；如双方冲突，则 `needs_review`。建议核验由不同提示词、不同上下文简化策略实现；资源允许时使用不同模型/独立调用，但不以模型身份“独立”作为天然可靠性的保证。

### 5.5 精准二次复修，而非整章重写

- 最多 2 轮**语义复修**（可配置），不包括第一次生成；同一错误连续三次不得无限循环。
- 每轮仅把 `FAIL/INCOMPLETE` 且**仍在作者原授权范围内**的问题重新送入修稿器。
- 一条问题需要新增未授权跨度时**停止这条**，回到“精准增补授权”界面；已经允许的其他条继续。
- 旧已通过问题成为**回归不变量**，新一轮不得修坏（保持已验收约束）。
- 补丁安全门禁每轮重新执行；不能缓存上一次的通过结果代替新候选。
- `BASE_STALE` 时重新采样和授权定位，不能继续套用旧指针。
- 重复失败记录具体原因，以便下一次做不同的合法尝试。
- 全轮统一计算 token/人民币额度；估价不可靠时不能作确定性预算放行。

### 5.6 质量报告从“改了几个补丁”升级为“改好几条问题”

新的报告样式建议：

```text
审稿确认：8 条
本次授权：8 条
准确定位：5 条；待补充范围：2 条；蓝图冲突待定：1 条
生成局部补丁：6 个
安全门禁通过：5 个；拦截：1 个
语义验收通过：3 条；部分处理：2 条；未通过：3 条
候选稿状态：PARTIAL_VERIFIED（不宣称全部修好）
正文入库状态：AWAITING_AUTHOR_COMMIT
下一步：仅针对剩余问题申请精确授权/继续复修
```

上述数字仅是**界面样例**，必须由真实执行流水动态计算。

---

## 6. 多热点与跨位置问题的安全实现（P0）

**这是最关键的算法升级，但不能放松原来的“只改获准字节”原则。**

### 6.1 读证据≠能编辑证据

一条 finding 允许拥有：

- `reference_evidence[]`：开头/结尾/词条/蓝图等可读证据；
- `targets[]`：本轮实际获得授权、可编辑的具体跨度；
- `acceptance`：原问题的整体成功标准；
- `atomic_group_id`：同一逻辑问题的多个修改必须一起校验。

**示例：检测单折数**
- 开头“两折”为**只读证据**；
- 章尾“一折”可被明确授权为编辑目标；
- 验收时必须查看开头—展开—回收—结尾四段；但不需要因此授权重写开头至结尾的全部正文。

### 6.2 修改 `buildRevisionPlan()`：一条问题可以有多个热点

建议新增 `buildRevisionPlanV2`，保留 v1：

```js
// 示意算法：不是当前仓库现成 API
function buildRevisionPlanV2({ snapshot, findings, hostAuthorization, invariants }) {
  const plan = { hotspots: [], coverage: [], groups: [], scope_incomplete: false };
  for (const finding of findings) {
    const references = locateAllEvidenceReadOnly(snapshot.body_text, finding.evidence);
    const targetRequests = deriveEditableTargets(finding); // 不把 references 全部当作授权
    const located = targetRequests.map((t) => locateUniquely(snapshot.body_text, t));

    if (located.some((loc) => !loc.unique)) {
      plan.coverage.push({ issue_id: finding.id, status: "needs_scope" });
      plan.scope_incomplete = true;
      continue;
    }
    const authorizedTargets = located.filter((loc) =>
      hostAuthorization.allows(finding.id, loc.start, loc.end, loc.original)
    );
    if (authorizedTargets.length !== located.length) {
      plan.coverage.push({ issue_id: finding.id, status: "authorization_missing" });
      plan.scope_incomplete = true;
      continue;
    }
    const group = `issue:${finding.id}`; // 同一逻辑问题的所有编辑目标原子化
    for (const loc of authorizedTargets) {
      plan.hotspots.push({ issue_id: finding.id, group_id: group, ...loc });
    }
    plan.coverage.push({ issue_id: finding.id, status: "planned", target_count: located.length });
  }
  return plan;
}
```

**约束**：
1. `locateUniquely` 仍必须实行出现次数/身份校验。
2. `hostAuthorization.allows()` 不是模型自报，而是由真实用户勾选/真实 UI 授权/宿主已批准范围编译出的许可表。
3. 多热点属于一个原子问题；允许不同位置但**各自独立、狭窄地授权**，不能合并成跨越中间整章的大跨度。
4. `condense` 仍只有连续已批准跨度可用；跨段变化用多个 replace/delete 补丁，不凭连号就自动放开整段。
5. 在 `planAuthorization()` 中将旧 `authorized[issue_id]` 单条结构升级到向后兼容的 `authorized_targets[issue_id][]`；原执行器的授权检查和组核验必须一起升级。
6. 多次补丁执行应按原文起始偏移倒序合并，复用已有安全写回算法。
7. 同组任何一条违反门禁则整个组不应用，并记录 `group_failures`；仍能继续与其独立的其他组。

### 6.3 优先追加的是“可编辑位置建议”，而非“自动放宽”

遇到 `needs_scope` 时：
- 先提供有限个候选精确句子与其上下文给作者核对；
- 只有作者通过现有 UI 授权该跨度，才可加入目标；
- 已勾选审稿项**不能**推导出整章所有可能涉及的跨度都获准；
- 作者拒绝授权时该项转 `BLOCKED_BY_SCOPE`，独立的其他项仍继续。

---

## 7. 在 `dsh-auto-plan-executor` 中加入写作质量闭环

### 7.1 双层编排结构：不要同时出现两个“主指挥”

**建议：Novel Studio 是章节修稿的业务执行器，DSH Auto Plan Executor 是跨任务流程与验收的外层协调器。**

```text
真实作者提交“小说修稿实施方案”
      │
      ▼
DSH Auto Plan Executor：触发/锁定方案/拆任务/记录整体状态
      │
      ├─ 检查 Novel Studio 1.2.1 / 当前作品 / 蓝图 / 费用 / 所需授权
      │
      ▼
Novel Studio：author-approved revision job（持有已选问题、快照和权限）
      │
      ├─ 审稿 findings + 证据定位
      ├─ 多热点局部修稿和安全门禁
      ├─ 逐条确定性+语义验收
      ├─ 未解决问题定向复修（受控预算和轮数）
      │
      ├─ VERIFIED_CANDIDATE → 等现有作者合并/写回审批
      │
      └─ PARTIAL / BLOCKED → 逐项原因
      │
      ▼
DSH Auto Plan Executor：读取带证据的结果、推进其他独立任务
      │
      ▼
最终统一报告（禁止把待审批候选稿称为已入库成稿）
```

### 7.2 触发隔离

在 DSH `0.2.0-rc.2` 下，自动方案触发器只识别真实用户消息及本轮实际附件。

**不要**让 Novel Studio 的内部 AI 审稿 Prompt、章节蓝图、“剧情方案”、中途自动生成的 job 回显或 `<goal_round>` 等伪装为新用户提交，从而自我触发新的方案执行。

建议检查 `message_source`、`job_kind`、`session_id`、`origin_nonce` 与稳定去重键；Novel Studio 内部续轮消息不触发自动方案插件。真实作者在 DSH 中明确说“按照修稿方案执行”才创建新的外层 plan。

### 7.3 增加新模块 `writing-quality-coordinator`

建议在新插件中增加：

```text
dsh-auto-plan-executor/
└── lib/
    ├── writing/
    │   ├── studio-adapter.js          # 通过公开/受控协议对接 Studio
    │   ├── quality-coordinator.js     # 协调审稿→修稿→核验→复修
    │   ├── quality-state.js           # 逐条问题状态、预算、恢复
    │   ├── review-normalizer.js       # 解析/保留 findings、证据和稳定 id
    │   ├── acceptance-policy.js       # 不变量、世界观、逐条验收合同
    │   ├── cost-tracker.js            # 真实/估算费用与人民币预算
    │   └── quality-reporter.js        # 验收报告与阻塞事项
    └── ...（既有通用方案执行模块）
```

第一版**不应在 DSH 插件里再写一套正文数据库、全套修稿门禁与编辑器**。应让 `studio-adapter` 消费 Studio 受控接口产出的真实状态和证据，避免双边解释不同的“完成”。

### 7.4 工作流契约（建议新增，非现有真实端点）

**所有以下路径为新功能的接口设计草案，不是 v1.2.1 已存在的 API。**

```text
POST /api/novel/revision/closure-runs
  仅经作者认证的 Studio UI 发起
  入参：work_id、chapter_id、review_id、selected_issue_ids、base_hash、
        审批时确认的精确 scopes、预算和强制不变量
  返回：revision_run_id、author_scope_receipt、run_status

GET /api/novel/revision/closure-runs/:run_id
  返回：任务状态、逐条 issue 的证据和原因、费用、候选版本

POST /api/novel/revision/closure-runs/:run_id/verify
  在受控后台权限下触发候选复验，不能越权写章节

POST /api/novel/revision/closure-runs/:run_id/commit
  必须校验现有作者一次性审批、章节版本/哈希和完整授权
  不可由 DSH 凭通用“自动同意”指令代替 author approval
```

在服务端将运行授权绑定于 `work_id/chapter_id/review_id/selected_ids/scopes/base_hash/expire_at`，保存能力收据；模型不应通过读写日志或编辑 JSON 自行“创建批准”。本地 `AUTHOR_ONLY_WRITES`/CSRF/origin 保护保持不变。

如不想第一版新增写接口，可先实现**只读状态查询/回执接口 + 现有 UI 手动启动**，让 DSH 在用户真实触发后仅做“建议、监听、验收和汇总”。优先追求兼容，而不是先打通无条件自动写回。

### 7.5 自动协调器伪代码

```js
// 示例逻辑，不代表已验证的 DSH 0.2.0-rc.2 实际 SDK 方法名
async function runWritingQualityPlan(plan, studio, limits) {
  assertRealUserIntent(plan.trigger);
  const run = await studio.getAuthorApprovedRun(plan.revision_run_id);
  assertImmutableTargets(run.original_blueprint, plan);
  assertBoundScope(run.author_scope_receipt, run.base_hash);
  const deadline = limits.maxRounds ?? 3;

  for (let round = 0; round < deadline; round++) {
    const current = await studio.getStatus(run.id);
    if (current.state === "PERSISTED_VERIFIED") return success(current);
    if (current.state === "AWAITING_AUTHOR_COMMIT") {
      return partial("候选稿已验证，等待作者按现有权限流程合并", current);
    }
    if (current.state === "NEEDS_SCOPE" || current.state === "NEEDS_APPROVAL") {
      await recordBlockedItems(current);
      if (!current.hasIndependentWork) return blocked(current);
      await studio.advanceIndependentAuthorizedWork(run.id);
      continue;
    }
    if (!hasReliableBudget(current.cost, limits)) {
      return partial("模型或支付成本无法可靠控制，停止收费步骤", current);
    }
    await studio.advanceOneAuthorizedRound(run.id);
    // Studio 内部完成补丁、门禁、独立语义验收、证据回填
  }
  return partial("质量闭环轮次已达上限；保留可恢复状态", await studio.getStatus(run.id));
}
```

**关键点：外层 DSH 避免与 Studio 自己的长文本分段驱动、Goal driver 同时反复重发相同修稿任务**。一次运行保留一个 `revision_run_id` 和唯一推进者；如果由 DSH Goal 管理外层轮次，Studio 负责自己的内部原子阶段，不能相互启动新的独立无限循环。

### 7.6 映射成 DSH 任务节点

| DSH 子任务 | 完成条件 | 失败时 |
|---|---|---|
| A. 读取审稿与勾选 | 有 review_id/selected_ids/底稿 hash | 等待真实作者选项，其他独立任务继续 |
| B. 证据定位 | 每个 selected finding 有完整只读证据和合法编辑目标 | `NEEDS_SCOPE`，不能臆造 |
| C. 生成修稿候选 | 局部补丁按原项目协议生成 | 规范化 JSON 重试 |
| D. 安全门禁 | 组合校验与授权均通过 | 按门禁原因精确修复，不绕过 |
| E. 语义验收 | 每条必要问题 `ISSUE_VERIFIED` | 未通过按范围定向复修 |
| F. 保存/合并 | 真实作者一次性审批、保存成功、版本匹配 | `WAITING_AUTHOR_COMMIT` |
| G. 最终汇报 | 必要任务都已验证、无失实状态 | `PARTIAL`，列未完成原因 |

### 7.7 与其他插件共享状态的原则

- Novel Studio 独占章节正文/修稿授权/作品设定数据库的写入权。
- Auto Plan 独占“自动方案执行”任务队列和汇报进度，不直接修改 Studio 原始审稿勾选记录。
- Confirmation Resolution 独占正式 C 编号确认账本；写作审稿 checklist 不是正式 C 项，**不得把每一条审稿问题伪装为 C1/C2**。
- 真正需要作者本人确认的写回/权限仍走 Studio 作者审批，不用泛化“自动同意”提示词代替。

---

## 8. 与 `dsh-confirmation-resolution` 的兼容边界

之前已确定的规则**保持不变**：

1. DSH 正式主任务结束、真正发布 C1/C2/...、插件真实 `register` 后，用户**真实回复**相关问题，才由确认插件进入 `decide`。
2. 普通小说修稿勾选项属于 Novel Studio 的**作者编辑授权**，不是 Confirmation Resolution 的正式 C 项。
3. Auto Plan 不伪造确认编号/用户回复、不调用不存在的 V2、不修改 Confirm ledger。
4. 如果自动写作质量验收产生“是否改世界观”的决定，应优先遵守原蓝图/作者真实授权；只是写作建议时保留为待作者事项，不强迫另一个插件裁决。
5. 两插件加载后必须测试工具注册、事件来源、Goal 轮次、会话 C 项隔离。必须使用本机实际适配版接口；无需纠缠原 Confirm 仓库旧 README 的 DSH 版本说明。
6. `dsh-auto-plan-executor` 只接收**公开能力可发现的**确认插件状态/工具；不要导入其内部 ledger 私有模块。

---

## 9. 进一步增强创作质量的建议

### 9.1 高收益优先级 P1

**（1）角色/道具状态链时间线检查**  
把“检测单折数”“物件位置”“手掌压痕”“谁什么时候进/出检测通道”建成轻量事件链。状态迁移要有正文证据；“展开过”不自动等于“重新折两折”。防止前后自洽问题逃过自然语言模型。

**（2）权威世界观词条优先级**  
建议优先级：当前作者明确批准的章节蓝图/修订决定 ＞ 已锁定设定词条（版本化）＞ 人物角色卡/既定事实 ＞ 审稿建议 ＞ 修稿模型自行推断。若蓝图和词条本身冲突，应标记 `CANON_CONFLICT` 供作者处理，不能悄然修改其中之一。

**（3）跨章节伏笔保护**  
把“0731 与伏笔 #35”“林清雪拢袖口与掌心”“石面余光”“SS 异象术语”等登记为**待核验**，不能为了去除重复/AI 味而误删。只读相关元数据可以进入 `must_keep`，但不要把所有暗示都当作“已确定伏笔”。

**（4）模式化结构检测**  
不只扫 AI 腔词语；检测连续场景采用同一模板（按石→颜色→等级→职业→群众反应），在保留首次详细演示的前提下，后续突出**新信息/新后果**。这属于语义风格项，不能靠简单字符串计数判必错。

**（5）主角能动性与商业钩子评分**  
用定性问题而非虚假的绝对分数：主角是否有明确目标、是否做过体现其性格的选择、世界观异常是否被感知、章尾悬念是否承诺独特冲突。模型评分必须包含正文证据；只有“建议”而非强制修改，不得违背章节蓝图。

**（6）重复反应功能分类**  
对群演反应标记“新信息/转折/人物关系/社会反馈/纯重复”；优先删纯重复且获准的跨度，保留能对比A级和D级待遇的最强一笔。

### 9.2 效率与稳定性 P1/P2

- **模型输出事实验证**：AI 判断“修好了 #2”时，必须附核验前/后位置和具体证据；不可只自述。
- **审稿建议聚类去重**：把同一原问题的多个表述合并成唯一 ID；避免8条里实际只有5个独立问题但重复修5次。
- **不变量回归守卫**：每次局部修改后复核人物/世界观/伏笔/章节蓝图；一处解决但破坏别处则回退当前候选。
- **复杂问题自动降级**：普通拼写/物件矛盾优先规则；跨设定冲突走强验证；纯审美问题优先建议而非无休止反复改写。
- **预算可视化**：每轮模型调用、预估费用/实际费用、语义复审次数分开，防止长文本复修超支。
- **按问题维度差分 UI**：显示“修前证据 → 允许改的跨度 → 实际补丁 → 修后依据 → 是否真的解决”，支持折叠详细审计。
- **前端更准确提示**：禁止以绿色 “已全部修好” 表示只有补丁安全通过。
- **审稿版本快照**：审稿针对底稿 hash；当前章节被编辑后，旧授权不能直接套新稿。
- **基于真实作品数据的脱敏回归夹具**：将此“0731章”的8条缩成合规小样本，公开测试无需真实整章文本。
- **单次 writer/单次 commit**：质量验证并发可读；提交写回按 `chapter_id` 串行锁和 compare-and-swap。

---

## 10. 关键接口与数据契约

### 10.1 每条问题状态建议

```json
{
  "issue_id": "R-0002",
  "selected": true,
  "scope_status": "AUTHORIZED|NEEDS_SCOPE|REFUSED|PROTECTED",
  "patch_status": "NOT_ATTEMPTED|GENERATED|APPLIED|BLOCKED|NO_OP",
  "safety_status": "NOT_RUN|PASS|FAIL|UNAVAILABLE",
  "semantic_status": "NOT_RUN|PASS|FAIL|NEED_CONTEXT",
  "final_status": "UNRESOLVED|PARTIAL|ISSUE_VERIFIED|AWAITING_AUTHOR_SCOPE|CANON_CONFLICT",
  "attempt_count": 1,
  "reason_code": "FIELD_ROLE_MISMATCH",
  "evidence_refs": [],
  "base_hash": "sha256...",
  "candidate_hash": "sha256..."
}
```

同一个问题允许多个 patch 和多个只读 evidence。**绝不可用 `patch_status=APPLIED` 推断 `final_status=ISSUE_VERIFIED`。**

### 10.2 整体状态判定（示意）

```js
function closureVerdict({ selectedIssues, safetyPassed, canonPassed, persisted }) {
  if (!safetyPassed || !canonPassed) {
    return { status: "BLOCKED", reason: "safety_or_canon_not_verified" };
  }
  const unresolved = selectedIssues.filter(x => x.final_status !== "ISSUE_VERIFIED");
  if (unresolved.length) {
    return { status: "PARTIAL", unresolved_ids: unresolved.map(x => x.issue_id) };
  }
  if (!persisted) {
    return { status: "VERIFIED_CANDIDATE", reason: "awaiting_author_commit_or_persistence" };
  }
  return { status: "PERSISTED_VERIFIED" };
}
```

注意：`selectedIssues` 只包含用户真正勾选并要求修复的事项；**未勾选不计为当前修稿失败**。但对强制世界观、数据安全等系统不变量，即使未勾选仍不应允许自动认定“满足全部定稿门槛”。

### 10.3 简化数据库表（建议采用迁移，不直接覆盖现有表）

```sql
CREATE TABLE IF NOT EXISTS revision_closure_runs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  budget_cny REAL NOT NULL DEFAULT 2,
  actual_cost_cny REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revision_closure_issues (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  selected INTEGER NOT NULL,
  scope_status TEXT NOT NULL,
  patch_status TEXT NOT NULL,
  semantic_status TEXT NOT NULL,
  final_status TEXT NOT NULL,
  reason_code TEXT,
  evidence_json TEXT,
  PRIMARY KEY (run_id, issue_id),
  FOREIGN KEY (run_id) REFERENCES revision_closure_runs(id)
);
```

实际仓库可能已有审批/版本/事件表，开发时必须检查 SQLite schema 和迁移设施，避免撞名/重复落表；`budget_cny REAL` 仅是草案，生产中的收费计算建议用**整数分**或定点货币精度并显式标注货币与计费渠道，避免浮点比较造成超限。

### 10.4 同步性和成本

- 每次复修操作必须使用 `run_id + round + issue_id + base_hash` 幂等键。
- 审稿、候选、语义核验分别记成本；未知费用不能当0。
- 提供 user cancel，在安全点停止，不让外层 DSH 继续触发相同 run。
- 后台运行如遇用户改正文，则触发 `BASE_STALE` 并停止本次自动写回。
- 并发仅处理无副作用的读/分析；章节写回串行。
- 旧任务恢复时核查提交结果与版本，避免重复扣费、重复覆盖和重复作者审批。

---

## 11. 应修改哪些文件，按什么顺序开发

**下列路径来自公开源码；新路径是建议创建，不代表目前已存在。**

| 顺序 | 目标文件/模块 | 修改内容 | 成功条件 |
|---|---|---|---|
| P0-1 | `public/app.js` → `buildAIReviewPrompt()` | 默认生成结构化 `findings[]`/多证据/验收标准，兼容旧 `issues` | 每条修稿问题能找回证据或明确报缺失 |
| P0-2 | `public/app.js` → 审稿解析与展示 | `review_id`、issue ID、勾选集持久化及显示 | 勾选不丢、未勾选不受影响 |
| P0-3 | `public/revision-plan.js` | 多只读 evidence + 多获准热点 + 原子组；保留旧接口 | 跨位置问题可以安全整体计划 |
| P0-4 | `public/revision-plan.js` `planAuthorization()` | issue→授权热点数组；严格一一授权 | 不能越权编辑其他位置 |
| P0-5 | `public/revision-patch.js` | 新授权结构对接现有校验、组合门禁与覆盖表 | 不降低现有安全测试通过率 |
| P0-6 | 新增 `revision-semantic-verifier`（位置按项目分层确定） | deterministic + semantic 检查 | `semantic:not_run` 不得 resolved |
| P0-7 | 新增 `revision-closure` 服务/状态存储 | 轮次/预算/逐项状态/恢复/审批边界 | 失败可追踪，无重复提交 |
| P0-8 | `public/app.js` → `refineByChecklist`/`showReviewDiff` | 展示“补丁、语义核验、入库”三个状态 | 不再把补丁数量当修复数量 |
| P0-9 | `harness-plugins/novel-writing/novel-tools.mjs` | 仅增加受控只读状态/回执能力，必要时注册合规新工具 | 原一次性作者审批逻辑不变 |
| P0-10 | `dsh-auto-plan-executor/lib/writing/*` | 质量协调器 + Studio 受控适配器 + 报告 | DSH 能推进不依赖人工的任务 |
| P1-1 | 世界观/角色/伏笔检查模块 | 道具状态、词条字段、一致性、伏笔保护 | 0731回归样例通过 |
| P1-2 | 语义验收策略/提示 | 节奏、AI模板感、叙事功能评估 | 可解释、保守、可复验 |
| P2-1 | UI 分组质量面板 | 每问题证据链和失败可操作提示 | 使用者清楚原因及下一步 |

**非常重要的顺序**：先修审稿输出契约和准确反馈，再增加语义复验，最后引入自动复修与 DSH 轮次联动。否则自动驱动只会更快、更多次地重复既有漏修。

---

## 12. 必须通过的回归测试矩阵

| ID | 测试用例 | 预期 |
|---|---|---|
| R-01 | 审稿返回只有旧 `issues[{text}]` | 兼容显示；无证据时明确 `EVIDENCE_MISSING` |
| R-02 | 审稿返回 `findings[].evidence` 两个跨度 | 两处都记录为只读证据，只对获授权目标写入 |
| R-03 | 同一原文引用多次出现 | `AMBIGUOUS_ANCHOR`，不猜第一次 |
| R-04 | 用户勾选 #1，但未勾选 #2 | 只编辑 #1 的授权位置 |
| R-05 | #1 两折/一折冲突仍存在 | 即使应用过补丁也不得 `ISSUE_VERIFIED` |
| R-06 | #1 用合规局部修改处理，动作链自洽 | 语义与安全检查通过 |
| R-07 | #2 把“基础战斗能力”错填职业栏 | 必须失败；不能靠删除该短语蒙混 |
| R-08 | #3 D级口径与词条不一致 | 定位真实不一致或标记词条冲突 |
| R-09 | #4 四次检测规则重复 | 语义复验能指出仍存在的重复，而非只看旧引文 |
| R-10 | #5 两个A级与百万分之一稀缺度 | 不可擅改蓝图；确有冲突时标 `CANON_CONFLICT` |
| R-11 | #6 改掉两处群众反应 | 仍核验叙事功能，不冒充全部通过 |
| R-12 | #7 只删摸兜动作 | 如果审稿要求处理多个重复动作，仍应为 `PARTIAL` |
| R-13 | #8 删“细白的手腕”保留动作 | 可完成局部问题验收 |
| R-14 | `condense` 未授权 | 不自动使用 condense/越界连段压缩 |
| R-15 | 部分跨度受保护 | 不能破坏保护内容；报告阻塞 |
| R-16 | 补丁过安全门禁但语义核验没跑 | 显示 `NEEDS_REVIEW`，不能全部完成 |
| R-17 | 模型报告已修而正文没变化 | 按实际 diff 判无修改或失败 |
| R-18 | 一条补丁 gate blocked | 其它独立已获准补丁可继续 |
| R-19 | 通过一轮修后又在二轮回归 | 已通过项转待验，不强行保留历史 PASS |
| R-20 | 预算上限（单笔/累计 2 元） | 不超限、不拆单；未知计费不能宣称0元 |
| R-21 | 作者没同意提交 | 只展示 VERIFIED_CANDIDATE，不写入作品库 |
| R-22 | 旧 snapshot/hash 与当前正文不符 | 返回 `BASE_STALE` |
| R-23 | 恢复执行时相同 run 被重放 | 不重复付费与写回 |
| R-24 | DSH内部消息标题含“方案” | 不触发新的外层自动计划 |
| R-25 | 两插件同时加载 | Confirmation 正式 C 流程和 Studio 勾选项互不污染 |
| R-26 | 正式 C1 未经用户真实回复 | 不能从写作闭环伪造 `decide` |
| R-27 | SS异象、0731伏笔、掌心动作被列保护 | 不能为了去 AI 味误删 |
| R-28 | 单章全部已授权问题通过且作者审批写入成功 | `PERSISTED_VERIFIED` + 真实证据 |
| R-29 | 全部补丁被拦或未定位 | `BLOCKED/PARTIAL` 而非成功 toast |
| R-30 | 分段修稿/长文本片段 | 全章 ID 一致、证据范围不串段、最终全章复验 |

### 12.1 为当前正文构造最小回归夹具

**fixture** 示例（运行前将实际可用于测试的原文摘录放入测试输入，防止测试误用生产 DB）：

```json
{
  "name": "0731-review-repair-closure",
  "source_version": "novel-studio-v1.2.1",
  "required_selected_ids": ["1", "2", "3", "4", "5", "6", "7", "8"],
  "assertions": [
    "结尾检测单与开头状态及中途动作链一致",
    "基础战斗能力不是职业方向栏值",
    "D级官方评价与确定版世界观词条一致",
    "检测机制完整说明不会无意义重复四次",
    "稀有A级两连不得违背蓝图且有异常性解释或经作者决定",
    "无功能群众反应经过合理压缩",
    "无信息动作重复减少且不损伤人物真实感",
    "林清雪动作不含细白的手腕模板形容",
    "系统首次绑定台词仍只在章尾出现一次",
    "审稿外未授权片段逐字不变"
  ]
}
```

为了测试真实修稿链路，建议另建两个 fixture：
- **只勾 #8**：必须只能碰相关局部，不能顺手改 #1–#7；
- **全部勾选，但关键跨度未授权**：应出现 `NEEDS_SCOPE`，其他条仍可工作，不能强行扩大全章。

---

## 13. 目标环境检测、开发验证与双插件联调

> 本章在目标 DSH / Novel Studio 主机上执行；本方案写作环境无法访问用户本地运行实例，**以下均为待执行步骤，不代表已经完成联调**。

### 13.1 环境前置检测

1. 确认 DSH 命令对应安装为 `0.2.0-rc.2`，以真实启动路径和 profile 为准。
2. 确认 Novel Studio 本地 `package.json` 为 `1.2.1`，记录 **Git commit SHA、Git status、未提交改动**。
3. 检查 `node -v`、`git --version`、SQLite 数据文件路径、读写权限。
4. 核对实际前端 `public/app.js`、`revision-plan.js`、`revision-patch.js` 是否与本方案检视的公开源码相同；不同之处先做 diff。
5. 检查作者实际勾选记录、修稿候选结果、DB 历史版本和运行日志（确保不输出密钥/全文敏感内容）。
6. 确认 `dsh-confirmation-resolution` 实际已适配并在对应 profile 正常加载；旧仓库说明不作为升级理由。
7. 确认 `dsh-auto-plan-executor` 是否已存在。如果尚未开发，将其接入列为开发任务，而非假定能调用。
8. 先新建**隔离测试作品与数据库快照**，不要在这篇小说的真实章节上跑自动写回故障注入。

### 13.2 示例只读检查命令

```bash
# 在 Novel Studio 项目根目录
pwd
node -v
git rev-parse HEAD
git status --short
node -p "require('./package.json').version"

# 在真正使用 DSH 的相同终端
command -v dsh
dsh -V

# 测试命令以本机仓库 package.json scripts / scripts/ 为准：
# node frontend-test.mjs
# node scripts/ci-offline-checks.mjs
# 若相关脚本不存在或需私有数据，明确记录 SKIPPED/ENV_BLOCKED，不臆造 PASS
```

Windows PowerShell 使用 `Get-Command dsh`、`Get-Location`、`git`、`node`，并使用 PowerShell 管道；不要照搬 Bash 的 `command -v`。

### 13.3 实施阶段（按依赖执行）

| 阶段 | 任务 | 最终证据 |
|---|---|---|
| E0 | 记录环境、源码差异、实际勾选与现有日志 | `env-report.md`、`current-run-diagnosis.md` |
| E1 | 为 #1–#8 补 fixture 和原有测试基线 | `baseline-tests.json` |
| E2 | 统一结构化 findings 契约与保守兼容 | 测试 R-01/02/03 |
| E3 | 多证据、受控多热点计划与授权表升级 | 测试 R-04/05/14/15 |
| E4 | 逐条确定性/语义独立验收 | 测试 R-06..13/R-16/17 |
| E5 | 有界自动复修＋每轮成本与恢复状态 | 测试 R-18..23 |
| E6 | UI逐项证据链及明确的成功文案 | 用户可复现对照 |
| E7 | DSH 自动方案插件协调接入 | R-24/25 |
| E8 | Confirm 插件原流程回归 | R-26 和原 Confirm 官方测试 |
| E9 | 长文本、真实双插件集成、作者审批 | R-27..30 |
| E10 | 文档、回滚脚本、可交付包和最终报告 | 清单、日志、版本 SHA |

### 13.4 新旧行为对比的验收硬指标

- 没有丢掉原 Author approval、scope、protected spans、Gate、原子组核验、快照校验。
- 明确勾选集合的每条结果都可解释；`NOT_SELECTED` 不算漏修。
- 凡是 `ISSUE_VERIFIED`，都有具体审稿问题、候选差异、当前正文复核证据和语义判定。
- `semantic_status=NOT_RUN` 或 `safety_available=false` 时，不能 `PERSISTED_VERIFIED`。
- 对多位置问题，能够对原文本的全部相关证据做复核，但编辑仍限于作者批准的精确热点。
- 未获授权的必要问题不因 DSH 自动继续而自动放权。
- 真实写回必须通过原有作者审批及版本检查。
- 不存在 DSH Goal 与 Novel Studio 内部任务相互无限启动。
- 与 Confirmation 插件同时运行时，正式 C 项生命周期不受破坏。
- 可禁用新质量闭环回退到原有 v1.2.1 路径，原章节和历史版本不受不可逆破坏。

### 13.5 灰度与回滚

1. 新路径受 `revision_closure_enabled=false` 功能开关控制，默认关闭。
2. 先在隔离作品开放“只读诊断/语义验收”，不运行二次复修。
3. 再开放“生成候选修稿”，依旧不自动正式提交。
4. 最后在原作者真实审批模型下测试写回，并检查历史版本/回滚。
5. 任何安全越权、C账本污染、旧版修稿退化、二次扣费或目标误触发应立刻关闭新路径。
6. 回滚只卸载新插件的受控协作逻辑和 feature flag；**不修改已经正常工作的 Confirm 插件**，且保留经授权产生的章节修改历史供作者恢复。

### 13.6 成功、部分完成与阻塞

| 状态 | 含义 |
|---|---|
| `ALL_PASSED` | 必要新增测试通过、质量候选验收通过、真实作者批准写回并二次验证 |
| `PARTIAL` | 部分问题修好，其他被保护、预算、词条缺失或未通过复验阻挡 |
| `BLOCKED` | 必须授权、关键依赖/权限或安全门禁拒绝 |
| `ENV_BLOCKED` | 当前环境缺少源代码、权限、运行实例或测试前置 |
| `NOT_RUN` | 尚未执行 |
| `FAILED` | 实际已执行且测试/逻辑未通过 |

任何一条必须步骤仍为 `NOT_RUN/ENV_BLOCKED/FAILED` 时，禁止宣称“已完成源码修复并通过真实双插件联调”。

---

## 14. 给 DSH 的实施指令（可直接连同本文件交给 DSH）

```text
请依据本文件对本地 Novel Studio 1.2.1 实施“审稿→授权→局部修稿→
安全门禁→逐条确定性/语义复验→未解决项定向复修→候选确认→作者批准写回”
的质量闭环，并接入 dsh-auto-plan-executor 的写作执行路径。

一、先执行 E0 真实环境扫描并保存现场：
- DSH 0.2.0-rc.2、Novel Studio 1.2.1 的真实本地代码与 profile。
- 不把公开仓库 README 的旧版本说明当作安装障碍。
- 读取实际修稿 selectedIds、findings/evidence、scope/authorization、
  model patch、safety blocked、coverage、semantic verdict、合并/写回状态。
- 用本文的8条问题逐项还原未修复原因，不允许没有日志就断言“某个 Bug”。

二、保留所有已有授权、安全、不可变目标和一次性作者审批：
- 不修改旧 Confirm ledger，不伪造 C1/C2 或用户真实回复。
- 不因为一条问题被勾选就放开整章编辑。
- 不因模型说修好了就宣布通过。
- 不绕过非可跳过的安全门禁。

三、按 E1→E10 开发与测试：
- 优先统一结构化 findings + 多证据及验收标准；
- 在已授权范围内支持同一问题的多精确热点和只读跨段证据；
- 追加真实的逐条语义验收和有界复修，不以补丁数量代替修复项数量；
- 每轮记录真实费用，单次不超过2元，未明示其他总预算时累计不超过2元；
- 预算不可可靠确定时不擅自付费。
- 将新的 revision run 状态通过受控适配层接入自动方案插件；
  Novel Studio 仍对作者勾选、文稿和写回权限负责。

四、遇到失败：
- 可修的局部问题在预算、权限、轮次内重试；
- 需要新增受保护/未授权跨度、修改原蓝图、超预算、
  或真实作者一次性提交审批时，挂起受影响项，继续其他独立工作。
- 达到上限诚实报告阻塞，不把候选稿称作正式写回。
- 绝不以扩大改写范围、取消门禁或伪造确认来追求“100%修复率”。

五、执行结束时统一交付：
- 实际修改文件/提交、具体问题根因、所有测试结果、
  回归用例的 PASS/FAIL/NOT_RUN、联调记录、费用、
  仍未完成事项与下一步必要人工动作。
- 全部必要验收通过前，不宣布已完成。
```

---

## 15. 关键源码链接与核验限制

### 15.1 已检查到的公开源码（分支：`Experimental-Version-v1.0`）

- 项目根目录：<https://github.com/bbaz123/novel-studio>
- 1.2.1 版本依据：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/package.json>
- 审稿提示词 `buildAIReviewPrompt`：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L10583-L10589>
- 审稿勾选 / `refineByChecklist`：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L10909-L11209>
- 有界格式重试：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L11470-L11483>
- 语义验收显示目前 `semantic:null`：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L11848-L11859> 以及 <https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L12215-L12224>
- “已按清单改好 N 处”的 UI 文案：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L11190-L11198>
- 精准 EditPlan / 首个引文即停止 / scope / condense：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/revision-plan.js#L184-L257>
- EditPlan 授权映射：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/revision-plan.js#L339-L380>
- 补丁处理 `coverage_ok` 与 `issue_coverage`：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/revision-patch.js#L1745-L1767>
- 不允许旧引文消失就视作已修复 `coverageVerdict()`：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/revision-patch.js#L197-L239>
- Studio DSH 工具侧 `novel_chapter_save` 作者一次性批准：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/harness-plugins/novel-writing/novel-tools.mjs#L726-L735>
- `novel_approvals` 只读：<https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/harness-plugins/novel-writing/novel-tools.mjs#L1093-L1109>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- 既有待确认事项插件：<https://github.com/bbaz123/dsh-confirmation-resolution>

### 15.2 分析证据的边界

- **已确认（公开代码）**：结构化审稿契约较弱、每 finding 首个热点、`coverage_ok` 与语义解决分离、UI 语义核验未执行、原作者写回审批。
- **已确认（所给正文）**：八项审稿问题在修后存在已解决/部分处理/未解决的差异。
- **尚未证实（需本机抓日志）**：哪几项实际被勾选、每项具体门禁状态、是否发生模型 keep、真实运行 profile、修稿是否已入库、当次费用。
- **尚未执行**：对本地 Novel Studio 的源代码修改、运行测试、真实 DSH 和 Confirm 双插件联调。

> **最终建议**：先将 Novel Studio 的“逐问题证据链 + 语义验收 + 定向复修”升级成代码级事实，再让 DSH Auto Plan Executor 做外层任务编排。这样自动执行插件越主动，交付质量越高；否则只会把“找到但没改好”的问题更快速地重复。
