/**
 * tests/narrative-repair/17-review-closure-0317.test.mjs ——《Novel Studio v1.1.8｜3月17日觉醒日：
 * 审稿与修稿新样本专项增补》（本文件简称《0317 增补》）§7 的 V118-01～V118-15。
 *
 * 与既有套件的分工（不重复、不覆盖）：
 *   · 11-review-closure：报告自洽（绝对措辞 × 正文反例）、reaction_causality 的 116 轮形状；
 *   · 13/14/16：授权身份、覆盖状态与 op 授权；
 *   · 07/04：引用核验与审稿协议。
 *   本套件只覆盖**本轮新增要求**：未经批准的制度/时间机制候选（new_workflow_rule /
 *   temporal_causal_bridge）、审稿报告引文的**归属核验**（quote_not_found）、
 *   strengths 绝对局限措辞的**限定建议**（strengths_needs_qualification）、
 *   同物件状态的**跨句桥接**候选（prop_state_continuity）、
 *   未选中问题不得假称已改（selection_status）、未跑语义核验不得报 resolved（semantic_not_run）、
 *   伏笔编号锚可见性（unknown_anchor）、以及常见等级结果引发全体中止反应的因果候选。
 *
 * ⚠️ 本套件对**语义层未运行**这件事的态度（§4）：
 *   确定性层只能证明"旧引文不见了"或"引文仍在"，**不能**证明语义上问题已解决。
 *   因此 V118-12 要求：没有语义核验输出时一律 `semantic_status:not_run`，**不得**给 resolved。
 *   这不是"永远不许 resolved"——语义层明确跑过并给出结论时可以 resolved（V118-12-b 的反例）。
 *
 * 零依赖、零计费；不连真实模型，不读真实作品库，不改任何正式稿件。
 */
import { createChecks, loadPublicModules } from './harness.mjs';
import { narrativeCandidateSignals } from '../../ai/editing/narrative-scan.mjs';
import {
  checkReportConsistency, structureReviewReport, auditReviewQuotes,
} from '../../ai/editing/narrative-review.mjs';

const { check, finish } = createChecks();
const { RP } = await loadPublicModules();
const PS = globalThis.NovelPatchSafety;

// ── 夹具：与《Novel_Studio_v118_0317回归样本.json》逐字一致 ────────────────────
// 只放**方案里逐字确认改变**的段落与判定需要的直接上下文，不含完整正文。
const FIX = {
  // R01：中午测完 → 天黑出门，补丁新增"下午的号按学校分批往下叫"
  r01Anchor: '走出检测中心大门的时候，天色已经暗了。',
  r01Revised: '下午的号按学校分批往下叫，他在外场又耽搁了一阵；走出检测中心大门的时候，天色已经暗了。',
  // 蓝图场景：中午的两段（"只剩十几个人"+"走了"）——时间缺口的**前半**
  noonBefore: '中午只剩十几个人了。\n\n十分钟一个变成三五分钟一个。\n\n王磊测完，说走了。',
  // R02：删掉"没有谁特意…"但三句安慰原话仍在（`r02Revised` 在 V118-04 就地定义，见下）
  // R07：删掉"二十米"，但"两步可见"与"几十人遮挡"仍在
  r07Quote: '检测台离他大概二十米',
  r07Still: ['再挪两步就能看见检测台', '几十个人', '看不清人脸'],
  r07Revised: '岳宸炎站在原地收回目光，没往前面再挤。他能看见光，但看不清人脸。队伍在他前面还有几十个人。',
  // 正文片段：引文核验与 strengths 限定用它
  chapter: [
    '“羡慕不？”',
    '“还行。”',
    '“还行？”王磊瞪着他，“他A级。”',
    '“就是，”王磊张了张嘴，“算了。你上去吧。”',
    '林清雪拿到一样东西之后没有笑，先低头看看手里多了什么。他从小觉得人应该是这样。',
    '岳宸炎把手机悬在半空，想拍大屏。',
    '后来他把手机举起来想拍大屏，举到一半又放下。',
  ].join('\n\n'),
};

