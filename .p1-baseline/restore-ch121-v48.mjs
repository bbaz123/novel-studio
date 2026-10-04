// 把 chapter_save_versions #48（13:38:50 的 manual 版）恢复为第三章正文。
// 通道：作者通道（不带 X-Novel-Agent）→ POST /api/novel/chapter_save
// 走服务端既有写入路径，因此旧正文（空）会先入历史版本，且时态修订与投影都会照常记录。
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://127.0.0.1:3737';
const CH = 121;
const VERSION_ID = 48;

const db = new DatabaseSync('data/novel.db', { readOnly: true });
const row = db.prepare('SELECT id, chapter_id, title, content, created_at FROM chapter_save_versions WHERE id = ?').get(VERSION_ID);
const before = db.prepare('SELECT id, title, content, updated_at FROM chapters WHERE id = ?').get(CH);
db.close();

if (!row || Number(row.chapter_id) !== CH) throw new Error(`版本 #${VERSION_ID} 不属于章节 ${CH}`);
const strip = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '');
console.log(`restore source: version #${row.id} created=${row.created_at} html=${row.content.length} text=${strip(row.content).length}`);
console.log(`before: ch${CH} html=${String(before.content).length} text=${strip(before.content).length} updated_at=${before.updated_at}`);

const res = await fetch(`${BASE}/api/novel/chapter_save`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chapter_id: CH, content: row.content, summary: undefined }),
});
const bodyText = await res.text();
console.log(`HTTP ${res.status} :: ${bodyText.slice(0, 300)}`);
if (!res.ok) process.exit(1);

const db2 = new DatabaseSync('data/novel.db', { readOnly: true });
const after = db2.prepare('SELECT id, title, content, updated_at FROM chapters WHERE id = ?').get(CH);
const ver = db2.prepare("SELECT id, kind, created_at, LENGTH(content) AS len FROM chapter_save_versions WHERE chapter_id = ? ORDER BY id DESC LIMIT 3").all(CH);
db2.close();
const same = String(after.content) === String(row.content);
console.log(`after: html=${String(after.content).length} text=${strip(after.content).length} updated_at=${after.updated_at}`);
console.log(`byte-identical to version #${VERSION_ID}: ${same}`);
console.log('new versions:', ver.map((v) => `#${v.id}/${v.kind}/${v.created_at}/${v.len}`).join(' | '));
if (!same) { console.log('!! content mismatch, abort reporting'); process.exit(2); }
