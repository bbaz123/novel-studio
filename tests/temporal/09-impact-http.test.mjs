#!/usr/bin/env node
/**
 * tests/temporal/09-impact-http.test.mjs —— T3 生产接线证据（真实 HTTP + 隔离实例 + 本机假模型，零计费）。
 *
 * 覆盖：
 *   G1  作者确认/更正根事实后，`POST /api/novel/state/correct` 自动触发 analyze 运行（跟随 auto_analysis 开关）；
 *   G2  `GET /api/novel/state/impact` 返回真实运行 + 逐章步骤（conflict / blocked / screening 证据）；
 *   G3  第7章复核输入使用第6章候选提交（新前缀，不是运行启动时的旧计划）；
 *   G4  本阶段不生成正文：totals.generated_revisions=0、step.revision_unchanged=true、章节正文前后一致；
 *   G5  模型侧（X-Novel-Agent）POST impact → 403；作者显式 POST（refresh）→ 新建运行；
 *   G6  未开启 temporal_enabled 的作品：POST impact 返回 enabled:false、零模型调用。
 *
 * 假模型：本机脚本化 Chat Completions；结论只由输入（变化清单 / 正文 / 姓名命中行）决定。
 */
import http from 'node:http';
import { createAssert, createClient, startFakeModel, startIsolatedServer, sleep } from './http-harness.mjs';

const a = createAssert();
const fake = await startFakeModel();
const server = await startIsolatedServer({ tag: 't3-impact-http' });
const client = createClient(server.base);
const AGENT = { 'x-novel-agent': '1' };

/** 复核结论完全由输入决定（不脱离输入直接给通过）。 */
function section(user, head, next) {
  const i = user.indexOf(head);
  if (i < 0) return '';
  const rest = user.slice(i + head.length);
  const j = next ? rest.indexOf(next) : -1;
  return (j >= 0 ? rest.slice(0, j) : rest).trim();
}
function decideImpact(user) {
  const namesLine = (/(?:^|\n)正文姓名命中[^\n]*：([^\n]*)/.exec(user) || [])[1] || '';
  const names = /^（无/.test(namesLine) ? [] : namesLine.split('、').filter(Boolean);
  const changes = section(user, '【世界线变化（已确认的新事实，来自根章节）】', '【章前最新状态');
  const text = section(user, '【本章正文（原文，未改动）】', '请输出 JSON');
  const dead = /战死|死亡/.test(changes);
  for (const name of names) {
    for (const sentence of text.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (!sentence.includes(name)) continue;
      if (/回忆|想起|梦见|当年|据说|转述/.test(sentence)) {
        return JSON.stringify({ decision: 'needs_review', conflicts: [], checked: [{ assumption: '叙述类型可疑', verdict: 'unknown', quote: sentence.slice(0, 40) }], notes: '非当下行动' });
      }
      return JSON.stringify({ decision: 'conflict', conflicts: [{ kind: 'explicit', premise: '该角色已不能参与当下行动', quote: sentence.slice(0, 40), detail: '正文把它写进当下行动' }], checked: [], notes: '显式冲突' });
    }
  }
  if (dead && /接应/.test(text)) {
    return JSON.stringify({ decision: 'conflict', conflicts: [{ kind: 'implicit_causal', premise: '等待接应的行动前提已失效（安排依赖已死亡角色）', quote: '', detail: '正文无姓名，但行动前提依赖新世界线已不成立的事实。' }], checked: [{ assumption: '接应安排依赖其履约', verdict: 'fails', quote: '' }], notes: '隐性因果冲突' });
  }
  return JSON.stringify({ decision: 'valid', conflicts: [], checked: [{ assumption: '行动前提仍成立', verdict: 'holds', quote: '' }], notes: '仍成立' });
}

// 假模型路由：impact → decideImpact；其余（不应出现的抽取）→ 空事件。
const modelHits = [];
fake.server.removeAllListeners('request');
fake.server.on('request', (req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 空体 */ }
    const messages = body.messages || [];
    const system = String((messages.find((m) => m.role === 'system') || {}).content || '');
    const user = String((messages.find((m) => m.role === 'user') || {}).content || '');
    let content;
    if (system.includes('连续性因果复核器')) {
      modelHits.push({ kind: 'impact', user });
      content = decideImpact(user);
    } else {
      modelHits.push({ kind: 'other', system: system.slice(0, 60), user: user.slice(0, 120) });
      content = JSON.stringify({ events: [], assumptions: [] });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', model: 'stub-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
  });
});

