/**
 * ai/quality-auditor/merge-revision.mjs —— 修稿终验的合并裁决（方案 §10.2 / §10.3）。
 *
 * 输入三路证据，输出每一个已选问题**唯一**的终态：
 *   ① 确定性层（本服务端算的：hash / 锚点 / must_contain / preserve / 残留证据）；
 *   ② auditor 逐项终评（PASS/PARTIAL/FAIL/NEED_CONTEXT/BLOCKED_SCOPE）；
 *   ③ 内部语义验收（Studio 自己的 verifier，按 issue_id）。
 *
 * 优先级是**硬编码**的，不是"综合判断"：确定性硬失败永远压过模型 PASS。
 * 这一条如果被"综合"掉，那这套审计就退化成了"模型说好就好"。
 */
import { revisionOverallVerdict, repairTargets } from './revision-integrity.mjs';

const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * @param {object} input
 * @param {object} input.deterministic revisionIntegrityCheck 结果
 * @param {object} [input.auditor] revision-audit.v1 结果
 * @param {object} [input.internalSemantic] 内部语义按 issue_id
 * @param {number} [input.round] 当前轮次
 * @param {number} [input.maxRounds]
 */
export function mergeRevision({ deterministic, auditor, internalSemantic, round = 0, maxRounds = 2 } = {}) {
  const overall = revisionOverallVerdict({ deterministic, auditor, internalSemantic });
  overall.round = Number(round) || 0;
  overall.maxRounds = Number(maxRounds) || 2;

  // 回归：本轮之前 PASS、本轮不是 PASS 的项（RS-16 / RS-08）
  const regressions = asList(auditor && auditor.regressions).map((r) => ({
    issue_id: String(r && r.issue_id || ''),
    reason: String(r && (r.reason || r.detail) || ''),
  }));
  const unauthorized = asList(deterministic && deterministic.hard_failures)
    .filter((h) => String(h.name) === 'authorized_scope')
    .map((h) => ({ kind: 'unauthorized_patch', reason: String(h.detail || '') }));

  const counts = {
    selected: overall.issues.length,
    pass: overall.issues.filter((i) => i.final === 'PASS').length,
    partial: overall.issues.filter((i) => i.final === 'PARTIAL').length,
    fail: overall.issues.filter((i) => i.final === 'FAIL').length,
    need_context: overall.issues.filter((i) => i.final === 'NEED_CONTEXT').length,
    blocked: overall.issues.filter((i) => ['BLOCKED_SCOPE'].includes(i.final)).length,
    stale: overall.issues.filter((i) => i.final === 'STALE').length,
    awaiting: overall.issues.filter((i) => i.final === 'AWAITING_AUDIT').length,
  };

  // "全部完成"只能由**所有已选项都 PASS** 得出；其余一律不得显示为全部完成。
  const allPass = overall.issues.length > 0 && counts.pass === overall.issues.length;
  const targets = repairTargets(overall, maxRounds);

  return {
    overall: overall.overall,
    all_pass: allPass,
    counts,
    issues: overall.issues,
    regressions,
    unauthorized_changes: unauthorized,
    repair_targets: targets.issue_ids,
    repair: targets,
    result: {
      schema_version: 'revision-audit.v1',
      audit_id: String((auditor && auditor.audit_id) || ''),
      base_hash: String((auditor && auditor.base_hash) || ''),
      candidate_hash: String((auditor && auditor.candidate_hash) || ''),
      issues: overall.issues.map((i) => ({
        issue_id: i.issue_id,
        verdict: i.final,
        reason: i.final_reason || '',
        remaining_evidence: asList(i.checks).filter((c) => c && c.pass === false).map((c) => ({ quote: String(c.evidence || '') })),
        checks: asList(i.checks),
        repair_hint: i.final === 'PASS' ? '' : '只处理仍残留的证据/判据，不改已通过部分',
      })),
      regressions,
      unauthorized_changes: unauthorized,
      overall: overall.overall,
    },
  };
}
