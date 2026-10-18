#!/usr/bin/env node
/**
 * .p1-baseline/test-1024-chapter-fixtures.mjs —— v1.2.4 P0B：
 * 把两轮真实章稿对照（A01–A08 / B01–B08）变成**可复现的最小夹具**，并钉住验收口径。
 *
 * 为什么必须做成夹具（方案 §2 / §13 P0B / §14.2 / §14.3 / §16 第 3 条）：
 *   真实报障里最贵的一次错误不是"某个判据写错了"，而是"修了一个句子就说这一项修好了"。
 *   这类错误只要没有夹具就会**反复复发**，因为下一次改判据时没有任何东西会叫。
 *
 * 本套件钉的是三条不变式：
 *   ① **未跑语义 ⇒ 任何一条都不得是 ISSUE_VERIFIED**（含"模型自称已修好"）。
 *   ② 证据层面**客观未消除**的项（旧引文还在 / 该出现的字面没出现 / 必须保留的被删），
 *      即便模型把 verdict 写成 pass，也不得变成 ISSUE_VERIFIED。
 *   ③ 8 项全选 ⇒ 8 行结论，计数自洽；`PATCH_APPLIED ≠ ISSUE_VERIFIED`。
 *
 * 夹具文本是**从两轮真实章稿提炼的最小片段**（保留会互相矛盾的关键句），不是原文全文：
 * 目的是让判据在几十行内可复现，而不是保存作者正文。零依赖、零计费、离线。
 */
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
const asUrl = (rel) => new URL('../' + rel, import.meta.url).href;
await import(asUrl('public/revision-semantic-verifier.js'));
await import(asUrl('public/revision-closure.js'));
await import(asUrl('public/revision-finalize.js'));
const SV = globalThis.NovelRevisionSemanticVerifier;
const FZ = globalThis.NovelRevisionFinalize;

// ── 工具：把"修前/修后"两段文本变成可被 verifier 复核的补丁 ──────────────────
function splitParas(t) {
  return String(t == null ? '' : t).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}
function offsets(base, paras) {
  const out = [];
  let cur = 0;
  for (const p of paras) {
    const at = base.indexOf(p, cur);
    if (at < 0) throw new Error('夹具段落不在基准文本里：' + p.slice(0, 24));
    out.push({ text: p, start: at, end: at + p.length });
    cur = at + p.length;
  }
  return out;
}
function lcsPairs(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}
/** 段落级 LCS → 若干"替换/插入/删除"补丁（偏移基于基准文本，可被 verifier 逐字复核）。 */
function makePatches(base, after) {
  const bp = splitParas(base);
  const ap = splitParas(after);
  const bo = offsets(base, bp);
  const pairs = lcsPairs(bp, ap);
  const runs = [];
  let bi = 0;
  let ai = 0;
  for (const [pb, pa] of pairs) {
    if (pb > bi || pa > ai) runs.push({ bi, bj: pb, ai, aj: pa });
    bi = pb + 1;
    ai = pa + 1;
  }
  if (bi < bp.length || ai < ap.length) runs.push({ bi, bj: bp.length, ai, aj: ap.length });

  const patches = [];
  runs.forEach((r, k) => {
    const hasBase = r.bj > r.bi;
    const hasAfter = r.aj > r.ai;
    // 关键：范围要**连同前后的段落分隔**一起替换，否则删掉中间一段会留下 `\n\n\n\n`
    // （那样补丁重建出来的文本就和"修后文本"差一个空行，后面的 diff 断言全部失真）。
    const rangeStart = r.bi > 0 ? bo[r.bi - 1].end : 0;
    const rangeEnd = r.bj < bo.length ? bo[r.bj].start : base.length;
    const lead = rangeStart > 0 ? '\n\n' : '';
    const trail = rangeEnd < base.length ? '\n\n' : '';
    const original = base.slice(rangeStart, rangeEnd);
    // 纯删除时保留**左**分隔（否则被删段前后的两段会粘在一起）；删到尾就什么都不留。
    const replacement = hasAfter
      ? lead + ap.slice(r.ai, r.aj).join('\n\n') + trail
      : (rangeEnd < base.length ? lead : '');
    const op = !original ? 'insert' : (!replacement ? 'delete' : 'replace');
    patches.push({
      patch_id: `p${k + 1}`, group_id: `p${k + 1}`, span_id: `fix-${k + 1}`,
      issue_ids: [], op, original, replacement, start: rangeStart, end: rangeEnd,
    });
    if (!hasBase && !hasAfter) throw new Error('空的夹具补丁');
  });
  // 反向应用，验证"补丁真的能重建修后文本"（否则后面所有断言都不成立）
  let rebuilt = base;
  for (const p of patches.slice().sort((x, y) => y.start - x.start)) {
    rebuilt = rebuilt.slice(0, p.start) + (p.op === 'delete' ? '' : p.replacement) + rebuilt.slice(p.end);
  }
  if (rebuilt !== after) throw new Error('夹具补丁无法重建修后文本（补丁生成器有 bug）');
  return patches;
}

