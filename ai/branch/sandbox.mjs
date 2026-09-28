/**
 * sandbox.mjs —— R11「剧情分支沙盘」纯模块（确定性、零模型调用、零计费）。
 *
 * 边界（写清楚才不会长成第二套世界观系统）：
 *   - 沙盘候选**不是**本书事实：本模块不写任何表，也不产出 story_facts / story_events /
 *     character_knowledge；候选只描述"可以往哪写"，采纳也只形成蓝图/契约建议。
 *   - 角色的行动理由必须受**该角色在当前时点的可行动知识**约束（R10 派生视图的 actionable_ids）；
 *     作者真相（AUTHOR_KNOWLEDGE）允许用于评估全局后果，但不得变成角色的行动依据。
 *   - 未来计划（author_plan / future / not_yet_disclosed）不得被写成"已发生"（certainty=established）。
 *   - "不同候选"的机械判据：核心行动规范化后不得相同；措辞级改写（高相似度 + 同一冲突）判"实质差异不足"。
 *     相似度是启发式，永远**只报告不代替作者判断**。
 *   - 依赖基线（state/content/contract/intent/disclosure 指纹）变化 → 候选标 stale：仍可阅读，
 *     但重新采纳必须复核/重新生成（adopt 侧强制，见 server.js）。
 */
import { sha16, stableStringify } from '../story-state/hash.mjs';

export const SANDBOX_VERSION = '1.0.0';

export const SANDBOX_LIMITS = Object.freeze({
  min_candidates: 2,
  max_candidates: 5,
  max_title_chars: 80,
  max_action_chars: 600,
  max_text_chars: 2000,
  max_items: 12,
  max_basis_ids: 40,
  // ≥ 该相似度且核心冲突相同 → 判"实质差异不足"（仅改写措辞/重排语序不算多个候选）
  max_similarity_to_count_as_distinct: 0.7,
});

export const CERTAINTY = Object.freeze(['established', 'planned', 'possible', 'uncertain']);
export const INTENT_STANCES = Object.freeze(['follows', 'extends', 'conflicts', 'neutral']);
export const RELATION_KINDS = Object.freeze(['relation', 'foreshadow']);

/** 允许出现在 certainty=established 后果里的分层（计划/未来/撤回/无记录一律禁止）。 */
const FORBIDDEN_ESTABLISHED_TIERS = Object.freeze(['author_plan', 'future', 'not_yet_disclosed', 'retracted', 'undetermined']);

