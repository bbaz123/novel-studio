# 主体 V2 交付报告 · 上下文身份 / 完整性 / 溯源 + 压缩输入修复 + CI（2026-09-24 ~ 09-25）

> 这一轮的任务是「给后续的确定性故事状态插件打好宿主基础设施，同时清掉此前审查发现、
> 且当前真实代码里仍然存在的问题」。纪律：**质量优先、真实用户影响优先、最小行为变更、
> 先测量后优化、可回滚**。本报告只写**已经跑过、能复现**的东西；没做的、没验的，
> 都在第九节里如实列着。

---

## 一、一句话结论

- **生成行为没有变**：改前副本 vs 当前代码，同一批 50 个装配用例（6 部作品 × 5 种模式）
  `assembled` **逐字节 50/50 相同**；热/冷路径 p50 差异在噪声内（见第六节）。
- **但上下文从此可被追问**：每一层都有溯源来源、时间视角、知识范围与查回路径；
  清单与真正发给模型的文字必须**逐字节对得上**（完整性判定 C1–C8），并有内容哈希与请求身份。
- **顺带修掉 6 个真实缺陷**（其中 2 个会静默降低压缩/审计的可靠性，1 个让验收在隔离实例里恒红，
  1 个把「缺能力」伪装成「没花钱」，1 条断言钉死了调用形态，1 个让「花钱总闸」对自己的零计费探针
  假红——见 4.7）。
- **首次接入 CI**：离线 31 条 + 活实例 2 条，Windows/Linux 双平台，零计费；
  依赖下限按实测定在 Node **22.15**（原因见 6.3）。
- **收尾定案三件**（此前留给"你决定"的）：许可证 **MIT**（`LICENSE` + README/CONTRIBUTING/Roadmap 同步，
  第三方资产单列）；`vendor/models/*.gguf`（47.9MB）**随仓库提交**（`.gitattributes` 标 `binary`，
  校验与移除路径见 `vendor/README.md`）；CI 的 ubuntu 两格**加固后保留**（本机无 Linux 可预演 ⇒
  每个 job 先打平台事实 + 把「首次真红修脚本、不许整格放行」写进 workflow）。
- **工具循环第一次有零计费证据**：假端点补上「回一轮工具调用」（opt-in，两条线路都覆盖），
  `probe-harness-tool-loop.mjs` 实测 **7/7**（模型 → 工具 → 模型 真的跑通）；同时给花钱总闸加了
  **归属第二层**——零计费探针必须自证，否则总闸会把自己的探针误判成"花钱"（假红，见 4.7）。
- **慢通道（harness）重新变成「可测」**：dsh 0.1.7 把与模型的线路换成了 Messages API
  （适配器发 `{base}/v1/messages`），而本仓的假 LLM 端点只实现 OpenAI 形状——于是
  冷启动与工具循环的零成本测量**全部变成「端点没收到请求」**（一个把「走错端点」报成
  「没连上」的测量盲区）。本轮给假端点补上 Messages 形状与逐请求留痕 `hits[]`，
  实测**生产路径冷启动均值 4.4s**（样本 4.29–4.55s）、预构建比源码现场转译省 **≈2.2s**（见 7.4）。

---

## 二、本轮改了什么

### 2.1 新增的生产模块（纯函数、零依赖、可离线断言）

| 文件 | 作用 |
|---|---|
| `ai/context/tokens.mjs` | 规模估算 `estimateTokens()`（CJK 感知）。⚠️ **只用于横向比较**，不参与预算/裁剪决策 |
| `ai/context/integrity.mjs` | `verifyContextIntegrity()`：C1–C8 逐条重算 + 内容哈希 `shortHash()` + 人话摘要 |
| `ai/memory-compress-prompt.mjs` | 记忆压缩提示词模板（从 `server.js` 原样抽出，模板逐字未改） |
| `text-utils.js`（追加） | `plainText` / `plainTextHead` / `plainTextTail`（纯文本化与头/尾截取） |

### 2.2 改到的共享文件（行为改动集中在这几处，均为**附加**）

| 文件 | 改了什么 |
|---|---|
| `ai/context/layers.mjs` | 新增 `PROVENANCE`（14 层逐层声明 source / temporal_scope / knowledge_scope / selection / reason / known_gap）、`provenanceOf()`、`trimPriorityOf()`（**从 `FLEX_ORDER` 派生**，不另设一张会腐烂的优先级表） |
| `ai/context/assembler.mjs` | 每层清单增加 `sourceIds` / `scores` / `recoveryPath`；产出 `contextId`（内容哈希）、`integrity`、`envelope`（身份 + 预算 + selected / trimmed / excluded）；`stats` 增加 `estimatedTokens` |
| `server.js` | 每层喂**真实** `sourceIds`（章节 id 列表、记忆行 id、召回命中 uri……）；压缩提示词改调纯函数模块；未 PASS 时写 `error`/`warn` 日志（`kind=context_integrity`）；两条端点随响应下发 `context_id` / `context_request_id` / `context_integrity` / `context_envelope` |
| `harness-plugins/novel-writing/test/smoke.mjs` | 外部实例模式（CI）下改用**那个实例的**数据目录；只清理自己造的临时目录 |
| `.p1-baseline/audit-llm-calls.mjs` | 新增 `assertZstdAvailable()`：缺 zstd 能力时**响亮失败**（此前会静默报「0 次真实调用」） |
| `.p1-baseline/test-recall-gap.mjs` | 断言改为**形态无关**（钉「决定权在 recallGapText 手上」这条意图，不钉调用形态的字节） |

### 2.3 新增/更新的验收与工程化

