#!/usr/bin/env node
/**
 * .p1-baseline/test-1023-foreshadow-autoregister.mjs —— v1.2.2 P1-3：疑伏笔自动登记为待确认候选。
 *
 * 覆盖：
 *   · 只把 `possible_foreshadowing`（或明确暗示词）转候选，普通 deferred 不转；
 *   · 幂等去重（同 work 同归一化摘要只登记一次）；
 *   · 每章上限（避免一次审稿刷出几十条噪音）；
 *   · 登记只写 pending 提案，**不写事件账本**（作者确认后才成为正典）。
 *
 * 纯函数 + 隔离实例 HTTP；零计费；退出码是唯一判据。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('【A. 规划器（纯函数）】');
const FA = await import(new URL('../ai/story-state/foreshadow-autoregister.mjs', import.meta.url).href);
{
  const plan = FA.planAutoRegistrations({
    workId: 7, chapterId: 3,
    deferred: [
      { text: '陌生人的怀表可能是伏笔', type: 'possible_foreshadowing' },
      { text: '普通的一句话，不是伏笔', type: 'other' },
      { text: '她后面会解释的异象' },
      { text: '陌生人的怀表可能是伏笔', type: 'possible_foreshadowing' },
    ],
  });
  ok('A1 只挑疑似伏笔（type 或暗示词），普通 deferred 不转',
    plan.candidates.length === 2 && plan.candidates[0].summary === '陌生人的怀表可能是伏笔'
    && plan.skipped.some((s) => s.reason === 'not_foreshadow'),
    JSON.stringify(plan));
  ok('A2 同批重复摘要只登记一次', plan.candidates.filter((c) => c.summary === '陌生人的怀表可能是伏笔').length === 1);
  ok('A3 候选只带摘要/去重键/说明，不含任何状态迁移字段',
    plan.candidates.every((c) => c.summary && c.dedup_key.startsWith('auto-foreshadow:7:') && c.note && !('status' in c)));
  const dup = FA.planAutoRegistrations({
    workId: 7, chapterId: 4,
    deferred: [{ text: '陌生人的怀表可能是伏笔', type: 'possible_foreshadowing' }],
    existingSummaries: ['陌生人的怀表可能是伏笔'],
  });
  ok('A4 已存在同摘要 → duplicate_summary（不重复登记）',
    dup.candidates.length === 0 && dup.skipped[0].reason === 'duplicate_summary', JSON.stringify(dup.skipped));
  const many = Array.from({ length: 15 }, (_, i) => ({ text: `伏笔线索 ${i}`, type: 'possible_foreshadowing' }));
  const capped = FA.planAutoRegistrations({ workId: 7, chapterId: 5, deferred: many, limit: 10 });
  ok('A5 每章上限 10 条（其余 over_limit）',
    capped.candidates.length === 10 && capped.skipped.filter((s) => s.reason === 'over_limit').length === 5,
    JSON.stringify({ c: capped.candidates.length, s: capped.skipped.length }));
}

console.log('【B. 真实实例：审稿落库时自动登记】');
const PORT = await new Promise((res) => {
  const probe = net.createServer();
  probe.once('error', () => res(6050 + (process.pid % 150)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1023-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });
const j = async (path, o = {}) => {
  const res = await fetch(BASE + path, {
    method: o.method || 'GET', headers: { 'content-type': 'application/json' },
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
  if (!(await ready())) { console.error('实例未就绪\n' + log.slice(-1200)); process.exit(2); }
  const workId = (await j('/api/works', { method: 'POST', body: { title: '伏笔自动登记' } })).data.id;
  const chapterId = (await j('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第1章', content: '<p>正文</p>' } })).data.id;
  const report = {
    summary: '总评',
    issues: [{ text: '重复句' }],
    deferred: [
      { text: '陌生人的怀表可能是伏笔', type: 'possible_foreshadowing' },
      { text: '普通评论，不是伏笔', type: 'other' },
    ],
  };
  const put = await j('/api/novel/review', { method: 'PUT', body: { chapter_id: chapterId, report } });
  ok('B1 审稿落库成功', put.status === 201, JSON.stringify(put.data).slice(0, 160));
  const proposals = await j(`/api/novel/proposals?work_id=${workId}`);
  const fores = (proposals.data.proposals || []).filter((p) => p.kind === 'foreshadow');
  ok('B2 疑似伏笔被登记为 pending 提案（只一条）',
    fores.length === 1 && fores[0].summary === '陌生人的怀表可能是伏笔' && fores[0].status === 'pending',
    JSON.stringify(fores));
  const events = await j(`/api/novel/events?work_id=${workId}`);
  const foreshadowEvents = (events.data.events || []).filter((e) => e.kind === 'foreshadow');
  ok('B3 不写事件账本（作者确认前不是正典）', foreshadowEvents.length === 0, JSON.stringify(foreshadowEvents));
  const again = await j('/api/novel/review', { method: 'PUT', body: { chapter_id: chapterId, report } });
  const proposals2 = await j(`/api/novel/proposals?work_id=${workId}`);
  const fores2 = (proposals2.data.proposals || []).filter((p) => p.kind === 'foreshadow');
  ok('B4 重复保存同一份审稿 → 幂等，不重复登记', again.status === 201 && fores2.length === 1, String(fores2.length));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
}

console.log(`\n[test-1023] 通过 ${pass} / 未通过 ${fails.length}`);
if (!pass) { console.error('零用例：拒绝当作通过'); process.exit(2); }
if (fails.length) { console.error('未通过：' + fails.join('; ')); process.exitCode = 1; }
