# Novel Studio：独立质量复核落地后的现场诊断与 P0 修复增量方案

> 日期：2026-10-22  
> 依据：本轮用户提供的三张真实界面/日志截图、修稿前后全文、六项审稿意见，以及公开 Novel Studio `Experimental-Version-v1.0` 分支的 `public/app.js`、`server.js`（核对时以实施机本地 checkout 为最终真源）。  
> 目的：**先保护已有正文和用户修改，再修正审计误报、复验漏判、失败项复修与跨版本覆盖风险。**  
> 本文是对原 `dsh-novel-quality-auditor` 完整方案的**实施后增量补丁**，不宣称实际本地工程已经按本文修改，也不以截屏代替真实验收。

## 1. 当前证据、确定结论与不能推断的内容

### 截图直接证明

- 独立审稿工作区已经被使用：有审稿清单、修稿候选、逐项验收、审阅与合并阶段。
- 工作区显示已选六项，其中四项 `已解决`、两项 `只解决局部`。未通过的是 `R-0005` 和 `R-0006`。
- 页面明确显示“候选未通过全部验收”，底部仍提供“合并到正文（仍有 2 条未通过）”操作。
- 日志中出现 `review_merge_overwrite`，目标是 work_id=18、chapter_id=119，`base_unreadable=false`。

### 源码可以确认

1. `public/app.js` 的 `issueStableId()` 在输入没有对象 ID 时仍退回列表序号；`revisionFindingsFor()` 包含结构化查找失败的 legacy 兼容路径，因此需要继续保留 ID 链回归。
2. `reviewWorkspaceContext` 从已完成的修稿裁决中构造逐项状态，`PARTIAL_CANDIDATE` 是受支持的非全通过状态。
3. `diff-merge` 会在部分通过时调用 `mergeReviewDiff()`；成功后把 `mergedUnverified` 标为真。**这说明“部分通过仍可由作者合并”是现有产品行为，不是模型把部分结果误当全部通过。**
4. `mergeReviewDiff()` 在 `baseFingerprint` 与当前正文不一致或读取失败时先报 `review_merge_overwrite`，**仍继续尝试整篇提交到** `/novel/adopt`。原注释明确说明：2026-10-06 的“点击合并必须执行”作者要求令此前基线防护降为告警。
5. `review_merge_overwrite` 警告位于真实 `/novel/adopt` 请求之前：**看到警告只能证明代码进入了准备强制覆盖路径，不能单独证明服务端已经写入成功。** 必须读取 `/novel/adopt` 结果、章节当前 hash 和历史版本才能确认。
6. 当前本地指纹是 `textFingerprint()` 的 FNV-1a+长度形式，只用于比较，不是服务端权威并发版本。服务端已有章节 `content_hash` 回包及版本历史相关基础，不需要把本地观测字符串当唯一并发真源。

### 无法从截图证明

- 为什么基线发生变化：是作者改动、编辑器自动保存、草稿/正式章节基准差异，还是 HTML/纯文本归一化不同。必须记录两边的版本与规范化 hash 再判断。
- 独立 DSH 插件是否对本轮完成 `final submit` 并通过 Novel Studio host 校验；报告还出现“上次独立复核 · 结果待主机校验”。
- 六项是否都拥有完整的 evidence/acceptance。报告提示“6 条缺字段”，但没展示缺失字段名与具体 item。
- 合并是否最终成功。不能仅凭 `review_merge_overwrite` 告警作成功结论。

## 2. 六项实际复核矩阵（固定成回归样本）

| Issue | 原目标 | 修稿观察 | 独立验收标准 |
|---|---|---|---|
| R-0001 | 校门口场景错乱 | 已换成检测中心门口 | 正文无误用“校门口”的场景位置；`PASS` |
| R-0002 | “多说了六个字”不准确 | 改成“念得比前面细” | 不再错误定量，保持 C 级原台词；`PASS` |
| R-0003 | 评定单被反复处理，折角作重复结尾 | 删除了后面重新抽出整理、折角收尾 | 还应检查“拉链头贴着红戳的位置”是否有清晰物理接触与叙事必要性；至少需要子条件逐项说明 |
| R-0004 | 重复群众叹息 + 主角放松的状态缺失 | 第一次重复叹气已压缩，第二次保留 | “群众重复”与“主角状态可见”是两个独立子条件；不能通过一个子条件就把整项直接 `ISSUE_VERIFIED` |
| R-0005 | 系统连续给相同的回避回答 | 只把一次回答改为“你问得太早” | 全部相同功能回合应重验；既要保留首次系统播报，也要保留数学卷死线；当前 `PARTIAL` 合理 |
| R-0006 | 钩子之后老太太/早餐铺/收尾过场拖慢节奏 | 部分压缩，但又重复“数学卷还等着他” | 终段须有新的推进而不是复述已有死线；当前 `PARTIAL` 合理 |

### 复核自身漏报的新候选

**具有明确逐字证据的道具位置矛盾：**

前文：“他把纸对折，再对折，折成四分之一大小，塞进校服裤兜。”

随后：“‘D。’岳宸炎晃了晃手里的东西。”

如果中间没有拿出评定单的动作，后者与“刚塞进口袋”不一致。独立复审应至少生成 `POSSIBLE_OBJECT_STATE_CONFLICT`，并给出两处证据，作为待作者确认的候选新增问题，不擅自改动未授权正文。

另有“耳机里安安静静的”值得核验：系统声音此前被描述为直接在耳边出现，正文并未明确说明主角佩戴耳机。它可以先标记 `NEED_CONTEXT`，不直接断言硬冲突。

