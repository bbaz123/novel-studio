/**
 * 时态故事状态 · 事件与绑定（story_state_events / story_chapter_bindings）。
 *
 * 事件是**类型化**的：落库前必须走 schema.normalizeEvent（白名单域 + 前置条件 + 证据锚点）。
 * 绑定是正文修订与事件集的唯一关联：pending = 待作者确认的提案组；valid = 已认可进提交。
 *
 * 绑定可复用同一文本内容的新修订（纯格式变化：revision 变了但 text_hash 不变），
 * 校验规则是「事件所属修订与该章文本内容一致」而非「同一个 revision 行」——
 * 这样"只改格式不重跑语义分析"不需要复制事件，也不会把旧稿事件混进新稿。
 */
import { db, inTransaction, withTransaction } from '../../../db.js';
import { prep } from './stmt.mjs';
import { hashEvent, hashJson, normalizeEvent, normalizeOp, sha16, TEMPORAL_SCHEMA_VERSION } from './schema.mjs';
import { getRevision, revisionsByIds } from './revision-store.mjs';

const now = () => new Date().toISOString();
const str = (v) => (v === null || v === undefined ? '' : String(v));

export function getEvent(id) {
  const row = prep('SELECT * FROM story_state_events WHERE id = ?').get(String(id || ''));
  return row ? publicEvent(row) : null;
}

export function publicEvent(row) {
  let ops = [];
  try { ops = JSON.parse(row.ops_json); } catch { ops = []; }
  let evidence = [];
  try { evidence = JSON.parse(row.evidence_json); } catch { evidence = []; }
  let cursor = {};
  try { cursor = JSON.parse(row.cursor_json); } catch { cursor = {}; }
  let storyTime = null;
  try { storyTime = JSON.parse(row.story_time_json); } catch { storyTime = null; }
  return {
    id: String(row.id), work_id: Number(row.work_id), chapter_id: Number(row.chapter_id),
    revision_id: String(row.revision_id), cursor, story_time: storyTime,
    ops, evidence, schema_version: String(row.schema_version), event_hash: String(row.event_hash || ''),
    created_at: row.created_at,
  };
}

/**
 * 落库一批已归一化事件（调用方负责在事务内）。
 * @param {Array} events normalizeEvent 的产物
 * @returns {Array<object>} 落库后的事件行（publicEvent 形状）
 */
export function insertEvents(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return [];
  // 先全量校验（任一非法 → 整批拒绝，不落半批），再批量落库：
  // 旧实现每个事件 4 次查询（修订/存在性/插入/回读），长批次会线性放大。
  const revisionIds = [...new Set(list.map((e) => String((e && e.revision_id) || '')))];
  const revisions = revisionsByIds(revisionIds);
  const prepared = [];
  for (const event of list) {
    if (!event || !event.revision_id) throw new Error('insertEvents: 事件缺少 revision_id');
    const revision = revisions.get(String(event.revision_id)) || null;
    if (!revision || Number(revision.chapter_id) !== Number(event.chapter_id) || Number(revision.work_id) !== Number(event.work_id)) {
      throw new Error(`insertEvents: 修订 ${event.revision_id} 与事件章节不匹配`);
    }
    const eventHash = hashEvent(event);
    const id = 'evt_' + sha16(`${event.work_id}|${event.chapter_id}|${event.revision_id}|${hashJson(event.ops.map((op) => ({ type: op.type, cell: op.cell, expected: op.expected, value: op.value ?? null })))}|${eventHash}`);
    prepared.push({
      id, eventHash,
      work_id: Number(event.work_id), chapter_id: Number(event.chapter_id), revision_id: String(event.revision_id),
      cursorJson: JSON.stringify(event.cursor),
      storyTimeJson: JSON.stringify(event.story_time),
      opsJson: JSON.stringify(event.ops.map((op) => ({ type: op.type, cell: op.cell, expected: op.expected, ...(op.type === 'set' ? { value: op.value } : {}) }))),
      evidenceJson: JSON.stringify(event.evidence),
    });
  }
  const existing = eventsByIds(prepared.map((p) => p.id));
  const ts = now();
  // 批内同 id（同内容事件重复提交）保持旧实现的静默去重：插入唯一一次，返回时按输入顺序各自取同一行。
  const uniqueById = new Map();
  for (const p of prepared) if (!uniqueById.has(String(p.id))) uniqueById.set(String(p.id), p);
  const missing = [...uniqueById.values()].filter((p) => !existing.has(String(p.id)));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const p of chunk) {
      params.push(p.id, p.work_id, p.revision_id, p.chapter_id, p.cursorJson, p.storyTimeJson, p.opsJson, p.evidenceJson, TEMPORAL_SCHEMA_VERSION, p.eventHash, ts);
    }
    db.prepare(`INSERT INTO story_state_events
        (id, work_id, revision_id, chapter_id, cursor_json, story_time_json, ops_json, evidence_json, schema_version, event_hash, created_at)
        VALUES ${values}`).run(...params);
  }
  // 返回与 publicEvent 完全一致的形状：已有行按数据库原样，新行按同一落库 JSON 构造（免回查）。
  const constructed = new Map();
  for (const p of missing) constructed.set(String(p.id), publicEvent({
    id: p.id, work_id: p.work_id, revision_id: p.revision_id, chapter_id: p.chapter_id,
    cursor_json: p.cursorJson, story_time_json: p.storyTimeJson, ops_json: p.opsJson, evidence_json: p.evidenceJson,
    schema_version: TEMPORAL_SCHEMA_VERSION, event_hash: p.eventHash, created_at: ts,
  }));
  return prepared.map((p) => existing.get(String(p.id)) || constructed.get(String(p.id)));
}

