/**
 * tests/narrative-repair/19-partial-repair-entry.test.mjs —— 《逐项验收卡死》方案 A/B1/C1 的离线断言。
 *
 * 这套断言回答的问题不是"写得好不好"，而是**界面会不会把作者锁在中间**：
 *   · 判"只解决局部"之后，除了合并/导出/返回，是否真的还有"再修"的路；
 *   · 这条路能不能被轮次/预算/硬阻塞项挡住（挡住时必须说清原因，而不是给个点不动的按钮）；
 *   · 「再修」与自动复修是不是同一套判据（各写一套必然一个说能修、一个说不能）；
 *   · 复验额度是否按候选版本给（改过候选就能验，同一份不重复付费）；
 *   · 「接受遗留」是否只记账、不冒充通过。
 *
 * 夹具是脱敏最小复现（R-0005 全篇同一句式 / R-0006 结构收尾 / R-0007 蓝图冲突），零计费。
 */
import { createChecks } from './harness.mjs';

await import(new URL('../../public/revision-closure.js', import.meta.url).href);
await import(new URL('../../public/review-workspace.js', import.meta.url).href);

const CL = globalThis.NovelRevisionClosure;
const RW = globalThis.NovelRevisionWorkspace;
const { check, finish } = createChecks();

check('V00', '判据模块与工作区模块都已加载（UMD 挂到 globalThis）',
  !!CL && !!RW && typeof CL.targetedRepairOf === 'function' && typeof RW.actionsOf === 'function',
  `CL=${!!CL} RW=${!!RW}`);

// ── 夹具：一次"已复验、仍有未通过项"的终审行 ─────────────────────────────────
const ROWS = [
  { issue_id: 'R-0001', final_status: 'ISSUE_VERIFIED', verdict: 'pass', semantic_status: 'pass' },
  { issue_id: 'R-0005', final_status: 'PARTIAL', verdict: 'partial', semantic_status: 'partial' },
  { issue_id: 'R-0006', final_status: 'UNRESOLVED', verdict: 'fail', semantic_status: 'fail' },
  { issue_id: 'R-0007', final_status: 'CANON_CONFLICT', verdict: 'fail', semantic_status: 'blocked', reason_code: 'CANON_CONFLICT' },
];
const SEMANTIC = {
  'R-0005': { status: 'partial', reason_code: 'MULTI_SPAN_REMAINS', remaining_evidence: ['不是……而是', '与其说……不如说'] },
  'R-0006': { status: 'fail', reason_code: 'STRUCTURAL_TAIL', remaining_evidence: ['三段无信息日常收尾'] },
  'R-0007': { status: 'blocked', reason_code: 'CANON_CONFLICT', remaining_evidence: [] },
};
const allowed = ['R-0001', 'R-0005', 'R-0006', 'R-0007'];

const plan = CL.targetedRepairOf({
  rows: ROWS, semanticByIssue: SEMANTIC, roundsUsed: 0, maxRounds: 2,
  budgetCents: 200, estimateCents: 5, allowedIssueIds: allowed,
});

check('V01', 'PARTIAL 与 UNRESOLVED 都进入复修目标（部分修复不是"没人管"）',
  plan.ok === true && plan.targets.includes('R-0005') && plan.targets.includes('R-0006'),
  `targets=${JSON.stringify(plan.targets)}`);
check('V02', '蓝图冲突不进自动复修，且被标成"人处理项"',
  !plan.targets.includes('R-0007') && plan.blocked.some((b) => b.issue_id === 'R-0007' && b.hard === true),
  `blocked=${JSON.stringify(plan.blocked.map((b) => b.issue_id + ':' + b.hard))}`);
check('V03', '复验留下的"还在的文字"被带进规划（复修不再重放同一跨度）',
  (plan.remaining_evidence['R-0005'] || []).length === 2 && (plan.remaining_evidence['R-0006'] || []).length === 1,
  `R-0005=${(plan.remaining_evidence['R-0005'] || []).length} 处`);