## 3. 独立复核报告的误报与结构问题

### 3.1 反例与结论不是同一个命题

报告把“前面的平头男生一直在说话”当成“系统首次上线克制、没有让系统先解释自己”的反例。这是**逻辑上不相关的两件事**：

- 说话主体不同（平头男生 vs 系统）；
- 被检验的命题不同（是否解释系统机制 vs 有人说话）；
- “一直”一词不足以证明任何系统说明过量。

修复：独立复核新增一个 `claim_evidence_relevance` 检验层。

- 证据先验证逐字存在；
- 再验证 subject / predicate / negation / time / scope 是否对齐；
- 不相关：`INVALID_RELEVANCE`，不得呈现成“互相否认”；
- 无法判断：`ADVISORY_NEEDS_REVIEW`，不能据此降低整份报告质量评分；
- 有真实矛盾：同时引用命题与对应反例，且记录双方位置和来源。

### 3.2 “6 条缺字段”必须可定位

独立报告里不得只显示“6 条缺字段：证据保留但只作待核验”。

必须记录：

```text
audit_id
finding_id
field_path
expected_type
actual_type
source
error_code
severity
resolution_path
```

对每条缺字段显示在哪条 finding、缺哪个字段、是否可以免费重新解析、是否需要付费重新生成。结构问题不得静默转成正式修稿问题。

### 3.3 Host 验证是一道独立门禁

- `DSH process exited=0` 不等于已完成独立审核；
- `submit(final)` 成功 + schema/quotes/hash/coverage 通过才是 `HOST_VERIFIED`；
- 在 `HOST_VERIFIED` 前，工作区只能标注“独立复核待校验/结果不可作为完整凭据”。

## 4. P0：解决修稿合并的版本覆盖风险

### 4.1 问题与现有事实

当前 `primePendingReviewDiff()` 绑定 `baseFingerprint`，但源码注释明确规定只用于提示；`mergeReviewDiff()` 不把 mismatch 作为阻断。这样作者在预览之后继续修改正文时，可以把后来的修改整体覆盖成几分钟前的候选。

该设计是旧需求下的有意行为，**不是“日志发出所以插件坏了”**，但在“独立复验 + 多轮候选 + 作者可继续编辑”的新工作区里，覆盖风险明显提高。

### 4.2 推荐改造：显式区分三个作者操作

- **普通合并**：基线一致时原子写入；基线不一致返回冲突，不偷偷覆盖。
- **重新基于当前正文计算**：在新的正文上重建候选、重跑安全与全项验收；合法的互不相交修改可以三方合并。
- **明确强制覆盖**：如果作者确实要用旧候选替换新正文，提供单独、二次明确的覆盖动作；强制覆盖前先保存当前版本，记录 `source_hash`、`target_hash`、用户操作与审计记录，且不把未通过项标成已修复。

这样可以保留作者最后裁决权，又避免普通“合并”动作默认吞掉新的编辑内容。

### 4.3 数据契约与服务端原子闸门

服务端应在事务内比较实际当前版本与提交的 expected base，至少包含：

```json
{
  "chapter_id": 119,
  "candidate_hash": "<hash of candidate>",
  "verified_candidate_hash": "<hash checked by final auditor>",
  "expected_chapter_hash": "<server hash captured at run creation>",
  "expected_chapter_updated_at": "<server version captured at run creation>",
  "mode": "normal|rebase|explicit_force",
  "operation_key": "<stable idempotency key>",
  "unresolved_issue_ids": ["R-0005", "R-0006"]
}
```

规则：

1. 普通合并：`expected_chapter_hash !== current_chapter_hash` → HTTP 409 `REVISION_BASE_STALE`；**同事务无写入**。
2. `candidate_hash !== verified_candidate_hash` → 409 `REVISION_VERIFICATION_STALE`，即使旧验收为 PASS 也不能采用。
3. 三方合并后所得的新候选 hash 必须重新走终验；不得沿用旧 `HOST_VERIFIED`。
4. 明确强制覆盖：要求另一个专用操作与完整审计事件，且在事务内先备份冲突正文，写入、历史记录、提案入账与 outbox 原子处理。
5. 任何报错都不能消费 `pendingReviewDiff`；前端不能在调用 API 前先显示合并成功。
6. 空章节依然是合法基线，不得因空文本 hash 错误拒绝第一次采纳。

### 4.4 核实这次截图的真实写入

先看章节 #119 的当前正文和历史版本，再核对 2026-10-22 19:03:42 附近对应合并的：

- `operation_key`；
- `/novel/adopt` 返回状态与写入版本 ID；
- `content_hash_before`、`content_hash_after`；
- 合并前用户编辑器版本与服务器正式版本；
- 是否真的新增了历史版本；
- 有没有之后的 autosave 再次覆盖合并结果。

**不要因为看到 `review_merge_overwrite` 就断言已经写入成功**：源码里它发生在 HTTP 请求之前。

## 5. P1：复验必须拆分成 issue 子条件

每个 issue 不再只存一句自然语言“是否修好”，还要编译为多个独立 `acceptance_checks`，例如：

```json
{
  "issue_id":"R-0004",
  "checks":[
    {"key":"duplicate_crowd_sigh_reduced","kind":"semantic","status":"PASS"},
    {"key":"hero_relief_visible","kind":"semantic","status":"FAIL"}
  ],
  "final_verdict":"PARTIAL"
}
```

合成规则：

- 硬条件任一 FAIL → 总体 FAIL；
- 软/文学子目标仍未满足 → PARTIAL；
- NEED_CONTEXT → 不可自动上调 PASS；
- 所有必需检查通过且引用最终候选的真实证据 → PASS。
- 无法证明“已解决”的语义层只能 `AWAITING_SEMANTIC` 或 `NEED_CONTEXT`。

