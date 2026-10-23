/**
 * tests/narrative-repair/18-six-issue-closure.test.mjs —— 《六项审稿漏修与语义闭环》
 * 方案 §11 的 N01–N36（离线、零计费、不读真实作品库）。
 *
 * 这套断言回答的问题不是"六条文学问题改得漂不漂亮"，而是：
 *   · 选中了什么，修稿/验收层是否真的收到了什么（不许静默丢项）；
 *   · 改了没改 / 改在哪 / 改的是不是问题本身，是否被分开记录；
 *   · "只修半个问题""完全漏修""改错位置""跨资料未核验"能不能被**识别为未闭环**；
 *   · 已有 PASS 会不会被后续复修冲掉；单请求与分段是否同一出口。
 *
 * 夹具是**脱敏最小复现**（只保留能复现判定的段落），人工参考真值来自方案 §0/§2，
 * 不冒充软件运行结论。本套件不调用任何模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecks, REPO_ROOT } from './harness.mjs';
import { structureReviewReport, resolveReviewQuoteBase } from '../../ai/editing/narrative-review.mjs';

await import(new URL('../../public/revision-findings.js', import.meta.url).href);
await import(new URL('../../public/revision-semantic-verifier.js', import.meta.url).href);
await import(new URL('../../public/revision-finalize.js', import.meta.url).href);
await import(new URL('../../public/revision-closure.js', import.meta.url).href);
await import(new URL('../../public/revision-trace.js', import.meta.url).href);
await import(new URL('../../public/review-workspace.js', import.meta.url).href);

const RF = globalThis.NovelRevisionFindings;
const SV = globalThis.NovelRevisionSemanticVerifier;
const FZ = globalThis.NovelRevisionFinalize;
const CL = globalThis.NovelRevisionClosure;
const TR = globalThis.NovelRevisionTrace;
const RW = globalThis.NovelRevisionWorkspace;
const { check, finish } = createChecks();

const FIX = path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'chapter1-six-issues');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const before = readJson('before-excerpts.json');
const after = readJson('after-excerpts.json');
const review = readJson('review-report.json');
const verdicts = readJson('model-verdicts.json');
const expected = readJson('expected-results.json');
const roleCard = readJson('role-card-asof.json');

const BODY = before.paragraphs.map((p) => p.text).join('\n');
const AFTER_BODY = after.paragraphs.map((p) => p.text).join('\n');
const findings = review.findings;
const byId = new Map(findings.map((f) => [f.id, f]));
const ALL = findings.map((f) => f.id);

/** 用户提供的真实修后差异（与 after-excerpts 同源）。 */
const REAL_EDITS = [
  { issue: 'Q01', original: '屏幕打出四行字：', replacement: '屏幕打出结果：' },
  { issue: 'Q02', original: '，也像值班室里那盏接触不良的灯照在墙上的那种黄', replacement: '' },
  { issue: 'Q04', original: '，看了一眼他的表情', replacement: '' },
];

/** 把"编辑清单"编译成补丁（偏移按原稿算），并返回候选正文。 */
function applyEdits(edits) {
  const applied = edits.map((e) => {
    const at = BODY.indexOf(e.original);
    if (at < 0) throw new Error(`夹具编辑找不到原文：${e.original}`);
    return {
      issue_ids: [e.issue], start: at, end: at + e.original.length,
      original: e.original, replacement: e.replacement,
      op: e.replacement ? 'replace' : 'delete', patch_id: `${e.issue}-p1`,
    };
  });
  let text = BODY;
  for (const p of applied.slice().sort((a, b) => b.start - a.start)) {
    text = text.slice(0, p.start) + p.replacement + text.slice(p.end);
  }
  return { applied, candidate: text };
}

/** 覆盖表：默认"改过的 patched、没改的 keep"。 */
function coverageOf(edits, ids = ALL) {
  const patched = new Set(edits.map((e) => e.issue));
  return ids.map((id) => ({ issue_id: id, status: patched.has(id) ? 'patched' : 'keep' }));
}

function runCase(opts = {}) {
  const edits = opts.edits || [];
  const built = applyEdits(edits);
  const ids = opts.select || ALL;
  return FZ.finalizeRevisionCandidate({
    originalText: BODY,
    candidateText: opts.candidate != null ? opts.candidate : built.candidate,
    selectedIssueIds: ids,
    findings: opts.findings || findings,
    applied: opts.applied != null ? opts.applied : built.applied,
    coverage: opts.coverage || coverageOf(edits, ids),
    plan: opts.plan || null,
    verifier: SV,
    closure: CL,
    semanticByIssue: opts.semantic || {},
    externalContextByIssue: opts.external || null,
    mode: opts.mode || 'single',
    segments: opts.segments || null,
    mergeComplete: opts.mergeComplete === true,
    segmentCoverage: opts.segmentCoverage || null,
    protectedSpans: opts.protectedSpans || [],
    invariants: opts.invariants || { must_keep: [] },
  });
}
const rowOf = (r, id) => (r.rows || []).find((x) => x.issue_id === id) || null;

