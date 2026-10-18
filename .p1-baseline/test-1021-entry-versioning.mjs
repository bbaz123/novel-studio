#!/usr/bin/env node
/**
 * .p1-baseline/test-1021-entry-versioning.mjs —— v1.2.2 P1-1：词条不可变版本 + 回滚 + 版本验收。
 *
 * 覆盖：
 *   · 每次保存产生追加式版本；当前指针只增不减；
 *   · 回滚 = 写回目标版内容 + 新增一版（不删除历史）；
 *   · 模型通道不得回滚（作者决策）；
 *   · 语义验收器：引用词条版本 ≠ 当前版本 → ENTRY_VERSION_STALE（不按旧口径判冲突）。
 *
 * 隔离实例 + 临时数据目录；零计费；退出码是唯一判据。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const AGENT = { 'x-novel-agent': '1' };
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

const PORT = await new Promise((res) => {
  const probe = net.createServer();
  probe.once('error', () => res(5900 + (process.pid % 200)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1021-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });
const j = async (path, o = {}) => {
  const res = await fetch(BASE + path, {
    method: o.method || 'GET', headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
};
const ready = async () => {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/works`)).status === 200) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

try {
  if (!(await ready())) { console.error('实例未就绪\n' + log.slice(-1500)); process.exit(2); }
  const workId = (await j('/api/works', { method: 'POST', body: { title: '词条版本' } })).data.id;

  console.log('【A. 保存即版本，指针只增不减】');
  const created = await j('/api/world_entries', { method: 'POST', body: { work_id: workId, title: '职业方向', content: 'D级·无战斗能力' } });
  const entryId = created.data.id;
  ok('A1 词条创建成功', created.status === 201 && Number(entryId) > 0, JSON.stringify(created.data));
  let vers = await j(`/api/novel/world_entries/versions?entry_id=${entryId}`);
  ok('A2 新建即 v1 且历史 1 条', vers.status === 200 && vers.data.current_version === 1 && vers.data.versions.length === 1,
    JSON.stringify(vers.data).slice(0, 200));
  const put2 = await j(`/api/world_entries/${entryId}`, { method: 'PUT', body: { content: 'D级·基础战斗能力' } });
  const put3 = await j(`/api/world_entries/${entryId}`, { method: 'PUT', body: { content: 'D级·无战斗能力（修订）' } });
  ok('A3 两次保存都成功', put2.status === 200 && put3.status === 200, JSON.stringify({ p2: put2.status, p3: put3.status }));
  vers = await j(`/api/novel/world_entries/versions?entry_id=${entryId}`);
  ok('A4 保存产生追加式版本（v1/v2/v3），当前指针=3',
    vers.data.current_version === 3 && vers.data.versions.length === 3
    && vers.data.versions.map((v) => v.version).join(',') === '3,2,1',
    JSON.stringify(vers.data.versions.map((v) => v.version)));

  console.log('【B. 回滚 = 恢复内容 + 新增一版（历史不删）】');
  const rb = await j('/api/novel/world_entries/rollback', { method: 'POST', body: { entry_id: entryId, version: 1, note: '回到 D 级原始口径' } });
  ok('B1 回滚成功且返回新版本号 4', rb.status === 200 && rb.data.version === 4 && rb.data.restored_from === 1,
    JSON.stringify(rb.data).slice(0, 200));
  vers = await j(`/api/novel/world_entries/versions?entry_id=${entryId}`);
  ok('B2 回滚后历史 4 条、当前指针=4（不删历史）',
    vers.data.current_version === 4 && vers.data.versions.length === 4, JSON.stringify(vers.data.current_version));
  const row = await j(`/api/world_entries/${entryId}`);
  ok('B3 当前内容已恢复为 v1 的正文', String(row.data.content || '').includes('D级·无战斗能力') && !String(row.data.content).includes('修订'),
    String(row.data.content));
  const missing = await j('/api/novel/world_entries/rollback', { method: 'POST', body: { entry_id: entryId, version: 99 } });
  ok('B4 不存在的版本 → 404（不静默创建空版本）', missing.status === 404, String(missing.status));

  console.log('【C. 作者通道边界】');
  const agent = await j('/api/novel/world_entries/rollback', {
    method: 'POST', headers: AGENT, body: { entry_id: entryId, version: 1 },
  });
  ok('C1 模型通道回滚 → 403（正典决策只由作者做）', agent.status === 403, String(agent.status));

  console.log('【D. 语义验收器：引用词条版本必须与当前一致】');
  await import(new URL('../public/revision-semantic-verifier.js', import.meta.url).href);
  const SV = globalThis.NovelRevisionSemanticVerifier;
  const finding = { id: 'R-1', title: '词条冲突', evidence: [{ quote: 'D级·无战斗能力', role: 'candidate_edit' }], acceptance: { rule: '与词条一致', preserve: [] } };
  const base = '检测单上写着：D级·无战斗能力。';
  const revised = '检测单上写着：D级·基础战斗能力。';
  const stale = SV.verifyIssue({
    finding, baseText: base, revisedText: revised,
    applied: [{ issue_ids: ['R-1'], op: 'replace', original: 'D级·无战斗能力', replacement: 'D级·基础战斗能力', start: base.indexOf('D级·无战斗能力'), end: base.indexOf('D级·无战斗能力') + 8 }],
    entryVersions: { 'R-1': { entry_id: entryId, referenced_version: 1, current_version: 3 } },
    semantic: { status: 'pass', reason: '模型自报与词条一致' },
  });
  ok('D1 引用 v1、当前 v3 → ENTRY_VERSION_STALE 且不得判通过',
    stale.verdict !== 'pass' && stale.checks.some((c) => c.code === 'ENTRY_VERSION_STALE' && !c.passed),
    JSON.stringify({ verdict: stale.verdict, code: stale.reason_code }));
  const match = SV.verifyIssue({
    finding, baseText: base, revisedText: revised,
    applied: [{ issue_ids: ['R-1'], op: 'replace', original: 'D级·无战斗能力', replacement: 'D级·基础战斗能力', start: base.indexOf('D级·无战斗能力'), end: base.indexOf('D级·无战斗能力') + 8 }],
    entryVersions: { 'R-1': { entry_id: entryId, referenced_version: 4, current_version: 4 } },
    semantic: { status: 'pass', reason: '按当前版词条核对通过' },
  });
  ok('D2 引用版本=当前版本 → 版本检查通过（可判 ISSUE_VERIFIED）',
    match.verdict === 'pass' && match.final_status === 'ISSUE_VERIFIED',
    JSON.stringify({ verdict: match.verdict, final: match.final_status }));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
}

console.log(`\n[test-1021] 通过 ${pass} / 未通过 ${fails.length}`);
if (!pass) { console.error('零用例：拒绝当作通过'); process.exit(2); }
if (fails.length) { console.error('未通过：' + fails.join('; ')); process.exitCode = 1; }
