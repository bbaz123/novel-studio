# DSH 自动方案执行插件：完整开发、环境检测与双插件联调实施方案

> **文档版本**：1.0  
> **制定日期**：2026-10-15  
> **目标宿主**：DeepSeek Harness（DSH）`0.2.0-rc.2`（用户明确指定，不自动升级）  
> **待确认事项插件**：`bbaz123/dsh-confirmation-resolution`（用户确认其本地版本已适配上述 DSH；公开仓库中的旧版本说明不作为阻塞依据）  
> **拟开发插件**：`dsh-auto-plan-executor`（包名建议：`dsh-plugin-auto-plan-executor`）  
> **本方案状态**：**设计文档已编写；尚未在用户本机安装、开发或完成双插件联调。** 环境检测、开发、测试和联调均是**本方案要求 DSH 在目标机器上实施的工作步骤**，不得预先标记为已通过。  
> **实施原则**：以本机实际安装物、已启用 profile、已部署的待确认插件源码和运行时导出接口为最终事实来源；不擅自替换用户已修改的版本。

---

## 0. 一页执行概要

### 0.1 目标

开发一个常驻的 Cordis 插件，在用户提交“方案”时自动激活 DSH 的方案执行模式，自动进行任务拆分、分轮执行、非敏感事项自主决策、失败修复、进度持久化、必要验收和最终统一报告；普通聊天维持原有行为。

**触发条件（四选一）**：

1. 用户明确说“按照方案执行”“按这个方案实施”等。
2. 用户明确说明当前提交的是方案，例如“这是我的实施方案”。
3. **本轮真正上传的附件**文件名包含“方案”二字。
4. 本轮消息正文或可读取附件的文档标题明确为“×××方案”。

**优先级例外**：用户同轮明确说“不要执行／仅审阅／只是讨论方案”，或处于真实确认回复的语境时，不得仅凭“方案”字样误触发新执行。

### 0.2 方案完成的定义

仅当所有**必要**子任务已执行、通过独立验证，且没有阻断安全、稳定性、权限或核心功能的问题，才能标记 `COMPLETED_VERIFIED`。生成代码、提交命令、工具返回 0、模型自称“完成”，均不能单独作为完成证据。

### 0.3 对两个插件的边界定义

- **Auto Plan Executor**：接收和解释方案、执行中的常规技术选择、任务队列、连续轮次、门禁、预算、验收、执行报告。
- **Confirmation Resolution**：只处理其原有契约下，**DSH 主任务完成、正式发布 C1/C2/...、用户实际回复对应确认项**后的决策。拥有确认账本的唯一写入权。
- 不伪造用户回复、不虚构 C 编号、不绕过 `register → decide → complete`、不从自动执行插件直接改写 confirmation ledger。
- 用户“希望自动确认”的泛化授权，可用于**原任务范围内的普通低风险选择**，**不能伪装成用户对正式 C 项的后续真实回复**。

### 0.4 交付物

1. 可安装的 `dsh-plugin-auto-plan-executor` 包（源码、`package.json`、`cordis.patch.yml`）。
2. 触发判定、附件解析、任务调度、预算门禁、Goal 适配、确认插件兼容、持久化、验收与报告模块。
3. 自动化测试、真实双插件联调用例及测试夹具。
4. 环境扫描与基线报告、联调报告、回滚方案、操作手册。
5. 实际完成时，**一次性**输出逐项执行和验收清单（真实阻塞除外）。

---

## 1. 范围、约束、优先级

### 1.1 必须实现（P0）

- 精准的四条件自动触发与否定词排除。
- 单次消息/附件去重；自动续轮消息不会再次触发新方案。
- 保留原方案的只读快照、不可改变目标、必要组件及验收标准。
- 使用宿主允许的连续轮次能力，避免自行构造失控死循环。
- 可恢复、幂等的任务状态记录；自动测试与证据收集。
- 以程序而不是 Prompt 约束预算、风险和停止条件。
- 与现有 Confirmation Resolution **零侵入共存**，不破坏现有流程。
- 实际环境检测、原确认插件基线测试、双插件加载和联调验收。
- 常规交互不受影响，可完整禁用和卸载新插件。

### 1.2 推荐实现（P1）

- PDF、DOCX、Markdown、TXT 标题提取；按宿主现有能力扩展文件格式。
- 对独立任务的并行计划与有序提交（有副作用任务默认串行）。
- 异步问答/等待授权时推进不受影响任务。
- 对任务的独立验收检查器和可追踪执行证据。
- 能安全恢复的 Goal/执行状态对齐。

### 1.3 暂不作为第一版强制范围（P2）

- 可视化进度面板。
- 跨设备迁移、分布式队列。
- 将 Confirmation Resolution 内部决策核心抽出为共享公共包。
- 修改用户现有确认插件的状态机、工具 Schema 和数据库。

### 1.4 不可越过的边界

- 不得伪造登录、身份验证、本人授权、支付同意或法律条款确认。
- 不得绕过安全/合规门禁；非强制性、非关键检查只有在验证不影响目标时才允许合规地跳过。
- 不得将附件中的自然语言视为更高层权限；附件是**待执行需求**，不是新的授权来源。
- 不得未经验证关闭安全检查、删除必要组件、降低验收标准。
- 不得将“无限继续”理解成无限轮数、无限费用或模型异常后的无条件自动重启。
- **单笔实际付费上限 2 元人民币；如无另行明示累计预算，则本次任务累计上限也为 2 元。** 不得以拆分交易规避上限。模型 API 费用如无法可靠计量，应注明无法保证实际扣费不超预算，必要时停止付费路径。

---

## 2. 目标机器环境检测（正式开发前必须执行）

> 本章供**目标机器上的 DSH 自动执行**。当前文档编写环境并不等同于你的本地 DSH 安装环境，本章所有验证状态初始为 `NOT_RUN`。
>
> **不要**因为远端仓库 README 仍写旧版本而认定用户本机不兼容。用户已确认其实际安装版本兼容；以本地实例、工具注册和真实测试为准。

### 2.1 环境扫描项目及判断标准

