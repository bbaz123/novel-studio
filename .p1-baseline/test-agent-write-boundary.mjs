#!/usr/bin/env node
/**
 * test-agent-write-boundary.mjs —— 「模型侧工具不得越权/不得静默写入」的零计费离线测试。
 *
 * 覆盖的任务书条目（R02）：
 *   1) 非法 action 必须校验失败，**不发出任何状态写入请求**（旧缺陷：未知值落入 apply）；
 *   2) 未知字段、id/ids/all 组合必须显式失败；
 *   3) 合法调用保持兼容（默认 review、apply 三种形态、snapshot create/rollback）。
 *
 * 做法：用 mock ctx 真正加载 `novel-tools.mjs`，把 NOVELSTUDIO_BASE_URL 指向本文件内起的
 * 本地 stub HTTP 端点（端口由内核分配），逐条记录请求；断言只允许 /api/logs（异常上报）
 * 出现在被拒绝的调用里，绝不允许 /api/novel/state/* 写入端点出现。
 *
 * 零计费：无 dsh、无模型、无外网；只用 localhost stub。
 * 用法: node .p1-baseline/test-agent-write-boundary.mjs
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pluginDir = path.join(REPO, 'harness-plugins', 'novel-writing');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ── 本地 stub：记录每个请求；按路径回罐头响应 ────────────────────────────────
const requests = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* 保留原始串 */ }
    requests.push({ method: req.method, path: req.url.split('?')[0], query: req.url, body: json });
    res.setHeader('content-type', 'application/json');
    const reply = (obj) => { res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/api/novel/story_state')) return reply({ ok: true, enabled: true, facts: 0, timeline: 0, knowledge: 0, entities: 0, contracts: 0, proposals_pending: 1, proposals_stale: 0, snapshots: 1, validations: 0, state_hash: 'stub' });
    if (req.url.startsWith('/api/novel/state/proposals/review')) return reply({ ok: true, decision: 'applicable', plan_ops: 2, reason: '' });
    if (req.url.startsWith('/api/novel/state/proposals/reject')) return reply({ ok: true });
    if (req.url.startsWith('/api/novel/state/proposals/apply')) return reply({ ok: true, applied: 1, stale: 0, results: [{ ok: true, proposal_id: 3, snapshot_id: 4, state_hash_before: 'a', state_hash_after: 'b' }] });
    if (req.url.startsWith('/api/novel/state/snapshot')) return reply({ ok: true, id: 9, state_hash: 'h' });
    if (req.url.startsWith('/api/novel/state/rollback')) return reply({ ok: true, snapshot_id: 9, ops: 1, safety_snapshot_id: 10, note: '' });
    if (req.url.startsWith('/api/novel/approvals')) return reply({ ok: true, ops: ['chapter_save', 'state_proposal_apply', 'proposal_apply', 'state_rollback'], approvals: [{ id: 'apv_test1', op: 'state_proposal_apply', chapter_id: 3, expires_at: '2099-01-01T00:00:00.000Z', binding_json: '{"proposals":[3]}' }] });
    if (req.url.startsWith('/api/novel/chapter_save')) return reply({ ok: true, chapter_id: 3, version_id: 1, scan: { total: 0, hits: [] } });
    return reply({ ok: true });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

process.env.NOVELSTUDIO_BASE_URL = stubBase;
process.env.NOVELSTUDIO_WORK_ID = '7';
delete process.env.NOVELSTUDIO_PROPOSE_MODE;

const mod = await import(pathToFileURL(path.join(pluginDir, 'novel-tools.mjs')).href);
const tools = new Map();
mod.apply({ tools: { register(t) { tools.set(t.name, t); } } }, { baseUrl: 'http://127.0.0.1:1' });

const stateWritePaths = () => requests.filter((r) => r.path.startsWith('/api/novel/state/proposals') || r.path.startsWith('/api/novel/state/snapshot') || r.path.startsWith('/api/novel/state/rollback'));
const reset = () => { requests.length = 0; };
async function call(name, args) {
  const tool = tools.get(name);
  if (!tool) throw new Error('工具未注册：' + name);
  try { return { text: await tool.execute(args), error: null }; }
  catch (e) { return { text: '', error: e }; }
}

const commit = (args) => call('novel_state_commit', args);
const snap = (args) => call('novel_snapshot', args);

console.log('【A. 非法 action 不得落入写入】');
{
  reset();
  const r = await commit({ work_id: '7', action: 'aply', id: '3' });
  ok('拼写错误 action=aply 抛错', !!r.error, r.error ? '' : '没有抛错');
  ok('  └ 且未发出任何状态写入请求', stateWritePaths().length === 0, JSON.stringify(stateWritePaths().map((x) => x.path)));

  reset();
  const r2 = await commit({ work_id: '7', action: 'apply\n', id: '3', approval_id: 'apv_nl' });
  ok('空白归一化：apply\\n 只归一为 apply（写入只落 proposals/apply）',
    !r2.error && requests.every((x) => ['/api/novel/state/proposals/apply', '/api/logs', '/api/novel/story_state'].includes(x.path)), r2.error ? r2.error.message : JSON.stringify(requests.map((x) => x.path)));

  reset();
  const r2b = await commit({ work_id: '7', action: 'apply;drop', id: '3' });
  ok('不可归一化 action=apply;drop 抛错且无写入', !!r2b.error && stateWritePaths().length === 0);

  reset();
  const r3 = await commit({ work_id: '7', action: 'delete', all: true });
  ok('未白名单 action=delete 抛错且无写入', !!r3.error && stateWritePaths().length === 0);

  reset();
  const r4 = await commit({ work_id: '7', action: 'APPLY', id: '3', approval_id: 'apv_test1' });
  ok('大小写归一：APPLY 合法（发往 proposals/apply）', !r4.error && requests.some((x) => x.path === '/api/novel/state/proposals/apply'), r4.error ? r4.error.message : '');
}

console.log('\n【B. 默认与合法调用保持兼容】');
{
  reset();
  const r = await commit({ work_id: '7', id: '3' });
  const req = requests.find((x) => x.path === '/api/novel/state/proposals/review');
  ok('缺省 action 仍为 review（只读）', !r.error && !!req && req.body.id === 3 && !requests.some((x) => x.path.endsWith('/apply')), r.error ? r.error.message : '');

  reset();
  const r2 = await commit({ work_id: '7', action: 'apply', ids: ['3', '4'], approval_id: 'apv_test2' });
  const req2 = requests.find((x) => x.path === '/api/novel/state/proposals/apply');
  ok('apply + ids + approval_id 正常发写请求（审批 id 透传）',
    !r2.error && !!req2 && JSON.stringify(req2.body.ids) === '[3,4]' && req2.body.approval_id === 'apv_test2', r2.error ? r2.error.message : JSON.stringify(req2 && req2.body));

  reset();
  const r3 = await commit({ work_id: '7', action: 'apply', all: true, approval_id: 'apv_test3' });
  const req3 = requests.find((x) => x.path === '/api/novel/state/proposals/apply');
  ok('apply + all=true 正常发写请求', !r3.error && !!req3 && req3.body.all === true, r3.error ? r3.error.message : '');

  reset();
  const r4 = await commit({ work_id: '7', action: 'reject', id: '3', note: '不同意' });
  ok('reject + id 正常', !r4.error && requests.some((x) => x.path === '/api/novel/state/proposals/reject'), r4.error ? r4.error.message : '');
}

console.log('\n【C. id/ids/all 组合与未知字段】');
{
  reset();
  const r = await commit({ work_id: '7', action: 'apply' });
  ok('apply 缺 id/ids/all → 抛错且无写入', !!r.error && stateWritePaths().length === 0);

  reset();
  const r2 = await commit({ work_id: '7', action: 'apply', id: '3', all: true });
  ok('apply id+all 组合 → 抛错且无写入', !!r2.error && stateWritePaths().length === 0);

  reset();
  const r3 = await commit({ work_id: '7', action: 'apply', ids: ['0', '-1', 'x'] });
  ok('apply ids 全非法 → 抛错且无写入', !!r3.error && stateWritePaths().length === 0);

  reset();
  const r4 = await commit({ work_id: '7', action: 'reject', ids: ['3'] });
  ok('reject + ids → 抛错（一次只驳回一条）且无写入', !!r4.error && stateWritePaths().length === 0);

  reset();
  const r5 = await commit({ work_id: '7', action: 'apply', id: '3', op: 'apply' });
  ok('未知字段 op → 抛错且无写入', !!r5.error && stateWritePaths().length === 0);
}

console.log('\n【D. snapshot 工具同类校验】');
{
  reset();
  const r = await snap({ work_id: '7', action: 'rollbak', snapshot_id: '9' });
  ok('action=rollbak 抛错且不落快照/不回滚', !!r.error && stateWritePaths().length === 0);

  reset();
  const r2 = await snap({ work_id: '7', action: 'rollback' });
  ok('rollback 缺 snapshot_id → 抛错且无写入', !!r2.error && stateWritePaths().length === 0);

  reset();
  const r3 = await snap({ work_id: '7' });
  ok('缺省 action 仍为 create（落快照）', !r3.error && requests.some((x) => x.path === '/api/novel/state/snapshot'), r3.error ? r3.error.message : '');

  reset();
  const r4 = await snap({ work_id: '7', action: 'rollback', snapshot_id: '9' });
  ok('rollback 缺 approval_id → 抛错且无写入（R02.2 执行边界）', !!r4.error && !requests.some((x) => x.path === '/api/novel/state/rollback'), r4.error ? '' : '没有抛错');

  reset();
  const r5 = await snap({ work_id: '7', action: 'rollback', snapshot_id: '9', approval_id: 'apv_rb' });
  ok('rollback + snapshot_id + approval_id 正常', !r5.error && requests.some((x) => x.path === '/api/novel/state/rollback' && x.body.approval_id === 'apv_rb'), r5.error ? r5.error.message : '');
}

console.log('\n【E. 模型侧写入必须引用作者审批（R02.2）】');
{
  reset();
  const r = await commit({ work_id: '7', action: 'apply', id: '3' });
  ok('apply 缺 approval_id → 抛错且不发出写请求', !!r.error && !requests.some((x) => x.path === '/api/novel/state/proposals/apply'), r.error ? '' : '没有抛错');

  reset();
  const r2 = await call('novel_chapter_save', { work_id: '7', chapter_id: '3', content: '正文' });
  ok('chapter_save 缺 approval_id → 抛错且不发出写请求', !!r2.error && !requests.some((x) => x.path === '/api/novel/chapter_save'), r2.error ? '' : '没有抛错');

  reset();
  const r3 = await call('novel_chapter_save', { work_id: '7', chapter_id: '3', content: '正文', approval_id: 'apv_ch' });
  ok('chapter_save 带 approval_id → 请求体透传审批 id',
    !r3.error && requests.some((x) => x.path === '/api/novel/chapter_save' && x.body.approval_id === 'apv_ch'), r3.error ? r3.error.message : JSON.stringify(requests.map((x) => x.body)));

  reset();
  const r4 = await call('novel_approvals', { work_id: '7' });
  const approvalsText = String((r4.text && r4.text.text) || r4.text || '');
  ok('novel_approvals 只读列出作者审批（含 id / op / 有效期）',
    !r4.error && approvalsText.includes('apv_test1') && approvalsText.includes('state_proposal_apply') && !requests.some((x) => x.method !== 'GET'), r4.error ? r4.error.message : approvalsText.slice(0, 80));
}

await new Promise((r) => setTimeout(r, 120)); // 让 fire-and-forget 的 /api/logs 上报落地
stub.close();

console.log(`\n合计：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n  - ' + fails.join('\n  - ')); process.exitCode = 1; }
