/**
 * tests/narrative-repair/16-op-authorization.test.mjs
 * 《0731 号觉醒日：审稿—局部修稿闭环增补方案》§2 **P0-B 双重授权**的回归断言 + R07 的零宽 insert。
 *
 * 为什么单独一套：08-authorization 管的是"**跨度**有没有被授权"，本套件管的是"**这种改法**
 * 有没有被授权"。两者失败时的排查方向不同——一个是改错了地方，一个是改法越权。
 *
 * 补上的是哪一重授权：授权条目**一直**带 `ops` 字段（08 号套件就在传 `ops:['replace','delete']`），
 * 但引擎从未读过它 → "我批了这个跨度"被悄悄放大成"这个跨度上想怎么改都行"。
 * 现在 `replace/delete/insert` 逐条对照授权声明。
 *
 * ⚠️ 兼容性边界（刻意的）：**缺 `ops` 字段的历史条目保持放行**。
 *    08 号套件里有一批 `{span_id,start,end,text}` 不带 ops 的写法，新约束只能收紧
 *    显式声明过的授权，不能把老条目一并判死（否则等于用新判据追溯否决旧授权）。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();

const BODY = '他把号码纸攥成一团。\n\n陈牧野没说话。';
const SNAP = RP.snapshotOf(BODY, { chapter_id: 70 });
const SPAN = RP.buildSpans(BODY, { sentences: true }).find((s) => s.text.includes('号码纸'));

/**
 * @param {string} op replace / delete / insert
 * @param {string[]|undefined} ops 授权条目声明的操作（undefined = 历史条目，不声明）
 */
const run = (op, original, replacement, ops) => {
  const entry = {
    span_id: SPAN.span_id, start: SPAN.start, end: SPAN.end, text: SPAN.text,
    ...(ops === undefined ? {} : { ops }),
  };
  const authorization = { authorized: { q1: [entry] } };
  const raw = JSON.stringify({
    schema_version: 2,
    snapshot_id: SNAP.snapshot_id,
    base_hash: SNAP.body_hash,
    patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: ['q1'], span_id: SPAN.span_id, op, original, replacement }],
    dispositions: [{ issue_id: 'q1', status: 'patched', reason: '按 q1 处理' }],
  });
  return RP.runRevisionPipeline({
    snapshot: SNAP, chapterId: 70, selectedIssueIds: ['q1'], engine: K, authorization, raw,
  });
};
const codeOf = (r) => r.error_code || (r.errors || [])[0]?.code || (r.blocked || [])[0]?.code;

// ── ① 第三重授权：op 必须在该跨度的授权操作内 ─────────────────────────────────
{
  const del = run('delete', SPAN.text, '', ['replace']);
  check('P0B-a delete 落到只授权 replace 的跨度 → op_not_authorized（不是 out_of_scope，要能区分哪一重没过）',
    codeOf(del) === 'op_not_authorized', JSON.stringify({ code: codeOf(del) }));
  check('P0B-b 越权操作必须 fail-closed：原文逐字不变',
    del.text === BODY, JSON.stringify({ same: del.text === BODY }));

  const rep = run('replace', SPAN.text, '他攥紧了号码纸。', ['replace', 'delete']);
  check('P0B-c 对照：op 在授权内 → 正常应用（排除"一律拒绝"的假绿）',
    rep.ok === true && rep.applied.length === 1, JSON.stringify({ ok: rep.ok, n: rep.applied.length }));

  const onlyDelete = run('replace', SPAN.text, '他攥紧了号码纸。', ['delete']);
  check('P0B-d 反向对照：只授权 delete 时 replace 同样被拒（判据不偏向某一种操作）',
    codeOf(onlyDelete) === 'op_not_authorized', JSON.stringify({ code: codeOf(onlyDelete) }));

  const legacy = run('replace', SPAN.text, '他攥紧了号码纸。', undefined);
  check('P0B-e 兼容性：历史条目（不声明 ops）保持放行，新判据不追溯否决旧授权',
    legacy.ok === true && legacy.applied.length === 1, JSON.stringify({ ok: legacy.ok, code: codeOf(legacy) }));
}

