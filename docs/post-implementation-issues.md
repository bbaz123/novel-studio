# 落地后独立重审：问题清单（post-implementation issues）

> 记录口径：每条含 严重度 / 根因 / 复现 / 影响 / 修复 / 回归 / 剩余风险。
> `fixed_in_this_round` 只在代码真正被本轮改动且复验通过后标记。先有失败证据，后动代码。

## 观察项（尚未判定为产品缺陷）

### OBS-01 verify-all「套件总闸」对同机其他 dsh 会话敏感（工具可靠性）

- 现象：并行运行 verify-all 与"真 spawn dsh 的 R01 探针"时，总闸把探针会话的模型文本判为"无法归属的真实调用"→假红；顺序单跑通过（窗口内 dsh 会话 0 条）。
- 证据：`.verify-post/baseline-verify-all.log`（47/2/6，总闸红）对比 `.verify-post/baseline-verify-all-sequential.log`（48/1/6，总闸绿）。
- 归因：操作失误（并行跑）为主；但"总闸无法区分本套件内部 spawn 的探针会话"仍是判据粗糙点。
- 处置：不改代码；作为使用约束记录（同一时刻只允许一个真 spawn dsh 的检查在跑），并在终报 J 节列为未解决观察项。

### OBS-02 连续性预检在真实作品上未达通过线（先于本轮存在，归因中）

- 现象：`verify-continuity-guard-on-real-data.mjs` 命中 4 / 漏报 1（`system_frequency@第五章`）/ 误报 0，未达通过线。
- 证据：`.verify-post/baseline-verify-all-sequential.log` 中该条未通过；直接复现已单独跑。
- 处置：待归因（是否与上一轮改动相关）后决定修复或如实记 P2 风险。禁止用放宽容差、删用例的方式"修绿"。

### OBS-03 前端字面量 vs 契约声明的路由名差（待逐一核对）

- 现象：前端出现 `/api/logs`、`/api/debug/op`、`/api/debug/stream`、`/api/ai/write_stream` 等字面量未在契约声明中一一对应。
- 初步判断：疑似命名维度差异（契约按端点族声明 debug 的 start/stop/state/ops；`ai_route` 段 362/373 行提及 write_stream）造成的假阳性。
- 本轮逐条核对结论：
  - `/api/logs`（POST 上报 + GET 查询）——契约 JSON `debug_endpoints` 明确声明 ✅；
  - `/api/debug/op`——契约 JSON 明确声明 ✅；
  - `/api/ai/write_stream`——契约按**端点族** `POST /api/ai/<action>` 声明，`docs/host-contract.md` §8 明列 `action ∈ {…, write_stream, …}`，且写明 SSE 形态 ✅（假阳性）；
  - `GET /api/debug/stream`（SSE 实时追踪，server.js:4106）——**唯一真实小缺口**：未写进契约 JSON 的 `debug_endpoints` 与契约文档的调试录制清单。
- 处置：前三条判假阳性；`/api/debug/stream` 记 **P3 文档缺口**（内部调试视图端点，不参与工具面/审批语义）。本轮**不改契约 fixture**（改它会触发全量契约测试语义变更，超出最小修复纪律），列入终报 J 节。

### OBS-04 verify-all「装配回归：P1 基线 vs 当前（真实）」实为两个旧快照互比（P3 工具诚实性）

- 现象：该条比较的是 `.p1-baseline/baselines-p3-real`（09-15 20:38）与 `baselines-p5-real`（09-15 20:45）两个**历史快照**，都不是当前代码产物；标签里的"当前"不成立 ⇒ 它恒绿，不能检出本轮改动造成的装配回归。
- 处置（本轮已做）：不改旧快照、不重抓覆盖；由本轮**自己抓当前基线**（`.verify-post/baselines-current`，隔离实例+stress 库副本）并与增强前最新快照 `baselines-v2b`（09-26 20:53）对照：**50/50 逐字节一致（含 --full manifest；未归一化同样一致）**，证据 `.verify-post/compare-current-vs-v2b-full.log`。
- 建议（未改代码）：把 verify-all 的该条改成"当前实抓 vs 冻结基线"或至少在标签/文档写明其为历史双快照对照，避免被误读为当前回归证据。