为已选择的 R-0005、R-0006 生成定向复修任务，但不得为了修这两项改动已经通过且未重新授权的跨度；每次复修后都对全部六项重验。

## 6. 工作区 UI：不变得更拥挤，只完善操作语义

保留截图里的一行紧凑页头、左侧问题列表、中央双栏差异、底部操作栏。

仅改动状态与按钮行为：

- `已解决` → 明确指最终候选的哪个 hash 与哪些子条件全部通过；
- `只解决局部` → 点开详情查看剩余 evidence 与 repair hint；
- `修稿候选 2 份` → 显示“当前候选与正式正文的版本关系”，历史候选不直接继承验收；
- `合并到正文（仍有2条未通过）` → 建议保留手动采用，但按钮行为区分“继续定向复修”和“明确带未通过项采用”；不可写成“全部验收通过”；
- 基线过期时显示：当前正文与候选不在同一版本，提供**查看差异 / 重算候选 / 明确覆盖**，不再将覆盖仅隐藏在运行追踪日志；
- `独立复核待主机校验` 与 `修稿候选逐项验收` 是两个不同流程状态，不混用“完成”。

## 7. 完整实施顺序与退出门禁

**阶段 0：冻结现场**
- 备份章节 #119 当前正文与历史版本；
- 导出此次 review、selected_ids、candidate、finalized rows、trace、合并日志；
- 本地运行既有测试，保存 baseline。

**阶段 1：P0 合并保护**
- 在 `/novel/adopt` 的正文采纳事务中加入 expected version/hash；
- 将普通合并与明确强制覆盖区分；
- 不破坏历史版本、空章节采纳及作者主动采纳能力；
- 所有 MERGE 项断言通过。

**阶段 2：复审误报修复**
- claim/evidence 相关性校验；
- 显示字段缺失详情；
- blind findings / compare findings 只在 host 验证后可正式合并；
- 所有 AUD 项断言通过。

**阶段 3：修稿子条件终验**
- R-0004 分别验证群众重复与主角反应；
- R-0005 检查重复功能对白；
- R-0006 检查尾段重复死线；
- 成功再执行有限复修，所有 REV 项断言通过。

**阶段 4：工作区接线与双插件兼容**
- UI 全状态真实展示；
- `dsh-confirmation-resolution` 的 C 编号账本不被 auditor 访问或修改；
- 修稿与 DSH 子进程联调；
- 所有 ID/UI/CO 断言通过。

**阶段 5：收尾**
- 完整回归零失败；
- 一次正常合并、一次基线冲突、一次作者明确强制采用和一次历史回退演练；
- 输出被修改文件、commit、实际测试退出码、不能自动完成项及剩余风险。

## 8. 可执行回归测试与真实断言矩阵

共 **41** 项，所有项目都必须写成实际调用函数/API/工作区行为的测试，不接受 grep 代码后仅打印 PASS。

| ID | 输入/行为 | 必须断言 |
|---|---|---|
| `ID-01` | R-0001～R-0006 在审稿、勾选、补丁、复验、工作区中一致 | 结构化 ID 无降级、无串位 |
| `ID-02` | 结构化 issue 无对应 finding | 拒绝完整精确修稿，不静默生成空证据 legacy |
| `ID-03` | 复审新增 QA-R ID 与初审 R ID 并存 | 不覆盖已有作者授权 |
| `AUD-01` | 优点为系统首次播报克制，原文包含平头男生一直说话 | 不得输出两者相互否认；证据不相关 |
| `AUD-02` | 优点称没有人注意系统声，正文另一人正常聊天 | 不得判反例 |
| `AUD-03` | 优点确实说无人看主角，正文有人明确看了主角 | 正确标出矛盾及两侧文本位置 |
| `AUD-04` | 复核结果引用的原句不在对应正文 hash 中 | 不进入正式 finding，显示无效证据 |
| `AUD-05` | 复审结果缺 6 个字段 | 显示各 finding 缺失字段、来源和状态，不能假定通过 |
| `AUD-06` | DSH 仅输出总结，未成功调用 final submit | 审计状态不是 VERIFIED |
| `AUD-07` | blind 阶段读取初审报告 | 服务端拒绝读取 |
| `AUD-08` | 纸已放入裤兜，却说晃了晃手里的东西 | 盲审抓取道具持有状态不连续 |
| `AUD-09` | 系统声从耳边发出，后文突然写耳机里 | 提示核验声音载体，不伪定为硬伤 |
| `REV-01` | 校门口改检测中心门口 | R-0001 PASS |
| `REV-02` | 多说六字改为不量化的念法 | R-0002 PASS |
| `REV-03` | 评定单重复取用减少但保留拉链与红戳关联 | 验收按多个子条件判定，必要时 PARTIAL |
| `REV-04` | 群众叹息减少但主角没有可见放松反应 | R-0004 不得只凭删除群像就直接 PASS |
| `REV-05` | 宿主符合绑定条件仍出现于两个追问答复 | R-0005 PARTIAL |
| `REV-06` | 删折角尾句，却在结尾重复两遍数学卷死线 | R-0006 PARTIAL |
| `REV-07` | 定向复修 R-0005、R-0006 | 仅更动授权 spans，R-0001～R-0004 不回退 |
| `REV-08` | 复修修坏此前通过的 R-0001 | 最终全选问题重新验收，出现 REGRESSION |
| `REV-09` | 语义审计绑定 candidate hash H1，候选变成 H2 | 前次验收 STALE |
| `REV-10` | 模型表示问题已经解决而硬规则 still_present 为 true | 按明确硬失败处理 |
| `MERGE-01` | 基线 hash 相同、候选全通过 | 成功写入并有版本记录 |
| `MERGE-02` | 基线 hash 不同、候选全通过 | 服务端 409，正文不变，候选不丢 |
| `MERGE-03` | 基线 hash 不同但只改互不相交授权区域 | 三方合并后产生新候选、重新全量验收；不直接复用旧 PASS |
| `MERGE-04` | 基线 hash 不同且同跨度冲突 | 显示冲突与双方差异，不能默认覆盖 |
| `MERGE-05` | 作者显式二次确认强制覆盖 | 单独记录旧版本 hash、用户意图和版本历史；不伪装为正常合并 |
| `MERGE-06` | read 失败 base_unreadable=true | 不在无法确认目标基线时默默替换正文 |
| `MERGE-07` | 预览时部分通过且作者选择合并 | 明确显示“带未通过项采用”，保留 unresolved issue IDs |
| `MERGE-08` | 合并报 warning 后 /novel/adopt 实际失败 | 不显示“已覆盖成功”；候选仍在 |
| `MERGE-09` | 两窗口 A/B 竞态同时合并 | 至多一个以其预期版本成功，另一个冲突返回 |
| `MERGE-10` | 自动保存与合并在同一时间发生 | 最终库中数据符合预期 CAS，没有先合并后被旧 autosave 覆盖 |
| `MERGE-11` | 空章节第一次采纳 | 能使用合法空基线完成，不重演旧版误拦 |
| `MERGE-12` | 服务端事务某一步失败 | 正文、历史版本、提案入账、审计事件整体回滚 |
| `UI-01` | 历史版本或差异工作区来回切换 | 问题选择和候选不丢失 |
| `UI-02` | 部分通过页面点击“修复剩余2份” | 只提交 R-0005、R-0006，保持预算门禁 |
| `UI-03` | 工作区展示 4/6、2 部分 | 计数来自服务端同一版次验收，非不同候选拼接 |
| `UI-04` | 没有成功的 DSH 审计结果 | 标签为待主机校验/不可用，而不是已通过 |
| `UI-05` | 审计结果与当前章节 hash 不一致 | 展示过期并禁用可信验收结论 |
| `CO-01` | 与 dsh-confirmation-resolution 同时运行 | 审计不读写 C 编号账本 |
| `CO-02` | DSH 质量插件被关闭或卸载 | 原写作与审稿路径正常；不虚报独立复核完成 |

