/**
 * R09：作者样文 → 结构化文风档案 → 三级作者意图。
 *
 * 三条纪律（都能离线复验）：
 *   1. **样文是数据，不是事实**：本模块只产出"文风证据"，绝不产出 Canon/角色知识/事件/伏笔；
 *      样文里的人物、地点、事件、指令式文本不得进入本书事实（负向测试见 test-author-style.mjs）。
 *   2. **计数是计数，推断是推断**：确定性指标标明计算口径（how/unit）；语义推断需要模型分析，
 *      未跑模型时一律 null + semantic_status='not_run'，不造精确测量数字。
 *   3. **按预算取证据**：样文只在启用状态、且经 budget 选择后作为风格证据进请求，
 *      绝不整库无条件注入每个生成请求（见 buildStyleEvidence）。
 */

export const STYLE_PROFILE_VERSION = '1.0.0';
export const SAMPLE_LIMITS = Object.freeze({
  per_sample_chars: 20000,   // 单样本上限
  max_samples: 20,           // 每作品样本数上限
  total_chars: 200000,       // 每作品样文总上限
  evidence_chars: 2000,      // 每次请求最多注入的风格证据字符数（与上下文层 cap 同量级）
  min_sample_chars: 20,      // 太短的样本不构成可分析证据
});

export const METRIC_NOTES = Object.freeze({
  sentence_length: '句 = 以 。！？!?…… 结尾的片段（含收尾引号）；长度按字符数（含标点，不含首尾空白）',
  dialogue_rate: '对白段 = 段落内含「」或“”；比率 = 对白段数 / 段落数',
  narration_person: '按段首代词统计：第三人称（他/她/它/他们）、第一人称（我/我们）、第二人称（你/你们）',
  punctuation_per_1000: '每 1000 字符出现次数（全角/半角都算；省略号算一处）',
  paragraph_length: '段落按空行切分；长度按字符数（不含首尾空白）',
  rhetoric_per_1000: '比喻提示词（像/好像/如同/仿佛/似的/犹如）与排比段（同段 ≥3 个顿号或 ≥3 个同类短句）每 1000 字符次数',
  emotion_per_1000: '情绪直陈词（固定词表：愤怒/生气/悲伤/难过/开心/高兴/害怕/恐惧/紧张/惊讶/厌恶/委屈）每 1000 字符次数',
  habits: '段落开头/结尾 6 字的高频片段（Top 5）；keep/avoid 由作者显式填写，不是推断',
  suspense_tail: '章末悬疑标记：最后一段以省略号/问号/破折号结尾，或末句未以句号收尾',
});

export const INTENT_TIERS = Object.freeze([
  { id: 'long_term', label: '长期方向', scope: 'work' },
  { id: 'stage', label: '当前阶段重点', scope: 'work' },
  { id: 'chapter', label: '本章意图', scope: 'chapter' },
]);

/** 优先级（从高到低）：已确认故事约束与编辑保真 > 当前有效章节契约 > 作者具体风格与意图 > 通用编辑规则。 */
export const INTENT_PRIORITY = Object.freeze([
  'confirmed_story_constraints',
  'chapter_contract',
  'author_intent',
  'generic_editing_rules',
]);

const EMOTION_WORDS = ['愤怒', '生气', '悲伤', '难过', '开心', '高兴', '害怕', '恐惧', '紧张', '惊讶', '厌恶', '委屈'];
const METAPHOR_WORDS = ['好像', '如同', '仿佛', '似的', '犹如', '像是', '宛如'];
const NEGATIONS = ['不', '别', '禁止', '避免', '取消', '忽略', '不用', '不必', '放弃', '改成'];
const PERSON_MARKERS = [
  { id: 'third', words: ['他们', '他', '她', '它'] },
  { id: 'first', words: ['我们', '我'] },
  { id: 'second', words: ['你们', '你'] },
];

