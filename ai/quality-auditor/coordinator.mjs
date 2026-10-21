/**
 * ai/quality-auditor/coordinator.mjs —— 审计生命周期的**唯一协调者**。
 *
 * 职责边界（方案 §8 / §9 / §10）：
 *   · 创建 run：先跑免费确定性检查，通过才冻结输入、下发一次性 token；
 *   · 启动 DSH：注入 token 与范围，**不以子进程退出码判定成功**；
 *   · 接收提交：blind 先冻结、compare 才开放初审；final 通过 schema/quote/hash/coverage 校验；
 *   · 主机校验：RESULT_RECEIVED → HOST_VERIFIED 必须重新核验，不能"收到了就算过"；
 *   · 合并：初审 + 盲审 + 对照 → 合并报告；修稿 → 逐项终态。
 *
 * 关键约束：DSH 侧只有"提交成功"这一条路径能推进状态；自然语言总结不算完成。
 */
import { randomBytes } from 'node:crypto';
import {
  RUN_STATUS, PHASES, ERROR_CODES, LIMITS, BLIND_FORBIDDEN_RESOURCES, DIMENSIONS,
  auditError, checkPayloadSize, validateBlindDraftPayload, validateReviewAuditPayload,
  validateRevisionAuditPayload, quoteExists,
} from './contracts.mjs';
import * as store from './store.mjs';
import { normalizeResources, buildManifest, contextHash, readResourceSlice, rangesCover } from './snapshots.mjs';
import { reviewIntegrityCheck } from './review-integrity.mjs';
import { revisionIntegrityCheck } from './revision-integrity.mjs';
import { mergeReview } from './merge-review.mjs';
import { mergeRevision } from './merge-revision.mjs';
import { budgetGuard, cnyToMicrounits } from './budget.mjs';
import { runNovelQualityAuditTask } from './harness-task.mjs';
import { statusPayload } from './status.mjs';
import { verifyQuotes } from './evidence.mjs';

/** 资源正文只活在内存里：DB 存清单与 hash，不存正文（作者资产不进审计账本）。 */
const RESOURCES = new Map();
const ACTIVE = new Map();

export function newAuditId() {
  return 'qa_' + randomBytes(8).toString('hex');
}

export function registerResources(auditId, resources) {
  RESOURCES.set(String(auditId), resources);
}

export function getResources(auditId) {
  return RESOURCES.get(String(auditId)) || null;
}

export function dropResources(auditId) {
  RESOURCES.delete(String(auditId));
}

const parseJson = (s, fb) => { try { const v = JSON.parse(s || ''); return v == null ? fb : v; } catch { return fb; } };

/**
 * 创建审稿审计。
 * @returns {{ok:true, run:object, token:string, integrity:object}|{ok:false, code:string, detail:string, integrity?:object, budget?:object}}
 */
