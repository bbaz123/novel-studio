#!/usr/bin/env node
/** 只读探针 2：列出故事状态相关表 + 作者真实作品 #18 的章节结构。 */
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log('表（' + tables.length + '）：\n' + tables.join('\n'));
console.log('\n--- 作品 #18 章节 ---');
for (const c of db.prepare('SELECT id,position,title,length(content) AS len FROM chapters WHERE work_id=18 ORDER BY position').all()) {
  console.log(`${c.id}\tpos=${c.position}\t${c.len}字\t${c.title}`);
}
console.log('\n--- 作品 #18 设定/风格字段 ---');
const w = db.prepare('SELECT * FROM works WHERE id=18').get();
for (const [k, v] of Object.entries(w)) {
  const s = String(v ?? '');
  console.log(`  ${k}: ${s.length > 120 ? s.slice(0, 120) + `…(${s.length}字)` : s}`);
}
console.log('\n--- 角色/词条/剧情线 计数 ---');
for (const t of tables) {
  if (/character|entity|plotline|foreshadow|timeline|story_state|setting|world|memory/.test(t)) {
    try { console.log(`  ${t}: ${db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n}`); } catch (e) { console.log(`  ${t}: ERR ${e.message}`); }
  }
}
db.close();
