# implementation-report.md —— S01–S09 现状与修复（复现 → 修改 → 测试）

> 判定口径：`LOCAL_VERIFIED`（本地代码证据 + 真实跑过的用例）／`already_satisfied`（既有能力已满足）／
> `PARTIAL`（要求成立但有明确残留）／`blocked`／`not_run`。
> 纪律：**先写失败测试，再做最小修改**；既有能力已达标则不再造第二套实现。

## 0. 判定总表

| 风险 | 判定 | 一句话结论 |
|---|---|---|
| S01 扫描命中的要写进 issues | **LOCAL_VERIFIED（本轮已修）** | 提示词改为"候选信号 + 逐条判断 + `not_applicable` 出口 + counterevidence" |
| S02 清空前冻结 review_id | already_satisfied | `public/app.js:11211-11218` 已有；116E-d 覆盖 |
| S03 稳定 finding ID | already_satisfied | `issueStableId()` 用原始 ID；116E-c/e 覆盖 |
| S04 plan 失败不放宽整章 + context_only 分离 | already_satisfied | 严格计划 + 空授权表；E01-3* 全覆盖 |
| S05 双重授权 | **PARTIAL → 本轮硬化** | 平时已双重授权；`authorization` 缺省时曾静默降级 → 现 fail-closed |
| S06 重复原句判歧义 | already_satisfied（1 处窄残留） | `occurrences>1` 即 `ambiguous`；"独立成句 1 次 + 被长句包含"仍取首处（低危，未改） |
| S07 重试预算跨刷新共享 | already_satisfied | 落 `localStorage`，键=章号\|快照\|勾选集合；116E-j 覆盖 |
| S08 无自动整章回退 | already_satisfied（注释 PARTIAL） | 失败停下给显式选择；作者入口保留 |
| S09 结构化证据保全 | already_satisfied（配套增强） | `normalizeNarrativeFindings` 保全 evidence/counterevidence/verdict/span；本轮补提示词字段说明 |

---

## 1. S01｜扫描命中只提出疑点，不强制修稿（E01 §5.1）

### 1.1 复现（改前）

`public/app.js` 的红线扫描块写的是：

```text
要求：AI 腔相关的问题必须与上面的扫描结果一致——扫描命中的要写进 issues 并指出位置；
扫描零命中就不要臆造"存在 AI 腔命中"。
```

后果：一份**字面词表统计**被升格成文学缺陷。`微微` / `嘴角` / 连续否定在正常叙述里大量合法出现，
扫描器无从判断"这一处是否伤害了阅读效果"，但旧措辞要求它们必须出现在 issues 里。

### 1.2 失败测试（先红）

`tests/narrative-repair/11-review-closure.test.mjs`：

- **T02-a**：合法语境 `她微微侧过身，让出了一条路。` → 确定性层 0 候选（扫描层不把词命中当缺陷）。
- **T02-b**：模型把该命中判为 `not_applicable` 时，报告里**必须保留**这条（`accepted=1`），不得被强制升格成 issue。
- **T02-c**：`not_applicable` 不进 `auto_eligible`（候选 ≠ 授权）。

`frontend-test.mjs`：

- **S01-a**：提示词含"候选信号"，且**不再**含"扫描命中的要写进 issues"。
- **S01-b**：含 `not_applicable` 出口与"逐条判断/不成立"要求。
- **S01-c**：含 `deferred` 与 `counterevidence`。

未改代码时，S01-a/S01-b 为红（当时的措辞里没有"候选信号"，`not_applicable` 只出现在
`FINDING_VERDICTS` 白名单而不是提示词里）。

### 1.3 修改（最小）

只改**一处**提示词段落（`public/app.js:10980-10990`），把它拆成三条明确口径：

```text
要求：上面每条只是候选信号，不是"必须报的问题"。逐条判断——
① 成立：写进 issues，并给出准确原文位置与伤害了哪种阅读效果；
② 不成立（比如「微微」是正常程度副词、否定句承担悬念或排除外部声源的功能）：写进 deferred 或
   直接写 verdict:"not_applicable"，不要为了"命中过扫描"而硬报；
③ 判定不成立时说明理由（counterevidence）；扫描零命中就不要臆造"存在 AI 腔命中"。
issue 里带 signal_hit（对应的扫描条目，没有就留空）与 verdict（confirmed / hypothesis /
not_applicable）时更有用——但不要为了填字段而把合法用法报成问题。
```

**没有**新增模块、没有改动扫描判据本身（`ai/editing/scan.mjs` 未动）。

### 1.4 结果

