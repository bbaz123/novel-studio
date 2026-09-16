# ai/ —— AI 内核

本目录是 novel-studio **AI 内核**的独立模块，P2/P4 阶段从 `server.js` 与 `public/app.js`
里抽出来。目标是把「上下文怎么装配」与「哪个环节用哪个模型」这两件最容易漂移的事，
各自收敛到**一处定义**。

## 结构

| 路径 | 作用 |
|---|---|
| `context/layers.mjs` | 上下文**层规格的唯一来源**：13 层的 cap / kind / 收缩属性 / 模式差异 / 查回路径 |
| `context/assembler.mjs` | **唯一装配器**：预算内渲染、收敛收缩、裁剪清单、溢出标记。纯函数、零依赖 |
| `context/cache.mjs` | **装配结果缓存**：版本 = 进程内数据版本 + 外部可观测状态（记忆库索引时间戳）。索引一完成缓存立刻失效，TTL 只作兜底——不再靠时间猜（D8-#7） |
| `sync-gate.mjs` | **在途同步 ↔ 移除**的顺序闸：登记在途、协作式取消、排空后才允许删目录。修掉「建完立刻删」留下孤儿记忆目录的竞态（D8-#6） |
| `task-settings.mjs` | **每任务一份独立 settings**（D8-#2）：生成指向独立副本的 `--patch` 补丁层 + 组装子进程参数（纯函数，参数顺序在此收口）。它让切模型不再有全局副作用，因而不再需要互斥——吞吐从 1 回到 2 |
| `context/README.md` | 装配层的改动须知 |
| `policy.mjs` | **模型与思考强度的唯一来源**：档位→模型、强度白名单、工作台档位→强度、归一化函数 |

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

   # 模型取值是否全部经策略解析
   node .p1-baseline/verify-ai-branches.mjs

   # 装配结果有没有变（与旧基线逐字节对照）
   node .p1-baseline/capture-baseline.mjs --base <base> --db <db> --out <dir>
   node .p1-baseline/compare-baseline.mjs <旧基线目录> <新基线目录>
   ```

## 背景

为什么这两个东西值得单独成模块，见 `docs/context-contract.md`（契约与历史失误）与
`docs/p2-assembler-verification.md`、`docs/p3-retrieval-verification.md`、`docs/p4-policy-verification.md`。
