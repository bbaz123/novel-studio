# Novel Studio × dsh 创作内核（ENGINE）

本文记录创作内核的当前实现：dsh 在小说生成时**自动尊重世界观/角色卡/长期记忆/未闭合伏笔**，
按“反 AI 腔”风格契约输出，生成后自动收尾（一致性核对 → 红线扫描 → 事件/记忆**提案** → 作者确认入账）。
本插件是 novel-studio 的内置组件，**与工坊同仓维护**，不存在独立补丁仓库漂移问题。

## 一、架构（两层）

```
novel-studio（数据真相源）
  ├─ 数据表：story_events（伏笔状态/回收/去重）、memory_versions（记忆快照/回滚）、
  │          writing_redlines（红线 + 豁免词）、story_event_proposals / story_memory_proposals（入账提案）、
  │          works.*（每章目标字数/总章数/故事结构/叙事视角/正向风格要求）、chapters.blueprint_json / target_words
  ├─ 创作内核：buildNovelContext（ST 式分层装配 + 分层预算 + 蓝图层 + 目标字数 + 正向契约）、
  │          scanAgainstRedlines（对话豁免 + 整词豁免）、saveStoryMemory（版本快照 + 保留策略 + 压缩提示）、
  │          提案确认（apply/reject）、多关键词加权检索
  ├─ 端点：/api/novel/*、/api/story_memory 版本与回滚、/api/novel/proposals、/api/search
  └─ /api/harness/run：注入 NOVELSTUDIO_WORK_ID/CHAPTER_ID/MODE + NOVELSTUDIO_PROPOSE_MODE=1
        │ spawn（携带身份 env）
        ▼
dsh headless / dsh 会话（工具与人设同源：harness-plugins/novel-writing/）
  ├─（确定性层）上下文/蓝图/目标字数/红线在 prompt 侧已装配 → 生成即守设定、不 AI 腔
  ├─（agent 层）novel_* 工具：上下文按需拉取、设定查证、伏笔闭环、蓝图保存、一致性核对、
  │   产出自检、事件/记忆提案（headless）或直接入账（GUI）、正文写回
  └─（收尾层）红线扫描结果随 /harness/run 响应返回；事件/记忆提案由作者在界面确认
```

## 二、关键机制

### 1. 提案确认（headless 防污染）

- `/api/harness/run` 给子进程注入 `NOVELSTUDIO_PROPOSE_MODE=1`；
- dsh 工具检测到该环境变量后，`novel_event_add` / `novel_memory_update` 改为
  `POST /api/novel/events {proposed:true}` / `PUT /api/story_memory {proposed:true}`，
  写入 `story_event_proposals` / `story_memory_proposals`（status=pending），**不触碰真实账本**；
- 任务完成时 `GET /harness/job` 的 `proposals` 字段带回全部 pending 提案；
- 作者在「AI 写作结果」弹窗勾选采纳（随正文应用一起生效），或稍后在
  「小说设定 → 长期记忆 → 📥 待确认提案」逐条采纳/忽略；
- 采纳事件提案 = 正式 `addStoryEvent`（含伏笔回收与 dedup 幂等）；采纳记忆提案 = `saveStoryMemory`（留版本快照）。

### 2. 伏笔闭环

- `story_events` 增加 `foreshadow_status`（''/open、resolved、dropped）与 `resolves_event_id`；
- 新埋伏笔：`kind=foreshadow`（默认 open）；回收：`kind=event` + `resolves_event_id=#伏笔id`，
  服务端自动把该伏笔置 resolved；
- 作者确认废弃/恢复时：`novel_foreshadow_update`（dsh）或伏笔面板按钮（UI），
  共用 `POST /api/novel/foreshadows/:id/status`；
- `novel_context` 的【未闭合伏笔】层与 `novel_foreshadows`、`novel_consistency` 共用这一状态。

### 3. 分层上下文预算（P1–P2 重构后：**规格已单点机读**）

> ⚠️ 本节**刻意不再重抄各层数字**——上一版就是把 cap 表抄进文档，重构后整段失效。
> 唯一真源是 `ai/context/layers.mjs` 的 `LAYERS`（**13 层**，分 `fixed` / `flex` / `cond` / `entity` 四类）
> 与 `RETRIEVAL`（查回路径）；契约与不变量见 `docs/context-contract.md`，逐条验收见 `.p1-baseline/verify-retrieval.mjs`。

