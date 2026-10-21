/**
 * ai/quality-auditor/revision-integrity.mjs —— 修稿候选的**确定性终验层**（方案 §10.1 的前半）。
 *
 * 这一层与 `dsh-novel-quality-auditor` 的分工：
 *   · 这里只判**能机器判定**的事：候选 hash、补丁是否落在已选问题、原文锚点是否还在、
 *     must_contain / min_chars / preserve 是否满足、证据是否仍逐字残留；
 *   · 语义层（"这个改法算不算真的解决了问题"）交给 auditor 的 revision audit。
 *
 * 裁决优先级（方案 §10.2）写在这里：确定性硬失败 > unauthorized/stale > auditor FAIL/PARTIAL
 * > auditor NEED_CONTEXT > internal semantic PASS。也就是说：模型 PASS 不能覆盖硬失败。
 */
import { deterministicFindingVerdict } from './evidence.mjs';

/**
 * @param {object} input
 * @param {string} input.baseText 底稿
 * @param {string} input.candidateText 候选稿
 * @param {string} input.baseHash
 * @param {string} input.candidateHash
 * @param {string[]} input.selectedIssueIds 作者勾选的稳定 id
 * @param {Array} input.findings 选中的结构化 findings（review.v3）
 * @param {Array} input.patches 实际应用的补丁（patch_trace）
 * @param {Array} input.protectedSpans 不得改写的原文片段
 */
export function revisionIntegrityCheck(input = {}) {
  const baseText = String(input.baseText == null ? '' : input.baseText);
  const candidateText = String(input.candidateText == null ? '' : input.candidateText);
  const baseHash = String(input.baseHash || '');
  const candidateHash = String(input.candidateHash || '');
  const selected = (Array.isArray(input.selectedIssueIds) ? input.selectedIssueIds : []).map(String);
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const patches = Array.isArray(input.patches) ? input.patches : [];
  const protectedSpans = (Array.isArray(input.protectedSpans) ? input.protectedSpans : []).map(String).filter(Boolean);

  const hard = [];
  const perIssue = [];

  // ── 1) 候选 hash 必须与本次审计绑定的一致（RS-10 / CT-06） ────────────────────
  if (input.expectedCandidateHash && String(input.expectedCandidateHash) !== candidateHash) {
    hard.push({ name: 'candidate_hash', pass: false, detail: '候选稿 hash 与审计绑定的不一致（STALE）' });
  }
  // ── 2) 底稿 hash（防止拿错底稿验收） ─────────────────────────────────────────
  if (input.expectedBaseHash && String(input.expectedBaseHash) !== baseHash) {
    hard.push({ name: 'base_hash', pass: false, detail: '底稿 hash 与审计绑定的不一致' });
  }
  // ── 3) 补丁必须属于已选问题（越权面，RS-09） ─────────────────────────────────
  const unauthorized = patches.filter((p) => {
    const ids = Array.isArray(p && p.issue_ids) ? p.issue_ids.map(String)
      : (p && p.issue_id != null ? [String(p.issue_id)] : []);
    return ids.some((id) => !selected.includes(id));
  });
  if (unauthorized.length) {
    hard.push({ name: 'authorized_scope', pass: false, detail: `${unauthorized.length} 个补丁作用于未选择的问题` });
  }
  // ── 4) 补丁锚点必须仍在底稿里（改错位置 / 底稿已变） ────────────────────────
  const lostAnchors = patches.filter((p) => {
    const original = String(p && (p.original != null ? p.original : p.anchor) || '');
    return original && !baseText.includes(original);
  });
  if (lostAnchors.length) {
    hard.push({ name: 'anchors_present', pass: false, detail: `${lostAnchors.length} 个补丁的原句不在底稿` });
  }
  // ── 5) 保护区不得被改（显式保护 > 任何模型判断） ─────────────────────────────
  const touchedProtected = protectedSpans.filter((s) => baseText.includes(s) && !candidateText.includes(s));
  if (touchedProtected.length) {
    hard.push({ name: 'protected_spans', pass: false, detail: `${touchedProtected.length} 处保护区被改写` });
  }

  // ── 6) 逐项确定性验收 ───────────────────────────────────────────────────────
  const byId = new Map(findings.map((f) => [String(f && f.id), f]));
  for (const id of selected) {
    const finding = byId.get(id) || { id, evidence: [], acceptance: {} };
    const verdict = deterministicFindingVerdict({ baseText, candidateText, finding });
    perIssue.push({
      issue_id: id,
      deterministic: verdict.verdict,
      reason: verdict.reason,
      checks: verdict.checks,
      has_finding: byId.has(id),
    });
  }

  return {
    ok: hard.length === 0,
    hard_failures: hard,
    issues: perIssue,
    unauthorized_patches: unauthorized.length,
    lost_anchors: lostAnchors.length,
    touched_protected: touchedProtected.length,
  };
}

