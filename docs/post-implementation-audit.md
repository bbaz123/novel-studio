# 落地后独立重审记录（post-implementation audit）

- 审计日期：2026-09-27（Asia/Shanghai）
- 仓库：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`
- 分支：`refactor/p0-p6`；HEAD：`be38b17c09f632ee546026fffe2723c5a9b3a18c`（本轮未 commit / tag / push）
- 审计原则（001.txt）：不继承上轮任何 PASS；旧文档只作定位线索；先取证后修复；证据分 CODE-CONFIRMED 与 RUNTIME-VERIFIED 且分开统计；破坏性测试无法隔离则 BLOCKED。
- 本轮费用授权：用户在本轮对话明确"给予预算 2 元以内"（001.txt §17 要求的显式 live 授权）。本轮 live 调用预算上限见 §H。

## A. 环境快照（Phase A，只读取证）

| 项 | 实测值 | 取证方式 |
|---|---|---|
| 分支 | `refactor/p0-p6` | `git branch --show-current` |
| HEAD | `be38b17c09f632ee546026fffe2723c5a9b3a18c` | `git rev-parse HEAD` |
| 未提交改动 | 23 个已跟踪文件修改（+5887 / -260），30 个未跟踪条目 | `.verify-post/baseline-git-status.txt` / `baseline-git-diff-name-status.txt` |
| Node.js | v24.19.0 | `node --version` |
| OS | Windows 10.0.26200 | `[Environment]::OSVersion` |
| DSH 仓库 | `C:\Users\a1941\Desktop\DeepSeek\deepseek-harness`，版本 0.1.7-rc.1，预构建 `apps/cli/lib/bin.js` 存在 | package.json |
| novel-writing bundle | 0.14.0（plugin.json / package.json 一致）；sha256 前缀：plugin.json `b8b53933c03e9f8f`、novel-tools.mjs `9940f8b371fa122d` | node 读取 + crypto |
| OpenViking bundle | `~/.dsh-novel/profiles/novel/node_modules/@openviking/dsh-memory-plugin` 存在，版本 0.5.3 | package.json |
| Host Contract | 1.10.0（frozen_at 2026-09-27），声明端点归一化后 61 路径（含别名） | `docs/host-contract.v1.json` |
| 真实 DB（只读） | `data/novel.db`：36 表（含 sqlite_sequence，实际业务表 35）；works=2、chapters=56、story_events=14、ai_eval_events=4、app_logs=350、api_configs=1、harness_jobs=15、story_facts=0；user_version=0（无迁移版本表） | `node .verify-post/tools/db-snapshot.mjs data/novel.db` |
| 真实 DB 未被触碰 | 文件 mtime 2026-09-25 11:53:35，本轮基线运行后未变 | Get-Item |
| 浏览器 | chrome.exe 不存在；msedge.exe 存在（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`） | Test-Path |
| OV 服务端 | 1933 未监听；3737 未监听（无本地 OpenViking 服务） | Get-NetTCPConnection |

### A.1 未提交改动清单（上一轮遗留，本清单在修复开始前冻结）

已跟踪修改（23）：`.p1-baseline/verify-phase-map.mjs`、`README.md`、`THIRD-PARTY-NOTICES.md`、`ai/context/layers.mjs`、`ai/story-state/index.mjs`、`ai/story-state/store.mjs`、`db.js`、`docs/host-contract.md`、`docs/host-contract.v1.json`、`docs/phase-map.md`、`docs/新手指南.md`、`frontend-test.mjs`、`harness-plugins/novel-writing/novel-tools.mjs`、`harness-plugins/novel-writing/package.json`、`harness-plugins/novel-writing/plugin.json`、`openviking-sync.js`、`openviking.js`、`public/app.js`、`public/index.html`、`public/styles.css`、`scripts/ci-offline-checks.mjs`、`server.js`、`zip-reader.mjs`

新增未跟踪（上一轮交付，29 + 本轮证据目录）：`.p1-baseline/test-*.mjs`（13 个新测试）、`.verify-enh/`（上轮证据）、`ai/branch/`、`ai/context/contributions.mjs`、`ai/editing/`、`ai/import/`、`ai/openviking/`、`ai/story-state/approval.mjs`、`ai/story-state/disclosure.mjs`、`ai/style/`、`docs/enhancement-*.md/json`、`docs/openviking-call-map.md`、`docs/plugin-runtime-map.md`、`public/long-text.js`；本轮新增 `.verify-post/`（证据目录，不是产品代码）。

> 区分口径：以上均属"上一轮遗留改动"。本轮修复将追加在 `post-implementation-issues.md` 的修复记录中，逐条注明文件与 diff 特征，便于与遗留改动分离。

