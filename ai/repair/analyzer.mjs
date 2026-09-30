/**
 * ai/repair/analyzer.mjs —— T3「全下游失效 + 隐性因果复核」分析器（**只分析，绝不生成正文**）。
 *
 * 产品语义（任务书 §7 / 方案 §17）：
 *   · 覆盖集合保守：根变更之后的所有叙事章节一律进入复核；依赖图只用于解释与排序，
 *     不用于排除（`explicit_hits_only` 仅供变异测试对照，不是产品选项）。
 *   · 复核在新世界线状态下执行：章前状态 = 根章节章后 + 已复核候选的累积（repair 工作线）。
 *   · 正文仍成立 → 保留同一 revision，新增**候选验证绑定**（新验证来源；不改写原生成记录）。
 *   · 不成立 → conflict；不能判断 → needs_review；跨不过冲突 → 后文 blocked（但仍做初筛并如实记录）。
 *   · 本模块没有正文生成路径；传入 writer 也只会被记录调用数（必须为 0）。
 *
 * 本阶段不得自动生成后文修订稿；修订器只能由 T4 的作者按钮授权启动。
 */
import { db } from '../../db.js';
import { canonicalJson, cellKey, parseCellKey, sha16 } from '../story-state/temporal/schema.mjs';
import { assertTemporalSchema, isTemporalEnabled } from '../story-state/temporal/config.mjs';
import { ensureMainCommit, commitManifest, manifestOf, orderOfCommit, getCommit } from '../story-state/temporal/worldline-store.mjs';
import { createBinding, getBinding, eventsOfBinding } from '../story-state/temporal/event-store.mjs';
import { getRevision, latestRevisionOf, revisionPlainText } from '../story-state/temporal/revision-store.mjs';
import { stateAt } from '../story-state/temporal/history.mjs';
import { saveSnapshot } from '../story-state/temporal/snapshot.mjs';
import { validateEventSet } from '../story-state/temporal/validation.mjs';
import { dependenciesOfBinding } from '../story-state/temporal/dependencies.mjs';
import { reduceBatch, stateContentHash } from '../story-state/temporal/reducer.mjs';
import { cursorOfChapter, ensureOrderVersion } from '../story-state/temporal/order.mjs';
import { sanitizeText } from '../story-state/temporal/extraction.mjs';
import * as Runs from './store.mjs';

export const IMPACT_ANALYSIS_VERSION = '1.0.0';
/** 覆盖率策略：all_downstream = 产品语义；explicit_hits_only 仅变异测试对照。 */
export const COVERAGE_MODES = new Set(['all_downstream', 'explicit_hits_only']);
export const IMPACT_LIMITS = Object.freeze({
  max_chapters: 200,
  max_text_chars: 6000,
  max_state_lines: 400,
  max_assumptions: 40,
  max_conflicts: 12,
  max_constraints: 30,
  max_response_chars: 200000,
});

const nowIso = () => new Date().toISOString();

/** 生成来源（只读呈现，绝不改写）：手工旧稿/外部写回没有捕获过输入 → unknown，不伪造。 */
export function generationProvenanceOf(revision) {
  let origin = {};
  try { origin = JSON.parse((revision && revision.origin_json) || '{}'); } catch { origin = {}; }
  const gen = origin && origin.extra && origin.extra.generation && typeof origin.extra.generation === 'object'
    ? origin.extra.generation : null;
  const status = gen && ['recorded', 'reconstructed', 'unknown'].includes(String(gen.kind)) ? String(gen.kind) : 'unknown';
  if (status !== 'unknown') {
    return {
      status,
      origin_kind: String(origin.kind || 'save'),
      source: sanitizeText(String(gen.source || ''), 120),
      provider: sanitizeText(String(gen.provider || ''), 60),
      model: sanitizeText(String(gen.model || ''), 120),
      context_version: sanitizeText(String(gen.context_version || ''), 60),
      context_hash: sanitizeText(String(gen.context_hash || ''), 80),
      read_set: Array.isArray(gen.read_set) ? gen.read_set.slice(0, 50).map((x) => sanitizeText(String(x), 80)) : [],
      retrieved: Array.isArray(gen.retrieved) ? gen.retrieved.slice(0, 50).map((x) => sanitizeText(String(x), 120)) : [],
      contract: gen.contract && typeof gen.contract === 'object' ? gen.contract : null,
      at: sanitizeText(String(gen.at || ''), 40),
    };
  }
  return {
    status: 'unknown',
    origin_kind: String(origin.kind || 'save'),
    source: sanitizeText(String(origin.source || ''), 120),
    actor: sanitizeText(String(origin.actor || ''), 60),
    note: status === 'unknown'
      ? '当初给模型的输入不可知（手工旧稿 / 外部写回 / 未捕获）：按 unknown 处理，不伪造成 reconstructed。'
      : '生成来源未记录。',
  };
}

