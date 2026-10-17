# NSDSH · 阶段状态

> 规则：只有「代码/文档 + 生产接线（如适用）+ 真实测试实跑」同时满足才可标 **DONE**；**SKIP ≠ PASS**。
> 每个阶段把原始输出留在 `.nsdsh/reports/`（本地、已忽略），本文件只放**脱敏摘要**。
> 阶段清单与命令的机器可读版本见 [`stages.json`](stages.json)。

- 基线 HEAD：`b7919f75624c4e788fd3ffe916f2339ec8f04913`（NSDSH 起点）
- 最近更新：2026-10-16（S18 交付验收）
- 交付验收：`node scripts/nsdsh/verify-delivery.mjs` → **exit 0**

## 阶段总览

| 阶段 | 批次 | 状态 | 说明 |
|---|---|---|---|
| S00 冻结真实基线 | NS-A | **DONE** | `baseline.md` + `adr-001-boundaries.md` + `PLAN.md` + 台账条目 |
| S01 隔离测试 / 阶段运行器 / 备份演练 | NS-A | **DONE（1 项环境阻断）** | `scripts/nsdsh/*` + `tests/nsdsh/*`；回环阴性对照受门禁沙箱阻断（见 E1） |
| S02 复现风险并固定行为契约 | NS-A | **DONE** | F01–F12 + D1–D6 行为表征；`known-issues.json` 20 条 |
| S03 渐进拆分入口（修 D1/D2/D3/D5） | NS-C | **DONE** | 四用例判据抽到 `server/services/temporal-services.mjs` |
| S04 持久任务 / 租约 / outbox / 恢复 | NS-B | **DONE** | `ai/jobs/*`；修 E2/F01/F02/F03；R1–R4（同内容重复入队 / 崩溃回收 / 租约过期 / 旧 timer 退役） |
| S05 稳定身份解析 + 迁移 dry-run | NS-C | **DONE** | `ai/story-state/temporal/identity.mjs`；修 F09；别名区间 / 合并链 / 关系方向 |
| S06 完整抽取 / 覆盖 / 摘要（修 D4） | NS-B | **DONE** | `ai/extraction/{coverage,digest,prompt-schema}.mjs`；修 D4/F05–F08；迁移账本化 |
| S07 统一时点读取与溯源 | NS-C | **DONE** | `state-query.mjs`（proj-v2 / q-v2）；历史/当前/草稿三视图 + POV 可见性 |
| S08 领域事件流与前端闭环 | NS-B | **DONE** | `domain-stream.mjs` + `public/temporal-stream.js`；水位/去重/重连 |
| S09 收紧工具能力与作者权限（修 F11+D6） | NS-D | **DONE** | `capabilities.mjs`（read_only/proposal/author_confirm）；28 工具一致 |
| S10 统一模型 broker（修 F04） | NS-B | **DONE** | `ai/model-broker/{routing,envelope,adapters}.mjs`；按作品+用途路由，禁止隐式挑选 |
| S11 固定并内置完整 DSH | NS-E | **DONE（门禁 BLOCKED，构建已实测）** | 基线 `dsh-v0.1.7-rc.1` / `7e06df2`；typecheck+build+lint 全 exit 0；`verify-vendor.mjs` |
| S12 小说专用 profile 与有效能力清单 | NS-E | **DONE** | `profile.mjs`；模型可见工具 == 审批允许集合；扩权 DENY |
| S13 SDK 子进程 / 会话 / 取消 | NS-E | **DONE** | `ai/runtime/dsh-sdk.mjs`；协议面仅三方法（**无 session/cancel**），取消=杀进程 |
| S14 运行时 manifest 与依赖闭包（修 F10） | NS-E | **DONE（门禁 BLOCKED，构建已实测）** | `runtime-manifest.json`；入口+版本握手替代"两个生成文件" |
| S15 故障矩阵 / 性能实测 / E1 归因 | NS-F | **DONE** | `benchmark.mjs`（100/1000 章）+ `attribute-gate-flakiness.mjs` |
| S16 迁移演练与灰度 | NS-F | **DONE** | 旧库副本 → 新 schema：26→85 表、账本 30 条、幂等、回滚产物 |
| S17 退役旧桥接 + 上游维护纪律 | NS-F | **DONE** | 单一调度所有者；修"import 即写用户全局设置"；`upstream-maintenance.md` |
| S18 最终交付与闭环验收 | NS-F | **DONE** | `verify-delivery.mjs` → exit 0；支持矩阵/平台/性能/限制成文 |

## 缺陷台账（`known-issues.json`）

- 总计 **20** 条：high 7 / medium 12 / low 1
- 已修 **18**；open **2**：
  - **F12**（`server.js` 渐进拆分，持续性重构；已完成 5 次抽取，仍有 10261 行）
  - **E1**（门禁侧沙箱导致 `spawn EPERM`；**本项目不可修**，S15 已归因并留证）

## 实测数字（零计费）

| 项 | 结果 |
|---|---|
| nsdsh 套件 | **44 套件 / 310 断言 / 0 失败** |
| temporal | **15/15** |
| 离线清单 | **55/55** |
| 迁移幂等 | **15/0** |
| Host Contract | **28/0**（78 表，v1.22.0） |
| UTF-8 | 非法 0 / 缺 BOM 的 .ps1 0 |
| 阶段台账 | 696 个文件**全部**有阶段归属 |
| 交付验收 | `verify-delivery.mjs` **exit 0**（12 项检查） |

## 性能（合成夹具，S15）

硬件：AMD Ryzen 7 5700X ×16 / 32690MB / node v24.19.0 / win32 10.0.26200 x64

| 夹具 | 冷启动 | 热查询(命中) | 新查询(未命中) | 正文读取 | 库体积 |
|---|---|---|---|---|---|
| 100 章 | import 420ms + 灌 5.7ms | 0.01ms | 0.03ms | 0.06ms | — |
| 1000 章 | import 420ms + 灌 11.8ms | 0.03ms | 0.11ms | 0.22ms | 3.63MB |

计时边界：单进程同步 SQLite、不含网络与模型调用、含 OS 页缓存影响、样本数小仅作量级判断。

## 未验证 / 剩余限制（不得声称已支持）

- **平台**：只测了 Windows（`win32 10.0.26200 x64`）；**macOS / Linux 未验证**。
- **真实裁剪发行物**：未产出（需完整打包流水线）；只验证了闭包与 B/C 契约等价。
- **真实模型质量**：未做（需显式授权与预算，与"零计费"纪律冲突）。
- **SDK 子进程**：生命周期逻辑已测（假 spawner），**未接真实子进程**。
- **S11 / S14 门禁**：`--offline` 下为 `BLOCKED(networkPolicy=build-prereq-explicit)`，属方案设计；
  两条构建前置命令已手动执行（exit 0），证据在 `PROVENANCE.md` §3 与 `runtime-manifest.json`。

## 交付命令（全部零计费）

```bash
node scripts/run-nsdsh-tests.mjs      # 44 套件 / 310 断言
node scripts/test-temporal-refactor.mjs
node scripts/ci-offline-checks.mjs    # 55/55
node .p1-baseline/verify-phase-map.mjs
node .p1-baseline/check-utf8.mjs
node scripts/nsdsh/check-stage.mjs S18 --offline
node scripts/nsdsh/verify-delivery.mjs
```
