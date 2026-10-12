// 诊断：一致性检测在**真实历史报告**上为什么报出 6/12（逐条打印命中的绝对措辞与匹配到的 issue）。
// 只读；摘录 ≤70 字。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const src = fs.readFileSync('ai/editing/narrative-review.mjs', 'utf8');
// 取真实实现里的 ABSOLUTE_CLAIM 与 topicGrams/STOP（避免复制判据导致漂移）
const m = src.match(/const ABSOLUTE_CLAIM = \[([\s\S]*?)\n\];/);
console.log('ABS 定义摘录:\n', m ? m[1].trim() : '(未找到)');
const stopM = src.match(/const STOP = new Set\(\[([\s\S]*?)\]\);/);
console.log('\nSTOP 摘录:', stopM ? stopM[1].replace(/\s+/g, ' ').trim() : '(未找到)');

const db = new DatabaseSync('data/novel.db', { readOnly: true });
const rows = db.prepare('SELECT id, chapter_id, report_json FROM chapter_reviews ORDER BY id').all();

// 用真实实现导出的能力复算；同时手工复现"哪个 pattern 命中"
const { checkReportConsistency } = await import(new URL('../ai/editing/narrative-review.mjs', import.meta.url).href);

for (const r of rows) {
  let rep = null; try { rep = JSON.parse(r.report_json); } catch (_) {}
  if (!rep) continue;
  const strengths = (rep.strengths || []).map((s) => String((s && s.text) || s));
  const issues = (rep.issues || []).map((s) => String((s && s.text) || s));
  const ch = db.prepare('SELECT content FROM chapters WHERE id = ?').get(r.chapter_id);
  const text = String((ch && ch.content) || '').replace(/<[^>]*>/g, '');
  const c = checkReportConsistency({ strengths, issues, text });
  if (c.status !== 'needs_calibration') { console.log(`\n[review ${r.id}] ok`); continue; }
  console.log(`\n[review ${r.id}] needs_calibration (${c.conflicts.length})`);
  for (const cf of c.conflicts) {
    console.log('  type   :', cf.type);
    console.log('  strength:', String(cf.strength).slice(0, 70));
    console.log('  issue   :', String(cf.issue).slice(0, 70));
  }
}
db.close();
