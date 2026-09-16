# P6 切换手册（一次性切换 · 待批准执行）

# 阶段：P6　状态：**前置全部就绪、彩排已通过，等待你批准执行窗口**
> 本文是执行清单，不是执行记录——**截至目前主实例 3737 与真实库仍未被动过**。
>
> S1（备份）与 S3（翻转）已工具化为 `.p6-cutover/cutover.mjs`：
> 预检 → 彩排 → 令牌确认 → 执行 → 可回滚。彩排 10/10、离线单测 32/32 通过；
> 真实切换**未执行**（`harness.js` 仍是 `pre-cutover`）。详见 `.p6-cutover/README.md`。

---

## 一、切换要做什么

只有一件事：**把 `harness.js` 的默认 dsh profile 从 `headless` 翻到 `novel`**。

外加一个不可回避的副作用：主库首次启动时会**新增一张表** `ai_eval_events`
（`CREATE TABLE IF NOT EXISTS`，向后兼容的增量迁移，**不修改任何既有数据**）。

---

## 二、前置状态（全部已完成并验证）

> ⚠️ **执行前必读（本轮实测的教训）**：`harness.js` → `logger.js`、以及 `db.js` 的模块顶层，
> 都会按 `NOVELSTUDIO_DATA_DIR` 解析数据目录，**未设置时默认就是项目里的 `data/`**。
> 也就是说：**任何 import `harness.js` 或 `db.js` 的探测脚本，只要不设这个环境变量，
> 就会写进真实数据目录**（`db.js` 甚至是读写打开 + 可能触发迁移）。
> 所有探测脚本必须先把 `NOVELSTUDIO_DATA_DIR` 指向临时目录——
> `.p0-recon/verify-harness-profile.mjs` 已如此处理。详见 `.p0-recon/README.md` 环境陷阱 0。

| 前置 | 验证方式 | 状态 |
|---|---|---|
| `novel` profile 与 headless 功能等价 | 83 行组合树逐条对账，17 条 disable 全部真实生效 | ✓ P0 |
| bundle 化 + profile 接线器 | 组合树等价 + 真机启动冒烟 | ✓ P0 |
| 迁移工具能处理「旧区块是唯一内容」的情况 | **P6 彩排实测**（见 §三） | ✓ 彩排修复 |
| `NOVELSTUDIO_DSH_PROFILE` 在真实 spawn 路径生效 | 真机任务：不存在的 profile 快速失败、`novel` 走到 LLM 调用 | ✓ P6 彩排 |
| 上下文契约与唯一装配器 | I1/I2/I3/I7 不变量 + 基线逐字节对照 | ✓ P1/P2 |
| 凡裁剪必可查回 | 9 个被裁层端到端实测可取回 | ✓ P3 |
| 模型策略单点化 | 0 处绕过策略 | ✓ P4 |
| 效果埋点 | 表 + 端点 + 前端挂钩实测 | ✓ P5 |

---

## 三、彩排结果（在克隆 profile 上做，未碰生产）

### 彩排 1：headless → bundle 迁移

流程：把生产 `headless` **完整克隆**成 `headless-sim` → 对克隆执行接线 → 组合对账 → 删除克隆。

**彩排抓到一个会让 P6 直接失败的 bug**：旧区块被移除后，`cordis.patch.yml` 只剩注释、
**没有 `[]`**，不再是合法的顶层 YAML 数组。dsh 启动报
`overlay ... must be a top-level YAML array of loader patch entries`。
而 headless 的 patch 里**只有**这个区块——**这是 P6 的必经路径，不彩排就会当场翻车**。
已修复，并给安装器加了写回自检（迁移后必须仍是合法数组，否则中止并保留备份）。

修复后复跑：

