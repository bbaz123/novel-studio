/**
 * harness-pool.mjs —— 常驻 dsh 运行时的「热备池」（把每任务 ≈17–18 秒的冷启动从**串行等待**
 * 变成**后台重叠**）。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────────────
 * 现状是"一个任务一个 `dsh --profile novel "<任务>"` 子进程"（harness.js 的 spawn 出口）。
 * 每个任务都要付一次 dsh 冷启动（本项目实测 ≈17–18 秒，见 README「写作路径提速（实测驱动）」）。
 * 而 dsh 自带一个**常驻**运行时：`@deepseek-ai/dsh-sdk-app`（`dsh --profile sdk`，
 * stdio JSON-RPC 常驻），本项目此前没有用它。协议来自对已装 dsh 的只读取证（见
 * `docs/` 的调研记录）：NDJSON + JSON-RPC 2.0；`initialize` → `session/prompt` → 收
 * `session.event` 通知（`assistant/message` 是正文、`turn/end` 是终态）。
 *
 * ── 为什么是"热备池"而不是"一个进程跑所有任务" ──────────────────────────────────
 * 三条硬约束决定了池的形状（都来自协议取证，不是口味问题）：
 *   1. **SDK 没有 per-session cancel**：任务只能靠 `shutdown` 或杀进程停下。若多个任务共享
 *      一个进程，取消其中一个就会连带杀掉别人的任务 —— 与现有"取消 = 杀子进程树"的语义冲突。
 *   2. **`initialize` 是进程级**：模型/思考强度**不能按任务切**，只能一个路由一条进程。
 *   3. **session 只在 shutdown 时清空**：长驻进程里每个新 sessionId 都会长期驻留一个 agent，
 *      内存只增不减。
 * 于是：**一个任务独占一个已启动的空闲进程；任务结束（成功/失败/超时/取消）后该进程退役，
 * 后台立刻补一个新的热备**。这样取消语义不变、会话天然隔离（一进程一会话）、内存不累积，
 * 而冷启动被藏在"上一个任务还在跑"的那几分钟里 —— 那是它本来就该待的地方。
 *
 * ── 与既有回退路径的关系 ──────────────────────────────────────────────────────
 * 池是**可选加速层**，不是替代：任何一环失败（起不来/握手失败/协议超时/进程意外退出）
 * 都由调用方回退到既有的 spawn 路径。默认关闭，由 `NOVELSTUDIO_HARNESS_POOL=1` 打开。
 *
 * 本模块**不碰文件系统、不 spawn**：进程由注入的 `spawnWorker(route)` 提供，
 * 于是协议与池策略都能离线断言（见 `.p1-baseline/test-harness-pool.mjs`）。
 */

/** 路由键：`initialize` 是进程级握手，所以"同一个键"才允许复用同一个进程。 */
export function routeKeyOf({ provider, model, reasoningEffort } = {}) {
  return `${String(provider || '')}|${String(model || '')}|${String(reasoningEffort || '')}`;
}

/**
 * 把一条 `session.event` 通知折成"这一轮的进展"。
 * 纯函数，便于离线断言"正文是怎么攒出来的、终态怎么判"。
 *
 * @param {{sessionId?:string, event?:{type?:string, data?:any}}} params
 * @param {{text:string, finished:boolean, failure:Error|null, progress:string[]}} state
 * @returns {{text:string, finished:boolean, failure:Error|null, progress:string[]}} 新的 state（不原地改）
 */
export function foldSessionEvent(params, state) {
  const next = { text: state.text, finished: state.finished, failure: state.failure, progress: state.progress };
  const ev = params && params.event;
  if (!ev || typeof ev.type !== 'string') return next;
  if (ev.type === 'assistant/message') {
    const content = ev.data && ev.data.message && ev.data.message.content;
    const texts = Array.isArray(content)
      ? content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
      : [];
    // ⚠️ 取**最后一条** assistant/message 作为最终答复：一轮里可能有多个 step，
    // 每个 step 都发一条；中间 step 的文本是过程稿，不能累加（累加会把草稿与正文拼在一起）。
    if (texts.length) next.text = texts.join('');
  } else if (ev.type === 'turn/end') {
    next.finished = true;
    const kind = ev.data && ev.data.reason && ev.data.reason.kind;
    if (kind && kind !== 'completed') {
      const err = new Error(`Harness 任务未完成（turn/end reason=${kind}）`);
      err.turnReason = kind;
      if (ev.data && ev.data.reason && ev.data.reason.error) err.detail = ev.data.reason.error;
      next.failure = err;
    }
  } else if (ev.type === 'tool/call') {
    const name = ev.data && ev.data.name;
    if (name) next.progress = state.progress.concat([`🔧 ${name}`]);
  }
  return next;
}

