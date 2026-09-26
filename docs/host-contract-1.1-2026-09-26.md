# Host Contract 变更说明：1.0.0 → 1.1.0（附加式）

- 日期：**2026-09-26**（1.0.0 冻结于 2026-09-25）
- 依据：第四步交付（`docs/story-state-kernel-2026-09-26.md`）
- 性质：**附加式**（新增门控层 / 新表 / 新端点 / 新工具）；旧字段、旧语义、旧顺序、旧预算、默认生成路径**均未改变**
- 运行时校验：`GET /api/novel/ping` → `host_contract: "1.1.0"`

## 1. 变更总表

| 面 | 1.0.0 | 1.1.0 | 兼容性 |
|---|---|---|---|
| 上下文层 | 14 | **15**（+`story_state`，`gated: true`，cap 2400，排在 `redlines` 之前） | 未开启开关时该层**不出现**、**不进 `excluded`**、**不计入下限** |
| 预算/下限 | `TOTAL_BUDGET` = 19000 / 26000；`floor(settings)` = 18173 | 逐值**不变** | 逐字节基线 50/50 |
| 弹性顺序 | `FLEX_ORDER = [story_tail, outline, world]`；`FLEX_CAPS = [2400,1600,800,400]` | **不变** | — |
| DB 表 | 25（`db.frozen_tables`） | **35**（+10 张 story_state 相关表；+16 索引，含 3 条条件唯一） | 旧库指纹 `3cb7e5d9ac4f67b9` 不变；旧表零结构改动 |
| 插件工具 | 15 | **23**（+8：`novel_state` / `novel_contract` / `novel_preflight` / `novel_validate` / `novel_state_propose` / `novel_state_commit` / `novel_snapshot` / `novel_write_pipeline`） | 旧 15 个名字与语义不变 |
| 插件端点 | 26 | **43**（+17 条确定性故事状态端点） | 旧 26 条不变 |
| 插件版本 | 0.9.0 | **0.10.0** | 三处（`novel-tools.mjs` / `plugin.json` / `package.json`）一致 |
| 质量保护不变条件 | 6 条 | **7 条**（新增第 7 条：新增能力一律门控） | 前 6 条逐字不变 |

## 2. 为什么这是安全的（可验证论证）

1. **默认关闭**：`story_state_config.enabled` 对既有作品默认 `0`。关闭时：层不在 `manifest`、不在 `excluded`、`story_state` 字段为 `null`、预检/校验返回 `enabled:false` 且**不运行**、提案登记返回 4xx 而不是静默写入。
2. **开启才 +1 层，且不挤压既有层**：活实例实测（同一作品同一章）——插入层恰好是 `['story_state']`，其余各层 `emitted` 逐层相同，`integrity` 仍为 `PASS`。
3. **旧库只读兼容**：`sqlite_master` 指纹不变；契约测试 §D 逐条核对冻结表仍在。
4. **契约三处互锁**：`server.js` 常量 / `docs/host-contract.v1.json` / 本文档与 `docs/host-contract.md`——任一处漂移，`node .p1-baseline/test-host-contract.mjs` 报红。
5. **可回滚**：关掉开关即回到 1.0.0 的可观察行为；彻底撤回 = 回退新增文件与 4 个挂载点（见交付报告 §10）。

## 3. 契约测试（1.1.0 冻结时实跑）

```
Host Contract 契约测试：通过 28 / 失败 0 / 跳过 0
契约版本 1.1.0（冻结于 2026-09-26）
```

覆盖：代码→契约漂移（层/预算/清单字段/策略/工具面/端点面/日志层级/表清单）、**负向对照**（改坏预算/工具名/信封字段必须报红）、文档→契约（23 工具、43 端点、边界、不变条件逐条）、边界→代码（前端不得自行拼装上下文、DB 只增不减、远端日志层级、ping 报契约版本、**门控层不进清单/excluded/下限**、每条端点在 `server.js` 有实现）、旧库兼容（指纹 + 冻结表）。

## 4. 插件侧新能力（1.1.0 新增，供 novel-writing 使用）

- **状态读取**：`novel_state`（开关与总览）、`GET /api/novel/state/{timeline,entities,knowledge,foreshadows,snapshots,validations,contract}`
- **写前/写后**：`novel_preflight`（`POST /api/novel/state/preflight`）、`novel_validate`（`POST /api/novel/state/validate`）、`POST /api/novel/state/quality`
- **契约**：`novel_contract`（`GET/PUT /api/novel/state/contract`）
- **提案-审核-应用-回滚**：`novel_state_propose` / `novel_state_commit` / `novel_snapshot`（`POST /api/novel/state/proposals`、`/review|apply|reject`、`/snapshot`、`/rollback`）
- **编排**：`novel_write_pipeline`（预检 → 写作 → 校验 → 提案；**不自己生成正文**）

**边界不变**：插件仍不得绕过 context budget、不得直写宿主全局 settings、不得自建第二套 task/trace/recovery、不得直接读写 `novel.db`、不得绕开策略表调 `/api/ai/*`。新增一条：**不得自行注入、伪造或强制开启门控层**。

## 5. 重新打开契约的条件（未变）

只有真实用户受影响 / 核心质量或安全阻塞 / 有实测证据的性能回归，才允许回到主体变更流程；其余一律在插件侧 adapter 解决。