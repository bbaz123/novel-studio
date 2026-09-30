/**
 * 时态故事状态 · 历史查询（按指定提交解析清单，而不是拼所有 applied 事件）。
 *
 * 语义（方案 §4.2 / §6.2）：
 *   · 章前 = 第 N−1 章章后；章后 = 第 N 章章后；目标章自身的事件只在章后出现。
 *   · 只沿「连续可信前缀」归约：中途遇到 missing / pending / stale / conflict /
 *     blocked / needs_review / rejected / superseded 的 binding 就停在它之前，
 *     并如实报告可信边界——**绝不用旧第 10 章状态冒充新稿最新状态**。
 *   · 历史提交保留旧正文与旧状态的一致组合（旧稿事件仍服务旧提交）。
 */
import { prep } from './stmt.mjs';
import { stateFromJson, reduceBatchInPlace, stateContentHash } from './reducer.mjs';
import {
  getBinding, assertBindingConsistent, bindingsByIds, eventsByIds,
  trustValidityOfCommit, effectiveValidity, pendingSaveIndex,
  pendingSaveNewerThanIn, latestSaveProposalBindingIn, validationReasonOf,
} from './event-store.mjs';
import { revisionsByIds } from './revision-store.mjs';
import { ensureMainWorldline, getWorldline, ensureMainCommit, getCommit, manifestOf, orderOfCommit } from './worldline-store.mjs';

const TRUSTED = new Set(['valid']);
const TERMINAL_BAD = new Set(['pending', 'stale', 'conflict', 'needs_review', 'blocked', 'rejected', 'superseded', 'missing']);

/** 解析目标提交：显式 commit_id 优先；其次指定世界线 HEAD；默认 main HEAD。 */
export function resolveCommit({ workId = 0, commitId = null, worldlineId = null } = {}) {
  if (commitId) {
    const c = getCommit(commitId);
    if (!c) throw new Error(`提交 ${commitId} 不存在`);
    if (Number(c.work_id) !== (Number(workId) || Number(c.work_id))) throw new Error('提交不属于该作品');
    return c;
  }
  const wl = worldlineId ? getWorldline(worldlineId) : ensureMainWorldline(Number(workId) || 0);
  if (!wl) return null;
  if (!wl.head_commit_id) return null;
  return getCommit(wl.head_commit_id);
}

/**
 * 沿提交清单归约到指定边界。
 * @returns {{state: Map, trusted: boolean, applied: number, stop: object|null, rows: Array}}
 */
