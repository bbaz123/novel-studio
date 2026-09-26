/**
 * 确定性故事状态内核 · 实体身份（P0：实体稳定 id / 别名与历史名 / merge · split · rename）。
 *
 * 要解决的问题：同一个角色在正文里可能叫「林晚」「晚儿」「林师姐」「林长老」——
 * 模型会把它们当成四个人，于是"她第三次出场时忽然不认识主角"。
 * 反过来，两个不同角色共用一个称呼（"师父"）时，别名解析会张冠李戴。
 *
 * 三条设计约束：
 *   ① **稳定 id 与宿主行解耦**：实体的身份由本模块管理，`ref_table/ref_id` 只是指回
 *      宿主既有行（characters / world_entries / terms…）。内核不复制宿主数据，
 *      删掉一个实体不会连带删掉角色卡。
 *   ② **改名可追踪**：旧名进 `story_entity_aliases`（kind='historical'，带 valid_to），
 *      所以"第 3 章之后大家改口叫他林长老"不会让第 2 章的"林师弟"变成无法解析的悬空引用。
 *   ③ **merge / split 必须走提案**：合并两个实体、把一个实体拆成两个，都是**破坏性**的
 *      身份变更。本模块只提供 `planMerge` / `planSplit` 产出提案负载，不直接改库。
 *
 * 匹配强度分四级（confidence 由它派生，不另设一套分数）：
 *   canonical > historical > alias > fuzzy
 */

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

/** 名称规范化：去空白、去常见中日英标点、全角转半角、小写。
 *  不做同音字归一——那需要词典，超出"确定性内核"的边界（宁可漏匹配，不可错匹配）。 */
export function normalizeName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・.,，。、"'「」『』《》()（）\[\]【】!！?？:：;；\-—_]/g, '')
    .toLowerCase();
}

export const MATCH_CONFIDENCE = { canonical: 1, historical: 0.9, alias: 0.8, fuzzy: 0.5 };
export const MATCH_STRENGTH = { canonical: 4, historical: 3, alias: 2, fuzzy: 1 };

/**
 * 建立别名索引。
 * 冲突处理是**这里的核心**：同一个规范化名称映射到多个实体时，不能静默取一个——
 * 那正是"师父"张冠李戴的成因。冲突会被记录在 `conflicts` 里，交给冲突分级处理。
 */
