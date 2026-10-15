# NSDSH · 实施计划（Novel Studio × DSH 架构优化）

> 本文件是仓库内的**执行版计划**。第三方方案稿 `novel-studio-dsh-optimization-plan.md` 按作者任务书处理
> （已在 `.gitignore`，不上传公开仓库）；本文件是它的落地裁剪版，**以本地真实代码为准**。
> 基线事实与证据见 [`baseline.md`](baseline.md)；改造边界见 [`adr-001-boundaries.md`](adr-001-boundaries.md)。
> 进度见 [`STATUS.md`](STATUS.md)；阶段清单见 [`stages.json`](stages.json)。

- 开始日期：2026-10-15
- 基线 HEAD：`b7919f75624c4e788fd3ffe916f2339ec8f04913`（`Experimental-Version-v1.0`）
- 批次：NS-A → NS-B → NS-C → NS-D → NS-E（对应方案稿 S00–S18，串行）

---

## 1. 目标与成功判据

**目标**：在不破坏旧正文与历史状态的前提下，最新修订能可靠进入分析队列；候选绑定正确版本并有完整覆盖说明；
作者确认后原子推进正式状态；界面可恢复地收到更新；DSH 以可追溯、可隔离、可取消、可回退的小说专用运行时工作；
发行物通过依赖与行为验证。

| # | 判据 | 证据形式 |
|---|---|---|
| G1 | 保存不依赖模型；正文 + 不可变修订 + pending 绑定 + 分析意图同事务 | 故障注入 + 事务边界断言 |
| G2 | 重启后待分析意图可恢复；旧 worker 不能覆盖新修订 | 恢复 / 租约 / fencing 套件 |
| G3 | 长章分析能证明"覆盖了哪些文本"；部分覆盖不得报"无变化" | coverage manifest + 12k 之后事实用例 |
| G4 | 正式状态重复应用 0 次；跨作品 / 过时结果写入 0 次 | 隔离回归 + 幂等回归 |
| G5 | 模型拿到的工具集合 = 审批允许集合；模型无法确认正式状态 | 能力清单捕获 + 403 边界 |
| G6 | 发行物在干净环境可启动，不回落开发源码树 / 全局包 | staging clean-room |
| G7 | required 检查全通过；SKIPPED / BLOCKED 不冒充 PASS | `scripts/nsdsh/verify-delivery.mjs` |

---

## 2. 与方案稿的差异（对账结论，详见 baseline.md §3–§6）

- **F01–F12 全部在本工作区成立**（F11 需订正归属：通用文件工具来自 bundle/preset 组合，不是插件代码）。
- 方案稿**未覆盖**、本轮新增确认的缺陷 **D1–D6**：
  D1 HEAD CAS 竞态且 parent 为 null 时跳过校验；D2 `validateEventSet` 失败返回不抛 → 孤儿事件入库；
  D3 `HEAD_CAS_MISMATCH` 无 HTTP 处理点（500 而非 409）；D4 迁移不包事务、无账本；
  D5 确认重放先于输入/信任复核返回复用回执；D6 契约声明了代码从不读的 `NOVELSTUDIO_HARNESS_POOL`。
- 方案稿**误判为缺失**、实际**已存在**的：时态内核 T0–T8 全部 DONE、一次性作者审批、模型/作者双通道、
  隔离配方、门禁体系、前端状态与竞态/IME 防护、热备池与 SDK worker（已写、已离线测试、**未接线**）。
- 方案稿**确实缺失**的：持久化分析任务与恢复、抽取完整性与完整摘要、按 purpose 的模型路由、
  可恢复的领域事件流、temporal 侧的稳定实体 ID、保存回执的四种版本区分、发行物闭包与裁剪。

---

## 3. 批次划分

| 批次 | 对应方案稿阶段 | 主题 |
|---|---|---|
| **NS-A** | S00–S02 | 基线冻结（已完成）、阶段门禁与运行器、行为表征 |
| **NS-B** | S04 / S06 / S10 | 持久化任务与恢复、抽取完整性与摘要、模型 broker |
| **NS-C** | S03 / S05 / S07 / S09 | 入口拆分（并修 D1/D2/D3/D5）、稳定实体身份、时点读取溯源、工具能力 |
| **NS-D** | S11–S14 | vendor 上游固定提交、小说专用 profile、SDK 适配、发行物与闭包（含修 F10） |
| **NS-E** | S15–S18 | 故障矩阵与性能、迁移演练与灰度、清理旧桥接、最终交付 |

每批结束必须：跑该批 `check-stage` + 公共回归 → 更新 `STATUS.md` 与 `docs/phase-map.md` → 形成一个可审阅提交。

---

## 4. 关键设计决定（决策完整）

### 4.1 持久化分析调度（NS-B，修 F01/F02/F03）
- 新增 `story_analysis_tasks` / `story_analysis_attempts`（`db.js` 附加式迁移）。
- 保存事务只写意图（`not_before_ms = now + debounce`）；删掉 `server.js` 的 `temporalAnalysisQueue` /
  `temporalImpactQueue` 及其全部 timer。
- **trailing debounce**：每次保存把 `not_before_ms` 往后推；超过 `max_wait_ms` 封顶（修 F02）。
- 单一 dispatcher（由显式 bootstrap 启动）：领取短事务内完成 `lease_generation+1` 与置 running；
  **模型调用在事务外**；回写事务校验 lease owner + generation + cancel/obsolete + 精确前置条件。
- 启动 reconciliation：租约过期的 `running` 任务，`transport_state='not_sent'` → 回 `queued`；
  `'sent'` → `unknown`（**不自动重发**，作者决定并提示可能再次计费）。
- `harness_jobs` 保留为历史/兼容展示，**不形成第二个调度器**。

