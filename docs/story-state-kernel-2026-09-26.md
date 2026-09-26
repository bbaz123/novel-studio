# 第四步交付报告：小说工坊 · 确定性故事状态内核（story-state）

- 日期：**2026-09-26**
- 分支：`refactor/p0-p6`（工作副本）
- Host Contract：**1.0.0 → 1.1.0**（附加式；见 `docs/host-contract-1.1-2026-09-26.md`）
- 一句话结论：**新增能力全部门控、默认关闭；未开启时与 1.0.0 逐字节一致（50/50）；开启时才多一层「故事状态」上下文。**

## 0. 方法与纪律（先说清楚"凭什么说没伤质量"）

本轮按"真实代码扫描 → 基线 → 修改 → 测试 → 生成质量回归"执行，最重要的三条证据：

1. **逐字节上下文基线 50/50**：改动后重新采样压力数据的全部 50 个用例，与 pre-V2 基线逐字节相同（`compare-baseline.mjs` → IDENTICAL）。
2. **门控关闭 = 行为不变**：既有作品 `story_state_config.enabled` 默认 `0`；未开启时该层既不在 `manifest`，也不在 `excluded`，`story_state` 字段恒为 `null`，可执行下限 `floor(settings)=18173` 与冻结值一致。
3. **开启时的结构性不变量**（活实例实测）：层列表恰好插入 1 层且位置紧邻 `redlines` 之前；其余各层 `emitted` 逐层相同（未挤压、未重排、未改写任何既有层）；`context_integrity` 仍为 `PASS`。

本轮**没有**改：模型、reasoning effort、prompt 语义、TOTAL_BUDGET / 各层 cap / FLEX_ORDER、默认 AI route、默认生成路径。

## 1. 实际修改文件

### 1.1 新增（生产代码）

| 文件 | 作用 |
|---|---|
| `ai/story-state/hash.mjs` | 稳定序列化 + 状态哈希（`stateHashOf` / `stateHashDetail` / `contractHashOf`；**不含 id/时间戳**，否则陈旧检查永远为红） |
| `ai/story-state/timeline.mjs` | 时间线比较 / 可见性 / 未来泄漏 / 顺序倒置 / 相对时间解析 / 时间线视图 |
| `ai/story-state/knowledge.mjs` | 三档 knowledge scope × 四态 + 越界检测（角色不该知道的事） |
| `ai/story-state/entities.mjs` | 实体与别名索引 / 解析 / 提及 / 冲突 / 合并-拆分-改名预案 |
| `ai/story-state/canon.mjs` | 正典投影 + 冲突分级（五级）+ 自动可修白名单 |
| `ai/story-state/foreshadow.mjs` | 伏笔**九态派生**（不改宿主 `foreshadow_status` 语义） |
| `ai/story-state/contract.mjs` | 章节契约 11 字段组 + 渲染（`unknown` 是一等公民） |
| `ai/story-state/state-machine.mjs` | 18 相位流程状态机（映射回宿主 `queued/running/done/failed/timeout/cancelled`） |
| `ai/story-state/injection.mjs` | DATA 围栏 + 11 条注入模式（**只记录不拦截**） |
| `ai/story-state/semantic-context.mjs` | 6 条优先级带 + `story_state` 子块（带序不参与裁剪） |
| `ai/story-state/style-quality.mjs` | 描述性风格指标（**不驱动改写**） |
| `ai/story-state/proposal.mjs` | 提案构建 / 陈旧检查 / 应用计划 / 回滚计划 / 复核 |
| `ai/story-state/preflight.mjs` | 写前预检编排 |
| `ai/story-state/store.mjs` | 全部 SQL + 单事务执行（apply / rollback） |
| `ai/story-state/index.mjs` | 门面：`compositionOf` / `storyStateLayerOf` / `preflightOf` / `validateOf` + `STORY_STATE_VERSION` |

