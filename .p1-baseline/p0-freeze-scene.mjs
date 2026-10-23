// 阶段0：冻结现场（只读源库，只写备份目录）。
//
// 为什么先做这一步再做任何代码改动：本方案要在采纳事务里加基线闸门，一旦写错，
// 受影响的是作者 4623 字的真实正文。先落一份整库快照 + 可读的 JSON 取证，
// 之后任何一步翻车都能整库回滚，而不是靠"我记得当时正文是什么"。
//
// 用法：node .p1-baseline/p0-freeze-scene.mjs [--work=18] [--chapter=119] [--dir=<备份目录>]
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i === -1 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
    })
);
const workId = Number(args.work) || 18;
const chapterId = Number(args.chapter) || 119;
const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '');
const outDir = resolve(args.dir || join('data', `backup-p0-merge-guard-${stamp}`));
if (existsSync(outDir) && !args.dir) throw new Error('备份目录已存在（拒绝覆盖）：' + outDir);
mkdirSync(outDir, { recursive: true });

const dbPath = join('data', 'novel.db');
const snapPath = join(outDir, 'novel.db.snapshot');
// 整库快照：这是回滚的真源。
//
// ⚠️ 2026-10-22 实测事故（本脚本第一版就是这么错的）：直接 `copyFileSync(novel.db)` 只复制**主文件**，
// 而本库跑在 `journal_mode=wal` —— 最近的写入还在 `novel.db-wal` 里，主文件停在最后一次 checkpoint 之前。
// 于是"整库快照"静默落后了整整一天（快照里的第 119 章是 10-21 的 4922 字，活库已是 10-22 的 4623 字），
// 而备份目录看起来一切正常 —— 这种"看起来有备份、其实回不到今天"的错最难发现。
// 正确做法：用 SQLite 自己的导出（VACUUM INTO），它会把 WAL 里的内容一起写进新文件。
// 下面还有一道自检：导出后立刻用快照读回同一章，正文 hash 必须与活库一致，否则直接失败。
{
  const live = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const mode = String((live.prepare('PRAGMA journal_mode').get() || {}).journal_mode || '').toLowerCase();
    if (mode === 'wal') {
      const wal = dbPath + '-wal';
      if (!existsSync(wal)) {
        console.warn('[冻结] 注意：库是 WAL 模式但当前没有 -wal 文件（可能刚 checkpoint 过）');
      }
    }
    live.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const write = (name, value) => writeFileSync(join(outDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');

const chapter = one('SELECT * FROM chapters WHERE id = ?', chapterId);
if (!chapter) throw new Error(`章节 #${chapterId} 不存在`);
if (Number(chapter.work_id) !== workId) throw new Error(`章节 #${chapterId} 不属于 work ${workId}`);

const versions = all('SELECT * FROM chapter_save_versions WHERE chapter_id = ? ORDER BY id', chapterId);
const adopts = all('SELECT * FROM adoption_operations WHERE chapter_id = ? ORDER BY created_at', chapterId);
const logs = all(
  `SELECT * FROM app_logs WHERE kind LIKE 'review_merge%' OR (context LIKE ? AND ts >= '2026-10-22T10:00')
   ORDER BY ts`,
  `%${chapterId}%`
);
const selections = all('SELECT * FROM revision_selections WHERE work_id = ? AND chapter_id = ? ORDER BY id DESC', workId, chapterId);
const reviews = all('SELECT id, status, created_at, dismissed, schema_version, review_hash, length(report_json) AS report_len FROM chapter_reviews WHERE work_id = ? AND chapter_id = ? ORDER BY id DESC', workId, chapterId);
const auditRuns = all('SELECT * FROM quality_audit_runs WHERE work_id = ? AND chapter_id = ? ORDER BY created_at DESC', workId, chapterId);
const auditItems = auditRuns.length
  ? all(`SELECT * FROM quality_audit_items WHERE audit_id IN (${auditRuns.map(() => '?').join(',')})`, ...auditRuns.map((r) => r.id))
  : [];

write('chapter.json', { chapter_id: chapterId, work_id: workId, title: chapter.title, updated_at: chapter.updated_at, chars: (chapter.content || '').length, content_html: chapter.content });
writeFileSync(join(outDir, 'chapter.txt'), chapter.content || '');
write('chapter-versions.json', versions.map((v) => ({ ...v })));
write('adoption-operations.json', adopts.map((a) => ({ ...a })));
write('app-logs-merge.json', logs);
write('revision-selections.json', selections);
write('chapter-reviews.json', reviews);
write('quality-audit.json', { runs: auditRuns, items: auditItems });

// 快照自检：快照必须能读回**同一个**章节正文。只在"导出成功"上签收，
// 就可能留下一个落后一整天的"备份"（见上面的事故注释）。
{
  const snapDb = new DatabaseSync(snapPath, { readOnly: true });
  let snapLen = -1;
  try {
    const r = snapDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapterId) || {};
    snapLen = String(r.content == null ? '' : r.content).length;
  } finally {
    snapDb.close();
  }
  const liveLen = String(chapter.content == null ? '' : chapter.content).length;
  if (snapLen !== liveLen) {
    throw new Error(`快照自检失败：快照里该章是 ${snapLen} 字，活库是 ${liveLen} 字（快照落后，不能当回滚真源）`);
  }
  write('snapshot-selfcheck.json', {
    chapter_id: chapterId, live_chars: liveLen, snapshot_chars: snapLen,
    live_content_hash: createHash('sha256').update(String(chapter.content || '')).digest('hex').slice(0, 16),
    ok: true,
  });
}

const report = {
  out_dir: outDir,
  snapshot_bytes: statSync(snapPath).size,
  chapter: { id: chapterId, chars: (chapter.content || '').length, updated_at: chapter.updated_at, versions: versions.length },
  adopt_ops: adopts.length,
  merge_logs: logs.length,
  audit_runs: auditRuns.map((r) => ({ id: r.id, status: r.status, phase: r.phase })),
};
write('INDEX.json', report);
console.log(JSON.stringify(report, null, 2));
