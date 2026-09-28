/**
 * guard.mjs —— R12：导入文件的安全校验（导入文件属于**不可信输入**）。
 *
 * 边界（写清楚才不会在各处重复实现）：
 *   - 本模块是纯函数：不读盘、不联网、不写库；只做「能不能安全处理」的判定与文本解码。
 *   - ZIP/EPUB 的**名字策略**（绝对路径 / `../` 穿越 / symlink / 深度 / 压缩比）在这里单点定义，
 *     `zip-reader.mjs` 与 server.js 都从这里取，避免「两处实现漂移」。
 *   - 解码一律严格 UTF-8：非法编码/二进制内容**安全失败**（抛错，由调用方转成 400），
 *     不做「尽力猜编码」——猜错会把乱码写进作品正文。
 *   - 我们不把归档解压到磁盘（只读进内存），所以「临时目录」这一条在这里体现为**根本没有临时目录**；
 *     任何未来的解压实现都必须遵守 IMPORT_RULES.temp_isolation 的约定。
 */

export const IMPORT_GUARD_VERSION = '1.0.0';

export const IMPORT_LIMITS = {
  max_file_bytes: 24 * 1024 * 1024,
  max_text_chars: 8 * 1024 * 1024,
  max_chapter_chars: 2 * 1024 * 1024,
  max_chapters: 2000,
  max_title_chars: 200,
  max_archive_entries: 2000,
  max_entry_uncompressed: 128 * 1024 * 1024,
  max_total_uncompressed: 256 * 1024 * 1024,
  max_compression_ratio: 200,
  max_entry_name_chars: 512,
  max_path_depth: 16,
  max_document_chars: 2 * 1024 * 1024,
  max_stored_text_chars: 24 * 1024 * 1024,
};

/** 判据口径（机器可读，随端点响应返回，便于审计「我们到底拦了什么」）。 */
export const IMPORT_RULES = {
  version: IMPORT_GUARD_VERSION,
  encoding: '严格 UTF-8（可带 BOM）：解码失败即拒绝，不猜编码、不把替换字符写进正文。',
  paths: `归档条目名必须相对、正斜杠、无 . / .. 段、深度 ≤ ${IMPORT_LIMITS.max_path_depth}、长度 ≤ ${IMPORT_LIMITS.max_entry_name_chars}；绝对路径与反斜杠一律拒绝。`,
  symlink: '归档里任何 symlink 条目一律拒绝（不跟随、不解压）。',
  ratio: `单条目解压/压缩比 ≤ ${IMPORT_LIMITS.max_compression_ratio}（压缩炸弹判据）。`,
  archive: `条目数 ≤ ${IMPORT_LIMITS.max_archive_entries}；单条目解压 ≤ ${IMPORT_LIMITS.max_entry_uncompressed} 字节；整包解压总量 ≤ ${IMPORT_LIMITS.max_total_uncompressed} 字节；只接受 stored(0) / deflate(8)。`,
  network: '导入过程不发起任何外部请求：不抓取远程资源、不执行脚本；HTML 只按 text-utils 的 htmlToPlain 剥标签（连同 <script>/<style> 一起丢弃）。',
  temp_isolation: '零临时目录：归档只在内存里读；若将来需要解压到磁盘，必须使用本次任务专用目录且只清理本次创建的路径。',
  atomic: '先解析、后写入；写入在单个事务里完成（importWorkFromChapters），失败不产生半导入状态。',
};

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const REPLACEMENT_RE = /\ufffd/;

