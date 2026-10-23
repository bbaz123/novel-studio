/**
 * ai/quality-auditor/relevance.mjs —— 「这条反例到底在反驳什么？」（确定性相关性筛选，零计费）。
 *
 * 为什么需要单独一层：2026-10-22 的真实误报是——
 * 初审说"系统首次上线时保持克制、没有急着解释自己"，审计员把"前面的平头男生一直在说话"
 * 当成**反例**记成 DISPUTED。两者主语不同、谓词不同、范围也不同，这根本不是"互相否认"，
 * 却被呈现成"作者判错了"。作者据理力争时，看到的是审计员拿一句无关的话否掉了他的观察。
 *
 * 这一层只做**筛选**，不做裁决：
 *   · 证据逐字存在（由 evidence.mjs / coordinator 负责，这里不重复）；
 *   · 再看 claim 与反例的**词面重叠**是否达到最低门槛；
 *   · 达到 → RELEVANT（真反例，可以标 DISPUTED）；
 *   · 只有 1 个共享词 → ADVISORY_NEEDS_REVIEW（太弱，不能据此降低整份报告的质量）；
 *   · 完全不重叠 → INVALID_RELEVANCE（不相干，禁止呈现成"互相否认"）。
 *
 * 为什么用"中文二元组 + 英文词"而不是分词器：本项目零依赖，装上分词器等于给运行时加一个
 * 不可控的第三方；而"是否在同一件事上说话"只需要**共现信号**，不需要词性标注。
 * 代价我已经知道：同义词（"系统"/"它"）会被判成不相干。所以这一层**只会降级、不会升级**，
 * 降级后作者仍能看到原判断与审计理由 —— 宁可少判一个反例，也不能凭空多判一个。
 */

/** 单字停用词：只用来过滤"两个字符都是虚词"的二元组（例如 的了、是在、也都）。 */
const STOP_CHARS = new Set('的了是在和也都就而及与或很更最又还只把被给让对从向为以于之其这那此我你他她它们个一不没'.split(''));

/** 否定标记：claim 与反例的否定方向不一致时，"同一件事"就未必成立，单独记下来供人工看。 */
const NEGATION_RE = /(没有|没|不曾|从未|从不|并未|尚未|无一人|无人|不再|不会|不能)/;

const CJK_RE = /[\u4e00-\u9fa5]/;

/** 连续中文字符的二元组（跨标点/空白的字不会拼成二元组）。 */
export function cjkBigrams(text) {
  const out = [];
  let run = [];
  for (const ch of String(text == null ? '' : text)) {
    if (CJK_RE.test(ch)) { run.push(ch); continue; }
    flush(run, out);
    run = [];
  }
  flush(run, out);
  return out;
}

function flush(run, out) {
  for (let i = 0; i + 1 < run.length; i += 1) {
    const a = run[i];
    const b = run[i + 1];
    // 两个字符都是虚词 → 这个词组不承载"在说哪件事"的信息。
    if (STOP_CHARS.has(a) && STOP_CHARS.has(b)) continue;
    out.push(a + b);
  }
}

/** 参与比较的词：中文二元组 + 英文/数字词（≥2 字符）。 */
export function claimTokens(text) {
  const s = String(text == null ? '' : text);
  const ascii = (s.match(/[A-Za-z0-9_]{2,}/g) || []).map((x) => x.toLowerCase());
  return [...new Set([...cjkBigrams(s), ...ascii])];
}

/** claim 的浅层信号（只用于解释，不参与扣分）。 */
export function claimSignals(text) {
  const s = String(text == null ? '' : text);
  return {
    tokens: claimTokens(s),
    negation: NEGATION_RE.test(s),
    time: (s.match(/(首次|第一次|一开始|起初|后来|随后|现在|此刻|当时|那天|今天|昨天|早上|中午|晚上)/g) || []),
    // "谁"的候选：句首到第一个谓词前的片段（仅显示用，不参与判定）。
    subject_hint: s.split(/[，。！？；：,.;:!?]/)[0].slice(0, 24),
  };
}

const MIN_OVERLAP = 2;

