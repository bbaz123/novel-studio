// 只读复算：不改任何数据，纯粹按 server.js 的真实判据复算"一次采纳"会得到什么。
// 目的：把报错里的「达标 14/13，护栏拦下 #1」在活库上逐条算出来。
// 用法：node .p1-baseline/probe-repro-14-13-20261006.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentMemoryUpdateVerdict, AGENT_GUARD_MARKER } from '../ai/memory-compress-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'novel.db'), { readOnly: true });
const plainText = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
const mergeMemoryDraft = (prev, delta) => {
  const base = (prev || '').trim(); const d = (delta || '').trim();
  if (!d) return base; if (!base) return d; return `${d}\n\n【此前进度】${base}`;
};

const WORK = 18;
// ① 先看界面能勾到什么：结果弹窗把两张表的提案混在一个列表里渲染，
//    复选框值是裸 id（app.js:10057 `data-proposal-id="${Number(p.id)}"`），没有表名。
const events = db.prepare(`SELECT id, status FROM story_event_proposals WHERE work_id = ? ORDER BY id`).all(WORK);
const memories = db.prepare(`SELECT id, status, guard, summary, delta FROM story_memory_proposals WHERE work_id = ? ORDER BY id`).all(WORK);
console.log('事件提案 id：', events.map((e) => `${e.id}(${e.status})`).join(' '));
console.log('记忆提案 id：', memories.map((m) => `${m.id}(${m.status}, guard=${m.guard || '空'})`).join(' '));

// 全部勾中（弹窗默认全选）→ 复选框值就是两张表 id 的并集，且 id 会重复。
const checkedRaw = [...events.map((e) => e.id), ...memories.map((m) => m.id)];
const legacySel = [...new Set(checkedRaw.filter((n) => n > 0))];   // server.js adopt 里的 dedupe
console.log('\n复选框原始值：', checkedRaw.join(','));
console.log('去重后 legacy_proposal_ids =', JSON.stringify(legacySel), `→ legacySel.length = ${legacySel.length}`);

// ② 复算 settleProposalsInTx（server.js:2826-2882）的真实行为
const inList = (arr) => arr.filter((r) => legacySel.includes(Number(r.id)));
const eventRows = inList(db.prepare(`SELECT * FROM story_event_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id`).all(WORK));
const memoryRows = inList(db.prepare(`SELECT * FROM story_memory_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id`).all(WORK));
console.log(`\nids=[${legacySel.join(',')}] 在两张表里各命中：事件 ${eventRows.length} 条（#${eventRows.map((r) => r.id).join('、#')}）、记忆 ${memoryRows.length} 条（#${memoryRows.map((r) => r.id).join('、#')}）`);
console.log('⚠ 后两张表是各自独立的 id 序列，"事件 #1" 与 "记忆 #1" 是不同行的同号提案 —— 裸 id 无法区分。');

const chapters = db.prepare('SELECT title, summary, content FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(WORK);
const characters = db.prepare('SELECT name FROM characters WHERE work_id = ? ORDER BY name ASC').all(WORK);
const worldEntries = db.prepare('SELECT title FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(WORK);
const chapterText = chapters.map((c) => `【${c.title}】${c.summary || ''} ${plainText(c.content || '')}`).join('\n');
const storyChars = chapters.reduce((n, c) => n + String(c.content || '').length, 0);
const prevMemory = (() => { try { return String(db.prepare('SELECT summary FROM story_memory WHERE work_id = ?').get(WORK)?.summary || ''); } catch (_) { return ''; } })();

const applied = { events: 0, memories: 0 };
const rejected = { events: 0, memories: 0 };
const guardFailed = [];
for (const p of eventRows) applied.events += 1;
for (const p of memoryRows) {
  let summary = String(p.summary || '');
  if (!summary && p.delta) summary = mergeMemoryDraft(prevMemory, p.delta);
  if (summary.trim()) {
    if (p.guard === AGENT_GUARD_MARKER && String(p.summary || '').trim()) {
      const v = agentMemoryUpdateVerdict({ characters, worldEntries, chapterText, summary, storyChars });
      if (!v.ok) { guardFailed.push({ proposal_id: p.id, reasons: v.reasons }); continue; }
    }
    applied.memories += 1;
  } else rejected.memories += 1;
}
const appliedCount = applied.events + applied.memories;
console.log('\n--- 复算结果（与 server.js:7131-7136 同一判据）---');
console.log(`applied = ${JSON.stringify(applied)}`);
console.log(`guard_failed = ${JSON.stringify(guardFailed)}`);
console.log(`appliedCount = ${appliedCount} ; legacySel.length = ${legacySel.length}`);
console.log(`\nserver.js:7134 的两个拒绝条件：`);
console.log(`  failed.length > 0 ?            ${guardFailed.length ? '真 → 抛错' : '假'}`);
console.log(`  appliedCount !== legacySel.length ? ${appliedCount !== legacySel.length ? `真（${appliedCount} !== ${legacySel.length}）→ 抛错` : '假'}`);
console.log(`\n最终报错文本：旧提案未全部入账（达标 ${appliedCount}/${legacySel.length}${guardFailed.length ? `，护栏拦下 #${guardFailed.map((g) => g.proposal_id).join('、#')}` : ''}）——已整次回滚`);
db.close();
