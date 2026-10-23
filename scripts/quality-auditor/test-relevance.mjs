#!/usr/bin/env node
/**
 * test-relevance.mjs —— 独立复核的「反例相关性」与「缺字段可定位」断言（AUD-01…AUD-07，零计费）。
 *
 * 依据：docs/quality-audit-p0-merge-protection-plan-20261022.md §3.1 / §3.2 / §3.3。
 *
 * 为什么这些断言必须存在（2026-10-22 真实误报）：
 * 初审说"系统首次上线时保持克制、没有急着解释自己"，审计员把"前面的平头男生一直在说话"
 * 当成反例记为 DISPUTED —— 主语不同、谓词不同、范围不同，却被呈现成"作者判错了"。
 * 作者据理力争时看到的是"我的观察被一句无关的话否掉了"。
 * 所以这里钉的不是模型话术，而是**判据**：不相干的证据不许冒充反例。
 *
 * 用法: node scripts/quality-auditor/test-relevance.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { relevanceOf, screenDisputes, claimSignals } from '../../ai/quality-auditor/relevance.mjs';
import { mergeReview } from '../../ai/quality-auditor/merge-review.mjs';
import {
  defectsOf, validateReviewAuditPayload, DEFECT_RESOLUTION, INITIAL_FINDING_VERDICTS,
  canTransition, RUN_STATUS, ERROR_CODES,
} from '../../ai/quality-auditor/contracts.mjs';
import { verifyQuotes } from '../../ai/quality-auditor/evidence.mjs';
import { reviewIntegrityCheck } from '../../ai/quality-auditor/review-integrity.mjs';
import { auditLeadHintsOf, propStateConflictsOf, soundCarrierHints } from '../../ai/quality-auditor/prop-continuity.mjs';
import { autoRepairPayload } from '../../ai/quality-auditor/contracts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
void REPO;

let pass = 0;
const fails = [];
const ok = (id, name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${id} ${name}`); }
  else { fails.push(`${id} ${name}`); console.log(`  ✗ ${id} ${name}${detail ? '  — ' + detail : ''}`); }
};

// ── 现场文本（取自方案 §2 的真实两段） ───────────────────────────────────────
const CLAIM_SYSTEM = '系统首次上线时保持克制，没有急着让系统解释自己';
const COUNTER_TALK = '前面的平头男生一直在说话';
const CLAIM_NOBODY_NOTICE = '这一段没有人注意系统的声音';
const COUNTER_CHAT = '另一个人在旁边正常聊天，没人抬头';
const CLAIM_NOBODY_LOOK = '这一段没有人看主角一眼';
const COUNTER_LOOK = '平头男生明确看了主角一眼';

console.log('独立复核相关性（AUD-01…AUD-07，零计费）');

// ── AUD-01 / 02：不相干的原文不得冒充反例 ───────────────────────────────────
{
  const a = relevanceOf({ claim: CLAIM_SYSTEM, counterEvidence: COUNTER_TALK });
  ok('AUD-01', '「平头男生一直说话」不是「系统播报克制」的反例（判 INVALID_RELEVANCE，不呈现成互相否认）',
    a.verdict === 'INVALID_RELEVANCE' && a.overlap.length === 0 && a.reasons.length > 0,
    JSON.stringify({ verdict: a.verdict, overlap: a.overlap }));

  const b = relevanceOf({ claim: CLAIM_NOBODY_NOTICE, counterEvidence: COUNTER_CHAT });
  ok('AUD-02', '「另一个人正常聊天」不是「没人注意系统声」的反例（同样判 INVALID_RELEVANCE）',
    b.verdict === 'INVALID_RELEVANCE', JSON.stringify({ verdict: b.verdict, overlap: b.overlap }));
}

// ── AUD-03：真反例必须被认出来（否则这一层就成了"永远不判反例"的摆设）───────
{
  const c = relevanceOf({ claim: CLAIM_NOBODY_LOOK, counterEvidence: COUNTER_LOOK });
  ok('AUD-03', '「没人看主角」×「有人明确看了主角一眼」是真反例（判 RELEVANT，并给出共享词）',
    c.verdict === 'RELEVANT' && c.overlap.length >= 2,
    JSON.stringify({ verdict: c.verdict, overlap: c.overlap }));
}

// ── 合并结果：降级条目不进 disputes，也不被删掉 ─────────────────────────────
{
  const initialReport = {
    issues: [{ id: 'R-0001', text: '系统播报' }, { id: 'R-0002', text: '没人看主角' }],
    findings: [
      { id: 'R-0001', title: CLAIM_SYSTEM, evidence: [{ quote: '滴' }], acceptance: { rule: '保持克制' } },
      { id: 'R-0002', title: CLAIM_NOBODY_LOOK, evidence: [{ quote: '滴' }], acceptance: { rule: '无人注视' } },
    ],
  };
  const compare = {
    verdict: 'COMPLETE_WITH_EVIDENCE',
    coverage: { resources: [{ name: 'article', ranges: [[0, 10]], complete: true }], dimensions: {} },
    initial_findings: [
      { issue_id: 'R-0001', verdict: 'DISPUTED', reason: '正文里有人说话', counter_evidence: [{ quote: COUNTER_TALK }] },
      { issue_id: 'R-0002', verdict: 'DISPUTED', reason: '有人看了主角', counter_evidence: [{ quote: COUNTER_LOOK }] },
    ],
    new_findings: [],
  };
  const merged = mergeReview({ initialReport, blind: { findings: [], scanned_ranges: [[0, 10]] }, compare });
  const r1 = merged.findings.find((f) => f.issue_id === 'R-0001');
  const r2 = merged.findings.find((f) => f.issue_id === 'R-0002');
  ok('AUD-01b', '不相干的那条：disputed=false、原始裁决仍保留、降级台账有记录（没被悄悄删掉）',
    r1.disputed === false && r1.review_verdict === 'DISPUTED'
      && r1.review_verdict_effective === 'ADVISORY_NEEDS_REVIEW'
      && merged.relevance_downgrades.some((d) => d.issue_id === 'R-0001' && d.verdict === 'INVALID_RELEVANCE'),
    JSON.stringify({ disputed: r1.disputed, eff: r1.review_verdict_effective }));
  ok('AUD-03b', '真反例仍然算驳倒：disputed=true、进 disputes、不计入 advisory',
    r2.disputed === true && merged.stats.disputes === 1 && merged.stats.advisory === 1
      && merged.issues.find((i) => i.id === 'R-0002').disputed === true,
    JSON.stringify(merged.stats));
}

// ── AUD-04：引用的反例不在正文里 → 不是证据 ─────────────────────────────────
{
  const article = '九月的上午，闷得人后背发潮。';
  const v = verifyQuotes(article, ['平头男生一直在说话']);
  ok('AUD-04', '逐字核验：正文里没有的反例句子被标成 missing（不进正式 finding）',
    v.ok === false && v.missing.length === 1, JSON.stringify(v));
}

// ── AUD-05 / AUD-06：缺字段必须可定位，且 DISPUTED 必须交出反例 ─────────────
{
  // 故意造一份"六项都缺"的提交（现场报告的形状：6 条缺字段）
  const payload = {
    schema_version: 'review-audit.v0',
    verdict: 'ALL_GOOD',
    coverage: { resources: [], dimensions: {} },
    initial_findings: [
      { issue_id: 'R-0001', verdict: 'DISPUTED' },
      { verdict: 'COVERED' },
    ],
    new_findings: [{ title: '没有 id 的新问题', evidence: [{ quote: '滴' }], acceptance: {} }],
  };
  const defects = defectsOf('review', payload, { auditId: 'qa_test_1' });
  const fields = new Set(defects.map((d) => d.field_path));
  const shapeOk = defects.every((d) => d.audit_id === 'qa_test_1' && d.field_path && d.expected_type
    && d.actual_type && d.source && d.error_code && d.severity && d.resolution_path);
  ok('AUD-05', '缺字段诊断是逐字段台账（审计号/finding/字段/期望/实际/来源/严重度/处理路径），不是一句"6 条缺字段"',
    defects.length >= 6 && shapeOk
      && fields.has('schema_version') && fields.has('verdict')
      && fields.has('coverage.resources') && fields.has('coverage.dimensions.blueprint')
      && fields.has('initial_findings[].issue_id') && fields.has('initial_findings[R-0001].counter_evidence')
      && fields.has('new_findings[].id'),
    JSON.stringify([...fields]));

  ok('AUD-06', '判 DISPUTED 却没有反例逐字证据 → 阻断级缺陷，且标注"只能让模型重新给"',
    defects.some((d) => d.field_path === 'initial_findings[R-0001].counter_evidence'
      && d.severity === 'blocker' && d.resolution_path === DEFECT_RESOLUTION.PAID_REGENERATE
      && d.finding_id === 'R-0001'));

  const val = validateReviewAuditPayload(payload, { auditId: 'qa_test_1' });
  ok('AUD-06b', '校验摘要与缺陷台账同源（errors 逐字取自 defects.detail，不存在第二份判据）',
    val.ok === false && val.errors.length === val.defects.length
      && val.errors.every((e, i) => e === val.defects[i].detail),
    JSON.stringify({ errors: val.errors.length, defects: val.defects.length }));

  const good = {
    schema_version: 'review-audit.v1', verdict: 'COMPLETE_WITH_EVIDENCE',
    coverage: {
      resources: [{ name: 'article', ranges: [[0, 10]], complete: true }],
      dimensions: Object.fromEntries(['blueprint', 'continuity', 'character', 'causality', 'repetition', 'style', 'pacing_hook', 'temporal_foreshadowing', 'evidence_integrity'].map((d) => [d, true])),
    },
    initial_findings: [
      { issue_id: 'R-0001', verdict: 'COVERED' },
      { issue_id: 'R-0002', verdict: 'ADVISORY_NEEDS_REVIEW' },
    ],
    new_findings: [],
  };
  const okVal = validateReviewAuditPayload(good, { auditId: 'qa_test_2' });
  ok('AUD-06c', '结构完整的提交通过，且 ADVISORY_NEEDS_REVIEW 是合法对照结论（降级有地方落）',
    okVal.ok === true && INITIAL_FINDING_VERDICTS.includes('ADVISORY_NEEDS_REVIEW'),
    JSON.stringify(okVal.errors));
}

// ── AUD-07：RESULT_RECEIVED 不等于可合并 ────────────────────────────────────
{
  const toMerged = canTransition(RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.MERGED);
  const toVerified = canTransition(RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.HOST_VERIFIED);
  ok('AUD-07', '收到结果不能直接合并：必须先主机校验（RESULT_RECEIVED→HOST_VERIFIED 才合法）',
    toMerged.ok === false && toVerified.ok === true
      && toMerged.code === ERROR_CODES.AUDIT_CONTRACT_INVALID,
    JSON.stringify({ toMerged, toVerified }));
}

// ── 解释信息：signal 只用于展示，不参与扣分 ─────────────────────────────────
{
  const s = claimSignals(CLAIM_SYSTEM);
  ok('AUD-10', 'claim 信号（否定/时点/主语提示）可解释，且不会被当成判定依据',
    s.negation === true && s.time.length >= 1 && s.tokens.length > 3 && typeof s.subject_hint === 'string',
    JSON.stringify({ negation: s.negation, time: s.time }));
}

// ── AUD-08 / AUD-09：道具持有状态与声音载体（确定性线索，不伪定硬伤）──────────
{
  const article = '他把纸对折，再对折，折成四分之一大小，塞进校服裤兜。\n“D。”岳宸炎晃了晃手里的东西。';
  const conflicts = propStateConflictsOf(article);
  ok('AUD-08', '「塞进裤兜」之后直接「晃了晃手里的东西」→ 报道具状态不连续，并附**两处**逐字证据',
    conflicts.length === 1 && conflicts[0].code === 'POSSIBLE_OBJECT_STATE_CONFLICT'
      && conflicts[0].evidence.length === 2
      && /塞进校服裤兜/.test(conflicts[0].evidence[0]) && /晃了晃手里的东西/.test(conflicts[0].evidence[1]),
    JSON.stringify(conflicts));

  const withRelease = '他把纸折好塞进裤兜，随后从裤兜里掏出那张纸，晃了晃手里的纸。';
  ok('AUD-08b', '中间写了「从裤兜里掏出」→ 不报（有拿出来的动作就不是断的）',
    propStateConflictsOf(withRelease).length === 0);

  const sound = '系统声音直接在耳边响起。\n耳机里安安静静的。';
  const hints = soundCarrierHints(sound);
  ok('AUD-09', '「耳边」之后出现「耳机」→ 只报 NEED_CONTEXT（提示核验载体，不判成硬伤）',
    hints.length === 1 && hints[0].code === 'NEED_CONTEXT_SOUND_CARRIER'
      && hints[0].evidence.length === 2,
    JSON.stringify(hints));

  ok('AUD-09b', '干净的正文不编造线索（线索判据不能变成"总有东西可报"）',
    auditLeadHintsOf('九月的上午，闷得人后背发潮。他抬手擦了擦汗。').total === 0);

  // 线索要真的进到复核结果里（并且**不阻塞**复核）
  const integ = reviewIntegrityCheck({ schema_version: 'review.v3', issues: [{ id: 'R-0001', text: 'x' }], findings: [{ id: 'R-0001', title: 'x', evidence: [{ quote: '塞进校服裤兜' }], acceptance: { rule: 'r' } }] }, article);
  ok('AUD-08c', '确定性线索进入复核结果的 advisories，且不阻塞（不把线索当结论）',
    Array.isArray(integ.advisories) && integ.advisories.some((x) => x.code === 'POSSIBLE_OBJECT_STATE_CONFLICT')
      && integ.ok === true,
    JSON.stringify({ ok: integ.ok, advisories: (integ.advisories || []).map((x) => x.code) }));
}

// ── FREE_REPARSE：能由契约唯一确定的字段自动补齐，其余一律不代编 ──────────────
{
  const payload = {
    verdict: 'COMPLETE_WITH_EVIDENCE',
    coverage: { resources: [{ name: 'article', ranges: [[0, 9]], complete: true }], dimensions: {} },
    initial_findings: [{ verdict: 'COVERED' }, { verdict: 'COVERED' }],
    new_findings: [{ title: 't', evidence: [{ quote: 'q' }], acceptance: { rule: 'r' } }],
  };
  const r = autoRepairPayload('review', payload, { auditId: 'qa_fr1', initialIssueIds: ['R-0001', 'R-0002'] });
  ok('FR-01', '自动补齐只补"契约能唯一确定"的字段：schema_version / 按顺序的 issue_id / QA-R 编号',
    r.applied.includes('schema_version')
      && r.payload.schema_version === 'review-audit.v1'
      && JSON.stringify(r.payload.initial_findings.map((f) => f.issue_id)) === JSON.stringify(['R-0001', 'R-0002'])
      && r.payload.new_findings[0].id === 'QA-R-0001',
    JSON.stringify({ applied: r.applied, ids: r.payload.initial_findings.map((f) => f.issue_id) }));

  ok('FR-02', '补不干净的仍然原样拦下（缺 coverage 维度不在自动补齐范围）',
    r.ok === false && r.remaining.some((d) => /coverage\.dimensions/.test(d.field_path)));

  const mismatch = autoRepairPayload('review', {
    verdict: 'COMPLETE_WITH_EVIDENCE',
    coverage: { resources: [{ name: 'article', ranges: [[0, 9]], complete: true }], dimensions: {} },
    initial_findings: [{ verdict: 'COVERED' }], new_findings: [],
  }, { initialIssueIds: ['R-0001', 'R-0002'] });
  ok('FR-03', '条数与冻结初审对不上时**不**按位置硬补（那等于替它编一份对不上号的结论）',
    mismatch.payload.initial_findings[0].issue_id === undefined
      && mismatch.applied.every((x) => !/issue_id/.test(x)));

  const blocked = autoRepairPayload('review', {
    schema_version: 'review-audit.v1', verdict: 'COMPLETE_WITH_EVIDENCE',
    coverage: { resources: [{ name: 'article', ranges: [[0, 9]], complete: true }], dimensions: {} },
    initial_findings: [{ issue_id: 'R-0001', verdict: 'DISPUTED' }], new_findings: [],
  }, { initialIssueIds: ['R-0001'] });
  ok('FR-04', '语义字段（反例引用）绝不自动编造：缺 counter_evidence 仍然阻断',
    blocked.ok === false
      && blocked.remaining.some((d) => /counter_evidence/.test(d.field_path) && d.severity === 'blocker'));
}

console.log(`\n相关性/缺字段：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
