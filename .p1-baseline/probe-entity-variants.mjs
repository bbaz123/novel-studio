#!/usr/bin/env node
/**
 * probe-entity-variants.mjs —— 用**真实库里的角色名**验证实体变体拆分。
 *
 * 由来：2026-09-16 一次真实压缩调用里，护栏把 11 个角色判成"丢失"并拒绝了整次压缩，
 * 而模型其实写了 `乔明山"乔半醒"`、`小满`、`老白婆婆` 这些**简称**——
 * 逐字比对带括号别名的完整串是假阳性。这个探针把真实名字喂给拆分函数，人眼可核对。
 *
 * 用法: node .p1-baseline/probe-entity-variants.mjs [db路径]
 */
import { DatabaseSync } from 'node:sqlite';
import { entityVariants } from '../ai/memory-compress-guard.mjs';

const dbPath = process.argv[2] || '.p1-baseline/data/novel.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT DISTINCT name FROM characters ORDER BY name').all();
db.close();

console.log(`═══ 实体变体拆分（${dbPath}，${rows.length} 个角色名）═══\n`);
let multi = 0;
for (const r of rows) {
  const v = entityVariants(r.name);
  if (v.length > 1) multi++;
  const mark = v.length > 1 ? '  ' : '  ';
  console.log(`${mark}${String(r.name).padEnd(34, '　')} → ${JSON.stringify(v)}`);
}
console.log(`\n合计 ${rows.length} 个名字，其中 ${multi} 个能拆出多个可接受写法。`);
console.log('判据：只要**任一**写法出现在压缩结果里，就算这个实体没丢。');
