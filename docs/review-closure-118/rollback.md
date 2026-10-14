# v118 0317 专项 · 回滚方案（rollback）

> 用户对本轮的硬约束：**不得 `reset` / `clean` / `stash` / `commit` / `push`**。
> 因此本文件给的是"逐文件、可核验"的回滚配方，而不是"跑一条 git 命令了事"。
> 本 Agent **没有执行**任何回滚命令（工作树保持本轮改动后的状态）。

## 1. 先分清三类东西

| 类 | 内容 | 回滚方式 |
|---|---|---|
| **A. 本批新增物** | `tests/narrative-repair/17-review-closure-0317.test.mjs`、`docs/review-closure-118/`、`scripts/rollback-v118.mjs` | 可直接删除（撤掉后旧套件照常跑） |
| **B. 共用源文件（判据层）** | `public/patch-safety.js`、`public/revision-patch.js`、`ai/editing/narrative-review.mjs`、`ai/editing/narrative-scan.mjs` | 按**整批**回滚（改动与 SE/SE4/SE5/SE6 交织，单独撤会留下半套判据） |
| **C. 入口与映射** | `scripts/test-narrative-repair.mjs`（套件清单一行）、`.p1-baseline/verify-phase-map.mjs`（`SE8` 条目） | 与 B 一起回滚；单独撤会让新套件失去入口或因缺文件而红 |

## 2. 逐文件回滚（确切命令）

**第 1 步：确认本批可被逐字识别（先验证，再动手）**

```
node scripts/rollback-v118.mjs --verify
```

本轮的实测结果（exit 0）：

```
✓ 全部标记唯一命中：本批可被逐字识别，回滚配方可用
```

它逐个断言本批在 B/C 类文件里留下的 **23 个标记各出现恰好 1 次**（0 次或多次 → 非零退出、不动手），
并打印每个文件的 `after_sha256`：

| 文件 | after_sha256 | after_lines |
|---|---|---|
| `public/patch-safety.js` | `8fa4514e8a09751cac25d0b960577f7fdbd1e954472085c6b789afc130706110` | 1388 |
| `public/revision-patch.js` | `91d97725286a4f684ece0409ea984731da167a2b82a7e4c654b1504e1c24bd11` | 1905 |
| `ai/editing/narrative-review.mjs` | `2b6febd57a257f6f65749a80b678d2fbfb1d946ff825b7bed39549bdd4fc928d` | 528 |
| `ai/editing/narrative-scan.mjs` | `9ae4094c3a39cca01b9a41e8b5beffc8a97aeaf4e9a1b26c0faf2a3b3c5681dd` | 522 |
| `scripts/test-narrative-repair.mjs` | `6889b97dde18d0599405531e0d47aab3268a8ce2eb977d0eca3226159c210299` | 138 |
| `.p1-baseline/verify-phase-map.mjs` | `3cc299b633eeaa5dbd558ced9ebd408d9dc063477fcf4f494f262645a8ee3915` | 1664 |

**第 2 步：回滚 B/C 类（在用户自己的终端）**

```
git restore -- public/patch-safety.js public/revision-patch.js \
  ai/editing/narrative-review.mjs ai/editing/narrative-scan.mjs \
  scripts/test-narrative-repair.mjs .p1-baseline/verify-phase-map.mjs
```

> 选 `git restore` 而不是 `checkout`：它只动工作树里列出的这几个路径，不带分支/索引副作用。
> 若本批已被提交过，改用 `git revert <commit>`（**不要** `reset --hard`）。

**第 3 步：删除 A 类新增物**

```
rm tests/narrative-repair/17-review-closure-0317.test.mjs
rm scripts/rollback-v118.mjs
rm -rf docs/review-closure-118/
```

**第 4 步：回滚后核验（必须做）**

```
node scripts/test-narrative-repair.mjs     # 期望：16 套件 / 0 未通过（少了 17 号）
node frontend-test.mjs                     # 期望：ALL PASS
node .p1-baseline/check-utf8.mjs           # 期望：非法 0
```

## 3. 为什么不能"自动执行字节级回滚"（本轮的真实边界）

1. 本沙箱**禁止子进程**，`node .p1-baseline/verify-phase-map.mjs` 里的 `spawnSync git` 直接 `EPERM`；
2. 用户明确禁止 `reset/clean/stash/commit/push`，而 `git restore` 同样会改写工作树，
   所以**我这一侧不执行**，只提供配方；
3. 因此本目录**不提供** B 类文件的 `before_sha256`——**没有真实取到，就不写**。
   替代证据是"批次标记唯一命中"（证明本批可被逐字识别，回滚不会误伤既有代码）。

## 4. 更细粒度回滚（只撤某一处判据）

如果你只想撤掉八处判据中的一处，按"问题 → 落点"删对应函数与其接入点即可，
但**必须同时**删掉 `classifyEditScope` / `structureReviewReport` / `issueCoverageCandidates`
里的接入行，否则会留下死代码；删除后跑 `node tests/narrative-repair/17-review-closure-0317.test.mjs`
应当在该条上变红（正是"撤掉了判据"的证据）。

| 想撤掉 | 删什么 | 接入点 |
|---|---|---|
| 新制度流程候选 | `WORKFLOW_PATTERNS` / `WORKFLOW_LINK` / `workflowRuleCandidates()` | `classifyEditScope` 里那行 `for (const wf of workflowRuleCandidates(...))` |
| 时间因果桥 | `TIME_ADVANCE` / `EVENT_CLOSES` / `assessTemporalBridge()` | `classifyEditScope` 里 `if (!opts.authorApprovedTimeAnchors) { ... }` 整块 |
| 引文归属 | `QUOTED_SPAN_RE` / `QUOTE_EDGE_PUNCT` / `auditReviewQuotes()` | `withConsistency` 里的 `quote_audit` / `strength_audit` |
| 好评限定 | `ABSENT_FAMILIES` / `ABSOLUTE_LIMIT` / `qualifications` | `checkReportConsistency` 的返回值 `strength_qualifications` |
| 同物件状态桥 | `PROP_STATE_VERBS` / `PROP_RESET_VERBS` / `propStateCandidates()` | 导出块 |
| 未选中处置 | `selectionOf()` / `unaccounted` | `issueCoverageCandidates` 里那段 `if (selected === false || !c || ...)` |
| 修后结论闸 | `coverageVerdict()` | 导出块（当前无生产调用方） |
| 伏笔锚可见性 | `anchorStatus()` | 导出块 |
| 因果稀有度通道 | `COMMON_RARITY` / `GRADE_RESULT_RE` / `opts.gradeRarity` 分支 | `reactionCausalityCandidates(raw, opts)` 调用点（改回 `reactionCausalityCandidates(raw)`） |

## 5. 未包含在本回滚方案里的东西（明确不撤）

- `docs/narrative-repair/`、`docs/narrative-repair-116/`、`.narrative-repair-116/`：**历史实验，不覆盖、不删除**。
- 任何真实章节、真实 SQLite、`data/`、用户密钥：本批从未触碰，无需回滚。
- 基线数据目录（`.p1-baseline/baselines*`）：从未改写，无需回滚。
