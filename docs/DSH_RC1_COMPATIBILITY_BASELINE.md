# DSH RC.1 兼容性基线（升级前）

> 生成时间：2026-09-25 · 审查性质：**只读诊断**，未修改 DSH / 小说工坊 / novel-writing / Memory 插件 / 用户配置与数据
> 证据根目录：`novel-studio/.dsh-rc-compat/`（已加 `.gitignore`，未提交）
> 配套文档：`DSH_0.1.7_RC1_RC2_NOVEL_COMPATIBILITY_REPORT.md`（主报告，24 节）· `DSH_0.1.7_RC1_RC2_API_DIFF.md` · `DSH_0.1.7_RC1_RC2_COMPATIBILITY_MATRIX.md` · `DSH_0.1.7_RC1_RC2_NOVEL_PLUGIN_TEST_REPORT.md` · `RC1_vs_RC2_CAPABILITY_MATRIX.md`
> 状态词只用 PASS / DEGRADED / BREAKING / UNKNOWN / NOT_APPLICABLE；没有证据一律 UNKNOWN。

---

## 0. 一句话结论

RC.1 基线**已完整建立**（有源码仓库 + 有可执行启动器 + 有实测运行记录），因此本次审查**不存在 "RC.1 baseline unavailable"** 的情形；
所有"是否退化"的判断都是**同机、同 profile、同 fixture 的前后对照**，不是回忆或推测。

---

## 1. 版本来源（§15 自动发现结果）

```text
RC.1 来源：C:\Users\a1941\Desktop\DeepSeek\deepseek-harness           （git 仓库，含预构建 apps/cli/lib）
           C:\Users\a1941\.dsh-novel\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js   （写作任务实际使用的启动器）
RC.2 来源：C:\Users\a1941\AppData\Roaming\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js （全局 npm 安装）
           C:\Users\a1941\AppData\Roaming\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*（283 个包）
源码版本：RC.1 = git master @ 7e06df2，tag dsh-v0.1.7-rc.1；RC.2 = 上游 tag dsh-v0.1.7-rc.2（477b4f42…，本机 GitHub 不可达，未 fetch）
package version：RC.1 @deepseek-ai/dsh@0.1.7-rc.1（deps=80） / RC.2 @deepseek-ai/dsh@0.1.7-rc.2（deps=81）
运行版本：Node v24.19.0（两版共用）
```

**为什么 RC.1 用仓库源码、RC.2 用 npm 产物做对比**：上游 `dsh-v0.1.7-rc.2` tag 存在但本机连不上 github.com（`git-proxy.mjs` 亦 ETIMEDOUT），
唯一可达通道是 npm 镜像 `registry.npmmirror.com`。对比口径因此是**构建产物 vs 构建产物**（`apps/cli/lib` 与 npm `lib` 都是 rolldown 输出），语义可比；
`@deepseek-ai/dsh` 主机包 `--help` 两版**逐字相同**（证据 `evidence/lib-diff-bin.txt`），说明 CLI 表面未变。

### 1.1 产出规模的量化基线（证据 `evidence/bulk-diff-summary.json`、`classification2.json`、`corpus-stats.txt`）

| 指标 | 数值 |
|---|---|
| 参与逐包比对的包 | 293（RC.1 仓库 312 包中的 293 个；19 个内部/未发布包在 npm 上 404） |
| **逐字节完全相同** | **179 / 293** |
| 有差异 | 114（聚合 +71 文件 / −6 文件 / 238 文件内容变化；+23,910 / −7,310 行） |
| **去掉纯内容哈希重命名后仍有语义变化的包** | **113 个包、236 个文件**（证据 `classify2.json`，字段 `sem`/`semFiles`） |
| 全局 RC.2 安装树 vs npm 官方 0.1.7-rc.2 | 282 / 283 包逐字节一致 |

