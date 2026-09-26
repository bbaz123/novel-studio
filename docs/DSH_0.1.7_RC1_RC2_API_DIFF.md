# DSH 0.1.7-rc.1 → 0.1.7-rc.2 API 差异表

> 口径：RC.1 = 本地源码仓库 `desktop\DeepSeek\deepseek-harness`（master @ 7e06df2，tag `dsh-v0.1.7-rc.1`，含预构建 `apps/cli/lib`）
> 　　　RC.2 = npm 官方 `@deepseek-ai/dsh@0.1.7-rc.2` 解包树（`.dsh-rc-compat/x-rc2`，297 包）
> 状态词：PASS / DEGRADED / BREAKING / UNKNOWN / NOT_APPLICABLE。以下是**只读诊断**结论。
> 原始语料：`.dsh-rc-compat/evidence/pkg-diffs/*.diff`（293 包，8.0 MB）、`classify2.json`、`bundle-id-diff.txt`、`lib-diff-*.txt`。

---

## 0. 总量与"有没有真差异"

| 指标 | 值 |
|---|---|
| 逐包比对 | 293（RC.1 仓库 307 包中的 293 个；其余 14 个为内部/未发布包） |
| 逐字节相同 | **179** |
| 有差异 | 114（+71 / −6 文件，238 文件内容变化，+23,910 / −7,310 行） |
| **去哈希归一后仍有语义变化** | **113 包 / 236 文件** |
| novel profile 的组合条目 | RC.1 **97 → RC.2 99**，**ID 删除数 = 0**（`bundle-id-diff.txt`） |
| 主机包 `--help` | **逐字相同**（`lib-diff-bin.txt`） |

> ⚠️ 不要把"文件内容变了"直接当 API 变化。rolldown 把 8 位内容哈希写进相对 import（`plugin-Dr5KNRuz.js → plugin-DkYIj96-.js`），
> `plugin-*.js`、`profile-boot-*.js`、`dump-config-*.js` 的"差异"绝大多数只是这一行。本表的每一行都已按实际内容核对。

---

## A. API 新增

| # | 新增项 | 形态 | 影响面 | 状态 |
|---|---|---|---|---|
| A1 | **`ToolUpdate = 'in-history' \| 'addition-only'`** | 类型（`@deepseek-ai/dsh-llm`） | 宿主内部；第三方插件若实现 provider 需感知 | PASS（新增，无破坏） |
| A2 | **`ToolHistory`** + `projectToolUpdates()` | 类型 + 纯函数 | 把"会话中途新增/移除工具"投影成 provider 声明 | PASS |
| A3 | **`PreparedLlmCall.toolUpdate?`** | 字段 | 路由声明"我支持工具更新"的方式 | PASS |
| A4 | **`ACCOUNT_QUOTA_EXCEEDED_CODE = "ACCOUNT_QUOTA"`** | 常量 | 账号额度错误码 | PASS |
| A5 | **`defer_loading`（线协议字段）** | DeepSeek Messages 请求体 `tools[]` 上的新字段 | 模型侧协议；**RC.1 见它会直接报错**（见 E1） | PASS |
| A6 | 工具审批 `displayReason` | `@deepseek-ai/dsh-tools` 新增透传字段 | 审批气泡显示 | PASS |
| A7 | `reportSkippedBundles(NAME, profile)` | `@deepseek-ai/dsh-boot`(app-boot) 新导出；`profile-boot` 启动时调用 | 启动日志多一条"跳过的 bundle"报告 | PASS |
| A8 | `ToolHistoryProjection` 类（+89 行，**零删除**） | `@deepseek-ai/dsh-session` 新模块 `lib/types/tool-history.js` | 会话重建工具声明历史（v4 格式） | PASS |
| A9 | 会话事件 `developer/message` + `tool-addition` / `tool-removal` 内容块 | session 事件层 | 中途增删工具会被记入历史并投影 | PASS |
| A10 | `request/header` 事件新增 `startsSeries: true` | session 事件 | 声明"工具声明新系列开始" | PASS |

### 包级新增（仅 RC.2 存在于 npm）