- `.p1-baseline/test-context-manifest.mjs`（44 条断言）、`test-memory-compress-prompt.mjs`（20 条）、
  `verify-memory-compress-input.mjs`（前后对照工具）、`bench-context-build.mjs`（热/冷路径耗时基线）
- `scripts/ci-isolated-run.mjs`（隔离实例包装器；本轮修掉它的一个真实缺陷，见第四节 #3）
- `scripts/ci-offline-checks.mjs`（**CI 离线检查清单的唯一来源**，31 条）
- `.p1-baseline/fake-llm.mjs` 补 **Messages 形状**（dsh 0.1.7 走的线路）+ `hits[]` 逐请求留痕
  （含 404/405：把「走错端点」与「没连上」分开，这两件事在日志里长得一样）；
- `.p1-baseline/probe-cold-start.mjs` 冷启动测不到时改为报出**真实原因**（见 4.6）
- `.github/workflows/ci.yml`（首次接入 CI：离线矩阵 / 依赖下限 / 活实例三档；本轮加固：每个 job 先打平台事实）
- `.p1-baseline/probe-harness-tool-loop.mjs`（**新**）：零计费验证「模型 → 工具 → 模型」真的跑通
  （7/7，含"工具结果里真的出现被请求的文件"这条独立证据；接线进 `verify-all.mjs`）
- `.p1-baseline/audit-llm-calls.mjs` 的**总闸第二层**：把「拿到模型文本」的会话逐条归属到
  本地假端点（四重自证），归属不了仍判红；`--self-test` 8 条（含 5 条阴性对照），已登记进离线清单
- `.p1-baseline/fake-llm.mjs` 补「回一轮工具调用」（opt-in `--tool-call`，OpenAI 与 Messages 两条线路都覆盖）
- `LICENSE`（MIT）+ `vendor/README.md`（资产事实表）+ `README.md` / `CONTRIBUTING.md` 同步

---

## 三、历史问题清零表（PHASE -1 复核：逐项回到真实代码）

> 规则：**不以「以前修过」为结论**，每一项都在当前代码上重新看过。

| # | 历史问题 | 当前代码实际状态 | 影响真实用户？ | 本轮处置 |
|---|---|---|---|---|
| 1 | `getPath` / 畸形 URL 抛穿请求 | 已在请求入口 `try/catch`（`server.js` 的 createServer 分支，畸形 URL → 400） | 否 | 不改 |
| 2 | ZIP / EPUB 解压后大小无上限 | `zip-reader.mjs`：单条目 **128MB**、整包 **256MB**，中央目录声明值先拒、`inflateRawSync` 带 `maxOutputLength`、解压后再核实际长度 | 否 | 不改 |
| 3 | 静态文件路径用脆弱字符串前缀 | 已改 `path.relative(publicDir, filePath)` + `startsWith('..' + path.sep)` + `isAbsolute`（`server.js:4898`） | 否 | 不改 |
| 4 | `server.js` 职责过重 | 仍约 5,080 行。**渐进拆分**：本轮抽出了 `ai/memory-compress-prompt.mjs`（提示词组装）与 `ai/context/integrity.mjs`（判定）两块纯函数 | 否 | 继续渐进，不做一次性重写 |
| 5 | Direct / Harness 路由不统一 | 策略单点在 `ai/policy.mjs`；`verify-ai-branches.mjs` 断言 **0 处绕过** | 否 | 不改 |
| 6 | Harness 冷启动 / 热备池是否有真实机会 | 冷启动实测 **12.6s → 1.9s**（优先用预构建产物，`resolveDshLaunch`）；热备池（`ai/harness-pool.mjs`）经核实**未接线到生产路径**（无环境变量开关，2026-09-25 验收复核订正；此前"`NOVELSTUDIO_HARNESS_POOL=1` 才开"的说法在代码里不存在） | 否（默认行为未变） | **不接线**：当前瓶颈由"预构建产物优先"解决，池留作离线可用的加速层 |
| 7 | 记忆压缩 / 记忆护栏是否有重复大查询 | `compressStoryMemory` 全程 **3 条查询**（works / characters / world_entries）；章节正文一次读入后复用（提示词、出场判定、规模分档都吃同一份行）。摘要读取与 `getStoryMemoryRow` **共用同一条语句**，不额外打库 | 否 | 不改 |
| 8 | `LONG_AI_TIMEOUT_MS` 是否真正统一 | 单点在 `ai/policy.mjs`（30 分钟）；`server.js`、`harness.js`、前端兜底都引用它。（`harness.js` 里的 20 分钟是 **pnpm 命令**超时，不是 AI 调用） | 否 | 不改 |
| 9 | 流式空回复重试是否先保强度再降级 | 是。`public/app.js`：① 保持原 `reasoning_effort` + `max_tokens` 抬到 `min(16384, max(8192, base×2))` 重试；② 仍为空才 `reasoning_effort: 'low'` 兜底；③ 再空才抛错走既有回退 | 否 | 不改（已钉在前端执行验证里） |
| 10 | 是否仍有绕过预算的 legacy context fallback | 没有。提示词正文唯一来源是装配器的 `assembled`；前端拿不到时**重新请求** `/api/novel/context`，不再自己拼 | 否 | 不改（并写进契约禁令） |
| 11 | Context trimming 是否有 recovery | 有：`RETRIEVAL` 逐层给查回工具，I4 端到端断言「被裁层实调端点能取回」；新判据 C5 会把「被裁但没有查回路径」如实标成 WARNING | 否 | 本轮增补判据 |
| 12 | 现有 regression suite 是否完整 | 补齐为：离线 **31 条**（`scripts/ci-offline-checks.mjs`）+ 一键验收（`verify-all.mjs`，含活实例/私有数据项）+ 活实例 2 条（API 套件 187 项断言、插件冒烟 39 组） | 否 | 本轮补齐 CI 缺的自动化 |
| 13 | GitHub Actions | **此前没有** → 本轮新增 `.github/workflows/ci.yml` | 否 | 已补 |
| 14 | LICENSE | 复核时**仍未声明** → 本轮收尾已定案 **MIT**（`LICENSE` + README/CONTRIBUTING/Roadmap 三处同步，第三方资产单列） | 是（对外分发/被再使用时） | 已落地（第九节 #1） |
| 15 | 跨平台启动 | `start-novel-studio.cmd` **仅 Windows**；macOS/Linux 走 `npm start`（README 已写明差异） | 是（非 Windows 用户多一步） | 不改产品行为；列未完成项 |
| 16 | 受控 LAN 模式 | **没有**。服务只绑 `127.0.0.1`，并有 Origin/Host 本机校验 | 否（当前是刻意加固） | 列未完成项（要做得单独设计鉴权） |
| 17 | EPUB | 导入**已实现**（container.xml → opf → spine，零依赖 zip 读取，24MB 上限）；**导出**未实现 | 否（缺功能而非缺陷） | 列未完成项 |
| 18 | DOCX | **导入导出都没有**（全仓无 docx 相关代码；README 如实写着「尚未支持」） | 否 | 列未完成项 |
| 19 | 上下文预览 | **已在**（右侧参考面板「上下文」页 + 弹窗里的分层预览），本轮把身份/完整性/信封也随端点下发了 | 否 | 不改 |
| 20 | 零成本 harness 验证能力（假 LLM 端点）是否还成立 | **已被 dsh 0.1.7 打瞎**：`llm-deepseek` 改走 Messages API，而假端点只有 OpenAI 形状 → 慢通道一律 404，且旧日志不记路径，被读成「端点没收到请求」 | 否（生产用真端点，线路本身没问题） | 本轮修（见 4.6）：假端点补 Messages 形状 + `hits[]` 留痕 |