/** 便捷入口：从原始事件数组归一化 + 落库。 */
export function createEvents(rawEvents, { workId, chapterId, revisionId } = {}) {
  const normalized = (rawEvents || []).map((e) => normalizeEvent(e, { workId, chapterId, revisionId }));
  return insertEvents(normalized);
}

export function getBinding(id) {
  const row = prep('SELECT * FROM story_chapter_bindings WHERE id = ?').get(String(id || ''));
  return row ? publicBinding(row) : null;
}

export function publicBinding(row) {
  const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
  return {
    id: String(row.id), work_id: Number(row.work_id), chapter_id: Number(row.chapter_id),
    revision_id: String(row.revision_id),
    event_ids: parse(row.event_ids_json, []),
    input_snapshot_id: row.input_snapshot_id ? String(row.input_snapshot_id) : null,
    output_snapshot_id: row.output_snapshot_id ? String(row.output_snapshot_id) : null,
    contract_ref: parse(row.contract_ref_json, {}),
    appearances: parse(row.appearances_json, []),
    validation: parse(row.validation_json, {}),
    validity: String(row.validity),
    story_time: parse(row.story_time_json, null),
    created_at: row.created_at,
  };
}

export function createBinding({
  workId, chapterId, revisionId, eventIds = [], validity = 'pending',
  inputSnapshotId = null, outputSnapshotId = null, validation = {}, appearances = [], contractRef = {}, storyTime = null,
} = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('createBinding: 缺少 work_id 或 chapter_id');
  const eventIdsJson = JSON.stringify((eventIds || []).map(String));
  const material = `${w}|${c}|${revisionId}|${eventIdsJson}|${validity}|${str(inputSnapshotId)}|${str(outputSnapshotId)}|${JSON.stringify(validation || {})}`;
  const id = 'bnd_' + sha16(material);
  const existing = getBinding(id);
  if (existing) return existing;
  prep(`INSERT INTO story_chapter_bindings
      (id, work_id, chapter_id, revision_id, event_ids_json, input_snapshot_id, output_snapshot_id,
       contract_ref_json, appearances_json, validation_json, validity, story_time_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, w, c, String(revisionId), eventIdsJson,
      inputSnapshotId ? String(inputSnapshotId) : null,
      outputSnapshotId ? String(outputSnapshotId) : null,
      JSON.stringify(contractRef || {}), JSON.stringify(appearances || []),
      JSON.stringify(validation || {}), String(validity), JSON.stringify(storyTime), now());
  return getBinding(id);
}

/**
 * 变更绑定状态（指针可变，记录不删）。valid 必须带 output_snapshot_id（表级 CHECK 兜底）。
 */
export function setBindingValidity(id, validity, patch = {}) {
  const row = prep('SELECT * FROM story_chapter_bindings WHERE id = ?').get(String(id || ''));
  if (!row) return null;
  const next = {
    validity: String(validity),
    output_snapshot_id: patch.outputSnapshotId !== undefined ? patch.outputSnapshotId : (row.output_snapshot_id || null),
    validation: patch.validation !== undefined ? JSON.stringify(patch.validation) : row.validation_json,
    appearances: patch.appearances !== undefined ? JSON.stringify(patch.appearances) : row.appearances_json,
    contract_ref: patch.contractRef !== undefined ? JSON.stringify(patch.contractRef) : row.contract_ref_json,
  };
  if (next.validity === 'valid' && !next.output_snapshot_id) {
    throw new Error('setBindingValidity: valid 绑定必须有 output_snapshot_id');
  }
  prep(`UPDATE story_chapter_bindings SET validity = ?, output_snapshot_id = ?, validation_json = ?, appearances_json = ?, contract_ref_json = ? WHERE id = ?`)
    .run(next.validity, next.output_snapshot_id, next.validation, next.appearances, next.contract_ref, String(id));
  return getBinding(id);
}


/**
 * 更新 pending 绑定的提案内容（分析完成后把事件集挂到待确认绑定上）。
 * 只允许 pending：已确认/已作废的绑定是审计记录，不能改。
 */
export function updateBindingProposal({ bindingId, eventIds, validation, contractRef, appearances, storyTime } = {}) {
  const row = prep('SELECT * FROM story_chapter_bindings WHERE id = ?').get(String(bindingId || ''));
  if (!row) throw new Error('UPDATE_BINDING_NOT_FOUND');
  if (String(row.validity) !== 'pending') throw new Error(`UPDATE_BINDING_NOT_PENDING:${row.validity}`);
  const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
  const nextEventIds = eventIds !== undefined ? (eventIds || []).map(String) : parse(row.event_ids_json, []).map(String);
  const nextValidation = validation !== undefined ? validation : parse(row.validation_json, {});
  const nextContract = contractRef !== undefined ? contractRef : parse(row.contract_ref_json, {});
  const nextAppearances = appearances !== undefined ? appearances : parse(row.appearances_json, []);
  const nextStoryTime = storyTime !== undefined ? storyTime : parse(row.story_time_json, null);
  prep(`UPDATE story_chapter_bindings SET event_ids_json = ?, validation_json = ?, contract_ref_json = ?, appearances_json = ?, story_time_json = ? WHERE id = ?`)
    .run(JSON.stringify(nextEventIds), JSON.stringify(nextValidation), JSON.stringify(nextContract), JSON.stringify(nextAppearances), JSON.stringify(nextStoryTime), String(bindingId));
  return getBinding(bindingId);
}
export function listBindings(workId, { chapterId = null, validity = null, limit = 50 } = {}) {
  const w = Number(workId) || 0;
  const conds = ['work_id = ?'];
  const params = [w];
  if (chapterId) { conds.push('chapter_id = ?'); params.push(Number(chapterId)); }
  if (validity) { conds.push('validity = ?'); params.push(String(validity)); }
  const rows = prep(`SELECT * FROM story_chapter_bindings WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, Math.max(1, Number(limit) || 50));
  return rows.map(publicBinding);
}

