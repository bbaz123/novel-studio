/**
 * tests/narrative-repair/04-narrative-scan.test.mjs —— E04：面向功能的叙事诊断（离线、零计费）。
 *
 * 覆盖任务书 §5.3/§5.4 的可离线验证部分：
 *   · 确定性候选层：四类诊断的正例（R02/R04/R06/R07 形状）与**阴性对照**（R03/R05/R11 形状）；
 *   · 数据不足必须显式返回，不硬判（过短 / 全对白）；
 *   · 审稿协议层：引用必须能在正文里逐字定位（伪造引用 → 拒绝）、反证缺失 → 降级 hypothesis、
 *     `auto_eligible` 只给 confirmed，三类保护分区不可由模型自行解除。
 *
 * 纪律：判据只产出**候选**；本套件也刻意断言"确定性层不定罪"（不含 delete、requires_semantic_check 恒真）。
 */
import { createChecks, loadFixtures } from './harness.mjs';
import { narrativeCandidateSignals, narrativeParagraphsOf, sentencesOf, DIAGNOSTICS } from '../../ai/editing/narrative-scan.mjs';
import {
  normalizeNarrativeFindings, validateNarrativeFinding, locateQuote,
  partitionProtections, buildNarrativeReviewPrompt, REVIEW_SCHEMA_VERSION,
} from '../../ai/editing/narrative-review.mjs';

const { check, finish } = createChecks();
const { after, before } = loadFixtures();

// ── 确定性候选层：冻结样本（真实两版正文） ─────────────────────────────────
const scanAfter = narrativeCandidateSignals(after, {});
const byRule = (r) => scanAfter.candidates.filter((c) => c.rule_id.startsWith(r));

check('E04-a', '候选层的四类诊断 id 与口径固定（§5.3）',
  JSON.stringify(scanAfter.diagnostics) === JSON.stringify(DIAGNOSTICS) && scanAfter.semantic_status === 'not_run'
  && scanAfter.deterministic === true, JSON.stringify(scanAfter.diagnostics));

{
  // R02：N04 那一形状（"这道光柱和他没关系……这场雪和他也没关系"）要形成**带准确引用**的解释冗余候选，
  //      同时**不得**把所有否定句批量标红（阴性对照见 E04-e）。
  const n04 = scanAfter.candidates.filter((c) => c.rule_id === 'structure:in-paragraph-repeat' && /没关系/.test(c.evidence));
  check('E04-b（R02）"没关系…也没关系"形成解释冗余候选，且引用是正文里真实存在的那一段',
    n04.length === 1 && n04[0].diagnostic === 'redundant_explanation'
    && after.includes(n04[0].quote.replace(/…$/, '').slice(0, 12))
    && /出现 2 次/.test(n04[0].evidence),
    JSON.stringify(n04.map((c) => ({ p: c.paragraph, ev: c.evidence }))));
  check('E04-b2', '候选只给"压缩/核对"，不带"删除"（确定性层不定罪）',
    scanAfter.candidates.every((c) => ['condense', 'check'].includes(c.suggested_action))
    && scanAfter.candidates.every((c) => c.requires_semantic_check === true)
    && scanAfter.candidates.every((c) => c.counterevidence_hint && c.counterevidence_hint.length > 0));
}

{
  // R04：S 级四处落雪（骨架重复）要能被建议**合并表达**，并把四处落点都列出来（默认不删地点）。
  const sk = byRule('structure:skeleton-repeat');
  check('E04-c（R04）四处落雪形成"落点重复"候选，引用覆盖多个落点',
    sk.length >= 1 && sk[0].diagnostic === 'spectacle_redundancy' && sk[0].quotes.length >= 3
    && sk[0].quotes.every((q) => /落在/.test(q))
    && /落点重复/.test(sk[0].evidence),
    JSON.stringify(sk[0] && sk[0].quotes));
  check('E04-c2', '落点候选给出反证提示（作者可能就是要铺陈），不按删除比例判',
    /排比|累积|规模/.test(sk[0].counterevidence_hint) && sk[0].suggested_action === 'condense');
}

{
  // R06/R07：流程复现来自 scan.mjs 的确定性统计（消费，不复制词表）。
  const proc = byRule('deterministic:process-shape-repeat');
  check('E04-d（R06）"同类机制被再次完整演示"由 scan.mjs 的统计给出（本模块不复制它的判据）',
    proc.length >= 1 && /来自 scan\.mjs/.test(proc[0].rule_id) && proc[0].diagnostic === 'repeated_mechanism'
    && Number.isFinite(proc[0].paragraph),
    JSON.stringify(proc.map((c) => ({ p: c.paragraph, ev: c.evidence.slice(0, 40) }))));
  check('E04-d2', '段号已换算到本模块的分段口径（不再混用 scan.mjs 的 \\\\n+ 口径）',
    proc.every((c) => !/段号沿用 scan\.mjs 口径/.test(c.evidence)),
    JSON.stringify(proc.map((c) => c.evidence.includes('沿用'))));
}

