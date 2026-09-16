#!/usr/bin/env node
/**
 * 压力数据生成器（P1-d）。
 *
 * 为什么必须要有它：真实库只有 2 部小作品，装配结果 5,196–9,210 字，**没有任何一层被截断**，
 * 收敛循环从未触发。历史失误 2 —— 用当前小数据验证与规模相关的断言（如 assembled<=12000）
 * 会「侥幸通过」，在百章规模必然假失败/假成功。规模断言必须在压力数据上跑。
 *
 * 本生成器造一部「每一层都顶到 cap」的作品，使装配进入收敛分支：
 *   120 章 / 50 角色 / 60 世界词条 / 150 事件（含 40 未闭合伏笔）/ 超长长期记忆 / 大量红线。
 *
 * 用法:
 *   node make-stress.mjs --db .p1-baseline/stress-data/novel.db
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DB = arg('--db', '.p1-baseline/stress-data/novel.db');
const N_CHAPTERS = Number(arg('--chapters', 120));
const N_CHARS = Number(arg('--characters', 50));
const TITLE = arg('--title', '压力测试·百章五十人');

/** 生成确定性的伪随机中文文本（不用 Math.random，保证可复现）。 */
const WORDS = ['雾','潮','缝','针','灯','巷','钟','信','线','影','霜','渡','窑','砚','苔','隼','锚','釉','檐','烬'];
function text(n, seed) {
  let s = '';
  let x = seed >>> 0;
  while (s.length < n) {
    x = (x * 1664525 + 1013904223) >>> 0;
    s += WORDS[x % WORDS.length];
    if (s.length % 17 === 0) s += '，';
    if (s.length % 53 === 0) s += '。';
  }
  return s.slice(0, n);
}

