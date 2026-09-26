#!/usr/bin/env node
/**
 * verify-memory-compress-input.mjs —— 记忆压缩**提示词输入**的前后对照（离线、只读、零计费）。
 *
 * 为什么需要：`compressStoryMemory` 的提示词决定压缩器能看见什么，而被压缩出的长期记忆会喂给
 * 之后**每一章**。2026-09-24 修掉一个静默缺陷：提示词引用了 2026-09-21 已被删除的
 * `content_head` / `content_tail` 查询别名 → `pl ainTextHead(undefined)` 恒为空串 →
 *   · 「最近章节尾部」那一段**永远是空的**（只剩三个标题）；
 *   · 没有摘要的章节在"全部章节摘要"里也只剩标题。
 * 本工具用**真实作品的章节数据**把"修之前模型看到多少字 / 修之后看到多少字"量出来。
 *
 * 它**不调用任何模型**，只做纯文本处理；数据库一律**只读**打开（真实库可能正被主实例使用）。
 *
 * 用法:
 *   node .p1-baseline/verify-memory-compress-input.mjs [--db data/novel.db] [--work 2] [--json]
 *   node .p1-baseline/verify-memory-compress-input.mjs --db .p1-baseline/stress-data/novel.db --all
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { plainTextHead, plainTextTail } from '../text-utils.js';
import { buildChapterPromptText, SUMMARY_BUDGET, TAIL_BUDGET, TAIL_COUNT } from '../ai/memory-compress-prompt.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DB = arg('--db', path.join('data', 'novel.db'));
const WORK = Number(arg('--work', '0')) || 0;
const ALL = process.argv.includes('--all');
const AS_JSON = process.argv.includes('--json');

if (!fs.existsSync(DB)) {
  console.error(`找不到数据库：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB, { readOnly: true });
const works = ALL
  ? db.prepare('SELECT id, title FROM works ORDER BY id ASC').all()
  : db.prepare('SELECT id, title FROM works WHERE id = ?').all(WORK || 2);
if (!works.length) {
  console.error(`库里没有作品 #${WORK}`);
  process.exit(1);
}

/** 修复前的逐行压缩（与旧实现逐字相同）。 */
function compactLinesWithinBudget(text, budget) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const cap = Math.max(1, Math.floor(budget / lines.length));
  let result = '';
  for (const line of lines) {
    const clipped = line.length > cap ? `${line.slice(0, cap)}…` : line;
    if ((result ? result.length + 1 : 0) + clipped.length > budget) break;
    result += (result ? '\n' : '') + clipped;
  }
  return result;
}

/**
 * 修复前的组装：**忠实复现**——章节行来自 `SELECT title, summary, content`，
 * 所以 `c.content_head` / `c.content_tail` 是 `undefined`，两个 helper 收到 undefined 后
 * 走参数默认值 ''，于是这两段恒为空白（这正是缺陷本身，不是把 undefined 写成字面量）。
 */
function buildBefore(chapters) {
  const summaries = chapters.map((c) => `【${c.title}】${c.summary || plainTextHead(c.content_head, SUMMARY_HEAD)}`).join('\n');
  const summaryText = compactLinesWithinBudget(summaries, SUMMARY_BUDGET);
  const recent = chapters.slice(-TAIL_COUNT).map((c) => `【${c.title} · 章节尾部】${plainTextTail(c.content_tail, TAIL_CHARS)}`).join('\n');
  const tailText = compactLinesWithinBudget(recent, TAIL_BUDGET);
  return `${summaryText}\n${tailText}`.trim();
}
const SUMMARY_HEAD = 260;
const TAIL_CHARS = 700;

/** 只看正文部分（去掉 `【…】` 前缀），避免把标题长度算成内容。 */
const bodyOf = (line) => line.replace(/^【[^\n]*?】/, '').trim();
const tailLines = (t) => t.split('\n').filter((l) => l.includes('章节尾部'));

const rows = [];
for (const w of works) {
  const chapters = db.prepare(
    'SELECT title, summary, content FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC'
  ).all(w.id);
  if (!chapters.length) continue;

  const before = buildBefore(chapters);
  const after = buildChapterPromptText(chapters);

  const lastN = chapters.slice(-TAIL_COUNT);
  const lastNWithProse = lastN.filter((c) => String(c.content || '').trim().length > 0).length;
  const latest = chapters[chapters.length - 1];
  const latestTail = plainTextTail(latest.content || '', 120);

  rows.push({
    work_id: w.id,
    title: w.title,
    chapters: chapters.length,
    no_summary: chapters.filter((c) => !String(c.summary || '').trim()).length,
    before_chars: before.length,
    after_chars: after.length,
    before_tail_body_chars: tailLines(before).reduce((n, l) => n + bodyOf(l).length, 0),
    after_tail_body_chars: tailLines(after).reduce((n, l) => n + bodyOf(l).length, 0),
    empty_prose_chapters: chapters.filter((c) => !String(c.content || '').trim()).length,
    last_n_with_prose: lastNWithProse,
    latest_tail_expected: latestTail.length > 0,
    after_contains_latest_tail: latestTail.length > 0 && after.includes(latestTail),
  });
}

let bad = 0;
for (const r of rows) {
  // 判据：修前尾部正文必须为 0（缺陷）；修后必须 > 0 —— 除非最近几章**正文本来就是空的**。
  const afterOk = r.after_tail_body_chars > 0 || r.last_n_with_prose === 0;
  const latestOk = r.after_contains_latest_tail || !r.latest_tail_expected;
  if (r.before_tail_body_chars !== 0) bad++;
  if (!afterOk) bad++;
  if (!latestOk) bad++;
}
const verdict = bad === 0
  ? '结论：前后对照成立——修前"最近章节尾部"恒为空（0 字），修后带上了最近几章的正文，且最新一章的正文结尾确实进了提示词。'
  : `结论：有 ${bad} 项不符合预期，需要人工看一眼。`;

if (AS_JSON) {
  console.log(JSON.stringify({ db: DB, verdict, rows }, null, 2));
} else {
  console.log(`数据库（只读）：${DB}\n`);
  for (const r of rows) {
    console.log(`作品 #${r.work_id}　${r.title}（${r.chapters} 章；无摘要 ${r.no_summary} 章；正文为空 ${r.empty_prose_chapters} 章）`);
    console.log(`  「章节」段总字数        修前 ${r.before_chars}　→　修后 ${r.after_chars}`);
    console.log(`  其中"最近章节尾部"正文    修前 ${r.before_tail_body_chars} 字　→　修后 ${r.after_tail_body_chars} 字`);
    console.log(`  最新一章正文结尾是否进提示词：${r.latest_tail_expected ? (r.after_contains_latest_tail ? '是' : '否 ← 需要看一眼') : '（该章正文为空，不适用）'}`);
    console.log('');
  }
  console.log(verdict);
}
process.exitCode = bad === 0 ? 0 : 1;