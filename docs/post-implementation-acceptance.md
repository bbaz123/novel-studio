# 落地后独立验收（post-implementation acceptance）

> 任务书：`C:/Users/a1941/Desktop/001.txt`（Novel Studio 落地后独立重审、回归与上线前验收）。
> 状态词：`PASS / FAIL / BLOCKED / SKIP`；证据等级：`CODE-CONFIRMED`（仅代码/配置/契约可证）与 `RUNTIME-VERIFIED`（真实跑通目标业务链）**分开统计，不混算**。
> 机器可读账本：`docs/post-implementation-results.json`（107 条 = 基线 9 + 子系统 20 + 本轮 POST 14 + NEG 35 + R01–R12 + 专项 §6–§22 17）；负向矩阵：`.verify-post/negative-matrix.json`（NEG-01…35）。
> 基线（修改前）与操作失误见 `docs/post-implementation-audit.md` §B；问题清单见 `docs/post-implementation-issues.md`。

## 0. 本轮结论（先读）

- **G1–G7、G9–G16 共 15 个发布 Gate = PASS；G8（OpenViking 集成与隔离）= BLOCKED**：本机 OV 服务端（1933/3737）未监听，写入/召回的真实服务端链路无法运行时验证；离线边界（跨书/未来章/候选/缺 scope fail-closed）与 rebuild 范围证明已由 `test-ov-recall-boundary` 用本地 OV stub 覆盖。
- 按 §26 的措辞纪律：**不能写"当前增强版本通过本轮独立上线前验收"** —— 有且仅有一个必需 Gate 为 BLOCKED。若把 G8 降级为"非必需"，结论才成立；本文不做这种降级。
- 本轮修复 2 个 **P1 产品缺陷**（ISSUE-02 样文档案接口 500；ISSUE-03 R08 单请求路径三缺陷）+ 1 个 **P2 测试可靠性**（ISSUE-01 busy_timeout）。
- 修复后回归：离线 CI **45/45**、隔离实例总回归 **48 通过/1 未通过/6 跳过**（唯一未通过 = 既有 OBS-02）、浏览器 E2E **19/19**、前端断言 **263/0** —— 与修复前基线逐项对齐或更好。
- 真实付费调用（用户授权 ≤¥2）：**7 次 / 输入 818 + 输出 1506 = 2324 tokens / 保守估算 ¥0.0137**，六项能力（去 AI 腔、语义审稿、样文分析、剧情推演、契约建议、导入抽取）全部 PASS。全天窗口付费归属审计：17 个含模型文本的 dsh 会话 **100% 可归属**（本地假端点或上一轮已记账），未归属 **0**。
- 遗留 FAIL 1 项：**OBS-02**（连续性预检在真实作品上命中 4 / 漏报 1 / 误报 0）——**先于本轮存在**，本轮未掩盖、未放宽容差、未删用例，归因待定后按 P2 风险处置。

## A. 当前环境