/** 根章节已确认事件 → 变化清单（cell 资源键、旧值→新值、原始 op 类型）。 */
export function changesOfBinding(binding) {
  const out = [];
  for (const event of binding ? eventsOfBinding(binding) : []) {
    for (const op of event.ops || []) {
      let key = op._key;
      if (!key) { try { key = cellKey(op.cell); } catch { continue; } }
      const from = op.expected && op.expected.kind === 'value' ? op.expected.value : 'missing';
      const to = op.type === 'unset' ? 'unset' : op.value;
      out.push({
        resource_key: String(key), cell: op.cell || null, op_type: String(op.type || ''),
        from, to,
        event_id: String(event.id || ''), chapter_id: Number(event.chapter_id) || 0,
        narrative: (Array.isArray(event.evidence) && event.evidence[0] ? String(event.evidence[0].narrative || 'unknown') : 'unknown'),
      });
    }
  }
  const seen = new Set();
  const dedup = [];
  for (const row of out) {
    const k = `${row.resource_key}|${JSON.stringify(row.to)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(row);
  }
  return dedup;
}

/** 变化涉及的命名实体（角色/地点/物品/势力；关系两端拆开）——显式出场检测用。 */
export function changedEntityNames(changes = []) {
  const names = new Set();
  for (const row of changes || []) {
    const cell = row && row.cell;
    if (!cell) continue;
    const id = String(cell.entityId || '');
    if (!id) continue;
    if (String(cell.domain) === 'relation') {
      for (const piece of id.split('|')) if (piece.trim()) names.add(piece.trim());
    } else if (['character', 'location', 'item', 'faction', 'plotline'].includes(String(cell.domain))) {
      names.add(id.trim());
    }
  }
  return [...names];
}

/** 作品写作红线（启用项）→ 复核输入里的作者约束（只读、截断）。 */
function authorConstraintsOf(workId) {
  try {
    const rows = db.prepare(`SELECT kind, pattern, note FROM writing_redlines WHERE work_id = ? AND enabled = 1 ORDER BY id ASC LIMIT ?`)
      .all(Number(workId) || 0, IMPACT_LIMITS.max_constraints);
    return (rows || []).map((r) => ({ kind: String(r.kind || ''), pattern: sanitizeText(String(r.pattern || ''), 200), note: sanitizeText(String(r.note || ''), 120) }));
  } catch {
    return [];
  }
}

function chapterTitleOf(chapterId) {
  try {
    const row = db.prepare('SELECT title, parent_id FROM chapters WHERE id = ?').get(Number(chapterId) || 0);
    return row ? { title: String(row.title || ''), parent_id: row.parent_id === undefined ? null : row.parent_id } : { title: '', parent_id: null };
  } catch {
    return { title: '', parent_id: null };
  }
}

export function impactAnalysisSystemPrompt() {
  return [
    '你是长篇小说的连续性因果复核器：只判断「在新世界线下这一章是否仍然成立」，不写新正文、不改正文。',
    '规则：',
    '1) 出现角色姓名不等于现行出场：回忆、梦境、引用、转述、误信要按证据判断叙述类型，不得仅凭姓名报告「复活」。',
    '2) 没有出现姓名也可能依赖旧前提：接应约定、资源来源、承诺、人物动机、行动原因、角色知识、因果结果。',
    '3) 只依据给出的「章前最新状态（截至本章）」和本章正文；不得引用未来章节才成立的事实。',
    '4) 证据不足、时间或动机无法判断 → needs_review，不要猜，不要给虚假的「通过」。',
    '严格输出 JSON：{"decision":"valid|conflict|needs_review","conflicts":[{"kind":"explicit|implicit_causal","premise":"...","quote":"正文原句","detail":"..."}],"checked":[{"assumption":"...","verdict":"holds|fails|unknown","quote":"..."}],"notes":"..."}',
  ].join('\n');
}

/** 组装隐性因果复核输入：新基线（变化清单）+ 章前状态 + 行动前提 + 原文 + 作者约束。 */
export function buildRevalidationInput({
  workId, runId = '', chapterId, chapterTitle = '', revision, plainText = '',
  binding = null, prefixView = null, changes = [], deps = [], explicitHits = [], appearanceNames = [],
  constraints = [], model = '',
} = {}) {
  const prettyCell = (key) => {
    try {
      const c = parseCellKey(String(key));
      return `${c.domain}|${c.entityId}|${c.predicate}`;
    } catch { return String(key); }
  };
  const stateLines = [];
  if (prefixView && prefixView.state instanceof Map) {
    for (const [key, value] of prefixView.state.entries()) {
      stateLines.push(`${prettyCell(key)} = ${canonicalJson(value)}`);
      if (stateLines.length >= IMPACT_LIMITS.max_state_lines) break;
    }
  }
  const changeLines = (changes || []).map((c) => `${prettyCell(c.resource_key)}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}${c.narrative && c.narrative !== 'present' ? `（叙述类型 ${c.narrative}）` : ''}`);
  const assumptions = (binding && binding.validation && binding.validation.assumptions) || [];
  const assumptionLines = assumptions.slice(0, IMPACT_LIMITS.max_assumptions)
    .map((a, i) => `${i + 1}. [${a.kind || 'reason'}] ${a.statement || ''}${a.quote ? `（正文原句：${a.quote}）` : ''}`);
  const depLines = (deps || []).slice(0, 40).map((d) => `${prettyCell(d.resource_key)}（${d.kind || 'unknown'}）`);
  const provenance = generationProvenanceOf(revision);
  const constraintLines = (constraints || []).slice(0, IMPACT_LIMITS.max_constraints).map((c) => `${c.kind || 'rule'}：${c.pattern || ''}`);
  const user = [
    `作品 #${workId}，复核至第 ${chapterId} 章《${chapterTitle || ''}》${model ? `（模型 ${model}）` : ''}。`,
    '',
    '【世界线变化（已确认的新事实，来自根章节）】',
    changeLines.length ? changeLines.join('\n') : '（无显式变化记录）',
    '',
    '【章前最新状态（截至本章，权威来源；不得使用未来章节事实）】',
    stateLines.length ? stateLines.join('\n') : '（空）',
    '',
    '【本章既有行动前提 / 依赖（保存时抽取；可能不完整，请自行核对正文）】',
    assumptionLines.length ? assumptionLines.join('\n') : '（未记录前提清单）',
    `依赖索引：${depLines.length ? depLines.join('，') : '（空）'}`,
    `生成来源：${provenance.status}${provenance.status === 'unknown' ? '（手工旧稿 / 外部写回：当初输入不可知）' : ''}`,
    explicitHits.length ? `显式依赖命中：${explicitHits.map((h) => prettyCell(h.resource_key)).join('，')}` : '显式依赖命中：（无；仍必须检查隐性因果）',
    appearanceNames.length ? `正文姓名命中（仍需按叙述类型判断）：${appearanceNames.join('、')}` : '正文姓名命中：（无姓名；仍必须检查行动前提与动机）',
    constraintLines.length ? `作者约束：${constraintLines.join('；')}` : '',
    binding && binding.story_time_json && binding.story_time_json !== 'null' ? `本章故事时间：${sanitizeText(binding.story_time_json, 200)}` : '',
    '',
    '【本章正文（原文，未改动）】',
    sanitizeText(plainText, IMPACT_LIMITS.max_text_chars),
    '',
    '请输出 JSON。',
  ].filter((x) => x !== '').join('\n');
  return {
    system: impactAnalysisSystemPrompt(),
    user,
    meta: {
      work_id: Number(workId) || 0, run_id: String(runId || ''), chapter_id: Number(chapterId) || 0,
      binding_id: binding ? binding.id : null, revision_id: revision ? revision.id : null,
    },
    input_hash: sha16(canonicalJson({
      revision: revision ? revision.id : '', changes: (changes || []).map((c) => [c.resource_key, c.to]),
      state: prefixView && prefixView.state instanceof Map ? prefixView.state_content_hash : '',
      assumptions: assumptions.map((a) => a.statement), title: chapterTitle || '', run: String(runId || ''),
    })),
  };
}

