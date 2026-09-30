# 时态故事状态契约（Temporal Story State Contract）

- 版本：2（2026-09-30，含 T7 存量迁移与 bootstrap；v1 的时态语义不变）
- 适用：Novel Studio 内启用「时态故事状态引擎」的作品；未启用作品完全走既有路径
- 唯一权威来源：`正文修订（story_chapter_revisions）＋ 作者认可的事件集（story_state_events）＋ 提交谱系（story_commits / story_worldlines）`
- 旧字段（`characters.status`、`story_facts` 等）在启用作品上降级为**兼容投影/只读展示**；未启用作品语义不变

## 1. 四维时间模型（不得混淆）

| 维度 | 载体 | 说明 |
|---|---|---|
| 叙事位置 | `story_chapter_order_versions` + `story_chapter_bindings.chapter_id` + cursor `before/after` | 章序由唯一章序服务产生（卷→根章节→场景）；稳定章节 ID 是锚点 |
| 故事时间 | `story_state_events.story_time_json` + `cursor_json` | 事件发生时间与叙事披露位置分开；回忆/梦境/转述不改客观事实 |
| 修订谱系 | `story_chapter_revisions`（不可变，内容寻址） | 旧正文的旧事件保留，只用于旧提交；新稿不复用被替换事件 |
| 世界线 | `story_worldlines`（main / repair） | 候选重建只写 repair 工作线；不得污染 main 的 `chapters.content` |

## 2. 统一状态单元（cell）与事件

- cell 键 = `canonicalJson([domain, entityId, predicate, scope, holderId])`，domain ∈ {character, relation, plotline, foreshadow, knowledge, disclosure, location, faction, item, goal, promise, task, world_fact, event, appearance, premise}；scope ∈ {canon, reader, character, author_plan}；scope=character 时必须给 holderId。
- 事件 = `{id, work_id, chapter_id, revision_id, ops[], evidence[], story_time, cursor, schema_version, extractor}`；op = `{type:'set'|'unset', cell, expected:{kind:'missing'|'value',value}, value?}`。
- **前置条件必须真实校验**：不满足 → `PRECONDITION_FAILED`，绝不自动补写 `alive` 或偷改 expected。
- `state_content_hash` = 规范化业务状态的哈希（判"业务上是否一致"）；`lineage_hash` = 提交/修订/事件集/顺序/算法版本的哈希（判"来源是否陈旧"）。两者不得混用。
- 事件只能由合法 binding 进入投影；提交清单按稳定章节 ID 选中 binding，绝不"查该作品全部 applied 事件"。

## 3. 章前 / 章后

- 写第 N 章新正文：读取**章前**可信状态（通常 = 第 N−1 章章后）。不得读取本章结尾。
- 查看第 N 章正文下方：默认**章后**状态；可信前缀之外返回 `stale` / `blocked` / `pending`，不用旧第 10 章状态冒充新稿最新状态。
- 历史查询：必须同时指定提交 + 章节；旧提交仍返回旧正文与旧状态的一致组合。
- 全文写作上下文：新章只用章前；续写只重放已采纳前缀；重写时旧稿只以「待修订材料」标签出现，不进入新世界线事实层。
- （T6）正文下方「本章状态」面板只经 `GET /api/novel/state/panel`（默认章后；`full=1` 才附带整个状态）与 `GET /api/novel/state/proposal-groups` 读取真实时态状态，位于正文编辑区之外（不进入正文导出 / 复制正文 / 字数统计）；默认不显示未来才登记的人名或状态；切章用请求序号丢弃迟到响应；「全部故事状态」按需拉取，不默认全量。
- （T6）候选修订预览只读 `GET /api/novel/state/revision?work_id=&revision_id=`（归属校验，找不到 404；纯读不写状态）；预览 ≠ 应用，正式正文切换仍必须在 `repair_run_apply` 一次性审批下由服务端原子完成。

## 4. 审批与保存边界

- 日常：保存 → 不可变 revision + **pending binding**（= 本章统一提案组，含各域 ops、证据、payload hash、输入快照、章序、契约、HEAD）→ 作者一次确认（原子组）→ 服务端重算校验（reducer 前置条件 + 基线 CAS）→ 提交 + 投影 + outbox + 审批消费，同一短同步事务。
- AI 产出永远是提案：没有作者确认（或合法审批）不得写入正式状态。模型自报的"已批准/合法 ID/无冲突"一律不接受。
- 确认服务端复核：正文修订（最新文本哈希）、章前状态哈希与提交、章序版本、契约版本、payload hash（事件载荷摘要）；过期提案 `stale` 原样保留，可对当前正文重新分析（重新分析会刷新输入绑定）。
- 一次性审批（`author_approvals`）：作者可创建 `temporal_apply`（提案组）/ `temporal_correction`（更正集）/（T4）`repair_run_start` `repair_run_apply`；baseline 与结构化绑定由服务端计算，确认时在同一事务最后一步校验并消费；不匹配一律拒绝且不消费无关审批。
- 正文保存不等待模型：分析请求持久化，保存请求立即返回；关闭自动分析或无模型时标 `not_run`，保存仍正常。
- 手工修改动态字段（角色状态/关系/剧情线）在启用作品上转为**作者更正事件**（要求生效章节，形成 revision + binding），不保留直写旧字段的后门。未启用作品保留原语义。
- 前文修改：只分析、标记（stale 全后缀）；未点「重建受影响章节」按钮时，后文生成适配器调用数严格为 0，后文正文不变。
- 重建运行：作者一次授权（一次性批准启动 → run 级持久授权；最终 apply 另取一次作者审批）；运行内按叙事顺序逐章验证/修订/抽取/复查；候选只写 repair 工作线；apply 原子切换并保留旧版本；撤销产生恢复提交。

