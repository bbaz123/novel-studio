# 2026-10-23 本轮审稿—修稿—终验：核验记录与增量修复

> 输入：作者本轮提供的【审稿前】【审稿报告】【修稿后】片段（`Novel Studio_本轮审稿回归片段_2026-10-23.json`）
> 与诊断方案（`Novel Studio 审稿修稿问题诊断与完整解决方案_2026-10-23.md`）。
> 性质：**本轮实际执行记录**；只写跑过、读过的证据，未做的项一律列在 §6。
> 计费：全部离线断言与活库只读查询，**0 次付费模型调用**。

## 1. 冻结与备份（S0）

| 项 | 值 |
|---|---|
| 工作区 | `Experimental-Version-v1.0` @ `9a145dbfe8a67fee74fe66dca4cd38d1989630ce`（v1.2.7 提交） |
| `package.json` | 1.2.6（上一提交未改版本号） |
| Node | v24.19.0 |
| 活库 | `data/novel.db`（WAL 模式；备份前无 `-wal/-shm` 残留） |
| 备份 | `data/backup-review-round-2026-10-23T12-28-09/novel.db`（`VACUUM INTO` 在线快照） |
| 备份 SHA-256 | `dbea7fb2552be6c95234ed1c9d85d8201527d4b290188e6d47a6a6e811f45af0` |
| 备份校验 | 打开备份库 `PRAGMA integrity_check = ok`；chapters=56、chapter119=5061 字 |
| 本轮真实全文 | `data/review-round-20261023/{before,after}.txt`（gitignored）<br>before sha256 `ea618411da2b7164d33c4c0e90f83bdb8fe104dc6a6a6feff25f04b9920df81f`（4771 字）<br>after sha256 `127dd700a40a339d8adde8d200d959f26a0995aedbb5c14c637cd2e5463ebace`（5061 字） |
| 审稿报告 | 活库 `chapter_reviews#32`（2026-10-23T11:12Z）：9 findings、`shape_defect_count=9`、`counts={hypothesis:9,auto_eligible:0}`、`base_hash=""` |

**未做**：全库"停服务 → 恢复演练 → 章 hash 比对"（见 §6）。本轮只做了在线快照 + integrity_check + 章节字数/计数核对。

## 2. 活库核验：诊断方案里哪些是真的、哪些本机已有

| 诊断项 | 本机核验结果 | 证据 |
|---|---|---|
| E-01「9 条缺字段」 | **真实存在**：9 条 finding 全缺 `kind/suggested_action/reading_cost` → 全部降级 `hypothesis`、`auto_eligible=0`、报告里逐条标「⚠️字段不全，保留证据但仅作待核验」。缺字段的 fail-closed **已在工作**（证据保留、不自动采纳、不冒充 confirmed）。 | `chapter_reviews#32.report_json`；`narrative-review.mjs` 的 `normalizeNarrativeFindings` |
| 清单翻倍（9+9） | **已在 v1.2.7 修**：`structureReviewReport` 用逐字前缀或 2-gram 覆盖率去重；本轮 9 条问题场景回放得到 9 个 canonical ID、0 条无 ID 伪项。 | 本套件 A20 |
| P0 合并覆盖 | **已在 v1.2.7 修**：`/novel/adopt` 事务内比对基线、`REVISION_BASE_STALE`、`REVISION_VERIFICATION_STALE`、明确覆盖双确认。 | `docs/CHANGELOG.md` v1.2.7 条目；`frontend-test.mjs` MG-01…MG-10 全 PASS |
| P1-C 独立复核误报 | **已有相关性层**：`ai/quality-auditor/relevance.mjs`（RELEVANT / ADVISORY / INVALID_RELEVANCE）。 | 代码与既有 `test-relevance` 套件 |
| 误判 A/B「无关反例」 | **真实存在且已修**：活库报告的两条「优点需加限定」都只因一个字面「一直」成立（详见 §3.1）。 | §3.1 前后对照 |

## 3. 本轮增量修复（三处判据 + 断言）

### 3.1 审稿报告自洽性：反例必须"在谈同一件事"（P1-B）