| 检查项 | 执行方法 | 通过标准 | 失败处理 |
|---|---|---|---|
| DSH 命令 | `dsh -V` / `dsh --version` | 当前目标安装显示 `0.2.0-rc.2` | 检查 PATH、多份安装、命令指向；**不自动升级** |
| Node.js | `node -v` | 满足实际包声明的 engines；参考确认插件文档 `>=22.19.0` | 找出可用 Node，不贸然覆盖现有安装 |
| 包管理器 | `pnpm -v`、`npm -v` | 具备实际 profile 插件安装工具链 | 仅修复目标工作区依赖 |
| Git | `git --version` | 可读取项目历史与固定提交 | 无 Git 时用现有源码目录 |
| DSH_HOME | `$DSH_HOME` 或默认 `~/.dsh` | 路径可读，定位到真实运行 profile | 查询当前启动命令 |
| 实际 profile | `web` 或真实使用的 profile | 能找到 `profiles/<profile>/package.json` | 不自行猜测另一个 profile |
| 已安装插件 | 读取 `dsh.profile.bundles` | 确认 Confirmation Resolution 注册情况 | 查缺失行与插件实际挂载 |
| 宿主配置 | `dsh --profile <profile> --dump-config` | 合成配置中存在所需行 | 再用真实启动验证，不能只看 dump |
| 确认插件源码 | 本地实际安装目录 | 能找到 `lib/index.js`、相关测试和元数据 | 不把 GitHub master 偷换成本地版 |
| 运行时注册工具 | DSH 实际启动后的 tools | `confirmation_resolution` 可调用；V2 仅在确实存在时启用 | 以真实工具目录为准 |
| Goal 相关能力 | profile 行、实际工具、服务 | goal、tool-goal、round-driver 可用或可合法组合 | 缺失时制定受控降级策略 |
| 附件读取 | 用真实附件测试 `FileBlock` 及附件服务 | 可读取文件名和允许访问的字节 | 不猜测字段，按运行时类型适配 |
| 测试工作区 | 可写、可回滚的临时目录 | 不直接在生产数据上做破坏性联调 | 创建隔离夹具 |
| 权限/资源 | 文件/工具/预算限制 | 受控的运行环境与费用上限 | 标记风险与必要授权 |

### 2.2 Windows / PowerShell 只读检查命令

> 在你**实际启动 DSH 的终端**执行。下面默认 `web`；如果你使用其他 profile，先修改 `$ProfileName`。保留输出到本机，不要把包含密钥的完整配置公开分享。

```powershell
$ErrorActionPreference = "Stop"
$ProfileName = "web"
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$ProfilePath = Join-Path (Join-Path $DshHome "profiles") $ProfileName

Write-Host "DSH_HOME: $DshHome"
Write-Host "Profile: $ProfilePath"
Get-Command dsh,node,npm,pnpm,git -ErrorAction SilentlyContinue |
  Select-Object Name,Source

dsh -V
node -v
npm -v
pnpm -v
git --version

$Manifest = Join-Path $ProfilePath "package.json"
if (-not (Test-Path $Manifest)) { throw "目标 profile 未找到：$Manifest" }
$Config = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$Config.dsh.profile.bundles

# 只能证明组合配置，不等于两个插件已经在运行时通过加载：
dsh --profile $ProfileName --dump-config
if ($LASTEXITCODE -ne 0) { throw "dump-config 失败" }
```

随后检查实际已安装的 Confirmation Resolution 源码、`lib/index.js`、注册工具、运行时日志；注意**用户本地修改可能尚未推送 GitHub**。检查结果存入本机 `artifacts/env-report.md`，**不得收集令牌/密钥原文**。

### 2.3 macOS / Linux 基线命令

```bash
PROFILE_NAME="${DSH_PROFILE:-web}"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
command -v dsh
dsh -V
node -v
npm -v
pnpm -v
git --version
test -f "$DSH_ROOT/profiles/$PROFILE_NAME/package.json"
dsh --profile "$PROFILE_NAME" --dump-config
```

### 2.4 基线与备份（只读优先）

1. 记录 `dsh -V`、Node、profile 名、插件行 ID、包名、源目录和 Git commit SHA。
2. 保存目标 profile 的 `package.json` 和 `cordis.patch.yml` **本地备份**（按日期命名，不覆盖已有备份）。
3. 对现有 Confirm 插件源码做 Git 状态快照；若有未提交变更，只记录其文件列表，不覆盖。
4. **不要重装、替换或清理用户现有确认插件**。优先新建测试 profile；如需在原 profile 安装，先完成快照和回滚准备。
5. 在确定依赖可解析的源码环境执行：

```bash
npm run test:offline
npm test
npm run verify
npm run check
```

> 以上四个命令是在**待确认事项插件项目目录**中执行。仓库文档指出完整测试/verify 需要 DSH 宿主依赖，独立源码副本未安装到 profile 时可能因为 peer 包不可解析而失败；这种情况应记录 `ENV_BLOCKED`，不能算测试通过，也不能直接认定插件业务逻辑失败。

### 2.5 环境发现后的分支

- **全部符合**：进入插件开发与沙盒集成。
- **仅缺少 optional 功能**：适配受控降级，目标及安全不变。
- **发现冲突或多份安装**：先定位正在使用的 DSH 实例及 profile，绝不贸然修改其他副本。
- **工具未实际挂载**：检查 bundle 清单、patch 层叠加和启动日志；只看 dump 不够。
- **需要改动原 Confirm 插件**：第一版应回避，改从公开工具或事件协同；如确实不可回避，列出破坏性变更及迁移测试，另立任务。

---

## 3. 插件架构与职责

```text
真实用户消息 + 当前轮附件
          |
  [0] 用户权限 / 明确否定 / C项回复判别
          |
  [1] trigger-detector：四条件判定
          | 未命中 → 普通 DSH
          v
  [2] plan-snapshot：锁定原方案 + 验收约束 + 来源哈希
          |
  [3] task-graph：拆解为任务/依赖/证据要求
          |
  [4] execution-coordinator：调度/异常/幂等/预算/门禁
          |                  |
          |                  +--> 常规决策：内部决策器
          |                  +--> 正式 C 项：不得伪造用户回复，
          |                       仅将真实 C 流程交给 Confirmation Resolution
          v
  [5] DSH Goal + tool-goal + goal-round-driver
          |
       工具执行 → 独立验收 → 状态写盘
          | 未结束：继续受控轮次
          v
  [6] reporter：最终验收 + 一次性完整汇报
```

### 3.1 文件结构（建议）

