/**
 * ai/quality-auditor/snapshots.mjs —— 冻结输入与分页读取（纯函数 + 少量 hash）。
 *
 * 为什么"冻结"不是把正文复制进 run 行：run 是账本，正文是作者资产。这里只冻结
 * **hash + 清单 + 资源正文的内存副本**（由协调器在创建 run 时放进 manifest），
 * 数据库只存清单与 hash。审计过程中 DSH 通过 token 分页读取，读到的就是创建那一刻的内容。
 *
 * 分页是硬要求（方案 §4.2 / RV-11）：一次性把几万字塞进工具结果会挤爆上下文，
 * 而且无法证明"全文都被读过"。这里给出 cursor/limit + 服务端上限 + 覆盖区间记录。
 */
import { createHash } from 'node:crypto';
import { LIMITS, RESOURCE_NAMES, auditError, ERROR_CODES } from './contracts.mjs';

export function sha256Of(text) {
  return 'sha256:' + createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/** 只保留合法资源；字符串/对象都规范成文本。 */
export function normalizeResources(input = {}) {
  const out = {};
  for (const name of RESOURCE_NAMES) {
    if (!(name in input)) continue;
    const v = input[name];
    if (v == null) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    out[name] = text;
  }
  return out;
}

/** manifest：每个资源的长度、hash、页数。不含正文。 */
export function buildManifest(resources, requiredOutputs = ['coverage', 'findings', 'verdict']) {
  const list = Object.keys(resources).map((name) => {
    const text = resources[name];
    return {
      name,
      chars: text.length,
      sha256: sha256Of(text),
      pages: Math.max(1, Math.ceil(text.length / LIMITS.defaultPageChars)),
    };
  });
  return { contract_version: 'novel-quality-audit.v1', resources: list, required_outputs: requiredOutputs };
}

/** 上下文 hash：所有资源按名字排序后串起来（任一变化都会变）。 */
export function contextHash(resources) {
  const names = Object.keys(resources).sort();
  const parts = names.map((n) => n + ':' + sha256Of(resources[n]));
  return sha256Of(parts.join('\n'));
}

/**
 * 分页读取。
 * @returns {{ok:true, name:string, cursor:number, limit:number, next_cursor:number|null, total_chars:number, chars:number, text:string, sha256:string, complete:boolean}|{ok:false, code:string, detail:string}}
 */
export function readResourceSlice(resources, name, cursor = 0, limit = LIMITS.defaultPageChars) {
  const key = String(name || '');
  if (!Object.prototype.hasOwnProperty.call(resources, key)) {
    return auditError(ERROR_CODES.AUDIT_SCOPE_MISMATCH, `资源不存在或不在本次审计范围内：${key}`);
  }
  const text = String(resources[key] || '');
  const start = Math.max(0, Math.floor(Number(cursor) || 0));
  const size = Math.max(1, Math.min(LIMITS.maxPageChars, Math.floor(Number(limit) || LIMITS.defaultPageChars)));
  if (start > text.length) {
    return auditError(ERROR_CODES.AUDIT_CONTRACT_INVALID, `cursor ${start} 超过资源长度 ${text.length}`);
  }
  const end = Math.min(text.length, start + size);
  const slice = text.slice(start, end);
  return {
    ok: true,
    name: key,
    cursor: start,
    limit: size,
    next_cursor: end < text.length ? end : null,
    total_chars: text.length,
    chars: slice.length,
    text: slice,
    sha256: sha256Of(slice),
    complete: start === 0 && end >= text.length,
  };
}

/**
 * 合并 coverage 区间（把多次分页读的 [start,end) 归并成连续段）。
 * 用于判定 RV-11「长章分页读取后 coverage ranges 无空洞」。
 */
export function mergeRanges(ranges = []) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .filter((r) => Array.isArray(r) && r.length === 2 && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])))
    .map((r) => [Math.max(0, Number(r[0])), Math.max(0, Number(r[1]))])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (!last) { out.push([...r]); continue; }
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** 覆盖是否完整：合并后必须从 0 开始、连续到 total，且中间无空洞。 */
export function rangesCover(ranges, totalChars) {
  const merged = mergeRanges(ranges);
  const total = Number(totalChars) || 0;
  if (!merged.length) return { ok: false, gaps: [[0, total]] };
  if (merged[0][0] > 0) return { ok: false, gaps: [[0, merged[0][0]]] };
  const gaps = [];
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i][0] > merged[i - 1][1]) gaps.push([merged[i - 1][1], merged[i][0]]);
  }
  const lastEnd = merged[merged.length - 1][1];
  if (lastEnd < total) gaps.push([lastEnd, total]);
  return { ok: gaps.length === 0, gaps };
}