/**
 * 历史归约专用轻量绑定视图：只保留归约需要的字段，validation 保持原始 JSON 字符串
 * （stopping 诊断才按需解析）——完整 publicBinding 的 5 次 JSON.parse 在 O(N²) 读取路径上
 * 会被放大成主要开销。
 */
function liteBinding(row) {
  let eventIds = [];
  try { eventIds = JSON.parse(row.event_ids_json); } catch { eventIds = []; }
  return {
    id: String(row.id), work_id: Number(row.work_id), chapter_id: Number(row.chapter_id),
    revision_id: String(row.revision_id), event_ids: Array.isArray(eventIds) ? eventIds : [],
    validity: String(row.validity), validation_reason: String(row.validation_reason || ''),
  };
}

/** 停止原因用的 validation.reason：完整视图与轻量视图（lazy 解析）同一结论。 */
export function validationReasonOf(binding) {
  if (!binding) return '';
  if (binding.validation && typeof binding.validation === 'object') return String(binding.validation.reason || '');
  if (typeof binding.validation_reason === 'string') return binding.validation_reason;
  if (typeof binding.validation_json === 'string' && binding.validation_json) {
    try {
      const v = JSON.parse(binding.validation_json);
      return String((v && v.reason) || '');
    } catch { return ''; }
  }
  return '';
}