export function createReviewAudit(input = {}) {
  const workId = Number(input.workId) || 0;
  const chapterId = Number(input.chapterId) || 0;
  if (!workId || !chapterId) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '缺少 work_id / chapter_id');
  const initialReport = input.initialReport && typeof input.initialReport === 'object' ? input.initialReport : null;
  if (!initialReport) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, '缺少初审报告快照');

  const resources = normalizeResources({
    ...(input.resources || {}),
    initial_review: JSON.stringify(initialReport),
  });
  const articleText = String(resources.article || '');
  if (!articleText.trim()) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, '被审正文为空：不能对空正文做盲审');

  // ① 免费结构检查（失败则不创建 run、不启动 DSH）
  const integrity = reviewIntegrityCheck(initialReport, articleText);
  if (!integrity.ok) {
    return { ok: false, code: integrity.code, detail: `审稿报告结构不完整（${integrity.code}）`, integrity };
  }

  const budget = budgetGuard({
    estimatedCny: input.estimatedCny,
    authorizedCny: input.authorizedCny,
    spentTotalCny: input.spentTotalCny,
  });
  if (!budget.ok) return { ok: false, code: budget.code, detail: budget.detail, budget };

  const id = String(input.auditId || newAuditId());
  const manifest = buildManifest(resources);
  const ctxHash = contextHash(resources);
  const created = store.createRun({
    id, kind: 'review', workId, chapterId,
    reviewId: input.reviewId == null ? null : Number(input.reviewId),
    phase: PHASES.BLIND,
    baseHash: String(input.baseHash || resources.article_sha256 || ''),
    contextHash: ctxHash,
    manifest,
    idempotencyKey: input.idempotencyKey,
    initialReportJson: initialReport,
    budgetEstimated: cnyToMicrounits(budget.estimated_cny || 0),
    budgetAuthorized: cnyToMicrounits(budget.limits.single_cny),
  });
  if (!created.ok) return created;
  if (!created.created) {
    // 幂等命中：不重复下发 token（调用方应使用已有 token；这里返回 run 与"未新建"标记）。
    return { ok: true, run: created.row, token: '', integrity, reused: true };
  }
  const runId = created.row.id;
  registerResources(runId, resources);
  // 初审 findings/issues 落成 source=initial 的条目（合并时是"初审侧"）
  store.upsertItems(runId, initialItems(initialReport, String(input.baseHash || '')));
  const frozen = store.transition(runId, RUN_STATUS.INPUT_FROZEN, {});
  if (!frozen.ok) return frozen;
  const issued = store.issueToken(runId, input.tokenTtlMs);
  return { ok: true, run: store.getRun(runId), token: issued.token, integrity, reused: false };
}

/**
 * 创建修稿审计。
 * @returns {{ok:true, run:object, token:string, deterministic:object}|{ok:false, code:string, detail:string, deterministic?:object, budget?:object}}
 */
export function createRevisionAudit(input = {}) {
  const workId = Number(input.workId) || 0;
  const chapterId = Number(input.chapterId) || 0;
  if (!workId || !chapterId) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '缺少 work_id / chapter_id');
  const resources = normalizeResources(input.resources || {});
  const baseText = String(resources.base_article || '');
  const candidateText = String(resources.candidate || '');
  if (!baseText.trim() || !candidateText.trim()) {
    return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, '底稿或候选稿为空：不能做逐项终验');
  }
  const selectedIssueIds = (Array.isArray(input.selectedIssueIds) ? input.selectedIssueIds : []).map(String);
  if (!selectedIssueIds.length) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, '没有已选问题：没有可终验的对象');

  // ① 确定性检查：硬失败（hash 不一致/越权补丁/保护区被改）时不创建 run、不花钱
  const deterministic = revisionIntegrityCheck({
    baseText, candidateText,
    baseHash: String(input.baseHash || ''),
    candidateHash: String(input.candidateHash || ''),
    expectedBaseHash: String(input.expectedBaseHash || input.baseHash || ''),
    expectedCandidateHash: String(input.expectedCandidateHash || input.candidateHash || ''),
    selectedIssueIds,
    findings: Array.isArray(input.findings) ? input.findings : [],
    patches: Array.isArray(input.patches) ? input.patches : [],
    protectedSpans: Array.isArray(input.protectedSpans) ? input.protectedSpans : [],
  });
  if (!deterministic.ok) {
    const stale = (deterministic.hard_failures || []).some((h) => /hash/i.test(String(h.name)));
    return {
      ok: false,
      code: stale ? ERROR_CODES.AUDIT_STALE_CANDIDATE : ERROR_CODES.AUDIT_CONTRACT_INVALID,
      detail: (deterministic.hard_failures || []).map((h) => h.detail).join('；'),
      deterministic,
    };
  }

  const budget = budgetGuard({
    estimatedCny: input.estimatedCny,
    authorizedCny: input.authorizedCny,
    spentTotalCny: input.spentTotalCny,
  });
  if (!budget.ok) return { ok: false, code: budget.code, detail: budget.detail, budget };

  const id = String(input.auditId || newAuditId());
  const manifest = buildManifest(resources);
  const created = store.createRun({
    id, kind: 'revision', workId, chapterId,
    revisionRunId: input.revisionRunId == null ? null : String(input.revisionRunId),
    phase: PHASES.REVISION,
    baseHash: String(input.baseHash || ''),
    candidateHash: String(input.candidateHash || ''),
    contextHash: contextHash(resources),
    manifest,
    idempotencyKey: input.idempotencyKey,
    budgetEstimated: cnyToMicrounits(budget.estimated_cny || 0),
    budgetAuthorized: cnyToMicrounits(budget.limits.single_cny),
  });
  if (!created.ok) return created;
  if (!created.created) return { ok: true, run: created.row, token: '', deterministic, reused: true };

  const runId = created.row.id;
  registerResources(runId, resources);
  store.upsertItems(runId, (Array.isArray(input.findings) ? input.findings : []).map((f) => ({
    issue_id: String(f && f.id || ''), source: 'initial', kind: 'finding',
    type: String(f && f.type || ''), severity: String(f && f.severity || ''),
    confidence: f && f.confidence == null ? null : Number(f.confidence),
    evidence: Array.isArray(f && f.evidence) ? f.evidence : [],
    acceptance: (f && f.acceptance) || {},
    base_hash: String(input.baseHash || ''), candidate_hash: String(input.candidateHash || ''),
  })).filter((x) => x.issue_id));
  // 新候选 → 旧审计作废（方案 §10.2）
  store.staleRunsForNewCandidate(workId, chapterId, String(input.candidateHash || ''));
  const frozen = store.transition(runId, RUN_STATUS.INPUT_FROZEN, {});
  if (!frozen.ok) return frozen;
  const issued = store.issueToken(runId, input.tokenTtlMs);
  return { ok: true, run: store.getRun(runId), token: issued.token, deterministic, reused: false };
}

