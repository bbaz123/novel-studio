/**
 * 确定性故事状态内核 · 写前预测校验（PHASE 5）。
 *
 * 与"写后校验"的分工：写后校验回答"这次成文有没有违背契约"；
 * 写前预检回答"**按现在的状态，这一章根本写不成**吗"——在花钱生成之前就把必然失败的情况挡下来。
 *
 * 预检**不阻断**生成（红线：不得仅因为某机制实现了就改变正常创作流程）。
 * 它的产出是**结构化风险清单 + 证据**，交给作者与编排层决定要不要先修状态/改契约。
 * 唯一会给出 `blocking: true` 的是"契约自相矛盾"这类无论怎么写都不可能同时满足的情况——
 * 即便如此，阻断与否仍由调用方决定（本模块只给结论）。
 *
 * 证据纪律：每条风险都必须带 `evidence`（是哪条事实/哪个 id/哪个章节点）。
 * 没有证据的风险项一律不报——那是猜测，不是预检。
 */

import { classifyConflict, summarizeConflicts, detectCanonConflicts, projectCanon, factKeyOf } from './canon.mjs';
import { detectOrderInversions, futureLeaks, ordinal } from './timeline.mjs';
import { foreshadowProblems } from './foreshadow.mjs';
import { normalizeName } from './entities.mjs';

