/**
 * tests/narrative-repair/08-authorization.test.mjs —— E01：锁死「选中问题 → 获准跨度 → 实际补丁」。
 *
 * 为什么单独一个套件（而不是塞进 01-patch-protocol）：
 *   01 覆盖的是**协议自身**（解码/跨度/组合/门禁）；本套件覆盖的是**授权**——
 *   "问题被选中"与"这个跨度被授权"是两件事，混在一起测会让后者永远没人测（K2 就是这样漏掉的）。
 *
 * 覆盖《修复.md》§5 与 §10 的夹具：
 *   · F-B01 选中问题 A，补丁却指向未授权句 B → out_of_scope，零文本改动（P0 安全路径）
 *   · F-B02 同一句出现两次 → ambiguous_anchor，绝不默选第一处
 *   · F-B03 问题没有原文引用 / 计划为空 → 不得产生整章可编辑授权（Host 授权表为空）
 *   · F-B04 新任务（expected_schema_version:2）收到 legacy 载荷 → 格式不兼容，不按旧语义应用
 *   · F-B05 授权范围内的显式 delete 真正生效；范围外/受保护一律拒绝
 * 零依赖、零计费；每条断言都对着**实际实现**跑。
 */
import { createChecks, loadPublicModules } from './harness.mjs';

const { check, finish } = createChecks();
const { RP, K } = await loadPublicModules();
await import(new URL('../../public/revision-plan.js', import.meta.url).href);
const PL = globalThis.NovelRevisionPlan;

const V2 = (snapshot, patches, extra = {}) => JSON.stringify({
  schema_version: 2, snapshot_id: snapshot.snapshot_id, base_hash: snapshot.body_hash, patches, ...extra,
});
const P = (span, op, original, replacement, issueIds = ['q1'], patchId = 'p1') => ({
  patch_id: patchId, group_id: patchId, issue_ids: issueIds, span_id: span.span_id, op, original, replacement,
});
const spanOf = (text, s) => RP.buildSpans(text, { sentences: true }).find((x) => x.text === s);
/**
 * 授权表读取：模块还没实现时返回一个"空授权"占位而不是抛错。
 * 为什么：本套件是**先写失败测试再修源码**的产物 —— 崩溃会把后面的断言一起吞掉，
 * 那样报告里只剩一条 TypeError，看不出到底坏了几处。
 */
const authOf = (plan) => (PL && typeof PL.planAuthorization === 'function')
  ? PL.planAuthorization(plan)
  : { authorized: {}, authorized_span_count: -1, scope_complete: null };

check('E01-0', '授权表是 Host 侧产物：计划模块导出 planAuthorization（不是把许可写在提示词里）',
  !!PL && typeof PL.planAuthorization === 'function' && typeof RP.planPatchApplication === 'function',
  PL ? `planAuthorization=${typeof PL.planAuthorization}` : 'missing');

