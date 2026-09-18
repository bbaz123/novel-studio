#!/usr/bin/env node
/**
 * test-harness-pool.mjs —— 常驻 dsh 热备池的**离线**测试。
 *
 * 为什么能在不启动 dsh、不花钱的前提下测：`ai/harness-pool.mjs` 刻意不 spawn、不碰文件系统，
 * 进程与传输都由调用方注入。这里注入一个**在进程内扮演 dsh 服务端**的假 worker：
 * 它说同一套 NDJSON + JSON-RPC 2.0 协议，按脚本回 `initialize` / `session/prompt` 的
 * 响应与 `session.event` 通知。于是"正文怎么攒、终态怎么判、超时/取消/进程死亡怎么收场、
 * 热备怎么补位"全都能离线钉死。
 *
 * 纪律：每条断言都要能被变异测试打红（本文件末尾列出两个已实测的变异点）。
 *
 * 用法：node .p1-baseline/test-harness-pool.mjs
 */
import {
  routeKeyOf, foldSessionEvent, createWorker, runPromptOnWorker, createWarmPool,
} from '../ai/harness-pool.mjs';

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
// 断言助手自检：喂一个恒假条件，确认它真的会计入失败（本项目 F7 的历史教训：
// 助手签名写错会让条件根本不被求值，于是"恒判通过"而没人发现）。
// ⚠️ 这一段**不能走 check()** —— 那会往输出里打一行注定是 FAIL 的噪声，
// 让"看输出判断有没有问题"的人误以为套件坏了。直接验计数器。
{
  const probe = [];
  const fakeCheck = (name, cond) => { if (!cond) probe.push(name); };
  fakeCheck('自检', false);
  if (probe.length !== 1) { console.log('FAIL  断言助手自检：假条件没有计入失败'); process.exit(1); }
}

/** 在进程内扮演 dsh 服务端。`plan` 决定握手是否成功、每个 prompt 回什么事件。 */
function makeFakeDsh({ plan } = {}) {
  const cfg = plan || {};
  const dataCbs = [];
  const exitCbs = [];
  const sent = [];
  const state = { killed: false, exited: false, promptCount: 0 };
  // ⚠️ 同步发射：早先这里写成 `setTimeout(() => cb(...), 0)`，于是**每一层 notify 都再套一层定时器**，
  // 顺序不再是脚本里写的那样 —— "外会话消息最后到达"实际变成了"最先到达"，一个检测点就这样静默失效
  // （变异运行器实测：去掉 sessionId 过滤时 3a 竟然不变红）。现在所有顺序都由脚本里的**显式延时**决定。
  const emit = (obj) => { for (const cb of dataCbs) cb(JSON.stringify(obj) + '\n'); };
  const notify = (method, params) => emit({ jsonrpc: '2.0', method, params });
  // 事件到达顺序（毫秒）：本会话正文 0 → 工具调用 1 → 外会话消息 2 → 终态 5。
  // 终态必须最后，否则任务会在"最后一条消息"到达前就结算。
  const T_STEP = 0, T_TOOL = 1, T_FOREIGN = 2, T_END = 5;

  const io = {
    send(line) {
      sent.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === 'initialize') {
        if (cfg.handshakeFails) { emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'no adapter registered for provider "x"' } }); return; }
        emit({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });
        return;
      }
      if (msg.method === 'session/prompt') {
        state.promptCount += 1;
        emit({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'm' + state.promptCount } });
        const sid = msg.params.sessionId;
        const script = cfg.script ? cfg.script(msg, state.promptCount) : { steps: [{ text: '最终正文' }], reason: 'completed' };
        if (script.silent) return; // 永不回事件（模拟超时）
        if (script.wrongSessionFirst) notify('session.event', { sessionId: '别的会话', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '不属于本任务' }] } } } });
        (script.steps || []).forEach((s, i) => {
          setTimeout(() => {
            notify('session.event', { sessionId: sid, event: { type: 'step/start', data: { turn: 1, step: i } } });
            notify('session.event', { sessionId: sid, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: s.text }] } } } });
          }, T_STEP);
        });
        // 外会话消息**最后**到达：在"取最后一条"的语义下，只有**真的过滤了 sessionId**
        // 才能拿到本任务的正文。若不加这一条，去掉过滤的实现照样能通过（最后一条恰好是本任务的）。
        if (script.wrongSessionLast) {
          setTimeout(() => notify('session.event', { sessionId: '别的会话', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '不属于本任务' }] } } } }), T_FOREIGN);
        }
        // ⚠️ toolCall 与 reason 必须分开：早先把"有工具调用"编码成 `reason:'tool'`，
        // 于是终态变成 kind='tool' → 被 foldSessionEvent 如实判成失败。那是**测试脚本**写错了，
        // 不是实现错了 —— 这种"用一个字段兼职两种语义"的写法正是假失败的来源。
        if (script.toolCall) {
          setTimeout(() => notify('session.event', { sessionId: sid, event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: script.toolCall } } }), T_TOOL);
        }
        if (script.reason) {
          setTimeout(() => notify('session.event', {
            sessionId: sid,
            event: { type: 'turn/end', data: { reason: script.reason === 'error' ? { kind: 'error', error: { message: '模型调用失败' } } : { kind: script.reason } } },
          }), T_END);
        }
        return;
      }
      if (msg.method === 'shutdown') { emit({ jsonrpc: '2.0', id: msg.id, result: {} }); setTimeout(() => state.exited || io.kill(), 0); }
    },
    onData(cb) { dataCbs.push(cb); },
    onExit(cb) { exitCbs.push(cb); },
    kill() {
      if (state.killed) return;
      state.killed = true;
      state.exited = true;
      setTimeout(() => { for (const cb of exitCbs) cb({ code: 0, signal: null }); }, 0);
    },
    pid: 4242,
    get sent() { return sent; },
    get state() { return state; },
  };
  return io;
}

