/**
 * tests/narrative-repair/05-revision-plan.test.mjs —— E05：受约束的局部编辑计划（离线、零计费）。
 *
 * 覆盖任务书 §6.3 与 §7 E05 的通过条件：
 *   · 热点 / 授权跨度 / 只读上下文 / 信息保留清单 / 依赖组都在计划里；
 *   · **非授权跨度不变**（定位到片段就只授权那一刻文字，不是整段）；
 *   · **不自动扩大**：预算不够返回 `needs_explicit_widening`（含候选范围），跨度一个都没放宽；
 *   · 定位不到的问题如实进 `needs_scope`（不猜、不替作者指原文）；
 *   · 作者改勾选 → 旧计划与旧候选作废（计划级 hash + `isPlanStale`）；
 *   · 计划是**干跑**：`dry_run`、不写盘；只支持 replace / delete / condense。
 */
import { createChecks, loadPublicModules, loadFixtures } from './harness.mjs';

const { check, finish } = createChecks();
const { RP } = await loadPublicModules();
await import(new URL('../../public/revision-plan.js', import.meta.url).href);
const PL = globalThis.NovelRevisionPlan;
check('E05-0', '计划模块随 revision-patch 之后加载（跨度口径复用同一实现）',
  !!PL && typeof PL.buildRevisionPlan === 'function' && PL.VERSION === '1.0.0'
  && typeof RP.buildSpans === 'function', PL ? PL.VERSION : 'missing');

const { before, after } = loadFixtures();
const body = [
  '王磊把面包递给岳宸炎，一个字没说。岳宸炎把面包塞进书包。',
  '然后她不一样了。',
  '他把排号纸翻了个面，数了数前头还剩几个人。',
  '雪落在海澜市的中心广场上。落在写字楼的玻璃幕墙上。落在停着的公交车顶。',
].join('\n\n');
const snap = RP.snapshotOf(body, { chapter_id: 7 });

// ── 授权范围：只授权被点名的文字 ───────────────────────────────────────────
{
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [
      { id: 'N05', text: '「然后她不一样了。」是重复预告，建议整段删除', suggested_action: 'delete' },
      { id: 'N04', text: '把「他把排号纸翻了个面，数了数前头还剩几个人。」改成只写注意力变化', suggested_action: 'replace' },
      { id: 'R11', text: '后半段读起来有点AI感，需要整体优化一下', suggested_action: 'replace' },
    ],
    invariants: { must_keep: ['一千多公里'], do_not_add: ['少女姓名'] },
    contextChars: 800,
  });
  const n05 = plan.hotspots.find((h) => h.issue_id === 'N05');
  check('E05-a', '定位到引号片段时，授权跨度**等于那一刻文字**（不是整段/整句）',
    !!n05 && n05.original === '然后她不一样了。' && n05.op === 'delete'
    && body.slice(n05.span.start, n05.span.end) === n05.original,
    JSON.stringify(n05 && { op: n05.op, original: n05.original, span: n05.span }));
  check('E05-b', '计划带只读上下文 / 保留清单 / 禁止新增 / 依赖组',
    !!n05 && typeof n05.read_only.before === 'string' && n05.must_keep.includes('一千多公里')
    && n05.do_not_add.includes('少女姓名') && /^hotspot-/.test(n05.group_id)
    && plan.groups.every((g) => g.atomic === true && /原子应用/.test(g.note || '')),
    JSON.stringify(plan.groups));
  check('E05-c', '定位不到的问题进 needs_scope（如实举手，不猜原文、不替作者指）',
    plan.unlocated_hotspots.length === 1 && plan.unlocated_hotspots[0].issue_id === 'R11'
    && plan.coverage.find((c) => c.issue_id === 'R11').status === 'needs_scope'
    && /不自动放宽/.test(plan.coverage.find((c) => c.issue_id === 'R11').reason),
    JSON.stringify(plan.coverage.map((c) => `${c.issue_id}:${c.status}`)));
  check('E05-d', '每个已选问题都有处置（planned / needs_scope / refused），没有静默丢弃',
    plan.coverage.length === 3 && plan.coverage.every((c) => ['planned', 'needs_scope', 'refused'].includes(c.status))
    && PL.planCoverageTable(plan).length === 3);
  check('E05-e', '计划是干跑：不写盘、只支持 replace/delete/condense',
    plan.dry_run === true && plan.writes_to_disk === false
    && JSON.stringify(PL.PLAN_OPS) === JSON.stringify(['replace', 'delete', 'condense'])
    && plan.hotspots.every((h) => PL.PLAN_OPS.includes(h.op)));
}