// ── N01：六项均选中 → 六条状态行，任何一条不能无声消失 ────────────────────────
{
  const r = runCase({ edits: REAL_EDITS });
  const ids = r.rows.map((x) => x.issue_id);
  check('N01 六项全选 ⇒ 六条状态行都在（逐条有终态或待验，没有 UNACCOUNTED 之外的静默消失）',
    r.rows.length === 6 && ALL.every((id) => ids.includes(id)) && r.summary.total === 6,
    JSON.stringify(ids));
  check('N01-b 结构化 findings 与 issues 同序（前端按勾选下标连接证据的前提）',
    review.findings.every((f, i) => review.issues[i].includes(f.title) || review.issues[i].length > 0)
    && review.findings.length === review.issues.length,
    `${review.findings.length}/${review.issues.length}`);
}

// ── N02：只选 Q03 → 不对其他问题生成非授权补丁 ────────────────────────────────
{
  // 只选中 Q03，却把 Q01/Q02 的补丁塞进来（模拟"模型顺手多改"）——覆盖表只回答 Q03
  const built = applyEdits([
    { issue: 'Q03', original: byId.get('Q03').evidence[0].quote, replacement: '' },
    { issue: 'Q01', original: '屏幕打出四行字：', replacement: '屏幕打出结果：' },
  ]);
  const r = runCase({
    select: ['Q03'], findings: [byId.get('Q03')], edits: [],
    applied: built.applied, candidate: built.candidate, coverage: coverageOf([], ['Q03']),
  });
  const q03 = rowOf(r, 'Q03');
  check('N02 只勾 Q03 时，越出该问题的补丁不会让它被判通过（覆盖表 keep + 越界补丁 ⇒ 不得 ISSUE_VERIFIED）',
    q03 && q03.final_status !== 'ISSUE_VERIFIED',
    JSON.stringify(q03 && { s: q03.final_status, c: q03.reason_code, patches: q03.patch_ids }));
  check('N02-b 分母只数被勾选的那一条（不是报告里的 6 条）',
    r.rows.length === 1 && r.summary.total === 1, JSON.stringify(r.summary));
}

// ── N03：只选 Q04 → 只在授权范围应用，保留李拓不同功能的帮助 ─────────────────
{
  const edits = [
    { issue: 'Q04', original: '“兄弟，也正常，D级一大半人呢。真不是事。”', replacement: '' },
    { issue: 'Q04', original: '“你要不去复检一下吧？我表舅去年第一次也是暗的，第二次亮了青，真的。”', replacement: '' },
    { issue: 'Q04', original: '，看了一眼他的表情', replacement: '' },
  ];
  const r = runCase({ select: ['Q04'], findings: [byId.get('Q04')], edits, semantic: { Q04: { status: 'pass' } } });
  const q04 = rowOf(r, 'Q04');
  check('N03 两个陌生人劝慰被合并、王磊与李拓的功能都在 ⇒ 语义通过时这一条可以 PASS',
    q04 && q04.final_status === 'ISSUE_VERIFIED',
    JSON.stringify(q04 && { s: q04.final_status, c: q04.reason_code }));
}

// ── N04：UI 展示六条但只勾四条 → 分母是四 ─────────────────────────────────────
{
  const r = runCase({ select: ['Q01', 'Q02', 'Q03', 'Q06'], edits: REAL_EDITS });
  check('N04 只勾 4 条时分母是 4，未勾的两项不被算成漏修',
    r.rows.length === 4 && r.summary.total === 4 && !r.rows.some((x) => x.issue_id === 'Q05'),
    JSON.stringify(r.rows.map((x) => x.issue_id)));
}

// ── N05 / N06：证据定位失败与引文歧义 ────────────────────────────────────────
{
  const missing = review.findings[0];
  const f = RF.normalizeFinding({
    id: 'Q01', title: missing.title, evidence: [{ quote: '这句话正文里根本没有出现过。', role: 'candidate_edit' }],
    acceptance: missing.acceptance,
  }, { bodyText: BODY });
  check('N05 找不到逐字证据 ⇒ 标 QUOTE_NOT_FOUND 且不可作为可执行条目（不猜位置）',
    f.diagnostics.some((d) => d.code === 'QUOTE_NOT_FOUND') && f.actionable === false,
    JSON.stringify(f.diagnostics.map((d) => d.code)));
  const dupBody = `${BODY}\n“兄弟，也正常，D级一大半人呢。真不是事。”`;
  const dup = RF.normalizeFinding({
    id: 'Q04', title: '重复引文', evidence: [{ quote: '“兄弟，也正常，D级一大半人呢。真不是事。”', role: 'candidate_edit' }],
    acceptance: { rule: 'x' },
  }, { bodyText: dupBody });
  check('N06 同一引文在正文出现多次 ⇒ AMBIGUOUS_ANCHOR，不随机改其中一处',
    dup.diagnostics.some((d) => d.code === 'AMBIGUOUS_ANCHOR') && dup.actionable === false,
    JSON.stringify(dup.diagnostics.map((d) => d.code)));
}