/** 把补丁按"改到了哪条问题的证据"归到 issue 上（界面里由 Host 授权表做，这里按证据归属）。 */
function attachIssues(patches, findings) {
  for (const p of patches) {
    const ids = new Set();
    for (const f of findings) {
      const ev = Array.isArray(f.evidence) ? f.evidence : [];
      const hit = ev.some((e) => {
        const q = String((e && e.quote) || '').trim();
        if (!q) return false;
        return (p.original && p.original.includes(q)) || (p.replacement && p.replacement.includes(q));
      });
      if (hit) ids.add(String(f.id));
    }
    p.issue_ids = [...ids];
  }
  return patches;
}

const coverageOf = (findings, patches, status = 'patched') => findings.map((f) => ({
  issue_id: String(f.id),
  status: (patches || []).some((p) => p.issue_ids.includes(String(f.id))) ? status : 'deferred',
  target_count: 1,
  reference_count: (f.evidence || []).filter((e) => e.role === 'reference').length,
}));

// ══════════════════════════════════════════════════════════════════════════
// 夹具 A：候场大厅版本（A01–A08）
// ══════════════════════════════════════════════════════════════════════════
const BASE_A = [
  '检测单在岳宸炎手里，折过两折。',
  '王磊把检测单拍在桌上：「职业方向栏，基础战斗能力。」',
  '「D 级评价：普通作业类。」工作人员念了一遍。',
  '检测规则是这样的：先由登记员核对身份，再由检测台读取觉醒等级，最后把回执交到本人手里。',
  '检测规则是这样的：先由登记员核对身份，再由检测台读取觉醒等级，最后把回执交到本人手里。',
  '检测规则是这样的：先由登记员核对身份，再由检测台读取觉醒等级，最后把回执交到本人手里。',
  '又是 A 级。今天已经出了两个 A 级觉醒者，都在同一个检测中心，同一天。',
  '人群里有人倒吸一口气。',
  '人群里又有人倒吸一口气。',
  '人群里还有人倒吸一口气。',
  '他没有说话。他没有回头。他没有停下脚步。',
  '一只手伸过来。那是一只细白的手腕。',
  '林清雪拢了拢袖口，摊开掌心给他看。',
  '编号 0731。',
  '系统提示音在章末响了一次：觉醒登记完成。',
  '检测单也在同一个口袋里，折过一折。',
].join('\n\n');

// 修后（真实结果：多数只改了一处，且有几项被"修坏了"）
const AFTER_A = [
  '检测单在岳宸炎手里，折过两折。',
  '王磊把检测单拍在桌上：「职业方向栏，基础战斗能力。」',
  '「D 级评价：普通职业。」工作人员念了一遍。',
  '检测规则是这样的：先由登记员核对身份，再由检测台读取觉醒等级，最后把回执交到本人手里。',
  '检测规则是这样的：先由登记员核对身份，再由检测台读取觉醒等级，最后把回执交到本人手里。',
  '又是 A 级。今天出了一个 A 级、一个 B 级觉醒者，都在同一个检测中心，同一天。',
  '人群里有人倒吸一口气。',
  '人群里又有人倒吸一口气。',
  '他没有说话。他没有停下脚步。',
  '编号 0731。',
  '系统提示音在章末响了一次：觉醒登记完成。',
  '检测单也在同一个口袋里，折过一折。',
].join('\n\n');

