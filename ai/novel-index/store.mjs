/**
 * store.mjs —— Novel Index Layer 的存储与查询（E 模块）。
 *
 * 把「数据会持续增长，但每章只需其中一小部分」的资产，从「全量扫描后截断」改为
 * 「先结构化定位 → 再读取少量记录」。边界（硬约束）：
 *   · 这只是**派生索引**：信息单向来自既有正典表（characters / story_events / world_entries /
 *     plotlines / character_relations / character_knowledge / story_entities / story_timeline_entries），
 *     绝不反向写入正典，也不构成新的事实来源；
 *   · 索引本身不是新的上下文层：候选、keywords、分数默认不进入模型输入，
 *     写给模型的内容仍由 buildNovelContext 的既有层构建（本模块只产出「取哪些 id」）；
 *   · 精确查询（角色位置/状态）走这里的结构化查询，绝不调用语义检索；
 *   · 索引不可用/未建/过期 → 调用方回退原有全量读取方式，不阻断写作；
 *   · 默认关闭（app_settings: novel_index_enabled=0）：关闭时装配路径与基线一致。
 *
 * 维护方式（诚实说明）：本索引按作品**惰性重建**——当 `works.updated_at`
 * 或模块 schema 版本与索引 meta 不一致时，整个作品的索引在下次使用前重建一次。
 * 重建是确定性的、幂等的、可离线跑的；不做逐行触发器（避免把写路径与索引耦合出
 * 隐藏状态）。取版本只读一行 meta + 一行 works，不做全量扫描。
 */
import { db } from '../../db.js';

export const NOVEL_INDEX_SCHEMA_VERSION = 1;

export const NOVEL_INDEX = Object.freeze({
  enabledKey: 'novel_index_enabled',
  characterLimit: 6,
  eventLimit: 8,
  foreshadowLimit: 6,
  worldLimit: 6,
  relationLimit: 8,
  locationLimit: 6,
  threadLimit: 4,
  knowledgeLimit: 8,
});

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const nowIso = () => new Date().toISOString();

// ── 计数（每次查询 +1；与「资料召回次数」严格分开统计） ──────────────────────
let queryCount = 0;
const queryByIndex = {};
export function indexQueryStats() { return { queries: queryCount, by_index: { ...queryByIndex } }; }
export function _resetIndexQueryStats() { queryCount = 0; for (const k of Object.keys(queryByIndex)) delete queryByIndex[k]; }
function countQuery(name) { queryCount += 1; queryByIndex[name] = (queryByIndex[name] || 0) + 1; }

