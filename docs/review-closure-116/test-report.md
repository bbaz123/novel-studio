# test-report.md —— 真实命令 / 退出码 / 断言数

> ⚠️ **本文档的记录属于主轮**（`narrative-repair` 227 条）。**当前值 = 240 条**
> （后续补充轮补了 T41/T51/T16/T19，闭环轮补了 T05-b）；当前状态以
> [execution-state.json](execution-state.json) 与 [final-summary.md](final-summary.md) §15 为准。

> 纪律：只记**实际跑过**的东西；0 条断言不算通过；跳过不算通过；环境阻塞如实标 `not_run(env_blocked)`。
> 本会话沙箱限制见 `source-map.md` §2（禁子进程管道 stdio）。

## 1. 本轮实际执行的命令

### 1.1 叙事专项套件（逐套件直接执行，只信退出码）

```powershell
cd C:\Users\a1941\Desktop\DeepSeek\novel-studio
foreach ($s in (Get-ChildItem tests/narrative-repair -Filter *.test.mjs -Name | Sort-Object)) {
  node "tests/narrative-repair/$s"
}
```

| 套件 | 退出码 | 断言 | 未通过 |
|---|---|---|---|
| `01-patch-protocol.test.mjs` | 0 | 65 | 0 |
| `02-fixtures.test.mjs` | 0 | 8 | 0 |
| `03-stage-rules.test.mjs` | 0 | 17 | 0 |
| `04-narrative-scan.test.mjs` | 0 | 24 | 0 |
| `05-revision-plan.test.mjs` | 0 | 19 | 0 |
| `06-report.test.mjs` | 0 | 16 | 0 |
| `07-review-structure.test.mjs` | 0 | 10 | 0 |
| `08-authorization.test.mjs` | 0 | 26 | 0 |
| `09-information-truncation.test.mjs` | 0 | 11 | 0 |
| `10-new-sample.test.mjs` | 0 | 12 | 0 |
| **`11-review-closure.test.mjs`（本轮新增）** | **0** | **19** | **0** |
| **合计** | **0** | **227** | **0** |

日志：`.narrative-repair-116/closure-final-suites.log`

### 1.2 总入口（已加同进程回退）

```powershell
node scripts/test-narrative-repair.mjs
```

```text
提示：当前环境不允许子进程管道（spawnSync status=null）→ 改用**同进程**逐套件执行（断言与退出码判定不变）。
✓ 11 个套件全部通过
合计：通过 11 / 未通过 0（共 11 个套件，零计费）
EXIT=0
```

> 回退**只替换传输方式**（管道 → 同进程 `import`），断言集合与退出码判定逐字不变；
> 在允许管道的环境里仍走原子进程路径。

### 1.3 前端执行验证（vm + DOM 桩）

```powershell
node frontend-test.mjs
```

```text
=== ALL PASS ===
EXIT=0
```

新增断言（本轮）：

| 用例 | 断言内容 | 结果 |
|---|---|---|
| `S01-a` | 扫描结果被声明为"候选信号"，且不再含"扫描命中的要写进 issues" | PASS |
| `S01-b` | 提示词给出 `not_applicable` 出口与逐条判断要求 | PASS |
| `S01-c` | 合法语境可用 `deferred` + `counterevidence` 处置 | PASS |

回归证据：本轮对 `public/app.js` 的改动曾让既有断言 `107c 未定位提示不再泄漏 Markdown 字面量（**）` 变红
（我新写的文案里用了字面 `**`），已改文案并复跑 → 全绿。这条回归是**真实发生并被修掉**的，不是事后声称。

### 1.4 本地探针（一次性调参，不入 CI）

```powershell
node .narrative-repair-116/probe-perception-candidates.mjs
```

```text
--- plan shapes (expected to fire) ---
F08 全场静止（C 级普通）: ["reaction_causality|可大厅里安静了"]
M02 触觉→密度断言: ["focalization_limit|他把右手按在石板上。石板的密度比普通石头高。"]
M03 隔队伍知掌心余温: ["focalization_limit|他隔着队伍看了一眼李拓，李拓掌心还残留着一点金色的余温。"]
{
  "fixture_noise_candidates": 0,
  "plan_shape_candidates": 3,
  "targets": 18
}
EXIT=0
```

