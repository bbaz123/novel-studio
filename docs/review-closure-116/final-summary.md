# final-summary.md —— 最终状态与结论口径

## 1. 结论（一句话）

**工程通过**：`LOCAL_VERIFIED` 的修复已落地并有实测证据（**240 条断言 0 失败** + frontend 全绿）；
**文学效果提升单独标 `not_run`**（未获付费评测授权，离线用例不得当作文学效果证明）。

> ⚠️ 本文档按轮次累积，前面章节里的**断言条数**是**当时**的数字；**当前值以 §15 与
> [execution-state.json](execution-state.json) 为准（240 条）**。

## 2. 本地核验（E00）

| 项 | 值 |
|---|---|
| package.json 版本 | **1.1.6**（= 任务书目标） |
| HEAD | `6f9a14b0d1f7e11117b68d0536aee5ca238969cd`（会话结束**未变**） |
| 分支 | `Experimental-Version-v1.0` |
| git status | 脏：会话开始前已有上一轮未提交成果；本轮增量修改，**未**覆盖/重置/提交 |
| Node | v24.19.0（engines ≥22.13.0） |
| 项目级 AGENTS.md | 不存在（有 CONTRIBUTING.md / docs/README.md） |

## 3. 风险复现结论（S01–S09）

| 风险 | 判定 |
|---|---|
| S01 扫描命中的要写进 issues | **LOCAL_VERIFIED（本轮已修）** |
| S02 清空前冻结 review_id | already_satisfied |
| S03 稳定 finding ID | already_satisfied |
| S04 plan 失败不放宽整章 / context_only 分离 | already_satisfied（1 处潜在退化面记为后续建议） |
| S05 双重授权 | already_satisfied；**本轮回合补上 fail-closed 硬化** |
| S06 重复原句判歧义 | already_satisfied（1 处窄残余，低危） |
| S07 重试预算跨刷新共享 | already_satisfied |
| S08 无自动整章回退；作者入口保留 | already_satisfied（注释层 PARTIAL） |
| S09 结构化证据保全 | already_satisfied（提示词字段说明已补） |

## 4. 实际源码改动（真实文件与函数）

| 文件 | 函数/位置 | 增量行为 |
|---|---|---|
| `public/app.js` | `buildAIReviewPrompt`（~10980-10990） | 红线扫描块由"命中必须进 issues"改为"候选信号 + 逐条判断 + `not_applicable` 出口 + counterevidence" |
| `public/app.js` | 新增 `reportConsistencyHtml`（11182）+ `showReviewReport` 调用（11202） | 只在服务端算出"待校准"时显示**具体**矛盾与反例 |
| `public/app.js` | `showReviewDiff`（形参 + 12442/12465） | 显示 `before → after / net_delta / remaining_to_target`；达标与否分别措辞 |
| `public/revision-patch.js` | `ERROR_CODES`（61）+ `runRevisionPipeline`（1414-1427） | 期望 v2 却缺授权表 → `authorization_required` fail-closed，正文一字不动 |
| `ai/editing/narrative-scan.mjs` | `DIAGNOSTICS`/`DIAGNOSTIC_META`（26/55）+ 判据（186-244） | 新增 `reaction_causality`、`focalization_limit` 候选（自带反证通道，不定罪） |
| `ai/editing/narrative-review.mjs` | 新增 `checkReportConsistency`（257）+ `withConsistency`（326） | 优点与问题/正文互相否认 → `needs_calibration` + 反例引用；**不新增模型轮** |
| `server.js` | 审稿保存响应（9052-9054） | 回带 `consistency` / `consistency_conflicts`；随 `report_json` 落库（**无需迁移**） |
| `tests/narrative-repair/11-review-closure.test.mjs` | 新增套件 | 19 条断言（含 5 条阴性对照） |
| `frontend-test.mjs` | 新增 `S01-a/b/c` | 提示词候选化的运行时证据 |
| `scripts/test-narrative-repair.mjs` | 清单一行的登记 + 同进程回退 | 沙箱禁管道时仍能跑真实断言与退出码判定 |