- **零损失层**（`fixed`：作品 / 长期记忆 / 最近事件 / 未闭合伏笔 / 写作红线）**永不参与收敛收缩**；
  角色卡是 `entity` 类，正文边界由 `buildCharacterCards` 的 5 级降级决定，**每卡的名字/身份/性格/当前状态必保**。
- 总预算 full/continuation/fragment **26,000** / settings **18,000**；**可执行下限由 `computeFloor()` 自动核算**
  （当前 full 20,547 / settings 17,356），不再手写常量。历史失误：settings 预算曾设成 12,000，
  而各层 cap 之和已超过它 → **收敛永远压不到，等于没有预算**。
- 压到下限仍超预算时，装配器产出**显式 `overflow` 标记**（不静默超限），以及 `manifest`（逐层裁剪清单）。
- **凡裁剪必可查回**（不变量 I4）：做不到查回的层**不允许裁剪**；模型侧入口见 §五。
- 记忆超过 1200 字压缩提示线时在上下文里标注，提醒模型优先压缩。

### 3f. OpenViking 语义召回层（v0.8.0）

- `buildNovelContext` 在「长期记忆」层之后装配【相关记忆检索（语义召回）】层：以当前章节
  （标题/摘要/蓝图/开头正文）+ 最近事件为查询，从 OpenViking 共享记忆库的作品子树
  （`user/default/resources/novel-studio/<workId>/`）语义召回相关片段（top 8、阈值 0.3、
  命中内容 ≤300 字/条、层预算 1400 字），响应携带 `semantic_recall`（status/hits）；
  30 秒微缓存；OpenViking 不可用/已禁用时静默跳过，装配不受影响。
- `/api/ai_context` 同样携带 `semantic_recall.hits`，工坊正文 AI 写作提示词（蓝图/成文/续写）
  在「长期记忆」之后注入召回片段，写作全程可见。
- 六类数据（章节/记忆/事件/词条/角色卡/大纲）由工坊增量同步进记忆库（写操作 2s 防抖、
  离线 pending 队列重放）；`POST /api/novel/semantic_index` 全量重建，
  `GET/PUT /api/novel/semantic` 查看/开关语义召回；`NOVELSTUDIO_OV_DISABLED=1` 整体停用。
- **缺口不再静默（D8-#5）**：期望有召回却拿不到时（OpenViking 不可用/未就绪），
  改发一层**显式占位**「相关记忆检索：本次不可用，原因=X」，而不是整层消失——
  否则模型与作者都不知道「本该有一层召回但没来」。
  判据单点在 `layers.mjs` 的 `recallGapReason`，两个响应端点同步回传 `gap` / `gap_reason`。
  ⚠️ 主动停用（`disabled`）与查询为空（`empty`）**不算缺口**：那是意图不是意外，插占位只会制造噪声，
  而噪声会让真正的缺口提示被忽略。
- 缓存版本纳入**外部可观测状态**（`ov_indexed_at:<workId>`，D8-#7）：索引一完成缓存立刻失效，
  TTL 退回纯兜底（10 分钟）——旧实现靠 120s TTL 猜"外部异步建索引完了没有"。

### 3c. 出场角色评分制与角色卡核心保底（v0.8.0）

- 出场角色选择改为评分制（`selectSceneCharacters`）：剧情线关联 +100 > 正文/摘要命中
  （每命中 +12，封顶 60）> 蓝图/作者注/最近事件提及（+10/次，封顶 40）> 最近章节摘要出场
  （+8/章，封顶 24）> 人物关系网（与信号角色直接关系 +5/条，封顶 20）；上限 16，
  兜底从「按名字前 8」改为「最近出场优先 + 名字序」，并始终补齐到 8 个。
- 名称命中走 `countNameHits`：正式名 + `characters.aliases`（逗号分隔）都参与；
  单字 CJK 名称要求词边界（左右邻居非 CJK），杜绝「云」命中「云彩/李云」类子串误报；
  多字名称直接计数。