## 9. 交给 Agent 的启动提示词

```text
你负责对 Novel Studio 当前 checkout 实施《独立质量复核落地后的现场诊断与 P0 修复增量方案》，并与既有《dsh-novel-quality-auditor 完整落地方案》协同，不重新实现已经存在且正常工作的功能。

前提：
- 以实施机本地 Novel Studio checkout/commit 为唯一源码真源；GitHub 是本地上传副本，不擅自认定 GitHub 版本更高。
- DSH 固定 0.2.0-rc.2，不擅自升级。
- 保留作者对每项问题的勾选、保护跨度与最终正文采纳权。
- 保留 dsh-confirmation-resolution 的 C 编号状态机，不伪造确认事项。
- 单次与本次累计模型预算默认上限均为 2 元人民币，除非已有更严格授权；不得拆单绕过。
- 所有自动执行仅限已授权、安全、可恢复操作。不可逆覆盖与身份/额度/权限提升需要真实明确授权。

第一步必须先保护 work_id=18、chapter_id=119 的当前正文与历史版本，读取本次 review、审计报告、候选稿、复验结果和 2026-10-22 19:03:42 的合并事件，不允许先强制覆盖或清除现场。

按阶段顺序执行：
0. 备份、版本冻结、测试基线；
1. 调整合并基线比较的权威来源，使普通合并在版本冲突时事务性拒绝；显式强制覆盖仍可按真正的二次作者确认进行，并保留先前版本；
2. 修复独立复核“平头男生说话”被误判为系统播报论点反例的问题，实现主语/谓词/时点/范围相关性校验及缺字段详细诊断；
3. 将验收子条件结构化，R-0004 两个子目标都要判断；R-0005、R-0006 的剩余证据必须能驱动有界定向复修与全项重验；
4. 保留独立工作区紧凑布局，补强候选 hash / 主机校验 / 合并冲突 / 部分采用状态；
5. 执行本文全部回归、既有完整测试与真实 DSH profile 冒烟；演练正常合并、并发冲突、部分采用、显式覆盖、历史回退；
6. 输出每条断言实际命令、输入、结果、退出码与证据。

尤其禁止：
- 看到 review_merge_overwrite 警告就宣称写库成功；
- 把补丁已应用或文字有变化认定为语义 PASS；
- 把无关原文摘句认定为审稿反证；
- 忽略旧正文更新，自动覆盖；
- 因当前 2 条部分通过就虚报本轮 6 条全部完成；
- 测试未运行却编造全部通过。

如果有独立可执行任务，连续推进；对真实阻塞如实报告。只有全部必要门禁通过才宣布完成。
```

## 10. 本方案的验收定义

成功不等于“再让模型多审一次”，而是：

- **发现的问题既真实又有对应证据**；
- **每条被选中的问题可证明完成或可解释地未完成**；
- **复修不会污染已通过的其他问题**；
- **最终状态属于被实际验证的候选版本**；
- **普通合并不会静默抹去正文预览后出现的更新**；
- **作者仍可有意识地采纳部分候选或显式强制覆盖，且每一种行为都可追溯、可回滚**。

