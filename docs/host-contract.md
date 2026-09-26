# Host Contract 1.2.0（宿主契约 · 冻结）

> **这份文档是 novel-writing 插件阶段的稳定地面。**
> 冻结的是**已经验收过的行为与接口**，不是"理论完美"；任何新增宿主行为都必须以后再走主体变更流程（质量门 → 行为门 → 兼容门），
> 不能在插件实现过程中随手改 Host。
>
> - 机读契约面（由真实代码导出，不是手抄）：`docs/host-contract.v1.json`
> - 契约测试（离线、零计费）：`node .p1-baseline/test-host-contract.mjs`
> - 版本：**host-contract 1.2.0**（`HOST_CONTRACT_VERSION` 在 `server.js`；`GET /api/novel/ping` 会回报它）
> - 1.0.0 冻结于 **2026-09-25**（依据：`docs/main-v2-acceptance-2026-09-25.md` 的 A PASS 验收结论）
> - 1.1.0 冻结于 **2026-09-26**（**附加式**扩展：确定性故事状态内核；预算常量、层顺序、默认生成路径均未变，逐字节基线 50/50 复验。见 §13）
> - 1.2.0 冻结于 **2026-09-26**（**附加式**：只读事实端点 `GET /api/novel/state/facts`；并修正派生视图的章序展示——内部 0 基下标，展示一律 +1。见 §13）

**三处互锁**：`server.js` 的常量 / `docs/host-contract.v1.json` / 本文档——任何一处被改动而另两处没跟上，契约测试会报红。

---

## 0. 冻结范围与变更流程

| | 内容 |
|---|---|
| **冻结** | 本文 §1–§10 的接口形状、字段名、状态词、错误码、边界与不变条件；`docs/host-contract.v1.json` 里所有机械项 |
| **允许（附加式）** | 新增字段、新增层（含**门控层**：只有作品显式打开开关时才存在的层）、新增表、新增工具、新增端点、新增日志 `kind`；**旧字段语义不得改变，不得删除** |
| **禁止** | 改名 / 删字段 / 改语义 / 减少上下文 / 降低模型或思考强度 / 改变默认生成路径 |
| **版本变化** | 必须走主体变更流程：改代码 → 改 fixture → 改本文档 → 跑契约测试 + `verify-all` + 质量回归（逐字节基线） |
| **重新打开契约** | 见 §12 |

**质量保护不变条件（Host 的硬承诺）**

1. 默认小说生成路径的语义不因本契约改变（相同输入 ⇒ 相同 assembled，逐字节）
2. 原有 novel_* 工具名与端点映射保持兼容（插件可以新增工具，不能悄悄改名/改语义）
3. 旧作品/旧章节/旧记忆继续可打开（schema 只增不减，零删除）
4. 上下文预算规则（TOTAL_BUDGET / 各层 cap / FLEX_ORDER）不得因"更规范"而无依据改变
5. 默认 AI route（直连 vs 慢通道的选择）不得因"统一"而无依据改变
6. Context Manifest 必须与真正发送的上下文一致（C1 逐字节 + 内容哈希 C6）
7. 新增能力一律**门控**：未打开开关的作品不出现新层、不新增 token 消耗、不进 `excluded`、不计入可执行下限（1.1.0 实测：`floor(settings)` 仍为 18173）

---

## 1. Context API / Context Manifest contract

