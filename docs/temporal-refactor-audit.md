# 时态故事状态重构 · T0 审计与冻结写入白名单

- 日期：2026-09-30
- 分支：`refactor/p0-p6`
- 基线 HEAD：`7d61390ccf0c52048c1a2df92c23701a684656a9`
- 工作区：`git status --porcelain=v1` 为空（任务开始前**没有**用户未提交改动）
- Node：v24.19.0
- 数据隔离：所有测试与迁移试验使用 `NOVELSTUDIO_DATA_DIR` 临时目录 / 隔离实例；真实 `data/` 未读取、未写入

## 0. 基线证据（T0 实跑）

| 命令 | 结果 |
|---|---|
| `node scripts/ci-offline-checks.mjs` | 通过 49 / 未通过 0（共 49 条，零计费） |
| `node scripts/ci-isolated-run.mjs --port 3756 -- node .p1-baseline/test-story-state-api.mjs --base http://127.0.0.1:3756` | 通过 75 / 失败 0 / 跳过 0 |

两条基线均全绿，历史遗留失败：无。

## 1. 任务书 / 方案 与本地实际的差异记录

| 文档表述 | 本地事实 | 处理 |
|---|---|---|
| 示例函数名 `saveChapter()` | 真实前端是 `public/app.js` 的 `saveChapterSnapshot()`（自动保存）与 `manualSaveChapter()`（手动保存），走 `PUT /api/chapters/:id` 通用 CRUD | 实现路径以本地为准；覆盖全部真实入口 |
| 「现有内核已有章序计算」 | 真实 `store.mjs` 的 `chapterIndexOf` 按 `(position,id)` 全局下标排序，**不区分卷与父子场景**，与前端「卷→章→场景」展示次序不一致 | T1 新建唯一章序服务 `temporal/order.mjs`（按卷分组 + 根章节 + 场景），旧函数保留兼容 |
| 方案 §14 建议路径 `ai/story-state/temporal/*`、`ai/repair/*` | 均不存在 | 按方案建议新建设计文件（属"拟新增"，非既有实现） |
| 方案 §16.4 建议 DDL | 目标表全部不存在；现有 `story_snapshots` 是**操作回滚快照**，任务书明确禁止改作章节历史 | 新建 `chapter_state_snapshots` 等表；`story_snapshots` 语义不动 |
| 「复用现有 story_state_proposals / author_approvals / story_validations / chapter_contracts / chapter_save_versions / projection_outbox」 | 全部真实存在（Host Contract 1.12.0，60 张表） | 复用；审批扩 op，不另造审批总线 |
| 五组功能「原本混入创作上下文」 | 真实：`renderST()`（app.js:4483）在进入页面时统一 `loadEditRules / loadAuthorStyle / loadStoryState / loadBranch / loadRebuild` 并渲染五张卡 | T6 拆为五个独立 view + 独立 load；`renderST` 保留兼容入口但不再自动加载五组 |
| Host Contract 互锁 | `db.tables` / 工具面 / 端点面由 `test-host-contract.mjs` 与代码逐字比对 | 新增表后同步契约 1.13.0（`docs/host-contract.v1.json` + `docs/host-contract.md`），不改插件工具/端点面 |
| 新文件必须登记阶段映射 | `.p1-baseline/verify-phase-map.mjs` 的 `PHASES` 为唯一来源，`docs/phase-map.md` 由 `--write` 生成 | 新增阶段 `TT` 并登记全部新文件；生成文档 |

无「无法同时满足」的真实冲突；本任务不改变已确认产品需求。

## 2. 已有能力盘点（可复用，不得另起平台）

- **状态内核**：`ai/story-state/` 18 个模块 + 门面 `index.mjs`（`compositionOf` / `storyStateLayerOf` / `preflightOf` / `validateOf` / `STORY_STATE_VERSION`）。作品级门控 `story_state_config.enabled` 默认 0。
- **既有表**：`story_facts` / `story_timeline_entries` / `character_knowledge` / `story_entities` / `story_entity_aliases` / `chapter_contracts` / `story_state_proposals` / `story_snapshots` / `story_validations` 等（v1.1.0 批次）。
- **作者审批**：`author_approvals`（服务端基线校验 / 单次消费 / 有效期 / 结构化绑定；`APPROVAL_OPS` 现有 4 种）。模型侧创建一律 403。
- **原子采纳**：`POST /api/novel/adopt` + `adoption_operations` 幂等键 + `projection_outbox`（同事务入队）。
- **导入后重建**：`ai/import/rebuild.mjs` + `rebuild-store.mjs`（分批规划 / 批次基线 / 候选 / 作者确认）。
- **上下文**：`ai/context/{layers,assembler,cache,integrity,contributions,tokens}.mjs`；`story_state` 层（`gated:true`，cap 2400，位于 `redlines` 之前）；装配唯一入口 `ai/context/assembler.mjs`；缓存 `createContextCache` + `touchWork()` 全量失效。
- **前端**：`AI_TABS = [['ai','⚙️ AI 设置'],['st','🧩 创作上下文']]`；编辑器正文区在 `renderWriting`（`#editor-content` / `#editor-status`，`.panel-editor`）。
- **测试设施**：`scripts/ci-offline-checks.mjs`（49 条离线、零计费）、`scripts/ci-isolated-run.mjs`（隔离实例）、`frontend-test.mjs`（vm + DOM 桩，真实点击与网络 mock）、`.p1-baseline/verify-all.mjs`（活实例一键验收）、`.p1-baseline/verify-phase-map.mjs`（阶段→改动面→回滚映射）。

