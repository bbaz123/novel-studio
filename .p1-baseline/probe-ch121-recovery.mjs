import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const strip = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '');
const KEY = '0731';
const KEY2 = 'S级天赋';
console.log('== chapter_save_versions for 121: content signature ==');
for (const v of q('SELECT id, kind, draft_applied, created_at, content FROM chapter_save_versions WHERE chapter_id = 121 ORDER BY id DESC')) {
  const t = strip(v.content);
  console.log(`#${v.id} ${v.kind} ${v.created_at} html=${String(v.content || '').length} text=${t.length} has0731=${t.includes(KEY)} head="${t.slice(0, 34)}" tail="${t.slice(-24)}"`);
}
console.log('\n== story_chapter_revisions for 121 ==');
try {
  for (const r of q('SELECT * FROM story_chapter_revisions WHERE chapter_id = 121 ORDER BY id DESC LIMIT 20')) {
    console.log(JSON.stringify(r).slice(0, 300));
  }
} catch (e) { console.log('ERR ' + e.message); }
console.log('\n== story_chapter_revisions columns ==');
try { console.log(q('PRAGMA table_info(story_chapter_revisions)').map((c) => c.name).join(',')); } catch (e) { console.log('ERR ' + e.message); }
console.log('\n== chapter_state_snapshots for 121 ==');
try {
  console.log(q('PRAGMA table_info(chapter_state_snapshots)').map((c) => c.name).join(','));
  for (const r of q('SELECT * FROM chapter_state_snapshots WHERE chapter_id = 121 ORDER BY id DESC LIMIT 10')) console.log(JSON.stringify(r).slice(0, 240));
} catch (e) { console.log('ERR ' + e.message); }
db.close();
