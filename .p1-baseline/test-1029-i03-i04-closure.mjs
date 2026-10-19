#!/usr/bin/env node
/**
 * test-1029-i03-i04-closure.mjs —— v1.2.5：用**用户这次的 I01–I08 样本**钉住
 * "审稿发现问题但修稿未完成"这条链路的判定口径（方案 §2 / §7 / §12.1 的 RT 矩阵）。
 *
 * 为什么必须有这个套件：
 *   A01–A08 / B01–B08 夹具（test-1024）证明了"旧缺陷能被识别"，但它们不是**这一次**的
 *   8 条样本。这一次的失败形态是：I03 完全没改（原文还在），I04 只改了分级解释、跨段
 *   矛盾仍在。若只靠"补丁应用数"或"模型说 pass"，这两条都会被读成已处理。
 *
 * 钉住的不变式：
 *   RT-01 8 全选 + 真实修后形态（6 修复 / 1 部分 / 1 未修）⇒ 计数与原因码必须一致；
 *   RT-02/03/04 I03：未改必须 FAIL；只删关键词不算修好；真修好可 PASS；
 *   RT-05/06 I04：只改"越高→越亮"不得 PASS；跨段矛盾仍在 ⇒ PARTIAL（语义层）或 FAIL（字面仍留）；
 *   RT-08 多证据（5 处）必须全部进入账本；
 *   RT-09 复修 I03 后，先前 6 条 PASS 不得被"确定性重验"冲成待验；
 *   RT-11 后端只收到 7 条时，第 8 条不得凭空消失（分母恒为 8）；
 *   RT-21/22/24/25 模型自述/未跑语义/假修复/等价改写的判定；
 *   RT-27/28 分段：跨段证据必须指出"哪一片没被处理"；
 *   RT-34 全部通过但作者未合并 ⇒ 候选态，不是已入库；
 *   RT-39/40 追踪脱敏与最终统计分母。
 *
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
const asUrl = (rel) => new URL('../' + rel, import.meta.url).href;
await import(asUrl('public/revision-semantic-verifier.js'));
await import(asUrl('public/revision-closure.js'));
await import(asUrl('public/revision-finalize.js'));
await import(asUrl('public/revision-trace.js'));
await import(asUrl('public/review-workspace.js'));
const SV = globalThis.NovelRevisionSemanticVerifier;
const CL = globalThis.NovelRevisionClosure;
const FZ = globalThis.NovelRevisionFinalize;
const TR = globalThis.NovelRevisionTrace;
const RW = globalThis.NovelRevisionWorkspace;

// ── 固定样本：用户这次 8 条问题所在的那一屏（I01–I08 的原文锚点各一处）──────────
const BASE = [
  '九月的早晨，棚外已经排起长队。',
  '登记员敲了敲桌沿：“下一位。”他又喊了一遍：“下一位。”',
  '李拓把检测单往前挪了小半步。',
  '她显然准备好了更长的安慰，比如“D级也有D级的前途”“普通职业更稳当”。',
  '“不是闪光，是金色的光。”有人低声说。',
  '“光柱越高，等级越好。”登记员随口解释，“去年有个孩子的光柱顶到棚顶了，B级。A级就不好说了，金红那种，棚顶都压不住。”',
  '金红色的光柱只顶到了棚布，李拓站着没动，他并不失望。',
  '“A级，职业方向：战斗系。”',
  '李拓不由得笑了。',
].join('\n\n');

const QUOTE = {
  i01: '九月的早晨，棚外已经排起长队。',
  i02: '“不是闪光，是金色的光。”',
  i03: '她显然准备好了更长的安慰，比如“D级也有D级的前途”“普通职业更稳当”。',
  i04a: '光柱越高，等级越好',
  i04b: '去年有个孩子的光柱顶到棚顶了，B级',
  i04c: 'A级就不好说了，金红那种，棚顶都压不住',
  i04d: '金红色的光柱只顶到了棚布',
  i04e: 'A级，职业方向：战斗系',
  i05: '把检测单往前挪了小半步',
  i06: '李拓站着没动，他并不失望。',
  i07: '“下一位。”他又喊了一遍：“下一位。”',
  i08: '李拓不由得笑了。',
};
const FIXED = {
  i01: '3751年九月一日的早晨，棚外已经排起长队。',
  i02: '“金色的光。”',
  i03: '那女人张了张嘴，停了一下，最后只是点了点头，把矿泉水往他那边递了递：“拿着喝。”',
  i04a: '光的颜色决定等级，亮度只是顺带',
  i04c: 'A级就不好说了，金红那种，颜色一出来，全场都能看见',
  i05: '把检测单往前挪了挪',
  i06: '李拓站着没动，把检测单叠好塞回口袋。',
  i07: '“下一位。”他敲了敲桌沿。',
  i08: '李拓笑了一下。',
};

function finding(id, title, evidence, acceptance = {}) {
  return { id, title, type: 'style', severity: 'high', evidence, acceptance };
}
// I04 的两个版本：partial 版把"棚顶"claim 作为只读证据（作者没选中它）；
// full 版把它也列为可编辑目标（这次授权允许改）。
const fI04Partial = finding('I04', 'A 级光柱高度与分级解释矛盾', [
  { quote: QUOTE.i04a, role: 'candidate_edit' },
  { quote: QUOTE.i04b, role: 'reference' },
  { quote: QUOTE.i04c, role: 'reference' },
  { quote: QUOTE.i04d, role: 'reference' },
  { quote: QUOTE.i04e, role: 'reference' },
], { rule: '分级解释、B 级例子、A 级说法、现场观测逻辑相容' });
const fI04Full = finding('I04', 'A 级光柱高度与分级解释矛盾', [
  { quote: QUOTE.i04a, role: 'candidate_edit' },
  { quote: QUOTE.i04b, role: 'reference' },
  { quote: QUOTE.i04c, role: 'candidate_edit' },
  { quote: QUOTE.i04d, role: 'reference' },
  { quote: QUOTE.i04e, role: 'reference' },
], { rule: '分级解释、B 级例子、A 级说法、现场观测逻辑相容' });

function findingsExcept(ids) {
  const all = [
    finding('I01', '开头缺 3751 年纪年锚点', [{ quote: QUOTE.i01, role: 'candidate_edit' }],
      { rule: '开头明确建立 3751 年', must_contain: ['3751年'] }),
    finding('I02', '否定—更正模板句', [{ quote: QUOTE.i02, role: 'candidate_edit' }],
      { rule: '冗余否定句消除，信息保留' }),
    finding('I03', '阿姨心理预演越出有限视角', [{ quote: QUOTE.i03, role: 'candidate_edit' }],
      { rule: '不得凭空陈述配角未说出口的心理' }),
    fI04Partial,
    finding('I05', '替动作定性并重复量词', [{ quote: QUOTE.i05, role: 'candidate_edit' }],
      { rule: '作者旁白不替动作定性' }),
    finding('I06', '直接确认主角“不失望”', [{ quote: QUOTE.i06, role: 'candidate_edit' }],
      { rule: '用行动呈现心理，不插总结句' }),
    finding('I07', '两次“下一位”流程播报重复', [{ quote: QUOTE.i07, role: 'candidate_edit' }],
      { rule: '重复步骤删减或具备新信息功能' }),
    finding('I08', '“不由得”红线表达', [{ quote: QUOTE.i08, role: 'candidate_edit' }],
      { rule: '冗词删除，且不重新引入同类红线' }),
  ];
  const skip = new Set(ids || []);
  return all.filter((f) => !skip.has(f.id));
}

function patchFor(issueId, quote, replacement, extra = {}) {
  const start = BASE.indexOf(quote);
  if (start < 0) throw new Error(`夹具错误：BASE 找不到「${quote.slice(0, 16)}」`);
  return {
    issue_ids: [issueId], span_id: `${issueId}-p1`, op: 'replace',
    original: quote, replacement, start, end: start + quote.length, ...extra,
  };
}
function patchesOf(map) {
  return Object.entries(map).map(([issueId, [quote, replacement]]) => patchFor(issueId, quote, replacement));
}
/** 用补丁重建候选稿：保证"候选 = 补丁逐字重建"，不会出现无记录改动。 */
function candidateFrom(patches) {
  const r = SV.reconstruct(BASE, patches);
  if (!r.ok) throw new Error(`夹具错误：${r.code}`);
  return r.text;
}
const SEMANTIC_PASS = (ids) => Object.fromEntries(ids.map((id) => [id, { status: 'pass', reason: '独立复核通过', confidence: 'high' }]));

