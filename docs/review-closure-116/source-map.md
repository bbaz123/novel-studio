# source-map.md —— Novel Studio 1.1.6 本地核验与调用链（E00）

> 本轮任务书：仓库根目录 `修改方案.md`（《Novel Studio 1.1.6｜第二轮审稿与修稿专项修改方案》）。
> 目标：用户**本地 1.1.6** 的「生成—审稿—选中—局部修稿—差异预览—采纳」闭环，**不是** DSH 内核。
> 证据标记沿用任务书：`LOCAL_VERIFIED`（在本地工作树真实核验）／`already_satisfied`（既有能力已满足且有测试）／`blocked`／`not_run`。

## 1. 本地源码基线（E00.1，2026-10-11 实测）

| 项 | 值 |
|---|---|
| 工作目录 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio` |
| `package.json` name/version | `novel-studio` / **`1.1.6`**（与任务书目标一致） |
| `engines.node` | `>=22.13.0` |
| 实际 Node | **v24.19.0**（npm 11.17.0） |
| 分支 | `Experimental-Version-v1.0` |
| HEAD | **`6f9a14b0d1f7e11117b68d0536aee5ca238969cd`** |
| HEAD 主题 | `feat(叙事性专项修复): 补丁协议 v2 + 叙事诊断/审稿结构化 + 修稿计划与补丁模块 + 159 条离线断言` |
| 项目级 AGENTS.md | **不存在**（仓库根无 `AGENTS.md`；有 `CONTRIBUTING.md`、`docs/README.md`、`README.md`） |
| 工作树 | **脏**（含本轮之前未提交的第二轮修复；见 `baseline.json` 的 `pre_existing_worktree`） |

**没有执行**：`git reset` / `clean` / `stash` / `commit` / `push` / `checkout`；未切版本、未改真实作品库、未动密钥与角色卡。

### 1.1 本会话期间 HEAD 与工作树未被破坏的证据

```text
$ git rev-parse HEAD
6f9a14b0d1f7e11117b68d0536aee5ca238969cd     # 与 E00 记录一致，会话结束时未变

$ git status --porcelain=v1 | wc -l
24                                          # 全部为已存在的未提交修改 + 本轮新增文件，无删除
```

## 2. 环境限制（必须先说清楚，否则会把环境问题误判成代码缺陷）

本会话的 DSH 文件沙箱**禁止子进程的管道 stdio**，实测：

```text
$ node -e "spawnSync(node,['-e','console.log(1)'],{encoding:'utf8'})"
piped status = null   err = EPERM
$ node -e "spawnSync(node,['-e','console.log(1)'],{stdio:['ignore','inherit','inherit']})"
inherit status = 0
```

后果与处置：

| 现象 | 真实原因 | 本轮的处置 |
|---|---|---|
| `node scripts/test-narrative-repair.mjs` 曾把 11 个套件报成"✗ 0ms" | 包装脚本用 `spawnSync(stdio:'pipe')`，子进程起不来（`status=null`） | 已为该运行器加**同进程回退**（管道不可用时逐套件 `import` 执行，断言与退出码判定不变）；现 11/11 通过 |
| `node scripts/ci-offline-checks.mjs` 54/54 全红 | 同一原因（该运行器仍要管道；且部分检查需要 HTTP 隔离实例） | **如实记为环境未验证**，不当成通过、也不当成代码回归 |
| `node .p1-baseline/test-editing-rules.mjs` 末尾 `spawn EPERM` | 它要起隔离 HTTP 实例（`.p1-baseline/test-editing-rules.mjs:201`） | 断言部分全绿后崩在起服务；该测试导入 `ai/editing/rules.mjs`、`ai/editing/scan.mjs`，**本轮均未修改** |

> 纪律：**绝不用"跳过"冒充"通过"**。上述三项在 `test-report.md` 中标为 `not_run(env_blocked)`，
> 并给出在正常环境下应执行的原始命令。

## 3. 真实调用链（LOCAL_VERIFIED，按文件:行）

```text
生成
  buildAIWritingBlueprintPrompt / buildAIWritingProsePrompt        public/app.js
审稿预检（零 token）
  POST /novel/scan            → buildRedlineScanText               public/app.js:10935-10949
  loadContinuityGuard         → buildContinuityGuardText           public/app.js:10638-10642
审稿阶段提示词
  buildAIReviewPrompt(article, redlineScanText, guardText, targetWords, opts)   public/app.js:10968-11010
      · 红线扫描块（S01 命中候选化）                              public/app.js:10980-10990
      · 叙述诊断项来自 ai/writing/policy.mjs（同源，不复制）       writingPolicyLines('verify_style','diagnostic')
