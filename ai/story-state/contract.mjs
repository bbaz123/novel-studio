/**
 * 确定性故事状态内核 · 章节契约（PHASE 3）。
 *
 * 契约的核心承诺是一句话：**同一份契约贯穿
 * preflight → context → generation → validation → repair → proposal → acceptance**。
 * 要做到这一点，契约必须是一份**结构化、可哈希、可机械核对**的对象，
 * 而不是一段散文——散文没法回答"这一次成文有没有满足它"。
 *
 * 十一个字段组（缺省即"不约束"，不做隐含默认值）：
 *   chapter_goal                本章要达成什么（一句话，供人读，也进上下文）
 *   required_beats              必须出现的情节点
 *   forbidden_beats             不得出现的情节点
 *   required_entities           必须出场的实体（角色/物品/地点，按名称或实体 id）
 *   required_events             必须发生的事件
 *   allowed_state_changes       允许的状态变化（白名单；空 = 不限制）
 *   forbidden_state_changes     禁止的状态变化（黑名单，优先于白名单）
 *   foreshadow_targets          本章应照顾/回收的伏笔
 *   style_constraints           风格约束（沿用写作红线的词表，不另立一套）
 *   continuity_constraints      连续性约束（不得违背的既有事实）
 *   acceptance_checks           验收项（可机械判定的最小集合）
 *
 * 匹配纪律：只做**确定性**匹配（规范化子串 / 关键词集合），不调用模型。
 * 判定不出来时返回 `unknown` 而不是 `fail`——"内核没看懂"与"作者没写到"是两件事，
 * 混在一起会让验收结论失去意义（作者会开始无视红灯）。
 */

import { contractHashOf } from './hash.mjs';

const str = (v) => String(v || '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 字段组与生成检查项的前缀（写成常量，便于负向对照与文档对齐）。 */
export const CONTRACT_FIELDS = [
  'chapter_goal', 'required_beats', 'forbidden_beats', 'required_entities', 'required_events',
  'allowed_state_changes', 'forbidden_state_changes', 'foreshadow_targets', 'style_constraints',
  'continuity_constraints', 'acceptance_checks',
];

export const THRESHOLDS = { min_goal_chars: 4 };

/** 检查项的判定结果词表。`unknown` 是**一等公民**，不是失败。 */
export const CHECK_STATUS = ['pass', 'fail', 'unknown'];

/** 规范化：把任意输入收敛成契约形状。**不抛异常**——契约往往由模型生成，报错会打断生成流程；
 *  不可用的字段一律降级为空数组并在 `warnings` 里如实登记。 */
export function normalizeContract(input = {}) {
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};
  const out = { chapter_goal: str(src.chapter_goal).trim() };
  if (out.chapter_goal && out.chapter_goal.length < THRESHOLDS.min_goal_chars) {
    warnings.push(`chapter_goal 过短（${out.chapter_goal.length} 字），可能无法作为写作目标`);
  }
  const listOf = (key) => {
    const v = src[key];
    if (v === undefined || v === null || v === '') return [];
    if (Array.isArray(v)) return v.map((x) => normalizeItem(x)).filter((x) => x !== null);
    if (typeof v === 'string') return v.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => normalizeItem(s));
    warnings.push(`${key} 不是数组或字符串，已忽略`);
    return [];
  };
  for (const key of CONTRACT_FIELDS) {
    if (key === 'chapter_goal') continue;
    out[key] = listOf(key);
  }
  if (src.notes !== undefined) out.notes = str(src.notes);
  if (src.source !== undefined) out.source = str(src.source);
  return { contract: out, warnings };
}

function normalizeItem(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'string') {
    const s = x.trim();
    return s ? { text: s } : null;
  }
  if (typeof x !== 'object') return { text: str(x) };
  // 允许 {text, match, entity_id, event_id, foreshadow_id, chapter_index, level, keywords}
  const text = str(x.text || x.summary || x.name || x.title || '').trim();
  if (!text && x.entity_id === undefined && x.event_id === undefined && x.foreshadow_id === undefined) return null;
  return { ...x, text };
}

/** 稳定哈希：同一份契约重复保存不产生新哈希（见 hash.mjs 的 normalizeForHash）。 */
export function hashOf(contract) {
  return contractHashOf(contract);
}

