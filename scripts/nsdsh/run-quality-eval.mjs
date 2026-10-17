#!/usr/bin/env node
/**
 * scripts/nsdsh/run-quality-eval.mjs —— R04-Q1：用**真实付费模型**跑质量语料（需作者显式授权）。
 *
 * ⚠️ 这是本仓库里**唯一**会真实计费的脚本。三条硬约束：
 *   ① 必须带 `--authorized-by <说明>` 才肯运行（把授权留痕在输出与元数据里）；
 *   ② 累计费用**硬上限**（默认 ¥1.50），逐次累加，超限立即停止并如实报告；
 *   ③ 绝不打印/落盘 API key；元数据里只记 key 长度与指纹前缀。
 *
 * 它产出两样东西：
 *   · `.nsdsh/quality-eval/raw/<caseId>.json` —— 每个用例的完整请求/响应/用量（本地忽略，**不入库**）
 *   · `.nsdsh/quality-eval/predictions.json` —— 交给 `score-quality.mjs` 打分的候选事实
 *
 * 用法：
 *   node scripts/nsdsh/run-quality-eval.mjs --authorized-by "作者于 2026-10-17 明确授权 6 项" \
 *        [--model deepseek-flash] [--budget-cny 1.5] [--out .nsdsh/quality-eval]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CORPUS = path.join(REPO, 'tests/quality/corpus.json');
const GOLD = path.join(REPO, 'tests/quality/gold.json');

/** 计费口径（元 / 百万 token）。用于**成本护栏**，不是账单。 */
export const PRICING_CNY_PER_MTOK = Object.freeze({
  input_cache_hit: 0.05,
  input_cache_miss: 0.5,
  output: 2.0,
});

export const TEMPORALITY_VOCAB = Object.freeze(['current', 'recalled', 'dream', 'future']);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** 从 DSH 凭据库取 key（**只读、不打印、不落盘**）。 */
export function readApiKey({ credPath = path.join(os.homedir(), '.dsh', '.credentials.yaml') } = {}) {
  const raw = fs.readFileSync(credPath, 'utf8');
  const m = raw.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/);
  if (!m) throw new Error('NO_DEEPSEEK_KEY_IN_CREDENTIAL_STORE');
  return m[1];
}

export function estimateCostCny(usage) {
  if (!usage) return 0;
  const hit = Number(usage.prompt_cache_hit_tokens) || 0;
  const miss = Number(usage.prompt_cache_miss_tokens)
    || Math.max(0, (Number(usage.prompt_tokens) || 0) - hit);
  const out = Number(usage.completion_tokens) || 0;
  return (hit / 1e6) * PRICING_CNY_PER_MTOK.input_cache_hit
    + (miss / 1e6) * PRICING_CNY_PER_MTOK.input_cache_miss
    + (out / 1e6) * PRICING_CNY_PER_MTOK.output;
}

/** 该作品的字段词表（来自 gold，属**schema** 而非答案）。 */
export function fieldVocabulary(gold, workId) {
  const set = new Set();
  for (const c of gold.cases) {
    if (c.work !== workId) continue;
    for (const e of c.expected || []) set.add(e.field);
  }
  return [...set].sort();
}

