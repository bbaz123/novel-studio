# Novel Studio 1.1.6｜0731 号觉醒日：审稿—局部修稿闭环增补方案

> 用途：给负责本地 Novel Studio 源码的工程代理（含 DeepSeek Harness）执行。**这不是小说重写方案**，也不是已经在用户本地实施的修复报告。
>
> 证据级别：`SOURCE`＝本次对话正文/审稿单/修后预览；`PUBLIC_VERIFIED`＝2026-10-12 查阅的 GitHub 默认分支 `Experimental-Version-v1.0`；`LOCAL_NOT_VERIFIED`＝未取得用户本地 checkout、真实 ReviewV2 记录、数据库及付费模型轨迹。
>
> 本文件是所上传《修改方案.md》的**新样本增补**：旧文档的 6357 字、0001/0372 号、6:20/7:40、另一套 D01–D06 绝不可充当此次 3223→3193 字及 0426/0698/0731 号样本的测试结果。

## 0. 可以直接交给 DSH 的执行指令

阅读根目录原《修改方案.md》及本增补。严格只对用户本地 Novel Studio 的源码和隔离测试动手，不改小说、真实数据库、角色卡、密钥、世界观或 Harness 内核。开始前记录 `git status --short`、HEAD、分支、package.json 版本、Node 版本、开发规范；只读核验 E00，然后先写能失败的 T31–T45，修复后运行现有离线回归。不得 reset/clean/stash/commit/push；没有许可不得触发付费模型；已有实现满足的条目标记 `already_satisfied`。必须记录真正运行的命令、退出码、断言数、差异证据及未验证项。**不要以模型声称“已改”代替 diff + issue + span + op + 修后验证。**

## 1. 本轮样本的 9 条覆盖审计（SOURCE）

| 原审稿 ID | 系统记录/实际处理 | 本轮审计判断 | 下一步 |
|---|---|---|---|
| R01 时序倒置 | 删“中午前后”，不移动面包段 | `partially_resolved`：后文仍称“中午那个面包”，而买面包段位于“十点出头”之前 | 取得作者对第二位置的局部批准，把后文“中午”改为“上午”；**或**作者批准跨段结构任务，把面包段移至两次 A 级之后。禁止自动重排 |
| R02 第二A级指代和学校信息 | 改“第二个A级下台的时候”，学校仍为江陵三中 | `mostly_resolved`：第二人的身份指代已清晰。**两个不同 A 级来自同校**是可能的重要新增事实，不应为了消除字符串重复而删去 | 保护第二个 A 级也属于江陵三中的增量；若设定不允许，同世界观另行核对 |
| R03 C级出路重复 | 第二处改为“王磊还在说，说着说着……” | `partially_resolved`：删除重复职业规则有益，但“还在说，说着说着”仍显重复，且新动作是否符合人物待作者阅读 | 可单独提议进一步精简，不得为了去重另造无意义的眼神、摸兜、捏手 |
| R04 安静反应重复 | 给了直播“声音一层层矮下去”的跨度，模型没有修改 | `blocked_scope_mismatch`：给到的是审稿建议明确要求**保留**的锚点 | 指出应另行授权浅蓝色反应“很快又安静下去”及“楼里先安静了半秒”，不可触碰直播锚点 |
| R05 D级后的群众反应 | 改“假装没看见”为“没人再看他……” | `partially_resolved`：仍保留“没事，一样能考大学”的陌生人通用安慰；可保留作人性差异，也可按作者许可删除 | 不把 D 级约95%的报告背景写成本文已证明的设定事实；只做候选，不强制删 |
| R06 王磊号码纸动作 | 改为“攥成一团，再塞回兜” | `patched_reason_mismatch`：动作可讨论，**补丁理由却谈深海母神角色卡**，与该 issue 不对应 | 查原 patch/disposition/adapter 是否 ID 串位；没有原始响应不得武断指认根因；错配时理由不能显示为可靠依据 |
| R07 开篇主角缺主动动作 | 未获得跨度，未改 | `needs_scope`：模型按门禁停下合理；不是“已解决” | 编辑器允许在明确零长度 insertion point 插入一个真正承担目的的小行动；新操作需独立授权 `insert`，若协议不支持则让作者手动加 |
| R08 系统每章5～15次 | 保留一次系统语音 | `keep`：首章钩子明确要求末尾首次出声；不得用书级指标提前透系统 | 必须保护末句声音来源悬念，不自动补面板/奖励/对答 |
| R09 深海母神角色卡时点 | 报告称卡片越界，正文中未出场 | `deferred_to_character_card`，不是 chapter patch | 验证真实角色卡及卷章时点后再由作者单独处理；本章不增多余日期锚 |