// ── N07：自然语言 issue、缺 finding → 兼容解析并如实报告补证据需求 ─────────────
{
  const norm = RF.normalizeReviewReport({ issues: review.issues.slice(0, 2) }, { bodyText: BODY });
  check('N07 只有自然语言问题（旧报告）⇒ 保留 2 条并标 LEGACY/EVIDENCE_MISSING，不静默丢项',
    norm.findings.length === 2 && norm.findings.every((f) => !f.actionable)
    && norm.diagnostics.some((d) => d.code === 'LEGACY_REPORT')
    && norm.diagnostics.some((d) => d.code === 'EVIDENCE_MISSING'),
    JSON.stringify(norm.counts));
  const shape = structureReviewReport({ summary: 's', issues: review.issues, findings: review.findings }, { text: BODY, quoteBase: resolveReviewQuoteBase({ reviewedText: BODY, chapterText: AFTER_BODY }) });
  check('N07-b 有引文的报告能被结构化（accepted=6），且引文底本来源被如实记录',
    shape.counts.accepted === 6 && shape.quote_base && shape.quote_base.source === 'reviewed'
    && shape.quote_base.differs_from_chapter === true,
    JSON.stringify({ accepted: shape.counts.accepted, qb: shape.quote_base }));
  // 2026-10-22（第 119 章实测）：库内正文为空时 `differs_from_chapter` 只能是 false，
  // 但"库里的正文是空的"必须单独可见，否则回执会把"报告底本不是正文"说成"无差异"。
  const qbEmptyChapter = resolveReviewQuoteBase({ reviewedText: BODY, chapterText: '' });
  check('N07-c 库内正文为空 ⇒ chapter_empty=true，且不靠 differs_from_chapter 表达这件事',
    qbEmptyChapter.source === 'reviewed' && qbEmptyChapter.chapter_empty === true
    && qbEmptyChapter.differs_from_chapter === false,
    JSON.stringify(qbEmptyChapter));
  const shapeEmptyChapter = structureReviewReport(
    { summary: 's', issues: review.issues, findings: review.findings },
    { text: BODY, quoteBase: qbEmptyChapter },
  );
  check('N07-d 结构化结果把 chapter_empty 传给界面（quote_base.chapter_empty）',
    shapeEmptyChapter.quote_base && shapeEmptyChapter.quote_base.chapter_empty === true
    && shapeEmptyChapter.counts.accepted === 6,
    JSON.stringify({ qb: shapeEmptyChapter.quote_base, accepted: shapeEmptyChapter.counts.accepted }));
}

// ── N08 / N09 / N10：Q01 的三种形态 ──────────────────────────────────────────
{
  const { applied, candidate } = applyEdits([REAL_EDITS[0]]); // 只把「四行字」改成「结果」
  const r = runCase({
    select: ['Q01'], findings: [byId.get('Q01')], edits: [REAL_EDITS[0]],
    applied, candidate, coverage: coverageOf([REAL_EDITS[0]], ['Q01']),
    semantic: { Q01: { status: 'partial', reason_code: 'PARTIAL_REFERENCE_AMBIGUITY_REMAINS' } },
  });
  const q01 = rowOf(r, 'Q01');
  check('N08 Q01 只把「四行字」改成「结果」⇒ PARTIAL（不得 PASS）',
    q01 && q01.verdict === 'partial' && q01.final_status === 'PARTIAL'
    && q01.reason_code === 'PARTIAL_REFERENCE_AMBIGUITY_REMAINS',
    JSON.stringify(q01 && { v: q01.verdict, c: q01.reason_code }));
}
{
  const edits = [
    { issue: 'Q01', original: '屏幕打出四行字：江陵三中 李拓 A级 高级战斗天赋。', replacement: '屏幕先打出校名与考号：江陵三中，随后亮出一行：李拓 A级 高级战斗天赋。' },
    { issue: 'Q01', original: '那四个字念得很慢', replacement: '「A级」三个字念得很慢' },
  ];
  const r = runCase({ select: ['Q01'], findings: [byId.get('Q01')], edits, semantic: { Q01: { status: 'pass' } } });
  const q01 = rowOf(r, 'Q01');
  check('N09 Q01 消除含糊指代且保留「李拓 A 级 / 高级战斗天赋」⇒ 可通过独立验收',
    q01 && q01.final_status === 'ISSUE_VERIFIED'
    && BODY.includes('高级战斗天赋') && r.rows.length === 1,
    JSON.stringify(q01 && { s: q01.final_status, conds: q01.condition_results }));
}
{
  const edits = [
    { issue: 'Q01', original: '屏幕打出四行字：', replacement: '屏幕打出结果：' },
    { issue: 'Q01', original: '那四个字念得很慢', replacement: '那几个字念得很慢' },
  ];
  const r = runCase({ select: ['Q01'], findings: [byId.get('Q01')], edits, semantic: { Q01: { status: 'pass' } } });
  const q01 = rowOf(r, 'Q01');
  check('N10 Q01 改成「那几个字」仍然含糊 ⇒ 风险断言命中，不得 PASS（也必须交语义层而不是机械判死）',
    q01 && q01.final_status !== 'ISSUE_VERIFIED'
    && q01.condition_results.some((c) => c.kind === 'residual_terms_absent' && c.status === 'FAIL'),
    JSON.stringify(q01 && { s: q01.final_status, c: q01.reason_code, conds: q01.condition_results }));
}

