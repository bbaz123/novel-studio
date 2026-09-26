/**
 * 确定性故事状态内核 · 门面（唯一对外入口）。
 *
 * 为什么要有门面：内核有 10 个模块，消费方（server.js / 测试 / 插件侧探测脚本）如果各自
 * 从不同文件 import，重构时就会出现"改了 A、B 还在用旧路径"的漂移。这里把**对外承诺**的
 * 面收成一处：纯函数模块 + 存储层 + 两个组合入口。
 *
 * 组合入口：
 *   compositionOf(workId, chapterId) —— 一次取齐"装配 story_state 层"与"跑预检/校验"
 *     所需要的全部状态（含派生视图）。**只读**，不改任何东西。
 *
 * ⚠ 性能纪律：`compositionOf` 只在作品开关打开时才被 server.js 调用
 * （未开启的作品连一次查询都不会发生，保证默认路径零开销）。
 */

export * from './hash.mjs';
export * from './timeline.mjs';
export * from './knowledge.mjs';
export * from './entities.mjs';
export * from './canon.mjs';
export * from './foreshadow.mjs';
export * from './contract.mjs';
export * from './state-machine.mjs';
export * from './injection.mjs';
export * from './semantic-context.mjs';
export * from './style-quality.mjs';
export * from './proposal.mjs';
export * from './preflight.mjs';
// 存储层也走星号导出：调用方（server.js / 探测脚本）只认这一个入口，
// 免得出现「改了 store 的导出名、某个调用方还在用旧名」这种只有运行时才炸的漂移。
export * from './store.mjs';

import { buildAliasIndex } from './entities.mjs';
import { deriveForeshadows, renderForeshadowLines } from './foreshadow.mjs';
import { projectCanon, renderCanonLines } from './canon.mjs';
import { buildTimelineView, ordinal } from './timeline.mjs';
import { knowledgeOf } from './knowledge.mjs';
import { checkContract, renderContractSection, isCheckable } from './contract.mjs';
import { buildStoryStateText, blockManifest, visibleOnly } from './semantic-context.mjs';
import { scanInjection, wrapAsData } from './injection.mjs';
import { preflight as preflightCore } from './preflight.mjs';
import {
  readFacts, readTimeline, readKnowledge, readEntities, readForeshadows, readContract,
  chapterIndexOf, isEnabled, readState, stateHash,
} from './store.mjs';

/**
 * 取齐一部作品在某一章的**完整只读视图**。
 *
 * @returns {null|object} 作品开关关闭时返回 null——调用方据此**完全跳过**这一段逻辑，
 *   保证未开启的作品不产生任何额外查询（也就不会有任何行为变化）。
 */
export function compositionOf(workId, chapterId) {
  const w = Number(workId);
  if (!w) return null;
  if (!isEnabled(w)) return null;
  const chapterIndex = chapterId ? chapterIndexOf(chapterId) : 0;
  const cursor = { chapter_index: chapterIndex, scene_index: null, chapter_id: chapterId ?? null };

  const facts = readFacts(w);
  const timeline = readTimeline(w);
  const knowledge = readKnowledge(w);
  const entities = readEntities(w);
  const { items: foreshadows, eventsById } = readForeshadows(w);
  const contract = chapterId ? readContract(chapterId) : null;

  const derived = deriveForeshadows(foreshadows, { cursor, eventsById });
  const projection = projectCanon(facts, cursor);
  const timelineView = buildTimelineView(timeline, cursor);
  const aliasIndex = buildAliasIndex(entities, entities.flatMap((e) => (e.aliases || []).map((a) => ({ ...a, entity_id: e.id }))));

  return {
    work_id: w,
    chapter_id: chapterId ?? null,
    cursor,
    chapter_index: chapterIndex,
    facts,
    timeline,
    knowledge,
    entities,
    foreshadows,
    eventsById,
    contract,
    derived,
    projection,
    timelineView,
    aliasIndex,
  };
}

/**
 * 组装 story_state 层的正文（供 server.js 在开关打开时推入层列表）。
 *
 * 返回的 `text` 已按优先级带排好；`blocks` 是子块清单（供 manifest 的 scores/note 使用）。
 * 只包含**当前章节看得见**的条目——未来事实一个都不放（visibleOnly 兜底）。
 */
export function storyStateLayerOf(comp, { maxChars = 4000 } = {}) {
  if (!comp) return { text: '', blocks: [], meta: {} };
  const visibleFacts = visibleOnly(comp.facts, comp.cursor);
  const projection = comp.projection;

  const canon = renderCanonLines(projection);
  const blocks = {
    canon: canon.canon_text,
    planned: canon.planned_text,
    // 时间线一行：**只保留真正有内容的段**（章/场 · 故事时间 · 标签）。
    // 不绑定章节的条目（chapter_index<=0）不再渲染成「第0章」：那既不是事实，也会在上下文里留一条「第0章｜」的噪声。
    timeline: comp.timelineView.visible.slice(0, 40)
      .map((t) => {
        // 章/场都是 0 基下标，展示必须 +1（见 timeline.mjs 的 ordinal）；
        // 未绑定章节的条目（chapter_id 为空）不谎称章号。
        const sceneIndex = Number(t.scene_index) || 0;   // 本文件没有 num()：就地转数，避免依赖未定义符号
        const sceneOrd = sceneIndex > 0 ? ordinal(sceneIndex) : null;
        const head = (t.chapter_id === null || t.chapter_id === undefined)
          ? (sceneOrd ? `第${sceneOrd}场` : '')
          : `第${ordinal(t.chapter_index)}章${sceneOrd ? `第${sceneOrd}场` : ''}`;
        const when = t.story_time || t.relative_time || '';
        return [head, when, t.label ? String(t.label) : '']
          .filter((seg) => seg !== '' && seg !== null && seg !== undefined)
          .join('｜');
      })
      .filter((line) => line !== '')
      .join('\n'),
    knowledge: renderKnowledgeLines(comp),
    foreshadows: renderForeshadowLines(comp.derived),
    contract: comp.contract ? renderContractSection(comp.contract, { includeStyle: false }) : '',
    hard_rules: renderHardRules(comp),
  };
  let text = buildStoryStateText(blocks);
  let truncated = false;
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  const scan = scanInjection(text, { label: 'story_state' });
  return {
    text,
    truncated,
    blocks: blockManifest(blocks),
    injection: scan,
    meta: {
      facts_total: comp.facts.length,
      facts_visible: visibleFacts.length,
      canon_count: projection.canon.length,
      planned_count: projection.planned.length,
      future_excluded: projection.future.length,
      timeline_visible: comp.timelineView.visible.length,
      timeline_leaks: comp.timelineView.leaks.length,
      foreshadows: comp.derived.byState,
      contract_version: comp.contract ? comp.contract.version : null,
      contract_hash: comp.contract ? comp.contract.contract_hash : '',
      alias_conflicts: comp.aliasIndex.conflicts.length,
    },
  };
}

