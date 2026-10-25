/**
 * tests/narrative-repair/20-review-round-20261023.test.mjs —— 2026-10-23 本轮
 * 「审稿 → 选择 → 修稿 → 终验」回归（离线、零计费、不读真实作品库）。
 *
 * 夹具来自作者本轮提供的逐字片段（R-0001～R-0009）；**不是完整章原文**，
 * 也不冒充真实运行结论：这套断言回答的是——
 *   · 报告里的 9 条问题被选中后，终验是否每一行都有结论（分母不被缩小）；
 *   · "完全没改 / 只改一半 / 改错位置 / 要求外部资料" 是否被分开；
 *   · 模型说"PASS"能不能覆盖字面事实；
 *   · 审稿侧"优点需加限定"会不会拿一句不相干的反例当证据。
 *
 * 判据改动（2026-10-23）：
 *   · verifier 新增 `target_verdict`（NO_EDIT / ON_TARGET / WRONG_TARGET / UNPROVEN）；
 *   · 多子条件"部分通过"落 PARTIAL，而不是 FAIL；
 *   · 报告自洽性层对反例做 support_relation 筛选（irrelevant/unknown 不进"需加限定"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecks, REPO_ROOT } from './harness.mjs';
import {
  checkReportConsistency,
  normalizeNarrativeFindings,
  structureReviewReport,
} from '../../ai/editing/narrative-review.mjs';
import {
  fingerprint as baseFingerprint,
  sha256Hex as baseSha256,
  resolveBaseHash,
  derivedBaseHash,
} from '../../ai/editing/review-hash.mjs';

await import(new URL('../../public/review-contract.js', import.meta.url).href);
await import(new URL('../../public/revision-findings.js', import.meta.url).href);
await import(new URL('../../public/revision-semantic-verifier.js', import.meta.url).href);
await import(new URL('../../public/revision-finalize.js', import.meta.url).href);
await import(new URL('../../public/revision-closure.js', import.meta.url).href);
await import(new URL('../../public/review-workspace.js', import.meta.url).href);
await import(new URL('../../public/revision-patch.js', import.meta.url).href);

const RF = globalThis.NovelRevisionFindings;
const SV = globalThis.NovelRevisionSemanticVerifier;
const FZ = globalThis.NovelRevisionFinalize;
const CL = globalThis.NovelRevisionClosure;
const RW = globalThis.NovelRevisionWorkspace;
const RC = globalThis.NovelReviewContract;
const RP = globalThis.NovelRevisionPatch;
const { check, finish } = createChecks();

const FIX = path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'review-20261023');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const BEFORE = read('before.txt');
const AFTER = read('after.txt');
const report = JSON.parse(read('review-report.json'));
const findings = report.findings;
const byId = new Map(findings.map((f) => [f.id, f]));
const ALL = findings.map((f) => f.id);

/** 把"编辑清单"编译成补丁（偏移按原稿算），返回候选正文。 */
function applyEdits(edits) {
  const applied = edits.map((e) => {
    const at = BEFORE.indexOf(e.original);
    if (at < 0) throw new Error(`夹具编辑找不到原文：${e.original}`);
    return {
      issue_ids: [e.issue], start: at, end: at + e.original.length,
      original: e.original, replacement: e.replacement,
      op: e.replacement ? 'replace' : 'delete', patch_id: `${e.issue}-p1`,
    };
  });
  let text = BEFORE;
  for (const p of applied.slice().sort((a, b) => b.start - a.start)) {
    text = text.slice(0, p.start) + p.replacement + text.slice(p.end);
  }
  return { applied, candidate: text };
}

/** 覆盖表：改过的 patched，没改的 keep（勾选清单是分母）。 */
function coverageOf(edits, ids = ALL) {
  const patched = new Set(edits.map((e) => e.issue));
  return ids.map((id) => ({ issue_id: id, status: patched.has(id) ? 'patched' : 'keep' }));
}

