/**
 * 确定性故事状态内核 · 正典投影与冲突分级（P0 必答项之一）。
 *
 * 正典（canon）= 在**当前章节点**上确实成立的事实集合。它由三样东西共同决定：
 *   ① `status`：established 才算正典；planned 是**安排**，不是已发生（把 planned 当
 *      established 用是长篇最隐蔽的崩法）；retracted / superseded 已失效。
 *   ② `effective_from / effective_to` 窗口：第 5 章不能看到第 9 章才成立的事实。
 *   ③ 取代关系：`superseded_by` 指向的那条生效后，本条不再参与投影。
 *
 * ⚠ 冲突分级里最重要的一条纪律：**正典冲突不能由 AI 擅自选择**。
 *    两个事实互相矛盾时（"张三死了" vs "张三在场"），解铃的只能是作者——
 *    所以正典类冲突一律 `requires_author_decision: true` / `auto_fixable: false`。
 *    只有低风险的格式类问题允许自动修复（见 AUTO_FIXABLE_CODES）。
 */

import { KNOWLEDGE_SCOPES } from './knowledge.mjs';
import { ordinal } from './timeline.mjs';

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

/** 五级：critical 必须停下；info 只做提示。 */
export const CONFLICT_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * 允许**自动修复**的问题码白名单——只限低风险的格式/标点/AI 套话/重复/工具格式。
 * 一切涉及"故事内容是什么"的判断都不在名单里。名单外的冲突一律要求作者决定。
 *
 * 注意这里是**问题码**而不是严重度：`low` 级的故事冲突（例如"同一句话里两次提到同一个道具"）
 * 依然要作者拍板，因为内核没有立场替作者判断哪一次是对的。
 */
export const AUTO_FIXABLE_CODES = [
  'FORMAT_TOOL_MARKUP',      // 正文里残留的工具调用标记
  'FORMAT_DUPLICATE_BLANK',  // 连续空行
  'FORMAT_PUNCTUATION',      // 中英标点混用
  'FORMAT_AI_CLICHE',        // 反 AI 腔红线命中的套话
  'FORMAT_DUPLICATED_SENTENCE', // 段落内整句重复
];

export function isAutoFixable(code) {
  return AUTO_FIXABLE_CODES.includes(String(code || ''));
}

const LEVEL_BY_CODE = {
  DECEASED_THEN_ACTIVE: 'critical',
  AUTHOR_SCOPE_LEAK: 'critical',
  KNOWLEDGE_VIOLATION: 'critical',
  PLANNED_AS_ESTABLISHED: 'high',
  SUPERSEDED_CANON_IN_USE: 'high',
  FACT_VALUE_CONFLICT: 'high',
  ORDER_BEFORE_VIOLATED: 'high',
  ORDER_AFTER_VIOLATED: 'high',
  FUTURE_EFFECTIVE_FROM: 'critical',
  FUTURE_CHAPTER_INDEX: 'critical',
  ITEM_STATE_CONTRADICTION: 'high',
  ALIAS_COLLISION: 'high',
  ENTITY_SAME_REF: 'high',
  ENTITY_DUPLICATE_NAME: 'high',
  FORESHADOW_MIS_RESOLVED: 'high',
  FORESHADOW_OVERDUE: 'medium',
  FORESHADOW_STALLED: 'medium',
  CONTRACT_REQUIRED_MISSING: 'high',
  CONTRACT_FORBIDDEN_PRESENT: 'high',
  CONTRACT_STATE_CHANGE_VIOLATION: 'critical',
  STYLE_DRIFT: 'medium',
  STYLE_CLICHE_DENSITY: 'low',
};

/** 归一到五级；未知码给 'medium'（不静默降级成 info——未知问题不该被当成噪音）。 */
export function levelOf(code) {
  return LEVEL_BY_CODE[String(code || '')] || 'medium';
}

/**
 * 给一条冲突补齐分级字段。
 * `auto_fixable` 与 `requires_author_decision` 是**互斥**的：
 * 自动可修的问题不需要作者决定；需要作者决定的问题不许自动修。
 */
export function classifyConflict(conflict = {}) {
  const code = String(conflict.code || '');
  const auto = isAutoFixable(code);
  return {
    ...conflict,
    code,
    level: conflict.level || levelOf(code),
    auto_fixable: auto,
    requires_author_decision: !auto,
  };
}

/** 按分级汇总：`{critical: n, high: n, ...}` + 是否需要作者介入。 */
export function summarizeConflicts(conflicts = []) {
  const counts = Object.fromEntries(CONFLICT_LEVELS.map((l) => [l, 0]));
  for (const c of conflicts) {
    const lvl = CONFLICT_LEVELS.includes(c.level) ? c.level : levelOf(c.code);
    counts[lvl] += 1;
  }
  return {
    counts,
    total: conflicts.length,
    blocking: counts.critical > 0,
    needs_author: conflicts.some((c) => c.requires_author_decision !== false && !c.auto_fixable),
  };
}

