#!/usr/bin/env node
/**
 * tests/temporal/06-http-save-entries.test.mjs —— T2「所有正文保存入口接入」的生产接线证据。
 *
 * 覆盖（真实 HTTP 端点 → 真实生产调用链；默认自托管隔离实例，也可 --base 指向 ci-isolated-run）：
 *   G0  开关边界：模型侧不能开启（403）；作者可开启
 *   G1  W1 编辑器保存 → 保存后自动分析（本机假模型，零计费）→ 提案组 → 作者一次确认 → 历史状态；
 *       重复保存去重；仅格式变化沿用既有事件、不重复分析（AC-13/22/25/28/29）
 *   G2  新保存取代旧提案：旧提案不可再确认（拒绝、HEAD 不动、状态不被部分破坏）（AC-43/45）
 *   G3  模型侧不能触发 apply / analyze / correct；跨作品章节不能确认（AC-43）
 *   G4  W3 POST /api/novel/chapter_save（AI 写回通道）接入统一后处理
 *   G5  W5 POST /api/chapter_versions/:id/restore 接入统一后处理
 *   G6  W9 POST /api/chapters 带正文（创作工作台成果流程）接入；只改标题不产生新修订
 *   G7  未开启作品：保存照常、零时态写入、零模型调用（AC-42）
 *   G8  N1 finalize / N2 draft / N3 mark_applied / N4 沙盘采纳：阴性对照（不写正文 → 零修订/零提案/HEAD 不动）
 *   G9  旧入口互锁：直接改角色 status 不给 chapter_id → 409；给了 → author_correction（AC-44）
 *   G10 关闭自动分析 / 未配置模型：保存照常、语义结果如实 not_run、历史查询不依赖模型（AC-42）
 *
 * 假模型：本套件在本机随机端口起一个脚本化 Chat Completions 端点，把作品的 api_configs.base_url 指到它。
 * 生产调度（server.js 保存后防抖 → callAI → analyzeChapter）原样走通，但请求不出本机、不产生费用；
 * 响应脚本由本文件给定，引文都取自刚保存的正文（证据锚点匹配）。
 *
 * 用法：
 *   node tests/temporal/06-http-save-entries.test.mjs                      # 自托管隔离实例（CI 用）
 *   node scripts/ci-isolated-run.mjs --port 3756 -- node tests/temporal/06-http-save-entries.test.mjs --base http://127.0.0.1:3756
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
let BASE = arg('--base', '');
let child = null;

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
const agent = { 'x-novel-agent': '1' };
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const kv = (domain, entityId, predicate, scope = 'canon', holderId = null) => JSON.stringify([domain, entityId, predicate, scope, holderId]);
const op = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });

const proposalGroups = (workId, chapterId) => api('GET', `/api/novel/state/proposal-groups?work_id=${workId}${chapterId ? `&chapter_id=${chapterId}` : ''}`);
const applyBinding = (workId, chapterId, bindingId, headers = {}) => api('POST', `/api/novel/state/proposal-groups/${encodeURIComponent(String(bindingId))}/apply`, { work_id: workId, chapter_id: chapterId }, headers);
const stateAt = (workId, chapterId, extra = '') => api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${chapterId}&boundary=after${extra}`);
const overview = (workId) => api('GET', `/api/novel/state/temporal?work_id=${workId}`);

/** 轮询：等某章的某个提案达到条件（分析是后台任务，产生时机不确定）。 */
async function waitProposal(workId, chapterId, accept, { timeout = 25000 } = {}) {
  const t0 = Date.now();
  let last = '(none)';
  while (Date.now() - t0 < timeout) {
    const r = await proposalGroups(workId, chapterId);
    const ps = (r.json && r.json.proposals) || [];
    last = ps.map((p) => `${p.status}${p.analysis && p.analysis.provider ? '/' + p.analysis.provider : ''}`).join(',') || '(none)';
    const hit = ps.find(accept);
    if (hit) return { proposal: hit, last };
    await sleep(250);
  }
  return { proposal: null, last };
}