/** 批量读取绑定（历史归约等读取路径专用；IN 分块，避免逐章一次查询）。传入 { lite: true } 返回轻量视图。 */
export function bindingsByIds(ids = [], { lite = false } = {}) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const out = new Map();
  // 轻量路径只 SELECT 归约需要的列：不搬运 validation/appearances/story_time 等大字段。
  const liteSql = (ph) => `SELECT id, work_id, chapter_id, revision_id, event_ids_json, validity,
      json_extract(validation_json, '$.reason') AS validation_reason
    FROM story_chapter_bindings WHERE id IN (${ph})`;
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    const rows = lite
      ? db.prepare(liteSql(ph)).all(...chunk)
      : db.prepare(`SELECT * FROM story_chapter_bindings WHERE id IN (${ph})`).all(...chunk);
    for (const row of rows) {
      out.set(String(row.id), lite ? liteBinding(row) : publicBinding(row));
    }
  }
  return out;
}

/** 历史归约专用轻量事件视图：只保留 id/归属/ops（ops 仍为落库 JSON 的原样解析）。 */
function liteEvent(row) {
  let ops = [];
  try { ops = JSON.parse(row.ops_json); } catch { ops = []; }
  return {
    id: String(row.id), work_id: Number(row.work_id), chapter_id: Number(row.chapter_id),
    revision_id: String(row.revision_id), ops: Array.isArray(ops) ? ops : [],
  };
}

/** 批量读取事件（同 bindingsByIds 的纪律）。传入 { lite: true } 返回轻量视图。 */
export function eventsByIds(ids = [], { lite = false } = {}) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    const rows = lite
      ? db.prepare(`SELECT id, work_id, chapter_id, revision_id, ops_json FROM story_state_events WHERE id IN (${ph})`).all(...chunk)
      : db.prepare(`SELECT * FROM story_state_events WHERE id IN (${ph})`).all(...chunk);
    for (const row of rows) {
      out.set(String(row.id), lite ? liteEvent(row) : publicEvent(row));
    }
  }
  return out;
}

/**
 * 绑定的事件（顺序 = event_ids 顺序；ops 重新挂 _key 供 reducer 使用）。
 * cache 可选（{ events, revisions } 批量预取结果）：命中则不再逐条查库，语义与不传时一致。
 */
export function eventsOfBinding(binding, cache = null) {
  if (!binding) return [];
  return (binding.event_ids || []).map((id) => {
    const e = cache ? (cache.events.get(String(id)) || null) : getEvent(id);
    if (!e) throw new Error(`绑定引用了不存在的事件 ${id}`);
    return { ...e, ops: e.ops.map((op) => normalizeOp(op)) };
  });
}

/**
 * 校验绑定事件与正文修订的一致性：事件修订文本内容必须与绑定修订一致（text_hash 相同）。
 * 允许"同文本不同 revision"（纯格式修改不复制事件），但拒绝内容已变的旧事件混入。
 */
export function assertBindingConsistent(binding, cache = null) {
  if (!binding) throw new Error('BINDING_NOT_FOUND');
  // cache 可选：历史归约等读取路径已批量预取修订/事件，避免逐章逐事件查库。
  // 约定：传入 cache 时，缺失条目视为"不存在"（预取范围覆盖全部被引用 id）。
  const revision = cache ? (cache.revisions.get(String(binding.revision_id)) || null) : getRevision(binding.revision_id);
  if (!revision) throw new Error('BINDING_REVISION_MISSING');
  for (const eventId of binding.event_ids || []) {
    const event = cache ? (cache.events.get(String(eventId)) || null) : getEvent(eventId);
    if (!event) throw new Error('BINDING_EVENT_MISSING');
    if (Number(event.chapter_id) !== Number(binding.chapter_id) || Number(event.work_id) !== Number(binding.work_id)) {
      throw new Error('BINDING_EVENT_CHAPTER_MISMATCH');
    }
    const eventRevision = cache ? (cache.revisions.get(String(event.revision_id)) || null) : getRevision(event.revision_id);
    if (!eventRevision) throw new Error('BINDING_EVENT_REVISION_MISSING');
    if (String(eventRevision.text_hash) !== String(revision.text_hash)) {
      throw new Error(`BINDING_EVENT_TEXT_MISMATCH:${eventId}`);
    }
  }
  return { revision, events: eventsOfBinding(binding, cache) };
}

