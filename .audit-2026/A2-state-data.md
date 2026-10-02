# A2 · 长期记忆 / Story State / 数据模型与持久化 — 只读取证审计

- 被审计仓库：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`
- 基线：分支 `refactor/p0-p6`，HEAD `565a30a79f0d0cc7b8aeceac639d13ce9a01be8a`
- 平台：Windows / Node v24.19.0 / `node:sqlite`（DatabaseSync，SQLite 3.53.x 运行时）
- 审计方式：**全程只读**。未修改 / 创建 / 删除仓库内任何源码文件；唯一写入是本文件（`.audit-2026/A2-state-data.md`）。
- 未读取：`data/`、`.verify-enh/`、`.verify-post/`、`.test-data-*`、`.env`、任何真实作品库内容、任何 API Key。

## 0. 基线与方法学声明（先读这一段，它决定下文结论的有效性）

**0.1 工作树是脏的（重要）。** `git status` 显示 15 个文件已改、6 个未跟踪（+773 / −53 行），其中包含本次审计的核心文件：

| 文件 | 改动量 | 影响 |
|---|---|---|
| `server.js` | +279 | 正文写入口、时态接线、备份/还原、通用 CRUD |
| `db.js` | +23 | schema / 索引 / 迁移 |
| `docs/host-contract.v1.json` | +1 | 契约表清单 |
| `docs/host-contract.md` | +4 | 契约正文 |
| `public/app.js` | +232 | 自动保存、状态面板 |
| `ai/context/assembler.mjs` | +7 | 装配 |
| `tests/temporal/*`、`frontend-test.mjs`、`harness-plugins/.../novel-tools.mjs`、`scripts/ci-isolated-run.mjs` | 小 | 测试与工具面 |

→ **本文所有 file:line 与引用均针对「磁盘上的工作树」，不是 `565a30a7` 的提交内容。** 契约漂移结论（A2-10、A2-11）在两者间可能不同，复核者需以 `git stash`/`git worktree` 另建干净检出对照。

**0.2 复核证据等级。** 每条发现标注 `已确认`（本人读到代码 + 行号 + 引用）/ `高可信静态推断`（代码结构决定，未跑运行验证）/ `尚未验证`。

**0.3 已执行的运行验证（全部为仓库自带隔离封装，不碰真实库）：**

| 命令 | 结果 | 说明 |
|---|---|---|
| `node scripts/ci-offline-checks.mjs --only "Host Contract"` | ✓ 通过（114ms） | 代码↔契约 / 文档↔契约 对账通过 |
| `node scripts/ci-offline-checks.mjs --only "迁移幂等"` | ✓ 通过（789ms） | 空库建表 / 重复启动指纹一致 / 旧库只读指纹 = `3cb7e5d9ac4f67b9` / 损坏库响亮失败 |
| `node scripts/ci-offline-checks.mjs --only "资料索引"` | ✓ 通过（1084ms） | BM25 方向、截断顺序、上限有界 |
| `node scripts/ci-offline-checks.mjs --only "时态"` | ✓ 通过（69480ms） | `scripts/test-temporal-refactor.mjs`（含自托管隔离实例 + 本机假模型；零计费） |

**方法学披露（必须知悉）**：`scripts/ci-offline-checks.mjs` 我已在运行前逐行读过——它只用 `spawnSync(process.execPath, c.cmd, { cwd: REPO })` 跑仓库内脚本，自身不写仓库外路径（`scripts/ci-offline-checks.mjs:91`）。但被它调用的 `test-migration-idempotent.mjs` 会在 **C 段**只读打开基线副本 `.p1-baseline/data/novel.db`（`.p1-baseline/test-migration-idempotent.mjs:85-98`），该文件**确实存在**。我本人没有读取该库内容，只取了它的 pass/fail 结论；这是本次唯一被第三方脚本触达的 `*.db`，请复核者按需裁定。

---

## 1. 模块地图（持久化相关）

```
db.js (1362 行)                        ← 唯一 schema/索引/迁移/事务原语 + 启动自检
  └─ withTransaction / inTransaction   深度感知事务（嵌套用 SAVEPOINT）db.js:36-61
server.js (8895 行)                    ← 宿主：CRUD、备份/还原、正文写入口、时态接线、审批
  ├─ 备份/还原            server.js:113-171
  ├─ 时态保存后处理       server.js:4624-4750（afterTemporalContentSave / schedule*）
  ├─ 通用 CRUD（正文入口）server.js:776-931, 8600-8731
  └─ 时态/状态端点        server.js:5560-6600（含 backfill 5758-5831、repair 5926-6060）
ai/story-state/            确定性状态内核（1.0.0，作品开关 story_state_config.enabled）
  ├─ index.mjs             门面：compositionOf / storyStateLayerOf / preflightOf / validateOf
  ├─ store.mjs             SQL 单点（facts/timeline/knowledge/entities/contracts/proposals/snapshots）
  ├─ proposal.mjs          ops 计划 + 陈旧检查 + 回滚计划；applyProposal 单事务
  ├─ semantic-context.mjs  优先级带 + story_state 子块渲染 + visibleOnly 未来过滤
  ├─ injection.mjs         DATA 围栏 / 注入模式扫描 / 受保护区块校验
  └─ 其余：canon/contract/disclosure/entities/foreshadow/hash/knowledge/preflight/state-machine/style-quality/timeline
ai/story-state/temporal/   时态引擎（temporal 1.2.0，三个默认关的开关）
  ├─ store 层              revision-store / event-store / worldline-store / order / snapshot / stmt
  ├─ 归约与查询            reducer / history(stateAt/reduceThroughIndex/trustReport) / projection
  ├─ 写入与确认            service.mjs(811 行：recordContentSave/applyChapterEvents/confirmBinding/analyze*)
  ├─ 分析                  analysis.mjs(调度) / extraction.mjs(提示词+解析) / validation.mjs(确定性校验)
  ├─ 失效与影响            dependencies.mjs / impact.mjs / repair/analyzer.mjs / repair/runner.mjs
  ├─ 上下文                context-provider.mjs(450 行：cursor / 未来过滤 / 时态版本串)
  └─ 迁移与兼容            migration.mjs(651 行) / compat.mjs
ai/import/  ai/repair/  ai/branch/  ai/library/  ai/novel-index/  ai/style/   ← 各自的 store/sandbox/guard
docs/host-contract.md · host-contract.v1.json · temporal-state-contract.md · story-state-kernel-2026-09-26.md  ← 声称的契约
```

---

## 2. 数据模型清单（实际 SQLite schema）

### 2.1 连接级 PRAGMA（启动即执行，**已确认**）

| 项 | 代码 | 值 |
|---|---|---|
| WAL | `db.js:18` `db.exec('PRAGMA journal_mode = WAL;')` | 开 |
| 外键 | `db.js:19` `db.exec('PRAGMA foreign_keys = ON;')` | 开 |
| 忙等 | `db.js:20` `db.exec('PRAGMA busy_timeout = 5000;')` | 5000ms |
| 启动自检 | `db.js:22-28` `PRAGMA quick_check` → 非 `ok` 直接抛错拒绝启动 | 开（响亮失败） |
| `synchronous` | 未设置 → SQLite 默认（FULL） | 默认 |
| `wal_autocheckpoint` | 未设置 → 默认 1000 页 | 默认 |

与 `docs/host-contract.md:160`、`docs/host-contract.v1.json` 的 `db.pragmas`（三条）**完全一致**。

### 2.2 表清单（`db.js:63-1179` 主建表块 + `db.js:1189` FTS）

共 **73** 个 `CREATE TABLE IF NOT EXISTS`：**72 张业务表 + 1 张 FTS5 虚表**（`library_index_fts`）。

**A. 宿主基础表（1.0.0 冻结的 25 张 + `story_memory_segments`）**

| 表 | 建表位置 | 主键 | 外键 | 唯一约束 | 关键列 |
|---|---|---|---|---|---|
| `works` | `db.js:64` | `id` AUTOINCREMENT | — | — | `title/description/author_note/default_chapter_words/total_chapters/story_structure/narrative_pov/style_positive/ov_uri` |
| `volumes` | `db.js:79` | `id` | `work_id→works` CASCADE | — | `title/summary/position` |
| `plotlines` | `db.js:89` | `id` | `work_id→works` CASCADE | — | `title/kind/summary/position` |
| `chapters` | `db.js:100` | `id` | `work_id→works` CASCADE、`volume_id→volumes` SET NULL、`plotline_id→plotlines` SET NULL、`parent_id→chapters` CASCADE | — | `title/summary/`**`content`（整章正文，长文本）**`/author_note/`**`blueprint_json`（JSON blob）**`/target_words/context_character_ids/position` |
| `categories` | `db.js:118` | `id` | `work_id→works` CASCADE | — | `name/color/position` |
| `terms` | `db.js:127` | `id` | `work_id→works`、`category_id→categories` | — | `title/content/tags` |
| `characters` | `db.js:138` | `id` | `work_id→works` CASCADE | — | `name/identity/appearance/personality/background/`**`status`（兼容投影字段）**`/avatar_color/mes_example/tags/system_prompt/aliases` |
| `character_relations` | `db.js:156` | `id` | `work_id`、`from/to_character_id→characters` CASCADE | — | `relation/description` |
| `world_entries` | `db.js:165` | `id` | `work_id→works` CASCADE | — | `title/content/keywords/is_pinned/priority/position` |
| `creation_tasks` | `db.js:178` | `id` | `work_id→works` SET NULL | — | `prompt/status/stages_json/result_json`（JSON blob） |
| `story_memories` | `db.js:190` | `id` | `work_id→works` CASCADE | **`work_id` UNIQUE** | `summary`（全书摘要，兼容源） |
| `story_memory_segments` | `db.js:198` | `id` | `work_id→works` CASCADE | `UNIQUE(work_id,from_chapter,to_chapter)` | `from/to_chapter/summary/revision/source_chapter_ids`（JSON 数组） |
| `plotline_characters` | `db.js:211` | `id` | `plotline_id/character_id` CASCADE | `UNIQUE(plotline_id,character_id)` | `status/notes` |
| `api_configs` | `db.js:221` | `id` | — | — | `name/base_url/api_key/model/temperature/max_tokens` |
| `ai_error_logs` | `db.js:235` | `id` | — | — | 已废弃，仅一次性迁移读取（注释 `db.js:233-234`） |
| `chapter_save_versions` | `db.js:245` | `id` | `chapter_id→chapters` CASCADE | — | `title/summary/content/kind('manual'\|'draft')` |
| `harness_jobs` | `db.js:257` | **`id` TEXT** | 无（`work_id/chapter_id` 裸列） | — | `kind/stage/status/output/error` |
| `story_events` | `db.js:273` | `id` | `work_id→works` CASCADE、`chapter_id→chapters` SET NULL | 条件唯一索引见下 | `kind/summary/payload(JSON)/foreshadow_status/resolves_event_id/dedup_key` |
| `memory_versions` | `db.js:287` | `id` | `work_id→works` CASCADE | — | `summary/source/note` |
| `writing_redlines` | `db.js:297` | `id` | `work_id→works` CASCADE（可空=全局） | — | `kind/pattern/note/exceptions/enabled` |
| `story_event_proposals` | `db.js:309` | `id` | `work_id`、`chapter_id` | — | `kind/summary/payload/foreshadow_status/resolves_event_id/dedup_key/note/status` |
| `story_memory_proposals` | `db.js:329` | `id` | `work_id→works` CASCADE | — | `summary/delta/note/`**`guard`（来源标记）**`/status` |
| `chapter_reviews` | `db.js:341` | `id` | `work_id`、`chapter_id` CASCADE | — | `report_json/checklist_json/status`（JSON blob） |
| `app_settings` | `db.js:1157` | `key` TEXT PRIMARY KEY | — | — | `value` |
| `app_logs` | `db.js:1165` | `id` | — | — | `ts/layer/level/kind/message/code_file/code_line/code_func/stack/context(JSON)/dedup_key` |
| `ai_eval_events` | `db.js:1141` | `id` | **无**（`work_id/chapter_id` 裸列） | — | `action/channel/model/chars_in/chars_out/ms/edit_distance/draft_key` |

**B. 确定性故事状态内核（1.1.0，10 张，`db.js:364-547`）**

| 表 | 位置 | 主键/唯一 | 关键列 |
|---|---|---|---|
| `story_state_config` | `db.js:364` | `work_id` PK，FK→works | **`enabled`（默认 0）/`temporal_enabled`/`auto_analysis_enabled`/`repair_enabled`（默认 0）/`schema_version`(默认1)/`note`** |
| `story_timeline_entries` | `db.js:382` | `id`，FK work/chapter | `chapter_index/scene_index/seq/story_time/relative_time/day_offset/`**`effective_from`/`effective_to`**`/before_event_id/after_event_id/kind/label/payload` |
| `story_facts` | `db.js:408` | `id`，FK work/chapter | **`subject/predicate/value/scope/state/status/superseded_by/holder_id/effective_from/effective_to/dedup_key/payload`**（`entity_id` 裸列，无 FK） |
| `character_knowledge` | `db.js:434` | `id`，FK work | `character_id`(裸)/`fact_id`(裸)/`fact_key/state/learned_chapter_id/learned_chapter_index/learned_scene_index/story_time/source/note` |
| `story_entities` | `db.js:453` | `id`，FK work | `kind/canonical_name/status/merged_into/split_from/renamed_to/ref_table/ref_id/note` |
| `story_entity_aliases` | `db.js:471` | `id`，FK work、`entity_id→story_entities` CASCADE | `alias/normalized/kind/valid_from/valid_to` |
| `chapter_contracts` | `db.js:486` | `id`，FK work、chapter CASCADE | `version/contract_hash/status/contract_json(JSON)` |
| `story_state_proposals` | `db.js:502` | `id`，FK work | `chapter_id/kind/payload_json/base_state_hash/context_hash/contract_hash/state/conflict_level/auto_fixable/requires_author/dedup_key/applied_at` |
| `story_snapshots` | `db.js:522` | `id`，FK work | `chapter_id/reason/label/state_hash/snapshot_json(JSON)` |
| `story_validations` | `db.js:535` | `id`，FK work | `chapter_id/phase/contract_hash/state_hash/passed/critical_count/high_count/result_json` |

（注：`db.js:549-550` 有一段**截断重复**的注释“作者审批记录（2026-09-27，R02.2）：把"作者同意"从工具描述里的口头纪律变成**服务端可校验”——与 `db.js:744-749` 的完整注释重复，是编辑残留，无功能影响。）

**C. 时态引擎（1.13.0，11 张，`db.js:563-742`）**

| 表 | 位置 | 主键/唯一 | 关键约束 | 关键列 |
|---|---|---|---|---|
| `story_chapter_order_versions` | `db.js:563` | `id` TEXT PK | `UNIQUE(work_id,id)`；`CHECK(json_valid(order_json))` | `order_json/order_hash` |
| `story_worldlines` | `db.js:574` | `id` TEXT PK | `CHECK(kind IN('main','repair','sandbox'))`、`CHECK(status IN('open','merged','archived'))`、**部分唯一索引：每作品仅一条 open main**（`db.js:586`） | `base/head_commit_id/generation/label` |
| `story_commits` | `db.js:589` | `id` TEXT PK | `UNIQUE(work_id,id)`、`json_valid(manifest_json)`；**`worldline_id` 无 FK** | `parent_commit_id/order_version_id/manifest_json/manifest_hash/note` |
| `story_chapter_revisions` | `db.js:604` | `id` TEXT PK | `UNIQUE(work_id,id)`、FK chapter CASCADE | **`content_html`（整章正文副本）/`content_hash`/`text_hash`/`normalizer_version`/`origin_json`** |
| `story_state_events` | `db.js:619` | `id` TEXT PK | `UNIQUE(work_id,id)`、FK chapter CASCADE、四个 `json_valid` | `revision_id`(裸)/`cursor_json/story_time_json/ops_json/evidence_json/schema_version/event_hash` |
| `chapter_state_snapshots` | `db.js:636` | `id` TEXT PK | `UNIQUE(work_id,id)`、FK chapter SET NULL | `order_version_id`(裸)/`cursor_json`/**`state_json`（全量状态镜像）**/`state_content_hash/lineage_hash/algorithm_version` |
| `story_chapter_bindings` | `db.js:652` | `id` TEXT PK | `UNIQUE(work_id,id)`、`CHECK(validity IN 9 值)`、**`CHECK(validity<>'valid' OR output_snapshot_id IS NOT NULL)`** | `revision_id/event_ids_json/input/output_snapshot_id/contract_ref_json/appearances_json/validation_json/story_time_json` |
| `story_binding_trust` | `db.js:676` | `id` TEXT PK | **`UNIQUE(commit_id,binding_id)`** | `validity/detail_json` |
| `story_chapter_dependencies` | `db.js:689` | `id` TEXT PK | `CHECK(kind IN 14 值)` | `binding_id`(裸)/`resource_key/expected_hash/dependency_json` |
| `story_repair_runs` | `db.js:703` | `id` TEXT PK | `UNIQUE(work_id,id)`、`CHECK(mode IN('analyze','repair'))`、`CHECK(status IN 10 值)` | `lease_owner/lease_expires_at/fencing_token/idempotency_key/coverage_json` |
| `story_repair_steps` | `db.js:727` | `id` TEXT PK | `CHECK(status IN 13 值)`、FK chapter CASCADE | `run_id`(裸)/`step_key/attempt/candidate_*` |

