# DSH Verification Gate 插件具体实现方案

建议将项目正式定为 dsh-plugin-verification：一个只服务于 DSH 的验证插件，负责在 Agent 结束当前任务前执行“回归 → 断言 → 审查”，发现有证据支持的问题后，先由插件检索 OpenViking，再把当前错误、本任务错误记录和相关历史经验一起交回 Agent。

保留你已经确定的分工：新插件读取经验并控制验证流程；Agent 按现有全局 AGENTS.md 规则完成最终复盘、经验写入和回读；OpenViking 继续负责长期记忆存储。 不再建设第二套长期记忆系统，也不重复写入相同经验。

下面是一份可据此拆分开发任务的 V1 实现设计。其中模块、数据结构、配置项属于本插件拟定义的协议；DSH 原生接口会单独标明。你本地 OpenViking 插件的检索工具 Schema 尚未提供，因此这部分设计为适配层，不假定存在某个未经确认的 ctx.openviking.search()。

## 一、确定 V1 的范围与职责

### 1.1 插件最终负责什么

| 角色 | 职责 | 不承担的职责 |
| --- | --- | --- |
| DSH Agent | 实现需求、修复问题、按现有规则最终复盘及写入长期经验 | 不能用自己的“已完成”声明代替验证证据 |
| Verification Plugin | 变化分析、经验检索、回归、断言、审查、错误记录、修复调度、验收状态 | 不直接修改业务代码，不直接写入长期经验 |
| OpenViking Plugin | 提供现有长期记忆检索和写入能力 | 历史经验不直接决定当前代码是否错误 |
| 项目测试框架及工具链 | 实际执行测试、编译、类型检查和既有断言 | 不负责判断用户需求是否完整实现 |

### 1.2 V1 支持范围

V1 优先支持 Node.js/TypeScript 与 Python 项目，完成整个验证闭环，而不是一次支持所有语言。

具体包括：Vitest、pytest、项目已有的 build/typecheck/lint 命令，Git 工作区快照，基线比较，OpenViking 强制检索，Task Error Ledger，基于证据的只读审查，以及全局复盘交接。

暂不加入复杂 Git 历史关联分析、自动生成 E2E、运行时 Golden Master 自动采集，以及不受限制的 AI 业务断言生成。经验可以帮助选择已有测试；没有现成测试或明确规范支撑的经验型断言，V1 先作为审查线索。

这不改变前面确定的核心顺序：

Change → Memory → Regression → Assertion → Review；确认失败 → Memory + Ledger → Repair；修复后从 Regression 重跑。

## 二、完整运行流程与状态机

### 2.1 主流程

```text
User Task
    |
    v
Capture Baseline Snapshot
    |
    v
Agent Work + Action Recording
    |
    v
agent/turn-stopping
    |
    v
Change Analysis + Memory Retrieval
    |
    v
Regression
    |
    v
Assertion
    |
    v
Evidence-based Review
    |
    v
Finalization Handoff
    |
    v
Agent Final Review + Memory Write/Read
    |
    v
Final State Check
    |
    v
Verified Completion
```

任何验证阶段发现需要处理的问题，都进入同一个分支：

```text
Confirmed Finding
    |
    v
Task Error Ledger
    |
    v
Mandatory OpenViking Retrieval
    |
    v
Repair Packet + Retrieval Receipt
    |
    v
agent.steer(...)
    |
    v
Agent Repair
    |
    v
New Workspace Fingerprint
    |
    v
Restart from Regression
```

### 2.2 用状态机控制，而不是堆叠 Prompt

建议定义以下内部状态：

| 状态 | 含义 |
| --- | --- |
| working | Agent 正常执行任务，插件记录事实 |
| analyzing | 分析当前变化、准备验证上下文 |
| regression | 执行回归检查 |
| assertion | 汇总既有断言，执行补充机器检查 |
| reviewing | 对照需求及证据进行审查 |
| retrieving_for_repair | 修复前强制读取长期经验 |
| repairing | 已注入修复上下文，等待 Agent 处理 |
| finalizing | 将结果交给现有全局复盘机制 |
| completed | 验证和必要收尾已完成 |
| blocked | 无法继续自动处理，需要用户介入 |
| cancelled | 用户取消或宿主终止 |

completed 不能由 Agent 提交一个布尔值直接设置。 它只能由状态机在检查必要条件后产生。

