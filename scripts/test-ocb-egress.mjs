#!/usr/bin/env node
/**
 * 宿主层出口隔离的离线断言（插件半边 + sandbox 半边）。
 *
 * 为什么两层都要测：只测纯判定证明不了“真的装了”；只测子进程证明不了“工具调用会被拦”。
 * 这里两层分别有观测：插件层拿 guard 返回串，sandbox 层拿子进程退出码与真实拒绝记录。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyToolCall, installEgressGuard } from '../harness-plugins/novel-writing/egress-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PRELOAD = path.join(REPO, 'harness-plugins/novel-writing/sandbox/install.mjs')

let passed = 0
let failed = 0
const failures = []
const queue = []
const test = (name, fn) => queue.push({ name, fn })

// ── 插件半边：纯判定 ─────────────────────────────────────────────────────────
test('EG-01 web_fetch 到非白名单主机 → deny', () => {
  const v = classifyToolCall({ name: 'web_fetch', arguments: { url: 'https://example.com/a' } }, { allowHosts: [] })
  assert.equal(v.decision, 'deny')
  assert.deepEqual(v.hosts, ['example.com'])
})

test('EG-02 web_fetch 到本机回环 → allow（不破坏工坊自身）', () => {
  const v = classifyToolCall({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1:3737/api/health' } }, { allowHosts: [] })
  assert.equal(v.decision, 'allow')
})

test('EG-03 白名单内的外部主机放行，白名单外仍拒绝', () => {
  const cfg = { allowHosts: ['api.example.com'] }
  assert.equal(classifyToolCall({ name: 'web_fetch', arguments: { url: 'https://api.example.com/x' } }, cfg).decision, 'allow')
  assert.equal(classifyToolCall({ name: 'web_fetch', arguments: { url: 'https://evil.example.org/x' } }, cfg).decision, 'deny')
})

test('EG-04 shell 里的 curl / npm publish 被识别为出站', () => {
  const deny = classifyToolCall({ name: 'ops_bash', arguments: { command: 'curl -s https://evil.example.org/x' } }, { allowHosts: [] })
  assert.equal(deny.decision, 'deny')
  assert.deepEqual(deny.hosts, ['evil.example.org'])
  const publish = classifyToolCall({ name: 'bash', arguments: { command: 'npm publish' } }, { allowHosts: [] })
  assert.equal(publish.decision, 'deny')
  assert.equal(publish.hosts.length, 0)
  const local = classifyToolCall({ name: 'ops_bash', arguments: { command: 'curl -s http://127.0.0.1:3737/api/health' } }, { allowHosts: [] })
  assert.equal(local.decision, 'allow')
})

test('EG-05 普通文件类命令不受影响', () => {
  for (const command of ['ls -la', 'node scripts/test-one-click-book.mjs', 'git status --porcelain']) {
    assert.equal(classifyToolCall({ name: 'ops_bash', arguments: { command } }, { allowHosts: [] }).decision, 'allow', command)
  }
})

// ── 插件半边：Cordis 挂载（用假 ctx 记录守卫返回值）──────────────────────────
test('EG-06 installEgressGuard 注册 pre-execute 与单调守卫，拒绝串可读', () => {
  const registered = { listeners: [], guards: [], effects: 0 }
  const ctx = {
    on(event, handler) { registered.listeners.push({ event, handler }) },
    effect(fn) { registered.effects += 1; fn() },
    tools: { guard(fn) { registered.guards.push(fn) } },
  }
  const guard = installEgressGuard(ctx, { allowHosts: [] })
  assert.equal(guard.installed, true)
  assert.ok(registered.listeners.some((item) => item.event === 'tools/pre-execute'))
  assert.equal(registered.guards.length, 1)
  const denyReason = registered.guards[0]({ name: 'web_fetch', arguments: { url: 'https://example.com' } })
  assert.match(String(denyReason), /novel-egress-guard/)
  const allowResult = registered.guards[0]({ name: 'novel_event_add', arguments: {} })
  assert.equal(allowResult, undefined)
  assert.equal(guard.summary().denials, 1)
})

test('EG-07 egress.enabled=false 时不安装', () => {
  const ctx = { on() {}, effect() {}, tools: { guard() {} } }
  assert.equal(installEgressGuard(ctx, { enabled: false }).installed, false)
})

// ── sandbox 半边：真实子进程 ────────────────────────────────────────────────
const runChild = (code) => new Promise((resolve) => {
  execFile(process.execPath, ['--import', pathToFileURL(PRELOAD).href, '--input-type=module', '-e', code], {
    cwd: REPO,
    timeout: 20_000,
    env: { ...process.env, NOVELSTUDIO_EGRESS_ALLOW: process.env.NOVELSTUDIO_EGRESS_ALLOW ?? '' },
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }))
})

test('EG-08 子进程 fetch 外部主机被沙箱拒绝', async () => {
  const result = await runChild(`
    try { await fetch('http://example.com'); console.log('LEAKED'); process.exit(2) }
    catch (e) { console.log('DENIED:' + e.code); process.exit(e.code === 'EGRESS_DENIED' ? 0 : 3) }
  `)
  assert.equal(result.code, 0, `child exit=${result.code} stderr=${result.stderr.slice(0, 200)}`)
  assert.match(result.stdout, /DENIED:EGRESS_DENIED/)
})

test('EG-09 子进程 net.Socket 与 dns 同被拒绝（不止 fetch 一个口子）', async () => {
  const socketRun = await runChild(`
    import net from 'node:net';
    try { net.connect(80, '8.8.8.8'); console.log('LEAKED'); process.exit(2) }
    catch (e) { console.log('DENIED:' + e.code); process.exit(e.code === 'EGRESS_DENIED' ? 0 : 3) }
  `)
  assert.equal(socketRun.code, 0, `socket exit=${socketRun.code}`)
  const dnsRun = await runChild(`
    import dns from 'node:dns';
    // lookup 的失败按 Node 约定走回调，不抛同步异常——判据必须是回调里的 code。
    dns.lookup('example.com', (err) => {
      console.log(err && err.code === 'EGRESS_DENIED' ? 'DENIED' : 'LEAKED');
      process.exit(err && err.code === 'EGRESS_DENIED' ? 0 : 2);
    });
  `)
  assert.equal(dnsRun.code, 0, `dns exit=${dnsRun.code} stdout=${dnsRun.stdout}`)
})

test('EG-10 本机回环在沙箱内仍可用（工坊本地实例不被自己挡住）', async () => {
  const server = http.createServer((req, res) => res.end('ok-loopback'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const result = await runChild(`
      const r = await fetch('http://127.0.0.1:${port}/');
      console.log('BODY:' + await r.text());
      process.exit(0);
    `)
    assert.equal(result.code, 0, `loopback exit=${result.code} stderr=${result.stderr.slice(0, 200)}`)
    assert.match(result.stdout, /BODY:ok-loopback/)
  } finally {
    server.close()
  }
})

// ── 汇总 ────────────────────────────────────────────────────────────────────
for (const { name, fn } of queue) {
  try {
    await fn()
    passed += 1
  } catch (e) {
    failed += 1
    failures.push({ name, error: String(e?.message || e) })
    process.stderr.write(`FAIL ${name}\n  ${String(e?.message || e)}\n`)
  }
}
process.stdout.write(`\n宿主层出口隔离验收：passed=${passed} failed=${failed}\n`)
for (const item of failures) process.stdout.write(`  ✗ ${item.name}\n`)
process.exit(failed === 0 ? 0 : 1)
