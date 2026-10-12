/**
 * tests/narrative-repair/09-information-truncation.test.mjs —— E03：解决"删得掉，但删错信息"。
 *
 * 本轮的事故样例是 A01：
 *   `屏幕下方滚过一行小字：职业方向——材料修复、灵植培育、检测辅助。`
 *   → `屏幕下方滚过一行小字：职业方向。`
 * 这不是 PatchV2 的格式错，而是**局部句意不完整**：删完只剩一个孤立的栏目名。
 *
 * 覆盖《修复.md》§7 E03 与 §10 的 F-A01 / F-A02：
 *   · A01 必须在修后核验里**可见**（信息残缺 + 具体丢了什么），且不得被写成质量改善；
 *   · A02（删重复的耳机动作）必须能作为**合理局部精简**通过，不误删等待时长/出场/登记表；
 *   · 阴性对照：对白句、句内压缩、整句删除都不许误报（不做"所有短句都判错"的扫描器）。
 * 零依赖、零计费。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecks, loadPublicModules, REPO_ROOT } from './harness.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();
await import(new URL('../../public/revision-plan.js', import.meta.url).href);
const PL = globalThis.NovelRevisionPlan;

const FIX_DIR = path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'new-3751-spring');
const loadFixture = (file) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, file), 'utf8'));
const a01 = loadFixture('F-A01-information-truncation.json');
const a02 = loadFixture('F-A02-positive-compression.json');

check('E03-0 新样本夹具可读，且不是把旧专项冻结样本改名冒充',
  a01.id === 'F-A01' && a02.id === 'F-A02'
  && fs.existsSync(path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'before.txt'))
  && fs.existsSync(path.join(FIX_DIR, 'manifest.json')),
  `${a01.id}/${a02.id}`);

check('E03-0b 判据落在修后核验层（安全门禁模块）而不是另建一套扫描器',
  typeof K.informationTruncationRisks === 'function'
  && typeof K.deletionRisks === 'function'
  && !K.HARD_CODES.includes('information_truncation'),
  `hard=${K.HARD_CODES.includes('information_truncation')}`);

// ── F-A01：保留句意完整性（负向修稿）──────────────────────────────────────
{
  const body = a01.body;
  const snap = RP.snapshotOf(body, { chapter_id: 201 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: a01.finding.id, text: a01.finding.text, quote: a01.finding.quote }],
  });
  const h = plan.hotspots[0];
  const authorization = PL.planAuthorization(plan);
  const run = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 201, selectedIssueIds: [a01.finding.id], engine: K, authorization,
    raw: JSON.stringify({
      schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
      patches: [{
        patch_id: 'p1', group_id: 'p1', issue_ids: [a01.finding.id], span_id: h.span.span_id,
        op: a01.patch.op, original: h.original, replacement: a01.patch.replacement,
      }],
      dispositions: [{ issue_id: a01.finding.id, status: 'patched', reason: '压掉重复列举' }],
    }),
  });
  const trunc = (run.combined && run.combined.findings || []).filter((f) => f.code === 'information_truncation');
  check('E03-1（F-A01）删掉列举后只剩孤立栏目名 → 修后核验给出 information_truncation',
    run.ok === true && run.applied.length === 1 && trunc.length === 1,
    JSON.stringify({ ok: run.ok, applied: run.applied.length, codes: (run.combined && run.combined.findings || []).map((f) => f.code) }));
  check('E03-1b 提醒里点名**具体丢了什么**（不是只报一个码）',
    trunc.length === 1 && String(trunc[0].lost).includes('材料修复') && trunc[0].label === '职业方向'
    && /职业方向/.test(String(trunc[0].reason)),
    JSON.stringify(trunc[0] || {}));
  check('E03-1c 这是**提醒**而不是硬拦：改动仍然进候选，由作者裁决（不强制回滚正式稿）',
    run.verified === true && run.safety_blocked !== true && trunc.every((f) => f.code !== 'story_fact'),
    JSON.stringify({ verified: run.verified, blocked: run.safety_blocked }));
  check('E03-1d 改后的正文确实是夹具记录的观察形态（不是"看起来差不多"）',
    run.text === body.replace(a01.finding.quote, a01.patch.replacement),
    JSON.stringify(run.text.slice(0, 40)));
  check('E03-1e 计划模块把该引用登记成**片段级**授权跨度（授权范围没有放大到整段）',
    !!h && h.original === a01.finding.quote
    && h.span.end - h.span.start === a01.finding.quote.length,
    JSON.stringify(h && h.original));
}

// ── F-A02：允许合理的动作减量（正向修稿）──────────────────────────────────
{
  const body = a02.body;
  const snap = RP.snapshotOf(body, { chapter_id: 202 });
  const plan = PL.buildRevisionPlan({ snapshot: snap, findings: [{ id: a02.finding.id, text: a02.finding.text, quote: a02.finding.quote }] });
  const h = plan.hotspots[0];
  const authorization = PL.planAuthorization(plan);
  const run = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 202, selectedIssueIds: [a02.finding.id], engine: K, authorization,
    raw: JSON.stringify({
      schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
      patches: [{
        patch_id: 'p1', group_id: 'p1', issue_ids: [a02.finding.id], span_id: h.span.span_id,
        op: 'delete', original: h.original, replacement: '',
      }],
      dispositions: [{ issue_id: a02.finding.id, status: 'patched', reason: '耳机状态后文还会出现' }],
    }),
  });
  const codes = (run.combined && run.combined.findings || []).map((f) => f.code);
  check('E03-2（F-A02）删重复的耳机动作 → 作为合理局部精简通过（不报信息残缺、不被硬拦）',
    run.ok === true && run.applied.length === 1 && !codes.includes('information_truncation') && run.safety_blocked !== true,
    JSON.stringify({ ok: run.ok, codes }));
  const keptAll = a02.expected.kept.every((s) => run.text.includes(s));
  check('E03-2b 精简不丢等待时长 / 出场方式 / 登记表（逐字仍在）', keptAll && !run.text.includes('耳机挂'),
    JSON.stringify({ kept: keptAll, text: run.text }));
}

// ── 阴性对照：不许误报 ────────────────────────────────────────────────────
{
  const neg = [
    ['对白句未改动', '他说：“今天别出门。”', '他说：“今天别出门。”'],
    ['对白句内压缩（内容仍在）', '他说：“今天别出门，外头冷。”', '他说：“今天别出门。”'],
    ['整句删除（引导语也一起没了）', '屏幕下方滚过一行小字：职业方向——材料修复、灵植培育、检测辅助。', '岳宸炎盯着那行字看了两秒。'],
    ['正常换词（列举内容仍在，只是换了写法）', '名单上写着：编号——A3。', '名单上写着编号 A3。'],
  ];
  const fired = neg.filter(([, b, a]) => K.informationTruncationRisks(b, a).length > 0).map(([label]) => label);
  check('E03-3 阴性对照：对白、句内压缩、整句删除、未改动都不误报（只报"孤立栏目名"这一形态）',
    fired.length === 0, fired.join(' | '));
  const comp = K.informationTruncationRisks('能力：念力、控物。他闭上眼。', '能力。他闭上眼。');
  check('E03-3b 同类形态（"能力："）同样被抓到 —— 判据不是为 A01 一条句子写死的',
    comp.length === 1 && comp[0].code === 'information_truncation' && String(comp[0].lost).includes('念力'),
    JSON.stringify(comp[0] || {}));
}

finish('09-information-truncation');