### OBS-05 隔离实例不会阻断 harness spawn：零计费依赖测试侧约定

- 现象：隔离实例（临时库、无 api_config）POST /api/harness/run 会照常入队并可由后台**真实 spawn dsh**（dsh 使用 ~/.dsh-novel 与其中的真实 provider 配置）。产品侧无"未配置模型就拒绝 spawn"的闸门——这是产品语义（本机写作就该用本机凭证），但意味着**测试零计费只能靠测试侧设置死端点/假端点**（仓库既有约定：DEEPSEEK_BASE_URL=127.0.0.1:1 等）。
- 本轮执行：所有 spawn 类检查运行前设死端口；对抗探针 F3 实测"死端口下任务终态为失败"（`.verify-post/post-adversarial-final.log`），跑后窗口审计 `unexplained=0`。
- 风险：任何后续新增的"起实例 + 触发 harness"测试若漏设端点，就会真实计费。建议（未改代码）：在测试基座（如 ci-isolated-run.mjs）默认注入死端点，只有显式 live 流程才放开。

### OBS-06 ai/story-state/injection.mjs 的 DATA 围栏是死代码（P3）

- 现象：`wrapAsData`（DATA 围栏）与 `verifyProtectedBlocks`（受保护区块校验）在生产代码中**零调用点**（仅模块内部与 import 存在）；实际生效的只有 `scanInjection`（把命中计数附到 story_state 元数据）。
- 影响：模块头声明的三条防护中第①②条（围栏包裹、受保护区块校验）在运行时不存在；实际安全依赖审批门、工具面策略、导入剥标签、召回 fail-closed 等行为层防线（本轮注入红队 33/0 验证了这些行为面）。
- 处置：本轮不改（改围栏会改动所有请求字节，违反"最小修复/不改冻结装配"纪律）。如实记入剩余风险，建议后续单独接线或修正文档口径。

## 本轮修复（fixed_in_this_round）

### ISSUE-01 测试偶发失败：`test-approval-boundary.mjs` 直连库无 busy_timeout，偶发 `database is locked`（P2·测试可靠性）

- 证据：`.verify-post/round1-test-approval-boundary.log`（34/1，异常中止于第 232 行 `DROP TRIGGER`）、复现 3/3 通过（`.verify-post/round1-approval-rerun-*.log`）→ 判定为偶发。
- 根因：测试进程直连隔离库执行 DDL/DML（`dbExec`）时未设置 `busy_timeout`；活实例后台事务瞬时持写锁时，测试连接立即 `SQLITE_BUSY`。产品侧自身连接有 5s busy_timeout，产品 API 行为正确（G1/G2/G3 断言在异常前已通过）。
- 修复：仅在这 4 个测试文件的直连库句柄上补 `PRAGMA busy_timeout = 5000`（`test-approval-boundary`、`test-adopt-atomic`、`test-ov-recall-boundary`、`test-context-contributions`）；不改产品代码、不放宽任何断言。
- 回归：4 文件复跑全绿（`.verify-post/round1-fix-*.log`）；`test-approval-boundary` 连压 5 次 0 失败（`.verify-post/round1-approval-stress-*.log`）。
- 剩余风险：无（纯测试可靠性）。

### ISSUE-02 无档案时 `GET /api/novel/style/profile` 抛 500：server.js 漏 import `sampleSetHash`（P1·核心功能/兼容面）