/** 事实的规范化（读库出来的形状 → 内核的形状）。 */
export function normalizeFact(row = {}) {
  const scope = String(row.scope || 'CANON_KNOWLEDGE');
  return {
    id: row.id ?? null,
    work_id: row.work_id ?? null,
    chapter_id: row.chapter_id ?? null,
    entity_id: row.entity_id ?? null,
    entity_name: String(row.entity_name || ''),
    subject: String(row.subject || ''),
    predicate: String(row.predicate || ''),
    value: String(row.value || ''),
    scope: KNOWLEDGE_SCOPES.includes(scope) ? scope : 'CANON_KNOWLEDGE',
    state: String(row.state || 'known'),
    status: String(row.status || 'established'),
    superseded_by: row.superseded_by ?? null,
    holder_id: row.holder_id ?? null,
    effective_from: num(row.effective_from),
    effective_to: row.effective_to === null || row.effective_to === undefined ? null : num(row.effective_to),
    story_time: String(row.story_time || ''),
    source_event_id: row.source_event_id ?? null,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 1,
    dedup_key: String(row.dedup_key || ''),
    payload: row.payload ?? {},
  };
}

function inWindow(f, chapterIndex) {
  if (f.effective_from > chapterIndex) return false;
  if (f.effective_to !== null && f.effective_to <= chapterIndex) return false;
  return true;
}

/**
 * 正典投影。
 *
 * @param {Array} facts 全部事实
 * @param {object} cursor {chapter_index, scene_index}
 * @returns {{canon:Array, planned:Array, retracted:Array, future:Array, excluded:Array}}
 *   - canon     当前成立、可据此写作的事实
 *   - planned   已安排但尚未发生（**不得**作为已发生的事叙述）
 *   - retracted 已撤回 / 已被取代
 *   - future    生效窗口在未来（不得出现在当前章节）
 *   - excluded  作者视角信息（AUTHOR_KNOWLEDGE）——装配时应单独处理，绝不混进 canon
 */
export function projectCanon(facts = [], cursor) {
  const canon = []; const planned = []; const retracted = []; const future = []; const excluded = [];
  const supersededIds = new Set();
  for (const raw of facts) if (raw.superseded_by) supersededIds.add(String(raw.id));
  for (const raw of facts) {
    const f = normalizeFact(raw);
    if (f.status === 'planned') { planned.push(f); continue; }
    if (f.status === 'retracted' || f.status === 'superseded' || supersededIds.has(String(f.id))) { retracted.push(f); continue; }
    if (f.scope === 'AUTHOR_KNOWLEDGE') { excluded.push(f); continue; }
    if (!inWindow(f, cursor.chapter_index)) { future.push(f); continue; }
    canon.push(f);
  }
  return { canon, planned, retracted, future, excluded };
}

/** (subject, predicate) 的归一键：判"同一件事"必须用归一后的键，否则换空格就换了一件事。 */
export function factKeyOf(f) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const subj = norm(f.subject) || norm(f.entity_name) || `#${f.entity_id ?? ''}`;
  return `${subj}::${norm(f.predicate)}`;
}

/**
 * 正典冲突检测。返回**已分级**的冲突清单（每条都带 evidence）。
 *
 * 覆盖（按危害排序）：
 *   ① 死人复活：`status=deceased/life=dead` 已成立，之后又有该主体在场/存活的事实；
 *   ② 未来泄漏：在将来才成立的事实被当前章节引用（由 timeline/knowledge 提供，此处只做事实侧）；
 *   ③ 把 planned 当 established：正文/提案里把计划写成了已发生；
 *   ④ 已撤回的事实仍在使用；
 *   ⑤ 同一 (主体, 谓词) 在同一时点有两个不同的值（真正的正典矛盾）；
 *   ⑥ 物品状态矛盾（存在/损毁/易主 三类互斥）。
 */
