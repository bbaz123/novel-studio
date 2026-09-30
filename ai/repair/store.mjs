/**
 * ai/repair/store.mjs —— 分析/修复运行的持久状态机（story_repair_runs / story_repair_steps）。
 *
 * 纪律：
 *   · 运行与步骤只描述**任务状态**；正文与正式状态只能在 T4 的 apply 里原子切换；
 *   · 运行可恢复：状态、覆盖、断点、失败原因、幂等键、租约与 fencing token 全部落库；
 *   · 中间步骤绝不写 `chapters.content`、绝不写正式角色状态（由调用方保证；本模块只碰运行表）。
 */
import { db } from '../../db.js';
import { sha16 } from '../story-state/temporal/schema.mjs';

const RUN_STATUSES = new Set(['queued', 'running', 'paused', 'stale', 'ready', 'applied', 'failed', 'cancelled', 'needs_review', 'reverted']);
const STEP_STATUSES = new Set(['queued', 'validating', 'kept', 'repairing', 'repaired', 'blocked', 'needs_review', 'failed', 'cancelled', 'stale', 'valid', 'conflict']);

const now = () => new Date().toISOString();
const parse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

export function publicRun(row) {
  if (!row) return null;
  return {
    id: String(row.id), work_id: Number(row.work_id), mode: String(row.mode),
    root_chapter_id: Number(row.root_chapter_id), base_commit_id: String(row.base_commit_id),
    working_worldline_id: row.working_worldline_id ? String(row.working_worldline_id) : null,
    status: String(row.status),
    baseline: parse(row.baseline_json, {}), policy: parse(row.policy_json, {}),
    authorization: parse(row.authorization_json, {}), coverage: parse(row.coverage_json, {}),
    result: parse(row.result_json, {}), idempotency_key: String(row.idempotency_key || ''),
    lease_owner: row.lease_owner ? String(row.lease_owner) : null,
    lease_expires_at: row.lease_expires_at ? String(row.lease_expires_at) : null,
    fencing_token: Number(row.fencing_token) || 0,
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export function publicStep(row) {
  if (!row) return null;
  return {
    id: String(row.id), work_id: Number(row.work_id), run_id: String(row.run_id),
    chapter_id: Number(row.chapter_id), step_key: String(row.step_key),
    input_fingerprint: String(row.input_fingerprint || ''), attempt: Number(row.attempt) || 1,
    status: String(row.status),
    candidate_revision_id: row.candidate_revision_id ? String(row.candidate_revision_id) : null,
    candidate_binding_id: row.candidate_binding_id ? String(row.candidate_binding_id) : null,
    result: parse(row.result_json, {}),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export function getRun(id) {
  const row = db.prepare('SELECT * FROM story_repair_runs WHERE id = ?').get(String(id || ''));
  return row ? publicRun(row) : null;
}

export function listRuns(workId, { mode = null, status = null, limit = 20 } = {}) {
  const where = ['work_id = ?'];
  const args = [Number(workId) || 0];
  if (mode) { where.push('mode = ?'); args.push(String(mode)); }
  if (status) { where.push('status = ?'); args.push(String(status)); }
  const rows = db.prepare(`SELECT * FROM story_repair_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, Math.max(1, Math.min(Number(limit) || 20, 200)));
  return rows.map(publicRun);
}

/** 同一作品 + 幂等键的非终态运行复用（AC-22：同一按钮重复点击不重复建运行）。 */
export function findReusableRun(workId, idempotencyKey) {
  const key = String(idempotencyKey || '');
  if (!key) return null;
  const row = db.prepare(`SELECT * FROM story_repair_runs
    WHERE work_id = ? AND idempotency_key = ? AND status IN ('queued','running','paused','ready','needs_review')
    ORDER BY created_at DESC LIMIT 1`).get(Number(workId) || 0, key);
  return row ? publicRun(row) : null;
}

export function createRun({
  workId, mode = 'analyze', rootChapterId, baseCommitId, workingWorldlineId = null,
  baseline = {}, policy = {}, authorization = {}, coverage = {}, result = {}, idempotencyKey = '',
} = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('createRun: 缺少 workId');
  if (!['analyze', 'repair'].includes(String(mode))) throw new Error(`createRun: 未知 mode ${mode}`);
  const reusable = findReusableRun(w, idempotencyKey);
  if (reusable) return { run: reusable, reused: true };
  const material = `${w}|${mode}|${Number(rootChapterId) || 0}|${String(baseCommitId || '')}|${String(idempotencyKey || '')}|${now()}`;
  const id = 'run_' + sha16(material);
  const ts = now();
  db.prepare(`INSERT INTO story_repair_runs
      (id, work_id, mode, root_chapter_id, base_commit_id, working_worldline_id, status,
       baseline_json, policy_json, authorization_json, coverage_json, result_json, idempotency_key,
       lease_owner, lease_expires_at, fencing_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`)
    .run(id, w, String(mode), Number(rootChapterId) || 0, String(baseCommitId || ''), workingWorldlineId ? String(workingWorldlineId) : null,
      JSON.stringify(baseline || {}), JSON.stringify(policy || {}), JSON.stringify(authorization || {}),
      JSON.stringify(coverage || {}), JSON.stringify(result || {}), String(idempotencyKey || ''), ts, ts);
  return { run: getRun(id), reused: false };
}

export function updateRun(id, patch = {}) {
  const run = getRun(id);
  if (!run) throw new Error(`updateRun: 运行不存在 ${id}`);
  const next = {
    status: patch.status === undefined ? run.status : String(patch.status),
    coverage: patch.coverage === undefined ? run.coverage : patch.coverage,
    result: patch.result === undefined ? run.result : patch.result,
    authorization: patch.authorization === undefined ? run.authorization : patch.authorization,
    working_worldline_id: patch.workingWorldlineId === undefined ? run.working_worldline_id : patch.workingWorldlineId,
  };
  if (!RUN_STATUSES.has(next.status)) throw new Error(`updateRun: 非法状态 ${next.status}`);
  db.prepare(`UPDATE story_repair_runs SET status = ?, coverage_json = ?, result_json = ?, authorization_json = ?, working_worldline_id = ?, updated_at = ? WHERE id = ?`)
    .run(next.status, JSON.stringify(next.coverage || {}), JSON.stringify(next.result || {}), JSON.stringify(next.authorization || {}),
      next.working_worldline_id ? String(next.working_worldline_id) : null, now(), run.id);
  return getRun(run.id);
}

/** 获取/续租执行租约（T4 runner 用；旧 fencing token 的 worker 不得写入）。 */
export function acquireLease({ runId, owner, ttlMs = 60 * 1000 } = {}) {
  const run = getRun(runId);
  if (!run) return { ok: false, reason: '运行不存在' };
  const stamp = now();
  const active = run.lease_owner && run.lease_expires_at && run.lease_expires_at > stamp && run.lease_owner !== String(owner || '');
  if (active) return { ok: false, reason: `运行被 ${run.lease_owner} 持有（租约至 ${run.lease_expires_at}）`, fenced: true };
  const token = run.fencing_token + 1;
  db.prepare('UPDATE story_repair_runs SET lease_owner = ?, lease_expires_at = ?, fencing_token = ?, updated_at = ? WHERE id = ?')
    .run(String(owner || 'runner'), new Date(Date.now() + Math.max(1000, Number(ttlMs) || 60000)).toISOString(), token, stamp, run.id);
  return { ok: true, run: getRun(run.id), fencing_token: token };
}

export function releaseLease(runId) {
  db.prepare('UPDATE story_repair_runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(now(), String(runId || ''));
  return getRun(runId);
}

export function addStep({ runId, workId, chapterId, stepKey = 'main', inputFingerprint = '', status = 'queued', attempt = 1, result = {} } = {}) {
  if (!STEP_STATUSES.has(String(status))) throw new Error(`addStep: 非法状态 ${status}`);
  const id = 'step_' + sha16(`${runId}|${chapterId}|${stepKey}|${attempt}|${now()}`);
  const ts = now();
  db.prepare(`INSERT INTO story_repair_steps
      (id, work_id, run_id, chapter_id, step_key, input_fingerprint, attempt, status, candidate_revision_id, candidate_binding_id, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
    .run(id, Number(workId) || 0, String(runId), Number(chapterId) || 0, String(stepKey), String(inputFingerprint || ''),
      Math.max(1, Number(attempt) || 1), String(status), JSON.stringify(result || {}), ts, ts);
  return publicStep(db.prepare('SELECT * FROM story_repair_steps WHERE id = ?').get(id));
}

export function updateStep(id, patch = {}) {
  const row = db.prepare('SELECT * FROM story_repair_steps WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error(`updateStep: 步骤不存在 ${id}`);
  const step = publicStep(row);
  const status = patch.status === undefined ? step.status : String(patch.status);
  if (!STEP_STATUSES.has(status)) throw new Error(`updateStep: 非法状态 ${status}`);
  db.prepare(`UPDATE story_repair_steps SET status = ?, result_json = ?, candidate_revision_id = ?, candidate_binding_id = ?, attempt = ?, updated_at = ? WHERE id = ?`)
    .run(status, JSON.stringify(patch.result === undefined ? step.result : patch.result),
      patch.candidateRevisionId === undefined ? step.candidate_revision_id : patch.candidateRevisionId,
      patch.candidateBindingId === undefined ? step.candidate_binding_id : patch.candidateBindingId,
      Math.max(1, Number(patch.attempt) || step.attempt), now(), step.id);
  return publicStep(db.prepare('SELECT * FROM story_repair_steps WHERE id = ?').get(step.id));
}

export function listSteps(runId) {
  return db.prepare('SELECT * FROM story_repair_steps WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(String(runId || '')).map(publicStep);
}
