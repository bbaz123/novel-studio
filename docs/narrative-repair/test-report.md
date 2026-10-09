# test-report —— 实际运行了什么、退出码是什么、哪些仍未验证

> 纪律：只信退出码与断言输出；零用例算失败；真实模型评测与工程测试**分开报告**。
> 所有命令的 cwd 都是仓库根 `C:/Users/a1941/Desktop/DeepSeek/novel-studio`，全部零计费。

## 1. 基线与改动后对比（同一入口，唯一真源）

| 时点 | 命令 | 退出码 | 通过 / 未通过 | 日志 |
|---|---|---|---|---|
| 改动前（2026-10-09 18:16 前后） | `node scripts/ci-offline-checks.mjs` | 0 | **53 / 0** | `.narrative-repair/baseline-ci-offline.log` |
| E01 落地后 | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-ci-offline.log` |
| E02 落地后 | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-e02-ci-offline.log` |
| 审查修复后 | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-review-ci-offline.log` |
| E04 落地后 | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-e04-ci-offline.log` |
| E05 落地后（当前） | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-e05-final-ci-offline.log` |
| E06 落地后 | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-e06-ci-offline.log` |
| E03 落地后（当前） | `node scripts/ci-offline-checks.mjs` | 0 | **54 / 0** | `.narrative-repair/post-e03-ci-offline.log` |

新增的那一条是本轮登记的叙事专项总入口：
`✓ 叙事性专项修复总入口（零计费）（278ms）`。
**没有既有检查由绿变红**（53 条基线条目在两次改动后都仍是 ✓）。

## 2. 专项套件明细