| 包 | 说明 | 对小说链路 |
|---|---|---|
| **`@deepseek-ai/dsh-llm-deepseek-api-key@0.1.7-rc.2`** | **新包**：`const name="llm-deepseek-api-key"; const PROVIDER="deepseek-official";` | 关键：`deepseek-official` **原样保留** |
| **`@deepseek-ai/dsh-llm-deepseek-account@0.1.7-rc.2`** | **新包**：`PROVIDER="deepseek-account"`（新增账号登录通道） | 不改变现有 provider id |
| `@deepseek-ai/dsh-util-code-language@0.1.7-rc.2` | `langFromPath` 从 tool-fs 抽出 | 无行为影响 |
| `@deepseek-ai/dsh-client-shortcuts` / `dsh-client-ui-shortcuts` | 快捷键 | UI |
| `@deepseek-ai/dsh-web-frontend` | Web 前端 | UI |
| **`@deepseek-ai/dsh-operation-security@0.1.7-rc.2`** | **不在 npm 上（404）**，是本机构建/私有源产物；仅因本机改过 `dsh-base/cordis.patch.yml` 才被挂载 | **非 stock RC.2**，写作 profile 不涉及 |
| `@deepseek-ai/cordis@4.0.4`、`cordis-plugin-group@1.0.4`、`-include@1.0.9`、`-loader@1.0.5`、`-timer@1.1.6`、`@deepseek-ai/cosmokit@1.8.5`、`@deepseek-ai/schemastery@3.18.4` | 插件框架由 3.x/内嵌 迁到 **4.x 独立包** | 插件 API 表面未变（`ctx.on/provide/effect/plugin/tools` 全在） |

> 包级"消失"要小心：本机 RC.2 只装了默认 profile 需要的子集。
> 抽样验证 41 个"RC.1 有、本机 RC.2 没有"的包，其中 `dsh-tool-terminal`、`dsh-subagent-codex`、`dsh-lsp`、`dsh-client-web`、`dsh-browser-use`、`dsh-computer-use`、`dsh-web-search-exa`、`dsh-tool-session-query`、`dsh-sandbox-ssh` **在 npm 上都有 0.1.7-rc.2**（只是没装）；
> `dsh-storage-sqlite`、`dsh-session-snapshot`、`dsh-remote-mock` **只有 rc.1、没有 rc.2** → 标 **UNKNOWN（P3）**，且三者都不在 novel profile 的组合里（ID 删除数=0），对小说链路无影响。

---

## B. API 删除

| # | 项 | 结论 |
|---|---|---|
| B1 | novel profile 组合条目 | **删除数 = 0**（97 → 99，只增不减） |
| B2 | `ctx.*` 插件入口（`provide`/`effect`/`plugin`/`on`/`logger`/`tools`/`skills`） | **无删除**（memory 插件与 novel-writing 用到的全部仍在） |
| B3 | 钩子名 `agent/pre-step`、`session/event`、`session/flush`、`session/end`、`tools/pre-execute`、`tools/post-execute`、`system-prompt` | **无删除**（`hook-surface.txt` 两版同批命中） |
| B4 | provider id `deepseek-official`、模型 `deepseek-flash` / `deepseek-v4-pro`、effort `off` / `low` / `high` / `max` | **无删除**（`llm-provider-ids.txt`、`effort-check.txt`） |
| B5 | `DEFAULT_CONTEXT_WINDOW=1e6`、`DEFAULT_MAX_TOKENS=256e3` | **两版都在** |
| B6 | CLI 表面（`--help` 全量文本） | **逐字相同** |
| B7 | 会话落盘格式 `session.v4.jsonl.zstd` 与 `--session-id` | **无删除、无格式变化** |
| B8 | 三个包 `dsh-storage-sqlite` / `dsh-session-snapshot` / `dsh-remote-mock` 在 rc.2 未发布 | **UNKNOWN（P3）**；不在 novel 组合内 |

---

## C. API 重命名