// ── 阴性对照：不该报的不能报 ───────────────────────────────────────────────
{
  // R03：结尾那组"没有人看他 / 广播念了一个名字"的短句与否定句 —— 有效停顿，不得产生候选。
  const tail = '他转过头，往身后看。身后是一条走廊，和一群往出口去的人。\n\n没有人看他。\n\n他站在原地，等了一下。\n\n广播念了一个名字，又念了下一个。走廊里没有人再说话。';
  const r = narrativeCandidateSignals(tail, {});
  check('E04-e（R03 阴性）短句/否定句的有效停顿不产生候选',
    r.candidates.length === 0, JSON.stringify(r.candidates.map((c) => c.rule_id)));
  // R05：直播/转播上下文里的镜头调度词合法 —— scan.mjs 的判据只在**不在媒体上下文里**时才产出，
  //      本模块直接消费它，因此这里断言"直播上下文不给镜头类候选"。
  const live = '大屏上正在直播海澜市的觉醒中心。\n\n画面切到室外，光柱从正中升上去。\n\n镜头拉远，能看见半座城市。\n\n他把视线从屏幕上移开。';
  const rl = narrativeCandidateSignals(live, {});
  check('E04-f（R05 阴性）直播/转播上下文里的"画面/镜头"不产生候选（判据只在媒体上下文之外才响）',
    !rl.candidates.some((c) => /camera/.test(c.rule_id)),
    JSON.stringify(rl.candidates.map((c) => c.rule_id)));
  // R11：密度很高但功能成立（无骨架重复、无段内重复）→ 允许不修改。
  const dense = '他数了三遍。三遍都是同一个数。\n\n窗外的雨越下越密，落在雨棚上，敲出一串没有间隙的声音。\n\n他把手指从纸上挪开，留下四个浅浅的印子。\n\n楼下有人在搬东西，铁皮刮过水泥地，声音长而干。';
  const rd = narrativeCandidateSignals(dense, {});
  check('E04-g（R11 阴性）高密度但功能成立的段落不产生候选（观察数据不自动进入补丁清单）',
    rd.candidates.length === 0, JSON.stringify(rd.candidates.map((c) => c.rule_id)));
  // 数据不足：过短 / 全对白必须显式返回，而不是硬判。
  const short = narrativeCandidateSignals('甲。\n\n乙。', {});
  check('E04-h', '过短文本显式返回 insufficient_data（不硬判）',
    short.insufficient_data.some((x) => /段落数/.test(x.reason)) && short.candidates.length === 0);
  const allDialogue = narrativeCandidateSignals(Array.from({ length: 6 }, (_, i) => `「第${i + 1}句台词，说的是同一件事。」`).join('\n\n'), {});
  check('E04-i', '全对白文本显式返回 insufficient_data（对白的重复不能按叙述冗余判）',
    allDialogue.insufficient_data.some((x) => x.diagnostic === 'redundant_explanation' && /对白段占比/.test(x.reason))
    && allDialogue.insufficient_data.some((x) => x.diagnostic === 'reaction_homogeneity'),
    JSON.stringify(allDialogue.insufficient_data));
}

// ── 两版样本的候选差异（回归材料，不当作"改善证明"） ───────────────────────
{
  const scanBefore = narrativeCandidateSignals(before, {});
  check('E04-j', '两版样本都能跑出候选，且不因版本不同而改变判据口径',
    scanBefore.schema_version === scanAfter.schema_version && scanBefore.scan_version === scanAfter.scan_version
    && scanBefore.measured.paragraphs > 0 && scanAfter.measured.paragraphs > 0,
    JSON.stringify({ before: scanBefore.candidates.length, after: scanAfter.candidates.length }));
  check('E04-j2', '测量值随结果一起给出（可核对"改了系统还是只改了某一章"）',
    Number.isFinite(scanAfter.measured.chars) && Number.isFinite(scanAfter.measured.dialogue_ratio)
    && scanAfter.advisory_signals.every((a) => /描述性线索/.test(a.note)));
}