---

## 11. 实施状态（2026-10-22 本轮，以本机 checkout 为准）

> 本节是**实施记录**，不是方案本身。方案 §1–§10 保持原样（含它当时无法推断的部分）。
> 数字与结论只在有命令输出支撑时才写；没做到的明确写在 §11.5。

### 11.1 阶段 0：现场已冻结（已做）

`.p1-baseline/p0-freeze-scene.mjs`，输出目录 `data/backup-p0-merge-guard-20261022134642/`
（**第一版目录 `…120844` 的快照是错的**，见下面的更正说明）：

- `novel.db.snapshot` —— 用 `VACUUM INTO` 导出的整库快照（WAL 里的内容一并落进来），带 `snapshot-selfcheck.json` 自检；
- `chapter.json` / `chapter.txt` —— work_id=18、chapter_id=119 的 4623 字正文与 `updated_at=2026-10-22T11:03:42.845Z`；
- `chapter-versions.json` —— 本章 20 条历史版本（`chapter_save_versions`）；
- `adoption-operations.json` —— 本章 14 条采纳记录（含 2026-10-22T11:03:42.844Z 那次 `review_merge`）；
- `app-logs-merge.json` —— 19 条 `review_merge*` 及同章上下文日志；
- `revision-selections.json` / `chapter-reviews.json` / `quality-audit.json`（含 `qa_fadd5d61e510fe18` 的 CANCELLED 与 3 个 `RESULT_RECEIVED`）。

**更正（2026-10-22 晚，回退演练自查发现）**：第一版冻结脚本用 `copyFileSync` 只复制了 `novel.db` 主文件，
而本库是 `journal_mode=wal` —— 最近的写入还在 `novel.db-wal` 里，于是那份"整库快照"静默落后了整整一天
（快照里的第 119 章是 10-21 的 4922 字，活库已是 10-22 11:03Z 的 4623 字）。
同目录的 JSON/JSONL 取证是用 SQLite 读的（会读 WAL），**它们是当时真值**，可以继续用；
已被标注 `STALE-NOTICE.txt`。现在脚本改为 `VACUUM INTO` + 导出后自检（快照读回的正文必须与活库一致，否则直接失败）。

**§4.4 的首次回答（此前只有告警截图，这次有库内证据）**：19:03:42 那次合并**确实提交了**——
`adoption_operations` 有对应 `operation_key`、`chapter_save_versions` 新增一条、`chapters.updated_at` 同步推进；
同一条 `review_merge_overwrite` 告警（`base_unreadable=false`）出现在 HTTP 请求之前 5ms，
所以"有告警"本身仍不能证明写入，**这次是靠采纳记录与历史版本证明的**。
另：该次提交的 `content_hash_before` 与 `content_hash_after` 相同（两次点击写了同一份内容），
因此这一轮**没有实际内容丢失**；但这只是运气，不是保护。

### 11.2 阶段 1：P0 合并保护（已做，含判据与断言）

**普通合并不再静默覆盖；作者仍有"明确覆盖"出口，但必须二次确认，且服务端留痕。**

- `server.js` `/novel/adopt`：
  - `mode: 'normal' | 'explicit_force'`（默认 normal）；`expected.candidate_hash` / `verified_candidate_hash`；
  - 事务内比对 `expected.content_hash` 与实际基线：不相等且非 explicit_force → `409 REVISION_BASE_STALE`（整次回滚，正文/历史版本/提案/outbox 都没动）；
  - explicit_force 缺 `force_ack` 或 `base_conflict` → `409 REVISION_FORCE_NOT_CONFIRMED`；两次都没带 → 不覆盖；
  - explicit_force 仍然比对基线：作者确认之后正文又变了 → `409 REVISION_BASE_CHANGED_AGAIN`（不覆盖他没看过的版本）；
  - `candidate_hash !== verified_candidate_hash` → `409 REVISION_VERIFICATION_STALE`（旧验收不给新候选背书）；
  - 覆盖成功时：`adopt.forced_overwrite=true`、`base_hash_at_force`、`unresolved_issue_ids` 回包；
    并在**同一事务内**直接写一条 `app_logs(kind='adopt_force_overwrite')` 审计（不走 `log()` 的 1 秒内存缓冲：
    缓冲会让审计既不在事务里、又可能在崩溃时丢掉）。
- `public/revision-closure.js`（纯函数）：`mergeGateOf`（OK / BASE_STALE / BASE_UNREADABLE / VERIFICATION_STALE / NEEDS_REVERIFY）、
  `mergeAdoptPayloadOf`（普通合并与明确覆盖的请求体是两个形状）、`FORCE_ACK`。
- `public/revision-plan.js`：`rebaseCandidate` —— 把补丁重放到**当前正文**，锚点逐条核对，任一条对不上就整体失败并指出是哪条（不产出半成品）。
- `public/app.js`：`revisionChapterBaseline`（只读服务端权威基线）、`revisionMergeGate`、
  冲突框（查看差异 / 在当前正文上重算候选 / 明确覆盖 / 先不合并）、覆盖二次确认、
  `unresolvedIssueIdsOf`（未通过条目随采纳上报）、`closeMergeDialog`（关框不清候选）。
  另修一处**新引入的坑**：`closeModal()` 会顺手清 `pendingReviewDiff`（N6 的收口），
  于是"点查看差异就再也合并不进去" —— 合并相关弹窗改用 `closeMergeDialog()` 显式保回候选。