### 本轮新增的待核验候选（不自动进入修稿问题）
- 检测石还未出结果，叫号器已“照常在响下一个号”：**如果只有一个工位且按完成顺序叫号**，流程有疑点；如多工位/预叫号则可成立。缺设定时 `needs_workflow_evidence`。
- 两次 A 级同城且同校，与“百万分之一”宣传形成罕见性张力：可能是刻意异常，而非硬冲突。设定未核实时 `possible_foreshadowing`。
- S级天赋、SS级异象、海澜直播、0731号纸、三秒与第四秒的间隔均保持伏笔/待核验状态，不能作无证据删除。

## 2. 源码 P0：不再只按模型的语言承诺兜底（PUBLIC_VERIFIED）

查阅范围：
- https://raw.githubusercontent.com/bbaz123/novel-studio/Experimental-Version-v1.0/public/app.js
- https://raw.githubusercontent.com/bbaz123/novel-studio/Experimental-Version-v1.0/public/revision-plan.js
- https://raw.githubusercontent.com/bbaz123/novel-studio/Experimental-Version-v1.0/public/revision-patch.js
- https://raw.githubusercontent.com/bbaz123/novel-studio/Experimental-Version-v1.0/public/patch-safety.js

### P0-A 稳定 issue/review 关联
- `refineByChecklist` 目前先把 `state.pendingReview = null`，之后 `selectionPayload.review_id` 从它再读取，实际可能是 `undefined`。在清空状态之前冻结 `review_id`、`snapshot_id`、`base_hash`、原 finding ID 和作者勾选集合；重试/刷新/分片必须复用，不得重新编号。
- 现有 `selectedIssueIds = confirmed.map((_,i)=>String(i+1))` 及提示词 `map((x,i)=>i+1)` 是选择后再编号，应使用初次审稿时的 immutable ID。不能只勾原 #3/#7 就生成 #1/#2。
- UI 不只保存问题文字；结构化记录至少含 `{review_id, issue_id, quote, target_scope, verdict, selected, evidence, counterevidence}`。旧报告可读，但不伪造旧 review_id。
- 本轮 #6 绑定了 #9 的解释：实现里要保留 `patch_id → issue_ids → disposition(reason, origin)` 的原始映射；发现理由与 issue/scope 没法核实时输出 `reason_unverified`，不能直接渲染成“已改理由”。必要时让作者人工确认语义，而不是用另一轮模型自动胡编。

### P0-B 双重授权 = 真实 selected issue + 该 issue 的准确 Host span/op
- 在一次修稿请求的不可变快照里保存 `authorizations:[{issue_id,span_id,start,end,allowed_ops}]`、`selection_hash`、`plan_hash`、`protected_spans` 和 `context_only_spans`。
- `runRevisionPipeline()` 传递授权映射给 `planPatchApplication()`；对每条 patch 严查“选中的 issue 能否对这个 exact range 做这个 op”。只检查 `issue_id ∈ selected` + `span_id ∈ 本章` 不足以证明授权。
- 含显式 offset 的 patch 也不能绕过白名单；`delete` 导致分隔符扩大有效范围时，扩大部分必须独立授权或通过安全的受控删除策略。
- 重复 exact quote 位置不唯一时 `ambiguous_anchor`；计划编译失败、无 hotspot、空白名单时返回 `needs_scope`，**不发付费局部修稿**。可以发送整章只读上下文，但不可给整章“授权跨度目录”。
- R07 插入需求：现有 op 只有 `replace/delete/condense`，不得假装字符串替换有权插入任意句。可以实现显式 `insert` 的零宽 Host 授权及测试，或保留手工插入。
- 作者编辑了底稿或变更勾选集合，旧 patch 全部 `stale`；重试次数属于持久任务预算，不因刷新无限重来。

