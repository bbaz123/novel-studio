/**
 * ai/extraction/coverage.mjs —— S06：完整覆盖（修 F05）。
 *
 * 病灶：旧实现 `sanitizeText(plainText)` 把正文**无声截断**到 12,000 字符，
 * 于是第 12,001 字符之后的证据永远检索不到，而调用方**看不出被截过**
 *（`rawFound=false` 会被误读成"模型编了引文"）。
 *
 * 本模块的做法：
 *   ① 规范化出**完整**正文（不截断）；
 *   ② 把它切成**连续、无重叠、无缝隙**的分块（每块自带 [start,end) 区间）；
 *   ③ 给出**覆盖清单**（总长、各块区间、缝隙、校验和）—— 让"是否丢内容"变成可断言的事实；
 *   ④ 引文定位返回**全部**命中区间，而不是第一处。
 *
 * 纪律：本模块只做纯计算（输入字符串 → 输出结构），不读写数据库、不调用模型。
 */

/** 规范化：去控制字符、统一换行、压缩行尾空白。**不截断**。 */
export function normalizeFullText(input) {
  return String(input == null ? '' : input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** 短哈希（与内核 schema 同族；这里独立实现以免引入循环依赖）。 */
export function coverageChecksum(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/**
 * 切块：连续、无重叠、**必须覆盖 [0,len)**。
 *
 * 为什么按"段落边界优先"切：硬切会把句子劈开，引文跨块后就无法定位。
 * 因此优先在 `\n` 处断开；找不到换行才硬切（并如实标记 `hardCut`）。
 *
 * @returns {Array<{index:number,start:number,end:number,chars:number,hardCut:boolean}>}
 */
export function planChunks(text, { maxChars = 12000 } = {}) {
  const s = normalizeFullText(text);
  const limit = Math.max(1, Number(maxChars) || 12000);
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + limit);
    let hardCut = false;
    if (end < s.length) {
      // 在窗口的后 40% 里找最后一个换行，避免块太短又避免劈句
      const windowStart = start + Math.floor(limit * 0.6);
      const nl = s.lastIndexOf('\n', end - 1);
      if (nl > windowStart) end = nl + 1;
      else hardCut = true;
    }
    chunks.push({ index, start, end, chars: end - start, hardCut });
    index += 1;
    start = end;
  }
  if (chunks.length === 0) chunks.push({ index: 0, start: 0, end: 0, chars: 0, hardCut: false });
  return chunks;
}

/**
 * 覆盖清单：把"是否丢内容"变成可断言的事实。
 *
 * @returns {{complete:boolean, total:number, covered:number, chunks:number, gaps:Array, hardCuts:number, checksum:string}}
 */
export function coverageManifest(text, chunks) {
  const s = normalizeFullText(text);
  const list = Array.isArray(chunks) && chunks.length ? chunks : planChunks(s);
  const gaps = [];
  let cursor = 0;
  let covered = 0;
  let hardCuts = 0;
  for (const c of list) {
    if (c.start !== cursor) gaps.push({ from: cursor, to: c.start, size: c.start - cursor });
    if (c.end < c.start) gaps.push({ from: c.start, to: c.end, size: c.end - c.start });
    covered += Math.max(0, c.end - c.start);
    if (c.hardCut) hardCuts += 1;
    cursor = Math.max(cursor, c.end);
  }
  if (cursor !== s.length) gaps.push({ from: cursor, to: s.length, size: s.length - cursor });
  return {
    complete: gaps.length === 0 && covered === s.length,
    total: s.length,
    covered,
    chunks: list.length,
    gaps,
    hardCuts,
    checksum: coverageChecksum(s),
  };
}

/** 引文在完整正文里的**全部**命中区间（不是第一处）。 */
export function locateQuote(text, quote) {
  const s = normalizeFullText(text);
  const q = String(quote == null ? '' : quote);
  if (!q) return [];
  const hits = [];
  let from = 0;
  for (;;) {
    const at = s.indexOf(q, from);
    if (at < 0) break;
    hits.push({ start: at, end: at + q.length });
    from = at + Math.max(1, q.length);
    if (hits.length >= 50) break; // 上限只是为了不让病态输入撑爆，不是语义限制
  }
  return hits;
}

/** 某个字符偏移落在哪一块（用于"证据属于哪一块"的溯源）。 */
export function chunkAt(chunks, offset) {
  const at = Number(offset) || 0;
  for (const c of chunks || []) {
    if (at >= c.start && at < c.end) return c;
  }
  return null;
}

/**
 * 证据锚点检查：引文是否存在、在哪一块、是否恰好唯一。
 * 返回结构直接可进 coverage manifest，供"部分抽取不能伪装无变化"使用。
 */
export function anchorQuote(text, quote, chunks) {
  const hits = locateQuote(text, quote);
  const list = Array.isArray(chunks) && chunks.length ? chunks : planChunks(text);
  return {
    found: hits.length > 0,
    occurrences: hits.length,
    ambiguous: hits.length > 1,
    hits: hits.map((h) => ({ ...h, chunk: chunkAt(list, h.start)?.index ?? null })),
  };
}
