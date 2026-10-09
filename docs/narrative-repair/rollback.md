# rollback —— 怎么退回去，以及为什么不需要动用户数据

> §10.3 要求：源码与新风格开关可**分开**回滚；正确性修复不应因为关掉风格功能而失效；
> 不删除用户数据库，不把新报告改造成旧格式再覆盖。

## 0. 本轮的性质（2026-10-09 收尾更新）

本轮改动 = **正确性修复** + **新增协议/计划模块** + **阶段化规则编译** + **一张新表与两个只读端点**。
与最初版本相比，本节如实更新（早期版本写的是"没有新增开关、没有改数据库结构"，那在 E02/E03/E06 落地后已不成立）：

- **新增表**：`revision_selections`（修稿选择记录，E03）。**纯附加式**：不改既有表结构、不改既有字段语义；
  旧库打开时由 `db.js` 的 `CREATE TABLE IF NOT EXISTS` 建出，旧作品与旧报告照常可读。
  契约随之升 `host_contract 1.21.0 → 1.22.0`（`docs/host-contract.v1.json` 与 `.md` 同步）。
- **新增开关（都是作者本机偏好，默认关闭）**：`允许对已选问题局部压缩`、`把编辑器里选中的文字列为保护`
  （localStorage：`ns_revision_allow_condense` / `ns_revision_protect_selection`；入口在审稿报告弹窗）。
- **没有**新增"生成期的风格功能"：`edit_rules_enabled` 仍是唯一的编辑规则总开关，
  E02 只是把**同一批能力的文本按阶段编译**（`stage_rules`），默认路径（不传阶段）逐字未变。
- **没有**动 `data/`（真实作品库）里的任何一行：写入路径只新增两张表的行（选择记录）与不可变快照逻辑。

## 1. 回滚粒度（四种，从最小到彻底）

### A. 只关新增功能，不碰源码（推荐的日常回滚）

1. **关掉叙事诊断与阶段变体**：作者设置里 `edit_rules_enabled=0`（或 `PUT /api/novel/editing {enabled:false}`）。
   验证：`node .p1-baseline/test-editing-rules.mjs` B10 —— 关闭后 `assembled` 与**默认基线逐字节一致**（退出码 0）。
2. **关掉两个修稿偏好**：`localStorage` 里把两个键设为 `'0'`（或直接清掉）。
   验证：`06` E06-c/E06-d —— 关闭时 `condense` 一律 `refused`（不静默降级）、不额外登记保护项。
3. **不用新增诊断**：`story-shape` 能力本来就是默认关闭；关闭后扫描端点不返回 `narrative`（`test-editing-rules` E14）。
4. **正确性修复仍然生效**（这是 §10.3 的硬要求）：`01-patch-protocol` 的 65 条断言与被测实现
   **完全不依赖**规则开关或阶段（协议模块只吃 `base_text` + 快照 + 选择集合）→ 关掉风格功能不会让精确跨度/显式删除失效。

### B. 回滚新增模块（保留正确性修复之外的东西）——⚠️ 删 `revision-patch.js` 不等于是回滚

本轮审查实测：删掉那一行 `<script>` 后，新提示词仍只索取 span 级补丁（协议 v2），而 v2 的执行依赖该模块：
`parseRevisionPatchesDetailed` → `schema_unavailable`，`refineByChecklist` 会在**付费之前**直接拒绝
（"协议模块未加载"）。**它不会退回旧的 anchor/revised 路径，也不会产生可用候选**——修稿功能等于停用。
若确实要撤掉 v2 协议，必须**同时**把 `buildAIRevisionPatchPrompt` 恢复成旧契约，或干脆按 C 整文件回滚。

`public/revision-plan.js` 同理：删掉后 `revisionPlanFor` 返回 `null` → 修稿退回"整章跨度目录"（有回落，不会静默降级），
但**单处撤销**与**阶段收窄**会失效（撤销按钮点下去会提示"缺少预览状态"）。

### C. 回滚源码改动（回到本轮改动前的源码）
用改动前的备份覆盖对应文件（**不要** `git checkout` —— 那会丢掉作者自己未提交的侧栏改动）：

```
data/backup-narrative-repair-20261009181433/
  files/app.js        → public/app.js
  files/index.html    → public/index.html
  files/styles.css    → public/styles.css
  files/patch-safety.js → public/patch-safety.js
  files/rules.mjs     → ai/editing/rules.mjs
  files/policy.mjs    → ai/writing/policy.mjs
  files/compile.mjs   → ai/writing/compile.mjs
  files/server.js     → server.js
  uncommitted.diff    # 改动前与 HEAD 的完整未提交差异（含作者自己的侧栏改动）
  git-status.txt      # 改动前的 git status
```
⚠️ 备份是**改动前**做的，因此**不包含** `db.js`、`public/revision-plan.js`、
`ai/editing/narrative-scan.mjs`、`ai/editing/narrative-review.mjs`、`harness-plugins/novel-writing/novel-tools.mjs`、
`.p1-baseline/test-editing-rules.mjs`、`docs/host-contract.*` 等**本轮后续才改到**的文件——
整文件回滚时这些要单独处理（新文件直接删除；被改的按 `uncommitted.diff` 里没有它们的部分手工还原，
或从 `docs/narrative-repair/source-map.md` 列出的改动点逐个撤销）。

