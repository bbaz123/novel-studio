# Host Contract 1.11.0（宿主契约 · 冻结）

> **这份文档是 novel-writing 插件阶段的稳定地面。**
> 冻结的是**已经验收过的行为与接口**，不是"理论完美"；任何新增宿主行为都必须以后再走主体变更流程（质量门 → 行为门 → 兼容门），
> 不能在插件实现过程中随手改 Host。
>
> - 机读契约面（由真实代码导出，不是手抄）：`docs/host-contract.v1.json`
> - 契约测试（离线、零计费）：`node .p1-baseline/test-host-contract.mjs`
> - 版本：**host-contract 1.11.0**（`HOST_CONTRACT_VERSION` 在 `server.js`；`GET /api/novel/ping` 会回报它）
> - 1.0.0 冻结于 **2026-09-25**（依据：`docs/main-v2-acceptance-2026-09-25.md` 的 A PASS 验收结论）
> - 1.1.0 冻结于 **2026-09-26**（**附加式**扩展：确定性故事状态内核；预算常量、层顺序、默认生成路径均未变，逐字节基线 50/50 复验。见 §13）
> - 1.2.0 冻结于 **2026-09-26**（**附加式**：只读事实端点 `GET /api/novel/state/facts`；并修正派生视图的章序展示——内部 0 基下标，展示一律 +1。见 §13）
> - 1.3.0 冻结于 **2026-09-27**（**附加式**：作者审批记录把模型侧写入变成服务端可校验的执行边界；`author_approvals` / `adoption_operations` 两张新表；`GET/POST /api/novel/approvals`；`novel_approvals` 工具。旧端点/工具/字段语义与默认生成路径不变。见 §13）
> - 1.4.0 冻结于 **2026-09-27**（**附加式 + 原子边界**：整次采纳 `POST /api/novel/adopt` —— 正文 + 选中提案 + 历史版本 + 投影 outbox 同一 SQLite 事务；`adoption_operations` 幂等键；`projection_outbox` 新表与 `GET /api/novel/projections`、`POST /api/novel/projections/retry`。插件工具/端点面不变；adopt 为作者界面专用、模型侧 403。见 §13）
> - 1.5.0 冻结于 **2026-09-27**（**附加式 + 记忆来源边界**：OpenViking 召回的 fail-closed 来源校验——跨书 / 未来章节 / 候选内容 / 布局不明一律不进 assembled，召回生产方与宿主装配器共用同一实现并对被拦条目留审计原因；`ov_projection_audit` 新表记录 delete/rebuild 的待删除集合与范围证明；新增作者侧 `POST /api/novel/projections/replay|rebuild` 与 `GET /api/novel/projections/audit`（rebuild 默认 dry-run、删除前逐条证明归属、模型侧 403）。插件工具/端点面不变。见 §13）
> - 1.6.0 冻结于 **2026-09-27**（**附加式 + 门控编辑规则**：R07 新增门控上下文层 `edit_rules`（`kind=cond`、`cap=2400`，排在 `story_state` 之后、`redlines` 之前；**默认关闭**，关闭时该层不存在、不进 `excluded`、不计入下限）；新增只读 `GET /api/novel/editing`、`GET /api/novel/editing/rules?task=`、`POST /api/novel/editing/scan`（确定性扫描，不调用模型）与作者侧 `PUT /api/novel/editing`（模型不能改自己的规则，模型侧 403）。见 §13、§15）
> - 1.7.0 冻结于 **2026-09-27**（**附加式 + 作者侧风格证据**：R09 作者样文 / 文风档案 / 三级作者意图。新增门控上下文层 `author_intent`（默认关闭：作品没有任何作者意图与启用样文时该层**不存在**，`assembled`/`manifest` 与接入前逐字节一致）；新增 3 张作者侧表 `author_samples` / `style_profiles` / `author_intents` 与作者侧端点 `GET/POST/PUT/DELETE /api/novel/style/samples`、`GET/POST /api/novel/style/profile`（分析为确定性计数，不调用模型）、`GET/PUT/DELETE /api/novel/author_intent`（模型侧只能读，写一律 403）。样文只作风格证据，**不进入** `story_facts` / 事件 / 角色知识。见 §13、§16）
> - 1.8.0 冻结于 **2026-09-27**（**附加式 + 披露派生视图**：R10 只读端点 `GET /api/novel/state/disclosure` —— 按章时点重算「作者真相 / 作者计划 / 撤回 / 角色信念 / 窗口关闭 / 未来 / 尚未披露 / 角色私有 / 读者已披露」九档，并给出每个角色在该时点的已知 / 未知 / 疑似 / 错误信念 / 未定与可执行 fact id；无新表、无缓存（每次重算），不改上下文层、预算与默认生成路径；模型的 `novel_state` 可读 `status=disclosure`。见 §13、§17）
> - 1.9.0 冻结于 **2026-09-27**（**附加式 + 候选/事实隔离**：R11 剧情分支沙盘。新增 2 张表 `branch_sandboxes` / `branch_candidates` 与 9 条端点；新增模型工具 `novel_branch`（只提候选与读回；采纳 / 丢弃 / 取消 / 重开是作者动作，模型侧一律 403）。候选带依赖基线 hash 与来源；重复候选 409 且整批不写；基线变化即 `stale`，重新采纳须复核。候选未采纳前不进正文 / 正典事实 / 事件 / 角色知识 / 上下文层。见 §13、§18）
> - 1.10.0 冻结于 **2026-09-27**（**附加式 + 不可信输入边界**：R12 导入安全校验（`ai/import/guard.mjs`：大小 / 编码 / 路径穿越 / symlink / 压缩比 / 条目数与深度；零临时目录；畸形与超限安全失败、不留半导入状态）与可选的「分析并重建创作状态」流程（分批规划 / 逐批基线 / 只恢复基线一致的完成批次 / 证据必须能在原文定位 / 抽取先落候选 / **作者确认后按批短事务原子应用**）。新增 2 张表与 7 条端点（含 R05 只读的 `GET /api/novel/context/contributions?work_id=&chapter_id=`）；TXT / Markdown / EPUB 三种既有格式全部保留；宿主不做模型调用。见 §13、§19）
> - 1.11.0 冻结于 **2026-09-28**（**附加式 + 参考资料边界**：共享资料库（跨作品写作参考资料）。新增门控上下文层 `library`（`kind=cond`、`cap=1200`，标题「参考资料（非本书事实）」，排在 `recall` 之后、`story_state` 之前；**默认关闭**——`library_enabled=0` 的作品 assembled / manifest 与接入前逐字节一致）；新增登记表 `library_docs` 与 7 条端点（`GET /api/novel/library/status|search|doc`、`PUT /api/novel/library/enabled`、`POST /api/novel/library/import|import/confirm`、`DELETE /api/novel/library/doc/:id`）与模型工具 `novel_library`（检索 + 按 id 读回原文窗口）。资料不是本书事实：条目只证明「在共享资料根注册表内」、canon 记 `reference` 永不 canon，层标题与条目标注一律写明「参考资料」；普通召回层与资料层互不混层。导入链是新的本地读取面：只读显式传入的目录、白名单 `.md`/`.txt`、单文件上限、单批上限、不跟随符号链接、严格 UTF-8、默认 dry-run；导入 / 删除 / 开关为作者动作（模型侧 403）。见 §13、§20）

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