## 5. 审稿校准

- **误报**：`微微` 在合法语境 → 确定性层 0 候选；被判 `not_applicable` 的命中**保留在报告里**且 `auto_eligible=false`。
- **报告自洽**（**契约于 2026-10-11 修正，见 §14**）：原先"绝对措辞 + 同话题 → `needs_calibration`"，
  实测在 12 份真实报告上误报 6 份，已改为——**只有可确证的"绝对措辞 × 正文反例"才置 `needs_calibration`**（T06-a，
  并给出反例原句）；优点与问题的字面话题重叠降级为 `advisories`（建议核对，**不改 status、不断言矛盾**，T05-a/T05-b）。
  不同维度 → **不报**（T06-b）。
- **场景/视点正反例**：F08 → `reaction_causality`（T21-a）；S 级奇观引发静止 → **不报**（T21-c）；
  触觉→密度 / 隔队伍→余温 → `focalization_limit`（T22-a/b）；候选不出现"新增能力"且**不带 delete**（T22-c）。
- **时间线**：缺上午最后编号/工位/跳号 → `needs_temporal_evidence`，不生成"下午自动提速"这一新事实。
- **角色卡**：深海母神时点 → `target_scope: character_card`，不产生 chapter patch。

## 6. 结构压缩与篇幅

- 字数口径统一（`wordCount`/`plainLength`）；`resolveTargetWords` = 章节覆盖 > 作品默认 > 2000。
- 差异预览显示：本次改了多少字、距目标还差多少、风格上限约多少。
- `condense` **默认关闭**；未获批准位时 `refused`（不静默降级成 replace）。
- H01–H07 已拆成可逐个审批的子热点（`issue-coverage.json`），`author_approved` 全部 `false`。
- 三种出口区分：默认局部 `replace/delete`｜显式批准连续跨度 `condense`｜结构重排 = **新任务**（`needs_structural_authorization`）。
- **不以"不达 4000 字"为由破坏已批准设定或伏笔**：H05/H07/K01–K03 的保护事实已登记。

## 7. 覆盖表（示例契约）

见 `issue-coverage.json`：`review_id → issue_id → selected → authorized_span_ids → patch_ids → disposition → reason → diff_verified`。
硬规则：**补丁条数 ≠ 解决的问题数**；`partially_resolved` 不得写成 `resolved`（R06/D03 即此例）。

## 8. 测试（命令 / 退出码 / 断言数）

| 命令 | 退出码 | 结果 |
|---|---|---|
| 逐套件 `node tests/narrative-repair/<n>.test.mjs`（11 套件） | 0 | **227 / 227 断言通过，0 失败** |
| `node scripts/test-narrative-repair.mjs` | 0 | 11/11 套件（同进程回退） |
| `node frontend-test.mjs` | 0 | ALL PASS（含新增 S01-a/b/c） |
| `node .narrative-repair-116/probe-perception-candidates.mjs` | 0 | 18 个既有文本误报 **0**；3 个计划形状全命中 |
| `node .p1-baseline/verify-plugin-tools.mjs` | 0 | 工具面/版本/端点声明一致（26 个工具） |

**旧失败**：`docs/phase-map.md` 与真实改动集不一致（上一轮已记为 `pre_existing`）。
**新失败**：本轮曾引入 1 条（frontend 107c，我新文案含字面 `**`）→ **已修复并复跑全绿**；无未修复新失败。

## 9. 尚未验证

1. 真实模型语义审稿与文学效果 A/B → `SKIPPED: paid_evaluation_not_authorized`。
2. `ci-offline-checks.mjs`（54 项）与 `api-test-suite.mjs`（含 `/api/novel/review` 的 `consistency` HTTP 往返）→ **环境阻塞**：
   本会话沙箱禁子进程管道（`spawnSync(stdio:'pipe') → EPERM`）。恢复命令见 `test-report.md` §5。
