# E1 门禁沙箱 `spawn EPERM`：外部归因与协同材料（R06）

> **阶段**：R06 / E1（《S18 后收尾方案》§8）
> **状态**：`BLOCKED_EXTERNAL`（**不是** fixed，**不是** resolved）
> **责任边界**：门禁 / 执行环境所有者；本项目**不可修**
> **纪律**：不加重试、不删测试、不改弱断言、不放宽 `networkPolicy`

---

## 0. 一句话

同一份工作区、同一条命令：
**在受信 shell 里 55/55 通过（exit 0），在门禁环境里曾出现 38 通过 / 17 未通过且 17 条统一 `spawn EPERM`（errno -4048）。**
差异不在项目代码，而在**执行环境是否允许派生进程的管道 stdio**。

## 1. 交给门禁所有者的取证包（照这个格式回填即可复现）

| 项 | 值 |
|---|---|
| 产品仓库 SHA | 见 `docs/nsdsh/post-s18-evidence-baseline.md`（R00 冻结；本文件不重复粘 SHA，避免与它漂移） |
| Node | `v24.19.0` |
| OS / arch | `win32 10.0.26200 x64` |
| 失败命令 | `node scripts/ci-offline-checks.mjs`（等价 `npm test`） |
| 工作目录 | 仓库根（绝对路径） |
| 沙箱 profile | `workspace-write`（门禁插件 `dsh-plugin-verification`） |
| stdio 模式 | 子进程需要 **pipe**（`stdio: ['pipe','pipe','pipe']`）；门禁侧拒绝时统一报 `spawn EPERM` |
| 实际 errno | `-4048`（Windows `EPERM`） |
| 预算 | 120s（实测同一命令在受信 shell 里 **141–150s**，本身也超预算） |
| 失败签名 | 17 条检查失败 + 每条 `spawn EPERM`；另有 `timed_out` |
| 通过对照 | 同一条命令在受信 shell：**exit 0，55/55，141.2s / 150.3s（两次）** |

> 关键点：**报错位置全部在"启动子进程"这一步**，不是断言失败。
> 所以它既不是代码回归，也不能靠改测试修好。

## 2. 最小 spawn 探针（本轮在本机 shell 实跑）

目的：把 `EPERM` 与"入口找不到 / 非零退出 / 超时"区分开——**只有签名一致才能归因外部**。
探针逻辑与源码（`spawnSync` + 异步 `spawn` + kill）共 5 条，输出如下（本机 shell，2026-10-17）：

```json
{
 "platform": "win32", "arch": "x64", "node": "v24.19.0",
 "results": [
  { "kind": "spawn_ok",    "status": 0, "signal": null, "error": null, "stdout": "ok" },
  { "kind": "enoent",      "error": "ENOENT" },
  { "kind": "nonzero",     "status": 7 },
  { "kind": "timeout_kill","code": null, "signal": "SIGKILL" },
  { "kind": "pipe_large",  "status": 0, "bytes": 100000, "error": null }
 ]
}
```

**读法（重要）**：

- 在本机 shell 里 **`EPERM` 复现不出来** —— 五条全部符合预期。这恰恰是归因的**必要条件**：
  同一个探针在门禁环境里若返回 `EPERM`，就能把"环境拒绝派生进程"与"项目代码坏了"分开。
- 四种失败形态彼此可分：`ENOENT`（入口不存在）**没有** `status`；非零退出**有** `status` 但不带 `error`；
  超时是我们**主动 kill**（`signal: SIGKILL`）；`EPERM` 会落在 `error.code` 上而 `status` 为 `null`。
  归类时**必须**按这个形状判，不能看到"红"就当代码回归。

## 3. 归因判据（什么时候可以写 `BLOCKED_EXTERNAL`）

三条必须**同时**满足，缺一条就只能按真实回归处理：

1. **签名一致**：失败原因是 `spawn EPERM`（errno `-4048`）或明确的 `timed_out`，**不是**断言失败；
2. **环境对照**：同一 SHA、同一命令、同一 Node/OS，在受信 shell 里能重复通过（本轮两次 55/55）；
3. **可定位**：失败集中在"派生子进程"的检查项上（本轮静态枚举：55 项里 **18 项**依赖子进程）。

反之，若受信 shell 里**也**红，那就是真回归 —— 不许拿 E1 当豁免。

## 4. 明确不做的事（这几条比"修好"更重要）

| 禁止 | 为什么 |
|---|---|
| 自动重试直到绿 | 会把真回归一起掩盖；E1 本来就表现为"红一次绿两次" |
| 把 required 测试改成可选 | 门禁强度下降，等于用 E1 换假绿 |
| 缩小断言 / 删测试项 | 同上 |
| 把 `networkPolicy` 改宽 | E1 与网络无关，改它是**误伤**且会放松门禁 |
| 在 YAML 里整格 `continue-on-error` | 真失败变成假失败不可见 |

## 5. 时间预算问题（另一个独立的外部项）

同一命令在受信 shell 实测 **141.2s / 150.3s**，而门禁预算是 **120s**。
这不是"代码慢"，而是**预算与既有检查集的规模不匹配**。方案 §8.5 给了两条正确出路（由门禁所有者决定）：

- **明示更合适的执行预算**；或
- 把 55 项**分成独立批次**，但**必须仍然执行全部 55 项**，并留下汇总退出码与每批原始证据。

**不允许**的做法：为了塞进 120s 而少跑检查。

## 6. 当前状态与解除条件

| 项 | 状态 |
|---|---|
| 项目内是否可修 | **不可修**（`disposition: not_fixable_in_project`） |
| 台账状态 | `open` + `externalKind: BLOCKED_EXTERNAL` + `externalOwner: gate-maintainer` |
| 解除条件 | 门禁所有者在**同一约束**下多次真实执行稳定通过，且 required checks 强度不变 → 才可改为 `RESOLVED_VERIFIED` |
| 在此之前 | 对外一律写"已知门禁环境限制"，并提供受信 shell 的独立实测作为补充证据（本轮：55/55 ×2、51 套件 385 断言、12 场景真实子进程） |

## 7. 本轮新增的旁证（与 E1 直接相关）

- `scripts/nsdsh/verify-sdk-real.mjs`：**真实子进程** 12 场景（本机受信 shell）全过 ——
  说明"派生进程 + 管道 stdio"在本机完全可用，进一步支持"差异在门禁环境"的结论。
- `scripts/nsdsh/verify-distribution.mjs` / `compare-runtime-bc.mjs`：同样在本机 shell 起真实子进程并通过。
- 这些脚本**都没有**被加进门禁的必需测试集（否则会把 E1 扩散成新的假红）；
  它们的证据记录在各自文档里，口径是"受信 shell 实测"，不是"门禁通过"。