const str = (v) => String(v === undefined || v === null ? '' : v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const list = (v) => (Array.isArray(v) ? v : []);

/** 规范化核心行动：去掉空白/标点与高频虚词，供"是否实质相同"比对。 */
const PUNCT_RE = /[\s，。、；：！？…—–·"'“”‘’（）()【】\[\]{}<>《》,.!?;:~`|/\\+=*&^%$#@!~～]/g;
const STOPWORDS = ['然后', '于是', '决定', '选择', '进行', '采取', '最终', '开始', '准备'];

/**
 * 有界的动作同义组：只覆盖高频"换词不换事"的改写（如 夺取/偷走/抢走）。
 * 这是**启发式词表**，不是语义分析：覆盖不到的组合由比较视图交给作者裁决。
 */
const VERB_GROUPS = [
  ['潜入', '混入', '溜进', '摸进'],
  ['夺取', '偷走', '抢走', '拿走', '窃取', '盗走'],
  ['杀死', '杀害', '干掉', '除掉'],
  ['质问', '责问', '当面对质', '公开质问'],
  ['坦白', '承认', '供认', '和盘托出'],
  ['逃离', '逃走', '跑掉'],
  ['求助', '求援', '找人帮忙'],
  ['结盟', '联手', '合作'],
  ['背叛', '出卖', '反水'],
  ['威胁', '威逼', '胁迫'],
  ['藏匿', '藏起', '藏好'],
  ['寻找', '搜寻', '查找'],
];
const VERB_CANON = new Map();
for (const group of VERB_GROUPS) for (const w of group) VERB_CANON.set(w, group[0]);
const VERB_KEYS = [...VERB_CANON.keys()].sort((a, b) => b.length - a.length);

function canonicalizeVerbs(text) {
  let out = text;
  for (const w of VERB_KEYS) if (out.includes(w)) out = out.split(w).join(VERB_CANON.get(w));
  return out;
}

export function normalizeActionKey(text) {
  let s = str(text).toLowerCase().replace(PUNCT_RE, '');
  for (const w of STOPWORDS) s = s.split(w).join('');
  return canonicalizeVerbs(s);
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 剥掉公共前缀/后缀，留下"真正不同的那一段"（同义换词/不同动作都会落在这里）。 */
export function stripCommonCore(a, b) {
  const A = normalizeActionKey(a);
  const B = normalizeActionKey(b);
  const minLen = Math.min(A.length, B.length);
  let i = 0;
  while (i < minLen && A[i] === B[i]) i++;
  let j = 0;
  while (j < minLen - i && A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  return [A.slice(i, A.length - j), B.slice(i, B.length - j)];
}

/**
 * "措辞级改写"启发式：先剥掉公共前缀/后缀，再算差异段的字符二元组 Jaccard 相似度（0..1）。
 * 完全相同 → 1；只差零星虚词 → 接近 1；换了核心动作/立场（如"夺取钥匙" vs "向守卫投降"）→ 接近 0。
 * 这是机械判据，不是语义等价判断：边界情况由作者在比较视图里裁决，宿主不替作者打分。
 */
export function actionSimilarity(a, b) {
  const A0 = normalizeActionKey(a);
  const B0 = normalizeActionKey(b);
  if (!A0 || !B0) return 0;
  if (A0 === B0) return 1;
  const [A, B] = stripCommonCore(a, b);
  const ga = bigrams(A);
  const gb = bigrams(B);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return Number((inter / (ga.size + gb.size - inter)).toFixed(3));
}

function textItems(value, label, errors) {
  const arr = list(value);
  if (arr.length > SANDBOX_LIMITS.max_items) errors.push(`${label} 超过 ${SANDBOX_LIMITS.max_items} 条`);
  const out = [];
  for (const raw of arr.slice(0, SANDBOX_LIMITS.max_items)) {
    const text = str(raw && typeof raw === 'object' ? raw.text : raw).trim();
    if (!text) { errors.push(`${label} 有空条目`); continue; }
    if (text.length > SANDBOX_LIMITS.max_text_chars) { errors.push(`${label} 单条超过 ${SANDBOX_LIMITS.max_text_chars} 字`); continue; }
    out.push(raw && typeof raw === 'object' ? { ...raw, text } : { text });
  }
  return out;
}

function normalizeChoices(value, errors) {
  const arr = list(value);
  if (!arr.length) {
    errors.push('缺少 character_choices（人物选择）：每个候选至少要说清一个具体角色做了什么选择、依据是什么');
  }
  if (arr.length > SANDBOX_LIMITS.max_items) errors.push(`character_choices 超过 ${SANDBOX_LIMITS.max_items} 条`);
  return arr.slice(0, SANDBOX_LIMITS.max_items).map((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const choice = str(r.choice).trim();
    const name = str(r.name).trim();
    const hasId = r.character_id !== undefined && r.character_id !== null && r.character_id !== '' && Number.isFinite(Number(r.character_id));
    const character_id = hasId ? num(r.character_id) : null;
    const isNew = r.new_character === true || character_id === null;
    if (!choice) errors.push(`character_choices[${i}] 缺少 choice（这个角色做了什么选择）`);
    if (choice.length > SANDBOX_LIMITS.max_text_chars) errors.push(`character_choices[${i}].choice 超过 ${SANDBOX_LIMITS.max_text_chars} 字`);
    if (character_id === null && !name) errors.push(`character_choices[${i}] 需要 character_id（既有角色）或 name + new_character=true（新角色）`);
    if (character_id === null && r.new_character !== true) {
      errors.push(`character_choices[${i}] 只有 name 没有 character_id：新角色必须显式 new_character=true，既有角色必须给 character_id（否则无法核对"这个角色当前知不知道"）`);
    }
    const basis_ids = list(r.basis_ids).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const basis_keys = list(r.basis_keys).map((k) => str(k).trim()).filter(Boolean).map((k) => k.slice(0, 100));
    if (basis_ids.length > SANDBOX_LIMITS.max_basis_ids) errors.push(`character_choices[${i}].basis_ids 超过 ${SANDBOX_LIMITS.max_basis_ids} 条`);
    if (basis_keys.length > SANDBOX_LIMITS.max_basis_ids) errors.push(`character_choices[${i}].basis_keys 超过 ${SANDBOX_LIMITS.max_basis_ids} 条`);
    // 既有角色的行动理由：要么给出该角色当前可行动事实 id（可机械核对），
    // 要么给出 basis_note 说明（作品还没有登记任何事实时无法核对，只能是"未核对"而不是"已通过"）。
    if (character_id !== null && !basis_ids.length && !basis_keys.length && !str(r.basis_note).trim()) {
      errors.push(`character_choices[${i}] 的既有角色必须给出 basis_ids / basis_keys（该角色当前可行动的事实依据）或 basis_note（说明为什么无法给依据）`);
    }
    return {
      character_id, name, new_character: character_id === null && isNew, choice, basis_ids, basis_keys,
      basis_note: str(r.basis_note).trim().slice(0, SANDBOX_LIMITS.max_text_chars),
    };
  });
}

function normalizeConsequences(value, errors) {
  const arr = list(value);
  if (!arr.length) errors.push('缺少 consequences（可能后果）');
  if (arr.length > SANDBOX_LIMITS.max_items) errors.push(`consequences 超过 ${SANDBOX_LIMITS.max_items} 条`);
  return arr.slice(0, SANDBOX_LIMITS.max_items).map((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : { text: raw };
    const text = str(r.text).trim();
    const certainty = str(r.certainty || 'possible').trim();
    if (!text) errors.push(`consequences[${i}] 缺少 text`);
    if (text.length > SANDBOX_LIMITS.max_text_chars) errors.push(`consequences[${i}].text 超过 ${SANDBOX_LIMITS.max_text_chars} 字`);
    if (!CERTAINTY.includes(certainty)) errors.push(`consequences[${i}].certainty=${certainty} 非法：只允许 ${CERTAINTY.join(' / ')}`);
    const fact_ids = list(r.fact_ids).map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, SANDBOX_LIMITS.max_basis_ids);
    return { text, certainty: CERTAINTY.includes(certainty) ? certainty : 'possible', fact_ids };
  });
}

function normalizeRelations(value, errors) {
  const arr = list(value);
  if (arr.length > SANDBOX_LIMITS.max_items) errors.push(`relations_foreshadows 超过 ${SANDBOX_LIMITS.max_items} 条`);
  return arr.slice(0, SANDBOX_LIMITS.max_items).map((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : { text: raw };
    const text = str(r.text).trim();
    const kind = str(r.kind || 'relation').trim();
    if (!text) errors.push(`relations_foreshadows[${i}] 缺少 text`);
    if (!RELATION_KINDS.includes(kind)) errors.push(`relations_foreshadows[${i}].kind=${kind} 非法：只允许 ${RELATION_KINDS.join(' / ')}`);
    const ref_id = r.ref_id === undefined || r.ref_id === null || r.ref_id === '' ? null : num(r.ref_id);
    return { kind: RELATION_KINDS.includes(kind) ? kind : 'relation', text: text.slice(0, SANDBOX_LIMITS.max_text_chars), ref_id };
  });
}

/** 形状校验 + 规范化。错误只报告，不改写语义。 */
export function validateCandidateShape(input, { index = 0 } = {}) {
  const errors = [];
  const c = input && typeof input === 'object' ? input : {};
  const title = str(c.title).trim().slice(0, SANDBOX_LIMITS.max_title_chars);
  const core_action = str(c.core_action).trim();
  const conflict = str(c.conflict).trim();
  if (!core_action) errors.push('缺少 core_action（核心行动）');
  if (core_action.length > SANDBOX_LIMITS.max_action_chars) errors.push(`core_action 超过 ${SANDBOX_LIMITS.max_action_chars} 字`);
  if (!conflict) errors.push('缺少 conflict（核心冲突/立场选择：这个候选和别的最本质的区别在哪里）');
  if (conflict.length > SANDBOX_LIMITS.max_action_chars) errors.push(`conflict 超过 ${SANDBOX_LIMITS.max_action_chars} 字`);
  const candidate = {
    title: title || `候选 ${index + 1}`,
    core_action,
    conflict,
    core_key: normalizeActionKey(core_action),
    conflict_key: normalizeActionKey(conflict),
    character_choices: normalizeChoices(c.character_choices, errors),
    beats: textItems(c.beats, 'beats（剧情节拍）', errors),
    consequences: normalizeConsequences(c.consequences, errors),
    relations_foreshadows: normalizeRelations(c.relations_foreshadows, errors),
    risks: textItems(c.risks, 'risks（风险）', errors),
    required_setup: textItems(c.required_setup, 'required_setup（必要铺垫）', errors),
    intent_relation: (() => {
      const r = c.intent_relation && typeof c.intent_relation === 'object' ? c.intent_relation : { text: c.intent_relation };
      const stance = str(r.stance || 'neutral').trim();
      if (!INTENT_STANCES.includes(stance)) errors.push(`intent_relation.stance=${stance} 非法：只允许 ${INTENT_STANCES.join(' / ')}`);
      return {
        text: str(r.text).trim().slice(0, SANDBOX_LIMITS.max_text_chars),
        stance: INTENT_STANCES.includes(stance) ? stance : 'neutral',
        intent_ids: list(r.intent_ids).map(Number).filter((n) => Number.isFinite(n)).slice(0, SANDBOX_LIMITS.max_basis_ids),
      };
    })(),
    source: (() => {
      const r = c.source && typeof c.source === 'object' ? c.source : {};
      return {
        author_truth_ids: list(r.author_truth_ids).map(Number).filter((n) => Number.isFinite(n)).slice(0, SANDBOX_LIMITS.max_basis_ids),
        reader_disclosed_ids: list(r.reader_disclosed_ids).map(Number).filter((n) => Number.isFinite(n)).slice(0, SANDBOX_LIMITS.max_basis_ids),
        note: str(r.note).trim().slice(0, SANDBOX_LIMITS.max_text_chars),
      };
    })(),
  };
  return { ok: errors.length === 0, errors, candidate };
}

/** 2—5 个候选 + "实质差异"检查。 */
export function checkDistinctness(candidates, { maxSimilarity = SANDBOX_LIMITS.max_similarity_to_count_as_distinct } = {}) {
  const errors = [];
  const report = [];
  if (candidates.length < SANDBOX_LIMITS.min_candidates) errors.push(`候选数量不足：至少 ${SANDBOX_LIMITS.min_candidates} 个，收到 ${candidates.length} 个`);
  if (candidates.length > SANDBOX_LIMITS.max_candidates) errors.push(`候选数量过多：最多 ${SANDBOX_LIMITS.max_candidates} 个，收到 ${candidates.length} 个`);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const sameKey = !!a.core_key && a.core_key === b.core_key;
      const sim = actionSimilarity(a.core_action, b.core_action);
      const sameConflict = !!a.conflict_key && a.conflict_key === b.conflict_key;
      const tooSimilar = sameKey || (sim >= maxSimilarity && sameConflict);
      report.push({ a: i, b: j, similarity: sim, same_core_key: sameKey, same_conflict: sameConflict, distinct: !tooSimilar });
      if (tooSimilar) {
        errors.push(`候选 ${i + 1} 与候选 ${j + 1} 的核心行动/冲突没有实质差异（相似度 ${sim}${sameKey ? '，核心行动规范化后相同' : ''}）：仅改写措辞、交换同义表达不算多个候选`);
      }
    }
  }
  return { ok: errors.length === 0, errors, report, threshold: maxSimilarity };
}

/** 与"沙盘里已有的候选"逐个比对（恢复追加最后一个槽位时的判据）。 */
export function checkDistinctAgainst(candidate, existing, { maxSimilarity = SANDBOX_LIMITS.max_similarity_to_count_as_distinct } = {}) {
  const errors = [];
  const report = [];
  for (const [i, other] of list(existing).entries()) {
    const otherKey = other.core_key || normalizeActionKey(other.core_action);
    const sameKey = !!candidate.core_key && candidate.core_key === otherKey;
    const sim = actionSimilarity(candidate.core_action, other.core_action);
    const sameConflict = normalizeActionKey(candidate.conflict) === normalizeActionKey(other.conflict);
    const tooSimilar = sameKey || (sim >= maxSimilarity && sameConflict);
    report.push({ existing_id: other.id ?? null, index: i, similarity: sim, same_core_key: sameKey, same_conflict: sameConflict, distinct: !tooSimilar });
    if (tooSimilar) {
      errors.push(`与已有候选 #${other.id ?? i + 1}（${other.title || ''}）没有实质差异（相似度 ${sim}${sameKey ? '，核心行动规范化后相同' : ''}）：仅改写措辞不算多个候选`);
    }
  }
  return { ok: errors.length === 0, errors, report, threshold: maxSimilarity };
}

/**
 * 角色行动理由约束 + 未来不得冒充已发生。
 * disclosure = R10 deriveDisclosure() 的返回值（必须按当前章/场景重算）。
 * 既有角色的每个 basis_id 必须在该角色的 actionable_ids 里；新角色不做既有知识核对（但仍受证据纪律约束）。
 */
export function validateKnowledgeConstraints(candidate, disclosure) {
  const violations = [];
  const warnings = [];
  const byId = new Map(list(disclosure && disclosure.characters).map((c) => [String(c.character_id), c]));
  const tierOf = new Map(list(disclosure && disclosure.items).map((it) => [String(it.id), it.tier]));
  const factsRegistered = list(disclosure && disclosure.items).length;
  for (const [i, ch] of list(candidate.character_choices).entries()) {
    if (ch.character_id === null) continue;
    const view = byId.get(String(ch.character_id));
    if (!view) {
      violations.push({ code: 'UNKNOWN_CHARACTER', index: i, character_id: ch.character_id, reason: `角色 #${ch.character_id} 不在本作品角色表里：沙盘不得凭空使用不存在的角色` });
      continue;
    }
    const hasIds = (ch.basis_ids || []).length > 0;
    const hasKeys = (ch.basis_keys || []).length > 0;
    if (!hasIds && !hasKeys) {
      warnings.push({
        code: 'BASIS_UNVERIFIED', index: i, character_id: ch.character_id,
        reason: `角色「${view.name}」的行动依据没有给事实 id / key：宿主无法核对（作品当前登记的事实数 ${factsRegistered}）——这是"未核对"，不是"已通过"`,
      });
      continue;
    }
    const actionable = new Set((view.actionable_ids || []).map(String));
    const knownKeys = new Set((view.known || []).map((k) => str(k.fact_key)).filter(Boolean));
    const keyStateOf = (key) => {
      if ((view.known || []).some((k) => str(k.fact_key) === key)) return 'known';
      for (const [state, rows] of [['unknown', view.unknown], ['suspected', view.suspected], ['false_belief', view.false_beliefs]]) {
        if ((rows || []).some((k) => str(k.fact_key) === key)) return state;
      }
      return 'undetermined';
    };
    for (const fid of ch.basis_ids || []) {
      if (!actionable.has(String(fid))) {
        const tier = tierOf.get(String(fid)) || 'undetermined';
        violations.push({
          code: 'BASIS_NOT_KNOWN_AT_CURSOR', index: i, character_id: ch.character_id, fact_id: fid, tier,
          reason: `角色「${view.name}」在当前时点不掌握事实 #${fid}（分层：${tier}）——行动理由不能用作者真相/读者披露/未来计划，也不能用没有记录的条目`,
        });
      }
    }
    for (const key of ch.basis_keys || []) {
      if (!knownKeys.has(key)) {
        const state = keyStateOf(key);
        violations.push({
          code: 'BASIS_KEY_NOT_KNOWN_AT_CURSOR', index: i, character_id: ch.character_id, fact_key: key, tier: state,
          reason: `角色「${view.name}」在当前时点不掌握「${key}」（知识状态：${state}）——行动理由不能引用角色不知道/只是怀疑/误信的条目`,
        });
      }
    }
  }
  for (const [i, cons] of list(candidate.consequences).entries()) {
    if (cons.certainty !== 'established') continue;
    for (const fid of cons.fact_ids || []) {
      const tier = tierOf.get(String(fid)) || 'undetermined';
      if (FORBIDDEN_ESTABLISHED_TIERS.includes(tier)) {
        violations.push({
          code: 'FUTURE_AS_ESTABLISHED', index: i, fact_id: fid, tier,
          reason: `后果 #${i + 1} 把${tier === 'undetermined' ? '没有记录的条目' : '计划/未来条目'} #${fid} 写成了"已发生"（certainty=established）：未来计划不能冒充已发生事件`,
        });
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    warnings,
    facts_registered: factsRegistered,
    status: violations.length ? 'has_violations' : (warnings.length ? 'has_unverified' : 'checked'),
  };
}

/** 依赖基线：宿主保存候选时算一份，重新采纳前再算一份，逐项比对。 */
export function buildSandboxDeps(input = {}) {
  const deps = {
    work_id: num(input.work_id),
    chapter_id: num(input.chapter_id),
    chapter_index: num(input.chapter_index),
    state_hash: str(input.state_hash),
    content_hash: str(input.content_hash),
    contract_hash: str(input.contract_hash),
    intent_hash: str(input.intent_hash),
    disclosure_fingerprint: str(input.disclosure_fingerprint),
  };
  deps.hash = 'sandbox-' + sha16(stableStringify(deps));
  return deps;
}

export function isSandboxStale(recorded, current) {
  const keys = ['state_hash', 'content_hash', 'contract_hash', 'intent_hash', 'disclosure_fingerprint', 'chapter_index'];
  const changed = keys.filter((k) => str(recorded && recorded[k]) !== str(current && current[k]));
  return { stale: changed.length > 0, changed };
}

export const COMPARE_DIMENSIONS = Object.freeze([
  { key: 'core_action', label: '核心行动' },
  { key: 'conflict', label: '冲突选择' },
  { key: 'character_choices', label: '人物选择' },
  { key: 'beats', label: '剧情节拍' },
  { key: 'consequences', label: '可能后果' },
  { key: 'relations_foreshadows', label: '关系/伏笔影响' },
  { key: 'risks', label: '风险' },
  { key: 'required_setup', label: '必要铺垫' },
  { key: 'intent_relation', label: '与作者意图' },
]);

function renderDimension(c, key) {
  const v = c && c[key];
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.text || x.choice || '') : str(x))).join('｜');
  if (v && typeof v === 'object') return str(v.text || v.stance);
  return str(v);
}

