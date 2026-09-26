/**
 * 确定性故事状态内核 · 内容哈希（PHASE 6 的陈旧检查基础）。
 *
 * 为什么需要它：提案在「作者看到的那一刻」与「作者点确认的那一刻」之间，
 * 状态可能已经被另一个任务改过。没有可比对的哈希，"提交前重算 current_state_hash
 * 不一致即 STALE" 就只是一句话，而不是一条能执行的规则。
 *
 * 设计约束：
 *   - **确定性**：同一份状态必须得到同一个哈希——所以先做键排序（stableStringify），
 *     再对规范化后的字符串取 SHA-256 截断，不依赖对象字面量的书写顺序；
 *   - **可比对**：哈希只覆盖**语义字段**，不覆盖 id / created_at / updated_at 这类
 *     每次写入都会变的行号与时间戳，否则每存一行哈希就变一次，陈旧检查会永远报 STALE；
 *   - **可解释**：`stateHashDetail` 同时返回参与哈希的条目数，便于在提案界面回答
 *     "到底是哪一类状态变了"。
 */
import { createHash } from 'node:crypto';

/** 键排序后的 JSON —— 对象字面量顺序不同但内容相同的两份状态必须序列化成同一个串。 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** SHA-256 截断到 16 位十六进制（与上下文 contentId 的长度口径一致，便于并排显示）。 */
export function sha16(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 一条正典事实的**语义指纹**。
 * 刻意排除 id / created_at / updated_at：行号与写入时间不是"状态"。
 * 刻意包含 status 与 superseded_by 的**目标内容**（不是行号），这样"被谁取代"参与哈希，
 * 而行号重排不会误报陈旧。
 */
export function factFingerprint(f) {
  return {
    subject: str(f.subject),
    predicate: str(f.predicate),
    value: str(f.value),
    scope: str(f.scope || 'CANON_KNOWLEDGE'),
    state: str(f.state || 'known'),
    status: str(f.status || 'established'),
    superseded_by: f.superseded_by ? str(f.superseded_by) : '',
    entity: str(f.entity_name || f.entity_id || ''),
    effective_from: num(f.effective_from),
    effective_to: f.effective_to === null || f.effective_to === undefined ? null : num(f.effective_to),
    story_time: str(f.story_time),
  };
}

export function timelineFingerprint(t) {
  return {
    chapter_index: num(t.chapter_index),
    scene_index: num(t.scene_index),
    seq: num(t.seq),
    story_time: str(t.story_time),
    relative_time: str(t.relative_time),
    kind: str(t.kind),
    label: str(t.label),
    effective_from: num(t.effective_from),
    effective_to: t.effective_to === null || t.effective_to === undefined ? null : num(t.effective_to),
    before_event_id: t.before_event_id ? num(t.before_event_id) : null,
    after_event_id: t.after_event_id ? num(t.after_event_id) : null,
  };
}

export function knowledgeFingerprint(k) {
  return {
    character: str(k.character_name || k.character_id),
    fact_key: str(k.fact_key),
    state: str(k.state),
    learned_chapter_index: num(k.learned_chapter_index),
    learned_scene_index: num(k.learned_scene_index),
  };
}

export function entityFingerprint(e) {
  return {
    kind: str(e.kind),
    canonical_name: str(e.canonical_name),
    status: str(e.status),
    merged_into: str(e.merged_into_name || e.merged_into || ''),
    aliases: (e.aliases || []).map((a) => ({
      alias: str(a.alias),
      kind: str(a.kind || 'alias'),
      valid_from: a.valid_from === null || a.valid_from === undefined ? null : num(a.valid_from),
      valid_to: a.valid_to === null || a.valid_to === undefined ? null : num(a.valid_to),
    })).sort((x, y) => (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0)),
  };
}

export function foreshadowFingerprint(f) {
  return {
    id: num(f.id),
    state: str(f.state || f.foreshadow_status || ''),
    resolves_event_id: f.resolves_event_id ? num(f.resolves_event_id) : null,
    target_entity: str(f.target_entity || ''),
  };
}

/**
 * 整部作品的故事状态哈希。
 *
 * 为什么按 `work_id` 而**不是**按章节：陈旧检查要回答的是"我基于的那份状态，
 * 现在还是不是同一份"。若只按章节取哈希，作者在第 5 章的提案不会察觉第 3 章
 * 的正典刚被改写——而那正是最危险的覆盖场景。
 *
 * @param {{facts?:Array, timeline?:Array, knowledge?:Array, entities?:Array, foreshadows?:Array}} state
 * @returns {string} 16 位十六进制
 */
export function stateHashOf(state = {}) {
  return stateHashDetail(state).hash;
}

/**
 * 与 `stateHashOf` 同源，但额外返回参与哈希的条目数与**分段哈希**，
 * 让"哪一类状态变了"可以直接读出来，而不必靠猜。
 */
export function stateHashDetail(state = {}) {
  const segments = {
    facts: (state.facts || []).map(factFingerprint).sort(byKey(stableStringify)),
    timeline: (state.timeline || []).map(timelineFingerprint).sort(byKey(stableStringify)),
    knowledge: (state.knowledge || []).map(knowledgeFingerprint).sort(byKey(stableStringify)),
    entities: (state.entities || []).map(entityFingerprint).sort(byKey(stableStringify)),
    foreshadows: (state.foreshadows || []).map(foreshadowFingerprint).sort(byKey((x) => x.id)),
  };
  const parts = {};
  for (const key of Object.keys(segments).sort()) parts[key] = sha16(stableStringify(segments[key]));
  return {
    hash: sha16(stableStringify(parts)),
    parts,
    counts: Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, v.length])),
  };
}

const byKey = (keyOf) => (a, b) => {
  const ka = typeof keyOf === 'function' ? keyOf(a) : a[keyOf];
  const kb = typeof keyOf === 'function' ? keyOf(b) : b[keyOf];
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * 章节契约哈希。
 * 只覆盖**契约语义**（目标/节拍/实体/事件/状态变化/伏笔/风格/连续性/验收项），
 * 不覆盖 version 与落库时间——否则"同一份契约重新保存一次"会伪造出一次契约变更。
 */
export function contractHashOf(contract) {
  if (!contract || typeof contract !== 'object') return '';
  return sha16(stableStringify(normalizeForHash(contract)));
}

function normalizeForHash(contract) {
  const pick = (v) => {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : normalizeForHash(x)));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === 'version' || k === 'created_at' || k === 'updated_at' || k === 'id') continue;
        out[k] = normalizeForHash(v[k]);
      }
      return out;
    }
    return v === undefined ? '' : v;
  };
  return pick(contract);
}