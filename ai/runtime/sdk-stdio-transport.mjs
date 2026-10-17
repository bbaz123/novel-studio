/**
 * ai/runtime/sdk-stdio-transport.mjs —— R01：上游锁定的 newline-delimited JSON-RPC 传输。
 *
 * ── 逐字对齐上游，不自己发明 ────────────────────────────────────────────────
 * 出处：`deepseek-harness/packages/sdk/protocol/src/transport.ts`（`JsonRpcLineTransport`）
 *
 *   ① 帧 = **一行一个 JSON**，以 `\n` 分隔；行尾 `\r` 要吃掉（Windows 上真实出现过 `\r\n`）。
 *   ② 带 `id` + `method` → 请求；只有 `id` → 响应；只有 `method` → 通知。
 *   ③ **JSON 语法错的行直接忽略**（不炸掉整个连接）——上游就是这么做的。
 *   ④ 请求失败 → `-32603`；方法不存在 → `-32601`。
 *   ⑤ 分块到达很常见（`partial`/`read chunk`）：必须用解码器 + 缓冲拼行，
 *      不能假设"一次 data 就是一条完整帧"。
 *
 * ── 本层额外补的两条（上游客户端有、S13 缺）────────────────────────────────
 *   · **超大帧保护**：缓冲超过上限就判定传输失败、拒绝所有挂起请求 —— 否则一个坏端点
 *     可以让内存无限涨、让任务永远不返回（"不无限等待"是 R01 的必测项）。
 *   · **请求超时**：每个请求都可带 `timeoutMs`，超时明确 reject（`SdkTimeoutError`），
 *     并把它从挂起表里删掉，**不留下一个永远不会 settle 的 Promise**。
 */

import { StringDecoder } from 'node:string_decoder';

export const SDK_TRANSPORT_VERSION = 'sdk-stdio-v1';
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 对端返回的 JSON-RPC 错误响应（保留线上 code/data，不吞掉）。 */
export class SdkRpcError extends Error {
  constructor(code, message, data) {
    super(String(message || 'JSON-RPC error'));
    this.name = 'SdkRpcError';
    this.code = code;
    this.data = data;
  }
}

/** 请求超时（不无限等待）。 */
export class SdkTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`SDK_REQUEST_TIMEOUT: ${method} 在 ${timeoutMs}ms 内没有响应`);
    this.name = 'SdkTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** 帧过大 → 传输判死。 */