| 命令 | 退出码 | 通过 / 未通过 | 说明 |
|---|---|---|---|
| **`node scripts/run-narrative-acceptance.mjs`（E07 验收运行器）** | 0 | 必做 9 / 失败 0 | 按**退出码**判定；逐条记录 cwd/开始时间/耗时/退出码/计数/日志路径 → `docs/narrative-repair/e07-run-manifest.json`；付费调用 0 次；`SKIPPED: paid_evaluation_not_authorized`、`SKIPPED: missing_frozen_blueprint`。逐项对照见 `acceptance-report.md` |
| `node scripts/test-narrative-repair.mjs` | 0 | 7 个套件全绿（65 + 8 + 17 + 24 + 19 + 16 + 10 = **159 条断言**） | 总入口，显式清单，子进程执行 |
| `node tests/narrative-repair/01-patch-protocol.test.mjs` | 0 | 65 / 0 | P 类：P01—P09、P14 的模块级判定面 + 协议自证（P15）+ **2026-10-09 审查修复的回归（P16—P21）** |
| `node tests/narrative-repair/02-fixtures.test.mjs` | 0 | 8 / 0 | R 类：R01（hash/字符数/六组重建/无评论）+ R12（来源标签、不登记为作者基线） |
| `node tests/narrative-repair/03-stage-rules.test.mjs` | 0 | 17 / 0 | E02：阶段化规则编译（同一能力三阶段内容不同、无阶段逐字不变、审计摘要、回落可见） |
| `node tests/narrative-repair/04-narrative-scan.test.mjs` | 0 | 24 / 0 | E04：确定性候选层（四类诊断的正例与**阴性对照**、数据不足显式返回）+ 审稿协议层（引用核验 / 反证降级 / 保护分区） |
| `node tests/narrative-repair/05-revision-plan.test.mjs` | 0 | 19 / 0 | E05：局部编辑计划（片段级授权跨度 / 只读上下文 / 不变量 / 依赖组 / 预算举手 / 勾选变更即作废 / 干跑） |
| `node tests/narrative-repair/06-report.test.mjs` | 0 | 16 / 0 | E06：单独撤销（位置重建/缺位置拒绝/源稿变了拒绝）+ 相对结论必须先读 diff + 开关默认关闭 + **对照视图的样本量守卫** |
| `node tests/narrative-repair/07-review-structure.test.mjs` | 0 | 10 / 0 | E03：审稿结构化与引用核验（逐字定位 / 重复引用拒收 / 反证降级 / 旧口径逐字不变 / JSON 不可解析时如实报告） |
| `node scripts/test-narrative-repair.mjs --only zzz` | **2** | — | 零匹配 → 非零退出（"没找到测试"不许当成功） |
| `node frontend-test.mjs` | 0 | 全绿（含 1c、9c、9d、9e、9f、9g、9h、94K4/94K5） | 应用层接线：v2 协议精确跨度 / schema_error / stale / 失败出口 / 阶段进真实请求 URL / 协议模块缺失前置拒绝 / 覆盖表与逐条改动 / 校验状态 / 单处撤销真的重建候选 / 修稿前写独立选择记录 / **对照视图（三类证据 + 样本量守卫）** |
| `node .p1-baseline/test-editing-rules.mjs` | 0 | **79 / 0** | 编辑规则的隔离实例测试；E12—E14 是 E04 的路由级证据，E15—E18c 是 E03/E06 的，**E19—E19e 是 E02 的"直连 vs Harness 同阶段等价"路由输入级证据**（同参数两条端点 → 同一份装配 + 同一规则块 hash；draft 无诊断判据；verify_style 有完整判据；不传阶段 = 旧行为；三个阶段都仍带写作红线层） |
| `node .p1-baseline/verify-plugin-tools.mjs` | 0 | 7 项通道检查 + 工具面/版本/端点三重对账 | **Harness 侧路由输入级证据**：`novel_write_pipeline` 的装配带 `stage=draft`；`novel_context` 不传 stage 时 URL 无 stage、传 `verify_style` 如实透传、传非法值**不透传**；预设仍写明事实限制与"允许略写"、且不含逐项评分/诊断阈值。**变异测试**：拿掉 `stage:'draft'` → 该检查变红并以退出码 1 中止（还原后 sha256 与变异前一致） |
| `node .p1-baseline/verify-preset-copy.mjs` | 0 | 结论 `junction_ok` | **部署拷贝核对（只读）**：两个活跃 profile（headless/novel）的 `node_modules/novel-writing` 都是**指向本仓库的 junction**（源文件即部署文件）；遗留的 `~/.dsh/.agent-presets/novel-writing` 有 2 个文件与仓库不同（`agent.cordis.yml` 6326B vs 12864B、`novel-tools.mjs` 40818B vs 106150B），**没有任何活跃通道加载它**。本工具不写用户目录，只给结论与清理/接线命令 |
| `node scripts/materialize-narrative-fixtures.mjs "叙事性专项修复.md"` | 0 | — | 冻结样本导出；`before_sha256=ffeae905…`、`after_sha256=932510ef…`、`verified_change_groups=6` |

## 2c. 2026-10-09 的**假绿审计**（这条比上面任何一条都重要）

写 E05 套件时发现：断言辅助 `check(...)` 的**签名**与本仓库 `frontend-test` 的签名不同
（本目录是 `check(id, desc, cond, detail)`，frontend-test 是 `check(name, cond, detail)`）。
我把描述写进 `id` 位时：

- **两个参数**（`check('E05-f 描述', cond)`）→ `cond` 落空 → **恒 FAIL**（当时被当成"实现有问题"）；
- **三个参数**（`check('E05-f 描述', cond, detail)`）→ `cond` 收到 detail 字符串 → **恒 PASS（假绿）**。

用一段正则（找 `check('…'` 里"ID 后面还有空格"的调用）对 5 个套件做了穷举，共 **17 条**受影响：
修正后真实结果是 **2 条假绿暴露的实现缺陷 + 2 条夹具缺陷**（详见下）。处置分两步：

