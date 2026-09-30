/**
 * 时态故事状态 · 本章状态提取（提示词构造 + 模型输出本地校验）。
 *
 * 纪律：
 *   · 模型输出**只是候选**：这里做的是结构白名单校验（域/谓词/expected/证据），
 *     不是执行；解析失败逐条报错，绝不把任意对象当 SQL 或路径执行。
 *   · 输入消毒：正文与状态摘要都截断、去除控制字符；响应体有上限。
 *   · 这里是唯一构造抽取请求的地方，便于用确定性 fake 断言"送进去的是什么"。
 */
import { DOMAINS, SCOPES, TEMPORAL_LIMITS, normalizeEvent, canonicalJson } from './schema.mjs';
import { cellKey } from './schema.mjs';

export const TEMPORAL_EXTRACTION_VERSION = '1.0.0';
/** 行动前提（actual assumptions）允许的类型：目标 / 行动原因 / 资源 / 承诺 / 知识 / 因果。 */
export const ASSUMPTION_KINDS = new Set(['goal', 'reason', 'resource', 'promise', 'knowledge', 'causal']);
export const ASSUMPTION_LIMITS = { max_items: 40, max_statement: 200, max_quote_chars: 200 };

export const EXTRACTION_LIMITS = {
  max_chars: 12000,
  max_events: 60,
  max_ops_per_event: TEMPORAL_LIMITS.max_ops_per_event,
  max_response_chars: 200000,
  max_quote_chars: 200,
};

/** 消毒：去控制字符、截断；保留换行以维持可读的段落边界。 */
export function sanitizeText(input, maxChars = EXTRACTION_LIMITS.max_chars) {
  return String(input == null ? '' : input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, maxChars);
}

/** 已知实体名（提示词里给出稳定 id 候选项，避免模型自造名字）。 */
export function knownNamesFrom(rows = []) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    const name = typeof row === 'string' ? row : String(row.name || row.title || '');
    if (name.trim()) out.push(name.trim());
  }
  return [...new Set(out)].slice(0, 200);
}

/**
 * 构造抽取请求。返回 {system,user,input_hash}；input_hash 覆盖正文与状态，供审计与幂等。
 */
export function buildExtractionPrompt({
  chapterId = 0, chapterTitle = '', revision = null, plainText = '',
  stateBeforeJson = {}, known = {}, targetWords = 2000,
} = {}) {
  const text = sanitizeText(plainText);
  const stateLines = [];
  const keys = Object.keys(stateBeforeJson || {}).sort();
  for (const key of keys.slice(0, 400)) {
    let cell = null;
    try { cell = JSON.parse(key); } catch { cell = null; }
    if (!Array.isArray(cell)) continue;
    const [domain, entityId, predicate, scope, holderId] = cell;
    const value = canonicalJson(stateBeforeJson[key]);
    stateLines.push(`${domain}|${entityId}|${predicate}|${scope}|${holderId == null ? '-' : holderId} = ${value}`);
  }
  const knownLine = (label, list) => (list && list.length ? `${label}：${list.join('、')}` : '');
  const system = [
    '你是长篇小说的“状态记账员”。只输出 JSON，不要解释、不要 Markdown 代码块。',
    '任务：从“本章正文”中提取**相对章前状态发生的变化**，逐条给出 events；并给出 assumptions（本章行动成立所依赖的前提，没有就写空数组）：',
    '{"events":[{"ops":[{"type":"set|unset","cell":{"domain":"...","entityId":"...","predicate":"...","scope":"canon|character|reader|world","holderId":null},',
    '"expected":{"kind":"missing"} 或 {"kind":"value","value":<章前值>},"value":<新值>}],"evidence":[{"quote":"正文原句","narrative":"present|flashback|dream|quote|report|unknown"}]}]}',
    '{"assumptions":[{"kind":"goal|reason|resource|promise|knowledge|causal","statement":"行动前提一句话","quote":"正文原句"}]}',
    `domain 只能是：${[...DOMAINS].join(', ')}；scope 只能是：${[...SCOPES].join(', ')}。`,
    '规则：① 只在正文明确支持时输出；② expected 必须是**章前状态**的真实值（没有则 kind=missing），不满足会让确认被拒绝；',
    '③ 回忆/梦境/引用/转述必须如实标 narrative，不能当作当前事实；④ 不得输出正文没有的实体或事件；',
    '⑤ 关系（relation，entityId 用 “A|B”）、剧情线（plotline）、角色（character，predicate 如 alive/status/location）、',
    '知识（knowledge，scope=character + holderId）、披露（disclosure，scope=reader）、伏笔（foreshadow）、物品（item）、',
    '地点（location）、势力（faction）、世界事实（world_fact）、任务（task）、目标（goal）、承诺（promise）、创作前提（premise）都要覆盖。',
    '⑥ assumptions 的 kind 只能是 goal/reason/resource/promise/knowledge/causal，每条给出 statement 与正文原句 quote；quote 必须能在正文中找到；不确定或没有就输出空数组。',
  ].join('\n');
  const parts = [
    `章节：${chapterId}${chapterTitle ? '（' + chapterTitle + '）' : ''}`,
    revision ? `修订：${revision.id}（文本哈希 ${revision.text_hash}）` : '',
    knownLine('已知角色', known.characters),
    knownLine('已知剧情线', known.plotlines),
    knownLine('已知设定/词条', known.terms),
    '章前状态（chapter 前一刻，权威来源）：',
    stateLines.length ? stateLines.join('\n') : '（空：这是开篇章节）',
    `本章正文（约 ${targetWords} 字目标，不要改正文）：`,
    text,
    '请输出 JSON。',
  ].filter(Boolean);
  const user = parts.join('\n');
  return { system, user, input_hash: canonicalJson({ text, state: keys.map((k) => [k, stateBeforeJson[k]]), known: knownLine('', []) }) };
}

