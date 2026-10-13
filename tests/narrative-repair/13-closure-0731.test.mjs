/**
 * tests/narrative-repair/13-closure-0731.test.mjs
 * 《0731 号觉醒日：审稿—局部修稿闭环增补方案》T31/T32/T34/T35/T36/T37 的回归断言。
 *
 * 范围声明（用户 2026-10-12 裁决，明确排除 T33）：
 *   T33 要求 `reason_unverified` / `explanation_mismatch`，而现行补丁协议 v2 的 patch 载荷
 *   **没有 `reason` 字段**（只有 dispositions 有）。实现它必须先给协议加字段 = 契约变更，
 *   本轮**不做**。所以本套件不覆盖 T33 —— 这是显式范围，不是遗漏。
 *
 * 本套件补的是"授权身份"与"安全失效姿态"两类跨模块行为：
 *   T31/T32 同一问题在排序/刷新/重试后必须仍是同一个 immutable id（不能重新编号）；
 *   T34     选中 issue 甲、模型却改未授权的句 B → out_of_scope 且原文逐字不变；
 *   T35     计划不可用 / 同一 exact quote 出现两处 → needs_scope / ambiguous_anchor，不放宽到整章；
 *   T36     issue 在已选集合里、但 span 属于**另一个** issue → 仍必须拒绝（"选中 ≠ 授权"）；
 *   T37     安全引擎缺失/抛异常 → safety_unavailable 且原文逐字不变（fail-closed）。
 *
 * ⚠️ 计划模块的定位契约：授权跨度由 `findings[].text` 里的**引号片段**决定
 *    （`「…」`），而不是由调用方直接给 span；Host 给出唯一 `span_id` 时才允许覆盖。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();
await import(new URL('../../public/revision-plan.js', import.meta.url).href);
const PL = globalThis.NovelRevisionPlan;

const V2 = (snapshot, patches, extra = {}) => JSON.stringify({
  schema_version: 2, snapshot_id: snapshot.snapshot_id, base_hash: snapshot.body_hash, patches, ...extra,
});
const P = (span, op, original, replacement, issueIds = ['q1'], patchId = 'p1') => ({
  patch_id: patchId, group_id: patchId, issue_ids: issueIds, span_id: span.span_id, op, original, replacement,
});
const spanOf = (text, s) => RP.buildSpans(text, { sentences: true }).find((x) => x.text === s);
/** 与 app.js/revisionPlanFor 同一口径：稳定编号按"作者看到的清单"给定，不按勾选顺序重编。 */
const buildPlan = (snap, ids, texts) => PL.buildRevisionPlan({
  snapshot: snap,
  findings: ids.map((id, i) => ({ id: String(id), text: texts[i] })),
});

// ── T31：勾选集合的身份稳定（不重新编号）─────────────────────────────────────
// 事故形态：`selectedIssueIds = confirmed.map((_,i)=>String(i+1))` —— 先选择再编号，
// 于是只勾原 #3/#7 会生成 #1/#2，重试/刷新后对不回同一份审稿报告。
{
  const body = '甲段里有一句话。\n\n乙段。\n\n丙段里也有一句话。';
  const snap = RP.snapshotOf(body, { chapter_id: 31 });
  const ids = ['3', '7'];
  const texts = ['「甲段里有一句话。」读起来重复，删掉', '「丙段里也有一句话。」同样重复'];
  const plan = buildPlan(snap, ids, texts);
  check('T31a 计划里的 issue_id 就是原始 immutable id（#3/#7，不被重编为 #1/#2）',
    plan.coverage.length === 2 && plan.coverage.map((c) => String(c.issue_id)).sort().join(',') === '3,7',
    JSON.stringify(plan.coverage.map((c) => c.issue_id)));

  const again = buildPlan(snap, ids, texts);
  check('T31b 同一勾选集合重算 → selection_hash 一致（重试/刷新可复用同一计划）',
    plan.selection_hash === again.selection_hash && !!plan.selection_hash,
    `${plan.selection_hash} / ${again.selection_hash}`);

  const reordered = buildPlan(snap, ['7', '3'], [texts[1], texts[0]]);
  check('T31c 勾选顺序不影响 selection_hash（按 id 排序取哈希）',
    reordered.selection_hash === plan.selection_hash,
    `${plan.selection_hash} / ${reordered.selection_hash}`);

  // 勾选集合变化 → 必须 stale（旧计划/旧候选不得复用）。
  const changed = buildPlan(snap, ['3'], [texts[0]]);
  check('T31d 勾选集合变化 → selection_hash 变化且旧计划被判 stale',
    changed.selection_hash !== plan.selection_hash
    && PL.isPlanStale(plan, { selectionHash: changed.selection_hash }).stale === true,
    `${plan.selection_hash} / ${changed.selection_hash}`);

  // 稳定编号必须原样进授权表（授权是按 issue_id 组织的）。
  const auth = PL.planAuthorization(plan);
  check('T31e 授权表按**稳定编号**组织（不是按勾选顺序的新序号）',
    !!auth && (auth.authorized['3'] !== undefined || auth.authorized['7'] !== undefined),
    JSON.stringify(Object.keys((auth && auth.authorized) || {})));
}

