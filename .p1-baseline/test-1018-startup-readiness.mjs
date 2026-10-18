#!/usr/bin/env node
// v1.2.0 回归套件 · T05：P13 迁移 fail-fast + P07 端口/监听/readiness + P06 启动脚本。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMigrationsApplied } from '../ai/db-migration-failfast.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

async function freePort() {
  return new Promise((resolvePort) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); });
  });
}
function runNode(env, timeoutMs = 20000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolvePromise({ code: 'timeout', out, err }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code, out, err }); });
  });
}
function runCmd(env, timeoutMs = 40000) {
  return new Promise((resolvePromise) => {
    const cmd = process.env.ComSpec || 'cmd.exe';
    const child = spawn(cmd, ['/d', '/c', 'start-novel-studio.cmd'], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolvePromise({ code: 'timeout', out, err }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code, out, err }); });
  });
}
async function fetchStatus(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return { status: r.status, data: await r.json().catch(() => ({})) }; } catch (e) { return { status: 0, error: String(e.message || e) }; }
}

console.log('【A. P13 迁移 fail-fast 判据】');
{
  let thrown = null;
  try { assertMigrationsApplied([{ id: 'm042', message: 'no such table: works' }]); } catch (e) { thrown = e; }
  ok('A 有失败 → 抛 DB_MIGRATION_FAILED', thrown?.code === 'DB_MIGRATION_FAILED', String(thrown));
  ok('A 错误带 migration id', Array.isArray(thrown?.migrations) && thrown.migrations.includes('m042'), JSON.stringify(thrown?.migrations));
  ok('A 无失败 → 放行', assertMigrationsApplied([])?.ok === true);
  ok('A 非数组 → 放行（不把缺参当失败）', assertMigrationsApplied(undefined)?.ok === true);
}

console.log('【B. P13 损坏库：非零退出且不篡改文件】');
{
  const dir = mkdtempSync(join(tmpdir(), 'novel-1018-t05-corrupt-'));
  const file = join(dir, 'novel.db');
  const junk = Buffer.from('this is not a sqlite database — probe — '.repeat(64), 'utf8');
  writeFileSync(file, junk);
  const r = await runNode({ NOVELSTUDIO_DATA_DIR: dir, NOVELSTUDIO_OV_DISABLED: '1', PORT: String(await freePort()) });
  ok('B 损坏库非零退出', r.code !== 0, `code=${r.code}`);
  ok('B 错误信息可归因', /数据库完整性自检失败|not a database/i.test(String(r.err) + String(r.out)), (String(r.err) + String(r.out)).slice(0, 200));
  const after = (await import('node:fs')).readFileSync(file);
  ok('B 原文件字节未被篡改', Buffer.compare(after, junk) === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log('【C. P07 非法端口 / 端口占用】');
{
  const bad = await runNode({ PORT: 'abc', NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_DATA_DIR: mkdtempSync(join(tmpdir(), 'novel-1018-t05-bad-')) }, 10000);
  ok('C 非法 PORT 非零退出', bad.code === 1, `code=${bad.code}`);
  ok('C 非法 PORT 明确报错', /非法端口/.test(String(bad.err) + String(bad.out)), (String(bad.err) + String(bad.out)).slice(0, 160));

  const p = await freePort();
  const blocker = net.createServer((s) => s.end());
  await new Promise((r) => blocker.listen(p, '127.0.0.1', r));
  const busyDir = mkdtempSync(join(tmpdir(), 'novel-1018-t05-busy-'));
  const busy = await runNode({ PORT: String(p), NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_DATA_DIR: busyDir }, 15000);
  ok('C 端口占用非零退出', busy.code === 1, `code=${busy.code}`);
  ok('C 端口占用明确报错', /EADDRINUSE|已被其它程序占用/.test(String(busy.err) + String(busy.out)), (String(busy.err) + String(busy.out)).slice(0, 200));
  await new Promise((r) => blocker.close(r));
  rmSync(busyDir, { recursive: true, force: true });
}

console.log('【D. P07 health / readiness / 未就绪写 503】');
{
  const p = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'novel-1018-t05-ready-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(p), NOVELSTUDIO_DATA_DIR: dir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t05' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logText = '';
  child.stdout.on('data', (c) => { logText += c; });
  child.stderr.on('data', (c) => { logText += c; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    const r = await fetchStatus(`http://127.0.0.1:${p}/api/readiness`);
    if (r.status === 200) ready = true;
    if (!ready) await new Promise((r2) => setTimeout(r2, 300));
  }
  ok('D 正常启动后 readiness 200', ready, logText.slice(-300));
  const health = await fetchStatus(`http://127.0.0.1:${p}/api/health`);
  ok('D health 200 且 ready=true', health.status === 200 && health.data?.ready === true, JSON.stringify(health.data));
  const readiness = await fetchStatus(`http://127.0.0.1:${p}/api/readiness`);
  ok('D readiness 含数据库迁移检查', readiness.data?.checks?.database?.ok === true, JSON.stringify(readiness.data?.checks));
  child.kill();

  const pHold = await freePort();
  const dirHold = mkdtempSync(join(tmpdir(), 'novel-1018-t05-hold-'));
  const hold = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(pHold), NOVELSTUDIO_DATA_DIR: dirHold, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_HOLD_READY: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t05-hold' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let holdLog = '';
  hold.stdout.on('data', (c) => { holdLog += c; });
  hold.stderr.on('data', (c) => { holdLog += c; });
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    const r = await fetchStatus(`http://127.0.0.1:${pHold}/api/health`);
    if (r.status === 200) up = true;
    if (!up) await new Promise((r2) => setTimeout(r2, 300));
  }
  ok('D 未就绪实例仍能回 health（进程活着）', up, holdLog.slice(-300));
  const h2 = await fetchStatus(`http://127.0.0.1:${pHold}/api/health`);
  ok('D health ready=false', h2.data?.ready === false, JSON.stringify(h2.data));
  const r2 = await fetchStatus(`http://127.0.0.1:${pHold}/api/readiness`);
  ok('D readiness 503', r2.status === 503 && r2.data?.ready === false, `${r2.status} ${JSON.stringify(r2.data)}`);
  const w = await fetch(`http://127.0.0.1:${pHold}/api/works`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) }).then((res) => res.status).catch(() => 0);
  ok('D 未就绪写请求 503', w === 503, `实际 ${w}`);
  hold.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirHold, { recursive: true, force: true });
}

