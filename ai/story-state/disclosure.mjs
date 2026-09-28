/**
 * disclosure.mjs —— R10「作者真相 / 读者已披露 / 各角色掌握」派生视图。
 *
 * 边界（写清楚才不会长成第二套状态体系）：
 *   - **不新增表、不写任何行**：只读 story_facts / character_knowledge / chapters，按当前章（场景）派生。
 *   - **没有缓存**：每次调用重算，所以章节重排 / 插入早期章 / 回滚 / retcon / 删除事实之后，
 *     视图必然重算（响应里的 fingerprint 变化可核对，"沿用失效缓存"在结构上不可能）。
 *   - CANON_KNOWLEDGE **不改名**为"读者已知"：它是"故事世界里成立的事实"；读者是否已经读到，
 *     还要看证据（事实挂在哪个章、那一章是否已写、effective_from 是否已到）。
 *   - AUTHOR_KNOWLEDGE 是**作者真相**，不是角色可行动知识：生成 POV 行为只能用「角色掌握」。
 *   - 没有任何记录的条目是「未定义」：既不算知道，也不算不知道；没有证据的隐藏真相保持 unknown。
 */
import { normalizeFact, factKeyOf } from './canon.mjs';
import { knowledgeOf } from './knowledge.mjs';
import { sha16, stableStringify } from './hash.mjs';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 派生口径（随视图一起返回，作者/模型都能核对"为什么它算已披露"）。 */
export const DISCLOSURE_RULES = Object.freeze({
  time: '章下标与 effective_from/to 都是 0 基（0 = 第一章）；展示给作者/模型时 +1。',
  effective_window: '在窗口内 ⇔ effective_from ≤ 当前章下标 且（effective_to 为空 或 effective_to > 当前章下标）。',
  scene: '场景语义只作用于角色知识行（learned_scene_index ≤ 当前场景下标）；不给场景时按章级最宽口径。',
  reader_disclosed: '读者已披露 ⇔ 非 AUTHOR_KNOWLEDGE、state=known、status=established、在窗口内，且证据章是**已写**章节且章下标 ≤ 当前章。',
  author_truth: '作者真相 = 已登记的非撤回条目（含 AUTHOR_KNOWLEDGE、计划、未到时点、私有条目）；可用于审稿与伏笔一致性，但不等于任何角色可行动知识。',
  character: '角色掌握 = character_knowledge 行（state=known 且在学时点之后才进 known；unknown/suspected/false_belief 分开列）+ 角色私有事实（scope=CHARACTER_KNOWLEDGE 且 holder_id=该角色）。',
  undetermined: '没有任何知识记录的条目是「未定义」：既不算知道也不算不知道（界面/模型都不得替作者决定）。',
  pov: '生成 POV 行为只能用「角色掌握」里 known 的条目；作者真相与读者披露都不构成角色可行动知识。',
});

