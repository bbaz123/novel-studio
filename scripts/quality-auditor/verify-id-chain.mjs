#!/usr/bin/env node
/**
 * verify-id-chain.mjs —— 阶段 1 的退出断言：审稿身份链 ID-01…ID-12（零计费、零依赖）。
 *
 * 覆盖的是方案 §1 与 §16 的 ID 矩阵中**契约层**能确定性判定的部分：
 *   ID-01 显式对象 issue → id 与 finding.id 一致、文本不变
 *   ID-02 字符串 issue + 同序 findings → 按同序契约绑定为同一 R-编号（不再生成 1/2/3）
 *   ID-03 顺序/文本明显不对应 → REVIEW_ID_MAPPING_BROKEN，拒绝按位置猜配
 *   ID-04 非连续编号（R-0001/R-0006）→ 两项都能被选中并进入选择记录
 *   ID-05 重复 finding id → REVIEW_DUPLICATE_ID
 *   ID-06 选中 id 在 findings 中缺失 → fail-closed（assertSelectionMappable 拒绝）
 *   ID-07 旧字符串报告 → 稳定 LEGACY id，可查看；evidence_status=legacy_missing
 *   ID-08 取消/重新勾选 → 保存的是稳定 id，不受排序影响（选择记录层面）
 *   ID-09 问题列表重排 → issueById / findingById 仍按 id 对齐
 *   ID-10 结构抢救成功但 findings 丢失 → REVIEW_FINDINGS_MISSING，禁止精确自动修稿
 *   ID-11 按稳定 id 取全部 evidence quote
 *   ID-12 对象 issue 渲染 → 显示 text，不出现 [object Object]
 *
 * DOM 形态的 ID-08/09/12（复选框 data-review-issue-id、按钮禁用）由 frontend-test.mjs 的
 * 同名断言覆盖 —— 那边已有真实 DOM 桩；本文件不重复造一套 DOM，只钉身份数据本身。
 */
import path from 'node:path';
import { createChecks, REPO_ROOT } from '../../tests/narrative-repair/harness.mjs';

const asUrl = (rel) => 'file://' + path.join(REPO_ROOT, rel).replace(/\\/g, '/');
await import(asUrl('public/review-contract.js'));
const RC = globalThis.NovelReviewContract;

const { check, finish } = createChecks();

if (!RC) {
  console.error('✗ review-contract 未注册：public/review-contract.js 没有导出 NovelReviewContract');
  process.exit(2);
}

// ── ID-01 ────────────────────────────────────────────────────────────────────
{
  const issues = [
    { id: 'R-0001', text: '中段重复解释等级规则' },
    { id: 'R-0002', text: '时间线三年前/两年前矛盾' },
  ];
  const findings = [
    { id: 'R-0001', title: '中段重复解释等级规则', evidence: [{ quote: '他第三次解释等级' }] },
    { id: 'R-0002', title: '时间线矛盾', evidence: [{ quote: '三年前' }] },
  ];
  const r = RC.normalizeReviewReport({ summary: 's', issues, findings }, { stage: 'strict' });
  check('ID-01', '显式对象 issue：issue.id 与 finding.id 一致，文本保持不变',
    r.integrity.ok && r.link_mode === 'explicit'
    && r.issues[0].id === 'R-0001' && r.issues[0].finding_id === 'R-0001'
    && r.issues[0].text === '中段重复解释等级规则'
    && r.issues[1].id === 'R-0002',
    JSON.stringify(r.issues.map((i) => [i.id, i.finding_id, i.link_mode])));
}

// ── ID-02 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: ['中段重复解释等级规则', '时间线矛盾'],
    findings: [
      { id: 'R-0001', title: '中段重复解释等级规则', evidence: [{ quote: 'x' }] },
      { id: 'R-0006', title: '时间线矛盾', evidence: [{ quote: 'y' }] },
    ],
  }, { stage: 'strict' });
  check('ID-02', '字符串 issue + 同序 findings：绑定为同一 R-编号，不再生成 1/2/3',
    r.integrity.ok && r.link_mode === 'position_contract'
    && r.issues[0].id === 'R-0001' && r.issues[1].id === 'R-0006'
    && !r.issues.some((i) => ['1', '2', '3'].includes(i.id)),
    JSON.stringify(r.issues.map((i) => i.id)));
}

// ── ID-03 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: ['完全不相干的话题甲', '另一个无关联的论述乙'],
    findings: [
      { id: 'R-0001', title: '时间线矛盾', evidence: [] },
      { id: 'R-0002', title: '角色性别错误', evidence: [] },
    ],
  }, { stage: 'strict' });
  check('ID-03', 'issues 与 findings 文不对题：标记 REVIEW_ID_MAPPING_BROKEN，不按位置猜配',
    r.integrity.ok === false && r.integrity.code === RC.CODES.ID_MAPPING_BROKEN && r.issues.length === 0,
    JSON.stringify({ code: r.integrity.code, issues: r.issues.length }));
}

