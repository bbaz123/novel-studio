/**
 * ai/quality-auditor/store.mjs —— 审计账本的**唯一写入口**（DB 访问集中在这一层）。
 *
 * 为什么单独一层：状态迁移、事件流水、租约、token、条目 upsert 都是"必须原子"的操作。
 * 散在 server.js 的 handler 里，任何一处忘了 BEGIN/COMMIT 或忘了校验迁移表，
 * 就会留下半条账本 —— 而审计账本的作用恰恰是"事后能证明发生了什么"。
 *
 * 所有状态变更走 transition()：它先读当前状态、用 contracts.canTransition 判合法、
 * 再在**同一事务**里更新状态与追加事件。插件/重试都不允许跳态。
 */
import { db, withTransaction } from '../../db.js';
import { RUN_STATUS, TERMINAL_STATUSES, canTransition, ERROR_CODES, auditError } from './contracts.mjs';
import { createAuditToken, tokenDigest, tokenMatches, tokenExpired } from './security.mjs';

const nowIso = () => new Date().toISOString();

const json = (v, fallback = '{}') => {
  try { return JSON.stringify(v == null ? JSON.parse(fallback) : v); } catch { return fallback; }
};
const parse = (s, fallback) => {
  try { const v = JSON.parse(s || ''); return v == null ? fallback : v; } catch { return fallback; }
};

/** 行 → 对外对象（camelCase，界面对齐用）。 */
export function runToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    work_id: row.work_id,
    chapter_id: row.chapter_id,
    review_id: row.review_id == null ? null : Number(row.review_id),
    revision_run_id: row.revision_run_id || null,
    status: row.status,
    phase: row.phase || '',
    contract_version: row.contract_version,
    base_hash: row.base_hash,
    candidate_hash: row.candidate_hash || null,
    context_hash: row.context_hash || '',
    manifest: parse(row.input_manifest_json, {}),
    result: row.result_json ? parse(row.result_json, null) : null,
    error_code: row.error_code || '',
    error_detail: row.error_detail || '',
    budget: (() => {
      const raw = Number(row.budget_charged_microunits);
      // 2026-10-22 真实联网演练发现：这个字段**从来没有写入方**，于是所有跑完的审计
      // 都显示"实际 ¥0.00"——而模型确实被调用过（有 blind/compare 产出）。那是在谎报费用。
      // 审计的真实计费发生在 dsh 侧（本服务看不到 token 用量），所以这里按**证据**判：
      //   · >0            → 已结清，已知金额；
      //   · <0（哨兵 -1） → 明确"未结清/未知"；
      //   · 0 且状态已过"已付费"阶段 → 缺记账数据，同样是未知（历史上没人写过，0 不代表免费）。
      //   · 0 且还没走到付费阶段 → 确实还没产生费用。
      const paidPhases = ['BLIND_SUBMITTED', 'COMPARE_RUNNING', 'RESULT_RECEIVED', 'HOST_VERIFIED', 'MERGED', 'COMPLETED'];
      const status = String(row.status || '');
      const known = raw > 0;
      const settledZero = raw === 0 && !paidPhases.includes(status);
      return {
        authorized_microunits: Number(row.budget_authorized_microunits) || 0,
        estimated_microunits: Number(row.budget_estimated_microunits) || 0,
        // null = 未知（不编造 0.00）；界面据此显示"实际费用未知"。
        charged_microunits: known || settledZero ? Math.max(0, raw) : null,
        charge_known: known || settledZero,
        charge_source: known ? 'settled' : (settledZero ? 'not_billed_yet' : 'unknown'),
      };
    })(),
    attempt: Number(row.attempt) || 0,
    lease_owner: row.lease_owner || '',
    lease_expires_at: row.lease_expires_at || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || '',
    terminal: TERMINAL_STATUSES.has(String(row.status)),
  };
}

/**
 * 结清一次审计的费用（**这个字段的唯一写入方**）。
 *
 * 为什么单独一个函数：`budget_charged_microunits` 之前全仓没有写入方，
 * 于是默认值 0 被当成"免费"。现在只有拿到真实用量（子进程回传 / 价目表折算）才写它，
 * 写不成就保持哨兵 -1（未知），读取侧据此显示"实际费用未知"。
 *
 * @param {string} id audit_id
 * @param {{microunits:number, source?:string, detail?:string}} charge
 * @returns {{ok:boolean, microunits?:number, error?:string}}
 */