**D. 审批 / 幂等 / 投影（1.3.0–1.5.0，4 张，`db.js:750-813`）**：`author_approvals`（`id` TEXT PK，`work_id/chapter_id` 裸列，索引 `(work_id,op,status)`）、`adoption_operations`（`idempotency_key` PK）、`projection_outbox`（`id` 自增 PK + 部分唯一索引 `dedup_key`）、`ov_projection_audit`（`id` PK）。

**E. 作者侧风格 / 沙盘 / 导入重建（1.7.0–1.10.0，7 张，`db.js:817-935`）**：`author_samples`、`style_profiles`、`author_intents`（`UNIQUE(work_id,chapter_id,tier)`）、`branch_sandboxes`、`branch_candidates`、`import_rebuild_runs`、`import_rebuild_batches`（`UNIQUE(run_id,batch_index)`）。

**F. 资料库与派生索引（1.11.0–1.12.0，14 张，`db.js:940-1130`）**：`library_docs`（`UNIQUE(uri)`）、`library_index`（`UNIQUE(doc_id)`）、`novel_index_characters/events/foreshadows/world/relations/locations/threads/items/chapters/style/knowledge`（均为 `PRIMARY KEY(work_id, …)` 复合主键，**无 FK**）、`novel_index_meta`（`PRIMARY KEY(work_id,key)`）。

### 2.3 索引与唯一约束（`db.js:269/571/586/601/616/633/649/669-670/686/699-700/724/742/764/794-795/813/829/843/856/872/893-894/912/934-935/959-960/980`，及 1296-1341 汇总块）

- 常规索引 **48 条** + 条件唯一索引 4 条 + 部分索引 2 条：
  - `idx_story_events_dedup_uq`：`UNIQUE(work_id,dedup_key) WHERE dedup_key!=''`（`db.js:1347`，建失败只告警）
  - `idx_story_facts_dedup_uq`：`UNIQUE(work_id,dedup_key) WHERE dedup_key!=''`（`db.js:1356`）
  - `idx_char_knowledge_key_uq`：`UNIQUE(work_id,character_id,fact_key) WHERE fact_key!=''`（`db.js:1357`）
  - `idx_chapter_contracts_version_uq`：`UNIQUE(chapter_id,version)`（`db.js:1358`）
  - `idx_projection_outbox_dedup`：`UNIQUE(dedup_key) WHERE dedup_key!=''`（`db.js:795`）
  - `idx_temporal_one_main`：`UNIQUE(work_id) WHERE kind='main' AND status='open'`（`db.js:586`）
- 启动时 `DROP INDEX IF EXISTS idx_plotline_characters_plotline`（`db.js:1293`，与 `UNIQUE(plotline_id,character_id)` 最左前缀重复）。

### 2.4 各业务实体的存储位置（回答「结构化列 vs 大 JSON blob vs 长文本」）

| 实体 | 表 / 字段 | 形态 |
|---|---|---|
| 章节正文 | `chapters.content`（长文本）+ **`story_chapter_revisions.content_html`（时态启用后每稿一份全量副本）** + `chapter_save_versions.content`（历史版本，每章保留 10 份/分区） | 长文本 |
| 章节大纲/蓝图 | `chapters.blueprint_json` | **JSON blob**（`schema` 无列级约束） |
| 卷/剧情线 | `volumes`、`plotlines`（`title/summary/position` 结构化） | 结构化 |
| 人物 | `characters`（12 列结构化；`aliases`/`tags` 为分隔字符串） | 结构化 + 字符串列表 |
| 人物关系 | `character_relations`（`from/to/relation/description`） | 结构化 |
| 世界观 | `world_entries`（`title/content/keywords/is_pinned/priority`） | 结构化 + 长文本 |
| 词条 | `terms`（`title/content/tags/category_id`） | 结构化 |
| 伏笔 | **`story_events.kind='foreshadow'` + `foreshadow_status`/`resolves_event_id`/`payload(JSON)`**；派生索引 `novel_index_foreshadows` | 结构化 + JSON |
| 时间线 | `story_timeline_entries`（`chapter_index/scene_index/seq/story_time/effective_from/to` 结构化 + `payload` JSON） | 结构化 + JSON |
| 长期记忆（摘要） | `story_memories.summary`（全书一条，`work_id` UNIQUE）+ `story_memory_segments.summary`（十章窗口，`revision` 递增） | 长文本 |
| 记忆版本 | `memory_versions.summary`（保留最近 K 份，`server.js:1822`） | 长文本 |
| 正典事实 | `story_facts`（`subject/predicate/value/scope/state/status/effective_*` 结构化 + `payload` JSON） | 结构化 + JSON |
| 角色知识边界 | `character_knowledge`（`fact_key/state/learned_*`） | 结构化 |
| 状态事件 | `story_state_events`（`ops_json`/`evidence_json`/`cursor_json`/`story_time_json` 全为 JSON） | **JSON blob** |
| 状态快照 | `chapter_state_snapshots.state_json`（整章状态 Map 序列化） | **JSON blob** |
| 绑定 | `story_chapter_bindings`（`event_ids_json`/`validation_json`/`contract_ref_json`/`appearances_json`） | **JSON blob** |
| 契约 | `chapter_contracts.contract_json`（按 `(chapter_id,version)` 追加） | **JSON blob** |
| 派生索引 | `novel_index_*`（每列多为空格分隔的字符串，无 FK） | 结构化（反规范化） |

---

## 3. 逐条发现

> 排序：P0 → P1 → P2 → P3。用户影响按「50 万字 / 300 章」场景给。

### A2-01 ｜正文写入与状态修订**不在同一事务**，与代码注释的声称矛盾（P1 · 已确认）

- 可信度：**已确认**（读代码 + 事务边界逐行核对）
- 证据：
  - 声称：「所有正文写入口在**写入的同一个事务里**调用 afterTemporalContentSave」`server.js:4625`
  - 实际（编辑器自动保存路径，即最常用路径）：`server.js:8675` `const changes = updateRow(resource, id, body);` → `server.js:8687` `afterTemporalContentSave(old.work_id, Number(id), body.content, 'editor_save');`，两者之间**没有任何 `BEGIN`/`withTx`**；`updateRow` 本身也无事务（`server.js:891-924`，裸 `UPDATE`）。
  - 对照：确实同事务的路径有 `server.js:3829/3842`（导入）、`server.js:4140/4232`（AI 成文）、`server.js:8489/8501`（恢复历史版本）。
  - 内部实现确实开事务：`service.mjs:335` `return inTransaction() ? run() : withTransaction(run);`
- 为什么是问题：`recordContentSave` 抛错（如 `guard` 的 `TEMPORAL_SCHEMA_MISSING`，`service.mjs:38`；或 `insertEvents` 的修订不匹配，`event-store.mjs:58`）时，**正文已经落库提交**，而 revision/pending 提案回滚——请求返回失败但字已保存；更危险的是缺了 pending 绑定后，默认 HEAD 查询不会在此章停住（依赖 `history.mjs:114-119` 的 pending 停止），旧的 valid 状态会继续充当「最新」。
- 用户影响（50 万字/300 章）：一次异常即可让某一章「正文是新的、状态是旧的」而界面无提示；后续所有基于该章的推断都错位，且难以定位。
- 根因：注释描述的是「设计意图」，实现按写入口逐个接线，通用 CRUD PUT 漏了事务包裹；`updateRow` 用 autocommit。
- 建议方向：把通用 CRUD 的 chapters 写入（`POST`/`PUT` 两条）整体包进 `withTx`，或让 `afterTemporalContentSave` 与正文写共享同一事务；顺带修正 `server.js:4625` 注释或补上例外清单。

