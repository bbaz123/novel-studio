#!/usr/bin/env node
/**
 * probe-v125-gaps.mjs —— 只读诊断探针（零依赖、零计费、不写任何生产文件）。
 *
 * 目的：用**本机当前代码的真实输出**回答"I03/I04 这类'改了但没修好'为什么可能被
 * 呈现为 6 已修复 / 1 部分 / 1 未修复"。每条结论必须能被这个脚本复现，
 * 而不是靠阅读印象断言"某一行就是 Bug"。
 *
 * 运行：node .p1-baseline/probe-v125-gaps.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (rel) => {
  await import(new URL(`../${rel}`, import.meta.url).href);
};
await load('public/revision-semantic-verifier.js');
await load('public/revision-closure.js');
await load('public/revision-finalize.js');
const SV = globalThis.NovelRevisionSemanticVerifier;
const CL = globalThis.NovelRevisionClosure;
const FZ = globalThis.NovelRevisionFinalize;

function line(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

// ── 缺口 1：语义层给 "partial"（部分修复）时，当前实现是否保留这个结论？ ─────────
const base = '她显然准备好了更长的安慰，比如“D级也有D级的前途”。';
const finding = {
  id: 'I03',
  title: '阿姨心理预演越出有限视角',
  type: 'style',
  evidence: [{ quote: '她显然准备好了更长的安慰', role: 'candidate_edit' }],
  acceptance: { rule: '不得凭空陈述配角内心', preserve: [] },
};
const partiallyEdited = '那女人张了张嘴，停了一下，只点了点头。';
const partial = SV.verifyIssue({
  finding, baseText: base, revisedText: partiallyEdited,
  applied: [{ start: 0, end: base.length, original: base, replacement: partiallyEdited, issue_ids: ['I03'] }],
  coverage: { status: 'patched' },
  semantic: { status: 'partial', reason: '只剩一处心理预演' },
});
line('G1 sem=partial → verdict', partial.verdict);
line('G1 sem=partial → final_status', partial.final_status);
line('G1 sem=partial → reason_code', partial.reason_code);

// ── 缺口 2：PARTIAL 是否进入有界复修队列？ ─────────────────────────────────────
const queue = CL.planAutoRepair({
  issues: [{ issue_id: 'I04', verdict: 'partial', final_status: 'PARTIAL', reason_code: 'SEMANTIC_PARTIAL' }],
  round: 0, maxRounds: 2, estimateCents: 10, budgetCents: 200,
});
line('G2 planAutoRepair(PARTIAL) → ok', queue.ok);
line('G2 planAutoRepair(PARTIAL) → reason', queue.reason);
const targets = CL.repairTargets({
  issues: [{ issue_id: 'I04', final_status: 'PARTIAL', reason_code: 'SEMANTIC_PARTIAL' }],
});
line('G2 repairTargets(PARTIAL) → targets', targets.targets.map((t) => t.issue_id));

// ── 缺口 3：结构化 revision-trace.v1 事件是否存在？ ───────────────────────────
const traceFiles = ['public/revision-trace.js'];
line('G3 public/revision-trace.js exists', traceFiles.every((f) => fs.existsSync(path.join(REPO, f))));
const finalizeSrc = fs.readFileSync(path.join(REPO, 'public/revision-finalize.js'), 'utf8');
line('G3 finalize 接线 revision-trace', /NovelRevisionTrace/.test(finalizeSrc));

// ── 缺口 4：未跑语义时终审是否仍能给出 PARTIAL/UNRESOLVED（而不是 AWAITING_SEMANTIC）？ ─
const noSem = SV.verifyIssue({
  finding, baseText: base, revisedText: base, applied: [{ start: 0, end: 0, original: '', replacement: '', issue_ids: ['I03'] }],
  coverage: { status: 'patched' },
});
line('G4 未跑语义 + 锚点原句仍在 → verdict', noSem.verdict);
line('G4 未跑语义 + 锚点原句仍在 → final_status', noSem.final_status);
line('G4 未跑语义 + 锚点原句仍在 → reason_code', noSem.reason_code);

// ── 缺口 5：终审行是否带 actual_change（"完全未修改"与"改动了但仍有问题"的分界）？ ─
const finalized = FZ.finalizeRevisionCandidate({
  originalText: base, candidateText: base,
  selectedIssueIds: ['I03'], findings: [finding],
  applied: [{ start: 0, end: 0, original: '', replacement: '', issue_ids: ['I03'] }],
  coverage: [{ issue_id: 'I03', status: 'patched' }], safetyAvailable: true,
});
const row = finalized.rows[0];
line('G5 终审 row.actual_change', row.actual_change);
line('G5 终审 stage', finalized.status);
line('G5 终审 row.final_status/reason', [row.final_status, row.reason_code]);

// ── 缺口 6：复修之后，先前 PASS 的条目不能被"确定性重验"冲成待验 ─────────────────
const prior = {
  issues: [
    { issue_id: 'I01', verdict: 'pass', final_status: 'ISSUE_VERIFIED', semantic_status: 'pass', checks: [] },
    { issue_id: 'I04', verdict: 'partial', final_status: 'PARTIAL', semantic_status: 'partial', checks: [] },
  ],
  summary: { verified: 1, unresolved: 0 },
};
const deterministic = {
  issues: [
    { issue_id: 'I01', verdict: 'need_context', final_status: 'AWAITING_SEMANTIC', semantic_status: 'not_run', checks: [] },
    { issue_id: 'I04', verdict: 'need_context', final_status: 'AWAITING_SEMANTIC', semantic_status: 'not_run', checks: [] },
  ],
  summary: { diff_ok: true },
};
const merged = CL.mergeRepairSemantic(prior, deterministic, ['I04']);
const byId = Object.fromEntries(merged.issues.map((i) => [i.issue_id, i]));
line('G6 未改条目 I01 保留原结论', byId.I01.verdict);
line('G6 本轮改过的 I04 置为待复验', byId.I04.verdict);
line('G6 汇总不虚报通过数', merged.summary.verified);

// ── 缺口 7：语义层 blocked / unverified 不得被当成 pass ───────────────────────
const blocked = SV.verifyIssue({
  finding, baseText: base, revisedText: partiallyEdited,
  applied: [{ start: 0, end: base.length, original: base, replacement: partiallyEdited, issue_ids: ['I03'] }],
  coverage: { status: 'patched' }, semantic: { status: 'blocked', reason: '预算耗尽' },
});
line('G7 sem=blocked → verdict/final', [blocked.verdict, blocked.final_status, blocked.reason_code]);

const unverified = SV.verifyIssue({
  finding, baseText: base, revisedText: partiallyEdited,
  applied: [{ start: 0, end: base.length, original: base, replacement: partiallyEdited, issue_ids: ['I03'] }],
  coverage: { status: 'patched' }, semantic: { status: 'unverified', reason: '证据不足' },
});
line('G7 sem=unverified → verdict/final', [unverified.verdict, unverified.final_status, unverified.reason_code]);

// ── 缺口 8：模型谎称 pass，但锚点原句仍在 → 硬事实必须压过自评 ─────────────────
const lying = SV.verifyIssue({
  finding, baseText: base, revisedText: base,
  applied: [{ start: 0, end: 0, original: '', replacement: '', issue_ids: ['I03'] }],
  coverage: { status: 'patched' }, semantic: { status: 'pass', reason: '模型自述已修好' },
});
line('G8 模型说 pass 但原句仍在 → verdict/reason', [lying.verdict, lying.reason_code]);

// ── 缺口 9：硬阻塞（保护区）不得进入复修队列 ──────────────────────────────────
const blockedQueue = CL.planAutoRepair({
  issues: [{ issue_id: 'I05', verdict: 'partial', final_status: 'PARTIAL', reason_code: 'PROTECTED_SPAN' }],
  round: 0, maxRounds: 2, estimateCents: 10, budgetCents: 200,
});
line('G9 保护区 PARTIAL 进队？', [blockedQueue.ok, blockedQueue.reason]);

// ── G10：revision-trace.v1 事件可由 finalize 结果确定性生成，且不含正文 ─────────
await load('public/revision-trace.js');
const TR = globalThis.NovelRevisionTrace;
const events = TR.buildTraceEvents(finalized, { round: 2, timestamp: '2026-10-18T00:00:00.000Z' });
line('G10 trace schema/event 数', [TR.SCHEMA, events.length]);
line('G10 run_finalized 与 issue_verdict 都在', [
  events.some((e) => e.event === 'run_finalized'),
  events.some((e) => e.event === 'issue_verdict' && e.issue_id === 'I03'),
]);
const redaction = TR.checkRedaction(events, base);
line('G10 脱敏自检（不含正文）', redaction.ok);
line('G10 事件里没有 quote/正文片段', !JSON.stringify(events).includes(base.slice(0, 24)));
line('G10 summarize', TR.summarizeTrace(events));

// ── G11：运行记录能带着 trace 存下并原样读回（刷新后仍可解释） ────────────────
await load('public/revision-run-store.js');
const RS = globalThis.NovelRevisionRunStore;
const mem = new Map();
const fakeStorage = {
  setItem: (k, v) => mem.set(k, String(v)),
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  removeItem: (k) => { mem.delete(k); },
};
const rec = RS.serialize({
  runId: 'run-1', workId: 1, chapterId: 2, baseHash: 'h1', candidateText: '候选',
  patches: [], semanticByIssue: {}, semanticRuns: 1, status: 'PARTIAL_CANDIDATE',
  rows: [{ issue_id: 'I03', final_status: 'UNRESOLVED', reason_code: 'ANCHOR_NOT_EDITED' }],
  trace: events, at: '2026-10-18T00:00:00.000Z',
});
const saved = RS.save(fakeStorage, rec);
const restored = RS.restore(RS.load(fakeStorage, 1, 2), { currentText: '原文', hashOf: () => 'h1' });
line('G11 trace 落盘并回读', [saved.ok, restored.ok, restored.trace.length]);
