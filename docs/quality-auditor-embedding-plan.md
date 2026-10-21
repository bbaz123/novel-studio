# 方案：审计插件内置化 + 依赖提示与缺依赖弹窗

> 状态：**待批准**（本轮只出方案，未改代码）。
> 目标：让作者在工坊里"看得见、装得上、缺什么知道怎么办"，而不是靠手动脚本和命令行。

## 0. 现状（读码结论）

| 位置 | 现状 |
| --- | --- |
| 依赖清单 `TOOL_SPECS`（`public/app.js:7840`） | 只有 4 项：Node / dsh / novel-writing / OpenViking；**没有审计插件**这一项 |
| dsh 卡渲染 `dshCardHtml()`（`app.js:7972`） | 显示仓库路径、来源、DSH_HOME、settings.yaml；**不显示 dsh 版本与实际启动方式**（repo 还是 npm bin） |
| 服务端检测 `GET /api/env/tools`（`server.js:9037`） | 返回 `dsh.plugin`（只检测 novel-writing）与 OpenViking；**没有审计插件状态** |
| 插件安装 | 只有 CLI：`harness-plugins/dsh-novel-quality-auditor/scripts/install.mjs`；工坊内无法一键装、也不提示没装 |
| 独立复核入口 | 只在审稿报告底部有一枚 `btn secondary` 小按钮；无状态行、无"是否已复核"提示，容易被忽略 |
| 缺依赖时的行为 | 审计创建失败会 toast 错误码（如 `AUDIT_NOT_FOUND`），但**不会**告诉作者"缺哪个依赖、怎么装" |

## 1. 目标拆解（对应你的四点）

### A. 插件内置进工坊（自举 + 自检，不靠命令行）
- 新增 `ai/quality-auditor/provision.mjs`：
  - `auditPluginStatus()`：只读检查「源码存在 / 两个 DSH home 的 profile 是否含依赖+bundle+链接 / 版本」；
  - `ensureAuditPluginInstalled()`：幂等安装（**与现有 install.mjs 共用同一实现**，不再写第二套）：
    备份 `package.json` → 写 dependency(`link:…`) → 追加 bundles → 建 junction。
- 服务端：
  - `GET /api/env/tools` 增加 `dsh.plugins.qualityAuditor = {source_exists, installed, installs:[{home,profile,points_here,version}], ready}`；
  - `POST /api/env/plugins/install {name:'quality-auditor', dry_run?}`（作者通道）→ 调用 ensure，返回安装后状态；
  - **启动时只检测、不自动写 profile**（避免偷偷改环境）；审计创建时若未安装 → 409 `AUDIT_PLUGIN_NOT_INSTALLED`（可执行动作码）。
- CLI `install.mjs/uninstall.mjs` 保留（高级用户/回滚用），实现收敛到 provision。

### B. 让「🔍 独立复核」显眼
- 审稿报告弹窗顶部加**状态条**（primary 按钮 + 一句话）：
  - 未运行：「未做独立复核 · 盲审→初审对照，会调用模型（消耗额度）」
  - 运行中：显示当前阶段（盲审/对照）
  - 有结果：显示 `已复核 · N 项问题 / M 条新增`，按钮变「查看上次复核」。
- 差异预览里的「逐项终验」同样提为主按钮（与「合并到正文」并列但不同色），并注明"未通过项会列出原因"。
- 按钮文案写明代价与前置（需要一份结构化审稿；旧报告只能到"待核验"）。

### C. 依赖显示优化
- `dsh` 行拆出更多事实：**版本**（`dsh --version` 或 package.json）、**启动方式**（repo / npm bin / 未配置）、**实际 profile**、DSH_HOME；
- 新增两行独立状态：`novel-writing` 与 `dsh-novel-quality-auditor`，状态细分：
  - 源码缺失 / 未安装 / 装到别处（同名但不是本仓库）/ 已安装（home + profile + 版本）；
- 版本偏离时给**黄色说明**（例：当前默认走 0.1.7-rc.1，本机实测可用；若要 0.2.0-rc.2 可设 `NOVELSTUDIO_DSH_BIN`），**不自动改**。

