# A1 · AI 写作调用链专项审计

- **审计对象**：`novel-studio`（零依赖 Node + SQLite 小说工坊）
- **声明基线**：分支 `refactor/p0-p6`，HEAD `565a30a79f0d0cc7b8aeceac639d13ce9a01be8a`
- **实际审计对象**：**工作树（含未提交改动）** —— 见 §0.2，这一点影响 2 条结论的可追溯性
- **平台**：Windows 11 / Node v24.19.0（`node --version` 实测）
- **审计方式**：只读取证。未修改/创建/删除被审计仓库中任何源码文件；唯一写入为本文件
- **未执行**：任何会写仓库的脚本、`npm install`、`git add/commit/checkout`；未读取 `data/`、任何 `*.db`、任何 `.env`、`.verify-*` / `.test-data-*` / `.p0-recon/`

---

## 0. 基线与可追溯性

### 0.1 审计目标文件指纹（工作树状态，SHA256 前 16 位）

| 文件 | 行数 | sha256(16) |
|---|---|---|
| `server.js` | 8895 | `BB75E16C39F47403` |
| `harness.js` | 994 | `8343976662826994` |
| `ai/harness-pool.mjs` | 362 | `39B6C237B5802567` |
| `ai/harness-sdk-worker.mjs` | 117 | `DCE7B41F7D0D0F77` |
| `ai/harness-env.mjs` | 111 | `0A93F2B0423ED103` |
| `ai/context/assembler.mjs` | 221 | `59DB2CF89431418A` |
| `ai/context/layers.mjs` | 426 | `EF3303CD50915F74` |
| `ai/context/tokens.mjs` | 66 | `D4158EC739048C9D` |
| `ai/context/cache.mjs` | 52 | `0E75F2845314B4AD` |
| `ai/context/contributions.mjs` | 234 | `AF5D9DA812FD0011` |
| `ai/context/integrity.mjs` | 134 | `D876BFC41C6CC74A` |
| `ai/policy.mjs` | 140 | `CAB942A76BC06656` |
| `ai/task-settings.mjs` | 252 | `FC2357176F5D4E31` |
| `ai/direction.mjs` | 119 | `CDA1DF4B8DB329D6` |
| `ai/continuity-guard.mjs` | 357 (按 `Measure-Object -Line` 去空行计 357) | `2AA4524F9F830B01` |
| `ai/story-state/injection.mjs` | 165 | `C5044D99E1D13803` |
| `ai/story-state/semantic-context.mjs` | 194 | `A14C6559979B4505` |
| `ai/story-state/preflight.mjs` | 232 | `5D25A2D7DBD7DCD3` |
| `ai/story-state/contract.mjs` | 284 | `6EAF364376E24C00` |
| `harness-plugins/novel-writing/novel-tools.mjs` | 1323 | `BF705CFD97BCC105` |
| `docs/ai-core.md` | 227 | `A944FA6A71F2BA68` |
| `docs/context-contract.md` | 406 | `41ADBE2C1921DCF0` |

> 行数口径：`Get-Content | Measure-Object -Line` **不计空行**。`read`/`grep` 工具给出的行号是文件真实行号（`server.js` 共 **8895** 行），本报告全部引用 `read`/`grep` 行号。

### 0.2 ⚠️ 基线偏差（A1-14，可追溯性前提）

`git status --porcelain` 显示工作树**不干净**：15 个已跟踪文件被改（**+773 / −53**），另有 21 个未跟踪文件。

```
 server.js                                      | 279 ++++++++++++++++--
 public/app.js                                  | 232 ++++++++++++++++-
 frontend-test.mjs                              | 216 +++++++++++++++++++-
 ai/context/assembler.mjs                       |   7 +-
 harness-plugins/novel-writing/novel-tools.mjs  |   7 +-
 db.js                                          |  23 +++
 ...
 15 files changed, 773 insertions(+), 53 deletions(-)
```

**这些未提交改动正落在本次审计的关键路径上**，具体两处（`git diff -U3 -- server.js` 实测）：

1. `buildNovelContext` 的 **temporal** 分支：
   - HEAD：`if (builtTemporalState.text) {` → 状态为空时**整层静默消失**
   - 工作树：`if (builtTemporalState.text || StoryState.isEnabled(workId)) {` + 显式占位文案
2. `buildNovelContext` 的 **legacy** 分支：同样从 `if (built && built.text)` 改为
   `if (built && (built.text || StoryState.isEnabled(workId)))` + 显式占位文案
3. `ai/context/assembler.mjs` 收缩循环：新增 `const appliedCap = Math.min(Number(cap), declaredCap);`
   （HEAD 版本会把 flex 层的 cap **调大**到 `FLEX_CAPS` 档位，可能越过层规格声明的 cap）

**因此**：本报告对代码行为的描述一律以**工作树**为准（那才是实际运行的代码）；凡结论依赖上述三处的，均在条目内标注「HEAD 基线不成立」。若委托方要的是 HEAD 的结论，需重新核对 A1-13 与 A1-02 的相关表述。

---

## 1. 模块地图

```
┌ 浏览器 SPA  public/app.js（14614 行）
│   提示词构建：buildAIWritingBlueprintPrompt / buildAIWritingProsePrompt /
│              buildAIReviewPrompt / buildAIRevisionPatchPrompt …（全部单条 role:'user'）
│   通道选择：directAIWrite（非流式）/ streamAIDirectWrite（SSE）/ runHarnessJob（子进程）
│   上下文：loadAIContext → state.aiContext → aiContextBlock()
│   JSON 抢救：extractJSONFromText / parseBlueprintJSON / parseAIWritingOutput / detectNonProseOutput
│
├ HTTP 服务  server.js（8895 行）
│   ├ POST /api/ai/<action>            → callAI（直连，非流式）
│   ├ POST /api/ai/write_stream        → handleAIWriteStream → callAIStream（SSE 直连）
│   ├ GET  /api/ai_context             → buildAIContext + buildNovelContext（预算内 assembled）
│   ├ GET  /api/novel/context          → buildNovelContext（唯一装配入口）
│   ├ POST /api/harness/run | /job     → createHarnessJob → runHarnessTaskWithProgress（spawn dsh）
│   └ /api/novel/state/* /story_state/* → 确定性故事状态读写与预检/校验
│
├ 上下文内核  ai/context/
│   ├ layers.mjs        层规格唯一来源：LAYERS(18) / TOTAL_BUDGET / FLEX_ORDER / FLEX_CAPS
│   │                   / RETRIEVAL(查回路径) / PROVENANCE(溯源) / computeFloor()
│   ├ assembler.mjs     唯一装配器：renderSection + 收敛循环 + manifest/envelope/integrity
│   ├ tokens.mjs        token 规模估算（CJK 1 字≈1 token；**不参与预算**）
│   ├ integrity.mjs     C1–C8 逐条重算（PASS/WARNING/FAIL）
│   ├ cache.mjs         上下文 LRU 缓存（TTL + 数据版本 + 外部版本）
│   └ contributions.mjs 运行时贡献记录（只读端点）
│
├ 故事状态内核  ai/story-state/（18 模块 + temporal/ 22 模块）
│   ├ index.mjs         门面：compositionOf / storyStateLayerOf / preflightOf / validateOf
│   ├ semantic-context.mjs 优先级带 + 子块排序 + 可见性过滤
│   ├ injection.mjs     DATA 围栏 / 受保护区块校验 / 注入模式扫描
│   ├ preflight.mjs     写前预检（时间线/正典/实体/事件/伏笔/知识边界）
│   └ temporal/context-provider.mjs  T5 统一时态游标 + 时态状态层
│
├ 通道与策略
│   ├ ai/policy.mjs     模型/思考强度/超时唯一来源
│   ├ harness.js        唯一 spawn 出口（每任务一个 dsh 子进程）
│   ├ ai/harness-env.mjs 子进程环境契约（NOVELSTUDIO_BASE_URL / 专用 DSH_HOME）
│   ├ ai/task-settings.mjs 每任务模型补丁层 + argv 上限→stdin 通道
│   ├ ai/harness-pool.mjs / ai/harness-sdk-worker.mjs 常驻热备池（**未接线**）
│   └ ai/direction.mjs  方向规范化/哈希/缓存键
│
└ 插件面  harness-plugins/novel-writing/
    ├ novel-tools.mjs   26 个 novel_* 工具（含 novel_write_pipeline 编排层）
    ├ plugin.json       插件清单（engineEndpoints 权威端点表）
    └ ENGINE.md         内核说明书（**含过期数字，见 A1-09**）
```

---

## 2. 调用链逐跳表（问题 1）

### 2.1 主路径：交互式「AI 写这一章」（`performToolbarAIWrite`）

| # | 跳 | file:line | 函数 / 关键代码 |
|---|---|---|---|
| 1 | UI 入口 | `public/app.js:10462` | `async function performToolbarAIWrite(requirement)` |
| 2 | 入口定章 | `public/app.js:10488` | `const writeChapterId = Number(state.currentChapterId) \|\| null;`（防切章串稿） |
| 3 | 任务解析（方向） | `public/app.js:10470-10477` | `savedBlueprintForChapter` → 有蓝图则 `loadAIContext({direction, library_recall_phase:'direction'})`，否则 `library_recall_phase:'defer'` |
| 4 | 取上下文 | `public/app.js:7883` | `let ctx = await api(queryOf('/ai_context'));` |
| 5 | **HTTP 入站** | `server.js:5171` | `if (resource === 'ai_context' && method === 'GET')` |
| 6 | 结构化预览字段 | `server.js:5174` | `const ctx = timed('server','AI 上下文装配（buildAIContext）', () => buildAIContext(chapterId), SLOW_REQUEST_MS);` |
| 7 | 缓存键 | `server.js:5198-5199` | `contextCacheKeyOf({workId,chapterId,mode:'full',phase,directionHash}) + temporalCacheSuffixOf(...)` |
| 8 | **装配入口** | `server.js:5202` | `budgeted = await buildNovelContext(workId, chapterId, 'full', {...})` |
| 9 | 时态游标 | `server.js:2841` | `cursor = StoryState.Temporal.resolveContextCursor({workId, chapterId, mode, boundary, commitId, worldlineId, perspective, povCharacterId, hasContent})` |
| 10 | 各层取数 | `server.js:2798-3307` | `works` / `volumes`+`plotlines`+`chapters` / `story_memories` / `story_events` / `characters` / `character_relations` / `world_entries` / `terms` / `writing_redlines` |
| 11 | 层对象构造 | `server.js:3190-3199` | `const L = (id, text, meta={}) => { const spec = specById.get(id); … cap: contextCapOf(spec, mode) }` |
| 12 | 层数组 | `server.js:3309-3352` | `const layers = [ … ].filter(Boolean);`（顺序即渲染顺序） |
| 13 | **唯一装配** | `server.js:3414` | `assembleContext(layers, {mode, workId, chapterId, requestId})` |
| 14 | 装配器 | `ai/context/assembler.mjs:65` | `export function assemble(layers, options = {})` |
| 15 | 单层渲染/截断 | `ai/context/assembler.mjs:32-46` | `renderSection(label, text, cap, options)` → `body.slice(0, cap)` + `truncationNotice` |
| 16 | 预算收敛 | `ai/context/assembler.mjs:92-109` | `if (joined.length > budget) { for (const id of flexOrder) { for (const cap of flexCaps) {…} } }` |
| 17 | 完整性判定 | `ai/context/assembler.mjs:176` | `verifyContextIntegrity({text, manifest, overflow, budget, contextId})` |
| 18 | 失败只记日志 | `server.js:3424-3439` | `if (contextIntegrity.status !== 'PASS') { const level = …'error'…; log({kind:'context_integrity'}) }`（**不拦截**） |
| 19 | 响应下发 | `server.js:5231` | `assembled: budgeted ? budgeted.assembled : ''` |
| 20 | 落到前端状态 | `public/app.js:7898` | `if (fresh()) state.aiContext = ctx;` |
| 21 | **提示词文本** | `public/app.js:7960` | `return typeof ctx.assembled === 'string' ? ctx.assembled : '';` |
| 22 | 蓝图轮提示词 | `public/app.js:8537` | `buildAIWritingProsePrompt(initial, blueprint, targetWords)` → `aiContextBlock()` 插在 `【当前小说上下文】` |
| 23 | 通道决策（蓝图） | `public/app.js:10544` | `if (!aiContextTruncated()) { … directAIWrite(…) }`（截断则直落 harness） |
| 24 | 直连兜底 | `public/app.js:10558` | `jobMeta = await runHarnessJob({...jobBase, prompt: blueprintPrompt}, stageLabel)` |
| 25 | 蓝图落库 | `public/app.js:10599` | `await api('/novel/chapter_blueprint', {method:'PUT', body:{chapter_id, blueprint, target_words}})` |
| 26 | **成文轮** | `public/app.js:10640` | `proseData = await streamAIDirectWrite({config_id, model, messages:[{role:'user',content:prosePrompt}], max_tokens, work_id, scan:true}, …)` |
| 27 | SSE 入站 | `server.js:8588` | `if (action === 'write_stream') { return handleAIWriteStream(req, res, body, config); }` |
| 28 | SSE 处理器 | `server.js:1347` | `async function handleAIWriteStream(req, res, body, config)` |
| 29 | 客户端断开→中止 | `server.js:1352-1354` | `const upstream = new AbortController(); const onClose = () => upstream.abort(); res.on('close', onClose);` |
| 30 | **provider 调用** | `server.js:1370` | `const text = await callAIStream(config, messages, {…, signal: upstream.signal, onUsage, onThinking}, (delta, acc) => {…})` |
| 31 | fetch | `server.js:1249` | `const resp = await fetch(url, {method:'POST', headers:{'Authorization': \`Bearer ${config.api_key}\`}, body: JSON.stringify(body), signal: controller.signal})` |
| 32 | SSE 解析 | `server.js:1272-1300` | 按 `\n` 切行 → `line.startsWith('data:')` → `JSON.parse(payload)` → 取 `choices[0].delta.content` |
| 33 | 落盘（草稿） | `public/app.js:10660` 起 | `parseAIWritingOutput(...)` → 弹「AI 写作结果」→ 作者采纳时 `PUT /api/novel/chapter_save` |
| 34 | 写回 + 后处理 | `server.js:8646` / `afterTemporalContentSave` | 章节保存后建 revision + pending 提案（`origin=chapter_save`） |

