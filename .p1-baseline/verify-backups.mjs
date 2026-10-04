import { DatabaseSync } from 'node:sqlite';
for (const [label, f] of [['backup-pre-savefix', 'data/backup-pre-savefix-20261002215726/novel-clean.db'], ['backup-pre-restore', 'data/backup-pre-ch121-restore-20261002215838/novel-clean.db']]) {
  const db = new DatabaseSync(f, { readOnly: true });
  console.log(`${label}: integrity=${db.prepare('PRAGMA integrity_check').get().integrity_check} ch121len=${db.prepare('SELECT LENGTH(content) AS n FROM chapters WHERE id=121').get().n} versions=${db.prepare('SELECT COUNT(*) AS n FROM chapter_save_versions WHERE chapter_id=121').get().n}`);
  db.close();
}
