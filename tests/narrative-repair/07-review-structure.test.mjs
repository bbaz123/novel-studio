/**
 * tests/narrative-repair/07-review-structure.test.mjs —— E03：审稿报告结构化与引用核验（离线、零计费）。
 *
 * 覆盖任务书 §6.2 / §7 E03 的**确定性**部分：
 *   · 结构化 findings 必须过**引用核验**：逐字定位不到、或正文里出现多次 → 拒收（带理由，不静默丢弃）；
 *   · 反证缺失 → 降级 hypothesis（并在兼容清单里标出来），不得当作已确认的问题；
 *   · 兼容清单（issues 行文本）由结构化结论**派生**，使"这一条指哪句话"可读；
 *   · 只有行文本（旧口径）时逐字沿用旧行为 —— 不改变既有审稿链路；
 *   · findings 不是合法 JSON 时**如实报告**（不吞掉整份报告）。
 */
import { createChecks, loadFixtures } from './harness.mjs';
import { structureReviewReport } from '../../ai/editing/narrative-review.mjs';

const { check, finish } = createChecks();
const { after } = loadFixtures();
const text = '他不认识画面里那个女生。这道光柱和他没关系，这场雪和他也没关系。\n\n然后她不一样了。';

const good = {
  id: 'N04', kind: 'narrative', severity: 'medium', verdict: 'confirmed',
  evidence: [{ quote: '这道光柱和他没关系，这场雪和他也没关系。', source: 'body' }],
  reading_cost: '同一层意思说了两遍',
  rationale: '前句已表达"与他无关"，后句再说一次',
  counterevidence: '若作者有意排比表达"什么都不属于他"，则不是冗余',
  suggested_action: 'condense',
};
const fabricated = { ...good, id: 'X1', evidence: [{ quote: '这道光柱与他无关，雪也与他无关。', source: 'body' }] };
const noCounter = { ...good, id: 'H1', counterevidence: '' };

{
  const r = structureReviewReport({ summary: '总评', issues: [], findings: [good, fabricated, noCounter] }, { text });
  check('E03-a 结构化输入走 ReviewV2 口径：通过核验的进入 findings，引用不合规的被拒收（带理由）',
    r.structure === 'review_v2' && r.findings.length === 2 && r.rejected.length === 1
    && r.rejected[0].id === 'X1' && /找不到/.test(r.rejected[0].errors.join('|')),
    JSON.stringify({ structure: r.structure, accepted: r.findings.length, rejected: r.rejected.map((x) => x.id) }));
  check('E03-a2 反证缺失 → 降级 hypothesis 且不进入 auto_eligible（可看、可讨论，但不是已确认）',
    r.findings[1].verdict === 'hypothesis' && r.findings[1].auto_eligible === false
    && r.counts.accepted === 2);
  // 2026-10-21（review.v3）：issues 由字符串改为**对象**（id/text/source/finding_id）。
  // 断言相应读取 `.text`，同时把"带稳定 id"这一点也钉住 —— 这是本次改造的目的，不是副作用。
  const issueText = (x) => String(x && typeof x === 'object' ? x.text : x);
  check('E03-b 兼容清单由结构化结论派生：带 id、理由与逐字引用，界面能看出"这一条指哪句话"',
    r.issues.length === 2 && /^\[N04\]/.test(issueText(r.issues[0]))
    && issueText(r.issues[0]).includes('这道光柱和他没关系')
    && /⚠️未给出反证/.test(issueText(r.issues[1]))
    && typeof r.issues[0] === 'object' && r.issues[0].id === 'N04' && r.issues[0].finding_id === 'N04',
    JSON.stringify(r.issues));
  check('E03-b2 拒收的条目**不**混进兼容清单（避免作者以为它已被采纳）',
    !r.issues.some((x) => issueText(x).includes('X1') && !issueText(x).includes('拒收')));
}