### A2-02 ｜章节重排（插章/删章/跨卷移动）不触发下游失效：`earliestOrderDifference` 零生产调用（P1 · 已确认）

- 证据：
  - 能力实现：`impact.mjs:154-169` `export function earliestOrderDifference(oldChapters,newChapters)`，注释「AC-30：插章/删章/跨卷移动后，从差异处开始失效」。
  - 调用点：仅 `tests/temporal/03-integrity.test.mjs:174`。`grep -rn "earliestOrderDifference"` 在 `ai/`、`server.js`、`public/` 中**无任何生产调用**。
  - 章序变化确实是可检测的：`order.mjs:91-113` `ensureOrderVersion` 会把新顺序落成新版本；`service.mjs:269/395` 在保存/确认时调用它，并把**新** `orderVersion.id` 写进提交（`worldline-store.mjs:90-95`）。
- 为什么是问题：重排后新提交引用新章序，而所有下游 binding 仍是 `valid`、覆盖表照旧复制（`service.mjs:431` `copyTrustOverlay`）→ 状态按新顺序归约，却没有任何重新验证，也没有 stale 提示。
- 用户影响：300 章作品里「把第 40 章拖到第 60 章位置」「插入新章」这类高频操作，会让 40 章之后的状态与历史静默错位；作者看不到任何告警。
- 根因：AC-30 只落了纯函数与单测，缺生产接线（章序写入口没有调用 `earliestOrderDifference` + `markDownstreamStale`）。
- 建议方向：在章序版本切换处（`ensureOrderVersion` 返回 `reused:false` 时，或章节 position/volume_id/parent_id 变更的 CRUD 路径）计算最早差异并调用 `markDownstreamStale({reason:'order_changed'})`。

### A2-03 ｜「全下游复核」被 `max_chapters:200` 静默截断，且 `skipped` 记为 0（P1 · 已确认）

- 证据：
  - 契约声称「根章之后的**全部**章节保守送入复核」`docs/host-contract.md:414`；`temporal-state-contract.md:42`「只分析、标记（stale 全后缀）」。
  - 实现上限：`analyzer.mjs:32-33` `export const IMPACT_LIMITS = Object.freeze({ max_chapters: 200,`；选取处 `analyzer.mjs:281` `chapters: selected.slice(0, Math.max(1, Number(maxChapters) || IMPACT_LIMITS.max_chapters)).map(...)`。
  - 统计口径：`analyzer.mjs:282` `skipped: all.length - selected.length`（`all_downstream` 时 `selected===all` → **恒为 0**）；`analyzer.mjs:660` `downstream: cov.chapters.length`（截断后的数量）。
- 为什么是问题：以第 50 章为根、300 章作品时，下游 250 章只复核前 200 章（第 251–300 章永不进入复核），而报告里 `skipped_by_coverage=0`、`totals.downstream=200`，读者无法从报告看出漏了 50 章。
- 用户影响：长篇后半段（正是最容易崩的部分）不在保护范围内，且失败是「静默」的——与契约承诺相反。
- 根因：常量上限（出于成本/时间）与「保守全量」措辞未对齐；截断未反映到 `skipped` / 未落一条显式的 `truncated_at_chapter` 说明。
- 建议方向：把截断显式化（`skipped = all.length - selected.length` 用 `chapters.length` 而非 `selected.length`；报告加 `truncated:true` + `not_revalidated:[…]`），并让上限可配置或分批续跑。

### A2-04 ｜Story State 闭环**默认不跑**：三个开关默认 0，新作品只开「基础状态」（P1 · 已确认，且仓库内已有报告承认）

- 证据：
  - 列默认值 0：`db.js:366-373`（`enabled`/`temporal_enabled`/`auto_analysis_enabled`/`repair_enabled` 全部 `DEFAULT 0`）；读取见 `temporal/config.mjs:22-31`。
  - 新作品只开 `enabled`：`server.js:8639-8641` 「P1-04：新作品默认接入 Story State」「`StoryState.setEnabled(newId, true, '新作品默认开启（可由作者关闭）')`」——**不含** temporal 三开关。
  - 自动分析门控：`analysis.mjs:67-70` `if (!force && !getTemporalConfig(ctx.work_id).auto_analysis) { finishAnalysis({... status:'not_run', error:'自动分析未开启（可在章节面板显式发起）' ...}) }`。
  - 保存只建 pending（不含事件）：`service.mjs:308-326`（`createBinding({validity:'pending'})`）；确认要求已有事件：`service.mjs:699` `if (!stored.length) return { ok:false, decision:'needs_review', reason:'提案还没有事件（分析未完成或未产出变化）' }`。
  - 一致性校验只在旧内核开关下前置：`server.js:6194`/`6222` 前置 `StoryState.isEnabled(workId)`，而时态影响复核前置 `isTemporalEnabled`（`server.js:4735`）。
  - 该结论在仓库内已被记录：`缺点及修复报告.md:634`「但时态引擎的写前预检/写后校验路径仍受 `temporal_enabled` 门控」，`缺陷修复报告.md:29`（P1-04）。
- 为什么是问题：默认路径上「章节完成 → 抽取 → 校验 → 提交 → 状态更新」这条链**不存在**：保存只落 revision + 空 pending 提案，没有模型分析就不会有事件，作者不点「显式分析」就永远停在 pending。所谓闭环是「能力存在、默认不开；开了也需要人工点两次」。
- 用户影响：300 章作者按默认设置写作，得不到任何确定性一致性保护；闭环只在「显式开启 temporal + 显式开启自动分析（或逐章手点分析）+ 逐章确认」时才成立。
- 根因：成本与「零行为变化」双约束下的默认策略；缺一条「首次开启后引导作者完成 enable_scope 回填」的显式提示链路（`enable_scope` 已实现，`server.js:5701-5703`，但只在 PUT 响应里出现一次）。
- 建议方向：在章节面板对 `analysis.status==='not_run'` 的 pending 提案给出显式的一键入口与费用提示；把「默认开启」的取舍写成契约里的明确结论（当前只在变更记录与散文里）。

### A2-05 ｜`GET /api/chapters` 无分页，返回全部章节**含整章正文**（P1 · 已确认）

- 证据：
  - `server.js:798-806` `function getList(resource, where) { ... `SELECT * FROM ${cfg.table} WHERE ... ORDER BY ${cfg.order}` ... }` —— **无 LIMIT**。
  - 路由 `server.js:8625` `const rows = getList(resource, where) || [];`
  - `chapters` 的字段表包含 `content`：`server.js:780`（`fields: [... 'content' ...]`）。
  - 前端每次打开作品都整表拉取：`public/app.js:974-986`（`Promise.all([... api('/chapters?work_id=' + workId) ...])`）；作品卡还会再拉一次算字数：`public/app.js:926-931`（`rows.reduce((sum, chapter) => sum + chapterWordCount(chapter), 0)` —— 依赖正文）。
- 为什么是问题：一次作品切换 = 全部正文的 JSON 传输 + 浏览器内存常驻；没有任何分页/懒加载层。
- 用户影响：50 万字 / 300 章时单次响应约 1.5–2MB（UTF-8 中文 3 字节/字），且首屏阻塞；多作品列表页会对每张卡片重复该请求（`state.workMeta` 有缓存，但 `force` 与切作品会重取）。
- 根因：通用 CRUD 一直是「小数据」假设；章节正文后来被塞进同一个 `chapters` 表成为大字段。
- 建议方向：`chapters` 列表默认不带 `content`（只给 `summary/updated_at/字数`），正文按需 `GET /chapters/:id`；或加分页/`fields=` 参数。

### A2-06 ｜全文检索是本库最弱一环：`LIKE '%kw%'` + `SELECT *`，无 FTS（P1 · 已确认）

- 证据：
  - `server.js:942-948`：`const conds = keywords.map((k) => `(${fields.map((f) => `${f} LIKE ?`).join(' OR ')})`).join(' AND ')`；`const sql = `SELECT * FROM ${table} WHERE ${conds}${workId ? ' AND work_id = ?' : ''}${extra} LIMIT 200``。
  - 调用处 `server.js:4954-4956`（`GET /api/search?q=&work_id=`）。
  - 章节表被搜的字段包含 `content`（见 `server.js:780`），故 `LIKE '%kw%'` 会扫整章正文。
  - 仓库里唯一的 FTS5 只服务**共享资料库**：`db.js:1189` `CREATE VIRTUAL TABLE ... library_index_fts USING fts5(tokens, doc_id UNINDEXED, tokenize='unicode61')`，写入在 `ai/library/library-index.mjs:237-239`；作品正文**没有** FTS 表。
- 为什么是问题：无索引的 `%...%` 前缀通配 → 每张表全扫描；`SELECT *` 把命中章节的完整正文读进内存（最多 200 行）；中文按 `LIKE` 匹配无分词。
- 用户影响：300 章作品里搜一个词要扫全部正文（数百万字符），并且把最多 200 章正文搬进内存；搜索越用越慢，且没有 BM25 排序（只有手写权重 `server.js:951-963`）。
- 根因：FTS 能力只在 D 模块（资料库）落地，作品域检索引擎没有对应建设；`AI 效果埋点`/`novel_index` 走的是结构化查询。
- 建议方向：为 `chapters`（或修订）建 FTS5 表（可用现有 `tokenizeForIndex` 的中文 bigram 口径，`library-index.mjs:189-203`），查询只回 `chapter_id + snippet`，正文按需取；至少在 `search()` 里把 `SELECT *` 换成显式列并去掉 `content`。

### A2-07 ｜派生索引的失效判据是 `works.updated_at`，而几乎每次保存都会改它 → 每保存一次全量重建索引（P1 · 已确认）

- 证据：
  - 指纹：`ai/novel-index/store.mjs:85-92` `const fingerprint = `${NOVEL_INDEX_SCHEMA_VERSION}|${String(work.updated_at || '')}`; ... if (stored === fingerprint && novelIndexVersion(workId) > 0) return {...'fresh'}; const out = rebuildWorkIndex(workId);`
  - `works.updated_at` 被每次内容写入推进：`server.js:607-615` `function touchWork(workId) { contextCache.invalidateAll(); ... 'UPDATE works SET updated_at = ? WHERE id = ?' ... }`；正文保存后调用 `server.js:8689 if (old?.work_id) touchWork(old.work_id);`
  - 重建成本：`novel-index/store.mjs:132-175` 读全量 `story_events`（`SELECT * FROM story_events WHERE work_id = ?`，`:142`）并对每个事件 × 每个角色做 `summary.includes(name)`（`:166-170`，O(事件×角色)）；`:337-340` `prune(...)` 先查全表再逐行 `DELETE`（O(N) 条语句）。
  - 触发点在上下文装配里：`server.js:3121-3123`（`if (direction && ... && NovelIndexStore.novelIndexEnabled()) { NovelIndexStore.ensureWorkIndex(workId); ... }`）。
- 为什么是问题：800ms 自动保存（`public/app.js:3392-3398`）→ `touchWork` → 下一次装配触发**整部作品**的索引重建；且它在生成请求的关键路径上同步执行。
- 用户影响：300 章 / 数千事件的作品，每次「打字停顿后第一次生成」都要重建全部派生索引（含 O(事件×角色) 的字符串扫描与逐行 DELETE），首字延迟随规模线性（甚至二次）增长；开关默认关闭（`novel-index/store.mjs:60-62` `settingGet(enabledKey,'0')`）缓解了默认路径，但一旦作者打开该功能即命中。
- 根因：指纹用了「作品行更新时间」这个过于粗糙的信号，而更新它的 `touchWork` 是通用失效钩子；缺少「按内容哈希/版本号」的细粒度指纹。
- 建议方向：指纹改为「章节内容哈希集合 / 受影响表的单调版本号」，或在 `touchWork` 里区分「影响索引的写入」；重建移出请求路径（作业化 + 结果缓存）。

### A2-08 ｜时态修订与快照无任何保留策略：库随时间线性膨胀（P2 · 已确认）

