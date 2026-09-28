/**
 * 共享资料库召回的形状化（纯函数）——从 OV find/read 的结果到「参考资料」层的一条条目。
 *
 * P0 实测结论（2026-09-28，见 .p1-baseline/probe-library-p0.result.json）决定了这里的常量：
 *   · find 是**文件级**命中（abstract 为整篇摘要），没有按 `##` 的逐段条目；
 *   · readContent 的 offset/limit 按**行**计：offset 0/limit 30 = 前 30 行（实测 484 字）；
 *   · 阈值：探针里真实标记 0.443–0.469，胡写对照 0.366 → 文档默认 0.35 太松，
 *     冻结为 0.40（宁缺毋滥：资料层是辅助，混入无关资料比漏召更糟）；
 *   · 「前 300 字窗口」实际由**文件头部**决定（取回窗口 30 行 + 单条压 300 字），
 *     格式约定要求把「一句话结论 + 适用场景」压进前 2–3 行（见 library-doc.mjs）。
 *
 * 网络调用在 openviking-sync.js 的 getLibraryRecall；本模块只做纯的选取与文本形状化，
 * 因而可以被离线单测（含与 recall-meta.recallTextOf 的格式一致性对照）。
 */

/** 检索参数（P0 后冻结；改动须同步文档与验证脚本）。 */
export const LIBRARY_RECALL = Object.freeze({
  maxHits: 4,           // 进层的 top-4（文档默认）
  overscan: 4,          // find 多取 4 条候选：先按形状过滤、再截断 top-4——
                        // P1 真机实测：OV 给目录生成的 .abstract/.overview 伴随文件分数常高于正文，
                        // 先截断会让它们挤掉真资料（保留前缀规则见 library-roots.checkLibraryShape）
  scoreThreshold: 0.40, // 0.35 太松（胡写对照 0.366），冻结 0.40
  perItemChars: 300,    // 单条进层前压到 300 字（与 recall 层同口径）
  readLines: 30,        // readContent 窗口：前 30 行（P0 实测 484 字）
  labelPrefix: '参考资料｜',
  ttlMs: 30000,         // 微缓存（与 recall 同口径）
  cacheMax: 256,        // 微缓存容量（LRU）
});

/** 确定性截断（与 openviking-sync.js 的 capText 同款；本模块不依赖那边，保持纯）。 */
function capText(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 从取回的正文里提标题：首个 `#` 行 → 否则 uri 的文件名。 */
export function libraryTitleOf(text, uri) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('#'));
  const name = String(uri || '').split('/').pop() || '资料条目';
  return capText((line ? line.replace(/^#+\s*/, '') : name).trim(), 40);
}

/**
 * 一条命中 → 层内条目。
 * label 带「参考资料｜」前缀：层标题之外再做**条目级**标注——去重、贡献记录与
 * 截断后重建文本（recall-meta.recallTextOf）三处读的是同一个 label，标注不会漂移。
 */
export function libraryHitOf(hit, { text = '', score = 0 } = {}) {
  const title = libraryTitleOf(text, hit && hit.uri);
  return {
    uri: (hit && hit.uri) || '',
    label: capText(`${LIBRARY_RECALL.labelPrefix}${title}`, 60),
    kind: '参考资料',
    scope: 'shared',
    score: Math.round((Number(score) || 0) * 100),
    text: capText(text, LIBRARY_RECALL.perItemChars),
  };
}

/** 条目列表 → 层正文。格式与 recall 层一致，recall-meta.recallTextOf 可原样重建。 */
export function libraryRecallTextOf(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && i.text)
    .map((i) => `【${i.label}】（相关度 ${Number(i.score) || 0}%）\n${i.text}`)
    .join('\n\n');
}