| 项 | 内容 |
|---|---|
| **输入** | `GET /api/novel/context?work_id=&chapter_id=&mode=`（`mode ∈ {full, continuation, fragment, settings}`）；`GET /api/ai_context?chapter_id=`（主成文路径入口，与前者**同源同缓存**） |
| **输出** | `assembled`（**唯一**进模型的提示词正文）、`context_manifest`（逐层）、`context_envelope`、`context_id`、`context_request_id`、`context_integrity`、`context_overflow`、`context_stats`；外加结构化字段（角色的卡、事件、伏笔、世界观…）供界面预览 |
| **状态** | 无长驻状态；进程内缓存（写操作 `touchWork` 与外部状态变化即失效） |
| **错误码** | `400` 缺 `work_id`（`chapter_id` 可空）；`404` 作品不存在 |
| **retryable** | `400/404` 否；网络/5xx 由调用方决定（宿主无副作用） |
| **兼容策略** | 附加式：新增字段允许；**既有字段名与语义不得变**（`assembled` 永远是服务端装配结果） |
| **版本** | 1.1.0（附加式：新增门控层 `story_state`；信封字段仍是 fixture `context.envelope_fields` 的 13 个，未增未删） |
| **不变条件** | ① 清单与真正发送的文本**逐字节自洽**（C1）+ 内容哈希（C6）；② 层裁剪必须留查回路径（I4，C5）；③ 不允许静默超预算（C4 必须带溢出标记）；④ 完整性**只记录不拦截**生成 |
| **可观测字段** | 清单逐层：`id/label/kind/bodyLength/emitted/dropped/declaredCap/truncated/empty/estimatedTokens/source/sourceId/temporalScope/knowledgeScope/selection/trimPriority/reason/knownGap/scores/note/recoveryPath/outcomeReason/shrunk`（24 个，见 fixture） |
| **不可绕过** | `assembled` 是**唯一**上下文来源：插件不得自行拼接、追加或扩大上下文；`TOTAL_BUDGET`(settings 19000 / default 26000) 与各层 cap 不得被绕开；门控层只有作品显式打开开关时才存在，插件不得自行注入、伪造或强制开启 |

15 个层（`context.layers`）：`work / outline / memory / recall / events / foreshadows / scene / blueprint / story_tail / characters / relations / world / terms / story_state / redlines`。

其中 `story_state` 是**门控层**（`gated: true`，`kind: cond`，cap 2400，排在 `redlines` 之前）：只有作品显式打开「确定性故事状态」开关时才会出现在清单里；未打开时**不出现、不进 `excluded`、不计入可执行下限**（它不是"被裁掉"，而是"不属于这套层"）。
弹性层顺序 `FLEX_ORDER = [story_tail, outline, world]`，档位 cap `FLEX_CAPS = [2400, 1600, 800, 400]`；`floor(settings) = 18173 ≤ 19000`（未开门控），`floor(full, {includeGated:true}) = 21364`。

---

## 2. Task / Run contract

| 项 | 内容 |
|---|---|
| **输入** | `POST /api/harness/job`（异步，返回 `job_id`）、`POST /api/harness/run`（同步）、`GET /api/harness/job?id=`（轮询）、`GET /api/harness/status`、`POST /api/ai/<action>`（直连，见 §8） |
| **输出** | `{ok, id, status, kind, stage, model_slot, model_waiters, chapter_id, work_id, elapsed_ms, tail, output, result, scan, proposals, error}`（16 个字段，见 fixture `task_run.job_response_fields`） |
| **状态** | 作业状态机：`queued → running → done | failed | timeout | cancelled`；取消请求的**瞬时**响应状态是 `cancelling` |
| **错误码** | `404` 任务不存在或已过期（服务重启后内存作业会丢）；`429` 并发槽位已满（`model_waiters` 给出等待数） |
| **retryable** | `429` **是**（退避后重试）；`404` 否（改用恢复端点或重建任务） |
| **兼容策略** | 字段附加式；`status` 词表**只增不改**（新增状态必须同步 fixture 与文档） |
| **版本** | 1.0.0 |
| **不变条件** | ① 直连与慢通道**共用同一档位→强度口径**；② 命名任务（`generate_novel` / `compress_memory`）与匿名任务走同一作业表；③ `output` 只在 `status==='done'` 时非空，绝不用半截正文冒充成功 |
| **可观测字段** | `status / stage / model_slot / model_waiters / elapsed_ms / tail / error`（`tail` 是最后 600 字的进度尾巴，不含正文全文） |
| **不可绕过** | 插件不得自建第二套 task/run（必须用宿主作业端点）；不得把 `queued`/`running` 当成功 |

---

## 3. Trace / Audit contract

