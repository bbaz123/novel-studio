# 小说工坊的出口隔离（宿主编排层：插件 + sandbox）

> 目标能力：方案里的 `network.egress_deny_default`——**默认拒绝出站**，白名单显式放行。
> 实现位置不是桌面版 DSH 内核，而是小说工坊自己的宿主侧编排层：`harness-plugins/novel-writing/`。

## 为什么是两层

模型能出站的地方不止业务代码里那一个 `fetch`：

| 出口 | 业务层守卫 | 插件层 | sandbox 层 |
| --- | --- | --- | --- |
| 业务代码里的出站 | 能管 | — | 能管 |
| `web_fetch` / `web_search` 工具 | 管不到 | **能管** | 管不到（工具在宿主进程里） |
| shell 工具里的 `curl` / `npm publish` | 管不到 | **能管**（识别命令文本） | 部分（命令不是 Node 时管不到） |
| Node 子进程里的 `net` / `tls` / `dns` / `http` / `fetch` | 管不到 | 管不到 | **能管**（进程内 preload） |

所以：**插件半边**管工具调用，**sandbox 半边**管进程内建通道，两者合起来才是完整的“插件 + sandbox”。

## 插件半边：`egress-guard.mjs`

- 注册 `tools/pre-execute`（留审计）+ `ctx.tools.guard()`（单调拒绝，后注册的监听器无法把拒绝翻回允许）。
- 纯判定函数 `classifyToolCall(exec, { allowHosts })` 可离线断言：
  - 网络工具（`web_fetch` / `web_search` / `browser_*` / `fetch_url`…）从参数里解析主机；无主机或主机不在白名单 → 拒绝；
  - shell 工具（`ops_bash` / `bash` / `pwsh`…）识别 `curl`、`wget`、`Invoke-WebRequest`、`ssh/scp`、`npm/pnpm/yarn` 安装发布、`git push/pull/fetch/clone`、`docker pull`；能解析主机就按白名单判，解析不到就**默认拒绝**（宁可误拒，不可静默放行）；
  - 其余工具放行。
- 本机回环（`127.0.0.1` / `localhost` / `::1`）始终允许——否则工坊自己的本地服务会被自己挡住。
- 配置：`egress.enabled`（默认 true）、`egress.allowHosts`、`egress.auditFile`（或用 `NOVELSTUDIO_EGRESS_AUDIT`）。
- 挂载失败不会阻断插件激活：`apply()` 里包了 try/catch，失败只记 `installed:false`。

## sandbox 半边：`sandbox/egress-preload.mjs` + `sandbox/install.mjs`

- 用 `node --import <install.mjs>` 在业务代码之前打补丁：`net.Socket#connect`、`net.connect` / `net.createConnection`、`tls.connect`、`dns.lookup|resolve*`、`http/https.request|get`、`globalThis.fetch`。
- 策略：本机回环允许；其余一律抛 `EGRESS_DENIED`（`dns.lookup` 按 Node 约定走回调错误）。
- 白名单：`NOVELSTUDIO_EGRESS_ALLOW`（逗号分隔，支持 `host` 与 `host:port`）。
- 审计：`NOVELSTUDIO_EGRESS_AUDIT` 指向文件时逐条追加；`NOVELSTUDIO_EGRESS_SUMMARY` 指向文件时退出前写摘要（`pid` / `policy` / `allow` / `denials`）。
- 接入：`scripts/ci-isolated-run.mjs --egress-guard`（或 `NOVELSTUDIO_EGRESS_GUARD=1`）会给所有 Node 子进程加上该 preload。

### 实测踩到的坑（已修，写在这里防回退）

1. **Windows 下 `--import` 只认 URL**：传盘符路径直接 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，必须 `pathToFileURL(...).href`。
2. **`net.connect(port, host)` 不经过 `Socket.prototype.connect`**：只包原型会被直接调用绕过（EG-09 就是这么漏过去的），必须同时包 `net.connect` / `net.createConnection` 两个导出函数。
3. **`dns.lookup` 的拒绝不能“抛同步异常”**：Node 约定走回调错误，判据要读 `err.code`。

## 边界（如实写）

- sandbox 只覆盖 **Node 进程内**的通道；外部 `curl.exe`、浏览器、原生扩展里自建的 socket 不在覆盖范围——那需要操作系统防火墙/AppContainer。
- 插件层依赖工具名与参数文本识别；改名或加密的脚本可能识别不到，此时它的出站仍会被 sandbox 层按进程拦（如果该进程是 Node）。
- 两层都不是“证明没有出站”，而是“默认拒绝 + 可审计 + 可断言”。

## 验证

```
node scripts/test-ocb-egress.mjs        # 10 条：纯判定 / Cordis 挂载 / 子进程 fetch、socket、dns、回环
node scripts/test-one-click-book.mjs    # 32 条：业务流水线（含业务层 egress 守卫 AC-21/22）
node scripts/ci-isolated-run.mjs --egress-guard --port 3738 -- node api-test-suite.mjs
```
