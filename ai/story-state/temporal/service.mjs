/**
 * 时态故事状态 · 单一保存后处理服务与作者确认入口（方案的唯一生产接线点）。
 *
 * 两条流程：
 *   recordContentSave —— 正文事实变化后（且仅在**真的变化**时）：
 *     不可变 revision → 归档旧的待确认绑定 → 新建 pending 保存提案 → 返回；
 *     默认 HEAD 查询会在此章停住（pending），旧状态不会冒充新稿最新；
 *     本函数**不调用模型、不等待分析**，可安全放进保存请求的同步事务里。
 *   applyChapterEvents —— 作者确认一批事件（T1 为作者手动确认；T2 在其上加提案/审批）：
 *     落事件 → 对章前状态跑确定性校验（前置条件/证据）→ 输入/输出快照 → valid 绑定
 *     → 提交（HEAD CAS）→ 复制父提交信任覆盖 → 下游一律先 stale → 依赖入索引。
 *     任何一步失败整事务回滚；重复调用幂等（事件/绑定/提交均按内容寻址）。
 *
 * 纪律：未开启 temporal_enabled 的作品，本模块全部入口立即返回 {enabled:false}，不写一行。
 */
import { db, inTransaction, withTransaction } from '../../../db.js';
import { assertTemporalSchema, getTemporalConfig, isTemporalEnabled, setTemporalConfig } from './config.mjs';
import { getRevision, latestRevisionOf, recordRevision } from './revision-store.mjs';
import {
  createBinding, supersedePendingBindings, insertEvents, listBindings,
  getBinding, eventsOfBinding, updateBindingProposal,
  copyTrustOverlay,
} from './event-store.mjs';
import { saveSnapshot } from './snapshot.mjs';
import { stateAt, stateBefore, trustReport, listCommits } from './history.mjs';
import { ensureMainCommit, ensureMainWorldline, commitManifest, getCommit, manifestOf } from './worldline-store.mjs';
import { cursorOfChapter, ensureOrderVersion } from './order.mjs';
import { explainDecision, validateEventSet } from './validation.mjs';
import { dependenciesFromEvents, recordDependencies, summarizeDependencies } from './dependencies.mjs';
import { markDownstreamStale } from './impact.mjs';
import { canonicalJson, cellKey, normalizeEvent, sha16, TEMPORAL_ALGORITHM_VERSION, TEMPORAL_SCHEMA_VERSION } from './schema.mjs';
import { sanitizeText, summarizeProposalEvents } from './extraction.mjs';
import { statePanelData } from './projection.mjs';
import { refreshCompatProjection } from './compat.mjs';
import * as Approvals from '../approval.mjs';
function guard(workId) {
  const schema = assertTemporalSchema();
  if (!schema.ok) throw new Error(`TEMPORAL_SCHEMA_MISSING:${(schema.missing || []).join(',')}`);
  return isTemporalEnabled(workId);
}
function appearancesOfEvents(events) {
  const out = [];
  for (const event of events || []) {
    for (const op of event.ops || []) {
      const cell = op.cell || {};
      if (cell.domain !== 'appearance' || op.type !== 'set') continue;
      const value = op.value && typeof op.value === 'object' ? op.value : {};
      out.push({ name: String(value.name || cell.predicate || ''), entity_id: value.entity_id || null, scene_index: value.scene_index ?? null });
    }
  }
  return out.filter((x) => x.name);
}
function cellsOfEvents(events) {
  const cells = new Set();
  for (const event of events || []) for (const op of event.ops || []) if (op && op.cell) {
    try {
      cells.add(JSON.stringify([op.cell.domain, op.cell.entityId, op.cell.predicate, op.cell.scope || 'canon', op.cell.scope === 'character' ? op.cell.holderId ?? null : null]));
    } catch { /* 结构非法事件由校验层报告 */ }
  }
  return [...cells];
}
/** 事件 payload 的确定性摘要（写入提交备注，便于审计与幂等）。 */
function eventDigest(events) {
  const parts = [];
  for (const event of events || []) for (const op of event.ops || []) {
    parts.push(`${(op.cell || {}).domain}:${(op.cell || {}).entityId}:${(op.cell || {}).predicate}=${op.type}`);
  }
  return parts.join(',');
}
/** 反查某绑定所在的主世界线提交（历史回执用；找不到返回 null）。 */
function commitOf(workId, bindingId) {
  for (const row of listCommits(Number(workId) || 0, 200)) {
    const commit = getCommit(row.id);
    if (!commit) continue;
    for (const id of Object.values(manifestOf(commit).chapters)) {
      if (String(id) === String(bindingId)) return row.id;
    }
  }
  return null;
}

/** 提案载荷（cursor + ops + 证据锚点）的确定性摘要：确认与审批都按它复核，防止绑定被篡改。 */
export function payloadHashOfEvents(events = []) {
  const payload = (events || []).map((e) => ({
    cursor: e.cursor || null,
    story_time: e.story_time || null,
    ops: (e.ops || []).map((op) => ({
      type: op.type,
      cell: op.cell || null,
      expected: op.expected === undefined ? null : op.expected,
      value: op.value === undefined ? null : op.value,
    })),
    evidence: (e.evidence || []).map((x) => ({
      narrative: x.narrative, quote: x.quote || '',
      paragraph: x.paragraph === undefined ? null : x.paragraph,
    })),
  }));
  return sha16(canonicalJson(payload));
}

