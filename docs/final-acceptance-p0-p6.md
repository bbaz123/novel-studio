# P0–P6 最终验收报告（novel-studio AI 内核重构）

> 生成时间：2026-09-16 · 分支 `refactor/p0-p6` · 基线分叉点 `ca1cdf9`（v0.9.3）
> 本报告只写**跑出来的结论**，每条都能用文末命令复现；跑不了的标 SKIP，不算通过。

## 一、一句话结论

P0–P6 全部执行并验收。**一次完整套件运行：29 通过 / 0 未通过 / 0 跳过**，
并由**双重独立判据**确认全程零真实 LLM 调用（套件总闸 + `audit-llm-calls` 转录审计）。
回滚粒度是**提交**，不是阶段——理由见 §四（这条是推导出来的，不是声明出来的）。

```powershell
node .p1-baseline/gate-env.mjs --data-dir .p1-baseline/stress-data --port 3738   # 另开终端
$env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'; $env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'
node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3738 --gate-base http://127.0.0.1:3738
node .p1-baseline/gate-env.mjs --stop
```

| 汇总项 | 结果 |
|---|---|
| 通过 | **29** |
| 未通过 | **0** |
| 跳过 | **0** |
| 套件总闸（本次是否真的调用了 LLM） | ✓ 未检出 |
| 独立审计 `audit-llm-calls --since …` | **3 个会话发过请求，0 个拿到模型文本 → 0 计费** |
| 黑洞端点连接证明 | ✓ 收到 2 次 `POST /chat/completions`（隔离链路端到端生效） |

> 为什么黑洞里有连接、却不计费：那 3 个会话是两条 **spawn 路径检查**故意发出的，
> 端点是永不响应的本机黑洞，拿到的是传输错误而不是模型文本。
> 审计判据是 `requests>0` **且** `assistantChars>0` 才算计费——只发请求不算。

## 二、逐条对账（目标原文 → 证据 → 结论）

| 目标条款 | 交付物 | 关键证据 | 结论 |
|---|---|---|---|
| **P0** 建专用 dsh profile（novel）并把 AI 内核迁上去 | `harness-plugins/novel-writing/`（bundle + `cordis.patch.yml` + `install-profile.mjs`）、`.p0-recon/` | 83 行组合树逐条对账等价、17 条 disable 真实生效；**线路层检查**：模型实际收到的请求体里 15 个 `novel_*` 工具都在（版本 0.8.2） | ✓ |
| **P1** 冻结上下文契约 + 基线 + 压力数据 | `ai/context/layers.mjs`（机读规格）、`docs/context-contract.md`、`.p1-baseline/context-floor.mjs`、基线/压力数据 | 可执行下限**自动核算**（不是手写表）；契约文档数字与活规格一致（`full=20,547` / `settings=17,356`） | ✓ |
| **P2** 重建唯一上下文装配器（预算自动核算 + 裁剪清单） | `ai/context/assembler.mjs` | 抽取**行为等价** 55/55 逐字节一致（真实 20/20、压力 35/35）；主成文路径与创作内核**同源**（3/3 逐字节） | ✓ |
| **P3** 扩展检索覆盖面 + 落实 I4「凡裁剪必可查回」 | `layers.mjs` 的 `RETRIEVAL`（13 层映射）、`server.js` 检索桶 | **I4 端到端**：被裁层逐个实调查回端点（真实数据下没有被裁层，同样通过）；静态核对 16/16 | ✓ |
| **P4** 收敛通道 + 建立单点策略表 | `ai/policy.mjs`、`docs/p4-policy-verification.md` | AI 全分支核对：**0 处绕过**策略（无散落字面量）；策略端点行为等价 6/6 | ✓ |
| **P5** 记忆语义压缩 + 评估埋点 | 压缩提示进层内、`ai/edit-distance.mjs`、`ai_eval_events` 表 | 编辑距离测量点端到端 10/10（采纳→保存→回填、幂等、无采纳不测量）；真实作品装配 20/20 逐字节未变 | ✓ |
| **P6** 一次性切换 | `.p6-cutover/`（预检/彩排/执行/回滚/快照/冒烟） | S1 备份哈希校验 → S3 翻转（写入后校验）→ 幂等复跑；**真实写作冒烟 7/7**，会话转录证明 persona 已是 `执行小说创作任务的AI` | ✓ |

## 三、契约不变量 I1–I7