/** 解析复核结论（严格 JSON；conflict 必须带证据，否则视为输出非法 → needs_review）。 */
export function parseImpactVerdict(raw) {
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw === 'object') text = String(raw.text || raw.content || '');
  text = text.slice(0, IMPACT_LIMITS.max_response_chars);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let data = null;
  try { data = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text); } catch { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, issues: [{ code: 'PROVIDER_OUTPUT_INVALID', message: '模型输出不是合法 JSON 对象' }] };
  }
  const decision = ['valid', 'conflict', 'needs_review'].includes(String(data.decision)) ? String(data.decision) : null;
  if (!decision) return { ok: false, issues: [{ code: 'PROVIDER_OUTPUT_INVALID', message: 'decision 必须是 valid/conflict/needs_review' }] };
  const conflicts = (Array.isArray(data.conflicts) ? data.conflicts : []).slice(0, IMPACT_LIMITS.max_conflicts).map((c) => ({
    kind: String((c && c.kind) || 'implicit_causal') === 'explicit' ? 'explicit' : 'implicit_causal',
    premise: sanitizeText(String((c && c.premise) || ''), 200),
    quote: sanitizeText(String((c && c.quote) || ''), 200),
    detail: sanitizeText(String((c && c.detail) || ''), 400),
  })).filter((c) => c.premise || c.detail || c.quote);
  const checked = (Array.isArray(data.checked) ? data.checked : []).slice(0, IMPACT_LIMITS.max_assumptions).map((c) => ({
    assumption: sanitizeText(String((c && c.assumption) || ''), 200),
    verdict: ['holds', 'fails', 'unknown'].includes(String(c && c.verdict)) ? String(c && c.verdict) : 'unknown',
    quote: sanitizeText(String((c && c.quote) || ''), 200),
  })).filter((c) => c.assumption);
  if (decision === 'conflict' && !conflicts.length) {
    return { ok: false, issues: [{ code: 'PROVIDER_OUTPUT_INVALID', message: 'decision=conflict 但没有给出冲突证据' }] };
  }
  return { ok: true, decision, conflicts, checked, notes: sanitizeText(String(data.notes || ''), 400) };
}

/**
 * 下游覆盖集合。产品模式 all_downstream = 根章之后的全部章节（保守，不因没有显式命中而跳过）。
 * explicit_hits_only 只作为变异测试对照：把"没有显式依赖命中就跳过"的破坏性改动变成可断言事实。
 */
