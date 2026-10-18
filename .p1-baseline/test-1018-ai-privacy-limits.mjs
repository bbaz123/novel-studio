#!/usr/bin/env node
// v1.2.0 回归套件 · T08：P09 AI 响应限额 + P10 追踪不落 AI 原文。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeEndpoint } from '../debug-trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

function freePort() {
  return new Promise((resolvePort) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); }); });
}

// 假 provider：正常 / 声明超大 / chunked 超大 / 出错但回显"敏感"文本
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const url = req.url || '';
    if (url.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { role: 'assistant', content: '短回复：这是 AI 正文' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
      return;
    }
    if (url.startsWith('/bigdeclared')) {
      const big = Buffer.alloc(4 * 1024 * 1024, 0x78);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(big.length) });
      res.end(big);
      return;
    }
    if (url.startsWith('/bigchunked')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      let n = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(512 * 1024, 0x79));
        n += 1;
        if (n >= 8) { clearInterval(timer); res.end(); }
      }, 5);
      return;
    }
    if (url.startsWith('/fail')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'echo sk-secret-xyz 短正文泄露样本' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakBase = `http://127.0.0.1:${fake.address().port}`;

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1018-t08-'));
async function j(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_MAX_AI_RESPONSE_BYTES: '1048576', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t08' },
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
  console.log('【A. 正常响应】');
  const cfg = await j('/api/api_configs', { method: 'POST', body: { name: 'fake', base_url: `${fakBase}/ok`, api_key: 'sk-test-key-123', model: 'deepseek-chat' } });
  ok('A 假 provider 配置已建', cfg.status === 201, `实际 ${cfg.status}`);
  const cfgId = cfg.data.id;
  const start = await j('/api/debug/start', { method: 'POST', body: {} });
  ok('A 追踪已开启', start.status === 200 && start.data?.session_id, JSON.stringify(start.data).slice(0, 120));
  const normal = await j('/api/ai/test', { method: 'POST', body: { config_id: cfgId } });
  ok('A 正常 AI 响应 200', normal.status === 200 && /短回复/.test(String(normal.data.reply || '')), `${normal.status} ${JSON.stringify(normal.data).slice(0, 120)}`);

  console.log('【B. 声明超大 Content-Length → 立即拒绝】');
  await j(`/api/api_configs/${cfgId}`, { method: 'PUT', body: { base_url: `${fakBase}/bigdeclared`, api_key: null } });
  const bigDeclared = await j('/api/ai/test', { method: 'POST', body: { config_id: cfgId } });
  ok('B 超大声明 → 502', bigDeclared.status === 502, `实际 ${bigDeclared.status} ${JSON.stringify(bigDeclared.data).slice(0, 160)}`);
  ok('B 错误信息说明上限', /过大|上限/.test(String(bigDeclared.data.error || '')), String(bigDeclared.data.error || ''));
  ok('B 进程仍存活', (await j('/api/health')).status === 200);

  console.log('【C. chunked 超大 → 边读边停】');
  await j(`/api/api_configs/${cfgId}`, { method: 'PUT', body: { base_url: `${fakBase}/bigchunked`, api_key: null } });
  const bigChunked = await j('/api/ai/test', { method: 'POST', body: { config_id: cfgId } });
  ok('C chunked 超大 → 502', bigChunked.status === 502, `实际 ${bigChunked.status} ${JSON.stringify(bigChunked.data).slice(0, 160)}`);
  ok('C 进程仍存活', (await j('/api/health')).status === 200);

  console.log('【D. 出错响应（回显敏感文本）】');
  await j(`/api/api_configs/${cfgId}`, { method: 'PUT', body: { base_url: `${fakBase}/fail`, api_key: null } });
  const fail = await j('/api/ai/test', { method: 'POST', body: { config_id: cfgId } });
  ok('D provider 错误按上游状态回传（400/502）', fail.status === 400 || fail.status === 502, `实际 ${fail.status}`);
  ok('D 错误信息被限长', String(fail.data.error || '').length <= 700, String(fail.data.error || '').length + ' chars');
  const stop = await j('/api/debug/stop', { method: 'POST', body: {} });
  ok('D 追踪已停止', stop.status === 200, JSON.stringify(stop.data).slice(0, 120));

  console.log('【E. 追踪文件：不落 AI 原文 / 不落 URL 凭证】');
  const debugDir = join(DATA_DIR, 'debug');
  let files = [];
  try { files = readdirSync(debugDir).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
  ok('E 产出追踪文件', files.length > 0, JSON.stringify(files));
  const raw = files.map((f) => { try { return readFileSync(join(debugDir, f), 'utf8'); } catch { return ''; } }).join('\n');
  ok('E 追踪含 AI 节点', /"kind":"ai"/.test(raw), raw.slice(0, 200));
  ok('E 不含正常 AI 正文', !raw.includes('短回复') && !raw.includes('这是 AI 正文'), '命中正文');
  ok('E 不含错误响应回显', !raw.includes('sk-secret-xyz') && !raw.includes('短正文泄露样本'), '命中错误回显');
  ok('E 结果标记为 omitted', /"result":\{[^}]*"omitted":true/.test(raw) || raw.includes('"omitted":true'), '未见 omitted');
  ok('E 错误节点不含 message 原文', !/"message":"[^"]*sk-secret/.test(raw), '错误消息泄露');
  ok('E 保留可诊断事实（模型/状态）', /"model":"deepseek-chat"/.test(raw), '模型字段缺失');

  console.log('【F. endpoint 脱敏（纯函数）】');
  const s1 = sanitizeEndpoint('http://user:pass@127.0.0.1:1933/v1/chat?api-key=sk-abc&x=2');
  ok('F 去掉 URL 用户信息', !s1.includes('user:pass'), s1);
  ok('F query 值被掩码', !s1.includes('sk-abc') && s1.includes('***'), s1);
  const s2 = sanitizeEndpoint('http://127.0.0.1:1/v1?token=abc123');
  ok('F token 参数被掩码', !s2.includes('abc123') && s2.includes('***'), s2);
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { fake.close(); } catch { /* 已关闭 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 尽力清理 */ }
}
console.log(`\nT08 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
