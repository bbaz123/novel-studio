/**
 * ai/story-state/temporal/state-query.mjs —— S07：统一时点读取（强制 worldline / 边界 / POV / 版本）。
 *
 * 为什么需要这一层（S07 的三个病灶）：
 *   ① **读取入口各自为政**：有的带 commitId、有的只带 chapterId，于是"读到哪个时点"取决于调用点，
 *      而不是取决于查询契约；
 *   ② **没有溯源**：拿到一份 state 之后，没人能回答"这份状态来自哪个提交、哪个边界、哪一版投影"；
 *   ③ **静默退回最新值**：输入不可信（提交不存在/章节不在章序/作品缺失）时，若返回"最新状态"，
 *      就成了"用未来的事实解释过去"——本模块**禁止**这种回退，一律返回类型化的失败。
 *
 * 纪律：
 *   · 本模块**不改变** `stateAt` 的语义，只在它外面加"契约 + 溯源 + 可见性判定"；
 *   · 视图（历史 / 当前 / 草案）由**参数**决定，不由调用方"顺手"决定；
 *   · POV 可见性只做**确定性**过滤（基于章节边界与 scope），不引入"名称没出现就不失效"这类启发式。
 */

export const PROJECTION_VERSION = 'proj-v2';
export const STATE_QUERY_VERSION = 'q-v2';

/** 三个视图：历史（钉提交）/ 当前（主线 HEAD）/ 草案（含 pending 之上的非正式视图）。 */
export const VIEWS = Object.freeze(['historical', 'current', 'draft']);

export function normalizeView(raw) {
  const v = String(raw == null ? 'current' : raw).trim().toLowerCase();
  if (!VIEWS.includes(v)) throw new TypeError(`INVALID_VIEW:${v}`);
  return v;
}

/**
 * 视图 → 查询参数。**强制**每个视图都必须能说清"钉在哪儿"：
 *   · historical：必须给 commitId（否则等于"历史=当前"，那就不是历史视图）；
 *   · current：必须给 worldlineId（或显式接受主线 HEAD）；
 *   · draft：在 current 的基础上允许 pending 参与**标记**，但**不得**混进正式事实
 *     （stateAt 的可信前缀在 pending 处停住，这里只额外标注"本章有未确认提案"）。
 */
export function resolveQueryPlan({ view = 'current', commitId = null, worldlineId = null } = {}) {
  const v = normalizeView(view);
  if (v === 'historical') {
    if (!commitId) throw new TypeError('HISTORICAL_REQUIRES_COMMIT_ID');
    return { view: v, commitId: String(commitId), worldlineId: null, boundary: 'after' };
  }
  return { view: v, commitId: null, worldlineId: worldlineId ? String(worldlineId) : null, boundary: 'after' };
}

/**
 * 统一查询。
 *
 * @returns {{
 *   ok:boolean, view:string, version:string, projection_version:string,
 *   provenance:{ commit_id:string|null, worldline_id:string|null, boundary:string, chapter_id:number, projection_version:string },
 *   state:Object|null, validity:string, trusted:boolean, verified_through:number,
 *   stop:Object|null, reason?:string, detail?:string
 * }}
 *
 * 关键：`ok:false` 时 `state` 必须是 **null**，绝不回退到"最新值"。
 * 旧实现若在 failed 路径返回 `state: {}`，调用方会把它当成"这一章什么都没有"——同样危险。
 */
export function queryState(deps, { workId, chapterId, chapterIndex = null, view = 'current', commitId = null, worldlineId = null, boundary = 'after', povCharacterId = null } = {}) {
  const { stateAt } = deps || {};
  if (typeof stateAt !== 'function') throw new TypeError('MISSING_STATE_AT');
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w) return failed('MISSING_WORK_ID', { view, chapterId: c });
  if (!c) return failed('MISSING_CHAPTER_ID', { view, workId: w });

  let plan;
  try {
    plan = resolveQueryPlan({ view, commitId, worldlineId });
  } catch (e) {
    return failed(String(e && e.message || 'INVALID_QUERY_PLAN'), { view, workId: w, chapterId: c });
  }
  const b = boundary === 'before' ? 'before' : 'after';

  let r;
  try {
    r = stateAt({ workId: w, chapterId: c, commitId: plan.commitId, worldlineId: plan.worldlineId, boundary: b });
  } catch (e) {
    // 提交不存在 / 不属于该作品 → 类型化失败，**不回退到最新**
    return failed('QUERY_FAILED', { view: plan.view, workId: w, chapterId: c, detail: String(e && e.message || e) });
  }

  const provenance = {
    commit_id: r && r.commit_id ? String(r.commit_id) : null,
    worldline_id: r && r.worldline_id ? String(r.worldline_id) : null,
    boundary: b,
    chapter_id: c,
    projection_version: PROJECTION_VERSION,
    query_version: STATE_QUERY_VERSION,
  };

  if (!r || r.ok === false) {
    return {
      ok: false,
      view: plan.view,
      version: STATE_QUERY_VERSION,
      projection_version: PROJECTION_VERSION,
      provenance,
      state: null, // ← 关键：失败绝不返回 {} 或最新值
      validity: (r && r.validity) || 'unknown',
      trusted: false,
      verified_through: -1,
      stop: (r && r.stop) || null,
      reason: 'STATE_NOT_QUERYABLE',
      detail: (r && r.note) || (r && r.stop && r.stop.detail) || '',
    };
  }

  return {
    ok: true,
    view: plan.view,
    version: STATE_QUERY_VERSION,
    projection_version: PROJECTION_VERSION,
    provenance,
    state: r.state,
    validity: String(r.validity || 'unknown'),
    trusted: r.trusted === true,
    verified_through: Number(r.verified_through),
    stop: r.stop || null,
    // 草案视图单独标注：有未确认提案时如实说"这不是正式事实"，而不是篡改 state。
    draft_pending: plan.view === 'draft',
    pov_character_id: povCharacterId == null ? null : Number(povCharacterId),
    chapter_index: chapterIndex == null ? null : Number(chapterIndex),
  };
}

