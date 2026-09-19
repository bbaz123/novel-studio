# C-第一次代码审查报告

> 📌 **归档注记（2026-09-19 交付时补，正文未改）**：本报告是「第 1 步：只读审查」的原始输出，
> 由工作区根目录的 `C-第一次代码审查报告.md` 原样归档到 `docs/`。
> 文中 `文件:行号` 是**审查当时**的位置，第 2～5 步的修复已使其中若干处发生位移——
> 找代码请按符号名（`compressStoryMemory`、`agentMemoryGuardOf`、`getPath`、`zip-reader.mjs` 的两个上限常量）定位，
> 不要照行号找。修复结果与遗留项见 `docs/code-review-2026-09-19-summary.md`。

审查日期：2026-09-19
审查范围：novel-studio 全仓（`server.js`、`db.js`、`harness.js`、`openviking.js`、`openviking-sync.js`、`logger.js`、`debug-trace.js`、`public/app.js`、`public/index.html`、`ai/**`、`harness-plugins/novel-writing/**`、文本/EPUB 工具与文档）
审查方式：只读静态审查 + `node --check` 语法检查（未运行业务测试，未修改任何代码）
结论：项目结构清晰、模块边界明确、SQL 参数化与安全基线扎实；未发现必须立即停止的崩溃级缺陷。质量风险集中在“长期记忆压缩的实体出场判定只读章节头部”这一处，会以静默丢实体的方式累积影响后续每一章的上下文质量；另有少量健壮性与可优化项。

---

## 一、功能结构确认

| 模块 | 主要职责 |
|---|---|
| `server.js` | 单文件 HTTP 服务与 API 路由：AI 直连/流式/慢通道、上下文装配、记忆压缩、红线扫描、故事事件/提案、导入导出、演示数据、通用 CRUD、harness 作业设施 |
| `db.js` | `node:sqlite` 建库、22 张表、幂等迁移、时间戳归一、模型名清理、索引与去重唯一索引 |
| `ai/policy.mjs` | 模型档位与思考强度单点策略表：`fast`/`quality` 均映射 `deepseek-flash`，质量优先由 `EFFORT_BY_TIER.quality='high'` 表达 |
| `ai/context/*` | 13 层上下文规格、唯一装配器、装配结果缓存（进程版本 + 记忆库索引时间戳） |
| `ai/memory-compress-guard.mjs` | 记忆压缩/模型自压缩的零损失护栏：完整性 + 无中生有两侧判据 |
| `ai/task-settings.mjs` | 每任务独立 settings 文档，消除全局模型切换副作用，吞吐回到 2 |
| `ai/sync-gate.mjs` | 在途同步与移除目录之间的顺序闸，消除孤儿目录竞态 |
| `ai/harness-pool.mjs` / `ai/harness-sdk-worker.mjs` | 常驻 dsh 热备池与协议握手（默认关闭，可开关） |
| `openviking.js` / `openviking-sync.js` | OpenViking 凭证解析、HTTP 客户端、离线队列、六类数据渲染、全量同步、语义召回 |
| `harness.js` | dsh 仓库解析、构建、每任务 settings、子进程运行、模型切换互斥 |
| `public/app.js` | SPA：AI 写作蓝图/成文/补足/质检、流水线、上下文预览、记忆与提案交互 |
| `harness-plugins/novel-writing/novel-tools.mjs` | dsh 侧 `novel_*` 工具集，与工坊本地 API 接线 |

---

## 二、按“质量优先”原则的重点问题

### Q1（高）长期记忆压缩的“出场判定”只读章节头部，可能静默丢实体
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:1313`、`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:1324`、`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:1411`
- 现状：`compressStoryMemory` 与 `agentMemoryGuardOf` 都执行 `SELECT title, summary, substr(content,1,1500) AS content`，再在 `partitionByAppearance` 里用 `plainTextHead(content,500)` 判断“哪些角色/世界观出现过”。长章节里出现在第 1500 原始字符之后、且摘要未提的角色，会被判成“未出场”。
- 影响：护栏的 `mustKeep` 名单漏掉该实体 → 压缩摘要可以静默丢掉它；同时压缩提示词刻意“未出场一律不提”，模型也不会补。此摘要会喂给之后每一章，属于最难发现的累积性质量损失。
- 建议方案（不降质量）：把“出场判定语料”改为“每章完整正文（经 `htmlToPlain`）+ 章节摘要 + 事件账本”，或对超长章用“头部 8000 + 尾部 8000”双窗采样；此判定是本地 SQLite/CPU 操作，不产生 AI 费用，且能真正兑现零损失承诺。

### Q2（中）压缩提示词顺序截断，长篇作品的后期剧情与靠后实体进不了压缩输入
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:1332`
- 现状：`chapterText.slice(0,6000)`、`characterText.slice(0,3000)`、`worldText.slice(0,3000)`，均为“从头部截断”。章节很多时只压缩前几章，角色很多时只压名字排序靠前的人。
- 影响：长期记忆是后续每一章的输入，若压缩时丢了后期进展，后续生成连贯性下降。
- 建议方案：章节部分改用“全部章节摘要（紧凑且覆盖全程）+ 最近若干章全文/尾部”；角色/世界观改用“名字/标题 + 一行状态”的紧凑列表，先保证覆盖度，再按需要限量。