- **现场**：`chapter_reviews#32.consistency.strength_qualifications` 两条：
  1. 优点「检测石…没有一句心理总结」← 反例「他左前方一个中年男人一直在打电话…」（`family=psychology`）；
  2. 优点「母亲那三句…没有多余的余韵段」← 反例「…从正门一直拖到马路牙子。」（`family=explanation`）。
- **根因**（两处，均可逐字复现）：
  - `EXPLANATION_RE` 把 `一直/从小就` 当成"解释性连接词"，于是任何持续动作句都能当"解释性反例"；
  - 优点族判定是**全文子串**匹配：长句里的「互不解释」「心理总结」都算数，不要求否定词直接修饰那一类；
  - 心理句探针 `他…一直` 会把台词/动作（`他头也没抬：“知道了！”`）当成心理描写。
- **修法**（`ai/editing/narrative-review.mjs`）：
  - 解释性只认因果/说明连接词（`所以/因为/于是/这才/原来/说明/意味着/其实/归根到底/毕竟`）；
  - 心理句必须带心理动词（`觉得/明白/知道/记得/意识到/回想起/心想/认为/想着`），且**去掉引号里的台词**；
  - 优点族改为"否定词 + 8 字内 + 那一类"（`没有…心理/内心/独白`、`没有…解释/说明/交代`）；
  - `only_once` 反例必须与优点共享话题（`sharesTopic`，阈值沿用 2026-10-11 收紧版）；
  - 每条限定建议带 `support_relation=contradicts`；被筛掉的候选进 `suppressed_qualifications`（`irrelevant|unknown` + 理由），**不静默消失、也不计作结论**。
- **活库前后对照**（只读重算 `checkReportConsistency`）：

| | 修前 | 修后 |
|---|---|---|
| `strength_qualifications` | 2（两条均为无关反例） | **0** |
| `suppressed_qualifications` | — | 2（unknown：缺少可核对的同类反例） |
| 阳性对照（`林清雪…没有一句内心独白` + `他从小觉得…`） | 命中 | 仍命中，`support_relation=contradicts` |
| 阴性对照（`他头也没抬：“知道了！”`） | 命中（台词误判） | 不命中 |

界面接线：`reportConsistencyHtml` 只把 `contradicts`（或旧数据缺字段）渲染成「优点需加限定」；`suppressed` 单列「反例候选未确认关联（非结论）」。

### 3.2 终验：把「改错位置」变成独立维度（P1-A）

- `public/revision-semantic-verifier.js` 新增 `target_verdict`：
  `NO_EDIT`（没有本项补丁）/ `ON_TARGET`（补丁落在本项证据上）/ `WRONG_TARGET`（补丁全部落在证据之外）/ `UNPROVEN`（分段片内偏移等无法证明位置）。
- **不改状态机枚举**：`WRONG_TARGET ≈ final_status=UNRESOLVED + reason_code=UNRELATED_CHANGE + target_verdict=WRONG_TARGET`；
  `final_status` 保持 `ISSUE_VERIFIED/PARTIAL/UNRESOLVED/CANON_CONFLICT/AWAITING_SEMANTIC` 五个值，避免回执与既有 19 个套件漂移。
- 工作区：`public/review-workspace.js` 把该维度显示为「改错位置（未通过）」/「未改动 / 改在证据上 / 位置未证实」，不再混成泛化的"未通过"。

### 3.3 多子条件只做一半 ⇒ PARTIAL（P0-C/P1-A）

- 旧行为：任一**硬**子条件失败 → `FAIL`，于是 R-0001「只删流程总结、人生总结还在」与"一个字没改"同档。
- 新行为：当**硬失败只来自声明的子条件**、且至少一个子条件 PASS、且确有真实改动（`actual_change=true`）→ `PARTIAL`，未通过子条件进 `unresolved_conditions`；
  锚点仍在 / 保留项丢失 / 越权 / 底稿变化这类字面事实**仍是 FAIL**（R-0005 只删短信即属此档）。

### 3.4 审稿底本指纹落库（作者选定 C 项）

