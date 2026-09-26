# DSH 0.1.7-rc.1 → 0.1.7-rc.2 小说工坊 / 插件兼容性审查报告

> 审查性质：**只读诊断**（任务第十一节）。未修改 DSH 主体、小说工坊主体、`novel-writing`、Memory 插件、用户现有配置与用户数据。
> 允许的动作只做了三类：建临时隔离环境、写测试脚本、写报告。
> 证据根目录：`novel-studio/.dsh-rc-compat/`（`.gitignore` 已忽略，未提交；RC.2 的 npm 解包与 tgz 作为证据保留）。
> 配套文档：`DSH_RC1_COMPATIBILITY_BASELINE.md` · `DSH_0.1.7_RC1_RC2_API_DIFF.md` · `DSH_0.1.7_RC1_RC2_COMPATIBILITY_MATRIX.md` · `DSH_0.1.7_RC1_RC2_NOVEL_PLUGIN_TEST_REPORT.md` · `RC1_vs_RC2_CAPABILITY_MATRIX.md`
> 状态词只用 **PASS / DEGRADED / BREAKING / UNKNOWN / NOT_APPLICABLE**；没有证据一律 UNKNOWN，绝不把 UNKNOWN 当 PASS。

---

## 1. 总结

**结论一句话：`0.1.7-rc.2` 对小说工坊与两个插件没有功能破坏；能力面上是"等价 + 两点增强 + 两点轻微退化"，没有发现"表面兼容、实际能力缩水"。**

支撑这一结论的四条硬证据：

1. **同一份 `~/.dsh-novel` 配置**在两版下装配出的组合条目是 **97 → 99，条目 ID 删除数为 0**（`evidence/bundle-id-diff.txt`）——凡是写作 profile 依赖的东西一件没少。
2. **模型可见的工具集合逐字相同**：32 个工具（23 个 `novel_*` + 6 个文件工具 + 3 个 MCP 资源工具），两版工具名文件哈希一致（`evidence/rt3-toolnames-rc1.txt` / `rc2.txt`）；端到端 `novel_works` 真调用两版都成功。
3. **MCP 桥在会话中途真的挂上了工具**：第 2 轮请求出现 **15 个 `mcp__openviking__*`**，两版名字集合完全相同（`evidence/rt3` 原始 dump）。
4. **会话恢复、未知会话报错、长文本输入（argv 28k / stdin 130k）逐项一致**，落盘格式 `session.v4.jsonl.zstd` 未变。

两处**增强**（RC.2 更好，不构成风险）：

- 会话中途新增工具时，RC.2 会**显式通告模型**（多注入一条含 `tool_addition` 块的 system 消息），RC.1 是静默出现（`rt3` dump：messages 3 → 4）。
- 子串替换工具改用 `truncateWithoutSplittingSurrogatePair`，**对中文/emoji 正文更安全**。

两处**轻微退化**：

- **冷启动 +≈2.8s**（中位 3097ms → 5866ms），开销来自 RC.2 依赖树本身，与新增插件无关（关掉 `operation-security` 与 `llm-deepseek-account` 后仍 4795ms）。
- **系统提示词 −685 字符**（2715 → 2030），减少的全是**文件工具的使用指导语**，不含小说设定、人物、伏笔、记忆或风格内容。

**未知项（必须如实列出，不得当 PASS）**：MCP 工具的真实回调、Memory 的"commit → 抽取 → 跨 session 召回"闭环绝对能力（两版**一致地**未发生）、钩子顺序、权限真实拦截、MCP 断线重放、真实模型下的生成质量。

---

## 2. 检查范围

### 2.1 对象

| 对象 | 版本/位置 | 说明 |
|---|---|---|
| DSH 宿主 RC.1 | `~/.dsh-novel/profiles/node_modules/@deepseek-ai/dsh` = **0.1.7-rc.1**；源码 `desktop\DeepSeek\deepseek-harness` @ `7e06df2`（tag `dsh-v0.1.7-rc.1`） | 写作任务实际使用的宿主 |
| DSH 宿主 RC.2 | `AppData\Roaming\npm-global\node_modules\@deepseek-ai\dsh` = **0.1.7-rc.2**（283 依赖包） | GUI/Web（`~/.dsh`）使用的宿主 |
| 小说工坊主体 | `novel-studio`（78 个文件有未提交改动） | Node v24.19.0 |
| `novel-writing` 插件 | `harness-plugins/novel-writing` **v0.10.0**，两处 home 均为 **junction 指向同一份代码** | 23 个 `novel_*` 工具 |
| Memory 插件 | 写作用 `~/.dsh-novel/profiles/novel` = **@openviking/dsh-memory-plugin 0.5.3** | 另有 0.5.5 / 0.2.1 在别的 home，不参与写作链路 |
| OpenViking 服务 | `http://localhost:1933`（**未随本次升级变动**，0.4.21 服务 / 0.4.22.dev0 CLI） | 记忆后端 |