17 个层（`context.layers`）：`work / outline / memory / recall / events / foreshadows / scene / blueprint / story_tail / characters / relations / world / terms / story_state / edit_rules / author_intent / redlines`。

其中 `story_state` 是**门控层**（`gated: true`，`kind: cond`，cap 2400，排在 `redlines` 之前）：只有作品显式打开「确定性故事状态」开关时才会出现在清单里；未打开时**不出现、不进 `excluded`、不计入可执行下限**（它不是"被裁掉"，而是"不属于这套层"）。

`edit_rules`（1.6.0）是同款**门控层**（`gated: true`，`kind: cond`，cap 2400，排在 `story_state` 之后、`redlines` 之前）：作者在「创作上下文 → 编辑规则」里显式打开 `edit_rules_enabled` 后才进入清单；未打开时同样**不出现**，`assembled` / `manifest` 与接入前逐字节一致（逐字节基线 50/50 的保持方式与 `story_state` 相同）。规则块内容与版本/hash 由 `GET /api/novel/editing` 给出，并在 R05 贡献记录里以 `layer:edit_rules` + 内容 hash 留痕。

`author_intent`（1.7.0）也是**门控层**（`gated: true`，`kind: cond`，cap 2400，排在 `edit_rules` 之后、`redlines` 之前）：作品里**没有**任何作者意图、也没有**启用**的样文时，这一层根本不存在——`assembled` / `manifest` / `excluded` 与接入前逐字节一致（作者确实写了意图或启用了样文，才算显式打开这一层，不需要额外开关）。层内容 = 三级意图块（长期方向 / 当前阶段重点 / 本章意图，硬约束显式标注）+ 按预算选择的文风证据（统计口径与样文原文）；本章具体偏好可覆盖较泛偏好，但遇到带否定语义、可能静默取消长期硬约束的写法时**不做自动取舍**，冲突随层与 `author_intent.conflicts` 一起交给作者裁决。样文**只作风格证据**：不进正典事实、事件账本与角色知识（负向测试见 `.p1-baseline/test-author-style.mjs`）。
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
| **输出** | 47 张表（见 fixture `db.tables`）。1.0.0 冻结的 25 张（见 fixture `db.frozen_tables`）：works / volumes / plotlines / chapters / categories / terms / characters / character_relations / world_entries / creation_tasks / story_memories / memory_versions / plotline_characters / api_configs / chapter_save_versions / harness_jobs / story_events / writing_redlines / story_event_proposals / story_memory_proposals / chapter_reviews / ai_eval_events / app_settings / app_logs / ai_error_logs；
1.1.0 附加的 10 张（见 fixture `db.tables_added_in_v1_1`）：story_state_config（作品开关，**既有作品默认 0**）/ story_timeline_entries / story_facts / character_knowledge / story_entities / story_entity_aliases / chapter_contracts / story_state_proposals / story_snapshots / story_validations；
1.3.0 附加的 2 张（见 fixture `db.tables_added_in_v1_3`）：author_approvals（模型侧写入的一次性审批边界）/ adoption_operations（整次采纳的幂等账本）；1.4.0 附加的 1 张（见 fixture `db.tables_added_in_v1_4`）：projection_outbox（提交后失败的投影可见 / 可重试 / 重启可恢复）；1.5.0 附加的 1 张（见 fixture `db.tables_added_in_v1_5`）：ov_projection_audit（delete / rebuild 的待删除集合与范围证明，可审计）；1.7.0 附加的 3 张（见 fixture `db.tables_added_in_v1_7`）：author_samples / style_profiles / author_intents（作者样文 / 文风档案 / 三级作者意图）；1.9.0 附加的 2 张（见 fixture `db.tables_added_in_v1_9`）：branch_sandboxes（沙盘：章节时点 + 依赖基线 hash + 状态 + 来源）/ branch_candidates（候选：核心行动/冲突/人物选择/节拍/后果/风险/铺垫/意图关系 + 依赖基线 + 来源；采纳记录在 `adopted_json`）；1.10.0 附加的 2 张（见 fixture `db.tables_added_in_v1_10`）：import_rebuild_runs（导入后重建的运行：作品 / 章节源指纹 / 抽取器与 schema 版本 / 模型路由与思考档位 / 状态）/ import_rebuild_batches（批次：章节范围与索引、基线 hash、结果 hash、尝试次数、候选草稿与提案 id、状态）；1.11.0 附加的 1 张（见 fixture `db.tables_added_in_v1_11`）：library_docs（共享资料登记表：uri 唯一；删除默认只标 `marked_missing`，作者确认后才删登记行与记忆库文件） |
| **状态** | `PRAGMA journal_mode = WAL` / `foreign_keys = ON` / `busy_timeout = 5000` |
| **错误码** | 无（DB 层错误由 API 层转成 4xx/5xx） |
| **retryable** | 写冲突由 `busy_timeout` 吸收；业务层不重试 |
| **兼容策略** | **只增不减**：`CREATE TABLE IF NOT EXISTS` + `try ALTER TABLE ... ADD COLUMN`（列已存在即忽略）；**绝不** `DROP TABLE` / `DROP COLUMN` / `RENAME` / 删除用户数据 |
| **版本** | 1.11.0（累计 47 张表；1.0.0 冻结的 25 张旧表零结构改动，新增表全部是新表） |
| **不变条件** | ① 旧作品/旧章节/旧记忆继续可打开；② 对旧库零 schema 写入、零数据删除（验收实测：`sqlite_master` 指纹 `3cb7e5d9ac4f67b9` 前后一致）；③ 新增表全部是**新表**，不改旧表结构；`story_state_config.enabled` 对既有作品默认 `0`（未开启 = 行为与 1.0.0 完全一致） |
| **可观测字段** | `sqlite_master`（表/索引/视图/触发器）、关键表行数 |
| **不可绕过** | 插件不得直接读写 `novel.db`（含 `-wal` / `-shm`）；不得要求宿主"顺手"改字段 |

---

## 7. Plugin Adapter contract