### D. 缺依赖弹窗（明确 + 可操作）
- 新增通用弹窗 `openMissingDepsDialog(items)`，每项显示：名称、为什么需要、缺什么、**一条可复制命令**、跳转按钮
  （http 链接 `window.open`；仓库内路径用现有 `POST /api/env/open_folder` 打开目录）。
- 触发点三处：
  1. 点「独立复核 / 逐项终验」前，前端先拉 `/api/env/tools` 判定缺项 → 直接弹窗（不发起付费调用）；
  2. 后端返回 `AUDIT_PLUGIN_NOT_INSTALLED` / `AUDIT_NOT_FOUND` 等可行动错误码 → 弹同一窗；
  3. 设置页依赖卡顶部"有 N 项缺失"横幅，点击打开同一窗。
- 弹窗内提供「一键安装插件」（走 A 的 API），装完立即刷新状态；**不阻断**正常写作与保存。

## 2. 改动清单（预计）

| 文件 | 改动 |
| --- | --- |
| `ai/quality-auditor/provision.mjs` | 新增：状态检测 + 幂等安装（install.mjs 改为调用它） |
| `server.js` | `/api/env/tools` 扩展插件与版本；新增 `/api/env/plugins/install`；审计创建返回可行动错误码 |
| `public/app.js` | `TOOL_SPECS` 增加审计插件；`dshCardHtml` 增加版本/启动方式；新增缺依赖弹窗；审计入口提为主按钮 + 状态条 |
| `public/quality-audit-panel.js` | 增加 `auditEntryHtml(run)`（状态条）与 `missingDepsHtml(items)`（弹窗内容，纯函数便于断言） |
| `frontend-test.mjs` / `scripts/quality-auditor/test-contracts.mjs` | 断言：状态条可见、缺依赖弹窗含命令与链接、未装插件时阻止发起、一键安装调用 |
| `docs/quality-auditor-plugin.md` | 补"内置化/一键安装/缺依赖弹窗"说明 |

## 3. 验证与回滚

- 离线：`frontend-test`（DOM）、`verify-id-chain`、`test-contracts`（新增 `AUDIT_PLUGIN_NOT_INSTALLED` 分支）、`test-e2e`；
- 真实：工坊里点一次独立复核（授权内），确认状态条推进与结果回显；
- 回滚：providers 只写 profile 的 `package.json`（安装前自动备份）+ junction；`uninstall.mjs` 已有恢复逻辑。

## 4. 不做的事

- 不自动删除/替换 DSH 仓库，不自动改 `NOVELSTUDIO_DSH_BIN`；
- 不在服务启动时偷偷改 profile（只在作者点"一键安装"时写）；
- 不阻断普通写作与保存（依赖提示只作用于 AI 审计动作）。

---

## 执行结果（2026-10-21）

- A：`ai/quality-auditor/provision.mjs` 落地；`install.mjs` 改为其包装；`GET /api/env/tools` 返回
  `dsh.plugins.qualityAuditor`、`dsh.version`、`dsh.launcher`、`dsh.missing_dependencies`；
  新增 `POST /api/env/plugins/install`（作者通道，支持 dry-run）；审计创建在插件未装时返回 409
  `AUDIT_PLUGIN_NOT_INSTALLED`。
- B：审稿报告顶部新增 `qa-entry` 状态条（未做/进行中/已复核）+ 主按钮；差异预览的「逐项终验」保留并同风格。
- C：依赖清单新增「审计插件」行；dsh 行显示版本与启动方式（repo/npm bin）。
- D：新增缺依赖弹窗（名称/原因/可复制命令/一键安装/打开目录），三处触发；缺依赖横幅在依赖卡顶部。
- 验证：`test-provision` 5/5、CT 18/18（含 CT-13）、frontend-test 655 PASS、真实工坊
  `/api/env/tools` 显示 `version=0.2.0-rc.2 / launcher=bin / qualityAuditor.ready=true / missing=[]`，
  一键安装 dry-run 返回 `ready=true` 且未改盘。
