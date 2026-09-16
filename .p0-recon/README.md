# .p0-recon —— P0 专用运行时：侦察与验收证据

本目录是 **P0 阶段（建立专用 dsh profile `novel`）** 的证据与工具目录。
P0 收尾时应把对账工具固化进测试套件、并清理本目录中的快照。

## P0 目标与结论

**目标**：把 novel-studio 的 AI 创作内核从共享的 `headless` profile 迁到一个专用
profile，使其与 GUI 及其它 dsh 用途解耦；同时把插件从「安装脚本做区块合并 + 复制
副本」升级为标准 dsh bundle。

**结论：P0 达成**（线上行为未变——`harness.js` 默认仍是 `headless`，切换是 P6 的
一次性动作；专用 profile 通过 `NOVELSTUDIO_DSH_PROFILE=novel` 启用）。

## 验收证据链（五条，全部可复现）

### 0. **线路层**：内核真的进了发出去的请求（2026-09-15 晚补）

前四条验的都是「组合层 / spawn 层」——组合进去 ≠ 进了请求。第五条把 dsh 子进程**真正发出去的
请求体**截下来看（`capture-dsh-request.mjs`：黑洞端点接收、永响应，`AbortSignal` 一拿到就收工）：

```
捕获 31306 字节　POST /chat/completions HTTP/1.1（发往黑洞端点）
  ✓ 清单里的 15 个 novel_* 工具都在请求体里
  ✓ 请求体里有 `"tools"` 键　　　　　　← 排除「人设只是提了一嘴工具名」的假象
  ✓ 请求体里有 JSON Schema 的 `"parameters"`
  ✓ 工具定义条数 ≥ 清单条数　实测 22 条（15 novel_* + 7 通用工具）
  ✓ 创作人设「执行小说创作任务的 AI」在请求体里
  ✓ 零真实计费调用（跑后审计）
```

阴性对照：profile 换成一个不存在的名字 → 任务在 `profile.ts:379` 失败，
**黑洞端零字节**（证明"抓到了东西"不是工具乱抓）。

> 这条补上了一个真实缺口：此前「把 AI 内核迁上去」只能证到"被组合进去了"，
> 没有人看过**模型实际收到的请求**里到底有没有那 15 个工具。

### 1. 组合树等价

`novel` profile 与 `headless` profile 的组合树 **83 行逐条等价**：条目集合、顺序、
`disabled` 标志、归一化正文全部一致。唯一差异是预期的 `name` 字段
（`./novel-tools.mjs` → 包名 `novel-writing`）。

### 2. 声明的 disable 全部真实生效（无静默失效）

patch 声明 17 条 disable，组合树实际 19 条 disabled
（多出的 `hmr`、`skill-badge` 来自基础 bundle 自带）。`--check-disables` 结论：
**声明但未生效 0 条，条目不存在 0 条**。

> 为什么单列这一项：若 patch 里的 id 在组合树中不存在，dsh 不报错——两边会
> 「同样地不生效」，**等价对账查不出这类静默失效**，必须单独校验。

### 3. bundle 在启动时确实被解析（含证伪对照）

- **正向**：`--profile novel` 启动一个真实任务（LLM 端点指向死端口）→ 插件树完整
  挂载、流程一路走到 LLM 调用才失败，错误为 `TRANSPORT`。
- **证伪对照**：摘掉 `node_modules/novel-writing` junction 后重启 → 启动**直接失败**：
  `dsh: cannot resolve profile bundle "novel-writing" from the dsh installation or
  C:\Users\a1941\.dsh\profiles\novel`。

对照成立 = 正向那条 `TRANSPORT` 是有判别力的真证据（挂载失败会响亮报错，而非静默
降级）。**没有这条对照，第 3 条不成立。**

### 4. 免 AI 调用的冒烟手法（零成本、零出网）

把 `DEEPSEEK_BASE_URL` 指向本机死端口（`llm-deepseek` 的 `$DEEPSEEK_BASE_URL` 优先于
配置），即可在**不产生任何 API 费用、不出网**的前提下验证「组合 → 挂载 → 进入执行」：