| # | RC.1 | RC.2 | 是否兼容 | 状态 |
|---|---|---|---|---|
| C1 | provider 注册责任在 `@deepseek-ai/dsh-llm-deepseek` | 责任搬到 **`@deepseek-ai/dsh-llm-deepseek-api-key`**（provider id 仍是 `deepseek-official`） | **包名变了、provider id 没变**。RC.2 里老包 `dsh-llm-deepseek` **仍在**（适配器/工厂：`registerDeepSeekProvider`、`deepSeekConfigFields`、`catalogModelInfo`、`plainOptions`、`resolveAdapterOptions`），只是**不再持有 provider 身份** | **P3 隐性风险**：老 profile 补丁若写 `name: '@deepseek-ai/dsh-llm-deepseek'`，仍能加载，但**不会再注册 `deepseek-official`**。本机写作 profile 走的是 base bundle（已更新为新包），实测正常 |
| C2 | `langFromPath` 在 `dsh-tool-fs` 内 | 抽到 `@deepseek-ai/dsh-util-code-language` | 内部重构，无外部契约 | PASS |
| C3 | `generateConfigSchema(NAME, profile, …)` | `generateConfigSchema(profile, …)`（**去掉 `binName` 形参**） | **公开导出签名变化**（`lib/dump-config-schema-*.js`） | **P3 公共 API 破坏**：第三方若调用该工具需去掉首参；小说工坊**不使用**该 API → 对小说链路无影响 |
| C4 | fs 工具指导语（`read`/`write`/`edit`/`glob`）长句 | 短句（见 D3） | 语义保留 | DEGRADED（轻微） |

---

## D. 参数 / Schema 变化

| # | 位置 | RC.1 | RC.2 | 性质 |
|---|---|---|---|---|
| D1 | `dump-config-schema` | `(NAME, profile, …)` | `(profile, …)` | 参数删除（C3） |
| D2 | `agent-loop.buildRequest` | `(config, preparedCall, tools, startsSeries, signal)` | `(config, preparedCall, tools, **{turn, step}**, startsSeries, signal)` | 内部签名扩展（新增位置参数） |
| D3 | 工具 schema 文案 | `read` 含 "Results include line numbers."；`write`/`edit`/`glob` 长指导语 | 全部缩短（系统提示词合计 **2715 → 2030 字符，−685**），`edit.old_string` 去掉 "Must match exactly."，`read_image` 描述精简 | **提示词级变化（非功能）** |
| D4 | `write`/`edit` 的 `sandbox_permissions` 描述 | "The wider sandbox mode this file operation needs…" | "The **narrowest wider** sandbox mode for a one-shot retry of the exact operation…" | 语义收紧（更明确） |
| D5 | `justification` 描述 | 无语言要求 | 追加 "**Use the language of the user's current request.**" | 新增要求 |
| D6 | `time-context.refreshIntervalMs` | `undefined`（=不自动刷新） | **`?? 600000`（默认 10 分钟自动刷新）** | **默认值变化（行为）**；小说链路单轮任务内实际影响≈0，标 P3 |
| D7 | `defer_loading` | 不存在 | 出现在"会话中途新增"的工具声明上（实测 15 个 `mcp__openviking__*` 全带） | 新增字段（A5/A9） |
| D8 | MCP 工具名字 | `mcp__openviking__<name>` | **完全相同 15 个** | PASS |

---

## E. 行为变化（API 名字没变、语义变了）

| # | 位置/机制 | RC.1 行为 | RC.2 行为 | 实测证据 | 状态 |
|---|---|---|---|---|---|
| **E1** | `llm-deepseek` 序列化 | `serialize.ts:87`：遇到 `deferLoading: true` → `unsupported('deferred tool loading')` → 抛 `LlmError(..., 'UNSUPPORTED_CONTENT')` | 支持：把 `defer_loading: true` 写进 wire（`input_schema` 同级） | `pkg-diffs/dsh-llm-deepseek.diff`；`rt3` 原始 dump | PASS（能力增强）；对小说无影响（`dsh-mcp-client` 两版都不设 deferLoading） |
| **E2** | 中途新增工具的通知 | 工具静默出现在**下一轮**请求里，模型无任何提示（messages=3：user/assistant/user） | **多注入一条 `system`/developer 消息**，含 `tool_addition` 块逐条列出新工具（messages=**4**） | `rt3` dump 逐字段比对 | **增强（PASS）** |
| **E3** | 工具集变化与请求系列 | `startsSeries = … \|\| toolsChanged(...)` | `startsSeries = … \|\| (preparedCall?.toolUpdate === void 0 && toolsChanged(...))` | `pkg-diffs/dsh-agent-loop.diff` | 对不支持工具更新的路由保持旧行为 |
| **E4** | 消息历史中的工具变更 | RC.1 序列化遇到 `tool-addition`/`tool-removal` 块会 `unsupported(...)` | 支持（并写 developer 历史） | RC.1 `serialize.ts` 片段 vs RC.2 实现 | 只在 RC.2 的机制里出现，不构成回归 |
| **E5** | 子串替换工具 | 截断可能切断代理对 | `truncateWithoutSplittingSurrogatePair` | `pkg-diffs/dsh-tool-str-replace-editor.diff` | **对中文正文更安全（PASS）** |
| **E6** | 系统提示词体量 | 2715 字符 | 2030 字符 | `rt7-sysdiff.txt` | DEGRADED（轻微，见 D3） |
| **E7** | 冷启动耗时 | 中位 **3097ms**（3097/2881/3363） | 中位 **5866ms**（5730/5866/6060）；关掉新增 opsec/account 后 4795ms | `rt4-timing.txt`、`rt5-cause.txt` | **DEGRADED：+≈2.8s**；成因在 RC.2 依赖树本身，不在新增插件 |
| **E8** | Profile 启动日志 | 无"跳过 bundle"报告 | `reportSkippedBundles()` 输出被跳过的 bundle | `pkg-diffs/dsh-boot.diff`、`lib-diff-profile-boot.txt` | P3（可观测性增强） |
| **E9** | 会话中途新增工具时的头事件 | 无 `startsSeries` 标记 | `request/header` 带 `startsSeries: true` | A10 | P3 |
| **E10** | 工具审批气泡 | 无 `displayReason` | 有（可显示一句话理由） | D6/A6 | P3 |

