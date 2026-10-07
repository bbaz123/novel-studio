// 只读排查（第二步）：ch119 在 2026-10-06 13:40–13:50 UTC 之间被谁写过。
import { DatabaseSync } from 'node:sqlite';

const d = new DatabaseSync('data/novel.db', { readOnly: true });
const all = (sql, ...p) => d.prepare(sql).all(...p);
const one = (sql, ...p) => d.prepare(sql).get(...p);

console.log('=== ch119 行 ===');
const ch = one("SELECT id, work_id, title, position, length(COALESCE(content,'')) AS n, updated_at, substr(content,1,80) AS head FROM chapters WHERE id = 119");
console.log(JSON.stringify(ch));

console.log('\n=== 内容是否含 HTML 标签 ===');
const c = String(one('SELECT content FROM chapters WHERE id = 119').content || '');
console.log('含 <p>：', /<p[\s>]/i.test(c), '；含 <br>：', /<br/i.test(c), '；含换行数：', (c.match(/\n/g) || []).length);
console.log('原样前 120：', JSON.stringify(c.slice(0, 120)));

console.log('\n=== 各版本/历史表的列 ===');
for (const t of ['chapter_save_versions', 'story_chapter_revisions', 'memory_versions', 'adoption_operations']) {
  try { console.log(t, '→', all(`PRAGMA table_info(${t})`).map((x) => x.name).join(' ')); } catch (e) { console.log(t, 'ERR', e.message); }
}

console.log('\n=== 2026-10-06 13:40 之后的章节历史行 ===');
try {
  for (const r of all("SELECT id, chapter_id, created_at, length(COALESCE(content,'')) AS n FROM chapter_save_versions WHERE chapter_id = 119 ORDER BY id DESC LIMIT 10")) console.log('save_ver', JSON.stringify(r));
} catch (e) { console.log('save_ver ERR', e.message); }
try {
  for (const r of all("SELECT * FROM story_chapter_revisions WHERE chapter_id = 119 ORDER BY id DESC LIMIT 6").map((r) => ({ id: r.id, created_at: r.created_at, keys: Object.keys(r).length }))) console.log('revision', JSON.stringify(r));
} catch (e) { console.log('revision ERR', e.message); }

console.log('\n=== adoption_operations 最近 5 条 ===');
try {
  for (const r of all('SELECT * FROM adoption_operations ORDER BY rowid DESC LIMIT 5')) {
    const { result_json, ...rest } = r;
    console.log(JSON.stringify(rest), 'result=', String(result_json || '').slice(0, 120));
  }
} catch (e) { console.log('adoption ERR', e.message); }

console.log('\n=== app_logs 里 2026-10-06T13:4x 的行 ===');
try {
  const cols = all('PRAGMA table_info(app_logs)').map((x) => x.name);
  console.log('列：', cols.join(' '));
  for (const r of all("SELECT * FROM app_logs WHERE ts LIKE '2026-10-06T13:4%' OR ts LIKE '2026-10-06T13:3%' ORDER BY ts LIMIT 40")) {
    console.log(JSON.stringify(r).slice(0, 400));
  }
} catch (e) { console.log('app_logs ERR', e.message); }
d.close();