// ══ V118-01：新增"按学校分批"须被识别为流程事实候选 ═══════════════════════════
{
  const scope = PS.classifyEditScope(FIX.r01Anchor, FIX.r01Revised, { baseText: FIX.noonBefore });
  const codes = (scope.signals || []).map((s) => s.code);
  check('V118-01-a 新增"下午的号按学校分批往下叫"必须被识别为 new_workflow_rule 候选',
    codes.includes('new_workflow_rule'),
    `scope=${scope.scope} signals=${JSON.stringify(codes)}`);
  check('V118-01-b 流程事实候选必须携带 evidence 原文（可复核，不是黑箱判定）',
    (scope.signals || []).some((s) => s.code === 'new_workflow_rule' && /分批/.test(String(s.evidence || ''))),
    JSON.stringify(scope.signals));
  check('V118-01-c 流程事实候选必须落到 story_fact（不得仅凭短于60字默认为 wording/无信号）',
    scope.scope === PS.SCOPE.STORY_FACT,
    `scope=${scope.scope}`);
  check('V118-01-d 该候选必须标 needs_fact_authorization（证据不足时不自动视为可信修稿）',
    (scope.signals || []).some((s) => s.code === 'new_workflow_rule' && s.needs_fact_authorization === true),
    JSON.stringify(scope.signals));
}

// ══ V118-02：蓝图/已批准文本里已有同一机制时，同一替换不得被永久硬拦 ══════════
{
  const approvedBase = '下午的号按学校分批往下叫，他在外场又耽搁了一阵；走出检测中心大门的时候，天色已经暗了。';
  const again = PS.classifyEditScope(FIX.r01Anchor, FIX.r01Revised, { baseText: approvedBase });
  const codes = (again.signals || []).map((s) => s.code);
  check('V118-02-a 已批准文本里存在同一"学校分批"机制时，不得再报 new_workflow_rule',
    !codes.includes('new_workflow_rule'),
    `scope=${again.scope} signals=${JSON.stringify(codes)}`);
  check('V118-02-b 该情形必须落 needs_fact_authorization=false 的可放行形态（不过度拒绝）',
    again.needs_fact_authorization !== true,
    JSON.stringify({ codes, nfa: again.needs_fact_authorization }));
}

// ══ V118-03：时间缺口不得靠新增流程句冒称已解决 ════════════════════════════════
{
  const bridge = PS.assessTemporalBridge
    ? PS.assessTemporalBridge(FIX.noonBefore, FIX.r01Revised, { baseText: FIX.noonBefore })
    : null;
  check('V118-03-a assessTemporalBridge 必须存在（时间缺口要可判定，不能只靠人读）',
    !!bridge && typeof bridge === 'object',
    String(typeof bridge));
  check('V118-03-b 中午测完说"走了"、傍晚才出门，且新增句只是无来源流程 → time_gap_unresolved',
    !!bridge && bridge.code === 'time_gap_unresolved' && bridge.resolved === false,
    JSON.stringify(bridge));
  // 反例（阴性对照）：新增的是**有来源的等待事件**时，时间缺口成立不了 → 不得报。
  const sourced = '他陪着王磊又把排号单交回去复核了一趟；走出检测中心大门的时候，天色已经暗了。';
  const okBridge = PS.assessTemporalBridge ? PS.assessTemporalBridge(FIX.noonBefore, sourced, { baseText: FIX.noonBefore }) : null;
  check('V118-03-c 阴性对照：有来源的等待事件（复核排号单）不得被判 time_gap_unresolved',
    !!okBridge && okBridge.code !== 'time_gap_unresolved',
    JSON.stringify(okBridge));
}