- 证据：
  - 每次内容变化都新增一整份正文副本：`revision-store.mjs:83-86`（`INSERT INTO story_chapter_revisions (..., content_html, ...)`），仅按「内容哈希相同」去重（`:70-75`）。
  - 全仓库**没有任何** `DELETE FROM story_chapter_revisions` / `chapter_state_snapshots` / `story_state_events` / `story_snapshots` / `story_chapter_bindings`（`grep -rn "DELETE FROM story_(chapter_revisions|state_events|snapshots|chapter_bindings)|DELETE FROM chapter_state_snapshots"` → 0 命中）。
  - 对照：用户可见的历史版本有明确保留策略——`server.js:1554-1576` `pruneChapterVersions`，manual/draft 各留 10 份。
- 为什么是问题：`content_html` 是整章正文（5–10KB/章），`chapter_state_snapshots.state_json` 是全量状态镜像（随事实数增长）。二者都是「只增不减」。
- 用户影响：300 章 × 每章数十次保存（800ms 防抖，但每次不同内容算一稿）→ 修订表可达数万行、数百 MB；状态镜像随事实数增长更快；备份（`VACUUM INTO`）体积与耗时同步膨胀，`quick_check` 与启动更慢。
- 根因：审计/可回放优先的「不可变」设计，与「无界增长」之间缺一条保留策略（内容寻址只解决同内容重复，不解决版本数）。
- 建议方向：为 `story_chapter_revisions` 加「每章保留最近 N 稿 + 被提交引用的稿永不删」的策略；`chapter_state_snapshots` 改为按提交保留或定期压缩（并在契约里写明保留口径）。

### A2-09 ｜状态查询每次从头重放全书事件：章节边界快照只写不读（P2 · 已确认）

- 证据：
  - 归约起点固定为空：`history.mjs:65-66` `let state = stateFromJson('{}'); let applied = 0;` → 逐章 `reduceBatchInPlace`（`:123`）直到边界。
  - 预取范围是该提交的**全部** binding/event/revision：`history.mjs:49-59`（`for (const id of Object.values(manifest)) ...`、`eventsByIds(...)`、`revisionsByIds(...)`）。
  - 快照写得很勤（`service.mjs:397-407` 章前/章后各一份、`analyzer.mjs:307-321`、`runner.mjs:758-767`），但**读回函数没有任何调用者**：`snapshot.mjs:20-24` `export function snapshotState(id)` —— 全仓库仅此一处定义（`grep -rn "snapshotState"` 只命中定义与 `proposal.mjs:333` 的同名**参数**）。
  - 模块自己的注释承认这是过渡态：`snapshot.mjs:7` 「起步阶段每章存完整状态快照（先证明正确性）；规模测试后再切 checkpoint + 增量」。
- 为什么是问题：每次 `stateBefore`/`stateAt`（保存、确认、装配、面板都会触发）都做 O(全书事件) 的内存归约与 O(全书) 的 3 次批量读；于是「写快照」的成本付出去了，「读快照省时间」的收益没有兑现。
- 用户影响：300 章 / 数千事件时，每次保存、每次装配上下文、每次打开章末面板都要重放全部事件（数百 ms 级，规模再大则秒级）。
- 根因：checkpoint 优化被标注为「规模测试后」，未实现；快照读取路径缺消费方。
- 建议方向：让 `reduceThroughIndex` 从「不晚于边界且可信前缀完整」的最近 `chapter_state_snapshots` 起算，仅在 lineage/hash 命中时复用；否则回退全量重放（正确性不变）。

### A2-10 ｜死代码 / 未接线导出（**声称有防护、实际零调用**）（P2 · 已确认）

以下导出在 `ai/**` 与 `server.js`/`public/` 中**无任何非测试调用**（逐个用 grep 复核过，非仅靠脚本统计）：

| 导出 | 位置 | 说明 / 影响 |
|---|---|---|
| `verifyProtectedBlocks` | `injection.mjs:108-141` | 模块头声明的三条防护之一（「受保护区块不可被 DATA 覆盖」），**零调用** |
| `annotateLayers` / `summarizeInjection` | `injection.mjs:147-165` | 注入命中元数据的装配侧入口，**零调用**（实际只有 `index.mjs:133` 对 `story_state` 层跑了一次 `scanInjection`） |
| `wrapAsData` | `injection.mjs:89-100` | DATA 围栏原语，**产品无调用点**（仅 `index.mjs:41` import 未用） |
| `state-machine.mjs` 全模块 | `state-machine.mjs:77/111/129/148/195`（`hostStatusOf`/`canAdvance`/`advance`/`derivePhase`/`timelineOf`） | 18 相位状态机在 `server.js` 里只用到常量 `PHASES`（`server.js:5640`），迁移表/相位推导/宿主状态映射**从未在生产路径使用** |
| `annotateSemantic` / `orderBlocks` / `orderSemanticItems` / `verifyBandCoverage` / `bandOfLayer` | `semantic-context.mjs:83/99/177/187/66` | 优先级带体系只被 `buildStoryStateText` 内部用到顺序常量；「每个既有层都必须有归属」的自检**零调用**（见 A2-12） |
| `detectKnowledgeViolations` / `detectAuthorScopeLeaks` | `knowledge.mjs:122/163` | 「角色知道了不该知道的」检测器**零调用**（只在注释里被提及） |
| `chapterIndexOfContract` | `contract.mjs:282` | 零调用 |
| `markProposalsStale` | `store.mjs:348-354` | 批量 stale 兜底入口零调用（只有单条 `applyProposal` 的 `store.mjs:342` 生效） |
| `snapshotState` | `snapshot.mjs:20` | 见 A2-09 |
| `chaptersOfOrderVersion` / `bindingIdOfChapter` / `headCommitOf` / `latestOrderVersion` | `order.mjs:145`、`worldline-store.mjs:117/32`、`order.mjs:123` | 零调用（历史查询走 `orderOfCommit`） |
| `chapterOrderIndexOf` | `order.mjs:132` | 仅测试调用（生产用 `cursorOfChapter`） |
| `hashOfContent` / `hashOfPlain` / `revisionTextHash` / `revisionLineageOf` | `revision-store.mjs:103/107/95/99` | 零调用（同类能力在 `schema.mjs` 内联实现） |
| `TEMPORAL_VERSION = '1.2.0'` | `temporal/index.mjs:27` | 常量零引用（无人上报该版本） |
| `isTerminal` / `PHASES_BY_HOST_STATUS` 等 | `state-machine.mjs:43/68` | 零引用 |
- 仓库内已自认的一部分：`docs/ai-core.md:225` 与 `docs/post-implementation-issues.md:46` 已把 `wrapAsData` / `verifyProtectedBlocks` 记为零调用（P3 · 本轮未改）；`docs/golden-novel-regression-2026-09-26.md:303` 记 `fencing_primitive_used_in_product=false`。
- 为什么是问题：模块头部的「三条防护（缺一条都不成立）」（`injection.mjs:10-15`）与「每个既有层都必须有归属」（`semantic-context.mjs:36`）是**读代码的人会相信的承诺**，实际只有 `scanInjection` 生效。
- 用户影响：注入防护与相位一致性目前由审批门、工具白名单、导入剥标签、召回 fail-closed 承担（`docs/ai-core.md:225`），没有实际质量损失；风险是**未来维护者按注释行事**（例如以为 DATA 围栏已生效而放宽别处）。
- 根因：能力先建成纯函数并单测（可测性好），生产接线被排到后续阶段且未回填清单。
- 建议方向：为「零调用的导出」建立显式状态（`@unwired` 注释或 `docs/ai-core.md` 清单），或者补接线；至少把 `verifyProtectedBlocks` 接到装配出口做告警（不改字节）。

### A2-11 ｜契约漂移 1：`library_index_fts` 未进 `db.tables`；72 vs 73（P3 · 已确认）

- 证据：
  - 契约声明 72 张：`docs/host-contract.md:157`「**输出** | 72 张表（见 fixture `db.tables`）」；`host-contract.v1.json` 的 `db.tables`（72 项）+ `db.frozen_tables`（25 项）。
  - 实际创建 73：`grep -c "CREATE .*TABLE IF NOT EXISTS" db.js` = 73；`db.js:1189` `CREATE VIRTUAL TABLE IF NOT EXISTS library_index_fts USING fts5(...)`。
  - 逐表对账结果：**声明但未建 = 0**；**建但未声明 = `library_index_fts`**（脚本对账，见 §0.3 已跑 `test-migration-idempotent.mjs` A1「契约声明的 72 张表全部建成」通过）。
  - 散文里承认了它：`docs/host-contract.md:159`（1.12.0 行）「词法用 FTS5 虚表 `library_index_fts`，单独 try/catch 建、缺 FTS5 只降级不阻断启动」。
- 为什么是问题：fixture 是唯一机读表清单，运维/插件若按它核对「有没有多余对象」会漏掉一张带 shadow tables 的虚表（`*_data/*_idx/*_content/*_docsize/*_config`）。
- 用户影响：无直接功能影响；影响「按契约核对数据库」的自动化与本次这类审计的可复核性。
- 根因：`db.tables` 只枚举业务表；FTS 是运行时可选能力（缺 FTS5 只告警，`db.js:1190-1192`），故被排除在枚举外，但没有在 fixture 里以「optional」字段显式表达。
- 建议方向：fixture 增 `db.optional_tables: ["library_index_fts"]`（或把 `db.tables` 标注为业务表并加 `db.virtual_tables`）。

### A2-12 ｜契约漂移 2：时态端点只出现在变更记录里，不在任何机读端点清单中（P3 · 已确认）

- 证据：
  - fixture `plugin_adapter.endpoints` 共 75 条，**不含**任何 `/api/novel/state/{temporal,at,panel,confirm,analyze,correct,proposal-groups,impact,repair,backfill,revision}`（`node -e` 打印全部 75 条逐条核对）。
  - `docs/host-contract.md:183`「② 端点面 = fixture `plugin_adapter.endpoints`（75 条）；③ 每个端点在 `server.js` 里真的存在（契约测试逐条核对）」。
  - `docs/host-contract.md:301`「**作者界面专用（不在插件白名单，模型侧一律 403）**」清单里**没有**时态端点，只有 adopt/editing/projections/import-confirm/library 写操作。
  - 时态端点确实实现：`server.js:5667`（temporal）、`:5707`（at）、`:5722`（panel）、`:5758`（backfill）、`:5844`（confirm）、`:5891`（proposal-groups apply）、`:5926`（impact）、`:5955`（repair）。
  - 变更记录里逐条声称：`docs/host-contract.md:25-31`（1.13.0–1.19.0）。
- 为什么是问题：契约的「可机读面」与「散文历史」分裂；契约测试（`.p1-baseline/test-host-contract.mjs`，已跑通）只校验 fixture 内 75 条与代码一致，**不会**发现新增的 11+ 条作者侧端点未登记。
- 用户影响：插件/自动化无法从契约发现这些端点；「作者侧 403」这一关键边界只存在于散文里。
- 根因：「不变条件②」把「端点面」定义成「插件白名单」而非「全部端点」，于是新增作者侧端点不触发 fixture 更新；措辞在 1.13.0+ 被沿用为「插件工具/端点面不变」。
- 建议方向：fixture 增 `author_only_endpoints`（或 `endpoints_added_in_v1_13…` 与 `db.tables_added_in_*` 同构），并让契约测试对「server.js 中存在但两侧清单都没有的 `/api/` 路由」告警。

### A2-13 ｜注释与代码不一致（5 处，逐条给证据）（P2/P3 · 已确认）