/** 构造一个用例的提示词：给实体表 + 字段词表 + 到证据章为止的正文；**不给类别、不给答案**。 */
export function buildPrompt({ corpus, gold, g, focus = false }) {
  const work = corpus.works.find((w) => w.id === g.work);
  const chapters = work.chapters;
  const firstExpected = (g.expected || [])[0];
  const targetChapter = firstExpected ? String(firstExpected.evidence.chapterId) : chapters[chapters.length - 1].id;
  const targetIndex = chapters.findIndex((c) => c.id === targetChapter);

  const lines = [];
  lines.push(`作品：${work.title}`);
  lines.push('');
  lines.push('实体表（只能使用这些 id）：');
  for (const e of work.entities) lines.push(`- ${e.id} = ${e.name}${e.aliases.length ? `（别名：${e.aliases.join('、')}）` : ''}`);
  lines.push('');
  lines.push(`可用字段词表（field 必须取自这里）：${fieldVocabulary(gold, g.work).join(', ')}`);
  lines.push('');
  lines.push('正文（按顺序）：');
  for (let i = 0; i <= (targetIndex < 0 ? chapters.length - 1 : targetIndex); i += 1) {
    const ch = chapters[i];
    const byRev = work.revisionTexts && work.revisionTexts[ch.id];
    const text = (g.revision !== undefined && byRev && byRev[String(g.revision)]) ? byRev[String(g.revision)] : ch.text;
    lines.push(`[${ch.id}] ${text}`);
  }
  lines.push('');
  if (focus) {
    const ent = work.entities.find((e) => e.id === (firstExpected && firstExpected.entityId));
    lines.push(`任务：只回答一个问题——在上面这段正文里，实体 ${firstExpected ? firstExpected.entityId : '?'}（${ent ? ent.name : '?'}）的字段 ${firstExpected ? firstExpected.field : '?'} 确立了什幺状态？`);
    lines.push('要求：');
    lines.push(`1. 只输出这一条事实（不要输出别的实体、别的字段）；对象字段为：caseId, entityId, field, prev, next, evidence{chapterId, quote}, temporality。`);
    lines.push(`2. caseId 必须原样写 "${g.id}"；entityId 写 "${firstExpected ? firstExpected.entityId : ''}"；field 写 "${firstExpected ? firstExpected.field : ''}"。`);
    lines.push('3. evidence.quote 必须是**正文里逐字出现**的片段（不改字、不省略、不拼接）。');
    lines.push(`4. temporality 只能是 ${TEMPORALITY_VOCAB.join(' / ')}。`);
    lines.push('5. 如果正文没有确立这个字段，输出 {"candidates": []}。不要解释。');
    lines.push('6. 输出必须是 JSON 对象：{"candidates": [...]}。');
    return lines.join(String.fromCharCode(10));
  }
  lines.push('任务：找出**在上面这段正文里新确立**的事实。要求：');
  lines.push('1. 每条事实一个对象，字段为：caseId, entityId, field, prev, next, evidence{chapterId, quote}, temporality。');
  lines.push(`2. caseId 必须原样写 "${g.id}"。entityId 必须是实体表里的 id。field 必须取自字段词表。`);
  lines.push('3. evidence.quote 必须是**正文里逐字出现**的片段（不改字、不省略、不拼接）。');
  lines.push(`4. temporality 只能是 ${TEMPORALITY_VOCAB.join(' / ')}：现在时=current，回忆转述=recalled，梦境=dream，尚未发生=future。`);
  lines.push('5. 只写本章确实确立的事实；不确定就不要写。不要解释，不要输出 JSON 之外的任何文字。');
  lines.push('6. 输出必须是 JSON 对象：{"candidates": [...]}；没有事实就输出 {"candidates": []}。');
  return lines.join('\n');
}

/** 从模型回复里取 JSON（容忍 ``` 围栏与前后废话）。 */
export function parseCandidates(content) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, reason: 'EMPTY_CONTENT', candidates: [] };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'NO_JSON_OBJECT', candidates: [] };
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch (e) {
    return { ok: false, reason: `JSON_PARSE_FAILED:${String((e && e.message) || e).slice(0, 80)}`, candidates: [] };
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.candidates) ? parsed.candidates : null);
  if (!list) return { ok: false, reason: 'NO_CANDIDATES_ARRAY', candidates: [] };
  return { ok: true, reason: '', candidates: list };
}

/**
 * 跑评测。**逐用例累加成本，超上限立即停止**（不静默放弃、不继续发请求）。
 */