// ── T32：快照身份可追溯（不因清空 pendingReview 而丢失）──────────────────────
{
  const body = '甲段里有一句话。\n\n乙段。';
  const snap = RP.snapshotOf(body, { chapter_id: 32 });
  const plan = buildPlan(snap, ['5'], ['「甲段里有一句话。」重复']);
  check('T32a 计划携带可追溯快照身份（snapshot_id + base_hash 与快照一致）',
    !!plan.snapshot_id && !!plan.base_hash
    && plan.snapshot_id === snap.snapshot_id && plan.base_hash === snap.body_hash,
    JSON.stringify({ s: plan.snapshot_id, b: plan.base_hash }));
  const stale = PL.isPlanStale(plan, { snapshotId: RP.snapshotOf('甲段里有一句话。\n\n乙段改了。', { chapter_id: 32 }).snapshot_id });
  check('T32b 底稿变化 → 旧计划判 stale（不拿旧计划改新底稿）',
    stale.stale === true, JSON.stringify(stale));
  check('T32c 计划模块提供结构化的授权载体（planAuthorization 可导出可序列化授权表）',
    typeof PL.planAuthorization === 'function' && !!PL.planAuthorization(plan),
    `planAuthorization=${typeof PL.planAuthorization}`);
}

// ── T34：越权改未授权跨度 → out_of_scope 且原文逐字不变 ──────────────────────
{
  const body = '开头是浅蓝色的光。\n\n直播的声浪一层层矮下去。';
  const snap = RP.snapshotOf(body, { chapter_id: 34 });
  const s1 = spanOf(body, '开头是浅蓝色的光。');
  const s2 = spanOf(body, '直播的声浪一层层矮下去。');
  const authorization = {
    authorized: { 4: [{ span_id: s2.span_id, start: s2.start, end: s2.end, text: s2.text, ops: ['replace'] }] },
  };
  const attack = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 34, selectedIssueIds: ['4'], engine: K, authorization,
    raw: V2(snap, [P(s1, 'replace', '开头是浅蓝色的光。', '开头一片亮。', ['4'])], {
      dispositions: [{ issue_id: '4', status: 'patched', reason: '顺手改了开头' }],
    }),
  });
  check('T34a 选中 issue #4 但改动未授权的另一个跨度 → out_of_scope 且原文逐字不变',
    attack.ok === false && attack.error_code === 'out_of_scope' && attack.text === body,
    JSON.stringify({ ok: attack.ok, code: attack.error_code }));
  const pass = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 34, selectedIssueIds: ['4'], engine: K, authorization,
    raw: V2(snap, [P(s2, 'replace', '直播的声浪一层层矮下去。', '直播声浪矮了下去。', ['4'])], {
      dispositions: [{ issue_id: '4', status: 'patched', reason: '按授权收束' }],
    }),
  });
  check('T34b 对照：同一授权下改被授权的跨度 → 正常应用（排除"一律拒绝"的假绿）',
    pass.ok === true && pass.applied.length === 1, JSON.stringify({ ok: pass.ok, n: pass.applied.length }));
}

// ── T35：计划不可用/歧义 → 不放宽到整章 ─────────────────────────────────────
{
  const snap = RP.snapshotOf('同一句话在这里。\n\n同一句话在这里。', { chapter_id: 35 });
  const plan = buildPlan(snap, ['B'], ['「同一句话在这里。」重复了']);
  check('T35a 同一 exact quote 出现两处 → ambiguous_anchor，热点为 0（绝不默选第一处）',
    plan.coverage.length === 1 && plan.coverage[0].status === 'ambiguous_anchor' && plan.hotspots.length === 0,
    JSON.stringify(plan.coverage.map((c) => c.status)));
  check('T35b 歧义引用 → scope_incomplete=true（不得当成"整章可改"）',
    plan.scope_incomplete === true, String(plan.scope_incomplete));
  const miss = buildPlan(RP.snapshotOf('甲段。', { chapter_id: 35 }), ['C'], ['「这句不在正文里。」要删']);
  check('T35c 定位不到 → 不产生热点、不放宽到整章（如实举手）',
    miss.hotspots.length === 0 && miss.coverage[0].status !== 'planned',
    JSON.stringify({ hotspots: miss.hotspots.length, status: miss.coverage[0].status }));
}

