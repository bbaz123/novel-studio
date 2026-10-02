/**
 * 时态故事状态 · 上下文提供者（T5：时态上下文与工具查询全链路接入）。
 *
 * 职责：把「唯一权威状态来源」（不可变修订 + 已认可事件 + 提交清单 + 章序版本）
 * 变成**同一 cursor 下**的上下文数据：
 *   · cursor = 作品 / 世界线 / 提交 / 章序版本 / 章节 / 章前或章后 / 视角 / POV；
 *   · 每个旧来源（角色当前值、关系、剧情线、事件、伏笔、知识、披露、作者计划、
 *     世界词条、全书记忆、章摘要、语义召回、外部资料）都按同一 cursor 过滤或替换；
 *   · 关闭引擎的作品不经过这里（server.js 里 cursor=null，走原路径，逐字节不变）。
 *
 * 纪律：
 *   ① 只读：本模块不写任何表；
 *   ② 不从旧字段“猜”历史状态——查不到就是未登记（未知 != 已知）；
 *   ③ 候选（pending）不进事实：stateAt 的可信前缀在 pending 处停止；
 *   ④ 没有章节归属的来源（story_memories 全书摘要）不得进入历史事实层；
 *   ⑤ 未启用作品零调用。
 */
import { db } from '../../../db.js';
import { stateAt, resolveCommit } from './history.mjs';
import { orderOfCommit } from './worldline-store.mjs';
import { getTemporalConfig } from './config.mjs';
import { domainViewsOf, relationViewsOf, plotlineViewsOf, characterViewsOf, stateEntries } from './projection.mjs';
import { readContract } from '../store.mjs';
import { renderContractSection } from '../contract.mjs';
import { latestSaveProposalBinding, pendingSaveNewerThan } from './event-store.mjs';
import { getRevision } from './revision-store.mjs';

/** 视角：author（作者/全知，默认）| character（角色 POV，只带该角色知识边界）。 */
export const CONTEXT_PERSPECTIVES = ['author', 'character'];
export function normalizeContextPerspective(raw) {
  return raw === 'character' ? 'character' : 'author';
}
export function normalizePovCharacterId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  return s ? s : null;
}

/** 写作模式 → 章前/章后：写新章用章前；续写（本章已有正文）用已采纳前缀（章后，pending 会被 stateAt 截住）。 */
export function contextBoundaryForMode(mode, hasContent = false) {
  if (mode === 'continuation') return 'after';
  if (mode === 'fragment' && hasContent) return 'after';
  return 'before';
}

