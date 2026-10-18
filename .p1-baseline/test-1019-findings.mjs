#!/usr/bin/env node
/**
 * .p1-baseline/test-1019-findings.mjs —— v1.2.1 审稿质量闭环 P0-1/P0-2：finding.v2 契约。
 *
 * 覆盖方案 §12 的 R-01/R-02/R-03（以及它们的反例）：
 *   R-01 旧 issues[{text}] → 兼容显示；无证据时明确 EVIDENCE_MISSING
 *   R-02 findings[].evidence 两处跨度 → 都记录为只读/可编辑证据，且只读项不取得写权限
 *   R-03 同一原文出现多次 → AMBIGUOUS_ANCHOR，不猜第一处
 *
 * 零依赖、零计费、离线。退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
await import(new URL('../public/revision-findings.js', import.meta.url).href);
const F = globalThis.NovelRevisionFindings;

const BODY = [
  '岳宸炎把检测单折过两折，纸边对齐得很仔细。',
  '',
  '王磊把单子拍在桌上，职业方向那一栏印着“基础战斗能力”。',
  '',
  '林清雪把袖口往上拢了拢，细白的手腕露出来。',
  '',
  '检测单也在同一个口袋里，折过一折。',
].join('\n');

// ── R-01：旧报告只有 issues[{text}] ─────────────────────────────────────────
{
  const norm = F.normalizeReviewReport({ summary: '总评', issues: [{ text: '检测单折数前后矛盾' }, '群演反应堆叠'] });
  check('R-01a 旧 issues 被适配成 findings（条数一致，id 稳定为原始序号）',
    norm.findings.length === 2 && norm.findings[0].id === '1' && norm.findings[1].id === '2',
    JSON.stringify(norm.findings.map((f) => f.id)));
  check('R-01b 适配条目一律 legacy=true 且带 EVIDENCE_MISSING（不伪装成已定位）',
    norm.findings.every((f) => f.legacy === true
      && f.diagnostics.some((d) => d.code === 'EVIDENCE_MISSING')),
    JSON.stringify(norm.findings.map((f) => f.diagnostics.map((d) => d.code))));
  check('R-01c 适配条目 actionable=false（没有证据就不能进入精确定位）',
    norm.findings.every((f) => f.actionable === false));
  check('R-01d 自然语言 issues 仍然保留给旧界面显示',
    norm.issues.length === 2 && norm.issues[0] === '检测单折数前后矛盾',
    JSON.stringify(norm.issues));
  check('R-01e 报告级诊断显式说明"这份审稿没有 findings"',
    norm.legacy === true && norm.diagnostics.some((d) => d.code === 'LEGACY_REPORT'),
    JSON.stringify(norm.diagnostics.map((d) => d.code)));
}

// ── R-02：两处跨度（只读引用 + 可编辑目标）──────────────────────────────────
const findingTwoSpan = {
  id: 'R-0001',
  title: '检测单折数前后矛盾',
  type: 'continuity',
  severity: 'high',
  explanation: '开篇两折、章尾一折，缺少对应操作',
  evidence: [
    { quote: '折过两折', role: 'reference', required: true },
    { quote: '折过一折', role: 'candidate_edit', required: true },
  ],
  acceptance: { rule: '检测单折数与动作链前后一致', preserve: ['检测单'] },
};
{
  const norm = F.normalizeReviewReport({ findings: [findingTwoSpan] }, { bodyText: BODY });
  const f = norm.findings[0];
  check('R-02a 两处证据都记录（reference 1 处 + candidate_edit 1 处）',
    f.evidence.length === 2 && f.reference_count === 1 && f.target_count === 1,
    JSON.stringify({ ref: f.reference_count, target: f.target_count }));
  check('R-02b 每处证据给出出现次数与唯一性（bodyText 提供时）',
    f.evidence.every((e) => e.occurrences === 1 && e.unique === true),
    JSON.stringify(f.evidence.map((e) => e.occurrences)));
  check('R-02c 有可编辑目标 → 可进入计划（actionable=true），且不带 EVIDENCE_MISSING',
    f.actionable === true && !f.diagnostics.some((d) => d.code === 'EVIDENCE_MISSING'),
    JSON.stringify(f.diagnostics.map((d) => d.code)));
  const plan = F.evidencePlan(f);
  check('R-02d evidencePlan 把 reference 与 target 分开（只读证据不取得写权限）',
    plan.references.length === 1 && plan.references[0].quote === '折过两折'
    && plan.targets.length === 1 && plan.targets[0].quote === '折过一折',
    JSON.stringify({ ref: plan.references.map((e) => e.quote), target: plan.targets.map((e) => e.quote) }));
  check('R-02e 验收判据随 finding 一起保存（rule + preserve）',
    f.acceptance.rule.length > 0 && f.acceptance.preserve.includes('检测单'),
    JSON.stringify(f.acceptance));
}

// ── R-03：同一引文出现多次 → 歧义，不猜第一处 ───────────────────────────────
{
  const norm = F.normalizeReviewReport({
    findings: [{
      id: 'R-0002', explanation: '重复句',
      evidence: [{ quote: '把袖口往上拢了拢', role: 'candidate_edit' }],
    }],
  }, { bodyText: `${BODY}\n\n她又把袖口往上拢了拢。` });
  const f = norm.findings[0];
  const amb = f.evidence[0];
  check('R-03a 引文出现 2 处 → occurrences=2、unique=false',
    amb.occurrences === 2 && amb.unique === false,
    JSON.stringify({ occurrences: amb.occurrences }));
  check('R-03b 同时给出 AMBIGUOUS_ANCHOR 诊断（不是静默取第一处）',
    f.diagnostics.some((d) => d.code === 'AMBIGUOUS_ANCHOR'),
    JSON.stringify(f.diagnostics.map((d) => d.code)));
  check('R-03c 歧义条目 actionable=false（进入 needs_scope，而不是被猜着改）',
    f.actionable === false);
}

// ── 反例与边界 ──────────────────────────────────────────────────────────────
{
  const norm = F.normalizeReviewReport({
    findings: [{ id: 'R-0003', explanation: '证据不在正文', evidence: [{ quote: '这一句不在底稿里', role: 'candidate_edit' }] }],
  }, { bodyText: BODY });
  check('X-01 证据原文不在底稿 → QUOTE_NOT_FOUND 且 occurrences=0',
    norm.findings[0].evidence[0].occurrences === 0
    && norm.findings[0].diagnostics.some((d) => d.code === 'QUOTE_NOT_FOUND'),
    JSON.stringify(norm.findings[0].diagnostics.map((d) => d.code)));

  const dup = F.normalizeReviewReport({
    findings: [
      { id: 'R-9', explanation: '甲', evidence: [{ quote: '折过两折', role: 'candidate_edit' }] },
      { id: 'R-9', explanation: '乙', evidence: [{ quote: '折过一折', role: 'candidate_edit' }] },
    ],
  }, { bodyText: BODY });
  check('X-02 重复 id 不被静默合并：第二个改为确定性后缀并记 DUPLICATE_ID',
    dup.findings[0].id === 'R-9' && dup.findings[1].id === 'R-9#2'
    && dup.findings[1].diagnostics.some((d) => d.code === 'DUPLICATE_ID'),
    JSON.stringify(dup.findings.map((f) => f.id)));

  const cross = F.normalizeReviewReport({
    findings: [{
      id: 'R-4', explanation: '跨位置', cross_span: true,
      evidence: [{ quote: '折过两折', role: 'reference' }],
    }],
  }, { bodyText: BODY });
  check('X-03 声明跨位置但只有一个只读引用 → CROSS_SPAN_EVIDENCE_MISSING',
    cross.findings[0].diagnostics.some((d) => d.code === 'CROSS_SPAN_EVIDENCE_MISSING')
    && cross.findings[0].actionable === false,
    JSON.stringify(cross.findings[0].diagnostics.map((d) => d.code)));

  const noAccept = F.normalizeReviewReport({
    findings: [{ id: 'R-5', explanation: '缺判据', evidence: [{ quote: '折过一折', role: 'candidate_edit' }] }],
  }, { bodyText: BODY });
  check('X-04 缺少 acceptance.rule → 记录 ACCEPTANCE_MISSING（但仍可进入计划）',
    noAccept.findings[0].diagnostics.some((d) => d.code === 'ACCEPTANCE_MISSING')
    && noAccept.findings[0].actionable === true,
    JSON.stringify(noAccept.findings[0].diagnostics.map((d) => d.code)));

  // 勾选只是标记，不改写证据/授权。
  const selected = F.applySelection(noAccept.findings, ['R-5']);
  check('X-05 勾选标记不改变 finding 证据（选择 ≠ 证据 ≠ 授权）',
    selected[0].selected === true && selected[0].evidence.length === 1,
    JSON.stringify({ selected: selected[0].selected, evidence: selected[0].evidence.length }));

  const summary = F.diagnosticsSummary(dup.findings);
  check('X-06 诊断汇总能按原因码列出 issue 清单（供界面逐项解释）',
    summary.some((s) => s.code === 'DUPLICATE_ID' && s.issue_ids.includes('R-9#2')),
    JSON.stringify(summary));
}

finish('test-1019-findings');
