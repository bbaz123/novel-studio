/**
 * 时态故事状态 · 不可变正文修订（story_chapter_revisions）。
 *
 * 与 chapter_save_versions 的分工：后者是**用户可见**的版本历史（保留既有语义），
 * 前者是机器需要的不可变正文版本（内容寻址：同内容同 id，天然幂等，避免重复存全文）。
 *
 * 保存路径只做廉价操作（哈希 + 一条 INSERT），模型调用不在请求内（见 service.mjs / T2）。
 */
import { db } from '../../../db.js';
import { prep } from './stmt.mjs';
import { htmlToPlain } from '../../../text-utils.js';
import { NORMALIZER_VERSION, hashJson, sha16 } from './schema.mjs';

const now = () => new Date().toISOString();

function normalizeText(html) {
  return String(htmlToPlain(String(html || ''))).replace(/\r\n/g, '\n').trim();
}

function textHashOf(plain) {
  return sha16(plain);
}

function contentHashOf(html) {
  return sha16(String(html || ''));
}

export function getRevision(id) {
  return prep('SELECT * FROM story_chapter_revisions WHERE id = ?').get(String(id || '')) || null;
}

export function latestRevisionOf(chapterId) {
  return prep('SELECT * FROM story_chapter_revisions WHERE chapter_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(Number(chapterId) || 0) || null;
}

/**
 * 批量读取修订（历史归约批取用；IN 分块，避免逐章一次查询）。
 * lite=true 只取归约需要的列（不搬运 content_html 全文）。
 */
export function revisionsByIds(ids = [], { lite = false } = {}) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    const rows = lite
      ? db.prepare(`SELECT id, work_id, chapter_id, text_hash, created_at FROM story_chapter_revisions WHERE id IN (${ph})`).all(...chunk)
      : db.prepare(`SELECT * FROM story_chapter_revisions WHERE id IN (${ph})`).all(...chunk);
    for (const row of rows) {
      out.set(String(row.id), row);
    }
  }
  return out;
}

/**
 * 记录一次正文修订。
 * @returns {{revision: object, dedup: boolean}}
 *   dedup=true 表示与最近一次修订内容完全一致（重复保存 / 无变化），未新增行。
 */
export function recordRevision({ workId, chapterId, contentHtml, origin = {} } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('recordRevision: 缺少 work_id 或 chapter_id');
  const html = String(contentHtml ?? '');
  const contentHash = contentHashOf(html);
  const plain = normalizeText(html);
  const textHash = textHashOf(plain);
  const last = latestRevisionOf(c);
  if (last && String(last.content_hash) === contentHash) {
    return { revision: last, dedup: true };
  }
  const id = 'rev_' + sha16(`${w}|${c}|${contentHash}`);
  const existing = getRevision(id);
  if (existing) return { revision: existing, dedup: true };
  const originJson = JSON.stringify({
    kind: String(origin.kind || 'save'),
    actor: String(origin.actor || 'author'),
    source: String(origin.source || ''),
    chapter_id: c,
    ...(origin.extra && typeof origin.extra === 'object' ? { extra: origin.extra } : {}),
  });
  prep(`INSERT INTO story_chapter_revisions
      (id, work_id, chapter_id, content_html, content_hash, text_hash, normalizer_version, origin_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, w, c, html, contentHash, textHash, NORMALIZER_VERSION, originJson, now());
  return { revision: getRevision(id), dedup: false };
}

/** 修订的规范化纯文本（证据锚点校验、影响分析、逐章验证共用同一口径）。 */
export function revisionPlainText(revision) {
  return normalizeText(revision && revision.content_html);
}

export function revisionTextHash(revision) {
  return String((revision && revision.text_hash) || '');
}

export function revisionLineageOf(revision) {
  return revision ? `${revision.id}:${revision.content_hash}` : '';
}

export function hashOfContent(html) {
  return contentHashOf(html);
}

export function hashOfPlain(plain) {
  return hashJson(plain);
}