| 项 | 内容 |
|---|---|
| **输入** | `POST /api/logs`（远端上报，**layer 只能是 `frontend` 或 `plugin`**）、`GET /api/logs`（查询/统计）、`X-Trace-Op` / `X-Trace-Title` 请求头（把前后端节点归到同一次用户操作）、调试录制 `POST /api/debug/start|stop`、`GET /api/debug/state|ops|op` |
| **输出** | 统一日志记录（11 字段）：`ts / layer / level / kind / message / code_file / code_line / code_func / stack / context / dedup_key`；`context_id`（内容哈希）与 `context_request_id`（本次装配身份）随上下文端点下发 |
| **状态** | 日志落 SQLite `app_logs`（滚动文件 + 去重窗口）；录制态可开可关 |
| **错误码** | `400` 非法层级 / 非法 JSON；`404` 资源不存在（如事件的 `work_id` 不存在 → 404 而不是 500） |
| **retryable** | 上报失败**不要**重试到刷屏（宿主有去重窗口）；`400` 否 |
| **兼容策略** | `layer` / `level` 词表只增不改；日志字段附加式；旧日志继续可读 |
| **版本** | 1.0.0 |
| **不变条件** | ① 远端只能报 `frontend` / `plugin` 两个层级（`LAYERS` 共 9 个，其余是宿主内部层级）；② 审计必须能回答"这次有没有真的调用模型"（花钱总闸）；③ 每条日志必须能定位到代码位置（自动解析调用栈） |
| **可观测字段** | 见上 11 字段；作业侧另有 `elapsed_ms`、`tail` |
| **不可绕过** | 插件不得把 layer 报成 `server`/`db`/`harness`/`ai`；不得自建第二套 trace/recovery；不得依赖未列入本契约的内部文件路径或函数名 |

---

## 4. Settings isolation contract

| 项 | 内容 |
|---|---|
| **输入** | 环境变量 `NOVELSTUDIO_DATA_DIR`（数据目录重定向）、`PORT`、任务身份 `NOVELSTUDIO_WORK_ID` / `NOVELSTUDIO_CHAPTER_ID` / `NOVELSTUDIO_MODE`、`NOVELSTUDIO_PROPOSE_MODE`（headless 先落提案）、`NOVELSTUDIO_OV_DISABLED`；每任务默认模型覆盖层（`ai/task-settings.mjs`） |
| **输出** | `GET /api/ai/policy` 策略快照（`models / known_models / efforts / pipeline_effort_by_mode / effort_by_tier / long_ai_timeout_ms`）；每任务 dsh 配置补丁 |
| **状态** | 设置来源三级：`settings 文档 → profile 补丁层 → 出厂默认`；每任务视图互不污染 |
| **错误码** | 无专用错误码；隔离失败表现为"用了别的实例的配置"（正是要避免的形态） |
| **retryable** | 配置类错误不 retryable（改配置再重试） |
| **兼容策略** | 环境变量只增不改；`/api/ai/policy` 字段附加式 |
| **版本** | 1.0.0 |
| **不变条件** | ① 隔离实例**不得**回落到作者的 3737 实例（由 `test-harness-env.mjs` 断言）；② 插件不得直接写宿主全局 settings；③ 默认模型/强度只从策略表来 |
| **可观测字段** | 策略快照 6 个键；`ov_endpoint_source`、`dsh_repo` 启动日志 |
| **不可绕过** | 直接写 `app_settings` / `~/.dsh` 全局配置；把子进程指向作者的实例 |

---

## 5. Cancellation / Recovery contract

| 项 | 内容 |
|---|---|
| **输入** | `POST /api/harness/cancel {job_id}`、`GET /api/harness/recoverable?work_id=&chapter_id=`、`GET /api/harness/recovered?id=`、`POST /api/harness/mark_applied {job_id}` |
| **输出** | 取消：`{ok, id, status:'cancelling'}`；可恢复清单：`{ok, jobs:[...]}`；取回：`{ok, job}` |
| **状态** | 取消后作业终态 `cancelled`；被杀的子进程树属于本次任务，不影响其他作业；恢复清单**跨服务重启**仍可读（落库） |
| **错误码** | `404` 任务不存在或已结束（取消）/ 任务记录不存在（取回）；`400` `mark_applied` 缺 `job_id`。**均为 404/400，绝不为 500** |
| **retryable** | `404` 否（任务确实不在了）；网络失败可重试（幂等：取消/标记重复调用无副作用） |
| **兼容策略** | 端点与语义冻结；新增恢复类端点属附加式 |
| **版本** | 1.0.0 |
| **不变条件** | ① 取消语义 = 杀该任务的 dsh 子进程树（不是杀共享进程）；② `HARNESS_CANCELLED` 是取消的专用错误码；③ 半截流（有正文但没等到完成信号）必须报错，绝不交付 |
| **可观测字段** | 作业 `status`、`cancelRequested` 落库标记、`error='任务已取消'` |
| **不可绕过** | 插件不得自建第二套取消/恢复机制；不得把取消当失败重试（会重复计费） |

