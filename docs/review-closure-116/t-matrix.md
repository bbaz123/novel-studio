# t-matrix.md —— 《修改方案.md》§9 测试矩阵 T01–T30 ↔ 实际用例覆盖表

> 用途：把任务书的 T01–T30 逐条对到**真实存在的**断言上，并明确标出**未覆盖**与原因。
> 纪律：不写"应该测了"；每条覆盖都给出**可核对的 check id**。
> ID 来源：从 `tests/narrative-repair/*.test.mjs` 与 `frontend-test.mjs` 中用正则**抽取**（该轮 `narrative-repair` 共 239 条断言，已与实跑汇总核对一致），不是凭记忆。
> ⚠️ **当前值**（2026-10-11 闭环修复后）为 **240 条**；本文表格里的 T05 一行已按**修正后契约**更新
> （strength↔issue 重叠只进 `advisories`，不改 status；见 `verify-round-20261011.md` §2）。
> 判定：`covered`（有直接断言）／`partial`（有相关断言但不完整）／`behavior_verified_unlabeled`（行为已被其它断言守住，但任务书那个**状态名**不存在）／`not_run`（未覆盖，附原因）。

| T | 内容（摘要） | 判定 | 证据（check id / 文件） |
|---|---|---|---|
| **T01** | 公开代码与本地 1.1.6/commit/脏工作树被记录；版本不符不自动覆盖 | `covered` | `docs/review-closure-116/baseline.json`、`source-map.md` §1/§1.1；`02-fixtures` R01-a…R01-f、R12 |
| **T02** | 「微微」在合法语境可 `not_applicable`，不强制进 issues | `covered` | `11-review-closure` **T02-a/T02-b/T02-c**；前端 **S01-a/S01-b/S01-c** |
| **T03** | 「嘴角没有上扬也没有下压」有重复解释证据可报，但不得强迫新造动作 | `covered` | `04-narrative-scan` E04-b/E04-b2；`11-review-closure` T02-a（合法语境 0 候选） |
| **T04** | 「没有下一句／没有一个人转头看他」承担悬念/声源排除 → 判保留 | `covered` | `04-narrative-scan` **E04-e（R03 阴性）**；`09-information-truncation` E03-2；K01 登记于 `issue-coverage.json` |
| **T05** | Strength「后续不再重复」vs Issue「0372 重复全套」→ 报待校准 | `covered` | `11-review-closure` **T05-a** |
| **T06** | Strength「伏笔完全没解释」但上下文有解释句 → 必须限定或单列 | `covered` | `11-review-closure` **T06-a**（含反例原句）+ **T06-b**（阴性对照） |
| **T07** | 缺上午结束编号/工位 → 不能断言"下午速度必然翻倍" | `partial` | 口径见 `review-quality-report.md` §1(R09)、`diff-audit.md` §2；**没有**针对时序结论的独立断言 |
| **T08** | 深海母神角色卡时点与第 1 章无关 → 不得编成 chapter patch | `partial` | 口径见 `review-quality-report.md` §1(R08)/§2；**没有**断言 |
| **T09** | 蓝图说系统只出场 1 次时不因作品级 5～15 次强制新增系统对白 | `not_run` | **未覆盖**：需要蓝图/作品级指标链路接通后才有可断言的输入 |
| **T10** | 只选原第 3/7 项，排序与刷新后 review_id、finding_id、selection_hash 不变 | `covered` | 前端 **116E-c**（稳定编号 3/7）、**116E-d**（review_id 带到选择记录）、**116E-e**；`11-review-closure` T51 系列 |
| **T11** | 清空 pendingReview 后 selectionPayload 仍有原 review_id；API/DB/reload 往返一致 | `partial` | 前端 116E-d 覆盖"清空后仍有"；**HTTP reload 往返未跑**（`not_run(env_blocked)`，见 test-report §5） |
| **T12** | 找不到引文／重复引文／plan null/抛错 → `needs_scope`/`ambiguous_anchor`；不生成整章可编辑目录 | `covered` | `08-authorization` **E01-2 / E01-2b / E01-3 / E01-3b / E01-3c / E01-3e**；前端 116E-a；`11-review-closure` T51-c |
| **T13** | 只选章尾问题，模型用相同 issue_id 改第二 A 级句 → `out_of_scope`，正文 hash 不变 | `covered` | `08-authorization` **E01-1 / E01-1c / E01-1d** |
| **T14** | `condense=false` 时连续压缩请求拒绝但允许独立句级 replace/delete | `covered` | `11-review-closure` **T41-a**；`05-revision-plan` E05 系列 |
| **T15** | `condense=true` 且批准连续 span 时只处理批准范围，保留段间未授权正文 | `covered` | `05-revision-plan` E05-b/E05-c/E05-d；`01-patch-protocol` P06/P06b |
| **T16** | 非连续 H02/H04 热点不能用一个大 span 把中间正文打包成"获准" | `covered` | `11-review-closure` **T16-a / T16-b**（本轮补齐；另有 `08-authorization` E01-6 系列守住收窄精度） |
| **T17** | 显式 delete、replace、合法空 patch/disposition、重复键/缺字段、旧协议错误输出按既有严规则 | `covered` | `01-patch-protocol` **P01/P02/P02b/P02c/P03/P03b/P03c/P04/P04b/P04c/P21/P21b** |
| **T18** | 两条单独安全的删除组合后破坏先行语 → 组合门禁必须拦截 | `covered` | `01-patch-protocol` **P08 / P08-PRE**；`08-authorization` **E01-5b** |
| **T19** | 只把第二 A 级人群解释压短、未缩流程 → 父问题必须 `partially_resolved` | `covered` | `11-review-closure` **T19-a / T19-b / T19-c / T19-d**（本轮实现并补测：该状态名原先**在代码里完全不存在**） |
| **T20** | 6357→少量删改须显示实际新字数与到 5000/4000 的剩余差额；不假称达标 | `partial` | 差异预览已实现字数与差额（`app.js` lengthInfo/lengthHintHtml）；`11-review-closure` T41-b 守住"不假装已修复"。**真实 6357 复算未做**（缺完整正文，见 baseline N4） |
| **T21** | D 级普通却全场静止 → 有反证通道的 `reaction_causality` 候选 | `covered` | `11-review-closure` **T21-a / T21-b / T21-c**（含阴性对照） |
| **T22** | 石板密度、远处掌心余温 → `focalization_limit` 疑点，不捏造能力 | `covered` | `11-review-closure` **T22-a / T22-b / T22-c / T22-d** |
| **T23** | 号码纸反复出现允许精简，但最终折一道与 0731 身份事实保留 | `partial` | 保护事实登记于 `issue-coverage.json` hotspots[H05]；**没有**针对该夹具的独立断言 |
| **T24** | 取消/恢复/晚到响应/重复采纳/切章/作者改稿后，旧补丁 stale/幂等，失败不自动整章重写 | `covered` | `01-patch-protocol` **P10 / P10b / P11 / P11b / P11c**；前端 **94K / 94K3 / 116E-j / 116E-k**；`11-review-closure` T31-d |
| **T25** | Unicode、CRLF、段落空行、富文本节点与保护 span，未授权文本逐字保留 | `covered` | `01-patch-protocol` **P06b / P06c**；`08-authorization` **E01-5c**（CRLF+emoji 逐字不变） |
| **T26** | 直连与 DSH preset 的 draft/verify_style/rewrite 阶段规则可对账；词表不被灌入初稿 | `covered` | `03-stage-rules` **E02-a…E02-q**（17 条） |
| **T27** | 注入门禁不可用/畸形/抛异常 → 候选标 `safety_unavailable`，不宣称通过 | `covered` | `01-patch-protocol` **P12 / P12b** |
| **T28** | 报告/选中/授权/补丁/覆盖 UI→API→DB→reload 数据完整，旧报告仍可读 | `partial` | 离线侧覆盖（`06-report` E06-*、`07-review-structure` E03-*）；**HTTP→DB→reload 未跑**（`env_blocked`） |
| **T29** | 无作者勾选不发付费修稿；blocked/noop 有理由，不重试到无限，不偷偷扩大范围 | `covered` | 前端 **116E-a**（0 次调用）、**116E-i/j/k**（预算有界且跨刷新共享）；`01-patch-protocol` P11/P11b |
| **T30** | 真实模型效果未评测时明确 `not_run`；离线 mock 不得写成"自然度实测提升" | `covered` | 全仓文档口径：`baseline.json.not_run` N1、`test-report.md` §5、`final-summary.md` §9；`semantic_status:'not_run'`（`04-narrative-scan` E04-a） |

