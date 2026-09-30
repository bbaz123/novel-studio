/**
 * 时态故事状态 · 作品级开关与总览。
 *
 * 三个开关分离（方案 §12）：
 *   temporal_enabled       版本化状态底座（修订/事件/提交/历史查询）
 *   auto_analysis_enabled  保存后自动提取（需要已配置模型；无模型标 not_run）
 *   repair_enabled         作者按钮驱动的逐章候选重建
 * 全部默认 0；未启用作品的上下文/端点/默认生成路径与接入前一致。
 */
import { db, withTransaction } from '../../../db.js';

const now = () => new Date().toISOString();

function rowOf(workId) {
  try {
    return db.prepare('SELECT * FROM story_state_config WHERE work_id = ?').get(Number(workId) || 0) || null;
  } catch {
    return null;
  }
}

export function getTemporalConfig(workId) {
  const row = rowOf(workId);
  return {
    work_id: Number(workId) || 0,
    enabled: !!(row && Number(row.temporal_enabled) === 1),
    auto_analysis: !!(row && Number(row.auto_analysis_enabled) === 1),
    repair: !!(row && Number(row.repair_enabled) === 1),
    story_state_enabled: !!(row && Number(row.enabled) === 1),
  };
}

export function isTemporalEnabled(workId) {
  return getTemporalConfig(workId).enabled;
}

/** 至少开启 temporal_enabled 才能写时态数据；其他开关只影响自动行为。 */
export function setTemporalConfig(workId, patch = {}, note = '') {
  const w = Number(workId) || 0;
  const current = getTemporalConfig(w);
  const next = {
    enabled: patch.temporal_enabled === undefined ? current.enabled : !!patch.temporal_enabled,
    auto_analysis: patch.auto_analysis_enabled === undefined ? current.auto_analysis : !!patch.auto_analysis_enabled,
    repair: patch.repair_enabled === undefined ? current.repair : !!patch.repair_enabled,
  };
  withTransaction(() => {
    db.prepare(`INSERT INTO story_state_config (work_id, enabled, temporal_enabled, auto_analysis_enabled, repair_enabled, note, updated_at)
      VALUES (?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET
        temporal_enabled = excluded.temporal_enabled,
        auto_analysis_enabled = excluded.auto_analysis_enabled,
        repair_enabled = excluded.repair_enabled,
        note = CASE WHEN excluded.note = '' THEN story_state_config.note ELSE excluded.note END,
        updated_at = excluded.updated_at`)
      .run(w, next.enabled ? 1 : 0, next.auto_analysis ? 1 : 0, next.repair ? 1 : 0, String(note || ''), now());
  });
  return getTemporalConfig(w);
}

/**
 * 引擎可用性自检：必要表缺失时**响亮说不**（禁止吞错误后假装数据库完好）。
 * 返回 { ok, missing: [...] }。
 */
export function assertTemporalSchema() {
const need = [
    'story_chapter_order_versions', 'story_worldlines', 'story_commits', 'story_chapter_revisions',
    'story_state_events', 'chapter_state_snapshots', 'story_chapter_bindings',
    'story_chapter_dependencies', 'story_binding_trust', 'story_repair_runs', 'story_repair_steps',
  ];
  let rows = [];
  try {
    rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
  } catch (e) {
    return { ok: false, missing: need, error: e.message };
  }
  const have = new Set(rows);
  const missing = need.filter((t) => !have.has(t));
  return { ok: missing.length === 0, missing };
}