// ---------- 1) 纯函数：路由键与事件折叠 ----------
{
  check('1a 路由键把 provider/model/强度 三者都编进去（缺一则不同键）',
    routeKeyOf({ provider: 'p', model: 'm', reasoningEffort: 'high' }) !== routeKeyOf({ provider: 'p', model: 'm', reasoningEffort: '' })
      && routeKeyOf({ provider: 'p', model: 'm' }) === 'p|m|',
    routeKeyOf({ provider: 'p', model: 'm' }));

  const s0 = { text: '', finished: false, failure: null, progress: [] };
  const s1 = foldSessionEvent({ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '过程稿' }] } } } }, s0);
  const s2 = foldSessionEvent({ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终稿' }] } } } }, s1);
  // 这条断言的阴性对照：如果实现改成"累加所有 assistant/message"，它会得到"过程稿最终稿"。
  check('1b 多个 assistant/message 取**最后一条**（不累加：否则会把过程稿与正文拼在一起）',
    s2.text === '最终稿', JSON.stringify(s2.text));

  const s3 = foldSessionEvent({ event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }, s2);
  check('1c turn/end(completed) 是成功终态', s3.finished && !s3.failure);
  const s4 = foldSessionEvent({ event: { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } } }, s2);
  check('1d turn/end(max-tokens) 是**失败**终态且带原因（不能当成功交付）',
    s4.finished && !!s4.failure && s4.failure.turnReason === 'max-tokens', String(s4.failure && s4.failure.message));
  const s5 = foldSessionEvent({ event: { type: 'tool/call', data: { name: 'novel_lookup' } } }, s0);
  check('1e tool/call 折成进度行', s5.progress.length === 1 && s5.progress[0].includes('novel_lookup'), JSON.stringify(s5.progress));
}

// ---------- 2) 协议层：请求/响应配对与通知过滤 ----------
{
  const io = makeFakeDsh({ plan: { handshakeFails: false } });
  const w = createWorker(io, { defaultTimeoutMs: 1000 });
  const r = await w.request('initialize', { cwd: 'C:/x', provider: 'p', model: 'm' });
  check('2a initialize 往返：拿到 serverInfo', r && r.serverInfo && r.serverInfo.name === 'deepseek-harness-sdk-runtime', JSON.stringify(r));
  check('2b 帧是 NDJSON（一行一个 JSON，带 jsonrpc/id/method）',
    io.sent.length === 1 && io.sent[0].endsWith('\n') && JSON.parse(io.sent[0]).method === 'initialize', io.sent[0].slice(0, 60));

  const errIo = makeFakeDsh({ plan: { handshakeFails: true } });
  const errW = createWorker(errIo, { defaultTimeoutMs: 1000 });
  let handshakeErr = null;
  try { await errW.request('initialize', {}); } catch (e) { handshakeErr = e; }
  check('2c 握手失败时把 JSON-RPC error 抛成异常（调用方据此回退 spawn）',
    !!handshakeErr && handshakeErr.code === -32603, String(handshakeErr && handshakeErr.message));

  let timeoutErr = null;
  try { await errW.request('nobody_answers_this', {}, 60); } catch (e) { timeoutErr = e; }
  check('2d 请求超时会被拒绝（不是永久挂起）', !!timeoutErr && timeoutErr.timeout === true, String(timeoutErr && timeoutErr.message));
}

