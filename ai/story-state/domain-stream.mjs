/**
 * ai/story-state/domain-stream.mjs —— S08：领域事件流（按作品过滤 / cursor 补读 / watermark / 重连 resync）。
 *
 * 设计要点（也就是 S08 的三条验收）：
 *   ① **断线不漏确认**：事件来自 `projection_outbox` —— 它在**提交事务里**就写入了，
 *      是"已经发生的变更"的持久记录，不是内存广播。客户端断线后按 cursor 补读即可；
 *   ② **重复事件不重复渲染业务动作**：以 `dedup_key`（次要）与自增 `id`（主）双重去重，
 *      客户端记录已处理游标，重放幂等；
 *   ③ **切章后旧结果不更新新章卡片**：每条事件带 `revision_id`，前端必须过
 *      `isUpdateApplicable()` 的修订守卫（见 public/temporal-stream.js 同构实现）。
 *
 * 纪律：
 *   · **不新建事实源**：本模块只**读**既有的 `projection_outbox`，不写业务状态；
 *   · 事件只说明"哪个作品的哪一章发生了什么类型的变更"，权威状态仍由 S07 的 queryState 提供；
 *   · watermark 消除初始化窗口：客户端拿到的初始快照与 `watermark` 一起返回，
 *     `id <= watermark` 的事件已经体现在快照里，直接跳过（否则会重复渲染）。
 */

export const STREAM_VERSION = 'stream-v1';

/** 对外暴露的状态机（前端卡片要能区分这六种）。 */
export const TEMPORAL_STATES = Object.freeze([
  'saved',      // 正文已保存
  'analyzing',  // 分析中
  'pending',    // 待确认（候选已生成）
  'confirmed',  // 已确认（正式生效）
  'stale',      // 过时（上游变了，需要复核）
  'failed',     // 失败（模型/校验失败，需作者处理）
]);

export function normalizeTemporalState(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return TEMPORAL_STATES.includes(s) ? s : 'failed';
}

/** outbox.kind → 前端状态。未识别的 kind 不当成成功态。 */
export function stateOfKind(kind) {
  const k = String(kind || '').trim();
  if (/confirm|apply|commit/.test(k)) return 'confirmed';
  if (/stale|invalidat|obsolete/.test(k)) return 'stale';
  if (/fail|error/.test(k)) return 'failed';
  if (/propos|pending|candidate/.test(k)) return 'pending';
  if (/analy/.test(k)) return 'analyzing';
  if (/save|revision/.test(k)) return 'saved';
  return 'failed';
}

