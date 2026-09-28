/**
 * 运行时上下文贡献记录（2026-09-27，R05）——「最终请求里到底有什么、为什么有、占多少」。
 *
 * 定位：**附加式观测**，不是第二个 Prompt Compiler。
 *   · 它不改装配结果、不改预算、不改层顺序：输入是装配器已经产出的 manifest/stats 与召回 payload；
 *   · 它回答任务书 §8 的四个问题：启用了哪些小说规则（DSH 侧规则 hash）？OV 召回了什么来源？
 *     与宿主召回是否重复（来源感知去重）？是否突破预算或混入跨书/未来信息（omitted 原因）？
 *   · 默认只记**结构**：来源 id、规则版本/hash、长度（单位 char）、去重标识、使用/省略原因；
 *     绝不记录完整正文 / 完整 Prompt / API Key / 审批凭据。需要"最终请求证据"时用隔离夹具。
 *
 * 去重语义（来源感知）：
 *   · 只对声明了 `dedup: true` 且带 content_hash 的条目做内容级比较（宿主层 vs OV 召回）；
 *   · 默认**只标注不删除**（`dedup_action: 'off'`）——保持旧作品既有生成行为不变；
 *   · 作者显式打开 `ov_recall_dedup` 后，重复的召回条目才从上下文里去掉，并在记录里写明省下的字数。
 */
import { sha16 } from '../story-state/hash.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const CONTRIBUTION_UNIT = 'char';
const MAX_RECORDS = 60;

const ring = [];
let seq = 0;

/** 内容指纹（口径与宿主其它 hash 一致；不用于安全，只用于去重/比对）。 */
export function contentHash(text) {
  return sha16(String(text || '').trim());
}

/** 去重比较用的归一化文本：去空白（换行/空格不影响"是不是同一段资料"）。 */
export function normalizeForDedup(text) {
  return String(text || '').replace(/\s+/g, '');
}

/**
 * 「这段召回转录是不是已经在宿主层里了」——重复判定口径（单点，宿主与记录共用）：
 *   · 归一化（去空白）后互相包含，且命中内容不短于 minChars（太短的片段包含是噪声）；
 *   · 返回重复的宿主层 id；没有重复返回 null。
 */
export function findDuplicateLayer(hitText, layers, { minChars = 40 } = {}) {
  const hit = normalizeForDedup(hitText);
  if (hit.length < minChars) return null;
  for (const l of Array.isArray(layers) ? layers : []) {
    if (!l || !l.text) continue;
    const body = normalizeForDedup(l.text);
    if (!body) continue;
    if (body.includes(hit) || hit.includes(body)) return l.id || l.label || '';
  }
  return null;
}

/**
 * 从装配器 manifest 的**实测结果**派生宿主层贡献条目（不另抄一份可能漂移的说明）。
 * @param {object} m manifest 行
 */
export function layerContribution(m, { workId = 0, chapterId = null, mode = 'full', text = '' } = {}) {
  return {
    source: 'host_context_layer',
    rule_id: String(m.id || ''),
    rule_version: 'host-contract',
    content_hash: contentHash(text),
    chars: Number(m.emitted) || 0,
    unit: CONTRIBUTION_UNIT,
    estimated_tokens: Number(m.estimatedTokens) || 0,
    work_id: Number(workId) || 0,
    chapter_id: chapterId ? Number(chapterId) : null,
    session: '',
    status: 'canon',
    dedup: true,
    dedup_id: `layer:${m.id}`,
    used: true,
    omitted_reason: '',
    duplicate_of: '',
    dedup_action: 'off',
    mode,
    note: m.outcomeReason || '',
  };
}

