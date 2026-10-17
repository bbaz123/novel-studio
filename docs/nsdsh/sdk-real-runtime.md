# R01：真实 DSH SDK 子进程、真协议与 broker 接线

> **阶段**：R01（《S18 后遗留问题分析与可执行收尾方案》§3，**P0 真实集成缺口**）
> **状态**：`PASS`（Windows x64 受信环境实测）
> **基线锚点**：产品 HEAD 见 `post-s18-evidence-baseline.md`；DSH 基线 `dsh-v0.1.7-rc.1` / vendor `7e06df2`
> **零计费**：本阶段全部使用**本机假模型端点**（`127.0.0.1` 的 Messages/SSE 服务），无真实 API key、无真实请求
> **原始日志**：`.nsdsh/r00/`（基线）与本文件表格中的观测值

---

## 0. 一句话结论

S13 交付的是**生命周期框架**，不是可运行的集成：它写的启动命令 `dsh-sdk --stdio` **在上游不存在**，
而且发完 `initialize` + `session/prompt` 就返回 "started"，**从不等待响应、也没有终态**。
R01 把它补成真实闭环，并在 Windows 上以真实子进程跑通 **12/12** 场景。

---

## 1. 先核对上游事实（不猜）

方案 §1.3 要求"不能仅因命令出现在本地代码里就视为锁定上游"。核对结果：

| 事实 | 出处（基线 `7e06df2`） | 结论 |
|---|---|---|
| 真实启动方式 | `packages/sdk/client/src/launch.ts` 的 `resolveDshLaunch()`：`process.execPath` + `[<dsh bin>]` + `['--profile', profile, ...patches]` | **入口是 CLI 构建产物，profile 才是 SDK 开关** |
| `dsh-sdk` 可执行文件 | 全仓无此 bin | 本地原来的 `cmd: 'dsh-sdk'` 是**编出来的** |
| `--stdio` 开关 | `apps/cli/src/args.ts` 无此参数 | 同上 |
| 协议面 | `packages/sdk/protocol/src/types.ts` 的 `HarnessSdkRequestMap` | 只有 `initialize` / `session/prompt` / `shutdown` |
| 通知 | 同上 `HarnessSdkNotificationMap` | `session.event` / `session.status` / `subagent.started` / `subagent.finished` |
| 取消 | 全仓无 `session/cancel` | 取消 = **终止独占进程**（实测发送该方法返回 `-32603 unknown ... method`） |
| 分帧 | `packages/sdk/protocol/src/transport.ts` | 一行一帧；`\r` 要吃掉；**非 JSON 行忽略**；`-32601`/`-32603` |
| 握手版本 | `packages/sdk/server/src/server.ts:170` 硬编码 | wire 上 `serverInfo.version` 是 **`0.0.1`（协议版本常量）**，不是包版本 `0.1.7-rc.1` |

> ⚠️ 最后一条是两个不同东西：**包版本**（`package.json` = `0.1.7-rc.1`，启动前核对）
> ≠ **协议版本**（wire 上 `0.0.1`，握手时比对名字 + 记录版本）。
> 第一版把两者混为一谈，会让"版本核对"要么永远失败、要么毫无意义。

## 2. 新增的四个模块

| 模块 | 职责 | 关键判据 |
|---|---|---|
| `ai/runtime/sdk-process.mjs` | 从 `vendor/dsh/runtime-manifest.json` 解析入口、构造**白名单环境**、真实 spawn、进程树清理、孤儿探测 | 入口必须是 `built-cli` 且文件存在；包版本必须与 manifest 一致；Node 主版本 ≥22；任一不符 `ok:false` **不给命令** |
| `ai/runtime/sdk-stdio-transport.mjs` | 逐行 JSON-RPC：分帧、id 关联、通知分发、错误响应、**超时**、**超大帧保护** | 请求超时必失败；帧超限判死并拒绝挂起；噪音行忽略但计数 |
| `ai/runtime/sdk-adapter.mjs` | 生命周期状态机：spawn → initialize → session/prompt → `session.event` → 终态 → shutdown → 确认真实退出 | 没握手不许发 prompt；没终态不许报 done；只收本 session 事件；进程没退出不许开新任务 |
| `ai/runtime/sdk-route.mjs` | 生产通道接线：开关 / 用途 / 路由 / 预算 / 能力五道判据 + **回退纪律** | 默认关闭；只有"一次调用都没发出"才允许回退 |

