/**
 * 时态故事状态 · 确定性校验义务（不调用模型）。
 *
 * 职责：把「一批候选事件能否被作者确认」拆成可核对的具体条目，而不是一个含糊的 VALID：
 *   · conflicts   —— 前置条件不满足 / 结构非法 / 批内重复 cell：**必须修**，不能当作有效；
 *   · unresolved  —— 证据缺失、引文找不到、文本哈希不匹配、回忆/梦境/转述等叙述类型：
 *                    结论只能是 needs_review（AC-08/AC-09 不许"死人复活"式误判）；
 *   · coverage    —— 事件、ops、evidence 是否**逐项**核对过具体修订；漏项不得冒充 valid。
 *
 * 纪律：本模块只读取已经落库的修订与调用方传入的输入状态；不做任何写入、不调用模型、
 * 不采信事件里自报的布尔值。validationDecision 的输入全部由这里确定性计算。
 */
import { parseCellKey, normalizeOp } from './schema.mjs';
import { reduceBatch, stateContentHash, validationDecision } from './reducer.mjs';
import { getRevision, revisionPlainText } from './revision-store.mjs';

const REVIEW_NARRATIVE = new Set(['flashback', 'dream', 'quote', 'report', 'unknown']);

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function conflict(code, extra = {}) {
  return { code, severity: 'conflict', ...extra };
}

function review(code, extra = {}) {
  return { code, severity: 'review', ...extra };
}

/**
 * 逐项核对一条事件的证据锚点。
 * @returns {Array<object>} unresolved 条目（可能为空）
 */
export function checkEvidenceAnchors(event, { revision, plainText }) {
  const out = [];
  const evidence = Array.isArray(event.evidence) ? event.evidence : [];
  if (!evidence.length) {
    out.push(review('EVIDENCE_MISSING', { event_id: event.id, note: '该事件没有任何证据锚点：只能待复核，不能直接确认。' }));
  }
  for (const [i, item] of evidence.entries()) {
    const at = { event_id: event.id, evidence_index: i };
    if (item.revision_id && String(item.revision_id) !== String(revision.id) && !item.text_hash) {
      // 同文本不同修订（纯格式变化）不构成锚点问题：正文内容未变，事件仍然成立。
      const ref = getRevision(item.revision_id);
      if (!ref || String(ref.text_hash) !== String(revision.text_hash)) {
        out.push(review('EVIDENCE_REVISION_UNKNOWN', { ...at, revision_id: String(item.revision_id), note: '证据指向的修订与本章绑定修订不同，且没有文本哈希可核对。' }));
      }
    }
    if (item.text_hash && String(item.text_hash) !== String(revision.text_hash)) {
      out.push(review('EVIDENCE_TEXT_HASH_MISMATCH', { ...at, expected: String(revision.text_hash), got: String(item.text_hash), note: '证据文本哈希与本章修订不一致：正文可能在提取后又被修改。' }));
    }
    if (item.quote) {
      if (!normText(plainText).includes(normText(item.quote))) {
        out.push(review('EVIDENCE_QUOTE_NOT_FOUND', { ...at, note: '证据引文在正文中找不到：锚点可疑，需人工复核。' }));
      }
    }
    if (REVIEW_NARRATIVE.has(String(item.narrative))) {
      out.push(review('NARRATIVE_NOT_ASSERTIVE', { ...at, narrative: String(item.narrative), note: '回忆/梦境/引用/转述/未知叙述中的变化不能自动当成当前事实。' }));
    }
  }
  return out;
}

function opsOf(event) {
  if (!Array.isArray(event.ops)) return null;
  try {
    // 存储层回读的 ops 不带 _key：这里统一走 normalizeOp（与落库同一口径）。
    return event.ops.map((op) => (op && op._key ? op : normalizeOp(op)));
  } catch {
    return null;
  }
}

/**
 * 校验一批候选事件相对输入状态是否可确认。
 *
 * @param {object} args
 * @param {string} args.workId
 * @param {string} args.chapterId
 * @param {object} args.revision   story_chapter_revisions 行（必须已落库）
 * @param {Array}  args.events     事件（publicEvent 形状；ops 至少含 cell/type/expected）
 * @param {Map}    args.inputState 章前状态（来自 history.stateBefore）
 * @param {boolean} args.upstreamTrusted 章前是否处于连续可信前缀内
 * @returns {object} 报告（JSON 安全部分 + output_state Map）
 */