### 2.2 覆盖到的接口面

Plugin API · Tool API（注册/调用/Schema/返回值） · MCP（客户端 + stdio 桥 + 工具命名） · Hook · Event · Session（落盘/恢复/格式） · Context（系统提示词与注入层） · Permission（审批字段与文案） · Process（子进程） · File（fs 工具面） · Config（profile 组合与 `--dump-config`） · CLI（`--help`/`--session-id`/`dump-config`） · 环境变量 · 目录与缓存 · 插件发现/加载/依赖解析 · 错误处理 · 恢复/续跑 · 长文本输入输出 · 并发/异步 · 插件依赖契约。

### 2.3 方法（§17 执行原则）

```text
先调查 → 建基线 → 逐包 Diff → 隔离环境实测 → 调用链分析 → 结论
```

- **静态**：293 包逐字节比对 + 8 位内容哈希归一化后语义比对（避免把 rolldown 改名误判为 API 变化）。
- **动态**：24 组隔离实验（24 个测试见测试报告），全部用本地假 LLM，**零计费**；`DSH_HOME` 用 `~/.dsh-novel` 的临时副本，模型侧不接真实 API。
- **不污染**：不碰 3737（小说工坊主实例）与 3080（DSH web）；测试期间在 OV 侧建的 8 个 session 已逐个 HTTP DELETE 并复核消失。

### 2.4 明确不在范围内

DSH 桌面 UI 的像素级回归、DSH 未发布到 npm 的内部包行为、真实模型生成质量打分（需要计费与人工评判）、OpenViking 服务本身的升级影响。

---

## 3. RC.1 基线

完整基线见 `DSH_RC1_COMPATIBILITY_BASELINE.md`。这里只摘本次判断必需的六条：

1. RC.1 **是写作链路的现役宿主**（`~/.dsh-novel`），不是"历史版本"；RC.2 在本机是 GUI/Web 的宿主。两版**并存**，不是替换关系。
2. RC.1 的 provider 注册在 `@deepseek-ai/dsh-llm-deepseek` 内，`PROVIDER="deepseek-official"`；模型 `deepseek-flash` / `deepseek-v4-pro`；effort `off|low|high|max`。
3. RC.1 的 DeepSeek 适配器**拒绝 deferred 工具**：`packages/llm/llm-deepseek/src/serialize.ts:87` → `unsupported('deferred tool loading')`（抛 `UNSUPPORTED_CONTENT`）。
4. RC.1 的工具注册入口 `ctx.tools.register`（`packages/core/tools/src/index.ts:1282`），系统提示词装配 `packages/core/system-prompt/src/index.ts:586`。
5. Memory 插件 0.5.3 的 peer 范围 `>=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1` **同时覆盖 rc.1 与 rc.2**，且插件内部**没有版本闸门**。
6. RC.1 实测基线：冷启动中位 **3097ms**、32 工具、`novel_works` 可调、会话可恢复、长文本 argv 28k / stdin 130k 均可。

---

## 4. RC.2 实际状态

| 维度 | 实测 |
|---|---|
| 启动 | `--profile novel` 与 `--help` 均 exit 0；插件全部 apply（工具面完整） |
| 冷启动 | 中位 **5866ms**（5730/5866/6060），比 RC.1 慢 ≈2.8s |
| 工具面 | **32 个**，与 RC.1 逐字相同 |
| MCP | 第 2 轮出现 15 个 `mcp__openviking__*`，与 RC.1 同名同数 |
| profile 组合 | 99 条（RC.1 97），**零删除**；`llm-deepseek` → `llm-deepseek-api-key`，新增 `llm-deepseek-account` |
| 接线改动 | 唯一实质改动是 `profile-boot` 调 `reportSkippedBundles()`；`--help` 全量文本逐字未变 |
| 新机制 | 工具延迟声明（`defer_loading`）+ 会话中途工具变更通告（`tool_addition`）+ `ToolHistoryProjection` |
| 非 stock 现象 | 本机全局 RC.2 的 `dsh-base/cordis.patch.yml` 被本地追加 `@deepseek-ai/dsh-operation-security`（npm 上 404 的私有包）→ **不是 stock RC.2** |

---

## 5. API 差异

详见 `DSH_0.1.7_RC1_RC2_API_DIFF.md`，此处给结论级摘要：

