# 小说工坊 / 插件 实际运行测试报告（RC.1 vs RC.2）

> 全部测试均在**隔离环境**下执行：`node scripts/ci-isolated-run.mjs --port <端口> -- <命令>`，
> `NOVELSTUDIO_DATA_DIR` 指向临时目录、`DSH_HOME` 指向 `~/.dsh-novel` 的临时副本（跳过 `sessions`/`storages`/`profiles/node_modules`），
> 模型侧用本地假 LLM（`.p1-baseline/fake-llm.mjs`，零计费）。**未触碰作者真实库、真实记忆与生产端口（3737 / 3080）**。
> 每个测试的原始输出都在 `novel-studio/.dsh-rc-compat/evidence/`。

## 测试清单

| 编号 | 测试名称 | 测试环境 | 测试目的 | RC.1 结果 | RC.2 结果 | 差异 | 日志/错误 | 最终状态 |
|---|---|---|---|---|---|---|---|---|
| T01 | 启动器 + 插件装载（`--help`，profile 真 apply） | 隔离 home ×2，端口 3741 | 宿主能否启动、插件能否加载 | exit 0，中位 3097ms | exit 0，中位 5866ms | **+2.8s** | 无报错（stderr 空） | **DEGRADED（仅耗时）** |
| T02 | `--dump-config` | 同一份 `~/.dsh-novel` 副本 | 组合条目是否有删除 | exit 0，214ms，97 条 | exit 0，310ms，99 条，**零删除** | +2 条目 | 无 | **PASS** |
| T03 | 冷启动计时 ×3 | 同上 | 确认耗时差稳定 | 3097/2881/3363 | 5730/5866/6060 | 稳定 +2.8s | 无 | **DEGRADED** |
| T04 | 开销归因（关 opsec / 关 account / 都关） | 同上 | 判断慢在哪 | — | 5727 / 5895 / **4795** | 关掉新增插件只省 ~1s | 无 | **PASS（归因：依赖树）** |
| T05 | 单轮任务（`--profile novel <prompt>`） | 隔离 home+假 LLM | 端到端能否跑通 | exit 0，3361ms，32 工具 | exit 0，5310ms，32 工具 | 仅耗时 | 无 | **PASS** |
| T06 | 端到端工具循环（假 LLM 调 `novel_works`） | 同上 + 隔离工坊实例 | Tool 注册→调用→回填 | exit 0，3717ms，结果含作品标题 | exit 0，6511ms，同 | **工具名集合逐字相同** | 无 | **PASS** |
| T07 | MCP 工具注册表面（第 2 轮请求） | 同上 | 桥是否真的挂上工具 | **15 个** `mcp__openviking__*` | **15 个，名字集合相同** | 无 | 无 | **PASS** |
| T08 | 中途新增工具的模型可见性 | 同上（dump 逐字段） | 隐性行为变化 | messages=3，静默出现 | messages=**4**，多 `tool_addition` 通告 | RC.2 增强 | 无 | **PASS（增强）** |
| T09 | Memory 写入（`session/event`→`addMessage`） | 隔离 home、专用 peer `rc-compat-e2e-*` | 记忆是否落库 | OV session 存在，`message_count=2` | 同 | 无 | 无 | **PASS** |
| T10 | Memory commit / 记忆抽取 | 同上 + `OPENVIKING_COMMIT_TOKEN_THRESHOLD=1000`、4102 字提示词 | 能否产生可召回记忆 | `commit_count=0`，`memories_extracted=0` | 同 | 两版一致 | 无 | **UNKNOWN（两版一致）** |
| T11 | Memory 跨 session 召回 | 同上，第二个新 session 提问 | 召回块是否注入 | 无 `<openviking-context source="recall">` | 同 | 两版一致 | 无 | **UNKNOWN（两版一致）** |
| T12 | 长文本输入 · argv 28,000 字 | 隔离 home+假 LLM | 长文本是否被截断/乱码 | exit 0，3610ms，标记完好 | exit 0，5673ms，标记完好 | 仅耗时 | 无 | **PASS** |
| T13 | 长文本输入 · stdin 130,000 字 | 同上 | 同上（stdin 通道） | exit 0，4147ms，139,186B | exit 0，6099ms，139,203B | 体积 +17B | 无 | **PASS** |
| T14 | 长文本输出 · 24,000 字回复 | 隔离 home+假 LLM | 大段正文能否完整落盘 | exit 0，3326ms，81,395 字符，尾部标记在 | exit 0，4454ms，79,184 字符，尾部标记在 | 体积 −2.7%（与 −685 系统提示词同向） | 无 | **PASS** |
| T15 | 长文本输出 · 120,000 字回复 | 同上 | 极端大回复 | **100s 内不退出**（人工终止） | **100s 内不退出**（关 Memory 亦同） | 两版一致 | 正文已完整落盘（328,283 字符，尾部标记在）；子进程仍在 | **UNKNOWN（两版一致）** |
| T16 | 会话恢复 `--session-id` | 隔离 home+假 LLM | 状态是否跨进程保持 | exit 0，消息数=3，带回上轮正文 | 完全相同 | 无 | 无 | **PASS** |
| T17 | 未知会话 ID | 同上 | 错误处理是否一致 | exit 1，`dsh: session "…" does not exist` | 逐字相同 | 无 | 无 | **PASS** |
| T18 | 并发调用（同 home 两进程） | 隔离 home+2 个假 LLM | 并发是否互相破坏 | 都 exit 0，各建 session | 都 exit 0 | 无 | 无 | **PASS** |
| T19 | 系统提示词差异 | dump 的 `system` 字段 | 上下文可见性 | 2715 字符 | 2030 字符（−685） | 4 行 fs 指导语被缩短 | 无 | **DEGRADED（轻微）** |
| T20 | 逐包产物比对 | `.dsh-rc-compat` | 宏观差异规模 | 基线 | 293 包：179 相同 / 113 有语义变化 | — | — | **PASS（信息）** |
| T21 | 组合条目 diff | 同上 | 是否有条目被删 | 97 | 99，**零删除** | +2 | — | **PASS** |
| T22 | OpenViking 服务健康 | `http://localhost:1933/health` | 记忆后端可用性 | 200 | 200（rc 无关，服务未升级） | 无 | 无 | **PASS** |
| T23 | 工坊插件冒烟（`harness-plugins/novel-writing/test/smoke.mjs`） | `--port 3747` 隔离实例 | 插件自身契约 | **39 组断言全通过** | 同（HTTP 直测，不经过 dsh） | 无 | 无 | **PASS** |
| T24 | 工坊 API 套件（`api-test-suite.mjs`） | `--port 3738` 隔离实例 | 工坊主体回归 | — | **186/190 通过，0 失败，4 主动跳过** | — | 跳过项为"不写全局配置"的安全设计 | **PASS** |