---

## 四、本轮新发现并修掉的缺陷（都有前后对照）

### 4.1 【质量·静默】压缩提示词引用了已被删除的 SQL 别名 → 「最近章节尾部」永远为空

- **现象**：记忆压缩提示词里写着「后为最近章节尾部」，但那一段用的是 `c.content_head` / `c.content_tail`——
  这两个别名在 2026-09-21「出场判定改读整章正文」时被删掉了，提示词里的引用留在原地。
  `undefined` 让那一段**恒为空**；缺摘要的章节在「全部章节摘要」里也**只剩标题**。
- **为什么危险**：压缩器只能靠摘要工作，而**正在写的新章**摘要往往是空的——最新剧情最可能被丢；
  而且摘要读起来照样通顺、**不会报错**。
- **修复**：整段组装搬进 `ai/memory-compress-prompt.mjs`（纯函数、可离线断言），引用整章正文；
  同时把「从头截断」（会把最新正文丢掉）改成**保前缀 + 取尾部**，并预留省略符使总长仍 ≤ 预算。
- **前后对照**（`node .p1-baseline/verify-memory-compress-input.mjs --db … --all`，只读）：

| 作品 | 「章节」段总字数 | 其中「最近章节尾部」正文 |
|---|---|---|
| 压力库 #2（1 章） | 14 → **974** | 0 → **700** |
| 压力库 #9（6 章） | 422 → **1334** | 0 → **912** |
| 压力库 #16（120 章） | 4441 → **5870** | 0 → **1429** |
| 压力库 #18（5 章，4 章正文为空） | 503 → 503 | 0 → 0（没有正文可放，如实报「不适用」） |
| **真实库 #9 雾都缝匠** | 422 → **1334** | 0 → **912** |
| 真实库 #18 无敌系统（50 章，44 章正文为空） | 2335 → 2335 | 0 → 0（同上） |

### 4.2 【可靠性·静默】审计工具的「缺能力」被伪装成「没花钱」

- **现象**：`.p1-baseline/audit-llm-calls.mjs` 依赖 `zlib.zstdDecompressSync`，而 Node **22.13 没有**这个 API
  （实测：v22.13.0 → `undefined`，v22.15.0 → `function`）。缺能力时它解不出内容，于是
  `countRealCallsSince()` 返回 **0** —— 一个**看门狗瞎了却报告「一切正常」**的形态，
  正是 2026-09-15 事故的同类。
- **修复**：新增 `assertZstdAvailable()`，并在 `auditSessions()` 入口调用：缺能力就抛错并说明该用哪个 Node。
- **对照**：Node 22.13 上现在报「当前 Node（v22.13.0）没有 zlib.zstdDecompressSync，无法审计 dsh 转录：
  请改用 Node ≥ 22.15」；Node 24 与 22.15 上 `test-gate-assert.mjs` **37/37** 通过。

### 4.3 【验收·恒红】隔离实例包装器不把隔离变量传给被跑的命令

- **现象**：`api-test-suite.mjs` 的封卷三条（I3ac/I3ad/I3ae）要读「本次会话的 JSONL」，路径由
  `NOVELSTUDIO_DATA_DIR` 拼出；而 `scripts/ci-isolated-run.mjs` 只把这个变量给了**服务端**，
  没给**被跑的命令**——命令于是退回到 cwd 下的 `.test-data-trace`（空目录），三条断言全报 ENOENT。
