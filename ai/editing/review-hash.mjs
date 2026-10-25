/**
 * ai/editing/review-hash.mjs —— 审稿底本的 hash 身份（服务端唯一实现，零依赖、可离线断言）。
 *
 * 为什么需要它（2026-10-23 现场）：活库 `chapter_reviews#32` 的 `base_hash` 是**空字符串**。
 * 报告里存了 `base_text`（作者实际被审的那篇），但没有任何指纹把它和"后来的修稿快照"绑在一起，
 * 于是"这份审稿是对哪一版正文做的"只能靠文本长度与肉眼比对。
 *
 * 口径（必须与前端一致，否则两边永远对不上）：
 *   · `base_hash` 用 **fnv1a32+len**，格式 `fnv1a:<hex>:<len>` —— 与
 *     `public/revision-patch.js` 的 `textFingerprint()`、`public/revision-finalize.js` 的
 *     `contentHash()` 回退分支、以及修稿计划里的 `snapshot.body_hash` **逐字同算法**；
 *   · 另存 `base_sha256`（`sha256:<hex>`）作为强摘要归档；两者用途不同，不能互相冒充。
 *   · 空底本不产生"空字符串的哈希"：`base_hash=''` 且 `state='missing'`，由调用方按 UNKNOWN 处理。
 *
 * 为什么用两种：前端没有同步 sha256（浏览器里只跑 UMD 纯函数），修稿计划与 stale 判定都用 fnv；
 * 只有 fnv 能与计划直接比对；sha256 用来做跨进程/跨版本的强校验与归档。
 */

import { createHash } from 'node:crypto';

export const REVIEW_BASE_HASH_VERSION = '1.0.0';
export const BASE_HASH_ALG = 'fnv1a32+len';

/** 与 `public/revision-patch.js#textFingerprint` 逐字相同的算法（改一侧必须同步另一侧）。 */
export function fingerprint(text) {
  const s = String(text == null ? '' : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16)}:${s.length}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/**
 * 由"被审底本"算出审稿该记的 hash。
 *
 * @param {string} text 被审正文（`quoteBase.text`，不是"现在库里的正文"）
 * @returns {{base_hash:string, base_hash_alg:string, base_sha256:string, state:'computed'|'missing', chars:number}}
 */
export function hashOfBaseText(text) {
  const s = String(text == null ? '' : text);
  if (!s.length) return { base_hash: '', base_hash_alg: '', base_sha256: '', state: 'missing', chars: 0 };
  return { base_hash: fingerprint(s), base_hash_alg: BASE_HASH_ALG, base_sha256: `sha256:${sha256Hex(s)}`, state: 'computed', chars: s.length };
}

/**
 * 保存审稿时决定最终 `base_hash`：调用方给了就用（并核对是否与底本一致），否则按底本算。
 *
 * 为什么保留"调用方给的"：修稿链路可能用另一套规范化（NSDSH）产生 `snapshot.body_hash`，
 * 服务端不能悄悄替换它；但**不一致必须留痕**（`base_hash_mismatch`），不得静默二选一。
 *
 * @param {{provided?:string, quoteBaseText?:string}} input
 */
export function resolveBaseHash({ provided = '', quoteBaseText = '' } = {}) {
  const computed = hashOfBaseText(quoteBaseText);
  const given = String(provided == null ? '' : provided).trim();
  if (!given) return { ...computed, source: computed.state === 'computed' ? 'computed_from_quote_base' : 'missing', base_hash_computed: computed.base_hash, base_hash_mismatch: false };
  return {
    ...computed,
    base_hash: given,
    base_hash_alg: given.startsWith('sha256:') ? 'sha256' : BASE_HASH_ALG,
    source: 'client',
    base_hash_computed: computed.base_hash,
    base_hash_mismatch: computed.state === 'computed' && computed.base_hash !== given,
  };
}

/**
 * 读路径：老报告没有存 hash 时，**只在内存里**由 `base_text` 派生一个，绝不改写历史行。
 *
 * @param {{base_hash?:string, base_hash_source?:string, base_sha256?:string, base_text?:string}} report
 * @returns {{base_hash:string, base_hash_alg:string, base_sha256:string, base_hash_source:string,
 *            base_hash_state:'stored'|'derived'|'missing', base_hash_mismatch:boolean}}
 */
export function derivedBaseHash(report = {}) {
  const r = report && typeof report === 'object' ? report : {};
  const stored = String(r.base_hash || '').trim();
  if (stored) {
    return {
      base_hash: stored,
      base_hash_alg: String(r.base_hash_alg || (stored.startsWith('sha256:') ? 'sha256' : BASE_HASH_ALG)),
      base_sha256: String(r.base_sha256 || ''),
      base_hash_source: String(r.base_hash_source || ''),
      base_hash_state: 'stored',
      base_hash_mismatch: false,
    };
  }
  const fromText = hashOfBaseText(r.base_text);
  if (fromText.state === 'computed') {
    return {
      base_hash: fromText.base_hash,
      base_hash_alg: fromText.base_hash_alg,
      base_sha256: fromText.base_sha256,
      base_hash_source: 'derived_on_read',
      base_hash_state: 'derived',
      base_hash_mismatch: false,
    };
  }
  return { base_hash: '', base_hash_alg: '', base_sha256: '', base_hash_source: '', base_hash_state: 'missing', base_hash_mismatch: false };
}