function liveOrderIds(workId) {
  const rows = db.prepare('SELECT id FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(Number(workId) || 0);
  return rows.map((r) => Number(r.id));
}

const FACT_DOMAINS = new Set(['location', 'faction', 'item', 'goal', 'promise', 'task', 'world_fact', 'premise']);
const HANDLED_DOMAINS = new Set(['character', 'relation', 'plotline', 'foreshadow', 'knowledge', 'disclosure', 'appearance', 'event',
  'location', 'faction', 'item', 'goal', 'promise', 'task', 'world_fact', 'premise']);

function buildViews(state, orderIndexById) {
  const views = {
    characters: [], relations: [], plotlines: [], foreshadows: [], knowledge: [],
    disclosure: [], author_plan: [], world_facts: [], events: [], appearances: [], other: [],
    known_names: [],
  };
  views.characters = characterViewsOf(state);
  views.relations = relationViewsOf(state);
  views.plotlines = plotlineViewsOf(state);
  views.foreshadows = domainViewsOf(state, 'foreshadow');
  views.knowledge = domainViewsOf(state, 'knowledge');
  views.disclosure = domainViewsOf(state, 'disclosure');
  views.events = domainViewsOf(state, 'event');
  const known = new Set();
  const entries = stateEntries(state);
  for (const { key, cell, value } of entries) {
    const item = { key, domain: cell.domain, entity_id: String(cell.entityId), predicate: cell.predicate, scope: cell.scope, holder_id: cell.holderId == null ? null : String(cell.holderId), value };
    if (cell.scope === 'author_plan') views.author_plan.push(item);
    else if (FACT_DOMAINS.has(cell.domain)) views.world_facts.push(item);
    else if (!HANDLED_DOMAINS.has(cell.domain)) views.other.push(item);
    if (cell.domain === 'appearance') {
      const idx = orderIndexById.get(String(cell.entityId));
      views.appearances.push({ chapter_id: String(cell.entityId), chapter_index: idx === undefined ? null : idx, name: String(value && value.name ? value.name : cell.predicate), value });
      known.add(String(cell.predicate));
      if (value && typeof value === 'object' && value.name) known.add(String(value.name));
    } else if (cell.domain === 'character') known.add(String(cell.entityId));
    else if (cell.domain === 'knowledge' && cell.holderId != null) known.add(String(cell.holderId));
  }
  for (const r of views.relations) { if (r.from) known.add(String(r.from)); if (r.to) known.add(String(r.to)); }
  views.known_names = [...known];
  return views;
}

/** 上下文层 note 里的机器可核对游标标记（测试与界面共用；不写正文）。 */
export function cursorNoteOf(cursor) {
  if (!cursor || !cursor.enabled || cursor.ok === false) return '';
  const id8 = cursor.commitId ? String(cursor.commitId).slice(0, 10) : '(none)';
  const anchor = cursor.chapter_id ? `ch${cursor.chapter_id}` : 'ch*';
  const scope = cursor.trusted ? `trusted=${cursor.lastVisibleIndex}` : `stop=${cursor.stop ? cursor.stop.reason : 'unknown'}`;
  return `temporal:${anchor}:${cursor.boundary}:commit=${id8}:wl=${cursor.worldlineId || 'main'}:persp=${cursor.perspective}${cursor.povCharacterId ? `:pov=${cursor.povCharacterId}` : ''}:${scope}`;
}

/**
 * 解析本次装配的统一 cursor。
 * 返回 ok:true 的 cursor（降级时 views 为空、lastVisibleIndex=-1 → fail-closed，绝不泄漏未来）。
 */
export function resolveContextCursor(input = {}) {
  const workId = Number(input.workId) || 0;
  const cfg = getTemporalConfig(workId);
  if (!workId || !cfg.enabled) return { enabled: false, ok: false, reason: '该作品未开启时态故事状态引擎' };
  try {
    return resolveInner(input);
  } catch (e) {
    return {
      enabled: true, ok: true, degraded: true, reason: `游标解析失败：${(e && e.message) || e}`,
      workId, worldlineId: null, commitId: null, orderVersionId: null,
      chapter_id: Number(input.chapterId) || 0, boundary: 'before',
      perspective: normalizeContextPerspective(input.perspective),
      povCharacterId: normalizePovCharacterId(input.povCharacterId),
      lastVisibleIndex: -1, index: -1, orderIndexById: new Map(), visibleChapterIds: [],
      state: new Map(), stateContentHash: '', validity: 'blocked', trusted: false, verifiedThrough: -1,
      stop: { reason: 'degraded', chapter_id: Number(input.chapterId) || 0, detail: String((e && e.message) || e) },
      views: buildViews(new Map(), new Map()), pendingOnBoundary: false, orderKnown: false,
    };
  }
}

function resolveInner(input) {
  const workId = Number(input.workId) || 0;
  const cfg = getTemporalConfig(workId);
  if (!cfg.enabled) return { enabled: false, ok: false, reason: '该作品未开启时态故事状态引擎' };
  const boundaryOverride = input.boundary === 'before' || input.boundary === 'after' ? input.boundary : null;
  const perspective = normalizeContextPerspective(input.perspective);
  const povCharacterId = normalizePovCharacterId(input.povCharacterId);
  const commitId = input.commitId ? String(input.commitId) : null;
  const worldlineId = input.worldlineId === undefined || input.worldlineId === null || input.worldlineId === '' ? null : Number(input.worldlineId);
  let anchorChapterId = Number(input.chapterId) || 0;
  let boundary = boundaryOverride || contextBoundaryForMode(input.mode, !!input.hasContent);

  let commit = null;
  try { commit = resolveCommit({ workId, commitId, worldlineId }); } catch (e) { throw new Error(`提交/世界线不可用：${e.message}`); }
  let orderIds = commit ? orderOfCommit(commit).chapters.map(Number) : liveOrderIds(workId);
  let orderKnown = true;
  let indexById = new Map(orderIds.map((id, i) => [String(id), i]));
  if (!anchorChapterId) {
    // settings 模式（无具体章节）：取全量当前状态（章后），不构成"未来泄漏"（没有写作位置）。
    anchorChapterId = orderIds.length ? orderIds[orderIds.length - 1] : 0;
    if (!boundaryOverride) boundary = 'after';
  }
  let index = anchorChapterId ? indexById.get(String(anchorChapterId)) : undefined;
  if (index === undefined && anchorChapterId) {
    // 场景章节归到父章节（与 history.stateAt 同口径）。
    const row = db.prepare('SELECT parent_id FROM chapters WHERE id = ?').get(anchorChapterId);
    if (row && row.parent_id !== null && row.parent_id !== undefined) index = indexById.get(String(row.parent_id));
  }
  if (index === undefined) {
    // 章节不在提交章序里（可能是刚插入、还没建立修订）：退回活字表顺序；再不行就如实标记 orderKnown=false。
    orderIds = liveOrderIds(workId);
    indexById = new Map(orderIds.map((id, i) => [String(id), i]));
    index = anchorChapterId ? indexById.get(String(anchorChapterId)) : (orderIds.length ? orderIds.length - 1 : undefined);
    if (index === undefined) orderKnown = false;
  }
  const lastVisibleIndex = orderKnown
    ? (boundary === 'after' ? index : index - 1)
    : -1; // fail-closed：章序无法定位时不放行任何按章归属的数据
  const visibleChapterIds = orderKnown && lastVisibleIndex >= 0 ? orderIds.slice(0, lastVisibleIndex + 1) : [];

  let view = null;
  if (anchorChapterId) {
    view = stateAt({ workId, chapterId: anchorChapterId, boundary, commitId, worldlineId });
  } else {
    view = { ok: true, state: new Map(), validity: 'pending', verified_through: -1, trusted: false, stop: { reason: 'no_chapter', chapter_id: 0, detail: '作品还没有章节' }, applied: 0, chapters: [], commit_id: null, order_version_id: null };
  }
  const state = view && view.state instanceof Map ? view.state : new Map();
  // 「边界处有未确认新正文」的判定：既包括 HEAD 归约在锚点停为 pending，
  // 也包括锚点自身在 HEAD 中先因上游失效停为 stale、但本章确有比可见修订更新的
  // 保存后待确认新稿——两种情况下，语义索引里的本章旧稿都不得回灌（unconfirmed_index）。
  let pendingOnBoundary = !!(view && view.stop && view.stop.reason === 'pending' && Number(view.stop.chapter_id) === Number(anchorChapterId));
  if (!pendingOnBoundary && boundary === 'after' && anchorChapterId) {
    try {
      const visibleRev = view && view.target_revision_id ? getRevision(view.target_revision_id) : null;
      pendingOnBoundary = visibleRev
        ? !!pendingSaveNewerThan(workId, anchorChapterId, visibleRev)
        : !!latestSaveProposalBinding(workId, anchorChapterId);
    } catch { /* 只读探测失败：维持既有结论，不放大拦截范围 */ }
  }
  const cursor = {
    enabled: true, ok: true, degraded: false, reason: '',
    workId,
    worldlineId: commit ? commit.worldline_id : (worldlineId || 'main'),
    commitId: view.commit_id || (commit ? commit.id : null),
    orderVersionId: view.order_version_id || (commit ? commit.order_version_id : null),
    chapter_id: Number(anchorChapterId) || 0,
    boundary,
    perspective,
    povCharacterId,
    index: orderKnown ? index : -1,
    lastVisibleIndex,
    orderKnown,
    orderIndexById: indexById,
    orderIds,
    visibleChapterIds,
    state,
    stateContentHash: view.state_content_hash || '',
    validity: view.validity || 'unknown',
    trusted: !!view.trusted,
    verifiedThrough: Number.isFinite(Number(view.verified_through)) ? Number(view.verified_through) : -1,
    stop: view.stop || null,
    pendingOnBoundary,
    views: buildViews(state, indexById),
  };
  return cursor;
}

/**
 * 按 cursor 过滤「带章节归属」的旧来源行（事件 / 伏笔 / 章节检索结果…）。
 * 归属不明的行在启用游标时**不放行**（没有时间来源的旧账不作为历史事实）。
 */
export function filterRowsByCursor(rows, cursor, { chapterIdOf = (r) => r && r.chapter_id, label = 'row' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!cursor || !cursor.enabled || cursor.ok === false) return { kept: list, dropped: [], hidden: 0 };
  const kept = [];
  const dropped = [];
  for (const row of list) {
    const raw = chapterIdOf(row);
    if (raw === undefined || raw === null || raw === '') {
      dropped.push({ label, reason: 'unattributed', chapter_id: null });
      continue;
    }
    const idx = cursor.orderIndexById.get(String(raw));
    if (idx === undefined) { dropped.push({ label, reason: 'not_in_order', chapter_id: String(raw) }); continue; }
    if (cursor.lastVisibleIndex < 0 || idx > cursor.lastVisibleIndex) {
      dropped.push({ label, reason: 'future_chapter', chapter_id: String(raw), chapter_index: idx });
      continue;
    }
    kept.push(row);
  }
  return { kept, dropped, hidden: dropped.length };
}

/** 角色当前值（状态/存活/所在地/状况）的时态覆盖；未登记的角色不返回条目（未知 != 已知）。 */
export function characterOverlayOf(cursor) {
  const map = new Map();
  if (!cursor || !cursor.views) return map;
  for (const c of cursor.views.characters) {
    map.set(String(c.entity_id), {
      entity_id: String(c.entity_id), alive: c.alive, status: c.status || '',
      location: c.location || '', condition: c.condition || '', predicates: c.predicates || {},
    });
  }
  return map;
}

/** 角色是否"截至本章已登记"（出现在角色状态 / 出场 / 关系 / 知识边界里）。 */
export function knownCharacterNamesOf(cursor) {
  const set = new Set();
  if (!cursor || !cursor.views) return set;
  for (const n of cursor.views.known_names || []) set.add(String(n));
  return set;
}

/**
 * 出场阵容过滤（AC-37）：启用游标时，默认只带「已登记或本章材料明确提及/作者强制」的角色；
 * 未来才登记的名字与状态默认不注入。
 */
export function sceneCastOf(cursor, rows, { forceIds = [], isMentioned = () => false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!cursor || !cursor.enabled || cursor.ok === false) return { kept: list, dropped: [], hidden: 0 };
  const known = knownCharacterNamesOf(cursor);
  const forced = new Set((forceIds || []).map((n) => Number(n)));
  const kept = [];
  const dropped = [];
  for (const c of list) {
    if (forced.has(Number(c.id)) || known.has(String(c.name)) || isMentioned(c)) kept.push(c);
    else dropped.push({ id: Number(c.id), name: String(c.name || ''), reason: 'not_registered_at_cursor' });
  }
  return { kept, dropped, hidden: dropped.length };
}

/** 人物关系：只取「两端都是本次出场角色」的关系（时态 state 的 relation 域）。 */
export function relationsForNames(cursor, names) {
  if (!cursor || !cursor.views) return { rows: [], dropped: 0 };
  const want = new Set((names || []).map((n) => String(n)));
  const rows = [];
  let dropped = 0;
  const seen = new Set();
  for (const r of cursor.views.relations) {
    if (!want.has(String(r.from)) || !want.has(String(r.to))) { dropped += 1; continue; }
    const key = `${r.from}|${r.to}|${r.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ from: String(r.from), to: String(r.to), relation: String(r.label || '关系'), description: r.description === undefined ? '' : String(r.description) });
  }
  return { rows, dropped };
}

/** 剧情线：截至本章的时态状态（state/summary），按标题或 ID 都可查。 */
export function plotlineStatesOf(cursor) {
  const map = new Map();
  if (!cursor || !cursor.views) return map;
  for (const p of cursor.views.plotlines) {
    map.set(String(p.entity_id), { state: p.state || '', summary: p.summary || '', predicates: p.predicates || {} });
  }
  return map;
}

/** 伏笔视图（截至本章未闭合的；state 域里有明确 closed/redeemed 的另计）。 */
export function foreshadowsOf(cursor) {
  if (!cursor || !cursor.views) return [];
  return cursor.views.foreshadows.map((f) => ({
    entity_id: String(f.entity_id), predicate: f.predicate, value: f.value,
    state: String(f.value && typeof f.value === 'object' ? (f.value.state || '') : (typeof f.value === 'string' ? f.value : '')),
  }));
}

function line(text, cap = 400) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/** 渲染 story_state 层正文（启用作品：唯一权威状态来源；未登记就是未登记）。 */
export function buildTemporalStoryStateLayer({ cursor, maxPerSection = 12 } = {}) {
  if (!cursor || !cursor.enabled || !cursor.views) return { text: '', meta: { engine: 'temporal', error: 'cursor_unavailable' }, sourceIds: null };
  const v = cursor.views;
  const sections = [];
  const anchor = cursor.chapter_id ? `第${cursor.index >= 0 ? cursor.index + 1 : '?'}节` : '全作';
  const scope = cursor.trusted
    ? `可信到${cursor.verifiedThrough >= 0 ? `第${cursor.verifiedThrough + 1}节` : '起始'}`
    : `可信前缀停在${cursor.stop && cursor.stop.chapter_id ? `第${(cursor.orderIndexById.get(String(cursor.stop.chapter_id)) ?? -1) + 1}节（${cursor.stop.reason}）` : (cursor.stop ? cursor.stop.reason : '未知')}`;
  const head = `【时态故事状态 · 截至${anchor}${cursor.boundary === 'before' ? '章前' : '章后'}｜${scope}｜提交 ${cursor.commitId ? String(cursor.commitId).slice(0, 12) : '(无)'}】`;
  sections.push(head);
  if (!cursor.trusted) {
    sections.push('⚠ 未确认的章节（pending/stale 等）不进入状态；以下只列可信前缀内已登记的事实，查不到 ≠ 不存在。');
  }
  const push = (title, lines) => {
    const body = lines.filter(Boolean).slice(0, maxPerSection);
    if (body.length) sections.push(`【${title}】\n${body.join('\n')}`);
  };
  push('角色状态', v.characters.map((c) => `- ${c.entity_id}：${line(c.status || `${c.alive === true ? '存活' : c.alive === false ? '已故' : '状态未登记'}`, 120)}`));
  push('人物关系', v.relations.map((r) => `- ${r.from} —${line(r.label || '关系', 40)}→ ${r.to}${r.description ? `（${line(r.description, 120)}）` : ''}`));
  push('剧情线', v.plotlines.map((p) => `- ${p.entity_id}：${line(p.state || '状态未登记', 60)}${p.summary ? `｜${line(p.summary, 160)}` : ''}`));
  push('伏笔', v.foreshadows.map((f) => `- ${f.entity_id}${f.predicate && f.predicate !== 'state' ? `（${f.predicate}）` : ''}：${line(typeof f.value === 'object' ? (f.value && f.value.state) || JSON.stringify(f.value) : f.value, 120)}`));
  push('知识边界', knowledgeLinesOf(cursor));
  push('读者披露', v.disclosure.map((d) => `- ${d.entity_id}：${line(typeof d.value === 'object' ? JSON.stringify(d.value) : d.value, 120)}`));
  push('其它事实（地点/势力/物品/任务/承诺/目标/世界事实）', v.world_facts.map((f) => `- [${f.domain}] ${f.entity_id}${f.predicate && f.predicate !== 'state' ? `（${f.predicate}）` : ''}：${line(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value, 120)}`));
  push('作者计划（未发生，禁止写入正文）', v.author_plan.map((p) => `- [${p.domain}] ${p.entity_id}${p.predicate && p.predicate !== 'state' ? `（${p.predicate}）` : ''}：${line(typeof p.value === 'object' ? JSON.stringify(p.value) : p.value, 120)}`));
  // ── P1-06：本章契约必须回到这一层 ────────────────────────────────────────────
  // 旧实现的坑：时态引擎**整层替换**了 story_state 的渲染（server.js 的 temporal 分支
  // 一旦产出 text，非时态分支的 storyStateLayerOf 就再也不会执行），而「本章契约」
  // 只在 storyStateLayerOf 里渲染（renderContractSection 的**唯一**调用点）。
  // 后果是"越用越少"：作者打开时态引擎后，本章契约与硬约束从提示词里静默消失，
  // 而层标签、PROVENANCE.reason 与两份契约文档仍声称这一层包含契约。
  // 现在把契约块作为与引擎无关的追加项渲染在这里（读契约是只读操作，不违反本模块纪律①）。
  const contractRow = cursor.chapter_id ? readContract(cursor.chapter_id) : null;
  const contractText = contractRow ? renderContractSection(contractRow, { includeStyle: false }) : '';
  if (contractText) {
    sections.push(`【本章契约（本章必须/不得包含）】\n${contractText}`);
  }
  const text = sections.join('\n');
  const counts = {
    characters: v.characters.length, relations: v.relations.length, plotlines: v.plotlines.length,
    foreshadows: v.foreshadows.length, knowledge: v.knowledge.length, disclosure: v.disclosure.length,
    world_facts: v.world_facts.length, author_plan: v.author_plan.length, appearances: v.appearances.length,
  };
  return {
    text,
    sourceIds: null,
    meta: {
      engine: 'temporal', boundary: cursor.boundary, commit_id: cursor.commitId, order_version_id: cursor.orderVersionId,
      worldline_id: cursor.worldlineId, state_content_hash: cursor.stateContentHash, validity: cursor.validity,
      trusted: cursor.trusted, verified_through: cursor.verifiedThrough, stop: cursor.stop,
      perspective: cursor.perspective, pov_character_id: cursor.povCharacterId,
      chapter_index: cursor.index, last_visible_index: cursor.lastVisibleIndex,
      counts, text_chars: text.length,
    },
  };
}

function knowledgeLinesOf(cursor) {
  const v = cursor.views;
  if (!v) return [];
  const pov = cursor.povCharacterId;
  const rows = cursor.perspective === 'character'
    ? v.knowledge.filter((k) => String(k.holder_id) === String(pov))
    : v.knowledge;
  return rows.map((k) => `- ${k.holder_id || '?'} 知道 ${k.entity_id}（${k.predicate}）：${line(typeof k.value === 'object' ? JSON.stringify(k.value) : k.value, 100)}`);
}

/**
 * 语义召回 / 外部资料：按 cursor 的章序过滤（未来章节、本正文尚未确认的旧索引内容不得回灌）。
 * 与 recall-meta.mjs 的宿主再校验同口径，但用**提交/章序版本**的位次而不是活字表位次。
 */
export function filterRecallPayloadForCursor(payload, cursor, { kind = 'recall' } = {}) {
  if (!payload || payload.status !== 'ok' || !Array.isArray(payload.hits) || !payload.hits.length) {
    return { payload, dropped: [], changed: false };
  }
  if (!cursor || !cursor.enabled || cursor.ok === false) return { payload, dropped: [], changed: false };
  const kept = [];
  const dropped = [];
  for (const hit of payload.hits) {
    const meta = hit && hit.source_meta ? hit.source_meta : null;
    const chapterId = meta && meta.chapter_id !== undefined ? meta.chapter_id : null;
    if (chapterId === null || chapterId === undefined) { kept.push(hit); continue; }
    const idx = cursor.orderIndexById.get(String(chapterId));
    if (idx === undefined) { dropped.push({ uri: hit.uri, code: 'not_in_order', reason: '召回的章节不在当前章序版本里（索引残留）' }); continue; }
    if (cursor.lastVisibleIndex < 0 || idx > cursor.lastVisibleIndex) {
      dropped.push({ uri: hit.uri, code: 'future_chapter', reason: `召回命中未来章节（第 ${idx + 1} 节 > 可见到第 ${cursor.lastVisibleIndex + 1} 节）` });
      continue;
    }
    if (cursor.pendingOnBoundary && String(chapterId) === String(cursor.chapter_id)) {
      dropped.push({ uri: hit.uri, code: 'unconfirmed_index', reason: '本章有未确认的新正文：索引可能仍是旧稿，暂不使用' });
      continue;
    }
    kept.push(hit);
  }
  if (!dropped.length) return { payload, dropped, changed: false };
  const text = kept.map((h) => `【${h.label || '记忆条目'}】（相关度 ${Number(h.score) || 0}%）\n${h.text}`).join('\n\n');
  const next = {
    ...payload,
    hits: kept,
    text,
    omitted: [...(Array.isArray(payload.omitted) ? payload.omitted : []), ...dropped.map((d) => ({ uri: d.uri, code: d.code, reason: d.reason }))],
    temporal_filtered: { kind, dropped: dropped.length },
  };
  if (!kept.length) next.status = 'filtered';
  return { payload: next, dropped, changed: true };
}

/** 全书记忆（story_memories）策略：没有章节归属 → 不进历史事实层（可在界面只读查看或重建后使用）。 */
export function memoryLayerPolicyOf(cursor) {
  if (!cursor || !cursor.enabled) return { included: true, reason: '' };
  return {
    included: false,
    reason: '该作品启用时态引擎：没有章节归属的全书摘要不得进入历史事实层（可在界面只读查看，或经存量重建后再使用）',
  };
}

/**
 * 廉价的外部版本片段（进 server.js 上下文缓存的 externalVersionOf）：
 * 只做单行聚合查询；未启用/表缺失时返回空串（不影响未启用作品的缓存行为）。
 */
export function temporalVersionOf(workId) {
  const w = Number(workId) || 0;
  if (!w) return '';
  const cfg = getTemporalConfig(w);
  if (!cfg.enabled) return '';
  try {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM story_commits WHERE work_id = @w) AS commits,
        (SELECT COALESCE(MAX(id), '') FROM story_commits WHERE work_id = @w) AS max_commit,
        (SELECT COUNT(*) FROM story_chapter_bindings WHERE work_id = @w) AS bindings,
        (SELECT COALESCE(MAX(created_at), '') FROM story_chapter_bindings WHERE work_id = @w) AS bindings_at,
        (SELECT COALESCE(SUM(CASE WHEN validity = 'valid' THEN 1 ELSE 0 END), 0) FROM story_chapter_bindings WHERE work_id = @w) AS bindings_valid,
        (SELECT COALESCE(SUM(CASE WHEN validity = 'pending' THEN 1 ELSE 0 END), 0) FROM story_chapter_bindings WHERE work_id = @w) AS bindings_pending,
        (SELECT COUNT(*) FROM story_state_events WHERE work_id = @w) AS events,
        (SELECT COALESCE(MAX(id), '') FROM story_chapter_revisions WHERE work_id = @w) AS revisions,
        (SELECT COUNT(*) FROM story_chapter_revisions WHERE work_id = @w) AS revision_count,
        (SELECT COALESCE(MAX(id), '') FROM story_binding_trust WHERE work_id = @w) AS trust_max,
        (SELECT COUNT(*) FROM story_binding_trust WHERE work_id = @w) AS trust_count,
        (SELECT COALESCE(MAX(id), '') FROM story_chapter_dependencies WHERE work_id = @w) AS dep_max,
        (SELECT COALESCE(MAX(updated_at), '') FROM story_state_config WHERE work_id = @w) AS cfg_at
    `).get({ w });
    return ['t', cfg.auto_analysis ? 1 : 0, cfg.repair ? 1 : 0,
      row.commits, row.max_commit, row.bindings, row.bindings_at, row.bindings_valid, row.bindings_pending, row.events,
      row.revisions, row.revision_count, row.trust_max, row.trust_count, row.dep_max, row.cfg_at].join(':');
  } catch {
    return `t:na:${cfg.auto_analysis ? 1 : 0}:${cfg.repair ? 1 : 0}`;
  }
}