- **现场**：`chapter_reviews#32` 的 `base_hash` 为**空字符串**。报告里存了被审 `base_text`（4771 字），
  但没有任何指纹把它和"后来的修稿快照"绑定。只读派生结果：
  `fnv1a:a0cd1c56:4771`，
  `base_sha256=sha256:ea618411da2b7164d33c4c0e90f83bdb8fe104dc6a6a6feff25f04b9920df81f`
  ——与 §1 导出的 `before.txt` 逐字一致，说明"底本"确实是作者被审的那一篇。
- **口径**：`base_hash` 用 **fnv1a32+len**（`fnv1a:<hex>:<len>`），与前端
  `revision-patch.textFingerprint()`、`revision-finalize` 的 `contentHash()` 回退、以及修稿计划
  `snapshot.body_hash` **同算法同格式**，因此两边可以直接比对；另存 `base_sha256` 作强摘要归档。
- **实现**：
  - 新模块 `ai/editing/review-hash.mjs`（服务端唯一实现）：`fingerprint / sha256Hex / hashOfBaseText /
    resolveBaseHash / derivedBaseHash`；空底本不生成"空字符串哈希"（`state=missing`）。
  - `PUT /novel/review`：保存时以 **`quoteBase.text`（被审底本，不是当前章节）** 计算；
    调用方显式给了 `base_hash` 就保留，但与底本算出来的不一致时写 `base_hash_mismatch=true`
    （不静默二选一）；`base_hash_alg/base_sha256/base_hash_source/quote_base_source` 一起落库。
  - 回执（201）带 `base_hash/base_hash_alg/base_sha256/base_hash_source/base_hash_mismatch`。
  - `GET /novel/review`：老报告没存 hash 时**只在回包里派生**（`base_hash_state=derived`），
    **不重写历史行**；三态为 `stored / derived / missing`。
  - `structureReviewReport` 的**每条返回路径**（旧口径、findings 不可解析、review_v2）都透传 `base_hash/source`。
- **验证**：A30（与前端 `textFingerprint` 逐字相同）、A31（sha256 已知向量）、A32（缺省计算/给值不符留痕）、
  A33（空底本不冒充）、A34（两条返回路径都带）、A35（读路径三态）、A36（server 静态接线守卫）。
- **仍未验证**：HTTP 层真跑（保存 → 回读 → 落库字段）受沙箱 `spawn EPERM` 限制，见 §6；
  因此本轮只声称"纯函数与接线守卫通过"，不声称"接口已验证"。

## 4. 本轮夹具与断言（可重复执行）

- 夹具：`tests/narrative-repair/fixtures/review-20261023/`
  `before.txt` / `after.txt` / `review-report.json` / `manifest.json`（三个文件的 SHA-256 已写入 manifest；片段夹具，不冒充全文）。
- 套件：`tests/narrative-repair/20-review-round-20261023.test.mjs`（A01–A37，零计费）。
- 已接入：`scripts/test-narrative-repair.mjs`（第 20 套件）与 `scripts/ci-offline-checks.mjs`（独立一条，便于失败归因）。

本轮 9 条回放结果（**软件判定**，与作者观察一致）：

| ID | 本轮回放结论 | 关键理由 |
|---|---|---|
| R-0001 | UNRESOLVED | 两句核心目标原封未动（语义说 PASS 也不覆盖） |
| R-0002 | PARTIAL | 删了「太阳升高了一截」，但「队伍往前挪」「他看了一上午」仍在 |
| R-0003 | UNRESOLVED + `target_verdict=WRONG_TARGET` | 删的是「羡慕」，马尾两处「青绿」未动 → `UNRELATED_CHANGE` |
| R-0004 | UNRESOLVED | 原句未改 |
| R-0005 | UNRESOLVED | 评定单原句仍在（窗口/单据/短信三处只改旁处） |
| R-0006 | ISSUE_VERIFIED | 指代唯一、语义复核通过（只有这一条 PASS） |
| R-0007 | UNRESOLVED | 旧回指未动，本轮记为 `NO_EDIT` |
| R-0008 | CANON_CONFLICT | 蓝图/作者授权边界；不生成正文补丁 |
| R-0009 | UNRESOLVED | 完整颜色表仍在，模型谎称 PASS 也被字面事实覆盖 |

## 5. 执行过的验证（真实命令与结果）

