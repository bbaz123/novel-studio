# .p1-baseline —— P1 上下文契约：冻结、基线与压力数据

本目录是 **P1 阶段（冻结上下文契约 + 建基线 + 建压力数据）** 的证据与工具目录。
配套文档是 `docs/context-contract.md`（契约本体）。P1 收尾时应把可复用的工具固化进
测试套件，并清理本目录中的临时实例数据。

## 一、交付物

| 文件 | 作用 |
|---|---|
| `context-floor.mjs` | 契约的**机读规格** + 各模式可执行下限自动核算（零依赖、无需服务） |
| `capture-baseline.mjs` | 对隔离实例抓取各路径装配结果，落 JSON 基线 + 逐层剖面 |
| `compare-baseline.mjs` | **P2** 基线对照器：逐字节比较两套基线的 `assembled`，定位首个差异；`--ignore-notice` 可把「只差截断提示语」与「正文真的变了」区分开（提示语前缀从层规格派生，不手写正则） |
| `verify-invariants.mjs` | **P2** 契约不变量校验器：I1/I2/I3/I7 + 输出 I4 工作清单 |
| `verify-p3-unified.mjs` | **P2** 主成文路径统一验证：`ai_context` 与 `novel/context` 必须逐字节相同 |
| `verify-retrieval.mjs` | **P3** I4 端到端实测：逐个被裁层实际调用查回端点，不看声明 |
| `verify-retrieval-map.mjs` | **I4 的静态保证**（零成本、不碰网络与数据库）：每层都有查回声明、可截断层真有查回路径、工具名真的存在、无陈旧声明——补上「端到端那条是数据相关」的洞 |
| `verify-layer-constants.mjs` | **层规格常量的单点来源**（零成本）：拦住在别处重写 `entityCap` / continuation 上限的字面量（它们曾有三份拷贝），并核对规格自洽 |
| `verify-plugin-tools.mjs` | **P3** 工具面验证：mock ctx 真正加载插件，列出注册的工具并与 plugin.json 对照 |
| `verify-ai-branches.mjs` | **P4** AI 全分支核对表：清点所有模型/强度取值，报出绕过 `ai/policy.mjs` 的字面量 |
| `verify-all.mjs` | **一键验收**：把上面这些验证跑一遍并输出汇总表。区分「未通过」与「跳过」——缺活实例/外部仓库的检查标 SKIP，不伪装成通过。**默认不跑任何会花钱的检查**（见 §六）。语法检查的文件清单**从实际源码派生**（不是手写枚举），并带「代表性文件必须在内」的护栏 |
| `test-assembler.mjs` | **装配器单元测试**：覆盖基线跑不到的边界——溢出分支、无查回路径的提示、收敛只动弹性层、预算核算自洽（32 项） |
| `verify-harness-gate.mjs` | **并发闸门验证**（会真的建 harness 任务，默认拒绝运行）：四道闸——授权 / 429 响应体文案 / 跑后审计真实调用 / 黑洞连接证明；含 `--preflight` 零成本预检 |
| `test-gate-assert.mjs` | **闸门断言的离线阴性对照**（零成本）：给每条断言喂「应该失败」的输入，含上游 429 与闸门 429 的区分、环境错配、预检穿透 |
| `gate-env.mjs` | **隔离环境一键搭建**：黑洞 LLM 端点 + 隔离实例（六项隔离变量）+ marker 登记；`--stop` 收工 |
| `blackhole.mjs` | 「黑洞」LLM 端点：接受连接、记录首字节、**永不响应**。既让作业占得住槽，又让隔离可自证 |
| `test-harness-env.mjs` | **dsh 子进程环境契约**单测（零成本）：钉住「任务必须回连发起它的实例，不得回落写死的 3737」 |
| `test-edit-distance.mjs` | **编辑距离**离线单测（零成本，30 项）：精确/近似/空串/单字符/对称性/三角不等式/归一 |
| `test-model-switch-gate.mjs` | **模型切换互斥语义**离线单测（零成本，30 项）：闸门真值表、互斥真的不交错、失败不卡队列、**排队计数不泄漏**（D4）——它决定实际吞吐是 1 还是 2 |
| `verify-model-slot.mjs` | **「等待模型槽位」可观测性的端到端验收**（会真的建 2 个 harness 任务，默认拒绝运行）：先做三方接线检查（后端回字段 ≠ 作者看得见），再在黑洞端点实例上断言"第二个作业必须显示 waiting"，跑完由 `audit-llm-calls` 复核零计费 |
| `verify-main-instance.mjs` | **主实例重启后的对照检查**（只读、零计费、不建任何 AI 任务）：对着活实例核 D4 字段、下发的 `app.js` 是否含排队提示、真实库作品清单是否仍可读——**"代码提交了" ≠ "实例生效了"** |
| `verify-phase-map.mjs` | **阶段 → 改动面 → 回滚**映射的核对器（零成本）：拿真实改动集对账，出现「没归属的改动」即失败；`docs/phase-map.md` 由它生成，防止清单腐烂 |
| `verify-memory-hint.mjs` | **长期记忆压缩提示是否真进上下文**（离线读基线 / 活实例自发现两模式）：层按 cap 从头部截断，提示挂在末尾会被自己截掉——这条把它钉住 |
| `compare-memory-hint.mjs` | **刻画式基线对照**：要求两套基线的差异**恰好**是「压缩提示从末尾挪到开头」（含代价量化），比"看起来一样"更强 |
| `verify-eval-metric.mjs` | **编辑距离测量点端到端**（需活实例；不触发 harness，零费用）：采纳→保存→回填、幂等、无采纳不测量 |
| `audit-llm-calls.mjs` | **真实调用审计**（只读）：从 dsh 会话转录数出「何时、用哪个模型、真的发了多少请求」，兼作套件总闸 |
| `read-dsh-session.mjs` | 解析单条 dsh 会话转录（多帧 zstd）；用于「这次任务到底有没有真的调模型」的取证 |
| `census.mjs` | 现场普查：进程 ↔ 端口 ↔ 数据目录 ↔ 日志 一次对齐，避免打错实例 |
| `probe-live.mjs` | 只读探测活实例身份（作品清单判定数据目录、策略快照） |
| `diff-log-noise.mjs` | 证明真实库「一行未失」：app_logs 差集方向归因（副本多 ≠ 真实库少） |
| `survey.mjs` | 数据库体检：作品/章节规模、OpenViking 索引状态 |
| `schema-dump.mjs` | 打印关键表列定义（构造压测数据用） |
| `make-stress.mjs` | 压力数据生成器（可复现、确定性伪随机） |
| `probe-*.mjs` | 语义召回缺陷的定位工具（见 §三） |
| `baselines/` `baselines-stress/` | P1 基线（真实 / 压力） |
| `baselines-p2*` | P2 重抓结果，用于与 P1 逐字节对照 |
| `baselines-pre-hint` / `baselines-post-hint` / `baselines-real-post-hint` | 自审 F6（压缩提示挪位）的**前后对照证据**：修复前/后各一套，用于刻画差异与做阴性对照 |
| `baselines-pre-const` / `baselines-post-const`（及 `-real-` 两份） | 自审 F8（层规格常量单点化）的**惰性证据**：重构前后各一套，逐字节一致证明改动没有改变任何输出 |
| `data/` | 真实库的**副本**（三件套 + checkpoint），供隔离实例使用 |
| `stress-data/` | 副本 + 压力作品的独立库 |