// ── 额度/轮次/预算的守卫 ───────────────────────────────────────────────────
const noRounds = CL.targetedRepairOf({
  rows: ROWS, semanticByIssue: SEMANTIC, roundsUsed: 2, maxRounds: 2,
  budgetCents: 200, estimateCents: 5, allowedIssueIds: allowed,
});
check('V04', '轮次用尽 → ROUND_LIMIT（不无限重试）', noRounds.ok === false && noRounds.reason === 'ROUND_LIMIT', String(noRounds.reason));

const overBudget = CL.targetedRepairOf({
  rows: ROWS, semanticByIssue: SEMANTIC, roundsUsed: 0, maxRounds: 2,
  budgetCents: 3, estimateCents: 40, allowedIssueIds: allowed,
});
check('V05', '预估超预算 → BUDGET_EXCEEDED（不静默超支）', overBudget.ok === false && overBudget.reason === 'BUDGET_EXCEEDED', String(overBudget.reason));

const unknownCost = CL.targetedRepairOf({
  rows: ROWS, semanticByIssue: SEMANTIC, roundsUsed: 0, maxRounds: 2,
  budgetCents: 200, estimateCents: null, costKnown: false, allowedIssueIds: allowed,
});
check('V06', '费用不可核价 → COST_UNKNOWN（"大概不到 2 元"不是授权）', unknownCost.ok === false && unknownCost.reason === 'COST_UNKNOWN', String(unknownCost.reason));

const outOfScope = CL.targetedRepairOf({
  rows: ROWS, semanticByIssue: SEMANTIC, roundsUsed: 0, maxRounds: 2,
  budgetCents: 200, estimateCents: 5, allowedIssueIds: ['R-0001'],
});
check('V07', '不在本轮勾选范围的问题不得被复修（不扩授权）', outOfScope.ok === false && outOfScope.reason === 'NO_TARGETS', String(outOfScope.reason));

// ── 底栏动作：卡死状态必须真的有出口 ───────────────────────────────────────
const repair = {
  ...plan, roundsLeft: 2, budgetLeftCents: 200, estimateCents: 5,
  // 复验指出"还在的文字"（B1）：只有这一类来源时也要给出扩范围入口。
  widening: { any: true, ids: ['R-0005', 'R-0006'], approvedIds: [], remainingIds: ['R-0005', 'R-0006'], paragraphs: 0, chars: 0 },
};
const leftovers = { ids: ['R-0005', 'R-0006', 'R-0007'], pending: ['R-0005', 'R-0006'], canon: ['R-0007'] };
const actions = RW.actionsOf({ stage: 'PARTIAL_CANDIDATE', rows: ROWS, repair, leftovers });
const byAction = (name) => actions.find((a) => a.action === name) || null;

check('V08', 'PARTIAL_CANDIDATE 底栏出现「只复修未通过项」（不再是死路）',
  !!byAction('repair-partial') && !byAction('repair-partial').disabled,
  `actions=${JSON.stringify(actions.map((a) => a.action))}`);
check('V09', '按钮写明条数与"一次付费调用"',
  /2 条/.test(byAction('repair-partial').label) && /一次付费调用/.test(byAction('repair-partial').label),
  byAction('repair-partial').label);
check('V10', '存在扩范围来源时出现「扩范围再修」（B1，且只在有来源时出现）',
  !!byAction('repair-partial-widened') && /扩范围再修/.test(byAction('repair-partial-widened').label),
  byAction('repair-partial-widened') && byAction('repair-partial-widened').label);
check('V11', '合并按钮仍然存在（复修不是唯一出口）',
  !!byAction('merge-partial') && /仍有 3 条未通过/.test(byAction('merge-partial').label),
  byAction('merge-partial') && byAction('merge-partial').label);
check('V12', '提供「接受 N 条为已知遗留」（C1：如实收工，不冒充通过）',
  !!byAction('accept-leftovers') && /2 条/.test(byAction('accept-leftovers').label),
  byAction('accept-leftovers') && byAction('accept-leftovers').label);

