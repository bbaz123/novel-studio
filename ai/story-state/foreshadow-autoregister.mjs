/**
 * 伏笔自动登记（P1-3，v1.2.2）——把审稿 `deferred` 里的"疑似伏笔"落成**待确认候选**。
 *
 * 为什么单独做（《v1.2.1 审稿闭环方案》§9.1(3)）：审稿模型会把"陌生人的怀表"这类疑点
 * 放进 deferred（它不该被当成 issue），但作者随后很容易忘记；等到修稿删掉相关动作时，
 * 才发现那是伏笔。自动登记要解决的是"别忘"，**不是**"替作者认定伏笔"：
 *   · 只产生 `story_event_proposals` 的 pending 候选（作者确认后才成为事件）；
 *   · 幂等去重（同一归一化摘要同一 work 只登记一次）；
 *   · 每章有条数上限，避免一次审稿刷出几十条噪音。
 */

export const FORESHADOW_AUTOREGISTER_VERSION = 1;
export const MAX_AUTO_REGISTRATIONS_PER_CHAPTER = 10;

const text = (v) => String(v == null ? '' : v);

/** 归一化摘要：去控制字符、折叠空白、去首尾标点，用于去重与展示。 */
export function normalizeForeshadowSummary(raw) {
  return text(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[，。；、：:,.!?！？\s]+/, '')
    .replace(/[，。；、：:,.!?！？\s]+$/, '')
    .slice(0, 120);
}

/** 稳定去重键（同 work + 同归一化摘要只登记一次）。 */
export function foreshadowDedupKey(workId, summary) {
  const s = normalizeForeshadowSummary(summary);
  if (!s) return '';
  // FNV-1a 32 位 + 长度：与仓库其它轻量指纹同口径，只做同一性判断。
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `auto-foreshadow:${Number(workId) || 0}:${h.toString(16).padStart(8, '0')}${s.length.toString(16)}`;
}

/**
 * 从 deferred 条目里挑出"疑似伏笔"，产出待确认候选计划（纯函数，不写库）。
 *
 * 判定（保守）：
 *   · `type === 'possible_foreshadowing'` 直接算；或
 *   · 文本命中"伏笔/暗示/伏线/未解释/可能后面"且没被显式标成其它类型。
 * 过滤：空文本、已在事件账本里的同摘要、已登记过的 dedup_key、本批重复、超过上限。
 *
 * @returns {{candidates:Array<{summary,dedup_key,note}>, skipped:Array<{text,reason}>}}
 */
export function planAutoRegistrations({
  workId, chapterId, deferred = [], existingKeys = [], existingSummaries = [], limit = MAX_AUTO_REGISTRATIONS_PER_CHAPTER, keywordFallback = true,
} = {}) {
  const keys = new Set((Array.isArray(existingKeys) ? existingKeys : []).map((k) => text(k)));
  const summaries = new Set((Array.isArray(existingSummaries) ? existingSummaries : []).map((s) => normalizeForeshadowSummary(s)).filter(Boolean));
  const candidates = [];
  const skipped = [];
  const cap = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : MAX_AUTO_REGISTRATIONS_PER_CHAPTER;
  for (const item of (Array.isArray(deferred) ? deferred : [])) {
    const raw = item && typeof item === 'object' ? item : { text: item };
    const summary = normalizeForeshadowSummary(raw.text != null ? raw.text : raw.summary);
    if (!summary) { skipped.push({ text: '', reason: 'empty' }); continue; }
    const type = text(raw.type).trim();
    // 类型显式给出时以类型为准：`type: 'other'` 的条目即使句子里带"伏笔"也不转
    // （审稿模型常写"这不是伏笔"来解释为什么放 deferred——按关键词转会把否定句当成伏笔）。
    if (type && type !== 'possible_foreshadowing') { skipped.push({ text: summary, reason: 'not_foreshadow' }); continue; }
    const negated = /不是\s*伏笔|并非\s*伏笔|没有\s*伏笔|不是\s*暗示|并非\s*暗示|无需|不必|不算/.test(summary);
    const looksLike = type === 'possible_foreshadowing'
      || (keywordFallback && !negated && /伏笔|暗示|伏线|未解释|可能后面|后面会|留待/.test(summary));
    if (!looksLike) { skipped.push({ text: summary, reason: 'not_foreshadow' }); continue; }
    if (summaries.has(summary)) { skipped.push({ text: summary, reason: 'duplicate_summary' }); continue; }
    const key = foreshadowDedupKey(workId, summary);
    if (!key) { skipped.push({ text: summary, reason: 'empty_key' }); continue; }
    if (keys.has(key)) { skipped.push({ text: summary, reason: 'duplicate_key' }); continue; }
    if (candidates.length >= cap) { skipped.push({ text: summary, reason: 'over_limit' }); continue; }
    keys.add(key);
    summaries.add(summary);
    candidates.push({
      summary,
      dedup_key: key,
      note: `审稿 deferred 自动登记（第 ${Number(chapterId) || 0} 章；作者确认后才成为事件）`,
    });
  }
  return { candidates, skipped };
}
