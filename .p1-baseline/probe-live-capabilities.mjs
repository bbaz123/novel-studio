#!/usr/bin/env node
/**
 * probe-live-capabilities.mjs —— 手动触发的**有限预算**真实模型验收（对应任务书 §17.4）。
 *
 * 为什么需要：离线测试只能证明「请求被正确构造」；本探针用**真实 DeepSeek** 验证六类能力
 * （三档编辑 / 语义审稿 / 样文分析 / 剧情推演 / 契约建议 / 导入抽取）确实有真实结果。
 * 它**不进 CI**（CI 永远零计费），只在作者显式授权预算后手动运行。
 *
 * 本次预算依据：用户 2026-09-27 显式授权「给予预算2元以内」。
 * 预先记录的硬上限（超限立即中止，不再发起新调用）：
 *   · 调用次数 ≤ 8（含连接自检 1 次）
 *   · 单次 max_tokens ≤ 512；输出总量 ≤ 30000 tokens；总 tokens ≤ 120000
 *   · 单次超时 120s；重试 0 次（网络错误也不重试，宁可少测不多花）
 *   · 保守费用估算上限 ≈ ¥0.5（输入按 ¥2/百万、输出按 ¥8/百万的上限单价），仍 ≤ 授权 ¥2
 *
 * 隔离：密钥只从真实库 api_configs **只读**读出，只放内存、只放进发往隔离实例的请求体；
 * 日志与证据文件只记「长度 + 掩码」，不含密钥。所有写入发生在临时数据目录。
 * 隔离实例关闭 OV（NOVELSTUDIO_OV_DISABLED=1），不触碰真实作品/真实 OV namespace。
 *
 * 用法: node .p1-baseline/probe-live-capabilities.mjs [--dry]
 *   --dry 只打印计划与上限、不发起任何付费调用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const NL = String.fromCharCode(10);

// ── 预算闸门（任何一项触顶 → 立刻停止后续调用）─────────────────────────────
const GUARD = {
  max_calls: 8,
  max_tokens_per_call: 512,
  max_total_output_tokens: 30000,
  max_total_tokens: 120000,
  timeout_ms: 120000,
  retries: 0,
  // 保守上限单价（元/百万 token）——只用于「不超过授权额」的自检，不代表账单；账单以 provider 为准
  price_in_per_m: 2,
  price_out_per_m: 8,
  max_estimate_cny: 2,
};

let calls = 0;
let outTokens = 0;
let totalTokens = 0;
let inTokens = 0;
function addUsage(u) {
  const p = Number(u?.prompt_tokens || 0);
  const c = Number(u?.completion_tokens || 0);
  inTokens += p; outTokens += c; totalTokens += p + c;
}
const estimate = () => (inTokens / 1e6) * GUARD.price_in_per_m + (outTokens / 1e6) * GUARD.price_out_per_m;
const budgetOk = () => calls < GUARD.max_calls && outTokens <= GUARD.max_total_output_tokens && totalTokens <= GUARD.max_total_tokens && estimate() <= GUARD.max_estimate_cny;

// ── 真实密钥：只读读出，只记掩码 ───────────────────────────────────────────
function readRealConfig() {
  const db = new DatabaseSync(path.join(ROOT, 'data', 'novel.db'), { readOnly: true });
  const row = db.prepare('SELECT * FROM api_configs ORDER BY id LIMIT 1').get();
  if (!row || !row.api_key) throw new Error('真实库 api_configs 里没有可用配置（不发起调用）');
  return { base_url: row.base_url, api_key: row.api_key, model: row.model, key_len: String(row.api_key).length, base: row.base_url, db_model: row.model };
}
const maskKey = (k) => (k ? k.slice(0, 3) + '***' + k.slice(-2) + '(len=' + k.length + ')' : '(none)');

// ── 隔离实例（临时数据目录 + 空闲端口 + 关 OV）───────────────────────────────
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(3900 + (process.pid % 90)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(3900 + (process.pid % 90)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-live-'));
let server = null;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { serverLog += c; });
  server.stderr.on('data', (c) => { serverLog += c; });
  for (let i = 0; i < 120; i += 1) {
    try { const r = await fetch(BASE + '/api/novel/ping', { signal: AbortSignal.timeout(2000) }); if (r.status === 200) return true; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
function stopServer() {
  if (!server) return;
  try { server.kill(); } catch { /* 已退出 */ }
  server = null;
}
function cleanup() {
  stopServer();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
// ── 解析与断言小工具 ───────────────────────────────────────────────────────
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const tryParse = (s) => { try { return { ok: true, v: JSON.parse(s) }; } catch (e) { return { ok: false, e: String(e.message) }; } };
  const direct = tryParse(t);
  if (direct.ok) return direct;
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const i = t.indexOf(open); const j = t.lastIndexOf(close);
    if (i >= 0 && j > i) { const r = tryParse(t.slice(i, j + 1)); if (r.ok) return r; }
  }
  return { ok: false, e: '连子串都解析不出 JSON' };
}
const hasQuoteFrom = (quotes, source) => Array.isArray(quotes) && quotes.some((q) => typeof q === 'string' && q.length >= 4 && source.includes(q.slice(0, Math.min(8, q.length))));
const flat = (x) => JSON.stringify(x || '');

