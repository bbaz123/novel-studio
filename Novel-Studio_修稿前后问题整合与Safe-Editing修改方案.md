# Novel Studio 修稿前后问题整合与 Safe Editing 修改方案

> 基于同一章节“审稿前初稿”与“自动审稿后版本”的对照验收。
>
> **核心结论：生成端优化已经基本成功；当前主要瓶颈已经从“AI 不会写”转移为“自动修稿器会把原本正确的内容修坏”。**
>
> 第三阶段不应继续大幅强化“去 AI Prompt”，而应重点建设 **Safe Editing / 安全修稿层**。

## 一、总体判断

### 审稿前初稿

与方案执行前相比，已经明显解决：

- 章内任务状态回退；
- 同一检测机制反复完整展示；
- 场景平均分配篇幅；
- 角色对白趋同；
- 作者替读者总结；
- 系统文标准化章尾；
- 世界观信息一次性解释过满。

整体 AI 味由最初约 **7.5/10** 降到约 **3.5～4/10**。

因此：**生成端主体建议冻结，不再大幅增加新的“去 AI”规则。**

### 审稿后版本

去冗余能力有效，但自动修稿安全性未通过。

正确修改包括：

- 李拓 A 级多层“很亮”的证明被压缩；
- “像走红毯”等概括被替换为行为；
- 王磊重复耳机动作有所减少；
- 章尾显式总结被删除。

但新增严重问题：

- 海澜直播场景主语丢失；
- 场景锚点被删除；
- 王磊递面包动作被删，导致面包凭空出现；
- 王磊人物关系信息被误伤；
- 为解释排队时间，新增整套 B 区错号剧情；
- S / SS 等正式事实存在被修改风险；
- Patch 后未可靠发现新引入的连续性错误。

结论：**第二阶段诊断能力基本成功，但自动修稿层未通过安全性验收。**


## 二、审稿前初稿仍有的问题

### 1. 角色专属动作饱和

王磊的耳机从人物特征开始接近人物标签：摘、挂、绕、捋出现过密。

问题不是“耳机不能写”，而是：

> **人物专属动作也会从人物特征退化成模板。**

保留真正有功能的几次即可：第一次建立紧张习惯、检测前交给岳宸炎、结尾作为状态回声。

### 2. `information_saturation`

李拓 A 级的金红、比喻、光柱、大厅暖调、横幅发白、钢架影、学生挡眼，主要都在证明：

> **A级很亮、很有排场。**

应由诊断层压缩，而不是继续修改生成主 Prompt。

### 3. D级后的群众反应仍稍满

学生回头、女生欲言又止、男生说“可惜”、旁边人碰胳膊、学生举手机，主要都在证明：

> **大家注意到D级，并觉得可惜。**

保留最有信息量的一处即可。

### 4. 岳宸炎存在“标准冷静男主”长期风险

建议人物卡增加：

```text
composure_breakers
interaction_patterns
```

重点不是强行让他情绪爆发，而是明确什么能真正破坏他的稳定，以及他在不同关系中的交流策略。

### 5. 区分有推进的重复与无推进重复

王磊反复说“我肯定是A级”，虽然字面重复，但语境从吹牛、打气逐渐变成紧张、自我确认，属于：

```text
repetition_progression
```

应优先保留。

李拓多种“很亮”的描写字面不同、功能却没有推进，属于：

```text
functional_redundancy
```

不能用简单重复次数处理。

### 6. 疑似伏笔进入长期验证

海澜裂缝、检测石异常不能当前直接判错。

建议：

```text
seeded → reinforced → paid_off
                    ↘ intentionally_abandoned
                    ↘ stale
```

`stale` 用于抓长期没有意义的 AI 假伏笔。

### 7. 跨章结构相似度

第一章“A级案例 → C级朋友 → S级异常 → D级主角 → 系统”单独看没有问题。

若后续反复使用相同宏观节拍，再由：

```text
cross_chapter_structure_similarity
```

提示。


## 三、审稿后新增的严重问题

### 1. `reference_anchor_error`

修稿后出现：

> 从通道走出来，头发是浅色的，编成低马尾。她走到检测台前……

首次人物主体被删，“她”的前置对象不完整。

### 2. `scene_anchor_error`

原本：

```text
岳宸炎人在江陵
→ 看全国直播大屏
→ 大屏切到海澜
→ 海澜女生出现
```

修稿后场景入口被删除，读者短时间无法确认当前看到的是江陵现场还是屏幕中的海澜。

### 3. `orphan_object`

修稿前：

```text
王磊拥有面包
→ 王磊递给岳宸炎
→ 岳宸炎拿着
→ 岳宸炎吃
```

修稿后删除了“王磊递面包”，但后文继续出现岳宸炎手里的面包。

这是严重物件来源断裂。

### 4. 高功能密度人物细节被误伤

“王磊把面包递给岳宸炎，一个字没说”同时完成：