`ai/runtime/dsh-sdk.mjs`（S13）被**最小修正**而非重写：去掉编出来的命令，改成从 manifest 解析 +
`buildChildEnv` 白名单，并把解析失败落成显式的 `launch_refused`。

## 3. 12 个验收场景与真实观测值

命令：`node scripts/nsdsh/verify-sdk-real.mjs`（**exit 0**）

| # | 场景 | 观测值 |
|---|---|---|
| S1 | 入口由 manifest 解析、不发明命令 | `entry=bin.js`、`pkg=0.1.7-rc.1`、`args=[--profile sdk]`、无 `--stdio`、无 `dsh-sdk` |
| S2 | 入口缺失 → fail-closed | `reason=ENTRY_MISSING`，`command=null`（不降级到源码/全局包） |
| S3 | 环境白名单：敏感键不外泄 | `MY_API_KEY/GH_TOKEN/DB_PASSWORD/CLIENT_SECRET` 全部被挡（`withheld` 有记录），显式 allow 才放行一个 |
| S4 | **真实子进程**：真 PID / 真握手 / 真终态 / 受控退出 | `pid=14512`、`serverInfo=deepseek-harness-sdk-runtime@0.0.1`、`terminal=done`、`exit=0`、`shutdown=true`、事件 17 条 |
| S5 | 假 provider 实际收到什么 | `tools=24`、`messages=1`、提示词出现在消息里 |
| S6 | **工具面由 profile 真实决定** | `sdk-minimal` 真实工具面 = `["pwsh"]`；4 个 `author_confirm` 工具一个都没出现 |
| S7 | 上游没有 `session/cancel` | 发送 → `SdkRpcError -32603 unknown DeepSeek Harness SDK runtime method: session/cancel` |
| S8 | 取消 = 杀进程 + 确认退出 | `cancel=cancelled`、`result=cancelled`、PID 已消失、可立刻新建任务 |
| S9 | 双会话隔离（同一进程） | `work-A=17 / work-B=17`、其它 session = 0、各 1 个 `turn/end` |
| S10 | 不碰作者真实 DSH 配置 | `~/.dsh/settings.yaml` 前后哈希一致；临时 `DSH_HOME` 已创建 |
| S11 | 孤儿扫描 | 本次起飞的 5 个 PID **全部已退出** |
| S12 | 传输分帧 | 拆分帧正确关联；超大帧 → `SdkFrameTooLarge` 且挂起请求被拒绝 |

补充套件（`run-nsdsh-tests.mjs` 内，共 **39** 条断言）：
`sdk-launch`（10）、`sdk-transport`（11）、`sdk-adapter`（18）—— 覆盖失败路径与状态机，
**不起子进程**（受限沙箱会拒绝管道 stdio，见 E1）。

## 4. 生产接线（默认关闭）

`server.js` 的 `temporalAnalysisGenerate()` 现在在 `callAI` **之前**插入一个 SDK 分支：

```
sdkDecision = ModelBroker.sdkRouteDecision({ requested: sdkRouteFlag(NOVELSTUDIO_SDK_ROUTE), purpose:'analysis', route, capability:'proposal' })
  └ ok:true → runSdkAnalysis(...) → used:true ? return text : 继续 callAI
  └ ok:false → 直接 callAI（一次模型调用都还没发生）
```

五道判据（`ai/model-broker/routing.mjs` 的 `sdkRouteDecision`，可单测）：
开关 → 用途合法 → 路由存在且带 config → **`author_confirm` 能力拒绝下放** → 预算未耗尽 → 租约代际一致。

**回退纪律（计费相关，必须写死）**：
`not_run` 表示"一次请求都没发出" → 允许回退；
`failed` / `unknown` 表示"已经发过" → **禁止回退**，否则同一段正文被计费两次。

**默认关闭的证据**：不设 `NOVELSTUDIO_SDK_ROUTE` 时，`temporal` 全套 **15/15** 通过，
与改造前的 15/15 一致——这是"默认路径未改变"的行为证据，不是形状断言。