function runCase(opts = {}) {
  const edits = opts.edits || [];
  const built = opts.candidate != null ? { applied: opts.applied || [], candidate: opts.candidate } : applyEdits(edits);
  const ids = opts.select || ALL;
  return FZ.finalizeRevisionCandidate({
    originalText: BEFORE,
    candidateText: built.candidate,
    selectedIssueIds: ids,
    findings: opts.findings || findings,
    applied: opts.applied != null ? opts.applied : built.applied,
    coverage: opts.coverage || coverageOf(edits, ids),
    plan: opts.plan || null,
    verifier: SV,
    closure: CL,
    semanticByIssue: opts.semantic || {},
    mode: 'single',
    protectedSpans: [],
    invariants: { must_keep: [] },
    canonConflictIds: opts.canon || [],
    currentBaseHash: opts.currentBaseHash,
  });
}
const rowOf = (r, id) => (r.rows || []).find((x) => x.issue_id === id) || null;

/** 本轮真实修后差异（作者实际拿到的候选）。 */
const REAL_EDITS = [
  { issue: 'R-0002', original: '太阳升高了一截，', replacement: '' },
  { issue: 'R-0003', original: '，声音里带着点羡慕', replacement: '' },
  { issue: 'R-0006', original: '他把这一行看了两遍，又去看底下那行小字。', replacement: '他把这行小字看了两遍。' },
];

// ── A01：本轮候选回放 —— 9 条已选问题各有终态，且与作者观察一致 ─────────────
{
  const r = runCase({
    edits: REAL_EDITS,
    semantic: { 'R-0006': { status: 'pass' }, 'R-0009': { status: 'pass' } },
    canon: ['R-0008'],
  });
  const status = (id) => (rowOf(r, id) || {}).final_status;
  check('A01 9 条已选问题 ⇒ 9 行结论（分母不缩、不静默丢项）',
    r.rows.length === 9 && ALL.every((id) => !!rowOf(r, id)), JSON.stringify(r.rows.map((x) => x.issue_id)));
  check('A02 R-0001 两句核心目标原封未动 ⇒ 未通过（不能因为语义说 PASS 就算修好）',
    status('R-0001') === 'UNRESOLVED' && rowOf(r, 'R-0001').actual_change === false, status('R-0001'));
  check('A03 R-0002 只删了「太阳升高了一截」⇒ PARTIAL（不是 PASS，也不是"完全没修"）',
    status('R-0002') === 'PARTIAL'
    && rowOf(r, 'R-0002').unresolved_conditions.includes('R-0002.C1')
    && rowOf(r, 'R-0002').unresolved_conditions.includes('R-0002.C3'), JSON.stringify(rowOf(r, 'R-0002').unresolved_conditions));
  check('A04 R-0003 删了「羡慕」但马尾两处「青绿」仍在 ⇒ 改错位置（WRONG_TARGET），不算已修',
    status('R-0003') === 'UNRESOLVED'
    && rowOf(r, 'R-0003').target_verdict === 'WRONG_TARGET'
    && rowOf(r, 'R-0003').reason_code === 'UNRELATED_CHANGE', JSON.stringify({ t: rowOf(r, 'R-0003').target_verdict, c: rowOf(r, 'R-0003').reason_code }));
  check('A05 R-0004 原句未改 ⇒ 未通过', status('R-0004') === 'UNRESOLVED', status('R-0004'));
  check('A06 R-0005 评定单原句原封不动 ⇒ 未通过（窗口/评定单/短信三处只改了旁处）',
    status('R-0005') === 'UNRESOLVED', status('R-0005'));
  check('A07 R-0006 指代修清楚且语义复核通过 ⇒ 只有这一条 PASS',
    status('R-0006') === 'ISSUE_VERIFIED' && r.summary.verified === 1, JSON.stringify(r.summary));
  check('A08 R-0007 未选中目标句（本轮没有改动）⇒ 未通过，且改不动记录为 NO_EDIT',
    status('R-0007') === 'UNRESOLVED' && rowOf(r, 'R-0007').target_verdict === 'NO_EDIT', rowOf(r, 'R-0007').target_verdict);
  check('A09 R-0008 蓝图/作者授权边界 ⇒ CANON_CONFLICT（不是程序漏修，也不是 PASS）',
    status('R-0008') === 'CANON_CONFLICT' && rowOf(r, 'R-0008').reason_code === 'CANON_CONFLICT', JSON.stringify({ s: status('R-0008'), c: rowOf(r, 'R-0008').reason_code }));
  check('A10 R-0009 完整颜色表仍在、模型谎称 PASS ⇒ 未通过（字面事实覆盖模型结论）',
    status('R-0009') === 'UNRESOLVED' && rowOf(r, 'R-0009').semantic_status === 'pass', JSON.stringify({ s: status('R-0009'), sem: rowOf(r, 'R-0009').semantic_status }));
  check('A11 运行级结论：仍是候选且未通过全部验收（绝不显示"全部修好"）',
    r.status === 'PARTIAL_CANDIDATE' && r.summary.coverage_complete === true, JSON.stringify({ status: r.status, cov: r.summary.coverage_complete }));
}