| # | 声称 | 实际 | 位置 |
|---|---|---|---|
| 1 | 「相位可以由编排层显式推进（`nextPhase`）」 | **不存在 `nextPhase`**，只有 `advance`；`grep -rn nextPhase` 全仓库仅命中该注释 | 注释 `state-machine.mjs:11`；实现 `state-machine.mjs:129` |
| 2 | 「规模测试后再切 checkpoint + 增量」（隐含已规划） | `snapshotState` 零调用、归约始终从空状态开始 | `snapshot.mjs:7` vs `history.mjs:65` |
| 3 | 「**开关默认 0**：未开启的作品…逐字节一致」 | 列默认确为 0，但**新作品**被 `server.js:8641` 自动置 1 | `db.js:356` vs `server.js:8639-8641` |
| 4 | 「FTS5 `library_index_fts`（bigram 分词）」 | DDL 用的是 `tokenize='unicode61'`；bigram 是 JS 侧 `tokenizeForIndex` 生成后以空格 join | `library-index.mjs:14` vs `db.js:1189` + `library-index.mjs:189-203/239` |
| 5 | 「**每个既有层都必须有归属**（缺一个会在单元测试里报出来）」 | `LAYER_BAND` 只有 15 项，实际层有 18 个（缺 `library`/`edit_rules`/`author_intent`，`layers.mjs` 18 层与 fixture 一致）；`verifyBandCoverage` 零调用、无测试覆盖 | `semantic-context.mjs:36/37-53` vs `ai/context/layers.mjs`（18 层）+ fixture `context.layers`（18 条，已核对 caps 全等） |
| 6 | 「所有正文写入口在写入的同一个事务里」 | 通用 CRUD PUT/POST 不是 | `server.js:4625` vs `server.js:8675/8687`（见 A2-01） |
- 为什么是问题：这 6 处都是「读注释就能得到错误结论」的地方，且第 3、5、6 条直接关系到默认行为与防护是否生效。
- 用户影响：间接（误导维护者与后续审计者）；第 3 条会影响作者对「我的书有没有开状态内核」的判断。
- 建议方向：逐条改正注释或在注释旁写明例外；对第 5 条要么补齐 `LAYER_BAND` 三层，要么删掉该承诺并把 `verifyBandCoverage` 接进 CI。

### A2-14 ｜无 `schema_version` 表 + 启动时逐表全量时间戳归一化（P2 · 已确认）

- 证据：
  - 迁移是「试错式 ALTER + 吞重复列错误」：`db.js:1195-1237`（`MIGRATIONS` 36 条 `ALTER TABLE ... ADD COLUMN`；`if (!/duplicate column/i.test(...)) console.warn(...)`）。**没有** host 侧迁移版本表（`story_state_config.schema_version` 只服务该行，`db.js:374`）。
  - 每次启动执行 19 张表 × 33 列的归一化 UPDATE：`db.js:1257-1275`（`UPDATE ${table} SET ${col} = replace(${col},' ','T')||'Z' WHERE ${col} GLOB '????-??-?? ??:??:??'`）——对该列**全表扫描**，且 `chapters`/`story_events`/`chapter_save_versions` 都在清单内（`db.js:1259/1264`）。
  - 每次启动还重建 48 条索引（`CREATE INDEX IF NOT EXISTS`，`db.js:1295-1341`）并 `DROP INDEX IF EXISTS`（`db.js:1293`）。
  - 仓库自己也点过这个问题：`docs/professional-experience-report.md:79`「位置：db.js:297-325（试错式 ALTER + 逐启动全表时间戳归一化 O(n)）。建议引入 schema_version 表」。
- 为什么是问题：启动耗时随「作品总字数 / 事件数」增长；归一化本应是一次性动作（GLOB 条件使其幂等，但代价是每次启动都扫）。
- 用户影响：`chapter_save_versions`（每章 20 份含全文）与 `story_events` 在 300 章规模下是十万行级，每次启动都要扫这几列；配合 `quick_check`（`db.js:23`）启动明显变慢。
- 根因：没有「迁移已执行」的持久标记；用幂等 SQL 取代版本登记。
- 建议方向：加 `schema_migrations(key TEXT PRIMARY KEY, applied_at)`，把归一化与一次性改写（模型名改写 `db.js:1282-1290`）标记为一次性；索引创建保留 `IF NOT EXISTS` 无妨。

### A2-15 ｜裸 `work_id` 表无外键 → 删除作品留下孤儿行（P2 · 已确认）

- 证据（`work_id` 为裸列、无 `REFERENCES works(id)` 的表）：`harness_jobs.work_id`（`db.js:259`）、`author_approvals.work_id`（`db.js:752`）、`adoption_operations.work_id`（`db.js:770`）、`projection_outbox.work_id`（`db.js:783`）、`ov_projection_audit.work_id`（`db.js:800`）、`author_samples.work_id`（`db.js:819`）、`style_profiles.work_id`（`db.js:834`）、`author_intents.work_id`（`db.js:848`）、`branch_sandboxes.work_id`（`db.js:862`）、`branch_candidates.work_id`（`db.js:875`）、`import_rebuild_batches.work_id`（`db.js:916`）、`library_docs.work_id`（`db.js:943`）、`novel_index_*`（13 张，`db.js:984-1130`，连 `work_id` 都没有 FK 且 `library_index` 完全无 `work_id`）。
  - 删除作品的清理只有一处显式补偿：`server.js:8706-8711`（注释说明 `ai_eval_events` 是裸列，「不显式删就会留下孤儿行」→ `purgeEvalEventsOfWork`）。
  - `library_index` 行随 `library_docs` 删除而删（`server.js:7014` `LibraryIndex.removeEntry(doc.id)`）。
- 为什么是问题：删掉一本作品后，`novel_index_*`、`author_samples`、`style_profiles`、`branch_*`、`author_approvals`、`projection_outbox` 等表的行全部留下，且 `novel_index_meta` 的 `work_id` 还是复合主键的一部分 → 若将来复用同一 `id`（AUTOINCREMENT 不会复用，但**恢复备份/换库**会），旧行会被当成新作品的索引。
- 用户影响：库体积与备份体积无谓增长；「作品卡计数/全局统计」类端点可能把孤儿行算进去（`ai_eval_events` 已被专门修过，其它表没有）；`novel_index_*` 孤儿行不会被 `prune` 清掉（`prune` 只按当前 work_id 清理）。
- 根因：派生索引/作者侧表出于「派生数据可重建」的判断省略了 FK，但没有集中式清理入口。
- 建议方向：为这些表加 `ON DELETE CASCADE`（迁移是附加式的，可用触发器兜底：`AFTER DELETE ON works`）或在删除作品处集中清理（参考 `purgeEvalEventsOfWork` 的写法）。

### A2-16 ｜旧内核读取路径的二次复杂度与小 N+1（P2 · 已确认）

- 证据：
  - `store.mjs:130-151` `readForeshadows`：先取全部伏笔行，再**取该作品全部事件**（`:132` `SELECT id, work_id, chapter_id, kind, summary, created_at FROM story_events WHERE work_id = ?`，无 LIMIT）。
  - `store.mjs:160-172` `lastTouchIndex`：对每条伏笔遍历全部事件（`for (const ev of events) if (String(ev.summary||'').includes('#'+row.id))`）→ **O(伏笔×事件)**。
  - `store.mjs:67-74` `chapterIndexOf`：每次调用都 `SELECT id FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC` 取全量章节再 `findIndex` → O(章数)；而 `store.mjs:302/321/327/390/397` 在一次 `applyProposal`/`applyProposalsBatch` 内会调用它 **4–5 次**；`readState`（`:214-225`）每次再读全部 facts/timeline/knowledge/entities/foreshadows+events，`applyProposal` 内调用 **2 次**（`:319`、`:329`）。
- 为什么是问题：旧内核（`story_state_config.enabled=1` 且未开 temporal）的每次提案应用/复核都是 O(事件 + 章数) 且带二次项。
- 用户影响：300 章 / 数千事件下，一次「采纳提案」要读数万行并做二次字符串扫描；批量采纳更明显。
- 根因：为「单一权威读路径」牺牲了增量缓存；`chapterIndexOf` 每次重建章序。
- 建议方向：`readForeshadows` 只取 `kind='foreshadow'` 与必要列；`lastTouchIndex` 预建 `#id → 事件` 映射；`chapterIndexOf` 接受已算好的章序（宿主已有 `chapterIndexMap`，`store.mjs:82-88`）。

### A2-17 ｜上下文缓存版本串每次 get/set 都跑 13 条聚合子查询（P2 · 已确认）

- 证据：
  - 缓存实现：`ai/context/cache.mjs:39-42` `const versionOf = (scope) => `${dataVersion}|${safeExternal(scope)}``；`get()`（`:48`）与 `set()`（`:60`）**都**调用它。
  - `externalVersionOf` 注入点：`server.js:530-546`，其中 `server.js:543` `temporal = StoryState.Temporal.temporalVersionOf(...)`。
  - 该函数体：`context-provider.mjs:428-446` 一条 SQL 内 **13 个子查询**，含 `COUNT(*)`（`story_commits`、`story_chapter_bindings` ×1、`story_state_events`、`story_chapter_revisions` ×2、`story_binding_trust`）与两个 `COALESCE(MAX(...))`。
  - 未启用作品短路返回空串：`context-provider.mjs:425-426` `if (!cfg.enabled) return '';`（默认路径零开销）。
- 为什么是问题：启用时态的作品，每次上下文缓存查询都要扫这几张只增不减的表（`story_chapter_revisions` 见 A2-08）。
- 用户影响：300 章 + 启用时态 → 每次装配都多一次 O(修订数 + 事件数) 的聚合；与 A2-08 叠加会随使用时间变慢。
- 根因：用「COUNT(*) 精确指纹」换取缓存正确性，未用 O(1) 的单调版本号（表里已有 `novel_index_meta` 这类版本位）。
- 建议方向：为时态状态维护一个单调 `version`（写路径自增，读一行），替代 COUNT 聚合。

### A2-18 ｜并发写入防护只有「单进程串行 + WAL/busy_timeout」，无应用层互斥（P2 · 高可信静态推断）

- 证据：
  - Node 单进程 + `DatabaseSync` 同步 API：所有 HTTP 处理在同一事件循环里串行进入 SQLite，天然无写-写竞争（`db.js:16` `new DatabaseSync(...)`）。
  - 多进程/多实例：仅靠 `PRAGMA journal_mode=WAL`（`db.js:18`）与 `busy_timeout=5000`（`db.js:20`），代码里**没有**文件锁、PID 锁或"已有实例在跑"的检测。
  - 还原路径会临时 `PRAGMA foreign_keys = OFF` + `ATTACH`（`server.js:152`、`:164`），期间对全库逐表 `DELETE`/`INSERT ... SELECT`（`server.js:154-162`，在 `withTx` 内）。
  - 多窗口：同一进程内（浏览器多标签），靠 `updated_at` 乐观锁 `_if_updated_at` → 409（`server.js:8666-8669`、`server.js:914-917` 注释）。
- 为什么是问题：若作者或运维同时起两个 `server.js` 指向同一 `data/`（README/脚本鼓励的启动方式不做唯一性检查），两个进程可交错写；`VACUUM INTO` 备份与 `ATTACH` 还原在另一进程写入时行为不可预期（`busy_timeout` 只覆盖锁等待，不覆盖语义冲突）。
- 用户影响：低概率但后果重（还原期间另一实例写入 → 覆盖丢失）。
- 根因：产品定位为单机单实例，未加实例互斥。
- 建议方向：启动时对 `data/` 加独占 PID/锁文件（检测到第二实例即拒绝启动或降级只读）；还原端点要求先停服（`docs/temporal-state-contract.md:60` 已如此建议，代码未强制）。

### A2-19 ｜备份/还原链（**链路本身完整，只有两个边角**）（P3 · 已确认）

- 已确认正常的完整链路（见 §4）：`VACUUM INTO`（`server.js:125`）→ 独立只读进程 `quick_check`（`server.js:136-141`）→ SHA256（`server.js:115-119`）→ 返回 `{path,size,sha256,integrity:'ok'}`（`server.js:129`）；还原前先做 `pre-restore` 安全副本（`server.js:146`），失败整体回滚（`server.js:166-169`）。
- 边角 1：还原**只遍历当前库存在的表**（`server.js:150`），备份中多出的新表不会被恢复（静默为空）→ 跨版本回滚后「新表空」可能被误读为数据丢失；备份缺表时会在 `INSERT ... SELECT` 处报错并整体回滚（这一侧是安全的）。
- 边角 2：`sqlite_sequence` 被显式排除（`server.js:150` 的 `name NOT LIKE 'sqlite_%'`）——因 AUTOINCREMENT 会随显式 id 插入自动上调，实测无风险，但迁移到「AUTOINCREMENT 计数已高于表中最大 id」的库时，新插入 id 会从 max(id)+1 起算（不冲突）。
- 无自动/定时备份：`createDatabaseBackup` 只在 `POST /api/backup`（`server.js:8528-8532`）与还原前调用；`grep setInterval` 未见备份定时器。
- 建议方向：还原前对「备份有、当前库无」的表给出显式提示；提供「每日自动备份 + 保留 N 份」的可选开关。

### A2-20 ｜性能清单：随规模线性/二次增长的查询（P2 · 已确认，逐条给证据）

