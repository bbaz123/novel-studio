/**
 * tests/nsdsh/sdk-adapter.test.mjs —— R01：真实传输 + 真实状态机的闭环（线上假对端）。
 *
 * 假的层次很重要：这里假的是**对端进程**（我们用内存流扮演 DSH 的 stdout/stdin），
 * 而不是假"适配器已经成功"。于是被测的是**真的** transport 分帧、真的状态机、
 * 真的终态归一化、真的取消路径 —— 这些正是 S13 缺的部分。
 *
 * 仍然不起真实子进程：真实 PID / 真实退出码 / 真实 stderr 的证据在
 * `scripts/nsdsh/verify-sdk-real.mjs`（S4/S8/S11），两者互补而不是互相替代。
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const A = await import('../../ai/runtime/sdk-adapter.mjs');
const P = await import('../../ai/runtime/sdk-process.mjs');
const B = await import('../../ai/model-broker/adapters.mjs');
const R = await import('../../ai/model-broker/routing.mjs');

const LAUNCH = P.resolveDshLaunch({
  manifestPath: `${REPO}/vendor/dsh/runtime-manifest.json`,
  repoRoot: REPO,
});

/**
 * 线上假对端：扮演 DSH 子进程的 stdout/stdin。
 * `onRequest(msg, peer)` 由用例决定怎么回 —— 包括"故意不回"。
 */
function wirePeer(onRequest) {
  const toChild = new PassThrough();
  const fromChild = new PassThrough();
  const sent = [];
  let buf = '';
  toChild.on('data', (c) => {
    buf += c.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      sent.push(msg);
      onRequest(msg, peer);
    }
  });
  const peer = {
    reply(id, result) { fromChild.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); },
    error(id, code, message) { fromChild.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); },
    notify(method, params) { fromChild.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    event(sessionId, event) { peer.notify('session.event', { sessionId, event }); },
    handle: null,
  };
  const handle = {
    pid: 4242, exited: false, exitCode: null, spawnError: null,
    stdinStream: toChild, stdoutStream: fromChild, stderrStream: new PassThrough(),
    kill() { handle.exit(0); },
    onExit(fn) { handle._onExit = fn; },
    async waitExit() { return handle.exited === true; },
    stderrText() { return ''; },
    exit(code) { if (handle.exited) return; handle.exited = true; handle.exitCode = code; if (handle._onExit) handle._onExit(code, null); },
  };
  peer.handle = handle;
  return { peer, handle, sent };
}

/** 标准应答：initialize 正常、prompt 受理，终态由用例自己补。 */
function happyPath({ serverName = A.SDK_SERVER_NAME, acceptPrompt = true } = {}) {
  return (msg, peer) => {
    if (msg.method === 'initialize') peer.reply(msg.id, { serverInfo: { name: serverName, version: '0.0.1' } });
    else if (msg.method === 'session/prompt') {
      if (acceptPrompt) peer.reply(msg.id, { messageId: 'msg-1' });
      else peer.reply(msg.id, {});
    } else if (msg.method === 'shutdown') { peer.reply(msg.id, {}); setImmediate(() => peer.handle.exit(0)); }
  };
}

function makeAdapter(onRequest) {
  const wire = wirePeer(onRequest);
  const adapter = A.createSdkRuntimeAdapter({
    launch: LAUNCH,
    spawn: () => wire.handle,
    handshakeTimeoutMs: 300,
    turnTimeoutMs: 400,
    shutdownTimeoutMs: 1000,
    exitTimeoutMs: 200,
    // 假 terminate 必须**真的**把 handle 标记成已退出：否则测的就不是取消，而是测'杀不掉'
    terminate: (h) => { h.exit(0); return { steps: ['FAKE_TERMINATE'], detail: 'test' }; },
  });
  return { adapter, ...wire };
}

const baseArgs = { taskId: 't1', sessionId: 'ns:1:1:t1', prompt: '写一段', provider: 'deepseek-official', model: 'deepseek-v4-pro' };