合计 **15 个文件 / 约 180 KB / 174 个导出**。

### 1.2 修改（共享文件，行为改动都在这几处）

| 文件 | 改动 |
|---|---|
| `db.js` | 追加 10 张表 + 16 个索引（13 普通 + 3 条件唯一），全附加式 |
| `ai/context/layers.mjs` | 新增第 15 层 `story_state`（`gated: true`、cap 2400、排在 `redlines` 之前）；`computeFloor(mode,{includeGated=false})` 默认不计入门控层；补 `RETRIEVAL` / `PROVENANCE` |
| `ai/context/assembler.mjs` | `excluded` 过滤 `gated`（未开启时它不属于这套层） |
| `server.js` | 门控构造故事状态层（异常只 `warn` 不打挂生成）；响应加 `story_state` 字段；新增 `handleStoryStateRoute`（17 条端点）；`HOST_CONTRACT_VERSION = '1.1.0'`；提案应用/回滚后 `touchWork` 失效上下文缓存 |
| `harness-plugins/novel-writing/novel-tools.mjs` | 新增 8 个工具（共 23）；`PLUGIN_VERSION` → `0.10.0` |
| `harness-plugins/novel-writing/plugin.json` | `version 0.10.0`；tools 23 / engineEndpoints 43 |
| `harness-plugins/novel-writing/package.json` | 版本对齐 0.10.0 |
| `harness-plugins/novel-writing/ENGINE.md` | 追加"确定性故事状态"章节 |
| `.p1-baseline/test-story-state-api.mjs` | 新增端到端测试（59 项，自建作品自清理） |
| `.p1-baseline/test-host-contract.mjs` | 升 1.1.0；新增门控层边界检查（C-5b） |
| `.p1-baseline/test-context-manifest.mjs` | 门控层不参与 `excluded` 的期望值修正 + 新增一条断言 |
| `.p1-baseline/verify-all.mjs` | 登记新的端到端测试 |
| `.p1-baseline/verify-phase-map.mjs` | 登记本轮阶段（Z3） |
| `docs/host-contract.md` / `docs/host-contract.v1.json` | 契约升 1.1.0（层 15 / 表 35 / 工具 23 / 端点 43 + 变更记录） |

## 2. 数据库 migration（只增不减）

| 项 | 实测 |
|---|---|
| 表 | 25 → **35**（+10：`story_state_config`、`story_timeline_entries`、`story_facts`、`character_knowledge`、`story_entities`、`story_entity_aliases`、`chapter_contracts`、`story_state_proposals`、`story_snapshots`、`story_validations`） |
| 索引 | +16（13 普通 + 3 条件唯一：`idx_story_facts_dedup_uq`、`idx_char_knowledge_key_uq`、`idx_chapter_contracts_version_uq`） |
| 风格 | `CREATE TABLE IF NOT EXISTS` + `try ALTER TABLE ... ADD COLUMN`；**无** DROP / RENAME / DELETE |
| 旧库兼容 | 旧库副本 `sqlite_master` 指纹 `3cb7e5d9ac4f67b9` 前后一致；`db.frozen_tables` 的 25 张表全部仍在 |
| 默认值 | `story_state_config.enabled` 对既有作品为 `0`（= 行为与 1.0.0 完全一致） |

## 3. 状态机与工作流

- **18 相位**（`state-machine.mjs`）是**内核内部**流程相位；对外的作业状态词仍是宿主的 `queued / running / done / failed / timeout / cancelled`（契约 §2 未变）。
- 工作流：`预检 → 写作 → 校验 → 提案 → 审核 → 应用 → 快照/回滚`。
- **提案不直接改状态**：`buildProposal` 只登记；应用才写，且走**单事务** + 状态哈希陈旧检查（`base_state_hash` 不一致 → `decision: 'stale'`，**不覆盖**）。
- **回滚不删行**：新增行标 `superseded`，改过的改回取值；回滚前自动留 `pre-rellback` 快照。
- **插件编排**：`novel_write_pipeline` 只编排（预检→写作→校验→提案），**不自己生成正文**、不新增第二条上下文来源。
- **注入防护只记录不拦截**（`injection.mjs`）：预检/校验会把可疑指令报出来，但不阻断作者写作。

