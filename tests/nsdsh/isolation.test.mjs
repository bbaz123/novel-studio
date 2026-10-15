/**
 * tests/nsdsh/isolation.test.mjs —— 隔离夹具与网络拒绝的**断言面**（S01，零依赖、零计费）。
 *
 * 这个套件回答四个问题，其中每个都必须能"真的失败"（否则就是恒真断言）：
 *   1. 隔离夹具会不会把数据落到系统临时目录之外 / 真实 `data/`？
 *   2. `assertIsolated` 在"忘了建环境"和"指向真实库"时会不会真的炸？
 *   3. `pickFreePort` 给的是不是空闲端口、且**绝不是 3737**？
 *   4. 出网 guard 会不会拦住非回环、同时**不误拦**合法回环（阴性对照）？
 *
 * 关于第 4 条的"实证"方式（本机受限沙箱的实测事实）：DSH 文件沙箱会拦掉**子进程的 HTTP**
 * （`fetch` / `http.get` 零响应直到超时），但裸 TCP `net.connect` 仍然可用。因此"证明假模型收到了
 * 请求体"改用裸 socket 手工发一条 HTTP/1.0 请求 —— 它同样经过真实服务端，但不需要沙箱放行 HTTP。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../../scripts/nsdsh/lib/gate.mjs';
import {
  GUARD_CJS, applyGuardInProcess, assertIsolated, isLoopbackHost, makeIsolatedEnv, pickFreePort, startFakeModel,
} from '../../scripts/nsdsh/lib/isolate.mjs';
import { probeEgressDenied, probeLoopbackAllowed } from '../../scripts/nsdsh/lib/egress.mjs';

const EGRESS_DENIED = 'NSDSH_EGRESS_DENIED';

/** 顺序执行（含异步）用例；任一失败 → 进程非零退出。与 tests/temporal/harness.mjs 同一形状。 */
async function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

/** 用裸 TCP 发一条最小 HTTP/1.0 请求，并把响应原文取回来（绕开沙箱对子进程 HTTP 的限制）。 */
function rawHttp(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body, 'utf8') : Buffer.alloc(0);
    const head = `${method} ${urlPath} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n`
      + `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`;
    const chunks = [];
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(head);
      if (payload.length) sock.write(payload);
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
    setTimeout(() => { try { sock.destroy(); } catch (_) { /* 已关闭 */ } reject(new Error('rawHttp 超时')); }, 10000);
  });
}