// ── A12：R-0001 一个字没改，模型说 PASS ⇒ 仍 FAIL（ANCHOR 类硬失败） ──────────
{
  const r = runCase({ select: ['R-0001'], findings: [byId.get('R-0001')], edits: [], semantic: { 'R-0001': { status: 'pass' } } });
  const q = rowOf(r, 'R-0001');
  check('A12 未改核心锚点却提交 PASS ⇒ 未通过，且原因落在"证据仍在"这一档',
    q.final_status === 'UNRESOLVED' && /ANCHOR|REMAINS|NOT_EDITED/.test(q.reason_code), JSON.stringify({ s: q.final_status, c: q.reason_code }));
}

// ── A13：R-0001 只删流程总结、保留人生总结 ⇒ PARTIAL（多子条件只做一半） ─────
{
  const edit = { issue: 'R-0001', original: '流程其实只有三步', replacement: '' };
  const r = runCase({ select: ['R-0001'], findings: [byId.get('R-0001')], edits: [edit] });
  const q = rowOf(r, 'R-0001');
  const cond = new Map((q.condition_results || []).map((c) => [c.id, c.status]));
  check('A13 R-0001 只删流程总结 ⇒ PARTIAL（C1 通过、C2 残留），不判 PASS、也不判"完全没改"',
    q.final_status === 'PARTIAL' && cond.get('R-0001.C1') === 'PASS' && cond.get('R-0001.C2') === 'FAIL'
    && q.unresolved_conditions.includes('R-0001.C2'), JSON.stringify({ s: q.final_status, cond: [...cond] }));
}

// ── A14：R-0003 只删「羡慕」⇒ WRONG_TARGET + UNRELATED_CHANGE ────────────────
{
  const edit = { issue: 'R-0003', original: '，声音里带着点羡慕', replacement: '' };
  const r = runCase({ select: ['R-0003'], findings: [byId.get('R-0003')], edits: [edit] });
  const q = rowOf(r, 'R-0003');
  check('A14 R-0003 改的是评价句、不是马尾证据 ⇒ WRONG_TARGET（actual_change=true 也不得 PASS）',
    q.final_status === 'UNRESOLVED' && q.target_verdict === 'WRONG_TARGET'
    && q.reason_code === 'UNRELATED_CHANGE' && q.actual_change === true,
    JSON.stringify({ t: q.target_verdict, c: q.reason_code, a: q.actual_change }));
}

