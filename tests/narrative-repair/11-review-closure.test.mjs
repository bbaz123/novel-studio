/**
 * tests/narrative-repair/11-review-closure.test.mjs —— 《修改方案.md》第二轮：
 * 审稿判断校准（扫描命中=候选）、报告自洽、感知/因果候选、双重授权 fail-closed、
 * 篇幅缺口与可选压缩热点（condense 默认关闭）。
 *
 * 与既有套件的分工（不重复、不覆盖）：
 *   · 04-narrative-scan：四类结构诊断 + 审稿协议（引用核验/反证降级/保护分区）；
 *   · 08-authorization：授权表 / 歧义拒绝 / plan 不放宽 / legacy 隔离；
 *   · 07-review-structure：结构化审稿与引用核验；
 *   本套件只覆盖**本轮新增要求**：S01 候选化、报告自洽、reaction_causality / focalization_limit
 *   的证据与反证、S05-1 缺授权 fail-closed、以及字数/压缩热点的如实呈现。
 *
 * 零依赖、零计费；不连真实模型，不读真实作品库，不改任何正式稿件。
 */
import { createChecks, loadPublicModules } from './harness.mjs';
import { narrativeCandidateSignals, DIAGNOSTICS, PERCEPTION_DIAGNOSTICS } from '../../ai/editing/narrative-scan.mjs';
import { structureReviewReport } from '../../ai/editing/narrative-review.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();
await import(new URL('../../public/revision-plan.js', import.meta.url).href);
const PL = globalThis.NovelRevisionPlan;

// ── T02：扫描命中只是候选，可以被判 not_applicable（不强制进 issues）──────────
{
  const legal = '她微微侧过身，让出了一条路。';
  const scan = narrativeCandidateSignals(legal, {});
  check('T02-a 合法语境里的「微微」不产生任何确定性候选（扫描层不把词命中当缺陷）',
    scan.candidates.length === 0,
    JSON.stringify(scan.candidates.map((c) => `${c.diagnostic}:${c.quote}`)));

  // 审稿协议层：扫描命中若被模型判为"不成立"，必须能作为 not_applicable 留下来，
  // 而不是被强制升格成 issues。
  const report = structureReviewReport({
    summary: '本章节奏稳定。',
    strengths: ['开头的排队布景克制，没有铺陈。'],
    issues: [],
    findings: [{
      id: 'R03', kind: 'wording', severity: 'low', verdict: 'not_applicable', rule_id: 'signal:微微',
      evidence: [{ quote: legal, source: 'body' }],
      reading_cost: '无：程度副词在此处正常',
      rationale: '「微微」是正常程度副词，此处不构成 AI 腔',
      counterevidence: '该词在全文高频重复且句式一致时才可能是模板句',
      suggested_action: 'keep',
      keep_reason: '正常用法，保留',
    }],
    // ⚠️ 签名是 structureReviewReport(report, ctx)：正文属于 **ctx.text**（引用核验的比对底本）。
    //    放在第一个参数里不会被读取，会红得像是"命中被拒收" —— 本套件第一版正是这样误判的。
  }, { text: legal });
  check('T02-b 扫描命中可被判 not_applicable 并留在报告里，不被强制写成 issue',
    report.findings.length === 1 && report.findings[0].verdict === 'not_applicable'
    && report.findings[0].auto_eligible === false,
    JSON.stringify(report.counts));
  check('T02-c not_applicable 的命中不进入"可自动修稿"集合（候选 ≠ 授权）',
    (report.counts.auto_eligible || 0) === 0, JSON.stringify(report.counts));
}