```text
朋友关系
+ 不知道怎么安慰
+ 从话多到沉默的人物变化
+ 后文面包来源
```

不应删除。

### 5. B区补丁 `fact_delta` 过高

为解释“为什么傍晚才检测”，修稿器新增：

```text
B区少队
→ 错序号
→ 岳宸炎误入B区
→ 排错队
→ 被赶回来
→ 重新排号
```

只是修一个轻度时间疑问，却新增多个剧情事实。

### 6. `fact_mutation` 风险

如果正式设定中海澜女生是 SS，而修稿器改成 S，就属于正式事实变更。

等级、人物历史、关系、制度等必须服从 `story_contract`，不能由风格审稿器自行决定。


## 四、第三阶段目标：Safe Editing

新的目标不是继续 Anti-AI，而是：

> **在减少冗余的同时，严格保证原文已经成立的事实、因果、物件、指代、人物关系和场景坐标不被破坏。**

职责拆分：

```text
事实系统 → 不写错
作者样文 → 像作者
叙述取舍 → 不像机器
Patch Safety → 不越修越坏
```

## 五、建立 `structural_dependencies`

Patch 前抽取轻量依赖：

```text
人物 → 当前地点
人物 → 持有物
人物 → 当前任务
代词 → 指代对象
动作 → 前置条件
后文事实 → 来源事件
场景 → 视觉/听觉来源
```

重点保护：

| 类型 | 作用 |
|---|---|
| `causal_bridge` | A 为什么导致 B |
| `object_bridge` | 物件怎么到了这里 |
| `scene_anchor` | 当前地点、视点、屏幕、时间 |
| `reference_anchor` | “他/她/这个东西”指向谁 |

## 六、增加 `fact_delta`

每个 Patch 输出：

```json
{
  "fact_delta": {
    "added": [],
    "removed": [],
    "mutated": []
  }
}
```

风险等级：

```text
0 = wording_only
1 = clarification
2 = new_local_fact
3 = canon_change
```

- Level 0：纯表达压缩，可自动应用。
- Level 1：轻度显式化，需记录与安全检查。
- Level 2：新增局部剧情事实，默认不能自动应用。
- Level 3：改变世界观、人物历史、关系、等级，必须作者确认。

## 七、增加 `deletion_dependency`

`fact_delta` 防乱加，`deletion_dependency` 防乱删。

删除“王磊递面包”前，扫描后文所有“面包”引用。如果后文依赖该来源：

```text
safe_to_delete = false
reason = object_provenance
```

删除“全国直播大屏切到海澜”前，同样检查后文的“她、海澜场馆、雪”等是否依赖该 `scene_anchor`。


## 八、Patch Safety Gate

建议链路：

```text
诊断
→ Patch Proposal
→ Patch Safety Check
→ 应用 Patch
→ Diff-aware Post-Patch Verification
→ 最终全文
```

安全检查至少回答：

1. 是否删除后文需要的物件来源？
2. 是否删除代词首次指代对象？
3. 是否删除场景切换锚点？
4. 是否删除事件发生原因？
5. 是否新增世界观 / 制度 / 历史事实？
6. 是否改变已有事实值？
7. 是否改变人物动机？
8. 是否破坏 `protected_content`？

高风险项命中，不得自动应用。

## 九、增加 `edit_scope`

### Level 1：`wording`

纯表达修改，不改变事件、人物、物件、地点、时间、因果。

**允许自动执行。**

### Level 2：`local_structure`

合并群众反应、压缩重复动作、调整局部段落。

**通过 Patch Safety 后才能执行。**

### Level 3：`story_fact`

新增事件、制度，修改等级、人物动机、时间线、关系、角色重要选择。

**禁止自动执行，只输出建议。**

## 十、增加 `edit_cost`

修复同一问题时：

> **优先最小 edit_cost + 最小 fact_delta。**

例如解释“为什么傍晚才检测”：

```text
方案A：轻微调整初始排队位置
edit_cost = very_low
fact_delta = 0

方案B：在正式设定支持下补一句中午暂停
edit_cost = low
fact_delta = 1

方案C：新增完整B区错号支线
edit_cost = high
fact_delta = 6+
```

若 A/B 足够，就不能选 C。

## 十一、增加 `repair_necessity` 与 `confidence`

小说里的疑问不等于必须修。

每个问题同时记录：

```text
severity
repair_necessity
confidence
```

决策：

| Confidence | Repair necessity | 行为 |
|---|---|---|
| 高 | 高 | 阻止错误稿交付 / 修复 |
| 高 | 低 | 给建议，不一定改 |
| 低 | 高 | 重新诊断 |
| 低 | 低 | 不处理 / deferred |

排队时间跨度可能是 `medium confidence + low necessity`；面包凭空出现是 `high confidence + critical necessity`。


## 十二、Post-Patch Verification 必须 Diff-aware

不能只重新跑原审稿。

