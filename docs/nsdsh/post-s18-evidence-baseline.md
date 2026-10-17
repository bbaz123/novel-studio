# NSDSH S18 后收尾：R00 证据与版本冻结

> **阶段**：R00（对应《S18 后遗留问题分析与可执行收尾方案》§2）
> **状态**：`PASS`
> **性质**：**本次实测**的基线证据。它不替换、不改写 S00–S18 的任何历史 PASS。
> **原始日志**：`.nsdsh/r00/`（本地忽略目录，不入库）

---

## 1. 为什么先做 R00

《S18 后收尾方案》§1.5 指出一个真实问题：对外文档里的数字（310 断言 / 696 文件）与后续消息里的
数字（315 断言 / 698 文件）不一致，**且不清楚是不是同一个 HEAD**。在这种状态下，任何新增证据都
无法确认自己挂在哪棵树上。

R00 的唯一目的：把"我在哪个提交、什么环境、跑了什么、退出码是多少"钉死；数字口径对不上的地方
**如实标 UNRECONCILED**，不靠改数字掩盖。

---

## 2. 冻结的对象

| 项 | 实测值 |
|---|---|
| 产品仓库分支 | `Experimental-Version-v1.0` |
| 产品仓库 HEAD | `2e09705ac7a077d3040ac79c3ac8e5405ae4ee5a` |
| HEAD 提交主题 | `docs(nsdsh): S11/S14 门禁按证据修正为可执行（BLOCKED → PASS）` |
| DSH 基线位置 | `<repo>/../deepseek-harness`（兄弟目录，**不**复制进产品仓库） |
| DSH 基线 commit | `7e06df28146c8f9b14e6185d1cdb325f6b05951b` |
| DSH 基线 tag | `dsh-v0.1.7-rc.1`（`git describe --tags` 精确命中） |
| DSH 基线工作树 | 干净（`verify-vendor.mjs` 断言 `git status --porcelain` 为空） |
| Node | `v24.19.0`（项目要求 ≥ 22.13） |
| 宿主 | `win32 10.0.26200 x64` |

> 以上 HEAD 与基线 commit 是**本轮全部新增证据的锚点**。任何一条新证据若不在这个 SHA 上取得，
> 必须显式写出它自己的 SHA。

## 3. 用户未提交修改的处理

`git status --porcelain` 共 **22** 条：

| 类别 | 数量 | 处理 |
|---|---|---|
| `M README.zh-CN.md` | 1 | **作者本人的未提交修改。全程不 stage、不 reset、不 checkout、不 stash。** |
| `??`（21 个作者文档 `.md`） | 21 | 同上，原样保留在工作树 |

**纪律**：本阶段不使用 `git reset --hard`、`git clean -fd`、`git checkout -- .`，也不强推。
每次提交都用**显式期望文件清单 + 双向精确比对**（见 R00 §7），绝不用 `git add -A`。

## 4. 命令与退出码（一条命令一个退出码）

全部零计费、不联网、不调用真实模型。原始输出见 `.nsdsh/r00/`。

| # | 命令 | 退出码 | 观测结果 | 耗时 |
|---|---|---|---|---|
| 1 | `node scripts/run-nsdsh-tests.mjs` | **0** | `suites=45 suitesFailed=0 passed=315 failed=0 total=315` | 30s |
| 2 | `node scripts/test-temporal-refactor.mjs` | **0** | `通过 15 / 未通过 0（15 个子套件）` | 72s |
| 3 | `node scripts/ci-offline-checks.mjs` | **0** | `通过 55 / 未通过 0` | 145s |
| 4 | `node .p1-baseline/verify-phase-map.mjs` | **0** | 真实改动集 **698** 个文件，全部有归属 | 1s |
| 5 | `node .p1-baseline/check-utf8.mjs` | **0** | 扫描 **6678** 个文本文件；非法 UTF-8 **0**；缺 BOM 的 `.ps1` **0** | 2s |
| 6 | `node scripts/nsdsh/check-stage.mjs S18 --offline` | **0** | `状态 PASS`，`通过 6，未通过 0` | 1s |
| 7 | `node scripts/nsdsh/verify-delivery.mjs` | **0** | 12 项检查全过；剩余限制按台账如实列出 | 1s |
| 8 | `git diff --check` | **2** | 12 条告警，**全部来自 `README.zh-CN.md`**（作者的未提交文件） | — |