| # | 位置 | 形态 | 备注 |
|---|---|---|---|
| 1 | `server.js:798-806` | `SELECT * FROM chapters WHERE work_id=?`（无 LIMIT，含 `content`） | 见 A2-05 |
| 2 | `server.js:942-948` | `LIKE '%kw%'` × N 字段 + `SELECT *` + `LIMIT 200` | 见 A2-06 |
| 3 | `ai/novel-index/store.mjs:142/166-170/337-340` | 全量 `story_events` + O(事件×角色) `includes` + 逐行 `DELETE` | 见 A2-07 |
| 4 | `ai/novel-index/store.mjs:383/395-396/414/429/446` | `LIKE '%name%'`（`aliases`/`participants`/`related_entities`/`entities`），**无 FTS、无索引可服务** | `novel_index_*` 只有复合主键，无这些列的前缀索引 |
| 5 | `ai/story-state/store.mjs:130-172` | O(伏笔×事件) + 全量事件 | 见 A2-16 |
| 6 | `ai/story-state/store.mjs:67-74` | 每次全量章节列表（一次流程 4–5 次） | 见 A2-16 |
| 7 | `ai/story-state/temporal/history.mjs:49-59` | 每次归约预取**全部** binding/event/revision | 见 A2-09 |
| 8 | `ai/story-state/temporal/context-provider.mjs:428-446` | 13 条聚合子查询 × 每次缓存 get/set | 见 A2-17 |
| 9 | `db.js:1257-1275` | 启动时 33 条全表时间戳 UPDATE | 见 A2-14 |
| 10 | `ai/story-state/temporal/revision-store.mjs:33` | `latestRevisionOf`：`ORDER BY created_at DESC, id DESC LIMIT 1`，靠 `idx_temporal_revision_chapter(work_id,chapter_id,created_at DESC)`… **但 SQL 只按 `chapter_id` 过滤，走了 `chapter_id` 前缀以外的列序**（索引首列是 `work_id`）→ 可能退化为该章扫描 | 有索引但列序不匹配，建议加 `(chapter_id, created_at DESC)` |
| 11 | `server.js:6255` | `SELECT content FROM chapters WHERE work_id=? AND length(content)>200 ORDER BY position DESC LIMIT 20` | 有 LIMIT，但 `length(content)` 需读全部候选行 |
| 12 | `server.js:3857` | `SELECT * FROM chapters WHERE work_id=? ORDER BY position ASC, id ASC`（导入路径，含全文） | 一次性导入路径，风险可接受 |
- 分页/虚拟化现状：**章节列表无分页**（#1）；`chapter_save_versions` 有保留（10 份/分区）；`app_logs` 有保留（`logger.js:444-457`，`MAX_DB_ROWS` + 天数）；`memory_versions` 有保留（`server.js:1822`）；`story_chapter_revisions`/`chapter_state_snapshots` **无保留**（A2-08）。

### A2-21 ｜检索与 FTS/向量（回答「有没有 embedding / BM25 / FTS」）（P2 · 已确认）

- **向量/embedding：本仓库内不实现**。没有任何 embedding/向量/相似度计算代码（`grep` 在 `ai/`、`server.js` 中无命中）；语义检索整体委派给外部 OpenViking 服务，宿主只做「来源与游标校验 + 文本形状化」：`ai/openviking/recall-meta.mjs`、`ai/library/library-recall.mjs:1-28`（注释明确「网络调用在 openviking-sync.js 的 getLibraryRecall」）。
- **BM25/FTS5：有，但只服务共享资料库**。DDL `db.js:1189`；查询 `ai/library/library-index.mjs:315-318` `SELECT doc_id, bm25(library_index_fts) AS rank FROM library_index_fts WHERE library_index_fts MATCH ? ORDER BY rank LIMIT ?`；分数口径 `q/(1+q)`（`:327-330`）。
- **切块策略**：**不做真实切块**——每篇资料一条轻量记录（`library_index`，`db.js:965-979`），字段为 `title(≤80)`/`summary(≤200)`/`keywords(≤24×12)`/`head_text(前 30 行、≤600 字)`（`library-index.mjs:28-43/183-186`）；FTS tokens 上限 400/篇（`:42/238`）。召回取回窗口为「前 30 行」（`library-recall.mjs:24`）。
- **top-K / 阈值**：资料召回 `maxHits:4`、`overscan:4`、`scoreThreshold:0.40`、单条 300 字（`library-recall.mjs:17-28`，注释给出实测依据 0.443–0.469 vs 0.366 对照）；FTS 候选 `candidateLimit:24`、`maxMatchTokens:12`（`library-index.mjs:33-34`）；`novel_index` 各查询上限 `characterLimit:6 / eventLimit:8 / foreshadowLimit:6 / worldLimit:6 / relationLimit:8 / locationLimit:6 / threadLimit:4`（`novel-index/store.mjs:24-34`）。
- **是否可能检索到「未来章节」**：有**两层**防护，且都以「章序下标」为判据——（a）召回 payload：`context-provider.mjs:373-407` `filterRecallPayloadForCursor`（`future_chapter` / `unindexed` 明确丢弃，`:386-393`；`pendingOnBoundary` 时丢弃本章旧索引内容，`:390-393`）；调用点 `server.js:3094`。（b）通用行过滤：`context-provider.mjs:211-231` `filterRowsByCursor`（`unattributed`/`not_in_order`/`future_chapter` 三类丢弃），调用点 `server.js:2876/7829/7876/7968`。
  - 关键前提：**只有启用 temporal 的作品才有 cursor**（`server.js:570`、`:581`），未启用作品这两层完全不生效（`context-provider.mjs:213/260/377` 的 `!cursor.enabled` 直通）。
- **Canon 与草稿是否区分**：区分，且是多重机制——`story_chapter_bindings.validity`（`pending` 不进可信前缀，`history.mjs:21-22/108-119`）、`chapter_state_snapshots` 只用已确认 `output_state`（`compat.mjs:6`）、候选只写 repair 工作线（`analyzer.mjs:290-299`）、`bridge` 层标题写明「参考资料（非本书事实）」（`docs/host-contract.md:407`）、以及 `pendingOnBoundary` 时不回灌语义索引（`context-provider.mjs:390-393`）。
- 用户影响：**作品自身的全文检索没有 FTS/BM25**（只有 A2-06 的 LIKE）；资料库检索质量与阈值口径明确且有实测依据。
- 建议方向：若要把「作品内检索」做成可扩展能力，复用 D 模块的 bigram + FTS5 方案（`library-index.mjs:189-203`）并对 `chapters` 建同构索引。

### A2-22 ｜Story State 闭环的逐跳实证（**回答 Q3/Q4/Q5 的核心**）（已确认）

**（a）逐跳接线（默认关闭时每跳都会早退，见 A2-04）**

| 跳 | 位置 | 代码事实 |
|---|---|---|
| ① 正文写入口 | `server.js:3842`(import)、`:3993`(demo)、`:4232`(AI 成文)、`:6681`(采纳)、`:8196`(Agent 写回)、`:8501`(恢复版本)、`:8647`(建章带正文)、`:8687`(编辑器保存) | 8 个入口统一调用 `afterTemporalContentSave`；其中 3 个在事务内（见 A2-01） |
| ② 记录修订 + 建 pending 提案 | `server.js:4659-4670` → `service.mjs:251-336` | `recordRevision`（`revision-store.mjs:61-88`，内容寻址去重）→ `supersedePendingBindings`（`:266`）→ `createBinding({validity:'pending'})`（`:308-326`） |
| ③ 排后台分析（不阻塞保存） | `server.js:4668` `scheduleTemporalAnalysis(w,c)` → `:4673-4696`（800ms 防抖、同章去重、`unref`） | 模型调用不在保存请求里 |
| ④ State Extractor | `analysis.mjs:50-105` `analyzeChapter` → `analysis.mjs:79-89` `buildExtractionPrompt` + `generate(...)`（`server.js:4642-4655` 用 `callAI`） | 提示词构造在 `extraction.mjs:47-70`，输出解析 `parseExtractionResponse`（`analysis.mjs:95`） |
| ⑤ State Delta（候选事件） | `service.mjs:569-624` `completeAnalysis` → `insertEvents`（`event-store.mjs:46-96`，事件 id 内容寻址） + `updateBindingProposal`（`event-store.mjs:176-189`） | 只挂到 pending 绑定，**不写正式状态**（`analysis.mjs:8-9` 纪律） |
| ⑥ 一致性校验 | `service.mjs:715` `validateEventSet(...)`（`validation.mjs`：前置条件/证据锚点/文本哈希/叙述类型）+ `reducer.mjs:70-114` `reduceBatchInPlace`（`PRECONDITION_FAILED` 整批回退） | 确定性、不调用模型 |
| ⑦ 提交 | `service.mjs:722-435` `finalizeValidGroup`：章前/章后快照（`:397-407`）→ `createBinding(valid)`（`:409-423`）→ `commitManifest`（HEAD CAS，`worldline-store.mjs:82-87`）→ `copyTrustOverlay`（`:431`） | 单事务（`commitOrRollback`，`service.mjs:125-139`） |
| ⑧ 更新状态 | 状态本身**不落单行**，由 `history.stateAt/reduceThroughIndex` 按提交清单归约（`history.mjs:42-132`）；兼容投影单向刷新旧字段（`compat.mjs:15-49`：`UPDATE characters SET status=...`、`UPDATE character_relations SET relation/description=...`） | 权威来源 = 修订 + 已认可事件 + 提交清单 + 章序 |
| ⑨ 下游失效 | `service.mjs:432-435` `markDownstreamStale({...})` → `impact.mjs:145-149` → `applyInvalidationPlan`（写 `story_binding_trust` 提交级覆盖，`impact.mjs:109-121`） | 保守：`from_index` 之后所有绑定先 stale（`impact.mjs:52-81`） |
| ⑩ 依赖入索引 | `service.mjs:437` `recordDependencies` → `dependencies.mjs:69-87` | 由 `op.expected` 确定性提取，**不用于排除**（`dependencies.mjs:8-9`） |
| ⑪ 影响复核（T3） | 确认后 `server.js:5855/5902/6052` `scheduleTemporalImpact` → `runTemporalImpact`（`:4717-4727`）→ `analyzer.mjs:535` `runImpactAnalysis` | 需 `auto_analysis` 开（`server.js:4737`）；`writer` 不传入 → **不生成正文**，`totals.generated_revisions: 0` 硬编码（`analyzer.mjs:662/664`） |
| ⑫ 重建（T4） | `server.js:5974/5991/6009/6023` → `runner.mjs`（`startRepairRun`/`resume`/`apply`/`revert`）；`apply` 原子切换正式正文，`markDownstreamStale` 在 `runner.mjs:721/802` | 作者按钮 + 一次性审批（`repair_run_start`/`repair_run_apply`） |

**（b）Temporal 开关默认值**：`db.js:371-373` 三列 `DEFAULT 0`；`config.mjs:22-31` 读取；`server.js:5675-5703` 写开关（模型侧 403，`:5676`），启用前跑迁移门禁（`server.js:5683-5687`，缺表/索引 → 503）。

**（c）默认关闭时**：① `recordContentSave` 立即返回 `enabled:false`，零写入（`service.mjs:255`）；② 上下文走旧路径（`server.js:570`/`:581` 判 `isTemporalEnabled`，`cursor=null`）；③ 章末状态面板返回 `enabled:false`（`service.mjs:456`）；④ 影响复核与重建不触发（`server.js:4735`）；⑤ ……**但写前预检/写后校验同样不跑**（`server.js:6194`/`:6222` 前置旧内核 `isEnabled`，新作品该值为 1，时态值为 0 → 预检/校验走旧内核）——这正是 A2-04 的核心。

**（d）Story State 是否进入 AI Context（Q4 完整路径）**：`server.js:3244-3273` →
- 启用 temporal：`buildTemporalStoryStateLayer({cursor})`（`context-provider.mjs:314-357`，渲染角色状态/关系/剧情线/伏笔/知识边界/披露/其它事实/作者计划）→ 推入 `L('story_state', ...)`（`server.js:3251`），受层 cap 2400（`ai/context/layers.mjs:81`）与总预算约束（装配器 `ai/context/assembler.mjs`）。
- 未启用 temporal 但开启旧内核：`StoryState.compositionOf(workId, chapter.id)`（`index.mjs:54-90`，只读）→ `storyStateLayerOf`（`index.mjs:98-153`，`visibleOnly` 过滤未来：`semantic-context.mjs:147-157`）→ 同一层 `server.js:3262`。
- 层被裁剪但可查回：`ai/context/layers.mjs:131`（`story_state` → `novel_state` 工具 / `GET /api/novel/story_state`）。
- 未开启任何开关：`compositionOf` 返回 `null`（`index.mjs:57`）→ 层为空且**不新增查询**（默认路径零开销）。

