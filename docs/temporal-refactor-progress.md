# 时态故事状态重构 · 执行进度

> 规格：根目录《方案.md》《架构重构.md》。规则：只有「代码 + 生产接线 + 迁移 + 测试实跑」同时满足才可标 DONE；SKIP ≠ PASS。
> 基线 HEAD：`7d61390ccf0c52048c1a2df92c23701a684656a9`（任务开始时工作区干净）。

## 阶段总览

| 阶段 | 状态 | 说明 |
|---|---|---|
| T0 | DONE | 审计、基线实跑、Frozen Write Allowlist 冻结（见 `docs/temporal-refactor-audit.md`） |
| T1 | DONE | 版本化状态底座与历史查询；生产端点 + 隔离/HTTP 测试全绿（AC-01/02/03/09/10/11/12/30/31/37） |
| T2 | DONE | 保存后自动提取与作者批量确认；输入绑定/服务端复核/一次性审批/兼容投影（06/07 全绿） |
| T3 | DONE | 全下游失效与隐性因果复核；工作线逐章重新验证；08（27）/09（18）全绿（AC-04/05/06/07/08/14） |
| T4 | DONE | 按钮驱动的逐章候选重建；一次性审批 + 逐章串行 + 原子 apply/revert（10:15 / 11:37 全绿，AC-15–27） |
| T5 | DONE | 时态上下文与工具查询全链路接入：统一 cursor 过滤全部上下文层 + 工具查询 + 缓存失效 + 契约 1.17.0（12:62 / 13:17 全绿，AC-32/33/34/37） |
| T6 | DONE | 独立导航、章末状态与重建界面（frontend-test 346/0 含 T6-1..T6-18） |
| T7 | DONE | 存量重建、迁移、开关与回退（14:8 / 15:30 / frontend T7-1..T7-11 全绿） |
| T8 | DONE | 综合验收与交付审计：AC-01–48 映射 + 性能基线（100/500/1000 章）+ 日志卫生（16 号 33 断言）+ 全量回归（verify-all 49/1/6；唯一未通过为环境前置不满足，见 T8 段） |

## T0（DONE）

- 实际修改文件：`docs/temporal-refactor-audit.md`（新建）、`docs/temporal-state-contract.md`（新建）、`docs/temporal-refactor-progress.md`（新建）、`docs/temporal-refactor-progress.json`（新建）
- 实际实现：只读审计 + 冻结写入白名单；未改动任何生产代码
- 生产调用链：n/a（审计阶段）
- 执行命令与结果：
  - `git rev-parse HEAD` → `7d61390ccf0c52048c1a2df92c23701a684656a9`
  - `git status --porcelain=v1` → 空（无用户未提交改动）
  - `node scripts/ci-offline-checks.mjs` → 通过 49 / 未通过 0（零计费）
  - `node scripts/ci-isolated-run.mjs --port 3756 -- node .p1-baseline/test-story-state-api.mjs --base http://127.0.0.1:3756` → 通过 75 / 失败 0 / 跳过 0
- Scope Audit：Files written this phase = 4 个新文档；全部在允许新增清单内；package.json / lockfile / AGENTS.md / README / data/ / 无关模块均未触碰
- 已知限制：无
- 剩余问题：无（T0 完成）

## T1（DONE）

### 实际修改文件

- 新增 `ai/story-state/temporal/` 15 个模块：`schema.mjs`（16 域/4 scope、normalizeOp 强制 expected、事件与证据哈希）、`reducer.mjs`（纯归约、前置条件失败即冲突、state_content_hash 与 lineage_hash 分离）、`order.mjs`（唯一章序：卷→根章节→场景；order 版本不可变）、`config.mjs`（三个开关 + 11 表自检）、`revision-store.mjs`（内容寻址不可变修订）、`snapshot.mjs`、`event-store.mjs`（事件 + 绑定 + 提交级信任覆盖）、`worldline-store.mjs`（main 世界线 / 提交 / 清单 HEAD CAS）、`history.mjs`（按提交清单归约、pending/stale 处停住）、`validation.mjs`、`projection.mjs`（章节状态面板）、`dependencies.mjs`（由 op.expected 提取依赖）、`impact.mjs`（保守全下游 stale + 最早差异章）、`service.mjs`（唯一生产入口）、`index.mjs`
- 新增测试：`tests/temporal/harness.mjs`、`01-pure.test.mjs`（8）、`02-history.test.mjs`（6）、`03-integrity.test.mjs`（8）、`04-http.test.mjs`（30 断言）；新增总入口 `scripts/test-temporal-refactor.mjs`
- 新增文档：`docs/temporal-refactor-audit.md`、`docs/temporal-state-contract.md`、`docs/temporal-refactor-progress.md`、`docs/temporal-refactor-progress.json`
- 修改既有文件（Frozen Write Allowlist §7 内）：`db.js`（11 张表 + `story_state_config` 三个开关列 + 迁移登记）、`ai/story-state/index.mjs`（`export * as Temporal`）、`server.js`（`HOST_CONTRACT_VERSION` 1.13.0 + `/api/novel/state/temporal|at|panel|confirm`）、`docs/host-contract.v1.json`、`docs/host-contract.md`、`docs/README.md`、`docs/plugin-runtime-map.md`、`scripts/ci-offline-checks.mjs`、`.p1-baseline/verify-all.mjs`、`.p1-baseline/verify-phase-map.mjs`（阶段 TT）；生成的 `docs/phase-map.md`

### 实际实现（能力）

- 唯一权威来源：不可变正文修订 + 类型化事件（必须带前置条件与证据锚点）+ 提交清单 + 章序版本 + main 世界线；旧字段未被改写，仅降级为兼容投影（投影切换在 T5/T7）。
- `recordContentSave`（保存后处理）：内容真的变化才落不可变修订 → 归档旧 pending → 新 pending 绑定；默认 HEAD 查询在 pending/stale 处停住，不用旧状态冒充新稿。
- `applyChapterEvents`（作者确认，原子）：事件归约校验（前置条件/证据/叙述类型）→ 章前·章后快照 → valid 绑定 → 提交（HEAD CAS）→ 复制父提交信任覆盖 → 下游一律 stale → 依赖索引；任一步失败整事务回滚；重复调用幂等（内容寻址）。
- 历史查询：任意章节可查「截至该章」状态；`commit_id` 可回放旧提交（旧提交不受新稿影响）；`/api/novel/state/panel` 给出章前/章后、出场、变更、关系、剧情线与完整 Story State。
- 未开启 `temporal_enabled` 的作品：全部入口返回 `enabled:false` 且零写入；开关由作者显式打开（模型侧 403）。

### 生产调用链

- `server.js` → `StoryState.Temporal`（`temporal/service.mjs`）→ `event-store` / `worldline-store` / `history` / `projection`；HTTP 路由 4 条（作者侧；不在插件白名单内）。
- 章节状态面板的数据源 = `temporal/projection.mjs`；前端接线在 T6（本阶段不声称 UI 已完成）。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | 通过 3 / 未通过 0 个子套件（01: 8、02: 6、03: 8） |
| `node scripts/ci-isolated-run.mjs --port 3756 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3756` | 通过 30 / 失败 0 / 跳过 0（隔离库，自建作品自清理，零计费） |
| `node .p1-baseline/test-host-contract.mjs` | 通过 28 / 失败 0 / 跳过 0（契约 1.13.0，旧库指纹一致） |
| `node .p1-baseline/test-migration-idempotent.mjs` | 通过 13 / 失败 0（空库 71 张表、重复启动不漂移、损坏库响亮失败） |
| `node .p1-baseline/verify-phase-map.mjs` | 330 个改动全部有归属（新增阶段 TT） |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0（含新增 temporal 总入口，零计费） |

### 验收覆盖

- AC-01（第 5 章存活 / 第 10 章战死，两个历史查询不同）、AC-02（新稿第 5 章死亡、原提交仍显示存活）、AC-03（章前不含本章结尾事件）、AC-09/10/11（多域变化 + 不自动删关系/不自动补知情）、AC-12（改写删除旧事件，旧历史可回放）、AC-30（章序版本不可变 + 从最早差异处失效）、AC-31（来源改变不跳过）、AC-37（未来状态不冒充历史）。测试见 `tests/temporal/01–04`。

### Scope Audit

```text
Files written this phase:
- ai/story-state/temporal/*（15 个新模块）
- tests/temporal/*（4 个测试 + harness）
- scripts/test-temporal-refactor.mjs、docs/temporal-refactor-audit.md、docs/temporal-state-contract.md、docs/temporal-refactor-progress.md、docs/temporal-refactor-progress.json
- db.js、ai/story-state/index.mjs、server.js、docs/host-contract.v1.json、docs/host-contract.md、docs/README.md、docs/plugin-runtime-map.md、scripts/ci-offline-checks.mjs、.p1-baseline/verify-all.mjs、.p1-baseline/verify-phase-map.mjs、docs/phase-map.md（生成）
All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始前工作区为空，无用户未提交改动）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（仓库根 README；docs/README.md 为白名单内的文档索引更新）
real data/ untouched: YES（全部测试走 NOVELSTUDIO_DATA_DIR 临时目录 / 隔离实例）
unrelated modules untouched: YES
```

### 未完成 / 未验证事项（按阶段归属，不计入 T1 完成）

- T2：所有正文保存入口接入 `recordContentSave`；自动分析（fake provider 可验）→ 本章统一提案组 → 作者一次确认；手工状态改动的命令化（AC-13/22/25/28/29/42/43/44/45）。
- T3：依赖与隐性因果复核、影响报告（AC-04–08/14）。
- T4：按钮驱动的逐章候选重建（AC-15–27）。
- T5：上下文与工具查询的时态接线（AC-32/33/34）。
- T6：五组独立导航 + 正文状态面板 + 重建界面（AC-35/36/38）。
- T7/T8：存量迁移、开关回退、综合验收（AC-39–41、46–48）。