export function supersedePendingBindings(workId, chapterId, { exceptId = null } = {}) {
  const list = listBindings(workId, { chapterId, validity: 'pending', limit: 200 });
  let n = 0;
  for (const b of list) {
    if (exceptId && b.id === exceptId) continue;
    setBindingValidity(b.id, 'superseded', { validation: { ...(b.validation || {}), superseded_at: now() } });
    n += 1;
  }
  return n;
}
/**
 * ── 提交级信任覆盖（story_binding_trust）────────────────────────────────────
 * 语义：同一 binding 在不同提交里可以有不同信任结论。上游变化后由**新提交**写入
 * stale 覆盖行；旧提交没有覆盖行 → 继续按 binding 自身 validity 回放（AC-02）。
 */
export function getBindingTrust(commitId, bindingId) {
  const row = prep('SELECT * FROM story_binding_trust WHERE commit_id = ? AND binding_id = ?')
    .get(String(commitId || ''), String(bindingId || ''));
  if (!row) return null;
  let detail = {};
  try { detail = JSON.parse(row.detail_json); } catch { detail = {}; }
  return { id: String(row.id), work_id: Number(row.work_id), commit_id: String(row.commit_id), binding_id: String(row.binding_id), validity: String(row.validity), detail };
}
export function setBindingTrust({ workId, commitId, bindingId, validity, detail = {} } = {}) {
  const w = Number(workId) || 0;
  const commit = String(commitId || '');
  const binding = String(bindingId || '');
  if (!w || !commit || !binding) throw new Error('setBindingTrust: 缺少 workId / commitId / bindingId');
  const id = 'trs_' + sha16(`${commit}|${binding}`);
  prep(`INSERT INTO story_binding_trust (id, work_id, commit_id, binding_id, validity, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(commit_id, binding_id) DO UPDATE SET validity = excluded.validity, detail_json = excluded.detail_json`)
    .run(id, w, commit, binding, String(validity), JSON.stringify(detail || {}), now());
  return getBindingTrust(commit, binding);
}
/**
 * 批量写入提交级信任覆盖（与 setBindingTrust 同一语义的成批版本）。
 * 供失效计划与覆盖表复制使用——避免逐行 upsert 在长篇小说上退化成 O(N) 条语句。
 * @param {Array<{workId:number, commitId:string, bindingId:string, validity:string, detail?:object}>} rows
 * @returns {number} 实际写入/更新的行数
 */