try {
  // ── 建库：作品 + 8 章（先建章，后开开关，避免保存触发抽取）──
  const wk = await client.createWork('T3 HTTP 影响分析');
  const workId = Number(wk.json.id);
  const chIds = [];
  for (let i = 1; i <= 8; i += 1) {
    const r = await client.createChapter(workId, `第${i}章`, { content: `<p>第${i}章占位正文。</p>` });
    chIds.push(Number(r.json.id));
  }
  const [c1, c2, c3, c4, c5, c6, c7, c8] = chIds;
  const cfg = await client.api('POST', '/api/api_configs', { name: 'T3 本机假模型（零计费）', base_url: `http://127.0.0.1:${fake.port}/v1`, api_key: 'sk-local-stub-not-billed', model: 'stub-model' });
  a.ok('假模型配置已建立', cfg.status === 201, `status=${cfg.status}`);

  const on = await client.setTemporal(workId, { temporal_enabled: true, auto_analysis_enabled: false, repair_enabled: true });
  a.ok('引擎开启（初始关闭自动分析）', on.status === 200 && !!(on.json.config && on.json.config.enabled === true) && !!on.json.schema_ok);

  // ── 逐章建立可信前缀：保存正文（无分析）+ 作者更正（真实命令入口）──
  let prefixOk = true;
  for (let i = 0; i < 8; i += 1) {
    const cid = chIds[i];
    const text = i === 5 ? '主角守在镇口，等待说好的接应。' : (i === 6 ? '王师傅提刀冲在最前面。' : `第${i + 1}章：主角在青云镇整理行装。`);
    const save = await client.api('PUT', `/api/chapters/${cid}`, { content: `<p>${text}</p>`, title: `第${i + 1}章` });
    if (save.status !== 200) { prefixOk = false; break; }
    const fixes = [{ kind: 'character', entity_id: '主角', predicate: '章节进度', value: i + 1 }];
    if (i === 0) fixes.push({ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '在青云镇' });
    const fix = await client.correct(workId, cid, fixes);
    if (!fix.json || fix.json.ok !== true) { prefixOk = false; console.error('correct failed', i, fix.status, fix.text.slice(0, 200)); break; }
  }
  a.ok('逐章建立可信前缀（保存→作者更正；第1章一并建立王师傅初始状态）', prefixOk);

  const on2 = await client.setTemporal(workId, { temporal_enabled: true, auto_analysis_enabled: true, repair_enabled: true });
  a.ok('开启自动分析（自动触发下游复核）', on2.status === 200 && !!(on2.json.config && on2.json.config.auto_analysis === true));

  // ── 根变更：王师傅 在青云镇 → 战死（作者更正；应自动触发 analyze 运行）──
  const before = await client.api('GET', `/api/chapters?work_id=${workId}`);
  const contentBefore = JSON.stringify((before.json.chapters || before.json || []).map((c) => String(c.content || '')));
  const rootChange = await client.correct(workId, c5, [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '战死' }]);
  a.ok('根变更确认成功（作者更正）', rootChange.status === 200 && rootChange.json.ok === true, rootChange.text.slice(0, 200));

  // ── G1/G2：轮询自动触发的运行（防抖 1.2s + 后台）──
  let runs = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const r = await client.api('GET', `/api/novel/state/impact?work_id=${workId}`);
    runs = (r.json && r.json.runs) || [];
    if (runs.some((x) => x.status === 'ready' && x.mode === 'analyze')) break;
    await sleep(300);
  }
  const autoRun = runs.filter((x) => x.mode === 'analyze').sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
  a.ok('G1 确认根事实后自动产生 analyze 运行（只分析）', !!autoRun && autoRun.status === 'ready', JSON.stringify(runs.map((x) => [x.id, x.status])).slice(0, 200));
  const view = await client.api('GET', `/api/novel/state/impact?work_id=${workId}&run_id=${autoRun.id}`);
  const report = view.json.report || {};
  const steps = view.json.steps || [];
  a.ok('G2 报告覆盖全部下游（保守 all_downstream）', report.coverage && report.coverage.mode === 'all_downstream' && report.totals.downstream === 3, JSON.stringify(report.totals).slice(0, 160));
  const s6 = steps.find((s) => Number(s.chapter_id) === c6) || {};
  const s7 = steps.find((s) => Number(s.chapter_id) === c7) || {};
  a.ok('G2 夹具A（HTTP）：无姓名等待接应 → 隐性因果冲突', s6.status === 'conflict' && (s6.result.implicit_causal || []).length > 0 && (s6.result.explicit_appearances || []).length === 0, JSON.stringify({ st: s6.status }).slice(0, 120));
  a.ok('G3 第7章输入使用第6章候选提交（新前缀）', s7.status === 'blocked' && s7.result.input && s7.result.input.commit_id === s6.result.candidate_commit_id, JSON.stringify({ st: s7.status, input: s7.result && s7.result.input && s7.result.input.commit_id, c6: s6.result && s6.result.candidate_commit_id }).slice(0, 200));
  a.ok('G2 第7章初筛报告显式冲突（跨冲突不静默跳过）', (s7.result.explicit_conflicts || []).length > 0);
  a.ok('G4 不生成正文：generated_revisions=0 且每一步 revision 未变', report.totals.generated_revisions === 0 && steps.every((s) => s.result.revision_unchanged === true));
  const after = await client.api('GET', `/api/chapters?work_id=${workId}`);
  const contentAfter = JSON.stringify((after.json.chapters || after.json || []).map((c) => String(c.content || '')));
  a.ok('G4 章节正文前后一致（未被分析改写）', contentBefore === contentAfter);
  a.ok('G4 模型调用都是复核请求（无生成请求）', modelHits.length > 0 && modelHits.every((x) => x.kind === 'impact'));
  a.ok('G4 复核输入包含变化后的上游事实（战死）与正文原文', modelHits.some((x) => x.user.includes('战死')) && modelHits.some((x) => x.user.includes('等待说好的接应')));

  // ── G5：模型侧 403；作者显式 refresh 新建运行 ──
  const agentTry = await client.api('POST', '/api/novel/state/impact', { work_id: workId, chapter_id: c5 }, AGENT);
  a.ok('G5 模型侧不能触发复核（403）', agentTry.status === 403, `status=${agentTry.status}`);
  const authorRun = await client.api('POST', '/api/novel/state/impact', { work_id: workId, chapter_id: c5, refresh: true });
  a.ok('G5 作者显式复核（refresh）成功且产生新运行', authorRun.status === 200 && authorRun.json.ok === true && authorRun.json.run && authorRun.json.run.id !== autoRun.id, `status=${authorRun.status} id=${authorRun.json && authorRun.json.run && authorRun.json.run.id}`);

  // ── G6：未开启作品零写入零模型 ──
  const wk2 = await client.createWork('T3 HTTP 未开启作品');
  const work2 = Number(wk2.json.id);
  const ch2 = await client.createChapter(work2, '第1章', { content: '<p>未开启作品。</p>' });
  const hitsBefore = modelHits.length;
  const offTry = await client.api('POST', '/api/novel/state/impact', { work_id: work2, chapter_id: Number(ch2.json.id) });
  a.ok('G6 未开启作品：enabled:false 且零模型调用', offTry.status === 200 && offTry.json.enabled === false && modelHits.length === hitsBefore, JSON.stringify(offTry.json).slice(0, 160));
  const listOff = await client.api('GET', `/api/novel/state/impact?work_id=${work2}`);
  a.ok('G6 未开启作品没有任何运行记录', listOff.status === 200 && (listOff.json.runs || []).length === 0);
  await client.deleteWork(work2);
  await client.deleteWork(workId);
} finally {
  const cfgList = await client.api('GET', '/api/api_configs');
  for (const c of (cfgList.json && cfgList.json.configs) || []) if (/本机假模型/.test(String(c.name || ''))) await client.api('DELETE', `/api/api_configs/${c.id}`);
  await server.stop();
  fake.server.close();
}

const failed = a.summary('T3 HTTP 影响分析接线');
process.exitCode = failed ? 1 : 0;