/** 作者一次授权（一次性审批）的服务端预检：不匹配就拒绝，**绝不消费无关审批**（AC-43）。 */
function precheckApproval({ approvalId, op, workId, chapterId = null, baselineHash = '', binding = {} }) {
  const row = Approvals.getApproval(String(approvalId || ''));
  if (!row) return { ok: false, decision: 'rejected', reason: '审批不存在（可能已被清理）' };
  if (row.status !== 'active') return { ok: false, decision: 'rejected', reason: `审批状态为 ${row.status}（默认单次消费），不可再用` };
  if (String(row.op) !== String(op)) return { ok: false, decision: 'rejected', reason: `审批用于 ${row.op}，不能顶替 ${op}` };
  if (Number(row.work_id) !== Number(workId)) return { ok: false, decision: 'rejected', reason: '审批属于另一部作品（跨作品审批无效）' };
  if (row.chapter_id !== null && row.chapter_id !== undefined && Number(row.chapter_id) !== Number(chapterId)) {
    return { ok: false, decision: 'rejected', reason: `审批绑定的是第 #${row.chapter_id} 章，本次是 #${chapterId}` };
  }
  if (row.expires_at && String(row.expires_at) <= new Date().toISOString()) {
    return { ok: false, decision: 'rejected', reason: '审批已过期：请作者重新确认' };
  }
  if (baselineHash && row.baseline_hash && String(row.baseline_hash) !== String(baselineHash)) {
    return { ok: false, decision: 'rejected', reason: '审批所绑定的基线已变化（提案在其后发生修改）：本审批不适用，且未被消费' };
  }
  let want = {};
  try { want = JSON.parse(row.binding_json || '{}'); } catch { want = {}; }
  const problem = Approvals.checkBinding(String(row.op), want, binding || {});
  if (problem) return { ok: false, decision: 'rejected', reason: problem };
  return { ok: true, approval: row };
}

/** 事务收尾：把"审批消费失败"转成明确回执（且整事务回滚），其余异常原样抛出。 */
function commitOrRollback(run) {
  if (inTransaction()) return run();
  try {
    return withTransaction(run);
  } catch (e) {
    if (e && e.approvalVerdict) {
      return {
        ok: false, enabled: true, decision: 'rejected',
        reason: `审批消费失败：${e.approvalVerdict.reason || ''}`,
        issues: [{ code: 'APPROVAL_CONSUME_FAILED', detail: String(e.approvalVerdict.code || '') }],
      };
    }
    throw e;
  }
}

/** 在事务内消费审批；失败抛出（由 commitOrRollback 转回执并整体回滚写入）。 */
function consumeApprovalOrThrow(approval, { op, workId, chapterId, baselineHash, binding }) {
  const verdict = Approvals.consumeApproval(String(approval.id), { op, workId, chapterId, baselineHash, binding, by: 'author' });
  if (!verdict.ok) {
    const err = new Error('APPROVAL_CONSUME_FAILED:' + verdict.code + ':' + verdict.reason);
    err.approvalVerdict = verdict;
    throw err;
  }
  return verdict.approval;
}

/**
 * 提案绑定的服务端复核（T2 §6.1）：契约 / 章序 / 输入快照（状态哈希 + 提交）/ payload hash。
 * 过期提案**原样保留**：只返回冲突原因，绝不套用到新正文（重新分析后由新提案取代）。
 */
export function verifyPendingContext({ workId, chapterId, binding, stored = [], before = null } = {}) {
  const w = Number(workId) || 0;
  const pending = (binding && ((binding.validation || {}).pending_context || (binding.contract_ref || {}).pending_context)) || null;
  if (!pending) {
    return { ok: false, decision: 'needs_review', reason: '提案缺少保存时绑定的输入上下文（旧版提案）：请对当前正文重新分析后再确认', issues: [{ code: 'PENDING_CONTEXT_MISSING' }], context: null };
  }
  const currentOrder = ensureOrderVersion(w);
  const contractVersion = String((pending.contract || {}).version || '');
  if (contractVersion && contractVersion !== TEMPORAL_SCHEMA_VERSION) {
    return { ok: false, decision: 'stale', reason: `契约版本已变化（提案 ${contractVersion} → 当前 ${TEMPORAL_SCHEMA_VERSION}）：请重新分析`, issues: [{ code: 'CONTRACT_CHANGED' }], context: pending };
  }
  if (pending.order_version_id && String(pending.order_version_id) !== String(currentOrder.id)) {
    return { ok: false, decision: 'stale', reason: '提案建立后章序发生了变化：提案已过期（保留可查），请重新分析', issues: [{ code: 'ORDER_CHANGED' }], context: pending };
  }
  if (pending.input_trusted === false) {
    return { ok: false, decision: 'needs_review', reason: '提案建立时上游尚不可信（章前状态不可用）：先补齐上游，再重新分析本章', issues: [{ code: 'INPUT_WAS_UNTRUSTED', detail: String(pending.input_unavailable_reason || '') }], context: pending };
  }
  const currentStateHash = before ? (before.state_content_hash || null) : null;
  const currentCommitId = before ? (before.commit_id || null) : null;
  if (pending.input_state_hash && currentStateHash && String(pending.input_state_hash) !== String(currentStateHash)) {
    return {
      ok: false, decision: 'stale',
      reason: '提案建立后章前状态发生了变化（上游有新确认）：该提案已过期（保留可查），请重新分析本章',
      issues: [{ code: 'INPUT_STATE_CHANGED', from: String(pending.input_state_hash), to: String(currentStateHash) }],
      context: pending,
    };
  }
  const payloadHash = payloadHashOfEvents(stored);
  const analysisPayload = ((binding.validation || {}).analysis || {}).payload_hash || null;
  const recordedPayload = pending.payload_hash || analysisPayload || null;
  if (recordedPayload && String(recordedPayload) !== String(payloadHash)) {
    return { ok: false, decision: 'needs_review', reason: '提案载荷与记录的分析结果不一致（绑定被改动或分析结果已更新）：请重新分析后再确认', issues: [{ code: 'PAYLOAD_HASH_MISMATCH' }], context: pending };
  }
  return {
    ok: true, decision: 'valid', payload_hash: payloadHash, context: pending,
    lineage_changed: !!(pending.input_commit_id && currentCommitId && String(pending.input_commit_id) !== String(currentCommitId)),
  };
}

/**
 * 重新分析前刷新提案的输入绑定（章前快照 / HEAD / 章序 / 输入状态哈希）。
 * 语义：分析结论只对"当时的输入"成立；输入变了必须重新分析——重新分析时绑定必须跟着更新，
 * 否则确认会被 verifyPendingContext 判为过期（这是有意的保护，不是故障）。
 */
