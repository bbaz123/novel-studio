#!/usr/bin/env node
/**
 * scripts/nsdsh/score-quality.mjs —— R04-Q0：零计费质量评分程序（不调用任何模型）。
 *
 * 它回答的是：**给定一批候选事实，它们到底错到什么程度？**
 * 而"候选从哪来"是两类完全不同的来源：
 *
 *   · `--fixture`（默认）—— 用 gold 自己当候选跑一遍。它证明**评分器本身工作**
 *     （能算分、能过 schema、能定位引文），**不证明模型质量**。
 *   · `--predictions <file>` —— 真实模型输出（Q1，需要作者显式授权）。
 *     本文件不发起任何模型调用，只对**已有**的预测打分。
 *
 * 指标刻意分开报告（方案 §6.2）：结构覆盖 / 事实质量 / 时态安全 / 重复与成本。
 * 不用"文本相似度"当质量：实体 ID、字段、前后值、引文位置都是**可判定**的事实。
 *
 * 用法：
 *   node scripts/nsdsh/score-quality.mjs                       # 自检（gold 当候选）
 *   node scripts/nsdsh/score-quality.mjs --predictions p.json  # 给真实输出打分
 *   node scripts/nsdsh/score-quality.mjs --json
 *
 * 退出码：0 = 结构/证据/时态等**门禁项**全过；1 = 有阻断项（跨作品越界、未确认写入正式状态、
 *         未来信息当现状、严重实体错配）或结构不合格。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CORPUS_PATH = path.join(REPO, 'tests/quality/corpus.json');
const GOLD_PATH = path.join(REPO, 'tests/quality/gold.json');

/** 汇总指标的门禁阈值（写死在代码里，避免"调阈值凑绿"）。 */
export const THRESHOLDS = Object.freeze({
  minSchemaValidRate: 1.0,       // 结构必须 100% 可解析：解析不了就不是候选
  // 证据必须 **100%** 可定位：定位不到引文的候选不是"证据"，只是一句话。
  // （曾经想过 0.95 —— 那意味着 100 条里可以有 5 条无法核对就进入正式状态。）
  minEvidenceLocatableRate: 1.0,
  maxSevereErrors: 0,            // 零容忍
  maxFutureLeakage: 0,           // 零容忍
  maxCrossWorkLeakage: 0,        // 零容忍
  maxUnconfirmedCanonWrites: 0,  // 零容忍
});

export const REQUIRED_CANDIDATE_FIELDS = Object.freeze(['entityId', 'field', 'next', 'evidence']);

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** 建 `workId → { chapters: Map(id → text), entities: Map(id → name) }`。 */
export function indexCorpus(corpus) {
  const works = new Map();
  for (const w of corpus.works) {
    works.set(w.id, {
      title: w.title,
      chapters: new Map(w.chapters.map((c) => [c.id, c.text])),
      // 修订正文：revision → { chapterId → text }。评分时按候选自带的 revision 取正文，
      // 否则"修订 2 的引文"会在原稿里查不到，被误判成引文不可定位。
      revisionTexts: new Map(Object.entries(w.revisionTexts || {})
        .map(([chapterId, byRev]) => [String(chapterId), new Map(Object.entries(byRev).map(([rev, text]) => [String(rev), String(text)]))])),
      chapterIndex: new Map(w.chapters.map((c) => [c.id, c.index])),
      entities: new Map(w.entities.map((e) => [e.id, e])),
    });
  }
  return works;
}

/**
 * 结构覆盖：每条候选的必填字段是否齐全且类型正确。
 * @returns `{ valid, invalid, rate }`
 */