## 4. 上下文接入（门控层）

| 项 | 值 |
|---|---|
| 层 id / 标签 | `story_state` / 故事状态（正典/时间线/契约/知识边界） |
| kind / cap / 位置 | `cond` / 2400 / 紧邻 `redlines` **之前** |
| 门控 | `gated: true`；未开启时**不进 manifest、不进 excluded、不计入下限** |
| 下限 | `floor(settings) = 18173`（未开门控，与 1.0.0 一致）；`floor(full,{includeGated:true}) = 21364` |
| 渲染顺序 | 正典切片 → 本章契约 → 时间线 →（知识/伏笔/硬规则） |
| 溯源与查回 | `source = story_facts + story_timeline_entries + chapter_contracts + character_knowledge + story_entities`；`recoveryPath → novel_state / GET /api/novel/story_state` |

**开启后的真实渲染样本**（活实例，层 `emitted=152`，`truncated=false`，`integrity=PASS`）：

```
【故事状态（正典/时间线/契约/知识边界）】
〔正典切片（当前成立的事实）〕
潮汐钟｜状态：被敲响三次
林晚｜位置：雾港码头

〔本章契约〕
本章目标：林晚在雾港码头拿到潮汐钟的钥匙
必须写到的情节点：
  · 码头重逢
  · 拿到钥匙
禁止出现的情节点：
  · 林晚死亡
必须出场：
  · 林晚
  · 潮汐钟
验收项：
  · 结尾留下悬念
```

## 5. 验收期抓到并修掉的 **5 个真实缺陷**

| # | 缺陷 | 影响 | 修法 |
|---|---|---|---|
| 1 | 提案应用/回滚改了状态但**上下文缓存不作废**（缓存键不含状态哈希） | 界面继续显示旧上下文 | `store.mjs` 返回值带 `work_id`；apply/rollback 分支按 `work_id` `touchWork` |
| 2 | `chapter_index` 取 `chapters.position`（宿主新建章节 position 恒 0） | "第 9 章才知道的事"在第 1 章就可见（**正是要防的未来泄漏**） | 改为按 `(position, id)` 排序后的**下标**；`chapterIndexOf` 与 `readForeshadows` 同源 |
| 3 | `sameOrLaterWindow` 参数方向写反 | 「死人复活」这类 critical 冲突**永不触发** | 修正方向；并让泛化的 `FACT_VALUE_CONFLICT` 让位给更具体的诊断 |
| 4 | `index.mjs` 未导出 `store` | `saveContract is not a function` 等运行时报错 | 补 `export * from './store.mjs'` |
| 5 | 时间线渲染把未绑定章节的条目渲染成 `第0章｜`（且空段留下悬空 `｜`） | 模型上下文里留一条无信息噪声行；"第0章"也不是事实 | 只保留真正有内容的段；整行空则丢弃。（验收实测：`label` 为空的行消失，`label/story_time` 有值的行照常渲染） |

## 6. 测试与回归结果（全部实跑）

| 验收项 | 结果 |
|---|---|
| 逐字节上下文基线（50 用例，与 pre-V2 对照） | **50/50 IDENTICAL** |
| 故事状态端到端（活实例，59 项：开关/契约/提案/陈旧/回滚/预检/校验/九态/别名/未开启不运行/关闭可回到接入前） | **59 通过 / 0 失败 / 0 跳过** |
| Host Contract 契约测试（含负向对照 + 旧库兼容） | **28 通过 / 0 失败 / 0 跳过**（契约 1.1.0） |
| 上下文清单/完整性/溯源（含阴性对照） | **45 通过 / 0 失败** |
| 插件工具面与版本一致（23 工具） | 通过 |
| 插件冒烟（EPUB/导入导出/日志/大作品性能等） | **39 组全通过** |
| 离线检查总闸 `scripts/ci-offline-checks.mjs` | **32/32**（零计费） |
| 一键验收 `verify-all.mjs`（隔离实例） | **54 通过 / 0 未通过 / 1 跳过**（跳过 = 会真实建任务的并发闸门，需显式授权） |
| 前端执行验证 | 164 / 0 |

