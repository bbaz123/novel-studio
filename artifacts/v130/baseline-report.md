# v1.3.0 UI 方案：P0 基线、现状审计与回滚

> 采集时间：2026-10-19 18:52 +08:00。只读采集，未改 `data/`、未执行 git pull/reset、未推送。

## 1. 本地权威基线（按“本地为源”规则）

| 项 | 值 |
| --- | --- |
| BASELINE_VERSION | 1.2.5（`package.json` 实际值；未按 GitHub/README 推断，也未升级） |
| BASELINE_COMMIT | `90782668b02641fc083e794b0db4793d6459915e` |
| 分支 | `Experimental-Version-v1.0` |
| Node / OS | v24.19.0 / Windows |
| WORKTREE_STATUS | 47 项（上一轮 v1.2.5 修稿闭环改动 + 作者既有文档），见 `worktree-status.txt` |
| 数据库 | `data/novel.db` 12,390,400 B；本轮未写入 |
| 回滚 | `git checkout -- <file>`；新增文件删除；哈希快照见 `sha256-before.txt` |

**边界**：本轮不改版本号、不 `git pull/reset/stash`、不升级依赖、不推送 GitHub、不做数据库迁移；
`data/` 与正式正文全程只读。

## 2. 现有实现审计（实际源码入口）

| 方案要求 | 当前实现 | 结论 |
| --- | --- | --- |
| 写作台三栏保留 | `renderWriting()` / `#writing-layout`；`state.editorLayout='three'` | 已具备 |
| 本章状态单行修稿入口 | `revisionClosureStripHtml()`（app.js）在 chapter-state 面板输出一行 + “查看”按钮 | **部分**：只有通用文案，缺 running / pending / all-passed / 未复验四态 |
| 独立审稿工作区 | `goView('review')` → `renderReviewWorkspace()`；头栏/左问题导航/主差异/底栏 | 已具备 |
| 覆盖式详情抽屉 | `.rw-drawer` CSS `position:absolute`，不参与 flex；`reviewWorkspaceToggleDrawer()` | **部分**：同时保留了常驻 `.rw-issue-detail` 内联详情；缺焦点管理与 Esc 回焦 |
| 四阶段导航 | 只有 `rw-stage` 单徽记 | **缺** |
| 问题三维状态（授权/操作/验证） | `review-workspace.issueRowsOf()` 只给一个 `status_text` | **缺** |
| 摘要 N=P+F+U+B | `summaryLine()` 给已选/已验证/未通过/局部/待复验 | **部分**：未显式给“未验证 U”，未标 run_id/candidate/轮次 |
| 时态引擎独立设置页 | `renderTemporalSettingsPage()`（view `temporal-settings`）；故事状态页 `ai-board` 只留摘要+入口 | 已具备 |
| 角色紧凑列表 | `renderStoryStateCard()` 的 `<details class="st-character-compact">` 行 | **部分**：无搜索/筛选/分页 |
| 修稿闭环 | `revision-finalize` / `revision-closure` / `revision-semantic-verifier` / `REVISION_AUTO_REPAIR_MAX_ROUNDS=2` | 已具备（上一轮 v1.2.5 硬化） |
| 合并安全 | `mergeReviewDiff()` + 服务端 `/novel/adopt`；`merge-forced` 显式跳过复验 | 已具备（需回归断言） |
| 深链接 | `state.reviewWorkspace` 只存在内存；URL 不带 `chapterId/runId` | **缺** |
| Back/Forward 无副作用 | 视图切换函数只渲染，不调用模型；但无基于 history 的测试 | 需断言 |

## 3. 回归入口

- 离线：`node scripts/ci-offline-checks.mjs`（零计费；依赖隔离实例的套件在受限沙箱会 `spawn EPERM`，需完整权限跑）。
- 前端：`node frontend-test.mjs`（vm + DOM 桩；覆盖 app.js 真实函数）。
- 真实布局：`.p1-baseline/browser-acceptance-v124.mjs`（Edge + CDP；需要运行中的实例，默认 3799）。
- 本轮新增：`.p1-baseline/test-1030-ui-closure.mjs` 与 `.p1-baseline/browser-acceptance-v130.mjs`（多宽度 + 截图）。

## 4. 已保存的改动前证据

- `artifacts/v130/baseline-facts.txt`
- `artifacts/v130/worktree-status.txt`
- `artifacts/v130/sha256-before.txt`
- 基线截图：由 T4 的真实浏览器脚本在**改动后**同时抓取宽/窄屏；改动前的等效数字由
  `browser-acceptance-v124.mjs` 的既有 15 条检查固化在上一轮报告中（本文件不伪造截图）。