同时分开保存两个结果：

- Technical Acceptance: verified / not_verified / not_applicable
- Finalization Status: complete / partial / pending

这样可以准确表达：

代码验证通过，但 OpenViking 写入回读失败，收尾尚不完整。

不会把“记忆服务故障”错误描述成“代码没有修好”。

## 三、代码组织：一个包、一个运行时、六个业务模块

保留前面确定的六个模块，但把 DSH 生命周期、进程执行、快照和存储放到公共支撑层。

```text
dsh-plugin-verification/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── protocol/
│   │   ├── context.ts
│   │   ├── evidence.ts
│   │   ├── finding.ts
│   │   └── repair.ts
│   ├── runtime/
│   │   ├── controller.ts
│   │   ├── task-state.ts
│   │   └── finalization.ts
│   ├── host/
│   │   ├── dsh.ts
│   │   ├── execution.ts
│   │   └── openviking.ts
│   ├── baseline/
│   │   ├── snapshot.ts
│   │   ├── materialize.ts
│   │   └── cache.ts
│   ├── modules/
│   │   ├── change.ts
│   │   ├── memory.ts
│   │   ├── regression.ts
│   │   ├── assertion.ts
│   │   ├── review.ts
│   │   └── repair.ts
│   ├── adapters/
│   │   ├── vitest.ts
│   │   └── pytest.ts
│   ├── store/
│   │   ├── evidence.ts
│   │   └── ledger.ts
│   └── tools.ts
└── tests/
    ├── unit/
    ├── integration/
    └── fixtures/
```

在 DSH Context 上提供本插件自己的服务：

`ctx.verification`

它负责统一调度，不让三个阶段分别拥有自己的修复循环、缓存和计数器。

| 模块 | 核心方法 | 主要产物 |
| --- | --- | --- |
| Change Analyzer | analyze() | ChangeAnalysis |
| Memory Resolver | resolve() | MemoryContext、检索凭据 |
| Regression Engine | verify() | RegressionResult |
| Assertion Engine | evaluate() | AssertionStageResult |
| Review Engine | review() | ReviewResult |
| Repair Coordinator | prepare() | RepairPacket |

这仍然是一个单用途插件，不需要拆成多个发布包。DSH 官方的包开发说明也支持单用途插件保持单包结构。

## 四、DSH 接入方式：使用真实扩展点

截至本次核对，DSH 公开接口中的 agent/turn-stopping 是一个等待执行的串行事件，参数包含 agent、turn 和 signal。监听器通过 agent.steer(...) 加入下一步工作，而不是返回某个 CONTINUE_AGENT 常量。

### 4.1 各扩展点承担的工作

| DSH 扩展点或服务 | 本插件用途 |
| --- | --- |
| agent/created | 初始化 Agent 级状态，不在这里重复运行完整基线测试 |
| agent/pre-step | 在首次实际处理用户任务前建立任务快照，检查修复上下文是否准备完成 |
| agent/turn-stopping | 启动验收流水线或检查收尾结果 |
| tools/result | 观察最终工具结果，记录动作和可复用证据 |
| agent.steer(...) | 注入修复包或最终复盘交接信息 |
| agent.cancel(...) | 达到硬性阻塞条件时终止本次自动循环 |
| agent/disposed | 清理监听、任务资源和执行句柄 |

工具结果收集优先使用最终的 tools/result，因为 tools/post-execute 后面仍可能存在结果变换；DSH 将 tools/result 定义为对最终冻结结果的观察入口。

### 4.2 任务边界不能等同于 Session 边界

一个 Session 可能处理多个任务，因此不能只在 agent/created 时拍一次快照。

建议 V1 使用：

`taskId = sessionId + 首个用户任务消息的标识`

同一个任务中的修复 steering、补证请求、最终复盘，都保留同一个 taskId 和原始基线。

用户在执行过程中补充要求时，增加 requirementsRevision，使需求审查结果失效；不能因此偷偷更换原始基线。

### 4.3 两个必须明确的边界

第一，Hook 不是终答文本过滤器。 DSH 的流程是在模型响应及工具执行之后进入停止检查。因此它可以强制继续工作、不给出已验收状态，但不能仅靠这个 Hook 撤回模型此前已经输出的“完成了”。界面和调用方应以插件的验收状态为准，而不是扫描回答中的成功关键词。

