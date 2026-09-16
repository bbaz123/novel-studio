#!/usr/bin/env node
/**
 * probe-d7-and-cast.mjs —— 两件事的侦察（只读）：
 *   1) D7：生产记忆库里的孤儿目录清单（数据库里有 ov_uri 的才是"活的"）
 *   2) D8-#3 续：角色表 vs "真正在章节里出现过的角色"，看两者差多少
 *      —— 差得多，说明护栏该按"出现过的人"取集合（用户 2026-09-16 的规格）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ── 1. 找到 OpenViking 的记忆库根 ───────────────────────────────────────────
// 实测位置：<workspace>\data\viking\<tenant>\user\default\resources\novel-studio
// （不是 `data/resources/...`——第一版按猜的路径找，三个候选全落空。）
const CANDIDATES = [
  path.resolve('..', 'data', 'viking', 'default', 'user', 'default'),
  path.resolve('data', 'viking', 'default', 'user', 'default'),
  path.resolve('..', 'data'),
  path.resolve('data'),
];
console.log('═══ 定位记忆库根 ═══');
let novelRoot = null;
for (const c of CANDIDATES) {
  const n = path.join(c, 'resources', 'novel-studio');
  const exists = fs.existsSync(n);
  console.log(`  ${exists ? '✓' : '·'} ${n}`);
  if (exists && !novelRoot) novelRoot = n;
}
if (!novelRoot) { console.log('\n没找到 resources/novel-studio —— 需要手工确认路径。'); process.exit(1); }

// ── 2. 数据库里的"活"作品 ───────────────────────────────────────────────────
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const works = db.prepare('SELECT id, title, ov_uri FROM works ORDER BY id').all();
const live = new Set(works.map((w) => String(w.ov_uri || w.id)));
console.log(`\n═══ 数据库里的活作品（${works.length} 部）═══`);
for (const w of works) console.log(`  #${w.id}  ov_uri=${w.ov_uri}  ${w.title}`);

// ── 3. 目录清单：活 / 孤儿 ──────────────────────────────────────────────────
const dirs = fs.readdirSync(novelRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const orphan = [], alive = [];
for (const name of dirs) {
  const p = path.join(novelRoot, name);
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else { files++; try { bytes += fs.statSync(q).size; } catch { /* 忽略 */ } }
    }
  };
  try { walk(p); } catch { /* 忽略 */ }
  const mtime = fs.statSync(p).mtime.toISOString();
  const rec = { name, files, bytes, mtime };
  if (live.has(name)) alive.push(rec); else orphan.push(rec);
}
const hex = orphan.filter((o) => /^[0-9a-f]{32}$/.test(o.name)).length;
const num = orphan.filter((o) => /^\d+$/.test(o.name)).length;
const other = orphan.length - hex - num;
console.log(`\n═══ 目录清单 ═══`);
console.log(`  总目录 ${dirs.length}：活 ${alive.length} / **孤儿 ${orphan.length}**（hex ${hex}、数字 ${num}、其它 ${other}）`);
console.log(`  孤儿文件合计 ${orphan.reduce((s, o) => s + o.files, 0)} 个、${(orphan.reduce((s, o) => s + o.bytes, 0) / 1048576).toFixed(1)} MB`);
console.log('  活目录：');
for (const a of alive) console.log(`    ✓ ${a.name}  ${a.files} 文件  ${a.mtime.slice(0, 10)}`);
const byDay = {};
for (const o of orphan) { const d = o.mtime.slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
console.log('  孤儿按 mtime 分布：' + Object.entries(byDay).sort().map(([d, n]) => `${d}:${n}`).join('  '));

// ── 4. 角色表 vs 章节里真正出现过的角色 ────────────────────────────────────
console.log('\n═══ 角色集合：整表 vs 章节里出现过的 ═══');
const chars = db.prepare('SELECT id, work_id, name FROM characters ORDER BY work_id, id').all();
const chapters = db.prepare('SELECT work_id, title, summary, blueprint_json, content FROM chapters').all();
for (const w of works) {
  const cs = chars.filter((c) => c.work_id === w.id);
  const chs = chapters.filter((c) => c.work_id === w.id);
  const hay = chs.map((c) => `${c.title || ''}\n${c.summary || ''}\n${c.blueprint_json || ''}\n${c.content || ''}`).join('\n');
  const mentioned = cs.filter((c) => hay.includes(c.name));
  const never = cs.filter((c) => !hay.includes(c.name));
  console.log(`  #${w.id} ${w.title}`);
  console.log(`    角色表 ${cs.length} 个 → 章节里出现过 ${mentioned.length} 个，**从未出现 ${never.length} 个**`);
  if (never.length) console.log(`    从未出现：${never.map((c) => c.name).join('、')}`);
}
db.close();