function initialItems(report, baseHash) {
  const out = [];
  for (const f of Array.isArray(report && report.findings) ? report.findings : []) {
    out.push({
      issue_id: String(f && f.id || ''), source: 'initial', kind: 'finding',
      type: String(f && f.type || ''), severity: String(f && f.severity || ''),
      confidence: f && f.confidence == null ? null : Number(f.confidence),
      evidence: Array.isArray(f && f.evidence) ? f.evidence : [],
      acceptance: (f && f.acceptance) || {},
      base_hash: baseHash,
    });
  }
  return out.filter((x) => x.issue_id);
}

/**
 * 启动 DSH 子进程。返回 {ok, done}：done 是"子进程结束 + 账本收尾"的 Promise。
 * 调用方（HTTP）应立即返回，让界面轮询状态；不要阻塞请求等几分钟。
 */
export function startAudit(runId, opts = {}) {
  const id = String(runId || '');
  const verified = store.verifyToken(id, opts.token);
  if (!verified.ok) return verified;
  const run = verified.row;
  if (ACTIVE.has(id)) return auditError(ERROR_CODES.AUDIT_RESULT_CONFLICT, '该审计已在运行');
  const lease = store.claimLease(id, `server:${process.pid}`, Number(opts.leaseTtlMs) || 15 * 60 * 1000);
  if (!lease.ok) return lease;
  const started = store.transition(id, RUN_STATUS.DSH_STARTED, {});
  if (!started.ok) { store.releaseLease(id); return started; }

  const controller = new AbortController();
  ACTIVE.set(id, { controller });
  const runOnce = async (repairHint) => runNovelQualityAuditTask({
    auditId: id,
    auditToken: opts.token,
    kind: String(run.kind || ''),
    workId: run.work_id,
    chapterId: run.chapter_id,
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    signal: controller.signal,
    onChunk: opts.onChunk,
    repairHint,
  });
  const done = runOnce('').then(async (first) => {
    // 解析失败只允许**一次**契约修复重试（方案 §13）：仅当账本还没有任何提交、
    // 且失败指纹像"模型侧 JSON/流损坏"时才重试；其它失败（鉴权/超时）重试只会再烧一次钱。
    const afterFirst = store.getRun(id);
    const submittedYet = Boolean(afterFirst && (String(afterFirst.blind_result_json || '').trim() || String(afterFirst.result_json || '').trim()));
    const retryable = !first.ok && !submittedYet && /MALFORMED_RESPONSE|invalid JSON|stream/i.test(String(first.error_message || ''));
    if (!retryable) return first;
    store.appendEvent(id, 'contract_repair_retry', { first_error: String(first.error_code || ''), reason: 'MALFORMED_RESPONSE' });
    const second = await runOnce('上一次工具调用的 JSON 损坏（MALFORMED_RESPONSE）。请把结果拆小：一次最多 3 条 finding、每条 quote ≤200 字，并确保字符串正确转义后重新提交。');
    return second;
  }).then((task) => {
    ACTIVE.delete(id);
    const current = store.getRun(id);
    if (!current) return { ok: false, code: ERROR_CODES.AUDIT_NOT_FOUND };
    // 子进程正常退出 ≠ 审计完成：只有账本里出现 final 提交才算（方案 §8.2）。
    if ([RUN_STATUS.DSH_STARTED, RUN_STATUS.RUNNING, RUN_STATUS.BLIND_SUBMITTED, RUN_STATUS.COMPARE_RUNNING].includes(String(current.status))) {
      const code = task.ok ? ERROR_CODES.AUDIT_NOT_SUBMITTED : ERROR_CODES.AUDIT_NOT_SUBMITTED;
      store.transition(id, RUN_STATUS.AUDIT_NOT_SUBMITTED, {
        error_code: code,
        error_detail: task.ok
          ? 'DSH 进程已结束，但没有收到 novel_quality_submit(final) 的结构化提交'
            + (task.output ? `；模型结尾：${String(task.output).slice(-700)}` : '')
          : `DSH 进程失败（${task.error_code}）：${String(task.error_message || '').slice(0, 900)}`,
      }, 'audit_not_submitted');
    }
    store.releaseLease(id);
    return { ok: true, audit_id: id, task_ok: task.ok, status: (store.getRun(id) || {}).status || '' };
  }).catch((e) => {
    ACTIVE.delete(id);
    const current = store.getRun(id);
    if (current && [RUN_STATUS.DSH_STARTED, RUN_STATUS.RUNNING].includes(String(current.status))) {
      store.transition(id, RUN_STATUS.FAILED_DSH, { error_code: ERROR_CODES.AUDIT_CONTRACT_INVALID, error_detail: String(e && e.message || e).slice(0, 300) });
    }
    store.releaseLease(id);
    return { ok: false, code: ERROR_CODES.AUDIT_CONTRACT_INVALID, detail: String(e && e.message || e) };
  });
  return { ok: true, audit_id: id, done, run: store.runToClient(store.getRun(id)) };
}