## 3. 全部正文写入入口审计（AC-28 的依据）

「正文真的变化」的判据是 `chapters.content`（存库原文）发生有效变化；以下为经代码定位的全部入口：

| # | 入口 | 位置 | 事务 | 现状后处理 | 本次接入 |
|---|---|---|---|---|---|
| W1 | 编辑器自动保存（800ms 防抖） | `app.js:3069 saveChapterSnapshot` → `PUT /api/chapters/:id`（`server.js` 通用 CRUD → `updateRow('chapters')`） | 无显式事务（单语句） | `maybeAutoCompressMemory`、`touchWork`、`notifyChange` | 记录 revision + pending binding + 下游失效 |
| W2 | 编辑器手动保存 | `app.js:3103 manualSaveChapter` → W1 + `POST /api/chapter_versions` | 无 | 同上 | 同 W1（去重：内容未变不重复建 revision） |
| W3 | AI 写回 / 审稿合并 / 草稿取回 / 批量生成写回 | `POST /api/novel/chapter_save`（`server.js:6948`，`withTx`） | 有 | 版本入历史、红线扫描、`touchWork` | 事务内记录 revision；消费审批边界保留 |
| W4 | 整次原子采纳（正文 + 提案） | `POST /api/novel/adopt`（`server.js:5427`，`withTx`） | 有 | 幂等键、outbox、`touchWork` | 事务内记录 revision + binding |
| W5 | 历史版本恢复 | `POST /api/chapter_versions/:id/restore`（`server.js:7260`，BEGIN/COMMIT） | 有 | `touchWork`、`notifyChange` | 记录 revision（origin=restore） |
| W6 | 导入作品（TXT/EPUB） | `POST /api/novel/import` → `importWorkFromChapters`（`server.js:3417`，BEGIN/COMMIT） | 有 | `syncWorkFull` | 导入后按序建档 revision（origin=import） |
| W7 | 示例作品安装 | `POST /api/demo/install` → `installDemo`（`server.js:3511`） | 有 | 同步 | 同 W6（origin=demo） |
| W8 | AI 生成整本 | `POST /api/ai/generate_novel` → `generateNovelFromPrompt`（章节落库 `server.js:3795`） | 有 | 同步 | 同 W6（origin=ai_generate） |
| W9 | 通用 CRUD 新建章节 | `POST /api/chapters`（`insertRow('chapters')`） | 无 | `notifyChange` | **T2 已接入**（origin=`chapter_create`）：内容非空才建 revision + pending 提案。T0 曾记为「不产生正文（可空）」——T2 复核发现前端「创作工作台成果」流程（`app.js:6372`）就是**带正文**新建章节，属真实生产入口，因此必须接线 |
| N1 | `POST /api/novel/finalize`（kind=成文/审稿） | `server.js:6882` | 有 | 只写 `chapter_save_versions(kind='draft')` | **不接入**：不写 `chapters.content`；T2 阴性证明见 `tests/temporal/06-http-save-entries.test.mjs`（G8） |
| N2 | `POST /api/novel/draft` | `server.js:6913` | 无 | 只写 draft 版本 | **不接入**：同上；T2 阴性证明见 `tests/temporal/06-http-save-entries.test.mjs`（G8） |
| N3 | `POST /api/harness/mark_applied` | `server.js:7129` | 无 | 只标记任务 | **不接入**：不写正文；T2 阴性证明见 `tests/temporal/06-http-save-entries.test.mjs`（G8） |
| N4 | 沙盘候选采纳 | `server.js:6297` | 有 | 只写 `chapters.blueprint_json` | **不接入**：非正文；T2 阴性证明见 `tests/temporal/06-http-save-entries.test.mjs`（G8） |

