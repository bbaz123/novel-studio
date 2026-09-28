/**
 * R09 存储层：作者样文 / 文风档案 / 三级作者意图。
 *
 * 边界（写清楚才不会长成第二个 server.js）：
 *   - 只读写这 3 张新表 + 2 张作品/章节表（只读 works 判存在，不改语义）；
 *   - **绝不写** story_facts / story_events / character_knowledge / story_state_proposals：
 *     样文与意图是"风格证据与作者偏好"，不是本书事实（负向测试见 test-author-style.mjs）。
 */
import { db } from '../../db.js';
import { analyzeStyle, profileHash, sampleSetHash, validateSample, SAMPLE_LIMITS } from './author-profile.mjs';

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const now = () => new Date().toISOString();
const rowToSample = (r) => ({
  id: r.id, work_id: r.work_id, title: r.title || '', text: r.text || '',
  chars: r.chars || 0, content_hash: r.content_hash || '', source: r.source || '',
  enabled: Number(r.enabled) === 1, created_at: r.created_at, updated_at: r.updated_at,
});

export function listSamples(workId) {
  return prepare('SELECT * FROM author_samples WHERE work_id = ? ORDER BY id').all(Number(workId)).map(rowToSample);
}

export function createSample(workId, input, source = 'author') {
  const existing = listSamples(workId);
  const v = validateSample({ ...input, id: null }, existing);
  if (!v.ok) return { ok: false, errors: v.errors };
  const info = prepare('INSERT INTO author_samples (work_id, title, text, chars, content_hash, source, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Number(workId), v.title, v.text, v.chars, v.content_hash, source, input && input.enabled === false ? 0 : 1, now(), now());
  return { ok: true, sample: rowToSample(prepare('SELECT * FROM author_samples WHERE id = ?').get(Number(info.lastInsertRowid))) };
}

export function updateSample(workId, id, patch) {
  const row = prepare('SELECT * FROM author_samples WHERE id = ? AND work_id = ?').get(Number(id), Number(workId));
  if (!row) return { ok: false, errors: ['样文不存在或不属于该作品'] };
  const merged = { title: patch && patch.title !== undefined ? patch.title : row.title, text: patch && patch.text !== undefined ? patch.text : row.text };
  const v = validateSample({ ...merged, id: Number(id) }, listSamples(workId));
  if (!v.ok) return { ok: false, errors: v.errors };
  const enabled = patch && patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled;
  prepare('UPDATE author_samples SET title = ?, text = ?, chars = ?, content_hash = ?, enabled = ?, updated_at = ? WHERE id = ? AND work_id = ?')
    .run(v.title, v.text, v.chars, v.content_hash, enabled, now(), Number(id), Number(workId));
  return { ok: true, sample: rowToSample(prepare('SELECT * FROM author_samples WHERE id = ?').get(Number(id))) };
}

export function deleteSample(workId, id) {
  const info = prepare('DELETE FROM author_samples WHERE id = ? AND work_id = ?').run(Number(id), Number(workId));
  return { ok: Number(info.changes) > 0 };
}

export function getProfile(workId) {
  const row = prepare('SELECT * FROM style_profiles WHERE work_id = ? ORDER BY id DESC LIMIT 1').get(Number(workId));
  if (!row) return null;
  let profile = {};
  try { profile = JSON.parse(row.profile_json || '{}'); } catch (_) { profile = {}; }
  return {
    id: row.id, work_id: row.work_id, profile, profile_hash: row.profile_hash,
    analysis_version: row.analysis_version, sample_set_hash: row.sample_set_hash,
    semantic_status: row.semantic_status || 'not_run', created_at: row.created_at,
  };
}

/** 分析：只做确定性计算（零模型调用），落一条新档案；样文变化让旧档案标 stale（isProfileStale）。 */
export function analyzeAndSave(workId, options = {}) {
  const samples = listSamples(workId).filter((s) => s.enabled);
  if (!samples.length) return { ok: false, errors: ['没有启用的作者样文：先添加至少一篇（≥' + SAMPLE_LIMITS.min_sample_chars + ' 字）'] };
  const profile = analyzeStyle(samples, { keep: options.keep, avoid: options.avoid });
  const hash = profileHash(profile);
  const withHash = { ...profile, profile_hash: hash };
  const setHash = sampleSetHash(samples);
  const prev = getProfile(workId);
  prepare('INSERT INTO style_profiles (work_id, profile_json, profile_hash, analysis_version, sample_set_hash, semantic_json, semantic_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Number(workId), JSON.stringify(withHash), hash, profile.profile_version, setHash, '', 'not_run', now());
  return { ok: true, profile: withHash, profile_hash: hash, sample_set_hash: setHash, replaced_previous: !!prev, semantic_status: 'not_run' };
}

export function listIntents(workId, chapterId = 0) {
  return prepare('SELECT * FROM author_intents WHERE work_id = ? AND chapter_id IN (0, ?) ORDER BY tier, id')
    .all(Number(workId), Number(chapterId) || 0)
    .map((r) => ({ id: r.id, work_id: r.work_id, chapter_id: r.chapter_id, tier: r.tier, text: r.text || '', hard: Number(r.hard) === 1, updated_at: r.updated_at }));
}

export function putIntent(workId, chapterId, tier, text, hard) {
  const cid = Number(chapterId) || 0;
  prepare(`INSERT INTO author_intents (work_id, chapter_id, tier, text, hard, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(work_id, chapter_id, tier) DO UPDATE SET text = excluded.text, hard = excluded.hard, updated_at = excluded.updated_at`)
    .run(Number(workId), cid, String(tier), String(text || ''), hard ? 1 : 0, now());
  return listIntents(workId, cid).find((x) => x.tier === tier && x.chapter_id === cid) || null;
}

export function deleteIntent(workId, chapterId, tier) {
  const info = prepare('DELETE FROM author_intents WHERE work_id = ? AND chapter_id = ? AND tier = ?')
    .run(Number(workId), Number(chapterId) || 0, String(tier));
  return { ok: Number(info.changes) > 0 };
}

export function workExists(workId) {
  return !!prepare('SELECT id FROM works WHERE id = ?').get(Number(workId));
}

export function chapterOfWork(workId, chapterId) {
  return prepare('SELECT id, work_id, title FROM chapters WHERE id = ? AND work_id = ?').get(Number(chapterId), Number(workId)) || null;
}

export function samplesSummary(workId) {
  const rows = listSamples(workId);
  const enabled = rows.filter((s) => s.enabled);
  return {
    samples: rows,
    limits: { ...SAMPLE_LIMITS },
    counts: { total: rows.length, enabled: enabled.length, chars: rows.reduce((n, s) => n + s.chars, 0), enabled_chars: enabled.reduce((n, s) => n + s.chars, 0) },
    sample_set_hash: sampleSetHash(enabled),
  };
}
