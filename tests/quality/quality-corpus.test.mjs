/**
 * tests/quality/quality-corpus.test.mjs —— R04-Q0：质量语料与评分器的**自我校验**。
 *
 * 一套评分器最容易犯的错不是算错分，而是**永远给满分**：
 * 只要它没能力把错误认出来，"质量达标"就只是它自己的回声。
 * 所以本套件的重心在**负向对照**：往预测里塞入真实会犯的错（实体错配、引文缺失、
 * 跨作品越界、未确认写正式状态、未来信息当现状），逐一断言评分器**必须报出来**。
 *
 * 零计费：本套件不发起任何模型调用（评分器只对已有预测打分）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const Q = await import('../../scripts/nsdsh/score-quality.mjs');

const corpus = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/quality/corpus.json'), 'utf8'));
const gold = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/quality/gold.json'), 'utf8'));

/** 由 gold 生成"完美预测"（自检基线）。 */
function perfectPredictions() {
  return gold.cases.flatMap((g) => (g.expected || []).map((e) => ({
    caseId: g.id, workId: g.work, entityId: e.entityId, field: e.field,
    prev: e.prev, next: e.next, evidence: e.evidence,
    temporality: e.boundary || g.temporality || 'current',
    ...(g.revision === undefined ? {} : { revision: g.revision }),
    applied: false,
  })));
}