- 角色卡层不再整层头部盲截：`buildCharacterCards` 逐卡构建，每卡名字/身份/性格/当前状态
  **必保**，背景/对话示例/系统提示/外貌/标签按 [500/400/400/400/200 → …→0] 分级压缩；
  极端超限时逐卡均分预算，保证没有角色整卡丢失。
- 作者在工坊「上下文」页签勾选的角色 = 章节级强制带入（`chapters.context_character_ids`，
  逗号分隔 id），评分 +1000 置顶，随 `/api/novel/context` 与 `/api/ai_context` 一起生效。

### 3d. 上下文预览页签与角色状态闭环（v0.8.0）

- 写作页参考面板「上下文」页签：拉取 `/api/novel/context` 展示实际装配全文 + 出场角色名单
  （区分「已自动带入 / 👤 强制带入 / 未带入」），勾选即保存为章节级强制带入。
- 角色状态闭环：`POST /api/novel/consistency` 的 `present_characters` 现带 `id` 与
  `related_events`（按名字/别名命中最近 30 条事件的摘要，≤5 条），供 AI 判断角色卡状态是否
  已被最近事件推翻；AI 用 `novel_event_add(kind="character", payload={character_id})` 记录
  新状态，作者在角色面板「⏱ 状态事件」一键把事件摘要同步为 `characters.status`。

### 3e. 上下文缓存与装配热点（v0.8.0）

- `/api/novel/context` 结果内存缓存（LRU ≤64，键 = work:chapter:mode）；任何写操作经
  `touchWork`（通用 CRUD POST/PUT/DELETE、事件/记忆/红线/蓝图/审稿/写回全覆盖）递增
  `CONTEXT_DATA_VERSION`，缓存整体失效，不会吐陈旧结果；
- 长章节只按需转换纯文本：`plainTextHead/Tail` 先按 3 倍字符截取原始 HTML 再剥标签，
  替代「全文剥标签后取头/尾」的浪费（压缩记忆、语料、前文尾巴等 6 处热点）；
- 索引补齐：`plotline_characters(character_id)`、`character_relations(from/to)`。

### 3b. 章节蓝图与目标字数（写前规划 → 落库 → 常驻锚点）

- 蓝图字段：`scene_goal`（场景目标）/ `plot_points`（情节点 3-8 条）/ `conflicts`（冲突与转折）/
  `character_changes`（出场角色状态变化）/ `hook`（下一章钩子）/ `references`（需回扣的设定/伏笔）；
- 工坊内 AI 写作流程：澄清需求 → 模型输出【蓝图】JSON → 弹窗可编辑确认 → `PUT /api/novel/chapter_blueprint`
  落库（`chapters.blueprint_json`，同时可设章节级 `target_words`）→ 按蓝图成文；
- 落库后蓝图随 `/api/novel/context` 与 `/api/ai_context` 进入写作上下文，`novel_consistency`
  以其为核对锚点；dsh GUI 会话可用 `novel_blueprint` 工具保存；
- 目标字数优先级：章节 `target_words` > 作品 `default_chapter_words`（默认 2000）> 兜底 2000；
  成文不足时工坊自动续写补足（≤2 轮拼稿），结果弹窗按目标字数对比提示。

### 4. 多关键词加权检索（/api/search）

查询词按空白拆分为多个关键词（≤5 个），全部 AND 匹配；名称/标题命中 ×3 权重、标签/身份 ×2、
内容 ×1，全词相等 > 前缀 > 包含；按得分排序取前 20，片段围绕最早命中的关键词截取；
前端对标题与片段做关键词高亮（`<mark class="search-hit">`）。

### 4b. 审稿→修稿闭环

- 成文后可在「AI 写作结果」弹窗点「🔍 先审稿再应用」：自动生成审稿报告（总评/问题逐条/优点）
  → 报告弹窗逐条勾选「确认/忽略」→ 按确认清单修稿 → 段落级差异预览（新增绿/删改红）
  → 合并到正文（旧稿自动存历史版本）；
- 报告落库 `chapter_reviews`（每章节保留最近 10 份），dsh GUI 会话可用 `novel_review` 保存；
- 差异对比为前端 LCS 段落级 diff（零依赖）。

### 4c. 批量章节生成 / 伏笔面板 / 导入导出

