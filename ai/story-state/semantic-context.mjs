/**
 * 确定性故事状态内核 · 语义上下文（PHASE 8）。
 *
 * 前提（不可动摇）：**保留现有 14 层架构**。本模块不新增预算、不改 layers.mjs 里已冻结的
 * cap/FLEX_ORDER，也不重排既有层的渲染顺序——它做的是"在既有分层上加元数据"：
 *   - 给每层标注它属于哪一条**优先级带**（作者可读，便于解释"为什么这层先被压"）；
 *   - 给 story_state 层（作品级开关打开时才存在）生成**子块**，子块内部按同一条带序排列；
 *   - 注入前做**可见性过滤**：只放"当前章节看得见"的事实（未来章节的事实一个都不放）。
 *
 * 优先级带（从高到低）——顺序来自"写错哪个最致命"：
 *   1 hard_constraint      硬约束：红线、连续性硬要求。写错就是违反作者意图。
 *   2 current_state        当前状态：本章场景/蓝图/角色当前状态/正典切片。
 *   3 chapter_contract     章节契约：本章必须达成什么。
 *   4 recent_facts         近期事实：事件账本、前文衔接、已发生的事实。
 *   5 high_relevance_recall 高相关召回：语义检索命中的旧内容。
 *   6 background           普通背景：世界观、词条、关系等长期不变的信息。
 *
 * ⚠ 这条带序**不参与预算裁剪**（裁剪仍由 FLEX_ORDER 决定）。把它做成第二套裁剪规则，
 *    等于背着契约偷偷改变默认生成路径的上下文构成——质量红线明确禁止。
 */

const str = (v) => String(v || '');

export const PRIORITY_BANDS = [
  { id: 'hard_constraint', rank: 1, label: '硬约束', why: '写错就是违反作者意图（红线 / 连续性硬要求）' },
  { id: 'current_state', rank: 2, label: '当前状态', why: '写错的直接后果是"这一章就跟前面接不上"' },
  { id: 'chapter_contract', rank: 3, label: '章节契约', why: '本章必须达成什么、不得出现什么' },
  { id: 'recent_facts', rank: 4, label: '近期事实', why: '刚发生的事被当成没发生，是长篇最常见的崩法' },
  { id: 'high_relevance_recall', rank: 5, label: '高相关召回', why: '只有命中的旧内容才值得占位置' },
  { id: 'background', rank: 6, label: '普通背景', why: '长期不变的信息，缺一节不影响本章成文' },
];

export const BAND_IDS = PRIORITY_BANDS.map((b) => b.id);
const RANK = Object.fromEntries(PRIORITY_BANDS.map((b) => [b.id, b.rank]));

/**
 * 层规格里的每一层 → 优先级带。**每一层都必须有归属**——缺一个会被
 * `.p1-baseline/verify-layer-constants.mjs` 的 E 组派生断言当场报出来。
 *
 * ⚠️ 2026-10-08 订正：这张表此前停在 14 层，而 `layers.mjs` 早已加到 18 层，
 * 缺的 `library` / `edit_rules` / `author_intent` 三层**长期无人发现**——
 * 因为唯一能发现它的判据 `verifyBandCoverage()` 从来没有被调用过
 * （"实现了没启用"的典型；同一条教训：护栏写了不接线，等于没写）。
 */
export const LAYER_BAND = {
  work: 'current_state',
  outline: 'background',
  memory: 'recent_facts',
  recall: 'high_relevance_recall',
  events: 'recent_facts',
  foreshadows: 'chapter_contract',
  scene: 'current_state',
  blueprint: 'current_state',
  story_tail: 'recent_facts',
  characters: 'current_state',
  relations: 'background',
  world: 'background',
  terms: 'background',
  redlines: 'hard_constraint',
  story_state: 'chapter_contract',
  // 门控层（作品显式打开开关后才存在）同样要有归属，否则"带序表与层表脱节"
  // 会等到开关被打开的那一刻才暴露。
  library: 'high_relevance_recall',   // 只在命中时才占位置，与召回同性质
  edit_rules: 'hard_constraint',      // 保护规则/档位：写错就是违反作者意图
  author_intent: 'hard_constraint',   // 作者长期方向与本章意图；hard_constraint 的定义即"写错就是违反作者意图"
};

/** story_state 层的子块（顺序即渲染顺序，内部按带序排列）。 */
export const STORY_STATE_BLOCKS = [
  { id: 'hard_rules', band: 'hard_constraint', title: '硬约束（不得违背）' },
  { id: 'canon', band: 'current_state', title: '正典切片（当前成立的事实）' },
  { id: 'timeline', band: 'recent_facts', title: '时间线（已发生的顺序）' },
  { id: 'contract', band: 'chapter_contract', title: '本章契约' },
  { id: 'knowledge', band: 'current_state', title: '角色知识边界（此时点）' },
  { id: 'foreshadows', band: 'chapter_contract', title: '伏笔状态（未回收）' },
  { id: 'planned', band: 'recent_facts', title: '已安排但尚未发生（不得当作已发生叙述）' },
];