**（e）旧章节修改后的依赖失效（Q5 结论）**：算法是**保守全量下游**（非依赖图裁剪）：
- 计划：`impact.mjs:28-91`；下游取「章序版本中 `from_index` 之后的全部章节」（`:52-55`），依赖命中只写进 `explicit_dependency` 用于解释与排序（`:71-80`，模块头 `:4-9` 明确「不得用于排除」）。
- 应用：`impact.mjs:93-143` 写 `story_binding_trust`（有 commit 时）或直接改 `binding.validity`（无 commit 时）。
- **调用点（生产）**：`service.mjs:432`（每次确认）、`ai/repair/runner.mjs:721`（重建保留章）、`ai/repair/runner.mjs:802`（重建修订章）。
- **未接线的部分**：`earliestOrderDifference`（章序变化，A2-02）；`applyInvalidationPlan`/`invalidationPlan` 的**直接**生产调用为 0（只被 `markDownstreamStale` 与测试调用）。

### A2-23 ｜`docs/story-state-kernel-2026-09-26.md` 与现状的漂移（P3 · 已确认）

- 证据：该文档 `:49` 仍写「`HOST_CONTRACT_VERSION = '1.1.0'`」，而实际为 `server.js:1112` `const HOST_CONTRACT_VERSION = '1.19.0';`（与 `docs/host-contract.md:9` 一致）。文档定位是「阶段快照」而非活契约，但文件名与 `docs/README.md` 的索引方式容易让读者把它当现行契约。
- 建议方向：在文档头部标注「历史快照 · 截至 1.1.0，现行契约见 host-contract.md / .v1.json」。

### A2-24 ｜默认路径上的固定开销：未开启的每次保存仍跑 schema 探测 + 开关查询（P3 · 已确认）

- 证据：
  - 写入口**不先判开关**：`server.js:4663` `const result = StoryState.Temporal.recordContentSave({...})`（`afterTemporalContentSave` 内无 `isTemporalEnabled` 前置；与之对比，`scheduleTemporalImpact` 明确先判，`server.js:4735`）。
  - 开关判定在函数内部、且**先探测 schema**：`service.mjs:36-40` `function guard(workId) { const schema = assertTemporalSchema(); if (!schema.ok) throw ...; return isTemporalEnabled(workId); }`；`assertTemporalSchema` 每次执行 `SELECT name FROM sqlite_master WHERE type='table'`（`config.mjs:72`），`isTemporalEnabled` 再查一行（`config.mjs:16`）；随后 `service.mjs:255` 才返回 `{enabled:false, ...}`。
- 为什么是问题：这条路径在**默认（未开启）**配置下也每次正文保存都执行——`sqlite_master` 现约 130+ 对象（73 表 + 48 索引 + shadow 表），属固定但无收益的开销；更值得注意的是顺序：schema 探测在开关之前，因此**未开启的作品也会因表缺失而抛 `TEMPORAL_SCHEMA_MISSING`**（严格说这是"响亮失败"的设计，但对一个明确关闭了引擎的作品，抛错语义可疑）。
- 用户影响：800ms 自动保存路径每次多 2 次查询；若库处于"有开关行但表被外部删除"的异常状态，关闭引擎的作品保存会失败（与 A2-01 叠加时会变成"正文已写、请求报错"）。
- 根因：把「schema 自检」放在 guard 的第一位，且写入口未做开关前置短路。
- 建议方向：`if (!isTemporalEnabled(w)) return {enabled:false}` 放在 `assertTemporalSchema()` 之前（或调用方前置）；schema 探测结果按进程缓存（DDL 不变）。

---

## 4. 确认正常、**不是问题**的部分（必须一并向审计委员会报告）

1. **schema 与契约的表清单完全对齐（72/72）**：`db.js` 实际建的 72 张业务表与 `host-contract.v1.json` 的 `db.tables` 一一对应，无「声明未建」；唯一多出的是可选 FTS 虚表（A2-11）。已由我实跑 `.p1-baseline/test-migration-idempotent.mjs`（A1/A2）与 `test-host-contract.mjs` 双重复核（均通过）。
2. **迁移幂等与损坏库处理正确**：空库 72 表全建；重复启动 schema 指纹一致（`test-migration-idempotent.mjs` B2）；旧库只读指纹 = 契约冻结值 `3cb7e5d9ac4f67b9`（C2 通过）；损坏库**响亮失败且字节不变**（`db.js:22-28` + D1/D2/D3）。`ALTER` 只吞 `duplicate column`、其余告警（`db.js:1231-1237`）。
3. **事务原语正确且能嵌套**：`db.js:36-61` 深度感知（外层 `BEGIN`，内层 `SAVEPOINT sp_N`），并额外认 SQLite 自动提交状态（`db.isTransaction`）以兼容历史 `db.exec('BEGIN')` 路径；注释里记录了 2026-09-27 的实际缺陷与 2026-09-30 的复测（`db.js:30-41`）。R03「整次采纳」的原子性（正文 + 提案 + 审批消费 + outbox 同事务，`server.js:6638`、`:8183`）与 `applyProposal` 单事务（`store.mjs:309-345`，失败整体回滚并落 stale）已确认。
4. **审批边界是真边界、不是口头纪律**：模型侧身份靠每进程随机能力令牌（`server.js:179-191`），作者通道才可创建审批（`server.js:195-198`），消费与写入同事务（`service.mjs:142-150`、`:380-385`），绑定/基线/过期/跨书逐项校验（`service.mjs:102-122`），且「过期标记必须提交」的顺序缺陷已修（`server.js:218-223`）。
5. **备份/还原链路完整**：`VACUUM INTO`（一致性备份，不是拷单文件）+ 独立只读进程 `quick_check` + SHA256 + 还原前 `pre-restore` 安全副本 + 失败整体回滚 + FTS rebuild（`server.js:120-171`）；与 `temporal-state-contract.md:60` 的建议一致。另：日志与记忆版本**有**保留策略（`logger.js:444-469`；`server.js:1822`），`chapter_save_versions` **有**10 份/分区保留（`server.js:1554-1576`）。
6. **「未来数据泄漏」两道机械防线存在且可验证**：`effective_from/effective_to` 窗口过滤（`semantic-context.mjs:147-157`）+ 章序下标过滤（`context-provider.mjs:211-231/373-407`），`fail-closed`（章序不可定位时 `lastVisibleIndex=-1`，`context-provider.mjs:155-158`），并有 `timeline_leaks`/`inversions` 上报（`index.mjs:145-146/178-179`）。
7. **提案≠事实的隔离在三条链路上都成立**：时态（pending 不进可信前缀）、旧内核（`story_state_proposals` 需 `applyProposal` + 快照）、沙盘候选（只写蓝图/契约建议）、资料库（canon 记 reference）、样文（`ai/style/store.mjs:6-7` 明令不写事实表）。已确认无一处例外。
8. **时态离线总入口通过**：`scripts/test-temporal-refactor.mjs`（reducer/原子归约/章序/历史隔离/完整性/保存接线，自托管隔离实例 + 本机假模型）实跑 ✓（69480ms，零计费）。

---

## 5. 未能证实（不得当作已确认结论）

1. **真实作品库的规模与增长速率**：300 章 / 50 万字场景下的实际行数、修订数、库体积、启动耗时**未实测**（被禁止读 `data/`）。A2-08/A2-09/A2-14/A2-17 的「用户影响」是按代码复杂度与常量推导的**高可信静态推断**，不是实测数字。
2. **`max_chapters=200` 截断的真实触发率**：取决于作者的根章位置与章数；我只证明了「300 章、根在第 50 章时会漏 50 章且报告不显示」，**未跑**真实规模的影响分析（需模型与真实库）。
3. **重排章节后的实际错位表现**（A2-02）：我证明了 `earliestOrderDifference` 无生产调用，**未构造**「拖拽章节 → 新提交 → 状态错位」的端到端复现（需要在隔离实例里造 300 章并做 UI 级操作）。
4. **多进程并发写入的实际冲突行为**（A2-18）：未起两个实例对同一目录做对写压力测试；`busy_timeout=5000` 是否足够、WAL 下 `ATTACH`+全表替换是否会被另一写入者破坏，均**未验证**。
5. **时态端点未进 fixture 是否有意为之**：`docs/host-contract.md:25` 写「不在插件白名单内」，但「不变条件②」把端点面定义为 fixture 白名单——**两处措辞都无法判定**这是「有意排除」还是「漏登记」。我按漂移报告，但请以作者确认为准。
6. **`HOST_CONTRACT_VERSION` 与 `docs/story-state-kernel-2026-09-26.md` 的历史快照定位**：该文档是否已被明确标记为历史件，未在 `docs/README.md` 中验证（我只读了该文件本身与该行）。
7. **`.p1-baseline/data/novel.db` 的性质**：该文件存在且被仓库自带测试只读打开（见 §0.3 披露）；它是「旧库副本」还是含作者数据，我**未读取内容**，故无法判定。
8. **`works.updated_at` 是否在所有写入路径都被推进**（A2-07 的前提）：我确认了正文保存路径（`server.js:8689`）与多处 `touchWork`，但**未穷举**全部写入路径（例如某些 AI 任务/导入是否绕过 `touchWork`）。
9. **`node:sqlite` 的默认 `synchronous` 值**：代码未设置该 PRAGMA，我按 SQLite 默认（FULL）推断，**未实测** `PRAGMA synchronous` 的运行时取值。
10. **A2-06 中 `LIKE '%kw%'` 的实际耗时**：未在 300 章合成数据上跑基准（`scripts/perf-temporal-baseline.mjs` 存在，但它测的是时态保存/查询路径，不是 `/api/search`）。

---

## 附：本次审计中「回答清单」与发现的对应关系

| 问题 | 结论落点 |
|---|---|
| 1 schema/索引/FK/唯一约束/PRAGMA | §2.1–2.3 |
| 2 各实体存储位置（结构化 vs blob vs 长文本） | §2.4 |
| 3 是否真实闭环 + 默认值 + 默认关闭的影响 | A2-22、A2-04、A2-02、A2-03 |
| 4 是否进入 AI Context + 完整路径 | A2-22(d)、A2-17 |
| 5 依赖失效算法 / stale 是否真被调用 | A2-22(e)、A2-02、A2-03 |
| 6 自动保存频率与单位 / 原子性 / 崩溃恢复 / 备份 / 校验 / 还原 / 并发 / 迁移 | A2-01、A2-14、A2-18、A2-19、§4.3、§4.5 |
| 7 规模与性能（线性/二次查询、分页、FTS 更新时机） | A2-20、A2-05、A2-07、A2-16、A2-17、A2-08、A2-09 |
| 8 全文搜索 / embedding / BM25 / 未来章节 / Canon | A2-21、A2-06 |
| 9 契约漂移 | A2-10(表) 、A2-11、A2-12、A2-13、A2-23 |
| 10 定义未调用 / 早退短路 / 注释不符 / 常量不符 | A2-10、A2-13、A2-04（早退）、A2-03（静默截断） |
| 11 确认不是问题 | §4 |

---

## 6. 主报告合并专用：三张精确清单（对应合并请求的三问）

### 6.1 `db.js` 结论卡（表清单 / 索引 / 迁移幂等 / 外键 / FTS / 关键列问答）

