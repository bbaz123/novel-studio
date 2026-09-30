#!/usr/bin/env node
/**
 * tests/temporal/11-repair-http.test.mjs —— T4「按钮驱动逐章重建」生产接线证据
 * （真实 HTTP + 隔离实例 + 本机假模型，零计费）。
 *
 * 覆盖：
 *   H1 作者签发 repair_run_start 审批 → POST /api/novel/state/repair/start 启动逐章重建；
 *   H2 候选阶段绝不改写正式正文；GET /api/novel/state/repair 返回真实运行 + 服务端重算的 ready_gate；
 *   H3 未就绪时签发 repair_run_apply → 409；无审批 apply → 403；模型侧（X-Novel-Agent）一律 403；
 *   H4 就绪后 apply：正式正文原子切换 + 旧稿保留在 chapter_save_versions；revert 恢复；
 *   H5 同一按钮重复点击（重新签发审批）→ 复用同一运行，且新审批不被消费（幂等）；
 *   H6 审批只对签发时的基线有效：期间基线前进 → 启动被拒（不静默放行）；
 *   H7 取消 → cancelled（断点保留）；已取消运行签发 apply 审批 → 409、不可 apply。
 *   H8（T6）候选修订只读预览：GET /api/novel/state/revision 返回真实候选正文；跨作品 / 不存在 404；
 *      预览是纯读（读候选不改任何正式正文），供前端逐段 diff 使用。
 *
 * 纪律：NOVELSTUDIO_DATA_DIR 指向 mkdtemp 临时目录；只连本机假模型；不调用真实计费端点；
 *       全部作品自建自清理（DELETE /api/works/:id）。
 */
import { createAssert, createClient, startFakeModel, startIsolatedServer, sleep } from './http-harness.mjs';

const a = createAssert();
const fake = await startFakeModel();
const server = await startIsolatedServer({ tag: 't4-repair-http' });
const client = createClient(server.base);
const AGENT = { 'x-novel-agent': '1' };

const C1 = '<p>第1章 正文。王师傅在青云镇教主角练刀，两人约定同去黑风谷。</p>';
const C2_BEFORE = '<p>第2章 正文。王师傅与主角同行于山道，风从谷口吹来。</p>';
const C2_AFTER = '<p>第2章 正文。王师傅战死，主角立誓查清死因，独自踏上归途。</p>';
const C3_ORIGINAL = '<p>第3章 正文。主角与王师傅同行于山道，等待说好的接应。</p>';
const C4 = '<p>第4章 正文。主角在青云镇整理行装，准备启程。</p>';
const C3_REVISED_PLAIN = '第3章 正文。主角独自埋葬了王师傅，立誓查清死因，随后踏上归途。';
const CONTENT = { 1: C1, 2: C2_BEFORE, 3: C3_ORIGINAL, 4: C4 };
const MODEL_DELAY_MS = 120;

/** 本机脚本化假模型：按系统提示路由；结论只由输入决定（不脱离输入给通过）。 */
const hits = [];
fake.server.removeAllListeners('request');
fake.server.on('request', (req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 空体 */ }
    const messages = body.messages || [];
    const system = String((messages.find((m) => m.role === 'system') || {}).content || '');
    const user = String((messages.find((m) => m.role === 'user') || {}).content || '');
    let content;
    if (system.includes('连续性因果复核器')) {
      const conflict = user.includes('等待说好的接应') && !user.includes('独自埋葬');
      hits.push({ kind: 'verify', conflict });
      content = conflict
        ? JSON.stringify({ decision: 'conflict', conflicts: [{ kind: 'implicit_causal', premise: '王师傅仍然活着并会履约接应', quote: '等待说好的接应', detail: '本章行动前提依赖已死亡角色' }], checked: [], notes: '隐性因果冲突' })
        : JSON.stringify({ decision: 'valid', conflicts: [], checked: [{ assumption: '行动前提仍成立', verdict: 'holds', quote: '' }], notes: '仍成立' });
    } else if (system.includes('连续性修订器')) {
      hits.push({ kind: 'generate' });
      content = JSON.stringify({ revised_text: C3_REVISED_PLAIN });
    } else if (system.includes('状态记账员')) {
      const repairExtract = user.includes('独自埋葬');
      hits.push({ kind: 'extract', repairExtract });
      content = repairExtract
        ? JSON.stringify({
          events: [{ ops: [{ type: 'set', cell: { domain: 'plotline', entityId: '线3', predicate: 'status', scope: 'canon' }, expected: { kind: 'missing' }, value: '已转向复仇' }], evidence: [{ quote: '主角独自埋葬了王师傅', narrative: 'present' }] }],
          assumptions: [{ kind: 'goal', statement: '主角决意查清死因', quote: '立誓查清死因' }],
        })
        : JSON.stringify({ events: [], assumptions: [] });
    } else {
      hits.push({ kind: 'other', system: system.slice(0, 60) });
      content = JSON.stringify({ events: [], assumptions: [] });
    }
    await sleep(MODEL_DELAY_MS);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', model: 'stub-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
  });
});
async function seedPrefix(workId, chapterIds) {
  for (let i = 0; i < chapterIds.length; i += 1) {
    const n = i + 1;
    const save = await client.api('PUT', `/api/chapters/${chapterIds[i]}`, { content: CONTENT[n], title: `第${n}章` });
    if (save.status !== 200) return `保存第${n}章失败：status=${save.status} ${save.text.slice(0, 160)}`;
    const fixes = [{ kind: 'plotline', entity_id: `线${n}`, predicate: 'status', value: '进行中' }];
    if (n === 1) {
      fixes.push({ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '在青云镇' });
      fixes.push({ kind: 'character', entity_id: '主角', predicate: 'status', value: '存活' });
    }
    const fix = await client.correct(workId, chapterIds[i], fixes);
    if (!fix.json || fix.json.ok !== true) return `更正第${n}章失败：status=${fix.status} ${fix.text.slice(0, 200)}`;
  }
  return '';
}

