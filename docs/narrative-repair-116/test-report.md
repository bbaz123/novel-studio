# test-report.md｜命令 · cwd · 时间 · 真实退出码 · 断言数 · 日志位置

> 时间：2026-10-10（UTC 时间戳见各日志头）｜cwd：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`｜Node `v24.19.0`｜全程**零计费**（不调用真实模型）
> 纪律：**只信退出码**；`skipped` 不算 passed；"0 tests / 无匹配"不算通过。

## 1. 修改前基线（E00.3）

```powershell
node scripts/run-narrative-repair-116.mjs --label baseline
```

| 命令 | 退出码 | 断言/结论 | 日志 |
|---|---|---|---|
| `node scripts/test-narrative-repair.mjs` | 0 | 7 个套件 / 65 条断言全通过 | `.narrative-repair-116/logs-baseline/E00-narrative-repair-suite.log` |
| `node scripts/run-narrative-acceptance.mjs` | 0 | 9/9 必做命令通过；phase-map 为 informational 且 exit 1（见 §4） | `.narrative-repair-116/logs-baseline/E00-narrative-acceptance.log` |
| `node frontend-test.mjs` | 0 | `=== ALL PASS ===` | `.narrative-repair-116/logs-baseline/E00-frontend.log` |
| `node .p1-baseline/test-editing-rules.mjs` | 0 | 79/79 | `.narrative-repair-116/logs-baseline/E00-editing-rules.log` |
| `node .p1-baseline/verify-plugin-tools.mjs` | 0 | 工具面/版本/端点三者一致（26 工具） | `.narrative-repair-116/logs-baseline/E00-plugin-tools.log` |
| `node .p1-baseline/verify-preset-copy.mjs` | 0 | 结论 `junction_ok` | `.narrative-repair-116/logs-baseline/E00-preset-copy.log` |

**如实说明一处**：运行器第一版把"汇总行格式不认识"误判成 `failed`（首跑显示 2/6），
这是**判定器的问题，不是套件的问题** —— 4 条命令的真实退出码当时就是 0（见日志头 `# 退出码: 0`）。
判定器已当场改为"先看退出码，再单独识别零用例陷阱"，修后同一批命令重跑为 6/6（见 §2）。

## 2. 修改后（E07）

```powershell
node scripts/run-narrative-repair-116.mjs --label after
```

| 命令 | 退出码 | 断言/结论 | 日志 |
|---|---|---|---|
| `node scripts/test-narrative-repair.mjs` | **0** | **10 个套件 / 202 条断言全通过**（见下） | `.narrative-repair-116/logs-after/E00-narrative-repair-suite.log` |
| `node scripts/run-narrative-acceptance.mjs` | **0** | 9/9 必做命令通过；`付费调用：0 次`；`SKIPPED: paid_evaluation_not_authorized` | `.narrative-repair-116/logs-after/E00-narrative-acceptance.log` |
| `node frontend-test.mjs` | **0** | `=== ALL PASS ===`（**551 条 PASS**；基线 537 → 修后 551：新增 14 条 + 2 条既有断言按新契约改写。核对方式：逐条比对两次运行的检查 id 集合，MISSING 恰为被改写的 `94K5`/`94L3` 两条，见 test-report §5） | `.narrative-repair-116/logs-after/E00-frontend.log` |
| `node .p1-baseline/test-editing-rules.mjs` | **0** | 79/79 | `.narrative-repair-116/logs-after/E00-editing-rules.log` |
| `node .p1-baseline/verify-plugin-tools.mjs` | **0** | 26 工具一致 | `.narrative-repair-116/logs-after/E00-plugin-tools.log` |
| `node .p1-baseline/verify-preset-copy.mjs` | **0** | `junction_ok` | `.narrative-repair-116/logs-after/E00-preset-copy.log` |

### 2.1 专项套件逐条（真实退出码 0，共 202 条断言）

| 套件 | 断言 |
|---|---|
| `01-patch-protocol.test.mjs` | 65 通过 / 0 未通过 |
| `02-fixtures.test.mjs` | 8 / 0 |
| `03-stage-rules.test.mjs` | 17 / 0 |
| `04-narrative-scan.test.mjs` | 24 / 0 |
| `05-revision-plan.test.mjs` | 19 / 0 |
| `06-report.test.mjs` | 16 / 0 |
| `07-review-structure.test.mjs` | 10 / 0 |
| **`08-authorization.test.mjs`（本轮新增）** | **20 / 0** |
| **`09-information-truncation.test.mjs`（本轮新增）** | **11 / 0** |
| **`10-new-sample.test.mjs`（本轮新增）** | **12 / 0** |

### 2.2 全量离线回归

```powershell
node scripts/ci-offline-checks.mjs
```

- 退出码 **0**；`合计：通过 54 / 未通过 0（共 54 条，零计费）`
- 日志：`.narrative-repair-116/ci-offline-after.log`

> 说明：`scripts/test-narrative-repair.mjs` 已经在 `scripts/ci-offline-checks.mjs` 的清单里
> （第 74 条），而新增的 3 个套件登记在该总入口的 `NARRATIVE_REPAIR_TESTS` 中 ——
> **不需要另建 CI 入口，也不存在"看起来通过、CI 从不执行"的孤立脚本**。

## 3. 先失败后修复的真实证据（不是"跑绿了就算"）

