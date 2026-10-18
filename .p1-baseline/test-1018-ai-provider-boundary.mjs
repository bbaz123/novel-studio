#!/usr/bin/env node
// v1.2.0 回归套件 · T10：P16 provider 信任边界 + 重定向凭证保护。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProviderBaseUrl, assertModelChannelProvider, checkAgentMessages } from '../ai/provider-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

console.log('【A. provider 地址判据（纯函数）】');
{
  ok('A https 正常地址放行', validateProviderBaseUrl('https://api.deepseek.com').ok === true);
  ok('A 本机自定义 provider 放行（合法功能）', validateProviderBaseUrl('http://127.0.0.1:11434/v1').ok === true);
  ok('A 私网地址不按主机名拦（作者可控）', validateProviderBaseUrl('http://192.168.1.20:8000/v1').ok === true);
  ok('A 非 http(s) 拒绝', validateProviderBaseUrl('ftp://example.com').ok === false);
  ok('A 内嵌账号密码拒绝', validateProviderBaseUrl('http://u:p@127.0.0.1:1/v1').ok === false);
  ok('A 非法 URL 拒绝', validateProviderBaseUrl('not a url').ok === false);
  ok('A 空串放行（用默认）', validateProviderBaseUrl('').ok === true);
  ok('A 模型通道自带 base_url 拒绝', assertModelChannelProvider({ base_url: 'http://x' }).ok === false);
  ok('A 模型通道自带 api_key 拒绝', assertModelChannelProvider({ api_key: 'sk-x' }).ok === false);
  ok('A 模型通道无内联字段放行', assertModelChannelProvider({ config_id: 1 }).ok === true);
  ok('A 消息条数上限', checkAgentMessages(new Array(51).fill({ role: 'user', content: 'x' }), { maxCount: 50 }).ok === false);
  ok('A 消息字节上限', checkAgentMessages([{ role: 'user', content: 'x'.repeat(2048) }], { maxBytes: 1024 }).ok === false);
}

const fakePort = await freePort();
const stealPort = await freePort();
let stealHits = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const url = req.url || '';
    if (url.startsWith('/redirect')) {
      res.writeHead(302, { location: `http://127.0.0.1:${stealPort}/steal` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});
const stealer = http.createServer((req, res) => { stealHits += 1; res.writeHead(200); res.end('{}'); });
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
await new Promise((r) => stealer.listen(stealPort, '127.0.0.1', r));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1018-t10-'));
const AGENT = { 'x-novel-agent': '1' };
async function j(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t10' },
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
  const cfg = (await j('/api/api_configs', { method: 'POST', body: { name: 'fake', base_url: `http://127.0.0.1:${fake.address().port}`, api_key: 'sk-author-key', model: 'deepseek-chat' } })).data.id;
  ok('B 作者配置已建立', !!cfg, String(cfg));

  console.log('【B. 模型通道不得自带 provider】');
  const inlineBase = await j('/api/ai/test', { method: 'POST', headers: AGENT, body: { config_id: cfg, base_url: `http://127.0.0.1:${fake.address().port}` } });
  ok('B 模型带 base_url → 403', inlineBase.status === 403, `实际 ${inlineBase.status} ${JSON.stringify(inlineBase.data).slice(0, 120)}`);
  const inlineKey = await j('/api/ai/test', { method: 'POST', headers: AGENT, body: { config_id: cfg, api_key: 'sk-attacker' } });
  ok('B 模型带 api_key → 403', inlineKey.status === 403, `实际 ${inlineKey.status}`);
  const noConfig = await j('/api/ai/test', { method: 'POST', headers: AGENT, body: {} });
  ok('B 模型缺 config_id → 403', noConfig.status === 403, `实际 ${noConfig.status}`);
  const tooMany = await j('/api/ai/write', { method: 'POST', headers: AGENT, body: { config_id: cfg, messages: new Array(51).fill({ role: 'user', content: 'x' }) } });
  ok('B 模型 51 条消息 → 403', tooMany.status === 403, `实际 ${tooMany.status}`);
  const agentOk = await j('/api/ai/test', { method: 'POST', headers: AGENT, body: { config_id: cfg } });
  ok('B 模型用作者配置 → 200', agentOk.status === 200, `实际 ${agentOk.status} ${JSON.stringify(agentOk.data).slice(0, 120)}`);

  console.log('【C. 作者通道：非法 provider 地址必须拒绝】');
  const ftpCfg = (await j('/api/api_configs', { method: 'POST', body: { name: 'ftp', base_url: 'ftp://evil.example', api_key: 'sk-x' } })).data.id;
  const ftpCall = await j('/api/ai/test', { method: 'POST', body: { config_id: ftpCfg } });
  ok('C ftp 协议 → 400', ftpCall.status === 400, `实际 ${ftpCall.status} ${JSON.stringify(ftpCall.data).slice(0, 120)}`);
  const credCfg = (await j('/api/api_configs', { method: 'POST', body: { name: 'cred', base_url: `http://u:p@127.0.0.1:${fake.address().port}`, api_key: 'sk-x' } })).data.id;
  const credCall = await j('/api/ai/test', { method: 'POST', body: { config_id: credCfg } });
  ok('C URL 内嵌凭证 → 400', credCall.status === 400, `实际 ${credCall.status}`);
  const inlineAuthor = await j('/api/ai/test', { method: 'POST', body: { base_url: 'gopher://x', api_key: 'sk-x' } });
  ok('C 作者内联非法地址 → 400', inlineAuthor.status === 400, `实际 ${inlineAuthor.status}`);

  console.log('【D. 重定向不转发凭证】');
  const redirCfg = (await j('/api/api_configs', { method: 'POST', body: { name: 'redir', base_url: `http://127.0.0.1:${fake.address().port}/redirect`, api_key: 'sk-author-key' } })).data.id;
  const redir = await j('/api/ai/test', { method: 'POST', body: { config_id: redirCfg } });
  ok('D 重定向被拒绝（非 200）', redir.status !== 200, `实际 ${redir.status}`);
  ok('D 凭证没有被转发到重定向目标', stealHits === 0, `stealHits=${stealHits}`);
  // 流式通道同样不得跟随重定向（否则 key 会经 302 被转发）。
  const streamRes = await fetch(`${BASE}/api/ai/write_stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config_id: redirCfg, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(20000),
  });
  const streamText = await streamRes.text();
  ok('D2 流式重定向报错（不静默成功）', /error|失败|redirect/i.test(streamText), streamText.slice(0, 160));
  ok('D2 流式重定向未转发凭证', stealHits === 0, `stealHits=${stealHits}`);
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { fake.close(); } catch { /* 已关闭 */ }
  try { stealer.close(); } catch { /* 已关闭 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 尽力清理 */ }
}
console.log(`\nT10 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
