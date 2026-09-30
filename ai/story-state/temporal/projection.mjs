/**
 * 时态故事状态 · 投影（temporal → 只读兼容视图 + 章节状态面板）。
 *
 * 两个纪律：
 *   ① 投影**只来自可信状态前缀**（history.stateAt 的 state）；被 stale/pending 截断时
 *      如实标出 state_scope，不用旧提交的状态冒充新稿。
 *   ② 旧字段（characters.status 等）只是**兼容展示**，不构成第二写入源；本模块不做任何写库。
 *
 * cell 约定（与 docs/temporal-state-contract.md 一致）：
 *   character   entityId = 角色稳定名/ID；predicate ∈ status/alive/location/condition/...
 *   appearance  entityId = 本章 chapter_id；predicate = 角色名/ID；value = {name, scene_index?, role?}
 *   relation    entityId = "from|to"；predicate = 关系词（师徒/父子…）；value = {from,to,label,description?}
 *   plotline    entityId = 剧情线 ID/标题；predicate ∈ state/summary/progress/...
 *   knowledge   scope=character；holderId = 角色；entityId = 知识 key；predicate = state
 *   disclosure  scope=reader；entityId = 事实 key；predicate ∈ disclosed/withheld
 *   foreshadow  entityId = 伏笔 ID/标题；predicate = state（open/closed/redeemed）
 *   event       实体事件 ID；predicate ∈ summary/status
 *   其余域（location/faction/item/world_fact/goal/promise/task/premise）为通用 key-value。
 */
import { parseCellKey } from './schema.mjs';
import { stateAt } from './history.mjs';
import { getBinding, eventsOfBinding } from './event-store.mjs';
import { getCommit, manifestOf } from './worldline-store.mjs';
/** 展开状态条目（键 → 结构）。 */
export function stateEntries(state) {
  const out = [];
  for (const [key, value] of state.entries()) {
    let cell = null;
    try { cell = parseCellKey(key); } catch { cell = null; }
    if (!cell) continue;
    out.push({ key, cell, value });
  }
  return out;
}
/** 角色视图：把同一角色的多个 predicate 聚成一张卡。 */
export function characterViewsOf(state) {
  const byEntity = new Map();
  for (const { cell, value } of stateEntries(state)) {
    if (cell.domain !== 'character') continue;
    const id = String(cell.entityId);
    if (!byEntity.has(id)) byEntity.set(id, { entity_id: id, predicates: {}, alive: null, status: '', location: '', condition: '' });
    const view = byEntity.get(id);
    view.predicates[cell.predicate] = value;
    if (cell.predicate === 'alive' && typeof value === 'boolean') view.alive = value;
    if (cell.predicate === 'status') view.status = String(value == null ? '' : value);
    if (cell.predicate === 'location') view.location = String(value == null ? '' : value);
    if (cell.predicate === 'condition') view.condition = String(value == null ? '' : value);
  }
  for (const view of byEntity.values()) {
    if (!view.status) {
      const parts = [];
      if (view.alive === true) parts.push('存活');
      if (view.alive === false) parts.push('已故');
      if (view.condition) parts.push(view.condition);
      if (view.location) parts.push(view.location);
      view.status = parts.join(' / ');
    }
  }
  return [...byEntity.values()];
}
/** 关系视图：entityId = "from|to"，predicate = 关系词。 */
export function relationViewsOf(state) {
  const out = [];
  for (const { key, cell, value } of stateEntries(state)) {
    if (cell.domain !== 'relation') continue;
    const [from, to] = String(cell.entityId).split('|');
    const row = { key, from: from || '', to: to || '', label: cell.predicate, value, scope: cell.scope };
    if (value && typeof value === 'object') {
      if (value.from !== undefined) row.from = String(value.from);
      if (value.to !== undefined) row.to = String(value.to);
      if (value.label !== undefined) row.label = String(value.label);
      if (value.description !== undefined) row.description = String(value.description);
    }
    out.push(row);
  }
  return out;
}
/** 指定域的通用视图。 */
export function domainViewsOf(state, domain) {
  return stateEntries(state)
    .filter((e) => e.cell.domain === domain)
    .map(({ key, cell, value }) => ({
      key, entity_id: String(cell.entityId), predicate: cell.predicate, scope: cell.scope,
      holder_id: cell.holderId === null || cell.holderId === undefined ? null : String(cell.holderId), value,
    }));
}
/** 剧情线视图（state/summary/progress 聚合）。 */
export function plotlineViewsOf(state) {
  const byId = new Map();
  for (const row of domainViewsOf(state, 'plotline')) {
    if (!byId.has(row.entity_id)) byId.set(row.entity_id, { entity_id: row.entity_id, state: '', summary: '', predicates: {} });
    const v = byId.get(row.entity_id);
    v.predicates[row.predicate] = row.value;
    if (row.predicate === 'state') v.state = String(row.value == null ? '' : row.value);
    if (row.predicate === 'summary') v.summary = String(row.value == null ? '' : row.value);
  }
  return [...byId.values()];
}
/**
 * 旧字段兼容投影（供后续阶段刷新 characters.status 等；本模块只读）。
 * 只映射有明确约定的 predicate，绝不臆造其它字段。
 */