export function buildAliasIndex(entities = [], aliases = []) {
  const byEntity = new Map();
  for (const e of entities) byEntity.set(String(e.id), e);
  const index = new Map();      // normalized -> [{entity_id, kind, strength, valid_from, valid_to}]
  const conflicts = [];
  for (const e of entities) {
    const n = normalizeName(e.canonical_name);
    if (!n) continue;
    push(index, n, { entity_id: e.id, alias: e.canonical_name, kind: 'canonical', strength: MATCH_STRENGTH.canonical, valid_from: null, valid_to: null });
  }
  for (const a of aliases) {
    if (!byEntity.has(String(a.entity_id))) continue;   // 悬空别名：跳过，不改索引
    const n = a.normalized ? String(a.normalized) : normalizeName(a.alias);
    if (!n) continue;
    const kind = a.kind === 'historical' ? 'historical' : 'alias';
    push(index, n, {
      entity_id: a.entity_id, alias: a.alias, kind,
      strength: kind === 'historical' ? MATCH_STRENGTH.historical : MATCH_STRENGTH.alias,
      valid_from: a.valid_from === null || a.valid_from === undefined ? null : num(a.valid_from),
      valid_to: a.valid_to === null || a.valid_to === undefined ? null : num(a.valid_to),
    });
  }
  for (const [n, hits] of index) {
    const ids = new Set(hits.map((h) => String(h.entity_id)));
    if (ids.size > 1) {
      conflicts.push({
        code: 'ALIAS_COLLISION',
        level: 'high',
        normalized: n,
        entity_ids: [...ids],
        reason: `称呼「${hits[0].alias}」同时指向 ${ids.size} 个实体：${[...ids].join('、')}——正文里出现这个称呼时无法确定是谁`,
        requires_author_decision: true,
        auto_fixable: false,
      });
    }
  }
  return { index, conflicts, byEntity };
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/**
 * 解析一个称呼。
 * @returns {{entityId, matchedBy, confidence, ambiguous, candidates}|null}
 *   多个命中且强度相同 → `ambiguous: true` 并列出全部候选（不替作者选）。
 *   强度不同 → 取最强的那个（canonical 比 alias 更可信），并把其余列入 candidates。
 */
export function resolveEntity(mention, builtIndex, cursor = null) {
  const idx = builtIndex && builtIndex.index ? builtIndex : { index: builtIndex || new Map(), byEntity: new Map() };
  const n = normalizeName(mention);
  if (!n) return null;
  const rawHits = idx.index.get(n);
  if (!rawHits || !rawHits.length) return null;
  // 时间窗过滤：历史名只在它的有效区间内解析得到（valid_from/to 是 chapter_index）
  const hits = cursor
    ? rawHits.filter((h) => withinWindow(h, cursor.chapter_index))
    : rawHits;
  const use = hits.length ? hits : rawHits;
  const best = Math.max(...use.map((h) => h.strength));
  const top = use.filter((h) => h.strength === best);
  const topIds = [...new Set(top.map((h) => String(h.entity_id)))];
  const matchedBy = top[0].kind;
  const entity = idx.byEntity.get(String(top[0].entity_id)) || null;
  return {
    entityId: top[0].entity_id,
    entityName: entity ? entity.canonical_name : '',
    matchedBy,
    confidence: MATCH_CONFIDENCE[matchedBy] ?? 0.5,
    ambiguous: topIds.length > 1,
    candidates: [...new Set(use.map((h) => h.entity_id))],
  };
}

function withinWindow(h, chapterIndex) {
  if (h.valid_from !== null && chapterIndex < h.valid_from) return false;
  if (h.valid_to !== null && chapterIndex >= h.valid_to) return false;
  return true;
}

/** 从一段正文里找出所有已知实体的提及（最长优先，避免"林"吃掉"林晚"）。 */
export function findMentions(text, builtIndex, cursor = null) {
  const body = String(text || '');
  const idx = builtIndex && builtIndex.index ? builtIndex : { index: builtIndex || new Map(), byEntity: new Map() };
  const names = [...idx.index.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length || !body) return [];
  const normalizedBody = normalizeName(body);
  const out = [];
  const claimed = [];
  for (const n of names) {
    let from = 0;
    for (;;) {
      const at = normalizedBody.indexOf(n, from);
      if (at < 0) break;
      from = at + n.length;
      if (claimed.some((c) => at < c.end && at + n.length > c.start)) continue;
      claimed.push({ start: at, end: at + n.length });
      const hit = resolveEntity(n, idx, cursor);
      out.push({ at, normalized: n, ...(hit || {}) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 实体冲突：两个**不同**实体挂了同一个宿主行（ref_table+ref_id），
 * 或同一作品里存在归一化后完全相同的正名（重复登记）。
 * 这两类都属于"应合并但没合并"，与别名碰撞（一个称呼指向多个实体）是不同的问题。
 */
export function detectEntityConflicts(entities = [], aliases = []) {
  const out = [];
  const byRef = new Map();
  const byName = new Map();
  for (const e of entities) {
    if (e.ref_table && e.ref_id !== null && e.ref_id !== undefined) {
      const key = `${e.ref_table}#${e.ref_id}`;
      const prev = byRef.get(key);
      if (prev) {
        out.push({
          code: 'ENTITY_SAME_REF', level: 'high', entity_ids: [prev.id, e.id],
          reason: `实体 #${prev.id}（${prev.canonical_name}）与 #${e.id}（${e.canonical_name}）指向同一条 ${e.ref_table}#${e.ref_id}，应合并`,
          requires_author_decision: true, auto_fixable: false,
        });
      } else byRef.set(key, e);
    }
    const n = normalizeName(e.canonical_name);
    if (!n) continue;
    const prev = byName.get(n);
    if (prev && String(prev.id) !== String(e.id)) {
      out.push({
        code: 'ENTITY_DUPLICATE_NAME', level: 'high', entity_ids: [prev.id, e.id],
        reason: `实体 #${prev.id} 与 #${e.id} 的正名归一化后相同（${e.canonical_name}）`,
        requires_author_decision: true, auto_fixable: false,
      });
    } else byName.set(n, e);
  }
  return [...out, ...buildAliasIndex(entities, aliases).conflicts];
}

/**
 * 合并计划（**不执行**）：产出提案负载，由 proposal.mjs 走复核 → 快照 → 原子应用。
 * 合并语义：把 `fromIds` 的别名与历史名全部挂到 `intoId`，被合并实体的 status='merged'、
 * merged_into=intoId。**不删除任何行**——删除会让历史正文里的引用失去解析目标。
 */
export function planMerge(intoId, fromIds = [], entities = [], aliases = []) {
  const ids = fromIds.map(String);
  const into = entities.find((e) => String(e.id) === String(intoId));
  if (!into) throw new Error(`planMerge: 目标实体 #${intoId} 不存在`);
  const movable = aliases.filter((a) => ids.includes(String(a.entity_id)));
  const missing = ids.filter((id) => !entities.some((e) => String(e.id) === id));
  if (missing.length) throw new Error(`planMerge: 被合并实体不存在：${missing.join('、')}`);
  return {
    kind: 'entity_merge',
    into: Number(intoId),
    from: ids.map(Number),
    alias_moves: movable.map((a) => ({ alias: a.alias, kind: a.kind || 'alias', from: Number(a.entity_id) })),
    reason: `把 ${ids.length} 个实体并入 #${intoId}（${into.canonical_name}），别名与历史名一并迁移`,
    destructive: true,
  };
}

/**
 * 拆分计划（**不执行**）：从 `fromId` 拆出一个新实体 `newName`，把指定的别名/正典事实迁过去。
 * 明确登记 `facts` 与 `aliases` 的归属，避免拆分后"事实留在旧实体、称呼跟着新实体"的错配。
 */
export function planSplit(fromId, newName, { aliases = [], factIds = [] } = {}, entities = []) {
  const from = entities.find((e) => String(e.id) === String(fromId));
  if (!from) throw new Error(`planSplit: 源实体 #${fromId} 不存在`);
  if (!normalizeName(newName)) throw new Error('planSplit: 新实体名称不能为空');
  return {
    kind: 'entity_split',
    from: Number(fromId),
    new_name: String(newName),
    aliases: aliases.map((a) => String(a)),
    fact_ids: factIds.map((f) => Number(f)),
    reason: `从 #${fromId}（${from.canonical_name}）拆出新实体「${newName}」`,
    destructive: true,
  };
}

/** 改名：旧名自动降为历史别名（带 valid_to），新名成为正名。 */
export function planRename(entityId, newName, { atChapterIndex = null } = {}, entities = []) {
  const e = entities.find((x) => String(x.id) === String(entityId));
  if (!e) throw new Error(`planRename: 实体 #${entityId} 不存在`);
  if (!normalizeName(newName)) throw new Error('planRename: 新名称不能为空');
  return {
    kind: 'entity_rename',
    entity: Number(entityId),
    from_name: e.canonical_name,
    to_name: String(newName),
    at_chapter_index: atChapterIndex === null ? null : num(atChapterIndex),
    reason: `实体 #${entityId} 由「${e.canonical_name}」改名为「${newName}」，旧名保留为历史别名`,
    destructive: false,
  };
}