| 类别 | 结论 |
|---|---|
| **新增** | `ToolUpdate('in-history'\|'addition-only')`、`ToolHistory`、`projectToolUpdates()`、`PreparedLlmCall.toolUpdate?`、`ACCOUNT_QUOTA_EXCEEDED_CODE`、wire 字段 `defer_loading`、`displayReason`、`reportSkippedBundles()`、`ToolHistoryProjection`、`developer/message` 工具增删块、`request/header.startsSeries`；包级新增 `dsh-llm-deepseek-api-key`、`dsh-llm-deepseek-account`、`dsh-util-code-language` 及 cordis 4.x 系列 |
| **删除** | **对小说链路：0**（组合条目零删除、`ctx.*` 零删除、钩子名零删除、provider/模型/effort 零删除、CLI 逐字相同）。三个未在 rc.2 发布的包（`dsh-storage-sqlite` / `dsh-session-snapshot` / `dsh-remote-mock`）不在 novel 组合内 → **UNKNOWN(P3)** |
| **重命名** | provider 注册责任 `dsh-llm-deepseek` → `dsh-llm-deepseek-api-key`（**provider id 仍是 `deepseek-official`**）；`langFromPath` → `dsh-util-code-language`；`generateConfigSchema(NAME, profile, …)` → `(profile, …)`（**公开签名变化**） |
| **参数/Schema** | 见 API Diff 表 D1–D8：内部签名扩展、工具描述文案、`sandbox_permissions` 收紧、`justification` 语言要求、`time-context.refreshIntervalMs` 默认 10 分钟 |
| **返回值** | 未发现结构变化（工具结果、错误结构一致） |
| **行为** | E1–E10：deferred 工具从"拒绝"变"支持"、中途新增工具会通告模型、`startsSeries` 条件收紧、大回合超大回复的收尾行为 |

---

## 6. Plugin 差异

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| 插件框架 | cordis 3.x/内嵌 | **cordis 4.0.4** + plugin-group/include/loader/timer | 插件 API 表面未变（`ctx.on/provide/effect/plugin/tools/logger/skills` 全在） |
| 插件发现/加载 | profile `cordis.patch.yml` | 同 | **零条目删除** |
| 依赖解析 | pnpm hoisted（profile 内 `node_modules`） | 同机制（`healProfilesModuleFallback` 会重建） | 隔离副本实测两版都能挂上插件 |
| `novel-writing@0.10.0` | 23 工具 | 同（同一份 junction 代码） | **PASS** |
| `@openviking/dsh-memory-plugin@0.5.3` | 加载、`ctx.provide('openvikingMemory')`、钩子全在 | 同 | **PASS**（召回链绝对能力见 §11） |
| 插件依赖包逐字节 | — | `dsh-mcp-client`、`dsh-skill-filesystem`、`dsh-system-prompt` 等 **sem=0（无语义变化）** | **PASS** |

---

## 7. Tool 差异

| 项 | RC.1 | RC.2 |
|---|---|---|
| 工具总数与集合 | 32 | **32，逐字相同** |
| `novel_*` | 23（blueprint/chapter_save/consistency/context/contract/event_add/events/foreshadow_update/foreshadows/lookup/memory_read/memory_update/preflight/review/scan/snapshot/state/state_commit/state_propose/style_contract/validate/works/write_pipeline） | 同 |
| 文件工具 | read / write / edit / glob / grep / read_image | 同 6 个，**描述文案缩短** |
| MCP 工具 | 第 2 轮 15 个 `mcp__openviking__*` | 同，**且带 `defer_loading: true`** |
| Tool 注册契约 | `ctx.tools.register({name, description, parameters, execute, deferLoading?})` | 未变 |
| 返回值/错误 | 工具结果结构一致 | 未发现变化 |

**唯一实质差异**：RC.2 给"会话中途新增"的工具加 `defer_loading` 并在历史里插一条工具新增通告；对小说链路无功能影响（首轮请求的工具面完全一致）。

---

## 8. MCP 差异

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| 桥的归属 | `@deepseek-ai/dsh-mcp-client`（随 dsh 本体发布，插件无需单独装） | 同 | 无变化 |
| 配置类型 | `{transport:'stdio', serverName:'openviking', command: process.execPath, args:[mcp-proxy.mjs], env, toolCallTimeoutMs}` | 同 | 无变化 |
| 工具命名 | `mcp__openviking__<name>` | 同 | **无变化** |
| 实测注册结果 | 15 个工具（第 2 轮） | 15 个，**名字集合相同** | **PASS** |
| 首轮可见性 | 不可见（桥 `apply` 不 await） | 同 | 两版一致 |
| **真实回调** | **未测** | **未测** | **UNKNOWN**（只有"能启动 + 能列工具"的证据，没有"能调用并回收结果"的证据） |
| 断线降级 | 插件自述 recall/capture 不受影响 | 同 | 未做故障注入 → 子项 UNKNOWN |

---