/** 比较视图：逐维并列 + 差异清单（不做"谁更好"的裁决）。 */
export function compareCandidates(a, b) {
  const rows = COMPARE_DIMENSIONS.map(({ key, label }) => {
    const va = renderDimension(a, key);
    const vb = renderDimension(b, key);
    return { key, label, a: va, b: vb, same: va === vb };
  });
  return {
    a: { id: a ? a.id ?? null : null, title: (a && a.title) || '', core_action: (a && a.core_action) || '' },
    b: { id: b ? b.id ?? null : null, title: (b && b.title) || '', core_action: (b && b.core_action) || '' },
    dimensions: rows,
    differences: rows.filter((r) => !r.same).map((r) => r.key),
    same_count: rows.filter((r) => r.same).length,
    note: '只并列差异，不替作者打分或排序。',
  };
}

/**
 * 采纳计划：只产出「章节蓝图 + 契约建议」。
 * 明文边界：不改正文、不写正典事实、不改角色状态（正文/事实的变更必须走各自的作者确认流程）。
 */
export function buildAdoptionPlan(candidate, { chapterTitle = '' } = {}) {
  const c = candidate || {};
  const clip = (s) => str(s).slice(0, 2000);
  const blueprint = {
    scene_goal: clip(c.core_action),
    plot_points: clip((c.beats || []).map((b) => b.text).join('\n')),
    conflicts: clip([c.conflict, ...(c.risks || []).map((r) => `风险：${r.text}`)].filter(Boolean).join('\n')),
    character_changes: clip((c.character_choices || []).map((x) => `${x.name || '#' + x.character_id}：${x.choice}`).join('\n')),
    hook: clip((c.required_setup || []).map((x) => x.text).join('\n')),
    references: clip((c.relations_foreshadows || []).map((x) => `[${x.kind}] ${x.text}`).join('\n')),
  };
  const contract_suggestion = {
    chapter_goal: str(c.core_action).slice(0, 500),
    required_beats: (c.beats || []).map((b) => ({ text: b.text })),
    required_entities: (c.character_choices || []).filter((x) => x.character_id !== null).map((x) => ({ character_id: x.character_id, text: x.name || '' })),
    forbidden_beats: [],
    note: `来自剧情候选 #${c.id ?? ''}（${chapterTitle || '当前章'}）：采纳只形成计划/契约建议，后续按对应作者确认流程处理。`,
  };
  return {
    blueprint,
    contract_suggestion,
    never_touched: ['chapters.content', 'story_facts', 'story_events', 'character_knowledge', 'characters'],
    disclaimer: '采纳只写入章节蓝图与契约建议；正文、正典事实、角色状态一律不动。',
  };
}

/** 列表摘要（界面与工具共用一份）。 */
export function summarizeCandidate(c) {
  return {
    id: c.id, work_id: c.work_id, sandbox_id: c.sandbox_id, chapter_id: c.chapter_id, ordinal: c.ordinal,
    title: c.title, core_action: c.core_action, conflict: c.conflict,
    counts: {
      choices: (c.character_choices || []).length, beats: (c.beats || []).length,
      consequences: (c.consequences || []).length, risks: (c.risks || []).length,
      required_setup: (c.required_setup || []).length, relations_foreshadows: (c.relations_foreshadows || []).length,
    },
    intent_stance: (c.intent_relation || {}).stance || 'neutral',
    status: c.status, stale: !!c.stale, created_by: c.created_by || '', deps_hash: c.deps_hash || '',
    created_at: c.created_at, updated_at: c.updated_at,
  };
}