const noWiden = RW.actionsOf({
  stage: 'PARTIAL_CANDIDATE', rows: ROWS,
  repair: { ...plan, remaining_evidence: {}, roundsLeft: 2, budgetLeftCents: 200, estimateCents: 5 },
  leftovers,
});
check('V13', '没有剩余证据时不出现"扩范围"按钮（不给没有依据的动作）',
  !noWiden.some((a) => a.action === 'repair-partial-widened'),
  JSON.stringify(noWiden.map((a) => a.action)));

const poor = RW.actionsOf({
  stage: 'PARTIAL_CANDIDATE', rows: ROWS,
  repair: { ...plan, roundsLeft: 2, budgetLeftCents: 3, estimateCents: 40 },
  leftovers,
});
const poorBtn = poor.find((a) => a.action === 'repair-partial');
check('V14', '预算不够时按钮置灰并写明原因（不给"点了没反应"）',
  !!poorBtn && poorBtn.disabled === true && /超出剩余/.test(poorBtn.note || ''),
  poorBtn && poorBtn.note);

const hardOnly = RW.actionsOf({
  stage: 'PARTIAL_CANDIDATE', rows: [ROWS[0], ROWS[3]],
  repair: { ok: false, reason: 'NO_TARGETS', targets: [], blocked: [{ issue_id: 'R-0007', hard: true }] },
  leftovers: { ids: ['R-0007'], pending: ['R-0007'], canon: ['R-0007'] },
});
const hardBtn = hardOnly.find((a) => a.action === 'repair-partial');
check('V15', '全是人处理项时按钮置灰并说明"自动复修不得碰"',
  !!hardBtn && hardBtn.disabled === true && /人处理项/.test(hardBtn.note || ''),
  hardBtn && hardBtn.note);

const blocker = RW.blockerText({ stage: 'PARTIAL_CANDIDATE', rows: ROWS, repair, leftovers });
check('V16', '底部阻塞文案给出下一步（"可只复修 N 条"），而不只是报未通过',
  /只复修未通过项/.test(blocker) && /R-0005/.test(blocker),
  blocker);

const blockerNoRepair = RW.blockerText({
  stage: 'PARTIAL_CANDIDATE', rows: [ROWS[0], ROWS[3]],
  repair: { ok: false, reason: 'NO_TARGETS', targets: [], blocked: [{ issue_id: 'R-0007', hard: true }] },
  leftovers: { ids: ['R-0007'], pending: ['R-0007'], canon: ['R-0007'] },
});
check('V17', '不能复修时文案改成"需要人工处理或放宽授权"，不假装有路',
  /人工处理/.test(blockerNoRepair) && !/已记为已知遗留/.test(blockerNoRepair),
  blockerNoRepair);

// ── 复验额度：按候选版本给，而不是全局一次 ─────────────────────────────────
const a1 = CL.verifyAllowanceOf({ candidateHash: 'h1', verifiedHashes: [] });
const a2 = CL.verifyAllowanceOf({ candidateHash: 'h1', verifiedHashes: ['h1'] });
const a3 = CL.verifyAllowanceOf({ candidateHash: 'h2', verifiedHashes: ['h1'] });
const a4 = CL.verifyAllowanceOf({ candidateHash: 'h1', verifiedHashes: ['h1'], mergedAt: true, reverifiedAfterMerge: false });
const a5 = CL.verifyAllowanceOf({ candidateHash: '', verifiedHashes: [] });
check('V18', '未验过的候选允许验；同一份候选不重复付费',
  a1.ok === true && a2.ok === false && a2.code === 'ALREADY_VERIFIED_THIS_CANDIDATE',
  `a1=${a1.code} a2=${a2.code}`);
check('V19', '改过候选（hash 变化）自动重开一次额度',
  a3.ok === true && a3.code === 'NEW_CANDIDATE', a3.code);
check('V20', '合并后补跑一次仍允许（2026-10-18 作者要求的反悔机会）', a4.ok === true && a4.code === 'POST_MERGE_RETRY', a4.code);
check('V21', '拿不到候选 hash 时 fail-closed（不放行付费验证）', a5.ok === false && a5.code === 'NO_CANDIDATE_HASH', a5.code);