- **表清单**：`db.js` 实际建 **73** 张（72 业务表 + 1 FTS5 虚表 `library_index_fts`）。与 `docs/host-contract.v1.json` 的 `db.tables`（72）逐表对账：**声明未建 = 0**，**建未声明 = `library_index_fts`**（A2-11）。`db.frozen_tables` = 25 张，`db.tables_added_in_v1_{1,3,4,5,7,9,10,11,12,13}` = 46 项，均在库中。
- **FTS 是否真的存在、建在哪**：存在，**只有一张**，且**只服务共享资料库**：
  - DDL：`db.js:1189` `CREATE VIRTUAL TABLE IF NOT EXISTS library_index_fts USING fts5(tokens, doc_id UNINDEXED, tokenize='unicode61');`（**单列 `tokens` + `doc_id`，不带 external content，无触发器**）
  - 建表放在**独立 try/catch**：`db.js:1188-1192`（缺 FTS5 只 `console.warn`，不阻断启动）
  - 写入/删除由应用层手工同步：`ai/library/library-index.mjs:237-239`（先 `DELETE ... WHERE doc_id=?` 再 `INSERT (tokens, doc_id)`，tokens 为 JS 侧中文 bigram + 英文词，空格 join）、`:251`（删主行时同步删 FTS 行）
  - 查询：`ai/library/library-index.mjs:315-318`（`bm25(library_index_fts)` + `MATCH` + `ORDER BY rank LIMIT ?`）
  - 还原后重建：`server.js:165` `INSERT INTO library_index_fts(library_index_fts) VALUES ('rebuild')`
  - **作品正文没有任何 FTS 对象**（`grep -rn "fts5" db.js` 只有这一处）。
- **索引**：常规 `CREATE INDEX IF NOT EXISTS` **48 条**（主块 `db.js:269/571/601/616/633/649/669/670/686/699/700/724/742/764/794/813/829/843/856/872/893/894/912/934/935/959/960/980`，汇总块 `db.js:1296-1341`）+ 6 条特殊唯一/部分索引（`db.js:586/795/1347/1356/1357/1358`）。启动时 `DROP INDEX IF EXISTS idx_plotline_characters_plotline`（`db.js:1293`）。
- **迁移幂等**：**是**——`CREATE TABLE IF NOT EXISTS` + 36 条 `ALTER TABLE ADD COLUMN`，只吞 `duplicate column`、其余 `console.warn`（`db.js:1195-1237`）；时间戳归一化用 `GLOB '????-??-?? ??:??:??'` 幂等 UPDATE（`db.js:1269-1275`）；模型名一次性改写（`db.js:1282-1290`）。**但没有 host 侧 `schema_version` 表**（A2-14），因此每次启动都重跑这些幂等语句。已实测：重复启动 schema 指纹一致、旧库只读指纹 = `3cb7e5d9ac4f67b9`、损坏库响亮失败且字节不变（`test-migration-idempotent.mjs` B2/C2/D1-D3 通过）。
- **外键**：`PRAGMA foreign_keys = ON`（`db.js:19`）确实生效；作品域主表普遍 `ON DELETE CASCADE`，但 **13+ 张表用裸 `work_id`**（列表见 A2-15），删除作品会留孤儿行。
- **`story_timeline_entries` 是否有 location/participants/cause/consequence/confidence**：**都没有**。它的全部列为：`id, work_id, chapter_id, event_id, chapter_index, scene_index, seq, story_time, relative_time, day_offset, effective_from, effective_to, before_event_id, after_event_id, kind, label, payload, source, created_at, updated_at`（`db.js:382-403`）。因果只用 **id 引用**表达（`before_event_id`/`after_event_id`），时间用 `story_time`/`relative_time`/`day_offset`，可见窗口用 `effective_from`/`effective_to`。
  - 这套词汇实际落在**派生索引层 E 模块**：`novel_index_events(location, participants, time_text, causal_parent, consequences, type, status)`（`db.js:998-1012`）、`novel_index_threads.participants`（`db.js:1068`）、`novel_index_items.location`（`db.js:1082`）、`novel_index_chapters.participants`（`db.js:1095`）、`novel_index_world.entities/applies_to/exceptions/hard_or_soft`（`db.js:1028-1032`）、`novel_index_knowledge.confidence`（`db.js:1119`）；正典事实的置信度在 `story_facts.confidence REAL NOT NULL DEFAULT 1`（`db.js:425`）。

### 6.2 temporal 引擎默认关闭（`story_state_config.temporal_enabled=0` 等三列默认 0）时，**实际不生效**的能力（精确到调用点）

**A. 每个入口的早退点（返回 `enabled:false`，零写入）**

| 能力 | 判定点 | 关闭时的行为 |
|---|---|---|
| 保存后处理（revision + pending 提案） | `service.mjs:37-39` guard → `:255` | `{enabled:false, recorded:false}`，**不写一行** |
| 作者确认事件集 | `service.mjs:351` | `disabled` |
| 章末状态面板 | `service.mjs:456` | `enabled:false` |
| 历史状态查询 `stateAtChapter` | `service.mjs:464` | `enabled:false` |
| 引擎总览 `temporalOverview` | `service.mjs:476`（`config.enabled && schema.ok`） | head/trust/commits 全 `null`/`[]` |
| 分析目标 `analysisTarget` | `service.mjs:504` | `enabled:false` → `analysis.mjs:52` 直接返回，**不消耗模型** |
| 分析上下文 `analysisContext` | 经 `analysisTarget`（`service.mjs:519`） | 同上 |
| 开始/完成/失败分析 | `service.mjs:542 / :573 / :630` | 全部 `enabled:false` |
| 确认提案组 `confirmBinding` | `service.mjs:668` | `enabled:false` |
| 作者更正 `correctAuthorState` | `service.mjs:743` | `enabled:false` |
| 影响复核 `runImpactAnalysis` | `analyzer.mjs:545` | `{enabled:false}`，零写入 |
| 逐章重建 `startRepairRun` 等 | `runner.mjs:118` | 零写入 |
| 存量回填 4 个入口 | `migration.mjs:275 / :356 / :481 / :544` | 零写入（`backfillStatus`/`enableScope` 只读仍可用：`:235 / :251`） |

**B. 宿主侧门控（不生效的具体功能）**

| 不生效的能力 | 门控位置 | 关闭时的实际路径 |
|---|---|---|
| 时态上下文 cursor（章前/章后、世界线、提交、POV） | `server.js:570`、`context-provider.mjs:102/123` | `cursor=null` → 走旧装配路径 |
| `story_state` 层由 temporal provider 渲染 | `server.js:3249`（`cursorUsable` 分支） | 落到 `server.js:3258` 旧内核 `compositionOf` |
| 工具查询的「截至该章」过滤（events/foreshadows/consistency/search） | `server.js:581`（`temporalToolCursorOf`） | 返回旧形状，不做游标过滤（`server.js:2876/7829/7876/7968` 均不生效） |
| 语义召回的时态过滤（未来章/未确认索引） | `server.js:3094` `filterRecallPayloadForCursor` | 不调用 |
| 确认后自动下游复核 | `server.js:4735`（`isTemporalEnabled`）+ `:4737`（`auto_analysis`） | 不调度；`scheduleTemporalImpact` 直接 return null |
| 旧入口互锁（角色状态/关系直写 → 命令化） | `server.js:4759` | 旧字段**仍是可直写的第二来源**（与 `temporal-state-contract.md:55-56` 的承诺相反） |
| 时态状态进入上下文缓存外部版本串 | `server.js:543` → `context-provider.mjs:426` | 返回 `''` → 缓存不跟踪时态状态 |
| 写前预检 / 写后校验（**注意**） | `server.js:6194` / `:6222` 前置**旧内核** `isEnabled` | 新作品 `enabled=1` 但 `temporal_enabled=0` → 预检/校验走旧内核；时态校验器 `validation.mjs` 完全不用（A2-04） |
| 保存时的 schema 探测 + 开关查询（**仍会跑**） | `service.mjs:37-40`（被 `server.js:4663` 无条件调用） | 每次保存多 2 次查询（A2-24） |

**C. 关闭时仍然生效、且已确认无第二写入源的部分**：`refreshPendingContext`（`service.mjs:208`，无内部 guard）只被 `beginAnalysis`（已 guard，`:541-554`）与 `migration.mjs:306/578`（已被 `:275/:356` guard 拦住）调用 → **不存在绕过开关的写入路径**（已逐个 grep 复核）。

### 6.3 随作品规模线性/二次增长的查询（含索引可服务性判定）

| # | 位置 | 语句形态 | 复杂度 | 索引可服务性 |
|---|---|---|---|---|
| 1 | `server.js:803` | `SELECT * FROM chapters WHERE work_id=? ORDER BY position ASC,id ASC`（**无 LIMIT**，含 `content`） | O(章数)，且传输全部正文 | `idx_chapters_work` 可服务过滤与排序，但正文搬运无法避免 |
| 2 | `server.js:946` | `SELECT * FROM ${table} WHERE (f LIKE '%kw%' OR …) … LIMIT 200`（`chapters.content` 在内） | 全表扫描 × 关键词数 | **不可服务**（`%` 前缀通配） |
| 3 | `ai/novel-index/store.mjs:142` | `SELECT * FROM story_events WHERE work_id=? ORDER BY id ASC` | O(事件数) 每重建 | `idx_story_events_work(work_id, created_at DESC)` 可服务过滤，排序列不同需排序 |
| 4 | `ai/novel-index/store.mjs:166-170` | 事件 × 角色 `summary.includes(name)`（JS 层） | **O(事件×角色)** | 与索引无关（内存二次循环） |
| 5 | `ai/novel-index/store.mjs:337-340` | `prune`：先 `SELECT key` 全表，再逐行 `DELETE` | O(行数) 条语句 | 逐行删除，无批量 |
| 6 | `ai/novel-index/store.mjs:383/395/414/429/446` | `aliases LIKE '%n%'`、`participants LIKE ?`、`related_entities LIKE ?`、`entities LIKE ?`、`c.name=? OR c.aliases LIKE ?` | 全扫描 + JOIN | **不可服务**（这些列无独立索引） |
| 7 | `ai/story-state/store.mjs:132` | `SELECT id,work_id,chapter_id,kind,summary,created_at FROM story_events WHERE work_id=?`（无 LIMIT） | O(事件数) 每次读状态 | `idx_story_events_work` 可服务过滤 |
| 8 | `ai/story-state/store.mjs:166-170` | 伏笔 × 全量事件 `includes('#'+id)`（JS 层） | **O(伏笔×事件)** | 与索引无关 |
| 9 | `ai/story-state/store.mjs:71` | `SELECT id FROM chapters WHERE work_id=? ORDER BY position ASC,id ASC` + `findIndex` | O(章数) **每次调用**（一次提案流程 4–5 次） | `idx_chapters_work` 可服务，但重复执行 |
| 10 | `ai/story-state/temporal/history.mjs:49-59` | 预取该提交**全部** binding/event/revision（分块 IN） | O(全书事件) 每次状态查询 | 主键 IN 可服务，但量为全书 |
| 11 | `ai/story-state/temporal/context-provider.mjs:428-446` | 单 SQL 内 13 个子查询（含 5 处 `COUNT(*)`、3 处 `MAX`） | O(修订+事件+绑定) **每次缓存 get/set** | 各表索引可服务过滤，但聚合量随规模增长 |
| 12 | `db.js:1272` | `UPDATE ${table} SET ${col}=… WHERE ${col} GLOB '????-??-?? ??:??:??'` × 33 列 | 每次启动全表扫描 | **不可服务**（GLOB 前缀固定但仍是列扫描） |
| 13 | `ai/story-state/temporal/revision-store.mjs:33` | `WHERE chapter_id=? ORDER BY created_at DESC,id DESC LIMIT 1` | 单章内扫描 | ⚠ 现有索引是 `(work_id, chapter_id, created_at DESC)`，SQL 未带 `work_id` → 首列不匹配，可能退化为扫描；建议加 `(chapter_id, created_at DESC)` |
| 14 | `server.js:6255` | `SELECT content FROM chapters WHERE work_id=? AND length(content)>200 ORDER BY position DESC LIMIT 20` | 需读全部候选行算 `length()` | 过滤列是函数，不可服务 |
| 15 | `server.js:3857` | `SELECT * FROM chapters WHERE work_id=? ORDER BY position ASC,id ASC`（导入路径） | O(章数) + 全部正文 | 一次性路径，风险可接受 |
| 16 | `ai/library/library-index.mjs:315-318` | FTS5 `MATCH` + `bm25()` + `LIMIT 24` | 有界（`candidateLimit:24`） | **FTS 索引可服务**（对比项 2） |

**分页/虚拟化现状**：章节列表**无分页**（#1）；`chapter_save_versions`（10 份/分区，`server.js:1554-1576`）、`app_logs`（`logger.js:444-457`）、`memory_versions`（`server.js:1822`）**有**保留策略；`story_chapter_revisions` / `chapter_state_snapshots` / `story_state_events` / `story_snapshots` / `story_chapter_bindings` **无任何删除路径**（A2-08）。

