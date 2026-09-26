#!/usr/bin/env node
/**
 * bench-context-build.mjs —— 上下文构建的**耗时基线**（零计费、只发 GET/PUT）。
 *
 * 为什么需要：本仓库的纪律是「先测量后优化」。任何动到上下文装配的改动都必须先有
 * 这条基线，改完再测一次，用数据说明「没有为了新功能而拖慢写作路径」。
 *
 * 测两条路径（它们共用同一份装配结果，但入口不同）：
 *   ① /api/ai_context          —— 界面「AI 写作」用的主成文路径入口
 *   ② /api/novel/context       —— 创作内核（dsh 侧 novel_context 工具）入口
 *
 * ⚠️ 装配结果**有缓存**（ai/context/cache.mjs）。所以本工具默认做两轮：
 *   · cached   连续 GET（热路径，文学写作时最常见）
 *   · cold     每次 GET 前先发一个**幂等写**（把作品简介原样写回 → 触发 touchWork → 缓存作废）
 *              —— 这才是新加的清单/溯源字段真正会花时间的地方
 *
 * 读法：本工具**只报数不下结论**。同一个实例、同一组参数各跑一次比 p50/p95，
 * 不要看单次最大值（受调度与磁盘噪声影响）。
 *
 * 用法:
 *   node .p1-baseline/bench-context-build.mjs [--base http://127.0.0.1:3739] [--work 16] [--chapter 108]
 *                                            [--n 20] [--cold] [--json]
 */
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('--base', process.env.NOVELSTUDIO_BASE || 'http://127.0.0.1:3739');
const WORK = arg('--work', '16');
const CHAPTER = arg('--chapter', '108');
const N = Number(arg('--n', '20')) || 20;
const COLD = process.argv.includes('--cold');
const AS_JSON = process.argv.includes('--json');

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const p95 = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)];
};

async function once(path) {
  const t0 = performance.now();
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  const ms = performance.now() - t0;
  let len = 0;
  try {
    const j = JSON.parse(text);
    len = String(j.assembled ?? j.text ?? '').length;
  } catch { /* 非 JSON：len 保持 0 */ }
  return { ms, status: r.status, chars: len };
}

/**
 * 让缓存作废：把作品简介**原样写回**（幂等、不改数据），服务端会 touchWork → 装配缓存作废。
 * 只在隔离实例上跑；对真实库不要用（虽然幂等，但没必要冒险）。
 */
async function bustCache() {
  const list = await fetch(`${BASE}/api/works/${WORK}`, { signal: AbortSignal.timeout(10000) });
  if (!list.ok) return false;
  const w = await list.json();
  const cur = ((w.work || w) || {}).description ?? '';
  const r = await fetch(`${BASE}/api/works/${WORK}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: cur }),
    signal: AbortSignal.timeout(10000),
  });
  return r.ok;
}

async function bench(label, path) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    if (COLD) await bustCache();
    rows.push(await once(path));
  }
  const ok = rows.filter((r) => r.status === 200);
  const ms = ok.map((r) => r.ms);
  return {
    label,
    status: ok.length === rows.length ? 200 : rows.map((r) => r.status).join('/'),
    n: ok.length,
    min: ms.length ? Math.round(Math.min(...ms)) : null,
    p50: ms.length ? Math.round(median(ms)) : null,
    p95: ms.length ? Math.round(p95(ms)) : null,
    max: ms.length ? Math.round(Math.max(...ms)) : null,
    assembledChars: ok.length ? ok[ok.length - 1].chars : null,
  };
}

const bustOk = COLD ? await bustCache() : null;
const results = [
  await bench(COLD ? 'ai_context（主成文路径，冷）' : 'ai_context（主成文路径入口）', `/api/ai_context?chapter_id=${CHAPTER}`),
  await bench(COLD ? 'novel/context（创作内核，冷）' : 'novel/context?mode=full（创作内核）', `/api/novel/context?work_id=${WORK}&chapter_id=${CHAPTER}&mode=full`),
];

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, work: WORK, chapter: CHAPTER, n: N, cold: COLD, bustOk, results }, null, 2));
} else {
  console.log(`目标实例：${BASE}　作品 #${WORK}　章节 #${CHAPTER}　次数 ${N}　模式：${COLD ? '冷（每次先作废缓存）' : '热（走缓存）'}\n`);
  if (COLD && !bustOk) console.log('⚠️ 缓存作废请求未成功，这组数其实是热路径。\n');
  console.log('路径                                      最小    p50    p95    最大   装配字数');
  for (const r of results) {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad(r.label, 40)}${pad(r.min, 7)}${pad(r.p50, 7)}${pad(r.p95, 7)}${pad(r.max, 7)}${r.assembledChars ?? '-'}`);
  }
  console.log('\n注：单次最大值受操作系统调度与磁盘噪声影响，判定变化请用 p50/p95。');
}