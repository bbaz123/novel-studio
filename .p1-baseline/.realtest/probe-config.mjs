#!/usr/bin/env node
/**
 * 只读探针：看作者真实库里的 api_configs（不回显密钥本体，只回显长度与前后缀指纹）。
 * 目的：确认「真实 provider 是否已配置好」这一前置条件，再决定要不要花钱跑质量回归。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.resolve(process.argv[2] || 'data/novel.db');
if (!fs.existsSync(dbPath)) { console.error('找不到库: ' + dbPath); process.exit(2); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT * FROM api_configs').all();
console.log(`库: ${dbPath}`);
console.log(`api_configs 行数: ${rows.length}`);
for (const r of rows) {
  const k = String(r.api_key ?? '');
  console.log(JSON.stringify({
    id: r.id,
    name: r.name,
    base_url: r.base_url,
    model: r.model,
    temperature: r.temperature,
    max_tokens: r.max_tokens,
    key_len: k.length,
    key_head: k.slice(0, 6),
    key_tail: k.slice(-4),
    key_is_placeholder: /test|fake|xxx|placeholder/i.test(k),
    is_active: r.is_active ?? r.active ?? null,
  }));
}
const works = db.prepare('SELECT id, title FROM works ORDER BY id').all();
console.log('\n作品: ' + works.map((w) => `${w.id}:${w.title}`).join(' | '));
for (const w of works.slice(-3)) {
  const chs = db.prepare('SELECT id, chapter_index, title, length(content) AS len FROM chapters WHERE work_id = ? ORDER BY chapter_index DESC LIMIT 5').all(w.id);
  console.log(`\n作品 #${w.id} ${w.title} 最近章: ` + chs.map((c) => `#${c.id}(idx${c.chapter_index}, ${c.len}字) ${c.title || ''}`).join(' | '));
}
db.close();
