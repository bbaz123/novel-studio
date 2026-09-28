/**
 * rebuild.mjs —— R12「导入后分析重建创作状态」的分批 / 基线 / 校验**纯逻辑**。
 *
 * 边界（写清楚才不会长成第二套状态体系）：
 *   - 不读盘、不联网、不写库、**不调模型**：模型抽取由宿主（界面/工具）按批执行，
 *     每批结果经 `validateExtraction` 校验后**记录**到 rebuild store，作者确认后交既有提案设施落地。
 *   - 只单点定义四件事：
 *     ① 批次规划（整本书绝不塞进一次请求；批大小有上限，且按字符预算切）；
 *     ② 每批基线（source chapter hash / extractor version / schema version / 路由 / 结果 hash）；
 *     ③ 恢复判据（基线不一致 → stale，不无条件复用旧结果；已完成的批次不重跑）；
 *     ④ 抽取结果 schema 校验（分类白名单 + 证据必须能在原文里定位）与「候选 → 既有提案种类」的映射。
 *   - 抽取结果**先是候选**：本模块只产出提案草稿（未落库、未应用），不直接改任何正式状态。
 */
import { sha16, stableStringify } from '../story-state/hash.mjs';

export const REBUILD_VERSION = '1.0.0';
export const REBUILD_EXTRACTOR_VERSION = '1.0.0';
export const REBUILD_SCHEMA_VERSION = '1.0.0';

/** 九类抽取对象（与任务书 §15 列举一一对应）→ 落库时用的既有提案种类。 */
export const REBUILD_CATEGORIES = [
  { key: 'entity', label: '人物/实体', proposal_kind: 'entity_create' },
  { key: 'alias', label: '别名', proposal_kind: 'entity_create' },
  { key: 'relation', label: '关系', proposal_kind: 'canon_fact' },
  { key: 'location', label: '地点设定', proposal_kind: 'entity_create' },
  { key: 'timeline', label: '时间线', proposal_kind: 'timeline_entry' },
  { key: 'event', label: '事件', proposal_kind: 'event' },
  { key: 'foreshadow', label: '伏笔', proposal_kind: 'event' },
  { key: 'character_state', label: '角色状态', proposal_kind: 'canon_fact' },
  { key: 'disclosure', label: '披露知识', proposal_kind: 'canon_fact' },
];
export const REBUILD_CATEGORY_KEYS = REBUILD_CATEGORIES.map((c) => c.key);

export const REBUILD_LIMITS = {
  max_chapters_per_batch: 6,
  max_chars_per_batch: 12000,
  max_batches: 4000,
  max_attempts: 3,
  max_items_per_batch: 200,
  max_item_chars: 2000,
  min_quote_chars: 4,
  max_quote_chars: 600,
};

/** 判据口径（机器可读，随状态端点返回，便于审计「按什么标准复用/作废」）。 */
export const REBUILD_RULES = {
  version: REBUILD_VERSION,
  batch: `按章节顺序打包，每批 ≤ ${REBUILD_LIMITS.max_chapters_per_batch} 章且 ≤ ${REBUILD_LIMITS.max_chars_per_batch} 字符：整本书不得作为一次请求发送。`,
  baseline: '每批记录 source chapter hash / extractor version / schema version / 模型路由与思考档位 / 结果 hash；source 指纹取「章节标题 + 正文纯文本」（与抽取器看到的内容一致，纯排版变化不误报 stale）。',
  resume: '恢复时只复用「基线完全一致且已完成」的批次；正文、抽取器版本、schema 版本或路由变化 → 该批标 stale，必须重跑。',
  evidence: '每个抽取项必须带原文证据（quote）与章节位置；quote 必须能在该章正文中定位，否则判为无效项（不落库）。',
  candidate: '抽取结果只生成候选提案，不直接写角色/事件/长期记忆；作者确认后按批原子应用。',
  conflict: '同一对象出现互相矛盾的候选时同时保留（标注冲突），由作者裁决，不替作者发明未揭示的秘密。',
  strictness: '任一项校验不过 → 整批拒绝（不留半批候选），修正后按 attempts 有限重试（上限 3 次，超限标记 failed）。',
};

