/**
 * 确定性故事状态内核 · 存储层。
 *
 * 职责边界（写清楚才不会长成第二个 server.js）：
 *   - 这里**只做读写与事务**：SQL 语句、行 ↔ 内核形状的转换、快照落盘、单事务应用；
 *   - 一切"要不要这么做"的判断都在纯模块里（canon / timeline / contract / proposal / preflight）；
 *   - **不修改宿主既有表的语义**：本模块只写 1.1.0 新增的 8 张表 + `story_events` 的两个
 *     既有字段（foreshadow_status / resolves_event_id，语义与端点行为完全不变）。
 *
 * 事务纪律：`applyProposal` 全程单事务——快照、状态变更、提案状态三者要么一起成功、
 * 要么一起回滚。半途失败留下"提案已应用但状态没改"的库，比重试更危险。
 */
import { db, withTransaction, inTransaction } from '../../db.js';
import { normalizeFact } from './canon.mjs';
import { normalizeTimelineEntry } from './timeline.mjs';
import { normalizeKnowledge } from './knowledge.mjs';
import { normalizeContract, hashOf as hashOfContract } from './contract.mjs';
import { stateHashOf } from './hash.mjs';
import { planApply, reviewProposal, makeSnapshot, parseSnapshot, planRollback } from './proposal.mjs';
import { normalizeName } from './entities.mjs';

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const now = () => new Date().toISOString();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// 事务原语与宿主共用（db.js 的深度感知版本）：R03 的原子采纳要求「正文 + 状态提案 + 审批消费」
// 在同一个事务里；内核的 applyProposal 会嵌在宿主事务内，深度感知用 SAVEPOINT 处理嵌套。
export const transaction = withTransaction;

// ── 开关（作品级；默认关 → 未开启的作品与 1.0.0 行为逐字节一致）──────────────
export function isEnabled(workId) {
  try {
    const row = prepare('SELECT enabled FROM story_state_config WHERE work_id = ?').get(Number(workId));
    return !!(row && Number(row.enabled) === 1);
  } catch (_) {
    return false;   // 表缺失（极旧的库）时按关闭处理，绝不因为新机制把既有流程打挂
  }
}

export function setEnabled(workId, enabled, note = '') {
  prepare(`INSERT INTO story_state_config (work_id, enabled, note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(work_id) DO UPDATE SET enabled = excluded.enabled, note = excluded.note, updated_at = excluded.updated_at`)
    .run(Number(workId), enabled ? 1 : 0, String(note || ''), now());
  return { work_id: Number(workId), enabled: !!enabled };
}

export function configOf(workId) {
  const row = prepare('SELECT * FROM story_state_config WHERE work_id = ?').get(Number(workId));
  return row ? { work_id: Number(row.work_id), enabled: Number(row.enabled) === 1, note: String(row.note || ''), updated_at: row.updated_at } : null;
}

// ── 章节序 ──────────────────────────────────────────────────────────────────
/**
 * `chapter_index`：章节在作品**展示顺序**里的序号（0 基）。
 *
 * ⚠ 为什么不直接用 `chapters.position`：实测发现宿主建章节时 position 的默认值是 0，
 * 经界面/接口新建的章节**全都是 0**（只有手动排序过的作品才有真实取值）。
 * 拿 position 当章序，会让"第 9 章才知道的事"在第 1 章就可见——正是我们要防的未来泄漏。
 * 所以取「按 (position, id) 排序后的下标」：positions 有意义时它就是作者排的顺序，
 * positions 全为 0 时它退化成建章顺序，两种情况下都单调、可靠。
 */