// ── 已知遗留：只记账 ───────────────────────────────────────────────────────
const left1 = CL.acceptedLeftoversOf({ rows: ROWS, acceptedIds: [] });
const left2 = CL.acceptedLeftoversOf({ rows: ROWS, acceptedIds: ['R-0005'] });
check('V22', '遗留清单只含未通过项，且记住"哪些已经接受过"',
  left1.ids.length === 3 && left2.pending.length === 2 && !left2.pending.includes('R-0005'),
  `ids=${left1.ids.join(',')} pending=${left2.pending.join(',')}`);
check('V23', '接受遗留不改变任何终态（它不是"通过"）',
  ROWS.every((r) => typeof r.final_status === 'string') && left2.count === 3,
  `count=${left2.count}`);

// ── 轮次/花费跨轮累计：按钮可以点多次，上限不能被"重新数"绕开 ─────────────
const r1 = { rounds: [{ round: 1, status: 'applied' }], spent_cents: 5 };
const r2 = { rounds: [{ round: 1, status: 'applied' }], spent_cents: 7 };
const mergedRounds = CL.mergeRepairRounds(r1, r2);
check('V24', '第二轮复修的轮次与花费接到上一轮后面（不重置）',
  mergedRounds.rounds.length === 2 && mergedRounds.spent_cents === 12 && CL.roundsUsedOf(mergedRounds) === 2,
  `rounds=${mergedRounds.rounds.length} spent=${mergedRounds.spent_cents}`);
check('V25', '累计满 2 轮后，再算一次复修必须 ROUND_LIMIT（不能靠再点一次重置上限）',
  CL.targetedRepairOf({
    rows: ROWS, semanticByIssue: SEMANTIC, roundsUsed: CL.roundsUsedOf(mergedRounds),
    maxRounds: 2, budgetCents: 200, estimateCents: 5, allowedIssueIds: allowed,
  }).reason === 'ROUND_LIMIT',
  '累计 2 轮 → ROUND_LIMIT');
check('V26', '没有新一轮时返回上一轮（不把已有轮次抹成空）',
  CL.mergeRepairRounds(r1, null) === r1 && CL.mergeRepairRounds(null, r2).rounds.length === 1,
  'merge(prior,null)=prior');

// ── 合并后的诚实说法：部分合并 ≠ 未做语义复验 ─────────────────────────────
const partialLabel = RW.STAGE_LABEL.PERSISTED_PARTIAL;
check('V27', '部分合并有独立档位："已合并 · 仍带未通过项"（不能说成"未做语义复验"）',
  !!partialLabel && /仍带未通过项/.test(partialLabel.text) && partialLabel.tone === 'warn',
  partialLabel && partialLabel.text);

const partialStage = RW.stagesOf({ rows: ROWS, stage: 'PERSISTED_PARTIAL', patchedCount: 2 });
check('V28', '部分合并算"已进入审阅与合并"这一步（流程导航不倒退）',
  partialStage[3] && partialStage[3].state === 'done',
  JSON.stringify(partialStage.map((s) => s.id + ':' + s.state)));

const partialBlocker = RW.blockerText({ stage: 'PERSISTED_PARTIAL', rows: ROWS });
check('V29', '部分合并的底部说明点出未通过编号与"重新审稿/回退"两条路',
  /#R-0005/.test(partialBlocker) && /重新审稿/.test(partialBlocker) && /历史版本/.test(partialBlocker),
  partialBlocker);

const partialActions = RW.actionsOf({ stage: 'PERSISTED_PARTIAL', rows: ROWS, archiveCount: 1 });
check('V30', '部分合并后仍能补跑一次复验或回退（不是死路）',
  partialActions.some((a) => a.action === 'semantic-verify') && partialActions.some((a) => a.action === 'archive'),
  JSON.stringify(partialActions.map((a) => a.action)));