- 批量生成：从第一个无正文的顶层章节开始顺序生成 N 章（≤10），每章自动蓝图→成文→字数补足→写回；
  暂停/取消/失败即停（已完成章节保留）；事件/记忆走提案模式，结束统一提示确认；
- 伏笔面板：写作页右侧参考面板「伏笔」页签——未闭合/已回收/已废弃分组、跳转埋设章节、
  标记回收/废弃/恢复（`POST /api/novel/foreshadows/:id/status`）；
- 导入：TXT/Markdown 按章节标题正则拆章、EPUB 按 spine 拆章（零依赖 zip 读取器
  `zip-reader.mjs`，支持 stored/deflate），新建作品自动写入；
- 导出：整书 TXT（含卷/章标题）、整书 Markdown（#/##/###）、单章 TXT，浏览器直接下载。

### 4d. 红线豁免词 / 正向风格契约 / 记忆版本界面（v0.7.0）

- 红线豁免词：每条红线可配 `exceptions`（如「眸 → 眼眸/回眸/眸色」），扫描时命中位置与豁免词
  重叠的整词放行；`PUT /api/novel/redlines` 校验豁免词数量（≤20）与单个长度（≤100）；
- 正向风格契约：作品新增 `works.style_positive`（作品编辑弹窗配置），`renderStyleContract`
  在【写作风格红线】之后追加【正向风格要求】段，随 `/api/novel/context` 与 `/api/ai_context` 进入写作上下文；
- 红线界面化管理：写作页参考面板新增「红线」页签——查看当前生效清单（含豁免词），
  「⚙️ 管理红线」弹窗逐条增删改（类型/模式/说明/豁免词/启用），保存为作品级清单（覆盖全局默认）；
- 记忆版本界面：长期记忆页「🕘 历史版本」——版本列表、一键回滚（自动再记回滚快照）、
  「对比当前」句子级差异预览（红=旧有、绿=新增）。

### 5. 模型切换：从"改写全局文件 + 互斥"改为"每任务一份 settings"（D8-#2）

dsh 的默认模型只存在于**进程级**的 `settings.yaml`，而 headless CLI **没有任务级模型参数**
（`.p0-recon/headless.help.txt` 实抓）。历史实现因此只能"改写全局文件 → 跑 → CAS 还原"，
再靠进程内互斥串行化——结果是**服务端允许 2 并发，界面路径的实际吞吐只有 1**。

现在改走「**每任务一份独立 settings 文档** + `dsh --patch` 指过去」（`ai/task-settings.mjs`）：
不碰任何全局状态，因此**不需要互斥，吞吐回到 2**。建立失败时**回退**到旧的全局改写 + 互斥路径，
行为与历史一致——「等待模型槽位」的界面提示保留为这条回退路径的安全网（D4）。

⚠️ 有一件事必须跟着走：专用 `DSH_HOME`（决策 B）启用后，**设置文件也要跟着走**。
否则回退路径改的是 GUI 的 `settings.yaml`，而子进程读的是新 home 的——**改了等于没改**，
还会静默以默认模型运行。`harness.js` 的 `DSH_SETTINGS` 因此改为跟随 `resolveTaskDshHome()`。

证据：`.p1-baseline/exp-concurrent-models.mjs`（两个并发任务各自读到自己的模型、
全局 `settings.yaml` **逐字节未变**、零计费）与 `.p1-baseline/test-task-settings.mjs`。

### 6. 模型自压缩的零损失护栏（D8-#3 续 · 2026-09-18）

**这条是"AI 能力结合"的核心：服务端有规则，还要让模型真的按规则行动。**

长期记忆是**有损压缩**的产物，而它会喂给之后每一章——丢一个角色，摘要读起来照样通顺、
**不会报错**，是最难发现的一类损失。护栏按「章节正文里出现过没有」确定性分**两侧**：

| 侧 | 判据 | 违反后果 |
| --- | --- | --- |
| **出场过的**（主角+配角，含别名变体） | `checkCompression` | **一个都不许丢** → 拒绝落库，并**指名**缺失名单 |
| **从未出场的**被提及 | `checkNoInvention` + `inventionVerdict` | **默认放行**（用户规格「根据剧情需要出现」是允许），但**如实记日志**；要严格时设 `NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1` |