### 已知限制 / 剩余问题

- `story_snapshots`（旧操作回滚快照）语义未动；旧字段仍可写（命令化在 T2 完成前不得声称已统一）。
- 前端尚未接线（T6），因此本阶段不声称 UI 完成。
- 无阻塞。

## T2（DONE，2026-09-30）

### 实际修改文件（T2，含上一轮已落地部分）

- 修改（Frozen Write Allowlist §7 内）：`server.js`（保存后自动分析调度、9 个正文入口接线、提案组/确认/分析/更正路由、旧字段命令化互锁、审批端点扩展）、`ai/story-state/approval.mjs`（`APPROVAL_OPS` 增 `temporal_apply / temporal_correction / repair_run_start / repair_run_apply` + `checkBinding` 分支）、`scripts/ci-offline-checks.mjs`（说明）、`docs/host-contract.v1.json` / `docs/host-contract.md` / `docs/README.md` / `docs/plugin-runtime-map.md`（契约 1.13.0 → 1.14.0）、`.p1-baseline/verify-phase-map.mjs`（TT 为目录级认领，新文件自动登记）、`docs/phase-map.md`（生成）
- 新增/修改（Temporal 目录与测试目录，属允许新增清单）：`ai/story-state/temporal/{analysis,extraction,validation,service,compat}.mjs`、`tests/temporal/06-http-save-entries.test.mjs`、`tests/temporal/07-proposal-binding.test.mjs`、`tests/temporal/http-harness.mjs`、`scripts/test-temporal-refactor.mjs`（登记 06/07）
- 测试期望更新（如实说明）：`tests/temporal/05-save-pipeline.test.mjs` 的「AC-44 原子回滚」原断言快照数 = 0；T2 §6.1 现在会在**保存时**落「输入快照」作为提案绑定，因此改为断言「失败确认不得**新增**快照」（其余不变：无 valid 绑定、无新提交、HEAD 不动、无依赖行）。这是设计变更导致的期望更新，不是放宽门禁。

### 实际实现

- 提案输入绑定（§6.1）：保存时 pending 绑定携带 `pending_context = { contract(id/version/algorithm), revision_id, revision_text_hash, order_version_id, head_commit_id, input_snapshot_id, input_state_hash, input_commit_id, input_trusted, payload_hash, dependencies, created_at }`；分析完成时写入 `analysis.payload_hash`（事件载荷摘要）与 `analysis.payload_dependencies`。
- 确认时服务端复核（`verifyPendingContext`）：契约版本、章序版本、章前状态哈希与提交、payload hash；不符 → `stale`（旧提案**原样保留**，可查、可重新分析）或 `needs_review`（载荷被改动）。`beginAnalysis` 在重新分析前刷新输入绑定（`refreshPendingContext`），保证"重新分析后可确认"。
- 原子确认：CAS → 输入/输出快照 → valid 绑定 → 提交（HEAD CAS）→ 信任覆盖 → 下游 stale → 依赖索引 → **兼容投影刷新**；任一步失败整事务回滚；不接受 `events` / `event_ids` 子集（400，AC-45）。
- 兼容投影（`compat.mjs`）：只从**已确认状态**单向刷新 `characters.status` 与 `character_relations.relation/description`；只更新已存在的行，不新建/删除实体；剧情线无安全对应字段（summary 是作者原文），如实跳过。
- 审批语义（决策，已写入契约 §4）：作者侧确认 = 日常批量确认，服务端重算全部基线；模型侧 apply/analyze/correct 一律 403（模型不能确认自己的抽取）；可选一次性审批由作者界面创建（服务端计算 baseline 与结构化绑定），确认时在**同一事务的最后一步**消费，失败整体回滚；不匹配（错误 op / 跨作品 / 基线已变 / 绑定不符）一律拒绝且**不消费**无关审批（AC-43）。

### 生产调用链

- 9 个正文入口全部接入统一后处理 `afterTemporalContentSave`（同事务落不可变修订 + pending 提案，分析走后台防抖队列，保存不等待模型）：W1 `PUT /api/chapters/:id`（editor_save；W2 自动保存同一路径）、W3 `PUT /api/novel/chapter_save`（agent_write_back）、W4 `POST /api/novel/adopt`（adopt）、W5 `POST /api/chapter_versions/:id/restore`（restore）、W6 导入 `importWorkFromChapters`（import）、W7 `installDemo`（demo）、W8 `createNovelFromData`（ai_generate）、W9 `POST /api/chapters` 带正文（chapter_create）。
- 阴性 N1 finalize / N2 draft / N3 mark_applied / N4 沙盘采纳：不接入，HTTP 级证明零修订、零提案、HEAD 不动、零模型调用（06 G8）。
- 旧字段互锁（AC-44）：`temporalLegacyStateWrite` 在启用作品上要求 `chapter_id` 并转为 author_correction 事件；未启用作品语义不变。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | 通过 6 / 未通过 0 个子套件（01:8、02:6、03:8、05:8、06:66、07:50） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | 通过 30 / 失败 0 / 跳过 0 |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0（含 temporal 总入口；零计费） |
| `node .p1-baseline/test-host-contract.mjs` | 通过 28 / 失败 0 / 跳过 0（契约 1.14.0） |
| `node .p1-baseline/test-approval-boundary.mjs` | 通过 50 / 未通过 0（op 扩展未破坏既有审批边界） |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | 通过（TT 认领 56 个文件） |
| `node tests/temporal/06-http-save-entries.test.mjs` | 通过 66 / 失败 0（自托管隔离实例 + 本机假模型） |
| `node tests/temporal/07-proposal-binding.test.mjs` | 通过 50 / 失败 0（同上；B4 篡改检测仅自托管时执行，--base 外部实例时如实 SKIP） |

### 验收覆盖（T2）

- AC-13/22/25/28/29/42/43/44/45：`06-http-save-entries`（G1–G10）与 `07-proposal-binding`（B1–B6）HTTP 级证据；AC-11/12 的域级证据在 T1 测试。
- 07 逐项：B1 输入快照/HEAD/章序/契约/payload hash 绑定 + 兼容投影；B3 上游变化 → stale（保留）→ 重新分析 → 确认；B4 payload hash 篡改 → needs_review 且不写入；B5 审批错误 op/跨作品/正确消费/重复确认幂等；B6 事件子集拒绝 + 基线变化审批不适用且不消费。

### Scope Audit

```text
Scope Audit

Files written this phase:
- server.js、ai/story-state/approval.mjs、scripts/ci-offline-checks.mjs、.p1-baseline/verify-phase-map.mjs
- docs/host-contract.v1.json、docs/host-contract.md、docs/README.md、docs/plugin-runtime-map.md、docs/phase-map.md（生成）
- ai/story-state/temporal/{analysis,extraction,validation,service,compat}.mjs
- tests/temporal/{05-save-pipeline.test.mjs（期望更新）,06-http-save-entries.test.mjs,07-proposal-binding.test.mjs,http-harness.mjs}
- scripts/test-temporal-refactor.mjs
- docs/temporal-refactor-progress.md、docs/temporal-refactor-progress.json、docs/temporal-refactor-audit.md、docs/temporal-state-contract.md

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始前工作区为空，无用户未提交改动）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES
real data/ untouched: YES（全部测试走 NOVELSTUDIO_DATA_DIR 临时目录 / 隔离实例）
unrelated modules untouched: YES
```

### 未完成 / 未验证事项（按阶段归属，不计入 T2 完成）

- T3：依赖与隐性因果复核、影响报告（AC-04–08/14）。
- T4：按钮驱动的逐章候选重建（AC-15–27）。
- T5：上下文与工具查询的时态接线（AC-32/33/34）。
- T6：五组独立导航 + 正文状态面板 + 重建界面（AC-35/36/38）。
- T7/T8：存量迁移、开关回退、综合验收（AC-39–41、46–48）。

### 已知限制 / 剩余问题

- 前端尚未接线（T6）：提案组/确认目前通过 API 使用；`proposal-groups` 已按界面需要暴露输入绑定（`pending_context`）。
- `refreshPendingContext` 目前只由 `beginAnalysis` 调用；若未来出现其它"重跑分析"入口，必须复用同一函数。
- 无阻塞。


## T3（DONE，2026-09-30）

### 实际修改文件（T3；含本轮 09 接线与阶段映射修正）

- 新增 `ai/repair/analyzer.mjs`：全下游保守复核运行（只分析、不生成）——工作世界线 `wl_an_*`、逐章 `revalidateChapter`、候选绑定与提交推进、经 `ai/repair/store.mjs`（T1 建表）落 `story_repair_runs` / `story_repair_steps`；导出 `runImpactAnalysis` / `listImpactRuns` / `impactRunView`。
- 修改 `ai/story-state/temporal/extraction.mjs`（`ASSUMPTION_KINDS` + `parseAssumptions`：目标/原因/资源/承诺/知识/因果；quote 必须是正文原句，否则只记 issues；抽取提示词规则 ⑥）。
- 修改 `ai/story-state/temporal/service.mjs`（`completeAnalysis` / `finalizeValidGroup` 贯穿 `assumptions`：提案 `validation.assumptions` → valid 绑定保留）。
- 修改 `ai/story-state/temporal/analysis.mjs`（传递 `parsed.assumptions`）。
- 修改 `server.js`：① `afterTemporalContentSave(..., generation)` 写 `origin.extra.generation`，`createNovelFromData` / `generateNovelFromPrompt` / `generateNovelFromHarness` 传入 `{kind:'recorded', source, provider, model, context_version, context_hash, read_set, retrieved, contract, at}`（W8 生成来源可追踪）；② `runTemporalImpact` + `scheduleTemporalImpact`（1.2s 防抖、同章去重、跟随 `auto_analysis` 开关）；③ `confirm` / proposal-group `apply` / `correct` 成功后调度；④ 新路由 `GET/POST /api/novel/state/impact`（GET 列表或 `run_id` 视图；POST 作者显式/refresh；模型侧 403）；⑤ `HOST_CONTRACT_VERSION` 1.15.0。
- 修改契约面：`docs/host-contract.v1.json`（`host_contract` + contract_history 1.15.0）、`docs/host-contract.md`、`docs/README.md`、`docs/plugin-runtime-map.md`。
- 修改 `scripts/test-temporal-refactor.mjs`（登记 08/09）。
- 修改 `.p1-baseline/verify-phase-map.mjs`（`ai/repair/` 归属 TT）并重新生成 `docs/phase-map.md`。
- 新增测试：`tests/temporal/08-impact-analysis.test.mjs`（27 断言）、`tests/temporal/09-impact-http.test.mjs`（18 断言）。