/** 便捷入口：用当前存储复核 pending 绑定的输入是否仍有效（分析刷新与确认共用同一套规则）。 */
export function pendingInputCheck({ workId, chapterId, binding } = {}) {
  const before = stateBefore({ workId: Number(workId) || 0, chapterId: Number(chapterId) || 0 });
  if (before.ok === false || before.trusted !== true) {
    return { ok: false, decision: 'blocked', reason: '上游章节尚未验证通过：不能基于不可信前缀分析或确认' };
  }
  return verifyPendingContext({ workId, chapterId, binding, stored: eventsOfBinding(binding), before });
}
export function refreshPendingContext({ workId, chapterId, bindingId } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('refreshPendingContext: 缺少 workId / chapterId');
  const binding = getBinding(bindingId);
  if (!binding || Number(binding.work_id) !== w || Number(binding.chapter_id) !== c) {
    return { ok: false, reason: '提案不存在或不属于该章' };
  }
  const orderVersion = ensureOrderVersion(w);
  const headCommit = ensureMainCommit(w);
  const before = stateBefore({ workId: w, chapterId: c });
  const inputTrusted = before.ok !== false && before.trusted === true;
  let snapshot = null;
  if (inputTrusted) {
    const cursor = cursorOfChapter(w, c, orderVersion.order);
    snapshot = saveSnapshot({
      workId: w, chapterId: c, orderVersionId: before.order_version_id || orderVersion.id,
      cursor: { chapter_index: cursor.chapter_index, scene_index: cursor.scene_index, boundary: 'before' },
      state: before.state, stateHash: before.state_content_hash || null, commitId: before.commit_id || '',
    });
  }
  const previous = (binding.validation || {}).pending_context || {};
  const context = {
    ...previous,
    contract: { id: 'story-state-temporal', version: TEMPORAL_SCHEMA_VERSION, algorithm: TEMPORAL_ALGORITHM_VERSION },
    order_version_id: orderVersion.id,
    head_commit_id: headCommit ? headCommit.id : null,
    input_snapshot_id: snapshot ? snapshot.id : null,
    input_state_hash: inputTrusted ? (before.state_content_hash || null) : null,
    input_commit_id: inputTrusted ? (before.commit_id || null) : null,
    input_trusted: inputTrusted,
    input_unavailable_reason: inputTrusted ? null : (before.stop ? String(before.stop.reason) : 'upstream_untrusted'),
    payload_hash: null,
    refreshed_at: new Date().toISOString(),
  };
  updateBindingProposal({ bindingId: binding.id, validation: { ...(binding.validation || {}), pending_context: context } });
  return { ok: true, context };
}

/**
 * 保存后处理（所有正文写入口统一调用；见 T2 的 8 个接入点）。
 * @returns {object} JSON 安全的回执
 */
export function recordContentSave({ workId, chapterId, contentHtml, origin = {} } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('recordContentSave: 缺少 workId / chapterId');
  if (!guard(w)) return { enabled: false, work_id: w, chapter_id: c, recorded: false, reason: '该作品未开启时态故事状态引擎' };
  const run = () => {
    ensureMainCommit(w);
    const prevLatest = latestRevisionOf(c);
    const { revision, dedup } = recordRevision({ workId: w, chapterId: c, contentHtml, origin });
    if (dedup) {
      return { enabled: true, work_id: w, chapter_id: c, recorded: false, dedup: true, revision_id: revision.id, reason: '正文内容未变化：不产生新修订、不触发失效' };
    }
    // 仅格式变化（纯文本哈希不变）：沿用同一文本的既有事件挂到新修订上，不触发重复分析（AC-29）。
    const formatOnly = !!(prevLatest && String(prevLatest.id) !== String(revision.id)
      && String(prevLatest.text_hash) === String(revision.text_hash));
    const superseded = supersedePendingBindings(w, c);
    // T2 §6.1：提案必须绑定「作品 / 正文修订 / 输入快照 / HEAD / 章序 / 契约 / payload hash / 依赖 / 作者审批」。
    // 确认时由服务端逐项复核（verifyPendingContext）；过期提案原样保留，不套用到新正文。
    const orderVersion = ensureOrderVersion(w);
    const headCommit = ensureMainCommit(w);
    const before = stateBefore({ workId: w, chapterId: c });
    const inputTrusted = before.ok !== false && before.trusted === true;
    let inputSnapshot = null;
    if (inputTrusted) {
    const cursor = cursorOfChapter(w, c, orderVersion.order);
      inputSnapshot = saveSnapshot({
        workId: w, chapterId: c, orderVersionId: before.order_version_id || orderVersion.id,
        cursor: { chapter_index: cursor.chapter_index, scene_index: cursor.scene_index, boundary: 'before' },
        state: before.state, stateHash: before.state_content_hash || null, commitId: before.commit_id || '',
      });
    }
    let carried = null;
    if (formatOnly) {
      const sameText = listBindings(w, { chapterId: c, limit: 20 }).filter((x) => {
        if (!x.revision_id || !(x.event_ids || []).length) return false;
        const r = getRevision(x.revision_id);
        return !!(r && String(r.text_hash) === String(revision.text_hash));
      });
      // 优先沿用已经完成过分析的绑定（保留 analysis 状态，避免“格式修改后重新分析”）。
      carried = sameText.find((x) => String(((x.validation || {}).analysis || {}).status) === 'done') || sameText[0] || null;
    }
    const pendingContext = {
      contract: { id: 'story-state-temporal', version: TEMPORAL_SCHEMA_VERSION, algorithm: TEMPORAL_ALGORITHM_VERSION },
      kind: 'save_proposal_group',
      work_id: w, chapter_id: c,
      revision_id: revision.id, revision_text_hash: revision.text_hash,
      order_version_id: orderVersion.id,
      head_commit_id: headCommit ? headCommit.id : null,
      input_snapshot_id: inputSnapshot ? inputSnapshot.id : null,
      input_state_hash: inputTrusted ? (before.state_content_hash || null) : null,
      input_commit_id: inputTrusted ? (before.commit_id || null) : null,
      input_trusted: inputTrusted,
      input_unavailable_reason: inputTrusted ? null : (before.stop ? String(before.stop.reason) : 'upstream_untrusted'),
      payload_hash: carried ? payloadHashOfEvents(eventsOfBinding(carried)) : null,
      dependencies: carried ? summarizeDependencies(dependenciesFromEvents(eventsOfBinding(carried), { workId: w })) : [],
      created_at: new Date().toISOString(),
    };
    const binding = createBinding({
      workId: w, chapterId: c, revisionId: revision.id,
      eventIds: carried ? carried.event_ids : [], validity: 'pending',
      validation: carried
        ? {
            ...(carried.validation || {}), kind: 'proposal_group', revision_text_hash: revision.text_hash,
            pending_context: pendingContext,
            note: '仅格式变化：沿用同一文本的事件与结论，无需重新分析',
            analysis: {
              ...((carried.validation || {}).analysis || {}), status: 'done', carried_from: carried.id,
              note: '仅格式变化：沿用此前已确认的事件，无需重新分析',
            },
          }
        : { kind: 'save', note: '保存后等待分析与作者确认', revision_text_hash: revision.text_hash, pending_context: pendingContext },
      appearances: carried ? carried.appearances : [],
      contractRef: carried
        ? { ...(carried.contract_ref || {}), kind: 'save_proposal', origin: String(origin.kind || 'save'), revision_text_hash: revision.text_hash, pending_context: pendingContext }
        : { kind: 'save_proposal', origin: String(origin.kind || 'save'), revision_text_hash: revision.text_hash, pending_context: pendingContext },
    });
    return {
      enabled: true, work_id: w, chapter_id: c, recorded: true, dedup: false, format_only: formatOnly,
      revision_id: revision.id, binding_id: binding.id, superseded_pending: superseded,
      carried_events: carried ? (carried.event_ids || []).length : 0,
      pending_context: pendingContext,
      invalidated: { mode: 'pending_stop', note: '默认 HEAD 查询将在此章停住；下游必须在确认后重新验证。' },
    };
  };
  return inTransaction() ? run() : withTransaction(run);
}
/**
 * 作者确认一批事件（正文必须已有修订；同一内容 + 同一事件集幂等）。
 * @param {object} args
 * @param {number} args.workId
 * @param {number} args.chapterId
 * @param {Array} args.events 原始事件（normalizeEvent 形状，revision_id 可缺省=本章最新修订）
 * @param {string} [args.source] 来源标记（author_confirm / author_correction / import_rebuild）
 * @param {string} [args.author] 作者标识（审计用）
 * @param {string|null} [args.expectedHead] HEAD CAS；默认=当前 HEAD
 */
