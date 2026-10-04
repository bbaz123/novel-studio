import { scanEditing } from '../ai/editing/scan.mjs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const html = String(db.prepare('SELECT content FROM chapters WHERE id = 121').get().content || '');
db.close();
const text = html.replace(/<\/p>/g, '\n').replace(/<[^>]*>/g, '').replace(/\n{2,}/g, '\n').trim();
for (const abilities of [['fiction-humanizer'], ['style-density'], ['fiction-humanizer', 'style-density']]) {
  const r = scanEditing(text, { abilities, genre: 'urban', task: 'review', characters: [{ name: '岳宸炎' }] });
  console.log(`\n=== abilities=${JSON.stringify(abilities)} → ${r.findings.length} findings ===`);
  for (const f of r.findings) console.log(`  [${f.severity}] ${f.rule_id} :: ${f.message.slice(0, 96)}`);
  if (r.scanned.density) {
    const d = r.scanned.density;
    console.log(`  density: 套式动作 ${d.gesture_count}(${d.gesture_per_1000}/k, ${d.gesture_kinds}种) 过程交代 ${d.process_explanation_count}(${d.process_explanation_per_1000}/k) 叙述越界 ${d.narrator_intrusion_count}(${d.narrator_intrusion_per_1000}/k) 数字调出 ${JSON.stringify(d.callback_tokens)}`);
  }
}

