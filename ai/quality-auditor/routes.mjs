/**
 * ai/quality-auditor/routes.mjs —— 质量审计的 HTTP 接口（方案 §7）。
 *
 * 为什么单独成文件而不是继续往 server.js 里堆：审计接口有独立的鉴权模型
 * （作者通道 vs DSH token 通道）、独立的体积上限与错误码。混进 10000 行的 handleAPI，
 * 下一次改动很容易把 token 校验漏在某个分支上 —— 那是安全边界，不该靠"记得"。
 *
 * 通道：
 *   · 作者通道（界面）：创建 / 列表 / 状态 / 启动 / 取消 / 主机校验 / 合并；
 *   · DSH 通道（子进程）：input-manifest / resources / submissions，必须带 `x-audit-token`。
 *
 * 所有路由先过 checkAuditRequest（Host/Origin 必须是本机）。
 */
import { db } from '../../db.js';
import { htmlToPlain } from '../../text-utils.js';
import { sendJSON, sendError, readBody, MAX_BODY_BYTES } from '../http/respond.mjs';
import * as store from './store.mjs';
import * as coordinator from './coordinator.mjs';
import { checkAuditRequest } from './security.mjs';
import { ERROR_CODES, LIMITS, RUN_STATUS } from './contracts.mjs';
import { statusPayload, RUN_STATUS_LABELS } from './status.mjs';
import { auditPluginStatus } from './provision.mjs';

const TOKEN_HEADER = 'x-audit-token';

function tokenOf(req, body) {
  return String((req && req.headers ? req.headers[TOKEN_HEADER] : '') || (body && body.token) || '');
}

function fail(res, status, code, detail = '') {
  return sendJSON(res, status, { ok: false, error: detail || code, code, detail });
}

function chapterRow(chapterId) {
  return db.prepare('SELECT * FROM chapters WHERE id = ?').get(Number(chapterId) || 0) || null;
}

function latestBlueprintText(chapter) {
  try {
    const row = db.prepare('SELECT blueprint_json FROM chapter_blueprints WHERE chapter_id = ? ORDER BY id DESC LIMIT 1')
      .get(Number(chapter.id)) || null;
    if (row && row.blueprint_json) return String(row.blueprint_json);
  } catch (_) { /* 旧库可能没有该表 */ }
  return String(chapter.blueprint_json || '');
}

function buildContextText(workId) {
  const parts = [];
  try {
    const chars = db.prepare('SELECT name, role, description FROM characters WHERE work_id = ? ORDER BY id ASC LIMIT 40').all(Number(workId));
    if (chars.length) {
      parts.push('【角色】');
      for (const c of chars) parts.push(`- ${c.name}${c.role ? `（${c.role}）` : ''}：${String(c.description || '').slice(0, 200)}`);
    }
  } catch (_) { /* 忽略 */ }
  try {
    const worlds = db.prepare('SELECT title, content FROM world_entries WHERE work_id = ? ORDER BY position ASC LIMIT 40').all(Number(workId));
    if (worlds.length) {
      parts.push('【世界观】');
      for (const w of worlds) parts.push(`- ${w.title}：${String(htmlToPlain(w.content || '')).slice(0, 200)}`);
    }
  } catch (_) { /* 忽略 */ }
  const text = parts.join('\n');
  return text.length > 20000 ? text.slice(0, 20000) + '\n……（已按预算截断）' : text;
}

function buildReviewResources(chapter) {
  const article = htmlToPlain(chapter.content || '');
  return {
    article,
    blueprint: latestBlueprintText(chapter),
    context: buildContextText(chapter.work_id),
  };
}

/**
 * 处理 `/api/novel/quality-audits/...`。
 * @returns {Promise<boolean>} true = 已处理（调用方直接 return）
 */