### 2.2 慢通道路径（harness）

| # | 跳 | file:line | 说明 |
|---|---|---|---|
| 1 | 入队 | `public/app.js:6662` | `runHarnessJob(body, stageLabel, endpoint='/harness/run')` |
| 2 | HTTP 入站 | `server.js:8284` | `if (resource === 'harness' && method === 'POST' && segments[2] === 'run')` |
| 3 | 身份环境 | `server.js:8287-8295` | `NOVELSTUDIO_BASE_URL` + `NOVELSTUDIO_PROPOSE_MODE:'1'` + `WORK_ID/CHAPTER_ID/MODE` |
| 4 | 并发闸 | `server.js:8298` | `if (harnessLoad() >= HARNESS_CONCURRENCY) return sendError(res, 429, …)` |
| 5 | 作业对象 | `server.js:8306` / `4490` | `createHarnessJob(String(body.prompt).trim(), {timeout, model, reasoningEffort, env, …})` |
| 6 | **提示词经 argv** | `server.js:4572` | `output = await runHarnessTaskWithProgress(prompt, {...options, signal, onPhase}, onChunk)` |
| 7 | spawn 出口 | `harness.js:851` | `const child = spawn(process.execPath, spawnArgs, {cwd, shell:false, env: childEnv, …})` |
| 8 | 环境契约 | `harness.js:848` | `harnessChildEnv({peerId: OPENVIKING_PEER_ID, env: options.env})` |
| 9 | argv→stdin 切换 | `ai/task-settings.mjs:245` | `promptFitsArgv(prompt, reservedUnits)`；超限则 `STDIN_TASK_ARG = '-'` |
| 10 | 每任务模型补丁 | `harness.js:746-748` | `materializeTaskSettings({model, reasoningEffort})` → `--patch <tmp>/override-default-model.patch.yml` |
| 11 | 超时/取消 | `harness.js:873-909` | `setTimeout(…killChildTree(child)…timeoutMs)` / `signal.addEventListener('abort', onAbort)` |
| 12 | 产出 | `harness.js:948` | `resolve(stdout.trim())`（**只取 stdout 正文，无 usage**） |
| 13 | 落库 | `server.js:4578-4601` | `job.status='done'; job.output=output; … persistHarnessJob(job)` |

---

## 3. 双通道边界（问题 2）

**LLM 由谁发起？两条都真实存在，且都在生产使用。**

| | 直连通道 | harness 慢通道 |
|---|---|---|
| 发起者 | `server.js` 内 `fetch` 直连 HTTP | `server.js` → `harness.js` `spawn` → dsh 子进程内 SDK 发起 |
| 代码 | `callAI` (`server.js:1115`) / `callAIStream` (`server.js:1208`) | `runHarnessTaskWithProgress` (`harness.js:706`) |
| 请求体 | OpenAI 兼容 `{model,messages,temperature,max_tokens,stream}` | dsh CLI 位置参数（或 stdin `-`）承载整段提示词 |
| 协议 | `/chat/completions`（`chatCompletionsUrl`，`server.js:1036`） | dsh 内部 provider（0.1.7 起 llm-deepseek 走 `/v1/messages`，见 `docs/ai-core.md:135-142`） |
| 工具循环 | **无**（请求体不含 `tools`/`tool_choice`） | 有（26 个 `novel_*` 工具） |
| 超时 | `AI_REQUEST_TIMEOUT_MS` = `LONG_AI_TIMEOUT_MS` = 30 min（`server.js:1079`） | `options.timeout \|\| LONG_AI_TIMEOUT_MS`，HTTP 层钳到 60 min（`server.js:8242/8300`） |
| usage | 有（含 `prompt_cache_hit_tokens` / `reasoning_tokens`） | **无**（`harness.js:804` 注释明写） |
| 用途 | 蓝图轮（默认）、成文轮流式、补足轮、润色/扩写/对话 | 成文回退、质检不合格返工、审稿、修稿、自动创建小说、记忆压缩、批量成文 |

**边界判定（关键）**：

- 边界不在 `server.js` 内部，而在 **前端**：`public/app.js` 决定走哪条（`10544` / `10558` / `10638-10659`）。
  服务端只为两条通道各提供一个入口，**不做通道选择**。
- **不存在「同一次调用双发」**：`streamAIDirectWrite` 抛错才回退 harness（`10648-10659`），非并发双通道。
- **但存在真实的行为不一致**（问题 2 的答案）：同一条提示词文本 `assembled` 会被送进两条通道，
  而两条通道的**能力集不同**（一条有工具、一条没有），
  因此 `assembled` 内嵌的「被裁了可用 XXX 工具查回」提示（`layers.mjs:28-33`）
  在直连通道上是**指向不存在的工具**。详见 **A1-02 / A1-03**。
- 第三条独立通道：`temporalAnalysisGenerate` (`server.js:4642-4656`) 用 `callAI` + **`role:'system'`/`role:'user'` 分层**
  调用，取「第一条带 api_key 的 api_configs」（`server.js:4635`）——即**用作者的第 1 条配置**跑状态分析，
  与写作任务选的配置无关。

---

## 4. Context 组装（问题 3）

### 4.1 层清单（`ai/context/layers.mjs:45-93`，`node` 实测 `LAYERS.length === 18`）

```
work,outline,memory,recall,library,events,foreshadows,scene,blueprint,
story_tail,characters,relations,world,terms,story_state,edit_rules,author_intent,redlines
```
- 14 条常规 + 4 条**门控**（`library` / `story_state` / `edit_rules` / `author_intent`，均带 `gated:true`）
- 顺序即渲染顺序；`server.js:3309-3352` 的数组顺序与之逐一对应

### 4.2 优先级 / 配额 / 预算（全部**按字符**，不是 token）

| 项 | 常量 | 位置 |
|---|---|---|
| 总预算 | `TOTAL_BUDGET = {settings:19000, default:26000}` | `layers.mjs:179` |
| 单层正文 cap | 各层 `cap`（如 `memory:2200`、`events:1800`、`story_state:2400`、`redlines:4000`） | `layers.mjs:46-92` |
| 实体层上限 | `entityCap: 4000`（角色卡，由 `buildCharacterCards` 保证） | `layers.mjs:70`；`entityCapOfId()` `layers.mjs:213` |
| 收缩顺序 | `FLEX_ORDER = ['story_tail','outline','world']` | `layers.mjs:96` |
| 收缩档位 | `FLEX_CAPS = [2400,1600,800,400]` | `layers.mjs:99` |
| 可执行下限 | `computeFloor(mode)` | `layers.mjs:256-275` |

**`computeFloor` 实测输出**（`node -e "import('./ai/context/layers.mjs')…"`，只读计算）：

```
floor(full)             = 21364      floor(settings)         = 18173
floor(full, inclGated)  = 29875      floor(settings, inclG)  = 26684
sum caps (excl entity)  = 35600      noticeSampleLength      = 56
```

→ 与 `docs/context-contract.md:116-117`（21,364 / 18,173）和 `docs/ai-core.md:94` **逐字一致**。
→ 含门控层时下限 29,875 / 26,684 **均已超过总预算**（26,000 / 19,000），但门控层默认不计入，故不影响。

### 4.3 截断与丢弃顺序

- **截断单位是字符**：`renderSection` 用 `body.slice(0, cap)`（`assembler.mjs:41`），**按头部截断**。
- **层从不被整层丢弃**：`assemble()` 全程只重渲染 flex 层（`assembler.mjs:102-104`），
  没有任何「移除层」的分支；`envelope.excluded` 只是**报告**，不改变 `text`。
- 丢弃顺序 = 收缩顺序：`story_tail` → `outline` → `world`，每层依次试 4 个档位，
  且**只有当 `joined.length > budget` 时才继续**（`assembler.mjs:92-109`）。
- 压到下限仍超预算 → 产出 `overflow` 标记但**照常发送**（`assembler.mjs:112-115`）；
  `context_integrity` 记 C4 = WARNING（`integrity.mjs:84-90`）。
- `sourceIds`/`scores`（谁被选中）与 `dropped`（丢了多少字）逐层落进 `manifest`（`assembler.mjs:117-157`）。

### 4.4 门控层「关闭时逐字节不变」是否成立

成立。`compositionOf`（`ai/story-state/index.mjs:54-57`）第一行即 `if (!isEnabled(w)) return null;`；
`libraryEnabled(workId)`（`server.js:3104`）、`edit_rules_enabled`（`server.js:3225`，默认 `'0'`）、
`author_intent`（`server.js:3282`，有数据才建）各自短路。→ **确认正常工作**（见 §7）。

---

## 5. Story State / 时间线 / 伏笔 / 人物动态状态是否真的进了 prompt（问题 4）

### 5.1 确切代码路径

