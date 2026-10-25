# 逐项验收卡死（PARTIAL_CANDIDATE 无出口）修复方案

> 2026-10-22 作者报：审稿工作区停在「逐项验收」，`#R-0005`／`#R-0006` 判「只解决局部」，
> 界面明确说未通过，但**没有任何入口能继续修这两条**：AI 不再修、也没地方人工改。
> 本文件是对该现象的诊断与可选修复路径。**本文件只做方案，不改行为。**

## 一、截图对应的真实状态（先对齐事实）

- 顶部阶段：`候选未通过全部验收`，即 `PARTIAL_CANDIDATE`。
- 左侧统计：已选 8 · 已验证 4 · 局部 2（其余 2 条为其它终态，不在底部未通过名单里）。
- 底部动作只有 4 个：`合并到正文（仍有 2 条未通过）`、`导出待处理清单`、`返回写作台（保留候选）`、以及存档入口。
- 左侧两条 `只解决局部` 的条目点击后，详情里只有证据与三维状态，没有任何按钮。

结论先说清楚：**不是模型没修，也不是修完又被吞了，而是这一档状态在设计上只有"合并／离开／导出"三条路，
没有"再修一次"。** 系统在"不宣称修好"这件事上是对的；错在**没有给出下一步的动作**。

## 二、根因（逐条给代码证据）

### R1 系统承诺了"只复修未通过项"，但按钮不存在

- 统一出口算出的下一步是 `TARGETED_REPAIR`：「只复修未通过项（N 条），仍限原授权范围」
  （`public/revision-finalize.js` 的 `nextActionOf()`，`PARTIAL_CANDIDATE` 落到最后一行）。
- 但底栏动作由 `public/review-workspace.js` 的 `actionsOf()` 生成，`PARTIAL_CANDIDATE` 分支
  只 push 了 `merge-partial`，随后统一追加 `archive / export / back`。
- 于是"下一步"这句提示只出现在**详情抽屉**里（`renderReviewWorkspace` 里的 `finalize.next_action.label`），
  底栏没有任何可点项 —— 这句话目前是**空头承诺**。

### R2 自动定向复修只在两条路径上跑，且额度是一次性的

- 路径一：生成修稿后，确定性验收已判失败 → 自动复修（`public/app.js` 中 `refineByChecklist` 内的
  `runRevisionAutoRepair` 调用）。
- 路径二：语义复验后仍有未解决项 → 自动复修再复验一次（`runRevisionSemanticVerify` 内的同名调用）。
- 轮次上限 `REVISION_AUTO_REPAIR_MAX_ROUNDS = 2`，预算上限 `revisionBudgetCents()` 默认 200 分（≤2 元）。
- 复验额度用 `semanticRuns` 计，`>= 1` 即封死（`runRevisionSemanticVerify` 开头的守卫）。
- 这套设计意味着：**复验一跑完，"再修"的自动通道就关闭了**，而新增按钮又不存在（R1），
  所以作者看到的就是"AI 修了一次就不修了"。

### R3 一个 finding 只给一个跨度，最多放宽到整句

`public/revision-plan.js` 的 `buildRevisionPlan()` 对每个 finding 只 `locateFragment()` 一次，
生成**一个** hotspot；跨度 = 能逐字指出的那段原文，提及型引用最多放宽到所在整句。
所以像 `#R-0005`「系统连用同一种回避句式」这种**全篇多处**的问题，一次补丁只能改中被引到的那一处，
其余处原样留着 → 复验判「只解决局部」。这不是模型懒，是授权范围只覆盖了一处。

### R4 跨段压缩（condense）在代码里**永远不可用**

- `condense` 只有在 `allowCondense` 打开**且** `f.merged_span_approved` 为真时才放行，
  否则一律 `refused`（`revision-plan.js` 两处守卫）。
- 全仓库检索：`merged_span_approved` **只有这里在读，没有任何地方写**。
- 也就是说 `#R-0006`「钩子成立后仍用三段无信息日常收尾」这种**跨段落删除/压缩**，
  在当前补丁协议下是结构性做不到的：单跨度删不掉三段，condense 又被门禁挡死。
- 顺带纠正一个容易踩的坑：审稿清单弹窗里那个「允许对已选问题局部压缩」勾选框，
  单独勾上**并不能**解开跨段压缩 —— 它只解决 `allowCondense`，`merged_span_approved` 仍然缺。