3. 本轮真实正文 6357/4000/5000 的本地复算 → 缺完整正文（`full_sample_unavailable`）。
4. 本轮实际勾选了哪些 issue / condense 开关 / 原始补丁 → 无本地运行记录（`missing_execution_evidence`）。

## 10. 回滚方式

逐文件撤销，**不使用** `git reset --hard` / `clean` / `stash`，**不删除** `data/`。见 `rollback.md`。
本轮**没有**改 DB schema（`report_json` 只是多一个键），因此无需数据迁移回滚。

## 11. 补充轮（2026-10-11，作者「开始执行」授权）

主轮交付后，作者授权实施我列出的剩余硬化项。详见 [supplement-round-20261011.md](supplement-round-20261011.md)。

| 项 | 判定 | 说明 |
|---|---|---|
| **S04-1** 未传 plan 默认下发整章跨度目录 | **已硬化** | `strictPlan` 默认严格；旧语义须显式 `allowCatalogueWithoutPlan: true`。既有 `94A` 改为显式 opt-in（断言内容逐字保留），新增 `94A2` 钉住新默认 |
| **S06-1** 唯一性只看字面出现次数 | **复核后判定：不改** | 穷举未找到可复现缺口；按建议收紧的实测代价是 **5 条既有断言变红**（E01-6/E01-6b/E01-6d/E01-6e/E05-f）→ 已回退，并用 **T51-d** 固化为反向确认 |
| **S04-2 / S08** 三处与行为相反的陈旧注释 | **已清理** | `public/app.js:11583`、`public/app.js:12279`、`public/revision-patch.js:12` |

补充轮回归：**11 套件 / 233 条断言全绿**，`frontend-test.mjs` **ALL PASS**。
`revision-plan.js` 本轮**净改动为 0**（改动已回退，仅留注释说明复核结论）。

> **补充轮最重要的记录**：S06-1 那个"看起来更严格 = 更安全"的改动，实测会破坏一条
> 已被 5 条断言守住的**精确路径**。"更严格"不等于"更好"——改动前必须先看它会不会
> 让既有正确行为变红。

## 12. 测试矩阵轮（2026-10-11，继续补 T01–T30）

产出 [t-matrix.md](t-matrix.md)：把任务书 §9 的 **T01–T30 逐条对到真实 check id**（ID 用正则从测试文件抽取，
与实跑汇总核对为 **239 条断言**），并如实标出未覆盖项。

| 判定 | 条数 | 说明 |
|---|---|---|
| `covered` | **23** | 有直接断言可核对 |
| `partial` | **6** | T07 时序结论、T08 角色卡分流、T11/T28 的 HTTP 往返、T20 真实 6357 复算、T23 号码纸夹具 |
| `not_run` | **1** | T09（需蓝图/作品级指标链路接通后才有可断言的输入） |

补齐过程中发现并处理了两个**真实覆盖缺口**：

1. **T19 的状态名在代码里完全不存在** —— 全仓检索 `partially_resolved` **0 命中**。
   模型想说"只把人群解释压短、流程没缩"时，白名单里没有这个词，**只能被迫说 `patched`**，
   于是**局部解决被系统性地显示成完全解决**（正是 §6.4 与 T19 要禁止的）。
   已实现：处置白名单加入 `partially_resolved`（**必须带理由**，否则 `partial_without_reason` 拒收）、
   覆盖表如实透传、并入"未完成项"、前端加标签；补 **T19-a/b/c/d** 4 条断言（含"缺理由拒收"与"不误降级"两个方向）。
2. **T16 行为正确但没有断言守住** —— 两个不相邻热点确实各自成跨度、中间未授权正文不被并进，
   但没有任何测试钉住它。已补 **T16-a/T16-b**（并检查授权表里不存在覆盖中间正文的大区间）。

**有意不加** `needs_structural_authorization`：行为上已安全（落进 `needs_scope`/`refused`/`ambiguous_anchor`，
且不会自动放宽或自动整章重写）；要用那个状态名就必须判定"作者这次要的是结构重排"，
只能靠意图识别，实测与"定位到但粒度是段落"无法区分、会引入误报。按"判据不得误报优先于召回"保留既有状态，
在 `t-matrix.md` §3 与 `execution-state.json` 的 `status_name_not_adopted` 如实记为**状态名未对齐**。