const str = (v) => (v === null || v === undefined ? '' : String(v));
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 一章的源指纹：标题 + 正文（正文以**原始文本**参与，防止改章节名绕过）。 */
export function chapterSourceHash(chapter = {}) {
  return sha16(`rebuild-source-v1\n${str(chapter.title)}\n${str(chapter.content)}`);
}

/** 一批的源指纹：按顺序把各章指纹拼起来（顺序变化=不同批，避免错位复用）。 */
export function sourceHashOf(hashes = []) {
  return sha16(`rebuild-batch-source-v1\n${(Array.isArray(hashes) ? hashes : []).map(str).join('\n')}`);
}

/** 模型路由与思考档位：参与基线，换模型/换档位旧结果不得复用。 */
export function normalizeRoute(route = {}) {
  return {
    model: str(route.model || route.tier || 'default').trim(),
    reasoning_effort: str(route.reasoning_effort || route.thinking || 'default').trim(),
  };
}

/**
 * 批次规划。chapters: [{ id, index, title, content }]（按 index 升序传入）。
 * 返回 [{ index, chapter_ids, chapter_indexes, chapter_hashes, chars, baseline_hash }]。
 */
export function planBatches(chapters, {
  batchSize = 0, route = {}, extractorVersion = REBUILD_EXTRACTOR_VERSION, schemaVersion = REBUILD_SCHEMA_VERSION,
  categories = REBUILD_CATEGORY_KEYS,
} = {}) {
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((c, i) => ({
      id: Number(c.id) || 0,
      index: Number.isFinite(Number(c.index)) ? Number(c.index) : i,
      title: str(c.title),
      content: str(c.content),
    }))
    .filter((c) => c.id);
  if (!list.length) throw new Error('重建批次规划失败：作品里没有章节');
  const perBatch = Math.max(1, Math.min(Number(batchSize) || REBUILD_LIMITS.max_chapters_per_batch, REBUILD_LIMITS.max_chapters_per_batch));
  const routeNorm = normalizeRoute(route);
  const cats = (Array.isArray(categories) && categories.length ? categories : REBUILD_CATEGORY_KEYS).filter((k) => REBUILD_CATEGORY_KEYS.includes(k));
  const batches = [];
  let current = null;
  const flush = () => { if (current) { batches.push(current); current = null; } };
  for (const c of list) {
    const chars = c.content.length;
    if (current && (current.chapter_ids.length >= perBatch || current.chars + chars > REBUILD_LIMITS.max_chars_per_batch)) flush();
    if (!current) current = { chapter_ids: [], chapter_indexes: [], chapter_hashes: [], chars: 0 };
    current.chapter_ids.push(c.id);
    current.chapter_indexes.push(c.index);
    current.chapter_hashes.push(chapterSourceHash(c));
    current.chars += chars;
  }
  flush();
  if (batches.length > REBUILD_LIMITS.max_batches) throw new Error(`重建批次过多（${batches.length} > ${REBUILD_LIMITS.max_batches}）：请调大批次或拆分作品`);
  return batches.map((b, index) => {
    const baseline = {
      extractor_version: str(extractorVersion),
      schema_version: str(schemaVersion),
      route: routeNorm,
      categories: cats,
      source_hash: sourceHashOf(b.chapter_hashes),
      batch_size: perBatch,
    };
    return { index, ...b, baseline, baseline_hash: batchBaselineHash(baseline) };
  });
}

export function batchBaselineHash(baseline = {}) {
  return sha16(`rebuild-baseline-v1\n${stableStringify(baseline)}`);
}