> 目录名的历史包袱：P2 起这里实际是「**上下文契约与验收工具**」的常驻目录，
> 不只是 P1 的基线。P2 的阶段报告在 `docs/p2-assembler-verification.md`。

## 二、隔离实例

真实库与主实例**全程未被触碰**。基线在副本上进行：

```powershell
# 真实数据基线（端口 3738）
$env:NOVELSTUDIO_DATA_DIR='.p1-baseline/data'; $env:PORT='3738'; node server.js
# 压力数据基线（端口 3739）
$env:NOVELSTUDIO_DATA_DIR='.p1-baseline/stress-data'; $env:PORT='3739'; node server.js
# 抓取
node .p1-baseline/capture-baseline.mjs --base http://127.0.0.1:3738 --db .p1-baseline/data/novel.db
```

**复制真实库必须带 WAL**：`data/` 当时有一个 3.2MB 未合并的 `novel.db-wal`，
只复制 `novel.db` 会丢掉里面的数据。三件套一起复制后再 `PRAGMA wal_checkpoint(TRUNCATE)`。

### ⚠️ 数据库隔离 ≠ 记忆库隔离（P3 发现）

OpenViking 记忆库按 `works.ov_uri` 寻址，而 **`ov_uri` 随数据库一起被复制**：

```
真实库 data/novel.db        → work#2 的 ov_uri = "2"
副本   .p1-baseline/data/   → work#2 的 ov_uri = "2"   ← 指向同一个记忆库目录
```