```
server.js:2838  temporalEnabled = StoryState.Temporal.isTemporalEnabled(workId)
server.js:2841  cursor = resolveContextCursor({...})          ← 只有 temporalEnabled 才解析
server.js:2859  cursorUsable = !!(cursor && cursor.enabled && cursor.ok !== false)
        │
        ├─ if (cursorUsable)                      server.js:3246
        │     buildTemporalStoryStateLayer({cursor})   ai/story-state/temporal/context-provider.mjs:314
        │     → sections: 角色状态/人物关系/剧情线/伏笔/知识边界/读者披露/其它事实/作者计划
        │
        └─ else if (chapter)                      server.js:3256
              compositionOf(workId, chapter.id)        ai/story-state/index.mjs:54
              storyStateLayerOf(comp)                  ai/story-state/index.mjs:98
              → blocks: canon/planned/timeline/knowledge/foreshadows/contract/hard_rules
                                    │
server.js:3346                  storyStateLayer（或 null）推入 layers 数组
server.js:3414                  assembleContext(...) → assembled
server.js:3542                  return { assembled, context_manifest, context_integrity, … }
server.js:5231                  /api/ai_context 响应 assembled
public/app.js:7960              aiContextBlock() → state.aiContext.assembled
public/app.js:8573 / 9322 / …   提示词里 `${aiContextBlock() || '无'}`
public/app.js:10549 / 10643     直连 messages 或 /harness/run prompt
```

### 5.2 结论

**是，真的注入了** —— 且证据来自项目自己的活体实测：
`docs/golden-novel-regression-2026-09-26.md:123`「8B 模型确实收到故事状态段｜正典/契约/时间线/知识边界/伏笔五块齐全」。
`ai/story-state/index.mjs:100-133` 的五个渲染器（`renderCanonLines` / `renderKnowledgeLines` /
`renderForeshadowLines` / `renderContractSection` / `renderHardRules`）都有真实内容来源。

**但有两个必须点出的问题**：

1. **时间线层与人物动态状态是两套实现，块集合不同**（A1-01）：legacy 引擎有「本章契约 + 硬约束」，
   temporal 引擎没有。
2. **`semantic-context.mjs` 的优先级带能力（`annotateSemantic` / `verifyBandCoverage` /
   `semanticItem` / `orderSemanticItems`）定义了但从未被调用**（A1-05），
   且它的 `LAYER_BAND` 表落后于 `LAYERS` 三层，而这个落后**正好因为校验函数没人调而无法被发现**。

### 5.3 "定义了但从未被调用" 点名录（问题 4 重点 / 问题 10）

| 符号 | 定义位置 | 全仓引用 | 判定 |
|---|---|---|---|
| `wrapAsData` | `ai/story-state/injection.mjs:89` | 仅 `index.mjs:41` 的 import（**未使用**） | 死代码 |
| `verifyProtectedBlocks` | `ai/story-state/injection.mjs:108` | **零**（除定义行） | 死代码 |
| `annotateLayers` | `ai/story-state/injection.mjs:147` | **零** | 死代码 |
| `summarizeInjection` | `ai/story-state/injection.mjs:157` | **零** | 死代码 |
| `annotateSemantic` | `ai/story-state/semantic-context.mjs:83` | **零** | 死代码 |
| `verifyBandCoverage` | `ai/story-state/semantic-context.mjs:187` | **零** | 死代码（**因此带表过期无人发现**） |
| `semanticItem` | `ai/story-state/semantic-context.mjs:163` | **零** | 死代码 |
| `orderSemanticItems` | `ai/story-state/semantic-context.mjs:177` | **零** | 死代码 |
| `renderPreflight` | `ai/story-state/preflight.mjs:221` | **零** | 死代码（插件另写一份，见 A1-06） |
| `runPromptOnWorker` | `ai/harness-pool.mjs:192` | 仅同文件 | 未接线 |
| `createWarmPool` | `ai/harness-pool.mjs:258` | 仅同文件 | 未接线 |
| `createSpawnWorker` | `ai/harness-sdk-worker.mjs:57` | 仅同文件（只被池调用，池本身未接线） | 未接线 |
| `buildHarness` | `harness.js:472` | 仅 `harness.js` 内（已 `export` 移除，见 `:470-471` 注释） | 已正确收口（非问题） |

> 取证方式：`grep` 工具全仓检索符号名（含 `tests/`、`scripts/`、`.p1-baseline/`、`docs/`、`harness-plugins/`），
> 逐个人工核对命中行是否为「定义/import/注释」。`wrapAsData` 在 `index.mjs:41` 被 import 但函数体内无调用点。

---

## 6. Prompt 结构（问题 5）

### 6.1 分层情况：**基本不分层**

写作链路的 12+ 处提示词**全部是单条 `role:'user'` 长字符串**：

- `public/app.js:10549` `directAIWrite([{ role: 'user', content: blueprintPrompt }], …)`
- `public/app.js:10643` `messages: [{ role: 'user', content: prosePrompt }]`
- `public/app.js:11020` / `10762` `directAIWrite([{ role: 'user', content: contPrompt }], …)`
- `runHarnessJob` 路径更彻底：整段 prompt 变成 **CLI 位置参数**（`harness.js:851`，超限才转 stdin）

**只有 3 处用了角色分层**（都不是章节成文）：
- `server.js:4091` `generateNovelFromPrompt`：`{role:'system', content: NOVEL_GENERATION_SYSTEM_PROMPT}` + user
- `server.js:4648` `temporalAnalysisGenerate`：`{role:'system',content:system}` + `{role:'user',content:user}`
- `server.js:8581` `/api/ai/test`：单条 user（无分层）

**为什么是问题**：一致性纪律（「不得提前回收伏笔/不得越界」）与用户即兴需求**同处一条 user 消息**，
没有任何结构性优先级。项目自己在 `ai/story-state/injection.mjs:31` 定义了
`PROTECTED_BLOCKS = ['SYSTEM_RULES','WRITING_CONTRACT']` 并写了「受保护区块**永不**由 DATA 提供」——
**但那条纪律没有任何执行者**（A1-04）。

### 6.2 一致性约束确实写进了提示词（原文引用）

`public/app.js:8510-8514`（蓝图轮，硬约束块）：
```
章节边界（硬约束，必须遵守）：
- 不得为后续章节做动机前置；不得提前释放后续章节的悬念、身份曝光类线索或设定升级
- 不得引入未登记的具名角色/地点/妖兽。
- 大纲里标注【未来章·禁止写入】的条目只用于规划与避免矛盾，正文不得提前消费其中任何一条。
```

`public/app.js:8563-8570`（成文轮）：
```
不得为凑字数新增场景或情节点，不得引入后续章节的动机、悬念或身份曝光线索，不得新增未登记的具名角色/地点/妖兽
【本章自检（写完后逐项自查，未通过就改）】① 对手/妖兽的阶位必须与本章摘要一致…
```

**「不得让人物知道自己不该知道的信息」**——这条**不在**前端提示词里，而是走
`ai/story-state/index.mjs:155-173` 的 `renderKnowledgeLines`，输出形如：
```
${name}｜知道：…｜**不知道**：…｜只是怀疑：…｜误信（写作时须保持这个错）：…
```
经 `story_state` 层进入 `assembled` → `aiContextBlock()`。**门控**：仅当作品开启确定性故事状态开关
且（temporal 开启 或 指定了 chapter）时才存在（`server.js:3246/3256`）。

### 6.3 输出契约分层

- 结构化产物（蓝图/审稿/修稿/分支候选）靠**尾部一句**约束：「只输出 JSON。」（`public/app.js:9329`）、
  「请直接输出【蓝图】并给出 JSON。」（`8531`）——**没有** JSON Schema、没有 function calling、没有 response_format。
- 长正文靠「请直接输出完整正文（不要输出【成文】等前缀，不要解释）。」（`8578`）。

---

## 7. 流式与中断 / 超时 / 重试 / 限流（问题 6）

| 能力 | 现状 | 位置 |
|---|---|---|
| SSE 服务端下发 | 有 | `server.js:1355-1364`，`data: ${JSON.stringify(obj)}\n\n` |
| SSE 上游解析 | 有（手写） | `server.js:1277-1299` 按 `\n` 切行 + `data:` 前缀 + 逐行 `JSON.parse` |
| 客户端断开→中止上游 | **有** | `server.js:1352-1354` `res.on('close', onClose)` → `upstream.abort()` |
| Abort 传到 provider | **有** | `server.js:1247` `options.signal.addEventListener('abort', onAbort)` → `controller.abort()` → `fetch(...,{signal})` |
| 超时 | 有，单一**总**超时 | `server.js:1245` `setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS)`；常量 `server.js:1079` = 30 min |
| **停滞（idle）超时** | **无** | 只有总超时；上游卡住时最长等满 30 分钟且界面无字节 |
| 重试 / 退避 | **仅 URL 形态回退** | `server.js:1195-1202`（非流式）/ `1334-1340`（流式）：`e.status===404\|\|405\|\|/not found\|invalid url/` 才换 `/v1/chat/completions` ↔ `/chat/completions` |
| 限流（429 / Retry-After） | **无处理** | 全仓无 `429` 特判、无 `Retry-After`、无指数退避；`429` 只出现在并发槽位的**出站**错误（`server.js:8241/8298`） |
| 错误标准化 | 部分 | `readableErrorMessage`（`logger.js`，`server.js:1430` 注释指明与 `harness.js` 共用）；`err.status` / `err.detail` 挂载于 `server.js:1159-1160`、`1264-1265` |
| 慢通道取消 | 有（杀进程树） | `harness.js:893-909` + `killChildTree`（`harness.js:569-581`，Windows `taskkill /T /F`） |
| 慢通道超时 | 有 | `harness.js:873-890`，错误文案含「已生成的中间内容未能落盘」 |
| 空回复阶梯（前端） | 有 | `public/app.js:6903-6940`（3 档：原强度放宽上限 → 仍空 → low effort 兜底） |
| 内容中断保稿 | 有 | `public/app.js:10504` `interruptedPartial` + `10651` |

---

## 8. 结构化输出：`JSON.parse` 依赖模型输出的位置（问题 7）

