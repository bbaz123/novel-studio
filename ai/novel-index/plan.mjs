/**
 * plan.mjs —— 检索计划（E4）：确定性生成 → 有界并发执行 → 汇总为最小必要资产。
 *
 * 纪律（本模块是本次集成点之一，必须读注释再改）：
 *   · 计划由**确定性规则**生成（词典 + 别名表 + 已有索引名称匹配），不调用任何模型；
 *   · 计划必须可序列化、可校验：不含函数名、路径、SQL 片段、阈值覆盖或写入动作；
 *   · 执行结果**全部汇总完成之后**才交给 buildNovelContext 装配——不允许把某个索引的
 *     结果并行「直接塞进上下文」。本模块只产出 `assets`（取哪些 id/名字），
 *     正文层仍由 buildNovelContext 的既有层构建；
 *   · 任一查询失败/超时 → 该类资产记为缺失，调用方回退该类的原有读取方式；
 *   · 计划失败不阻断写作。
 */
import { createHash } from 'node:crypto';

export const PLAN_LIMITS = Object.freeze({
  maxQueries: 12,
  maxEntitiesPerKind: 8,
  concurrency: 4,          // 并发上限（规格建议 ≤ 4）
  queryTimeoutMs: 1000,    // 单次索引查询超时上限
  totalBudgetMs: 4000,     // 计划总体截止（保守；正常本地 SQLite 远低于此）
  perQueryLimit: 8,
  planCacheMax: 32,
  planCacheTtlMs: 30000,   // 与召回微缓存同口径
  maxStringChars: 200,     // 计划里任何字符串的上限（direction 片段也只以片段出现）
});

/** 允许的索引与操作（白名单；任何不在表里的 index/op 都会被拒绝）。 */
export const PLAN_OPS = Object.freeze({
  character: ['by_names'],
  event: ['by_participants', 'by_location', 'recent'],
  foreshadow: ['by_topics', 'open'],
  world: ['by_entities'],
  relation: ['by_names'],
  location: ['by_names'],
  thread: ['by_topics'],
  item: ['reserved'],
  chapter: ['reserved'],
  style: ['reserved'],
  knowledge: ['reserved'],
});

const FORBIDDEN = [
  { re: /\b(select|insert|update|delete|drop|alter|pragma|attach|exec|eval|require|import)\b/i, code: 'sql_or_code' },
  { re: /(viking:|https?:|file:|[A-Za-z]:\\|\.\.\/|\/\/)/i, code: 'path_or_uri' },
  { re: /(top_k|topk|threshold|scoreThreshold|minScore|budgetMs|timeoutMs)/i, code: 'threshold_override' },
  { re: /\bwrite|写入|删除资料|ignore (all|previous)|忽略.*规则/i, code: 'write_or_instruction' },
];

function sha8(s) { return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8); }

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * 确定性实体抽取：词典（角色名/别名、地点名、世界词条关键词、剧情线主题）在文本里做
 * 子串匹配；长词优先，避免「张三」被「张三丰」抢先。返回去重、有界的名字数组。
 */
export function extractEntityMentions({ text = '', dictionary = [] } = {}) {
  const hay = String(text || '');
  const found = new Map(); // name -> {kind, hit, pos}
  const entries = (dictionary || [])
    // 词表由宿主拼装；畸形项（null/非对象）直接跳过——计划生成不得抛错（失败也不能阻断写作）。
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({ ...d, terms: [d.name, ...(d.aliases || [])].map((x) => String(x || '').trim()).filter(Boolean) }))
    .filter((d) => d.terms.length)
    .flatMap((d) => d.terms.map((t) => ({ ...d, term: t })))
    .sort((a, b) => (b.term.length - a.term.length) || (a.term < b.term ? -1 : 1));
  for (const e of entries) {
    const idx = hay.indexOf(e.term);
    if (idx < 0) continue;
    const key = `${e.kind}:${e.name}`;
    if (!found.has(key) || found.get(key).pos > idx) found.set(key, { kind: e.kind, name: e.name, term: e.term, pos: idx });
  }
  const byKind = { character: [], location: [], topic: [] };
  for (const v of [...found.values()].sort((a, b) => a.pos - b.pos)) byKind[v.kind] ? byKind[v.kind].push(v.name) : null;
  for (const k of Object.keys(byKind)) byKind[k] = [...new Set(byKind[k])].slice(0, PLAN_LIMITS.maxEntitiesPerKind);
  return byKind;
}

