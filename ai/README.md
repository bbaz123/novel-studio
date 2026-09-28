# ai/ —— AI 内核

本目录是 novel-studio **AI 内核**的独立模块，P2/P4 阶段从 `server.js` 与 `public/app.js`
里抽出来。目标是把「上下文怎么装配」与「哪个环节用哪个模型」这两件最容易漂移的事，
各自收敛到**一处定义**。

## 结构

| 路径 | 作用 |
|---|---|
| `context/layers.mjs` | 上下文**层规格的唯一来源**：18 条规格（14 条常规层 + 4 条**门控层** `library` / `story_state` / `edit_rules` / `author_intent`，门控层默认不计入可执行下限）的 cap / kind / 收缩属性 / 模式差异 / 查回路径 |
| `context/assembler.mjs` | **唯一装配器**：预算内渲染、收敛收缩、裁剪清单、溢出标记。纯函数、零依赖 |
| `context/cache.mjs` | **装配结果缓存**：版本 = 进程内数据版本 + 外部可观测状态（记忆库索引时间戳）。索引一完成缓存立刻失效，TTL 只作兜底——不再靠时间猜（D8-#7） |
| `sync-gate.mjs` | **在途同步 ↔ 移除**的顺序闸：登记在途、协作式取消、排空后才允许删目录。修掉「建完立刻删」留下孤儿记忆目录的竞态（D8-#6） |
| `task-settings.mjs` | **每任务一份默认模型补丁层**（D8-#2）：生成覆盖 `agent-default-model` 的 `--patch` 补丁 + 组装子进程参数（纯函数，参数顺序在此收口；超长任务文本改走 `-` + stdin 的通道判定 `promptFitsArgv` 也在此）。它让切模型不再有全局副作用，因而不再需要互斥——吞吐从 1 回到 2。0.1.7 起"重定向 settings 文档"的旧写法已失效（`settings-file` 包被删），取值改走 `settings.yaml` → profile 补丁 → `.imported` 三级 |
| `continuity-guard.mjs` | **审稿前的确定性连续性预检**（2026-09-22）：角色卡时点 / 系统出场频率 / 篇幅口径 / 剧情线推进。只做**机器能判定**的事，纯函数零依赖，输出 findings 由调用方决定怎么用（界面提示 / 内联进审稿提示词） |
| `continuity-guard-source.mjs` | 上面那套判据的**装配层**：把库里的角色卡、卷章、剧情线、风格文本装成输入。靠注入的 `{all,get}` 工作（不 import db），所以服务端端点、验收脚本、将来的提示词路径共用同一套 SQL——口径只写一次 |
| `context/README.md` | 装配层的改动须知 |
| `policy.mjs` | **模型与思考强度的唯一来源**：档位→模型、档位→强度（`EFFORT_BY_TIER`）、强度白名单、工作台档位→强度、长任务统一超时（`LONG_AI_TIMEOUT_MS`）、旧名清理清单（`LEGACY_MODEL_NAMES`）、归一化函数 |
| `context/contributions.mjs` | **运行时上下文贡献记录**（R05）：每层实际进入装配时的来源 / 版本 hash / 长度 / 去重标识 / 使用或省略原因；由只读端点 `/api/novel/context/contributions` 下发，不新增表、不改装配结果 |
| `story-state/` | **确定性故事状态内核**：正典事实 / 时间线 / 角色知识边界 / 章节契约 / 提案与快照回滚。其中 `approval.mjs` 是模型侧写入的**一次性审批边界**，`disclosure.mjs` 产出作者真相 / 读者披露 / 角色掌握三视图（按时点重算） |
| `branch/` | **剧情分支沙盘**（R11）：`sandbox.mjs` 候选形状与九维比较，`store.mjs` 只写 2 张候选表。采纳只写章节蓝图，正文 / 正典 / 事件 / 角色知识一律不动 |
| `editing/` | **编辑保护规则**（R07）：`rules.mjs` 规则资产（三档编辑 / 7 条保护规则 / 7 项能力 / 题材档 + 版本与 `ruleHash`），`scan.mjs` 确定性扫描（**不调用模型**） |
| `style/` | **作者样文与文风档案**（R09）：`store.mjs` 样文仓库（单篇 / 篇数 / 总量上限与启停分离），`author-profile.mjs` 结构化风格统计（每项都写**计算口径**）。样文只作证据，不进事实 / 事件 / 角色知识 |
| `import/` | **导入安全与导入后重建**（R12）：`guard.mjs` 不可信输入的**单点**判据（大小 / 严格编码 / 路径穿越 / symlink / 压缩比 / 条目数与深度），`rebuild.mjs` 分批规划与逐批基线，`rebuild-store.mjs` 运行与批次持久化（确认是作者动作、按批短事务原子应用） |
| `library/` | **共享资料库**（L）：`library-roots.mjs` 共享资料根注册表、`library-ingest.mjs` dry-run 扫描与计划、`library-doc.mjs` 格式规范化、`library-recall.mjs` 检索窗口与微缓存、`store.mjs` 登记表。资料**永不 canon**，与作品子树物理隔离 |
| `openviking/recall-meta.mjs` | **召回来源 fail-closed 校验**：命名空间 / 布局已知 / 正典状态 / 未来章节四道判据 + 资料根形状闸门；召回生产方与宿主装配器**共用同一实现**，被拦条目留审计原因 |

> ⚠️ **2026-09-18 变更**：两档模型已统一为 V4.1 Flash（`deepseek-flash`），「质量优先」改由
> `EFFORT_BY_TIER.quality = 'high'` 表达。决策理由与"不要改回 v4-pro"的说明写在 `policy.mjs` 文件头；
> 单测在 `.p1-baseline/test-policy-tiers.mjs`。

## 两条铁律

1. **不要在业务代码里重新内联这些取值。**
   层规格只在 `context/layers.mjs`；模型名只在 `policy.mjs`。
   `.p1-baseline/verify-ai-branches.mjs` 会扫描源码，把任何绕过策略的模型字面量报出来
   （当前 **0 处**）。

2. **改完必须跑验证，不能靠读代码确认。**

   ```powershell
   # 契约不变量（I1/I2/I3/I7）+ 输出被裁内容清单（I4 工作清单）
   node .p1-baseline/verify-invariants.mjs <基线目录>

   # I4 端到端：逐个被裁层实际调用查回端点
   node .p1-baseline/verify-retrieval.mjs <base> <db> <workId> <chapterId>

   # 模型取值是否全部经策略解析（扫 public/app.js、server.js、harness.js、db.js）
   node .p1-baseline/verify-ai-branches.mjs

   # 档位→模型/强度/长任务超时 是否仍符合 2026-09-18 的决策（含 db.js 同源、超时不被 clamp 截短）
   node .p1-baseline/test-policy-tiers.mjs

   # 装配结果有没有变（与旧基线逐字节对照）
   node .p1-baseline/capture-baseline.mjs --base <base> --db <db> --out <dir>
   node .p1-baseline/compare-baseline.mjs <旧基线目录> <新基线目录>
   ```

## 背景

为什么这两个东西值得单独成模块，见 `docs/context-contract.md`（契约与历史失误）与
`docs/p2-assembler-verification.md`、`docs/p3-retrieval-verification.md`、`docs/p4-policy-verification.md`。