export class SdkFrameTooLarge extends Error {
  constructor(bytes, limit) {
    super(`SDK_FRAME_TOO_LARGE: 缓冲 ${bytes} 字节超过上限 ${limit}`);
    this.name = 'SdkFrameTooLarge';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * 建一条传输。
 *
 * @param input          可读流（子进程 stdout）
 * @param output         可写流（子进程 stdin）
 * @param maxFrameBytes  单帧上限
 * @param now            时钟（注入便于测超时，不必真等）
 */
export function createStdioTransport({
  input, output,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  now = Date.now,
} = {}) {
  if (!input || typeof input.on !== 'function') throw new TypeError('MISSING_INPUT_STREAM');
  if (!output || typeof output.write !== 'function') throw new TypeError('MISSING_OUTPUT_STREAM');

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 1;
  let closed = false;
  let failure = null;
  const pending = new Map();
  const notificationHandlers = [];
  const stats = { frames: 0, ignored: 0, responses: 0, requests: 0, notifications: 0, byMethod: Object.create(null) };

  const onNotification = (fn) => { if (typeof fn === 'function') notificationHandlers.push(fn); return () => {
    const i = notificationHandlers.indexOf(fn);
    if (i >= 0) notificationHandlers.splice(i, 1);
  }; };
  const onRequest = () => { /* 客户端不接服务端反向请求；收到时按 -32601 回 */ };

  function bump(method) {
    const m = String(method || '');
    stats.byMethod[m] = (stats.byMethod[m] || 0) + 1;
  }

  function fail(err) {
    if (failure) return;
    failure = err;
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) p.reject(err);
  }

  function writeFrame(message) {
    if (closed) throw new Error('SDK_TRANSPORT_CLOSED');
    if (failure) throw failure;
    output.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal = null } = {}) {
    if (closed) return Promise.reject(new Error('SDK_TRANSPORT_CLOSED'));
    if (failure) return Promise.reject(failure);
    if (signal && signal.aborted) return Promise.reject(new Error('SDK_REQUEST_ABORTED'));

    const id = `req_${nextId++}`;
    const message = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params };
    bump(method);

    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        pending.delete(id);
        fn(value);
      };
      const done = settle(resolve);
      const failReq = settle(reject);
      const entry = { resolve: done, reject: failReq, method, startedAt: Number(now()) };
      const onAbort = () => failReq(new Error('SDK_REQUEST_ABORTED'));
      pending.set(id, entry);

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (Number(timeoutMs) > 0) {
        // ⚠️ **不能 unref**：unref 过的定时器在"没有别的活跃句柄"时根本不会触发，
        // 于是 `await request(...)` 会永远挂着（实测：套件卡死在顶层 await，
        // Node 只打印 "Detected unsettled top-level await"）。超时必须是可靠的。
        // 泄漏风险由"settle 时 clearTimeout"保证，不靠 unref。
        timer = setTimeout(() => failReq(new SdkTimeoutError(method, timeoutMs)), Number(timeoutMs));
      }
      try {
        writeFrame(message);
      } catch (e) {
        failReq(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function handleFrame(frame) {
    const id = frame.id;
    const method = frame.method;
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      // 服务端 → 客户端的反向请求：我们一个都不支持，按 -32601 回，别静默挂着
      stats.requests += 1;
      bump(method);
      try {
        writeFrame({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      } catch { /* 连接已坏，已在上面记账 */ }
      return;
    }
    if (typeof id === 'string' || typeof id === 'number') {
      stats.responses += 1;
      const entry = pending.get(id);
      if (!entry) return; // 迟到的响应（可能已被超时丢弃）
      pending.delete(id);
      if (frame.error && typeof frame.error === 'object') {
        entry.reject(new SdkRpcError(
          typeof frame.error.code === 'number' ? frame.error.code : undefined,
          frame.error.message,
          frame.error.data,
        ));
        return;
      }
      entry.resolve(frame.result);
      return;
    }
    if (typeof method === 'string') {
      stats.notifications += 1;
      bump(method);
      for (const fn of notificationHandlers) {
        try { fn(method, (frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)) ? frame.params : {}); } catch { /* 订阅者异常不影响传输 */ }
      }
    }
  }

  function drain() {
    for (;;) {
      if (failure) return;
      const nl = buffer.indexOf('\n');
      if (nl < 0) {
        if (buffer.length > maxFrameBytes) fail(new SdkFrameTooLarge(buffer.length, maxFrameBytes));
        return;
      }
      // 行尾 `\r` 要吃掉：Windows 上子进程若走文本模式会带它，不处理就会 JSON.parse 失败
      const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      if (line.length > maxFrameBytes) { fail(new SdkFrameTooLarge(line.length, maxFrameBytes)); return; }
      stats.frames += 1;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 上游同样是"忽略"而不是"断开"：非 JSON 的噪音不能把任务弄死
        stats.ignored += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { stats.ignored += 1; continue; }
      handleFrame(parsed);
    }
  }

  const onData = (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    drain();
  };
  const onInputError = (e) => fail(e instanceof Error ? e : new Error(String(e)));
  const onEnd = () => {
    buffer += decoder.end();
    drain();
    fail(new Error('SDK_TRANSPORT_INPUT_CLOSED'));
  };

  input.on('data', onData);
  input.on('error', onInputError);
  input.on('end', onEnd);

  /**
   * 关闭传输：摘监听、拒绝挂起请求。**不销毁流**（流的所有权在进程层）。
   */
  function close(reason = 'SDK_TRANSPORT_CLOSED') {
    if (closed) return;
    closed = true;
    input.off('data', onData);
    input.off('error', onInputError);
    input.off('end', onEnd);
    fail(new Error(reason));
  }

  return {
    version: SDK_TRANSPORT_VERSION,
    request,
    onNotification,
    onRequest,
    close,
    get pendingCount() { return pending.size; },
    get failure() { return failure; },
    get bufferBytes() { return buffer.length; },
    stats: () => ({ ...stats, byMethod: { ...stats.byMethod } }),
    /** 只给探针用：喂一段原始字节，验证分帧行为（真实运行时由流驱动）。 */
    _inject: (chunk) => onData(chunk),
  };
}