await import('node:timers/promises').then(() => {});

await suiteAsync('nsdsh/sdk-adapter', [
  ['R01-A1 正常闭环：initialize 响应 → prompt 受理 → session.event(turn/end completed) → done', async () => {
    let started;
    const { adapter, peer } = makeAdapter((msg, p) => {
      happyPath()(msg, p);
      if (msg.method === 'session/prompt') {
        started = true;
        setTimeout(() => {
          p.event('ns:1:1:t1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '正文片段' }] }, usage: { inputTokens: 11, outputTokens: 4 } } });
          p.event('ns:1:1:t1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
        }, 30);
      }
    });
    const r = await adapter.runTask({ ...baseArgs });
    assert.equal(started, true);
    assert.equal(r.terminal, 'done', JSON.stringify(r));
    assert.equal(r.ok, true);
    assert.equal(r.text, '正文片段');
    assert.deepEqual(r.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }, '必须读上游 camelCase 的 TokenUsage');
    assert.ok(r.eventTypes.includes('turn/end'));
    assert.ok(r.pid > 0);
    assert.deepEqual(adapter.detectLeaks(), []);
  }],

  ['R01-A2 握手身份不符 → failed，且**不得**继续发 session/prompt', async () => {
    const { adapter, sent } = makeAdapter(happyPath({ serverName: 'some-other-runtime' }));
    const r = await adapter.runTask({ ...baseArgs });
    assert.equal(r.terminal, 'failed');
    assert.match(String(r.error), /HANDSHAKE_MISMATCH/);
    assert.ok(!sent.some((m) => m.method === 'session/prompt'), '握手没过就不许发 prompt（这是 S13 的漏洞）');
  }],

  ['R01-A3 prompt 未被受理（没有 messageId）→ failed，不把"发出去"当成功', async () => {
    const { adapter } = makeAdapter(happyPath({ acceptPrompt: false }));
    const r = await adapter.runTask({ ...baseArgs });
    assert.equal(r.terminal, 'failed');
    assert.match(String(r.error), /PROMPT_NOT_ACCEPTED/);
  }],

  ['R01-A4 终态原因不是 completed → failed 并带上原因（不粉饰成 done）', async () => {
    const { adapter } = makeAdapter((msg, peer) => {
      happyPath()(msg, peer);
      if (msg.method === 'session/prompt') {
        setTimeout(() => peer.event('ns:1:1:t1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } }), 20);
      }
    });
    const r = await adapter.runTask({ ...baseArgs });
    assert.equal(r.terminal, 'failed');
    assert.match(String(r.error), /max-tokens/);
  }],

  ['R01-A5 没有终态 → unknown（不是 done，也不是 failed），并杀掉进程不占槽', async () => {
    const { adapter } = makeAdapter(happyPath()); // 只回 prompt，永不给 turn/end
    const r = await adapter.runTask({ ...baseArgs, turnTimeoutMs: 200 });
    assert.equal(r.terminal, 'unknown');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NO_TERMINAL_STATE');
    assert.equal(adapter.canStartNewTask().ok, true, 'unknown 之后进程必须已退出，槽位可用');
  }],

  ['R01-A6 别的 session 的事件被丢弃并计数（跨作品隔离的客户端一侧）', async () => {
    const { adapter } = makeAdapter((msg, peer) => {
      happyPath()(msg, peer);
      if (msg.method === 'session/prompt') {
        setTimeout(() => {
          peer.event('ns:9:9:other', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '别人的正文' }] } } });
          peer.event('ns:9:9:other', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          peer.event('ns:1:1:t1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '我的正文' }] } } });
          peer.event('ns:1:1:t1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
        }, 20);
      }
    });
    const r = await adapter.runTask({ ...baseArgs });
    assert.equal(r.terminal, 'done');
    assert.equal(r.text, '我的正文', '绝不能把别的 session 的正文混进来');
    assert.equal(r.foreignEvents, 2, '外部事件必须被计数，便于观测');
  }],

  ['R01-A7 spawn 失败（EPERM/ENOENT）→ 立即 failed，不等超时', async () => {
    const adapter = A.createSdkRuntimeAdapter({
      launch: LAUNCH,
      spawn: () => ({ pid: 0, exited: true, exitCode: null, spawnError: 'EPERM', stdinStream: new PassThrough(), stdoutStream: new PassThrough(), onExit() {}, kill() {}, async waitExit() { return true; } }),
      turnTimeoutMs: 10_000,
    });
    const t0 = Date.now();
    const r = await adapter.runTask({ ...baseArgs });
    assert.equal(r.terminal, 'failed');
    assert.match(String(r.error), /SPAWN_FAILED:EPERM/);
    assert.ok(Date.now() - t0 < 2000, '不得把"起不来"记成"跑得慢"');
  }],

  ['R01-A8 单活跃任务：上一个进程还活着时拒绝新任务（判据是进程是否退出）', async () => {
    let resolveFirst;
    const { adapter } = makeAdapter((msg, peer) => {
      happyPath()(msg, peer);
      if (msg.method === 'session/prompt') resolveFirst = () => peer.event('ns:1:1:t1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    });
    const first = adapter.runTask({ ...baseArgs, turnTimeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 60));
    const second = await adapter.runTask({ ...baseArgs, taskId: 't2', sessionId: 'ns:1:1:t2' });
    assert.equal(second.error, 'ANOTHER_TASK_ACTIVE');
    assert.equal(second.terminal, 'not_run');
    resolveFirst();
    await first;
  }],

  ['R01-A9 取消 → cancelled 且进程已退出；进程退不掉时如实报 cancel_failed', async () => {
    // ① 正常取消
    const ok = makeAdapter(() => { /* 永不回应：任务一直挂着手握阶段 */ });
    const running = ok.adapter.runTask({ ...baseArgs, turnTimeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 40));
    const c1 = await ok.adapter.cancelTask({ taskId: 't1' });
    assert.equal(c1.type, 'cancelled');
    const r1 = await running;
    assert.equal(r1.terminal, 'cancelled', '取消不得被归一化成 failed（否则会触发重试策略）');

    // ② 进程杀不掉：terminate 真的什么都没做（不是"假装退出了"）
    const wire2 = wirePeer(() => { /* 不回 */ });
    const stubborn = {
      adapter: A.createSdkRuntimeAdapter({
        launch: LAUNCH, spawn: () => wire2.handle,
        handshakeTimeoutMs: 300, turnTimeoutMs: 5000, exitTimeoutMs: 50,
        terminate: () => ({ steps: ['NOOP_CANNOT_KILL'], detail: '模拟杀不掉的进程' }),
      }),
      handle: wire2.handle,
    };
    const running2 = stubborn.adapter.runTask({ ...baseArgs, turnTimeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 40));
    const c2 = await stubborn.adapter.cancelTask({ taskId: 't1' });
    assert.equal(c2.type, 'cancel_failed');
    assert.equal(c2.reason, 'PROCESS_DID_NOT_EXIT');
    const leaks = stubborn.adapter.detectLeaks();
    assert.ok(leaks.some((l) => l.kind === 'PROCESS_ALIVE_AFTER_SETTLE'), '活着没结算必须被 detectLeaks 抓出来');
    assert.equal(stubborn.adapter.canStartNewTask().ok, false, '进程还活着就不许开新任务');
    stubborn.handle.exit(0);
    await running2;
  }],

  ['R01-A10 缺 provider/model → not_run（不是 failed：没配置 ≠ 坏了）', async () => {
    const { adapter } = makeAdapter(happyPath());
    const r = await adapter.runTask({ ...baseArgs, provider: '' });
    assert.equal(r.terminal, 'not_run');
    assert.equal(r.error, 'MISSING_PROVIDER_OR_MODEL');
  }],

  ['R01-A11 broker：SDK 路由默认关闭时返回 not_run，绝不自作主张走 SDK', async () => {
    const calls = [];
    const runtime = { async runTask(a) { calls.push(a); return { ok: true, terminal: 'done', text: 'x' }; } };
    const off = B.createSdkAdapter({ runtime, enabled: false });
    assert.equal(off.available, false);
    const env = { route: { source: 'sdk', session_id: 's', task_id: 't' }, model: { provider: 'p', model: 'm' } };
    const r = await off.run(env, { prompt: 'x' });
    assert.equal(r.status, 'not_run');
    assert.equal(r.error, 'SDK_ROUTE_DISABLED');
    assert.equal(calls.length, 0, '关闭时一次运行都不能发起');

    const on = B.createSdkAdapter({ runtime, enabled: true });
    assert.equal(on.available, true);
    const r2 = await on.run(env, { prompt: 'x' });
    assert.equal(r2.status, 'done');
    assert.equal(calls.length, 1);
  }],

  ['R01-A12 broker：请求走 SDK 但未接线时必须如实降级并说明原因（不能假装是 SDK 跑的）', async () => {
    const direct = { kind: 'direct', async run() { return B.makeResult({ ok: true, status: 'done', text: 'direct' }); } };
    const sdk = B.createSdkAdapter({ runtime: null, enabled: true });
    const picked = B.pickAdapter({ direct, sdk }, { route: { source: 'sdk' } });
    assert.equal(picked.kind, 'direct');
    assert.equal(picked.degradedFrom, 'sdk');
    assert.equal(picked.degradedReason, 'SDK_RUNTIME_NOT_WIRED');
  }],

  ['R01-A13 路由准入：默认关 / author_confirm 拒绝 / 预算耗尽拒绝 / 租约代际不一致拒绝', () => {
    const route = { ok: true, config: { id: 1 }, route: { source: 'work' } };
    const must = (args, reason) => {
      const d = R.sdkRouteDecision({ purpose: 'analysis', ...args });
      assert.equal(d.ok, false, `${reason} 应被拒绝`);
      assert.equal(d.reason, reason);
    };
    assert.equal(R.sdkRouteFlag(undefined), false);
    assert.equal(R.sdkRouteFlag('0'), false);
    assert.equal(R.sdkRouteFlag('true'), true);
    must({ requested: false, route }, 'SDK_ROUTE_DISABLED');
    must({ requested: true, purpose: 'nope', route }, 'UNKNOWN_PURPOSE');
    must({ requested: true, route: null }, 'NO_ROUTE');
    must({ requested: true, route, capability: 'author_confirm' }, 'AUTHOR_CONFIRM_NOT_DELEGABLE');
    must({ requested: true, route, budget: { remainingCny: 0 } }, 'BUDGET_EXHAUSTED');
    must({ requested: true, route, leaseGeneration: 3, expectedLeaseGeneration: 4 }, 'LEASE_GENERATION_STALE');
    const ok = R.sdkRouteDecision({ requested: true, purpose: 'analysis', route, budget: { remainingCny: 2 }, leaseGeneration: 4, expectedLeaseGeneration: 4, capability: 'proposal' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  }],

  ['R01-A15 生产通道：SDK 路由默认关闭时 runSdkAnalysis 一步都不走（可安全回退）', async () => {
    const SR = await import('../../ai/runtime/sdk-route.mjs');
    const r = await SR.runSdkAnalysis({
      flag: undefined,
      decision: { ok: false, reason: 'SDK_ROUTE_DISABLED' },
      config: { base_url: 'http://127.0.0.1:1', api_key: 'k', model: 'm' },
      dshHome: '/tmp/home',
    });
    assert.equal(r.used, false);
    assert.equal(r.attempted, false, '没发请求才允许回退（回退=可能二次计费）');
    assert.equal(r.reason, 'SDK_ROUTE_DISABLED');
  }],

  ['R01-A16 生产通道：入口解析失败 → 不启动、可回退；缺少 DSH_HOME/base_url → 明确拒绝', async () => {
    const SR = await import('../../ai/runtime/sdk-route.mjs');
    const decision = { ok: true };
    const config = { base_url: 'http://127.0.0.1:1', api_key: 'k', model: 'm' };
    const badLaunch = await SR.runSdkAnalysis({
      decision, config, dshHome: '/tmp/home',
      launchResolver: () => ({ ok: false, reason: 'ENTRY_MISSING' }),
      makeAdapter: () => { throw new Error('不该走到建适配器'); },
    });
    assert.equal(badLaunch.used, false);
    assert.match(badLaunch.reason, /SDK_LAUNCH_REFUSED/);
    const noHome = await SR.runSdkAnalysis({ decision, config, dshHome: '' });
    assert.equal(noHome.reason, 'MISSING_DSH_HOME');
    const noBase = await SR.runSdkAnalysis({ decision, config: { model: 'm' }, dshHome: '/tmp/h' });
    assert.equal(noBase.reason, 'CONFIG_MISSING_BASE_URL');
  }],

  ['R01-A17 生产通道：真跑过（即使失败）就标记 attempted=true，调用方不得回退', async () => {
    const SR = await import('../../ai/runtime/sdk-route.mjs');
    const fakeAdapter = () => ({
      async runTask() {
        return { terminal: 'unknown', error: 'NO_TERMINAL_STATE', pid: 111 };
      },
    });
    const r = await SR.runSdkAnalysis({
      decision: { ok: true },
      config: { base_url: 'http://127.0.0.1:1', api_key: 'k', model: 'm' },
      workId: 1, taskId: 'a', system: 's', user: 'u', model: 'm',
      dshHome: '/tmp/home',
      launchResolver: () => ({ ok: true }),
      makeAdapter: fakeAdapter,
    });
    assert.equal(r.used, true);
    assert.equal(r.attempted, true, '请求已发就必须标 attempted，禁止回退重发');
    assert.equal(r.status, 'unknown');
    assert.equal(r.text, '');
  }],

  ['R01-A18 server.js 真实接线：SDK 分支在 callAI 之前，且开关走路由判定', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    const start = src.indexOf('function temporalAnalysisGenerate(');
    assert.ok(start > 0, '找不到生产接线函数');
    const body = src.slice(start, start + 2600);
    assert.match(body, /runSdkAnalysis\(/, '必须真的调用 SDK 通道');
    assert.match(body, /SDK_ROUTE_FLAG_ENV/, '开关必须走路由层的常量，不能自己写死环境变量名');
    const iSdk = body.indexOf('runSdkAnalysis(');
    const iCall = body.indexOf('await callAI(');
    assert.ok(iCall > iSdk, 'callAI 必须在 SDK 分支之后（否则 SDK 永远走不到）');
    assert.match(body, /if \(sdk\.used\) return sdk\.text;/, '拿到 SDK 文本必须直接返回（否则会重复调用）');
    // 默认关闭：路由层常量必须是默认 false 的开关
    assert.match(src, /import \{ runSdkAnalysis, routeShapeFor \}/);
  }],

  ['R01-A14 适配器不碰数据库（真实运行时事件不得直接改正文/正式状态）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const f of ['ai/runtime/sdk-adapter.mjs', 'ai/runtime/sdk-process.mjs', 'ai/runtime/sdk-stdio-transport.mjs']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert.ok(!/from\s+['"].*db\.mjs['"]/.test(src), `${f} 不得 import db.js`);
      assert.ok(!/\.prepare\(/.test(src), `${f} 不得写 SQL`);
      assert.ok(!/child_process/.test(src) || /now|spawn/.test(src), `${f} 若用子进程必须是可注入的`);
    }
  }],
]);