### 实际实现（能力）

- 保守覆盖：根事实确认后把根章之后的**全部**章节送入复核（`all_downstream`）；依赖图与显式命中只用于解释/排序，**不排除**章节；`explicit_hits_only` 仅作变异对照（08 变异测试证明它不是姓名搜索）。
- 隐性因果：复核输入 = 变化清单（来自根章绑定）+ 工作线章前状态 + 本章前提清单（assumptions）+ 正文原文；模型结论仅 valid / conflict / needs_review，conflict 必须带证据。
- 新前缀累积：复核在 `wl_an_*` 工作世界线执行，章前 = 根章后 + 已复核候选的累积；第 7 章输入必须使用**第 6 章候选提交**，而不是运行启动时的旧计划（08 与 09 G3 双证）。
- 跨冲突不静默：首个非 valid 后置 `prefixBroken`，其后章节标 `blocked`，但仍做模型初筛并记录 `explicit_conflicts`（报告呈现，不冒充通过）。
- 不生成正文：`totals.generated_revisions=0`、每步 `revision_unchanged`（含 blocked 步）；原生成来源保留；验证来源写在**新绑定**的 `validation.revalidation`（source=impact_analysis/version、base_binding_id、base_revision_id、输入状态哈希/commit、checked、冲突明细）；`writer.calls=0`。
- 根章未确认（tentative）：存在未确认 pending 时只生成 `needs_review` 运行，零模型调用、零候选绑定（AC-13 的时态面）。
- 生成来源判定：`generationProvenanceOf(revision)` 无 `origin.extra.generation` → `unknown`（手工旧稿 / 外部写回不伪造来源）。
- 报告：结构化 downstream 明细（chapter/status/input/显式出场与依赖/隐性因果/确定性结果/生成来源/复查项）+ `totals`。

### 生产调用链

- 自动触发（确认路径）：`POST /api/novel/state/confirm`、`POST /api/novel/state/proposal-groups/:id/apply`、`POST /api/novel/state/correct` 成功后 `scheduleTemporalImpact`（仅 `temporal_enabled` 且 `auto_analysis` 开启的作品）→ `TemporalRepair.runImpactAnalysis`（落库运行）。
- 作者显式：`POST /api/novel/state/impact`（`refresh:true` 新建运行）；读取：`GET /api/novel/state/impact`（列表或 `run_id` 视图）。
- 模型侧（X-Novel-Agent）：POST → 403；GET 只读运行报告。
- 本阶段不写正文：运行只产生候选绑定与报告，不写 `chapters`；重建与批准在 T4。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | 通过 8 / 未通过 0 个子套件（01:8、02:6、03:8、05:8、06:66、07:50、08:27、09:18） |
| `node tests/temporal/08-impact-analysis.test.mjs` | 通过 27 / 失败 0（进程内真实服务 + 临时隔离库 + 确定性假模型） |
| `node tests/temporal/09-impact-http.test.mjs` | 通过 18 / 失败 0（自托管隔离实例 + 本机假模型；零计费） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | 通过 30 / 失败 0 / 跳过 0 |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0（含 temporal 总入口；零计费） |
| `node .p1-baseline/test-host-contract.mjs` | 通过 28 / 失败 0 / 跳过 0（契约 1.15.0） |
| `node .p1-baseline/test-approval-boundary.mjs` | 通过 50 / 未通过 0 |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | 通过（TT 认领 51 个文件；`ai/repair/` 已归属） |

### 验收覆盖（T3）

- AC-04/05/06/07/08/14：
  - 08 夹具 A（无姓名等待接应 → `implicit_causal` conflict，文本不含「王师傅」）；夹具 B（独立行动 → kept：原文保留 + 新验证绑定）；夹具 C（冲突前缀阻断时第 7 章输入使用第 6 章候选提交）；夹具 D（显式出场 → conflict，quote 为正文原句）；夹具 E（梦中出现 → needs_review，不误报复活）；变异对照（`explicit_hits_only` 跳过 ≥1 章且夹具 A 不再被发现）。
  - 09 G1–G6：作者更正后自动触发 analyze（只分析）、GET 报告/步骤、新前缀输入、零生成零改写、模型侧 403、未开启作品零写入零模型。
  - tentative：根章未确认 → needs_review、零调用零绑定（AC-13 时态面补充）。

### Scope Audit

```text
Scope Audit

Files written this phase:
- ai/repair/analyzer.mjs（新建；ai/repair/ 为白名单允许的新模块目录）
- ai/story-state/temporal/{analysis,extraction,service}.mjs（白名单内既有新模块）
- server.js、docs/host-contract.v1.json、docs/host-contract.md、docs/README.md、docs/plugin-runtime-map.md（白名单内）
- scripts/test-temporal-refactor.mjs、.p1-baseline/verify-phase-map.mjs、docs/phase-map.md（生成；白名单内）
- tests/temporal/{08-impact-analysis.test.mjs,09-impact-http.test.mjs}（新建；tests/temporal/ 允许）
- docs/temporal-refactor-progress.md、docs/temporal-refactor-progress.json（进度记录）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净，无用户未提交改动）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改；docs/README.md 属契约面白名单）
real data/ untouched: YES（全部测试走 NOVELSTUDIO_DATA_DIR 临时目录 / 隔离实例）
unrelated modules untouched: YES
```

### 未完成 / 未验证事项（按阶段归属，不计入 T3 完成）

- T4：按钮驱动的逐章候选重建（AC-15–27）——`ai/repair/runner.mjs`、`repair_run_start` / `repair_run_apply` 一次性审批、有界重试（≤3 次/章）、取消/可恢复/幂等、apply 一次原子。
- T5：上下文与工具查询的时态接线（AC-32/33/34）；T6：独立导航、章末状态面板与重建界面（AC-35/36/38）；T7/T8：存量迁移、开关回退与综合验收。
- 09 的显式 refresh 运行与自动运行按 `created_at` 选择较新者；未做毫秒级排序断言（非验收项）。

### 已知限制 / 剩余问题

- 复核结论依赖注入的模型适配器；无可用模型时章节如实标 `needs_review`（不冒充通过）。
- `scheduleTemporalImpact` 覆盖 confirm / apply / correct 三个作者写入口；T4 重建将复用同一工作线/候选语义。
- 无阻塞。


## T4（DONE，2026-09-30）

### 实际修改文件（T4）

- 新增 `ai/repair/runner.mjs`：按钮驱动的逐章候选重建运行 —— `planRepair`（下游连续前缀 + 根章 valid 绑定/可回退基线检查 + `scope_hash`）、`startRepairRun`（同一事务消费 `repair_run_start` 审批 + 建运行/工作线，后台驱动）、`driveRepairRun`（lease + fencing token、逐章串行、断点跳过、checkpoint/totals 落库、ready 门槛）、`verifyChapter` / `commitKeptChapter`（保留章：正文不改，只新增 `validation.repair_keep` 验证来源绑定）、`attemptRepair` / `repairChapter`（每章 ≤3 次有界重试、重复冲突指纹早停、根锁、候选 0.4–2.5 倍且 ≤20000 字）、`landRepair`、`finalSweep`（≤3 轮，比较输入 `state_content_hash` 漂移）、`resumeRepairRun`（扩展预算不重置）、`cancelRepairRun`（幂等）、`repairRunView`（`ready_gate` 服务端重算）、`applyRepairRun`（单事务：消费 `repair_run_apply` → 旧稿备份 → 正文/绑定/HEAD/兼容投影/outbox 原子切换；重复 apply 返回同一回执）、`revertRepairRun`（恢复提交；应用后已有新编辑 → CAS 拒绝不覆盖）、`repairStartBinding` / `repairApplyBinding`（审批创建端点的服务端绑定计算）。
- 修改 `server.js`：新路由 `GET /api/novel/state/repair`（列表 / `run_id` 视图）与 `POST /api/novel/state/repair/{start,resume,cancel,apply,revert}`（全部作者动作，模型侧 403；注入真实 hooks `saveChapterVersion` / `enqueueProjectionInTx`）；`/api/novel/approvals` 支持 `repair_run_start`（绑定根章/基线/范围）与 `repair_run_apply`（绑定 run_id/manifest_hash；未就绪 409）；`HOST_CONTRACT_VERSION` 1.16.0。
- 修改 `ai/story-state/approval.mjs`（`checkBinding` 支持 `repair_run_start` / `repair_run_apply`）。
- 修改契约面：`docs/host-contract.v1.json`（1.16.0 + contract_history 第 17 条）、`docs/host-contract.md`、`docs/README.md`、`docs/plugin-runtime-map.md`。
- 修改 `scripts/test-temporal-refactor.mjs`（登记 10/11）；重新生成 `docs/phase-map.md`（`verify-phase-map --write` 后复跑通过；`ai/repair/runner.mjs` 由生产代码 server.js import，归属 TT）。
- 新增测试：`tests/temporal/10-repair-runner.test.mjs`（进程内 15 用例：主流程 4 + 注入 11）、`tests/temporal/11-repair-http.test.mjs`（HTTP 生产接线 37 断言）。