export function reduceThroughIndex(commit, endExclusive, { currentness = false } = {}) {
  const order = orderOfCommit(commit);
  const manifestFull = manifestOf(commit);
  const manifest = manifestFull.chapters;
  const overlay = trustValidityOfCommit(commit.id);
  // 批量预取本章序前缀（+ 开篇设定）引用的绑定 / 事件 / 修订，以及「保存后待确认」索引：
  // 逐章逐事件查库在长篇上会退化成 O(N²) 次查询与语句编译。
  const bindingIdList = [];
  for (const id of Object.values(manifest)) if (id) bindingIdList.push(String(id));
  if (manifestFull.initial_binding_id) bindingIdList.push(String(manifestFull.initial_binding_id));
  const bindingById = bindingsByIds(bindingIdList, { lite: true });
  const eventIdList = [];
  for (const b of bindingById.values()) for (const eid of b.event_ids || []) eventIdList.push(String(eid));
  const eventById = eventsByIds(eventIdList, { lite: true });
  const revisionIdList = [];
  for (const b of bindingById.values()) revisionIdList.push(String(b.revision_id));
  for (const e of eventById.values()) revisionIdList.push(String(e.revision_id));
  const revisionById = revisionsByIds(revisionIdList, { lite: true });
  const cache = { events: eventById, revisions: revisionById };
  const stopAt = Math.max(0, Math.min(Number(endExclusive) || 0, order.chapters.length));
  // 只对本次要归约的前缀章节建 pending 索引：长篇上避免每次确认都扫描整个作品的待确认行。
  const pendingIndex = currentness ? pendingSaveIndex(commit.work_id, { chapterIds: order.chapters.slice(0, stopAt) }) : null;
  const rows = [];
  let state = stateFromJson('{}');
  let applied = 0;
  let stop = null;
  // 开篇设定（T7 bootstrap）：只接受**已确认**（valid）的绑定；未确认 / 缺失一律不进入初始状态，
  // 并如实记在 initial 里（不是猜测，也不是"第 0 章就拥有最新角色状态"）。
  let initial = null;
  if (manifestFull.initial_binding_id) {
    const initialBinding = bindingById.get(String(manifestFull.initial_binding_id)) || null;
    if (!initialBinding) {
      initial = { binding_id: manifestFull.initial_binding_id, validity: 'missing', applied: false, detail: '清单引用的开篇设定绑定不存在' };
    } else {
      const initialValidity = effectiveValidity(overlay, initialBinding);
      if (TRUSTED.has(initialValidity)) {
        try {
          const { events } = assertBindingConsistent(initialBinding, cache);
          state = reduceBatchInPlace(state, events);
          initial = { binding_id: initialBinding.id, validity: initialValidity, applied: true, events: (initialBinding.event_ids || []).length };
        } catch (e) {
          initial = { binding_id: initialBinding.id, validity: 'conflict', applied: false, detail: e.message };
        }
      } else {
        initial = { binding_id: initialBinding.id, validity: initialValidity, applied: false, detail: '开篇设定尚未确认：不进入初始状态' };
      }
    }
  }
  for (let i = 0; i < stopAt; i += 1) {
    const chapterId = order.chapters[i];
    const bindingId = manifest[String(chapterId)] || null;
    if (!bindingId) {
      // 未确认章节：若工作区里有保存后待确认的提案，默认查询必须停在 pending（不是 missing）。
      if (currentness && latestSaveProposalBindingIn(pendingIndex, chapterId)) {
        stop = { chapter_id: chapterId, index: i, reason: 'pending', detail: '本章有保存后尚未确认的正文：默认查询必须停在这里。' };
        break;
      }
      stop = { chapter_id: chapterId, index: i, reason: 'missing', detail: '该章还没有确认的状态绑定' };
      break;
    }
    const binding = bindingById.get(String(bindingId)) || null;
    if (!binding) {
      stop = { chapter_id: chapterId, index: i, reason: 'missing', detail: `清单引用的绑定 ${bindingId} 不存在` };
      break;
    }
    const validity = effectiveValidity(overlay, binding);
    if (!TRUSTED.has(validity)) {
      stop = { chapter_id: chapterId, index: i, reason: validity, detail: validationReasonOf(binding) };
      break;
    }
    // 默认（HEAD）查询必须看见「保存后未确认」：新正文已落 revision，但事件尚未确认。
    // 显式历史提交查询不做这项检查——旧提交回放不受新保存影响（AC-02）。
    if (currentness) {
      const newer = pendingSaveNewerThanIn(pendingIndex, chapterId, revisionById.get(String(binding.revision_id)) || null);
      if (newer) {
        stop = { chapter_id: chapterId, index: i, reason: "pending", detail: "本章有保存后尚未确认的新正文：旧状态不得冒充最新。" };
        break;
      }
    }
    try {
      const { events } = assertBindingConsistent(binding, cache);
      state = reduceBatchInPlace(state, events);
      applied += 1;
      rows.push({ chapter_id: chapterId, binding_id: binding.id, validity: binding.validity, applied: true });
    } catch (e) {
      stop = { chapter_id: chapterId, index: i, reason: 'conflict', detail: e.message };
      break;
    }
  }
  return { state, trusted: !stop && applied === stopAt, applied, stop, rows, order, initial };
}

/**
 * 历史查询主入口。
 * @returns {{ok:boolean, state:Map, state_json:object, validity:string, verified_through:number, ...}}
 */
export function stateAt({ workId, commitId = null, worldlineId = null, chapterId, boundary = 'after' }) {
  const w = Number(workId) || 0;
  const chapter = prep('SELECT id, work_id FROM chapters WHERE id = ?').get(Number(chapterId) || 0);
  if (!chapter) throw new Error('章节不存在');
  if (Number(chapter.work_id) !== w) throw new Error('章节不属于该作品');
  if (!['before', 'after'].includes(boundary)) throw new Error('boundary 必须是 before / after');
  const commit = resolveCommit({ workId: w, commitId, worldlineId });
  if (!commit) {
    return {
      ok: true, work_id: w, commit_id: null, worldline_id: null, order_version_id: null, chapter_id: Number(chapterId), boundary,
      state: stateFromJson('{}'), state_content_hash: stateContentHash(stateFromJson('{}')),
      validity: 'pending', verified_through: -1, trusted: false, applied: 0, chapters: [],
      initial: null,
      stop: { chapter_id: Number(chapterId), index: -1, reason: 'no_commit', detail: '该作品还没有任何时态提交' },
      note: '尚无时态提交：返回空状态而不是旧字段值。',
    };
  }
  const order = orderOfCommit(commit);
  let index = order.chapters.indexOf(Number(chapterId));
  if (index < 0) {
    // 场景：归到父章节
    const row = prep('SELECT parent_id FROM chapters WHERE id = ?').get(Number(chapterId));
    if (row && row.parent_id !== null && row.parent_id !== undefined) {
      index = order.chapters.indexOf(Number(row.parent_id));
    }
  }
  if (index < 0) {
    return {
      ok: false, work_id: w, commit_id: commit.id, worldline_id: commit.worldline_id || null, order_version_id: commit.order_version_id,
      chapter_id: Number(chapterId), boundary, state: stateFromJson('{}'), validity: 'blocked',
      verified_through: -1, trusted: false, applied: 0, chapters: [],
      initial: null,
      stop: { chapter_id: Number(chapterId), index: -1, reason: 'chapter_not_in_order', detail: '章节不在该提交的章序版本里（可能是新插入的章节）' },
      note: '章节不在提交的顺序版本中：请先为它建立修订与绑定。',
    };
  }
  const endExclusive = boundary === 'after' ? index + 1 : index;
  const { state, applied, stop, rows, initial } = reduceThroughIndex(commit, endExclusive, { currentness: !commitId });
  const targetBindingId = manifestOf(commit).chapters[String(Number(chapterId))] || null;
  const targetBinding = targetBindingId ? getBinding(targetBindingId) : null;
  const targetValidity = targetBinding ? effectiveValidity(trustValidityOfCommit(commit.id), targetBinding) : 'missing';
  const targetApplied = rows.some((r) => Number(r.chapter_id) === Number(chapterId));
  let validity;
  if (stop) validity = stop.reason === 'missing' ? 'missing' : stop.reason;
  else if (boundary === 'before') validity = targetValidity === 'missing' && !targetApplied ? 'valid' : 'valid';
  else validity = targetApplied ? 'valid' : 'missing';
  return {
    ok: true,
    work_id: w,
    commit_id: commit.id,
    worldline_id: commit.worldline_id || null,
    order_version_id: commit.order_version_id,
    chapter_id: Number(chapterId),
    boundary,
    state,
    state_json: Object.fromEntries(state.entries()),
    state_content_hash: stateContentHash(state),
    validity,
    target_binding_id: targetBindingId,
    target_revision_id: targetBinding ? targetBinding.revision_id : null,
    target_validity: targetValidity,
    verified_through: applied - 1,
    trusted: !stop && applied === Math.max(0, endExclusive),
    applied,
    chapters: rows,
    initial,
    stop,
    policy: {
      authoritative: 'story_commits.manifest + story_chapter_bindings.validity + story_state_events',
      note: '可信前缀之外不返回旧状态；未确认的章节显示 pending / stale，而不是旧快照冒充。开篇设定（initial_binding_id）只有已确认才进入初始状态。',
    },
  };
}