1. **改装置而不是改纪律**：`tests/narrative-repair/harness.mjs` 的 `check` 现在**形状自适应** ——
   `check(id, desc, cond, detail)` 与 `check('id 描述', cond, detail)` 都能正确取到 `cond`，
   从根上消除"描述进 id 位"这一整类误用（不再依赖我记住签名）。
2. 穷举修完后暴露并修掉的真缺陷：
   - `narrative-scan.mjs` 的段号换算：`scan.mjs` 的 finding 常常**没有 `quote`**，只有被截断的
     `excerpt`，且带它自己的段标签（`第3段：…`）→ 直接拿整段去匹配永远失败，候选只能标"未能定位"。
     改为：剥标签 → 去省略号 → 取开头 12 字做**无空白**包含匹配 → 仍找不到且两边段数一致时才用它的段号。
   - E05 的 `allowCondense` 门控语义（E06 新增）与 E05 用例冲突：单跨度压缩不需要额外批准，
     跨句压缩才需要 `merged_span_approved` → 用例按真实语义拆成三条。
   - E06 用例自身的夹具缺陷：手写偏移与正文不符、跨段引用定位不到（夹具必须真的含两次/真的跨句）。

**教训**：假红会被发现，**假绿不会**。任何"一次新增多条断言"的批次都必须先单独跑一次这个套件，
并且**断言装置要设计成不能误用**（或至少在成批失败/成批通过时都能自查）。

## 2b. 2026-10-09 审查复审（自审 + 独立复查）与修复

复审范围：E01/E02 全部改动（含新文件与交付文档）。**独立复查者只读、未改任何文件**，
复跑专项套件与前端套件均绿，并找到 1 条【高】+ 4 条【中】+ 若干【低】。两份清单合并后逐条修复：

| 编号 | 严重度 | 缺陷（旧行为实测） | 修复位置 | 回归断言 |
|---|---|---|---|---|
| R1 | 高 | 句级跨度被逐条门禁按"整段替换/整段删除"模拟 → 安全改动被 `object_provenance`/`reference_anchor` 误拦（`allBlocked=true, applied=0`），而同一改动用段跨度就放行；整批被拦又使组合核验走早退分支，无人纠正 | `revision-patch.js` `gatePlanPatches`：按**段落级 before/after** 构造门禁输入；并补一条**跨度级**"事实增量过大"判据，避免修复开口子 | `01 P16`（+P16b/P16c）、`01 P16d`（真删来源仍拦）、`01 P17`（跨度膨胀仍拦） |
| R2 | 中 | 组合核验在**段落带前导空白**时坐标错位 → 报 `unsupported_mapping` 假警告并 early return（跳过该候选的组合分析） | `combinedDeletionFindings`：用**原始**段文本切片、只对结果 trim | `01 P20` |
| R3 | 中 | 空补丁 + disposition 为 `blocked/deferred` 时，界面转述成"模型判断没有需要改动的段落"（模型理由全丢）；`showReviewDiff` 无 `coverage` 形参 → 覆盖表分文不显 | `app.js` 的 noop 分支按状态分文案 + 新增 `showRevisionDispositions`；`showReviewDiff` 接收并渲染 `revisionCoverageHtml` | `frontend-test 94J`、`94I/94I2` |
| R4 | 中 | 文档与注释声称"删掉 `<script>` 即可最小回滚"，实测会变成"修稿每次失败且归因错误" | 修正 `rollback.md` §1A 与 `index.html` 注释；并加**付费前前置校验**（模块缺失直接拒绝）+ `schema_unavailable` 结论码 | `frontend-test 94H/94H2/94H3` |
| R5 | 中 | "接回进度"调用 `tryApplyRevisionOutput` **未传 ctx** → 该路径跳过"未选问题"校验、章号回落成当前章（同一产物刷新前后行为不一致） | `app.js` 恢复分支传 `{snapshot, chapterId}` | `94K`（走真实 refineByChecklist 路径）|
| R6 | 中 | 分段路径的"改用整片重写"丢掉作者勾选（回落全量 `review.issues`） | `refineByChecklist` 分段分支传 `confirmed` | `94y`（源码）+ 语义与 9e 一致 |
| R7 | 中 | §6.6 要求的"格式失败 → 一次仅格式重试"未实现；预算/幂等原语零接线 | `app.js` 用 `createRetryBudget({max:1})` 实现一次仅格式重试（同一授权范围）；提示词侧加"仅格式重试"块 | `94K2`（实测恰好 2 次请求且第二次含格式重试块） |
| R8 | 中 | "别章跨度"判据自证式（跨度用调用方 chapterId 打标 → 恒成立） | `planPatchApplication`：跨度按 **snapshot.chapter_id** 打标 | `01 P18/P18b` |
| R9 | 中 | 删除的分隔符归属不一致：删末段留 `\n\n`；同一意图用段/句跨度结果不同 | `planPatchApplication`：句跨度等于父段时按段落删除；末段删除回收前导分隔符 | `01 P19/P19b` |
| R10 | 低 | 一份可解析 + 一份"完整但坏"的多份 JSON 被静默挑一份（§6.6 不允许） | `decodePatchOutput`：`partial_json_ignored` → 拒绝执行 | `01 P21/P21b` |
| R11 | 低 | 纯空格段也进授权跨度目录；`buildSpans` 里 `startSep`/`isCRLF` 死变量；`94G` 只还原 `aiContext` 而改了章节/作品状态 | 目录按 `trim()` 过滤；删死变量；测试块成对保存/还原 | `01 P14`系列 + `94G`（状态还原） |
| R12 | 低 | 文档过期/不实：`test-report.md` 61 条；`source-map.md` 行号与文件表；`baseline.json` C03 状态；implementation-report 把 P11 写成已接线、把 `schema_error` 说成一律（实为仅 v2）；`rollback.md`/index.html 的回滚说法 | 逐条更正（见各文档最新版本） | 本轮文档改动，无代码断言 |