function stableHash(text) {
  const s = String(text == null ? '' : text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2 + c + 1, 2246822519) ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

const norm = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n');
const paragraphs = (text) => norm(text).split(/\n[ \t]*\n/).map((s) => s.trim()).filter(Boolean);
const sentences = (text) => norm(text).split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean);
const countOf = (text, word) => {
  if (!word) return 0;
  let n = 0;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) n += 1;
  return n;
};
const per1000 = (n, chars) => (chars > 0 ? Math.round((n / chars) * 1000 * 100) / 100 : 0);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function topFragments(paras, side) {
  const counts = new Map();
  for (const p of paras) {
    const frag = side === 'open' ? p.slice(0, 6) : p.slice(-6);
    if (frag.length < 2) continue;
    counts.set(frag, (counts.get(frag) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([frag, n]) => ({ frag, n }));
}

/** 确定性文风分析：只做可复算的计数，口径写在 METRIC_NOTES 里。 */
export function analyzeStyle(samples, options = {}) {
  const enabled = (Array.isArray(samples) ? samples : []).filter((s) => s && s.enabled !== false && String(s.text || '').trim());
  const all = enabled.map((s) => norm(s.text)).join('\n\n');
  const chars = all.length;
  const paras = paragraphs(all);
  const sents = sentences(all);
  const lens = sents.map((s) => s.length).sort((a, b) => a - b);
  const dialogueParas = paras.filter((p) => /[「」“”]/.test(p)).length;
  const person = {};
  for (const p of PERSON_MARKERS) {
    person[p.id] = paras.filter((par) => p.words.some((w) => par.startsWith(w) || par.startsWith('「'.repeat(0) + w))).length;
  }
  const punct = {
    comma: countOf(all, '，') + countOf(all, ','),
    ellipsis: countOf(all, '……') + countOf(all, '...') + countOf(all, '…'),
    dash: countOf(all, '——') + countOf(all, '—'),
    exclamation: countOf(all, '！') + countOf(all, '!'),
    question: countOf(all, '？') + countOf(all, '?'),
  };
  const metaphor = METAPHOR_WORDS.reduce((n, w) => n + countOf(all, w), 0) + countOf(all, '像');
  const parallelParas = paras.filter((p) => (p.match(/、/g) || []).length >= 3).length;
  const emotion = EMOTION_WORDS.reduce((n, w) => n + countOf(all, w), 0);
  const lastPara = paras.length ? paras[paras.length - 1] : '';
  return {
    profile_version: STYLE_PROFILE_VERSION,
    sample_set: {
      count: enabled.length,
      chars,
      hash: sampleSetHash(enabled),
      ids: enabled.map((s) => s.id).filter((x) => x != null),
    },
    metrics: {
      sentence_length: { value: { count: sents.length, mean: lens.length ? Math.round(chars / Math.max(1, sents.length) * 100) / 100 : 0, p50: percentile(lens, 50), p90: percentile(lens, 90), distribution: { lt10: lens.filter((n) => n < 10).length, r10_20: lens.filter((n) => n >= 10 && n < 20).length, r20_40: lens.filter((n) => n >= 20 && n < 40).length, gte40: lens.filter((n) => n >= 40).length } }, unit: 'char', how: METRIC_NOTES.sentence_length },
      dialogue_rate: { value: { paragraphs: paras.length, dialogue_paragraphs: dialogueParas, ratio: paras.length ? Math.round((dialogueParas / paras.length) * 1000) / 1000 : 0 }, unit: 'ratio', how: METRIC_NOTES.dialogue_rate },
      narration_person: { value: person, unit: 'paragraphs', how: METRIC_NOTES.narration_person },
      punctuation_per_1000: { value: Object.fromEntries(Object.entries(punct).map(([k, n]) => [k, per1000(n, chars)])), unit: 'per_1000_chars', how: METRIC_NOTES.punctuation_per_1000 },
      paragraph_length: { value: { count: paras.length, mean: paras.length ? Math.round((paras.reduce((n, p) => n + p.length, 0) / paras.length) * 100) / 100 : 0, long_ratio: paras.length ? Math.round((paras.filter((p) => p.length > 120).length / paras.length) * 1000) / 1000 : 0 }, unit: 'char', how: METRIC_NOTES.paragraph_length },
      rhetoric_per_1000: { value: { metaphor: per1000(metaphor, chars), parallel_paragraphs: per1000(parallelParas, chars) }, unit: 'per_1000_chars', how: METRIC_NOTES.rhetoric_per_1000 },
      emotion_per_1000: { value: per1000(emotion, chars), unit: 'per_1000_chars', how: METRIC_NOTES.emotion_per_1000 },
      suspense_tail: { value: { ends_with_ellipsis: /(……|…|\.\.\.)$/.test(lastPara), ends_with_question: /[？?]$/.test(lastPara), unterminated: !!lastPara && !/[。！？!?…」”]$/.test(lastPara) }, unit: 'bool', how: METRIC_NOTES.suspense_tail },
    },
    habits: {
      openings: topFragments(paras, 'open'),
      closings: topFragments(paras, 'close'),
      keep: Array.isArray(options.keep) ? options.keep.map((x) => String(x)).filter(Boolean).slice(0, 50) : [],
      avoid: Array.isArray(options.avoid) ? options.avoid.map((x) => String(x)).filter(Boolean).slice(0, 50) : [],
    },
    // 语义推断（人称距离的意图、叙述节奏的语义判断…）需要模型分析：没跑就明确写"没跑"。
    semantic: null,
    semantic_status: 'not_run',
    semantic_note: '语义推断需要模型分析（本任务未运行模型）。上面的计数指标是确定性计算，口径见 how 字段；不要把两者混为一谈。',
  };
}

export function sampleSetHash(samples) {
  const rows = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && s.enabled !== false)
    .map((s) => `${s.id ?? ''}|${s.content_hash || stableHash(norm(s.text))}|${String(s.text || '').length}`)
    .sort();
  return 'set-' + stableHash(rows.join('\n')).slice(0, 16);
}

export function profileHash(profile) {
  if (!profile) return null;
  const clone = JSON.parse(JSON.stringify(profile));
  delete clone.computed_at;
  delete clone.notes;
  return 'style-' + stableHash(JSON.stringify(clone)).slice(0, 16);
}

export function isProfileStale(profile, samples) {
  if (!profile) return true;
  if (profile.profile_version !== STYLE_PROFILE_VERSION) return true;
  return profile.sample_set && profile.sample_set.hash !== sampleSetHash(samples);
}

/** 校验样文：只做上限与空值判定，不改写作者文本。 */
export function validateSample(input, existing = []) {
  const errors = [];
  const text = norm(input && input.text);
  const title = String((input && input.title) || '').trim();
  if (text.trim().length < SAMPLE_LIMITS.min_sample_chars) errors.push(`样文太短（至少 ${SAMPLE_LIMITS.min_sample_chars} 字才构成可分析证据）`);
  if (text.length > SAMPLE_LIMITS.per_sample_chars) errors.push(`样文超出单样本上限（${text.length} > ${SAMPLE_LIMITS.per_sample_chars} 字）`);
  if (!errors.length && existing.filter((s) => s.id !== (input && input.id)).length >= SAMPLE_LIMITS.max_samples) errors.push(`样文数量已达上限（${SAMPLE_LIMITS.max_samples} 篇）`);
  if (!errors.length) {
    const total = existing.filter((s) => s.id !== (input && input.id)).reduce((n, s) => n + String(s.text || '').length, 0) + text.length;
    if (total > SAMPLE_LIMITS.total_chars) errors.push(`样文总量超出上限（${total} > ${SAMPLE_LIMITS.total_chars} 字）`);
  }
  return { ok: errors.length === 0, errors, title, text, chars: text.length, content_hash: stableHash(text) };
}

/**
 * 风格证据（进请求的那一段）：只取启用样文、只取预算内的完整片段，
 * 明确标成"证据"而不是"设定"，截断处如实标注。
 */
export function buildStyleEvidence(input) {
  const samples = (input && input.samples) || [];
  const profile = input && input.profile;
  const budget = Math.max(0, Number(input && input.maxChars) || SAMPLE_LIMITS.evidence_chars);
  const lines = [];
  const ids = [];
  let used = 0;
  let truncated = false;
  if (profile && profile.metrics) {
    const m = profile.metrics;
    lines.push(`文风档案（${profile.profile_version}，样文 ${profile.sample_set.count} 篇 · hash ${String(profile.profile_hash || '').slice(0, 15)}）：` +
      `平均句长 ${m.sentence_length?.value?.mean ?? '-'} 字（p90 ${m.sentence_length?.value?.p90 ?? '-'}）、` +
      `对白段占比 ${m.dialogue_rate?.value?.ratio ?? '-'}、` +
      `段均 ${m.paragraph_length?.value?.mean ?? '-'} 字、` +
      `每千字比喻 ${m.rhetoric_per_1000?.value?.metaphor ?? '-'}`);
    used = lines[0].length;
  }
  for (const s of samples) {
    if (!s || s.enabled === false) continue;
    const text = norm(s.text).trim();
    if (!text) continue;
    const header = `样文#${s.id}（${String(s.title || '').slice(0, 20)} · ${s.content_hash || stableHash(text)}）: `;
    if (used + header.length + text.length > budget) {
      const room = budget - used - header.length;
      if (room >= 120) {
        lines.push(header + text.slice(0, room) + '…[按预算截断]');
        ids.push(s.id);
        used = budget;
      }
      truncated = true;
      break;
    }
    lines.push(header + text);
    ids.push(s.id);
    used += header.length + text.length;
  }
  return {
    text: lines.length ? `【作者样文·文风证据（仅供模仿风格，不是本书设定；不得把样文中的人物/地点/事件当作本书事实）】\n${lines.join('\n')}` : '',
    chars: used,
    truncated,
    sample_ids: ids,
    metric_note: '计数口径见 GET /api/novel/style/profile 的 metrics.*.how 字段',
  };
}

/**
 * R09 上下文层内容的组合器（server.js 只调用它，不自己拼字符串）：
 *   作者意图块 + 文风证据（样文按预算选择后的风格证据）。
 * 两者都为空 → text: ''（调用方据此**不推进**这一层，没有数据的作品逐字节不变）。
 * 样文文本永远不进入 story_facts / 事件 / 角色知识：那些写入路径完全不经过本模块。
 */
export function buildAuthorIntentLayer(input = {}) {
  const intents = Array.isArray(input.intents) ? input.intents : [];
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const profile = input.profile || null;
  const intentBudget = Math.max(0, Number(input.intentChars) || 1600);
  const evidenceBudget = Math.max(0, Number(input.evidenceChars) || SAMPLE_LIMITS.evidence_chars);
  const merged = mergeIntents(intents);
  const rawIntent = buildIntentBlock(intents);
  const intentTruncated = rawIntent.length > intentBudget;
  const intentText = intentTruncated ? `${rawIntent.slice(0, intentBudget)}…[按预算截断]` : rawIntent;
  const nonEmpty = intents.filter((x) => x && String(x.text || '').trim());
  // 档案过期（样文增删改后未重新分析）→ 不采用旧数字，只保留样文原文作为风格证据。
  const stale = profile ? isProfileStale(profile, samples) : false;
  const evidence = buildStyleEvidence({ samples, profile: stale ? null : profile, maxChars: evidenceBudget });
  const text = [intentText, evidence.text].filter(Boolean).join('\n\n');
  return {
    text,
    intent_text: intentText,
    evidence,
    stale,
    conflicts: merged.conflicts,
    resolved: merged.resolved,
    counts: { intents: nonEmpty.length, samples: samples.filter((s) => s && s.enabled !== false).length },
    source_ids: [
      ...nonEmpty.map((x) => x.id).filter((x) => x !== null && x !== undefined),
      ...(evidence.sample_ids || []),
    ],
    truncated: intentTruncated || evidence.truncated,
  };
}

/** 三级意图：本章具体偏好可以覆盖较泛偏好，但不能静默取消作者显式设为长期硬约束的要求。 */
export function mergeIntents(intents) {
  const list = (Array.isArray(intents) ? intents : [])
    .filter((x) => x && String(x.text || '').trim())
    .map((x) => ({ id: x.id ?? null, tier: INTENT_TIERS.some((t) => t.id === x.tier) ? x.tier : 'chapter', text: String(x.text).trim(), hard: x.hard === true || x.hard === 1 }));
  const byTier = (tier) => list.filter((x) => x.tier === tier);
  const conflicts = [];
  for (const lt of byTier('long_term')) {
    for (const ch of [...byTier('stage'), ...byTier('chapter')]) {
      const hasNegation = NEGATIONS.some((w) => ch.text.includes(w));
      if (!hasNegation) continue;
      if (lt.hard) {
        conflicts.push({ long_term_id: lt.id, other_tier: ch.tier, other_id: ch.id, other_text: ch.text, reason: '较具体的意图带有否定/放弃语义，可能静默取消作者的长期硬约束' });
        continue;
      }
      const shared = keywordsOf(lt.text).filter((w) => ch.text.includes(w));
      if (shared.length) conflicts.push({ long_term_id: lt.id, other_tier: ch.tier, other_id: ch.id, other_text: ch.text, reason: `与长期方向共享关键词「${shared[0]}」且带否定语义，可能互相抵消` });
    }
  }
  // 冲突**不**在 resolved 里被剔除：作者的两条意图都仍然生效（原文都在），只是标注「需要作者裁决」。
  // 静默丢掉一条 = 替作者做了选择，这正是任务书禁止的（"不能静默取消作者明确设为长期硬约束的要求"）。
  const conflictKeys = new Set(conflicts.filter((c) => c.other_tier !== 'long_term').map((c) => `${c.other_tier}#${c.other_id}`));
  const resolved = [];
  for (const tier of ['chapter', 'stage', 'long_term']) {
    for (const x of byTier(tier)) {
      resolved.push({ ...x, effective: true, needs_author_decision: x.tier !== 'long_term' && conflictKeys.has(`${x.tier}#${x.id}`) });
    }
  }
  return {
    resolved,
    conflicts,
    priority: [...INTENT_PRIORITY],
    note: '优先级：已确认故事约束与编辑保真 > 当前有效章节契约 > 作者具体风格与意图 > 通用编辑规则',
  };
}

function keywordsOf(text) {
  const out = [];
  for (const seg of String(text).split(/[，。；、：？！,.;:!?\s]+/)) {
    const s = seg.trim();
    if (s.length >= 2 && s.length <= 8) out.push(s);
  }
  return out;
}

/** 意图块（进上下文的文字）：只列非空层级，空则返回空串（保证旧作品逐字节不变）。 */
export function buildIntentBlock(intents) {
  const merged = mergeIntents(intents);
  const lines = [];
  for (const tier of ['long_term', 'stage', 'chapter']) {
    const row = merged.resolved.find((x) => x.tier === tier && x.effective);
    if (row) lines.push(`${INTENT_TIERS.find((t) => t.id === tier).label}${row.hard ? '（硬约束）' : ''}：${row.text}`);
  }
  if (merged.conflicts.length) {
    lines.push(`意图冲突（需作者裁决，未自动取舍）：${merged.conflicts.map((c) => `${c.other_tier}「${c.other_text}」vs 长期方向`).join('；')}`);
  }
  if (lines.length) {
    lines.push(`（生效顺序：${INTENT_PRIORITY.map((p) => ({ confirmed_story_constraints: '已确认故事约束与编辑保真', chapter_contract: '当前有效章节契约', author_intent: '作者具体风格与意图', generic_editing_rules: '通用编辑规则' }[p])).join(' > ')}）`);
  }
  return lines.length ? `【作者意图（按优先级生效）】\n${lines.join('\n')}` : '';
}