// ── 附录示范补丁能进入测试候选，但不写真实稿 ────────────────────────────────
{
  const cases = [
    { name: '例A 整段删除（N05）', action: 'delete', quote: '然后她不一样了。' },
    { name: '例B 去掉重复解释但保留事实（N04）', action: 'replace', quote: '这道光柱和他没关系，这场雪和他也没关系。' },
    { name: '例C 合并排比、不删落点（N03）', action: 'condense', quote: '雪落在海澜市的中心广场上。落在写字楼的玻璃幕墙上。落在停着的公交车顶。' },
    { name: '例D 只修物件用词（L01）', action: 'replace', quote: '把耳机线往耳朵里塞了一半' },
  ];
  const planning = ['然后她不一样了。', '他不认识画面里那个女生。她跟他隔着一千多公里，', '这道光柱和他没关系，这场雪和他也没关系。', '可他一直看着，看那道白线漫过海澜市郊的几栋教学楼、一个操场，再漫过去。',
    '雪落在海澜市的中心广场上。落在写字楼的玻璃幕墙上。落在停着的公交车顶。落在通往港口的立交桥上。', '半座城市。', '下午一点多，大厅里的人少了三成。', '“不是，”王磊把耳机线往耳朵里塞了一半，没塞好，“我是说，你紧张不紧张？”'].join('\n\n');
  const snap2 = RP.snapshotOf(planning, { chapter_id: 8 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap2,
    // 「允许对已选问题局部压缩」开关（E06）打开时才可能出现 condense；host 再对连续跨度做批准。
    allowCondense: true,
    findings: cases.map((c, i) => ({ id: `demo-${i + 1}`, text: `请处理「${c.quote}」`, suggested_action: c.action, merged_span_approved: true })),
    contextChars: 0,
  });
  check('E05-f（通过条件）附录四个示范补丁都能进入计划候选，且计划不写真实稿',
    plan.hotspots.length === 4 && plan.dry_run === true && plan.writes_to_disk === false
    && plan.hotspots.every((h) => planning.includes(h.original) || h.original.startsWith('雪落在')),
    JSON.stringify(plan.hotspots.map((h) => `${h.issue_id}:${h.original.slice(0, 12)}`)));
  const condenseHotspot = plan.hotspots.find((h) => h.op === 'condense');
  check('E05-g', 'condense 只作用在已批准的连续跨度上（开关打开 + host 批准才放行）',
    !!condenseHotspot && condenseHotspot.original.startsWith('雪落在')
    && plan.coverage.filter((c) => c.status === 'refused').length === 0);
  const refused = PL.buildRevisionPlan({
    snapshot: snap2,
    findings: [{ id: 'x', text: '请压缩「雪落在海澜市的中心广场上。落在写字楼的玻璃幕墙上。」', suggested_action: 'condense' }],
  });
  check('E05-g2', '「允许局部压缩」开关未打开 → refused（不静默降级成 replace）',
    refused.hotspots.length === 0 && refused.coverage[0].status === 'refused'
    && /允许对已选问题局部压缩/.test(refused.coverage[0].reason),
    JSON.stringify(refused.coverage));
  const noApprove = PL.buildRevisionPlan({
    snapshot: snap2,
    allowCondense: true,
    findings: [{ id: 'y', text: '请压缩「雪落在海澜市的中心广场上。落在写字楼的玻璃幕墙上。」', suggested_action: 'condense' }],
  });
  check('E05-g3', '开关打开但 host 未批准连续跨度 → 仍然 refused（两道门都要过）',
    noApprove.hotspots.length === 0 && noApprove.coverage[0].status === 'refused'
    && /merged_span_approved/.test(noApprove.coverage[0].reason),
    JSON.stringify(noApprove.coverage));
  check('E05-h', '计划不碰真实作品数据（模块内无写盘路径：dry_run 恒真）',
    PL.buildRevisionPlan({ snapshot: snap, findings: [] }).dry_run === true);
}

