/**
 * 确定性故事状态内核 · 伏笔（PHASE 7）。
 *
 * ⚠ 与宿主的关系（这是本模块最容易做错的地方）：
 *   宿主的 `story_events.foreshadow_status` 只有 `'' | open | resolved | dropped` 三种取值，
 *   而那三个值是 **Host Contract 冻结**的语义。本模块**不修改**它、不新增取值、
 *   不改变 `/api/novel/foreshadows` 的返回形状。
 *
 *   这里做的是**派生视图**：在宿主那三个值 + 章节序 + 回收事件的基础上，算出九个状态
 *   （planned / planted / reinforced / advanced / resolved / dropped / overdue /
 *   mis_resolved / abandoned），供插件与预检使用。派生是只读的纯函数——
 *   宿主字段仍是唯一真相，视图可以随时重算，不会与宿主脱节。
 *
 * 九个状态的含义：
 *   planned       已登记但正文还没写到（尚无归属章节的正文）
 *   planted       已埋进正文（有归属章节）
 *   reinforced    埋下之后又被提及/强化过（后续事实或事件指向它）
 *   advanced      正在推进（有中间事件引用了它，但还没回收）
 *   resolved      已回收，**且**回收事件真实存在且在射程内
 *   dropped       作者显式放弃（宿主 foreshadow_status='dropped'）
 *   overdue       该回收的章节点已过仍未回收
 *   mis_resolved  声称已回收，但回收站不住（回收事件缺失 / 在未来 / 指向别处）
 *   abandoned     长期不推进（远超阈值），基本可以判定为被遗忘
 */

import { ordinal } from './timeline.mjs';

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
const str = (v) => String(v || '');

/** 派生状态词表（只增不改；消费方按这些值判断）。 */
export const FORESHADOW_STATES = [
  'planned', 'planted', 'reinforced', 'advanced', 'resolved', 'dropped', 'overdue', 'mis_resolved', 'abandoned',
];

/** 默认阈值：多少章没推进算 overdue / abandoned。可被调用方覆盖（不做成全局配置，避免"机制强制生效"）。 */
export const DEFAULT_FORESHADOW_THRESHOLDS = { overdueIdleChapters: 12, abandonedIdleChapters: 40 };

export function normalizeForeshadow(row = {}) {
  return {
    id: row.id ?? null,
    work_id: row.work_id ?? null,
    chapter_id: row.chapter_id ?? null,
    chapter_index: row.chapter_index === null || row.chapter_index === undefined ? null : num(row.chapter_index),
    summary: str(row.summary),
    host_status: str(row.foreshadow_status),
    resolves_event_id: row.resolves_event_id ?? null,
    created_index: num(row.created_index, row.chapter_index === null || row.chapter_index === undefined ? 0 : num(row.chapter_index)),
    payload: row.payload ?? {},
    target_chapter_index: row.target_chapter_index === null || row.target_chapter_index === undefined
      ? null : num(row.target_chapter_index),
    last_touch_index: num(row.last_touch_index, num(row.chapter_index)),
  };
}

/**
 * 派生单条伏笔的状态。
 *
 * @param {object} row 伏笔行（至少含 id/summary/foreshadow_status/chapter_index）
 * @param {object} ctx {cursor, eventsById:Map|object, thresholds}
 * @returns {{state:string, reason:string, evidence:object}}
 */