### R5 人工修复入口不存在，而改正文会让候选作废

- 工作区对候选稿是**只读**的：没有编辑器，没有"就地改这段"。
- 作者能改的只有写作台里的正文；而正文一改，候选即按 `BASE_STALE` 作废
  （`public/app.js` 的 `revisionRunStoreLoad` 附近，提示语是"旧候选与旧授权已作废，需要重新修稿"）。
- 所以"人工修复"不是没做，而是**做不了**：改了正文就丢了候选里已经修好的 6 条。

## 三、现在马上能走的三条路（不改代码，今天就能动）

### 路 1（推荐）：先合并已修好的部分，再人工收尾，再重审一次

1. 先留档：点「导出待处理清单」存一份；需要对照的话再从存档入口看「历史版本」。
2. 点「合并到正文（仍有 2 条未通过）」。这一步把已修好的 6 条写进正文，`#R-0005`／`#R-0006`
   的**局部改动**也会一起进去；旧稿会留在历史版本，可回退。
3. 回写作台，人工处理这两条（这是当前唯一能真正动手的地方）：
   - `#R-0006`：把那三段日常收尾删掉或压成一句；这是人类写手几秒钟的事，AI 现在做不到（见 R4）。
   - `#R-0005`：搜同一类回避句式（例如"不是……而是""与其说……不如说"），逐处改成直陈。
4. 重新审稿 → 只勾这两条（正文已是改进版，问题面更窄）→ 若还需要 AI 精修再跑一轮修稿。
5. 若不想人工改：就此收工也行，但要在心里记牢 **这两条是"已知遗留"**，
   下次审稿它们还会再被报出来（当前没有"已接受遗留"的记账，见方案 C）。

### 路 2：不合并，直接重新审稿

能走通，但**不推荐**：正文还是原样，重审会把 8 条全部再报一次，
已经修好的 6 条等于白修（旧候选留在存档里，需要手工对比）。

### 路 3：先不动，等方案落地

只做留档（导出清单 + 确认历史版本里有候选），然后把这份方案选定后实施。
适合"这两条现在不急、但不想再踩第二次"的情况。

## 四、方案 A：补上「只复修未通过项」入口（P0，建议先做）

**目标**：让 `PARTIAL_CANDIDATE` 这一档真的有"再修一次"的按钮，且仍然受原有门禁、轮次、预算约束。

改动点：

- `public/review-workspace.js`：`actionsOf()` 的 `PARTIAL_CANDIDATE` 分支新增一个动作
  `repair-partial`，文案带上待修条数与花费口径（沿用"一次付费调用"的写法）；
  无可修条目（全是蓝图冲突/需作者裁决）或预算用尽时给 `disabled` 并写明原因。
- `public/app.js`：新增 `runRevisionTargetedRepair()`。**不新写一套判据**，把
  `runRevisionSemanticVerify()` 里"复修 → 重算候选 → 补一次复验 → 走 `revisionFinalizeFor()`"那段
  抽成共享函数（暂名 `applyRevisionRepairAndRecheck(ctx, jobBase)`），两处共用。
- 额度口径要跟着改：现在 `semanticRuns` 是"这份候选只能验一次"，复修换了候选 hash 之后就该重开一次额度。
  建议记 `verifiedHashes`（候选 hash 集合），而不是一个全局计数；否则"修好了却验不了"或"同一份反复付费"必居其一。
- `public/revision-closure.js` 的 `planAutoRepair()`：新增累计轮次入参（`roundsUsed`），
  让新按钮不能绕过 2 轮上限；预算按 `budget - 累计已花` 传。

验收（离线、零计费）：

- 新断言：`PARTIAL_CANDIDATE` 下 `actionsOf()` 必然包含 `repair-partial`；
  预算耗尽 / 全是硬阻塞项时该动作 `disabled` 且文案与实际原因一致。
- 新断言：`planAutoRepair({ roundsUsed: 2 })` 返回 `ROUND_LIMIT`；`roundsUsed: 1` 时仍可修一轮。
- 新断言：复修后候选 hash 变化时，复验额度重开；hash 不变时不重开。
- 回归：`node scripts/test-narrative-repair.mjs`、`node scripts/ci-offline-checks.mjs`、`node frontend-test.mjs`。

风险与回滚：