// ── 依赖组 / 预算 / 勾选变更 ────────────────────────────────────────────────
{
  const two = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [
      { id: '1', text: '「王磊把面包递给岳宸炎，一个字没说。」这句要收紧', suggested_action: 'replace' },
      { id: '2', text: '「岳宸炎把面包塞进书包。」与前一句功能重复', suggested_action: 'replace' },
    ],
    contextChars: 5000,
  });
  check('E05-i', '同一段内、需要共同上下文的热点合并为一个组（原子 + 共享上下文）',
    two.groups.length === 1 && two.groups[0].issue_ids.join(',') === '1,2'
    && two.groups[0].shared_context === true && two.hotspots.every((h) => h.group_id === two.groups[0].group_id),
    JSON.stringify(two.groups));
  check('E05-i2', '合并成组**不改变**任何一处的授权跨度（跨度仍是各自那一刻文字）',
    two.hotspots.length === 2 && two.hotspots.every((h) => body.slice(h.span.start, h.span.end) === h.original),
    JSON.stringify(two.hotspots.map((h) => h.original)));

  const tight = PL.buildRevisionPlan({
    snapshot: RP.snapshotOf(after, { chapter_id: 9 }),
    findings: [
      { id: '1', text: '「他不认识画面里那个女生。」这句要压缩', suggested_action: 'replace' },
      { id: '2', text: '「这道光柱和他没关系，这场雪和他也没关系。」重复', suggested_action: 'replace' },
    ],
    contextChars: 20,
  });
  check('E05-j', '预算不够 → 返回 needs_explicit_widening（含候选范围），跨度一个都没放宽',
    !!tight.needs_explicit_widening && tight.needs_explicit_widening.needed_chars > 20
    && tight.needs_explicit_widening.candidate_ranges.length >= 1
    && /不能自动扩大|显式扩大授权/.test(tight.needs_explicit_widening.reason)
    && tight.hotspots.every((h) => after.slice(h.span.start, h.span.end) === h.original),
    JSON.stringify(tight.needs_explicit_widening && { needed: tight.needs_explicit_widening.needed_chars, ranges: tight.needs_explicit_widening.candidate_ranges.length }));

  const stale = PL.isPlanStale(two, { selectionHash: 'changed-selection' });
  const fresh = PL.isPlanStale(two, { selectionHash: two.selection_hash, snapshotId: two.snapshot_id });
  check('E05-k', '作者改勾选 → 旧计划与由它产出的候选一律作废；同勾选同快照则仍有效',
    stale.stale === true && /勾选集合变化/.test(stale.reason) && fresh.stale === false);
  const changed = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: '1', text: '「王磊把面包递给岳宸炎，一个字没说。」这句要收紧', suggested_action: 'replace' }],
  });
  check('E05-k2', '取消一个问题后，新计划的 selection_hash / plan_hash 都变了（缓存不复用）',
    changed.selection_hash !== two.selection_hash && changed.plan_hash !== two.plan_hash
    && PL.isPlanStale(two, { selectionHash: changed.selection_hash }).stale === true);
}

// ── 提示词：只带已选问题与不变量，没有"通读全部再优化"的暗示 ────────────────
{
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'N05', text: '「然后她不一样了。」重复预告', suggested_action: 'delete' }],
    invariants: { must_keep: ['一千多公里'], do_not_add: ['少女姓名'] },
  });
  const prompt = PL.buildRevisionPatchPromptFromPlan(plan);
  check('E05-l', '计划提示词只列授权跨度 + 只读上下文 + 不变量（不含"通读/顺便优化"暗示）',
    prompt.includes('只有下面这些跨度允许改') && prompt.includes('然后她不一样了。')
    && prompt.includes('必须保留：一千多公里') && prompt.includes('禁止新增：少女姓名')
    && prompt.includes('依赖组') && !/通读|顺便|整体优化/.test(prompt),
    prompt.split('\n').slice(0, 3).join(' ｜ '));
  check('E05-m', '没有可定位热点时提示词如实说明"不要改动任何文字"',
    PL.buildRevisionPatchPromptFromPlan(PL.buildRevisionPlan({ snapshot: snap, findings: [{ id: 'x', text: '不太好' }] }))
      .includes('不要改动任何文字'));

  // before.txt 也要能跑（回归材料两侧都覆盖）
  const planBefore = PL.buildRevisionPlan({
    snapshot: RP.snapshotOf(before, { chapter_id: 10 }),
    findings: [{ id: '1', text: '「岳宸炎把排号纸翻了个面。纸背面是空白的」这一段重复纸面细节', suggested_action: 'replace' }],
  });
  check('E05-n', '另一版样本同样能定位到片段级跨度（判据不依赖某一版写法）',
    planBefore.hotspots.length === 1 && before.includes(planBefore.hotspots[0].original)
    && planBefore.hotspots[0].original.length < 40,
    JSON.stringify(planBefore.hotspots.map((h) => h.original.slice(0, 20))));
}

finish('05-revision-plan');