// ── RT-01：用户这次的修后形态（6 修复 / I03 未修 / I04 部分修复）──────────────
{
  const partialPatches = patchesOf({
    I01: [QUOTE.i01, FIXED.i01], I02: [QUOTE.i02, FIXED.i02],
    I04: [QUOTE.i04a, FIXED.i04a],
    I05: [QUOTE.i05, FIXED.i05], I06: [QUOTE.i06, FIXED.i06],
    I07: [QUOTE.i07, FIXED.i07], I08: [QUOTE.i08, FIXED.i08],
  });
  const after = candidateFrom(partialPatches);
  const findings = findingsExcept([]);
  const selected = ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08'];
  const semanticByIssue = {
    ...SEMANTIC_PASS(['I01', 'I02', 'I05', 'I06', 'I07', 'I08']),
    I03: { status: 'fail', reason: '“她显然准备好了更长的安慰”仍在：视角仍越界' },
    I04: { status: 'partial', reason: '总规则改了，但“棚顶都压不住”与现场“只顶到棚布”仍冲突', reason_code: 'CROSS_SPAN_CONTRADICTION_REMAINS', remaining_evidence: [QUOTE.i04c] },
  };
  const coverage = selected.map((id) => ({
    issue_id: id,
    status: id === 'I03' ? 'keep' : 'patched',
    target_count: id === 'I04' ? 1 : 1,
    reference_count: id === 'I04' ? 4 : 0,
  }));
  const rt01 = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: after,
    selectedIssueIds: selected, applied: partialPatches, coverage, findings, semanticByIssue,
  });
  const byId = Object.fromEntries(rt01.rows.map((r) => [r.issue_id, r]));
  check('RT-01 6 修复 / 1 部分 / 1 未修：计数、原因码与分母都必须与样本一致',
    rt01.summary.verified === 6 && rt01.summary.partial === 1 && rt01.summary.unresolved === 1
      && rt01.rows.length === 8 && rt01.status === 'PARTIAL_CANDIDATE'
      && byId.I03.final_status === 'UNRESOLVED' && byId.I03.reason_code === 'ANCHOR_NOT_EDITED'
      && byId.I04.final_status === 'PARTIAL' && byId.I04.reason_code === 'CROSS_SPAN_CONTRADICTION_REMAINS',
    JSON.stringify({ summary: rt01.summary, status: rt01.status, i03: [byId.I03.final_status, byId.I03.reason_code], i04: [byId.I04.final_status, byId.I04.reason_code] }));

  check('RT-40 最终统计分母 = 全部已选（6+1+1=8），不因"没修好"而少两条',
    rt01.summary.total === 8
      && (rt01.summary.verified + rt01.summary.partial + rt01.summary.unresolved
        + rt01.summary.awaiting_semantic + rt01.summary.canon_conflict) === 8,
    JSON.stringify(rt01.summary));

  check('RT-01b I04 行带 actual_change / patch_ids / evidence_ids（能证明"改过哪里"）',
    byId.I04.actual_change === true && byId.I04.patch_ids.length === 1
      && byId.I04.evidence_ids.length === 5 && byId.I04.evidence_count === 5,
    JSON.stringify({ actual: byId.I04.actual_change, patches: byId.I04.patch_ids, evidence: byId.I04.evidence_ids }));

  check('RT-01c I03 行 actual_change=false：完全未修改与"改了但仍有问题"必须可区分',
    byId.I03.actual_change === false && byId.I03.patch_ids.length === 0,
    JSON.stringify({ actual: byId.I03.actual_change, patches: byId.I03.patch_ids }));

  // RT-39：追踪事件必须脱敏且覆盖每条问题
  const record = FZ.runRecordOf(rt01, { lastUpdate: '2026-10-18T00:00:00.000Z' });
  const red = TR.checkRedaction(record.trace, BASE);
  check('RT-39 运行记录带 revision-trace.v1 且不含正文：事件数 = 1 条运行 + 8 条问题',
    record.trace.length === 9 && red.ok === true
      && record.trace.filter((e) => e.event === 'issue_verdict').length === 8
      && !JSON.stringify(record.trace).includes(BASE.slice(0, 24)),
    JSON.stringify({ events: record.trace.length, redaction: red }));

  // RT-34：作者未合并 ⇒ 候选态；合并且版本一致才 PERSISTED_VERIFIED
  const twoPatches = partialPatches.filter((p) => p.issue_ids.some((id) => ['I01', 'I02'].includes(id)));
  const twoCandidate = candidateFrom(twoPatches);
  const twoCoverage = coverage.filter((c) => ['I01', 'I02'].includes(c.issue_id));
  const allPass = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: twoCandidate,
    selectedIssueIds: ['I01', 'I02'], applied: twoPatches,
    coverage: twoCoverage, findings,
    semanticByIssue: SEMANTIC_PASS(['I01', 'I02']),
  });
  const persisted = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: twoCandidate, persisted: true, baseMatches: true,
    selectedIssueIds: ['I01', 'I02'], applied: twoPatches,
    coverage: twoCoverage, findings,
    semanticByIssue: SEMANTIC_PASS(['I01', 'I02']),
  });
  check('RT-34 全部通过但作者未合并 ⇒ VERIFIED_CANDIDATE；只有写回且版本一致才 PERSISTED_VERIFIED',
    allPass.status === 'VERIFIED_CANDIDATE' && persisted.status === 'PERSISTED_VERIFIED',
    JSON.stringify({ unmerged: allPass.status, merged: persisted.status }));

  // ── S6：审稿工作区按真实终态渲染（PARTIAL 不能被画成已验证）──────────────
  {
    const counts = RW.countsOf(rt01.rows);
    const line = RW.summaryLine({ rows: rt01.rows, chapterTitle: '第 121 章' });
    const displayRows = RW.issueRowsOf({ rows: rt01.rows });
    const i04Row = displayRows.find((r) => r.issue_id === 'I04');
    const pending = RW.filterRows(rt01.rows, 'pending').map((r) => r.issue_id);
    const acts = RW.actionsOf({ stage: 'PARTIAL_CANDIDATE', rows: rt01.rows, semanticRuns: 1 });
    check('WS-01 状态条区分“已验证 / 未通过 / 局部”，部分修复不被画成通过',
      counts.verified === 6 && counts.partial === 1 && counts.unresolved === 1
        && /已验证\s*6/.test(line) && /局部\s*1/.test(line) && /未通过\s*1/.test(line),
      JSON.stringify({ counts, line }));
    check('WS-02 左侧问题行：I04 显示“只解决局部”（warn），且“待处理”筛选包含未通过/局部',
      i04Row && i04Row.status_text === '只解决局部' && i04Row.tone === 'warn'
        && pending.includes('I04') && pending.includes('I03') && !pending.includes('I01'),
      JSON.stringify({ i04: i04Row && [i04Row.status_text, i04Row.tone], pending }));
    check('WS-03 部分完成只给“合并（仍有 2 条未通过）”，不出现“全部已验证再合并”的主按钮',
      acts.some((a) => a.action === 'merge-partial' && /仍有\s*2\s*条未通过/.test(a.label))
        && !acts.some((a) => a.action === 'merge'),
      JSON.stringify(acts.map((a) => a.action)));
  }

  // ── S7：单段与分段在同一夹具上给同义判定（Q-10 的本次样本回归）─────────────
  {
    const seg = FZ.finalizeRevisionCandidate({
      mode: 'segmented', originalText: BASE, candidateText: after,
      selectedIssueIds: selected,
      applied: partialPatches.map((p) => ({ ...p, segment_id: 'seg-1' })),
      segmentCoverage: coverage,
      segments: [{ segment_id: 'seg-1', status: 'done', proof_ok: true }],
      mergeComplete: true, findings, semanticByIssue,
    });
    const sig = (r) => JSON.stringify(r.rows.map((x) => [x.issue_id, x.final_status, x.reason_code]));
    check('RT-10 同一份 8 项夹具：单请求与分段路径的逐条终态一致（不会换条路径换结论）',
      seg.status === rt01.status && sig(seg) === sig(rt01),
      JSON.stringify({ single: rt01.status, segmented: seg.status, same: sig(seg) === sig(rt01) }));
  }
}