```text
dsh-auto-plan-executor/
├── package.json
├── cordis.patch.yml
├── README.md
├── AGENTS.md
├── lib/
│   ├── index.js                 # Cordis 入口、注册/卸载生命周期
│   ├── rules.js                 # 条件启用的提示规则，不复制确认插件全套规则
│   ├── trigger.js               # 四条件 + 明确否定 + 误触发保护
│   ├── attachment-reader.js     # 安全提取文件名、文本与标题
│   ├── plan-snapshot.js         # 原方案版本、核心目标、哈希
│   ├── task-graph.js            # 子任务、依赖、有向无环检查
│   ├── plan-state.js            # 状态机 + 持久化
│   ├── goal-adapter.js          # DSH Goal 原生能力适配
│   ├── confirmation-adapter.js  # Confirmation Resolution 边界与能力发现
│   ├── policy.js                # 自动选择、风险、门禁分级
│   ├── budget.js                # 单次与累计费用守卫
│   ├── executor.js              # 分轮调度与失败隔离
│   ├── verifier.js              # 非模型自报的验收
│   └── reporter.js              # 证据与最终报告
├── test/
│   ├── trigger.test.mjs
│   ├── plan-state.test.mjs
│   ├── budget.test.mjs
│   ├── confirmation-contract.test.mjs
│   ├── e2e-dual-plugin.test.mjs
│   └── fixtures/
├── verify/
│   ├── environment.mjs
│   ├── wiring.mjs
│   └── dual-plugin.mjs
└── artifacts/                   # 本机生成，默认 .gitignore
```

### 3.2 发布包契约

- `package.json` 建议名为 `dsh-plugin-auto-plan-executor`，`type: module`，`main: lib/index.js`。
- 保留 `dsh.bundle.patch: "./cordis.patch.yml"`，由 DSH CLI 以 profile bundle 方式安装。
- `cordis.patch.yml` 建议挂载独立 ID：`auto-plan-executor`。
- 插件自己的 System Prompt 区块名例如 `auto-plan:policy`，与现有 `confirmation:policy` 不冲突。
- 依赖版本与共享服务实例以环境扫描得到的 `0.2.0-rc.2` 实际包为准；避免携带第二份会造成身份冲突的宿主核心模块。
- 新插件**不导入 Confirmation Resolution 的 `lib/index.js`/私有 ledger**；通过已登记工具契约、真实事件和能力发现协作。

> 具体 Cordis `inject`、事件负载类型及 Goal API，应在**目标机器的 `0.2.0-rc.2` 实际类型声明**中复核后编码，不能把 GitHub `master` 的接口一字不差地当作 RC 版真值。

---

## 4. 四类触发规则的优先级和算法

### 4.1 判定顺序（由高到低）

1. **系统/权限强制约束**：无访问权限、附件不可读等先受控处理。
2. **真实用户的明确否定/仅讨论意图**：`不要执行`、`只分析`、`仅审阅`、`先别实施`，一票否决自动启动。
3. **已发布确认项的真实用户回复**：若用户在回应有效 C 项，优先交给原确认插件正常流程；不能因为该确认项提到了“方案”就新建任务。
4. **显式执行指令**：如 `按照方案执行` / `按上述方案实施` / `开始执行这个方案` → 触发。
5. **显式方案提交意图**：如 `这是我的实施方案` / `以下为XXX方案` → 触发。
6. **本轮实际附件名包含「方案」** → 触发。
7. **当前消息首部或附件正文标题为「XX方案」** → 触发。
8. 其余不触发，继续正常聊天。

**仅有“帮我写一个方案”“这个方案怎么样”“请比较两个方案”通常不触发**：它们属于生成/讨论，不代表要求立即实施。显式否定必须压过文件名触发。

### 4.2 判定细则

- 仅处理 **human-sourced** 的真实提交；助手输出、工具结果、Goal 自动续轮合成消息、引用旧消息和日志回放不得新建方案。
- 只读取**当前消息实附**的文件元数据；不要把正文里随意引用的文件名误当作附件。
- 标题识别只检查文档标题/第一段有效标题（例如 Markdown `# XX方案`、DOCX 标题样式、PDF 标题区域或抽取文本），不因正文普通段落中出现“方案”而触发。
- 允许 Unicode 规范化、文件名去路径化、大小写/空格清理。禁止读取附件提供的危险本地路径；附加文件须走 DSH 的附件权限与内容句柄。
- 文件解析有大小、页数、超时与格式白名单；缺乏可靠标题提取时不得伪称已识别。
- 明确指令但当前没有方案正文：只可关联**同会话中唯一、明确且未被撤回的原方案**；不存在或有多个歧义时记录 `NEEDS_PLAN_INPUT`，不随意实施。
- 同一消息重复送达（断线重连/重试）必须使用 `{agentId, sessionId, messageId, attachmentDigest}` 等组成的幂等键，绝不能创建两个 Goal 或重复扣款。

### 4.3 必测触发样例

| 测试输入 | 预期 |
|---|---|
| “按照方案执行”且上下文仅一份有效方案 | 启动 |
| “这是一个实施方案：...” | 启动 |
| 上传 `服务器部署方案.docx` | 启动（若有显式否定则不启动） |
| `项目需求.txt`，首行“# 服务迁移方案” | 启动 |
| “帮我写一个部署方案” | 不启动 |
| “这个方案有什么缺点？” | 不启动 |
| “不要执行，先审核附件里的方案” | 不启动 |
| 附件正文出现“方案”，但标题不是方案 | 不启动 |
| 模型自己的 `<goal_round>` 包含“方案” | 不启动 |
| 用户对真实 C1 回复“采用第二个方案” | 属于确认项回复，不启动新计划 |
| 同一消息被重放两次 | 仅启动一次 |
| 明确实施指令但无可确定目标方案 | 挂起输入，不执行猜测 |

---

## 5. 原方案锁定、任务规划和反偏航

### 5.1 快照创建

创建 `plan_id` 与只读的 `plan_snapshot`，保存来源、原文哈希、用户明确约束、必须实现的功能、组件/依赖、不可变目标、禁止事项、预算上限、验收口径。

- 快照不可被模型在后续轮次静默覆盖。
- 修改核心目标须有真实用户新指令及新的 `plan_revision`。
- 普通修复可调整细节和任务顺序；移除明确要求的功能不属于可自行做的优化。
- 若因缺少权限或硬依赖无法实施，标注为阻塞，不允许以删减需求伪装完成。
- 原文与敏感附件能不复制则不复制；存放路径必须受访问控制，报告里只引用哈希/受保护证据路径。

### 5.2 任务图

每个任务至少有：