/** 生成计划（纯函数；同一输入输出完全相同）。 */
export function buildRetrievalPlan({ workId, chapterId = null, direction = '', chapterSignals = '', dictionary = [] }) {
  const mentions = extractEntityMentions({ text: [direction, chapterSignals].filter(Boolean).join('\n'), dictionary });
  const queries = [];
  const push = (index, op, args, limit) => {
    if (queries.length >= PLAN_LIMITS.maxQueries) return;
    queries.push({ index, op, args, limit: Math.min(Number(limit) || PLAN_LIMITS.perQueryLimit, PLAN_LIMITS.perQueryLimit) });
  };
  if (mentions.character.length) {
    push('character', 'by_names', { names: mentions.character }, 6);
    push('relation', 'by_names', { names: mentions.character }, 8);
    push('event', 'by_participants', { names: mentions.character }, 8);
  }
  if (mentions.location.length) {
    push('location', 'by_names', { names: mentions.location }, 6);
    push('event', 'by_location', { names: mentions.location }, 6);
  }
  if (mentions.topic.length) {
    push('foreshadow', 'by_topics', { topics: mentions.topic }, 6);
    push('thread', 'by_topics', { topics: mentions.topic }, 4);
  }
  if (mentions.character.length || mentions.topic.length) push('world', 'by_entities', { entities: [...mentions.character, ...mentions.topic].slice(0, 8) }, 6);
  // 没有任何实体线索时不硬凑：只保留「未闭合伏笔」这一条确定性查询（数量有界），
  // 它在装配侧仅用于「相关性不足时是否回退全量」的判定，不会扩大注入。
  push('foreshadow', 'open', {}, 6);
  const core = {
    version: 1,
    work_id: Number(workId) || 0,
    chapter_id: chapterId === null || chapterId === undefined ? null : Number(chapterId) || null,
    direction_used: Boolean(direction && String(direction).trim()),
    direction_chars: Array.from(String(direction || '')).length,
    direction_hash: direction ? sha8(direction) : '',
    entities: mentions,
    queries,
    bounds: {
      max_queries: PLAN_LIMITS.maxQueries,
      concurrency: PLAN_LIMITS.concurrency,
      per_query_timeout_ms: PLAN_LIMITS.queryTimeoutMs,
      total_budget_ms: PLAN_LIMITS.totalBudgetMs,
    },
    source: 'deterministic',
  };
  return { plan_id: `p7-${core.work_id}-${core.chapter_id ?? 0}-${sha8(stableStringify(core))}`, ...core };
}

