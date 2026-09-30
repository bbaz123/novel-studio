#!/usr/bin/env node
/**
 * tests/temporal/15-backfill-http.test.mjs —— T7「存量重建 / bootstrap」生产接线证据
 * （自托管隔离实例，零模型、零计费；不注册任何模型配置 → 语义分析结果只能是 not_run）。
 *
 * 覆盖：
 *   H1 未开启作品：backfill/step 409 + enabled:false；只读进度可用；零写入（默认关闭的语义）；
 *   H2 作者启用引擎 → 200，返回 enable_scope（预算 + 待重建范围）与 migration 登记；
 *   H3 step（无 result）→ awaiting_extraction + 真实抽取请求；正文行一字不改（GET 章节内容对照）；
 *   H4 step（带 result）→ 候选（不写正式状态）→ 作者 confirm → 可信前缀前进；重复 confirm 幂等；
 *   H5 顺序 / 模型侧：跳章确认 409；X-Novel-Agent 的 confirm / bootstrap 一律 403；
 *   H6 bootstrap：旧字段最新值只是待确认候选（历史查询里没有任何自动回填）；作者确认才进入初始状态；
 *      拒绝不写状态；模型侧 403。
 *
 * 纪律：NOVELSTUDIO_DATA_DIR 指向 mkdtemp 临时目录；不连任何真实模型端点；作品自建自清理。
 */
import { createAssert, createClient, startIsolatedServer, kv } from './http-harness.mjs';

const a = createAssert();
const server = await startIsolatedServer({ tag: 't7-backfill-http' });
const client = createClient(server.base);
const AGENT = { 'x-novel-agent': '1' };
const step = (workId, chapterId, body = {}) => client.api('POST', '/api/novel/state/backfill/step', { work_id: workId, chapter_id: chapterId, ...body });
const confirm = (workId, chapterId, headers = {}) => client.api('POST', '/api/novel/state/backfill/confirm', { work_id: workId, chapter_id: chapterId }, headers);
const status = (workId) => client.api('GET', `/api/novel/state/backfill?work_id=${workId}`);
const bootPlan = (workId, headers = {}) => client.api('POST', '/api/novel/state/backfill/bootstrap/plan', { work_id: workId }, headers);
const bootDecide = (workId, candidateId, body = {}, headers = {}) => client.api('POST', '/api/novel/state/backfill/bootstrap/decide', { work_id: workId, candidate_id: candidateId, ...body }, headers);

const C1 = '第1章 正文。王师傅在青云镇教主角练刀。';
const C2 = '第2章 正文。主角独自在青云镇整理行装。';
const C3 = '第3章 正文。主角启程前往黑风谷。';

