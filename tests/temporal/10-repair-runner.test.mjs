#!/usr/bin/env node
/**
 * tests/temporal/10-repair-runner.test.mjs —— T4「按钮驱动的逐章候选重建」（进程内、零计费）。
 *
 * 覆盖：AC-15/16/17/18/19/20/21/22/23/24/25/26/27 的模块级证据，以及任务书 §8.5 要求的注入：
 *   生成后取消 / 状态写入中断（apply 故障注入 → 事务整体回滚）/ 审批消费失败 / 旧 worker 回写 /
 *   任务恢复（断点 + 预算不重置）/ 用户中途编辑 / 连续三次修订失败 / 重复指纹停止。
 *
 * 隔离纪律：isolatedDir() 在 import db.js 之前调用；全部假模型，绝不调用真实计费端点。
 * 生产 HTTP 接线（路由 / 审批 / 403）在 tests/temporal/11-repair-http.test.mjs。
 */
import assert from 'node:assert/strict';
import { isolatedDir, seedWork, suiteAsync } from './harness.mjs';

isolatedDir('ns-temporal-repair-');
const T = await import('../../ai/story-state/temporal/index.mjs');
const Repair = await import('../../ai/repair/runner.mjs');
const Approvals = await import('../../ai/story-state/approval.mjs');
const Runs = await import('../../ai/repair/store.mjs');
const { db } = await import('../../db.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const setOp = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });
const countOf = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
const chapterRow = (id) => db.prepare('SELECT * FROM chapters WHERE id = ?').get(Number(id));
const baseText = (n) => `<p>第${n}章 正文。王师傅与主角同行于青云镇外的山道，风从谷口吹来，两人沉默赶路。</p>`;
const rootText = '<p>第2章 正文。王师傅战死，主角立誓查清死因，独自踏上归途。</p>';
const sleep0 = () => new Promise((r) => setImmediate(r));

function seedTemporalWork(title, chapters = 5) {
  const { workId, chapterIds } = seedWork(db, { title, chapters });
  T.setTemporalConfig(workId, { temporal_enabled: true, auto_analysis_enabled: false });
  for (const [i, chapterId] of chapterIds.entries()) {
    const text = baseText(i + 1);
    db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(text, chapterId);
    const events = [{ ops: [setOp(cell('plotline', `线${i + 1}`, 'status'), '进行中')], evidence: [{ quote: `第${i + 1}章 正文`, narrative: 'present' }] }];
    if (i === 0) {
      events.push({
        ops: [
          setOp(cell('character', '王师傅', 'alive'), true),
          setOp(cell('character', '王师傅', 'status'), '存活'),
          setOp(cell('character', '主角', 'alive'), true),
          setOp(cell('character', '主角', 'status'), '存活'),
        ],
        evidence: [{ quote: '第1章 正文', narrative: 'present' }],
      });
    }
    const r = T.applyChapterEvents({ workId, chapterId, events, source: 'author_confirm', contentHtml: text });
    assert.equal(r.ok, true, `确认第${i + 1}章失败：${r.reason || ''} ${JSON.stringify(r.issues || [])}`);
  }
  return { workId, chapterIds };
}

/** 根章节（第 2 章）作者更正：王师傅 存活 → 战死（已确认的根变更）。 */
function changeRootToDeath(workId, rootChapterId) {
  db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(rootText, rootChapterId);
  const r = T.applyChapterEvents({
    workId, chapterId: rootChapterId, source: 'author_correction', contentHtml: rootText,
    events: [{
      ops: [
        setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }),
        setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }),
      ],
      evidence: [{ quote: '王师傅战死', narrative: 'present' }],
    }],
  });
  assert.equal(r.ok, true, `根变更确认失败：${r.reason || ''}`);
  return r;
}

function startApprovalFor(workId, rootChapterId, chapterIds = null) {
  const info = Repair.repairStartBinding({ workId, rootChapterId, chapterIds });
  assert.equal(info.ok, true, `启动绑定计算失败：${info.reason || ''}`);
  const row = Approvals.createApproval({ workId, op: 'repair_run_start', baselineHash: info.baseline_hash, binding: info.binding, note: 'T4 测试' });
  return { info, approval: row };
}