// ── T05 / T06：报告的 strengths 与 issues 不得互相矛盾 ─────────────────────
{
  // T05（**2026-10-11 契约修正**）：绝对化 strength 与同话题 issue 重叠 → 只给**建议核对**，
  // 不得据此宣称"报告自相矛盾"。
  // 为什么改：原断言要求 status=needs_calibration。但把该检测器放到 **12 份真实历史审稿报告** 上实测，
  // 宽松判据误报 **6/12**（例如「不靠旁白建体系」被读成"宣称已不存在"，与"时间线冲突"配成一对），
  // 收紧到话题重叠系数后**合成正例又漏报** —— 说明**字面重叠无法证明语义矛盾**，任何阈值都两头不讨好。
  // 因此唯一允许改变 status 的，是**可确证**的那种（绝对措辞 × 正文反例，证据是那句原文）。
  const body = '0001号上台，石板亮了。\n\n0372号上台，石板又亮了一次，光柱、嗡鸣、收回，流程一模一样。';
  const t05 = structureReviewReport({
    summary: '总评',
    strengths: ['0001号之后同类机制不再完整演示，处理得干净。'],
    issues: ['0372号仍然把光柱、嗡鸣、收回的完整流程又演了一遍，与0001号重复。'],
    findings: [],
  }, { text: body });
  check('T05-a（契约修正）绝对化 strength 与同话题 issue 重叠 → 只进 advisories，不宣称"互相矛盾"',
    t05.consistency && t05.consistency.status === 'ok'
    && Array.isArray(t05.consistency.advisories) && t05.consistency.advisories.length >= 1
    && t05.consistency.conflicts.length === 0
    && /无法证明语义矛盾|只进 advisories/.test(String(t05.consistency.note || '')),
    JSON.stringify({ status: t05.consistency && t05.consistency.status, adv: (t05.consistency && t05.consistency.advisories || []).length }));

  // T05-b（**真实数据假阳性回归**，直接从实测里抽象出来的最小反例）：
  // 「不靠旁白建体系」这种正常描述**不得**被当成绝对措辞，更不得与无关 issue 配成"矛盾"。
  // 实测背景：修复前它在 12 份真实报告上产生 6 份假阳性；这条把它永久钉住。
  const t05b = structureReviewReport({
    summary: '总评',
    strengths: ['等级分量全靠事件给出，不靠旁白建体系；细节质感扎实。'],
    issues: ['开篇时间线与既有设定冲突：本章开篇写的是早上六点四十，与角色卡当前状态不一致。'],
    findings: [],
  }, { text: '正文。' });
  check('T05-b（假阳性回归）「不靠旁白建体系」不被当作绝对措辞，也不与无关问题配成矛盾',
    t05b.consistency && t05b.consistency.status === 'ok' && t05b.consistency.conflicts.length === 0,
    JSON.stringify({ status: t05b.consistency && t05b.consistency.status, conflicts: (t05b.consistency && t05b.consistency.conflicts) || [] }));

  // T06：strength 称"伏笔完全没有解释"，正文却存在"他从小就觉得……"的解释。
  const t06 = structureReviewReport({
    summary: '总评',
    strengths: ['林清雪的伏笔完全没有解释，留得干净。'],
    issues: [],
    findings: [],
  }, { text: '她低下头，把掌心摊开。他从小就觉得，人拿到一样东西时手会先紧一下。' });
  check('T06-a strength 绝对宣称"完全没有解释"而正文含解释句 → 标为待校准并给出反例引用',
    t06.consistency && t06.consistency.status === 'needs_calibration'
    && t06.consistency.conflicts.some((c) => /解释/.test(c.strength) && c.evidence),
    JSON.stringify(t06.consistency));

  // 阴性对照：strength 与 issue 指向不同维度时不得乱报矛盾。
  const ok = structureReviewReport({
    summary: '总评',
    strengths: ['排队布景写得克制。'],
    issues: ['结尾等待的重复可以再压一次。'],
    findings: [],
    text: '队伍很长。\n\n他等了几秒。没有下一句。',
  });
  check('T06-b 阴性对照：strength 与 issue 指向不同维度时不报矛盾（不误伤正常报告）',
    ok.consistency && ok.consistency.status === 'ok' && ok.consistency.conflicts.length === 0,
    JSON.stringify(ok.consistency));
}