**两个入口共用同一份判据**（`ai/memory-compress-guard.mjs`）：

1. **服务端自动压缩作业**（`compressStoryMemory`，开关默认关闭）；
2. **模型自压缩**（`novel_memory_update` 传 `summary`）——**这是本次新增的一条**。
   此前护栏只管第 1 条，而人设恰恰教模型走第 2 条，于是那条路**完全没有护栏**。

判据的接线是**纯函数** `needsAgentMemoryGuard(body)`（同模块导出），语义为
「工具显式标记来源（`guard:'agent'`）**且**传了 `summary`」——刻意不写成 handler 里的字符串比较，
这样它能离线断言真值表，而不是去读 server.js 的**代码形状**（形状型断言在本项目已失效三次）。

| 输入 | 设闸？ | 为什么 |
| --- | --- | --- |
| 工具标记 + `summary` | ✅ | 模型自压缩，正是要防的场景 |
| 工具标记 + 只传 `delta` | ❌ | `delta` 经 `mergeMemoryDraft` 是**纯拼接**（不截断），丢不了东西 |
| 带 `proposed:true` | ❌ | 提案先落提案表、不碰正式账本，等作者确认时才走正式写入 |
| **无标记**（作者在界面手改） | ❌ | **作者的意图优先**——用机器判据挡住作者的手是本末倒置 |

被拒时返回 **409**（不是 400：这不是格式错，而是内容没过**可修正**的质量闸），错误文本带
**缺失名单 + `delta` 逃生口**，模型一轮内即可改正——重试就是钱，所以人设里**先**把规则讲清楚，
让模型第一次就写对。

> 为什么要 "先讲规则"：护栏只保证**不丢**，不保证**不返工**。把规则写进人设与工具描述
> （`cordis.patch.yml` 与 `agent.cordis.yml` 两侧同步）才能让护栏很少被触发。
> 验收：`.p1-baseline/test-agent-memory-guard.mjs`（28/28，含"作者手改不被拦"的阴性对照）
> 与 `test/smoke.mjs` 的 7b 组（端到端：409 拒绝且**数据库一个字未改** / 齐全通过 / 作者路径放行 / delta 放行）。

### 7. 本地安全

- 服务端不再返回 `Access-Control-Allow-Origin: *`：跨源页面无法读取 API Key 与作品数据；
- 浏览器跨源写请求（Origin 非 localhost/127.0.0.1）一律 403；
- 请求体上限 32MB（供 EPUB 导入；写请求有本机 Origin 校验兜底）；红线模式长度上限 500、regex 编译校验；
- 蓝图/审稿/正文写回等写类端点校验 `work_id` 与章节归属（chapter_blueprint/review/chapter_save），防止串作品误写。

## 三、端点一览