// ── RT-02 / 03 / 04：I03（完全漏修 / 真修 / 假修）──────────────────────────
{
  const findings = [finding('I03', '阿姨心理预演越出有限视角', [{ quote: QUOTE.i03, role: 'candidate_edit' }],
    { rule: '不得凭空陈述配角未说出口的心理' })];
  const original = BASE;
  const unchanged = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: original, candidateText: original,
    selectedIssueIds: ['I03'], findings, coverage: [{ issue_id: 'I03', status: 'keep' }],
    semanticByIssue: { I03: { status: 'pass', reason: '模型自述已修好' } },
  });
  check('RT-02 I03 完全未改：模型谎称 pass 也必须 FAIL（ANCHOR_NOT_EDITED）',
    unchanged.rows[0].final_status === 'UNRESOLVED' && unchanged.rows[0].reason_code === 'ANCHOR_NOT_EDITED'
      && unchanged.rows[0].actual_change === false,
    JSON.stringify(unchanged.rows[0]));

  const fixedPatches = [patchFor('I03', QUOTE.i03, FIXED.i03)];
  const fixed = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: original, candidateText: candidateFrom(fixedPatches),
    selectedIssueIds: ['I03'], findings, applied: fixedPatches,
    coverage: [{ issue_id: 'I03', status: 'patched' }],
    semanticByIssue: { I03: { status: 'pass', reason: '改为动作与言语，未越界' } },
  });
  check('RT-03 I03 真修好（动作替代心理预演）⇒ PASS',
    fixed.rows[0].final_status === 'ISSUE_VERIFIED' && fixed.rows[0].actual_change === true,
    JSON.stringify(fixed.rows[0]));

  // 假修：只删"显然"，越界心理内容还在
  const fakeQuote = QUOTE.i03;
  const fakeAfter = fakeQuote.replace('她显然准备好了更长的安慰，比如', '她张了张嘴，似乎想说些安慰的话，比如');
  const fakePatches = [patchFor('I03', fakeQuote, fakeAfter)];
  const fake = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: original, candidateText: candidateFrom(fakePatches),
    selectedIssueIds: ['I03'], findings, applied: fakePatches,
    coverage: [{ issue_id: 'I03', status: 'patched' }],
    semanticByIssue: { I03: { status: 'fail', reason: '仍凭空叙述她的心理活动' } },
  });
  check('RT-04 I03 假修复（只删“显然”）⇒ 不得 PASS（语义层判 FAIL）',
    fake.rows[0].final_status === 'UNRESOLVED' && fake.rows[0].reason_code === 'SEMANTIC_FAILED',
    JSON.stringify(fake.rows[0]));

  const fakeNoSem = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: original, candidateText: candidateFrom(fakePatches),
    selectedIssueIds: ['I03'], findings, applied: fakePatches,
    coverage: [{ issue_id: 'I03', status: 'patched' }],
  });
  check('RT-04b 假修复 + 未跑语义 ⇒ 停在待验收（AWAITING_SEMANTIC），不得静默通过',
    fakeNoSem.rows[0].final_status === 'AWAITING_SEMANTIC' && fakeNoSem.summary.verified === 0,
    JSON.stringify(fakeNoSem.rows[0]));

  // RT-24 假阳性：等价矛盾仍在（换了说法，但仍是心理预演）
  const fakePositive = fakeNoSem;
  check('RT-24 原句消失但等价矛盾仍保留：不因“关键词没了”判通过',
    fakePositive.rows[0].final_status !== 'ISSUE_VERIFIED', JSON.stringify(fakePositive.rows[0]));

  // RT-25 假阴性：表达完全不同但真的解决了 → 语义复验可以 PASS
  check('RT-25 表达换了但条件真的满足 ⇒ 语义复验可以 PASS',
    fixed.rows[0].final_status === 'ISSUE_VERIFIED', JSON.stringify(fixed.rows[0]));
}

