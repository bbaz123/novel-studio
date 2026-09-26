/**
 * 确定性故事状态内核 · 时间线（P0 必答项之一）。
 *
 * 要解决的问题：长篇里最容易出的两类时间线事故——
 *   ① **未来数据泄漏**：第 5 章就写到了第 9 章才该发生的事（"她后来才知道……" 变成
 *      当场就知道），装配上下文时把 effective_from=9 的条目塞进了第 5 章的提示词；
 *   ② **顺序倒置**：事件 B 明确要求在 A 之后，却在时间线上排在 A 前面。
 *
 * 这两类都必须能被**机械判定**，而不是靠人工读一遍。所以本模块只做纯函数计算：
 * 输入是时间线条目数组 + 一个游标（第几章第几场），输出是"哪些可见 / 哪些是未来 /
 * 哪些顺序冲突"。它不碰数据库、不碰提示词——写与读由 store.mjs / server.js 负责。
 *
 * 时间模型（三层，缺一不可）：
 *   - `chapter_index` / `scene_index`：**结构时间**，永远是整数，是"能不能看见"的唯一判据；
 *   - `story_time`：**故事内时间**，自由文本（"开元三年冬"），用于人工判读与排序提示；
 *   - `relative_time` / `day_offset`：**相对时间**，从相对说法解析出的天数偏移，
 *     用于把"三天后"换算成可比较的整数。
 *
 * 为什么"能不能看见"只认 chapter_index：story_time 是自由文本，同一天里可能有
 * 上一章与下一章的事件，用它做可见性判据会随机地把未来事件放进当前章节。
 */

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

/**
 * 面向人的章/场序号。
 *
 * 内部 `chapter_index` / `scene_index` 是**0 基下标**（0 = 第一章 / 第一场），比较逻辑一律用下标；
 * 凡是写给人或模型看的文字都必须走这里 +1——否则会显示成不存在的「第 0 章」，
 * 或把第三章说成「第 2 章」。时间线正是靠这些数字对齐，错一位就会错位归因。
 */
export function ordinal(index) {
  const n = Number(index);
  return Number.isFinite(n) ? n + 1 : null;
}

/** 规范化一条时间线条目（容错：缺字段时给安全默认值，不抛）。 */
export function normalizeTimelineEntry(row = {}) {
  return {
    id: row.id ?? null,
    work_id: row.work_id ?? null,
    chapter_id: row.chapter_id ?? null,
    event_id: row.event_id ?? null,
    chapter_index: num(row.chapter_index),
    scene_index: num(row.scene_index),
    seq: num(row.seq),
    story_time: String(row.story_time || ''),
    relative_time: String(row.relative_time || ''),
    day_offset: row.day_offset === null || row.day_offset === undefined ? null : num(row.day_offset),
    effective_from: num(row.effective_from, num(row.chapter_index)),
    effective_to: row.effective_to === null || row.effective_to === undefined ? null : num(row.effective_to),
    before_event_id: row.before_event_id ?? null,
    after_event_id: row.after_event_id ?? null,
    kind: String(row.kind || 'event'),
    label: String(row.label || ''),
    payload: row.payload ?? {},
    source: String(row.source || ''),
  };
}

/**
 * 让时间线拥有**全序**：先章、再场、再 seq、最后 id。
 * seq 缺省时用 id 兜底，保证同一 (章, 场) 下不会出现顺序不定——
 * 顺序不定会让"同一份输入"装配出不同结果，直接破坏上下文可复现性。
 */
export function compareTimeline(a, b) {
  if (a.chapter_index !== b.chapter_index) return a.chapter_index - b.chapter_index;
  if (a.scene_index !== b.scene_index) return a.scene_index - b.scene_index;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return num(a.id) - num(b.id);
}

export function sortTimeline(entries = []) {
  return entries.map(normalizeTimelineEntry).sort(compareTimeline);
}

/** 游标：把"现在写到哪了"表达成一个可比较的值。 */
export function cursorOf({ chapterIndex, sceneIndex, chapterId } = {}) {
  return {
    chapter_index: num(chapterIndex),
    scene_index: sceneIndex === null || sceneIndex === undefined ? null : num(sceneIndex),
    chapter_id: chapterId ?? null,
  };
}

/** 条目在游标处是否**可见**（即：它属于过去或现在，不是未来）。 */
export function isVisibleAt(cursor, entry) {
  const e = normalizeTimelineEntry(entry);
  if (e.effective_from > cursor.chapter_index) return false;
  if (e.effective_to !== null && e.effective_to <= cursor.chapter_index) return false;
  return true;
}

/**
 * 未来数据泄漏清单：条目本身属于当前或更早的章，却把 effective_from 声明到了未来；
 * 或条目自身的章节下标就在未来（作者把后面的安排混进了这一章的事实里）。
 *
 * 返回的每一项都带 `reason` 与 `evidence`，让作者能直接看到"是谁漏的"，
 * 而不是收到一句"检测到时间线问题"。
 */