/** 进入上下文的召回调目 → 贡献条目（供"与宿主层是否重复"的标注与去重统计）。 */
export function recallHitContribution(h, { workId = 0, chapterId = null, dedupAction = 'off' } = {}) {
  const text = String((h && h.text) || '');
  return {
    source: 'openviking_recall',
    rule_id: String((h && (h.source_meta && h.source_meta.rel || h.uri)) || ''),
    rule_version: '',
    content_hash: contentHash(text),
    chars: text.length,
    unit: CONTRIBUTION_UNIT,
    estimated_tokens: 0,
    work_id: Number(workId) || 0,
    chapter_id: chapterId ? Number(chapterId) : null,
    session: '',
    status: (h && h.source_meta && h.source_meta.canon) === 'candidate' ? 'candidate' : 'canon',
    dedup: true,
    dedup_id: `ov:${(h && h.uri) || ''}`,
    used: true,
    omitted_reason: '',
    duplicate_of: '',
    dedup_action: dedupAction,
    mode: '',
    note: '',
  };
}

/** 被来源校验拦下 / 被去重省略的召回调目 → 记录条目（used:false + 原因）。 */
export function omittedRecallContribution(o, { workId = 0, chapterId = null, dedupAction = 'off' } = {}) {
  return {
    source: 'openviking_recall',
    rule_id: String(o.rel || o.uri || ''),
    rule_version: '',
    content_hash: '',
    chars: 0,
    unit: CONTRIBUTION_UNIT,
    estimated_tokens: 0,
    work_id: Number(workId) || 0,
    chapter_id: chapterId ? Number(chapterId) : null,
    session: '',
    status: 'canon',
    dedup: false,
    dedup_id: `ov:${o.uri || ''}`,
    used: false,
    omitted_reason: o.reason || o.code || '未进入上下文',
    duplicate_of: '',
    dedup_action: dedupAction,
    mode: '',
    note: '',
  };
}

/**
 * 来源感知去重：对声明 dedup 且 content_hash 相同的条目，保留**先出现**的那一条
 * （宿主层先于召回层），后续条目标记 duplicate_of；apply=true 时后续条目标记 used=false。
 * 口径：只有**有内容的条目**（chars > 0 且 hash 非空）参与比较——零长/空层不算"重复"，
 * 否则空层之间会互相标记，把 duplicates 计数变成噪声（审计时看不出真实重复）。
 * @returns {{entries:object[], duplicates:object[], saved_chars:number}}
 */
export function dedupeContributions(entries, { apply = false, reason = '与先出现的同源内容重复（来源感知去重）' } = {}) {
  const byHash = new Map();
  const out = [];
  const duplicates = [];
  let saved = 0;
  for (const e of entries) {
    const h = (e.dedup === true && Number(e.chars) > 0) ? String(e.content_hash || '') : '';
    if (!h) { out.push(e); continue; }
    const first = byHash.get(h);
    if (!first) { byHash.set(h, e); out.push(e); continue; }
    const dup = { ...e, duplicate_of: first.dedup_id, omitted_reason: reason, dedup_action: apply ? 'dropped' : 'marked' };
    if (apply) { dup.used = false; saved += Number(e.chars) || 0; }
    duplicates.push(dup);
    out.push(dup);
  }
  return { entries: out, duplicates, saved_chars: saved };
}

/** DSH 侧规则/技能/画像的贡献条目（由宿主读 bundle 声明后传入，不记录正文）。 */
export function dshContribution({ id, kind = 'rules', version = '', text = '', workId = 0, chapterId = null, session = '', note = '' } = {}) {
  return {
    source: kind === 'rules' ? 'dsh_bundle_rules' : `dsh_${kind}`,
    rule_id: String(id || ''),
    rule_version: String(version || ''),
    content_hash: contentHash(text),
    chars: String(text || '').length,
    unit: CONTRIBUTION_UNIT,
    estimated_tokens: 0,
    work_id: Number(workId) || 0,
    chapter_id: chapterId ? Number(chapterId) : null,
    session: String(session || ''),
    status: 'rules',
    dedup: false,
    dedup_id: `${kind === 'rules' ? 'rules' : kind}:${id}:${contentHash(text).slice(0, 8)}`,
    used: true,
    omitted_reason: '',
    duplicate_of: '',
    dedup_action: 'off',
    mode: '',
    note: String(note || ''),
  };
}