| 项 | 内容 |
|---|---|
| **输入** | 插件清单 `harness-plugins/novel-writing/plugin.json`：`tools`（26 个）、`engineEndpoints`（75 条）、`dshPlugin.contract`（exports / registersToolsVia）、`identityEnv`、`proposeModeEnv` |
| **输出** | dsh 侧工具注册（`ctx.tools.register`）+ 对宿主的 HTTP 调用；插件日志经 `POST /api/logs`（layer=`plugin`） |
| **状态** | 插件进程是 dsh headless；无宿主侧长驻状态 |
| **错误码** | 与所调端点一致（见各契约）；插件自身的失败必须上报日志而不是静默 |
| **retryable** | 见 §9（按 HTTP 状态码分类） |
| **兼容策略** | 工具名与端点映射冻结；**新增**工具允许（必须同步 fixture 与文档） |
| **版本** | 1.11.0（插件面：工具 26、端点 75；1.11.0 新增门控上下文层 `library`（默认关闭：关闭时该层不存在、不进 excluded、不计入下限）与资料库端点（`GET /api/novel/library/status|search|doc` 只读，模型侧可用；`PUT /api/novel/library/enabled`、`POST /api/novel/library/import|import/confirm`、`DELETE /api/novel/library/doc/:id` 为作者动作，模型侧一律 403）与模型工具 `novel_library`；资料不是本书事实，条目 canon 记 reference、层标题与条目标注一律写明「参考资料」。1.10.0 新增 `GET /api/import/guard` 与导入后重建的五条端点（`POST /api/import/rebuild/plan|record|confirm|cancel`、`GET /api/import/rebuild/status`），其中 **confirm 是作者动作**（模型侧 403）——模型可以规划批次、记录自己的抽取结果，不能把候选确认为正式状态；导入安全判据由 `ai/import/guard.mjs` 单点执行，TXT / Markdown / EPUB 三种既有格式全部保留；同一轮把请求体上限提到 36MB 并在超限时先排空请求体再回 413。1.9.0 新增 `novel_branch` 与沙盘/候选端点；1.4.0 起新增的 `POST /api/novel/adopt`、投影查看/重试/重放/重建/审计端点，1.6.0 的 `PUT /api/novel/editing`，以及 1.7.0 的 `POST/PUT/DELETE /api/novel/style/samples`、`POST /api/novel/style/profile`、`PUT/DELETE /api/novel/author_intent` 均为**作者界面专用**，模型侧调用返回 403；`GET /api/novel/editing*`、`POST /api/novel/editing/scan`、`GET /api/novel/style/*`、`GET /api/novel/author_intent`、`GET /api/novel/state/disclosure`、`GET /api/novel/library/status|search|doc` 只读，模型侧可用；1.9.0 的沙盘开 / 候选提交 / 列表 / 单条 / 比较端点模型侧可用——**采纳、丢弃、取消、重开是作者动作，模型侧一律 403**） |
| **不变条件** | ① 1.0.0 的 15 个 `novel_*` 工具名与语义不变，1.1.0 新增 8 个（合计 23；1.3.0 新增 `novel_approvals`、1.9.0 新增 `novel_branch`、1.11.0 新增 `novel_library` 后现为 26）；② 端点面 = fixture `plugin_adapter.endpoints`（75 条）；③ 每个端点在 `server.js` 里真的存在（契约测试逐条核对） |
| **可观测字段** | 插件请求可带 `X-Trace-Op` / `X-Trace-Title`，日志 `layer=plugin` |
| **不可绕过** | 绕过 context budget / 直写全局 settings / 自建 task-trace-recovery / 直写 DB / 绕开策略表调 `/api/ai/*` |

**插件可以使用的工具**（26 个 `novel_*`：1.0.0 冻结 15 个 + 1.1.0 新增 8 个 + 1.3.0 的 `novel_approvals` + 1.9.0 的 `novel_branch` + 1.11.0 的 `novel_library`；名字与语义冻结）

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
| `novel_approvals` | 列出作者创建的一次性审批（只读）：模型侧写入必须引用作者审批，不能自行创建 |
| `novel_write_pipeline` | 编排层：预检 → 写作 → 校验 → 提案（**不自己生成正文**） |
| `novel_branch` | 剧情分支沙盘：提候选（open/submit）/ 列表 / 单条视图 / 九维比较；候选是提案、带依赖基线 hash 与来源；**采纳/丢弃/取消不在工具面内**（作者动作，模型侧 403） |
| `novel_library` | 查共享资料库（跨作品写作参考资料）：search 按关键词/分类检索、read 按 id 读回原文窗口；资料不是本书事实，引用须标注「参考资料」 |