const FINDINGS_A = [
  {
    id: 'A01', type: 'object_state', severity: 'high', title: '检测单折数前后不符',
    evidence: [
      { quote: '折过两折', role: 'reference' },
      { quote: '折过一折', role: 'candidate_edit' },
    ],
    acceptance: { rule: '读完整持有物动作链后折数自洽', preserve: ['检测单'] },
  },
  {
    id: 'A02', type: 'field_role', severity: 'high', title: '职业方向栏写成等级评价',
    evidence: [{ quote: '基础战斗能力', role: 'candidate_edit' }],
    acceptance: { rule: '职业方向栏写职业方向，不写等级评价', preserve: ['王磊', '检测单'] },
  },
  {
    id: 'A03', type: 'canon_conflict', severity: 'high', title: 'D 级评价与词条冲突',
    evidence: [{ quote: '普通作业类', role: 'candidate_edit' }],
    acceptance: { rule: 'D 级评价与权威词条一致' },
  },
  {
    id: 'A04', type: 'multi_span_repetition', severity: 'medium', title: '检测规则被反复完整讲解',
    evidence: [
      { quote: '检测规则是这样的：先由登记员核对身份', role: 'reference' },
      { quote: '最后把回执交到本人手里。', role: 'candidate_edit' },
    ],
    acceptance: { rule: '规则只讲一次，后文不得整段重复' },
  },
  {
    id: 'A05', type: 'canon_conflict', severity: 'high', title: '同一日同中心两个 A 级的稀缺度',
    evidence: [{ quote: '今天已经出了两个 A 级觉醒者', role: 'candidate_edit' }],
    acceptance: { rule: '蓝图要求保留双 A 时必须保留并解释异常性', preserve: ['两个 A 级觉醒者'] },
  },
  {
    id: 'A06', type: 'narrative_style', severity: 'low', title: '无名群众反应堆积',
    evidence: [
      { quote: '人群里有人倒吸一口气。', role: 'reference' },
      { quote: '人群里又有人倒吸一口气。', role: 'candidate_edit' },
    ],
    acceptance: { rule: '按信息/对照/关系保留，纯重复删掉' },
  },
  {
    id: 'A07', type: 'narrative_style', severity: 'low', title: '重复否定句与无信息动作',
    evidence: [
      { quote: '他没有说话。', role: 'reference' },
      { quote: '他没有停下脚步。', role: 'candidate_edit' },
    ],
    acceptance: { rule: '连续否定句保留承担功能的，删除纯重复' },
  },
  {
    id: 'A08', type: 'foreshadowing_preserve', severity: 'high', title: '模板外貌描写与必要的袖口/掌心伏笔',
    evidence: [{ quote: '细白的手腕', role: 'candidate_edit' }],
    acceptance: { rule: '删模板句，但拢袖口—看掌心的伏笔必须留', preserve: ['拢了拢袖口', '摊开掌心', '0731'] },
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 夹具 B：九月上午报名与热敏回执（B01–B08，作者明确 8 项全选）
// ══════════════════════════════════════════════════════════════════════════
const BASE_B = [
  '江陵市的九月上午，闷得人后背发潮。他抬手擦了擦手心的汗。',
  '窗口前排着队，登记台只有一张，队伍只有一队。',
  '登记处摆着三块石板，每一块前面都排着队。',
  '他掏出手机，10:41，没有新消息。',
  '母亲的消息是 10:23 发的：「妈这边忙，你先吃，锅里有粥。」',
  '母亲这个点刚交完班。晚上十点出门，早上八点半回来。',
  'B 级的家长在旁边鼓掌。',
  'A 级的家长也在旁边鼓掌。',
  '检测大厅里亮着灯，上午的太阳照得人发暖。',
  '他走到台阶上，掏出手机，看到一条未读消息。',
  '外面上午的太阳照得人发暖。',
  '回执单在手里，热敏纸上的字迹正在变淡。他用袖口蹭掉手汗，免得把纸弄糊。',
  '他又擦了擦手心的汗。',
].join('\n\n');

const AFTER_B = [
  '江陵市的九月上午，闷得人后背发潮。他把登记条从窗口递进去。',
  '窗口前排着队，登记台只有一张，队伍只有一队。',
  '登记处摆着一块石板，石板前只排着这一队。',
  '他掏出手机，10:41，没有新消息。',
  '母亲的消息是刚发的：「妈这边忙，你先吃，锅里有粥。」',
  '母亲这个点刚交完班。晚上十点出门，早上八点半回来。',
  'A 级的家长也在旁边鼓掌。',
  '检测大厅里亮着灯，上午的太阳照得人发暖。',
  '他走到台阶上，掏出手机，看到一条未读消息。',
  '外面上午的太阳照得人发暖。',
  '回执单在手里，热敏纸上的字迹正在变淡。他用袖口蹭掉手汗，免得把纸弄糊。',
].join('\n\n');

const FINDINGS_B = [
  {
    id: 'B01', type: 'multi_span_repetition', severity: 'medium', title: '手汗/擦手表达重复',
    evidence: [
      { quote: '他用袖口蹭掉手汗', role: 'reference' },
      { quote: '他又擦了擦手心的汗。', role: 'candidate_edit' },
    ],
    acceptance: { rule: '按描写功能保留两处，其余删掉' },
  },
  {
    id: 'B02', type: 'temporal_consistency', severity: 'high', title: '10:41 无新消息 vs 10:23 未读消息',
    evidence: [
      { quote: '10:41，没有新消息', role: 'reference' },
      { quote: '10:23 发的', role: 'candidate_edit' },
    ],
    acceptance: { rule: '消息确实在两次查看之间到达', preserve: ['妈这边忙'] },
  },
  {
    id: 'B03', type: 'temporal_consistency', severity: 'high', title: '母亲夜班行程矛盾',
    evidence: [
      { quote: '晚上十点出门，早上八点半回来', role: 'reference' },
      { quote: '母亲这个点刚交完班', role: 'candidate_edit' },
      { quote: '妈这边忙，你先吃，锅里有粥。', role: 'reference' },
    ],
    acceptance: { rule: '行程没有自相矛盾', preserve: ['锅里有粥'] },
  },
  {
    id: 'B04', type: 'narrative_style', severity: 'medium', title: '等级对应群众反应模式化',
    evidence: [
      { quote: 'B 级的家长在旁边鼓掌', role: 'reference' },
      { quote: 'A 级的家长也在旁边鼓掌', role: 'candidate_edit' },
    ],
    acceptance: { rule: '保留有对比功能的反应，剔除纯重复' },
  },
  {
    id: 'B05', type: 'scene_geometry', severity: 'high', title: '三块石板却只有一队一检测台',
    evidence: [{ quote: '登记处摆着三块石板', role: 'candidate_edit' }],
    acceptance: { rule: '石板数量与队伍/检测台一致', preserve: ['登记台只有一张'] },
  },
  {
    id: 'B06', type: 'narrative_style', severity: 'low', title: '上午的太阳在室内外重复出现',
    evidence: [
      { quote: '上午的太阳照得人发暖', role: 'reference' },
      { quote: '外面上午的太阳照得人发暖', role: 'candidate_edit' },
    ],
    acceptance: { rule: '纯布景重复在批准范围内删减' },
  },
  {
    id: 'B07', type: 'world_time_anchor', severity: 'high', title: '缺 3751 年纪年锚点',
    evidence: [{ quote: '3751年全民觉醒日', role: 'reference' }],
    acceptance: { rule: '纪年锚点必须落到正文（回执/角标）', must_contain: ['3751'] },
  },
  {
    id: 'B08', type: 'target_length', severity: 'medium', title: '低于 4000 字目标',
    evidence: [],
    acceptance: { rule: '蓝图把本章篇幅定为硬目标', min_chars: 4000 },
  },
];

// ══════════════════════════════════════════════════════════════════════════
// 断言
// ══════════════════════════════════════════════════════════════════════════
const lyingSemantic = (findings) => Object.fromEntries(findings.map((f) => [String(f.id), {
  status: 'pass', reason: '模型声称已按审稿意见修好', checks: [{ criterion: '模型自述', passed: true, evidence: ['自称已改'] }],
}]));

function runRound(label, base, after, findings, extra = {}) {
  const patches = attachIssues(makePatches(base, after), findings);
  const coverage = coverageOf(findings, patches);
  const ids = findings.map((f) => String(f.id));

  // ── ① 没有语义结论：一条都不许是 ISSUE_VERIFIED ─────────────────────────
  const noSem = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: base, candidateText: after,
    selectedIssueIds: ids, applied: patches, coverage,
    findings, plan: null, invariants: { must_keep: [] },
  });
  check(`${label}-1 ${ids.length} 项全选 ⇒ ${ids.length} 行结论，且"未跑语义"一条都不算通过`,
    noSem.rows.length === ids.length
      && noSem.rows.every((r) => r.final_status !== 'ISSUE_VERIFIED')
      && noSem.summary.verified === 0
      && noSem.status === 'AWAITING_SEMANTIC',
    JSON.stringify({ rows: noSem.rows.map((r) => `${r.issue_id}:${r.final_status}`), status: noSem.status }));

  const sum = noSem.summary;
  check(`${label}-2 计数自洽（verified+unresolved+awaiting+partial+canon = total）且补丁数不等于修复数`,
    sum.verified + sum.unresolved + sum.awaiting_semantic + sum.partial + sum.canon_conflict === sum.total
      && sum.patch_applied > 0 && sum.verified === 0,
    JSON.stringify(sum));

  check(`${label}-3 全局 diff 校验通过（候选确实能由补丁逐字重建）`,
    noSem.semantic.summary.diff_ok === true || noSem.semantic.issues.every((i) => i.reason_code !== 'DIFF_MISMATCH'),
    JSON.stringify(noSem.semantic.issues.map((i) => i.reason_code)));

  check(`${label}-4 PATCH_APPLIED ≠ ISSUE_VERIFIED：覆盖表说"已改"的条目要么待复验、要么被证据判失败，没有一条算通过`,
    noSem.rows.filter((r) => r.coverage_status === 'patched')
      .every((r) => r.final_status === 'AWAITING_SEMANTIC' || r.final_status === 'UNRESOLVED'),
    JSON.stringify(noSem.rows.map((r) => [r.issue_id, r.coverage_status, r.final_status])));

  // ── ② 模型把每一条都写成 pass，客观证据仍必须拦住 ─────────────────────────
  const lying = FZ.finalizeRevisionCandidate({
    mode: 'single', originalText: base, candidateText: after,
    selectedIssueIds: ids, applied: patches, coverage,
    findings, plan: null, invariants: { must_keep: [] },
    semanticByIssue: lyingSemantic(findings),
    canonConflictIds: extra.canonConflictIds || [],
  });
  const blockedByEvidence = (extra.mustBlockEvenIfLying || []).map((id) => {
    const row = lying.rows.find((r) => String(r.issue_id) === id);
    return { id, final: row && row.final_status, code: row && row.reason_code };
  });
  check(`${label}-5 模型自称"全部修好"也骗不过：证据未消除/该出现的字面缺失/必须保留被删的条目仍不通过`,
    blockedByEvidence.every((x) => x.final && x.final !== 'ISSUE_VERIFIED'),
    JSON.stringify(blockedByEvidence));

  check(`${label}-6 出现"拦住了模型自述"的确定性原因码（不是只靠语义层反悔）`,
    blockedByEvidence.some((x) => x.code && x.code !== 'SEMANTIC_FAILED'),
    JSON.stringify(blockedByEvidence.map((x) => x.code)));

  return { patches, coverage, noSem, lying };
}