// ── ID-04 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: [{ id: 'R-0001', text: '第一条' }, { id: 'R-0006', text: '第六条' }],
    findings: [
      { id: 'R-0001', title: '第一条', evidence: [{ quote: 'q1' }] },
      { id: 'R-0006', title: '第六条', evidence: [{ quote: 'q6' }] },
    ],
  }, { stage: 'strict' });
  const sel = RC.selectionRecord(r, ['R-0001', 'R-0006'], 42);
  check('ID-04', '非连续编号（R-0001、R-0006）两项均可被勾选、定位并进入修稿选择记录',
    r.integrity.ok && sel.selected_issue_ids.join(',') === 'R-0001,R-0006'
    && sel.selected_issues.length === 2 && sel.selected_issues[1].text === '第六条'
    && sel.review_id === 42,
    JSON.stringify(sel));
}

// ── ID-05 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: [{ id: 'R-0001', text: 'a' }],
    findings: [{ id: 'R-0001', title: 'a' }, { id: 'R-0001', title: 'b' }],
  }, { stage: 'strict' });
  const stored = RC.normalizeStoredReviewReport({
    issues: [{ id: 'R-0001', text: 'a' }],
    findings: [{ id: 'R-0001', title: 'a' }, { id: 'R-0001', title: 'b' }],
  }, 9);
  check('ID-05', '重复 finding id：保存前拒绝（REVIEW_DUPLICATE_ID），normalize 与 stored 两条路径都拦住',
    r.integrity.ok === false && r.integrity.code === RC.CODES.DUPLICATE_ID
    && stored.integrity.ok === false && stored.integrity.code === RC.CODES.DUPLICATE_ID,
    JSON.stringify({ normalized: r.integrity.code, stored: stored.integrity.code }));
}

// ── ID-06 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: [{ id: 'R-0001', text: 'a' }],
    findings: [{ id: 'R-0001', title: 'a', evidence: [{ quote: 'q' }] }],
  }, { stage: 'strict' });
  const bad = RC.assertSelectionMappable(r, ['R-0001', 'R-9999']);
  const good = RC.assertSelectionMappable(r, ['R-0001']);
  check('ID-06', '选中 id 在 structured findings 中缺失：fail-closed（不退回空证据兼容路径）',
    bad.ok === false && bad.code === RC.CODES.SELECTION_MISSING_FINDING
    && bad.missing.join(',') === 'R-9999' && good.ok === true && good.legacy === false,
    JSON.stringify({ bad, good }));
}

// ── ID-07 ────────────────────────────────────────────────────────────────────
{
  const legacy = RC.migrateLegacyReviewReport({ summary: '旧报告', issues: ['问题一', '问题二'] }, 123);
  const m = RC.assertSelectionMappable(legacy, ['LEGACY-123-1']);
  check('ID-07', '旧字符串报告：稳定 LEGACY-<review_id>-<n> 可查看；缺证据时标记 legacy_missing 且不宣称精确修复',
    legacy.schema_version === RC.LEGACY_SCHEMA_VERSION
    && legacy.issues.map((i) => i.id).join(',') === 'LEGACY-123-1,LEGACY-123-2'
    && legacy.evidence_status === 'legacy_missing'
    // ok=true 表示"可查看/可人工选择"；legacy=true + code=LEGACY_NO_EVIDENCE 表示"不算精确修复"。
    // 这两件事必须同时成立：只判 ok 会把"能看"读成"已修好"。
    && legacy.integrity.ok === true && legacy.integrity.code === RC.CODES.LEGACY_NO_EVIDENCE
    && legacy.integrity.legacy === true
    && m.ok === true && m.legacy === true && m.evidence_status === 'legacy_missing',
    JSON.stringify({ ids: legacy.issues.map((i) => i.id), code: legacy.integrity.code, ok: legacy.integrity.ok, m }));
}

// ── ID-08 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: [{ id: 'R-0001', text: 'a' }, { id: 'R-0002', text: 'b' }, { id: 'R-0003', text: 'c' }],
    findings: [
      { id: 'R-0001', title: 'a', evidence: [{ quote: 'qa' }] },
      { id: 'R-0002', title: 'b', evidence: [{ quote: 'qb' }] },
      { id: 'R-0003', title: 'c', evidence: [{ quote: 'qc' }] },
    ],
  }, { stage: 'strict' });
  // 作者先勾 1、2 → 取消 1 → 再勾 3：保存的永远是 id，不是"第几个勾选"。
  const first = RC.selectionRecord(r, ['R-0001', 'R-0002'], 7);
  const second = RC.selectionRecord(r, ['R-0002', 'R-0003'], 7);
  check('ID-08', '取消/重新勾选：保存的是稳定 id，不受勾选顺序或数量影响',
    first.selected_issue_ids.join(',') === 'R-0001,R-0002'
    && second.selected_issue_ids.join(',') === 'R-0002,R-0003'
    && second.selected_issues[0].id === 'R-0002',
    JSON.stringify({ first: first.selected_issue_ids, second: second.selected_issue_ids }));
}

