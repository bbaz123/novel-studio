/**
 * ai/http/validation.mjs —— 输入校验的单一入口（P11，2026-10-18）。
 *
 * 为什么需要它：`Number(value)` 会静默接受 `'12abc'`（NaN）、`'1e3'`、`true`、`[]`；
 * 而很多调用点的写法是 `if (workId) { ...过滤... }`——一旦 workId 变成 NaN，
 * 过滤条件被整段跳过，GET 退化成**全库查询**（比报错更糟：它看起来成功了）。
 *
 * 本模块只做纯函数判定，不碰数据库、不碰 HTTP：拒绝 NaN / Infinity / 小数 / 负数 /
 * 空串 / 科学计数法 / 前后夹带非数字字符；合法 `null`/`undefined`（可空字段）由调用方
 * 通过 `parseOptionalPositiveInteger` 显式表达，而不是被一概拒绝。
 */
export class ValidationError extends Error {
  constructor(message, { code = 'INVALID_ARGUMENT', status = 400 } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 严格解析正整数：数字或纯十进制数字串（不接受 `+5`、`1e3`、`1.0`、`007` 之外的写法）。
 * @returns {number|null}
 */
export function parsePositiveInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 可空正整数：`null` / `undefined` / `''` → null（合法缺省）；
 * 其它值必须是严格正整数，否则也返回 null —— 调用方用 `requirePositiveInteger` 区分"缺省"与"非法"。
 */
export function parseOptionalPositiveInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  return parsePositiveInteger(value);
}

/** 必须为正整数：非法直接抛 400（可用 `e.status` 映射响应）。 */
export function requirePositiveInteger(value, label = '参数') {
  const n = parsePositiveInteger(value);
  if (n === null) throw new ValidationError(`${label}必须是正整数`);
  return n;
}

/** LIKE 模式转义：`%` / `_` / `\` 按字面匹配（必须配合 SQL 里的 `ESCAPE '\'`）。 */
export function escapeLike(text) {
  return String(text ?? '').replace(/[\\%_]/g, (m) => '\\' + m);
}

/** 生成 `%keyword%` 模式（已转义）。 */
export function likeContainsPattern(keyword) {
  return `%${escapeLike(keyword)}%`;
}