### 实际实现（能力）

- 一次性启动授权：`repair_run_start` 的绑定（root_chapter_id / base_commit_id / scope_hash）由服务端从真实存储计算；同一按钮重复点击按幂等键 `repair|work|scope_hash` 复用既有运行，且**不消费**新签发的审批（11 H5 证明）。
- 范围与可回退性：根章之后的下游**连续前缀**（不可跳过中间章节）；根章必须已有 valid 绑定且最新正文已确认；目标章必须有可回退的确认绑定与正文修订（否则 `startable:false`，先确认再重建——刻意行为）。
- 逐章串行（叙事顺序）：第 N 章先复核（确定性 `validateEventSet` 复算 + 注入式模型语义复核）→ 仍成立：保留原 revision、只新增验证来源绑定（`revision_unchanged` 可证）→ 不成立：生成最小修订候选 → 抽取新事件 → 确定性前置条件 → 根锁（不得撤销已确认变更）→ 语义复核 → 候选入工作线；第 N+1 章输入 = 第 N 章输出（`state_content_hash` 链断言）。
- 未来状态隔离：章前状态只从工作线 HEAD 归约（boundary=before）——第 N 章绝不可见未来章节事实（future-state leakage 防护）。
- 候选 ≠ 正式：运行期间 `chapters.content` 逐字节不变（10/11 双证）；只有 apply 才在单事务内切换正式正文 + 绑定 + HEAD + 兼容投影 + outbox，并经 hooks.saveChapterVersion 留旧稿备份；revert 产生恢复提交。
- 可恢复/幂等/中止：lease + fencing（旧 worker 不得回写）、断点跳过、`resume` 不重置已消耗预算、`cancel` 幂等、`ready_gate` 由服务端重算（全部 kept/repaired 且无 blocked/needs_review/stale/failed 才 ready）。
- 边界：五个 POST 动作模型侧（X-Novel-Agent）一律 403；审批单次消费；apply 前未就绪签发 apply 审批 → 409；无审批 apply → 403；基线漂移后旧审批被拒（403）。

### 生产调用链

- 启动：`POST /api/novel/approvals`（op=repair_run_start）→ `POST /api/novel/state/repair/start` → `startRepairRun`（消费审批 + 建运行/工作线）→ 后台 `driveRepairRun`（真实假模型/真实模型通道 = 既有 `callAI`）。
- 就绪：`GET /api/novel/state/repair?work_id&run_id`（运行 + 步骤 + ready_gate）→ `POST /api/novel/approvals`（op=repair_run_apply）→ `POST /api/novel/state/repair/apply` → 单事务切换 + 版本备份；`POST /api/novel/state/repair/revert` 恢复。
- 恢复/取消：`POST /api/novel/state/repair/{resume,cancel}`。
- 模型侧：全部写动作 403；GET 只读。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | 通过 10 / 未通过 0 个子套件（01:8 02:6 03:8 05:8 06:66 07:50 08:27 09:18 10:15 11:37） |
| `node tests/temporal/10-repair-runner.test.mjs` | 通过 15 / 失败 0（主流程 4 + 注入 11；进程内真实服务 + 临时隔离库 + 确定性假模型） |
| `node tests/temporal/11-repair-http.test.mjs` | 通过 37 / 失败 0（自托管隔离实例 + 本机假模型；零计费；连跑 3 次稳定） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | 通过 30 / 失败 0 / 跳过 0 |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0（零计费） |
| `node .p1-baseline/test-host-contract.mjs` | 通过 28 / 失败 0 / 跳过 0（契约 1.16.0） |
| `node .p1-baseline/test-approval-boundary.mjs` | 通过 50 / 未通过 0 |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | 通过 |

### 验收覆盖（T4）

- AC-15/16/17/18/19/20/21：一次启动自动逐章、第 N+1 章输入使用第 N 章候选（新前缀链）、根锁拒绝撤销已确认变更、候选比例/长度边界与每章 ≤3 次有界重试、重复冲突指纹早停、未来状态隔离、apply 前正式正文逐字节不变。
- AC-22/23/24/25：重复点击/重复 apply 幂等回执、审批单次消费、旧 worker fencing、取消（断点保留）与 resume（预算不重置、断点续跑）。
- AC-26/27：apply 单事务原子切换（正文/绑定/HEAD/兼容投影/outbox + 旧稿备份）、revert 恢复提交、应用后新编辑 CAS 拒绝不覆盖。
- AC-28/29（T2 起）：未开启作品零写入、模型侧边界；T4 复核点见 11 H0/H3/H6/H7。

### Scope Audit

```text
Scope Audit

Files written this phase:
- ai/repair/runner.mjs（新建；ai/repair/ 为白名单允许的新模块目录）
- server.js、ai/story-state/approval.mjs（白名单内）
- docs/host-contract.v1.json、docs/host-contract.md、docs/README.md、docs/plugin-runtime-map.md（白名单内）
- scripts/test-temporal-refactor.mjs、.p1-baseline/verify-phase-map.mjs、docs/phase-map.md（生成；白名单内）
- tests/temporal/{10-repair-runner.test.mjs,11-repair-http.test.mjs}（新建；tests/temporal/ 允许）
- docs/temporal-refactor-progress.md、docs/temporal-refactor-progress.json（进度记录）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净，无用户未提交改动）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改；docs/README.md 属契约面白名单）
real data/ untouched: YES（全部测试走 NOVELSTUDIO_DATA_DIR 临时目录 / 隔离实例）
unrelated modules untouched: YES
```

### 未完成 / 未验证事项（按阶段归属，不计入 T4 完成）

- T5：上下文与工具查询的时态接线（AC-32/33/34）；T6：独立导航、章末状态面板与重建界面（AC-35/36/38）；T7/T8：存量迁移、开关回退与综合验收。
- 前端尚未接线（T6）：repair 运行目前通过 API 使用（11 已证 HTTP 生产链路）。
- `repair_run_apply` 重复 apply 直接返回同一回执（不再重复校验审批）——符合 AC-22 幂等语义，已记录。

### 已知限制 / 剩余问题

- `planRepair` 对「存在未确认新正文 / 无 valid 绑定」的章节返回 `startable:false`（先确认再重建）。
- 完整套件首跑曾出现 1 次 `06-http-save-entries` 偶发失败（42s）；单独复跑与套件复跑均 66/0 通过，未复现，记录为观察项（不改变通过结论，后续 T5–T8 回归继续观察）。
- 无阻塞。

## T5（DONE，2026-09-30）

### 实际修改文件（T5）

- 新建 `ai/story-state/temporal/context-provider.mjs`：统一时态游标与上下文提供者 —— `resolveContextCursor`（作品 / 世界线 / 提交 / 章序 / 章节 / 章前章后 / 视角 / POV 一次解析；解析失败 fail-closed 降级）、`filterRowsByCursor`、`characterOverlayOf` / `knownCharacterNamesOf` / `sceneCastOf` / `relationsForNames` / `plotlineStatesOf` / `foreshadowsOf`、`buildTemporalStoryStateLayer`、`filterRecallPayloadForCursor`（`future_chapter` / `unconfirmed_index` / `unattributed` 拦截并留审计）、`memoryLayerPolicyOf`、`temporalVersionOf`（单行聚合的廉价外部版本，进入上下文缓存外部版本串）。
- 修改 `ai/story-state/temporal/index.mjs`：`export * from './context-provider.mjs'`；`TEMPORAL_VERSION` → 1.1.0。
- 修改 `server.js`：`externalVersionOf` 追加时态版本（L463）；新增 `temporalContextParamsOf` / `isDefaultTemporalParams` / `temporalCacheSuffixOf` / `temporalToolCursorOf` / `temporalToolFilterMetaOf`（L471–527）；`buildNovelContext` 内解析统一 cursor（L2649）并逐层过滤 / 覆盖（章节检索、语义召回、事件、伏笔、角色状态与关系、剧情线、世界词条、知识披露、`story_state` 层改由 temporal provider 提供），响应新增 additive 字段 `temporal_context`（L3357）；`/api/novel/context`（L7205）与 `/api/ai_context`（L4983）缓存键追加时态后缀并透传 boundary / commit / worldline / perspective / pov；`GET /api/novel/events`（L7486）、`GET /api/novel/foreshadows`（L7533）、`POST /api/novel/consistency`（L7624）、`GET /api/search`（L4745）在显式给出 `chapter_id` 时按同一游标过滤并附 `temporal_filter`。
- 修改 `tests/temporal/http-harness.mjs`：`startIsolatedServer({ tag, env })` 支持隔离实例环境变量注入（测试 13 的 OV stub 地址）。
- 修改 `scripts/test-temporal-refactor.mjs`：登记 12 / 13 两个套件。
- 修改契约面（1.17.0）：`docs/host-contract.v1.json`（版本 + 端点参数面 + contract_history 第 18 条）、`docs/host-contract.md`（标题 / 版本 / 输入行 / 历史行）、`docs/README.md`、`docs/plugin-runtime-map.md`；`docs/phase-map.md` 重生成（`context-provider.mjs` 由 server.js import，归属 TT；`--write` 后复跑通过）。
- 修改 `docs/temporal-state-contract.md`（§6 补充：同一 cursor 覆盖全部装配路径与工具查询）。
- 新增测试：`tests/temporal/12-context-temporal.test.mjs`（62 断言）、`tests/temporal/13-context-cache.test.mjs`（17 断言）。
- 进度记录：`docs/temporal-refactor-progress.md` / `docs/temporal-refactor-progress.json`。

