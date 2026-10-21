/**
 * ai/quality-auditor/review-integrity.mjs —— 审稿报告的**免费结构检查**（方案 §9.1 第一步）。
 *
 * 在启动 DSH 盲审之前先跑一遍确定性检查。它能当场发现：
 *   · issue 没有稳定 id / id 重复；
 *   · finding 的逐字引用在正文里找不到（模型编的引用）；
 *   · finding 缺少 acceptance（修后无法验收）；
 *   · 报告一条 findings 都没有（无法精确修稿）。
 *
 * 为什么先跑这一层：盲审要花钱、要等模型。结构坏掉的报告拿去复核，等于花钱复核一堆
 * 无法落地成修稿的东西。这里把"能不能进入精确修复"在花钱之前判掉。
 */
import { validateReviewIntegrity } from '../editing/review-contract.mjs';
import { validateFindingEvidence, ERROR_CODES } from './contracts.mjs';

/**
 * @param {object} report review.v3 归一化报告
 * @param {string} articleText 被审正文（用于逐字核验）
 * @returns {{ok:boolean, code:string, checks:Array<{name:string,pass:boolean,detail:string}>, stats:object}}
 */
export function reviewIntegrityCheck(report, articleText) {
  const checks = [];
  const integ = validateReviewIntegrity(report);
  checks.push({ name: 'identity', pass: integ.ok, detail: integ.ok ? integ.code : `${integ.code}:${(integ.errors || []).join(';').slice(0, 200)}` });

  const issues = Array.isArray(report && report.issues) ? report.issues : [];
  const findings = Array.isArray(report && report.findings) ? report.findings : [];
  checks.push({
    name: 'findings_present',
    pass: findings.length > 0,
    detail: findings.length ? `${findings.length} 条` : '报告没有任何结构化 findings：无法精确修复',
  });

  let quoteNotFound = 0;
  let missingEvidence = 0;
  let missingAcceptance = 0;
  for (const f of findings) {
    const ev = validateFindingEvidence(f, articleText);
    if (!ev.ok) quoteNotFound += ev.quote_not_found.length;
    if (ev.missing_evidence) missingEvidence += 1;
    const acc = (f && f.acceptance) || {};
    if (!String(acc.rule || '').trim() && !(Array.isArray(acc.must_contain) && acc.must_contain.length) && !(Array.isArray(acc.preserve) && acc.preserve.length)) {
      missingAcceptance += 1;
    }
  }
  checks.push({ name: 'quotes_exist', pass: quoteNotFound === 0, detail: quoteNotFound ? `${quoteNotFound} 处引用不在正文` : '' });
  checks.push({ name: 'evidence_present', pass: missingEvidence === 0, detail: missingEvidence ? `${missingEvidence} 条 finding 没有逐字证据` : '' });
  checks.push({ name: 'acceptance_present', pass: missingAcceptance === 0, detail: missingAcceptance ? `${missingAcceptance} 条 finding 缺少验收条件` : '' });

  const failed = checks.filter((c) => !c.pass);
  const code = (() => {
    if (integ.code === ERROR_CODES.REVIEW_ID_MAPPING_BROKEN) return ERROR_CODES.REVIEW_ID_MAPPING_BROKEN;
    if (integ.legacy) return 'REVIEW_LEGACY_NO_EVIDENCE';
    if (!findings.length) return 'REVIEW_FINDINGS_MISSING';
    if (quoteNotFound) return ERROR_CODES.AUDIT_QUOTE_NOT_FOUND;
    if (failed.length) return ERROR_CODES.AUDIT_CONTRACT_INVALID;
    return 'OK';
  })();
  // 只有"身份链真的断了/编号重复"才阻塞**独立复核**；缺证据/旧报告允许复核，
  // 只是结论要封顶（legacy_missing / NEED_CONTEXT）—— 这正是独立复核最该介入的场景。
  const blocking = code === ERROR_CODES.REVIEW_ID_MAPPING_BROKEN || code === ERROR_CODES.REVIEW_DUPLICATE_ID;
  return {
    ok: !blocking,
    blocking,
    legacy: Boolean(integ.legacy),
    code,
    checks,
    stats: {
      issues: issues.length,
      findings: findings.length,
      quote_not_found: quoteNotFound,
      missing_evidence: missingEvidence,
      missing_acceptance: missingAcceptance,
    },
  };
}