第二，blocked 是插件状态，不是随便返回的 Hook 值。 达到上限时，先保存并展示阻塞报告，再通过宿主支持的取消接口停止自动处理；不要在停止监听器内部等待同一个 Agent 的 whenIdle()。

DSH 的公开取消类型包含 Hook 原因，可以用于保留终止原因。

## 五、统一数据协议：沿用原结构，补齐执行约束

前面确定的 VerificationContext、Evidence、Finding、RepairPacket 保留。此次重点不是重新发明 Schema，而是增加能够真正执行门禁的字段。

### 5.1 主上下文

| 字段 | 用途 |
| --- | --- |
| schemaVersion | 协议版本 |
| taskId、sessionId | 任务及会话关联 |
| requirementsRevision | 区分不同版本的用户要求 |
| baselineFingerprint | 任务开始前的真实项目状态 |
| workspaceFingerprint | 本轮验证对应的项目状态 |
| environmentFingerprint | 本轮实际执行环境身份 |
| policyFingerprint | 验收规则、必测项目及豁免配置身份 |
| cycle | 当前验证轮次和全局修复预算 |
| change | 当前变化分析 |
| memoryQueries | 各检查点的查询记录，不能被后一条覆盖 |
| regression、assertions、review | 三个阶段产物 |
| ledger | 本任务已确认问题及处理过程 |
| finalization | 全局复盘与记忆回读状态 |

阶段产物按轮次追加，不原地覆盖旧结果。 否则无法追溯“第几轮修复解决了什么，又引入了什么”。

### 5.2 Evidence 的最低要求

每条证据至少要回答：

- 谁产生的？
- 执行或观察了什么？
- 对应哪个项目状态？
- 结果是否完整？
- 原始材料在哪里？

建议在原有字段上补充：

```ts
type EvidenceValidity =
  | "valid"
  | "stale"
  | "incomplete"
  | "unavailable";
```

```ts
type EvidenceOrigin =
  | "current_execution"
  | "baseline_execution"
  | "current_file"
  | "user_requirement"
  | "historical_memory"
  | "model_inference";
```

历史记忆可以登记进 EvidenceStore，但必须标为 historical_memory，不能被伪装成当前执行证据。

### 5.3 Finding 必须区分问题性质

```ts
type FindingKind =
  | "confirmed_defect"
  | "verification_gap"
  | "environment_problem"
  | "policy_violation"
  | "advisory";
```

例如：

| 情况 | 类型 | 后续动作 |
| --- | --- | --- |
| 基线通过、当前同一测试失败 | confirmed_defect | 请求修复 |
| 必须检查的功能没有执行证据 | verification_gap | 请求补充验证 |
| 测试数据库没有启动 | environment_problem | 处理环境，不直接修改业务代码 |
| 为通过测试删除必测用例 | policy_violation | 阻止验收并要求说明或恢复 |
| 历史经验提示可能存在风险 | advisory | 作为检查线索 |

blocking、authority 和最终 Gate Decision 由插件 Policy Engine 计算，不接受模型通过 JSON 自行授予这些权限。

## 六、Baseline 与缓存的具体实现

### 6.1 保存可恢复快照，而不只是保存一个 Hash

继续采用前面选定的：

Snapshot Baseline + Lazy Baseline Testing + Cache。

任务开始时，保存以下内容：

| 内容 | 原因 |
| --- | --- |
| Git HEAD | 定位仓库基点 |
| 工作区已有修改的实际内容 | 包含用户开始任务前未提交的工作 |
| 必要的未跟踪文件 | 避免遗漏新建源码或测试 |
| 文件删除、模式及必要链接信息 | 保证还原后的项目状态正确 |
| 依赖锁文件和测试配置 | 复现测试条件 |
| 快照范围及排除项 | 知道哪些内容没有被纳入验证 |

不能只保存 workingTreeDiffHash，等需要基线时才去读旧文件。 那时旧文件可能已经被 Agent 覆盖。

任务开始时先完成快照，再允许本任务的修改开始。采集过程中发现文件持续变化，应重试或标记快照不可用，而不是产生一个混合状态的基线。

### 6.2 在独立目录还原基线

Git 提供额外 worktree，并支持 detached HEAD，可以用来构建独立的基线工作目录。

拟实现过程：

```text
Frozen HEAD
    +
Frozen Workspace Changes
    +
Frozen Untracked Inputs
    |
    v
Baseline Execution Directory
```