export function checkStructure(candidates) {
  const invalid = [];
  for (const c of candidates) {
    // next 允许显式 null（= 该状态被清空，例如"既往不咎"），但**键必须存在**；
    // 把 null 当"缺失"会把"清空状态"这类合法事实误判成结构错误（第一版就是这么错的）。
    const missing = REQUIRED_CANDIDATE_FIELDS.filter((f) => c == null || !(f in c) || c[f] === undefined);
    const badEvidence = c && c.evidence && (typeof c.evidence.chapterId !== 'string' || typeof c.evidence.quote !== 'string');
    if (missing.length || badEvidence) invalid.push({ candidate: c, missing, badEvidence: Boolean(badEvidence) });
  }
  const total = candidates.length || 1;
  return { valid: candidates.length - invalid.length, invalid, rate: (candidates.length - invalid.length) / total };
}

/** 引文可定位：quote 必须逐字出现在被引章节正文里（含全角/半角标点差异的严格比较）。 */
export function checkEvidence(candidates, works) {
  const notFound = [];
  for (const c of candidates) {
    const work = works.get(String(c.workId || ''));
    if (!work) { notFound.push({ candidate: c, reason: 'UNKNOWN_WORK' }); continue; }
    const chapterId = String(c.evidence && c.evidence.chapterId);
    const byRev = work.revisionTexts.get(chapterId);
    const rev = c.revision === undefined ? null : String(c.revision);
    const text = (rev !== null && byRev && byRev.has(rev)) ? byRev.get(rev) : work.chapters.get(chapterId);
    if (text === undefined) { notFound.push({ candidate: c, reason: 'UNKNOWN_CHAPTER' }); continue; }
    const quote = String(c.evidence.quote || '');
    if (!quote || !text.includes(quote)) notFound.push({ candidate: c, reason: 'QUOTE_NOT_FOUND', quote });
  }
  const total = candidates.length || 1;
  return { located: candidates.length - notFound.length, notFound, rate: (candidates.length - notFound.length) / total };
}

/**
 * 事实质量：以 `entityId + field + next` 三元组为判据的 precision / recall。
 * `prev` 与 `severityIfWrong` 参与"严重误判"的额外判定，但不参与匹配。
 */
export function scoreFacts(candidates, goldCases) {
  const goldSet = new Map();
  for (const g of goldCases) {
    for (const e of g.expected || []) {
      goldSet.set(`${g.id}|${e.entityId}|${e.field}|${JSON.stringify(e.next)}`, { gold: g, entry: e });
    }
  }
  let tp = 0;
  const fp = [];
  for (const c of candidates) {
    const key = `${c.caseId}|${c.entityId}|${c.field}|${JSON.stringify(c.next)}`;
    if (goldSet.has(key)) { tp += 1; goldSet.delete(key); } else fp.push(c);
  }
  const fn = [...goldSet.values()].map((x) => ({ caseId: x.gold.id, entityId: x.entry.entityId, field: x.entry.field, next: x.entry.next }));
  const precision = candidates.length ? tp / candidates.length : 0;
  const recall = (tp + fn.length) ? tp / (tp + fn.length) : 0;
  return { tp, fp, fn, precision, recall };
}

/**
 * 零容忍项：跨作品越界 / 未确认写入正式状态 / 未来信息当现状 / 严重实体错配。
 * 这些不参与"平均分"，出现即阻断。
 */
