# v1.2.5 修稿质量闭环硬化：S0 现场保护与基线

> 本文件由本次执行在**改动任何源码之前**生成，记录可回滚点与不可变事实。
> 采集时间：2026-10-18（本机）；采集方式：只读命令 + 哈希快照。

## 1. 运行基线

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows（win32 x64） |
| Node | v24.19.0 |
| package.json version | 1.2.4（本机实际；方案写的 v1.2.3 是文档基线，按约定**不升级/不 pull**） |
| 分支 | Experimental-Version-v1.0 |
| HEAD | 90782668b02641fc083e794b0db4793d6459915e |
| HEAD 时间 | 2026-10-18 21:14:10 +0800 |
| 工作树 | 25 项改动/未跟踪（见 `git-status-before.txt`；其中仅 `README.zh-CN.md` 是被跟踪文件的修改，其余为作者本地文档） |
| 数据目录 | `data/`（185M；`data/novel.db` 12M，另有多份历史备份 db） |

> 版本边界：本次按约定**不**执行 `git pull / checkout / rebase / 升级`，也不自动覆盖作者本地修改。
> 生产数据目录未被写入或迁移；本轮只改源码、测试与文档。

## 2. 回滚点

- 代码回滚：`git checkout -- <file>`，基线哈希见 `sha256-before.txt`。
- 新增文件回滚：删除 `.p1-baseline/test-1029-i03-i04-closure.mjs`、`public/revision-trace.js`、`artifacts/v125/`。
- 数据回滚：本轮未触碰 `data/`；如需要演练恢复，使用既有 `data/backup-v124-2026-10-18T10-47-48-850Z.db`（12M，与当前库同量级）。
- 工作树中作者既有改动（如 `README.zh-CN.md`）不在本轮回滚范围内，保留原样。

## 3. 基线验证（改动前）

```text
node -v                                  -> v24.19.0
node -p "process.platform+' '+process.arch" -> win32 x64
node -p "require('./package.json').version" -> 1.2.4
git rev-parse HEAD                       -> 9078266...
git branch --show-current                -> Experimental-Version-v1.0
```

改动前源码哈希（用于证明"我只改了我声明的文件"）：见 `sha256-before.txt`。

## 4. 隔离与费用

- 全部回归断言离线运行，注入 fixture 的模型输出，**零计费**。
- 不启动新的生产实例；不调用真实 LLM；不写 `data/`。
- 若要跑需要隔离实例的既有套件，在受限沙箱里子进程管道可能被拒（EPERM），
  如实记环境阻断，不把"没跑"记成通过。