### 4.1 关于第 8 条

`git diff --check` 退出码 2 是**预期**的：它检查的是工作树未提交 diff，而作者在
`README.zh-CN.md` 里留了行尾空格。逐行归属核对过，输出 **12 行 = 6 条告警 ×（1 行位置 + 1 行内容）**：

```
README.zh-CN.md:194  README.zh-CN.md:197  README.zh-CN.md:200
README.zh-CN.md:215  README.zh-CN.md:218  README.zh-CN.md:221
```

**6 条全部来自 `README.zh-CN.md` 一个文件，没有一条来自本轮或历史 NSDSH 改动。**
我们不修改作者的文件来把这个检查"弄绿"——那属于改动用户未提交内容。

## 5. 数字口径对账（310/315、696/698）

结论：**两个数字都真实，差异可完全归因，不是矛盾。**

| 数字 | 出处 | 为什么不同 |
|---|---|---|
| 44 套件 / 310 断言 / 696 文件 | `docs/nsdsh/STATUS.md` 原文 | 写 STATUS 时用的是**加入 S18 交付套件之前**的计数 |
| 45 套件 / 315 断言 / 698 文件 | 本次实测 | 同一提交 `a79eb6c` 里**新增**了 `tests/nsdsh/delivery-report.test.mjs`（5 条断言）与 `scripts/nsdsh/verify-delivery.mjs`（2 个新文件 ⇒ 696+2=698） |

证据：`git show --stat a79eb6c` 同时列出

```
scripts/nsdsh/verify-delivery.mjs            | 161 ++++++
scripts/run-nsdsh-tests.mjs                  |   2 +
tests/nsdsh/delivery-report.test.mjs         |  80 ++++++++++
.p1-baseline/verify-phase-map.mjs            |   3 +
docs/phase-map.md                            |   6 +-
```

即"加套件"和"写 STATUS 数字"发生在同一个提交里，STATUS 的数字取早了一步。
**对账结果：`RECONCILED`**（44+1=45 套件，310+5=315 断言，696+2=698 文件，逐项闭合）。

**本轮已做的修正**：把 `STATUS.md` 的三处计数改成实测值（45/315/698），并在
`verify-delivery.mjs` 修掉一条**已经变成假话**的限制说明（它还在说 S11/S14 是
`BLOCKED / build-prereq-explicit`，而这两阶段已按证据改成 `networkPolicy: none` 并 PASS）。
这不是"改数字掩盖问题"，而是让文档与可复现的实测一致。

## 6. R00 没有证明什么（必须一起读）

- **不是**新的能力证据：本轮之前"未验证"的四项，R00 之后**仍然是未验证**：
  macOS/Linux、真实裁剪发行物、真实模型质量、真实 SDK 子进程。
- **不是**跨平台结论：本表全部来自 `win32 x64` 单机。
- **不是**性能结论：R00 只记耗时量级，不做基准声明（基准见 S15）。

## 7. 后续阶段的提交纪律（从 R00 起生效）

1. 每个阶段**一个**可审阅提交，主题前缀按方案 §9.2。
2. 提交前跑：`git diff --check`（只看自己改的文件）、`verify-phase-map`、`check-utf8`、
   `run-nsdsh-tests`、`check-stage <stage> --offline`。
3. **stage 纪律**：把期望文件写进 `.nsdsh/expected-<stage>.txt`，`git add` 后做**双向精确比对**
   （staged ⊄ expected 且 expected ⊄ staged 都算失败）。
4. `README.zh-CN.md` 与 21 个 `??` 作者文档**永不出现在任何 staged 列表里**。
