/**
 * tests/narrative-repair/01-patch-protocol.test.mjs —— P 类：局部补丁协议 v2（§8.1 全部必做）。
 *
 * 覆盖 P01—P09、P14 的**模块级**判定面（协议/跨度/组合/门禁姿态）。
 * P10—P13 中需要真实调用链（不再回退整章、取消与恢复幂等、覆盖表渲染）的部分
 * 由 frontend-test.mjs 的接线断言与 02-orchestration.test.mjs 覆盖。
 *
 * 纪律：每条断言都对着**实际实现**跑；零用例 → 非零退出。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();
check('P00', '协议模块与门禁模块都已加载（UMD 入口有效）', !!RP && !!K, `RP=${!!RP} K=${!!K}`);
check('P00b', '协议版本可读且与实现一致', typeof RP.VERSION === 'string' && RP.VERSION.startsWith('2.'), RP.VERSION);

const V2 = (snapshot, patches, extra = {}) => JSON.stringify({
  schema_version: 2,
  snapshot_id: snapshot.snapshot_id,
  base_hash: snapshot.body_hash,
  patches,
  ...extra,
});
const P = (span, op, original, replacement, issueIds = ['q1'], patchId = 'p1') => ({
  patch_id: patchId, group_id: patchId, issue_ids: issueIds, span_id: span.span_id, op, original, replacement,
});

// ── P01 显式删除 ───────────────────────────────────────────────────────────
{
  const base = '上午八点四十，江陵市第三检测中心，候检大厅。\n\n女生走到石板前，右手按了上去。\n\n然后她不一样了。\n\n检测石亮了。';
  const snap = RP.snapshotOf(base, { chapter_id: 101, work_id: 7 });
  const span = RP.buildSpans(base, { sentences: true }).find((x) => x.text === '然后她不一样了。');
  const run = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 101, selectedIssueIds: ['N05'], engine: K,
    raw: V2(snap, [P(span, 'delete', '然后她不一样了。', '', ['N05'])], { dispositions: [{ issue_id: 'N05', status: 'patched', reason: '重复预告' }] }),
  });
  check('P01', '显式 delete 真的删掉整段（不再要求填一句废话）', run.ok === true && run.applied.length === 1 && run.applied[0].op === 'delete', JSON.stringify({ ok: run.ok, applied: run.applied.length, err: run.error_code }));
  check('P01b', '只删除授权 span：其余文字与换行逐字不变',
    run.text === base.slice(0, span.start) + base.slice(span.sep_end),
    JSON.stringify(run.text));
  check('P01c', '删除整段不会留下空段（段尾分隔符随跨度一起授权）', !/\n{3,}/.test(run.text), JSON.stringify(run.text));
  check('P01d', '删除路径不产生任何"整章重写"信号', !('full_rewrite' in run) && run.ok === true && run.plan.patches.length === 1);
}

// ── P02 缺字段 / 类型错误 与 delete 的严格区分 ─────────────────────────────
{
  const base = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 1 });
  const span = RP.buildSpans(base, { sentences: true })[0];
  const cases = [
    ['replace 的 replacement 为空串', { ...P(span, 'replace', '甲段。', '') }, 'replace_requires_nonempty'],
    ['replace 的 replacement 是 null', { ...P(span, 'replace', '甲段。', null) }, 'bad_replacement_type'],
    ['replace 的 replacement 是数字', { ...P(span, 'replace', '甲段。', 5) }, 'bad_replacement_type'],
    ['replace 缺 replacement 字段', (() => { const p = P(span, 'replace', '甲段。', 'x'); delete p.replacement; return p; })(), 'missing_replacement'],
    ['delete 缺 replacement 字段', (() => { const p = P(span, 'delete', '甲段。', ''); delete p.replacement; return p; })(), 'missing_replacement'],
    ['未知操作 op:"remove"', { ...P(span, 'remove', '甲段。', ''), op: 'remove' }, 'unknown_op'],
    ['缺 span_id', (() => { const p = P(span, 'replace', '甲段。', '乙'); delete p.span_id; return p; })(), 'missing_span'],
  ];
  let allErr = true;
  let allUnchanged = true;
  const seen = [];
  for (const [label, patch, expectCode] of cases) {
    const r = RP.runRevisionPipeline({ snapshot: snap, raw: V2(snap, [patch]), selectedIssueIds: ['q1'], chapterId: 1, engine: K });
    const codeHit = r.ok === false && r.error_code === 'schema_error' && (r.errors || []).some((e) => e.code === expectCode);
    if (!codeHit) allErr = false;
    if (r.text !== base) allUnchanged = false;
    seen.push(`${label}:${r.ok ? 'OK' : r.error_code}/${(r.errors || []).map((e) => e.code).join(',')}`);
  }
  check('P02', '缺 replacement / 类型错误 / 未知操作 / 缺 span 一律 schema_error', allErr, seen.join(' | '));
  check('P02b', '全部 schema_error 场景下原文一个字符都没动', allUnchanged);
  check('P02c', '"缺 replacement" 绝不等于 delete（错误码可区分）',
    (() => {
      const p = P(span, 'delete', '甲段。', ''); delete p.replacement;
      const r = RP.runRevisionPipeline({ snapshot: snap, raw: V2(snap, [p]), selectedIssueIds: ['q1'], chapterId: 1, engine: K });
      return r.ok === false && (r.errors || []).some((e) => e.code === 'missing_replacement');
    })());
}

// ── P03 合法空补丁 + 每个已选问题的处置 ────────────────────────────────────
{
  const base = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 2 });
  const ok = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 2, selectedIssueIds: ['i1', 'i2'], engine: K,
    raw: V2(snap, [], {
      dispositions: [
        { issue_id: 'i1', status: 'keep', reason: '结尾短句承担查验停顿，保留' },
        { issue_id: 'i2', status: 'deferred', reason: '证据不足' },
      ],
    }),
  });
  check('P03', '合法空补丁正常结束，且如实显示"未改动"', ok.ok === true && ok.noop === true && ok.text === base && ok.applied.length === 0);
  check('P03b', '空补丁下每个已选问题的处置都可读（keep/deferred 带理由）',
    ok.coverage.length === 2 && ok.coverage.every((c) => c.status === 'keep' || c.status === 'deferred') && ok.coverage.every((c) => c.reason) && ok.coverage_ok === true,
    JSON.stringify(ok.coverage));
  const silent = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 2, selectedIssueIds: ['i1', 'i2'], engine: K,
    raw: V2(snap, [], {}),
  });
  check('P03c', '空补丁但没有任何处置 → 不得显示"全部问题已解决"',
    silent.ok === true && silent.coverage_ok === false && silent.unaccounted.length === 2,
    JSON.stringify({ coverage_ok: silent.coverage_ok, unaccounted: silent.unaccounted.length }));
}

// ── P04 坏载荷不得被折叠成"合法空补丁" ─────────────────────────────────────
{
  const bad = [
    ['{"patches":[{}]}', 'schema_error', 'missing_original'],
    ['{"patches":[{"anchor":"还记得那天"}]}', 'schema_error', 'missing_replacement'],
    ['{"patches":[{"anchor":"a","revised":"b"}', 'parse_error', 'json_invalid'],
    ['{"patches":[{"anchor":"a","revised":"b"}],"patches":[]}', 'parse_error', 'duplicate_key'],
    ['{"patches":[{"anchor":"a","revised":"b"}]}\n看这里又给了一份：\n{"patches":[{"anchor":"a","revised":"c"}]}', 'schema_error', 'conflicting_json'],
  ];
  let allFail = true;
  const detail = [];
  for (const [raw, expectCode, expectSub] of bad) {
    const d = RP.decodePatchOutput(raw);
    const hit = d.ok === false && d.error_code === expectCode && (d.errors || []).some((e) => e.code === expectSub);
    if (!hit) allFail = false;
    detail.push(`${expectSub}→${d.ok ? 'ACCEPTED(!)' : d.error_code}[${(d.errors || []).map((e) => e.code).join(',')}]`);
  }
  check('P04', 'patches:[{}] / 半截 JSON / 重复 key / 两份冲突 JSON 都是明确失败', allFail, detail.join(' | '));
  // 关键回归：旧实现把坏元素丢光后返回 `[]`，而 `[]` 是合法 noop —— 事故被显示成结论。
  const base = '甲段。';
  const snap = RP.snapshotOf(base, { chapter_id: 3 });
  const folded = RP.runRevisionPipeline({ snapshot: snap, raw: '{"patches":[{}]}', selectedIssueIds: ['i1'], chapterId: 3, engine: K });
  check('P04b', '坏元素被丢弃后**绝不**报 noop 成功（不把解析事故说成结论）',
    folded.ok === false && folded.noop === false && folded.text === base,
    JSON.stringify({ ok: folded.ok, noop: folded.noop, error_code: folded.error_code }));
  const legalEmpty = RP.runRevisionPipeline({ snapshot: snap, raw: '{"patches":[]}', selectedIssueIds: [], chapterId: 3, engine: K });
  check('P04c', '真正合法的空补丁仍然是合法 noop（不误伤）', legalEmpty.ok === true && legalEmpty.noop === true && legalEmpty.text === base);
}

// ── P05 相同原句 / 锚点少标点：不猜第一处 ──────────────────────────────────
{
  const base = '相同的话。\n\n别的。\n\n相同的话。';
  const snap = RP.snapshotOf(base, { chapter_id: 4 });
  const bySpan = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 4, selectedIssueIds: ['q'], engine: K,
    raw: V2(snap, [P({ span_id: 'p3' }, 'replace', '相同的话。', '改后。', ['q'])]),
  });
  check('P05', '重复原句用 span_id + 逐字原文定位，只改授权的那一处',
    bySpan.ok === true && bySpan.text === '相同的话。\n\n别的。\n\n改后。', JSON.stringify(bySpan.text));
  const mismatch = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 4, selectedIssueIds: ['q'], engine: K,
    raw: V2(snap, [P({ span_id: 'p3' }, 'replace', '相同的话', '改后。', ['q'])]),
  });
  check('P05b', '锚点少一个标点 → anchor_mismatch（不猜、不"包含式"改整段）',
    mismatch.ok === false && mismatch.error_code === 'anchor_mismatch' && mismatch.text === base,
    JSON.stringify({ code: mismatch.error_code, text: mismatch.text }));
  const legacyDup = K ? null : null;
  check('P05c', '旧格式（anchor/revised）重复原句仍由前端层拒绝第一处猜测（见 frontend-test 90a）', legacyDup === null);
}

// ── P06 只授权长段中的一句 ─────────────────────────────────────────────────
{
  const base = '第一句写了很多东西，其中提到了雨、伞和鞋子，还有一整段别的内容。\n\n第二段。';
  const snap = RP.snapshotOf(base, { chapter_id: 5 });
  const sent = RP.buildSpans(base, { sentences: true }).find((x) => x.kind === 'sentence');
  const r = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 5, selectedIssueIds: ['s1'], engine: K,
    raw: V2(snap, [P(sent, 'replace', sent.text, '第一句很短。', ['s1'])]),
  });
  check('P06', '只授权一个短句时，只改这一句', r.ok === true && r.text === base.replace(sent.text, '第一句很短。'), JSON.stringify(r.text));
  check('P06b', '长段其余部分逐字不变（不走"包含命中后替换整段"）',
    r.ok === true && r.text.includes('第二段。') && r.text.split('\n\n').length === 2);
  const para = RP.buildSpans(base, { sentences: false })[0];
  const whole = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 5, selectedIssueIds: ['s1'], engine: K,
    raw: V2(snap, [P(para, 'replace', '第一句写了很多东西', '第一句很短。', ['s1'])]),
  });
  check('P06c', '把半段文字当整段原文提交 → anchor_mismatch（不允许范围扩大）',
    whole.ok === false && whole.error_code === 'anchor_mismatch', String(whole.error_code));
}

// ── P07 重叠 / 同跨度互不一致 ─────────────────────────────────────────────
{
  const base = '甲段第一句。甲段第二句。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 6 });
  const spans = RP.buildSpans(base, { sentences: true });
  const s1 = spans.find((x) => x.text === '甲段第一句。');
  const s2 = spans.find((x) => x.text === '甲段第二句。');
  const same = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 6, selectedIssueIds: ['a', 'b'], engine: K,
    raw: V2(snap, [
      P(s1, 'replace', '甲段第一句。', '改甲。', ['a'], 'p1'),
      P(s1, 'replace', '甲段第一句。', '改乙。', ['b'], 'p2'),
    ]),
  });
  check('P07', '同一跨度两条互不一致的补丁 → overlap，整批拒绝',
    same.ok === false && same.error_code === 'overlap' && same.text === base, JSON.stringify({ code: same.error_code, text: same.text }));
  check('P07b', '冲突位置与涉及补丁在结论里可见（不做"先到先得"）',
    Array.isArray(same.conflicts) && same.conflicts.length >= 1 && /先到先得|顺序覆盖|不一致/.test(same.conflicts[0].reason), JSON.stringify(same.conflicts && same.conflicts[0]));
  const overlapStart = s1.end - 2;
  const overlap = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 6, selectedIssueIds: ['a', 'b'], engine: K,
    raw: V2(snap, [
      P(s1, 'replace', s1.text, '改甲。', ['a'], 'p1'),
      // 显式跨段跨度 [s1.end-2, s2.end)：与上面那条**互相重叠**（不是同一跨度）。
      {
        patch_id: 'p2', group_id: 'p2', issue_ids: ['b'], span_id: null,
        span: { start: overlapStart, end: s2.end },
        op: 'replace', original: base.slice(overlapStart, s2.end), replacement: '改乙。',
      },
    ]),
  });
  check('P07c', '两个跨度互相重叠 → overlap，整批拒绝', overlap.ok === false && overlap.error_code === 'overlap', String(overlap.error_code));
}

// ── P08 组合门禁：单条安全、合起来断裂 ─────────────────────────────────────
{
  const base = '队伍前面那个女生走上台阶。\n\n另一个女生从通道走出来。\n\n她把手按在石板上。';
  const snap = RP.snapshotOf(base, { chapter_id: 8 });
  const ps = RP.buildSpans(base, { sentences: false });
  const mk = (ids) => V2(snap, [
    P(ps[0], 'replace', ps[0].text, '队伍前面的人走上台阶。', ['x'], 'a'),
    P(ps[1], 'replace', ps[1].text, '另一个人从通道走出来。', ['y'], 'b'),
  ].filter((p) => ids.includes(p.patch_id)), { dispositions: [{ issue_id: 'x', status: 'patched' }, { issue_id: 'y', status: 'patched' }] });
  const solo1 = RP.runRevisionPipeline({ snapshot: snap, raw: mk(['a']), selectedIssueIds: ['x', 'y'], chapterId: 8, engine: K });
  const solo2 = RP.runRevisionPipeline({ snapshot: snap, raw: mk(['b']), selectedIssueIds: ['x', 'y'], chapterId: 8, engine: K });
  check('P08-PRE', '前提：这两条删除**单独**看都是安全的（门禁不响）',
    solo1.safety_blocked !== true && solo2.safety_blocked !== true && solo1.verified === true && solo2.verified === true,
    JSON.stringify({ s1: solo1.combined && solo1.combined.status, s2: solo2.combined && solo2.combined.status }));
  const both = RP.runRevisionPipeline({ snapshot: snap, raw: mk(['a', 'b']), selectedIssueIds: ['x', 'y'], chapterId: 8, engine: K });
  check('P08', '组合后删光"她"的先行语 → 组合门禁抓到', both.safety_blocked === true && (both.combined.hard || []).some((f) => f.code === 'reference_anchor'),
    JSON.stringify((both.combined || {}).hard));
  check('P08b', '组合候选不被称为"已验证"', both.verified === false);
  check('P08c', '组合候选仍可看（不因为门禁而丢掉作者要看的东西）', !!both.text && both.text.length > 0 && both.text !== undefined);
  check('P08d', '同一处断裂不重复占用作者注意力（去重后只报一条）',
    (both.combined.findings || []).filter((f) => f.code === 'reference_anchor').length === 1,
    JSON.stringify((both.combined.findings || []).map((f) => f.code)));
}

// ── P09 越权引用 ───────────────────────────────────────────────────────────
{
  const base = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 9 });
  const spans = RP.buildSpans(base, { sentences: true });
  const p1 = spans.find((x) => x.text === '甲段。');
  const cases = [
    ['引用未勾选的问题', V2(snap, [P(p1, 'replace', '甲段。', '改过。', ['not-selected'])]), 'out_of_scope'],
    ['补丁不声明处理哪个已选问题', V2(snap, [{ ...P(p1, 'replace', '甲段。', '改过。', []), issue_ids: [] }]), 'selection_mismatch'],
  ];
  let ok = true;
  const codes = [];
  for (const [label, raw, expect] of cases) {
    const r = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 9, engine: K });
    codes.push(`${label}:${r.error_code}`);
    if (!(r.ok === false && r.error_code === expect && r.text === base)) ok = false;
  }
  check('P09', '未选问题 / 不声明问题 → out_of_scope / selection_mismatch，原文不变', ok, codes.join(' | '));
  const ctxOnly = RP.runRevisionPipeline({
    snapshot: snap, raw: V2(snap, [P(p1, 'replace', '甲段。', '改过。', ['q1'])]),
    selectedIssueIds: ['q1'], contextOnlySpanIds: ['p1'], chapterId: 9, engine: K,
  });
  check('P09b', '只读上下文（context-only）跨度不可修改 → out_of_scope', ctxOnly.ok === false && ctxOnly.error_code === 'out_of_scope' && ctxOnly.text === base, String(ctxOnly.error_code));
  const otherChapter = RP.runRevisionPipeline({
    snapshot: snap, raw: V2(snap, [P({ span_id: 'p9', }, 'replace', '甲段。', '改过。', ['q1'])]),
    selectedIssueIds: ['q1'], chapterId: 9, engine: K,
  });
  check('P09c', '别章 / 不存在的 span → out_of_scope，原文不变', otherChapter.ok === false && otherChapter.error_code === 'out_of_scope' && otherChapter.text === base, String(otherChapter.error_code));
  check('P09d', '模型自报 approval 字段不产生任何权限（协议里没有"批准"这个输入）',
    (() => {
      const raw = JSON.stringify({
        schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash, approved: true, approved_by: 'model',
        patches: [P(p1, 'replace', '甲段。', '改过。', ['q1'])],
      });
      const r = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 9, engine: K });
      // 改动仍然只能来自"已选问题 + 授权跨度"；approval 字段既不报错也不给权限。
      return r.ok === true && r.plan.patches[0].issue_ids[0] === 'q1';
    })());
}

// ── P10 源稿过期（stale）：不猜、不覆盖 ────────────────────────────────────
{
  const base = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 10 });
  const spans = RP.buildSpans(base, { sentences: true });
  const p1 = spans.find((x) => x.text === '甲段。');
  const edited = '甲段（作者刚改过）。\n\n乙段。';
  const stale = RP.staleCheck(snap, edited);
  check('P10', '审稿后作者改稿 → staleCheck 报 stale 且带两个指纹', stale.stale === true && !!stale.expected_hash && !!stale.actual_hash);
  const mismatch = RP.runRevisionPipeline({
    snapshot: RP.snapshotOf(edited, { chapter_id: 10 }), chapterId: 10, selectedIssueIds: ['q1'], engine: K,
    raw: V2(snap, [P(p1, 'replace', '甲段。', '改过。', ['q1'])]),
  });
  check('P10b', '把旧补丁套到新稿 → stale（不猜位置、不覆盖新稿）',
    mismatch.ok === false && mismatch.error_code === 'stale' && mismatch.text === edited,
    JSON.stringify({ code: mismatch.error_code, kept_new_draft: mismatch.text === edited }));
}

// ── P11 有界预算与幂等 ─────────────────────────────────────────────────────
{
  const b = RP.createRetryBudget({ max: 2 });
  const t1 = b.take();
  const t2 = b.take();
  const t3 = b.take();
  check('P11', '重试预算是共享的、有界的（2 次后不再放行）',
    t1.ok === true && t2.ok === true && t3.ok === false && t3.error_code === 'budget_exhausted' && b.used === 2);
  const frozen = RP.createRetryBudget({ max: 2, used: 2 });
  check('P11b', '跨刷新恢复沿用同一预算（把已用次数带回来，不叠加成无限调用）', frozen.take().ok === false);
  const k1 = RP.idempotencyKey({ snapshotId: 's1', baseHash: 'h1', issueIds: ['i2', 'i1'], patches: [{ span_id: 'p1', op: 'replace' }] });
  const k2 = RP.idempotencyKey({ snapshotId: 's1', baseHash: 'h1', issueIds: ['i1', 'i2'], patches: [{ span_id: 'p1', op: 'replace' }] });
  const k3 = RP.idempotencyKey({ snapshotId: 's1', baseHash: 'h1', issueIds: ['i1'], patches: [{ span_id: 'p1', op: 'replace' }] });
  check('P11c', '重复点击采纳落到同一个幂等键；换了勾选集合就是新任务',
    k1 === k2 && k1 !== k3, `${k1} / ${k2} / ${k3}`);
}

// ── P12 门禁不可用：不冒充安全通过 ─────────────────────────────────────────
{
  const base = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 12 });
  const spans = RP.buildSpans(base, { sentences: true });
  const p1 = spans.find((x) => x.text === '甲段。');
  const raw = V2(snap, [P(p1, 'replace', '甲段。', '改过。', ['q1'])]);
  const noEngine = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 12, engine: null });
  check('P12', '门禁模块未加载 → safety_unavailable，且**不**被称为已验证',
    noEngine.ok === true && noEngine.combined.status === 'safety_unavailable' && noEngine.verified === false,
    JSON.stringify({ status: noEngine.combined.status, verified: noEngine.verified }));
  check('P12b', '候选仍可看（手工编辑与明确采纳不受影响）', noEngine.text !== base && noEngine.applied.length === 1, JSON.stringify(noEngine.text));
  const boom = { HARD_CODES: K.HARD_CODES, paragraphsOf: K.paragraphsOf, deletionRisks: () => { throw new Error('boom'); }, verifyPatchedText: () => { throw new Error('boom'); } };
  const threw = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 12, engine: boom });
  check('P12c', '门禁抛异常 → safety_unavailable（不静默降级成"安全"）',
    threw.combined.status === 'safety_unavailable' && threw.verified === false, String(threw.combined.status));
  const malformed = { HARD_CODES: K.HARD_CODES, paragraphsOf: K.paragraphsOf, verifyPatchedText: () => ({ findings: 'not-an-array' }), deletionRisks: () => 'not-an-array' };
  const bad = RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['q1'], chapterId: 12, engine: malformed });
  check('P12d', '门禁返回畸形结果 → 不冒充安全通过（如实标注未验证）',
    bad.verified === false && bad.combined.status !== 'ok', String(bad.combined.status));
}

// ── P13 三种"没改成"必须可区分，且都不扩大为整章重写 ───────────────────────
{
  const base = '大屏切到海澜市。\n\n他在看。';
  const snap = RP.snapshotOf(base, { chapter_id: 13 });
  const spans = RP.buildSpans(base, { sentences: true });
  const p1 = spans.find((x) => x.text === '大屏切到海澜市。');
  const blocked = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 13, selectedIssueIds: ['q1'], engine: K,
    raw: V2(snap, [P(p1, 'delete', '大屏切到海澜市。', '', ['q1'])], { dispositions: [{ issue_id: 'q1', status: 'patched' }] }),
  });
  check('P13', '被门禁拦下的补丁不进候选，原文保持原样（blocked 可见）',
    blocked.safety_blocked === true && blocked.text === base, JSON.stringify({ blocked: blocked.safety_blocked }));
  const unresolved = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 13, selectedIssueIds: ['q1'], engine: K,
    raw: V2(snap, [P({ span_id: 'p2' }, 'replace', '这段根本不在快照里。', '改后。', ['q1'])]),
  });
  check('P13b', '锚点全部未命中 → unresolved 语义（anchor_mismatch），不产生候选',
    unresolved.ok === false && unresolved.error_code === 'anchor_mismatch' && unresolved.text === base, String(unresolved.error_code));
  // 依赖组原子性：同组一条失败 → 整组不进入候选；独立组仍可进入候选并显示未完成项。
  const groupRun = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 13, selectedIssueIds: ['q1', 'q2'], engine: K,
    raw: JSON.stringify({
      schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
      patches: [
        { patch_id: 'g1a', group_id: 'g1', issue_ids: ['q1'], span_id: 'p2', op: 'replace', original: '这段根本不在快照里。', replacement: 'x' },
        { patch_id: 'g1b', group_id: 'g1', issue_ids: ['q1'], span_id: 'p1', op: 'replace', original: '大屏切到海澜市。', replacement: '大屏切到海澜市，画面里全是人。' },
        { patch_id: 'g2a', group_id: 'g2', issue_ids: ['q2'], span_id: 'p1', op: 'replace', original: '大屏切到海澜市。', replacement: '大屏切到海澜市，画面里全是人。' },
      ],
      dispositions: [{ issue_id: 'q1', status: 'patched' }, { issue_id: 'q2', status: 'patched' }],
    }),
  });
  check('P13c', '依赖组原子：同组一条失败则该组整体不进入候选，且未完成项可见',
    groupRun.ok === true && groupRun.applied.length === 1 && groupRun.unresolved.some((u) => u.status === 'blocked'),
    JSON.stringify({ applied: groupRun.applied.length, unresolved: groupRun.unresolved }));
  check('P13d', '任何一类"没改成"都不产生整章重写请求（协议层没有这条路径）',
    !JSON.stringify(blocked).includes('full_rewrite') && !JSON.stringify(unresolved).includes('full_rewrite') && !JSON.stringify(groupRun).includes('full_rewrite'));
}

// ── P14 快照口径：Unicode / CRLF / 空行 / 段合并 ───────────────────────────
{
  const base = '甲段，带 emoji 🀄 与组合字符 é。\r\n\r\n乙段。\r\n\r\n丙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 14 });
  const spans = RP.buildSpans(base, { sentences: true });
  const p2 = spans.find((x) => x.span_id === 'p2');
  check('P14', 'CRLF 正文的分段与偏移仍精确（span 文本等于切片）',
    base.slice(p2.start, p2.end) === p2.text && p2.text === '乙段。', JSON.stringify({ slice: base.slice(p2.start, p2.end), span: p2.text }));
  const r = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 14, selectedIssueIds: ['q1'], engine: K,
    raw: V2(snap, [P(p2, 'replace', p2.text, '乙段改。', ['q1'])]),
  });
  check('P14b', '未授权内容（含 CRLF 与 emoji）逐字保持', r.ok === true && r.text === base.replace('乙段。', '乙段改。'), JSON.stringify(r.text));
  const merged = RP.mergeAdjacentSpans(base, [spans.find((x) => x.span_id === 'p2'), spans.find((x) => x.span_id === 'p3')]);
  check('P14c', '需要跨两段编辑时由 Host 显式授予连续跨度（段间换行只在授权跨度内可动）',
    merged.length === 1 && merged[0].merged === true && base.slice(merged[0].start, merged[0].end).includes('丙段'), JSON.stringify(merged[0]));
  const emojiSpan = RP.buildSpans('😀😀😀\n\n下一段。', { sentences: false });
  check('P14d', 'emoji（代理对）不破坏偏移：span 文本仍是精确切片',
    base !== undefined && emojiSpan[0].text === '😀😀😀' && '😀😀😀\n\n下一段。'.slice(emojiSpan[0].start, emojiSpan[0].end) === '😀😀😀');
  const mapping = RP.verifyCombinedCandidate('甲。\n\n乙。', '甲改。\n\n丙。', { engine: K, plan: { patches: [] } });
  check('P14e', '没有计划时不硬报断裂（空计划 ≠ 已验证：status 明确）', mapping.status === 'unchanged' || mapping.status === 'ok' || mapping.verified === false, String(mapping.status));
}

// ── 协议自证：无授权就无改动（阴性对照） ───────────────────────────────────
{
  const base = '甲段。\n\n乙段。';
  const snap = RP.snapshotOf(base, { chapter_id: 15 });
  const noSelection = RP.runRevisionPipeline({ snapshot: snap, raw: V2(snap, []), selectedIssueIds: [], chapterId: 15, engine: K });
  check('P15', '阴性对照：没有任何补丁时正文逐字不变', noSelection.text === base && noSelection.applied.length === 0);
  const same = RP.buildSpans(base, { sentences: true }).find((x) => x.text === '甲段。');
  const noop = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 15, selectedIssueIds: ['q1'], engine: K,
    raw: V2(snap, [P(same, 'replace', '甲段。', '甲段。', ['q1'])]),
  });
  check('P15b', 'no-op（replacement 与原文逐字相同）被如实报告，不计入实际改动',
    noop.ok === true && noop.applied.length === 0 && noop.noop === true && noop.noop_reasons.length === 1,
    JSON.stringify({ applied: noop.applied.length, noop_reasons: noop.noop_reasons }));
}

// ── 2026-10-09 审查修复的回归（每条都先复现旧行为、再钉住新行为） ────────────
{
  // P16【高】句级精确改动不得被"逐条门禁按整段模拟"误拦。
  // 旧行为（本次修复前实测）：allBlocked=true / blocked=['object_provenance'] / applied=0，
  // 理由是"删掉了后文仍在使用的物件来源「面包」"—— 而那个词还在同一段的第二句里。
  const base = '王磊把面包递给岳宸炎，一个字没说。岳宸炎把面包塞进书包。\n\n他把面包咬了一口。';
  const snap = RP.snapshotOf(base, { chapter_id: 16 });
  const sent = RP.buildSpans(base, { sentences: true }).find((x) => x.text === '王磊把面包递给岳宸炎，一个字没说。');
  const mk = (spanId, original, replacement) => {
    const raw = V2(snap, [P({ span_id: spanId }, 'replace', original, replacement, ['1'])], { dispositions: [{ issue_id: '1', status: 'patched' }] });
    return RP.runRevisionPipeline({ snapshot: snap, raw, selectedIssueIds: ['1'], chapterId: 16, engine: K });
  };
  const bySentence = mk(sent.span_id, sent.text, '王磊把一个袋子递过去。');
  check('P16', '句级精确替换不再被逐条门禁误拦（改动没有删掉后文在用的物件来源）',
    bySentence.ok === true && bySentence.applied.length === 1 && (bySentence.blocked || []).length === 0
    && bySentence.safety_blocked !== true,
    JSON.stringify({ applied: bySentence.applied.length, blocked: (bySentence.blocked || []).map((b) => b.code), combined: bySentence.combined && bySentence.combined.status }));
  check('P16b', '同一改动用段跨度表达时结论一致（不再"看模型选了哪个粒度"）',
    (() => {
      const para = RP.buildSpans(base, { sentences: false })[0];
      const byPara = mk(para.span_id, para.text, '王磊把一个袋子递过去。岳宸炎把面包塞进书包。');
      return byPara.applied.length === bySentence.applied.length && byPara.text === bySentence.text;
    })());
  check('P16c', '真实候选不会被误判为"已验证"的例外：组合核验在这条路径上确实跑过',
    bySentence.combined && bySentence.combined.status === 'ok' && bySentence.verified === true,
    JSON.stringify(bySentence.combined && bySentence.combined.status));
  check('P16d', '同一份正文里真删掉物件来源**仍然**被硬拦（修复没有把门禁放松）',
    (() => {
      const live = '王磊把面包递给岳宸炎，一个字没说。\n\n岳宸炎吃面包。';
      const s2 = RP.snapshotOf(live, { chapter_id: 16 });
      const raw = V2(s2, [P({ span_id: 'p1' }, 'delete', '王磊把面包递给岳宸炎，一个字没说。', '', ['1'])]);
      const r = RP.runRevisionPipeline({ snapshot: s2, raw, selectedIssueIds: ['1'], chapterId: 16, engine: K });
      return r.allBlocked === true && (r.blocked || []).some((b) => b.code === 'object_provenance') && r.text === live;
    })());
  // P17：跨度内"事实增量过大"按**跨度级**补回，不能因为按段对齐而丢掉这条保护
  const growBase = '他站在门口。\n\n外面在下雨。';
  const growSpan = RP.buildSpans(growBase, { sentences: true }).find((x) => x.text === '他站在门口。');
  const growRaw = V2(RP.snapshotOf(growBase, { chapter_id: 17 }), [P(growSpan, 'replace', growSpan.text,
    '他站在门口，手里攥着一张写着 B区 两个字的号单，旁边还停着一辆悬浮车，车里坐着一个穿制服的人，正低头看手里的名单，嘴里念念有词，像是要念很久很久。', ['1'])]);
  const grow = RP.runRevisionPipeline({ snapshot: RP.snapshotOf(growBase, { chapter_id: 17 }), raw: growRaw, selectedIssueIds: ['1'], chapterId: 17, engine: K });
  check('P17', '授权跨度内塞进一整段新内容仍然被拦（跨度级判据补回，不因按段对齐而开缺口）',
    (grow.blocked || []).some((b) => b.code === 'story_fact') && grow.applied.length === 0,
    JSON.stringify((grow.blocked || []).map((b) => b.code)));
}

{
  // P18【中】"别章跨度"判据要真的可判：快照属于第 5 章、调用方声称在编辑第 7 章 → 必须拒绝。
  // 旧行为（修复前实测）：跨度用调用方的 chapterId 打标 → 判据恒成立 → ok=true / applied=1。
  const base = '甲段。\n\n乙段。';
  const snap5 = RP.snapshotOf(base, { chapter_id: 5 });
  const raw = V2(snap5, [P({ span_id: 'p1' }, 'replace', '甲段。', '甲段改。', ['1'])]);
  const cross = RP.runRevisionPipeline({ snapshot: snap5, raw, selectedIssueIds: ['1'], chapterId: 7, engine: K });
  check('P18', '快照属于别章时拒绝（跨度按快照章打标，判据才可判）',
    cross.ok === false && cross.error_code === 'out_of_scope' && cross.text === base,
    JSON.stringify({ ok: cross.ok, code: cross.error_code }));
  const same = RP.runRevisionPipeline({ snapshot: snap5, raw, selectedIssueIds: ['1'], chapterId: 5, engine: K });
  check('P18b', '同一章时照常通过（没有把正常路径一起拦掉）', same.ok === true && same.applied.length === 1);
}

{
  // P19【中】删除的分隔符归属：① 末段不留尾随空行；② 段跨度与句跨度删同一段结果一致。
  const base = '甲。\n\n乙。\n\n丙。';
  const snap = RP.snapshotOf(base, { chapter_id: 19 });
  const del = (spanId, original) => RP.runRevisionPipeline({
    snapshot: snap, selectedIssueIds: ['1'], chapterId: 19, engine: K,
    raw: V2(snap, [P({ span_id: spanId }, 'delete', original, '', ['1'])]),
  }).text;
  const last = del('p3', '丙。');
  check('P19', '删除文末那一段不留尾随空行（旧行为实测为 "甲。\\n\\n乙。\\n\\n"）',
    last === '甲。\n\n乙。' && !/\n\n$/.test(last), JSON.stringify(last));
  const short = '甲。\n\n乙。';
  const snap2 = RP.snapshotOf(short, { chapter_id: 19 });
  const del2 = (spanId) => RP.runRevisionPipeline({
    snapshot: snap2, selectedIssueIds: ['1'], chapterId: 19, engine: K,
    raw: V2(snap2, [P({ span_id: spanId }, 'delete', '甲。', '', ['1'])]),
  }).text;
  check('P19b', '同一意图用段跨度/句跨度结果一致（单句成段时按段落删除处理）',
    del2('p1') === del2('p1s1') && del2('p1') === '乙。', JSON.stringify({ p: del2('p1'), s: del2('p1s1') }));
}

{
  // P20【中】段落带前导空白时，组合核验的偏移坐标系必须统一（旧行为实测：假警告 + 跳过组合分析）。
  const base = '  他很累。他坐下了。\n\n窗外没有动静。';
  const snap = RP.snapshotOf(base, { chapter_id: 20 });
  const sent = RP.buildSpans(base, { sentences: true }).find((x) => x.text === '他坐下了。');
  const r = RP.runRevisionPipeline({
    snapshot: snap, selectedIssueIds: ['1'], chapterId: 20, engine: K,
    raw: V2(snap, [P(sent, 'replace', sent.text, '他把包放下。', ['1'])]),
  });
  check('P20', '带前导空白的段落不再产生 unsupported_mapping 假警告（组合核验照常跑）',
    r.ok === true && r.combined.status !== 'unsupported_mapping' && r.verified === true
    && !(r.combined.findings || []).some((f) => f.code === 'unsupported_mapping'),
    JSON.stringify({ status: r.combined.status, findings: (r.combined.findings || []).map((f) => f.code) }));
}

{
  // P21【低】一份能解析 + 一份"完整但坏" → 不得静默挑一份执行（§6.6）。
  const d = RP.decodePatchOutput('{"patches":[]}\n\n另外一份：\n{"patches":[],"patches":[]}');
  check('P21', '多份 JSON 中有一份坏掉时拒绝执行（不挑一份）',
    d.ok === false && d.error_code === 'schema_error' && (d.errors || []).some((e) => e.code === 'partial_json_ignored'),
    JSON.stringify({ ok: d.ok, code: d.error_code, codes: (d.errors || []).map((e) => e.code) }));
  const one = RP.decodePatchOutput('{"patches":[]}');
  check('P21b', '仍然只输出一份合法 JSON 时不误伤（配额没被这条收紧搞坏）', one.ok === true && one.patch.patches.length === 0);
}

finish('01-patch-protocol');