## 13. 真实模型付费评测（2026-10-11，作者授权 2 元）

见 [paid-eval-20261011.md](paid-eval-20261011.md)。此前的 `SKIPPED: paid_evaluation_not_authorized` 已解除。

| 评测 | 结果 |
|---|---|
| **S01 扫描命中候选化** | ✅ **7/7 断言通过**（真实模型） |
| **自洽检测真实对照** | ⚠️ **两例均 `ok`，未触发** → 检测器未获真实阳性，如实记为未证实 |
| 实付 | **≈ 0.2238 元 / 2 元** |

**S01 的关键证据（模型原话）**：summary 写 *"扫描命中的"微微"在此属于正常程度副词，**不宜硬报为AI腔**"*；
`scan_verdicts` 记 `signal_hit:"微微"` / `verdict:"not_applicable"` /
`counterevidence:"…单句内没有形成模板复用、情绪词库轮换或AI腔复读，不能仅因扫描命中就报为问题。"`
A/B 两侧有区分力（A 放过合法用法、B 报 7 条真问题含可定位引用）。

**安全边界**：临时库 + 真实库只读 + 密钥不经手（只复制一行、只输出哈希）+ 走应用自身 `/api/ai/*` + 端口 3738；
评测后临时目录已删；真实库最后写入时间早于评测 70 分钟。

**本轮又抓到我自己的装置错误**：判"扫描信号是否被定罪"连错 3 次（整份报告字符串包含 / issue 对象 stringify 混入并列 summary 键 /
只读 issue text 而模型引用了原句），**全部是假阳性**，最终改用结构化字段 `signal_hit` + `verdict`。
若第一版就写结论，会向作者报出与事实相反的"模型仍在误报微微"。

## 14. 逐项验证「尚未验证」的 5 项（2026-10-11，作者「尚未验证的进行验证」）

见 [verify-round-20261011.md](verify-round-20261011.md)。

| # | 项 | 结果 |
|---|---|---|
| **N5** | 实际勾选 / condense / 原始补丁 | ✅ **已取得**：4 条修稿选择 + 12 份审稿报告（只读）。选择保存的是报告原始序号，同一 review 的两次选择 `selection_hash` 一致、勾选变化后才变 |
| **N6** | 自洽检测真实阳性 | ✅ **实测并发现真实缺陷**：修复前在 12 份真实报告上**误报 6 份**（裸 `不` 被当绝对措辞：不靠/不是/不锁/不抢）→ 修复后 **0/12** |
| **N3** | api-test-suite HTTP 往返 | ✅ **已跑通 195/200、1 失败、4 跳过**；用 **HEAD 干净 worktree** 对照跑出**完全相同的失败项** ⇒ 先前就存在 |
| **N2** | ci-offline-checks 54 项 | ❌ 仍 `env_blocked`：三次绕行尝试均不可行（inherit 读不到 stdout／ESM 绑定不可变／shell 包装风险高于收益） |
| **N1** | 文学效果 A/B | ❌ 仍 `not_run`：缺完整章节两版正文与判读规模；**不把 S01 行为验证冒充文风改善** |

**本轮最重要的产出**：把"未验证项"真正拿去跑真实数据，**当场暴露了自洽检测器的严重假阳性**
（会在作者面前指控"你的报告自相矛盾"，而 6/12 都是误报）。由此得出并落实一条设计结论：

> 在"长真实报告"上要收紧、在"短合成正例"上要放宽 ⇒ **不存在同时满足的字面阈值**；
> 字面重叠**无法证明**语义矛盾。因此 `needs_calibration` 只由**可确证**的"绝对措辞 × 正文反例"触发，
> 优点与问题的话题重叠降级为 `advisories`（建议核对），不再声称矛盾。

