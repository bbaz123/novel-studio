/**
 * library-index.mjs —— 知识库专用候选索引（D 模块）。
 *
 * 目标：把「5000 篇全库向量竞争」变成「先廉价索引缩小候选 → 再语义排名 → 再确定性放行」。
 * 边界（硬约束）：
 *   · 不新增向量库、不调用 LLM、不产生付费请求；
 *   · 索引只用于**候选发现与查询优化**：title/summary/keywords/tags/候选清单/分数解释
 *     默认不进入模型上下文（本模块的查询接口不返回正文与关键词，只返回元数据与分数）；
 *   · 语义阈值 0.40 / top-4 / 每条 300 字 / 前 30 行 / 1200 字上限一律不放宽——
 *     词法分数绝不用于把低于 0.40 语义阈值的项顶进上下文（放行仍由现有链路决定）；
 *   · 索引不可用/未建/损坏/超时 → 调用方降级为纯 OpenViking 路径，不阻断写作；
 *   · 开关默认关闭（app_settings: library_index_enabled=0），关闭时链路与基线一致。
 *
 * 存储：SQLite `library_index`（每篇一条轻量记录）+ FTS5 `library_index_fts`（bigram 分词，
 * 支持中英混合与专名精确匹配）。两份表由本模块在每次 upsert/delete 时同步维护；
 * 重建为幂等操作（sha256 未变的行不重写）。
 *
 * 词法分数口径：FTS5 的 bm25() 为**负值、越负越相关**（SQLite 文档与本地实测一致）。
 * 把 q=|rank| 映射为确定性的 0–1 分数 `q/(1+q)`（单调递增，越大越相关），
 * 只用于**排序提示与审计**，不参与语义阈值判定。
 */
import fs from 'node:fs';
import { db } from '../../db.js';

/** 索引 schema 版本：字段或分词口径变化时必须 +1（缓存失效判据之一，见 §九）。 */
export const LIBRARY_INDEX_SCHEMA_VERSION = 1;

export const LIBRARY_INDEX = Object.freeze({
  enabledKey: 'library_index_enabled',
  versionKey: 'library_index_version',
  schemaKey: 'library_index_schema',
  queryTimeoutMs: 1000,   // D5：索引查询超时上限（超时降级）
  candidateLimit: 24,     // 候选 overscan 有界（不随库规模增长）
  maxMatchTokens: 12,     // MATCH 表达式最多用的 token 数（有界）
  headLines: 30,          // 与现有「前 30 行窗口」同口径
  headChars: 600,
  summaryChars: 200,
  keywordsMax: 24,
  keywordChars: 12,
  expansionTerms: 3,      // 查询扩展最多 3 个词
  expansionChars: 120,
  ftsMaxTokens: 400,      // 单篇索引 tokens 上限（有界）
});

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const nowIso = () => new Date().toISOString();
const cap = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) : t; };

// ── 进程内诊断计数（测试与审计用；正式统计以每次装配的 retrieval_stats 为准） ──
let queryCount = 0;
let lastStatus = 'idle';
export function indexQueryStats() { return { queries: queryCount, last_status: lastStatus }; }
export function _resetIndexQueryStats() { queryCount = 0; lastStatus = 'idle'; }

