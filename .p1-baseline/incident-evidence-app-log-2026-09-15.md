# 事故证据：真实数据目录里被写进的 9 行 harness 日志

> 归档于 2026-09-16（D5 决议：**删掉原文件，但先把内容转存到这里**）。
> 原始字节：`incident-evidence-app-log-2026-09-15.raw.txt`（7011 字节，SHA256 `0889CED17BB18797…`，
> 与原文件逐字节一致，副本已校验）。
> 原路径：`data/logs/app-2026-09-15.log`（**已删除**）。

## 一、这是什么

9 行 harness 任务日志，写进了**真实数据目录** `data/logs/`。内容是
`verify-harness-profile.mjs` 在跑 `no-such-profile-xyz` 与 `novel` 两个 profile 时的任务起止与失败：

| # | 时间（UTC） | 内容 |
|---|---|---|
| 1–2 | 12:48:22–23 | `no-such-profile-xyz`：`task_start` → `harness_exit`（765ms，profile 解析失败） |
| 3 | 12:49:00 | `novel`：`TRANSPORT: DeepSeek API request to http://127.0.0.1:1 failed`（36840ms，死端口，零计费） |
| 4–5 | 12:49:09–10 | `no-such-profile-xyz` 第二轮（823ms） |
| 6 | 12:49:50 | `novel` 第二轮（40637ms，死端口） |
| 7–8 | 12:49:54–55 | `no-such-profile-xyz` 第三轮（828ms） |
| 9 | 12:50:37 | `novel` 第三轮（41539ms，死端口） |

判据（来自日志自身，不靠推断）：`code_file` 字段是
`.../harness.js?profile=novel` 与 `.../harness.js?profile=no-such-profile-xyz`——
带查询串的动态 import 正是 `verify-harness-profile.mjs` 第 36 行的写法。

**未证实**：具体是哪一次命令调用造成的。三次成对出现，与 P6 彩排期间重复跑该验证工具的节奏一致，
但当时的 shell 环境已无法回溯。

## 二、为什么它值得留档

它证明了一件事：**隔离护栏本身也曾漏过**。`verify-harness-profile.mjs` 现在在第 19 行
把 `NOVELSTUDIO_DATA_DIR` 指向 `.p0-recon/scratch-data`，但**加护栏之前**，
它 import `harness.js` → `logger.js` 就按默认值写进了项目的 `data/`——也就是真实数据目录。

这与「环境陷阱 0」是同一条：**import 即污染**。任何 import `harness.js` / `db.js` 的脚本，
只要不在 import 之前设好数据目录，就会写进真实目录。

## 三、护栏现在确实生效（本文件归档当天实测）

```powershell
node .p0-recon/verify-harness-profile.mjs no-such-profile-xyz   # 只用不存在的 profile，快速失败、零 API
```

结果：

| 观察对象 | 实验前 | 实验后 |
|---|---|---|
| `data/logs/app-2026-09-15.log` | 7011B，mtime 20:50:37 | **完全未变**（仍 7011B / 20:50:37） |
| `.p0-recon/scratch-data/logs/` | 只有 `app-2026-09-15.log` | **新增** `app-2026-09-16.log`（1386B） |

→ 日志落到了临时目录，真实目录没有再被写。所以删除原文件是安全的：**它不会再生**。

## 四、真实库内容未受影响

`data/logs/` 只是文件日志；真实数据库的完整性另行核验过
（`node .p1-baseline/diff-real-db.mjs`：真实库没有任何一行在副本中缺失，
作品/章节逐项一致）。