审稿输出 → 结构化与核验
  structureReviewReport(report, ctx)                               ai/editing/narrative-review.mjs
      · 引用逐字核验 / 重复引用拒收 / 反证缺失降级                 validateNarrativeFinding + normalizeNarrativeFindings
      · E01 §5.2 报告自洽（本轮新增）                              checkReportConsistency  narrative-review.mjs:257
      · 每条返回路径统一附加 consistency                          withConsistency         narrative-review.mjs:326
API / DB
  PUT /api/novel/review → structureReviewReport → saveReview       server.js:9017-9058 , 4191-4208
      · report_json = 整份 structured（**含 consistency**）→ 无需迁移
      · 响应回带 consistency / consistency_conflicts（本轮新增）   server.js:9052-9054
UI 清单
  showReviewReport(review) → reportConsistencyHtml(review.consistency)   public/app.js:11182-11202
选择（稳定 ID）
  refineByChecklist(): 清空 pendingReview **之前**冻结 review_id   public/app.js:11211-11229
  issueStableId() = 结构化 finding.id / 报告原始序号               public/app.js:11841-11845
  勾选集合 → selectedIssueIds（不重编号）                          public/app.js:11280-11282
局部编辑计划
  revisionPlanFor(article, issues, {snapshot, issueIds, allowCondense…})  public/app.js:11796-11823
  PL.buildRevisionPlan → hotspots / coverage / unlocated_hotspots  public/revision-plan.js
  PL.locateFragment（重复原句 → ambiguous，绝不取第一处）          public/revision-plan.js:108-145
Host 授权表
  revisionAuthorizationFor(plan) → PL.planAuthorization(plan)      public/app.js:11832-11838
  **没有计划 / 0 授权跨度 → 不发起付费修稿**                        public/app.js:11297-11308
补丁协议（双重授权）
  E.runRevisionPipeline({authorization, expectedSchemaVersion:2})  public/revision-patch.js:1417
      · ①issue_ids ⊆ 已选                                        revision-patch.js:876-886
      · ②该 issue 授权了该跨度/原文/op                            revision-patch.js:890-908 , 650-665
      · 模型自报 span:{start,end} 不算许可                        revision-patch.js:803-827
      · 期望 v2 但缺授权表 → fail-closed（本轮新增 S05-1）         revision-patch.js:1414-1427
门禁 / 组合核验
  gatePlanPatches（逐条） → combined 组合核验                      revision-patch.js:1411-1421 , 1464-1472
差异预览 / 采纳
  showReviewDiff(oldText, newText, {…, targetWords})               public/app.js:12392
      · 篇幅缺口如实呈现（本轮新增 E03 §7.1）                      public/app.js:12442-12447 , 12465-12477
      · 覆盖表 revisionCoverageHtml / 逐条 revisionAppliedHtml      public/app.js:12116-12168
  mergeReviewDiff()（作者显式动作；旧稿先入历史版本）               public/app.js:12460+
整章重写（**仅作者显式入口**）
  refineByFullRewrite  ← 唯一触发点 模态按钮 long-text-retry-alt    public/app.js:11522-11526 , 15962-15968
  refineLongTextFull   → longTextRunTask('revision_full')           public/app.js:14280-14290