/**
 * 一条常驻进程的协议封装：NDJSON JSON-RPC 2.0 客户端。
 *
 * @param {{ send:(line:string)=>void, onData:(cb:(chunk:string)=>void)=>void, onExit:(cb:(info:any)=>void)=>void, kill:()=>void, pid?:number }} io
 *        —— 由调用方适配真实子进程（stdout ⇒ onData、stdin ⇐ send、close/error ⇒ onExit）。
 * @param {{ timeoutMs?:number }} [opts]
 */
export function createWorker(io, { defaultTimeoutMs = 30000 } = {}) {
  let buf = '';
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const listeners = new Set(); // 通知订阅者
  const exitListeners = new Set(); // 进程退出订阅者（在途任务必须靠它立刻收场，而不是等到超时）
  let exitInfo = null;
  const exitWaiters = [];

  const settleAll = (err) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    for (const w of exitWaiters.splice(0)) w(err);
  };

  io.onData((chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // 坏帧静默丢弃，与传输层语义一致
      if (!msg || typeof msg !== 'object') continue;
      if (msg.id !== undefined && msg.method === undefined) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const err = new Error(msg.error.message || 'JsonRpc error');
          err.code = msg.error.code;
          p.reject(err);
        } else p.resolve(msg.result);
      } else if (typeof msg.method === 'string') {
        for (const fn of listeners) { try { fn(msg.method, msg.params || {}); } catch { /* 订阅者自身出错不影响协议 */ } }
      }
    }
  });
  io.onExit((info) => {
    exitInfo = info || { code: null };
    const err = new Error(`常驻 dsh 进程已退出（${JSON.stringify(exitInfo)}）`);
    err.workerExited = true;
    // 先通知在途任务，再结算挂起请求：在途任务等的是**通知**而不是请求响应，
    // 所以只 settleAll 是不够的（那会让任务一直挂到超时 —— 首版就是这样，被离线测试抓到）。
    for (const fn of exitListeners) { try { fn(err, exitInfo); } catch { /* 订阅者自身出错不影响其它订阅者 */ } }
    settleAll(err);
  });

  const request = (method, params, timeoutMs = defaultTimeoutMs) => new Promise((resolve, reject) => {
    if (exitInfo) { reject(new Error('常驻 dsh 进程已退出，请求无法送达')); return; }
    const id = `req_${nextId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new Error(`常驻 dsh 请求超时：${method}（${timeoutMs}ms）`);
      err.timeout = true;
      reject(err);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { io.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });

  return {
    request,
    /** 订阅服务端通知；返回退订函数。 */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** 订阅进程退出；返回退订函数。在途任务靠它立刻失败，而不是挂到超时。 */
    onExit(fn) {
      if (exitInfo) {
        const err = new Error(`常驻 dsh 进程已退出（${JSON.stringify(exitInfo)}）`);
        err.workerExited = true;
        try { fn(err, exitInfo); } catch { /* 同上 */ }
        return () => {};
      }
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    get exited() { return Boolean(exitInfo); },
    get exitInfo() { return exitInfo; },
    kill: () => io.kill(),
    pid: io.pid,
    /** 等进程退出（用于池退役时确认资源真的释放了）。 */
    waitExit: (timeoutMs = 5000) => new Promise((resolve) => {
      if (exitInfo) { resolve(exitInfo); return; }
      const t = setTimeout(() => resolve(null), timeoutMs);
      exitWaiters.push((err) => { clearTimeout(t); resolve(exitInfo || { error: String(err && err.message) }); });
    }),
  };
}

/**
 * 在一个已握手的 worker 上跑一条任务。
 *
 * 协议要点（全部来自只读取证）：
 *   - `session/prompt` **立即返回**一个收据 `{messageId}`，没有"跑完返结果"的调用；
 *   - 正文与终态只能从 `session.event` 通知里取，且通知带 `sessionId`（同一进程可能有多条会话）；
 *   - `turn/end` 的 `reason.kind` 就是终态，`error` 变体带错误详情。
 *
 * @param {ReturnType<typeof createWorker>} worker
 * @param {{ sessionId:string, prompt:string, timeoutMs?:number, onProgress?:(line:string)=>void, signal?:AbortSignal }} o
 * @returns {Promise<{text:string}>}
 */
export async function runPromptOnWorker(worker, { sessionId, prompt, timeoutMs = 30 * 60 * 1000, onProgress, signal } = {}) {
  let state = { text: '', finished: false, failure: null, progress: [] };
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  // ⚠️ 必须**立刻**挂一个空 catch：终态通知（尤其是 turn/end(error)）可能在调用方
  // `await done` 之前就到达（`session/prompt` 的收据与通知是两条独立的帧），
  // 那样这个 Promise 会以"未处理的 rejection"结束 —— Node 默认直接终止进程
  // （本文件首次跑测试时就是这么炸的，不是理论风险）。挂空 catch 只是把它标记为已处理，
  // 后面真正的 `await done`（在 finally 之前的 return 处）依然会拿到同一个错误。
  done.catch(() => {});

  const unsubscribe = worker.subscribe((method, params) => {
    if (method !== 'session.event') return;
    if (!params || params.sessionId !== sessionId) return; // 只认自己那条会话
    state = foldSessionEvent(params, state);
    if (onProgress && state.progress.length) {
      const last = state.progress[state.progress.length - 1];
      if (last !== state.progress[state.progress.length - 2]) { try { onProgress(last); } catch { /* 进度回调失败不影响任务 */ } }
    }
    if (state.finished) state.failure ? rejectDone(state.failure) : resolveDone({ text: state.text });
  });

  const timer = setTimeout(() => {
    const err = new Error(`Harness 任务超时（${Math.round(timeoutMs / 1000)} 秒）后被取消，已生成的中间内容未能落盘。`);
    err.code = 'HARNESS_TIMEOUT';
    rejectDone(err);
  }, timeoutMs);

  const onAbort = () => {
    const err = new Error('Harness 任务已取消');
    err.code = 'HARNESS_CANCELLED';
    rejectDone(err);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  // 进程中途死掉：立刻把在途任务拒掉（与 spawn 路径的 child.on('close') 同语义）。
  const offExit = worker.onExit ? worker.onExit((err) => rejectDone(err)) : () => {};

  try {
    await worker.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: String(prompt ?? '') }],
    });
    return await done;
  } catch (e) {
    // 进程意外退出/握手后断开：把"没有正文"如实带出去（调用方据此回退 spawn 路径）。
    throw e;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    offExit();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 热备池策略（不 spawn、不管协议，只决定"取哪个、何时补、何时退役"）。
 *
 * @param {{
 *   spawnWorker: (route:object)=>Promise<{worker:any, dispose:()=>void}>,
 *   maxWarm?: number, idleMs?: number, now?: ()=>number, log?: (level:string, kind:string, message:string, ctx?:object)=>void,
 * }} o
 */
export function createWarmPool({ spawnWorker, maxWarm = 2, idleMs = 10 * 60 * 1000, now = () => Date.now(), log = () => {} } = {}) {
  /** key -> { route, worker, dispose, spawnedAt, lastUsedAt, tasks } */
  const warm = new Map();
  const inflight = new Map(); // key -> Promise（防止同一路由并发预热出多条）
  // 关闭标志：`disposeAll` 之后仍在**补位中**的进程必须被就地退役，否则服务退出会漏一个孤儿进程
  // —— 本仓库有过"前台看护进程不真正退出、后台作业一轮漏一个"的事故（见隔离与验证教训 §九）。
  let disposed = false;

  const routeKey = routeKeyOf;

  const evictIfNeeded = () => {
    while (warm.size > maxWarm) {
      // 淘汰最久未用的（LRU）：路由种类少，但真出现第 3 种时不能让空闲进程无限堆积。
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of warm) if (v.lastUsedAt < oldestAt) { oldestAt = v.lastUsedAt; oldestKey = k; }
      if (!oldestKey) break;
      const v = warm.get(oldestKey);
      warm.delete(oldestKey);
      try { v.dispose(); } catch { /* 退役失败不影响池 */ }
      log('info', 'pool_evict', `热备进程退役（超出上限 ${maxWarm}，路由 ${oldestKey}）`);
    }
  };

  const warmUp = async (route) => {
    if (disposed) throw new Error('热备池已关闭，不再预热');
    const key = routeKey(route);
    if (warm.has(key)) return warm.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const t0 = now();
      const entry = await spawnWorker(route);
      // 关键：spawn 是异步的，"关闭"可能发生在它返回之前 —— 这时必须**就地退役**，
      // 绝不能塞进 warm（塞进去就再也没人会 dispose 它，服务退出后留一个孤儿 dsh 进程）。
      if (disposed) {
        try { entry.dispose(); } catch { /* 忽略 */ }
        throw new Error('热备池已关闭，刚就绪的进程已就地退役');
      }
      const rec = { route, worker: entry.worker, dispose: entry.dispose, spawnedAt: now(), lastUsedAt: now(), tasks: 0 };
      warm.set(key, rec);
      evictIfNeeded();
      log('info', 'pool_warm', `热备进程就绪（路由 ${key}，耗时 ${now() - t0}ms）`);
      return rec;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  return {
    /** 确保该路由有一条热备（幂等；已在预热中则复用同一条 Promise）。 */
    warmUp,
    /**
     * 取一条**独占**的热备进程。取不到就现起一条（此时要付冷启动，与今天的路径等价）。
     * 取出后立即在后台补一条新的热备 —— 这就是"把冷启动藏进任务自身运行时间"的地方。
     */
    async acquire(route) {
      const key = routeKey(route);
      let rec = warm.get(key);
      if (rec && !rec.worker.exited) {
        warm.delete(key);
      } else {
        if (rec) { warm.delete(key); try { rec.dispose(); } catch { /* 已死进程退役失败无害 */ } }
        rec = null;
      }
      if (!rec) {
        const t0 = now();
        const entry = await spawnWorker(route);
        rec = { route, worker: entry.worker, dispose: entry.dispose, spawnedAt: now(), lastUsedAt: now(), tasks: 0 };
        log('info', 'pool_cold', `热备为空，现起进程（路由 ${key}，耗时 ${now() - t0}ms）`);
      }
      // 后台补位：不 await，失败只记日志（下一次 acquire 会现起，退化为今天的路径）。
      warmUp(route).catch((e) => log('warn', 'pool_rewarm_failed', `热备补位失败：${e.message}`, { route: key }));
      return rec;
    },
    /** 清掉空闲过久的进程（内存回收）。返回回收条数。 */
    sweep() {
      let n = 0;
      for (const [k, v] of [...warm]) {
        if (now() - v.lastUsedAt > idleMs) {
          warm.delete(k);
          try { v.dispose(); } catch { /* 忽略 */ }
          n += 1;
        }
      }
      if (n) log('info', 'pool_sweep', `空闲热备回收 ${n} 条`);
      return n;
    },
    stats: () => ({ warm: warm.size, keys: [...warm.keys()], inflight: inflight.size, disposed }),
    /**
     * 全部退役（服务退出时调用）。**必须等补位中的进程落地再收尾**，否则会出现
     * "disposeAll 已返回、但一个刚刚 spawn 完的进程随后被塞进池里且再没人管"的孤儿。
     */
    async disposeAll() {
      disposed = true;
      const pending = [...inflight.values()];
      const all = [...warm.values()];
      warm.clear();
      for (const v of all) { try { v.dispose(); } catch { /* 忽略 */ } }
      await Promise.allSettled(pending.map((p) => p.catch(() => {})));
      // 兜底：万一仍有竞态把条目塞了进来（例如未来有人绕过 disposed 检查），这里再清一次。
      for (const v of [...warm.values()]) { try { v.dispose(); } catch { /* 忽略 */ } }
      warm.clear();
    },
  };
}
