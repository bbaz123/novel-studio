/**
 * 时态故事状态 · 契约层（纯函数，不碰数据库、不调用模型、不修改输入）。
 *
 * 这里是「什么是一个合法的状态变化」的唯一裁决处：
 *   · cell 键 = canonicalJson([domain, entityId, predicate, scope, holderId])；
 *     domain / scope 走白名单，禁止把用户提供的字符串当可执行路径或任意 SQL。
 *   · 事件 ops 只允许 set / unset，且**必须带 expected 前置条件**（missing 或 value）。
 *     前置条件不满足 → PRECONDITION_FAILED（由 reducer 抛出），绝不自动补写。
 *   · 证据锚点 = 正文修订 + 文本哈希 + 段落下标/字符区间 + 叙述类型；回忆 / 梦境 /
 *     转述 / 引用必须如实标注，避免"死人复活"式误判。
 *
 * 版本：TEMPORAL_SCHEMA_VERSION 变化意味着事件语义变化，历史事件按各自 schema_version 解释。
 */
import { createHash } from 'node:crypto';

export const TEMPORAL_SCHEMA_VERSION = '1';
export const TEMPORAL_ALGORITHM_VERSION = 'temporal-v1';
export const NORMALIZER_VERSION = 'v1';

/** 统一状态域（方案 §5 的 16 类，全部可承载事件；覆盖 AC-09/11 的多域同批演进）。 */
export const DOMAINS = new Set([
  'character', 'relation', 'plotline', 'foreshadow', 'knowledge', 'disclosure',
  'location', 'faction', 'item', 'goal', 'promise', 'task', 'world_fact',
  'event', 'appearance', 'premise',
]);
export const SCOPES = new Set(['canon', 'reader', 'character', 'author_plan']);

const MAX_DEPTH = 32;
const MAX_VALUE_JSON_CHARS = 4096;
const MAX_PREDICATE_CHARS = 120;
const MAX_QUOTE_CHARS = 240;
const MAX_OPS_PER_EVENT = 64;
const MAX_EVENTS_PER_BATCH = 256;