// ---------- 3) 任务层：正文、终态、错误、超时、取消、进程死亡 ----------
{
  const io = makeFakeDsh({
    plan: {
      script: () => ({
        // ⚠️ 只留**一个** step：3a 要单独钉住"按 sessionId 过滤"这一件事。
        // 早先这里有两个 step，于是"把 assistant/message 改成累加"这个变异也会让 3a 变红
        // （红点无法归因）—— 变异运行器把这个纠缠抓了出来。
        steps: [{ text: '第一章正文。' }],
        toolCall: 'novel_scan',
        reason: 'completed',
        wrongSessionLast: true,
      }),
    },
  });
  const w = createWorker(io, { defaultTimeoutMs: 2000 });
  await w.request('initialize', { cwd: 'C:/x', provider: 'p', model: 'm' });
  const progress = [];
  const out = await runPromptOnWorker(w, { sessionId: 'task-1', prompt: '写一章', timeoutMs: 3000, onProgress: (l) => progress.push(l) });
  check('3a 只认自己那条会话（外会话消息**最后**到达也不采纳）',
    out.text === '第一章正文。', JSON.stringify(out.text));
  check('3b 进度回调拿到工具调用行', progress.some((p) => p.includes('novel_scan')), JSON.stringify(progress));
  const promptFrame = JSON.parse(io.sent[1]);
  check('3c prompt 帧的形状与协议一致（sessionId + contentBlocks[type=text]）',
    promptFrame.method === 'session/prompt'
      && promptFrame.params.sessionId === 'task-1'
      && Array.isArray(promptFrame.params.contentBlocks)
      && promptFrame.params.contentBlocks[0].type === 'text'
      && promptFrame.params.contentBlocks[0].text === '写一章',
    JSON.stringify(promptFrame.params).slice(0, 120));

  // 同一 worker 上第二条会话必须与第一条互不串扰（结构性隔离）。
  const io2 = makeFakeDsh({
    plan: { script: (msg) => ({ steps: [{ text: '会话' + msg.params.sessionId }], reason: 'completed' }) },
  });
  const w2 = createWorker(io2, { defaultTimeoutMs: 2000 });
  await w2.request('initialize', {});
  const [a, b] = await Promise.all([
    runPromptOnWorker(w2, { sessionId: 's-a', prompt: 'A', timeoutMs: 3000 }),
    runPromptOnWorker(w2, { sessionId: 's-b', prompt: 'B', timeoutMs: 3000 }),
  ]);
  check('3d 同一进程内两条会话并发且互不串扰（一进程一会话的结构性隔离）',
    a.text === '会话s-a' && b.text === '会话s-b', JSON.stringify([a.text, b.text]));
}

{
  const io = makeFakeDsh({ plan: { script: () => ({ steps: [], reason: 'error' }) } });
  const w = createWorker(io, { defaultTimeoutMs: 2000 });
  await w.request('initialize', {});
  let e = null;
  try { await runPromptOnWorker(w, { sessionId: 't', prompt: 'x', timeoutMs: 3000 }); } catch (err) { e = err; }
  check('3e turn/end(error) 抛错且带原因（不能把失败当成功）', !!e && e.turnReason === 'error', String(e && e.message));
}

{
  const io = makeFakeDsh({ plan: { script: () => ({ silent: true }) } });
  const w = createWorker(io, { defaultTimeoutMs: 2000 });
  await w.request('initialize', {});
  let e = null;
  const t0 = Date.now();
  try { await runPromptOnWorker(w, { sessionId: 't', prompt: 'x', timeoutMs: 80 }); } catch (err) { e = err; }
  check('3f 任务超时会终止并带 HARNESS_TIMEOUT（与既有超时语义同名）',
    !!e && e.code === 'HARNESS_TIMEOUT' && Date.now() - t0 < 1500, String(e && e.code));
}