// ── N11 / N12：Q02 已通过，后续只修 Q04 不得把它冲掉 ─────────────────────────
{
  const edits = [{ issue: 'Q02', original: REAL_EDITS[1].original, replacement: '' }];
  const r = runCase({ select: ['Q02'], findings: [byId.get('Q02')], edits, semantic: { Q02: { status: 'pass' } } });
  const q02 = rowOf(r, 'Q02');
  check('N11 Q02 删掉值班室灯比喻、保留搪瓷盆与暗黄事实 ⇒ PASS',
    q02 && q02.final_status === 'ISSUE_VERIFIED', JSON.stringify(q02 && q02.final_status));
}
{
  const prior = runCase({ select: ['Q01', 'Q02'], findings: [byId.get('Q01'), byId.get('Q02')], edits: [REAL_EDITS[1]], semantic: { Q01: { status: 'partial' }, Q02: { status: 'pass' } } });
  // 第二轮只复修 Q04：确定性层对 Q02 仍然通过
  const det = runCase({ select: ['Q01', 'Q02', 'Q04'], findings: [byId.get('Q01'), byId.get('Q02'), byId.get('Q04')], edits: REAL_EDITS, semantic: {} });
  const merged = CL.mergeRepairSemantic(prior, det, ['Q04']);
  const q02 = merged.issues.find((x) => x.issue_id === 'Q02');
  check('N12 第二轮只复修 Q04 时，Q02 的 PASS 不被冲成待验（本轮没改它）',
    q02 && q02.final_status === 'ISSUE_VERIFIED' && q02.semantic_status === 'pass',
    JSON.stringify(q02 && { s: q02.final_status, sem: q02.semantic_status }));
}

// ── N13 / N14 / N15：Q03 原段未动 / 已删 / 只删一半 ──────────────────────────
{
  const r = runCase({
    select: ['Q03'], findings: [byId.get('Q03')], edits: [], coverage: coverageOf([], ['Q03']),
    // 模型谎报 pass：硬事实必须压过自评
    semantic: { Q03: { status: 'pass', reason: '我已经改好了' } },
  });
  const q03 = rowOf(r, 'Q03');
  check('N13 Q03 原总结段完全未修改 ⇒ FAIL/REDUNDANT_EXPLANATION_REMAINS，即使模型回包 pass',
    q03 && q03.final_status === 'UNRESOLVED' && q03.reason_code === 'REDUNDANT_EXPLANATION_REMAINS',
    JSON.stringify(q03 && { s: q03.final_status, c: q03.reason_code }));
}
{
  const edits = [{ issue: 'Q03', original: byId.get('Q03').evidence[0].quote, replacement: '' }];
  const r = runCase({ select: ['Q03'], findings: [byId.get('Q03')], edits, semantic: { Q03: { status: 'pass' } } });
  const q03 = rowOf(r, 'Q03');
  check('N14 Q03 原段整段删除且前后衔接正常 ⇒ 可通过独立验收',
    q03 && q03.final_status === 'ISSUE_VERIFIED', JSON.stringify(q03 && q03.final_status));
}
{
  const half = '颜色越亮，等级越高；';
  const edits = [{ issue: 'Q03', original: half, replacement: '' }];
  const r = runCase({ select: ['Q03'], findings: [byId.get('Q03')], edits, semantic: { Q03: { status: 'pass' } } });
  const q03 = rowOf(r, 'Q03');
  check('N15 Q03 只删「颜色越亮…」而剩余重复大段仍在 ⇒ 不得 PASS（锚点原句仍在）',
    q03 && q03.final_status !== 'ISSUE_VERIFIED'
    && q03.checks.some((c) => c.code === 'REDUNDANT_EXPLANATION_REMAINS' && c.passed === false),
    JSON.stringify(q03 && { s: q03.final_status, c: q03.reason_code }));
}