## 环境冻结记录（本次测试的那一份）

```text
代码 commit        ：novel-studio 工作区（78 个已修改文件未提交）+ deepseek-harness @ 7e06df2
Host Contract 版本 ：host-contract.v1.json / host-contract-1.1-2026-09-26.md（上一轮已冻结）
插件版本           ：novel-writing@0.10.0；@openviking/dsh-memory-plugin@0.5.3（写作链路）
模型/provider      ：假 LLM（本地 OpenAI/Messages 兼容，零计费）——**不涉及真实模型参数**
关键模型参数       ：未设置（走 profile 默认）
context budget     ：profile 默认（未改动）
route              ：headless 直连（非 harness-pool）
作品 fixture       ：T06 用隔离实例新建的作品（id=1，随后随实例销毁）
数据库 fixture     ：`NOVELSTUDIO_DATA_DIR` 临时目录（`%TEMP%\novel-studio-ci-*`）
测试后清理         ：OV 侧 8 个测试 session 已逐个 **HTTP DELETE 并复核 gone**；进程树已回收；临时目录待清
```

## 本次**没有**测到的（不得当成 PASS）

```text
1. MCP 工具的真实回调（模型→mcp__openviking__*→OV→模型）        → UNKNOWN
2. Memory 的 commit→抽取→召回闭环绝对能力（两版一致地"没发生"）    → UNKNOWN
3. 钩子注册顺序的 A/B（只核对了钩子名存在）                        → UNKNOWN
4. 权限系统的实际拦截（只核对了 schema 字段与文案）                → UNKNOWN
5. MCP 断线后的 pending 队列重放（未做故障注入）                   → UNKNOWN
6. 真实模型下的长文生成质量（本次全为假 LLM，零计费）              → UNKNOWN
7. 120,000 字单条回复为何两版都不退出（已定位为与 Memory 无关）      → UNKNOWN（成因）
```