async function waitTerminal(workId, runId, { timeout = 60000 } = {}) {
  const t0 = Date.now();
  let view = null;
  const terminal = ['ready', 'needs_review', 'paused', 'stale', 'failed', 'cancelled', 'applied', 'reverted'];
  while (Date.now() - t0 < timeout) {
    const r = await client.api('GET', `/api/novel/state/repair?work_id=${workId}&run_id=${encodeURIComponent(runId)}`);
    view = r.json;
    const st = view && view.run && view.run.status;
    if (st && terminal.includes(st)) return view;
    await sleep(200);
  }
  return view;
}

const chapterContents = async (workId) => {
  const r = await client.api('GET', `/api/chapters?work_id=${workId}`);
  const rows = r.json.chapters || r.json || [];
  return rows.map((c) => String(c.content || ''));
};

try {
  // ── 建作品 + 4 章 + 可信前缀（保存 → 作者更正）──
  const wk = await client.createWork('T4 HTTP 逐章重建');
  const workId = Number(wk.json.id);
  const chIds = [];
  for (let i = 1; i <= 4; i += 1) {
    const r = await client.createChapter(workId, `第${i}章`, { content: `<p>第${i}章 占位。</p>` });
    chIds.push(Number(r.json.id));
  }
  const [c1, c2, c3, c4] = chIds;
  const cfg = await client.api('POST', '/api/api_configs', { name: 'T4 本机假模型（零计费）', base_url: `http://127.0.0.1:${fake.port}/v1`, api_key: 'sk-local-stub-not-billed', model: 'stub-model' });
  a.ok('H0 假模型配置已建立（零计费）', cfg.status === 201, `status=${cfg.status}`);
  const on = await client.setTemporal(workId, { temporal_enabled: true, auto_analysis_enabled: false, repair_enabled: true });
  a.ok('H0 时态引擎开启（自动分析关闭，避免后台运行干扰）', on.status === 200 && !!(on.json.config && on.json.config.enabled === true) && !!on.json.schema_ok);
  const seedErr = await seedPrefix(workId, chIds);
  a.ok('H0 逐章建立可信前缀（保存 → 作者更正）', seedErr === '', seedErr);

  // ── 根变更：第 2 章保存新正文 + 作者更正（王师傅 战死）──
  const saved = await client.api('PUT', `/api/chapters/${c2}`, { content: C2_AFTER, title: '第2章' });
  a.ok('H1 根章节保存新正文', saved.status === 200, `status=${saved.status} ${saved.text.slice(0, 160)}`);
  const rootChange = await client.correct(workId, c2, [
    { kind: 'character', entity_id: '王师傅', predicate: 'alive', value: false },
    { kind: 'character', entity_id: '王师傅', predicate: 'status', value: '战死' },
  ]);
  a.ok('H1 根变更经作者确认（alive → false / status → 战死）', rootChange.status === 200 && rootChange.json.ok === true, rootChange.text.slice(0, 200));

  // ── 审批：范围/基线绑定由服务端从真实存储计算 ──
  const startAppr = await client.createApproval({ work_id: workId, op: 'repair_run_start', root_chapter_id: c2, note: 'T4 HTTP 测试' });
  const startBinding = startAppr.json && startAppr.json.binding_json ? JSON.parse(startAppr.json.binding_json) : {};
  a.ok('H1 repair_run_start 审批签发（服务端绑定 root/base/scope）', startAppr.status === 201 && startAppr.json.status === 'active' && !!startAppr.json.baseline_hash && Number(startBinding.root_chapter_id) === c2, `status=${startAppr.status} ${startAppr.text.slice(0, 200)}`);

  // ── 模型侧 403（在任何作者启动之前，保证零副作用）──
  const agentStart = await client.api('POST', '/api/novel/state/repair/start', { work_id: workId, root_chapter_id: c2, approval_id: startAppr.json.id }, AGENT);
  a.ok('H3 模型侧不能启动重建（403）', agentStart.status === 403, `status=${agentStart.status}`);
  const agentApply = await client.api('POST', '/api/novel/state/repair/apply', { work_id: workId, run_id: 'x', approval_id: startAppr.json.id }, AGENT);
  a.ok('H3 模型侧不能应用重建（403）', agentApply.status === 403, `status=${agentApply.status}`);
  const agentResume = await client.api('POST', '/api/novel/state/repair/resume', { work_id: workId, run_id: 'x' }, AGENT);
  a.ok('H3 模型侧不能恢复重建（403）', agentResume.status === 403, `status=${agentResume.status}`);
  const agentCancel = await client.api('POST', '/api/novel/state/repair/cancel', { work_id: workId, run_id: 'x' }, AGENT);
  a.ok('H3 模型侧不能取消重建（403）', agentCancel.status === 403, `status=${agentCancel.status}`);

  // ── 启动（按钮动作）──
  const start = await client.api('POST', '/api/novel/state/repair/start', { work_id: workId, root_chapter_id: c2, approval_id: startAppr.json.id });
  a.ok('H1 POST /api/novel/state/repair/start 启动成功（后台逐章）', start.status === 200 && start.json.ok === true && start.json.run && start.json.run.status === 'running', `status=${start.status} ${start.text.slice(0, 240)}`);
  const runId = start.json.run.id;
  // ── 未就绪：apply 审批 409；未授权 apply 403 ──
  const early = await client.createApproval({ work_id: workId, op: 'repair_run_apply', run_id: runId });
  a.ok('H3 运行未就绪时签发 apply 审批 → 409（不得提前放行）', early.status === 409, `status=${early.status} ${early.text.slice(0, 160)}`);
  const noAppr = await client.api('POST', '/api/novel/state/repair/apply', { work_id: workId, run_id: runId });
  a.ok('H3 无审批 apply → 403（一次性授权不可或缺）', noAppr.status === 403, `status=${noAppr.status} ${noAppr.text.slice(0, 160)}`);

  // ── 等就绪（真实后台驱动 + 假模型）──
  const view = await waitTerminal(workId, runId);
  a.ok('H2 逐章重建运行就绪（ready + ready_gate.can_apply）', view && view.ok === true && view.run.status === 'ready' && view.ready_gate.can_apply === true, JSON.stringify({ st: view && view.run && view.run.status, gate: view && view.ready_gate }).slice(0, 260));
  const stepOf = (cid) => (view.steps || []).filter((s) => Number(s.chapter_id) === Number(cid)).slice(-1)[0] || {};
  const s3 = stepOf(c3); const s4 = stepOf(c4);
  a.ok('H2 第3章确认为冲突并生成候选修订（step=repaired）', String(s3.status) === 'repaired', JSON.stringify({ st: s3.status, reason: s3.result && s3.result.reason }).slice(0, 200));
  a.ok('H2 第4章在新前缀下仍成立（step=kept，正文未改）', String(s4.status) === 'kept' && s4.result && s4.result.revision_unchanged === true, JSON.stringify({ st: s4.status }).slice(0, 160));
  const contentsBefore = await chapterContents(workId);
  a.ok('H2 候选阶段绝不改写正式正文（4 章内容全部不变）', contentsBefore[0] === C1 && contentsBefore[1] === C2_AFTER && contentsBefore[2] === C3_ORIGINAL && contentsBefore[3] === C4, contentsBefore.map((x) => x.slice(0, 24)).join(' | '));
  a.ok('H2 重建只发生必要的生成（唯一 repaired 章）', (view.steps || []).filter((s) => String(s.status) === 'repaired').length === 1);
  a.ok('H2 假模型调用覆盖复核/生成/抽取（含修订后抽取）', ['verify', 'generate'].every((k) => hits.some((h) => h.kind === k)) && hits.some((h) => h.kind === 'extract' && h.repairExtract), JSON.stringify(hits.map((h) => h.kind)).slice(0, 200));

  // ── 幂等：重复点击复用同一运行，不消费新审批 ──
  const again = await client.createApproval({ work_id: workId, op: 'repair_run_start', root_chapter_id: c2 });
  const second = await client.api('POST', '/api/novel/state/repair/start', { work_id: workId, root_chapter_id: c2, approval_id: again.json.id });
  const list = await client.api('GET', `/api/novel/state/repair?work_id=${workId}`);
  const active = await client.listApprovals(workId, 'active');
  a.ok('H5 重复点击复用同一运行（幂等回执）', second.status === 200 && second.json.reused === true && String(second.json.run.id) === String(runId), `status=${second.status} ${second.text.slice(0, 200)}`);
  a.ok('H5 复用路径不消费新的启动审批，也不新建运行', (list.json.runs || []).length === 1 && (active.json.approvals || []).some((x) => String(x.id) === String(again.json.id)), `runs=${(list.json.runs || []).length} active=${(active.json.approvals || []).length}`);

  // ── 应用审批 + 应用（原子切换正式正文）──
  const applyAppr = await client.createApproval({ work_id: workId, op: 'repair_run_apply', run_id: runId });
  const applyBinding = applyAppr.json && applyAppr.json.binding_json ? JSON.parse(applyAppr.json.binding_json) : {};
  a.ok('H4 就绪后签发 apply 审批（绑定 manifest_hash）', applyAppr.status === 201 && !!applyBinding.manifest_hash, `status=${applyAppr.status} ${applyAppr.text.slice(0, 160)}`);
  const apply = await client.api('POST', '/api/novel/state/repair/apply', { work_id: workId, run_id: runId, approval_id: applyAppr.json.id });
  a.ok('H4 apply 原子切换正式正文（一个事务）', apply.status === 200 && apply.json.ok === true, `status=${apply.status} ${apply.text.slice(0, 240)}`);
  const contentsAfter = await chapterContents(workId);
  a.ok('H4 修订章正文已切换、保留章/范围外章节未变', contentsAfter[2].includes('独自埋葬') && contentsAfter[0] === C1 && contentsAfter[1] === C2_AFTER && contentsAfter[3] === C4, contentsAfter.map((x) => x.slice(0, 24)).join(' | '));
  const versions = await client.api('GET', `/api/chapter_versions?chapter_id=${c3}`);
  const rows = versions.json || [];
  a.ok('H4 被替换的旧稿保留在 chapter_save_versions（可恢复）', Array.isArray(rows) && rows.some((r) => String(r.content || '').includes('等待说好的接应')), `versions=${Array.isArray(rows) ? rows.length : 'n/a'}`);
  const viewApplied = await client.api('GET', `/api/novel/state/repair?work_id=${workId}&run_id=${runId}`);
  a.ok('H4 运行状态落到 applied（真实后端状态）', viewApplied.json && viewApplied.json.run.status === 'applied' && !!viewApplied.json.run.result.apply, JSON.stringify(viewApplied.json && viewApplied.json.run && viewApplied.json.run.status));

  // ── 撤销（恢复重建前正文）──
  const revert = await client.api('POST', '/api/novel/state/repair/revert', { work_id: workId, run_id: runId });
  const contentsReverted = await chapterContents(workId);
  a.ok('H4 撤销恢复重建前正文', revert.status === 200 && revert.json.ok === true && contentsReverted[2] === C3_ORIGINAL, `status=${revert.status} ${contentsReverted[2].slice(0, 30)}`);

  // ── H6：审批只对签发时的基线有效 ──
  const staleAppr = await client.createApproval({ work_id: workId, op: 'repair_run_start', root_chapter_id: c2 });
  const bump = await client.correct(workId, c2, [{ kind: 'character', entity_id: '王师傅', predicate: 'location', value: '战场' }]);
  a.ok('H6 运行后基线前进（第2章新增已确认事实）', bump.status === 200 && bump.json.ok === true, bump.text.slice(0, 200));
  const staleTry = await client.api('POST', '/api/novel/state/repair/start', { work_id: workId, root_chapter_id: c2, approval_id: staleAppr.json.id });
  a.ok('H6 基线漂移后旧审批被拒（403，不静默降级）', staleTry.status === 403, `status=${staleTry.status} ${staleTry.text.slice(0, 200)}`);

  // ── H8（T6）：候选修订只读预览端点（前端「预览候选」的真实读取入口）──
  const candRev = await client.api('GET', `/api/novel/state/revision?work_id=${workId}&revision_id=${encodeURIComponent(String(s3.candidate_revision_id))}`);
  a.ok('H8 候选修订预览返回该章候选正文（含文本哈希，前端可做 diff）',
    candRev.status === 200 && candRev.json.ok === true && candRev.json.revision && Number(candRev.json.revision.chapter_id) === c3
      && String(candRev.json.revision.content_html).includes('独自埋葬') && !!candRev.json.revision.text_hash,
    `status=${candRev.status} ${candRev.text.slice(0, 160)}`);
  const otherWorkRev = await client.api('GET', `/api/novel/state/revision?work_id=99999&revision_id=${encodeURIComponent(String(s3.candidate_revision_id))}`);
  a.ok('H8 归属校验：跨作品读取候选修订 → 404（不泄露他作正文）', otherWorkRev.status === 404, `status=${otherWorkRev.status}`);
  const missingRev = await client.api('GET', `/api/novel/state/revision?work_id=${workId}&revision_id=rev-does-not-exist`);
  a.ok('H8 不存在的修订 → 404（不返回空壳 200）', missingRev.status === 404, `status=${missingRev.status}`);
  const contentsAfterRead = await chapterContents(workId);
  a.ok('H8 预览是纯读：读候选修订不改变任何正式正文', JSON.stringify(contentsAfterRead) === JSON.stringify(contentsReverted), contentsAfterRead.map((x) => x.slice(0, 18)).join(' | '));

  await client.deleteWork(workId);
  // ── H7：独立作品 —— 缺审批拒绝 / 取消 / 已取消不可 apply ──
  const wk2 = await client.createWork('T4 HTTP 取消');
  const work2 = Number(wk2.json.id);
  const ch2 = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await client.createChapter(work2, `第${i}章`, { content: `<p>第${i}章 占位。</p>` });
    ch2.push(Number(r.json.id));
  }
  const [, d2] = ch2;
  const on2 = await client.setTemporal(work2, { temporal_enabled: true, auto_analysis_enabled: false, repair_enabled: true });
  a.ok('H7 第二作品引擎开启', on2.status === 200 && !!on2.json.schema_ok);
  const seedErr2 = await seedPrefix(work2, ch2);
  a.ok('H7 第二作品建立可信前缀', seedErr2 === '', seedErr2);
  const root2 = await client.correct(work2, d2, [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '战死' }]);
  a.ok('H7 第二作品根变更确认（王师傅 战死）', root2.status === 200 && root2.json.ok === true, root2.text.slice(0, 200));
  const noAppr2 = await client.api('POST', '/api/novel/state/repair/start', { work_id: work2, root_chapter_id: d2 });
  a.ok('H7 缺审批启动 → 403（拒绝而非默认放行，且不建运行）', noAppr2.status === 403, `status=${noAppr2.status} ${noAppr2.text.slice(0, 200)}`);
  const appr2 = await client.createApproval({ work_id: work2, op: 'repair_run_start', root_chapter_id: d2 });
  const start2 = await client.api('POST', '/api/novel/state/repair/start', { work_id: work2, root_chapter_id: d2, approval_id: appr2.json.id });
  a.ok('H7 第二作品启动成功（running）', start2.status === 200 && start2.json.run && start2.json.run.status === 'running', `status=${start2.status} ${start2.text.slice(0, 200)}`);
  const run2 = start2.json.run.id;
  const cancel2 = await client.api('POST', '/api/novel/state/repair/cancel', { work_id: work2, run_id: run2 });
  a.ok('H7 取消 → cancelled（断点保留，不算重建完成）', cancel2.status === 200 && cancel2.json.ok === true && cancel2.json.run.status === 'cancelled', JSON.stringify({ status: cancel2.status, st: cancel2.json && cancel2.json.run && cancel2.json.run.status }).slice(0, 200));
  const appr2b = await client.createApproval({ work_id: work2, op: 'repair_run_apply', run_id: run2 });
  a.ok('H7 已取消运行签发 apply 审批 → 409', appr2b.status === 409, `status=${appr2b.status} ${appr2b.text.slice(0, 160)}`);
  const apply2 = await client.api('POST', '/api/novel/state/repair/apply', { work_id: work2, run_id: run2, approval_id: appr2b.json && appr2b.json.id });
  a.ok('H7 已取消运行不可 apply', [403, 409].includes(apply2.status), `status=${apply2.status}`);
  await client.deleteWork(work2);
} finally {
  const cfgList = await client.api('GET', '/api/api_configs');
  for (const c of (cfgList.json && cfgList.json.configs) || []) if (/本机假模型/.test(String(c.name || ''))) await client.api('DELETE', `/api/api_configs/${c.id}`);
  await server.stop();
  fake.server.close();
}

const failed = a.summary('T4 HTTP 逐章重建接线');
process.exitCode = failed ? 1 : 0;