```

### 3.1 本轮改动落点（真实文件:行）

| 风险项 | 改动 | 位置 |
|---|---|---|
| S01 | 红线扫描块从"命中的要写进 issues"改为"候选信号 + not_applicable 出口 + counterevidence" | `public/app.js:10980-10990` |
| S09（配套） | 审稿 JSON 契约补 `signal_hit` / `verdict` / `counterevidence` 说明 | `public/app.js:10986-10990` |
| E01 §5.2 | 新增 `checkReportConsistency`（绝对措辞 × 同话题反例） | `ai/editing/narrative-review.mjs:257` |
| E01 §5.2 | 每条返回路径统一附加 `consistency` | `ai/editing/narrative-review.mjs:326` |
| E01 §5.2 | 落库随 `report_json` 持久化 + API 回带 | `server.js:9052-9054` |
| E01 §5.2 | 界面显示"待校准"具体矛盾 | `public/app.js:11182-11202` |
| §5.3 新增诊断 | `reaction_causality` / `focalization_limit` 元数据 | `ai/editing/narrative-scan.mjs:55-66` |
| §5.3 新增诊断 | 两个判据函数（候选 + 反证通道） | `ai/editing/narrative-scan.mjs:186-244` |
| S05-1 | 期望 v2 却缺授权表 → `authorization_required` fail-closed | `public/revision-patch.js:61 , 1414-1427` |
| E03 §7.1 | 差异预览给出 before→after / net_delta / 剩余目标差额 | `public/app.js:12442-12447 , 12465-12477` |
| E03 §7.2 | H01–H07 可审批子热点 | `issue-coverage.json` |

## 4. 既有能力：`already_satisfied`（有测试、不重复实现）

按任务书 §2「若本地已修，提供用例和执行结果，记录 `already_satisfied`，严禁重复开发模块」：

| 项 | 判定 | 关键证据 | 已覆盖用例 |
|---|---|---|---|
| S02 清空前冻结 review_id | **already_satisfied** | `public/app.js:11211-11218` | `frontend-test` 116E-d |
| S03 稳定 finding ID（不做 `map((_,i)=>i+1)`） | **already_satisfied** | `public/app.js:11841-11845`、`11280-11282` | `frontend-test` 116E-c / 116E-e；`08-authorization` E01-6 |
| S04 plan 失败不放宽整章 + context_only 分离 | **already_satisfied** | `public/app.js:11817-11823 , 11297-11308 , 11583-11594`；`revision-plan.js:394-397 , 420 , 427-428` | `08-authorization` E01-3/3b/3c/3d/3e；`frontend-test` 116E-a/b/f/g/m |
| S05 双重授权（issue ∧ span/op） | **already_satisfied** | `revision-patch.js:876-908 , 650-665 , 803-827` | `08-authorization` E01-1/1b/1c/1d/3d/5/5b/5c；116E-f/l/m |
| S06 重复原句判歧义 | **already_satisfied** | `revision-plan.js:108-145` | `08-authorization` E01-2/2b/2c；`05-revision-plan` E05-a |
| S07 重试预算跨刷新共享 | **already_satisfied** | `public/app.js:11752-11792`；`revision-patch.js:1281-1295` | `frontend-test` 116E-i/j/k；`01-patch-protocol` P11/P11b |
| S08 无"失败→整章重写"自动回退；作者入口保留 | **already_satisfied**（注释层 PARTIAL） | `public/app.js:11478-11484 , 11522-11526 , 15962-15968 , 14280-14290` | `frontend-test` 94K / 94K3 / 116E-b |
| E03 condense 默认关闭 | **already_satisfied** | `public/app.js:11742`（`ns_revision_allow_condense`，缺省 `'0'`）；`revision-plan.js` 无批准位即 `refused` | `11-review-closure` T41-a |
| E03 字数口径统一（生成/审稿/预览同源） | **already_satisfied** | `wordCount` / `plainLength` `public/app.js:902 , 10490`；`resolveTargetWords` `10523` | `frontend-test` 98e；本文档 §1 |

## 5. 样本与计数基线

| 项 | 值 | 证据等级 |
|---|---|---|
| 报告称 6357 字（剥标签+去空白） | **SOURCE**，本轮未拿到该章完整正文，**未本地复算** | `not_run` |
| 目标 4000 / 风格上限 5000 | **SOURCE**；本地口径由 `resolveTargetWords`（章节覆盖 > 作品默认 > 2000）决定，与报告数字不必相等 | `not_run` |
| 冻结样本 `fixtures/before.txt` / `after.txt` | 4736 / 约 4746 字符（按字符计，**不是** `wordCount` 口径） | `LOCAL_VERIFIED`（哈希见 `02-fixtures`） |
| 本轮新样本 | 仅拿到用户贴出的**逐段摘录**，标记 `full_sample_unavailable` | `10-new-sample` E06-c |
| 本次实际勾选了哪些 issue / condense 开关 / 原始补丁 | **无运行记录可查** | `not_run`（`missing_execution_evidence`） |

## 6. 未运行项（不得当作已通过）

| 项 | 状态 | 原因 / 恢复条件 |
|---|---|---|
| 真实模型语义审稿与文学效果 A/B | `not_run` | 需要用户明确授权付费预算：`SKIPPED: paid_evaluation_not_authorized` |
| `scripts/ci-offline-checks.mjs` 54 项 | `not_run(env_blocked)` | 沙箱禁管道 + 部分需 HTTP 隔离实例 |
| `api-test-suite.mjs`（含 `/api/novel/review` HTTP 往返） | `not_run(env_blocked)` | 需 `node scripts/ci-isolated-run.mjs --port 3738 -- node api-test-suite.mjs` |
| 本轮真实两版正文的字数复算（6357/4000/5000） | `not_run` | 缺完整正文；片段不可拼全文 |
| 真实小说 / 真实数据库 / 角色卡 / 密钥 | **未触碰**（按任务书 §3 边界） | — |
