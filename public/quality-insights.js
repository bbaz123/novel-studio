/*
 * 修复效果统计（quality-insights）—— 纯函数、零依赖（UMD）。
 *
 * 用于 v1.2.4 方案 P2「质量历史统计与问题修复效果分析」。
 *
 * 为什么值得做：v1.2.4 之前，"这次修稿到底有没有用"只有单次结论（这次 5 通过 / 3 未通过）。
 * 作者真正想知道的跨章问题是：**同一类问题是不是反复修不掉**（例如"时序矛盾"每次都失败）。
 * 那需要按**问题类型/原因码**聚合，而不是再刷一遍单次数字。
 *
 * 纪律：
 *   · 样本不足（< 3 次运行）不给"成功率"这类比例结论，只给计数；
 *   · 不把"未跑语义"算进任何分母（否则成功率会被等待中的项稀释）；
 *   · 只从**已有记录**聚合，不重新调用模型、不推测。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelQualityInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const MIN_RUNS = 3;
  const textOf = (x) => String(x == null ? '' : x);

  /** 从任一行形状里取终态（运行记录 / 终审行 / 覆盖表行都认）。 */
  function finalOf(row) {
    return textOf(row && (row.final_status || row.finalStatus || row.status));
  }
  function codeOf(row) {
    return textOf(row && (row.reason_code || row.reasonCode || row.code));
  }
  function typeOf(row) {
    return textOf(row && (row.type || row.issue_type || row.issueType));
  }

  /**
   * @param {Array} runs [{at, chapter_index, rows|issues:[{final_status, reason_code, type}], auto_repair_rounds}]
   * @returns 统计对象；`enough:false` 时 `success_rate` 为 null（不给比例）
   */
  function effectStats(runs) {
    const list = Array.isArray(runs) ? runs : [];
    const byType = new Map();
    const byCode = new Map();
    let totalIssues = 0;
    let fixed = 0;
    let failing = 0;
    let awaiting = 0;
    let canon = 0;
    let rounds = 0;
    let runsWithRows = 0;

    for (const run of list) {
      const rows = Array.isArray(run && (run.rows || run.issues)) ? (run.rows || run.issues) : [];
      if (!rows.length) continue;
      runsWithRows += 1;
      rounds += Number(run && (run.auto_repair_rounds || run.repair_rounds)) || 0;
      for (const row of rows) {
        const st = finalOf(row);
        if (!st || st === 'NOT_SELECTED') continue;
        totalIssues += 1;
        const t = typeOf(row) || '未分类';
        if (!byType.has(t)) byType.set(t, { type: t, total: 0, fixed: 0, failing: 0, awaiting: 0 });
        const bucket = byType.get(t);
        bucket.total += 1;
        if (st === 'ISSUE_VERIFIED') { fixed += 1; bucket.fixed += 1; }
        else if (st === 'UNRESOLVED' || st === 'PARTIAL') { failing += 1; bucket.failing += 1; }
        else if (st === 'CANON_CONFLICT') { canon += 1; bucket.failing += 1; }
        else { awaiting += 1; bucket.awaiting += 1; }
        const code = codeOf(row);
        if (code && st !== 'ISSUE_VERIFIED') byCode.set(code, (byCode.get(code) || 0) + 1);
      }
    }

    const decided = fixed + failing + canon;      // 分母只含"有结论"的项
    const enough = runsWithRows >= MIN_RUNS && decided > 0;
    return {
      enough,
      runs: runsWithRows,
      min_runs: MIN_RUNS,
      total_issues: totalIssues,
      fixed,
      failing,
      awaitings: awaiting,
      canon_conflict: canon,
      // 未跑语义的项不进分母：成功率先要"有结论"才谈比例
      success_rate: enough ? Math.round((fixed / decided) * 1000) / 1000 : null,
      avg_repair_rounds: runsWithRows ? Math.round((rounds / runsWithRows) * 100) / 100 : 0,
      by_type: [...byType.values()].sort((a, b) => b.total - a.total),
      top_codes: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      note: enough
        ? `共 ${runsWithRows} 次运行、${decided} 条有结论的问题：通过 ${fixed}，未通过 ${failing + canon}`
        : `有结论的运行不足（${runsWithRows}/${MIN_RUNS} 次）：只给计数，不给成功率`,
    };
  }

  /** 反复修不掉的问题类型（按"未通过数 / 总数"降序，至少 2 条才值得说）。 */
  function stubbornTypes(stats, opts = {}) {
    const minTotal = Number(opts.minTotal) > 0 ? Number(opts.minTotal) : 2;
    const list = Array.isArray(stats && stats.by_type) ? stats.by_type : [];
    return list
      .filter((b) => b.total >= minTotal && b.failing > 0)
      .map((b) => ({ ...b, fail_rate: Math.round((b.failing / b.total) * 100) / 100 }))
      .sort((a, b) => (b.fail_rate - a.fail_rate) || (b.failing - a.failing))
      .slice(0, 5);
  }

  /** 一行摘要（界面/导出共用，避免两处措辞漂移）。 */
  function summaryLine(stats) {
    if (!stats || !stats.runs) return '还没有可统计的修稿运行';
    const base = `运行 ${stats.runs} 次 · 有结论 ${stats.fixed + stats.failing + stats.canon_conflict} 条 · 通过 ${stats.fixed}`;
    if (stats.success_rate == null) return `${base} · 样本不足，不给成功率`;
    return `${base} · 成功率 ${Math.round(stats.success_rate * 100)}% · 平均复修 ${stats.avg_repair_rounds} 轮`;
  }

  return { VERSION, MIN_RUNS, effectStats, stubbornTypes, summaryLine, finalOf, codeOf };
});