/** 事实的可读标签（界面与工具共用同一份，避免两处各写一套）。 */
export function factLabelOf(fact) {
  const f = fact && fact.subject !== undefined ? fact : normalizeFact(fact || {});
  const label = [f.subject, f.predicate, f.value].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  return label || `#${f.id}`;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * 派生三档视图。
 *
 * @param {object} input
 *   facts      story_facts 行
 *   knowledge  character_knowledge 行
 *   chapters   [{ id, index, written }]——index 是 0 基章下标；written=false 表示该章还没有正文
 *   characters [{ id, name }]
 *   cursor     { chapter_index, scene_index, chapter_id }
 *   character_id  可选：只算这个角色（界面按角色查看）
 */
export function deriveDisclosure({
  facts = [], knowledge = [], chapters = [], characters = [], cursor = {}, character_id = null,
} = {}) {
  const ci = num(cursor.chapter_index);
  const scene = cursor.scene_index === null || cursor.scene_index === undefined ? null : num(cursor.scene_index);
  const chapterIndex = new Map();
  const chapterWritten = new Map();
  for (const c of chapters) {
    chapterIndex.set(String(c.id), num(c.index));
    chapterWritten.set(String(c.id), c.written !== false);
  }
  const all = facts.map((r) => normalizeFact(r));
  const indexOfEvidence = (f) => (f.chapter_id === null || f.chapter_id === undefined || !chapterIndex.has(String(f.chapter_id))
    ? null : chapterIndex.get(String(f.chapter_id)));
  const inWindow = (f) => f.effective_from <= ci && (f.effective_to === null || f.effective_to > ci);
  const hasEvidence = (f) => (f.chapter_id !== null && f.chapter_id !== undefined) || f.source_event_id !== null && f.source_event_id !== undefined || !!String(f.story_time || '').trim();
  const evidenceWritten = (f) => {
    const idx = indexOfEvidence(f);
    return idx !== null && idx <= ci && chapterWritten.get(String(f.chapter_id)) !== false;
  };
  const isDead = (f) => f.status === 'retracted' || f.status === 'superseded' || (f.superseded_by !== null && f.superseded_by !== undefined);

  const items = all.map((f) => {
    const item = {
      id: f.id, key: factKeyOf(f), label: factLabelOf(f), scope: f.scope, state: f.state, status: f.status,
      effective_from: f.effective_from, effective_to: f.effective_to, holder_id: f.holder_id,
      no_evidence: !hasEvidence(f),
      evidence: {
        chapter_id: f.chapter_id, chapter_index: indexOfEvidence(f), written: evidenceWritten(f),
        source_event_id: f.source_event_id, story_time: f.story_time,
      },
      tier: 'unknown',
    };
    if (isDead(f)) item.tier = 'retracted';
    else if (f.status === 'planned') item.tier = 'author_plan';
    else if (f.state !== 'known') item.tier = 'belief';
    else if (f.scope === 'AUTHOR_KNOWLEDGE') item.tier = 'author_truth';
    else if (f.effective_to !== null && f.effective_to <= ci) item.tier = 'window_closed';
    else if (!inWindow(f)) item.tier = 'future';
    else if (!evidenceWritten(f)) item.tier = 'not_yet_disclosed';
    else if (f.scope === 'CHARACTER_KNOWLEDGE') item.tier = 'character_private';
    else item.tier = 'reader_disclosed';
    return item;
  });
  const ofTier = (t) => items.filter((x) => x.tier === t);
  const ids = (list) => list.map((x) => x.id);
  const readerDisclosed = ofTier('reader_disclosed');

  const charIds = character_id !== null && character_id !== undefined && character_id !== ''
    ? [character_id]
    : characters.map((c) => c.id);
  const characterViews = charIds.map((id) => {
    const cid = String(id);
    const view = knowledgeOf(knowledge, id, { chapter_index: ci, scene_index: scene });
    const rowsOf = (rows) => rows.map((k) => ({
      id: k.id, fact_id: k.fact_id, fact_key: k.fact_key, state: k.state,
      learned_chapter_index: k.learned_chapter_index, learned_scene_index: k.learned_scene_index,
      story_time: k.story_time, note: k.note,
      source: (all.find((f) => String(f.id) === String(k.fact_id)) ? 'explicit_fact' : 'explicit_key'),
    }));
    const holderFacts = all.filter((f) => !isDead(f) && f.status !== 'planned' && f.state === 'known'
      && f.scope === 'CHARACTER_KNOWLEDGE' && String(f.holder_id) === cid && inWindow(f) && hasEvidence(f));
    const explicitKnown = rowsOf(view.known);
    const explicitKeys = new Set();
    for (const k of knowledge.filter((x) => String(x.character_id) === cid)) {
      if (k.fact_id !== null && k.fact_id !== undefined) explicitKeys.add(`f${k.fact_id}`);
      if (k.fact_key) explicitKeys.add(`k${String(k.fact_key)}`);
    }
    const holderKnown = holderFacts.map((f) => ({ fact_id: f.id, fact_key: factKeyOf(f), state: 'known', label: factLabelOf(f), source: 'holder_fact' }));
    const undetermined = readerDisclosed.filter((it) => !explicitKeys.has(`f${it.id}`) && !explicitKeys.has(`k${it.key}`));
    const knownIds = [
      ...holderKnown.map((x) => x.fact_id),
      ...explicitKnown.map((x) => x.fact_id).filter((x) => x !== null && x !== undefined),
    ];
    return {
      character_id: id,
      name: (characters.find((c) => String(c.id) === cid) || {}).name || `#${id}`,
      known: [...holderKnown, ...explicitKnown],
      known_ids: knownIds,
      holder_known_ids: holderKnown.map((x) => x.fact_id),
      unknown: rowsOf(view.unknown),
      suspected: rowsOf(view.suspected),
      false_beliefs: rowsOf(view.false_beliefs),
      undetermined: {
        count: undetermined.length,
        sample: undetermined.slice(0, 10).map((x) => x.label),
        ids: undetermined.slice(0, 20).map((x) => x.id),
      },
      actionable_ids: knownIds,
      note: DISCLOSURE_RULES.character,
    };
  });

  const view = {
    cursor: { chapter_index: ci, chapter_id: cursor.chapter_id ?? null, scene_index: scene },
    rules: { ...DISCLOSURE_RULES },
    items,
    author: {
      truth: ofTier('author_truth'),
      plan: ofTier('author_plan'),
      retracted: ofTier('retracted'),
      note: DISCLOSURE_RULES.author_truth,
    },
    reader: {
      disclosed: readerDisclosed,
      private_not_disclosed: ofTier('character_private'),
      not_yet: ofTier('not_yet_disclosed'),
      future: ofTier('future'),
      window_closed: ofTier('window_closed'),
      beliefs: ofTier('belief'),
      disclosed_ids: ids(readerDisclosed),
      note: DISCLOSURE_RULES.reader_disclosed,
    },
    characters: characterViews,
    unknown: {
      no_evidence_ids: items.filter((x) => x.no_evidence && x.tier !== 'retracted').map((x) => x.id),
      note: '没有证据（无章节、无来源事件、无故事时间）的条目保持 unknown：既不宣布"读者已知道"，也不宣布"角色知道"。',
    },
    counts: {
      facts: items.length,
      author_truth: ofTier('author_truth').length,
      author_plan: ofTier('author_plan').length,
      reader_disclosed: readerDisclosed.length,
      not_yet: ofTier('not_yet_disclosed').length,
      future: ofTier('future').length,
      window_closed: ofTier('window_closed').length,
      beliefs: ofTier('belief').length,
      character_private: ofTier('character_private').length,
      retracted: ofTier('retracted').length,
      no_evidence: items.filter((x) => x.no_evidence && x.tier !== 'retracted').length,
    },
  };
  view.fingerprint = disclosureFingerprint(view);
  return view;
}

/** 视图指纹：只覆盖会影响结论的部分（游标 / 每个条目的分层与窗口 / 角色可行动集合）。 */
export function disclosureFingerprint(view) {
  if (!view) return '';
  const core = {
    cursor: view.cursor,
    facts: (view.items || []).map((x) => [x.id, x.tier, x.state, x.status, x.scope, x.effective_from, x.effective_to, x.evidence && x.evidence.chapter_index, x.evidence && x.evidence.written]).sort(),
    characters: (view.characters || []).map((c) => [c.character_id, [...(c.actionable_ids || [])].sort(), (c.unknown || []).length, (c.suspected || []).length, (c.false_beliefs || []).length, c.undetermined && c.undetermined.count]).sort(),
  };
  return `disclosure-${sha16(stableStringify(clone(core)))}`;
}

/**
 * POV 护栏：某个角色在当前章可行动的条目（只有这里面的内容才允许写进他的行为理由）。
 * 刻意**不**含 AUTHOR_KNOWLEDGE 与读者披露：作者知道 ≠ 角色知道。
 */
export function povKnowledgeOf(view, characterId) {
  const c = (view && view.characters || []).find((x) => String(x.character_id) === String(characterId));
  if (!c) return { character_id: characterId, known_ids: [], actionable_ids: [], note: '该角色没有任何已知/可行动条目（未定义不等于不知道）。' };
  return {
    character_id: c.character_id,
    known_ids: c.known_ids,
    actionable_ids: c.actionable_ids,
    unknown: c.unknown,
    suspected: c.suspected,
    false_beliefs: c.false_beliefs,
    undetermined: c.undetermined,
    note: DISCLOSURE_RULES.pov,
  };
}
