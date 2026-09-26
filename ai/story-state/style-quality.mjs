/**
 * 确定性故事状态内核 · 风格与质量指标（PHASE 10）。
 *
 * ⚠ 本模块的第一条纪律：**指标是描述性的，不是规范性的。**
 *    它只回答"这一段和作者自己的习惯比，偏了多少"，**不回答**"这样写不好"。
 *    任何"为了指标好看而改文风"的行为都是质量红线明确禁止的——
 *    所以这里没有一个函数会返回"应当改成什么样"，全部只返回测量值 + 与基线的差。
 *
 * 指标集（全部可离线重算，不调用模型）：
 *   style_profile        句长分布 / 段落长度 / 对话占比 / 标点习惯
 *   style_dna            作者自己的"指纹"（从已有正文统计出的基线）
 *   cliche_density       反 AI 腔红线命中密度（复用宿主既有红线扫描结果）
 *   sentence_variance    句长方差（判断"整段一个节奏"）
 *   dialogue_ratio       对话字数占比
 *   paragraph_rhythm     段落长度序列（看节奏是否均匀到失真）
 *   style_drift          与 style_dna 的偏移（归一化后 0..1）
 *   contract_pass_rate   契约通过率（来自 contract.mjs 的核对结果）
 *   continuity_issues    连续性问题数（来自 canon/knowledge/foreshadow 的冲突清单）
 *   repair_count         修复轮次
 *   latency / tokens     成本侧指标
 */