## 5. 事故记录：一次真实的"环境没传下去"（必须公开）

**发生了什么**：本阶段第一版 `verify-sdk-real.mjs` 的 S9 场景把
`buildChildEnv({...})` 的返回值 `{ env, passed, withheld }` **整个对象**当成 `extra` 又传回了
`buildChildEnv`。结果子进程拿到的是 `env="[object Object]"` 之类的键，**没有 `DSH_HOME`、
没有 `DEEPSEEK_BASE_URL`、没有 `DEEPSEEK_API_KEY`**。

**后果**：那一次 DSH 子进程用了**作者真实的 `~/.dsh`**，在
`~/.dsh/sessions/--C-Users-a1941-AppData-Local-Temp-ns-sdk-iso-l7NA6E--/{work-A,work-B}`
落了两份会话日志，在 `~/.dsh/storages/session_projcache/sessions/` 落了两份投影缓存。

**是否产生真实调用/费用**（逐项核对，不含推断）：

| 证据 | 观测 |
|---|---|
| 预算账本 `~/.dsh/storages/dsh_budget.json` | `2026-10-17` 只有 `deepseek-flash`（本 agent 自己的模型）；**没有 `deepseek-v4-pro` 行**，而那次子进程的模型参数正是 `deepseek-v4-pro` |
| 受污染会话日志 | 只解出 1 行 session header（进程被 SIGTERM 前事件未刷盘） |

**结论（严格表述）**：**账本里没有任何该模型的用量记录，因此没有发生计费**；
但"没有计费"不等于"绝对没有发出过请求"——如果请求被上游拒绝，用量不会记账。
本报告不声称后者已被证明。

**已做的清理**（逐项验证过）：删除那 2 个会话目录、2 个投影缓存文件；
`grep -rl "ns-sdk-iso" ~/.dsh` 结果为空。
`~/.dsh/profiles/sdk/` **保留**——它是 DSH 正常生成的 profile 物化产物（与 `headless`/`web` 同类），
不存在被测试污染的状态。

**已加的守卫（防复发）**：每个场景在 spawn 之前必须过 `assertSandboxedEnv()`：

```
① DSH_HOME 必须指向本次的临时目录（否则 DSH 会读写作者 ~/.dsh）
② DEEPSEEK_BASE_URL 必须是 127.0.0.1（否则可能打到真实计费端点）
```

任一条不满足 → **该场景直接 FAIL**，不是"大概本地"。这类 bug 的教训不是"下次小心"，
而是"把'我知道我在临时环境里'变成一次运行时检查"。

## 6. 根因与以后避免

| 根因 | 规则 |
|---|---|
| 把"包装对象"当"内层对象"传递（`{env}` vs `env`） | 凡是"传给下游之前要再处理一遍"的返回值，**用解构取名**（`const { env } = …`），不要整体转发 |
| 测试无法区分"用了临时环境"和"用了真实环境" | 每个隔离场景必须有**运行时守卫**，不能靠"我写的时候是这么想的" |
| 断言只覆盖 happy path | 同一模块必须同时断言"拒绝路径"（S2/S3/S7/A2/A3/A12） |

## 7. 本阶段**没有**证明什么

- 没有接**真实模型**跑过（零计费纪律）→ 真实模型质量仍是 `NOT_RUN_REQUIRES_AUTHORIZATION`。
- 没有在 macOS / Linux 上跑过 → 那两格仍 `UNVERIFIED`（见 R03）。
- 没有产出可分发裁剪包 → 仍 `NOT_PRODUCED`（见 R02）。
- SDK 路由在生产里**默认关闭**，且只接到"章节分析"这一条通道；写作/审稿/修稿未接。

## 8. 回退

关闭 `NOVELSTUDIO_SDK_ROUTE`（或干脆不设）→ 立刻回到 `callAI` 直连路径，
**不需要**回滚故事库、不涉及时态 schema 迁移。子进程若异常残留，`terminateProcessTree` 会按平台清理
（win32 用 `taskkill /T /F`，POSIX 先 SIGTERM 后 SIGKILL），并由 `detectLeaks()` + 孤儿扫描复核。