| 对照 | 结果 |
|---|---|
| 迁移后的 headless-sim vs `novel`（都是 bundle 制） | **83 行完全等价**（顺序/集合/disabled/正文全一致） |
| 迁移后的 headless-sim vs 旧 headless | 只差 2 处**预期**差异：`system-prompt`（新人设）、`novel-tools`（包名） |
| 迁移后声明的 17 条 disable | **全部真实生效**，0 处静默失效 |

### 彩排 2：profile 参数在真实 spawn 路径上生效

```
✓ NOVELSTUDIO_DSH_PROFILE=no-such-profile-xyz  →  830ms 失败
      原因：dsh: profile "no-such-profile-xyz" does not exist
✓ NOVELSTUDIO_DSH_PROFILE=novel                →  41.5s，走到 LLM 调用
      原因：dsh: TRANSPORT: DeepSeek API request to http://127.0.0.1:1 failed
```

零成本（LLM 端点指向本机死端口，不出网）。**这条证明 P6 的翻转不是静默无效的**——
`dump-config` 证明不了它，它只组合配置、不启动任务。

---

## 四、执行步骤

> **已工具化**：S1 与 S3 由 `.p6-cutover/cutover.mjs` 执行（预检 → 彩排 → 令牌确认 → 执行 → 可回滚）。
> 手工分步最易错配——本会话的事故就是手工编排把实例配错了，所以 P6 也按同一纪律收进脚本。
> 下面保留手工步骤作为**含义说明**；实际操作请用脚本（见 §四·零）。

### 四·零 · 推荐操作方式

```powershell
node .p6-cutover/cutover.mjs --check                 # 只读预检：列出将要改动的每一处 + 给出确认令牌
node .p6-cutover/cutover.mjs --rehearse              # 彩排：全在副本上做，断言真实产物零改动
# 停主实例（S2，脚本刻意不做进程动作）
node .p6-cutover/cutover.mjs --execute --confirm=P6-CUTOVER-xxxxxxxx
# 重启主实例 → 跑 S4 的四条验证 → 视需要做一次真实冒烟（需单独许可）
node .p6-cutover/cutover.mjs --rollback data/backup-p6-<stamp>   # 需要回滚时
```

脚本会拒绝执行的情况：锚点漂移（源码变了）、令牌不符、已是 post-cutover。
细节与阴性对照见 `.p6-cutover/README.md`。

### S1 · 备份（必做，全部可逆）

```powershell
$stamp = Get-Date -Format yyyyMMdd-HHmmss
# 1) 数据库三件套（必须带 WAL，否则丢数据）
New-Item -ItemType Directory -Force "data\backup-p6-$stamp" | Out-Null
Copy-Item data\novel.db,data\novel.db-wal,data\novel.db-shm "data\backup-p6-$stamp\"
# 2) dsh 侧
Copy-Item "$env:USERPROFILE\.dsh\profiles\headless" "$env:USERPROFILE\.dsh\profiles\headless-precutover-$stamp" -Recurse
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml" "$env:USERPROFILE\.dsh\settings.yaml.p6-$stamp"
# 3) 代码侧
git rev-parse HEAD   # 记下这个 commit
```

> ⚠️ **脚本刻意不复制 profile 的 `node_modules`**：那里有 junction，
> 递归复制有跟随目标、把内容复制出来的风险；该目录可由 `install-profile.mjs` 重装，可复现。
> 脚本改为只备份 profile 的文本产物（`cordis.patch.yml` / `package.json`）+ `harness.js` + 数据库三件套，
> 并逐文件校验哈希、写 `manifest.json` 供回滚核对。

### S2 · 停主实例

若 3737 在运行，先关闭（`start-novel-studio.cmd` 启动的独立控制台窗口）。

### S3 · 翻转默认 profile

`harness.js` 中 `DSH_PROFILE` 的默认值：

```js
if (!raw) return 'headless';   →   if (!raw) return 'novel';
```

并同步更新该常量上方的注释（把「默认仍是 headless、切换是 P6 的动作」改为已切换 + 回滚方式）。