### 实际实现（能力）

- 同一 cursor、全部来源：装配第 N 章的章前 / 章后边界时，章节检索结果、语义召回命中、事件账本、伏笔、角色「当前值」、人物关系、剧情线、世界词条 / 设定词条、知识 / 披露、全书摘要（策略性排除）都用同一个 cursor 过滤或替换；未归属章节的行在启用作品上按 `unattributed` 拦下（未知 != 已知）。
- 角色状态不再读单一最新值：装配与工具查询的角色状态来自 `stateAt` 的时态覆盖（`characterOverlayOf`），历史查询显示当时状态（第 5 章「存活」不会因第 10 章「战死」而提前显示死亡）。
- 视角边界：`perspective=character` 时知识点按持有者过滤（只有该 POV 角色自己持有的知识可见）——`pov_character_id` 必填才生效，author 视角为默认且与旧行为同缓存。
- 未确认新稿保护：本章有保存后未确认的新正文（含 HEAD 因上游失效先停为 stale、但本章确有更新保存的情况）→ 游标 `pending_on_boundary=true`，本章的语义索引旧稿命中按 `unconfirmed_index` 拦下，不回灌旧稿。
- 未来状态隔离：`boundary=before` 时本章及之后的召回 / 事件 / 关系等一律不进装配（`future_chapter`）；章后边界只放行 ≤N 章。
- 缓存不串线：时态状态版本（提交 / 绑定 / 事件 / 修订 / 信任 / 依赖 / 开关）进入缓存外部版本串；进程外状态推进（不经过服务端 touchWork）也会让同一请求重新装配，不返回陈旧状态；不同章 / 不同边界 / 不同视角的缓存键相互隔离，默认参数下缓存键与 1.16.0 逐字节相同。
- 工具查询：events / foreshadows / consistency / search 在显式给出 `chapter_id`（或 consistency 的 chapter_id 入参）时按同一游标过滤，并附 `temporal_filter` 审计（含每桶 hidden 计数与 omitted 原因）；未给 chapter_id 时响应形状与旧版一致。
- 未启用作品零变化：所有接入点先查开关；未开启 `temporal_enabled` 的作品响应逐字节不变（对照断言在 12 / 13 内），缓存键不追加后缀。

### 生产调用链

- 装配：`GET /api/novel/context?work_id&chapter_id&mode&boundary&commit_id&worldline_id&perspective&pov_character_id` 或 `GET /api/ai_context?...`（同源同缓存）→ `buildNovelContext` → `resolveContextCursor`（真实存储：提交清单 / 绑定 / 事件 / 章序版本）→ 各层过滤 / 覆盖 → `temporal_context` 随响应返回（作者界面与测试共用同一装配结果）。
- 工具：`GET /api/novel/events?work_id&chapter_id`、`GET /api/novel/foreshadows?work_id&chapter_id`、`POST /api/novel/consistency {work_id, chapter_id, text}`、`GET /api/search?q=&work_id=&chapter_id=` → `temporalToolCursorOf` → 同一 provider 过滤。
- 缓存：`externalVersionOf(workId)`（server.js L450–467）→ `temporalVersionOf(workId)`（真实表聚合）→ 任一状态推进即失效上下文缓存。
- 模型侧：全部只读查询可用；写入仍走既有作者动作 / 审批边界，本阶段未新增任何模型侧写入口。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | 通过 12 / 未通过 0 个子套件（01:8 02:6 03:8 05:8 06:66 07:50 08:27 09:18 10:15 11:37 12:62 13:17） |
| `node tests/temporal/12-context-temporal.test.mjs` | 通过 62 / 失败 0（隔离实例 + 10 章作品逐章保存 / 更正；章前章后、视角、缓存、工具过滤、未启用对照、provider 纯函数直调） |
| `node tests/temporal/13-context-cache.test.mjs` | 通过 17 / 失败 0（隔离实例 + 本机 OV stub；进程外状态推进使缓存失效；本章未确认新稿的旧索引被拦） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | 通过 30 / 失败 0 / 跳过 0 |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0（零计费） |
| `node .p1-baseline/test-host-contract.mjs` | 通过 28 / 失败 0 / 跳过 0（契约 1.17.0） |
| `node .p1-baseline/test-approval-boundary.mjs` | 通过 50 / 未通过 0 |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | 通过（TT 57 文件；docs/phase-map.md 与阶段数据一致） |

### 验收覆盖（T5）

- AC-32：截止第 5 章的旧角色卡 / 全书记忆 / 召回含未来信息 → 全部上下文层（角色状态、关系、剧情线、事件、伏笔、知识、披露、世界词条、章节检索、语义召回）与后续工具查询（events / foreshadows / consistency / search）按同一游标过滤；未归属与未来来源分别拦为 `unattributed` / `future_chapter`（12 断言 + 13 D4）。
- AC-33：多世界线 / 不同 POV / 章前章后交替访问 → 缓存不串线、不串视角、不串时点（12 的缓存键断言 + 13 D1/D2：同请求同 context_id；换章 / 换边界 / 换视角不同；进程外推进后重新装配）。
- AC-34：外部索引尚未更新 → 过期来源被识别并过滤：本章未确认新稿的旧索引命中拦为 `unconfirmed_index`，不把旧稿回灌（13 D3）；章前边界下本章旧稿拦为 `future_chapter`（13 D4）。
- AC-37：未出场 / 未来才登记角色不泄露 → 时态覆盖只返回已登记状态；未登记不猜测（12 视角与边界断言；T1 历史查询继续覆盖）。

### SCOPE_BLOCKED（插件工具路径，未修改负清单文件）

```text
SCOPE_BLOCKED

目标文件：harness-plugins/novel-writing/novel-tools.mjs
为什么必须修改：该插件的 novel_events 工具请求 /api/novel/events 时只传 work_id/limit，chapter_id 仅用于本地过滤；
  novel_foreshadows 工具没有 chapter_id 参数。服务端时态过滤在「显式给出 chapter_id」时生效（这是为保持未给参数时
  响应形状不变而刻意设计的），因此这两个插件工具调用不会自动携带游标，拿不到服务端的时态过滤。
预计最小改动：novel_events 在 args.chapter_id 存在时把 chapter_id 放进查询串；novel_foreshadows 增加可选 chapter_id 参数并透传。
不修改会阻塞哪个 T 阶段：不阻塞 T5 主体（服务器装配、四个工具端点、缓存、契约均已按任务书完成并验证）；
  仅模型侧「插件自动携带章上下文」路径缺失。
不修改会阻塞哪个验收项：AC-32 的服务器侧结论成立（端点已过滤、测试覆盖）；插件层属额外加固项，当前记录为缺口而非既证事实。
当前可继续完成哪些任务：T6 前端导航 / 状态面板、T7 迁移与回退、T8 综合验收；后续修复需用户先解除 harness-plugins/** 负清单。
```

### Scope Audit

```text
Scope Audit

Files written this phase:
- ai/story-state/temporal/context-provider.mjs（temporal/ 为允许的新模块目录）
- ai/story-state/temporal/index.mjs（temporal/ 内）
- server.js（白名单内：上下文装配与 API）
- tests/temporal/{12-context-temporal.test.mjs,13-context-cache.test.mjs}（tests/temporal/ 允许新建）
- tests/temporal/http-harness.mjs（既有测试设施，tests/temporal/ 内）
- scripts/test-temporal-refactor.mjs（专用测试入口，允许新建清单内）
- docs/{host-contract.v1.json,host-contract.md,README.md,plugin-runtime-map.md}（白名单契约面）
- docs/{phase-map.md, temporal-state-contract.md, temporal-refactor-progress.md, temporal-refactor-progress.json}（白名单 / 进度记录）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净，无用户未提交改动；本轮所有改动均为本次任务产生）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改；docs/README.md 属契约面白名单）
real data/ untouched: YES（全部测试走 NOVELSTUDIO_DATA_DIR 临时目录 / 隔离实例 + 本机 stub）
unrelated modules untouched: YES
```

### 未完成 / 未验证事项（按阶段归属，不计入 T5 完成）

- T6：前端独立导航（五组）+ 章末状态面板 + 影响 / 重建界面（AC-35/36/38）——后端与 API 已就绪，前端尚未接线。
- T7：存量迁移 / 开关回退（AC-39–41/44 剩余部分）；T8：综合验收矩阵与性能基线。
- 插件工具路径的 SCOPE_BLOCKED（见上）。

### 已知限制 / 剩余问题

- `filterRowsByCursor` 对「归属不明」的行在启用作品上不放行（未知 != 已知）；这是刻意的 fail-closed 行为，旧账需经存量重建补归属后才能进入历史事实层。
- 语义召回的拦截依赖索引 URI 能解析出章节号（`/chapters/<id>.md`）；无法解析章节归属的命中在启用作品上同样不放行并记录 `unattributed`。
- 无阻塞。

## T6（DONE，2026-09-30）

### 实际修改文件（T6）