/**
 * 组装一次记录（纯函数）。
 * @param {{workId:number, chapterId:(number|null), mode:string, requestId:string, contextId:string,
 *          manifest:object[], stats:object, entries:object[], overflow:object|null}} args
 */
export function buildContributionRecord({
  workId = 0, chapterId = null, mode = 'full', requestId = '', contextId = '',
  manifest = [], stats = {}, entries = [], overflow = null, session = '',
} = {}) {
  const { entries: deduped, saved_chars: savedByHash } = dedupeContributions(entries);
  const totalChars = deduped.reduce((n, e) => n + (e.used ? Number(e.chars) || 0 : 0), 0);
  // 省下字数与重复计数取**标记后的结果**，而不是只看本函数自己标了几条：
  // 装配器按来源感知去重**实际省略**的召回（dedup_action='dropped'）同样要入账，
  // 否则记录会说"没有省下任何字数"，而真实请求里那一段确实没进去。
  const savedChars = Math.max(
    savedByHash,
    deduped.filter((e) => e.used === false && e.dedup_action === 'dropped').reduce((n, e) => n + (Number(e.chars) || 0), 0),
  );
  const duplicateCount = deduped.filter((e) => !!e.duplicate_of).length;
  return {
    request_id: String(requestId || ''),
    context_id: String(contextId || ''),
    work_id: Number(workId) || 0,
    chapter_id: chapterId ? Number(chapterId) : null,
    session: String(session || ''),
    mode,
    unit: CONTRIBUTION_UNIT,
    budget: Number(stats.budget) || 0,
    length: Number(stats.length) || 0,
    over_budget: Boolean(overflow),
    layer_count: Number(stats.layerCount) || 0,
    truncated_layers: Number(stats.truncatedLayers) || 0,
    dropped_chars: Number(stats.droppedChars) || 0,
    estimated_tokens: Number(stats.estimatedTokens) || 0,
    entries: deduped,
    duplicates: duplicateCount,
    saved_chars: savedChars,
    layer_ids: manifest.map((m) => m.id),
  };
}

/** 存入进程内环形缓冲（重启即清空——它是运行观测，不是持久账本）。 */
export function recordContributions(record) {
  if (!record) return null;
  seq += 1;
  const stored = { seq, recorded_at: new Date().toISOString(), ...record };
  ring.push(stored);
  while (ring.length > MAX_RECORDS) ring.shift();
  return stored;
}

export function latestContributions({ workId = 0, chapterId = null, session = '' } = {}) {
  const wid = Number(workId) || 0;
  const cid = chapterId ? Number(chapterId) : null;
  const sid = String(session || '');
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    const r = ring[i];
    if (r.work_id !== wid) continue;
    if (cid !== null && r.chapter_id !== cid) continue;
    if (sid && r.session !== sid) continue;
    return r;
  }
  return null;
}

export function listContributions(limit = 20) {
  return ring.slice(-Math.min(MAX_RECORDS, Math.max(1, Number(limit) || 20)));
}

/**
 * 读 DSH bundle 的规则声明文件 → 贡献条目的**原始材料**（id / 版本 / 文本）。
 * 宿主只把这些材料交给 dshContribution() 取 hash 与长度；文本本身不写进记录。
 * bundleDir 不存在或缺文件时如实为空（不编造"已加载"）。
 */
export function dshBundleRuleEntries(bundleDir) {
  const base = String(bundleDir || '');
  if (!base) return [];
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  let plugin = {};
  try { plugin = JSON.parse(read(path.join(base, 'plugin.json')) || '{}'); } catch { plugin = {}; }
  const version = String(plugin.version || '');
  const entries = [];
  for (const f of ['agent.cordis.yml', 'cordis.patch.yml', 'headless-cordis.patch.yml']) {
    const text = read(path.join(base, f));
    if (text === null) continue;
    entries.push({ id: f, version, text, note: 'DSH bundle 规则文件（只记 hash/长度）' });
  }
  const tools = (plugin.tools || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
  entries.push({ id: 'plugin.tools', version, text: JSON.stringify(tools), note: '插件工具面清单' });
  return entries;
}
