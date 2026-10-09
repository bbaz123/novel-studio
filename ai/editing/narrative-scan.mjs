/**
 * 面向功能的叙事诊断 · **确定性候选层**（E04，2026-10-09）。
 *
 * 定位：只产出**候选信号**（每一条都带准确原文引用与"为什么它可能只是有意手法"），
 * 语义判断在 `narrative-review.mjs` 的模型侧协议里做。判据层**从不定罪**：
 * 它不返回"应当删掉/应当改成什么"，也不产生可直接应用的补丁。
 *
 * 与 `ai/editing/scan.mjs` 的分工（任务书 §7 E04 明写"复用确定性统计作为候选来源，不复制它的词表"）：
 *   · 「同形流程复现」「群众反应功能重复」「不在转播上下文里的镜头调度」直接**消费 scanEditing 的
 *     findings**（`deterministic:process-shape-repeat` / `crowd-function-repeat` / `camera-outside-media`）；
 *   · 本模块只补三类 scan.mjs 没有的**结构**测量（全部基于字符 bigram 的文档频率，**不使用任何词表**）：
 *     ① 同一段内同一个非通用 bigram 反复出现（"这道光柱和他没关系，这场雪和他也没关系"这一形状）；
 *     ② 相邻段落的字符 bigram 包含度过高（同一件事被两段各证明一次）；
 *     ③ 相邻句子的**骨架**重复（"落在A。落在B。落在C。"这一形状）。
 *
 * ⚠️ 三条纪律（与 scan.mjs 一致）：
 *   · 确定性层只报"可能是问题"的候选，`requires_semantic_check` 永远为 true；
 *   · 数据不足时返回 `insufficient_data`，**不硬判**（全对白、过短、样本不足都会落到这里）；
 *   · 排比、时间跳跃、短句、心理描写、直播上下文本身都不是错误——候选里必须带上对应的反证提示。
 */
import { scanEditing } from './scan.mjs';

export const NARRATIVE_SCAN_VERSION = '1.0.0';

/** 本轮核心四类诊断（任务书 §5.3）。id 与 §5.3 表格一一对应。 */
export const DIAGNOSTICS = ['repeated_mechanism', 'redundant_explanation', 'spectacle_redundancy', 'reaction_homogeneity'];

export const DIAGNOSTIC_META = {
  repeated_mechanism: {
    question: '同一流程再次展开时，新信息在哪里？',
    counterevidence: '第二次流程本身产生反转或关键因果时，它不是问题；假设句与梦境不算"流程被演示了一遍"。',
  },
  redundant_explanation: {
    question: '动作/事实已经表达之后，是否又解释了相同含义？',
    counterevidence: '不同层次的心理、必要的视角限定、叙述可靠性变化都不算重复解释。',
  },
  spectacle_redundancy: {
    question: '多处视觉落点是否在反复证明同一规模？',
    counterevidence: '故意升级、喜剧/恐怖的累积、有效排比都可能成立——不按删除比例强行通过。',
  },
  reaction_homogeneity: {
    question: '群众或人物是否只在轮流执行相同反应？',
    counterevidence: '性格差异、关系变化或新信息确实存在时，这些反应就不是同质的。',
  },
};

/** scan.mjs 的 rule_id → 本轮四类诊断（**消费**它，不复制它的判据）。 */
const RULE_TO_DIAGNOSTIC = {
  'deterministic:process-shape-repeat': 'repeated_mechanism',
  'deterministic:crowd-function-repeat': 'reaction_homogeneity',
  'deterministic:camera-outside-media': 'spectacle_redundancy',
  'deterministic:duplicate-paragraph': 'redundant_explanation',
  'deterministic:duplicate-sentence': 'redundant_explanation',
};

/** 描述性测量（不进入候选、不自动可采纳）：时间轴密度与摄像机化线索。 */
const ADVISORY_RULES = ['deterministic:timeline-density', 'deterministic:pov-observer'];

const CJK = /[\u3400-\u9fff\u3040-\u30ffA-Za-z0-9]/;

/** 段落口径：空行分段（与生成/修稿链路的 `\n{2,}` 一致），保留段号供引用。 */
export function narrativeParagraphsOf(text) {
  return String(text == null ? '' : text)
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, i) => ({ index: i, text: t }));
}

