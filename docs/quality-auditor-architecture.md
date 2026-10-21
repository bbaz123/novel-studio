# 质量审计子系统架构（dsh-novel-quality-auditor 阶段 2–3）

> 适用代码：本文件描述**当前**实现（2026-10-21）。函数名稳定，行号会漂。

## 1. 两层分工

```text
┌──────────────────── Novel Studio（事实与授权的唯一真源）─────────────────────┐
│ 正文 / 蓝图 / 角色卡 / world / 审稿报告 / 作者勾选 / 候选稿 / 版本 hash      │
│                                                                             │
│ ① 免费确定性检查（review-integrity / revision-integrity）                    │
│ ② 创建 quality_audit_run + 冻结输入 hash + 资源清单                          │
│ ③ 下发一次性 token → 启动 DSH 子进程                                         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ HTTP + x-audit-token
┌──────────────────────────────────▼──────────────────────────────────────────┐
│ DSH 0.2.0-rc.2 / novel profile                                              │
│ dsh-novel-quality-auditor                                                   │
│   novel_quality_open / read / submit / status                               │
│   盲审 → 冻结 → 对照 → 提交结构化结论                                        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ 结构化提交（schema/quote/hash/coverage 校验）
┌──────────────────────────────────▼──────────────────────────────────────────┐
│ Novel Studio 合并与闭环                                                      │
│ 审稿：初审 + 盲审新增 + 争议 + deferred → 合并报告                           │
│ 修稿：确定性验收 + 内部语义 + auditor 终验 → 失败项定向复修 → 全量重验       │
│ 写入：作者审批 + CAS                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

插件**不**直接改正文；它只能读写自己那次审计的数据。

## 2. 数据表（旁路表，回滚可整体删除）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `quality_audit_runs` | 一次审计运行 | 状态机、token hash、预算、租约、冻结 hash、manifest |
| `quality_audit_items` | 每条问题的审计结论 | `PRIMARY KEY(audit_id, issue_id, source)`；source ∈ initial/auditor/merged |
| `quality_audit_events` | append-only 事件流 | `UNIQUE(audit_id, seq)`；只存形状/长度/状态，不存全文 |

`runs` 额外保存 `blind_result_json` / `initial_report_json`：盲审与对照是两次独立提交，
只存最后一次会让"先盲后对照"的顺序无法证明。

## 3. 状态机

```text
CREATED → INPUT_FROZEN → DSH_STARTED → RUNNING
        → BLIND_SUBMITTED（仅 review）→ COMPARE_RUNNING（仅 review）
        → RESULT_RECEIVED → HOST_VERIFIED → MERGED → COMPLETED
```

失败分支：`FAILED_CONTRACT / FAILED_AUTH / FAILED_DSH / AUDIT_NOT_SUBMITTED / INTERRUPTED / CANCELLED / STALE`。

- 迁移表在 `contracts.ALLOWED_TRANSITIONS`，唯一写入口是 `store.transition`；
- `DSH_STARTED` / `INPUT_FROZEN` 都接受 blind/result 提交：真实 `start:true` 路径停在 `DSH_STARTED`，
  外部 runner 模式停在 `INPUT_FROZEN`（创建时 `start:false`）。两条路径都必须可提交，
  安全性不变（仍必须持有一次性 token），只是不强制服务器亲自 spawn；
- 重启时 `recoverInterruptedRuns()` 把"非终态 + 租约过期"的 run 标成 `INTERRUPTED`；
- **已完成（COMPLETED）的修稿审计**在被新候选取代后也会被标成 `STALE`：结论只对当时的 candidate hash 有效。

## 4. API

| 方法 | 路径 | 通道 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/novel/quality-audits?chapter_id=` | 作者 | 列表 + 最新一条 |
| POST | `/api/novel/quality-audits` | 作者 | 创建（`kind=review\|revision`），返回 token |
| GET | `/api/novel/quality-audits/:id` | 作者 | 状态 + 事件 + 条目 |
| POST | `/api/novel/quality-audits/:id/start` | 作者 | 拉起 DSH（需 token） |
| POST | `/api/novel/quality-audits/:id/cancel` | 作者 | 取消 |
| POST | `/api/novel/quality-audits/:id/verify` | 作者 | 主机校验 |
| POST | `/api/novel/quality-audits/:id/merge` | 作者 | 合并（review 会落一份新审稿） |
| GET | `/api/novel/quality-audits/:id/status` | DSH token | 只读自查（状态/缺失要求/上次错误） |
| GET | `/api/novel/quality-audits/:id/input-manifest` | DSH token | 资源清单 |
| GET | `/api/novel/quality-audits/:id/resources/:name?cursor=&limit=` | DSH token | 分页读取 |
| POST | `/api/novel/quality-audits/:id/submissions` | DSH token | `blind_draft` / `final` |