**与 2026-10-06 裁决的关系**：旧裁决是"点合并就必须写进去"，本轮把它拆成两步——
**出口没取消**（作者确认一次仍能覆盖），但"顺手一点就抹掉预览之后新写的正文"这条副作用取消了。
这是本方案 §4.2 的原意，已在该节记录。

### 11.3 断言（可复算）

- `node .p1-baseline/test-adopt-atomic.mjs` → **68/68**（新增 M0–M10 共 15 条：基线一致写入、基线不一致 409 且零写入、
  候选/验收 hash 不一致 409、缺 force_ack 409、缺 base_conflict 409、明确覆盖写入 + 事务内审计 + 旧稿进历史版本、
  未通过条目随记录回传、同 key 原样重放不重写、同 key 换 mode 409、空章节第一次采纳合法、老客户端不带基线语义不变）。
- `node frontend-test.mjs` → **ALL PASS（671 条）**，其中新增 MG-01…MG-10：
  门禁四态、请求体形状（普通/覆盖）、重放锚点、未通过台账、**真跑一次普通合并证明"一个 adopt 都不发"**、
  候选不被消费、覆盖请求体带二次确认、成功后消费、adopt 被拒时不清候选。
- 端到端（QC-21…QC-32）在更新夹具后仍然全绿：夹具原先只回 `content` 不回 `content_hash`，
  会被新门禁判成"读不到基线"——那是夹具不全，不是被测行为（已在注释里写明）。

### 11.4 阶段 2–5：未开始（本机代码现状）

- **未做** §3.1 `claim_evidence_relevance`：审稿报告的"优点 × 反例"相关性校验（主语/谓词/否定/时点/范围）目前不存在，
  `ai/quality-auditor/review-integrity.mjs` 只做身份链 + 逐字引用 + 缺字段计数，**没有**相关性这一层。
- **未做** §3.2 缺字段可定位：`normalization_warnings_json` 存的是粗粒度字符串，没有 `finding_id/field_path/expected_type/...` 的逐字段记录。
- **未做** §3.3 Host 验证门禁：`RESULT_RECEIVED` 与 `HOST_VERIFIED` 在界面上仍是同一档"上次独立复核"。
- **未做** §5 子条件结构化（R-0004/0005/0006 的 `acceptance_checks`）：验收仍是"一条自然语言判据 + 语义复核"。
- **未做** §6 其余 UI 语义（候选与正式正文的版本关系、`独立复核待主机校验` 与 `逐项验收` 分档显示）。
- 因此 §8 的 41 项断言矩阵**只覆盖了 MERGE 组的一部分与 REV 组的历史断言**，其余未实现也未断言。

### 11.5 诚实的边界

- 本轮**没有**在真实浏览器里点过新加的三个出口，**没有**发起真实付费调用；证据是隔离实例 + 桩驱动的断言。
- `candidate_hash` / `verified_candidate_hash` 是**客户端同族指纹**（`contentHashOf`，FNV-1a+长度），
  服务端只比较"两者是否相同"，不与自己的 `sha256` 基线互算。它的作用是"别拿旧结论给新候选背书"，
  **不是**密码学证明；基线保护（真正拦住覆盖的那一道）用的是服务端自己的 `content_hash`。
- explicit_force 的 `force_ack`/`base_conflict` 是**意图证据**，不是身份认证：本地应用无法证明点击者是谁。
  它的价值是让"顺手点合并"与"确认覆盖"成为两个不同的请求，并让每一次覆盖都留下可核对的审计。
- 该次真实事故的正文（4623 字）已在 §11.1 的快照与导出里；本轮的整库快照**不在** git 里（`data/` 永不提交）。

---

## 12. 第二轮实施（2026-10-22 晚）：阶段 2 与阶段 3

> 本节覆盖 §11.4 里"未开始"清单的一部分。§11 保持原样（那是第一轮的记录），
> 未覆盖的部分在 §12.3 逐条列出 —— 不把"没做"写成"已做"。

### 12.1 阶段 2：误报修复（§3.1 相关性 / §3.2 缺字段 / §3.3 主机门禁）

**§3.1 反例相关性（新增 `ai/quality-auditor/relevance.mjs`）**

- 判据是**确定性**的（中文二元组 + 英文词共现），零计费、无模型参与：
  - 共享词 ≥2 → `RELEVANT`（真反例，可以标 DISPUTED）；
  - 只共享 1 个 → `ADVISORY_NEEDS_REVIEW`（太弱，不据此降低报告质量）；
  - 0 个 → `INVALID_RELEVANCE`（不相干，**禁止**呈现成"互相否认"）。
- 现场三例的实测结论：「平头男生一直在说话」vs「系统首次上线保持克制」→ `INVALID_RELEVANCE`；
  「另一个人正常聊天」vs「没人注意系统声」→ `INVALID_RELEVANCE`；
  「有人明确看了主角一眼」vs「没人看主角」→ `RELEVANT`（真反例必须被认出来，否则这层就成摆设）。
- 落点：`merge-review` 里 DISPUTED 先过这一层；不过关的降级为 `ADVISORY_NEEDS_REVIEW`
  （`disputed=false`、进 `advisories`、写入 `relevance_downgrades`），**原始结论仍保留**（`review_verdict`），
  并在 `hostVerify` 与 `merge` 各写一条 `review_relevance_downgrade` 审计事件。
- 契约随之收紧：`DISPUTED` 现在**必须**带 `counter_evidence`（逐字引用），否则阻断级缺陷。
  提示词同步要求给出反例、并说明"反例必须与主张同一件事"。

**§3.2 缺字段可定位（`contracts.defectsOf`）**