// ── 开关 / 版本 / 指纹 ──────────────────────────────────────────────────────
function settingGet(key, fallback = '') {
  const row = prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? String(row.value) : fallback;
}
function settingSet(key, value) {
  prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function novelIndexEnabled() {
  return settingGet(NOVEL_INDEX.enabledKey, '0') === '1';
}
export function setNovelIndexEnabled(enabled) {
  settingSet(NOVEL_INDEX.enabledKey, enabled ? '1' : '0');
  return novelIndexEnabled();
}

function metaGet(workId, key) {
  const row = prepare('SELECT value FROM novel_index_meta WHERE work_id = ? AND key = ?').get(Number(workId), String(key));
  return row ? String(row.value) : '';
}
function metaSet(workId, key, value) {
  prepare('INSERT INTO novel_index_meta (work_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(work_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(Number(workId), String(key), String(value), nowIso());
}

export function novelIndexVersion(workId) {
  return Math.max(0, parseInt(metaGet(workId, 'version'), 10) || 0);
}
export function novelIndexVersionKey(workId) {
  return `${NOVEL_INDEX_SCHEMA_VERSION}.${novelIndexVersion(workId)}`;
}

/** 惰性保鲜：指纹不一致（作品被写过 / schema 升级 / 从未建过）才重建。 */
export function ensureWorkIndex(workId) {
  const work = prepare('SELECT id, updated_at FROM works WHERE id = ?').get(Number(workId));
  if (!work) return { ok: false, status: 'no_work' };
  const fingerprint = `${NOVEL_INDEX_SCHEMA_VERSION}|${String(work.updated_at || '')}`;
  const stored = metaGet(workId, 'fingerprint');
  if (stored === fingerprint && novelIndexVersion(workId) > 0) return { ok: true, status: 'fresh', version: novelIndexVersion(workId) };
  const out = rebuildWorkIndex(workId);
  return { ok: out.ok, status: 'rebuilt', ...out };
}

// ── 重建 ────────────────────────────────────────────────────────────────────
function splitList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  const s = String(v || '');
  return s ? s.split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean) : [];
}
function payloadOf(row) {
  try { const o = JSON.parse(row.payload || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function extractNameList(payload) {
  const out = [];
  for (const key of ['participants', 'characters', 'character_names', 'names']) {
    if (payload[key] !== undefined) out.push(...splitList(payload[key]));
  }
  if (payload.character_id !== undefined) out.push(String(payload.character_id));
  if (payload.character_ids !== undefined) out.push(...splitList(payload.character_ids));
  return [...new Set(out)];
}
function extractLocation(payload) {
  for (const key of ['location', 'place', 'scene', '地点']) if (payload[key]) return String(payload[key]);
  return '';
}
function extractTime(payload) {
  for (const key of ['time', 'story_time', '时间']) if (payload[key]) return String(payload[key]);
  return '';
}
function extractConsequences(payload) {
  for (const key of ['consequences', 'result', 'outcome', '后果']) {
    if (payload[key] !== undefined) { const l = splitList(payload[key]); if (l.length) return l.join('；'); return String(payload[key]); }
  }
  return '';
}

/**
 * 幂等重建一个作品的索引。返回每类写入行数（供审计/测试）。
 * 重建只在指纹变化后发生（ensureWorkIndex 拦下重复调用）。
 */
export function rebuildWorkIndex(workId) {
  const wid = Number(workId);
  const t0 = Date.now();
  const work = prepare('SELECT * FROM works WHERE id = ?').get(wid);
  if (!work) return { ok: false, status: 'no_work' };
  const ts = nowIso();
  const chapters = prepare('SELECT id, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(wid);
  const posOf = new Map(chapters.map((c) => [Number(c.id), Number(c.position) || 0]));
  const charRows = prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY id ASC').all(wid);
  const relRows = prepare('SELECT * FROM character_relations WHERE work_id = ? ORDER BY id ASC').all(wid);
  const eventRows = prepare('SELECT * FROM story_events WHERE work_id = ? ORDER BY id ASC').all(wid);
  const timelineRows = prepare('SELECT * FROM story_timeline_entries WHERE work_id = ? ORDER BY id ASC').all(wid);
  const worldRows = prepare('SELECT * FROM world_entries WHERE work_id = ? ORDER BY id ASC').all(wid);
  const plotRows = prepare('SELECT * FROM plotlines WHERE work_id = ? ORDER BY position ASC, id ASC').all(wid);
  const plotChars = prepare('SELECT pc.*, c.name AS character_name FROM plotline_characters pc LEFT JOIN characters c ON c.id = pc.character_id WHERE pc.plotline_id IN (SELECT id FROM plotlines WHERE work_id = ?)').all(wid);
  const entityRows = prepare('SELECT * FROM story_entities WHERE work_id = ? ORDER BY id ASC').all(wid);
  const aliasRows = prepare('SELECT * FROM story_entity_aliases WHERE work_id = ? ORDER BY id ASC').all(wid);

  const nameOf = new Map(charRows.map((c) => [Number(c.id), String(c.name || '')]));
  const aliasesOf = new Map(charRows.map((c) => [Number(c.id), splitList(c.aliases)]));
  const eventParticipants = new Map();
  const eventLocation = new Map();
  const eventTime = new Map();
  const timelineByEvent = new Map();
  for (const t of timelineRows) if (t.event_id) timelineByEvent.set(Number(t.event_id), t);
  for (const e of eventRows) {
    const payload = payloadOf(e);
    const names = new Set();
    const rawNames = extractNameList(payload);
    for (const n of rawNames) {
      if (/^\d+$/.test(n)) { const nm = nameOf.get(Number(n)); if (nm) names.add(nm); }
      else names.add(n);
    }
    const summary = String(e.summary || '');
    for (const c of charRows) {
      const nm = String(c.name || '');
      if (nm && summary.includes(nm)) { names.add(nm); continue; }
      for (const a of aliasesOf.get(Number(c.id)) || []) if (a && summary.includes(a)) { names.add(nm); break; }
    }
    eventParticipants.set(Number(e.id), [...names]);
    eventLocation.set(Number(e.id), extractLocation(payload));
    const tl = timelineByEvent.get(Number(e.id));
    eventTime.set(Number(e.id), extractTime(payload) || String(tl?.story_time || tl?.relative_time || ''));
  }

  const relationCount = new Map();
  const relationshipsOf = new Map();
  for (const r of relRows) {
    relationCount.set(Number(r.from_character_id), (relationCount.get(Number(r.from_character_id)) || 0) + 1);
    relationCount.set(Number(r.to_character_id), (relationCount.get(Number(r.to_character_id)) || 0) + 1);
    const from = Number(r.from_character_id); const to = Number(r.to_character_id);
    if (!relationshipsOf.has(from)) relationshipsOf.set(from, []);
    relationshipsOf.get(from).push({ to_id: to, to_name: nameOf.get(to) || null, relation: String(r.relation || '') });
  }
  const participation = new Map();
  for (const e of eventRows) {
    const names = eventParticipants.get(Number(e.id)) || [];
    const pos = e.chapter_id ? (posOf.get(Number(e.chapter_id)) ?? null) : null;
    for (const nm of names) {
      const entry = participation.get(nm) || { count: 0, last: null };
      entry.count += 1;
      if (pos !== null && (entry.last === null || pos > entry.last)) entry.last = pos;
      participation.set(nm, entry);
    }
  }

  const knowledgeByChar = new Map();
  try {
    const krows = prepare(`SELECT k.character_id, f.subject, f.predicate FROM character_knowledge k LEFT JOIN story_facts f ON f.id = k.fact_id WHERE k.work_id = ? ORDER BY k.id ASC`).all(wid);
    for (const k of krows) {
      const cid = Number(k.character_id);
      const topic = [k.subject, k.predicate].filter(Boolean).join(':');
      if (!topic) continue;
      if (!knowledgeByChar.has(cid)) knowledgeByChar.set(cid, []);
      const list = knowledgeByChar.get(cid);
      if (!list.includes(topic) && list.length < 12) list.push(topic);
    }
  } catch { /* 知识表缺失时跳过（旧库） */ }

  db.exec('BEGIN');
  try {
    let characters = 0; let events = 0; let foreshadows = 0; let world = 0; let relations = 0; let locations = 0; let threads = 0;

    for (const c of charRows) {
      const cid = Number(c.id);
      const part = participation.get(String(c.name || '')) || { count: 0, last: null };
      const importance = Math.min(100, 20 + 8 * (relationCount.get(cid) || 0) + 3 * part.count);
      let loc = '';
      for (let i = eventRows.length - 1; i >= 0; i -= 1) {
        const e = eventRows[i];
        const names = eventParticipants.get(Number(e.id)) || [];
        if (!names.includes(String(c.name || ''))) continue;
        loc = eventLocation.get(Number(e.id)) || '';
        if (loc) break;
      }
      prepare(`INSERT INTO novel_index_characters (work_id, character_id, name, aliases, importance, current_location, factions, relationships_json, last_active_chapter, knowledge_topics, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, character_id) DO UPDATE SET name=excluded.name, aliases=excluded.aliases, importance=excluded.importance,
          current_location=excluded.current_location, factions=excluded.factions, relationships_json=excluded.relationships_json,
          last_active_chapter=excluded.last_active_chapter, knowledge_topics=excluded.knowledge_topics, updated_at=excluded.updated_at`)
        .run(wid, cid, String(c.name || ''), String(c.aliases || ''), importance, loc,
          String(c.tags || ''), JSON.stringify(relationshipsOf.get(cid) || []),
          part.last, (knowledgeByChar.get(cid) || []).join(' '), ts);
      characters += 1;
    }

    for (const e of eventRows) {
      const eid = Number(e.id);
      const payload = payloadOf(e);
      const participants = (eventParticipants.get(eid) || []).join('、');
      const causalParent = Number(payload.causal_parent || payload.causes_event_id || 0) || null;
      const status = String(payload.status || (e.kind === 'foreshadow' ? (e.foreshadow_status || 'open') : 'logged'));
      prepare(`INSERT INTO novel_index_events (work_id, event_id, chapter_id, chapter_position, time_text, location, participants, type, causal_parent, consequences, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, event_id) DO UPDATE SET chapter_id=excluded.chapter_id, chapter_position=excluded.chapter_position,
          time_text=excluded.time_text, location=excluded.location, participants=excluded.participants, type=excluded.type,
          causal_parent=excluded.causal_parent, consequences=excluded.consequences, status=excluded.status, updated_at=excluded.updated_at`)
        .run(wid, eid, e.chapter_id || null, e.chapter_id ? (posOf.get(Number(e.chapter_id)) ?? null) : null,
          eventTime.get(eid) || '', eventLocation.get(eid) || '', participants, String(e.kind || 'event'),
          causalParent, extractConsequences(payload), status, ts);
      events += 1;
      if (e.kind === 'foreshadow') {
        const related = new Set([...extractNameList(payload), ...((eventParticipants.get(eid) || []))]);
        const topics = new Set();
        for (const c of charRows) {
          const nm = String(c.name || '');
          if (nm && String(e.summary || '').includes(nm)) topics.add(nm);
          for (const a of aliasesOf.get(Number(c.id)) || []) if (a && String(e.summary || '').includes(a)) topics.add(nm);
        }
        for (const t of splitList(payload.topics || payload.trigger_topics)) topics.add(t);
        prepare(`INSERT INTO novel_index_foreshadows (work_id, event_id, planted_chapter, related_entities, trigger_topics, expected_window, status, importance, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(work_id, event_id) DO UPDATE SET planted_chapter=excluded.planted_chapter, related_entities=excluded.related_entities,
            trigger_topics=excluded.trigger_topics, expected_window=excluded.expected_window, status=excluded.status, importance=excluded.importance, updated_at=excluded.updated_at`)
          .run(wid, eid, e.chapter_id ? (posOf.get(Number(e.chapter_id)) ?? null) : null,
            [...related].join(' '), [...topics].join(' '),
            String(payload.expected_window || payload.window || ''), String(e.foreshadow_status || 'open'),
            Number(payload.importance) || 50, ts);
        foreshadows += 1;
      }
    }

    for (const w of worldRows) {
      const kws = splitList(w.keywords);
      prepare(`INSERT INTO novel_index_world (work_id, entry_id, domain, entities, applies_to, exceptions, hard_or_soft, priority, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, entry_id) DO UPDATE SET domain=excluded.domain, entities=excluded.entities, applies_to=excluded.applies_to,
          exceptions=excluded.exceptions, hard_or_soft=excluded.hard_or_soft, priority=excluded.priority, updated_at=excluded.updated_at`)
        .run(wid, Number(w.id), kws[0] || '', kws.join(' '), '', '', Number(w.is_pinned) === 1 ? 'hard' : 'soft', Number(w.priority) || 50, ts);
      world += 1;
    }

    for (const r of relRows) {
      const from = Number(r.from_character_id); const to = Number(r.to_character_id);
      let lastChanged = null;
      for (let i = eventRows.length - 1; i >= 0; i -= 1) {
        const e = eventRows[i];
        const names = eventParticipants.get(Number(e.id)) || [];
        if (names.includes(nameOf.get(from) || '') || names.includes(nameOf.get(to) || '')) { lastChanged = e.chapter_id ? (posOf.get(Number(e.chapter_id)) ?? null) : null; break; }
      }
      prepare(`INSERT INTO novel_index_relations (work_id, relation_id, from_character_id, to_character_id, relation_type, trust, conflict, debt, last_changed_chapter, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, relation_id) DO UPDATE SET from_character_id=excluded.from_character_id, to_character_id=excluded.to_character_id,
          relation_type=excluded.relation_type, trust=excluded.trust, conflict=excluded.conflict, debt=excluded.debt,
          last_changed_chapter=excluded.last_changed_chapter, updated_at=excluded.updated_at`)
        .run(wid, Number(r.id), from, to, String(r.relation || ''), null, null, null, lastChanged, ts);
      relations += 1;
    }

    const locationNames = new Map();
    for (const en of entityRows.filter((x) => x.kind === 'location')) {
      const aliases = aliasRows.filter((a) => Number(a.entity_id) === Number(en.id)).map((a) => String(a.alias || '')).filter(Boolean);
      locationNames.set(`entity:${en.id}`, { name: String(en.canonical_name || ''), aliases });
    }
    for (const [, loc] of eventLocation) {
      if (!loc) continue;
      const key = `name:${loc}`;
      if (!locationNames.has(key)) locationNames.set(key, { name: loc, aliases: [] });
    }
    for (const [lid, info] of locationNames) {
      prepare(`INSERT INTO novel_index_locations (work_id, location_id, name, parent, region, connected_to, travel_time, occupants, factions, scene_tags, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, location_id) DO UPDATE SET name=excluded.name, parent=excluded.parent, region=excluded.region,
          connected_to=excluded.connected_to, travel_time=excluded.travel_time, occupants=excluded.occupants,
          factions=excluded.factions, scene_tags=excluded.scene_tags, updated_at=excluded.updated_at`)
        .run(wid, lid, info.name, '', '', '', '', '', '', info.aliases.join(' '), ts);
      locations += 1;
    }

    for (const p of plotRows) {
      const pid = Number(p.id);
      const parts = plotChars.filter((x) => Number(x.plotline_id) === pid).map((x) => String(x.character_name || '')).filter(Boolean);
      const chs = prepare('SELECT id, position FROM chapters WHERE work_id = ? AND plotline_id = ? ORDER BY position ASC, id ASC').all(wid, pid);
      const opened = chs.length ? (posOf.get(Number(chs[0].id)) ?? null) : null;
      const last = chs.length ? (posOf.get(Number(chs[chs.length - 1].id)) ?? null) : null;
      prepare(`INSERT INTO novel_index_threads (work_id, thread_id, topic, participants, opened_chapter, last_progress, next_expected, status, priority, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, thread_id) DO UPDATE SET topic=excluded.topic, participants=excluded.participants,
          opened_chapter=excluded.opened_chapter, last_progress=excluded.last_progress, next_expected=excluded.next_expected,
          status=excluded.status, priority=excluded.priority, updated_at=excluded.updated_at`)
        .run(wid, pid, String(p.title || ''), [...new Set(parts)].join(' '), opened, last, '', 'open', Number(p.position) || 0, ts);
      threads += 1;
    }

    const idList = (rows) => rows.map((r) => Number(r.id));
    const prune = (table, key, ids) => {
      const rows = prepare(`SELECT ${key} AS k FROM ${table} WHERE work_id = ?`).all(wid);
      for (const r of rows) if (!ids.includes(Number(r.k))) prepare(`DELETE FROM ${table} WHERE work_id = ? AND ${key} = ?`).run(wid, Number(r.k));
    };
    prune('novel_index_characters', 'character_id', idList(charRows));
    prune('novel_index_events', 'event_id', idList(eventRows));
    prune('novel_index_foreshadows', 'event_id', idList(eventRows.filter((e) => e.kind === 'foreshadow')));
    prune('novel_index_world', 'entry_id', idList(worldRows));
    prune('novel_index_relations', 'relation_id', idList(relRows));
    prune('novel_index_threads', 'thread_id', idList(plotRows));
    const locationKeys = [...locationNames.keys()];
    for (const r of prepare('SELECT location_id FROM novel_index_locations WHERE work_id = ?').all(wid)) {
      if (!locationKeys.includes(String(r.location_id))) prepare('DELETE FROM novel_index_locations WHERE work_id = ? AND location_id = ?').run(wid, String(r.location_id));
    }

    const version = novelIndexVersion(wid) + 1;
    metaSet(wid, 'version', String(version));
    metaSet(wid, 'schema', String(NOVEL_INDEX_SCHEMA_VERSION));
    metaSet(wid, 'fingerprint', `${NOVEL_INDEX_SCHEMA_VERSION}|${String(work.updated_at || '')}`);
    metaSet(wid, 'rebuilt_at', ts);
    db.exec('COMMIT');
    return { ok: true, status: 'rebuilt', version, counts: { characters, events, foreshadows, world, relations, locations, threads }, ms: Date.now() - t0 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已回滚 */ }
    return { ok: false, status: 'rebuild_failed', error: e.message };
  }
}

// ── 查询（结构化/精确；每次调用计数一次） ────────────────────────────────────
function nameLike(names) {
  return names.map(() => '(name = ? OR aliases LIKE ?)').join(' OR ');
}
function nameParams(names) {
  const params = [];
  for (const n of names) { params.push(n, `%${n}%`); }
  return params;
}

export function queryCharacters({ workId, names = [], limit = NOVEL_INDEX.characterLimit } = {}) {
  countQuery('character');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.characterLimit, NOVEL_INDEX.characterLimit));
  const list = [...new Set(names.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  try {
    const base = 'SELECT character_id, name, aliases, importance, current_location, factions, last_active_chapter FROM novel_index_characters WHERE work_id = ?';
    const rows = list.length
      ? prepare(`${base} AND (${nameLike(list)}) ORDER BY importance DESC, character_id ASC LIMIT ?`).all(wid, ...nameParams(list), lim)
      : prepare(`${base} ORDER BY importance DESC, character_id ASC LIMIT ?`).all(wid, lim);
    return { ok: true, status: 'ok', rows };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

export function queryEvents({ workId, participants = [], location = '', fromChapter = null, toChapter = null, limit = NOVEL_INDEX.eventLimit } = {}) {
  countQuery('event');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.eventLimit, NOVEL_INDEX.eventLimit));
  const conds = ['work_id = ?']; const params = [wid];
  const parts = [...new Set(participants.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  if (parts.length) { conds.push(`(${parts.map(() => 'participants LIKE ?').join(' OR ')})`); params.push(...parts.map((p) => `%${p}%`)); }
  if (location) { conds.push('location LIKE ?'); params.push(`%${String(location).slice(0, 40)}%`); }
  if (Number.isFinite(fromChapter)) { conds.push('chapter_position >= ?'); params.push(Number(fromChapter)); }
  if (Number.isFinite(toChapter)) { conds.push('chapter_position <= ?'); params.push(Number(toChapter)); }
  try {
    const rows = prepare(`SELECT event_id, chapter_id, chapter_position, time_text, location, participants, type, causal_parent, consequences, status FROM novel_index_events WHERE ${conds.join(' AND ')} ORDER BY COALESCE(chapter_position, -1) DESC, event_id DESC LIMIT ?`).all(...params, lim);
    return { ok: true, status: 'ok', rows };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

export function queryForeshadows({ workId, topics = [], entities = [], limit = NOVEL_INDEX.foreshadowLimit } = {}) {
  countQuery('foreshadow');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.foreshadowLimit, NOVEL_INDEX.foreshadowLimit));
  const terms = [...new Set([...topics, ...entities].map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  try {
    const base = `SELECT event_id, planted_chapter, related_entities, trigger_topics, expected_window, status, importance FROM novel_index_foreshadows WHERE work_id = ? AND status NOT IN ('resolved','dropped')`;
    const rows = terms.length
      ? prepare(`${base} AND (${terms.map(() => '(related_entities LIKE ? OR trigger_topics LIKE ?)').join(' OR ')}) ORDER BY importance DESC, planted_chapter DESC LIMIT ?`)
          .all(wid, ...terms.flatMap((t) => [`%${t}%`, `%${t}%`]), lim)
      : prepare(`${base} ORDER BY importance DESC, planted_chapter DESC LIMIT ?`).all(wid, lim);
    return { ok: true, status: 'ok', rows, matched: terms.length > 0 };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

// ── 第二梯队：结构与查询接口就绪，**本次不接入装配** ──────────────────────────
export function queryWorld({ workId, entities = [], limit = NOVEL_INDEX.worldLimit } = {}) {
  countQuery('world');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.worldLimit, NOVEL_INDEX.worldLimit));
  const terms = [...new Set(entities.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  try {
    const base = 'SELECT entry_id, domain, entities, applies_to, exceptions, hard_or_soft, priority FROM novel_index_world WHERE work_id = ?';
    const rows = terms.length
      ? prepare(`${base} AND (${terms.map(() => 'entities LIKE ?').join(' OR ')}) ORDER BY priority DESC, entry_id ASC LIMIT ?`).all(wid, ...terms.map((t) => `%${t}%`), lim)
      : prepare(`${base} ORDER BY priority DESC, entry_id ASC LIMIT ?`).all(wid, lim);
    return { ok: true, status: 'ok', rows };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

export function queryRelations({ workId, names = [], characterIds = [], limit = NOVEL_INDEX.relationLimit } = {}) {
  countQuery('relation');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.relationLimit, NOVEL_INDEX.relationLimit));
  const ids = [...new Set(characterIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 12);
  const wanted = [...new Set(names.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  try {
    let rows;
    if (ids.length) {
      rows = prepare(`SELECT relation_id, from_character_id, to_character_id, relation_type, trust, conflict, debt, last_changed_chapter FROM novel_index_relations WHERE work_id = ? AND (from_character_id IN (${ids.map(() => '?').join(',')}) OR to_character_id IN (${ids.map(() => '?').join(',')})) ORDER BY relation_id ASC LIMIT ?`).all(wid, ...ids, ...ids, lim);
    } else if (wanted.length) {
      rows = prepare(`SELECT r.relation_id, r.from_character_id, r.to_character_id, r.relation_type, r.trust, r.conflict, r.debt, r.last_changed_chapter FROM novel_index_relations r JOIN novel_index_characters c ON c.work_id = r.work_id AND (c.character_id = r.from_character_id OR c.character_id = r.to_character_id) WHERE r.work_id = ? AND (${wanted.map(() => '(c.name = ? OR c.aliases LIKE ?)').join(' OR ')}) ORDER BY r.relation_id ASC LIMIT ?`).all(wid, ...wanted.flatMap((n) => [n, `%${n}%`]), lim);
    } else {
      rows = prepare('SELECT relation_id, from_character_id, to_character_id, relation_type, trust, conflict, debt, last_changed_chapter FROM novel_index_relations WHERE work_id = ? ORDER BY relation_id ASC LIMIT ?').all(wid, lim);
    }
    return { ok: true, status: 'ok', rows };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

export function queryLocations({ workId, names = [], limit = NOVEL_INDEX.locationLimit } = {}) {
  countQuery('location');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.locationLimit, NOVEL_INDEX.locationLimit));
  const terms = [...new Set(names.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  try {
    const base = 'SELECT location_id, name, parent, region, connected_to, travel_time, occupants, factions, scene_tags FROM novel_index_locations WHERE work_id = ?';
    const rows = terms.length
      ? prepare(`${base} AND (${terms.map(() => '(name = ? OR scene_tags LIKE ?)').join(' OR ')}) ORDER BY name ASC LIMIT ?`).all(wid, ...terms.flatMap((n) => [n, `%${n}%`]), lim)
      : prepare(`${base} ORDER BY name ASC LIMIT ?`).all(wid, lim);
    return { ok: true, status: 'ok', rows };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

export function queryThreads({ workId, topics = [], limit = NOVEL_INDEX.threadLimit } = {}) {
  countQuery('thread');
  const wid = Number(workId);
  const lim = Math.max(1, Math.min(Number(limit) || NOVEL_INDEX.threadLimit, NOVEL_INDEX.threadLimit));
  const terms = [...new Set(topics.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  try {
    const base = "SELECT thread_id, topic, participants, opened_chapter, last_progress, next_expected, status, priority FROM novel_index_threads WHERE work_id = ? AND status IN ('open','dormant')";
    const rows = terms.length
      ? prepare(`${base} AND (${terms.map(() => '(topic LIKE ? OR participants LIKE ?)').join(' OR ')}) ORDER BY priority DESC, last_progress DESC LIMIT ?`).all(wid, ...terms.flatMap((t) => [`%${t}%`, `%${t}%`]), lim)
      : prepare(`${base} ORDER BY priority DESC, last_progress DESC LIMIT ?`).all(wid, lim);
    return { ok: true, status: 'ok', rows };
  } catch (e) { return { ok: false, status: 'index_unavailable', rows: [], error: e.message }; }
}

// ── 第三梯队：仅结构与预留接口（E3）——明确返回 not_wired，不假装可用 ─────────
export function queryItems() { countQuery('item'); return { ok: false, status: 'not_wired', rows: [] }; }
export function queryChapters() { countQuery('chapter'); return { ok: false, status: 'not_wired', rows: [] }; }
export function queryStyle() { countQuery('style'); return { ok: false, status: 'not_wired', rows: [] }; }
export function queryKnowledge() { countQuery('knowledge'); return { ok: false, status: 'not_wired', rows: [] }; }