## 汇总

| 判定 | 条数 | T 项 |
|---|---|---|
| `covered` | **23** | T01 T02 T03 T04 T05 T06 T10 T12 T13 T14 T15 **T16** T17 T18 **T19** T21 T22 T24 T25 T26 T27 T29 T30 |
| `partial` | **6** | T07 T08 T11 T20 T23 T28 |
| `not_run` | **1** | T09 |
| 合计 | **30** | — |

> 自查：上表 `covered` 行逐个数 = 23 项；`partial` 6 项；`not_run` 1 项；23+6+1 = 30 ✓
> （初次写入时该行曾写成"22 项"并把 T11 重复计入，已按实际逐项重数更正。）

## 本轮为补齐矩阵而做的事

1. **T19 实现并补测**：核查发现 `partially_resolved` 这个状态**在代码里完全不存在**
   （`Select-String` 全仓 0 命中），模型想说"只改了一半"时只能被迫说 `patched` →
   **局部解决被显示成完全解决**。已加入处置白名单（必须带理由）、覆盖表如实透传、
   并入"未完成项"、前端加标签；**T19-a/b/c/d** 4 条断言（含"缺理由拒收"与"不误降级"两个方向）。
2. **T16 补测**：行为本就正确（两个不相邻热点各自成跨度，中间段不被并进），但**没有断言守住**。
   已补 **T16-a/T16-b**，把"不得用大 span 打包中间未授权正文"变成可回归的约束。
