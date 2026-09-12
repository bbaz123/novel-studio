# 小说工坊（novel-studio）上下文记忆功能分析报告

> 分析对象：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`（版本 0.9.1，零依赖 Node.js + SQLite + 浏览器 SPA）
> 分析方式：源码逐层精读（server.js / db.js / openviking.js / openviking-sync.js / harness.js / harness-plugins/novel-writing/novel-tools.mjs / public/app.js）+ 端到端冒烟实测
> 实测依据：`harness-plugins/novel-writing/test/smoke.mjs`（23 项断言，22 项通过，1 项为计时分辨率抖动，详见 §9）

---

## 摘要（结论先行）

小说工坊的「上下文 / 记忆」不是单一机制，而是一套**四层协同的记忆架构**：

1. **确定性分层上下文装配层**（`buildNovelContext` / `buildAIContext`）——按「ST 式分层预算」把大纲、长期记忆、事件账本、伏笔、场景、角色卡、世界观、红线等拼装成一份 ≤26000 字的上下文；
2. **长期记忆子系统**（`story_memories` + `memory_versions`）——git 式版本快照、可回滚、超线压缩提示、AI 自动压缩；
3. **事件账本 / 伏笔账本**（`story_events`）——记忆的“增量事实来源”，伏笔闭环、幂等去重；
4. **OpenViking 语义记忆层（RAG）**——把六类小说数据向量化进共享记忆库，写作时按场景语义召回“分层预算漏掉”的相关片段。

AI 调用则分**两条通道**：直连 `callAI`（OpenAI 兼容 Chat Completions，秒级）与 **DeepSeek Harness headless 子进程**（带 `novel_*` 工具、可读/写上下文与记忆，分钟级）。两条通道都吃同一套上下文装配产物，记忆写入在 headless 场景下走**提案确认**（human-in-the-loop），防止 AI 污染真实账本。

---

## 一、系统架构总览（AI 调用拓扑）

关键架构事实：

- **数据真相源是本地 SQLite**，OpenViking 记忆库是其**只读投影/语义索引**（增量同步 + 全量重建，非双向对等）；
- AI 不直接改库：headless 生成任务以 `NOVELSTUDIO_PROPOSE_MODE=1` 运行，事件/记忆写入先落**提案**，作者确认后才入账。

数据流：

```
novel-studio SQLite（真相源）
   │  2s 防抖增量同步 / 全量同步
   ▼
OpenViking 共享记忆库（RAG）：viking://user/default/resources/novel-studio/<workId>/
   │  语义召回（find + readContent）
   ▼
上下文装配（buildNovelContext / buildAIContext，分层预算 + 语义召回层）
   ├── 直连通道 callAI()  →  /v1/chat/completions（秒级，write/polish/expand/…）
   └── Harness 通道 runHarnessTask()  →  spawn pnpm dsh --profile headless（分钟级，novel_* 工具）
```

---

## 二、AI 调用路径详解

### 2.1 直连通道（`callAI`，server.js:437–501）

- 目标：OpenAI 兼容 Chat Completions 端点，`chatCompletionsUrl()` 自动在 `/v1/chat/completions` ↔ `/chat/completions` 两种路径形态间回退；
- 配置来源：`api_configs` 表（`base_url / api_key / model / temperature / max_tokens`），默认 `https://api.deepseek.com`、模型 `deepseek-v4-pro`；
- 模型归一化白名单：`deepseek-chat / deepseek-reasoner / deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp`；
- **输出上限**：`MAX_OUTPUT_TOKENS = 393216`（DeepSeek V4 接口实际上限，用于把“无上限”映射到接口上限）；
- **超时**：`AI_REQUEST_TIMEOUT_MS = 30 分钟`（思考模式 + 大 max_tokens 放宽，避免中途 abort）；
- 用途（`/api/ai/*`）：`write / polish / expand / personality / outline / chat / test / generate_novel / pipeline`。