- **修复**：包装器把 `PORT` / `NOVELSTUDIO_DATA_DIR` 一并传给被跑的命令（测试与实例看同一份数据目录）。
- **对照**：修前 **180 通过 / 3 失败 / 4 跳过** → 修后 **183 通过 / 0 失败 / 4 跳过**
  （I3ac/I3ad/I3ae 现在 PASS，`after=0`）。4 条跳过是「全局配置写入」这类**不可隔离**的项，
  跳过不计入通过、也不假装通过。

### 4.4 【验收·红】插件冒烟在外部实例模式下读错数据目录

- **现象**：`smoke.mjs` 无论是否外部实例模式都自己造一个临时数据目录，于是
  「data/logs 下应存在滚动日志文件」这条断言去读那个**空目录** → ENOENT。
- **修复**：外部实例模式下改用 `NOVELSTUDIO_DATA_DIR`（即那个实例的数据目录）；
  并且**只清理自己造的目录**（否则会把还在跑的实例的数据目录抽走）。
- **对照**：修前「❌ 冒烟测试失败：ENOENT … novel-smoke-XXXX\logs」→ 修后 **全部 39 组断言通过**。

### 4.5 【验收·脆弱】召回缺口断言钉死了调用形态

- **现象**：`test-recall-gap.mjs` 用正则钉死 `recallGapText ? L('recall', recallGapText)` 这条**字面调用形态**；
  本轮给每层加了溯源 meta（`L(id, text, meta)`），断言随即变红，但**行为没变**。
- **修复**：断言改为形态无关（仍要求「决定权在 recallGapText 手上」），**意图不变**。
- **阴性对照（变异测试）**：把 `server.js` 里那个三元判断改成 `false ?` 后，断言**确实报红**
  （16 通过 / 1 失败）；改回后 `server.js` 逐字节还原（sha256 前后一致）。

### 4.6 【测量·盲区】假 LLM 端点不认 dsh 0.1.7 的新线路，把「走错端点」报成「没连上」

- **现象**：`probe-cold-start.mjs`（拆解每任务冷启动）本轮第一次跑出来的结果是
  「冷启动 **(端点没收到请求!)**」、三条路径全部退出码 1、stderr 只有
  `dsh: HTTP_404: DeepSeek Messages request failed (404)`。看起来像「端点没起 / 没连上」。
- **真因**：dsh 0.1.7 的 `llm-deepseek` 改用 **Messages API**——把 `$DEEPSEEK_BASE_URL`
  当 **Messages 兼容根**，在其后追加 `/v1/messages`（官方根 `https://api.deepseek.com/anthropic`）。
  假端点只实现了 `/v1/chat/completions`，于是**请求确实打到了**、但路径不认识；
  而旧日志只记「认得的聊天请求」，`requests` 数组为空 → 工具把 404 读成「没收到请求」。
- **为什么必须修**：这不是产品缺陷（生产走 dsh 自带的 `deepseek-official`，线路没问题），
  而是**测量能力缺陷**——少了它，「重新测量 Direct / Harness 的真实延迟与质量」这条要求
  在本机只能靠推断。测量工具说谎，比测量不出来更坏。
- **修复（两处，都在验收工具层，零产品行为变更）**：
  1. `fake-llm.mjs` 增加 Messages 形状（流式 6 事件序列照 dsh 自家测试端点的 `success` 行为：
     `message_start` → `content_block_start(text)` → `text_delta…` → `content_block_stop`
     → `message_delta(stop_reason)` → `message_stop`），并另设 `hits[]` 给**每条**请求留痕
     （ts / method / path / handled / reason）；`/health` 同时回报 `requests` 与 `hits`。
  2. `probe-cold-start.mjs` 用 `hits` 区分「没请求」与「有请求但路径不认识」，并把路径与原因打出来。
- **对照**：修前三条路径全部 `HTTP_404` + 「(端点没收到请求!)」；修后同一条命令产出
  `退出码 0 / 回复 "好的"` 与真实冷启动数字（见 7.4）。
- **附带发现（如实记）**：Messages 形状把 `system` 提在顶层、不在 `messages` 里，
  所以旧的 prompt 长度统计会**整整缺掉人设/工具说明那一截**；已分形状计算并实测两条线路
  对同一份内容报同一个字数（12 = 12）。当时的诚实边界是「假端点只回正文、不产生 `tool_use` 块」，
  这条边界已在 2026-09-25 补掉（opt-in `--tool-call` 可回一轮工具调用，见 4.7 与第九节 #13）。

### 4.7 【验收·假红】零计费探针被「花钱总闸」误判成真实调用（2026-09-25 修）

- **现象**：把新的工具循环探针接进 `verify-all.mjs` 后，最后一条「套件总闸」立刻判**未通过**：
  `检出 1 条真实调用（会话 2 条）：2026-09-24T16:33:27.869Z deepseek-flash「先用工具确认一下当前目录里有没有 package.json，」`。
- **真因**：总闸的判据是「转录里有 `request/header` **且** 有模型正文 = 计费」。探针的"模型"是
  **本地假端点**（绑 127.0.0.1、回罐头文本），而 dsh 的转录里**看不出端点是谁**——真调用与假端点
  在转录里长得一模一样。于是总闸把自己的零计费探针当成了花钱。
- **为什么必须修**：这不是探针的错，也不是该把总闸放松的理由。一个**恒假红**的总闸会被学会无视，
  而它恰恰是 2026-09-15 事故之后最重要的那道闸。