await suite('nsdsh/isolation', [
  ['makeIsolatedEnv 把数据目录放在系统临时目录内', () => {
    const env = makeIsolatedEnv({ label: 'nsdsh-iso-test' });
    try {
      const tmp = path.resolve(os.tmpdir()).toLowerCase();
      assert.ok(env.dataDir.toLowerCase().startsWith(tmp), `dataDir 不在临时目录：${env.dataDir}`);
      assert.ok(env.homeDir.toLowerCase().startsWith(tmp), `homeDir 不在临时目录：${env.homeDir}`);
      assert.ok(!env.dataDir.toLowerCase().includes(`${path.sep}novel-studio${path.sep}data`), '不得落在仓库 data/');
      assert.equal(env.env.NOVELSTUDIO_DATA_DIR, env.dataDir);
      assert.equal(env.env.NOVELSTUDIO_OV_DISABLED, '1');
      assert.ok(env.env.NODE_OPTIONS.includes('network-guard.cjs'));
    } finally { env.cleanup(); }
  }],

  ['makeIsolatedEnv 的 cleanup 真的删掉临时目录（幂等）', () => {
    const env = makeIsolatedEnv({ label: 'nsdsh-iso-clean' });
    const root = env.root;
    assert.ok(fs.existsSync(root));
    assert.equal(env.cleanup(), true);
    assert.equal(fs.existsSync(root), false);
    assert.equal(env.cleanup(), true); // 第二次也必须安全
  }],

  ['assertIsolated 在未建环境时抛错', () => {
    const prev = process.env.NOVELSTUDIO_DATA_DIR;
    delete process.env.NOVELSTUDIO_DATA_DIR;
    try {
      assert.throws(() => assertIsolated(), /未建立隔离环境/);
    } finally {
      if (prev !== undefined) process.env.NOVELSTUDIO_DATA_DIR = prev;
    }
  }],

  ['assertIsolated 在数据目录指向真实 data/ 时抛错', () => {
    const env = makeIsolatedEnv({ label: 'nsdsh-iso-refuse' });
    const prev = process.env.NOVELSTUDIO_DATA_DIR;
    try {
      process.env.NOVELSTUDIO_DATA_DIR = path.join(env.root, '..', '..', '..', 'novel-studio', 'data');
      assert.throws(() => assertIsolated(), /拒绝把测试数据目录指向真实库|必须位于系统临时目录内/);
    } finally {
      process.env.NOVELSTUDIO_DATA_DIR = prev;
      env.cleanup();
    }
  }],

  ['pickFreePort 返回范围内的空闲端口且绝不是 3737', () => {
    const used = new Set();
    for (let i = 0; i < 3; i += 1) {
      const p = pickFreePort({ exclude: used });
      used.add(p);
      assert.ok(p >= 38100 && p < 38200, `端口越界：${p}`);
      assert.notEqual(p, 3737, '绝不能退回作者活实例的 3737');
    }
    // 排除集合必须真的生效（否则"空闲"是碰运气）。
    const again = pickFreePort({ exclude: used });
    assert.ok(!used.has(again), `排除集未生效：${again}`);
  }],

  ['isLoopbackHost 认回环、不认外网', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('example.com'), false);
    assert.equal(isLoopbackHost('10.0.0.5'), false);
  }],

  ['子进程 --require guard 拒绝非回环 fetch（命中 NSDSH_EGRESS_DENIED）', () => {
    const r = probeEgressDenied('http://example.com');
    assert.equal(r.verdict, 'denied', `期望被拒，实际 ${r.verdict}：${r.detail}`);
    assert.notEqual(r.status, 0, `被拒时退出码必须非 0，实际 ${r.status}`);
    assert.ok(r.denialSignature, '输出里必须出现 NSDSH_EGRESS_DENIED');
  }],

  ['阴性对照：guard 允许合法回环（沙箱拦 HTTP 时如实标 BLOCKED，不误判为 guard 缺陷）', async () => {
    const model = await startFakeModel({ reply: '{"ok":true}' });
    try {
      const r = probeLoopbackAllowed(`${model.baseUrl}/models`);
      // allowed = guard 正确放行；blocked = 沙箱不让子进程走 HTTP（本机受限策略下的实测形态）。
      // **不许**出现 denied —— 那才是"guard 误拦了合法回环"。
      assert.notEqual(r.verdict, 'denied', `guard 误拦了合法回环：${r.detail}`);
      assert.ok(['allowed', 'blocked'].includes(r.verdict), `未知判定：${r.verdict} ${r.detail}`);
      if (r.verdict === 'blocked') {
        assert.ok(r.tcpOk || r.hung, `BLOCKED 需要裸 TCP 或超时作证据：${r.detail}`);
      }
    } finally { await model.stop(); }
  }],

  ['applyGuardInProcess 记录违规并抛 NSDSH_EGRESS_DENIED', async () => {
    const env = makeIsolatedEnv({ label: 'nsdsh-guard-inproc' });
    try {
      const guard = applyGuardInProcess(env.egressPath);
      assert.equal(typeof guard.record, 'function');
      // 同进程 guard 是**同步抛出**（在调用点就拒绝，不是等 promise 失败）——
      // 这恰恰是它比"清空环境变量"更强的地方：拒绝发生在调用点，而不是配置层。
      assert.throws(() => fetch('http://example.com/steal'), (e) => e.code === EGRESS_DENIED);
      const lines = env.egressViolations();
      assert.ok(lines.length >= 1, `违规日志必须留下记录，实际 ${lines.length} 条`);
      assert.ok(lines[0].includes('example.com'), `记录里应含目标主机：${lines[0]}`);
      // 阴性对照：回环（已打过补丁的 fetch）必须仍然放行，不得被同进程 guard 拦下。
      const model = await startFakeModel({ reply: '{"ok":true}' });
      try {
        const r = await fetch(`${model.baseUrl}/models`);
        assert.equal(r.status, 200, '回环 fetch 必须被放行');
      } finally { await model.stop(); }
    } finally { env.cleanup(); }
  }],

  ['startFakeModel 捕获到发送给它的完整请求体', async () => {
    const model = await startFakeModel({ reply: '{"ok":true}' });
    try {
      const body = JSON.stringify({ model: 'nsdsh-fake', messages: [{ role: 'user', content: '第一章写了什么？' }] });
      const raw = await rawHttp(model.port, 'POST', '/v1/chat/completions', body);
      assert.ok(raw.startsWith('HTTP/1.'), `响应不像 HTTP：${raw.slice(0, 80)}`);
      assert.ok(raw.includes('200'), `期望 200：${raw.split('\r\n')[0]}`);
      assert.equal(model.requests.length, 1, `应恰好捕获 1 条请求，实际 ${model.requests.length}`);
      const captured = model.requests[0];
      assert.equal(captured.method, 'POST');
      assert.equal(captured.url, '/v1/chat/completions');
      assert.deepEqual(captured.body, JSON.parse(body), '捕获到的请求体必须与发送的一致');
      assert.equal(captured.body.messages[0].content, '第一章写了什么？');
    } finally { await model.stop(); }
  }],

  ['guard 的 --require 路径存在且是 CJS（--require 只接受 CJS）', () => {
    assert.ok(fs.existsSync(GUARD_CJS), `guard 文件不存在：${GUARD_CJS}`);
    const text = fs.readFileSync(GUARD_CJS, 'utf8');
    assert.ok(text.includes('NSDSH_EGRESS_DENIED'), 'guard 里必须有拒绝标记');
    assert.ok(!/^\s*import\s/m.test(text), '.cjs 里不得出现 ESM import 语句');
  }],
]);