每个接入入口统一调用 `ai/story-state/temporal/service.mjs` 的单一保存服务（唯一后处理点）；不接入的入口必须有「不产生章节状态陈旧」的证明与测试。

> T2 接线状态（2026-09-30）：W1–W9 全部接入 `recordContentSave`（保存请求内同步落不可变修订 + pending 提案，分析走后台防抖队列）；HTTP 级证据 = `tests/temporal/06-http-save-entries.test.mjs`（G1/G4/G5/G6 覆盖 W1/W3/W5/W9 + 重复保存/格式变化去重；W4/W6/W7/W8 的模块级证据见 T1/T2 测试与导入/示例/生成路径回归）。N1–N4 阴性对照见同文件 G8（零修订 / 零提案 / HEAD 不动 / 零模型调用）。 提案输入绑定（输入快照/HEAD/章序/契约/payload hash）、确认时逐项服务端复核、一次性审批（`temporal_apply`/`temporal_correction`）与兼容投影（`characters.status`/`character_relations` 单向刷新）的 HTTP 级证据 = `tests/temporal/07-proposal-binding.test.mjs`（B1–B6）。`tests/temporal/05-save-pipeline.test.mjs` 的 AC-44 期望随「保存时落输入快照」调整为「失败确认不得新增快照」。

## 4. 正文生成真实调用链（现状）

```text
server.js buildNovelContext(workId, chapterId, ...)
  → StoryState.compositionOf(workId, chapterId)     [仅 story_state_config.enabled=1]
  → StoryState.storyStateLayerOf(comp)              [cap 2400，visibleOnly 过滤未来]
  → L('story_state', ...) 进入层列表
  → ai/context/assembler.mjs assemble(...)          [唯一装配器：预算/manifest/完整性]
  → 缓存 createContextCache（TTL + externalVersion；touchWork 全量失效）
  → /api/novel/context · /api/ai/write_stream · 插件工具
```

T5 接线点：作品开启时态引擎后，`story_state` 层的数据源切换到 temporal provider（同一 cursor 下的章前状态），并覆盖其余旧来源（角色卡当前值、关系、剧情线、记忆、召回）的未来泄漏面。

## 5. 前端结构（T6 接线点）

- `AI_TABS`（app.js:2367）→ `renderAIBoard` → `renderAI` / `renderST`。
- `renderST`（app.js:4483）：`loadEditRules / loadAuthorStyle / loadStoryState / loadBranch / loadRebuild` + 五张卡（`renderEditRulesCard / renderAuthorStyleCard / renderStoryStateCard / renderBranchCard / renderRebuildCard`）+ 作者注 + 角色卡 + 世界观词条。
- 正文编辑区：`renderWriting`（app.js:2690 起）；状态面板插入点 = `.panel-editor` 之后（正文编辑区域之外）。
- 事件委托：`data-action` 大 switch（app.js:11530 起）。
- `frontend-test.mjs` 对五组卡片有真实 DOM 断言（58h/R09/R10/R11/R12）；拆分后必须改为「独立页面 + 真实点击 + 网络 mock」断言，并保持旧 `st` 入口兼容。

## 6. 测试设施与新入口登记

- 新增总入口 `scripts/test-temporal-refactor.mjs`（显式发现并执行本项目新增测试；清单为空或子测试失败时非零退出）。
- 必须登记进：`scripts/ci-offline-checks.mjs`（CI 离线清单）、`.p1-baseline/verify-all.mjs`（一键验收）、`.p1-baseline/verify-phase-map.mjs`（阶段映射，`--write` 生成 `docs/phase-map.md`）。
## 7. Frozen Write Allowlist（既有文件，冻结）

> 规则：T1–T8 不得自行增加白名单；白名单外的既有文件确需修改时，只在 `docs/temporal-refactor-progress.md` 记录 `SCOPE_BLOCKED`，不修改该文件。