export function setBindingTrustBulk(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  const ts = now();
  let changed = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const values = [];
    const params = [];
    for (const r of chunk) {
      const commit = String(r.commitId || '');
      const binding = String(r.bindingId || '');
      if (!commit || !binding) throw new Error('setBindingTrustBulk: 缺少 commitId / bindingId');
      values.push('(?, ?, ?, ?, ?, ?, ?)');
      params.push('trs_' + sha16(`${commit}|${binding}`), Number(r.workId) || 0, commit, binding, String(r.validity), JSON.stringify(r.detail || {}), ts);
    }
    changed += Number(db.prepare(`INSERT INTO story_binding_trust (id, work_id, commit_id, binding_id, validity, detail_json, created_at)
      VALUES ${values.join(', ')}
      ON CONFLICT(commit_id, binding_id) DO UPDATE SET validity = excluded.validity, detail_json = excluded.detail_json`).run(...params).changes) || 0;
  }
  return changed;
}
/** 某提交的完整覆盖表（binding_id → 覆盖行）。 */
export function trustOverlayOfCommit(commitId) {
  const rows = prep('SELECT * FROM story_binding_trust WHERE commit_id = ?').all(String(commitId || ''));
  const map = new Map();
  for (const row of rows) {
    let detail = {};
    try { detail = JSON.parse(row.detail_json); } catch { detail = {}; }
    map.set(String(row.binding_id), { validity: String(row.validity), detail });
  }
  return map;
}
/** 提交覆盖的轻量视图（只取 validity）：历史归约热路径不再逐行解析 detail_json。 */
export function trustValidityOfCommit(commitId) {
  const map = new Map();
  for (const row of prep('SELECT binding_id, validity FROM story_binding_trust WHERE commit_id = ?').all(String(commitId || ''))) {
    map.set(String(row.binding_id), { validity: String(row.validity) });
  }
  return map;
}
/** 把父提交的覆盖表复制进子提交（未重新验证的章节继续未验证）。 */
export function copyTrustOverlay({ workId, fromCommitId, toCommitId, exceptBindingIds = [] } = {}) {
  if (!fromCommitId) return 0;
  const skip = new Set((exceptBindingIds || []).map(String));
  const rows = prep('SELECT * FROM story_binding_trust WHERE commit_id = ?').all(String(fromCommitId));
  const write = () => {
    const out = [];
    for (const row of rows) {
      if (skip.has(String(row.binding_id))) continue;
      out.push({
        workId: Number(workId) || Number(row.work_id), commitId: toCommitId, bindingId: row.binding_id, validity: row.validity,
        detail: (() => { try { return JSON.parse(row.detail_json); } catch { return {}; } })(),
      });
    }
    setBindingTrustBulk(out);
    return out.length;
  };
  return inTransaction() ? write() : withTransaction(write);
}
/** 本章最新的"保存后待确认"绑定（用于默认 HEAD 查询判定 pending）。 */
export function latestSaveProposalBinding(workId, chapterId) {
  const rows = listBindings(workId, { chapterId, validity: 'pending', limit: 10 });
  for (const b of rows) {
    const ref = b.contract_ref || {};
    if (ref.kind === 'save_proposal') return b;
  }
  return null;
}
/** 有效结论 = 提交覆盖（若有）∪ binding 自身 validity。 */
export function effectiveValidity(overlayMap, binding) {
  if (!binding) return 'missing';
  const overlay = overlayMap && overlayMap.get(String(binding.id));
  return overlay ? overlay.validity : binding.validity;
}
/** 本章或子场景是否存在比给定修订更新的"保存后待确认"记录。 */
export function pendingSaveNewerThan(workId, chapterId, bindingRevision) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  const rows = prep(`SELECT b.* FROM story_chapter_bindings b
    JOIN chapters ch ON ch.id = b.chapter_id
    WHERE b.work_id = ? AND b.validity = 'pending' AND (b.chapter_id = ? OR ch.parent_id = ?)
    ORDER BY b.created_at DESC, b.id DESC LIMIT 5`).all(w, c, c);
  const bindingAt = String((bindingRevision && bindingRevision.created_at) || '');
  for (const row of rows) {
    const b = publicBinding(row);
    if ((b.contract_ref || {}).kind !== 'save_proposal') continue;
    const rev = getRevision(b.revision_id);
    if (!rev) continue;
    if (String(rev.created_at) > bindingAt) return b;
  }
  return null;
}

/**
 * 「保存后待确认」批量索引：一次读取作品内全部 pending 绑定（含章-父章关系与修订时间），
 * 供历史归约 / 信任报告在内存里逐章判定，避免每章一次 JOIN 查询在长篇上退化成 O(N²)。
 * 排序与 SQL 版一致（created_at DESC, id DESC）；分块（slice）对应原 LIMIT。
 */
