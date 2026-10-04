# 「已有蓝图」为什么还在按旧蓝图生成（2026-10-04）

## 报障原文

> 什么叫已有蓝图？我重新ai生成了，就是可能因为前文改动或者蓝图不满意而让ai重新生成，
> 为什么还会按照原先的蓝图生成？给我修掉，让每次点击ai写作后，每次都要完整执行，先出蓝图

## 两个根因（都有实测证据）

### 一、写作入口有一条"已有蓝图就跳过蓝图轮"的捷径

`public/app.js` 的 `performToolbarAIWrite()` 里，只要本章 `chapters.blueprint_json` 能解析出
至少一个已知字段（`savedBlueprintForChapter()`），就：

1. 入口按旧蓝图做一次 `direction` 装配（`direction_source=saved_blueprint`），
2. **跳过蓝图生成轮**，直接把旧蓝图当成"已确认"送进成文轮，
3. 界面上只留一句「检测到本章已有蓝图：按已保存蓝图的方向写作（资料只召回一次）」。

这条捷径的初衷是"省一次模型调用 + 只召回一次资料"（C3 约束）。代价是**作者无法表达
"这一版我不要了，重新规划"**：结果弹窗里的「重新生成」也走同一个入口，于是"重新生成"
变成了"用旧蓝图重新写一遍正文"。

### 二、旧蓝图还会以「写作必须遵守」的形式回流进规划轮

`ai/context/layers.mjs` 里那一层的标题是 **「本章蓝图（写作必须遵守）」**（cap 1500，
source `chapters.blueprint_json`）。它不只在成文轮出现，**规划轮的上下文里也有它**：

```
GET /api/ai_context?chapter_id=121&library_recall_phase=defer&tools=0
→ assembled 16720 字，含「本章蓝图（写作必须遵守）」+ 旧蓝图全文
```

于是即便把入口捷径删掉，模型一边被要求"输出新蓝图"，一边读到"本章蓝图（写作必须遵守）"，
最省力的做法就是复述旧计划 —— 作者看到的仍然是"还是按原先的蓝图生成"。

## 修法

**前端（`public/app.js`）**

1. 入口一律 `libraryRecallPhase: 'defer'`，并显式 `omitLayers: ['blueprint']`：
   规划轮不带上一版蓝图。
2. 删掉沿用分支：`pendingConfirmedBlueprint` / `fromSavedBlueprint` 全部移除，
   蓝图轮照跑、`showBlueprintConfirm()` 照弹（作者能改、能重规划、也能跳过）。
3. `savedBlueprintForChapter()` 随之删除（连同它的用例 C1l）——留成死代码只会让
   "它还活着"看起来像真的。

**服务端（`server.js` + 装配器调用点）**

4. 新增请求参数 `omit_layers`，**白名单**只允许 `blueprint`（`OMITTABLE_LAYERS`）：
   不做"任意跳层"的通用后门 —— 上下文层是契约（清单/预算/审计都按 layers.mjs 算）。
5. `buildNovelContext()` 里按 `omitLayers` 决定要不要构造 `blueprint` 层；
   不传该参数时数组、顺序、字节数与接入前完全一致。
6. **进缓存键**（`|omit=blueprint`）：规划轮（无蓝图层）与成文轮（有蓝图层）的 assembled
   不同，不进键就会互相误命中——而这恰好会复现"拿到的还是上一轮的上下文"。
   两条端点（`/api/ai_context`、`/api/novel/context`）同口径。

## 验证

| 手段 | 结果 |
| --- | --- |
| `node frontend-test.mjs` | **397 PASS / 0 FAIL**（新增 `108p1`；改写 `C3e/C3e2/C3f`；删除 `C1l`） |
| `test-context-manifest.mjs` | 45 / 0（默认路径契约未变） |
| `test-context-contributions.mjs` | 27 / 0 |
| `test-context-cache.mjs` | 19 / 0 |
| 真实服务：同参数对照 | 默认 16720 字**含**「本章蓝图（写作必须遵守）」；`&omit_layers=blueprint` 15383 字**不含**，且 `context_manifest` 里没有 `blueprint` 层 |
| 真实服务：缓存不串线 | 先 omit 再默认、再 omit 再默认，四次各自正确 |
| 真实服务：第二条端点 | `/api/novel/context` 同参数同结果 |
| 真实服务：白名单 | `omit_layers=characters,world` 被忽略（仍含蓝图层），不报错、不扩权 |
| 服务端 `app.js` | 与磁盘逐字节一致（刷新页面即生效；服务端改动已重启） |