export function settleCharge(id, charge = {}) {
  const runId = String(id || '');
  if (!runId) return { ok: false, error: '缺少 audit_id' };
  const mu = Number(charge.microunits);
  // 只接受有限非负数；未知/非法一律不写（保持 -1，读取侧就是"未知"）。
  if (!Number.isFinite(mu) || mu < 0) return { ok: false, error: 'microunits 非法' };
  const row = db.prepare('SELECT id FROM quality_audit_runs WHERE id = ?').get(runId);
  if (!row) return { ok: false, error: '审计不存在' };
  db.prepare('UPDATE quality_audit_runs SET budget_charged_microunits = ?, updated_at = ? WHERE id = ?')
    .run(Math.round(mu), new Date().toISOString(), runId);
  appendEvent(runId, 'charge_settled', {
    microunits: Math.round(mu),
    source: String(charge.source || ''),
    detail: String(charge.detail || '').slice(0, 300),
  });
  return { ok: true, microunits: Math.round(mu) };
}

export function getRun(id) {
  return db.prepare('SELECT * FROM quality_audit_runs WHERE id = ?').get(String(id || '')) || null;
}

export function getRunByIdempotencyKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return db.prepare('SELECT * FROM quality_audit_runs WHERE idempotency_key = ?').get(k) || null;
}

/**
 * 创建 run（幂等）。
 * @returns {{ok:true, row:object, created:boolean}|{ok:false, code:string, detail:string}}
 */
export function createRun(input = {}) {
  const id = String(input.id || '');
  if (!id) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, 'createRun 缺少 id');
  const kind = String(input.kind || '');
  if (!['review', 'revision'].includes(kind)) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, `kind 非法：${kind}`);
  const idempotencyKey = String(input.idempotencyKey || '').trim() || null;
  if (idempotencyKey) {
    const existing = getRunByIdempotencyKey(idempotencyKey);
    if (existing) return { ok: true, row: existing, created: false };
  }
  try {
    db.prepare(`INSERT INTO quality_audit_runs
      (id, kind, work_id, chapter_id, review_id, revision_run_id, status, phase, contract_version,
       base_hash, candidate_hash, context_hash, input_manifest_json, idempotency_key,
       token_hash, token_expires_at, budget_authorized_microunits, budget_estimated_microunits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, kind,
      Number(input.workId) || 0, Number(input.chapterId) || 0,
      input.reviewId == null ? null : Number(input.reviewId) || null,
      input.revisionRunId == null ? null : String(input.revisionRunId),
      RUN_STATUS.CREATED, String(input.phase || ''),
      String(input.contractVersion || 'novel-quality-audit.v1'),
      String(input.baseHash || ''), input.candidateHash == null ? null : String(input.candidateHash),
      String(input.contextHash || ''), json(input.manifest, '{}'),
      idempotencyKey,
      String(input.tokenHash || ''), String(input.tokenExpiresAt || ''),
      Number(input.budgetAuthorized) || 0, Number(input.budgetEstimated) || 0,
    );
  } catch (e) {
    // 并发下唯一键冲突：返回已存在的那一条（幂等），而不是 500。
    if (/UNIQUE/i.test(String(e && e.message))) {
      const existing = idempotencyKey ? getRunByIdempotencyKey(idempotencyKey) : getRun(id);
      if (existing) return { ok: true, row: existing, created: false };
    }
    throw e;
  }
  const row = getRun(id);
  appendEvent(id, 'run_created', { kind, work_id: Number(input.workId) || 0, chapter_id: Number(input.chapterId) || 0 });
  return { ok: true, row, created: true };
}

/** 不改状态的字段更新（manifest/result/hash/budget 等）。 */
export function updateRun(id, patch = {}) {
  const map = {
    review_id: 'review_id', revision_run_id: 'revision_run_id', phase: 'phase',
    base_hash: 'base_hash', candidate_hash: 'candidate_hash', context_hash: 'context_hash',
    input_manifest_json: 'input_manifest_json', result_json: 'result_json',
    blind_result_json: 'blind_result_json', initial_report_json: 'initial_report_json',
    error_code: 'error_code', error_detail: 'error_detail',
    token_hash: 'token_hash', token_expires_at: 'token_expires_at',
    budget_authorized_microunits: 'budget_authorized_microunits',
    budget_estimated_microunits: 'budget_estimated_microunits',
    budget_charged_microunits: 'budget_charged_microunits',
    attempt: 'attempt', lease_owner: 'lease_owner', lease_expires_at: 'lease_expires_at',
    completed_at: 'completed_at', contract_version: 'contract_version',
  };
  const sets = [];
  const values = [];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === 'input_manifest_json' || k === 'result_json') v = typeof v === 'string' ? v : json(v);
    if (k === 'blind_result_json' || k === 'initial_report_json') v = typeof v === 'string' ? v : json(v);
    sets.push(`${col} = ?`);
    values.push(v == null ? (['candidate_hash', 'review_id', 'revision_run_id'].includes(k) ? null : '') : v);
  }
  if (!sets.length) return getRun(id);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  db.prepare(`UPDATE quality_audit_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, String(id));
  return getRun(id);
}

