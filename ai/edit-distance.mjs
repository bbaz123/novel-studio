// 编辑距离：衡量「AI 草稿 → 作者最终正文」改了多少。
//
// 为什么需要：P5 的埋点里 `edit_distance` 一直是 NULL，而它恰恰是**唯一能回答
// 「上下文质量有没有变好」**的指标——采纳率只说明用不用，改了多少说明**用得顺不顺**。
//
// 为什么不在弹窗采纳那一刻量：结果弹窗里的正文是**只读预览**（`ai-apply-preview`），
// 采纳写回正文必然等于草稿，那一刻量恒为 0、毫无信息量。所以测量点放在
// **作者改动章节后保存**时（`PUT /api/chapters/:id`），此时才有"改了多少"可言。
//
// 纯模块、零依赖、无副作用：可离线单测（见 .p1-baseline/test-edit-distance.mjs）。

/**
 * 精确 Levenshtein 的规模上限（lenA × lenB 的格子数）。
 * 5000×5000=25M 格：两行 DP + Int32Array 实测在百毫秒量级，可以放在保存请求里。
 * 超过它就走 bigram 近似——两者单位都是"改动了多少个字符"，可一起求平均。
 */
export const EXACT_MAX_CELLS = 25_000_000;

/** 经典两行 DP 的 Levenshtein 距离（字符级；对中文按字计）。 */
export function levenshtein(a, b) {
  const A = String(a ?? '');
  const B = String(b ?? '');
  const n = A.length;
  const m = B.length;
  if (n === 0) return m;
  if (m === 0) return n;

  // 让列数取较短的一边：内存 O(min(n,m))
  const [short, long] = n <= m ? [A, B] : [B, A];
  const len = short.length;
  let prev = new Int32Array(len + 1);
  let cur = new Int32Array(len + 1);
  for (let j = 0; j <= len; j++) prev[j] = j;

  for (let i = 1; i <= long.length; i++) {
    cur[0] = i;
    const ci = long.charCodeAt(i - 1);
    for (let j = 1; j <= len; j++) {
      const cost = short.charCodeAt(j - 1) === ci ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[len];
}

function bigramCounts(s) {
  const counts = new Map();
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  return counts;
}

/**
 * bigram 近似距离：按字符二元组重合度（Dice 系数）折算成"改动了多少个字符"。
 * 用于超长文本——O(n)，与长度线性相关。
 */
export function bigramDiceDistance(a, b) {
  const A = String(a ?? '');
  const B = String(b ?? '');
  const ca = bigramCounts(A);
  const cb = bigramCounts(B);
  let totalA = 0;
  for (const v of ca.values()) totalA += v;
  let totalB = 0;
  for (const v of cb.values()) totalB += v;

  // ⚠️ 单字符（或长度为 1）的文本没有二元组：denom=0 时 Dice 会退化成 1（相似度满分），
  // 于是 "x" vs "y" 会被算成距离 0 —— 明显错误。这里显式退回逐字比较。
  if (totalA === 0 && totalB === 0) {
    return A === B ? 0 : Math.max(A.length, B.length);
  }
  let inter = 0;
  for (const [g, n] of ca) inter += Math.min(n, cb.get(g) || 0);
  const denom = totalA + totalB;
  const sim = denom ? (2 * inter) / denom : 0;
  return Math.round(Math.max(A.length, B.length) * (1 - sim));
}

/**
 * 统一入口：返回 `{ distance, method }`。
 * `distance` 的单位始终是"改动了多少个字符"，所以不同 method 的行可以一起求平均。
 */
export function editDistance(a, b, { exactMaxCells = EXACT_MAX_CELLS } = {}) {
  const A = String(a ?? '');
  const B = String(b ?? '');
  if (A === B) return { distance: 0, method: 'identical' };
  if (!A.length || !B.length) return { distance: Math.max(A.length, B.length), method: 'empty' };
  if (A.length * B.length <= exactMaxCells) {
    return { distance: levenshtein(A, B), method: 'levenshtein' };
  }
  return { distance: bigramDiceDistance(A, B), method: 'bigram-dice' };
}

/** 相对改动比例（0..1），便于跨长度比较；长度为 0 时返回 null（不下结论）。 */
export function editRatio(distance, lengthA, lengthB) {
  const denom = Math.max(Number(lengthA) || 0, Number(lengthB) || 0);
  if (!denom) return null;
  const r = Number(distance) / denom;
  return r < 0 ? 0 : (r > 1 ? 1 : Number(r.toFixed(4)));
}