## 9. Context 差异

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| 系统提示词长度 | **2715 字符** | **2030 字符（−685）** | **DEGRADED（轻微）** |
| 减少的内容 | — | 4 条 fs 工具指导语变短（`read` 去掉 "Results include line numbers."；`write`/`edit`/`glob` 长句精简）+ `edit.old_string` 去掉 "Must match exactly." + `read_image` 精简 | **不含小说设定/人物/伏笔/记忆/风格** |
| 上下文层结构 | 系统提示词 + developer 历史 + 工具 schema + 插件注入消息 | 同 | PASS |
| 注入标记 | `<openviking-context source="profile"\|"recall">` 语法 | 同 | PASS |
| 时间上下文 | `refreshIntervalMs` 未设 = 不自动刷新 | **默认 10 分钟自动刷新** | P3（单轮任务内影响≈0） |
| 中途新增工具对上下文的影响 | 无通告 | 多一条含 `tool_addition` 的 system 消息 | **增强** |

---

## 10. Session 差异

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| 落盘格式 | `sessions/<cwd 派生>/session-<uuid>/session.v4.jsonl.zstd` | 同（多 zstd 帧） | **PASS** |
| 会话 ID 形态 | `session-<uuid>` | 同 | PASS |
| `--session-id` 恢复 | exit 0，**消息数=3**，带回上一轮用户正文 | **完全相同** | **PASS** |
| 未知 ID | exit 1 + `dsh: session "…" does not exist` | **逐字相同** | PASS |
| 事件结构 | — | 新增 `developer/message`、`request/header.startsSeries`（**只增不改**） | PASS（向后兼容：v3→v4 迁移有专门守卫） |
| 跨调用状态 | 保持 | 保持 | PASS |

---

## 11. Memory 差异（本次最需要如实说明的一节）

**做了什么**：用隔离 home + **专用 peer**（`rc-compat-e2e-*` / `rc-compat-commit-*`，不碰作者记忆）跑了两轮对照：
(A) 写入 → 直接问 OV 服务器确认落库；(B) 新 session 提同一事实 → 看是否注入召回块；
又把 commit 阈值降到 1000、提示词加到 4102 字再跑一遍。

**结果（两版逐项一致）**：

| 观察点 | RC.1 | RC.2 |
|---|---|---|
| session 在 OV 侧建立 | ✅ `POST /api/v1/sessions` 成功 | ✅ 同 |
| 消息落库（capture） | ✅ `message_count=2` | ✅ `message_count=2` |
| commit（记忆抽取前提） | ❌ `commit_count=0`、`pending_tokens=0` | ❌ 同 |
| `memories_extracted` | 0 | 0 |
| 召回块 `<openviking-context source="recall">` | 未出现 | 未出现 |
| `source="profile"` | 未出现 | 未出现 |
| 直接查 OV 检索（`/api/v1/search/find`） | 找不到测试标记 | 同 |

**判断**：

- **版本兼容性：一致（PASS）**——两版行为逐项相同，**RC.1→RC.2 没有记忆能力下降**。
- **绝对能力：UNKNOWN**——本次没有证明"写作链路的一次性 headless 任务能产出可召回记忆"。成因指向**两版共有**的机制：`maybeCommit` 只在 `turn/end` 且 `pending_tokens ≥ 20000`（默认）时 commit；一次性任务到不了阈值，进程也没有 orderly 的 session dispose 提交。**这是既有特性，不是 rc.2 引入的退化。**
- 与工坊侧的 OpenViking 集成（`openviking-sync.js` → 资源库）是**两条独立路径**：OV 里作者作品的资源（如 `viking://user/default/resources/novel-studio/...`）是工坊链路写的，与 dsh 记忆插件无关。

---

## 12. Permission 差异

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| 工具 schema 字段 | `sandbox_permissions` + `justification` | 同字段都在 | PASS |
| `sandbox_permissions` 描述 | "The wider sandbox mode this file operation needs…" | "The **narrowest wider** sandbox mode for a one-shot retry of the exact operation the sandbox just denied…" | 语义收紧 |
| `justification` 描述 | 无语言要求 | 追加 "**Use the language of the user's current request.**" | 新增要求 |
| 审批气泡 | 无 `displayReason` | 新增透传字段 | P3 增强 |
| stock 权限模型 | — | 未发现新增硬限制 | PASS |
| **本机非 stock 层** | 无 | `dsh-base` 挂 `@deepseek-ai/dsh-operation-security`（`requireApprovalForExecute/Output: true`，`enforcedOperations: [PLUGIN_INSTALL, PLUGIN_UPDATE, PLUGIN_ENABLE, PLUGIN_UNINSTALL, EXPORT, PUBLISH]`） | **必须在决策里单列**：非 stock、写作 profile 无关、GUI/Web 生效 |
| 真实拦截行为 | 未测 | 未测 | **UNKNOWN** |

---

## 13. Process / File 能力差异

