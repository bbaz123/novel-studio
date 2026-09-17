# docs/ 索引

> 🧑💻 **第一次用这个项目、只想尽快跑起来？** 请看 **[新手入门.md](新手入门.md)** ——
> 装 Node.js → 下载 → 双击启动 → 写出第一章 → 出错了怎么查，全在里面。
>
> 📌 **本页是面向开发者的文档索引**：收录的基本都是各轮重构的验收报告、验证记录与自审材料，
> 对"只想用起来"的读者没有帮助，不必往下看。

---

⚠️ **先读这一条**：本目录混有**两批**文档，它们描述的是**不同版本的代码**。

- **本次 AI 内核重构（2026-09-15，P0–P6）** —— 描述**当前**代码，引用的模块与符号有效。
- **历史报告（2026-09-06 ~ 09-14）** —— 描述**重构前**的代码。里面的行号、函数分布
  （上下文预算与收敛当时还在 `server.js` 里）**已经过时**，只能当"当时发生了什么"的证据读，
  不要照着它找代码。

---

## 一、本次重构（P0–P6）· 描述当前代码

按建议阅读顺序：

| 文档 | 内容 |
|---|---|
| **`ai-core.md`** | **入口。** AI 内核的现状：一张图、四个组成、一次成文请求的数据流、怎么验证、已知缺口 |
| `context-contract.md` | 上下文契约与不变量 I1–I7；四条装配路径；层规格；可执行下限；偏离清单与处置状态 |
| `p2-assembler-verification.md` | P2 验收：装配器抽取（55/55 逐字节等价）、主成文路径统一（−73% 输入）、缓存 TTL |
| `p3-retrieval-verification.md` | P3 验收：I4「凡裁剪必可查回」端到端成立；**记忆库内容缺失**的排查证据 |
| `p4-policy-verification.md` | P4 验收：模型策略单点化（0 处绕过）、全分支核对表 |
| `p5-memory-eval-verification.md` | P5 验收：截断提示改为指向真实可用工具；AI 效果埋点 |
| `p6-cutover-runbook.md` | P6 切换手册：前置、彩排结果、执行步骤、回滚、待决事项（**待批准执行**） |
| `self-review-p0-p6.md` | 全量自审：项目原生三套件结果、既有失败的对照实验、发现并修复的问题 |
| **`final-acceptance-p0-p6.md`** | **最终验收报告**：P0–P6 逐条对账、I1–I7 状态、**回滚真相**（无可独立回滚的阶段 → 提交粒度）、约束遵守情况、遗留事项；含一次性完整验收结果（29 通过 / 0 未通过 / 0 跳过，零计费双重佐证） |
| **`phase-map.md`** | **阶段 → 改动面 → 回滚**（自动生成）：哪些阶段可独立回滚、哪些共享文件只能整体回滚；由 `verify-phase-map.mjs` 与真实改动集对账 |
| **`pending-decisions.md`** | **待决事项（六件）**：提交、P6 执行、索引重建、吞吐对齐、日志噪声、埋点孤儿——各列现状/选项/影响代价/建议；刻意不复制数字，避免漂移 |

配套的可复现验证工具在 `.p0-recon/`、`.p1-baseline/` 与 `.p6-cutover/`（各有 README）。
一键跑全部验证：`node .p1-baseline/verify-all.mjs`。

**要跑齐全部检查，需要这三种前置**（缺哪个，套件就把对应项标成「跳过」而**不是**通过）：

```powershell
# ① 活实例 → 解锁 I4 可查回、主成文路径同源、编辑距离端到端、压缩提示自发现
node .p1-baseline/gate-env.mjs --data-dir .p1-baseline/stress-data   # 前台；六项隔离变量一次配齐
# ② 显式授权 → 解锁两条会真的 spawn dsh 的检查（零计费，且自带跑后审计）
#    $env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'
# ③ 闸门并发验证 → 另需 --gate-base 且 NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1
node .p1-baseline/gate-env.mjs --stop                                 # 收工
```

**成本自证**：任何一段跑完都可以核对「到底有没有花钱」：

```powershell
node .p1-baseline/audit-llm-calls.mjs --since 2026-09-15T00:00Z   # 真实调用清单（含提示词与模型）
```

**项目原生三套测试**的复现方式（含 3738 端口与 `.test-data-trace` 的前置）见
`docs/self-review-p0-p6.md` §一·补。隔离环境与成本纪律详见 `docs/p6-cutover-runbook.md` §八
与 `.p1-baseline/README.md` §六。

> **P6 切换已工具化**：S1 备份与 S3 翻转收进 `node .p6-cutover/cutover.mjs`
> （预检 → 彩排 → 令牌确认 → 执行 → 可回滚）。彩排 10/10、离线单测 32/32 通过；
> **真实切换未执行**（`harness.js` 仍是 `pre-cutover`）。

> ⚠️ **成本纪律（2026-09-15 事故后新增）**：`verify-all.mjs` 默认**不跑**任何会创建
> harness 任务或调起 dsh 的检查——那些路径可能产生**真实计费调用**。需要显式授权
> （`NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1` / `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`）。
> 套件最后一条是**总闸**：本次窗口内检出任何真实调用即判未通过。
> 事故经过与硬约束见 `.p1-baseline/README.md` §六。**别再假定「死端口 = 零成本」**。

---

## 二、历史报告 · 描述重构前的代码

保留作为"当时发生了什么"的证据，**其中的行号与函数分布已过时**。

### 上下文与记忆
- `context-memory-analysis-report.md` —— 重构前的上下文/记忆四层架构逐层精读
- `context-optimization-plan.md` / `-implementation-report.md` / `-review-report.md` —— 2026-09-13 那轮
  上下文优化（**复盘出的 5 处失误见 OpenViking 偏好记忆**：预算常量不核算下限、规模断言用小数据、
  字符串匹配未限定层边界、新增枚举不同步描述、把"质量优先"写成会伤质量的机制）

### 代码审查与走查
- `code-review-report.md` —— 2026-09-06 全库审查（161 个问题）
- `professional-experience-report.md` / `novice-experience-report.md` —— 专业与新人体验走查
- `fix-summary-2026-09-06.md` / `-novice.md` —— 对应的修复清单

### 运行追踪
- `run-trace-review-2026-09-14.md` / `-round2` / `-round3` —— 三轮追踪复核（缺陷 D1–D5）
- `change-review-2026-09-14-round2.md` / `-round3.md` —— 对应改动复审
- `ov-append-section.md` / `-round2.md` —— OpenViking 附加章节

### 其它
- `agent-change-review-2026-09-13.md` —— 模型路由改造的自审（含"注释只写主路径"的教训来源）
- `CHANGELOG.md` —— 版本记录