function failed(reason, extra = {}) {
  return {
    ok: false,
    view: extra.view || 'current',
    version: STATE_QUERY_VERSION,
    projection_version: PROJECTION_VERSION,
    provenance: {
      commit_id: null,
      worldline_id: null,
      boundary: extra.boundary || 'after',
      chapter_id: Number(extra.chapterId) || 0,
      projection_version: PROJECTION_VERSION,
      query_version: STATE_QUERY_VERSION,
    },
    state: null,
    validity: 'untrusted',
    trusted: false,
    verified_through: -1,
    stop: null,
    reason,
    detail: extra.detail || '',
  };
}

/**
 * 边界可见性：**第 20 章不能看到第 80 章的事实**。
 *
 * 这是 S07 的硬验收项。判据是纯算术 + 确定性：
 *   · 事实所在章序 index 必须 < 读取边界的排他上界；
 *   · 缺 index（没进章序）一律**不可见**（宁可少给，不可多给）。
 */
export function factVisibleAt({ factChapterIndex, boundaryExclusive, boundary = 'after', readChapterIndex = null } = {}) {
  // ⚠️ 必须显式排除 null/undefined/'' —— `Number(null) === 0`，否则"没给上界"会被当成上界=0，
  // 从而静默把一切事实判为不可见（或反过来），这类类型陷阱在边界判定里代价极大。
  const missingFact = factChapterIndex === null || factChapterIndex === undefined || factChapterIndex === '';
  const missingLimit = boundaryExclusive === null || boundaryExclusive === undefined || boundaryExclusive === '';
  if (missingFact) return { visible: false, reason: 'FACT_INDEX_UNKNOWN' };
  if (missingLimit) return { visible: false, reason: 'BOUNDARY_INDEX_UNKNOWN' };
  const fact = Number(factChapterIndex);
  const limit = Number(boundaryExclusive);
  if (!Number.isFinite(fact) || fact < 0) return { visible: false, reason: 'FACT_INDEX_UNKNOWN' };
  if (!Number.isFinite(limit)) return { visible: false, reason: 'BOUNDARY_INDEX_UNKNOWN' };
  // 读第 N 章（after）时，排他上界应为 N+1；读 before 时是 N。
  if (readChapterIndex !== null && readChapterIndex !== undefined) {
    const expected = boundary === 'before' ? Number(readChapterIndex) : Number(readChapterIndex) + 1;
    if (Number.isFinite(expected) && expected !== limit) {
      return { visible: false, reason: 'BOUNDARY_MISMATCH', detail: `边界上界 ${limit} 与 ${boundary}@${readChapterIndex} 不一致` };
    }
  }
  if (fact >= limit) return { visible: false, reason: 'BEYOND_BOUNDARY' };
  return { visible: true, reason: 'WITHIN_BOUNDARY' };
}

/** 把"每章事实"按边界过滤成可见子集（用于投影/检索的确定性裁剪）。 */
export function filterFactsByBoundary(facts, { boundaryExclusive, boundary = 'after', readChapterIndex = null } = {}) {
  const kept = [];
  const dropped = [];
  for (const f of facts || []) {
    const v = factVisibleAt({ factChapterIndex: f && (f.chapter_index ?? f.chapterIndex), boundaryExclusive, boundary, readChapterIndex });
    if (v.visible) kept.push(f);
    else dropped.push({ fact: f, reason: v.reason });
  }
  return { kept, dropped, total: (facts || []).length };
}

/**
 * POV 可见性：只做**确定性**过滤。
 *   · `reader` scope 的事实只对"已披露"成立 —— 由调用方传入 disclosed 集合，本函数不猜；
 *   · `character` scope 且 holderId 不是当前 POV → 不可见（角色只能看到自己的知识）。
 * 不做"名称没出现过就不失效"这类启发式（S07 明确禁止）。
 */
export function povVisible({ scope, holderId = null, povCharacterId = null, disclosed = false } = {}) {
  const s = String(scope || '');
  if (s === 'reader') {
    return { visible: disclosed === true, reason: disclosed ? 'DISCLOSED' : 'NOT_DISCLOSED' };
  }
  if (s === 'character') {
    if (povCharacterId === null || povCharacterId === undefined) {
      return { visible: false, reason: 'POV_UNKNOWN' };
    }
    const holder = holderId === null || holderId === undefined ? '' : String(holderId);
    return { visible: holder === String(povCharacterId), reason: holder === String(povCharacterId) ? 'OWN_KNOWLEDGE' : 'OTHER_CHARACTER' };
  }
  // canon / world 等对任何人可见（它们就是世界事实）
  return { visible: true, reason: 'SCOPE_PUBLIC' };
}
