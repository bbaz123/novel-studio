/**
 * 时态故事状态 · 章节边界快照（chapter_state_snapshots）。
 *
 * 两种哈希严格分开：
 *   state_content_hash  规范化业务状态（判"业务上是否一致"）
 *   lineage_hash        提交/修订/事件集/顺序/算法版本（判"来源是否陈旧"）
 * 起步阶段每章存完整状态快照（先证明正确性）；规模测试后再切 checkpoint + 增量。
 */
import { db } from '../../../db.js';
import { prep } from './stmt.mjs';
import { TEMPORAL_ALGORITHM_VERSION } from './schema.mjs';
import { stateContentHash, stateFromJson, stateToJson, lineageHash } from './reducer.mjs';

const now = () => new Date().toISOString();

export function getSnapshot(id) {
  return prep('SELECT * FROM chapter_state_snapshots WHERE id = ?').get(String(id || '')) || null;
}

export function snapshotState(id) {
  const row = getSnapshot(id);
  if (!row) return null;
  return stateFromJson(row.state_json);
}

/**
 * 保存快照；同内容同 lineage 幂等（同 id 直接复用）。
 * stateHash 可选：调用方若已对同一 state 计算过 stateContentHash（如 stateAt / 校验报告），
 * 可直接传入，避免对全量状态重复规范化+哈希（必须与 state 严格对应）。
 * @returns {{id: string, state_content_hash: string, lineage_hash: string, reused: boolean}}
 */
export function saveSnapshot({ workId, chapterId = null, orderVersionId, cursor, state, commitId = '', revisionIds = [], eventHashes = [], stateHash = null } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('saveSnapshot: 缺少 work_id');
  if (!(state instanceof Map)) throw new Error('saveSnapshot: state 必须是 Map');
  const stateContent = stateHash ? String(stateHash) : stateContentHash(state);
  const lineage = lineageHash({ commitId, revisionIds, eventHashes, orderVersionId, algorithmVersion: TEMPORAL_ALGORITHM_VERSION });
  const id = 'snap_' + lineage.slice(0, 24) + '_' + stateContent.slice(0, 8);
  const existing = getSnapshot(id);
  if (existing) return { id, state_content_hash: existing.state_content_hash, lineage_hash: existing.lineage_hash, reused: true };
  prep(`INSERT INTO chapter_state_snapshots
      (id, work_id, chapter_id, order_version_id, cursor_json, state_json, state_content_hash, lineage_hash, algorithm_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, w, chapterId === null ? null : Number(chapterId), String(orderVersionId || ''),
      JSON.stringify(cursor || {}), JSON.stringify(stateToJson(state)), stateContent, lineage, TEMPORAL_ALGORITHM_VERSION, now());
  return { id, state_content_hash: stateContent, lineage_hash: lineage, reused: false };
}

/** 快照摘要（不含 state_json，供列表/面板使用）。 */
export function listSnapshots(workId, limit = 50) {
  return prep(`SELECT id, chapter_id, order_version_id, cursor_json, state_content_hash, lineage_hash, algorithm_version, created_at
    FROM chapter_state_snapshots WHERE work_id = ? ORDER BY created_at DESC LIMIT ?`).all(Number(workId) || 0, Math.max(1, Number(limit) || 50));
}