export function downstreamCoverage({ workId, rootChapterId, commitId = null, coverage = 'all_downstream', changedResources = [], maxChapters = IMPACT_LIMITS.max_chapters } = {}) {
  const w = Number(workId) || 0;
  const root = Number(rootChapterId) || 0;
  if (!COVERAGE_MODES.has(String(coverage))) return { ok: false, reason: `未知覆盖策略 ${coverage}`, chapters: [], all: [] };
  const commit = commitId ? getCommit(String(commitId)) : ensureMainCommit(w);
  if (!commit) return { ok: false, reason: '没有提交', chapters: [], all: [] };
  const manifestChapters = manifestOf(commit).chapters;
  const order = orderOfCommit(commit);
  const chapters = Array.isArray(order.chapters) ? order.chapters.map(Number) : [];
  let index = chapters.indexOf(root);
  if (index < 0) {
    const row = chapterTitleOf(root);
    if (row && row.parent_id !== null && row.parent_id !== undefined) index = chapters.indexOf(Number(row.parent_id));
  }
  if (index < 0) return { ok: false, reason: '根章节不在章序版本中（先建立章序/绑定）', chapters: [], all: [] };
  const resourceSet = new Set((changedResources || []).map(String));
  const all = [];
  for (const chapterId of chapters.slice(index + 1)) {
    const bindingId = manifestChapters[String(chapterId)] || null;
    const deps = bindingId ? dependenciesOfBinding(bindingId) : [];
    const hits = deps.filter((d) => resourceSet.has(String(d.resource_key)));
    all.push({ chapter_id: chapterId, binding_id: bindingId, explicit_hits: hits.map((h) => h.resource_key), has_explicit_hit: hits.length > 0 });
  }
  const selected = String(coverage) === 'explicit_hits_only' ? all.filter((r) => r.has_explicit_hit) : all;
  return {
    ok: true, commit_id: commit.id, order_version_id: String(order.order_version_id || ''),
    coverage: String(coverage), all,
    chapters: selected.slice(0, Math.max(1, Number(maxChapters) || IMPACT_LIMITS.max_chapters)).map((r) => r.chapter_id),
    skipped: all.length - selected.length,
    policy: String(coverage) === 'all_downstream'
      ? '保守：根章之后的全部章节一律进入复核；依赖图只用于解释与排序，不用于排除。'
      : '变异对照：只复核有显式依赖命中的章节（不是产品语义，只用于证明保守传播是必须的）。',
  };
}

/** 复核运行的工作世界线（kind=repair；候选只存在于这里，main 不被分析改写）。 */
export function ensureWorkingWorldline({ workId, runId, baseCommitId }) {
  const w = Number(workId) || 0;
  const id = 'wl_an_' + sha16(`${w}|${String(runId)}`).slice(0, 16);
  const existing = db.prepare('SELECT * FROM story_worldlines WHERE id = ?').get(id);
  if (existing) return existing;
  const ts = nowIso();
  db.prepare(`INSERT INTO story_worldlines (id, work_id, kind, base_commit_id, head_commit_id, generation, status, label, created_at)
    VALUES (?, ?, 'repair', ?, ?, 0, 'open', ?, ?)`)
    .run(id, w, String(baseCommitId || ''), String(baseCommitId || ''), `analyze:${String(runId)}`, ts);
  return db.prepare('SELECT * FROM story_worldlines WHERE id = ?').get(id);
}

/** 复核结论 → 工作线候选绑定（保留原 revision 与事件集；valid 必须有输出快照）。 */
function writeCandidateBinding({
  workId, runId, chapterId, binding, revision, prefixView, verdict, orderVersionId, cursor, decision,
  deterministic, modelConflicts, assumptions, outputState,
}) {
  const beforeSnap = saveSnapshot({
    workId, chapterId, orderVersionId,
    cursor: { chapter_index: cursor.chapter_index, scene_index: cursor.scene_index, boundary: 'before' },
    state: prefixView.state, commitId: prefixView.commit_id,
  });
  let outputSnapId = null;
  const finalOutput = outputState instanceof Map ? outputState : prefixView.state;
  if (decision === 'valid') {
    const outSnap = saveSnapshot({
      workId, chapterId, orderVersionId, cursor,
      state: finalOutput, commitId: prefixView.commit_id,
      revisionIds: [revision.id], eventHashes: (binding.event_ids || []).map(String),
    });
    outputSnapId = outSnap.id;
  }
  const validation = {
    decision,
    // 再次验证创建**新的验证来源**；原生成记录（revision.origin_json / 原 binding）保持不可变。
    revalidation: {
      source: 'impact_analysis',
      version: IMPACT_ANALYSIS_VERSION,
      run_id: String(runId),
      at: nowIso(),
      base_binding_id: binding.id,
      base_revision_id: String(binding.revision_id),
      input: {
        commit_id: prefixView.commit_id,
        state_content_hash: prefixView.state_content_hash || '',
        order_version_id: String(orderVersionId || ''),
        upstream_trusted: !!prefixView.trusted,
      },
      output_state_content_hash: decision === 'valid' && finalOutput instanceof Map ? stateContentHash(finalOutput) : '',
      checked: verdict ? verdict.checked : [],
      model_conflicts: modelConflicts || [],
      deterministic_conflicts: deterministic ? (deterministic.conflicts || []) : [],
      deterministic_unresolved: deterministic ? (deterministic.unresolved || []) : [],
      note: decision === 'valid'
        ? '复核通过：正文未改，保留原生成来源，仅新增验证来源（T3 不生成修订稿）。'
        : decision === 'conflict'
          ? '复核判定：现有正文在新世界线下不成立；等待作者点击「重建受影响章节」（T4）。'
          : '复核无法判定：留给作者复核，不自动改写。',
    },
    generation_provenance: generationProvenanceOf(revision),
    assumptions: (assumptions || []).slice(0, 40),
  };
  const candidate = createBinding({
    workId, chapterId, revisionId: binding.revision_id, eventIds: binding.event_ids || [],
    validity: decision, inputSnapshotId: beforeSnap.id, outputSnapshotId: outputSnapId,
    validation,
    appearances: binding.appearances || [],
    contractRef: { ...(binding.contract_ref || {}), kind: 'impact_revalidation', base_binding_id: binding.id, run_id: String(runId) },
  });
  return { candidate, inputSnapshotId: beforeSnap.id, outputSnapshotId: outputSnapId };
}

