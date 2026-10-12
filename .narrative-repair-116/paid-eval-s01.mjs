/**
 * 真实付费评测 · 第 2 步：S01「扫描命中只是可否决的候选」A/B（隔离实例 + 应用自身调用通道）。
 *
 * 设计（每一条都为了"可核对"而不是"看起来跑过了"）：
 *   · A/B 两侧用**同一份真实提示词**（直接来自 `public/app.js` 的 buildAIReviewPrompt），
 *     只换待审正文：GOOD=「微微」合法用法；BAD=真实的解释冗余/否定句堆叠。
 *   · 机器可核验的判据：模型对 GOOD 侧的 `微微` 不得判 confirmed；对 BAD 侧必须给出可定位引用。
 *   · 计费：逐次记录 provider 返回的 usage，并按同一单价折算，累计与 2 元预算对比。
 *   · 隔离：NOVELSTUDIO_DATA_DIR=临时目录；真实库只读复制一行凭据；端口 3738。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeIsolatedDataDir, startIsolatedServer, BASE } from './paid-eval-harness.mjs';

// DeepSeek 官方公开单价（元 / 百万 token，cache miss 输入；用于**预算护栏**而不是结论）。
// 只要护栏用的单价 ≥ 实际单价，预算就一定是保守（不会超支）的。
const PRICE_PER_M = { input: 4, output: 16 };
const BUDGET_YUAN = 2;
const yuan = (usage) => {
  const i = Number(usage && usage.prompt_tokens) || 0;
  const o = Number(usage && usage.completion_tokens) || 0;
  return (i / 1e6) * PRICE_PER_M.input + (o / 1e6) * PRICE_PER_M.output;
};

const prompts = JSON.parse(fs.readFileSync(path.resolve('.narrative-repair-116/paid-eval-prompts.json'), 'utf8'));
const cfg = makeIsolatedDataDir();
const { stop } = await startIsolatedServer(cfg.dir);

const log = { started_at: new Date().toISOString(), config_id: cfg.configId, key_sha8: cfg.keySha8,
  model: cfg.model, price_per_m: PRICE_PER_M, budget_yuan: BUDGET_YUAN, calls: [], spend_yuan: 0, assertions: [] };

async function callAI(messages, maxTokens = 6000) {
  const r = await fetch(`${BASE}/api/ai/write`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_id: cfg.configId, messages, max_tokens: maxTokens, temperature: 0.2,
      // ⚠️ 第一次实测（已留痕）：不传 effort 时默认 thinking=high，**3000 个输出 token 全被推理吃掉**
      //    （reasoning_tokens: 3000、reply_len: 0）→ 拿不到任何内容。这里降到 low，并把预算放大。
      reasoning_effort: 'low',
    }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json().catch(() => null);
  const usage = (j && j.raw && j.raw.usage) || null;
  const cost = yuan(usage);
  log.spend_yuan = Number((log.spend_yuan + cost).toFixed(6));
  const reply = String((j && j.reply) || '');
  const rec = { status: r.status, ok: !!(j && j.ok), usage, cost_yuan: Number(cost.toFixed(6)), spend_total_yuan: log.spend_yuan, reply_len: reply.length };
  log.calls.push(rec);
  log.raw_replies = log.raw_replies || [];
  log.raw_replies.push(reply.slice(0, 4000));
  if (log.spend_yuan > BUDGET_YUAN) throw new Error(`预算护栏触发：累计 ${log.spend_yuan} 元 > 授权 ${BUDGET_YUAN} 元，立即停止`);
  return { reply, meta: rec };
}

/** 从回复里取出第一个 JSON 对象（模型可能包 markdown 代码块）。 */
function parseJSONish(s) {
  const t = String(s || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced && fenced[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of candidates) { try { return JSON.parse(c); } catch (_) {} }
  return null;
}

try {
  // ── A 侧：合法语境的「微微」──
  const a = await callAI([
    { role: 'user', content: prompts.pGood },
    { role: 'user', content: '请只输出那个 JSON 对象（不要 Markdown 代码块、不要解释）。' },
  ]);
  const aJson = parseJSONish(a.reply);
  const aIssues = (aJson && Array.isArray(aJson.issues)) ? aJson.issues : [];
  const aDeferred = (aJson && Array.isArray(aJson.deferred)) ? aJson.deferred : [];
  const aGuilty = aIssues.some((x) => /微微/.test(JSON.stringify(x)));
  const aNA = JSON.stringify(aJson || {}).includes('not_applicable');
  log.A = { parsed: !!aJson, issue_count: aIssues.length, deferred_count: aDeferred.length, weiwei_in_issues: aGuilty, mentions_not_applicable: aNA, sample: aIssues.slice(0, 3) };
  log.assertions.push({ id: 'S01-A1', desc: '合法语境的「微微」未被强制报成 issue', pass: aJson ? !aGuilty : null, observed: { weiwei_in_issues: aGuilty } });
  log.assertions.push({ id: 'S01-A2', desc: '报告给出了 not_applicable 处置（命中可被否决）', pass: aJson ? aNA : null, observed: { mentions_not_applicable: aNA } });

  // ── B 侧：真实冗余/否定句堆叠 ──
  const b = await callAI([
    { role: 'user', content: prompts.pBad },
    { role: 'user', content: '请只输出那个 JSON 对象（不要 Markdown 代码块、不要解释）。' },
  ]);
  const bJson = parseJSONish(b.reply);
  const bIssues = (bJson && Array.isArray(bJson.issues)) ? bJson.issues : [];
  const bAll = JSON.stringify(bJson || {});
  const bQuoteOk = /和 (?:他|她|他)[^]{0,40}(没关系|没有关系)/.test(bAll) || bAll.includes('也没关系');
  log.B = { parsed: !!bJson, issue_count: bIssues.length, quote_present: bQuoteOk, sample: bIssues.slice(0, 3) };
  log.assertions.push({ id: 'S01-B1', desc: '真实冗余被报成 issue（不是"零命中"放过）', pass: bJson ? bIssues.length >= 1 : null, observed: { issue_count: bIssues.length } });
  log.assertions.push({ id: 'S01-B2', desc: 'issue 带可定位的原文引用', pass: bJson ? bQuoteOk : null, observed: { quote_present: bQuoteOk } });

  // ── 反向对照：同一次会话里两侧结论必须**不同**（否则说明判据无区分力） ──
  log.assertions.push({ id: 'S01-AB', desc: 'A 侧不报「微微」且 B 侧报真问题：两侧结论不同（判据有区分力）',
    pass: (aJson && bJson) ? (!aGuilty && bIssues.length >= 1) : null, observed: { a_guilty: aGuilty, b_issues: bIssues.length } });
} catch (e) {
  log.error = String(e && e.message ? e.message : e);
} finally {
  stop();
}
log.finished_at = new Date().toISOString();
fs.writeFileSync(path.resolve('.narrative-repair-116/paid-eval-s01.json'), JSON.stringify(log, null, 2));
console.log(JSON.stringify({
  model: log.model, calls: log.calls.length, spend_yuan: log.spend_yuan, budget_yuan: BUDGET_YUAN,
  A: log.A, B: log.B, assertions: log.assertions, error: log.error || null,
}, null, 2));
