/**
 * tests/narrative-repair/14-plan-coverage-0731.test.mjs
 * 《0731 号觉醒日：审稿—局部修稿闭环增补方案》§4 + §5 T41/T42/T43 的回归断言。
 *
 * 为什么单独一套（而不是塞进 13 号）：
 *   13 号管"授权身份 / 越权拒绝 / 安全失效姿态"这一类**跨度级**行为；本套件管
 *   "问题解决状态是否被如实报告"这一类**清单级**行为。两者失败时的排查方向不同。
 *
 * ⚠️ 编号冲突声明（不掩盖历史包袱）：`tests/narrative-repair/11-review-closure.test.mjs`
 *    里已有一对 `T41-a/T41-b`，讲的是 **condense 授权**，与本方案 §5 的 T41（时间指代复核）
 *    不是同一件事。本套件用的是本方案的编号与语义，两处不互相顶替。
 *
 * ⚠️ 状态名以真实实现为准：处置状态白名单是
 *    `patched / partially_resolved / keep / deferred / blocked`
 *    （`public/revision-patch.js` 的 `bad_disposition_status` 校验）。
 *    本方案 §4 提到的 `needs_temporal_review`、§4 提到的 `patch_count/resolved_issue_count`
 *    **在实现里不存在**，所以下面断言的是实现真实具备的字段（applied / coverage / unresolved），
 *    而不是为了对齐文档去发明字段 —— 那属于契约变更，本轮明确不做。
 */
import { createChecks, loadPublicModules } from './harness.mjs';
import { scanEditing } from '../../ai/editing/scan.mjs';

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
const buildPlan = (snap, ids, texts) => PL.buildRevisionPlan({
  snapshot: snap, findings: ids.map((id, i) => ({ id: String(id), text: texts[i] })),
});
/** 与 13 号同口径：授权表按 issue_id 组织，每条给出该 issue 获授权的确切跨度。 */
const authFor = (map) => ({
  authorized: Object.fromEntries(Object.entries(map).map(([id, spans]) => [
    id, spans.map((s) => ({ span_id: s.span_id, start: s.start, end: s.end, text: s.text, ops: ['replace'] })),
  ])),
});
const ruleIds = (scan) => scan.findings.map((f) => f.rule_id);

// ── T41：局部修完 ≠ 问题解决（时间指代没闭合就不能报 resolved）────────────────
{
  const body = '十点出头，他领了面包。\n\n中午前后，队伍散了。';
  const snap = RP.snapshotOf(body, { chapter_id: 41 });
  const s2 = spanOf(body, '中午前后，队伍散了。');
  const authorization = authFor({ R01: [s2] });
  // 模型只删掉了"中午前后"这个时间锚，但面包段落的位置**没动** ——
  // 后文若仍称"中午那个面包"，时间指代就没有闭合（本方案 R01 的实际形态）。
  const res = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 41, selectedIssueIds: ['R01'], engine: K, authorization,
    raw: V2(snap, [P(s2, 'replace', '中午前后，队伍散了。', '队伍散了。', ['R01'])], {
      dispositions: [{ issue_id: 'R01', status: 'partially_resolved', reason: '只去掉了时间词，面包段的位置按裁决未移动' }],
    }),
  });
  const cov = (res.coverage || []).find((c) => String(c.issue_id) === 'R01');
  check('T41a 模型声明"只解决局部" → 覆盖表如实报 partially_resolved，绝不升级成 patched',
    !!cov && cov.status === 'partially_resolved', JSON.stringify(cov));
  check('T41b 部分解决必须同时进 unresolved（作者能看见这条还没闭合）',
    (res.unresolved || []).some((u) => String(u.issue_id) === 'R01' && u.status === 'partially_resolved'),
    JSON.stringify(res.unresolved));
  check('T41c 有补丁真的落地了（证明 T41a 不是"补丁没应用"造成的假绿）',
    res.ok === true && res.applied.length === 1 && res.text !== body,
    JSON.stringify({ ok: res.ok, n: res.applied.length }));

  // 对照：同一句若声明 patched（已完整解决），覆盖表才允许显示 patched。
  const done = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 41, selectedIssueIds: ['R01'], engine: K, authorization,
    raw: V2(snap, [P(s2, 'replace', '中午前后，队伍散了。', '队伍散了。', ['R01'])], {
      dispositions: [{ issue_id: 'R01', status: 'patched', reason: '时间指代已闭合' }],
    }),
  });
  const cov2 = (done.coverage || []).find((c) => String(c.issue_id) === 'R01');
  check('T41d 对照：声明完整解决时才显示 patched（状态确实跟着声明走，不是永远报部分）',
    !!cov2 && cov2.status === 'patched', JSON.stringify(cov2));
}

