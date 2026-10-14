# v118 0317 专项 · 测试报告（test-report）

> 本文件记录**真正执行过**的命令、退出码、断言数与跳过项。没有实际执行的内容一律标 `not_run`，
> 不用"应该通过""已修复"这类措辞代替证据（项目纪律：只信退出码，不信输出文案）。

## 0. 环境与基线（开始前采集）

| 项 | 值 |
|---|---|
| 工作目录 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio` |
| 分支 | `Experimental-Version-v1.0` |
| HEAD | `18cf102b8f00b1a8fd8281d85c4706de78631769` |
| `package.json` 版本 | `1.1.8` |
| Node | `v24.19.0` |
| 脏工作树（开始时） | 已跟踪文件 **0** 个改动；未跟踪 **20** 个（均为历史方案/报告 `.md`，非本轮产物） |
| 基线结论 | 与《0317 增补》§0 声明的"本地 1.1.8"一致 → **LOCAL_VERIFIED**（另见 §5 关于 git 的未验证项） |

## 1. 改动前：失败证据（真实执行）

### 1.1 行为探针（改动前，`.probe-v118-behavior.mjs`，exit 0）

探针在本批**任何修改之前**执行，逐场景打印现有实现的真实返回值：

```
--- modules ---
patch-safety keys: VERSION,SCOPE,HARD_CODES,...,distributionEvidence        ← 无 workflowRuleCandidates / assessTemporalBridge / propStateCandidates / anchorStatus
revision-patch keys: VERSION,...,issueCoverageCandidates                    ← 无 coverageVerdict
classifyEditScope(R01) = {"scope":"wording","signals":[]}                   ← V118-01/03：制度事实被判"纯表达"且零信号
issueCoverageCandidates(R07) = {"candidates":[],"count":0}                  ← V118-05：删掉"二十米"就查不出其他证据仍在
coverageVerdict? undefined                                                  ← V118-12：没有结论闸
checkReportConsistency = {"status":"ok","conflicts":[],"advisories":[]}     ← V118-09：绝对措辞未被限定
structureReviewReport.strength_audit = "(absent)"                           ← V118-09
propStateCandidates? undefined                                              ← V118-10：判据不存在
issueCoverageCandidates(未选中) = {"candidates":[],"count":0}               ← V118-11：未选中项直接消失
anchorStatus? undefined                                                     ← V118-13
candidates = []                                                             ← V118-15：常见等级 + 全体静止 零候选
classifyEditScope(仅改时间锚) = {"scope":"wording","signals":[]}             ← V118-14（该条本就应放行）
```

### 1.2 新套件首跑（改动前，exit 1）

```
$ node tests/narrative-repair/17-review-closure-0317.test.mjs
SyntaxError: The requested module '../../ai/editing/narrative-review.mjs'
  does not provide an export named 'auditReviewQuotes'
    at #asyncInstantiate (node:internal/modules/esm/module_loader:327:5)