### 2.2 Harness 通道（`runHarnessTaskWithProgress`，harness.js:244–422）

- 通过 `node + corepack pnpm.js dsh --profile headless "<prompt>"` **无 shell** 启动 dsh 子进程（HA-06 修复：去 shell:true 防命令注入）；
- 子进程挂载 `harness-plugins/novel-writing/novel-tools.mjs` 的 12 个 `novel_*` 工具（上下文/查证/伏笔/蓝图/一致性/自检/事件/记忆/审稿/写回）；
- 注入身份环境变量：`NOVELSTUDIO_WORK_ID / NOVELSTUDIO_CHAPTER_ID / NOVELSTUDIO_MODE / NOVELSTUDIO_BASE_URL / NOVELSTUDIO_PROPOSE_MODE=1`，并把 `OPENVIKING_PEER_ID` 固定为工坊派生 peer（与 GUI 会话共享同一记忆库）；
- 模型切换：CAS 方式临时改写 `~/.dsh/settings.yaml` 默认模型，**进程内互斥串行化 + CAS 还原**，避免并发竞态与崩溃残留（HA-04）；
- 超时默认 10 分钟，可取消（`killChildTree` 杀 pnpm→dsh 进程树）。

### 2.3 双通道职责划分与回退（public/app.js）

| 任务 | 通道 | 说明 |
| --- | --- | --- |
| 写作/润色/扩写/人格/大纲/闲聊/连通性测试 | **直连优先** | `DIRECT_AI_ACTIONS` 集合，直连失败/空回复才回退 Harness |
| 整章「AI 写作」（蓝图→成文→字数补足） | Harness | 需 `novel_*` 工具读写上下文与记忆 |
| 批量章节生成 / 审稿 / 修稿 / 工作台流水线 / 角色生成 / 对话生成 / 记忆压缩 | Harness | 多阶段、需创作内核 |
| 工作台流水线（世界观→角色→大纲→正文→审查） | 直连优先、Harness 兜底 | 按 fast/balanced/deep 三档路由 flash/pro |

模型路由（工作台流水线，`PIPELINE_MODEL_BY_MODE`）：`fast=全 flash`、`balanced=世界观/角色 flash + 大纲/正文/审查 pro`、`deep=全 pro`。整章 AI 写作默认 `deepseek-v4-pro`，短任务优先 `deepseek-v4-flash`。

---

## 三、上下文装配机制（Context Assembly）

存在**两套装配**，规则刻意保持同源，避免分叉：

| 装配器 | 端点 | 用途 | 层数 |
| --- | --- | --- | --- |
| `buildAIContext(chapterId)` | `GET /api/ai_context` | 工坊 UI 预览 + 前端注入正文写作提示词 | 轻量（角色卡/世界观/记忆/前文/事件/红线/蓝图/作者注） |
| `buildNovelContext(workId, chapterId, mode)` | `GET /api/novel/context` | dsh `novel_context` 工具、创作内核 | **13 层 ST 式** |

`mode`：`full`（整章代写/分析）/ `continuation`（接龙，前文尾巴最长 4000 字）/ `fragment`（片段补写）。

### 3.1 分层预算表（`buildNovelContext`，server.js:1435–1456）

| 层 | 预算（字） |
| --- | --- |
| 作品（标题/简介/写作配置） | 900 |
| 卷/剧情线/章节进度（大纲） | 2800 |
| **长期记忆（已发生的故事摘要）** | 2200 |
| **相关记忆检索（语义召回）** | 1400 |
| 最近事件（事件账本） | 1800 |
| 未闭合伏笔（写作必须照顾） | 1200 |
| 当前场景 | 1200 |
| 本章蓝图（写作必须遵守） | 1500 |
| 前文衔接 | 1600–4000（按 mode） |
| 出场角色卡 | 4000 |
| 人物关系 | 800 |
| 激活的世界观设定 | 3000 |
| 写作风格红线 | 4000 |