**独立性说明**：独立复查者用自己的探针复现了 R1/R2/R3/R4，我用自己的探针复现了 R1/R5/R6/R7/R8/R9/R10；
两份清单在 R1 上重合（同一条高严重度缺陷被两方独立证实）。

## 3. 三条既有断言的**规格变更**（不是弱化，需要留痕）

改动前 `frontend-test.mjs` 里有两处编码了**旧规格**，本轮按任务书 §6.4 改成新规格：

1. `90`（原标签"补丁都定位不到时 ok=false（调用方据此回退）"）→ 断言**未改**（仍要求 `ok===false` 且 `unresolved.length===1`），
   只把标签改成"调用方**不得**据此整章重写，见 94s"。"不回退"由新断言 94x/94y/94z 动态钉住。
2. `91`（原"提示词含 JSON 契约与 anchor/revised 字段"）→ 改成断言协议 v2 的
   `"patches"` / `span_id` / `"op"` / `original` / `replacement` / `"schema_version":2`。
   **断言变多了、覆盖更强**：旧字段仍由解析器兼容分支接收，其覆盖在 80c/80d/81/82 里保持不变。

除此之外没有任何测试被删除、跳过、重命名或弱化；没有被跳过的检查（本工程没有 skip 机制）。

## 4. 每一项"未验证"的如实说明