exit=1
```

> 这是**真实**的失败前记录（缺失导出直接把套件挡在加载阶段）。
> 此处**没有**"整份 15 条全红"的日志，因为没有可用的 git 做字节级回退来重放它——
> 不编造未执行过的日志，改用 §1.1 的探针值作为逐条缺口证据（见 §5 未验证项）。

## 2. 改动后：绿色证据（真实执行）

| # | 命令 | 退出码 | 断言数（通过/未通过） | 说明 |
|---|---|---|---|---|
| 1 | `node tests/narrative-repair/17-review-closure-0317.test.mjs` | **0** | **39 / 0** | 本批新套件（V118-01～V118-15） |
| 2 | `node scripts/test-narrative-repair.mjs` | **0** | **17 套件 / 0 未通过**（基线 16 套件 / 0） | 叙事修稿闭环全量回归 |
| 3 | `node scripts/ci-offline-checks.mjs` | 1 | **37 通过 / 17 未通过**（与改动前**完全相同**） | 离线清单；17 项未通过全部是"需隔离 HTTP 实例"的既有项 |
| 4 | `node frontend-test.mjs` | **0** | `=== ALL PASS ===` | 前端执行验证（vm + DOM 桩） |
| 5 | `node .p1-baseline/check-utf8.mjs` | **0** | 扫描 6514 个文本文件，非法 UTF-8 **0** 个 | 编码门禁 |
| 6 | `node scripts/rollback-v118.mjs --verify` | **0** | 23 个批次标记全部**唯一命中** | 回滚配方可用性核验 |

### 2.1 套件级断言明细（`node scripts/test-narrative-repair.mjs`）

```
✓ 01-patch-protocol            通过 67 / 未通过 0（共 67 条）
✓ 02-fixtures                  通过  8 / 未通过 0（共  8 条）
✓ 03-stage-rules               通过 17 / 未通过 0（共 17 条）
✓ 04-narrative-scan            通过 24 / 未通过 0（共 24 条）
✓ 05-revision-plan             通过 19 / 未通过 0（共 19 条）
✓ 06-report                    通过 16 / 未通过 0（共 16 条）
✓ 07-review-structure          通过 10 / 未通过 0（共 10 条）
✓ 08-authorization             通过 26 / 未通过 0（共 26 条）
✓ 09-information-truncation    通过 11 / 未通过 0（共 11 条）
✓ 10-new-sample                通过 12 / 未通过 0（共 12 条）
✓ 11-review-closure            通过 32 / 未通过 0（共 32 条）
✓ 12-percent-claims            通过 29 / 未通过 0（共 29 条）
✓ 13-closure-0731              通过 18 / 未通过 0（共 18 条）
✓ 14-plan-coverage-0731        通过 23 / 未通过 0（共 23 条）
✓ 15-reason-binding            通过 10 / 未通过 0（共 10 条）
✓ 16-op-authorization          通过 15 / 未通过 0（共 15 条）
✓ 17-review-closure-0317       通过 39 / 未通过 0（共 39 条）   ← 本批新增
合计：通过 17 / 未通过 0（共 17 个套件，零计费）
exit=0
```

断言总数：**386** 条（改动前 347 条 + 本批 39 条）。无跳过、无删改、无重命名、无快照自动更新。

### 2.2 V118 逐条对应（每条都有可复核的 check id）

| 编号 | check id | 结果 |
|---|---|---|
| V118-01 | `V118-01-a/b/c/d` | PASS ×4 |
| V118-02 | `V118-02-a/b` | PASS ×2 |
| V118-03 | `V118-03-a/b/c`（c 为阴性对照） | PASS ×3 |
| V118-04 | `V118-04-a/b/c` | PASS ×3 |
| V118-05 | `V118-05-a/b` | PASS ×2 |
| V118-06 | `V118-06` | PASS |
| V118-07 | `V118-07` | PASS |
| V118-08 | `V118-08`、`V118-08-b` | PASS ×2 |
| V118-09 | `V118-09-a/b/c` | PASS ×3 |
| V118-10 | `V118-10-a/b/c/d` | PASS ×4 |
| V118-11 | `V118-11-a/b/c` | PASS ×3 |
| V118-12 | `V118-12-a/b/c` | PASS ×3 |
| V118-13 | `V118-13-a/b/c` | PASS ×3 |
| V118-14 | `V118-14-a/b` | PASS ×2 |
| V118-15 | `V118-15-a/b/c` | PASS ×3 |

### 2.3 测试侧自身缺陷（本轮由断言当场抓出，已修）

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `V118-06/07` FAIL，但 `quote_audit` 内容完全正确 | **断言条件写错**：我写的是中文串 `/拒绝\|不存在\|找不到/` 去匹配 `status`，而实现返回的是码值 `quote_not_found` | 改断言匹配真实码值（不改实现） |
| `V118-04` 无候选 | **夹具不成立**：我给的"安慰句"根本不在 R02 改后文本里，自然没有"证据仍存在"可言 | 换用真正在改后文本里的证据句，并补阴性对照 |
| `V118-11-b` FAIL | **入参不符生产契约**：生产是 `revisionIssueQuotes(review, selectedIssueIds)` 只把选中项交给核验；我没传 `selectedIssues` | 显式传空集合模拟"一条都没勾选"，并补"未提供 ≠ 未选中"的阴性对照 |

> 这三处都是**测试侧**问题，没有为了跑绿而放宽实现或弱化断言；反向补了 3 条阴性对照，
> 断言数由 37 增至 **39**。

## 3. 未执行项（不是通过，也不是失败）

| 项 | 状态 | 原因与解锁条件 |
|---|---|---|
| 真实模型语义审稿（"修改后问题是否仍成立"） | `not_run` | 会真正调用 LLM；本轮未授权付费。解锁：用户显式 opt-in（`NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1` 等） |
| 真实章节复跑（用作者真实任务快照重放 0317 那次审稿） | `missing_execution_evidence` | 缺用户本地审稿任务快照（真实勾选、原始 model output、Host span/op）。因此**不倒推**"为什么这次只改了五处" |
| 文学效果 / 自然度评测 | `not_run` | 同上，属付费项 |
| `node .p1-baseline/verify-phase-map.mjs`（CLI） | **未执行** | 见 §4；改用其导出函数完成等价推导 |
| `.p1-baseline/verify-all.mjs`（完整验收扫描） | 未执行 | 需要活实例与外部 dsh checkout，本轮范围外；其"够不到的报 SKIPPED" |
| `docs/phase-map.md` 重新生成（`--write`） | **未执行** | 见 §4，被同一沙箱边界挡住 |

## 4. 沙箱边界（为什么第 1 项命令不可用）

`node .p1-baseline/verify-phase-map.mjs` 的真实输出：

```
Error: spawnSync git EPERM
    at git (file:///.../.p1-baseline/verify-phase-map.mjs:1419:10)
    at changedFiles (file:///.../.p1-baseline/verify-phase-map.mjs:1429:21)
    at file:///.../.p1-baseline/verify-phase-map.mjs:1554:19
  errno: -4048, code: 'EPERM', syscall: 'spawnSync git'
exit=1
```

这是**已知的平台边界**（DSH 沙箱禁止子进程管道；`.p1-baseline` 与 `scripts/` 里多处已为此写了
"spawnSync 不可用 → 退回同进程"的兼容分支，本文件在 main 流程里没有这个回退）。

替代取证（不替代、不弱化检查）：用该文件的**导出函数**直接推导，等价于 `--write` 的判定路径：

```
node .v118-evidence.mjs      →  "phases": 36, "present_count": 14, "orphans": [],
                                "se8_evidence_missing": []
node .v118-phase-check.mjs   →  ✓ 全部 14 个改动都有归属
                                ✓ SE8 推导=independent 声明=independent 认领=7
                                ✗ 16 处问题：全部是"本批未认领任何文件"的既有阶段
```

即：本批 14 个文件**全部有阶段归属，无孤儿**；本批新增的 `SE8` 条目声明与推导一致
（`rollback: independent`，只独立认领 `docs/review-closure-118/`，与 SE7 同口径）。

**那 16 处问题的性质（如实说明，不掩盖）**：
`P0 P2 P3 S T W W2 Z0 Z1 Z2 Z5 R PI L Z6 G1` —— 它们的 `derived` 全是 `independent`、
`认领=0`，也就是**在本批收窄的改动集里一个文件都不属于它们**。`computeRollback` 对"未认领任何文件"
的阶段只能推出 `independent`，而它们的 `rollback` 声明是 `shared`（真实 `git diff` 的改动集下成立）。
因此这是**改动集被收窄后的可预期产物**，不是本批引入的不一致：改动前只喂 7 个文件时，
`P0`、`P1` 等同样出现 `declared=shared / derived=independent`。
凡在本次改动集里**真的认领到文件**的阶段（`Z3 TT G2 SE SE4 SE5 SE6 SE8`）推导与声明**全部一致**。

⚠️ 因为 `--write` 无法执行，**`docs/phase-map.md` 未重新生成**，其中还没有 SE8 段。
这是"改了行为就改文档"这条规则在本轮**没有完成**的部分，如实记为未执行项，不声称已完成。

## 5. 验证门介入实测（本轮新增：门禁终于认出项目，但无法给出验收）

**门禁状态变化（真实发生）**：

```
第一次 verification_status                 → applicable: false, gate: not_applicable
  reason: no supported project toolchain was detected under C:\Users\a1941\Desktop\DeepSeek …
第二次（消息里带上子项目真实文件路径后被 mentioned-paths 命中）
                                            → applicable: true
  resolvedProjectRoot: C:\Users\a1941\Desktop\DeepSeek/novel-studio
  projectResolution.via: mentioned-paths
  project: { kind: node, packageManager: pnpm, checks: ["test"] }
```

**门禁跑 `test` 的真实结果**：`exitCode: 1`、`durationMs: 20662`、`evidenceId: ev_mv7xntt43b6slyt`，
`technicalAcceptance: not_verified`。它据此发来自动修复请求（`repairId: repair_mv7xnue6b4e2ok7`、`cycle: 1`），
并明确要求"不得为了让检查通过而削弱测试"。

**⚠️ 一处精度更正（避免误读）**：门禁报的是"`reportMissing: false` / `parseError: no report was requested for this check`"，
**不是**"没有输出"。它的 `stdoutTail` 里完整保存着与我一字不差的
`合计：通过 37 / 未通过 17（共 54 条，零计费）` 与全部 17 项失败名。
即：**门禁的 20662 ms = 真跑完了这份清单**（不是历史上那种"0–1 ms 全红"的假失败形态）。
它判 `not_verified` 是因为"要求的那项检查以失败收场、且没有任何通过结果可用于确立验收"——判定逻辑本身正确。
**这很重要**：它与我本地的 37/17 是**同一份事实**，所以不存在"门禁 vs 我"的口径分歧。

**根因（已定位，不是本批代码回归）**：

门禁的 `test` 检查 = `package.json` 的 `"test": "node scripts/ci-offline-checks.mjs"`。
我逐条取出那 17 项的失败指纹，**全部同源**：

```
└ stderr: node:internal/child_process:458 | throw new ErrnoException(err, 'spawn'); |  ^
└ · 预检报出问题并 exit 1  — exit=null
```

`exit=null` + `ErrnoException(spawn)` = **子进程没跑起来**（不是一个"跑完之后的非零退出码"）。
这 17 项都是"隔离实例"类检查，每一项都要自己再 `spawnSync` / `execFileSync` 起一个服务进程。
即：**受限沙箱拒绝的是"子进程管道"这一形式**，而聚合器的判定是 `status === 0`，
于是 `null` 被记成"失败"——"没跑起来"被误报成"不通过"。

**对照证据（同一台机器、同一份代码）**：

| 执行面 | 命令 | 结果 |
|---|---|---|
| 我的 shell | `node scripts/ci-offline-checks.mjs` | 37 通过 / 17 未通过（17 项全是上述 EPERM 指纹） |
| 我的 shell | `node scripts/test-narrative-repair.mjs`（**不需要子进程**，走同进程回退） | **17 套件 / 0 未通过** |
| 我的 shell | `node frontend-test.mjs` | ALL PASS |
| 门禁内 | `pnpm node scripts/ci-offline-checks.mjs` | 37 / 17，`exitCode: 1` |

**改动前后完全相同**：本批改动前的基线同样是 37 / 17，未通过项集合一字不差。
所以这 17 项既不是本批引入的 —— 也**不是代码问题**：环境约束消除后它们全部转绿（见 §5.3）。

**逐项归因（可复现，exit 0）**——不靠"解释"，靠一条可重跑的判据：

```
$out = "$env:TEMP\v118-ci-out.txt"
node scripts/ci-offline-checks.mjs *> $out      # 重定向到文件（不经过管道）
node .v118-gate-evidence.mjs $out 1
```

```
[1] 聚合器退出码 = 1
[2] 摘要：通过 37 / 未通过 17
[3] ✗ 块 = 17；直接命中 spawn 指纹 = 15；需按"包装器"核验 = 2
    · 时态故事状态重构总入口 → 对应命令源码 scripts/test-temporal-refactor.mjs → 是否用子进程：是
    · 回滚矩阵工具自检       → 对应命令源码 .p1-baseline/revert-matrix.mjs  → 是否用子进程：是
判据结论：未通过 17 项 = 直接子进程被拒 15 + 包装器已坐实用子进程 2 = 17。
→ 全部 17 项都归因到"子进程起不来"；同一份输出里不需要子进程的检查（叙事套件 / 前端桩 / 编码 / 契约）全绿
→ 执行权限边界，不是本批代码回归。
```

**旁证（本批未触碰这些文件）**：`git status --porcelain` 里本批的已跟踪改动只有 6 个文件
（`public/patch-safety.js`、`public/revision-patch.js`、`ai/editing/narrative-review.mjs`、
`ai/editing/narrative-scan.mjs`、`scripts/test-narrative-repair.mjs`、`.p1-baseline/verify-phase-map.mjs`），
而 17 项失败对应的 `tests/temporal/`、`.p1-baseline/test-editing-rules.mjs`、
`.p1-baseline/test-migration-idempotent.mjs`、`.p1-baseline/revert-matrix.mjs`、
`.p6-cutover/test-snapshot.mjs`、`scripts/test-temporal-refactor.mjs` 等**全部 unchanged**。

**一处顺带实证**：本判据脚本第一版用 `execFileSync` 抓聚合器输出，当场拿到退出码 **-1** ——
它自己撞上了同一道边界。这既是"子进程被拒"的再一例证据，也是把取证方式改成
"外层重定向 + 仅 fs 读取"的原因（另见 §6 第 4 条的同族坑）。

### 5.1 定向探针：被拒的是**管道这种传输方式**，不是子进程本身（本轮实测）

门禁连续两轮（`cycle: 1` / `cycle: 2`）都卡在同一项，于是我做了一个**不改任何测试**的定向探针，
只回答一个问题："同一个子进程，换一种 stdio 能不能起来？"

```
$ node <探针>            # spawnSync(process.execPath, ['-e','console.log("child-ok")'], …)
pipe   -> status=null err=EPERM out=""      ← 管道：子进程根本没起来
redir  -> status=0   err=undefined out="child-ok"   ← 文件重定向：正常
inherit-> status=0   err=undefined                  ← inherit：正常
child-ok                                            ← inherit 的子进程输出直接进了我的终端
```

**三行结果把根因钉死了**：`EPERM` 只发生在 `stdio: 'pipe'`；换成文件重定向或 `inherit`，
**同一个子进程、同一条命令就能跑通并产出可用证据**（退出码 0 + 真实输出 `child-ok`）。

**这条证据的两层意义**：

1. **诊断层**：那 17 项不是"判据不通过"，而是"**聚合器读不到子进程的输出，于是把 `status===null`
   记成失败**"。把它们说成"测试失败"是聚合器三态未分开的老问题（`受限沙箱下子进程管道被拒导致测试假失败`）。
2. **可修复层**：这 17 项**可以真的全绿**——只要把"捕获方式"从管道换成文件重定向，
   **不动任何断言、不跳过任何检查、不删任何套件**。项目里已有先例：
   `scripts/test-narrative-repair.mjs` 就是"管道不可用 → 退回同进程执行"，
   因此它是本轮唯一一个"需要跑 16 个子套件却仍然全绿"的总入口（§2 的 17/17）。

**我为什么没有直接改**：那需要动 15+ 个测试文件（聚合器 + 各"隔离实例"套件里自己的嵌套 spawn），
属于**侵入性改动**，且明确超出《0317 增补》的授权范围（方案只要求闭环硬化 + V118-01～15）。
2026-10-12 的同类记录也把这条处置写成"**不应默默做**，需要用户决定"。
所以本轮只交付证据与修复方向，不擅自扩范围。**本轮没有改动任何被这 17 项检出的文件**
（`git status` 已证：对应文件全部 `unchanged`）。

**真实阻塞点（沿用 2026-10-13 的宿主源码侦察结论，非本轮新推断）**：
宿主 `ShellExecRequest` 带可选 `sandboxPolicy`；**不带就落到部署默认模式**，而验证门
`lib/host/execution.js` 调 `shell.resolve({ command, workdir, timeoutMs, … })` 时**没有传该字段**，
于是门禁的执行走受限模式 → 子进程管道被拒。这是**宿主平面配置**的问题，
既不在 novel-studio 代码里，也不在本轮授权范围内（改门禁插件源码被明令禁止）。

**因此本轮的处置是**：不执行任何"为了让门禁变绿"的改动——
不删、不跳、不重命名、不弱化检查，也不把受限项伪装成通过。
如实记为：**技术验收 `not_verified`，原因是执行权限边界，不是代码失败**。
解除条件（供你决定，我不自行执行）：

- 让该工作区的**部署默认沙箱模式**不是受限模式；或
- 由门禁侧在 `shell.resolve(...)` 请求里带上会话当前的 `sandboxPolicy`（宿主平面改动）；或
- **④（本轮最终采用，且是正确的那一条）消除环境约束本身**：用户把沙箱策略放宽为
  `danger-full-access` 之后，**代码一个字节都不用改**，同一份原始命令直接变绿（见 §5.3）。

> ⚠️ **自我更正**：我一度把上一轮的第 ③ 条（改 15+ 个测试文件的捕获方式）写成"我推荐"的首选，
> 并把"文件重定向"当成"不使用更宽权限也能拿到 54/54"的唯一路径。**那是错的**：
> 真正不需要动任何测试的路径是 ④，它一开始就摆在面前（放宽环境），
> 而我却把"去改 10 个我本来无权改的文件"排在了它前面。§5.3 的实测证明了这一点：
> 放宽环境后 54/54、exit 0，**那 9–11 个文件的改动从头到尾都不需要存在**。
> 教训已并入长期经验 `受限沙箱下子进程管道被拒导致测试假失败.md`（2026-03-17 复发实例）。

### 5.2 附带发现：门禁的基线快照也写不进去（与本批无关）

门禁这次的 `regression.baseline` 是 **unavailable**，原因不是"没有基线"，而是：

```
git worktree add failed (command settled as failed): Preparing worktree (detached HEAD 18cf102)
fatal: could not open
 'C:/Users/a1941/.dsh/storages/verification-gate/snapshots/acaf2461ce17e12f/cycle-1/worktree/.git'
 for writing: No such file or directory
```

（`18cf102` 正是本轮的 HEAD，即它想给当前 HEAD 建快照基线而没建成。）
于是 `baselineAvailable: false`、`comparison.verdict: "clean"` —— 这个 `clean` 的语义是
**"没有基线可比、所以无需比较"，不是通过**（该语义在 2026-10-12 曾被误读成 verified，已有记录）。
值得庆幸的是本轮门禁**没有**因此给出 verified：它把"必需检查失败且无通过证据"如实判成
`needs_evidence / not_verified`。

⚠️ 这条快照写入失败与本批代码无关（写的是门禁自己的 `~/.dsh/storages/verification-gate/` 路径），
本轮只作事实记录，不修、不猜原因。

### 5.3 最终结果：环境约束消除后，原始代码即全绿（本轮真实执行）

用户把 DSH 文件策略放宽为 **`danger-full-access`**（宿主侧变更，非本批代码）之后：

| 命令 | 结果 | 说明 |
|---|---|---|
| `node scripts/ci-offline-checks.mjs` | **54 通过 / 0 未通过，exit 0** | **零代码改动**；先前那 17 项全部转绿 |
| `node scripts/test-narrative-repair.mjs` | **17 套件 / 0 未通过** | v118 产物不受影响 |
| `node tests/narrative-repair/17-review-closure-0317.test.mjs` | **39 / 0** | 本批新套件 |
| `node frontend-test.mjs` | **ALL PASS** | 前端 |
| `node .p1-baseline/check-utf8.mjs` | 非法 **0** | 编码门禁 |

门禁侧（`verification_run(release=true)` 解除阻塞后重新验证）：

```
技术验证已通过，进入收尾交接
  技术验收: verified
  回归: clean — no failures were observed and no comparison was required
  检查: test=completed
  断言: 36 条，其中未决必测项 0 条
  Task Error Ledger: 4 条 assertion/verification_gap 全部 [released]
```

**结论（对本轮最重要的一个更正）**：

- 那 17 项**从来不是代码问题**，也**从来不需要改任何测试文件**。根因始终是执行环境：
  受限沙箱拒绝 `stdio:'pipe'`，而这一层由宿主策略决定，**一行配置即可消除**。
- 我此前给出的"出路 A = 改 9–11 个测试文件（推荐）"是**错误的处置排序**：
  把"待配置的环境条件"当成了"设计前提"，转而去改被它影响的代码。
  实测证明：放宽环境后，那些改动**完全不需要存在**。
- 本批的 6 个已跟踪改动与 3 个新增未跟踪文件，**在放宽环境前后完全一致** ——
  即"技术验收通过"这件事**没有靠改任何测试或聚合器换来**。

## 6. 本次未能取得的证据（诚实清单）

1. **字节级 before-hash**：本沙箱内 `git` 不可用，且用户禁止 `reset/clean/stash/commit/push`，
   因此无法生成"改动前源码文件的 sha256"用于 before/after 对照。已改用**批次标记唯一性**
   （23 个标记全部恰好出现 1 次，`node scripts/rollback-v118.mjs --verify` exit 0）作为
   "本批可被逐字识别"的替代证据。
2. **真实审稿报告的原始 model output**：未取得，因此本报告不对"模型为何这么写"作因果断言。
3. **`docs/phase-map.md` 对账**：见 §4。
4. **判据脚本自身的一处错误（已修，留痕）**：`未通过：…` 清单在真实输出里**跨多行**，
   我的解析正则只取了最后一行 → 得到"未通过 6 项"，与 17 个失败块**自相矛盾**。
   正确处置是**把两个互相矛盾的计数当成解析错误的信号**立刻修解析，
   而不是去解释"6 与 17 谁对、哪几项算真失败"。修好后计数闭合（17 = 15 + 2）。
   同一脚本第一版还用 `execFileSync` 去抓子进程输出（→ `-1`），与 §5 的边界同源。