{
  const io = makeFakeDsh({ plan: { script: () => ({ silent: true }) } });
  const w = createWorker(io, { defaultTimeoutMs: 2000 });
  await w.request('initialize', {});
  const ac = new AbortController();
  const p = runPromptOnWorker(w, { sessionId: 't', prompt: 'x', timeoutMs: 3000, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  let e = null;
  try { await p; } catch (err) { e = err; }
  check('3g 外部取消会终止任务并带 HARNESS_CANCELLED', !!e && e.code === 'HARNESS_CANCELLED', String(e && e.code));
}

{
  const io = makeFakeDsh({ plan: { script: () => ({ silent: true }) } });
  const w = createWorker(io, { defaultTimeoutMs: 2000 });
  await w.request('initialize', {});
  const p = runPromptOnWorker(w, { sessionId: 't', prompt: 'x', timeoutMs: 3000 });
  setTimeout(() => io.kill(), 20);
  let e = null;
  try { await p; } catch (err) { e = err; }
  check('3h 进程中途退出会把在途任务拒绝掉（不悬挂），并标记 workerExited',
    !!e && e.workerExited === true && w.exited === true, String(e && e.message));
}

// ---------- 4) 池策略：热备、冷启动、后台补位、LRU 淘汰、空闲回收 ----------
{
  const spawns = [];
  const disposed = [];
  // 注入可控时钟：空闲回收是**时间**判据，用真实 sleep 去测它只会得到一个不稳定的断言
  // （首版就是这么写的，超时 1000ms 而只等了 30ms，于是 4d 假失败）。
  let clock = 1_000_000;
  const pool = createWarmPool({
    maxWarm: 1,
    idleMs: 60_000,
    now: () => clock,
    spawnWorker: async (route) => {
      spawns.push(routeKeyOf(route));
      const io = makeFakeDsh({});
      const w = createWorker(io, { defaultTimeoutMs: 2000 });
      await w.request('initialize', route);
      return { worker: w, dispose: () => { disposed.push(1); w.kill(); } };
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  const t0 = Date.now();
  const w1 = await pool.acquire({ provider: 'p', model: 'm', reasoningEffort: '' });
  const coldMs = Date.now() - t0;
  await settle(); // 等后台补位完成（补位是**后台**的，acquire 不等它 —— 这正是提速的来源）
  const t1 = Date.now();
  const w2 = await pool.acquire({ provider: 'p', model: 'm', reasoningEffort: '' });
  const warmMs = Date.now() - t1;
  check('4a 第二次取用命中热备（不再付一次冷启动）',
    spawns.length >= 2 && warmMs < Math.max(20, coldMs), `冷 ${coldMs}ms → 热 ${warmMs}ms，spawn=${spawns.length}`);
  await settle();
  check('4b 取用后会在后台补位（补位完成后池里重新有 1 条热备）',
    pool.stats().warm >= 1, JSON.stringify(pool.stats()));

  const another = await pool.acquire({ provider: 'p', model: 'OTHER', reasoningEffort: '' });
  await settle();
  check('4c 换模型必须走另一条进程（initialize 是进程级，不能复用），且超出上限时 LRU 淘汰',
    spawns.includes('p|OTHER|') && pool.stats().warm <= 1, JSON.stringify({ spawns, stats: pool.stats() }));

  // 4d 要单独钉住"空闲回收"：先**显式**补一条热备再快进时钟，否则它会依赖上面 acquire 的
  // 后台补位是否已完成 —— 变异运行器实测到"不补位"这个变异会把 4d 一起带红（红点无法归因）。
  await pool.warmUp({ provider: 'p', model: 'm', reasoningEffort: '' });
  await settle();
  clock += 61_000; // 快进到超过 idleMs
  const before = disposed.length;
  const warmBefore = pool.stats().warm;
  const swept = pool.sweep();
  await settle();
  check('4d 空闲超时会回收热备进程（内存不无限堆积）',
    warmBefore >= 1 && swept >= 1 && disposed.length > before, JSON.stringify({ warmBefore, swept, disposed: disposed.length }));

  // 4e：必须让**池里那条**热备死掉，才能测到"acquire 不把死进程发出去"。
  // 首版写的是"杀掉一条已经取走的进程"，那时池里那条是另起的健康进程 → 断言恒真（空断言），
  // 变异运行器实测"去掉 worker.exited 检查"时它**没有变红**。
  const warmRec = await pool.warmUp({ provider: 'p', model: 'm', reasoningEffort: '' });
  warmRec.worker.kill();
  await settle();
  const respawned = await pool.acquire({ provider: 'p', model: 'm', reasoningEffort: '' });
  check('4e 池里那条热备死掉后不会被发出去（acquire 丢弃并重起一条新的）',
    respawned.worker !== warmRec.worker && respawned.worker.exited === false,
    JSON.stringify({ sameWorker: respawned.worker === warmRec.worker, exited: respawned.worker.exited }));

  await pool.disposeAll();
  check('4f disposeAll 会把空闲热备全部退役（服务退出时不留孤儿进程）',
    pool.stats().warm === 0, JSON.stringify(pool.stats()));
}

console.log(`\n=== ${failures.length ? failures.length + ' FAILURES' : 'ALL PASS'} ===  （通过 ${passed} 条）`);
console.log(`
变异锚点由 .p1-baseline/mutation-check-harness-pool.mjs **实际执行**（改坏实现 → 跑本文件 →
确认红的集合恰好等于期望 → 还原 → 复查全绿）。不要只写锚点不跑它：本文件首版的 4e 就是
一条**空断言**（杀的是已经取走的进程，池里那条是另起的健康进程），写的时候看不出问题，
只有真的注入变异才暴露。当前已实测的锚点：
  · foldSessionEvent 改成累加 assistant/message            → 只红 1b
  · runPromptOnWorker 去掉 sessionId 过滤                  → 红 3a,3d（隔离性同一处的两个检测点）
  · createWarmPool.acquire 去掉后台补位                     → 只红 4b
  · acquire 不检查 worker.exited                            → 只红 4e
  · runPromptOnWorker 不订阅进程退出                        → 只红 3h`);
if (failures.length) process.exit(1);