---

## F. 返回值变化

| # | 项 | 结论 |
|---|---|---|
| F1 | 工具结果结构 / 错误结构 | **未发现变化**（`rt3` 工具结果两版同形；未知 session 的报错逐字相同） |
| F2 | `--dump-config` 输出 | 结构相同，条目 97 → 99（新增 `llm-deepseek-account`；`llm-deepseek` → `llm-deepseek-api-key`；dump 层只多 1 条 `operation-security`） |
| F3 | 会话 JSONL 事件结构 | 新增 `developer/message`、`request/header.startsSeries`（只增不改） |

---

## G. 权限变化

| # | 项 | RC.1 | RC.2 | 状态 |
|---|---|---|---|---|
| G1 | 工具审批字段 | `sandbox_permissions` + `justification` | 同字段；**文案收紧**（"narrowest wider sandbox mode"、"用用户当前请求的语言"） | PASS（文案） |
| G2 | stock 权限模型 | — | 未发现新增硬限制 | PASS |
| G3 | **本机非 stock 权限层** | 无 | 全局安装的 `dsh-base/cordis.patch.yml` 被本地加了 `@deepseek-ai/dsh-operation-security`（`requireApprovalForExecute/Output: true`、`enforcedOperations: [PLUGIN_INSTALL, PLUGIN_UPDATE, PLUGIN_ENABLE, PLUGIN_UNINSTALL, EXPORT, PUBLISH]`） | **必须在结论里单列**：这不是 stock RC.2；写作 profile（RC.1）不受影响；GUI/Web（RC.2）会启用该层 |

---

## H. 明确"没变"的清单（用于防止过度推断）

以下是**实测逐字/逐字段相同**的部分，升级不需要任何适配：

```text
CLI --help 全量文本                              （lib-diff-bin.txt）
会话恢复：--session-id 二次运行行为与消息数        （rt9-run.txt）
未知 session 报错文案与退出码                     （rt8-run.txt）
novel profile 的组合条目 ID 集合（零删除）         （bundle-id-diff.txt）
模型可见工具集合（32 个，含 23 个 novel_*）        （rt3-toolnames-*.txt，两文件哈希一致）
MCP 工具集合（15 个 mcp__openviking__*）          （rt3 dump）
provider id / 模型 id / effort 枚举               （llm-provider-ids.txt、effort-check.txt）
memory 插件的 peerDependencies 范围与运行时接口    （package.json、index.mjs）
65 个 `novel_*`/memory 相关源码文件逐字节相同      （classify2.json：dsh-mcp-client、dsh-skill-filesystem、dsh-system-prompt 等 sem=0）
```

---

## 一句话结论

**存在 API 新增与内部重命名，存在 1 处公开导出签名变化（`generateConfigSchema` 去 `binName`）与 1 处"包名搬迁但 provider id 保留"的隐性风险（C1），但不存在影响小说工坊链路的能力删除。**