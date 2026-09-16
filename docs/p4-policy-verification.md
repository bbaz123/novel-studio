# P4 验收报告：通道策略单点化与全分支核对

> 阶段：P4（收敛通道 + 建立单点策略表）
> 日期：2026-09-15　状态：**策略单点化完成并验证**；通道侧的三项遗留见 §五

---

## 一、目标

把「哪个环节用哪个模型、用多强的思考」从**散落的字面量**收敛到**一处定义**，
并让「主路径 + 每个回退分支各用什么」可以被机器核对，而不是靠通读代码。

必要性来自两条既有事实：

- `public/app.js` 顶部注释自己写着：「散落的字面量一旦被批量替换，就会把刻意的质量选择
  悄悄改掉（本会话已因此误伤过 4 处）」——但注释旁边就是 **12 处硬编码 `'deepseek-flash'`**。
- 2026-09-13 复盘的补充教训：「改模型/通道路由，必须把**全部分支**一起核对，并在注释里
  写明回退分支用的模型」。

---

## 二、做了什么

| # | 改动 | 文件 |
|---|---|---|
| 1 | 新增策略真源：档位→模型、强度白名单、工作台档位→强度、归一化函数 | `ai/policy.mjs`（新） |
| 2 | `server.js` 不再自行定义模型表/白名单/归一化，改为从策略导入 | `server.js` |
| 3 | `harness.js` 删掉**重复的强度白名单**，改为引用策略 | `harness.js` |
| 4 | 新增 `GET /api/ai/policy`：前端取得与后端同一份策略 | `server.js` |
| 5 | 前端 12 处 `'deepseek-flash'` + 4 处 `QUALITY_AI_MODEL` → `policyModel('fast'/'quality')` | `public/app.js` |
| 6 | 工作台的模型与强度改为 `policyModel('fast')` / `policyEffort(mode)`，删掉 `PIPELINE_MODEL` 常量 | `public/app.js` |
| 7 | 前端启动时拉取策略快照；失败不阻塞，退回兜底常量 | `public/app.js` |
| 8 | **更正注释与实现的不符**（见 §四） | `public/app.js` |
| 9 | 新增**全分支核对表**工具 | `.p1-baseline/verify-ai-branches.mjs`（新） |

---

## 三、验收证据

### 3.1 无散落字面量（0 处绕过）

```
═══ 绕过策略的模型字面量（0 处）═══
结论: ✓ 所有模型取值都经 policy.mjs 解析（无散落字面量）
```

工具扫描 `public/app.js` / `server.js` / `harness.js` 全部 63 处模型/强度取值。
允许的例外只有 4 处，且**逐条列出原因**（策略未就绪的兜底常量 ×2、面向用户的模型下拉 ×2），
不静默放过。

> 工具本身也修正过一次误报：最初用 `/deepseek-[a-z0-9.-]+/` 匹配，把
> `'deepseek-harness'`（目录名）误判为模型名——已收紧到已知模型名集合。

### 3.2 行为等价：集中化前后取值完全一致

集中化最大的风险是「顺手把刻意的质量选择改掉」。逐项断言：

| 断言 | 结果 |
|---|---|
| `MODELS.fast` 仍是 `deepseek-flash` | ✓ |
| `MODELS.quality` 仍是 `deepseek-v4-pro` | ✓ |
| 工作台档位→强度 未被改动（low/high/max） | ✓ |
| 强度白名单 未被改动（off/low/high/max） | ✓ |
| `harness.REASONING_EFFORTS` 与策略一致 | ✓ |
| 已知模型表仍含旧名 `deepseek-v4-flash`（存量配置仍可归一） | ✓ |

**6/6 通过。**

### 3.3 无回归

P4 未触碰装配器：

```
压力数据  35/35 逐字节一致
真实数据  20/20 逐字节一致
```

---

## 四、更正的两处「注释与实现不符」

1. **app.js 顶部策略注释**：原文写 `QUALITY_AI_MODEL` 管「成文轮」，与实现不符——
   **章节正文成文实际走 fast**；走 quality 的只有「设定生成的成文轮」。
   已按实现改写，并在注释里保留了这次更正本身（避免下次又被改回去）。
2. **`harness.js` 的强度白名单**：与 `server.js` 各有一份、各改各的，现统一到 `policy.mjs`。

---

## 五、P4 未做的三项（诚实标注）

原计划里 P4 还包含三项，本轮**没有做**，它们各自需要独立设计与验证：

1. **两条同步旁路**（`/harness/generate_novel`、`/story_memory/compress`）绕过作业设施
   （无进度、无取消、无落库、不计并发）。合并进作业设施会改变这两条链路的返回契约，
   需要单独一轮。