**总预算收敛**：`TOTAL_BUDGET = 26000` 字；超限时按「前文衔接 → 大纲 → 世界观」弹性层依次收缩（`FLEX_CAPS = [2400,1600,800,400]`），**红线层不动**；收敛按**层名定位**而非下标（修复人物关系层为空时下标错位误伤红线层）。

### 3.2 出场角色评分制（`selectSceneCharacters`，server.js:731–787）

评分维度（自上而下降权，`SCENE_CHAR_CAP=16`、兜底补足到 8）：

1. 剧情线关联：+100
2. **作者强制带入**（`chapters.context_character_ids`）：+1000（最高优先）
3. 正文/摘要命中：+12/次，封顶 60
4. 蓝图/作者注/最近事件提及：+10/次，封顶 40
5. 最近章节摘要出场：+8/章，封顶 24
6. 人物关系网（与 ≥10 分信号角色的直接关系）：+5/条，封顶 20

名称命中 `countNameHits`：正式名 + `aliases` 都参与；**单字 CJK 名要求词边界**（左右邻居非 CJK），杜绝“云”误命中“云彩/李云”；多字名直接计数。

### 3.3 角色卡分级压缩（`buildCharacterCards`，server.js:792–828）

- 核心字段（名字/身份/性格/当前状态）**必保**；
- 长字段（背景/对话示例/系统提示/外貌/标签）按 `[500,300,150,80,0] → [400,200,100,0] → … → 0` 逐级压缩；
- 极端超限时逐卡均分预算（≥160 字/卡），保证没有角色整卡被“整层头部盲截”丢失。

### 3.4 世界观词条筛选（`pickWorldEntries`）

固定（`is_pinned`）优先 + 关键词命中，按 `priority` 降序，限量 30。

### 3.5 大纲省略策略

长作品只给「前 30 节 + 最近 40 节」，中间以 `（中间 N 章已省略…）` 标注，避免大纲撑爆上下文。

### 3.6 前文衔接（`storyTail`）

`plainTextTail` 取上一节尾部纯文本（接龙模式取当前节尾部 4000 字）；`plainTextHead/Tail` 先按 3 倍字符截取原始 HTML 再剥标签，避免全文剥标签的性能浪费。

---

## 四、长期记忆子系统（Long-term Memory）

### 4.1 数据结构

- `story_memories(work_id UNIQUE, summary, updated_at)`：每个作品一行“已发生故事摘要”；
- `memory_versions(work_id, summary, source, note, created_at)`：git 式版本快照，保留策略 `MEMORY_VERSION_KEEP = 200`（超出剪除最旧）。

### 4.2 写入与版本快照（`saveStoryMemory`，server.js:636–668）

- 与旧摘要相同则 `unchanged` 短路；
- 每次变更**自动写一条 `memory_versions` 快照**（`source` 记录来源：manual/auto/proposal/rollback）；
- 返回 `needs_compression`（`summary.length > MEMORY_COMPRESS_HINT = 1200`）。

### 4.3 压缩机制

- **压缩提示线**：记忆超 1200 字时，上下文「长期记忆」层末尾注入 `⚠ 记忆已 N 字…请优先用 novel_memory_update 压缩合并`，提示模型收尾时主动压缩；
- **AI 自动压缩**（`compressStoryMemory`，server.js:676–694）：汇总作品章节/角色/世界观 → `runHarnessTask`（模型 `deepseek-v4-pro`）→ 生成 **≤800 字**压缩摘要 → `saveStoryMemory`。这是唯一一条以 `runHarnessTask`（而非 callAI）驱动、且**直接入账**（不走提案）的记忆写路径。

### 4.4 增量合并（`mergeMemoryDraft`）

`delta` 模式安全拼接约定：`新进展 + 【此前进度】旧摘要`；真正的语义压缩由模型在 `novel_memory_update` 调用时完成（传 `summary`）。

### 4.5 提案确认（human-in-the-loop）

