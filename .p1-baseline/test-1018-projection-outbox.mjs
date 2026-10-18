#!/usr/bin/env node
// v1.2.0 回归套件 · T06：P12 outbox 租约/认领/恢复/排空。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectionOutbox, drainUntilIdle } from '../server/services/projection-outbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projection_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id INTEGER NOT NULL,
    chapter_id INTEGER,
    kind TEXT NOT NULL,
    dedup_key TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
    updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
    worker_token TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT NOT NULL DEFAULT ''
  );`);
  return db;
}
function enqueue(db, n) {
  const ins = db.prepare(`INSERT INTO projection_outbox (work_id, kind, status) VALUES (?, 'ov_work_sync', 'pending')`);
  for (let i = 0; i < n; i += 1) ins.run(i + 1);
}
const statusOf = (db, id) => db.prepare('SELECT * FROM projection_outbox WHERE id = ?').get(id);

console.log('【A. 队列 6 / 50 / 100 条最终排空】');
for (const n of [6, 50, 100]) {
  const db = makeDb();
  enqueue(db, n);
  const outbox = createProjectionOutbox({ db, workerToken: 'w_test' });
  const r = await drainUntilIdle(outbox, { run: async () => { /* 模拟外部服务正常 */ }, budgetMs: 5000, batch: 25 });
  const s = outbox.summary();
  ok(`A ${n} 条全部 done`, s.done === n && s.pending === 0 && s.failed === 0, JSON.stringify(s));
  ok(`A ${n} 条 stopped=drained`, r.stopped === 'drained', JSON.stringify(r));
}

console.log('【B. 外部失败：保留 failed + 不忙循环】');
{
  const db = makeDb();
  enqueue(db, 3);
  const outbox = createProjectionOutbox({ db, workerToken: 'w_test' });
  let calls = 0;
  const r = await drainUntilIdle(outbox, { run: async () => { calls += 1; throw new Error('上游不可用'); }, budgetMs: 5000, batch: 25 });
  const s = outbox.summary();
  ok('B 只尝试一次（失败即退避）', calls === 1, `calls=${calls}`);
  ok('B 首条 failed 且有 last_error', s.failed === 1, JSON.stringify(s));
  const first = db.prepare("SELECT * FROM projection_outbox WHERE status = 'failed'").get();
  ok('B last_error 可见', /上游不可用/.test(String(first?.last_error || '')), String(first?.last_error));
  ok('B 其余保持 pending', s.pending === 2, JSON.stringify(s));
  ok('B stopped=backoff', r.stopped === 'backoff', JSON.stringify(r));
}

console.log('【C. 崩溃恢复：过期 running 复位】');
{
  const db = makeDb();
  enqueue(db, 1);
  db.exec(`UPDATE projection_outbox SET status='running', worker_token='w_dead', lease_expires_at='2000-01-01T00:00:00.000Z'`);
  const outbox = createProjectionOutbox({ db, workerToken: 'w_new' });
  const n = outbox.recoverStale();
  const row = statusOf(db, 1);
  ok('C 过期 running 被复位为 pending', n === 1 && row.status === 'pending', `${n} ${row.status}`);
  ok('C 恢复留下可归因的 last_error', /租约过期/.test(String(row.last_error)), String(row.last_error));
  ok('C 未过期 running 不受影响', (() => {
    enqueue(db, 1);
    db.exec(`UPDATE projection_outbox SET status='running', worker_token='w_live', lease_expires_at='2099-01-01T00:00:00.000Z' WHERE id = 2`);
    outbox.recoverStale();
    return statusOf(db, 2).status === 'running';
  })());
}

console.log('【D. token 守卫：旧 worker 不能覆盖新 worker】');
{
  const db = makeDb();
  enqueue(db, 1);
  // 当前持有者是 w_new（新 worker 已接管），旧 worker w_old 晚到的写回必须被拒绝。
  db.exec(`UPDATE projection_outbox SET status='running', worker_token='w_new', lease_expires_at='2099-01-01T00:00:00.000Z'`);
  const outbox = createProjectionOutbox({ db, workerToken: 'w_old' });
  ok('D 旧 token 写 done 被拒绝', outbox.markDone(1, 'w_old') === 0 && statusOf(db, 1).status === 'running', JSON.stringify(statusOf(db, 1)));
  ok('D 旧 token 写 failed 被拒绝', outbox.markFailed(1, 'w_old', 'x') === 0 && statusOf(db, 1).status === 'running', JSON.stringify(statusOf(db, 1)));
  ok('D 持有 token 才能写 done', outbox.markDone(1, 'w_new') === 1 && statusOf(db, 1).status === 'done', JSON.stringify(statusOf(db, 1)));
}

console.log('【E. 并发认领不重复】');
{
  const db = makeDb();
  enqueue(db, 5);
  const a = createProjectionOutbox({ db, workerToken: 'w_a' });
  const b = createProjectionOutbox({ db, workerToken: 'w_b' });
  const claimed = [];
  for (let i = 0; i < 6; i += 1) {
    const row = (i % 2 === 0 ? a : b).claim();
    if (row) claimed.push(row.id);
  }
  ok('E 五条各被认领一次', claimed.length === 5 && new Set(claimed).size === 5, JSON.stringify(claimed));
  ok('E 认领后无 pending', a.summary().pending === 0 && a.summary().running === 5, JSON.stringify(a.summary()));
}

async function freePort() {
  return new Promise((resolvePort) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); }); });
}
console.log('【F. 重启恢复（真实实例 + 过期 running）】');
{
  const dir = mkdtempSync(join(tmpdir(), 'novel-1018-t06-'));
  const seed = new DatabaseSync(join(dir, 'novel.db'));
  seed.exec(`CREATE TABLE IF NOT EXISTS projection_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, chapter_id INTEGER, kind TEXT NOT NULL, dedup_key TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z', updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');`);
  // 注意：这里故意不建 worker_token/lease_expires_at，由服务端迁移补列（验证增量迁移）。
  seed.prepare(`INSERT INTO projection_outbox (work_id, kind, status) VALUES (1, 'ov_work_sync', 'pending')`).run();
  seed.close();
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t06' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logText = '';
  child.stdout.on('data', (c) => { logText += c; });
  child.stderr.on('data', (c) => { logText += c; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/readiness`, { signal: AbortSignal.timeout(2000) }); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 300));
  }
  ok('F 实例就绪', ready, logText.slice(-300));
  // 塞一条"崩溃时 running 且租约过期"的记录，再重启
  const mid = new DatabaseSync(join(dir, 'novel.db'));
  mid.exec('PRAGMA busy_timeout = 5000');
  mid.prepare(`INSERT INTO projection_outbox (work_id, kind, status, attempts, worker_token, lease_expires_at) VALUES (1, 'ov_work_sync', 'running', 2, 'w_dead', '2000-01-01T00:00:00.000Z')`).run();
  const crashedId = Number(mid.prepare('SELECT MAX(id) AS id FROM projection_outbox').get().id);
  mid.close();
  child.kill();
  await new Promise((r) => child.on('exit', r).setTimeout?.(15000));
  const port2 = await freePort();
  const child2 = spawn(process.execPath, ['server.js'], { cwd: REPO, env: { ...process.env, PORT: String(port2), NOVELSTUDIO_DATA_DIR: dir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t06-b' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log2 = '';
  child2.stdout.on('data', (c) => { log2 += c; });
  child2.stderr.on('data', (c) => { log2 += c; });
  ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port2}/api/readiness`, { signal: AbortSignal.timeout(2000) }); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 300));
  }
  ok('F 重启后实例就绪', ready, log2.slice(-300));
  const check = new DatabaseSync(join(dir, 'novel.db'));
  check.exec('PRAGMA busy_timeout = 5000');
  const row = check.prepare('SELECT * FROM projection_outbox WHERE id = ?').get(crashedId);
  const cols = check.prepare('PRAGMA table_info(projection_outbox)').all().map((r) => r.name);
  check.close();
  ok('F 迁移补出 worker_token/lease_expires_at 列', cols.includes('worker_token') && cols.includes('lease_expires_at'), JSON.stringify(cols));
  ok('F 过期 running 已被恢复处理（不再悬挂）', row && row.status !== 'running', JSON.stringify(row));
  ok('F 恢复后 attempts 递增', Number(row?.attempts) >= 3, JSON.stringify({ attempts: row?.attempts }));
  child2.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

console.log(`\nT06 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