export function cancelAudit(runId, reason = '作者取消') {
  const id = String(runId || '');
  const active = ACTIVE.get(id);
  if (active) {
    try { active.controller.abort(); } catch (_) { /* 已结束 */ }
    ACTIVE.delete(id);
  }
  const res = store.transition(id, RUN_STATUS.CANCELLED, { error_code: ERROR_CODES.AUDIT_CANCELLED, error_detail: String(reason).slice(0, 300) }, 'run_cancelled');
  if (res.ok) dropResources(id);
  return res;
}

/** blind 提交：校验 → 冻结 → 进入 compare。 */
export function submitBlind(runId, token, payload) {
  const id = String(runId || '');
  const verified = store.verifyToken(id, token);
  if (!verified.ok) return verified;
  const run = verified.row;
  if (String(run.kind) !== 'review') return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, '只有 review 审计有 blind 阶段');
  if (String(run.blind_result_json || '').trim()) return auditError(ERROR_CODES.AUDIT_ALREADY_SUBMITTED, 'blind 结果已冻结，不允许覆盖');
  // 允许 INPUT_FROZEN：那是"外部 runner"模式（创建时 start:false，由调用方自己拉起 DSH）。
  // 安全性不变 —— 仍然必须持有一次性 token；这里只是不强制服务器亲自 spawn。
  if (![RUN_STATUS.INPUT_FROZEN, RUN_STATUS.DSH_STARTED, RUN_STATUS.RUNNING].includes(String(run.status))) {
    return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, `当前状态 ${run.status} 不接受 blind 提交`);
  }
  const size = checkPayloadSize(payload);
  if (!size.ok) return size;
  const val = validateBlindDraftPayload(payload);
  if (!val.ok) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, val.errors.slice(0, 5).join('；'));
  const resources = getResources(id);
  if (!resources) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '输入快照已不在内存（服务可能重启过）：请重跑本次审计');
  const article = String(resources.article || '');

  // 证据必须逐字存在（PL-07）
  const quotes = [];
  for (const f of Array.isArray(payload.findings) ? payload.findings : []) {
    for (const e of Array.isArray(f && f.evidence) ? f.evidence : []) quotes.push(e && e.quote);
  }
  const q = verifyQuotes(article, quotes);
  if (!q.ok) return auditError(ERROR_CODES.AUDIT_QUOTE_NOT_FOUND, `有 ${q.missing.length} 条引用不在正文：${q.missing.slice(0, 3).map((s) => String(s).slice(0, 30)).join(' / ')}`);

  // 必须真的扫过全文（PL-06 / RV-11）
  const cov = rangesCover(payload.scanned_ranges, article.length);
  if (!cov.ok) return auditError(ERROR_CODES.AUDIT_COVERAGE_INCOMPLETE, `扫描区间有空洞：${JSON.stringify(cov.gaps.slice(0, 3))}`);

  const r1 = store.transition(id, RUN_STATUS.BLIND_SUBMITTED, { blind_result_json: payload, phase: PHASES.COMPARE }, 'blind_submitted');
  if (!r1.ok) return r1;
  store.upsertItems(id, (Array.isArray(payload.findings) ? payload.findings : []).map((f) => ({
    issue_id: String(f && f.id || ''), source: 'auditor', kind: 'finding',
    type: String(f && f.type || ''), severity: String(f && f.severity || ''),
    confidence: f && f.confidence == null ? null : Number(f.confidence),
    evidence: Array.isArray(f && f.evidence) ? f.evidence : [],
    acceptance: (f && f.acceptance) || {},
    base_hash: String(run.base_hash || ''),
  })).filter((x) => x.issue_id));
  const r2 = store.transition(id, RUN_STATUS.COMPARE_RUNNING, {}, 'compare_started');
  if (!r2.ok) return r2;
  return { ok: true, run: store.runToClient(store.getRun(id)) };
}

