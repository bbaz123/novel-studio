// 只读排查：为什么「合并到正文」被"正文在差异预览之后被修改过"拒绝（2026-10-06 21:47 报障）。
// 用法：node .p1-baseline/probe-merge-fingerprint-20261006.mjs
import { DatabaseSync } from 'node:sqlite';

const d = new DatabaseSync('data/novel.db', { readOnly: true });
const all = (sql, ...p) => d.prepare(sql).all(...p);
const one = (sql, ...p) => d.prepare(sql).get(...p);

console.log('=== 表清单 ===');
console.log(all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name).join(' '));

console.log('\n=== chapter_reviews 列 ===');
console.log(all('PRAGMA table_info(chapter_reviews)').map((c) => c.name).join(' '));
console.log('\n=== 最近 6 条审稿记录 ===');
for (const r of all('SELECT id, chapter_id, status, created_at FROM chapter_reviews ORDER BY id DESC LIMIT 6')) {
  console.log(JSON.stringify(r));
}
console.log('\n=== 最近 6 条 harness_jobs（review / revision） ===');
console.log('harness_jobs 列：', all('PRAGMA table_info(harness_jobs)').map((c) => c.name).join(' '));
for (const r of all("SELECT id, kind, stage, chapter_id, status, created_at, length(COALESCE(output,'')) AS out FROM harness_jobs ORDER BY id DESC LIMIT 8")) {
  console.log(JSON.stringify(r));
}

console.log('\n=== work 18 的章节（id / 标题 / 正文长度 / updated_at） ===');
for (const r of all("SELECT id, title, length(COALESCE(content,'')) AS n, updated_at FROM chapters WHERE work_id = 18 ORDER BY id DESC LIMIT 8")) {
  console.log(JSON.stringify(r));
}

const ch = one("SELECT id, work_id, title, length(COALESCE(content,'')) AS n, updated_at, content FROM chapters WHERE id = 119");
if (ch) {
  const html = String(ch.content || '');
  const text = html.replace(/<\/(p|div|h\d|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  console.log(`\n=== ch119 正文（HTML ${html.length} 字符，纯文本 ${text.length} 字符） ===`);
  console.log('--- 纯文本前 200 ---');
  console.log(JSON.stringify(text.slice(0, 200)));
  console.log('--- 纯文本后 200 ---');
  console.log(JSON.stringify(text.slice(-200)));
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  console.log(`按空行切段：${paras.length} 段；按单换行切行：${text.split('\n').filter((s) => s.trim()).length} 行`);
  console.log('段落前 80 字：');
  paras.slice(0, 12).forEach((p, i) => console.log(`  [${i}] ${JSON.stringify(p.slice(0, 80))}`));
}
d.close();