（上表里的工具名同时出现在 fixture 的 `plugin_adapter.tools`；工具名与端点映射由 `verify-plugin-tools.mjs` 与契约测试双重核对。）
**插件可以使用的接口**（白名单，75 条端点逐条列出；第 26 条起是 1.1.0–1.11.0 新增的确定性故事状态、披露派生视图、审批、编辑规则、作者意图、剧情分支沙盘、导入重建与共享资料库端点；其中沙盘的采纳/丢弃/取消/重开、`POST /api/import/rebuild/confirm` 与资料库的导入/删除/开关仅作者界面可用）

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
GET /api/import/guard
POST /api/import/rebuild/plan
GET /api/import/rebuild/status?work_id=&run_id=
POST /api/import/rebuild/record
POST /api/import/rebuild/confirm
POST /api/import/rebuild/cancel
GET /api/novel/context/contributions?work_id=&chapter_id=
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
GET /api/novel/state/disclosure?work_id=&chapter_id=&character_id=&scene=
GET/POST /api/novel/approvals
GET /api/novel/editing
GET /api/novel/editing/rules?task=
POST /api/novel/editing/scan
GET/POST/PUT/DELETE /api/novel/style/samples?work_id=&id=
GET/POST /api/novel/style/profile?work_id=
GET/PUT/DELETE /api/novel/author_intent?work_id=&chapter_id=&tier=
GET /api/novel/branch/sandboxes?work_id=&chapter_id=
POST /api/novel/branch/sandboxes
GET /api/novel/branch/sandboxes/:id
POST /api/novel/branch/sandboxes/:id/cancel|reopen
GET /api/novel/branch/candidates?work_id=&chapter_id=&sandbox_id=&status=
POST /api/novel/branch/candidates
GET /api/novel/branch/candidates/:id
POST /api/novel/branch/candidates/:id/adopt|discard
POST /api/novel/branch/compare
GET /api/novel/library/status?work_id=
GET /api/novel/library/search?work_id=&q=&category=&limit=
GET /api/novel/library/doc?id=&offset=&limit=
PUT /api/novel/library/enabled
POST /api/novel/library/import
POST /api/novel/library/import/confirm
DELETE /api/novel/library/doc/:id
```

白名单之外，插件还可以用：`GET /api/ai/policy`（读策略快照）、`GET /api/harness/job|status|recoverable|recovered`、`POST /api/harness/cancel|mark_applied`。

**作者界面专用（不在插件白名单，模型侧一律 403）**：`POST /api/novel/adopt`（整次采纳：正文 + 选中提案 + 历史版本 + 投影 outbox 同一事务；幂等键 `operation_key`）、`PUT /api/novel/editing`（写编辑规则开关 / 档位 / 能力 / 题材档；模型侧只能读，不能改自己的规则）、`GET /api/novel/projections`（投影状态：pending/running/done/failed + 最近错误）、`POST /api/novel/projections/retry`（把 failed 复位为 pending 并立即续跑）、`POST /api/novel/projections/replay`（按当前正式版本重新投递投影，不删既有记忆）、`POST /api/novel/projections/rebuild`（默认 dry-run 返回待删除集合与范围证明；`confirm=true` 才执行，证明不了归属即拒绝）、`GET /api/novel/projections/audit`（上述破坏性操作的审计记录）；`POST /api/import/rebuild/confirm`（导入后重建的确认：把某一批的候选确认为正式提案并按批原子应用；它列在上面的插件白名单里作为端点面声明，但**模型侧调用一律 403**——模型可以规划批次、记录自己的抽取结果，不能替作者确认）；资料库写操作 `PUT /api/novel/library/enabled` / `POST /api/novel/library/import|import/confirm` / `DELETE /api/novel/library/doc/:id`（开关是作者意图；导入会读取本机目录——模型不能读本机任意目录、不能自行打开资料层或从共享资料库里删东西；只读的 `GET /api/novel/library/status|search|doc` 模型侧可用）。

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
| **版本** | `host-contract 1.11.0`；运行时可从 `GET /api/novel/ping` 读到 `host_contract`（1.0.0 → 1.11.0 全为附加式，见 §13） |
| **不变条件** | 见 §0 的 6 条质量保护不变条件 |
| **可观测字段** | `ping.host_contract`；fixture 版本；文档版本（三处互锁） |
| **不可绕过** | 插件不得假设"宿主没变"而跳过版本检查；也不得因为版本不同就自行分叉实现 |

---

## 11. 契约验证方式（真的跑，不是写着好看）

| 层次 | 工具 | 覆盖 |
|---|---|---|
| **契约测试** | `node .p1-baseline/test-host-contract.mjs`（离线清单 46 条之一；也已接进一键验收） | 代码↔契约漂移、文档↔契约腐烂、边界是否真的在代码里成立、旧库兼容；含**负向对照**（改坏预算/工具名/信封字段必须报红） |
| **契约夹具** | `docs/host-contract.v1.json` | 由真实代码导出的可机读契约面（层/预算/清单字段/策略/工具面/端点面/日志层级/表清单） |
| **adapter 测试** | `.p1-baseline/verify-plugin-tools.mjs` + `harness-plugins/novel-writing/test/smoke.mjs` | 26 个工具 ↔ 75 条端点的对账；插件冒烟 39 组 |
| **迁移/旧库兼容** | `test-host-contract.mjs`（§D）+ `api-test-suite.mjs` | 旧库 schema 指纹与表清单；旧作品/章节/记忆可读可写 |
| **宿主整体** | `node scripts/ci-isolated-run.mjs --port 3739 -- node .p1-baseline/verify-all.mjs`（隔离实例；缺活实例/外部仓库的检查会标"跳过"） | **44 通过 / 1 未通过 / 10 跳过**（2026-09-28 实测）。唯一未通过 = **先于本轮存在**的连续性预检真实数据对照（`system_frequency`），见 `docs/post-implementation-issues.md` OBS-02。⚠️ **跳过 ≠ 通过**：三条会真的 `spawn dsh` 的检查需 `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1` 才转成运行；且**不要与其它会真 spawn dsh 的探针并发跑**（并发会让"套件总闸"把探针会话误判为无法归属的真实调用，即 OBS-01） |
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
| 1.3.0 | 2026-09-27 | **附加式 + 安全边界**：新增 `author_approvals`（作者一次性审批：work/chapter/op/基线 hash/提案集合绑定、单次消费、有效期）与 `adoption_operations`（整次采纳幂等账本）；新增 `GET/POST /api/novel/approvals` 与只读工具 `novel_approvals`。模型侧（`X-Novel-Agent`）写正文/应用提案/回滚必须引用作者审批，审批不能由模型创建、不进模型 Prompt、消费与写入同事务 | 端点 44→45，工具 23→24；作者界面写入语义不变（不带该标记）；旧端点/字段/预算/层序/默认 route 均未变 |
| 1.4.0 | 2026-09-27 | **附加式 + 原子边界**：新增 `POST /api/novel/adopt`（正文 + 选中的状态/事件/记忆提案 + 历史版本 + 投影 outbox 在同一 SQLite 事务；`adoption_operations` 幂等键：同键同载荷重放返回原结果，同键不同载荷 409；选中项有任一应用不了则整次回滚）；新增 `projection_outbox` 表与 `GET /api/novel/projections`、`POST /api/novel/projections/retry`（投影失败可见、可重试、重启只凭持久化记录恢复）；同轮修复旧提案采纳路径的**嵌套事务报错**（`addStoryEvent`/`saveStoryMemory` 在宿主事务内再次 BEGIN）与带单 `id` 调用被静默当成"无提案"的 no-op | 插件工具 24 / 端点 45 **不变**；旧端点/字段/预算/层序/默认 route 均未变；`adopt` 与投影端点仅作者界面可用（模型侧 403） |
| 1.5.0 | 2026-09-27 | **附加式 + 记忆来源边界**：语义召回的来源 fail-closed 校验（`ai/openviking/recall-meta.mjs`：命名空间 / 已知布局 / 正典状态 / 未来章节四道判据；召回生产方与宿主装配器**共用同一实现**并对被拦条目留审计原因；全部被拦时改报 `filtered` 缺口而不是静默 no-hits）；新增 `ov_projection_audit` 表与作者侧 `POST /api/novel/projections/replay|rebuild`、`GET /api/novel/projections/audit`（rebuild 默认 dry-run，删除前逐条证明归属，证明不了拒绝执行；模型侧 403）；同轮修复带审批的旧提案采纳**必然判基线不符**的顺序缺陷（审批消费移到任何写入之前，仍在同一事务内） | 插件工具 24 / 端点 45 **不变**；旧端点/字段/预算/层序/默认 route 均未变 |
| 1.6.0 | 2026-09-27 | **附加式 + 门控编辑规则**：新增门控上下文层 `edit_rules`（`kind=cond`、`cap=2400`，排在 `story_state` 之后、`redlines` 之前；**默认关闭**，关闭时该层不存在、不进 `excluded`、不计入下限）；新增 `GET /api/novel/editing`（读回开关/目录/版本/hash）、`GET /api/novel/editing/rules?task=`（按任务取规则块）、`POST /api/novel/editing/scan`（只读确定性检查：规则/位置/摘录/严重性/建议，不调用模型）与作者侧 `PUT /api/novel/editing`（模型侧 `X-Novel-Agent` 403，模型不能改自己的规则） | 插件工具 24 **不变**、端点 45→48；旧层/旧端点/字段/预算/`FLEX_ORDER`/默认 route 均未变；未打开开关的作品 assembled 逐字节不变 |
| 1.7.0 | 2026-09-27 | **附加式 + 作者侧风格证据**：新增门控上下文层 `author_intent`（`kind=cond`、`cap=2400`，排在 `edit_rules` 之后、`redlines` 之前；作品没有作者意图且没有启用样文时**该层不存在**，不进 `excluded`、不计入下限）；新增 3 张作者侧表 `author_samples` / `style_profiles` / `author_intents`；新增作者侧 `GET/POST/PUT/DELETE /api/novel/style/samples`（单样文 ≤20000 字、作品 ≤20 篇 / 20 万字）、`GET/POST /api/novel/style/profile`（分析 = 确定性计数 + 计算口径，`semantic_status: not_run`，不调用模型；样文变更后旧档案标 `stale`）、`GET/PUT/DELETE /api/novel/author_intent`（三级意图，PUT 校验层级/长度/章节归属，模型侧写 403） | 插件工具 24 **不变**、端点 48→51；旧层/旧端点/字段/预算/`FLEX_ORDER`/默认 route 均未变；没有作者意图与启用样文的作品 assembled 逐字节不变；样文与意图**不进入** `story_facts` / `story_events` / `character_knowledge`（负向测试 `.p1-baseline/test-author-style.mjs`） |
| 1.8.0 | 2026-09-27 | **附加式 + 披露派生视图**：新增只读端点 `GET /api/novel/state/disclosure?work_id=&chapter_id=&character_id=&scene=`（按章时点重算作者真相 / 作者计划 / 撤回 / 角色信念 / 窗口关闭 / 未来 / 尚未披露 / 角色私有 / 读者已披露九档 + 每角色已知 / 未知 / 疑似 / 错误信念 / 未定与可执行 id；纯重算、不落库、无新表） | 插件工具 24 **不变**、端点 51→52；无新表；旧端点/字段/预算/层序/默认 route 均未变；`novel_state` 增加只读 `status=disclosure`；负向边界见 `.p1-baseline/test-disclosure.mjs`（未写完的章不得把计划说成「读者已知」、跨作品章节 404） |
| 1.9.0 | 2026-09-27 | **附加式 + 候选/事实隔离**：新增 2 张表 `branch_sandboxes` / `branch_candidates` 与 9 条端点（沙盘开 / 列表 / 单条 / 取消与重开；候选列表 / 提交 / 单条 / 采纳与丢弃；九维比较）；新增模型工具 `novel_branch`（只提候选与读回：open / submit / list / view / compare；采纳、丢弃、取消、重开不在工具面内，模型侧调用这些端点一律 403）。候选与沙盘都带依赖基线 hash（故事状态 / 正文 / 契约 / 作者意图 / 披露指纹）与来源（`created_by` = author / agent）；仅改写措辞、交换同义表达不算多候选（同批或与既有候选重复 → 409 且**整批不写**）；既有角色的行动理由受该角色**当前可行动**知识约束（`basis_ids` / `basis_keys` / `basis_note`，新角色需显式 `new_character`），未来计划不得写成已发生（422）；基线变化即 `stale`，重新采纳须复核或重新生成。采纳只写章节蓝图与可选契约建议，正文 / 正典事实 / 事件 / 角色知识 / 状态一律不动 | 插件工具 24→25、端点 52→61；旧工具 / 旧端点 / 字段 / 预算 / 层序 / 默认 route 均未变；未使用沙盘的作品装配与生成路径逐字节不变 |
| 1.10.0 | 2026-09-27 | **附加式 + 不可信输入边界**：R12 新增 2 张表 `import_rebuild_runs` / `import_rebuild_batches` 与 7 条端点（`GET /api/import/guard`；`GET /api/novel/context/contributions`（R05 只读贡献记录）；`POST /api/import/rebuild/plan|record|confirm|cancel`；`GET /api/import/rebuild/status`）。导入安全判据单点定义在 `ai/import/guard.mjs`（大小 / 严格 UTF-8 编码 / 绝对路径与 `..` 穿越 / symlink / 压缩比 / 条目数与深度；零临时目录；畸形与超限安全失败、不留半导入状态）；传输层把请求体上限提到 36MB 并在超限时先排空请求体再回 413。新增「分析并重建创作状态」：分批（≤6 章且 ≤12000 字符）、逐批基线、恢复只复用基线一致的完成批次（否则 stale，不重跑已完成章节）、证据必须能在原文定位（任一项不过整批拒绝，≤3 次重试）、抽取先落候选、**确认是作者动作**（模型侧 403）且按批短事务原子应用（拒绝/失败不留半套）；宿主不做模型调用，全链路离线可验证。TXT / Markdown / EPUB 三种既有格式全部保留 | 插件工具 25 **不变**、端点 61→68；新表 2 张（旧 44 张零结构改动）；旧端点/字段/预算/层序/默认 route 均未变；未使用重建流程的作品生成路径逐字节不变；导入安全与隔离测试见 `.p1-baseline/test-import-guard.mjs` / `.p1-baseline/test-import-rebuild.mjs` |
| 1.11.0 | 2026-09-28 | **附加式 + 参考资料边界**：共享资料库（跨作品写作参考资料）。新增门控上下文层 `library`（`kind=cond`、`cap=1200`，标题「参考资料（非本书事实）」，排在 `recall` 之后；**默认关闭**，关闭时该层不存在、不进 `excluded`、不计入下限，`library_enabled=0` 的作品 assembled / manifest 与接入前逐字节一致）；新增 1 张登记表 `library_docs`（uri 唯一；删除策略默认只标 `marked_missing`，作者确认后才删行并删记忆库文件）与 7 条端点（`GET /api/novel/library/status`（含索引时间 `ov_indexed_at:library`、分类计数、导入规则）/`search`（登记表 + 形状闸门过滤，未登记条目与 OV 伴随文件不返回）/`doc` 只读；`PUT /api/novel/library/enabled`、`POST /api/novel/library/import`（dry-run）/`import/confirm`、`DELETE /api/novel/library/doc/:id` 为作者动作）与模型工具 `novel_library`。资料不是本书事实：条目只证明「在共享资料根注册表内」、canon 记 `reference` 永不 canon；层标题「参考资料（非本书事实）」+ 条目标注「参考资料｜」；普通召回层与资料层互不混层（跨层条目一律拦下并留 `omitted` 归因）。导入链只读作者显式传入的目录（白名单 `.md`/`.txt`、单文件上限、单批上限、不跟随符号链接、严格 UTF-8、默认 dry-run、不写真实资料库的测试用 stub）。P1 真机实测（3 篇资料 + 真实 OpenViking）：命中预览 → 装配出现资料层；`readContent` 按行取回（前 30 行窗口外的内容不出现）；单条 ≤300 字；OV 生成的 `.abstract.md`/`.overview.md` 伴随文件按保留前缀规则拦下且不挤占 top-4 名额；未开开关的作品零影响；总闸 `NOVELSTUDIO_OV_DISABLED=1` 时整条链消失且不报错 | 插件工具 25→26、端点 68→75；新表 1 张（旧 46 张零结构改动）；旧工具 / 旧端点 / 字段 / 预算 / 层序 / 默认 route 均未变；未开启资料层的作品装配与生成路径逐字节不变；验证见 `.p1-baseline/test-ov-recall-boundary.mjs`（资料根用例）/ `verify-library-identity.mjs` / `verify-library-realmachine.mjs` |

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

---

## 15. 1.6.0 新增宿主能力：门控编辑规则（R07）

这一节同样是**能力地图**，不是对插件实现的承诺：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 规则资产与版本（三档编辑 / 7 条保护规则 / 7 项能力 / 7 个题材档） | `ai/editing/rules.mjs`（`EDITING_RULE_VERSION`、`ruleHash`） | `GET /api/novel/editing`、`GET /api/novel/editing/rules?task=`、清单 `edit_rules` 层的 `version`/`hash` |
| 请求侧规则块（门控层，默认关闭） | `layers.mjs` 的 `edit_rules` 层 + `server.js` 的门控构建块 | `context_manifest.edit_rules`；关闭时 `manifest` / `excluded` 里都没有它 |
| 确定性编辑扫描（**不调用模型**） | `ai/editing/scan.mjs`（`scanEditing`） | `POST /api/novel/editing/scan` |
| 能力白名单解析（未知能力不静默生效） | `resolveEditingSelection()` → `invalid[]` | `GET/PUT /api/novel/editing` 响应 |
| 模型侧只读边界（模型不能改自己的规则） | `server.js` 的 `X-Novel-Agent` 判定 | `PUT /api/novel/editing` → `403` |

**门控与预算**：`edit_rules` 与 `story_state` 一样**默认关闭**（`app_settings.edit_rules_enabled` 缺省即关）。关闭时：层不存在、不进 `manifest`、不进 `excluded`、不计入 `floor()`；打开后规则块（≤ 2400 字）进入 `assembled`，并在运行时上下文贡献记录（R05）里留下 `version` / `block_id` / `hash`，用于回答"这次精修按的是哪一版规则"。

**规则来源**：规则文本是本项目**自写**的编辑规则资产（不是第三方作品的提示词），只以版本化常量保存；第三方引用与致谢见 `THIRD-PARTY-NOTICES.md` §2.1。

**界面侧（不改契约）**：同版把旧「SillyTavern 兼容」帮助页改名为「创作上下文」，并在首页新增「借鉴与致谢」页（来源 / 许可证 / 引用提交可点击核对）——纯前端视图，不新增端点、不改变上下文预算。

---

## 16. 1.7.0 新增宿主能力：作者样文 / 文风档案 / 三级作者意图（R09）

这一节同样是**能力地图**：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 样文仓库（单篇 ≤20000 字 / ≤20 篇 / 总量 ≤200000 字；启用与停用独立） | `author_samples` 表 + `ai/style/store.mjs` | `GET/POST/PUT/DELETE /api/novel/style/samples` |
| 文风档案（句长变化/对白占比/叙述人称/标点/段落/修辞/情绪/章尾习惯 + 每项**计算口径**） | `ai/style/author-profile.mjs`（`analyzeStyle`、`STYLE_PROFILE_VERSION`） | `GET/POST /api/novel/style/profile`（响应里的 `notes` 即口径表） |
| 档案过期判据（样文增删改 / 版本变化 → `stale`，不沿用旧数字） | `isProfileStale` + 样文集合 hash | `GET /api/novel/style/profile` 的 `stale`；装配层元信息 `author_intent.profile_stale` |
| 语义分析如实标注（**当前未跑模型**：`semantic_status: not_run`，不冒充模型结论） | `style_profiles.semantic_json` / `semantic_status` | `GET /api/novel/style/profile` 的 `semantic_status` |
| 三级意图（长期方向 / 当前阶段重点 / 本章意图；可标硬约束） | `author_intents` 表（`UNIQUE(work_id, chapter_id, tier)`） | `GET/PUT/DELETE /api/novel/author_intent` |
| 冲突呈现（本章/阶段带否定语义、可能静默取消长期硬约束 → 报冲突，**不自动取舍**） | `mergeIntents().conflicts`，随请求进入意图块 | `GET /api/novel/author_intent` 的 `merged.conflicts`；装配层 `author_intent.conflicts`；界面「需要你裁决」 |
| 请求侧风格证据（门控层，默认关闭） | `layers.mjs` 的 `author_intent` 层 + `server.js` 门控构建块 | `context_manifest.author_intent`；没有数据时 `manifest` / `excluded` 里都没有它 |
| 数据边界（样文/意图**不进**正典事实、事件账本、角色知识、工具授权） | 写入路径只落 3 张作者侧表；装配只进 `author_intent` 层 | 隔离测试 `.p1-baseline/test-author-style.mjs` 的 D2/D3/D6 |
---

## 17. 1.8.0 新增宿主能力：披露派生视图（R10）

这一节同样是**能力地图**：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 九档披露分层（作者真相 / 作者计划 / 撤回 / 角色信念 / 窗口关闭 / 未来 / 尚未披露 / 角色私有 / 读者已披露） | `ai/story-state/disclosure.mjs`（`deriveDisclosure`、`DISCLOSURE_RULES`） | `GET /api/novel/state/disclosure?work_id=&chapter_id=&character_id=&scene=` |
| 角色时点知识边界（已知 / 未知 / 疑似 / 错误信念 / 未定 + 可执行 id；「未定」不冒充结论） | 同上（复用 `knowledgeOf` / `learnedByCursor`） | 同一端点的 `characters[]`；`novel_state` 的 `status=disclosure` |
| 口径（时间窗口 / 场景 / 读者已披露 / 作者计划 / 角色私有 / 未定判据） | `DISCLOSURE_RULES`（机器可读常量） | 端点响应 `rules` |
| 视图指纹（章序 + 时点 + 每事实档位窗口 + 每角色可执行集合的确定性 hash） | `disclosureFingerprint()`（`disclosure-<16hex>`） | 端点响应 `fingerprint` |
| 无缓存、每次重算（正文 / 提案 / 快照 / 回滚 / 章序变化后旧指纹一律作废） | 端点内现算，不落库 | 改章正文后 `fingerprint` 变化（测试 B9 / B12 / B13） |
| 时点必填（不能笼统说「读者知道」） | 端点校验 | 缺 `chapter_id` → `400`；跨作品章节 → `404` |

---

## 18. 1.9.0 新增宿主能力：剧情分支沙盘（R11）

这一节同样是**能力地图**：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 2—5 个候选方向（核心行动 / 冲突选择 / 人物选择 / 剧情节拍 / 可能后果 / 关系伏笔 / 风险 / 必要铺垫 / 与作者意图关系） | `ai/branch/sandbox.mjs`（`validateCandidateShape`、`SANDBOX_LIMITS`）+ `ai/branch/store.mjs` | `POST /api/novel/branch/sandboxes`、`POST /api/novel/branch/candidates`；界面「剧情分支沙盘」卡片 |
| 「不同」的机械判据（仅改措辞 / 同义表达不算多候选；核心行动规范化 + 相似度阈值 0.7） | `normalizeActionKey` / `actionSimilarity` / `checkDistinctness` / `checkDistinctAgainst` | 提交响应的 `distinctness` 报告；整批重复 → 409（一个都不写） |
| 角色知识边界（既有角色的行动理由只能引用该角色**当前可行动**的事实 id / 已知键 / 明确说明；新角色需显式 `new_character`） | `validateKnowledgeConstraints`（复用披露派生视图的 `actionable_ids` / `known`） | 提交响应 `knowledge[]`（`checked` / `has_unverified` / `has_violations`）；违规 422 |
| 未来计划不得冒充已发生（`consequences.certainty=established` 不得引用作者计划 / 未披露 / 已撤回 / 未定条目） | 同上 | 违规 422，原因逐条列出 |
| 候选依赖基线（故事状态 / 正文 / 契约 / 作者意图 / 披露指纹 → `sandbox-<16hex>`）与来源（沙盘与候选都记 `created_by` = author / agent） | `buildSandboxDeps` / `isSandboxStale` / `store.mjs` 的 `created_by` 列 | 沙盘与候选的 `deps.hash` 与 `created_by`；列表 / 单条视图的 `stale_now` + `stale_changed` |
| 列表 / 查看 / 九维比较（只列差异不打分）/ 取消 / 重启恢复（只补未完成槽位，不重跑） | `compareCandidates` / `COMPARE_DIMENSIONS` / `POST /api/novel/branch/sandboxes/:id/cancel 与 .../reopen` | `GET /api/novel/branch/sandboxes`、`GET /api/novel/branch/candidates`、`POST /api/novel/branch/compare` |
| 采纳 = 作者动作：只写章节蓝图（`chapters.blueprint_json`）+ 可选契约建议（`apply_contract:true`）；正文 / 正典事实 / 事件 / 角色知识 / 状态一律不动 | `buildAdoptionPlan` + `POST /api/novel/branch/candidates/:id/adopt`（模型侧 403） | `adopted_json` 记录来源；`boundary.never_touched` 清单 |
| stale 强制复核（基线变了：旧候选可读，重新采纳须 `recheck:true` 或重新生成；不能往旧基线的沙盘里混新候选） | 采纳 / 追加入口内现算（无缓存） | `stale_now` 为真时 `adopt` → 409；`recheck:true` → 200 并记录 |
| 候选不是本书事实（未采纳前不进正文 / `story_facts` / `story_events` / `character_knowledge` / 上下文层 / 记忆同步；进入 DSH 会话历史 ≠ 获准） | 只写 `branch_sandboxes` / `branch_candidates` 两张表 | 隔离测试 `.p1-baseline/test-branch-sandbox.mjs`（含只读 SQLite 直接核对与装配层阴性对照） |
| 模型侧工具面（只提候选与读回） | `novel_branch`（open / submit / list / view / compare） | `harness-plugins/novel-writing/novel-tools.mjs`；`verify-plugin-tools.mjs` 核对工具与端点声明一致 |

---

## 19. 1.10.0 新增宿主能力：导入安全边界与导入后重建（R12）

这一节同样是**能力地图**：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 不可信导入的安全判据（纯函数、单点定义；zip 读取器与 server 共用同一实现，避免两处漂移） | `ai/import/guard.mjs`（`IMPORT_GUARD_VERSION`、`IMPORT_LIMITS`、`IMPORT_RULES`） | `GET /api/import/guard`；`POST /api/import` 响应的 `guard`（`guard_version` / `format` / `bytes|chars` / `chapters`） |
| 归档路径与压缩边界（绝对路径 / `..` 穿越 / symlink / 深度 ≤16 / 条目 ≤2000 / 单条目 ≤128MB / 整包 ≤256MB / 压缩比 ≤200 / 只接受 stored 与 deflate） | `normalizeArchiveName` / `resolveArchivePath` / `assertArchiveEntry` + `zip-reader.mjs` | `POST /api/import`：畸形归档 → 400，且不产生半导入状态 |
| 严格文本解码（非法编码安全失败：不猜编码、不把替换字符写进正文） | `decodeTextStrict` / `assertImportText` / `assertChapters` | 同上；`GET /api/import/guard` 的 `rules.encoding` |
| 传输层上限一致（请求体上限 36MB ≥ 24MiB 文件 base64 后的 32MiB；超限时先排空请求体再回 413） | `server.js` 的 `MAX_BODY_BYTES` / `drainRequestBody` / `MAX_DRAIN_BYTES` | 超限请求得到明确的 413（而不是连接被重置） |
| 分批规划（每批 ≤6 章且 ≤12000 字符；整本书绝不作一次请求；批数 ≤4000） | `ai/import/rebuild.mjs`（`planBatches`、`REBUILD_LIMITS`） | `POST /api/import/rebuild/plan`、`GET /api/import/rebuild/status` |
| 批次基线（章节源指纹 / 抽取器版本 / schema 版本 / 模型路由与思考档位 / 结果 hash） | `chapterSourceHash` / `sourceHashOf` / `normalizeRoute` / `batchBaselineHash` / `resultHashOf` | 状态响应里的 `baseline_hash` / `result_hash` / `counts`（复用 / 过期 / 待跑） |
| 恢复判据（只复用基线一致的完成批次；正文 / 抽取器 / schema / 路由变化即 `stale`，不无条件复用旧结果） | `compareBatches` | `GET /api/import/rebuild/status` 的 `state` 与 `reason` |
| 结果 schema 与证据要求（九类对象；quote 必须能在该章原文定位；任一项不过整批拒绝；≤3 次有限重试） | `validateExtraction` / `extractionToProposals`（`REBUILD_RULES`） | `POST /api/import/rebuild/record` 的 `errors` / `stats`；状态端点回传 `rules` / `limits` |
| 候选不覆盖作者状态（抽取先落候选草稿；未确认不进正文 / 正典事实 / 事件 / 角色知识 / 长期记忆） | `import_rebuild_batches` 的候选草稿 + 既有提案设施 | 只读 SQLite 核对与装配层阴性对照：`.p1-baseline/test-import-rebuild.mjs` |
| 作者确认 = 按批原子应用（一个批次一个短事务：登记提案 + 批量应用；避免逐条应用把后一条判 stale；拒绝/失败整批回滚，不留半套） | `ai/story-state/store.mjs` 的 `applyProposalsBatch` + `StoryState.transaction` | `POST /api/import/rebuild/confirm`（模型侧 403） |
| 进度 / 取消 / 断点续跑（不重跑已完成章节；空批只登记完成） | `import_rebuild_runs` / `import_rebuild_batches` + `RebuildStore.progressOf` | `GET /api/import/rebuild/status` 的 `progress`；`POST /api/import/rebuild/cancel` |
| 零计费可验证（宿主不调用任何模型，抽取由调用方按批执行） | `handleImportRebuildRoute` 内无模型调用 | 全链路离线测试；界面提供「复制提示词给 dsh」 |
| 运行时贡献记录（只读口径，R05） | `ai/context/contributions.mjs` + `server.js` | `GET /api/novel/context/contributions?work_id=&chapter_id=`（来源 id / 版本 hash / 长度 / 去重标识 / 使用或省略原因；不记完整正文与密钥） |

---

## 20. 1.11.0 新增宿主能力：共享写作资料库（library）

这一节同样是**能力地图**：插件只能通过 §7 的工具/端点使用它们，不得依赖宿主内部文件路径。

| 能力 | 宿主实现 | 可观测入口 |
|---|---|---|
| 共享资料根注册表（唯一来源；跨作品共享，与作品记忆子树**物理隔离**） | `ai/library/library-roots.mjs`（`SHARED_LIBRARY_ROOT` = `viking://user/default/resources/novel-studio-library`、`LIBRARY_ROOTS`、`libraryRelOf`、`isLibraryUri`） | `GET /api/novel/library/status` 的 `root` |
| 资料形状闸门（恰两层 `<分类>/<slug>.md`；**任意层级** `.`/`_` 前缀拒绝；只收 `.md`） | `checkLibraryShape` | 省略归因 `library_root` / `library_bad_path` / `library_reserved` / `library_bad_shape` |
| 资料**永不 canon**（只证明「在注册根内」；canon 记 `reference`、kind 记 `参考资料`） | `ai/openviking/recall-meta.mjs` 的资料分支（`filterRecallItems` 的 `allowLibrary` 口径） | 资料层条目；跨层条目归因 `library_out_of_scope` / `not_library_item` |
| 门控上下文层 `library`（`kind=cond`、`cap=1200`、标题「参考资料（非本书事实）」，排在 `recall` 之后；**默认关闭**；零命中不插占位层） | `ai/context/layers.mjs` + `server.js` 装配点 + `openviking-sync.js` 的 `getLibraryRecall` | 上下文清单里 `library` 层的有无；`status.enabled` 与 `library_enabled:<workId>` |
| 检索窗口冻结（top-4、阈值 0.40、单条 300 字、`readContent` 前 30 行按行计、微缓存 30s/256） | `LIBRARY_RECALL`（`ai/library/library-recall.mjs`）；find 多取 `overscan=4` 条后**先过滤、再截断**（OV 给目录生成的 `.abstract.md`/`.overview.md` 分数常高于正文，必须先拦下且不挤占名额） | 层内条目文本与相关度；`novel_library` 读回 |
| 资料格式约定（不用 front matter；首行 `# 主题` + 一句话结论；`##` 分块；入库 `<分类>/<slug>.md`） | `ai/library/library-doc.mjs`（`normalizeLibraryText`、`libraryDocStats`、`slugifyLibraryName`） | `POST /api/novel/library/import` 的计划（字数 / 预估块数 / 告警，**不含正文**） |
| 导入链安全边界（白名单 `.md`/`.txt`、单文件 ≤2MB、单批 ≤500 篇、隐藏与忽略目录不深入、不跟随符号链接、严格 UTF-8 安全失败、**默认 dry-run**） | `ai/library/library-ingest.mjs`（`LIBRARY_INGEST`、`scanLibraryDir`、`planLibraryImport`） | `GET /api/novel/library/status` 的 `ingest`；`POST .../import`（计划）→ `POST .../import/confirm`（写入） |
| 登记表与删除策略（`library_docs` 表、uri 唯一 upsert；默认只标 `marked_missing`；作者 `?confirm=1` 才删记忆库文件与登记行；OV 不可用时 409 并保留登记行） | `db.js` + `ai/library/store.mjs` | `status.summary` / `status.docs`；`DELETE /api/novel/library/doc/:id` |
| 索引时间可见（异步索引不假装即时：写后约 30 秒内可召回） | `server.js` 导入确认链（`ov_indexed_at:library`） | `status.index.last_indexed_at`；confirm 响应的 `index` |
| 模型侧查回（被预算裁掉的原文按 id + 行窗口读回；只读） | `harness-plugins/novel-writing/novel-tools.mjs` 的 `novel_library`（`action=search|read`） | `GET /api/novel/library/search|doc`（模型侧可用） |
| 作者动作边界（开关 / 导入 / 导入确认 / 删除 = 作者界面专用，模型侧一律 403） | `server.js` 的 library 段（`isAgentRequest`） | 模型侧 403；`.p1-baseline/test-library-import.mjs` A2 / E1 / F2。作者界面入口（P4）：侧栏「📎 资料库」页（列表 / 检索 / 导入两段式 / 读原文 / 按作品开关 / 标记缺失与确认删除）；前端断言 `frontend-test.mjs` LIB-1…LIB-11b |
| 总闸语义（`NOVELSTUDIO_OV_DISABLED=1`：资料链整体消失、无报错；dry-run 仍可本地扫描；confirm 409 零写入；search 走关键词兜底；**即便开着资料开关，装配里也没有 `library` 层**） | `ovEffectiveEnabled()` + 端点分支 | `.p1-baseline/test-library-import.mjs` G 段（G4）；真机 `verify-library-realmachine` 的 `ov_disabled_smoke`（`library_recall.status=disabled`、`assembled_has_label=false`、HTTP 200） |

