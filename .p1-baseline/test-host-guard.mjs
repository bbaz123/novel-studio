#!/usr/bin/env node
// P0-02/P1-02：宿主级写路由与通用 CRUD 的模型/作者双向边界（隔离库、零计费）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repo = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const port = await new Promise((resolvePort) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); }); });
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), 'novel-host-guard-'));
const agent = { 'x-novel-agent': '1' };
const req = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = {}; try { json = text ? JSON.parse(text) : {}; } catch (_) {}
  return { status: res.status, json };
};
const server = spawn(process.execPath, ['server.js'], { cwd: repo, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: data, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' }, stdio: 'ignore' });
let ready = false;
for (let i = 0; i < 100 && !ready; i++) { try { ready = (await req('/api/novel/ping')).status === 200; } catch (_) {} if (!ready) await new Promise((r) => setTimeout(r, 100)); }
if (!ready) { console.error('host guard server not ready'); process.exit(2); }
let pass = 0; const fail = [];
const ok = (name, v, detail = '') => { if (v) { pass++; console.log(`  ✓ ${name}`); } else { fail.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
try {
  const w = await req('/api/works', { method: 'POST', body: { title: 'guard-test' } });
  const wid = w.json.id;
  const c = await req('/api/chapters', { method: 'POST', body: { work_id: wid, title: '第一章' } });
  const cid = c.json.id;
  ok('通用 works：模型 PUT → 403', (await req(`/api/works/${wid}`, { method: 'PUT', headers: agent, body: { title: 'agent' } })).status === 403);
  ok('通用 works：作者 PUT → 200', (await req(`/api/works/${wid}`, { method: 'PUT', body: { title: 'author' } })).status === 200);
  ok('通用 chapters：模型 PUT → 403', (await req(`/api/chapters/${cid}`, { method: 'PUT', headers: agent, body: { title: 'agent' } })).status === 403);
  ok('通用 chapters：作者 PUT → 200', (await req(`/api/chapters/${cid}`, { method: 'PUT', body: { title: 'author' } })).status === 200);
  ok('通用 api_configs：模型 POST → 403', (await req('/api/api_configs', { method: 'POST', headers: agent, body: { name: 'agent' } })).status === 403);
  ok('宿主 semantic 开关：模型 PUT → 403', (await req('/api/novel/semantic', { method: 'PUT', headers: agent, body: { enabled: true } })).status === 403);
  ok('宿主 memory compress 开关：模型 PUT → 403', (await req('/api/novel/memory_auto_compress', { method: 'PUT', headers: agent, body: { enabled: true } })).status === 403);
  ok('宿主 OpenViking 全局配置：模型 POST → 403', (await req('/api/novel/openviking/global_config', { method: 'POST', headers: agent })).status === 403);
  ok('宿主 dsh repo：模型 PUT → 403', (await req('/api/env/dsh_repo', { method: 'PUT', headers: agent, body: { dir: '' } })).status === 403);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const r = await req('/api/novel/openviking', { method: 'PUT', body: { endpoint: `http://${host}:1933` } });
    ok(`OpenViking 回环地址 ${host} → 作者允许`, r.status === 200, String(r.json.error || r.status));
  }
  for (const host of ['192.168.1.2', '10.0.0.2', 'example.com']) {
    const r = await req('/api/novel/openviking', { method: 'PUT', body: { endpoint: `http://${host}:1933` } });
    ok(`OpenViking 非回环地址 ${host} → 默认拒绝`, r.status === 400, String(r.json.error || r.status));
  }
  const backup = await req('/api/backup', { method: 'POST', body: { label: 'guard' } });
  ok('整库备份：作者通道生成可校验副本', backup.status === 201 && backup.json.backup?.integrity === 'ok' && backup.json.backup?.sha256, JSON.stringify(backup.json));
  const backupPath = backup.json.backup?.path;
  const beforeTitle = (await req(`/api/works/${wid}`)).json.title;
  ok('整库还原：先改变测试作品内容', (await req(`/api/works/${wid}`, { method: 'PUT', body: { title: 'changed-after-backup' } })).status === 200);
  const restored = await req('/api/backup/restore', { method: 'POST', body: { path: backupPath } });
  ok('整库还原：良好副本恢复成功', restored.status === 200, JSON.stringify(restored.json));
  const restoredWork = await req(`/api/works/${wid}`);
  ok('整库还原：恢复后作品数据一致', restoredWork.json.title === beforeTitle, JSON.stringify(restoredWork.json));
  ok('整库还原：恢复后章节仍存在', (await req(`/api/chapters/${cid}`)).status === 200);
  const badPath = join(data, 'bad.db');
  (await import('node:fs')).writeFileSync(badPath, 'not sqlite');
  const badRestore = await req('/api/backup/restore', { method: 'POST', body: { path: badPath } });
  ok('整库还原：损坏副本拒绝且不继续写入', badRestore.status === 400 && /拒绝/.test(String(badRestore.json.error || '')), String(badRestore.json.error || ''));
  ok('整库备份：模型通道拒绝', (await req('/api/backup', { method: 'POST', headers: agent, body: {} })).status === 403);
} finally {
  try { server.kill(); } catch (_) {}
  try { rmSync(data, { recursive: true, force: true }); } catch (_) {}
}
console.log(`\nHost guard：通过 ${pass} / 未通过 ${fail.length}`);
if (fail.length) process.exit(1);