| 项 | 值 |
|---|---|
| 仓库 / 分支 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio` / `refactor/p0-p6` |
| HEAD | `be38b17c09f632ee546026fffe2723c5a9b3a18c`（本轮全程未 commit / push / tag / rebase） |
| 工作区 | 23 个已修改文件（21 个为本轮开始前既有 + 2 个本轮：`.p1-baseline/verify-phase-map.mjs`、`docs/phase-map.md`）+ 未跟踪文件（新增审计资产见 §B3）；未 commit/push/tag |
| Node / 平台 | Node v24.19.0（`node:sqlite`、`zlib.zstdDecompressSync` 均可用）/ Windows |
| 浏览器 | Edge headless（`--headless=new` + CDP，真实渲染 + 真实 fetch） |
| 真实 DB | `data/novel.db`：47 表、works=2、chapters=56、app_logs 353+（本轮只读，未写） |
| 旧 schema 库 | `data/backup-real-db-premigrate-20260920202338/novel.db`（26 表，2026-09-20 迁移前真实备份）——迁移探针的正确输入 |
| 压力库 | `.p1-baseline/stress-data/novel.db`（work 16：120 章，最长章 12000 字） |
| DSH | `C:\Users\a1941\Desktop\DeepSeek\deepseek-harness`（预构建 `apps/cli/lib/bin.js`）；专用 home `~/.dsh-novel`（profile `novel`）；`~/.dsh` 未触碰 |
| 小说 bundle | `harness-plugins/novel-writing` v0.14.0（源↔安装位 junction，hash 一致；25 工具 / 68 端点） |
| OpenViking | 服务端未监听（1933/3737 无响应）→ 写型运行时一律 BLOCKED；已安装插件 `@openviking/dsh-memory-plugin` 0.5.3 |
| 隔离底座 | `node scripts/ci-isolated-run.mjs --port 3739 -- <cmd>`（临时 DATA_DIR + 空闲端口 + `NOVELSTUDIO_OV_DISABLED=1`） |

## B. 改动审计（三分类，互不混淆）

**B1. 本轮开始前已存在的改动**：`git status` 中的 21 个修改文件（server.js、public/app.js、db.js、openviking*.js、docs/host-contract.* 等）与未跟踪目录（`ai/branch/`、`ai/editing/`、`ai/import/`、`ai/openviking/`、`ai/style/`、`ai/story-state/*`、`public/long-text.js`、`.p1-baseline/test-*.mjs` 等）——属上一轮增强成果，本轮**未回滚、未改写**。

**B2. 本轮新增的代码改动（全部为缺陷修复，无新功能）**：

| 文件 | 改动 | 归属缺陷 |
|---|---|---|
| `server.js` | import 列表补 `sampleSetHash`（1 行） | ISSUE-02 |
| `public/app.js` | 16 处最小编辑：单请求补丁底稿、`singleRunByCaller` 短路、草稿链正文指纹贯通 | ISSUE-03 |
| `frontend-test.mjs` | 新增 3 条回归断言（58ad/58ae/58af，先红后绿） | ISSUE-03 |
| `.p1-baseline/test-{approval-boundary,adopt-atomic,ov-recall-boundary,context-contributions}.mjs` | 直连库句柄补 `PRAGMA busy_timeout = 5000`（测试可靠性，不动产品代码/断言） | ISSUE-01 |
| `.p1-baseline/verify-phase-map.mjs` | 新增 `PI` 阶段认领本轮改动与 `.verify-post/**` 证据（rollback=shared），`--write` 重生成 `docs/phase-map.md` | 过程要求 |

**B3. 本轮新增的审计资产（只读探针 + 证据）**：`.verify-post/tools/*.mjs`（迁移、性能、syncTurns、secret、bundle、金额归属、E2E、修复脚本）与 `.verify-post/*.log`。未删除任何既有测试、未降低任何阈值、未扩大 mock 范围、未修改验收语义。

## C. 缺陷列表

### C1. 本轮修复（fixed_in_this_round）

| ID | 严重度 | 根因 | 复现 | 影响 | 修复 | 回归 | 剩余风险 |
|---|---|---|---|---|---|---|---|
| ISSUE-02 | P1 | `server.js:5520` 使用 `sampleSetHash`，但第 22 行 import 列表漏掉该符号 → 无档案分支必抛 ReferenceError | `GET /api/novel/style/profile?work_id=<新作品>` → 500 `sampleSetHash is not defined`（`.verify-post/issue-02-before-fix.log`） | 新作品/未分析作品首次进入时，作者样文/文风档案/三级意图整卡降级为"服务端不提供"；E2E-10/11 浏览器实证 | import 补 1 个符号（`fix-issue02.mjs`） | 200 + `profile:null, stale:true, semantic_status:not_run`（`issue-02-after-fix.log`）；E2E-10/11 转 PASS | 无 |
| ISSUE-03 | P1 | 上轮 R08 单请求路径三缺陷：①`parse` 写死 `seg.target.text`（`seg=null` 时 TypeError）；②`longTextRunTask` 在单请求路径先真实调用一次模型，调用方老路径再调一次（同一任务双倍计费+双倍等待）；③草稿链合并指纹拿"草稿"比"章节正文"，必然不相等 | 前端 58ad/58ae/58af 三连 FAIL（`Cannot read properties of null`）；E2E-18 `confirm=clicked refine=false`（`.verify-post/fe-before-fix-2.log`、`e2e-run-8-dsh.log`） | "AI 写作 → 先审稿再应用 → 按清单修稿"在单请求路径**永远出不了 diff**；并隐藏双倍调用 | `fix-r08-single-path.mjs` 16 处最小编辑（A/B/C 三组；未改 prompt 语义/模型路由/预算/注入字节） | 前端 263 PASS/0 FAIL；E2E 19/19（E2E-18 `fakeDelta=1 review/refine/merge/adoptRows` 全真） | 无已知 |
| ISSUE-01 | P2（测试） | 4 个测试文件直连隔离库未设 busy_timeout，活实例后台事务瞬时持锁时偶发 `database is locked` | `.verify-post/round1-test-approval-boundary.log`（异常中止于 DROP TRIGGER） | 仅测试偶发假红；产品 API 行为正确 | 测试内补 `PRAGMA busy_timeout = 5000` | 4 文件复跑全绿；连压 5 次 0 失败 | 无 |

### C2. 观察项（未判定为产品缺陷 / 未修复）

| ID | 级别 | 结论 |
|---|---|---|
| OBS-01 | 工具可靠性 | verify-all"套件总闸"对同机并行 dsh 会话敏感；顺序单跑正常 → 作为使用约束记录（同一时刻只允许一个真 spawn 的探针在跑） |
| OBS-02 | P2（既有 FAIL） | 连续性预检真实数据：命中 4 / 漏报 1（`system_frequency@第五章`）/ 误报 0，先于本轮存在；**未修绿**，保留为遗留风险 |
| OBS-03 | P3（本轮核定） | 前端字面量 vs 契约：`/api/logs`、`/api/debug/op`、`/api/ai/write_stream` 均可在契约（JSON 端点族 + 契约文档 §8）中找到依据 = 假阳性；**唯一真实小缺口**：SSE `GET /api/debug/stream`（server.js:4106）未写进契约的 debug 端点清单（文档级 P3） |
| OBS-04 | P3（工具诚实性） | verify-all"装配回归：P1 基线 vs 当前（真实）"实为两个历史快照互比（恒绿）；本轮改为自己抓当前基线并与 `baselines-v2b` 对照：**50/50 逐字节一致**（`compare-current-vs-v2b-full.log`） |
| OBS-05 | 风险 | 隔离实例不会阻断 harness spawn：零计费依赖测试侧设死端点/假端点；本轮全天窗口审计未归属=0，但建议后续在 `ci-isolated-run.mjs` 默认注入死端点 |
| OBS-06 | P3（既有） | `ai/story-state/injection.mjs` 的 DATA 围栏/受保护区块校验是死代码（零调用点）；实际防线是审批门/工具面/导入剥标签/召回 fail-closed（红队 33/0 验证行为面）。不改（改围栏会改动全部请求字节） |

### C3. 本轮新发现但**不修**的契约缺口

- `GET /api/debug/stream`（SSE，实时追踪视图）未在 `docs/host-contract.v1.json` 的 `debug_endpoints` 与 `docs/host-contract.md` §三 的调试录制清单中声明。它是前端调试视图的内部端点，不参与 Host Contract 的工具面与审批语义 → 记 P3 文档缺口，不改契约版本（改契约 fixture 会触发全量契约测试语义变更，超出"最小修复"纪律）。

## D. 验收统计

**按状态**（账本 `docs/post-implementation-results.json` 107 条 + 本文档内的定性结论）：

| 状态 | 数量 | 说明 |
|---|---|---|
| PASS | 103 | 其中 14 条 POST-*（本轮修复/探针）、35 条 NEG-*（§23 矩阵）、12 条 R01–R12、17 条专项 §6–§22、25 条基线/子系统记录 |
| FAIL | 2 | 均为**基线记录**：`BASE-08`/`BASE-09`（修改前的 verify-all 47/2/6 与 48/1/6）。修复后由 `POST-02` 取代（48/1/6，唯一未通过=既有 OBS-02） |
| BLOCKED | 2（R04 / S11 = G8）+1（NEG-22 子项；矩阵内记为 PASS+子项） | OpenViking 运行时链路（服务端未监听） |
| SKIP | 6 | verify-all 中缺活实例/外部仓库的检查（历史既有，不作为通过） |

**按证据等级**（分开统计，不混算）：

| 证据等级 | 数量 | 说明 |
|---|---|---|
| RUNTIME-VERIFIED | 105 条账本记录 | 除 2 条 BLOCKED 外全部为真实运行（隔离实例 / 真浏览器 / 真 dsh spawn / 真实模型 7 次）；BLOCKED 记录只声明"离线部分已跑、在线部分未跑" |
| CODE-CONFIRMED（补充性，不计入 PASS 数） | 9 处 | 仅代码/契约可证的结论：cancel 后置状态机（server.js:3889/3965/6685、harness.js:892-904）、outbox 同事务（server.js:150-152）、projection worker 失败即停（server.js:199-232）、`/api/debug/stream` 未声明（server.js:4106 vs 契约）、`ai/story-state/injection.mjs` 死代码（OBS-06）、bundle profile 接线（profile package.json）、旧 localStorage 键读写 try/catch（app.js:931-951）、断网重试有界（server.js:3491-3497）、REBUILD_LIMITS.max_attempts |

**门禁语义**：运行类验收只有 RUNTIME-VERIFIED 才计 PASS；上述 CODE-CONFIRMED 处仅用于佐证风险面，不单独构成 PASS。

## E. 实际测试命令与证据（只列真正执行过的）

| # | 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | `node scripts/ci-offline-checks.mjs` | 0 | 45/45 通过（零计费） | `.verify-post/after-fix-ci-offline.log` |
| 2 | `node scripts/ci-isolated-run.mjs --port 3739 -- node .p1-baseline/verify-all.mjs` | 1（因既有 OBS-02） | 48 通过 / 1 未通过 / 6 跳过 | `.verify-post/after-fix-verify-all-isolated2.log` |
| 3 | `node frontend-test.mjs` | 0 | 263 PASS / 0 FAIL（vm + DOM 桩） | `.verify-post/fe-after-fix.log` |
| 4 | `node .verify-post/tools/e2e-browser.mjs`（`E2E_DSH=1`，Edge headless + CDP） | 0 | E2E 19 PASS / 0 FAIL / 0 SKIP | `.verify-post/e2e-run-9-dsh.log`、`.verify-post/e2e-report.json` |
| 5 | `node .verify-post/tools/probe-old-db-migration.mjs`（默认 2026-09-20 旧库） | 0 | 26→47 表零丢失、幂等、中断可续 | `.verify-post/old-db-migration-probe.log`、`-live.log` |
| 6 | `node .p1-baseline/test-approval-boundary.mjs` | 0 | 审批边界 50/0 | `.verify-post/round1-fix-test-approval-boundary.log` |
| 7 | `node .p1-baseline/test-adopt-atomic.mjs` | 0 | 整次采纳 36/0 | `.verify-post/round1-fix-test-adopt-atomic.log` |
| 8 | `node .p1-baseline/test-long-text.mjs` | 0 | R08 长正文 58/0 | `.verify-post/round1-test-long-text.log` |
| 9 | `node .p1-baseline/test-ov-recall-boundary.mjs` | 0 | 召回来源边界 38/0（本地 OV stub） | `.verify-post/round1-fix-test-ov-recall-boundary.log` |
| 10 | `node .p1-baseline/test-author-style.mjs` | 0 | 样文/文风/意图 52/0 | `.verify-post/round1-test-author-style.log` |
| 11 | `node .p1-baseline/test-editing-rules.mjs` | 0 | 编辑规则 45/0 | `.verify-post/round1-test-editing-rules.log` |
| 12 | `node .p1-baseline/test-branch-sandbox.mjs` | 0 | 剧情沙盘 66/0 | `.verify-post/round1-test-branch-sandbox.log` |
| 13 | `node .p1-baseline/test-import-guard.mjs` | 0 | 导入安全 30/0 | `.verify-post/round1-test-import-guard.log` |
| 14 | `node .p1-baseline/test-import-rebuild.mjs` | 0 | 导入重建 28/0 | `.verify-post/round1-test-import-rebuild.log` |
| 15 | `node .p1-baseline/test-context-contributions.mjs` | 0 | 上下文贡献 27/0 | `.verify-post/round1-fix-test-context-contributions.log` |
| 16 | `node .p1-baseline/test-disclosure.mjs` | 0 | 披露派生视图 31/0 | `.verify-post/round1-test-disclosure.log` |
| 17 | `node .p1-baseline/test-agent-write-boundary.mjs` | 0 | 工具写边界 24/0 | `.verify-post/round1-test-agent-write-boundary.log` |
| 18 | `node .verify-post/tools/post-adversarial.mjs`（隔离实例 + 假端点） | 0 | 独立对抗探针 33/0 | `.verify-post/post-adversarial-final.log` |
| 19 | `node .verify-post/tools/perf-probe.mjs` | 0 | 性能绝对观测（见 §20） | `.verify-post/perf-probe.log` |
| 20 | `node .verify-post/tools/probe-syncturns.mjs` | 0 | resolveKnobs 4/4 | `.verify-post/syncturns-probe.log` |
| 21 | `node .verify-post/tools/probe-secret-hygiene.mjs` | 0 | 静态 363 文件 + 运行面 0 命中 | `.verify-post/secret-hygiene-probe.log` |
| 22 | `node .verify-post/tools/probe-bundle-identity.mjs` | 0 | bundle 一致性 11/0 | `.verify-post/bundle-identity-probe.log` |
| 23 | `node .p1-baseline/probe-live-capabilities.mjs`（用户授权 ≤¥2；硬闸门 ≤8 调用） | 0 | live 7/7 PASS，2324 tokens，¥0.0137 | `.verify-post/live-capabilities-this-round.log/.json` |
| 24 | `node .verify-post/tools/audit-money-window.mjs` | 0 | 17 会话 100% 归属，未归属 0 | `.verify-post/money-window-audit.log` |
| 25 | `node .p1-baseline/verify-phase-map.mjs --write` 后只读复核 | 0 | 424 改动全归属、PI 认领 154 文件、文档重生成后一致（43093B） | `.verify-post/after-fix-phase-map3.log`；`.verify-post/phase-map-write.log` |

> 说明：`node .verify-post/tools/e2e-browser.mjs`、`post-adversarial.mjs`、`perf-probe.mjs` 等探针均在**隔离实例 + 假端点/死端点**下运行；真实模型只出现在第 23 行（显式授权）。

## F. 实机证据

| 面 | 是否真实验证 | 证据 |
|---|---|---|
| Browser | ✅ 真实 Edge headless + CDP：真实渲染、真实 fetch、真实 DOM 交互（点击/键盘/窄屏/刷新） | `.verify-post/e2e-run-9-dsh.log`（19/19） |
| DSH | ✅ 真 spawn dsh：工具循环（模型→工具→模型 2 轮）、写作慢链（AI 写作→审稿→修稿→合并→采纳） | `.verify-post/baseline-r01-tool-loop.log`（7/0）、`.verify-post/e2e-run-9-dsh.log` E2E-18 |
| DeepSeek | ✅ 真实付费调用 7 次（六能力 + 连接自检），全部 HTTP 200 且结果可校验 | `.verify-post/live-capabilities-this-round.log/.json` |
| OpenViking | ⛔ 服务端未监听 → 写型/服务端链路 **BLOCKED**；离线 stub 覆盖来源边界与 fail-closed | `.verify-post/round1-fix-test-ov-recall-boundary.log`（38/0） |
| SQLite | ✅ 真实隔离库上的事务/并发/迁移/崩溃注入 | `.verify-post/old-db-migration-probe.log`、`perf-probe.log`、`round1-fix-test-adopt-atomic.log` |

## G. 兼容性

| 面 | 结论 | 证据 |
|---|---|---|
| 旧作品 | PASS：新功能默认关闭时上下文/manifest 无新增层，逐字节回到默认基线 | `round1-test-editing-rules.log`（B1/B2/B10）、`compare-current-vs-v2b-full.log`（50/50） |
| 旧 DB | PASS：2026-09-20 旧库 26→47 表、零丢行、旧作品可读、二次启动幂等、中断可续 | `old-db-migration-probe.log` |
| 旧 API | PASS：Host Contract 1.10.0 代码↔契约↔文档一致（28/0）；新增端点只增不改 | `.verify-post/baseline-host-contract.log`、`docs/host-contract.*` |
| localStorage/session | PASS：旧键/旧帮助锚点仍可用；真实浏览器刷新恢复 `session workId=1 view=writing` | `fe-after-fix.log`（58a）、`e2e-run-9-dsh.log`（E2E-07） |
| GUI / headless | PASS：同一 profile 唯一接线点；安装位 junction 指回仓库源、hash 一致；headless `dsh --dump-config --profile novel` 解析到同一 bundle | `bundle-identity-probe.log`（11/0） |
| 新功能关闭状态 | PASS：R05/R07/R09/R10/R11 全部默认关闭且关闭后行为与增强前一致 | `round1-test-editing-rules.log`、`round1-test-context-contributions.log`、`round1-test-author-style.log`（C1） |

## H. 费用

- **授权依据**：用户 2026-09-27 显式授权"给予预算 2 元以内"；探针自带硬闸门：调用 ≤8 次、单次 max_tokens ≤512、输出总量 ≤30000、总 tokens ≤120000、单次超时 120s、重试 0 次、保守估算上限 ≤¥2。
- **本轮真实付费调用**：**7 次**（连接自检 1 + 六项能力 6），输入 818 + 输出 1506 = **2324 tokens**，保守估算 **¥0.0137**（≤¥2 ✅；账单以 provider 为准）。
- **本轮其他所有测试**：0 次真实调用——全天窗口审计 17 个"拿到模型文本"的 dsh 会话中，3 条由合成申报归属、13 条由假端点日志关联归属（回环绑定 127.0.0.1）、1 条为**上一轮**已记账的 P6 live 冒烟（`session-cbd1b388…`，10591 tokens）；未归属 **0**（`.verify-post/money-window-audit.log`）。
- 累计（上轮 ≈¥0.035 + 本轮 ≈¥0.0137）远低于授权上限；本轮未新增任何未授权调用。

## I. 用户数据安全

- 未写真实 DB `data/novel.db`（仅以只读方式读取凭据与表结构）；未打开/修改真实作品正文；未触碰正式 OV namespace（OV 全程禁用或本地 stub）；未触碰 `~/.dsh`（写作任务只用 `~/.dsh-novel`；写入的会话转录属写作任务的正常产物，且未做破坏性操作）。
- 未执行 `git commit / push / tag / merge / rebase / reset --hard / clean`；未覆盖用户未提交修改。
- 破坏性测试（迁移中断、崩溃注入、并发写、导入炸弹）全部在临时库/临时目录/临时端口上执行，结束后清理。
- 证据文件不含 API Key / Bearer / 完整审批 id / 真实书稿：`secret-hygiene-probe.log`（363 文件 + 运行面 0 命中，含阳性对照）。

## J. 未解决风险（不得用"全部完成"覆盖）

1. **G8 BLOCKED**：OV 服务端未监听，真实服务端的召回/投影/重建链路本轮无法运行时验证；离线 stub 覆盖了边界判据与 fail-closed，但"OV 在线时的端到端行为"仍是未知面。
2. **OBS-02（P2，既有 FAIL）**：连续性预检真实数据漏报 1（`system_frequency@第五章`），未达通过线；本轮未修绿，也未掩盖。
3. **NEG-22 子项 BLOCKED**：`syncTurns`(=autoCapture) 的配置语义已核验（4/4），但"排队写入由 drainer 重放"需 OV 在线。
4. **OBS-05（P2 风险）**：隔离实例不阻断 harness spawn，零计费依赖测试侧设端点约定；本轮审计未归属=0，但新增测试若漏设端点仍可能计费（建议基座默认注入死端点）。
5. **OBS-06（P3）**：`ai/story-state/injection.mjs` 的 DATA 围栏/受保护区块校验为死代码；行为层防线有效但文档口径与实现不符。
6. **OBS-03 余项（P3）**：`GET /api/debug/stream` 未写入契约清单。
7. **OBS-04（P3）**：verify-all 中"装配回归"条目仍是历史双快照互比（本轮已用自抓基线补证 50/50，但工具本身未改）。
8. **OBS-01（P3 工具）**：verify-all 总闸对并行 dsh 会话敏感——同一时刻只允许一个真 spawn 探针在跑。

---

## 附 1：R01–R12 逐条重验（本轮独立取证，不继承上轮 PASS）

| 项 | 结论 | 证据等级 | 关键证据（断言级） |
|---|---|---|---|
| R01 DSH 插件/能力对账 | PASS | RUNTIME-VERIFIED | bundle 0.14.0 三处一致、25 工具/68 端点（`baseline-plugin-tools.log`）；真 spawn 工具循环 7/0（`baseline-r01-tool-loop.log`）；profile 参数生效（`dsh-profile-check.log`）；GUI/headless bundle 一致 11/0（`bundle-identity-probe.log`） |
| R02 双链与三类数据（工坊/DSH 会话/Host Contract 工具链） | PASS | RUNTIME-VERIFIED | 工具循环 + 装配 + 贡献记录 + 旧库读取；R02.1 工具写边界 24/0（`round1-test-agent-write-boundary.log`） |
| R03 故事状态内核 | PASS | RUNTIME-VERIFIED | 端到端（开关/提案/陈旧/回滚/预检/校验）通过；审批边界 50/0；整次采纳 36/0 |
| R04 OV 双链与三类数据 | 边界 PASS / 运行时 **BLOCKED** | RUNTIME-VERIFIED（离线） | 来源边界 38/0（跨书 A8、未来章 A6、候选 A9、缺 scope A11、全拦 A14）；服务端未监听 → G8 BLOCKED |
| R05 最终模型上下文（何时进请求） | PASS | RUNTIME-VERIFIED | 贡献记录 27/0：每层 id/长度/hash/预算/单位/session 可核对；去重默认关、开启后重复不再进入；对抗 C4 规则层逐字节不变、C5 变化层全在内容白名单、C6 跨书隔离、C7 只存 hash/长度 |
| R06 创作上下文与借鉴页面 | PASS | RUNTIME-VERIFIED | E2E-02 外链 5 条全带 noopener、许可可见、返回可用；58a–58f 旧键兼容/别名/外链安全/无官方背书暗示；E2E-06 窄屏、E2E-07 刷新恢复 |
| R07 编辑 / Humanizer / 审稿（七能力） | PASS | RUNTIME-VERIFIED | 编辑规则 45/0：A1 版本/hash、A3 默认关、A9 题材不适用不加载、C·七能力逐项"开启进请求/关闭不进"、B9/B10 关闭后逐字节回默认；live 去 AI 腔 + 语义审稿 PASS；统一 diff 路径 `verify-p3-unified` 通过 |
| R08 长正文 | PASS | RUNTIME-VERIFIED | 长文 58/0（片号唯一/头中尾/拼回等原文/越界拒绝/断点续跑/取消）；前端 58t/58v/58x/58y/58z/58aa + 58ad/58ae/58af；E2E-18 慢链全真 |
| R09 作者样文与三级意图 | PASS | RUNTIME-VERIFIED | 样文 52/0（上限/过期/证据预算/冲突/模型侧只读/不进事实）；E2E-10/11；live 样文分析 PASS；ISSUE-02 修复后首次可用 |
| R10 契约、知识与流程闭环 | PASS | RUNTIME-VERIFIED | 契约 1.10.0 测试 28/0；披露派生视图 31/0（读者≠作者、时点、未来、回滚、指纹）；I1/I2/I3/I7 不变量（压力+真实库） |
| R11 剧情沙盘 | PASS | RUNTIME-VERIFIED | 沙盘 66/0（2–5 实质不同候选、形状非法整批拒、知识边界、采纳只写蓝图、stale 复核、取消/恢复不重跑、跨作品 404）；live 剧情推演 PASS |
| R12 已有小说导入重建 | PASS | RUNTIME-VERIFIED | 重建 28/0（分批/基线/hash/校验/候选不落正式/确认原子/中断/陈旧/stale batch/模型侧不可确认）；导入安全 30/0；live 导入抽取 PASS；E2E-15 导入 2 章 |

## 附 2：专项 §6–§22

| 专项 | 结论 | 关键证据 |
|---|---|---|
| §6 DB / Migration | PASS | 空库建表；2026-09-20 旧库 26→47 表零丢失、旧作品可读、新功能默认关、二次启动幂等；120ms 杀进程后 13/21 半新、重启可完成；损坏库响亮失败不篡改原文件（`old-db-migration-probe.log`、`baseline-migration.log`） |
| §7 并发/幂等/竞态/恢复 | PASS | 同键同载荷重放、同键异载荷 409、并发双写只有一次成功、审批单次消费、同章 6 并发写 0 BUSY、outbox 重启恢复、取消后无迟到写入 |
| §8 Patch / Diff | PASS | 空补丁合法 no-op、重复/非唯一/重叠 anchor 拒绝、非法 JSON 不整章重写、stale 源拒绝合并、跨章合并写回所属章、预览后原文变化拒绝合并 |
| §9 Prompt Injection | PASS | 红队 C 组：注入进容器但仍是 pending、规则/契约层逐字节不变、写入仍 403、跨书隔离；样文指令不改工具授权；导入剥标签 |
| §10 作者审批 | PASS | 50/0：模型侧无审批 403、布尔自报无效、单次消费、跨章/跨书/跨操作 403、过期/撤销失效、失败不吞授权、回滚彻底 |
| §11 OV 隔离与恢复 | 离线 PASS / 运行时 BLOCKED | 来源边界 38/0 + rebuild 范围证明 D3–D6；服务端未监听 |
| §12 DSH Runtime | PASS | 真 spawn 工具循环 2 轮 7/0；profile 参数生效；bundle identity 11/0；每任务独立 settings（吞吐前提） |
| §13 AI 路由与关闭新功能回归 | PASS | `verify-ai-branches` 0 处绕过策略；关闭新功能后与增强前基线逐字节一致（50/50） |
| §14 浏览器真实 E2E | PASS | 19/19（Edge headless：首页/借鉴/写作/保存/窄屏/刷新/规则/扫描/样文/意图/沙盘/三档编辑/采纳/导入/历史/返回/慢链/控制台 0 错误） |
| §15 前端与导入安全 | PASS | 导入守卫 30/0（穿越/symlink/zip bomb/编码/上限/零半导入）；前端 263/0 |
| §16 旧作品/旧 API 兼容 | PASS | 旧库升级 + Host Contract 1.10.0 双向一致 + 旧键/旧 session |
| §17 live 与费用 | PASS | 7/7 live PASS、2324 tokens、¥0.0137（授权 ≤¥2） |
| §18 零计费隔离 | PASS | F1/F2/F3b（无配置/4xx/死端口失败）+ 全天 17 会话 100% 归属、未归属 0 |
| §19 崩溃/重启恢复 | PASS | migration 中断、outbox 续跑、长文成功片不重跑、导入批次复用、取消持久化 |
| §20 性能与资源 | PASS | 启动 400ms；120 章列表 7–20ms；12000 字章 8–15ms；装配 2–45ms；6 并发写 35ms/0 BUSY；RSS 83.4MB、CPU 0.22s；代码面：SQLite 重试有界（1 次）、import rebuild 有 max_attempts、projection worker 连续失败即停（无 busy-loop） |
| §21 日志 / Secret / 隐私 | PASS | 363 文件 + 7 响应 + 服务端日志 + app_logs + 浏览器抓包 + 运行追踪：Key/Bearer/审批 id/正文哨兵 0 命中（含阳性对照） |
| §22 第三方许可 | PASS | 6 个参考项目许可与 commit 本轮 GitHub 复核一致；LICENSE=MIT、无 npm 运行时依赖；`THIRD-PARTY-NOTICES.md` 与实际一致；未暗示官方合作 |

## 附 3：§23 必测负向矩阵（35/35）

> 机器可读：`.verify-post/negative-matrix.json`。全部为隔离实例/假端点下的真实运行（RUNTIME-VERIFIED）。

| test_id | 项目 | 状态 | 关键证据（断言） |
|---|---|---|---|
| NEG-01 | 非法 action 不写入 | PASS | 对抗 A1–A5（4xx/404 且计数不变）；工具写边界 24/0 |
| NEG-02 | 未授权/过期/已消费/跨书批准不能写 | PASS | 审批边界 50/0（A1–A4、C1–C3、D2–D4、E3–E5、F3–F5）；对抗 B1–B5 |
| NEG-03 | 正文 hash / 版本 stale 后批准失效 | PASS | F1 `baseline_mismatch`→403、F2 未覆盖新正文；H7 已消费再 apply→403 |
| NEG-04 | SQLite 中途失败整体回滚 | PASS | 审批 G1–G3（失败→403+正文未变+授权未吞）；采纳 C3/C5 无半套状态 |
| NEG-05 | commit 成功 + OV 失败保留 Canon | PASS | 采纳 A7 outbox 与提交同事务；F 组重启只凭 outbox 续跑 |
| NEG-06 | outbox 重启恢复 | PASS | 采纳 F 组（attempts 递增、投影不重复） |
| NEG-07 | 同 key 同 payload 不重复写 | PASS | 采纳 B1–B3；对抗 D1/D2（并发恰好一条原发+一条重放） |
| NEG-08 | 同 key 不同 payload 冲突 | PASS | 对抗 D3 → 409 |
| NEG-09 | 并发编辑不覆盖新正文 | PASS | 对抗 D1/D2；前端 107h2；6 并发写 6/6 2xx/0 BUSY |
| NEG-10 | 切章/删章不写错、不复活 | PASS | 对抗 A5→404；107g/107h 跨章写回所属章；E2E-16/17 |
| NEG-11 | 重复/非唯一/重叠 patch 安全失败 | PASS | 前端 90a/90b/90c |
| NEG-12 | 空 patch 合法 no-op | PASS | 前端 89 |
| NEG-13 | 非法 JSON 不整章重写 | PASS | 前端 28/29/32b/33/34 + 88/90（解析失败→null→作者确认，不静默替换） |
| NEG-14 | 长章头中尾均处理，无漏段/重段 | PASS | 长文 45–63/88–92/118–128；58t |
| NEG-15 | context-only 不被修改 | PASS | 长文 104/106/126 |
| NEG-16 | 长文部分失败可恢复，成功片不重跑 | PASS | 长文 170–179；58v/58aa |
| NEG-17 | 样文事实与注入不进 Canon/权限 | PASS | 样文 D2/D3/D5/D6；对抗 C1/C2 |
| NEG-18 | OV 跨书不串、未来章不泄密 | PASS | 边界 A6/A8/B2/B3/B5/C1–C3；对抗 C6 |
| NEG-19 | 未采纳候选不成为 Canon | PASS | 沙盘 B10/B11/B12/B29/B30 |
| NEG-20 | 缺 scope recall fail closed | PASS | A11 missing_uri、A14 filtered+text 清空、B7 全打本地 stub |
| NEG-21 | rebuild 不删其他作品/长期记忆/DSH 会话 | PASS | rebuild D3–D6（dry-run/范围证明/只删计划内）；重建 B11 不改正文 |
| NEG-22 | syncTurns=false 符合锁定版本 | PASS（子项 BLOCKED） | resolveKnobs 4/4；排队重放需 OV 在线 |
| NEG-23 | 导入中断不重复入账、不覆盖手动资料 | PASS | 重建 B5/B8/B12/B13/B14 |
| NEG-24 | EPUB 穿越/炸弹/脚本安全失败 | PASS | 导入安全 A2/A4/A5/A7/B3b/B7/B8/B10–B14 |
| NEG-25 | 旧 localStorage/session 正常 | PASS | E2E-07；58a；app.js try/catch |
| NEG-26 | 旧作品在新功能关闭时正常 | PASS | 编辑规则 B1/B2/B10；贡献 B1；旧库默认关 |
| NEG-27 | 关闭时模型/路由/上下文不回归 | PASS | 50/50 逐字节（含 --full manifest） |
| NEG-28 | 离线测试不逃逸真实 Provider | PASS | 对抗 F1/F2/F3b；全天归属审计未归属 0 |
| NEG-29 | 日志无 API Key/审批 secret | PASS | secret 探针（静态+运行面 0 命中，含阳性对照）；对抗 E1–E4 |
| NEG-30 | migration 空库/旧库/重复/中断安全 | PASS | 迁移探针（26→47、零丢失、幂等、120ms 中断可续）；迁移测试 A1–D3 |
| NEG-31 | job cancel 后无迟到写入 | PASS | 58aa；长文 188/189；重建取消后 409；服务端取消→杀进程树置 cancelled |
| NEG-32 | 重启不重复付费生成 | PASS | 长文续跑只跑失败片；重建复用已完成批次；outbox 只重放未完成；进度落 localStorage |
| NEG-33 | GUI/headless bundle 一致 | PASS | bundle 探针 11/0（唯一接线点 + headless dump-config + GUI 真 spawn 7/0） |
| NEG-34 | source/installed hash 与声明一致 | PASS | junction realpath 相等 + 3 文件 sha256 相等 + 版本三处 0.14.0 + 无影子副本 |
| NEG-35 | 注入不改系统规则/tool policy/审批/写入权限 | PASS | 对抗 C4/C5/C8；样文 D5/D6；沙盘 B14/B26/B28/C5/C6 |

## 附 4：发布 Gate（G1–G16）

| Gate | 状态 | 证据等级 | 判定依据 |
|---|---|---|---|
| G1 数据安全 | **PASS** | RUNTIME-VERIFIED | 未写真实库/作品/OV；隔离库事务与回滚 50/0、36/0；秘密卫生 0 命中 |
| G2 作者授权 | **PASS** | RUNTIME-VERIFIED | 审批边界 50/0（模型侧写入必须有效授权、单次消费、跨书/过期/撤销失效） |
| G3 事务一致性 | **PASS** | RUNTIME-VERIFIED | 正文+提案+投影同事务；全有或全无；失败回滚彻底 |
| G4 崩溃恢复 | **PASS** | RUNTIME-VERIFIED | migration 中断可续、outbox 重启续跑、长文/导入断点续跑、恢复来自持久化事实 |
| G5 长篇处理 | **PASS** | RUNTIME-VERIFIED | 长文 58/0 + 前端 58t/58v/58x/58y/58z/58aa/58ad/58ae/58af + E2E-18 慢链 |
| G6 AI 路由兼容 | **PASS** | RUNTIME-VERIFIED | `verify-ai-branches` 0 绕过；live 六能力 7/7；三档编辑/审稿真实结果可校验 |
| G7 DSH 集成 | **PASS** | RUNTIME-VERIFIED | 真 spawn 工具循环 7/0；profile 参数；bundle 一致性 11/0 |
| G8 OpenViking 集成与隔离 | **BLOCKED** | RUNTIME-VERIFIED（仅离线） | 服务端未监听：召回/投影/重建的真实服务端链路无法验证；离线边界 38/0 与 fail-closed 已覆盖 |
| G9 浏览器核心流程 | **PASS** | RUNTIME-VERIFIED | E2E 19/19（真浏览器真交互，控制台 0 错误） |
| G10 旧数据/旧 API 兼容 | **PASS** | RUNTIME-VERIFIED | 旧库升级零丢失；契约 1.10.0 一致；旧键/旧 session 可用 |
| G11 导入安全 | **PASS** | RUNTIME-VERIFIED | 导入安全 30/0（穿越/炸弹/编码/上限/零半导入） |
| G12 Prompt Injection | **PASS** | RUNTIME-VERIFIED | 红队 33/0；规则层不变、写入权限不变、跨书隔离 |
| G13 Secret / 隐私 | **PASS** | RUNTIME-VERIFIED | 静态 363 文件 + 运行面（响应/日志/追踪/抓包）0 命中，含阳性对照 |
| G14 Migration | **PASS** | RUNTIME-VERIFIED | 空库/旧库/重复/中断四态 + 损坏库不篡改原文件 |
| G15 性能稳定性 | **PASS** | RUNTIME-VERIFIED | 绝对观测无退化；6 并发写 0 BUSY；无无界重试/busy-loop |
| G16 许可与文档 | **PASS** | RUNTIME-VERIFIED | 6 项目许可本轮复核一致；LICENSE=MIT；未暗示官方合作；文档与实现一致（除 OBS-03 余项 P3） |

## 最终判定（按 §26）

> **当前增强版本未通过本轮独立上线前验收**：15 个 Gate 为 PASS，**G8（OpenViking 集成与隔离）为 BLOCKED**。
> 阻塞原因与本机环境有关（OV 服务端未监听），非本仓库缺陷；解除阻塞后需补做 G8 的真实服务端链路验证，方可按 §26 给出完整 PASS 结论。
> 在不涉及 OV 服务端写入/召回的服务面上，本轮证据支持"可用于长期使用/合并"的判断，但 G8 未通过前不得使用"通过验收"措辞。