// ── ID-09 ────────────────────────────────────────────────────────────────────
{
  const base = RC.normalizeReviewReport({
    issues: [{ id: 'R-0001', text: 'a' }, { id: 'R-0002', text: 'b' }],
    findings: [
      { id: 'R-0001', title: 'a', evidence: [{ quote: 'qa' }] },
      { id: 'R-0002', title: 'b', evidence: [{ quote: 'qb' }] },
    ],
  }, { stage: 'strict' });
  // 界面重排：只换显示顺序，不换身份。
  const reordered = { ...base, issues: [base.issues[1], base.issues[0]] };
  const still = RC.issueById(reordered, 'R-0001');
  const f = RC.findingById(reordered, 'R-0001');
  const sel = RC.selectionRecord(reordered, ['R-0001'], 1);
  check('ID-09', '问题列表重排：selection / trace / finding 仍按 id 对齐',
    still && still.text === 'a' && f && f.evidence[0].quote === 'qa'
    && sel.selected_issues[0].text === 'a' && sel.review_hash === base.review_hash,
    JSON.stringify({ id: still && still.id, text: still && still.text }));
}

// ── ID-10 ────────────────────────────────────────────────────────────────────
{
  const salvaged = RC.normalizeReviewReport({ summary: '抢救出的总评', issues: ['问题一', '问题二'] }, { stage: 'salvaged' });
  const m = RC.assertSelectionMappable(salvaged, ['1']);
  check('ID-10', 'JSON 抢救成功但 findings 丢失：标记 REVIEW_FINDINGS_MISSING，禁止进入完整自动修稿',
    salvaged.integrity.ok === false && salvaged.integrity.code === RC.CODES.FINDINGS_MISSING
    && salvaged.integrity.repairable === false && m.ok === false,
    JSON.stringify({ code: salvaged.integrity.code, ok: salvaged.integrity.ok, mapping: m }));
}

// ── ID-11 ────────────────────────────────────────────────────────────────────
{
  const r = RC.normalizeReviewReport({
    issues: [{ id: 'R-0001', text: '跨位置矛盾' }],
    findings: [{
      id: 'R-0001', title: '跨位置矛盾', evidence: [
        { quote: '第一处原文', role: 'candidate_edit' },
        { quote: '第二处原文', role: 'reference' },
        { quote: '   ' }, // 空引用必须被归一丢掉
      ],
    }],
  }, { stage: 'strict' });
  const f = RC.findingById(r, 'R-0001');
  const quotes = (f && f.evidence ? f.evidence : []).map((e) => e.quote);
  check('ID-11', '按稳定 id 取到该 finding 的全部 evidence quote（多处证据不丢、空白证据被丢弃）',
    quotes.length === 2 && quotes[0] === '第一处原文' && quotes[1] === '第二处原文',
    JSON.stringify(quotes));
}

// ── ID-12 ────────────────────────────────────────────────────────────────────
{
  const text = RC.issueLineText({ id: 'R-0002', text: '对象形态的问题文本' });
  const noText = RC.issueLineText({ id: 'R-0003' });
  const legacy = RC.migrateLegacyReviewReport({ issues: ['字符串形态的问题'] }, 5);
  const lines = legacy.issues.map((i) => RC.issueLineText(i));
  check('ID-12', '对象 issue 渲染：显示 issue.text，不出现 [object Object]',
    text === '对象形态的问题文本' && !String(text).includes('[object Object]')
    && noText === '（这条问题没有文本）'
    && lines.join('|') === '字符串形态的问题',
    JSON.stringify({ text, noText, lines }));
}

// ── ID-14：旧报告的完整性判定（真实事故：独立复核被 REVIEW_ID_MAPPING_BROKEN 拒绝）
{
  const legacy = RC.migrateLegacyReviewReport({ summary: '旧', issues: ['问题一', '问题二'] }, 29);
  const integ = RC.validateReviewIntegrity(legacy);
  check('ID-14', 'review.legacy：有 issues、无 findings 是"缺证据"而不是"映射断裂"',
    integ.ok === true && integ.code === RC.CODES.LEGACY_NO_EVIDENCE && integ.legacy === true,
    JSON.stringify({ ok: integ.ok, code: integ.code }));
}

// ── 附加：归一化是纯函数（不覆盖原始 payload / 幂等）──────────────────────────
{
  const raw = { summary: '旧', issues: ['A', 'B'], findings: [] };
  const before = JSON.stringify(raw);
  const normalized = RC.normalizeStoredReviewReport(raw, 88);
  const again = RC.normalizeStoredReviewReport(normalized, 88);
  check('ID-13', '迁移是纯函数且幂等：原始 payload 一字节未改，重复迁移结果一致',
    JSON.stringify(raw) === before
    && again.schema_version === normalized.schema_version
    && again.review_hash === normalized.review_hash
    && again.issues.map((i) => i.id).join(',') === 'LEGACY-88-1,LEGACY-88-2',
    JSON.stringify({ before, after: JSON.stringify(raw), ids: again.issues.map((i) => i.id) }));
}

finish('ID-01…ID-13 审稿身份链');