禁止为了测试基线对用户主工作区进行来回 checkout、reset 或 stash。

建议当前版本也复制到本轮执行目录中测试，减少 build、snapshot 或测试脚本改变用户工作区的风险。完成验证后，再检查真实工作区的指纹是否仍然匹配。

### 6.3 基线和当前版本分别使用对应依赖

不能直接把当前项目的 node_modules 或 Python 环境共享给旧基线，然后宣称做了准确比较。

如果本次任务修改了锁文件，应分别建立两边对应的依赖环境，并记录：

- 受控不变条件：运行时、操作系统、测试数据等
- 本次变化条件：源码、依赖、配置等

锁文件变化不等于完全不能比较；真正的问题是是否能够复现两边各自应有的环境。

### 6.4 缓存键与复用条件

建议缓存键为：

```text
hash(
  workspaceSnapshot
  + executionEnvironment
  + commandDefinition
  + testSelection
  + oracleDefinition
  + adapterVersion
)
```

Baseline Evidence 和 Current Evidence 是两类不同记录，不能相互替代。

Agent 主动执行的测试只有在命令、范围、状态指纹、结果完整性均可确认时才能复用。仅有一段“测试通过”的终端文本，不足以满足条件。

V1 宁可少复用，也不要错误复用。

## 七、六个业务模块的具体执行方案

### 7.1 Change Analyzer：确定“改了什么”，不先判断“改错了什么”

输入是任务要求、原始快照、当前快照和本任务动作记录。

输出继续使用：

- files
- symbols
- components
- changeTypes
- directions
- riskSignals
- candidateImpacts

其中，文件变化和具体代码内容属于直接事实；“此次修改意图是统一过期时间”可能属于模型分析，必须带来源。

实现顺序建议为：

先做确定性文件比较，再做组件映射，最后才做有预算限制的语义归纳。

额外规则：

- 修改依赖、公共配置、测试框架配置时扩大测试范围。
- 无法准确判断受影响范围时，回退到模块级或项目级测试。
- 没有源码变化，只能跳过不适用的项目测试；如果执行过配置变更或外部状态操作，仍然需要相应的断言和审查。

### 7.2 Memory Resolver：独立完成查询，并产生凭据

设置四个强制检查点：

| 检查点 | 查询依据 | 主要作用 |
| --- | --- | --- |
| Change Analysis | 组件、改动方向、风险信号 | 建立经验上下文 |
| Regression | 改动范围与历史回归类型 | 增加回归测试目标 |
| Assertion | 业务边界、规范、不变量 | 找到需要特别检查的条件 |
| Repair | 当前实际失败指纹 | 避免重复错误修法 |

Review 可以复用已有经验，再按需查询执行、验收类经验。

基础验证集合与经验扩展集合取并集：

```text
Required Checks
    =
Project Required Checks
    ∪ Deterministic Change Mapping
    ∪ Relevant Experience Suggestions
```

经验只能增加关注点，不能删掉项目必测项。没有命中经验，也必须执行正常验证。

每次查询生成明确状态：

```ts
type MemoryQueryStatus =
  | "success"
  | "empty"
  | "failed"
  | "denied"
  | "unavailable";
```

empty 表示查询成功但没有相关经验；failed 表示查询没有完成。两者不能混为一谈。

**OpenViking 适配方式**

host/openviking.ts 提供本插件内部的统一接口：

```ts
interface MemorySearchRequest {
  taskId: string;
  purpose: "change" | "regression" | "assertion" | "review" | "repair";
  query: string;
  projectScope: string;
  limit: number;
}
```

实际实现按你本地插件提供的能力绑定：

有公开服务接口时使用服务；只有工具时，通过受控工具执行入口调用，并验证实际 Schema。

不能只看到工具名包含 search 就自动调用，更不能猜测参数。也不能为了调用成功，绕过当前 Agent 的作用域或工具权限。

默认只注入相关度最高的少量规则，保留来源标识；不把整段历史聊天塞给 Agent。

### 7.3 Regression Engine：比较测试项，而不是比较整套测试的一个状态

V1 测试选择采用保守策略：

| 模式 | 范围 |
| --- | --- |
| quick | 已知直接相关测试及必要快速检查 |
| regression | 受影响模块、项目必测集合、经验追加测试 |
| full | 用户配置的全部测试和集成检查 |

