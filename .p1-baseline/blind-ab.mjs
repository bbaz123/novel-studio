#!/usr/bin/env node
/**
 * blind-ab.mjs —— 关键改动的人工**盲测**（决策 D8-#8 的后半）。
 *
 * ── 它补的是哨兵补不了的那一半 ────────────────────────────────────────────────
 * `quality-sentinel.mjs` 衡量"你改了多少"（采纳率、编辑距离），**不衡量"好不好"**。
 * 真正判断"改动有没有让小说更好"，只能由人来读——而且要**盲着读**：
 * 知道你读的是哪个设置，判断就会被预期污染。
 *
 * ── 它怎么做到盲 ──────────────────────────────────────────────────────────────
 * 同一章上下文、同一提示词，用两套设置各生成一次；写盘时把顺序**随机打乱**成 A/B，
 * 真实对应关系只落在 `mapping.json` 里。你先读、先选，之后才揭示。
 * 提示词与上下文取自应用自己的装配结果（`/api/ai_context`），不在这里重写一份。
 *
 * ── 花钱闸 ────────────────────────────────────────────────────────────────────
 * 它会真的产生两次生成费用（一次一章，可能数千字）。必须显式设
 * `NOVELSTUDIO_BLIND_AB_CONFIRM=1` 才执行，并把预计规模打印出来。
 *
 * 用法:
 *   # 1) 生成（花钱，需确认）
 *   $env:NOVELSTUDIO_BLIND_AB_CONFIRM='1'
 *   node .p1-baseline/blind-ab.mjs --base http://127.0.0.1:3737 --chapter 107 \
 *        --a deepseek-flash --b deepseek-v4-pro --out .p1-baseline/.blind/run1
 *   # 2) 读 A.md 与 B.md，选一个
 *   node .p1-baseline/blind-ab.mjs --reveal .p1-baseline/.blind/run1 --pick A
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

// ── 揭示模式：读 mapping 并给出结论 ──────────────────────────────────────────
const revealDir = arg('--reveal', '');
if (revealDir) {
  const pick = String(arg('--pick', '')).toUpperCase();
  const mapFile = path.join(revealDir, 'mapping.json');
  if (!fs.existsSync(mapFile)) { console.error(`✗ 找不到 ${mapFile}`); process.exit(2); }
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  console.log(`═══ 揭示：${revealDir} ═══\n`);
  console.log(`  A = ${map.A.model}　（${map.A.chars} 字，${map.A.seconds} 秒）`);
  console.log(`  B = ${map.B.model}　（${map.B.chars} 字，${map.B.seconds} 秒）`);
  if (pick !== 'A' && pick !== 'B') {
    console.log('\n（未给 --pick A|B，只揭示对应关系。）');
    process.exit(0);
  }
  const winner = map[pick];
  const loser = map[pick === 'A' ? 'B' : 'A'];
  console.log(`\n你选了 **${pick}** → 那是 \`${winner.model}\`。`);
  console.log(`落选的是 \`${loser.model}\`。`);
  console.log('\n这条结论要连着说清样本量：**一次盲测只说明"这一章这一次"**，');
  console.log('它能当"值不值得继续用这个设置"的线索，不能当统计结论。多跑几章再下判断。');
  fs.writeFileSync(path.join(revealDir, 'result.json'), JSON.stringify({
    revealedAt: new Date().toISOString(), pick, winner: winner.model, loser: loser.model, mapping: map,
  }, null, 2), 'utf8');
  process.exit(0);
}

// ── 生成模式 ────────────────────────────────────────────────────────────────
const BASE = arg('--base', 'http://127.0.0.1:3737');
const CHAPTER = Number(arg('--chapter', '0'));
const MODEL_A = arg('--a', '');
const MODEL_B = arg('--b', '');
const OUT = arg('--out', path.join('.p1-baseline', '.blind', `run-${Date.now()}`));

if (!CHAPTER || !MODEL_A || !MODEL_B) {
  console.error('用法: node .p1-baseline/blind-ab.mjs --chapter <id> --a <modelA> --b <modelB> [--base url] [--out dir]');
  console.error('   （或揭示模式：--reveal <dir> --pick A|B）');
  process.exit(2);
}
if (process.env.NOVELSTUDIO_BLIND_AB_CONFIRM !== '1') {
  console.error('✗ 拒绝执行：盲测会真的生成两次（**产生 API 费用**）。');
  console.error('  确认后重跑：$env:NOVELSTUDIO_BLIND_AB_CONFIRM=\'1\'');
  process.exit(2);
}

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};

// 上下文与提示词取自应用自己的装配结果——不在这里重写一份（否则测的就不是真实路径）。
const ctx = await api('GET', `/api/ai_context?chapter_id=${CHAPTER}`);
if (ctx.status !== 200) { console.error(`✗ 取上下文失败：HTTP ${ctx.status}`); process.exit(2); }
const assembled = String(ctx.json?.assembled || '');
const targetWords = Number(ctx.json?.chapter?.target_words) || 2000;
console.log('═══ 关键改动的人工盲测（A/B 随机打乱）═══\n');
console.log(`  实例      : ${BASE}`);
console.log(`  章节      : #${CHAPTER}`);
console.log(`  上下文    : ${assembled.length} 字（取自应用自己的预算化装配）`);
console.log(`  A / B 设置: ${MODEL_A} vs ${MODEL_B}`);
console.log(`  预计费用  : **两次**生成，各约 ${targetWords} 字 → 请确认在授权额度内\n`);

const prompt = `${assembled}\n\n【任务】请根据以上上下文写出本章正文，目标约 ${targetWords} 字。只输出正文。`;

async function generate(model, tag) {
  const t0 = Date.now();
  // 走 `/harness/run`（自由提示词 → 产出是正文，落在 job.output），不新造任务类型。
  const created = await api('POST', '/api/harness/run', { prompt, model, timeout: 600000 });
  if (created.status !== 202 || !created.json?.job_id) {
    throw new Error(`建作业失败（${tag}）：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  }
  const id = created.json.job_id;
  for (;;) {
    await new Promise((s) => setTimeout(s, 4000));
    const st = await api('GET', `/api/harness/job?id=${encodeURIComponent(id)}`);
    const j = st.json || {};
    if (['done', 'failed', 'cancelled', 'timeout'].includes(j.status)) {
      return { status: j.status, text: String(j.output || ''), error: j.error || null, seconds: Math.round((Date.now() - t0) / 1000) };
    }
    if (Date.now() - t0 > 900000) return { status: 'local_timeout', text: '', error: null, seconds: Math.round((Date.now() - t0) / 1000) };
  }
}

const genA = await generate(MODEL_A, 'A');
const genB = await generate(MODEL_B, 'B');
for (const [tag, g] of [['A', genA], ['B', genB]]) {
  if (g.status !== 'done') console.error(`⚠ ${tag}（${tag === 'A' ? MODEL_A : MODEL_B}）状态 ${g.status}：${g.error || ''}`);
}

// 随机打乱：谁是 A 由密码学随机决定，之后不再改。
const flip = crypto.randomInt(2) === 1;
const slots = flip
  ? { A: { model: MODEL_B, ...genB }, B: { model: MODEL_A, ...genA } }
  : { A: { model: MODEL_A, ...genA }, B: { model: MODEL_B, ...genB } };

fs.mkdirSync(OUT, { recursive: true });
for (const k of ['A', 'B']) {
  fs.writeFileSync(path.join(OUT, `${k}.md`), slots[k].text || '（本次未产出内容）', 'utf8');
}
fs.writeFileSync(path.join(OUT, 'mapping.json'), JSON.stringify(slots, null, 2), 'utf8');

console.log('═══ 生成完成 ═══\n');
console.log(`  输出目录: ${OUT}`);
console.log('  A.md / B.md 已写好，顺序**随机打乱**，对应关系在 mapping.json 里（先别看）。\n');
console.log('  下一步：');
console.log(`    1. 读 ${path.join(OUT, 'A.md')} 与 ${path.join(OUT, 'B.md')}`);
console.log(`    2. 告诉我哪个更好：node .p1-baseline/blind-ab.mjs --reveal ${OUT} --pick A`);
console.log('\n  ⚠️ 一次盲测只说明"这一章这一次"。要多跑几章才谈得上结论。');
