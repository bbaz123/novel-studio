/**
 * ai/quality-auditor/prop-continuity.mjs —— 道具持有状态与声音载体的**确定性线索**（零计费）。
 *
 * 依据：docs/quality-audit-p0-merge-protection-plan-20261022.md §2 与 §8 的 AUD-08 / AUD-09。
 *
 * AUD-08 的现场形态（作者真实正文）：
 *   前文「他把纸对折，再对折，折成四分之一大小，塞进校服裤兜。」
 *   随后「'D。'岳宸炎晃了晃手里的东西。」
 *   中间**没有**"拿出来"的动作 → 纸在兜里，人却晃着"手里的东西"。这不是文笔问题，是状态不连续。
 *
 * AUD-09 的形态：系统声先前被描述成直接在耳边出现，后文突然写"耳机里安安静静的"，
 *   而正文从未说他戴上耳机 → 载体不明。这种**不能**当成硬伤（可能前面写过、也可能他就是戴着），
 *   只能标 NEED_CONTEXT 让人去核验。
 *
 * 为什么是"线索"而不是"结论"：这两条判据是**词面模式**，会漏（同义改写）也会误命中（比喻）。
 * 所以它们只做两件事：① 在花钱之前告诉作者"这里可能有状态不连续"；② 作为待核验线索交给盲审，
 * 让人（和模型）去看，而不是直接把正文判成错。
 */

const STOW_RE = /(塞进|放进|揣进|收进|装进|放入|收好|揣好)[^。！？；\n]{0,12}(兜|口袋|包里|书包|抽屉|背包)/;
const HOLD_RE = /(晃了晃|举起来|举起|掏出|拿出|取出|摸出|拎起|握着|捏着|晃着手里的)[^。！？；\n]{0,14}(手里的|手上|手中|东西)/;
const RELEASE_RE = /(掏出|拿出|取出|摸出|抽出来|从[^。！？；\n]{0,8}(兜|口袋|包里|书包)[^。！？；\n]{0,6}(掏|拿|取|摸))/;
const EAR_RE = /(耳边|耳边响起|直接在耳边|耳畔)/;
const HEADPHONE_RE = /(耳机)/;

const str = (v) => String(v == null ? '' : v);
const clip = (s, n = 60) => str(s).replace(/\s+/g, ' ').slice(0, n);

/** 切成句子（保留标点前的原文，便于当逐字证据）。 */
function sentencesOf(text) {
  const out = [];
  const s = str(text);
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if ('。！？；\n'.includes(ch)) {
      const piece = s.slice(start, i + 1).trim();
      if (piece) out.push({ text: piece, index: start });
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) out.push({ text: tail, index: start });
  return out;
}

/**
 * 道具持有状态不连续（AUD-08）。
 *
 * @returns {Array<{code:string, prop:string, stow:{quote:string,index:number}, hold:{quote:string,index:number}, evidence:string[], note:string}>}
 */
export function propStateConflictsOf(text) {
  const list = sentencesOf(text);
  const out = [];
  let pending = null; // 最近一次"收起来"的位置
  for (const s of list) {
    if (RELEASE_RE.test(s.text)) { pending = null; continue; }
    const stow = s.text.match(STOW_RE);
    if (stow) {
      // 道具名取"动作之前那段"（"…折成四分之一大小，塞进校服裤兜"→「四分之一大小」太难读，
      // 所以只取紧邻动词前的一小段并清掉标点；取不到就退回方位词）。
      const before = str(s.text).slice(0, stow.index).replace(/[，。！？；、\s]+$/, '');
      const prop = clip(before.slice(-10).replace(/^[，。！？；、\s]+/, ''), 10) || clip(stow[2], 6);
      pending = { quote: s.text, index: s.index, prop };
      continue;
    }
    const hold = s.text.match(HOLD_RE);
    if (hold && pending) {
      // 没有"拿出来"的动作，却在说"手里的东西" → 状态不连续（待人确认）。
      out.push({
        code: 'POSSIBLE_OBJECT_STATE_CONFLICT',
        prop: pending.prop,
        stow: { quote: pending.quote, index: pending.index },
        hold: { quote: s.text, index: s.index },
        evidence: [pending.quote, s.text],
        note: `「${pending.prop}」先被收起来（${clip(pending.quote, 28)}），之后直接出现"手里的东西"（${clip(s.text, 28)}），中间没有"拿出来"的动作`,
      });
      pending = null;
    }
  }
  return out;
}

/**
 * 声音载体不明（AUD-09）：先前写"在耳边"，后文出现"耳机"，中间没提戴耳机。
 * 只提示核验，**不**断言硬冲突。
 *
 * @returns {Array<{code:string, evidence:string[], note:string}>}
 */
export function soundCarrierHints(text) {
  const list = sentencesOf(text);
  const out = [];
  let sawEar = false;
  let sawHeadphone = false;
  let earQuote = '';
  let hpQuote = '';
  for (const s of list) {
    if (!sawEar && EAR_RE.test(s.text)) { sawEar = true; earQuote = s.text; }
    if (sawEar && HEADPHONE_RE.test(s.text)) { sawHeadphone = true; hpQuote = s.text; break; }
  }
  if (sawEar && sawHeadphone) {
    out.push({
      code: 'NEED_CONTEXT_SOUND_CARRIER',
      evidence: [earQuote, hpQuote],
      note: '声音先前被描述成在耳边直接出现，后文却写"耳机里"：正文没交代载体，需核验（可能前面写过，也可能只是比喻）',
    });
  }
  return out;
}

/**
 * 全部线索（按严重度排序：状态不连续在前，载体不明在后）。
 * @returns {{conflicts:Array, hints:Array, total:number}}
 */
export function auditLeadHintsOf(text) {
  const conflicts = propStateConflictsOf(text);
  const hints = soundCarrierHints(text);
  return { conflicts, hints, total: conflicts.length + hints.length };
}