fs.mkdirSync(path.dirname(DB), { recursive: true });
if (!fs.existsSync(DB)) {
  console.error(`库不存在：${DB}\n请先从真实库副本初始化（含表结构），或先启动一次服务让其建表。`);
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys = ON');

// 幂等：先清掉同名旧作品
const old = db.prepare('SELECT id FROM works WHERE title = ?').get(TITLE);
if (old) {
  const wid = old.id;
  for (const t of ['chapters', 'characters', 'character_relations', 'world_entries', 'story_events', 'story_memories', 'writing_redlines', 'volumes', 'plotlines', 'memory_versions']) {
    try { db.prepare(`DELETE FROM ${t} WHERE work_id = ?`).run(wid); } catch { /* 表可能不存在 */ }
  }
  db.prepare('DELETE FROM works WHERE id = ?').run(wid);
  console.log(`已清理同名旧作品 #${wid}`);
}

const now = new Date().toISOString();
const workId = db
  .prepare(
    `INSERT INTO works (title, description, created_at, updated_at, default_chapter_words, total_chapters, story_structure, narrative_pov, style_positive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    TITLE,
    text(700, 11),          // 作品描述：逼近「作品」层 cap 900
    now, now,
    3000,                    // 每章目标字数
    N_CHAPTERS,
    '三幕式',
    '第三人称限知',
    text(500, 12),           // 正向风格契约
  ).lastInsertRowid;

// ── 卷 / 剧情线 ──────────────────────────────────────────────────────────
for (let i = 0; i < 3; i++) {
  db.prepare('INSERT INTO volumes (work_id, title, summary, position, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(workId, `第${i + 1}卷 ${text(6, 100 + i)}`, text(400, 200 + i), i, now, now);
}
const plotlineIds = [];
for (let i = 0; i < 5; i++) {
  const r = db.prepare('INSERT INTO plotlines (work_id, title, kind, summary, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(workId, `${i === 0 ? '主线' : '支线'}${i + 1}·${text(6, 300 + i)}`, i === 0 ? 'main' : 'side', text(400, 400 + i), i, now, now);
  plotlineIds.push(r.lastInsertRowid);
}

// ── 角色（50 个，字段给足，用于触发角色卡 5 级降级与兜底截断）──────────────
const charIds = [];
for (let i = 0; i < N_CHARS; i++) {
  const r = db.prepare(
    `INSERT INTO characters (work_id, name, identity, appearance, personality, background, status, mes_example, tags, system_prompt, aliases, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    workId,
    `角色${String(i + 1).padStart(2, '0')}·${text(3, 500 + i)}`,
    `${text(20, 600 + i)}`,                 // 身份
    text(500, 700 + i),                     // 外貌 500
    `${text(60, 800 + i)}`,                 // 性格 60
    text(900, 900 + i),                     // 背景 900（远超单卡降级首档 500）
    `${text(30, 1000 + i)}`,                // 当前状态
    text(600, 1100 + i),                    // 对话示例 600
    `主角,${text(20, 1200 + i)}`,           // 标签
    text(700, 1300 + i),                    // 角色系统提示 700
    text(12, 1400 + i),                     // 别名
    now, now,
  );
  charIds.push(r.lastInsertRowid);
}

// ── 人物关系（30 条，逼近「人物关系」层 cap 800）──────────────────────────
for (let i = 0; i < 30; i++) {
  db.prepare('INSERT INTO character_relations (work_id, from_character_id, to_character_id, relation, description) VALUES (?,?,?,?,?)')
    .run(workId, charIds[i % N_CHARS], charIds[(i + 1) % N_CHARS], ['师徒', '宿敌', '同门', '债主', '血亲'][i % 5], text(300, 2000 + i));
}

// ── 世界词条（60 条，其中 10 条置顶；每条 900 字，触发世界观层 cap 3000）──
for (let i = 0; i < 60; i++) {
  db.prepare('INSERT INTO world_entries (work_id, title, content, keywords, is_pinned, position, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(
      workId,
      `设定${String(i + 1).padStart(2, '0')}·${text(4, 3000 + i)}`,
      text(900, 3100 + i),
      i < 10 ? `${text(4, 3200 + i)}` : `雾,${text(3, 3300 + i)}`,   // 前 10 条置顶，其余靠关键词
      i < 10 ? 1 : 0,
      i,
      90 - i,
      now, now,
    );
}

// ── 章节（120 章；正文长短相间，摘要给足）────────────────────────────────
const chapterIds = [];
for (let i = 0; i < N_CHAPTERS; i++) {
  const isTarget = i === N_CHAPTERS - 1;
  const contentLen = isTarget ? 12000 : (i % 5 === 0 ? 4000 : 800);
  const r = db.prepare(
    `INSERT INTO chapters (work_id, volume_id, plotline_id, title, summary, content, position, created_at, updated_at, author_note, blueprint_json, target_words, context_character_ids)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    workId,
    null,
    plotlineIds[i % plotlineIds.length],
    `第${i + 1}节 ${text(8, 4000 + i)}`,
    text(260, 4100 + i),                                     // 摘要 260（大纲层按 120 截断）
    text(contentLen, 5000 + i),                              // 正文
    i,
    now, now,
    text(150, 6000 + i),                                     // 作者注
    i === N_CHAPTERS - 1
      ? JSON.stringify({
          scene_goal: text(900, 7000), plot_points: text(900, 7001), conflicts: text(900, 7002),
          character_changes: text(900, 7003), hook: text(900, 7004), references: text(900, 7005),
        })
      : '{}',
    3000,
    i === N_CHAPTERS - 1 ? charIds.slice(0, 16).join(',') : '',
  );
  chapterIds.push(r.lastInsertRowid);
}

// ── 事件账本（150 条，含 40 条未闭合伏笔；每条 300 字，触发多层 cap）──────
for (let i = 0; i < 150; i++) {
  const isForeshadow = i % 4 === 0 && i < 160;
  db.prepare('INSERT INTO story_events (work_id, chapter_id, kind, summary, payload, created_at, foreshadow_status, dedup_key) VALUES (?,?,?,?,?,?,?,?)')
    .run(
      workId,
      chapterIds[i % N_CHAPTERS],
      isForeshadow ? 'foreshadow' : 'event',
      text(300, 8000 + i),
      '{}',
      new Date(Date.now() - (150 - i) * 3600_000).toISOString(),
      isForeshadow ? 'open' : '',
      `stress-${workId}-${i}`,
    );
}

// ── 长期记忆（超长，触发压缩提示线 1200 与 cap 2200）─────────────────────
db.prepare('INSERT INTO story_memories (work_id, summary, updated_at) VALUES (?,?,?)')
  .run(workId, text(9000, 9999), now);

// ── 写作红线（多条长规则，逼近红线层 cap 4000）──────────────────────────
for (let i = 0; i < 40; i++) {
  db.prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note, enabled, created_at, exceptions) VALUES (?,?,?,?,?,?,?)')
    .run(workId, 'phrase', `${text(30, 10000 + i)}`, text(60, 11000 + i), 1, now, '');
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const stat = (sql) => db.prepare(sql).get(workId);
console.log(`\n压力作品已建: #${workId}  ${TITLE}`);
console.log(`  章节 ${stat('SELECT COUNT(*) c FROM chapters WHERE work_id=?').c}  正文合计 ${stat('SELECT COALESCE(SUM(LENGTH(content)),0) n FROM chapters WHERE work_id=?').n} 字`);
console.log(`  角色 ${stat('SELECT COUNT(*) c FROM characters WHERE work_id=?').c}  词条 ${stat('SELECT COUNT(*) c FROM world_entries WHERE work_id=?').c}  关系 ${stat('SELECT COUNT(*) c FROM character_relations WHERE work_id=?').c}`);
console.log(`  事件 ${stat('SELECT COUNT(*) c FROM story_events WHERE work_id=?').c}（未闭合伏笔 ${stat("SELECT COUNT(*) c FROM story_events WHERE work_id=? AND kind='foreshadow' AND foreshadow_status='open'").c}）  红线 ${stat('SELECT COUNT(*) c FROM writing_redlines WHERE work_id=?').c}`);
console.log(`  长期记忆 ${stat('SELECT LENGTH(summary) n FROM story_memories WHERE work_id=?').n} 字`);
console.log(`  目标章节: 最后一章 #${chapterIds[chapterIds.length - 1]}`);
db.close();
