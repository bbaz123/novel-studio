/**
 * tests/nsdsh/sdk-cancel.test.mjs —— S13：取消语义（**无假取消 API**）。
 *
 * 上游 SDK 协议面**没有 `session/cancel`**。所以"取消"唯一诚实的实现是
 * **终止那个独占进程**，并**确认它真的退出了**。
 * 本套件钉住三件事：
 *   ① 取消走 kill，而不是发一个不存在的协议方法；
 *   ② 取消后必须**确认退出**（否则是"假取消"）；
 *   ③ 取消一个任务不影响别的任务的状态（不误伤）。
 */
import assert from 'node:assert/strict';
import { suiteAsync } from '../temporal/harness.mjs';

const R = await import('../../ai/runtime/dsh-sdk.mjs');

function fakeSpawner({ killWorks = true } = {}) {
  const spawned = [];
  const spawn = () => {
    const child = {
      pid: 5000 + spawned.length, sent: [], killed: null, exited: false, exitCode: null,
      onExit(cb) { this._cb = cb; },
      send(msg) { this.sent.push(msg); },
      kill(sig) {
        this.killed = sig;
        if (killWorks) { this.exited = true; this.exitCode = 0; if (this._cb) this._cb(0); }
      },
    };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

await suiteAsync('nsdsh/sdk-cancel', [
  ['S13-C1 取消 = 终止独占进程（不是发一个不存在的 cancel 请求）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2, prompt: 'x' });
    const before = spawned[0].sent.map((m) => m.method);
    const r = await rt.cancelTask({ taskId: 't1' });
    assert.equal(r.type, 'cancelled');
    assert.equal(r.via, 'kill_process', '取消必须走杀进程');
    assert.equal(spawned[0].killed, 'SIGTERM', '必须真的发了终止信号');
    // 取消过程中**不得**新增任何协议方法调用
    assert.deepEqual(spawned[0].sent.map((m) => m.method), before, '取消不得引入新的协议方法');
    assert.ok(!spawned[0].sent.some((m) => m.method === 'session/cancel'), '绝不能发 session/cancel');
  }],

  ['S13-C2 取消后必须确认进程真的退出（否则是假取消）', async () => {
    // 子进程"杀不动"：kill 不置 exited
    const { spawn } = fakeSpawner({ killWorks: false });
    const rt = R.createSdkRuntime({ spawn, now: () => Date.now() });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    const r = await rt.cancelTask({ taskId: 't1', reason: 'timeout' });
    assert.equal(r.type, 'cancel_failed', '进程没退出时不能谎报已取消');
    assert.equal(r.reason, 'PROCESS_DID_NOT_EXIT');
    assert.equal(rt.get('t1').state, R.SDK_TASK_STATE.FAILED);
    // 因为没确认退出，仍视为"有活跃任务"，不允许新建
    assert.equal(rt.canStartNewTask().ok, false, '未确认退出前不得新建任务');
  }],

  ['S13-C3 取消不误伤：已结束的任务不受影响，未知任务安全跳过', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    spawned[0].kill('SIGTERM');
    // 再取消一次：已经退出的，跳过而不是重杀
    const again = await rt.cancelTask({ taskId: 't1' });
    assert.equal(again.type, 'cancel_skipped');
    assert.equal(again.reason, 'ALREADY_EXITED');
    // 未知任务：安全跳过（不抛、不误杀）
    const unknown = await rt.cancelTask({ taskId: 'nope' });
    assert.equal(unknown.type, 'cancel_skipped');
    assert.equal(unknown.reason, 'UNKNOWN_TASK');
  }],

  ['S13-C4 取消一个任务后，另一个任务可正常启动且互不影响（单活跃模型的正确语义）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    await rt.cancelTask({ taskId: 't1' });
    const r2 = await rt.startTask({ taskId: 't2', workId: 1, chapterId: 3 });
    assert.equal(r2.type, 'started', 't1 取消后 t2 必须能启动');
    // t1 的记录保持"已退出"，不被 t2 的启动覆盖
    assert.equal(rt.get('t1').state, R.SDK_TASK_STATE.EXITED);
    assert.equal(rt.get('t1').exited, true);
    assert.notEqual(rt.get('t2').pid, rt.get('t1').pid, '两个任务必须是不同进程');
    assert.deepEqual(rt.detectLeaks(), []);
  }],

  ['S13-C5 协议事实自证：上游没有 cancel 方法，因此实现里也不得出现', async () => {
    assert.ok(!R.SDK_PROTOCOL.requests.includes('session/cancel'), '协议面里不得有 session/cancel');
    assert.ok(!R.SDK_PROTOCOL.notifications.includes('session/cancel'));
    // 源码级：不得把 session/cancel 当成可发送的方法
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { REPO } = await import('../../scripts/nsdsh/lib/isolate.mjs');
    const src = fs.readFileSync(path.join(REPO, 'ai/runtime/dsh-sdk.mjs'), 'utf8');
    const sendsCancel = /send\(\s*\{[^}]*method:\s*['"]session\/cancel['"]/.test(src);
    assert.equal(sendsCancel, false, '不得发送 session/cancel');
  }],
]);
