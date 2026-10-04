# `spawn EPERM`：AI 任务起不来（2026-10-02 22:29）

> 一句话：**不是工坊代码的问题，是我把工坊服务跑在了自己的沙箱会话里**。沙箱禁止子进程使用
> 管道 stdio，而 `harness.js` 启动 `dsh` 子进程时用的正是默认的三管道（`pipe,pipe,pipe`）。
> 已把服务改为独立启动（自己的控制台窗口，不继承本会话），并实测该进程能正常起子进程。

## 一、现象与证据

作者在工坊里发起 AI 写作（`/api/harness/run`），界面弹错：

```
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:458:11)
    at file:///C:/Users/a1941/Desktop/DeepSeek/novel-studio/harness.js:851:23
    at runTask (harness.js:810) → runHarnessTaskWithProgress (harness.js:983)
    at createHarnessJob (server.js:4768) → handleAPI (server.js:8702)
{ "action": "write", "endpoint": "/api/harness/run", "error_code": "EPERM" }
```

`harness.js:851` 的调用形状：

```js
const child = spawn(process.execPath, spawnArgs, {
  cwd: spawnCwd, shell: false, windowsHide: true, env: childEnv,
  ...(useStdinPrompt ? { stdio: ['pipe', 'pipe', 'pipe'] } : {})   // 不传时默认同样是三管道
});
```

即 `spawn` 需要建立**管道**（父进程要读子进程的 stdout/stderr 才能上报进度与产出）。
沙箱的边界恰好是"**程序不能打开命名管道 / 管道式 stdio 的 spawn 会被拒**"，
于是每一次 AI 任务都在这里以 `EPERM` 失败——而工坊的其它功能（读、写、保存）全部正常，
这个组合正是"只有 AI 任务坏了"的形状。

## 二、根因（我造成的）

本次会话早前，工坊服务被**我**以"托管后台作业"的方式启动：
`pwsh` 作业 → `node server.js`（服务进程是本会话的子进程）。
子进程**继承本会话的沙箱身份**，因此它自己再 `spawn` 孙进程时被同一道边界拒绝。

对照实验（同一台机器、同一份代码）：

| 启动方式 | 在服务进程内 `spawn(node, …, 默认三管道)` | 结果 |
| --- | --- | --- |
| 本会话内（沙箱） | 抛 `EPERM` | **复现作者报错**（`.p1-baseline/probe-spawn-sandbox.mjs`） |
| 本会话内、且文件策略放开后 | 成功 | `SPAWN_OK out=child-ok` |
| 独立控制台窗口启动（不继承本会话） | 成功 | `SPAWN_OK code=0 stdout=dsh-child-ok` |

## 三、处置

1. 停掉我起的沙箱内实例（避免"服务在跑但 AI 任务永远失败"这种更难查的状态）。
2. 用**独立控制台窗口**重启（与项目自带 `start-novel-studio.cmd` 的行为一致，只是不自动开浏览器）：
   `Start-Process cmd.exe '/c start "Novel Studio Server" cmd /k node server.js'`
   → 服务 pid **22768**，父进程是 `cmd.exe`（**不再是我的会话**）。
3. 端到端验证（走作者刚才失败的那条路）：

   | 验证 | 结果 |
   | --- | --- |
   | `GET /api/harness/status` | `200 {"ok":true,"available":true,"built":true,...}` |
   | `GET /api/chapters/121` | 4294 bytes / `updated_at=2026-10-02T14:15:05.141Z`（正文未被本次故障影响） |
   | `POST /api/harness/run`（一次最小任务） | `202` → 作业最终 `status=done`、无 `EPERM`；**证明服务进程已能正常 `spawn` 并跑完 `dsh` 子进程** |

## 四、要记住的操作纪律（避免复发）

- **长驻服务不要挂在 Agent 会话里**：Agent 的工具调用带沙箱，服务继承该沙箱后，
  它自己的子进程会以 `EPERM` 失败——而"服务在工作、AI 任务却失败"是最难定位的一种组合。
  工坊服务一律用项目自带的 `start-novel-studio.cmd`（或等价的独立控制台窗口）启动。
- 若确实需要由我启动，必须在**文件/进程策略允许子进程**的前提下，并**当场用一次真实 spawn 验证**，
  不能以"端口能打开、页面能加载"作为服务可用的证据（那两项在 EPERM 故障下同样正常）。

## 五、本次验证的代价（如实记账）

端到端验证用的那次最小任务**真实调用了模型一次**（作业 `22cc2e4d-1b75-435d-b654-6786ddaa253b`，
`elapsed_ms=9787`）。这是为了让"能 spawn"不止停留在形状复现上而付出的成本；
除此之外本次故障排查没有产生其它模型调用。