// ── 夹具 A ────────────────────────────────────────────────────────────────
const A = runRound('A', BASE_A, AFTER_A, FINDINGS_A, {
  mustBlockEvenIfLying: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'],
  canonConflictIds: ['A03'],
});

// A05：擅自把第二个 A 级降成 B（蓝图要求保留双 A）必须被"必须保留项"抓住
{
  const row = A.lying.rows.find((r) => r.issue_id === 'A05');
  check('A-7 A05 不得擅自降 B：蓝图要求的"两个 A 级觉醒者"被改写后，该项不通过',
    row && row.final_status !== 'ISSUE_VERIFIED'
      && (row.reason_code === 'DETERMINISTIC_FAILED' || /必须保留/.test(row.reason)),
    JSON.stringify(row && { final: row.final_status, code: row.reason_code, reason: String(row.reason).slice(0, 60) }));
}
// A08：为消除重复把袖口/掌心伏笔一起删掉 = 修坏了
{
  const row = A.lying.rows.find((r) => r.issue_id === 'A08');
  check('A-8 A08 删除"细白的手腕"时不得连"拢袖口/摊开掌心/0731"一起删（伏笔保护）',
    row && row.final_status !== 'ISSUE_VERIFIED' && /必须保留/.test(String(row.reason)),
    JSON.stringify(row && { final: row.final_status, reason: String(row.reason).slice(0, 80) }));
}
// A03：有权威词条冲突时，最终结论必须是 CANON_CONFLICT（而不是"修好了"）
{
  const row = A.lying.rows.find((r) => r.issue_id === 'A03');
  check('A-9 A03 与词条冲突 → 标 CANON_CONFLICT 待作者裁决（不静默判通过）',
    row && row.final_status === 'CANON_CONFLICT',
    JSON.stringify(row && { final: row.final_status, code: row.reason_code }));
}