- `public/app.js`（白名单 #5）：① `AI_TABS` 从「一个创作上下文页」拆成七项同级独立导航（AI 设置 / 创作上下文 / 编辑规则 / 作者样文与文风 / 故事状态与披露 / 剧情分支沙盘 / 导入后重建），每页独立 load / render / 空态 / 错误态，旧键 `st` 保留为创作上下文兼容别名；② 正文编辑区外的章末状态面板（三档视图：本章出场 / 截至本章可见角色 / 全部故事状态；本章待确认提案一次确认；状态变化带原文证据与「定位」；`chapterPanelSeq` 请求序号防迟到响应；`full=1` 才拉完整状态）；③ 影响分析区（按后端报告分组：需要复核 / 阻塞 / 冲突 / 保留原文，每条可展开原因与证据）；④ 逐章重建区（签发一次性审批 `repair_run_start` → start → 3s 轮询真实进度 → ready_gate 通过后签发 `repair_run_apply` → apply；cancel / resume / revert / 候选预览 `revison` 只读 diff）；⑤ 事件委托分支（`panel-view` / `panel-jump` / `panel-confirm-proposals` / `impact-analyze` / `repair-*` / `board-tab`）。
- `public/styles.css`（白名单 #6）：面板 / 页面所需少量类（含 `.redline-scan` 提示样式）。
- `frontend-test.mjs`（白名单 #7）：新增 T6-1..T6-18 断言（真实点击 tab + 网络 mock；面板按章不泄漏未来状态、迟到响应拦截、提案一次确认 POST、影响只分析不改写、重建审批链、候选预览只读）。

### 实际实现（能力）

- 五组页面各自只加载自己的数据：切换到任一页不会连带读取其余四页（T6-3 用真实点击 + 请求清单断言）。
- 章末状态面板读取真实后端时态投影（`GET /novel/state/panel`），角色表里没有 `status` 字段也能按章显示；查看第 5 章显示第 5 章状态，不因第 10 章已死亡而显示死亡（T6-7 / T6-11 断言）。
- 提案确认是原子组（`POST /novel/state/proposal-groups/:id/apply`，无事件子集）；模型侧不能确认自己的抽取。
- 重建界面：运行中就绪与否由服务端 `ready_gate` 判定；就绪 ≠ 已应用；应用候选正文切换由服务端原子完成（T6-16/18）。

### 生产调用链

- 前端事件委托 → 真实 API：`GET /api/novel/state/panel|proposal-groups|impact|repair|revision`、`POST /api/novel/state/proposal-groups/:id/apply`、`POST /api/novel/state/impact`、`POST /api/novel/state/repair/{start,apply,cancel,resume,revert}`、`POST /api/novel/approvals`（op=`repair_run_start` / `repair_run_apply`）。后端实现与 HTTP 证据见 T1–T5 的 04 / 06 / 09 / 11 套件（本轮复跑全绿）。

### 执行命令与实际结果（本轮复核）

| 命令 | 结果 |
|---|---|
| `node frontend-test.mjs` | 通过 346 / 失败 0（含 T6-1..T6-18、T7-1..T7-11；T6 断言逐条 PASS） |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0（含「前端执行验证（vm + DOM 桩）」，零计费） |

### Scope Audit（T6）

```text
Scope Audit

Files written this phase:
- public/app.js（白名单 #5：独立导航 + 面板 + 影响/重建界面）
- public/styles.css（白名单 #6）
- frontend-test.mjs（白名单 #7）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净；T6 改动为本次任务产生）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改）
real data/ untouched: YES（前端测试为 vm + fetch mock，零真实库访问；另见文末「真实 data/ 事件」披露）
unrelated modules untouched: YES
```

### 已知限制 / 剩余问题（T6）

- 真实浏览器人工点击验证：SKIP（环境无浏览器；任务书允许保留 DOM stub 交互测试并如实报告）。交互路径由 `frontend-test.mjs` 的真实事件委托 + 网络 mock 覆盖。
- 章末面板的视觉密度依赖既有样式类；本轮未新增设计系统。

## T7（DONE，2026-09-30）

### 实际修改文件（T7）

- 新增 `ai/story-state/temporal/migration.mjs`（允许新增目录内）：schema 探测（11 表 + 12 索引）/ 迁移登记（`app_settings.temporal_migration`）/ 启用范围 `enableScope`（预算 + 待重建范围）/ 存量计划 `planBackfill`（逐章状态机：`missing_revision → pending_analysis → analysis_running → pending_confirm → valid`，另有 stale / needs_review / conflict / blocked）/ 单章 `backfillStep`（冻结修订不改正文 → 无 result 时返回抽取请求；有 result 时本地结构校验后登记候选）/ `confirmBackfillChapter`（按序确认，跳章拒绝；章边界快照 + 事后依赖 `unknown`）/ bootstrap 候选（`planBootstrapCandidates` 扫描旧字段最新值 → 待确认；`decideBootstrapCandidate` 开篇设定 / 转章提案 / 拒绝）。
- `ai/story-state/temporal/worldline-store.mjs`：提交清单支持 `initial_binding_id`（开篇设定）；`history.mjs`：归约时先应用初始绑定（`Story State @ Chapter 0`）。
- `ai/story-state/temporal/extraction.mjs`：`extractJsonBlock` 支持结构化对象直传（本地 fake / 测试路径不再要求先序列化成字符串）。
- `ai/story-state/temporal/index.mjs`：导出 migration 能力；`TEMPORAL_VERSION` 1.2.0。
- `server.js`（白名单 #2）：`GET / PUT /api/novel/state/temporal`（PUT 迁移门禁 503、三开关部分更新、响应含 `migration` + 首次启用 `enable_scope`；模型侧 403）；`GET /api/novel/state/backfill`；`POST .../backfill/{step,confirm,bootstrap/plan,bootstrap/decide}`（step 无 result = 只冻结 + 抽取请求；confirm / bootstrap 为作者动作，模型侧 403；章节归属校验 404）。**修正**：上一轮误挂到 `handleImportRebuildRoute` 的 backfill 路由已移入 `handleStoryStateRoute`（否则真实 URL 返回 404）。
- `public/app.js`（白名单 #5）：时态引擎开关卡（三开关分离、迁移缺表/索引禁用开启、启用范围与预算告知、`enable_scope` 展示、可信前缀 / 提交 / 章序）+ 存量重建卡（逐章状态机列表、下一章、冻结并生成抽取请求、复制抽取请求 / 记录本机结果（本机管线，与导入重建同一模式）、按序确认、bootstrap 候选三决定、失败如实报错）。
- `frontend-test.mjs`（白名单 #7）：T7-1..T7-11（含 T7-5 迁移门禁、T7-6b 零正文写入、T7-8b 跳章 409 如实报错、T7-10 接口失败不伪装）。
- 新增测试：`tests/temporal/14-backfill-migration.test.mjs`（8 断言）、`tests/temporal/15-backfill-http.test.mjs`（30 断言）；`scripts/test-temporal-refactor.mjs` 登记 14/15。
- 文档：`docs/temporal-state-contract.md`（版本 2；§7 迁移门禁 / 回退三义 / 备份与恢复；§8 存量迁移与 bootstrap）；`docs/host-contract.*`（1.18.0 → 1.19.0）；`.p1-baseline/verify-phase-map.mjs` + 生成的 `docs/phase-map.md`（TT 认领）。

### 实际实现（能力）

- 迁移：附加式（不改旧表）；缺表/缺索引时 `PUT temporal` 503 且不改配置；启用成功才登记版本；重复登记幂等（14 M1）。
- 存量重建：按真实叙事顺序逐章；冻结不可变修订不改写导入正文（15 H3c 逐字节对照）；无模型结果不生成假事件（15 H3d）；候选未确认前不进正式状态（15 H4b）；确认一章才推进可信前缀，跳章 409（15 H4/H5，14 M7）；重复确认幂等；失败可恢复（14 M8）。
- 旧字段迁移：最新值只是待确认候选（14 M4；15 H6）；开篇设定与「转某章提案」都必须作者显式决定；拒绝零写入。
- 开关分离：`temporal_enabled` / `auto_analysis_enabled` / `repair_enabled` 全部默认关（15 H1/H2c）；未启用作品 zero-touch（15 H1，T5 的 12/13 逐字节对照）。
- 回退三义与备份说明：契约文档 §7（停用开关 / 应用级回滚 / 数据库版本回退；不删除审计历史；不得只复制写入中的单文件）。

### 生产调用链

- UI → `PUT /api/novel/state/temporal` → `temporal/config.setTemporalConfig` + `migration.recordMigration` + `migration.enableScope`。
- UI → `POST /api/novel/state/backfill/step` → `migration.backfillStep` → `revision-store.recordContentSave`（冻结修订）→ `extraction.parseExtractionResponse` + `completeAnalysis`（候选，不写正式状态）。
- UI → `POST .../confirm` → `migration.confirmBackfillChapter` → `confirmBinding`（章边界快照 + 提交清单）→ 事后依赖 `unknown`。
- UI → `POST .../bootstrap/*` → `migration.planBootstrapCandidates` / `decideBootstrapCandidate` → `createEvents` / `createBinding` / `commitManifest(initialBindingId)`。
- 前端真实生产函数：`loadTemporalEngine` / `renderTemporalEngineCard` / `temporalToggle` / `loadBackfill` / `renderBackfillCard` / `backfillStepRun`（`record:true` 走 `runPipelineStage`，与导入重建同路径）/ `backfillConfirmRun` / `backfillBootstrapPlan` / `backfillBootstrapDecide`；测试仅注入 `state.backfillRunner` 桩，生产未设置该字段。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | 通过 14 / 未通过 0 个子套件（01:8 02:6 03:8 05:8 06:66 07:50 08:27 09:18 10:15 11:41 12:62 13:17 14:8 15:30）。注：首跑 06 因瞬时端口占用失败一次，单独复跑与整套复跑均 66/0 全绿（非代码失败，已记录） |
| `node tests/temporal/14-backfill-migration.test.mjs` | 通过 8 / 失败 0（迁移门禁 / 逐章按序 / bootstrap / 未启用零写入 / 恢复） |
| `node tests/temporal/15-backfill-http.test.mjs` | 通过 30 / 失败 0（H1–H6，自托管隔离实例，零计费） |
| `node frontend-test.mjs` | 通过 346 / 失败 0（T7-1..T7-11 全绿） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | 通过 30 / 失败 0 / 跳过 0 |
| `node scripts/ci-offline-checks.mjs` | 通过 50 / 未通过 0 |
| `node .p1-baseline/test-approval-boundary.mjs` | 通过 50 / 未通过 0 |
| `node .p1-baseline/verify-phase-map.mjs` | 通过（TT 认领；docs/phase-map.md 与阶段数据一致） |