// ── T21：场景反应因果候选必须有证据与反证 ─────────────────────────────────
{
  const text = '他的成绩是C级。C级本来就常见，队伍里没什么反应。\n\n可大厅里安静了。靠在墙边打盹的考生全都停住了。';
  const scan = narrativeCandidateSignals(text, {});
  const rc = scan.candidates.filter((c) => c.diagnostic === 'reaction_causality');
  check('T21-a 普通等级却引发全体中止反应 → 出 reaction_causality 候选（带准确引用）',
    rc.length === 1 && /大厅里安静了/.test(rc[0].quote) && text.includes(rc[0].quote),
    JSON.stringify(rc.map((c) => c.quote)));
  check('T21-b 该候选必须带反证通道与"只是候选"标记，绝不自动改全场反应',
    rc.length === 1 && rc[0].counterevidence_hint.length > 0 && rc[0].requires_semantic_check === true
    && ['check', 'condense'].includes(rc[0].suggested_action),
    JSON.stringify({ hint: rc[0] && rc[0].counterevidence_hint.slice(0, 30), act: rc[0] && rc[0].suggested_action }));

  // 阴性对照：真正的奇观（S 级异象）引发的全场静止不是"反应过大"。
  const spectacle = '直播画面里，S级异象的光柱冲上云层。\n\n候检大厅里没声了。全场抬着头。';
  const sc = narrativeCandidateSignals(spectacle, {});
  check('T21-c 阴性对照：S 级奇观引发的全场静止不产生 reaction_causality 候选',
    !sc.candidates.some((c) => c.diagnostic === 'reaction_causality'),
    JSON.stringify(sc.candidates.map((c) => `${c.diagnostic}:${c.quote}`)));
}

// ── T22：视点信息越界候选必须有证据与反证，且不得捏造能力 ─────────────────
{
  const density = '他把右手按在石板上。石板的密度比普通石头高。';
  const d = narrativeCandidateSignals(density, {});
  const f = d.candidates.filter((c) => c.diagnostic === 'focalization_limit');
  check('T22-a 手按一下就断言密度 → 出 focalization_limit 候选（触觉得不到该性质）',
    f.length === 1 && /密度/.test(f[0].evidence) && /触觉/.test(f[0].evidence),
    JSON.stringify(f.map((c) => c.evidence)));

  const warmth = '前厅里挤满了人。\n\n他隔着队伍看了一眼李拓，李拓掌心还残留着一点金色的余温。';
  const w = narrativeCandidateSignals(warmth, {});
  const fw = w.candidates.filter((c) => c.diagnostic === 'focalization_limit');
  check('T22-b 隔着队伍却知道掌心余温 → 出 focalization_limit 候选（隔距离给出对方身上信息）',
    fw.length === 1 && /隔着队伍|隔着/.test(fw[0].evidence),
    JSON.stringify(fw.map((c) => c.evidence)));
  check('T22-c 候选只提疑点：带反证提示、不带"删除"、绝不新增角色能力',
    [...f, ...fw].every((c) => c.counterevidence_hint.length > 0 && c.suggested_action !== 'delete'
      && c.requires_semantic_check === true && !/新增|赋予|获得能力/.test(c.evidence)),
    JSON.stringify([...f, ...fw].map((c) => c.suggested_action)));
  check('T22-d 两类新增诊断已登记进 DIAGNOSTICS（口径可对账）',
    PERCEPTION_DIAGNOSTICS.every((x) => DIAGNOSTICS.includes(x)),
    JSON.stringify(DIAGNOSTICS));
}

// ── S05-1：期望 v2 的作业缺授权表必须 fail-closed（不得静默降级成弱校验）──
{
  const body = '甲说：“今天别出门。”\n\n乙把围巾放在椅子上。';
  const snap = RP.snapshotOf(body, { chapter_id: 31 });
  const span = RP.buildSpans(body, { sentences: true }).find((x) => x.text === '乙把围巾放在椅子上。');
  const v2 = JSON.stringify({
    schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
    patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: ['q1'], span_id: span.span_id, op: 'delete', original: span.text, replacement: '' }],
  });
  // 期望 v2、但没有 Host 授权表：旧实现会退到"只校验 issue 在已选集合里"的弱校验并把补丁应用掉。
  const noAuth = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 31, selectedIssueIds: ['q1'], engine: K,
    expectedSchemaVersion: 2, raw: v2,
  });
  check('T31-a 期望 v2 却缺 Host 授权表 → fail-closed（不是静默降级成弱校验）',
    noAuth.ok === false && noAuth.error_code === 'out_of_scope' && noAuth.text === body
    && (noAuth.errors || []).some((e) => e.code === 'authorization_required'),
    JSON.stringify({ ok: noAuth.ok, code: noAuth.error_code, errors: noAuth.errors }));
  check('T31-b fail-closed 时正文一个字符都不动（不是"先改了再报错"）',
    noAuth.text === body && (noAuth.applied || []).length === 0, noAuth.text);

  // 阴性对照：给了授权表（即便是等价的一份）必须照常通过 —— 不能把正常路径一起拦掉。
  const auth = { authorized: { q1: [{ span_id: span.span_id, start: span.start, end: span.end, text: span.text, ops: ['delete'] }] } };
  const withAuth = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 31, selectedIssueIds: ['q1'], engine: K, authorization: auth,
    expectedSchemaVersion: 2, raw: v2,
  });
  check('T31-c 阴性对照：带授权表的同一作业正常通过（硬化没有误伤正常路径）',
    withAuth.ok === true && withAuth.applied.length === 1,
    JSON.stringify({ ok: withAuth.ok, code: withAuth.error_code, text: withAuth.text }));

  // 兼容性：不声明期望 v2 的旧调用（历史路径）不受该硬门影响。
  const legacy = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 31, selectedIssueIds: ['q1'], engine: K, raw: v2,
  });
  check('T31-d 未声明 expectedSchemaVersion 的历史调用仍可走原语义（不破坏存量兼容路径）',
    legacy.ok === true && legacy.applied.length === 1,
    JSON.stringify({ ok: legacy.ok, code: legacy.error_code }));
}