### P0-C 安全门禁异常不能默许机器补丁
- `revision-patch.js/gatePlanPatches` 在 engine 缺失和 catch 异常时当前返回 `allowed:patches.slice()` 并标记 unavailable。虽然随后会显示未验证/安全阻断信息，但候选文本仍可能被形成。**机器自动修稿路径改成 fail-closed**：`allowed:[]`、`safety_unavailable`、原文哈希不变，不自动交由普通候选采纳。
- 作者仍应保留明确的手动编辑、独立授权的整章任务和历史报告浏览功能；新机器门禁不能阻断人的自主编辑。
- 单条核验与组合核验都需处理 missing/malformed/throws，任何一个失败均不得显示“已验证”。审稿失败不应通过切换 legacy 补丁、扩大跨度或静默整章重写来绕过。

## 3. 源码 P1：概率误报是确定性算法的归因错误

公开 `patch-safety.js` 的 `collectPercents` 会：
1. 在“概率/占比/分之”等词附近提取裸中文数字；
2. 把“百万分之一”折算成 0.0001%；
3. 只要收集到至少两种数值，就把**本章所有数值出现次数**相加，并判“应为100%”。

但“等级分布是否加起来为100%”只适用于**完整、互斥、同一口径**的一组分类概率；角色口头反复念同一个稀有度、附近的“一年/一个/一遍”、或部分等级数据都不能作为完整分布。示例：
`百万分之一啊。那你说，江陵这种地方一年能出一个吗？`
按公开规则的关键分支做隔离复现，会同时提取普通“一年”的 `1` 和稀有度 `0.0001`，因此可能错误触发 `percent_sum_mismatch`。**这不是本地仓库回归通过的证据。**

修复要求：
- 将 `collectPercents` 定位为**提取候选及证据位置**，不是无条件构造世界观合计。
- 只对明确绑定 `{level, probability, unit, source_quote}` 的等级事实去重与比较；“A级百万分之一”重复十次只能形成 A级的一个一致性声明。
- 只有权威世界观明确提供完整、互斥等级全集，且每一等级均有有效概率时，才允许总和检查；其余输出 `distribution_incomplete/not_applicable`，而不是“合计5%，应100%”。
- 支持 `95%`、`95％`、`百分之九十五`、`百万分之一` 的单值提取回归；拒绝把“我一年看过一个人”当额外1%。无充分上下文时宁缺勿错。
- 此报错不应归咎于作者，不能作为修稿提示词中“必须改掉正文事实”的已证实问题。

## 4. 源码 P1：问题解决状态不等于“该跨度曾被改过”

覆盖记录至少要区分：
- `resolved`：该问题的所有已授权必要证据均修复，修后上下文通过；
- `partially_resolved`：R01/R03/R05 等只处理一半；另有未授权位置；
- `patched_reason_mismatch`：有 diff，但理由引用了另一问题；
- `blocked_scope_mismatch`：R04 给到的是要求保留的跨段；
- `needs_scope`：R07 无合法 insertion point；
- `keep`：R08 保护首次系统语音；
- `deferred_to_character_card`：R09 跨作用域。

修后核验应读取**完整新稿**及修改前后直接相邻上下文，支持最小的 `temporal_reference`、`semantic_completion`、`issue_coverage` 候选。不能“语义模型没跑”时显示文学自然度已改善；无额外付费许可默认 `semantic_status:not_run`。模型说“改了5条”只记录 `patch_count=5`，不等于 `resolved_issue_count=5`。