**Process**

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| 起子进程（MCP stdio proxy） | 成功（15 工具即证据） | 成功 | **PASS** |
| 附件模式（`--profile novel` headless） | 成功 | 成功 | PASS |
| 并发两进程 | 都 exit 0 | 都 exit 0 | PASS |
| 120k 字回复时进程不退出 | 复现 | 复现（关 Memory 亦同） | **两版一致，UNKNOWN(成因)** |
| 环境变量继承差异 | 未单测 | 未单测 | UNKNOWN |

**File**

| 项 | RC.1 | RC.2 | 判断 |
|---|---|---|---|
| fs 工具面 | read/write/edit/glob/grep/read_image | 同 | PASS |
| 路径范围 | 未发现变化 | 未发现变化 | PASS |
| 中文安全 | — | 子串替换改用 `truncateWithoutSplittingSurrogatePair` | **增强** |
| 真实读写断言 | 未做 | 未做 | 子项 UNKNOWN |

---

## 14. 小说工坊兼容性

### 14.1 调用链逐层判定（§7）

```text
用户操作 → 小说工坊(server.js, HTTP/DB) → harness.js 组装 prompt → dsh CLI(--profile novel)
        → Plugin API(cordis) → novel-writing 的 ctx.tools.register / Memory 的 ctx.on
        → Tool / MCP → dsh Runtime → 实际执行 → 结果回填 → 工坊落库
```

| 层 | RC.1 | RC.2 | 变化点 | 兼容层 | 隐性行为变化 | 需要插件改 | 只需配置迁移 | 需要回滚 |
|---|---|---|---|---|---|---|---|---|
| 工坊 HTTP/DB | 正常 | 正常（与 dsh 版本无关） | 无 | — | 无 | 否 | 否 | 否 |
| `harness.js` → dsh 启动 | 正常 | 正常 | 无（`resolveDshLaunch`/`--profile`/`--session-id` 语义未变） | — | 无 | 否 | 否 | 否 |
| Plugin API 层 | 正常 | 正常（cordis 4.0.4） | 框架包版本；API 表面未变 | — | 无 | 否 | 否 | 否 |
| Tool 注册/执行 | 32 工具 | 32 工具（逐字相同） | 无 | — | 无 | 否 | 否 | 否 |
| MCP 桥 | 15 工具注册 | 15 工具注册 + `defer_loading` + 通告 | 声明方式 | — | 有（增强） | 否 | 否 | 否 |
| Memory 钩子 | 落库成功 | 落库成功（逐项一致） | 无 | — | 无 | 否 | 否 | 否 |
| Session/恢复 | 正常 | 正常 | 无 | — | 无 | 否 | 否 | 否 |

### 14.2 工坊"慢通道"的已知硬伤（与版本无关，但影响真实用户）

`harness.js` 的 `runHarnessTaskWithProgress` 把整个 prompt 放进 **argv**；Windows argv 上限约 32k，实测 12 万字中文触发 `spawn ENAMETOOLONG`。
dsh 两版都支持 `-` 从 stdin 读取提示词，工坊**没有走这条路**。→ 属**工件自身缺陷（P2）**，建议单独修（不在本次升级范围）。

> ✅ **2026-09-25 已修**：该 P2 项已单独修复并验证——**仅 Windows、仅任务文本超过安全余量时**改走
> `dsh … -` + stdin（短/中文本继续走 argv，逐字不变）。报告与证据：`docs/HARNESS_ARGV_LIMIT_FIX.md`、
> `.dsh-rc-compat/rt15-argv-limit.mjs` / `rt16-real-dsh-stdin.mjs`。上面的段落保留为**当时的现场记录**。

### 14.3 三级优先级核对（§16）

1. 工坊能否启动 —— **能**（隔离实例 + 真实实例均正常）
2. 核心插件能否加载 —— **能**
3. `novel_*` 能否注册和调用 —— **能**（端到端验证过）
4. Memory / MCP 是否正常 —— **MCP PASS；Memory 写入 PASS、召回链 UNKNOWN（两版一致）**
5. Context / Session 是否正常 —— **正常**
6. File / Process / Hook 是否正常 —— **File/Process PASS（子项 UNKNOWN）；Hook 名 PASS（顺序 UNKNOWN）**
7. 数据与状态兼容 —— **兼容**（零条目删除、会话格式未变、恢复一致）
8. 长文本创作 —— **PASS（24k 输出 / 130k 输入）**；120k 单条输出两版都不退出（UNKNOWN，超出正常范围）
9. Recovery —— **PASS**（`--session-id` 一致；插件内部状态恢复未测）
10. 非核心差异 —— UI/account/schedule 等见 API Diff（不影响小说链路）

---

## 15. 插件兼容性