| 不变量 | 含义 | 状态 |
|---|---|---|
| I1 | 预算有硬上界，溢出**显式**上报（不再静默） | ✓ 压力 + 真实数据双跑 |
| I2 | 单层 cap 是硬上界 | ✓ 同上 |
| I3 | 零损失层（红线/伏笔/人物卡/长期记忆）**永不收缩** | ✓ 同上 |
| I4 | **凡裁剪必可查回** | ✓ 端到端实调 + 静态核对 |
| I5 | 同数据同渲染（幂等） | ✓ 基线逐字节对照 |
| I6 | 所有 AI 路径都经预算化装配器 | ✓ 0 处绕过 |
| I7 | 清单（manifest）可复现 | ✓ 快照工具离线测试 52 项 |

## 四、回滚真相：**没有可独立回滚的阶段**

这一列不是判断，是**从真实 `import` 图推导**的（`.p1-baseline/verify-phase-map.mjs`）：

- P0–P6 **全部** `shared`：要么与别的阶段改在同一批代码里（`server.js` 同时属于 P2/P3/P4/P5，
  `public/app.js` 属于 P3/P4/P5），要么被**生产代码** import（撤掉会当场打断线上路径）。
- 只有工具集 X 是 `tool-only`（撤掉只会让验收工具**响亮地**失效）。

**所以：回滚粒度 = 提交。** 分支 `refactor/p0-p6` 上的提交序列就是回滚点；
`.p6-cutover/snapshot.mjs` 是补充手段（可还原到快照时点，但快照过期后不再等于当前工作区）。
这条结论与 `docs/phase-map.md` 一致，且由工具生成、每次核对改动归属。

## 五、约束遵守情况（诚实记录）

| 约束 | 实际 |
|---|---|
| 全程隔离实例开发 | ✓ 隔离配方六项（`gate-env.mjs`），所有会 spawn dsh / 建任务的检查都在隔离实例上跑 |
| 主实例 3737 与真实库**不动** | ✓ 开发全程未动。**唯一一次生产动作**：D4 完成后经你明确批准重启 3737（用于让排队提示生效），重启前后做了对照检查（`verify-main-instance.mjs` 6/6） |
| 真实库未被写入 | ✓ 套件内「真实库未被写入（app_logs 差集归因）」通过；`data/novel.db` 的 mtime 自 09-15 20:47 起未变 |
| 每阶段独立**验收** | ✓ 每阶段一份验证文档（P2/P3/P4/P5 + P0 的 `.p0-recon/README.md` + P6 runbook） |
| 每阶段独立**回滚** | ✗ **做不到**，已由推导证明并改为提交粒度（见 §四）。这是对原方案的**修正**，不是遗漏 |
| 花钱的验证需批准 | ✓ D2 冒烟（1 次真实调用 / 367 字）经批准；其余全部零计费并有审计 |

## 六、遗留事项（不影响 P0–P6 完成）

1. **D7 待你决定**：生产记忆库里 183 个孤儿目录（2,022 文件）怎么处理（A 保留 / B 全删 / C 删今天的 1 个 / D 先留档再删）。见 `docs/pending-decisions.md`。
2. **P5 的记忆自动压缩刻意未启用**：它会真的产生 API 费用，需你单独批准。
3. **已知小缺陷（未修，等 D7 一起决定）**：`POST /api/works` 的异步 `syncWorkFull` 与
   `DELETE /api/works` 的异步 `removeWorkFromMemory` 竞态时，会留下孤儿记忆目录。

## 七、复现与证据索引

```powershell
# 完整验收（需要隔离实例，见 §一）
node .p1-baseline/verify-all.mjs --base http://127.0.0.1:3738 --gate-base http://127.0.0.1:3738

# 各阶段的详细证据
docs/p2-assembler-verification.md      # P2 装配器
docs/p3-retrieval-verification.md      # P3 检索与 I4
docs/p4-policy-verification.md         # P4 通道与策略
docs/p5-memory-eval-verification.md    # P5 压缩与埋点
docs/p6-cutover-runbook.md             # P6 切换手册与 S4 验证
docs/self-review-p0-p6.md              # 自审 F1–F12（每条都带阴性对照）
docs/phase-map.md                      # 改动归属 + 回滚判定（工具生成，不要手改）
docs/pending-decisions.md              # D1–D7 决策与执行记录

# 独立复核
node .p1-baseline/audit-llm-calls.mjs --since <时刻>   # 是否真的调用了 LLM
node .p1-baseline/verify-phase-map.mjs                 # 改动归属是否腐烂
node .p6-cutover/snapshot.mjs --verify <快照目录>       # 快照是否仍可用
```