```json
{
  "task_id": "T-001",
  "title": "示例任务",
  "required": true,
  "dependencies": [],
  "allowed_scope": ["指定工作区"],
  "acceptance": ["可以客观验证的条件"],
  "rollback": "可用的回滚路径或不可回滚说明",
  "risk_level": "LOW",
  "status": "PENDING",
  "retry_count": 0,
  "idempotency_key": "由执行实例与动作计算",
  "evidence_refs": []
}
```

依赖图必须检查循环，禁止对同一文件/数据库进行无协调的并发写入。高风险副作用任务按保守顺序运行。

---

## 6. 连续轮次执行、停止与恢复

### 6.1 优先复用原生 Goal

检查实际 profile 是否已装载：

- `@deepseek-ai/dsh-goal`
- `@deepseek-ai/dsh-tool-goal`
- `@deepseek-ai/dsh-goal-round-driver`

如果存在并符合 `0.2.0-rc.2` 实测契约，优先由这组机制推进自动轮次。新的 Auto Plan 插件负责生命周期编排与额外守卫，**不能又启动一套竞争性 `followup` 无穷循环**。

宿主公开资料说明：Goal 驱动在目标 active 且 armed、agent idle 且轮次未用尽时续跑；达到轮次上限会产生 blocker；重启/恢复之后**不会擅自自动重新 armed**，需遵循恢复授权约束。以本机版测试验证这些行为。

### 6.2 状态机

```text
NOT_TRIGGERED
    ↓ （真实用户方案触发）
DETECTED → SNAPSHOTTED → PLANNED → RUNNING
                                   ├→ RETRYING → RUNNING
                                   ├→ PARTIALLY_BLOCKED → RUNNING(独立分支)
                                   ├→ NEEDS_HUMAN_ACTION
                                   ├→ BUDGET_BLOCKED
                                   └→ VERIFYING
                                          ├→ RUNNING(待修复)
                                          ├→ COMPLETED_VERIFIED
                                          └→ PARTIAL / BLOCKED / FAILED
```

- 只要有可执行的独立任务，继续当前合法轮次。
- 相同错误连续失败最多 3 次；根据错误类型允许更严格的重试上限。
- 达到宿主轮次/资源上限、取消、权限失效、会话停止或宿主异常时，不冒充成功；记录可恢复状态。
- Goal 的轮数上限和 token / 费用 / 时间预算是不同约束，必须分别实现。
- 显式用户停止指令、宿主取消与安全断路器高于“自动继续”。

### 6.3 中断恢复

- 以原子写或持久化事务保存状态：`plan_id`、`task_id`、Goal 身份/修订、幂等键、执行结果摘要、验收证据、费用和阻塞项。
- 重新启动先核验外部副作用：例如文件已改、服务已部署、付款已扣，再判断是否重复调用。
- **遵循 Goal 原生重启后需重新授权 armed 的规则**，不可偷偷恢复可产生副作用的执行。
- 当前公开版 Confirmation Resolution 的会话账本不持久化；如果本地版未改变此行为，进程重启后不得凭自己保存的 C1 摘要直接调用 `decide/complete`。原确认插件账本需要通过受允许的真实发布/登记链路重新建立，或者将旧 C 项标记为不可直接恢复并待用户处理。
- 用户本机如果确实增加了 V2 或持久化功能，以本机代码和测试结果修订本节，不预设仓库 `master` 等于本机版本。

---

## 7. 与 `dsh-confirmation-resolution` 的精确兼容方案

### 7.1 先区分两种“确认”

| 场景 | 正确处理 |
|---|---|
| 执行中“用 A 还是 B 实现？” | 新插件内部自主判定，受原方案和权限约束 |
| 执行中“是否重试一个低风险测试？” | 新插件自主判定 |
| 执行中需要本人授权/敏感权限 | 等真实本人授权；其他任务继续 |
| 主任务结束，DSH 正式发布 `C1` | 原 Confirm 插件按规则 `register` |
| 用户随后真实回复 `C1` | 原 Confirm 插件 `decide` |
| 返回 `MODIFY`、执行成功 | DSH 真执行 + 验收，原 Confirm 插件 `complete` |
| 返回 `KEEP_CURRENT` | 原 Confirm 插件完成自身确认项；主方案是否完成仍独立验收 |
| 没有用户回复 `C1` | 不伪造回复，不得自动 `decide` |

**不存在“为了自动执行，先给自己制造 C1，再自己回复 C1”的合法捷径。**

### 7.2 版本/工具能力适配

适配器在真实运行时检查：

- `confirmation_resolution` 是否注册（本方案基线必须支持）。
- `confirmation_resolution_v2` 是否**确实**注册、启用，及其实际 Schema、审批状态、完成条件。只有存在时才纳入 V2 路径；不得将历史对话的 V2 描述视为真实安装证据。
- 同一个正式确认项必须绑定一个版本与一次真实发布轮次；禁止跨 V1/V2 重复处理。
- 如实际版本只有 V1，完整支持 V1 即可，不需要为此修改确认插件。
- 原插件所有输出/状态以实时返回为准，不能用新插件自己的推测覆盖。

### 7.3 V1 必须保持的状态机与守卫

```text
发布真实 C1
   → register(C1)：STATUS=REGISTERED，账本状态 PENDING
用户真实回复 C1
   → decide(C1)
      ├─ KEEP_CURRENT：自动 RESOLVED；无需 complete
      ├─ MODIFY：STATUS=READY_TO_EXECUTE，账本 AWAITING_EXECUTION
      │        → DSH 按 SELECTED_SOLUTION / EXECUTION_SCOPE /
      │          DO_NOT_CHANGE 修改
      │        → 真实成功 + 必要验收
      │        → complete(C1)：RESOLVED
      ├─ INSUFFICIENT_CONTEXT：补证据，不能借旧决定完成
      └─ NOT_APPLICABLE：硬守卫拒绝，不重试非法路径
```

**外部 API 语义要点**：

1. `register` 在 DSH 实际向用户发布确认项之后，不要求 `user_reply`。
2. `decide` 必须有**用户当前的真实** `user_reply`，不得合成。
3. 预判 `user_goal`、`quality_impact`、`user_impact_if_unchanged`，必要时给出 2–3 个真实候选方案和约束；输入证据不得伪造。
4. `MODIFY` 不等于完成，未实际成功前不可 `complete`。
5. 每次重新 `decide` 会使旧的未执行授权失效；不能复用旧决策完成。
6. 已解决/未登记的编号被硬守卫拒绝；C 编号是否可复用由原插件账本规则控制。
7. 最终方案验收器独立判断必要功能是否实现，不能因为 `KEEP_CURRENT` 便认定原方案已经达标。