/**
 * 恢复判据：把「已记录批次」与本次规划逐批比对。
 * previous: [{ batch_index, baseline_hash, chapter_hashes, status }]
 * 返回 Map<index, { state: 'pending'|'reuse'|'stale', reason }>。
 * 语义：基线一致且状态是 extracted/confirmed → reuse（不重跑）；基线不一致 → stale（必须重跑）；
 *       其余（失败/未抽取）→ pending。
 */
export function compareBatches(previous = [], plan = []) {
  const prev = new Map();
  for (const p of (Array.isArray(previous) ? previous : [])) prev.set(Number(p.batch_index), p);
  const out = new Map();
  for (const b of plan) {
    const p = prev.get(Number(b.index));
    if (!p) { out.set(b.index, { state: 'pending', reason: '本批尚未抽取' }); continue; }
    const prevHash = Array.isArray(p.chapter_hashes) ? p.chapter_hashes.map(str) : [];
    const sameSources = prevHash.length === b.chapter_hashes.length && prevHash.every((h, i) => h === b.chapter_hashes[i]);
    const sameBaseline = str(p.baseline_hash) && str(p.baseline_hash) === b.baseline_hash;
    const done = p.status === 'extracted' || p.status === 'confirmed' || p.status === 'applied';
    if (sameBaseline && done) { out.set(b.index, { state: 'reuse', reason: '基线与结果均在，直接复用' }); continue; }
    if (!sameSources) { out.set(b.index, { state: 'stale', reason: '章节正文已变化（source hash 不一致），旧结果不得复用' }); continue; }
    if (!sameBaseline) { out.set(b.index, { state: 'stale', reason: '抽取器/schema/路由等关键配置已变化，旧结果不得复用' }); continue; }
    out.set(b.index, { state: 'pending', reason: p.error ? `上次失败：${str(p.error).slice(0, 80)}` : '本批尚未完成抽取' });
  }
  return out;
}

/** 结果指纹：规范化后的结果 JSON。 */
export function resultHashOf(result) {
  try { return sha16(`rebuild-result-v1\n${stableStringify(result)}`); } catch (_) { return ''; }
}

function parseMaybeJson(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return {};
  return JSON.parse(text);
}

const normalizeForMatch = (s) => str(s).replace(/\s+/g, '');

/**
 * 校验一批抽取结果。raw 可以是对象或 JSON 字符串。
 * chapterTexts: { [chapterId]: 正文纯文本 }（可选；提供时逐项核对 quote 能否在原文定位）。
 * 返回 { ok, items, errors, stats }；有 errors 时 ok=false，但 items 里保留**通过校验的项**供作者查看。
 * 返回**不抛错**的判定：解析失败/形状不对都是可预期业务结果（要显示给作者，而不是 500）。
 */
