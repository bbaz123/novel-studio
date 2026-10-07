# 确定性连续性预检（continuity-guard）

> 落地自 `2026-09-22` 复核报告的第 1 步（以及第 4 步的「内联进 AI 审稿提示词」）。
> 判据写在 `ai/continuity-guard.mjs`（纯函数）、装配写在 `ai/continuity-guard-source.mjs`（只读），
> 接线在 `server.js` 的两条端点与 `public/app.js` 的审稿/成文路径。**它不调用任何 AI，零 token。**

---

## 一、为什么要有它

两份真实审稿报告（作品 18 的第 5、6 章）里，占比最高的一类 issue 是「与既有设定/大纲冲突」。
这类问题里有一部分是**机器直接算得出来**的——角色卡的时点、篇幅口径、系统出场次数、剧情线推进间隔。
把它交给付费的 AI 审稿，有两个确定的代价：

- **它算不准**。第 6 章审稿把 3897 字的定稿估成「约五千字以上（估 5000–5600 字）」；
  让模型去数数，等于把确定性工作交给一个会算错的执行者。
- **它要花钱、要等**。几分钟的等待里，其中一部分本可以是 0.2 秒的本地计算。

所以这里的分工是：**机器能判定的先判掉，剩下的判断再交给 AI**。findings 不会替代 AI 审稿，
而是作为审稿的**起始上下文**（与既有的「写作红线扫描」并排），让模型不必从零发现这些事实。

### 与既有机制的分工（刻意不重复）

| 已有的机制 | 管什么 | 本预检是否重复 |
|---|---|---|
| `server.js` 的 `scanAgainstRedlines`（写作红线） | 反 AI 腔**词句** | 不重复（它已在审稿前内联进提示词） |
| `/api/novel/consistency` + `novel_consistency` 工具 | 正文是否违反本章蓝图、未登记实体 | 不重复（那需要语义判断） |
| 成文弹窗的 `articleLengthHint` | 成文**不足**目标字数 | 不重复（本预检只判**超上限**） |

---

## 二、四项检查

检查项 id 清单在 `GUARD_CHECKS`；`findings[].category` 是它 + 三个细分项：

### 1) `character_time_point` —— 角色卡时点越界（**首版第一项**）

两份审稿报告的**第 1 条 issue 说的都是它**。根因不是「状态太薄」，而是**状态没有时点**：
岳宸炎的 `characters.status` 写的是「第一卷末：暗夜修罗身份引发全城追查…」，
`identity` 写的是转学**之后**的学校——而第 5、6 章的时间点还在转学之前（转学发生在第七章）。
生成端照着卡写、审稿端照着卡判，冲突是必然的。

判据只认**可判定的时点标记**：`第X卷`、`第X卷末`、`最终卷`（`parseVolumeMarkers`）；
认不出来就**不猜**（假阳性会让作者关掉整个预检）。

| 情形 | 严重度 |
|---|---|
| 卡片写的是**后续卷**的事实，而本章还在更靠前的卷 | warning |
| 卡片写的是**最终卷**的事实，而本章不在最终卷 | warning |
| 同一卷，但把**卷末**状态用在卷中（卷内倒数第 2 章之前，`VOLUME_END_LEAD_CHAPTERS=2`） | warning |
| 反向：卡停在了**更早**的卷（可能过期） | info |
| 本章没有卷信息（`volume_id` 为空） | **不判**（判据缺一半时不猜） |

### 2) `system_frequency` —— 系统出场频率

上限取自**作品自己的风格文本**（本作 `style_positive`：「系统每章有效出场约 5～15 次，不要每段都有」）。
解析不到时用兜底值 `DEFAULT_SYSTEM_MENTION_MAX = 15`。

- 只判**超上限**，不判低于下限：系统出场少是叙事选择（第 1 章就该只有 2 次）。
- 计量的是**字面命中次数**，它是「有效出场」的**近似值**（一次出场可能被写多次）——
  所以刚好超线只报 **info**，达到上限 **1.5 倍**（`SYSTEM_OVERRUN_HARD_RATIO`）才升级为 **warning**。

### 3) `chapter_length_target_conflict` / `chapter_length_over` —— 篇幅

**口径冲突**（info，是数据问题不是写作问题）：本章 `target_words`、作品 `default_chapter_words`、
风格文本里的区间三者不一致时报出来。作品 18 就是三套尺子同时在用：
第 5、6 章目标 3000 字、作品默认 4000 字、风格写「单章 3000～5000 字（默认 4000）」——
AI 写作按 3000 补足、审稿却按 4000 判，于是「篇幅不足」这条 issue 是必然会出现的。

