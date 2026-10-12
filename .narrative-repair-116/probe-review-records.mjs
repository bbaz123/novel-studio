// 只读取证：历史审稿记录与修稿选择的**结构**（用于 N5「实际勾选/原始补丁」与 N6「自洽检测真实阳性」）。
// ⚠️ 只打印结构、计数、id 与短摘录（≤60 字，用于核对判据是否命中）；不整段导出作者作品。
import { DatabaseSync } from 'node:sqlite';
import { structureReviewReport } from '../ai/editing/narrative-review.mjs';

const db = new DatabaseSync('data/novel.db', { readOnly: true });

console.log('=== revision_selections（真实勾选）===');
for (const r of db.prepare('SELECT * FROM revision_selections ORDER BY id').all()) {
  console.log(JSON.stringify({
    id: r.id, chapter_id: r.chapter_id, review_id: r.review_id,
    selected: r.selected_issue_ids_json, selection_hash: String(r.selection_hash || '').slice(0, 24),
    plan_hash: String(r.plan_hash || '').slice(0, 24), source: r.source, created_at: r.created_at,
  }));
}

console.log('\n=== chapter_reviews（历史审稿报告）===');
const rows = db.prepare('SELECT id, chapter_id, status, report_json, created_at FROM chapter_reviews ORDER BY id').all();
for (const r of rows) {
  let rep = null;
  try { rep = JSON.parse(r.report_json); } catch (_) {}
  const has = (k) => Array.isArray(rep && rep[k]) ? rep[k].length : (rep && rep[k] != null ? 1 : 0);
  console.log(JSON.stringify({
    id: r.id, chapter_id: r.chapter_id, status: r.status, created_at: r.created_at,
    keys: rep ? Object.keys(rep).slice(0, 12) : null,
    summary_len: String((rep && rep.summary) || '').length,
    issues: has('issues'), strengths: has('strengths'), deferred: has('deferred'),
    findings: has('findings'), rejected: has('rejected'),
    has_consistency: !!(rep && rep.consistency),
  }));
}

// N6：用**真实实现**看历史报告里有没有"优点与问题互相否认"的真实阳性
console.log('\n=== N6：对历史报告跑 checkReportConsistency（真实实现，零计费）===');
let anyConflict = 0;
for (const r of rows) {
  let rep = null;
  try { rep = JSON.parse(r.report_json); } catch (_) {}
  if (!rep) continue;
  const ch = db.prepare('SELECT content FROM chapters WHERE id = ?').get(r.chapter_id);
  const text = String((ch && ch.content) || '').replace(/<[^>]*>/g, '');
  const s = structureReviewReport(rep, { text });
  const c = s.consistency || { status: 'n/a', conflicts: [] };
  if (c.status === 'needs_calibration') {
    anyConflict += 1;
    console.log(`  [review ${r.id} ch${r.chapter_id}] needs_calibration →`, JSON.stringify(c.conflicts.map((x) => ({ type: x.type, strength: String(x.strength).slice(0, 50), reason: String(x.reason).slice(0, 70) }))));
  } else {
    console.log(`  [review ${r.id} ch${r.chapter_id}] ${c.status}`);
  }
}
console.log('\nneeds_calibration 命中数 =', anyConflict, '/', rows.length);

db.close();