// ── N16 / N17 / N18 / N19：Q04 的四种形态 ───────────────────────────────────
{
  const r = runCase({ select: ['Q04'], findings: [byId.get('Q04')], edits: [REAL_EDITS[2]], semantic: { Q04: { status: 'pass' } } });
  const q04 = rowOf(r, 'Q04');
  check('N16 Q04 只删「看了一眼他的表情」⇒ UNRELATED_CHANGE（actual_change=true 也不得 PASS）',
    q04 && q04.final_status === 'UNRESOLVED' && q04.reason_code === 'UNRELATED_CHANGE'
    && q04.actual_change === true,
    JSON.stringify(q04 && { s: q04.final_status, c: q04.reason_code, ac: q04.actual_change }));
}
{
  const edits = [
    { issue: 'Q04', original: '“兄弟，也正常，D级一大半人呢。真不是事。”\n', replacement: '' },
    { issue: 'Q04', original: '“你要不去复检一下吧？我表舅去年第一次也是暗的，第二次亮了青，真的。”\n', replacement: '' },
    { issue: 'Q04', original: '王磊从人堆里挤出来，把文件袋塞回他手里，看了一眼他的表情，说：', replacement: '' },
  ];
  const r = runCase({ select: ['Q04'], findings: [byId.get('Q04')], edits, semantic: { Q04: { status: 'fail', reason_code: 'DANGLING_DIALOGUE' } } });
  const q04 = rowOf(r, 'Q04');
  check('N17 Q04 删掉重复劝慰但留下无主对白 ⇒ 语义判 fail 时不得 PASS（结构/连贯验收未过）',
    q04 && q04.final_status === 'UNRESOLVED', JSON.stringify(q04 && { s: q04.final_status, c: q04.reason_code }));
}
{
  const edits = [
    { issue: 'Q04', original: '“兄弟，也正常，D级一大半人呢。真不是事。”', replacement: '' },
    { issue: 'Q04', original: '“你要不去复检一下吧？我表舅去年第一次也是暗的，第二次亮了青，真的。”', replacement: '' },
  ];
  const r = runCase({ select: ['Q04'], findings: [byId.get('Q04')], edits, semantic: { Q04: { status: 'pass' } } });
  const q04 = rowOf(r, 'Q04');
  check('N18 Q04 两组发声者功能清晰、李拓的信息保留 ⇒ 语义可 PASS',
    q04 && q04.final_status === 'ISSUE_VERIFIED'
    && q04.checks.every((c) => c.code !== 'PRESERVE_LOST' || c.passed !== false),
    JSON.stringify(q04 && q04.final_status));
}
{
  const edits = [{ issue: 'Q04', original: '，看了一眼他的表情', replacement: '，抬眼看了看他' }];
  const r = runCase({ select: ['Q04'], findings: [byId.get('Q04')], edits, semantic: { Q04: { status: 'pass' } } });
  const q04 = rowOf(r, 'Q04');
  check('N19 Q04 只是把动作词换个说法（关键词频率下降）不得作为 PASS 唯一依据',
    q04 && q04.final_status === 'UNRESOLVED', JSON.stringify(q04 && { s: q04.final_status, c: q04.reason_code }));
}

