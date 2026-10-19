#!/usr/bin/env node
/**
 * test-1030-ui-closure.mjs —— UI 方案（ui方案.md）的**纯函数**验收：
 *   单行入口四态、四阶段、问题三维状态、摘要恒等式 N=P+F+U+B、未复验≠PASS。
 *
 * 为什么先测纯函数：这些判据是界面展示的"事实来源"。DOM/浏览器测试证明"排得下"，
 * 但证明不了"数字与状态是否被正确归类"；两者不能互相替代（方案 §15.3）。
 *
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
await import(new URL('../public/review-workspace.js', import.meta.url).href);
const RW = globalThis.NovelRevisionWorkspace;

const row = (issue_id, final_status, extra = {}) => ({
  issue_id, final_status,
  semantic_status: final_status === 'ISSUE_VERIFIED' ? 'pass' : (final_status === 'AWAITING_SEMANTIC' ? 'not_run' : 'fail'),
  coverage_status: extra.coverage_status || 'patched',
  authorized: extra.authorized !== undefined ? extra.authorized : true,
  patch_count: extra.patch_count !== undefined ? extra.patch_count : 1,
  title: `问题 ${issue_id}`,
  ...extra,
});

// ── 单行入口四态 ───────────────────────────────────────────────────────────
{
  check('UI-01 没有相关任务时不显示入口（不得凭空造一条"已完成"）',
    RW.entryLineOf({ rows: [], selected: 0 }) === null, String(RW.entryLineOf({ rows: [], selected: 0 })));
  const running = RW.entryLineOf({
    rows: [row('I01', 'AWAITING_SEMANTIC')], selected: 1, running: true, runningRound: 2,
  });
  check('UI-02 运行中：显示"正在复验第 N 轮"，不显示完成',
    running && /正在复验第 2 轮/.test(running.text) && !/完成|全部通过/.test(running.text),
    JSON.stringify(running));
  const notRun = RW.entryLineOf({
    rows: [row('I01', 'AWAITING_SEMANTIC'), row('I02', 'UNRESOLVED')],
    selected: 2, patchedCount: 1, semanticRuns: 0,
  });
  check('UI-03 有候选但未语义复验：必须写"尚未语义复验"，不得写完成',
    notRun && /尚未语义复验/.test(notRun.text) && !/全部通过|完成/.test(notRun.text),
    JSON.stringify(notRun));
  const pending = RW.entryLineOf({
    rows: [row('I01', 'ISSUE_VERIFIED'), row('I02', 'UNRESOLVED')],
    selected: 2, patchedCount: 2, semanticRuns: 1,
  });
  check('UI-04 有未通过项：显示"1/2 待处理"，不显示全部通过',
    pending && /1\/2 待处理/.test(pending.text) && !/全部通过/.test(pending.text),
    JSON.stringify(pending));
  const allPass = RW.entryLineOf({
    rows: [row('I01', 'ISSUE_VERIFIED'), row('I02', 'ISSUE_VERIFIED')],
    selected: 2, patchedCount: 2, semanticRuns: 1,
  });
  check('UI-05 全部通过：显示"已选项全部通过（尚未合并）"，不得暗示已合并',
    allPass && /已选项全部通过/.test(allPass.text) && /尚未合并/.test(allPass.text),
    JSON.stringify(allPass));
}

// ── 四阶段 ────────────────────────────────────────────────────────────────
{
  const s1 = RW.stagesOf({ rows: [], patchedCount: 0, stage: 'AWAITING_SEMANTIC' });
  check('UI-06 四阶段顺序固定：审稿清单→生成修稿→逐项验收→审阅与合并',
    s1.map((s) => s.id).join(',') === 'review,generate,verify,commit',
    JSON.stringify(s1.map((s) => s.id)));
  const s2 = RW.stagesOf({
    rows: [row('I01', 'AWAITING_SEMANTIC')], patchedCount: 1, stage: 'AWAITING_SEMANTIC',
  });
  check('UI-07 进入"逐项验收"不等于完成：verfiy=active、commit=pending',
    s2.find((s) => s.id === 'verify').state === 'active'
      && s2.find((s) => s.id === 'commit').state === 'pending',
    JSON.stringify(s2));
  const s3 = RW.stagesOf({
    rows: [row('I01', 'ISSUE_VERIFIED')], patchedCount: 1, stage: 'VERIFIED_CANDIDATE',
  });
  check('UI-08 全部通过后第 4 阶段才 active（且仍不是 done，除非已入库）',
    s3.find((s) => s.id === 'commit').state === 'active',
    JSON.stringify(s3));
}

// ── 三维状态 ──────────────────────────────────────────────────────────────
{
  const dims = RW.dimensionsOf(row('I03', 'UNRESOLVED', { patch_count: 0, coverage_status: 'keep', authorized: false, semantic_status: 'fail' }));
  check('UI-09 三维分开：授权态 / 操作态 / 验证态各说各的',
    dims.authorization.code === 'SELECTED_NO_EDIT'
      && dims.operation.code === 'NO_PATCH'
      && dims.verification.code === 'FAIL',
    JSON.stringify(dims));
  const rows = RW.issueRowsOf({ rows: [row('I04', 'AWAITING_SEMANTIC', { semantic_status: 'not_run' })] });
  check('UI-10 列表行同时携带三维文本，详情不必再自己猜',
    rows[0].dimensions_text.includes('已选·已授权')
      && rows[0].dimensions_text.includes('候选已应用')
      && rows[0].dimensions_text.includes('未语义复验'),
    rows[0].dimensions_text);
}

// ── 摘要恒等式与"未复验≠PASS" ───────────────────────────────────────────
{
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row(`P${i}`, 'ISSUE_VERIFIED')),
    row('F1', 'UNRESOLVED'),
    row('P2', 'PARTIAL'),
  ];
  const f = RW.summaryFormulaOf(rows);
  check('UI-11 摘要恒等式 N=P+F+U+B：8=6+2+0+0，且计数闭合',
    f.total === 8 && f.pass === 6 && f.fail === 2 && f.unverified === 0 && f.blocked === 0 && f.balanced === true,
    JSON.stringify(f));
  const mixed = RW.summaryFormulaOf([
    row('A', 'ISSUE_VERIFIED'), row('B', 'UNRESOLVED'), row('C', 'AWAITING_SEMANTIC'), row('D', 'CANON_CONFLICT'),
  ]);
  check('UI-12 蓝图冲突计入阻塞 B；四类互斥不重不漏',
    mixed.pass === 1 && mixed.fail === 1 && mixed.unverified === 1 && mixed.blocked === 1 && mixed.balanced === true,
    JSON.stringify(mixed));
  const line = RW.summaryLine({ chapterTitle: '第一章', rows: [row('A', 'AWAITING_SEMANTIC')], patchedCount: 1 });
  check('UI-13 摘要在未复验时绝不出现"已验证 1"或"通过 1"',
    !/已验证\s*[1-9]/.test(line) && !/通过\s*[1-9]/.test(line), line);

  const bad = RW.summaryFormulaOf([row('A', 'ISSUE_VERIFIED'), row('B', 'SOMETHING_NEW')]);
  check('UI-14 未知终态必须计入 unknown 且 balanced=false（不能悄悄归到 B 让等式恒成立）',
    bad.pass === 1 && bad.blocked === 0 && bad.unknown === 1 && bad.balanced === false,
    JSON.stringify(bad));
}

// ── 详情字段透传与"全通过但 0 补丁"入口 ─────────────────────────────────
{
  const rich = row('I04', 'ISSUE_VERIFIED', {
    checks: [{ criterion: '规则闭合', passed: true }],
    canon: { strength: 'hard', entry_title: '等级规则' },
    cross_segment: { split: true, evidence_segments: ['s1', 's2'], patched_segments: ['s1'], untouched_segments: ['s2'] },
    repair_hint: '只在授权热点内重写',
  });
  const projected = RW.issueRowsOf({ rows: [rich] })[0];
  check('UI-15 issueRowsOf 必须透传 checks/canon/cross_segment/repair_hint（抽屉不能永远空）',
    Array.isArray(projected.checks) && projected.checks.length === 1
      && projected.canon && projected.canon.entry_title === '等级规则'
      && projected.cross_segment && projected.cross_segment.untouched_segments.length === 1
      && projected.repair_hint === '只在授权热点内重写',
    JSON.stringify({ checks: projected.checks.length, canon: !!projected.canon, cross: !!projected.cross_segment, hint: projected.repair_hint }));

  const noPatchPass = RW.entryLineOf({
    rows: [row('A', 'ISSUE_VERIFIED', { patch_count: 0 }), row('B', 'ISSUE_VERIFIED', { patch_count: 0 })],
    selected: 2, patchedCount: 0, semanticRuns: 1,
  });
  check('UI-16 全部通过但 0 补丁时仍显示"已选项全部通过"，不得落成"0/N 待处理"',
    noPatchPass && /已选项全部通过/.test(noPatchPass.text) && !/0\/2 待处理/.test(noPatchPass.text),
    JSON.stringify(noPatchPass));
}

finish('test-1030 UI 闭环纯函数断言');