headless 任务里 `novel_memory_update` 传 `proposed:true` → 落 `story_memory_proposals(status=pending)` → 作者在「长期记忆 → 📥 待确认提案」采纳后才 `saveStoryMemory`（留版本快照）。空提案按拒绝处理，防止把记忆覆盖为空串。

### 4.6 回滚（`rollbackMemory`）

`POST /api/story_memory/rollback {version_id}` 把指定版本写回当前摘要，并**再记一条 rollback 快照**；UI 提供版本列表 + 句子级差异对比。

---

## 五、事件账本与伏笔（增量记忆的事实来源）

`story_events` 是长期记忆的**增量来源**，也是伏笔闭环与一致性核对的依据：

- `kind`：`event / foreshadow / character / status_change / setting_change`；
- **伏笔闭环**：新埋伏笔 `kind=foreshadow`（`foreshadow_status='open'`）；回收用 `kind=event + resolves_event_id=#伏笔id`，服务端自动置 `resolved` 并回链；
- **幂等去重**：`dedup_key` + `(work_id, dedup_key)` 唯一索引（事务内查重 + 唯一约束兜底并发竞态）；
- `listStoryEvents(workId, limit)`：装配上下文取最近 30 条、出场角色评分取最近 200 条、语义召回查询取最近 12 条；
- 未闭合伏笔层 `open_foreshadows` 取前 20 条，`novel_consistency` 与其共享状态。

---

## 六、OpenViking 语义记忆层（RAG）

### 6.1 存储布局（openviking-sync.js:1–15）

六类数据渲染成 Markdown 写入共享记忆库：

```
viking://user/default/resources/novel-studio/<workId>/
  meta.md          作品标题/简介/作者注
  long-memory.md   长期记忆/故事摘要
  events.md        事件账本与伏笔（近 300 条）
  outline.md       大纲/剧情线
  settings/<termId>.md   设定词条
  characters/<charId>.md 角色卡（含人物关系）
  world/<entryId>.md     世界观词条
  chapters/<chapterId>.md 章节正文（纯文本，≤200000 字/章）
```

向量化由 OpenViking 服务端完成（本地 `bge-small-zh` 512 维 embedding）。

### 6.2 同步机制（增量 + 全量 + 离线重放）

- **增量**：写操作 → 2 秒防抖（`DEBOUNCE_MS=2000`，按 `kind:workId:id` 合并）→ 渲染当前 DB 行 → `write(replace)`；
- **全量**：`syncWorkFull` 分批 `batchWrite`（≤200 op/批、≤12MB/批），全部成功才写 `ov_indexed_at:<workId>` 索引标记（避免假成功，OS-07）；
- **离线重放**：写失败落 `data/openviking-pending.jsonl`（内存权威队列 + 原子文件镜像），每 45 秒重放，同 URI 合并、死信 `QUEUE_MAX_ATTEMPTS=3` 后落 `openviking-dead.jsonl`；
- **启动自动建索引**：`autoIndexExistingWorks` 对 `ov_indexed_at` 缺失或过期的作品补全量同步（时间戳归一化比较，兼容空格/ISO 两种格式）。

### 6.3 语义召回（`getSemanticRecall`，openviking-sync.js:486–542）

- **查询构造**（`buildRecallQuery`）：作品标题 + 当前章节（标题/摘要/蓝图/开头正文 ≤800 字）+ 最近 12 条事件，截断 ≤1600 字；
- **检索**：`ovClient.find(query, {targetUri: workDir, limit: 8, scoreThreshold: 0.3, timeoutMs: 6000})`；
- **命中回填**：并行 `readContent`（各 5s 超时），每条 ≤300 字，组装成 `【label】（相关度 N%）\ntext`；
- **注入**：作为「相关记忆检索（语义召回）」层（预算 1400 字）拼进 `buildNovelContext`；`/api/ai_context` 同样携带 `semantic_recall.hits`，前端 `aiContextBlock()` 在「长期记忆」之后注入召回片段；
- **缓存**：30 秒微缓存（`RECALL_TTL_MS=30000`，LRU `RECALL_CACHE_MAX=256`），键 = `workId:chapterId`；
- **降级**：OpenViking 不可用/禁用/无命中时静默跳过（`status=unavailable/no-hits/disabled/empty`），**绝不阻塞写作**。

