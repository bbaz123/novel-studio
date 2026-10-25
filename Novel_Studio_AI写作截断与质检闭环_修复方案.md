# Novel Studio AI 写作中途截断与质检失效——排障、修复及回归验收方案

> **文档用途**：直接交给本地开发 Agent/DSH，按阶段定位问题、修改源码、运行测试并提交可核验的完成报告。  
> **目标仓库**：[bbaz123/novel-studio](https://github.com/bbaz123/novel-studio)  
> **问题优先级**：P0（正文成文可靠性 / 章节蓝图达成 / 质量门禁真实性）  
> **创建日期**：2026-10-19  
> **重要边界**：这是一份待执行的修复方案，不代表已经在用户电脑上定位了全部根因、修改了源码或完成了联调。  
> **版本原则**：先检查用户本地真实运行的代码。公开仓库 README 当前标注实验通道 `v1.2.4`，但公开 `package.json` 页面仍标注 `1.2.3`；两者不能用来推断用户本机真实版本。**不得擅自 `git pull`、切换分支、升级、重置或覆盖用户修改。**

---

## 0. 一页摘要：这次到底坏在什么地方

### 0.1 本次现场症状

用户在 Novel Studio 中使用 **AI 写作**生成第一章《觉醒日，我获得了D级天赋》。正文正常展开大厅排队、两名 A 级觉醒、林清雪 S 级异象、轮到三号检测台等内容，却突然在下列位置终止：

> “A035——”没人应

用户得到的正文约 **1759 字**（此数字来自日志里的质检阶段，不一定等于用户手工数的字数）；章内尚未写到主人公岳宸炎的 D 级检测、检测员宣读、围观反应，更没有写出章节结尾的系统提示。**这是本章核心剧情缺失，不是正常的开放式结尾，也不应因为有文字可展示就被视为完整章节。**

### 0.2 三条关键日志（均为用户提供的真实日志）

按时间排列：

```text
2026-10-19 20:10:10 警告 frontend ai_write_stream_empty_retry
[AI] 成文流式直连返回空内容（思考可能吃光输出预算），
先保持原思考强度 + 更大上限到 16384 重试一次
```

```text
2026-10-19 20:12:05 警告 frontend quality_gate_unparsed
[写作] 质检返回无法解析为契约 JSON（785 字），本次视为未质检

context.chars = 785
context.head 以 {"verdict":"issues","issues":[... 开始，
指出“未完成 D 级觉醒、本章结尾钩子缺失”。
```

```text
2026-10-19 20:12:05 慢 frontend slow_api
API /ai/write 耗时 26868ms（阈值 10000ms）

2026-10-19 20:12:08 警告 frontend quality_gate_skipped
[写作] 长正文分段模块不可用（正文 1759 字）
```

### 0.3 对日志的正确解读

| 现象 | 已确认 / 待验证 | 说明 |
|---|---|---|
| 首次成文流式直连得到空内容 | **已确认** | 触发了现有空回复重试路径 |
| 重试时上限提高到 `16384` | **已确认** | 是本次重试的配置值，**不是**已经证明用了 16384 Token |
| 首轮可能“思考 Token 耗尽输出预算” | **待验证** | 源码和日志把它列为解释，但需要该次 `finish_reason`、usage 证明 |
| 后续成文只完成了本章前半段 | **从文本与蓝图确认** | 故事停在 A035，未写到主要 D 级情节与章末钩子 |
| 质检模型识别到缺失情节的线索 | **已确认** | `head` 片段已经指出 D 级结果和章末钩子缺失 |
| 质检 JSON（785 字）解析失败 | **已确认** | 当前无法判断是语法错误、截断、格式不合规还是修复重试失败 |
| `head` 日志看起来半句话结束 | **不能证明上游被截断** | `head` 是源码主动截取的前 200 字；必须查完整模型输出和解析错误 |
| “长正文分段模块不可用” | **当前公开源码存在误报可能，且路径明确** | UI 把多个 `skipped.reason` 错误映射为该文案，不代表分段引擎实际损坏 |
| `/ai/write` 用时 26.868 秒 | **已确认** | 只说明超过 10 秒**慢请求告警阈值**；不是超时/断流证据，也并非 `/ai/write_stream` 同一路径 |
| 本次最终为何停在 1759 字 | **尚未坐实根因** | 可能是 `finish_reason=length`、模型主动 stop、上游/客户端截断、解析/合并遗漏或多因素组合 |

**修复总目标：**
1. **真实识别**一次写作是否因输出限制或链路异常而停止；
2. **可靠判断**是否已经完成蓝图中所有必需情节点；
3. **可控恢复**缺失情节，保留已有高质量正文而不是机械凑字；
4. **质检失效时不得假通过**，并准确显示失败原因；
5. **最终是否写入正式章节，依然由作者批准**。

---

## 1. 已从公开代码确认的具体薄弱点

> **定位方法**：以下是对公开默认实验分支的检查结果。行号仅方便阅读；Agent 必须以本机当前工作树中的**函数名和实际调用路径**为准。

### F-01：上游流式 `finish_reason` 未进入最终 SSE 完成协议（P0）

**公开代码线索：**

- `server.js`：`callAIStream()`，当前主要解析 `delta.content`、`delta.reasoning_content`、`usage`，返回拼接文本。
- `server.js`：`handleAIWriteStream()`，向浏览器发送 `send({ done: true, text, scan, usage })`。
- `public/app.js`：`streamAIDirectWrite()`，收到 `evt.done` 就返回 `complete: true`。

当前公开实现可观察到：**“连接完整、服务端发出了 done”与“模型因 token 限制停笔”没有被有效区分**。需要将终止原因沿“供应商 SSE → `callAIStream` → 本地 SSE → 前端 → 管线结论”贯通。

证据入口：

- [server.js / callAIStream](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/server.js#L1194-L1320)
- [server.js / handleAIWriteStream](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/server.js#L1355-L1415)
- [public/app.js / streamAIDirectWrite](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L8241-L8403)

**注意**：4096 是底层默认值；本章成文调用本身显式计算 `max_tokens = min(16384, ceil(target × 2 + 2000))`，之后空输出时还会重试。不要把底层默认值错当成此次实际请求上限。

### F-02：质量 JSON 失败后被当作“没有 issues”的跳过结果（P0）

`verifyAIDraft()` 的公开代码：

- 先调用 `extractJSONFromText(reply)`；
- 如果无法解析，记录 `quality_gate_unparsed`；
- 再使用一次 `directAIWrite()` 做 JSON 修复；
- 修复仍失败则返回：

```js
{
  pass: false,
  verdict: 'unknown',
  skipped: true,
  reason: 'unparsed'
}
```

但管线真正进入自动修复的条件，是类似：

```js
if (!verdict.pass && (verdict.issues || []).length) {
  // 调用修复
}
```

于是“质检输出其实指出明显缺失，但因为不能被解析成契约对象”可能导致**没有可消费的 issues、没有可靠复修任务**。系统虽然给了警告，但不能当作自动解决完成。

证据入口：

- [public/app.js / verifyAIDraft](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L8475-L8549)
- [public/app.js / 质检后修复条件](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L15085-L15155)

### F-03：`unparsed` 被误报成“长正文分段模块不可用”（确定性缺陷，P0）

公开 `public/app.js` 当前逻辑，近似：

```js
const why = verdict.reason === 'over_single_request_limit'
  ? '本章正文超过单请求质检上限（未分段质检）'
  : '长正文分段模块不可用';
```

这意味着 `reason='unparsed'`、`reason='channel_unavailable'` 等理由都错误显示为“长正文分段模块不可用”。**本次 1759 字的报错有明确的错误映射路径**，必须先修它，不能据此贸然重构分段引擎。

证据入口：
[public/app.js / quality_gate_skipped 映射](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L15108-L15119)

### F-04：篇幅诊断依赖已解析的 `issues`，质检失败时可能误分到“短但完整”（P0）

当前 `classifyChapterLength()` 基本规则：

- 不设目标或字数达标：`ok`；
- 字数不足且已解析的 issues 含“遗漏、未写、缺失……”：`missing_content`；
- 其他字数不足情况：`short_but_complete`。

如果本次质检为 `unparsed/unknown/skipped`，即使实际正文缺失情节，函数也可能因 `issues` 为空而将其视作 `short_but_complete`。

**改造原则：字数是否达标与蓝图情节是否完成是两件事。**

证据入口：
[public/app.js / classifyChapterLength](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L10554-L10573)

### F-05：程序已经禁止了“为凑字数无条件章尾续写”，这一点应当保留（P0 设计边界）

公开源码明确注释：旧版因未达目标字数而机械在末尾追加，容易破坏章节结尾、增加 AI 腔，所以新流程将篇幅仅作为诊断，**不再按字数自动补字**。

本方案不要求回退到旧版机械追加。应新增的是：**当章节确实遗漏了冻结蓝图中的必需情节时，在作者本次授权预算内做定向续写/局部补齐。**

证据入口：
[public/app.js / 取消机械补字及结果交付](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L15179-L15220)

### F-06：流式重试已有保护机制，修复时必须复用，不能重复造轮子（P0）

`streamAIDirectWrite()` 已具备：

- SSE 渐进显示；
- 思考状态提示；
- 首轮空内容 → 保留思考强度、扩大输出预算重试；
- 仍空 → 降低思考强度再试一次；
- 无 `done` 的半截流抛错；
- 中断正文附在 `partialText` 上，供候选草稿恢复。

这套机制必须保留，只做**结束原因补齐、状态传递、必要续写**。不得废除既有停止按钮、恢复草稿、失败回退、并发锁及计费记录。

证据入口：
[public/app.js / 流式空回复重试与半截保留](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js#L8363-L8437)

---

## 2. 实施前的现场保护与最小定位

### 2.1 本地环境检查（Agent 必须实际执行）

在**用户当前运行 Novel Studio 的项目目录**执行：

```bash
node --version
node -p "require('./package.json').version"
git branch --show-current
git rev-parse HEAD
git status --short
git log -1 --format="%h %ci %s"
```

随后：

1. 核实启动路径和浏览器实际连接的 Node 服务实例，确认运行 JS 就是将要修改的 JS，排查多个进程、老服务、浏览器缓存。
2. 读取仓库内 `AGENTS.md` 和现有 `ai/writing/policy.mjs`，遵循它们对于 ESM、零 npm 依赖、测试/文档同步和数据隔离的约束。
3. 保存工作树及用户尚未提交的更改。**不强制 reset、checkout、pull、rebase。**
4. 备份用户章节、版本、SQLite 数据；在独立工作树/隔离数据目录与测试端口排障，不能直接用真实写作库进行破坏性试验。
5. 优先复用**已有诊断日志/运行追踪**，查看本次 `run_id`、API 完成状态、模型名、有效 `max_tokens`、`usage`。不要为调查而重复发起收费请求。
6. 如果日志没有完整 `finish_reason`，先写受控的 SSE 假上游离线测试，验证改造后能够采集，再征得授权进行真实模型单次联调。

可用的静态定位命令：

```bash
git grep -n -E "callAIStream|handleAIWriteStream|streamAIDirectWrite"
git grep -n -E "verifyAIDraft|quality_gate_unparsed|quality_gate_skipped"
git grep -n -E "classifyChapterLength|performToolbarAIWrite|showAIWritingResult"
git grep -n -E "extractJSONFromText|longTextPlanFor|ai_write_stream_empty_retry"
```

定位时按函数名，不应依据本文所列 GitHub 行号直接自动打补丁。

### 2.2 三个必须得到的真实答案

- **Q1：为什么成文停在 A035？** 是上游 `finish_reason=length` / `stop` / `content_filter` / `unknown`，还是没有收到可靠终止信号、客户端中断、候选正文解析丢尾？
- **Q2：为什么质检 785 字解析失败？** 是 JSON 真正不合法、字段缺失、模型输出截断、修复重试失败，还是解析器本身不兼容合法 JSON？
- **Q3：为什么后面没有补齐 D 级情节？** 是 `issues` 为空导致未触发修复、`unknown` 被当作完成、篇幅误判、作者授权边界、预算阻止，还是其他真实分支？

**只有 Q1–Q3 的证据链能落到具体函数/判断/测试时，才可以在最终报告中将根因标注为“已证实”。**

---

## 3. P0 修复 A：贯通真实模型结束原因

### 3.1 目标协议

统一“**服务端是否结束传输**”和“**模型是否完成正文**”的概念。建议将信息沿整个链路传递：

```json
{
  "done": true,
  "text": "...",
  "scan": null,
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 5678,
    "completion_tokens_details": {"reasoning_tokens": 3000}
  },
  "finish_reason": "length",
  "finish_reason_observed": true,
  "requested_max_tokens": 8192,
  "stream_terminated_normally": true,
  "generation_status": "OUTPUT_LIMIT_REACHED"
}
```

> 这是**目标接口示例**，不是声称当前服务端已经返回该 JSON。数字为占位演示，不代表此次调用的实际 Token 用量。

### 3.2 推荐改法

1. `callAIStream()` 解析上游 SSE 时，在实际 `choices[0].finish_reason` 非空时记录原值。多个 chunk 或第三方兼容端点缺失时，记录 `null` / `not_observed`，不能自己推断成 `stop`。
2. 保留现有 `onUsage`、思考心跳和返回字符串的兼容性；如需扩展，优先新增 `onFinish` 回调/元数据，而不是直接破坏依赖 `callAIStream(): string` 的其他调用方。
3. `handleAIWriteStream()` 在 `done` 中附加 `finish_reason`、请求上限和可用的 `usage`，不传输推理正文、API Key 或敏感请求全文。
4. `streamAIDirectWrite()` 在收到 `done` 时保留新增元数据并传到 `performToolbarAIWrite()`；当前前端的 `complete:true` **只代表本地完成事件已收到**，不得代表蓝图已完成。
5. `finish_reason='length'` → **候选稿不完整/需要续写**；模型明确 `stop` → **仅说明生成正常结束，仍需检查蓝图完成度**。
6. `content_filter` 或供应商安全终止 → **遵守供应商约束，显示正确终止原因，不尝试绕过**；其他未知值 → `UNKNOWN_TERMINATION`。
7. 没有可靠 finish 事件 / SSE 中断 / 请求取消 → **保留已有部分文字，但不把它作为已完成稿**。
8. 一次空输出重试必须是**独立 attempt 记录**，分别记录 requested max、usage、finish reason、文本长度、耗时。不要用第二次的状态覆盖第一次造成无法排查。

### 3.3 最小状态模型（建议）

| 状态码 | 含义 | 处理 |
|---|---|---|
| `PROVIDER_STOP` | 上游明确正常停止 | 进入蓝图覆盖检查 |
| `OUTPUT_LIMIT_REACHED` | 明确达到输出上限 | 保留候选稿，安排受控续写 |
| `EMPTY_OUTPUT` | 此次尝试无正文 | 沿现有有界重试逻辑 |
| `STREAM_INTERRUPTED` | 本地没有可靠完成信号 | 保留部分稿、可恢复，不可标完成 |
| `USER_CANCELLED` | 作者主动停止 | 绝不自动继续；保留部分稿 |
| `PROVIDER_BLOCKED` | 供应商拒绝或过滤 | 如实解释，不做规避 |
| `UNKNOWN_TERMINATION` | 上游没有提供可靠结束原因 | 允许查看草稿，但**不能仅凭 done 自证章节完成** |

备注：第三方 OpenAI 兼容接口未必给出 usage/finish_reason，缺字段应保留 `null/unknown`，不能伪造为 0 或 `stop`。

---

## 4. P0 修复 B：蓝图情节完成度的独立门禁

### 4.1 不再把“够字数”或“模型停止”当作“章节完成”

建立**蓝图必需情节点账本**：

```json
{
  "chapter_id": "example",
  "blueprint_revision": "frozen-author-approved-version",
  "required_beats": [
    {"id": "B01", "description": "岳宸炎正式上台检测", "required": true},
    {"id": "B02", "description": "检测石呈暗黄色，确认D级结果", "required": true},
    {"id": "B03", "description": "检测屏/检测员正式公布D级与评价", "required": true},
    {"id": "B04", "description": "排队人群的惋惜和安慰反应", "required": true},
    {"id": "B05", "description": "检测中心门口台阶上的系统声音钩子", "required": true}
  ]
}
```

这是根据**用户本章质检日志**提炼的回归测试夹具，不是要求为所有小说硬编码“D级”或指定角色名字。

实现要求：

- 通用代码从**作者确认后的章节蓝图**提取/维护必需情节点；固定本章样本只用于自动测试。
- `required_beats` 与原蓝图版本一起冻结。区分必须发生和可选择性表现细节，避免过度约束写作。
- 使用现有结构化质检提取“已满足 / 不满足 / 无法判定”证据，不能仅依赖关键字扫描，也不能相信生成模型自称“写完了”。
- 可用确定性断言覆盖日期、指定关键原词等有限事实，但“情节是否实质出现”需要具有正文证据的语义判断。
- 伏笔、开放结局和作者允许的留白不能被当成缺失问题；**只有蓝图明确要求本章兑现的情节**才是硬门禁。
- 如果原蓝图未知、作者修改了蓝图，或证据不足，返回 `UNVERIFIED`，不要自行发明蓝图。

### 4.2 将两个维度彻底分开

建议维护：

```json
{
  "length_status": "BELOW_TARGET",
  "blueprint_status": "MISSING_REQUIRED_BEATS",
  "verification_status": "VERIFIED_ISSUES",
  "unresolved_beat_ids": ["B02", "B03", "B04", "B05"],
  "ready_for_normal_delivery": false
}
```

规则：

1. **字数达到目标，但缺少必需情节** → 仍需修复。
2. **字数低于目标，但蓝图完整、结构自然** → 可以保留短章，不强制补字。
3. **质检失败 / JSON 无法解析 / 通道不可用** → `UNVERIFIED`；不能判为“短但完整”，也不能判为“已全部通过”。
4. **用户中途停止** → 明确保留为部分草稿；不触发收费自动续写。
5. 不应使用硬编码正则“没有看到 D级 字样”直接把章节判失败；验证必须依据该书蓝图及正文具体证据。
6. 即使 `length_status='ok'`，也不能跳过蓝图覆盖判断。

建议修改现有 `classifyChapterLength()` 的返回契约或新增相邻的 `classifyChapterCompleteness()`，优先复用原有字段并保留旧调用方兼容。

---

## 5. P0 修复 C：质检 JSON 的真实校验与原因映射

### 5.1 首先修复“伪分段模块故障”的错误提示

**禁止**将所有 `skipped` 原因默认归到“长正文分段模块不可用”。

推荐状态映射：

| `reason` | 面向作者的真实提示 | 后续动作 |
|---|---|---|
| `unparsed` | 质检返回格式无效，未得到可靠结论 | 有界格式修复/重新质检 |
| `channel_unavailable` | 质检通道暂时不可用 | 保留候选、允许稍后手动复验 |
| `long_text_engine_unavailable` | 长正文质检模块不可用 | 检查实际模块装载，允许只读提示 |
| `over_single_request_limit` | 正文超过单请求质检上限 | 使用合规分段质检或保留待验收 |
| `cancelled` | 质检已被用户取消 | 保留候选，不自动继续 |
| 其他/未知 | 本次质检未完成（记录原始原因码） | 不冒充 `pass` |

要求：日志中同时记录 `reason_code`，前端展示不能与程序状态不一致。

### 5.2 结构化结果契约

当前质检提示已有以下字段：`verdict`、`issues`、`deferred`、`coverage`。修复要遵循当前真实接口而不是改成新的不兼容 JSON。

推荐语义：

```json
{
  "verdict": "issues",
  "issues": [
    "章内必需的D级觉醒结果尚未发生",
    "章末系统声音钩子缺失"
  ],
  "deferred": [],
  "coverage": {
    "story_state": true,
    "space": true,
    "timeline": true,
    "world_rules": true,
    "chapter_boundary": true,
    "style_structure": true
  }
}
```

**关键要求**：

- `issues` 对应可核对的证据，不把 `deferred` 里的真实伏笔自动转为硬伤。
- `coverage` 是检查覆盖声明，不是质量通过证明；明确有未检查维度时不得把 `pass` 判为可信通过。
- **修复器输出缺少必要覆盖字段时不能直接判为已验证通过**；如果允许某些历史格式，需写出兼容边界和测试。
- `verdict=pass` 必须通过结构校验且所有必需维度有真实覆盖证据；`verdict=issues` 必须有非空、可追踪问题；其他情况归 `unknown/unverified`。
- 解析器可安全去除 Markdown 代码围栏、前后空白等；**不能**自动把被截断的 JSON 伪造为完整 `pass`。
- 记录**完整响应的长度、失败类别、尝试次数、Token 用量及响应哈希**；在作者明确允许的诊断模式下才保存私密全文。
- 已有一次 JSON 修复重试要保留，但检查其 `maxTokens: 512` 是否在真实接口上足以输出所需契约；不能只加大上限而不修结构与状态处理。

### 5.3 质检与修复闭环

推荐顺序：

`原稿候选 → 蓝图缺口识别 → 质检 JSON 解析与契约校验 → issues/unknown 分流 → 必要补救 → 重新检查最终候选稿 → 作者审批`

- 能验证问题确实存在时，才可以生成**对应问题**的局部补救任务。
- `UNVERIFIED` 不应被转成空 `issues` 再进入“没有问题”的正常分支。
- 不能仅凭损坏 JSON 中几个片段就**跳过独立验收**直接改写全章。
- 既有修稿链路是否复用，要取决于实际输入/输出契约；不允许在写作链路中绕开已有授权门禁。

---

## 6. P0 修复 D：仅在必要时执行定向续写（不机械补字）

### 6.1 触发条件

允许进入续写的情况：

- 上游终止原因明确为 `length`，且正文尚有必要蓝图情节未完成；
- 上游 `stop`，但经过可靠蓝图核对发现必需情节点缺失；
- SSE 中断后恢复了可用部分草稿，且作者选择继续；
- 质检明确指出缺失内容且本次写作已授权相应自动修复费用。

不得进入自动续写的情况：

- 作者点击取消/停止；
- 已完成蓝图，只是字数略少；
- 无法确认是否缺失且用户未授权继续收费；
- 触及额外费用上限、敏感权限或安全门禁；
- 作者已经在原章上另行编辑，造成候选版本不一致。

### 6.2 定向续写算法

1. 冻结**已生成部分正文**、章节蓝图、角色/世界设定、已完成的情节点与缺失情节点。
2. 续写提示只提供必要上下文：原正文摘要、**末尾足够长度的原文衔接片段**、尚未完成的 required beats、风格与剧透边界。
3. 指示模型**从断点自然续写**，不要重讲已写出的 A/S 级事件，不要提前写入未来章，尽可能保持第三人称有限视角和原有人物状态。
4. 若最后停在半句或残缺对白，如 `“A035——”没人应`，允许在**候选稿的末尾极小范围**做重叠/衔接修正；其他正文不可悄悄改写。
5. 使用可确定性验证的**边界去重**（前后公共前缀/后缀、段落指纹等）；不要盲目字符串拼接产生重复句/重复事件。
6. 所有修改都先进入**候选稿**，生成差异和版本 hash，不直接覆盖原正式章节。
7. 对**完整候选稿重新运行蓝图验收和必要质检**，不能只验新增段落。
8. 只进行有限次续写/复检：推荐将**最多追加 1 次自动续写 + 1 次明确授权的修复**设为第一版可配置默认值；实际轮次、单次成本和累计预算以当前项目已有授权/预算合同为准。
9. 仍无法完成时**保留当前候选稿**，显示 `PARTIAL` / `UNVERIFIED` / `BLOCKED` 和下一步选项；绝不无限循环或无限消费。
10. 无论通过与否，正式章节写入需要作者明确确认；用户可以保留、导出、放弃或继续修改未完成候选。

### 6.3 续写合格标准（当前第一章夹具）

对于此次章节，最终续写至少要让下列**蓝图实质**在正文中落地（措辞可以自然变化，不能硬编码所有小说都照此写）：

| Beat | 需要在正文里真正发生的情节 |
|---|---|
| B01 | 从 A035 顺利过渡到岳宸炎 A037 上台 |
| B02 | 他亲手按在检测石上，显示 **D 级 / 暗黄色**（以作者实际确认设定为准） |
| B03 | 屏幕和/或检测员公开给出 **D 级、无战斗能力** 等核心评价 |
| B04 | 场内同学或排队者出现合理的惋惜、安慰与社会对 D 级的反应 |
| B05 | 岳宸炎在检测中心门口台阶上听见**无来源的系统提示音**，形成原计划章末钩子 |

反例：模型只补到 A036、填够了目标字数，却没有 B02～B05；不得通过。

### 6.4 建议的主流程伪代码（设计参考，不是现有 API）

```js
async function produceVerifiedChapter(input) {
  const run = snapshotAuthorizedWritingRun(input); // 冻结作者蓝图、预算、原稿版本
  let candidate = await generateInitialCandidate(run);

  const finish = normalizeProviderFinish(candidate.meta);
  const initialCheck = await checkBlueprintWithinBudget(run, candidate);

  // 结束原因不能取代蓝图判断
  let status = classifyDraft({
    finish, check: initialCheck, targetWords: run.targetWords
  });

  // 授权范围内、有限次数、按真实缺失情节补齐
  for (let i = 0; i < run.maxAutoContinuations && needsContinuation(status); i++) {
    if (!run.canSpendAnotherCall()) break;
    const continuation = await writeMissingBeats(run, candidate, status.unresolvedBeats);
    candidate = mergeWithBoundaryChecks(candidate, continuation, run);
    const recheck = await checkBlueprintWithinBudget(run, candidate);
    status = classifyDraft({
      finish: normalizeProviderFinish(continuation.meta),
      check: recheck,
      targetWords: run.targetWords
    });
  }

  // 对所有结论如实统计：正常结束、缺情节、未知、被取消、预算阻塞
  await saveRecoverableCandidate(run, candidate, status);
  return {
    candidateText: candidate.text,
    status,
    requiresAuthorApprovalToCommit: true
  };
}
```

不可因为有 `for` 循环就让它直接在无人授权的情况下持续收费。`maxAutoContinuations` 必须有限，停止条件和费用上限都要有离线测试。

---

## 7. P1：日志、前端结果和性能诊断

### 7.1 建议的每次尝试诊断字段

```json
{
  "run_id": "local-write-run-uuid",
  "attempt": 2,
  "stage": "prose",
  "channel": "direct_sse",
  "requested_max_tokens": 16384,
  "finish_reason": "length",
  "finish_reason_observed": true,
  "completion_tokens": null,
  "reasoning_tokens": null,
  "response_chars": 1759,
  "provider_stream_closed": true,
  "sse_done_received": true,
  "quality_reason": "unparsed",
  "blueprint_status": "MISSING_REQUIRED_BEATS",
  "candidate_committed": false
}
```

**上面是目标诊断字段，除了用户日志中出现的 `16384`、`1759` 和 `unparsed` 等值以外，其他值都只是示意，不代表此次实际调用结果。**

- 缺失的 usage / finish 信息记 `null`，不可填 0 或编造 `stop`。
- 日志只存 ID、调用耗时、Token 数、reason_code、长度、hash，默认不存整篇作者正文、密钥或推理内容。
- `run_id` 串起首轮、重试、质检、质检修复、续写及最终交付。
- 不能把“质检超时”和“写作成文结束”混成一条告警。

### 7.2 `/ai/write` 慢请求的正确排障方式

本次 `slow_api: /ai/write 26868ms` 只是性能告警，不应先入为主认定“超过 10 秒导致 AI 截断”。

需要检查：

1. 这是首轮正文、JSON 修复重试还是独立质检的哪一次调用；
2. 实际服务端超时阈值、AbortController、代理超时、供应商耗时；
3. 是否存在客户端已经进入下一阶段但前一调用仍在等待的竞态；
4. UI 是否保留正在处理的进度卡，是否允许重复点击造成并发请求；
5. `request_id` 是否与此次 quality_gate_unparsed 同属一个 `run_id`。

本次事件的**正确优先级**是先修可靠性，再分析慢调用是否独立需要优化。不得简单把 `10000ms` 提高到 `30000ms` 作为“已修复正文截断”的证据。

### 7.3 UI 必须诚实呈现四类状态

| UI 状态 | 何时显示 | 可以做什么 |
|---|---|---|
| `已完成且通过验收` | 上游结束明确，蓝图验收可信通过 | 预览差异，等待作者应用 |
| `正文未完成，已保留草稿` | 确认有缺失情节点 / 输出上限截断 | 查看缺失清单，受控续写 |
| `质检未完成，结果待核实` | JSON 失败、通道不可用、覆盖未知 | 查看草稿，重跑质检或人工审阅 |
| `已停止/需要人工处理` | 取消、预算耗尽、权限/版本冲突 | 恢复、导出、稍后继续或放弃 |

不要将 `UNKNOWN`、`SKIPPED`、`PARTIAL` 显示成绿色已完成，也不要因为候选稿可查看而暗示它已保存进正式章节。

---

## 8. 回归测试矩阵（必须真正跑，禁止只写测试方案）

尽量先用假上游 SSE 和固定质检 Fixture 离线测试，不调用真实付费模型。测试按**本机真实契约**编写。

| ID | 场景 | 必须满足 |
|---|---|---|
| T01 | 上游发送正文 + `finish_reason=stop` | 前端能读到 `stop`，随后仍做蓝图检查 |
| T02 | 上游发送正文 + `finish_reason=length` | 不标完整章节，保留候选并给续写路径 |
| T03 | 上游无 `finish_reason` 但 SSE 有本地 `done` | `finish_reason=unknown/null`，不能伪造 `stop` |
| T04 | SSE 中途断开，没有 `done` | 保留已有正文；不直接作为成品 |
| T05 | 用户按“停止” | 不自动续写，保存可恢复部分稿 |
| T06 | 首次成文全空，扩大上限到 16384 后成功 | 两次 attempt 分别记录，最终进入正常质量检查 |
| T07 | 两次空输出再降思考预算兜底 | 保留原有有限重试纪律，不无限回环 |
| T08 | 只收到 reasoning token 没有正文 | 不当作有效正文；记录空回复与 usage（如可得） |
| T09 | `usage` 缺失 | 不伪造 Token 为 0，标记未知 |
| T10 | 上游限制 `max_tokens` 与用户预期不同 | 诊断记录发送值与有效上限 |
| T11 | 质检返回合法完整 JSON，全部 coverage 有效 | 按语义与证据得出 pass/issues/unknown |
| T12 | 质检回复有 Markdown JSON 代码围栏 | 安全解析为正确结构，不新增事实 |
| T13 | 质检返回截断 JSON | `unparsed` 或已授权的有界格式修复；永不假 PASS |
| T14 | JSON 修复器输出只含 verdict、缺 coverage | 不可凭不完整的 `pass` 宣称全范围验收 |
| T15 | 修复器仍失败 | 显示“质检结果格式无效”，不报“分段模块故障” |
| T16 | 真正长文模块不可用 | 精确显示 `long_text_engine_unavailable` |
| T17 | 超过单请求质检上限 | 精确显示 `over_single_request_limit` |
| T18 | 质检通道无响应 | 显示 `channel_unavailable` / unknown，不假通过 |
| T19 | 1759 字、停在 A035，缺主角觉醒情节 | 必须识别缺失 B02–B05，不能 `short_but_complete` |
| T20 | 3000 字达到目标但未写 D 级 | 蓝图门禁仍不能 PASS |
| T21 | 1600 字但所有必需情节自然完整 | 允许短稿，不强制补字 |
| T22 | 质检 unknown + 低于目标字数 | 长度诊断不能单凭空 issues 推断完整 |
| T23 | 合格定向续写 | 不重复前文的 A 级/S 级事件，不遗漏原蓝图 |
| T24 | 续写从半句/半对白开始 | 末尾衔接自然、去重、原稿未被整章改写 |
| T25 | 续写引入新冲突或提前泄露未来章 | 全文复验失败，不能自动交付“全部通过” |
| T26 | 续写次数达到上限 | 停止收费、保留部分稿、原因可追踪 |
| T27 | 费用预算用尽或用户未授权 | 不继续收费调用，其他离线检查可做 |
| T28 | 作者已编辑原章节，候选稿基准变化 | 不覆盖作者改动，提示版本冲突 |
| T29 | 候选稿已经通过但用户未点击应用 | 正式章节数据完全不变 |
| T30 | direct 与 harness 两种成文路线 | 都能产出统一完成度状态；不得仅 direct 使用门禁 |
| T31 | `slow_api` 10 秒告警 | 只是性能告警，不被误归为流中断 |
| T32 | 重复点击/取消/切换章节 | 不重复请求、不混淆 chapter ID、不丢恢复草稿 |
| T33 | 源码改动后既有修稿、审稿、时态状态逻辑 | 回归无新失败 |
| T34 | 日志脱敏 | API Key、原始推理内容和完整正文不进入默认日志 |
| T35 | 本章第一章专属 Fixture | B01–B05 全部成立后才验收完成 |

### 8.1 项目原有测试命令

按项目本地 `AGENTS.md` 提示及实际脚本存在情况执行：

```bash
node scripts/ci-offline-checks.mjs
node scripts/test-narrative-repair.mjs
node frontend-test.mjs
node .p1-baseline/verify-phase-map.mjs
node .p1-baseline/check-utf8.mjs
```

若真实目录/脚本有变动，先核查 `package.json` 与 `AGENTS.md`，不要假装已经运行成功。

### 8.2 必须新建的测试夹具

- `write-stream-stop.fixture`：正常 `stop` 结束；
- `write-stream-length.fixture`：携带正文但 `finish_reason=length`；
- `write-stream-empty-retry.fixture`：首次仅 reasoning、正文为空，第二次成功；
- `quality-json-invalid.fixture`：类似此次日志，质检指出缺失但 JSON 不完整；
- `quality-json-valid-issues.fixture`：完整结构化缺口列表；
- `chapter-1-A035-incomplete.fixture`：本章原停笔处的截断文本与必需情节点；
- `chapter-1-complete.fixture`：覆盖 B01–B05 的已完成示例；
- `continuation-duplicate.fixture`：续写重复前文，验证去重/事件连续性。

文件名称为建议；可按本机已有测试目录布局调整。Fixture 应做脱敏与作者内容权限保护。

---

## 9. 开发阶段、优先级、退出门槛

| 阶段 | 优先级 | 具体工作 | 产出与验收 |
|---|---|---|---|
| S0 | P0 | 核对本地代码、服务进程、日志、蓝图，备份与隔离测试 | 可复现、可回滚、无数据风险 |
| S1 | P0 | 提取首轮空回复和重试的真实终止原因与 usage，识别 Q1–Q3 | `root-cause.md`，含证据与未知项 |
| S2 | P0 | 修复 `callAIStream → done → streamAIDirectWrite` 结束原因传递 | T01–T10 通过 |
| S3 | P0 | 修复质检 JSON 状态与 `quality_gate_skipped` 原因误映射 | T11–T18 通过 |
| S4 | P0 | 引入蓝图必需情节点的完成状态，独立于篇幅 | T19–T22 通过 |
| S5 | P0 | 有界定向续写、边界拼接、候选版本和全文复验 | T23–T29 通过 |
| S6 | P1 | 两路统一结束状态、UI、指标与慢请求追踪 | T30–T34 通过 |
| S7 | P0 | 运行第一章 A035 专属回归及全部旧测试 | T35 + 所有既有 P0 门禁通过 |
| S8 | P1 | 隔离环境联调；经授权后最多进行预算内必要真实模型调用 | 有真实调用证据、无越权扣费 |
| S9 | P0 | 恢复与回滚演练，报告代码改动、失败项、风险 | 最终报告如实完成 |

**各阶段不得因存在未解决 P0 问题而伪称“全部完成”。** 修复阻塞时先继续其他互不依赖、无需收费的任务。

---

## 10. 安全、预算及兼容性不可放松的条件

1. **本地优先**：不上传作者数据库、API Key、私人正文到额外远端诊断服务；测试在隔离数据目录运行。
2. **最小必要修改**：先修具体链路，禁止为了本问题大面积重构 DSH 内核、写作 UI 或数据库。
3. **零 npm 依赖 / ESM**：遵守项目 `AGENTS.md`，默认不新增依赖，不引入 CommonJS。
4. **保留历史能力**：停止/取消、空回复重试、部分草稿恢复、并发互斥、红线扫描、审稿与修稿、安全版本保护均不能退化。
5. **失败关口不能绕过**：`unparsed`、`unknown`、`skipped`、输出上限达到都不是通过。
6. **成本受控**：任何真实模型补调/续写/复检必须经过当前产品已存在的费用与作者授权机制。不得把“再次调用模型”悄悄变成永久免费或无限重试的承诺；费用不可确知时停止新收费步骤。
7. **作者最终决定**：正常已完成稿、部分稿、截断恢复稿都不自动覆盖正式章节；原稿和版本历史须保留。
8. **一致性与故事质量**：补齐情节时尊重本章蓝图、第三人称视角、角色卡、世界设定、未来章边界。不能只为了达到字数强行追加废话。
9. **已通过的测试不能弱化**：不得删测试、改快照、降低质量判据来制造“全绿”。
10. **版本真实**：README/`package.json` 标记冲突时记录差异，以用户实际运行目录和提交 hash 为准，不得擅自升级。

---

## 11. 最终报告模板：Agent 必须填写真实结果

```markdown
# AI 写作截断与质检闭环：实际实施报告

## A. 本地基线
- 本地分支 / commit / package version：
- Node / OS / 真正服务进程：
- 是否存在未提交改动、如何保护：
- 数据备份与恢复验证证据：

## B. 三条日志的实际根因
- 首轮空回复：finish_reason / usage / max_tokens / 是否得到有效正文：
- 提高到 16384 后：finish_reason / usage / 正文结束原因：
- 质检 785 字无法解析的具体原因与解析器栈：
- 是否真有分段引擎错误，还是 reason 映射误报：
- `/ai/write` 26868ms 对应哪个实际阶段：

## C. 代码改动表
| 文件 | 函数 / 模块 | 修改摘要 | 对应测试与实际结果 |
|---|---|---|---|

## D. 关键用例实际测试
| 用例 | 预期 | 实测（PASS/FAIL/SKIPPED） | 证据路径 |
|---|---|---|---|
| T01 ... T35 | ... | ... | ... |

## E. 第一章实际结果
- 原文截断点：
- B01 / B02 / B03 / B04 / B05：
- 首稿/补写后字数：
- 模型是否再次遇到输出上限：
- 整章质检的有效 JSON / 判定结果：
- 正式章节是否仍等待作者确认：

## F. 费用与风险
- 模型调用次数、用量、真实费用/无法获知项：
- 是否触达预算上限：
- 未解决阻塞 / 剩余风险：
- 备份/回滚方式：

## G. 最终结论
- [ ] 全部 P0 必需任务已完成并验证
- [ ] 部分完成（列出未通过项）
- [ ] 存在必须由用户处理的阻塞（列出最少必要问题）
```

---

## 12. 直接交给 Agent 的执行指令

**把以下整段发给本地 Agent，或直接让 Agent 阅读本文件并执行：**

> 请在我本地运行的 `bbaz123/novel-studio` 项目中，按照《Novel Studio AI 写作中途截断与质检失效——排障、修复及回归验收方案》执行实际开发。
>
> **先检查**当前工作树、Node、运行进程、已确认蓝图、API 运行日志及源码调用路径，保存未提交改动并备份隔离数据。不得擅自拉取远程分支、升级、重置或覆盖正式正文。
>
> **目标故障**：第一章《觉醒日，我获得了D级天赋》成文停在 `“A035——”没人应`，正文 1759 字。日志表明 20:10:10 首轮流式输出空并提高到 16384 重试；20:12:05 质检 785 字无法解析契约 JSON；20:12:08 质检跳过被报告为分段模块不可用，另有 `/ai/write` 26.868 秒慢请求告警。
>
> **优先修改**：
> 1. 贯通供应商 SSE 真实 `finish_reason`、输出上限、usage 和流式终止信号，不把 `done` 当成模型写完整章；
> 2. 修复 `verifyAIDraft()` 对 `unparsed/unknown/skipped` 的处理及质检 JSON 契约，并纠正 `quality_gate_skipped` 的错误原因映射；
> 3. 将“蓝图必需情节点是否写完”与“字数是否达标”解耦；质检不可信时不得显示 `short_but_complete`；
> 4. 在现有用户授权、费用及安全门禁范围内增加**有限的定向续写**，从未完成断点自然接续，去重、保存候选稿、全文复验；绝不恢复机械凑字、无限重试或未经作者批准写入正式章节；
> 5. 保持直连与 DSH 内核路径的最终验收口径一致，不改动不相关模块。
>
> **必须完成**：建立复现 Fixture、执行 T01～T35，运行现有离线检查、前端测试和项目门禁；需要真实模型付费的联调，只在我已授权预算内执行。每个测试记录实际退出码及证据。按阶段持续推进所有能做的事项，确需用户本人授权时只挂起相关部分。最后统一提交：已证实根因、完整改动文件清单、逐项测试结果、本章情节覆盖验证、费用、遗留风险和回滚方法。不得把计划、提交命令或部分执行误报为全部完成。

---

## 13. 源码与项目规范参考（Agent 自行以本机 HEAD 复核）

- [Novel Studio 仓库首页](https://github.com/bbaz123/novel-studio)
- [项目级 AGENTS.md](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/AGENTS.md)
- [server.js：AI 流式上游与本地 SSE](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/server.js)
- [public/app.js：成文、质检、篇幅判断](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/public/app.js)
- [package.json](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/package.json)
- [README](https://github.com/bbaz123/novel-studio/blob/Experimental-Version-v1.0/README.md)

> **关键结论**：本次不能只靠增大 `max_tokens` 修好。需要同时解决 **结束原因不透明、质检 JSON 失败、质量门禁错误报因、蓝图缺失不拦截、缺失情节无有界恢复** 五个问题。只要仍有本章必需情节未写、质检未验证或发生关键链路异常，系统就应保留草稿并如实提示，而不是宣称成文完成。