// ── T42：同校/同名的字面重复 ≠ 事实重复，不得据此删除增量事实 ────────────────
{
  // 只出现两次的定位同一地名 —— 与作者复核稿里"两个 A 级都来自江陵三中"同形。
  const twice = '第一个A级是江陵三中的学生。\n\n第二个A级也是江陵三中的学生。';
  const scanTwice = scanEditing(twice, {});
  check('T42a 同一校名跨段出现两次 → 确定性层不产出 duplicate-sentence（不得据此删掉增量事实）',
    !ruleIds(scanTwice).includes('deterministic:duplicate-sentence'),
    JSON.stringify(ruleIds(scanTwice)));

  // 阳性对照：判据本身有效 —— 同一句在 3 段里逐字重复时照报。
  // ⚠️ 句子必须越过 `DUPLICATE_MIN_CHARS = 10`（去标点后计），否则被"太短是正常节奏"挡掉：
  //    第一版样本「他站在门口没有说话。」去标点只有 8 字 → 阳性对照自己变成了假阴性。
  const three = '他站在门口一直没有开口说话。\n\n他站在门口一直没有开口说话。\n\n他站在门口一直没有开口说话。';
  const scanThree = scanEditing(three, {});
  check('T42b 阳性对照：同一句在 3 段逐字重复 → 照报 duplicate-sentence（判据没被削弱）',
    ruleIds(scanThree).includes('deterministic:duplicate-sentence'),
    JSON.stringify(ruleIds(scanThree)));

  // 增量事实必须能在计划里作为独立问题被选中（不能因为字面相同而合并成一条）。
  const snap = RP.snapshotOf('第一个A级来自江陵三中。\n\n第二个A级也来自江陵三中。', { chapter_id: 42 });
  const plan = buildPlan(snap, ['R02', 'R02b'], [
    '「第一个A级来自江陵三中。」这句要保留，同校是新增事实',
    '「第二个A级也来自江陵三中。」这句是第二个人的增量信息，不得因字面重复删除',
  ]);
  check('T42c 增量事实以两条独立编号进计划（不被按字面重复折叠成一条）',
    plan.coverage.length === 2
    && plan.coverage.map((c) => String(c.issue_id)).sort().join(',') === 'R02,R02b',
    JSON.stringify(plan.coverage.map((c) => c.issue_id)));

  // 反向要求：不得靠"把重复那句删掉"来消灭报告。
  const s1 = spanOf('第一个A级来自江陵三中。\n\n第二个A级也来自江陵三中。', '第一个A级来自江陵三中。');
  const refusal = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 42, selectedIssueIds: ['R02'], engine: K,
    authorization: authFor({ R02: [s1] }),
    raw: V2(snap, [P(s1, 'replace', '第一个A级来自江陵三中。', '第一个A级来自江陵三中。', ['R02'])], {
      dispositions: [{ issue_id: 'R02', status: 'patched', reason: '去重' }],
    }),
  });
  check('T42d 字面重复不是可删除的理由：声明 patched 但没有真实改动 → 不冒充已解决',
    refusal.ok === false || (refusal.applied || []).length === 0,
    JSON.stringify({ ok: refusal.ok, n: (refusal.applied || []).length, code: refusal.error_code }));
}