// ══ V118-04：删一条旁白 ≠ R02 解决（三句安慰原话仍在 → partially_resolved）═══════
{
  // ⚠️ 口径（与生产 `revisionIssueQuotes()` 一致）：`issues[].quotes` 来自**结构化审稿的
  //    finding evidence**，也就是"这条问题当初点名的原话"，不是方案叙述里的转述。
  //    R02 的问题是"D 级之后三句匿名安慰同义重复"，R02 的**改后文本**仍然原样保留了
  //    「没事，一样能考大学。」这句安慰原话——只删掉了后面那条解释性旁白。
  const r02Revised = '“没事，一样能考大学。”这些话从人群里飘过来。岳宸炎走到台阶旁边把书包捡起来，背到肩上。';
  const out = RP.issueCoverageCandidates({
    issues: [{ id: 'R02', quotes: ['没事，一样能考大学。'] }],
    coverage: [{ issue_id: 'R02', status: 'patched' }],
    revisedText: r02Revised,
  });
  check('V118-04-a 安慰原话仍在修后正文里时，issue_coverage 必须给出候选（旧证据逐字未消失）',
    out.count >= 1 && out.candidates[0].issue_id === 'R02',
    JSON.stringify(out));
  check('V118-04-b 该条候选的 claimed_resolved 只转述处置状态，且最终结论不得是 resolved',
    (() => {
      const v = RP.coverageVerdict({ semantic: null, stillPresent: out.count ? out.candidates[0].still_present : 0, covered: true });
      return out.candidates[0] && out.candidates[0].claimed_resolved === true && v.status !== 'resolved';
    })(),
    JSON.stringify(out.candidates[0] || null));
  // 阴性对照：证据句真的不在修后正文里时，不得凭空产出候选。
  const gone = RP.issueCoverageCandidates({
    issues: [{ id: 'R02', quotes: ['没有谁特意冲他说'] }],
    coverage: [{ issue_id: 'R02', status: 'patched' }],
    revisedText: r02Revised,
  });
  check('V118-04-c 阴性对照：证据句已不在正文里时不得产出 issue_coverage 候选',
    gone.count === 0,
    JSON.stringify(gone));
}

// ══ V118-05：只删"二十米"，"两步可见/几十人遮挡"仍在 → partially_resolved ══════
{
  const out = RP.issueCoverageCandidates({
    issues: [{ id: 'R07', quotes: [FIX.r07Quote, ...FIX.r07Still] }],
    coverage: [{ issue_id: 'R07', status: 'patched' }],
    revisedText: FIX.r07Revised,
  });
  check('V118-05-a 只删"二十米"不行：仍存在的其余证据句必须让 R07 保持 partially_resolved',
    out.count >= 1 && out.candidates[0].still_present >= 1,
    JSON.stringify(out));
  const verdict = RP.coverageVerdict ? RP.coverageVerdict({ semantic: null, stillPresent: 1 }) : null;
  check('V118-05-b 缺语义核验时 coverageVerdict 必须给 partially_resolved + semantic_not_run',
    !!verdict && verdict.status === 'partially_resolved' && verdict.semantic_status === 'not_run',
    JSON.stringify(verdict));
}

