/**
 * tests/nsdsh/session-scope.test.mjs —— S13：会话作用域（**无跨任务结果混淆**）。
 *
 * 上游 `session/prompt` 的 `sessionId` 语义是"未知 id 惰性创建 agent+session 对"。
 * 因此**会话命名就是隔离边界**：只要 sessionId 里带上 (work, chapter, task)，
 * "把上一个任务的会话内容带进新作品"在命名层面就不可能发生。
 * 再加一道结果归属校验：回来的结果必须与启动它的 session 一致，否则拒收。
 */
import assert from 'node:assert/strict';
import { suiteAsync } from '../temporal/harness.mjs';

const R = await import('../../ai/runtime/dsh-sdk.mjs');

function fakeSpawner() {
  const spawned = [];
  const spawn = (opts) => {
    const child = {
      pid: 6000 + spawned.length, sent: [], exited: false, opts,
      onExit(cb) { this._cb = cb; },
      send(msg) { this.sent.push(msg); },
      kill() { this.exited = true; if (this._cb) this._cb(0); },
    };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

await suiteAsync('nsdsh/session-scope', [
  ['S13-S1 sessionId 必须带上 work / chapter / task，不同作品绝不同号', () => {
    const a = R.sessionIdFor({ workId: 1, chapterId: 2, taskId: 't1' });
    const b = R.sessionIdFor({ workId: 2, chapterId: 2, taskId: 't1' });
    const c = R.sessionIdFor({ workId: 1, chapterId: 3, taskId: 't1' });
    const d = R.sessionIdFor({ workId: 1, chapterId: 2, taskId: 't2' });
    for (const [x, y] of [[a, b], [a, c], [a, d], [b, c]]) assert.notEqual(x, y);
    assert.match(a, /^ns:1:2:t1$/);
    // 缺 task 时也要给出稳定值（不能变成 undefined 串进会话名）
    assert.equal(R.sessionIdFor({ workId: 1, chapterId: 2 }), 'ns:1:2:adhoc');
    assert.ok(!R.sessionIdFor({}).includes('undefined'));
  }],

  ['S13-S2 结果归属校验：session 不匹配必须拒收（防跨任务混淆）', async () => {
    const { spawn } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 7, chapterId: 3, prompt: 'x' });
    const session = rt.get('t1').session_id;

    const good = rt.resolveResult({ taskId: 't1', sessionId: session, text: '正文' });
    assert.equal(good.accepted, true);
    assert.equal(good.work_id, 7);
    assert.equal(good.chapter_id, 3);

    const bad = rt.resolveResult({ taskId: 't1', sessionId: 'ns:8:3:t1', text: '别人的正文' });
    assert.equal(bad.accepted, false);
    assert.equal(bad.reason, 'SESSION_MISMATCH', '不同 session 的结果必须被拒收');

    const unknown = rt.resolveResult({ taskId: 'nope', sessionId: session });
    assert.equal(unknown.accepted, false);
    assert.equal(unknown.reason, 'UNKNOWN_TASK');
  }],

  ['S13-S3 同一作品不同章节、不同任务各自独立会话（并发被拒，但命名互不覆盖）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 't1', workId: 1, chapterId: 2 });
    const s1 = spawned[0].sent.find((m) => m.method === 'session/prompt').params.sessionId;
    await rt.cancelTask({ taskId: 't1' });
    await rt.startTask({ taskId: 't2', workId: 1, chapterId: 3 });
    const s2 = spawned[1].sent.find((m) => m.method === 'session/prompt').params.sessionId;
    assert.notEqual(s1, s2, '不同章节的任务不能共用一个会话');
    assert.equal(s1, 'ns:1:2:t1');
    assert.equal(s2, 'ns:1:3:t2');
  }],

  ['S13-S4 换作品启动时，新会话名不含旧作品信息（同一进程内也不串）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 'a', workId: 1, chapterId: 1, prompt: '作品一的内容' });
    await rt.cancelTask({ taskId: 'a' });
    await rt.startTask({ taskId: 'b', workId: 2, chapterId: 1, prompt: '作品二的内容' });
    const p2 = spawned[1].sent.find((m) => m.method === 'session/prompt').params;
    assert.equal(p2.sessionId, 'ns:2:1:b');
    // 按**作品前缀**判断（不能用 includes(':1:') —— 那会误命中章节号）
    assert.ok(!p2.sessionId.startsWith('ns:1:'), '新作品会话名不得以旧作品 id 为前缀');
    // 提示内容也是本任务自己的（不是上一个任务的）
    assert.equal(p2.contentBlocks[0].text, '作品二的内容');
    // 旧任务的结果不能记到新任务上
    const wrong = rt.resolveResult({ taskId: 'b', sessionId: 'ns:1:1:a', text: '作品一' });
    assert.equal(wrong.accepted, false);
  }],

  ['S13-S5 sessionId 进 env 且与 prompt 里的一致（同一任务只有一种会话身份）', async () => {
    const { spawn, spawned } = fakeSpawner();
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    const r = await rt.startTask({ taskId: 'z', workId: 5, chapterId: 6, cwd: '/w' });
    const envSession = spawned[0].opts.env.NOVELSTUDIO_SESSION;
    const promptSession = spawned[0].sent.find((m) => m.method === 'session/prompt').params.sessionId;
    assert.equal(envSession, promptSession, 'env 与 protocol 里的会话身份必须一致');
    assert.equal(r.sessionId, promptSession);
  }],
]);
