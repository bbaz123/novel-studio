#!/usr/bin/env node
/** 打印关键表的列定义（用于构造合法的压测数据）。用法: node schema-dump.mjs [db] */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2] || '.p1-baseline/data/novel.db', { readOnly: true });
const tables = process.argv.slice(3);
const list = tables.length
  ? tables
  : ['works', 'volumes', 'plotlines', 'chapters', 'characters', 'character_relations', 'world_entries', 'story_events', 'story_memories', 'writing_redlines'];

for (const t of list) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  if (!cols.length) { console.log(`\n### ${t} —— 不存在`); continue; }
  console.log(`\n### ${t}`);
  for (const c of cols) {
    const flags = [c.notnull ? 'NOT NULL' : '', c.pk ? 'PK' : '', c.dflt_value !== null ? `DEFAULT ${c.dflt_value}` : ''].filter(Boolean).join(' ');
    console.log(`  ${c.name.padEnd(24)} ${String(c.type).padEnd(10)} ${flags}`);
  }
}
db.close();