// ── ② 零宽 insert：R07 的"插入一个主动动作" ───────────────────────────────────
{
  const ok = run('insert', '', '他先松开手。', ['insert']);
  check('P0B-f 显式授权 insert → 零宽插入成功，正文真的多出那一句',
    ok.ok === true && ok.applied.length === 1 && ok.text.includes('他先松开手。'),
    JSON.stringify({ ok: ok.ok, n: ok.applied.length }));

  const plug = run('insert', '', '他先松开手。', ['replace']);
  check('P0B-g 授权条目没写 insert → 拒绝（"哪里都能插"是最危险的放宽）',
    codeOf(plug) === 'op_not_authorized' && plug.text === BODY,
    JSON.stringify({ code: codeOf(plug), same: plug.text === BODY }));

  const noDeclaration = run('insert', '', '他先松开手。', undefined);
  check('P0B-h 条目完全不声明 ops 时 insert 同样被拒（插入必须**显式**授权，不享用历史放行）',
    codeOf(noDeclaration) === 'op_not_authorized' && noDeclaration.text === BODY,
    JSON.stringify({ code: codeOf(noDeclaration) }));

  const disguised = run('insert', SPAN.text, '他先松开手。', ['insert']);
  check('P0B-i insert 带非空 original → 语法拒绝（不许用 insert 顺带替换原文）',
    disguised.text === BODY && (disguised.errors || []).some((e) => e.code === 'insert_requires_empty_original'),
    JSON.stringify((disguised.errors || []).map((e) => e.code)));

  const empty = run('insert', '', '', ['insert']);
  check('P0B-j 空插入内容 → 拒绝（空插入没有意义）',
    (empty.errors || []).some((e) => e.code === 'insert_requires_nonempty_replacement'),
    JSON.stringify((empty.errors || []).map((e) => e.code)));

  // 安全门禁对 insert 同样生效：插入引入本章没有的正式事实时必须被拦，不得因为是 insert 就免检。
  // ⚠️ 样本必须真的触发规则：实测 `他忽然站起身。` 会命中 `new_institution`（安全门禁把"忽然站"
  //    解析成机构名），而 `他加入了青云宗。` 反而**不**触发 —— 第一版就踩了这个坑，
  //    断言于是变成"永远通过"的假绿。这里用实测会触发的那一句。
  const risky = run('insert', '', '他忽然站起身。', ['insert']);
  const blockedCode = (risky.blocked || [])[0]?.code;
  check('P0B-k 安全门禁对 insert 同样生效（引入新正式事实 → 不自动应用），insert 不是免检通道',
    risky.applied.length === 0 && !!blockedCode,
    JSON.stringify({ applied: risky.applied.length, code: blockedCode }));
}

// ── ③ 未声明的 op 值仍然拒绝（白名单不能被 insert 撑开） ──────────────────────
{
  const bogus = run('rewrite', SPAN.text, '他攥紧了号码纸。', ['rewrite']);
  check('P0B-l 白名单依然是白的：未知 op 值被语法层拒绝，不因新增 insert 而放开',
    (bogus.errors || []).some((e) => e.code === 'unknown_op'), JSON.stringify((bogus.errors || []).map((e) => e.code)));
}

// ── ④ 字段命名：方案叫 allowed_ops，既有授权表叫 ops，两者都要认 ──────────────
{
  const runNamed = (op, original, replacement, field, value) => {
    const entry = {
      span_id: SPAN.span_id, start: SPAN.start, end: SPAN.end, text: SPAN.text,
      [field]: value,
    };
    const raw = JSON.stringify({
      schema_version: 2,
      snapshot_id: SNAP.snapshot_id,
      base_hash: SNAP.body_hash,
      patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: ['q1'], span_id: SPAN.span_id, op, original, replacement }],
      dispositions: [{ issue_id: 'q1', status: 'patched', reason: '按 q1 处理' }],
    });
    return RP.runRevisionPipeline({
      snapshot: SNAP, chapterId: 70, selectedIssueIds: ['q1'], engine: K, authorization: { authorized: { q1: [entry] } }, raw,
    });
  };

  const byPlanName = runNamed('delete', SPAN.text, '', 'allowed_ops', ['replace']);
  check('P0B-m `allowed_ops`（方案 §2 P0-B 的字段名）与 `ops` 等效：越权同样被拒',
    codeOf(byPlanName) === 'op_not_authorized', JSON.stringify({ code: codeOf(byPlanName) }));

  const allowedOk = runNamed('replace', SPAN.text, '他攥紧了号码纸。', 'allowed_ops', ['replace']);
  check('P0B-n `allowed_ops` 声明允许的 op → 正常放行（命名不影响判定方向）',
    allowedOk.ok === true && allowedOk.applied.length === 1, JSON.stringify({ ok: allowedOk.ok }));

  // 计划层必须真的把方案契约名发出来，否则"引擎支持它"只是空话。
  await import(new URL('../../public/revision-plan.js', import.meta.url).href);
  const PL = globalThis.NovelRevisionPlan;
  const plan = PL.buildRevisionPlan({
    snapshot: RP.snapshotOf('甲段里有一句话。\n\n乙段。', { chapter_id: 71 }),
    findings: [{ id: 'q1', text: '「甲段里有一句话。」读起来重复，删掉' }],
  });
  const auth = PL.planAuthorization(plan);
  const entry = (auth && auth.authorized && auth.authorized.q1 && auth.authorized.q1[0]) || {};
  check('P0B-o planAuthorization 发出的授权条目同时带 allowed_ops 与 ops（方案契约名 + 向后兼容）',
    Array.isArray(entry.allowed_ops) && Array.isArray(entry.ops)
    && entry.allowed_ops.includes('replace') && entry.ops.includes('replace'),
    JSON.stringify({ allowed_ops: entry.allowed_ops, ops: entry.ops }));
}

finish('16-op-authorization');