const SYS = '你是中文小说创作助手。只输出 JSON（不要 Markdown 代码围栏，不要任何解释文字）。';

const EDIT_SRC = '空气仿佛凝固了。他缓缓地抬起头，眼神中闪过一丝复杂的神色。他知道，这一切都是命运的安排。他深吸一口气，仿佛要将整个世界都吸进胸腔。';
const REVIEW_SRC = '天还没亮，他就摸黑出了门。正午的太阳晒得他睁不开眼，他抹了把汗继续往前走。到了河边，天还没亮，他只好在黑暗里等渡船。';
const STYLE_SRC = '他推开门。屋里没有人。灯还亮着，茶杯是温的。他不喜欢这种安静——像有人在暗处，替他把话都说完了。';
const BRANCH_SRC = '主角在旧书店发现一本会自己换页的日记：谁读了它，就会忘记自己昨天写下的最重要的一件事。';
const CONTRACT_SRC = '第五章：主角第一次使用力量，代价是失去一段记忆；同章结尾，他遇见一个自称见过他的人。';
const IMPORT_SRC = '雾城的钟楼在七月停了。修钟匠沈砚把梯子靠在墙上，发现齿轮里卡着一枚铜钥匙。三天后，城里所有钟同时响了一声。他的学徒小满说，那声音像是从地底下传来的。';

