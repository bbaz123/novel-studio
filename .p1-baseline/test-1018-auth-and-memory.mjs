#!/usr/bin/env node
// 临时探针（T2：P03 权限矩阵 + P02 记忆回滚边界）。最终会并入 test-1018-hardening.mjs。
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
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1018-t2-'));
const AGENT = { 'x-novel-agent': '1' };
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

async function j(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logText = '';
server.stdout.on('data', (c) => { logText += c; });
server.stderr.on('data', (c) => { logText += c; });
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await j('/api/novel/ping', {}); if (r.status === 200) ready = true; } catch { /* not ready */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('实例未就绪\n' + logText.slice(-2000)); process.exit(2); }

try {
  const work = await j('/api/works', { method: 'POST', body: { title: 'T2 作品' } });
  const workId = work.data.id;
  const other = await j('/api/works', { method: 'POST', body: { title: 'T2 另一部' } });
  const otherId = other.data.id;
  const chapter = await j('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第1章', content: '<p>正文</p>' } });
  const chapterId = chapter.data.id;

  console.log('【A. 模型通道必须 403】');
  const agentCases = [
    ['写作红线编辑', '/api/novel/redlines', { method: 'PUT', body: { work_id: workId, entries: [{ kind: 'phrase', pattern: 'T2-测试红线' }] } }],
    ['连续性豁免', '/api/novel/continuity_exemption', { method: 'POST', body: { work_id: workId, key: 'k:v' } }],
    ['连续性阈值', '/api/novel/continuity_thresholds', { method: 'POST', body: { work_id: workId, thresholds: { systemFrequencyMax: 3 } } }],
    ['蓝图保存', '/api/novel/chapter_blueprint', { method: 'PUT', body: { chapter_id: chapterId, blueprint: { scene_goal: '目标' } } }],
    ['蓝图删除', '/api/novel/chapter_blueprints', { method: 'DELETE', body: { chapter_id: chapterId } }],
    ['审稿提示关闭', '/api/novel/review/dismiss', { method: 'POST', body: { chapter_id: chapterId } }],
    ['审稿确认清单', '/api/novel/review/checklist', { method: 'PUT', body: { review_id: 1, checklist: { a: true } } }],
    ['生成稿关闭', '/api/novel/draft/dismiss', { method: 'POST', body: { chapter_id: chapterId } }],
    ['旧提案拒绝', '/api/novel/proposals/reject', { method: 'POST', body: { work_id: workId, id: 1 } }],
    ['状态提案拒绝', '/api/novel/state/proposals/reject', { method: 'POST', body: { id: 1 } }],
  ];
  for (const [name, path, opts] of agentCases) {
    const r = await j(path, { ...opts, headers: AGENT });
    ok(`A ${name} 模型通道 403`, r.status === 403, `实际 ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }

  // 模型拒绝后库确实没变：蓝图列表为空、红线为空
  const bp = await j(`/api/novel/chapter_blueprints?chapter_id=${chapterId}`);
  ok('A 蓝图未被写入（列表为空）', (bp.data.blueprints || []).length === 0, JSON.stringify(bp.data).slice(0, 120));
  const rl = await j(`/api/novel/redlines?work_id=${workId}`);
  ok('A 红线未被写入', !(rl.data.redlines || []).some((x) => String(x.pattern) === 'T2-测试红线'), JSON.stringify(rl.data).slice(0, 120));

  console.log('【B. 作者通道行为不变】');
  const authorRed = await j('/api/novel/redlines', { method: 'PUT', body: { work_id: workId, entries: [{ kind: 'phrase', pattern: 'T2-作者红线' }] } });
  ok('B 作者红线编辑 200', authorRed.status === 200, `实际 ${authorRed.status}`);
  const authorEx = await j('/api/novel/continuity_exemption', { method: 'POST', body: { work_id: workId, key: 'cat:1' } });
  ok('B 作者豁免 200', authorEx.status === 200, `实际 ${authorEx.status}`);
  const authorBp = await j('/api/novel/chapter_blueprint', { method: 'PUT', body: { chapter_id: chapterId, blueprint: { scene_goal: '作者的目标' } } });
  ok('B 作者蓝图保存 200', authorBp.status === 200, `实际 ${authorBp.status}`);
  const authorDel = await j('/api/novel/chapter_blueprints', { method: 'DELETE', body: { chapter_id: chapterId } });
  ok('B 作者蓝图删除 200', authorDel.status === 200, `实际 ${authorDel.status}`);

  console.log('【C. 记忆回滚边界】');
  const mem = await j('/api/story_memory', { method: 'PUT', body: { work_id: workId, summary: '第一版摘要' } });
  ok('C 作者写入记忆 200', mem.status === 200, `实际 ${mem.status}`);
  const mem2 = await j('/api/story_memory', { method: 'PUT', body: { work_id: workId, summary: '第二版摘要' } });
  ok('C 第二次写入 200', mem2.status === 200, `实际 ${mem2.status}`);
  const versions = await j(`/api/story_memory/versions?work_id=${workId}`);
  const firstVersion = (versions.data.versions || []).find((v) => v.summary === '第一版摘要');
  ok('C 版本列表有第一版', !!firstVersion, JSON.stringify(versions.data).slice(0, 200));

  const agentRollback = await j('/api/story_memory/rollback', { method: 'POST', body: { version_id: firstVersion.id }, headers: AGENT });
  ok('C 模型回滚 403', agentRollback.status === 403, `实际 ${agentRollback.status}`);
  const afterAgent = await j(`/api/story_memory?work_id=${workId}`);
  ok('C 模型回滚未改记忆', afterAgent.data.summary === '第二版摘要', String(afterAgent.data.summary));

  const badNum = await j('/api/story_memory/rollback', { method: 'POST', body: { version_id: 'abc' } });
  ok('C 非法 version_id 400', badNum.status === 400, `实际 ${badNum.status}`);
  const frac = await j('/api/story_memory/rollback', { method: 'POST', body: { version_id: 1.5 } });
  ok('C 小数 version_id 400', frac.status === 400, `实际 ${frac.status}`);
  const missing = await j('/api/story_memory/rollback', { method: 'POST', body: { version_id: 999999 } });
  ok('C 不存在版本 404', missing.status === 404, `实际 ${missing.status}`);

  const memOther = await j('/api/story_memory', { method: 'PUT', body: { work_id: otherId, summary: '另一部摘要' } });
  ok('C 另一部写入 200', memOther.status === 200, `实际 ${memOther.status}`);
  const crossWork = await j('/api/story_memory/rollback', { method: 'POST', body: { version_id: memOther.data.version_id, work_id: workId } });
  ok('C 跨作品声明 400', crossWork.status === 400, `实际 ${crossWork.status}`);
  const afterCross = await j(`/api/story_memory?work_id=${workId}`);
  ok('C 跨作品未改本作记忆', afterCross.data.summary === '第二版摘要', String(afterCross.data.summary));

  const goodRollback = await j('/api/story_memory/rollback', { method: 'POST', body: { version_id: firstVersion.id, work_id: workId } });
  ok('C 作者合法回滚 200', goodRollback.status === 200 && goodRollback.data.summary === '第一版摘要', `${goodRollback.status} ${JSON.stringify(goodRollback.data).slice(0, 160)}`);
  const afterRollback = await j(`/api/story_memory?work_id=${workId}`);
  ok('C 回滚后记忆为第一版', afterRollback.data.summary === '第一版摘要', String(afterRollback.data.summary));
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}
console.log(`\nT2 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