export async function runQualityEval({
  authorizedBy,
  model = 'deepseek-flash',
  budgetCny = 1.5,
  outDir = path.join(REPO, '.nsdsh/quality-eval'),
  baseUrl = 'https://api.deepseek.com/v1/chat/completions',
  // deepseek-flash 是**推理模型**：3000 全被 reasoning 吃掉、content 为空（实测 21/25 解析失败）。
  // 这个上限必须按"推理 + 正文"两份支出来定，不能按普通模型的输出长度估。
  // deepseek-flash 的**推理入口**在这些抽取任务上会烧掉 8k–28k reasoning 字符而 content 仍为空
  //（实测 16/25 解析失败）。因此默认改用同一模型的**非推理入口** `deepseek-chat`
  //（两次探测里响应都回报 `model: deepseek-flash`），输出预算按普通模型定。
  maxTokens = 2000,
  temperature = 0,
  fetchImpl = fetch,
  apiKey = null,
  onProgress = () => {},
  focus = false,
} = {}) {
  if (!authorizedBy) throw new Error('MISSING_AUTHORIZATION_NOTE: 必须显式给出 --authorized-by');
  const key = apiKey || readApiKey();
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const gold = JSON.parse(fs.readFileSync(GOLD, 'utf8'));

  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  const predictions = [];
  const perCase = [];
  let spentCny = 0;
  let halted = null;

  for (const g of gold.cases) {
    if (spentCny >= budgetCny) { halted = `BUDGET_EXHAUSTED_AT_${spentCny.toFixed(4)}`; break; }
    const prompt = buildPrompt({ corpus, gold, g, focus });
    const t0 = Date.now();
    let httpStatus = null;
    let body = null;
    let content = '';
    let usage = null;
    let error = '';
    try {
      const res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature,
          response_format: { type: 'json_object' },
        }),
      });
      httpStatus = res.status;
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = { unparsed: text.slice(0, 2000) }; }
      content = body && body.choices && body.choices[0] && body.choices[0].message
        ? String(body.choices[0].message.content || '')
        : '';
      usage = (body && body.usage) || null;
      if (!res.ok) error = `HTTP_${res.status}`;
    } catch (e) {
      error = `NETWORK:${String((e && e.message) || e).slice(0, 120)}`;
    }
    const ms = Date.now() - t0;
    const cost = estimateCostCny(usage);
    spentCny += cost;

    const parsed = error ? { ok: false, reason: error, candidates: [] } : parseCandidates(content);
    const cleaned = parsed.candidates
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        caseId: g.id, workId: g.work,
        entityId: c.entityId, field: c.field,
        prev: c.prev === undefined ? null : c.prev,
        next: c.next === undefined ? null : c.next,
        evidence: c.evidence || null,
        temporality: c.temporality,
        ...(g.revision === undefined ? {} : { revision: g.revision }),
        applied: false,
      }));

    // 用户授权"保存所有元数据"：原始请求/响应/用量逐条落盘（本地忽略目录，不入库）
    fs.writeFileSync(path.join(outDir, 'raw', `${g.id}.json`), JSON.stringify({
      caseId: g.id, model, baseUrl, httpStatus, ms,
      authorizedBy,
      keyFingerprint: { length: key.length, prefix: `${key.slice(0, 6)}…` },
      request: { promptChars: prompt.length, maxTokens, temperature },
      usage, costCny: cost,
      parse: { ok: parsed.ok, reason: parsed.reason, rawCandidates: parsed.candidates.length },
      response: body,
    }, null, 2) + '\n');

    predictions.push(...cleaned);
    perCase.push({
      caseId: g.id, category: g.category, httpStatus, ms,
      candidates: cleaned.length, parseOk: parsed.ok, parseReason: parsed.reason,
      usage, costCny: Number(cost.toFixed(6)),
    });
    onProgress({ caseId: g.id, spentCny, candidates: cleaned.length });

    if (!parsed.ok) { /* 结构不合法会由评分器算进 rate；这里只记录 */ }
  }

  const predictionsPath = path.join(outDir, 'predictions.json');
  fs.writeFileSync(predictionsPath, JSON.stringify(predictions, null, 2) + '\n');

  const summary = {
    version: 'quality-eval-v1',
    mode: focus ? 'focused' : 'open-ended',
    model, baseUrl, authorizedBy,
    cases: perCase.length,
    candidates: predictions.length,
    spentCny: Number(spentCny.toFixed(6)),
    budgetCny,
    halted,
    parseFailures: perCase.filter((c) => !c.parseOk).length,
    totalPromptTokens: perCase.reduce((a, c) => a + (Number(c.usage && c.usage.prompt_tokens) || 0), 0),
    totalCompletionTokens: perCase.reduce((a, c) => a + (Number(c.usage && c.usage.completion_tokens) || 0), 0),
    perCase,
    predictionsPath,
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

function isDirectRun() {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isDirectRun()) {
  const authorizedBy = arg('--authorized-by');
  if (!authorizedBy) {
    console.error('用法：node scripts/nsdsh/run-quality-eval.mjs --authorized-by "<授权说明>" [--model deepseek-flash] [--budget-cny 1.5]');
    console.error('⚠️ 这会真实计费。没有作者的显式授权不得运行。');
    process.exit(2);
  }
  const model = arg('--model', 'deepseek-flash');
  const budget = Number(arg('--budget-cny', '1.5'));
  const focus = process.argv.includes('--focus');
  const outDir = path.resolve(arg('--out', path.join(REPO, focus ? '.nsdsh/quality-eval-focused' : '.nsdsh/quality-eval')));
  console.log(`R04-Q1 真实模型质量评测（模型 ${model}；模式 ${focus ? '定向（只问目标实体+字段）' : '开放式（列出本章新确立的事实）'}；费用上限 ¥${budget}）`);
  console.log(`  授权依据：${authorizedBy}`);
  const r = await runQualityEval({
    authorizedBy, model, budgetCny: budget, outDir, focus,
    onProgress: ({ caseId, spentCny, candidates }) => {
      console.log(`  ${caseId}：候选 ${candidates} 条（累计 ¥${spentCny.toFixed(4)}）`);
    },
  });
  console.log('');
  console.log(`  用例 ${r.cases} / 候选 ${r.candidates} / 解析失败 ${r.parseFailures}`);
  console.log(`  token：入 ${r.totalPromptTokens} / 出 ${r.totalCompletionTokens}`);
  console.log(`  费用（按护栏价目估算）：¥${r.spentCny} / 上限 ¥${r.budgetCny}${r.halted ? ` —— ${r.halted}` : ''}`);
  console.log(`  产物：${r.predictionsPath}`);
  process.exit(r.halted ? 1 : 0);
}