前端新判据（`C3e`）钉的就是本次报障：本章**已有** `blueprint_json` 时，
入口仍然 `defer` + `omit_layers=blueprint`，**不再出现** `direction_source=saved_blueprint`，
且第二次装配带 `direction_source=confirmed_blueprint`；`C3e2` 要求蓝图轮真的跑过一次、
确认框真的弹过一次。

## 第二轮（同日晚）：把「慢通道检索工具」这条残留通道也堵上

**为什么还有残留**：第一轮删掉的是**前端自己装配的上下文**里那一层。作者问的那句话来自
`harness_jobs#68674c8f`（10:49:03，晚于修复与刷新），它跑在**慢通道**上 —— 慢通道的模型
**带着检索工具**，那两条路各自去服务端取数据，绕过前端：

| 工具 | 打到哪 | 当时会返回 |
| --- | --- | --- |
| `novel_context` | `/api/novel/context`（没带 omit） | 含 `blueprint` 层（旧蓝图全文） |
| `novel_lookup` | `/api/search` | 章节行带 `blueprint_json` 字段，还会附一段「蓝图：…」摘要 |

**修法（跨三层，链路已存在，无需新机制）**

1. `public/app.js`：**规划轮**的慢通道任务带上 `env: { NOVEL_OMIT_LAYERS: 'blueprint' }`；
   成文轮不带（那时新蓝图已确认，必须能被查到）。
2. `server.js` → `harness.js`：`env` 本来就随 `/api/harness/run` 透传进子进程（现成通道，未改）。
3. `harness-plugins/novel-writing/novel-tools.mjs`：读 `NOVEL_OMIT_LAYERS`，
   给三处 `/api/novel/context` 追加 `&omit_layers=…`，并在 `novel_lookup` 的章节结果里
   跳过蓝图摘要（`omitsBlueprint()`）。

**验证**

- `node --check` 两个改动文件通过。
- 前端新用例 `P-OMIT-1`：强制规划轮走慢通道 → 该任务体带
  `env.NOVEL_OMIT_LAYERS=blueprint` 且提示词是蓝图轮；成文轮的调用不带该 env。
  全套 `node frontend-test.mjs` → **398 PASS / 0 FAIL**。
- 服务端那一侧（`omit_layers` → 装配器跳层、缓存键后缀、两条端点、白名单）已在第一轮实测。

**这一轮之后，规划轮仍然能看到的东西（不是蓝图，是"书里已经发生的事实"）**

长期记忆（故事摘要）、事件账本、章节摘要（`chapters.summary`／当前场景层）、本作章节的
检索命中、角色卡、世界观、词条、大纲与剧情线。作者今天那句「第一章现有的蓝图里…」读到的
正是这些（我把那份 15671 字的装配文本逐层搜过：`本章蓝图` 0 命中，而
"江陵市第三检测中心 / 李拓 / 林清雪" 出现在长期记忆、事件账本、章节摘要与检索命中里；
"学校把高三学生集体带过去排队"这几个字**任何一层都没有**，是模型自己的归纳）。

**结论**：删掉蓝图层不会让这些消失 —— 它们是故事本身。要连它们也不看，属于**改产品语义**
（作者已就此提出"C2：全部重新生成"的范围确认）。

## 第三轮（同日晚，作者选定）：把每次 AI 写作当作「重写本章」

作者原话：**"我点击ai写作后，无论哪个方向写作，一切都与前面的无关，全部重新生成"**，
并在三选一里选了「重写本章」（不是"真白纸"，也不是"只砍蓝图"）。

**语义**：点一次「AI 写作」= 把这一章重写一遍，**本章既有记录一概不看**：

| 不看（跳层） | 保留（这本书的设定） |
| --- | --- |
| `blueprint` 上一版蓝图 | `work` 作品简介与配置 |
| `scene` 本章摘要/当前场景 | `outline` 大纲与剧情线 |
| `memory` 长期记忆（故事摘要） | `characters` 出场角色卡 |
| `events` 事件账本 | `world` 世界观 |
| `foreshadows` 未闭合伏笔 | `terms` 设定词条 |
| `recall` 本作章节的语义召回 | `redlines`/`edit_rules` 写作纪律与编辑规则 |

**实现**