## 7. 性能对照（先测量后优化）

| 场景 | 冷启动装配（中位） | 热缓存（中位） | 层数 | 组装长度 |
|---|---|---|---|---|
| 门控**关闭** | 12.5 ms | 13.8 ms | 11 | 1132 字 |
| 门控**开启** | 12.6 ms | 15.8 ms | 12 | 1268 字 |
| 差 | **+0.1 ms** | +2.0 ms | +1 | +136 字 |

（活实例、同一作品同一章、各 6 次采样；样本量小，热缓存中位差落在噪声内。关键结论不是"快"，而是**关闭时零变化**、开启时只多一层且内容来自 5 张带索引的新表。）

## 8. 兼容性

- **旧作品**：默认关闭 → 上下文、预算、层序、生成路径与 1.0.0 完全一致；打开后随时可关（S12 实测：关闭后层数正好少一层，其余层不动）。
- **旧库**：schema 指纹不变；旧表零改动；新表全部新建。
- **旧工具/端点**：15 个 `novel_*` 与 26 条端点名字、语义、映射不变；新增 8 工具 / 17 端点全部附加式。
- **插件**：`plugin.json` 版本 0.10.0（与 `novel-tools.mjs`、`package.json` 三处一致，由 `verify-plugin-tools.mjs` 断言）。

## 9. 未完成项与风险（如实）

1. **未知 payload 键被静默忽略**：`timeline_entry` 期望 `entries`（或单条对象），`canon_fact` 期望 `facts`；传错包装键会写入"空条目"而不报错。已在本报告与插件文档口径中明确，但**尚未**加运行时告警——建议在插件侧 adapter 校验，或在下一轮给提案构建加 `warnings[]`（附加字段，不破坏兼容）。
2. **历史数据的章节 `position` 全为 0**：本轮改用 `(position,id)` 下标后可正确排序；但若作者手工调整过章序而 position 未同步，顺序判断仍以下标为准（已在测试中覆盖"界面新建章节"这一真实形态）。
3. **前端无故事状态面板**：当前只有 API + 插件工具面；可视化留给后续（不影响生成质量）。
4. **`harness-pool` 仍未接线**（仅头注释订正），默认走"优先预构建产物"的既有路径。
5. 其他已知工程缺口状态：GitHub Actions CI 已接入（离线 / 依赖下限 / 活实例三档）、`LICENSE` = MIT、EPUB/DOCX/跨平台启动此前已具备；受控 LAN 与上下文可视化仍属未做。

## 10. Git diff 摘要（本轮）

- 新增：`ai/story-state/`（15 文件）、`.p1-baseline/test-story-state-api.mjs`、本报告与契约变更报告。
- 修改：`db.js`、`server.js`、`ai/context/layers.mjs`、`ai/context/assembler.mjs`、`harness-plugins/novel-writing/{novel-tools.mjs,plugin.json,package.json,ENGINE.md}`、`.p1-baseline/{test-host-contract.mjs,test-context-manifest.mjs,verify-all.mjs,verify-phase-map.mjs}`、`docs/host-contract.md`、`docs/host-contract.v1.json`。
- 回滚方式：本轮为**附加式**；撤回 = 停用开关（默认即关闭）或整体回退这批新增文件与 4 个挂载点（`server.js` 门控分支、层登记、DB 建表、插件工具）。阶段映射见 `docs/phase-map.md` 的 Z3。