// ── RT-05 / RT-06：I04（只改一句 / 全链相容）───────────────────────────────
{
  const findingsPartial = [fI04Partial];
  const findingsFull = [fI04Full];
  const onlyA = [patchFor('I04', QUOTE.i04a, FIXED.i04a)];
  const aAndC = [...onlyA, patchFor('I04', QUOTE.i04c, FIXED.i04c)];

  const noSem = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: candidateFrom(onlyA),
    selectedIssueIds: ['I04'], findings: findingsPartial, applied: onlyA,
    coverage: [{ issue_id: 'I04', status: 'patched' }],
  });
  check('RT-05 I04 只改“越高→越亮”、未跑语义 ⇒ 不得 PASS（停在待验收）',
    noSem.rows[0].final_status !== 'ISSUE_VERIFIED' && noSem.summary.verified === 0,
    JSON.stringify(noSem.rows[0]));

  const partial = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: candidateFrom(onlyA),
    selectedIssueIds: ['I04'], findings: findingsPartial, applied: onlyA,
    coverage: [{ issue_id: 'I04', status: 'patched' }],
    semanticByIssue: { I04: { status: 'partial', reason: '“棚顶都压不住”与“只顶到棚布”仍冲突', reason_code: 'CROSS_SPAN_CONTRADICTION_REMAINS', remaining_evidence: [QUOTE.i04c] } },
  });
  check('RT-05b I04 跨段矛盾仍在 ⇒ PARTIAL + CROSS_SPAN_CONTRADICTION_REMAINS（不是 PASS）',
    partial.rows[0].final_status === 'PARTIAL'
      && partial.rows[0].reason_code === 'CROSS_SPAN_CONTRADICTION_REMAINS'
      && partial.rows[0].remaining_evidence.length >= 1,
    JSON.stringify(partial.rows[0]));

  const full = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: candidateFrom(aAndC),
    selectedIssueIds: ['I04'], findings: findingsFull, applied: aAndC,
    coverage: [{ issue_id: 'I04', status: 'patched' }],
    semanticByIssue: { I04: { status: 'pass', reason: '规则、例子、现场观测相容' } },
  });
  check('RT-06 I04 完整修复（总规则与“棚顶”说法一起闭合）⇒ PASS',
    full.rows[0].final_status === 'ISSUE_VERIFIED' && full.rows[0].actual_change === true,
    JSON.stringify(full.rows[0]));

  // RT-08：5 处证据必须全部进账本
  check('RT-08 同一问题的 5 处证据全部进入验收（不是只取第一句）',
    partial.rows[0].evidence_ids.length === 5 && partial.rows[0].evidence_count === 5,
    JSON.stringify({ ids: partial.rows[0].evidence_ids, count: partial.rows[0].evidence_count }));
}

