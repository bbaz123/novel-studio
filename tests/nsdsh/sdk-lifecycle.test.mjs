/**
 * tests/nsdsh/sdk-lifecycle.test.mjs —— S13：SDK 子进程生命周期。
 *
 * 反复强调的一条：**不得发明上游方法**。锁定基线的协议面只有
 * `initialize` / `session/prompt` / `shutdown` 三个请求（出处：
 * `deepseek-harness/packages/sdk/protocol/src/types.ts` 的 `HarnessSdkRequestMap`）。
 * 本套件因此同时钉住两件事：方法**顺序正确**，且**只用了真实存在的方法**。
 */
import assert from 'node:assert/strict';
import { suiteAsync } from '../temporal/harness.mjs';

const R = await import('../../ai/runtime/dsh-sdk.mjs');

/** 假 spawner：不产生任何真实进程（因此测试里不可能有进程泄漏）。 */
function fakeSpawner() {
  const spawned = [];
  const spawn = (opts) => {
    const child = {
      pid: 4000 + spawned.length,
      opts, sent: [], killed: null, exited: false, exitCode: null,
      onExit(cb) { this._cb = cb; },
      send(msg) { this.sent.push(msg); },
      kill(sig) { this.killed = sig; this.exited = true; this.exitCode = 0; if (this._cb) this._cb(0); },
      exitGracefully() { this.exited = true; this.exitCode = 0; if (this._cb) this._cb(0); },
    };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

await suiteAsync('nsdsh/sdk-lifecycle', [
  ['S13-L1 启动顺序固定为 initialize → session/prompt，且两者都在上游协议面里', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    const r = await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2, prompt: '写', provider: 'prov', model: 'mod', cwd: '/tmp/x' });
    assert.equal(r.type, 'started');
    assert.deepEqual(r.sent, ['initialize', 'session/prompt'], '顺序必须是 initialize 先');
    for (const m of r.sent) assert.ok(R.SDK_PROTOCOL.requests.includes(m), `${m} 必须在真实协议面里`);
    // 发出的消息体也要用真实 params 形状
    const [initMsg, promptMsg] = spawned[0].sent;
    assert.equal(initMsg.method, 'initialize');
    assert.equal(initMsg.params.cwd, '/tmp/x');
    assert.equal(initMsg.params.provider, 'prov');
    assert.equal(initMsg.params.model, 'mod');
    assert.equal(promptMsg.method, 'session/prompt');
    assert.equal(typeof promptMsg.params.sessionId, 'string');
    assert.ok(Array.isArray(promptMsg.params.contentBlocks));
  }],

  ['S13-L2 默认单进程单活跃任务：并发启动第二个任务必须被拒（不是排队也不是并行）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    const r2 = await rt.startTask({ taskId: 't2', workId: 1, chapterId: 3 });
    assert.equal(r2.type, 'refused');
    assert.equal(r2.reason, 'ANOTHER_TASK_ACTIVE');
    assert.deepEqual(r2.active, ['t1']);
    assert.equal(spawned.length, 1, '不得启动第二个进程');
    assert.deepEqual(rt.canStartNewTask(), { ok: false, active: ['t1'] });
  }],

  ['S13-L3 正常结束只用 shutdown + 确认退出；退出后才允许新建（动作 4）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    // 让子进程在 shutdown 时退出
    spawned[0].send = (msg) => { spawned[0].sent.push(msg); if (msg.method === 'shutdown') spawned[0].exitGracefully(); };
    const fin = await rt.finishTask({ taskId: 't1' });
    assert.equal(fin.type, 'finished');
    assert.equal(fin.exited, true, '必须确认进程已退出');
    assert.ok(spawned[0].sent.some((m) => m.method === 'shutdown'), '正常结束用 shutdown');
    assert.deepEqual(rt.canStartNewTask(), { ok: true, active: [] }, '退出后才允许新建');
    const r2 = await rt.startTask({ taskId: 't2', workId: 1, chapterId: 3 });
    assert.equal(r2.type, 'started');
    assert.equal(spawned.length, 2);
  }],

  ['S13-L4 拒绝发明上游方法：任何不在协议面的方法名都必须抛 SDK_PROTOCOL_VIOLATION', async () => {
    for (const bogus of ['session/cancel', 'session/new', 'session/close', 'cancel', 'prompt', '']) {
      assert.throws(() => R.assertProtocolMethod(bogus), /SDK_PROTOCOL_VIOLATION/, `${bogus} 应被拒`);
    }
    // 真实存在的必须放行
    for (const ok of R.SDK_PROTOCOL.requests) assert.equal(R.assertProtocolMethod(ok), ok);
    for (const ok of R.SDK_PROTOCOL.notifications) assert.equal(R.assertProtocolMethod(ok), ok);
    // 协议面必须是冻结的常量（防止运行时被改宽）
    assert.ok(Object.isFrozen(R.SDK_PROTOCOL));
    assert.ok(Object.isFrozen(R.SDK_PROTOCOL.requests));
  }],

  ['S13-L5 无进程泄漏：正常结束与取消之后都不应被判为泄漏', async () => {
    const { spawn } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    assert.deepEqual(rt.detectLeaks(), [], '初始无泄漏');
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    await rt.cancelTask({ taskId: 't1' });
    assert.deepEqual(rt.detectLeaks(), [], '取消后不应有泄漏记录');
    // 反向对照：人为制造"状态在跑但进程已退" → 必须被 detectLeaks 抓出来
    const { spawn: sp2 } = fakeSpawner();
    const rt2 = R.createSdkRuntime({ spawn: sp2, now: () => 1 });
    await rt2.startTask({ taskId: 'x', workId: 1, chapterId: 1 });
    const t = rt2.get('x');
    t.exited = true; // 进程退了，但状态没跟着变
    assert.equal(rt2.detectLeaks().length, 1, '必须能发现"进程已退但状态仍在跑"');
    assert.equal(rt2.detectLeaks()[0].kind, 'EXITED_BUT_STATE_RUNNING');
  }],
]);
