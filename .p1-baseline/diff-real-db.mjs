#!/usr/bin/env node
/**
 * 真实库 vs 副本：逐表对比，查清 20:47 那次写入到底改了什么。
 * 副本（.p1-baseline/data/novel.db）是 2026-09-15 20:20 的快照，早于那次写入。
 *
 * 用法: node diff-real-db.mjs
 */
import { DatabaseSync } from 'node:sqlite';

const REAL = 'data/novel.db';
const COPY = '.p1-baseline/data/novel.db';

const open = (p) => new DatabaseSync(p, { readOnly: true });
const real = open(REAL);
const copy = open(COPY);

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const tReal = tables(real);
const tCopy = tables(copy);

console.log('═══ 表集合差异 ═══');
const onlyReal = tReal.filter((t) => !tCopy.includes(t));
const onlyCopy = tCopy.filter((t) => !tReal.includes(t));
console.log(`  真实库 ${tReal.length} 张 / 副本 ${tCopy.length} 张`);
console.log(`  仅真实库有: ${onlyReal.join(', ') || '(无)'}`);
console.log(`  仅副本有  : ${onlyCopy.join(', ') || '(无)'}`);

console.log('\n═══ 逐表行数对比 ═══');
let changed = 0;
for (const t of tReal.filter((x) => tCopy.includes(x))) {
  if (t === 'sqlite_sequence') continue;
  const a = real.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  const b = copy.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  if (a !== b) { changed++; console.log(`  ⚠ ${t.padEnd(24)} 真实=${a}  副本=${b}  差 ${a - b}`); }
}
if (!changed) console.log('  （所有表行数一致）');

console.log('\n═══ 今日（2026-09-15）新增日志 ═══');
try {
  const rows = real.prepare("SELECT ts, layer, level, kind, substr(message,1,70) AS m FROM app_logs WHERE ts >= '2026-09-15' ORDER BY id").all();
  console.log(`  共 ${rows.length} 条`);
  for (const r of rows.slice(0, 10)) console.log(`   ${r.ts}  [${r.layer}/${r.level}] ${r.kind}  ${r.m}`);
} catch (e) { console.log('  查询失败：' + e.message); }

console.log('\n═══ app_settings 对比 ═══');
const keysOf = (db) => db.prepare('SELECT key, value FROM app_settings ORDER BY key').all();
const kr = keysOf(real); const kc = keysOf(copy);
const mapOf = (rows) => new Map(rows.map((r) => [r.key, r.value]));
const mr = mapOf(kr); const mc = mapOf(kc);
for (const [k, v] of mr) {
  if (!mc.has(k)) console.log(`  + ${k} = ${String(v).slice(0, 60)}`);
  else if (mc.get(k) !== v) console.log(`  ~ ${k}: 副本=${String(mc.get(k)).slice(0, 40)} → 真实=${String(v).slice(0, 40)}`);
}
for (const k of mc.keys()) if (!mr.has(k)) console.log(`  - ${k}（仅副本有）`);

console.log('\n═══ 内容抽查：作品与章节是否被改动 ═══');
for (const w of real.prepare('SELECT id, title, updated_at FROM works ORDER BY id').all()) {
  const c = copy.prepare('SELECT title, updated_at FROM works WHERE id = ?').get(w.id);
  const same = c && c.title === w.title && c.updated_at === w.updated_at;
  console.log(`  work#${w.id} ${same ? '一致' : '**不一致**'}  updated_at=${w.updated_at}`);
}
for (const ch of real.prepare('SELECT id, title, LENGTH(content) AS n, updated_at FROM chapters ORDER BY id').all()) {
  const c = copy.prepare('SELECT title, LENGTH(content) AS n, updated_at FROM chapters WHERE id = ?').get(ch.id);
  const same = c && c.title === ch.title && c.n === ch.n && c.updated_at === ch.updated_at;
  console.log(`  chapter#${ch.id} ${same ? '一致' : '**不一致**'}  正文=${ch.n}字`);
}

real.close(); copy.close();