/** 解析 payload（坏数据不许让整条流崩掉）。 */
function parsePayload(raw) {
  try {
    const v = JSON.parse(String(raw || '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

/**
 * 快照 watermark：该作品当前最大的 outbox id。
 * 客户端拿初始快照时一并收到它 —— 之后只处理 `id > watermark` 的事件。
 */
export function snapshotWatermark(db, { workId } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new TypeError('MISSING_WORK_ID');
  const row = db.prepare('SELECT MAX(id) AS m FROM projection_outbox WHERE work_id = ?').get(w);
  return Number(row && row.m) || 0;
}

/**
 * 按作品读取 cursor 之后的事件。
 *
 * @returns {{events:Array, next_cursor:number, has_more:boolean, version:string}}
 */
export function readDomainEvents(db, { workId, afterCursor = 0, limit = 200 } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new TypeError('MISSING_WORK_ID');
  const after = Math.max(0, Number(afterCursor) || 0);
  const take = Math.max(1, Math.min(1000, Number(limit) || 200));
  // 按 id 升序，取 cursor 之后的前 take+1 条，用来判断是否还有更多。
  const rows = db.prepare(
    `SELECT id, work_id, chapter_id, kind, dedup_key, payload_json, created_at
       FROM projection_outbox
      WHERE work_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
  ).all(w, after, take + 1);

  const hasMore = rows.length > take;
  const slice = hasMore ? rows.slice(0, take) : rows;
  const events = slice.map((r) => {
    const payload = parsePayload(r.payload_json);
    return {
      id: Number(r.id),
      work_id: Number(r.work_id),
      chapter_id: r.chapter_id === null || r.chapter_id === undefined ? null : Number(r.chapter_id),
      kind: String(r.kind || ''),
      dedup_key: String(r.dedup_key || ''),
      state: stateOfKind(r.kind),
      revision_id: payload.revision_id === undefined ? null : String(payload.revision_id),
      commit_id: payload.commit_id === undefined ? null : String(payload.commit_id),
      boundary: payload.boundary === undefined ? null : String(payload.boundary),
      affected_chapters: Array.isArray(payload.affected_chapters) ? payload.affected_chapters.map(Number) : [],
      evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
      created_at: String(r.created_at || ''),
    };
  });

  return {
    events,
    next_cursor: events.length ? events[events.length - 1].id : after,
    has_more: hasMore,
    version: STREAM_VERSION,
  };
}

/**
 * 重连策略：决定"补读"还是"resync"。
 *
 * 为什么需要它：客户端可能离线很久，cursor 早已超出保留窗口；
 * 此时**补读会漏确认**（验收明令禁止）。判据是确定性比较，不猜。
 */
export function resyncPlan({ clientCursor, serverWatermark, maxCatchUp = 500, force = false } = {}) {
  const cur = Math.max(0, Number(clientCursor) || 0);
  const wm = Math.max(0, Number(serverWatermark) || 0);
  if (force) return { action: 'resync', reason: 'FORCED' };
  if (cur === 0) return { action: 'snapshot', reason: 'NO_CURSOR', from: wm };
  if (cur > wm) return { action: 'resync', reason: 'CURSOR_AHEAD', from: wm };
  if (wm - cur > Math.max(1, Number(maxCatchUp) || 500)) {
    // 落后太多：补读可能被保留窗口截断 → 直接 resync（宁可重取快照，不可漏确认）
    return { action: 'resync', reason: 'TOO_FAR_BEHIND', from: wm, gap: wm - cur };
  }
  if (cur === wm) return { action: 'idle', reason: 'UP_TO_DATE', from: wm };
  return { action: 'catch_up', reason: 'HAS_NEW_EVENTS', from: cur };
}

/**
 * 幂等去重：重复事件不得触发第二次业务动作。
 * 以 id 为主键去重，并顺带用 dedup_key 兜底（同一逻辑变更可能被重放）。
 *
 * `seen` 可以传 id 数组（向后兼容），也可以传上一次的完整返回值 `{ seenIds, seenKeys }`。
 * ⚠️ 只用本批事件里的 key 构建集合是**不够的** —— 重放通常发生在**跨批次**，
 * 因此必须把历史的 key 一起带进来，否则"换了个 id 的同一变更"会被当成新事件。
 */
export function dedupeEvents(seen, events) {
  const isObj = seen && !Array.isArray(seen) && typeof seen === 'object';
  const seenIds = isObj
    ? new Set(seen.seenIds || [])
    : new Set(Array.isArray(seen) ? seen : []);
  const seenKeys = isObj && seen.seenKeys ? new Set(seen.seenKeys) : new Set();
  const fresh = [];
  const duplicates = [];
  for (const e of events || []) {
    const id = Number(e && e.id);
    const key = String((e && e.dedup_key) || '');
    const dupById = Number.isFinite(id) && seenIds.has(id);
    const dupByKey = !!key && seenKeys.has(key);
    if (dupById || dupByKey) {
      duplicates.push({ id, dedup_key: key, reason: dupById ? 'DUPLICATE_ID' : 'DUPLICATE_KEY' });
      continue;
    }
    if (Number.isFinite(id)) seenIds.add(id);
    if (key) seenKeys.add(key);
    fresh.push(e);
  }
  return { fresh, duplicates, seenIds: [...seenIds], seenKeys: [...seenKeys] };
}

/**
 * 修订守卫：**切章后旧结果不得更新新章节卡片**。
 *
 * 判据（全部确定性）：
 *   · 事件章节必须等于卡片章节（否则丢弃——旧章的更新不许写进新章）；
 *   · 事件的 revision 不得早于卡片当前 revision（用 outbox id 作为单调序即可）；
 *   · 事件状态不得把已确认（confirmed）倒退成 pending/saved（只能前进到 stale 或保持）。
 */
const STATE_RANK = { saved: 0, analyzing: 1, pending: 2, confirmed: 3, stale: 4, failed: 5 };

export function isUpdateApplicable({ event, card } = {}) {
  const e = event || {};
  const c = card || {};
  const evChapter = e.chapter_id === null || e.chapter_id === undefined ? null : Number(e.chapter_id);
  const cardChapter = c.chapter_id === null || c.chapter_id === undefined ? null : Number(c.chapter_id);
  if (evChapter === null) return { applicable: true, reason: 'WORK_LEVEL_EVENT' };
  if (cardChapter !== null && evChapter !== cardChapter) {
    return { applicable: false, reason: 'CHAPTER_MISMATCH' };
  }
  const evCursor = Number(e.id);
  const cardCursor = Number(c.cursor);
  if (Number.isFinite(evCursor) && Number.isFinite(cardCursor) && evCursor < cardCursor) {
    return { applicable: false, reason: 'STALE_EVENT' };
  }
  const evState = normalizeTemporalState(e.state);
  const cardState = c.state == null ? null : normalizeTemporalState(c.state);
  if (cardState === 'confirmed' && (evState === 'pending' || evState === 'saved' || evState === 'analyzing')) {
    return { applicable: false, reason: 'NO_BACKWARD_FROM_CONFIRMED' };
  }
  // 同一事件重复应用：幂等丢弃
  if (Number.isFinite(evCursor) && Number.isFinite(cardCursor) && evCursor === cardCursor && evState === cardState) {
    return { applicable: false, reason: 'ALREADY_APPLIED' };
  }
  return { applicable: true, reason: 'OK', rank: STATE_RANK[evState] };
}