- 风险：作者可能连点，"每点一次都花钱"。缓解：按钮文案写明一次付费调用 + 累计预算上限，
  并在运行中禁用（沿用 `busy` 逻辑）。
- 回滚：`localStorage['ns_revision_targeted_repair']='0'` 关闭新按钮，不改任何既有行为。

## 五、方案 B：显式扩大授权跨度 + 多热点（P0.5，真正让 #5/#6 可被 AI 修）

方案 A 只是把"再修一次"补上；对 R3／R4 这两类问题，**再修一次也只能修局部**。要真修，得改授权模型：

- B1（多热点）：同一个 finding 可以对应**多处**原文（规则命中所有位置），plan 生成多个 hotspot，
  验收要求"全部位置都不再命中"才算解决。这一条主要解决 `#R-0005`（全篇同一句式）。
- B2（显式跨段授权）：作者在详情里对某条未通过项点"允许改：本段 / 本段起连续 N 段"，
  Host 把批准跨度写成 `merged_span_approved`，plan 才允许 condense/delete 覆盖它。
  这一条主要解决 `#R-0006`（删三段日常收尾）。
- 两道硬约束必须同时加：单次删除幅度上限（例如 ≤3 段 / ≤600 字）与保护区、`must_keep` 叠加；
  超限一律 `refused`，不静默降级。

风险：这是**放宽安全边界**，必须由作者逐次点按授权，不能默认打开。
回滚：开关默认关闭；关掉后行为与今天完全一致（condense 一律 refused）。

## 六、方案 C：人工处置出口（P1）

- C1（接受遗留）：对未通过项逐个"接受为已知遗留"，写进回执与章节级问题台账，
  合并按钮文案改成"合并（已记录 N 条遗留）"。好处是"我知道它没修"变成**可审计的记录**，
  而不是每次审稿再被报一遍。
- C2（在候选上手工改）：给候选一个受控编辑器，只允许改未通过项所在段落，改完照常跑
  确定性检查 + 一次复验。代价：绕过补丁协议，必须把 `must_keep`／保护区／幅度上限重新跑一遍，
  否则等于给正文开了个后门。工作量明显大于 A/B，建议放到最后。

## 七、推荐顺序与预估

- 第 1 步：方案 A（前端 + 额度口径 + 断言）。范围小、不动补丁协议、当天可验。
- 第 2 步：方案 B1（多热点）。这是"全篇同一句式"能被 AI 真正修掉的前提。
- 第 3 步：方案 B2（跨段授权，带幅度上限）。这一步要作者明确同意放宽边界。
- 第 4 步：方案 C1（接受遗留记账）。成本低，能立刻消灭"同一问题被反复报"。
- C2 视需要再说。

## 八、需要作者拍板的两件事

1. **要不要放宽"跨段删除/压缩"的授权**（B2）。不放宽的话，`#R-0006` 这类问题永远只能人工改。
2. **单次修稿的花费上限**。现在是 200 分（≤2 元）封顶；如果希望"一次点到底"，需要明确新的上限。

> 2026-10-22 裁决：第 1 项**放开**（作者原话"放开跨段授权"），实现见第十节 B2；
> 第 2 项维持 200 分封顶不变。

## 九、说明：本文的证据边界

- 以上结论来自**实际阅读**这些文件：`public/review-workspace.js`、`public/revision-finalize.js`、
  `public/revision-plan.js`、`public/revision-closure.js`、`public/app.js`（相关函数段）。
- 未读取：本次运行的 `localStorage` 运行记录（`ns_revision_run:*`）与数据库回执，
  因此**没有**逐条核对 `#R-0005`／`#R-0006` 这次复验模型给出的 `reason_code` 与 `repair_hint`。
  若需要"这一轮自动复修到底为什么没修成"的确切原因，要从存档的运行记录或章节回执里取，
  属于下一步的取证工作，不影响本方案的结构性结论。

## 十、实施状态（2026-10-22 落地）

方案 A、B1、B2、C1 已实现并附离线断言。

**B2（跨段授权，2026-10-22 作者明确放开"放开跨段授权"）**：

- 入口在**详情抽屉**：未通过项下面出现「允许改的范围：只本段 / 本段起 2 段 / 本段起 3 段」，
  另给「撤销批准」。批准只**记录**，真正生效要再点底栏「按已批准范围再修（N 段）」。