// ── A15：R-0005 只删短信 ⇒ 必须保留项丢失 ⇒ FAIL ─────────────────────────────
{
  const edit = { issue: 'R-0005', original: '测完了，D级，无战斗能力，普通职业方向。', replacement: '' };
  const r = runCase({ select: ['R-0005'], findings: [byId.get('R-0005')], edits: [edit] });
  const q = rowOf(r, 'R-0005');
  check('A15 R-0005 只删短信、评定单不动 ⇒ FAIL（保留项丢失 + 子条件未过，不因"改了字"放行）',
    q.final_status === 'UNRESOLVED' && q.unresolved_conditions.includes('R-0005.C3'), JSON.stringify({ s: q.final_status, u: q.unresolved_conditions }));
}

// ── A16：R-0005 只压缩评定单重述、窗口与短信保留 ⇒ PASS（该项） ──────────────
{
  const edit = {
    issue: 'R-0005',
    original: '评定单上印得规规整整：姓名岳宸炎，学校江陵三中，检测结果D级·无战斗能力，建议方向普通职业。',
    replacement: '评定单的纸很薄，背面透出上一页的字。',
  };
  const r = runCase({ select: ['R-0005'], findings: [byId.get('R-0005')], edits: [edit], semantic: { 'R-0005': { status: 'pass' } } });
  const q = rowOf(r, 'R-0005');
  check('A16 R-0005 只压缩评定单重述、窗口与短信逐字保留 ⇒ 该项通过',
    q.final_status === 'ISSUE_VERIFIED' && q.unresolved_conditions.length === 0, JSON.stringify({ s: q.final_status, u: q.unresolved_conditions }));
}

// ── A17：R-0007 只改旁处 ⇒ WRONG_TARGET ─────────────────────────────────────
{
  const edit = { issue: 'R-0007', original: '手里拎着半瓶可乐', replacement: '手里拎着半瓶可乐，听他应了' };
  const r = runCase({ select: ['R-0007'], findings: [byId.get('R-0007')], edits: [edit] });
  const q = rowOf(r, 'R-0007');
  check('A17 R-0007 只改后文动作、旧回指未动 ⇒ WRONG_TARGET，不判通过',
    q.final_status === 'UNRESOLVED' && q.target_verdict === 'WRONG_TARGET' && q.reason_code === 'UNRELATED_CHANGE',
    JSON.stringify({ t: q.target_verdict, c: q.reason_code }));
}

// ── A18：单证据的 R-0005 ⇒ 证据覆盖不全（不声称三处已验） ────────────────────
{
  const oneEvidence = {
    ...byId.get('R-0005'),
    evidence: [{ quote: 'D级，暗黄色，无战斗能力。建议方向——普通职业。', role: 'reference', span_id: 'only-window' }],
  };
  const nf = RF.normalizeFinding(oneEvidence, { bodyText: BEFORE });
  check('A18 R-0005 只引窗口一句 ⇒ CROSS_SPAN_EVIDENCE_MISSING，不可精确定位',
    nf.diagnostics.some((d) => d.code === 'CROSS_SPAN_EVIDENCE_MISSING') && nf.actionable === false,
    JSON.stringify(nf.diagnostics.map((d) => d.code)));
}

// ── A19：identity —— issues.id 与 findings.id 对不上 ⇒ 阻塞，不按位置猜配 ────
{
  const integ = RC.validateReviewIntegrity({
    schema_version: 'review.v3',
    issues: [{ id: 'R-0001', text: 'A' }],
    findings: [{ id: 'R-0002', title: 'B' }],
  });
  check('A19 issues/findings 编号错位 ⇒ REVIEW_ID_MAPPING_BROKEN（拒绝按位置猜配）',
    integ.ok === false && integ.code === 'REVIEW_ID_MAPPING_BROKEN', JSON.stringify(integ));
}