/**
 * 状态迁移（唯一入口）：校验迁移表 → 事务内更新 + 追加事件。
 * @returns {{ok:true, row:object}|{ok:false, code:string, detail:string}}
 */
export function transition(id, to, patch = {}, eventType = '') {
  const runId = String(id || '');
  return withTransaction(() => {
    const current = getRun(runId);
    if (!current) return auditError(ERROR_CODES.AUDIT_NOT_FOUND, `audit ${runId} 不存在`);
    const check = canTransition(String(current.status), String(to));
    if (!check.ok) return check;
    if (String(current.status) === String(to)) {
      // 幂等：同状态重复迁移不写事件（避免事件流被重试刷屏）。
      return { ok: true, row: current };
    }
    const merged = { ...patch };
    if ([RUN_STATUS.COMPLETED, RUN_STATUS.CANCELLED, RUN_STATUS.STALE, RUN_STATUS.MERGED].includes(String(to))) {
      merged.completed_at = nowIso();
    }
    updateRun(runId, merged);
    db.prepare("UPDATE quality_audit_runs SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(String(to), runId);
    appendEvent(runId, eventType || `status_${String(to).toLowerCase()}`, {
      from: String(current.status), to: String(to), patch_keys: Object.keys(patch || {}),
    });
    return { ok: true, row: getRun(runId) };
  });
}

/** append-only 事件流：只存形状/长度/hash/状态，不存全文。 */
export function appendEvent(auditId, eventType, shape = {}) {
  const id = String(auditId || '');
  const safeShape = {};
  for (const [k, v] of Object.entries(shape || {})) {
    // 防误存正文：字符串只记长度与前 8 位 hash 形态，绝不落原文。
    if (typeof v === 'string' && v.length > 120) safeShape[k] = { chars: v.length };
    else safeShape[k] = v;
  }
  db.prepare(`INSERT INTO quality_audit_events (audit_id, seq, event_type, payload_shape_json)
    SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM quality_audit_events WHERE audit_id = ?`)
    .run(id, String(eventType || 'event').slice(0, 80), json(safeShape), id);
  return true;
}

export function listEvents(auditId) {
  return db.prepare('SELECT * FROM quality_audit_events WHERE audit_id = ? ORDER BY seq ASC').all(String(auditId || ''))
    .map((r) => ({ seq: Number(r.seq), event_type: r.event_type, payload: parse(r.payload_shape_json, {}), created_at: r.created_at }));
}

/**
 * 条目 upsert（按 audit_id + issue_id + source）。
 * 同一 issue 在一个 source 下只有一行动态；重新提交（允许的场景）覆盖同一行而不是堆积。
 */
export function upsertItems(auditId, items = []) {
  const id = String(auditId || '');
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;
  const stmt = db.prepare(`INSERT INTO quality_audit_items
    (audit_id, issue_id, source, kind, type, severity, confidence, evidence_json, acceptance_json,
     verdict, reason, repair_hint, base_hash, candidate_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(audit_id, issue_id, source) DO UPDATE SET
      kind = excluded.kind, type = excluded.type, severity = excluded.severity, confidence = excluded.confidence,
      evidence_json = excluded.evidence_json, acceptance_json = excluded.acceptance_json,
      verdict = excluded.verdict, reason = excluded.reason, repair_hint = excluded.repair_hint,
      base_hash = excluded.base_hash, candidate_hash = excluded.candidate_hash,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  let n = 0;
  withTransaction(() => {
    for (const it of list) {
      const issueId = String(it.issue_id || '');
      if (!issueId) continue;
      const source = ['initial', 'auditor', 'merged'].includes(String(it.source)) ? String(it.source) : 'auditor';
      const kind = ['finding', 'deferred', 'dispute', 'regression'].includes(String(it.kind)) ? String(it.kind) : 'finding';
      stmt.run(
        id, issueId, source, kind,
        String(it.type || ''), String(it.severity || ''),
        it.confidence == null ? null : Number(it.confidence),
        json(it.evidence, '[]'), json(it.acceptance, '{}'),
        String(it.verdict || ''), String(it.reason || ''), String(it.repair_hint || ''),
        String(it.base_hash || ''), String(it.candidate_hash || ''),
      );
      n += 1;
    }
  });
  return n;
}

export function listItems(auditId, source = '') {
  const rows = source
    ? db.prepare('SELECT * FROM quality_audit_items WHERE audit_id = ? AND source = ? ORDER BY issue_id ASC').all(String(auditId), String(source))
    : db.prepare('SELECT * FROM quality_audit_items WHERE audit_id = ? ORDER BY issue_id ASC').all(String(auditId));
  return rows.map((r) => ({
    audit_id: r.audit_id, issue_id: r.issue_id, source: r.source, kind: r.kind,
    type: r.type, severity: r.severity, confidence: r.confidence == null ? null : Number(r.confidence),
    evidence: parse(r.evidence_json, []), acceptance: parse(r.acceptance_json, {}),
    verdict: r.verdict, reason: r.reason, repair_hint: r.repair_hint,
    base_hash: r.base_hash, candidate_hash: r.candidate_hash,
  }));
}

/** 发一次性 token（只返回明文一次；库里存 digest）。 */
export function issueToken(auditId, ttlMs = 30 * 60 * 1000) {
  const token = createAuditToken();
  const expiresAt = new Date(Date.now() + Math.max(60_000, Number(ttlMs) || 0)).toISOString();
  updateRun(auditId, { token_hash: tokenDigest(token), token_expires_at: expiresAt });
  appendEvent(auditId, 'token_issued', { expires_at: expiresAt, ttl_ms: Number(ttlMs) || 0 });
  return { token, expiresAt };
}

/**
 * token 校验：存在 → 匹配 → 未过期 → run 仍可写。
 * @returns {{ok:true, row:object}|{ok:false, code:string, detail:string}}
 */
export function verifyToken(auditId, token) {
  const row = getRun(auditId);
  if (!row) return auditError(ERROR_CODES.AUDIT_NOT_FOUND, `audit ${auditId} 不存在`);
  if (!row.token_hash) return auditError(ERROR_CODES.AUDIT_TOKEN_INVALID, '该审计没有下发过 token');
  if (!tokenMatches(row.token_hash, token)) return auditError(ERROR_CODES.AUDIT_TOKEN_INVALID, 'token 不匹配');
  if (tokenExpired(row.token_expires_at)) return auditError(ERROR_CODES.AUDIT_TOKEN_EXPIRED, 'token 已过期');
  if (TERMINAL_STATUSES.has(String(row.status)) && String(row.status) !== RUN_STATUS.INTERRUPTED) {
    return auditError(ERROR_CODES.AUDIT_ALREADY_SUBMITTED, `审计已结束（${row.status}）`);
  }
  return { ok: true, row };
}

/** 租约：防止两个 DSH 进程同时写同一次审计（也用于重启后的可恢复判定）。 */
export function claimLease(auditId, owner, ttlMs = 10 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + Math.max(30_000, Number(ttlMs) || 0)).toISOString();
  const row = getRun(auditId);
  if (!row) return auditError(ERROR_CODES.AUDIT_NOT_FOUND, '审计不存在');
  const heldByOther = String(row.lease_owner || '') && String(row.lease_owner) !== String(owner)
    && Date.parse(row.lease_expires_at || '') > Date.now();
  if (heldByOther) return auditError(ERROR_CODES.AUDIT_RESULT_CONFLICT, `租约被 ${row.lease_owner} 持有`);
  updateRun(auditId, { lease_owner: String(owner), lease_expires_at: expiresAt, attempt: (Number(row.attempt) || 0) + 1 });
  appendEvent(auditId, 'lease_claimed', { owner: String(owner), expires_at: expiresAt, attempt: (Number(row.attempt) || 0) + 1 });
  return { ok: true, row: getRun(auditId) };
}

export function releaseLease(auditId) {
  updateRun(auditId, { lease_owner: '', lease_expires_at: '' });
  appendEvent(auditId, 'lease_released', {});
}

/**
 * 重启恢复（CT-10）：进程启动时把"非终态且租约已过期"的 run 标成 INTERRUPTED。
 * 为什么不直接继续跑：DSH 子进程已随上一个进程消失，重建上下文比重新开始更不可靠；
 * 标记 INTERRUPTED 让作者可以安全重跑（新 attempt），而不是永远卡在 RUNNING。
 */
export function recoverInterruptedRuns(now = Date.now()) {
  const rows = db.prepare(`SELECT id, status, lease_expires_at FROM quality_audit_runs
    WHERE status NOT IN (${[...TERMINAL_STATUSES, RUN_STATUS.COMPLETED].map(() => '?').join(',')})`).all(...[...TERMINAL_STATUSES, RUN_STATUS.COMPLETED]);
  let marked = 0;
  for (const r of rows) {
    const lease = Date.parse(r.lease_expires_at || '');
    if (Number.isFinite(lease) && lease > now) continue; // 还有效：留给活着的进程
    const res = transition(r.id, RUN_STATUS.INTERRUPTED, { error_code: 'INTERRUPTED', error_detail: '进程重启：租约失效，可安全重跑' }, 'run_interrupted_on_recovery');
    if (res.ok) marked += 1;
  }
  return marked;
}

/** 某章最新一次审计（界面恢复用）。 */
export function latestForChapter(chapterId, kind = '') {
  const rows = kind
    ? db.prepare('SELECT * FROM quality_audit_runs WHERE chapter_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').all(Number(chapterId) || 0, String(kind))
    : db.prepare('SELECT * FROM quality_audit_runs WHERE chapter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').all(Number(chapterId) || 0);
  return rows[0] || null;
}

export function listForChapter(chapterId, limit = 20) {
  return db.prepare('SELECT * FROM quality_audit_runs WHERE chapter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(Number(chapterId) || 0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

/**
 * candidate hash 变化 → 旧审计立即 STALE（方案 §10.2 / RS-10）。
 * 只动"仍然有效/已收结果但未合并"的那些；COMPLETED/MERGED 是历史事实，不改写。
 */
export function staleRunsForNewCandidate(workId, chapterId, candidateHash) {
  if (!candidateHash) return 0;
  const rows = db.prepare(`SELECT id, candidate_hash, status FROM quality_audit_runs
    WHERE kind = 'revision' AND chapter_id = ? AND status IN (?, ?, ?, ?, ?, ?)`).all(
    Number(chapterId) || 0,
    RUN_STATUS.INPUT_FROZEN, RUN_STATUS.DSH_STARTED, RUN_STATUS.RUNNING,
    RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.HOST_VERIFIED, RUN_STATUS.COMPLETED,
  );
  let n = 0;
  for (const r of rows) {
    if (!r.candidate_hash || String(r.candidate_hash) === String(candidateHash)) continue;
    const res = transition(r.id, RUN_STATUS.STALE, { error_code: ERROR_CODES.AUDIT_STALE_CANDIDATE, error_detail: '候选稿 hash 已变化，旧审计作废' }, 'run_stale_candidate_changed');
    if (res.ok) n += 1;
  }
  return n;
}

/** 供测试与界面读的摘要（不含 token）。 */
export function runSummary(row) {
  const c = runToClient(row);
  if (!c) return null;
  return {
    id: c.id, kind: c.kind, status: c.status, phase: c.phase,
    base_hash: c.base_hash, candidate_hash: c.candidate_hash,
    error_code: c.error_code, attempt: c.attempt,
    created_at: c.created_at, updated_at: c.updated_at, terminal: c.terminal,
    budget: c.budget,
  };
}

export { nowIso };