const str = (v) => String(v || '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 句末标点（中英）。分号不算句末——它连接的是同一句的两半。 */
const SENTENCE_END = /[。！？!?…]+|\n{2,}/;
const DIALOGUE_MARK = /[「『“"][^」』”"]{0,400}[」』”"]/g;

/** 切句：先按段落，再按句末标点。切不出时退回整段（不猜）。 */
export function splitSentences(text) {
  const body = str(text);
  if (!body.trim()) return [];
  const out = [];
  for (const para of body.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    let buf = '';
    for (const ch of p) {
      buf += ch;
      if (SENTENCE_END.test(ch)) { if (buf.trim()) out.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

export function splitParagraphs(text) {
  return str(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}
function stdev(xs) { return Math.sqrt(variance(xs)); }

/**
 * 一次文本测量。纯统计，不含任何"好坏"判断。
 */
export function measureStyle(text) {
  const body = str(text);
  const sentences = splitSentences(body);
  const paragraphs = splitParagraphs(body);
  const lens = sentences.map((s) => s.length);
  const paraLens = paragraphs.map((p) => p.length);
  const dialogueMatches = body.match(DIALOGUE_MARK) || [];
  const dialogueChars = dialogueMatches.reduce((n, s) => n + s.length, 0);
  const totalChars = body.replace(/\s/g, '').length || 0;
  const punctCounts = {};
  for (const ch of body) {
    if (/[，。！？；：、…—～~!?,;:]/.test(ch)) punctCounts[ch] = (punctCounts[ch] || 0) + 1;
  }
  return {
    chars: totalChars,
    sentence_count: sentences.length,
    paragraph_count: paragraphs.length,
    sentence_len_mean: round(mean(lens), 2),
    sentence_len_stdev: round(stdev(lens), 2),
    sentence_len_min: lens.length ? Math.min(...lens) : 0,
    sentence_len_max: lens.length ? Math.max(...lens) : 0,
    paragraph_len_mean: round(mean(paraLens), 2),
    paragraph_rhythm: paraLens.slice(0, 200),
    dialogue_ratio: totalChars ? round(dialogueChars / totalChars, 4) : 0,
    dialogue_spans: dialogueMatches.length,
    punctuation: punctCounts,
  };
}

function round(v, n) {
  const f = 10 ** n;
  return Math.round(num(v) * f) / f;
}

/**
 * 作者指纹（style DNA）：从**作者自己已写好的章节**统计出的基线。
 * 刻意不使用任何"优秀网文的平均值"——那等于用别人的风格当尺子量作者。
 */
export function buildStyleDna(samples = [], { minSamples = 3 } = {}) {
  const usable = samples.map((s) => (typeof s === 'string' ? measureStyle(s) : s))
    .filter((m) => m && m.chars > 200);
  if (usable.length < minSamples) {
    return { ready: false, sample_count: usable.length, reason: `样本不足（${usable.length} < ${minSamples}），不用别人的风格当基线`, dna: null };
  }
  return {
    ready: true,
    sample_count: usable.length,
    dna: {
      sentence_len_mean: round(mean(usable.map((m) => m.sentence_len_mean)), 2),
      sentence_len_stdev: round(mean(usable.map((m) => m.sentence_len_stdev)), 2),
      dialogue_ratio: round(mean(usable.map((m) => m.dialogue_ratio)), 4),
      paragraph_len_mean: round(mean(usable.map((m) => m.paragraph_len_mean)), 2),
    },
  };
}

/**
 * 风格偏移：测量值与指纹的**相对差**，三项取平均后归一到 0..1。
 * @returns {{drift:number, parts:object, note:string}}
 *   `note` 明确写出"这只是偏移量，不代表写坏了"——避免下游把它当质量分用。
 */
export function styleDrift(measurement, dna) {
  if (!dna) return { drift: null, parts: {}, note: '没有可用的作者指纹，无法计算偏移' };
  const rel = (a, b) => (b ? Math.min(1, Math.abs(num(a) - num(b)) / Math.abs(b)) : 0);
  const parts = {
    sentence_len_mean: round(rel(measurement.sentence_len_mean, dna.sentence_len_mean), 4),
    sentence_len_stdev: round(rel(measurement.sentence_len_stdev, dna.sentence_len_stdev), 4),
    dialogue_ratio: round(rel(measurement.dialogue_ratio, dna.dialogue_ratio), 4),
  };
  const drift = round(mean(Object.values(parts)), 4);
  return { drift, parts, note: '偏移量只描述"与作者自己的习惯差多少"，不代表写得好或坏。' };
}

/**
 * 反 AI 腔密度：复用宿主红线扫描结果（`hits`），不在这里重新扫描。
 * 单位是"每千字命中数"，与正文长度无关，便于跨章比较。
 */
export function clicheDensity(hits = [], chars = 0) {
  const n = Array.isArray(hits) ? hits.length : 0;
  const c = num(chars);
  return { hits: n, chars: c, per_1k: c ? round((n * 1000) / c, 3) : 0 };
}

/**
 * 汇总一张质量趋势点。
 * 每个字段都只做**记录**；本函数不返回任何阈值判定，判定由调用方按作品配置做。
 */
export function qualityPoint({
  measurement, dna, hits = [], contract, continuityIssues = [], repairCount = 0,
  latencyMs = 0, tokens = {}, chapterId = null, at = null,
} = {}) {
  const m = measurement || {};
  const drift = dna ? styleDrift(m, dna) : { drift: null, parts: {}, note: '' };
  return {
    chapter_id: chapterId,
    at,
    chars: m.chars || 0,
    sentence_len_mean: m.sentence_len_mean || 0,
    sentence_len_stdev: m.sentence_len_stdev || 0,
    dialogue_ratio: m.dialogue_ratio || 0,
    paragraph_count: m.paragraph_count || 0,
    cliche: clicheDensity(hits, m.chars),
    style_drift: drift.drift,
    style_drift_parts: drift.parts,
    contract_pass_rate: contract && contract.summary && contract.summary.total
      ? round(contract.summary.pass / contract.summary.total, 4) : null,
    contract_fail: contract && contract.summary ? contract.summary.fail : null,
    continuity_issues: Array.isArray(continuityIssues) ? continuityIssues.length : 0,
    continuity_blocking: Array.isArray(continuityIssues) ? continuityIssues.filter((c) => c.level === 'critical').length : 0,
    repair_count: num(repairCount),
    latency_ms: num(latencyMs),
    tokens: { in: num(tokens.in), out: num(tokens.out) },
    note: '描述性指标：用于作者自查与趋势对比，不驱动任何自动改写。',
  };
}

/**
 * 趋势：一串质量点 → 每个指标的斜率（最小二乘，x = 序号）。
 * 返回 null 表示样本不足，**不猜**。
 */
export function trend(points = [], key) {
  const ys = points.map((p) => (p ? p[key] : null)).map((v) => (v === null || v === undefined ? null : num(v)));
  const idx = [];
  const vals = [];
  ys.forEach((v, i) => { if (v !== null) { idx.push(i); vals.push(v); } });
  if (vals.length < 3) return null;
  const mx = mean(idx); const my = mean(vals);
  let numr = 0; let den = 0;
  for (let i = 0; i < vals.length; i++) { numr += (idx[i] - mx) * (vals[i] - my); den += (idx[i] - mx) ** 2; }
  return den ? round(numr / den, 5) : 0;
}