### 验收覆盖（T7）

- AC-28（旧字段写入统一命令）：06 G9（启用作品直接改角色 status 无 chapter_id → 409；带 chapter_id → author_correction 统一生效）。
- AC-39（存量缺生成上下文）：14 M2/M3 + 15 H3（`generation_context=unknown` / `support=reconstructed`；事后依赖如实记录；不改写导入正文）。
- AC-40（旧字段最新状态迁移）：14 M4 + 15 H6（最新值 → 待确认候选；确认/拒绝都显式；不把「第 10 章死亡」回填为开篇死亡）。
- AC-41（迁移重复运行 / 故障 / 未启用作品）：14 M1/M8 + 15 H1/H2（重复登记幂等；缺表/索引 503 且不改配置；未启用作品 backfill 409 / 历史查询 enabled:false / 端点契约不变）。
- AC-42（模型未配置/关闭）：15 全程零模型（未注册任何模型配置，语义结果 not_run）；14 M6。
- T7 §11.2「新增功能关闭时原测试无新增失败」：`ci-offline-checks` 50/0、`approval-boundary` 50/0、`frontend-test` 346/0 全绿。

### Scope Audit（T7）

```text
Scope Audit

Files written this phase:
- ai/story-state/temporal/{migration.mjs,extraction.mjs,worldline-store.mjs,history.mjs,index.mjs}（允许新增目录 temporal/ 内）
- server.js（白名单 #2：temporal 路由 / backfill 路由 / 迁移门禁 / 章节归属校验）
- public/app.js（白名单 #5：T7 开关卡 + 存量重建卡 + 动作接线）
- frontend-test.mjs（白名单 #7：T7-1..T7-11）
- tests/temporal/{14-backfill-migration.test.mjs,15-backfill-http.test.mjs}（允许新增）
- scripts/test-temporal-refactor.mjs（专用测试入口，允许新增清单内）
- docs/{temporal-state-contract.md,host-contract.v1.json,host-contract.md,README.md,plugin-runtime-map.md}（白名单文档面）
- docs/{phase-map.md,temporal-refactor-progress.md,temporal-refactor-progress.json}（白名单 / 进度记录）
- .p1-baseline/verify-phase-map.mjs（白名单 #8）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净；无用户既有 diff 需保留）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改）
real data/ untouched: YES（本轮全部测试走 NOVELSTUDIO_DATA_DIR 临时目录 / 自托管隔离实例；另见下方披露）
unrelated modules untouched: YES
```

### 已知限制 / 剩余问题（T7）

- 「把新表删掉」不被视为回退：数据库版本回退按阶段撤回模块（phase-map TT），表数据保留；应用级回滚用 T4 revert（恢复提交）。见契约 §7。
- 抽取请求的「记录本机结果」会调用当前模型配置（可能产生费用）；零计费路径 = 复制给 dsh 会话或测试注入 runner。这与导入重建的既有语义一致。
- 真实浏览器人工点击验证：SKIP（无浏览器环境；DOM stub 交互测试 + 后端 HTTP 套件共同覆盖）。

## T8（DONE，2026-09-30）

### 实际修改文件（T8）

- `scripts/perf-temporal-baseline.mjs`（允许新增：合成大作品性能基线；零计费、`mkdtemp`、调用生产同一后端函数）
- `tests/temporal/16-log-hygiene.test.mjs`（允许新增：日志/追踪卫生；33 断言；哨兵 + 正控）
- `scripts/test-temporal-refactor.mjs`（白名单：登记 16 号子套件，空清单非零退出不变）
- `.p1-baseline/verify-phase-map.mjs`（白名单 #8：TT 证据文件清单登记 `scripts/perf-temporal-baseline.mjs` 与 `docs/temporal-refactor-acceptance.md`）
- `docs/phase-map.md`（`--write` 重生成：354 个改动全部有归属，含本验收文档）
- `docs/temporal-refactor-acceptance.md`（允许新增：AC-01–48 映射 + 性能表 + SKIP/NOT VERIFIED 披露）
- `docs/temporal-refactor-audit.md`（T8 补记：新增文件实况与 T0 预估清单的对照说明）
- `docs/temporal-refactor-progress.md` / `docs/temporal-refactor-progress.json`（进度记录）

### 实际实现（能力）

- AC-48 性能基线：100/500/1000 章合成作品的保存 → 确认 → 末章查询 → 面板查询时延、SQL 次数、库体积、RSS、墙钟（退出码 0；零模型调用）。
- AC-46 日志与追踪卫生：正文甲/乙/丙 + 样文 + API key 五个唯一哨兵，先用正控证明**确实进过真实链路**（分析请求携带正文 / 样文进上下文装配 / key 为真实配置值），再扫描 `app_logs`、`data/logs/app-*.log` 与 `debug-trace` JSONL 本体；模型 500 失败路径同样核查（诊断可见、无泄漏）。
- 验收审计文档：AC-01–48 逐项映射到测试文件与代表用例；失败路径诊断出口表；SKIP / NOT VERIFIED / SCOPE_BLOCKED 逐条披露；已知限制（确认路径超线性等）。
- 阶段映射证据同步：`docs/phase-map.md` 重生成后 `verify-phase-map` 复跑通过；全量回归按最终口径记录（见下）。

### 生产调用链

- perf 基线直接调用生产同一后端函数（保存路径 → `afterTemporalContentSave` 后处理 → 时态查询 / 章节状态面板查询），写入临时目录库；不是 mock 存储。
- 16 号测试经自托管隔离实例走真实 HTTP 保存/分析链路（保存 → 提取 → 提案/确认 → 投影），模型为本机脚本化 stub；被扫描的日志/追踪与测试同一临时目录，真实写出后再断言。
- AC-46/48 同时满足「底层实现 + 真实入口 + 实际执行」；与 §3 全量 HTTP 套件（04 号 30 例、06 号 66 例等）互补，不以 mock 代替接线。

### 执行命令与实际结果

| 命令 | 结果 |
|---|---|
| `node scripts/test-temporal-refactor.mjs` | EXIT=0；15 个子套件全绿（01:8 02:6 03:8 05:8 06:66 07:50 08:27 09:18 10:15 11:41 12:62 13:17 14:8 15:30 16:33） |
| `node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3757` | EXIT=0；30 通过 / 0 失败 |
| `node frontend-test.mjs` | EXIT=0；346 通过 / 0 失败 |
| `node scripts/ci-offline-checks.mjs` | EXIT=0；50 通过 / 0 失败 |
| `node .p1-baseline/test-approval-boundary.mjs` | EXIT=0；50 通过 / 0 失败 |
| `node .p1-baseline/test-host-contract.mjs` | EXIT=0；28 通过（契约 1.19.0） |
| `node .p1-baseline/check-utf8.mjs` | EXIT=0 |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后复跑） | EXIT=0；354 个改动全部有归属（含本验收文档） |
| `node scripts/ci-isolated-run.mjs --port 3739 -- node .p1-baseline/verify-all.mjs --live-db <真实库只读副本>` | EXIT=1；通过 49 / 未通过 1 / 跳过 6。唯一未通过＝「连续性预检在真实作品上成立」（环境前置不满足，见下）；不伪装通过 |
| `node tests/temporal/16-log-hygiene.test.mjs`（单跑） | EXIT=0；33 断言通过 / 0 失败 |
| `node scripts/perf-temporal-baseline.mjs --size 100` | EXIT=0；保存 3.26ms/章，确认 16.75ms/章，末章查询 26.34ms（709 SQL），面板 32.21ms，库 2.86MiB，RSS 77.2MB，墙钟 2.3s |
| `node scripts/perf-temporal-baseline.mjs --size 500` | EXIT=0；保存 6.25ms/章，确认 174.9ms/章，末章查询 271.2ms（3509 SQL），库 27.64MiB，RSS 255.7MB，墙钟 92.3s |
| `node scripts/perf-temporal-baseline.mjs --size 1000` | EXIT=0；保存 9.11ms/章，确认 1042.2ms/章（超线性，占墙钟 98.8%），末章查询 793ms（7009 SQL），库 93.82MiB，RSS 285.1MB，墙钟 1055.3s（T8 当时读数；后续优化见文末「后续优化记录」） |

### 验收覆盖（T8）

- AC-46（日志/API 错误/追踪无泄漏）：16 号 33 断言（哨兵 + 正控 + 失败路径）。
- AC-48（合成大作品与真值查询）：perf 基线 EXIT=0；`package.json` / lockfile `git diff` 为空；真实 `data/` 未触碰。
- AC-01–AC-48 全量映射与 SKIP / NOT VERIFIED 披露：`docs/temporal-refactor-acceptance.md`（§3 映射、§4 性能、§7 披露）。

### Scope Audit（T8）

```text
Scope Audit

Files written this phase:
- scripts/perf-temporal-baseline.mjs（允许新增）
- tests/temporal/16-log-hygiene.test.mjs（允许新增）
- scripts/test-temporal-refactor.mjs（白名单）
- .p1-baseline/verify-phase-map.mjs（白名单 #8）
- docs/phase-map.md（白名单 / 重生成）
- docs/temporal-refactor-acceptance.md（允许新增）
- docs/temporal-refactor-progress.md / .json（进度记录）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净；无用户既有 diff）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改）
real data/ untouched: YES（T8 全部命令走临时目录 / 自托管隔离实例；verify-all 的 --live-db 指向真实库的只读临时副本；另见下方披露）
unrelated modules untouched: YES
```

