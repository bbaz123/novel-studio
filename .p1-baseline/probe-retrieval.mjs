#!/usr/bin/env node
/**
 * P3 侦察：四个「零损失层」各自现有的查回路径能拿到多少？
 * 对照装配器实际裁掉了多少，判断 I4（凡裁剪必可查回）当前是否成立。
 *
 * 用法: node probe-retrieval.mjs <base> <workId> <chapterId>
 */
const [base, workIdArg, chapterIdArg] = process.argv.slice(2);
const workId = Number(workIdArg);
const chapterId = Number(chapterIdArg);

const get = async (p) => {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 200) }; }
};

const ctx = (await get(`/api/novel/context?work_id=${workId}&chapter_id=${chapterId}&mode=full`)).json;
const manifest = ctx.context_manifest || [];
console.log(`作品 #${workId} 章节 #${chapterId}`);
console.log(`装配长度 ${ctx.assembled.length} / 预算 ${ctx.context_stats?.budget}\n`);

console.log('═══ 各层被裁掉多少（来自裁剪清单）═══');
for (const m of manifest) {
  if (m.dropped > 0) {
    console.log(`  ${m.id.padEnd(12)} 原始 ${String(m.bodyLength).padStart(7)} → 采用 ${String(m.emitted).padStart(6)}  裁掉 ${String(m.dropped).padStart(7)}`);
  }
}

console.log('\n═══ 现有查回路径的返回规模 ═══');

// 1) 长期记忆
{
  const r = await get(`/api/story_memory?work_id=${workId}`);
  const len = (r.json?.summary || '').length;
  const m = manifest.find((x) => x.id === 'memory');
  console.log(`  [memory]  GET /api/story_memory          -> ${len} 字${m ? `（层里只有 ${m.emitted}，原始 ${m.bodyLength}）` : ''}`);
}

// 2) 事件账本 / 伏笔
{
  const r = await get(`/api/novel/events?work_id=${workId}&limit=1000`);
  const n = Array.isArray(r.json) ? r.json.length : (r.json?.events?.length ?? '?');
  console.log(`  [events]  GET /api/novel/events           -> ${n} 条`);
  const rf = await get(`/api/novel/foreshadows?work_id=${workId}&status=all`);
  const nf = Array.isArray(rf.json) ? rf.json.length : (rf.json?.foreshadows?.length ?? '?');
  console.log(`  [foreshadows] GET /api/novel/foreshadows?status=all -> ${nf} 条`);
}

// 3) 红线
{
  const r = await get(`/api/novel/redlines?work_id=${workId}`);
  const arr = Array.isArray(r.json) ? r.json : (r.json?.redlines || []);
  const total = arr.reduce((n, x) => n + String(x.pattern || '').length + String(x.note || '').length, 0);
  console.log(`  [redlines] GET /api/novel/redlines        -> ${arr.length} 条，正文合计约 ${total} 字`);
}

// 4) 世界观
{
  const r = await get(`/api/search?q=${encodeURIComponent('设定')}&work_id=${workId}`);
  const j = r.json || {};
  console.log(`  [world]   GET /api/search?q=设定          -> terms=${j.terms?.length ?? 0} chapters=${j.chapters?.length ?? 0} characters=${j.characters?.length ?? 0} plotlines=${j.plotlines?.length ?? 0}（无 world_entries 桶）`);
}

// 5) 工具的检索覆盖
{
  const r = await get(`/api/search?q=${encodeURIComponent('雾')}&work_id=${workId}`);
  const j = r.json || {};
  console.log(`  [/api/search 桶] ${Object.keys(j).join(', ')}`);
}