/** 仅接受有限深度 JSON；规范化规则发布后必须版本化。 */
export function canonicalJson(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError('JSON_DEPTH_EXCEEDED');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((k) =>
      `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`
    ).join(',')}}`;
  }
  throw new TypeError('NON_JSON_VALUE');
}

export function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function sha16(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex').slice(0, 16);
}

function assertJsonValue(value, label) {
  const json = canonicalJson(value);
  if (json.length > MAX_VALUE_JSON_CHARS) {
    throw new TypeError(`${label}_TOO_LARGE`);
  }
  return json;
}

function safeId(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`INVALID_${label}`);
    return value;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t || t.length > 120) throw new TypeError(`INVALID_${label}`);
    return t;
  }
  throw new TypeError(`INVALID_${label}`);
}

/**
 * cell 形如 { domain, entityId, predicate, scope = 'canon', holderId = null }。
 * 键不是可执行路径；不使用 obj[userProvidedPath] 做任意深层写入。
 */
export function cellKey({ domain, entityId, predicate, scope = 'canon', holderId = null } = {}) {
  if (!DOMAINS.has(domain) || !SCOPES.has(scope)) {
    throw new TypeError('INVALID_DOMAIN_OR_SCOPE');
  }
  const eid = safeId(entityId, 'ENTITY_ID');
  if (typeof predicate !== 'string' || !predicate.trim() || predicate.length > MAX_PREDICATE_CHARS) {
    throw new TypeError('INVALID_PREDICATE');
  }
  if (scope === 'character') {
    return canonicalJson([domain, eid, predicate.trim(), scope, safeId(holderId, 'HOLDER_ID')]);
  }
  if (holderId !== null && holderId !== undefined) throw new TypeError('HOLDER_NOT_ALLOWED_FOR_SCOPE');
  return canonicalJson([domain, eid, predicate.trim(), scope, null]);
}

/** 校验并归一化 cell（返回可存储的字段副本）。 */
export function normalizeCell(cell) {
  const key = cellKey(cell);
  const { domain, entityId, predicate, scope = 'canon', holderId = null } = cell;
  return {
    domain, entityId, predicate: String(predicate).trim(), scope,
    holder_id: scope === 'character' ? holderId : null,
    key,
  };
}

export function parseCellKey(key) {
  const parsed = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.length !== 5) throw new TypeError('INVALID_CELL_KEY');
  return { domain: parsed[0], entityId: parsed[1], predicate: parsed[2], scope: parsed[3], holderId: parsed[4] };
}

/** 归一化并校验一个 op。 */
export function normalizeOp(op) {
  if (!op || typeof op !== 'object') throw new TypeError('INVALID_OPERATION');
  if (!['set', 'unset'].includes(op.type)) throw new TypeError('INVALID_OPERATION_TYPE');
  const cell = normalizeCell(op.cell || {});
  const expected = op.expected;
  if (!expected || !['missing', 'value'].includes(expected.kind)) {
    throw new TypeError('EXPECTED_VALUE_REQUIRED');
  }
  const out = { type: op.type, cell: op.cell, expected: { kind: expected.kind } };
  if (expected.kind === 'value') {
    assertJsonValue(expected.value, 'EXPECTED_VALUE');
    out.expected.value = expected.value;
  }
  if (op.type === 'set') {
    if (!Object.prototype.hasOwnProperty.call(op, 'value')) throw new TypeError('SET_VALUE_REQUIRED');
    assertJsonValue(op.value, 'VALUE');
    out.value = op.value;
  }
  out._key = cell.key;
  return out;
}

const NARRATIVE_KINDS = new Set(['present', 'flashback', 'dream', 'quote', 'report', 'unknown']);

/** 证据锚点：可核对到具体修订与位置；不完整时显式记 unknown，而不是伪造精度。 */
export function normalizeEvidenceItem(item) {
  if (!item || typeof item !== 'object') throw new TypeError('INVALID_EVIDENCE');
  const out = {
    revision_id: item.revision_id ? String(item.revision_id) : '',
    text_hash: item.text_hash ? String(item.text_hash) : '',
    paragraph_index: Number.isSafeInteger(item.paragraph_index) ? item.paragraph_index : null,
    char_start: Number.isSafeInteger(item.char_start) ? item.char_start : null,
    char_end: Number.isSafeInteger(item.char_end) ? item.char_end : null,
    quote: typeof item.quote === 'string' ? item.quote.slice(0, MAX_QUOTE_CHARS) : '',
    narrative: NARRATIVE_KINDS.has(item.narrative) ? item.narrative : 'unknown',
    note: typeof item.note === 'string' ? item.note.slice(0, 200) : '',
  };
  if (out.char_start !== null && out.char_end !== null && out.char_end < out.char_start) {
    throw new TypeError('INVALID_EVIDENCE_RANGE');
  }
  return out;
}

export function normalizeStoryTime(storyTime) {
  if (storyTime === null || storyTime === undefined) return null;
  if (typeof storyTime !== 'object') throw new TypeError('INVALID_STORY_TIME');
  const out = {};
  for (const k of ['kind', 'at', 'from', 'to', 'relative', 'day_offset']) {
    if (storyTime[k] === undefined || storyTime[k] === null) continue;
    out[k] = typeof storyTime[k] === 'number' ? storyTime[k] : String(storyTime[k]).slice(0, 120);
  }
  assertJsonValue(out, 'STORY_TIME');
  return out;
}

export function normalizeCursor(cursor) {
  const chapterIndex = Number(cursor && cursor.chapter_index);
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 0) throw new TypeError('INVALID_CURSOR');
  const sceneIndex = Number.isSafeInteger(cursor && cursor.scene_index) ? cursor.scene_index : null;
  return { chapter_index: chapterIndex, scene_index: sceneIndex };
}

/** 归一化事件（不含 id / created_at，存储层负责补齐）。 */
export function normalizeEvent(event, { workId, chapterId, revisionId } = {}) {
  if (!event || typeof event !== 'object') throw new TypeError('INVALID_EVENT');
  if (!Array.isArray(event.ops) || !event.ops.length || event.ops.length > MAX_OPS_PER_EVENT) {
    throw new TypeError('INVALID_EVENT_OPS');
  }
  const ops = event.ops.map(normalizeOp);
  const seen = new Set();
  for (const op of ops) {
    if (seen.has(op._key)) throw new TypeError('DUPLICATE_CELL_IN_EVENT');
    seen.add(op._key);
  }
  const evidence = Array.isArray(event.evidence) ? event.evidence.map(normalizeEvidenceItem) : [];
  const out = {
    work_id: Number(workId) || 0,
    chapter_id: Number(chapterId) || 0,
    revision_id: String(revisionId || event.revision_id || ''),
    cursor: normalizeCursor(event.cursor || { chapter_index: 0 }),
    story_time: normalizeStoryTime(event.story_time),
    ops,
    evidence,
    schema_version: TEMPORAL_SCHEMA_VERSION,
    extractor: {
      name: String((event.extractor && event.extractor.name) || 'manual'),
      version: String((event.extractor && event.extractor.version) || '1'),
      method: String((event.extractor && event.extractor.method) || 'deterministic'),
    },
  };
  if (!out.work_id || !out.chapter_id || !out.revision_id) throw new TypeError('EVENT_SCOPE_REQUIRED');
  return out;
}

/** 事件内容哈希（不含 id / 时间戳，保证同内容同哈希）。 */
export function hashEvent(event) {
  return hashJson({
    ops: event.ops.map((op) => ({ type: op.type, cell: op.cell, expected: op.expected, value: op.value ?? null })),
    evidence: event.evidence || [],
    story_time: event.story_time ?? null,
    cursor: event.cursor,
    schema_version: event.schema_version,
  });
}

/** 事件集的 lineage 指纹（顺序敏感：同一集合不同顺序视为不同批次）。 */
export function hashEventSet(eventHashes) {
  return hashJson((eventHashes || []).map(String));
}

export function assertBatchSize(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_BATCH) throw new TypeError('EVENT_BATCH_TOO_LARGE');
  return events.length;
}

export const TEMPORAL_LIMITS = Object.freeze({
  max_ops_per_event: MAX_OPS_PER_EVENT,
  max_events_per_batch: MAX_EVENTS_PER_BATCH,
  max_value_json_chars: MAX_VALUE_JSON_CHARS,
  max_quote_chars: MAX_QUOTE_CHARS,
});
