#!/usr/bin/env node
/**
 * scripts/quality-auditor/test-contracts.mjs —— 阶段 2 退出断言 CT-01…CT-12（零计费）。
 *
 * 全部用**真实隔离实例**：真实 HTTP + 真实 SQLite（临时目录），不 mock 数据库。
 * 审计一律 `start:false`（外部 runner 模式）：用例自己扮演"DSH 的提交侧"，
 * 因此不拉起模型、不产生费用 —— 而协议、鉴权、状态机、幂等、事务都走真实路径。
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createChecks } from '../../tests/narrative-repair/harness.mjs';
import {
  jfetch, startServer, stopServer, waitReady, freePort, tempDir, cleanup,
  ARTICLE, BLUEPRINT, INITIAL_REPORT, seedReview,
} from './harness.mjs';

const { check, finish } = createChecks();

const PORT = await freePort();
const DATA = tempDir('novel-qa-ct-');
const srv = startServer({ port: PORT, dataDir: DATA });
const base = srv.base;
const ok = await waitReady(base);
if (!ok) {
  console.error('实例未就绪：\n' + srv.log.text.slice(-3000));
  await stopServer(srv);
  cleanup(DATA);
  process.exit(2);
}

const DIMS = ['blueprint', 'continuity', 'character', 'causality', 'repetition', 'style', 'pacing_hook', 'temporal_foreshadowing', 'evidence_integrity'];
const allDims = () => Object.fromEntries(DIMS.map((d) => [d, true]));

function openDb() {
  const db = new DatabaseSync(join(DATA, 'novel.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const work = await jfetch(base, '/api/works', { method: 'POST', body: { title: '审计契约样本' } });
const workId = work.data.id;
const chapter = await jfetch(base, '/api/chapters', {
  method: 'POST',
  body: { work_id: workId, title: '第一章 雨夜', content: ARTICLE.split('\n').map((line) => (line ? `<p>${line}</p>` : '')).join('') },
});
const chapterId = chapter.data.id;
const seeded = await seedReview(base, chapterId);
const reviewId = seeded.data.review_id;

const created = await jfetch(base, '/api/novel/quality-audits', {
  method: 'POST',
  body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, base_hash: 'sha256:fixture-base', start: false },
});
if (created.status !== 201) {
  console.error('CT 前置失败：创建审计失败 ' + JSON.stringify(created.data));
  await stopServer(srv);
  cleanup(DATA);
  process.exit(2);
}
const auditId = created.data.audit_id;
const token = created.data.token;
const TH = { 'x-audit-token': token };

// ── CT-01 ────────────────────────────────────────────────────────────────────
{
  const db = openDb();
  const row = db.prepare('SELECT * FROM quality_audit_runs WHERE id = ?').get(auditId);
  const manifest = JSON.parse(row.input_manifest_json || '{}');
  db.close();
  const st = await jfetch(base, `/api/novel/quality-audits/${auditId}`);
  const names = (manifest.resources || []).map((r) => r.name);
  check('CT-01', '创建 review audit：冻结 article/report/context 的 hash 与 snapshot 清单',
    created.status === 201 && row && row.status === 'INPUT_FROZEN'
      && Boolean(row.base_hash) && Boolean(row.context_hash)
      && names.includes('article') && names.includes('blueprint') && names.includes('context') && names.includes('initial_review')
      && manifest.resources.every((r) => /^sha256:[0-9a-f]{64}$/.test(String(r.sha256)))
      && st.data.run.status === 'INPUT_FROZEN',
    JSON.stringify({ status: row && row.status, names, manifest: manifest.resources.map((r) => r.name) }));
}

// ── CT-02 ────────────────────────────────────────────────────────────────────
const CANDIDATE_TEXT = ARTICLE.replace('信上说三天后见，可今天已经是第四天。', '信上说三天后见，今天正好是第三天。');
let revisionAuditId = '';
let revisionToken = '';
{
  const r = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST',
    body: {
      kind: 'revision', chapter_id: chapterId, review_id: reviewId,
      base_text: ARTICLE, candidate_text: CANDIDATE_TEXT,
      base_hash: 'sha256:fixture-base', candidate_hash: 'sha256:fixture-cand-1',
      selected_issue_ids: ['R-0001'],
      findings: [{ id: 'R-0001', evidence: INITIAL_REPORT.findings[0].evidence, acceptance: INITIAL_REPORT.findings[0].acceptance }],
      patches: [{ issue_id: 'R-0001', original: '信上说三天后见，可今天已经是第四天。', replacement: '信上说三天后见，今天正好是第三天。' }],
      start: false,
    },
  });
  if (r.status === 201) { revisionAuditId = r.data.audit_id; revisionToken = r.data.token; }
  const db = openDb();
  const row = revisionAuditId ? db.prepare('SELECT * FROM quality_audit_runs WHERE id = ?').get(revisionAuditId) : null;
  db.close();
  check('CT-02', '创建 revision audit：冻结 base/candidate/selected findings/patches 的 hash',
    r.status === 201 && row && row.kind === 'revision'
      && row.base_hash === 'sha256:fixture-base' && row.candidate_hash === 'sha256:fixture-cand-1'
      && row.status === 'INPUT_FROZEN',
    JSON.stringify({ status: r.status, data: r.data }).slice(0, 300));
}

// ── CT-03 ────────────────────────────────────────────────────────────────────
{
  const again = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST',
    body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, base_hash: 'sha256:fixture-base', start: false, idempotency_key: 'idem-ct-03' },
  });
  const again2 = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST',
    body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, base_hash: 'sha256:fixture-base', start: false, idempotency_key: 'idem-ct-03' },
  });
  check('CT-03', '同一 idempotency key 重复创建：返回同一 run，不重复扣费/不重复启动',
    again.status === 201 && again2.status === 201 && again.data.audit_id === again2.data.audit_id
      && again2.data.reused === true,
    JSON.stringify({ a: again.data.audit_id, b: again2.data.audit_id, reused: again2.data.reused }));
}

// ── CT-04 ────────────────────────────────────────────────────────────────────
{
  const bad = await jfetch(base, `/api/novel/quality-audits/${auditId}/input-manifest`, { headers: { 'x-audit-token': 'wrong-token' } });
  const db = openDb();
  db.prepare("UPDATE quality_audit_runs SET token_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(auditId);
  db.close();
  const expired = await jfetch(base, `/api/novel/quality-audits/${auditId}/input-manifest`, { headers: TH });
  // 复原 token 期限，继续后续用例
  const db2 = openDb();
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db2.prepare('UPDATE quality_audit_runs SET token_expires_at = ? WHERE id = ?').run(future, auditId);
  db2.close();
  check('CT-04', '错误/过期的一次性 token：401 且不泄露正文',
    bad.status === 401 && bad.data.code === 'AUDIT_TOKEN_INVALID'
      && expired.status === 401 && expired.data.code === 'AUDIT_TOKEN_EXPIRED'
      && !JSON.stringify(bad.data).includes('雨声') && !JSON.stringify(expired.data).includes('雨声'),
    JSON.stringify({ bad: bad.data.code, expired: expired.data.code }));
}

// ── CT-05 ────────────────────────────────────────────────────────────────────
{
  // 第二份**可复核**的审稿（另一个作品/章）。必须让它也能通过结构检查，
  // 否则"跨作品读取"测到的是"审计根本没建出来"，而不是 token 边界。
  const work2 = await jfetch(base, '/api/works', { method: 'POST', body: { title: '另一个作品' } });
  const otherChapter = await jfetch(base, '/api/chapters', {
    method: 'POST',
    body: {
      work_id: work2.data.id,
      title: '第一章',
      content: ARTICLE.split('\n').map((line) => (line ? `<p>${line}</p>` : '')).join(''),
    },
  });
  await seedReview(base, otherChapter.data.id);
  const other = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST', body: { kind: 'review', chapter_id: otherChapter.data.id, base_hash: 'x', start: false },
  });
  const cross = await jfetch(base, `/api/novel/quality-audits/${other.data.audit_id}/resources/article`, { headers: TH });
  const unknown = await jfetch(base, `/api/novel/quality-audits/${auditId}/resources/not_a_resource`, { headers: TH });
  const foreignOrigin = await jfetch(base, `/api/novel/quality-audits/${auditId}/input-manifest`, {
    headers: { ...TH, origin: 'http://evil.example' },
  });
  check('CT-05', '跨作品读取 / 未知资源 / 非本机 Origin：全部拒绝并记录，不返回别的作品正文',
    other.status === 201
      && cross.status === 401 && cross.data.code === 'AUDIT_TOKEN_INVALID'
      && unknown.status === 409 && unknown.data.code === 'AUDIT_SCOPE_MISMATCH'
      && foreignOrigin.status === 403 && foreignOrigin.data.code === 'AUDIT_FORBIDDEN_ORIGIN',
    JSON.stringify({ cross: cross.data.code, unknown: unknown.data.code, origin: foreignOrigin.data.code }));
}

// ── CT-00：真实 start:true 路径的状态机（外部 runner 模式测不到这一条）───────────
{
  // 只有真实子进程才会停在 DSH_STARTED；它必须能直接提交 blind（模型在联调中真的撞到了这条）。
  const mod = await import('../../ai/quality-auditor/contracts.mjs');
  const t1 = mod.canTransition('DSH_STARTED', 'BLIND_SUBMITTED');
  const t2 = mod.canTransition('DSH_STARTED', 'RESULT_RECEIVED');
  const t3 = mod.canTransition('INPUT_FROZEN', 'BLIND_SUBMITTED');
  check('CT-00', 'DSH_STARTED 可直接进 BLIND_SUBMITTED / RESULT_RECEIVED（真实 start:true 路径）',
    t1.ok === true && t2.ok === true && t3.ok === true,
    JSON.stringify({ dsh2blind: t1.ok, dsh2result: t2.ok, input2blind: t3.ok }));
  // token 通道的只读自查入口（插件 novel_quality_status 依赖它）
  const st = await jfetch(base, `/api/novel/quality-audits/${auditId}/status`, { headers: TH });
  const stBad = await jfetch(base, `/api/novel/quality-audits/${auditId}/status`, { headers: { 'x-audit-token': 'nope' } });
  check('CT-00b', '/status 只读入口存在且校验 token；返回缺失要求与状态',
    st.status === 200 && st.data.ok === true && Array.isArray(st.data.missing_requirements)
    && st.data.audit_id === auditId && stBad.status === 401,
    JSON.stringify({ ok: st.status, bad: stBad.status }));
}

// ── CT-00c：旧格式审稿（字符串 issues、无 findings）也能发起独立复核 ─────────────
{
  const legacyChapter = await jfetch(base, '/api/chapters', {
    method: 'POST',
    body: {
      work_id: workId,
      title: '旧报告章',
      content: ARTICLE.split('\n').map((l) => `<p>${l}</p>`).join(''),
    },
  });
  const legacyReview = await jfetch(base, '/api/novel/review', {
    method: 'PUT',
    body: { chapter_id: legacyChapter.data.id, base_text: ARTICLE, base_hash: 'sha256:legacy', report: { summary: '旧格式', issues: ['问题一', '问题二'] } },
  });
  const created = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST',
    body: { kind: 'review', chapter_id: legacyChapter.data.id, review_id: legacyReview.data.review_id, start: false },
  });
  check('CT-00c', '旧格式审稿（无 findings）不被判 REVIEW_ID_MAPPING_BROKEN，可发起独立复核且标记 legacy',
    created.status === 201 && created.data.integrity && created.data.integrity.legacy === true
      && created.data.integrity.code === 'REVIEW_LEGACY_NO_EVIDENCE' && created.data.status === 'INPUT_FROZEN',
    JSON.stringify({ status: created.status, code: created.data.code, integrity: created.data.integrity && created.data.integrity.code }));
}

// ── 正常流程（盲审 → 对照 → 校验 → 合并）：也是 RV/IT 的前置 ────────────────────
{
  const manifest = await jfetch(base, `/api/novel/quality-audits/${auditId}/input-manifest`, { headers: TH });
  const articleRes = (manifest.data.resources || []).find((r) => r.name === 'article') || {};
  const total = Number(articleRes.chars) || 0;
  // 分页读取（RV-11 的前置：必须真的能读到全文）
  let cursor = 0;
  let seen = 0;
  let pages = 0;
  const blindBeforeCompare = await jfetch(base, `/api/novel/quality-audits/${auditId}/resources/initial_review`, { headers: TH });
  while (cursor != null && pages < 20) {
    const page = await jfetch(base, `/api/novel/quality-audits/${auditId}/resources/article?cursor=${cursor}&limit=50`, { headers: TH });
    if (page.status !== 200) break;
    seen += Number(page.data.chars) || 0;
    pages += 1;
    cursor = page.data.next_cursor;
  }
  check('CT-05b', 'blind 阶段禁止读初审（防锚定）；正文可完整分页读完',
    blindBeforeCompare.status === 409 && blindBeforeCompare.data.code === 'AUDIT_PHASE_INVALID'
      && seen === total && pages > 1,
    JSON.stringify({ initial: blindBeforeCompare.data.code, seen, total, pages }));

  const blindPayload = {
    scanned_ranges: [[0, total]],
    findings: [{
      id: 'QA-R-0001', type: 'continuity', severity: 'high', confidence: 0.92,
      title: '陈默“第三次想起那封信”与前文的首次提及不一致',
      explanation: '正文只写了这一封信，却称第三次想起，读者无法回溯前两次',
      evidence: [{ quote: '他第三次想起那封信' }],
      acceptance: { rule: '删除“第三次”或补足前两次的回想', preserve: ['那封信'] },
    }],
  };
  const blind = await jfetch(base, `/api/novel/quality-audits/${auditId}/submissions`, {
    method: 'POST', headers: TH, body: { operation: 'blind_draft', payload: blindPayload },
  });
  const afterBlind = await jfetch(base, `/api/novel/quality-audits/${auditId}`);
  const nowCanRead = await jfetch(base, `/api/novel/quality-audits/${auditId}/resources/initial_review`, { headers: TH });

  const finalPayload = {
    schema_version: 'review-audit.v1',
    base_hash: 'sha256:fixture-base',
    coverage: { resources: [{ name: 'article', ranges: [[0, total]], complete: true }], dimensions: allDims() },
    initial_findings: [
      { issue_id: 'R-0001', verdict: 'COVERED', reason: '时间线矛盾确实存在' },
      { issue_id: 'R-0002', verdict: 'DISPUTED', reason: '比喻与雨声意象一致，不构成模板句' },
    ],
    new_findings: [],
    verdict: 'COMPLETE_WITH_EVIDENCE',
  };
  const final = await jfetch(base, `/api/novel/quality-audits/${auditId}/submissions`, {
    method: 'POST', headers: TH, body: { operation: 'final', payload: finalPayload },
  });
  const verified = await jfetch(base, `/api/novel/quality-audits/${auditId}/verify`, { method: 'POST', body: {} });
  const merged = await jfetch(base, `/api/novel/quality-audits/${auditId}/merge`, { method: 'POST', body: {} });
  const reviewed = await jfetch(base, `/api/novel/review?chapter_id=${chapterId}`);
  check('CT-06', '盲审提交后解锁 compare，final 通过校验后进入 RESULT_RECEIVED → HOST_VERIFIED → 合并',
    blind.status === 200 && ['BLIND_SUBMITTED', 'COMPARE_RUNNING'].includes(String(blind.data.status))
      && afterBlind.data.run.phase === 'compare'
      && nowCanRead.status === 200
      && final.status === 200 && final.data.status === 'RESULT_RECEIVED'
      && verified.status === 200 && verified.data.status === 'HOST_VERIFIED'
      && merged.status === 200 && merged.data.status === 'COMPLETED'
      && merged.data.review_id > 0
      && reviewed.data.review && reviewed.data.review.id === merged.data.review_id,
    JSON.stringify({ blind: blind.data.status, phase: afterBlind.data.run.phase, final: final.data.status, verified: verified.data.status, merged: merged.data.status }));
}

// ── CT-06b（方案 CT-06 的另一条）：candidate hash 不一致 → STALE ────────────────
{
  const finalPayload = {
    schema_version: 'revision-audit.v1',
    base_hash: 'sha256:fixture-base',
    candidate_hash: 'sha256:OTHER',
    issues: [{ issue_id: 'R-0001', verdict: 'PASS', reason: '已改', remaining_evidence: [], checks: [], repair_hint: '' }],
    regressions: [], unauthorized_changes: [], overall: 'PASS',
  };
  const bad = await jfetch(base, `/api/novel/quality-audits/${revisionAuditId}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': revisionToken },
    body: { operation: 'final', payload: finalPayload },
  });
  check('CT-06b', 'candidate hash 与冻结值不一致：结果标记 STALE（AUDIT_STALE_CANDIDATE），不能进入终验',
    bad.status === 422 && bad.data.code === 'AUDIT_STALE_CANDIDATE',
    JSON.stringify(bad.data));
}

// ── 供 CT-07/08/09 使用的"干净审计" ─────────────────────────────────────────────
async function freshReviewAudit() {
  const r = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST',
    body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, base_hash: 'sha256:fixture-base', start: false },
  });
  return { id: r.data.audit_id, token: r.data.token, status: r.status };
}
async function submitBlindEmpty(id, token) {
  const m = await jfetch(base, `/api/novel/quality-audits/${id}/input-manifest`, { headers: { 'x-audit-token': token } });
  const total = Number(((m.data.resources || []).find((r) => r.name === 'article') || {}).chars) || 0;
  return jfetch(base, `/api/novel/quality-audits/${id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': token },
    body: { operation: 'blind_draft', payload: { scanned_ranges: [[0, total]], findings: [] } },
  });
}
const goodFinal = () => ({
  schema_version: 'review-audit.v1',
  base_hash: 'sha256:fixture-base',
  coverage: { resources: [{ name: 'article', ranges: [[0, 400]], complete: true }], dimensions: allDims() },
  initial_findings: [
    { issue_id: 'R-0001', verdict: 'COVERED', reason: '时间线矛盾确实存在' },
    { issue_id: 'R-0002', verdict: 'COVERED', reason: '比喻确实偏模板' },
  ],
  new_findings: [],
  verdict: 'COMPLETE_WITH_EVIDENCE',
});

// ── CT-07 ────────────────────────────────────────────────────────────────────
{
  const a = await freshReviewAudit();
  const huge = {
    scanned_ranges: [[0, 10]],
    findings: [{ id: 'QA-R-0009', evidence: [{ quote: 'x'.repeat(600 * 1024) }] }],
  };
  const r = await jfetch(base, `/api/novel/quality-audits/${a.id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': a.token }, body: { operation: 'blind_draft', payload: huge },
  });
  const db = openDb();
  const row = db.prepare('SELECT status FROM quality_audit_runs WHERE id = ?').get(a.id);
  db.close();
  check('CT-07', '超大结果体：按契约上限拒绝（413 / AUDIT_PAYLOAD_TOO_LARGE），run 保持原状态',
    r.status === 413 && String(r.data.code || '').startsWith('AUDIT_PAYLOAD_TOO_LARGE')
      && row.status === 'INPUT_FROZEN',
    JSON.stringify({ status: r.status, code: r.data.code, run: row.status }));
}

// ── CT-08 ────────────────────────────────────────────────────────────────────
{
  const a = await freshReviewAudit();
  const blind = await submitBlindEmpty(a.id, a.token);
  const f1 = await jfetch(base, `/api/novel/quality-audits/${a.id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': a.token }, body: { operation: 'final', payload: goodFinal() },
  });
  const f2 = await jfetch(base, `/api/novel/quality-audits/${a.id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': a.token }, body: { operation: 'final', payload: goodFinal() },
  });
  const different = goodFinal();
  different.new_findings = [{ id: 'QA-R-0002', type: 'style', severity: 'low', confidence: 0.7, title: '另一处模板句', explanation: 'x', evidence: [{ quote: '雨点砸在窗上' }], acceptance: { rule: '不得再用模板句', preserve: [] } }];
  const f3 = await jfetch(base, `/api/novel/quality-audits/${a.id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': a.token }, body: { operation: 'final', payload: different },
  });
  check('CT-08', '重复 final：相同摘要幂等成功（200 + idempotent），不同摘要冲突拒绝（409）',
    blind.status === 200 && f1.status === 200 && f1.data.status === 'RESULT_RECEIVED'
      && f2.status === 200 && f2.data.idempotent === true
      && f3.status === 409 && f3.data.code === 'AUDIT_RESULT_CONFLICT',
    JSON.stringify({ blind: blind.data.status, f1: f1.data.status, f2: f2.data.idempotent, f3: f3.data.code }));
}

// ── CT-09 ────────────────────────────────────────────────────────────────────
{
  const a = await freshReviewAudit();
  const c = await jfetch(base, `/api/novel/quality-audits/${a.id}/cancel`, { method: 'POST', body: {} });
  const after = await jfetch(base, `/api/novel/quality-audits/${a.id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': a.token }, body: { operation: 'final', payload: goodFinal() },
  });
  check('CT-09', '取消运行：进入 CANCELLED，之后 token 不能再写',
    c.status === 200 && c.data.status === 'CANCELLED'
      && after.status === 409
      && after.data.code === 'AUDIT_ALREADY_SUBMITTED',
    JSON.stringify({ cancel: c.data.status, after: after.status, code: after.data.code }));
}

// ── CT-11 ────────────────────────────────────────────────────────────────────
{
  // 用一条新的 review 审计验证"契约不合法时不留半条账本"
  const r = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST', body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, base_hash: 'x', start: false },
  });
  const id = r.data.audit_id;
  const t = r.data.token;
  const mf = await jfetch(base, `/api/novel/quality-audits/${id}/input-manifest`, { headers: { 'x-audit-token': t } });
  const total = Number(((mf.data.resources || []).find((r) => r.name === 'article') || {}).chars) || 0;
  await jfetch(base, `/api/novel/quality-audits/${id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': t },
    body: { operation: 'blind_draft', payload: { scanned_ranges: [[0, total]], findings: [] } },
  });
  const badFinal = await jfetch(base, `/api/novel/quality-audits/${id}/submissions`, {
    method: 'POST', headers: { 'x-audit-token': t },
    body: { operation: 'final', payload: { schema_version: 'review-audit.v1', coverage: { resources: [] }, dimensions: {} } },
  });
  const db = openDb();
  const run = db.prepare('SELECT status, result_json FROM quality_audit_runs WHERE id = ?').get(id);
  const itemCount = db.prepare('SELECT COUNT(*) n FROM quality_audit_items WHERE audit_id = ?').get(id).n;
  const auditorItems = db.prepare("SELECT COUNT(*) n FROM quality_audit_items WHERE audit_id = ? AND source = 'auditor'").get(id).n;
  db.close();
  check('CT-11', '契约不合法的提交：拒绝且不留半条账本（run 停在原状态、result 为空）',
    badFinal.status === 422 && badFinal.data.code === 'AUDIT_CONTRACT_INVALID'
      && run.status === 'COMPARE_RUNNING' && !String(run.result_json || '').trim()
      // 初始 items（source=initial，2 条初审 finding）是创建时冻结的，属正常；
      // 关键是没有半条 auditor/merged 条目、没有 result。
      && Number(auditorItems) === 0,
    JSON.stringify({ status: run.status, result: run.result_json, items: itemCount, auditor: auditorItems, err: badFinal.data.code }));
}

// ── CT-13：依赖可见性与一键安装端点（插件内置化的服务端面）──────────────────
{
  const env = await jfetch(base, '/api/env/tools');
  const q = env.data && env.data.dsh && env.data.dsh.plugins ? env.data.dsh.plugins.qualityAuditor : null;
  const inst = await jfetch(base, '/api/env/plugins/install', { method: 'POST', body: { name: 'quality-auditor', dry_run: true } });
  check('CT-13', '/env/tools 暴露审计插件状态与 dsh 版本/启动方式；一键安装 dry-run 只报告不改盘',
    env.status === 200 && q && typeof q.ready === 'boolean' && Array.isArray(q.installs)
      && typeof env.data.dsh.version === 'string' && env.data.dsh.launcher
      && Array.isArray(env.data.dsh.missing_dependencies)
      && inst.status === 200 && inst.data.dry_run === true && inst.data.ready === true,
    JSON.stringify({ ready: q && q.ready, version: env.data && env.data.dsh && env.data.dsh.version, launcher: env.data && env.data.dsh && env.data.dsh.launcher && env.data.dsh.launcher.kind, inst: inst.data && { ready: inst.data.ready, dry: inst.data.dry_run } }));
}

// ── CT-10 / CT-12 需要重启：先标一条"运行中且租约过期"的 run ──────────────────
let restartId = '';
{
  const r = await jfetch(base, '/api/novel/quality-audits', {
    method: 'POST', body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, base_hash: 'x', start: false },
  });
  restartId = r.data.audit_id;
  const db = openDb();
  db.prepare(`UPDATE quality_audit_runs SET status = 'RUNNING', lease_owner = 'dead', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(restartId);
  db.close();
}

const migrationsBefore = (() => {
  const db = openDb();
  const n = db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n;
  db.close();
  return Number(n);
})();

await stopServer(srv);
const srv2 = startServer({ port: PORT, dataDir: DATA });
const ready2 = await waitReady(srv2.base);
if (!ready2) {
  console.error('重启后实例未就绪：\n' + srv2.log.text.slice(-3000));
  await stopServer(srv2); cleanup(DATA); process.exit(2);
}
{
  const st = await jfetch(srv2.base, `/api/novel/quality-audits/${restartId}`);
  const db = openDb();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)));
  const migrationsAfter = Number(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n);
  db.close();
  check('CT-10', '服务重启后读取进行中的 run：租约失效 → 明确标记 INTERRUPTED（可安全重跑）',
    st.data.run.status === 'INTERRUPTED',
    JSON.stringify({ status: st.data.run.status }));
  check('CT-12', '旧数据库重复启动：迁移幂等（账本条数不增），三张审计表已在',
    migrationsAfter === migrationsBefore
      && tables.has('quality_audit_runs') && tables.has('quality_audit_items') && tables.has('quality_audit_events'),
    JSON.stringify({ before: migrationsBefore, after: migrationsAfter }));
}

await stopServer(srv2);
cleanup(DATA);
finish('CT-01…CT-12 审计契约/数据库/API');