- **修复（只加严、不放松）**：给总闸加**归属第二层**（`attributeSyntheticSessions`）——每条
  「拿到模型文本」的会话都必须被一条**本地端点自证**解释掉，四重核对缺一即判红：
  ① 端点必须是回环地址（远端端点一律不认，真花钱的形态正是它）；② 端点自报的**实收请求数 ≥
  转录请求数**（转录多出来的那条 = 有流量没走本地）；③ 转录正文**包含**端点申报的罐头正文；
  ④ 申报时段与会话时间有交集（防陈旧申报替别人背书）。另加一条：一条申报只能认领一个会话。
  探针侧打一行 `SYNTHETIC_MODEL_SESSION {...}`（端点端口 / 实收数 / 工具轮数 / 罐头正文 / 时段），
  **即使探针自身断言失败也照打**——总闸问的是"钱有没有花"，不是"探针过没过"。
- **对照**：修前同一条命令 `未通过`（假红）；修后 `通过`，证据行写明
  `未检出（窗口内 dsh 会话 2 条：其中 1 条拿到模型文本，全部由本地假端点自证归属 127.0.0.1:<端口>）`。
  判据自检 **8/8**，其中 5 条是阴性对照（无申报 / 远端端点 / 实收数不足 / 正文对不上 / 时段不重叠 /
  一条申报认领两个会话）——**只严不松**：无法归属的文本会话仍然是红灯。
- **残留假设（如实记）**：归属依赖探针自报，是**可核对的证据**而不是形式化证明；真正的兜底仍是
  「总闸 + 人工看证据行」。已列进第九节 #14。

---

## 五、Context / Task / Trace / Recovery 契约（当前代码的真实形状）

### 5.1 上下文身份

| 字段 | 含义 | 语义边界 |
|---|---|---|
| `context_id` | **内容**哈希：`sha256(发给模型的文字)` 前 12 位 | 同一份内容永远同一个 id；可复现、可对照、可回归 |
| `context_request_id` | **这一次装配**的身份 | ⚠️ 装配结果有缓存，**缓存命中时 request_id 会被沿用**——它标识「这份内容来自哪一次装配」，**不是** HTTP 请求 id |

两条端点（`/api/novel/context`、`/api/ai_context`）对同一份内容返回**同一个** `context_id`；
实测（压力作品 #16 第 108 章）：`4bda5529515c`，两端口一致、完整性 PASS。

### 5.2 完整性（PASS / WARNING / FAIL）

判据 C1–C8 详见 `docs/context-contract.md` §8.2。要点：

- **C1** 清单逐层占用之和（含层间分隔符）= 真正发出去的文字长度 → 不一致即 FAIL（清单与文字必须同源）；
- **C6** 内容哈希复核 → 钉住「装配后被改写」；
- **C3** 零损失层（`kind=fixed`）**不因预算被收缩**（按本层 cap 截断不算违反，这是既有行为）；
- **C8** 有丢字却**没标成截断** = 静默裁剪 → FAIL；
- **C5/C7** 缺查回路径 / 缺溯源 → WARNING（**WARNING 不是通过**，它必须一直看得见）；
- **FAIL 不拦截生成**：拦截会改变真实用户行为（章节写不出来）。按最小行为变更纪律，本轮的做法是
  **响亮记录**（error 日志 + 响应字段 + 验收断言），是否升级为硬拦截属产品决策。

### 5.3 溯源（每层都能被追问）

- 静态一半：`layers.mjs` 的 `PROVENANCE` —— 每层的 `source` / `temporal_scope` / `knowledge_scope` /
  `selection` / `reason` / `known_gap`；
- 动态一半：`server.js` 取数处给的真实 `sourceIds` / `scores`（章节 id 列表、记忆行 id、召回命中 uri 与分数分布）；
- **两半都不手写进清单**，避免清单与实际取数漂移；裁剪优先级 `trimPriorityOf()` 从 `FLEX_ORDER` 派生。

### 5.4 信封（selected / trimmed / excluded）

`context_envelope` = 身份 + 预算 + `length` + `estimatedTokens` + `selected`（进了上下文的层，顺序即拼装顺序）
+ `trimmed`（被裁层：丢了多少字 / 采用多少 / 原多长 / 查回工具）+ `excluded`（**声明了却没来**的层与原因）。
实测同一章：`selected` 12 层、`trimmed` 7 层、`excluded` = `recall`（语义召回未启用）与 `terms`（本次无命中）。

`estimatedTokens` 的纪律：它是**附加信息**，不是预算单位。把预算从「字符」改成「token 估算」会改变每一层的
实际容量——那会直接改变模型看到什么，必须单独论证、单独回归，不允许借着「加个估算」顺手改掉。

### 5.5 Task / Run / Trace

- **任务身份**沿用既有设施，没有为「整齐」新造一张表：作业 `job_id`（`/harness/job`、`/harness/run`）、
  运行追踪的会话 id 与 op id（`debug-trace.js`）、以及本轮新增的 `context_request_id`；
- **可观测项**：路由 / provider / 模型 / 思考强度 / 上下文哈希 / 输入输出 token（操作级汇总）/ 起止与耗时 /
  重试与回退 / 状态与失败原因 —— 分别落在运行追踪、操作摘要与日志（`layer=ai`）里；
- **不合并成一张大表**的理由：这些身份各有各的生命周期（作业可取消、装配可缓存、追踪会话可封卷），
  强行统一会改动线上路径，收益不明确。

### 5.6 Recovery（凡裁剪必可查回）

- `RETRIEVAL` 逐层声明查回工具；I4 端到端断言「被裁层能被工具实调取回」；
- 召回缺口**显式占位**（不静默消失），判据单点在 `layers.mjs`；
- 新判据 C5 会把「被裁但没有查回路径」标成 WARNING —— 缺口的**可见性**优先于好看。

---

## 六、数据库、迁移与性能

### 6.1 数据库与 migration