如果适配器不能可靠判断关联范围，regression 回退到项目已有测试集合，不为了速度随意漏测。

**执行适配器**

统一定义：

- detect()
- buildExecutionPlan()
- parseReport()
- normalizeTestIdentity()

Vitest 使用结构化 JSON 报告；pytest 使用 JUnit XML。两者都提供相应报告能力，适合交给插件解析，而不是让模型阅读终端颜色判断成功。

命令示例仅适用于适配器已确认项目配置的情况：

pnpm exec vitest run --reporter=json --outputFile=/reports/vitest.json

python -m pytest --junitxml=/reports/pytest.xml

真实执行时，解释器、包管理器、环境变量和配置入口以项目实际设置为准；不能绕过项目脚本中的必要初始化。

**基线比较规则**

| Baseline | Current | 处理 |
| --- | --- | --- |
| PASS | PASS | 当前检查通过 |
| PASS | FAIL | 新增回归 |
| FAIL | 相同失败 | 已有问题，不默认要求本任务修复 |
| FAIL | PASS | 原有失败已消失 |
| UNKNOWN | FAIL | 当前失败已观察到，但归因未确定 |
| 任意 | 未执行、报告缺失、结果不完整 | 验证不充分 |

比较必须下沉到测试项及可识别失败项：

`新增失败 = 当前失败集合 - 可确认相同的基线失败集合`

不能因为两边都是 suite FAIL，就认为没有新增问题。这个问题前面已经在数据协议中明确指出。

**额外处理三类容易误判的情况**

测试被删除、跳过或改名： 不能把“未再出现失败”直接算作修复，先进行测试完整性检查。

测试或 Snapshot 本身被修改： 标记 Oracle 发生变化，旧结果不能无条件作为相同断言的基线。合法修改需要能对应当前需求；禁止自动更新 Snapshot 来获得 PASS。

不稳定测试： 重跑用于识别不稳定性，不以“某一次通过”覆盖此前失败。没有稳定结论时保留不确定状态。

### 7.4 Assertion Engine：复用回归证据，再执行缺失检查

这里需要明确：Regression 和 Assertion 是逻辑阶段，不意味着同一个测试要跑两次。

Regression 已经执行过的 expect/assert，直接转成统一断言记录；Assertion Stage 只运行还缺少的类型、构建、Schema 或明确配置的不变量检查。

| 断言来源 | 默认地位 | 失败处理 |
| --- | --- | --- |
| 项目既有测试、已确认规范、既有 Snapshot | 权威依据 | 按基线及任务目标决定阻塞 |
| Build、TypeCheck、项目明确配置的约束 | 机器检查 | 按必需检查策略处理 |
| 自动发现的 Before/After 行为差异 | 建议性 | WARN，不直接判错 |
| 仅来自历史经验的假设 | 建议性 | 查找当前规范或执行证据 |
| AI 临时生成的业务预期 | 建议性 | V1 不自动授予阻塞权 |

不使用“置信度大于 0.9，所以 BLOCK”这样的规则。

另外，不能擅自认定所有 HTTP 500、NaN 或异常都一定错误；某些测试本来就在验证异常路径。不变量必须有适用范围和预期依据。

### 7.5 Review Engine：只读审查，并校验 Finding

建议使用独立的审查上下文，通过 DSH 已有模型能力执行，不让 Reviewer 直接持有写文件、Shell 修改或长期记忆写入权限。DSH 的模型调用能力本身通过服务层提供，本插件不需要再建设模型接入系统。

Reviewer 的输入是：

- 原始需求及补充要求
- 最终 ChangeSet
- 动作记录索引
- Regression Evidence
- Assertion Evidence
- 相关经验
- Task Error Ledger

输出分为两部分：

- requirementCoverage
- findings

requirementCoverage 的状态建议为：

`satisfied / violated / unverified / not_applicable`

插件对每个 Finding 做第二次校验：

| 校验 | 要求 |
| --- | --- |
| 证据存在 | 引用的 ID 必须能在 EvidenceStore 找到 |
| 状态匹配 | 当前代码证据不能来自旧工作区 |
| 来源合格 | 不能只有历史经验或模型推测 |
| 结论受支持 | 证据内容确实支持该结论 |
| 动作匹配 | “缺少验证”要求补证，不直接要求改代码 |

例如，“diff 中没有发送邮件调用”不足以独立证明功能缺失，因为调用可能在没有改动的下游路径中。Reviewer 应请求检查实际调用链或执行相应测试。