| 用例 | 结果 |
|---|---|
| T02-a / T02-b / T02-c | 通过 |
| S01-a / S01-b / S01-c（frontend） | 通过 |

语义边界仍是 `semantic_status: 'not_run'`：确定性层**从不**宣称"叙事诊断已完成"。

---

## 2. E01 §5.2｜报告的优点与问题不得互相矛盾

### 2.1 复现

任务书 §1.3 给出两处真实矛盾：

- 优点称"0001号之后的同类机制不再完整演示"，问题却说"0372号仍然把完整流程又演了一遍"；
- 优点称"林清雪的伏笔完全没有解释"，正文里却有 `他从小就觉得，人拿到一样东西时手会先紧一下。`。

模型不会自己发现——它两次都用绝对措辞。

### 2.2 失败测试（先红）

- **T05-a**（**2026-10-11 契约修正**）：绝对化 strength + 同话题 issue → **`status` 保持 `ok`，只进 `advisories`**，
  且 note 明确说明"不据此宣称矛盾"。原来的断言（要求 `needs_calibration`）属**旧契约**，已按新契约改述。
  修正理由：该检测器在 **12 份真实历史报告上误报 6 份**（裸 `不` 被当成绝对措辞），
  且收紧到话题重叠系数后合成正例又漏报 ⇒ **字面重叠无法证明语义矛盾**。
  详见 [verify-round-20261011.md](verify-round-20261011.md) §2。
- **T05-b**（**假阳性回归**）：「不靠旁白建体系」这类正常描述不得被当成绝对措辞、也不得与无关问题配成矛盾。
- **T06-a**：strength 称"完全没有解释"、正文含解释句 → `needs_calibration`，且**给出反例引用**。
- **T06-b（阴性对照）**：strength 谈排队布景、issue 谈结尾重复（不同维度）→ **不得**报矛盾。

未改代码时 `consistency` 字段根本不存在 → 三条全红。

### 2.3 修改（最小、不新增模型轮）

`ai/editing/narrative-review.mjs` 新增纯函数 `checkReportConsistency`（`:257`）：

1. 只在优点出现**绝对/穷尽**措辞时检查：`不再…`、`(完全|彻底|根本)?(没有|没|无|不)`、`零(解释…)`、`(从未|毫无…)`；
2. **与 issue 打架**：要求两边**共享实词**（2-gram 去停用词）→ 判定为同一话题，才报 `strength_vs_issue`；
3. **与正文打架**：strength 明确在说"解释/说明/交代"且正文存在带解释性连接词的句子 → 报 `strength_vs_body`
   并**给出那句原文**（`evidence`）。

> 为什么 ② 要共享实词、③ 不共享：② 谈的是同一处内容（"不再重复" vs "重复了"），必须同话题；
> ③ 谈的是"有没有解释"这一**元概念**，而解释句写的是内容，两者本就不会共享实词。

每条返回路径统一附加（`:326` 的 `withConsistency`），避免"只有一部分报告带自洽检查"。
落库无需迁移（`saveReview` 把整份 structured 写进 `report_json`，`server.js:4191-4208`），
API 回带 `consistency` / `consistency_conflicts`（`server.js:9052-9054`），界面显示**具体**矛盾
（`public/app.js:11182-11202`）。

### 2.4 结果

| 用例 | 结果 |
|---|---|
| T05-a / T06-a / T06-b | 通过（19/19 全绿） |

---

## 3. E01 §5.3｜两类新诊断：场景反应因果 / 视点信息越界

### 3.1 需求

- `reaction_causality`：D 级本来常见、观众反应平淡，主角 D 级却让"打盹的考生全都停住了"；
  要判断是否夸大、是否已有剧情依据。
- `focalization_limit`：手按一下石板就断言"密度比普通石头高"；隔着队伍却知道李拓"掌心还残留余温"。
  角色特殊感知**未获准**时只提疑点，不新增天赋。

### 3.2 设计约束与调参过程（这是本轮最容易写坏的地方）

新判据必然需要少量语法标记（量词、触觉动词、距离词），无法用字符 n-gram 表达。为避免
"加了新诊断 → 既有阴性对照变红"，先写一次性探针
`.narrative-repair-116/probe-perception-candidates.mjs`，在**全部 18 个既有目标文本**上量误报：

