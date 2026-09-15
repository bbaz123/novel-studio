# 「🐞 运行追踪」改动重审报告（第二轮 · 2026-09-14）

**重审范围**：上一轮 4 处修复之后，重新逐段通读全部改动（`debug-trace.js`、`server.js`、`harness.js`、`openviking-sync.js`、`public/app.js`、`public/index.html`、`public/styles.css`、`api-test-suite.mjs`、`frontend-test.mjs`、`README.md`、`.gitignore`），并跑了导出符号对账、心跳值核对、全 diff 复核与三套验证。

**结论**：本轮又发现 **7 处失误**，已全部修复并补测试。最终验证：后端 115/115、前端 19/19、迟到写入封卷探针 5/5、语法检查全过。
上一轮已修的问题（bumpTool 未接线、心跳 20s 过紧、死导出符号、SQLite 表取舍未文档化）经复核仍然成立，未回退。

---

## 本轮发现并修复的失误

### 失误 1（严重）：停止录制时最后一包前端数据被静默丢弃
- **现象**：`traceStop()` 的旧顺序是「`trace.on = false` → flush → send」。而 `traceSendPending()` 的第一行闸门是 `if (!trace.on ...) return`——flush 是在关灯之后执行的，**最后一包操作（含停录瞬间在途的 API 调用、点击节点、toast、渲染快照）永远发不出去**，只留在 `trace.pending` 里烂掉。
- **影响**：用户点停止之后完成的那些操作，前端节点在后端永远缺失；操作列表里大量记录只有后端节点、没有前端链路。这是数据静默丢失，且不报任何错。
- **修复**：① 调整 `traceStop` 顺序——先 flush 在途 op/long-op，再关 `trace.on`；② `traceSendPending(force)` 支持在关灯后强制冲刷 pending；③ `traceStop` 收尾时以 `force=true` 再冲一次兜底。

### 失误 2（严重）：停止后迟到的前端收尾会污染已封卷的 JSONL 文件
- **现象**：后端 `stopTracing` 写完 `session-end` 封卷后，前端仍可能补发 `/api/debug/op`（停录瞬间在途请求、或上面失误 1 修好后的 force 冲刷）。旧的 `appendNode`/`appendLine` 不看会话是否已关闭，会把 `node`/`op-end` 行**写在 `session-end` 之后**。
- **影响**：会话文件失去「自描述」结构——回看器按顺序读，封卷后冒出的行会被误读成下一条操作/节点，甚至让 `readSession` 解析出残缺记录。文件级数据损坏。
- **修复**：新增 `state.sessionClosed` 封卷标志。`stopTracing` 在自动收尾 op 之后、写 `session-end` 之前置位；`appendNode` 与 `appendLine` 在封卷后拒绝一切写入（`session-end` 行自身豁免）。迟到数据仍进内存供界面查看，只是不再写文件。
- **测试**：新增 I3aa~I3ae 五条断言——停录后迟到收尾被接受、节点进内存、文件含 `session-end`、封卷后无 node 行、封卷后无 op-end 行。

### 失误 3（中等）：直连流式写作没有长流程操作，耗时与 Token 汇总失真
- **现象**：慢通道 `runHarnessJob` 有 `traceLongOp`，但 SSE 直连成文 `streamAIDirectWrite`（分钟级任务）没有。点击操作 150ms 就被收尾定时器标成「已完成」，之后几分钟的 AI 调用、扫描、续写全部以「迟到节点」身份塞进一条已经结束的操作里。
- **影响**：直连写作（质量优先模式的默认路径）在界面上显示耗时几百毫秒、AI Token 汇总为零——正是用户要的核心数据。
- **修复**：`streamAIDirectWrite` 入口建立长流程（`traceLongOp(stageLabel)`），与慢通道一致。

### 失误 4（中等）：多阶段写作管线被阶段级 flush 切碎成多条操作
- **现象**：修失误 3 时我最初把 `traceFlushLong` 放在了 `runHarnessJob`/`streamAIDirectWrite` 的 finally 里——但「AI 写本章」是蓝图→成文→质检→补足多阶段管线，每阶段结束时 flush 会把一条业务操作切碎成 3~5 条。
- **影响**：违背需求澄清第 8 题的「按业务语义归并」。
- **修复**：撤掉阶段级 flush；长流程只在**管线级 finally**（`performToolbarAIWrite` 末尾）收尾，并用 `traceWriteCancelled` 标记用户取消状态。阶段间靠 120 秒空闲窗口保持同一条长流程存活。