// ── RT-09：复修后，先前 PASS 的条目不得被冲成"待验" ─────────────────────────
{
  const prior = {
    issues: [
      ...['I01', 'I02', 'I05', 'I06', 'I07', 'I08'].map((id) => ({ issue_id: id, verdict: 'pass', final_status: 'ISSUE_VERIFIED', semantic_status: 'pass', checks: [] })),
      { issue_id: 'I03', verdict: 'fail', final_status: 'UNRESOLVED', semantic_status: 'fail', checks: [] },
      { issue_id: 'I04', verdict: 'partial', final_status: 'PARTIAL', semantic_status: 'partial', checks: [] },
    ],
    summary: { verified: 6, unresolved: 1, partial: 1 },
  };
  const deterministic = {
    issues: prior.issues.map((i) => ({ issue_id: i.issue_id, verdict: 'need_context', final_status: 'AWAITING_SEMANTIC', semantic_status: 'not_run', checks: [] })),
    summary: { diff_ok: true },
  };
  const merged = CL.mergeRepairSemantic(prior, deterministic, ['I03']);
  const byId = Object.fromEntries(merged.issues.map((i) => [i.issue_id, i]));
  check('RT-09 复修 I03 后：先前 6 条 PASS 保留，I03 待复验，I04 部分修复不被抹掉',
    merged.summary.verified === 6 && byId.I03.verdict === 'need_context' && byId.I04.verdict === 'partial',
    JSON.stringify(merged.summary));
}