// ── T43：keep / deferred 不得产生改章补丁；空口"已改"必须被点出 ───────────────
{
  const body = '结尾只有一次系统语音。';
  const snap = RP.snapshotOf(body, { chapter_id: 43 });
  const keepRun = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 43, selectedIssueIds: ['R08', 'R09'], engine: K,
    raw: V2(snap, [], {
      dispositions: [
        { issue_id: 'R08', status: 'keep', reason: '首章钩子要求末尾首次出声，保留' },
        { issue_id: 'R09', status: 'deferred', reason: '角色卡时点属跨作用域，不在本章处理' },
      ],
    }),
  });
  check('T43a keep/deferred 只登记状态，不产生任何改章补丁（原文逐字不变）',
    keepRun.text === body && (keepRun.applied || []).length === 0,
    JSON.stringify({ n: (keepRun.applied || []).length }));
  check('T43b keep/deferred 照实出现在覆盖表里（不因"没改"就从清单消失）',
    (keepRun.coverage || []).some((c) => String(c.issue_id) === 'R08' && c.status === 'keep')
    && (keepRun.coverage || []).some((c) => String(c.issue_id) === 'R09' && c.status === 'deferred'),
    JSON.stringify(keepRun.coverage));

  const liar = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 43, selectedIssueIds: ['R08'], engine: K,
    raw: V2(snap, [], { dispositions: [{ issue_id: 'R08', status: 'patched', reason: '已处理' }] }),
  });
  const cov = (liar.coverage || []).find((c) => String(c.issue_id) === 'R08');
  check('T43c 声称 patched 却没有任何对应补丁 → unaccounted 且 coverage_ok=false（不许只在嘴上改）',
    !!cov && cov.status === 'unaccounted' && liar.coverage_ok === false,
    JSON.stringify({ cov, ok: liar.coverage_ok }));
  check('T43d 无补丁可应用的运行里，原文保持逐字不变',
    liar.text === body, JSON.stringify({ same: liar.text === body }));
}

// ── §4 / §6.4：patch_count ≠ resolved_issue_count ────────────────────────────
{
  const body = '甲句需要改。\n\n乙句需要改。';
  const snap = RP.snapshotOf(body, { chapter_id: 44 });
  const sA = spanOf(body, '甲句需要改。');
  const sB = spanOf(body, '乙句需要改。');
  const res = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 44, selectedIssueIds: ['E1', 'E2'], engine: K,
    authorization: authFor({ E1: [sA], E2: [sB] }),
    raw: V2(snap, [
      P(sA, 'replace', '甲句需要改。', '甲句改好了。', ['E1'], 'p1'),
      P(sB, 'replace', '乙句需要改。', '乙句只改了一半。', ['E2'], 'p2'),
    ], {
      dispositions: [
        { issue_id: 'E1', status: 'patched', reason: '完整解决' },
        { issue_id: 'E2', status: 'partially_resolved', reason: '只改了前半句' },
      ],
    }),
  });
  check('T44a 两条补丁落地 ≠ 两个问题解决：applied=2 而只有 1 条 patched',
    res.ok === true && res.applied.length === 2
    && (res.coverage || []).filter((c) => c.status === 'patched').length === 1
    && (res.coverage || []).filter((c) => c.status === 'partially_resolved').length === 1,
    JSON.stringify({ applied: res.applied.length, coverage: res.coverage }));
  check('T44b 补丁条数与"已解决数"必须能分开读（不把 patch 数直接当解决数）',
    res.applied.length !== (res.coverage || []).filter((c) => c.status === 'patched').length,
    JSON.stringify({ applied: res.applied.length, patched: (res.coverage || []).filter((c) => c.status === 'patched').length }));
  check('T44c 部分解决的那条留在 unresolved 里（不因有 diff 就被算作完成）',
    (res.unresolved || []).some((u) => String(u.issue_id) === 'E2'),
    JSON.stringify(res.unresolved));

  // 阴性对照：只勾了一个问题、也只改了一个问题 → 两者相等，说明 T44b 不是恒真断言。
  const one = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 44, selectedIssueIds: ['E1'], engine: K,
    authorization: authFor({ E1: [sA] }),
    raw: V2(snap, [P(sA, 'replace', '甲句需要改。', '甲句改好了。', ['E1'], 'p1')], {
      dispositions: [{ issue_id: 'E1', status: 'patched', reason: '完整解决' }],
    }),
  });
  check('T44d 阴性对照：一对一（1 补丁 / 1 解决）时两者相等，证明区分逻辑不是恒不相等',
    one.applied.length === 1
    && (one.coverage || []).filter((c) => c.status === 'patched').length === 1,
    JSON.stringify({ applied: one.applied.length, coverage: one.coverage }));
}