| 端点 | 说明 |
| --- | --- |
| `GET /api/novel/ping` | 服务探活 |
| `GET /api/novel/context?work_id=&chapter_id=&mode=` | ST 式分层上下文（full/continuation/fragment，分层预算 + 蓝图层 + 目标字数） |
| `GET/PUT /api/novel/redlines?work_id=` | 读取/全量替换红线清单（校验类型/长度/正则/豁免词；返回解析后的 exceptions） |
| `POST /api/novel/scan` | 正文红线扫描 `{work_id,text,skip_dialogue}` → hits（对话豁免 + 整词豁免） |
| `GET/POST /api/novel/events` | 事件账本读取/追加（伏笔状态/回收/dedup/proposed） |
| `GET /api/novel/foreshadows?work_id=&status=` | 未闭合（open）或全部（all）伏笔 |
| `POST /api/novel/consistency` | 一致性核对清单装配 `{work_id,chapter_id,text}` |
| `PUT /api/novel/chapter_blueprint` | 保存章节蓝图 `{work_id?, chapter_id, blueprint{6字段}, target_words}`（校验 work_id 归属） |
| `PUT /api/novel/review` | 保存审稿报告 `{work_id?, chapter_id, report:{summary,issues,strengths}}`（校验 work_id 归属） |
| `GET /api/novel/review?chapter_id=` | 读取章节最新审稿（含确认清单） |
| `PUT /api/novel/review/checklist` | 提交确认清单 `{review_id, checklist:{idx:confirmed|ignored}}` |
| `GET /api/novel/empty_chapters?work_id=` | 尚无正文的顶层章节（批量生成选章依据） |
| `POST /api/novel/foreshadows/:id/status` | 伏笔状态流转 `{status:open|resolved|dropped, resolves_event_id?}` |
| `POST /api/novel/chapter_save` | 成稿写回章节（校验 work_id 归属；旧稿存历史版本，返回红线扫描） |
| `GET /api/search?q=&work_id=` | 多关键词加权检索（AND 匹配/标题加权/片段定位） |
| `POST /api/import` | 导入 `{title, text|base64}`：TXT/Markdown 按章节标题拆章，EPUB 按 spine 拆章，新建作品 |
| `GET /api/export/txt|md?work_id=|chapter_id=` | 导出整书 TXT/Markdown 或单章 TXT（浏览器下载） |
| `GET /api/novel/proposals?work_id=` | 待确认入账提案 |
| `POST /api/novel/proposals/apply` / `reject` | 采纳/忽略提案 `{work_id, ids|all}` |
| `PUT /api/story_memory` | 提交记忆（summary/delta、proposed；返回 needs_compression） |
| `GET /api/story_memory/versions?work_id=` | 记忆版本历史（每作品保留最近 200 个） |
| `POST /api/story_memory/rollback` | 回滚到指定记忆版本 |
| `POST /api/harness/run` | 启动 dsh 任务（注入身份 + 提案模式 env，202 job_id） |
| `POST /api/harness/job` | **命名任务**作业入口（D8-#4：生成小说 / 记忆压缩并入作业设施，有进度、可取消、可落库） |
| `GET /api/harness/job?id=` | 任务状态（output/scan/proposals/stage/model_slot） |
| `GET /api/harness/recoverable` / `recovered` | 可恢复 / 已恢复任务（服务重启后仍能把结果取回） |
| `POST /api/harness/cancel` | 取消任务（`taskkill /T` 杀进程树——只杀直接子进程的话，dsh 孙进程会继续回连工坊提交提案） |
| `GET /api/harness/status` | 运行状态：`model_load: {busy, waiters}` 与 `concurrency`（D4，界面据此显示「等待模型槽位」） |
| `GET /api/ai/policy` | 模型与思考强度策略快照（`ai/policy.mjs` 单点，前端取同一份，不再各存常量） |
| `GET/POST /api/ai/eval` | AI 效果埋点：POST 记一条行为信号，GET 取聚合（采纳率 / 编辑距离 / 上下文成本；D8-#8 哨兵调它，不自己写 SQL） |

## 四、dsh 侧挂载（install.ps1 自动完成）

1. **GUI/交互会话**：agent preset 安装到 `~/.dsh/.agent-presets/novel-writing/`
   （`agent.cordis.yml` + `preset.yml` + `novel-tools.mjs`）。
2. **novel-studio 后台任务（关键）**：本目录是一个标准 **dsh bundle**
   （`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`）。profile 只需在
   `dsh.profile.bundles` 里列出 `novel-writing`，并在 `node_modules` 下放一个指向本目录的
   junction——**工坊仓库即唯一来源，不存在副本**。`cordis.patch.yml` 负责：覆盖
   `system-prompt.persona` 注入创作纪律、`insert` novel_* 工具、关闭与创作无关的通用能力。

profile 侧的实际接线由 `install-profile.mjs` 完成（零依赖 node 脚本）：补齐 profile 骨架 →
写 `dsh.profile.bundles` → 建 junction → 一次性清理旧版安装痕迹。`install.ps1` 是它的
PowerShell 入口（支持 `-Profile <名>` / `-DryRun` / `-Uninstall`）。

> **历史与迁移**：旧版把补丁片段**合并进** profile 的 `cordis.patch.yml`，并把
> `novel-tools.mjs` **复制**到 profile 目录。前者要按标记行裁剪（旧版裁剪逻辑会吞掉用户
> 后加的条目），后者会与仓库源发生版本漂移（实测 `PLUGIN_VERSION` 与 `plugin.json` 已不一致）。
> P0 专用运行时时已改为 bundle 方式，`install-profile.mjs` 会识别并清理这两类旧痕迹（带备份）。
> 旧的区块片段文件 `headless-cordis.patch.yml` 已弃用，仅为对照保留。