/** final 提交：review 的对照结论 / revision 的逐项终验。 */
export function submitFinal(runId, token, payload) {
  const id = String(runId || '');
  const verified = store.verifyToken(id, token);
  if (!verified.ok) return verified;
  const run = verified.row;
  const size = checkPayloadSize(payload);
  if (!size.ok) return size;

  // 重复提交：摘要相同 → 幂等成功；不同 → 冲突（CT-08）
  const prev = parseJson(run.result_json, null);
  const resultHash = JSON.stringify(payload);
  if (run.result_json) {
    if (JSON.stringify(prev) === resultHash) return { ok: true, run: store.runToClient(run), idempotent: true };
    return auditError(ERROR_CODES.AUDIT_RESULT_CONFLICT, 'final 结果已收到且摘要不同：拒绝覆盖');
  }

  const resources = getResources(id);
  if (!resources) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '输入快照已不在内存（服务可能重启过）：请重跑本次审计');

  if (String(run.kind) === 'review') {
    if (![RUN_STATUS.BLIND_SUBMITTED, RUN_STATUS.COMPARE_RUNNING].includes(String(run.status))) {
      return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, `review 的 final 必须在 compare 阶段提交（当前 ${run.status}）`);
    }
    const val = validateReviewAuditPayload(payload);
    if (!val.ok) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, val.errors.slice(0, 6).join('；'));
    // 初审每一条都要有对照结论（漏判 = 无法证明"逐项对照过"）
    const initialReport = parseJson(run.initial_report_json, {});
    const initialIds = (Array.isArray(initialReport.findings) ? initialReport.findings : []).map((f) => String(f && f.id));
    const covered = new Set((Array.isArray(payload.initial_findings) ? payload.initial_findings : []).map((i) => String(i && i.issue_id)));
    const missing = initialIds.filter((x) => !covered.has(x));
    if (missing.length) return auditError(ERROR_CODES.AUDIT_COVERAGE_INCOMPLETE, `初审这些条目没有对照结论：${missing.slice(0, 5).join('、')}`);
    // 新 finding 的证据必须逐字存在
    const article = String(resources.article || '');
    const bad = [];
    for (const f of Array.isArray(payload.new_findings) ? payload.new_findings : []) {
      for (const e of Array.isArray(f && f.evidence) ? f.evidence : []) {
        const quote = String(e && (e.quote != null ? e.quote : e));
        if (quote && !quoteExists(article, quote)) bad.push(quote.slice(0, 30));
      }
    }
    if (bad.length) return auditError(ERROR_CODES.AUDIT_QUOTE_NOT_FOUND, `复审新增有 ${bad.length} 条引用不在正文`);
    const baseHash = String(payload.base_hash || '');
    if (baseHash && baseHash !== String(run.base_hash || '')) {
      return auditError(ERROR_CODES.AUDIT_HASH_MISMATCH, '结果里的 base_hash 与冻结输入不一致');
    }
    const r = store.transition(id, RUN_STATUS.RESULT_RECEIVED, { result_json: payload }, 'result_received');
    if (!r.ok) return r;
    return { ok: true, run: store.runToClient(store.getRun(id)) };
  }

  // revision
  if (![RUN_STATUS.INPUT_FROZEN, RUN_STATUS.DSH_STARTED, RUN_STATUS.RUNNING].includes(String(run.status))) {
    return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, `revision 的 final 必须在运行中提交（当前 ${run.status}）`);
  }
  const selectedFindings = store.listItems(id, 'initial').map((i) => ({
    id: i.issue_id, evidence: i.evidence, acceptance: i.acceptance,
  }));
  const selectedIssueIds = selectedFindings.map((f) => f.id);
  const val = validateRevisionAuditPayload(payload, { selectedIssueIds });
  if (!val.ok) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, val.errors.slice(0, 6).join('；'));
  // candidate hash 必须匹配（RS-10 / CT-06）
  const cand = String(payload.candidate_hash || '');
  if (cand && cand !== String(run.candidate_hash || '')) {
    return auditError(ERROR_CODES.AUDIT_STALE_CANDIDATE, 'candidate_hash 与本次审计绑定的候选稿不一致（STALE）');
  }
  // 残留证据必须真的还在候选稿里（模型说"还残留"也要有原文）
  const candidate = String(resources.candidate || '');
  for (const it of Array.isArray(payload.issues) ? payload.issues : []) {
    for (const e of Array.isArray(it && it.remaining_evidence) ? it.remaining_evidence : []) {
      const quote = String(e && (e.quote != null ? e.quote : e)).trim();
      if (quote && !quoteExists(candidate, quote)) {
        return auditError(ERROR_CODES.AUDIT_QUOTE_NOT_FOUND, `remaining_evidence 不在候选稿里：${quote.slice(0, 30)}`);
      }
    }
  }
  const r = store.transition(id, RUN_STATUS.RESULT_RECEIVED, { result_json: payload }, 'result_received');
  if (!r.ok) return r;
  store.upsertItems(id, (Array.isArray(payload.issues) ? payload.issues : []).map((it) => ({
    issue_id: String(it && it.issue_id || ''), source: 'auditor', kind: 'finding',
    evidence: Array.isArray(it && it.remaining_evidence) ? it.remaining_evidence : [],
    verdict: String(it && it.verdict || ''), reason: String(it && it.reason || ''),
    repair_hint: String(it && it.repair_hint || ''),
    candidate_hash: String(run.candidate_hash || ''),
  })).filter((x) => x.issue_id));
  return { ok: true, run: store.runToClient(store.getRun(id)) };
}