console.log('【G. P13 真实迁移失败：非零退出 + 打印 migration id】');
{
  const dir = mkdtempSync(join(tmpdir(), 'novel-1018-t05-migfail-'));
  const dbPath = join(dir, 'novel.db');
  const { DatabaseSync } = await import('node:sqlite');
  // 用 spawn + readiness 等待：runNode 的 timeout 会留下仍占着数据库文件的子进程。
  const bootDir = async (d, port) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: d, NOVELSTUDIO_OV_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (c) => { text += c; });
    child.stderr.on('data', (c) => { text += c; });
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); if (r.status === 200) up = true; } catch { /* 未就绪 */ }
      if (!up) await new Promise((r2) => setTimeout(r2, 300));
    }
    return { child, up, text };
  };
  const p1 = await freePort();
  const boot = await bootDir(dir, p1);
  ok('G 首个实例就绪（准备 schema）', boot.up, boot.text.slice(-200));
  boot.child.kill();
  await new Promise((r) => { if (boot.child.exitCode !== null) return r(); boot.child.once('exit', r); });
  const seed = new DatabaseSync(dbPath);
  seed.exec('PRAGMA busy_timeout = 5000');
  // 选一条"正常会成功"的迁移（DROP INDEX IF EXISTS），删掉它的账本行并要求重跑；
  // 然后用触发器让**记账写入**失败 —— 迁移事务整体回滚，正是 fail-fast 要覆盖的真实失败。
  const mig = seed.prepare("SELECT id FROM schema_migrations WHERE sql LIKE '%DROP INDEX IF EXISTS idx_story_analysis_tasks_open%'").get();
  ok('G 找到目标迁移账本行', !!mig?.id, JSON.stringify(mig));
  if (mig?.id) {
    seed.exec(`CREATE TRIGGER zz_probe_block_migration BEFORE INSERT ON schema_migrations WHEN NEW.id = '${mig.id}' BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END`);
    seed.prepare('DELETE FROM schema_migrations WHERE id = ?').run(mig.id);
    seed.close();
    const p2 = await freePort();
    const boot2 = await bootDir(dir, p2);
    if (boot2.child.exitCode === null) boot2.child.kill();
    await new Promise((r) => { if (boot2.child.exitCode !== null) return r(); boot2.child.once('exit', r); });
    const text = String(boot2.text);
    ok('G 迁移真实失败 → 实例未就绪', !boot2.up, text.slice(-300));
    ok('G 报错含迁移 id 与失败原因', text.includes(mig.id) && /迁移失败|DB_MIGRATION_FAILED|injected ledger failure/i.test(text), text.slice(-400));
    const check = new DatabaseSync(dbPath);
    const ledger = check.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = ?').get(mig.id).n;
    check.close();
    ok('G 失败迁移未记账（事务回滚）', Number(ledger) === 0, 'ledger=' + ledger);
  }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 尽力清理 */ }
}