await suiteAsync('quality/quality-corpus', [
  ['R04Q0-1 语料规模与类别覆盖：25 条用例、12 个类别全覆盖、两个作品', async () => {
    assert.equal(gold.cases.length, 25, `用例数应为 25，实际 ${gold.cases.length}`);
    const covered = new Set(gold.cases.map((c) => c.category));
    for (const cat of corpus.categories) assert.ok(covered.has(cat), `类别 ${cat} 没有对应用例`);
    assert.equal(covered.size, corpus.categories.length);
    assert.equal(corpus.works.length, 2);
    // 每类至少一条
    const counts = {};
    for (const c of gold.cases) counts[c.category] = (counts[c.category] || 0) + 1;
    for (const [cat, n] of Object.entries(counts)) assert.ok(n >= 2, `${cat} 至少 2 条，实际 ${n}`);
  }],

  ['R04Q0-2 语料不含私人正文：无路径、无邮箱、无长段真实文本标记', async () => {
    const raw = fs.readFileSync(path.join(REPO, 'tests/quality/corpus.json'), 'utf8')
      + fs.readFileSync(path.join(REPO, 'tests/quality/gold.json'), 'utf8');
    for (const bad of [/C:\\\\Users/i, /[A-Za-z]:\\\\/, /@[a-z0-9-]+\.(com|cn)/i, /sk-[A-Za-z0-9]{8,}/]) {
      assert.ok(!bad.test(raw), `语料不得包含 ${bad}`);
    }
    // 合成标记：每个作品的标题必须带「合成样本」
    for (const w of corpus.works) assert.match(w.title, /合成样本/, '作品标题必须标明是合成样本');
  }],

  ['R04Q0-3 每条 gold 的实体与引文都真实存在于语料（标注自洽）', async () => {
    const works = Q.indexCorpus(corpus);
    const problems = [];
    for (const g of gold.cases) {
      const w = works.get(g.work);
      assert.ok(w, `用例 ${g.id} 指向不存在的作品 ${g.work}`);
      for (const e of g.expected || []) {
        if (!w.entities.has(e.entityId)) problems.push(`${g.id}: 未知实体 ${e.entityId}`);
        const byRev = w.revisionTexts.get(String(e.evidence.chapterId));
        const rev = g.revision === undefined ? null : String(g.revision);
        const text = (rev !== null && byRev && byRev.has(rev)) ? byRev.get(rev) : w.chapters.get(String(e.evidence.chapterId));
        if (text === undefined) { problems.push(`${g.id}: 未知章节 ${e.evidence.chapterId}`); continue; }
        if (!text.includes(String(e.evidence.quote))) problems.push(`${g.id}: 引文不在正文里「${e.evidence.quote}」`);
      }
    }
    assert.deepEqual(problems, []);
  }],

  ['R04Q0-4 自检基线：gold 当候选 → 结构/证据 100%，precision=recall=1，零违规', async () => {
    const r = Q.scoreQuality({ corpus, gold });
    assert.equal(r.ok, true, JSON.stringify(r.safety));
    assert.equal(r.structure.rate, 1);
    assert.equal(r.evidence.rate, 1);
    assert.equal(r.facts.precision, 1);
    assert.equal(r.facts.recall, 1);
    assert.equal(r.safety.severeErrors, 0);
    assert.equal(r.cost.real_provider_calls, 0, '评分器不得调用模型');
  }],

  ['R04Q0-5 负向对照①：未知实体必须被判为严重误判（不能静默给分）', async () => {
    const preds = perfectPredictions();
    preds[0] = { ...preds[0], entityId: 'E_NOT_EXIST' };
    const r = Q.scoreQuality({ corpus, gold, predictions: preds });
    assert.equal(r.ok, false, '有未知实体时门禁必须阻断');
    assert.ok(r.safety.severeErrors >= 1);
    assert.ok(r.safety.violations.some((v) => v.kind === 'UNKNOWN_ENTITY' || v.kind === 'SEVERE_ENTITY_MISMATCH'));
  }],

  ['R04Q0-6 负向对照②：引文查不到 → 证据率下降且门禁阻断', async () => {
    const preds = perfectPredictions();
    preds[0] = { ...preds[0], evidence: { ...preds[0].evidence, quote: '这句正文里根本没有' } };
    const r = Q.scoreQuality({ corpus, gold, predictions: preds });
    assert.ok(r.evidence.rate < 1);
    assert.ok(r.evidence.notFound.length >= 1);
    assert.equal(r.evidence.notFound[0].reason, 'QUOTE_NOT_FOUND');
    assert.equal(r.ok, false);
  }],

  ['R04Q0-7 负向对照③：缺字段 → 结构不合格（键缺失与"显式清空"必须区分）', async () => {
    const preds = perfectPredictions();
    delete preds[0].field;
    const r = Q.scoreQuality({ corpus, gold, predictions: preds });
    assert.ok(r.structure.rate < 1);
    assert.equal(r.ok, false);
    // 反过来：next:null 是"显式清空"，必须仍然算结构合格
    const cleared = perfectPredictions().map((p) => ({ ...p, next: null }));
    assert.equal(Q.checkStructure(cleared).rate, 1, 'next:null 是合法语义，不能被判成缺字段');
  }],

  ['R04Q0-8 负向对照④：跨作品越界 / 未确认写正式状态 / 未来信息当现状 → 零容忍', async () => {
    const base = perfectPredictions();
    const cross = base.map((p, i) => (i === 0 ? { ...p, workId: p.workId === 'W1' ? 'W2' : 'W1' } : p));
    const r1 = Q.scoreQuality({ corpus, gold, predictions: cross });
    assert.ok(r1.safety.crossWorkLeakage >= 1, '跨作品必须被抓到');

    const unapproved = base.map((p, i) => (i === 0 ? { ...p, applied: true } : p));
    const r2 = Q.scoreQuality({ corpus, gold, predictions: unapproved });
    assert.ok(r2.safety.unconfirmedCanonWrites >= 1, '未确认写入必须被抓到');
    assert.equal(r2.ok, false);

    const futur = base.map((p, i) => (i === 0 ? { ...p, temporality: 'future' } : p));
    const r3 = Q.scoreQuality({ corpus, gold, predictions: futur });
    assert.ok(r3.safety.futureLeakage >= 1, '未来信息当现状必须被抓到');
    assert.equal(r3.ok, false);
  }],

  ['R04Q0-9 负向对照⑤：抽错事实 → precision/recall 必须下降（不能靠"差不多"给分）', async () => {
    const preds = perfectPredictions();
    preds[0] = { ...preds[0], next: '完全不同的值' };
    const r = Q.scoreQuality({ corpus, gold, predictions: preds });
    assert.ok(r.facts.precision < 1, `precision 应下降，实际 ${r.facts.precision}`);
    assert.ok(r.facts.recall < 1, `recall 应下降，实际 ${r.facts.recall}`);
    assert.ok(r.facts.fp >= 1 && r.facts.fn >= 1);
  }],

  ['R04Q0-10 重复性：只有一轮时如实报"未知"，两轮一致/不一致都要能分辨', async () => {
    const one = Q.checkRepeatability(null);
    assert.equal(one.available, false);
    assert.match(one.detail, /未知/);
    const a = [{ caseId: 'Q01', entityId: 'E1', field: 'plan', next: 'x' }];
    const b = [{ caseId: 'Q01', entityId: 'E1', field: 'plan', next: 'x' }];
    const c = [{ caseId: 'Q01', entityId: 'E1', field: 'plan', next: 'y' }];
    assert.equal(Q.checkRepeatability([a, b]).identical, true);
    assert.equal(Q.checkRepeatability([a, c]).identical, false);
  }],

  ['R04Q0-11 零计费：评分器不做网络调用、不读 API key', async () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/score-quality.mjs'), 'utf8');
    for (const bad of ['fetch(', 'http.request', 'https.request', 'DEEPSEEK_API_KEY', 'api.deepseek.com']) {
      assert.ok(!src.includes(bad), `评分器不得包含 ${bad}`);
    }
    assert.match(src, /real_provider_calls: 0/);
  }],

  ['R04Q0-12 Q1 门槛写死在代码里（防止"调阈值凑绿"）', async () => {
    assert.equal(Q.THRESHOLDS.maxSevereErrors, 0);
    assert.equal(Q.THRESHOLDS.maxFutureLeakage, 0);
    assert.equal(Q.THRESHOLDS.maxCrossWorkLeakage, 0);
    assert.equal(Q.THRESHOLDS.maxUnconfirmedCanonWrites, 0);
    assert.equal(Q.THRESHOLDS.minSchemaValidRate, 1);
    assert.equal(Q.THRESHOLDS.minEvidenceLocatableRate, 1, '证据必须 100% 可定位：定位不到引文的候选不是证据');
  }],
]);