> ⚠️ 方法论陷阱（必须记住）：rolldown 给每个相对 import 加了 8 位内容哈希，
> 单纯"文件内容变了"绝大多数只是 `plugin-Dr5KNRuz.js → plugin-DkYIj96-.js` 这类**路径改名**。
> 本基线里的"语义变化"是**先归一化哈希再比对**得到的（归一化正则见 `.dsh-rc-compat/classify2.mjs`）。

---

## 2. 宿主接口基线（RC.1 实测/源码）

### 2.1 Plugin API（cordis 风格）

| 接口 | RC.1 形态 | 证据位置 |
|---|---|---|
| 插件导出 | `export const name` / `export const inject` / `export function apply(ctx, config)` | `harness-plugins/novel-writing/novel-tools.mjs`；`~/.dsh-novel/profiles/novel/node_modules/@openviking/dsh-memory-plugin/index.mjs` |
| 依赖声明 | `ctx.provide(key)`、`ctx.effect(() => cleanup, label)`、`ctx.plugin(mod, config)` | memory 插件 `index.mjs` |
| 事件钩子 | `ctx.on("<event>", handler[, { prepend }])` | memory 插件 `index.mjs` / novel-writing |
| 生命周期 | `session/event`、`session/flush`、`agent/session-start`、`agent/pre-step` | 同上 |
| 工具拦截 | `tools/pre-execute`、`tools/post-execute` | 同上 |
| 注册入口 | `ctx.tools.register(definition)` | RC.1 源码 `packages/core/tools/src/index.ts:1282` |
| 系统提示词 | `ctx.system-prompt.assemble()` → `{ tools: ToolSchema[] }` | RC.1 源码 `packages/core/system-prompt/src/index.ts:586` |
| 日志 | `ctx.logger` | memory 插件 `runtime.mjs` |

**钩子表面**（证据 `evidence/hook-surface.txt`，RC.1 lib 目录 307 个文件 / RC.2 297 个）：
`agent/pre-step`、`session/event`、`session/flush`、`session/end`、`tools/pre-execute`、`tools/post-execute`、`system-prompt`、`deferLoading`、`registerConfigurableProviders`、`ctx.provide` —— **两版都在**；仅 RC.2 多 `ToolUpdate`。

### 2.2 Tool API

```text
ToolSchema = { name, description, parameters: Record<string,unknown>, deferLoading?: true }
注册：ctx.tools.register({ name, description, parameters, execute, deferLoading? })
MCP 桥命名：mcp__<serverName>__<rawToolName>（serverName=openviking 时为 mcp__openviking__*）
```
RC.1 源码：`packages/core/tools/src/schema.ts:499-500`（`deferLoading`）、`packages/llm/llm/src/types.ts:465-467`。
**RC.1 的 DeepSeek 适配器拒绝 deferred 工具**：`packages/llm/llm-deepseek/src/serialize.ts:87`
`if (options.tools?.some(tool => tool.deferLoading === true)) return unsupported('deferred tool loading')` → 抛 `LlmError(..., 'UNSUPPORTED_CONTENT')`。
（实测 RC.1 未触发：`dsh-mcp-client` 两版都**不设置** deferLoading，见 §5。）

### 2.3 MCP

| 项 | RC.1 |
|---|---|
| 客户端包 | `@deepseek-ai/dsh-mcp-client`（随 dsh 本体发布，插件无需单独安装） |
| 配置类型 | `{ transport: 'stdio', serverName, command, args, env, toolCallTimeoutMs }` |
| 子进程 | `command: process.execPath`, `args: [mcp-proxy.mjs]`，`ELECTRON_RUN_AS_NODE=1` |
| 工具命名 | `mcp__openviking__<name>` |
| 实测工具数 | **15 个**（第 2 轮请求可见，见 `evidence/rt3-toolloop.txt`） |
| MCP 资源工具 | `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` 两版都在 |

### 2.4 Session / Context

