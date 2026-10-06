// 生成"重算第 119 章本应写入的合并稿"的探针（用真实生产函数 tryApplyRevisionOutput，不是复刻）。
// 做法：把 frontend-test.mjs 的**桩与加载部分**（第一个 check 之前）原样切下来，拼上本脚本的正文，
// 放进一个自带 public/ 的目录里运行 —— 这样拿到的是 app.js 里那份真实实现，而不是我另写一份可能漂移的复刻。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'frontend-test.mjs'), 'utf8');
const marker = "check('1 app.js 在最小 DOM 环境下无顶层运行时错误'";
const cut = src.indexOf(marker);
if (cut < 0) { console.error('未找到切分点'); process.exit(2); }
const harness = src.slice(0, cut);

const body = `
// ==================== 重算第 119 章本应写入的合并稿 ====================
const { DatabaseSync } = await import('node:sqlite');
const P = sandbox.__probe;
// 注意：桩里的 repoRoot 是**测试文件自己所在目录**（.p1-baseline/regress-run），
// 不是仓库根；这里显式回推两级，避免读到不存在的库。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new DatabaseSync(path.join(REPO, 'data', 'novel.db'), { readOnly: true });
const draft = db.prepare('SELECT content FROM chapter_save_versions WHERE id = 71').get();
const job = db.prepare("SELECT output FROM harness_jobs WHERE kind LIKE 'revision%' AND chapter_id = 119 ORDER BY created_at DESC LIMIT 1").get();
const cur = db.prepare('SELECT content, updated_at FROM chapters WHERE id = 119').get();
db.close();

// 复刻 htmlNodeToText 的段落口径（块级标签后补空行）——判据：28 条补丁的 anchor 必须能**逐字**命中。
const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TR', 'SECTION']);
function htmlToPlainText(html) {
  const withBreaks = String(html || '')
    .replace(/<br\\s*\\/?>/gi, '\\n')
    .replace(/<\\/([a-z0-9]+)\\s*>/gi, (m, tag) => (BLOCK.has(tag.toUpperCase()) ? '\\n\\n' : ''))
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&');
  return withBreaks.replace(/[ \\t]*\\n[ \\t]*/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]{2,}/g, ' ').trim();
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const textToParagraphsHtml = (t = '') => String(t).split(/\\n{2,}/).map((b) => esc(b.trim())).filter(Boolean).map((b) => \`<p>\${b.replace(/\\n/g, '<br>')}</p>\`).join('');

const baseText = htmlToPlainText(draft.content);
const r = P.tryApplyRevisionOutput(job.output, baseText);
const patches = P.parseRevisionPatches(job.output) || [];
const html = r && r.ok ? textToParagraphsHtml(r.text) : '';
const crypto = await import('node:crypto');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const report = {
  补丁条数: patches.length,
  命中条数: r ? r.applied.length : -1,
  未命中条数: r ? r.unresolved.length : -1,
  底稿可读字符: baseText.length,
  合并稿可读字符: r ? r.text.length : -1,
  合并稿段落数: r && r.ok ? r.text.split(/\\n{2,}/).length : -1,
  正文HTML字节: html.length,
  sha256_正文HTML: sha(html),
  sha256_合并稿纯文本: r && r.ok ? sha(r.text) : '',
  当前库内正文字节: cur.content.length,
  当前库内正文_updated_at: cur.updated_at
};
console.log(JSON.stringify(report, null, 1));
if (r && r.ok && r.unresolved.length === 0) {
  fs.writeFileSync(path.join(REPO, '.p1-baseline', 'ch119-merge-candidate.html'), html, 'utf8');
  fs.writeFileSync(path.join(REPO, '.p1-baseline', 'ch119-merge-candidate.txt'), r.text, 'utf8');
  console.log('已写出候选件：.p1-baseline/ch119-merge-candidate.html / .txt');
} else {
  console.log('候选稿未通过（存在未命中补丁），不写出文件');
}
// app.js 顶层会挂心跳/轮询定时器；探针不是测试套件，必须自己收尾，否则进程不退出。
process.exit(0);
`;

const outDir = path.join(root, '.p1-baseline', 'regress-run');
fs.writeFileSync(path.join(outDir, 'recompute-ch119-merge.mjs'), harness + body, 'utf8');
console.log('已生成: ' + path.join(outDir, 'recompute-ch119-merge.mjs'));
