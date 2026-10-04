import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db');   // 写：删除**我自己**验证时造出来的测试草稿行（作者频道，已披露）
const before = db.prepare("SELECT id, length(content) AS len, substr(content,1,30) AS head FROM chapter_save_versions WHERE id = 67").get();
console.log('待删（我的测试产物）:', JSON.stringify(before));
const info = db.prepare('DELETE FROM chapter_save_versions WHERE id = 67').run();
console.log('已删除行数 =', Number(info.changes) || 0);
console.log('ch119 剩余草稿行:');
for (const r of db.prepare("SELECT id, draft_applied, draft_dismissed, length(content) AS len FROM chapter_save_versions WHERE chapter_id = 119 AND kind='draft' ORDER BY id DESC LIMIT 4").all()) console.log(` #${r.id} applied=${r.draft_applied} dismissed=${r.draft_dismissed} len=${r.len}`);
db.close();
