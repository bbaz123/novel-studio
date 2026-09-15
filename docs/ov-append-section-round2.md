## 追加：2026-09-14「🐞 运行追踪」第二轮重审（7 处失误）

完整报告：`novel-studio/docs/run-trace-review-round2-2026-09-14.md`。修复后验证：后端 api-test-suite 115/115、前端 frontend-test 19/19、封卷探针 5/5。

### 失误 1（严重）：停止录制时最后一包前端数据被静默丢弃
- 现象：`traceStop()` 旧顺序 =「`trace.on = false` → flush → send」，而 `traceSendPending()` 首行闸门 `if (!trace.on ...) return`——flush 发生在关灯之后，**最后一包操作永远发不出去**，静默留在 `trace.pending` 里烂掉。
- 影响：停止后的操作在后端永远缺失前端节点（点击链、toast、渲染快照）。
- 修复：先 flush 再关灯；`traceSendPending(force)` 支持关灯后强制冲刷；`traceStop` 收尾 force 兜底。

### 失误 2（严重）：停录后迟到的前端收尾污染已封卷的 JSONL 文件
- 现象：后端 `stopTracing` 写完 `session-end` 封卷后，前端仍可能补发 `/api/debug/op`。旧 `appendNode`/`appendLine` 不看会话是否关闭，把 `node`/`op-end` 行写在 **session-end 之后**，破坏文件自描述结构。
- 修复：新增 `state.sessionClosed` 封卷闸门——封卷后拒绝一切写入（`session-end` 行自身豁免）；迟到数据只进内存供界面看，不写文件。补断言 I3aa~I3ae。

### 失误 3（中等）：直连流式写作没有长流程操作，耗时与 Token 汇总失真
- `streamAIDirectWrite`（SSE 直连成文，分钟级）没有 `traceLongOp`，点击操作 150ms 就被标「已完成」，之后几分钟的 AI 调用以迟到身份塞进已结束的操作。修复：入口建立长流程。

### 失误 4（中等）：多阶段管线被阶段级 flush 切碎
- 修失误 3 时最初把 `traceFlushLong` 放在阶段函数 finally 里，「AI 写本章」被切成 3~5 条，违背按业务语义归并。修复：撤回阶段级 flush，只在管线级 finally（`performToolbarAIWrite`）收尾，并以 `traceWriteCancelled` 标记取消状态。

### 失误 5（中等）：长流程与点击操作的归属竞争
- 把 `traceHeaders()` 改成「长流程优先」后，长流程开启后 120 秒内的无关点击请求（自动保存/切视图）全部混进旧长流程。修复：回滚为点击优先；`traceLongOp()` 建立长流程时先把未收尾的点击操作落地。

### 失误 6（轻微）：退出进程时不冲刷追踪节点缓冲
- `flushTraceFile` 导入了但从未调用，`initLogger` 的 `onExit` 只刷了 OpenViking 防抖队列。修复：`onExit` 同时调用 `flushTraceFile()`。

### 失误 7（轻微）：多请求操作的状态码被后到的 200 覆盖
- `op.httpStatus = res.statusCode` 覆盖式赋值，一次操作多请求时先发的 500 被后发 200 盖掉。修复：改为 `Math.max` 保留最糟状态码。

### 验证工具自我纠错（教训）
- 迟到写入探针最初报假阳性失败——探针自己的 `api()` 调用签名写错（body 包了双层 `{body:{...}}`），服务端收到 `{}` 返回 400。修正探针后全过。**验证脚本失败先怀疑脚本本身，别急着改产品代码。**

### 新增防复发规则（并入本文件）
6. **「关灯顺序」要画时序图**：任何「先置标志位、后做依赖该标志位的工作」都要画时序——本次两处数据丢失（前端停录丢包、后端封卷后写文件）同类。
7. **多阶段管线的收尾点必须在管线边界**：把 flush 放进阶段函数前，先数这条函数在一个业务动作里会被调用几次。
8. **优先级/归属规则要写清仲裁**：`traceHeaders` 点击 vs 长流程优先级改了两遍才定对。
9. **验证脚本失败先怀疑脚本**：探针签名错误曾伪装成产品 bug。
10. **封卷/关闭类状态要有显式闸门**：文件写入层加 `sessionClosed`，不依赖调用方自觉。