---

## 6. Database / Migration contract

| 项 | 内容 |
|---|---|
| **输入** | 无（宿主内部）；插件**不得**直接打开 `novel.db` |
| **输出** | 35 张表（见 fixture `db.tables`）。1.0.0 冻结的 25 张（见 fixture `db.frozen_tables`）：works / volumes / plotlines / chapters / categories / terms / characters / character_relations / world_entries / creation_tasks / story_memories / memory_versions / plotline_characters / api_configs / chapter_save_versions / harness_jobs / story_events / writing_redlines / story_event_proposals / story_memory_proposals / chapter_reviews / ai_eval_events / app_settings / app_logs / ai_error_logs；
1.1.0 附加的 10 张（见 fixture `db.tables_added_in_v1_1`）：story_state_config（作品开关，**既有作品默认 0**）/ story_timeline_entries / story_facts / character_knowledge / story_entities / story_entity_aliases / chapter_contracts / story_state_proposals / story_snapshots / story_validations |
| **状态** | `PRAGMA journal_mode = WAL` / `foreign_keys = ON` / `busy_timeout = 5000` |
| **错误码** | 无（DB 层错误由 API 层转成 4xx/5xx） |
| **retryable** | 写冲突由 `busy_timeout` 吸收；业务层不重试 |
| **兼容策略** | **只增不减**：`CREATE TABLE IF NOT EXISTS` + `try ALTER TABLE ... ADD COLUMN`（列已存在即忽略）；**绝不** `DROP TABLE` / `DROP COLUMN` / `RENAME` / 删除用户数据 |
| **版本** | 1.1.0（附加 10 张 story_state 相关表；25 张旧表零结构改动） |
| **不变条件** | ① 旧作品/旧章节/旧记忆继续可打开；② 对旧库零 schema 写入、零数据删除（验收实测：`sqlite_master` 指纹 `3cb7e5d9ac4f67b9` 前后一致）；③ 新增表全部是**新表**，不改旧表结构；`story_state_config.enabled` 对既有作品默认 `0`（未开启 = 行为与 1.0.0 完全一致） |
| **可观测字段** | `sqlite_master`（表/索引/视图/触发器）、关键表行数 |
| **不可绕过** | 插件不得直接读写 `novel.db`（含 `-wal` / `-shm`）；不得要求宿主"顺手"改字段 |

---

## 7. Plugin Adapter contract

| 项 | 内容 |
|---|---|
| **输入** | 插件清单 `harness-plugins/novel-writing/plugin.json`：`tools`（23 个）、`engineEndpoints`（44 条）、`dshPlugin.contract`（exports / registersToolsVia）、`identityEnv`、`proposeModeEnv` |
| **输出** | dsh 侧工具注册（`ctx.tools.register`）+ 对宿主的 HTTP 调用；插件日志经 `POST /api/logs`（layer=`plugin`） |
| **状态** | 插件进程是 dsh headless；无宿主侧长驻状态 |
| **错误码** | 与所调端点一致（见各契约）；插件自身的失败必须上报日志而不是静默 |
| **retryable** | 见 §9（按 HTTP 状态码分类） |
| **兼容策略** | 工具名与端点映射冻结；**新增**工具允许（必须同步 fixture 与文档） |
| **版本** | 1.2.0（工具 15 → 23、端点 26 → 44，全部为**新增**；旧工具名与语义不变） |
| **不变条件** | ① 1.0.0 的 15 个 `novel_*` 工具名与语义不变，1.1.0 新增 8 个（合计 23）；② 端点面 = fixture `plugin_adapter.endpoints`（44 条）；③ 每个端点在 `server.js` 里真的存在（契约测试逐条核对） |
| **可观测字段** | 插件请求可带 `X-Trace-Op` / `X-Trace-Title`，日志 `layer=plugin` |
| **不可绕过** | 绕过 context budget / 直写全局 settings / 自建 task-trace-recovery / 直写 DB / 绕开策略表调 `/api/ai/*` |