引用了 Evidence ID，并不自动等于论证成立。

### 7.6 Repair Coordinator：先查询，再释放修复上下文

这是整个插件最重要的强制环节。

完整顺序固定为：

```text
Record Current Finding
    → Search Task Error Ledger
    → Search OpenViking
    → Resolve Relevant Rules
    → Create Retrieval Receipt
    → Build Repair Packet
    → Inject into Agent
```

建议修复包具有以下结构：

```json
{
  "repairId": "repair_02",
  "taskId": "task_01",
  "workspaceFingerprint": "sha256:current-state",
  "trigger": {
    "stage": "regression",
    "findingIds": ["finding_07"]
  },
  "currentProblem": {
    "summary": "Refresh token lifetime changed from 7 days to 1 day.",
    "evidenceIds": ["ev_baseline_11", "ev_current_28"]
  },
  "memoryRetrieval": {
    "queryId": "memory_query_09",
    "status": "success",
    "memoryIds": ["memory_2841"]
  },
  "taskHistoryIds": ["task_error_01"],
  "requiredChecks": [
    "Confirm the session expiration configuration source.",
    "Confirm the refresh-token expiration configuration source."
  ],
  "constraints": [
    "Use current evidence to identify the cause.",
    "Treat historical experience as a hypothesis.",
    "Do not weaken tests merely to obtain a passing result."
  ],
  "restartFrom": "regression"
}
```

这是协议示例，不代表已经发生过该错误。

**强制检索凭据**

增加 RepairReadTicket，绑定：

- taskId
- workspaceFingerprint
- failureFingerprint
- memoryQueryId
- queryStatus
- repairPacketHash

只有查询成功或明确空命中，且凭据匹配当前错误与当前代码状态，才允许进入正常自动修复。

OpenViking 超时、拒绝访问或不可用时，默认进入 blocked，报告“修复前经验检索未完成”；不悄悄按空结果继续。用户可以明确选择降级，但需要记录这次例外。

在 retrieving_for_repair 期间，通过步骤准入及工具策略限制新的修改动作。DSH 的工具服务提供作用域限制和单调拒绝的 guard，可用于实现这类控制。

能强制的是：检索确实执行、相关内容确实注入下一步输入、必要检查确实得到验证；不能保证模型在认知上一定理解或遵循了每条经验。 后者仍然要靠下一轮执行证据检查，不能用“已注入”代替“已遵守”。

**全局循环预算**

默认：

`maxRepairCycles = 3`

这是 Regression、Assertion、Review 共用的三次修复，不是每个阶段三次。

初次验证失败后最多三次自动修复，随后进行最后一次验证。仍然失败则阻塞。

同一工作区指纹、同一失败指纹连续重复出现，应提前判定没有进展，避免模型反复解释但不解决问题。

## 八、与现有 AGENTS.md 复盘规则的衔接

这里需要补上一个实际运行问题：

turn-stopping 中验证通过后直接返回，DSH 会结束当前 turn，并不会自动再给 Agent 一轮执行最终复盘。 要让模型继续执行已有复盘规则，需要显式安排下一步输入。

### 8.1 增加 Finalization Bridge

三个阶段通过后，控制器进入 finalizing，向 Agent 交接：

- 本任务验证结果
- Task Error Ledger
- 已验证修复及对应证据
- 尚未确认的根因
- 长期经验候选项

同时要求 Agent 执行它已经拥有的全局规则，不再复制整段规则，也不修改全局 AGENTS.md。

Agent 负责最终生成你要求的：

- 【发现的问题】
- 【修复内容】
- 【验证结果】
- 【错误根因】

有真实且可复用经验时，Agent 再调用现有 OpenViking 写入工具，并检索回读。

### 8.2 插件不写记忆，但验证记忆收尾的证据

新增一个本插件工具：

verification_finalize

它接收报告以及实际工具调用的引用，不接受单纯的：

```json
{ "memorySaved": true }
```

插件从已观察到的工具结果中检查：

- 是否实际调用写入工具
- 是否实际执行后续检索
- 是否检索到对应经验
- 内容或标识是否匹配

只搜到一条“看起来相似”的旧记忆，不足以证明这次写入成功。优先匹配写入返回的记录标识；没有稳定标识时，使用经验去重键及规则内容进行匹配。