### Q3（中）成文流式空回复重试直接把思考强度降到 `low`
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\public\app.js:4678`
- 现状：成文流式遇到空回复（疑似思考吃光输出预算）时，重试参数为 `reasoning_effort:'low'` + `max_tokens` 上限放宽。这个兜底以“降低质量档思考预算”为代价换可用性。
- 影响：只在空回复兜底时发生，通常优于整轮失败；但若频繁触发，重试稿质量会低于正常路径。
- 建议方案（可验证后再定）：优先“保持当前 effort、只提高 `max_tokens`”重试一次，仍空再降为 `low`，把质量降级放到最后一档；需用真实/假 LLM 端到端验证 DeepSeek 对 `max_tokens` 是否包含推理 token 的语义。

### Q4（低）前端仍保留“无预算”旧拼装兜底，存在再次引入 7 万字上下文的风险
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\public\app.js:5450`、`C:\Users\a1941\Desktop\DeepSeek\novel-studio\public\app.js:5457`
- 现状：正常路径使用服务端 `ctx.assembled`；但 `aiContextBlock()` 在 `ctx.assembled` 缺失时回退到旧拼装。旧拼装正是历史上“同一章喂入约 7.4 万字”的路径。
- 建议方案：明确旧兜底只用于“旧服务端/旧缓存”兼容，并在装配缺失时改为重新请求 `/ai_context` 或提示刷新，而不是用无预算拼装；如确认服务端已统一，可考虑删除该兜底。

### Q5（低）`computeFloor` 对 fixed 层被截断时的提示语开销未计入
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\ai\context\layers.mjs:211`
- 现状：`noticeTotal` 只对 flex 层累加；但 fixed 层同样可能被自身 `cap` 截断并追加截断提示语。该函数当前不参与运行，仅用于文档/工具口径。
- 建议方案：对可能截断的 fixed 层也计入 `noticeSampleLength()`，使“可执行下限”口径更准确；或明确注释“此函数不含 fixed 层截断提示语”。

---

## 三、健壮性与正确性问题

### R1（中）`getPath` 在 try/catch 之外，畸形 URL 会直接抛穿请求处理
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:158`、`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:4686`
- 现状：`http.createServer` 回调先执行 `const { pathname, query } = getPath(req)`，再进入 `try`。`new URL` 或 `decodeURIComponent(url.pathname)` 遇到非法百分号编码（如 `%E0%A4%A`）会抛 `URIError`，此时没有响应、也没有统一错误日志。
- 建议方案：把 `getPath` 的解析放进 try/catch，失败时直接 `sendError(res, 400, '非法请求路径')` 并返回；或让 `getPath` 内部捕获解码错误。

### R2（低）EPUB/ZIP 解压缺少解压后大小上限
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\zip-reader.mjs:58`
- 现状：导入入口限制了 base64 解码后 24MB，但 ZIP deflate 可高度压缩，恶意/损坏文件可能解压出超大内容，造成内存膨胀。
- 建议方案：解压前依据 `compSize` 与声明上限（如单条目 ≤ 32MB、总解压 ≤ 64MB）拒绝；或在 `inflateRawSync` 后检查 `data.length`。

### R3（低）静态文件路径校验使用字符串前缀判断
- 定位：`C:\Users\a1941\Desktop\DeepSeek\novel-studio\server.js:4594`
- 现状：`filePath.startsWith(publicDir)` 在 `path.join` 产生的带分隔符路径下当前可用，但字符串前缀判断不如路径关系判断稳健。
- 建议方案：改为 `path.relative(publicDir, filePath)` 后判断不是 `..` 开头且不是绝对路径。

---

## 四、性能/速度相关观察（后续步骤可评估）

- `buildNovelContext` 有缓存且语义召回有 30 秒微缓存，整体设计合理；`/api/ai_context` 会先调一次 `getSemanticRecall` 预热，再调 `buildNovelContext`，同键可命中，实际收益已覆盖。
- `ai/harness-pool.mjs` 热备池默认关闭（`NOVELSTUDIO_HARNESS_POOL=1` 才启用）。若当前瓶颈在每任务冷启动（源码路径实测 12.6s，预构建 1.9s），可在第 3 步评估默认启用或自动探测。
- `compressStoryMemory`/`agentMemoryGuardOf` 对章节全表做 `substr(content,1,1500)`，大作品下可评估按 `summary` 优先、正文仅取近章，进一步降低装配/压缩延迟。

---

## 五、兼容性与适配性观察（留待第 4 步深查）

- `harness-sdk-worker.mjs` 内复制了 `harness.js` 的 `resolveDshLaunch` 启动解析逻辑（注释已说明原因），存在两处漂移风险，需要保持测试对照。
- `ai/memory-compress-guard.mjs` 与 `novel-tools.mjs` 通过 `guard:'agent'` 字面量契约对齐，插件不能 import 内核模块，已有测试断言两侧一致；仍属于需重点保护的跨模块契约。
- `callAIStream` 仅对官方 DeepSeek 端点下发 `stream_options.include_usage` 与思考强度字段，对第三方 OpenAI 兼容端点不下发，策略正确；但自定义端点若返回 usage 不完整，追踪层已有 `usage_unavailable_reason` 兜底。

---

## 六、第 1 步声明

本步只完成审查、问题定位与解决方案建议，**未修改任何代码**。以上 Q1–Q5 中，Q1、Q2 与生成内容质量直接相关，建议在第 2 步优先处理；Q3 与 R1 次之。是否按此报告进入第 2 步，请确认。