3. **T16 的 `needs_structural_authorization` 状态名：有意不加**。理由见 §3。

## §3 为什么 T16 只加断言、不加那个状态名

任务书把 `needs_structural_authorization` 列为完成态之一。核查后**不加**，理由是它无法用一个
可靠判据与既有状态区分开：

- 行为上已经安全：遇到"跨远处多段重排"这类请求，计划**不会**扩大授权，而是落进
  `needs_scope`（定位不到）／`refused`（condense 未批准）／`ambiguous_anchor`（多处），
  由作者另行发起整章/结构性任务。**没有一条路径会自动放宽或自动整章重写。**
- 要"改用另一个状态名"，就必须判定"作者这次要的是结构重排"——而这只能靠意图识别。
  我试过按"sentence 跨度 + 跨段"判，结果与"定位到但粒度是段落"无法区分，
  会引入误报（把普通局部修稿标成"需要结构授权"）。
- 因此按[判据不得误报优先于召回]与既有纪律（`05-revision-plan` E14：误报比漏报更伤），
  **保留既有状态**，并在本节如实记为"状态名未对齐"，而不是硬造一个会误报的判据。

> 若后续需要该状态名，正确做法是让**作者显式选择**"这是结构性重排任务"（例如界面上的独立入口），
> 由该显式动作产生状态，而不是从正文里猜意图。

## §3b `advisories` 的触发是**窄**的（集成验证时发现，如实记录）

在隔离实例上做 HTTP→DB→回读 集成验证（`.narrative-repair-116/it-review-consistency.mjs`，**9/9 通过**）时，
我的第一版断言写错了：我以为"任何与 issue 话题重叠的优点"都会进 `advisories`。实测**不是**：

- `advisories` 只在 **① strength 带绝对措辞 ② 且不属于"解释/说明/交代"那一类 ③ 且与某条 issue 有实词话题重叠** 时产生。
- 例：`等级分量全靠事件给出，不靠旁白建体系。` → **不产生** advisories（无绝对措辞）。这是**正确**的：
  它本来就不是绝对断言，就不该提示"可能自相矛盾"。
- 例：`本章对白完全没有推进信息，读起来很拖。` × issue`对白信息量不足…` → 产生 1 条
  `strength_vs_issue_overlap`（共享"对白/信息"实词）。

**这是刻意设计而非缺陷**：宽松版在 12 份真实报告上误报 6 份、收紧到重叠系数后合成正例又漏报，
因此宁可让 advisories **少而准**（集成用例 `IT3b` 专门钉住"无绝对措辞的优点不得报警"）。
