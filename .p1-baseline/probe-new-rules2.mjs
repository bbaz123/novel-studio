import { scanEditing } from '../ai/editing/scan.mjs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const html = String(db.prepare('SELECT content FROM chapters WHERE id = 121').get().content || '');
db.close();
const text = html.replace(/<\/p>/g, '\n').replace(/<[^>]*>/g, '').replace(/\n{2,}/g, '\n').trim();
const combos = [
  ['fiction-humanizer'],
  ['narrative-distance'],
  ['scene-logic'],
  ['style-density'],
  ['fiction-humanizer', 'narrative-distance', 'scene-logic', 'style-density'],
];
for (const abilities of combos) {
  const r = scanEditing(text, { abilities, genre: 'urban', task: 'review', characters: [{ name: '岳宸炎' }] });
  console.log(`\n=== ${abilities.join('+')} → ${r.findings.length} findings, skipped=${r.skipped.length} ===`);
  for (const f of r.findings) console.log(`  [${f.severity}] ${f.rule_id}${f.paragraph !== null ? ' p' + f.paragraph : ''} :: ${f.message.slice(0, 88)} | 摘录：${f.excerpt}`);
}