### 失误 5（中等）：长流程与点击操作的归属竞争
- **现象**：修失误 3 时我把 `traceHeaders()` 改成「长流程优先」，但这会让长流程开启后 120 秒内**无关点击**的请求（如自动保存、切视图）全部混进旧长流程。
- **修复**：回滚为点击优先；改由 `traceLongOp()` 在建立长流程时先把未收尾的点击操作落地（点击操作只是"发起者"，其处理链内的阶段请求自然落到长流程上）。这个边界现在两清了。

### 失误 6（轻微）：退出进程时不冲刷追踪节点缓冲
- **现象**：`flushTraceFile` 导入了但从未调用；`initLogger` 的 `onExit` 只刷了 OpenViking 防抖队列。
- **影响**：进程退出（正常关服/崩溃兜底）时，最后 1 秒内缓冲的追踪节点丢失。
- **修复**：`onExit` 同时调用 `flushTraceFile()`。

### 失误 7（轻微）：多请求操作的状态码会被后到的 200 覆盖
- **现象**：`traceRequest` 里 `op.httpStatus = res.statusCode` 是覆盖式赋值。一次操作触发多个 HTTP 请求时（如保存→同步→扫描），先发生的 500 会被后面的 200 覆盖。
- **影响**：操作列表上显示 HTTP 200，掩盖了操作中真实发生过的失败。
- **修复**：改为取最大状态码（`Math.max`），保留「最糟糕」的失败证据；`close` 事件同样处理。

### 附：本轮验证工具的自我纠错
- 迟到写入探针最初报了假阳性失败——探针脚本自己的 `api()` 调用签名写错（把 body 包了双层 `{ body: {...} }`），服务端因此收到 `{}` 返回 400「缺少 op_id」。修正探针签名后全部通过。**教训：验证脚本的失败先怀疑脚本本身，别急着改产品代码。**

---

## 复核后确认**没有**问题的部分（第二轮）

- harness.js 中 `patchAgentDefault`、思考强度校验等大块 diff 是 2026-09-13 会话的既有改动，本轮未触碰，也未引入交叉影响。
- `bumpTool` 确实在 import 列表且有两个真实调用点（缓存命中/未命中）——上一轮修复仍然有效。
- 心跳 90s / 检查间隔 15s 已按上轮修复落地。
- 被 `traceFn` 重新赋值的函数无 ESM 导出契约风险（入口文件 + 内部非导出函数，已核实）。
- `Object.create(stmt)` 包装 node:sqlite StatementSync 只覆盖 run/get/all/iterate，其余走原型链，安全。
- `/api/debug/*` 受 `isLocalRequest` 保护、会话文件名有白名单 + 前缀校验（路径穿越 404）。
- `AsyncLocalStorage` 无法跨界 `enterWith` 注入——已实测，必须由请求回调自身 `als.run`（此结论记录于上轮报告，本轮代码未依赖错误用法）。

## 验证结果（修复后）

| 验证 | 结果 |
|---|---|
| `node api-test-suite.mjs` | **115/115**（新增 I3aa~I3ae 封卷断言 5 条） |
| `node frontend-test.mjs` | **19/19** |
| 迟到写入封卷探针 | **5/5** |
| `node --check` | debug-trace.js / server.js / harness.js / openviking-sync.js / public/app.js / api-test-suite.mjs / frontend-test.mjs 全 OK |

## 新增的防复发规则（并入偏好记忆）

6. **「关灯顺序」要画时序图**：任何「先置标志位、后做依赖该标志位的工作」的代码都要画一遍时序——本次两处数据丢失（前端停录丢包、后端封卷后写文件）都是同类错误。
7. **多阶段管线的收尾点必须在管线边界**：把 flush 放进阶段函数内部之前，先数一遍这条函数在一个业务动作里会被调用几次。
8. **优先级/归属规则要写清仲裁**：`traceHeaders` 的点击 vs 长流程优先级改了两遍才定对——先写清楚"什么场景谁优先"，再写代码。
9. **验证脚本的失败先怀疑脚本**：探针自身的调用签名错误曾伪装成产品 bug。
10. **封卷/关闭类状态要有显式闸门**：文件写入层加 `sessionClosed` 闸门，而不是依赖调用方自觉。