export async function handleQualityAuditRoutes(req, res, segments, query, method) {
  const audit = segments[0] === 'quality-audits';
  if (!audit) return false;

  const gate = checkAuditRequest(req);
  if (!gate.ok) {
    fail(res, 403, gate.code, gate.detail);
    return true;
  }
  const id = segments[1] ? String(segments[1]) : '';
  const action = segments[2] ? String(segments[2]) : '';

  // ── 作者通道：列表 ───────────────────────────────────────────────────────────
  if (!id && method === 'GET') {
    const chapterId = Number(query.chapter_id);
    if (!chapterId) return (sendError(res, 400, '缺少 chapter_id'), true);
    const kind = String(query.kind || '');
    const rows = store.listForChapter(chapterId, 20).filter((r) => !kind || String(r.kind) === kind);
    const latest = rows[0] || null;
    return (sendJSON(res, 200, {
      ok: true,
      chapter_id: chapterId,
      latest: latest ? { ...store.runSummary(latest), status_label: RUN_STATUS_LABELS[String(latest.status)] || latest.status } : null,
      runs: rows.map((r) => ({ ...store.runSummary(r), status_label: RUN_STATUS_LABELS[String(r.status)] || r.status })),
    }), true);
  }

  // ── 作者通道：创建 ───────────────────────────────────────────────────────────
  if (!id && method === 'POST') {
    let body;
    try { body = await readBody(req, { maxBytes: LIMITS.maxBodyBytes }); } catch (e) {
      fail(res, 413, ERROR_CODES.AUDIT_PAYLOAD_TOO_LARGE, String(e && e.message || e));
      return true;
    }
    const kind = String(body.kind || '');
    const chapterId = Number(body.chapter_id);
    const chapter = chapterRow(chapterId);
    if (!chapter) { fail(res, 404, ERROR_CODES.AUDIT_SCOPE_MISMATCH, '章节不存在'); return true; }
    if (Number(body.work_id) && Number(body.work_id) !== Number(chapter.work_id)) {
      fail(res, 400, ERROR_CODES.AUDIT_SCOPE_MISMATCH, '章节不属于该作品'); return true;
    }
    const baseUrl = String(body.base_url || `http://127.0.0.1:${process.env.PORT || 3737}`).replace(/\/+$/, '');

    // 插件没装就**别创建 run**：否则会留下一条永远 INPUT_FROZEN 的账本，作者也不知道原因。
    const plugin = auditPluginStatus();
    if (!plugin.ready) {
      fail(res, 409, 'AUDIT_PLUGIN_NOT_INSTALLED',
        '审计插件还没装进 dsh 的 novel profile：请在「AI 设置 → 工具与环境清单」点「一键安装」，或运行 harness-plugins/dsh-novel-quality-auditor/scripts/install.mjs');
      return true;
    }

    if (kind === 'review') {
      // 初审报告优先级：显式传入 > 数据库里指定 review_id > 本章最新审稿
      let reviewRow = null;
      if (body.review_id) reviewRow = db.prepare('SELECT * FROM chapter_reviews WHERE id = ?').get(Number(body.review_id)) || null;
      else reviewRow = db.prepare('SELECT * FROM chapter_reviews WHERE chapter_id = ? ORDER BY id DESC LIMIT 1').get(chapterId) || null;
      if (!reviewRow) { fail(res, 404, 'AUDIT_NOT_FOUND', '没有可复核的初审报告'); return true; }
      let report = null;
      try { report = JSON.parse(reviewRow.normalized_report_json || 'null'); } catch (_) { report = null; }
      if (!report || !report.schema_version) {
        let raw = {};
        try { raw = JSON.parse(reviewRow.report_json || '{}'); } catch (_) { raw = {}; }
        report = await import('../editing/review-contract.mjs')
          .then((m) => m.normalizeStoredReviewReport(raw, reviewRow.id));
      }
      const out = coordinator.createReviewAudit({
        workId: chapter.work_id, chapterId, reviewId: reviewRow.id,
        initialReport: report,
        resources: buildReviewResources(chapter),
        baseHash: String(body.base_hash || report.review_hash || ''),
        idempotencyKey: body.idempotency_key,
        estimatedCny: body.estimated_cost_cny,
        authorizedCny: body.authorized_cny,
        spentTotalCny: body.spent_total_cny,
      });
      if (!out.ok) { fail(res, out.code === ERROR_CODES.AUDIT_BUDGET_EXCEEDED ? 402 : 422, out.code, out.detail); return true; }
      const started = body.start === false ? null : coordinator.startAudit(out.run.id, { token: out.token, baseUrl, timeoutMs: Number(body.timeout_ms) || undefined });
      sendJSON(res, 201, {
        ok: true, audit_id: out.run.id, token: out.token, kind: 'review',
        status: (store.getRun(out.run.id) || {}).status || '',
        integrity: out.integrity,
        reused: Boolean(out.reused),
        started: Boolean(started && started.ok),
        start_error: started && !started.ok ? { code: started.code, detail: started.detail } : null,
        run: store.runToClient(store.getRun(out.run.id)),
      });
      return true;
    }

    if (kind === 'revision') {
      const article = htmlToPlain(chapter.content || '');
      const baseText = String(body.base_text || article);
      const candidateText = String(body.candidate_text || '');
      if (!candidateText.trim()) { fail(res, 400, ERROR_CODES.AUDIT_CONTRACT_INVALID, '缺少 candidate_text（候选稿正文）'); return true; }
      const selectedIssueIds = (Array.isArray(body.selected_issue_ids) ? body.selected_issue_ids : []).map(String);
      if (!selectedIssueIds.length) { fail(res, 400, ERROR_CODES.AUDIT_CONTRACT_INVALID, '缺少 selected_issue_ids'); return true; }
      // 选中的 findings 从审稿报告里取（按稳定 id），不在请求体里重复传正文。
      let findings = [];
      if (body.review_id) {
        const row = db.prepare('SELECT * FROM chapter_reviews WHERE id = ?').get(Number(body.review_id)) || null;
        if (row) {
          let rep = null;
          try { rep = JSON.parse(row.normalized_report_json || 'null'); } catch (_) { rep = null; }
          if (rep && Array.isArray(rep.findings)) {
            const byId = new Map(rep.findings.map((f) => [String(f && f.id), f]));
            findings = selectedIssueIds.map((sid) => byId.get(String(sid))).filter(Boolean);
          }
        }
      }
      if (Array.isArray(body.findings)) findings = body.findings;
      const out = coordinator.createRevisionAudit({
        workId: chapter.work_id, chapterId,
        revisionRunId: body.revision_run_id,
        baseHash: String(body.base_hash || ''),
        candidateHash: String(body.candidate_hash || ''),
        selectedIssueIds,
        findings,
        resources: {
          base_article: baseText,
          candidate: candidateText,
          selected_findings: JSON.stringify(findings.map((f) => ({ id: f && f.id, evidence: f && f.evidence, acceptance: f && f.acceptance }))),
          patch_trace: JSON.stringify(Array.isArray(body.patches) ? body.patches : []),
          context: buildContextText(chapter.work_id),
        },
        patches: Array.isArray(body.patches) ? body.patches : [],
        protectedSpans: Array.isArray(body.protected_spans) ? body.protected_spans : [],
        idempotencyKey: body.idempotency_key,
        estimatedCny: body.estimated_cost_cny,
        authorizedCny: body.authorized_cny,
        spentTotalCny: body.spent_total_cny,
      });
      if (!out.ok) { fail(res, out.code === ERROR_CODES.AUDIT_BUDGET_EXCEEDED ? 402 : 409, out.code, out.detail); return true; }
      const started = body.start === false ? null : coordinator.startAudit(out.run.id, { token: out.token, baseUrl, timeoutMs: Number(body.timeout_ms) || undefined });
      sendJSON(res, 201, {
        ok: true, audit_id: out.run.id, token: out.token, kind: 'revision',
        status: (store.getRun(out.run.id) || {}).status || '',
        deterministic: out.deterministic,
        reused: Boolean(out.reused),
        started: Boolean(started && started.ok),
        start_error: started && !started.ok ? { code: started.code, detail: started.detail } : null,
        run: store.runToClient(store.getRun(out.run.id)),
      });
      return true;
    }

    fail(res, 400, ERROR_CODES.AUDIT_CONTRACT_INVALID, `kind 必须是 review 或 revision（收到 ${kind}）`);
    return true;
  }

  if (!id) { fail(res, 404, ERROR_CODES.AUDIT_NOT_FOUND, '未知审计路由'); return true; }
  const run = store.getRun(id);
  if (!run) { fail(res, 404, ERROR_CODES.AUDIT_NOT_FOUND, `审计 ${id} 不存在`); return true; }

  // ── 作者通道：状态 ───────────────────────────────────────────────────────────
  if (!action && method === 'GET') {
    const result = (() => { try { return JSON.parse(run.result_json || 'null'); } catch { return null; } })();
    sendJSON(res, 200, {
      ok: true,
      run: store.runToClient(run),
      status: statusPayload(run, {
        hasBlind: Boolean(String(run.blind_result_json || '').trim()),
        hasFinal: Boolean(result),
        coverage: result && result.coverage ? result.coverage : null,
      }),
      events: store.listEvents(id).slice(-50),
      items: store.listItems(id),
    });
    return true;
  }

  // ── 作者通道：启动 ───────────────────────────────────────────────────────────
  if (action === 'start' && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { body = {}; }
    const started = coordinator.startAudit(id, {
      token: tokenOf(req, body),
      baseUrl: String(body.base_url || `http://127.0.0.1:${process.env.PORT || 3737}`).replace(/\/+$/, ''),
      timeoutMs: Number(body.timeout_ms) || undefined,
    });
    if (!started.ok) { fail(res, started.code === ERROR_CODES.AUDIT_TOKEN_INVALID ? 401 : 409, started.code, started.detail); return true; }
    sendJSON(res, 200, { ok: true, audit_id: id, status: started.run.status });
    return true;
  }

  // ── 作者通道：取消 ───────────────────────────────────────────────────────────
  if (action === 'cancel' && method === 'POST') {
    const out = coordinator.cancelAudit(id);
    if (!out.ok) { fail(res, 409, out.code, out.detail); return true; }
    sendJSON(res, 200, { ok: true, audit_id: id, status: out.row.status });
    return true;
  }

  // ── 作者通道：主机校验 ───────────────────────────────────────────────────────
  if (action === 'verify' && method === 'POST') {
    const out = coordinator.hostVerify(id);
    if (!out.ok) { fail(res, out.code === ERROR_CODES.AUDIT_CONTRACT_INVALID ? 422 : 409, out.code, out.detail); return true; }
    sendJSON(res, 200, { ok: true, audit_id: id, status: out.run.status });
    return true;
  }

  // ── 作者通道：合并 ───────────────────────────────────────────────────────────
  if (action === 'merge' && method === 'POST') {
    const out = coordinator.mergeAudit(id);
    if (!out.ok) { fail(res, 409, out.code, out.detail); return true; }
    const merged = out.merged;
    // review：把合并后的报告存成一份新的审稿记录（append-only，不改写初审原文）。
    let reviewId = null;
    if (String(run.kind) === 'review' && merged) {
      let initial = {};
      try { initial = JSON.parse(run.initial_report_json || '{}'); } catch (_) { initial = {}; }
      // 初始报告是旧格式时，合并结果也保持 review.legacy：否则 LEGACY-* 的 issues 在 v3 里
      // 会被判成"缺少 finding"，界面从"旧报告（缺证据）"退化成"结构不完整"——都是真的，但前者更准确。
      const legacyMerged = String(initial.schema_version || '') === 'review.legacy';
      const report = {
        schema_version: legacyMerged ? 'review.legacy' : 'review.v3',
        evidence_status: legacyMerged ? 'legacy_missing' : 'structured',
        summary: String(initial.summary || ''),
        strengths: Array.isArray(initial.strengths) ? initial.strengths : [],
        deferred: [...(Array.isArray(initial.deferred) ? initial.deferred : []), ...(merged.deferred || [])],
        issues: (merged.issues || []).map((i) => ({
          id: String(i.id), text: String(i.text || ''), source: String(i.source || 'merged'),
          link_mode: String(i.link_mode || 'explicit'), finding_id: String(i.finding_id || i.id),
        })),
        findings: (merged.findings || []).map((f) => ({
          id: String(f.id), title: String(f.title || ''), type: String(f.type || 'other'),
          severity: String(f.severity || 'medium'), confidence: f.confidence == null ? null : Number(f.confidence),
          explanation: String(f.text || ''), verdict: String(f.review_verdict || ''), counterevidence: '',
          evidence: Array.isArray(f.evidence) ? f.evidence : [],
          acceptance: f.acceptance && typeof f.acceptance === 'object' ? f.acceptance : { rule: '', preserve: [] },
        })),
        base_text: String(initial.base_text || ''),
        base_hash: String(run.base_hash || ''),
        audit_id: id,
        merged_at: new Date().toISOString(),
      };
      // 落库走与 saveReview 相同的 schema（原始 payload 与归一化视图分列）。
      // 为什么不 import server.js 的 saveReview：server.js 是**本模块的导入方**，
      // 反向 import 会形成循环并且在导入期拿到 undefined。两份写入形状必须一致，
      // 所以这里显式写出同样的列集合，并由 CT 套件断言"合并后的报告能被 GET /novel/review 读回"。
      const { normalizeStoredReviewReport } = await import('../editing/review-contract.mjs');
      const normalized = normalizeStoredReviewReport(report, null);
      const info = db.prepare("INSERT INTO chapter_reviews (work_id, chapter_id, report_json, checklist_json, status) VALUES (?, ?, ?, '{}', 'parsed')")
        .run(run.work_id, run.chapter_id, JSON.stringify(report));
      reviewId = Number(info.lastInsertRowid);
      db.prepare(`UPDATE chapter_reviews SET normalized_report_json = ?, normalization_version = ?, normalization_warnings_json = ?, schema_version = ?, review_hash = ? WHERE id = ?`)
        .run(
          JSON.stringify(normalized), Number(normalized.normalization_version) || 0,
          JSON.stringify(normalized.normalization_warnings || []), String(normalized.schema_version || ''),
          String(normalized.review_hash || ''), reviewId,
        );
      // 与 saveReview 一致：每章只保留最近 10 份审稿。
      db.prepare(`DELETE FROM chapter_reviews WHERE chapter_id = ? AND id NOT IN (
        SELECT id FROM chapter_reviews WHERE chapter_id = ? ORDER BY id DESC LIMIT 10
      )`).run(run.chapter_id, run.chapter_id);
    }
    sendJSON(res, 200, { ok: true, audit_id: id, status: out.run.status, merged, review_id: reviewId });
    return true;
  }

  // ── DSH 通道：清单 / 资源 / 提交 ─────────────────────────────────────────────
  // DSH 只读自查：novel_quality_status 指向这里（没有它，模型中途无法确认"还缺什么"）。
  if (action === 'status' && method === 'GET') {
    const out = coordinator.statusFor(id, tokenOf(req));
    if (!out.ok) { fail(res, out.code === ERROR_CODES.AUDIT_TOKEN_INVALID || out.code === ERROR_CODES.AUDIT_TOKEN_EXPIRED ? 401 : 409, out.code, out.detail); return true; }
    sendJSON(res, 200, out);
    return true;
  }

  if (action === 'input-manifest' && method === 'GET') {
    const out = coordinator.inputManifest(id, tokenOf(req));
    if (!out.ok) { fail(res, out.code === ERROR_CODES.AUDIT_TOKEN_INVALID ? 401 : (out.code === ERROR_CODES.AUDIT_TOKEN_EXPIRED ? 401 : 409), out.code, out.detail); return true; }
    sendJSON(res, 200, out);
    return true;
  }

  if (action === 'resources' && method === 'GET') {
    const name = String(segments[3] || '');
    const out = coordinator.readResource(id, tokenOf(req), name, Number(query.cursor) || 0, Number(query.limit) || LIMITS.defaultPageChars);
    if (!out.ok) { fail(res, out.code === ERROR_CODES.AUDIT_TOKEN_INVALID || out.code === ERROR_CODES.AUDIT_TOKEN_EXPIRED ? 401 : 409, out.code, out.detail); return true; }
    sendJSON(res, 200, out);
    return true;
  }

  if (action === 'submissions' && method === 'POST') {
    let body;
    try { body = await readBody(req, { maxBytes: LIMITS.maxBodyBytes }); } catch (e) {
      fail(res, 413, ERROR_CODES.AUDIT_PAYLOAD_TOO_LARGE, String(e && e.message || e));
      return true;
    }
    const token = tokenOf(req, body);
    const operation = String(body.operation || '');
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const out = operation === 'blind_draft'
      ? coordinator.submitBlind(id, token, payload)
      : operation === 'final'
        ? coordinator.submitFinal(id, token, payload)
        : { ok: false, code: ERROR_CODES.AUDIT_CONTRACT_INVALID, detail: `operation 必须是 blind_draft 或 final（收到 ${operation}）` };
    if (!out.ok) {
      const status = out.code === ERROR_CODES.AUDIT_TOKEN_INVALID || out.code === ERROR_CODES.AUDIT_TOKEN_EXPIRED ? 401
        : out.code === ERROR_CODES.AUDIT_RESULT_CONFLICT ? 409
          : out.code === ERROR_CODES.AUDIT_ALREADY_SUBMITTED || out.code === ERROR_CODES.AUDIT_CANCELLED ? 409
            : out.code === ERROR_CODES.AUDIT_PAYLOAD_TOO_LARGE ? 413 : 422;
      fail(res, status, out.code, out.detail);
      return true;
    }
    sendJSON(res, 200, { ok: true, audit_id: id, status: out.run.status, idempotent: Boolean(out.idempotent) });
    return true;
  }

  fail(res, 404, ERROR_CODES.AUDIT_NOT_FOUND, `未知审计动作：${action || '(空)'}`);
  return true;
}

export { MAX_BODY_BYTES, RUN_STATUS };