- 硬上限（`revision-closure.wideningApprovalOf`，纯函数、可离线复算）：
  一次 ≤3 段、≤600 字、段落不得重叠；段落里含**保护区**或 `must_keep` 内容一律 `PROTECTED` 拒绝。
  拒绝时把原因原样告诉作者，**不静默降级成"只改一句"**。
- 授权落地方式：批准过的段落逐段变成同一条问题的 `candidate_edit` 目标（带 `span_id` 消歧），
  计划与授权表由 `buildRevisionPlanV2` 重建 —— "能改哪几段"仍由 Host 的显式批准决定，
  模型拿不到"随便改哪都行"的能力。
- 旧格式审稿（v1 计划、没有结构化跨度）**不能**跨段：按钮会出现，但执行时会明确要求先重新审稿。

判据（单一来源，全部可离线复算）：

- `public/revision-closure.js` 新增三个纯函数：
  - `repairIssuesFrom(rows, semanticByIssue)` —— 把"终验行 + 语义结论"复原成可复修清单，
    关键是**保留 `remaining_evidence`**（旧实现漏这个字段，导致每轮复修都重放同一个跨度）。
  - `targetedRepairOf({rows, semanticByIssue, roundsUsed, maxRounds, budgetCents, estimateCents})`
    —— 复修目标/人处理项/剩余证据的唯一计算，界面按钮与执行体都读它。
  - `verifyAllowanceOf({candidateHash, verifiedHashes, mergedAt, reverifiedAfterMerge})`
    —— 复验额度按**候选 hash** 计：改过候选就重开一次；同一份不重复付费；合并后仍允许补验一次。
  - `acceptedLeftoversOf({rows, acceptedIds})` —— 已知遗留清单（只记账，不判通过）。

界面（`public/review-workspace.js` → `actionsOf` / `blockerText`）：

- `PARTIAL_CANDIDATE` 新增 `repair-partial`（写明条数与"一次付费调用"）、
  条件性 `repair-partial-widened`（有"作者批准过的段落"或"复验剩余证据"时出现，两种来源分别命名）、
  `accept-leftovers`；轮次用尽/超预算/全是人处理项时**置灰并写明原因**。
- 底部阻塞文案补上"下一步"（可只复修 N 条 / 需要人工处理），不再只报"未通过"。

执行（`public/app.js`）：

- 抽出 `applyRevisionRepairAndRecheck()` 与 `finalizeRevisionRun()`：复验后的自动复修与
  「只复修未通过项」按钮共用同一份复修/复验/收尾逻辑（不再各写一套）。
- 新增 `runRevisionTargetedRepair({widen})`：判据来自 `targetedRepairOf`，
  付费前先把进度条画出来；没产出补丁时如实提示并**不改候选**。
- `widen=true` 走 `revisionWidenedRepairPlan()`：按**全部已选问题**重建 v2 计划，
  把本轮要修的 issue 的"剩余证据"与"作者批准的段落"追加为 candidate_edit 目标
  （同一问题编号，不新增问题），并重新推导授权表；旧格式审稿（v1 计划）直接拒绝并说明原因。
- 跨段批准的记录在运行内（`ctx.approvedWidening`），可撤销；换候选/新建运行自然作废。
- `acceptRevisionLeftovers()`：确认后写本机台账 `ns_revision_accepted_leftovers:<workId>:<chapterId>`，
  绑定候选 hash（换候选自动失效），只记账。

新增断言：`tests/narrative-repair/19-partial-repair-entry.test.mjs`（V00–V39，40 条），
已登记进 `scripts/test-narrative-repair.mjs` 与 `scripts/ci-offline-checks.mjs`。

验证命令（全部离线、零计费）：

- `node tests/narrative-repair/19-partial-repair-entry.test.mjs`
- `node scripts/test-narrative-repair.mjs`（19 个套件）
- `node frontend-test.mjs`（前端接线，含"按钮真的渲染出来"）
- `node scripts/ci-offline-checks.mjs`
- `node .p1-baseline/verify-phase-map.mjs`、`node .p1-baseline/check-utf8.mjs`

回滚：`localStorage['ns_revision_auto_repair']='0'` 关掉自动/定向复修；
删本文件与新套件即回到"卡死"旧行为（代码改动落在既有文件，按各自阶段回滚）。