| 插件 | 结论 | 依据 |
|---|---|---|
| `novel-writing@0.10.0` | **PASS，无需适配** | 23 工具两版逐字相同；端到端调用成功；组合条目零删除；peer/依赖未变 |
| `@openviking/dsh-memory-plugin@0.5.3` | **PASS（兼容），无需适配；含 UNKNOWN 子项** | peer 范围同时覆盖 rc.1/rc.2；`ctx.*`/钩子名全在；无版本闸门；写入实测一致；**召回链绝对能力 UNKNOWN** |
| Memory 0.5.5 / 0.2.1（其他 home） | 未测 | 不在写作链路，标 NOT_APPLICABLE |

---

## 16. 调用能力变化

见 `RC1_vs_RC2_CAPABILITY_MATRIX.md`（19 项）：**16 项 PASS（含轻微文案/增强）、1 项轻微 DEGRADED（Context）、1 项 NOT_APPLICABLE（Shell）、0 项 BREAKING**，4 项带 UNKNOWN 子项。

---

## 17. 实际测试结果

24 个测试的逐项表（名称/环境/目的/RC.1/RC.2/差异/日志/状态）在 `DSH_0.1.7_RC1_RC2_NOVEL_PLUGIN_TEST_REPORT.md`。要点：

- **工程侧**：`novel-writing` 冒烟 **39 组全通过**；工坊 `api-test-suite` **186/190 通过、0 失败、4 主动跳过**。
- **宿主侧**：22 组 dsh 对照实验，全部用隔离 home + 假 LLM；唯一"红色"是 T15（120k 字回复两版都不退出）。
- **清理**：OV 侧 8 个测试 session 已 DELETE 并复核；进程树已回收。

---

## 18. Breaking Changes

**对小说工坊 / `novel-writing` / Memory 插件：无 P0/P1 破坏。**

以下三条**不是**小说链路的破坏，但必须记录：

| 级别 | 项 | 影响对象 | 说明 |
|---|---|---|---|
| P3 | `generateConfigSchema(binName, profile, …)` → `(profile, …)` | 调用该工具函数的第三方 | 公开导出签名变化；小说工坊不使用 |
| P3 | provider 注册责任由 `dsh-llm-deepseek` 搬到 `dsh-llm-deepseek-api-key` | 手写 profile 补丁引用老包名者 | 老包仍在，**能加载但不再注册 `deepseek-official`** —— "API 没变但行为变了"的典型 |
| P3/UNKNOWN | `dsh-storage-sqlite` / `dsh-session-snapshot` / `dsh-remote-mock` 未在 rc.2 发布 | 用到这三包的 profile | 三者都不在 novel 组合内 |

---

## 19. Degraded Changes

| 级别 | 项 | 量化 | 真实用户影响 | 是否必须处理 |
|---|---|---|---|---|
| P2 | **冷启动 +≈2.8s**（3097 → 5866ms） | 每次慢通道任务 | 会感知"变慢"，但生成内容不变 | 建议观察；不是升级阻塞项。可用固定 RC.1 宿主规避 |
| P3 | **系统提示词 −685 字符**（fs 工具指导语缩短） | 2715 → 2030 | 对小说生成几乎无影响（不是设定/记忆/风格内容） | 不需要 |
| P3 | `time-context` 默认 10 分钟自动刷新 | 单轮任务内无差异 | 长会话可能出现时间戳刷新 | 不需要 |
| P3 | 工具审批文案变化 | — | 提示措辞更严格更清晰 | 不需要 |
| P3（工件自身） | 工坊把 prompt 放 argv，Windows ~32k 上限 | 12 万字实测 `spawn ENAMETOOLONG` | 长章/长上下文走慢通道会**硬失败** | ✅ **2026-09-25 已在工坊侧修掉**（仅 Windows、仅超长时改用 stdin `-`；见 `docs/HARNESS_ARGV_LIMIT_FIX.md`） |

---

## 20. Unknown

```text
1. MCP 工具的真实回调链（模型→mcp__openviking__*→OV→模型）        —— 只证了注册，未证调用
2. Memory commit→抽取→跨 session 召回的绝对能力                    —— 两版一致地未发生（既有特性）
3. 钩子注册顺序的 A/B                                              —— 只核对了钩子名存在
4. 权限系统的真实拦截行为                                          —— 只核对了 schema 字段与文案
5. MCP 断线后的 pending 队列重放                                   —— 未做故障注入
6. 真实模型下的生成质量（本次全为假 LLM）                          —— 需计费与人工评判
7. 120k 字单条回复为何两版都不退出（已排除 Memory 因素）            —— 成因未定
8. 三个未在 rc.2 发布的包是否真的被上游废弃                        —— 本机 GitHub 不可达
9. 高并发压力下的表现（本次只测了 2 进程并发）                      —— 上限未知
10. RC.2 桌面 UI 侧（account/onboarding/schedule 等 20+ 包）的实际体验 —— 仅有产物级差异
```

