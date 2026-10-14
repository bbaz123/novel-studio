# v118 0317 专项 · 源码映射（source-map）

> 本文件回答一件事：**这次改动落在哪些真实源码上、对应哪一条要求、能不能被独立识别与回滚。**
> 仓库若已有同类目录，本目录是**追加**（不覆盖 `docs/narrative-repair-116/`、`docs/narrative-repair/`）。

## 1. 本轮真实基线

| 项 | 值 | 取证方式 |
|---|---|---|
| 分支 | `Experimental-Version-v1.0` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `18cf102b8f00b1a8fd8281d85c4706de78631769` | `git rev-parse HEAD` |
| 版本 | `1.1.8` | `package.json` |
| Node | `v24.19.0` | `node -v` |
| 已跟踪文件改动（改动前） | 0 | `git status --porcelain` |
| 未跟踪文件（改动前） | 20（历史方案 `.md`） | 同上 |

**LOCAL_VERIFIED 的范围**：上述四行是本地实测值，可标 `LOCAL_VERIFIED`。
**不标 LOCAL_VERIFIED 的部分**：真实章节内容、真实 ReviewV2 记录、真实勾选与原始 model output、
字节级 before-hash（本沙箱 git 不可用）——这些一律 `LOCAL_NOT_VERIFIED` 或 `missing_execution_evidence`。

## 2. 判据源映射（问题 → 落点 → 断言）

| 方案条款 | 落点（文件 / 函数） | 断言 |
|---|---|---|
| §2 P0 新缺口：`new_workflow_rule` | `public/patch-safety.js` → `workflowRuleCandidates()`、`classifyEditScope()` | V118-01-a/b/c/d、V118-02-a/b、V118-14-a/b |
| §2 P0 时间因果桥 | `public/patch-safety.js` → `assessTemporalBridge()`、`classifyEditScope()` | V118-03-a/b/c |
| §3 P0 审稿报告不得虚构"原话" | `ai/editing/narrative-review.mjs` → `auditReviewQuotes()`、`structureReviewReport()` 的 `withConsistency` | V118-06、V118-07、V118-08、V118-08-b |
| §4 P0 修后"旧引文消失"≠"问题解决" | `public/revision-patch.js` → `coverageVerdict()`、`issueCoverageCandidates()` | V118-04-a/b/c、V118-05-a/b、V118-12-a/b/c |
| §5 P1 审稿好评自洽（绝对局限措辞） | `ai/editing/narrative-review.mjs` → `checkReportConsistency()` 的 `strength_qualifications` | V118-09-a/b/c |
| §6 P1 王磊手机状态桥 | `public/patch-safety.js` → `propStateCandidates()` | V118-10-a/b/c/d |
| §6 P1 未选中问题不得假称已改 | `public/revision-patch.js` → `selectionOf()`、`issueCoverageCandidates()` 的 `unaccounted` | V118-11-a/b/c |
| §6 P1 伏笔 `0731` 锚可见性 | `public/patch-safety.js` → `anchorStatus()` | V118-13-a/b/c |
| §6 P1 D 级群众反应因果 | `ai/editing/narrative-scan.mjs` → `UNIVERSAL_HEAD`、`COMMON_RARITY`、`reactionCausalityCandidates()` | V118-15-a/b/c |

## 3. 现场级事实：`reaction_causality` 为什么此前"完全不响"

`ai/editing/narrative-scan.mjs` 早已注册 `reaction_causality` 诊断（116 轮新增），
但本轮样本的真句是「**外场**安静了」——旧 `UNIVERSAL_HEAD` 只认
`全场/全都/所有/大厅/整个大厅/一片/候检大厅`，**不含"外场"**，于是整句在第一步就被丢弃：
成因匹配（`ORDINARY_CAUSE`）再怎么准也不会被触发。

这是本项目反复出现的同一类根因：**判据词表写窄了一点点，整条判据静默失效**，
而失败姿态是"零候选"——看起来像"没有问题"，不是像"报错了"。

## 4. 与既有实现的边界（哪些没动、为什么不重复造）

| 既有机制 | 本批是否重做 | 说明 |
|---|---|---|
| `story_fact` 保护（`gatePatches` → HARD_CODES） | ❌ 不重做 | 只在其 `signals` 里**增加**两条窄候选，复用同一拦截路径与同一条理由文案 |
| `validateNarrativeFinding` 的 finding 引用核验 | ❌ 不重做 | findings 一直有核验；本批补的是 **summary/strengths/issues 里的行内引号**这一半 |
| `reaction_homogeneity` | ❌ 不重做 | 它是"反应是否同质"，与"反应是否与事件稀有度相称"是两件事（方案 §6 已明写） |
| `reason_unverified`（T33） | ❌ 不动 | 理由错配判据与"引文归属"是两个方向 |
| 协议 schema（v2 的 `ops`/`allowed_ops`/零宽 insert） | ❌ 不动 | 本轮无契约变更 |
| `scanFactLock` / `information_truncation` / `scene_bridge` | ❌ 不动 | 与 V118 的 15 条无交集 |

## 5. 改动清单（按可回滚单位）

**可独立撤回（本批自身的新增物）**

- `tests/narrative-repair/17-review-closure-0317.test.mjs`（新套件）
- `docs/review-closure-118/`（本目录）

**与更早阶段共用（必须按所选粒度整体回滚）**

- `public/patch-safety.js`（SE/SE4/SE6 共用）
- `public/revision-patch.js`（SE6/SE7 共用）
- `ai/editing/narrative-review.mjs`、`ai/editing/narrative-scan.mjs`（SE6 共用）
- `scripts/test-narrative-repair.mjs`（SE6/SE7 共用）
- `.p1-baseline/verify-phase-map.mjs`（阶段映射生成器，SE6 起各批都追加条目）

## 6. 阶段映射状态

- 本批以 **`SE8`** 条目登记在 `.p1-baseline/verify-phase-map.mjs`（`docs/review-closure-118/` 以目录前缀认领，
  `rollback: independent`，与 SE7 同口径）。
- 等价推导（用导出函数，CLI 的 git 依赖在沙箱内不可用）：
  `phases=36`、`present_count=14`、**`orphans=[]`**（本批 14 个文件改动全部有归属）、
  `SE8` 推导=声明=`independent`、认领 7 个文件、7 项证据齐备。
- ⚠️ **未完成**：`docs/phase-map.md` 没有重新生成（`--write` 同样需要 git）。
  同时，收窄改动集后 `computeRollback` 会让 16 个"未认领任何文件"的既有阶段出现
  `declared=shared / derived=independent` —— 见 `test-report.md` §4 的性质说明。