### 7.4 V2 处理原则（能力可选，不假设存在）

仅在本机**实际注册并可用** V2 工具时，建立对其真实参数/状态的适配：

- 按本机 Schema 填写版本、operation、上下文、revision 等。
- 遇到 `REQUEST_APPROVAL` 不伪造批准；交由真实用户授权。
- 仅在有效且最新授权、范围和 revision 满足本机 V2 契约时执行。
- 任何不确定字段或返回枚举应先通过本地契约测试确认；不得把猜测写成生产接口。
- 如果 V2 不可用，明确输出 `V2_NOT_PRESENT`，继续 V1，不将其记为失败。

### 7.5 唯一数据所有权

- Confirmation 插件独占其 `ledger` 写入权。
- Auto Plan 插件只维护自己的映射：`{plan_id, task_id, session_id, confirmation_id, confirmation_generation, version, outcome, evidence}`。
- 同一 C 项串行处理；任何并发消息需做会话级锁，避免 `register/decide/complete` 交错。
- 不导入原插件私有 `ledger.js`，也不直接复制/修改其 System Prompt 内容。
- 原确认插件退出/重载时，Auto Plan 必须停止对应确认流；不触发幽灵 `complete`。

### 7.6 插件相互影响的处理

- Prompt：新插件自己的提示词注明“仅 active 方案时执行”，不取代已有 `confirmation:policy`。
- tools：名称独立、不与 `confirmation_resolution` 冲突。
- hooks：先检查 `source`，避免把 Goal 合成轮次和正式 C 回复误识别为新方案。
- Goal：只保留一个推进器；避免两个插件对同一 agent 重复 `steer/followup`。
- 失败：确认插件挂载失败时，新插件不能声称双插件已联调；保持普通 DSH 或安全降级，并记录原因。

---

## 8. 决策、门禁、授权与预算的硬规则

### 8.1 普通技术决策

在保持原目标与必要功能不变的前提下，优先顺序：

1. 与原方案一致；
2. 满足安全/稳定/数据完整性；
3. 可验证实现效果；
4. 对现有系统改动最小；
5. 维护与实现成本更低。

决策日志必须记录候选方案、推荐选项、选择依据、被排除的原因及后续影响。

### 8.2 门禁分类

| 类型 | 示例 | 允许行为 |
|---|---|---|
| G0 常规流程确认 | 选择低风险参数 | 范围内自动选择 |
| G1 非强制、非关键质量检查 | 与核心任务无关的可选 lint 建议 | 证明无实质影响后可跳过，留痕 |
| G2 关键稳定性/功能检查 | 编译失败、核心测试失败、数据校验异常 | 先修复重验；无安全替代则阻塞 |
| G3 身份、权限、安全、合规 | 身份校验、访问控制、强制审批 | 正规授权，**不得绕过** |
| G4 费用与资源 | 收费步骤、累计额度 | 硬预算门禁，超限停止该操作 |

不允许以“对稳定性无影响”的主观口头判断跳过真实的安全门禁；跳过必须有验证证据且该检查本身允许跳过。

### 8.3 费用策略

- 一次实际收费操作估价 `>2 CNY` → 不自动批准。
- 本次任务累计预算没有另外指定时固定为 `2 CNY`；任何新收费操作必须在预算内。
- 无法获取可信计费价格/货币换算/剩余余额 → **不做付费放行判断**；可继续免费任务。
- 预估费用不等于已扣费用；每次记录实际结算证据及累计数。
- 禁止拆单突破预算；重试前核对已产生的扣费。
- 大模型 token 费用如需纳入人民币预算，必须接入可信使用量和价格数据；否则明确写出“模型 API 消耗不能保证被此预算守卫覆盖”。

---

## 9. 持久化数据、日志和验收

### 9.1 状态持久化建议

为每个方案生成受控目录（可配置），如：

```text
<workspace>/.dsh-auto-plan/
├── plans/<plan-id>/snapshot.json
├── plans/<plan-id>/state.json
├── plans/<plan-id>/decisions.jsonl
├── plans/<plan-id>/actions.jsonl
├── plans/<plan-id>/evidence/
└── plans/<plan-id>/final-report.md
```

`state.json` 原子写入并带 schema 版本；日志禁止写密钥、会话凭据和完整敏感文档。只存必要证据摘要和受限路径。

### 9.2 关键字段

- `plan_id`、`source_message_id`、`source_attachment_ids`、`snapshot_hash`、`revision`
- `task_id`、`required`、`dependencies`、`status`、`acceptance`
- `action_id`、`idempotency_key`、`attempt_no`、`tool_result_ref`
- `gate_type`、`reason`、`skip_justification`、`security_impact`
- `budget_limit_cny`、`estimated_cost_cny`、`actual_cost_cny`、`currency`
- `confirmation_id`、`confirmation_version`、`confirmation_generation`、`outcome`
- `evidence_refs`、`validation_timestamp`、`validator_version`
- `blocked_reason`、`resume_requirement`、`final_status`

### 9.3 独立验收示例

- 修改文件：检查目标内容、语法、必要回归测试、Git diff，不以“写入成功”代替验证。
- 修改程序：单测、集成测试、构建/启动检查、核心用例检查。
- 部署服务：启动、健康检查、权限和网络可达性、可选回滚验证。
- 付费操作：实际账单/调用结果证据；无证据不得记为已付款成功。
- 自动确认处理：按原确认插件 `STATUS` 和真实执行证据分别判定，而不是以调用次数判定。

---

## 10. 本地开发与双插件联调实施步骤

> **本章是实施清单，不是已完成记录。** 每个阶段完成后保存日志和验收证据；不要对用户每一步询问是否继续。只有真实需要本人授权的动作停在局部任务上。

### 阶段 P0：环境预检和基线冻结

**操作**：
1. 执行第 2 章；识别 DSH `0.2.0-rc.2` 当前命令、Node、profile、两种服务、附件和 Goal 接口。
2. 锁定原确认插件本机源目录/commit，建立配置与源码快照。
3. 在实际可解析宿主依赖的环境中运行 Confirm 插件已有离线、完整与 wiring 测试。
4. 建立 `artifacts/env-report.md` 和 `artifacts/confirmation-baseline.md`。

**门禁**：不能定位真实 profile 或原确认插件启动失败时，不允许宣称已具备双插件联调条件。

### 阶段 P1：建立新插件工程