// ── A20：重复清单（9 条正文明细 + 9 条同义行）不双计数 ──────────────────────
{
  const issues = findings.map((f) => ({ id: f.id, text: `[${f.id}] ${f.rationale}` }));
  const structured = structureReviewReport({ summary: 's', strengths: [], issues, findings }, { text: BEFORE });
  const unlinked = (structured.issues || []).filter((i) => i && !i.id);
  check('A20 同一批问题重复展示 ⇒ 9 个 canonical ID、0 条无 ID 伪项（不把分母翻倍）',
    structured.issues.length === 9 && unlinked.length === 0,
    JSON.stringify({ total: structured.issues.length, unlinked: unlinked.length }));
}

// ── A21：底稿 hash 变化 ⇒ BASE_STALE，不套用旧跨度 ──────────────────────────
{
  const edit = { issue: 'R-0006', original: '他把这一行看了两遍，又去看底下那行小字。', replacement: '他把这行小字看了两遍。' };
  const r = runCase({
    select: ['R-0006'], findings: [byId.get('R-0006')], edits: [edit],
    semantic: { 'R-0006': { status: 'pass' } },
    plan: { issue_id: 'R-0006', base_hash: 'fnv1a:base-at-review' },
    currentBaseHash: 'fnv1a:changed-after-review',
  });
  const q = rowOf(r, 'R-0006');
  check('A21 底稿 hash 与计划快照不同 ⇒ BASE_STALE，该项不得判通过',
    q.final_status === 'UNRESOLVED' && q.reason_code === 'BASE_STALE', JSON.stringify({ s: q.final_status, c: q.reason_code }));
  check('A22 同一个 hash 时 BASE_STALE 不响（阴性对照，避免"永远过期"）；缺哈希 = 未知，不冒充一致',
    CL.isBaseStale({ plannedBaseHash: 'h1', currentBaseHash: 'h1' }).stale === false
    && CL.isBaseStale({ plannedBaseHash: 'h1', currentBaseHash: 'h2' }).stale === true
    && CL.isBaseStale({}).unknown === true, JSON.stringify(CL.isBaseStale({})));
}

// ── A23：工作区把「改错位置」显示成可读状态，不混成普通"未通过" ──────────────
{
  const view = RW.issueRowsOf({
    rows: [{ issue_id: 'R-0003', title: 't', final_status: 'UNRESOLVED', reason_code: 'UNRELATED_CHANGE', target_verdict: 'WRONG_TARGET' }],
  });
  const row = (view || [])[0] || {};
  check('A23 工作区行状态：WRONG_TARGET 显示为「改错位置」而不是泛化的"未通过"',
    row.status_text === '改错位置（未通过）' && row.target_text === '改错位置', JSON.stringify({ t: row.status_text, m: row.target_text }));
}

