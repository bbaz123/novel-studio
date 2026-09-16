# .p6-cutover —— P6 一次性切换的受控执行器

配套文档：`docs/p6-cutover-runbook.md`（切换手册本体）。

## 为什么要有这个目录

P6 的**动作**只有一行：`harness.js` 里默认 dsh profile 从 `headless` 翻到 `novel`。
但围绕它的**手工分步流程**才是风险所在——本会话已经吃过一次同类亏：
「先起实例、再设环境变量、再跑测试」这种手工编排错配了实例，产生了未经批准的真实调用。

所以 P6 也按同一套纪律工具化：**预检 → 彩排 → 显式确认 → 执行 → 可回滚**，
每一步都有机器可核对的判据，而不是靠"我记得做对了"。

## 四个模式

```powershell
node .p6-cutover/cutover.mjs --check      # 只读预检：列出将要改动的每一处 + 给出确认令牌
node .p6-cutover/cutover.mjs --rehearse   # 全流程彩排：文件 I/O 全在副本上，最后断言真实产物零改动
node .p6-cutover/cutover.mjs --execute --confirm=P6-CUTOVER-xxxxxxxx   # 真实执行（需令牌）
node .p6-cutover/cutover.mjs --rollback data/backup-p6-<stamp>         # 回滚代码侧
node .p6-cutover/test-cutover.mjs         # 离线单测（零成本，套件默认跑）
```

## 设计要点

| 要点 | 为什么 |
|---|---|
| 确认令牌由**改动内容**派生（`--check` 打印，`--execute` 必须原样给出） | 不看清单就拿不到令牌，杜绝"照着旧命令盲跑" |
| 锚点是**带上下文的精确串**，替换数必须正好 1 | 源码一漂移就**失败**而不是静默无效；`test-cutover.mjs` 每次都与真实源码对账 |
| 锚点自动适配 CRLF/LF | 本仓库源码是 CRLF，用 `\n` 拼锚点会全部匹配不上（第一次预检就栽在这） |
| 彩排全程 `try/finally`，安全网在 `finally` 里核对真实产物哈希 | 阴性对照实测：变异后流程崩在断言之前，安全网若不放在 finally 就**根本没跑** |
| 备份清单**不含** profile 的 `node_modules` | 那里面有 junction，递归复制有跟随目标的风险；该目录可由 `install-profile.mjs` 重装 |

## 它刻意**不做**的三件事

1. **不停止/重启主实例** —— 进程动作留给操作者；
2. **不发起真实写作冒烟** —— 会产生 API 费用，需单独许可；
3. **不复制 profile 的 `node_modules`** —— 理由见上表。

## 已验证（本目录的收尾状态）

```
--check     ✓ 预检通过（5 处锚点各命中 1 次；profile/bundles/接线/主库/端口/可写性全部核对）
--rehearse  ✓ 10/10 通过：备份逐文件校验哈希、副本翻转、从备份还原逐字节一致、
              幂等拒绝、真实产物（harness.js / novel.db）哈希零改动
test-cutover ✓ 32/32 通过：锚点对账、CRLF/LF、漂移拒绝、幂等、四态识别、令牌派生、备份清单、
              未污染自检
```

**真实切换尚未执行**：`harness.js` 仍是 `pre-cutover`（`if (!raw) return 'headless';`）。
执行窗口需要你批准；真实冒烟会产生 API 费用，需单独许可。

## 阴性对照（做了哪些"应该失败"的实验）

| 变异 | 期望 | 实测 |
|---|---|---|
| 锚点文本改错（模拟源码漂移） | 彩排失败 | ✓ `✗ 锚点未命中：默认 profile（无环境变量时）` |
| 彩排写入真实 `harness.js`（而非副本） | 安全网报出真实产物被改 | ✓ `✗ 真实产物未被彩排改动：harness.js`（异常路径也生效） |

两次实验后 `harness.js` 均按快照逐字节还原并核对 SHA256
（`AF703BD399BDC8D1C2104FDD14F5D3356776092C714ABAE9F7C5AF06959F9EE2`）。

## 全量快照与回滚（`snapshot.mjs`）

**为什么需要**：P0–P6 全程在工作区进行、**没有提交**——HEAD 仍是重构前的 `ca1cdf9`（v0.9.3）。
也就是说 13 个已跟踪文件带着 700+ 行改动挂在工作区，另有 81 个新文件未跟踪。
一次 `git checkout -- .` / `git stash` / `git reset --hard` 就会静默毁掉已跟踪的那部分，
而新文件还在 → 工作区变成"半重构"状态，既跑不起来也说不清丢了什么。

```powershell
node .p6-cutover/snapshot.mjs --create                 # 生成 data/backup-p0p6-<stamp>/
node .p6-cutover/snapshot.mjs --verify <快照目录>       # 在 HEAD 克隆树上还原并逐文件比对哈希
node .p6-cutover/test-snapshot.mjs                     # 离线单测（零成本，套件默认跑）
```

**快照里有什么**：`changes.patch`（已跟踪改动，供阅读/`git apply`）、
`files/`（新增 + 修改文件的**整文件副本**）、`manifest.json`（逐文件 sha256 + 被排除项的指纹）。

**为什么需要整文件副本**：本仓库 `core.autocrlf` 生效，`git apply` 会把 CRLF 归一成 LF，
`server.js` / `harness.js` / `db.js` 还原后**行尾会变**（验证器实测 91/94）。
所以补丁用于 review，**字节级还原以 `files/` 为准**。

**已实测**（三条对照）：

| 场景 | 结果 |
|---|---|
| 正向：工作区未变 | ✓ 94/94 哈希一致，且"无快照未覆盖的新文件" |
| 阴性 A：快照生成后又改了代码 | ✓ 抓出 `1 处不一致`（首次就是被这条抓到的） |
| 阴性 B：新增了快照未覆盖的源码文件 | ✓ 报「快照已过期」 |
| 阴性 C：删掉一个快照覆盖的文件 | ✓ 抓出 `93/94` |

**排除规则也要被测试**：备份工具最危险的失败模式是**排除过宽**——静默漏掉源码却仍然报绿。
`test-snapshot.mjs`（50 项）同时钉「该排除的排除」（尤其 `data/` 里的数据库与 API Key）
与「该包含的包含」；阴性对照：把排除前缀放宽成 `.p1-baseline/` → 测试失败 2 项。

> ⚠️ **快照只对生成那一刻成立**。改完代码要重新 `--create`，否则 `--verify` 会（正确地）报过期。

## 本机陷阱（本目录踩到的）

- **以 `.` 结尾的目录名**：早期时间戳用了 `slice(0,15)`，把毫秒前的点带进来，生成
  `20260915140632.` 这样的目录。Win32 API 会悄悄剥掉尾点，导致 `Remove-Item` 报
  "cannot find the file specified"。删它必须走 `\\?\` 扩展路径：
  `[System.IO.Directory]::Delete("\\?\<绝对路径>", $true)`。已改时间戳为 14 位。