/** 归档条目名规范化：不合法就抛错（附原因），合法则返回规范化后的相对路径。 */
export function normalizeArchiveName(raw, { label = '归档条目' } = {}) {
  const name = String(raw ?? '');
  const fail = (why) => { throw new Error(`${label}名不合法（${why}）：${JSON.stringify(name.slice(0, 120))}`); };
  if (!name) fail('空名');
  if (name.length > IMPORT_LIMITS.max_entry_name_chars) fail(`超过 ${IMPORT_LIMITS.max_entry_name_chars} 字符`);
  if (CONTROL_RE.test(name)) fail('含控制字符');
  if (name.includes('\\')) fail('含反斜杠（Windows 路径分隔符）');
  if (name.startsWith('/')) fail('绝对路径');
  if (/^[A-Za-z]:/.test(name)) fail('盘符绝对路径');
  if (/^[a-z]+:\/\//i.test(name)) fail('URL 形式');
  if (REPLACEMENT_RE.test(name)) fail('文件名含无效 UTF-8 替换字符');
  const parts = [];
  for (const seg of name.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') fail('包含上级目录引用（路径穿越）');
    if (seg.length > 255) fail('单级目录名过长');
    parts.push(seg);
  }
  if (!parts.length) fail('规范化后为空');
  if (parts.length > IMPORT_LIMITS.max_path_depth) fail(`路径深度超过 ${IMPORT_LIMITS.max_path_depth}`);
  return parts.join('/');
}

/**
 * 相对路径解析（posix 语义）：把 base 目录 + rel 解析成归档内路径。
 * 为什么需要它：合法 EPUB 会用 `../Text/x.xhtml` 这种相对 href，**不能**因为出现 `..` 就判穿越——
 * 判据是「解析之后有没有越出归档根」。越界（栈弹空还继续 ..）或得到绝对/URL 路径 → 拒绝。
 */
export function resolveArchivePath(base, rel, { label = '归档路径' } = {}) {
  const b = String(base ?? '');
  const r = String(rel ?? '').trim();
  const fail = (why) => { throw new Error(`${label}不合法（${why}）：${JSON.stringify(`${b}+${r}`.slice(0, 160))}`); };
  if (!r) fail('空路径');
  if (CONTROL_RE.test(r) || CONTROL_RE.test(b)) fail('含控制字符');
  if (r.includes('\\') || b.includes('\\')) fail('含反斜杠');
  if (r.startsWith('/')) fail('绝对路径');
  if (/^[A-Za-z]:/.test(r)) fail('盘符绝对路径');
  if (/^[a-z]+:\/\//i.test(r)) fail('URL 形式');
  const stack = [];
  for (const seg of `${b.replace(/\/+$/, '')}/${r}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!stack.length) fail('解析后越出归档根（路径穿越）');
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (!stack.length) fail('解析后为空');
  return normalizeArchiveName(stack.join('/'), { label });
}
/** 归档条目策略：压缩方式 / 压缩比 / 大小 / symlink。抛错即拒绝整包。 */
export function assertArchiveEntry({ name, method, compSize, uncompSize, externalAttrs = 0, versionMadeBy = 0 } = {}) {
  const norm = normalizeArchiveName(name);
  if (method !== 0 && method !== 8) throw new Error(`${norm}：不支持的压缩方式 ${method}（只接受 stored(0) / deflate(8)）`);
  const unixMode = (Number(versionMadeBy) >> 8) === 3 ? (Number(externalAttrs) >>> 16) : 0;
  if ((unixMode & 0xf000) === 0xa000) throw new Error(`${norm}：拒绝 symlink 条目（不跟随、不解压）`);
  const isDir = /\/$/.test(String(name));
  if (isDir) return { name: norm, directory: true };
  const comp = Number(compSize) || 0;
  const uncomp = Number(uncompSize) || 0;
  if (uncomp > IMPORT_LIMITS.max_entry_uncompressed) throw new Error(`${norm}：声明解压后 ${uncomp} 字节，超过单条目上限 ${IMPORT_LIMITS.max_entry_uncompressed}`);
  if (comp > 0 && uncomp / comp > IMPORT_LIMITS.max_compression_ratio) {
    throw new Error(`${norm}：压缩比 ${Math.round(uncomp / comp)}:1 超过上限 ${IMPORT_LIMITS.max_compression_ratio}:1（疑似压缩炸弹）`);
  }
  if (comp === 0 && uncomp > 0) throw new Error(`${norm}：压缩数据为空但声明解压后 ${uncomp} 字节`);
  return { name: norm, directory: false };
}

/** 严格 UTF-8 解码（可带 BOM）：失败即抛错；拒绝 NUL 等二进制信号。 */
export function decodeTextStrict(input, { label = '文本', maxChars = IMPORT_LIMITS.max_document_chars } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    throw new Error(`${label}不是合法 UTF-8（可能是其它编码或二进制文件）：请先转成 UTF-8 再导入`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) throw new Error(`${label}含 NUL 字节：看起来是二进制文件，已拒绝`);
  if (text.length > maxChars) throw new Error(`${label}超过长度上限（${text.length} > ${maxChars} 字符）`);
  return text;
}

/** 文本导入（TXT / Markdown）的内容校验：非空、非二进制、长度与单章长度上限。 */
export function assertImportText(text, { label = '导入文本' } = {}) {
  if (typeof text !== 'string') throw new Error(`${label}必须是字符串`);
  if (!text.trim()) throw new Error(`${label}为空`);
  if (CONTROL_RE.test(text.replace(/[\n\r\t]/g, ''))) throw new Error(`${label}含二进制控制字符：已拒绝`);
  if (text.length > IMPORT_LIMITS.max_text_chars) throw new Error(`${label}超过上限（${text.length} 字符 > ${IMPORT_LIMITS.max_text_chars}）`);
  return text;
}

/** 拆章结果校验：章节数 / 单章长度（拆章后调用，越界即安全失败，不进写库）。 */
export function assertChapters(chapters, { label = '导入结果' } = {}) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) throw new Error(`${label}里没有章节`);
  if (list.length > IMPORT_LIMITS.max_chapters) throw new Error(`${label}章节数超过上限（${list.length} > ${IMPORT_LIMITS.max_chapters}）`);
  let total = 0;
  for (let i = 0; i < list.length; i += 1) {
    const len = String((list[i] || {}).content || '').length;
    total += len;
    if (len > IMPORT_LIMITS.max_chapter_chars) throw new Error(`${label}第 ${i + 1} 章超过单章上限（${len} > ${IMPORT_LIMITS.max_chapter_chars} 字符）`);
  }
  if (total > IMPORT_LIMITS.max_text_chars) throw new Error(`${label}总长度超过上限（${total} > ${IMPORT_LIMITS.max_text_chars} 字符）`);
  return { chapters: list.length, chars: total };
}

export default { IMPORT_GUARD_VERSION, IMPORT_LIMITS, IMPORT_RULES, normalizeArchiveName, resolveArchivePath, assertArchiveEntry, decodeTextStrict, assertImportText, assertChapters };