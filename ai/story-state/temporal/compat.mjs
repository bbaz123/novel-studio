/**
 * 时态故事状态 · 旧字段兼容投影（单向：权威来源是 temporal 提交清单；旧字段只是展示缓存）。
 *
 * 纪律：
 *   ① 只写「有明确对应关系」的字段与「已存在的实体」——不新建、不删除角色/关系；
 *   ② 只从**已确认状态前缀**（finalizeValidGroup 的 output_state）投影，绝不用候选稿或旧快照；
 *   ③ 未开启 temporal 的作品不会走到这里（service 的 guard 已拦截）；
 *   ④ 剧情线没有可安全对应的旧字段（summary 是作者原文），因此不写、只返回 skipped；
 *   ⑤ 旧入口（手工改角色状态/关系）在启用作品上已命令化为 author_correction 事件（AC-44），
 *      所以这张表在启用作品上不会出现第二个写入源。
 */
import { db } from '../../../db.js';
import { characterViewsOf, relationViewsOf } from './projection.mjs';

export function refreshCompatProjection({ workId, state, commitId = '' } = {}) {
  const w = Number(workId) || 0;
  if (!w || !state) return { ok: false, reason: '缺少作品或状态' };
  const now = new Date().toISOString();
  let characters = 0;
  for (const view of characterViewsOf(state)) {
    const name = String(view.entity_id || '').trim();
    const status = String(view.status || '').trim();
    if (!name || !status) continue;
    characters += Number(db.prepare('UPDATE characters SET status = ?, updated_at = ? WHERE work_id = ? AND name = ? AND status <> ?')
      .run(status, now, w, name, status).changes) || 0;
  }
  let relations = 0;
  for (const view of relationViewsOf(state)) {
    const from = String(view.from || '').trim();
    const to = String(view.to || '').trim();
    const label = String(view.label || '').trim();
    if (!from || !to || !label) continue;
    const row = db.prepare(`SELECT r.id, r.relation FROM character_relations r
      JOIN characters a ON a.id = r.from_character_id
      JOIN characters b ON b.id = r.to_character_id
      WHERE r.work_id = ? AND a.name = ? AND b.name = ?`).get(w, from, to);
    if (!row) continue;
    const description = view.value && typeof view.value === 'object' && view.value.description !== undefined
      ? String(view.value.description) : null;
    if (String(row.relation) === label && description === null) continue;
    relations += description === null
      ? Number(db.prepare('UPDATE character_relations SET relation = ? WHERE id = ? AND relation <> ?').run(label, row.id, label).changes) || 0
      : Number(db.prepare('UPDATE character_relations SET relation = ?, description = ? WHERE id = ?').run(label, description, row.id).changes) || 0;
  }
  return {
    ok: true, commit_id: String(commitId || ''),
    characters_updated: characters, relations_updated: relations,
    plotlines_skipped: 'no_safe_legacy_field',
  };
}