- **本轮没有任何 schema 变更**：改动在上下文装配/展示/验收层，`db.js` 未改。
- 既有迁移仍按原方式工作（首次启动建表/加列，向后兼容旧库）：例如 `story_memory_proposals.guard`
  （来源标记跨落库存活）、`story_memories` 的版本化、`app_settings` 的键值对（`ov_indexed_at:<workId>` 等）。
- **可逆性**：因为没有 schema 变更，回滚不需要数据迁移；旧作品 / 旧章节 / 旧记忆 / 旧设置 / 旧插件数据
  在本轮前后**都被同一套代码读取**（本轮只加了「读出来的东西怎么描述」）。

### 6.2 性能前后（同一实例配置、同一份数据、同一章节：压力作品 #16 第 108 章，装配 20,713 字）

| 路径 | 改前 p50 | 改后 p50 | 结论 |
|---|---|---|---|
| `ai_context`（主成文路径，热） | 15ms | 15ms | 不变 |
| `novel/context?mode=full`（创作内核，热） | 15ms | 14ms | 噪声内 |
| `ai_context`（冷：每次先作废缓存） | 35ms | 37ms | 噪声内 |
| `novel/context`（冷） | 25ms | 26ms | 噪声内 |

复现：`node .p1-baseline/bench-context-build.mjs --base <实例> --work 16 --chapter 108 [--cold]`。
**只报数不下结论**：单次最大值受调度与磁盘噪声影响，判定看 p50/p95。
本轮**没有**为了性能引入任何缓存 / 批处理 / 记忆化 —— 因为没有测出真实瓶颈。

### 6.3 依赖下限：**22.15** 而不是 22.13（实测结论）

| 版本 | `node:sqlite` | `zlib.zstdDecompressSync` | 离线套件 |
|---|---|---|---|
| v22.13.0 | 可用（免 flag） | **没有** | 29/30（「花钱总闸」那条因缺能力而红——现已改为**响亮报错**） |
| v22.15.0 | 可用 | 有 | **30/30** |
| v24.19.0（本机） | 可用 | 有 | **30/30** |

- **产品运行**只要 22.13（`node:sqlite` 免 `--experimental-sqlite` 的门槛，`package.json` 的 engines 即此值）；
- **验收工具**（读 dsh 多帧 zstd 转录的「花钱总闸」）需要 22.15+；
- 所以 CI 的「依赖下限」那一格定在 **22.15**，它一次覆盖两件事。CI 其余格是 Node 24。

### 6.4 CI（新增 `.github/workflows/ci.yml`）

| 作业 | 平台 | 内容 |
|---|---|---|
| `offline` | windows + ubuntu × node 24 | `node scripts/ci-offline-checks.mjs`（31 条） |
| `node-floor` | ubuntu × node 22.15.0 | 同上（证明不是「只在 24 上能跑」） |
| `live` | windows + ubuntu × node 24 | `ci-isolated-run.mjs` 跑 API 套件 187 项 + 插件冒烟 39 组 |

纪律：**绝不调用真实 LLM**（离线套件只读文件；活实例套件在隔离实例里、用本机假端点/死端口）；
清单只有一个来源（YAML 里不抄第二份）；只信退出码。

⚠️ **本机没有 Linux/macOS 环境**，所以 `ubuntu-latest` 那两格**没有在本地预演过**；首次在 GitHub 上跑时
若出现平台差异，那属于**首次发现的真实缺口**，不是回归。

---

## 七、生成质量回归结果

### 7.1 最强的一条：逐字节等价

```
node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-before-v2 .p1-baseline/baselines-v2b --ignore-notice
→ A = 50 个用例；B = 50 个用例；逐字节一致: 50/50；结论: IDENTICAL（完全一致）
```

覆盖：2 部真实作品 + 压力作品的多个章节 × 5 种装配模式（`full` / `continuation` / `fragment` /
`settings` / `ai_context`）。`assembled` 是**提示词正文**里唯一进模型的那一段文字 —— 它逐字节相同，
意味着**模型看到的东西没有变**。（`--ignore-notice` 只归一「已按预算截断…」这类提示语里的工具名差异，
不掩盖正文差异。）

### 7.2 本轮**没有**动的质量敏感点（逐条声明）

- 模型与档位（`ai/policy.mjs` 未改）；
- 思考强度与 `LONG_AI_TIMEOUT_MS`；
- 提示词语义（压缩提示词模板**逐字搬迁**；只有「最近章节尾部」从恒空改成真的有正文——那是修缺陷）；
- token 预算与各层 cap（`TOTAL_BUDGET` / `FLEX_CAPS` **V2 未改**）。**口径订正（2026-09-25 验收复核）**：
  `ai/context/layers.mjs` 里 `TOTAL_BUDGET.settings = 19000` **不是 V2 引入的**——它来自 **2026-09-22 CR-1 轮**
  （新增 `terms` 层后 `computeFloor()` 可执行下限 17,356 → 18,173，旧常量 18000 已低于下限），有
  `docs/confirmation-resolution-2026-09-22.md`、`smoke.mjs` 断言为证；V2 只把该常量**定义**从 `server.js`
  搬到 `ai/context/layers.mjs`（**值未动**，搬迁已逐 token 比对）；
- 上下文层数与顺序（仍是 14 层，`FLEX_ORDER` 未改）；
- 生成后的文本处理（未改）。

### 7.3 验收结果（本轮最终一轮，全部零计费）