/** 从模型回复里取出 JSON 对象（容忍代码块与前后噪声，但仍要求整体可解析）。 */
export function extractJsonBlock(raw) {
  // 调用方直接给结构化结果（{events:[...]} / 事件数组）：已是对象，不再过 JSON 文本解析。
  if (raw && typeof raw === 'object') return raw;
  let s = String(raw == null ? '' : raw).slice(0, EXTRACTION_LIMITS.max_response_chars).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* 继续尝试整体解析 */ }
  }
  return JSON.parse(s);
}

/**
 * 解析并本地校验 assumptions（行动前提）：kind 白名单、statement 非空、quote 必须是正文原句。
 * 不可信条目不入库，只记 issues（宁可少记前提，也不记假前提）。
 */
export function parseAssumptions(parsed, { plainText = '', issues = [] } = {}) {
  const list = parsed && Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
  const out = [];
  const norm = String(plainText || '').replace(/\s+/g, ' ').trim();
  for (const [index, item] of list.slice(0, ASSUMPTION_LIMITS.max_items).entries()) {
    if (!item || typeof item !== 'object') continue;
    const kind = String(item.kind || '');
    if (!ASSUMPTION_KINDS.has(kind)) { issues.push({ code: 'ASSUMPTION_KIND_INVALID', index, message: `assumption kind 非法：${sanitizeText(kind, 40)}` }); continue; }
    const statement = sanitizeText(String(item.statement || ''), ASSUMPTION_LIMITS.max_statement).trim();
    if (!statement) { issues.push({ code: 'ASSUMPTION_STATEMENT_MISSING', index, message: 'assumption 缺少 statement' }); continue; }
    const quote = sanitizeText(String(item.quote || ''), ASSUMPTION_LIMITS.max_quote_chars).trim();
    if (!quote) { issues.push({ code: 'ASSUMPTION_QUOTE_MISSING', index, message: 'assumption 缺少 quote（必须是正文原句）' }); continue; }
    if (norm && !norm.includes(quote.replace(/\s+/g, ' ').trim())) {
      issues.push({ code: 'ASSUMPTION_QUOTE_NOT_FOUND', index, message: `assumption 的引文在正文中找不到：${sanitizeText(quote, 60)}` });
      continue;
    }
    out.push({ kind, statement, quote });
  }
  return out;
}

/**
 * 本地校验模型输出：逐事件走 normalizeEvent（白名单域 + expected + 证据）。
 * @returns {{ok:boolean, events:Array, assumptions:Array, issues:Array<{code:string,message:string,index?:number}>}}
 */
export function parseExtractionResponse(raw, { workId = 0, chapterId = 0, revisionId = '', plainText = '' } = {}) {
  const issues = [];
  let parsed = null;
  try {
    parsed = extractJsonBlock(raw);
  } catch (e) {
    return { ok: false, events: [], issues: [{ code: 'JSON_PARSE_FAILED', message: sanitizeText(String(e.message || e), 300) }] };
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.events) ? parsed.events : null);
  if (!list) return { ok: false, events: [], issues: [{ code: 'EVENTS_ARRAY_REQUIRED', message: '输出必须是 {events:[...]} 或事件数组' }] };
  if (list.length > EXTRACTION_LIMITS.max_events) {
    issues.push({ code: 'TOO_MANY_EVENTS', message: `事件数 ${list.length} 超过上限 ${EXTRACTION_LIMITS.max_events}，超出的已丢弃` });
  }
  const events = [];
  for (const [index, item] of list.slice(0, EXTRACTION_LIMITS.max_events).entries()) {
    try {
      // 模型有时把 evidence 放在 ops 里（提示词历史版本）：上提到事件级，保持唯一口径。
      let rawItem = item;
      if (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)) {
        const hasEventEvidence = Array.isArray(rawItem.evidence) && rawItem.evidence.length > 0;
        if (!hasEventEvidence && Array.isArray(rawItem.ops)) {
          const hoisted = [];
          for (const op of rawItem.ops) {
            if (op && Array.isArray(op.evidence)) for (const e of op.evidence) hoisted.push(e);
          }
          if (hoisted.length) rawItem = { ...rawItem, evidence: hoisted };
        }
      }
      const normalized = normalizeEvent(rawItem, { workId, chapterId, revisionId });
      // 证据里的引文必须能在正文里找到——找不到就降级为待复核（保留但标出）。
      for (const ev of normalized.evidence || []) {
        if (ev.quote && plainText && !sanitizeText(plainText).includes(ev.quote)) {
          issues.push({ code: 'EVIDENCE_QUOTE_NOT_FOUND', index, message: `事件 ${index} 的引文在正文中找不到：${sanitizeText(ev.quote, 60)}` });
        }
      }
      events.push(normalized);
    } catch (e) {
      issues.push({ code: 'EVENT_INVALID', index, message: sanitizeText(String(e.message || e), 200) });
    }
  }
  const assumptions = parseAssumptions(parsed, { plainText, issues });
  return { ok: events.length > 0, events, assumptions, issues };
}

/** 提案组摘要（给界面显示“一次确认要同步哪些域”）。 */
export function summarizeProposalEvents(events = []) {
  const byDomain = {};
  const cells = [];
  for (const event of events || []) {
    for (const op of event.ops || []) {
      const domain = String((op.cell || {}).domain || 'unknown');
      byDomain[domain] = (byDomain[domain] || 0) + 1;
      try { cells.push(cellKey(op.cell)); } catch { /* 非法 cell 由解析层报错 */ }
    }
  }
  return { events: (events || []).length, ops: cells.length, by_domain: byDomain, cells: [...new Set(cells)].slice(0, 200) };
}