// ── 夹具 B（作者明确 8 项全选）──────────────────────────────────────────────
const B = runRound('B', BASE_B, AFTER_B, FINDINGS_B, {
  mustBlockEvenIfLying: ['B03', 'B04', 'B06', 'B07', 'B08'],
  canonConflictIds: [],
});

// B02 / B05：修后"局部可见"已改，但时序/空间是否真的自洽只能靠语义层 —— 未跑就必须是待复验
{
  const b02 = B.noSem.rows.find((r) => r.issue_id === 'B02');
  const b05 = B.noSem.rows.find((r) => r.issue_id === 'B05');
  check('B-7 B02/B05 局部差异可见 ≠ 已解决：未跑语义时仍是待复验（不因删掉旧时间戳/改石板数给满分）',
    b02 && b05 && b02.final_status === 'AWAITING_SEMANTIC' && b05.final_status === 'AWAITING_SEMANTIC',
    JSON.stringify({ b02: b02 && b02.final_status, b05: b05 && b05.final_status }));
}

// B07：纪年锚点在修前天然不存在（正是"漏了"）—— 必须靠 must_contain 才能判，不能靠"旧引文消失"
{
  const row = B.lying.rows.find((r) => r.issue_id === 'B07');
  check('B-8 B07 纪年锚点缺失：模型说 pass 也必须有 REQUIRED_TEXT_MISSING 的确定性失败',
    row && row.final_status === 'UNRESOLVED'
      && (row.reason_code === 'REQUIRED_TEXT_MISSING' || row.reason_code === 'DETERMINISTIC_FAILED'),
    JSON.stringify(row && { final: row.final_status, code: row.reason_code }));
}