### 6.4 检索合并（`semanticSearchMerge`）

`/api/search`（`novel_lookup` 与全局搜索共用）：关键词结果（多关键词加权 AND 检索）+ 语义结果（`find` limit 6、阈值 0.25）并列返回。

### 6.5 开关与环境总闸

- `GET/PUT /api/novel/semantic` 查/改语义召回开关（`app_settings.ov_semantic_enabled`）；
- `NOVELSTUDIO_OV_DISABLED=1` 环境总闸（冒烟/隔离环境用，优先于界面开关）；
- 凭证解析链（与 dsh 插件同源）：`OPENVIKING_*` 环境变量 → `~/.openviking/ovcli.conf` → `ov.conf` → 默认 `http://127.0.0.1:1933`。

---

## 七、上下文缓存与失效

- `CONTEXT_CACHE`：`/api/novel/context` 结果内存缓存（`Map`，LRU `CONTEXT_CACHE_MAX=64`，键 = `novel:workId:chapterId:mode`）；
- **失效机制**：`touchWork(workId)` 递增 `CONTEXT_DATA_VERSION`，任何写操作（通用 CRUD POST/PUT/DELETE、事件/记忆/红线/蓝图/审稿/写回）都使缓存**整体失效**，命中时校验版本号，不会吐陈旧结果（smoke 实测已验证“写操作后返回新数据”）；
- 语义召回层另有独立的 30s TTL 微缓存，与上下文主缓存解耦。

---

## 八、一致性与红线（记忆一致性保障）

- **红线（反 AI 腔）**：`writing_redlines`（kind = word/phrase/regex，全局默认 + 作品级覆盖），`scanAgainstRedlines` 确定性扫描——支持**对话豁免**（先剥引号内对话再扫）与**整词豁免**（`exceptions`）；`renderStyleContract` 生成“写作风格契约 + 正向风格要求”随上下文注入；生成后红线扫描结果随 `/harness/run` 响应返回；
- **一致性核对**（`/api/novel/consistency`）：确定性装配核对清单——未闭合伏笔、出场角色（含 `related_events` 供 AI 判断角色状态是否已被最近事件推翻）、最近事件、长期记忆、红线扫描；冲突判断由模型在同一轮内完成（工具只返回清单文本）。

---

## 九、实操验证（端到端冒烟实测）

运行 `node harness-plugins/novel-writing/test/smoke.mjs`（自启动隔离服务、临时 DB、`NOVELSTUDIO_OV_DISABLED=1`，不依赖 dsh/模型/API Key）。

**结果：23 项断言，22 项通过，1 项为计时分辨率抖动（非功能缺陷）。**

通过的 22 项覆盖了本报告核心机制：

| 分组 | 验证项 |
| --- | --- |
| 分层上下文 | 分层上下文（伏笔层 + 红线层保底）、作品写作配置（字数/总章数/结构/视角）、章节蓝图（保存/带入/字数覆盖/空蓝图拒绝） |
| 红线 | 命中 + 对话豁免、豁免词整词放行、正向风格契约、非法红线拒绝 |
| 事件/伏笔 | 伏笔闭环（open→resolved）+ 事件幂等、伏笔状态流转 |
| 记忆 | 记忆版本快照 / 压缩提示 / 回滚、提案确认流（pending→apply→入账） |
| 角色评分 | 别名命中/蓝图提及/单字防误命中/角色卡核心保底/兜底/强制带入/角色相关事件 |
| 一致性/检索 | 一致性核对清单、多关键词加权检索 |
| 其它 | 导入拆章、EPUB 解析、正文写回（历史版本）、跨源拒绝/无 CORS 通配、写类端点 work_id 归属校验 |