| 套件 | 结果 | 说明 |
|---|---|---|
| 一键验收 `verify-all.mjs`（活实例 3739 + 授权 spawn dsh 三条） | **通过 52 / 未通过 0 / 跳过 1** | 跳过那条是「harness 并发闸门」（会真的建任务，需 `--gate-base` 显式授权）——**跳过不是通过**；总闸证据行写明「1 条拿到模型文本，全部由本地假端点自证归属 127.0.0.1」 |
| 离线 31 条 `scripts/ci-offline-checks.mjs` | **31 通过 / 0 未通过** | 本轮在 Node 24.19 上跑齐（Node 22.15 的兼容性结论来自上一轮实测；本机没有 22.15 二进制，未重跑）；node 22.13 上「花钱总闸」**响亮报错**（缺 `zstdDecompressSync`） |
| API 套件（隔离实例） | **183 通过 / 0 失败 / 4 跳过** | 跳过是「全局配置写入」这类不可隔离项 |
| 插件冒烟（隔离实例） | **39/39** | 外部实例模式 |
| 上下文清单 / 完整性 / 溯源 | 44/44 | 含阴性对照 |
| 记忆压缩提示词 | 20/20 | 含变异测试 |
| 记忆压缩零损失护栏 | 66/66 | —— |
| 装配器单元（边界与溢出） | 32/32 | —— |
| 确定性连续性预检 | 69/69 | —— |
| 真实库未被删改（app_logs 差集归因）+ 判据自检 | 通过 | 正常增长不判红 |
| 花钱总闸归属判据自检 | **8/8**（含 5 条阴性对照） | `node .p1-baseline/audit-llm-calls.mjs --self-test` |
| 工具循环零计费证据 | **7/7** | `probe-harness-tool-loop.mjs`（实测两次 10.7s / 9.0s） |

> **阶段映射核对为什么不进 CI**（实测）：它的判据是「相对基线的改动集」，而 CI 的检出要么是合并后的树
> （改动集为空）、要么没有 `origin/main` 可比（退回 `HEAD`）——于是全仓改动集=0、推导出的回滚档全变
> `independent`，与声明的 `shared` 冲突 → **恒红 7 条**。它是**提交前**的核对工具（前提是「有未提交的
> 工作区」），跑在 `verify-all` 与本地流程里，在 CI 里只会制造假红灯。

### 7.4 慢通道（harness）冷启动：本轮第一次测出真实数字

补上 Messages 形状之后，`probe-cold-start.mjs` 能在**零计费**下把每任务的冷启动拆开测量
（冷启动 = 子进程启动 → 假端点收到第一个模型请求，用端点侧时间戳，不是估算）。
三次采样（第 1 次独占跑；第 2、3 次来自 `--runs 2`，当时有别的套件并发，**数值偏保守**）：

| 启动路径 | 冷启动样本（ms，时间序） | 均值 | 端到端（ms，同序） |
|---|---|---|---|
| A 现状：`tsx/esm` 现场转译源码 | 6239 / 6899 / 7501 | 6.9s | 6424 / 7107 / 7707 |
| B 对照：预构建 `apps/cli/lib/bin.js` | 4273 / 5185 / 4501 | 4.7s | 4441 / 5359 / 4675 |
| C **生产路径**：`harness.js` 实际选择的启动方式 | 4317 / 4553 / 4289 | **4.4s** | 4476 / 4726 / 4452 |

读法（**不夸大**）：C 与 B 同档（逐次差 44ms / −632ms / −212ms，落在采样噪声内）⇒
生产确实走的是预构建产物；A→B 的逐次差额 1966 / 1714 / 3000ms（均值 ≈2.2s）就是
「省掉每任务现场转译」的真实收益。这台机器上**冷启动仍是秒级**，热备池（默认关闭）
能省多少、稳定性与失败率如何，现在有了可复现的测法，不再是推断。
（复现：`node .p1-baseline/probe-cold-start.mjs --runs 2`；全流程零计费，端点自设。）

⚠️ 本表只说明**启动开销**，不构成生成质量证据；生成质量证据见 7.1 的逐字节等价。

---

## 八、用户可见行为变化清单

**结论：没有必须由用户适应的行为变化。** 逐项核对：

| 面 | 变化 | 用户感知 |
|---|---|---|
| 生成质量 / 文风 / 上下文内容 | 无（50/50 逐字节相同） | 否 |
| 界面 | 无新增按钮、无改版（只多收到几个响应字段，界面暂未展示） | 否 |
| API 响应 | 两条上下文端点**多了 4 个字段**（`context_id` / `context_request_id` / `context_integrity` / `context_envelope`） | 否（纯附加字段，旧字段与旧语义不变） |
| 日志 | 完整性非 PASS 时会多出 `kind=context_integrity` 的 warn/error 行 | 否（数据/正文不变） |
| 记忆压缩输入 | 「最近章节尾部」从**空**变成**真的有最近正文**（见 4.1） | 是——**这是修缺陷**：压缩摘要从此能看到最新剧情，长期记忆质量应上升；方向与用户诉求一致 |
| 默认开关 | 自动压缩、热备池等**默认值全部未动** | 否 |
| 成本 | 无新增调用；压缩输入变长会**略微增加**压缩那一次请求的输入 token（每作品一次，字数见 4.1） | 是（可忽略，但如实报告） |

---

## 九、未完成项与风险（如实清单）