/** 主机校验：重新核验，不"收到就算过"。 */
export function hostVerify(runId) {
  const id = String(runId || '');
  const run = store.getRun(id);
  if (!run) return auditError(ERROR_CODES.AUDIT_NOT_FOUND, '审计不存在');
  if (String(run.status) !== RUN_STATUS.RESULT_RECEIVED) {
    return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, `只有 RESULT_RECEIVED 可以主机校验（当前 ${run.status}）`);
  }
  const payload = parseJson(run.result_json, null);
  if (!payload) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, '结果为空');
  const resources = getResources(id);
  if (!resources) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '输入快照已不在内存：无法复核（请重跑）');

  if (String(run.kind) === 'review') {
    if (!String(run.blind_result_json || '').trim()) {
      return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, '没有 blind 结果：无法证明先盲后对照');
    }
    const val = validateReviewAuditPayload(payload);
    if (!val.ok) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, val.errors.slice(0, 5).join('；'));
  } else {
    const selectedIssueIds = store.listItems(id, 'initial').map((i) => i.issue_id);
    const val = validateRevisionAuditPayload(payload, { selectedIssueIds });
    if (!val.ok) return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, val.errors.slice(0, 5).join('；'));
  }
  const r = store.transition(id, RUN_STATUS.HOST_VERIFIED, {}, 'host_verified');
  if (!r.ok) return r;
  return { ok: true, run: store.runToClient(store.getRun(id)) };
}