const CAPS = [
  {
    id: 'edit_deai',
    title: '三档编辑·去 AI 腔（R07）',
    action: 'write',
    temperature: 0.2, maxTokens: 512,
    prompt: '把下面这段按「去 AI 腔」档改写：删掉套话与机械比喻，保留原意、人名与情节事实，长短句自然交替。\n原文：' + EDIT_SRC + '\n只输出 JSON：{"rewritten":"改写后的正文","changes":[{"rule":"命中的规则名","before":"被删改的原文片段","after":"改写后片段"}]}',
    assert: (v, reply) => {
      const bad = [];
      if (typeof v.rewritten !== 'string' || v.rewritten.length < 20) bad.push('rewritten 太短或缺失');
      if (v.rewritten === EDIT_SRC) bad.push('rewritten 与原文完全相同（没有真的改写）');
      if (!Array.isArray(v.changes) || v.changes.length === 0) bad.push('changes 为空（没有给出改了什么）');
      if (!Array.isArray(v.changes) || !v.changes.every((c) => c && typeof c.rule === 'string' && typeof c.before === 'string')) bad.push('changes 缺 rule/before 字段');
      return { ok: bad.length === 0, detail: bad.join('；') || '改写结果与改动清单齐全', reply };
    },
  },
  {
    id: 'review_semantic',
    title: '语义审稿（时间线矛盾）',
    action: 'write',
    temperature: 0.2, maxTokens: 512,
    prompt: '审下面这段草稿，找出其中的硬伤（尤其是时间/光线与行程的自相矛盾）。\n草稿：' + REVIEW_SRC + '\n只输出 JSON：{"issues":[{"type":"问题类型","quote":"原文片段","why":"为什么是问题","severity":"high|medium|low"}]}',
    assert: (v) => {
      const bad = [];
      if (!Array.isArray(v.issues) || v.issues.length === 0) bad.push('issues 为空');
      const text = flat(v.issues);
      if (!/天还没亮|正午|时间|光线|矛盾|冲突/.test(text)) bad.push('没有指出时间/光线矛盾');
      if (Array.isArray(v.issues) && !v.issues.every((i) => i && typeof i.quote === 'string' && typeof i.why === 'string')) bad.push('issue 缺 quote/why');
      return { ok: bad.length === 0, detail: bad.join('；') || '指出了植入的时间线矛盾', found: Array.isArray(v.issues) ? v.issues.length : 0 };
    },
  },
  {
    id: 'style_profile',
    title: '样文分析（风格档案）',
    action: 'write',
    temperature: 0.3, maxTokens: 512,
    prompt: '读下面这段作者样文，给出结构化风格画像。\n样文：' + STYLE_SRC + '\n只输出 JSON：{"tone":"基调","sentence_style":"句式特征","traits":["特征1","特征2"],"evidence_quotes":["样文里的原句"]}',
    assert: (v) => {
      const bad = [];
      if (typeof v.tone !== 'string' || v.tone.length < 2) bad.push('tone 缺失');
      if (!Array.isArray(v.traits) || v.traits.length === 0) bad.push('traits 为空');
      if (!hasQuoteFrom(v.evidence_quotes, STYLE_SRC)) bad.push('evidence_quotes 没有一条能在样文里找到');
      return { ok: bad.length === 0, detail: bad.join('；') || '画像字段齐全且引文可回溯', traits: Array.isArray(v.traits) ? v.traits.length : 0 };
    },
  },
  {
    id: 'branch_deduction',
    title: '剧情推演（2 个候选方向）',
    action: 'write',
    temperature: 0.7, maxTokens: 512,
    prompt: '基于下面的设定，推演 2 个**不同**的剧情方向候选（候选不是既成事实）。\n设定：' + BRANCH_SRC + '\n只输出 JSON 数组：[{"title":"候选名","core_action":"核心行动","conflict":"核心冲突","character_choice":"人物选择","consequence":"后果","risk":"风险"}]',
    assert: (v) => {
      const bad = [];
      if (!Array.isArray(v) || v.length !== 2) bad.push('不是恰好 2 个候选');
      if (Array.isArray(v) && !v.every((c) => c && typeof c.core_action === 'string' && typeof c.conflict === 'string' && typeof c.consequence === 'string')) bad.push('候选缺 core_action/conflict/consequence');
      if (Array.isArray(v) && v.length === 2 && v[0].core_action === v[1].core_action) bad.push('两个候选的核心行动相同（没有真正两条路）');
      return { ok: bad.length === 0, detail: bad.join('；') || '两个候选形状齐全且互不相同', candidates: Array.isArray(v) ? v.length : 0 };
    },
  },
  {
    id: 'contract_suggestion',
    title: '契约建议（本章必须守住什么）',
    action: 'write',
    temperature: 0.3, maxTokens: 512,
    prompt: '根据下面的章节安排，提出这一章的写作契约建议。\n章节安排：' + CONTRACT_SRC + '\n只输出 JSON：{"must_facts":["必须发生的事实"],"red_lines":["不能违背的底线"],"open_questions":["留给后文的悬置问题"]}',
    assert: (v) => {
      const bad = [];
      if (!Array.isArray(v.must_facts) || v.must_facts.length < 2) bad.push('must_facts 少于 2 条');
      if (!Array.isArray(v.red_lines) || v.red_lines.length === 0) bad.push('red_lines 为空');
      return { ok: bad.length === 0, detail: bad.join('；') || '契约建议三件套齐全', must: Array.isArray(v.must_facts) ? v.must_facts.length : 0 };
    },
  },
  {
    id: 'import_extract',
    title: '导入抽取（九类对象子集）',
    action: 'write',
    temperature: 0.2, maxTokens: 512,
    prompt: '从下面这段导入文本里抽取结构化信息，每条都要带原文证据。\n文本：' + IMPORT_SRC + '\n只输出 JSON：{"characters":[{"name":"","identity":"","evidence":"原文片段"}],"events":[{"summary":"","evidence":"原文片段"}],"world_terms":[{"title":"","content":"","evidence":"原文片段"}],"relations":[{"from":"","to":"","relation":"","evidence":"原文片段"}]}',
    assert: (v) => {
      const bad = [];
      if (!Array.isArray(v.characters) || v.characters.length < 2) bad.push('characters 少于 2 个');
      if (!Array.isArray(v.events) || v.events.length === 0) bad.push('events 为空');
      const allEvidence = [].concat(v.characters || [], v.events || [], v.world_terms || [], v.relations || []).map((x) => x && x.evidence).filter(Boolean);
      if (!hasQuoteFrom(allEvidence, IMPORT_SRC)) bad.push('没有一条 evidence 能在原文里找到');
      return { ok: bad.length === 0, detail: bad.join('；') || '实体/事件/词条/关系都有原文证据', chars: Array.isArray(v.characters) ? v.characters.length : 0, evidence: allEvidence.length };
    },
  },
];
// ── 运行 ───────────────────────────────────────────────────────────────────
const DAY = new Date().toISOString().slice(0, 10);
const LOG_PATH = path.join(ROOT, '.verify-enh', 'live-capabilities-' + DAY + '.log');
const JSON_PATH = path.join(ROOT, '.verify-enh', 'live-capabilities-' + DAY + '.json');
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say('══════ 真实模型有限预算验收（手动触发，不进 CI）══════');
say('预算依据：用户 2026-09-27 显式授权「给予预算2元以内」');
say('硬上限：调用 ≤ ' + GUARD.max_calls + ' 次；单次 max_tokens ≤ ' + GUARD.max_tokens_per_call + '；输出总量 ≤ ' + GUARD.max_total_output_tokens + '；总 tokens ≤ ' + GUARD.max_total_tokens + '；单次超时 ' + (GUARD.timeout_ms / 1000) + 's；重试 ' + GUARD.retries + ' 次');
say('保守估算：输入 ¥' + GUARD.price_in_per_m + '/M、输出 ¥' + GUARD.price_out_per_m + '/M ⇒ 本次自检上限 ¥' + GUARD.max_estimate_cny + '（账单以 provider 为准）');
for (const c of CAPS) say('  · ' + c.id + '：' + c.title + '（max_tokens ' + c.maxTokens + '，temperature ' + c.temperature + '）');
say('');

