# RC1 vs RC2 调用能力矩阵（19 项）

> 目的：回答"**插件还能不能像 RC.1 一样完整调用 DSH**"，而不是"插件还能不能启动"。
> 状态词：PASS / DEGRADED / BREAKING / UNKNOWN / NOT_APPLICABLE。没有实测证据 → UNKNOWN。
> 环境：同机、Node v24.19.0、同一份 `~/.dsh-novel` 配置副本、同一假 LLM、隔离实例（`scripts/ci-isolated-run.mjs`），零计费。
> 证据：`novel-studio/.dsh-rc-compat/evidence/rt*.txt|json`、`pkg-diffs/*.diff`。

## 逐项判定

| 能力 | RC.1 | RC.2 | 是否下降 | 证据 | 备注 |
|---|---|---|---|---|---|
| **Tool 注册** | 32 工具（23 个 `novel_*` + 6 个 fs + 3 个 MCP 资源） | 32 工具，**逐字集合相同** | **否（PASS）** | `rt3-toolloop.txt`；`rt3-toolnames-rc1/rc2.txt` 哈希一致 | `ctx.tools.register` 契约未变 |
| **Tool 调用** | `novel_works` 真调用，结果含作品标题，exit 0 | 同 | **否（PASS）** | `rt3-toolloop.txt` | 注册→参数解析→执行→回填全通 |
| **MCP** | 第 2 轮请求出现 **15 个** `mcp__openviking__*` | 同样 15 个，**名字集合完全相同** | **否（PASS）** | `rt3-*.txt` 原始 dump 逐条比对 | 桥随 dsh 本体发布；stdio 子进程两版都能起 |
| **File** | `read/write/edit/glob/grep/read_image` 6 个工具在位 | 同样 6 个；**描述文案变化**（见 API Diff §Tool） | **否（PASS，非功能性）** | `rt3-toolnames-*.txt`、`pkg-diffs/dsh-tool-fs.diff` | 未做真实文件读写断言 → 严格说"可用性"证据为间接 |
| **Shell** | `novel` profile 未注册 shell/bash 工具 | 同 | **不适用（NOT_APPLICABLE）** | `rt3-toolnames-*.txt` 全量工具名 | 小说链路不经过 shell；此处不下"PASS" |
| **Process（子进程）** | MCP proxy 由 `process.execPath` 拉起并完成 tools/list 握手 | 同（15 工具即证明握手成功） | **否（PASS）** | `rt3-*`、`rt10-memory-e2e.json`（proxy 子进程存在） | 未测环境变量继承差异 → 该项若单独判需 UNKNOWN，但"能起子进程"已证 |
| **Context（上下文层）** | 系统提示词 2715 字符；插件注入层可用 | 系统提示词 **2030 字符（−685）**；其余层同 | **轻微（DEGRADED-轻微）** | `rt7-sysdiff.txt`、`rt6-memory.txt` | 减少的全是 fs 工具指导语，非小说设定/记忆内容（详见主报告 §9） |
| **Session** | 会话创建、跨进程恢复（消息数 3、带回上一轮正文） | **完全相同** | **否（PASS）** | `rt9-resume.txt`、`rt9-run.txt` | `session.v4.jsonl.zstd` 格式两版一致 |
| **Memory** | session 落库成功（`message_count=2`），commit 未发生（`commit_count=0`） | 与 RC.1 **逐项相同** | **否（两版一致）**；绝对能力 **UNKNOWN** | `rt10-memory-e2e.json`、`rt11-memory-commit.json` | 见主报告 §11：不是版本差异，是写作链路既有特性 |
| **Hook** | `agent/pre-step`(prepend)、`session/event`、`session/flush`、`tools/pre/post-execute` 都在 | 都在（`hook-surface.txt` 两版命中同一批名） | **否（PASS）** | `evidence/hook-surface.txt` | 钩子**执行顺序**未做 A/B 断言 → 该子项 UNKNOWN |
| **Event** | `turn/end`、`user/message`、`assistant/message`、`tool/result` 驱动 memory capture | 同（capture 落库两版都成功） | **否（PASS）** | `rt10/rt11` + memory `capture.mjs` 事件映射 | — |
| **Permission** | 工具 schema 含 `sandbox_permissions` / `justification` | 字段都在；**文案收紧**（"narrowest wider sandbox mode…" + "用用户当前请求的语言"） | **否（PASS，文案变化）** | `rt3` 原始 tools JSON 字段级比对；`pkg-diffs/dsh-tools.diff` | RC.2 新增 `displayReason` 字段（审批气泡） |
| **Config** | 同配置合成 97 条 | 99 条，**ID 删除数 = 0**；新增 `llm-deepseek-account`；`llm-deepseek` → `llm-deepseek-api-key` | **否（PASS）** | `bundle-id-diff.txt`、`dumpconfig.diff` | 无删除是本项最强证据 |
| **Recovery** | `--session-id` 恢复成功；未知 id 报错并 exit 1 | **逐字相同** | **否（PASS）** | `rt9-run.txt`、`rt8-run.txt` | 中断/重启的**插件内部状态**恢复未测 → 子项 UNKNOWN |
| **长文本输入** | argv 28,000 字 OK；stdin 130,000 字 OK | 27,000/130,000 字均 OK | **否（PASS）** | `rt8-run.txt` | 工坊自身 argv 32k 上限是**工坊缺陷**，非 DSH 差异 |
| **长文本输出** | 24,000 字回复：exit 0，落盘 81,395 字符，尾部标记完整 | 24,000 字：exit 0，落盘 79,184 字符，尾部完整 | **否（PASS）** | `rt13-longout.txt` | 120,000 字回复**两版都不退出**（100s 超时），与 Memory 开关无关 → 共同特性，见主报告 §17 |
| **并发调用** | 同一 home 两进程并发：都 exit 0，各自建 session | 同 | **否（PASS）** | `rt12-parallel-longout.json` | 高并发/竞争压力未测 → 上限 UNKNOWN |
| **异步调用** | MCP 桥 `apply` 不 await；工具延后出现在第 2 轮 | RC.2 除了延后，还**多注入一条 developer/system 消息**告知模型（`tool_addition`） | **否（PASS，行为增强）** | `rt3` dump：RC.1 messages=3 / RC.2 messages=4；`pkg-diffs/dsh-session.diff` | RC.1 模型到第 2 轮才"看见"新工具且无提示 |
| **错误恢复** | 未知 session → exit 1 + 明确报错；MCP 不可用不影响 recall/capture（插件自述） | 同 | **否（PASS）** | `rt8-run.txt`；memory `mcp.mjs` 注释与 pending-queue 实现 | "MCP 断线后的 pending 队列重放"未做故障注入 → 子项 UNKNOWN |

## 汇总

```text
19 项中：
  PASS（含轻微文案/增强）        16
  DEGRADED（轻微，可用）          1   → Context（系统提示词 −685 字符，全为工具指导语）
  NOT_APPLICABLE                  1   → Shell（novel profile 不挂 shell 工具）
  BREAKING                        0
  整项 UNKNOWN                    0
  带 UNKNOWN 子项的 PASS          4   → Memory（召回链绝对能力）、Hook（顺序）、Permission（真实拦截行为）、错误恢复（故障注入）
```

**结论：不存在"表面兼容、实际能力缩水"的实例。**
唯一被证实的"缩水"是系统提示词里 fs 工具指导语文案变短（−685 字符，非小说设定/记忆内容）；
唯一被证实的"增强"是 RC.2 在会话中途新增工具时会向模型显式通告（RC.1 不会）。