export function applyChapterEvents({ workId, chapterId, events = [], source = 'author_confirm', author = 'author', expectedHead = null, contentHtml = null, approval = null } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('applyChapterEvents: 缺少 workId / chapterId');
  if (!guard(w)) return { ok: false, enabled: false, decision: 'disabled', reason: '该作品未开启时态故事状态引擎' };
  const run = () => {
    if (contentHtml !== null && contentHtml !== undefined) {
      recordRevision({ workId: w, chapterId: c, contentHtml, origin: { kind: 'confirm_input' } });
    }
    const revision = latestRevisionOf(c);
    if (!revision) {
      return { ok: false, enabled: true, decision: 'blocked', reason: '该章节还没有任何正文修订：先保存正文或随确认提供 content_html。', issues: [] };
    }
    ensureMainCommit(w);
    const before = stateBefore({ workId: w, chapterId: c });
    const upstreamTrusted = before.ok !== false && before.trusted === true;
    let stored = [];
    try {
      const normalized = (events || []).map((e) => normalizeEvent(e, { workId: w, chapterId: c, revisionId: revision.id }));
      stored = insertEvents(normalized);
    } catch (e) {
      return { ok: false, enabled: true, decision: 'conflict', reason: `事件结构非法：${e.message}`, issues: [{ code: 'EVENT_NORMALIZE_FAILED', message: String(e.message || e) }], revision_id: revision.id };
    }
    const report = validateEventSet({ workId: w, chapterId: c, revision, events: stored, inputState: before.state, upstreamTrusted });
    if (report.decision !== 'valid') {
      return {
        ok: false, enabled: true, decision: report.decision, reason: explainDecision(report),
        issues: [...report.conflicts, ...report.unresolved], revision_id: revision.id,
        event_ids: stored.map((e) => e.id), upstream_trusted: upstreamTrusted,
      };
    }
    const finalized = finalizeValidGroup({ workId: w, chapterId: c, revision, stored, report, before, source, author, expectedHead });
    if (finalized && finalized.ok && approval && approval.id) {
      consumeApprovalOrThrow(approval, {
        op: String(approval.op || 'temporal_apply'), workId: w, chapterId: c,
        baselineHash: String(approval.baselineHash || ''), binding: approval.binding || {},
      });
      finalized.approval = { id: String(approval.id), op: String(approval.op || 'temporal_apply'), consumed: true };
    }
    return finalized;
  };
  return commitOrRollback(run);}
/**
 * 校验通过后的统一收尾（作者确认 与 提案确认 共用）：
 * 快照 → valid 绑定 → 提交（HEAD CAS）→ 复制信任覆盖 → 下游 stale → 依赖索引。
 * 任何一步失败由调用方的事务整体回滚；重复调用按内容寻址幂等。
 */