| 项 | RC.1 |
|---|---|
| 会话落盘 | `$DSH_HOME/sessions/<cwd 派生目录>/session-<uuid>/session.v4.jsonl.zstd`（**多 zstd 帧**，单帧解压只有 ~220 字符，需逐帧解码） |
| 会话 id | `session-<uuid>` |
| 恢复 | `--session-id <id>`；未知 id → `exit 1`，`dsh: session "<id>" does not exist`（两版逐字相同） |
| 上下文层 | 系统提示词 + developer 历史 + 工具 schema + 插件注入消息（`<openviking-context source="profile"\|"recall">`） |
| 默认窗口 | `DEFAULT_CONTEXT_WINDOW=1e6`、`DEFAULT_MAX_TOKENS=256e3`（两版都有，证据 `evidence/effort-check.txt`） |

### 2.5 Provider / 模型

| 项 | RC.1 |
|---|---|
| provider 注册包 | **`@deepseek-ai/dsh-llm-deepseek`** 同时负责 provider 身份 + API Key 认证 + 账号认证 |
| provider id | `deepseek-official`（编在包内 `const PROVIDER="deepseek-official"`） |
| 模型 id | `deepseek-flash`、`deepseek-v4-pro` |
| reasoning effort 枚举 | `off` / `low` / `high` / `max`（`ReasoningEffortId`） |
| 小说工坊默认 | `ai/task-settings.mjs` `DEFAULT_PROVIDER='deepseek-official'`；`ai/policy.mjs` `EFFORTS=['off','low','high','max']` |

### 2.6 配置文件与目录

| 对象 | 路径 | RC.1 实况 |
|---|---|---|
| 写作任务 home | `~/.dsh-novel` | profile `novel`；启动器 `profiles/node_modules/@deepseek-ai/dsh` = 0.1.7-rc.1 |
| GUI/Web home | `~/.dsh` | 全局 dsh = 0.1.7-rc.2（**天然形成 RC.1/RC.2 并存**） |
| 插件目录 | `~/.dsh-novel/profiles/novel/node_modules/novel-writing` | **junction → `novel-studio\harness-plugins\novel-writing`（v0.10.0）** |
| Memory 插件 | `~/.dsh-novel/profiles/novel/node_modules/@openviking/dsh-memory-plugin` | **0.5.3**（写作链路唯一在用的版本） |
| OpenViking 服务 | `http://localhost:1933`（`~/.openviking/ovcli.conf`；`api_key: null`、`profile: false`） | `/health` → **200**；服务版本 0.4.21 / CLI 0.4.22.dev0 |

### 2.7 插件依赖契约（RC.1 实测值）

```text
@openviking/dsh-memory-plugin@0.5.3
  engines: node ^22.19.0 || >=24        → 满足（v24.19.0）
  peerDependencies:
    @deepseek-ai/dsh-llm            >=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1
    @deepseek-ai/dsh-mcp-client     >=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1
    @deepseek-ai/dsh-skill-filesystem >=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1
  → 0.1.7-rc.1 与 0.1.7-rc.2 **都在范围内**
  runtime.mjs 内**没有**任何 semver / 版本闸门（rg semver|satisfies|MIN_|SUPPORTED 无命中）→ 不会因宿主小版本变化自锁

novel-writing@0.10.0：无 dependencies / 无 peerDependencies（纯宿主 API + HTTP 回工坊）
```

---

## 3. 小说工坊 → DSH 能力依赖矩阵（RC.1 实测）

