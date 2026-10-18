#!/usr/bin/env node
// v1.2.0 回归套件 · T04：P04 Origin/Host 精确校验 + P05 请求体解析失败中止。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWriteOrigin } from '../ai/http/origin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CRLF = String.fromCharCode(13, 10);
const PORT = await new Promise((resolvePort) => {
  const probe = net.createServer();
  probe.once('error', () => resolvePort(5400 + (process.pid % 400)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1018-t04-'));
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

async function j(path, { method = 'GET', body, headers = {}, rawBody } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
// 原始 http.request：只有它能真正改写 Host 头（fetch 会忽略被禁的头）。
function raw({ path = '/', headers = {}, body = '' }) {
  const buf = Buffer.from(body, 'utf8');
  const h = { 'content-type': 'application/json', ...headers, 'content-length': String(buf.length) };
  return new Promise((resolvePromise) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path, headers: h, timeout: 8000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolvePromise({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolvePromise({ status: 0, error: 'timeout' }); });
    req.on('error', (e) => resolvePromise({ status: 0, error: e.message }));
    req.end(buf);
  });
}
// 真正不带 Host 的请求：HTTP/1.0 且手写报文（Node 的 http.request 会自动补 Host）。
function rawNoHost() {
  return new Promise((resolvePromise) => {
    const body = JSON.stringify({ title: 'x' });
    const sock = net.connect(PORT, '127.0.0.1');
    let text = '';
    sock.setTimeout(8000, () => { sock.destroy(); resolvePromise({ status: 0, error: 'timeout' }); });
    sock.on('connect', () => {
      sock.write(['POST /api/works HTTP/1.0', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, '', body].join(CRLF));
    });
    sock.on('data', (c) => { text += c; });
    sock.on('end', () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(text);
      resolvePromise({ status: m ? Number(m[1]) : 0 });
    });
    sock.on('error', (e) => resolvePromise({ status: 0, error: e.message }));
  });
}

console.log('【A. 纯函数判据】');
{
  const req = (o) => ({ method: 'POST', headers: o });
  ok('A 同端口同源放行', checkWriteOrigin(req({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), { port: PORT }).ok);
  ok('A localhost 同端口放行', checkWriteOrigin(req({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), { port: PORT }).ok);
  ok('A 同机不同端口拒绝', !checkWriteOrigin(req({ host: '127.0.0.1:3737', origin: 'http://127.0.0.1:5173' }), { port: 3737 }).ok);
  ok('A 异主机拒绝', !checkWriteOrigin(req({ host: 'evil.example:3737', origin: 'http://evil.example:3737' }), { port: 3737 }).ok);
  ok('A 缺 Host 拒绝', !checkWriteOrigin(req({ origin: 'http://127.0.0.1:3737' }), { port: 3737 }).ok);
  ok('A Host 端口不符拒绝', !checkWriteOrigin(req({ host: '127.0.0.1:9999' }), { port: 3737 }).ok);
  ok('A 无 Origin 的 CLI 放行', checkWriteOrigin(req({ host: '127.0.0.1:3737' }), { port: 3737 }).ok);
  ok('A GET 不校验', checkWriteOrigin({ method: 'GET', headers: {} }, { port: 3737 }).ok);
  ok('A 非法监听端口 fail-closed', !checkWriteOrigin(req({ host: '127.0.0.1:3737' }), { port: Number.NaN }).ok);
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t04' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logText = '';
server.stdout.on('data', (c) => { logText += c; });
server.stderr.on('data', (c) => { logText += c; });
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await j('/api/novel/ping'); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('实例未就绪\n' + logText.slice(-2000)); process.exit(2); }

try {
  console.log('【B. HTTP 写请求来源】');
  const page = await j('/api/works', { method: 'POST', headers: { origin: BASE }, body: { title: 'P04 当前页面' } });
  ok('B 当前页面同源写 201', page.status === 201, `实际 ${page.status}`);
  const crossPort = await j('/api/works', { method: 'POST', headers: { origin: 'http://127.0.0.1:5173' }, body: { title: '跨端口页面' } });
  ok('B 同机 5173 端口 403', crossPort.status === 403, `实际 ${crossPort.status}`);
  const localhost = await j('/api/works', { method: 'POST', headers: { origin: `http://localhost:${PORT}` }, body: { title: 'localhost 同端口' } });
  ok('B localhost 同端口 201', localhost.status === 201, `实际 ${localhost.status}`);
  const cli = await j('/api/works', { method: 'POST', body: { title: '无 Origin 工具' } });
  ok('B 无 Origin 工具 201', cli.status === 201, `实际 ${cli.status}`);
  const evil = await raw({ path: '/api/works', headers: { host: `evil.example:${PORT}` }, body: JSON.stringify({ title: 'x' }) });
  ok('B 异主机 Host 403', evil.status === 403, `实际 ${evil.status}`);
  const wrongPort = await raw({ path: '/api/works', headers: { host: '127.0.0.1:9999' }, body: JSON.stringify({ title: 'x' }) });
  ok('B Host 端口不符 403', wrongPort.status === 403, `实际 ${wrongPort.status}`);
  const noHost = await rawNoHost();
  ok('B 缺 Host 403', noHost.status === 403, `实际 ${noHost.status} ${JSON.stringify(noHost)}`);

  console.log('【C. P05 畸形请求体必须中止副作用】');
  const backupsDir = join(DATA_DIR, 'backups');
  const countBackups = () => { try { return readdirSync(backupsDir).length; } catch { return 0; } };
  const before = countBackups();
  const badBackup = await j('/api/backup', { method: 'POST', rawBody: '{bad json' });
  ok('C 畸形 JSON 备份 400', badBackup.status === 400, `实际 ${badBackup.status} ${JSON.stringify(badBackup.data).slice(0, 120)}`);
  ok('C 畸形 JSON 未产生备份文件', countBackups() === before, `${before} → ${countBackups()}`);
  const goodBackup = await j('/api/backup', { method: 'POST', body: { label: 'probe' } });
  ok('C 合法备份 201', goodBackup.status === 201, `实际 ${goodBackup.status}`);
  ok('C 合法备份产生文件', countBackups() === before + 1, `${before} → ${countBackups()}`);

  const chapters = await j('/api/chapters', { method: 'POST', body: { work_id: page.data.id, title: '第1章', content: '<p>正文</p>' } });
  const chapterId = chapters.data.id;
  const bp1 = await j('/api/novel/chapter_blueprint', { method: 'PUT', body: { chapter_id: chapterId, blueprint: { scene_goal: '保存目标' } } });
  ok('C 合法蓝图保存 200', bp1.status === 200, `实际 ${bp1.status}`);
  const beforeDel = (await j(`/api/novel/chapter_blueprints?chapter_id=${chapterId}`)).data.blueprints.length;
  const badDel = await j('/api/novel/chapter_blueprints', { method: 'DELETE', rawBody: 'not-json' });
  ok('C 畸形 JSON 蓝图删除 400', badDel.status === 400, `实际 ${badDel.status}`);
  const afterDel = (await j(`/api/novel/chapter_blueprints?chapter_id=${chapterId}`)).data.blueprints.length;
  ok('C 畸形 JSON 未删除蓝图', afterDel === beforeDel, `${beforeDel} → ${afterDel}`);

  const state0 = await j('/api/debug/state');
  ok('C 追踪初始未录制', state0.data.state?.recording === false, JSON.stringify(state0.data.state));
  const badTrace = await j('/api/debug/start', { method: 'POST', rawBody: '{oops' });
  ok('C 畸形 JSON 启动追踪 400', badTrace.status === 400, `实际 ${badTrace.status}`);
  const state1 = await j('/api/debug/state');
  ok('C 畸形 JSON 未启动追踪', state1.data.state?.recording === false, JSON.stringify(state1.data.state));
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}
console.log(`\nT04 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