```powershell
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:1'
cd <deepseek-harness>
node --import tsx/esm apps/cli/src/bin.ts --profile novel "Reply with the single word: ok"
# 期望：dsh: TRANSPORT: DeepSeek API request to http://127.0.0.1:1 failed
```

## 文件说明

| 文件 | 说明 |
|---|---|
| `compare-composed.mjs` | 对账工具。切块解析两份 dump，比对 id 集合/顺序/`disabled`/正文；另有 `--list` 与 `--check-disables <patch.yml>` 两个模式。 |
| `verify-harness-profile.mjs` | **P6** spawn 路径验证：确认 `NOVELSTUDIO_DSH_PROFILE` 真的作用在实际 dsh 启动上（零成本，LLM 端点指向死端口）。`dump-config` 证明不了这件事——它只组合配置、不启动任务。 |
| `capture-dsh-request.mjs` | **P0 线路层验证**：黑洞端点截下 dsh 真正发出去的请求体，核对 15 个 novel_* 工具与人设是否真的在请求里；`--profile` 可换 profile（用不存在的 profile 做阴性对照：应是零字节）。**会 spawn 一次 dsh**，零计费并有跑后审计。 |
| `negative-control.patch.yml` | 阴性对照用的补丁（插入一个不存在的插件包）。 |
| `headless.srcrepo.txt` | 基线：`headless` 组合树（**源码仓库 CLI**，即工坊实际使用的构建）。 |
| `novel.srcrepo.txt` | `novel` 组合树（沿用 patch 机制的中间态）。 |
| `novel.bundle.txt` | `novel` 组合树（改用 bundle 后的最终态）。 |
| `headless.composed.txt` | 参考：`headless` 组合树（**npm CLI** 0.1.5-rc.1 产出）。 |
| `*.help.txt` / `negctl.*` | 启动探测的留档（见下方「已证伪的手法」）。 |

## 复现命令

```powershell
# 组合树（工作目录 = deepseek-harness 源码仓库）
cmd /c "node --import tsx/esm apps/cli/src/bin.ts --profile headless --dump-config > <ws>\.p0-recon\headless.srcrepo.txt"
cmd /c "node --import tsx/esm apps/cli/src/bin.ts --profile novel    --dump-config > <ws>\.p0-recon\novel.bundle.txt"
# 对账
node .p0-recon\compare-composed.mjs .p0-recon\headless.srcrepo.txt .p0-recon\novel.bundle.txt
# 声明 vs 生效
node .p0-recon\compare-composed.mjs .p0-recon\novel.bundle.txt .p0-recon\novel.bundle.txt `
  --check-disables C:\Users\a1941\.dsh\profiles\novel\cordis.patch.yml
```

## 已证伪的手法（勿再使用）

- **`--help` 不能作为挂载验证**：注入一个不存在的插件包后 `--profile novel --help`
  仍然 `exit 0`（见 `negctl.err.txt`）——该路径在插件挂载前就打印帮助并退出。
- **启发式行窗口扫描不可靠**：曾按「`id` 行后 5 行内找 `disabled`」统计，漏掉了
  `disabled: true` 写在 `config:` 块之后的条目（`session-title-llm`），把 19 条误报为
  15 条。必须按整块解析。
- **`--dump-config` 不是只读操作**：它调用 `prepareProfile` 写回 profile 目录下的
  `cordis.yml`（生成文件）。

## 已知环境陷阱（本机实测）

0. **导入 `harness.js` 会写真实数据目录**：`harness.js` → `logger.js` 按
   `NOVELSTUDIO_DATA_DIR` 解析数据目录，未设置时默认是项目里的 `data/`，于是**仅仅 import**
   就会写入 `data/logs/app-YYYY-MM-DD.log`。任何要导入 `harness.js` 的探测脚本，
   **必须先把 `NOVELSTUDIO_DATA_DIR` 指向临时目录**（`verify-harness-profile.mjs` 已如此处理）。
   同理：`db.js` 在模块顶层就 `new DatabaseSync(...)` **以读写方式**打开数据库——
   任何 import `db.js` 的脚本若不设该环境变量，都会打开并可能迁移**真实库**。
1. **编码**：Windows PowerShell 5.1（Desktop）下 `Set-Content -Encoding UTF8` 会写
   **BOM**，导致 dsh 解析 `package.json` 失败（`SyntaxError: Unexpected token ''`）。
   JSON/YAML/JS 一律用
   `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。
   反过来，**中文 `.ps1` 必须带 BOM**，否则 PS 5.1 按 ANSI 解析成乱码。