/** 合并：review 生成合并报告；revision 生成逐项终态。 */
export function mergeAudit(runId) {
  const id = String(runId || '');
  const run = store.getRun(id);
  if (!run) return auditError(ERROR_CODES.AUDIT_NOT_FOUND, '审计不存在');
  if (String(run.status) !== RUN_STATUS.HOST_VERIFIED) {
    return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, `只有 HOST_VERIFIED 可以合并（当前 ${run.status}）`);
  }
  const resources = getResources(id);
  if (!resources) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '输入快照已不在内存：无法合并（请重跑）');

  let merged;
  if (String(run.kind) === 'review') {
    const initialReport = parseJson(run.initial_report_json, {});
    const blind = parseJson(run.blind_result_json, {});
    const compare = parseJson(run.result_json, {});
    merged = mergeReview({ initialReport, blind, compare });
    store.upsertItems(id, merged.findings.map((f) => ({
      issue_id: f.issue_id, source: 'merged', kind: 'finding',
      type: f.type, severity: f.severity, confidence: f.confidence,
      evidence: f.evidence, acceptance: f.acceptance,
      verdict: f.review_verdict || '', reason: f.disputed ? 'DISPUTED' : '',
      base_hash: String(run.base_hash || ''),
    })));
  } else {
    const deterministic = revisionIntegrityCheck({
      baseText: String(resources.base_article || ''),
      candidateText: String(resources.candidate || ''),
      baseHash: String(run.base_hash || ''),
      candidateHash: String(run.candidate_hash || ''),
      selectedIssueIds: store.listItems(id, 'initial').map((i) => i.issue_id),
      findings: store.listItems(id, 'initial').map((i) => ({ id: i.issue_id, evidence: i.evidence, acceptance: i.acceptance })),
      patches: parseJson(resources.patch_trace, []),
    });
    merged = mergeRevision({ deterministic, auditor: parseJson(run.result_json, {}), round: 0, maxRounds: 2 });
    store.upsertItems(id, merged.issues.map((m) => ({
      issue_id: m.issue_id, source: 'merged', kind: 'finding',
      verdict: m.final, reason: m.final_reason || '',
      repair_hint: String((m.checks || []).filter((c) => c.pass === false).map((c) => c.evidence).join('；')).slice(0, 1000),
      candidate_hash: String(run.candidate_hash || ''),
    })));
  }
  const r1 = store.transition(id, RUN_STATUS.MERGED, { result_json: { ...parseJson(run.result_json, {}), merged } }, 'merged');
  if (!r1.ok) return r1;
  const r2 = store.transition(id, RUN_STATUS.COMPLETED, {}, 'completed');
  if (!r2.ok) return r2;
  dropResources(id);
  return { ok: true, run: store.runToClient(store.getRun(id)), merged };
}

