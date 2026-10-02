#!/usr/bin/env node
// P3-16：API key 掩码边界（隔离库、只测返回值，不打印原始 key）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const repo = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const data = mkdtempSync(join(tmpdir(), 'novel-key-mask-')); const base = `http://127.0.0.1:${port}`;
const req = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j }; };
const child = spawn(process.execPath, ['server.js'], { cwd: repo, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: data, NOVELSTUDIO_OV_DISABLED: '1' }, stdio: 'ignore' });
let ready = false; for (let i = 0; i < 100 && !ready; i++) { try { ready = (await req('/api/novel/ping')).status === 200; } catch (_) {} if (!ready) await new Promise((r) => setTimeout(r, 50)); }
if (!ready) process.exit(2);
let pass = 0; const fail = []; const ok = (n, v) => v ? (pass++, console.log(`  ✓ ${n}`)) : (fail.push(n), console.log(`  ✗ ${n}`));
try {
  for (const key of ['a', '12345678', 'sk-short', 'sk-live-1234567890']) {
    const created = await req('/api/api_configs', { method: 'POST', body: { name: `mask-${key.length}`, api_key: key, base_url: 'http://127.0.0.1' } });
    const id = created.json.id; const got = await req(`/api/api_configs/${id}`); const masked = String(got.json.api_key || '');
    ok(`长度 ${key.length} 的 key 已掩码`, masked !== key && masked.length > 0);
  }
} finally { try { child.kill(); } catch (_) {} try { rmSync(data, { recursive: true, force: true }); } catch (_) {} }
console.log(`\nAPI key mask：通过 ${pass} / 失败 ${fail.length}`); if (fail.length) process.exit(1);