export function bandOfLayer(layerId) {
  return LAYER_BAND[str(layerId)] || 'background';
}

export function rankOfBand(bandId) {
  return RANK[str(bandId)] || 99;
}

export function bandLabel(bandId) {
  const b = PRIORITY_BANDS.find((x) => x.id === bandId);
  return b ? b.label : '';
}

/**
 * 给既有层加语义元数据（**附加式**：只在层对象上挂一个 `semantic` 字段，
 * 不改变 text / cap / id / label，因此装配结果与清单字段不受影响）。
 */
export function annotateSemantic(layers = []) {
  return layers.map((l) => {
    const band = bandOfLayer(l && l.id);
    return {
      ...l,
      semantic: {
        band,
        rank: rankOfBand(band),
        band_label: bandLabel(band),
        visible_scope: l && l.visibleScope ? l.visibleScope : 'as-provided',
      },
    };
  });
}

/** 按带序排序子块（同带内保持声明顺序，保证渲染确定性）。 */
export function orderBlocks(blocks = []) {
  return blocks
    .map((b, i) => ({ b, i }))
    .sort((x, y) => rankOfBand(x.b.band) - rankOfBand(y.b.band) || x.i - y.i)
    .map((x) => x.b);
}

/**
 * 组装 story_state 层的正文。
 *
 * 输入是**已经算好**的各块文本（本模块不做检索、不碰数据库）：
 *   { contract_text, canon_text, planned_text, timeline_text, knowledge_text, foreshadow_text, hard_rules_text }
 *
 * 只输出非空块；空块连标题都不出现——空标题会让模型以为"这一类信息不存在"，
 * 而实际是"这次没有"。
 */
export function buildStoryStateText(blocks = {}) {
  const rendered = [];
  for (const spec of orderBlocks(STORY_STATE_BLOCKS)) {
    const text = str(blocks[spec.id]).trim();
    if (!text) continue;
    rendered.push(`〔${spec.title}〕\n${text}`);
  }
  return rendered.join('\n\n');
}

/** 子块的元数据（给清单用：每个块属于哪条带、有多大）。 */
export function blockManifest(blocks = {}) {
  return orderBlocks(STORY_STATE_BLOCKS).map((spec) => {
    const text = str(blocks[spec.id]).trim();
    return {
      id: spec.id,
      band: spec.band,
      rank: rankOfBand(spec.band),
      title: spec.title,
      emitted: text.length,
      empty: text.length === 0,
    };
  });
}

/**
 * 可见性过滤：只保留在当前游标处**看得见**的条目。
 * 这是"不得把未来数据泄漏到当前章节"在语义上下文这一侧的落点。
 *
 * @param {Array} entries 带 effective_from / effective_to / chapter_index 的条目
 * @param {{chapter_index:number}} cursor
 */
export function visibleOnly(entries = [], cursor) {
  const at = Number(cursor && cursor.chapter_index) || 0;
  return entries.filter((e) => {
    if (!e) return false;
    const from = Number(e.effective_from ?? e.chapter_index ?? 0) || 0;
    if (from > at) return false;
    const to = e.effective_to;
    if (to !== null && to !== undefined && Number(to) <= at) return false;
    return true;
  });
}

/**
 * 语义索引项的形状（供 store 侧构建检索用，不实现检索本身）。
 * `text` 必须是可以直接展示的片段；`ref` 指回真实来源，便于"凡召回必可查回"。
 */
export function semanticItem({ id, kind, text, ref, chapter_index, band, score = 0 } = {}) {
  return {
    id: id ?? null,
    kind: str(kind),
    text: str(text),
    ref: ref ?? null,
    chapter_index: Number(chapter_index) || 0,
    band: BAND_IDS.includes(str(band)) ? str(band) : 'background',
    rank: rankOfBand(band),
    score: Number(score) || 0,
  };
}

/** 按 (带序, 分数降序, id 升序) 排序：同分也要有确定顺序，否则装配结果不可复现。 */
export function orderSemanticItems(items = []) {
  return items.slice().sort((a, b) => rankOfBand(a.band) - rankOfBand(b.band)
    || (b.score - a.score)
    || (Number(a.id) || 0) - (Number(b.id) || 0));
}

/**
 * 语义上下文的自检：每个既有层都要有带归属、每个子块都要有带归属。
 * 返回 `ok:false` 表示带序表与层表脱节了——那是**配置缺陷**，必须立刻可见。
 */
export function verifyBandCoverage(existingLayerIds = []) {
  const missing = existingLayerIds.filter((id) => !LAYER_BAND[id]);
  const blocksWithoutBand = STORY_STATE_BLOCKS.filter((b) => !BAND_IDS.includes(b.band)).map((b) => b.id);
  const problems = [];
  if (missing.length) problems.push({ code: 'LAYER_WITHOUT_BAND', ids: missing });
  if (blocksWithoutBand.length) problems.push({ code: 'BLOCK_WITHOUT_BAND', ids: blocksWithoutBand });
  return { ok: problems.length === 0, problems };
}