export function chapterIndexOf(chapterId) {
  if (!chapterId) return 0;
  const row = prepare('SELECT work_id FROM chapters WHERE id = ?').get(Number(chapterId));
  if (!row) return 0;
  const list = prepare('SELECT id FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(Number(row.work_id));
  const at = list.findIndex((c) => Number(c.id) === Number(chapterId));
  return at >= 0 ? at : 0;
}

export function chapterWork(chapterId) {
  const row = prepare('SELECT id, work_id, title, position FROM chapters WHERE id = ?').get(Number(chapterId));
  return row || null;
}

/** 作品的章节序清单（按 position），供时间线换算与"第几章"文案使用。 */
export function chapterIndexMap(workId) {
  const rows = prepare('SELECT id, position FROM chapters WHERE work_id = ? ORDER BY position, id').all(Number(workId));
  const byId = new Map();
  const indexById = new Map();
  rows.forEach((r, i) => { byId.set(Number(r.id), r); indexById.set(Number(r.id), i); });
  return { byId, indexById, ordered: rows.map((r) => Number(r.id)) };
}

// ── 读：状态 ────────────────────────────────────────────────────────────────
export function readFacts(workId) {
  return prepare(`SELECT f.*, e.canonical_name AS entity_name FROM story_facts f
    LEFT JOIN story_entities e ON e.id = f.entity_id
    WHERE f.work_id = ? ORDER BY f.effective_from, f.id`).all(Number(workId)).map(normalizeFact);
}

export function readTimeline(workId) {
  return prepare('SELECT * FROM story_timeline_entries WHERE work_id = ? ORDER BY chapter_index, scene_index, seq, id')
    .all(Number(workId)).map(normalizeTimelineEntry);
}

export function readKnowledge(workId) {
  return prepare(`SELECT k.*, c.name AS character_name FROM character_knowledge k
    LEFT JOIN characters c ON c.id = k.character_id
    WHERE k.work_id = ? ORDER BY k.character_id, k.fact_key, k.id`).all(Number(workId)).map(normalizeKnowledge);
}

export function readEntities(workId) {
  const entities = prepare('SELECT * FROM story_entities WHERE work_id = ? ORDER BY id').all(Number(workId));
  const aliases = prepare('SELECT * FROM story_entity_aliases WHERE work_id = ? ORDER BY id').all(Number(workId));
  const byId = new Map();
  for (const a of aliases) {
    if (!byId.has(Number(a.entity_id))) byId.set(Number(a.entity_id), []);
    byId.get(Number(a.entity_id)).push({
      alias: String(a.alias || ''), kind: String(a.kind || 'alias'),
      valid_from: a.valid_from === null ? null : num(a.valid_from),
      valid_to: a.valid_to === null ? null : num(a.valid_to),
    });
  }
  return entities.map((e) => ({
    id: Number(e.id), kind: String(e.kind || 'character'), canonical_name: String(e.canonical_name || ''),
    status: String(e.status || 'active'), merged_into: e.merged_into === null ? null : Number(e.merged_into),
    split_from: e.split_from === null ? null : Number(e.split_from),
    ref_table: String(e.ref_table || ''), ref_id: e.ref_id === null ? null : Number(e.ref_id),
    aliases: byId.get(Number(e.id)) || [],
  }));
}

/** 伏笔 = 宿主 story_events 里 kind='foreshadow' 的行（宿主语义不变，只是补上 chapter_index）。 */
export function readForeshadows(workId) {
  const rows = prepare(`SELECT e.* FROM story_events e WHERE e.work_id = ? AND e.kind = 'foreshadow' ORDER BY e.id`).all(Number(workId));
  const events = prepare('SELECT id, work_id, chapter_id, kind, summary, created_at FROM story_events WHERE work_id = ?').all(Number(workId));
  const eventsById = new Map(events.map((e) => [Number(e.id), e]));
  // 章序与 chapterIndexOf 同源：按 (position, id) 排序后的**下标**，不是原始 position。
  const ordered = prepare('SELECT id FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(Number(workId));
  const posById = new Map(ordered.map((c, i) => [Number(c.id), i]));
  const items = rows.map((r) => ({
    id: Number(r.id),
    work_id: Number(r.work_id),
    chapter_id: r.chapter_id === null ? null : Number(r.chapter_id),
    chapter_index: r.chapter_id === null || r.chapter_id === undefined ? null : (posById.has(Number(r.chapter_id)) ? posById.get(Number(r.chapter_id)) : null),
    summary: String(r.summary || ''),
    foreshadow_status: String(r.foreshadow_status || ''),
    resolves_event_id: r.resolves_event_id === null ? null : Number(r.resolves_event_id),
    payload: safeParse(r.payload),
    created_index: r.chapter_id === null || r.chapter_id === undefined ? 0 : num(posById.get(Number(r.chapter_id))),
    target_chapter_index: targetIndexOf(safeParse(r.payload)),
    last_touch_index: lastTouchIndex(r, events, posById),
  }));
  return { items, eventsById };
}

function targetIndexOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const t = payload.target_chapter_index ?? payload.target_chapter ?? payload.due_chapter_index;
  return t === undefined || t === null || t === '' ? null : num(t);
}

/** 最近一次"碰到"这条伏笔的章序：埋下、被回收、或被后续事件引用。 */
function lastTouchIndex(row, events, posById) {
  let best = row.chapter_id === null || row.chapter_id === undefined ? 0 : num(posById.get(Number(row.chapter_id)));
  if (row.resolves_event_id) {
    const ev = events.find((e) => Number(e.id) === Number(row.resolves_event_id));
    if (ev && ev.chapter_id) best = Math.max(best, num(posById.get(Number(ev.chapter_id))));
  }
  for (const ev of events) {
    if (String(ev.summary || '').includes(`#${row.id}`) && ev.chapter_id) {
      best = Math.max(best, num(posById.get(Number(ev.chapter_id))));
    }
  }
  return best;
}

function safeParse(v) {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (_) { return {}; }
}

/** 章节契约：取该章 version 最大的一条（历史版本保留在表里，可查"当时按什么写的"）。 */
export function readContract(chapterId) {
  const row = prepare('SELECT * FROM chapter_contracts WHERE chapter_id = ? ORDER BY version DESC LIMIT 1').get(Number(chapterId));
  if (!row) return null;
  const parsed = safeParse(row.contract_json);
  return {
    ...parsed,
    id: Number(row.id), version: num(row.version), contract_hash: String(row.contract_hash || ''),
    status: String(row.status || 'active'), note: String(row.note || ''), created_at: row.created_at,
  };
}

export function saveContract(workId, chapterId, contractInput, { note = '', status = 'active' } = {}) {
  const { contract, warnings } = normalizeContract(contractInput);
  const hash = hashOfContract(contract);
  const prev = prepare('SELECT MAX(version) AS v FROM chapter_contracts WHERE chapter_id = ?').get(Number(chapterId));
  const version = num(prev && prev.v) + 1;
  return transaction(() => {
    prepare('UPDATE chapter_contracts SET status = ? , updated_at = ? WHERE chapter_id = ? AND status = ?')
      .run('superseded', now(), Number(chapterId), 'active');
    const info = prepare(`INSERT INTO chapter_contracts (work_id, chapter_id, version, contract_hash, status, contract_json, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(Number(workId), Number(chapterId), version, hash, status, JSON.stringify(contract), String(note || ''), now(), now());
    return { id: Number(info.lastInsertRowid), version, contract_hash: hash, contract, warnings, status };
  });
}


export function listContractVersions(chapterId) {
  return prepare('SELECT id, version, contract_hash, status, note, created_at FROM chapter_contracts WHERE chapter_id = ? ORDER BY version DESC')
    .all(Number(chapterId));
}

// ── 状态聚合（哈希与快照的共同输入）────────────────────────────────────────
export function readState(workId, { chapterId = null } = {}) {
  const { items: foreshadows } = readForeshadows(workId);
  return {
    work_id: Number(workId),
    chapter_id: chapterId === null ? null : Number(chapterId),
    facts: readFacts(workId),
    timeline: readTimeline(workId),
    knowledge: readKnowledge(workId),
    entities: readEntities(workId),
    foreshadows,
  };
}

export function stateHash(workId, opts) {
  return stateHashOf(readState(workId, opts));
}

// ── 快照 ────────────────────────────────────────────────────────────────────
export function createSnapshot(workId, { reason = '', label = '', chapterId = null } = {}) {
  const state = readState(workId, { chapterId });
  const snap = makeSnapshot(state, { reason, label, chapterId, workId });
  const info = prepare(`INSERT INTO story_snapshots (work_id, chapter_id, reason, label, state_hash, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(workId), chapterId === null ? null : Number(chapterId), String(reason), String(label), snap.state_hash, snap.snapshot_json, now());
  return { id: Number(info.lastInsertRowid), state_hash: snap.state_hash };
}

export function listSnapshots(workId, limit = 20) {
  return prepare('SELECT id, chapter_id, reason, label, state_hash, created_at FROM story_snapshots WHERE work_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(workId), Number(limit) || 20);
}

export function getSnapshot(id) {
  return prepare('SELECT * FROM story_snapshots WHERE id = ?').get(Number(id)) || null;
}

// ── 提案 ────────────────────────────────────────────────────────────────────
export function createProposal(row) {
  const info = prepare(`INSERT INTO story_state_proposals
    (work_id, chapter_id, kind, payload_json, base_state_hash, context_hash, contract_hash, state, conflict_level,
     auto_fixable, requires_author, note, dedup_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      Number(row.work_id), row.chapter_id === null || row.chapter_id === undefined ? null : Number(row.chapter_id),
      String(row.kind), String(row.payload_json || '{}'), String(row.base_state_hash || ''),
      String(row.context_hash || ''), String(row.contract_hash || ''), String(row.state || 'pending'),
      String(row.conflict_level || 'info'), row.auto_fixable ? 1 : 0, row.requires_author ? 1 : 0,
      String(row.note || ''), String(row.dedup_key || ''), now(),
    );
  return { id: Number(info.lastInsertRowid) };
}

export function listProposals(workId, { state = null, limit = 50 } = {}) {
  const sql = state
    ? 'SELECT * FROM story_state_proposals WHERE work_id = ? AND state = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM story_state_proposals WHERE work_id = ? ORDER BY id DESC LIMIT ?';
  const rows = state ? prepare(sql).all(Number(workId), String(state), Number(limit) || 50)
    : prepare(sql).all(Number(workId), Number(limit) || 50);
  return rows.map(publicProposal);
}

export function getProposal(id) {
  const row = prepare('SELECT * FROM story_state_proposals WHERE id = ?').get(Number(id));
  return row ? publicProposal(row) : null;
}

function publicProposal(r) {
  return {
    id: Number(r.id), work_id: Number(r.work_id),
    chapter_id: r.chapter_id === null ? null : Number(r.chapter_id),
    kind: String(r.kind), payload: safeParse(r.payload_json),
    base_state_hash: String(r.base_state_hash || ''), context_hash: String(r.context_hash || ''),
    contract_hash: String(r.contract_hash || ''), state: String(r.state),
    conflict_level: String(r.conflict_level || 'info'),
    auto_fixable: Number(r.auto_fixable) === 1, requires_author: Number(r.requires_author) === 1,
    note: String(r.note || ''), applied_at: r.applied_at || null, created_at: r.created_at,
  };
}

/**
 * 复核（不落库）：给定提案 id 与"当前状态"，回答能不能应用、会不会陈旧。
 * 单独一个函数是为了让界面在作者点确认**之前**就能显示"这条已经过期了"。
 */
export function review(proposalId, { chapterId = null } = {}) {
  const p = getProposal(proposalId);
  if (!p) return { ok: false, decision: 'not_found', reason: `提案 #${proposalId} 不存在` };
  if (p.state !== 'pending') return { ok: false, decision: p.state, reason: `提案 #${proposalId} 已经是 ${p.state} 状态` };
  const state = readState(p.work_id, { chapterId: p.chapter_id });
  return { ok: true, proposal: p, ...reviewProposal({ ...p, payload_json: JSON.stringify(p.payload) }, state, { chapterIndex: chapterIndexOf(p.chapter_id || chapterId), now: now() }) };
}

/**
 * 应用提案：**单事务** = 陈旧检查 → 落快照 → 执行 ops → 标记 applied。
 * 陈旧时把提案标成 `stale` 并**返回而不是抛**——过期是业务事件，不是异常。
 */
export function applyProposal(proposalId, { onBeforeCommit = null } = {}) {
  const row = prepare('SELECT * FROM story_state_proposals WHERE id = ?').get(Number(proposalId));
  if (!row) return { ok: false, decision: 'not_found', reason: `提案 #${proposalId} 不存在` };
  const p = publicProposal(row);
  if (p.state !== 'pending') return { ok: false, decision: p.state, work_id: p.work_id, reason: `提案 #${proposalId} 已经是 ${p.state} 状态，不能重复应用` };

  const workId = p.work_id;
  let result;
  try {
    result = transaction(() => {
      const state = readState(workId, { chapterId: p.chapter_id });
      const verdict = reviewProposal({ ...p, payload_json: JSON.stringify(p.payload) }, state, {
        chapterIndex: chapterIndexOf(p.chapter_id), now: now(),
      });
      if (!verdict.ok) return { ok: false, decision: verdict.decision, work_id: workId, reason: verdict.reason };
      const snapId = createSnapshot(workId, {
        reason: `应用提案 #${p.id}（${p.kind}）`, label: p.note || '', chapterId: p.chapter_id,
      }).id;
      const executed = executeOps(verdict.plan.ops, { workId, chapterId: p.chapter_id, chapterIndex: chapterIndexOf(p.chapter_id) });
      prepare('UPDATE story_state_proposals SET state = ?, applied_at = ? WHERE id = ?').run('applied', now(), p.id);
      const after = readState(workId, { chapterId: p.chapter_id });
      // 宿主钩子（R02.2/R03）：在**同一事务内**做最后一道校验（如消费作者审批）。
      // 抛错 = 整个事务回滚——审批已消费但状态没写、或状态写了审批没消费，都不允许出现。
      if (typeof onBeforeCommit === 'function') onBeforeCommit({ workId, chapterId: p.chapter_id, proposalId: p.id, decision: 'applied' });
      return {
        ok: true, decision: 'applied', proposal_id: p.id, work_id: workId, snapshot_id: snapId,
        ops: executed.length, state_hash_before: verdict.stale.base, state_hash_after: stateHashOf(after),
      };
    });
  } catch (e) {
    return { ok: false, decision: 'error', work_id: workId, reason: `应用提案失败（已回滚）：${e.message}` };
  }
  if (result.ok !== true && result.decision === 'stale') {
    prepare('UPDATE story_state_proposals SET state = ? WHERE id = ? AND state = ?').run('stale', p.id, 'pending');
  }
  return result;
}

/**
 * 批量应用返回 stale 时，把整批标 stale（与单条应用保持同一可见口径）。
 *
 * ⚠️ 2026-10-08 审计：**当前零调用点**。它想服务的场景（批量/单条应用发现基线移动后
 * 把提案标 stale）目前由各应用路径**内联**完成（见本站上方 `applyProposal` 里那两句
 * `UPDATE story_state_proposals SET state='stale'`）。所以它不是被别的模块取代的重复实现
 * （与 `temporal/impact.mjs` 的 `markDownstreamStale` 不是一回事：那个管**下游章节失效**，
 * 这个管**提案自身的状态**），而是"写了没接"的辅助函数。
 * 处置：本次**不改行为**，只如实标注。要么将来把内联的两处收口到它这里（同一口径只写一份），
 * 要么确认不再需要后删除——留在没有标注的死代码里，下一次审计还会把它当成缺陷报一遍。
 */
export function markProposalsStale(ids = []) {
  let n = 0;
  for (const id of (Array.isArray(ids) ? ids : []).map(Number).filter((x) => x > 0)) {
    n += prepare('UPDATE story_state_proposals SET state = ? WHERE id = ? AND state = ?').run('stale', id, 'pending').changes;
  }
  return n;
}

/**
 * 批量原子应用（R12：以「确认单元」为原子边界）。
 *
 * 为什么不能简单地对每条调 applyProposal：逐条应用时，第一条改了状态，后面每一条的
 * 陈旧检查都会失败（判成 stale）——但同一批候选本来就来自**同一个基线快照**，
 * 它们应当**一起**生效。这里在一个事务里：只做一次基线核对（全批共享同一当前状态）、
 * 落一个快照、顺序执行全批 ops、一次性标记 applied；任一失败整体回滚，不留半套正式状态。
 *
 * 基线不一致（不是同一次确认单元）的批量请求直接拒绝，而不是猜哪条该用哪份基线。
 */
export function applyProposalsBatch(proposalIds, { onBeforeCommit = null } = {}) {
  const ids = (Array.isArray(proposalIds) ? proposalIds : []).map(Number).filter((n) => n > 0);
  if (!ids.length) return { ok: false, decision: 'not_found', reason: '没有可应用的提案' };
  const rows = ids.map((id) => prepare('SELECT * FROM story_state_proposals WHERE id = ?').get(id)).filter(Boolean).map(publicProposal);
  if (rows.length !== ids.length) return { ok: false, decision: 'not_found', reason: '部分提案不存在（批量应用要求全部存在）' };
  const workId = rows[0].work_id;
  if (!rows.every((p) => p.work_id === workId)) return { ok: false, decision: 'mixed_work', reason: '批量应用的提案必须属于同一作品' };
  const notPending = rows.filter((p) => p.state !== 'pending');
  if (notPending.length) return { ok: false, decision: notPending[0].state, work_id: workId, reason: `提案 #${notPending[0].id} 已经是 ${notPending[0].state} 状态，不能重复应用` };
  const hashes = new Set(rows.map((p) => String(p.base_state_hash || '')));
  if (hashes.size !== 1 || !String(rows[0].base_state_hash || '')) {
    return { ok: false, decision: 'mixed_baseline', work_id: workId, reason: '这批提案的基线不一致（不是同一次确认单元）：请分批确认后再应用' };
  }
  let result;
  try {
    result = transaction(() => {
      const chapterId = rows[0].chapter_id ?? null;
      const state = readState(workId, { chapterId });
      const base = String(rows[0].base_state_hash || '');
      if (base !== stateHashOf(state)) {
        return { ok: false, decision: 'stale', work_id: workId, reason: '当前状态与这批提案的基线不一致：期间有其它变更写入，应用会覆盖它们' };
      }
      const plans = [];
      for (const p of rows) {
        const verdict = planApply({ ...p, payload_json: JSON.stringify(p.payload) }, { now: now(), chapterIndex: chapterIndexOf(p.chapter_id || chapterId) });
        if (!verdict.ok) return { ok: false, decision: 'invalid', work_id: workId, reason: `提案 #${p.id} 无法执行：${verdict.reason}` };
        plans.push({ p, ops: verdict.ops });
      }
      const kinds = [...new Set(rows.map((p) => p.kind))].join('/');
      const snapId = createSnapshot(workId, { reason: `批量应用 ${rows.length} 条提案（${kinds}）`, label: '', chapterId }).id;
      let executed = 0;
      for (const item of plans) executed += executeOps(item.ops, { workId, chapterId, chapterIndex: chapterIndexOf(chapterId) }).length;
      for (const p of rows) prepare('UPDATE story_state_proposals SET state = ?, applied_at = ? WHERE id = ?').run('applied', now(), p.id);
      if (typeof onBeforeCommit === 'function') onBeforeCommit({ workId, chapterId, proposalIds: rows.map((p) => p.id), decision: 'applied' });
      const after = readState(workId, { chapterId });
      return { ok: true, decision: 'applied', work_id: workId, snapshot_id: snapId, proposal_ids: rows.map((p) => p.id), ops: executed, state_hash_before: base, state_hash_after: stateHashOf(after) };
    });
  } catch (e) {
    return { ok: false, decision: 'error', work_id: workId, reason: `批量应用失败（已回滚）：${e.message}` };
  }
  return result;
}

export function rejectProposal(proposalId, note = '') {
  const row = prepare('SELECT * FROM story_state_proposals WHERE id = ?').get(Number(proposalId));
  if (!row) return { ok: false, reason: `提案 #${proposalId} 不存在` };
  if (String(row.state) !== 'pending') return { ok: false, reason: `提案 #${proposalId} 已经是 ${row.state} 状态` };
  prepare('UPDATE story_state_proposals SET state = ?, note = COALESCE(NULLIF(?, \'\'), note) WHERE id = ?').run('rejected', String(note || ''), Number(proposalId));
  return { ok: true, proposal_id: Number(proposalId), state: 'rejected' };
}

/**
 * 回滚到某个快照。
 * 语义见 proposal.mjs 的 `planRollback`：**不删除任何行**——
 * 快照之后新增的标记 superseded，被改过的改回快照取值。
 */
export function rollbackToSnapshot(snapshotId, { onBeforeCommit = null } = {}) {
  const snap = getSnapshot(snapshotId);
  if (!snap) return { ok: false, reason: `快照 #${snapshotId} 不存在` };
  const before = parseSnapshot(snap);
  if (!before) return { ok: false, reason: `快照 #${snapshotId} 的内容无法解析` };
  const workId = Number(snap.work_id);
  try {
    const out = transaction(() => {
      const current = readState(workId, { chapterId: snap.chapter_id === null ? null : Number(snap.chapter_id) });
      const safety = createSnapshot(workId, { reason: `回滚前自动快照（目标 #${snap.id}）`, label: 'pre-rollback', chapterId: snap.chapter_id });
      const plan = planRollback(before, current);
      const executed = executeOps(plan.ops, { workId, chapterId: snap.chapter_id, chapterIndex: chapterIndexOf(snap.chapter_id) });
      if (typeof onBeforeCommit === 'function') onBeforeCommit({ workId, snapshotId: Number(snap.id), ops: executed.length });
      return { ok: true, work_id: workId, snapshot_id: Number(snap.id), safety_snapshot_id: safety.id, ops: executed.length, note: plan.note };
    });
    return out;
  } catch (e) {
    return { ok: false, reason: `回滚失败（已回滚事务）：${e.message}` };
  }
}

// ── 声明式 ops 的执行器（唯一一处把计划变成 SQL 的地方）────────────────────
function executeOps(ops = [], ctx = {}) {
  const done = [];
  const returned = {};
  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        const values = { ...op.values };
        if (values.created_at === null) delete values.created_at;
        if (values.updated_at === null) delete values.updated_at;
        const keys = Object.keys(values);
        const info = prepare(`INSERT INTO ${op.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
          .run(...keys.map((k) => values[k]));
        if (op.returnId) returned[op.returnId] = Number(info.lastInsertRowid);
        done.push({ op: 'insert', table: op.table, id: Number(info.lastInsertRowid) });
        break;
      }
      case 'upsert': {
        const values = { ...op.values };
        const keys = Object.keys(values);
        const conflict = (op.conflictKeys || []).join(', ');
        const updates = keys.filter((k) => !(op.conflictKeys || []).includes(k));
        // `conflictWhere` 是给**部分唯一索引**用的：SQLite 要求 ON CONFLICT 的冲突目标把该索引的 WHERE
        // 谓词原样重复一遍，否则报 "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"。
        // 省略时 SQL 与改动前**逐字节相同**（非部分索引不需要它，行为不变）。
        const conflictWhere = op.conflictWhere ? ` WHERE ${op.conflictWhere}` : '';
        const info = prepare(`INSERT INTO ${op.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
          ON CONFLICT(${conflict})${conflictWhere} DO UPDATE SET ${updates.map((k) => `${k} = excluded.${k}`).join(', ')}`)
          .run(...keys.map((k) => values[k]));
        done.push({ op: 'upsert', table: op.table, id: Number(info.lastInsertRowid) });
        break;
      }
      case 'update': {
        const keys = Object.keys(op.values);
        if (!keys.length) break;
        const whereKeys = Object.keys(op.where || {});
        const info = prepare(`UPDATE ${op.table} SET ${keys.map((k) => `${k} = ?`).join(', ')}
          WHERE ${whereKeys.map((k) => `${k} = ?`).join(' AND ')}`)
          .run(...keys.map((k) => op.values[k]), ...whereKeys.map((k) => op.where[k]));
        done.push({ op: 'update', table: op.table, changes: Number(info.changes) });
        break;
      }
      case 'insert_alias': {
        const entityId = returned[op.aliasOf];
        if (!entityId) break;
        const alias = String(op.values.alias || '');
        if (!alias) break;
        prepare(`INSERT INTO story_entity_aliases (work_id, entity_id, alias, normalized, kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(ctx.workId, entityId, alias, normalizeName(alias), String(op.values.kind || 'alias'), now());
        done.push({ op: 'insert_alias', entity_id: entityId, alias });
        break;
      }
      case 'move_aliases': {
        const info = prepare(`UPDATE story_entity_aliases SET entity_id = ? WHERE work_id = ? AND entity_id IN (${op.fromEntityIds.map(() => '?').join(', ')})`)
          .run(Number(op.intoEntityId), ctx.workId, ...op.fromEntityIds.map(Number));
        done.push({ op: 'move_aliases', changes: Number(info.changes) });
        break;
      }
      case 'move_aliases_named': {
        const target = op.intoEntityRef ? returned[op.intoEntityRef] : Number(op.intoEntityId);
        const names = (op.names || []).filter(Boolean);
        if (!target || !names.length) break;
        const info = prepare(`UPDATE story_entity_aliases SET entity_id = ? WHERE work_id = ? AND entity_id = ? AND alias IN (${names.map(() => '?').join(', ')})`)
          .run(Number(target), ctx.workId, Number(op.fromEntityId), ...names);
        done.push({ op: 'move_aliases_named', changes: Number(info.changes) });
        break;
      }
      case 'repoint_facts': {
        const target = op.intoEntityRef ? returned[op.intoEntityRef] : Number(op.intoEntityId);
        if (!target) break;
        if (Array.isArray(op.factIds) && op.factIds.length) {
          const info = prepare(`UPDATE story_facts SET entity_id = ? WHERE work_id = ? AND id IN (${op.factIds.map(() => '?').join(', ')})`)
            .run(Number(target), ctx.workId, ...op.factIds.map(Number));
          done.push({ op: 'repoint_facts', changes: Number(info.changes) });
        } else if (Array.isArray(op.fromEntityIds) && op.fromEntityIds.length) {
          const info = prepare(`UPDATE story_facts SET entity_id = ? WHERE work_id = ? AND entity_id IN (${op.fromEntityIds.map(() => '?').join(', ')})`)
            .run(Number(target), ctx.workId, ...op.fromEntityIds.map(Number));
          done.push({ op: 'repoint_facts', changes: Number(info.changes) });
        }
        break;
      }
      case 'restore': {
        const values = op.values || {};
        if (op.table === 'story_facts') {
          prepare(`INSERT INTO story_facts (work_id, chapter_id, entity_id, subject, predicate, value, scope, state, status,
            holder_id, effective_from, effective_to, story_time, source_event_id, confidence, dedup_key, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(ctx.workId, values.chapter_id ?? null, values.entity_id ?? null, String(values.subject || ''), String(values.predicate || ''),
              String(values.value || ''), String(values.scope || 'CANON_KNOWLEDGE'), String(values.state || 'known'),
              String(values.status || 'established'), values.holder_id ?? null, num(values.effective_from),
              values.effective_to === null || values.effective_to === undefined ? null : num(values.effective_to),
              String(values.story_time || ''), values.source_event_id ?? null,
              Number.isFinite(Number(values.confidence)) ? Number(values.confidence) : 1,
              String(values.dedup_key || ''), JSON.stringify(values.payload || {}), now(), now());
          done.push({ op: 'restore', table: 'story_facts', key: op.key });
        } else if (op.table === 'character_knowledge') {
          prepare(`INSERT INTO character_knowledge (work_id, character_id, fact_id, fact_key, state, learned_chapter_id,
            learned_chapter_index, learned_scene_index, story_time, source, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(ctx.workId, num(values.character_id), values.fact_id ?? null, String(values.fact_key || ''),
              String(values.state || 'known'), values.learned_chapter_id ?? null, num(values.learned_chapter_index),
              num(values.learned_scene_index), String(values.story_time || ''), String(values.source || 'rollback'),
              String(values.note || ''), now());
          done.push({ op: 'restore', table: 'character_knowledge', key: op.key });
        }
        break;
      }
      default:
        done.push({ op: op.op, skipped: true });
    }
  }
  return done;
}

// ── 校验记录 ────────────────────────────────────────────────────────────────
export function saveValidation({ workId, chapterId = null, phase = 'post', contractHash = '', stateHashValue = '', result = {} } = {}) {
  const counts = result.counts || {};
  const info = prepare(`INSERT INTO story_validations (work_id, chapter_id, phase, contract_hash, state_hash, passed,
    critical_count, high_count, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(workId), chapterId === null ? null : Number(chapterId), String(phase), String(contractHash),
      String(stateHashValue), result.passed ? 1 : 0, num(counts.critical), num(counts.high),
      JSON.stringify(result), now());
  return { id: Number(info.lastInsertRowid) };
}

export function listValidations(chapterId, phase = null) {
  const rows = phase
    ? prepare('SELECT * FROM story_validations WHERE chapter_id = ? AND phase = ? ORDER BY id DESC LIMIT 20').all(Number(chapterId), String(phase))
    : prepare('SELECT * FROM story_validations WHERE chapter_id = ? ORDER BY id DESC LIMIT 20').all(Number(chapterId));
  return rows.map((r) => ({
    id: Number(r.id), phase: String(r.phase), passed: Number(r.passed) === 1,
    contract_hash: String(r.contract_hash || ''), state_hash: String(r.state_hash || ''),
    critical_count: num(r.critical_count), high_count: num(r.high_count),
    result: safeParse(r.result_json), created_at: r.created_at,
  }));
}

/** 作品级概览（给界面/编排层：一眼看到状态规模与开关）。 */
export function summaryOf(workId) {
  const w = Number(workId);
  const count = (sql) => { try { return num(prepare(sql).get(w).n); } catch (_) { return 0; } };
  return {
    work_id: w,
    enabled: isEnabled(w),
    config: configOf(w),
    facts: count('SELECT COUNT(*) AS n FROM story_facts WHERE work_id = ?'),
    timeline: count('SELECT COUNT(*) AS n FROM story_timeline_entries WHERE work_id = ?'),
    knowledge: count('SELECT COUNT(*) AS n FROM character_knowledge WHERE work_id = ?'),
    entities: count('SELECT COUNT(*) AS n FROM story_entities WHERE work_id = ?'),
    contracts: count('SELECT COUNT(*) AS n FROM chapter_contracts WHERE work_id = ?'),
    proposals_pending: count("SELECT COUNT(*) AS n FROM story_state_proposals WHERE work_id = ? AND state = 'pending'"),
    proposals_stale: count("SELECT COUNT(*) AS n FROM story_state_proposals WHERE work_id = ? AND state = 'stale'"),
    snapshots: count('SELECT COUNT(*) AS n FROM story_snapshots WHERE work_id = ?'),
    validations: count('SELECT COUNT(*) AS n FROM story_validations WHERE work_id = ?'),
    state_hash: stateHash(w),
  };
}