## 5. 本轮新增离线测试 T31–T45（先复现失败，再修到通过）

| 编号 | 输入／触发 | 预期断言 |
|---|---|---|
| T31 | 原始 9 issue 只勾 #3/#7，排序、刷新、重试 | stable IDs 原样保持 #3/#7，review_id 非空、selection_hash 一致 |
| T32 | 清空 `pendingReview` 再创建 selectionPayload | 使用冻结的 review_id；API/DB/reload 可追溯 |
| T33 | #6 号码纸修改的 reason 写成 #9 深海母神 | `reason_unverified` 或 `explanation_mismatch`，不得展示为可信理由 |
| T34 | #4 只授权直播“声音矮下去”，模型却改前面浅蓝段 | `out_of_scope`，原文哈希不变 |
| T35 | 计划 null、编译器抛错、同一 exact quote 出现两处 | `needs_scope/ambiguous_anchor`，不下发可改整章跨度 |
| T36 | 补丁 issue 在 selected 中，但 span 属该章另一个 issue | `out_of_scope`，即使 original 完全一致仍拒绝 |
| T37 | 安全引擎缺失/抛异常/返回畸形 | `safety_unavailable`，新自动修稿候选不含待应用补丁，原文不变 |
| T38 | 稀有度“百万分之一”+“一年/一个” | 不触发“所有等级百分比未合计100%” |
| T39 | A级百万分之一连续重复讲三次 | 同等级去重，不把三句话视作三种分类概率 |
| T40 | 仅列部分等级的 95%/4%，无完整全集 | `distribution_incomplete`；不报必然差1% |
| T41 | 跨句改完仍有“中午那个面包”且前文在十点前 | `partially_resolved` 或 `needs_temporal_review`，不能叫 #1 resolved |
| T42 | #2 两个不同A级都来自江陵三中 | 作为新增人物关系事实保留，不能仅因同名字符串重复而删 |
| T43 | #8 只在结尾有一次系统语音、#9 角色卡不在本章 | `keep/deferred_to_character_card`，不生成改章 patch |

测试在已有 `tests/` 结构中接入，不新建与生产引擎并行的独立扫描器。**用本文件同目录 JSON 做差异夹具，不接真实作品库和付费模型**。参考原《修改方案.md》已有的离线入口，先确认脚本存在；每条给出实跑命令、exit code、断言数、跳过原因、日志位置。公开代码可见不等于本地测试通过。


### 额外数值边界测试（T44–T45）

| 编号 | 输入／触发 | 预期断言 |
|---|---|---|
| T44 | `100%`、`100％`、`100.00%`、`123%` | 正则不能从数字内部截取尾部 `00%/23%` 当完整数值；100 应可正确识别，超出合法占比的 123 应明确拒绝或报告格式错误 |
| T45 | `0%`、`0.0001%`、多次出现相同A级稀有率 | 零概率允许作为合法分类项；极小数不被截断为 `1%`，重复叙述不累计 |

这两条针对公开源码 `PERCENT_RE` 未限制数值左边界、整数部分只允许1～2位以及 `v > 0` 的边界。按该正则在隔离复现里，`100%` 会错误匹配到 `00%`。修复需避免新引入数字误判，且先确认项目对“0% 等级”是否有业务约束。

## 6. 最终交付要求

最小交付清单：真实 `HEAD/branch/status/version`；被改源码清单；缺陷复现截图或失败断言；修复后的绿色断言；R01–R09 覆盖状态；T31–T45 测试结果；每一补丁的原 issue ID、原文 hash、授权 span/op、diff、处置与原始理由；未跑的真实模型文学效果显式 `not_run`；不含 reset/clean/stash/commit 的逐文件回滚方案。

**完成判据**：作者勾选什么、Host 精确授权哪里、模型修改哪一段、门禁为何允许、修改后是否真的解决问题，必须能逐步复核。即使无法在现有授权内修完，也要如实报告 `partially_resolved/needs_scope`，不能通过删字数、改问题 ID 或错误概率报表伪装成完成。