| 命令 | 结果 | 说明 |
|---|---|---|
| `node tests/narrative-repair/20-review-round-20261023.test.mjs` | 37/37 | 本轮新套件（A01–A37，含底本指纹 A30–A37） |
| `node scripts/test-narrative-repair.mjs` | 20/20 套件 | 含既有 19 套（240+ 条）全绿 |
| `node frontend-test.mjs` | ALL PASS | 含 V118-09u（限定建议仍渲染）与 MG-01…MG-10 |
| `node .p1-baseline/test-1019-semantic.mjs` | 19/19 | Y-01b 断言同步收紧为"原因码 ∈ {ANCHOR_NOT_EDITED, UNRELATED_CHANGE} 且 target_verdict=WRONG_TARGET" |
| `node .p1-baseline/test-1025-finalize.mjs` | 52/52 | 统一终验出口/工作区 |
| `node .p1-baseline/test-1029-i03-i04-closure.mjs` | 28/28 | 修稿闭环矩阵 |
| `node .p1-baseline/check-utf8.mjs` | 7002 文件 / 0 非法 | 编码门禁 |
| `node scripts/ci-offline-checks.mjs` | 51 通过 / 27 未通过（共 78） | 见下 |

**关于 27 条未通过**：与**本轮修改前的基线完全相同**（基线 50/77，仅多出本轮 1 条新套件通过）。它们全部是既有失败，主要是本机沙箱禁止 `child_process` 管道（`spawnSync git EPERM` / `spawn` 报错），需要拉起隔离 HTTP 实例或 `git` 子进程的套件因此拿不到被测服务；这与 2026-10 中旬记录的沙箱限制一致，不是本轮代码回归。真正断言型失败（`回滚矩阵工具自检`、`全量快照工具离线测试`、`v1.2.1 R-01–R-30`、`闸门断言离线阴性对照`）在本轮改动前即为红，本轮未修。

**未能运行**：`.p1-baseline/verify-phase-map.mjs`（内部 `spawnSync git` 被沙箱拒绝：`EPERM`）。归属按清单人工核对：本轮改动文件分别由 SE6（`ai/editing/narrative-review.mjs`、`public/revision-*.js`、`public/review-workspace.js`、`public/app.js`、`scripts/test-narrative-repair.mjs`、`scripts/ci-offline-checks.mjs`、`tests/narrative-repair/`、`docs/narrative-repair/`）、`.p1-baseline/test-1019-semantic.mjs` 所在阶段与 `docs/CHANGELOG.md` 既有阶段认领；新增文件只落在 `tests/narrative-repair/` 与 `docs/narrative-repair/` 两个已被 SE6 整目录认领的位置。

## 6. 明确未做（NOT_RUN）与原因

| 项 | 状态 | 原因/下一步 |
|---|---|---|
| 30 项回归矩阵中的 HTTP/DB/浏览器真跑（T01–T30 里依赖活实例的部分） | NOT_RUN | 沙箱 `spawn EPERM`；本轮改为**纯函数层**回放（A01–A37），不声称端到端已验 |
| DSH 独立审计真实联调（open/read/submit/status、主机校验、C 编号） | NOT_RUN | 需要活实例 + DSH 进程；本轮未调用任何付费模型 |
| 备份恢复演练（停服务 → 恢复 → 章 hash 比对） | NOT_RUN | 只做了在线快照与 integrity_check；恢复演练需短暂停写窗口 |
| `base_hash` 落库为空（review#32） | **已修（纯函数 + 接线层）** | 新报告由被审底本计算；老报告读时派生不重写。HTTP 层真跑仍 NOT_RUN（见上） |

## 7. 结论

- 本轮修的是**判据层**：把"无关反例""改错位置""多条件只做一半""审稿底本是哪一版"从"看起来像"变成可复核的机器结论，并用 37 条断言钉住。
- 诊断方案里 P0 的合并保护、清单去重、审计相关性、缺字段 fail-closed 在**本机已存在**（v1.2.7 及之前），本轮没有重复造第二套。
- 仍未闭环的是**端到端**部分（DSH 联调、HTTP/DB/浏览器矩阵、恢复演练）。底本指纹已实现到服务端保存/回读代码与纯函数断言，
  但 HTTP 真跑仍属 NOT_RUN；需要活实例与停写窗口，不能凭纯函数测试声称已完成。
