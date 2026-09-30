/**
 * 时态故事状态 · 世界线 / 提交 / 清单（story_worldlines / story_commits）。
 *
 * 提交清单（manifest）是「每章选中哪个 binding」的唯一依据：
 *   manifest = { version, order_version_id, chapters: { "<chapterId>": "<bindingId>" } }
 * 历史查询沿目标提交的清单解析 binding，**不查"该作品全部 applied 事件"**——
 * 旧正文被替换后，旧事件仍服务于旧提交，但不出现在新稿事件集中。
 *
 * 主世界线 HEAD 更新、正式正文、投影与清单必须一致；候选工作线写任何数据都不能覆盖 main。
 */
import { db } from '../../../db.js';
import { prep } from './stmt.mjs';
import { hashJson, sha16 } from './schema.mjs';
import { ensureOrderVersion, getOrderVersion } from './order.mjs';

const now = () => new Date().toISOString();

export function ensureMainWorldline(workId) {
  const w = Number(workId) || 0;
  const existing = prep("SELECT * FROM story_worldlines WHERE work_id = ? AND kind = 'main' AND status = 'open'").get(w);
  if (existing) return existing;
  const id = `wl_main_${w}`;
  prep(`INSERT OR IGNORE INTO story_worldlines (id, work_id, kind, base_commit_id, head_commit_id, generation, status, label, created_at)
    VALUES (?, ?, 'main', NULL, NULL, 0, 'open', '', ?)`).run(id, w, now());
  return prep('SELECT * FROM story_worldlines WHERE id = ?').get(id);
}

export function getWorldline(id) {
  return prep('SELECT * FROM story_worldlines WHERE id = ?').get(String(id || '')) || null;
}

export function headCommitOf(worldlineId) {
  const wl = getWorldline(worldlineId);
  if (!wl || !wl.head_commit_id) return null;
  return getCommit(wl.head_commit_id);
}

export function getCommit(id) {
  const row = prep('SELECT * FROM story_commits WHERE id = ?').get(String(id || ''));
  if (!row) return null;
  let manifest = null;
  try { manifest = JSON.parse(row.manifest_json); } catch { manifest = null; }
  return { ...row, manifest };
}

export function manifestOf(commit) {
  if (!commit || !commit.manifest) return { version: 1, order_version_id: '', chapters: {}, initial_binding_id: null };
  const m = commit.manifest;
  return {
    version: Number(m.version) || 1,
    order_version_id: String(m.order_version_id || ''),
    chapters: { ...(m.chapters || {}) },
    // 开篇设定（第 0 章 / 建库前状态）：只有作者明确确认的 bootstrap 候选才会写在这里。
    // 旧提交没有这个键 → null（哈希保持不变，历史提交逐字节可回放）。
    initial_binding_id: m.initial_binding_id ? String(m.initial_binding_id) : null,
  };
}

/** 主世界线当前提交（必要时创建 genesis：空清单 + 当前章序版本）。 */
export function ensureMainCommit(workId) {
  const wl = ensureMainWorldline(workId);
  if (wl.head_commit_id) return getCommit(wl.head_commit_id);
  const order = ensureOrderVersion(workId);
  const manifest = { version: 1, order_version_id: order.id, chapters: {} };
  const manifestHash = hashJson(manifest);
  const id = 'cmt_' + sha16(`${wl.id}|genesis|${order.id}`);
  prep(`INSERT OR IGNORE INTO story_commits (id, work_id, worldline_id, parent_commit_id, order_version_id, manifest_json, manifest_hash, note, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, 'genesis', ?)`).run(id, Number(workId) || 0, wl.id, order.id, JSON.stringify(manifest), manifestHash, now());
  prep('UPDATE story_worldlines SET head_commit_id = ? WHERE id = ?').run(id, wl.id);
  return getCommit(id);
}

/**
 * 创建子提交并推进世界线 HEAD（调用方必须已有事务）。
 * @returns {{commit: object, manifest: object}}
 */
export function commitManifest({ workId, worldlineId, parentCommitId, orderVersionId = null, chapters, initialBindingId = undefined, note = '', expectedHead = null } = {}) {
  const wl = getWorldline(worldlineId);
  if (!wl) throw new Error('WORLDLINE_NOT_FOUND');
  if (Number(wl.work_id) !== (Number(workId) || 0)) throw new Error('WORLDLINE_WORK_MISMATCH');
  const head = wl.head_commit_id || null;
  if (expectedHead !== null && String(expectedHead) !== String(head || '')) {
    const err = new Error('HEAD_CAS_MISMATCH');
    err.code = 'HEAD_CAS_MISMATCH';
    err.current = head;
    throw err;
  }
  const parent = parentCommitId ? getCommit(parentCommitId) : (head ? getCommit(head) : null);
  const baseManifest = parent ? manifestOf(parent) : { version: 1, order_version_id: null, chapters: {}, initial_binding_id: null };
  const orderVersionIdFinal = orderVersionId || baseManifest.order_version_id || ensureOrderVersion(Number(workId) || 0).id;
  // initialBindingId === undefined → 继承父提交；显式给 null → 清空（回退开篇设定）。
  const initialBinding = initialBindingId === undefined ? (baseManifest.initial_binding_id || null) : (initialBindingId || null);
  const manifest = {
    version: 1,
    order_version_id: String(orderVersionIdFinal),
    chapters: { ...baseManifest.chapters, ...(chapters || {}) },
    ...(initialBinding ? { initial_binding_id: initialBinding } : {}),
  };
  const manifestHash = hashJson(manifest);
  const parentId = parent ? parent.id : null;
  const id = 'cmt_' + sha16(`${wl.id}|${parentId || ''}|${manifestHash}|${note}`);
  const existing = getCommit(id);
  if (existing) {
    if (!wl.head_commit_id || (parent && wl.head_commit_id === parentId)) {
      // 幂等重放：同一父 + 同一清单 + 同一备注 → 返回既有提交，不重复推进 HEAD。
      return { commit: existing, manifest: existing.manifest, reused: true };
    }
    return { commit: existing, manifest: existing.manifest, reused: true };
  }
  prep(`INSERT INTO story_commits (id, work_id, worldline_id, parent_commit_id, order_version_id, manifest_json, manifest_hash, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, Number(workId) || 0, wl.id, parentId, manifest.order_version_id, JSON.stringify(manifest), manifestHash, String(note || ''), now());
  prep('UPDATE story_worldlines SET head_commit_id = ? WHERE id = ?').run(id, wl.id);
  return { commit: getCommit(id), manifest, reused: false };
}

/** 某提交在指定章节选中的 binding id。 */
export function bindingIdOfChapter(commit, chapterId) {
  const m = manifestOf(commit);
  return m.chapters[String(Number(chapterId))] || null;
}

/** 章序版本解析（历史查询必须用提交自带的版本，不用当前顺序改写历史）。 */
export function orderOfCommit(commit) {
  const m = manifestOf(commit);
  const v = getOrderVersion(m.order_version_id);
  if (!v || !v.parsed) return { order_version_id: m.order_version_id, chapters: [], scenes: {} };
  return {
    order_version_id: m.order_version_id,
    chapters: (v.parsed.chapters || []).map(Number),
    scenes: v.parsed.scenes || {},
  };
}