/**
 * 汇总裁决（方案 §10.2 的优先级实现）。
 *
 * @param {object} input
 * @param {object} input.deterministic revisionIntegrityCheck 的结果
 * @param {object} [input.auditor] revision audit 结果（可缺省 = 尚未运行）
 * @param {object} [input.internalSemantic] 内部语义验收（按 issue_id）
 * @returns {{overall:'PASS'|'PARTIAL'|'FAIL'|'AWAITING_AUDIT'|'STALE'|'BLOCKED_SCOPE', issues:Array}}
 */
export function revisionOverallVerdict({ deterministic, auditor, internalSemantic } = {}) {
  const det = deterministic || { ok: true, hard_failures: [], issues: [] };
  const auditorIssues = new Map(((auditor && auditor.issues) || []).map((i) => [String(i.issue_id), i]));

  const merged = (det.issues || []).map((d) => {
    const a = auditorIssues.get(String(d.issue_id));
    const s = internalSemantic && internalSemantic[String(d.issue_id)] ? internalSemantic[String(d.issue_id)] : null;
    // 优先级：硬失败 → 越权/stale → auditor FAIL/PARTIAL → auditor NEED_CONTEXT → 内部语义 PASS
    let final = 'PARTIAL';
    let reason = d.reason || '';
    if (!det.ok) {
      final = /STALE|hash|不一致/.test(JSON.stringify(det.hard_failures)) ? 'STALE' : 'BLOCKED_SCOPE';
      reason = '确定性硬失败优先于任何模型判断';
    } else if (d.deterministic === 'FAIL') {
      final = 'FAIL';
      reason = d.reason || '确定性层判定未生效';
    } else if (a && ['FAIL', 'PARTIAL'].includes(String(a.verdict))) {
      final = String(a.verdict);
      reason = String(a.reason || '');
    } else if (a && String(a.verdict) === 'NEED_CONTEXT') {
      final = 'NEED_CONTEXT';
      reason = String(a.reason || '缺少外部上下文');
    } else if (a && String(a.verdict) === 'BLOCKED_SCOPE') {
      final = 'BLOCKED_SCOPE';
      reason = String(a.reason || '越权/保护区');
    } else if (a && String(a.verdict) === 'PASS') {
      // auditor 的 PASS **就是**语义复核通过。确定性层只保留"硬失败"否决权：
      // 带 `acceptance.rule` 自然语言判据的条目在确定性层永远是 PARTIAL（规则本身要语义判断），
      // 若这里再要求 d.deterministic==='PASS'，auditor 的 PASS 永远无法落地 —— 那等于没接审计。
      const hardFail = (Array.isArray(d.checks) ? d.checks : []).some((c) => c && c.pass === false);
      final = hardFail ? 'PARTIAL' : 'PASS';
      reason = hardFail ? '确定性硬约束未通过，模型 PASS 不能覆盖' : String(a.reason || '');
    } else if (!a) {
      // 没有 auditor 结果：确定性 PASS 也只能到 AWAITING_AUDIT。
      final = d.deterministic === 'PASS' ? 'AWAITING_AUDIT' : d.deterministic;
      reason = d.deterministic === 'PASS' ? '尚未运行独立语义审计' : reason;
    } else if (s && String(s.status || '').toUpperCase() === 'PASS' && d.deterministic === 'PASS') {
      // 内部语义 PASS 不能覆盖 auditor FAIL；只有 auditor 缺失时才作为 AWAITING_AUDIT 的依据。
      final = 'AWAITING_AUDIT';
    }
    return { ...d, final, final_reason: reason, auditor_verdict: a ? a.verdict : '', auditor_reason: a ? a.reason : '' };
  });

  const anyBlocked = merged.some((m) => m.final === 'BLOCKED_SCOPE');
  const anyStale = merged.some((m) => m.final === 'STALE');
  const anyHard = merged.some((m) => ['FAIL', 'PARTIAL', 'NEED_CONTEXT', 'BLOCKED_SCOPE', 'STALE'].includes(m.final));
  const anyAwaiting = merged.some((m) => m.final === 'AWAITING_AUDIT');
  let overall = 'PASS';
  if (anyStale) overall = 'STALE';
  else if (anyBlocked) overall = 'BLOCKED_SCOPE';
  else if (anyHard) overall = 'PARTIAL';
  else if (anyAwaiting) overall = 'AWAITING_AUDIT';
  return { overall, issues: merged };
}

/** 有界定向复修：只挑 PARTIAL/FAIL 且仍在授权跨度内的项（方案 §10.3）。 */
export function repairTargets(overall, maxRound = 2) {
  const items = (overall && overall.issues) || [];
  const round = Number(overall && overall.round) || 0;
  if (round >= maxRound) return { ok: false, reason: 'ROUND_LIMIT', issue_ids: [], round, maxRounds: maxRound };
  const targets = items
    .filter((i) => ['PARTIAL', 'FAIL'].includes(String(i.final)))
    .map((i) => String(i.issue_id));
  if (!targets.length) return { ok: false, reason: 'NO_FAILED_ISSUES', issue_ids: [], round, maxRounds: maxRound };
  return { ok: true, reason: 'ELIGIBLE', issue_ids: targets, round: round + 1, maxRounds: maxRound };
}
