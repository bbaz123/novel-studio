/**
 * public/temporal-stream.js —— S08：前端侧领域事件流消费（无 DOM 依赖，可在 Node 里直接单测）。
 *
 * 为什么单独一个模块而不是塞进 app.js：S08 明确要求"逐步迁移，不一次重写 app.js"，
 * 并要"保留中文 IME、撤销、光标与自动保存行为"。把流/守卫逻辑做成**纯函数 + 小状态机**，
 * 既能被 frontend-test 覆盖，也不会碰到编辑器里那些对时序极敏感的输入处理。
 *
 * 与后端 `ai/story-state/domain-stream.mjs` 的 `isUpdateApplicable()` **同构**：
 * 两侧判据必须一致，否则会出现"后端认为该丢、前端照渲染"的裂缝。
 */

export const TEMPORAL_STATES = ['saved', 'analyzing', 'pending', 'confirmed', 'stale', 'failed'];

export function normalizeTemporalState(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return TEMPORAL_STATES.includes(s) ? s : 'failed';
}

/** 修订守卫（与后端同构）。 */
export function isUpdateApplicable(event, card) {
  const e = event || {};
  const c = card || {};
  const evChapter = e.chapter_id === null || e.chapter_id === undefined ? null : Number(e.chapter_id);
  const cardChapter = c.chapter_id === null || c.chapter_id === undefined ? null : Number(c.chapter_id);
  if (evChapter === null) return { applicable: true, reason: 'WORK_LEVEL_EVENT' };
  if (cardChapter !== null && evChapter !== cardChapter) return { applicable: false, reason: 'CHAPTER_MISMATCH' };
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
  if (Number.isFinite(evCursor) && Number.isFinite(cardCursor) && evCursor === cardCursor && evState === cardState) {
    return { applicable: false, reason: 'ALREADY_APPLIED' };
  }
  return { applicable: true, reason: 'OK' };
}

/**
 * 创建一个流消费者（纯逻辑，不碰网络）。
 *
 * 用法：`const s = createStreamConsumer(); s.applySnapshot({watermark}); s.ingest(events)`，
 * `s.changed` 里的条目才是需要渲染的业务动作 —— 重复事件不会出现在里面。
 */
export function createStreamConsumer({ initialCursor = 0 } = {}) {
  const state = {
    cursor: Math.max(0, Number(initialCursor) || 0),
    watermark: 0,
    seenIds: new Set(),
    cards: new Map(),      // chapter_id -> { chapter_id, state, cursor }
    applied: [],
    dropped: [],
  };

  /** 初始化/重连后拿到的快照：watermark 之前的事件已经体现在快照里，直接记为已处理。 */
  function applySnapshot({ watermark = 0 } = {}) {
    const wm = Math.max(0, Number(watermark) || 0);
    state.watermark = wm;
    if (wm > state.cursor) state.cursor = wm;
    state.cards.clear();
    return { cursor: state.cursor, watermark: wm };
  }

  /**
   * 消费一批事件；返回真正需要渲染的动作。
   *
   * @param events 事件数组
   * @param activeChapterId 当前正在看的章节。给了它就是**单卡片模式**：
   *   别的章的事件一律丢弃（`CHAPTER_MISMATCH`）—— 这正是"切章后旧结果不更新新章节卡片"。
   *   不给则维护**每章一张卡**（多卡片模式）。
   */
  function ingest(events, { activeChapterId = null } = {}) {
    const active = activeChapterId === null || activeChapterId === undefined ? null : Number(activeChapterId);
    const applied = [];
    const dropped = [];
    for (const e of events || []) {
      const id = Number(e && e.id);
      // ① 快照 watermark 之前的旧事件：已经体现在快照里，**无条件**跳过
      //    （不能要求"以前见过它"—— 快照之后的首次消费正是从空 seenIds 开始的）
      if (Number.isFinite(id) && id <= state.watermark) {
        dropped.push({ id, chapter_id: e && e.chapter_id, reason: 'BELOW_WATERMARK' });
        continue;
      }
      // ② 幂等：同一事件不得触发第二次业务动作
      if (Number.isFinite(id) && state.seenIds.has(id)) {
        dropped.push({ id, reason: 'DUPLICATE_ID' });
        continue;
      }
      // ③ 单卡片模式：不是当前章的事件直接丢弃
      const chapterId = e && e.chapter_id !== null && e.chapter_id !== undefined ? Number(e.chapter_id) : null;
      if (active !== null && chapterId !== null && chapterId !== active) {
        dropped.push({ id, chapter_id: chapterId, reason: 'CHAPTER_MISMATCH' });
        if (Number.isFinite(id)) {
          state.seenIds.add(id);
          if (id > state.cursor) state.cursor = id;
        }
        continue;
      }
      const card = chapterId === null ? null : (state.cards.get(chapterId) || { chapter_id: chapterId, state: null, cursor: 0 });
      const verdict = isUpdateApplicable(e, card || {});
      if (!verdict.applicable) {
        dropped.push({ id, chapter_id: chapterId, reason: verdict.reason });
        if (Number.isFinite(id)) state.seenIds.add(id);
        if (Number.isFinite(id) && id > state.cursor) state.cursor = id;
        continue;
      }
      if (chapterId !== null) {
        state.cards.set(chapterId, { chapter_id: chapterId, state: normalizeTemporalState(e.state), cursor: Number.isFinite(id) ? id : (card ? card.cursor : 0) });
      }
      if (Number.isFinite(id)) {
        state.seenIds.add(id);
        if (id > state.cursor) state.cursor = id;
      }
      applied.push(e);
    }
    state.applied.push(...applied);
    state.dropped.push(...dropped);
    return { applied, dropped, cursor: state.cursor };
  }

  /** 重连决策（与后端 resyncPlan 同构，仅用于客户端自检）。 */
  function planReconnect({ serverWatermark, maxCatchUp = 500 } = {}) {
    const wm = Math.max(0, Number(serverWatermark) || 0);
    if (state.cursor === 0) return { action: 'snapshot', reason: 'NO_CURSOR', from: wm };
    if (state.cursor > wm) return { action: 'resync', reason: 'CURSOR_AHEAD', from: wm };
    if (wm - state.cursor > maxCatchUp) return { action: 'resync', reason: 'TOO_FAR_BEHIND', from: wm };
    if (state.cursor === wm) return { action: 'idle', reason: 'UP_TO_DATE', from: wm };
    return { action: 'catch_up', reason: 'HAS_NEW_EVENTS', from: state.cursor };
  }

  function cardOf(chapterId) {
    const id = Number(chapterId);
    return state.cards.get(id) || null;
  }

  return { applySnapshot, ingest, planReconnect, cardOf, state };
}