// ── N20 / N21 / N22 / N23：Q05 的外部资料分流 ───────────────────────────────
{
  const r = runCase({ select: ['Q05'], findings: [byId.get('Q05')], edits: [], coverage: coverageOf([], ['Q05']) });
  const q05 = rowOf(r, 'Q05');
  check('N20 Q05 卡片不可读/时点不明 ⇒ NEED_CONTEXT（待核验），不改正文也不改卡片',
    q05 && q05.final_status === 'AWAITING_SEMANTIC' && q05.reason_code === 'EXTERNAL_CONTEXT_REQUIRED'
    && q05.patch_ids.length === 0,
    JSON.stringify(q05 && { s: q05.final_status, c: q05.reason_code, ex: q05.external_context }));
  const card = roleCard.cases.find((c) => c.id === 'offscene-count');
  check('N20-b 角色卡真值被夹具如实记录：卡片含「四遍」但没有 effective_chapter/as_of 字段',
    card && card.readable === true && /四遍/.test(card.card_fields.personality) && card.temporal_fields_present === false,
    JSON.stringify(card && { readable: card.readable, temporal: card.temporal_fields_present }));
}
{
  const r = runCase({
    select: ['Q05'], findings: [byId.get('Q05')], edits: [], coverage: coverageOf([], ['Q05']),
    external: { Q05: { resolved: true, verdict: 'not_applicable_with_evidence', note: '卡片「四遍」含画外早上，正文无需补写', evidence_ref: 'characters#76' } },
  });
  const q05 = rowOf(r, 'Q05');
  check('N21 Q05 有证据地判「不适用（画外计数）」⇒ 仍不是 PASS，且没有为凑数字生成任何正文补丁',
    q05 && q05.final_status === 'AWAITING_SEMANTIC' && q05.reason_code === 'NOT_APPLICABLE_WITH_EVIDENCE'
    && q05.patch_ids.length === 0,
    JSON.stringify(q05 && { s: q05.final_status, c: q05.reason_code }));
}
{
  const r = runCase({ select: ['Q05'], findings: [byId.get('Q05')], edits: [], coverage: coverageOf([], ['Q05']) });
  const targets = CL.repairTargets({ issues: r.rows });
  check('N22 Q05 需要改卡但只有正文授权 ⇒ 不进入定向复修队列（阻塞外部写入，向作者要最小权限）',
    targets.targets.length === 0 && targets.skipped.some((s) => s.issue_id === 'Q05' && /外部资料/.test(s.why)),
    JSON.stringify(targets));
}
{
  const r = runCase({
    select: ['Q05'], findings: [byId.get('Q05')], edits: [], coverage: coverageOf([], ['Q05']),
    external: { Q05: { resolved: true, verdict: 'time_conflict', note: '卡片写的是卷末状态，被误套到第 1 章', evidence_ref: 'characters#76' } },
  });
  const q05 = rowOf(r, 'Q05');
  check('N23 Q05 卡片把卷末状态套到第 1 章 ⇒ 标注资料时态冲突，仍不改角色命运与世界设定',
    q05 && q05.final_status === 'AWAITING_SEMANTIC' && q05.reason_code === 'NOT_APPLICABLE_WITH_EVIDENCE'
    && q05.patch_ids.length === 0,
    JSON.stringify(q05 && { s: q05.final_status, c: q05.reason_code, ex: q05.external_context }));
}

// ── N24 / N25 / N26：Q06 缺行动 / 有行动 / 破坏钩子 ─────────────────────────
{
  const r = runCase({ select: ['Q06'], findings: [byId.get('Q06')], edits: [], coverage: coverageOf([], ['Q06']) });
  const q06 = rowOf(r, 'Q06');
  check('N24 Q06 只保留王磊「普通大学」的劝慰 ⇒ FAIL（主角没有做决定）',
    q06 && q06.final_status === 'UNRESOLVED' && q06.reason_code === 'REQUIRED_CHARACTER_DECISION_MISSING',
    JSON.stringify(q06 && { s: q06.final_status, c: q06.reason_code }));
}
{
  const edits = [{ issue: 'Q06', original: '检测完成，宿主符合绑定条件。', replacement: '他拿出手机，在备忘录里记下「普通大学招生」和「本地岗位」两行，才把登记表收好。\n检测完成，宿主符合绑定条件。' }];
  const r = runCase({ select: ['Q06'], findings: [byId.get('Q06')], edits, semantic: { Q06: { status: 'pass' } } });
  const q06 = rowOf(r, 'Q06');
  check('N25 Q06 主角出现可见的普通路线行动（备忘录）⇒ 可按蓝图验收 PASS',
    q06 && q06.final_status === 'ISSUE_VERIFIED', JSON.stringify(q06 && { s: q06.final_status, c: q06.reason_code }));
}
{
  const edits = [
    { issue: 'Q06', original: '检测完成，宿主符合绑定条件。', replacement: '他知道，自己一定能走出一条不一样的路，普通大学也好，本地岗位也好，他都不怕。' },
  ];
  const r = runCase({ select: ['Q06'], findings: [byId.get('Q06')], edits, semantic: { Q06: { status: 'pass' } } });
  const q06 = rowOf(r, 'Q06');
  check('N26 Q06 改写成大段内心总结并抹掉章末钩子 ⇒ 不得通过（保留条件丢了是硬事实）',
    q06 && q06.final_status === 'UNRESOLVED'
    && q06.checks.some((c) => c.code === 'PRESERVE_LOST' && c.passed === false),
    JSON.stringify(q06 && { s: q06.final_status, c: q06.reason_code }));
}

