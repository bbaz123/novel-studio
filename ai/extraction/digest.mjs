/**
 * ai/extraction/digest.mjs —— S06：版本化完整请求/响应摘要（修 F07 / F08）。
 *
 * 病灶：
 *   · F07：旧 `input_hash` 只覆盖正文与状态，**没有**把"已知实体、选入状态、lineage、
 *     身份版本、模型路由"算进去 —— 于是"同一个 hash 却发出不同请求"，审计与幂等都不可靠。
 *     反向的坑同样危险：**未提供的状态不能被当成 missing**（要能区分"没有这一项"与"这一项为空"）。
 *   · F08：旧实现只对响应**前 2,000 字符**算摘要 —— 后面的内容变了摘要不变。
 *
 * 本模块把摘要定义成一个**显式版本化的契约**：
 *   REQUEST_DIGEST_VERSION = 'v2'，字段集合固定且可枚举；
 *   响应摘要基于**完整有效输出**（先按明确上限截断，再算）。
 *
 * 纪律：纯函数，不读环境、不发请求。
 */

export const REQUEST_DIGEST_VERSION = 'v2';
export const RESPONSE_DIGEST_VERSION = 'v2';

/** 与内核同族的短哈希（独立实现，避免循环依赖）。 */
export function sha16(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/** 稳定序列化：键排序、拒绝 undefined（undefined 会被 JSON 丢掉，导致"改了却没进摘要"）。 */
export function canonicalize(value) {
  if (value === undefined) throw new TypeError('DIGEST_UNDEFINED_NOT_ALLOWED');
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('DIGEST_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError('DIGEST_UNSUPPORTED_TYPE');
}

/**
 * 请求身份 v2：把"真正决定这次请求长什么样"的东西全部纳入。
 *
 * 关键设计（F07 的两个易错点）：
 *   ① **缺失 ≠ 空**：用 `stateProvided` 显式区分"调用方没有提供状态"
 *      与"提供了但是空表"。未提供时摘要里记 `null`，绝不伪装成 `{}`；
 *   ② **顺序不敏感**：已知实体与状态表按内容排序后再入摘要，
 *      否则"同一批数据换了顺序"会被误判成不同请求。
 */
export function requestDigestV2({
  system = '',
  user = '',
  knownEntities = null,
  selectedState = null,
  lineage = null,
  identityVersion = '',
  modelRoute = '',
  extractionVersion = '',
} = {}) {
  const payload = {
    v: REQUEST_DIGEST_VERSION,
    system: String(system || ''),
    user: String(user || ''),
    // 未提供 → null（不是 [] / {}）；提供了空数组 → []。两者必须不同。
    known_entities: knownEntities === null || knownEntities === undefined
      ? null
      : [...new Set((Array.isArray(knownEntities) ? knownEntities : []).map((x) => String(x)))].sort(),
    selected_state: selectedState === null || selectedState === undefined
      ? null
      : (() => {
        const keys = Object.keys(selectedState).sort();
        const out = {};
        for (const k of keys) out[k] = canonicalize(selectedState[k]);
        return out;
      })(),
    lineage: lineage === null || lineage === undefined ? null : canonicalize(lineage),
    identity_version: String(identityVersion || ''),
    model_route: String(modelRoute || ''),
    extraction_version: String(extractionVersion || ''),
  };
  return { version: REQUEST_DIGEST_VERSION, digest: sha16(canonicalize(payload)), payload };
}

/**
 * 响应摘要 v2：基于**完整有效输出**。
 *
 * @param raw 原始响应（字符串或对象）
 * @param maxChars 明确上限（超出才算"超限"，并如实标 overLimit）
 */
export function responseDigestV2(raw, { maxChars = 200000 } = {}) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  const limit = Math.max(1, Number(maxChars) || 200000);
  const overLimit = text.length > limit;
  const body = overLimit ? text.slice(0, limit) : text;
  return {
    version: RESPONSE_DIGEST_VERSION,
    digest: sha16(body),
    length: text.length,
    truncatedLength: body.length,
    overLimit,
  };
}