| 探针迭代 | 观察 | 处置 |
|---|---|---|
| v1 | 冻结样本误报 2 条：`动作跟前面所有人都一样`、`候检大厅里没声了` | 全体量词必须出现在**分句开头**；全体反应必须带"停住/静/愣" |
| v2 | M02（触觉→密度）**漏报** | 改为同段内触觉动词与"触觉得不到的性质"邻近（≤40 字）匹配 |
| v3 | F08 仍漏报 | 语境窗口改用**原始文本切片**（句末为逗号的从句不会被丢弃） |
| v4 | F08 仍漏报 | 根因：`SPECTACLE` 里的裸 `级` 命中了 `他的成绩是C级` → 去掉裸 `级` |

最终：**18 个既有目标文本误报 0 条**，F08 / M02 / M03 三个计划形状全部命中。

### 3.3 失败测试（先红）

- **T21-a/b**：F08 形状 → 出 `reaction_causality`，带准确引用、反证通道、`requires_semantic_check: true`。
- **T21-c（阴性）**：真正奇观（S 级异象光柱）引发的全场静止 → **不得**出候选。
- **T22-a/b**：触觉→密度、隔队伍→余温 → 出 `focalization_limit`，证据里写明触觉/距离。
- **T22-c**：候选只提疑点——带反证、**不带 delete**、不出现"新增/赋予/获得能力"。
- **T22-d**：两类已登记进 `DIAGNOSTICS`（口径可对账）。

### 3.4 修改

`ai/editing/narrative-scan.mjs`：

- `DIAGNOSTICS` 增加 `reaction_causality`、`focalization_limit`；新增导出 `PERCEPTION_DIAGNOSTICS`；
- `DIAGNOSTIC_META` 为两类写明 question 与 counterevidence（含"有意舞台化描写""已确立特殊感知"等反证）；
- 两个判据函数（`:186-244`），产物统一走 `pushCandidate` → 一律带 `counterevidence_hint`、
  `requires_semantic_check: true`、`suggested_action: 'check'`；
- 段落 < 2 时显式 `insufficient_data`（不硬判）；
- 版本号 `1.0.0 → 1.1.0`。

**没有**改动 `ai/editing/scan.mjs`；**没有**建立第二套扫描器。

### 3.5 结果

| 用例 | 结果 | 既有套件 |
|---|---|---|
| T21-a/b/c、T22-a/b/c/d | 通过 | `04-narrative-scan` 24/24、`10-new-sample` 12/12 **未回归** |

---

## 4. S05-1｜期望 v2 却缺授权表：从静默降级改为 fail-closed

### 4.1 复现（真实 fail-open 形状）

`public/revision-patch.js` 的位置解析是：

```js
} else if (opts.authorization) {   // ← authorization 为 null/undefined 时整块跳过
```

于是当调用方**没有**传授权表时：

- 第①重授权（`issue_ids ⊆ 已选`）仍然生效；
- 第②重授权（"该 issue 是否授权了这个确切跨度/操作"）**整块被跳过**，位置改为采信模型自报的
  `span_id` / `span:{start,end}`。

这正是任务书 §6.3 禁止的"把'跨度在本章存在'当作'这个 issue 有权改它'"。现实可达路径：
`public/app.js:5117-5121`（刷新后"接回进度"）不传 `authorization` → `public/app.js:12299` 传 `null`。

### 4.2 失败测试（先红）

- **T31-a**：`expectedSchemaVersion: 2` 且**不给**授权表 → 必须失败，`error_code === 'out_of_scope'`
  且错误里带 `authorization_required`。
- **T31-b**：fail-closed 时正文**逐字不变**。
- **T31-c（阴性对照）**：给等价授权表后同一作业**正常通过**（不能把正常路径一起拦掉）。
- **T31-d（兼容）**：不声明 `expectedSchemaVersion` 的历史调用仍走原语义。

改前 T31-a/T31-b 为红（`ok===true`，补丁被应用）。

### 4.3 修改

新增错误码并在**规划之前**拒绝（`public/revision-patch.js:61 , 1414-1427`）：

```js
AUTHORIZATION_REQUIRED: 'authorization_required'
...
if (Number(expectedSchemaVersion) === SCHEMA_VERSION && !authorization) {
  return { ok:false, error_code: ERROR_CODES.OUT_OF_SCOPE, mode: decoded.mode,
           errors: [{ code: ERROR_CODES.AUTHORIZATION_REQUIRED, ... }],
           text: baseText, applied: [], unresolved: [], coverage: [], noop: false };
}
```

只对**期望 v2 的作业**生效；历史（非 v2）语义保持原样，避免破坏存量兼容路径。

### 4.4 结果

| 用例 | 结果 | 既有套件 |
|---|---|---|
| T31-a/b/c/d | 通过 | `01-patch-protocol` 65/65、`08-authorization` 26/26 **未回归** |