---

## 21. 修复建议

**针对小说链路（都不阻塞）**

1. **不改宿主、不改插件**即可继续用 RC.1 跑写作；若要切到 RC.2，先接受 +2.8s 冷启动。
2. **工坊侧修 argv 上限（P2，强烈建议）**：`harness.js` 的 `runHarnessTaskWithProgress` 对超长 prompt 改走 `dsh -` 的 stdin 通道（两版都支持），消除 `spawn ENAMETOOLONG`。这是一条**独立于本次升级的真实缺陷修复**。✅ **已于 2026-09-25 执行并验证**：`docs/HARNESS_ARGV_LIMIT_FIX.md`（离线契约 49/49、通道逐字一致、EPIPE 阴性对照与变异对照、真 dsh 端到端）。
3. **不要手写 `name: '@deepseek-ai/dsh-llm-deepseek'` 的补丁条目**：在 RC.2 上它能加载但不会注册 `deepseek-official`。如需自定义 provider，请引用 `-api-key` / `-account` 包。
4. **如要保留 `operation-security`**：它依赖本机私有包（npm 404），换机器/重装会消失 → 建议把它做成显式可安装的插件或写进安装脚本，否则"权限收紧"会静默失效（这是一条**安全一致性风险**，不是小说链路问题）。
5. **Memory 召回链若要真用**：先单独验证"commit 是否发生"。在工坊的一次性任务模型下，默认 20000 token 阈值 + 无 orderly dispose 很可能永远不 commit；若需要跨会话记忆，应在插件配置里显式降低阈值或在工作流里加一次显式 commit（**属于插件/工坊的既有设计问题，不是升级引入**）。

**针对审查本身**

6. 下一步若要闭环 §20 的 1/2/4/5，需要：真实（或脚本化多轮）模型调用、带故障注入的 MCP 断线用例、以及人工生成质量对照——**本次受"零计费 + 只读"约束未做**。

---

## 22. 是否需要插件适配

**否。**
`novel-writing@0.10.0` 与 `@openviking/dsh-memory-plugin@0.5.3` 都不需要为 rc.2 做适配：工具面逐字相同、钩子名全在、peer 范围同时覆盖两版、组合条目零删除、端到端可跑。
唯一的"如果"是 Memory 的召回链——那是**两版都存在的既有特性**，不是升级适配问题。

---

## 23. 是否需要 DSH 侧兼容层

**否（对小说链路）。**
RC.2 对写作 profile 是**纯增量**：组合条目只增不减、工具集合一致、会话格式未变、CLI 逐字相同。
需要留意但不是"兼容层"级别的是两条**使用约定**：

1. 手写补丁不要引用老 provider 包名（老包在、但不注册 provider）；
2. `generateConfigSchema` 的调用方去掉首参。

---

## 24. 是否建议保持 RC.1

**建议：写作链路继续钉在 RC.1，直到下列任一条件成立再切 RC.2。**

| 条件 | 理由 |
|---|---|
| 需要 RC.2 的新能力（中途新增工具的通告、`defer_loading`、账号登录通道、opsec 等） | 这些对小说链路不是刚需 |
| 愿意接受 +2.8s 冷启动 | 这是目前唯一可感知的退化 |
| 先修掉工坊侧的 argv 上限（P2） | 否则长 prompt 在慢通道上仍会硬失败（与版本无关） |

反过来，**没有任何证据表明 RC.1 存在必须升级的安全/数据风险**；本次审查未发现 RC.2 修复了小说链路上的缺陷。

---

## 十三、最终结论必须回答的 10 个问题

1. **`0.1.7-rc.2` 是否仍然兼容小说工坊？**
 **是。** 启动、工具注册与调用、MCP 注册、会话恢复、长文本输入输出、并发两进程全部实测通过；组合条目零删除。

2. **哪些小说工坊功能完全兼容？**
 `novel_*` 全部 23 个工具（注册/调用/结果回填）、工坊→dsh 启动接线、会话创建与恢复、长文本输入（argv 28k、stdin 130k）、长文本输出（24k）、并发调用、MCP 工具注册（15 个）、插件加载与依赖解析、错误提示文案。**证据**：§17 的 T01–T24。

3. **哪些功能能力下降？**
 ① 冷启动 +≈2.8s（中位 3097 → 5866ms，P2）；② 系统提示词 −685 字符（全为 fs 工具指导语，P3）；③ `time-context` 默认 10 分钟刷新（P3）；④ 公开导出 `generateConfigSchema` 去掉 `binName`（P3，小说链路不用）。**没有能力被删除。**

4. **哪些功能已经破坏？**
 **对小说工坊/两个插件：无（0 个 BREAKING）。** 另有 3 个未在 rc.2 发布的包（`dsh-storage-sqlite`/`dsh-session-snapshot`/`dsh-remote-mock`）标 UNKNOWN(P3)，且都不在 novel 组合内。