if (DRY) {
  say('【干跑】只打印计划，不发起任何调用。');
  process.exit(0);
}

const CFG = readRealConfig();
say('配置来源：真实库 data/novel.db 的 api_configs（只读，行数 1）');
say('  · base_url = ' + CFG.base_url + '（上游路由 ' + String(CFG.base_url).replace(/\/+$/, '') + '/chat/completions）');
say('  · model = ' + CFG.model + '；api_key = ' + maskKey(CFG.api_key));
say('  · 思考配置 = disabled（thinking:{type:"disabled"}，避免思考 token 计入预算）');
say('隔离实例：PORT=' + PORT + '，数据目录=' + DATA_DIR + '，NOVELSTUDIO_OV_DISABLED=1');
say('');

const ready = await startServer();
if (!ready) { say('✗ 隔离实例未就绪，未发起任何调用'); stopServer(); process.exit(2); }
say('✓ 隔离实例就绪（' + BASE + '）');
say('');

const results = [];
async function once(record) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/ai/' + record.action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record.body),
    signal: AbortSignal.timeout(GUARD.timeout_ms),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  record.http_status = res.status;
  record.elapsed_ms = Date.now() - t0;
  record.usage = data?.raw?.usage || null;
  record.provider_model = data?.raw?.model || null;
  record.reply = typeof data?.reply === 'string' ? data.reply : '';
  if (record.usage) addUsage(record.usage);
  return record;
}
const cfgBody = () => ({ base_url: CFG.base_url, api_key: CFG.api_key, model: 'deepseek-flash' });

// 1) 连接自检（最小的一次真实调用）
{
  const rec = { id: 'connect_test', title: '连接自检（最小调用）', action: 'test', body: { ...cfgBody(), max_tokens: 16 } };
  calls += 1;
  await once(rec);
  rec.verdict = rec.http_status === 200 && rec.reply.trim().length > 0 ? 'PASS' : 'FAIL';
  results.push(rec);
  say('【' + rec.id + '】' + rec.title + ' → HTTP ' + rec.http_status + '，' + rec.elapsed_ms + 'ms，用量 ' + JSON.stringify(rec.usage) + '，回复「' + String(rec.reply).slice(0, 30) + '」 ⇒ ' + rec.verdict);
}