// ── F-B01：选中问题 A，补丁改未授权句 B（安全攻击模拟）────────────────────────
{
  const body = '甲说：“今天别出门。”\n\n乙把围巾放在椅子上。';
  const snap = RP.snapshotOf(body, { chapter_id: 11 });
  const p1 = spanOf(body, '甲说：“今天别出门。”');
  const p2 = spanOf(body, '乙把围巾放在椅子上。');
  // Host 只授权 issue「I-甲」改第一行那一句（确切跨度 + 逐字原文）。
  const authorization = {
    authorized: { 'I-甲': [{ span_id: p1.span_id, start: p1.start, end: p1.end, text: p1.text, ops: ['replace', 'delete'] }] },
  };
  const attack = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 11, selectedIssueIds: ['I-甲'], engine: K, authorization,
    raw: V2(snap, [P(p2, 'replace', '乙把围巾放在椅子上。', '乙走了。', ['I-甲'])], {
      dispositions: [{ issue_id: 'I-甲', status: 'patched', reason: '顺手改一下' }],
    }),
  });
  check('E01-1（F-B01）选中问题 A、补丁改未授权句 B → out_of_scope 且原文逐字不变',
    attack.ok === false && attack.error_code === 'out_of_scope' && attack.text === body,
    JSON.stringify({ code: attack.error_code, changed: attack.text !== body }));
  const legit = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 11, selectedIssueIds: ['I-甲'], engine: K, authorization,
    raw: V2(snap, [P(p1, 'replace', '甲说：“今天别出门。”', '甲说：“今天别乱跑。”', ['I-甲'])], {
      dispositions: [{ issue_id: 'I-甲', status: 'patched', reason: '收紧措辞' }],
    }),
  });
  check('E01-1b 同一 issue 落在授权跨度上 → 正常应用（没有把正常路径一起拦掉）',
    legit.ok === true && legit.applied.length === 1 && legit.text === body.replace('今天别出门。', '今天别乱跑。'),
    JSON.stringify({ ok: legit.ok, text: legit.text }));
  // 模型自造显式 offset 指向未授权位置：offset 只有 Host 事先登记过才算授权。
  const selfMade = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 11, selectedIssueIds: ['I-甲'], engine: K, authorization,
    raw: V2(snap, [{
      patch_id: 'p1', group_id: 'p1', issue_ids: ['I-甲'], op: 'replace',
      original: p2.text, replacement: '乙走了。', span: { start: p2.start, end: p2.end },
    }]),
  });
  check('E01-1c 模型自造 span:{start,end} 不算许可（Host 未登记的 range 一律拒绝）',
    selfMade.ok === false && selfMade.error_code === 'out_of_scope' && selfMade.text === body,
    JSON.stringify({ code: selfMade.error_code, changed: selfMade.text !== body }));
  const protectedHit = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 11, selectedIssueIds: ['I-甲'], engine: K,
    authorization: { ...authorization, protected: [{ start: p1.start, end: p1.end }] },
    raw: V2(snap, [P(p1, 'replace', p1.text, '甲说：“今天别乱跑。”', ['I-甲'])]),
  });
  check('E01-1d 授权表里的 protected 范围不可被同一条 issue 越过',
    protectedHit.ok === false && protectedHit.error_code === 'out_of_scope' && protectedHit.text === body,
    String(protectedHit.error_code));
}

// ── F-B02：重复 anchor → 定位歧义，绝不默选第一处 ───────────────────────────
{
  const body = '他低下头。\n\n过了一阵，他低下头。';
  const snap = RP.snapshotOf(body, { chapter_id: 12 });
  const direct = PL.locateFragment(body, '他低下头。', RP.buildSpans(body, { sentences: true }));
  check('E01-2（F-B02）同一句在正文里出现两次 → locateFragment 报歧义（不是返回第一个）',
    !!direct && direct.ambiguous === true && Number(direct.count) >= 2,
    JSON.stringify(direct));
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    // 没有位置/上下文标识的引用：Host 无法判定作者指的是哪一处。
    findings: [{ id: 'I-低', text: '「他低下头。」这个动作重复了，删掉后面那次' }],
  });
  check('E01-2b 歧义引用进 ambiguous_anchor：不产生热点、不猜第一处',
    plan.hotspots.length === 0
    && plan.coverage[0].status === 'ambiguous_anchor'
    && /歧义|多处|不唯一/.test(plan.coverage[0].reason || ''),
    JSON.stringify(plan.coverage));
  const hostSpan = RP.buildSpans(body, { sentences: true }).find((x) => x.span_id === 'p2');
  const unique = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'I-低', text: '「他低下头。」重复了', span_id: hostSpan.span_id }],
  });
  check('E01-2c Host 给出唯一 span/上下文标识时才允许改（且只授权那一处）',
    unique.hotspots.length === 1 && unique.hotspots[0].span.start === body.indexOf('过了一阵')
    && unique.hotspots[0].span.span_id === hostSpan.span_id,
    JSON.stringify(unique.hotspots.map((h) => h.span)));
}