### S4 · 重启并验证

```powershell
# 主实例（建议带 NOVELSTUDIO_OV_AUTOINDEX=0：D3 是"先只重建 work#2"，
# 别让启动顺带把记忆库索引范围放大）
#   $env:NOVELSTUDIO_OV_AUTOINDEX='0'; node server.js

# ① 自设死端口（脚本内部已设 DEEPSEEK_BASE_URL=http://127.0.0.1:1），零计费：
#    已证实该变量对 dsh 生效（黑洞端口实测收到 dsh 子进程的 POST /chat/completions）
node .p0-recon\verify-harness-profile.mjs novel
# ② 工具面 / 版本
node .p1-baseline\verify-plugin-tools.mjs
# ③ 策略无绕过
node .p1-baseline\verify-ai-branches.mjs
# ④ 数据库：确认 ai_eval_events 已建、既有数据条数未变
node .p1-baseline\survey.mjs data/novel.db
# ⑤ 真实写作冒烟（**会计费，需显式授权**；用临时作品做、验完即删）
$env:NOVELSTUDIO_SMOKE_ALLOW_BILLING='1'
node .p6-cutover/smoke.mjs --base http://127.0.0.1:3737
```

**已执行（2026-09-16）**：①–⑤ 全部通过。

- ① 结论「profile 参数在真实 spawn 路径上生效」；审计口径：**零计费**
  （拿到的是 6 个错误结束块 + 5 次重试，模型文本 0 字）。
- ② 15 个工具 / 0.8.2 一致；③ 0 处绕过。
- ④ `ai_eval_events` 已建（26 张表）；既有 14 项行数**逐项未变**。
- ⑤ **冒烟 7/7**：临时作品 → `/api/harness/run` → 作业 `done` → 产出 135 字正文 → 临时作品已删。
  会话转录证明系统提示词含创作人设（`执行小说创作任务的 AI`，2318 字）⇒ 走的确实是 `novel` profile。
  计费：**1 次真实调用、模型文本 367 字**。真实作品仍为 2 部 / 7 章，一行未变。

然后启动主实例，做**一次真实写作冒烟**（这一步会产生 API 费用，**需你单独许可**）。

---

## 五、回滚

| 层次 | 动作 | 耗时 |
|---|---|---|
| 最快 | 设环境变量 `NOVELSTUDIO_DSH_PROFILE=headless` 并重启 | 一次重启 |
| 彻底 | `git revert` 那一行改动 + 重启 | 一次重启 |
| 数据库 | **不需要回滚**：只新增了一张空表，既有数据未被修改 | — |
| dsh 侧 | 生产 `headless` **全程未动**，回滚位始终可用 | — |

**建议：不要迁移生产 `headless`**。回滚位的价值在于「回到已知可用的旧状态」；
迁移它会削弱这一点。代价是回滚期间工具集退回旧的 13 个（新工具不可用），
这是可接受的降级。若你希望迁移，请先保留一份 untouched 的
`headless-precutover-<stamp>` 克隆。

---

## 六、两个待你决定的事项

> 📋 **五项待决事项已汇总成一页**：`docs/pending-decisions.md`（含提交、执行窗口、索引重建、
> 吞吐对齐、日志噪声；每项列现状/选项/影响代价/建议）。下面两项是其中与 P6 直接相关的。

1. **执行窗口**：P6 需要停一次主实例（约 1 分钟）+ 一次真实冒烟。
   在你确认之前，切换**不会执行**。
2. **P3-d 记忆库索引重建**：`work#2`（你在写的书）以及另外 78 个作品的记忆库目录
   只剩骨架，语义召回层一直是空的。重建是幂等写、无 API 费用，但**写的是你的生产记忆库**。
   详见 `docs/p3-retrieval-verification.md` §4.1 与 §五。

---

## 七、复现彩排