// ── 审稿协议层：引用核验 / 反证要求 / 保护分区 ─────────────────────────────
{
  const text = '他不认识画面里那个女生。这道光柱和他没关系，这场雪和他也没关系。';
  const good = {
    id: 'N04', kind: 'narrative', severity: 'medium', verdict: 'confirmed', rule_id: 'redundant_explanation',
    evidence: [{ quote: '这道光柱和他没关系，这场雪和他也没关系。', source: 'body' }],
    reading_cost: '同一层意思说了两遍，读者的注意力被拖住',
    rationale: '前句已表达"与他无关"，后句用同一句式再说一次',
    counterevidence: '若作者有意用排比表达"什么都不属于他"，则不是冗余',
    suggested_action: 'condense',
  };
  const ok = validateNarrativeFinding(good, { text });
  check('E04-k', '逐字引用可定位时校验通过', ok.ok === true && ok.errors.length === 0, JSON.stringify(ok.errors));

  const fake = { ...good, evidence: [{ quote: '这道光柱与他无关，雪也与他无关。', source: 'body' }] };
  check('E04-l', '伪造引用（不是逐字）被拒绝，且理由可读',
    validateNarrativeFinding(fake, { text }).ok === false
    && /找不到/.test(validateNarrativeFinding(fake, { text }).errors.join('|')));

  // 引用的**唯一性**：同一句话在正文里出现两次时不得猜第一处（夹具必须真的含两次，否则这条断言没在测东西）。
  const ambiguous = validateNarrativeFinding({ ...good, evidence: [{ quote: '和他没关系', source: 'body' }] }, { text: '他不认识她。这道光柱和他没关系。这场雪和他没关系。' });
  check('E04-l2', '正文里出现多次的引用 → 拒绝（不猜第一处）',
    ambiguous.ok === false && /多次/.test(ambiguous.errors.join('|')), JSON.stringify(ambiguous.errors));

  const noCounter = { ...good, counterevidence: '' };
  const normed = normalizeNarrativeFindings([good, noCounter, fake], { text });
  check('E04-m', '反证缺失 → 降级 hypothesis 且不进入 auto_eligible（引用不合规的直接拒收）',
    normed.findings.length === 2 && normed.findings[0].verdict === 'confirmed' && normed.findings[0].auto_eligible === true
    && normed.findings[1].verdict === 'hypothesis' && normed.findings[1].downgraded_for_missing_counterevidence === true
    && normed.findings[1].auto_eligible === false
    && normed.rejected.length === 1 && /找不到/.test(normed.rejected[0].errors.join('|')),
    JSON.stringify({ counts: normed.counts, auto: normed.auto_eligible_count }));
  check('E04-m2', 'schema_version 固定为 2（ReviewV2）', normed.schema_version === REVIEW_SCHEMA_VERSION && normed.schema_version === 2);

  const obs = { ...good, id: 'obs', kind: 'observation' };
  const obsNorm = normalizeNarrativeFindings([obs], { text });
  check('E04-n', '观察类（observation）即使 confirmed 也不进 auto_eligible',
    obsNorm.findings[0].verdict === 'confirmed' && obsNorm.findings[0].auto_eligible === false);

  const part = partitionProtections({
    protectedSpans: ['p3'], approvedContractSpans: ['p7'], editorialSpans: ['p9'],
    findings: [{ id: 'N08', suggested_action: 'keep', keep_reason: '结尾短句承担查验停顿' }],
  });
  check('E04-o', '三类保护分区：前两类进 hard_spans，编辑建议只进 suggested_spans，保留项随报告交付',
    part.hard_spans.join(',') === 'p3,p7' && part.suggested_spans.join(',') === 'p9'
    && part.kept.length === 1 && /不可由模型自行解除/.test(part.note),
    JSON.stringify(part));
}

{
  // 提示词契约（§9.2）：变量由 Host 填充；必须显式声明"候选不是修改命令"与反证要求。
  const prompt = buildNarrativeReviewPrompt({
    snapshot: { snapshot_id: 'ch1@abc', body_hash: 'fnv1a:x:10', chapter_id: 1, normalization_version: 'raw_v1' },
    candidates: scanAfter.candidates.slice(0, 2),
    approvedContext: '【故事状态】…',
    enabledRules: DIAGNOSTICS,
    protectedSpans: [{ span_id: 'p3', text: '然后她不一样了。' }],
  });
  check('E04-p', '审稿提示词含快照身份 / 候选（标注"不是修改命令"）/ 反证要求 / 受保护跨度 / 不输出改写正文',
    prompt.includes('ch1@abc') && prompt.includes('不是修改命令') && prompt.includes('反证')
    && prompt.includes('受保护跨度') && prompt.includes('不输出改写正文')
    && prompt.includes('ReviewV2'),
    prompt.slice(0, 60));
  check('E04-q', 'locateQuote 是去空白比对（模型把软换行抄成空格仍算逐字）',
    locateQuote('甲段。\n乙段。', '甲段。乙段。').found === true
    && locateQuote('甲段。', '乙段。').found === false);
  check('E04-r', '段落/句子切分口径可复核（供 Host 生成 span 时复用）',
    narrativeParagraphsOf('甲。\n\n乙。\n\n丙。').length === 3 && sentencesOf('甲。乙！丙？').length === 3);
}

finish('04-narrative-scan');