**从隔离实例触发任何全量同步，写的都是生产的记忆库**（`<工作区>/data/viking/...`）。
做隔离验证时务必避免调用 `syncWorkFull` / 让 `autoIndexExistingWorks` 跑起来；
需要真正的记忆库隔离时，得把副本里的 `works.ov_uri` 全部改写为独立前缀。

## 三、P1 发现（全部有实测证据）

### F1 · 每一层都超出自己的 cap（违反契约 I2）

压力数据下 **9 层同时超 cap**：大纲 2866>2800、长期记忆 2265>2200、语义召回 1463>1400、
最近事件 1861>1800、未闭合伏笔 1265>1200、本章蓝图 1563>1500、人物关系 855>800、
世界观 3067>3000、红线 4055>4000。

超出量恰好是那段「…（本层共 N 字，已按预算截断…）」提示语的长度——`server.js:1705`
把提示语拼在 `body.slice(0, cap)` **之后**，不计入 cap。**cap 不是硬上界。**

### F2 · 主成文路径的输入规模是受预算路径的 3 倍（违反契约 I6）

同一章（w16/c227）：

| 路径 | 角色卡 | 世界观 | 长期记忆 | 前文 | 合计 |
|---|---|---|---|---|---|
| P1 `/api/novel/context`（有预算） | 3558 | 3067 | 2265 | 809 | **24,738** |
| P3 `/api/ai_context`（**无预算**） | **37,088** | **27,270** | 9,000 | 800 | **≈74,000+** |

P3 是**实际写正文**的那条路径。26,000 的预算常量对它完全无效。

### F3 · 语义召回层对真实作品完全失效

`work#2`（用户在写的作品）的 `getSemanticRecall` 返回 `status=no-hits, hits=0`。
直接打 OpenViking 的 `find` 能看到原因——**前 5 条原始命中全部是记忆库自己的元数据文件**：

```
0.4446  world/.abstract.md
0.4438  chapters/.overview.md
0.4378  settings/.overview.md
0.4339  .overview.md
0.4315  characters/.overview.md
```

它们全部以 `.` 开头，被 `isRecallNoise`（`openviking-sync.js:486-492`）正确丢弃，
于是 `items` 为空 → 整层不存在。**真正的内容文件从未排进前 8。**
→ 这 1400 字的召回预算对该作品是**永久性空转**。

对照：压力作品 `work#16` 的命中是真实内容文件（`meta.md`、`chapters/*.md`，相关度 95-96%），
召回层正常工作。所以这是**数据相关**的失效，不是全局失效。

### F4 · 上下文缓存无 TTL，陈旧结果会被无限期复用

`CONTEXT_CACHE`（`server.js:174-194`）只按 `CONTEXT_DATA_VERSION` 失效，而该版本
**只在写操作时递增**（`touchWork`）——**没有时间维度**。

实证：抓基线时压力作品还在建索引，`getSemanticRecall` 返回 `no-hits`，整个 ctx 被缓存；
之后同一个请求持续返回 `no-hits`。**重启实例后**同一请求变成：