export function pendingSaveIndex(workId, { chapterIds = null } = {}) {
  const w = Number(workId) || 0;
  const select = `SELECT b.id, b.work_id, b.chapter_id, b.revision_id, b.validity, b.created_at, b.contract_ref_json,
      ch.parent_id AS parent_chapter_id, r.created_at AS revision_created_at`;
  const from = `FROM story_chapter_bindings b
    JOIN chapters ch ON ch.id = b.chapter_id
    LEFT JOIN story_chapter_revisions r ON r.id = b.revision_id`;
  const base = `${select} ${from}
    WHERE b.work_id = ? AND b.validity = 'pending'`;
  const rows = [];
  const ids = Array.isArray(chapterIds) && chapterIds.length ? [...new Set(chapterIds.map(Number))] : null;
  if (ids) {
    // 只取指定章节（或其直接子场景）命中的 pending 行：调用方只关心章序前缀时，不必把整个作品的
    // pending 行带回 JS。查询计划保持走 (work_id, validity) 索引、在 SQLite 内完成 OR 过滤：
    // 实测若改成 INDEXED BY 章节索引，会按章取回大量已作废绑定行再在 JS 过滤，反而更慢。
    // 每块补齐到固定 400 个占位符（重复末位 id 不改变 IN 结果）→ SQL 文本稳定、语句缓存有界。
    for (let i = 0; i < ids.length; i += 400) {
      const raw = ids.slice(i, i + 400);
      const chunk = raw.slice();
      while (chunk.length < 400) chunk.push(raw[raw.length - 1]);
      const ph = chunk.map(() => '?').join(',');
      rows.push(...prep(`${base} AND (b.chapter_id IN (${ph}) OR ch.parent_id IN (${ph}))`).all(w, ...chunk, ...chunk));
    }
  } else {
    rows.push(...prep(base).all(w));
  }
  const byChapter = new Map();
  const byParent = new Map();
  const push = (map, key, entry) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  };
  const sorter = (a, b) => {
    const ca = String(a.binding.created_at || '');
    const cb = String(b.binding.created_at || '');
    if (ca !== cb) return ca < cb ? 1 : -1;
    const ia = String(a.binding.id || '');
    const ib = String(b.binding.id || '');
    if (ia === ib) return 0;
    return ia < ib ? 1 : -1;
  };
  for (const row of rows) {
    let contractRef = {};
    try { contractRef = JSON.parse(row.contract_ref_json); } catch { contractRef = {}; }
    const entry = {
      // 轻量条目：只解析 kind 判定所需的 contract_ref（避免为每个 pending 行解析全部 JSON 字段）。
      binding: {
        id: String(row.id), work_id: Number(row.work_id), chapter_id: Number(row.chapter_id),
        revision_id: String(row.revision_id), validity: String(row.validity),
        created_at: row.created_at, contract_ref: contractRef && typeof contractRef === 'object' ? contractRef : {},
      },
      revision_created_at: row.revision_created_at ? String(row.revision_created_at) : '',
    };
    push(byChapter, Number(row.chapter_id), entry);
    if (row.parent_chapter_id !== null && row.parent_chapter_id !== undefined) push(byParent, Number(row.parent_chapter_id), entry);
  }
  for (const list of byChapter.values()) list.sort(sorter);
  for (const list of byParent.values()) list.sort(sorter);
  return { byChapter, byParent };
}

/** 批量索引版：本章或子场景是否存在比给定修订更新的"保存后待确认"记录（语义同 pendingSaveNewerThan）。 */
export function pendingSaveNewerThanIn(index, chapterId, bindingRevision) {
  if (!index) return null;
  const c = Number(chapterId) || 0;
  const merged = [...(index.byChapter.get(c) || []), ...(index.byParent.get(c) || [])].sort((a, b) => {
    const ca = String(a.binding.created_at || '');
    const cb = String(b.binding.created_at || '');
    if (ca !== cb) return ca < cb ? 1 : -1;
    const ia = String(a.binding.id || '');
    const ib = String(b.binding.id || '');
    if (ia === ib) return 0;
    return ia < ib ? 1 : -1;
  });
  const bindingAt = String((bindingRevision && bindingRevision.created_at) || '');
  for (const entry of merged.slice(0, 5)) {
    if ((entry.binding.contract_ref || {}).kind !== 'save_proposal') continue;
    if (!entry.revision_created_at) continue;
    if (entry.revision_created_at > bindingAt) return entry.binding;
  }
  return null;
}

/** 批量索引版：本章最新的"保存后待确认"绑定（语义同 latestSaveProposalBinding）。 */
export function latestSaveProposalBindingIn(index, chapterId) {
  if (!index) return null;
  const rows = index.byChapter.get(Number(chapterId) || 0) || [];
  for (const entry of rows.slice(0, 10)) {
    if ((entry.binding.contract_ref || {}).kind === 'save_proposal') return entry.binding;
  }
  return null;
}