**插件可以使用的工具**（23 个 `novel_*`，名字与语义冻结；后 8 个是 1.1.0 新增）

| 工具 | 用途 |
|---|---|
| `novel_context` | 取 ST 式分层上下文（唯一上下文来源） |
| `novel_works` | 列出作品，确认 work_id |
| `novel_lookup` | 关键词检索（被裁层的查回入口） |
| `novel_foreshadows` | 列出未闭合/全部伏笔 |
| `novel_events` | 读事件账本 |
| `novel_foreshadow_update` | 标记伏笔状态 |
| `novel_consistency` | 成文后一致性核对 |
| `novel_scan` | 确定性反 AI 腔红线扫描 |
| `novel_style_contract` | 读写作红线清单 |
| `novel_event_add` | 事件/伏笔/状态变化入账 |
| `novel_memory_read` | 读完整长期记忆摘要 |
| `novel_memory_update` | 长期记忆压缩/增量提交（零损失护栏 + 版本快照） |
| `novel_blueprint` | 保存本章写作蓝图 |
| `novel_review` | 保存审稿报告 |
| `novel_chapter_save` | 成稿写回章节正文 |
| `novel_state` | 读/写作品级故事状态开关（门控总闸，**默认关闭**） |
| `novel_contract` | 读/写章节契约（11 个字段组，`unknown` 是一等公民） |
| `novel_preflight` | 写前预检：时间线/知识边界/正典冲突/注入检查 |
| `novel_validate` | 成文后校验：契约符合度 + 事实/知识/时间线违规 |
| `novel_state_propose` | 落状态提案（**不直接改状态**；带 base_state_hash 陈旧检查） |
| `novel_state_commit` | 审核/应用/驳回提案（应用走单事务，可回滚） |
| `novel_snapshot` | 打快照 / 回滚（回滚不删行：新增标 superseded、改过的改回取值） |
| `novel_write_pipeline` | 编排层：预检 → 写作 → 校验 → 提案（**不自己生成正文**） |

（上表里的工具名同时出现在 fixture 的 `plugin_adapter.tools`；工具名与端点映射由 `verify-plugin-tools.mjs` 与契约测试双重核对。）
**插件可以使用的接口**（白名单，44 条端点逐条列出；最后 18 条是 1.1.0/1.2.0 新增的确定性故事状态端点）

```
GET /api/novel/ping
GET /api/works
GET /api/search?q=&work_id=
GET /api/novel/context?work_id=&chapter_id=&mode=
GET/PUT /api/novel/redlines?work_id=
GET/PUT /api/novel/semantic
POST /api/novel/scan
GET/POST /api/novel/events
GET /api/novel/foreshadows?work_id=&status=
POST /api/novel/foreshadows/:id/status
POST /api/novel/consistency
PUT /api/novel/chapter_blueprint
PUT /api/novel/review
GET /api/novel/review?chapter_id=
PUT /api/novel/review/checklist
GET /api/novel/empty_chapters?work_id=
POST /api/novel/chapter_save
GET /api/novel/proposals?work_id=
POST /api/novel/proposals/apply|reject
PUT /api/story_memory
GET /api/story_memory?work_id=
GET /api/story_memory/versions?work_id=
POST /api/story_memory/rollback
POST /api/logs
POST /api/import
GET /api/export/txt|md?work_id=|chapter_id=
GET /api/novel/story_state?work_id=
PUT /api/novel/story_state
GET /api/novel/state/timeline?work_id=&chapter_id=
GET /api/novel/state/entities?work_id=
GET /api/novel/state/knowledge?work_id=&character_id=&chapter_id=
GET /api/novel/state/foreshadows?work_id=&chapter_id=
GET /api/novel/state/contract?chapter_id=
PUT /api/novel/state/contract
POST /api/novel/state/preflight
POST /api/novel/state/validate
POST /api/novel/state/quality
GET /api/novel/state/proposals?work_id=&state=
POST /api/novel/state/proposals
POST /api/novel/state/proposals/review|apply|reject
GET /api/novel/state/snapshots?work_id=
POST /api/novel/state/snapshot
POST /api/novel/state/rollback
GET /api/novel/state/facts?work_id=&chapter_id=
```