/** 章前状态（写第 N 章用；= 第 N−1 章章后）。 */
export function stateBefore({ workId, chapterId, commitId = null, worldlineId = null }) {
  return stateAt({ workId, commitId, worldlineId, chapterId, boundary: 'before' });
}

/** 逐章信任报告（面板/上下文/失败诊断共用）。 */
export function trustReport({ workId, commitId = null, worldlineId = null }) {
  const w = Number(workId) || 0;
  const commit = resolveCommit({ workId: w, commitId, worldlineId });
  if (!commit) return { ok: true, work_id: w, commit_id: null, chapters: [], trusted_through: -1, totals: { valid: 0, pending: 0, stale: 0, missing: 0, other: 0 } };
  const order = orderOfCommit(commit);
  const manifest = manifestOf(commit).chapters;
  const overlay = trustValidityOfCommit(commit.id);
  // 显式历史提交只报告该提交的信任；默认查询才叠加"工作区里有更新保存未确认"。
  const currentness = !commitId;
  // 批量预取（与 reduceThroughIndex 同一纪律）：逐章查绑定/修订在长篇上退化成 O(N²)。
  const pendingIndex = currentness ? pendingSaveIndex(w) : null;
  const bindingById = bindingsByIds(Object.values(manifest).filter(Boolean).map(String), { lite: true });
  const revisionById = revisionsByIds([...bindingById.values()].map((b) => String(b.revision_id)));
  const chapters = [];
  const totals = { valid: 0, pending: 0, stale: 0, missing: 0, other: 0 };
  let trustedThrough = -1;
  let broken = false;
  for (let i = 0; i < order.chapters.length; i += 1) {
    const chapterId = order.chapters[i];
    const bindingId = manifest[String(chapterId)] || null;
    const binding = bindingId ? (bindingById.get(String(bindingId)) || null) : null;
    const ownValidity = binding ? binding.validity : 'missing';
    const pendingSave = currentness
      ? (binding ? pendingSaveNewerThanIn(pendingIndex, chapterId, revisionById.get(String(binding.revision_id)) || null) : latestSaveProposalBindingIn(pendingIndex, chapterId))
      : null;
    const validity = pendingSave ? "pending" : effectiveValidity(overlay, binding);
    if (validity === 'valid' && !broken) trustedThrough = i;
    else if (validity !== 'valid') broken = true;
    if (validity === 'valid') totals.valid += 1;
    else if (validity === 'pending') totals.pending += 1;
    else if (validity === 'stale') totals.stale += 1;
    else if (validity === 'missing') totals.missing += 1;
    else totals.other += 1;
    chapters.push({ chapter_id: chapterId, index: i, binding_id: bindingId, validity, own_validity: ownValidity, pending_save: !!pendingSave, revision_id: binding ? binding.revision_id : null });
  }
  return {
    ok: true, work_id: w, commit_id: commit.id, order_version_id: commit.order_version_id,
    chapters, trusted_through: trustedThrough, totals,
  };
}

/** 提交时间线（供面板"可回看旧提交"）。 */
export function listCommits(workId, limit = 30) {
  return prep('SELECT id, worldline_id, parent_commit_id, order_version_id, manifest_hash, note, created_at FROM story_commits WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(Number(workId) || 0, Math.max(1, Number(limit) || 30));
}