// ══ V118-06/07/08：报告引文必须逐字可归属 ═════════════════════════════════════
{
  const quoted06 = structureReviewReport(
    { summary: '本章突出。', strengths: ['王磊那句「你就不能配合一下气氛」把紧张感写活了。'], issues: [] },
    { text: FIX.chapter },
  );
  check('V118-06 报告引用原文不存在的「你就不能配合一下气氛」→ quote_not_found',
    !!quoted06.quote_audit && quoted06.quote_audit.items.some(
      (i) => i.status === 'quote_not_found' && i.found === false && /你就不能配合一下气氛/.test(i.quote)),
    JSON.stringify(quoted06.quote_audit || null));

  const quoted07 = structureReviewReport(
    { summary: '本章突出。', strengths: ['「你先上去吧」这句处理得干脆。'], issues: [] },
    { text: FIX.chapter },
  );
  check('V118-07 报告引用原文不存在的「你先上去吧」→ quote_not_found（真原话是「算了。你上去吧。」）',
    !!quoted07.quote_audit && quoted07.quote_audit.items.some(
      (i) => i.status === 'quote_not_found' && i.found === false && /你先上去吧/.test(i.quote)),
    JSON.stringify(quoted07.quote_audit || null));

  const good = auditReviewQuotes(['王磊说「羡慕不？」'], FIX.chapter);
  const goodKeep = auditReviewQuotes(['王磊说「算了。你上去吧。」'], FIX.chapter);
  check('V118-08 与原文逐字一致的对白引用必须通过（不误报合法引文）',
    good.quote_not_found_count === 0 && goodKeep.quote_not_found_count === 0,
    JSON.stringify({ a: good.items, b: goodKeep.items }));
  // 阴性对照：概括性转述（不带引号）不得被当成引文核验对象。
  const paraphrase = auditReviewQuotes(['王磊喜欢用插科打诨应对紧张。'], FIX.chapter);
  check('V118-08-b 阴性对照：不带引号的概括性转述不得产生任何引文核验项',
    paraphrase.items.length === 0 && paraphrase.quote_not_found_count === 0,
    JSON.stringify(paraphrase));
}

// ══ V118-09：strengths 的绝对局限措辞必须被限定，且不得机械删句 ══════════════
{
  const rep = checkReportConsistency({
    strengths: ['林清雪只给动作，完全没有内心独白。', '李拓是本章唯一一次写足检测流程。'],
    issues: [],
    text: FIX.chapter,
  });
  check('V118-09-a "完全没有内心独白"与正文解释句冲突 → 报 confirmation_needed 且标 strengths_needs_qualification',
    !!rep.strength_qualifications && rep.strength_qualifications.length >= 1
    && rep.strength_qualifications.some((q) => q.code === 'strengths_needs_qualification' || q.type === 'strength_vs_body'),
    JSON.stringify(rep.strength_qualifications || rep.conflicts || null));
  check('V118-09-b "唯一一次/只"这类绝对局限措辞必须给出**限定建议**，而不是删除该条优点',
    !!rep.strength_qualifications
    && rep.strength_qualifications.some((q) => /唯一|只/.test(String(q.strength || ''))),
    JSON.stringify(rep.strength_qualifications || null));
  // 不带绝对措辞的优点不得被牵连（阴性对照）。
  const clean = checkReportConsistency({ strengths: ['开头的排队布景克制，没有铺陈。'], issues: [], text: FIX.chapter });
  check('V118-09-c 阴性对照：不含绝对局限措辞的优点不得被报',
    (clean.strength_qualifications || []).length === 0,
    JSON.stringify(clean.strength_qualifications || null));
}

// ══ V118-10：同物件状态跨句重叠 → prop_state_continuity 候选 ══════════════════
{
  check('V118-10-a propStateCandidates 必须存在（同物件状态缺桥要可判定）',
    typeof PS.propStateCandidates === 'function',
    String(typeof PS.propStateCandidates));
  const prop = typeof PS.propStateCandidates === 'function'
    ? PS.propStateCandidates('岳宸炎把手机悬在半空，想拍大屏。\n\n后来他把手机举起来想拍大屏，举到一半又放下。', {})
    : { candidates: [] };
  check('V118-10-b 手机先"悬在半空"后又"举起来"：必须给出 prop_state_possible_overlap 候选',
    prop.candidates.some((c) => c.code === 'prop_state_possible_overlap'),
    JSON.stringify(prop.candidates));
  check('V118-10-c 该候选必须带反证通道（允许"中间已复位/只是另一只手"这类反证）',
    prop.candidates.some((c) => c.code === 'prop_state_possible_overlap' && String(c.counterevidence || '').length > 0),
    JSON.stringify(prop.candidates));
  // 阴性对照：状态被明确复位（举起来→放下→再举起）时不得报。
  const reset = typeof PS.propStateCandidates === 'function'
    ? PS.propStateCandidates('他把手机举起来想拍大屏，举到一半又放下。后来他把手机重新举起来，对准大屏。', {})
    : { candidates: [] };
  check('V118-10-d 阴性对照：状态已明确复位（放下→重新举起）不得报 prop_state_possible_overlap',
    !reset.candidates.some((c) => c.code === 'prop_state_possible_overlap'),
    JSON.stringify(reset.candidates));
}

