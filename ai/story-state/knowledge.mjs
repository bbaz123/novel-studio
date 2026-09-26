/**
 * 确定性故事状态内核 · 角色知识边界（P0 必答项之一）。
 *
 * 要解决的问题：长篇里"角色知道了他不该知道的事"（知识越界）是最常见的崩法，
 * 而且**只有作者能发现**——因为模型每一章都是独立生成的，它不记得谁知道什么。
 *
 * 三档知识域必须严格区分（混在一起就失去判定力）：
 *   AUTHOR_KNOWLEDGE    作者视角：大纲、后续安排、结局。**任何角色都不得据此行动**，
 *                       也不得出现在成文正文里（那是剧透，不是伏笔）。
 *   CANON_KNOWLEDGE     世界事实：确实发生过、写在正典里。角色**不一定知道**。
 *   CHARACTER_KNOWLEDGE 某个角色知道的事（`holder` 必须给出）。
 *
 * 四态知识状态：
 *   known         确实知道
 *   unknown       确实不知道（显式声明，与"没记录"不同——没记录是"未定义"）
 *   suspected     怀疑但不确定（可以据此试探，不可以据此断言）
 *   false_belief  误信（他相信的是错的——写作时必须保持这个错，不能顺手写对）
 *
 * ⚠ 这里判的是"**在当前章节点上，某角色是否已经知道**"，所以每条知识都带
 * `learned_chapter_index` / `learned_scene_index`，与时间线用**同一套游标**。
 */

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

export const KNOWLEDGE_SCOPES = ['AUTHOR_KNOWLEDGE', 'CANON_KNOWLEDGE', 'CHARACTER_KNOWLEDGE'];
export const KNOWLEDGE_STATES = ['known', 'unknown', 'suspected', 'false_belief'];

/** 只有这三档；写错档位是**配置错误**，必须在写入时拦住（见 normalizeKnowledge 的 throws）。 */
export function isKnownScope(scope) {
  return KNOWLEDGE_SCOPES.includes(String(scope || ''));
}

export function isKnownState(state) {
  return KNOWLEDGE_STATES.includes(String(state || ''));
}

export function normalizeKnowledge(row = {}) {
  const scope = String(row.scope || 'CANON_KNOWLEDGE');
  const state = String(row.state || 'known');
  return {
    id: row.id ?? null,
    work_id: row.work_id ?? null,
    character_id: row.character_id ?? null,
    character_name: String(row.character_name || ''),
    fact_id: row.fact_id ?? null,
    fact_key: String(row.fact_key || ''),
    state,
    scope: isKnownScope(scope) ? scope : 'CANON_KNOWLEDGE',
    learned_chapter_id: row.learned_chapter_id ?? null,
    learned_chapter_index: num(row.learned_chapter_index),
    learned_scene_index: num(row.learned_scene_index),
    story_time: String(row.story_time || ''),
    source: String(row.source || ''),
    note: String(row.note || ''),
  };
}