**超上限**（warning）：超过风格区间的上限时报；风格文本里解析不到区间时，退回
`max(本章目标, 作品默认) × 1.25`（`DEFAULT_LENGTH_OVERRUN_RATIO`）并注明是推定值。

⚠️ 字数口径**必须与应用内显示一致**：剥标签 + 去掉所有空白（`public/app.js` 的 `plainLength`）。
装配层统一走 `text-utils.js` 的 `htmlToPlain`，不新写剥标签正则——否则会出现
「界面显示 3897、预检说 4505」，作者会先怀疑工具，再怀疑正文。

### 4) `plotline_stalled` / `plotline_not_started` —— 剧情线推进间隔

数据早就够用：`chapters.plotline_id` 已把 50 章全量分配到 4 条线，
所以「某条线多久没推进」直接用章节序号算，**不需要新字段**。

| 情形 | 严重度 |
|---|---|
| 推进过、又连续 N 章没有推进（默认 `DEFAULT_PLOTLINE_STALL_CHAPTERS = 4`） | warning |
| 一章都没轮到（在已规划范围内有归属章，但已写正文里一章都没有它） | info（作品早期属正常，交由作者判） |

> 阈值 4 的来历：外部参照 Novel-OS 的 `DORMANT_THREAD_GAP_CHAPTERS=3`，但那是按「章」计的通用值，
> 本作是 4000 字/章的长章，故取 4。**这是作者口径，不是唯一答案**——见第四节。

---

## 三、输出与呈现

### 端点

```text
POST /api/novel/continuity_guard
     body: { work_id, chapter_id?, text? }        # text 省略/空串 = 用库里这一章的正文
     resp: { ok, findings:[{category,severity,entity_id,message,suggestion,evidence,key}],
             exempted:[同形], summary, checked }
     404：作品或章节不存在（或章节不属于该作品）；400：缺 work_id

POST /api/novel/continuity_exemption
     body: { work_id, key, action: 'exempt'|'restore', reason? }
     resp: { ok, action, key, keys }
     400：缺 work_id / 缺 key

POST /api/novel/continuity_thresholds            # 作者口径；模型通道一律 403
     body: { work_id, thresholds: { plotlineStallChapters?, systemMentionMax? } }
     resp: { ok, work_id, thresholds }           # 回传**清洗后**的实际落库值
     400：缺 work_id
     # 只白名单判据真正消费的两个键，且只接受 >0 的整数——与 ai/continuity-guard.mjs 的
     # "Number(x) > 0 才算覆盖、否则回默认值"同一口径，避免把永远不生效的值写进设置。
     # ⚠️ 诚实标注：本版**只有接口、没有界面入口**（作者要改仍需手动发一次请求）。
```

`key` 由**服务端**算好下发（`findingKey`）：键的定义只在 `ai/continuity-guard.mjs` 一处，
前端不重复实现——同一判据两处实现必然漂移，而漂移的后果是「点了豁免却不管用」，界面上看不出来。

**不给 `chapter_id` 时**（前端在拿不到章号时刷新预检块的那条路径）：只跑**作品级**的
「剧情线推进」，需要章的三条（角色卡时点 / 系统出场 / 篇幅）一律不判——判据缺一半时**不猜**。
界面与审稿提示词都会写明「未指定章节」，**不写成"四项都通过"**（缺判据却假装零命中是坏预检）。
（2026-09-22 复盘实测：修之前这条路径会算出 `system_frequency:chapter:` 这种**空章号键**，
与列表里的键对不上 → 豁免静默失效、界面多出看不懂的条目。）

### 界面

- **成文弹窗**：`#continuity-guard-slot` 异步填充预检块；每条 finding 带一个
  **「这是故意的」**按钮（写豁免），已忽略的条目可**恢复**。
- **AI 审稿前**：先跑红线扫描，再跑本预检，两段都内联进审稿提示词。
  预检那段被明确定义为**已知事实**：模型确认成立的写进 issues，判断不成立的
  （例如字面统计与「有效出场」的差异）可以不写，但要在 summary 里说明为什么——
  它可以否决，但不该对此一无所知。
- 预检**失败不阻塞**：拿不到结果时提示词里不出现这一段（缺判据时不假装「零命中」）。

---

## 四、阈值与豁免：都是你的口径

两样都落 `app_settings`（key-value，**零迁移、零 schema 改动**）：

```text
continuity_thresholds:<workId>   →  {"plotlineStallChapters": 4, "systemMentionMax": 15}
continuity_exemptions:<workId>   →  {"system_frequency:chapter:123": {"reason": "…", "at": "…"}}
```

- **阈值**：`plotlineStallChapters`（剧情线停滞章数）、`systemMentionMax`（系统出场上限）。
  代码里的默认值只是**兜底**，作品级设置优先；`systemMentionMax` 还会先尝试从
  `style_positive` 解析（「系统每章有效出场约 5～15 次」→ 取 15）。