/** 校验：计划只能包含白名单内容；任何非法字符串/未知操作 → 拒绝（不执行）。 */
export function validateRetrievalPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan_not_object'] };
  if (Number(plan.version) !== 1) errors.push('bad_version');
  if (!Array.isArray(plan.queries)) errors.push('queries_not_array');
  const queries = Array.isArray(plan.queries) ? plan.queries : [];
  if (queries.length > PLAN_LIMITS.maxQueries) errors.push('too_many_queries');
  for (const q of queries) {
    if (!q || typeof q !== 'object') { errors.push('bad_query'); continue; }
    if (!PLAN_OPS[q.index] || !PLAN_OPS[q.index].includes(q.op)) errors.push(`bad_op:${q.index}.${q.op}`);
    const lim = Number(q.limit);
    if (!Number.isFinite(lim) || lim < 1 || lim > PLAN_LIMITS.perQueryLimit) errors.push(`bad_limit:${q.index}`);
  }
  const strings = [];
  const walk = (v, path) => {
    if (typeof v === 'string') strings.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(plan, 'plan');
  for (const [path, s] of strings) {
    if (Array.from(s).length > PLAN_LIMITS.maxStringChars) { errors.push(`too_long:${path}`); continue; }
    if (/[\u0000-\u001f]/.test(s)) { errors.push(`control_chars:${path}`); continue; }
    for (const f of FORBIDDEN) if (f.re.test(s)) { errors.push(`${f.code}:${path}`); break; }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// ── 计划结果缓存（有界；键含计划摘要与索引版本，版本变化即不命中） ─────────────
const planCache = new Map();
let planCacheHits = 0;
export function _clearPlanCache() { planCache.clear(); planCacheHits = 0; }
export function _planCacheStats() { return { size: planCache.size, hits: planCacheHits }; }

/**
 * 执行计划：按 concurrency ≤ 4 分批并发（本地 SQLite 为同步调用，分批用于让出事件循环并
 * 保证并发**上限**语义；真实并发能力与耗时在报告中如实说明）。
 * @param {object} plan buildRetrievalPlan 的输出（先经 validateRetrievalPlan 校验）
 * @param {object} index 注入的索引实现（默认 ai/novel-index/store.mjs；测试可注入假实现）
 */
export async function executeRetrievalPlan(plan, { index, versions = {}, now = () => Date.now() } = {}) {
  const t0 = now();
  const validation = validateRetrievalPlan(plan);
  if (!validation.ok) return { ok: false, status: 'rejected', errors: validation.errors, assets: emptyAssets(), stats: { plan_id: plan && plan.plan_id || '', plan_digest: sha8(stableStringify(plan)), by_index: {}, cached: 0, failed: 0, timings_ms: 0 } };
  if (!index) return { ok: false, status: 'index_unavailable', assets: emptyAssets(), stats: { plan_id: plan.plan_id, plan_digest: sha8(stableStringify(plan)), by_index: {}, cached: 0, failed: 1, timings_ms: 0 } };

  const cacheKey = `${plan.work_id}:${plan.plan_id}:${versions.schema || ''}.${versions.version || ''}`;
  const hit = planCache.get(cacheKey);
  if (hit && now() - hit.at < PLAN_LIMITS.planCacheTtlMs) {
    planCacheHits += 1;
    // 命中计划缓存 = **本次装配没有真的查索引**：by_index 归零、只记 cached 标记。
    // 否则账本会把上一次执行的查询重复计入本次（与「资料召回微缓存命中记为 0」同口径；
    // 集成点③要求 index_queries 反映本次实际发生的查询次数）。
    return { ...hit.payload, stats: { ...hit.payload.stats, by_index: {}, cached: 1 } };
  }

  const assets = emptyAssets();
  const results = [];
  const byIndex = {};
  let failed = 0;
  let cachedCount = 0;
  const queries = plan.queries;
  let budgetExceeded = false;
  for (let i = 0; i < queries.length; i += PLAN_LIMITS.concurrency) {
    if (now() - t0 > PLAN_LIMITS.totalBudgetMs) { budgetExceeded = true; break; }
    const batch = queries.slice(i, i + PLAN_LIMITS.concurrency);
    // 每一批并发上限 ≤ concurrency；await 全部完成后才合并（集成点：先汇总、后装配）。
    const batchResults = await Promise.all(batch.map(async (q) => {
      const qs = now();
      try {
        const r = await Promise.resolve().then(() => runQuery(index, q, plan.work_id));
        return { q, ok: !!(r && r.ok), status: r && r.status || 'unknown', rows: (r && r.rows) || [], reason: r && r.error || '', ms: now() - qs };
      } catch (e) {
        return { q, ok: false, status: 'index_unavailable', rows: [], reason: e.message, ms: now() - qs };
      }
    }));
    for (const br of batchResults) {
      results.push(br);
      byIndex[br.q.index] = (byIndex[br.q.index] || 0) + 1;
      if (!br.ok) failed += 1;
      mergeResultIntoAssets(assets, br);
      if (br.ms > PLAN_LIMITS.queryTimeoutMs) assets.timeouts.push({ index: br.q.index, op: br.q.op, ms: br.ms });
    }
  }

  const out = {
    ok: failed === 0 && !budgetExceeded,
    partial: failed > 0 || budgetExceeded,
    status: budgetExceeded ? 'budget_exceeded' : (failed ? 'partial' : 'ok'),
    assets,
    results,
    stats: {
      plan_id: plan.plan_id,
      plan_digest: sha8(stableStringify(plan)),
      by_index: byIndex,
      cached: cachedCount,
      failed,
      timings_ms: now() - t0,
    },
  };
  planCache.set(cacheKey, { at: now(), payload: out });
  while (planCache.size > PLAN_LIMITS.planCacheMax) planCache.delete(planCache.keys().next().value);
  return out;
}

function runQuery(index, q, workId) {
  const args = { ...(q.args || {}), limit: q.limit, workId };
  if (q.index === 'character' && q.op === 'by_names') return index.queryCharacters({ workId: args.workId, names: args.names, limit: q.limit });
  if (q.index === 'event' && q.op === 'by_participants') return index.queryEvents({ workId: args.workId, participants: args.names, limit: q.limit });
  if (q.index === 'event' && q.op === 'by_location') return index.queryEvents({ workId: args.workId, location: (args.names || [])[0] || '', limit: q.limit });
  if (q.index === 'event' && q.op === 'recent') return index.queryEvents({ workId: args.workId, limit: q.limit });
  if (q.index === 'foreshadow' && q.op === 'by_topics') return index.queryForeshadows({ workId: args.workId, topics: args.topics, limit: q.limit });
  if (q.index === 'foreshadow' && q.op === 'open') return index.queryForeshadows({ workId: args.workId, limit: q.limit });
  if (q.index === 'world' && q.op === 'by_entities') return index.queryWorld({ workId: args.workId, entities: args.entities, limit: q.limit });
  if (q.index === 'relation' && q.op === 'by_names') return index.queryRelations({ workId: args.workId, names: args.names, limit: q.limit });
  if (q.index === 'location' && q.op === 'by_names') return index.queryLocations({ workId: args.workId, names: args.names, limit: q.limit });
  if (q.index === 'thread' && q.op === 'by_topics') return index.queryThreads({ workId: args.workId, topics: args.topics, limit: q.limit });
  if (q.index === 'item') return index.queryItems();
  if (q.index === 'chapter') return index.queryChapters();
  if (q.index === 'style') return index.queryStyle();
  if (q.index === 'knowledge') return index.queryKnowledge();
  return { ok: false, status: 'not_wired', rows: [] };
}

function emptyAssets() {
  return {
    character_ids: [], character_names: [],
    event_ids: [], foreshadow_ids: [],
    world_ids: [], relation_ids: [], location_ids: [], thread_ids: [],
    timeouts: [],
    matched: { characters: false, events: false, foreshadows: false, world: false, relations: false, locations: false, threads: false },
  };
}

function mergeResultIntoAssets(assets, br) {
  const rows = Array.isArray(br.rows) ? br.rows : [];
  const names = new Set(assets.character_names);
  if (br.q.index === 'character') {
    for (const r of rows) { assets.character_ids.push(Number(r.character_id)); if (r.name) names.add(String(r.name)); }
    assets.matched.characters = assets.matched.characters || rows.length > 0;
  } else if (br.q.index === 'event') {
    for (const r of rows) assets.event_ids.push(Number(r.event_id));
    assets.matched.events = assets.matched.events || rows.length > 0;
  } else if (br.q.index === 'foreshadow') {
    for (const r of rows) assets.foreshadow_ids.push(Number(r.event_id));
    if (br.q.op === 'by_topics' && rows.length) assets.matched.foreshadows = true;
  } else if (br.q.index === 'world') {
    for (const r of rows) assets.world_ids.push(Number(r.entry_id));
    assets.matched.world = assets.matched.world || rows.length > 0;
  } else if (br.q.index === 'relation') {
    for (const r of rows) assets.relation_ids.push(Number(r.relation_id));
    assets.matched.relations = assets.matched.relations || rows.length > 0;
  } else if (br.q.index === 'location') {
    for (const r of rows) assets.location_ids.push(String(r.location_id));
    assets.matched.locations = assets.matched.locations || rows.length > 0;
  } else if (br.q.index === 'thread') {
    for (const r of rows) assets.thread_ids.push(Number(r.thread_id));
    assets.matched.threads = assets.matched.threads || rows.length > 0;
  }
  assets.character_names = [...names];
  // 汇总后按出现顺序去重、有界（先定位再读取，读取侧仍受层预算约束）。
  const dedupe = (arr, cap) => [...new Set(arr.filter((x) => Number.isFinite(x) && x > 0))].slice(0, cap);
  assets.character_ids = dedupe(assets.character_ids, 8);
  assets.event_ids = dedupe(assets.event_ids, 12);
  assets.foreshadow_ids = dedupe(assets.foreshadow_ids, 8);
  assets.world_ids = dedupe(assets.world_ids, 8);
  assets.relation_ids = dedupe(assets.relation_ids, 10);
  assets.location_ids = [...new Set(assets.location_ids)].slice(0, 8);
  assets.thread_ids = dedupe(assets.thread_ids, 6);
}

/**
 * 生成执行计划并执行（供 buildNovelContext 使用的入口）。
 * 任何失败都返回 { ok:false, assets:null }，调用方回退旧路径。
 */
export async function planAndExecute({ workId, chapterId, direction, chapterSignals, dictionary, index, versions }) {
  const plan = buildRetrievalPlan({ workId, chapterId, direction, chapterSignals, dictionary });
  const validation = validateRetrievalPlan(plan);
  if (!validation.ok) {
    return { ok: false, status: 'rejected', plan, errors: validation.errors, assets: null, stats: { plan_id: plan.plan_id, plan_digest: sha8(stableStringify(plan)), by_index: {}, cached: 0, failed: 0, timings_ms: 0 } };
  }
  const exec = await executeRetrievalPlan(plan, { index, versions });
  return { ...exec, plan };
}