// ── 篇幅缺口与可选压缩热点（condense 默认关闭）────────────────────────────
{
  const body = '第一段。\n\n第二段。\n\n第三段。\n\n第四段。';
  const snap = RP.snapshotOf(body, { chapter_id: 41 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'H07', text: '章尾重复等待', quote: '第四段。', suggested_action: 'condense' }],
    allowCondense: false,
  });
  check('T41-a condense 默认关闭：没有 host 批准位时压缩请求被拒绝（不静默降级成 replace）',
    plan.coverage.some((c) => c.issue_id === 'H07' && /condense|压缩/.test(String(c.reason || '')))
    || plan.hotspots.every((h) => h.suggested_action !== 'condense'),
    JSON.stringify(plan.coverage));
  check('T41-b 计划如实给出"可定位/未定位"清单，供界面显示剩余缺口（不假装篇幅已修复）',
    Array.isArray(plan.coverage) && plan.coverage.every((c) => typeof c.status === 'string'),
    JSON.stringify(plan.coverage.map((c) => `${c.issue_id}:${c.status}`)));
}

// ── 补充轮：S06-1 唯一性判据升级为"能作为独立句逐字相等的跨度数"─────────────
// 背景（取证记录）：旧判据只看**字面片段**出现次数（`occurrences`）。
// 当同一句在正文里出现两次时它已经能拦住；本组把口径升级为"逐字相等的**句子跨度**数 > 1 也算歧义"，
// 属于纵深防御（不是修一个已复现的真实越权）。因此本组**明确标注**它验证的是防御面本身。
{
  const body = '他低下头。\n\n过了一阵，他低下头。';
  // 直接构造"两个逐字相等的句子跨度"（整句重复场景），验证判据不只是"数字面出现次数"。
  const synthetic = [
    { span_id: 'p1s1', kind: 'sentence', start: 0, end: 5, text: '他低下头。', paragraph_index: 0 },
    { span_id: 'p2s1', kind: 'sentence', start: 12, end: 17, text: '他低下头。', paragraph_index: 1 },
  ];
  const plural = PL.locateFragment(body, '他低下头。', synthetic);
  check('T51-a（S06-1）两个逐字相等的句子跨度 → 判歧义（不只看字面出现次数）',
    !!plural && plural.ambiguous === true && Number(plural.count) >= 2,
    JSON.stringify(plural));
  // ⚠️ 上面两条**不能**证明需要新判据：这两种输入里 `他低下头。` 在正文里字面出现 ≥2 次，
  //    旧的 occurrences 核验**已经**拦住它们（T51-c 就是走这条旧判据报的 ambiguous_anchor）。
  //    下面这组是"多个候选跨度"的形状，但结论同样是"已被旧判据覆盖"——
  //    本组的作用是**如实记录 S06-1 的复核结论**：穷举构造后没有找到"字面只出现 1 次、
  //    却必须判歧义"的真实输入，因此本轮**不**改动该判据（改动的实测代价见 T51-d 的注释）。
  const shiftBody = '他低下头。\n\n他低下头。他低下头。';
  const shiftSpans = [
    { span_id: 'p1s1', kind: 'sentence', start: 0, end: 5, text: '他低下头。', paragraph_index: 0 },
    { span_id: 'p2s1', kind: 'sentence', start: 7, end: 18, text: '他低下头。他低下头。', paragraph_index: 1 },
    { span_id: 'p2s2', kind: 'sentence', start: 12, end: 18, text: '他低下头。', paragraph_index: 1 },
  ];
  const shift = PL.locateFragment(shiftBody, '他低下头。', shiftSpans);
  check('T51-a2（S06-1 表征）多候选跨度形状 → 判歧义（实际由旧的字面出现次数核验拦下，count=3）',
    !!shift && shift.ambiguous === true && Number(shift.count) >= 3,
    JSON.stringify(shift));
  // T51-d：**反向确认本轮不改判据是正确的**。把"候选跨度数 > 1 即歧义"这一扩展加上去之后，
  // 下面这条形状（片段是某句的**真前缀**：`p1` 段与 `p1s1` 句都装得下它）会被误判成歧义，
  // 而它必须精确命中 `p1s1` —— 这正是 E01-6/E01-6b/E01-6d/E01-6e/E05-f 五条既有断言变红的原因。
  const prefixBody = '3751年全民觉醒日，江陵市第三检测中心。门口的栏杆拐了两道弯。';
  const prefixSpans = RP.buildSpans(prefixBody, { sentences: true });
  const prefix = PL.locateFragment(prefixBody, '3751年全民觉醒日，江陵市第三检测中心。', prefixSpans);
  check('T51-d（S06-1 反向确认）片段=某句逐字整句时精确命中该句，不得因"段落也装得下"被判歧义',
    !!prefix && prefix.span_id === 'p1s1' && prefix.ambiguous !== true,
    JSON.stringify(prefix));
  // 阴性对照：只有一个候选跨度时照常命中。
  const single = PL.locateFragment('他低下头。\n\n雪还在下。', '他低下头。', [
    { span_id: 'p1s1', kind: 'sentence', start: 0, end: 5, text: '他低下头。', paragraph_index: 0 },
    { span_id: 'p2s1', kind: 'sentence', start: 7, end: 12, text: '雪还在下。', paragraph_index: 1 },
  ]);
  check('T51-a3（S06-1 阴性对照）只有一个候选跨度时仍正常定位（不误报歧义）',
    !!single && single.span_id === 'p1s1' && single.ambiguous !== true,
    JSON.stringify(single));
  // Host 给出唯一 span_id 时必须照常定位（硬化不得把正常路径一起拦掉）。
  const hostGiven = PL.locateFragment(body, '他低下头。', synthetic, { span_id: 'p2s1' });
  check('T51-b（S06-1）Host 显式给出唯一 span_id 时仍正常定位（阴性对照）',
    !!hostGiven && hostGiven.span_id === 'p2s1' && hostGiven.host_given === true && hostGiven.ambiguous !== true,
    JSON.stringify(hostGiven));

  // 端到端：整句重复 + 无唯一标识 → ambiguous_anchor，且不产生任何可改热点。
  const snap = RP.snapshotOf(body, { chapter_id: 51 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'I-重复', text: '「他低下头。」这个动作重复了，删掉后面那次' }],
  });
  check('T51-c（S06-1）端到端：重复引用 → ambiguous_anchor 且热点为 0（不猜第一处）',
    plan.hotspots.length === 0
    && plan.coverage.some((c) => c.issue_id === 'I-重复' && c.status === 'ambiguous_anchor'),
    JSON.stringify(plan.coverage));
}

