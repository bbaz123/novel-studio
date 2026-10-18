#!/usr/bin/env node
// v1.2.0 回归套件 · T03：P01 伏笔状态 + 回收事件 + 审批消费同一事务。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PORT = await new Promise((resolvePort) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePort(5400 + (process.pid % 400)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
  }).catch(() => resolvePort(5400 + (process.pid % 400)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1018-t03-'));
const AGENT = { 'x-novel-agent': '1' };
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

async function j(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t03' },
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

const eventsOf = async (workId) => (await j(`/api/novel/events?work_id=${workId}&limit=200`)).data.events || [];
const addEvent = async (workId, body) => (await j('/api/novel/events', { method: 'POST', body: { work_id: workId, ...body } })).data;
const approvalOf = async (workId, id) => ((await j(`/api/novel/approvals?work_id=${workId}&status=all&limit=200`)).data.approvals || []).find((a) => a.id === id) || null;

try {
  const workA = (await j('/api/works', { method: 'POST', body: { title: 'T03 A' } })).data.id;
  const workB = (await j('/api/works', { method: 'POST', body: { title: 'T03 B' } })).data.id;

  console.log('【A. 合法回收：状态与关联同时提交】');
  const f1 = await addEvent(workA, { kind: 'foreshadow', summary: 'A 伏笔 1', foreshadow_status: 'open' });
  const e1 = await addEvent(workA, { kind: 'event', summary: 'A 回收事件' });
  const okResolve = await j(`/api/novel/foreshadows/${f1.id}/status`, { method: 'POST', body: { status: 'resolved', resolves_event_id: e1.id } });
  ok('A 合法回收 200', okResolve.status === 200, `实际 ${okResolve.status} ${JSON.stringify(okResolve.data).slice(0, 120)}`);
  let rows = await eventsOf(workA);
  const f1After = rows.find((r) => r.id === f1.id);
  ok('A 状态已 resolved', f1After?.foreshadow_status === 'resolved', JSON.stringify(f1After));
  ok('A 关联已写入', Number(f1After?.resolves_event_id) === Number(e1.id), JSON.stringify({ resolves: f1After?.resolves_event_id }));

  // A2（2026-10-18 插件冒烟实测补的回归）：`foreshadow_status` 的**存储默认值是空串**，
  // 而空串在业务语义里就是 open。旧 CAS 判据只把 NULL 当 open，于是"新建且没显式写状态"的伏笔
  // 第一次更新必然 0 行 → 409（把合法操作说成并发冲突）。这里用**不传 foreshadow_status** 的
  // 建法复现真实默认值，断言第一次更新必须成功。
  const fDefault = await addEvent(workA, { kind: 'foreshadow', summary: 'A 伏笔（默认空串状态）' });
  const defaultRow = (await eventsOf(workA)).find((r) => r.id === fDefault.id);
  ok('A2 新建伏笔未显式写状态时落库为空串（真实默认值）',
    String(defaultRow?.foreshadow_status || '') === '' || defaultRow?.foreshadow_status === 'open',
    JSON.stringify({ status: defaultRow?.foreshadow_status }));
  const firstUpdate = await j(`/api/novel/foreshadows/${fDefault.id}/status`, { method: 'POST', body: { status: 'resolved' } });
  ok('A2 空串状态按 open 归一：第一次更新 200（不再误判 409 并发冲突）',
    firstUpdate.status === 200, `实际 ${firstUpdate.status} ${JSON.stringify(firstUpdate.data).slice(0, 120)}`);
  const defaultAfter = (await eventsOf(workA)).find((r) => r.id === fDefault.id);
  ok('A2 更新后状态确为 resolved', defaultAfter?.foreshadow_status === 'resolved', JSON.stringify(defaultAfter));

  console.log('【B. 非法目标：三类状态均不变】');
  const f2 = await addEvent(workA, { kind: 'foreshadow', summary: 'A 伏笔 2', foreshadow_status: 'open' });
  const eB = await addEvent(workB, { kind: 'event', summary: 'B 事件' });
  const snapshot = async () => (await eventsOf(workA)).find((r) => r.id === f2.id);
  const before2 = await snapshot();
  const missing = await j(`/api/novel/foreshadows/${f2.id}/status`, { method: 'POST', body: { status: 'resolved', resolves_event_id: 999999 } });
  ok('B 不存在目标 404', missing.status === 404, `实际 ${missing.status}`);
  ok('B 失败后状态未变', (await snapshot())?.foreshadow_status === before2.foreshadow_status);
  ok('B 失败后关联未变', (await snapshot())?.resolves_event_id === before2.resolves_event_id);
  const cross = await j(`/api/novel/foreshadows/${f2.id}/status`, { method: 'POST', body: { status: 'resolved', resolves_event_id: eB.id } });
  ok('B 跨作品目标 400', cross.status === 400, `实际 ${cross.status}`);
  ok('B 跨作品后状态未变', (await snapshot())?.foreshadow_status === 'open');
  const bad = await j(`/api/novel/foreshadows/${f2.id}/status`, { method: 'POST', body: { status: 'resolved', resolves_event_id: '12abc' } });
  ok('B 非法数字 400', bad.status === 400, `实际 ${bad.status}`);

  console.log('【C. 模型通道：审批必须与写入同生共死】');
  const f3 = await addEvent(workA, { kind: 'foreshadow', summary: 'A 伏笔 3', foreshadow_status: 'open' });
  const noAp = await j(`/api/novel/foreshadows/${f3.id}/status`, { method: 'POST', headers: AGENT, body: { status: 'resolved', resolves_event_id: e1.id } });
  ok('C 无审批 403', noAp.status === 403, `实际 ${noAp.status}`);
  ok('C 无审批状态未变', (await eventsOf(workA)).find((r) => r.id === f3.id)?.foreshadow_status === 'open');

  const ap = await j('/api/novel/approvals', { method: 'POST', body: { work_id: workA, op: 'foreshadow_status', event_id: f3.id, status: 'resolved' } });
  ok('C 作者创建伏笔审批 201', ap.status === 201, `实际 ${ap.status} ${JSON.stringify(ap.data).slice(0, 160)}`);
  const apId = ap.data.id;
  const wrongTarget = await j(`/api/novel/foreshadows/${f3.id}/status`, { method: 'POST', headers: AGENT, body: { status: 'resolved', resolves_event_id: eB.id, approval_id: apId } });
  ok('C 非法目标 400（带审批）', wrongTarget.status === 400, `实际 ${wrongTarget.status}`);
  ok('C 失败后审批仍 active（未被吃掉）', (await approvalOf(workA, apId))?.status === 'active', JSON.stringify(await approvalOf(workA, apId)));
  ok('C 失败后状态未变', (await eventsOf(workA)).find((r) => r.id === f3.id)?.foreshadow_status === 'open');
  const goodAgent = await j(`/api/novel/foreshadows/${f3.id}/status`, { method: 'POST', headers: AGENT, body: { status: 'resolved', resolves_event_id: e1.id, approval_id: apId } });
  ok('C 同一审批随后成功 200', goodAgent.status === 200, `实际 ${goodAgent.status} ${JSON.stringify(goodAgent.data).slice(0, 120)}`);
  ok('C 成功后审批 consumed', (await approvalOf(workA, apId))?.status === 'consumed');

  console.log('【D. 并发：同一审批最多成功一次】');
  const f4 = await addEvent(workA, { kind: 'foreshadow', summary: 'A 伏笔 4', foreshadow_status: 'open' });
  const ap2 = (await j('/api/novel/approvals', { method: 'POST', body: { work_id: workA, op: 'foreshadow_status', event_id: f4.id, status: 'resolved' } })).data.id;
  const fire = () => j(`/api/novel/foreshadows/${f4.id}/status`, { method: 'POST', headers: AGENT, body: { status: 'resolved', resolves_event_id: e1.id, approval_id: ap2 } });
  const [r1, r2] = await Promise.all([fire(), fire()]);
  const statuses = [r1.status, r2.status].sort();
  ok('D 并发结果恰为一次成功', statuses[0] === 200 && statuses[1] === 403, JSON.stringify(statuses));
  const f4After = (await eventsOf(workA)).find((r) => r.id === f4.id);
  ok('D 最终状态 resolved 且无中间态', f4After?.foreshadow_status === 'resolved', JSON.stringify(f4After));
  ok('D 审批只被消费一次', (await approvalOf(workA, ap2))?.status === 'consumed');
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}
console.log(`\nT03 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
