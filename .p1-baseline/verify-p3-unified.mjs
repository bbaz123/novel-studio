#!/usr/bin/env node
/**
 * P2 验收：主成文路径（P3 `/api/ai_context`）是否已收敛到唯一装配器。
 *
 * 断言（对应契约 I5 同源一致 / I6 所有 AI 路径走同一装配器）：
 *   1. `/api/ai_context` 返回 `assembled`（提示词文本由服务端装配器产出）
 *   2. 同一章的 `ai_context.assembled` 与 `/api/novel/context?mode=full` 的 `assembled`
 *      **逐字节相同**——两条路径渲染同一份数据必须一致
 *   3. 量化收敛效果：改造前 P3 的输入规模（各字段长度之和）vs 改造后的装配长度
 *
 * 用法: node verify-p3-unified.mjs <base> <db> [chapterId...]
 */
import { DatabaseSync } from 'node:sqlite';

const [base, dbPath, ...chapterArgs] = process.argv.slice(2);
if (!base || !dbPath) {
  console.error('用法: node verify-p3-unified.mjs <base> <db> [chapterId...]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const chapters = chapterArgs.length
  ? chapterArgs.map(Number)
  : db.prepare('SELECT id FROM chapters ORDER BY RANDOM() LIMIT 4').all().map((r) => r.id);

/** 改造前 P3 的输入规模：前端 aiContextBlock 会把这些字段拼进提示词（无预算）。 */
function legacyInputSize(ctx) {
  const len = (s) => (s ? String(s).length : 0);
  const chars = (ctx.characters || []).reduce((n, c) =>
    n + len(c.name) + len(c.identity) + len(c.personality) + len(c.background) + len(c.status) + len(c.mes_example) + len(c.system_prompt), 0);
  const world = (ctx.world_entries || []).reduce((n, w) => n + len(w.title) + len(w.content), 0);
  const recall = (ctx.semantic_recall?.hits || []).reduce((n, h) => n + len(h.text), 0);
  const events = (ctx.recent_events || []).reduce((n, e) => n + len(e.summary), 0);
  const fore = (ctx.open_foreshadows || []).reduce((n, f) => n + len(f.summary), 0);
  return chars + world + recall + events + fore + len(ctx.story_memory) + len(ctx.story_tail) + len(ctx.style_contract);
}

let pass = 0;
let fail = 0;

for (const id of chapters) {
  const ai = await (await fetch(`${base}/api/ai_context?chapter_id=${id}`)).json();
  const nv = await (await fetch(`${base}/api/novel/context?work_id=${ai.work?.id}&chapter_id=${id}&mode=full`)).json();

  const a = ai.assembled || '';
  const n = nv.assembled || '';
  const same = a.length > 0 && a === n;
  const before = legacyInputSize(ai);

  console.log(`章节 #${id}  《${ai.work?.title || '?'}》`);
  console.log(`  ai_context.assembled      = ${a.length} 字`);
  console.log(`  novel/context(full) 的     = ${n.length} 字`);
  console.log(`  断言 1（有 assembled）    = ${a.length > 0 ? '✓' : '✗'}`);
  console.log(`  断言 2（两条路径逐字节相同）= ${same ? '✓' : '✗'}`);
  console.log(`  改造前 P3 输入规模（无预算）= ${before} 字 → 现在 ${a.length} 字（${before > 0 ? Math.round((1 - a.length / before) * 100) : 0}% 收敛）`);
  const st = ai.context_stats;
  if (st) console.log(`  装配统计: 预算 ${st.budget} / 截断 ${st.truncatedLayers} 层 / 裁掉 ${st.droppedChars} 字 / 收缩 ${st.shrinkSteps} 步`);
  console.log('');

  if (same) pass++; else fail++;
}

db.close();
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
// 不用 process.exit()：那会在 fetch 的 keep-alive socket 仍打开时终止进程，
// 触发 libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言并把退出码弄成 0xC0000409。
process.exitCode = fail ? 1 : 0;