// ── T19（《修改方案.md》§8 E04.1 / §6.4）：只解决局部必须报 partially_resolved ──
// 需求原文：「仅将第二次A级人群解释压短，却未缩流程，父问题必须 partially_resolved 而非 resolved」；
// 核心验收原则：「不能把'实际改了2个span'自动报成'2个问题全部解决'」。
{
  const body = '第二段：人群的反应写得很抽象。\n\n第三段：流程又完整走了一遍。';
  const snap = RP.snapshotOf(body, { chapter_id: 61 });
  const span = RP.buildSpans(body, { sentences: true }).find((x) => x.text === '第二段：人群的反应写得很抽象。');
  const auth = { authorized: { R06: [{ span_id: span.span_id, start: span.start, end: span.end, text: span.text }] } };
  const v2 = (dispositions) => JSON.stringify({
    schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
    patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: ['R06'], span_id: span.span_id, op: 'replace', original: span.text, replacement: '第二段：人群反应一笔带过。' }],
    dispositions,
  });
  const partial = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 61, selectedIssueIds: ['R06'], engine: K, authorization: auth,
    expectedSchemaVersion: 2,
    raw: v2([{ issue_id: 'R06', status: 'partially_resolved', reason: '只压了人群抽象解释；检测流程仍完整保留' }]),
  });
  check('T19-a 模型声明"只解决局部" → 覆盖表如实报 partially_resolved（不升级成 patched）',
    partial.ok === true && partial.coverage.some((c) => c.issue_id === 'R06' && c.status === 'partially_resolved'),
    JSON.stringify(partial.coverage));
  check('T19-b partially_resolved 必须进"未完成项"，作者能看见这条还没解决完',
    partial.ok === true && (partial.unresolved || []).some((u) => u.issue_id === 'R06' && u.status === 'partially_resolved'),
    JSON.stringify(partial.unresolved));
  // 负向：声明 partially_resolved 却不给理由 → 与"完全解决"无从区分，必须拒收。
  const noReason = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 61, selectedIssueIds: ['R06'], engine: K, authorization: auth,
    expectedSchemaVersion: 2,
    raw: v2([{ issue_id: 'R06', status: 'partially_resolved', reason: '   ' }], ),
  });
  check('T19-c partially_resolved 缺理由 → schema_error 拒收（不拿"局部"当免责话术）',
    noReason.ok === false && (noReason.errors || []).some((e) => e.code === 'partial_without_reason')
    && noReason.text === body,
    JSON.stringify({ code: noReason.error_code, errors: noReason.errors }));
  // 阴性对照：真的完全解决时仍是 patched（不能把正常路径一律降级）。
  const full = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 61, selectedIssueIds: ['R06'], engine: K, authorization: auth,
    expectedSchemaVersion: 2,
    raw: v2([{ issue_id: 'R06', status: 'patched', reason: '整条抽象解释已删除' }]),
  });
  check('T19-d 阴性对照：声明 patched 且确实有补丁 → 仍是 patched（不误降级）',
    full.ok === true && full.coverage.some((c) => c.issue_id === 'R06' && c.status === 'patched')
    && !(full.unresolved || []).some((u) => u.issue_id === 'R06'),
    JSON.stringify(full.coverage));
}