| # | 文件 | 为什么必须修改 | 最小改动 |
|---|---|---|---|
| 1 | `db.js` | 时态引擎的持久化底座 | 追加 11 张新表 + 索引 + `story_state_config` 三个开关列（ALTER 迁移）+ 迁移登记 |
| 2 | `server.js` | 生产接线（HTTP / 保存入口 / 上下文 / 审批透出） | 新增 temporal 路由组；8 个正文写入口接入统一保存服务；`buildNovelContext` 的 story_state 层切换 temporal provider；通用 CRUD 动态字段命令化 |
| 3 | `ai/story-state/index.mjs` | 现有唯一门面（组合入口在此） | 追加 `export * as Temporal from './temporal/index.mjs'` |
| 4 | `ai/story-state/approval.mjs` | 复用现有审批的 op 词表 | `APPROVAL_OPS` 追加 `temporal_apply` / `repair_run_start` / `repair_run_apply` / `temporal_correction`；`checkBinding` 补分支 |
| 5 | `public/app.js` | 五组独立导航 + 正文下方状态面板 + 影响/重建界面 | AI_TABS 扩展为独立 view；`renderST` 只留本页内容；新增 `renderChapterStatePanel` / 影响面板 / 修复面板与事件委托分支 |
| 6 | `public/styles.css` | 新面板/页面的最小样式 | 追加少量类 |
| 7 | `frontend-test.mjs` | 五组页面拆分后原断言失配 | 改为独立页面断言（真实点击 + 网络 mock），保留旧 `st` 兼容断言 |
| 8 | `.p1-baseline/verify-phase-map.mjs` | 阶段映射唯一来源（新文件必须登记） | 追加阶段 `TT` 与文件清单 |
| 9 | `.p1-baseline/verify-all.mjs` | 一键验收登记 | 登记 temporal 总入口 |
| 10 | `.p1-baseline/test-host-contract.mjs` | 契约 1.13.0 互锁 | 版本相关期望更新（如有硬编码） |
| 11 | `scripts/ci-offline-checks.mjs` | CI 离线清单 | 追加 temporal 总入口（零计费） |
| 12 | `docs/host-contract.v1.json` | 契约冻结表清单（与 db.js 逐字互锁） | host_contract 1.13.0 + `db.tables` + `tables_added_in_v1_13` |
| 13 | `docs/host-contract.md` | 契约文档 | 1.13.0 变更记录 + 表清单 |
| 14 | `docs/README.md` | 文档索引里的契约计数 | 更新 1.13.0 / 表数引用 |
| 15 | `docs/plugin-runtime-map.md` | 契约版本登记 | 更新版本行 |

## 8. 允许新增文件（仅本任务直接需要）

- `ai/story-state/temporal/`：`schema.mjs` `order.mjs` `revision-store.mjs` `event-store.mjs` `reducer.mjs` `snapshot.mjs` `worldline-store.mjs` `history.mjs` `dependencies.mjs` `impact.mjs` `validation.mjs` `service.mjs` `projection.mjs` `index.mjs`
- `ai/repair/`：`planner.mjs` `runner.mjs` `store.mjs` `authorization.mjs` `semantic.mjs`
- `tests/temporal/*.test.mjs`
- `scripts/test-temporal-refactor.mjs`
- `docs/temporal-refactor-audit.md` / `docs/temporal-state-contract.md` / `docs/temporal-refactor-progress.md` / `docs/temporal-refactor-progress.json` / `docs/temporal-refactor-acceptance.md`

> T8 补记：以上为 T0 预估清单；实际落地的新增文件以 `docs/temporal-refactor-progress.md` 各阶段 Scope Audit 为准（例：`ai/repair/analyzer.mjs`、`ai/story-state/temporal/{config,compat,context-provider,analysis,migration,extraction,worldline-store,history}.mjs`、`scripts/perf-temporal-baseline.mjs`（AC-48 性能基线专用）、`tests/temporal/16-log-hygiene.test.mjs` 等），均为本任务直接所需专用文件；未新增通用框架 / 通用 helper / 无关抽象层。

## 9. 明确不修改（负清单）

`data/`（真实作品库）、`package.json`、`pnpm-lock.yaml`、`AGENTS.md`、`README.md`、`README.zh-CN.md`、`LICENSE`、`.env*`、`.github/`、Docker / 发布配置、`harness-plugins/**`（本次不动插件工具/端点面）、与任务无关的测试 / fixture / 文档 / 资源。

## 10. 风险与当前阻塞

- 真实阻塞：无。
- 风险 R1：Host Contract 1.13.0 与 4 处文档/测试互锁，漏一处会让 `ci-offline-checks` 变红 → 已在白名单覆盖。
- 风险 R2：`frontend-test.mjs` 断言密度高，拆分后需要同等强度的新断言 → T6 单独核验。
- 风险 R3：时态表引入后 `test-migration-idempotent.mjs` 按契约动态核对，无需改测试，但必须保证迁移可重复执行且指纹稳定 → T1 实测。
- 风险 R4：模型侧边界 —— 新增作者操作（temporal apply / repair start）必须继承「模型侧 403 + 审批单次消费」语义 → T2/T4 用审批测试覆盖。

## 11. 结论

- T0 事实核对完成：真实路径、已有设施、9 个写入口（8 个需接入 + 4 个不接入的证明义务）、上下文与前端接线点、测试方法、缺口均已明确。
- Frozen Write Allowlist 已冻结（§7），T1–T8 不自行扩大。
- 无安全阻塞，继续 T1。