5. **哪些插件出现兼容问题？**
 **没有。** `novel-writing@0.10.0` 与 `@openviking/dsh-memory-plugin@0.5.3` 均无兼容问题；后者带一个"两版一致"的 UNKNOWN 子项（召回链绝对能力）。

6. **`novel-writing` 是否需要适配？**
 **否。**

7. **`@openviking/dsh-memory-plugin` 是否需要适配？**
 **否。**（若要真正启用跨会话召回，需要的是**配置/流程**调整——降低 commit 阈值或显式 commit——不是 rc.2 适配。）

8. **是否存在 DSH API Breaking Change？**
 **对小说链路：无。** 全局层面有两处第三方可见变化：`generateConfigSchema` 签名（P3）、provider 注册包搬迁（P3 隐性）。另注意本机 `dsh-base` 的 `operation-security` 属**非 stock 定制**，不是上游 API 变化。

9. **是否存在"API 没变但行为变了"的隐性兼容问题？**
 **有两条，且都不冲击小说链路：**
 ① `@deepseek-ai/dsh-llm-deepseek` 在 rc.2 仍能加载，但**不再注册 `deepseek-official`**（provider 身份搬到了 `-api-key` 包）——手写补丁若引用老包名会"看似生效、实际没有 provider"；
 ② 会话中途新增工具时，rc.2 会**额外注入一条 system/developer 消息**并在 wire 上使用 `defer_loading`（rc.1 是静默出现）。实测对小说链路是**增强**而非退化。

10. **从 RC.1 → RC.2 是否需要建立专门的兼容层 / 适配层？**
 **否。** 建议用"两条使用约定"替代兼容层：手写补丁引用 `-api-key`/`-account` 包；`generateConfigSchema` 调用方去掉首参。

---

## 十八、最终报告结论格式

```text
【整体状态】        DEGRADED（核心链路全通；可感知退化仅冷启动 +2.8s 与系统提示词 −685 字符）
【小说工坊】        PASS
【novel-writing】   PASS
【Memory Plugin】   PASS（兼容性一致；含"召回链绝对能力"UNKNOWN 子项）
【DSH Plugin API】  PASS（框架升 cordis 4.x，API 表面未变；另有 1 处公开签名变化属 P3）
【Tool 调用能力】   PASS（32 工具逐字相同；端到端调用成功）
【MCP】             PASS（15 个 mcp__openviking__* 两版同名同数；真实回调未测 → 子项 UNKNOWN）
【Context / Session】PASS（会话格式/恢复/报错逐字一致；上下文层结构未变）
【Recovery】        PASS（--session-id 恢复两版一致；插件内部状态恢复未测 → 子项 UNKNOWN）
```

```text
必须修复：
  （对小说链路）无。
  （对工坊本身，与版本无关但影响真实用户）harness.js 超长 prompt 走 argv 触发 spawn ENAMETOOLONG
  —— 建议改用 dsh 的 stdin（'-'）通道；属既有缺陷，本次审查未修（只读诊断），
  ✅ 2026-09-25 已单独修复（仅 Windows、仅超长任务文本；见 docs/HARNESS_ARGV_LIMIT_FIX.md）。

建议修复：
  1) 手写 profile 补丁改引用 @deepseek-ai/dsh-llm-deepseek-api-key（或 -account），不要引用老包名；
  2) 调用 generateConfigSchema 的第三方代码去掉首参 binName；
  3) 把本机私有的 @deepseek-ai/dsh-operation-security 变成显式可安装项，否则权限收紧会静默失效；
  4) 若要启用跨会话记忆：显式降低 commit 阈值或在流程里显式 commit。

可以兼容：
  小说工坊全部 23 个 novel_* 工具、MCP 桥、会话与恢复、长文本输入输出、并发调用、
  novel-writing@0.10.0、@openviking/dsh-memory-plugin@0.5.3、旧作品/旧会话数据。

暂无法确认：
  1) MCP 工具真实回调链；2) Memory commit→抽取→召回闭环；3) 钩子顺序；
  4) 权限真实拦截；5) MCP 断线重放；6) 真实模型生成质量；
  7) 120k 字单条回复不退出（已排除 Memory 因素）；8) 三个未发布包是否被上游废弃；
  9) 高并发上限；10) RC.2 桌面 UI 侧实际体验。
```

```text
RC.1 → RC.2 是否存在兼容性下降：      是（仅两处轻微：冷启动 +≈2.8s、系统提示词 −685 字符；
                                          未发现功能删除或破坏，故不判为 BREAKING）
是否需要小说工坊适配：                否
是否需要插件适配：                    否
是否需要 DSH 兼容层：                  否（用两条使用约定替代）
```