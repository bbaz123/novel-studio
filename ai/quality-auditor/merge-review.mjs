/**
 * ai/quality-auditor/merge-review.mjs —— 审稿合并（初审 + 盲审新增 + 对照结论）。
 *
 * 方案 §9.3 的合并算法，逐条落成代码：
 *   ① 初审 finding ID 保持不变；
 *   ② auditor 新 finding 用 `QA-R-xxxx`；
 *   ③ 以「类型 + 证据跨度 + acceptance 主体」生成 canonical key；
 *   ④ 同一问题合并来源，不重复显示；
 *   ⑤ auditor 认为初审误报 → 加 DISPUTED 标记，**不删除**原 finding；
 *   ⑥ 新增高置信 finding 显示"复审新增"，不自动扩大修稿授权；
 *   ⑦ 低置信/缺资料 → 待核验（deferred），不进修稿；
 *   ⑧ coverage 不完整时 overall 不能是 COMPLETE。
 *
 * 为什么"不删除"这么重要：作者看到的清单是他勾选的依据。审计员说"这条是误报"，
 * 正确形态是"这条被质疑（附理由）"，而不是让它凭空消失 —— 否则作者永远不知道
 * 自己原来的判断被谁推翻了。
 */
import { sha256Of } from './snapshots.mjs';
import { screenDisputes } from './relevance.mjs';

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').slice(0, 200);

/** canonical key：类型 + 证据（排序后的逐字引用）+ 验收主体。 */
export function canonicalKey(finding) {
  const type = String((finding && finding.type) || 'other').toLowerCase();
  const quotes = (Array.isArray(finding && finding.evidence) ? finding.evidence : [])
    .map((e) => norm(e && (e.quote != null ? e.quote : e)))
    .filter(Boolean)
    .sort();
  const acc = (finding && finding.acceptance) || {};
  const subject = norm(acc.rule || (Array.isArray(acc.must_contain) ? acc.must_contain.join('') : ''));
  return type + '|' + quotes.join('|') + '|' + subject;
}

/**
 * @param {object} input
 * @param {object} input.initialReport review.v3（初审，已冻结）
 * @param {object} input.blind blind_draft 提交（findings / scanned_ranges）
 * @param {object} input.compare final 提交（initial_findings 逐条判定 + new_findings + coverage + verdict）
 * @returns {{issues:Array, findings:Array, deferred:Array, disputes:Array, coverage:object, overall:string, stats:object}}
 */
