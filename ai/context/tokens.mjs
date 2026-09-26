/**
 * tokens.mjs —— **上下文规模的估算**（不是 tokenizer）。
 *
 * ── 它为什么存在，以及它**不**用来做什么 ──────────────────────────────────────
 * 需求里要求清单能给出 `estimated_tokens`。但本项目所有**预算与裁剪**一律以**字符**核算
 * （`layers.mjs` 的 cap / TOTAL_BUDGET / computeFloor 全是字符）——那是可核算、可复现、
 * 可离线断言的量。换一套单位去驱动裁剪，等于把整套契约的基准悄悄改掉。
 *
 * 所以本模块只回答一个问题：「这次的上下文，模型大概要读多少 token」，
 * 用于**横向比较与容量判断**（例如"这一章的上下文比上一章重了 30%"），
 * **绝不**参与任何预算、裁剪、路由或重试决策。
 *
 * ── 估算规则（刻意保守、可解释）──────────────────────────────────────────────
 *   中日韩字符（CJK 统一表意 + 全角标点等）：约 1 token / 字
 *   其余（拉丁字母、数字、空白、符号）：约 1 token / 4 字符
 * 这是公开经验值区间的偏保守一侧（真实分词器上中文约 0.6–1 token/字，
 * 英文约 0.25–0.3 token/字符）。**标为估算就是估算**：任何"精确"承诺都是假的，
 * 所以取整到百位并在返回值里带上 note。
 */

/**
 * CJK 区段（**与旧版正则逐段相同**，只是换成数值比较）。
 *
 * 为什么不是正则：这段估算每装配一次就要走一遍全部上下文字符（20k+），
 * 第一版用「逐字符 `regex.test(ch)`」实现，冷路径实测多花约 2ms（p50 25→27ms）。
 * 同一批区段改成数值判断后结果逐字节不变、开销回到噪声内。
 * 语义保持不变：按 **UTF-16 码元**判定（与不带 `u` 标志的正则完全一致），
 * 因此增补平面字符仍计入 other，`other` 仍等于 `s.length - cjk`。
 */
const CJK_RANGES = [
  [0x1100, 0x11FF], [0x2E80, 0x303F], [0x3040, 0x30FF], [0x3130, 0x318F],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF],
];

function isCjkCodeUnit(c) {
  for (let i = 0; i < CJK_RANGES.length; i++) {
    const [lo, hi] = CJK_RANGES[i];
    if (c >= lo && c <= hi) return true;
  }
  return false;
}

/** @param {string} text @returns {{tokens:number, cjk:number, other:number}} */
export function estimateTokensDetailed(text = '') {
  const s = String(text || '');
  let cjk = 0;
  for (let i = 0; i < s.length; i++) if (isCjkCodeUnit(s.charCodeAt(i))) cjk++;
  const other = s.length - cjk;
  const tokens = Math.ceil(cjk * 1 + other / 4);
  return { tokens, cjk, other };
}

/**
 * 估算 token 数（**取整到百位**：这个量级的估算不该假装有 1 位精度）。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text = '') {
  const { tokens } = estimateTokensDetailed(text);
  return tokens < 100 ? tokens : Math.round(tokens / 100) * 100;
}

/** 估算口径的自我说明，随清单一起下发，避免消费方把它当成精确值。 */
export const TOKEN_ESTIMATE_NOTE =
  '按 CJK 1 字≈1 token、其余 4 字符≈1 token 估算并取整到百位；仅供横向比较，'
  + '预算与裁剪一律以字符核算（见 ai/context/layers.mjs）';