// ══ V118-11：未选中的问题不得被说成"已改"或"修稿失败" ═══════════════════════
{
  const out = RP.issueCoverageCandidates({
    issues: [{ id: 'R04', quotes: ['王磊把手机举起来想拍大屏'] }, { id: 'R05', quotes: ['假装没看见'] }],
    coverage: [
      { issue_id: 'R04', status: 'unaccounted' },
      { issue_id: 'R05', status: 'unaccounted' },
    ],
    revisedText: FIX.chapter,
    // ⚠️ 生产是通过 `revisionIssueQuotes(review, selectedIssueIds)` **只把选中项**交给核验的；
    //    这里显式给空集合，模拟"本轮一条都没勾选"（V118-11 的原始情形：R04/R05 未选中）。
    selectedIssues: [],
  });
  check('V118-11-a 未选中/未处置的问题必须是 unaccounted，不得被算作"已改"',
    out.candidates.length === 0 && Array.isArray(out.unaccounted) && out.unaccounted.length === 2,
    JSON.stringify(out));
  check('V118-11-b 未选中项不得被渲染成 patch_count/resolved（必须显式 selection_status:not_selected）',
    out.unaccounted.every((u) => u.selection_status === 'not_selected' && u.disposition === 'not_selected'),
    JSON.stringify(out.unaccounted));
  // 阴性对照：**未提供**勾选集合 ≠ 未选中。此时只如实标 selection_unspecified，
  // 不得反过来把"我不确定它选没选"说成"作者没选"。
  const unknown = RP.issueCoverageCandidates({
    issues: [{ id: 'R04', quotes: ['王磊把手机举起来想拍大屏'] }],
    coverage: [{ issue_id: 'R04', status: 'unaccounted' }],
    revisedText: FIX.chapter,
  });
  check('V118-11-c 阴性对照：未提供勾选集合时标 selection_unspecified，不得冒充 not_selected',
    unknown.unaccounted.length === 1 && unknown.unaccounted[0].selection_status === 'selection_unspecified',
    JSON.stringify(unknown.unaccounted));
}

// ══ V118-12：缺语义核验不得报 resolved ═════════════════════════════════════════
{
  check('V118-12-a coverageVerdict 必须存在，并默认 semantic_status:not_run',
    typeof RP.coverageVerdict === 'function',
    String(typeof RP.coverageVerdict));
  const v = RP.coverageVerdict ? RP.coverageVerdict({ semantic: null, stillPresent: 0, covered: true }) : null;
  check('V118-12-b 旧引文已消失但语义核验未跑：旧实现会报 resolved —— 必须改为不报 resolved',
    !!v && v.semantic_status === 'not_run' && v.status !== 'resolved',
    JSON.stringify(v));
  check('V118-12-c 反向：语义层明确跑过并判定通过时，允许 resolved（不是"永远不许 resolved"）',
    (() => {
      const r = RP.coverageVerdict ? RP.coverageVerdict({ semantic: { status: 'pass' }, stillPresent: 0, covered: true }) : null;
      return !!r && r.status === 'resolved' && r.semantic_status === 'pass';
    })(),
    JSON.stringify((RP.coverageVerdict ? RP.coverageVerdict({ semantic: { status: 'pass' }, stillPresent: 0, covered: true }) : null)));
}