| 小说工坊功能 | 依赖的 DSH 能力 | RC.1 接口 | RC.1 行为（实测） | 关键程度 |
|---|---|---|---|---|
| `novel_*` 全部 23 个工具 | Tool Registry + 系统提示词装配 | `ctx.tools.register` | 模型可见 23 个 `novel_*` 工具（共 32 工具），可注册、可调用、结果回填 | Critical |
| 工坊 → dsh 慢通道 | CLI `--profile novel <prompt>` + `--session-id` | `lib/bin.js` | `exit=0`，中位 3097ms，工具循环 3717ms | Critical |
| 长期记忆（写入侧） | Plugin 钩子 `session/event` → `addMessage` | `ctx.on('session/event')` | **实测落库**：OV 侧 `message_count=1~2` | Critical |
| 长期记忆（召回侧） | Plugin 钩子 `agent/pre-step`(`prepend`) → `<openviking-context source="recall">` | `ctx.on('agent/pre-step', ..., {prepend})` | **实测未注入**（commit_count=0，见主报告 §11） | Critical |
| 记忆工具面 | MCP stdio 桥 | `ctx.plugin(@deepseek-ai/dsh-mcp-client, …)` | 第 2 轮请求出现 **15 个** `mcp__openviking__*` | High |
| 上下文装配（工坊侧） | 与 dsh 无耦合（工坊自身 assembler + HTTP 回调） | — | 冒烟 39 组断言全通过 | Critical |
| 文件操作（dsh 侧） | `dsh-tool-fs`（read/write/edit/glob/grep/read_image） | `ctx.tools.register` | 6 个 fs 工具两版都在 | High |
| 子进程 | MCP proxy 启动 | `process.execPath` + stdio | 两版都成功完成 tools/list 握手 | High |
| 会话状态/恢复 | Session JSONL v4 + `--session-id` | `session.v4.jsonl.zstd` | 恢复后消息数=3 且带回上一轮正文 | Critical |
| 权限 | 工具 schema 内 `sandbox_permissions` / `justification` | — | 两版字段都在（RC.2 文案变化，见 API Diff） | Medium |
| 插件发现/加载 | profile 的 `cordis.patch.yml` + `dsh-base` 组合 | — | 同一份 `~/.dsh-novel` 配置：RC.1 合成 97 条 / RC.2 99 条，**ID 删除数 = 0** | Critical |

---

## 4. RC.1 实测运行基线（后续所有对照的参照物）

| 实验 | 命令/方式 | RC.1 结果 | 证据 |
|---|---|---|---|
| dump-config | `--profile novel --dump-config` | exit 0，214ms，97 条 | `evidence/rt1-report.txt` |
| 全 profile 挂载启动 | `--help`（插件真的 apply） | exit 0，3097 / 2881 / 3363ms（中位 **3097**） | `evidence/rt2-boot.txt`、`rt4-timing.txt` |
| 端到端工具循环 | 假 LLM 要求调 `novel_works` | exit 0，3717ms，32 工具，工具结果含作品标题 | `evidence/rt3-*.txt` |
| 长输入（argv） | 28,000 字 | exit 0，3610ms，标记完好无乱码 | `evidence/rt8-run.txt` |
| 长输入（stdin） | 130,000 字 | exit 0，4147ms，139,186B | `evidence/rt8-run.txt` |
| 会话恢复 | `--session-id` 二次运行 | exit 0，消息数=3，带回上一轮用户正文 | `evidence/rt9-run.txt` |
| 未知会话 | `--session-id nope` | exit 1，`dsh: session "nope" does not exist` | `evidence/rt8-run.txt` |
| Memory 落库 | 隔离 home + 专用 peer | session 建立，`message_count=2`，`commit_count=0` | `evidence/rt10-memory-e2e.json`、`rt11-memory-commit.json` |
| 长输出 | 24,000 字回复 | exit 0，3326ms，会话日志解压 81,395 字符，尾部标记完整 | `evidence/rt13-longout.txt` |
| 并发 | 同 home 两进程同时起 | 两进程都 exit 0，各建各的 session | `evidence/rt12-parallel-longout.json` |

---

## 5. 基线固有的"非 stock"事实（必须随结论一起读）

