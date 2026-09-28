/**
 * rebuild-store.mjs —— R12「导入后分析重建创作状态」的存储层（run / 批次账本）。
 *
 * 边界：
 *   - 只读写 `import_rebuild_runs` / `import_rebuild_batches` 两张新表；works / chapters 只读。
 *   - **绝不**在这里写 story_facts / story_events / character_knowledge / chapters.content：
 *     抽取结果先是候选（存在批次的 result_json / proposals_json 里），作者确认后由既有提案设施落地。
 *   - 状态机：run: planned → running → confirmed | cancelled；batch: pending → extracted → confirmed
 *     | stale | failed。stale 是「基线不再匹配」，不代表结果被删——旧结果仍可阅读。
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
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function workExists(workId) {
  return !!prepare('SELECT id FROM works WHERE id = ?').get(Number(workId));
}

/** 作品章节（按 position, id 排序）——重建的输入顺序必须有唯一口径。 */
export function chaptersOfWork(workId) {
  return prepare('SELECT id, title, content, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC')
    .all(Number(workId))
    .map((r, i) => ({ id: Number(r.id), index: i, title: r.title || '', content: r.content || '' }));
}

export function chapterById(workId, chapterId) {
  return prepare('SELECT id, title, content FROM chapters WHERE id = ? AND work_id = ?').get(Number(chapterId), Number(workId)) || null;
}

// ── run ─────────────────────────────────────────────────────────────────────
const runRow = (r) => r ? {
  id: Number(r.id), work_id: Number(r.work_id), status: String(r.status),
  extractor_version: String(r.extractor_version || ''), schema_version: String(r.schema_version || ''),
  route: parseJson(r.route_json, {}), categories: parseJson(r.categories_json, []),
  batch_size: Number(r.batch_size), note: String(r.note || ''), created_by: String(r.created_by || ''),
  created_at: r.created_at, updated_at: r.updated_at,
} : null;

export function createRun({ workId, extractorVersion = '', schemaVersion = '', route = {}, categories = [], batchSize = 0, note = '', createdBy = 'author', status = 'planned' }) {
  const info = prepare(`INSERT INTO import_rebuild_runs
    (work_id, status, extractor_version, schema_version, route_json, categories_json, batch_size, note, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(workId), String(status), String(extractorVersion), String(schemaVersion),
      JSON.stringify(route || {}), JSON.stringify(categories || []), num(batchSize), String(note || ''), String(createdBy || ''), now(), now());
  return getRun(Number(info.lastInsertRowid));
}

export function getRun(id) {
  return runRow(prepare('SELECT * FROM import_rebuild_runs WHERE id = ?').get(Number(id)));
}

export function listRuns(workId, limit = 20) {
  return prepare('SELECT * FROM import_rebuild_runs WHERE work_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(workId), Number(limit) || 20).map(runRow);
}

export function latestRunFor(workId) {
  return runRow(prepare('SELECT * FROM import_rebuild_runs WHERE work_id = ? ORDER BY id DESC LIMIT 1').get(Number(workId)));
}

export function setRunStatus(id, status, note = null) {
  if (note === null || note === undefined) prepare('UPDATE import_rebuild_runs SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now(), Number(id));
  else prepare('UPDATE import_rebuild_runs SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(String(status), String(note), now(), Number(id));
  return getRun(id);
}

export function deleteRun(id) {
  return prepare('DELETE FROM import_rebuild_runs WHERE id = ?').run(Number(id)).changes;
}

// ── 批次 ────────────────────────────────────────────────────────────────────
const batchRow = (r) => r ? {
  id: Number(r.id), run_id: Number(r.run_id), work_id: Number(r.work_id), batch_index: Number(r.batch_index),
  chapter_ids: parseJson(r.chapter_ids_json, []), chapter_indexes: parseJson(r.chapter_indexes_json, []),
  chapter_hashes: parseJson(r.chapter_hashes_json, []), chars: Number(r.chars),
  baseline: parseJson(r.baseline_json, {}), baseline_hash: String(r.baseline_hash || ''),
  status: String(r.status), attempts: Number(r.attempts),
  result: parseJson(r.result_json, null), result_hash: String(r.result_hash || ''),
  proposals: parseJson(r.proposals_json, []), proposal_ids: parseJson(r.proposal_ids_json, []),
  error: String(r.error || ''), created_at: r.created_at, updated_at: r.updated_at,
} : null;

export function createBatch({ runId, workId, index, chapterIds = [], chapterIndexes = [], chapterHashes = [], chars = 0, baseline = {}, baselineHash = '' }) {
  const info = prepare(`INSERT INTO import_rebuild_batches
    (run_id, work_id, batch_index, chapter_ids_json, chapter_indexes_json, chapter_hashes_json, chars, baseline_json, baseline_hash, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
    .run(Number(runId), Number(workId), num(index), JSON.stringify(chapterIds), JSON.stringify(chapterIndexes),
      JSON.stringify(chapterHashes), num(chars), JSON.stringify(baseline || {}), String(baselineHash), now(), now());
  return getBatch(Number(info.lastInsertRowid));
}

export function getBatch(id) {
  return batchRow(prepare('SELECT * FROM import_rebuild_batches WHERE id = ?').get(Number(id)));
}

export function getBatchByIndex(runId, batchIndex) {
  return batchRow(prepare('SELECT * FROM import_rebuild_batches WHERE run_id = ? AND batch_index = ?').get(Number(runId), num(batchIndex)));
}

export function listBatches(runId) {
  return prepare('SELECT * FROM import_rebuild_batches WHERE run_id = ? ORDER BY batch_index ASC').all(Number(runId)).map(batchRow);
}

export function recordBatch(id, { result = null, resultHash = '', proposals = [], status = 'extracted', attempts = null } = {}) {
  prepare(`UPDATE import_rebuild_batches SET result_json = ?, result_hash = ?, proposals_json = ?, status = ?,
    attempts = COALESCE(?, attempts), error = '', updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(result === null ? null : result), String(resultHash), JSON.stringify(proposals || []),
      String(status), attempts === null || attempts === undefined ? null : num(attempts), now(), Number(id));
  return getBatch(id);
}

export function setBatchStatus(id, status, { error = null, attempts = null } = {}) {
  prepare(`UPDATE import_rebuild_batches SET status = ?, error = COALESCE(?, error),
    attempts = COALESCE(?, attempts), updated_at = ? WHERE id = ?`)
    .run(String(status), error === null || error === undefined ? null : String(error),
      attempts === null || attempts === undefined ? null : num(attempts), now(), Number(id));
  return getBatch(id);
}

export function setBatchProposalIds(id, proposalIds = []) {
  prepare('UPDATE import_rebuild_batches SET proposal_ids_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(proposalIds || []), now(), Number(id));
  return getBatch(id);
}

/** 进度统计（状态端点用）。 */
export function progressOf(runId) {
  const rows = listBatches(runId);
  const by = (s) => rows.filter((b) => b.status === s).length;
  return {
    batches: rows.length,
    pending: by('pending'), extracted: by('extracted'), confirmed: by('confirmed'),
    stale: by('stale'), failed: by('failed'),
    chars: rows.reduce((n, b) => n + b.chars, 0),
    proposals: rows.reduce((n, b) => n + b.proposals.length, 0),
  };
}

export default {
  workExists, chaptersOfWork, chapterById,
  createRun, getRun, listRuns, latestRunFor, setRunStatus, deleteRun,
  createBatch, getBatch, getBatchByIndex, listBatches, recordBatch, setBatchStatus, setBatchProposalIds, progressOf,
};