- 严重度：P1。R09「作者样文与文风档案 / 三级作者意图」在**首次分析前**整卡不可用，浏览器实测。
- 证据（修复前）：`.verify-post/issue-02-before-fix.log` —— 隔离实例 `GET /api/novel/style/profile?work_id=1` → `500 {"error":"sampleSetHash is not defined"}`；浏览器侧 `.verify-post/e2e-run-2.log`、`.verify-post/e2e-run-3.log` 的 E2E-10/E2E-11 FAIL（`profOk=false`、`rows=[]`）。
- 根因：`server.js:5520` 在"当前无档案"分支调用 `sampleSetHash(enabledSamples)`，但 `server.js:22` 从 `./ai/style/author-profile.mjs` 的 import 列表漏掉该符号 → 无档案路径必抛 ReferenceError（有档案时走 `current.sample_set_hash` 分支，不触发，所以**只有新作品/未分析过的作品**中招）。
- 影响：前端 `loadAuthorStyle()` 三连读任一失败即把 `state.authorStyle` 置 null → 整卡降级为"当前服务端不提供该接口"；该功能在首次分析前的核心入口不可用（分析成功后仍可用，属"首次不可用"类缺陷）。
- 修复：`.verify-post/tools/fix-issue02.mjs` 在 import 列表补 `sampleSetHash`（1 行，未改任何逻辑）。
- 回归：`.verify-post/issue-02-after-fix.log`（同请求 200：`profile:null, stale:true, semantic_status:not_run`）；`.verify-post/e2e-run-4.log` 起 E2E-10/E2E-11 转 PASS，run-9 全绿；`fe-after-fix.log` 263 PASS / 0 FAIL。
- 剩余风险：无（补 import 最小面；有档案路径未受影响，均已回归）。

### ISSUE-03 R08 单请求路径（未分段）三处缺陷：修稿永远解析失败 / 同一任务双倍真实调用 / 草稿链合并必被拒（P1·核心功能 + 费用）

- 严重度：P1（核心写作链"AI 写作 → 先审稿再应用 → 按清单修稿"不可用；且隐藏同一任务双倍计费）。
- 证据（修复前）：
  - 前端门禁：`.verify-post/fe-before-fix-2.log` —— 58ad / 58ae / 58af 三条 FAIL，报错 `Cannot read properties of null (reading 'target')`，`=== 3 FAILURES ===`。
  - 浏览器慢链：`.verify-post/e2e-run-8-dsh.log` E2E-18 FAIL `confirm=clicked refine=false`（点"按清单修稿"后永远出不了 diff）。
- 根因（`public/app.js`，上轮 R08 引入；三处独立缺陷）：
  1. `revision_patch` 的 `parse` 写死 `seg.target.text`；单请求（未分段）路径 `seg=null` → TypeError → 修稿补丁永远解析失败。
  2. `longTextRunTask` 在单请求路径**先真实调用一次模型**，而 `review / revision_patch / repair_full` 三个调用方各有一条更完整的单请求老路径（审稿的"解析失败仍存原文"容错、修稿的整章回退、精修的写作流水线）→ 同一任务真实调用**两遍**（双倍计费 + 双倍等待）。
  3. AI 写作草稿链（AI 草稿 → 先审稿再应用）的差异合并指纹用"草稿"与"章节正文"比对，永远不相等 → 合并闸门**必然拒绝**。
- 影响：R08 长文链在长章（>单请求安全范围，分段路径）之外的**单请求路径**全面不可用；费用面存在隐性双倍调用。
- 修复：`.verify-post/tools/fix-r08-single-path.mjs`（16 处最小编辑，全部 throw-then-replace）：
  - A：`parse` 底稿改为 `seg ? seg.target.text : o.text`；
  - B：`longTextRunTask` 新增 `singleRunByCaller` 短路（模块只回计划，不预跑模型），三个调用点显式传入；
  - C：草稿链标记 `fromDraft` + 审稿入口经 `revisionBaseArticle()` 固化章节正文指纹 `baseChapterFingerprint` + `showReviewDiff` 新增 `baseFingerprint` 参数 + 5 个调用点透传。
  - 未改：prompt 语义、模型路由、预算常量、注入字节。
- 回归：`frontend-test.mjs` 新增 3 条断言（58ad/58ae/58af，先红后绿）；`.verify-post/fe-after-fix.log` **263 PASS / 0 FAIL**；`.verify-post/e2e-run-9-dsh.log` **E2E 19/19**（E2E-18 `fakeDelta=1 review=true refine=true merge=true adoptRows=1`）；总回归 `.verify-post/after-fix-verify-all-isolated2.log` 48 通过/1 未通过/6 跳过（与基线一致）、`.verify-post/after-fix-ci-offline.log` 45/45。
- 剩余风险：无已知（该链路的既有 OBS-06 DATA 围栏问题为独立项，见观察项）。