- 每个缺陷是：`audit_id / finding_id / field_path / expected_type / actual_type / source /
  error_code / severity / resolution_path / detail`，
  `resolution_path ∈ {FREE_REPARSE, PAID_REGENERATE, AUTHOR_CONFIRM}`（能不能免费修）。
- `validateReviewAuditPayload` / `validateRevisionAuditPayload` 的 `errors` **由同一批 defects 逐字拼出**
  —— 一份判据，两种呈现，避免"摘要说缺 6 条、台账只有 4 条"这类漂移。
- 接口层：`/submissions` 失败时把 `defects` 与 `defect_summary`（按处理路径分组 + 前 8 条摘录）一并回传；
  前端 `showAuditDefectDialog` 按行显示，并写明"结构问题不进逐项验收"。

**§3.3 主机门禁**：服务端本来就是 `RESULT_RECEIVED → HOST_VERIFIED → MERGED` 的硬状态机
（未主机校验不能合并）；本轮补了断言 AUD-07，并让 `HOST_VERIFIED` 之前也做一次相关性复核留痕。

### 12.2 阶段 3：逐项验收子条件（§5）

- `revision-integrity.effectiveVerdictOf`：一条问题可带多条 `checks`（`kind ∈ hard|soft|context`，
  `status ∈ PASS|FAIL|UNKNOWN`），由**固定规则**合成终态：
  硬条件 FAIL → FAIL；context 未确认 → NEED_CONTEXT；软条件 FAIL → PARTIAL；
  状态缺失/非法 → PARTIAL（不判通过）；全部 PASS → PASS。
- 模型单独给的那个词不再作数：`verdict_declared` 保留原判，`verdict_derived=true` 表示终态来自合成。
- 契约：`issues[].checks` 的 key 必填且同项唯一、kind/status 必须在枚举内，非法即逐字段拒绝。
- 复修线索：子条件的失败证据进入 `remaining_evidence`（`from=acceptance_check`），
  与确定性层失败一起驱动有界定向复修。

### 12.3 断言（真实命令与数字）

- `node scripts/quality-auditor/test-relevance.mjs` → **12/12**（AUD-01/02/03/01b/03b/04/05/06/06b/06c/07/08）。
- `node scripts/quality-auditor/test-acceptance-checks.mjs` → **10/10**（REV-03…REV-11）。
- `node scripts/quality-auditor/test-contracts.mjs` → **19/19**（新增 CT-06c：缺 `counter_evidence` → 422 + 逐字段缺陷，
  且 run 停在 `COMPARE_RUNNING` 未被推进）。
- `frontend-test.mjs` → **ALL PASS（680 条）**，新增 QA-P14…QA-P18（子条件进度/降级说明、缺字段台账、
  相关性降级文案、中文标签、真实弹窗内容）与 QC-60…QC-63（工作区行内带审计子条件、没跑审计时留空、
  候选与正文版本关系三态、工作区真的从审计结果取子条件）。
- `verify-id-chain` 14/14、`test-e2e` 6/6、`test-provision` 5/5、插件 `tools.test` 13/13。
- 两个新套件已登记进 `scripts/ci-offline-checks.mjs`。
- **回退演练**（`node .p1-baseline/p0-rollback-drill.mjs`，只读）→ **6/6**：
  快照里确有该章、快照正文与活库一致、字数一致、存在非空历史版本、复制出来的快照能打开并读回同一份正文。
  这一步正是它先发现了上面那条"快照落后一天"的问题。

### 12.4 仍然没做（如实列出）

- **§8 里 AUD-08/09**（"纸已塞进裤兜，却又晃了晃手里的东西"这类**道具持有状态不连续**）：
  盲审提示词没有要求核验道具状态链，也没有对应断言。v1.2.2 的 `story_prop_states` 是写作侧能力，未接入审计。
- **§6 已做**（本轮补）：
  - **版本关系**：详情抽屉显示"正文：与打开预览时同一版（合并会直接写入）／在打开预览之后更新过
    （合并前会先让你确认是否覆盖那一版）／这份候选已经合并进正文"（`versionLineOf`，QC-62）；
  - **工作区行内子条件**：审计的 `acceptance_checks` 按 issue_id 并进工作区行，抽屉里既能看
    摘要（"审计子条件 1/2 通过（未达成：…）；审计原判 PASS，按子条件降为 PARTIAL"）也能看逐条清单
    （QC-60/61/63）；没跑过审计就留空，不画成"全部通过"。
- **§6 仍未做**：`独立复核待主机校验` 与 `逐项验收` 的**分档展示**（两套标签仍各自出现，没有合成一处）；
  「修稿候选 N 份」里历史候选不继承验收（版本关系只覆盖"当前候选 ↔ 正文"）。
- **AUD-05 的"免费重新解析"**：`FREE_REPARSE` 目前只是**分类**，服务端还没有一条"自动补齐后重试"的实现路径。
- 未在真实浏览器里点过新弹窗，也未发起真实付费审计；证据是隔离实例 + 桩驱动。

---

## 13. 第三轮（2026-10-22 深夜）：分档展示 / 历史候选 / 道具线索 / 真实联网演练

### 13.1 「独立复核」与「逐项验收」合成一条梯子

`review-workspace.stageLadderOf` —— 五步一条梯子：审稿与选择 → **独立复核** → 生成修稿候选 →
**逐项验收** → 审阅与合并。独立复核那一步单独分档：未做（可选）/ 进行中 / **结果待主机校验** /
已复核 / 未通过。工作区顶部原来那个阶段导航改用它，作者在一处就能看到"我在第几步、卡在什么状态"。
"当前步骤"跳过"可选且未做"的独立复核，不会把箭头指到没做的事上（QC-64…QC-66）。

