#!/usr/bin/env node
// P1-03：分段长期记忆隔离验收（120 章 fixture，零计费）。
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:3739';
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => cond ? (pass++, console.log(`  ✓ ${name}`)) : (fails.push(name), console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`));
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j };
}
const w = await api('POST', '/api/works', { title: '分段记忆 fixture' });
if (w.status >= 300) throw new Error(`create work ${w.status}`);
const workId = w.json.id; const chapterIds = [];
for (let i = 0; i < 120; i++) {
  const c = await api('POST', '/api/chapters', { work_id: workId, title: `第${i + 1}章`, content: '' });
  if (c.status >= 300) throw new Error(`create chapter ${i}: ${c.status}`);
  chapterIds.push(c.json.id);
}
const summary = Array.from({ length: 120 }, (_, i) => `EVENT_CHAPTER_${i + 1}: 关键事实${i + 1}`).join('\n');
const saved = await api('PUT', '/api/story_memory', { work_id: workId, summary, source: 'fixture' });
ok('长期记忆保存成功', saved.status === 200);
const mem = await api('GET', `/api/story_memory?work_id=${workId}`);
const segs = mem.json.segments || [];
ok('120 章摘要被拆成多个分段', segs.length >= 12, `segments=${segs.length}`);
ok('分段保留 source_chapter_ids 查回路径', segs.every((s) => Array.isArray(s.source_chapter_ids) && s.source_chapter_ids.length > 0));
ok('分段窗口不重叠且按章序排列', segs.every((s, i) => i === 0 || Number(s.from_chapter) > Number(segs[i - 1].to_chapter)));
const ctx = await api('GET', `/api/ai_context?chapter_id=${chapterIds[99]}`);
const memoryLayer = (ctx.json.context_manifest || []).find((m) => m.id === 'memory');
ok('第100章 Context 含长期记忆层', !!memoryLayer);
ok('早期事件通过分段摘要进入第100章 manifest/assembled', String(ctx.json.assembled || '').includes('EVENT_CHAPTER_1') || String(ctx.json.story_memory || '').includes('EVENT_CHAPTER_1'));
ok('未来第101章事件不泄漏到第100章 Context', !String(ctx.json.assembled || '').includes('EVENT_CHAPTER_101'));
console.log(`\nMemory segments：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) process.exit(1);