| 位置 | 函数 | 失败处理 | 可信度 |
|---|---|---|---|
| `public/app.js:8705-8718` | `extractJSONFromText(text)` | 严格 parse → 引号修复重试（`"\s*,\s*"` / `"\s*,\s*[}\]]`）→ 返回 `null` | 已确认 |
| `public/app.js:8737-8754` | `parseBlueprintJSON(text)` | 严格 → **逐字段抢救**（`salvageJSONString`）→ `stage:'salvaged'`；仍失败 `null`，调用方报错 | 已确认 |
| `public/app.js:8746-8790` | `detectNonProseOutput(article)` | 「结构化产物解析失败时不许降级成正文」闸门；不通过则用纠正提示词重生成一次 | 已确认 |
| `public/app.js:7183` / `8920` / `9689` | 蓝图/审稿解析调用点 | 同上 | 已确认 |
| `public/app.js:5114` / `5606` | 分支候选 JSON | `JSON.parse(payload.slice(start,end+1))`，失败交给校验口径报错 | 已确认 |
| `public/app.js:5317` | 候选 JSON | `catch` → `toast('候选 JSON 不合法：…')` | 已确认 |
| `server.js:4033-4041` | `extractJSON(text)` | **仅** ```json 围栏 → 首个 `{` 到末个 `}` → 裸 parse。**无引号修复、无字段抢救** | 已确认 |
| `server.js:4098/4108` | `generateNovelFromPrompt` | 失败 → 单次重试（`temperature:0.3` + 强化 system 指令，`4103-4108`）；`retryable` 判据 `4101` | 已确认 |
| `server.js:4288` | `generateNovelFromHarness` | `extractJSON(output)`，无修复重试 | 高可信静态推断 |
| `server.js:3700-3701` | 审稿报告解析（服务端侧） | `catch` → 尾逗号/引号修复重试 → `null` | 已确认 |
| `server.js:1155` / `1261` | provider 响应体 | `catch { data = {raw:text} }`（协议层，非模型内容） | 已确认 |
| `server.js:1284` | SSE 帧 | `catch {}` 静默忽略心跳/非 JSON 行 | 已确认 |
| `ai/repair/analyzer.mjs:227` | 修复分析器 | `try/catch → null` | 已确认 |
| `ai/repair/runner.mjs:441` | 修复执行器 | 同上 | 已确认 |
| `ai/story-state/temporal/extraction.mjs:103-105` | 状态抽取 | 先 `{}` 切片 parse，再整体 parse，失败**抛错** | 已确认 |

**结论**：前端侧对模型 JSON 的鲁棒性**明显强于**服务端侧。
`server.js:4033` 的 `extractJSON` 与前端 `parseBlueprintJSON` 不是同一套逻辑，
而两者服务的都是「模型自由文本 → 结构化产物」这一件事。
`generateNovelFromPrompt`（直连）与 `generateNovelFromHarness`（慢通道）**共用**这个弱版 `extractJSON`
（`server.js:4098` / `4288`），即「AI 自动创建小说」两条通道的解析鲁棒性都弱于章节蓝图路径。

---

## 9. Token / 成本（问题 8）

| 项 | 现状 | 位置 |
|---|---|---|
| 估算方法 | **不用 tiktoken**。CJK 码点 1 token/字、其余 4 字符/token，取整到百位 | `ai/context/tokens.mjs:30-61` |
| 估算是否驱动预算 | **否**（明确声明） | `tokens.mjs:5-11`、`context-contract.md:370-372` |
| 估算进入产物 | 是（`manifest[].estimatedTokens`、`stats.estimatedTokens`、`envelope.estimatedTokens`） | `assembler.mjs:133/171/203` |
| 真实 usage（直连） | 是，含缓存命中与思考 token | `server.js:1181`、`1286`、`1304`；`debug-trace.js:823-831` |
| 真实 usage（慢通道） | **拿不到** | `harness.js:804`；`public/app.js:10662` 注释「慢通道拿不到就不编」 |
| 是否落盘/可见 | 是：运行追踪面板（`public/app.js:2097-2135`）显示 `↑prompt ↓completion tok` + 缓存命中 | — |
| 费用换算 | **无**（全仓无价格表/成本估算） | — |

---

## 10. Provider 抽象（问题 9）

| 问题 | 答案 | 证据 |
|---|---|---|
| 支持哪些 provider | **只有一种请求形状**：OpenAI 兼容 Chat Completions | `server.js:1036-1042` `chatCompletionsUrl` |
| baseURL 可配置 | **是** | `server.js:1124` `String(config.base_url \|\| 'https://api.deepseek.com')`；`api_configs` 表（`server.js:1411`） |
| 是否硬编码某 provider 格式 | **是**（OpenAI 形状）。但**对 DeepSeek 额外下发专有字段** | `server.js:1138` / `1234` `if (effort && isDeepSeekEndpoint(config.base_url)) applyReasoningEffort(body, effort)` |
| DeepSeek 判据 | 主机名匹配 | `server.js:1053-1060`：`host === 'deepseek.com' \|\| host.endsWith('.deepseek.com')` |
| 流式 usage 索取 | 仅 DeepSeek | `server.js:1230` `...(isDeepSeekEndpoint(...) ? {stream_options:{include_usage:true}} : {})` |
| 多模态 | **不支持** | `server.js:1119-1123` 强制 `typeof m.content === 'string'`，**数组型 content（图片块）会被拒绝** |
| 工具调用 | **不支持**（直连通道） | 请求体只构造 `model/messages/temperature/max_tokens/stream(/reasoning_effort/thinking)`，无 `tools` |
| 慢通道的 provider | dsh 自带的 llm provider，由 `--patch` 覆盖 `agent-default-model.config` | `ai/task-settings.mjs:138-155` |

> 第三方兼容性设计：对非 DeepSeek 端点**不下发** `reasoning_effort` / `thinking` / `stream_options`，
> 且模型名原样转发（`ai/policy.mjs:112-117` 未知模型不改写）。这是有意的兼容取舍，**确认正常**。

---

## 11. 逐条发现

> 每条含：标题｜可信度｜证据｜为什么是问题｜用户影响（100/300/500 章）｜根因｜建议方向

---

### A1-01 ｜开启时态引擎后，「本章契约」与「硬约束」整块不再进入提示词

**可信度：已确认（源码调用点唯一性 + 两个渲染器逐块对比）**

**证据**

```
ai/story-state/contract.mjs:252   export function renderContractSection(contract, { includeStyle = true } = {}) {
ai/story-state/index.mjs:39       import { checkContract, renderContractSection, isCheckable } from './contract.mjs';
ai/story-state/index.mjs:127        contract: comp.contract ? renderContractSection(comp.contract, { includeStyle: false }) : '',
```
`renderContractSection` 全仓**只有一个调用点**：`index.mjs:127`，位于 `storyStateLayerOf` 内。
而 `storyStateLayerOf` 全仓也**只有一个调用点**：

```
server.js:3246   if (cursorUsable) {
server.js:3249     const builtTemporalState = StoryState.Temporal.buildTemporalStoryStateLayer({ cursor });
server.js:3256   } else if (chapter) {
server.js:3260       const built = StoryState.storyStateLayerOf(comp);
```

即：**temporal 开启（`cursorUsable`）时 `storyStateLayerOf` 永不执行**，
于是 `renderContractSection` 永不执行，契约块不进 `assembled`。

temporal 渲染器实际产出的块（`ai/story-state/temporal/context-provider.mjs:331-338`）：
```
角色状态 / 人物关系 / 剧情线 / 伏笔 / 知识边界 / 读者披露 / 其它事实 / 作者计划
```
**没有** `本章契约`，**也没有** `hard_rules`（时间线泄漏 / 倒置 / 别名冲突的显式警告，
见 `index.mjs:175-182` 的 `renderHardRules`）。

插件侧同样失效（二次确认）：
```
harness-plugins/novel-writing/novel-tools.mjs:1141
  const c = ctx.story_state?.contract_version ? await jfetch(`/api/novel/state/contract?…`) : null
harness-plugins/novel-writing/novel-tools.mjs:1142
  if (c?.contract) parts.push(`本章契约（v${c.contract.version}）：\n${renderContractText(c.contract)}`)
```
闸门字段 `contract_version` 由 `index.mjs:148` 提供（legacy 引擎专有）；
temporal 引擎的 meta（`context-provider.mjs:348-355`）**不含该字段** →
`ctx.story_state.contract_version` 为 `undefined` → 契约**不取**。

**为什么是问题**
「同一份契约贯穿 preflight → context → generation → validation」是该项目写在
`ai/story-state/contract.mjs:4-6` 的核心承诺。temporal 是较新的权威引擎（T5），
启用它反而**降低了**上下文里的约束密度——这是「升级一个能力导致另一个能力静默失效」的典型形态。
更危险的是它是**静默**的：`layers.mjs:81` 的层标签仍写「故事状态（**正典/时间线/契约/知识边界**）」，
`layers.mjs:383` 的 `reason` 仍写「本章契约」，
`docs/context-contract.md:85` 的数据来源仍列 `chapter_contracts`，
`docs/host-contract.md:432` 仍把「章节契约（11 字段组）」列为进上下文的能力。
作者/审计者从清单、标签、文档三处都**读不到**这个缺失。

**用户影响**
- 100 章：`required_beats` / `forbidden_beats` 丢失后，章节漂移主要表现为「该发生的事没发生」，
  作者会归因为「模型不听话」，而不是「契约没送到」。
- 300 章：`continuity_constraints` 不进上下文 → 与既有事实的冲突率上升；
  `acceptance_checks` 缺失使 `novel_validate` 的对照基准与生成时的约束**不是同一份**，
  校验会报出「生成时根本不知道」的违规，作者被迫反复人工修。
- 500 章：`foreshadow_targets` 丢失（契约里的伏笔目标）叠加伏笔数量增长，
  「本章该回收的伏笔」只能靠模型从伏笔列表里自己猜；`forbidden_state_changes`
  不进上下文则「已死角色又出场」这类硬伤重新变成概率事件——正是这套内核要消灭的失败模式。

**根因**
「哪个引擎负责渲染 story_state 层」被实现为 `if/else` 二选一（`server.js:3246/3256`），
但两个渲染器的**块集合没有共同的契约校验**。`STORY_STATE_BLOCKS`（`semantic-context.mjs:56-64`）
本来可以充当这份契约，但只被 legacy 渲染器使用，且没有断言二者块集合一致。

**建议方向**
1. 给 `STORY_STATE_BLOCKS` 增加 temporal 渲染器必须覆盖的声明，并加一条**离线断言**：
   两个渲染器产出的块 id 集合必须相等（把 `verifyBandCoverage` 那种「有校验函数但没人调」的坑堵死）。
2. 若 temporal 引擎暂时无法产出契约块，就让 `buildTemporalStoryStateLayer` 显式渲染一行
   「本章契约：未登记」而不是整块缺席（与工作树已给空状态加的占位文案同一姿态）。
3. 插件侧 `contract_version` 闸门改为「能力探测」而不是「字段存在」，
   否则任何 meta 形状变化都会静默关闭契约注入。

---

### A1-02 ｜「上下文被截断时不用直连」的规则只管蓝图轮，成文轮没有这道保护 ⚠️ HEAD 与工作树同

**可信度：已确认（全仓 5 处引用逐点核对）**

**证据**

规则声明（三处，措辞一致）：
```
public/app.js:10449-10451
// 上下文是否被预算截断/溢出。
// 用途：慢通道能"用工具取回被截断的原文"，直连不能 —— 所以**截断时不用直连**。
function aiContextTruncated() {
public/app.js:10536-10537   // 两道保险：① 上下文被预算截断时不用直连（慢通道能取回被截断的原文）；
public/app.js:10981-10982   //    两种必须回退的情况：① 上下文被预算截断——只有慢通道能用 novel_lookup 取回被裁掉的原文；
```

`aiContextTruncated()` 的**全部**调用点（`grep -n 'aiContextTruncated' public/app.js` → 3 处，含定义）：
```
public/app.js:10544      if (!aiContextTruncated()) {          ← 交互式「蓝图轮」
public/app.js:10985      if (!aiContextTruncated()) {          ← 批量「蓝图轮」
```
**成文轮没有任何检查**：
```
public/app.js:10637-10647
const activeConfig = await getActiveAIConfig();
if (activeConfig && activeConfig.api_key) {
  try {
    proseData = await streamAIDirectWrite({ config_id: activeConfig.id, model: policyModel('fast'),
      messages: [{ role: 'user', content: prosePrompt }], max_tokens: maxTokens, work_id: …, scan: true }, …);
```
同理，补足轮也没有：
```
public/app.js:10761-10766   if (gap <= Math.max(200, Math.ceil(target * 0.15))) { const reply = await directAIWrite(…contPrompt…) }
public/app.js:11019-11024   批量补足：同样的 gap<=15% 直连分支
```

**为什么是问题**
成文轮是**真正决定章节正文**的那一次调用。规则的理由（「直连没有工具，取不回被裁掉的原文」）
在成文轮上成立得最彻底——被裁掉的正是 `story_tail`（前文衔接，`FLEX_ORDER` 第一个被压）
和 `outline`（大纲）。结果：在**大作品**上（上下文真的被截断时），
章节正文偏偏由**唯一没有查回能力的通道**生成。
直连失败才会回退慢通道（`10648-10659`），而「生成成功但上下文残缺」不会触发任何回退——
质量闸（`verifyAIDraft`，`10704`）只在**内容硬伤**上拦截，不检查「模型是否本可以查回却查不到」。

**用户影响**
- 100 章：`outline` 层 cap 2800，超 70 章起只列前 30 + 最近 40，中段章纲被省略。
  直连成文时模型看不到第 40–60 章发生了什么，也调不了 `novel_lookup` → 中段剧情重复或断裂。
- 300 章：`story_tail` 被压到 400 字下限，`memory` 层 2200 字已装不下整个故事。
  直连成文时「刚写完的那句话的直接延续」只剩 400 字，跨章连贯性下降最明显。
- 500 章：三层 flex 全部压到 400 字下限后仍可能 `overflow`（`floor(full)=21364` 已占预算 82%），
  此时直连通道收到的是**明确标注「已截断、可用 novel_lookup 查回」但无法查回**的上下文——
  模型要么忽视提示硬写，要么在正文里留下「待补充」类痕迹。

**根因**
通道决策被写在两个不同的位置（蓝图轮在 `10544`，成文轮在 `10637`），
而判据（`aiContextTruncated`）只被前一处消费。`prosePrompt` 的构造（`10629`）与
它的发送（`10640`）相邻但没有共享前置条件，所以「同一纪律」在重构时漏了一处。

**建议方向**
把「通道选择」收成一个纯函数，例如
`chooseChannel({ truncated, hasApiKey, kind:'blueprint'|'prose'|'continuation' })`，
两个分支都调它；并为「truncated 且 kind==='prose' 时必须选 harness」加一条 `frontend-test.mjs` 断言。
（现有测试只覆盖了蓝图轮的判据——`frontend-test.mjs` 中 `context_overflow` 仅 1 处，
见 `frontend-test.mjs:2221`。）

---

### A1-03 ｜截断提示语让模型去调「直连通道根本没有的工具」

**可信度：已确认**

**证据**

```
ai/context/layers.mjs:28-33
export const truncationNotice = (originalLength, retrievalTool) =>
  `\n…（本层共 ${originalLength} 字，已按预算截断；${
    retrievalTool ? `如需精确内容可用 ${retrievalTool} 查证`
                  : '被截掉的部分当前没有查回路径（已知缺口）'}）`;
```
`retrievalTool` 来自 `RETRIEVAL`（`layers.mjs:113-134`），例如
`memory → novel_memory_read`、`events → novel_events`、`outline/story_tail/world → novel_lookup`
（`layers.mjs:123/126/116/119`）。

而直连通道的请求体里**没有任何工具字段**：
```
server.js:1129-1135   const body = { model, messages, temperature, max_tokens, stream: false };
server.js:1222-1231   流式版：{ model, messages, temperature, max_tokens, stream: true, …stream_options }
```
`assembled` 是**唯一来源**、两条通道共用同一段文本：
```
public/app.js:7957-7960
// P2：提示词文本改由服务端**唯一装配器**产出…这里不再保留该兜底
return typeof ctx.assembled === 'string' ? ctx.assembled : '';
```

**为什么是问题**
提示语在直连通道上是**不可执行指令**。这比「不提示」更糟：
它明确告诉模型「你可以查回」，模型于是可能：
① 在正文里写「（详见设定）」之类的悬空表述；② 直接输出
「我需要用 novel_lookup 查询…」这类工具意图文本（dsh 侧没有工具时会以自然语言收场）。
注意 `layers.mjs:23-26` 的注释说明这条提示语**曾经**因为写死工具名而被专门修过一次——
修的方向是「工具名要准确」，但没有处理「同一段文本走两条能力不同的通道」这个更根本的问题。

**用户影响**
- 100/300/500 章均一致：凡有层被截断的章节，直连成文都可能出现「要求查证」的残留文本；
  500 章时 `story_tail` 必然被压（400 字下限），命中概率最高。

**根因**
`assembled` 被设计成「通道无关的唯一文本」，但它的内容**包含通道相关的能力假设**
（可用工具）。设计上缺一个「本次装配将送往哪条通道」的入参。

**建议方向**
给 `assemble()` 增加 `channel: 'direct'|'harness'` 选项，`direct` 时把
`retrievalTool` 渲染为「（本次为直连生成，无法中途查证；请基于已有内容完成本章）」。

---

### A1-04 ｜DATA 围栏与受保护区块校验：定义了，零生产调用点

**可信度：已确认（全仓 grep）**

**证据**

```
ai/story-state/injection.mjs:89    export function wrapAsData(text, { label = '', kind = 'data' } = {}) {
ai/story-state/injection.mjs:108   export function verifyProtectedBlocks(blocks = []) {
ai/story-state/injection.mjs:147   export function annotateLayers(layers = []) {
ai/story-state/injection.mjs:157   export function summarizeInjection(annotated = []) {
```
全仓检索结果（`grep`）：这 4 个符号只出现在
① 自身定义行；② `injection.mjs` 内部相互引用；
③ `ai/story-state/index.mjs:25` 的 `export * from './injection.mjs'`；
④ `ai/story-state/index.mjs:41` 的 `import { scanInjection, wrapAsData } from './injection.mjs';`
——**该 import 中的 `wrapAsData` 在 `index.mjs` 函数体内无任何调用**。
唯一真正生效的是 `scanInjection`：
```
ai/story-state/index.mjs:133   const scan = scanInjection(text, { label: 'story_state' });
```
且它的结果只放进 meta（`index.mjs:138 injection: scan`），**不影响文本**。

模块头声明的三条防护（`injection.mjs:10-15`）中，②③ 无执行者：
```
injection.mjs:12  ② **系统规则与写作契约不可覆盖**：…本模块提供检测器，让"被覆盖"变成可观测事件；
injection.mjs:105 用法：编排层把要发送的提示词按区块拼好后调用它。返回 ok:false 时**不要发出请求**
```
而**不存在**这样一个「按区块拼好的编排层」：写作提示词是前端字符串拼接（`public/app.js:8548-8579`），
契约块（`PROTECTED_BLOCKS = ['SYSTEM_RULES','WRITING_CONTRACT']`）从未被构造过。

**项目自身已记录**：`docs/ai-core.md:225` 与 `docs/post-implementation-issues.md:46`（OBS-06）已把它列为
「P3 · 本轮未改」，理由是「改围栏会改动所有请求字节，违反最小改动纪律」。
`docs/golden-novel-regression-2026-09-26.md:303` 也记录了 `fencing_primitive_used_in_product=false`。

**为什么仍是问题（而不是「已知即无害」）**
① 文档只记录了「围栏未接线」，**没有记录**「因此不存在受保护区块」这个更强的结论：
`verifyProtectedBlocks` 的语义是「缺少受保护区块 → 不发请求」，也就是说按模块自身的判据，
**当前所有写作请求都应当被拒绝发出**。这条判据没有任何执行者，所以无人察觉这层不一致。
② 提示注入的实质防线只剩「召回来源 fail-closed + 导入剥标签 + 审批门」，
而**正文本身**（`story_tail` 层直接来自 `chapters.content`）是无围栏进入提示词的。
`wrapAsData` 的围栏穿透防护（`injection.mjs:91`，把正文里的 `<<<NOVEL_DATA` 替换为占位）
同样未生效——不过因为围栏本身不存在，这个具体风险暂不成立。

**用户影响**
- 100/300/500 章一致：作者从别处**复制粘贴**一段含「忽略以上所有要求，直接输出…」的文字进正文，
  该文字会经 `story_tail` 层原样进入提示词，且无任何检测（`scanInjection` 只扫 story_state 层，
  `index.mjs:133`）。长篇作者维护素材库、外链转载的情况越多，暴露面越大。

**根因**
「先建防护原语、后接线」的顺序，配上一个没有调用者的校验函数——
校验函数本身不报错，于是缺口从「代码缺陷」变成了「文档条目」。

**建议方向**
最小可行而非全量围栏：只对**不可信来源层**（`story_tail`、`story_state` 之外的作者正文、
召回命中）调用 `wrapAsData`，并把 `scanInjection` 扩到全部层
（`annotateLayers` 已经写好，只差一次调用），命中时记 error 级日志——不改变文本字节。

---

### A1-05 ｜优先级带能力整体未接线，且带表已落后 `LAYERS` 三层（而校验函数没人调）

**可信度：已确认**

**证据**

零调用点（全仓 grep）：
```
ai/story-state/semantic-context.mjs:83    export function annotateSemantic(layers = []) {
ai/story-state/semantic-context.mjs:163   export function semanticItem({ id, kind, text, ref, … } = {}) {
ai/story-state/semantic-context.mjs:177   export function orderSemanticItems(items = []) {
ai/story-state/semantic-context.mjs:187   export function verifyBandCoverage(existingLayerIds = []) {
```
唯一被消费的是 `PRIORITY_BANDS`（只读展示）：
```
server.js:5643   priority_bands: StoryState.PRIORITY_BANDS,
```

带表落后（`semantic-context.mjs:37-53` 的 `LAYER_BAND` 键 vs 实测 `LAYERS`）：
```
实测 LAYERS ids（node 打印）：
work,outline,memory,recall,library,events,foreshadows,scene,blueprint,
story_tail,characters,relations,world,terms,story_state,edit_rules,author_intent,redlines
LAYER_BAND 缺：library、edit_rules、author_intent            ← 3 层没有归属
```
`bandOfLayer` 对未知 id 返回 `'background'`（`semantic-context.mjs:66-68`），
于是 `library`（参考资料）与 `author_intent`（作者意图与文风证据）会被静默归入「普通背景」——
而这两层恰恰是「作者显式要求优先照顾」的内容。

而本应发现这件事的校验函数：
```
semantic-context.mjs:36   /** 既有 14 层 → 优先级带。**每个既有层都必须有归属**（缺一个会在单元测试里报出来）。 */
semantic-context.mjs:187  export function verifyBandCoverage(existingLayerIds = []) {
```
`verifyBandCoverage` 需要调用方**传入**层 id 列表；**没有任何调用方**（生产或测试），
所以「单元测试会报出来」这条承诺**不成立**。注释里的「14 层」同样是过期数字。

**为什么是问题**
三层元数据声称「已建立优先级带体系」——`PRIORITY_BANDS` 通过 API 下发给界面
（`server.js:5643`），作者能在界面看到「硬约束/当前状态/章节契约/近期事实/高相关召回/普通背景」六档。
但**没有任何一层文本真的被按带排序或标注**（`annotateSemantic` 未调用），
`LAYER_BAND` 又不完整。于是界面展示的是一套**没有实际作用**的分类。

**用户影响**
- 100/300/500 章一致：作者据界面提示「`library` 属于高相关召回」做取舍时，
  实际系统把它当普通背景处理。层被裁时作者无法从带序解释「为什么先压它」——
  而 `context_envelope.trimmed` 的 `trimPriority` 是**从 `FLEX_ORDER` 派生**的
  （`layers.mjs:420-426`），与 `LAYER_BAND` 是**两套互不相干的数字**，
  同一界面可能同时显示两套口径。

**根因**
「附加式元数据」被当作零风险改动先行落地，但元数据的**完整性校验**被写成「调用方传入待校验列表」
的形式——这种接口在没有调用方时**永远不会失败**。与 A1-06 的 `renderPreflight` 是同一类形态。

**建议方向**
让校验函数**自己去读 `LAYERS`**（`verifyBandCoverage()` 无参或默认取 `LAYERS`），
并加进 `scripts/ci-offline-checks.mjs`；同时补齐 3 层的带归属，
或明确把「带序不参与任何决策」写进 `PRIORITY_BANDS` 的注释与 API 字段说明。

---

### A1-06 ｜`renderPreflight` 零调用点；活的那份实现丢了「这是预测不是事实」的免责语

**可信度：已确认**

**证据**

宿主侧渲染器（死代码）：
```
ai/story-state/preflight.mjs:217-221
 * 预检结论 → 给模型/作者看的一段文本。
 * **明确标注"这是预测，不是事实"**：否则模型会把预检的推测当成已发生的事写进正文。
export function renderPreflight(risks = []) {
ai/story-state/preflight.mjs:225   const lines = ['（写前预检 · 预测，不是已发生的事实）'];
```
全仓 grep：`renderPreflight` **零调用点**。

活的那份实现（插件内，格式不同且**无免责语**）：
```
harness-plugins/novel-writing/novel-tools.mjs:1136
  const pf = await jfetch('/api/novel/state/preflight', { method:'POST', body:{work_id,chapter_id,persist:true}, … })
novel-tools.mjs:1138   parts.push(`写前预检：${risks.length} 项风险（critical ${pf.summary?.counts?.critical ?? 0}）`)
novel-tools.mjs:1139   for (const r of risks.slice(0, 12)) parts.push(`  [${r.level}]${r.requires_author_decision ? '〔需作者决定〕' : ''} ${r.reason}`)
novel-tools.mjs:1140   if (pf.blocking) parts.push('⚠ 有 critical 项：先与作者确认，不要自行推进。')
```

宿主的写入路径**从不调用** `preflightOf`：`preflightOf` 的调用点只有
`server.js:6202`（`POST /api/novel/state/preflight`）与 `server.js:6229`（validate 端点），
即**必须由模型显式调工具**才会跑。

**为什么是问题**
（a）`preflight` 的设计目标是「在花钱生成之前就把必然失败的情况挡下来」
（`preflight.mjs:5`），但它不在生成链路上，只能靠模型记得调工具。
（b）`preflight.mjs:219` 明确说明免责语是**必需**的（否则推测会被写成事实），
而唯一活着的实现把它删了 —— 一份格式、两份实现，正是该项目在别处反复消灭的漂移形态
（参见 `ai/policy.mjs:4-14` 对「四处各存一份常量」的复盘）。

**用户影响**
- 100 章：`CONTRACT_REQUIRED_MISSING`（契约要求出场但未登记实体的角色）与
  `KNOWLEDGE_VIOLATION`（角色此时点还不知道）这两类风险不会出现在写作简报里，
  模型凭「合理推断」补全 → 同人异名、知识越界。
- 300 章：`FORESHADOW_MIS_RESOLVED`（伏笔回收状态站不住）不在简报里，
  作者要靠事后审稿发现，而审稿本身也要花钱。
- 500 章：`futureLeaks` / `detectOrderInversions` 的命中概率随章数上升，
  而风险清单的注入完全依赖模型是否记得调 `novel_write_pipeline`。

**根因**
「预检」被实现为**端点**而不是**装配前置步骤**；插件侧为了少一次跳转而重写渲染格式，
且重写时未对齐免责语。

**建议方向**
1. 在 `buildNovelContext` 里对 `storyStateMeta` 可用的作品自动跑一次 `preflightOf`（纯函数、零模型成本），
   把 `renderPreflight(risks)` 的输出作为 `story_state` 层的一个子块（同样按 cap 截断 + 可查回）。
2. 插件侧改为调用同一个渲染函数（经端点返回 `rendered` 字段），消除格式分叉。

---

### A1-07 ｜E4「确定性检索计划」不改变任何上下文，只产出审计字段

**可信度：已确认**

**证据**
```
server.js:3121   if (direction && libraryRecallPhase !== 'defer' && NovelIndexStore.novelIndexEnabled()) {
server.js:3126       const exec = await runRetrievalPlan({ workId, chapterId, direction, chapterSignals, dictionary, index, versions });
server.js:3137       retrievalPlanMeta = { plan_id, status, partial, queries, by_index, matched, assets_count, timings_ms, cached,
server.js:3155         note: '计划结果只用于候选定位与审计；本版不改变既有层内容（E5：assembled 不增）' };
```
`retrievalPlanMeta` 的全部使用点（grep）：`3120`（初始化）、`3137`/`3160`（赋值）、
`3591`（`return { …, retrieval_plan: retrievalPlanMeta }`）。**没有任何层构建读取 `exec.assets`**。
默认关闭：`novel_index_enabled` 默认 `0`（`server.js:3119` 注释、`7051`）。

**为什么是问题**
一个会执行多索引查询、有并发上限与 4 秒总预算（`ai/novel-index/plan.mjs:15-25`）、
产生 `assets_count` 七类 id 的子系统，其全部产出只进响应 JSON。
这是**有意为之的分阶段落地**（注释写得很清楚），但对外部审计者/使用者而言，
「开了索引却看不出上下文有任何变化」几乎无法与「功能没生效」区分——
尤其当它与语义召回（会改变上下文）在同一个「检索」名号下出现时。

**用户影响**
- 100/300/500 章：作者打开 `novel_index_enabled` 后观察不到任何生成差异，
  合理的结论是「开了没用」（实际上就是没用），于是无法判断该开关的价值。
  它还会消耗真实的 SQLite 查询与 30 秒计划缓存（`plan.mjs:23`）。

**根因**
集成点②的纪律（「计划结果全部 await 汇总后才交给装配」）执行得很好，
但集成点③（「结果怎么影响装配」）被推迟，而**开关先放出来了**。

**建议方向**
开关置灰/标注「实验：仅产出审计字段，不改变上下文」，或在 UI 上把 `retrieval_plan`
明确标为「规划结果（未参与装配）」——现在只有 API 字段名，界面措辞容易让人误解。

---

### A1-08 ｜热备池未接线；而机读契约与评审文档仍宣称 `NOVELSTUDIO_HARNESS_POOL` 开关

**可信度：已确认**

**证据**

模块自述：
```
ai/harness-pool.mjs:28-31
 * ⚠️ **接线状态（2026-09-25 验收核实）**：本模块目前**没有接线到生产路径**——`harness.js` 仍走
 * 既有的 "每任务一个 dsh 子进程" 出口，**没有任何环境变量开关**（曾经文档里写的
 * `NOVELSTUDIO_HARNESS_POOL=1` 在代码里不存在，写了也不生效）。
```
全仓 grep `createWarmPool|runPromptOnWorker|createSpawnWorker|NOVELSTUDIO_HARNESS_POOL`：
- `createWarmPool` / `runPromptOnWorker`：只在 `ai/harness-pool.mjs` 自身
- `createSpawnWorker`：只在 `ai/harness-sdk-worker.mjs:57` 定义 + 文件头注释
- `NOVELSTUDIO_HARNESS_POOL`：**代码零命中**；但仍在两处文档/夹具里：
```
docs/host-contract.v1.json:503      "NOVELSTUDIO_HARNESS_POOL"        ← 机读契约夹具
docs/code-review-2026-09-19.md:27   「ai/harness-pool.mjs / ai/harness-sdk-worker.mjs | 常驻 dsh 热备池与协议握手（默认关闭，可开关）」
docs/code-review-2026-09-19.md:89   「热备池默认关闭（`NOVELSTUDIO_HARNESS_POOL=1` 才启用）」
```
反证（已订正的文档）：`README.zh-CN.md:606`、`docs/main-v2-upgrade-2026-09-24.md:88`、
`docs/main-v2-acceptance-2026-09-25.md:258-259` 都已明确「无环境变量开关、未接线」。

**为什么是问题**
「未接线」这件事已被多处正确记录，**但机读契约夹具 `docs/host-contract.v1.json` 里那个不存在的
环境变量还没删**。夹具是自动化核对的输入（`docs/host-contract.md:9` 指明由
`.p1-baseline/test-host-contract.mjs` 断言），保留一个不存在的开关会：
① 让「契约 = 代码事实」这句承诺在机读面上失真；
② 让后来者按夹具去设变量，得到「设了没用」的静默失败（正是该项目在别处专门消灭的失败模式，
见 `harness.js:39-41` 对「填了路径、下一个任务仍报未找到」的复盘）。

**用户影响**
- 章节数与通道无直接关系；影响面是**维护者与自动化**：按契约文档操作得不到反馈，
  与 A1-10 同属「文档与代码不一致」类，成本落在后续每一轮排查上。

**根因**
「订正文档」的动作只覆盖了叙述性文档（README / 验收报告 / 模块头注释），
**没有覆盖机读夹具**——因为夹具的编辑与文档的编辑不在同一次改动里。

**建议方向**
从 `docs/host-contract.v1.json` 移除该键（或改为显式 `"not_implemented": true` 形式），
并让 `test-host-contract.mjs` 增加一条「夹具里声明的每个环境变量都必须在代码中被读取」的断言——
这才是防止同类漂移复发的结构性修复。

---

### A1-09 ｜`ENGINE.md` 的层数与契约版本已过期

**可信度：已确认**

**证据**
```
harness-plugins/novel-writing/ENGINE.md:57
> 唯一真源是 `ai/context/layers.mjs` 的 `LAYERS`（**14 层**，分 fixed / flex / cond / entity 四类）
实测：LAYERS.length === 18（node 打印，见 §4.1）

harness-plugins/novel-writing/ENGINE.md:7
> **宿主契约（稳定性承诺）见 `docs/host-contract.md`（版本 1.0.0；机读面 `docs/host-contract.v1.json`）。**
实测：server.js:1112   const HOST_CONTRACT_VERSION = '1.19.0';
```
同一文件 `ENGINE.md:62` 的预算数字**是对的**（26000 / 19000；下限 21364 / 18173，实测一致），
`ENGINE.md:67` 的压缩提示线 1200 也与 `server.js:1793 MEMORY_COMPRESS_HINT = 1200` 一致。
→ 漂移是**局部的**（层数、契约版本），不是整体过期。

对照：`docs/ai-core.md:21` 与 `:56` 都正确写了「18 条（14 条常规 + 4 条门控）」，
`docs/context-contract.md` 的 14+4 表也与代码一致（§二 表格 + §二 门控层表）。

**为什么是问题**
`ENGINE.md` 是**插件侧**的说明书（`harness-plugins/novel-writing/ENGINE.md:1`
「Novel Studio × dsh 创作内核（ENGINE）」），是 dsh 侧开发者/模型人设维护者最可能先读的文件。
它对契约版本的引用错误尤其有害：`ENGINE.md:7` 明确说「插件只依赖这份契约，
不依赖宿主内部实现」——那么「插件作者以为契约是 1.0.0」就意味着他会按 1.0.0 的能力假设写代码，
而实际契约已经是 1.19.0（`server.js:1085-1111` 记录了 1.0.0 → 1.19.0 的全部附加式变更）。

**用户影响**
- 与章节数无关；影响插件/内核的后续维护成本，以及模型人设（`cordis.patch.yml`）里
  对层数的描述是否误导模型。

**根因**
`ENGINE.md:56` 自己写了「本节**刻意不再重抄各层数字**——上一版就是把 cap 表抄进文档，重构后整段失效」，
但紧接着的括号里仍然抄了一个**层数**。也就是：删掉了会腐烂的 cap 表，却留下了同样会腐烂的计数。

**建议方向**
把那句改成「层数与 cap 以 `GET /api/novel/context` 的 `context_manifest` 为准」，
契约版本改为「以 `GET /api/novel/ping` 的 `host_contract` 运行时读取为准」
（`ENGINE.md:8-9` 已经写了这个端点，只是没当成唯一来源）。

---

### A1-10 ｜`ai-core.md` 说「旧的前端拼装保留为兜底」，代码与另一份契约都说不保留

**可信度：已确认**

**证据**
```
docs/ai-core.md:149
2. 前端把 `assembled` 放进提示词（`aiContextBlock()` 直接采用；旧的前端拼装保留为兜底）
```
代码（无兜底）：
```
public/app.js:7957-7960
  // P2：提示词文本改由服务端**唯一装配器**产出…旧前端拼装没有预算，且历史上会绕过服务端装配器喂入约 7.4 万字；
  // 这里不再保留该兜底：loadAIContext 会在缺少 assembled 时回退 /novel/context。
  return typeof ctx.assembled === 'string' ? ctx.assembled : '';
```
`loadAIContext` 的回退是「重新请求 **服务端** 端点」，不是「前端自己拼」：
```
public/app.js:7887-7894
      if (ctx && !(typeof ctx.assembled === 'string' && ctx.assembled) && workId) {
          const assembledCtx = await api(`/novel/context?${qs.toString()}`);
```
另一份契约明确**禁止**重新引入前端拼装：
```
docs/context-contract.md:376-377
1. **不许重新引入无预算的兜底上下文**：提示词正文只有一个来源——装配器的 `assembled`。
   前端在拿不到 `assembled` 时是去**重新请求** `/api/novel/context`，而不是自己再拼一份；
```

**为什么是问题**
`docs/ai-core.md` 是「AI 内核现状」的**总览文档**（`ai-core.md:1-8` 自述），
它与 `docs/context-contract.md`（契约）就同一条禁令给出**相反描述**。
读者若按 `ai-core.md:149` 理解，会以为存在一个安全兜底；
若不知道兜底已被删除，就不会去检查「`assembled` 为空时提示词里会不会出现『（无）』」这个真实后果。

顺带指出一个**真实的行为后果**（与文档归属无关）：当 `assembled` 为空字符串时，
12 处提示词全部走 `aiContextBlock() || '无'` 分支，提示词里出现：
```
public/app.js:8573   aiContextBlock() || '无',
```
即模型收到「【当前小说上下文】\n无」，而**没有任何提示说明「上下文装配失败了」**。
`loadAIContext` 的两层回退（`7883` → `7894`）之外没有第三层，且回退失败时 `catch` 是静默的
（`7896` `catch (_) { /* 回退失败时保留 /ai_context 的结构化字段供界面预览 */ }`）。

**用户影响**
- 100 章：单次装配失败（如时态游标降级、DB 忙）→ 该章在**零设定上下文**下成文，
  作者只看到结果「不对劲」，看不到原因。
- 300/500 章：同上，且失败概率随层数与数据量上升（`buildNovelContext` 的取数路径很长）。

**根因**
两份文档对同一条纪律分别演进：契约文档记录「禁止兜底」的新决定，
总览文档的对应句子没有随之更新——因为总览文档是**叙述性**的，缺少与代码的核对机制。

**建议方向**
① 修正 `ai-core.md:149`；② 给「`assembled` 为空」加一条前端显式告警
（`reportClientLog` + toast），让「上下文缺席」可观测——这与该项目在
`recallGapReason` 上确立的「缺口不得静默」是同一条纪律，只是还没覆盖到装配整体。

---

### A1-11 ｜直连通道无 429/退避处理，且只有总超时、没有停滞超时

**可信度：已确认**

**证据**
```
server.js:1141-1142   const controller = new AbortController();
                      const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
server.js:1240/1245   流式版相同；AI_REQUEST_TIMEOUT_MS = LONG_AI_TIMEOUT_MS = 30*60*1000（server.js:1079 / ai/policy.mjs:103）
server.js:1156-1161   if (!resp.ok) { … err.status = resp.status; err.detail = data; throw err; }
```
- **无** `429` / `Retry-After` 处理：全仓无相关分支。
- **无**指数退避：唯一的「重试」是 URL 形态回退（404/405/URL 类错误），见 `server.js:1199-1202` / `1338-1340`。
- **无**停滞超时：`controller.abort()` 只在请求开始后 30 分钟触发一次；
  流式期间若上游停发数据，`reader.read()`（`server.js:1273`）会一直 pending，
  界面无字节、无进度，直到 30 分钟总超时。
- 前端有**内容驱动**的重试阶梯（非错误驱动）：`public/app.js:6903-6940`（空回复 → 放宽上限 →
  仍空 → low effort）。它对「空回复」有效，对「429」无效。

**为什么是问题**
30 分钟且无进度信号，与该项目自己在 `server.js:1074-1078` 记下的教训正面冲突：
```
// 若这里写死 30 分钟而策略表被调大，直连路径会在旧上限处静默 abort，
// 报错形态（AbortError）看起来像网络故障 —— 2026-09-18 第四轮重审把这条也收回单点。
```
即：项目已经识别出「超时 abort 看起来像网络故障」这个可诊断性问题，
但只解决了「常量同源」，没有解决「停滞时无信号、无区分」。
另外，`reasoning_content` 相位上报被设计为**只报一次**
（`server.js:1288-1292`，`thinkingNotified` 单次标志），
因此长时间思考期间客户端在收到第一个 reasoning 帧后就再无进度。

**用户影响**
- 100 章：一次 429（并发/配额）→ 直连抛错 → 前端回退慢通道（`10648-10659`），
  用户多等 17 秒冷启动，且日志里是一条「上游错误」而不是「被限流」。可接受但不可归因。
- 300/500 章：章节变长 → 生成时间变长 → 触及 30 分钟总超时的概率上升。
  命中时错误文案是统一的「网络故障」形态，作者无法区分「模型太慢」与「网络断了」，
  也无法判断该不该重试（重试会再花一次钱）。

**根因**
超时模型只有「总时长」一维；流式路径接上 `onThinking` 相位后，
「停滞」在语义上被误认为已被「思考中」覆盖（而该信号只发一次）。

**建议方向**
① 加**停滞超时**（例如 120 秒无任何 chunk 即 abort，错误码区别于总超时）；
② 对 `429` 读 `Retry-After` 并做一次有上限的等待重试（仅直连、仅 429，不扩大到 5xx）；
③ `onThinking` 改为带节流的心跳（例如每 15 秒一次），而不是一次性标志。

---

### A1-12 ｜慢通道 token 用量不可得 → 最贵的调用最不可观测

**可信度：已确认**

**证据**
```
harness.js:803-804
    // 🐞 运行追踪：慢通道只记到进程边界（job id / 模型 / 耗时 / 成败）。
    // Token 不可得——dsh headless 驱动显式丢弃 usage 事件，stdout 只输出正文。
harness.js:948        resolve(stdout.trim());
public/app.js:10662   // token 明细（缓存命中 / 思考占比）同样只有流式直连才有 usage；慢通道拿不到就不编。
```
`ai_eval_events` 记录的是 `chars_in` / `chars_out`（`server.js:8551`），不是 token。

**为什么是问题**
按 `ai/policy.mjs:35-39` 的设计，`quality` 档承载「结果会喂给之后每一章」的环节：
AI 审稿、AI 修稿、设定生成的成文轮、AI 自动创建小说、长期记忆压缩。
这些环节在**两条通道里偏向慢通道**（审稿/修稿/创建小说/压缩都走 harness，
`public/app.js:9455/9601/9628`、`server.js:8258/8263`）。
结果是：token 与成本可见性**恰好缺席在最贵的那批调用上**，
而相对便宜的直连成文反而有完整 usage（含 `prompt_cache_hit_tokens`）。
同理，`ai-core.md:216` 记录过「两次真实调用：模型为『≤800 字』任务实际产出 5.6k~22k 字（含推理，同样计费）」——
这类超额**只能靠事后察觉**，因为慢通道没有 usage。

**用户影响**
- 100/300/500 章：作者无法回答「这一章审稿花了多少钱」。
  长篇连载的主要成本来自审稿/修稿/压缩的重复调用，因此**成本不可控的部分正是主体部分**。
  作者只能靠 `ai_eval_events` 的字符数间接推断，而字符↔token 的换算对含大量推理输出的调用不成立。

**根因**
能力缺口在 dsh 侧（headless 驱动丢弃 usage 事件），本项目选择了「如实不编」（正确），
但没有补上**替代观测**（例如按 stdout 字数 + 已知 max_tokens 给出区间估计，并明确标注为估算）。

**建议方向**
在 `harness.js` 的 `recordHarnessTrace` 里补 `stdout_chars` 与 `max_tokens_requested`，
并在运行追踪面板标注「慢通道：输出字符数（token 不可得）」——
与 `tokens.mjs:64-66` 的 `TOKEN_ESTIMATE_NOTE` 同一种「标注为估算」的纪律。

---

### A1-13 ｜HEAD 基线上 temporal 引擎状态为空时 `story_state` 层静默消失（工作树已修） ⚠️ 仅 HEAD 成立

**可信度：已确认（git diff 直接对照）**

**证据**
```
HEAD 版本（git diff 的删除行）：
server.js  -        if (builtTemporalState.text) {
server.js  -          storyStateLayer = L('story_state', builtTemporalState.text, {

工作树版本（当前运行代码）：
server.js:3250      if (builtTemporalState.text || StoryState.isEnabled(workId)) {
server.js:3251        storyStateLayer = L('story_state', builtTemporalState.text || '【故事状态】当前暂无已确认的状态事实；不得把候选内容当作正典。', {
```
同一处 `git diff` 还显示 legacy 分支同样被修（`-if (built && built.text)` → `+if (built && (built.text || StoryState.isEnabled(workId)))`）。

**为什么是问题（针对声明的基线 `565a30a`）**
在 HEAD 上，若作品开了 `story_state` 但尚无任何已确认状态事实（新建作品、刚开启开关、
或时态游标降级到空 views —— `context-provider.mjs:115` 的 degradation 分支就是空视图），
`builtTemporalState.text` 为空 → **整层不存在** → 模型与作者都无从得知
「本该有一层故事状态但它是空的」。这正是该项目自己判定为缺陷并在语义召回上修掉的形态：
```
ai/context/layers.mjs:140-147
 * 为什么这条判据住在内核模块而不是 server.js 里：…三处必须同源，否则会出现
 * "上下文里插了占位、界面却说一切正常"这种自相矛盾。
```
工作树的改动把这个姿态推广到了 story_state 层（正确的方向），
但它以**未提交**状态存在 —— 任何以 HEAD 为基线运行/验收的流程都会得到旧行为。

**用户影响**
- 100 章：新建作品默认开启 story state（`server.js:8641` `StoryState.setEnabled(newId, true, …)`），
  首个状态事实被作者确认之前，每章都在「没有状态层」下生成，且界面不提示。
- 300/500 章：不适用（存量作品的 temporal 视图通常非空）；
  但**时态游标降级**（`server.js:2855-2857` 记 error 级 `temporal_cursor_degraded`）时
  视图为空，HEAD 行为下该章静默失去全部故事状态；工作树行为下至少有一句显式说明。

**根因**
门控层的「存在性」判定写成「有内容才存在」（`if (text)`），
而「缺内容」与「不该存在」在渲染层没有被区分——`excluded`（`assembler.mjs:185-193`）
只报告未进装配的层，不区分原因；而门控层按设计又**不进** `excluded`。

**建议方向**
工作树的改法是对的，建议补一条离线断言钉住它：
「`story_state` 开关开启、状态视图为空时，`assembled` 必须包含 `story_state` 层且该层含显式占位文案」。

---

### A1-14 ｜被审计的工作树含 773 行未提交改动，且落在审计关键路径上

**可信度：已确认**

**证据**：见 §0.2。`git status --porcelain` → 15 个已跟踪文件被改（+773/−53）+ 21 个未跟踪文件；
关键三处（temporal 门控、legacy 门控、assembler 收缩 cap 钳制）都在 `git diff` 里。

**为什么是问题**
审计任务声明的基线是 HEAD `565a30a`，但那不是**运行**的代码。
本报告以工作树为准（唯一合理选择），代价是：A1-13 的结论在 HEAD 上不成立，
且 assembler 的收缩行为（§4.3）在 HEAD 上是**另一个**语义：
```
HEAD：rows[idx].section = renderSection(label, text, cap, …)   ← cap 可被调大到 2400，越过层规格声明的 cap
工作树：const appliedCap = Math.min(Number(cap), declaredCap);  ← 只能缩小
```
即 HEAD 上「收缩」可能**增加**某层占用（`story_tail` 声明 cap 1600，收缩档第一档 2400）。

**用户影响**
- 与章节数无关；影响的是**验收与回滚**：以 HEAD 复现验收会得到与工作树不同的装配结果，
  而 `capture-baseline.mjs` / `compare-baseline.mjs` 的逐字节对照是以数据版本为键的，
  没有任何机制会提示「你比对的是另一个代码版本」。

**根因**
审计/验收流程以 `git rev-parse HEAD` 作为基线标识，但仓库允许长时间存在未提交的工作树改动。

**建议方向**
审计流程记录基线时应同时记录 `git status --porcelain` 与关键文件 sha256（本报告 §0.1 已给出），
并在结论中区分「HEAD 成立 / 工作树成立」。

---

### A1-15（低） ｜`builtTemporalState.meta.counts` 无保护解引用（当前不可达，属脆弱点）

**可信度：高可信静态推断（未触发；已核对 `resolveContextCursor` 全部分支）**

**证据**
```
server.js:3252
  note: withCursorNote(`时态状态引擎（角色 ${builtTemporalState.meta.counts.characters}｜…）`),
```
而 `buildTemporalStoryStateLayer` 存在一个**不含 `counts`** 的提前返回：
```
ai/story-state/temporal/context-provider.mjs:315
  if (!cursor || !cursor.enabled || !cursor.views) return { text: '', meta: { engine: 'temporal', error: 'cursor_unavailable' }, sourceIds: null };
```
`counts` 只出现在正常返回里（`context-provider.mjs:340-344`）。
该 `if (cursorUsable)` 分支（`server.js:3246-3255`）**没有 try/catch**（try/catch 只在 legacy 分支
`3257-3272`），所以一旦进入，TypeError 会一路抛出 `buildNovelContext` → 整个上下文装配失败。

**为什么现在不可达**：`resolveContextCursor` 的两个返回路径**都**提供 `views`：
- 降级路径 `context-provider.mjs:106-116`（含 `views: buildViews(new Map(), new Map())`）
- 正常路径 `context-provider.mjs:179-204`（含 `views: buildViews(state, indexById)`）
且 `server.js:2859` 的 `cursorUsable` 要求 `cursor.enabled && cursor.ok !== false`。
逐分支核对后**当前不存在** `cursorUsable === true` 且 `views` 缺失的可能。

**为什么仍值得记录**：该不变量是**跨模块隐式约定**——
`server.js` 依赖「`cursorUsable` ⇒ `meta.counts` 存在」，而这个约定没有断言。
`resolveContextCursor` 未来增加第三个返回分支（例如新的 fail-closed 情形）就会破坏它，
且失败形态是「写作路径整条 500」，不是降级。

**建议方向**：`server.js:3252` 改为可选访问（`builtTemporalState.meta.counts?.characters ?? 0`），
或在 `server.js:3246` 分支也加 try/catch（与 legacy 分支对称）。

---

## 12. 确认正常工作、不是问题的部分

> 列在这里是为了防止把已实现能力误判为缺失。每条都给出可核对的证据。

1. **预算与可执行下限的真实性（已确认，实测）**
   `TOTAL_BUDGET = {settings:19000, default:26000}`（`layers.mjs:179`）与
   `computeFloor` 输出（`full=21364` / `settings=18173`）经 `node` 只读计算**逐字复现**，
   与 `docs/context-contract.md:116-117`、`docs/ai-core.md:94` 一致。
   下限低于预算（余量 4636 / 827），收敛循环**可达**——这正是文档里「先算下限再定常量」纪律的成效。
   门控层默认不计入下限（`layers.mjs:256-275` 的 `includeGated` 开关），
   含门控时 29875 > 26000，说明这个默认值是**必需**的，不是可选项。

2. **门控层「关闭时逐字节不变」的承诺成立（已确认）**
   `compositionOf` 首行自闸 `if (!isEnabled(w)) return null;`（`index.mjs:57`）；
   `libraryEnabled` / `edit_rules_enabled`（默认 `'0'`）/ `author_intent`（有数据才建）
   分别在 `server.js:3104/3225/3282` 短路。`excluded` 计算显式排除 `gated` 层
   （`assembler.mjs:185-186`），避免「凭空多一条」。→ 默认关闭的四个门控层不改变
   任何既有作品的 `assembled` / `manifest`。

3. **上下文完整性护栏是「逐条重算」而不是抽查（已确认）**
   `verifyContextIntegrity` 的 C1 用「清单各层渲染长之和 + 层间分隔符」与真实文本长度**逐字节对齐**
   （`integrity.mjs:60-63`），C6 用内容哈希钉住「装配后未被改写」（`:104-107`），
   C3 用 `shrunk`（而非 `truncated`）区分「被预算压」与「超本层 cap」——
   `integrity.mjs:73-77` 记录了第一版混淆二者在真实数据上误报 FAIL 的教训。
   FAIL 只记 error 日志不拦截（`server.js:3424-3439`），这是**有意的产品决策**并有文档说明
   （`context-contract.md:336-339`），不是遗漏。

4. **截断提示语与查回路径是派生而非硬编码（已确认）**
   `truncationNotice` 的工具名来自 `RETRIEVAL`（`assembler.mjs:60-63`），
   且 `noticeSampleLength()` 从 `RETRIEVAL` 取**最长工具名**核算提示语上界
   （`layers.mjs:226-233`，实测 56 字）——修掉了「写死 `novel_memory_read`(17) 而
   `novel_style_contract`(20) 更长导致上界被突破」的历史缺陷。
   `story_state` / `edit_rules` / `author_intent` / `library` 四个门控层**都已声明** `RETRIEVAL`
   （`layers.mjs:118/131/132/133`），18 层全覆盖。

5. **`NOVELSTUDIO_BASE_URL` 在唯一 spawn 出口兜底（已确认，且是结构性修复）**
   `harnessChildEnv` 给该变量一个等于本实例的默认值（`ai/harness-env.mjs:102`），
   调用方显式值优先（`:109`）。修复理由写在文件头（`harness-env.mjs:3-11`）：
   曾有两处调用点忘记下发，导致隔离实例上的 `novel_*` 工具回落到 3737 **写进生产库**。
   修在根上而不是逐个调用点补，`harness.js:848` 是唯一出口。这是本审计中见到的
   最干净的一处「单点收口」。

6. **直连通道的 usage 采集与落盘（已确认）**
   `stream_options.include_usage` 仅对 DeepSeek 端点下发（`server.js:1230`，避免第三方网关 400），
   流式最后一个 chunk 的 usage 被接住（`:1286`）并回传给调用方（`:1304`），
   直连非流式也挂在运行追踪上（`:1180-1184`）。
   `debug-trace.js:823-831` 归一化了 `prompt_cache_hit_tokens` /
   `prompt_tokens_details.cached_tokens` / `cache_read_tokens` 三种字段名。
   这是「前缀缓存到底命不命中」的唯一实测来源，链路完整。

7. **模型 JSON 解析的抢救链在真实事故后已加固（已确认）**
   2026-10-01 事故（蓝图 JSON 里的裸引号 → 整篇蓝图被写成第一章正文）之后：
   `parseBlueprintJSON` 逐字段抢救（`public/app.js:8737-8754`）+
   `detectNonProseOutput` 交付闸门（`:8746-8790`）+
   批量生成同样过闸门（`:11009-11010`，注释明写「一次跑 N 章，污染会跟着写回 N 章」）
   + 抢救时记 `blueprint_json_salvaged` 日志（`:10574-10580`）。
   这是本项目对「结构化产物解析失败不许降级成正文」这条纪律的完整落地。

8. **慢通道的超时/取消语义完整（已确认）**
   `killChildTree` 在 Windows 用 `taskkill /T /F` 杀**整棵进程树**（`harness.js:569-581`），
   理由写在 `ENGINE.md:272`：「只杀直接子进程的话，dsh 孙进程会继续回连工坊提交提案」。
   超时与取消都带明确的错误码（`HARNESS_TIMEOUT` / `HARNESS_CANCELLED`，`harness.js:879/726`）
   与「已生成的中间内容未能落盘」的用户提示（`:878`）。

---

## 13. 未能证实 / 需运行验证的部分

| # | 事项 | 为什么未能证实 | 需要什么才能证实 |
|---|---|---|---|
| U1 | `MAX_OUTPUT_TOKENS = 393216` 是否真是「DeepSeek V4 API 当前允许的最大输出 token 数」 | 这是**外部 API 事实**，仓库内无第二来源可交叉验证（`server.js:1072` 的注释是唯一出处） | 查官方 API 文档或实测一次超限请求的报错 |
| U2 | A1-01（temporal 模式下契约不进提示词）在**活实例**上的端到端表现 | 需要一部 `temporal_enabled=1` 且 `story_state enabled=1` 的作品；未运行实例（本审计零计费、不碰真实库） | `node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs` 造一部开启时态的测试作品，抓 `/api/novel/context` 的 `assembled` 全文，断言其中不含契约块 |
| U3 | A1-02（成文轮在截断时仍走直连）是否在真实长篇上**实际**发生 | 需要 `aiContextTruncated() === true` 的真实上下文（≥70 章、`outline` 被省略）。真实库不在本次可读范围 | 在隔离实例里构造 >70 章作品，令 `context_manifest` 出现 `truncated`，然后在浏览器 devtools 抓 `streamAIDirectWrite` 是否被调用 |
| U4 | 热备池接线后的真实冷启动收益（17–18s → ?） | `ai/harness-pool.mjs` 未接线，且收益测量需要真实 dsh 进程与真实计费端点 | 需显式授权 `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1` + 假端点（`docs/main-v2-acceptance-2026-09-25.md:185` 记冷启动收益实际来自预构建产物：1844ms） |
| U5 | `scanInjection` 在真实作者正文上的命中率与误报率 | 需要真实作品正文（本次不可读 `data/`）；且该扫描目前只覆盖 `story_state` 层（`index.mjs:133`），样本极小 | 在隔离实例导入一篇含指令式文本的长篇，跑 `scanInjection` 并人工判读 `high`/`low` 权重分布 |
| U6 | 前端 12 处提示词与后端 `assembled` 的**同源性**在全部调用点都成立 | 本次逐一核对了 `aiContextBlock()` 的 12 处调用（grep 命中 12 处），但未逐一验证每处的 `state.aiContext` 是否都在调用前刷新过 | `frontend-test.mjs` 已有 stub 机制（`:2221`），可为 12 处各写一条「调用前必先 loadAIContext」的断言 |
| U7 | temporal 引擎与 legacy 引擎在同一作品上的 **generation 质量差异** | 需要真实模型调用（真实计费）；项目自己也把这一项列为未验证（`docs/golden-novel-regression-2026-09-26.md:290` U1 / `:302` R1） | 同作品同章节同参数冻结 3 次采样，比较结构不变量 + 人工判读 |

> **隔离运行封装（供后续验证者使用，本次未执行）**：
> `node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs`
> 隔离变量由 `scripts/ci-isolated-run.mjs` 设置（本次只读查看未运行）；
> 切记**不要**把真实 `data/` 作为目标。

---

## 14. 审计方法说明与局限

- **做了什么**：逐文件 `read` 通读 `server.js` 的 AI 相关区段（1108–1466、2797–3600、4033–4119、
  4490–4710、5155–5260、8228–8360、8550–8670、8828–8895）、`harness.js` 全文、
  `ai/context/*` 五个模块全文、`ai/story-state/` 的 injection/semantic-context/preflight/contract/index、
  `ai/story-state/temporal/context-provider.mjs` 关键段、`ai/policy.mjs`、`ai/task-settings.mjs`、
  `ai/direction.mjs`、`ai/harness-env.mjs`、`ai/harness-sdk-worker.mjs`、`ai/memory-compress-prompt.mjs`、
  `harness-plugins/novel-writing/ENGINE.md`、`novel-tools.mjs` 关键工具、`docs/ai-core.md`、
  `docs/context-contract.md`、`public/app.js` 的 6859–6950 / 7855–7910 / 7948–7975 / 8500–8580 /
  9300–9360 / 10430–10790 区段。
- **工具**：`read` / `grep` / `glob` 工具读取；`pwsh` 运行只读命令（`git rev-parse` / `git status` /
  `git diff --stat` / `Get-FileHash` / `Measure-Object`）。
- **唯一执行的代码**：`node -e` 导入 `ai/context/layers.mjs` 做**纯函数**计算
  （`LAYERS.length` / `computeFloor` / `TOTAL_BUDGET` / `noticeSampleLength`）。
  该模块文件头自述「纯函数、零依赖、不碰数据库」，导入无副作用，不写任何文件。
- **未做**：未运行服务、未运行任何测试套件、未做任何模型调用、未读取任何真实作者数据。
- **推断与实测的区分**：凡标 `已确认` 者，均为「源码直接确认」或「纯函数实测」；
  凡涉及活实例行为的结论（A1-01 的端到端表现、A1-02 的真实触发、A1-12 的成本影响量级）
  均标为需运行验证，见 §13。