// ── B2：跨段授权（3 段 / 600 字 / 保护区）──────────────────────────────
const P = (n, text) => ({ span_id: `p${n}`, start: (n - 1) * 100, end: (n - 1) * 100 + text.length, text });
const twoParas = [P(5, '车还在往前开。'), P(6, '明早七点前，那套卷子还等着他。')];
const ok2 = CL.wideningApprovalOf({ paragraphs: twoParas });
check('V31', '批准 2 段（在 3 段 / 600 字内）被接受，并返回实际段数与字数',
  ok2.ok === true && ok2.paragraphs === 2 && ok2.chars > 0, `${ok2.code} ${ok2.paragraphs} 段/${ok2.chars} 字`);

const four = CL.wideningApprovalOf({ paragraphs: [P(1, 'a段。'), P(2, 'b段。'), P(3, 'c段。'), P(4, 'd段。')] });
check('V32', '超过 3 段被拒（TOO_MANY_PARAGRAPHS）', four.ok === false && four.code === 'TOO_MANY_PARAGRAPHS', four.code);

const long = CL.wideningApprovalOf({ paragraphs: [P(1, '字'.repeat(400)), P(2, '字'.repeat(300))] });
check('V33', '超过 600 字被拒（TOO_MANY_CHARS），不静默截断', long.ok === false && long.code === 'TOO_MANY_CHARS', `${long.code} ${long.chars} 字`);

const guarded = CL.wideningApprovalOf({ paragraphs: [P(1, '我信A级存在。没说你。')], mustKeep: ['我信A级存在'] });
check('V34', '段落里含必须保留的内容 → PROTECTED（硬门禁不被段数上限绕过）',
  guarded.ok === false && guarded.code === 'PROTECTED', guarded.code);

const protectedSpan = CL.wideningApprovalOf({ paragraphs: [P(2, '这一段是作者锁定的保护区内容。')], protectedSpans: ['作者锁定的保护区'] });
check('V35', '段落落在保护区 → PROTECTED（与 must_keep 同一道门）',
  protectedSpan.ok === false && protectedSpan.code === 'PROTECTED', protectedSpan.code);

check('V36', '定位不到段落的空白范围被拒（NO_SPAN）',
  CL.wideningApprovalOf({ paragraphs: [{ span_id: 'p9', start: 5, end: 5, text: '' }] }).code === 'NO_SPAN',
  'NO_SPAN');

const src = CL.wideningSourcesOf({
  approved: { 'R-0006': { spans: twoParas, chars: 30, paragraphs: 2 } }, remaining: {},
});
const srcOnlyRemaining = CL.wideningSourcesOf({ approved: {}, remaining: { 'R-0005': ['不是……而是'] } });
const srcNone = CL.wideningSourcesOf({ approved: {}, remaining: {} });
check('V37', '扩范围来源：作者批准 / 复验剩余证据 各自独立，都没有时不给入口',
  src.any === true && src.paragraphs === 2 && srcOnlyRemaining.any === true && srcOnlyRemaining.paragraphs === 0 && srcNone.any === false,
  `approved=${src.paragraphs} remaining=${srcOnlyRemaining.ids.length} none=${srcNone.any}`);

const widenActions = RW.actionsOf({
  stage: 'PARTIAL_CANDIDATE', rows: ROWS,
  repair: { ...plan, roundsLeft: 2, budgetLeftCents: 200, estimateCents: 5, widening: src },
  leftovers,
});
const widenBtn = widenActions.find((a) => a.action === 'repair-partial-widened');
check('V38', '批准跨段后按钮变成「按已批准范围再修（N 段）」',
  !!widenBtn && /已批准范围再修/.test(widenBtn.label) && /2 段/.test(widenBtn.label),
  widenBtn && widenBtn.label);

check('V39', '多段批准的默认动作是 delete（逐段 replace 表达不了"三段合成一句"）；单段沿用原建议',
  CL.wideningOpFor({ paragraphs: 3, suggested: 'condense' }) === 'delete'
    && CL.wideningOpFor({ paragraphs: 1, suggested: 'condense' }) === 'condense'
    && CL.wideningOpFor({ paragraphs: 1, suggested: '' }) === 'replace',
  `3段=${CL.wideningOpFor({ paragraphs: 3, suggested: 'condense' })}`);

finish('逐项验收卡死出口（V00–V39）');
