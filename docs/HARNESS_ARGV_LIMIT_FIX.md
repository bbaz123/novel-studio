# 工坊缺陷修复：超长任务文本走 argv 触发 `spawn ENAMETOOLONG`（2026-09-25）

> **一句话**：慢通道（harness）把整个任务文本塞进子进程 **argv**，而 Windows 的命令行上限是
> 32767 个 UTF-16 码元；超了 `spawn` **同步抛** `ENAMETOOLONG`（4ms 内失败、零输出）。
> 长章 + 完整上下文的提示词很容易到这个量级。修复：**只在 Windows、且任务文本超过安全余量时**，
> 把任务文本改从 stdin 送（`dsh --profile novel -`）；其余路径逐字不变。
>
> 这是**工件自身**的缺陷，与 DSH 版本无关（0.1.7-rc.1 / rc.2 表现相同）。

## 1. 缺陷与真实用户影响

| 项 | 内容 |
|---|---|
| 现象 | 走慢通道生成时**瞬间失败**，用户只看到一句 `Harness 任务失败：spawn ENAMETOOLONG` |
| 触发条件 | 任务文本（提示词 + 上下文）超过 Windows 命令行上限；实测 32650 码元成功、**32700 码元失败**，40000 字必失败 |
| 谁会遇到 | 长章生成、长上下文续写、把整章设定/前文一并交给模型的任务；短任务完全不受影响 |
| 影响面 | **硬失败**（不是降级）：这一次生成根本不发生，用户只能自己把任务改短 |
| 性质 | 工件缺陷——`harness.js` 自己选择把 prompt 放进 argv，不是 DSH 的限制 |
| 严重度 | 高（阻断生成），但**只影响长任务**；短任务行为逐字不变 |

## 2. 现场取证（修复前，可复跑）

```powershell
node .dsh-rc-compat/rt15-argv-limit.mjs
```

零计费：用 fixture dsh（与真 dsh 同 argv/cwd/env 契约，但不调用任何模型）；
不碰生产实例（3737/3080）、不碰 `~/.dsh`、不碰 `~/.dsh-novel`。
原始输出：`.dsh-rc-compat/evidence/rt15-argv-limit.txt`。

**① 裸 spawn 边界**（`node fixture.mjs <任务文本>`，Node v24.19.0 / win32）：

| 任务文本 | 结果 |
|---|---|
| 30000 / 32400 / 32600 / 32650 码元 | OK（`channel=argv`） |
| **32700 码元** | **FAIL `throw ENAMETOOLONG`**（Node 24 是同步抛出，不是 `error` 事件） |
| 32730 / 32740 / 32750 / 32760 / 32767 / 32800 码元 | FAIL 同上 |

**② 走工坊真实代码路径**（`harness.js` 的 `runHarnessTaskWithProgress`）：

| 用例 | 送出 | 通道 | 结果 |
|---|---|---|---|
| short-1k | 1000 码元 | argv | OK，逐字相同 |
| mid-16k | 16000 码元 | argv | OK，逐字相同 |
| long-40k | 40000 码元 | — | ❌ `ENAMETOOLONG`（4ms，零输出） |
| long-120k | 120000 码元 | — | ❌ `ENAMETOOLONG`（4ms，零输出） |
| quotes-25k（一半是引号） | 25000 码元 | — | ❌ `ENAMETOOLONG`（2ms） |

> `quotes-25k` 这条是**为了钉住转义膨胀**：文本本身只有 25000 码元（看着没超），
> 但 argv 里每个 `"` 要写成 `\"`，实际命令行约 37500 码元 → 也会失败。

## 3. 修复设计

| 决策 | 内容 | 理由 |
|---|---|---|
| 判据放在哪 | `ai/task-settings.mjs` 的纯函数 `promptFitsArgv(prompt, reservedUnits)` | 该模块本来就是"参数组装"的纯函数层（I/O 留在 `harness.js`），可离线断言 |
| 计量单位 | **UTF-16 码元**（`String#length`），不是 UTF-8 字节 | 被计量的是那条 UTF-16 命令行本身；一个中文字 1 码元 / 3 字节，按字节判会在 1/3 的规模上就误换通道 |
| 转义膨胀 | `estimateArgvUnits` 把 `"` 与 `\` 各多算 1 个码元 | libuv 给含空格/引号的参数加引号包裹，`"` → `\"`；只按裸长度判，引号密集文本会漏判 |
| 固定开销 | `reservedUnits` = exe 路径 + 入口 + 选项（按"两端引号 + 分隔空格"估上界） | 上限约束的是**整条命令行**，不是只有任务文本 |
| 阈值 | `32767 − 2048 = 30719` 码元（任务文本 + 预留） | 实测失败点 32700、成功点 32650；本机固定开销约 135 码元 → 判据最坏情况落在 ~30700，距失败点仍有约 2000 码元余量 |
| 通道 | 位置参数 `-`：`dsh --profile novel -`，任务文本从 stdin 读 | dsh 的 headless 运行器 `config.task === '-' ? readStdin() : task`（本地仓库 `packages/bundle/headless/src/index.ts:325`）；两版实测均支持，130000 字中文经 stdin 完整送达（`.dsh-rc-compat/evidence/rt8-run.txt`） |
| 生效平台 | **仅 Windows**（`argvLimitApplies`） | 32767 是 `CreateProcessW` 的限制；POSIX 的 `ARG_MAX` 约 2MB，那边走 argv 的现状没有缺陷要修——不制造无必要的跨平台行为差异 |
| 回退链路 | pnpm 回退启动仍走 argv，超长时打一条 `prompt_arg_limit_fallback` 告警 | 该链路经 cmd.exe 转一手，"stdin 能否转发到 dsh"**没有实测**，不擅自改行为；告警避免它再以一句没头没脑的 ENAMETOOLONG 失败 |