### 8.3 防止收尾再次引入未验证修改

再次进入 turn-stopping 时：

| 收尾期间发生的情况 | 行为 |
| --- | --- |
| 只生成报告、写记忆，代码未变 | 复用有效技术验证结果 |
| Agent 在最终复盘中又修改了代码 | 旧技术结果失效，从 Regression 重跑 |
| 没有真实且可复用错误 | 记忆状态为 not_required |
| 写入或回读失败 | 明确标为未验证，不声称长期记住 |
| 已有匹配当前状态的完整收尾凭据 | 不重复要求相同复盘 |

这样既保留现有全局规则，又不会形成“每次准备结束都要求再复盘一次”的无限循环。

## 九、执行、安全与证据保护

### 9.1 不把“调用了 DSH 服务”等同于“自动继承全部权限”

执行层封装为：

ExecutionPlan
    → Policy Check
    → Approval When Required
    → Approved Execution Environment
    → Process Result
    → Structured Report

如果通过工具执行，走完整受控工具通道；如果使用 Shell 服务，则由适配层明确解析工作目录、超时和沙箱策略，不能因为是插件内部调用就跳过策略。

DSH 的 Shell 接口分别报告退出码、超时、中止及沙箱事实，因此 exitCode === 0 本身不足以证明一次执行完整成功。

### 9.2 默认限制

| 项目 | V1 默认行为 |
| --- | --- |
| 依赖安装 | 不静默联网安装，需要明确配置或批准 |
| 执行目录 | 仅限批准的项目快照及报告目录 |
| 凭据 | 不向测试环境传递无关宿主凭据 |
| 进程 | 超时或取消后清理相关执行进程 |
| 报告 | 设置大小上限，保留完整性标识 |
| 项目配置 | 不允许 Agent 无审批降低宿主验收要求 |
| 经验内容 | 作为低信任数据，不执行其中携带的任意命令 |

EvidenceStore、缓存和 Ledger 应放在插件管理目录，而不是让项目代码任意覆盖。报告解析还要校验本轮运行标识、文件时间及内容结构，避免读到旧报告。

这仍不是对恶意代码的绝对安全证明。DSH 官方明确说明其仍为实验性软件，沙箱和审批不能作为不可信工作负载的唯一安全控制；不可信项目应在额外隔离环境中运行。

## 十、配置、工具与安装形态

### 10.1 插件配置

下面是本插件拟提供的配置，不是 DSH 已有配置项：

```yaml
enabled: true
mode: enforce

verification:
  defaultMode: regression
  maxRepairCycles: 3
  failFast: true
  unknownRequiredCheck: block
  baselinePolicy: new-failures
  sameFailureNoProgressLimit: 2

baseline:
  strategy: snapshot-lazy
  preserveInitialWorkspace: true
  executeInIsolatedCopy: true

memory:
  binding: existing-openviking
  requiredBeforeRepair: true
  onReadFailure: block
  maxExperiences: 5
  timeoutMs: 5000
  retries: 1

review:
  enabled: true
  readOnly: true
  requireCurrentEvidence: true

finalization:
  owner: agent
  bridgeExistingGlobalRules: true
  verifyMemoryReadback: true
  onMemoryWriteFailure: report-partial

execution:
  autoInstallDependencies: false
  commandTimeoutMs: 120000
  maxCapturedOutputBytes: 2097152
```

数值是建议初始预算，不是性能承诺；项目级长时间测试可以单独配置。

### 10.2 对 Agent 暴露三个工具

| 工具 | 用途 |
| --- | --- |
| verification_run | 主动执行 quick/regression/full |
| verification_status | 查询当前结果、失败原因和报告 |
| verification_finalize | 提交最终报告及真实收尾证据引用 |

这些工具都不能直接提交 PASS，也不接受任意 Shell 字符串来替换必测计划。

### 10.3 打包为可安装 DSH Bundle

DSH 官方的安装式插件通过 package.json 中的 dsh.bundle 声明配置层，配置层再挂载插件入口。

本插件的发布结构可采用：

```json
{
  "name": "dsh-plugin-verification",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/index.js",
  "files": [
    "lib",
    "cordis.patch.yml"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

这是发布结构节选；开发时还需补齐实际依赖、类型声明和构建脚本。

cordis.patch.yml：

```yaml
- insert:
    - id: verification-gate
      name: dsh-plugin-verification
      config:
        enabled: true
        mode: enforce