---

## 5. E03｜篇幅超限与结构重复：从"泛化建议"到受控计划

### 5.1 already_satisfied 的部分

| 要求 | 现状 |
|---|---|
| 统一字数口径 | `wordCount`（`public/app.js:902`）/ `plainLength`（`:10490`）同源；`resolveTargetWords`（`:10523`）= 章节覆盖 > 作品默认 > 2000 |
| condense 默认关闭 | `ns_revision_allow_condense`，缺省 `'0'`（`public/app.js:11742`） |
| condense 只处理明确选中的连续跨度 | 计划层无 host 批准位即 `refused`（`05-revision-plan` E05 已覆盖） |
| 不允许自动扩大授权 / 回退整章 | 0 授权跨度即**不下发**付费修稿（`public/app.js:11297-11308`） |

### 5.2 本轮补上的：差异预览如实给出"字数与剩余差额"

改前 `showReviewDiff` 只显示"实际改好 N 处"——作者容易把"改了几处"读成"篇幅已达标"。

新增（`public/app.js:12442-12447` 计算、`:12465-12477` 渲染）：

```text
📏 正文 {before} → {after} 字（本次减少 N 字）；距本章目标 {target} 字仍差 {remaining} 字
（风格上限约 {style_max} 字）。本次只是局部改动：差额要靠作者继续选择可压热点
（或另行授权连续压缩）来补，不会自动扩大修改范围。
```

达标时改说"已达到本章目标"。差额**不驱动任何自动动作**，只如实呈现。

### 5.3 H01–H07 可审批子热点

见 `issue-coverage.json` 的 `hotspots`：每条带 `issue_id / exact_quote / span_id / suggested_action /
protected_facts / expected_compression_range / author_approved / dependency_group`。
`author_approved` 全部为 `false` —— 本轮**没有**任何作者批准，因此不产生任何 condense 授权。

### 5.4 三种任务出口区分

| 出口 | 状态 |
|---|---|
| 普通局部修稿（默认） | 已实现：只对已选热点 `replace/delete` |
| 连续跨度压缩（作者显式开启） | 已实现：`allowCondense` + Host 批准位；默认关闭 |
| 大结构重排 / 整章改写（新任务） | 已实现：`needs_structural_authorization` 语义 + 作者显式按钮 `long-text-retry-alt`；**不是**失败回退分支 |

### 5.5 测试

- **T41-a**：`allowCondense: false` 时 `condense` 请求 → `status:'refused'`（不静默降级成 replace）。
- **T41-b**：计划如实给出每个 issue 的 `status`，供界面显示"可定位/未定位/被拒"，不假装篇幅已修复。

---

## 6. 未修改项（避免超范围）

| 候选硬化项 | 为什么本轮不改 |
|---|---|
| S04-1：`buildAIRevisionPatchPrompt` 保留"未传 plan → 整章目录"分支 | 今天仅 probe 探测可达（不下发、不执行）；改动会触及分段提示词装配，超出本轮重点，记入 `final-summary.md` 的后续建议 |
| S06-1：`occurrences` 只看字面片段出现次数 | 窄残余（"独立成句 1 次 + 被别处长句包含"）；真正的两处同句已被拦住 |
| S08-2 / S04-2：三处陈旧注释（`app.js:11556`、`app.js:12246-12248`、`revision-patch.js:12`） | 仅可读性/可审计性，不改变运行行为；避免无关大范围改动 |

---

## 7. 本轮实际改动的文件

| 文件 | 性质 |
|---|---|
| `public/app.js` | S01 提示词；报告自洽界面；差异预览篇幅缺口 |
| `public/revision-patch.js` | S05-1 fail-closed（错误码 + 规划前拒绝） |
| `ai/editing/narrative-scan.mjs` | 两类新诊断 + 元数据 + 版本 |
| `ai/editing/narrative-review.mjs` | `checkReportConsistency` + 每条路径附加 |
| `server.js` | 审稿保存响应回带 `consistency` |
| `tests/narrative-repair/11-review-closure.test.mjs` | **新增**套件（19 条断言） |
| `frontend-test.mjs` | **新增** S01-a/b/c 三条断言 |
| `scripts/test-narrative-repair.mjs` | 登记新套件 + 同进程回退 |
| `docs/review-closure-116/*`、`.narrative-repair-116/*` | 证据与文档 |

未修改：`data/`、真实章节、角色卡、密钥、`harness-plugins/`、`ai/editing/scan.mjs`、`ai/editing/rules.mjs`。