const str = (v) => String(v || '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 契约自检（不依赖任何作品状态）：契约本身是否自相矛盾 / 是否为空。
 * 这一类问题必须在生成前解决——它们不是"状态没准备好"，而是"要求本身矛盾"。
 */
export function checkContractCoherence(contract = {}) {
  const out = [];
  const bodyHas = (t) => normalizeName(t);
  const beats = (contract.required_beats || []).map((b) => str(b.text)).filter(Boolean);
  const forb = (contract.forbidden_beats || []).map((b) => str(b.text)).filter(Boolean);
  for (const r of beats) {
    for (const f of forb) {
      const a = bodyHas(r); const b = bodyHas(f);
      if (!a || !b) continue;
      if (a === b) {
        out.push(classifyConflict({
          code: 'CONTRACT_REQUIRED_MISSING',
          subject: '契约自相矛盾',
          reason: `「${r}」同时出现在必须写到与禁止出现两栏——无论怎么写都无法同时满足`,
          evidence: { required: r, forbidden: f },
          blocking: true,
        }));
      } else if (a.includes(b) || b.includes(a)) {
        out.push(classifyConflict({
          code: 'CONTRACT_REQUIRED_MISSING',
          subject: '契约可能自相矛盾',
          reason: `必须写到的「${r}」与禁止出现的「${f}」在文字上互相包含，很可能无法同时满足`,
          evidence: { required: r, forbidden: f, overlap: a.includes(b) ? 'forbidden⊂required' : 'required⊂forbidden' },
          blocking: false,
        }));
      }
    }
  }
  const changeKeys = new Set((contract.forbidden_state_changes || []).map((x) => normalizeName(x.text)).filter(Boolean));
  for (const a of (contract.allowed_state_changes || [])) {
    const k = normalizeName(a.text);
    if (k && changeKeys.has(k)) {
      out.push(classifyConflict({
        code: 'CONTRACT_STATE_CHANGE_VIOLATION',
        subject: '契约自相矛盾',
        reason: `状态变化「${str(a.text)}」同时被允许与禁止`,
        evidence: { text: str(a.text) },
        blocking: true,
      }));
    }
  }
  return out;
}

/**
 * 写前预测。
 *
 * @param {object} input
 *   contract      已规范化的章节契约（contract.mjs 的 normalizeContract().contract）
 *   cursor        {chapter_index, scene_index}
 *   facts         正典事实（含未来与 planned）
 *   timeline      时间线条目
 *   foreshadows   Foreshadow 行（宿主 story_events 的 kind='foreshadow'）
 *   derivedForeshadows  派生视图（foreshadow.mjs 的 deriveForeshadows 结果，可选）
 *   entities      实体 + 别名（用于校验 required_entities 是否登记过）
 *   knowledge     角色知识行
 *   characters    角色表（id → 名称）
 *   conflicts     调用方已收集的冲突（可选，会一并计入）
 * @returns {{ok, risks, blocking, summary, cursor, evidence_index}}
 */
export function preflight(input = {}) {
  const contract = input.contract || {};
  const cursor = input.cursor || { chapter_index: 0, scene_index: null };
  const risks = [];

  // ① 契约自身
  if (!str(contract.chapter_goal)) {
    risks.push(classifyConflict({
      code: 'CONTRACT_REQUIRED_MISSING', subject: '契约不完整',
      reason: '契约没有 chapter_goal——没有目标就无法判断这一章该不该结束',
      evidence: { field: 'chapter_goal' },
    }));
  }
  risks.push(...checkContractCoherence(contract));

  // ② 时间线
  const timeline = input.timeline || [];
  if (timeline.length) {
    const leaks = futureLeaks(timeline, cursor);
    for (const l of leaks) risks.push(classifyConflict(l));
    for (const inv of detectOrderInversions(timeline)) risks.push(classifyConflict(inv));
  }

  // ③ 正典
  const facts = input.facts || [];
  const projection = facts.length ? projectCanon(facts, cursor) : { canon: [], planned: [], retracted: [], future: [], excluded: [] };
  if (facts.length) {
    for (const c of detectCanonConflicts(facts, cursor, { referenced: contract.required_entities ? [] : [] })) risks.push(c);
  }

  // ④ 必须出场的实体是否登记过（没登记 → 别名解析不到，模型可能写成另一个人）
  const entities = input.entities || [];
  const aliasNames = new Set(entities.flatMap((e) => [normalizeName(e.canonical_name), ...(e.aliases || []).map((a) => normalizeName(a.alias))]));
  for (const [i, req] of (contract.required_entities || []).entries()) {
    const name = str(req.text || req.name);
    if (!name) continue;
    const known = req.entity_id !== undefined && req.entity_id !== null
      ? entities.some((e) => String(e.id) === String(req.entity_id))
      : aliasNames.has(normalizeName(name));
    if (!known) {
      risks.push(classifyConflict({
        code: 'CONTRACT_REQUIRED_MISSING',
        subject: name,
        reason: `契约要求「${name}」出场，但它没有登记为实体——模型无法判断它与既有角色是不是同一个人，容易出现"同人异名"`,
        evidence: { index: i + 1, name },
      }));
    }
  }

  // ⑤ 必须发生的事件是否已作为 planned 记录（没安排过 → 这一章可能无处落脚）
  const plannedKeys = new Set(projection.planned.map((f) => factKeyOf(f)));
  const plannedText = projection.planned.map((f) => normalizeName(`${f.subject}${f.predicate}${f.value}`)).join('|');
  for (const [i, ev] of (contract.required_events || []).entries()) {
    const text = str(ev.text);
    if (!text) continue;
    const named = normalizeName(text);
    const registered = plannedKeys.size && [...plannedKeys].some((k) => k.includes(named.slice(0, 6)))
      || (plannedText && plannedText.includes(named.slice(0, 4)));
    if (!registered && num(ev.event_id) === 0) {
      risks.push(classifyConflict({
        code: 'CONTRACT_REQUIRED_MISSING',
        subject: text,
        reason: `契约要求发生「${text}」，但状态里没有对应的安排（planned）——要么先补安排，要么这一章会写到一半没处落脚`,
        evidence: { index: i + 1, text },
      }));
    }
  }

  // ⑥ 伏笔
  const derived = input.derivedForeshadows || { items: [] };
  for (const p of foreshadowProblems(derived)) risks.push(classifyConflict(p));
  const targetIds = new Set((contract.foreshadow_targets || []).map((t) => str(t.foreshadow_id)).filter(Boolean));
  for (const it of derived.items || []) {
    if (it.state === 'mis_resolved' && targetIds.has(String(it.id))) {
      risks.push(classifyConflict({
        code: 'FORESHADOW_MIS_RESOLVED', foreshadow_id: it.id,
        reason: `契约要求照顾伏笔 #${it.id}，但它的回收状态站不住：${it.reason}`,
        evidence: it.evidence,
      }));
    }
  }

  // ⑦ 知识边界：契约要求出场且需要知情，但角色此时点还不知道
  const knowledge = input.knowledge || [];
  const characters = input.characters || [];
  for (const k of knowledge) {
    if (str(k.state) !== 'unknown') continue;
    const learned = num(k.learned_chapter_index);
    if (learned <= num(cursor.chapter_index)) continue;
    const name = str(k.character_name) || (characters.find((c) => String(c.id) === String(k.character_id)) || {}).name || '';
    if (!name) continue;
    const mentioned = (contract.required_entities || []).some((e) => normalizeName(str(e.text || e.name)) === normalizeName(name));
    if (mentioned) {
      risks.push(classifyConflict({
        code: 'KNOWLEDGE_VIOLATION',
        reason: `契约要求「${name}」出场，但他在第 ${ordinal(cursor.chapter_index)} 章之前明确不知道「${str(k.fact_key)}」（第 ${ordinal(learned)} 章才知道）——写入时容易越界`,
        evidence: { character_id: k.character_id, fact_key: str(k.fact_key), learned_chapter_index: learned, cursor: num(cursor.chapter_index) },
      }));
    }
  }

  // ⑧ 调用方已收集的冲突
  for (const c of (input.conflicts || [])) risks.push(classifyConflict(c));

  const deduped = dedup(risks);
  const summary = summarizeConflicts(deduped);
  return {
    ok: true,
    cursor,
    risks: deduped,
    blocking: deduped.some((r) => r.blocking === true || r.level === 'critical'),
    summary,
    counts: summary.counts,
    note: '预检只给结论与证据，不阻断生成；是否先修状态由作者或编排层决定。',
  };
}

function dedup(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = `${c.code}|${str(c.reason)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * 预检结论 → 给模型/作者看的一段文本。
 * **明确标注"这是预测，不是事实"**：否则模型会把预检的推测当成已发生的事写进正文。
 */
export function renderPreflight(risks = []) {
  if (!risks.length) return '';
  const byLevel = { critical: [], high: [], medium: [], low: [], info: [] };
  for (const r of risks) (byLevel[r.level] || byLevel.info).push(r);
  const lines = ['（写前预检 · 预测，不是已发生的事实）'];
  for (const lvl of ['critical', 'high', 'medium', 'low', 'info']) {
    if (!byLevel[lvl].length) continue;
    lines.push(`${lvl.toUpperCase()}：`);
    for (const r of byLevel[lvl].slice(0, 12)) lines.push(`  · ${r.reason}${r.requires_author_decision ? '〔需作者决定〕' : ''}`);
  }
  return lines.join('\n');
}