/** 单章复核：确定性前置条件检查 + 注入式模型因果判定 → 工作线候选。 */
async function revalidateChapter(ctx) {
  const {
    workId, run, worklineId, workingHeadId, baseManifest, chapterId,
    changes, changedResources, changedNames, generate, model, constraints, counters, orderVersionId,
  } = ctx;
  const title = chapterTitleOf(chapterId);
  const bindingId = baseManifest[String(chapterId)] || null;
  const binding = bindingId ? getBinding(bindingId) : null;
  const revision = binding ? getRevision(binding.revision_id) : null;
  const base = {
    chapter_id: Number(chapterId), chapter_title: title.title, binding_id: bindingId,
    revision_id: revision ? revision.id : null, chapter_index: counters.index,
  };
  if (!revision) {
    const step = Runs.addStep({
      runId: run.id, workId, chapterId, stepKey: 'revalidate', status: 'blocked',
      result: { ...base, status: 'blocked', reason: 'no_revision', note: '该章还没有正文修订：先保存正文' },
    });
    counters.blocked += 1;
    return { entry: { ...base, status: 'blocked', reason: 'no_revision' }, workingHeadId, prefixBroken: true, stepId: step.id };
  }
  const plainText = revisionPlainText(revision);
  // ── 章前状态：工作线（根章后 + 已复核候选的累积）──
  let prefixView = null;
  let prefixError = '';
  try {
    const view = stateAt({ workId, chapterId, boundary: 'before', commitId: workingHeadId });
    if (view && view.state instanceof Map) {
      prefixView = {
        commit_id: workingHeadId, state: view.state,
        state_content_hash: view.state_content_hash || '', trusted: !!view.trusted,
        stop: view.stop || null, rows: Array.isArray(view.chapters) ? view.chapters : [],
      };
    } else if (view && view.ok === false) {
      prefixError = sanitizeText(String(view.reason || '章前状态不可用'), 200);
    }
  } catch (e) {
    prefixError = sanitizeText(String((e && e.message) || e), 200);
  }
  const inputFingerprint = sha16(canonicalJson({
    run: run.id, chapter: chapterId, binding: bindingId, revision: revision.id,
    input_commit: workingHeadId, coverage: 'revalidate',
  }));
  const step = Runs.addStep({
    runId: run.id, workId, chapterId, stepKey: 'revalidate', inputFingerprint, status: 'validating',
    result: { ...base, status: 'validating' },
  });
  // ── 显式信号（只解释，不排除）──
  const deps = bindingId ? dependenciesOfBinding(bindingId) : [];
  const explicitHits = deps.filter((d) => changedResources.has(String(d.resource_key)));
  const appearanceNames = changedNames.filter((name) => plainText.includes(name));
  // ── 确定性检查：既有事件集在新章前状态下是否仍可归约 ──
  let det = null;
  let detError = '';
  let events = [];
  try {
    events = binding && (binding.event_ids || []).length ? eventsOfBinding(binding) : [];
    if (events.length && prefixView && prefixView.trusted) {
      det = validateEventSet({ workId, chapterId, revision, events, inputState: prefixView.state, upstreamTrusted: true });
    }
  } catch (e) {
    detError = sanitizeText(String((e && e.message) || e), 200);
  }
  const prefixBroken = !prefixView || !prefixView.trusted;
  const blockedByPrefix = ctx.prefixBroken || prefixBroken || !!prefixError;
  // ── 模型复核（注入式；本模块不生成正文）──
  let verdict = null;
  const providerIssues = [];
  if (typeof generate === 'function') {
    const prompt = buildRevalidationInput({
      workId, runId: run.id, chapterId, chapterTitle: title.title, revision, plainText, binding, prefixView,
      changes, deps, explicitHits, appearanceNames, constraints, model,
    });
    counters.model_calls += 1;
    try {
      const raw = await generate({
        system: prompt.system, user: prompt.user, model,
        work_id: workId, chapter_id: chapterId, binding_id: bindingId, revision_id: revision.id,
        run_id: run.id, purpose: 'impact_analysis',
      });
      verdict = parseImpactVerdict(raw);
    } catch (e) {
      verdict = { ok: false, issues: [{ code: 'PROVIDER_CALL_FAILED', message: sanitizeText(String((e && e.message) || e), 200) }] };
    }
    if (verdict && verdict.ok === false) providerIssues.push(...(verdict.issues || []));
  } else {
    providerIssues.push({ code: 'NO_MODEL_ADAPTER', message: '没有可用的模型适配器：本章只做了确定性检查（如实标 needs_review，不冒充通过）' });
  }
  const detConflicts = det ? (det.conflicts || []) : [];
  const modelConflicts = verdict && verdict.ok ? verdict.conflicts : [];
  const modelDecision = verdict && verdict.ok ? verdict.decision : null;
  let decision;
  if (blockedByPrefix) decision = 'blocked';
  else if (detConflicts.length || modelDecision === 'conflict') decision = 'conflict';
  else if (detError || (det && det.decision !== 'valid') || !(verdict && verdict.ok && modelDecision === 'valid')) decision = 'needs_review';
  else decision = 'valid';
  const assumptions = (binding && binding.validation && binding.validation.assumptions) || [];
  const entryBase = {
    ...base, status: decision,
    input: {
      commit_id: workingHeadId,
      state_content_hash: prefixView ? prefixView.state_content_hash : '',
      trusted: !!(prefixView && prefixView.trusted),
      stop: prefixView ? prefixView.stop : null,
      source_bindings: prefixView ? prefixView.rows.map((r) => ({ chapter_id: Number(r.chapter_id), binding_id: String(r.binding_id) })) : [],
    },
    explicit_dependencies: explicitHits.map((h) => ({ resource_key: h.resource_key, kind: h.kind })),
    explicit_appearances: appearanceNames,
    implicit_causal: modelConflicts.filter((c) => c.kind === 'implicit_causal'),
    explicit_conflicts: modelConflicts.filter((c) => c.kind === 'explicit'),
    assumptions_checked: verdict && verdict.ok ? verdict.checked : [],
    deterministic: det ? { decision: det.decision, conflicts: det.conflicts, unresolved: det.unresolved } : (detError ? { error: detError } : null),
    generation_provenance: generationProvenanceOf(revision),
    provider_issues: providerIssues,
    model_decision: modelDecision,
    notes: verdict && verdict.ok ? verdict.notes : '',
  };
  if (decision === 'blocked') {
    counters.blocked += 1;
    // 被上游阻塞同样必须如实报告「本章正文没有被改写」——面板/报告依赖该字段区分
    // 「已保留原文」与「尚未复核」；此处不生成任何修订稿。
    const updated = Runs.updateStep(step.id, { status: 'blocked', result: {
      ...entryBase, status: 'blocked',
      kept_revision_id: null, candidate_binding_id: null, candidate_commit_id: null,
      revision_unchanged: String((latestRevisionOf(chapterId) || {}).id || '') === String(revision.id),
      reason: prefixError || (ctx.prefixBroken ? 'upstream_conflict' : 'upstream_untrusted'),
    } });
    return { entry: updated.result, workingHeadId, prefixBroken: true, stepId: step.id };
  }
  const cursor = cursorOfChapter(workId, chapterId);
  const { candidate } = writeCandidateBinding({
    workId, runId: run.id, chapterId, binding, revision, prefixView: prefixView || { state: new Map(), state_content_hash: '', commit_id: workingHeadId, trusted: false },
    verdict: verdict && verdict.ok ? verdict : null,
    orderVersionId, cursor, decision, deterministic: det,
    modelConflicts, assumptions,
    outputState: decision === 'valid' && det ? det.output_state : null,
  });
  const committed = commitManifest({
    workId, worldlineId: worklineId, parentCommitId: workingHeadId, orderVersionId,
    chapters: { [String(chapterId)]: candidate.id },
    note: `impact_${decision}:${run.id}:${chapterId}`,
    expectedHead: workingHeadId,
  });
  const statusMap = { valid: 'kept', conflict: 'conflict', needs_review: 'needs_review' };
  const status = statusMap[decision] || 'needs_review';
  if (decision === 'valid') counters.kept += 1;
  else if (decision === 'conflict') counters.conflict += 1;
  else counters.needs_review += 1;
  const entry = {
    ...entryBase, status,
    kept_revision_id: decision === 'valid' ? revision.id : null,
    candidate_binding_id: candidate.id,
    candidate_commit_id: committed.commit.id,
    revision_unchanged: String((latestRevisionOf(chapterId) || {}).id || '') === String(revision.id),
    review: decision === 'conflict'
      ? { conflicts: [...detConflicts, ...modelConflicts] }
      : (decision === 'needs_review' ? { unresolved: det ? det.unresolved : [], provider_issues: providerIssues } : { checked: verdict && verdict.ok ? verdict.checked : [] }),
  };
  Runs.updateStep(step.id, { status, candidateRevisionId: decision === 'valid' ? revision.id : null, candidateBindingId: candidate.id, result: entry });
  return { entry, workingHeadId: committed.commit.id, prefixBroken: decision !== 'valid', stepId: step.id };
}

