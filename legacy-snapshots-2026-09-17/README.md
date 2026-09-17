# 历史快照归档（legacy snapshots · 2026-09-17）

这个分支**只做一件事：替本地保管几个旧源码快照**。它只有一个提交，**不参与任何构建、不合并进任何分支**，请勿把它当成可用代码。

## 为什么会有这个分支

2026-09-17 清理本地时发现：`novel-studio/data/backup-*` 里有几份旧快照，它们的**内容在任何已推送的提交里都找不到**（用 `git rev-list --objects main refactor/p0-p6` 的可达对象集合逐一比对 blob sha 得出）。也就是说，删掉本地副本就会永久丢失，GitHub 当时并不是它们的备份。

所以先把这 15 个文件推到本分支，GitHub 才真正成为它们的备份，随后才删除本地副本。

## 收录内容与出处

| 归档路径 | 出处（原本地路径） | 时间 | 说明 |
| --- | --- | --- | --- |
| `p0p6-20260915145543/files/` 下 8 个文件 | `data/backup-p0p6-20260915145543/files/` | 2026-09-15 14:55:43 | **AI 内核重构（P0–P6）开始前的源码状态**。其 `server.js` = 205,370 B，既不等于已发布版（`main` 的 189,151 B）也不等于当前分支（225,690 B），属发布后、重构前的中间态 |
| `p0p6-20260915145543/changes.patch` | 同上 | 同上 | 该快照对应的**完整改动补丁**（120 KB） |
| `p0p6-20260915145543/manifest.json` | 同上 | 同上 | 快照清单（含各文件 sha256 与大小） |
| `round3-20260914/` 下 4 个文件 | `data/backup-round3-20260914/` | 2026-09-14 | 第三轮复核时期的 `app.js` / `debug-trace.js` / `harness.js` / `server.js` |
| `p6-20260916100449/harness.js` | `data/backup-p6-20260916100449/` | 2026-09-16 10:04:49 | P6 切换备份里的 `harness.js`（本地那份仍保留，见下） |

合计 15 个文件 / 1056.4 KB。

## 怎么取回

```bash
# 看清单
git ls-tree -r --name-only archive/legacy-snapshots-2026-09-17

# 取回单个文件（例：重构前的 server.js）
git show archive/legacy-snapshots-2026-09-17:legacy-snapshots-2026-09-17/p0p6-20260915145543/files/server.js > server.js.pre-p0p6

# 或把整个归档检出到临时目录
git worktree add --detach /tmp/ns-archive archive/legacy-snapshots-2026-09-17
```

## 明确没有收录的东西（有意为之）

- **数据库备份**（`data/backup-20260903-*`、P6 备份里的 `data/novel.db*`）：含作品正文与 API Key。这是**公开仓库**，一律不上传。
- **P6 回滚备份整体**（`data/backup-p6-20260916100449/`）：`node .p6-cutover/cutover.mjs --rollback <该目录>` 依赖它做一键回滚，因此保留在本地，只把其中那份 `harness.js` 收录进来以备不时之需。
- **`data/recovered/`**：第 107 章审稿相关的脚本与产物，属作品工作文件，不是代码快照。

## 当前可用代码在哪

| 分支 | 内容 |
| --- | --- |
| `refactor/p0-p6` | **最新代码**（AI 内核重构后的版本，含 `ai/`、`.p1-baseline/` 等） |
| `main` | 已发布版本 v0.9.3（重构前） |
| `archive/legacy-snapshots-2026-09-17` | **本分支**：仅历史快照，无可用代码 |
