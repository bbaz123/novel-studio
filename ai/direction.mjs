/**
 * direction.mjs —— 「写作方向」（direction）与召回阶段的纯契约。
 *
 * 为什么要有这个模块：direction 会同时出现在四条路径上——工具栏装配、pipeline 工具、
 * 服务器缓存键、资料/索引检索。四处各写一份「规范化 + 哈希」必然漂移（先例：
 * 模型名曾在 db.js 与 policy.mjs 各写一份）。所以：
 *   · 规范化/校验/哈希/缓存键拼接只在这里定义一次；
 *   · 本模块零 IO、零 DB、零业务依赖，可离线单测；
 *   · 前端 app.js 的镜像实现（浏览器脚本无法 import 本模块）由 frontend-test.mjs
 *     与这里逐用例对照，保证两侧口径一致。
 *
 * 边界（硬约束）：
 *   · direction 是**检索数据**，不是指令：不做任何解析、不求值、不识别工具名/路径；
 *   · direction 只影响资料召回与索引候选发现，绝不改变正典查询；
 *   · 规范化后仍为空串 = 未提供方向（调用方走原路径）。
 */
import { createHash } from 'node:crypto';

/** direction 规范化后的字符上限（Unicode 码点计数，不是 UTF-16 长度）。 */
export const DIRECTION_MAX_CHARS = 400;

/** direction 的来源枚举（仅用于审计，不作权限依据）。 */
export const DIRECTION_SOURCES = Object.freeze([
  'confirmed_blueprint', // 作者刚确认的蓝图
  'saved_blueprint',     // 已保存且仍适用当前章节的蓝图
  'agent',               // Agent 在同一次 pipeline 调用中提交
  'fallback',            // 无蓝图时由用户要求/章节信号确定性回退
]);

/** 资料召回阶段枚举。 */
export const LIBRARY_RECALL_PHASES = Object.freeze(['default', 'defer', 'direction']);

/** requestId 只是审计身份，限制长度防止被塞进日志放大。 */
export const REQUEST_ID_MAX_CHARS = 64;

/**
 * 规范化 direction：
 *   1. 非字符串（undefined/null/数字/对象）一律视为未提供 → 空串；
 *   2. 去掉 Unicode 控制字符（C0/C1，含 \u2028/\u2029），换行/制表折叠为空格；
 *   3. 首尾去空白，连续空白折叠为单个空格；
 *   4. 超长按码点截断到 400（安全上限；不抛错——检索输入不该让写作中断）。
 * 相同输入输出完全相同；空串输出空串。
 */
export function normalizeDirection(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const chars = Array.from(s);
  if (chars.length > DIRECTION_MAX_CHARS) s = chars.slice(0, DIRECTION_MAX_CHARS).join('');
  return s;
}

/** 稳定哈希（sha256 前 16 位 hex）。空串 → 空串，便于缓存键缺省形态保持可读。 */
export function directionHashOf(normalized) {
  const s = typeof normalized === 'string' ? normalized : '';
  if (!s) return '';
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

/** 阶段规范化：未知值一律回退 default（旧调用不带该参数时的语义）。 */
export function normalizeLibraryRecallPhase(raw) {
  return LIBRARY_RECALL_PHASES.includes(raw) ? raw : 'default';
}

/** 来源规范化：未知值回退空串（审计字段宁缺毋滥，不伪装成已知来源）。 */
export function normalizeDirectionSource(raw) {
  return DIRECTION_SOURCES.includes(raw) ? raw : '';
}

/** requestId 规范化：控制字符（C0+C1）清理 + 按**码点**限长（不撕裂代理对）；空 → 空串。 */
export function normalizeRequestId(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, '').trim();
  const chars = Array.from(s);
  return chars.length > REQUEST_ID_MAX_CHARS ? chars.slice(0, REQUEST_ID_MAX_CHARS).join('') : s;
}

/**
 * 服务器上下文缓存键。方向进键的是**哈希**而不是全文（缓存键可能进日志/内存快照），
 * 阶段进键保证 defer / direction / default 三种装配互不误命中。
 * 无方向且 default 时输出旧键形态（`novel:w:c:mode`），便于审计对照，
 * 同时不会与「有方向」的键相撞。
 */
export function contextCacheKeyOf({ workId, chapterId = 0, mode = 'full', phase = 'default', directionHash = '' }) {
  const base = `novel:${Number(workId) || 0}:${Number(chapterId) || 0}:${String(mode || 'full')}`;
  if ((!directionHash) && phase === 'default') return base;
  return `${base}:${phase}:${directionHash || '-'}`;
}

/**
 * 缓存外部版本串：把影响装配结果、但不在进程内 dataVersion 里的外部状态拼成一个串。
 * 调用方负责给每段一个稳定的名字前缀；顺序固定（测试对账）。
 * 关键约束（本次集成点）：资料索引版本与索引 **schema 版本**必须都在这里出现，
 * 否则「索引重建/升级后仍命中旧缓存」。
 */
export function contextExternalVersionStringOf(parts = {}) {
  const seg = (name, value) => `${name}:${value === undefined || value === null ? '' : String(value)}`;
  return [
    seg('ov', parts.ovIndexedAt),
    seg('li', parts.libraryIndexVersion),
    seg('ls', parts.libraryIndexSchema),
    seg('ni', parts.novelIndexVersion),
    seg('ns', parts.novelIndexSchema),
  ].join('|');
}

/** direction 的审计摘要（不含全文——审计默认不记录完整 direction）。 */
export function directionAuditOf(direction, source = '') {
  const d = typeof direction === 'string' ? direction : '';
  return {
    used: d.length > 0,
    source: normalizeDirectionSource(source),
    hash: directionHashOf(d),
    chars: Array.from(d).length,
  };
}