**唯一失败项**（第 13 组）：`缓存命中应快于首次装配（首次 14ms，命中 14ms）`。

判定为**计时分辨率抖动，而非缓存正确性缺陷**：该断言要求 `cacheMs < firstMs`，在空库、装配仅 14ms 时，`performance.now()` 两次采样都落在同一毫秒内（14 vs 14），无法体现缓存收益。同组「缓存失效正确性」断言（写操作后必须返回新数据）**通过**，证明缓存机制本身工作正常。该处若需根治，可在基准段改用更粗粒度样本或对空库放宽 `<=` 比较。

---

## 十、观测结论与改进建议

### 10.1 架构优点

1. **确定性装配优先、语义召回兜底**：分层预算 + 评分制保证“该带的必带”，语义召回补“预算/关键词漏掉的相关信息”，两条路径解耦、语义层可静默降级；
2. **记忆写入有版本可回滚**（git 式），并有人工确认闸门（提案模式），AI 不自作主张污染账本；
3. **零依赖 + 缓存 + 防抖 + 离线重放**，在纯 Node 环境跑通 RAG 全链路，工程化程度高。

### 10.2 观测到的边界 / 建议

1. **记忆压缩是唯一“直接入账”的 AI 写路径**（`compressStoryMemory` 不走提案，直接 `saveStoryMemory`）：它会覆盖现有摘要并落版本快照，回滚可兜底，但与提案模式的“作者确认”语义不一致，建议视产品定位决定是否也走提案或加“压缩前快照提示”；
2. **`mergeMemoryDraft` 是文本拼接而非语义压缩**：`delta` 直写会得到“新进展 + 【此前进度】旧摘要”的待压缩文本，若模型持续只传 delta 不传 summary，摘要会线性膨胀，最终依赖压缩提示线 + 手动/AI 压缩收敛——长期无人值守时需留意膨胀；
3. **语义召回查询依赖章节已写入内容**：新章节正文为空时查询主要靠标题/摘要/蓝图，召回质量取决于这些元信息的完整度（与出场角色评分同样依赖蓝图/作者注）；
4. **记忆库是“投影”而非双向同步**：从 OpenViking 侧删除/修改文件不会回写 SQLite（`removeWorkFromMemory` 只清作品子树），两者一致性以工坊 DB 为真相源，方向是单向的；
5. **缓存正确性已验证，性能基线断言存在计时抖动**：见 §9，建议修复基准测试的计时比较（改用 `<=` 或提高样本量），避免 CI 偶发红。

---

### 附：关键常量速查

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `MAX_OUTPUT_TOKENS` | 393216 | server.js:432 |
| `AI_REQUEST_TIMEOUT_MS` | 30 min | server.js:434 |
| `TOTAL_BUDGET`（上下文总预算） | 26000 字 | server.js:1454 |
| `MEMORY_COMPRESS_HINT` | 1200 字 | server.js:630 |
| `MEMORY_VERSION_KEEP` | 200 | server.js:632 |
| `SCENE_CHAR_CAP` / `SCENE_FALLBACK_COUNT` | 16 / 8 | server.js:700–701 |
| `RECALL_MAX_HITS` / `RECALL_SCORE_THRESHOLD` / `RECALL_TTL_MS` | 8 / 0.3 / 30s | openviking-sync.js:434–436 |
| `semanticSearchMerge` limit / threshold | 6 / 0.25 | openviking-sync.js:551–552 |
| `DEBOUNCE_MS`（增量同步防抖） | 2000ms | openviking-sync.js:187 |
| pending 队列重放间隔 / 重试 / 上限 | 45s / 3 / 1000 | openviking.js:226–350 |
| `CONTEXT_CACHE_MAX` | 64 | server.js:157 |