**操作**：
1. 新建 `dsh-auto-plan-executor` 项目，纯 ESM/Cordis 结构。
2. 实现包元数据、bundle patch、基础启动/卸载钩子。
3. 添加最小测试，验证新插件安装/卸载可逆且不改变 Confirmation 工具契约。
4. 首次仅在**隔离测试 profile**启动。

**门禁**：bundle 行存在且真实启动可激活；无重复工具/服务注册。

### 阶段 P2：触发识别

**操作**：
1. 实现四种规则、明确否定优先、正式 C 回复优先。
2. 加入消息来源判定、附件内容获取、标题抽取和大小/超时限制。
3. 实现幂等 trigger、避免重复创建方案。
4. 完成第 4.3 节全部样例及变体测试。

**门禁**：所有强制正向、否定和重放测试通过；不得把普通问答改成执行。

### 阶段 P3：方案快照与任务图

**操作**：
1. 固化方案原文及必要目标，生成 SHA-256 指纹和版本。
2. 构建任务依赖图、验收定义、风险等级、回滚说明。
3. 检测有向环、冲突改动和不合理目标裁剪。
4. 测试任务更新不会篡改 snapshot。

**门禁**：必须任务和必要组件不可被优化器私自删除。

### 阶段 P4：执行协调器与 Goal 集成

**操作**：
1. 以本机实测的 DSH Goal API 创建/激活任务目标。
2. 同步任务阶段与 Goal 轮数，复用 `goal-round-driver`。
3. 对独立任务继续执行，对相同错误限制重试次数。
4. 处理用户中断、轮数耗尽、模型异常和未完成回报。

**门禁**：只有一个主动续轮控制器；不出现双重 followup 或无限循环。

### 阶段 P5：门禁与费用守卫

**操作**：
1. 实现 G0–G4 分类、默认低风险决策、阻塞与不影响分支继续。
2. 实现单次与累计各 2 元的默认硬限额。
3. 将权限判定放在**工具调用前**，不是只写在 Prompt 里。
4. 为每个跳过的非关键检查记录理由和验证证据。

**门禁**：越权、真实授权、超预算场景必须 fail closed。

### 阶段 P6：确认事项插件兼容适配

**操作**：
1. 检查真实注册工具。识别 V1，以及本机如果存在的 V2。
2. 验证 Confirm 原有注册—决策—执行—完成状态机不被篡改。
3. 新插件不在主任务执行中伪造 C 项，也不合成真实用户回复。
4. 验证 CONFIRM 的 `KEEP_CURRENT`、`READY_TO_EXECUTE`、`INSUFFICIENT_CONTEXT`、`NOT_APPLICABLE` 分支。
5. 如存在 V2，再单独验证审批与修订号保护；若不存在则记录 `NOT_PRESENT`。

**门禁**：正式确认流与普通方案执行流完全隔离；同会话多方案不串账。

### 阶段 P7：独立验收与报告

**操作**：
1. 添加检查器：测试结果、文件差异、服务探针、必要验收列表。
2. 所有必须任务验证通过才允许 `COMPLETED_VERIFIED`。
3. 生成完整执行清单、风险、费用、门禁、确认状态、异常与回滚记录。
4. 对未完成事项给出 `PARTIAL` 或 `BLOCKED`，不虚报完成。

**门禁**：任一必要任务失败/待授权时，“全部完成”必须不可达。

### 阶段 P8：隔离环境双插件端到端联调

**建议环境**：从真实 `web` profile 派生隔离 profile；确认插件使用用户现有适配代码的**受控副本**，不直接覆盖日常运行环境。

**测试步骤**：
1. 单独启动 Confirm → 原基线测试通过。
2. 单独启动 Auto Plan → 触发与执行测试通过。
3. 两者同时装载 → 启动日志、工具注册表、Prompt sections 和 Goal service 没有冲突。
4. 逐项运行第 11 章测试矩阵。
5. 故障注入：重启、超预算、非法 C 编号、相同错误重试、附件不可读、模拟权限拒绝。
6. 收集实际结果和证据，不因全部脚本进程退出码为 0 就直接认为功能验收通过。
7. 失败时分类：插件缺陷、测试环境、上游限制、待人工授权。

**门禁**：P0 用例全部通过；没有未经授权的敏感操作和账本污染。

### 阶段 P9：部署至日常 profile