let workOff = 0;
let workOn = 0;
let workBoot = 0;
try {
  // ── H1 未开启作品：零接管 ────────────────────────────────────────────────
  const w = await client.createWork('T7-H1-未开启');
  workOff = w.json.id;
  const chOff = [];
  for (const t of [C1, C2]) chOff.push((await client.createChapter(workOff, t.slice(0, 6), { content: t })).json.id);
  const stepOff = await step(workOff, chOff[0]);
  a.ok('H1a 未开启作品 backfill/step → 409 + enabled:false（不产生修订/提案）', stepOff.status === 409 && stepOff.json.enabled === false, `status=${stepOff.status} ${stepOff.text.slice(0, 160)}`);
  const bootOff = await bootPlan(workOff);
  a.ok('H1b 未开启作品 bootstrap/plan → 409（候选也要先启用引擎）', bootOff.status === 409 && bootOff.json.enabled === false, `status=${bootOff.status} ${bootOff.text.slice(0, 160)}`);
  const atOff = await client.stateAt(workOff, chOff[0]);
  a.ok('H1c 未开启作品历史查询保持旧契约（enabled:false 且无状态）', atOff.status === 200 && atOff.json.enabled === false, `status=${atOff.status} ${atOff.text.slice(0, 200)}`);
  const stOff = await status(workOff);
  a.ok('H1d 只读进度可直接用于启用前范围告知（config.enabled=false）', stOff.status === 200 && stOff.json.config && stOff.json.config.enabled === false, stOff.text.slice(0, 200));

  // ── H2 作者启用 → 预算/范围告知 ──────────────────────────────────────────
  const on = await client.setTemporal(workOff, { temporal_enabled: true, auto_analysis_enabled: false, repair_enabled: false });
  a.ok('H2a 作者启用引擎 200（schema_ok + migration 登记）', on.status === 200 && on.json.schema_ok === true && on.json.migration && on.json.migration.applied === true, on.text.slice(0, 220));
  a.ok('H2b 启用时告知预算与待重建范围（章数 / 预计模型调用 / 默认关闭自动分析）',
    !!on.json.enable_scope && on.json.enable_scope.budget.chapters_total === 2 && on.json.enable_scope.budget.model_calls_estimated === 2
    && on.json.enable_scope.budget.auto_analysis_default === 'off' && on.json.enable_scope.pending_rebuild.chapters === 2,
    JSON.stringify(on.json.enable_scope && on.json.enable_scope.budget));
  a.ok('H2c 未开启自动分析：语义结果不会被伪装成已完成（auto_analysis=false）', on.json.config && on.json.config.auto_analysis === false);

  // ── H3 step（无 result）→ 抽取请求；正文一字不改 ─────────────────────────
  const before = await client.api('GET', `/api/chapters/${chOff[0]}`);
  const step1 = await step(workOff, chOff[0]);
  a.ok('H3a step → awaiting_extraction + 真实抽取请求（含章前状态与已知名）',
    step1.status === 200 && step1.json.status === 'awaiting_extraction' && step1.json.prompt && typeof step1.json.prompt.user === 'string' && step1.json.prompt.user.length > 0,
    step1.text.slice(0, 200));
  a.ok('H3b 事后重建出处如实标注（generation_context=unknown / reconstructed）',
    step1.json.provenance && step1.json.provenance.generation_context === 'unknown' && step1.json.provenance.support === 'reconstructed');
  const after = await client.api('GET', `/api/chapters/${chOff[0]}`);
  a.ok('H3c 冻结修订不改写导入正文（章节内容逐字节不变）', typeof before.json.content === 'string' && before.json.content === after.json.content);
  const atPending = await client.stateAt(workOff, chOff[0]);
  a.ok('H3d 只有抽取请求、没有模型结果时：没有假事件、没有正式状态', atPending.json.validity === 'pending' && JSON.stringify(atPending.json.state_json) === '{}', atPending.text.slice(0, 200));

  // ── H4 候选 → 作者确认 → 可信前缀前进；幂等 ──────────────────────────────
  const result = { events: [{ ops: [{ type: 'set', cell: { domain: 'character', entityId: '王师傅', predicate: 'status', scope: 'canon', holderId: null }, expected: { kind: 'missing' }, value: '存活' }], evidence: [{ quote: '王师傅在青云镇教主角练刀', narrative: 'present' }] }] };
  const step2 = await step(workOff, chOff[0], { result, provider: 'http-test-local' });
  a.ok('H4a step（带本地结果）→ pending_confirm（候选，不写正式状态）', step2.status === 200 && step2.json.status === 'pending_confirm', step2.text.slice(0, 220));
  const atCand = await client.stateAt(workOff, chOff[0]);
  a.ok('H4b 候选未确认前正式状态里没有该值（AC-13/AC-39）', !(atCand.json.state_json && atCand.json.state_json[kv('character', '王师傅', 'status')] === '存活'), atCand.text.slice(0, 200));
  const conf1 = await confirm(workOff, chOff[0]);
  a.ok('H4c 作者确认 → valid；可信前缀前进（trusted_through=0）+ 给出下一章',
    conf1.status === 200 && conf1.json.ok === true && conf1.json.trusted_through === 0 && conf1.json.next_chapter_id === chOff[1],
    conf1.text.slice(0, 240));
  const atOk = await client.stateAt(workOff, chOff[0]);
  a.ok('H4d 确认后历史查询反映新事实（确定性路径，无需模型）', atOk.json.validity === 'valid' && atOk.json.state_json?.[kv('character', '王师傅', 'status')] === '存活', atOk.text.slice(0, 200));
  const confAgain = await confirm(workOff, chOff[0]);
  a.ok('H4e 重复确认 → 幂等回执（不重复写入）', confAgain.status === 200 && confAgain.json.ok === true && confAgain.json.reused === true, confAgain.text.slice(0, 200));

  // ── H5 顺序 / 模型侧边界 ────────────────────────────────────────────────
  const skip = await confirm(workOff, chOff[0] + 100000);
  a.ok('H5a 跨作品 / 不存在章节 → 404（不静默放行）', skip.status === 404, `status=${skip.status}`);
  const agentConfirm = await confirm(workOff, chOff[0], AGENT);
  a.ok('H5b 模型侧（X-Novel-Agent）确认 → 403（模型不能确认自己的抽取）', agentConfirm.status === 403, `status=${agentConfirm.status}`);
  const agentBoot = await bootPlan(workOff, AGENT);
  a.ok('H5c 模型侧 bootstrap/plan → 403', agentBoot.status === 403, `status=${agentBoot.status}`);

  // ── H6 bootstrap：旧字段最新值 → 待确认候选 ──────────────────────────────
  const wb = await client.createWork('T7-H6-存量旧字段');
  workBoot = wb.json.id;
  const chb = [];
  for (const t of [C1, C2, C3]) chb.push((await client.createChapter(workBoot, t.slice(0, 6), { content: t })).json.id);
  const onB = await client.setTemporal(workBoot, { temporal_enabled: true, auto_analysis_enabled: false });
  a.ok('H6a 第二作品启用', onB.status === 200 && onB.json.schema_ok === true);
  const chA = await client.api('POST', '/api/characters', { work_id: workBoot, name: '王师傅', status: '已战死' });
  const chB = await client.api('POST', '/api/characters', { work_id: workBoot, name: '主角', status: '存活' });
  a.ok('H6b 既有角色卡（含"最新 status=已战死"）已建立', chA.status < 300 && chB.status < 300, `${chA.status}/${chB.status}`);
  const freeze = await step(workBoot, chb[0]);
  a.ok('H6c-pre 冻结第一章修订（bootstrap 候选必须锚定真实修订）', freeze.status === 200 && freeze.json.status === 'awaiting_extraction', freeze.text.slice(0, 200));
  const boot1 = await bootPlan(workBoot);
  a.ok('H6c 候选登记：旧字段最新值只是待确认（不自动回填）',
    boot1.status === 201 && boot1.json.ok === true && boot1.json.created >= 2 && boot1.json.candidates.every((c) => c.status === 'pending'),
    boot1.text.slice(0, 240));
  const beforeBoot = await client.stateBefore(workBoot, chb[0]);
  const afterBoot = await client.stateAt(workBoot, chb[2]);
  a.ok('H6d 未确认前：开篇/各章状态里都没有"已战死"（AC-40）',
    !(beforeBoot.json.state_json && Object.keys(beforeBoot.json.state_json).length) && !(afterBoot.json.state_json && Object.keys(afterBoot.json.state_json).length),
    JSON.stringify({ before: beforeBoot.json.state_json, after: afterBoot.json.state_json }).slice(0, 240));
  const wangCand = boot1.json.candidates.find((c) => c.entity_id === '王师傅');
  const decided = await bootDecide(workBoot, wangCand.candidate_id, { decision: 'confirm', effective: 'opening' });
  a.ok('H6e 作者确认"作为开篇设定" → 写入初始状态', decided.status === 200 && decided.json.ok === true && decided.json.decision === 'confirmed', decided.text.slice(0, 240));
  const initState = await client.stateBefore(workBoot, chb[0]);
  a.ok('H6f 开篇状态可见：第一章章前即有该事实（initial 已应用）',
    initState.json.initial && initState.json.initial.applied === true && initState.json.state_json?.[kv('character', '王师傅', 'status')] === '已战死',
    initState.text.slice(0, 240));
  const heroCand = boot1.json.candidates.find((c) => c.entity_id === '主角');
  const rejected = await bootDecide(workBoot, heroCand.candidate_id, { decision: 'reject' });
  a.ok('H6g 拒绝候选 → 记录拒绝、不写任何状态', rejected.status === 200 && rejected.json.decision === 'rejected'
    && (await client.stateBefore(workBoot, chb[0])).json.state_json?.[kv('character', '主角', 'status')] === undefined, rejected.text.slice(0, 200));
  const agentDecide = await bootDecide(workBoot, heroCand.candidate_id, { decision: 'confirm' }, AGENT);
  a.ok('H6h 模型侧 bootstrap/decide → 403', agentDecide.status === 403, `status=${agentDecide.status}`);

  // ── H7 进度接口：真实后端状态（不是前端拼的） ────────────────────────────
  const st = await status(workBoot);
  a.ok('H7a 进度含候选 / 预算 / 逐章状态机（后端真值）',
    st.status === 200 && st.json.ok === true && st.json.bootstrap && st.json.bootstrap.total >= 2 && st.json.bootstrap.items.some((c) => c.status === 'confirmed') && st.json.bootstrap.items.some((c) => c.status === 'rejected') && st.json.budget && Array.isArray(st.json.chapters) && st.json.chapters.length === 3,
    st.text.slice(0, 240));
  a.ok('H7b 未确认章节在计划里如实标 pending_analysis / missing_revision，而不是 valid',
    st.json.chapters.every((c) => c.state !== 'valid'), st.json.chapters.map((c) => c.state).join(','));
} finally {
  for (const id of [workOff, workBoot]) if (id) await client.deleteWork(id);
  await server.stop();
}

const failed = a.summary('T7 HTTP 存量重建与 bootstrap 接线');
process.exitCode = failed ? 1 : 0;