**专用 profile**：P0 起本插件装在专用 profile 上（`~/.dsh/profiles/novel/`），与 GUI 及其它
dsh 用途解耦。用哪个 profile 由 `harness.js` 的 `NOVELSTUDIO_DSH_PROFILE` 决定；
**P6 已执行，默认值就是 `novel`**（2026-09-15 一次性切换，证据见 `docs/p6-cutover-runbook.md`，
切换前备份在 `data/backup-p6-*`）。零成本挂载验证（死端口，不出网）见 README「验证」。

**专用 DSH_HOME（决策 B）**：写作任务的 `DSH_HOME` 指向 `~/.dsh-novel`，与 GUI 的 `~/.dsh` 分开。
原因是 dsh **每次启动 profile** 都会重建 `$DSH_HOME/profiles/node_modules` 这层共享镜像
（`healProfilesModuleFallback`，源码注释明写 *"moved installations are re-pointed"*）——
两代运行时共存时**谁后启动谁把它改指过去**，GUI 会被打回旧版。分开 home 是**消除**碰撞，
而不是让碰撞变得无害。目录不存在时自动退回共享 home（不会把任务打挂）。

启动时会打印「写作任务使用专用 DSH_HOME：…（覆盖了环境里继承来的 …）」——**这行是有意打的**：
`DSH_HOME` 会随**启动方式**而变（从 DSH 派生的终端启动时环境里已带着它，桌面快捷方式没有），
不说明的话「B 到底生没生效」只能靠猜。要换位置设 `NOVELSTUDIO_DSH_HOME`；要回到共用就删掉 `~/.dsh-novel`。

## 五、已知边界与后续

- 补丁对该 profile 的所有任务生效（P0 起的专用 profile 基本只被 novel-studio 使用）；
  人设文本已声明“非创作任务按任务执行”，无副作用。如需按任务条件化，可改用 `!!js` 判断
  `NOVELSTUDIO_WORK_ID`（见 cordis 补丁语法）。
- **上下文分层是有预算的，且被裁内容都必须能查回**（P3 落实）。装配器给每层设正文上限，
  被截断处标注「已按预算截断」。契约把「凡被裁剪必可查回」写成可断言的不变量（I4），
  逐层声明查回路径并**实测**（见 `docs/p3-retrieval-verification.md`、`ai/context/layers.mjs`
  的 `RETRIEVAL`、`.p1-baseline/verify-retrieval.mjs`）。模型侧入口：
  长期记忆 → `novel_memory_read`；事件账本 → `novel_events`；伏笔 → `novel_foreshadows(status=all)`；
  写作红线 → `novel_style_contract`；其余（世界观 / 蓝图 / 人物关系 / 角色 / 章节）→ `novel_lookup`。
  **新增会被裁剪的层时，必须同时给它声明查回路径**，否则 verify-retrieval 会报缺口。
- 记忆 delta 是“安全拼接”约定（`mergeMemoryDraft` 纯拼接、不截断，因此**丢不了东西**，不设闸）；
  语义压缩由模型在调用 `novel_memory_update` 时完成，**并受零损失护栏核对**（见 §二.6）。
  直接 `PUT /api/story_memory` 传 delta（不带 `guard:'agent'`）会得到待压缩的追加文本。
- `novel_consistency` 只做确定性清单装配，冲突判断由模型在同一轮内完成（工具返回清单文本）。
- 提案表暂无自动过期策略：pending 提案长期不处理会累积；后续可在 UI 加“一键清理”。

## 六、验证

```bash
# 服务端冒烟测试（纯 HTTP 断言，不依赖 dsh/模型）
node harness-plugins/novel-writing/test/smoke.mjs

# 手动抽查
curl "http://127.0.0.1:3737/api/novel/ping"
curl -X POST "http://127.0.0.1:3737/api/novel/scan" -H "Content-Type: application/json" \
  -d '{"text":"他嘴角勾起一抹冷笑，眼中闪过一丝复杂。"}'
curl -X POST "http://127.0.0.1:3737/api/novel/scan" -H "Content-Type: application/json" \
  -d '{"text":"“你嘴角勾起的弧度出卖了你。”她淡淡道。","skip_dialogue":true}'
```