/**
 * 一条 claim 与它的反例是否在说同一件事。
 *
 * @param {{claim?:string, counterEvidence?:string|string[]}} input
 * @returns {{verdict:'RELEVANT'|'ADVISORY_NEEDS_REVIEW'|'INVALID_RELEVANCE', overlap:string[],
 *            claim_tokens:string[], counter_tokens:string[], reasons:string[]}}
 */
export function relevanceOf(input = {}) {
  const claim = String(input.claim == null ? '' : input.claim);
  const list = Array.isArray(input.counterEvidence)
    ? input.counterEvidence
    : (input.counterEvidence == null ? [] : [input.counterEvidence]);
  const counter = list
    .map((e) => String(e && typeof e === 'object' ? (e.quote != null ? e.quote : e.text) : e))
    .filter((s) => s.trim())
    .join('\n');
  const claimTok = claimTokens(claim);
  const counterTok = claimTokens(counter);
  const counterSet = new Set(counterTok);
  const overlap = claimTok.filter((t) => counterSet.has(t));
  const reasons = [];
  if (!claim.trim()) {
    return { verdict: 'INVALID_RELEVANCE', overlap, claim_tokens: claimTok, counter_tokens: counterTok, reasons: ['没有可判定的主张原文：不能把"缺少主张"当成"主张被驳倒"'] };
  }
  if (!counter.trim()) {
    return { verdict: 'INVALID_RELEVANCE', overlap, claim_tokens: claimTok, counter_tokens: counterTok, reasons: ['没有给出反例的逐字证据：不算反驳'] };
  }
  const negationMismatch = NEGATION_RE.test(claim) !== NEGATION_RE.test(counter);
  if (overlap.length >= MIN_OVERLAP) {
    if (negationMismatch) reasons.push('否定方向不同，但共享词足够：按"同一件事上的相反陈述"处理');
    return { verdict: 'RELEVANT', overlap, claim_tokens: claimTok, counter_tokens: counterTok, reasons };
  }
  if (overlap.length === 1) {
    reasons.push(`只共享 1 个词（${overlap[0]}）：不足以证明在说同一件事`);
    return { verdict: 'ADVISORY_NEEDS_REVIEW', overlap, claim_tokens: claimTok, counter_tokens: counterTok, reasons };
  }
  reasons.push('主张与反例没有任何共享词：主语/谓词/范围都对不上，不能呈现成"互相否认"');
  return { verdict: 'INVALID_RELEVANCE', overlap: [], claim_tokens: claimTok, counter_tokens: counterTok, reasons };
}

/**
 * 逐条筛选对照结论里的 DISPUTED。
 *
 * 输入是 coordinator 里那两份已经冻结的东西：初审报告（找 claim 原文）与 final 提交里的
 * `initial_findings`（找审计员给的反例）。不读库、不调模型。
 *
 * @returns {{byIssueId:Map<string, object>, downgrades:Array<object>}}
 */
export function screenDisputes({ initialFindings = [], compareInitial = [] } = {}) {
  const textById = new Map();
  for (const f of Array.isArray(initialFindings) ? initialFindings : []) {
    const id = String(f && f.id || '');
    if (!id) continue;
    // claim = 初审那条判断的正文（标题优先，回退到说明）。
    textById.set(id, String((f && (f.title || f.explanation || f.text)) || ''));
  }
  const byIssueId = new Map();
  const downgrades = [];
  for (const c of Array.isArray(compareInitial) ? compareInitial : []) {
    const id = String(c && c.issue_id || '');
    const verdict = String(c && c.verdict || '');
    if (!id || verdict !== 'DISPUTED') continue;
    const counter = c && c.counter_evidence != null ? c.counter_evidence : c && c.evidence;
    const screen = relevanceOf({ claim: textById.get(id) || '', counterEvidence: counter });
    byIssueId.set(id, screen);
    if (screen.verdict !== 'RELEVANT') {
      downgrades.push({
        issue_id: id,
        verdict: screen.verdict,
        overlap: screen.overlap,
        reasons: screen.reasons,
        // 降级不等于"作者一定对"：条目仍在，只是不允许被当成"已被驳倒"。
        downgraded_from: 'DISPUTED',
        downgraded_to: 'ADVISORY_NEEDS_REVIEW',
      });
    }
  }
  return { byIssueId, downgrades };
}