/** DSH 读取入口：清单。 */
export function inputManifest(runId, token) {
  const verified = store.verifyToken(runId, token);
  if (!verified.ok) return verified;
  const run = verified.row;
  const manifest = parseJson(run.input_manifest_json, {});
  return {
    ok: true,
    audit_id: run.id,
    kind: run.kind,
    phase: run.phase,
    contract_version: run.contract_version,
    base_hash: run.base_hash,
    candidate_hash: run.candidate_hash || null,
    resources: manifest.resources || [],
    required_outputs: manifest.required_outputs || ['coverage', 'findings', 'verdict'],
  };
}

/** DSH 读取入口：分页资源（blind 阶段禁止读初审）。 */
export function readResource(runId, token, name, cursor, limit) {
  const verified = store.verifyToken(runId, token);
  if (!verified.ok) return verified;
  const run = verified.row;
  if (String(run.phase) === PHASES.BLIND && BLIND_FORBIDDEN_RESOURCES.has(String(name))) {
    return auditError(ERROR_CODES.AUDIT_PHASE_INVALID, `blind 阶段不允许读取 ${name}（先提交 blind_draft）`);
  }
  const resources = getResources(runId);
  if (!resources) return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, '输入快照已不在内存（服务可能重启过）：请重跑本次审计');
  const page = readResourceSlice(resources, name, cursor, limit);
  if (!page.ok) return page;
  store.appendEvent(runId, 'resource_read', { name: String(name), cursor: Number(cursor) || 0, chars: page.chars });
  return page;
}

/** 只读状态（插件 novel_quality_status 用）。 */
export function statusFor(runId, token) {
  const verified = store.verifyToken(runId, token);
  if (!verified.ok) return verified;
  const run = verified.row;
  const payload = parseJson(run.result_json, null);
  const blind = parseJson(run.blind_result_json, null);
  const items = store.listItems(runId, 'merged').length
    ? store.listItems(runId, 'merged')
    : store.listItems(runId, 'auditor');
  return {
    ok: true,
    ...statusPayload(run, {
      hasBlind: Boolean(blind),
      hasFinal: Boolean(payload),
      coverage: payload && payload.coverage ? payload.coverage : null,
    }),
    counts: {
      initial: store.listItems(runId, 'initial').length,
      auditor: store.listItems(runId, 'auditor').length,
      merged: store.listItems(runId, 'merged').length,
    },
    issues: items.map((i) => ({ issue_id: i.issue_id, verdict: i.verdict, kind: i.kind })),
    dimensions: DIMENSIONS,
    limits: { max_body_bytes: LIMITS.maxBodyBytes, max_quote_chars: LIMITS.maxQuoteChars },
  };
}