// ── RT-11：勾选 8 条、后端只收到 7 条 ─────────────────────────────────────
{
  const findings = findingsExcept(['I03']);
  const patches = patchesOf({
    I01: [QUOTE.i01, FIXED.i01], I02: [QUOTE.i02, FIXED.i02], I04: [QUOTE.i04a, FIXED.i04a],
    I05: [QUOTE.i05, FIXED.i05], I06: [QUOTE.i06, FIXED.i06], I07: [QUOTE.i07, FIXED.i07], I08: [QUOTE.i08, FIXED.i08],
  });
  const rt11 = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: candidateFrom(patches),
    selectedIssueIds: ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08'],
    findings, applied: patches,
    coverage: ['I01', 'I02', 'I04', 'I05', 'I06', 'I07', 'I08'].map((id) => ({ issue_id: id, status: 'patched' })),
    semanticByIssue: SEMANTIC_PASS(['I01', 'I02', 'I05', 'I06', 'I07', 'I08']),
  });
  const i03 = rt11.rows.find((r) => r.issue_id === 'I03');
  check('RT-11 后端只收到 7 条：第 8 条必须显式出现并标未回答，绝不总结成 7/7',
    rt11.rows.length === 8 && i03.reason_code === 'UNACCOUNTED'
      && i03.final_status !== 'ISSUE_VERIFIED' && rt11.status !== 'VERIFIED_CANDIDATE',
    JSON.stringify({ rows: rt11.rows.length, i03: i03 && [i03.final_status, i03.reason_code], status: rt11.status }));
}