- 前端 `REWRITE_OMIT_LAYERS`（6 项）用于规划轮的装配与慢通道任务的 env 标记；
  `REWRITE_OMIT_LAYERS_PROSE`（少 `blueprint`）用于**成文轮** —— 成文发生在作者确认新蓝图之后，
  那一层此刻装的是新蓝图，必须可见。
- 服务端 `OMITTABLE_LAYERS` 扩到这六项，并逐层加了 `omitLayerIds.has(x) ? [] : [L(x, …)]` 守卫；
  **不传该参数时数组内容与顺序逐字节不变**（既有上下文契约测试 45/27/19 全绿）。
- 插件在「重写本章」模式下额外隐藏 `novel_lookup` 的**章节摘要**段与**记忆库语义召回**段，
  并如实回报"本次是重写本章，章节既有记录与记忆库召回已被排除"，避免模型以为工具坏了。

**同步问题（自查后按原样保留，未加新机制）**：跳层让这一章按新设定重写，而事件账本/长期记忆里
还是旧事实。核对时我先在采纳路径上强行补了一次"入账提案"，随后**撤掉**：慢通道的精写内核本来就会
调 `novel_event_add` / `novel_memory_update` 提交入账提案（`needsLedger = proseData.via === 'direct'`
那条判据的存在理由），重写模式下再补一次会变成**两套提案**。也就是说这条链本来就闭合：
直连成文 → 前端补一次入账；慢通道成文 → 内核自己提案。作者在两类提案里逐条确认即可。

**补充说明（决策插件）**：这次的范围确认（C2）我提交了两次裁决，插件都返回
`INSUFFICIENT_CONTEXT / MODIFY_REQUIRED_BUT_ONLY_THE_USERS_OWN_DAMAGING_OPTION_WAS_GIVEN`
—— 它判定"整层去掉"属于有损做法，要求给出一个**不删层**的替代方案。该项因此在账本里保持
PENDING；功能按作者明确指令已上线，账本口径与此处结论一致（未自行标记为已决）。

**验证（真实服务，重启后）**

| 请求 | 层数 | 长度 | 六个层 |
| --- | --- | --- | --- |
| 默认装配 | 16 | 17230 字 | 全部在 |
| `omit_layers=blueprint,scene,memory,events,foreshadows,recall` | 10 | 12119 字 | 全部不在 |
| 同上 + `characters,unknown_layer`（白名单外） | 10 | — | 六个仍被排除，角色卡保留（未知项被忽略） |

装配文本里已无「本章蓝图 / 长期记忆 / 事件账本 / 未闭合伏笔」；保留 work/outline/characters/
world/terms/redlines；缓存不串线（再取默认仍带 blueprint 层）。前端 `frontend-test.mjs`
**399 PASS / 0 FAIL**（`P-OMIT-1` 验慢通道标记、`P-OMIT-2` 验两次装配的 omit 参数）。

**代价（如实说明）**：这一章会与已写章节的事实脱钩——这正是"与前面的无关"的字面含义。
后面几章的长期记忆/事件账本仍是旧事实，需要作者在采纳新稿后自行同步（或让我来同步）。

## 第四轮（同日晚，作者报障）：AI 交互弹窗不再被"误触遮罩"关掉

作者原话：**"再进行ai写作的时候，弹出提问窗口，为什么我鼠标不小心点到窗口外面会自动关闭窗口？
取消掉这个功能，要避免"**。

**根因**：`openModal()` 早就带了 `protectedBackdrop` 开关（点遮罩只提示、不关闭），
但只被**采纳冲突框**用上；AI 写作这条链上的两个框都没传它：

- `askAIQuestion()`（提问窗口）——点遮罩会走关闭分支，而"没输入过"时 `modalDirty()` 为假，
  于是**直接关闭**：`state.pendingAIQuestion` 被 resolve 成 null = 整次写作取消。
  作者只是鼠标滑出去，却丢了这次生成。
- `showBlueprintConfirm()`（蓝图确认框）——同一个形状：它是要填/要改的表单，关掉＝放弃这次写作。

**修法**（两处各加一行，复用既有机制，不新增交互）：

```js
protectedBackdrop: true   // askAIQuestion / showBlueprintConfirm
```

关闭仍走明确动作：右上角 ✕、或「取消」按钮（这条路径不受影响）。