/** 契约里的"关键词集合"：显式 keywords 优先，否则从 text 里切出可判定的片段。 */
function probeList(item) {
  if (item.match) {
    if (typeof item.match === 'string') return [item.match];
    if (Array.isArray(item.match)) return item.match.map(str).filter(Boolean);
  }
  if (Array.isArray(item.keywords) && item.keywords.length) return item.keywords.map(str).filter(Boolean);
  const t = str(item.text).trim();
  if (!t) return [];
  // 去掉常见连接词后按标点/空格切；切不出足够的片段时退回整句。
  const parts = t.split(/[，。、；,;:：!！?？\s]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  return parts.length ? parts : [t];
}

/** 正文规范化（匹配用）：全角转半角、去空白。只影响匹配，不影响原文。 */
export function normalizeForMatch(text) {
  return str(text).normalize('NFKC').replace(/\s+/g, '');
}

function hit(body, item) {
  const probes = probeList(item).map(normalizeForMatch).filter(Boolean);
  if (!probes.length) return null;              // 判不了 → unknown
  return probes.some((p) => body.includes(p));
}

function checkOf(id, kind, item, status, expected, actual, evidence = {}) {
  return { id, kind, status, expected, actual, evidence, text: str(item && item.text) };
}

/**
 * 用契约核对一份正文（成文后）或一份计划（写前预检，draft 传空字符串）。
 *
 * @param {object} contract normalizeContract 的结果
 * @param {string} draft 正文
 * @param {object} opts { stateChanges?: Array<{kind:string, text?:string}>, styleHits?: Array, continuityFacts?: Array }
 * @returns {{passed:boolean, checks:Array, summary:object, contract_hash:string}}
 */
export function checkContract(contract, draft, opts = {}) {
  const c = contract || {};
  const body = normalizeForMatch(draft);
  const checks = [];

  if (c.chapter_goal) {
    checks.push(checkOf('C_GOAL', 'goal', { text: c.chapter_goal }, 'unknown', c.chapter_goal, '', {
      note: '写作目标本身无法机械判定，仅作为上下文与验收参照',
    }));
  }

  for (const [i, item] of (c.required_beats || []).entries()) {
    const ok = hit(body, item);
    checks.push(checkOf(`C_REQ_BEAT_${i + 1}`, 'required_beat', item,
      ok === null ? 'unknown' : (ok ? 'pass' : 'fail'),
      str(item.text), ok === null ? '' : (ok ? '命中' : '未命中'),
      { probes: probeList(item).slice(0, 6) }));
  }
  for (const [i, item] of (c.forbidden_beats || []).entries()) {
    const ok = hit(body, item);
    checks.push(checkOf(`C_FORBID_BEAT_${i + 1}`, 'forbidden_beat', item,
      ok === null ? 'unknown' : (ok ? 'fail' : 'pass'),
      `不得出现：${str(item.text)}`, ok === null ? '' : (ok ? '出现了' : '未出现'),
      { probes: probeList(item).slice(0, 6) }));
  }
  for (const [i, item] of (c.required_entities || []).entries()) {
    const probe = str(item.text || item.name || '');
    const present = probe ? body.includes(normalizeForMatch(probe)) : (item.entity_id !== undefined ? null : false);
    checks.push(checkOf(`C_REQ_ENTITY_${i + 1}`, 'required_entity', item,
      present === null ? 'unknown' : (present ? 'pass' : 'fail'),
      `${probe} 必须出场`, present === null ? '' : (present ? '出场' : '未出场'),
      { entity_id: item.entity_id ?? null }));
  }
  for (const [i, item] of (c.required_events || []).entries()) {
    const ok = hit(body, item);
    checks.push(checkOf(`C_REQ_EVENT_${i + 1}`, 'required_event', item,
      ok === null ? 'unknown' : (ok ? 'pass' : 'fail'),
      str(item.text), ok === null ? '' : (ok ? '命中' : '未命中'),
      { event_id: item.event_id ?? null, probes: probeList(item).slice(0, 6) }));
  }

  // 状态变化：白名单允许、黑名单禁止；黑名单优先。
  const changes = Array.isArray(opts.stateChanges) ? opts.stateChanges : [];
  for (const [i, ch] of changes.entries()) {
    const text = str(ch.text || ch.summary || ch.kind || '');
    const hitForbidden = (c.forbidden_state_changes || []).find((it) => matchForbiddenStateChange(text, it));
    const hitAllowed = (c.allowed_state_changes || []).length === 0
      || (c.allowed_state_changes || []).some((it) => matchForbiddenStateChange(text, it));
    if (hitForbidden) {
      checks.push(checkOf(`C_STATE_CHANGE_${i + 1}`, 'state_change',
        { text: str(hitForbidden.text) }, 'fail', `禁止的变化：${str(hitForbidden.text)}`, text,
        { rule: 'forbidden_state_changes', index: i }));
    } else if (!hitAllowed) {
      checks.push(checkOf(`C_STATE_CHANGE_${i + 1}`, 'state_change',
        { text }, 'fail', '只允许白名单内的状态变化', text,
        { rule: 'allowed_state_changes', index: i, allowed: (c.allowed_state_changes || []).map((x) => str(x.text)) }));
    } else {
      checks.push(checkOf(`C_STATE_CHANGE_${i + 1}`, 'state_change', { text }, 'pass', '白名单内', text,
        { rule: 'allowed_state_changes', index: i }));
    }
  }

  for (const [i, item] of (c.foreshadow_targets || []).entries()) {
    const probe = str(item.text || '');
    const ok = probe ? body.includes(normalizeForMatch(probe)) : null;
    checks.push(checkOf(`C_FORESHADOW_${i + 1}`, 'foreshadow_target', item,
      ok === null ? 'unknown' : (ok ? 'pass' : 'fail'),
      `应照顾伏笔：${probe}`, ok === null ? '' : (ok ? '已提及' : '未提及'),
      { foreshadow_id: item.foreshadow_id ?? null }));
  }

  // 风格约束：复用红线扫描的命中结果（不在这里重新实现扫描）
  const styleHits = Array.isArray(opts.styleHits) ? opts.styleHits : [];
  for (const [i, item] of (c.style_constraints || []).entries()) {
    const probes = probeList(item).map(normalizeForMatch);
    const hits = styleHits.filter((h) => {
      const hp = normalizeForMatch(h.pattern || h.text || h.word || '');
      return probes.length === 0 || probes.includes(hp) || hp.includes(probes[0]);
    });
    checks.push(checkOf(`C_STYLE_${i + 1}`, 'style_constraint', item,
      probes.length === 0 ? 'unknown' : (hits.length ? 'fail' : 'pass'),
      str(item.text), hits.length ? `命中 ${hits.length} 次` : '未命中',
      { hits: hits.slice(0, 5).map((h) => h.pattern || h.text || '') }));
  }

  for (const [i, item] of (c.continuity_constraints || []).entries()) {
    const probe = str(item.text || '');
    const negated = item.must_not === true || /^不得|^不要|^禁止/.test(probe);
    const needle = negated ? probe.replace(/^不得|^不要|^禁止/, '').trim() : probe;
    const present = needle ? body.includes(normalizeForMatch(needle)) : null;
    const status = present === null ? 'unknown' : (negated ? (present ? 'fail' : 'pass') : (present ? 'pass' : 'unknown'));
    checks.push(checkOf(`C_CONTINUITY_${i + 1}`, 'continuity_constraint', item, status,
      str(item.text), present === null ? '' : (present ? '出现' : '未出现'),
      { must_not: negated, needle }));
  }

  for (const [i, item] of (c.acceptance_checks || []).entries()) {
    const ok = hit(body, item);
    checks.push(checkOf(`C_ACCEPT_${i + 1}`, 'acceptance_check', item,
      ok === null ? 'unknown' : (ok ? 'pass' : 'fail'),
      str(item.text), ok === null ? '' : (ok ? '满足' : '未满足'),
      { probes: probeList(item).slice(0, 6) }));
  }

  const fails = checks.filter((x) => x.status === 'fail');
  const unknowns = checks.filter((x) => x.status === 'unknown');
  const passes = checks.filter((x) => x.status === 'pass');
  return {
    passed: fails.length === 0,
    checks,
    contract_hash: hashOf(c),
    summary: { total: checks.length, pass: passes.length, fail: fails.length, unknown: unknowns.length },
  };
}

function matchForbiddenStateChange(text, rule) {
  const t = normalizeForMatch(text);
  const probes = probeList(rule).map(normalizeForMatch).filter(Boolean);
  if (!probes.length) return false;
  return probes.some((p) => t.includes(p) || p.includes(t));
}

/**
 * 把契约渲染成上下文档的正文。
 * 渲染顺序固定（目标 → 必须 → 禁止 → 实体 → 事件 → 状态变化 → 伏笔 → 风格 → 连续性 → 验收），
 * 因为**同一份契约必须装配出同一段文字**，否则逐字节基线会无缘无故地红。
 */
export function renderContractSection(contract, { includeStyle = true } = {}) {
  const c = contract || {};
  const lines = [];
  if (c.chapter_goal) lines.push(`本章目标：${c.chapter_goal}`);
  const block = (title, items, fmt) => {
    if (!items || !items.length) return;
    lines.push(`${title}：`);
    for (const it of items) lines.push(`  · ${fmt(it)}`);
  };
  block('必须写到的情节点', c.required_beats, (it) => str(it.text));
  block('禁止出现的情节点', c.forbidden_beats, (it) => str(it.text));
  block('必须出场', c.required_entities, (it) => str(it.text || it.name));
  block('必须发生的事件', c.required_events, (it) => str(it.text));
  block('允许的状态变化', c.allowed_state_changes, (it) => str(it.text));
  block('禁止的状态变化', c.forbidden_state_changes, (it) => str(it.text));
  block('应照顾的伏笔', c.foreshadow_targets, (it) => `#${it.foreshadow_id ?? '?'} ${str(it.text)}`);
  if (includeStyle) block('风格约束', c.style_constraints, (it) => str(it.text));
  block('连续性约束（不得违背）', c.continuity_constraints, (it) => str(it.text));
  block('验收项', c.acceptance_checks, (it) => str(it.text));
  return lines.join('\n');
}

/** 契约是否"足够具体到可以用来核对"——空契约不应该产生"通过"的假象。 */
export function isCheckable(contract) {
  const c = contract || {};
  const n = CONTRACT_FIELDS.filter((k) => k !== 'chapter_goal')
    .reduce((acc, k) => acc + ((c[k] || []).length), 0);
  return n > 0;
}

export function chapterIndexOfContract(contract) {
  return num(contract && contract.chapter_index);
}