### 13.2 历史候选不继承验收

验收结论**绑定候选 hash**，不绑定槽位：`revision-archive.acceptanceOf(records, slot, currentHash)` 返回
"这份就是当前候选（结论适用）/ 历史候选（结论只属于它自己，不继承）/ 不存在"。
存档时把该候选自己的 `verdict/pass/total` 一并记下；写作台那一条存档提示会写明当前是哪一种（QC-67）。

### 13.3 AUD-08/09：道具持有状态与声音载体（确定性线索）

新增 `ai/quality-auditor/prop-continuity.mjs`：
- **AUD-08**「先收起来（塞进裤兜），之后直接出现"手里的东西"」→ `POSSIBLE_OBJECT_STATE_CONFLICT`，
  附**两处**逐字证据；中间写了"从裤兜里掏出"就不报。
- **AUD-09**「先前写"在耳边"、后文出现"耳机"」→ `NEED_CONTEXT_SOUND_CARRIER`，只提示核验载体，**不判硬伤**。
线索进入 `reviewIntegrityCheck().advisories`（**不阻塞**复核），并写进审计输入的 context
（标题写明"确定性线索（非结论）"）；提示词新增两条核验要求。

### 13.4 FREE_REPARSE 从"分类"变成"实现"

`contracts.autoRepairPayload(kind, payload, ctx)`：只补**契约能唯一确定**的字段 ——
`schema_version`、条数与冻结初审一致时按位置补的 `initial_findings[].issue_id`、`new_findings[].id`（QA-R 编号）；
补完重新校验，补不干净把剩余缺陷原样交回。语义字段（反例引用、验收条件）**绝不代编**。
`submitFinal` 在契约失败时自动尝试一次，成功则记 `contract_auto_repaired` 事件（FR-01…FR-04）。

### 13.5 真实浏览器与真实联网审计

- **真实浏览器**（`.p1-baseline/browser-e2e-dialogs.mjs`）：本机 Edge headless + CDP，**真鼠标事件**
  （`Input.dispatchMouseEvent`，不是 JS `.click()`）点开这一轮新增的弹窗 → 7/7：冲突框出现且文案正确、
  「查看差异」打开只读对比、「明确覆盖」弹出**第二个**确认框、点取消后正文长度不变且没有采纳被写入。
  跑在隔离实例（`VACUUM INTO` 复制），作者的真实库没有任何写入。
- **真实付费审计**（`.p1-baseline/real-audit-run.mjs`）：同样隔离实例（复制了 api_configs），
  真实 dsh + 真实审计插件、预算上限 ¥2 → 实跑到 **RESULT_RECEIVED**：
  `run_created → input_frozen → token_issued → dsh_started → blind_submitted → compare_started →
  resource_read×5 → result_received`；6 条初审结论 4×INVALID_EVIDENCE / 1×NEED_CONTEXT / 1×COVERED，
  **没有 DISPUTED**（因此不需要反例；收紧后的契约在实际模型输出上没有被误伤）。

### 13.6 真实演练发现并**已修**的缺陷：实际费用被谎报成 ¥0.00

`budget_charged_microunits` 在真实跑完之后仍是 **0**（授权 ¥2 / 估算 ¥1.2 / 实际 ¥0.00），
而模型确实被调用过（有 blind 与 compare 的产出）——界面上那句"实际 ¥0.00"是**谎报**。

根因（两条，缺一不可）：
1. 这个字段**从来没有写入方**（全仓只有读与 patch 映射），所以它永远是默认值 0；
2. 审计的真实计费发生在 dsh 侧，本服务拿不到 token 用量，于是"0"被当成了"免费"。

修法（按"证据"而不是"默认值"）：`store.runToClient` 的记账口径改为
`charge_known + charge_source`：`>0` → `settled`（已知金额）；`0` 且已进入付费阶段
（BLIND_SUBMITTED 之后）→ `unknown`（`charged_microunits: null`，**不编造 0.00**）；
`0` 且还没走到付费阶段 → `not_billed_yet`；哨兵 `-1` → `unknown`。
界面对应三种文案（`quality-audit-panel.chargeText`）：「实际 ¥x.xx」/「实际费用未知（dsh 侧未回传用量，
不作 0 元记账）」/「实际 ¥0.00（尚未走到付费阶段）」。

断言：CT-00d（口径四态）、QA-P19（界面不打印"实际 ¥0.00"且抽屉同步）。

**结清链路已实现**（2026-10-23）：
- `ai/quality-auditor/usage.mjs`：`settleChargeFrom({usage, priceTable})` 纯函数 ——
  没用量 / 没价目 / 型号不在表里 → **未知**；有价目 → 按 `入 tokens × 单价 + 出 tokens × 单价` 折算；
  子进程自报金额 → 采用并标 `source=reported_cost`。
- `store.settleCharge(id, microunits)` 是该字段的**唯一写入方**（写成功才落账，并记 `charge_settled` 事件）。
- `/submissions` 接受请求体里的 `usage`（**不是**模型产出：模型不知道 token 数，让它填只会得到编造值），
  服务端读 `app_settings.audit_price_table` 折算；没有价目就记 `charge_unknown` 事件并保持未知。
- `scripts/quality-auditor/set-price-table.mjs --show/--set/--set-file/--clear` 配置可信价目表。

**仍然缺的一环**（如实）：`dsh` 子进程目前**不打印** token 用量，插件也拿不到，
所以真实跑完的审计仍然是"未知"。一旦子进程能回传 usage（或插件能读到），
服务端这一侧已经就位（CT-06d 证明了"带 usage → 1500 微单位结清"这条链是通的）。
