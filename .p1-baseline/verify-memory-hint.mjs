#!/usr/bin/env node
/**
 * verify-memory-hint.mjs —— 钉住「长期记忆超线时，压缩提示必须真的进到上下文里」。
 *
 * 为什么要有它（2026-09-15 自审发现 F6）：
 *   装配器对每层是按 cap **从头部**截断的，而长期记忆会随章节无界增长
 *   （`mergeMemoryDraft` 新事件置顶、只拼接不压缩）。压缩提示原先挂在正文**末尾**，
 *   于是记忆越长越会被自己截掉——恰恰在最该提示压缩的时候提示消失。
 *   实测：work#16 记忆 9063 字、cap 2200 → 层内只剩截断提示，压缩提示不可见。
 *
 * 修法：提示挪到正文**开头**（头部截断切不到它）。代价是提示占用 cap 内空间
 *（实测让出 63 字 / 2200 字 = 2.9%，总长不变），被挤掉的部分仍可经 novel_memory_read 查回。
 *
 * 两种数据源（两者都可跑，建议都跑）：
 *   --base <url>        活实例：自动找出「记忆超提示线」的作品，逐个实调 /api/ai_context
 *   --baselines <dir>   离线：读 capture-baseline 落下的 JSON，检查 assembled
 *
 * 用法:
 *   node .p1-baseline/verify-memory-hint.mjs --base http://127.0.0.1:3739
 *   node .p1-baseline/verify-memory-hint.mjs --baselines .p1-baseline/baselines-p5
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('--base', '');
const DIR = arg('--baselines', '');
/** 与 server.js 的 MEMORY_COMPRESS_HINT 保持一致（从现场读不到，只能对齐常量）。 */
const HINT_LINE = 1200;
const HINT_RX = /（⚠ 记忆已 \d+ 字，超过 \d+ 字压缩提示线，收尾时请优先用 novel_memory_update 压缩合并）/;

let pass = 0, fail = 0, skip = 0;
const notes = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const no = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? '  — ' + d : ''}`); };
const sk = (n, d) => { skip++; console.log(`  – ${n}${d ? '  — ' + d : ''}`); };

/** 在 assembled 文本里定位长期记忆层，判断提示是否落在**层内**。 */
export function hintInsideMemoryLayer(assembled) {
  const text = String(assembled || '');
  const h = text.indexOf('【长期记忆');
  if (h < 0) return { found: false, reason: '没有长期记忆层' };
  const afterHeader = text.indexOf('\n', h);
  const window = text.slice(afterHeader + 1);
  const m = window.match(HINT_RX);
  if (!m) return { found: false, reason: '层内没有压缩提示' };
  // 提示必须在层内（在下一个层标题之前）
  const next = window.indexOf('【');
  return { found: next < 0 || m.index < next, reason: m[0].slice(0, 40) + '…' };
}

if (!BASE && !DIR) { console.error('需要 --base 或 --baselines'); process.exit(2); }

if (DIR) {
  console.log(`═══ 离线：读基线目录 ${DIR} ═══\n`);
  const files = fs.readdirSync(DIR).filter((f) => /^w\d+-c\d+-full\.json$/.test(f)).sort();
  if (!files.length) sk('目录里没有 *-full.json 用例', DIR);
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const memLen = String(j.story_memory || '').length;
    if (memLen <= HINT_LINE) continue;   // 未超线 → 本就不该有提示
    const r = hintInsideMemoryLayer(j.assembled);
    if (r.found) ok(`${f}　记忆 ${memLen} 字 > ${HINT_LINE} → 压缩提示在层内`);
    else no(`${f}　记忆 ${memLen} 字 > ${HINT_LINE} 但提示不在层内`, r.reason);
  }
  const checked = files.filter((f) => String(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).story_memory || '').length > HINT_LINE).length;
  if (!checked) sk(`目录里没有「记忆 > ${HINT_LINE} 字」的用例（提示本就不该出现）`);
}

if (BASE) {
  console.log(`═══ 活实例：${BASE} ═══\n`);
  const get = async (p) => {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const works = (await get('/api/works')).json || [];
  const list = Array.isArray(works) ? works : (works.works || []);
  let checked = 0;
  for (const w of list) {
    const wid = w.id ?? w.work_id;
    const mem = await get(`/api/story_memory?work_id=${wid}`);
    const memLen = String(mem.json?.summary || '').length;
    if (memLen <= HINT_LINE) continue;
    const chs = await get(`/api/chapters?work_id=${wid}`);
    const first = (Array.isArray(chs.json) ? chs.json : (chs.json?.chapters || []))[0];
    if (!first) { sk(`work#${wid} 记忆 ${memLen} 字但没有章节可测`); continue; }
    const ctx = await get(`/api/ai_context?chapter_id=${first.id}`);
    const r = hintInsideMemoryLayer(ctx.json?.assembled);
    checked++;
    if (r.found) ok(`work#${wid}（记忆 ${memLen} 字，chapter#${first.id}）→ 提示在层内`);
    else no(`work#${wid}（记忆 ${memLen} 字）提示不在层内`, r.reason);
  }
  if (!checked) sk(`实例里没有「记忆 > ${HINT_LINE} 字」的作品（提示本就不该出现）`);
}

console.log(`\n══════════════════════════════`);
console.log(`长期记忆压缩提示检查：通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
process.exitCode = fail ? 1 : 0;
