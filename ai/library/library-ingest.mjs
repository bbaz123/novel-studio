/**
 * 共享资料库导入链（library）——目录扫描 + 导入计划，**默认 dry-run**。
 *
 * 安全边界（对应待办红线 4：目录导入是新的本地读取面）：
 *   · 只读**显式传入**的那一个目录；不联网、不写盘、不读别处；
 *   · 扩展名白名单（.md/.txt）；单文件上限（LIBRARY_INGEST.maxFileBytes）与单批篇数上限；
 *   · 不跟随符号链接（文件与目录都跳过并给原因——防止借链接把库外文件带进来）；
 *   · 跳过隐藏项（`.` / `_` 前缀）与忽略目录（node_modules/.git/…），忽略目录**不深入**；
 *   · 严格 UTF-8（fatal 解码，失败即跳过：不猜编码、不把替换字符写进资料）；
 *   · 文本内容**不随计划返回**（dry-run 报告只带统计；确认导入时重新扫描取文本，
 *     避免把正文灌进响应/日志，也避免 plan 与写入之间的内容漂移）。
 *
 * 计划（planLibraryImport）产出三类动作：add（新）/ update（sha256 变了）/ skip（未变或无法入库）。
 * 入库路径经 slugifyLibraryName 折叠为 <分类>/<slug>.md，再经 checkLibraryShape 复核（fail-closed）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_INGEST, normalizeLibraryText, sha256Of, libraryDocStats, slugifyLibraryName } from './library-doc.mjs';
import { SHARED_LIBRARY_ROOT, checkLibraryShape } from './library-roots.mjs';
import { libraryTitleOf } from './library-recall.mjs';

export const LIBRARY_INGEST_VERSION = '1.0.0';

/** 忽略目录（不深入）：依赖/版本库/构建产物等，绝不是资料。 */
export const LIBRARY_IGNORE_DIRS = Object.freeze([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '__pycache__', '.cache', '.venv', 'venv', '.idea', '.vscode',
]);

/** dry-run 跳过清单的展示上限（计数不截断）。 */
export const SKIP_LIST_MAX = 200;

const isReservedName = (name) => name.startsWith('.') || name.startsWith('_');

/**
 * 扫描目录 → 候选条目 + 跳过清单（纯本地，绝不跟随符号链接）。
 * @returns {{ok:boolean, dir:string, error?:string, entries:Array, skipped:Array, skipped_counts:object, truncated:boolean}}
 */
export function scanLibraryDir(dir) {
  const root = path.resolve(String(dir || ''));
  let st;
  try { st = fs.statSync(root); } catch { return { ok: false, dir: root, error: `目录不存在或不可读：${root}`, entries: [], skipped: [], skipped_counts: {}, truncated: false }; }
  if (!st.isDirectory()) return { ok: false, dir: root, error: `不是目录：${root}`, entries: [], skipped: [], skipped_counts: {}, truncated: false };

  const entries = [];
  const skipped = [];
  const counts = {};
  let truncated = false;
  const skip = (relPath, code, reason) => {
    counts[code] = (counts[code] || 0) + 1;
    if (counts[code] <= SKIP_LIST_MAX) skipped.push({ path: relPath, code, reason });
    else truncated = true;
  };

  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { skip(rel || '.', 'unreadable', `读取失败：${e.message}`); continue; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const it of items) {
      const relPath = rel ? `${rel}/${it.name}` : it.name;
      const fileAbs = path.join(abs, it.name);
      if (it.isSymbolicLink()) { skip(relPath, 'symlink', '符号链接一律跳过（不跟随）'); continue; }
      if (it.isDirectory()) {
        if (isReservedName(it.name)) { skip(relPath, 'ignored_dir', '隐藏目录（. / _ 前缀）：不深入'); continue; }
        if (LIBRARY_IGNORE_DIRS.includes(it.name)) { skip(relPath, 'ignored_dir', '忽略目录（依赖/版本库/构建产物）：不深入'); continue; }
        stack.push(relPath);
        continue;
      }
      if (!it.isFile()) { skip(relPath, 'not_regular_file', '不是普通文件'); continue; }
      if (isReservedName(it.name)) { skip(relPath, 'hidden', '隐藏文件（. / _ 前缀）'); continue; }
      const ext = path.extname(it.name).toLowerCase();
      if (!LIBRARY_INGEST.exts.includes(ext)) { skip(relPath, 'ext_not_allowed', `扩展名不在白名单（${LIBRARY_INGEST.exts.join(' / ')}）`); continue; }
      if (entries.length >= LIBRARY_INGEST.maxFiles) { skip(relPath, 'too_many_files', `超过单批上限 ${LIBRARY_INGEST.maxFiles} 篇`); continue; }
      let buf;
      try { buf = fs.readFileSync(fileAbs); } catch (e) { skip(relPath, 'unreadable', `读取失败：${e.message}`); continue; }
      if (buf.length > LIBRARY_INGEST.maxFileBytes) { skip(relPath, 'too_large', `超过单文件上限 ${LIBRARY_INGEST.maxFileBytes} 字节`); continue; }
      let raw;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { skip(relPath, 'bad_encoding', '不是合法 UTF-8：拒绝（不猜编码）'); continue; }
      const text = normalizeLibraryText(it.name, raw);
      if (!text.trim()) { skip(relPath, 'empty', '空文件'); continue; }
      const stats = libraryDocStats(text);
      entries.push({
        source_path: fileAbs, rel_path: relPath, ext,
        bytes: buf.length, sha256: sha256Of(text), title: libraryTitleOf(text, it.name), stats,
        // text 只留给确认导入的同一次扫描使用；planLibraryImport 不会把它放进计划。
        text,
      });
    }
  }
  entries.sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : 0));
  return { ok: true, dir: root, entries, skipped, skipped_counts: counts, truncated };
}

