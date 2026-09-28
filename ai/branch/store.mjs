/**
 * store.mjs —— R11「剧情分支沙盘」存储层（候选 / 沙盘运行 / 采纳记录）。
 *
 * 边界（写清楚才不会长成第二套状态体系）：
 *   - 只读写 `branch_sandboxes` / `branch_candidates` 两张新表；works / chapters 只读判存在与取标题。
 *   - **绝不写** story_facts / story_events / character_knowledge / chapters.content：
 *     候选不是本书事实，采纳只形成蓝图与契约建议（正文/事实的变更走各自的作者确认流程）。
 */
import { db } from '../../db.js';

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const now = () => new Date().toISOString();
const parseJson = (s, dflt) => { try { return JSON.parse(s || ''); } catch (_) { return dflt; } };

export function workExists(workId) {
  return !!prepare('SELECT id FROM works WHERE id = ?').get(Number(workId));
}

export function chapterOfWork(workId, chapterId) {
  return prepare('SELECT id, work_id, title FROM chapters WHERE id = ? AND work_id = ?').get(Number(chapterId), Number(workId)) || null;
}

// ── 沙盘运行（一个运行 = 为某一章准备 2—5 个候选；支持取消 / 恢复到未完成状态）──
const sandboxRow = (r) => r ? {
  id: r.id, work_id: r.work_id, chapter_id: r.chapter_id, status: r.status, requested: r.requested,
  deps: parseJson(r.deps_json, {}), note: r.note || '', created_by: r.created_by || '', created_at: r.created_at, updated_at: r.updated_at,
} : null;

export function createSandbox({ workId, chapterId = null, requested = 3, deps = {}, note = '', createdBy = '' }) {
  const info = prepare('INSERT INTO branch_sandboxes (work_id, chapter_id, status, requested, deps_json, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Number(workId), chapterId === null ? null : Number(chapterId), 'open', Number(requested) || 3, JSON.stringify(deps || {}), String(note || ''), String(createdBy || ''), now(), now());
  return getSandbox(Number(info.lastInsertRowid));
}

export function getSandbox(id) {
  return sandboxRow(prepare('SELECT * FROM branch_sandboxes WHERE id = ?').get(Number(id)));
}

export function listSandboxes(workId, chapterId = null) {
  const rows = chapterId
    ? prepare('SELECT * FROM branch_sandboxes WHERE work_id = ? AND chapter_id = ? ORDER BY id DESC').all(Number(workId), Number(chapterId))
    : prepare('SELECT * FROM branch_sandboxes WHERE work_id = ? ORDER BY id DESC').all(Number(workId));
  return rows.map(sandboxRow);
}

export function setSandboxStatus(id, status) {
  prepare('UPDATE branch_sandboxes SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now(), Number(id));
  return getSandbox(id);
}

export function countCandidates(sandboxId, { status = null, excludeDiscarded = false } = {}) {
  const rows = prepare('SELECT status FROM branch_candidates WHERE sandbox_id = ?').all(Number(sandboxId));
  return rows.filter((r) => (status ? r.status === status : (excludeDiscarded ? r.status !== 'discarded' : true))).length;
}

/** 进度：计划 / 已完成 / 剩余槽位（重启恢复用它回答"还差几个"）。 */
export function sandboxProgress(sandbox) {
  if (!sandbox) return null;
  const produced = countCandidates(sandbox.id, { excludeDiscarded: true });
  return {
    sandbox_id: sandbox.id, status: sandbox.status, requested: sandbox.requested,
    produced, remaining: Math.max(0, Number(sandbox.requested) - produced),
    complete: produced >= Number(sandbox.requested),
  };
}

// ── 候选 ──
const candidateRow = (r) => {
  if (!r) return null;
  const payload = parseJson(r.payload_json, {});
  return {
    ...payload,
    id: r.id, work_id: r.work_id, sandbox_id: r.sandbox_id, chapter_id: r.chapter_id, ordinal: r.ordinal,
    title: r.title || payload.title || '', core_action: r.core_action || payload.core_action || '',
    conflict: r.conflict || payload.conflict || '',
    deps: parseJson(r.deps_json, {}), deps_hash: r.deps_hash || '',
    distinct: parseJson(r.distinct_json, {}), stale: Number(r.stale) === 1,
    status: r.status, adopted: parseJson(r.adopted_json, {}), created_by: r.created_by || '',
    created_at: r.created_at, updated_at: r.updated_at,
  };
};

export function createCandidate({ workId, sandboxId = null, chapterId = null, ordinal = 1, candidate, deps, distinct = {}, createdBy = 'author' }) {
  const info = prepare(`INSERT INTO branch_candidates
    (work_id, sandbox_id, chapter_id, ordinal, title, core_action, conflict, payload_json, deps_json, deps_hash, distinct_json, stale, status, adopted_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'candidate', '{}', ?, ?, ?)`)
    .run(
      Number(workId), sandboxId === null ? null : Number(sandboxId), chapterId === null ? null : Number(chapterId),
      Number(ordinal) || 1, String(candidate.title || ''), String(candidate.core_action || ''), String(candidate.conflict || ''),
      JSON.stringify(candidate || {}), JSON.stringify(deps || {}), String((deps && deps.hash) || ''),
      JSON.stringify(distinct || {}), String(createdBy || 'author'), now(), now(),
    );
  return getCandidate(Number(info.lastInsertRowid));
}

export function getCandidate(id) {
  return candidateRow(prepare('SELECT * FROM branch_candidates WHERE id = ?').get(Number(id)));
}

export function listCandidates({ workId, chapterId = null, status = null, sandboxId = null, limit = 100 } = {}) {
  const clauses = ['work_id = ?'];
  const args = [Number(workId)];
  if (chapterId) { clauses.push('chapter_id = ?'); args.push(Number(chapterId)); }
  if (status) { clauses.push('status = ?'); args.push(String(status)); }
  if (sandboxId) { clauses.push('sandbox_id = ?'); args.push(Number(sandboxId)); }
  args.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  return prepare(`SELECT * FROM branch_candidates WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args).map(candidateRow);
}

export function updateCandidate(id, { status = null, adopted = null, stale = null } = {}) {
  const row = prepare('SELECT id FROM branch_candidates WHERE id = ?').get(Number(id));
  if (!row) return null;
  if (status !== null) prepare('UPDATE branch_candidates SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now(), Number(id));
  if (adopted !== null) prepare('UPDATE branch_candidates SET adopted_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(adopted || {}), now(), Number(id));
  if (stale !== null) prepare('UPDATE branch_candidates SET stale = ?, updated_at = ? WHERE id = ?').run(stale ? 1 : 0, now(), Number(id));
  return getCandidate(id);
}

export function countCandidatesForWork(workId) {
  const row = prepare("SELECT COUNT(*) AS n FROM branch_candidates WHERE work_id = ? AND status != 'discarded'").get(Number(workId));
  return Number(row && row.n) || 0;
}