2. **并发上限与串行现实对齐**：服务端允许 2 个作业，但所有作业都带 `model` →
   `harness.js` 的全局串行锁使实际吞吐为 1。对齐方向取决于 dsh 能否提供任务级模型参数。
   **→ 已改为"有证据的结论"，见下方 §五·补。**
3. **usage 采集打通**：harness 慢通道丢弃 usage 事件，Token 与费用不可得——属 dsh 侧改动。

### 补充（2026-09-15 晚）：第 1 项的闸门部分已实现**并已验收**

`server.js` 已加统一闸门（`HARNESS_CONCURRENCY` / `harnessLoad()` / `withHarnessSlot()`）：

| 位置 | 作用 |
|---|---|
| `harnessLoad()` | 全服务唯一的「运行中/排队中」计数（含排队，不只是运行） |
| `withHarnessSlot(fn)` | 满员即抛 `status=429` 的错误，路由据此回 429 |
| `/harness/run`、`/harness/generate_novel`、`/story_memory/compress` | 三条路都占槽位 |

**验收结果（在可证明的隔离环境里实测，12/12 通过）**：

```
【空载】              ✓ 空载时 compress 不被闸门拦（404）
【槽位占满后】         ✓ 占满 2 个槽位
                     ✓ compress       被闸门拦（429 + 闸门文案）
                     ✓ generate_novel 被闸门拦（429 + 闸门文案）
                     ✓ 第三个 /harness/run 被拦（429 + 闸门文案）
【作业结束后】         ✓ 两个作业均进入终态；✓ 闸门放行（槽位已释放）
【跑后审计】           ✓ 本次运行未产生真实 LLM 调用
【证明闸】             ✓ 指向的实例与隔离启动器登记的一致
                     ✓ 黑洞端点收到本次连接（POST /chat/completions → 127.0.0.1:<黑洞端口>）
```

隔离环境由 `.p1-baseline/gate-env.mjs` 一条命令搭建（黑洞 LLM 端点 + 隔离实例 + 六项环境变量），
`verify-harness-gate.mjs` 设四道闸（前置授权 / 响应体文案 / 跑后审计 / 黑洞连接证明）。
**该检查默认拒绝运行**，需要显式授权 —— 原因与事故经过见 `.p1-baseline/README.md` §六。

另外修掉一处**真实隔离缺口**：`compressStoryMemory` 与 `generateNovelFromHarness` 原先没有下发
`NOVELSTUDIO_BASE_URL`，隔离实例上这两条任务的 novel_* 工具会回落到插件安装时写死的 3737
（= 生产实例）。修法是在唯一的 spawn 出口 `ai/harness-env.mjs` 给默认值（调用方显式值仍优先），
生产端口 3737 下取值与历史逐字相同，属零行为变更。

由于第 1 项的另一半（合并进作业设施以获得进度/取消/落库）**仍未做**，
§五 第 1 项只完成了「不再绕过并发限制」，未完成「统一到作业设施」。

---

## 五·补 · 吞吐到底是 1 还是 2：从论断变成证据（2026-09-15 晚）

原先的写法是「所有作业都带 `model` → 实际吞吐为 1」。结论方向对，但**机制没有被验证过**，
而且"所有作业"这个前提在 API 层并不成立。现在机制由离线单测钉住
（`.p1-baseline/test-model-switch-gate.mjs`，16/16；阴性对照：拆掉串行化 → 断言失败 2 项，
实测出现交错 `a进 b进 c进 c出 b出 a出`）。

### 机制（两处代码，各一条结论）

| 位置 | 语义 |
|---|---|
| `requiresModelSwitchGate(model, reasoningEffort)`（`harness.js`） | 传了 `model` **或**归一化后的强度 → 需要改写 `~/.dsh/settings.yaml` |
| `withModelSwitch(fn)`（`harness.js`） | 需要改写时进入 promise 链互斥：**改 → 跑 → 还原**三段不交错 |
| 调用点（`runHarnessTaskWithProgress`） | `needsSettingsSwitch ? withModelSwitch(runTask) : runTask()` —— **不需要改写就允许真并行** |

### 三个调用点实际传了什么

| 调用点 | 传的 model | 实际吞吐 |
|---|---|---|
| `compressStoryMemory` | 恒为 `QUALITY_AI_MODEL` | **恒串行** |
| `generateNovelFromHarness` | `model \|\| undefined` | 取决于调用方 |
| `/harness/run`（作业设施） | `body.model \|\| undefined` | 取决于调用方 |

### 实践中的真实吞吐 = 1