export function validateExtraction(raw, { chapterTexts = null, chapterIds = null, maxItems = REBUILD_LIMITS.max_items_per_batch } = {}) {
  const errors = [];
  let data;
  try { data = parseMaybeJson(raw); } catch (e) {
    return { ok: false, items: [], errors: [{ index: -1, code: 'parse', message: `抽取结果不是合法 JSON：${e.message}` }], stats: { items: 0, valid: 0 } };
  }
  const rawItems = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
  if (!rawItems) {
    return { ok: false, items: [], errors: [{ index: -1, code: 'schema', message: '抽取结果缺少 items 数组（顶层应为 { items: [...] }）' }], stats: { items: 0, valid: 0 } };
  }
  if (rawItems.length > maxItems) {
    errors.push({ index: -1, code: 'limit', message: `本批抽取项数 ${rawItems.length} 超过上限 ${maxItems}：请缩小批次或分批提交` });
  }
  const allowedIds = Array.isArray(chapterIds) && chapterIds.length ? new Set(chapterIds.map(Number)) : null;
  const items = [];
  rawItems.slice(0, maxItems).forEach((it, i) => {
    const push = (code, message) => errors.push({ index: i, code, message });
    if (!it || typeof it !== 'object' || Array.isArray(it)) { push('schema', '抽取项必须是对象'); return; }
    const category = str(it.category || it.kind);
    if (!REBUILD_CATEGORY_KEYS.includes(category)) { push('category', `未知抽取分类：${category || '（空）'}`); return; }
    const chapterId = Number(it.chapter_id) || 0;
    if (!chapterId) { push('chapter', '抽取项缺少 chapter_id（必须标明来自哪一章）'); return; }
    if (allowedIds && !allowedIds.has(chapterId)) { push('chapter', `chapter_id ${chapterId} 不在本批范围内（跨批结果不得混入）`); return; }
    const evidence = it.evidence || {};
    const quote = str(evidence.quote || it.quote);
    if (!quote.trim()) { push('evidence', '抽取项缺少原文证据 quote（不得无证据入库）'); return; }
    if (quote.length < REBUILD_LIMITS.min_quote_chars) { push('evidence', `原文证据过短（< ${REBUILD_LIMITS.min_quote_chars} 字）：无法定位`); return; }
    if (CONTROL_RE.test(quote)) { push('evidence', '原文证据含控制字符：疑似二进制垃圾'); return; }
    if (chapterTexts && chapterTexts[chapterId] !== undefined && !normalizeForMatch(chapterTexts[chapterId]).includes(normalizeForMatch(quote))) {
      push('evidence', `原文证据在该章正文中定位不到：「${quote.slice(0, 40)}…」——拒绝编造的证据`);
      return;
    }
    const payload = (it.data && typeof it.data === 'object' && !Array.isArray(it.data)) ? it.data : (it.payload && typeof it.payload === 'object' ? it.payload : null);
    if (!payload) { push('schema', '抽取项缺少 data 对象'); return; }
    const blob = JSON.stringify(payload);
    if (blob.length > REBUILD_LIMITS.max_item_chars) { push('limit', `抽取项体积 ${blob.length} 超过单条上限 ${REBUILD_LIMITS.max_item_chars}`); return; }
    const conflicted = it.conflict === true || str(it.conflict_with) !== '';
    items.push({
      index: i, category, chapter_id: chapterId,
      chapter_index: Number.isFinite(Number(it.chapter_index)) ? Number(it.chapter_index) : null,
      evidence: { quote: quote.slice(0, REBUILD_LIMITS.max_quote_chars), location: str(evidence.location || it.location) },
      payload, conflict: conflicted,
    });
  });
  return {
    ok: errors.length === 0,
    items,
    errors,
    stats: { items: rawItems.length, valid: items.length, conflicts: items.filter((x) => x.conflict).length },
  };
}

/**
 * 候选 → 既有提案种类 的映射（**只产出草稿，不落库**）。
 * 返回值：[{ kind, chapter_id, payload, note, dedup_key }]
 * 映射口径（与 ai/story-state/proposal.mjs 的 planApply 对齐）：
 *   entity/location/alias → entity_create；relation/character_state/disclosure → canon_fact
 *   （角色知识以 CHARACTER_KNOWLEDGE 域表达，holder 用 subject 承载；不伪造 character_id）；
 *   timeline → timeline_entry；event → event；foreshadow → event(foreshadow_status=open)。
 * 返回 { proposals, skipped }：字段不全无法成形的项进 skipped（带原因），**不静默丢弃**。
 */