T05-a 据此**按新契约改述**（未弱化：改为断言 `status:ok` + `advisories≥1` + `conflicts:0` + note 说明），
并**新增 T05-b 假阳性回归**（把「不靠旁白建体系」这个真实误报永久钉住）。

## 15. 闭环修复（2026-10-11，作者「修复未闭环问题」）

自查后**确认两处都是我自己制造的「只修数据层、不修呈现层」**（形态 B），均为**先写失败断言再修**：

| # | 缺陷 | 后果 | 修复 | 断言 |
|---|---|---|---|---|
| 1 | §14 把 `strength_vs_issue` 从 `conflicts` 降级到 `advisories`，**呈现层没跟着改**（`reportConsistencyHtml` 只读 `conflicts`；全仓 `advisories` 前端 0 命中） | "降级为建议核对"这个设计在**界面上等于没做**，作者什么也看不到 | 两档都渲染，且**措辞强度区分**：conflicts 说"互相否认"，advisories 只说"建议核对（非结论）"并明写不据此判定矛盾 | `S04-2a`（先红 `rendered:""`）/ `S04-2b` / `S04-2c` |
| 2 | 自洽结论**在两条读路径上层级不同**：新建路径在 `report.consistency`，而"查看上次审稿"把整个 `report` 交给渲染器 → 顶层无该字段 | **回读时提示静默消失**，"落库后仍可追溯"只在数据层成立 | 渲染器两种形状都认；`server.js` 另加 `consistency_advisories` 且**与 conflicts 分开计数** | `S04-2d`（回读路径形状） |

修复中我自己又踩了一次呈现层缺陷：第一版文案含字面 `**`，被既有断言 **107c** 当场抓住 → 已改为纯文本。
（这反过来证明：呈现层断言是有效的，只是我改数据时没去跑它。）

**可复用教训（已写入 OpenViking）**：把信息从 A 字段搬到 B 字段时，必须枚举**四层消费面**——
数据层 / 呈现层 / **落库回读路径** / 计数与 API 暴露；"渲染出空串"是这类缺陷的默认表现，
没有报错不代表没坏。

## 16. 最终状态

| 维度 | 状态 |
|---|---|
| 工程实现（P0 硬门禁：候选不强制定罪 / 双重授权真实闭合 / plan 失败不放宽 / 选择与授权幂等） | **通过** |
| 叙事质量（证据与反证、不互相矛盾、区分"普通等级全场异常反应"与"有效悬念否定句"） | **通过** |
| 结构问题（句级修补或连续压缩可选；授权不足时如实说明做不到） | **通过** |
| 兼容性（旧报告、既有勾选、手工保存、历史版本、真实数据库安全） | **通过**（未改 schema；旧路径语义保留并有 T31-d） |
| 证据（每项核心修改有先红后绿的离线用例、真实退出码与非零断言数） | **通过**（240 条断言 + frontend 全绿；T01–T30 覆盖表见 t-matrix.md） |
| 安全（未重置工作树、未提交推送、未改真实章节与卡片） | **通过**（`data/` 在 git status 中 0 条；HEAD 未变；评测用临时库，用后即删） |
| 文学效果 | **`not_run`** —— 真实评测覆盖 S01 候选化行为（7/7），样本为合成文本，**不构成文学效果 A/B** |
| 环境阻塞项 | `ci-offline-checks` 54 项 **`not_run(env_blocked)`**；api-test-suite **已跑通**（唯一失败项经基线证明先前就存在） |

**交付物（15 份）**：`docs/review-closure-116/` 下的 `source-map.md`、`baseline.json`、
`execution-state.json`、`implementation-report.md`、`review-quality-report.md`、`issue-coverage.json`、
`diff-audit.md`、`test-report.md`、`rollback.md`、`final-summary.md`、`supplement-round-20261011.md`、
`t-matrix.md`、`paid-eval-20261011.md`、`verify-round-20261011.md`（以及侦察记录 `recon-S04-S08.md`），
外加 `tests/narrative-repair/11-review-closure.test.mjs`。
