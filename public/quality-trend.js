/*
 * 质量趋势与章节级回归（quality-trend）—— 纯函数、零依赖（UMD）。
 *
 * 用于 v1.2.4 方案 P2「风格和情节 AI 机械感的长期趋势图与章节级回归」。
 *
 * 两条纪律（与既有 `revisionSampleGuard` 同源）：
 *   ① **样本不足不给趋势**：少于 5 次运行只列明细，不得说"在变好/在变差"；
 *   ② 趋势只是**观测**，不是质量结论：界面必须写成"这一指标在上升/下降"，
 *      不得写成"这章写得更好"。指标本身也无法表达"好不好"。
 *
 * 指标来自确定性可数的东西（模板句命中、重复 n-gram 候选、连续否定句、字数），
 * 不引入模型打分 —— 那会把"AI 味"变成又一个不可复核的分数。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelQualityTrend = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const MIN_SAMPLES = 5;

  /** 指标定义：label 用于界面，higher_is_worse 决定"变差"的方向。 */
  const METRICS = [
    { id: 'template_hits', label: '模板句命中', higher_is_worse: true },
    { id: 'repetition', label: '段内重复候选', higher_is_worse: true },
    { id: 'negation_runs', label: '连续否定句', higher_is_worse: true },
    { id: 'ai_flavor', label: 'AI 味信号', higher_is_worse: true },
    { id: 'chars', label: '本章字数', higher_is_worse: false },
  ];

  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

  function metricOf(id) {
    return METRICS.find((m) => m.id === String(id)) || null;
  }

  /** 从运行记录里抽一条指标的序列（按章节序 / 时间序）。缺值的样本跳过并计数。 */
  function seriesOf(runs, metricId) {
    const list = Array.isArray(runs) ? runs : [];
    const points = [];
    let skipped = 0;
    list.forEach((r, i) => {
      const m = r && (r.metrics || (r.closure && r.closure.metrics) || null);
      const v = m ? num(m[metricId]) : null;
      if (v == null) { skipped += 1; return; }
      points.push({
        chapter_index: Number(r.chapter_index) >= 0 ? Number(r.chapter_index) : i,
        at: String(r.at || ''),
        value: v,
      });
    });
    return { metric: metricId, points, skipped, total: list.length };
  }

  /**
   * 最小二乘斜率 + 方向。样本不足返回 `enough:false` 且**不给方向**。
   */
  function trendOf(points, opts = {}) {
    const list = Array.isArray(points) ? points : [];
    const minSamples = Number(opts.minSamples) > 0 ? Number(opts.minSamples) : MIN_SAMPLES;
    if (list.length < minSamples) {
      return {
        enough: false, samples: list.length, minSamples,
        note: `只有 ${list.length} 个样本（少于 ${minSamples}）：只列明细，不给趋势结论`,
        slope: null, direction: 'unknown',
      };
    }
    const n = list.length;
    const xs = list.map((_, i) => i);
    const ys = list.map((p) => Number(p.value) || 0);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let numr = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      numr += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const slope = den === 0 ? 0 : numr / den;
    const direction = Math.abs(slope) < 1e-9 ? 'flat' : (slope > 0 ? 'up' : 'down');
    return {
      enough: true, samples: n, minSamples,
      slope: Math.round(slope * 1000) / 1000,
      direction,
      first: ys[0], last: ys[n - 1], avg: Math.round((my + Number.EPSILON) * 100) / 100,
      note: `样本 ${n} 个：${direction === 'up' ? '上升' : direction === 'down' ? '下降' : '基本持平'}（斜率 ${Math.round(slope * 1000) / 1000}／次）—— 这只是观测，不是"写得好不好"的结论`,
    };
  }

  /**
   * 章节级回归：本章比历史中位数差多少才算"劣化"。
   * 用中位数而不是均值：一两章异常值不该把门槛抬高（与 `revisionSampleGuard` 的样本量思路一致）。
   * @returns {{enough:boolean, worse:boolean, delta:number|null, note:string, median:number|null}}
   */
  function chapterRegression(input = {}) {
    const history = (Array.isArray(input.history) ? input.history : []).map(num).filter((v) => v != null);
    const current = num(input.current);
    const metric = metricOf(input.metric) || { id: String(input.metric || ''), label: String(input.metric || ''), higher_is_worse: true };
    const threshold = Number.isFinite(Number(input.threshold)) ? Math.max(0, Number(input.threshold)) : 1;
    const minHistory = Number.isFinite(Number(input.minHistory)) ? Math.max(2, Number(input.minHistory)) : 3;
    if (current == null) return { enough: false, worse: false, delta: null, median: null, note: '本章没有该指标的值' };
    if (history.length < minHistory) {
      return { enough: false, worse: false, delta: null, median: null, note: `历史只有 ${history.length} 章（少于 ${minHistory}）：不做章节级回归判断` };
    }
    const sorted = history.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const delta = current - median;
    const worse = metric.higher_is_worse ? delta > threshold : delta < -threshold;
    return {
      enough: true, worse, delta, median,
      note: worse
        ? `本章「${metric.label}」${current} 比历史中位数 ${median} ${metric.higher_is_worse ? '高' : '低'} ${Math.abs(Math.round(delta * 100) / 100)}（阈值 ${threshold}）：标为劣化，需复核`
        : `本章「${metric.label}」${current}，历史中位数 ${median}（阈值 ${threshold}）：未见劣化`,
    };
  }

  /** 一次性把全部指标算出来（界面用；样本不足的指标各自带 note）。 */
  function overviewOf(runs) {
    return METRICS.map((m) => {
      const s = seriesOf(runs, m.id);
      const t = trendOf(s.points);
      return { metric: m.id, label: m.label, written: s.points.filter((p) => p.value !== 0).length, series: s.points, trend: t };
    });
  }

  return { VERSION, MIN_SAMPLES, METRICS, metricOf, seriesOf, trendOf, chapterRegression, overviewOf };
});