// B08：蓝图硬字数目标未达成
{
  const row = B.lying.rows.find((r) => r.issue_id === 'B08');
  check('B-9 B08 硬篇幅目标未达成 → TARGET_LENGTH_MISSED（软目标才由作者签收）',
    row && row.final_status === 'UNRESOLVED'
      && (row.reason_code === 'TARGET_LENGTH_MISSED' || row.reason_code === 'DETERMINISTIC_FAILED'),
    JSON.stringify(row && { final: row.final_status, code: row.reason_code }));
}

// B03：三个证据（短信/旁白/夜班时刻）必须一起读，"10:23 改成刚发的"不能顺带把 B03 判过
{
  const row = B.lying.rows.find((r) => r.issue_id === 'B03');
  check('B-10 B03 母亲行程：改掉短信时间也不能让"这个点刚交完班"变成通过（多证据整项复验）',
    row && row.final_status === 'UNRESOLVED',
    JSON.stringify(row && { final: row.final_status, code: row.reason_code }));
}

// ── 跨轮：A 与 B 的验收口径必须一致（不是两套实现）────────────────────────
{
  const keysOf = (r) => r.rows.map((x) => `${x.issue_id}:${x.final_status}:${x.reason_code}`).sort().join(',');
  const again = runRound('B2', BASE_B, AFTER_B, FINDINGS_B, {
    mustBlockEvenIfLying: ['B03', 'B07'],
  });
  check('X-1 同一素材重复终审结果稳定（同输入同结论；不是随机/时间相关）',
    keysOf(B.noSem) === keysOf(again.noSem) && B.noSem.status === again.noSem.status,
    `${B.noSem.status} vs ${again.noSem.status}`);
}

finish('test-1024 两轮真实章稿夹具（A01–A08 / B01–B08）');