结论：在**全部 18 个既有目标文本**上误报 0 条；三个计划形状全部命中。这是"新诊断不会把既有阴性对照变红"的证据。

## 2. 环境阻塞（不是通过，也不是代码回归）

| 命令 | 观察 | 判定 |
|---|---|---|
| `node scripts/ci-offline-checks.mjs` | 54/54 报红，全部 0–1ms | `not_run(env_blocked)` |
| `node .p1-baseline/test-editing-rules.mjs` | 断言部分全绿后 `Error: spawn EPERM`（`.p1-baseline/test-editing-rules.mjs:201` 起隔离实例） | `not_run(env_blocked)` |
| `node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs` | 未执行（需子进程起服务） | `not_run(env_blocked)` |
| `node .p1-baseline/verify-plugin-tools.mjs` | 退出码 0，"工具面／版本／端点声明三者一致（26 个工具）" | 通过 |

**根因证据**（同一条命令两种 stdio）：

```text
spawnSync(..., {encoding:'utf8'})                      => status=null  error.code=EPERM
spawnSync(..., {stdio:['ignore','inherit','inherit']}) => status=0
```

`.p1-baseline/test-editing-rules.mjs` 导入的是 `ai/editing/rules.mjs` 与 `ai/editing/scan.mjs`，
**两者本轮都未修改**；崩溃发生在"起隔离 HTTP 实例"这一步，而不是断言阶段。

## 3. 旧失败 vs 新失败

| 类别 | 数量 | 说明 |
|---|---|---|
| 本会话开始前既有的失败 | 1 类 | `docs/phase-map.md` 与真实改动集不一致（上一轮已记录为 `pre_existing`，与本轮无关） |
| 本轮引入、已修复的失败 | 1 | `frontend-test.mjs` 107c（我的新文案含字面 `**`）→ 已改文案，复跑全绿 |
| 本轮引入、**未**修复的失败 | **0** | — |
| 本轮的 `not_run` | 5 项 | 见 `baseline.json.not_run` |

## 4. 断言数与"通过"的可靠性

- 每个套件都经 `createChecks().finish()`：**零用例 → `process.exit(2)`**，不会被当成通过。
- `check()` 形状自适应（既接受 `check(id, desc, cond, detail)`，也接受 `check('id 描述', cond, detail)`），
  避免"描述落到 cond 位→恒真"的假绿。
- 本轮新增的 19 条断言里，**5 条是阴性对照**（T21-c、T06-b、T31-c、T31-d、T22-c 的"不带 delete/不新增能力"），
  用来证明修复没有把正常路径一起拦掉或误报。

## 5. 尚未验证

1. 真实模型语义审稿与文学效果 A/B —— `SKIPPED: paid_evaluation_not_authorized`；离线 mock **不得**被写成"自然度实测提升"。
2. `ci-offline-checks` 54 项与 `api-test-suite.mjs` HTTP 往返 —— 环境阻塞，需在允许子进程管道的环境执行：
   ```powershell
   node scripts/ci-offline-checks.mjs
   node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs
   ```
3. 本轮真实正文 6357/4000/5000 的本地口径复算 —— 缺完整正文。
4. `server.js` 的 `consistency` 字段往返（HTTP）—— 代码路径已确认（`saveReview` 序列化整份 structured，
   无需迁移），但**没有**在隔离实例上跑过 HTTP 往返；属第 2 项的一部分。

## 6. 可信度自评

| 结论 | 等级 |
|---|---|
| 227 条断言全绿、11/11 套件 | **实测**（本文档 §1.1/§1.2） |
| 新诊断在 18 个既有文本上零误报 | **实测**（§1.4 探针） |
| S01 提示词已候选化 | **实测**（frontend S01-a/b/c） |
| S05-1 fail-closed | **实测**（T31-a/b/c/d） |
| 报告自洽检测 | **实测**（T05-a/T06-a/T06-b） |
| 篇幅缺口如实呈现 | **实测**（T41-a/b）+ 源码核对 |
| 文学效果提升 | **not_run** |
