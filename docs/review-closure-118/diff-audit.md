# v118 0317 专项 · 差异审计（diff-audit）

> 目的：《0317 增补》§8 要求"每一补丁的原 issue ID、原文 hash、授权 span/op、diff、处置与原始理由"
> 都能逐步复核。本文件按**逐条**列，并把"**没有**做的事"同样写清楚——不把"没改"说成"改好了"。

## 0. 审计口径（先写清楚，后面才好读）

- 本轮**没有**产生任何真实章节补丁：作者没有在这台机器上重放 0317 那次审稿任务，
  缺少原始 model output 与真实勾选记录（`missing_execution_evidence`）。
  因此本文件审计的是**机制改动**，不是"某一章被改了哪几句"。
- 方案 §1 的 5 组 diff（字符净变化 −61）是**用户提供的样本事实**，来源标 `SOURCE`；
  正文是否真的按这 5 组落地，本轮**看不到**，故不声称已验证。
- 真实章节内容、真实 SQLite、用户密钥：**零触碰**（本批只改判据与测试）。

## 1. 逐条审计表（R01–R07）

| 原 issue | 本轮样本的实际 diff（SOURCE） | 机制侧是否补上 | 处置 | 依据 |
|---|---|---|---|---|
| **R01** 中午测完却天黑才出门 | 在"走出大门天色暗"前**新增**"下午的号按学校分批往下叫，他在外场又耽搁了一阵" | ✅ `new_workflow_rule` + `temporal_causal_bridge` | `partially_resolved` / `needs_author_choice` | 新增句是**无来源的制度事实**，且没有把"为什么两人测完却没走"补上；判据现在会拦在 `story_fact`，不再静默自动应用 |
| **R02** 三句安慰同义重复 | 仅删"没有谁特意冲他说，也没有谁刻意避开他" | ✅ `issueCoverageCandidates` 保持 `partially_resolved` | `partially_resolved` | 三条安慰原话仍在正文里；逐字证据未消失 → 候选照报，且 `coverageVerdict` 在语义未跑时**不给 resolved** |
| **R03** S/D 两次安静的解说 | 删掉"跟看S级落雪时那种安静不一样……"至"也笑不出来" | ⬜ 无需新增判据 | `locally_resolved`（仅文本层） | 保留"外场安静了"是正确方向（不替读者翻译情绪）；但**语义层未跑**，不升级为 resolved |
| **R04** S级场面六拍反应 | **没有变更** | ⬜ 无需新增判据 | `not_touched` | 是否勾选未知；**不因无变化断言失败**（见 V118-11：未选中既不算已改也不算失败） |
| **R05** 散场布景冗余 | **没有变更** | ⬜ 无需新增判据 | `not_touched` | 作者可能刻意保留；不按文字数量强制删 |
| **R06** 开篇站位重复 | 只删"又停下来" | ⬜ 无需新增判据 | `partially_resolved` | 开头仍有"不往前挤"与"这个位置有个好处"的解释叠加 |
| **R07** 台子距离感 | 只删"检测台离他大概二十米" | ✅ `issueCoverageCandidates` 证据清单化 | `partially_resolved` | "再挪两步就能看见检测台"与"几十个人遮挡"仍在（实测 `still_present>=1`） |

## 2. 本批代码 diff（按问题 → 补丁 → 断言）

> `before_sha256` 见 `test-report.md` §5 的说明：本沙箱无 git，**不提供**字节级 before-hash；
> `after_sha256` 为实测值，`after_lines` 为实测行数。

| 文件 | after_sha256（前 12 位） | after_lines | 涉及函数 | 对应断言 |
|---|---|---|---|---|
| `public/patch-safety.js` | `8fa4514e8a09` | 1388 | `workflowRuleCandidates`、`assessTemporalBridge`、`propStateCandidates`、`anchorStatus`、`classifyEditScope` | V118-01/02/03/10/13/14 |
| `public/revision-patch.js` | `91d97725286a` | 1905 | `selectionOf`、`issueCoverageCandidates`、`coverageVerdict` | V118-04/05/11/12 |
| `ai/editing/narrative-review.mjs` | `2b6febd57a25` | 528 | `auditReviewQuotes`、`checkReportConsistency`（`strength_qualifications`）、`structureReviewReport`（`withConsistency`） | V118-06/07/08/09 |
| `ai/editing/narrative-scan.mjs` | `9ae4094c3a39` | 522 | `UNIVERSAL_HEAD`、`COMMON_RARITY`、`reactionCausalityCandidates` | V118-15 |
| `scripts/test-narrative-repair.mjs` | `6889b97dde18` | 138 | 套件清单 | 全部 |
| `scripts/rollback-v118.mjs` | `7dfc6b270c9f` | 113 | 批次标记唯一性核验 + git 回滚配方 | 回滚可用性 |
| `tests/narrative-repair/17-review-closure-0317.test.mjs` | `5cb119c47de9` | 342 | 39 条 `check` | V118-01～15 |
| `.p1-baseline/verify-phase-map.mjs` | `3cc299b633ee` | 1664 | `PHASES` 新增 `SE8` 条目 | 归属（见 test-report §4） |

## 3. 授权与 ops（本地机器上发生了什么）

| 动作 | 是否发生 | 说明 |
|---|---|---|
| 自动应用机器补丁到真实章节 | ❌ 未发生 | 本批只改判据与测试；没有真实章节文本进入任何写路径 |
| `insert` / `delete` / `replace` op 授权变更 | ❌ 未发生 | 未改协议 schema（沿用 v1.1.8 的 `ops` / `allowed_ops` / 零宽 `insert`） |
| 修改真实 SQLite | ❌ 未发生 | 未连库、未迁移、未写行 |
| 修改用户密钥 / `data/` | ❌ 未发生 | 未读、未写 |
| 触发付费模型 | ❌ 未发生 | 全部检查零计费；无 LLM 调用 |
| `reset` / `clean` / `stash` / `commit` / `push` | ❌ 未发生 | 一条都没执行 |
| UI 保存 / 作者手工编辑 / 整章重写授权 | ⬜ 未触碰 | 新判据只在**机器局部补丁**通道生效；见 `implementation-report.md` §4 |

## 4. 差异审计结论

- 本批**没有**制造"看起来改好了"的假象：凡确定性层不能证明的（语义是否真的解决），
  一律写成 `partially_resolved` / `needs_review` / `not_run`。
- 本批**新增的是"拦"，不是"改"**：`new_workflow_rule` 与 `temporal_causal_bridge` 都落到
  `story_fact`（禁止自动应用、只输出建议），所以它最多让作者多看到一条待确认项，
  不可能替作者改故事。
- 唯一一处**行为收紧**（可能影响既有使用）是 `issueCoverageCandidates` 现在会返回
  `unaccounted`（此前对"无覆盖记录"的 issue 直接跳过）。这是有意为之且是本轮要求（V118-11），
  调用方必须把 `unaccounted` 渲染成"未选中/未处置"，**不得**渲染成"已改"或"修改失败"。