/** 本机脚本化假模型（零计费）。记录每次请求的 user 正文用于断言"分析的是新修订"。 */
function startFakeModel() {
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

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(5400 + (process.pid % 400)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

async function startIsolatedServer() {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ns-temporal-http-'));
  child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    cwd: REPO,
    // 该测试专门覆盖旧 HTTP 模型头的兼容阴性路径；生产默认仍拒绝固定头，
    // 这里只在隔离实例显式打开兼容开关，避免测试依赖环境外泄。
    env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'ci-temporal-06' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  BASE = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (child.exitCode !== null) throw new Error('隔离实例提前退出：' + log.slice(-800));
    try {
      const r = await fetch(`${BASE}/api/works`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return { port, dataDir };
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('隔离实例未在超时内就绪：' + log.slice(-800));
}

async function main() {
  if (!BASE) {
    const info = await startIsolatedServer();
    console.log(`✓ 自托管隔离实例已就绪：${BASE}（数据目录 ${info.dataDir}）`);
  }
  console.log(`T2 保存入口 HTTP 接线 @ ${BASE}\n`);

  const fake = await startFakeModel();
  const works = [];
  try {
    // ── 建作品 A + 章节；作品 B 用于"未开启 / 跨作品"两条阴性对照 ────────────────
    const w = await api('POST', '/api/works', { title: 'T2 接线验收《青云纪》', description: '自动化测试作品（自清理）' });
    if (w.status >= 300) { console.error('建作品失败', w.status, w.text.slice(0, 200)); process.exit(2); }
    const workA = w.json.id; works.push(workA);
    const chapters = [];
    for (let i = 1; i <= 5; i += 1) {
      const c = await api('POST', '/api/chapters', { work_id: workA, title: `第${i}章` });
      if (c.status >= 300) { console.error('建章节失败', c.status, c.text.slice(0, 200)); process.exit(2); }
      chapters.push(c.json.id);
    }
    const [c1, c2, c3, c4, c5] = chapters;
    const wB = await api('POST', '/api/works', { title: 'T2 未开启引擎的对照作品' });
    const workB = wB.json.id; works.push(workB);
    const cb = await api('POST', '/api/chapters', { work_id: workB, title: '第1章' });
    const b1 = cb.json.id;
    // 新作品默认开启；这里显式关闭，构造旧作品兼容语义的阴性对照。
    await api('PUT', '/api/novel/state/temporal', { work_id: workB, temporal_enabled: false });

    // ── G0 开关与模型侧边界 ────────────────────────────────────────────────────
    console.log('【G0 开关与模型侧边界】');
    {
      const denied = await api('PUT', '/api/novel/state/temporal', { work_id: workA, temporal_enabled: true }, agent);
      ok('G0a 模型侧不能开启时态引擎（403）', denied.status === 403, `status=${denied.status}`);
      const on = await api('PUT', '/api/novel/state/temporal', { work_id: workA, temporal_enabled: true, auto_analysis_enabled: true });
      ok('G0b 作者开启 temporal + 自动分析（schema 自检通过）', on.status === 200 && on.json.config?.enabled === true && on.json.config?.auto_analysis === true && on.json.schema_ok === true, `status=${on.status} ${on.text.slice(0, 160)}`);
      const cfg = await api('POST', '/api/api_configs', { name: 'T2 本机假模型（零计费）', base_url: `http://127.0.0.1:${fake.port}/v1`, api_key: 'sk-local-stub-not-billed', model: 'deepseek-chat' });
      ok('G0c 假模型配置已建立（base_url 指向本机随机端口）', cfg.status === 201, `status=${cfg.status} ${cfg.text.slice(0, 140)}`);
    }

    // ── G1 W1：编辑器保存 → 自动分析 → 提案组 → 一次确认 ────────────────────────
    console.log('【G1 W1 编辑器保存：提案 → 确认 → 历史状态】');
    const text1 = '第一章 王师傅在青云镇登场';
    let hitsAfter1 = 0;
    let rev1 = '';
    {
      fake.state.scripts.push({
        events: [{
          ops: [op(cell('character', '王师傅', 'alive'), true), op(cell('character', '王师傅', 'status'), '存活'), op(cell('character', '王师傅', 'location'), '青云镇')],
          evidence: [{ quote: '王师傅在青云镇登场', narrative: 'present' }],
        }],
      });
      const save1 = await api('PUT', `/api/chapters/${c1}`, { content: `<p>${text1}</p>` });
      ok('G1a PUT 正文保存成功（W1 编辑器保存入口）', save1.status === 200 && save1.json.content === `<p>${text1}</p>`, `status=${save1.status}`);
      const g1 = await proposalGroups(workA, c1);
      const p1 = (g1.json.proposals || [])[0] || null;
      ok('G1b 保存后出现 1 个待确认提案（不可变修订 + pending 绑定）', g1.status === 200 && g1.json.enabled === true && !!p1 && !!p1.revision_id, `status=${g1.status} n=${(g1.json.proposals || []).length}`);
      rev1 = (p1 && p1.revision_id) || '';
      const at1 = await stateAt(workA, c1);
      ok('G1c 未确认前历史查询停住（pending，不拿提案冒充事实）', at1.json.validity === 'pending' || (at1.json.stop && at1.json.stop.reason === 'pending'), `validity=${at1.json.validity}`);
      ok('G1d 未确认前正式状态里没有提案中的值（AC-13）', !(at1.json.state_json && at1.json.state_json[kv('character', '王师傅', 'alive')] === true));
      const w1 = await waitProposal(workA, c1, (p) => p.status === 'done');
      ok('G1e 保存后自动分析完成并挂上候选事件（生产调度 + 本机假模型）', !!w1.proposal && (w1.proposal.event_ids || []).length === 1, `last=${w1.last}`);
      ok('G1f 提案组按域汇总（character 域 ≥ 3 个操作）', !!w1.proposal && (w1.proposal.proposal?.by_domain?.character || 0) >= 3, w1.proposal ? JSON.stringify(w1.proposal.proposal || {}) : '');
      ok('G1g 分析读到的是刚保存的正文修订（不是旧缓存）', fake.state.seen.some((s) => s.text.includes(text1) && s.text.includes('王师傅在青云镇登场')), `hits=${fake.state.hits}`);
      hitsAfter1 = fake.state.hits;
      const apply1 = await applyBinding(workA, c1, p1.binding_id);
      ok('G1h 作者一次确认：整组原子应用（valid + 新提交）', apply1.status === 200 && apply1.json.ok === true && apply1.json.decision === 'valid' && !!apply1.json.commit_id, `status=${apply1.status} ${apply1.text.slice(0, 180)}`);
      const at1b = await stateAt(workA, c1);
      ok('G1i 确认后历史查询反映新事实', at1b.json.validity === 'valid' && at1b.json.state_json?.[kv('character', '王师傅', 'alive')] === true && at1b.json.state_json?.[kv('character', '王师傅', 'status')] === '存活', `validity=${at1b.json.validity}`);
      const apply1b = await applyBinding(workA, c1, p1.binding_id);
      ok('G1j 重复确认幂等（返回已应用回执，不重复提交）', apply1b.status === 200 && apply1b.json.ok === true && apply1b.json.reused === true, `status=${apply1b.status} ${apply1b.text.slice(0, 140)}`);
      const afterApply = await proposalGroups(workA, c1);
      ok('G1k 确认后该章不再有 pending 提案', (afterApply.json.proposals || []).length === 0);
      const head1 = await overview(workA);
      ok('G1l 提交清单覆盖 1 章（HEAD 前进）', head1.json.manifest_size === 1 && !!head1.json.head_commit_id, `size=${head1.json.manifest_size}`);
      const headId1 = head1.json.head_commit_id;
      const dup = await api('PUT', `/api/chapters/${c1}`, { content: `<p>${text1}</p>` });
      await sleep(1200);
      const afterDup = await proposalGroups(workA, c1);
      const headDup = await overview(workA);
      ok('G1m 重复保存同一内容：不产生新修订/新提案、不调用模型（AC-29 去重）', dup.status === 200 && (afterDup.json.proposals || []).length === 0 && headDup.json.head_commit_id === headId1 && fake.state.hits === hitsAfter1, `proposals=${(afterDup.json.proposals || []).length} hits=${fake.state.hits}/${hitsAfter1}`);
      const fmt = await api('PUT', `/api/chapters/${c1}`, { content: `<p><em>${text1}</em></p>` });
      const w1f = await waitProposal(workA, c1, (p) => p.status === 'done');
      ok('G1n 仅格式变化沿用既有事件与结论（carried_from，不重新分析）', fmt.status === 200 && !!w1f.proposal && (w1f.proposal.event_ids || []).length >= 1 && !!w1f.proposal.analysis?.carried_from, w1f.proposal ? JSON.stringify({ status: w1f.proposal.status, carried: w1f.proposal.analysis?.carried_from || '' }) : `last=${w1f.last}`);
      ok('G1o 仅格式变化没有新增模型调用（AC-29）', fake.state.hits === hitsAfter1, `hits=${fake.state.hits}/${hitsAfter1}`);
      const apply1f = await applyBinding(workA, c1, w1f.proposal.binding_id);
      ok('G1p 沿用事件的提案仍可确认（证据锚点匹配同一文本）', apply1f.json.ok === true && apply1f.json.decision === 'valid', apply1f.text.slice(0, 160));
    }

    // ── G2 二次保存取代旧提案；旧提案拒绝；新提案确认 ───────────────────────────
    console.log('【G2 新保存取代旧提案（AC-43/45）】');
    {
      fake.state.scripts.push({ events: [{ ops: [op(cell('plotline', '黑风谷任务', 'state'), '进行中')], evidence: [{ quote: '黑风谷任务开始', narrative: 'present' }] }] });
      await api('PUT', `/api/chapters/${c2}`, { content: '<p>第二章 黑风谷任务开始</p>' });
      const w2 = await waitProposal(workA, c2, (p) => p.status === 'done');
      ok('G2a 第 2 章保存 → 分析完成（剧情线提案，尚未确认）', !!w2.proposal && (w2.proposal.proposal?.by_domain?.plotline || 0) >= 1, `last=${w2.last}`);
      const head2 = (await overview(workA)).json.head_commit_id;
      fake.state.scripts.push({ events: [{ ops: [op(cell('plotline', '黑风谷任务', 'state'), '僵持')], evidence: [{ quote: '陷入僵局', narrative: 'present' }] }] });
      await api('PUT', `/api/chapters/${c2}`, { content: '<p>第二章 黑风谷任务陷入僵局</p>' });
      const w2b = await waitProposal(workA, c2, (p) => p.status === 'done' && p.revision_id !== w2.proposal.revision_id);
      ok('G2b 新保存建立新修订 + 新提案（分析的是新正文，不是旧缓存）', !!w2b.proposal && w2b.proposal.revision_id !== w2.proposal.revision_id, `last=${w2b.last}`);
      const staleApply = await applyBinding(workA, c2, w2.proposal.binding_id);
      ok('G2c 被取代的旧提案不能再确认（拒绝，不写正式状态）', staleApply.status === 200 && staleApply.json.ok === false && staleApply.json.decision === 'rejected', `status=${staleApply.status} ${staleApply.text.slice(0, 160)}`);
      const head2b = (await overview(workA)).json.head_commit_id;
      ok('G2d 被拒确认不推进 HEAD（无部分应用，AC-45）', head2b === head2, `${head2} -> ${head2b}`);
      const at2 = await stateAt(workA, c2);
      ok('G2e 第 2 章仍停在 pending（旧提案的值没有以任何形式进入正式状态）', at2.json.validity === 'pending' || (at2.json.stop && at2.json.stop.reason === 'pending'), `validity=${at2.json.validity}`);
      const apply2b = await applyBinding(workA, c2, w2b.proposal.binding_id);
      ok('G2f 新提案确认后状态推进到新事实', apply2b.json.ok === true && apply2b.json.decision === 'valid' && (await stateAt(workA, c2)).json.state_json?.[kv('plotline', '黑风谷任务', 'state')] === '僵持', apply2b.text.slice(0, 160));
      ok('G2g HEAD 前进为新提交（旧值只留在旧历史里）', !!apply2b.json.commit_id && apply2b.json.commit_id !== head2, `${head2} -> ${apply2b.json.commit_id}`);
    }

    // ── G3 模型侧与跨作品边界 ──────────────────────────────────────────────────
    console.log('【G3 模型侧 / 跨作品边界（AC-43）】');
    {
      const lastProposal = (await proposalGroups(workA, c2)).json.proposals || [];
      const anyBinding = lastProposal[0] ? lastProposal[0].binding_id : (await proposalGroups(workA, c1)).json.proposals?.[0]?.binding_id;
      const d1 = await applyBinding(workA, c2, anyBinding || 'bnd_none', agent);
      ok('G3a 模型侧不能确认提案（403）', d1.status === 403, `status=${d1.status}`);
      const d2 = await api('POST', '/api/novel/state/analyze', { work_id: workA, chapter_id: c1 }, agent);
      ok('G3b 模型侧不能触发分析（403）', d2.status === 403, `status=${d2.status}`);
      const d3 = await api('POST', '/api/novel/state/correct', { work_id: workA, chapter_id: c1, corrections: [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '不该生效' }] }, agent);
      ok('G3c 模型侧不能手工更正（403）', d3.status === 403, `status=${d3.status}`);
      const d4 = await applyBinding(workA, b1, anyBinding || 'bnd_none');
      ok('G3d 跨作品章节不能确认本作品提案（404，不消费任何东西）', d4.status === 404, `status=${d4.status}`);
      const d5 = await api('POST', `/api/novel/state/proposal-groups/${encodeURIComponent(String(anyBinding || 'bnd_none'))}/partial`, { work_id: workA, chapter_id: c2 });
      ok('G3e 任意操作路径不被接受（不存在 partial 之类入口）', d5.status >= 400, `status=${d5.status}`);
    }

    // ── G4 W3：AI 写回通道 chapter_save ────────────────────────────────────────
    console.log('【G4 W3 chapter_save（AI 写回通道）】');
    let revAfterG4 = '';
    {
      fake.state.scripts.push({ events: [{ ops: [op(cell('character', '王师傅', 'status'), '受伤', { kind: 'value', value: '存活' })], evidence: [{ quote: '王师傅受伤休养', narrative: 'present' }] }] });
      const hitsB4 = fake.state.hits;
      const cs = await api('POST', '/api/novel/chapter_save', { work_id: workA, chapter_id: c3, content: '<p>第三章 王师傅受伤休养</p>' });
      ok('G4a chapter_save 写入成功且保留历史版本（旧语义不变）', cs.status === 200 && cs.json.ok === true && cs.json.version_id > 0, `status=${cs.status} ${cs.text.slice(0, 160)}`);
      const w4 = await waitProposal(workA, c3, (p) => p.status === 'done');
      ok('G4b chapter_save 同样建立 pending 提案（统一后处理）', !!w4.proposal && !!w4.proposal.revision_id, `last=${w4.last}`);
      revAfterG4 = w4.proposal ? w4.proposal.revision_id : '';
      ok('G4c 该分析只调用了一次本机假模型', fake.state.hits === hitsB4 + 1, `hits=${fake.state.hits}/${hitsB4 + 1}`);
      const apply4 = await applyBinding(workA, c3, w4.proposal.binding_id);
      ok('G4d 确认后状态推进（来自正文事实，不是 UI 点击）', apply4.json.ok === true && (await stateAt(workA, c3)).json.state_json?.[kv('character', '王师傅', 'status')] === '受伤', apply4.text.slice(0, 160));
    }

    // ── G5 W5：历史版本恢复 ────────────────────────────────────────────────────
    console.log('【G5 W5 历史版本恢复】');
    {
      const mk = await api('POST', '/api/chapter_versions', { chapter_id: c3, title: '第三章', summary: '', content: '<p>第三章 王师傅养伤的旧稿</p>' });
      ok('G5a 建立历史版本', mk.status === 201 && mk.json.id > 0, `status=${mk.status}`);
      fake.state.scripts.push({ events: [{ ops: [op(cell('character', '王师傅', 'status'), '静养', { kind: 'value', value: '受伤' })], evidence: [{ quote: '养伤的旧稿', narrative: 'present' }] }] });
      const rs = await api('POST', `/api/chapter_versions/${mk.json.id}/restore`, { backup_current: true });
      ok('G5b 恢复历史版本成功（W5）', rs.status === 200 && rs.json.ok === true, `status=${rs.status} ${rs.text.slice(0, 140)}`);
      const ch3 = await api('GET', `/api/chapters/${c3}`);
      ok('G5c 正文已恢复为旧稿', ch3.json.content === '<p>第三章 王师傅养伤的旧稿</p>', String(ch3.json.content || '').slice(0, 60));
      const w5 = await waitProposal(workA, c3, (p) => p.status === 'done');
      ok('G5d 恢复也建立新的 pending 提案（新修订，不是旧修订）', !!w5.proposal && !!w5.proposal.revision_id && w5.proposal.revision_id !== revAfterG4, `last=${w5.last}`);
    }

    // ── G6 W9：带正文新建章节；仅改标题不产生修订 ──────────────────────────────
    console.log('【G6 W9 新建章节带正文 / W1 只改标题】');
    {
      fake.state.scripts.push({ events: [{ ops: [op(cell('location', '断魂谷', 'known'), true)], evidence: [{ quote: '工作台生成成果', narrative: 'present' }] }] });
      const mkCh = await api('POST', '/api/chapters', { work_id: workA, title: '第六章 工作台成果', content: '<p>第六章 工作台生成成果</p>' });
      ok('G6a POST /api/chapters 带正文成功（创作工作台成果流程）', mkCh.status === 201 && mkCh.json.content === '<p>第六章 工作台生成成果</p>', `status=${mkCh.status}`);
      const c6 = mkCh.json.id;
      const g6 = await proposalGroups(workA, c6);
      ok('G6b 带正文新建章节同样建立 pending 提案（W9 接入）', g6.status === 200 && (g6.json.proposals || []).length === 1 && !!g6.json.proposals[0].revision_id, `n=${(g6.json.proposals || []).length}`);
      await waitProposal(workA, c6, (p) => p.status === 'done');
      const mkEmpty = await api('POST', '/api/chapters', { work_id: workA, title: '第七章 空章' });
      const g6c = await proposalGroups(workA, mkEmpty.json.id);
      ok('G6c 无正文新建章节不产生修订/提案', mkEmpty.status === 201 && (g6c.json.proposals || []).length === 0);
      fake.state.scripts.push({ events: [{ ops: [op(cell('location', '青云镇', 'visited'), true)], evidence: [{ quote: '平静的一天', narrative: 'present' }] }] });
      await api('PUT', `/api/chapters/${c4}`, { content: '<p>第四章 平静的一天</p>' });
      const w6 = await waitProposal(workA, c4, (p) => p.status === 'done');
      ok('G6d 第 4 章保存并分析完成', !!w6.proposal, `last=${w6.last}`);
      const hitsBeforeTitle = fake.state.hits;
      const titleOnly = await api('PUT', `/api/chapters/${c4}`, { title: '第四章 平静的一天（改名）' });
      await sleep(1300);
      const g6e = await proposalGroups(workA, c4);
      ok('G6e 只改标题不产生新修订/提案、不触发分析（正文事实未变）', titleOnly.status === 200 && (g6e.json.proposals || []).length === 1 && g6e.json.proposals[0].revision_id === w6.proposal.revision_id && fake.state.hits === hitsBeforeTitle, `n=${(g6e.json.proposals || []).length} hits=${fake.state.hits}/${hitsBeforeTitle}`);
    }

    // ── G7 未开启作品：旧语义不变、零写入 ──────────────────────────────────────
    console.log('【G7 未开启作品（AC-42）】');
    {
      const hitsB = fake.state.hits;
      const saveB = await api('PUT', `/api/chapters/${b1}`, { content: '<p>未开启作品的正文</p>' });
      ok('G7a 未开启作品保存正文照常成功（旧语义不变）', saveB.status === 200 && saveB.json.content === '<p>未开启作品的正文</p>', `status=${saveB.status}`);
      await sleep(1100);
      const g7 = await proposalGroups(workB, b1);
      ok('G7b 未开启作品零时态写入（enabled:false + 空提案列表）', g7.status === 200 && g7.json.enabled === false && (g7.json.proposals || []).length === 0, `status=${g7.status} enabled=${g7.json.enabled}`);
      const t7 = await overview(workB);
      ok('G7c 未开启作品没有 HEAD / 没有提交', t7.status === 200 && t7.json.config?.enabled === false && t7.json.head_commit_id === null, `enabled=${t7.json.config?.enabled} head=${t7.json.head_commit_id}`);
      ok('G7d 未开启作品不调用分析模型', fake.state.hits === hitsB, `hits=${fake.state.hits}/${hitsB}`);
    }

    // ── G8 N1–N4 阴性对照：不写正文的入口不得产生时态数据 ──────────────────────
    console.log('【G8 N1–N4 阴性对照】');
    {
      const headG8 = (await overview(workA)).json.head_commit_id;
      const hitsG8 = fake.state.hits;
      const n2 = await api('POST', '/api/novel/draft', { chapter_id: c5, content: '<p>AI 草稿（不应进入时态修订）</p>' });
      const n1 = await api('POST', '/api/novel/finalize', { kind: 'draft', chapter_id: c5, output: '<p>成文产出（不应进入时态修订）</p>' });
      const n3 = await api('POST', '/api/harness/mark_applied', { job_id: 't2-no-such-job' });
      const cand = await api('POST', '/api/novel/branch/candidates', {
        work_id: workA, chapter_id: c5,
        candidates: [
          {
            title: '甲方案', core_action: '主角独自前往黑风谷探查', conflict: '与留在镇上保护同伴的立场冲突',
            character_choices: [{ name: '主角', new_character: true, choice: '独自出发探查黑风谷' }],
            consequences: [{ text: '黑风谷的线索提前暴露', certainty: 'possible' }],
          },
          {
            title: '乙方案', core_action: '主角留在青云镇等待线索', conflict: '与主动出击尽快破局的立场冲突',
            character_choices: [{ name: '主角', new_character: true, choice: '留在镇上等消息' }],
            consequences: [{ text: '错过黑风谷的关键时机', certainty: 'possible' }],
          },
        ],
      });
      const candId = (cand.json.candidates || [])[0] ? cand.json.candidates[0].id : 0;
      const adopt = candId ? await api('POST', `/api/novel/branch/candidates/${candId}/adopt`, { blueprint: true }) : { status: 0, json: {}, text: '候选未建立' };
      await sleep(900);
      const ch5 = await api('GET', `/api/chapters/${c5}`);
      const g8 = await proposalGroups(workA, c5);
      const headG8b = (await overview(workA)).json.head_commit_id;
      ok('G8a N2 draft：只落草稿版本，不产生时态修订/提案', n2.status === 201 && n2.json.draft_id > 0 && (g8.json.proposals || []).length === 0, `status=${n2.status} n=${(g8.json.proposals || []).length}`);
      ok('G8b N1 finalize：只落草稿，不产生时态修订/提案', n1.status === 201 && n1.json.draft_id > 0);
      ok('G8c N3 mark_applied：只标记作业，不写正文/时态', n3.status === 200 && n3.json.ok === true);
      ok('G8d N4 沙盘候选建立成功（作者提交，零模型调用）', cand.status === 201 && (cand.json.candidates || []).length === 2, `status=${cand.status} ${cand.text.slice(0, 120)}`);
      ok('G8e N4 采纳只写章节蓝图（作者决定）', adopt.status === 200 && adopt.json.ok === true && adopt.json.blueprint_written === true, `status=${adopt.status} ${adopt.text.slice(0, 140)}`);
      ok('G8f 采纳没有碰正文（content 仍为空）', String(ch5.json.content || '') === '', String(ch5.json.content || '').slice(0, 60));
      ok('G8g N1–N4 阴性：零修订/零提案/HEAD 不动/零模型调用', (g8.json.proposals || []).length === 0 && headG8b === headG8 && fake.state.hits === hitsG8, `head=${headG8 === headG8b} hits=${fake.state.hits}/${hitsG8}`);
    }

    // ── G9 AC-44：旧入口互锁（手工改状态必须指明生效位置并命令化）─────────────────
    console.log('【G9 旧入口互锁（AC-44）】');
    {
      const ch = await api('POST', '/api/characters', { work_id: workA, name: '王师傅', status: '' });
      ok('G9a 建立角色卡（旧入口）', ch.status === 201, `status=${ch.status} ${ch.text.slice(0, 120)}`);
      const cid = ch.json.id;
      const blocked = await api('PUT', `/api/characters/${cid}`, { status: '受伤' });
      ok('G9b 开启引擎的作品：直接改角色 status 且不给 chapter_id → 409（不留第二写入源）', blocked.status === 409, `status=${blocked.status} ${blocked.text.slice(0, 120)}`);
      const afterBlocked = await api('GET', `/api/characters/${cid}`);
      ok('G9c 被拒的旧字段写入没有生效', String(afterBlocked.json.status || '') === '', `status=${JSON.stringify(afterBlocked.json.status)}`);
      const applied = await api('PUT', `/api/characters/${cid}`, { status: '受伤', chapter_id: c1 });
      ok('G9d 带 chapter_id 的同一改动统一转成 author_correction 并生效', applied.status === 200 && String(applied.json.status || '') === '受伤', `status=${applied.status} ${applied.text.slice(0, 140)}`);
      const at1 = await stateAt(workA, c1);
      ok('G9e 时态历史在同一命令入口里反映更正（不是旁路写入）', at1.json.validity === 'valid' && at1.json.state_json?.[kv('character', '王师傅', 'status')] === '受伤', `validity=${at1.json.validity} ${JSON.stringify(at1.json.state_json?.[kv('character', '王师傅', 'status')])}`);
    }

    // ── G10 AC-42：关闭自动分析 / 未配置模型时的保存与「未运行」如实呈现 ─────────
    console.log('【G10 模型未运行时的语义（AC-42）】');
    {
      const wC = await api('POST', '/api/works', { title: 'T2 模型未运行对照作品' });
      const workC = wC.json.id; works.push(workC);
      const cC = await api('POST', '/api/chapters', { work_id: workC, title: '第1章' });
      const cc1 = cC.json.id;
      await api('PUT', '/api/novel/state/temporal', { work_id: workC, temporal_enabled: true, auto_analysis_enabled: false });
      const hits0 = fake.state.hits;
      const saveC1 = await api('PUT', `/api/chapters/${cc1}`, { content: '<p>第一章 断魂谷的雾</p>' });
      const wC1 = await waitProposal(workC, cc1, (p) => p.status === 'not_run' || p.status === 'done');
      ok('G10a 关闭自动分析：保存照常成功，语义分析如实记 not_run（不调用模型）', saveC1.status === 200 && !!wC1.proposal && wC1.proposal.status === 'not_run' && fake.state.hits === hits0, `last=${wC1.last} hits=${fake.state.hits}/${hits0}`);
      const atC = await stateAt(workC, cc1);
      ok('G10b 未分析/未确认前历史查询停在 pending（不冒充已确认状态）', atC.json.validity === 'pending' || (atC.json.stop && atC.json.stop.reason === 'pending'), `validity=${atC.json.validity}`);
      await api('PUT', '/api/novel/state/temporal', { work_id: workC, auto_analysis_enabled: true });
      fake.state.scripts.push({ events: [{ ops: [op(cell('location', '断魂谷', 'known'), true)], evidence: [{ quote: '断魂谷的雾散了', narrative: 'present' }] }] });
      await api('PUT', `/api/chapters/${cc1}`, { content: '<p>第一章 断魂谷的雾散了</p>' });
      const wC2 = await waitProposal(workC, cc1, (p) => p.status === 'done');
      ok('G10c 开启自动分析后：保存即自动分析（生产调度走通）', !!wC2.proposal, `last=${wC2.last}`);
      const applyC = await applyBinding(workC, cc1, wC2.proposal.binding_id);
      ok('G10d 确认后历史可查（确定性检查不依赖模型）', applyC.json.ok === true && (await stateAt(workC, cc1)).json.state_json?.[kv('location', '断魂谷', 'known')] === true, applyC.text.slice(0, 140));
      const cfgList = await api('GET', '/api/api_configs');
      const cfgId = (cfgList.json || [])[0] ? cfgList.json[0].id : 0;
      if (cfgId) await api('DELETE', `/api/api_configs/${cfgId}`);
      const hitsNo = fake.state.hits;
      const saveC2 = await api('PUT', `/api/chapters/${cc1}`, { content: '<p>第一章 断魂谷的雾又起</p>' });
      const wC3 = await waitProposal(workC, cc1, (p) => p.status === 'not_run');
      ok('G10e 未配置模型：保存可用、语义结果显示未运行、零模型调用', saveC2.status === 200 && !!wC3.proposal && wC3.proposal.status === 'not_run' && cfgId > 0 && fake.state.hits === hitsNo, `last=${wC3.last} cfg=${cfgId}`);
      const hist = await stateAt(workC, cc1, `&commit_id=${encodeURIComponent(applyC.json.commit_id)}`);
      ok('G10f 已确认历史查询不依赖模型（显式提交可回放）', hist.json.validity === 'valid' && hist.json.state_json?.[kv('location', '断魂谷', 'known')] === true, `validity=${hist.json.validity}`);
    }

  } finally {
    for (const id of works) { try { await api('DELETE', `/api/works/${id}`); } catch { /* 自清理 */ } }
    try { fake.server.close(); } catch { /* 已关闭 */ }
    if (child) { try { child.kill(); } catch { /* 已退出 */ } }
  }
  console.log('\n' + '─'.repeat(46));
  console.log(`T2 保存入口 HTTP 接线：通过 ${pass} / 失败 ${fails.length}`);
  if (fails.length) { for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? '  — ' + f.detail : ''}`); process.exit(1); }
}

main().catch((e) => { console.error('测试异常：', e); if (child) { try { child.kill(); } catch { /* noop */ } } process.exit(1); });