### 4.2 抽取完整性与摘要（NS-B，修 F05–F08）
- 提示词里的 `domain`/`scope` 从 `schema.mjs` 生成（修 F06）；已知实体带稳定 ID。
- `request_digest_v2` 覆盖完整渲染请求 + 修订/文本摘要 + 输入快照与 lineage + 身份映射版本 +
  提示词/normalizer/算法版本 + 去密钥的模型路由（修 F07）；
  `response_digest_v2` = 完整被接受响应字节的 SHA256（修 F08）。旧 `input_hash`/`resultHash` 只读兼容。
- 全章分块 + coverage manifest（`complete` 只表示"约定输入与处理单元被覆盖"）；`7/8` 块 → `partial`，
  **不得**返回"没有变化"。证据区间声明计量单位（规范化文本 UTF-16 offset）。
- 同时修 D4：`MIGRATIONS` 包事务 + 新增 `schema_migrations` 账本。

### 4.3 模型路由（NS-B，修 F04）
- `ai/model-broker/`：按 `作品 + purpose` 解析路由；时态分析不再取"第一条带 key 的配置"。
- `ai/policy.mjs` 仍是模型名/思考强度唯一来源（`verify-ai-branches.mjs` 必须保持绿）。
- 支持显式本地无 key 路由（端点为回环/内网且 `api_key=''` 的显式白名单）；不自动切换付费 provider。

### 4.4 稳定身份（NS-C，修 F09）
- 复用 `ai/story-state/entities.mjs` 的规范化/别名/冲突逻辑；解析结果只有"唯一命中 / 缺失 / 歧义"，
  歧义进作者映射队列，**绝不自动合并**。
- v2 cell：角色用稳定 `entity_uid`；关系用 `{subject, relation_type, object, scope, holder}`，
  对称性由关系类型表决定。旧算法保留 reader；**正式切换留给 S16 且需作者批准**。
- 兼容投影不再按 `characters.name` 连接。

### 4.5 运行时（NS-D）
- vendor 固定提交 `7e06df28146c8f9b14e6185d1cdb325f6b05951b`（0.1.7-rc.1，**现有集成面向的那条线**）。
- `runtime manifest` 取代 `isHarnessBuilt()` 的产物文件猜测（修 F10），旧标记只作 legacy 兜底。
- 热备池与 SDK worker 接到 `RuntimeAdapter`；**无法可靠取得真实 session 上下文时保持一任务一进程**。

---

## 5. 仓库强约束（每批都要同步改，漏一个就红）

| # | 位置 | 规则 |
|---|---|---|
| 1 | `db.js` `MIGRATIONS` | 附加式；新表 `CREATE TABLE IF NOT EXISTS`；新列登记进数组 |
| 2 | `.p1-baseline/verify-phase-map.mjs` | 每批新增阶段条目并逐条列文件；改完 `--write` 重生成 `docs/phase-map.md` |
| 3 | `scripts/ci-offline-checks.mjs` | 新离线检查登记进 `CHECKS` |
| 4 | `scripts/test-temporal-refactor.mjs` | 新 temporal 套件登记进 `TEMPORAL_TESTS` |
| 5 | `server.js` `HOST_CONTRACT_VERSION` | 与 `docs/host-contract.v1.json`、`docs/host-contract.md`、`test-host-contract.mjs` 四处互锁 |
| 6 | `docs/README.md`、`docs/CHANGELOG.md` | 文档索引与变更记录 |
| 7 | `docs/context-contract.md` | 数字必须等于 `ai/context/layers.mjs` |
| 8 | `.gitignore` | 任务书类文档与 `.nsdsh/`；vendor 的 `pnpm-lock.yaml` 需否定规则 |
| 9 | `.p6-cutover/snapshot.mjs` `EXCLUDES` | `.nsdsh/` 不进快照 |
| 10 | `ai/story-state/temporal/index.mjs` | 新模块必须从唯一入口 re-export |
| 11 | `ai/policy.mjs` | 模型/强度字面量唯一来源 |
| 12 | `plugins/novel-writing/plugin.json` | `tools`/`engineEndpoints` 与实际注册数一致（26 工具） |

---

## 6. 执行纪律

1. **串行推进**，每批一个可审阅提交，不混入无关重构。
2. **先取证再动手**；红灯先归因：环境缺料 → BLOCKED，真回归 → FAIL；`SKIPPED ≠ PASS`。
3. **不撤销作者已有改动**；不 `checkout` / `reset` / `stash` / 强推。
4. **改行为前先备份**：`data/backup-<label>-<yyyymmddhhmmss>/`（`files/` + `uncommitted.diff` +
   `git-status.txt` + 恢复说明 README）。
5. **零计费**：默认 fake provider + 临时库 + 临时 `NOVELSTUDIO_DSH_HOME` + 隔离端口。
6. **不要动别人的东西**：作者真实库 `data/novel.db`、用户全局 `~/.dsh`、同级上游 checkout、全局 npm 安装。
7. **沙箱限制**：DSH 文件沙箱禁止子进程使用管道 stdio；阶段台账类门禁（内部 `execFileSync('git')`）
   必须在**普通终端**执行，沙箱内跑不了就标 BLOCKED。

**红线**：不建第二套事实库；不让模型确认正式状态；不用旧结果覆盖新修订；不按名字自动合并实体；
不把截断/部分分析标成"完整无变化"；不因 state hash 相同跳过 lineage 校验；不在事务里 await 网络；
不把进程内 timer 当持久真相；不原样套用 `sdk-minimal` 的宽权限；不编造 SDK 取消方法；不先删目录再修构建；
不为过门禁删测试 / 放宽断言 / 把 SKIPPED 改成 PASS；不把密钥与完整正文写进普通日志。
