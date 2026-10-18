#!/usr/bin/env node
/**
 * .p1-baseline/test-1026-timeline-canon-store.mjs —— v1.2.4 P1 三项：
 *   ① 剧情时间线结构化（时刻/事件/冲突）；
 *   ② 世界观词条强弱约束（hard/soft/unknown）；
 *   ③ 审稿运行记录可恢复（Q-15：刷新不丢候选、也不复活失效权限）。
 *
 * 这三项的共同点：都是**纯函数**，可以在没有任何模型、任何付费的情况下逐条钉住。
 * 零依赖、零计费、离线；退出码是唯一判据。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
const asUrl = (rel) => new URL('../' + rel, import.meta.url).href;
await import(asUrl('public/revision-timeline.js'));
await import(asUrl('public/revision-canon-strength.js'));
await import(asUrl('public/revision-run-store.js'));
await import(asUrl('public/revision-semantic-verifier.js'));
const T = globalThis.NovelRevisionTimeline;
const C = globalThis.NovelRevisionCanonStrength;
const S = globalThis.NovelRevisionRunStore;
const SV = globalThis.NovelRevisionSemanticVerifier;

// ══════════════════════════════════════════════════════════════════════════
// ① 剧情时间线
// ══════════════════════════════════════════════════════════════════════════
const B03_BASE = [
  '他掏出手机，10:41，没有新消息。',
  '母亲的消息是 10:23 发的：「妈这边忙，你先吃，锅里有粥。」',
  '母亲这个点刚交完班。晚上十点出门，早上八点半回来。',
].join('\n\n');
const B03_AFTER = B03_BASE.replace('10:23 发的', '刚发的');
const B03_FIXED = B03_BASE
  .replace('10:23 发的', '10:52 发的')
  .replace('母亲这个点刚交完班。', '母亲已经在家了。');

{
  const clocks = T.extractClocks(B03_BASE);
  const digital = clocks.find((c) => c.raw.includes('10:41'));
  const evening = clocks.find((c) => c.raw.includes('晚上十点'));
  const morning = clocks.find((c) => c.raw.includes('早上八点半'));
  check('TL-01 时刻抽取：数字钟点与中文钟点都能落到"当天分钟数"',
    digital && digital.minutes === 641 && evening && evening.minutes === 22 * 60 && morning && morning.minutes === 8 * 60 + 30,
    JSON.stringify([digital && digital.minutes, evening && evening.minutes, morning && morning.minutes]));
  check('TL-02 时刻抽取保留原文偏移与上下文（可定位回正文）',
    digital && digital.index === B03_BASE.indexOf('10:41') && digital.quote.includes('10:41'),
    JSON.stringify(digital && [digital.index, digital.quote.slice(0, 20)]));
  check('TL-03 无法判定的钟点如实标 ambiguous，不猜上下午',
    T.extractClocks('三点钟他醒了。').every((c) => c.minutes === null || c.ambiguous === true),
    JSON.stringify(T.extractClocks('三点钟他醒了。')));

  const base = T.detectTemporalIssues(B03_BASE);
  check('TL-04 B-02 形态：先写"没有新消息"、后写更早的发送时刻 → MESSAGE_AFTER_READ（hard）',
    base.issues.some((i) => i.code === 'MESSAGE_AFTER_READ' && i.hard === true),
    JSON.stringify(base.issues.map((i) => i.code)));
  check('TL-05 B-03 形态：写"这个点刚交完班"但归家时刻是 8:30 → SHIFT_GAP_CONFLICT（hard）',
    base.issues.some((i) => i.code === 'SHIFT_GAP_CONFLICT' && i.hard === true),
    JSON.stringify(base.issues.map((i) => i.code)));

  const after = T.detectTemporalIssues(B03_AFTER);
  check('TL-06 把 10:23 改成"刚发的"可以消掉 MESSAGE_AFTER_READ（说明它不是靠字符串硬匹配）',
    !after.issues.some((i) => i.code === 'MESSAGE_AFTER_READ'),
    JSON.stringify(after.issues.map((i) => i.code)));
  check('TL-07 但 B-03 的"刚交完班 vs 8:30 回家"仍在（改掉短信时间不能顺带翻案）',
    after.issues.some((i) => i.code === 'SHIFT_GAP_CONFLICT'),
    JSON.stringify(after.issues.map((i) => i.code)));

  const fixed = T.detectTemporalIssues(B03_FIXED);
  check('TL-08 真正修好后（10:52 发的 + 已在家）两项冲突都消失 —— 阴性对照',
    fixed.issues.length === 0, JSON.stringify(fixed.issues.map((i) => i.code)));

  check('TL-09 跨天关系未声明只进 advisories，不进 issues（不污染"软判断"层）',
    base.advisories.some((a) => a.code === 'DAY_ROLLOVER_UNDECLARED')
      && !base.issues.some((i) => i.code === 'DAY_ROLLOVER_UNDECLARED'),
    JSON.stringify({ adv: base.advisories.map((a) => a.code), iss: base.issues.map((i) => i.code) }));

  const anchor = T.detectTemporalIssues('正文里没有任何纪年。', { requiredTerms: ['3751'] });
  check('TL-10 设定要求的字面缺失 → ANCHOR_MISSING（hard，可配置）',
    anchor.issues.some((i) => i.code === 'ANCHOR_MISSING' && i.hard === true),
    JSON.stringify(anchor.issues.map((i) => i.code)));
}

// 验收器接入：temporal_consistency 类问题走结构化检查，且硬事实不被语义 pass 覆盖
{
  const finding = {
    id: 'B03', type: 'temporal_consistency', title: '母亲夜班行程矛盾',
    evidence: [{ quote: '母亲这个点刚交完班', role: 'candidate_edit' }],
    acceptance: { rule: '行程自洽' },
  };
  const patch = { issue_ids: ['B03'], span_id: 's1', op: 'replace', original: '刚发的', replacement: '刚发的', start: 0, end: 0 };
  const r = SV.verifyIssue({
    finding, baseText: B03_BASE, revisedText: B03_AFTER, applied: [patch], plan: null,
    coverage: { issue_id: 'B03', status: 'patched' }, invariants: { must_keep: [] },
    semantic: { status: 'pass', reason: '模型自称已修好' },
  });
  check('TL-11 接入验收器：B-03 在模型自称"已修好"时仍 UNRESOLVED，且失败项含 SHIFT_GAP_CONFLICT',
    r.verdict === 'fail' && r.final_status === 'UNRESOLVED'
      && r.checks.some((c) => c.code === 'SHIFT_GAP_CONFLICT' && !c.passed),
    JSON.stringify({ code: r.reason_code, failed: r.checks.filter((c) => !c.passed).map((c) => c.code) }));

  const ok = SV.verifyIssue({
    finding, baseText: B03_FIXED.replace('母亲已经在家了。', '母亲这个点刚交完班。'), revisedText: B03_FIXED,
    applied: [{ ...patch, original: '母亲这个点刚交完班。' }], plan: null,
    coverage: { issue_id: 'B03', status: 'patched' }, invariants: { must_keep: [] },
    semantic: { status: 'pass', reason: '行程与短信都对得上' },
  });
  check('TL-12 接入验收器：真正修好后（阴性对照）可判 ISSUE_VERIFIED',
    ok.final_status === 'ISSUE_VERIFIED', JSON.stringify({ code: ok.reason_code, final: ok.final_status }));
}

// ══════════════════════════════════════════════════════════════════════════
// ② 词条强弱约束
// ══════════════════════════════════════════════════════════════════════════
{
  const entries = [
    { id: 5, title: '等级体系', keywords: 'D 级,普通职业,等级', content: 'D 级 = 普通职业', is_pinned: 1, version: 3, priority: 80 },
    { id: 6, title: '语言风格', keywords: '文风,用词', content: '口语化', version: 1 },
    { id: 7, title: '门派', keywords: '宗门', content: '', version: 1 },
  ];
  check('CS-01 显式 strength 字段优先于任何推断',
    C.classifyEntryStrength({ title: '某词条', strength: 'soft', content: '等级' }).strength === 'soft'
      && C.classifyEntryStrength({ title: '某词条', strength: 'hard', content: '文风' }).strength === 'hard',
    JSON.stringify([C.classifyEntryStrength({ title: 'x', strength: 'soft', content: '等级' }).basis]));
  check('CS-02 作者钉住的词条按硬约束（is_pinned=1）',
    C.classifyEntryStrength({ title: '随便', is_pinned: 1 }).strength === 'hard',
    JSON.stringify(C.classifyEntryStrength({ title: '随便', is_pinned: 1 })));
  check('CS-03 设定类关键词 → hard；风格类 → soft；都没有 → unknown（不猜）',
    C.classifyEntryStrength({ title: '等级体系' }).strength === 'hard'
      && C.classifyEntryStrength({ title: '语言风格' }).strength === 'soft'
      && C.classifyEntryStrength({ title: '某地名', content: '一座山' }).strength === 'unknown',
    JSON.stringify(['等级体系', '语言风格', '某地名'].map((t) => C.classifyEntryStrength({ title: t }).strength)));

  const a03 = { id: 'A03', type: 'canon_conflict', title: 'D 级评价与词条冲突', evidence: [{ quote: '普通作业类' }] };
  const canon = C.resolveCanon([a03], entries);
  check('CS-04 命中的硬约束 + canon_conflict → 进 conflictIds（交作者裁决）',
    canon.conflictIds.includes('A03')
      && canon.strengthByIssue.A03.strength === 'hard'
      && canon.strengthByIssue.A03.entry_id === 5,
    JSON.stringify(canon.strengthByIssue.A03));
  check('CS-05 带空格的关键词（"D 级"）也能匹配（曾因按空格切词而整条失配）',
    C.matchEntry(a03, entries) !== null && C.matchEntry(a03, entries).needle === 'D 级',
    JSON.stringify(C.matchEntry(a03, entries) && C.matchEntry(a03, entries).needle));

  const soft = C.resolveCanon([{ id: 'X1', type: 'canon_conflict', title: '文风不一致', evidence: [] }], entries);
  check('CS-06 弱约束**不进** conflictIds（只作建议，不逼作者裁决）',
    soft.conflictIds.length === 0 && soft.strengthByIssue.X1.strength === 'soft',
    JSON.stringify(soft.strengthByIssue.X1));
  const none = C.resolveCanon([{ id: 'X2', type: 'canon_conflict', title: '完全无关的问题', evidence: [] }], entries);
  check('CS-07 匹配不到权威词条 → unmatched（调用方按 NEED_CONTEXT 处理，不擅自判冲突）',
    none.conflictIds.length === 0 && none.unmatched.includes('X2'),
    JSON.stringify(none.unmatched));
  check('CS-08 单字标题不参与匹配（避免到处误命中）',
    C.matchEntry({ id: 'Y', title: '门', evidence: [] }, entries) === null,
    JSON.stringify(C.matchEntry({ id: 'Y', title: '门', evidence: [] })));

  const vers = C.resolveEntryVersions([{ ...a03, entry_version: 2 }], entries);
  check('CS-09 词条版本归因：引用版本 ≠ 当前版本时报告引用/当前两个版本号',
    vers.A03 && vers.A03.referenced_version === 2 && vers.A03.current_version === 3,
    JSON.stringify(vers.A03));

  const staleVerdict = SV.verifyIssue({
    finding: { ...a03, evidence: [{ quote: '普通作业类', role: 'candidate_edit' }] },
    baseText: 'D 级评价：普通作业类。', revisedText: 'D 级评价：普通职业。',
    applied: [{ issue_ids: ['A03'], span_id: 's', op: 'replace', original: '普通作业类', replacement: '普通职业', start: 6, end: 11 }],
    plan: null, coverage: { issue_id: 'A03', status: 'patched' }, invariants: { must_keep: [] },
    entryVersions: { A03: { entry_id: 5, referenced_version: 2, current_version: 3 } },
  });
  check('CS-10 验收器接入：引用旧版词条 → 不解为"通过"（ENTRY_VERSION_STALE 在失败项里）',
    staleVerdict.final_status !== 'ISSUE_VERIFIED'
      && staleVerdict.checks.some((c) => c.code === 'ENTRY_VERSION_STALE' && !c.passed),
    JSON.stringify({ final: staleVerdict.final_status, codes: staleVerdict.checks.filter((c) => !c.passed).map((c) => c.code) }));
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 运行记录可恢复（Q-15）
// ══════════════════════════════════════════════════════════════════════════
{
  const mem = (() => {
    const m = new Map();
    return {
      setItem: (k, v) => m.set(k, String(v)),
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      removeItem: (k) => m.delete(k),
      size: () => m.size,
    };
  })();
  const hashOf = (t) => `h:${t.length}`;
  const rec = S.serialize({
    runId: 'run:abc', workId: 1, chapterId: 41, reviewId: 9,
    baseHash: hashOf('底稿正文'), candidateText: '候选正文',
    patches: [{ issue_ids: ['B01'], span_id: 's1', op: 'replace', original: 'a', replacement: 'b', start: 0, end: 1 }],
    semanticByIssue: { B01: { status: 'pass', reason: '逐条通过' } },
    semanticRuns: 1, status: 'VERIFIED_CANDIDATE',
    rows: [{ issue_id: 'B01', final_status: 'ISSUE_VERIFIED', reason_code: 'ISSUE_VERIFIED' }],
    at: '2026-10-18T10:00:00.000Z',
  });
  const saved = S.save(mem, rec);
  check('RS-01 保存：写入记录 + 轻量索引（索引供渲染时判断"有没有可恢复的运行"）',
    saved.ok === true && S.load(mem, 1, 41) !== null && S.loadIndex(mem, 1, 41) !== null,
    JSON.stringify({ saved, idx: S.loadIndex(mem, 1, 41) }));
  check('RS-02 索引与记录分开：索引里不含候选正文（渲染不用解析几百 KB）',
    !JSON.stringify(S.loadIndex(mem, 1, 41)).includes('候选正文'),
    JSON.stringify(S.loadIndex(mem, 1, 41)));

  const same = S.restore(S.load(mem, 1, 41), { currentText: '底稿正文', hashOf });
  check('RS-03 底稿未变 → 恢复候选与逐条语义结论',
    same.ok === true && same.candidate === '候选正文' && same.semanticByIssue.B01.status === 'pass',
    JSON.stringify({ ok: same.ok, candidate: same.candidate }));
  check('RS-04 已用掉的付费复验额度一起恢复（刷新不等于再送一次复验）',
    same.semanticRuns === 1, String(same.semanticRuns));

  const stale = S.restore(S.load(mem, 1, 41), { currentText: '底稿被作者改过', hashOf });
  check('RS-05 底稿变了 → BASE_STALE，且**不返回候选**（不复活旧候选与旧授权）',
    stale.ok === false && stale.stale === true && stale.reason === 'BASE_STALE' && stale.candidate === undefined,
    JSON.stringify(stale));

  const noHash = S.restore(S.load(mem, 1, 41), { currentText: '底稿正文' });
  check('RS-06 没有哈希函数时拒绝恢复（不"尽力而为"地信任存档）',
    noHash.ok === false && noHash.reason === 'NO_HASH_FN', JSON.stringify(noHash));

  const big = S.serialize({ runId: 'r2', workId: 1, chapterId: 42, baseHash: 'h', candidateText: 'x'.repeat(S.MAX_CHARS + 10), rows: [], at: 't' });
  const bigSaved = S.save(mem, big);
  check('RS-07 超过本地上限 → 不落盘并说明原因（宁可不持久化，也不让浏览器配额异常）',
    bigSaved.ok === false && bigSaved.reason === 'TOO_LARGE' && S.load(mem, 1, 42) === null,
    JSON.stringify(bigSaved));

  const cleared = S.clear(mem, 1, 41);
  check('RS-08 清除同时删记录与索引（不留"有运行"的幽灵入口）',
    cleared === true && S.load(mem, 1, 41) === null && S.loadIndex(mem, 1, 41) === null,
    JSON.stringify({ cleared }));

  check('RS-09 没有记录时恢复返回 NO_RECORD（不是空成功）',
    S.restore(null).reason === 'NO_RECORD', JSON.stringify(S.restore(null)));
}

finish('test-1026 时间线 / 词条强弱 / 运行记录恢复');
