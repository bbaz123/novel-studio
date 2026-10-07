// 只读探针：对活库里 pending 的记忆提案逐条跑一次零损失护栏判据，打印真实拒绝原因。
// 不改任何数据、不产生 AI 费用。用法：node .p1-baseline/probe-guard-verdict-20261006.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentMemoryUpdateVerdict, AGENT_GUARD_MARKER } from '../ai/memory-compress-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'novel.db'), { readOnly: true });

// 端点的口径（server.js agentMemoryGuardOf）
const plainText = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');

for (const w of db.prepare('SELECT id, title FROM works ORDER BY id').all()) {
  const chapters = db.prepare('SELECT title, summary, content FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(w.id);
  if (!chapters.length) continue;
  const characters = db.prepare('SELECT name FROM characters WHERE work_id = ? ORDER BY name ASC').all(w.id);
  const worldEntries = db.prepare('SELECT title FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(w.id);
  const chapterText = chapters.map((c) => `【${c.title}】${c.summary || ''} ${plainText(c.content || '')}`).join('\n');
  const storyChars = chapters.reduce((n, c) => n + String(c.content || '').length, 0);
  const props = db.prepare(`SELECT id, guard, summary FROM story_memory_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id`).all(w.id);
  if (!props.length) continue;
  console.log(`\n=== 作品 #${w.id} ${w.title}：${chapters.length} 章 / 正文 ${storyChars} 字 / 角色 ${characters.length} / 词条 ${worldEntries.length} ===`);
  for (const p of props) {
    const marked = p.guard === AGENT_GUARD_MARKER;
    const summary = String(p.summary || '');
    console.log(`\n-- 记忆提案 #${p.id} guard=${JSON.stringify(p.guard)}（${marked ? '会进护栏' : '作者路径，不进护栏'}）长度=${summary.length}`);
    if (!marked || !summary.trim()) { console.log('   → 采纳时不会调用护栏'); continue; }
    const v = agentMemoryUpdateVerdict({ characters, worldEntries, chapterText, summary, storyChars });
    console.log(`   ok=${v.ok}`);
    console.log(`   reasons=${JSON.stringify(v.reasons)}`);
    console.log(`   missing=${v.guard.missing.length} 个，前 20：${v.guard.missing.slice(0, 20).join('、')}`);
    console.log(`   invented=${v.invention.invented.length} 个，前 20：${v.invention.invented.slice(0, 20).join('、')}`);
  }
}
db.close();
