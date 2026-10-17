/**
 * tests/nsdsh/sdk-transport.test.mjs —— R01：逐行 JSON-RPC 传输（真实分帧规则）。
 *
 * 这一层最容易出的两个错，本套件专门钉：
 *   ① **假设"一次 data = 一条完整帧"** —— 真实管道里一帧会被拆成任意多段；
 *   ② **一个坏帧把连接弄死** —— 上游的做法是"忽略非 JSON 行"，我们也必须一样，
 *      否则一段诊断输出混进 stdout 就能让整个任务失败。
 *
 * 只用内存流（PassThrough），不起子进程。
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { suiteAsync } from '../temporal/harness.mjs';

const T = await import('../../ai/runtime/sdk-stdio-transport.mjs');

/** 建一对内存流 + 传输；`out` 是"对端会读到的东西"，`peer` 是"对端说的话"。 */
function bench({ maxFrameBytes } = {}) {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  const written = [];
  let buf = '';
  toPeer.on('data', (c) => {
    buf += c.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const p of parts) if (p.trim()) written.push(JSON.parse(p));
  });
  const tr = T.createStdioTransport({ input: fromPeer, output: toPeer, ...(maxFrameBytes ? { maxFrameBytes } : {}) });
  const say = (obj) => fromPeer.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  return { tr, written, say, toPeer, fromPeer };
}

const okFrame = (id, result) => ({ jsonrpc: '2.0', id, result });

await suiteAsync('nsdsh/sdk-transport', [
  ['R01-T1 一帧被拆成三段到达仍然正确关联（禁止假设一次 data 即一帧）', async () => {
    const b = bench();
    const p = b.tr.request('initialize', { cwd: '/x' }, { timeoutMs: 3000 });
    assert.equal(b.written.length, 1, '请求必须立刻按一行写出');
    assert.equal(b.written[0].jsonrpc, '2.0');
    assert.equal(b.written[0].method, 'initialize');
    assert.deepEqual(b.written[0].params, { cwd: '/x' });
    const line = `${JSON.stringify(okFrame(b.written[0].id, { serverInfo: { name: 'deepseek-harness-sdk-runtime' } }))}\r\n`;
    b.fromPeer.write(line.slice(0, 7));
    b.fromPeer.write(line.slice(7, 19));
    b.fromPeer.write(line.slice(19));
    const r = await p;
    assert.equal(r.serverInfo.name, 'deepseek-harness-sdk-runtime');
    assert.equal(b.tr.pendingCount, 0);
    b.tr.close('test');
  }],

  ['R01-T2 行尾 \\r 必须吃掉（Windows 文本模式会带它）', async () => {
    const b = bench();
    const p = b.tr.request('shutdown', undefined, { timeoutMs: 3000 });
    b.fromPeer.write(`${JSON.stringify(okFrame(b.written[0].id, {}))}\r\n`);
    assert.deepEqual(await p, {});
    b.tr.close('test');
  }],

  ['R01-T3 非 JSON 噪音行被忽略，不影响后续正常帧', async () => {
    const b = bench();
    const p = b.tr.request('initialize', {}, { timeoutMs: 3000 });
    b.fromPeer.write('WARNING: some diagnostic leaked to stdout\n');
    b.fromPeer.write('{ not json at all\n');
    b.fromPeer.write(`${JSON.stringify(okFrame(b.written[0].id, { ok: 1 }))}\n`);
    assert.deepEqual(await p, { ok: 1 });
    assert.equal(b.tr.stats().ignored, 2, '两条噪音都要记入 ignored（可观测，不是静默吞掉）');
    b.tr.close('test');
  }],

  ['R01-T4 错误响应 → SdkRpcError 保留线上 code 与 message', async () => {
    const b = bench();
    const p = b.tr.request('session/cancel', { sessionId: 'x' }, { timeoutMs: 3000 });
    b.fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', id: b.written[0].id, error: { code: -32603, message: 'unknown DeepSeek Harness SDK runtime method: session/cancel' } })}\n`);
    await assert.rejects(p, (e) => {
      assert.equal(e.name, 'SdkRpcError');
      assert.equal(e.code, -32603);
      assert.match(e.message, /session\/cancel/);
      return true;
    });
    b.tr.close('test');
  }],

  ['R01-T5 请求超时 → SdkTimeoutError，且挂起表必须清空（不留永不 settle 的 Promise）', async () => {
    const b = bench();
    const p = b.tr.request('initialize', {}, { timeoutMs: 30 });
    await assert.rejects(p, (e) => e.name === 'SdkTimeoutError' && e.method === 'initialize');
    assert.equal(b.tr.pendingCount, 0, '超时后不得残留挂起项');
    b.tr.close('test');
  }],

  ['R01-T6 超大帧 → 传输判死并拒绝挂起请求（不无限缓冲）', async () => {
    const b = bench({ maxFrameBytes: 200 });
    const p = b.tr.request('initialize', {}, { timeoutMs: 5000 });
    b.fromPeer.write('y'.repeat(400));
    await assert.rejects(p, (e) => e.name === 'SdkFrameTooLarge');
    assert.ok(b.tr.failure, '传输必须记录失败原因');
    b.tr.close('test');
  }],

  ['R01-T7 通知按方法名分发；session.event 的 params 原样给出', async () => {
    const b = bench();
    const seen = [];
    b.tr.onNotification((m, p) => seen.push([m, p.sessionId, p.event && p.event.type]));
    b.fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'ns:1:1:t', event: { type: 'turn/end' } } })}\n`);
    b.fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'ns:1:1:t', status: 'idle' } })}\n`);
    assert.deepEqual(seen, [['session.event', 'ns:1:1:t', 'turn/end'], ['session.status', 'ns:1:1:t', undefined]]);
    b.tr.close('test');
  }],

  ['R01-T8 迟到/未知 id 的响应被丢弃而不是错配给别的请求', async () => {
    const b = bench();
    const p = b.tr.request('initialize', {}, { timeoutMs: 3000 });
    b.fromPeer.write(`${JSON.stringify(okFrame('req_999', { wrong: true }))}\n`);
    b.fromPeer.write(`${JSON.stringify(okFrame(b.written[0].id, { right: true }))}\n`);
    assert.deepEqual(await p, { right: true });
    b.tr.close('test');
  }],

  ['R01-T9 对端反向请求一律回 -32601（不静默挂着）', async () => {
    const b = bench();
    b.fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv_1', method: 'ui/ask', params: {} })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const reply = b.written.find((m) => m.id === 'srv_1');
    assert.ok(reply && reply.error && reply.error.code === -32601, '必须明确回 method not found');
    b.tr.close('test');
  }],

  ['R01-T10 close() 拒绝所有挂起请求（进程被杀时不会有人永远等）', async () => {
    const b = bench();
    const p = b.tr.request('session/prompt', {}, { timeoutMs: 5000 });
    b.tr.close('PEER_GONE');
    await assert.rejects(p, /PEER_GONE|closed/i);
    assert.equal(b.tr.pendingCount, 0);
  }],

  ['R01-T11 输入流结束 → 挂起请求立刻失败（不是等超时）', async () => {
    const b = bench();
    const p = b.tr.request('initialize', {}, { timeoutMs: 5000 });
    b.fromPeer.end();
    await assert.rejects(p, /INPUT_CLOSED/);
    assert.equal(b.tr.pendingCount, 0);
  }],
]);
