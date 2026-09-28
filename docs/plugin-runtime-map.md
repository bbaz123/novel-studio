# 宿主 / DSH 小说 bundle / OV bundle / 服务端：边界与实际加载路径

> **用途**：让复核者能**照着路径核对**「谁加载谁、实际跑的是哪一份代码」，而不是听叙述（任务书 §19.2）。
> **采集方式**：本机只读枚举 + 本次实测（2026-09-27 首采，Windows，Node v24.19.0）。
> **2026-09-28 复核更新**：版本与规模（插件 / 契约 / 工具 / 端点 / 离线清单条数）已按当前仓库状态刷新，
> 并修正了下方 A/B 双闭环与浏览器 E2E 的状态；**未改写用户的全局 dsh profile**。
> 关联文档：`docs/host-contract.md` §7（Plugin Adapter contract）、`docs/openviking-call-map.md`（OV 三条链）。

## 0. 一句话结构

浏览器（同源前端） → **宿主 novel-studio**（`server.js`：HTTP + SQLite + 唯一装配器 + 作业设施）
→ **dsh 子进程**（专用 profile `novel` + 专用 `DSH_HOME`）→ **novel-writing 插件**（26 个 `novel_*` 工具）
→ 模型（直连 `POST /api/ai/*` 或慢通道 `POST /api/harness/job|run`，走策略表）；
旁路：**OpenViking 共享记忆库**（工坊侧 A 链 + dsh 会话侧 B 链，见另一份文档）。

## 1. 组件与版本（本次实测）

| 组件 | 实际值 | 证据 |
| --- | --- | --- |
| 仓库 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio` | 工作目录 |
| 分支 / HEAD | `refactor/p0-p6`（2026-09-27 采集时为 `be38b17`；两轮改动已于 2026-09-28 提交并推送，当前 HEAD 见仓库） | `git rev-parse HEAD` |
| 运行时 | Node **v24.19.0**；`package.json` 无 dependencies（`node:sqlite` 内建） | `node -v`、`package.json` |
| 宿主契约 | **1.11.0**（`server.js` 的 `HOST_CONTRACT_VERSION`；`frozen_at` 2026-09-28；`GET /api/novel/ping` 回报） | `test-host-contract.mjs` 28/28 |
| 插件 | `harness-plugins/novel-writing` **v0.15.0**：26 个工具 / 75 条端点声明 | `plugin.json` + `verify-plugin-tools.mjs` |
| 故事状态内核 | `ai/story-state/index.mjs` — `STORY_STATE_VERSION = 1.0.0` | 代码 |
| dsh | **0.1.7-rc.2**；本地仓库 `C:\Users\a1941\Desktop\DeepSeek\deepseek-harness`，预构建入口 `apps/cli/lib/bin.js` | 工具循环探针日志（`预构建产物启动`） |
| 专用 DSH_HOME | `C:\Users\a1941\.dsh-novel`；profile `novel`；`node_modules/novel-writing` 是 **Junction** → 仓库 `harness-plugins/novel-writing` | 只读 `Get-Item`（LinkType=Junction） |
| OpenViking | 客户端 `openviking.js` + 同步 `openviking-sync.js`；默认 endpoint `http://127.0.0.1:1933`；配置 `~/.openviking/ovcli.conf`、`~/.openviking/ov.conf` | 代码 + 端口探测（本次**未监听**） |
| 前端 | `public/index.html` + `public/app.js` + `public/styles.css` + `public/long-text.js`（R08 纯函数模块，浏览器与 Node 共用） | 代码 |

**"同一份代码"的证据**（避免"改了一份、跑的是另一份"这类事故）：
插件目录是 junction 而不是副本，因此仓库改动立即生效；`plugin.json` 的 `tools` / `engineEndpoints` 与
`novel-tools.mjs` 实际注册的工具、`server.js` 里真实存在的处理分支三处由 `verify-plugin-tools.mjs`
与 `test-host-contract.mjs` 双重核对。

## 2. 一次写作任务的实际链路

| 步 | 发生什么 | 代码位置 | 可观测入口 |
| --- | --- | --- | --- |
| 1 | 前端取策略快照与唯一上下文 | `public/app.js` → `GET /api/ai/policy`、`GET /api/novel/context` | 上下文预览、`context_manifest` |
| 2 | 宿主装配（唯一装配器，产出 assembled + manifest + envelope + integrity） | `ai/context/assembler.mjs` + `ai/context/layers.mjs` | `context_manifest` / 运行时贡献记录（R05） |
| 3 | 慢通道建作业并 spawn dsh | `harness.js`（`--profile novel`、`DSH_HOME=~/.dsh-novel`、身份经 `NOVELSTUDIO_*` 环境变量） | `GET /api/harness/job`、`job`/`status`/`cancel` |
| 4 | dsh 加载插件并注册工具 | `harness-plugins/novel-writing/novel-tools.mjs`（`ctx.tools.register`） | 工具循环探针端点侧请求序列 |
| 5 | 模型发起工具调用 → dsh 执行 → 结果回灌 → 模型收尾 | 同上 | `.p1-baseline/probe-harness-tool-loop.mjs`（7/7） |
| 6 | 工具写回宿主（提案 / 蓝图 / 章节保存 / 审批校验） | `server.js` 各端点 + `ai/story-state/*` | `ai_eval_events`、`app_logs`、审批表 |