// 2) 六类能力
for (const cap of CAPS) {
  if (!budgetOk()) { say('✗ 预算闸门触发（调用 ' + calls + ' 次 / 输出 ' + outTokens + ' tokens / 估算 ¥' + estimate().toFixed(4) + '）——停止后续调用'); break; }
  const rec = {
    id: cap.id, title: cap.title, action: cap.action,
    body: { ...cfgBody(), temperature: cap.temperature, max_tokens: Math.min(cap.maxTokens, GUARD.max_tokens_per_call), reasoning_effort: 'off', messages: [{ role: 'system', content: SYS }, { role: 'user', content: cap.prompt }] },
    thinking: 'disabled', temperature: cap.temperature, max_tokens: cap.maxTokens,
  };
  calls += 1;
  try { await once(rec); } catch (e) { rec.http_status = 0; rec.error = String(e?.message || e); rec.reply = ''; }
  const parsed = extractJson(rec.reply);
  rec.json_ok = parsed.ok;
  if (rec.http_status !== 200) {
    rec.verdict = 'FAIL';
    rec.detail = 'HTTP ' + rec.http_status + (rec.error ? '（' + rec.error + '）' : '');
  } else if (!parsed.ok) {
    rec.verdict = 'FAIL';
    rec.detail = '回复不是 JSON：' + parsed.e;
  } else {
    const a = cap.assert(parsed.v, rec.reply);
    rec.verdict = a.ok ? 'PASS' : 'FAIL';
    rec.detail = a.detail;
    rec.facts = Object.fromEntries(Object.entries(a).filter(([k, val]) => !['ok', 'detail', 'reply'].includes(k) && (typeof val === 'number' || typeof val === 'string')));
  }
  rec.reply_excerpt = String(rec.reply).replace(/\s+/g, ' ').slice(0, 200);
  rec.parsed_excerpt = parsed.ok ? JSON.stringify(parsed.v).slice(0, 400) : null;
  results.push(rec);
  say('【' + rec.id + '】' + rec.title + ' → HTTP ' + rec.http_status + '，' + rec.elapsed_ms + 'ms，用量 ' + JSON.stringify(rec.usage) + ' ⇒ ' + rec.verdict + (rec.detail ? '（' + rec.detail + '）' : ''));
}

// 3) 汇总与证据
const passed = results.filter((r) => r.verdict === 'PASS').length;
const failed = results.filter((r) => r.verdict !== 'PASS');
say('');
say('合计：PASS ' + passed + ' / FAIL ' + failed.length + '（调用 ' + calls + ' 次）');
say('用量总计：输入 ' + inTokens + ' + 输出 ' + outTokens + ' = ' + totalTokens + ' tokens');
say('保守估算费用：¥' + estimate().toFixed(4) + '（≤ 授权 ¥2：' + (estimate() <= 2 ? '是' : '否') + '；账单以 provider 为准）');
say('密钥脱敏：' + maskKey(CFG.api_key) + '（日志与证据文件不含密钥）');
if (failed.length) for (const f of failed) say('  ✗ ' + f.id + '：' + (f.detail || '未通过'));
const evidence = {
  kind: 'live-model-acceptance', date: DAY, budget_basis: '用户 2026-09-27 显式授权「给予预算2元以内」',
  guard: GUARD, totals: { calls, input_tokens: inTokens, output_tokens: outTokens, total_tokens: totalTokens, estimate_cny_conservative: Number(estimate().toFixed(4)) },
  config: { source: 'data/novel.db api_configs（只读）', base_url: CFG.base_url, provider_route: String(CFG.base_url).replace(/\/+$/, '') + '/chat/completions', model: 'deepseek-flash', thinking: 'disabled', key_mask: maskKey(CFG.api_key) },
  isolation: { instance_port: PORT, data_dir: '临时目录（运行后删除）', ov: 'disabled', real_db_access: '只读', real_works_touched: false },
  results,
};
fs.writeFileSync(LOG_PATH, lines.join(NL) + NL, 'utf8');
fs.writeFileSync(JSON_PATH, JSON.stringify(evidence, null, 2) + NL, 'utf8');
say('证据已写入：' + path.relative(ROOT, LOG_PATH) + '、' + path.relative(ROOT, JSON_PATH));
cleanup();
process.exit(failed.length ? 1 : 0);