2. **重定向编码**：PS 5.1 的 `>` / `*>` 默认写 **UTF-16LE**。抓取命令输出请用
   `cmd /c "... > file"`（字节保真）。
3. **junction 删除**：PowerShell 的 `Remove-Item -Recurse` 作用于 junction 有删除
   目标内容的风险，应改用 `cmd /c rmdir "<junction>"` 或 Node 的 `fs.rmSync`。

## 两个 dsh 构建（未决事项，需要决策）

同一 `$DSH_HOME` 下存在两个 dsh 构建，且**组合结果不同**：

- **源码仓库** `deepseek-harness`（`0.1.1-rc.2`，git HEAD 2026-08-21）——`harness.js`
  当前实际使用的就是它（`resolveHarnessDir()` 命中同级目录）。
- **npm 全局** `@deepseek-ai/dsh`（`0.1.5-rc.1`，bundle `0.1.5-rc.2`）——GUI 使用。

实测差异：`--profile headless --dump-config` 在源码仓库 CLI 下是 **382 行**，在 npm CLI
下是 **398 行**（少 `deepseek-llm-api-extensions` 等）。两者共用同一个 `profiles/` 与同一份
`settings.yaml`。本轮 P0 的基线统一取**源码仓库 CLI**（与工坊现状一致）。

另：源码仓库 CLI **没有** `--from-default-profile`（`apps/cli/src/args.ts` 只支持
`profile` / `dump-config` / `plugin` 三种模式），因此 `novel` profile 是手工建立的。

## P6 彩排（在克隆 profile 上做，未碰生产）

P6 的动作只有一件：把 `harness.js` 的默认 profile 从 `headless` 翻到 `novel`。
执行前在**克隆**出来的 `headless-sim` 上完整跑了一遍，两点结论：

1. **彩排抓到一个会让 P6 直接失败的 bug**：旧区块被移除后 `cordis.patch.yml` 只剩注释、
   没有 `[]`，不再是合法的顶层 YAML 数组。而 headless 的 patch 里**只有**这个区块——
   这是必经路径，不彩排就会当场翻车。已修复并给安装器加了写回自检。
2. **spawn 路径验证通过**：不存在的 profile 在 830ms 内明确失败，`novel` 一路走到 LLM 调用。

完整的执行步骤、验证清单与回滚方案见 `docs/p6-cutover-runbook.md`。

## P0 遗留（待收尾）

- `harness-plugins/novel-writing/headless-cordis.patch.yml` 已弃用（仅留作对照），
  待 `ENGINE.md` / `README.md` / `NATIVE_PLUGIN_GUIDE.md` 更新后删除。
- 三份文档仍在描述旧的「区块合并」安装方式与 `--profile headless` 验证命令。
- `novel-tools.mjs` 的 `PLUGIN_VERSION='0.8.0'` 与 `plugin.json` 的 `version: 0.8.1`
  不一致（**会话前既有**的漂移，非本次引入）。
- GUI preset 侧 `baseUrl` 仍是硬编码 `127.0.0.1:3737`（`agent.cordis.yml` 与
  `preset.yml` 各一处）；headless 侧已有 `NOVELSTUDIO_BASE_URL` 兜底。
- `headless` profile 的迁移（改用 bundle）留到 P6 一次性切换时执行；
  `install.ps1 -Profile headless` 已具备该能力，当前**尚未执行**。
