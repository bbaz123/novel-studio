/**
 * ai/quality-auditor/evidence.mjs —— 证据的**确定性**核验（不调用模型、零计费）。
 *
 * 方案 §5.4 的可接受证据里，只有两类能机器判定：
 *   ① 逐字 quote 是否真的出现在正文里；
 *   ② must_contain / min_chars 这类硬约束是否满足。
 * 其余（"感觉改善了"）一律不可接受。这里只做这两类，别的一律交回给 auditor 的 NEED_CONTEXT。
 *
 * 为什么必须在服务端做：模型会给出"看起来像引用"的句子。如果服务端不核对，
 * 一条虚构的引用就能让"已修复"成立 —— 那正是本插件要防止的事。
 */
import { quoteExists } from './contracts.mjs';

/** 逐字引用核验。 */
export function verifyQuotes(text, quotes = []) {
  const list = (Array.isArray(quotes) ? quotes : [])
    .map((q) => String(q && typeof q === 'object' ? (q.quote != null ? q.quote : q.text) : q).trim())
    .filter(Boolean);
  const missing = list.filter((q) => !quoteExists(text, q));
  return { ok: missing.length === 0, checked: list.length, missing };
}

/** must_contain：每一条都必须出现（这是"必须新增的情节/文本"的硬判据）。 */
export function verifyMustContain(text, mustContain = []) {
  const list = (Array.isArray(mustContain) ? mustContain : []).map((s) => String(s).trim()).filter(Boolean);
  const missing = list.filter((s) => !String(text || '').includes(s));
  return { ok: missing.length === 0, checked: list.length, missing };
}

/** min_chars：只有明确标成硬约束时才做（软目标不误判）。 */
export function verifyMinChars(text, minChars) {
  const n = Number(minChars) || 0;
  if (n <= 0) return { ok: true, skipped: true, chars: String(text || '').length, min_chars: 0 };
  const chars = String(text || '').length;
  return { ok: chars >= n, skipped: false, chars, min_chars: n };
}

/** preserve：必须保留的原文片段（改没了就是硬 FAIL）。 */
export function verifyPreserve(baseText, candidateText, preserve = []) {
  const list = (Array.isArray(preserve) ? preserve : []).map((s) => String(s).trim()).filter(Boolean);
  const lost = list.filter((s) => String(baseText || '').includes(s) && !String(candidateText || '').includes(s));
  return { ok: lost.length === 0, checked: list.length, lost };
}

/**
 * 一条 finding 的确定性验收（修改前后）。
 * @returns {{verdict:'PASS'|'PARTIAL'|'FAIL', checks:Array, reason:string}}
 */
export function deterministicFindingVerdict({ baseText = '', candidateText = '', finding = {} } = {}) {
  const acceptance = (finding && finding.acceptance) || {};
  const checks = [];
  // 1) acceptance.rule 是自然语言判据，机器不判；只登记"需要语义复核"。
  if (String(acceptance.rule || '').trim()) {
    checks.push({ name: 'acceptance_rule', pass: null, evidence: '自然语言判据需语义复核' });
  }
  // 2) must_contain（硬）
  if (Array.isArray(acceptance.must_contain) && acceptance.must_contain.length) {
    const r = verifyMustContain(candidateText, acceptance.must_contain);
    checks.push({ name: 'must_contain', pass: r.ok, evidence: r.ok ? '' : `缺失：${r.missing.join('、')}` });
  }
  // 3) min_chars（明确硬约束时才判）
  if (Number(acceptance.min_chars) > 0) {
    const r = verifyMinChars(candidateText, acceptance.min_chars);
    checks.push({ name: 'min_chars', pass: r.ok, evidence: `${r.chars}/${r.min_chars}` });
  }
  // 4) preserve
  if (Array.isArray(acceptance.preserve) && acceptance.preserve.length) {
    const r = verifyPreserve(baseText, candidateText, acceptance.preserve);
    checks.push({ name: 'preserve', pass: r.ok, evidence: r.ok ? '' : `丢失：${r.lost.join('、')}` });
  }
  // 5) 原证据是否仍逐字存在（若 acceptance 明确要求消除，这就是硬残留）
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const stillPresent = evidence
    .map((e) => String(e && e.quote || '').trim())
    .filter((q) => q && String(candidateText || '').includes(q));
  if (stillPresent.length) {
    checks.push({ name: 'remaining_evidence', pass: false, evidence: `证据仍逐字存在：${stillPresent.length} 处` });
  }
  // 6) 文本是否有变化
  const changed = String(baseText || '') !== String(candidateText || '');
  if (!changed) {
    return { verdict: 'FAIL', checks: checks.concat([{ name: 'changed', pass: false, evidence: '候选稿与底稿完全相同' }]), reason: 'FAIL_NO_EFFECT' };
  }
  const hardFail = checks.some((c) => c.pass === false);
  const pending = checks.some((c) => c.pass === null);
  if (hardFail) {
    return { verdict: 'PARTIAL', checks, reason: '确定性硬约束未通过，且可能仍有残留证据' };
  }
  if (pending || stillPresent.length === 0) {
    // 有自然语言判据需要语义复核：确定性层不能单独判 PASS。
    return { verdict: 'PARTIAL', checks, reason: pending ? '等待语义复核' : '证据已消除但缺少语义复核' };
  }
  return { verdict: 'PASS', checks, reason: '' };
}