## 5. 状态语义

- 验证状态：`pending / valid / stale / conflict / needs_review / blocked / waived / rejected / superseded`；"已修订"是步骤结果，不是正文永远有效。
- 置信度/存在性：没有记录 ≠ 存活；未知 ≠ 已知；客观事实与角色信念分开；披露按叙事位置过滤；作者计划 ≠ 读者已获知。
- 出具结论必须诚实：未检查、blocked、needs_review、失败、取消、豁免单列；"本次范围内未发现未解决冲突"不等于全书证明。
- 死亡不自动删除关系/实体；闪回/梦境/转述/假死/误信不自动判"复活"；不确定 → `needs_review`。

## 6. 兼容与投影

- 启用开关（作品级，默认全关）：`temporal_enabled`、`auto_analysis_enabled`、`repair_enabled`；存量作品默认关闭。
- 兼容投影只来自**可信状态前缀**；旧 `characters.status` 等字段不构成第二写入源。确认成功后单向刷新 `characters.status` 与 `character_relations.relation/description`（只更新已存在的行；剧情线无安全对应字段，不写）。
- 旧路径在未启用作品上逐字节保持；启用后同一字段不得由新旧两套来源重复注入；`story_state` 上下文层在启用作品上改由 temporal provider 提供（章前 cursor）。
- T5 起，同一 cursor 覆盖全部上下文装配路径：章节检索、语义召回、事件账本、伏笔、角色状态与关系、剧情线、世界词条、知识/披露均按游标过滤或替换；工具查询（events / foreshadows / consistency / search）在显式给出 `chapter_id` 时用同一游标过滤；时态状态版本进入缓存外部版本串，状态推进即失效缓存。未给章节 / 未启用作品时，旧形状与旧缓存行为保持不变。
- 迁移附加式；缺失必要表/索引时禁止开启引擎（响亮失败，不吞错）：`PUT /api/novel/state/temporal` 启用前先跑 `migrationStatus()`（11 张表 + 12 条索引探测），缺一即 503 且不改配置；启用成功才登记迁移版本（`app_settings.temporal_migration`，版本 `1.0.0`，响应里的 `migration.applied=true` 表示本次启用已完成登记）。schema 齐备但未启用时，读接口与启用前逐字节一致。
- 回退 = 停用开关或按阶段回滚（见 `docs/phase-map.md` 的 TT 阶段），**不删除审计历史**；「回退」有三种，不得混称：① 停用作品开关（引擎立即退出生产路径，历史保留）；② 应用级回滚（T4 `repair revert`：产生恢复提交、旧正文可比较）；③ 数据库版本回退（按阶段撤回新增模块 + 保留表数据；不是「把新表删掉就算回滚」）。
- 备份与恢复：停服后复制完整数据目录，或使用 SQLite 一致性备份（`.backup` / VACUUM INTO 等）；**不得只复制仍在写入中的单个 `novel.db` 文件**。测试/迁移演练只操作临时目录或合成夹具，真实作品库不参与。

## 7. 数据安全

- 本地优先 / 隐私优先：不引入云依赖、账号、外部队列；不扩大正文/提示词/API Key 暴露面。
- 测试零计费：确定性 fake provider；真实模型入口默认关闭、需显式授权。
- 所有真实数据试验只在临时目录/隔离实例；真实 `data/` 不触碰。

## 8. 存量迁移与 bootstrap（T7）

- 存量重建按**真实叙事顺序**逐章推进，四步一章：① `POST /api/novel/state/backfill/step`（不带 `result`）冻结不可变修订（内容寻址、幂等，**不改写导入正文**）并返回抽取请求；② 调用方（作者界面 / 脚本 / 本机 fake）按批把抽取 `result` 交回 step → 本地结构校验（唯一校验器）后登记**待确认候选**，不写正式状态；③ 作者 `POST /api/novel/state/backfill/confirm` 按序确认，可信前缀前进一步（跳章 409；重复确认返回幂等回执；上游不可信 / 正文已变一律拒绝，绝不强接）；④ 确认后写章边界快照与事后依赖。
- 出处诚实：旧稿没有生成时上下文，一律记 `generation_context=unknown` / `support=reconstructed`，并把依赖记为 `generation_input:<chapterId>`（status=unknown）；不伪造原始创作记录，不猜原始 context。
- 进度只读真值：`GET /api/novel/state/backfill` 返回迁移状态、逐章状态机（`missing_revision / pending_analysis / analysis_running / pending_confirm / valid / stale / conflict / needs_review / blocked`）、可信前缀、预算（预计抽取调用数，默认关闭自动分析）与 bootstrap 候选；启用响应附 `enable_scope`（首次启用时告知待重建范围）。
- 旧字段迁移只是候选：角色 `status` / 人物关系 / 已确立事实的**最新值**经 `POST /api/novel/state/backfill/bootstrap/plan` 登记为**待确认**候选（幂等、内容键去重）；未确认前任何章的历史状态里都看不到它们（最新角色状态绝不回填为「第 0 章就拥有」）。
- 候选决定（`POST /api/novel/state/backfill/bootstrap/decide`）：`confirm+opening` → 写 `story_commits.manifest.initial_binding_id`（**只有已确认的初始绑定才进入初始状态**；`GET /api/novel/state/at` 返回 `initial` 说明是否应用）；`confirm+chapter` → 转该章普通待确认提案（仍须按序确认）；`reject` → 记录拒绝、不写任何状态。
- 边界：backfill 写入口全部是作者动作（`X-Novel-Agent` → 403），章节/作品归属校验失败 → 404；step 本身不调用模型（模型不可用时保留待分析任务，不编造假历史）。