- **豁免键 = `category:entity_id`**，`entity_id` 形如 `character:<id>` / `chapter:<id>` / `plotline:<id>`。
  **故意不含措辞、不含章节号**：检查改进措辞、或同一个矛盾换个章节再出现时，
  你按过的「这是故意的」不会悄悄复活。
- 解析失败一律退回空对象：**坏配置不该让预检整个不可用**（宁可少一条豁免，也不要挡住写作）。

---

## 五、它在你自己的作品上成立吗（通过线）

判据是「在可确定复现的 4 条里至少复现 2 条、且误报 ≤1 条/章」才允许扩面。实测（作品 18）：

```text
命中 5｜漏报 0｜误报 0｜本轮全部发现 18 条（2/3/3/3/4/3 条/章）
  第五章 3/3：角色卡时点 ×2 + 系统出场（20 次 > 15）
  第六章 2/2：角色卡时点 ×2          ← 篇幅那条**必须不报**（现定稿 3897 字，在 3000～5000 内）
  豁免闭环：全部命中项都能被 `category:entity_id` 精确过滤掉
```

第 6 章的「篇幅」是特意写进期望表的**阴性对照**：两份审稿报告针对的是**更早的草稿**
（审稿 12:52 / 13:32，章节最后修改 13:17 / 14:04），而当前定稿已经改好了——
一个会拿旧草稿的结论去报新定稿的预检，是坏的预检。

自己复现：

```powershell
node .p1-baseline/test-continuity-guard.mjs                     # 离线真值表 + 阴性对照（67 条断言）
node .p1-baseline/verify-continuity-guard-on-real-data.mjs      # 真实作品上的命中/误报/豁免（只读）
node .p1-baseline/verify-continuity-guard-on-real-data.mjs --db <path> --work <id> --verbose
```

---

## 六、刻意不做的（燃料为空）

首版只收**有真实燃料**的检查——每条都能在真实库里读到数据。以下几条被评估过并**放弃**：

| 候选检查 | 为什么不收 |
|---|---|
| 角色缺席（本章该出场却没出场） | `chapters.context_character_ids` 全库 **0/50** 非空——该字段是手动勾选的「强制带入」，从未被使用过 |
| 事件 payload 冲突比对 | 作品 18 的 6 条 `story_events.payload` **全是 `{}`**；结构化事实只存在于示例作品 |
| 关系孤儿 / 自环 | 误报不可控，且现有 6 条关系数据量太小，测不出真问题 |
| 未登记实体 | 已由 `/api/novel/consistency` 覆盖（需要语义判断） |

没有燃料的检查会让界面永远显示「无问题」——那比不检查更糟：**它假装检查过了**。

---

## 七、还没拍板的（工具只把冲突摆到台面上，不代你决定）

本预检**故意不改任何作品数据**（`chapters.target_words`、角色卡状态、风格文本一律原样）。
它报出来的东西里有四件是作者决策，不是代码能定的：

1. **剧情线停滞阈值**（默认 4 章）——长章/短章、多线/单线的合理值不一样；
2. **系统出场判据**——「有效出场」是写作概念，字面命中只是近似（可换用更贴切的关键词）；
3. **篇幅的权威口径**——章节目标 / 作品默认 / 风格区间，三者选一为准，其余降为参考；
4. **角色卡是否拆「时点」**——按卷拆卡、还是卡里只写本章语境的状态。

四条都已进 `docs/pending-decisions.md`。改口径只需要改 `continuity_thresholds:<workId>` 或作品数据，
**不需要改代码**——这也正是把阈值放在 `app_settings` 而不是写死在判据里的原因。
3. **篇幅的权威口径**——章节目标 / 作品默认 / 风格区间，三者选一为准，其余降为参考。
   ⚠️ **2026-09-22 更新**：这条的**误报已经修掉**——审稿提示词现在声明「与写作路径同源」的权威值
   （章节覆盖 > 作品默认），所以模型不会再按风格文本报「篇幅不足」。仍未定的是**数据要不要统一**，
   那属于你的口径；不统一也不影响使用（预检会继续以 info 提示这条冲突）。
4. **角色卡是否拆「时点」**——按卷拆卡、还是卡里只写本章语境的状态。

四条都已进 `docs/pending-decisions.md`；逐项的自动裁决（谁 MODIFY、谁 KEEP、为什么）见
`docs/confirmation-resolution-2026-09-22.md`。改口径只需要改 `continuity_thresholds:<workId>`
或作品数据，**不需要改代码**——这也正是把阈值放在 `app_settings` 而不是写死在判据里的原因。
