/**
 * tests/narrative-repair/15-reason-binding.test.mjs
 * 《0731 号觉醒日：审稿—局部修稿闭环增补方案》§2 P0-A 末条 + §5 **T33** 的回归断言。
 *
 * T33 原文：`#6 号码纸修改的 reason 写成 #9 深海母神` → 预期 `reason_unverified` 或
 * `explanation_mismatch`，**不得展示为可信理由**。
 *
 * 为什么此前不做、现在做了：实现它必须给补丁协议 v2 的 patch 载荷加 `reason` 字段（契约变更），
 * 用户最初裁决"不碰 schema"；2026-10-13 用户给出标准授权（可自动授权/确认/选推荐），
 * 该项经 confirmation_resolution 裁定为 MODIFY 后落地。
 *
 * 判据边界（刻意收窄，避免误报）：
 *   · 只认**带编号标记**的引用（`#6`、`问题6`）；理由里的裸数字（"改了 2 处""第 3 句"）
 *     一律不算引用 —— 否则正常理由会被判成错配，而这条判据的代价是作者丧失对理由的信任。
 *   · 只做**可判定的那一半**：不做语义相似度。理由用了不同措辞不算错配。
 *   · 理由错配 ≠ 改错地方：补丁照常按跨度与 ops 校验应用，只是理由被标为不可核验。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();

const BODY = '他把号码纸攥成一团，再塞回兜里。\n\n陈牧野没说话。';
const SNAP = RP.snapshotOf(BODY, { chapter_id: 61 });
const SPAN = RP.buildSpans(BODY, { sentences: true }).find((s) => s.text.includes('号码纸'));
const AUTH = {
  authorized: {
    '6': [{ span_id: SPAN.span_id, start: SPAN.start, end: SPAN.end, text: SPAN.text, ops: ['replace'] }],
  },
};
const REVISED = '他把号码纸攥成一团，塞回兜里。';

/**
 * @param {string} dispositionReason 处置自述理由（R06 的实际载体）
 * @param {string|undefined} patchReason 补丁自述理由（本次新增字段）
 */
const payload = (dispositionReason, patchReason) => ({
  schema_version: 2,
  snapshot_id: SNAP.snapshot_id,
  base_hash: SNAP.body_hash,
  patches: [{
    patch_id: 'p1',
    group_id: 'p1',
    issue_ids: ['6'],
    span_id: SPAN.span_id,
    op: 'replace',
    original: SPAN.text,
    replacement: REVISED,
    ...(patchReason === undefined ? {} : { reason: patchReason }),
  }],
  dispositions: [{ issue_id: '6', status: 'patched', reason: dispositionReason }],
});

const run = (dispositionReason, patchReason) => RP.runRevisionPipeline({
  snapshot: SNAP,
  chapterId: 61,
  selectedIssueIds: ['6'],
  engine: K,
  authorization: AUTH,
  raw: JSON.stringify(payload(dispositionReason, patchReason)),
});
const covOf = (r) => (r.coverage || []).find((c) => String(c.issue_id) === '6') || {};

// ── T33 主断言：R06 的实际形态 ────────────────────────────────────────────────
{
  const bad = run('按 #9 深海母神角色卡时点调整', undefined);
  const cov = covOf(bad);
  check('T33a 处置理由引用别的 issue（#9）而处置声明处理 #6 → reason_unverified=true',
    cov.reason_unverified === true, JSON.stringify(cov));
  check('T33b 被引用的外来编号被如实记录（作者能看到"它引用了哪一条"）',
    Array.isArray(cov.foreign_reference) && cov.foreign_reference.includes('9'),
    JSON.stringify(cov.foreign_reference));

  // 关键：理由错配**不等于**改错地方 —— 补丁仍应按授权应用（否则会拦掉正确的修改）。
  check('T33c 理由错配不阻断补丁本身（理由错配 ≠ 越权）',
    bad.ok === true && (bad.applied || []).length === 1 && bad.text !== BODY,
    JSON.stringify({ ok: bad.ok, applied: (bad.applied || []).length }));

  // 阳性对照：理由引用自己的编号时**不得**误报。
  const good = run('按 #6 处理：号码纸动作重复', '按 #6 处理：号码纸动作重复');
  check('T33d 阳性对照：理由引用自己的 #6 → reason_unverified=false（该标记有区分力，不是恒真）',
    covOf(good).reason_unverified === false, JSON.stringify(covOf(good)));
}

// ── 补丁自述理由（本次新增字段）也要被核验 ───────────────────────────────────
{
  const p = run('动作重复，收束为一次', '这条其实在处理 #9 的角色卡时点');
  check('T33e 补丁自带理由引用外来编号 → 同样标记为不可核验（新增字段不是免责通道）',
    covOf(p).reason_unverified === true, JSON.stringify(covOf(p)));
  check('T33f 光有处置理由不足以掩盖补丁理由的错配（两个来源都查）',
    p.ok === true && (p.applied || []).length === 1 && covOf(p).reason_unverified === true,
    JSON.stringify({ ok: p.ok, cov: covOf(p) }));
}

// ── 阴性对照：措辞不同 / 裸数字 / 无理由 ─────────────────────────────────────
{
  const wording = run('动作重复，收束为一次', undefined);
  check('T33g 阴性对照：理由只描述正文、不引用任何编号 → 不报（不做语义相似度判断）',
    covOf(wording).reason_unverified === false, JSON.stringify(covOf(wording)));

  const bare = run('改了 2 处，第 3 句收束', undefined);
  check('T33h 阴性对照：理由里的裸数字（2 处 / 第 3 句）不算编号引用，不得误报',
    covOf(bare).reason_unverified === false, JSON.stringify(covOf(bare)));

  const cnStyle = run('问题9 的时点问题', undefined);
  check('T33i `问题N` 的中文写法同样被识别（不只认 `#N`）',
    covOf(cnStyle).reason_unverified === true && (covOf(cnStyle).foreign_reference || []).includes('9'),
    JSON.stringify(covOf(cnStyle)));
}

// ── 向后兼容：不带 reason 的旧载荷行为不变 ───────────────────────────────────
{
  const legacyPayload = JSON.stringify({
    schema_version: 2,
    snapshot_id: SNAP.snapshot_id,
    base_hash: SNAP.body_hash,
    patches: [{
      patch_id: 'p1', group_id: 'p1', issue_ids: ['6'], span_id: SPAN.span_id,
      op: 'replace', original: SPAN.text, replacement: REVISED,
    }],
    dispositions: [{ issue_id: '6', status: 'patched' }],
  });
  const r = RP.runRevisionPipeline({
    snapshot: SNAP, chapterId: 61, selectedIssueIds: ['6'], engine: K, authorization: AUTH, raw: legacyPayload,
  });
  check('T33j 兼容性：旧载荷（无 reason 字段）照常应用且 reason_unverified=false',
    r.ok === true && (r.applied || []).length === 1 && covOf(r).reason_unverified === false,
    JSON.stringify({ ok: r.ok, cov: covOf(r) }));
}

finish('15-reason-binding');