**操作**：
1. 在完成 P8 后对日常 profile 做备份。
2. 只安装新插件，不修改现有 Confirmation 源码。
3. 使用 DSH 官方 profile 管理命令安装（目录应为新插件真实路径）：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-auto-plan-executor
dsh --profile web --dump-config
```

4. 重启目标 DSH（如该 bundle 必须启动时组合），确认两插件运行时均已加载。
5. 进行只读 smoke test、一份临时方案的真实执行与最终报告验收。

**门禁**：原 Confirmation 的常规 C1 功能在启用新插件前后必须一致。

### 阶段 P10：交付、回滚和维护

**操作**：
1. 归档新插件源码、测试、文档和证据。
2. 记录原插件的源版本、配置信息和联调结果。
3. 撰写操作手册、示例方案、常见阻塞恢复操作。
4. 验证禁用/卸载新插件后 Confirm 仍可独立工作。
5. 完成全部验收后，统一向用户汇报真实实施情况。

---

## 11. 双插件联调测试矩阵（必须有实际通过记录）

> **初始状态全部为 `NOT_RUN`**。运行后填入 `PASS / FAIL / ENV_BLOCKED / NOT_APPLICABLE` 和证据路径。

| ID | 测试 | 预期结果 | 优先级 |
|---|---|---|---|
| ENV-01 | DSH 版本与 PATH | 当前宿主 `0.2.0-rc.2` | P0 |
| ENV-02 | 正确识别当前 profile | 不串用其他 profile | P0 |
| ENV-03 | Confirm 原基线测试 | 本机已适配代码按实际测试通过 | P0 |
| ENV-04 | 双插件真实启动 | 两个工具/服务均可用，无重复行 | P0 |
| TRG-01 | “按照方案执行” | 自动进入方案模式 | P0 |
| TRG-02 | “这是实施方案” | 自动触发 | P0 |
| TRG-03 | 文件名含“方案” | 自动触发 | P0 |
| TRG-04 | 正文/附件标题“XX方案” | 自动触发 | P0 |
| TRG-05 | “不要执行，只审阅方案” | 绝不自动启动 | P0 |
| TRG-06 | “帮我写方案” | 保持普通问答 | P0 |
| TRG-07 | Goal 合成消息包含“方案” | 不重复触发 | P0 |
| TRG-08 | 重复上报同一消息 | 仅一个 plan_id | P0 |
| PLN-01 | 原方案要求指定组件 | 不得擅自移除 | P0 |
| PLN-02 | 部分任务失败 | 无依赖任务继续 | P0 |
| PLN-03 | 连续相同错误 | 达重试上限后阻塞 | P0 |
| PLN-04 | 必要任务未验收 | 不得输出全部完成 | P0 |
| GOAL-01 | 多轮 Goal 驱动 | 不需每轮人工输入“继续” | P0 |
| GOAL-02 | 轮次上限/取消 | 正确停止并保存状态 | P0 |
| GOAL-03 | 重启恢复 | 不擅自重新 armed，状态可追踪 | P0 |
| CONF-01 | 独立原始 C1 对话 | 原插件照常 register/decide | P0 |
| CONF-02 | 未注册 C1 的 decide | `NOT_APPLICABLE` | P0 |
| CONF-03 | KEEP_CURRENT | 不执行修改，确认项正常关闭 | P0 |
| CONF-04 | MODIFY 成功 | 执行验收成功后 complete | P0 |
| CONF-05 | MODIFY 执行失败 | 不 complete，可正确重试 | P0 |
| CONF-06 | 重新 decide 后旧授权 | 不可被旧决定完成 | P0 |
| CONF-07 | 同一 C 编号复用 | 遵循新文本/账本轮次规则 | P0 |
| CONF-08 | 执行中的普通选择 | 不误调用确认工具 | P0 |
| CONF-09 | 用户真实 C 回复含“方案” | 不误建新 plan | P0 |
| CONF-10 | 两个不同会话 C1 | 不串账 | P0 |
| CONF-11 | V2 不存在 | V1 继续正常工作 | P0 |
| CONF-12 | V2 存在时真实审批 | 未获授权不得自动 approve | 条件 P0 |
| RSK-01 | 安全/身份/权限门禁 | 不自动绕过 | P0 |
| RSK-02 | 非关键可跳过检查 | 有证据、有报告记录 | P0 |
| BUD-01 | 单项费用 >2 元 | 拒绝自动付款 | P0 |
| BUD-02 | 多次费用累计 >2 元 | 阻断后续收费 | P0 |
| BUD-03 | 费用不可计量 | 不声称额度仍充足 | P0 |
| REC-01 | 部署/文件重试 | 不重复副作用 | P0 |
| REC-02 | Confirm ledger 重启丢失 | 不伪造恢复或直接 complete | P0 |
| REP-01 | 完整方案执行完毕 | 逐项证据与统一报告 | P0 |
| REP-02 | 必要任务受阻 | 诚实报告部分完成/阻塞 | P0 |
| OFF-01 | 禁用新插件 | 原 Confirmation 独立功能正常 | P0 |

### 11.1 必须保存的证据

- `env-report.md`：本机版本、运行路径、profile、依赖、注册工具列表（敏感字段打码）。
- `baseline-confirmation.log`：原插件已有测试结果。
- `wiring-dual-plugin.log`：真实两个插件启动和卸载结果。
- `test-results.json`：逐项状态、时间、证据引用和失败原因。
- `fixtures/`：与用户生产数据隔离的测试文件、方案、模拟账户和示例服务。
- `final-integration-report.md`：失败说明、功能回归、最终验收结论。

### 11.2 通过标准

- **所有 P0 实施与联调测试均 PASS**；条件用例可记录 `NOT_APPLICABLE`，并附支持性事实。
- Confirm 原有测试在新插件装载后不退化。
- 真实双插件启动/卸载稳定；无同名工具覆盖。
- 不出现伪造 `user_reply`、伪造 C 项、重复扣费、必要任务假完成。
- 显式不执行 / 仅讨论的方案绝不触发。
- 任务的稳定性、安全和核心目标通过验收。
- 不以 `ENV_BLOCKED` 或 `NOT_RUN` 代替 PASS。

---

## 12. 统一提示规则（供新插件实现，不覆盖原插件）

> 以下为建议注入的短规则。执行可靠性由代码状态机、工具权限和真实验证保障，**不能只靠这段 Prompt**。

```text
【自动方案执行策略】
仅当 auto-plan-executor 检测到真实用户明确实施指令、提交方案意图、
本轮附件名称包含“方案”、或可信解析到“XX方案”标题，
且没有明确的“仅分析/不要执行”指令时，激活当前方案。

激活后，读取已冻结的原方案目标、任务依赖和验收条件。
优先自主选择原方案范围内的低风险实现细节；不得改变核心目标、
删减必需组件或降低验收标准。
每轮执行完验证结果，写入持久状态；有独立任务可做则继续合法轮次。
同一错误连续失败最多三次，不能继续时隔离阻塞并如实记录。
单次收费不超过2元人民币；无另行预算授权时累计也不超过2元。
无法核实费用、权限或安全性时不得假定已获授权。

正常任务内的技术选择不调用 confirmation_resolution。
只有主任务完成、DSH 真实发布/登记 C 编号、真实用户针对该项回复时，
才允许让现有待确认事项插件依其 register→decide→complete 契约工作。
不得制造用户回复、改写其账本或假设 V2 已启用。