## B. 修改前零计费基线（Phase B，全部在修改任何代码之前执行）

| 检查 | 命令 | 结果 | 退出码 | 证据 |
|---|---|---|---|---|
| 离线 CI 全量 | `node scripts/ci-offline-checks.mjs` | 45/45 通过 | 0 | `.verify-post/baseline-ci-offline.log` |
| 前端测试 | `node frontend-test.mjs` | ALL PASS（260 断言） | 0 | `.verify-post/baseline-frontend.log` |
| Host Contract | `node test-host-contract.mjs` | 28/0（契约 1.10.0） | 0 | `.verify-post/baseline-host-contract.log` |
| 插件工具一致性 | `node verify-plugin-tools.mjs` | 25 工具 / 68 端点一致 | 0 | `.verify-post/baseline-plugin-tools.log` |
| R01 工具循环探针 | `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1 node .p1-baseline/probe-harness-tool-loop.mjs`（真 spawn dsh + 自设假端点，零计费） | 7/0 通过 | 0 | `.verify-post/baseline-r01-tool-loop.log` |
| Migration 幂等 | `node .p1-baseline/test-migration-idempotent.mjs` | 13/0 通过 | 0 | `.verify-post/baseline-migration.log` |
| 阶段映射 | `node .p1-baseline/verify-phase-map.mjs` | 通过（276 文件全归属） | 0 | `.verify-post/baseline-phase-map.log` |
| verify-all（隔离端口 3739）并行误跑 | `node verify-all.mjs`（隔离实例） | 47 通过 / 2 未通过 / 6 跳过 | 1 | `.verify-post/baseline-verify-all.log` |
| verify-all 顺序重跑（权威基线） | 同上，串行 | **48 通过 / 1 未通过 / 6 跳过** | 1 | `.verify-post/baseline-verify-all-sequential.log` |

### B.1 基线失败与操作失误说明（不掩盖）

1. **唯一基线 FAIL（先于本轮存在）**：`verify-continuity-guard-on-real-data.mjs` —— 在真实作品数据上"命中 4 / 漏报 1（`system_frequency@第五章`）/ 误报 0"，未达其通过线。本轮将确认它是否与上一轮改动有关（见缺陷列表），未确认前不得当作"上轮引入"。
2. **并行误跑说明（操作失误，非产品缺陷）**：并行运行 verify-all 与真 spawn dsh 的 R01 探针时，"套件总闸"把探针 dsh 会话的模型文本判为"无法归属的真实调用"而假红。顺序单跑后该闸通过（窗口内 dsh 会话 0 条）。教训：本机同时只允许一个真 spawn dsh 的检查在跑。该观察同时是"总闸对同机其他 dsh 会话过敏"的工具可靠性观察项（见 issues）。
3. 6 个跳过项均为：缺活实例（3739 无章节 #227 的 2 项）、需显式授权的 2 项 harness 并发门、以及 2 项需活实例/外部仓库的接线检查；Baseline 阶段未对它们下通过结论。

## C. 费用账本（live 调用）

| 时间 | 项目 | 次数 | 结果 | 证据 |
|---|---|---|---|---|
| （上轮，2026-09-27 早些时候） | 上轮增强的 live 探针 + 整链冒烟 | 8 次 / 约 12.8K tokens ≈ ¥0.035 | 已完成 | `.verify-enh/live-capabilities-2026-09-27.*`、`.verify-enh/smoke-chain-2026-09-27.*` |
| 本轮 | 未开始（Phase E 前为 0） | 0 | — | 本文件将在 Phase E 追加 |

本轮授权与自设上限：用户授权"2 元以内"；本轮自设硬上限 **≤ ¥0.60**（约为授权额 30%），真实付费调用次数上限 12 次，单次 timeout ≤ 180s、retry ≤ 1；每次调用前先写调用计划、调用后立即用 `.p1-baseline/audit-llm-calls.mjs` 记账。若任何一次调用异常放大用量，立即停止 Phase E。

## D. 数据库/破坏性测试隔离口径

- 所有写型测试使用隔离副本（`$env:TEMP` 下）或隔离实例端口；真实 `data/novel.db` 仅只读打开。
- OV 写入型测试使用独立 test namespace；服务端未监听时相关项如实 BLOCKED。
- DSH 测试使用隔离 `DSH_HOME`；不触碰 `~/.dsh-novel` 全局 profile。
- 浏览器测试将用 Edge（headless/CDP）+ 隔离实例 + 临时 DB。

（后续章节按 Phase 推进追加：静态审查、R01–R12、专项矩阵、故障注入、live、Gate、终报。）