```
status=ok  hits=8  assembled=23275 → 24738   （召回层出现）
```

同一进程生命周期内，一次早于索引完成的装配结果会一直粘住。

### F5 · 收敛循环确实会被触发（弹性收缩路径已被覆盖）

- `w16/c227` continuation：前文衔接从 4009 被压到 **2455**（cap 4000）
- `w16` settings：大纲从 2866 被压到 **466**（一路压到最小档 400）
- `w16/c108` fragment：前文衔接 1655（cap 1600）

即：`FLEX_CAPS = [2400,1600,800,400]` 的逐档压缩真实生效。

### F6 · 真实数据下**从不**触发任何截断或收敛

真实库两部作品合计 5,196–9,210 字，全部层都远低于各自 cap，合计远低于 26,000。
**这就是「规模断言必须压测」的实证**：只看真实数据，F1/F2/F5 一个都发现不了。

### F7 · `ov_indexed_at` 与实际记忆库目录不一致

`work#9` 有 `ov_indexed_at:9 = 2026-09-13T11:50:47Z`，但 OpenViking 的
`novel-studio/` 下**没有名为 `9` 的目录**（work#2 的 `2` 存在）。
索引时间戳不能作为「数据真的在库里」的凭据。

## 四、复现

```powershell
node .p1-baseline/context-floor.mjs                                  # 可执行下限
node .p1-baseline/survey.mjs .p1-baseline/stress-data/novel.db       # 库体检 + 索引状态
node .p1-baseline/probe-recall-direct.mjs .p1-baseline/data 2 107    # 直接跑生产召回代码
node .p1-baseline/probe-recall-query.mjs .p1-baseline/data 2 107     # 看真实查询词与前 5 条命中
node .p1-baseline/probe-ov-recall-chain.mjs                          # find→读取→过滤 全链路
```

## 五、归属：这些发现由后续哪个阶段处理

| 发现 | 归属 | 处理方向 |
|---|---|---|
| F1 提示语溢出 cap | P2 | 提示语计入 cap；cap 成为硬上界（契约 I2） |
| F2 主成文路径无预算 | P2 | `aiContextBlock` 改走唯一装配器（契约 I6） |
| F3 召回层对真实作品失效 | P3 | 检索侧排除元数据文件（而不是检索后过滤），并复核 top-k 是否够用 |
| F4 上下文缓存无 TTL | P2 | 加时间维度或召回态失效（契约 I7 可观测） |
| F5 收敛可触发 | P2 | 保留行为，补「压到下限仍超限」的显式溢出标记（契约 I1） |
| F6 真实数据无截断 | — | 结论：**规模相关断言一律在 `stress-data` 上跑** |
| F7 索引状态不一致 | P3 | 索引状态与实际目录对账 |

## 六、成本纪律：会花钱的检查默认不跑（2026-09-15 事故后新增）

### 事故

作者曾把「`DEEPSEEK_BASE_URL` 指向死端口 = 零成本」当作既定事实，据此跑了多轮
「零成本」闸门验证。**审计发现这些运行真的产生了 LLM 调用**：
`~/.dsh/sessions/--C-Users-a1941-Desktop-DeepSeek-deepseek-harness--/` 下 19 个会话
同时含 `request/header` 与流式产出，提示词可直接归属到闸门测试
（`作业一`/`作业二`/`第三个作业`/长期记忆压缩）。其中一次跑了 15 次工具调用，
含 `mcp__openviking__write`，**写进了生产记忆库**。

三个根因：

1. **测试指向了不受控的实例**（唯一真因）。套件 `--base` 指向的 3739 实例由旧后台作业启动，
   其命令行没有 `DEEPSEEK_BASE_URL`（用 `job_list` 才看清）。而且它是旧代码，
   那轮「14/15」本身也无效。事后核对：那一轮产生的 **5 次真实调用全部来自闸门项**
   （2 个作业 + compress + generate_novel + 第三个作业），与转录逐条对得上。