// ── F-B03：没有可定位原文 → Host 授权表为空（不得放宽成整章）───────────────
{
  const body = '这一章还有很多段落。\n\n中间还有别的东西。\n\n最后也是。';
  const snap = RP.snapshotOf(body, { chapter_id: 13 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'M-1', text: '中间某处写得机械。' }],
    plannedHotspots: [],
  });
  check('E01-3（F-B03）定位不到 → needs_scope 且热点为 0（不自动放宽到整章）',
    plan.hotspots.length === 0 && plan.coverage.length === 1 && plan.coverage[0].status === 'needs_scope',
    JSON.stringify(plan.coverage));
  const auth = authOf(plan);
  check('E01-3b 这个计划产出的授权表为空，且 scope_complete=false（Host 明示"没授权任何跨度"）',
    auth && Object.keys(auth.authorized).length === 0 && auth.authorized_span_count === 0 && auth.scope_complete === false,
    JSON.stringify(auth));
  const empty = authOf(null);
  check('E01-3c 计划缺失（null）同样只能是空授权 —— 不存在"没有计划就等于整章可改"',
    empty && Object.keys(empty.authorized).length === 0 && empty.scope_complete === false,
    JSON.stringify(empty));
  // 空授权表 + 任意补丁 → 一律拒绝（"没有计划"不能悄悄变成"整章自由修改"）
  const attack = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 13, selectedIssueIds: ['M-1'], engine: K, authorization: auth,
    raw: V2(snap, [P(spanOf(body, '最后也是。'), 'delete', '最后也是。', '', ['M-1'])]),
  });
  check('E01-3d 授权表为空时任何补丁都不通过（付费任务不会拿到全章可编辑面）',
    attack.ok === false && attack.error_code === 'out_of_scope' && attack.text === body,
    JSON.stringify({ code: attack.error_code, changed: attack.text !== body }));
  // 多热点里能定位的仍可形成受限计划，未定位的问题必须留下处置
  const mixed = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [
      { id: 'M-1', text: '中间某处写得机械。' },
      { id: 'M-2', text: '把「最后也是。」删掉', suggested_action: 'delete' },
    ],
  });
  const mixedAuth = authOf(mixed);
  check('E01-3e 部分可定位：授权表只含已定位的 issue，未定位的仍留在 coverage 里',
    mixed.hotspots.length === 1 && Object.keys(mixedAuth.authorized).join() === 'M-2'
    && mixed.coverage.find((c) => c.issue_id === 'M-1').status === 'needs_scope'
    && mixedAuth.scope_complete === false,
    JSON.stringify({ auth: Object.keys(mixedAuth.authorized), cov: mixed.coverage.map((c) => `${c.issue_id}:${c.status}`) }));
}

// ── F-B04：新任务不接受 legacy 自动应用 ────────────────────────────────────
{
  const legacy = JSON.stringify({ patches: [{ anchor: '他低下头。', revised: '他低着头。' }] });
  const hist = RP.decodePatchOutput(legacy);
  check('E01-4 历史存量：默认仍可读 legacy（旧报告/旧响应继续可读，不破坏兼容）',
    hist.ok === true && hist.mode === 'legacy' && hist.legacy === true, JSON.stringify({ ok: hist.ok, mode: hist.mode }));
  const strict = RP.decodePatchOutput(legacy, { expectedSchemaVersion: 2 });
  check('E01-4b（F-B04）新任务（expected_schema_version:2）收到 legacy → 格式不兼容',
    strict.ok === false && strict.error_code === 'incompatible_legacy_format'
    && /legacy|v2|schema/i.test(JSON.stringify(strict.errors)),
    JSON.stringify({ ok: strict.ok, code: strict.error_code }));
  const body = '他低下头。\n\n雪还在下。';
  const snap = RP.snapshotOf(body, { chapter_id: 14 });
  const run = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 14, selectedIssueIds: ['q1'], engine: K,
    expectedSchemaVersion: 2, raw: legacy,
  });
  check('E01-4c 新修稿作业收到 legacy 时不执行旧"包含式整段替换"，原文一个字符不动',
    run.ok === false && run.text === body && run.applied.length === 0,
    JSON.stringify({ ok: run.ok, code: run.error_code, changed: run.text !== body }));
  const compat = RP.decodePatchOutput(legacy, { allowLegacy: true });
  check('E01-4d 显式兼容入口（allowLegacy）仍可读存量；expected_schema_version 优先于它',
    compat.ok === true && compat.mode === 'legacy'
    && RP.decodePatchOutput(legacy, { allowLegacy: true, expectedSchemaVersion: 2 }).ok === false,
    JSON.stringify({ ok: compat.ok, mode: compat.mode }));
}