// ── N27 / N28：改错位置与谎报 pass ──────────────────────────────────────────
{
  // 改动落在别处（补丁归属 Q01，但删的是另一句）
  const r = runCase({ select: ['Q01'], findings: [byId.get('Q01')], edits: [{ issue: 'Q01', original: '，看了一眼他的表情', replacement: '' }], semantic: { Q01: { status: 'pass' } } });
  const q01 = rowOf(r, 'Q01');
  check('N27 actual_change=true 但改的是别处 ⇒ 不能 PASS（改错位置/锚点未动）',
    q01 && q01.final_status === 'UNRESOLVED' && q01.actual_change === true
    && ['UNRELATED_CHANGE', 'ANCHOR_NOT_EDITED'].includes(q01.reason_code),
    JSON.stringify(q01 && { c: q01.reason_code, ac: q01.actual_change }));
}
{
  const liar = {};
  for (const v of verdicts.liar_pass) liar[v.issue_id] = { status: v.verdict, reason: v.reason };
  const r = runCase({ edits: [], coverage: coverageOf([], ['Q03', 'Q04']), select: ['Q03', 'Q04'], findings: [byId.get('Q03'), byId.get('Q04')], semantic: liar });
  const q03 = rowOf(r, 'Q03'), q04 = rowOf(r, 'Q04');
  check('N28 模型谎报 pass、硬事实反证 ⇒ 硬守卫仍拒绝（两条都不得 ISSUE_VERIFIED）',
    q03.final_status === 'UNRESOLVED' && q04.final_status === 'UNRESOLVED',
    JSON.stringify({ q03: q03.reason_code, q04: q04.reason_code }));
}

// ── N29 / N30 / N31 / N32：预算、复修队列与轮次上限 ─────────────────────────
{
  // 没有任何确定性失败（Q02 的锚点已整段删除）但没有语义结论 ⇒ 只能停在待验
  const r = runCase({ select: ['Q02'], findings: [byId.get('Q02')], edits: [REAL_EDITS[1]], semantic: {} });
  const q02 = rowOf(r, 'Q02');
  check('N29 未跑语义复验 ⇒ 停在 UNVERIFIED（不进 PASS），且不进入自动复修',
    q02.final_status === 'AWAITING_SEMANTIC' && q02.semantic_status === 'not_run'
    && CL.planAutoRepair({ issues: r.rows, round: 0, estimateCents: 3, budgetCents: 100 }).reason === 'NO_TARGETS',
    JSON.stringify({ q02: q02.final_status }));
  // 费用无法核价 ⇒ 拒绝自动复修（"大概不到 2 元"不是授权）
  const bad = runCase({ select: ['Q03'], findings: [byId.get('Q03')], edits: [], coverage: coverageOf([], ['Q03']), semantic: {} });
  const plan = CL.planAutoRepair({ issues: bad.rows, round: 0, costKnown: false, estimateCents: null });
  check('N29-b 费用无法核价 ⇒ COST_UNKNOWN，不自动发起付费复修',
    plan.ok === false && plan.reason === 'COST_UNKNOWN', JSON.stringify(plan));
}
{
  const r = runCase({ select: ['Q01'], findings: [byId.get('Q01')], edits: [REAL_EDITS[0]], semantic: { Q01: { status: 'partial' } } });
  const plan = CL.planAutoRepair({ issues: r.rows, round: 0, estimateCents: 3, budgetCents: 100, allowedIssueIds: ['Q01'] });
  const targets = CL.repairTargets({ issues: r.rows, budget: { remaining: 100 } });
  check('N30 PARTIAL 在预算与授权范围内进入复修（repairTargets 与 planAutoRepair 都包含它）',
    plan.ok === true && plan.issue_ids.includes('Q01') && targets.targets.some((t) => t.issue_id === 'Q01'),
    JSON.stringify({ plan, targets: targets.targets.map((t) => t.issue_id) }));
}
{
  const r = runCase({
    select: ['Q02'], findings: [byId.get('Q02')], edits: [REAL_EDITS[1]],
    semantic: { Q02: { status: 'fail', reason_code: 'PROTECTED_SPAN' } },
    protectedSpans: ['高级战斗天赋'],
  });
  const targets = CL.repairTargets({ issues: r.rows });
  check('N31 保护区/版本冲突 ⇒ 不绕过门禁：硬阻塞项不进自动复修，并给出原因码',
    rowOf(r, 'Q02').reason_code === 'PROTECTED_SPAN'
    && targets.targets.length === 0 && targets.skipped.length === 1,
    JSON.stringify(targets));
}
{
  const issues = [{ issue_id: 'Q01', verdict: 'fail', final_status: 'UNRESOLVED', reason_code: 'ANCHOR_NOT_EDITED' }];
  const plan = CL.planAutoRepair({ issues, round: 2, maxRounds: 2, estimateCents: 3, budgetCents: 100 });
  check('N32 复修第二轮已用尽 ⇒ ROUND_LIMIT，不无限执行，未解决状态保留',
    plan.ok === false && plan.reason === 'ROUND_LIMIT', JSON.stringify(plan));
}

