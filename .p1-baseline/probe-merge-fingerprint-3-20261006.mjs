// 只读排查（第三步）：ch119 正文在 13:40–13:50 UTC 的内容时间线。
import { DatabaseSync } from 'node:sqlite';

const d = new DatabaseSync('data/novel.db', { readOnly: true });
const all = (sql, ...p) => d.prepare(sql).all(...p);

console.log('=== chapter_save_versions 75..79 ===');
for (const r of all('SELECT id, chapter_id, title, kind, draft_applied, draft_dismissed, created_at, length(COALESCE(content,\'\')) AS n, substr(COALESCE(content,\'\'),1,100) AS head FROM chapter_save_versions WHERE chapter_id = 119 ORDER BY id DESC LIMIT 8')) {
  console.log(JSON.stringify(r));
}

console.log('\n=== story_chapter_revisions for 119（最近 12 条） ===');
for (const r of all("SELECT id, chapter_id, content_hash, text_hash, normalizer_version, created_at, length(COALESCE(content_html,'')) AS n FROM story_chapter_revisions WHERE chapter_id = 119 ORDER BY id DESC LIMIT 12")) {
  console.log(JSON.stringify(r));
}

console.log('\n=== 今天创建的所有章节历史（任意章） ===');
for (const r of all("SELECT id, chapter_id, kind, created_at, length(COALESCE(content,'')) AS n FROM chapter_save_versions WHERE created_at >= '2026-10-06' ORDER BY id DESC LIMIT 25")) {
  console.log(JSON.stringify(r));
}

console.log('\n=== harness_jobs 2026-10-06 全部 ===');
for (const r of all("SELECT id, kind, stage, chapter_id, status, created_at, length(COALESCE(output,'')) AS out FROM harness_jobs WHERE created_at >= '2026-10-06' ORDER BY created_at")) {
  console.log(JSON.stringify(r));
}

console.log('\n=== 当前 ch119 内容结构（前 3 个 div / 段数） ===');
const c = String(all('SELECT content FROM chapters WHERE id = 119')[0].content || '');
console.log('顶层标签：', JSON.stringify(c.slice(0, 60)));
console.log('div 数：', (c.match(/<div>/g) || []).length, '；</div>数：', (c.match(/<\/div>/g) || []).length);
console.log('尾 120：', JSON.stringify(c.slice(-120)));
d.close();
