#!/usr/bin/env node
/**
 * smoke.mjs —— P6 切换后的**真实写作冒烟**（会真实计费，需显式授权）。
 *
 * 为什么单独成文件：runbook 的 S4 最后一步一直写着"一次真实写作冒烟（需单独许可）"，
 * 却没有可复现的脚本——于是"冒烟过了"只能靠叙述。这里把它固化，并沿用本仓库的成本纪律：
 *   - **默认拒绝运行**，必须显式设 `NOVELSTUDIO_SMOKE_ALLOW_BILLING=1`；
 *   - 用**临时作品**做（验完即删），绝不碰作者的真实作品；
 *   - 任务走 `/api/harness/run`，因此走的是**当前默认 dsh profile**（P6 之后即 novel）；
 *   - 不传 model → 用 dsh 的默认模型（settings.yaml，通常是最便宜的那档）。
 *
 * 它验的是**整条链路真的通**：上下文装配 → novel profile（人设 + 15 个 novel_* 工具）→ 真实 API → 产出正文。
 * 这一步是任何零成本检查都替代不了的。
 *
 * 用法:
 *   $env:NOVELSTUDIO_SMOKE_ALLOW_BILLING='1'
 *   node .p6-cutover/smoke.mjs --base http://127.0.0.1:3737
 */
const arg = (n, d) => {
  const pref = `${n}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const BASE = arg('--base', 'http://127.0.0.1:3737');
const TIMEOUT_MS = Number(arg('--timeout-ms', '600000'));

if (process.env.NOVELSTUDIO_SMOKE_ALLOW_BILLING !== '1') {
  console.error(`拒绝运行：这一步会发起**真实 LLM 调用**（真实计费）。

它需要显式授权：
  $env:NOVELSTUDIO_SMOKE_ALLOW_BILLING='1'
  node .p6-cutover/smoke.mjs --base ${BASE}

它会：建一个**临时作品** → 跑一次真实写作任务 → 校验产出 → 删掉临时作品。
不碰你的任何真实作品。`);
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

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};

console.log(`═══ P6 真实写作冒烟（会计费）═══\n目标实例：${BASE}\n`);
const t0 = Date.now();

// 1) 临时作品 + 章节（用完即删）
const w = await api('POST', '/api/works', { title: 'P6 冒烟·临时作品', description: '切换后真实冒烟，用完即删' });
const wid = w.json?.id ?? w.json?.work_id;
check('创建临时作品', !!wid, `status=${w.status}`);
if (!wid) process.exit(1);

const c = await api('POST', '/api/chapters', { work_id: wid, title: '冒烟章', content: '雨夜，缝匠铺的门被推开。', position: 1 });
const cid = c.json?.id;
check('创建临时章节', !!cid, `status=${c.status}`);

// 2) 真实写作任务：走 /api/harness/run → 当前默认 dsh profile
let jobId = null;
{
  const r = await api('POST', '/api/harness/run', {
    prompt: '请写一段 150 字左右的中文小说场景片段：雨夜，缝匠铺里有人在等一个不会来的人。只输出正文，不要解释。',
    work_id: wid, chapter_id: cid, timeout: TIMEOUT_MS, action: 'smoke',
  });
  jobId = r.json?.job_id || null;
  check('任务已入队（202 + job_id）', r.status === 202 && !!jobId, `status=${r.status} body=${r.text.slice(0, 120)}`);
}

// 3) 轮询到终态
let job = null;
if (jobId) {
  const deadline = Date.now() + TIMEOUT_MS + 60000;
  while (Date.now() < deadline) {
    const r = await api('GET', `/api/harness/job?id=${encodeURIComponent(jobId)}`);
    job = r.json?.job || r.json;
    const st = job?.status;
    if (['done', 'failed', 'cancelled', 'error', 'timeout'].includes(st)) break;
    await new Promise((s) => setTimeout(s, 3000));
  }
  const st = job?.status;
  const out = String(job?.output || job?.result || '');
  check('任务进入终态', !['running', 'queued', 'undefined'].includes(String(st)), `status=${st}`);
  check('任务成功（status=done）', st === 'done', `status=${st} error=${String(job?.error || '').slice(0, 160)}`);
  check('产出了正文', out.trim().length > 0, `${out.trim().length} 字`);
  if (out.trim()) {
    console.log('\n  ── 产出预览（前 200 字）──');
    console.log('  ' + out.trim().slice(0, 200).replace(/\n/g, '\n  '));
  }
}

// 4) 删掉临时作品（D6 之后：埋点行会随之清理）
{
  const d = await api('DELETE', `/api/works/${wid}`);
  check('临时作品已删除', d.status === 200, `status=${d.status}`);
}

console.log(`\n耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`═══ 冒烟：通过 ${pass} / 失败 ${fail} ═══`);
process.exitCode = fail ? 1 : 0;