## 3. 边界（谁能写什么）

| 边界 | 实现 | 可观测 / 证据 |
| --- | --- | --- |
| 模型侧写入必须引用作者创建的一次性审批 | `ai/story-state/approval.mjs` + 各写入点的事务内消费 | `test-approval-boundary.mjs` 50/50 |
| 模型不能改自己的规则 / 样文 / 作者意图 | `server.js` 的 `X-Novel-Agent` 判定（403） | `test-editing-rules.mjs`、`test-author-style.mjs` |
| 采纳 / 丢弃 / 取消 / 重开 / 重建确认是作者动作 | `server.js`（403） | `test-branch-sandbox.mjs`、`test-import-rebuild.mjs` |
| 未采纳候选不是本书事实 | `ai/branch/store.mjs` 只写 2 张候选表 | `test-branch-sandbox.mjs`（只读 SQLite 核对 + 装配层阴性对照） |
| 导入文件是不可信输入 | `ai/import/guard.mjs`（单点判据）+ `zip-reader.mjs` | `test-import-guard.mjs` 30/30 |
| 召回内容进装配前必须证明来源（fail-closed） | `ai/openviking/recall-meta.mjs`（生产方与装配器共用） | `test-ov-recall-boundary.mjs` 38/38 |
| 插件不得直连 DB / 绕开预算 / 自建 trace | Host Contract §7 + 契约测试 | `test-host-contract.mjs` C 段 |

## 4. 本次运行到的证据 / 不能声称的部分

- **真实工具循环（RUNTIME-VERIFIED，零计费）**：`NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1 node .p1-baseline/probe-harness-tool-loop.mjs`
  → 真 spawn dsh，本地假模型端点看到 2 条请求（第 1 条 `tool_turn=true`、工具 `glob`；第 2 条 `tool_results=1`），
  收尾正文等于罐头文本；**7/7 通过**（日志 `.verify-enh/r01-harness-tool-loop-run2.log`）。
- **插件面 / 契约一致**：`verify-plugin-tools.mjs`（26 工具、75 端点、三处版本 0.15.0 一致）；
  `test-host-contract.mjs` 28/28（含"契约里每条端点在 `server.js` 里都有对应实现"）。
- **真实 DeepSeek（RUNTIME-VERIFIED，有限预算）**：用户 2026-09-27 授权「预算2元以内」——
  `probe-live-capabilities.mjs` 六类能力 **7/0**（7 次调用 / 2226 tokens ≈¥0.013）＋
  `ci-isolated-run + .p6-cutover/smoke.mjs` 整链写作冒烟 **7/0**（1 次调用 / 10591 tokens ≈¥0.022）；合计 ≈¥0.035 ≤ ¥2。
  证据：`.verify-enh/live-capabilities-2026-09-27.{log,json}`、`.verify-enh/smoke-chain-2026-09-27.{log,usage.json}`。
- **BLOCKED（不写 PASS）**：
  - 真实 OV **A / B 双闭环**：2026-09-27 本机 `1933` 端口未监听；**2026-09-28 知识库专项期间 OV 在线（v0.4.21）**，
    共享资料链（C）已在隔离实例上真机验证（`verify-library-realmachine.mjs` 18/18，写共享资料根 3 篇后删除、根零残留）；
    但作品资源链（A）与会话链（B）的 live 闭环仍记为 BLOCKED——缺足够的 namespace 隔离授权，
    不能把测试哨兵写进作者正式作品/共享长期记忆来强行验收（判据与证据见 `docs/openviking-call-map.md` §3）。OV-VLM 未验证；
  - 真实浏览器 E2E：**已执行**——2026-09-28 独立重审轮用 Edge headless + CDP（`E2E_DSH=1`）跑 **19/19**
    （含慢链 `AI 写作 → 先审稿再应用 → 按清单修稿 → 合并 → 采纳`）。前端另有 vm + DOM 桩的离线执行验证
    （`frontend-test.mjs` 263 断言 PASS）——它**不能**替代浏览器 E2E，两者是两层证据。

## 5. 复验命令

```powershell
node scripts/ci-offline-checks.mjs                 # 46 条离线检查（零计费）
node .p1-baseline/verify-plugin-tools.mjs          # 工具面 / 版本 / 端点声明
node .p1-baseline/test-host-contract.mjs           # 宿主契约（含端点存在性）
$env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'
node .p1-baseline/probe-harness-tool-loop.mjs      # 真 spawn dsh 的工具循环（自设假端点）
node .p1-baseline/probe-live-capabilities.mjs      # 真实模型六类能力（会计费；--dry 只看计划）
$env:NOVELSTUDIO_SMOKE_ALLOW_BILLING='1'
node scripts/ci-isolated-run.mjs --port 3739 -- node .p6-cutover/smoke.mjs --base http://127.0.0.1:3739   # 整链写作冒烟（会计费）
```