// ── RT-21 / RT-22：模型自述 vs 未跑语义 ──────────────────────────────────
{
  const findings = findingsExcept([]);
  const lying = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: BASE,
    selectedIssueIds: ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08'],
    findings, coverage: ['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08'].map((id) => ({ issue_id: id, status: 'patched' })),
    semanticByIssue: SEMANTIC_PASS(['I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08']),
  });
  check('RT-21 模型声称全部解决但正文未改 ⇒ 8 条全部 FAIL（硬事实压过自评），通过数为 0',
    lying.summary.verified === 0 && lying.summary.unresolved === 8,
    JSON.stringify(lying.summary));

  const i08Patch = [patchFor('I08', QUOTE.i08, FIXED.i08)];
  const noSem = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: BASE, candidateText: candidateFrom(i08Patch),
    selectedIssueIds: ['I08'], findings, applied: i08Patch, coverage: [{ issue_id: 'I08', status: 'patched' }],
  });
  check('RT-22 语义验收未运行 ⇒ AWAITING_SEMANTIC，绝不计入通过',
    noSem.rows[0].final_status === 'AWAITING_SEMANTIC' && noSem.summary.verified === 0,
    JSON.stringify(noSem.rows[0]));
}

// ── RT-27 / RT-28：分段路径的跨段证据 ────────────────────────────────────
{
  const patches = [patchFor('I04', QUOTE.i04a, FIXED.i04a, { segment_id: 'seg-1' })];
  const seg = FZ.finalizeRevisionCandidate({
    mode: 'segmented', originalText: BASE, candidateText: candidateFrom([patchFor('I04', QUOTE.i04a, FIXED.i04a)]),
    selectedIssueIds: ['I04'], findings: [fI04Full], applied: patches,
    coverage: [], segmentCoverage: [],
    segments: [
      { segment_id: 'seg-1', status: 'done', proof_ok: true, evidence_editable_issue_ids: ['I04'] },
      { segment_id: 'seg-2', status: 'done', proof_ok: true, evidence_editable_issue_ids: ['I04'] },
    ],
    mergeComplete: true,
  });
  const row = seg.rows[0];
  check('RT-28 同一问题证据跨两片、只改了一片 ⇒ 行上明确"哪一片没被处理"（不得判通过）',
    row.cross_segment && row.cross_segment.split === true
      && row.cross_segment.untouched_segments.join(',') === 'seg-2'
      && row.final_status !== 'ISSUE_VERIFIED',
    JSON.stringify({ cross: row.cross_segment, final: row.final_status, code: row.reason_code }));

  check('RT-27 分段缺语义结论时同样停在待验收（与单段同一判据，不因分段而放宽）',
    seg.summary.verified === 0 && seg.status !== 'VERIFIED_CANDIDATE',
    JSON.stringify({ status: seg.status, summary: seg.summary }));
}

// ── 语义层异常状态：unverified / blocked 不得被当成通过 ────────────────────
{
  const findings = [finding('I03', '视角越界', [{ quote: QUOTE.i03, role: 'candidate_edit' }], { rule: '不得越界' })];
  const patches = [patchFor('I03', QUOTE.i03, FIXED.i03)];
  for (const status of ['unverified', 'blocked']) {
    const out = FZ.finalizeRevisionCandidate({
      mode: 'single', originalText: BASE, candidateText: candidateFrom(patches),
      selectedIssueIds: ['I03'], findings, applied: patches,
      coverage: [{ issue_id: 'I03', status: 'patched' }],
      semanticByIssue: { I03: { status, reason: '无法判定' } },
    });
    check(`RT-23 语义回包为 ${status} ⇒ 保持待验并带原因码 ${status === 'unverified' ? 'SEMANTIC_UNVERIFIED' : 'SEMANTIC_BLOCKED'}（不虚报通过）`,
      out.rows[0].final_status === 'AWAITING_SEMANTIC'
        && out.rows[0].reason_code === (status === 'unverified' ? 'SEMANTIC_UNVERIFIED' : 'SEMANTIC_BLOCKED'),
      JSON.stringify(out.rows[0]));
  }
}

finish('test-1029 I01–I08 修稿闭环回归（RT 矩阵）');