// ── §4 修后核验：issue_coverage 候选（"声称改了，但证据还在"）─────────────────
{
  const REVISED = '队伍散了。\n\n没人再看他，他收起号码纸。';
  const cov = (id, status) => ({ issue_id: id, status, reason: '' });

  // 正例：覆盖表说 R05 已处理，而它当初的逐字证据仍在修后正文里。
  const hit = RP.issueCoverageCandidates({
    issues: [{ id: 'R05', quotes: ['假装没看见'] }, { id: 'R06', quotes: ['攥成一团，再塞回兜里。'] }],
    coverage: [cov('R05', 'patched'), cov('R06', 'patched')],
    revisedText: '没人再看他，还是有人小声说“假装没看见”。',
  });
  check('IC-a 覆盖表说 patched、而该问题的逐字证据在修后正文里仍在 → 产出 issue_coverage 候选',
    hit.count === 1 && hit.candidates[0].issue_id === 'R05',
    JSON.stringify(hit.candidates.map((c) => c.issue_id)));

  // 阴性对照①：证据确实已不在 → 不产出（否则这条判据恒真）。
  const gone = RP.issueCoverageCandidates({
    issues: [{ id: 'R05', quotes: ['假装没看见'] }],
    coverage: [cov('R05', 'patched')],
    revisedText: REVISED,
  });
  check('IC-b 阴性对照：证据已从修后正文消失 → 不产出候选（判据不是恒真）',
    gone.count === 0, JSON.stringify(gone.candidates));

  // 阴性对照②：短证据句（< 6 字）在章内反复出现属正常节奏，不得拿它当"问题仍在"。
  const short = RP.issueCoverageCandidates({
    issues: [{ id: 'q1', quotes: ['嗯。'] }],
    coverage: [cov('q1', 'patched')],
    revisedText: '嗯。他应了一声。',
  });
  check('IC-c 阴性对照：过短证据（"嗯。"）不算"问题仍在"，避免持续误报',
    short.count === 0, JSON.stringify(short.candidates));

  // 阴性对照③：keep / deferred 的条目不参与（它们本来就不该被改）。
  const kept = RP.issueCoverageCandidates({
    issues: [{ id: 'R08', quotes: ['假装没看见'] }],
    coverage: [cov('R08', 'keep'), cov('R09', 'deferred')],
    revisedText: '还是有人小声说“假装没看见”。',
  });
  check('IC-d 阴性对照：keep / deferred 的条目不做覆盖核验（它们本就不该被改）',
    kept.count === 0, JSON.stringify(kept.candidates));

  // 阴性对照④：没有逐字引用（旧格式审稿）时如实"没做这项核验"，不伪造结论。
  const noQuote = RP.issueCoverageCandidates({
    issues: [{ id: 'q1', quotes: [] }],
    coverage: [cov('q1', 'patched')],
    revisedText: '随便一段文字。',
  });
  check('IC-e 没有逐字引用（旧格式审稿）→ 候选为空，如实表示"这项核验没做成"',
    noQuote.count === 0, JSON.stringify(noQuote.candidates));

  // 管线集成：runRevisionPipeline 接收 issueQuotes 并把结论带进结果。
  const body = '他把号码纸攥成一团，再塞回兜里。';
  const snap = RP.snapshotOf(body, { chapter_id: 62 });
  const sp = RP.buildSpans(body, { sentences: true }).find((s) => s.text.includes('号码纸'));
  const auth = { authorized: { q1: [{ span_id: sp.span_id, start: sp.start, end: sp.end, text: sp.text, ops: ['replace'] }] } };
  const raw = JSON.stringify({
    schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
    patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: ['q1'], span_id: sp.span_id, op: 'replace', original: sp.text, replacement: sp.text.replace('再塞回兜里。', '塞回兜里。') }],
    dispositions: [{ issue_id: 'q1', status: 'patched', reason: '收束为一次' }],
  });
  const run2 = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 62, selectedIssueIds: ['q1'], engine: K, authorization: auth, raw,
    // ⚠️ 样本必须选**补丁没动**的那句：第一版拿了被补丁替换掉的「再塞回兜里。」当证据，
    //    它在修后正文里当然不存在，断言于是错误地期望命中（判据本身是对的）。
    issueQuotes: [{ id: 'q1', quotes: ['号码纸攥成一团'] }],
  });
  check('IC-f 管线把 issue_coverage 带进结果（未改动的证据句仍在 → 候选 1 条）',
    run2.issue_coverage && run2.issue_coverage.count === 1,
    JSON.stringify(run2.issue_coverage && run2.issue_coverage.candidates));

  const run3 = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 62, selectedIssueIds: ['q1'], engine: K, authorization: auth, raw,
  });
  check('IC-g 未提供 issueQuotes 时 issue_coverage 为空（不伪造"已核验"）',
    run3.issue_coverage && run3.issue_coverage.count === 0,
    JSON.stringify(run3.issue_coverage));
}

finish('14-plan-coverage-0731');
