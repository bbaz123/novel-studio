#!/usr/bin/env node
/**
 * .p1-baseline/test-1022-prop-chain.mjs —— v1.2.2 P1-2：道具状态链（章级迁移 + 逐字证据 + 验收）。
 *
 * 覆盖：
 *   · 状态迁移必须绑章节、必须带本章正文逐字证据（找不到/歧义都拒绝）；
 *   · 链按章序读回，最终状态可判；
 *   · 修稿验收：最终状态不符 / 证据在候选里丢失 → 确定性失败；
 *   · 模型通道不得登记（作者/内核写入口）。
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
  probe.once('error', () => res(5950 + (process.pid % 150)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1022-'));
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
  const workId = (await j('/api/works', { method: 'POST', body: { title: '道具状态链' } })).data.id;
  const c1 = (await j('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第1章', content: '<p>岳宸炎把检测单折过两折。</p>' } })).data.id;
  const c2 = (await j('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第2章', content: '<p>检测单最后折过一折。</p>' } })).data.id;
  const c3 = (await j('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第3章', content: '<p>他把检测单折过一折，又折过一折。</p>' } })).data.id;

  console.log('【A. 登记：必须带本章逐字证据】');
  const r1 = await j('/api/novel/prop_chain', { method: 'POST', body: { chapter_id: c1, prop_key: '检测单', prop_name: '检测单', state: '两折', evidence_quote: '折过两折' } });
  ok('A1 第1章登记成功（证据逐字命中）', r1.status === 201 && r1.data.occurrences === 1, JSON.stringify(r1.data));
  const r2 = await j('/api/novel/prop_chain', { method: 'POST', body: { chapter_id: c2, prop_key: '检测单', state: '一折', evidence_quote: '折过一折' } });
  ok('A2 第2章登记成功（链上第二个迁移）', r2.status === 201, JSON.stringify(r2.data));
  const notFound = await j('/api/novel/prop_chain', { method: 'POST', body: { chapter_id: c1, prop_key: '检测单', state: '三折', evidence_quote: '折过三折' } });
  ok('A3 证据不在本章 → 400（拒绝无证据的状态）', notFound.status === 400 && /EVIDENCE_NOT_FOUND/.test(JSON.stringify(notFound.data)),
    JSON.stringify(notFound.data));
  const ambiguous = await j('/api/novel/prop_chain', { method: 'POST', body: { chapter_id: c3, prop_key: '检测单', state: '两折', evidence_quote: '折过一折' } });
  ok('A4 同一证据出现两处 → 400（不猜是哪一处）', ambiguous.status === 400 && /EVIDENCE_AMBIGUOUS/.test(JSON.stringify(ambiguous.data)),
    JSON.stringify(ambiguous.data));
  const agent = await j('/api/novel/prop_chain', {
    method: 'POST', headers: AGENT, body: { chapter_id: c1, prop_key: '检测单', state: '两折', evidence_quote: '折过两折' },
  });
  ok('A5 模型通道登记 → 403（作者/内核写入口）', agent.status === 403, String(agent.status));

  console.log('【B. 链的读回与顺序】');
  const chain = await j(`/api/novel/prop_chain?work_id=${workId}&prop_key=${encodeURIComponent('检测单')}`);
  ok('B1 链按章序返回 2 条，最终状态=一折',
    chain.status === 200 && chain.data.chain.length === 2
    && chain.data.latest.state === '一折'
    && chain.data.chain.map((r) => r.chapter_id).join(',') === `${c1},${c2}`,
    JSON.stringify(chain.data.chain.map((r) => [r.chapter_id, r.state])));

  console.log('【C. 修稿验收：状态不符 / 证据丢失都判失败】');
  await import(new URL('../public/revision-semantic-verifier.js', import.meta.url).href);
  const SV = globalThis.NovelRevisionSemanticVerifier;
  const finding = { id: 'R-1', title: '检测单折数', evidence: [{ quote: '检测单', role: 'candidate_edit' }], acceptance: { rule: '最终折数与动作链一致', preserve: [] } };
  const baseText = '岳宸炎把检测单折过一折。';
  const revisedOk = '它折过一折。';
  const propChains = { 'R-1': { prop_key: '检测单', expected_state: '一折', chain: chain.data.chain } };
  const bad = SV.verifyIssue({
    finding, baseText, revisedText: baseText, applied: [],
    propChains: { 'R-1': { prop_key: '检测单', expected_state: '两折', chain: chain.data.chain } },
    semantic: { status: 'pass', reason: '模型自报' },
  });
  ok('C1 预期两折但链上最终一折 → PROP_STATE_MISMATCH，且不得通过',
    bad.verdict !== 'pass' && bad.checks.some((c) => c.code === 'PROP_STATE_MISMATCH' && !c.passed),
    JSON.stringify({ verdict: bad.verdict, code: bad.reason_code }));
  const lost = SV.verifyIssue({
    finding, baseText, revisedText: '他把单据收进口袋。', applied: [],
    propChains, semantic: { status: 'pass', reason: '模型自报' },
  });
  ok('C2 状态证据在候选里消失 → PROP_EVIDENCE_LOST（确定性失败，不得通过）',
    lost.verdict !== 'pass' && lost.checks.some((c) => c.code === 'PROP_EVIDENCE_LOST' && !c.passed),
    JSON.stringify({ verdict: lost.verdict, code: lost.reason_code }));
  const good = SV.verifyIssue({
    finding, baseText, revisedText: revisedOk,
    applied: [{ issue_ids: ['R-1'], op: 'replace', original: '检测单', replacement: '', start: baseText.indexOf('检测单'), end: baseText.indexOf('检测单') + 3 }],
    propChains, semantic: { status: 'pass', reason: '最终状态与证据一致' },
  });
  ok('C3 最终状态与证据都自洽 → 可判 ISSUE_VERIFIED', good.verdict === 'pass' && good.final_status === 'ISSUE_VERIFIED',
    JSON.stringify({ verdict: good.verdict, final: good.final_status }));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
}

console.log(`\n[test-1022] 通过 ${pass} / 未通过 ${fails.length}`);
if (!pass) { console.error('零用例：拒绝当作通过'); process.exit(2); }
if (fails.length) { console.error('未通过：' + fails.join('; ')); process.exitCode = 1; }