2. ~~套件自身会调起 dsh 而未设隔离变量~~ —— **此条已订正为不成立**：
   `.p0-recon/verify-harness-profile.mjs` **自己**就把 `DEEPSEEK_BASE_URL` 指向死端口
   （源码第 20 行），因而本来就是零计费的。教训：写根因前先读那条检查的源码，
   别把自己的猜测写成结论。
3. **`DEEPSEEK_BASE_URL` 是否被 dsh 采纳**——已实测证实**生效**（见下节补测结论）。
   所以隔离手法可用，问题出在"没配上"，而不是"配了没用"。

### 现在的硬约束

- `verify-all.mjs` 默认**不跑**任何会创建 harness 任务或调起 dsh 的检查：
  并发闸门要 `--gate-base` **且** `NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1`；
  spawn 路径要 `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`。缺授权一律 SKIP 并写明原因。
  （spawn 检查其实自设死端口、零计费；要求授权是因为它会真的 spawn dsh，
  而"零计费"依赖环境变量被 honored 这个外部假设。）
- `verify-harness-gate.mjs` 自身也拒绝未授权运行（exit 2），并设**四道闸**：
  授权 → 429 必须带闸门文案 → 跑后审计是否真花钱 → 黑洞端点是否真收到连接（失败关闭）。
- `verify-model-slot.mjs`（D4 的可观测性验收）同样自设授权闸，但**它依赖调用方先把实例起对**：
  它不校验黑洞，只负责断言排队可见。所以必须配合 `gate-env.mjs` 使用
  （黑洞日志里"没有连接"是**正常**的——作业常在 dsh 启动完成前就被取消，
  不要据此判定隔离失败；真正的保证是跑后审计 + 哨兵 Key）。
- 套件最后一条是**总闸**：本次窗口内检出任何真实调用即判未通过。
- **429 断言必须校验响应体**。`server.js` 会把上游错误也映射成 429
  （`e.status === 429 ? 429 : …`），只看状态码会把「被限流」误判成「被闸门拦住」。
- **「槽位已满」是有寿命的前置条件**：作业结束后放行是合法的，不是缺陷。
  断言前必须重新占满，占不住就失败关闭。
- 隔离环境一律用 `gate-env.mjs` 一次配齐（六项变量），不要手工分步搭。

### 补测结论：`DEEPSEEK_BASE_URL` 是生效的

事故后补测：把隔离实例的 `DEEPSEEK_BASE_URL` 指向黑洞端口后，黑洞日志收到 dsh 子进程发来的
真实请求（`POST /chat/completions` + `host: 127.0.0.1:<黑洞端口>` + `authorization` 头），
同时跑后审计确认**零计费调用**。

→ **变量生效；事故真因是「测试打到了没设该变量的实例或进程」**，不是变量被忽略。
教训：根因要靠证据定，不要靠推断定罪。

### 预检「穿透」：一个自己踩出来的坑

给闸门检查加 `--preflight`（不建作业、先验环境）时，第一版在预检后**忘了结束进程**，
于是穿透进正式流程：既建了作业，又因为走 `if` 分支而**绕过了授权闸**。
是「跑后审计 + 黑洞证明闸」如实报出来的（两条都通过，故未计费）。两条可复用教训：

1. **模式分支必须显式结束进程**——"只检查不执行"最容易的失败方式就是检查完继续往下走。
2. **纯语法检查看不见运行时引用错误**（第一版预检还漏了 `net` 导入，`node --check` 全过）。
   每个新分支都要有一条**子进程级**的冒烟断言。

### 复现审计

```powershell
node .p1-baseline/audit-llm-calls.mjs --since 2026-09-15T00:00Z        # 当天真实调用清单
node .p1-baseline/audit-llm-calls.mjs --since 2026-09-15T13:12:40Z --json
node .p1-baseline/test-gate-assert.mjs                                # 断言逻辑的离线阴性对照（零成本）
node .p1-baseline/test-harness-env.mjs                                # 子进程环境契约（零成本）
```