export function legacyProjection(state) {
  const characters = characterViewsOf(state).map((c) => ({
    entity_id: c.entity_id,
    name: c.entity_id,
    status: c.status,
    alive: c.alive,
    location: c.location,
    condition: c.condition,
    predicates: c.predicates,
  }));
  return {
    characters,
    relations: relationViewsOf(state),
    plotlines: plotlineViewsOf(state),
    facts: domainViewsOf(state, 'world_fact'),
    foreshadows: domainViewsOf(state, 'foreshadow'),
  };
}
/** 从事件列表收集出场（appearance 域 + binding.appearances 双通道，去重）。 */
function appearancesOf(chapterId, events, binding) {
  const out = new Map();
  const add = (name, extra = {}) => {
    const n = String(name || '').trim();
    if (!n) return;
    if (!out.has(n)) out.set(n, { name: n, ...extra });
    else out.set(n, { ...out.get(n), ...extra });
  };
  for (const item of (binding && binding.appearances) || []) {
    if (typeof item === 'string') add(item);
    else if (item && typeof item === 'object') add(item.name || item.entity_id || item.character, item);
  }
  for (const event of events) {
    for (const op of event.ops || []) {
      const cell = op.cell || {};
      if (cell.domain !== 'appearance') continue;
      if (String(cell.entityId) !== String(chapterId)) continue;
      const value = op.type === 'set' ? op.value : null;
      add(cell.predicate, value && typeof value === 'object' ? value : {});
    }
  }
  return [...out.values()];
}
/**
 * 章节状态面板数据（正文下方的「本章状态」读取真实后端时态状态）。
 * @param {object} args
 * @param {number} args.workId
 * @param {number} args.chapterId
 * @param {'before'|'after'} [args.boundary]
 * @param {boolean} [args.includeFull]
 */
export function statePanelData({ workId, chapterId, boundary = 'after', includeFull = false } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  const view = stateAt({ workId: w, chapterId: c, boundary });
  const commit = view.commit_id ? getCommit(view.commit_id) : null;
  const manifest = commit ? manifestOf(commit) : { chapters: {} };
  const bindingId = manifest.chapters[String(c)] || null;
  const binding = bindingId ? getBinding(bindingId) : null;
  const chapterApplied = (view.chapters || []).some((r) => Number(r.chapter_id) === c && r.applied);
  let events = [];
  if (binding && chapterApplied) {
    try { events = eventsOfBinding(binding); } catch { events = []; }
  }
  const characters = characterViewsOf(view.state);
  const relationRows = relationViewsOf(view.state);
  const plotlines = plotlineViewsOf(view.state);
  const appearances = appearancesOf(c, events, binding);
  const appearing = new Set(appearances.map((a) => a.name));
  for (const ch of characters) ch.in_chapter = appearing.has(ch.entity_id);
  const inChapter = new Set([...appearing, ...characters.filter((x) => x.in_chapter).map((x) => x.entity_id)]);
  const relations = relationRows.map((r) => ({ ...r, related_in_chapter: inChapter.has(r.from) || inChapter.has(r.to) }));
  const changedEntities = new Set();
  for (const event of events) for (const op of event.ops || []) changedEntities.add(`${(op.cell || {}).domain}:${(op.cell || {}).entityId}`);
  const plotlineViews = plotlines.map((p) => ({ ...p, touched_in_chapter: changedEntities.has(`plotline:${p.entity_id}`) }));
  const changes = [];
  for (const event of events) {
    for (const op of event.ops || []) {
      changes.push({
        event_id: event.id, type: op.type, domain: (op.cell || {}).domain,
        entity_id: String((op.cell || {}).entityId ?? ''), predicate: (op.cell || {}).predicate,
        scope: (op.cell || {}).scope || 'canon', holder_id: (op.cell || {}).holderId ?? null,
        from: op.expected && op.expected.kind === 'value' ? op.expected.value : null,
        from_missing: !op.expected || op.expected.kind === 'missing',
        to: op.type === 'set' ? op.value : null,
        // 证据锚点来自事件本身（修订 + 段落下标 + 引文）：面板用它做「定位」而不是只显示一句说明。
        evidence: Array.isArray(event.evidence) ? event.evidence : [],
      });
    }
  }
  const chapterEvents = domainViewsOf(view.state, 'event').filter((e) => changedEntities.has(`event:${e.entity_id}`));
  const stateScope = chapterApplied ? (boundary === 'after' ? 'through_chapter' : 'through_previous_chapter')
    : (view.trusted === false || view.stop ? 'through_previous_chapter' : 'through_chapter');
  // 面板必须显示**有效**结论：本章被 pending/stale 截断时不能显示旧绑定的 valid。
  const stoppedHere = !!(view.stop && Number(view.stop.chapter_id) === c);
  return {
    ok: view.ok !== false,
    work_id: w,
    chapter_id: c,
    boundary,
    commit_id: view.commit_id || null,
    worldline_id: view.worldline_id || null,
    order_version_id: view.order_version_id || null,
    binding_id: bindingId,
    binding_validity: stoppedHere ? String(view.stop.reason) : (binding ? binding.validity : 'missing'),
    stored_binding_validity: binding ? binding.validity : null,
    state_scope: stateScope,
    trusted: !!view.trusted,
    verified_through: view.verified_through,
    validity: view.validity,
    stop: view.stop || null,
    state_content_hash: view.state_content_hash,
    chapter_index: (view.chapters || []).findIndex((r) => Number(r.chapter_id) === c),
    appearances,
    characters: characters.filter((x) => x.in_chapter).concat(characters.filter((x) => !x.in_chapter)),
    relations,
    plotlines: plotlineViews,
    events: chapterEvents,
    changes,
    counts: {
      appearances: appearances.length, characters: characters.length, relations: relationRows.length,
      plotlines: plotlineViews.length, events: chapterEvents.length, changes: changes.length,
    },
    full_state: includeFull ? view.state_json : undefined,
    policy: {
      source: 'chapter_state_snapshots?→按提交清单归约（story_commits.manifest）',
      note: '面板只读真实时态状态；不被确认的章节显示 pending/stale，而不是旧提交快照。',
    },
  };
}
