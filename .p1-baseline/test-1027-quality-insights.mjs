#!/usr/bin/env node
/**
 * .p1-baseline/test-1027-quality-insights.mjs —— v1.2.4 P2 四项 + P1 跨边界联合证据：
 *   ① 质量趋势与章节级回归（quality-trend）
 *   ② 作品级质量规则档案（quality-profile，且它真的影响验收）
 *   ③ 修复效果统计（quality-insights）
 *   ④ 跨作品模板迁移（quality-profile 的 export/import/diff）
 *   ⑤ 分段跨边界联合证据（revision-finalize 的 row.cross_segment）
 *
 * 全部是纯函数断言：不调用模型、不写库、零计费。退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
const asUrl = (rel) => new URL('../' + rel, import.meta.url).href;
await import(asUrl('public/quality-trend.js'));
await import(asUrl('public/quality-profile.js'));
await import(asUrl('public/quality-insights.js'));
await import(asUrl('public/revision-semantic-verifier.js'));
await import(asUrl('public/revision-closure.js'));
await import(asUrl('public/revision-finalize.js'));
const QT = globalThis.NovelQualityTrend;
const QP = globalThis.NovelQualityProfile;
const QI = globalThis.NovelQualityInsights;
const FZ = globalThis.NovelRevisionFinalize;

// ══════════════════════════════════════════════════════════════════════════
// ① 质量趋势
// ══════════════════════════════════════════════════════════════════════════
{
  const runs = [
    { chapter_index: 0, at: 't1', metrics: { template_hits: 3, chars: 3200 } },
    { chapter_index: 1, at: 't2', metrics: { template_hits: 2, chars: 3400 } },
    { chapter_index: 2, at: 't3', metrics: { template_hits: 1, chars: 3600 } },
    { chapter_index: 3, at: 't4', metrics: {} },                    // 缺值 → skipped
    { chapter_index: 4, at: 't5', metrics: { template_hits: 0 } },
    { chapter_index: 5, at: 't6', metrics: { template_hits: 1 } },
  ];
  const s = QT.seriesOf(runs, 'template_hits');
  check('TR-01 序列抽取：只取有值的样本，缺值单独计数（不把缺失当 0）',
    s.points.length === 5 && s.skipped === 1 && s.total === 6
      && s.points.map((p) => p.value).join(',') === '3,2,1,0,1',
    JSON.stringify({ n: s.points.length, skipped: s.skipped, values: s.points.map((p) => p.value) }));

  const few = QT.trendOf([{ value: 1 }, { value: 2 }, { value: 3 }]);
  check('TR-02 样本 < 5 → 只列明细、不给趋势方向（不拿 3 个点谈"长期趋势"）',
    few.enough === false && few.direction === 'unknown' && /少于 5/.test(few.note),
    JSON.stringify({ enough: few.enough, note: few.note }));

  const up = QT.trendOf([{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }, { value: 6 }]);
  const down = QT.trendOf([{ value: 6 }, { value: 5 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 1 }]);
  check('TR-03 样本够时给出斜率与方向，且措辞明确"这只是观测，不是好坏结论"',
    up.enough === true && up.direction === 'up' && down.direction === 'down' && /观测/.test(up.note),
    JSON.stringify({ up: up.direction, down: down.direction, slope: up.slope }));

  const worse = QT.chapterRegression({ metric: 'template_hits', current: 9, history: [1, 2, 1, 3, 2], threshold: 1 });
  const ok = QT.chapterRegression({ metric: 'template_hits', current: 2, history: [1, 2, 1, 3, 2], threshold: 1 });
  const short = QT.chapterRegression({ metric: 'template_hits', current: 9, history: [1, 2], threshold: 1 });
  check('TR-04 章节级回归：高于历史中位数+阈值 → 劣化；历史不足 → 不下结论',
    worse.enough === true && worse.worse === true && ok.worse === false
      && short.enough === false && short.worse === false,
    JSON.stringify({ worse: worse.worse, ok: ok.worse, short: short.note }));

  const chars = QT.chapterRegression({ metric: 'chars', current: 3000, history: [4000, 4200, 3900], threshold: 500 });
  check('TR-05 指标方向可配置（字数"越高越好"：低于中位数才算劣化）',
    chars.worse === true && /低于|低/.test(chars.note), JSON.stringify({ worse: chars.worse, note: chars.note }));

  const ov = QT.overviewOf(runs);
  check('TR-06 总览覆盖全部指标，并各自带足/不足样本的说明',
    ov.length === QT.METRICS.length && ov.every((m) => m.trend && typeof m.trend.note === 'string'),
    JSON.stringify(ov.map((m) => [m.metric, m.trend.enough])));
}

// ══════════════════════════════════════════════════════════════════════════
// ② 作品级质量规则档案
// ══════════════════════════════════════════════════════════════════════════
{
  const norm = QP.normalizeProfile({
    schema: 'whatever', target_words: 4000, hard_min_chars: 3900,
    required_terms: ['3751', '', '3751', 'x'.repeat(80)], forbidden_patterns: ['细白的手腕'],
    ai_flavor_max: 3, timeline_strict: true, note: '作者备注',
    // 白名单外的键：必须被丢弃并回报（模板不能偷偷注入语义）
    auto_repair_rounds: 99, semantic_verify: false, danger: 'x',
  });
  check('PR-01 白名单：未知键一律丢弃并回报（不能靠模板改产品门禁）',
    norm.profile.auto_repair_rounds === undefined && norm.profile.semantic_verify === undefined
      && norm.ignoredKeys.includes('auto_repair_rounds') && norm.ignoredKeys.includes('danger'),
    JSON.stringify(norm.ignoredKeys));
  check('PR-02 合法值被接受；空项/超长项被丢弃并报错（不静默吞掉）',
    norm.profile.target_words === 4000 && norm.profile.hard_min_chars === 3900
      && norm.profile.required_terms.join(',') === '3751'
      && norm.profile.forbidden_patterns.join(',') === '细白的手腕'
      && norm.errors.some((e) => e.key === 'required_terms'),
    JSON.stringify({ terms: norm.profile.required_terms, errors: norm.errors }));

  const bad = QP.normalizeProfile({ target_words: -1, ai_flavor_max: 'abc', timeline_strict: 'yes' });
  check('PR-03 非法值被拒绝并报出（不"尽力而为"地改成 0）',
    bad.profile.target_words === 0 && bad.profile.ai_flavor_max === null && bad.profile.timeline_strict === false
      && bad.errors.length >= 3,
    JSON.stringify(bad.errors.map((e) => e.key)));

  const conflict = QP.normalizeProfile({ target_words: 3000, hard_min_chars: 3500 });
  check('PR-04 硬下限高于目标字数 → 报出而不是偷偷改数（否则每章都判不达标）',
    conflict.errors.some((e) => e.key === 'hard_min_chars' && /每一章/.test(e.reason || '')),
    JSON.stringify(conflict.errors));

  const applied = QP.applyProfile([
    { id: 'B07', type: 'world_time_anchor', acceptance: {} },
    { id: 'B08', type: 'target_length', acceptance: {} },
    { id: 'B09', type: 'target_length', acceptance: { min_chars: 9000 } },
    { id: 'B10', type: 'world_time_anchor', acceptance: { must_contain: ['0731'] } },
    { id: 'B11', type: 'narrative_style', acceptance: {} },
  ], norm.profile);
  check('PR-05 档案**真的**影响验收：只补缺省、不覆盖审稿已给出的更具体值',
    applied[0].acceptance.must_contain.join(',') === '3751'
      && applied[1].acceptance.min_chars === 3900
      && applied[2].acceptance.min_chars === 9000
      // 档案是**并入**而不是覆盖：作者/审稿已给的 0731 要保留，档案的 3751 追加进来
      && applied[3].acceptance.must_contain.join(',') === '0731,3751'
      && !applied[4].acceptance.min_chars && !applied[4].acceptance.must_contain,
    JSON.stringify(applied.map((f) => [f.id, f.acceptance])));

  const hits = QP.scanForbidden('她有一只手伸过来，那是一只细白的手腕。', norm.profile);
  check('PR-06 禁忌字面扫描（确定性）：命中给出偏移与上下文',
    hits.length === 1 && hits[0].pattern === '细白的手腕' && hits[0].index > 0,
    JSON.stringify(hits));

  const tpl = QP.exportTemplate(norm.profile);
  const round = QP.importTemplate(JSON.stringify(tpl), {});
  check('PR-07 导出→导入可逐字往返（模板迁移的最小闭环）',
    round.ok === true && round.profile.hard_min_chars === 3900
      && round.profile.required_terms.join(',') === '3751'
      && tpl.schema === QP.TEMPLATE_SCHEMA,
    JSON.stringify({ ok: round.ok, hard: round.profile.hard_min_chars }));

  check('PR-08 损坏/异种模板被拒绝且**不改变**当前档案',
    QP.importTemplate('{bad json', { target_words: 1234 }).ok === false
      && QP.importTemplate({ schema: 'other/9', rules: { target_words: 1 } }, { target_words: 1234 }).reason === 'SCHEMA_MISMATCH',
    JSON.stringify([QP.importTemplate('{bad json', { target_words: 1234 }).reason,
      QP.importTemplate({ schema: 'other/9', rules: {} }, {}).reason]));

  const diff = QP.diffProfiles({ target_words: 3000, timeline_strict: false }, { target_words: 4000, timeline_strict: true });
  check('PR-09 跨作品迁移前能列出差异（会改到哪些键）',
    diff.some((d) => d.key === 'target_words' && d.from === 3000 && d.to === 4000)
      && diff.some((d) => d.key === 'timeline_strict'),
    JSON.stringify(diff));
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 修复效果统计
// ══════════════════════════════════════════════════════════════════════════
{
  const runs = [
    { rows: [
      { final_status: 'ISSUE_VERIFIED', type: 'object_state' },
      { final_status: 'UNRESOLVED', reason_code: 'ANCHOR_NOT_EDITED', type: 'temporal_consistency' },
      { final_status: 'AWAITING_SEMANTIC', type: 'narrative_style' },
    ], auto_repair_rounds: 1 },
    { rows: [
      { final_status: 'ISSUE_VERIFIED', type: 'object_state' },
      { final_status: 'UNRESOLVED', reason_code: 'ANCHOR_NOT_EDITED', type: 'temporal_consistency' },
    ], auto_repair_rounds: 2 },
    { rows: [
      { final_status: 'ISSUE_VERIFIED', type: 'object_state' },
      { final_status: 'CANON_CONFLICT', reason_code: 'CANON_CONFLICT', type: 'canon_conflict' },
    ], auto_repair_rounds: 0 },
  ];
  const st = QI.effectStats(runs);
  check('IN-01 统计：未跑语义的项**不进分母**（成功率先要"有结论"）',
    st.total_issues === 7 && st.fixed === 3 && st.awaitings === 1
      && st.success_rate === Math.round((3 / 6) * 1000) / 1000,
    JSON.stringify({ total: st.total_issues, fixed: st.fixed, awaiting: st.awaitings, rate: st.success_rate }));

  const few = QI.effectStats([{ rows: [{ final_status: 'ISSUE_VERIFIED' }] }]);
  check('IN-02 运行不足 3 次 → 不给成功率（样本守卫），但计数照给',
    few.enough === false && few.success_rate === null && few.fixed === 1,
    JSON.stringify({ enough: few.enough, rate: few.success_rate, note: few.note }));

  check('IN-03 反复修不掉的问题类型按失败率排序（这才是作者想知道的跨章问题）',
    QI.stubbornTypes(st)[0].type === 'temporal_consistency'
      && QI.stubbornTypes(st)[0].fail_rate === 1,
    JSON.stringify(QI.stubbornTypes(st)));

  check('IN-04 常见失败原因码被聚合（用于解释"为什么老修不掉"）',
    st.top_codes[0].code === 'ANCHOR_NOT_EDITED' && st.top_codes[0].count === 2,
    JSON.stringify(st.top_codes));

  check('IN-05 一行摘要与明细口径一致（不出现"成功率"时明说样本不足）',
    /成功率 50%/.test(QI.summaryLine(st)) && /样本不足/.test(QI.summaryLine(few)),
    QI.summaryLine(st));
}

// ══════════════════════════════════════════════════════════════════════════
// ④ 分段跨边界联合证据
// ══════════════════════════════════════════════════════════════════════════
{
  const base = '开头：折过两折。\n\n结尾：折过一折。';
  const after = '开头：折过两折。\n\n结尾：折过两折。';
  const findings = [{
    id: 'B01', title: '折数不一致',
    evidence: [
      { quote: '折过两折', role: 'reference' },
      { quote: '折过一折', role: 'candidate_edit' },
      { quote: '结尾：折过一折。', role: 'candidate_edit' },
    ],
    acceptance: { rule: '折数一致' },
  }];
  const seg = FZ.finalizeRevisionCandidate({
    mode: 'segmented', originalText: base, candidateText: after,
    selectedIssueIds: ['B01'],
    applied: [{ issue_ids: ['B01'], segment_id: 'seg-2', op: 'replace', original: '', replacement: '' }],
    coverage: [{ issue_id: 'B01', status: 'patched' }],
    segments: [
      { segment_id: 'seg-1', status: 'done', proof_ok: true, evidence_editable_issue_ids: ['B01'] },
      { segment_id: 'seg-2', status: 'done', proof_ok: true, evidence_editable_issue_ids: ['B01'] },
    ],
    mergeComplete: true, findings,
  });
  const row = seg.rows.find((r) => r.issue_id === 'B01');
  check('XS-01 跨片证据：同一 issue 的可编辑锚点落在两片、只改到一片 → 记录 split 与未处理片',
    row && row.cross_segment && row.cross_segment.split === true
      && row.cross_segment.evidence_segments.length === 2
      && row.cross_segment.untouched_segments.includes('seg-1'),
    JSON.stringify(row && row.cross_segment));

  const rec = FZ.runRecordOf(seg, {});
  check('XS-02 运行记录带上证据跨片情况（回执可复核"哪一片没被处理"）',
    rec.issues[0].evidence_segments && rec.issues[0].evidence_segments.length === 2
      && rec.issues[0].untouched_segments.includes('seg-1'),
    JSON.stringify(rec.issues[0]));

  const single = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: base, candidateText: after,
    selectedIssueIds: ['B01'],
    applied: [{ issue_ids: ['B01'], span_id: 's', op: 'replace', original: '折过一折', replacement: '折过两折', start: base.indexOf('折过一折'), end: base.indexOf('折过一折') + 4 }],
    coverage: [{ issue_id: 'B01', status: 'patched' }], findings,
  });
  check('XS-03 单段运行不产生"跨片"字段（不伪造分段证据）',
    single.rows[0].cross_segment === null,
    JSON.stringify(single.rows[0].cross_segment));
}

finish('test-1027 质量趋势 / 规则档案 / 效果统计 / 跨边界证据');