// ── 开关与版本 ────────────────────────────────────────────────────────────
function settingGet(key, fallback = '') {
  const row = prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? String(row.value) : fallback;
}
function settingSet(key, value) {
  prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** 开关：默认关闭（未显式打开即与基线一致）。 */
export function libraryIndexEnabled() {
  return settingGet(LIBRARY_INDEX.enabledKey, '0') === '1';
}

export function setLibraryIndexEnabled(enabled) {
  settingSet(LIBRARY_INDEX.enabledKey, enabled ? '1' : '0');
  return libraryIndexEnabled();
}

/**
 * 版本信息（缓存失效判据）：
 *   version 每次索引内容变更 +1；schema 恒为模块常量，并落库便于审计。
 * 注意：schema 取**模块常量**而不是库里存的值——模块升级后常量变化必须立即让旧缓存失效，
 * 不能等下一次 rebuild 才对齐。
 */
export function libraryIndexVersionInfo() {
  const version = Math.max(0, parseInt(settingGet(LIBRARY_INDEX.versionKey, '0'), 10) || 0);
  const storedSchema = parseInt(settingGet(LIBRARY_INDEX.schemaKey, '0'), 10) || 0;
  return { version, schema: LIBRARY_INDEX_SCHEMA_VERSION, stored_schema: storedSchema, stale_schema: storedSchema !== LIBRARY_INDEX_SCHEMA_VERSION };
}

/** 版本串：进入缓存键/外部版本判据的稳定形态。 */
export function libraryIndexVersionKey() {
  const v = libraryIndexVersionInfo();
  return `${v.schema}.${v.version}`;
}

function bumpVersion() {
  const v = libraryIndexVersionInfo();
  const next = v.version + 1;
  settingSet(LIBRARY_INDEX.versionKey, String(next));
  settingSet(LIBRARY_INDEX.schemaKey, String(LIBRARY_INDEX_SCHEMA_VERSION));
  return next;
}

// ── FTS 可用性（只探测一次；失败只降级，不抛穿） ─────────────────────────────
let ftsOk = null;
export function libraryFtsAvailable() {
  if (ftsOk !== null) return ftsOk;
  try {
    db.prepare("SELECT count(*) AS n FROM library_index_fts WHERE library_index_fts MATCH '\"__probe__\"'").get();
    ftsOk = true;
  } catch {
    ftsOk = false;
  }
  return ftsOk;
}

// ── 确定性字段提取（禁止 LLM） ───────────────────────────────────────────────
const CN_RUN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
const EN_RUN = /[A-Za-z][A-Za-z0-9_-]{2,}/g;
const KW_LINE = /^(关键词|关键字|标签|tags?)[:：]\s*(.+)$/i;

/** summary：首行标题 + 次行结论 + 可能的 ## 小节标题（上限 200 字）。 */
export function summaryOfDoc(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const parts = [];
  if (nonEmpty[0]) parts.push(nonEmpty[0].replace(/^#+\s*/, ''));
  // 次行结论：仅当它不像小节标题、且长度像一句话（≤120）时采用。
  const second = nonEmpty[1] || '';
  if (second && !/^#{1,6}\s/.test(second) && second.length <= 120) parts.push(second);
  const headings = lines.filter((l) => /^#{2,6}\s+/.test(l)).slice(0, 2).map((l) => l.replace(/^#+\s*/, ''));
  for (const h of headings) if (!parts.includes(h)) parts.push(h);
  return cap(parts.join('；'), LIBRARY_INDEX.summaryChars);
}

/** keywords：标题/小节标题/显式关键词行/高频专名（确定性，上限 24 个、每个 ≤12 字）。 */
export function keywordsOfDoc(text, title = '') {
  const out = [];
  const push = (w) => {
    const t = cap(String(w || '').replace(/[，。！？、；：""''（）()【】\[\]「」]/g, '').trim(), LIBRARY_INDEX.keywordChars);
    if (!t || t.length < 2) return;
    if (!out.includes(t)) out.push(t);
  };
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const headLines = lines.slice(0, LIBRARY_INDEX.headLines);
  // 1) 标题与显式关键词行
  const first = headLines.find(Boolean) || title;
  for (const seg of String(first || '').replace(/^#+\s*/, '').split(/[\s/｜|·]+/)) push(seg);
  for (const l of headLines) {
    const m = l.match(KW_LINE);
    if (m) for (const seg of m[2].split(/[、，,;；\s]+/)) push(seg);
  }
  // 2) 小节标题里的专名
  for (const l of headLines.filter((x) => /^#{2,6}\s+/.test(x))) {
    for (const seg of l.replace(/^#+\s*/, '').split(/[\s/｜|·：:]+/)) {
      if (CN_RUN.test(seg) || /[A-Za-z]/.test(seg)) push(seg);
      CN_RUN.lastIndex = 0;
    }
  }
  // 3) 高频专名：头部窗口里出现 ≥3 次的 2–4 字中文串（按出现次数降序、首次位置升序）
  const freq = new Map();
  const head = headLines.join('\n');
  for (const run of head.match(CN_RUN) || []) {
    const chars = Array.from(run);
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= chars.length; i += 1) {
        const g = chars.slice(i, i + n).join('');
        const prev = freq.get(g) || { n: 0, pos: head.indexOf(g) };
        freq.set(g, { n: prev.n + 1, pos: prev.pos });
      }
    }
  }
  const hot = [...freq.entries()]
    .filter(([g, v]) => v.n >= 3 && !out.includes(g))
    .sort((a, b) => (b[1].n - a[1].n) || (a[1].pos - b[1].pos))
    .slice(0, 8)
    .map(([g]) => g);
  for (const g of hot) push(g);
  return out.slice(0, LIBRARY_INDEX.keywordsMax).join(' ');
}

/** head_text：前 30 行（与现有读取窗口同口径），上限 600 字。 */
export function headTextOfDoc(text) {
  return cap(String(text || '').split('\n').slice(0, LIBRARY_INDEX.headLines).join('\n'), LIBRARY_INDEX.headChars);
}

// ── 分词（中英混合：中文 bigram + 英文词） ───────────────────────────────────
export function tokenizeForIndex(text) {
  const s = String(text || '').toLowerCase();
  const parts = s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+|[a-z0-9_]+/g) || [];
  const out = [];
  for (const p of parts) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(p)) {
      const chars = Array.from(p);
      if (chars.length === 1) out.push(chars[0]);
      for (let i = 0; i + 2 <= chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
    } else if (p.length >= 2) {
      out.push(p);
    }
  }
  return out;
}

function ftsMatchExpr(tokens) {
  const t = tokens.slice(0, LIBRARY_INDEX.maxMatchTokens).map((x) => '"' + String(x).replace(/"/g, '""') + '"');
  if (!t.length) return '';
  return t.join(' OR ');
}

// ── 写入（导入时增量维护；失败不抛穿——索引失败不得导致资料导入整体失败） ────────
export function upsertEntry({ docId, uri, sha256 = '', title = '', category = '', tags = '', text = '' }) {
  try {
    if (!Number(docId) || !uri) return { ok: false, status: 'invalid' };
    const existing = prepare('SELECT id, sha256 FROM library_index WHERE doc_id = ?').get(Number(docId));
    if (existing && String(existing.sha256 || '') === String(sha256 || '') && sha256) {
      return { ok: true, skipped: true, status: 'unchanged' }; // D3：sha 未变 → 不更新索引
    }
    if (!libraryFtsAvailable()) return { ok: false, status: 'fts_unavailable' };
    const fields = {
      title: cap(title || summaryOfDoc(text), 80),
      summary: summaryOfDoc(text),
      keywords: keywordsOfDoc(text, title),
      head_text: headTextOfDoc(text),
    };
    const version = (libraryIndexVersionInfo().version || 0) + 1;
    const ts = nowIso();
    const row = prepare('SELECT id FROM library_index WHERE doc_id = ?').get(Number(docId));
    if (row) {
      prepare(`UPDATE library_index SET uri = ?, sha256 = ?, title = ?, summary = ?, keywords = ?, category = ?, tags = ?, head_text = ?, updated_at = ?, index_version = ? WHERE doc_id = ?`)
        .run(String(uri), String(sha256), fields.title, fields.summary, fields.keywords, String(category), String(tags), fields.head_text, ts, version, Number(docId));
    } else {
      prepare(`INSERT INTO library_index (doc_id, uri, sha256, title, summary, keywords, category, tags, head_text, updated_at, index_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(docId), String(uri), String(sha256), fields.title, fields.summary, fields.keywords, String(category), String(tags), fields.head_text, ts, version);
    }
    // FTS 行与主行同步：先删后插（doc_id 在 FTS 侧是 UNINDEXED 列）。
    prepare('DELETE FROM library_index_fts WHERE doc_id = ?').run(Number(docId));
    const tokens = [...new Set(tokenizeForIndex([fields.title, fields.summary, fields.keywords, fields.head_text].join('\n')))].slice(0, LIBRARY_INDEX.ftsMaxTokens);
    prepare('INSERT INTO library_index_fts (tokens, doc_id) VALUES (?, ?)').run(tokens.join(' '), Number(docId));
    settingSet(LIBRARY_INDEX.versionKey, String(version));
    settingSet(LIBRARY_INDEX.schemaKey, String(LIBRARY_INDEX_SCHEMA_VERSION));
    return { ok: true, status: 'indexed', version };
  } catch (e) {
    return { ok: false, status: 'index_write_failed', error: e.message };
  }
}

export function removeEntry(docId) {
  try {
    const info = prepare('DELETE FROM library_index WHERE doc_id = ?').run(Number(docId));
    try { prepare('DELETE FROM library_index_fts WHERE doc_id = ?').run(Number(docId)); } catch { /* FTS 不可用时只删主行 */ }
    if (Number(info.changes) > 0) bumpVersion();
    return { ok: true, removed: Number(info.changes) };
  } catch (e) {
    return { ok: false, status: 'index_write_failed', error: e.message };
  }
}

/** 重建（幂等）：从登记表 + 原始来源文件重建；读不到来源的文件保留既有索引行并计数。 */
export function rebuildFromRegistry(docs, { readText } = {}) {
  const t0 = Date.now();
  const active = (docs || []).filter((d) => d && d.status === 'active');
  const activeIds = new Set(active.map((d) => Number(d.id)));
  let indexed = 0; let kept = 0; let degraded = 0; let removed = 0;
  for (const d of active) {
    let text = null;
    try { text = readText ? readText(d) : null; } catch { text = null; }
    if (typeof text === 'string' && text.trim()) {
      const r = upsertEntry({ docId: d.id, uri: d.uri, sha256: d.sha256, title: d.title, category: d.category, tags: d.tags || '', text });
      if (r.ok) indexed += 1; else degraded += 1;
    } else if (prepare('SELECT id FROM library_index WHERE doc_id = ?').get(Number(d.id))) {
      kept += 1; // 来源不可读：保留既有索引行（不假装更新）
    } else {
      degraded += 1;
    }
  }
  // 清掉已不在登记表（或已非 active）的索引行
  for (const row of prepare('SELECT doc_id FROM library_index').all()) {
    if (!activeIds.has(Number(row.doc_id))) { removeEntry(row.doc_id); removed += 1; }
  }
  settingSet(LIBRARY_INDEX.schemaKey, String(LIBRARY_INDEX_SCHEMA_VERSION));
  return { ok: true, indexed, kept, degraded, removed, total: active.length, ms: Date.now() - t0 };
}

/** 从原始来源文件读文本（严格 UTF-8；与导入链同一纪律；失败返回 null）。 */
export function readSourceText(sourcePath, maxBytes = 2 * 1024 * 1024) {
  try {
    if (!sourcePath) return null;
    const st = fs.statSync(sourcePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = fs.readFileSync(sourcePath);
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch { return null; }
}

// ── 查询（只返回元数据 + 分数；不返回 summary/keywords/正文） ─────────────────
function countAsQuery() { queryCount += 1; }

/**
 * 词法候选查询。
 * @returns {{ok:boolean,status:string,candidates:Array,scoresByDocId:object,timings_ms:number}}
 *   candidate: { doc_id, uri, title, category, lexical_score }
 */
export function queryCandidates({ query = '', limit = LIBRARY_INDEX.candidateLimit, timeoutMs = LIBRARY_INDEX.queryTimeoutMs, category = '' } = {}) {
  const t0 = Date.now();
  countAsQuery();
  if (!libraryFtsAvailable()) { lastStatus = 'index_unavailable'; return { ok: false, status: 'index_unavailable', candidates: [], scoresByDocId: {}, timings_ms: Date.now() - t0 }; }
  const tokens = [...new Set(tokenizeForIndex(query))];
  if (!tokens.length) { lastStatus = 'empty'; return { ok: true, status: 'empty', candidates: [], scoresByDocId: {}, timings_ms: Date.now() - t0 }; }
  const expr = ftsMatchExpr(tokens);
  const capLimit = Math.max(1, Math.min(Number(limit) || LIBRARY_INDEX.candidateLimit, LIBRARY_INDEX.candidateLimit));
  try {
    // 先按 bm25 排序再截断：候选集合必须是**最相关的 N 条**。少了 ORDER BY 时 LIMIT 取到的是
    // 存储顺序的任意子集，等于把「先廉价缩小候选」做成了随机抽样。rank 是 bm25 的别名，越小越相关。
    const rows = prepare(`
      SELECT f.doc_id AS doc_id, f.rank AS rank
      FROM (SELECT doc_id, bm25(library_index_fts) AS rank FROM library_index_fts WHERE library_index_fts MATCH ? ORDER BY rank LIMIT ?) AS f
    `).all(expr, capLimit);
    const ids = rows.map((r) => Number(r.doc_id)).filter((n) => n > 0);
    if (!ids.length) { lastStatus = 'no_hits'; return { ok: true, status: 'no_hits', candidates: [], scoresByDocId: {}, timings_ms: Date.now() - t0 }; }
    const placeholders = ids.map(() => '?').join(',');
    const metaRows = category
      ? prepare(`SELECT i.doc_id, i.uri, i.title, i.category FROM library_index i JOIN library_docs d ON d.id = i.doc_id AND d.status = 'active' WHERE i.doc_id IN (${placeholders}) AND i.category = ?`).all(...ids, category)
      : prepare(`SELECT i.doc_id, i.uri, i.title, i.category FROM library_index i JOIN library_docs d ON d.id = i.doc_id AND d.status = 'active' WHERE i.doc_id IN (${placeholders})`).all(...ids);
    const rankBy = new Map(rows.map((r) => [Number(r.doc_id), Number(r.rank)]));
    const candidates = metaRows.map((m) => {
      // bm25 负值、越负越相关 → q=|rank| 越大越相关 → q/(1+q) 单调递增（0–1）。
      // 口径与 semantic_score / final_score 的「越大越相关」一致，避免词法排序提示反向。
      const q = Math.max(0, -Number(rankBy.get(Number(m.doc_id)) || 0));
      return { doc_id: Number(m.doc_id), uri: m.uri, title: m.title, category: m.category, lexical_score: Number((q / (1 + q)).toFixed(4)) };
    }).sort((a, b) => (b.lexical_score - a.lexical_score) || (String(a.uri) < String(b.uri) ? -1 : 1));
    const timings = Date.now() - t0;
    if (timings > timeoutMs) { lastStatus = 'timeout'; return { ok: false, status: 'timeout', candidates: [], scoresByDocId: {}, timings_ms: timings }; }
    lastStatus = 'ok';
    const scoresByDocId = {};
    for (const c of candidates) scoresByDocId[String(c.doc_id)] = c.lexical_score;
    return { ok: true, status: 'ok', candidates, scoresByDocId, timings_ms: timings };
  } catch (e) {
    lastStatus = 'index_unavailable';
    return { ok: false, status: 'index_unavailable', error: e.message, candidates: [], scoresByDocId: {}, timings_ms: Date.now() - t0 };
  }
}

/** 用索引里的高分候选为 OV 查询做**有界**扩展（只取少量词，总字符受限）。 */
export function expansionTermsForHits(candidates = [], limit = LIBRARY_INDEX.expansionTerms) {
  const terms = [];
  let chars = 0;
  for (const c of candidates) {
    if (!c || !c.title) continue;
    const t = cap(String(c.title).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, ' ').split(/\s+/).find(Boolean) || '', 16);
    if (!t || terms.includes(t)) continue;
    if (chars + t.length > LIBRARY_INDEX.expansionChars) break;
    terms.push(t); chars += t.length;
    if (terms.length >= limit) break;
  }
  return terms;
}

/** 诊断：索引行数（status 页/报告用；不是热路径）。 */
export function indexStats() {
  try {
    const row = prepare('SELECT COUNT(*) AS n FROM library_index').get();
    return { entries: Number(row?.n) || 0, fts: libraryFtsAvailable(), version: libraryIndexVersionInfo() };
  } catch (e) {
    return { entries: 0, fts: false, version: libraryIndexVersionInfo(), error: e.message };
  }
}
