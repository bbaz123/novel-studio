/**
 * 时态故事状态 · 保守失效与影响计划（增量验证的起点，见方案 §8）。
 *
 * 核心纪律：
 *   · 上游正文/状态一旦变化，**所有下游章节先进入 stale**——不是"搜到角色名才失效"；
 *     隐性因果（无姓名但依赖旧前提）在 T1 就用保守全量失效兜住，T3 再逐章增量验证；
 *   · 状态哈希相同也**不得**跳过下游（AC-31）：lineage 变了就要重新验证，
 *     计划里保留 same_state_hash 标记，由后续验证流程决定是否仅更新验证来源；
 *   · 本模块只改 binding.validity（指针），不重写正文、不调用模型、不生成候选。
 */
import { db, inTransaction, withTransaction } from '../../../db.js';
import { prep } from './stmt.mjs';
import { resolveCommit, } from './history.mjs';
import { manifestOf, orderOfCommit } from './worldline-store.mjs';
import { bindingsByIds, setBindingValidity, setBindingTrustBulk } from './event-store.mjs';
import { bindingsDependingOn, resourceKeyOfCell } from './dependencies.mjs';
const INVALIDATABLE = new Set(['valid', 'pending', 'needs_review', 'conflict', 'blocked', 'waived']);
/**
 * 生成失效计划（只算不写）。
 * @param {object} args
 * @param {number} args.workId
 * @param {number} args.fromChapterId  发生变化的章节（含场景；场景归到父章节）
 * @param {string|null} args.commitId  基线提交（默认 main HEAD）
 * @param {string[]} args.changedCells cell 键列表（用于依赖命中解释；不用于排除）
 * @param {boolean|null} args.sameStateHash 上游状态内容哈希是否未变（仅记录，不跳过）
 * @param {number[]|null} args.orderChapters 覆盖章序（章序变化时用**新顺序**计算下游）
 */