新增文件（回滚时一并删除即可；除 `index.html` 的 `<script>` 外没有 import 点）：
`public/revision-patch.js`、`public/revision-plan.js`、`ai/editing/narrative-scan.mjs`、`ai/editing/narrative-review.mjs`、
`tests/narrative-repair/**`、`docs/narrative-repair/**`、`scripts/test-narrative-repair.mjs`、
`scripts/materialize-narrative-fixtures.mjs`、`scripts/run-narrative-acceptance.mjs`、`.p1-baseline/verify-preset-copy.mjs`。

同时回滚这些**共用文件**的本轮改动：`ai/editing/rules.mjs`（v1.5.0 的 `stage_rules`/`audit`）、
`server.js`（`normalizeStage`/`stageCacheSuffix`、两个 context 端点的 stage、`/api/ai_context` 的 `edit_rules`、
`PUT /api/novel/review` 的结构化、`/api/novel/revision/*` 两条只读端点、`revision_selections` 的读写）、
`db.js`（`revision_selections` 建表）、`harness-plugins/novel-writing/novel-tools.mjs`（`novel_review.findings`、
`novel_context.stage`、`novel_write_pipeline` 的 `stage=draft`）、`docs/host-contract.*`（1.22.0）、
`scripts/ci-offline-checks.mjs`（"叙事性专项修复总入口"那一条）、`frontend-test.mjs` 与
`.p1-baseline/test-editing-rules.mjs` 的本轮断言块。

### D. 彻底回到提交点
本轮**没有** git commit / push（按任务书要求）。若要回到仓库状态：保留作者未提交的 `index.html` / `styles.css` 改动，
其余按 C 处理。

## 2. 回滚的验证方式

回滚后必须复跑同一条真源并给出退出码：

```sh
node scripts/ci-offline-checks.mjs        # 改动前基线：通过 53 / 未通过 0；本轮落地后：54 / 0
node scripts/run-narrative-acceptance.mjs # 留下 cwd/时间/退出码/计数/日志的完整证据（E07）
```

**提交前门禁（本轮已完成登记，剩余问题非本轮引入）**：`node .p1-baseline/verify-phase-map.mjs`
—— 本轮的 27 个文件已登记进新阶段 `SE6`（该门禁已报告"✓ SE6 的 6 项证据都在"，且**本轮改动无未归属文件**），
`docs/phase-map.md` 已用 `--write` 重新生成。该门禁**仍然失败**，原因是仓库里还有 **96 个历史遗留文件**
（更早几轮的草稿/探针）没有归属；那不是本轮的改动，我没有代替作者认领（认领别人的文件会让回滚说明变成假的）。

## 3. 哪些东西**不会**因为回滚而损坏

| 资产 | 影响 |
|---|---|
| 已有小说正文、章节、蓝图 | 无（本轮没有任何写入用户内容的路径改动） |
| 已有审稿报告（`chapter_reviews`） | 无：旧格式继续可读（legacy 解析分支保留，见 `01` 的 legacy 载荷用例） |
| 作者选择/清单（`checklist_json`） | 无：结构未改 |
| 新增的选择记录（`revision_selections`） | 回滚后该表不再被读写；**表本身可以保留不动**（不删用户数据），也可在确认不需要后手工删除 |
| 数据库 | 旧库可打开：`test-migration-idempotent` A1/B1/C1/D1—D3（重复启动不漂移、旧库只读指纹、损坏库响亮失败不篡改原文件）+ `test-host-contract`"契约冻结的全部表在旧库里都存在" |
| 作者自己未提交的侧栏改动 | 无：备份与 `uncommitted.diff` 都保留了改动前状态，回滚用复制而不是 `git checkout` |

## 4. 已知的"回滚也不该恢复"的行为

以下三条是**正确性修复**，任务书明确要求它们不应随风格开关一起失效
（它们与规则开关/阶段无关，见 §1.A.4 的证据）：

1. 失败不再自动扩大为整章重写（一次付费、无补丁级门禁的整章覆盖）；
2. 显式删除（`op:'delete'`）与精确跨度替换；
3. 坏载荷（`patches:[{}]`、半截 JSON、重复 key、冲突 JSON）不再被折叠成"合法无修改"。