| 阶段 | 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|---|
| 先写失败测试（复现缺陷） | `node tests/narrative-repair/08-authorization.test.mjs` | **1** | **6 通过 / 14 未通过**：`E01-1` 复现"选中 A 却改到 B（原文被改动）"、`E01-1c` 自造 offset 被承认、`E01-2/2b` 重复原句取首处、`E01-3b/3c/3d` 无授权表概念、`E01-4b` 新任务吃 legacy 等 | `.narrative-repair-116/e01-repro.log` |
| 修复后 | 同上 | **0** | 20 / 0 | `.narrative-repair-116/e01-after1.log` |
| E03 修复后 | `node tests/narrative-repair/09-information-truncation.test.mjs` | **0** | 11 / 0 | `.narrative-repair-116/e03-test.log` |
| E04/E06 | `node tests/narrative-repair/10-new-sample.test.mjs` | **0** | 12 / 0 | `.narrative-repair-116/e04-test.log` |

## 4. T25 防假绿（变异对照）：反转关键实现必须变红

```powershell
# 把授权表的**后置校验**短路：public/revision-patch.js 的 `      if (opts.authorization) {` → `if (false && opts.authorization) {`
#   （变异脚本先断言该行在文件里唯一命中，命中数 != 1 就直接判为不可信并退出 3）
node tests/narrative-repair/08-authorization.test.mjs
# → 退出码 1；[08-authorization] 通过 18 / 未通过 2
# 还原（从 .narrative-repair-116/revision-patch.js.mutation-backup 按字节还原）
node tests/narrative-repair/08-authorization.test.mjs
# → 退出码 0；[08-authorization] 通过 20 / 未通过 0
```

- 红：`.narrative-repair-116/t25-mutation-red.log`
- 绿：`.narrative-repair-116/t25-mutation-green.log`
- 还原校验：`RESTORED_IDENTICAL=true`（与变异前逐字节相同），且不再含 `false &&`。
- 备注：更早一次（在把片段级授权改为"以逐字原文为身份"之前）把 `if (opts.authorization)` 短路会红 **4 条**（16/20）。
  现在只红 2 条 —— 因为位置解析本身也已经受授权表约束（`} else if (opts.authorization)` 分支），
  两处独立判据构成纵深防御；这正是"越权需要同时绕过两道判据"的预期形状。

## 4.1 分段命名空间（K2′ 的第二面）

`116E-l` / `116E-m` 是本轮把"片段级授权"改成**以逐字原文为身份**的直接回归：
- 正例：整章编译的授权表 + **片**底稿 → 精确改到 `第二段：他把伞收了。`；
- 负例：整章 span_id `p2s1` 在片内恰好指向**另一句** → 仍被拒（授权不因分片放宽；这条在修复前会认错位置）。

## 5. 因契约变更而**修改（非删除）**的既有断言（如实披露）

本轮把"新修稿路径必须带授权表 / 不接受 legacy"作为新契约，因此 6 条既有前端断言的**输入或期望**随契约更新，
断言仍在测同一件事（没有删掉任何一条失败用例）：

| 断言 | 改动 | 为什么这是契约更新而不是"改松" |
|---|---|---|
| `94K` / `94K2` / `94K3` | 输入问题改为带逐字引用（`把「第二段：他站着没动。」改掉`），并给出 `confirmedIdsOverride: ['2']` | 断言本身未变（"失败不整章重写""只做一次仅格式重试""给出显式选择"），只是让输入满足"必须有可定位的授权跨度"这一新前提 |
| `94K4` / `94K5` | 期望从 `["1"]` 改为 `["2"]` | 这正是 E02 要的性质：只勾报告第 2 条就记 `2`，不按勾选顺序重编成 `1` |
| `94L3` | 期望从"退回整章目录"改为"**不**退回整章目录 + 显式声明没有可编辑跨度" | 直接来自《修复.md》E01-A3："删除新修稿路径的这类退位" |
| `58ad` | 载荷从 legacy 改为 v2（并新增 `58ad2` 断言 legacy 被拒） | 直接来自《修复.md》E01-D："新请求不走旧 legacy 自动应用" |
| `108e` | 问题改为带逐字引用 | 同上：计划必须能编译出授权跨度，才会发起调用 |

## 6. 未执行 / 未验证（不得当成通过）

| 项 | 状态 | 原因 |
|---|---|---|
| 真实模型语义审稿（`verify_style` 跑语义模型） | `SKIPPED: paid_evaluation_not_authorized` | 需真实计费调用；本轮默认零计费 |
| 文学效果 A/B（检出率/误报率/阅读质量） | `not_run` | 无授权预算与样本策略 |
| 真实章节上的整章修稿端到端 | `not_run` | 不得把真实作品当测试输入（硬边界） |
| 分段修稿在真实长章（> 单请求上限）上的授权表行为 | `partial` | 已用同口径的模块/应用层断言覆盖（`58ad`、`116E-*`），但未在真实长章上跑过 |
| `docs/phase-map.md` 文档与阶段数据一致 | `pre_existing_failed` | 该文件在本轮之前就已过期（记录 503，实跑 523+）；未用 `--write` 重写（属无关大范围改动） |
| 97 项"未归属改动" | `pre_existing_failed` | 全部是旧探针与基线数据，早于本轮 |