白名单之外，插件还可以用：`GET /api/ai/policy`（读策略快照）、`GET /api/harness/job|status|recoverable|recovered`、`POST /api/harness/cancel|mark_applied`。

**插件不得绕过的边界**

- 绕过 context budget：不得自行拼接/追加超出 assembled 的上下文
- 直接写宿主全局 settings（app_settings / ~/.dsh 全局配置）
- 自建第二套 task/run/trace/recovery（必须用宿主 endpoint）
- 直接写数据库文件（novel.db / -wal）
- 调用 /api/ai/* 绕开策略表（模型/强度必须来自 /api/ai/policy）
- 把 layer 报成 server/db/harness/ai（远端只允许 frontend/plugin）
- 依赖未列入本契约的内部文件路径或函数名

---

## 8. AI Route contract

| 项 | 内容 |
|---|---|
| **输入** | 直连：`POST /api/ai/<action>`，`action ∈ {write, write_stream, personality, outline, chat, polish, expand, pipeline, generate_novel, test}`；慢通道：`POST /api/harness/job|run`。策略：`GET /api/ai/policy` |
| **输出** | 直连：`{ok, reply, raw}`；SSE（`write_stream`）：流式正文 + 结束时的确定性红线扫描；慢通道：作业对象（§2） |
| **状态** | 直连无状态；慢通道有作业状态机 |
| **错误码** | `405` 非 POST；`404` 未知 action；`400` 缺 API Key / 缺 `messages`；上游失败 `e.status || **502**` |
| **retryable** | `502` 是（上游/超时）；`400/404/405` 否 |
| **兼容策略** | action 词表只增不改；默认 route **不变**（"统一成一条路"属于无依据的行为变更，不做） |
| **版本** | 1.0.0 |
| **不变条件** | ① 模型/强度/超时全部来自 `ai/policy.mjs` 单点（`long_ai_timeout_ms = 1800000`）；② 前端不得自己写死模型名或强度；③ 慢通道用**预构建产物优先**启动（省掉现场转译） |
| **可观测字段** | `policy` 快照 6 键；`traceAI` 记录的 endpoint/stream/status；作业 `model_slot` |
| **不可绕过** | 插件不得自带模型配置或强度；不得绕过策略表直接调上游 |

---

## 9. Error / Retry contract

| 项 | 内容 |
|---|---|
| **输入** | 任意端点的失败响应 |
| **输出** | **统一错误体**：`{"error": "<人话>"}`（HTTP 状态码另行表达类别） |
| **状态** | 无 |
| **错误码** | `200/201` 成功；`400` 请求本身不合法（缺参/非法 JSON/非法层级）；`403` 静态路径越界；`404` 不存在；`405` 方法不对；`413` 请求体过大；`429` 并发槽位已满；`500` 宿主内部异常；`502` 上游 AI 失败/超时 |
| **retryable** | `429 → 是`（退避）；`502 → 是`；`500 → 谨慎是`（幂等才重试）；`400/403/404/405/413 → 否` |
| **兼容策略** | 状态码语义冻结；新增错误码须同时更新 fixture 与本文档 |
| **版本** | 1.0.0 |
| **不变条件** | ① 错误体永远是 `{error}` 而不是裸字符串/HTML；② 空回复重试是**质量阶梯**：保持原思考强度 + 放宽 `max_tokens` → 仍空才降 effort → 仍空才回退/报错；③ 半截流必须报错，绝不交付残缺正文 |
| **可观测字段** | HTTP 状态码、`{error}`、日志 `kind`、作业 `error` / `status` |
| **不可绕过** | 插件不得把 4xx 当"重试就好"；不得把 `cancelled` 当失败重试（会重复计费） |

---

## 10. Compatibility policy（兼容与版本策略）

| 项 | 内容 |
|---|---|
| **输入** | 旧库 / 旧作品 / 旧章节 / 旧插件 / 旧客户端 |
| **输出** | 继续可用；无法兼容时必须**响亮失败**（不能静默降级） |
| **状态** | — |
| **错误码** | 兼容性失败用 4xx/5xx 明确表达 |
| **retryable** | 兼容性问题不靠重试解决 |
| **兼容策略** | ① 接口**附加式**演进（加字段/加端点/加工具，不改语义、不删）；② DB **只增不减**；③ 旧作品可打开；④ 旧 `novel_*` 工具与端点不变；⑤ 契约版本号作为唯一硬信号 |
| **版本** | `host-contract 1.2.0`；运行时可从 `GET /api/novel/ping` 读到 `host_contract`（1.0.0 → 1.2.0 全为附加式，见 §13） |
| **不变条件** | 见 §0 的 6 条质量保护不变条件 |
| **可观测字段** | `ping.host_contract`；fixture 版本；文档版本（三处互锁） |
| **不可绕过** | 插件不得假设"宿主没变"而跳过版本检查；也不得因为版本不同就自行分叉实现 |

---

## 11. 契约验证方式（真的跑，不是写着好看）

| 层次 | 工具 | 覆盖 |
|---|---|---|
| **契约测试** | `node .p1-baseline/test-host-contract.mjs`（离线清单 32 条之一；也已接进一键验收） | 代码↔契约漂移、文档↔契约腐烂、边界是否真的在代码里成立、旧库兼容；含**负向对照**（改坏预算/工具名/信封字段必须报红） |
| **契约夹具** | `docs/host-contract.v1.json` | 由真实代码导出的可机读契约面（层/预算/清单字段/策略/工具面/端点面/日志层级/表清单） |
| **adapter 测试** | `.p1-baseline/verify-plugin-tools.mjs` + `harness-plugins/novel-writing/test/smoke.mjs` | 15 个工具 ↔ 26 条端点的对账；插件冒烟 39 组 |
| **迁移/旧库兼容** | `test-host-contract.mjs`（§D）+ `api-test-suite.mjs` | 旧库 schema 指纹与表清单；旧作品/章节/记忆可读可写 |
| **宿主整体** | `node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3739` | **53 通过 / 0 未通过 / 1 跳过**（含本契约测试、清单完整性、查回路径、策略单点、作业接线、花钱总闸） |
| **质量回归** | `capture-baseline.mjs` + `compare-baseline.mjs` | 50 例上下文与 pre-V2 基线**逐字节**相同（冻结时实测） |

---

## 12. 什么时候允许重新打开 Host Contract

只有下面三类**真实**理由才允许改宿主；其余一律在插件侧 adapter 解决：

- 真实用户受影响（旧作品打不开、生成质量下降、数据丢失）
- 核心质量或安全阻塞（上下文丢失、越权写入、注入）
- 性能回归有实测证据且必须在宿主侧修
- 以上之外：优先在插件侧 adapter 解决，不改 Host

打开流程与 §0 一致：改代码 → 改 fixture → 改本文档 → 跑契约测试 + `verify-all` + 质量回归；**并重新走一遍质量门 / 行为门 / 兼容门**。

---

## 13. 变更记录（Change log）

| 版本 | 冻结日 | 变更 | 兼容性 |
|---|---|---|---|
| 1.0.0 | 2026-09-25 | 首版冻结（主体 V2 验收 A PASS 之后） | — |
| 1.1.0 | 2026-09-26 | **附加式**：新增门控上下文层 `story_state`（cap 2400，排在 `redlines` 之前）；新增 10 张故事状态表；新增 17 条状态端点；新增 8 个插件工具（工具 15→23、端点 26→43） | 旧字段/旧层/旧表/旧工具/旧端点**语义与顺序均未变**；预算常量、`FLEX_ORDER`、默认 AI route、默认生成路径未变；旧库 schema 指纹 `3cb7e5d9ac4f67b9` 未变；逐字节上下文基线 **50/50** |
| 1.2.0 | 2026-09-26 | **附加式**：新增只读端点 `GET /api/novel/state/facts`（事实清单 + 按章可见/计划/未来 id），补齐 supersede / merge / split 所需的 id 读回；修正派生视图的章序展示（内部 0 基下标 → 展示 +1） | 端点 43→44，工具仍 23；默认生成路径、预算、层序均未变；逐字节基线 **50/50** |

**1.1.0 的"不做"清单（对照质量红线）**

- 不把新层强加给既有作品：`story_state_config.enabled` 默认 `0`，未开启时层不存在、不进 `excluded`、不计入下限，`story_state` 字段恒为 `null`
- 不因"更规范"改预算：`TOTAL_BUDGET`、各层 cap、`FLEX_ORDER`、`floor(settings)=18173` 逐值不变
- 不因"统一"改路由：默认直连/慢通道选择不变（见 §8）
- 不改旧表结构、不动旧数据：10 张新表 + 14 个索引 + 3 个条件唯一索引，全部新增

## 14. 1.1.0 新增宿主能力：确定性故事状态（PHASE 1–14）

这一节是**能力地图**，不是对插件实现的承诺：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 作品开关（门控总闸） | `story_state_config`（默认 0） | `GET/PUT /api/novel/story_state`、`novel_state` |
| 时间线（相对日/可见性/未来泄漏/顺序倒置） | `ai/story-state/timeline.mjs` | `GET /api/novel/state/timeline` |
| 知识边界（三档 scope × 四态） | `knowledge.mjs` + `character_knowledge` | `GET /api/novel/state/knowledge`、`POST /api/novel/state/validate` |
| 实体与别名（合并/拆分/改名预案） | `entities.mjs` + `story_entities` / `story_entity_aliases` | `GET /api/novel/state/entities` |
| 正典事实与冲突分级（五级，白名单自动可修） | `canon.mjs` + `story_facts` | `POST /api/novel/state/validate` |
| 伏笔九态派生（不改宿主 `foreshadow_status`） | `foreshadow.mjs` | `GET /api/novel/state/foreshadows` |
| 章节契约（11 字段组，`unknown` 一等公民） | `contract.mjs` + `chapter_contracts` | `GET/PUT /api/novel/state/contract`、`novel_contract` |
| 写前预检 | `preflight.mjs` | `POST /api/novel/state/preflight`、`novel_preflight` |
| 成文后校验 | `store.mjs` + `story_validations` | `POST /api/novel/state/validate`、`novel_validate` |
| 提案-审核-应用-回滚（单事务、陈旧检查、不删行） | `proposal.mjs` + `story_state_proposals` / `story_snapshots` | `POST /api/novel/state/proposals*`、`snapshot`、`rollback` |
| 事实清单（含 id，供 supersede / merge / split 指认） | `store.mjs` + `story_facts` | `GET /api/novel/state/facts` |
| 章序口径（**内部 0 基下标**，展示一律 +1） | `timeline.mjs` 的 `ordinal()` | 各端点/上下文层的人读文字 |
| 18 相位流程状态机（映射回宿主作业状态） | `state-machine.mjs` | 提案/快照记录里的 `phase`；宿主作业状态词不变（§2） |
| 注入防护（DATA 围栏 + 11 条模式，**只记录不拦截**） | `injection.mjs` | 预检/校验结果里的 `injection` |
| 上下文分层（6 条优先级带 + `story_state` 子块） | `semantic-context.mjs` + `layers.mjs` | `context_manifest` 的 `story_state` 层 |
| 风格质量指标（描述性，**不驱动改写**） | `style-quality.mjs` | `POST /api/novel/state/quality` |
| 内核门面与版本 | `ai/story-state/index.mjs`（`STORY_STATE_VERSION`） | 提案/校验响应里的 `kernel_version` |

**回滚语义（可逆性承诺）**：回滚**不删任何行**——新增的行标 `superseded`，改过的行改回取值；回滚前自动留 `pre-rellback` 快照。
