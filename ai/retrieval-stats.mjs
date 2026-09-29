/**
 * retrieval-stats.mjs —— 一次装配的「检索账本」。
 *
 * 为什么单独一个模块：验收时必须能分清两个**不同**的计数——
 *   ① 资料召回次数（library recall）：真正向共享资料库发起检索（含缓存命中标记）；
 *   ② 索引查询次数（index queries）：本次装配对 Library Index / Novel Index 的查询次数。
 * 「召回一次但查了 3 个索引」与「召回了两次」是两件事，混成一个「调用次数」会让
 * 验收结论无法解释（例如：索引优化后索引查询变多、召回仍是一次，这不是退化）。
 *
 * 本模块零 IO：计数由调用方累加，这里只负责结构与合并口径。
 */

/** 每类索引的稳定名字（by_index 的键；也是测试对账表）。 */
export const INDEX_NAMES = Object.freeze([
  'library',      // D：共享资料候选索引
  'character',    // E1
  'event',        // E1
  'foreshadow',   // E1
  'world',        // E2（结构/查询接口就绪，分阶段接入）
  'relation',     // E2
  'location',     // E2
  'thread',       // E2
  'item',         // E3（仅结构）
  'chapter',      // E3
  'style',        // E3
  'knowledge',    // E3
]);

export function createRetrievalAccumulator({ phase = 'default', direction = null, requestId = '' } = {}) {
  return {
    request_id: requestId,
    phase,
    direction, // directionAuditOf 的输出（不含全文）
    library_recall: {
      phase,
      searches: 0,        // 真实检索次数（不含缓存命中）
      cached: false,      // 该结果是否来自微缓存
      index_assisted: false,
      index_queries: 0,   // 资料索引查询次数（属于 index_queries.by_index.library 的镜像，便于单侧核对）
      status: 'unknown',
      hits: 0,
      text_chars: 0,
      timings_ms: 0,
    },
    index_queries: {
      total: 0,
      by_index: {},
      cached: 0,
      failed: 0,
      plan_id: '',
      plan_digest: '',
      timings_ms: 0,
    },
    timings_ms: {
      library_recall: 0,
      index_plan: 0,
    },
  };
}

/** 记录一次索引查询（cached/failed 也要显式记账，不允许「沉默的零成本」）。 */
export function addIndexQuery(acc, indexName, { count = 1, cached = false, failed = false } = {}) {
  if (!acc || count <= 0) return acc;
  const name = INDEX_NAMES.includes(indexName) ? indexName : `unknown:${indexName}`;
  acc.index_queries.total += count;
  acc.index_queries.by_index[name] = (acc.index_queries.by_index[name] || 0) + count;
  if (cached) acc.index_queries.cached += count;
  if (failed) acc.index_queries.failed += count;
  if (name === 'library') acc.library_recall.index_queries += count;
  return acc;
}

/** 合并资料召回层的统计（getLibraryRecall 返回值里的 stats 字段）。 */
export function mergeLibraryStats(acc, stats) {
  if (!acc || !stats) return acc;
  acc.library_recall.searches += Number(stats.searches) || 0;
  // D4：资料索引查询次数在这里入账（getLibraryRecall 内部已计数，但它是独立的一件事，见集成点③）：
  // 计入总账 index_queries.by_index.library，并同步镜像 library_recall.index_queries；
  // searches（真实召回次数）完全不受影响——「召回一次但查了索引」与「召回了两次」是两回事。
  const libraryIndexQueries = Number(stats.index_queries) || 0;
  if (libraryIndexQueries > 0) addIndexQuery(acc, 'library', { count: libraryIndexQueries });
  acc.library_recall.cached = acc.library_recall.cached || Boolean(stats.cached);
  acc.library_recall.index_assisted = acc.library_recall.index_assisted || Boolean(stats.index_assisted);
  if (stats.status) acc.library_recall.status = String(stats.status);
  acc.library_recall.hits = Number(stats.hits) || 0;
  acc.library_recall.text_chars = Number(stats.text_chars) || 0;
  acc.library_recall.timings_ms += Number(stats.timings_ms) || 0;
  return acc;
}

/**
 * 合并检索计划执行器的统计（executeRetrievalPlan 的 stats）。
 * 计划缓存命中时 by_index 为空（由 executeRetrievalPlan 归零）——本次装配没有发生索引查询，
 * 只把 cached 记 1；不得把上一次执行的 by_index 重复计入本账本。
 */
export function mergePlanStats(acc, stats) {
  if (!acc || !stats) return acc;
  acc.index_queries.plan_id = String(stats.plan_id || '');
  acc.index_queries.plan_digest = String(stats.plan_digest || '');
  acc.index_queries.cached += Number(stats.cached) || 0;
  acc.index_queries.failed += Number(stats.failed) || 0;
  for (const [name, n] of Object.entries(stats.by_index || {})) addIndexQuery(acc, name, { count: Number(n) || 0, failed: false });
  acc.timings_ms.index_plan += Number(stats.timings_ms) || 0;
  return acc;
}

/**
 * 收口为响应字段。两个计数在结构上就是两组字段：
 *   library_recall.searches   与  index_queries.total
 * 任何消费方都不需要、也不允许用一个「总调用次数」把它们合并。
 */
export function finalizeRetrievalStats(acc) {
  if (!acc) return null;
  return {
    // 调用方传入的装配身份（缺省为空串）。装配自身的身份另见响应 `context_request_id`；
    // 这里带上它，是为了让这份检索账本能单独与一次装配对上（§十 审计要求 requestId 可查）。
    request_id: String(acc.request_id || ''),
    direction: acc.direction || { used: false, source: '', hash: '', chars: 0 },
    library_recall: {
      phase: acc.library_recall.phase,
      searches: acc.library_recall.searches,
      cached: acc.library_recall.cached,
      index_assisted: acc.library_recall.index_assisted,
      index_queries: acc.library_recall.index_queries,
      status: acc.library_recall.status,
      hits: acc.library_recall.hits,
      text_chars: acc.library_recall.text_chars,
      timings_ms: acc.library_recall.timings_ms,
    },
    index_queries: {
      total: acc.index_queries.total,
      by_index: { ...acc.index_queries.by_index },
      cached: acc.index_queries.cached,
      failed: acc.index_queries.failed,
      plan_id: acc.index_queries.plan_id,
      plan_digest: acc.index_queries.plan_digest,
      timings_ms: acc.index_queries.timings_ms,
    },
    timings_ms: { ...acc.timings_ms },
  };
}
