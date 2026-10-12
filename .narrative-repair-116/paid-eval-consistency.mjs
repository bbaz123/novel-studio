/**
 * 真实付费评测 · 第 4 步：报告自洽性检测（E01 §5.2）的**真实模型对照**。
 *
 * 要回答的问题：checkReportConsistency 抓的那种矛盾（优点用绝对措辞宣称"已不存在"，问题却仍指向同一处），
 * **真实模型会不会犯**？如果它从不犯，那这个检测器就是空转；如果它会犯，检测器就有真实价值。
 *
 * 两个自然样本（不给模型任何"要写矛盾"的暗示）：
 *   DOC1：第二场 A 级流程**完整重复**了第一场 → 看模型会不会一边夸"后续不再完整演示"一边报"重复"。
 *   DOC2：正文里**确实有**解释句（"他从小就觉得…"）→ 看模型会不会夸"伏笔完全没有解释"。
 *
 * 计费：逐次记录 usage；2 元护栏在每次调用后校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeIsolatedDataDir, startIsolatedServer, BASE } from './paid-eval-harness.mjs';
import { structureReviewReport } from '../ai/editing/narrative-review.mjs';

const PRICE_PER_M = { input: 4, output: 16 };
const BUDGET_YUAN = 2;
const yuan = (u) => ((Number(u && u.prompt_tokens) || 0) / 1e6) * PRICE_PER_M.input
  + ((Number(u && u.completion_tokens) || 0) / 1e6) * PRICE_PER_M.output;

function parseJSONish(s) {
  const t = String(s || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cands = [fenced && fenced[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of cands) { try { return JSON.parse(c); } catch (_) {} }
  return null;
}

const DOC1 = '0001号上台，右手按住石板，金红色从边缘爬到中心，光柱拔起顶到穹顶，播报念出结果，石板收回，全程持续了约两秒。\n\n'
  + '0372号上台，右手按住石板，金红色从边缘爬到中心，光柱拔起顶到穹顶，播报念出结果，石板收回，全程也持续了约两秒。';
const DOC2 = '那个女生没有看镜头，只低下头，把右手的袖口往左手心里拢了拢。掌心朝上，她看了很久。\n\n'
  + '他从小就觉得，人拿到一样东西时手会先紧一下，然后才会慢慢松开。这一点他早就知道。';

const prompt1 = '你是严格的中文网络小说审稿编辑。请审读下面这篇章节正文，输出 JSON 对象（不要 Markdown 代码块）：\n'
  + '{"summary":"总评（两三句）","issues":[{"text":"问题描述，含位置与理由"}],"deferred":[{"text":"待核验疑点"}],"strengths":[{"text":"写得好的地方"}]}\n'
  + 'issues 覆盖：剧情逻辑/人物言行/AI 腔与模板句/节奏与钩子/篇幅；strengths 1-3 条。\n\n【待审正文】\n' + DOC1 + '\n\n只输出 JSON。';
const prompt2 = prompt1.replace(DOC1, DOC2);

const cfg = makeIsolatedDataDir();
const { stop } = await startIsolatedServer(cfg.dir);
const log = { started_at: new Date().toISOString(), model: cfg.model, key_sha8: cfg.keySha8, price_per_m: PRICE_PER_M, budget_yuan: BUDGET_YUAN, calls: [], spend_yuan: 0, results: [] };

async function callAI(content, maxTokens = 6000) {
  const r = await fetch(`${BASE}/api/ai/write`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: cfg.configId, messages: [{ role: 'user', content }], max_tokens: maxTokens, temperature: 0.2, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json().catch(() => null);
  const u = (j && j.raw && j.raw.usage) || null;
  const cost = Number(yuan(u).toFixed(6));
  log.spend_yuan = Number((log.spend_yuan + cost).toFixed(6));
  log.calls.push({ status: r.status, usage: u, cost_yuan: cost, spend_total_yuan: log.spend_yuan });
  if (log.spend_yuan > BUDGET_YUAN) throw new Error(`预算护栏触发：累计 ${log.spend_yuan} > ${BUDGET_YUAN}`);
  return String((j && j.reply) || '');
}

try {
  for (const [name, doc, prompt] of [['DOC1_重复流程', DOC1, prompt1], ['DOC2_有解释句', DOC2, prompt2]]) {
    const reply = await callAI(prompt);
    const parsed = parseJSONish(reply);
    const report = parsed || {};
    // 用**真实实现**（不是另写一份判据）检验模型输出是否自相矛盾
    const consistency = structureReviewReport(report, { text: doc }).consistency;
    log.results.push({
      name,
      parsed: !!parsed,
      strengths: (report.strengths || []).map((s) => String((s && s.text) || s).slice(0, 90)),
      issues: (report.issues || []).map((s) => String((s && s.text) || s).slice(0, 90)),
      consistency_status: consistency ? consistency.status : null,
      consistency_conflicts: consistency ? consistency.conflicts.map((c) => ({ type: c.type, strength: String(c.strength).slice(0, 70), reason: String(c.reason).slice(0, 80) })) : [],
    });
  }
} catch (e) {
  log.error = String((e && e.message) || e);
} finally { stop(); }

log.finished_at = new Date().toISOString();
const out = {
  spend_yuan: log.spend_yuan, budget_yuan: BUDGET_YUAN, calls: log.calls,
  results: log.results,
  // 结论口径：只要有任一真实样本触发 needs_calibration，就说明"模型确实会写出互相否认的绝对断言"，
  // 即该检测器有真实价值；若都是 ok，则如实记为"本次两例未触发"，不能宣称普遍不存在。
  any_real_contradiction: log.results.some((r) => r.consistency_status === 'needs_calibration'),
  error: log.error || null,
};
fs.writeFileSync(path.resolve('.narrative-repair-116/paid-eval-consistency.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