{
  // 2026-10-23 现场（修稿选择映射断裂 REVIEW_SELECTION_MISSING_FINDING）：
  // 模型把同一条问题写了两遍 —— issues 里一段散文、findings 里一条结构化。旧去重只比较
  // "派生行是否包含这一行的前 20 字"，而两处措辞几乎从不逐字相同，于是每条被接受的 finding
  // 都会额外留下一条 id:'' 的未链接项：清单从 9 条变成 18 条，默认全勾选 → 修稿前的映射闸门
  // fail-closed，整章无法精确修稿。这里钉住"同义改写要算重复、真·额外问题要保留"。
  // 措辞取自 2026-10-23 的真实报告（review 32）：finding.rationale 与 issues 散文行讲同一件事，
  // 后者多一句建议 —— 旧前缀判据因此一条也没去掉。
  const rationale = '位置：进大厅前的排队段。广播已经把流程说全（「交表、按掌、等结果，全程不超过三分钟」），'
    + '隔了几段叙述者又用「流程其实只有三步」重述一遍，紧接着把全套后果也讲完：'
    + '「念什么学校、进不进防卫体系、家里人是哭还是笑，全在这三步里」。';
  const paraphrase = rationale + '建议删掉这三步与后果的总结句，让规则由场景自己交代。';
  const distinctExtra = '位置：第三章开头。上一章时间线已经推进到傍晚，这一章又写「刚过正午」，跨章时间倒退。';
  const structured = structureReviewReport({
    summary: '总评',
    issues: [paraphrase, distinctExtra],
    findings: [{ ...good, id: 'N04', rationale }],
  }, { text });
  const ids = structured.issues.map((x) => (x && typeof x === 'object' ? String(x.id) : ''));
  check('E03-g 同义改写的 issues 行不再重复成未链接项（否则默认全勾选会让修稿映射闸门整体 fail-closed）',
    structured.issues.length === 2 && ids[0] === 'N04',
    JSON.stringify(ids));
  check('E03-g2 真正额外的问题仍如实保留为未链接项（不能为了去重把它吞掉）',
    ids.length === 2 && ids[1] === '' && String(structured.issues[1].text || '').includes('跨章时间倒退'),
    JSON.stringify(structured.issues[1]));
}

{
  // 旧口径：只有行文本 → 逐字沿用旧行为（这条是"不破坏既有链路"的证据）
  const legacy = structureReviewReport({ summary: '总评', issues: ['问题一', '问题二'], strengths: ['优点一'] }, { text });
  check('E03-c 只有行文本（旧口径）时逐字沿用：issues 原样、structure 标 legacy_lines',
    legacy.structure === 'legacy_lines' && legacy.issues.join('|') === '问题一|问题二'
    && legacy.findings.length === 0 && legacy.strengths.join('|') === '优点一');
}

{
  const bad = structureReviewReport({ summary: '总评', issues: ['问题一'], findings: '{ 这不是 JSON' }, { text });
  check('E03-d findings 不是合法 JSON → 如实报告并保留行文本问题（不吞掉整份报告）',
    bad.structure === 'findings_unparsable' && bad.issues.join('|') === '问题一'
    && /不是合法 JSON/.test(bad.structure_note),
    bad.structure_note);
  const empty = structureReviewReport({ summary: '总评', issues: [], findings: [] }, { text });
  check('E03-d2 findings 为空数组时按旧口径处理（不伪造成 review_v2）', empty.structure === 'legacy_lines');
}

{
  // 结构化字符串输入（模型常把 JSON 塞进字符串参数）
  const fromString = structureReviewReport({ summary: '总评', issues: '', findings: JSON.stringify([good]) }, { text, baseHash: 'fnv1a:x:10' });
  check('E03-e 模型把 findings 作为 JSON 字符串提交时同样能结构化（并记录 base_hash）',
    fromString.structure === 'review_v2' && fromString.findings.length === 1 && fromString.base_hash === 'fnv1a:x:10');
  check('E03-e2 同一份审稿里"重复引用"的条目被拒收（正文里出现两次的句子不能当唯一证据）',
    (() => {
      const dup = structureReviewReport({ summary: 's', issues: [], findings: [{ ...good, id: 'D1', evidence: [{ quote: '和他没关系', source: 'body' }] }] }, { text: '他不认识她。这道光柱和他没关系。这场雪和他没关系。' });
      return dup.rejected.length === 1 && /多次/.test(dup.rejected[0].errors.join('|'));
    })());
  check('E03-f 冻结样本上结构化一份真实形状的报告：引用确实取自正文（逐字）则通过',
    (() => {
      // 引用**从正文里现取**一句（不手写：手写的"看起来像正文"的句子会把这条测成"引用不存在"）。
      const quote = after.split('\n').map((l) => l.trim()).find((l) => l.length >= 20 && l.length <= 60);
      const r = structureReviewReport({
        summary: 's', issues: [],
        findings: [{ ...good, id: 'N01', evidence: [{ quote, source: 'body' }] }],
      }, { text: after });
      return !!quote && r.findings.length === 1 && r.findings[0].id === 'N01';
    })());
}

finish('07-review-structure');