export function checkSafety(candidates, goldCases, works) {
  const violations = [];
  const offTarget = [];
  const goldByCase = new Map(goldCases.map((g) => [g.id, g]));
  for (const c of candidates) {
    const g = goldByCase.get(String(c.caseId));
    // ① 跨作品：候选声明的 workId 与用例所属作品不一致
    if (g && c.workId && String(c.workId) !== String(g.work)) {
      violations.push({ kind: 'CROSS_WORK_LEAKAGE', caseId: c.caseId, detail: `${c.workId} ≠ ${g.work}` });
    }
    // ② 未来信息当现状（泄漏方向只有一个：**未发生的事被写成现状**）
    //
    // 第一版极性写反了：它把"用例属于现在时、而模型把某条事实标成 future"当成违规。
    // 但那恰恰是**正确**行为（"我明日要去北关" 里的"北关"确实还没到）。
    // 正确的判据只能是：用例本身考的是 future（尚未发生），而候选把它标成 current。
    if (g && String(g.temporality) === 'future' && String(c.temporality || 'current') === 'current') {
      violations.push({ kind: 'FUTURE_AS_CURRENT', caseId: c.caseId });
    }
    // ③ 未确认就写正式状态
    if (c.applied === true && c.approvalId !== undefined && String(c.approvalId || '') === '') {
      violations.push({ kind: 'UNCONFIRMED_CANON_WRITE', caseId: c.caseId });
    }
    if (c.applied === true && c.approvalId === undefined) {
      violations.push({ kind: 'UNCONFIRMED_CANON_WRITE', caseId: c.caseId });
    }
    // ④ 严重实体错配：用例本身标了 severe，且候选实体不在本作品的实体表里
    if (g) {
      const work = works.get(String(g.work));
      const known = work && work.entities.has(String(c.entityId));
      if (!known) violations.push({ kind: 'UNKNOWN_ENTITY', caseId: c.caseId, detail: String(c.entityId) });
      // "不是 gold 指的那一个实体" **不是**严重错配 —— 那只是"这条候选对应别的事实"。
      // 第一版把 92 条候选里的 40 条判成严重错配，几乎全是这类；
      // 它反映的是 gold 只标了**一条**目标事实，而任务允许多条，不是模型召回错了实体。
      // 真正的严重错配只有一种：作品实体表里根本没有这个 id。
      const allowed = new Set((g.expected || []).map((e) => e.entityId));
      if (allowed.size > 0 && !allowed.has(String(c.entityId))) offTarget.push({ caseId: c.caseId, entityId: String(c.entityId) });
    }
  }
  return {
    violations,
    offTarget,
    severeErrors: violations.filter((v) => v.kind === 'UNKNOWN_ENTITY').length,
    offTarget: offTarget.length,
    futureLeakage: violations.filter((v) => v.kind === 'FUTURE_AS_CURRENT').length,
    crossWorkLeakage: violations.filter((v) => v.kind === 'CROSS_WORK_LEAKAGE').length,
    unconfirmedCanonWrites: violations.filter((v) => v.kind === 'UNCONFIRMED_CANON_WRITE').length,
  };
}

/**
 * 重复与成本：**不调用模型**，只做"同一输入多次输出的方差"与 token/费用占位。
 * 没有多轮输出时如实返回 `null` 而不是 0（"没测"与"零方差"是两件事）。
 */
export function checkRepeatability(runs) {
  if (!Array.isArray(runs) || runs.length < 2) return { available: false, detail: '只有一轮输出，方差未知（不是零方差）' };
  const keys = runs.map((r) => r.map((c) => `${c.caseId}|${c.entityId}|${c.field}|${JSON.stringify(c.next)}`).sort().join(';'));
  const agree = keys.every((k) => k === keys[0]);
  return { available: true, runs: runs.length, identical: agree, disagreement: agree ? 0 : 1 };
}