**明确没有动的**（这些都在 `harness.js` 的同一断面里，逐字保留）：
`shell:false` / `windowsHide:true` / `cwd` / `childEnv` / 超时与取消 / 环形缓冲（64KB）/
stdout·stderr 的 `onChunk` 上报 / 参数顺序（`--profile`、`--patch` 必须在任务文本之前）/
短文本路径**完全不传 `stdio`**（保持与改动前逐字相同的默认行为）。

**EPIPE 处理**：stdin 模式下父进程要写整个任务文本；若子进程先退出（未知选项、启动即失败），
写入会产生 EPIPE。Node 的流错误是**事件**，没人监听就是未捕获异常——**会打死工坊自己的进程**
（比任务失败严重得多）。因此 `child.stdin.on('error', …)` 兜住，真正的失败原因交给
`close`/`exit` 分支按 stderr 定性（那个信息比 EPIPE 准确）。

## 4. 行为变更清单（真实用户视角）

| 变化 | 谁受影响 | 方向 | 必要性来源 | 能否用更小的实现 |
|---|---|---|---|---|
| 任务文本 >30719 码元时改从 stdin 送 | Windows 上跑**长**任务的人 | **正面**：从"必失败"变成"正常生成" | 真实缺陷（硬失败） | 不能：argv 放不下是硬限制 |
| 任务文本 ≤30719 码元时**完全不变** | 所有人 | 中性（逐字不变，已实测） | — | — |
| pnpm 回退链路超长时多一条 warn 日志 | 极少（无 `scripts.dsh` 的仓库） | 中性（只多一行诊断） | 让失败可解释 | 可以，但留着更好定位 |
| 非 Windows 平台 | 无 | **无变化**（换通道不生效） | — | — |

**没有用户可见的 UI / 默认路由 / 默认模型 / 上下文预算 / 生成参数变化。**

## 5. 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 离线契约（含新增 12 条断言） | `node .p1-baseline/test-task-settings.mjs` | **49 通过 / 0 失败**（既有 37 条期望值**一字未改**） |
| 通道与逐字一致（fixture） | `node .dsh-rc-compat/rt15-argv-limit.mjs` | 短/中仍走 argv、超长走 stdin，**全部逐字相同**；总体 PASS |
| EPIPE 阴性对照 | rt15 的 §2b | 子进程提前退出时任务照常收尾、**进程存活**、无 EPIPE 冒泡 |
| 变异对照（那行 error 处理是否承重） | `node .dsh-rc-compat/rt15b-epipe-mutant.mjs ../harness.js` 与去掉该行的变异体 | 正常模块 `SURVIVED`（exit 0）；**变异体 `UNCAUGHT EOF write EOF`（exit 3）** |
| 真 dsh + 假端点端到端 | `node .dsh-rc-compat/rt16-real-dsh-stdin.mjs` | 1000 码元（argv）与 120000 码元（stdin）两条通道**都把全文逐字送达模型**（请求体 6984B / 125984B，头尾标记与全文比对全中、无乱码），dsh 正常收尾 |
| 一键验收（隔离实例，授权 spawn） | `node scripts/ci-isolated-run.mjs --port 3785 --data .p1-baseline/stress-data -- node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3785` | 见 §7（含 2 条与本改动无关的既有红灯及归因） |
| API 套件（隔离实例 3738） | `node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs` | **186/190 通过、0 失败、4 跳过**（与基线一致） |
| 插件冒烟 | `node scripts/ci-isolated-run.mjs --port 3783 -- node harness-plugins/novel-writing/test/smoke.mjs` | **39/39 通过** |

原始输出（本轮，均已归档）：`.dsh-rc-compat/evidence/` 下的 `rt15-argv-limit.txt`、`rt16-real-dsh-stdin.txt`、
`rt17-verify-all-final.txt`（52/2/1 全量输出）、`rt17-api-suite.txt`、`rt17-plugin-smoke.txt`、`rt17-ci-offline.txt`。