```powershell
# 迁移彩排（在克隆上，不碰生产）
Copy-Item "$env:USERPROFILE\.dsh\profiles\headless" "$env:USERPROFILE\.dsh\profiles\headless-sim" -Recurse
node harness-plugins/novel-writing/install-profile.mjs --profile headless-sim
# 组合对账（工作目录 = deepseek-harness）
node --import tsx/esm apps/cli/src/bin.ts --profile headless-sim --dump-config > .p0-recon/headless-sim.p6.txt
node .p0-recon/compare-composed.mjs .p0-recon/novel.p3.txt .p0-recon/headless-sim.p6.txt
# 清理（先删 junction 再删目录）
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\headless-sim\node_modules\novel-writing"
Remove-Item "$env:USERPROFILE\.dsh\profiles\headless-sim" -Recurse -Force

# spawn 路径验证（**不是零成本**：它会真的调起 dsh，可能产生真实计费调用）
# 先按 §八 搭好隔离环境，再显式授权：
#   $env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'
node .p0-recon/verify-harness-profile.mjs
```

---

## 八、隔离环境与「会花钱的检查」（2026-09-15 事故后新增）

### 事故

曾假定「把 `DEEPSEEK_BASE_URL` 指向死端口 = 零成本」，据此跑了多轮「零成本」验证，
**实际产生了未经批准的真实 LLM 调用**，其中一次还写进了生产 OpenViking 记忆库。
事后核对：那一轮 5 次调用**全部来自闸门项打到不受控的实例**（该实例由旧后台作业启动，
命令行里没有隔离变量，且是旧代码）。

补测已证实：**`DEEPSEEK_BASE_URL` 本身是生效的**——把它指向本机黑洞端口后，
黑洞日志收到了 dsh 子进程发来的 `POST /chat/completions`（带 `host: 127.0.0.1:<黑洞端口>`），
且跑后审计确认零计费调用。所以隔离手法可用，关键是**配方要一次配齐、且要能自证**。

### 一条命令搭好可证明的隔离环境

```powershell
node .p1-baseline/gate-env.mjs      # 前台：黑洞 LLM 端点 + 隔离实例，并打印授权命令
node .p1-baseline/gate-env.mjs --stop   # 收工（清 marker；Ctrl+C 亦可）
```

配方六项，各挡一类污染：

| 环境变量 | 挡住的污染 |
|---|---|
| `NOVELSTUDIO_DATA_DIR=<临时目录>` | 数据库（`logger.js`/`db.js` 都按它解析） |
| `PORT=<空闲端口>` | 实例错配；harness 子进程据此回连本实例 |
| `NOVELSTUDIO_OV_DISABLED=1` | 服务端 OpenViking 集成（不写 `ov_uri` 记忆目录） |
| `NOVELSTUDIO_OPENVIKING_PEER_ID=<测试 peer>` | dsh 任务的记忆写入落进生产 peer |
| `DEEPSEEK_BASE_URL=http://127.0.0.1:<黑洞端口>` | LLM 出海；**黑洞连接即隔离证明** |
| `DEEPSEEK_API_KEY=<哨兵值>` | 兜底（未实测：万一 baseURL 未生效，请求应 401 而非计费） |

### 套件的行为变化

`node .p1-baseline/verify-all.mjs` **默认不跑**任何会创建 harness 任务或调起 dsh 的检查：

| 检查 | 授权条件 |
|---|---|
| harness 并发闸门（会建真实任务） | `--gate-base` **且** `NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1` |
| dsh spawn 路径（会真的 spawn dsh） | `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`（该检查自设死端口，本身零计费；要求授权是因为它依赖"环境变量被 honored"这一外部假设，且会真跑约 40s） |

末尾新增**套件总闸**：本次窗口内检出任何真实 LLM 调用即判未通过——
把「悄悄花钱」变成红灯。事故经过与硬约束详见 `.p1-baseline/README.md` §六。