// ══ V118-13：伏笔编号未知应 deferred/unknown_anchor，不是硬冲突 ═══════════════
{
  check('V118-13-a anchorStatus 必须存在（伏笔锚的可见性要可判定）',
    typeof PS.anchorStatus === 'function',
    String(typeof PS.anchorStatus));
  const unknown = typeof PS.anchorStatus === 'function'
    ? PS.anchorStatus({ text: '评定单上是一串数字，他没细看。', anchor: '0731', label: '伏笔 #35' })
    : null;
  check('V118-13-b 正文只写"一串数字"而伏笔要 `0731` → unknown_anchor（不得判硬冲突，也不得自动补数）',
    !!unknown && unknown.status === 'unknown_anchor' && unknown.hard_conflict !== true,
    JSON.stringify(unknown));
  check('V118-13-c G：编号在正文里已明写时 → confirmed（阴性对照，不把已公开的锚当未知）',
    (() => {
      const shown = PS.anchorStatus({ text: '评定单上写着 0731 号。', anchor: '0731', label: '伏笔 #35' });
      return shown.status === 'confirmed';
    })(),
    JSON.stringify(PS.anchorStatus({ text: '评定单上写着 0731 号。', anchor: '0731', label: '伏笔 #35' })));
}

// ══ V118-14：作者批准的多点时间锚调整不得被硬拦；不得创造外场等待规则 ═════════
{
  const approved = PS.classifyEditScope(
    '中午只剩十几个人了。',
    '十点出头只剩十几个人了。',
    { baseText: FIX.noonBefore, authorApprovedTimeAnchors: true },
  );
  check('V118-14-a 作者批准的仅时间锚替换（中午→十点出头）不得判 story_fact 硬拦',
    approved.scope !== PS.SCOPE.STORY_FACT,
    `scope=${approved.scope} signals=${JSON.stringify(approved.signals)}`);
  check('V118-14-b 未带作者批准时，同一替换只是普通换词（不虚构"外场等待规则"）',
    (() => {
      const plain = PS.classifyEditScope('中午只剩十几个人了。', '十点出头只剩十几个人了。', { baseText: FIX.noonBefore });
      return plain.scope === PS.SCOPE.WORDING && !(plain.signals || []).some((s) => s.code === 'new_workflow_rule');
    })(),
    JSON.stringify(PS.classifyEditScope('中午只剩十几个人了。', '十点出头只剩十几个人了。', { baseText: FIX.noonBefore })));
}

// ══ V118-15：常见等级结果 + 全体静止 → 因果候选（带反证）；有铺垫则保留 ═══════
{
  const common = narrativeCandidateSignals(
    '大屏上跳出结果。\n\nD级。\n\n外场安静了。没人说话，所有人都站着不动。\n\n岳宸炎走下台阶。',
    { gradeRarity: { D: 'common' }, characters: ['岳宸炎'] },
  );
  const hit = common.candidates.filter((c) => c.diagnostic === 'reaction_causality');
  check('V118-15-a D级属常见结果而"外场安静了"全场静止 → 必须给出 reaction_causality 候选',
    hit.length >= 1,
    JSON.stringify(common.candidates.map((c) => `${c.diagnostic}:${c.quote}`)));
  check('V118-15-b 该候选必须带 counterevidence_hint，且 requires_semantic_check=true（候选≠定罪）',
    hit.length >= 1 && hit.every((c) => String(c.counterevidence_hint || '').length > 0 && c.requires_semantic_check === true),
    JSON.stringify(hit));
  // 阴性对照：前文已把该等级铺垫为异常/罕见时，全体静止成立 → 不得报。
  const staged = narrativeCandidateSignals(
    '这一届据说只出过一个D级，还是三年前的怪事。\n\n大屏上跳出结果。\n\nD级。\n\n外场安静了。没人说话。',
    { gradeRarity: { D: 'rare' } },
  );
  check('V118-15-c 阴性对照：该等级已被铺垫为罕见（gradeRarity:D=rare）时允许保留，不得报',
    !staged.candidates.some((c) => c.diagnostic === 'reaction_causality'),
    JSON.stringify(staged.candidates.map((c) => `${c.diagnostic}:${c.quote}`)));
}

finish('17-review-closure-0317');
