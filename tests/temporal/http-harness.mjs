/**
 * tests/temporal/http-harness.mjs —— 时态重构 HTTP 级测试的共享设施（零依赖、零计费）。
 *
 * 纪律（与 docs/temporal-refactor-audit.md 一致）：
 *   · 只起**隔离实例**：NOVELSTUDIO_DATA_DIR 指向 mkdtemp 临时目录，绝不触碰真实 data/；
 *   · 只连**本机假模型**：脚本化 Chat Completions，不调用真实付费端点；
 *   · 所有作品/章节由测试自建并自清理（DELETE /api/works/:id）。
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const argValue = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const AGENT = { 'x-novel-agent': '1' };

export const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({
  domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}),
});
export const kv = (domain, entityId, predicate, scope = 'canon', holderId = null) => JSON.stringify([domain, entityId, predicate, scope, holderId]);
export const op = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });

/** 断言器：ok(name, cond, detail) + 统一 summary(name)。 */
export function createAssert() {
  let pass = 0;
  const fails = [];
  return {
    ok(name, cond, detail = '') {
      if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
      else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
    },
    summary(title) {
      console.log('\n' + '─'.repeat(46));
      console.log(`${title}：通过 ${pass} / 失败 ${fails.length}`);
      if (fails.length) for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
      return fails.length;
    },
    get pass() { return pass; },
    get fails() { return fails; },
  };
}

export function createClient(base) {
  const api = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };
  return {
    base, api,
    createWork: (title) => api('POST', '/api/works', { title: `${title}（自动化测试，自清理）` }),
    createChapter: (workId, title, extra = {}) => api('POST', '/api/chapters', { work_id: workId, title, ...extra }),
    proposalGroups: (workId, chapterId) => api('GET', `/api/novel/state/proposal-groups?work_id=${workId}${chapterId ? `&chapter_id=${chapterId}` : ''}`),
    applyBinding: (workId, chapterId, bindingId, extra = {}) => api('POST', `/api/novel/state/proposal-groups/${encodeURIComponent(String(bindingId))}/apply`, { work_id: workId, chapter_id: chapterId, ...extra }),
    stateAt: (workId, chapterId, extra = '') => api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${chapterId}&boundary=after${extra}`),
    stateBefore: (workId, chapterId, extra = '') => api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${chapterId}&boundary=before${extra}`),
    panel: (workId, chapterId, extra = '') => api('GET', `/api/novel/state/panel?work_id=${workId}&chapter_id=${chapterId}${extra}`),
    overview: (workId) => api('GET', `/api/novel/state/temporal?work_id=${workId}`),
    setTemporal: (workId, patch, headers = {}) => api('PUT', '/api/novel/state/temporal', { work_id: workId, ...patch }, headers),
    analyze: (workId, chapterId, headers = {}) => api('POST', '/api/novel/state/analyze', { work_id: workId, chapter_id: chapterId }, headers),
    correct: (workId, chapterId, corrections, extra = {}, headers = {}) => api('POST', '/api/novel/state/correct', { work_id: workId, chapter_id: chapterId, corrections, ...extra }, headers),
    createApproval: (body) => api('POST', '/api/novel/approvals', body),
    listApprovals: (workId, status = 'active') => api('GET', `/api/novel/approvals?work_id=${workId}&status=${status}`),
    deleteWork: (workId) => api('DELETE', `/api/works/${workId}`),
  };
}

/** 轮询：等某章的某个提案达到条件（分析是后台任务，产生时机不确定）。 */
export async function waitProposal(client, workId, chapterId, accept, { timeout = 25000 } = {}) {
  const t0 = Date.now();
  let last = '(none)';
  while (Date.now() - t0 < timeout) {
    const r = await client.proposalGroups(workId, chapterId);
    const ps = (r.json && r.json.proposals) || [];
    last = ps.map((p) => `${p.status}${p.analysis && p.analysis.provider ? '/' + p.analysis.provider : ''}`).join(',') || '(none)';
    const hit = ps.find(accept);
    if (hit) return { proposal: hit, last };
    await sleep(250);
  }
  return { proposal: null, last };
}

/** 本机脚本化假模型（零计费）。state.scripts 为响应队列；记录每次请求的 user 文本供断言。 */
export function startFakeModel() {
  const state = { hits: 0, scripts: [], last: { events: [] }, seen: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      state.hits += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 空体 */ }
      const user = String(((body.messages || []).find((m) => m.role === 'user') || {}).content || '');
      state.seen.push({ path: String(req.url || ''), chars: user.length, text: user });
      const payload = state.scripts.length ? state.scripts.shift() : state.last;
      state.last = payload;
      const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub', object: 'chat.completion', model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

export async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(5400 + (process.pid % 400)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

/** 起隔离实例（临时数据目录）。返回 { port, dataDir, base, stop }；stop() 会杀掉子进程。 */
export async function startIsolatedServer({ tag = 'temporal-http', env = {} } = {}) {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), `ns-${tag}-`));
  const child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: `ci-${tag}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (child.exitCode !== null) throw new Error('隔离实例提前退出：' + log.slice(-800));
    try {
      const r = await fetch(`${base}/api/works`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) {
        return { port, dataDir, base, stop: () => { try { child.kill(); } catch { /* noop */ } } };
      }
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('隔离实例未在超时内就绪：' + log.slice(-800));
}