export function detectCanonConflicts(facts = [], cursor, opts = {}) {
  const out = [];
  const all = facts.map(normalizeFact);
  const byId = new Map(all.map((f) => [String(f.id), f]));
  const projection = projectCanon(all, cursor);

  // ① 死人复活
  for (const dead of all) {
    if (!isAlivePredicate(dead.predicate) || !isDeadValue(dead.value)) continue;
    if (dead.status !== 'established') continue;
    for (const act of all) {
      if (String(act.id) === String(dead.id)) continue;
      if (String(act.subject || act.entity_name) !== String(dead.subject || dead.entity_name)) continue;
      if (act.status !== 'established') continue;
      if (isAlivePredicate(act.predicate) && isAliveValue(act.value) && sameOrLaterWindow(act, dead)) {
        out.push(classifyConflict({
          code: 'DECEASED_THEN_ACTIVE',
          subject: dead.subject || dead.entity_name,
          reason: `「${dead.subject || dead.entity_name}」已被判定为死亡（事实 #${dead.id}），却又存在存活/在场的事实 #${act.id}（${act.predicate}=${act.value}）`,
          evidence: { dead_fact: dead.id, active_fact: act.id, dead_from: dead.effective_from, active_from: act.effective_from },
        }));
      }
    }
  }

  // ③ planned 当 established（调用方给出"正文里出现的计划性措辞"或提案变更时）
  for (const item of opts.plannedUsedAsEstablished || []) {
    const f = byId.get(String(item));
    if (!f) continue;
    out.push(classifyConflict({
      code: 'PLANNED_AS_ESTABLISHED',
      reason: `事实 #${f.id}（${f.subject}·${f.predicate}）的状态是 planned（只是安排），却被当成已发生使用`,
      evidence: { fact: f.id, status: f.status },
    }));
  }

  // ④ 已撤回的事实仍在被引用
  for (const item of opts.referenced || []) {
    const f = byId.get(String(item));
    if (!f) continue;
    if (f.status === 'retracted' || f.status === 'superseded' || f.superseded_by) {
      out.push(classifyConflict({
        code: 'SUPERSEDED_CANON_IN_USE',
        reason: `事实 #${f.id}（${f.subject}·${f.predicate}）已${f.status === 'retracted' ? '撤回' : '被取代'}，仍被本次变更引用`,
        evidence: { fact: f.id, status: f.status, superseded_by: f.superseded_by },
      }));
    }
  }

  // ⑤ / ⑥ 同一键在同一时点出现两个不同值
  const specificKeys = new Set(out.filter((c) => c.code === 'DECEASED_THEN_ACTIVE')
    .map((c) => `${c.subject}::生死`));
  const groups = new Map();
  for (const f of projection.canon) {
    const key = factKeyOf(f);
    const list = groups.get(key);
    if (list) list.push(f); else groups.set(key, [f]);
  }
  for (const [key, list] of groups) {
    const values = new Map();
    for (const f of list) {
      const v = String(f.value || '').trim();
      if (!values.has(v)) values.set(v, []);
      values.get(v).push(f);
    }
    if (values.size <= 1) continue;
    const itemConflict = list.some((f) => isItemPredicate(f.predicate));
    // 泛化的取值冲突让位给更具体的诊断（死人复活 / 物品状态矛盾），避免同一对事实报两次。
    if (!itemConflict && specificKeys.has(key)) continue;
    out.push(classifyConflict({
      code: itemConflict ? 'ITEM_STATE_CONTRADICTION' : 'FACT_VALUE_CONFLICT',
      subject: list[0].subject || list[0].entity_name,
      reason: `同一时点上「${list[0].subject || list[0].entity_name}·${list[0].predicate}」有 ${values.size} 个不同取值：${[...values.keys()].map((v) => `「${v}」(#${values.get(v).map((f) => f.id).join(',')})`).join(' / ')}`,
      evidence: { key, values: Object.fromEntries([...values].map(([v, fs]) => [v, fs.map((f) => f.id)])) },
    }));
  }
  return out;
}

function sameOrLaterWindow(later, earlier) {
  // 判据：later 的生效窗口不早于 earlier。
  // （曾把方向写反，结果是「死人复活」这条永远不触发——而它恰恰是最该报的一条。）
  return num(later.effective_from) >= num(earlier.effective_from);
}

const DEAD_WORDS = ['死', '亡', '殁', '逝', '身亡', '已死', '遇害', '殉', 'dead', 'deceased', 'killed'];
const ALIVE_WORDS = ['活', '在场', '出现', '现身', '生还', '存活', 'alive', 'present', 'appears'];

function isAlivePredicate(predicate) {
  const p = String(predicate || '').toLowerCase();
  return /life|alive|存活|生死|状态|status|present|在场/.test(p);
}
function isDeadValue(value) {
  const v = String(value || '').toLowerCase();
  return DEAD_WORDS.some((w) => v.includes(w));
}
function isAliveValue(value) {
  const v = String(value || '').toLowerCase();
  return ALIVE_WORDS.some((w) => v.includes(w));
}
function isItemPredicate(predicate) {
  return /item|物品|持有|归属|位置|存在|损毁|状态/.test(String(predicate || ''));
}

/**
 * 正典切片：给上下文层用的一行文本。
 * 只输出 established 且在当前窗口内的事实；planned 单独一行提示，避免模型混用。
 */
export function renderCanonLines(projection, { maxItems = 40, maxChars = 1600 } = {}) {
  const lines = [];
  for (const f of projection.canon.slice(0, maxItems)) {
    const who = f.subject || f.entity_name || '';
    lines.push(`${who}｜${f.predicate}：${f.value}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const planned = projection.planned.slice(0, 10).map((f) => `${f.subject || f.entity_name}｜${f.predicate}（第 ${ordinal(f.effective_from)} 章起）`);
  return { canon_text: text, planned_text: planned.join('\n'), canon_count: projection.canon.length, planned_count: projection.planned.length };
}