| # | 项 | 类型 | 现状与建议 |
|---|---|---|---|
| 1 | ~~LICENSE 未声明~~ | **已定案（2026-09-25）** | **MIT**（见 `LICENSE`）；README / CONTRIBUTING / Roadmap 三处同步，第三方资产单列。要改回更严格的许可只需动 `LICENSE` 一个文件 |
| 2 | `ubuntu-latest` 两格 CI 未本地预演 | 风险（已加固） | 本机无 Linux（无 WSL / 无 Docker），**首次真红仍可能发生**。已加固：workflow 顶部写明该事实与静态审计结论、每个 job 先打**平台事实**、并钉死「首次真红要修脚本、不许整格 `continue-on-error`」 |
| 3 | ~~`vendor/models/*.gguf` 未提交 git~~ | **已定案（2026-09-25）** | **随仓库提交**（代价：每次 clone +47.9MB）：`.gitattributes` 标 `binary` 以免行尾转换；`vendor/README.md` 记录上游、SHA256 校验命令、代价与「不想要就删掉 `vendor/models/`」的路径 |
| 4 | DOCX 导入/导出 | 缺功能 | 全仓无相关代码；README 已如实标注「尚未支持」 |
| 5 | LAN 受控模式 | 缺功能 | 现在是**只绑 127.0.0.1 + 本机 Origin/Host 校验**；要开放局域网必须先设计鉴权（否则等于把含 API Key 的服务暴露出去） |
| 6 | 跨平台一键启动 | 缺功能 | `start-novel-studio.cmd` 仅 Windows；macOS/Linux 需 `npm start`（README 已写明） |
| 7 | 完整性 FAIL 是否升级为**硬拦截** | 产品决策 | 本轮刻意只「响亮记录」。升级会改变用户可见行为（章节可能写不出来），需要你点头 |
| 8 | `request_id` 在缓存命中时被沿用 | 已知语义边界 | 已写进代码注释与契约；若将来要「每次调用唯一」，需要另起一个 HTTP 级 id，不能复用装配层这个 |
| 9 | 阶段映射核对的 CI 假红 | 已知 | 已按实测把它移出 CI 清单，并在清单里写明原因 |
| 10 | 本机 Node 22.13 上跑不了「花钱总闸」 | 已知 | 现在会**响亮报错**并提示用 ≥22.15（此前是静默报 0） |
| 11 | 本轮未提交 git | 流程 | 提交与否等你确认（分支前缀建议 `codex/`） |
| 12 | dsh 0.1.7 把线路换成 **Messages API**（适配器发 `{base}/v1/messages`） | 风险（只影响**自设** `DEEPSEEK_BASE_URL` 的人） | 生产默认走 dsh 自带的 `deepseek-official`（官方根 `https://api.deepseek.com/anthropic`），用户无需干预。但若谁把该变量设成 **OpenAI 兼容**的第三方网关（旧线路时代的做法），慢通道会 404——现在它必须是 **Messages 兼容根**。本仓 README 从未建议用户自设它，故默认无感 |
| 13 | ~~假 LLM 端点不产生 `tool_use` 块~~ | **已定案（2026-09-25）** | opt-in `--tool-call` 可回**一轮**工具调用（OpenAI 与 Messages 两条线路都覆盖，判据只有一条且确定：**请求里已带工具结果 → 回正文，否则 → 回工具调用**）。零计费证据 `probe-harness-tool-loop.mjs` **7/7**。**边界**：不做多步工具链规划，也不校验工具参数的业务语义 |
| 14 | 花钱总闸的归属第二层有**残留假设** | 已知（如实记） | 归属靠探针自报 `SYNTHETIC_MODEL_SESSION`，是**可核对证据**而非形式化证明；一条申报只认领一个会话。已用 8 条自检（含 5 条阴性对照）钉住主要误用形态（见 4.7） |
| 15 | 工具循环探针需要 **dsh 仓库 + 显式授权** | 边界 | 只有 `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1` 且 `../deepseek-harness/package.json` 存在才跑；CI 里两条都不满足 ⇒ 该项在 CI 是 SKIP（**跳过不是通过**） |

---

## 十、复现（全部零计费）

```powershell
# ① 离线（不需要实例、不碰私有数据）
node scripts/ci-offline-checks.mjs

# ② 活实例（隔离：临时数据目录 + 假端点/死端口）
node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs
node scripts/ci-isolated-run.mjs --port 3738 -- node harness-plugins/novel-writing/test/smoke.mjs

# ③ 一键验收（需要活实例；会 spawn dsh 的三条需显式授权）
#    活实例要挂压力库（探针章节 #227 在里头），用隔离包装器起最省事：
$env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'
node scripts/ci-isolated-run.mjs --port 3739 --data .p1-baseline/stress-data -- node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3739

# ④ 本轮的针对性证据
node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-before-v2 .p1-baseline/baselines-v2b --ignore-notice
node .p1-baseline/bench-context-build.mjs --base http://127.0.0.1:3739 --work 16 --chapter 108 --cold
node .p1-baseline/probe-cold-start.mjs --runs 2        # 慢通道冷启动拆解（会 spawn dsh；自设假端点，零计费）
node .p1-baseline/probe-harness-tool-loop.mjs          # 模型 → 工具 → 模型（会 spawn dsh；自设假端点，零计费）
node .p1-baseline/audit-llm-calls.mjs --self-test      # 总闸归属判据（8 条，含 5 条阴性对照）
node --input-type=module -e "const {startFakeLLM}=await import('./.p1-baseline/fake-llm.mjs');const l=await startFakeLLM({port:0});await fetch('http://127.0.0.1:'+l.port+'/v1/messages',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'hi'}]})});console.log(l.hitsCount(),l.count());await l.close()"
node .p1-baseline/verify-memory-compress-input.mjs --db data/novel.db --all   # 只读
node .p1-baseline/test-context-manifest.mjs

# ⑤ 提交前的阶段映射核对（改动归属 / 证据存在 / 文档一致）
node .p1-baseline/verify-phase-map.mjs --write   # 清单变了先重生成文档
node .p1-baseline/verify-phase-map.mjs
```