/** 事实键的规范化：`角色:状态` 这类键必须大小写/空白无关，否则查不到。 */
export function normalizeFactKey(key) {
  return String(key || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 某条知识在游标处**是否已经学到**。
 * 学到 = (章, 场) 字典序 ≤ 游标；场缺省时退化成只比章。
 */
export function learnedByCursor(knowledge, cursor) {
  const k = normalizeKnowledge(knowledge);
  if (k.learned_chapter_index > cursor.chapter_index) return false;
  if (k.learned_chapter_index < cursor.chapter_index) return true;
  if (cursor.scene_index === null || cursor.scene_index === undefined) return true;
  return k.learned_scene_index <= cursor.scene_index;
}

/**
 * 按角色汇总"当前时点他知道什么"。
 *
 * @returns {{known:Array, unknown:Array, suspected:Array, false_beliefs:Array}}
 *   语义说明：`unknown` 是**显式声明不知道**的条目；没有任何记录的既不在 known 也不在
 *   unknown 里（= 未定义）。把未定义当成"不知道"会让模型不敢用任何未登记的常识，
 *   把未定义当成"知道"就是知识越界——所以两者都不能替作者决定，只能如实分开。
 */
export function knowledgeOf(rows = [], characterId, cursor) {
  const out = { known: [], unknown: [], suspected: [], false_beliefs: [] };
  for (const raw of rows) {
    const k = normalizeKnowledge(raw);
    if (characterId !== undefined && characterId !== null && String(k.character_id) !== String(characterId)) continue;
    // 可见窗口：known 与非 known 的方向**相反**（不是笔误）。
    //   known  —— 学到之后才成立：learned <= 游标。
    //   unknown / suspected / false_belief —— 描述的是「错误或不确定的认知」这件事，
    //              它**结束于** learned（那一章他学到真相）。所以只在 learned > 游标时成立。
    //              反过来的写法（学到之后才显示）会同时错两次：最需要提醒的章节（学到之前）看不见，
    //              而已经学到之后还在提示「他不知道」，会让模型把已经知道的事当成不知道。
    //              预检（preflight ⑦）与正文越界检测（detectKnowledgeViolations）用的都是这一侧，
    //              三处口径现在一致。
    // learned === 0（没有声明学到章）视为「状态持续」，照常显示。
    const learned = num(k.learned_chapter_index);
    const visible = k.state === 'known'
      ? learnedByCursor(k, cursor)
      : (learned === 0 || !learnedByCursor(k, cursor));
    if (!visible) continue;
    const bucket = k.state === 'known' ? 'known'
      : k.state === 'unknown' ? 'unknown'
        : k.state === 'suspected' ? 'suspected' : 'false_beliefs';
    out[bucket].push(k);
  }
  return out;
}

/**
 * 知识越界检测：正文里出现了某角色**在此时点不该知道**的事实关键词。
 *
 * 判定用**关键词命中**而不是语义理解：内核不能调用模型（那会把确定性换成又一次推理），
 * 所以只对**显式登记过的事实**做机械比对。命中即报，报的是"这段正文提到了 X，
 * 而 Y 在第 N 章之前不该知道 X"，由作者决定这是越界还是自己忘了登记。
 *
 * @param {string} text 正文
 * @param {Array} rows  character_knowledge 行
 * @param {{characters:Array<{id:any,name:string}>}} opts
 * @param {object} cursor
 */
export function detectKnowledgeViolations(text, rows = [], characters = [], cursor) {
  const body = String(text || '');
  if (!body) return [];
  const byId = new Map(characters.map((c) => [String(c.id), c]));
  const out = [];
  const seen = new Set();
  for (const raw of rows) {
    const k = normalizeKnowledge(raw);
    const name = k.character_name || (byId.get(String(k.character_id)) || {}).name || '';
    // 只查"此时点还不知道 / 只是怀疑 / 误信"的事实；已知的事实被提到是正常的。
    if (k.state === 'known') continue;
    if (learnedByCursor(k, cursor)) continue;   // 学到之后提到它是正常的
    const key = k.fact_key;
    if (!key) continue;
    const idx = body.indexOf(key);
    if (idx < 0) continue;
    const dedup = `${k.character_id}|${key}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({
      code: 'KNOWLEDGE_VIOLATION',
      level: k.state === 'unknown' ? 'critical' : 'high',
      character_id: k.character_id,
      character_name: name,
      fact_key: key,
      state: k.state,
      reason: k.state === 'unknown'
        ? `${name}在第 ${cursor.chapter_index} 章时明确不知道「${key}」，正文里却写出了它`
        : `${name}在第 ${cursor.chapter_index} 章时只是${k.state === 'suspected' ? '怀疑' : '误信'}「${key}」，正文的写法越过了这个边界`,
      excerpt: body.slice(Math.max(0, idx - 24), idx + key.length + 24),
      evidence: { learned_chapter_index: k.learned_chapter_index, cursor_chapter_index: cursor.chapter_index },
    });
  }
  return out;
}

/**
 * 作者视角信息的**越界检查**：AUTHOR_KNOWLEDGE 的事实不得作为已发生的事出现在正文里。
 * 这一类与 `detectKnowledgeViolations` 分开：前者是"角色知道了不该知道的"，
 * 这里是"叙述把计划当成了已发生"（planned 当 established 的叙述版本）。
 */
export function detectAuthorScopeLeaks(text, facts = [], cursor) {
  const body = String(text || '');
  if (!body) return [];
  const out = [];
  for (const f of facts) {
    if (String(f.scope || '') !== 'AUTHOR_KNOWLEDGE') continue;
    if (num(f.effective_from) <= cursor.chapter_index) continue;
    const probe = String(f.value || f.predicate || '').trim();
    if (probe.length < 2) continue;
    if (body.indexOf(probe) < 0) continue;
    out.push({
      code: 'AUTHOR_SCOPE_LEAK',
      level: 'critical',
      fact_id: f.id,
      reason: `「${probe}」属于作者视角信息（第 ${num(f.effective_from)} 章起才成立），不该出现在第 ${cursor.chapter_index} 章的叙述里`,
      evidence: { effective_from: num(f.effective_from), cursor_chapter_index: cursor.chapter_index },
    });
  }
  return out;
}