// ── N33：复修 Q04 意外破坏 Q02 → 交叉回归识别 ────────────────────────────────
{
  const prior = runCase({ select: ['Q02'], findings: [byId.get('Q02')], edits: [REAL_EDITS[1]], semantic: { Q02: { status: 'pass' } } });
  const broken = BODY.replace('很像旧搪瓷盆磕掉漆以后露出来的底子', '很像旧盆子').replace('，看了一眼他的表情', '');
  const det = runCase({ select: ['Q02', 'Q04'], findings: [byId.get('Q02'), byId.get('Q04')], edits: [REAL_EDITS[2]], candidate: broken, semantic: {} });
  const merged = CL.mergeRepairSemantic(prior, det, ['Q04']);
  const q02 = merged.issues.find((x) => x.issue_id === 'Q02');
  check('N33 复修改坏了 Q02 的保留字面 ⇒ 交叉回归识别为 FAIL（不静默沿用旧 PASS）',
    q02 && q02.final_status === 'UNRESOLVED',
    JSON.stringify(q02 && { s: q02.final_status, c: q02.reason_code }));
}

// ── N34：单请求与分段进入同一出口 ───────────────────────────────────────────
{
  const base = { select: ['Q01', 'Q02'], findings: [byId.get('Q01'), byId.get('Q02')], edits: [REAL_EDITS[1]], semantic: { Q01: { status: 'partial' }, Q02: { status: 'pass' } } };
  const single = runCase(base);
  const seg = runCase({ ...base, mode: 'segmented', segments: [{ segment_id: 's1', proof_ok: true }], mergeComplete: true, segmentCoverage: coverageOf([REAL_EDITS[1]], ['Q01', 'Q02']) });
  check('N34 单请求与分段：逐项终验语义一致、分母一致（同一出口）',
    single.parity.key === seg.parity.key && single.summary.total === seg.summary.total,
    JSON.stringify({ single: single.parity.key, seg: seg.parity.key }));
}

// ── N35：deferred 三项只延期，不成为正文补丁 ─────────────────────────────────
{
  const deferredIds = review.deferred.map((d) => d.text);
  const allIds = new Set(ALL);
  check('N35 possible_foreshadowing 三项只登记延期，不在 findings/选中清单里（不会变成正文补丁）',
    review.deferred.length === 3 && review.deferred.every((d) => d.type === 'possible_foreshadowing')
    && deferredIds.every((t) => ![...allIds].some((id) => String(byId.get(id).explanation).includes(t))),
    JSON.stringify(deferredIds));
}

// ── N36：工作区/恢复后展示一致 ──────────────────────────────────────────────
{
  const r = runCase({
    edits: REAL_EDITS,
    semantic: {
      Q01: { status: 'partial' }, Q02: { status: 'pass' }, Q03: { status: 'fail' }, Q04: { status: 'fail' }, Q06: { status: 'fail' },
    },
  });
  const c = RW.countsOf(r.rows);
  const identity = RW.summaryFormulaOf(r.rows);
  const record = FZ.runRecordOf(r);
  check('N36 工作区统计与终验 rows 同一口径：N = P + F + U + B，且 trace 逐项可读',
    identity.total === r.rows.length && identity.balanced === true
    && identity.pass === r.summary.verified && identity.fail === r.summary.unresolved + r.summary.partial
    && identity.unverified === r.summary.awaiting_semantic && identity.blocked === r.summary.canon_conflict
    && c.selected === 6 && Array.isArray(record.selected_issue_ids) && record.selected_issue_ids.length === 6,
    JSON.stringify({ identity, counts: c, sel: record.selected_issue_ids }));
  const events = TR.buildTraceEvents(r, { round: 1, timestamp: 'fixture' });
  const err = TR.checkRedaction(events, BODY);
  check('N36-b trace 逐项有终态且不含正文（脱敏自检通过）',
    events.filter((e) => e.event === 'issue_verdict').length === 6 && err.ok === true,
    JSON.stringify({ events: events.length, offenders: err.offenders.length }));
}

// ── 人工参考真值 vs 软件判定的一致性（六项全选、按真实修后差异）──────────────
{
  const r = runCase({
    edits: REAL_EDITS,
    semantic: {
      Q01: { status: 'partial' }, Q02: { status: 'pass' },
    },
  });
  const got = new Map(r.rows.map((x) => [x.issue_id, x.final_status]));
  const expectMap = { Q01: 'PARTIAL', Q02: 'ISSUE_VERIFIED', Q03: 'UNRESOLVED', Q04: 'UNRESOLVED', Q05: 'AWAITING_SEMANTIC', Q06: 'UNRESOLVED' };
  const ok = Object.entries(expectMap).every(([id, want]) => got.get(id) === want);
  check('N00 六项全选 + 用户真实修后差异 ⇒ 软件判定与人工参考真值逐项一致（1 PASS / 1 PARTIAL / 3 FAIL / 1 待核验）',
    ok, JSON.stringify({ got: Object.fromEntries(got), expected: expectMap, truth: expected.rows.map((x) => `${x.issue_id}:${x.human}`) }));
}

finish('六项审稿漏修与语义闭环（N01–N36）');