严禁绕过安全、身份验证和强制授权门禁；
仅能在证明无实质影响且允许跳过时跳过非关键检查。
不得将拟执行命令或模型描述当作实际成功。
完成全部必要任务并逐项验收后，再统一报告。
遇真实无法代理的授权或资源阻塞，应仅暂停受影响任务。
```

### 12.1 建议程序层面实现的审计点

- `activatePlan()`：必须通过真实触发判定、同会话消息去重、否定意图优先。
- `beforeToolCall()`：校验作用域、预算、风险等级、任务依赖、幂等键。
- `afterToolCall()`：记录实际输出、费用、失败信息，更新状态，不提前验收。
- `validateTask()`：独立运行必要验证。
- `beforeFinalReport()`：校验所有 required 子任务确实通过，才允许 `COMPLETED_VERIFIED`。
- `onShutdown()`：提交状态；取消未提交副作用；Goal continuation 按宿主生命周期卸载。
- `onResume()`：先检查 Goal armed 授权与确认账本有效性，再决定可以恢复哪些任务。

---

## 13. 失败处理与回滚

### 13.1 回滚条件

- 新插件引起 Confirm 常规 C 项状态机回归。
- 出现未授权调用、插件间串账或安全门禁被绕过。
- 出现任务重复执行导致实际重复付费/不可逆副作用。
- 新插件无法卸载、会话无法正常交互或常规非方案消息被误拦截。
- 关键验收测试失败且没有安全替代方法。

### 13.2 回滚顺序

1. 先暂停新插件的新方案触发与 Goal 自动继续。
2. 等待正在进行的低风险操作安全结束，必要时按宿主标准取消。
3. 从 profile 中**只卸载新插件**，不触碰现有 Confirmation 插件：

```bash
dsh plugin --profile web remove dsh-plugin-auto-plan-executor
```

4. 重启/重载实际目标 DSH，并验证 Confirm `confirmation_resolution` 原流程仍工作。
5. 如曾修改 profile 的其他配置，按先前快照只恢复**新插件影响的配置项**，避免覆盖用户近期合法更改。
6. 记录回滚原因、未完成任务及已发生的外部副作用；对不可逆动作明确报告，不谎称已经撤销。

---

## 14. 执行状态模板与最终汇报格式

### 14.1 进度看板（实际执行时填）

| 阶段 | 状态 | 实施结果 | 验收证据 | 阻塞 |
|---|---|---|---|---|
| P0 环境扫描与基线 | NOT_RUN | — | — | — |
| P1 工程骨架 | NOT_RUN | — | — | — |
| P2 四条件触发 | NOT_RUN | — | — | — |
| P3 方案快照与任务图 | NOT_RUN | — | — | — |
| P4 Goal 连续执行 | NOT_RUN | — | — | — |
| P5 门禁与预算 | NOT_RUN | — | — | — |
| P6 Confirmation 适配 | NOT_RUN | — | — | — |
| P7 独立验收与报告 | NOT_RUN | — | — | — |
| P8 隔离双插件联调 | NOT_RUN | — | — | — |
| P9 日常 profile 部署 | NOT_RUN | — | — | — |
| P10 交付与回滚检查 | NOT_RUN | — | — | — |

### 14.2 最终统一汇报必含八部分

1. **总体结论**：目标、实际是否完成、运行状态、验收结果。
2. **环境清单**：真实 DSH 版本、目标 profile、Node、插件来源、确认插件基线。
3. **逐项执行记录**：P0–P10 每一步真实操作、状态、日期、证据、失败原因。
4. **双插件联调矩阵**：第 11 章每个用例的 PASS/FAIL/ENV_BLOCKED/NA。
5. **自动决策与原方案一致性**：重要的选择、理由和不可改变项核对。
6. **门禁、授权、费用**：类型、跳过证据、实际收费、累计费用与剩余预算。
7. **未完成和风险**：必要任务、非关键跳过、等待本人授权、需要修复的内容。
8. **最终验收**：只能为 `全部完成并验证 / 部分完成 / 阻塞 / 失败` 之一，不得虚构。

**真实阻塞时允许提前输出最小必要问题，但这不是全部完成的最终报告。**

---

## 15. 给本地 DSH 的实施总指令（执行本文件时直接使用）

```text
请将本 Markdown 视为 dsh-auto-plan-executor 的正式开发与本地联调实施方案。

先执行 P0 的本地环境检查，锁定当前 DSH 0.2.0-rc.2 的真实运行 profile、
工具注册、Goal API、附件类型和已经适配的 dsh-confirmation-resolution。
仓库旧 README 的版本声明不构成否决依据；不要擅自升级 DSH 或替换原确认插件。

依 P1→P10 开发新插件并在隔离 profile 中完成双插件真实联调。
每轮实施应读取状态、选择可执行任务、调用工具、验证结果、更新持久状态，
有下一轮则按宿主允许的 Goal 机制自动推进；不要每轮询问“是否继续”。
需要常规技术取舍时自主选择，严格保留原方案目标和必须组件。
原确认插件仅处理正式发布、已登记且用户真实回复的确认项，
不可伪造 C 项/用户回复/审批，不能越过其代码级守卫。

单笔收费 <= 2 CNY，默认本次累计收费 <= 2 CNY；
预算不可可靠计量时停止无法核价的收费动作。
安全、权限、强制审批和关键稳定性门禁不得绕过。
可安全隔离的失败只阻断相应子任务，其余继续。
测试不通过时修复后复验；不得把 NOT_RUN、ENV_BLOCKED 当作 PASS。

全部必要任务和 P0 测试通过后，按第14章生成一次性的完整执行情况报告。
如本地环境缺失或存在真实不可代理的阻塞，报告具体缺口与所需操作，
不得宣称已完成本地双插件联调。
```

---

## 16. 参考资料与核验说明

**宿主官方参考**

- DeepSeek Harness 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- CLI 与插件安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md>
- Profile 插件发布/安装：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- Agent hooks / `agent/pre-step`：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md>
- Goal 连续轮次机制：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal-round-driver/README.md>
- 工具目录 / timed ask-user：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.zh.md>
- 文件消息块：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/types.ts>

**现有插件参考**

- Confirmation Resolution 仓库：<https://github.com/bbaz123/dsh-confirmation-resolution>
- 原插件项目规范：<https://github.com/bbaz123/dsh-confirmation-resolution/blob/master/AGENTS.md>
- 原插件 `lib/index.js`：<https://github.com/bbaz123/dsh-confirmation-resolution/blob/master/lib/index.js>
- 原插件打包与测试命令：<https://github.com/bbaz123/dsh-confirmation-resolution/blob/master/package.json>

> 以上网页可能追踪 `master` 分支并继续变化。**真正开发时以本地已锁定的 DSH `0.2.0-rc.2` 和用户改好的 Confirmation Resolution 安装物为准。** 特别是 V2 是否实际存在、事件/服务签名、Goal 是否已挂载和 confirmation ledger 是否持久化，必须由 P0 与 P6 的本地真实测试确认，不得依据早期对话或远端文件臆测。

---

## 17. 最终成功标准

插件交付只有同时满足以下事实才算成功：

**触发准确** + **不干扰普通聊天** + **原方案不被擅自裁剪** + **安全受控的连续轮次** + **可恢复/幂等的执行状态** + **严格预算和权限边界** + **现有 Confirmation Resolution 原样可用** + **真实双插件联调全通过** + **逐项验收和最终统一报告**。

凡是不能实际验证的目标，必须写清 `NOT_RUN`、`ENV_BLOCKED` 或 `FAILED`，不得伪造“已经完成”。