export function invalidationPlan({ workId, fromChapterId, commitId = null, reason = 'upstream_content_changed', changedCells = [], sameStateHash = null, orderChapters = null } = {}) {
  const w = Number(workId) || 0;
  const commit = resolveCommit({ workId: w, commitId });
  if (!commit) {
    return { ok: true, work_id: w, commit_id: null, from_chapter_id: Number(fromChapterId) || 0, from_index: -1, actions: [], totals: { downstream: 0, will_stale: 0, already_bad: 0, missing_binding: 0, explicit_hits: 0 }, resources: [], policy: { note: '尚无提交：没有可失效的绑定。' } };
  }
  const order = orderOfCommit(commit);
  const chapters = Array.isArray(orderChapters) && orderChapters.length
    ? orderChapters.map(Number)
    : (Array.isArray(order.chapters) ? order.chapters : []);
  let fromIndex = chapters.indexOf(Number(fromChapterId));
  if (fromIndex < 0) {
    const row = prep('SELECT parent_id FROM chapters WHERE id = ?').get(Number(fromChapterId));
    if (row && row.parent_id !== null && row.parent_id !== undefined) fromIndex = chapters.indexOf(Number(row.parent_id));
  }
  if (fromIndex < 0) {
    return { ok: false, work_id: w, commit_id: commit.id, from_chapter_id: Number(fromChapterId) || 0, from_index: -1, actions: [], totals: { downstream: 0, will_stale: 0, already_bad: 0, missing_binding: 0, explicit_hits: 0 }, resources: [], note: '章节不在该提交的章序版本中：先补章序/绑定，再做失效。' };
  }
  const resources = [...new Set((changedCells || []).map(String))].map(resourceKeyOfCell);
  const hitRows = resources.length ? bindingsDependingOn(w, resources) : [];
  const hitBindings = new Set(hitRows.map((r) => r.binding_id));
  const manifest = manifestOf(commit).chapters;
  // 一次性预取全部下游绑定（只在内存里做 validity 判定）：逐章 getBinding 在长篇上会退化成 O(N²)。
  const downstreamBindingIds = [];
  for (let i = fromIndex + 1; i < chapters.length; i += 1) {
    const id = manifest[String(chapters[i])] || null;
    if (id) downstreamBindingIds.push(String(id));
  }
  const bindingById = bindingsByIds(downstreamBindingIds, { lite: true });
  const actions = [];
  const totals = { downstream: 0, will_stale: 0, already_bad: 0, missing_binding: 0, explicit_hits: 0 };
  for (let i = fromIndex + 1; i < chapters.length; i += 1) {
    const chapterId = chapters[i];
    const bindingId = manifest[String(chapterId)] || null;
    totals.downstream += 1;
    if (!bindingId) { totals.missing_binding += 1; actions.push({ chapter_id: chapterId, index: i, binding_id: null, from: 'missing', to: 'stale', reason: 'no_binding_yet', requires_semantic_review: false }); continue; }
    const binding = bindingById.get(String(bindingId)) || null;
    if (!binding) { totals.missing_binding += 1; actions.push({ chapter_id: chapterId, index: i, binding_id: bindingId, from: 'dangling', to: 'stale', reason: 'binding_dangling', requires_semantic_review: false }); continue; }
    if (!INVALIDATABLE.has(binding.validity)) {
      totals.already_bad += 1;
      actions.push({ chapter_id: chapterId, index: i, binding_id: bindingId, from: binding.validity, to: binding.validity, reason: 'already_not_trusted', requires_semantic_review: false });
      continue;
    }
    const explicit = hitBindings.has(bindingId);
    if (explicit) totals.explicit_hits += 1;
    totals.will_stale += 1;
    actions.push({
      chapter_id: chapterId, index: i, binding_id: bindingId,
      from: binding.validity, to: 'stale',
      reason: sameStateHash === true ? 'lineage_changed_state_hash_same' : (explicit ? 'explicit_dependency' : 'conservative_all_downstream'),
      explicit_dependency: explicit,
      requires_semantic_review: true,
    });
  }
  return {
    ok: true, work_id: w, commit_id: commit.id, from_chapter_id: Number(fromChapterId) || 0, from_index: fromIndex,
    reason: String(reason || 'upstream_content_changed'), same_state_hash: sameStateHash,
    resources, actions, totals,
    policy: {
      conservative: 'from_index 之后的所有持有绑定的章节一律先 stale；依赖图只用于解释与排序，不用于排除。',
      no_silent_rewrite: '失效只改 validity 指针；后文正文与候选生成必须等作者点击「重建受影响章节」。',
    },
  };
}
/** 应用失效计划（写 binding.validity='stale'）。返回实际改动数。 */
export function applyInvalidationPlan(plan) {
  if (!plan || plan.ok !== true || !Array.isArray(plan.actions)) return { changed: 0, skipped: 0 };
  const commitId = plan.commit_id ? String(plan.commit_id) : null;
  const write = () => {
    let changed = 0;
    let skipped = 0;
    // 先筛出可落地的 stale 动作，再批量读绑定、批量写覆盖表：
    // 逐条 getBinding + setBindingTrust 在下游很长时会退化成 O(N) 条语句。
    const candidates = [];
    for (const action of plan.actions) {
      if (action.to !== 'stale' || action.from === action.to || !action.binding_id) { skipped += 1; continue; }
      candidates.push(action);
    }
    if (!candidates.length) return { changed, skipped };
    // 提交级覆盖只需 validity（轻量）；无提交基线要拼 validation 片段，取完整视图。
    const bindingById = bindingsByIds(candidates.map((a) => a.binding_id), { lite: !!commitId });
    if (commitId) {
      const rows = [];
      for (const action of candidates) {
        const binding = bindingById.get(String(action.binding_id)) || null;
        if (!binding || !INVALIDATABLE.has(binding.validity)) { skipped += 1; continue; }
        // 提交级覆盖：旧提交没有覆盖行 → 仍按 binding 自身 validity 回放（AC-02）。
        rows.push({
          workId: plan.work_id, commitId, bindingId: action.binding_id, validity: 'stale',
          detail: { reason: action.reason, from: action.from, invalidated_by_chapter: plan.from_chapter_id, requires_semantic_review: !!action.requires_semantic_review },
        });
      }
      setBindingTrustBulk(rows);
      changed += rows.length;
    } else {
      const written = new Set();
      for (const action of candidates) {
        const binding = bindingById.get(String(action.binding_id)) || null;
        // 与逐条实现同一语义：同一 binding 先写 stale 后，后续重复动作视为 already_not_trusted 跳过。
        if (!binding || written.has(String(action.binding_id)) || !INVALIDATABLE.has(binding.validity)) { skipped += 1; continue; }
        const validation = {
          ...(binding.validation || {}),
          invalidated_reason: action.reason,
          invalidated_by_chapter: plan.from_chapter_id,
          invalidated_at: new Date().toISOString(),
          requires_semantic_review: !!action.requires_semantic_review,
        };
        setBindingValidity(action.binding_id, 'stale', { validation });
        written.add(String(action.binding_id));
        changed += 1;
      }
    }
    return { changed, skipped };
  };
  return inTransaction() ? write() : withTransaction(write);
}
/** 便捷入口：上游发生变化后的保守失效。 */
export function markDownstreamStale({ workId, fromChapterId, commitId = null, reason = 'upstream_content_changed', changedCells = [], sameStateHash = null } = {}) {
  const plan = invalidationPlan({ workId, fromChapterId, commitId, reason, changedCells, sameStateHash });
  const applied = applyInvalidationPlan(plan);
  return { ...plan, applied };
}
/**
 * 两个章序序列的最早差异（AC-30：插章/删章/跨卷移动后，从差异处开始失效）。
 * 返回 {index, chapter_id}：以**新顺序**里该位置的章节为准（新增章节取新 id）。
 */
export function earliestOrderDifference(oldChapters, newChapters) {
  const a = Array.isArray(oldChapters) ? oldChapters : [];
  const b = Array.isArray(newChapters) ? newChapters : [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return {
        index: i,
        chapter_id: b[i] !== undefined ? Number(b[i]) : Number(a[i]),
        old_chapter_id: a[i] === undefined ? null : Number(a[i]),
        new_chapter_id: b[i] === undefined ? null : Number(b[i]),
      };
    }
  }
  return null;
}