/** 句子切分（句末标点 + 收尾引号）：只用于"骨架重复"这一类结构测量。 */
export function sentencesOf(paragraphText) {
  const s = String(paragraphText || '');
  const out = [];
  let cur = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (/[。！？!?…]/.test(s[i])) {
      let j = i + 1;
      while (j < s.length && /[。！？!?…”’"』」）)】》]/.test(s[j])) j += 1;
      out.push(s.slice(cur, j));
      cur = j;
      i = j - 1;
    }
  }
  if (cur < s.length) out.push(s.slice(cur));
  return out.map((t) => t.trim()).filter(Boolean);
}

/** 字符 n-gram（只用字符，不用词表）。 */
export function ngramsOf(text, n = 2) {
  const s = String(text == null ? '' : text);
  const out = [];
  let run = '';
  for (let i = 0; i <= s.length; i += 1) {
    const c = s[i];
    if (c && CJK.test(c)) { run += c; continue; }
    for (let k = 0; k + n <= run.length; k += 1) out.push(run.slice(k, k + n));
    run = '';
  }
  return out;
}
export const bigramsOf = (text) => ngramsOf(text, 2);

/**
 * 通用 n-gram（跨段高频）：用**文档频率**判定，而不是维护一张停用词表 ——
 * "他的/一直/然后"这类在多数段落里都会出现，视作通用；"没关系"这种只在一两段里反复的不算。
 *
 * ⚠️ 段内重复用 **3-gram**：2-gram 在中文里几乎每段都能凑出重复（实测在冻结样本上产出 16 条
 * 噪音候选，precision 极低），而 3-gram 才对应"同一个说法被说了两遍"这一形状。
 */
function genericGrams(paras, n) {
  const df = new Map();
  for (const p of paras) {
    for (const g of new Set(ngramsOf(p.text, n))) df.set(g, (df.get(g) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(paras.length * 0.4));
  const generic = new Set();
  for (const [g, count] of df) if (count >= threshold) generic.add(g);
  return { generic, df };
}

const quoted = (s, max = 60) => {
  const t = String(s || '');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};

function pushCandidate(out, c) {
  out.push({
    candidate_id: `cand-${out.length + 1}-${c.diagnostic}`,
    diagnostic: c.diagnostic,
    rule_id: c.rule_id,
    paragraph: Number.isFinite(c.paragraph) ? c.paragraph : null,
    paragraphs: Array.isArray(c.paragraphs) ? c.paragraphs : [],
    quote: c.quote || '',
    quotes: Array.isArray(c.quotes) ? c.quotes : (c.quote ? [c.quote] : []),
    evidence: c.evidence || '',
    counterevidence_hint: DIAGNOSTIC_META[c.diagnostic] ? DIAGNOSTIC_META[c.diagnostic].counterevidence : '',
    // 确定性层永远不定罪：一切候选都必须过语义核对；只允许"压缩/核对"，不返回"删除"。
    requires_semantic_check: true,
    suggested_action: c.suggested_action || 'check',
    severity: c.severity || 'low',
    deterministic: true,
    source: c.source || 'narrative-scan',
  });
}

/**
 * 候选信号入口。
 * @param {string} text 章节正文（纯文本）
 * @param {{characters?:object[], genre?:string}} opts
 * @returns {{candidates:Array, advisory_signals:Array, measured:object, insufficient_data:Array, deterministic:true}}
 */
export function narrativeCandidateSignals(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const paras = narrativeParagraphsOf(raw);
  const candidates = [];
  const insufficient = [];
  const note = (diagnostic, reason) => insufficient.push({ diagnostic, reason });

  // scan.mjs：**消费**它的确定性 findings（能力开关只影响要不要产出 finding，测量值总会算）。
  let scan = { findings: [], scanned: {} };
  try {
    scan = scanEditing(raw, { abilities: ['story-shape'], genre: opts.genre, characters: opts.characters, task: 'review' });
  } catch (e) {
    note('*', `确定性统计不可用（${e && e.message ? e.message : e}）：本次只给结构候选`);
  }
  const findings = Array.isArray(scan.findings) ? scan.findings : [];
  // ⚠️ 段号口径必须统一：scan.mjs 的 `paragraphsOf` 按 `\n+` 切，而本模块按空行（`\n{2,}`）切
  //   —— 两者在"一段里有软换行"的稿子上会差位。这里用**引用原文**把它的段号换算到本模块的段号。
  //   实测的 scan 侧形态：finding 可能**没有 quote**，只有 `excerpt`，而 excerpt ①带它自己的段标签
  //   （"第3段：…"）②中间被截断成 `…`。所以定位要：剥标签 → 去掉省略号 → 拿开头 12 字做无空白包含匹配；
  //   内容匹配不到时才敢用它的段标签，且**仅当两边段数一致**（否则口径不同，宁可标"未能定位"）。
  const scanParagraphCount = Number(scan.scanned && scan.scanned.paragraphs) || 0;
  const paraIndexByFinding = (f) => {
    const raw = String((f && (f.quote || f.excerpt)) || '').trim();
    if (!raw) return -1;
    const label = /^第\s*(\d+)\s*段[:：]/.exec(raw);
    const labelIdx = label ? Number(label[1]) - 1 : -1;
    const content = raw.replace(/^第\s*\d+\s*段[:：]\s*/, '').replace(/…+/g, ' ').trim();
    const tries = [
      content.slice(0, 12),
      content.replace(/\s+/g, '').slice(0, 12),
      content.split(/[，。！？；：]/).filter((x) => x.replace(/\s+/g, '').length >= 6)[0],
    ];
    for (const t of tries) {
      const needle = String(t || '').replace(/\s+/g, '');
      if (needle.length < 4) continue;
      const idx = paras.findIndex((p) => p.text.replace(/\s+/g, '').includes(needle));
      if (idx >= 0) return idx;
    }
    if (labelIdx >= 0 && scanParagraphCount > 0 && paras.length === scanParagraphCount) return labelIdx;
    return -1;
  };
  for (const f of findings) {
    const diagnostic = RULE_TO_DIAGNOSTIC[f.rule_id];
    if (diagnostic) {
      const mapped = paraIndexByFinding(f);
      const scanIndex = Number.isFinite(f.paragraph) ? f.paragraph : null;
      pushCandidate(candidates, {
        diagnostic,
        rule_id: `${f.rule_id}（来自 scan.mjs）`,
        paragraph: mapped >= 0 ? mapped : scanIndex,
        quote: f.quote || f.excerpt || '',
        quotes: f.quote ? [f.quote] : [],
        evidence: `确定性统计命中：${f.rule_id}${f.evidence ? `｜${f.evidence}` : ''}`
          + (mapped >= 0 ? '' : `（段号沿用 scan.mjs 口径${scanIndex === null ? '' : ` p${scanIndex}`}：引用原文未能定位到本模块的段落）`),
        // scan 的命中本身是事实（例如"同一流程被完整演示两次"）——但"该不该改"仍要语义核对。
        severity: f.severity || 'low',
        suggested_action: diagnostic === 'repeated_mechanism' ? 'condense' : 'check',
        source: 'scan.mjs',
      });
    } else if (ADVISORY_RULES.includes(f.rule_id)) {
      // 时间轴密度 / 摄像机化：只做描述性线索，不进候选（它们不构成本轮四类诊断）。
      continue;
    }
  }
  const advisory = findings
    .filter((f) => ADVISORY_RULES.includes(f.rule_id))
    .map((f) => ({ rule_id: f.rule_id, paragraph: f.paragraph, quote: quoted(f.quote || f.excerpt || ''), evidence: f.evidence || '', note: '描述性线索：只供人读，不进入候选、不自动可采纳' }));

  // 数据不足的显式返回（不硬判）。
  if (paras.length < 4) note('*', `段落数 ${paras.length} < 4：结构判据在这么短的文本上没有判别力（insufficient_data）`);
  const dialogueLike = paras.filter((p) => /^[「“"']/.test(p.text)).length;
  const dialogueRatio = paras.length ? dialogueLike / paras.length : 0;
  if (dialogueRatio >= 0.75) {
    note('redundant_explanation', `对白段占比 ${(dialogueRatio * 100).toFixed(0)}% ≥ 75%：对白里的重复是人物说话方式，不能按叙述冗余判`);
    note('reaction_homogeneity', '全篇以对白为主：群众/人物反应不在叙述层，判据不适用');
  }
  if (!paras.length) note('*', '正文为空：没有可诊断的内容');

  const { generic: generic2 } = genericGrams(paras, 2);
  const { generic: generic3 } = genericGrams(paras, 3);
  const skeletonParas = new Set();
  const repeatedParas = new Set();

  // ① 同一段内非通用 **3-gram** 反复出现（N04 那一形状："没关系…也没关系…"）。
  //    每段最多留一条（取出现次数最高的那个说法），避免同一段被刷出一串同义候选。
  paras.forEach((p) => {
    if (p.text.length < 24) return;
    const counts = new Map();
    for (const g of ngramsOf(p.text, 3)) {
      if (generic3.has(g)) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    if (!repeated.length) return;
    const [g, n] = repeated[0];
    repeatedParas.add(p.index);
    pushCandidate(candidates, {
      diagnostic: 'redundant_explanation',
      rule_id: 'structure:in-paragraph-repeat',
      paragraph: p.index,
      quote: quoted(p.text, 80),
      evidence: `同一段内「${g}」这个说法出现 ${n} 次（该 3-gram 在本章只覆盖少数段落，不属于通用连接词）`,
      severity: 'low',
      suggested_action: 'condense',
      source: 'narrative-scan',
    });
  });

  // ② 相邻段落的字符 bigram 包含度过高（同一件事被两段各证明一次）。
  for (let i = 1; i < paras.length; i += 1) {
    const a = new Set(ngramsOf(paras[i - 1].text, 2).filter((g) => !generic2.has(g)));
    const b = new Set(ngramsOf(paras[i].text, 2).filter((g) => !generic2.has(g)));
    if (a.size < 8 || b.size < 8) continue;
    const small = a.size <= b.size ? a : b;
    const big = a.size <= b.size ? b : a;
    let hit = 0;
    for (const g of small) if (big.has(g)) hit += 1;
    const containment = hit / small.size;
    if (containment < 0.6) continue;
    if (repeatedParas.has(paras[i].index) || repeatedParas.has(paras[i - 1].index)) continue;
    pushCandidate(candidates, {
      diagnostic: 'redundant_explanation',
      rule_id: 'structure:adjacent-overlap',
      paragraph: paras[i].index,
      paragraphs: [paras[i - 1].index, paras[i].index],
      quote: quoted(paras[i].text, 80),
      quotes: [quoted(paras[i - 1].text, 60), quoted(paras[i].text, 60)],
      evidence: `相邻两段的字符 bigram 包含度 ${(containment * 100).toFixed(0)}%（短的那段几乎被另一段覆盖）`,
      severity: 'low',
      suggested_action: 'condense',
      source: 'narrative-scan',
    });
  }

  // ③ 相邻句子的骨架重复（"落在A。落在B。落在C。"）：只比骨架（前 2 字 + 末字），不比内容。
  const flat = [];
  paras.forEach((p) => sentencesOf(p.text).forEach((s) => flat.push({ paragraph: p.index, text: s })));
  const skeleton = (s) => {
    const t = String(s).replace(/[\s「」“”"']/g, '');
    if (t.length < 4) return null;
    return `${t.slice(0, 2)}…${t.slice(-1)}`;
  };
  for (let i = 0; i < flat.length; i += 1) {
    const key = skeleton(flat[i].text);
    if (!key) continue;
    const group = [flat[i]];
    for (let j = i + 1; j < Math.min(flat.length, i + 5); j += 1) {
      if (skeleton(flat[j].text) === key) group.push(flat[j]);
    }
    if (group.length < 3) continue;
    const middles = new Set(group.map((g) => g.text.slice(2, -1)));
    if (middles.size < 2) continue; // 逐字相同属于"重复"，已由 scan.mjs 的重复判据覆盖
    group.forEach((g) => skeletonParas.add(g.paragraph));
    pushCandidate(candidates, {
      diagnostic: 'spectacle_redundancy',
      rule_id: 'structure:skeleton-repeat',
      paragraph: group[0].paragraph,
      paragraphs: [...new Set(group.map((g) => g.paragraph))],
      quote: quoted(group[0].text, 60),
      quotes: group.slice(0, 5).map((g) => quoted(g.text, 60)),
      evidence: `相邻 ${group.length} 句共用同一骨架（${key}）而填入不同内容：落点重复，规模信息已被反复证明`,
      severity: 'low',
      suggested_action: 'condense',
      source: 'narrative-scan',
    });
    i += group.length - 1;
  }

  candidates.sort((a, b) => (a.paragraph ?? -1) - (b.paragraph ?? -1) || a.diagnostic.localeCompare(b.diagnostic));
  return {
    schema_version: 1,
    scan_version: NARRATIVE_SCAN_VERSION,
    diagnostics: [...DIAGNOSTICS],
    candidates,
    advisory_signals: advisory,
    measured: {
      paragraphs: paras.length,
      chars: raw.length,
      dialogue_ratio: Number(dialogueRatio.toFixed(2)),
      // 复用 scan.mjs 的测量值（时间轴密度 / 同形流程 / 群众反应 / 摄像机化），原样透出，不改口径。
      style_shape: (scan.scanned && scan.scanned.style_shape) || null,
    },
    insufficient_data: insufficient,
    // 明确口径：这份结果**全部**来自确定性判据，未运行语义审稿；不得据此显示"叙事诊断完成"。
    semantic_status: 'not_run',
    deterministic: true,
  };
}
