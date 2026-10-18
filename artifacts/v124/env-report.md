# v1.2.4 P0A · 真实基线冻结报告

> 生成时间：2026-10-18（本轮实施开始前采集）
> 目的：在动任何代码之前，先把"这次改的是哪一份源码、哪一份数据、哪一套既有测试"钉死。
> 纪律：本文件里的每个数字都来自**实际执行**（命令 + 退出码），不是推断。

## 1. 源码基线（唯一升级起点）

| 项 | 值 | 采集方式 |
|---|---|---|
| 仓库 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio` | `Get-Location` |
| 分支 | `Experimental-Version-v1.0`（GitHub 默认分支） | `git status` |
| HEAD SHA | `b4c9502a1abbbfe1c68f496608eaf060d0955eb8` | `git rev-parse HEAD` |
| 最近标签 | `v1.2.3`（指向 `b4c9502`） | `git describe --tags --abbrev=0` |
| `package.json` version | **1.2.3** | `node -p JSON.parse(fs.readFileSync('package.json','utf8')).version` |
| Node 运行时 | v24.19.0（要求 ≥ 22.13） | `node -v` |
| 依赖 | 0 个 npm 依赖（`dependencies` 不存在） | `package.json` |

### 1.1 实施前工作树状态（未提交改动）

```
 M README.zh-CN.md          ← 作者自己的改动，本轮不提交
```

未跟踪文件：作者上传的若干方案 `.md`（`01.md`、`Novel_Studio_v1.2.4_完整优化升级实施方案.md` 等）与本轮交付文档。
**本轮不修改、不删除、不提交作者的未跟踪文档与 `README.zh-CN.md`。**

### 1.2 版本元数据的已知不一致（`VERSION_METADATA_NEEDS_RECONCILIATION`）

- GitHub REST API（`contents/package.json?ref=Experimental-Version-v1.0`）解出的内容为 `"version": "1.2.3"`，
  该 blob 的 sha 为 `95ce156ac4234a821543f47d352832e9cf5c30e1`，对应提交 `b4c9502`。
- 仓库 `About` 描述仍写着 `v1.2.0`（描述文字不会随提交自动更新）。
- 结论：**远端默认分支就是 1.2.3**；页面显示旧版本属于缓存/旧 ref/描述文字，不构成"回退到 1.2.1"的理由。
  本轮按用户指定以 **v1.2.3 为唯一基线**做增量升级。

## 2. 数据备份（P0A 第 3 步）

`data/` 是作者私有库（已 gitignore，**永不提交**）。本轮在改动前后都用 SQLite 一致性备份：

| 项 | 值 |
|---|---|
| 备份文件 | `data/backup-v124-2026-10-18T10-47-48-850Z.db` |
| 大小 | 12,349,440 字节 |
| SHA-256 | `9b9275918dbe257a5a3cf6e8a1c080723af2a20707e9223186366599af090f1b` |
| 方式 | `node:sqlite` 只读打开 + `VACUUM INTO`（**不是**直接复制活动中的 `novel.db`：那样会漏掉 WAL 里未 checkpoint 的事务） |
| 服务状态 | 采集时 Studio 服务在运行（`node.exe` 进程存在，`novel.db-wal` 4.1MB）——只读备份不打断写入 |

> 恢复路径：停服务 → 用备份文件覆盖 `data/novel.db` → 删除 `novel.db-wal` / `novel.db-shm` → 重启。

## 3. 既有测试基线（改动前的真实结果）

| 套件 | 结果 | 退出码 |
|---|---|---|
| `node scripts/ci-offline-checks.mjs` | **通过 61 / 未通过 0**（共 61 条，零计费） | 0 |
| `node frontend-test.mjs` | 当时既有断言全部通过（本轮结束时为 ALL PASS，见 §5） | 0 |

`ci-offline-checks` 覆盖：语法/UTF-8、叙事修稿 11 套件、阶段映射、宿主契约、时态迁移、费用闸门等。
**本轮不删除、不跳过、不弱化任何既有检查**；新增能力另加断言（见 §5）。

## 4. 本轮要改的能力盘点（避免重复实现）

| 已有模块 | 本机现状 | v1.2.4 处理 |
|---|---|---|
| `public/revision-findings.js` | finding.v2 契约 | 复用，不重写 |
| `public/revision-plan.js` | 多热点授权编译 | 复用 |
| `public/revision-patch.js` | span 级补丁 + 安全门禁 + 组合核验 | 复用（只补 extra 记账字段） |
| `public/revision-semantic-verifier.js` | 确定性层 + 注入式语义层 | **增强**：硬事实/软判断分级、`must_contain`、`min_chars`、分段重建证明 |
| `public/revision-closure.js` | 分层状态与预算 | 复用 |
| `public/app.js` → `refineByChecklist` | 单请求路径有 semantic/closure；分段路径只有计数 | **统一出口**（`revision-finalize.js`） |
| `public/app.js` → `showReviewDiff` | 大弹窗 | 保留为回滚路径；新增独立工作区视图 |
| `public/app.js` → `renderStoryStatePage` | 状态 + 时态 + 影响 + 重建 + 回填同页堆叠 | 拆分：设置页独立 |

## 5. 本轮结束时的验证结果（实施后回填）

| 套件 | 结果 |
|---|---|
| `.p1-baseline/test-1024-chapter-fixtures.mjs` | 见最终报告（两轮 A/B 夹具） |
| `.p1-baseline/test-1025-finalize.mjs` | 见最终报告（终验出口/覆盖完备/工作区/时态设置） |
| `node frontend-test.mjs` | 见最终报告（含 v1.2.4 新增断言） |
| `node scripts/ci-offline-checks.mjs` | 见最终报告 |
| `node .p1-baseline/verify-phase-map.mjs` / `check-utf8.mjs` | 见最终报告 |

> 本文件的 §5 由 `docs/v1.2.4-review-workspace.md` 的验收表给出最终数字（避免两处各写一遍、漂移）。