前端**每一处**都显式传了模型（`policyModel('fast')` / `policyModel('quality')`，共 20+ 处），
所以经界面发起的任务全部进入互斥 → 服务端的 `HARNESS_CONCURRENCY = 2` 在实践中退化成 1。

`2` 仍然有意义的地方：**API 层不强制传 model**，此时第二个作业可以真并行——上限 2 约束的是
"被接受的作业数"，而不是"同时改写 settings.yaml 的任务数"。

### 当时列出的三个对齐方向（**现已定 C**，见下）

| 方案 | 效果 | 代价 |
|---|---|---|
| A. 保持 `HARNESS_CONCURRENCY=2`，只把现实写进文档与注释 | 零行为变更；第二个请求"被接受并在队列里等"，比直接 429 友好 | 界面上第二个作业显示"运行中"但其实在排队 |
| B. 改成 1 | 语义诚实：拒绝就是拒绝 | 第二个请求变 429；无 model 的任务也失去并行 |
| C. 让"等待模型槽位"可观测（作业状态里区分 running / waiting-model） | 既不丢并行、也不误导 | 需要把互斥状态从 `harness.js` 透出到作业记录，改动最大 |

**本报告当时只做到 A 的文档部分**：把机制、三个调用点的实际取值、以及"界面路径吞吐=1"写清楚，
并留下这个三选一。

### 已定：**C**（2026-09-16，决策 D4，排在 P6 之后再动）

你选了 C。落地结果（提交 `bfefdcc`）：

- `harness.js` 的互斥体现在维护 `busy` / `waiters` 计数，并导出 `modelSwitchLoad()`；
  进入队列**之前**上报 `onPhase('waiting-model', {waiters})`，真正拿到槽位时上报 `onPhase('running')`。
- 作业记录新增 `model_slot`（`''` / `'waiting'` / `'running'`）与 `model_waiters`；
  `GET /harness/job` 以**结构化字段**回给前端，`GET /harness/status` 增加 `model_load` 与 `concurrency`。
- 前端轮询读 `model_slot`，排队期间显示"⏳ 等待模型槽位（前面还有 N 个任务）…"。

⚠️ 顺带纠正本报告 §五·补 的一处**基于代码阅读的推断**：当时写"界面上第二个作业显示'运行中'"，
方向没错，但**没有验证过前端到底显示什么**。实际实现里前端从不读 `job.stage`，
排队期间进度卡只显示静止的 `tail` —— 表现是"像卡死"，而不是"显示运行中"。

`HARNESS_CONCURRENCY` 保持 2（未改）：并行仍然留给不请求模型/强度的任务。
端到端验收见 `.p1-baseline/verify-model-slot.mjs`（黑洞端点隔离实例，零计费）。

---

## 六、复现

```powershell
# 全分支核对表
node .p1-baseline/verify-ai-branches.mjs

# 策略端点
curl http://127.0.0.1:3738/api/ai/policy

# 行为等价断言（含 harness 导出对照）
#   见本报告 §3.2 的 6 项，可复现为一次性 node 脚本

# 装配回归
node .p1-baseline/capture-baseline.mjs --base http://127.0.0.1:3739 --db .p1-baseline/stress-data/novel.db --out .p1-baseline/baselines-p4
node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-p3 .p1-baseline/baselines-p4

# 闸门断言的离线阴性对照（零成本，可随时跑）
node .p1-baseline/test-gate-assert.mjs

# harness 子进程环境契约（零成本）
node .p1-baseline/test-harness-env.mjs

# 闸门端到端验证（会真的创建 harness 任务）——按下面三步走：
node .p1-baseline/gate-env.mjs                  # ① 前台起黑洞端点 + 隔离实例，打印授权命令
node .p1-baseline/verify-harness-gate.mjs http://127.0.0.1:<port> --require-blackhole <黑洞端口> --preflight
                                                # ② 预检：零成本，判定环境是否值得授权
# ③ 预检通过后，按打印出的命令显式授权再跑正式验证：
#    $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
#    node .p1-baseline/verify-harness-gate.mjs http://127.0.0.1:<port> --require-blackhole <黑洞端口>
node .p1-baseline/gate-env.mjs --stop           # 收工
```

> 成本纪律与事故经过见 `.p1-baseline/README.md` §六。要点：
> `DEEPSEEK_BASE_URL` 指向黑洞端点**确实生效**（黑洞日志收到 `POST /chat/completions` 即证据），
> 但历史事故的真因是**测试打到了没设该变量的实例或进程**——所以必须用 `gate-env.mjs`
> 一次配齐六项变量，并以「黑洞收到连接」作为通过的前提。