// ── A24：报告自洽性——活库真实的两条"无关反例"不再进「需加限定」 ─────────────
{
  const LIVE_TEXT = [
    '江陵市第三检测中心外的广场上排着四条长队，从正门一直拖到马路牙子。',
    '他左前方一个中年男人一直在打电话，反复说“排着呢，中午前应该能进去”，说到第四遍的时候，队伍又动了。',
    '林清雪把手按在石板上，光柱冲天。',
  ].join('');
  const LIVE_STRENGTHS = [
    '检测石的物理性写得实：上一个人的粉嵌在浅纹里、袖口蹭了灰白粉——超自然流程落地成手续，最后把“接受普通”落在一个动作上，没有一句心理总结。',
    '母亲那三句把全章重量卸在饭桌上，与大厅里仍在叫号的广播互不解释；结尾钩子干净，没有多余的余韵段。',
  ];
  const c = checkReportConsistency({ strengths: LIVE_STRENGTHS, issues: [], text: LIVE_TEXT });
  check('A24 「一直在打电话」与「一直拖到马路牙子」不再被当作心理/解释反例',
    c.strength_qualifications.length === 0, JSON.stringify(c.strength_qualifications.map((q) => q.evidence)));
  check('A25 被筛掉的候选反例仍有留痕（support_relation=unknown，不是静默消失）',
    c.suppressed_qualifications.length >= 1
    && c.suppressed_qualifications.every((s) => s.support_relation !== 'contradicts'),
    JSON.stringify(c.suppressed_qualifications.map((s) => s.support_relation)));
  const real = checkReportConsistency({
    strengths: ['林清雪那段只给动作，没有一句内心独白。'],
    issues: [],
    text: '林清雪把手按在石板上。她没说话。他从小觉得人应该是这样。',
  });
  check('A26 （阳性对照）同一话题上确有心理句时仍给 contradicts，不把真问题一起筛掉',
    real.strength_qualifications.length === 1
    && real.strength_qualifications[0].support_relation === 'contradicts'
    && real.strength_qualifications[0].evidence.includes('从小觉得'),
    JSON.stringify(real.strength_qualifications.map((q) => q.evidence)));
  const dialogueOnly = checkReportConsistency({
    strengths: ['他头也没抬，没有一句心理描写。'],
    issues: [],
    text: '他头也没抬：“知道了！”',
  });
  check('A27 （阴性对照）角色台词里的「知道」不算心理叙述',
    dialogueOnly.strength_qualifications.length === 0, JSON.stringify(dialogueOnly.strength_qualifications));
}

// ── A28：缺字段的 finding 仍被保留但降级（E-01 的 fail-closed） ──────────────
{
  const broken = { ...byId.get('R-0006') };
  delete broken.kind;
  delete broken.suggested_action;
  delete broken.reading_cost;
  const out = normalizeNarrativeFindings([broken], { text: BEFORE });
  const f = out.findings[0];
  check('A28 缺 kind/suggested_action/reading_cost ⇒ hypothesis + auto_eligible=false，证据保留',
    f && f.verdict === 'hypothesis' && f.auto_eligible === false
    && f.shape_defects.length === 3 && f.evidence.length > 0,
    JSON.stringify({ v: f && f.verdict, d: f && f.shape_defects, ev: f && f.evidence.length }));
}

// ── A29：页面真实装载顺序（模块存在但页不加载 = 全线失效） ─────────────────
{
  const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');
  // 只认真实的 <script src> 标签顺序：html 里别处也可能出现 app.js 字样。
  const srcs = [...html.matchAll(/<script\s+src="\/([^"]+)"/g)].map((m) => m[1]);
  const wanted = ['revision-findings.js', 'revision-semantic-verifier.js', 'revision-finalize.js', 'review-contract.js', 'app.js'];
  const order = wanted.map((n) => srcs.indexOf(n));
  check('A29 index.html 按真实依赖顺序装载修稿/验收/契约模块，且 app.js 最后',
    order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), JSON.stringify(order));
}