function renderKnowledgeLines(comp) {
  const lines = [];
  const byCharacter = new Map();
  for (const k of comp.knowledge) {
    if (!byCharacter.has(String(k.character_id))) byCharacter.set(String(k.character_id), []);
    byCharacter.get(String(k.character_id)).push(k);
  }
  for (const [cid, rows] of byCharacter) {
    const name = rows[0].character_name || `#${cid}`;
    const view = knowledgeOf(rows, cid, comp.cursor);
    const parts = [];
    if (view.known.length) parts.push(`知道：${view.known.slice(0, 8).map((k) => k.fact_key).join('、')}`);
    if (view.unknown.length) parts.push(`**不知道**：${view.unknown.slice(0, 8).map((k) => k.fact_key).join('、')}`);
    if (view.suspected.length) parts.push(`只是怀疑：${view.suspected.slice(0, 8).map((k) => k.fact_key).join('、')}`);
    if (view.false_beliefs.length) parts.push(`误信（写作时须保持这个错）：${view.false_beliefs.slice(0, 8).map((k) => k.fact_key).join('、')}`);
    if (parts.length) lines.push(`${name}｜${parts.join('｜')}`);
  }
  return lines.join('\n');
}

function renderHardRules(comp) {
  const lines = [];
  // 「不得把未来写进现在」是硬约束：泄漏项必须在提示词里明说，否则模型不知道自己在越界
  for (const leak of comp.timelineView.leaks.slice(0, 8)) lines.push(`· ${leak.reason}`);
  for (const inv of comp.timelineView.inversions.slice(0, 8)) lines.push(`· ${inv.reason}`);
  for (const c of comp.aliasIndex.conflicts.slice(0, 6)) lines.push(`· ${c.reason}`);
  return lines.join('\n');
}

/**
 * 写前预检的组合入口（只读，不落库）。
 * 落库由调用方决定（`saveValidation`）——保持"预检"与"记录预检"两件事分开，
 * 这样作者反复看预检不会产生一堆记录。
 */
export function preflightOf(comp, { extraConflicts = [] } = {}) {
  if (!comp) return { ok: false, reason: '该作品未开启确定性故事状态（开关关闭时预检不运行）', risks: [], summary: { counts: {}, total: 0 } };
  const contract = comp.contract || {};
  const risks = [];
  if (!isCheckable(contract)) {
    risks.push({
      code: 'CONTRACT_REQUIRED_MISSING', level: 'medium', auto_fixable: false, requires_author_decision: true,
      reason: '本章还没有可核对的契约（只有目标或为空），写后校验将只能给出 unknown',
      evidence: { chapter_id: comp.chapter_id },
    });
  }
  const base = preflightCore({
    contract, cursor: comp.cursor, facts: comp.facts, timeline: comp.timeline,
    entities: comp.entities, knowledge: comp.knowledge, derivedForeshadows: comp.derived,
    conflicts: [
      ...comp.timelineView.leaks, ...comp.timelineView.inversions, ...comp.aliasIndex.conflicts, ...extraConflicts,
    ],
  });
  return { ...base, risks: [...risks, ...base.risks], summary: summarizeRisks([...risks, ...base.risks]) };
}

function summarizeRisks(risks) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of risks) counts[r.level] = (counts[r.level] || 0) + 1;
  return { counts, total: risks.length, blocking: counts.critical > 0 };
}


/**
 * 写后校验的组合入口。
 * `draft` 是候选正文；`stateChanges` 是本次拟入库的状态变化（用于契约的白/黑名单核对）。
 */
export function validateOf(comp, draft, { stateChanges = [], styleHits = [] } = {}) {
  if (!comp) return { ok: false, reason: '该作品未开启确定性故事状态（开关关闭时不运行写后校验）', checks: [], summary: { total: 0, pass: 0, fail: 0, unknown: 0 } };
  const contractResult = checkContract(comp.contract || {}, draft, { stateChanges, styleHits });
  const text = String(draft || '');
  const conflicts = [...comp.timelineView.leaks, ...comp.timelineView.inversions, ...comp.aliasIndex.conflicts];
  const projection = comp.projection;
  return {
    ok: true,
    contract: contractResult,
    checks: contractResult.checks,
    summary: contractResult.summary,
    passed: contractResult.passed,
    conflicts: conflicts.map((c) => ({ ...c })),
    counts: summarizeRisks(conflicts).counts,
    note: '写后校验只产生结论与证据，不自动改写正文。',
    draft_chars: text.length,
  };
}

export const STORY_STATE_VERSION = '1.0.0';