console.log('【E. P06 启动脚本】');
if (process.platform !== 'win32') {
  // P06 验证的是 start-novel-studio.cmd（cmd.exe / curl / timeout / start）。这些命令在
  // Linux/macOS 上不存在，硬跑只会得到"spawn ENOENT"式的假失败；Windows CI job 仍然会执行
  // 这一组，因此覆盖没有丢失。这里显式打印 SKIP，不把"没跑"混进通过数。
  console.log('  – SKIP（非 Windows）：P06 用例执行 .cmd 启动脚本，仅在 Windows 上运行；Windows CI job 覆盖');
} else
{
  const bad = await runCmd({ PORT: 'abc', NOVELSTUDIO_SCRIPT_SILENT: '1', NOVELSTUDIO_NO_BROWSER: '1', NOVELSTUDIO_NO_START: '1' }, 20000);
  ok('E 非法端口脚本非零退出', bad.code === 1, `code=${bad.code}`);
  ok('E 非法端口有明确提示', /Invalid PORT/.test(bad.out + bad.err), (bad.out + bad.err).slice(0, 200));

  const p = await freePort();
  const foreign = http.createServer((req, res) => {
    if (req.url.startsWith('/api/readiness')) { res.writeHead(500); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((r) => foreign.listen(p, '127.0.0.1', r));
  const occupied = await runCmd({ PORT: String(p), NOVELSTUDIO_SCRIPT_SILENT: '1', NOVELSTUDIO_NO_BROWSER: '1', NOVELSTUDIO_NO_START: '1' }, 20000);
  ok('E 端口被占脚本非零退出', occupied.code === 1, `code=${occupied.code}`);
  ok('E 端口被占不误报 ready', /not OK|not ready/i.test(occupied.out + occupied.err) && !/already ready/i.test(occupied.out), (occupied.out + occupied.err).slice(0, 300));
  await new Promise((r) => foreign.close(r));

  const p2 = await freePort();
  const timeout = await runCmd({ PORT: String(p2), NOVELSTUDIO_SCRIPT_SILENT: '1', NOVELSTUDIO_NO_BROWSER: '1', NOVELSTUDIO_NO_START: '1', NOVELSTUDIO_READY_TIMEOUT_SEC: '2' }, 30000);
  ok('E 未就绪超时非零退出', timeout.code === 1, `code=${timeout.code}`);
  ok('E 超时提示不打开浏览器', /did not become ready/i.test(timeout.out + timeout.err), (timeout.out + timeout.err).slice(0, 300));

  const p3 = await freePort();
  const readySrv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/api/readiness') ? '{"ok":true,"ready":true}' : '{"ok":true}');
  });
  await new Promise((r) => readySrv.listen(p3, '127.0.0.1', r));
  const good = await runCmd({ PORT: String(p3), NOVELSTUDIO_SCRIPT_SILENT: '1', NOVELSTUDIO_NO_BROWSER: '1', NOVELSTUDIO_NO_START: '1' }, 20000);
  ok('E 已就绪脚本 0 退出', good.code === 0, `code=${good.code}`);
  ok('E 已就绪识别正确', /already ready/i.test(good.out + good.err), (good.out + good.err).slice(0, 200));
  await new Promise((r) => readySrv.close(r));
}

console.log(`\nT05 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
