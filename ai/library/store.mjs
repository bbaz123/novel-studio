/**
 * 共享资料库登记表（library_docs）的存储层。
 *
 * 边界（与 ai/style/store.mjs 同口径）：
 *   · 只读写 library_docs 这一张表（只读 works 判存在由调用方做）；
 *   · 绝不写作品数据 / 正典事实 / 事件 / 角色知识——资料不是本书事实；
 *   · uri 唯一：同一入库路径只有一行（重导即更新，不产生重复）。
 */
import { db } from '../../db.js';

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const now = () => new Date().toISOString();

const rowToDoc = (r) => (r ? {
  id: r.id, scope: r.scope || 'shared', work_id: r.work_id ?? null,
  uri: r.uri || '', rel: r.rel || '', category: r.category || '', slug: r.slug || '',
  title: r.title || '', sha256: r.sha256 || '', bytes: Number(r.bytes) || 0,
  chars: Number(r.chars) || 0, est_chunks: Number(r.est_chunks) || 0,
  source_path: r.source_path || '', status: r.status || 'active',
  indexed_at: r.indexed_at || '', created_at: r.created_at, updated_at: r.updated_at,
} : null);

/** 登记行清单（可按分类/状态过滤）。 */
export function listDocs({ category = '', status = '' } = {}) {
  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(String(category)); }
  if (status) { where.push('status = ?'); params.push(String(status)); }
  const sql = `SELECT * FROM library_docs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY category ASC, slug ASC, id ASC`;
  return prepare(sql).all(...params).map(rowToDoc);
}

export function getDoc(id) {
  return rowToDoc(prepare('SELECT * FROM library_docs WHERE id = ?').get(Number(id)));
}

/** uri → 行（导入计划比对 sha256 用）。 */
export function docByUriMap() {
  const map = {};
  for (const row of prepare('SELECT * FROM library_docs').all()) map[row.uri] = rowToDoc(row);
  return map;
}

/** 新增或按 uri 更新登记行（重导幂等）。 */
export function upsertDoc(doc) {
  const d = {
    scope: doc.scope || 'shared', work_id: doc.work_id ?? null, uri: String(doc.uri || ''),
    rel: doc.rel || '', category: doc.category || '', slug: doc.slug || '', title: doc.title || '',
    sha256: doc.sha256 || '', bytes: Number(doc.bytes) || 0, chars: Number(doc.chars) || 0,
    est_chunks: Number(doc.est_chunks) || 0, source_path: doc.source_path || '',
    status: doc.status || 'active', indexed_at: doc.indexed_at || '',
  };
  if (!d.uri) return { ok: false, error: 'uri 不能为空' };
  const ts = now();
  prepare(`
    INSERT INTO library_docs (scope, work_id, uri, rel, category, slug, title, sha256, bytes, chars, est_chunks, source_path, status, indexed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO UPDATE SET
      scope = excluded.scope, work_id = excluded.work_id, rel = excluded.rel,
      category = excluded.category, slug = excluded.slug, title = excluded.title,
      sha256 = excluded.sha256, bytes = excluded.bytes, chars = excluded.chars,
      est_chunks = excluded.est_chunks, source_path = excluded.source_path,
      status = excluded.status, indexed_at = excluded.indexed_at, updated_at = excluded.updated_at
  `).run(d.scope, d.work_id, d.uri, d.rel, d.category, d.slug, d.title, d.sha256, d.bytes, d.chars, d.est_chunks, d.source_path, d.status, d.indexed_at, ts, ts);
  return { ok: true, doc: rowToDoc(prepare('SELECT * FROM library_docs WHERE uri = ?').get(d.uri)) };
}

/** 删除策略默认「标记缺失」：只改 status，不动记忆库文件。 */
export function setStatus(id, status) {
  const info = prepare('UPDATE library_docs SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now(), Number(id));
  return { ok: Number(info.changes) > 0 };
}

/** 作者确认后才删登记行（记忆库文件的删除由调用方在同一步完成，失败则不走到这里）。 */
export function deleteDoc(id) {
  const info = prepare('DELETE FROM library_docs WHERE id = ?').run(Number(id));
  return { ok: Number(info.changes) > 0 };
}

/** 状态总览（含分类计数与最近索引时间）。 */
export function summary() {
  const rows = prepare('SELECT * FROM library_docs').all().map(rowToDoc);
  const categories = {};
  let bytes = 0; let chars = 0; let lastIndexed = ''; let lastUpdated = '';
  for (const r of rows) {
    if (r.status !== 'active') continue;
    categories[r.category || '未分类'] = (categories[r.category || '未分类'] || 0) + 1;
    bytes += r.bytes; chars += r.chars;
    if (r.indexed_at > lastIndexed) lastIndexed = r.indexed_at;
    if (r.updated_at > lastUpdated) lastUpdated = r.updated_at;
  }
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    marked_missing: rows.filter((r) => r.status === 'marked_missing').length,
    bytes, chars,
    categories: Object.entries(categories).map(([category, n]) => ({ category, n })).sort((a, b) => (a.category < b.category ? -1 : 1)),
    last_indexed_at: lastIndexed,
    last_updated_at: lastUpdated,
  };
}