**为什么"生成质量不变"是可证的、不是推测的**：模型能看到的只有提示词字符串本身。
rt16 把真 dsh 送出的请求体抓下来逐字比对——**字符级相同**（含长度、UTF-8 字节数、头尾标记），
所以换通道不改变任何模型输入，也就不改变生成质量。这比"看起来差不多"强。

## 6. 修改文件

| 文件 | 改动 |
|---|---|
| `ai/task-settings.mjs` | 新增 `normalizeTaskPrompt` / `STDIN_TASK_ARG` / `estimateArgvUnits` / `promptFitsArgv` / `WIN_ARGV_LIMIT_UNITS` / `ARGV_UNITS_MARGIN`；`buildTaskArgs` 增加 `stdin` 开关（选项顺序不变） |
| `harness.js` | import 增加两个纯函数；spawn 断面新增：预留量计算、通道判定、`useStdinPrompt` 时显式 `stdio` + 写 stdin + EPIPE 处理；`argvLimitApplies`（仅 win32）与回退链路告警 |
| `.p1-baseline/test-task-settings.mjs` | 新增 §3b（11 条）与 1 条接线断言；**未改任何既有期望值** |
| `ai/README.md` | 该模块职责补一句"超长任务文本改走 `-` + stdin 的通道判定 `promptFitsArgv` 也在此" |

无数据库 schema 变化、无配置默认值变化、无 migration。

## 7. 一键验收的 2 条红灯（与本改动无关，附归因）

`verify-all`（授权 spawn）实测 **52 通过 / 2 未通过 / 1 跳过**；对照 2026-09-25 的
`story-state-kernel` 记录（54 通过 / 0 未通过 / 1 跳过），差额**恰好是这 2 条**：

| 红灯 | 现象 | 归因（证据） |
|---|---|---|
| 阶段映射核对 | 8 个改动没有归属 + 生成文档过期 | 8 个文件**全部由上一轮（DSH 兼容性审查）产生**：`.p1-baseline/.realtest/probe-config.mjs`、`probe-schema.mjs`、`docs/DSH_0.1.7_RC1_RC2_API_DIFF.md`、`..._COMPATIBILITY_MATRIX.md` 等；本改动**没有新增任何无归属文件**（新增文件全在 `.gitignore` 掉的 `.dsh-rc-compat/` 内） |
| 连续性预检在真实作品上成立 | 命中 4 / 漏报 1（第 5 章 `system_frequency`）/ 误报 0 | 该脚本只 `import` 守卫模块与 `node:sqlite`，**不碰 harness**；其输入 `data/novel.db-wal` 的写入时间 **13:59:40** 晚于该条通过时的基线运行（12:03 / 12:34）——是作者本人在工坊里改过作品数据，不是代码回归 |

两条都**不是**本次改动引入，也不因本次改动而恶化；按红线"不为过关而扩张范围"，本轮不改它们，
留给用户决定（阶段映射可用 `node .p1-baseline/verify-phase-map.mjs --write` 刷新生成文档，
但那 8 个文件的归属仍需人来认领）。

## 8. 回滚

| 粒度 | 做法 | 效果 |
|---|---|---|
| 最小（1 行） | `harness.js` 里 `const useStdinPrompt = promptBeyondArgv && Boolean(launch) && argvLimitApplies;` → `const useStdinPrompt = false;` | 完全回到修复前行为（超长任务文本重新变成 `ENAMETOOLONG`） |
| 彻底 | 删掉 §6 中两个文件的新增部分（纯函数 + 通道判定），恢复 `buildTaskArgs` 三参形态 | 同上；离线契约测试的 §3b 会同时变红，提示已回滚 |

无 migration、无快照需求：改动只影响"这次任务文本走哪条通道"，不写任何持久状态。

## 9. 未完成与风险

| # | 项 | 说明 | 风险 |
|---|---|---|---|
| R1 | pnpm 回退链路上的超长任务文本仍走 argv | 该链路仅在没有可直接 node 启动的 `scripts.dsh` 时走到，且本身已有中文 ANSI 损坏的已知问题；"stdin 转发"未实测故未改 | 低（不是目标链路，且有 warn） |
| R2 | 阈值是静态余量，不是精确算命令行长度 | 极端引号/反斜杠密集文本会被**提前**换通道（安全方向）；反方向漏判需要约 8700 个引号 | 低 |
| R3 | 非 Windows 平台不生效 | POSIX 上超长文本仍走 argv（`ARG_MAX` ≈2MB），现状无缺陷 | 低 |
| R4 | 单条 12 万字回复 100s 不退出 | DSH 侧既有问题（`.dsh-rc-compat/rt14-longout120.mjs` 已记录），与本修复无关 | 既有 UNKNOWN |
| R5 | 真实模型的生成质量未做人工评审 | 本修复**不改变模型输入**（rt16 逐字证明），故按因果边界不需要重新做生成质量对照；若仍要人眼确认，可用同一 fixture 出一章对照 | 低 |