export function futureLeaks(entries = [], cursor) {
  const out = [];
  for (const raw of entries) {
    const e = normalizeTimelineEntry(raw);
    if (e.effective_from > cursor.chapter_index) {
      out.push({
        code: 'FUTURE_EFFECTIVE_FROM',
        id: e.id,
        label: e.label,
        reason: `条目声明从第 ${ordinal(e.effective_from)} 章起生效，而当前写到第 ${ordinal(cursor.chapter_index)} 章`,
        evidence: { effective_from: e.effective_from, cursor_chapter_index: cursor.chapter_index },
      });
    }
    if (e.chapter_index > cursor.chapter_index) {
      out.push({
        code: 'FUTURE_CHAPTER_INDEX',
        id: e.id,
        label: e.label,
        reason: `条目本身属于第 ${ordinal(e.chapter_index)} 章（未来章），不应出现在第 ${ordinal(cursor.chapter_index)} 章的上下文里`,
        evidence: { chapter_index: e.chapter_index, cursor_chapter_index: cursor.chapter_index },
      });
    }
  }
  return out;
}

/**
 * 顺序冲突：`before_event_id` / `after_event_id` 是作者写下的**显式约束**，
 * 时间线排序必须满足它们；不满足就是硬冲突（不是提醒）。
 *
 * 只在两个事件都在同一份输入里时才判定——单边缺失属于"还没写进来"，
 * 报出来只会变成噪音（大量误报会让作者直接忽略这一栏）。
 */
export function detectOrderInversions(entries = []) {
  const list = sortTimeline(entries);
  const indexOf = new Map();
  list.forEach((e, i) => { if (e.id !== null) indexOf.set(num(e.id), i); });
  const out = [];
  for (const e of list) {
    if (e.before_event_id !== null && indexOf.has(num(e.before_event_id))) {
      const target = indexOf.get(num(e.before_event_id));
      const self = indexOf.get(num(e.id));
      if (self > target) {
        out.push({
          code: 'ORDER_BEFORE_VIOLATED',
          id: e.id,
          label: e.label,
          reason: `条目要求排在第 ${e.before_event_id} 条之前，实际排在其后`,
          evidence: { self_index: self, target_index: target },
        });
      }
    }
    if (e.after_event_id !== null && indexOf.has(num(e.after_event_id))) {
      const target = indexOf.get(num(e.after_event_id));
      const self = indexOf.get(num(e.id));
      if (self < target) {
        out.push({
          code: 'ORDER_AFTER_VIOLATED',
          id: e.id,
          label: e.label,
          reason: `条目要求排在第 ${e.after_event_id} 条之后，实际排在其前`,
          evidence: { self_index: self, target_index: target },
        });
      }
    }
  }
  return out;
}

/**
 * 从中文相对时间说法里解析天数偏移："三天后" → 3，"两年前" → 730。
 *
 * 只认**明确表述**；解析不出来返回 null（而不是猜一个数字）——
 * 猜出来的数字会污染排序，让作者看到一条凭空的先后关系。
 */
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
export function relativeTimeToDayOffset(text) {
  const s = String(text || '');
  if (!s) return null;
  const m = s.match(/([0-9]+|[一二两三四五六七八九十半]+)\s*(天|日|周|星期|个月|月|年)(后|之后|前|之前)?/);
  if (!m) return null;
  const raw = m[1];
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : parseCnNumber(raw);
  if (n === null) return null;
  const unit = m[2];
  const perUnit = unit === '天' || unit === '日' ? 1
    : unit === '周' || unit === '星期' ? 7
      : unit === '个月' || unit === '月' ? 30 : 365;
  const sign = (m[3] === '前' || m[3] === '之前') ? -1 : 1;
  return sign * n * perUnit;
}

function parseCnNumber(raw) {
  if (raw === '十') return 10;
  if (raw === '半') return 0.5;
  if (raw.length === 1) return CN_NUM[raw] ?? null;
  // 十N / N十 / N十M
  const tenIdx = raw.indexOf('十');
  if (tenIdx >= 0) {
    const head = tenIdx === 0 ? 1 : (CN_NUM[raw[tenIdx - 1]] ?? null);
    const tailRaw = raw.slice(tenIdx + 1);
    const tail = tailRaw === '' ? 0 : (CN_NUM[tailRaw] ?? null);
    if (head === null || tail === null) return null;
    return head * 10 + tail;
  }
  return null;
}

/**
 * 时间线视图：可见 / 未来 / 顺序冲突 / 冲突清单。
 * `visible` 已按全序排好，可直接交给上下文层渲染（渲染顺序也必须确定）。
 */
export function buildTimelineView(entries = [], cursor) {
  const all = sortTimeline(entries);
  const visible = all.filter((e) => isVisibleAt(cursor, e));
  const future = all.filter((e) => !isVisibleAt(cursor, e));
  const leaks = futureLeaks(all, cursor);
  const inversions = detectOrderInversions(all);
  return {
    cursor,
    all,
    visible,
    future,
    leaks,
    inversions,
    conflicts: [...leaks, ...inversions],
  };
}

/**
 * 故事内时间的粗排序键：有 day_offset 的用它，没有的用章序。
 * **只用于展示排序**，不用于可见性判定（见文件头说明）。
 */
export function storyTimeSortKey(entry) {
  const e = normalizeTimelineEntry(entry);
  if (e.day_offset !== null) return e.day_offset;
  return e.chapter_index * 1000 + e.scene_index;
}