export function deriveForeshadowState(row, ctx = {}) {
  const f = normalizeForeshadow(row);
  const cursor = ctx.cursor || { chapter_index: 0 };
  const thresholds = { ...DEFAULT_FORESHADOW_THRESHOLDS, ...(ctx.thresholds || {}) };
  const lookup = (id) => {
    if (!ctx.eventsById) return null;
    if (ctx.eventsById instanceof Map) return ctx.eventsById.get(Number(id)) || null;
    return ctx.eventsById[Number(id)] || null;
  };
  const idle = Math.max(0, num(cursor.chapter_index) - f.last_touch_index);

  // ① 作者显式放弃 —— 优先于一切自动判定（作者说了算）。
  if (f.host_status === 'dropped') {
    return { state: 'dropped', reason: '作者已标记放弃', evidence: { host_status: 'dropped' } };
  }

  // ② 声称已回收 —— 必须验证回收站不站得住。
  if (f.host_status === 'resolved') {
    if (!f.resolves_event_id) {
      return {
        state: 'mis_resolved',
        reason: '标记为已回收，但没有记录回收事件（resolves_event_id 为空）',
        evidence: { host_status: 'resolved', resolves_event_id: null },
      };
    }
    const ev = lookup(f.resolves_event_id);
    if (!ev) {
      return {
        state: 'mis_resolved',
        reason: `标记为已回收，但回收事件 #${f.resolves_event_id} 不存在（可能已被删除）`,
        evidence: { resolves_event_id: f.resolves_event_id },
      };
    }
    const evIndex = ev.chapter_index === null || ev.chapter_index === undefined ? null : num(ev.chapter_index);
    if (evIndex !== null && f.chapter_index !== null && evIndex < f.chapter_index) {
      return {
        state: 'mis_resolved',
        reason: `回收事件 #${f.resolves_event_id} 在第 ${ordinal(evIndex)} 章，早于伏笔埋下的第 ${ordinal(f.chapter_index)} 章——回收站不住`,
        evidence: { resolves_event_id: f.resolves_event_id, event_chapter_index: evIndex, planted_index: f.chapter_index },
      };
    }
    if (evIndex !== null && evIndex > num(cursor.chapter_index)) {
      return {
        state: 'mis_resolved',
        reason: `回收事件 #${f.resolves_event_id} 属于第 ${ordinal(evIndex)} 章（未来章），当前才写到第 ${ordinal(cursor.chapter_index)} 章`,
        evidence: { resolves_event_id: f.resolves_event_id, event_chapter_index: evIndex, cursor: num(cursor.chapter_index) },
      };
    }
    const sameWork = ev.work_id === undefined || ev.work_id === null || !f.work_id || Number(ev.work_id) === Number(f.work_id);
    if (!sameWork) {
      return {
        state: 'mis_resolved',
        reason: `回收事件 #${f.resolves_event_id} 不属于本作品`,
        evidence: { resolves_event_id: f.resolves_event_id, event_work_id: ev.work_id, work_id: f.work_id },
      };
    }
    return {
      state: 'resolved',
      reason: `已由第 ${evIndex === null ? '?' : ordinal(evIndex)} 章的事件 #${f.resolves_event_id} 回收`,
      evidence: { resolves_event_id: f.resolves_event_id, event_chapter_index: evIndex },
    };
  }

  // ③ 尚未埋进正文。
  if (f.chapter_index === null && f.created_index === 0 && !f.summary) {
    return { state: 'planned', reason: '已登记但尚无内容', evidence: {} };
  }
  if (f.chapter_index === null) {
    return { state: 'planned', reason: '已登记，但还没有归属章节（正文尚未写到）', evidence: { created_index: f.created_index } };
  }

  // ④ 还没到该回收的位置：按推进程度分 planted / reinforced / advanced。
  const advanceRefs = num(ctx.advanceRefs);
  const reinforceRefs = num(ctx.reinforceRefs);
  const target = f.target_chapter_index;

  // ⑤ / ⑥ 逾期与长期不推进（只在"还没回收"时有意义）。
  if (target !== null && num(cursor.chapter_index) > target) {
    return {
      state: 'overdue',
      reason: `计划在第 ${ordinal(target)} 章回收，当前已写到第 ${ordinal(cursor.chapter_index)} 章仍未回收`,
      evidence: { target_chapter_index: target, cursor: num(cursor.chapter_index), idle_chapters: idle },
    };
  }
  if (idle >= thresholds.abandonedIdleChapters) {
    return {
      state: 'abandoned',
      reason: `已连续 ${idle} 章没有任何推进（阈值 ${thresholds.abandonedIdleChapters}）`,
      evidence: { idle_chapters: idle, threshold: thresholds.abandonedIdleChapters },
    };
  }
  if (idle >= thresholds.overdueIdleChapters) {
    return {
      state: 'overdue',
      reason: `已连续 ${idle} 章没有推进（阈值 ${thresholds.overdueIdleChapters}）`,
      evidence: { idle_chapters: idle, threshold: thresholds.overdueIdleChapters },
    };
  }
  if (advanceRefs > 0) {
    return { state: 'advanced', reason: `已有 ${advanceRefs} 处中间推进`, evidence: { advance_refs: advanceRefs } };
  }
  if (reinforceRefs > 0) {
    return { state: 'reinforced', reason: `埋下之后又被提及 ${reinforceRefs} 次`, evidence: { reinforce_refs: reinforceRefs } };
  }
  return { state: 'planted', reason: `已在第 ${ordinal(f.chapter_index)} 章埋下，尚未回收`, evidence: { planted_index: f.chapter_index } };
}

/**
 * 批量派生 + 汇总。
 * `byState` 的计数与 `items` 一一对应，便于一处断言两处一致。
 */
export function deriveForeshadows(rows = [], ctx = {}) {
  const items = rows.map((row) => {
    const d = deriveForeshadowState(row, {
      ...ctx,
      advanceRefs: (ctx.advanceRefsById || {})[row.id] ?? 0,
      reinforceRefs: (ctx.reinforceRefsById || {})[row.id] ?? 0,
    });
    const f = normalizeForeshadow(row);
    return { id: f.id, summary: f.summary, host_status: f.host_status, ...d };
  });
  const byState = Object.fromEntries(FORESHADOW_STATES.map((s) => [s, 0]));
  for (const it of items) byState[it.state] = (byState[it.state] || 0) + 1;
  return { items, byState };
}

/** 逾期 / 错误回收 / 长期不推进 三类问题清单（供预检与校验使用）。 */
export function foreshadowProblems(derived) {
  const out = [];
  for (const it of derived.items || []) {
    if (it.state === 'overdue') {
      out.push({ code: 'FORESHADOW_OVERDUE', foreshadow_id: it.id, summary: it.summary, reason: it.reason, evidence: it.evidence });
    } else if (it.state === 'mis_resolved') {
      out.push({ code: 'FORESHADOW_MIS_RESOLVED', foreshadow_id: it.id, summary: it.summary, reason: it.reason, evidence: it.evidence });
    } else if (it.state === 'abandoned') {
      out.push({ code: 'FORESHADOW_STALLED', foreshadow_id: it.id, summary: it.summary, reason: it.reason, evidence: it.evidence });
    }
  }
  return out;
}

/** 给上下文层用的一行文本：只列**未回收**的（含逾期与不推进），按危害排序。 */
export function renderForeshadowLines(derived, { maxItems = 20 } = {}) {
  const order = { mis_resolved: 0, overdue: 1, abandoned: 2, advanced: 3, reinforced: 4, planted: 5, planned: 6, resolved: 7, dropped: 8 };
  const live = (derived.items || []).filter((it) => it.state !== 'resolved' && it.state !== 'dropped');
  live.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || num(a.id) - num(b.id));
  return live.slice(0, maxItems)
    .map((it) => `#${it.id}〔${it.state}〕${it.summary}${it.state === 'overdue' || it.state === 'abandoned' ? `（${it.reason}）` : ''}`)
    .join('\n');
}