/**
 * 扫描结果 + 现有登记表 → 导入计划（不含正文）。
 * @param {object} scan scanLibraryDir 的返回
 * @param {Record<string, {sha256?:string}>} existingByUri uri → 登记行
 */
export function planLibraryImport(scan, existingByUri = {}) {
  const items = [];
  const skipped = [...((scan && scan.skipped) || [])];
  const seen = new Map();
  let add = 0; let update = 0; let unchanged = 0; let bytes = 0; let chars = 0; let chunks = 0;
  for (const e of (scan && scan.entries) || []) {
    const target = slugifyLibraryName(e.rel_path);
    const uri = `${SHARED_LIBRARY_ROOT}/${target.rel}`;
    const shape = checkLibraryShape(target.rel);
    if (!shape.ok) { skipped.push({ path: e.rel_path, code: 'bad_target', reason: shape.reason }); continue; }
    if (seen.has(uri)) { skipped.push({ path: e.rel_path, code: 'duplicate_target', reason: `与「${seen.get(uri)}」映射到同一入库路径 ${target.rel}` }); continue; }
    seen.set(uri, e.rel_path);
    const prev = existingByUri[uri] || null;
    let action = 'add';
    let reason = '新入库';
    if (prev && prev.sha256 === e.sha256) { action = 'skip'; reason = '内容未变（sha256 相同）'; unchanged += 1; }
    else if (prev) { action = 'update'; reason = '内容有更新（sha256 变了）'; update += 1; }
    else add += 1;
    if (action !== 'skip') { bytes += e.bytes; chars += e.text.length; chunks += e.stats.est_chunks; }
    items.push({
      source_path: e.source_path, rel_path: e.rel_path, uri, rel: target.rel,
      category: target.category, slug: target.slug, title: e.title, action, reason,
      sha256: e.sha256, bytes: e.bytes, chars: e.text.length, est_chunks: e.stats.est_chunks,
      warnings: e.stats.warnings,
    });
  }
  return {
    ok: true, dir: scan ? scan.dir : '', items, skipped,
    truncated: Boolean(scan && scan.truncated),
    summary: {
      files_scanned: scan ? scan.entries.length : 0,
      add, update, skip_unchanged: unchanged,
      skipped_files: skipped.length,
      will_write: add + update,
      bytes, chars, est_chunks: chunks,
    },
    rules: {
      version: LIBRARY_INGEST_VERSION,
      exts: [...LIBRARY_INGEST.exts],
      max_file_bytes: LIBRARY_INGEST.maxFileBytes,
      max_files: LIBRARY_INGEST.maxFiles,
      ignore_dirs: [...LIBRARY_IGNORE_DIRS],
      symlink: '不跟随（文件与目录都跳过）',
      encoding: '严格 UTF-8（失败即跳过，不猜编码）',
      target: '<共享资料根>/<分类>/<slug>.md（分类一层目录）',
    },
  };
}