export function mergeReview({ initialReport, blind, compare } = {}) {
  const initialFindings = Array.isArray(initialReport && initialReport.findings) ? initialReport.findings : [];
  const initialIssues = Array.isArray(initialReport && initialReport.issues) ? initialReport.issues : [];
  const blindFindings = Array.isArray(blind && blind.findings) ? blind.findings : [];
  const compareInitial = Array.isArray(compare && compare.initial_findings) ? compare.initial_findings : [];
  const compareNew = Array.isArray(compare && compare.new_findings) ? compare.new_findings : [];

  const verdictById = new Map(compareInitial.map((c) => [String(c && c.issue_id), String(c && c.verdict || '')]));
  // 便宜的相关性筛选（纯词面共现，零计费）：只有"在说同一件事"的反例才允许标成"被驳倒"。
  // 不相干/太弱的反例被降级成 ADVISORY_NEEDS_REVIEW —— 条目仍然留在清单里，理由也一起留，
  // 只是不许它把作者的原判断说成"错的"（2026-10-22 误报的形态）。
  const screens = screenDisputes({ initialFindings, compareInitial });
  const disputes = [];
  const advisories = [];
  const deferred = [];
  const byKey = new Map();

  // ① 初审 finding：id 不变，只叠加对照结论。
  for (const f of initialFindings) {
    const id = String(f && f.id || '');
    const verdict = verdictById.get(id) || 'COVERED';
    const screen = screens.byIssueId.get(id) || null;
    // 审计员说 DISPUTED，但相关性与"同一件事"对不上 → 降级为"待人工判断"，不算驳倒。
    const disputed = verdict === 'DISPUTED' && (!screen || screen.verdict === 'RELEVANT');
    const item = {
      issue_id: id,
      id,
      text: String(f && (f.title || f.explanation) || ''),
      title: String(f && f.title || ''),
      type: String(f && f.type || 'other'),
      severity: String(f && f.severity || 'medium'),
      confidence: f && f.confidence != null ? Number(f.confidence) : null,
      evidence: Array.isArray(f && f.evidence) ? f.evidence : [],
      acceptance: (f && f.acceptance) || { rule: '', preserve: [] },
      source: 'initial',
      // 原始裁决照原样保留（不删除、不隐藏审计员说过什么）。
      review_verdict: verdict,
      // 生效裁决：只有相关性过关的 DISPUTED 才算"被驳倒"。
      review_verdict_effective: verdict === 'DISPUTED' && !disputed ? 'ADVISORY_NEEDS_REVIEW' : verdict,
      disputed,
      relevance: screen,
    };
    if (disputed) {
      disputes.push({ issue_id: id, reason: String((compareInitial.find((c) => String(c && c.issue_id) === id) || {}).reason || '') });
    } else if (verdict === 'DISPUTED') {
      advisories.push({
        issue_id: id,
        relevance: screen,
        reasons: (screen && screen.reasons) || [],
        reason: String((compareInitial.find((c) => String(c && c.issue_id) === id) || {}).reason || ''),
      });
    }
    byKey.set(canonicalKey(item), item);
  }

  // ② 盲审新增：QA-R-xxxx；与初审同 canonical key 的合并来源，不重复显示。
  const mergedNew = [];
  for (const f of blindFindings) {
    const item = {
      issue_id: String(f && f.id || ''),
      id: String(f && f.id || ''),
      text: String(f && (f.title || f.explanation) || ''),
      title: String(f && f.title || ''),
      type: String(f && f.type || 'other'),
      severity: String(f && f.severity || 'medium'),
      confidence: f && f.confidence != null ? Number(f.confidence) : null,
      evidence: Array.isArray(f && f.evidence) ? f.evidence : [],
      acceptance: (f && f.acceptance) || { rule: '', preserve: [] },
      source: 'auditor',
      review_verdict: '',
      disputed: false,
    };
    const key = canonicalKey(item);
    if (byKey.has(key)) {
      // 同一问题：把来源标成 merged，不新增一行。
      const existing = byKey.get(key);
      existing.sources = [...new Set([...(existing.sources || [existing.source]), 'auditor'])];
      existing.source = 'merged';
      continue;
    }
    byKey.set(key, item);
    mergedNew.push(item);
  }

  // compare 阶段 auditor 又补充的新问题（也走 QA-R-xxxx，去重同样按 canonical key）。
  for (const f of compareNew) {
    const item = {
      issue_id: String(f && f.id || ''),
      id: String(f && f.id || ''),
      text: String(f && (f.title || f.explanation) || ''),
      title: String(f && f.title || ''),
      type: String(f && f.type || 'other'),
      severity: String(f && f.severity || 'medium'),
      confidence: f && f.confidence != null ? Number(f.confidence) : null,
      evidence: Array.isArray(f && f.evidence) ? f.evidence : [],
      acceptance: (f && f.acceptance) || { rule: '', preserve: [] },
      source: 'auditor',
      review_verdict: '',
      disputed: false,
    };
    const key = canonicalKey(item);
    if (byKey.has(key)) continue;
    byKey.set(key, item);
    mergedNew.push(item);
  }

  const findings = [...byKey.values()];

  // ⑦ 低置信/缺资料 → 待核验（不进入修稿）。阈值 0.6 与 prompts 里的口径一致。
  const autoEligible = [];
  for (const f of findings) {
    const low = f.confidence != null && Number(f.confidence) < 0.6;
    const noEvidence = !(Array.isArray(f.evidence) && f.evidence.length);
    if (low || noEvidence) {
      deferred.push({ issue_id: f.issue_id, reason: low ? '低置信' : '缺少逐字证据' });
    } else {
      autoEligible.push(f.issue_id);
    }
  }

  // issues 清单：保留初审顺序（稳定 id），再追加复审新增。
  const issueOrder = new Map();
  initialIssues.forEach((it, idx) => issueOrder.set(String(it && it.id), idx));
  const issues = [];
  for (const it of initialIssues) {
    const id = String(it && it.id || '');
    const f = findings.find((x) => String(x.issue_id) === id);
    issues.push({
      id, text: String(it && it.text || ''), source: 'initial_review',
      link_mode: String(it && it.link_mode || 'explicit'), finding_id: id,
      disputed: Boolean(f && f.disputed),
      review_verdict: (f && f.review_verdict) || '',
      severity: (f && f.severity) || '',
    });
  }
  for (const f of mergedNew) {
    issues.push({
      id: f.issue_id, text: f.title || f.text, source: 'auditor',
      link_mode: 'explicit', finding_id: f.issue_id,
      new_in_review: true, severity: f.severity,
    });
  }

  // ⑧ coverage 不完整 → overall 不能 COMPLETE。
  const coverage = (compare && compare.coverage) || {};
  const dims = coverage.dimensions && typeof coverage.dimensions === 'object' ? coverage.dimensions : {};
  const dimsComplete = Object.keys(dims).length > 0 && Object.values(dims).every((v) => v === true || v === 'true');
  const resources = Array.isArray(coverage.resources) ? coverage.resources : [];
  const resourcesComplete = resources.length > 0 && resources.every((r) => r && r.complete !== false);
  const coverageComplete = dimsComplete && resourcesComplete;
  let overall = String((compare && compare.verdict) || 'NEED_CONTEXT');
  if (!coverageComplete && overall === 'COMPLETE_WITH_EVIDENCE') overall = 'IMPORTANT_OMISSIONS_FOUND';

  const result = {
    schema_version: 'review-audit.v1',
    audit_id: String((compare && compare.audit_id) || ''),
    base_hash: String((compare && compare.base_hash) || ''),
    coverage,
    initial_findings: compareInitial,
    new_findings: compareNew,
    verdict: overall,
  };
  return {
    issues,
    findings,
    deferred,
    disputes,
    coverage,
    coverage_complete: coverageComplete,
    overall,
    auto_eligible: autoEligible,
    // 降级台账要能被持久化（服务端会用一条事件记下来），否则"为什么这条不算驳倒"事后无从查。
    relevance_downgrades: screens.downgrades,
    advisories,
    stats: {
      initial: initialFindings.length,
      blind: blindFindings.length,
      merged_new: mergedNew.length,
      deferred: deferred.length,
      disputes: disputes.length,
      // 被相关性筛选降级的条数：它们**不**计入 disputes，也**不**降低整份报告的质量判定。
      advisory: advisories.length,
      total: findings.length,
    },
    result,
    result_hash: sha256Of(JSON.stringify({ issues, findings, overall })),
  };
}
