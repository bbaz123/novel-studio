# 一键成书 · P1/P2 审查修复记录（2026-10-25）

对应审查报告（`dsh-one-click-book.plan` 复核）中的 3 个高严重度 + 8 个中等问题。每条都给出
“改了什么 / 怎么证明改好了”。

## P1 高严重度

### P1-1 状态历史失真 → 已修

- **改因**：旧实现用 `STAGE_ORDER` 并集拼 `stage_history`，中途 job 会记上 `DRAFTING/QA/FULL_REVIEW/EXPORTING` 等未来阶段，且缺 `NORMALIZED`、`EXPORT_READY`。
- **改法**：`record()` 只追加真实发生的阶段；补记 `NORMALIZED`、`EXEMPLAR_REVIEW`（成功路径）、`EXPORT_READY`；观测类记录（出口摘要）走 `recordEvidence()`，不进阶段历史。
- **证据**：`scripts/test-one-click-book.mjs` AC-03 断言中途历史恰为 `RECEIVED→PREFLIGHT→INGESTING→NORMALIZED→OUTLINED→EXEMPLAR_REVIEW`，且不含任何未来阶段；AC-04 断言完成态历史恰为 12 个阶段。

### P1-2 凭据可经来源进正文并导出 → 已修

- **改因**：来源只按扩展名放行；`forbidden_paths` 未实现；扫描只有 4 条规则（`API_TOKEN=…` 零命中）；扫描在导出前才做，正文草稿已落盘；导出审批只是布尔。
- **改法**：
  1. 来源路径策略：dotfile、`secrets/`、`credentials/`、`.env*`、文件名含 secret/credential/password/token 一律 `FORBIDDEN_SOURCE_PATH`；
  2. 大小上限（单文件 8MB / 总量 32MB）与 UTF-8 严格解码（`SOURCE_TOO_LARGE` / `SOURCE_TOTAL_TOO_LARGE` / `SOURCE_NOT_UTF8`）；
  3. 扫描规则扩展到 `token-assignment` 与高熵串（≥32 字符、三类字符）；
  4. **扫描前移到 ingest**，命中即 `BLOCKED(CREDENTIAL_IN_SOURCE)`，此时 `chapters/` 尚未创建；
  5. 导出改两段式：先写候选稿并记录 `pending_export_hash`，审批必须携带该 hash，改稿即 `APPROVAL_HASH_MISMATCH`。
- **证据**：AC-01c（禁止路径）、AC-01d（超大/非 UTF-8）、AC-12b（凭据来源阻断且无 chapters）、AC-12（hash 绑定放行）、AC-12c（改稿后旧审批失效）；HTTP 实测无 hash→400、错 hash→409、对 hash→COMPLETED。

### P1-3 验收函数未接线 → 已修

- **改因**：`completionVerdict`/`assertCommitted`/`validateContract`/`impactGraph` 只被测试与验收表引用，生产路径从未调用。
- **改法**：
  - `COMPLETED` 前调用 `completionVerdict`（证据引用 + 门禁 + 证据链），失败 `BLOCKED(COMPLETION_EVIDENCE_MISSING)`；
  - 导出前调用 `assertCommitted`；
  - 任务契约/章节契约/交付清单生成即 `validateContract`，失败 `BLOCKED(CONTRACT_INVALID)`；
  - 影响图落到 `POST /chapters/:id/edit`：保留旧版本、写影响图、退回 `FULL_REVIEW` 并作废旧审批。
- **证据**：AC-14/19（生产源码必须出现这两个调用 + 完成态存在 evidence/completion）、AC-17（编辑后 `versions/002-<hash>.md`、下游 003/004、审批复位）、HTTP 实测编辑返回 graph 与 rollback 路径。

## P2 中等问题

| 编号 | 问题 | 修法 | 证据 |
| --- | --- | --- | --- |
| P2-1 | 账本无增量（只有 2 行） | 每章追加术语/时间线/事实事件（幂等去重），全书复审新增 `reviewLedgers`（伏笔未回收、时间线倒挂、术语漂移、空账本章节） | AC-04：术语/时间线行数 = 章节数；`review/full-book-report.json` 含 ledger 段 |
| P2-2 | 交付物路径不全 | 生成 `README.md`、`过程记录.md`、`contract/task-contract.json`、`contract/book-requirements.json`、`.dsh/checkpoints/*.json`、`.dsh/evidence/run.json` | AC-04 路径存在性断言（12 个路径 + checkpoint ≥5） |
| P2-3 | 单活跃 job 堵死 | 输入未齐（WAITING_CONFIRMATION）或终态可换 key 重建；job 历史入 `index.json`；`GET /jobs` 可查 | AC-01c 连续两个 job 均正常创建；`jobStatus().jobs` |
| P2-4 | 无进度/重试/发布/编辑 | `status.progress{stage,done,total,blocked,next_action}`；`POST /retry`、`POST /publish`（默认 403）、`POST /chapters/:id/edit`；UI 增加进度行与重试/发布按钮 | AC-20（retry 后 attempts≥1）、P2-4 断言、HTTP 实测 |
| P2-5 | 预算/时长未执行 | PREFLIGHT 校验 `budget_cny ∈ [0,2]`（对应 max_cost_cents=200），越界 `BUDGET_EXCEEDED` | AC-01e |
| P2-6 | 大文件/编码未覆盖 | 见 P1-2 第 2 条 | AC-01d |
| P2-7 | AC-13/19 断言偏弱 | AC-19 改为生产接线断言（源码调用 + 完成态证据）；AC-13 增加“HTTP 层无插件端点”断言，并注明 DPIP 由宿主插件负责 | AC-13、AC-14/19 |
| P2-8 | 恢复测试非真重启 | 用三个真实子进程跑 CLI：停在 FULL_REVIEW → 续跑到 EXPORT_READY → 两段导出完成；另测取消 | `reports/recovery-test.json`（process_1/2/3 + cancelled），AC-09 子进程测试 |

## 本次全门禁结果

```
node scripts/test-one-click-book.mjs      → passed=31 failed=0
node scripts/one-click-book-mutation.mjs  → killed=10/10 score=1.0
node scripts/one-click-book-finalize.mjs  → ok=true gates=true ledger=true recovery=true
node .p1-baseline/verify-phase-map.mjs    → ✓ 阶段映射核对通过
node .p1-baseline/check-utf8.mjs          → 7083 文件，非法 UTF-8 0
node scripts/ci-offline-checks.mjs        → 通过 78 / 未通过 0
```

## 仍然保留的诚实边界

- 第三方时间戳（RFC3161/OpenTimestamps）仍为 `UNSUPPORTED`：需要出站与授权。
- 发布通道只有拒绝路径（`PUBLISH_DISABLED` / `PUBLISH_UNSUPPORTED`），因为本机没有发布适配器。
- docx/pdf/epub 仍标 `UNSUPPORTED`，不生成空文件。