| 项 | 状态 | 原因 |
|---|---|---|
| 真实 DeepSeek API 的文学效果（审稿覆盖实验 / 局部修稿实验 / 生成实验） | `SKIPPED: paid_evaluation_not_authorized` | 无独立授权与预算；本轮不得把"改代码的授权"扩张成付费批测 |
| 生成实验的对照 | `SKIPPED: missing_frozen_blueprint` | 附件里没有当次蓝图与故事状态 |
| P10/P11 的应用层编排（刷新恢复、取消后晚到响应、重复点击采纳的端到端幂等） | 部分验证 | 模块级已验（P10/P11）；端到端需要隔离实例 + 假模型，本轮未接（属 E07 的隔离实例端到端测试） |
| P13 的"某个必需长文片失败" | 部分验证 | 长正文分段的失败/续跑由既有 `.p1-baseline/test-long-text.mjs` 覆盖（本轮复跑仍绿）；V2 协议下的逐片失败由 P13c 的依赖组原子性覆盖，**但没有**端到端跑一次"必需片失败"的整章流程 |
| R02—R11 的叙事判断（解释冗余、落雪排比、耳机动作、3751 年等） | **确定性层已验；语义层未运行** | E04 的候选层在冻结样本上正例（R02/R04/R06）与阴性对照（R03/R05/R11）都成立；但"该不该改"的语义判断需要真实模型（未授权付费），所以 `semantic_status` 恒为 `not_run`。R08/R09/R10 涉及的"未来科技/人物背景/相对改善"由语义层与人工确认，离线层不覆盖 |
| E02：审稿/修稿请求**自身**的上下文装配是否拿到对应阶段 | **未接线** | 阶段已能通过 HTTP 参数（`stage=`）与前端请求 URL 下发，但审稿路径仍复用上一次 `loadAIContext` 的装配结果：为它单独再取一次装配会多一次装配成本，属需要作者决定的行为改动（execution-state 已记为 next） |
| E02：慢通道（harness preset）与直连对同一阶段输出**等价规则集合** | **未验证** | 本轮只保证 HTTP 装配参数与直连通道支持阶段；preset 人设是另一份文件，未做对照 |
| 真实模型在新 v2 提示词下能否稳定回 `span_id` + 逐字 `original` | **未验证**（独立复查也标为未覆盖） | 严格化的已知代价：偶发丢字会整批 `anchor_mismatch`（分段路径把该片标失败）。建议排一次离线回放 |
| 浏览器 diff → 合并 → 保存 → 服务端空覆盖护栏这条链 | **未验证** | 未跑端到端；"单段正文被删空"目前只有服务端 `EMPTY_OVERWRITE_BLOCKED` 这一层兜底（本轮未验证它确实拦住 diff 合并路径） |
| E03—E06 | **未验证** | 未实现（同上） |
| 文学品味的改善 | 不作声明 | 工程通过 ≠ 文学效果确认；本报告不写"AI 痕迹已消除""自然度提升"这类结论 |

## 4b. 本轮的一次自伤事故与恢复（留痕）

用 PowerShell 批量改写 `public/app.js` 时，PS 5.1 的 `Get-Content -Raw` 默认按 ANSI 读取，
`Set-Content -Encoding UTF8` 再写回，**把整个文件的中文重新编码成乱码并破坏了结构**
（`node --check` 报 `Illegal return statement`；文件从 952,738 B / 15,524 行变成 1,120,301 B / 15,705 行）。

处置：**不猜测损伤范围、直接还原**——从改动前的备份
`data/backup-narrative-repair-20261009181433/files/app.js` 复制回原位（`git diff --stat public/app.js` 为空即证明与 HEAD 一致），
然后用 `edit` 工具逐条**重新施加**本轮对 app.js 的全部改动（E01 6 处 + E02 5 处），
每步都跑 `node --check`，最后跑 `frontend-test.mjs`（exit 0）与全量 `ci-offline-checks.mjs`（**54/0**）确认等价。

以后规则：**不得用 shell 文本重写（Set-Content / sed / 重定向）改动本仓库源码**——
本机 PowerShell 5.1 的默认编码会把 UTF-8 中文破坏掉；只用结构化文件编辑工具。

## 5. 证据可复现入口

```sh
node scripts/test-narrative-repair.mjs      # 专项（90 条断言）
node frontend-test.mjs                      # 前端契约 + 本轮 9c/9d/9e 接线
node scripts/ci-offline-checks.mjs          # 全量离线真源（54 条）
node scripts/materialize-narrative-fixtures.mjs "叙事性专项修复.md"   # 只校验，不覆盖基线
```
