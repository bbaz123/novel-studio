/*
 * 作品级质量规则档案 + 跨作品模板（quality-profile）—— 纯函数、零依赖（UMD）。
 *
 * 用于 v1.2.4 方案 P2：
 *   · 「可配置作品级质量规则档案」——不同作品对"篇幅/禁忌/硬锚点"的要求不同，
 *     这些规则必须**能被验收器读到**，否则只是又一份没人用的配置；
 *   · 「跨作品质量模板及规则迁移」——把一部作品的档案导出成模板、在另一部作品导入。
 *
 * 三条纪律：
 *   ① 档案只能**加强**、不能削弱安全边界：它不能关掉语义复验、不能放开授权跨度、
 *      不能改自动复修上限（那些是产品门禁，不是作品偏好）；
 *   ② 导入是**白名单**合并：未知键一律丢弃并报出来（避免老模板悄悄注入新语义）；
 *   ③ 导入不写库、不产生副作用：调用方拿到 profile 后自行决定存到哪里。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelQualityProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const SCHEMA = 'quality-profile/1';
  const TEMPLATE_SCHEMA = 'quality-template/1';

  /** 白名单：只有这些键会被接受。刻意不包含 auto_repair rounds / semantic verify 开关等门禁项。 */
  const ALLOWED_KEYS = [
    'target_words',        // 本章目标字数（写作与审稿共用口径）
    'hard_min_chars',      // 硬性字数下限（0 = 不硬性）
    'required_terms',      // 必须落地到正文的字面（纪年/编号）
    'forbidden_patterns',  // 正文不得出现的字面
    'ai_flavor_max',       // AI 味信号上限（超出只提示，不阻断）
    'timeline_strict',     // 时序问题是否按硬事实处理
    'note',                // 作者备注（纯文本，会上界面）
  ];

  const textOf = (x) => String(x == null ? '' : x);
  const intOf = (x, dflt = 0) => (Number.isInteger(Number(x)) && Number(x) >= 0 ? Number(x) : dflt);

  function defaults() {
    return {
      schema: SCHEMA,
      target_words: 0,
      hard_min_chars: 0,
      required_terms: [],
      forbidden_patterns: [],
      ai_flavor_max: null,
      timeline_strict: false,
      note: '',
    };
  }

  function cleanList(list, max = 40, len = 40) {
    const out = [];
    for (const x of (Array.isArray(list) ? list : [])) {
      const s = textOf(x).trim();
      if (!s || s.length > len) continue;
      if (!out.includes(s)) out.push(s);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 归一化 + 校验。返回 `errors`（丢弃的非法项）与 `ignoredKeys`（白名单外的键）。
   * **不抛异常**：导入一份坏档案不该让界面崩掉。
   */
  function normalizeProfile(raw) {
    const base = defaults();
    const errors = [];
    const ignoredKeys = [];
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { ...base };
    for (const key of Object.keys(src)) {
      if (key === 'schema' || key === 'exported_at' || key === 'from_work') continue;
      if (!ALLOWED_KEYS.includes(key)) { ignoredKeys.push(key); continue; }
      const v = src[key];
      if (key === 'target_words' || key === 'hard_min_chars') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 200000) { errors.push({ key, reason: '必须是 0–200000 的整数' }); continue; }
        out[key] = n;
      } else if (key === 'required_terms' || key === 'forbidden_patterns') {
        const list = cleanList(v);
        if (!Array.isArray(v)) errors.push({ key, reason: '必须是字符串数组' });
        else if (list.length !== v.length) errors.push({ key, reason: '有空项/过长项被丢弃' });
        out[key] = list;
      } else if (key === 'ai_flavor_max') {
        if (v == null || v === '') { out[key] = null; continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) { errors.push({ key, reason: '必须是 ≥0 的数字或 null' }); continue; }
        out[key] = n;
      } else if (key === 'timeline_strict') {
        if (typeof v !== 'boolean') { errors.push({ key, reason: '必须是布尔值' }); continue; }
        out[key] = v;
      } else if (key === 'note') {
        out[key] = textOf(v).slice(0, 400);
      }
    }
    if (out.hard_min_chars && out.target_words && out.hard_min_chars > out.target_words) {
      // 硬下限高于目标字数：不是错误，但几乎必然永远不达标 —— 如实提示，不偷偷改数。
      errors.push({ key: 'hard_min_chars', reason: '硬下限高于目标字数：这会让每一章都判"篇幅未达标"' });
    }
    out.schema = SCHEMA;
    return { profile: out, errors, ignoredKeys };
  }

  /**
   * 把档案应用到 findings：只**补**验收契约里缺省的部分，不覆盖审稿已经给出的更具体值。
   * 这是"规则档案真的影响验收"的那一步（否则它只是设置页里的摆设）。
   */
  function applyProfile(findings, profile) {
    const p = profile && typeof profile === 'object' ? profile : defaults();
    const list = Array.isArray(findings) ? findings : [];
    return list.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const acc = { ...(f.acceptance && typeof f.acceptance === 'object' ? f.acceptance : {}) };
      const isLength = textOf(f.type) === 'target_length';
      const isAnchor = textOf(f.type) === 'world_time_anchor' || textOf(f.type) === 'canon_conflict';
      if (isLength && p.hard_min_chars > 0 && !(Number(acc.min_chars) > 0)) acc.min_chars = p.hard_min_chars;
      if (isAnchor && p.required_terms.length) {
        acc.must_contain = cleanList([...(Array.isArray(acc.must_contain) ? acc.must_contain : []), ...p.required_terms]);
      }
      return { ...f, acceptance: acc };
    });
  }

  /** 违规字面检查（纯文本，确定性）：返回命中项，不给"建议改写"。 */
  function scanForbidden(text, profile) {
    const p = profile && typeof profile === 'object' ? profile : defaults();
    const s = textOf(text);
    const hits = [];
    for (const pat of (Array.isArray(p.forbidden_patterns) ? p.forbidden_patterns : [])) {
      const at = s.indexOf(pat);
      if (at >= 0) hits.push({ pattern: pat, index: at, quote: s.slice(Math.max(0, at - 12), at + pat.length + 12) });
    }
    return hits;
  }

  /** 导出成模板（确定性输出：不加时间戳，便于逐字比对与版本控制）。 */
  function exportTemplate(profile) {
    const { profile: p } = normalizeProfile(profile);
    const rules = {};
    for (const key of ALLOWED_KEYS) if (key !== 'note') rules[key] = p[key];
    return { schema: TEMPLATE_SCHEMA, rules, note: p.note };
  }

  /**
   * 导入模板：白名单合并到当前档案。
   * @returns {{ok:boolean, profile:object, errors:Array, ignoredKeys:string[], reason?:string}}
   */
  function importTemplate(input, current) {
    let obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (_) { return { ok: false, reason: 'JSON_INVALID', profile: normalizeProfile(current).profile, errors: [], ignoredKeys: [] }; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, reason: 'NOT_OBJECT', profile: normalizeProfile(current).profile, errors: [], ignoredKeys: [] };
    }
    if (textOf(obj.schema) && textOf(obj.schema) !== TEMPLATE_SCHEMA) {
      return { ok: false, reason: 'SCHEMA_MISMATCH', profile: normalizeProfile(current).profile, errors: [{ key: 'schema', reason: `期望 ${TEMPLATE_SCHEMA}` }], ignoredKeys: [] };
    }
    const rules = obj.rules && typeof obj.rules === 'object' ? obj.rules : obj;
    const merged = { ...normalizeProfile(current).profile, ...normalizeProfile(rules).profile };
    const norm = normalizeProfile(merged);
    return { ok: true, profile: norm.profile, errors: norm.errors, ignoredKeys: norm.ignoredKeys };
  }

  /** 两份档案的差异（跨作品迁移时告诉作者"会改到什么"）。 */
  function diffProfiles(a, b) {
    const A = normalizeProfile(a).profile;
    const B = normalizeProfile(b).profile;
    const out = [];
    for (const key of ALLOWED_KEYS) {
      const va = Array.isArray(A[key]) ? A[key] : A[key];
      const vb = Array.isArray(B[key]) ? B[key] : B[key];
      const same = JSON.stringify(va) === JSON.stringify(vb);
      if (!same) out.push({ key, from: va, to: vb });
    }
    return out;
  }

  return { VERSION, SCHEMA, TEMPLATE_SCHEMA, ALLOWED_KEYS, defaults, normalizeProfile, applyProfile, scanForbidden, exportTemplate, importTemplate, diffProfiles };
});