function applyApprovalFor(workId, runId) {
  const info = Repair.repairApplyBinding({ workId, runId });
  assert.equal(info.ok, true, `应用绑定计算失败：${info.reason || ''}`);
  assert.equal(info.ready, true, '候选未就绪：不能创建应用审批');
  const row = Approvals.createApproval({ workId, op: 'repair_run_apply', baselineHash: info.baseline_hash, binding: { run_id: info.run_id, manifest_hash: info.manifest_hash }, note: 'T4 测试' });
  return { info, approval: row };
}

function testHooks(overrides = {}) {
  return {
    saveChapterVersion: (chapterId, title, summary, content, kind = 'manual') => {
      db.prepare('INSERT INTO chapter_save_versions (chapter_id, title, summary, content, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Number(chapterId), String(title || ''), String(summary || ''), String(content || ''), new Date().toISOString(), kind === 'draft' ? 'draft' : 'manual');
      return { id: 1 };
    },
    enqueueProjectionInTx: (workId, { chapterId = null, kind = 'ov_work_sync', payload = {}, dedupKey = '' } = {}) => {
      const info = db.prepare('INSERT OR IGNORE INTO projection_outbox (work_id, chapter_id, kind, dedup_key, payload_json) VALUES (?, ?, ?, ?, ?)')
        .run(Number(workId) || 0, chapterId ? Number(chapterId) : null, String(kind), String(dedupKey), JSON.stringify(payload || {}));
      return { id: Number(info.lastInsertRowid) || 0, created: Number(info.changes) === 1 };
    },
    ...overrides,
  };
}

/** 假模型：按用途脚本化；记录每次调用的正文/输入，供断言。 */
function makeFake(script = {}) {
  const calls = [];
  const generate = async (args) => {
    calls.push({ purpose: String(args.purpose || ''), chapter_id: Number(args.chapter_id) || 0, user: String(args.user || ''), system: String(args.system || ''), at: Date.now() });
    const handler = script[String(args.purpose || '')] || script.default;
    if (typeof handler === 'function') return handler(args, calls);
    if (handler === undefined) throw new Error(`fake 未配置用途 ${args.purpose}`);
    return handler;
  };
  generate.calls = calls;
  return generate;
}

const verdictValid = JSON.stringify({ decision: 'valid', conflicts: [], checked: [{ assumption: '王师傅仍然活着', verdict: 'holds', quote: '王师傅与主角同行' }], notes: '' });
const conflictOnly = (chapterId) => (args) => (Number(args.chapter_id) === Number(chapterId) && !String(args.user).includes('独自埋葬') ? verdictConflict : verdictValid);
const genRepairText = (args) => JSON.stringify({ revised_text: `第${args.chapter_id}章 正文。主角独自埋葬了王师傅，立誓查清死因，随后踏上归途。` });
const repairHtml = (chapterId) => `<p>第${chapterId}章 正文。主角独自埋葬了王师傅，立誓查清死因，随后踏上归途。</p>`;
const extractRepairFor = (args) => JSON.stringify({
  events: [{ ops: [setOp(cell('plotline', `线${args.chapter_id}`, 'status'), '已转向复仇')], evidence: [{ quote: '主角独自埋葬了王师傅', narrative: 'present' }] }],
  assumptions: [{ kind: 'goal', statement: '主角决意查清死因', quote: '立誓查清死因' }],
});
const verdictConflict = JSON.stringify({ decision: 'conflict', conflicts: [{ kind: 'implicit_causal', premise: '王师傅仍然活着', quote: '王师傅与主角同行', detail: '本章行动建立在王师傅存活之上' }], checked: [], notes: '' });
const extractRepair = JSON.stringify({
  events: [{
    ops: [setOp(cell('plotline', '线3', 'status'), '已转向复仇')],
    evidence: [{ quote: '主角独自埋葬了王师傅', narrative: 'present' }],
  }],
  assumptions: [{ kind: 'goal', statement: '主角决意查清死因', quote: '立誓查清死因' }],
});

async function waitRun(workId, runId, accept, { timeout = 20000 } = {}) {
  const t0 = Date.now();
  let view = null;
  while (Date.now() - t0 < timeout) {
    view = Repair.repairRunView({ workId, runId });
    if (view.ok && accept(view.run)) return view;
    await sleep(15);
  }
  throw new Error(`等待运行状态超时：最后 ${view && view.run && view.run.status}`);
}
const terminal = new Set(['ready', 'needs_review', 'paused', 'stale', 'failed', 'cancelled']);
const waitTerminal = (workId, runId) => waitRun(workId, runId, (r) => terminal.has(r.status));const flow = {};

await suiteAsync('temporal/10-repair-runner', [
  ['AC-15/16：一次启动自动逐章；第 N 章候选先入线，第 N+1 章输入从新前缀重建', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 主流程', 5);
    const [c1, c2, c3, c4, c5] = chapterIds;
    const root = changeRootToDeath(workId, c2);
    const plan = Repair.planRepair({ workId, rootChapterId: c2 });
    assert.equal(plan.ok, true, `计划失败：${plan.reason}`);
    assert.deepEqual(plan.chapters, [c3, c4, c5]);
    assert.equal(plan.startable, true);
    const { info, approval } = startApprovalFor(workId, c2);
    const fake = makeFake({
      repair_verify: conflictOnly(c3),
      repair_generate: genRepairText,
      repair_extract: extractRepairFor,
    });
    const started = await Repair.startRepairRun({
      workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub',
      policy: { max_attempts_per_chapter: 3, max_final_sweeps: 3 },
    });
    assert.equal(started.ok, true, `启动失败：${started.reason || ''}`);
    flow.workId = workId; flow.chapterIds = chapterIds; flow.runId = started.run.id; flow.fake = fake; flow.approval = approval; flow.plan = plan; flow.root = root;
    const view = await waitRun(workId, started.run.id, (r) => r.status === 'ready' || r.status === 'needs_review' || r.status === 'paused');
    assert.equal(view.run.status, 'ready', `运行未就绪：${view.run.status} ${JSON.stringify(view.run.result && view.run.result.halt || null)}`);
    assert.equal(view.ready_gate.can_apply, true, JSON.stringify(view.ready_gate.reasons));
    flow.view = view;
    const steps = view.steps;
    const stepOf = (chapterId) => steps.filter((s) => Number(s.chapter_id) === Number(chapterId))[steps.filter((s) => Number(s.chapter_id) === Number(chapterId)).length - 1];
    const s3 = stepOf(c3); const s4 = stepOf(c4); const s5 = stepOf(c5);
    assert.equal(s3.status, 'repaired');
    assert.equal(s4.status, 'kept');
    assert.equal(s5.status, 'kept');
    assert.equal(s3.result.output_state_content_hash, s4.result.input_state_content_hash, 'AC-16：第 4 章输入必须等于第 3 章输出');
    assert.equal(s4.result.output_state_content_hash, s5.result.input_state_content_hash, 'AC-16：第 5 章输入必须等于第 4 章输出');
    assert.notEqual(s4.result.input_state_content_hash, s3.result.input_state_content_hash, '第 3 章修订必须改变第 4 章的输入');
    assert.equal(s4.result.revision_unchanged, true, '保留章必须证明正文未改');
    assert.equal(chapterRow(c3).content, baseText(3), '候选阶段不得改写正式正文');
    assert.equal(chapterRow(c4).content, baseText(4));
    assert.equal(chapterRow(c5).content, baseText(5));
    assert.equal(Approvals.getApproval(approval.id).status, 'consumed', '一次性启动授权必须被消费');
    assert.equal(fake.calls.filter((c) => c.purpose === 'repair_generate').length, 1, 'AC-15：同一次启动内自动逐章，不逐章反复生成');
  }],

  ['AC-22：同一按钮重复点击不重复建运行/不重复消费审批（幂等回执）', async () => {
    const { workId, runId, chapterIds } = flow;
    const info = Repair.repairStartBinding({ workId, rootChapterId: chapterIds[1] });
    const approval2 = Approvals.createApproval({ workId, op: 'repair_run_start', baselineHash: info.baseline_hash, binding: info.binding });
    const fake = makeFake({ default: verdictValid });
    const second = await Repair.startRepairRun({ workId, rootChapterId: chapterIds[1], approvalId: approval2.id, generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true, '重复点击必须复用既有运行');
    assert.equal(second.run.id, runId);
    assert.equal(countOf('SELECT COUNT(*) n FROM story_repair_runs WHERE work_id = ?', workId), 1, '不得新建第二个运行');
    assert.equal(Approvals.getApproval(approval2.id).status, 'active', '复用路径不得消费新的启动审批');
  }],

  ['AC-26：正常完成后一次应用（正文/绑定/HEAD/投影/outbox 同事务；旧稿可恢复）', async () => {
    const { workId, runId, chapterIds } = flow;
    const [c1, c2, c3] = chapterIds;
    const applyInfo = applyApprovalFor(workId, runId);
    const hooks = testHooks();
    const receipt = Repair.applyRepairRun({ workId, runId, approvalId: applyInfo.approval.id, hooks });
    assert.equal(receipt.ok, true, `应用失败：${receipt.reason || ''}`);
    assert.equal(receipt.compat.ok, true, '兼容投影必须一次刷新');
    assert.equal(receipt.projection.created, true, 'outbox 必须同一事务落库');
    assert.equal(chapterRow(c3).content, repairHtml(c3), '第 3 章正文必须切换为修订候选');
    assert.equal(chapterRow(c1).content, baseText(1), '范围外章节不得改写');
    assert.equal(countOf("SELECT COUNT(*) n FROM chapter_save_versions WHERE chapter_id = ? AND content = ? AND kind = 'manual'", c3, baseText(3)), 1, '被替换的旧正文必须保留版本备份');
    assert.equal(Runs.getRun(runId).status, 'applied');
    const state = T.stateAt({ workId, chapterId: chapterIds[4], boundary: 'after' });
    const kv = (domain, entityId, predicate) => state.state.get(T.cellKey(cell(domain, entityId, predicate)));
    assert.equal(kv('character', '王师傅', 'status'), '战死', '正式状态必须来自新世界线');
    assert.equal(kv('plotline', '线3', 'status'), '已转向复仇', '修订章的新事件必须进入正式状态');
    assert.equal(String(state.trusted), 'true', '应用后截至末章的正式状态必须是可信前缀');
    const dup = Repair.applyRepairRun({ workId, runId, approvalId: '', hooks });
    assert.equal(dup.reused, true, 'AC-22：重复 apply 必须返回同一回执');
    assert.equal(dup.commit_id, receipt.commit_id);
    assert.equal(Approvals.getApproval(applyInfo.approval.id).status, 'consumed');
    flow.receipt = receipt;
  }],

  ['AC-27：撤销产生恢复提交；应用后已有新编辑 → CAS 拒绝且不覆盖', async () => {
    const { workId, runId, chapterIds, receipt } = flow;
    const c3 = chapterIds[2];
    const editedAfterApply = '<p>第3章 作者应用后的新编辑，不属于任何候选。</p>';
    db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(editedAfterApply, c3);
    const blocked = Repair.revertRepairRun({ workId, runId, hooks: testHooks() });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.rejected, 'cas_conflict');
    assert.equal(Runs.getRun(runId).status, 'applied', 'CAS 冲突时运行必须保持 applied（保留恢复候选）');
    assert.equal(chapterRow(c3).content, editedAfterApply, '绝不覆盖作者新编辑');
    assert.equal((Runs.getRun(runId).result.recovery || {}).cas_conflict.length, 1);
    // 作者把正文改回候选版本后，撤销可以执行
    db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(repairHtml(c3), c3);
    const hooks = testHooks();
    const reverted = Repair.revertRepairRun({ workId, runId, hooks });
    assert.equal(reverted.ok, true, `撤销失败：${reverted.reason || ''}`);
    assert.equal(Runs.getRun(runId).status, 'reverted');
    assert.equal(chapterRow(c3).content, baseText(3), '撤销必须恢复重建前正文');
    assert.notEqual(reverted.commit_id, receipt.commit_id, '撤销必须产生恢复提交');
    assert.equal(countOf("SELECT COUNT(*) n FROM chapter_save_versions WHERE chapter_id = ? AND content = ? AND kind = 'manual'", c3, repairHtml(c3)), 1, '被替换的候选正文必须保留版本备份');
  }],
]);await suiteAsync('temporal/10-repair-runner-injections', [
  ['AC-17：修复试图撤销根变更 → 拒绝（根锁），不得通过恢复旧前提通过检查', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 根锁', 4);
    const [, c2, c3] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    const fake = makeFake({
      repair_verify: (args) => (String(args.user).includes('王师傅仍然活着') || !String(args.user).includes('复活')) ? verdictConflict : verdictValid,
      repair_generate: JSON.stringify({ revised_text: '第3章 正文。王师傅仍然活着，他回到了青云镇。' }),
      repair_extract: JSON.stringify({
        events: [{ ops: [setOp(cell('character', '王师傅', 'alive'), true, { kind: 'value', value: false })], evidence: [{ quote: '王师傅仍然活着', narrative: 'present' }] }],
        assumptions: [],
      }),
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(started.ok, true);
    const view = await waitTerminal(workId, started.run.id);
    assert.equal(view.run.status, 'needs_review', `根锁必须硬停：${view.run.status}`);
    const step = view.steps.find((s) => Number(s.chapter_id) === Number(c3));
    assert.equal(step.status, 'needs_review');
    assert.equal((step.result.attempts[0] || {}).reason, 'ROOT_LOCK_VIOLATION', JSON.stringify(step.result.attempts));
    assert.equal(chapterRow(c3).content, baseText(3), '根锁失败不得写任何正文');
  }],

  ['AC-18：三次修订仍失败 → 有界停止（≤3 次），候选与问题保留', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 有界停止', 4);
    const [, c2, c3] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    let gen = 0;
    const fake = makeFake({
      repair_verify: verdictConflict,
      repair_generate: () => {
        gen += 1;
        if (gen === 1) return '不是 JSON';
        if (gen === 2) return JSON.stringify({ revised_text: '短' });
        return JSON.stringify({ revised_text: '第3章 正文。王师傅仍然活着，他回到了青云镇。' });
      },
      repair_extract: JSON.stringify({ events: [], assumptions: [] }),
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub', policy: { max_attempts_per_chapter: 3 } });
    assert.equal(started.ok, true);
    const view = await waitTerminal(workId, started.run.id);
    assert.equal(view.run.status, 'needs_review', `有界停止应停在 needs_review：${view.run.status}`);
    const step = view.steps.find((s) => Number(s.chapter_id) === Number(c3));
    assert.equal(step.status, 'needs_review');
    assert.equal(step.result.attempts.length, 3, JSON.stringify(step.result.attempts.map((a) => a.reason)));
    assert.equal(gen, 3, '生成调用不得超过 3 次');
    assert.equal(view.run.result.totals.repaired, 0);
    assert.equal(chapterRow(c3).content, baseText(3));
  }],

  ['AC-18/19：重复冲突指纹 → 提前停止，不空转烧调用', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 重复指纹', 4);
    const [, c2, c3] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    const fake = makeFake({
      repair_verify: verdictConflict,
      repair_generate: '不是 JSON（每次一样）',
      repair_extract: extractRepair,
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub', policy: { max_attempts_per_chapter: 3 } });
    const view = await waitTerminal(workId, started.run.id);
    assert.equal(view.run.status, 'needs_review');
    const step = view.steps.find((s) => Number(s.chapter_id) === Number(c3));
    assert.equal(step.result.attempts.length, 2, '相同指纹第二次出现即停止');
    assert.equal(chapterRow(c3).content, baseText(3));
  }],

  ['AC-19/21：token/调用预算与模型超时 → 明确暂停；恢复不重置已消耗预算并从断点继续', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 预算恢复', 4);
    const [, c2, c3, c4] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    let n = 0;
    const fake = makeFake({
      repair_verify: conflictOnly(c3),
      repair_generate: genRepairText,
      repair_extract: extractRepairFor,
      default: verdictValid,
    });
    const started = await Repair.startRepairRun({
      workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub',
      policy: { max_model_calls: 5, call_timeout_ms: 5000 },
    });
    const paused = await waitTerminal(workId, started.run.id);
    assert.equal(paused.run.status, 'paused', `预算上限必须明确暂停：${paused.run.status}`);
    assert.match(String(paused.run.result.halt.reason), /上限/);
    assert.equal(paused.run.result.checkpoint.last_chapter_id, c3, '断点必须落库（第 3 章已完成）');
    const step3Before = paused.steps.find((s) => Number(s.chapter_id) === Number(c3));
    assert.equal(step3Before.status, 'repaired');
    const callsBeforeResume = paused.run.result.totals.model_calls;
    assert.equal(callsBeforeResume >= 4, true, `调用计量必须落库：${callsBeforeResume}`);
    const resumed = await Repair.resumeRepairRun({ workId, runId: started.run.id, generate: fake, provider: 'fake', model: 'stub', extendCalls: 10 });
    assert.equal(resumed.ok, true, `恢复失败：${resumed.reason || ''}`);
    const done = await waitRun(workId, started.run.id, (r) => r.status === 'ready' || r.status === 'needs_review' || r.status === 'paused');
    assert.equal(done.run.status, 'ready', `恢复后未完成：${done.run.status} ${JSON.stringify(done.run.result.halt || null)}`);
    assert.equal(done.run.result.totals.model_calls > callsBeforeResume, true, '恢复后的累计调用必须包含恢复前的消耗（不重置）');
    const step3After = done.steps.find((s) => Number(s.chapter_id) === Number(c3));
    assert.equal(step3After.id, step3Before.id, '已完成章节不得重复执行（断点续跑）');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_state_events e JOIN story_chapter_revisions r ON r.id = e.revision_id WHERE r.chapter_id = ? AND r.origin_json LIKE ?', c3, '%repair%'), 1, '同一候选事件不得重复落库');
  }],

  ['AC-19：模型超时 → 如实停止（不显示为冲突为零 / 不冒充通过）', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 超时', 3);
    const [, c2, c3] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    const fake = makeFake({
      repair_verify: verdictConflict,
      repair_generate: () => new Promise(() => {}),
      repair_extract: extractRepair,
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub', policy: { max_attempts_per_chapter: 1, call_timeout_ms: 1000 } });
    const view = await waitTerminal(workId, started.run.id);
    assert.equal(view.run.status, 'needs_review', `超时必须明确停止：${view.run.status}`);
    const step = view.steps.find((s) => Number(s.chapter_id) === Number(c3));
    assert.equal(step.result.attempts[0].reason, 'PROVIDER_CALL_FAILED');
    assert.equal(String(step.result.attempts[0].detail).includes('MODEL_TIMEOUT'), true);
    assert.equal(chapterRow(c3).content, baseText(3));
  }],

  ['AC-20：取消时模型恰好返回 → 结果不提交；主稿不变；未采纳产物保留', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 生成后取消', 4);
    const [, c2, c3] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    let runId = '';
    const fake = makeFake({
      repair_verify: async (args) => {
        if (!String(args.user).includes('独自埋葬')) return verdictConflict;
        return verdictValid;
      },
      repair_generate: async () => {
        Repair.cancelRepairRun({ workId, runId, by: 'author' });
        return JSON.stringify({ revised_text: '第3章 正文。主角独自埋葬了王师傅，立誓查清死因，随后踏上归途。' });
      },
      repair_extract: extractRepair,
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    runId = started.run.id;
    const view = await waitTerminal(workId, runId);
    assert.equal(view.run.status, 'cancelled', `取消后必须停：${view.run.status}`);
    assert.equal(chapterRow(c3).content, baseText(3), '主稿不得被未采纳产物覆盖');
    const workingHead = Runs.getRun(runId).working_worldline_id;
    const wl = (await import('../../ai/story-state/temporal/worldline-store.mjs')).getWorldline(workingHead);
    assert.equal(String(wl.head_commit_id), String(started.run.base_commit_id), '取消后工作线不得再前进');
  }],

  ['AC-21：旧 worker 的 fencing token 回写被拒绝；取消/恢复后旧 token 失效', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 fencing', 4);
    const [, c2] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    const fake = makeFake({ default: verdictValid });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    const ready = await waitRun(workId, started.run.id, (r) => ['ready', 'needs_review', 'paused'].includes(r.status));
    assert.equal(ready.run.status, 'ready');
    const staleToken = ready.run.fencing_token;
    const lease = Runs.acquireLease({ runId: started.run.id, owner: 'new-worker' });
    assert.equal(lease.ok, true);
    assert.notEqual(lease.fencing_token, staleToken, '新 worker 必须拿到新的 fencing token');
    assert.throws(() => Repair.assertFence({ runId: started.run.id, fencingToken: staleToken }), /FENCED/);
    const staleDrive = await Repair.driveRepairRun({ runId: started.run.id, owner: 'stale-worker', generate: fake, fencingToken: staleToken });
    assert.equal(staleDrive.ok, false);
    assert.match(String(staleDrive.reason), /FENCED/);
    assert.equal(Runs.getRun(started.run.id).status, 'ready', '旧 worker 不得改写运行状态');
    Runs.releaseLease(started.run.id);
  }],

  ['AC-23：作者中途修改后文 → 候选判 stale（暂停），不得覆盖新编辑', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 中途编辑', 4);
    const [, c2, c3, c4] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    const editedText = '<p>第4章 作者中途改写的新正文。</p>';
    let injected = false;
    const fake = makeFake({
      repair_verify: async (args) => {
        if (!injected) {
          injected = true;
          db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(editedText, c4);
          await sleep0();
          T.recordContentSave({ workId, chapterId: c4, contentHtml: editedText, origin: { kind: 'editor_save' } });
        }
        return verdictValid;
      },
      repair_generate: JSON.stringify({ revised_text: '第3章 正文。主角独自埋葬了王师傅，立誓查清死因，随后踏上归途。' }),
      repair_extract: extractRepair,
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    const view = await waitTerminal(workId, started.run.id);
    assert.equal(view.run.status, 'paused', `未确认新正文必须暂停：${view.run.status}`);
    assert.match(String(view.run.result.halt.reason), /未确认的新正文/);
    assert.equal(chapterRow(c4).content, editedText, '绝不覆盖作者新编辑');
    const step4 = view.steps.filter((s) => Number(s.chapter_id) === Number(c4)).pop();
    assert.equal(step4.status, 'blocked');
    assert.equal(step4.result.revision_unchanged, false);
    assert.equal(chapterRow(c3).content, baseText(3), '第 3 章候选也不得写正式正文');
  }],

  ['AC-24：运行期间正式主线前进（根变更/章序）→ 旧运行 stale；不能用过期基线继续或应用', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 基线过期', 4);
    const [c1, c2] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    let moved = false;
    const fake = makeFake({
      repair_verify: async () => {
        if (!moved) {
          moved = true;
          const text = '<p>第1章 正文（作者补充：主角在青云镇醒来）。</p>';
          db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(text, c1);
          const r = T.applyChapterEvents({ workId, chapterId: c1, source: 'author_correction', contentHtml: text, events: [{ ops: [setOp(cell('character', '主角', 'location'), '青云镇')], evidence: [{ quote: '主角在青云镇醒来', narrative: 'present' }] }] });
          assert.equal(r.ok, true, `主线前进失败：${r.reason}`);
        }
        return verdictValid;
      },
      repair_generate: '{}',
      repair_extract: extractRepair,
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    const view = await waitTerminal(workId, started.run.id);
    assert.equal(view.run.status, 'stale', `必须判 stale：${view.run.status}`);
    const resume = await Repair.resumeRepairRun({ workId, runId: started.run.id, generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(resume.ok, false);
    assert.match(String(resume.reason), /基线已过期|不可恢复/);
    const applyBlocked = Repair.applyRepairRun({ workId, runId: started.run.id, approvalId: '', hooks: testHooks() });
    assert.equal(applyBlocked.ok, false);
    assert.equal(chapterRow(chapterIds[2]).content, baseText(3), 'stale 运行不得写正文');
  }],

  ['AC-25：应用中途故障 → 正文/状态/HEAD/审批/outbox 全部回滚；重试成功', async () => {
    const { workId, chapterIds } = seedTemporalWork('T4 原子应用', 4);
    const [, c2, c3] = chapterIds;
    changeRootToDeath(workId, c2);
    const { approval } = startApprovalFor(workId, c2);
    const fake = makeFake({
      repair_verify: conflictOnly(c3),
      repair_generate: genRepairText,
      repair_extract: extractRepairFor,
    });
    const started = await Repair.startRepairRun({ workId, rootChapterId: c2, approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    const ready = await waitRun(workId, started.run.id, (r) => r.status === 'ready' || r.status === 'needs_review' || r.status === 'paused');
    assert.equal(ready.run.status, 'ready');
    const { approval: applyApproval } = applyApprovalFor(workId, started.run.id);
    const headBefore = T.ensureMainCommit(workId).id;
    const failingHooks = testHooks({ enqueueProjectionInTx: () => { throw new Error('注入故障：投影 outbox 写入失败'); } });
    const failed = Repair.applyRepairRun({ workId, runId: started.run.id, approvalId: applyApproval.id, hooks: failingHooks });
    assert.equal(failed.ok, false);
    assert.match(String(failed.reason), /注入故障/);
    assert.equal(chapterRow(c3).content, baseText(3), '失败必须回滚正文');
    assert.equal(T.ensureMainCommit(workId).id, headBefore, '失败必须回滚 HEAD');
    assert.equal(Approvals.getApproval(applyApproval.id).status, 'active', '失败必须回滚审批消费');
    assert.equal(Runs.getRun(started.run.id).status, 'ready', '失败后运行保持 ready 可重试');
    assert.equal(countOf('SELECT COUNT(*) n FROM chapter_save_versions WHERE chapter_id = ?', c3), 0, '失败不得留下半套版本备份');
    const retry = Repair.applyRepairRun({ workId, runId: started.run.id, approvalId: applyApproval.id, hooks: testHooks() });
    assert.equal(retry.ok, true, `重试失败：${retry.reason || ''}`);
    assert.equal(chapterRow(c3).content, repairHtml(c3));
    assert.equal(Approvals.getApproval(applyApproval.id).status, 'consumed');
  }],

  ['AC-21/22：审批消费失败不建档、不消费无关审批；跨作品/跨范围一律拒绝', async () => {
    const a = seedTemporalWork('T4 审批失败-A', 4);
    const b = seedTemporalWork('T4 审批失败-B', 4);
    changeRootToDeath(a.workId, a.chapterIds[1]);
    const fake = makeFake({ default: verdictValid });
    const noApproval = await Repair.startRepairRun({ workId: a.workId, rootChapterId: a.chapterIds[1], approvalId: '', generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(noApproval.ok, false);
    assert.equal(noApproval.decision, 'rejected');
    assert.equal(countOf('SELECT COUNT(*) n FROM story_repair_runs WHERE work_id = ?', a.workId), 0, '审批失败不得留下运行');
    const { approval } = startApprovalFor(a.workId, a.chapterIds[1]);
    const crossWork = await Repair.startRepairRun({ workId: b.workId, rootChapterId: b.chapterIds[1], approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(crossWork.ok, false);
    assert.equal(Approvals.getApproval(approval.id).status, 'active', '跨作品失败不得消费有效审批');
    const crossScope = await Repair.startRepairRun({ workId: a.workId, rootChapterId: a.chapterIds[2], approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(crossScope.ok, false);
    assert.equal(Approvals.getApproval(approval.id).status, 'active', '范围不符不得消费有效审批');
    const okStart = await Repair.startRepairRun({ workId: a.workId, rootChapterId: a.chapterIds[1], approvalId: approval.id, generate: fake, provider: 'fake', model: 'stub' });
    assert.equal(okStart.ok, true);
    assert.equal(Approvals.getApproval(approval.id).status, 'consumed');
    await waitTerminal(a.workId, okStart.run.id);
    const applyWithout = Repair.applyRepairRun({ workId: a.workId, runId: okStart.run.id, approvalId: '', hooks: testHooks() });
    assert.equal(applyWithout.ok, false);
    assert.equal(String(applyWithout.code), 'not_found');
    assert.equal(Runs.getRun(okStart.run.id).status, 'ready', '应用审批失败不得改变候选状态');
  }],
]);