// ── F-B05：授权范围内的显式 delete / 组合核验 / 边界 ──────────────────────
{
  const body = '王磊把面包递给岳宸炎，一个字没说。\n\n然后她不一样了。\n\n岳宸炎把面包塞进书包。';
  const snap = RP.snapshotOf(body, { chapter_id: 15 });
  const target = spanOf(body, '然后她不一样了。');
  const auth = { authorized: { 'N05': [{ span_id: target.span_id, start: target.start, end: target.end, text: target.text }] } };
  const del = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 15, selectedIssueIds: ['N05'], engine: K, authorization: auth,
    raw: V2(snap, [P(target, 'delete', '然后她不一样了。', '', ['N05'])], {
      dispositions: [{ issue_id: 'N05', status: 'patched', reason: '重复预告，整处删除' }],
    }),
  });
  check('E01-5 授权跨度上的显式 delete 真正生效，边界外无字符变动',
    del.ok === true && del.applied.length === 1 && del.applied[0].op === 'delete'
    && del.text === body.replace('然后她不一样了。\n\n', ''),
    JSON.stringify({ ok: del.ok, text: del.text }));
  // 组合核验：两条补丁各自都在自己的授权跨度内，合起来却删光"她"的先行语 →
  // 授权通过 ≠ 组合安全。这里钉住"接入授权表之后组合门禁仍然真的跑"。
  const combBody = '队伍前面那个女生走上台阶。\n\n另一个女生从通道走出来。\n\n她把手按在石板上。';
  const combSnap = RP.snapshotOf(combBody, { chapter_id: 15 });
  const cps = RP.buildSpans(combBody, { sentences: false });
  const combAuth = {
    authorized: {
      x: [{ span_id: cps[0].span_id, start: cps[0].start, end: cps[0].end, text: cps[0].text }],
      y: [{ span_id: cps[1].span_id, start: cps[1].start, end: cps[1].end, text: cps[1].text }],
    },
  };
  const both = RP.runRevisionPipeline({
    snapshot: combSnap, chapterId: 15, selectedIssueIds: ['x', 'y'], engine: K, authorization: combAuth,
    raw: V2(combSnap, [
      { ...P(cps[0], 'replace', cps[0].text, '队伍前面的人走上台阶。', ['x'], 'a') },
      { ...P(cps[1], 'replace', cps[1].text, '另一个人从通道走出来。', ['y'], 'b') },
    ], { dispositions: [{ issue_id: 'x', status: 'patched' }, { issue_id: 'y', status: 'patched' }] }),
  });
  check('E01-5b 授权通过 ≠ 组合安全：组合后删光先行语仍被组合门禁抓到，且不称"已验证"',
    both.ok === true && both.verified === false
    && ((both.combined && both.combined.hard) || []).some((f) => f.code === 'reference_anchor'),
    JSON.stringify({ ok: both.ok, verified: both.verified, hard: (both.combined || {}).hard }));
  // CRLF + emoji：授权跨度的偏移是 UTF-16 code unit，未授权内容逐字不动
  const crlf = '甲段。\r\n\r\n乙段🙂。\r\n\r\n丙段。';
  const cSnap = RP.snapshotOf(crlf, { chapter_id: 16 });
  const cSpan = spanOf(crlf, '乙段🙂。');
  const cAuth = { authorized: { q1: [{ span_id: cSpan.span_id, start: cSpan.start, end: cSpan.end, text: cSpan.text }] } };
  const cRun = RP.runRevisionPipeline({
    snapshot: cSnap, chapterId: 16, selectedIssueIds: ['q1'], engine: K, authorization: cAuth,
    raw: V2(cSnap, [P(cSpan, 'replace', '乙段🙂。', '乙段。', ['q1'])]),
  });
  check('E01-5c CRLF 与 emoji 下的授权边界仍精确（未授权段含 CRLF 逐字不变）',
    cRun.ok === true && cRun.text === '甲段。\r\n\r\n乙段。\r\n\r\n丙段。',
    JSON.stringify(cRun.text));
}

