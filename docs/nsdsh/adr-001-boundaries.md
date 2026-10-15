# ADR-001 · NSDSH 改造边界与授权范围

- 状态：**已采纳**（2026-10-15，作者在计划评审时选定）
- 适用：《Novel Studio × DSH 架构优化实施计划》全部阶段 S00–S18
- 关联：`docs/nsdsh/baseline.md`、`docs/nsdsh/PLAN.md`

---

## 1. 背景

方案稿建议"把 DSH 源码放进小说工坊仓库、按需裁剪"。这件事同时涉及三件容易被混为一谈的事：

| 对象 | 说明 |
|---|---|
| 正在执行本任务的 DSH 安装 | 本会话的宿主，位于全局 npm 目录；**它是执行器，不是被改造对象** |
| 上游源码基线 | 需要一个固定、可复现、可重放补丁的版本，供内置运行时使用 |
| 分发给作者的运行时 | 从允许清单构建、按实际传递依赖裁剪的产物 |

把三者混在一起，最典型的后果是"一边运行编码执行器，一边删掉它自己的依赖"。

## 2. 决策

### D-1 允许修改的范围

1. 本仓库（`bbaz123/novel-studio`）的全部业务代码、文档、脚本、测试与插件：`server.js`、`db.js`、
   `harness.js`、`ai/`、`public/`、`harness-plugins/novel-writing/`、`docs/`、`scripts/`、`tests/`、
   `.p1-baseline/`。
2. **本仓库内的上游镜像**：`third_party/deepseek-harness/`（S11 新建）。
   它是一份**固定提交的源码副本**，本项目可在其上打小而有说明的补丁；
   它可以删除重建（回滚 = 删目录），但不允许"就地跟踪 master"。

### D-2 明确不允许修改的范围

1. **正在执行本任务的 DSH 安装**：`C:\Users\a1941\AppData\Roaming\npm-global\node_modules\@deepseek-ai\dsh`。
2. **用户全局 DSH 配置**：`~/.dsh`（含 `settings.yaml`、`profiles/`、credentials）。
   小说任务使用自带隔离 home（`NOVELSTUDIO_DSH_HOME`，默认 `~/.dsh-novel`），不得把用户全局 home 的
   patch 无意带进嵌入运行时。
3. **同级源码 checkout**：`..\deepseek-harness`（当前 `7e06df2` / 0.1.7-rc.1）。
   它只作为**只读参照与固定提交来源**，不修改、不切换分支、不 `pull`。
4. **作者私有数据**：`data/`（`novel.db` 含 API Key 与全部正文、`-wal`/`-shm`、日志、备份）。
   - 任何测试必须走临时 `NOVELSTUDIO_DATA_DIR` 或 `scripts/ci-isolated-run.mjs`。
   - 迁移演练只在**真实库的拷贝**上进行（沿用 `data/backup-*` 规范）。
   - 正式迁移与真实作品切换**必须由作者显式确认**后执行；编码代理不擅自执行。
5. **不撤销作者未提交的改动**（当前为 `README.zh-CN.md`）：不 `checkout`、不 `reset`、不 `stash`、
   不强制推送。

### D-3 固定上游基线取哪一条线

- 取 **`7e06df28146c8f9b14e6185d1cdb325f6b05951b`（`@deepseek-ai/dsh-root@0.1.7-rc.1`）**。
- 理由：`ai/task-settings.mjs` 的文件头记录本仓库的 DSH 集成是"2026-09-24 迁移到 dsh 0.1.7"，
  `harness.js` 的解析链在本机命中的也是这条 checkout。**0.1.7 是现有集成真正面向的那条线。**
- 方案稿记录的 `0.2.1-alpha.2` 与全局安装的 `0.2.0-rc.2` 都是**另一条线**。升级到 0.2.x 属于
  独立的一次升级试验，**不得**与状态可靠性改造互相绑架。
- 若 S11 执行时该 commit 无法获取：记录新 commit、在 `docs/nsdsh/runtime-compatibility.md` 说明差异，
  **不静默跟随 master**。

### D-4 文档与公开范围

- 原始方案稿 `novel-studio-dsh-optimization-plan.md` 按**作者任务书**处理：加入 `.gitignore`（文件保留在磁盘），
  不推送公开仓库。沿用 `修复.md` / `修改方案.md` 的先例。
- 仓库内保留的是本项目自己写的 `docs/nsdsh/*`（`PLAN.md`、`STATUS.md`、`baseline.md`、
  `adr-001-boundaries.md`、`stages.json` 及后续 runbook）。
- `.nsdsh/`（原始阶段报告与日志）加入 `.gitignore` 与快照排除清单，避免把隔离库副本推上公开仓库。

## 3. 与本地规则冲突时的处置

- 本 ADR 与 `AGENTS.md`（全局/项目级）**不冲突**：全局规则要求"修改前确认、修改后验证、不擅自扩散范围"，
  与本 ADR 一致。
- 若执行中发现某条本地规则与本 ADR 存在**未解决冲突**：**记录为阻断点并报告**，
  不得为了推进而偷偷删除或绕过规则。

## 4. 后果

- 正向：编码执行器与待裁剪运行时物理分离；上游可追踪、可重放补丁；作者数据与全局配置零污染。
- 代价：`third_party/deepseek-harness/` 会显著增大公开仓库体积（作者已确认接受）；
  构建需在 vendor 树内联网安装（属于显式构建前置，与 `--offline` 测试分离）。