/** 完整评分。 */
export function scoreQuality({ corpus, gold, predictions = null }) {
  const works = indexCorpus(corpus);
  const goldCases = gold.cases;

  // 候选来源：真实预测，或"gold 自己当候选"（自检）
  const candidates = predictions
    ? predictions.map((p) => ({ ...p }))
    : goldCases.flatMap((g) => (g.expected || []).map((e) => ({
      caseId: g.id, workId: g.work, entityId: e.entityId, field: e.field,
      prev: e.prev, next: e.next, evidence: e.evidence,
      temporality: e.boundary || g.temporality || 'current',
      ...(g.revision === undefined ? {} : { revision: g.revision }),
      applied: false,
    })));

  const structure = checkStructure(candidates);
  const evidence = checkEvidence(candidates, works);
  const facts = scoreFacts(candidates, goldCases);
  const safety = checkSafety(candidates, goldCases, works);

  const blocked = safety.severeErrors > THRESHOLDS.maxSevereErrors
    || safety.futureLeakage > THRESHOLDS.maxFutureLeakage
    || safety.crossWorkLeakage > THRESHOLDS.maxCrossWorkLeakage
    || safety.unconfirmedCanonWrites > THRESHOLDS.maxUnconfirmedCanonWrites
    || structure.rate < THRESHOLDS.minSchemaValidRate
    || evidence.rate < THRESHOLDS.minEvidenceLocatableRate;

  return {
    version: 'score-quality-v1',
    source: predictions ? 'predictions' : 'fixture(gold-as-candidates)',
    ok: !blocked,
    // ① 结构与覆盖
    structure: {
      candidates: candidates.length,
      valid: structure.valid,
      rate: Number(structure.rate.toFixed(4)),
      invalid: structure.invalid.slice(0, 5),
      threshold: THRESHOLDS.minSchemaValidRate,
    },
    evidence: {
      located: evidence.located,
      rate: Number(evidence.rate.toFixed(4)),
      notFound: evidence.notFound.slice(0, 5),
      threshold: THRESHOLDS.minEvidenceLocatableRate,
    },
    // ② 事实质量
    facts: {
      tp: facts.tp,
      fp: facts.fp.length,
      fn: facts.fn.length,
      precision: Number(facts.precision.toFixed(4)),
      recall: Number(facts.recall.toFixed(4)),
      falsePositives: facts.fp.slice(0, 5).map((c) => `${c.caseId}:${c.entityId}.${c.field}`),
      falseNegatives: facts.fn.slice(0, 5).map((c) => `${c.caseId}:${c.entityId}.${c.field}`),
    },
    // ③ 时态安全（零容忍）
    safety: {
      severeErrors: safety.severeErrors,
      futureLeakage: safety.futureLeakage,
      crossWorkLeakage: safety.crossWorkLeakage,
      unconfirmedCanonWrites: safety.unconfirmedCanonWrites,
      offTarget: safety.offTarget,
      violations: safety.violations.slice(0, 8),
    },
    // ④ 重复与成本（Q1 才可能有值）
    repeatability: checkRepeatability(null),
    cost: { real_provider_calls: 0, billed_amount_cny: 0, note: '评分程序本身不调用任何模型' },
    generated_at: new Date().toISOString(),
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function isDirectRun() {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isDirectRun()) {
  const corpus = readJson(CORPUS_PATH);
  const gold = readJson(GOLD_PATH);
  const predPath = arg('--predictions');
  const predictions = predPath ? readJson(path.resolve(predPath)) : null;
  const r = scoreQuality({ corpus, gold, predictions });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`质量评分（来源：${r.source}）`);
    console.log(`  结构：${r.structure.valid}/${r.structure.candidates} 合格（rate=${r.structure.rate}，阈值 ${r.structure.threshold}）`);
    console.log(`  证据：${r.evidence.located} 条引文可定位（rate=${r.evidence.rate}，阈值 ${r.evidence.threshold}）`);
    console.log(`  事实：precision=${r.facts.precision} recall=${r.facts.recall}（tp=${r.facts.tp} fp=${r.facts.fp} fn=${r.facts.fn}）`);
    console.log(`  安全：未知实体=${r.safety.severeErrors} 未来泄漏=${r.safety.futureLeakage} 跨作品=${r.safety.crossWorkLeakage} 未确认写入=${r.safety.unconfirmedCanonWrites}`);
    console.log(`  非目标实体候选（不算错，仅统计）：${r.safety.offTarget}`);
    console.log(`  重复：${r.repeatability.available ? `identical=${r.repeatability.identical}` : r.repeatability.detail}`);
    console.log(`  费用：${r.cost.real_provider_calls} 次真实调用 / ¥${r.cost.billed_amount_cny}`);
    console.log(r.ok ? '  门禁：通过' : '  门禁：阻断（见 safety 与结构/证据阈值）');
    for (const v of r.safety.violations) console.log(`    ✗ ${v.kind} ${v.caseId} ${v.detail || ''}`);
  }
  process.exit(r.ok ? 0 : 1);
}