// ── T16（§7.2）：两个不相邻热点不得被并成一个大跨度把中间正文一起"授权" ──
// 需求原文：「两个不相邻的热点不得用包含中间未授权正文的大 span 合并」。
{
  const body = '第一段：这里是开头。\n\n第二段：中间还有别的东西。\n\n第三段：结尾也是这样。';
  const snap = RP.snapshotOf(body, { chapter_id: 71 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [
      { id: 'A', text: '把「第一段：这里是开头。」改掉' },
      { id: 'B', text: '把「第三段：结尾也是这样。」改掉' },
    ],
  });
  const origins = plan.hotspots.map((h) => String(h.original));
  check('T16-a（§7.2）两个不相邻热点各自成跨度，中间未授权正文不被并进任何一个',
    plan.hotspots.length === 2
    && !origins.some((o) => o.includes('中间还有别的东西'))
    && plan.hotspots.every((h) => h.original === body.slice(h.span.start, h.span.end)),
    JSON.stringify(plan.hotspots.map((h) => [h.span.span_id, h.original])));
  // 授权表同样不得出现把两处包起来的大区间。
  const auth = PL.planAuthorization(plan);
  const ranges = Object.values(auth.authorized || {}).flat().map((e) => [e.start, e.end]);
  const spansMid = ranges.some(([s, e]) => body.slice(s, e).includes('中间还有别的东西'));
  check('T16-b 授权表里不存在"覆盖中间未授权正文"的大区间',
    ranges.length === 2 && !spansMid,
    JSON.stringify(ranges));
}

finish('11-review-closure');