function finalizeValidGroup({ workId: w, chapterId: c, revision, stored, report, before, source, author, expectedHead = null, assumptions = [] }) {
  const orderVersion = ensureOrderVersion(w);
  const cursor = cursorOfChapter(w, c, orderVersion.order);
  const inputSnap = saveSnapshot({
    workId: w, chapterId: c, orderVersionId: before.order_version_id || orderVersion.id,
    cursor: { chapter_index: cursor.chapter_index, scene_index: cursor.scene_index, boundary: 'before' },
    state: before.state, stateHash: before.state_content_hash || null, commitId: before.commit_id || '',
  });
  const eventHashes = stored.map((e) => e.event_hash);
  const outputSnap = saveSnapshot({
    workId: w, chapterId: c, orderVersionId: orderVersion.id, cursor,
    state: report.output_state, stateHash: report.output_state_hash || null,
    commitId: before.commit_id || '', revisionIds: [revision.id], eventHashes,
  });
  const appearances = appearancesOfEvents(stored);
  const binding = createBinding({
    workId: w, chapterId: c, revisionId: revision.id, eventIds: stored.map((e) => e.id), validity: 'valid',
    inputSnapshotId: inputSnap.id, outputSnapshotId: outputSnap.id,
    validation: {
      decision: 'valid', checked: report.checked, state_content_hash: report.output_state_hash, input_state_hash: report.input_state_hash,
      // 行动前提随确认保留（去重、截断）；复核与影响分析按它检查动机/资源/承诺/知识。
      assumptions: (assumptions || []).slice(0, 40).map((a) => ({
        kind: String((a && a.kind) || 'reason'),
        statement: sanitizeText(String((a && a.statement) || ''), 200).trim(),
        quote: sanitizeText(String((a && a.quote) || ''), 200).trim(),
      })).filter((a) => a.statement),
    },
    appearances,
    contractRef: { kind: 'author_confirm', source, author, revision_text_hash: revision.text_hash, state_content_hash: report.output_state_hash, contract_version: TEMPORAL_SCHEMA_VERSION },
  });
  if (!binding.output_snapshot_id) throw new Error('BINDING_OUTPUT_SNAPSHOT_REQUIRED');
  const parentCommitId = before.commit_id || null;
  const { commit, reused } = commitManifest({
    workId: w, worldlineId: ensureMainWorldline(w).id, parentCommitId,
    orderVersionId: orderVersion.id, chapters: { [String(c)]: binding.id },
    note: `${source}:${c}:${binding.id}`, expectedHead: expectedHead === null ? parentCommitId : expectedHead,
  });
  copyTrustOverlay({ workId: w, fromCommitId: parentCommitId, toCommitId: commit.id, exceptBindingIds: [binding.id] });
  const impact = markDownstreamStale({
    workId: w, fromChapterId: c, commitId: commit.id, reason: `${source}:upstream_changed`,
    changedCells: cellsOfEvents(stored),
  });
  supersedePendingBindings(w, c, { exceptId: binding.id });
  const deps = recordDependencies({ workId: w, bindingId: binding.id, events: stored });
  // 兼容视图（characters.status / character_relations）只从**已确认状态**单向投影；旧字段不再直写（AC-44）。
  const compat = refreshCompatProjection({ workId: w, state: report.output_state, commitId: commit.id });
  return {
    ok: true, enabled: true, decision: 'valid', work_id: w, chapter_id: c, compat,
    revision_id: revision.id, event_ids: stored.map((e) => e.id),
    binding_id: binding.id, commit_id: commit.id, commit_reused: !!reused,
    input_snapshot_id: inputSnap.id, output_snapshot_id: outputSnap.id,
    state_content_hash: report.output_state_hash,
    appearances, dependencies: summarizeDependencies(deps),
    invalidated: impact.applied,
    validation: { checked: report.checked, decision: report.decision },
  };
}
/** 章节状态面板（正文下方「本章状态」的真实数据源）。 */
export function chapterPanel({ workId, chapterId, boundary = 'after', includeFull = false } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('chapterPanel: 缺少 workId / chapterId');
  if (!guard(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  return { enabled: true, ...statePanelData({ workId: w, chapterId: c, boundary, includeFull }) };
}
/** 历史查询（透传 history.stateAt 的门控包装）。 */
export function stateAtChapter({ workId, chapterId, boundary = 'after', commitId = null, worldlineId = null } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('stateAtChapter: 缺少 workId / chapterId');
  if (!isTemporalEnabled(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  const view = stateAt({ workId: w, chapterId: c, boundary, commitId, worldlineId });
  return { enabled: true, ...view, state_json: view.state_json || Object.fromEntries(view.state.entries()) };
}
/** 引擎总览（设置页与验收脚本共用）。 */
export function temporalOverview(workId, { commitLimit = 10 } = {}) {
  const w = Number(workId) || 0;
  const config = getTemporalConfig(w);
  const schema = assertTemporalSchema();
  let head = null;
  let trust = null;
  let commits = [];
  if (config.enabled && schema.ok) {
    try {
      head = ensureMainCommit(w);
      trust = trustReport({ workId: w });
      commits = listCommits(w, commitLimit);
    } catch {
      head = null;
      trust = null;
      commits = [];
    }
  }
  return {
    ok: true, work_id: w, config, schema_ok: schema.ok, missing_tables: schema.missing || [],
    head_commit_id: head ? head.id : null,
    order_version_id: head ? head.order_version_id : null,
    manifest_size: head ? Object.keys(manifestOf(head).chapters).length : 0,
    trust, commits,
    version: 1,
  };
}
export { setTemporalConfig };


/** 本章待确认提案（分析目标）：唯一入口，避免各处自己拼 pending 判断。 */
export function analysisTarget({ workId, chapterId } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('analysisTarget: 缺少 workId / chapterId');
  if (!guard(w)) return { enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  const revision = latestRevisionOf(c);
  const pending = listBindings(w, { chapterId: c, validity: 'pending', limit: 20 })
    .find((b) => String((b.contract_ref || {}).kind) === 'save_proposal') || null;
  if (!revision) return { enabled: true, work_id: w, chapter_id: c, status: 'no_content', revision: null, binding: null };
  if (!pending) return { enabled: true, work_id: w, chapter_id: c, status: 'up_to_date', revision, binding: null };
  if (String(pending.revision_id) !== String(revision.id)) {
    return { enabled: true, work_id: w, chapter_id: c, status: 'stale', revision, binding: pending };
  }
  const analysis = (pending.validation || {}).analysis || {};
  return { enabled: true, work_id: w, chapter_id: c, status: analysis.status || 'pending', revision, binding: pending, analysis };
}
/** 分析上下文：章前状态（权威来源）+ 已知实体名（避免模型自造名字）。 */
export function analysisContext({ workId, chapterId } = {}) {
  const t = analysisTarget({ workId, chapterId });
  if (!t.enabled) return t;
  if (!t.revision) return { ...t, ok: false, reason: '该章节还没有正文修订：先保存正文' };
  const w = t.work_id;
  const c = t.chapter_id;
  const before = stateBefore({ workId: w, chapterId: c });
  if (before.ok === false) return { ...t, ok: false, reason: before.reason || '章前状态不可用' };
  const names = (sql) => db.prepare(sql).all(w).map((r) => String(r.name || r.title || '')).filter(Boolean);
  return {
    ...t, ok: true,
    boundary: 'before',
    commit_id: before.commit_id || null,
    trusted: !!before.trusted,
    state_json: Object.fromEntries(before.state.entries()),
    known: {
      characters: names('SELECT name FROM characters WHERE work_id = ? ORDER BY id ASC'),
      plotlines: names('SELECT title FROM plotlines WHERE work_id = ? ORDER BY id ASC'),
      terms: names('SELECT title FROM terms WHERE work_id = ? ORDER BY id ASC'),
    },
  };
}
/** 开始分析：pending → running（CAS；过期或被替代的分析不得回写）。 */
export function beginAnalysis({ workId, chapterId, expectedBindingId = null } = {}) {
  const t = analysisTarget({ workId, chapterId });
  if (!t.enabled) return { ...t, ok: false };
  if (t.status === 'no_content' || t.status === 'up_to_date') return { ...t, ok: false };
  if (!t.binding) return { ...t, ok: false, reason: '没有待确认提案' };
  if (expectedBindingId && String(t.binding.id) !== String(expectedBindingId)) {
    return { ok: false, enabled: true, work_id: t.work_id, chapter_id: t.chapter_id, status: 'stale', reason: '提案已被新的保存替代' };
  }
  const current = t.analysis || {};
  if (current.status === 'running' && current.lease_expires_at && Date.parse(current.lease_expires_at) > Date.now()) {
    return { ok: false, enabled: true, work_id: t.work_id, chapter_id: t.chapter_id, status: 'running', reason: '已有分析在进行中', binding_id: t.binding.id };
  }
  const run = () => {
    // 分析必须针对**当前**输入：刷新章前快照/HEAD/章序绑定，并清空上一次分析的载荷哈希。
    const refreshed = refreshPendingContext({ workId: t.work_id, chapterId: t.chapter_id, bindingId: t.binding.id });
    const fresh = refreshed.ok ? getBinding(t.binding.id) : t.binding;
    const requestId = 'an_' + sha16(`${t.work_id}|${t.chapter_id}|${t.binding.id}|${(Number(current.attempts) || 0) + 1}`);
    const analysis = {
      ...current, status: 'running', request_id: requestId,
      attempts: (Number(current.attempts) || 0) + 1,
      started_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    updateBindingProposal({ bindingId: t.binding.id, validation: { ...(fresh.validation || {}), analysis } });
    return { ok: true, enabled: true, work_id: t.work_id, chapter_id: t.chapter_id, status: 'running', revision_id: t.revision.id, binding_id: t.binding.id, analysis, pending_context: (fresh.validation || {}).pending_context || null };
  };
  return commitOrRollback(run);
}
/** 分析完成：把候选事件挂到待确认绑定上（**不写正式状态**，等作者确认）。 */
export function completeAnalysis({ workId, chapterId, bindingId, events = [], assumptions = [], provider = 'model', model = '', inputHash = '', resultHash = '', issues = [] } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('completeAnalysis: 缺少 workId / chapterId');
  if (!guard(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  const run = () => {
    const binding = getBinding(bindingId);
    if (!binding || Number(binding.work_id) !== w || Number(binding.chapter_id) !== c) {
      return { ok: false, enabled: true, decision: 'rejected', reason: '提案不存在或不属于该章' };
    }
    if (binding.validity !== 'pending') {
      return { ok: false, enabled: true, decision: 'stale', reason: `提案已 ${binding.validity}：过期分析结果不得回写` };
    }
    const revision = latestRevisionOf(c);
    if (!revision || String(revision.id) !== String(binding.revision_id)) {
      return { ok: false, enabled: true, decision: 'stale', reason: '保存了更新的正文：分析结果已过期' };
    }
    let stored = [];
    try {
      const revisionId = binding.revision_id;
      stored = insertEvents((events || []).map((e) => normalizeEvent(e, { workId: w, chapterId: c, revisionId })));
    } catch (e) {
      return { ok: false, enabled: true, decision: 'needs_review', reason: `事件结构非法：${e.message}`, issues: [{ code: 'EVENT_INVALID', message: String(e.message || e) }] };
    }
    const summary = summarizeProposalEvents(stored);
    const deps = dependenciesFromEvents(stored, { workId: w, bindingId: binding.id });
    // 行动前提（T3 §7.1）：随提案组一起等待作者确认；确认后随 valid 绑定保留，供隐性因果复核使用。
    const cleanAssumptions = (assumptions || []).slice(0, 40).map((a) => ({
      kind: String((a && a.kind) || 'reason'),
      statement: sanitizeText(String((a && a.statement) || ''), 200).trim(),
      quote: sanitizeText(String((a && a.quote) || ''), 200).trim(),
    })).filter((a) => a.statement);
    const analysis = {
      ...((binding.validation || {}).analysis || {}),
      status: 'done', provider, model,
      finished_at: new Date().toISOString(),
      input_hash: inputHash, result_hash: resultHash,
      payload_hash: payloadHashOfEvents(stored),
      payload_dependencies: summarizeDependencies(deps),
      assumptions_count: cleanAssumptions.length,
      issues: (issues || []).slice(0, 20), summary,
    };
    const updated = updateBindingProposal({
      bindingId: binding.id,
      eventIds: stored.map((e) => e.id),
      appearances: appearancesOfEvents(stored),
      validation: { ...(binding.validation || {}), kind: 'proposal_group', revision_text_hash: revision.text_hash, assumptions: cleanAssumptions, analysis },
      contractRef: { ...(binding.contract_ref || {}), kind: 'save_proposal', payload_hash: payloadHashOfEvents(stored), proposal: summary, dependencies: summarizeDependencies(deps) },
    });
    return {
      ok: true, enabled: true, status: 'done', binding_id: updated.id, revision_id: revision.id,
      event_ids: stored.map((e) => e.id), proposal: summary, dependencies: summarizeDependencies(deps), issues: analysis.issues,
    };
  };
  return inTransaction() ? run() : withTransaction(run);
}
/** 分析失败 / 未运行（无模型）：如实记录，保存本身不受影响。 */
export function finishAnalysis({ workId, chapterId, bindingId, status = 'failed', error = '', provider = 'model' } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('finishAnalysis: 缺少 workId / chapterId');
  if (!guard(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c };
  const binding = getBinding(bindingId);
  if (!binding || binding.validity !== 'pending') return { ok: false, enabled: true, reason: '提案不存在或已不是待确认状态' };
  const analysis = {
    ...((binding.validation || {}).analysis || {}),
    status: String(status), provider,
    error: sanitizeText(error, 300),
    finished_at: new Date().toISOString(),
  };
  updateBindingProposal({ bindingId: binding.id, validation: { ...(binding.validation || {}), analysis } });
  return { ok: true, enabled: true, status: analysis.status, binding_id: binding.id, analysis };
}
/** 本章统一提案组（界面一次确认的对象）。 */
export function listProposalGroups({ workId, chapterId = null, limit = 20 } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('listProposalGroups: 缺少 workId');
  if (!guard(w)) return { ok: false, enabled: false, work_id: w, proposals: [] };
  const rows = listBindings(w, { chapterId, validity: 'pending', limit });
  const proposals = rows
    .filter((b) => String((b.contract_ref || {}).kind) === 'save_proposal')
    .map((b) => ({
      binding_id: b.id, chapter_id: b.chapter_id, revision_id: b.revision_id,
      created_at: b.created_at,
      status: ((b.validation || {}).analysis || {}).status || 'pending',
      analysis: (b.validation || {}).analysis || {},
      proposal: (b.contract_ref || {}).proposal || { events: 0, ops: 0, by_domain: {} },
      event_ids: b.event_ids || [],
      input_snapshot_id: b.input_snapshot_id,
      output_snapshot_id: b.output_snapshot_id,
      pending_context: (b.validation || {}).pending_context || null,
    }));
  return { ok: true, enabled: true, work_id: w, chapter_id: chapterId, proposals };
}
/** 作者确认一个提案组（原子：校验 → 提交 → 信任覆盖 → 下游 stale → 依赖）。 */
export function confirmBinding({ workId, chapterId, bindingId, expectedHead = null, source = 'author_confirm', author = 'author', approvalId = null } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('confirmBinding: 缺少 workId / chapterId');
  if (!guard(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  const run = () => {
    const binding = getBinding(bindingId);
    if (!binding || Number(binding.work_id) !== w || Number(binding.chapter_id) !== c) {
      return { ok: false, enabled: true, decision: 'rejected', reason: '提案不存在或不属于该章' };
    }
    const revision = getRevision(binding.revision_id);
    if (!revision) return { ok: false, enabled: true, decision: 'blocked', reason: '提案引用的正文修订不存在' };
    if (binding.validity !== 'pending') {
      // 幂等：已经确认过的同一提案（或同内容同事件集的 valid 绑定）直接返回成功回执。
      if (binding.validity === 'valid') {
        return { ok: true, enabled: true, decision: 'valid', reused: true, binding_id: binding.id, commit_id: commitOf(w, binding.id), event_ids: binding.event_ids || [] };
      }
      if (binding.validity === 'superseded') {
        const same = listBindings(w, { chapterId: c, validity: 'valid', limit: 50 })
          .find((b) => String(b.revision_id) === String(binding.revision_id) && JSON.stringify(b.event_ids || []) === JSON.stringify(binding.event_ids || []));
        if (same) return { ok: true, enabled: true, decision: 'valid', reused: true, binding_id: same.id, commit_id: commitOf(w, same.id), event_ids: same.event_ids };
      }
      return { ok: false, enabled: true, decision: 'rejected', reason: `提案状态为 ${binding.validity}，不能确认` };
    }
    const latest = latestRevisionOf(c);
    if (latest && String(latest.id) !== String(revision.id) && String(latest.text_hash) !== String(revision.text_hash)) {
      return { ok: false, enabled: true, decision: 'stale', reason: '保存了更新的正文：该提案已过期，请重新分析' };
    }
    ensureMainCommit(w);
    const before = stateBefore({ workId: w, chapterId: c });
    const upstreamTrusted = before.ok !== false && before.trusted === true;
    if (!upstreamTrusted) {
      return { ok: false, enabled: true, decision: 'blocked', reason: '上游章节尚未验证通过：不能把新事实接到不可信前缀上', issues: [{ code: 'UPSTREAM_UNTRUSTED' }] };
    }
    const stored = eventsOfBinding(binding);
    if (!stored.length) return { ok: false, enabled: true, decision: 'needs_review', reason: '提案还没有事件（分析未完成或未产出变化）' };
    const pendingCheck = verifyPendingContext({ workId: w, chapterId: c, binding, stored, before });
    if (!pendingCheck.ok) {
      return {
        ok: false, enabled: true, decision: pendingCheck.decision, reason: pendingCheck.reason,
        issues: pendingCheck.issues, binding_id: binding.id, pending_context: pendingCheck.context,
      };
    }
    const payloadHash = pendingCheck.payload_hash;
    if (approvalId) {
      const pre = precheckApproval({
        approvalId, op: 'temporal_apply', workId: w, chapterId: c, baselineHash: payloadHash,
        binding: { binding_id: binding.id, revision_id: binding.revision_id, payload_hash: payloadHash },
      });
      if (!pre.ok) return { ok: false, enabled: true, decision: pre.decision, reason: pre.reason, binding_id: binding.id };
    }
    const report = validateEventSet({ workId: w, chapterId: c, revision, events: stored, inputState: before.state, upstreamTrusted });
    if (report.decision !== 'valid') {
      return {
        ok: false, enabled: true, decision: report.decision, reason: explainDecision(report),
        issues: [...report.conflicts, ...report.unresolved], binding_id: binding.id,
      };
    }
    const finalized = finalizeValidGroup({
      workId: w, chapterId: c, revision, stored, report, before, source, author, expectedHead,
      assumptions: (binding.validation || {}).assumptions || [],
    });
    if (finalized && finalized.ok && approvalId) {
      consumeApprovalOrThrow({ id: approvalId, op: 'temporal_apply' }, {
        op: 'temporal_apply', workId: w, chapterId: c, baselineHash: payloadHash,
        binding: { binding_id: binding.id, revision_id: binding.revision_id, payload_hash: payloadHash },
      });
      finalized.approval = { id: String(approvalId), op: 'temporal_apply', consumed: true };
    }
    return finalized;
  };
  return commitOrRollback(run);
}

/** 作者更正（手工改角色/关系/剧情线等的唯一命令入口）：形成 author_correction 事件。 */
export function correctAuthorState({ workId, chapterId, corrections = [], note = '', approvalId = null } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('correctAuthorState: 缺少 workId / chapterId');
  if (!guard(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  const before = stateBefore({ workId: w, chapterId: c });
  if (before.ok === false) return { ok: false, enabled: true, decision: 'blocked', reason: before.reason || '章前状态不可用' };
  const state = before.state;
  const ops = [];
  for (const item of corrections || []) {
    const kind = String(item && item.kind || '');
    let cell = null;
    let value;
    if (kind === 'character') {
      cell = { domain: 'character', entityId: String(item.entity_id || item.name || ''), predicate: String(item.predicate || 'status'), scope: 'canon' };
      value = item.value;
    } else if (kind === 'relation') {
      const from = String(item.from || ''); const to = String(item.to || '');
      const label = String(item.label || item.predicate || '关系');
      cell = { domain: 'relation', entityId: `${from}|${to}`, predicate: label, scope: 'canon' };
      value = { from, to, label, ...(item.description ? { description: String(item.description) } : {}) };
    } else if (kind === 'plotline') {
      cell = { domain: 'plotline', entityId: String(item.entity_id || item.title || ''), predicate: String(item.predicate || 'state'), scope: 'canon' };
      value = item.value;
    } else if (kind === 'knowledge') {
      cell = { domain: 'knowledge', entityId: String(item.entity_id || ''), predicate: String(item.predicate || 'state'), scope: 'character', holderId: String(item.holder_id || '') };
      value = item.value;
    } else if (kind === 'disclosure') {
      cell = { domain: 'disclosure', entityId: String(item.entity_id || ''), predicate: String(item.predicate || 'disclosed'), scope: 'reader' };
      value = item.value;
    } else {
      return { ok: false, enabled: true, decision: 'rejected', reason: `不支持的更正类型：${kind}` };
    }
    if (!cell.entityId || !cell.predicate) return { ok: false, enabled: true, decision: 'rejected', reason: '更正必须指明目标实体与字段' };
    let key;
    try { key = cellKey(cell); } catch (e) { return { ok: false, enabled: true, decision: 'rejected', reason: `更正目标非法：${e.message}` }; }
    const expected = state.has(key) ? { kind: 'value', value: state.get(key) } : { kind: 'missing' };
    ops.push(item.value === undefined || item.value === null
      ? { type: 'unset', cell, expected }
      : { type: 'set', cell, expected, value });
  }
  if (!ops.length) return { ok: false, enabled: true, decision: 'rejected', reason: '没有可应用的更正' };
  const events = [{ cursor: cursorOfChapter(w, c), ops, evidence: [{ narrative: 'present', note: note || '作者手动更正（统一命令入口）' }] }];
  const correctionsHash = correctionsHashOf(corrections);
  let approval = null;
  if (approvalId) {
    const pre = precheckApproval({
      approvalId, op: 'temporal_correction', workId: w, chapterId: c, baselineHash: correctionsHash,
      binding: { chapter_id: c, corrections_hash: correctionsHash },
    });
    if (!pre.ok) return { ok: false, enabled: true, decision: pre.decision, reason: pre.reason };
    approval = { id: pre.approval.id, op: 'temporal_correction', baselineHash: correctionsHash, binding: { chapter_id: c, corrections_hash: correctionsHash } };
  }
  const result = applyChapterEvents({ workId: w, chapterId: c, events, source: 'author_correction', author: 'author', approval });
  return { ...result, correction: true, corrections_hash: correctionsHash };
}

/** 提案组的载荷哈希与绑定信息（审批创建端点的服务端计算来源，客户端不能自报）。 */
export function proposalPayloadHash({ workId, chapterId = null, bindingId } = {}) {
  const w = Number(workId) || 0;
  const binding = getBinding(String(bindingId || ''));
  if (!binding || Number(binding.work_id) !== w) return { ok: false, reason: '提案不存在或不属于该作品' };
  if (chapterId && Number(binding.chapter_id) !== Number(chapterId)) return { ok: false, reason: '提案不属于该章' };
  const stored = eventsOfBinding(binding);
  return {
    ok: true, binding_id: binding.id, chapter_id: Number(binding.chapter_id), revision_id: binding.revision_id,
    validity: binding.validity, payload_hash: payloadHashOfEvents(stored), event_count: stored.length,
  };
}
/** 更正集合的确定性哈希（temporal_correction 审批的基线，服务端计算）。 */
export function correctionsHashOf(corrections = []) {
  return sha16(canonicalJson(corrections || []));
}