export function validateEventSet({ workId = 0, chapterId = 0, revision, events = [], inputState, upstreamTrusted = false } = {}) {
  const conflicts = [];
  const unresolved = [];
  const checked = { events: 0, ops: 0, evidence: 0, evidence_anchored: 0 };
  if (!revision) {
    return {
      ok: false, decision: 'blocked', conflicts: [conflict('REVISION_MISSING')], unresolved: [],
      coverage_complete: false, upstream_trusted: false, checked,
      input_state_hash: '', output_state: null, output_state_hash: '',
    };
  }
  if (!(inputState instanceof Map)) {
    return {
      ok: false, decision: 'blocked', conflicts: [conflict('UPSTREAM_STATE_UNAVAILABLE')], unresolved: [],
      coverage_complete: false, upstream_trusted: false, checked,
      input_state_hash: '', output_state: null, output_state_hash: '',
    };
  }
  const plainText = revisionPlainText(revision);
  const normalizedEvents = [];
  for (const [i, event] of (events || []).entries()) {
    checked.events += 1;
    if (!event || typeof event.id !== 'string' || !event.id) {
      conflicts.push(conflict('EVENT_ID_MISSING', { event_index: i }));
      continue;
    }
    const ops = opsOf(event);
    if (!ops) {
      conflicts.push(conflict('EVENT_OPS_NOT_NORMALIZED', { event_id: event.id }));
      continue;
    }
    const cells = new Set();
    for (const [j, op] of ops.entries()) {
      checked.ops += 1;
      try {
        parseCellKey(op._key);
      } catch (e) {
        conflicts.push(conflict('INVALID_CELL', { event_id: event.id, op_index: j, message: e.message }));
      }
      if (cells.has(op._key)) conflicts.push(conflict('DUPLICATE_CELL_IN_EVENT', { event_id: event.id, op_index: j, cell: op._key }));
      cells.add(op._key);
      if (!op.expected || !['missing', 'value'].includes(op.expected.kind)) {
        conflicts.push(conflict('EXPECTED_MISSING', { event_id: event.id, op_index: j, cell: op._key }));
      }
      if (op.type === 'set' && !Object.prototype.hasOwnProperty.call(op, 'value')) {
        conflicts.push(conflict('SET_VALUE_MISSING', { event_id: event.id, op_index: j, cell: op._key }));
      }
    }
    checked.evidence += Array.isArray(event.evidence) ? event.evidence.length : 0;
    unresolved.push(...checkEvidenceAnchors(event, { revision, plainText }));
    normalizedEvents.push({ id: event.id, ops });
  }
  // 只有结构与证据都逐项核对过，覆盖率才成立；否则 coverageComplete=false → 至少 needs_review。
  const structuralOk = !conflicts.some((c) => ['INVALID_CELL', 'DUPLICATE_CELL_IN_EVENT', 'EXPECTED_MISSING', 'SET_VALUE_MISSING', 'EVENT_ID_MISSING', 'EVENT_OPS_NOT_NORMALIZED'].includes(c.code));
  let outputState = null;
  if (structuralOk) {
    try {
      outputState = reduceBatch(inputState, normalizedEvents);
      checked.preconditions_checked = true;
    } catch (e) {
      if (e && e.code === 'PRECONDITION_FAILED') {
        conflicts.push(conflict('PRECONDITION_FAILED', { event_id: e.eventId || '', cell: e.cell || '', message: e.message }));
      } else {
        conflicts.push(conflict('REDUCER_ERROR', { message: String((e && e.message) || e) }));
      }
    }
  }
  const evidenceAnchored = unresolved.every((u) => !String(u.code || '').startsWith('EVIDENCE_'));
  checked.evidence_anchored = evidenceAnchored ? checked.evidence : 0;
  const coverageComplete = structuralOk
    && conflicts.length === 0
    && !!outputState
    && checked.evidence > 0
    && evidenceAnchored;
  const decision = validationDecision({ upstreamTrusted, coverageComplete, conflicts, unresolved });
  return {
    ok: decision === 'valid',
    decision,
    conflicts,
    unresolved,
    coverage_complete: coverageComplete,
    upstream_trusted: !!upstreamTrusted,
    checked,
    input_state_hash: stateContentHash(inputState),
    output_state: outputState,
    output_state_hash: outputState ? stateContentHash(outputState) : '',
    policy: {
      model_self_report_accepted: false,
      note: 'valid 需要：上游可信 + 前置条件全部成立 + 每个事件都有可核对证据 + 无待复核叙述。',
    },
  };
}

/** 供 API/UI 展示：把决定翻译成一句可审计的中文结论。 */
export function explainDecision(report) {
  const d = report && report.decision;
  if (d === 'valid') return '可确认：上游可信、前置条件成立、证据逐项核对通过。';
  if (d === 'blocked') return '被上游阻塞：章前状态不在连续可信前缀内，确认不会生效。';
  if (d === 'conflict') return `存在硬冲突 ${ (report.conflicts || []).length } 条：必须修正后才能确认。`;
  if (d === 'needs_review') return `需人工复核 ${ (report.unresolved || []).length } 条（证据/叙述类型），不能直接确认。`;
  return '未知结论：不得当作有效。';
}