/**
 * 运行一次全下游复核（只分析）。
 *
 * @param {object} args
 * @param {number} args.workId
 * @param {number} args.rootChapterId 根章节（正文或事实刚变化的那一章）
 * @param {Function|null} args.generate 注入式模型适配器（生产 = server 的 callAI 通道；测试 = 确定性 fake）
 * @param {object|null} args.writer 哨兵：本模块没有正文生成路径，传入只会被如实记录调用数（必须为 0）
 * @returns {Promise<object>} JSON 安全回执
 */
export async function runImpactAnalysis({
  workId, rootChapterId, generate = null, provider = 'none', model = '',
  coverage = 'all_downstream', maxChapters = IMPACT_LIMITS.max_chapters,
  owner = 'impact-analyzer', idempotencyKey = '', refresh = false, writer = null,
} = {}) {
  const w = Number(workId) || 0;
  const root = Number(rootChapterId) || 0;
  if (!w || !root) throw new Error('runImpactAnalysis: 缺少 workId / rootChapterId');
  const schema = assertTemporalSchema();
  if (!schema.ok) return { ok: false, enabled: false, work_id: w, root_chapter_id: root, reason: `TEMPORAL_SCHEMA_MISSING:${(schema.missing || []).join(',')}` };
  if (!isTemporalEnabled(w)) return { ok: false, enabled: false, work_id: w, root_chapter_id: root, reason: '该作品未开启时态故事状态引擎（零写入）' };
  const head = ensureMainCommit(w);
  const baseManifest = manifestOf(head).chapters;
  const rootBindingId = baseManifest[String(root)] || null;
  const rootBinding = rootBindingId ? getBinding(rootBindingId) : null;
  const rootRevision = latestRevisionOf(root);
  const rootConfirmed = !!(rootBinding && rootBinding.validity === 'valid' && rootRevision && String(rootBinding.revision_id) === String(rootRevision.id));
  const changes = rootConfirmed ? changesOfBinding(rootBinding) : [];
  const changedResources = new Set(changes.map((c) => c.resource_key));
  const changedNames = changedEntityNames(changes);
  const cov = downstreamCoverage({ workId: w, rootChapterId: root, commitId: head.id, coverage, changedResources: [...changedResources], maxChapters });
  if (!cov.ok) return { ok: false, enabled: true, work_id: w, root_chapter_id: root, reason: cov.reason };
  const orderVersionId = cov.order_version_id || ensureOrderVersion(w).id;
  const keyBase = `analyze|${w}|${root}|${rootBindingId || 'none'}|${head.id}|${cov.coverage}|${cov.chapters.length}${rootConfirmed ? '' : '|tentative'}`;
  // refresh=true 是作者显式要求重算：不复用旧运行（但仍然幂等于同一毫秒内的重复请求键）。
  const key = String(idempotencyKey || (refresh ? `${keyBase}|refresh:${Date.now()}` : keyBase));
  const reusable = Runs.findReusableRun(w, key);
  if (reusable && !refresh) return { ok: true, enabled: true, reused: true, tentative: !!reusable.result.tentative, run: reusable, report: reusable.result };
  const created = Runs.createRun({
    workId: w, mode: 'analyze', rootChapterId: root, baseCommitId: head.id,
    baseline: {
      version: IMPACT_ANALYSIS_VERSION, root_binding_id: rootBindingId,
      root_revision_id: rootRevision ? rootRevision.id : null, head_commit_id: head.id,
      confirmed_root: rootConfirmed, changes, changed_resources: [...changedResources],
    },
    policy: { coverage_mode: cov.coverage, max_chapters: Math.max(1, Number(maxChapters) || IMPACT_LIMITS.max_chapters), no_generation: true },
    coverage: { mode: cov.coverage, chapters: cov.chapters, skipped: cov.skipped, policy: cov.policy, all: cov.all },
    idempotencyKey: key,
  });
  const run = created.run;
  if (created.reused && !refresh) return { ok: true, enabled: true, reused: true, tentative: !!run.result.tentative, run, report: run.result };
  const report = {
    run_id: run.id, mode: 'analyze', version: IMPACT_ANALYSIS_VERSION, at: nowIso(),
    work_id: w, root_chapter_id: root, root_binding_id: rootBindingId,
    root_revision_id: rootRevision ? rootRevision.id : null,
    base_commit_id: head.id, working_worldline_id: null,
    tentative: !rootConfirmed,
    coverage: { mode: cov.coverage, chapters: cov.chapters, skipped: cov.skipped, policy: cov.policy },
    changes,
    downstream: [],
    explicit_appearances: [], explicit_dependencies: [], implicit_dependencies: [],
    needs_review: [], blocked: [],
    totals: { downstream: cov.chapters.length, kept: 0, conflict: 0, needs_review: 0, blocked: 0, skipped_by_coverage: cov.skipped, model_calls: 0, generated_revisions: 0 },
    writer_calls: Number(writer && typeof writer.calls === 'number' ? writer.calls : 0),
    notes: [],
  };
  if (!rootConfirmed) {
    // AC-13：根事实尚未确认 → 影响仅 tentative（不建候选绑定、不推进工作线、不调用模型）。
    for (const chapterId of cov.chapters) {
      Runs.addStep({
        runId: run.id, workId: w, chapterId, stepKey: 'revalidate', status: 'needs_review',
        result: { chapter_id: chapterId, status: 'needs_review', tentative: true, reason: '根章节的最新正文尚未确认：影响仅 tentative，不建立候选绑定。' },
      });
    }
    report.totals.needs_review = cov.chapters.length;
    report.needs_review = [...cov.chapters];
    report.notes.push('根事实尚未确认：本报告只做 tentative 覆盖提示，未调用模型、未写任何候选状态。');
    Runs.updateRun(run.id, { status: 'needs_review', result: report });
    return { ok: true, enabled: true, tentative: true, run: Runs.getRun(run.id), report };
  }
  Runs.updateRun(run.id, { status: 'running' });
  const lease = Runs.acquireLease({ runId: run.id, owner: String(owner || 'impact-analyzer') });
  if (lease.ok !== true) {
    Runs.updateRun(run.id, { status: 'queued' });
    return { ok: false, enabled: true, reason: lease.reason || '运行已被其他执行者持有', run: Runs.getRun(run.id), report };
  }
  const workline = ensureWorkingWorldline({ workId: w, runId: run.id, baseCommitId: head.id });
  Runs.updateRun(run.id, { workingWorldlineId: workline.id });
  report.working_worldline_id = workline.id;
  const counters = { model_calls: 0, kept: 0, conflict: 0, needs_review: 0, blocked: 0, index: 0 };
  const constraints = authorConstraintsOf(w);
  let workingHeadId = head.id;
  let prefixBroken = false;
  let failed = '';
  try {
    for (const chapterId of cov.chapters) {
      const current = Runs.getRun(run.id);
      if (!current || current.status !== 'running') {
        report.notes.push(`运行状态变为 ${current ? current.status : 'missing'}：在章节 #${chapterId} 前停止（断点保留）。`);
        break;
      }
      const out = await revalidateChapter({
        workId: w, run, worklineId: workline.id, workingHeadId, baseManifest, chapterId,
        changes, changedResources, changedNames, generate, model, constraints, counters,
        prefixBroken, orderVersionId,
      });
      counters.index += 1;
      workingHeadId = out.workingHeadId;
      prefixBroken = out.prefixBroken;
      report.downstream.push(out.entry);
    }
  } catch (e) {
    failed = sanitizeText(String((e && e.message) || e), 300);
  } finally {
    Runs.releaseLease(run.id);
  }
  if (failed) {
    report.error = failed;
    Runs.updateRun(run.id, { status: 'failed', result: report });
    return { ok: false, enabled: true, error: failed, run: Runs.getRun(run.id), report };
  }
  for (const entry of report.downstream) {
    if (entry.explicit_appearances && entry.explicit_appearances.length) {
      report.explicit_appearances.push({ chapter_id: entry.chapter_id, names: entry.explicit_appearances });
    }
    if (entry.explicit_dependencies && entry.explicit_dependencies.length) {
      report.explicit_dependencies.push({ chapter_id: entry.chapter_id, resources: entry.explicit_dependencies });
    }
    if (entry.implicit_causal && entry.implicit_causal.length) {
      report.implicit_dependencies.push({ chapter_id: entry.chapter_id, conflicts: entry.implicit_causal });
    }
    if (entry.status === 'needs_review') report.needs_review.push(entry.chapter_id);
    if (entry.status === 'blocked') report.blocked.push(entry.chapter_id);
  }
  report.totals = {
    downstream: cov.chapters.length, kept: counters.kept, conflict: counters.conflict,
    needs_review: counters.needs_review, blocked: counters.blocked,
    skipped_by_coverage: cov.skipped, model_calls: counters.model_calls, generated_revisions: 0,
  };
  report.notes.push('T3 只分析与标记：不生成/不覆盖任何正文；修订器只能由 T4 的作者按钮授权启动。');
  Runs.updateRun(run.id, { status: 'ready', result: report });
  return { ok: true, enabled: true, tentative: false, run: Runs.getRun(run.id), report };
}

/** 列出该作品的分析运行（作者界面/插件查询用；按创建时间倒序）。 */
export function listImpactRuns({ workId, limit = 10 } = {}) {
  return Runs.listRuns(Number(workId) || 0, { mode: 'analyze', limit: Math.max(1, Math.min(Number(limit) || 10, 50)) });
}

/** 读取运行与逐章步骤（作者界面/验收查询用）。 */
export function impactRunView({ workId, runId }) {
  const w = Number(workId) || 0;
  const run = Runs.getRun(String(runId || ''));
  if (!run || (w && Number(run.work_id) !== w)) return { ok: false, reason: '运行不存在或不属于该作品' };
  return { ok: true, run, steps: Runs.listSteps(run.id), report: run.result, coverage: run.coverage, policy: run.policy, baseline: run.baseline };
}