// ── A30–A36：审稿底本指纹（2026-10-23，review#32 的 base_hash 为空） ─────────
{
  const SAMPLE = '检测完成，宿主符合绑定条件。\n';

  check('A30 base_hash 与前端快照同一算法（fnv1a32+len，逐字同格式）',
    typeof RP.textFingerprint === 'function'
    && baseFingerprint(SAMPLE) === RP.textFingerprint(SAMPLE)
    && /^fnv1a:[0-9a-f]+:\d+$/.test(baseFingerprint(SAMPLE)),
    JSON.stringify({ server: baseFingerprint(SAMPLE), client: RP.textFingerprint(SAMPLE) }));

  check('A31 base_sha256 是真实 sha256（空串与 abc 的已知向量）',
    baseSha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    && baseSha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    baseSha256('abc'));

  const auto = resolveBaseHash({ quoteBaseText: SAMPLE });
  const given = resolveBaseHash({ provided: 'fnv1a:dead:7', quoteBaseText: SAMPLE });
  check('A32 没给 hash ⇒ 由被审底本计算；给了但与底本不符 ⇒ 保留原值并留 mismatch 痕迹',
    auto.base_hash === baseFingerprint(SAMPLE) && auto.source === 'computed_from_quote_base'
    && /^sha256:[0-9a-f]{64}$/.test(auto.base_sha256)
    && given.base_hash === 'fnv1a:dead:7' && given.base_hash_mismatch === true
    && given.base_hash_computed === baseFingerprint(SAMPLE),
    JSON.stringify({ auto: auto.source, mismatch: given.base_hash_mismatch }));

  const empty = resolveBaseHash({ quoteBaseText: '' });
  check('A33 空底本不产生"空字符串哈希"（state=missing，不冒充一致）',
    empty.base_hash === '' && empty.state === 'missing' && empty.base_sha256 === '',
    JSON.stringify(empty));

  const legacy = structureReviewReport({ summary: 's', strengths: [], findings: [] }, {
    text: 'x', baseHash: 'fnv1a:1:1', baseHashSource: 'computed_from_quote_base',
  });
  const v2 = structureReviewReport({
    summary: 's', strengths: [], issues: [{ id: 'R-0006', text: 't' }], findings: [byId.get('R-0006')],
  }, { text: BEFORE, baseHash: 'fnv1a:2:2', baseHashSource: 'computed_from_quote_base' });
  check('A34 旧口径与 review_v2 两条返回路径都携带 base_hash/source（不只新格式有）',
    legacy.base_hash === 'fnv1a:1:1' && legacy.base_hash_source === 'computed_from_quote_base'
    && v2.base_hash === 'fnv1a:2:2' && v2.base_hash_source === 'computed_from_quote_base',
    JSON.stringify({ legacy: legacy.base_hash, v2: v2.base_hash }));

  const stored = derivedBaseHash({ base_hash: 'fnv1a:9:9', base_text: 'x' });
  const derived = derivedBaseHash({ base_text: SAMPLE });
  const missing = derivedBaseHash({});
  check('A35 读路径三态：存了=stored；没存但有底本=derived（不重写历史）；都没有=missing',
    stored.base_hash_state === 'stored' && derived.base_hash_state === 'derived'
    && derived.base_hash === baseFingerprint(SAMPLE) && derived.base_hash_source === 'derived_on_read'
    && missing.base_hash_state === 'missing',
    JSON.stringify({ stored: stored.base_hash_state, derived: derived.base_hash_state, missing: missing.base_hash_state }));

  const server = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  check('A36 服务端真的接线：保存时由 quoteBase.text 计算、回执带指纹、读路径派生',
    /resolveBaseHash\(\{\s*provided:[\s\S]{0,160}?quoteBaseText:\s*quoteBase \? quoteBase\.text/.test(server)
    && /base_hash_mismatch: structured\.base_hash_mismatch === true/.test(server)
    && server.includes('...derivedBaseHash(report)'),
    'server.js 静态接线');

  // A37：归一化视图只保留 base_hash（实测），所以第二次读取必须从 raw payload 回填其余指纹字段。
  const normalized = RC.normalizeStoredReviewReport({
    base_hash: 'fnv1a:5:5', base_sha256: 'sha256:x', base_hash_alg: 'fnv1a32+len',
    base_hash_source: 'computed_from_quote_base', base_text: 'abc', issues: [],
  }, 1);
  check('A37 归一化只保 base_hash ⇒ 读路径必须从 raw 回填 alg/sha256/source（否则二次读取丢半套指纹）',
    normalized.base_hash === 'fnv1a:5:5' && !normalized.base_sha256
    && /for \(const k of \['base_hash', 'base_hash_alg', 'base_sha256', 'base_hash_source', 'base_hash_computed'\]\)/.test(server),
    JSON.stringify({ kept: normalized.base_hash, sha: normalized.base_sha256 || '' }));
}

const result = finish('2026-10-23 审稿—修稿—终验回放');
process.exitCode = result.failures ? 1 : 0;