系统必须知道刚才：

```text
删了什么
加了什么
改了什么
```

删除递面包动作后，自动扫描所有后续“面包”引用。

删除人物首次出现后，自动扫描：

```text
他 / 她 / 它 / 这个 / 那个 / 这里 / 那里 / 前者 / 后者
```

确认 antecedent 仍存在。

重点检测：

```text
orphan_object
reference_anchor_error
scene_anchor_error
causal_bridge_break
fact_mutation
```

## 十三、扩展 `protected_content`

除好对白、人物辨识度和反类型选择外，还应保护：

```text
causal_bridge
object_bridge
scene_anchor
reference_anchor
character_relation
expectation_break
```

本章建议保护：

- “我信A级存在。没说你。”
- “C级。嗯。强化皮肤。挺好。”
- “我陪你等。”
- 王磊把面包递给岳宸炎，一个字没说。
- “掌心是热的，石板还是凉的。”（deferred）
- 系统第一句普通模板台词及其后的沉默。
- 章尾不急着解释系统功能。

## 十四、第三阶段回归测试

### Test 1：面包

```text
王磊把面包递给岳宸炎。
……
岳宸炎吃面包。
```

若 Patch 删除第一句：

```text
REJECT
reason = orphan_object / object_provenance
```

### Test 2：直播女生

```text
大屏切到海澜市。
一个女生从通道走出来。
她……
```

若删除场景锚点或首次人物介绍：

```text
REJECT
reason = scene_anchor / reference_anchor
```

### Test 3：B区

原文只有轻度时间跨度疑问，Patch 却新增多个剧情事实：

```text
REJECT AUTO-APPLY
fact_delta_risk >= 2
```

重新寻找事实增量更小的方案。

### Test 4：李拓A级

删除多余光效比喻，但事件、人物、场景不变：

```text
ALLOW
edit_scope = wording
fact_delta = 0
dependencies = intact
```

### Test 5：结尾

删除“他坐着等系统下一句”，前文已充分表现等待：

```text
ALLOW
```

但不要因为删总结就自动补一个环境意象。

## 十五、实施优先级

### P0：必须先做

1. `Patch Safety Check`
2. `fact_delta / fact_mutation`
3. `deletion_dependency`
4. `object_bridge / scene_anchor / reference_anchor`
5. Diff-aware Post-Patch Verification
6. Level 3 `story_fact` 禁止自动应用

### P1：随后做

1. `repetition_progression`
2. `composure_breakers`
3. `interaction_patterns`
4. `deferred / stale`
5. `protected_content` 扩展

### P2：长篇阶段

1. `cross_chapter_structure_similarity`
2. 长期人物模式重复检测
3. 长期伏笔 stale 检测
4. 作者修改偏好持续学习

## 十六、明确不要做的事

- 不要继续大幅增加生成主 Prompt 的“去 AI”规则。
- 不要继续扩充大量禁词。
- 不要用“出现次数”直接删除人物专属动作。
- 不要把所有疑问自动补成解释。
- 不要让风格审稿器修改正式世界观事实。
- 不要让 Patch 删除物件来源、场景入口和首次人物指代。
- 不要默认“审稿后一定优于审稿前”。
- 不要全文重写；继续采用最小 Patch。
- 不要为了删除作者总结，自动补“风、灯、影子、车声”等文学式章尾。

## 十七、最终验收标准

第三阶段完成后，同一章节重新运行自动审稿，应满足：

```text
✓ 能压缩李拓多余A级光效
✓ 能减少王磊无推进的耳机动作
✓ 能减少D级同功能群众反应
✓ 能保留“我肯定是A级”中有情绪推进的重复
✓ 绝不删除王磊递面包
✓ 绝不让面包凭空出现
✓ 绝不删除海澜直播场景锚点和人物首次介绍
✓ 不为排队时间擅自创造B区支线
✓ 不擅自修改S/SS等正式事实
✓ Patch后自动发现物件、指代、场景和因果断裂
✓ protected_content 不被“润色”成解释句
```

## 十八、最终结论

### 生成端

**通过阶段验收。建议冻结主体。**

### 审稿诊断

**基本通过。** 已经能发现并压缩部分信息饱和、功能重复和过度解释。

### 自动修稿

**未通过安全性验收。**

当前最大问题已经不是“AI味还不够低”，而是：

> **修稿器不知道哪些普通句子其实是后文成立所依赖的结构桥，也不知道修一个小问题时不能顺手创造一串新事实。**

因此下一阶段最值得投入的是：

```text
fact_delta
+ deletion_dependency
+ structural_dependencies
+ Patch Safety Gate
+ Diff-aware Post-Patch Verification
```

把这一层做好以后，系统才适合从“自动诊断”真正升级到“可靠自动局部修稿”。

**目标不是把每一处都修得更漂亮，而是：只改真正需要改的地方，而且绝不把原本成立的小说修坏。**
