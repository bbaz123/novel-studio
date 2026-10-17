/**
 * 时态故事状态 · 稳定实体身份（S05，修 F09）。
 *
 * 为什么要有这一层：`compat.mjs` 的旧字段投影过去是**按名称**关联的 ——
 *   `UPDATE characters … WHERE work_id = ? AND name = ?`
 *   `JOIN characters a ON a.name = ? AND b.name = ?`
 * 于是「作者把"王师傅"改成"老王"」会**丢投影**，而「两个不同角色同名」会**把状态写到一起**（F09）。
 * 本模块给出与名称解耦的稳定标识，并强制把"找不到 / 找到多个"如实报出来，**绝不猜**。
 *
 * 三条纪律：
 *   ① **改名不改身份**：身份来自 `story_entities.id`（canonical），名称只是当下一层展示文本；
 *   ② **同名不合并**：解析结果只有 unique / missing / ambiguous 三态，ambiguous 一律交作者处置；
 *   ③ **不改旧数据**：v1 事件与事件哈希原样保留；这里只提供"名字 → 身份"的解析与 v2 引用编码。
 *
 * 依赖注入：`db` 由调用方传入（与 compat.mjs 一致的风格），便于隔离库测试。
 */

/** 名称规范化：只用于**比较**，永远不落库覆盖作者原文。 */
export function normalizeEntityName(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 稳定身份的外部表示（写进 v2 事件 key 的形态）。与自增 id 绑定，改名不会变。 */
export const ENTITY_UID_RE = /^ent:([1-9][0-9]{0,17})$/;

export function entityUidOf(entityId) {
  const n = Number(entityId);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError('INVALID_ENTITY_ID');
  return `ent:${n}`;
}

export function parseEntityUid(uid) {
  const m = ENTITY_UID_RE.exec(String(uid == null ? '' : uid).trim());
  if (!m) throw new TypeError('INVALID_ENTITY_UID');
  return Number(m[1]);
}

/**
 * 解析一个名称到稳定身份。
 *
 * @returns {{status:'unique'|'missing'|'ambiguous', entityId:number|null, uid:string|null, candidates:Array, via:string|null}}
 *   · unique    —— 恰好一个候选，可以安全使用；
 *   · missing   —— 没有任何候选（可能是新角色，交作者/抽取流程建实体）；
 *   · ambiguous —— 多于一个候选，**必须交作者**，绝不自动择一（这就是"同名不误合并"）。
 */
export function resolveEntity(db, { workId, name, chapterIndex = null } = {}) {
  const w = Number(workId) || 0;
  const norm = normalizeEntityName(name);
  if (!w) throw new TypeError('MISSING_WORK_ID');
  if (!norm) return { status: 'missing', entityId: null, uid: null, candidates: [], via: null };

  // 候选来源 ①：规范名（只算 still-active 的实体；merged_into 指向别人的算作被合并）
  const byCanonical = db.prepare(
    `SELECT id, canonical_name, status, merged_into, renamed_to
       FROM story_entities
      WHERE work_id = ? AND lower(trim(canonical_name)) = ?`,
  ).all(w, norm);

  // 候选来源 ②：别名表（valid_from/valid_to 是 chapter_index 区间，NULL = 无界）
  const byAlias = db.prepare(
    `SELECT a.entity_id AS id, a.alias AS canonical_name, s.status, s.merged_into, s.renamed_to, a.valid_from, a.valid_to
       FROM story_entity_aliases a
       JOIN story_entities s ON s.id = a.entity_id
      WHERE a.work_id = ? AND a.normalized = ?`,
  ).all(w, norm);

  // 别名必须落在本章区间内才可用于**解析**（否则等于拿未来的改名解释过去的事件）。
  const aliasInRange = byAlias.filter((r) => {
    if (chapterIndex === null || chapterIndex === undefined) return true;
    const from = r.valid_from === null || r.valid_from === undefined ? -Infinity : Number(r.valid_from);
    const to = r.valid_to === null || r.valid_to === undefined ? Infinity : Number(r.valid_to);
    return Number(chapterIndex) >= from && Number(chapterIndex) <= to;
  });

  // 合并/改名的处理：merged_into 指向存活实体时，身份归到那一头；renamed_to 同理。
  // 注意：这两列不改变**事件**的语义，只影响"这个名字现在代表谁"。
  const canonicalize = (row) => {
    let id = Number(row.id);
    const seen = new Set();
    for (let hop = 0; hop < 8; hop += 1) {
      const r = db.prepare('SELECT id, merged_into, renamed_to FROM story_entities WHERE id = ?').get(id);
      if (!r) break;
      const next = Number(r.merged_into || r.renamed_to || 0);
      if (!next || next === id || seen.has(next)) break;
      seen.add(id);
      id = next;
    }
    return id;
  };

  const ids = new Set();
  for (const row of [...byCanonical, ...aliasInRange]) ids.add(canonicalize(row));
  const candidates = [...ids].sort((a, b) => a - b);

  if (candidates.length === 0) {
    return { status: 'missing', entityId: null, uid: null, candidates: [], via: null };
  }
  if (candidates.length > 1) {
    // 同名不同实体：**不猜**。调用方必须把它交给作者队列。
    return { status: 'ambiguous', entityId: null, uid: null, candidates, via: null };
  }
  const only = candidates[0];
  const via = byCanonical.some((r) => canonicalize(r) === only) ? 'canonical_name' : 'alias';
  return { status: 'unique', entityId: only, uid: entityUidOf(only), candidates, via };
}

/**
 * 显式绑定：把某个旧表行（characters / character_relations）关联到稳定身份。
 *
 * 为什么单独一张映射：`story_entities.ref_table / ref_id` 已经预留了这个语义，
 * 但历史数据里大量实体**没有**回填。S05 只做"能确定性回填的回填"，
 * 回填不了的留在 dry-run 的阻断清单里（S16 才正式切换旧作品的正式世界线）。
 */
export function linkLegacyRef(db, { workId, entityId, refTable, refId } = {}) {
  const w = Number(workId) || 0;
  const eid = Number(entityId) || 0;
  if (!w || !eid) throw new TypeError('MISSING_WORK_ID_OR_ENTITY');
  const table = String(refTable || '');
  if (!['characters', 'character_relations'].includes(table)) throw new TypeError('INVALID_REF_TABLE');
  const rid = Number(refId) || 0;
  if (!rid) throw new TypeError('INVALID_REF_ID');
  const info = db.prepare(
    `UPDATE story_entities SET ref_table = ?, ref_id = ?, updated_at = ?
      WHERE id = ? AND work_id = ? AND (ref_table = '' OR ref_id IS NULL)`,
  ).run(table, rid, new Date().toISOString(), eid, w);
  return { ok: info.changes === 1, changed: info.changes };
}

/** 反向查询：旧表行 → 稳定身份（没有绑定就返回 null，不按名称兜底）。 */
export function entityOfLegacyRef(db, { workId, refTable, refId } = {}) {
  const row = db.prepare(
    `SELECT id, canonical_name FROM story_entities
      WHERE work_id = ? AND ref_table = ? AND ref_id = ? LIMIT 1`,
  ).get(Number(workId) || 0, String(refTable || ''), Number(refId) || 0);
  if (!row) return null;
  return { entityId: Number(row.id), uid: entityUidOf(row.id), canonicalName: row.canonical_name };
}

/**
 * 关系方向：v2 明确规定"谁持有、谁被引用"，避免 A→B 与 B→A 被当成同一条。
 *
 * 旧数据只有 from/to 两个名字，既没有方向语义也没有身份；这里给出确定性规则：
 *   · 方向以 **from → to** 为规范顺序，比较时先按 uid 排序再比对，保证 (A,B) 与 (B,A) 不相等；
 *   · 自反关系（from === to）单独标记，便于校验层拒绝或提示。
 */
export const RELATION_KIND = Object.freeze({
  FORWARD: 'forward',
  INVERSE: 'inverse',
  SELF: 'self',
});

export function canonicalRelation({ fromUid, toUid } = {}) {
  const from = String(fromUid || '').trim();
  const to = String(toUid || '').trim();
  if (!from || !to) throw new TypeError('MISSING_RELATION_ENDS');
  parseEntityUid(from);
  parseEntityUid(to);
  if (from === to) return { kind: RELATION_KIND.SELF, fromUid: from, toUid: to, key: `rel:self:${from}` };
  const [a, b] = [from, to].sort();
  const kind = from === a ? RELATION_KIND.FORWARD : RELATION_KIND.INVERSE;
  return { kind, fromUid: from, toUid: to, key: `rel:${a}->${b}` };
}

/** (A,B) 与 (B,A) 必须落到同一个 key 上 —— 方向另存，不能靠"字符串不同"隐式表达。 */
export function relationPairKey(fromUid, toUid) {
  return canonicalRelation({ fromUid, toUid }).key;
}