1. **写作链路固定在 RC.1**：`~/.dsh-novel` 的启动器是 0.1.7-rc.1；`~/.dsh`（GUI/Web）是 0.1.7-rc.2。**本次升级不是"换成 RC.2 就好了"，而是宿主并存、按 home 分流**。
2. **全局 RC.2 被本机改过**：`@deepseek-ai/dsh-base/cordis.patch.yml` 被本地追加了 `operation-security` 条目（`requireApprovalForExecute: true`、`requireApprovalForOutput: true`、`scanMaxFiles: 4000`、`enforcedOperations: [PLUGIN_INSTALL, PLUGIN_UPDATE, …]`，注释自述 "built-in infrastructure, not an installable plugin"）；
   被测包 `@deepseek-ai/dsh-operation-security@0.1.7-rc.2` **不在 npm 上（404）**，属本机构建/私有源产物。→ **这不是 stock RC.2 行为**，RC.1 侧无对应物。
3. **Memory 插件三处三种版本**（写作链路只用 0.5.3）：`~/.dsh-novel/profiles/novel` = 0.5.3；`~/.dsh/profiles/web` = 0.5.5；`~/.dsh/profiles/{headless,novel}` 与 `~/.dsh-novel/profiles/novel-sdk` = 0.2.1。
4. **`novel-studio` 工作区有 78 个已修改文件未提交**（上一轮 V2/Golden Novel 的产物）→ 本次审查的"工坊侧"结论基于该工作区当前状态。
5. **长 prompt 走 argv 的硬上限**（工坊自身缺陷，与 DSH 版本无关）：`harness.js` 的 `runHarnessTaskWithProgress` 把整个 prompt 放进 argv，Windows 上限 ~32k，实测 12 万字中文触发 `spawn ENAMETOOLONG`；dsh 支持 `-` 从 stdin 读，工坊未走该路径（✅ 2026-09-25 已修：仅 Windows、仅超长任务文本改走该通道，见 `docs/HARNESS_ARGV_LIMIT_FIX.md`）。

---

## 6. 基线可信度自评

| 结论类型 | 可信度 | 说明 |
|---|---|---|
| RC.1 宿主 API 表面 | **高** | 有 RC.1 源码（含 schema.ts / serialize.ts 等类型与实现）+ 有实测运行 |
| RC.1 运行时行为 | **高** | 14 组隔离实验真实跑过（假 LLM，零计费） |
| RC.1 与 RC.2 的逐包差异 | **高** | 293 包逐字节 + 归一化语义比对，原始 diff 语料保留在 `evidence/pkg-diffs/`（8.0MB / 293 文件） |
| RC.1 与 RC.2 的"上游发布差异全貌" | **中** | RC.2 用 npm 产物、RC.1 用仓库源码；不排除上游有未发布到 npm 的改动 |
| Memory 召回链的绝对能力 | **低（UNKNOWN）** | 见主报告 §11：只证明了"两版一致"，未证明"能召回" |

---

## 7. 证据索引（判断"是否退化"用的原始文件）

```text
.dsh-rc-compat/
  bulk-diff-summary.json / classify2.json / corpus-stats.json     逐包比对与语义分类
  evidence/pkg-diffs/*.diff                                       293 个包的原始 diff（8.0 MB）
  evidence/lib-diff-*.txt                                         主机包 lib/ 逐文件差异
  evidence/bundle-id-diff.txt / dumpconfig.diff / dumpconfig-rc*.txt  组合条目对照（97 → 99，零删除）
  evidence/installed-vs-published.txt / dsh-base-installed-vs-published.diff  全局安装树 vs 官方发布
  evidence/effort-check.txt / llm-provider-ids.txt / llm-deepseek-focus.txt   provider/模型/effort
  evidence/hook-surface.txt                                       钩子表面两版对照
  evidence/rt1..rt14-*                                             运行时实验原始输出
  x-rc2/  npm-rc2/                                                 RC.2 npm 解包与 tgz（证据保留，未清理）
```