### 未完成 / 未验证事项（按阶段归属，不计入 T8 完成）

- `verify-all` 的「连续性预检在真实作品上成立」：NOT VERIFIED（环境前置不满足）。真实库 work#18 第 1–6 章正文为 11 字符空占位 `<p><br></p>`（`updated_at=2026-09-25`，早于本任务基线、也早于 09-30 18:11 事件）→ 判据要求的 `system_frequency` 命中必然无法出现。只读副本复跑：命中 4 / 漏报 1 / 误报 0；`ai/continuity-guard*.mjs` 与验证脚本自基线零 diff。不改真实库凑通过；不影响 AC-01–48。
- 真实浏览器人工点击：SKIP（环境无浏览器；DOM stub 交互测试 + HTTP 套件覆盖，见验收文档 §7）。
- `harness-plugins/**`（插件工具路径携带时态游标）：SCOPE_BLOCKED（负清单；记录见 T5）。
- temporal 专项真实模型语义评测：NOT VERIFIED（零计费纪律，不调用真实付费模型）。
- 1000 章 HTTP / 前端端到端负载：NOT VERIFIED（perf 走进程内生产函数；未在 1000 章规模跑完整 HTTP/前端链路）。

### 已知限制 / 剩余问题（T8）

- 确认路径超线性：500→1000 章时确认单章耗时约 175ms→1042ms（T8 当时读数）；**已于 2026-09-30 后续优化修复**（1000 章降至 32.75ms/章），见文末「后续优化记录」。
- 其余限制见 `docs/temporal-refactor-acceptance.md` §4/§8 与 `docs/temporal-state-contract.md`（迁移门禁、回退三义）。

## 真实 data/ 事件（如实披露，2026-09-30）

只读拷贝审计 `data/novel.db`（拷贝到 `%TEMP%` 用 `readOnly` 打开，未动原库）发现：文件 mtime 2026-09-30 18:11–18:13 期间有前序会话的测试运行打到了真实库：

- `works` 新增 47「smoke」、48「dbg2」两个测试作品；
- work 9「雾都缝匠」被追加 chapters 199 / 200，且 `story_state_config.temporal_enabled=1`；
- `story_commits` / `story_chapter_revisions` 等表出现该时段的测试行。

已确认：work 9 的既有章节正文未变化（正文内容逐行对照一致）。处理决定：**不擅自删除或修复**真实库数据；本会话（T6/T7）全部测试均通过 `NOVELSTUDIO_DATA_DIR` 临时目录与自托管隔离实例运行，未再触碰真实库。此前置事件不计入 T6/T7 的 Scope Audit 通过条件（它发生在任务可归属范围之外），在此单独记录以免误导。

### 清理记录（2026-09-30，用户明确授权后执行）

- 备份：`data/backup-pre-temporal-cleanup-20260930215404.db`（清理前完整副本，可回滚）。
- 删除：works 47「smoke」（空壳作品行）、48「dbg2」（作品行 + chapters 201–210 + 其全部时态测试行）；work 9 的 chapters 199/200（`ch1`/`ch2` 测试占位 + 其绑定/快照/修订/事件行）。
- 复位：work 9 的 `story_state_config.temporal_enabled` 置回 0（`auto_analysis_enabled` / `repair_enabled` 本就为 0）。
- 验证：清理前后对 works 9/18 的 chapters / works / characters / character_relations / plotlines / terms / world_entries / story_events / story_memories / memory_versions / volumes / categories / plotline_characters 全量逐行对照（除 199/200 测试行外）**IDENTICAL**；新时态表残留 0 行；`PRAGMA integrity_check=ok`。
- 未触碰：work 18 的 `story_state_config.enabled=1`（既有旧状态机制开关）、work 9/18 的全部正文与旧表数据。

## 后续优化记录（2026-09-30，用户授权）：确认路径超线性消除

**目标**：消除「作者确认」路径随章数加速膨胀的超线性（T8 基线：1000 章 1042.2ms/章，占 1000 章总墙钟 98.8%）。

**根因（已修复）**：确认/查询路径对每章重复「逐绑定/逐事件裸 `prepare`（每次调用重编译 SQL）+ 全前缀归约 + 全量 pending JOIN + 逐行 overlay upsert + 全量章序哈希」——单章成本随章数加速膨胀。

**修改文件（仅性能等价改写，未改语义、未改内容寻址 ID；全部在冻结白名单 / 允许新增范围内）**：

- `ai/story-state/temporal/stmt.mjs`（新增：按 SQL 文本的预处理语句缓存，有界）
- `ai/story-state/temporal/reducer.mjs`（`reduceBatchInPlace` 批量归约）
- `ai/story-state/temporal/event-store.mjs`（批量 lite 读、`pendingSaveIndex`、批量插入 + 批内去重、断言/信任缓存、批量信任覆盖写）
- `ai/story-state/temporal/worldline-store.mjs`（提交读写改用缓存化 `prep`）
- `ai/story-state/temporal/revision-store.mjs`（`revisionsByIds` lite 批量读）
- `ai/story-state/temporal/history.mjs`（前缀批量预取 + 内存归约）
- `ai/story-state/temporal/impact.mjs`（下游批量预取 + 批量覆盖写）
- `ai/story-state/temporal/dependencies.mjs`（批量落库 + IN 分块）
- `ai/story-state/temporal/order.mjs`（`cursorOfChapter` orderOverride、`sameOrder` 逐项比较、`orderHash` 懒算）
- `ai/story-state/temporal/snapshot.mjs`（`stateHash` 复用）
- `ai/story-state/temporal/service.mjs`（向查询传 `stateHash`/`order`）
- `scripts/perf-temporal-baseline.mjs`（SQL 计数口径拆分：执行次数 vs 编译次数）
- `docs/phase-map.md`（`verify-phase-map --write` 重生成，58→59 文件行）

**执行命令与结果（2026-09-30 22:25–22:30 复跑，零计费）**：

| 命令 | 结果 |
|---|---|
| `node scripts/perf-temporal-baseline.mjs --size 100/500/1000` | EXIT=0；确认 3.62 / 17.91 / 32.75ms/章（优化前 16.75 / 174.9 / 1042.2）；末章查询 2.52 / 12.56 / 23.37ms（SQL 13 / 17 / 21；优化前 709 / 3509 / 7009）；墙钟 0.76 / 14.66 / 54.02s（优化前 2.30 / 92.33 / 1055.31s）；500 章复跑 18.30ms/章（±2%） |
| 黄金等价对照（`golden.mjs --size 120` 导出 ↔ `golden-before.json`，内容寻址 ID/哈希逐字节） | 连续 6 次（check1–check6）`identical: true` |
| `node scripts/test-temporal-refactor.mjs`（复跑） | EXIT=0；15/15 子套件（01:8 02:6 03:8 05:8 06:66 07:50 08:27 09:18 10:15（4+11 两组） 11:41 12:62 13:17 14:8 15:30 16:33） |
| `node frontend-test.mjs`（复跑） | EXIT=0；PASS 346 / FAIL 0 |
| `node scripts/ci-offline-checks.mjs`（复跑） | EXIT=0；通过 50 / 未通过 0 |
| `node .p1-baseline/test-approval-boundary.mjs`（复跑） | EXIT=0；通过 50 / 未通过 0 |
| `node .p1-baseline/test-host-contract.mjs`（复跑） | EXIT=0；通过 28 / 失败 0（契约 1.19.0） |
| `node .p1-baseline/check-utf8.mjs`（复跑） | EXIT=0 |
| `node .p1-baseline/verify-phase-map.mjs`（复跑） | EXIT=0；阶段映射一致 |

**残余（如实记录，未做增量状态缓存/惰性预取，超出本次范围）**：

- 确认与查询仍按前缀规模读取（总量仍为 O(N²)·小常数；每前缀章约 0.03ms 量级）。
- 每章约 1.5–2ms 固定事务落盘（WAL `synchronous=FULL`，实测 300 事务 600ms vs `OFF` 6ms）。
- 保存后处理在 500/1000 章的平均每章耗时高于优化前（6.25→9.30ms、9.11→18.59ms；100 章 3.26→1.99ms 反而更快）：保存路径 `pendingSaveIndex` 按前缀规模扫描 pending 行；1000 章单次保存仍约 19ms（交互不可感知）。
- 1000 章 HTTP 端到端仍未跑（NOT VERIFIED，见验收文档 §7）。

**Scope Audit（本优化段）**：

```text
Scope Audit

Files written this phase:
- ai/story-state/temporal/stmt.mjs（新增，本任务专用源码）
- ai/story-state/temporal/{reducer,event-store,worldline-store,revision-store,history,impact,dependencies,order,snapshot,service}.mjs（本任务专用源码）
- scripts/perf-temporal-baseline.mjs（本任务专用脚本）
- docs/phase-map.md（重生成）
- docs/temporal-refactor-acceptance.md / docs/temporal-refactor-progress.md / docs/temporal-refactor-progress.json（进度记录）

All files in Frozen Write Allowlist or explicitly allowed new files: YES
Pre-existing user changes preserved: YES（任务开始时工作区干净；无用户既有 diff）
package.json untouched: YES
lockfile untouched: YES
AGENTS.md untouched: YES
README untouched: YES（根 README 未改）
real data/ untouched: YES（仅 mkdtemp 临时库；未写真实库）
unrelated modules untouched: YES
```