// ── T36：issue 在已选集合里，但 span 属于另一个 issue → 仍拒绝 ────────────────
{
  const body = '第一句属于问题甲。\n\n第二句属于问题乙。';
  const snap = RP.snapshotOf(body, { chapter_id: 36 });
  const sA = spanOf(body, '第一句属于问题甲。');
  const sB = spanOf(body, '第二句属于问题乙。');
  const authorization = {
    authorized: {
      'J-甲': [{ span_id: sA.span_id, start: sA.start, end: sA.end, text: sA.text, ops: ['replace'] }],
      'J-乙': [{ span_id: sB.span_id, start: sB.start, end: sB.end, text: sB.text, ops: ['replace'] }],
    },
  };
  const crossed = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 36, selectedIssueIds: ['J-甲', 'J-乙'], engine: K, authorization,
    raw: V2(snap, [P(sB, 'replace', '第二句属于问题乙。', '第二句被改了。', ['J-甲'])], {
      dispositions: [{ issue_id: 'J-甲', status: 'patched', reason: '改到别人的跨度上' }],
    }),
  });
  check('T36a issue 在已选集合里、span 属另一 issue → 仍拒绝（选中≠授权）',
    crossed.ok === false && crossed.text === body
    && ['out_of_scope', 'authorization_mismatch', 'selection_mismatch'].includes(crossed.error_code || (crossed.errors && crossed.errors[0] && crossed.errors[0].code)),
    JSON.stringify({ ok: crossed.ok, code: crossed.error_code }));
  const right = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 36, selectedIssueIds: ['J-甲', 'J-乙'], engine: K, authorization,
    raw: V2(snap, [P(sA, 'replace', '第一句属于问题甲。', '第一句被改了。', ['J-甲'])], {
      dispositions: [{ issue_id: 'J-甲', status: 'patched', reason: '改自己的跨度' }],
    }),
  });
  check('T36b 对照：改自己获授权的跨度 → 放行',
    right.ok === true && right.applied.length === 1, JSON.stringify({ ok: right.ok, n: right.applied.length }));
}

// ── T37：安全引擎缺失/抛异常 → fail-closed（原文不变）────────────────────────
{
  const body = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(body, { chapter_id: 37 });
  const sp = spanOf(body, '甲段。');
  const raw = V2(snap, [P(sp, 'replace', '甲段。', '改过。', ['q1'])], {
    dispositions: [{ issue_id: 'q1', status: 'patched', reason: '正常改写' }],
  });
  const noEngine = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 37, engine: null });
  check('T37a 安全引擎缺失 → safety_unavailable 且不产出可应用候选（原文逐字不变）',
    noEngine.combined.status === 'safety_unavailable' && noEngine.verified === false
    && noEngine.text === body && noEngine.applied.length === 0,
    JSON.stringify({ s: noEngine.combined.status, applied: noEngine.applied.length }));
  const boom = {
    HARD_CODES: K.HARD_CODES, paragraphsOf: K.paragraphsOf,
    deletionRisks: () => { throw new Error('boom'); }, verifyPatchedText: () => { throw new Error('boom'); },
  };
  const threw = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 37, engine: boom });
  check('T37b 安全引擎抛异常 → safety_unavailable 且原文逐字不变（异常不得变成放行）',
    threw.combined.status === 'safety_unavailable' && threw.text === body && threw.applied.length === 0,
    JSON.stringify({ s: threw.combined.status, applied: threw.applied.length }));
  const malformed = {
    HARD_CODES: K.HARD_CODES, paragraphsOf: K.paragraphsOf,
    verifyPatchedText: () => ({ findings: 'not-an-array' }), deletionRisks: () => 'not-an-array',
  };
  const bad = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 37, engine: malformed });
  check('T37c 安全引擎返回畸形结果 → 不冒充"已验证"',
    bad.verified === false && bad.combined.status !== 'ok', String(bad.combined.status));
}

finish('13-closure-0731');