export function extractionToProposals(validated, { workId, batch = null } = {}) {
  const items = (validated && Array.isArray(validated.items)) ? validated.items : [];
  const batchIndex = batch ? Number(batch.index) : null;
  const out = [];
  const skipped = [];
  for (const it of items) {
    const d = it.payload || {};
    const note = `导入重建 · 批次 ${batchIndex === null ? '?' : batchIndex} · 第 ${it.chapter_index === null ? '?' : it.chapter_index + 1} 章 · 证据：「${it.evidence.quote.slice(0, 60)}」`;
    const dedup = sha16(`rebuild-candidate-v1\n${it.category}\n${it.chapter_id}\n${stableStringify(d)}`);
    const base = { chapter_id: it.chapter_id, note, dedup_key: dedup, source: { category: it.category, chapter_id: it.chapter_id, chapter_index: it.chapter_index, evidence: it.evidence } };
    if (it.category === 'entity' || it.category === 'location' || it.category === 'alias') {
      const kind = it.category === 'location' ? 'location' : str(d.kind || 'character');
      const canonical = str(d.canonical_name || d.name);
      if (!canonical) { skipped.push({ index: it.index, category: it.category, reason: '缺少 canonical_name/name' }); continue; }
      out.push({ ...base, kind: 'entity_create', payload: { kind, canonical_name: canonical, aliases: Array.isArray(d.aliases) ? d.aliases : [], note: str(d.note) } });
      continue;
    }
    if (it.category === 'relation') {
      const subject = str(d.subject || d.from);
      const relation = str(d.relation || d.predicate);
      if (!subject || !relation) { skipped.push({ index: it.index, category: it.category, reason: '缺少 subject 或 relation' }); continue; }
      out.push({ ...base, kind: 'canon_fact', payload: { facts: [{ subject, predicate: `关系：${relation}`, value: str(d.value || d.to || d.counterpart), scope: 'CANON_KNOWLEDGE', state: 'known', payload: { evidence: it.evidence } }] } });
      continue;
    }
    if (it.category === 'timeline') {
      out.push({ ...base, kind: 'timeline_entry', payload: { entries: [{ story_time: str(d.story_time), relative_time: str(d.relative_time), chapter_index: it.chapter_index, seq: Number(d.seq) || 0, kind: str(d.kind || 'event'), label: str(d.label || d.summary), source: 'rebuild', payload: { evidence: it.evidence } }] } });
      continue;
    }
    if (it.category === 'event') {
      const summary = str(d.summary || d.label);
      if (!summary) { skipped.push({ index: it.index, category: it.category, reason: '缺少 summary/label' }); continue; }
      out.push({ ...base, kind: 'event', payload: { kind: 'event', summary, payload: { evidence: it.evidence, chapter_index: it.chapter_index } } });
      continue;
    }
    if (it.category === 'foreshadow') {
      const summary = str(d.summary || d.label);
      if (!summary) { skipped.push({ index: it.index, category: it.category, reason: '缺少 summary/label' }); continue; }
      out.push({ ...base, kind: 'event', payload: { kind: 'foreshadow', summary, foreshadow_status: 'open', payload: { evidence: it.evidence, chapter_index: it.chapter_index } } });
      continue;
    }
    if (it.category === 'character_state' || it.category === 'disclosure') {
      const who = str(d.character || d.subject || d.who);
      const what = str(d.state || d.fact || d.value || d.summary);
      if (!who || !what) { skipped.push({ index: it.index, category: it.category, reason: '缺少 character/subject 或 state/fact' }); continue; }
      const predicate = it.category === 'disclosure' ? '得知' : '状态';
      out.push({ ...base, kind: 'canon_fact', payload: { facts: [{ subject: who, predicate, value: what, scope: 'CHARACTER_KNOWLEDGE', state: it.category === 'disclosure' ? 'known' : str(d.state_kind || 'known'), effective_from: it.chapter_index === null ? undefined : it.chapter_index, payload: { evidence: it.evidence, source_category: it.category } }] } });
      continue;
    }
    skipped.push({ index: it.index, category: it.category, reason: '没有可用的落库映射（未知分类）' });
  }
  return { proposals: out, skipped };
}

export default {
  REBUILD_VERSION, REBUILD_EXTRACTOR_VERSION, REBUILD_SCHEMA_VERSION,
  REBUILD_CATEGORIES, REBUILD_CATEGORY_KEYS, REBUILD_LIMITS, REBUILD_RULES,
  chapterSourceHash, sourceHashOf, normalizeRoute, planBatches, batchBaselineHash,
  compareBatches, resultHashOf, validateExtraction, extractionToProposals,
};