```

开发完成后的本地安装与检查命令可以采用：

```bash
dsh plugin --profile web add ./dsh-plugin-verification
dsh --profile web --dump-config
```

随后必须实际启动并运行一个验证夹具，不能仅凭安装命令退出成功就认定插件已生效。共享宿主实例的 DSH 依赖应按官方方式声明 peer/dev 依赖，并锁定实际兼容版本。

由于 DSH 目前仍标记为 Developer Preview 并提示存在破坏性变更，V1 应先绑定你本地实际版本测试，而不是承诺兼容所有公开版本。

## 十一、必须通过的验收测试

这些测试应该成为插件自身的自动化测试，而不只是人工检查清单。

| 场景 | 必须观察到的行为 |
| --- | --- |
| 用户任务没有项目修改 | 不无意义执行项目测试 |
| 用户开始前已有未提交修改 | 基线包含这些修改，不归因给 Agent |
| Agent 新建未跟踪源码 | 能被变化分析发现 |
| Baseline PASS、Current FAIL | 生成新增回归并进入修复流程 |
| Baseline 已有失败，Current 新增另一失败 | 正确识别新增项 |
| 必测测试被删除或跳过 | 不得按通过处理 |
| 测试进程退出 0，但报告缺失 | 不得生成有效 PASS |
| 命令超时后仍返回 0 | 按不完整执行处理 |
| 测试后源码再次改变 | 旧证据失效 |
| OpenViking 查询成功但空命中 | 正常执行基于当前证据的修复 |
| OpenViking 查询失败 | 不得伪装成空命中放行 |
| Agent 没主动读取记忆 | 插件仍完成检索和注入 |
| 只有历史经验提示风险 | 不直接产生已确认缺陷 |
| Reviewer 引用不存在的 Evidence | 拒绝该阻塞性 Finding |
| 只有“缺少验证”的证据 | 请求补证，不要求盲目改代码 |
| 同一错误重复且没有进展 | 提前停止自动循环 |
| 已修复三次仍失败 | 保存报告并阻塞 |
| 最终复盘又修改了代码 | 从 Regression 重验 |
| 写入记忆后只检索到相似旧记录 | 不宣称本次回读成功 |
| 用户取消 | 中断执行，不继续自动 steer |
| 插件卸载或热重载 | 不残留重复监听和重复 Gate |
| 审查子任务 | 不递归触发自己的审查 Gate |

最关键的端到端测试应使用一个可控 Agent 测试替身：

```text
第一次修改产生错误
    → Gate 真实检测失败
    → 观察到 OpenViking 查询调用
    → 下一步输入实际包含 Repair Packet
    → 第二次修改修复错误
    → Gate 重新执行并通过
    → 全局收尾完成
```

测试插件时，也要验证实际调用、文件状态和执行结果，而不是只检查模型输出里有没有“已检索”“已修复”。

## 十二、开发顺序与最终交付标准

建议按照四个里程碑实施，每一步都有独立验收结果。

| 里程碑 | 交付内容 | 完成标准 |
| --- | --- | --- |
| M0：宿主契约与协议 | DSH 接入、任务状态、Schema、OpenViking 绑定验证 | 确认本地接口可用，能建立和恢复任务状态 |
| M1：确定性验证 | Snapshot、Runner、Vitest/pytest、EvidenceStore、基线比较 | 能准确区分新增失败、已有失败、未完成执行 |
| M2：经验与修复闭环 | 四个查询检查点、Ledger、RepairReadTicket、RepairPacket | Agent 无法在正常受控修复流程中跳过插件检索 |
| M3：审查与收尾 | 只读 Review、Finalization Bridge、记忆回读验证 | 完整走通验证、修复、复盘、经验沉淀的流程 |

第一版正式交付时，应同时具备源码、协议定义、配置说明、兼容版本记录、测试夹具和自动化测试；不能只交付一个长 Prompt。

最终验收标准可以收敛成一句话：

每一次通过，都能追溯到当前项目状态的有效证据；每一次打回，都先完成经验检索并附带当前错误与本任务历史；每一次修复，都重新验证；每一次长期记忆成功声明，都有对应的实际回读结果。

这份方案的核心不是让 Agent “多检查一次”，而是把前面确定的规则落实为 状态机、执行协议、证据校验和不可静默省略的检查点。