**验证**：新增前端用例 `P-MODAL-1/2/3` —— ①提问框带保护（`state.modalProtected === true`
且渲染出 `ai-writing-question`／`ai-writing-answer`）；②保护状态下 `closeModal()` 仍立即关闭
（pending 解析为 null，等同于点 ✕）；③蓝图确认框同样带保护。全套 `frontend-test.mjs`
→ **402 PASS / 0 FAIL**；服务端 `app.js` 与磁盘逐字节一致。

**同类保护的覆盖口径（第三处报障后改口径）**：作者随后又截了**第三处**——
「✍️ AI 写作 · 写点什么？」需求框，同样被点外面关掉。逐个补是在追着报障跑，
而误触关闭的代价是不对称的（丢输入 / 取消一次正在跑的付费任务），所以把口径改成：
**`openModal` 的 `protectedBackdrop` 默认 true —— 所有弹窗都不再被点遮罩关闭**，
只提示「点窗口外面不会关闭：请用右上角 ✕ 或「取消」按钮」。
仍想"点外面就关"的纯信息/预览弹窗，显式传 `protectedBackdrop: false`（该能力保留并有回归守着）。

**验证**：`P-MODAL-1..6` —— 提问框 / 蓝图确认框 / 需求框都带保护；
保护状态下 `closeModal()` 仍立即关闭（pending 解析为 null＝明确的取消）；
`openModal` 默认保护、显式 `false` 可放行。全套 `frontend-test.mjs` → **405 PASS / 0 FAIL**；
服务端 `app.js` 与磁盘逐字节一致。

## 第五轮（同日晚）：蓝图不得被当成「生成稿」存进草稿

作者原话：**"19:44:55 又一次成文 1589 字草稿（已在恢复条上）这个是蓝图，不是正文"**。

**查证**：`chapter_save_versions#66`（ch=119，1599 字节）内容为
`<p>【蓝图】<br>{"scene_goal":"江陵三中操场的全民觉醒日仪式上…` —— 与计划轮那次慢通道任务
（`harness_jobs#3d07e6ce`，1589 字）逐字同源。恢复条因此显示「有未应用的生成稿（1589 字）」，
点开却是一段蓝图 JSON（同类事故 2026-10-01 已发生过一次）。

**根因**：「这看起来是不是章节正文」的判断此前**只做在前端成文轮那一处**
（`detectNonProseOutput`），而草稿有**三条写入通道**：长任务产出回填、`/novel/finalize` 回填、
以及界面直接 `POST /novel/draft`。规划文本从没有这道闸的那条通道进去了。

**修法（判据下沉到服务端收口处）**：新增 `looksLikeBlueprintText()` ——
过程头 `【蓝图】/【规划】/【写作规划】` 开头，或 JSON 里出现 **≥3 个**蓝图专有字段名
（`scene_goal` / `plot_points` / `conflicts` / `character_changes` / `hook` / `references`，
保守判据，正文里出现"场景目标"这类词不会命中）；挂在两个落草稿的通道上，命中即 `400`
并回显原因「这是写作规划（蓝图），不是章节正文：已拒绝存成生成稿（正文未被改动）」。

**验证（真实服务，重启后）**

| 请求 | 结果 |
| --- | --- |
| `POST /novel/draft` 送真实蓝图原文 | **400**（拒绝） |
| `POST /novel/finalize`（kind=prose）送同一份蓝图 | **400**（拒绝） |
| `POST /novel/draft` 送正常正文（控制组） | **201**，新增一行草稿 |
| 被拒请求之后核对草稿行数 | **未增加**（拒绝 ≠ 没写进去，靠行数确认） |

前端 `frontend-test.mjs` **406 PASS / 0 FAIL**（第五轮同时修掉：提问轮的任务产出是**问句**，
此前一直以「已完成，结果待应用」挂在恢复条上 —— 现在问句展示后立刻标记已应用，`P-Q-1`）。

**清理与披露**：验证控制组时我造出的一行测试草稿（`#67`，20 字节）已用作者频道删除；
作者那条 `#66` 他自己已点 ✕ 关闭（`dismissed=1`，内容仍在库里）。

## 影响与代价（如实说明）


- 每次点「AI 写作」（含结果弹窗的「重新生成」）都会多一轮蓝图模型调用；这是作者明确要的
  "每次都要完整执行"。
- 快速通道仍在：蓝图确认框里的「跳过蓝图直接成文」。
- 旧蓝图在作者**确认新蓝图之前**仍留在 `chapters.blueprint_json` 里；确认后按既有行为覆盖。