## 5. 校验与 fail-closed

| 检查 | 位置 | 失败结果 |
| --- | --- | --- |
| Host/Origin 非本机 | `security.checkAuditRequest` | 403 `AUDIT_FORBIDDEN_ORIGIN` |
| token 不存在/不匹配/过期/已结束 | `store.verifyToken` | 401 / 409 |
| blind 阶段读初审 | `coordinator.readResource` | 409 `AUDIT_PHASE_INVALID` |
| 引用不在正文 | `contracts/evidence` + coordinator | 422 `AUDIT_QUOTE_NOT_FOUND` |
| 扫描区间有空洞 | `snapshots.rangesCover` | 422 `AUDIT_COVERAGE_INCOMPLETE` |
| 初审未逐条对照 | coordinator.submitFinal | 422 `AUDIT_COVERAGE_INCOMPLETE` |
| candidate/base hash 不一致 | coordinator.submitFinal | 422 `AUDIT_STALE_CANDIDATE` / `AUDIT_HASH_MISMATCH` |
| 重复 final（不同摘要） | coordinator.submitFinal | 409 `AUDIT_RESULT_CONFLICT` |
| 提交体超上限 | `contracts.checkPayloadSize` / `readBody maxBytes` | 413 `AUDIT_PAYLOAD_TOO_LARGE` |
| 自然语言说完了但没提交 | `startAudit` 收尾 | `AUDIT_NOT_SUBMITTED`（不是完成） |

## 6. 安全边界

- 服务只监听回环；审计路由额外校验 Host/Origin（防 DNS rebinding）；
- token 32 字节随机，DB 只存 `sha256:` digest，比较用 `timingSafeEqual`；
- token 绑定 audit_id + work_id + chapter_id + kind（跨审计使用直接 401）；
- 资源正文只在内存里（`coordinator.RESOURCES`），账本只存清单与 hash；
- 提交体、finding 数、quote 长度、资源页长都有上限；
- 事件流不落正文，只落形状/长度/状态。

## 7. 预算

- 单次 ≤ ¥2、累计默认 ≤ ¥2；不拆单（同一 `idempotency_key` 复用同一 run）；
- 费用无法可靠计量时 `cost_known=false`：不阻断启动（否则未配置价格时功能不可用），
  但界面必须显示"估算不可用"，且不做自动重试；
- 未知价格**不虚构**数字（方案 §13 的硬要求）。

## 8. 断言

| 套件 | 覆盖 |
| --- | --- |
| `scripts/quality-auditor/test-contracts.mjs` | CT-01…CT-12（真实实例：三表/状态机/token/幂等/体积/取消/重启恢复/迁移幂等） |
| `.p1-baseline/test-host-contract.mjs` | 契约表清单包含三张新表 |
| `tests/nsdsh/regression-findings.test.mjs` | 迁移账本/事务化（D4 静态 + schema） |

全部零计费：CT 套件用 `start:false`（外部 runner），不拉起模型。