// ── E01-6（2026-10-10 现场事故）：审稿散文里的「」是**提及**，不是精确编辑目标 ──────────
// 事故复盘：报告用「」随手括起一句话，引号外的句号不在引用里 → 计划只授权 20 字（不含句号）；
// 而提示词同时下发了另一套原生 span_id 目录（`p1s1｜3751年全民觉醒日，江陵市第三检测中心。`），
// 模型照目录写补丁 → 5/5 条被判 out_of_scope、正文一个字都没动。
// 本组锁两件事：①散文「」提及 → 授权**所在整句**（跨度与提示词不再有两套身份）；
//            ②结构化 quote（作者已指定逐字目标）保持片段精度，不借"修缺陷"之名放大授权。
{
  const body = '3751年全民觉醒日，江陵市第三检测中心。门口的栏杆拐了两道弯。\n\n王磊把耳机摘下来：“你就不紧张？”';
  const snap = RP.snapshotOf(body, { chapter_id: 21 });
  const plan = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'T1', text: '开篇只有「3751年全民觉醒日，江陵市第三检测中心」，建议补一句时间定位' }],
  });
  const h = plan.hotspots[0];
  check('E01-6 散文里的「」提及（不含句号）→ 授权跨度是**所在整句**，不是片段本身',
    plan.hotspots.length === 1 && !!h
    && h.original === '3751年全民觉醒日，江陵市第三检测中心。'
    && h.span.span_id === 'p1s1' && h.span.start === 0 && h.span.end === 21,
    JSON.stringify(h && { id: h.span.span_id, len: h.original.length, original: h.original }));
  const auth = authOf(plan);
  const sent = RP.buildSpans(body, { sentences: true }).find((s) => s.span_id === 'p1s1');
  const legit = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 21, selectedIssueIds: ['T1'], engine: K, authorization: auth,
    raw: V2(snap, [P(sent, 'replace', sent.text, '3751年全民觉醒日，江陵市第三检测中心。觉醒当天上午，队伍还没散。', ['T1'])], {
      dispositions: [{ issue_id: 'T1', status: 'patched', reason: '补一句落在事件上的时间定位' }],
    }),
  });
  check('E01-6b 模型按整句写补丁 → 通过（这正是现场被误判 out_of_scope 的那一类补丁）',
    legit.ok === true && legit.applied.length === 1 && legit.text.includes('觉醒当天上午'),
    JSON.stringify({ ok: legit.ok, code: legit.error_code }));
  const other = RP.buildSpans(body, { sentences: true }).find((s) => s.text === '门口的栏杆拐了两道弯。');
  const attack = RP.runRevisionPipeline({
    snapshot: snap, chapterId: 21, selectedIssueIds: ['T1'], engine: K, authorization: auth,
    raw: V2(snap, [P(other, 'replace', other.text, '门口没什么人。', ['T1'])]),
  });
  check('E01-6c 放宽只到所在整句：同章其它跨度仍 out_of_scope，原文逐字不变',
    attack.ok === false && attack.error_code === 'out_of_scope' && attack.text === body,
    JSON.stringify({ code: attack.error_code, changed: attack.text !== body }));
  const structured = PL.buildRevisionPlan({
    snapshot: snap,
    findings: [{ id: 'T2', text: '只压这一处列举', quote: '3751年全民觉醒日，江陵市第三检测中心' }],
  });
  check('E01-6d 结构化 quote（作者指定逐字目标）保持片段精度：不放大到整句',
    structured.hotspots.length === 1
    && structured.hotspots[0].original === '3751年全民觉醒日，江陵市第三检测中心'
    && /~/.test(String(structured.hotspots[0].span.span_id)),
    JSON.stringify(structured.hotspots.map((x) => [x.span.span_id, x.original.length])));
  // 段落恰好等于一句话（长度相同）时不能随机选段落：同一处出现两个 span_id 就又会"两套身份"。
  const tieBody = '3751年全民觉醒日，江陵市第三检测中心。\n\n门口的栏杆拐了两道弯。';
  const planTie = PL.buildRevisionPlan({
    snapshot: RP.snapshotOf(tieBody, { chapter_id: 22 }),
    findings: [{ id: 'T3', text: '开篇只有「3751年全民觉醒日，江陵市第三检测中心」，补一句时间定位' }],
  });
  check('E01-6e 段落与句子长度相同时优先授权**句子**（同一处不得有两个身份）',
    planTie.hotspots.length === 1 && planTie.hotspots[0].span.span_id === 'p1s1',
    JSON.stringify(planTie.hotspots.map((x) => x.span.span_id)));
  // 跨句提及（没有单独一句装得下）→ 保持片段精度：**不能**退到"包含它的段落"，
  // 因为段落长度没有上界（实测另一版样本"一段=整章 3148 字"）。
  const multi = '开头一句。\n\n岳宸炎把排号纸翻了个面。纸背面是空白的，边角有一小块折痕。\n\n收尾一句。';
  const planMulti = PL.buildRevisionPlan({
    snapshot: RP.snapshotOf(multi, { chapter_id: 23 }),
    findings: [{ id: 'T4', text: '「岳宸炎把排号纸翻了个面。纸背面是空白的」重复了' }],
  });
  const hm = planMulti.hotspots[0];
  check('E01-6f 跨句提及保持片段精度（不放宽到整段：段落长度没有上界）',
    planMulti.hotspots.length === 1 && /~/.test(String(hm.span.span_id))
    && hm.original === '岳宸炎把排号纸翻了个面。纸背面是空白的'
    && !hm.original.includes('边角'),
    JSON.stringify({ id: hm.span.span_id, len: hm.original.length }));
}

finish('08-authorization');
