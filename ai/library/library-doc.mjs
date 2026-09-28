/**
 * 资料文件 → 入库 Markdown 的规范化（纯函数；导入链与离线单测共用）。
 *
 * ── 格式约定（P0 实测后冻结，2026-09-28；依据 .p1-baseline/probe-library-p0.result.json）──
 *   1. **不用 YAML front matter**。P0 实测：`---` 区块会原样留在取回窗口里
 *      （30 行窗口被吃掉 5 行 ≈ 17%），且只进整篇 abstract、不产生条目级元数据。
 *      元数据放**正文可见行**（建议第 3 行：来源｜标签｜适用）。
 *   2. 首行 `# 主题`；第 2 行写「一句话结论」；前 ~10 行必须自足——
 *      取回窗口 = 前 30 行（实测 484 字），单条进层前再压到 300 字。
 *   3. 用 `##` 分段，每段自成一题（标题写「是什么」）；单段建议 ≤ 600 字。
 *   4. 单文件 2–20 KB（约 50–400 行）；超长拆篇（超长会稀释检索）。
 *   5. UTF-8 无 BOM；`.txt` 导入时自动包 `# 文件名` 一级标题。
 *   6. 入库路径：<共享资料根>/<分类>/<slug>.md（分类一层目录）。
 *
 * 本模块只产出文本与统计/告警，不做丢弃与截断——语义完整优先，问题交给 dry-run 报告。
 */
import crypto from 'node:crypto';

/** 导入扫描的白名单与上限（P2 导入链共用）。 */
export const LIBRARY_INGEST = Object.freeze({
  exts: ['.md', '.txt'],
  maxFileBytes: 2 * 1024 * 1024, // 单文件安全上限（远大于 20KB 约定，只挡异常大文件）
  maxFiles: 500,                 // 单批导入篇数上限（防一次误选整个盘；超出部分在跳过清单里可见）
  minBytesWarn: 2048,            // 低于 2KB：提示（可能太薄，召回价值低）
  maxBytesWarn: 20480,           // 高于 20KB：提示拆篇
  softSectionChars: 600,         // 单段软上限：超出在 dry-run 里提示
});

/** 去掉 BOM、统一换行、保证有 `# 标题` 与结尾换行（不改动其余内容）。 */
export function normalizeLibraryText(name, raw) {
  let text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const base = String(name || '').replace(/\.[^.]*$/, '').trim() || '未命名资料';
  if (!text.trimStart().startsWith('#')) text = `# ${base}\n\n${text.trimStart()}`;
  return `${text.replace(/\s+$/, '')}\n`;
}

/** 内容 sha256（幂等对照用；导入链以它为「要写 / 要更新 / 跳过」判据之一）。 */
export function sha256Of(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 统计与告警（供 dry-run 报告）：字节数 / 行数 / 预估块数（`##` 计数）/ 最长段。
 * warnings: [{ code, message }] —— 只提示，不修改内容。
 */
export function libraryDocStats(text) {
  const t = String(text ?? '');
  const lines = t.split('\n');
  const bytes = Buffer.byteLength(t, 'utf8');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) { current = { title: line.slice(3).trim(), chars: 0 }; sections.push(current); continue; }
    if (current) current.chars += line.length + 1;
  }
  const longest = sections.reduce((n, s) => Math.max(n, s.chars), 0);
  const warnings = [];
  if (/^---\s*\n/.test(t)) warnings.push({ code: 'front_matter', message: '检测到 YAML front matter：P0 实测它会占用取回窗口（30 行里的 5 行）且不产生条目级元数据，建议移到正文可见行' });
  if (bytes < LIBRARY_INGEST.minBytesWarn) warnings.push({ code: 'too_small', message: `仅 ${bytes} 字节（约定 2–20KB）：资料太薄时召回价值低，建议补全或合并` });
  if (bytes > LIBRARY_INGEST.maxBytesWarn) warnings.push({ code: 'too_large', message: `${bytes} 字节超过 20KB 约定：建议拆篇（超长会稀释检索）` });
  if (longest > LIBRARY_INGEST.softSectionChars) warnings.push({ code: 'long_section', message: `最长段约 ${longest} 字（软上限 600）：建议拆成多个小节` });
  if (!/^#\s/.test(t)) warnings.push({ code: 'no_title', message: '首行不是 `# 主题`：建议补一行标题（召回标签取它）' });
  return { bytes, lines: lines.length - (t.endsWith('\n') ? 1 : 0), est_chunks: sections.length || 1, longest_section: longest, warnings };
}

/**
 * 源相对路径 → 入库相对路径 <分类>/<slug>.md。
 * 保留中文；路径分隔、空白与 Windows 非法字符统一折叠为 '-'；扩展名收敛为 .md。
 */
export function slugifyLibraryName(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const file = parts.pop() || '未命名.md';
  const clean = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || '未命名';
  let slug = clean(file);
  if (!/\.md$/i.test(slug)) slug = `${slug.replace(/\.(txt|markdown)$/i, '')}.md`;
  const category = clean(parts.join('-') || '未分类');
  return { category, slug, rel: `${category}/${slug}` };
}