**真机证据（2026-09-28，真实 OpenViking v0.4.21 + 隔离实例；零计费）**

- `.p1-baseline/verify-library-realmachine.mjs` → **18/18**（机读证据 `.p1-baseline/verify-library-realmachine.result.json`）：写前 fail-closed（资料根必须为空）→ 只写共享资料根 3 篇 → 命中预览 → 装配出现资料层 → `readContent` 按行取回（前 30 行窗口外的内容不出现）→ 单条 ≤300 字 → 删除后回读失败、根零残留；全程不动作品子树（作品/章节用 SQL 直插，不触发 `syncWorkFull`）。
- `.p1-baseline/verify-library-identity.mjs` → **4/4**：`library_enabled=0` 的作品 assembled + manifest 与接入前**逐字节一致**（1091 / 1081 / 1014 / 1071 字；11/11/8/11 层）。
- `.p1-baseline/test-ov-recall-boundary.mjs` → **54/54**（含资料根用例：形状拒绝 / 伴随文件拦下 / 跨层互拒 / rebuild 拒绝资料根；HTTP 门控 F1–F6、F3b）。
- `.p1-baseline/test-library-import.mjs` → **34/34**（隔离实例 + OV stub，零计费：扫描 / 计划 / 开关 / dry-run→confirm / 幂等 / 查回 / 删除 / 总闸关闭）。

**边界与"不做"（对照质量红线）**

- 不给任何作品默认开开关：`library_enabled:<workId>` 缺省即关闭；未开启作品与接入前逐字节一致（有基线可证）。
- 不放宽既有 fail-closed：资料只认注册表 + 形状闸门；`recall` 层与 `library` 层互不混层。
- `rebuild` / `planRebuild` 对资料根**显式拒绝**（`library_scope`）：全量重建永远不会把共享资料当作品投影删除。
- 导入目录只读作者显式传入的路径；测试与真机验证都写隔离实例 / OV stub，绝不写作者真实记忆库与 `data/`。
