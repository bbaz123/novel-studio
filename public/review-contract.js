/*
 * 审稿契约 v3（review.v3）——纯函数、零依赖、浏览器与 Node 共用（UMD）。
 *
 * 为什么必须有这一层（方案 §1）：
 *   旧链路里 `parseReviewText()` 把 `issues` 拍平成字符串数组，而 `findings` 保留模型给的
 *   `R-0001`。于是"作者勾选的问题"只有数组下标身份（1、2、3），"结构化 finding"有自己的 ID，
 *   两者在 `revisionFindingsFor()` 处对不上，命中失败后**静默退回 legacy 空证据**——
 *   多位置授权、逐字引用、验收条件全部丢失，修稿可能只改一处/改错位置，而且事后无法证明修好。
 *   这不是界面编号问题，是接口缺陷：身份不稳定，下游所有"精确修复"都失去依据。
 *
 * 本模块确立唯一、稳定、从审稿到终验不变的 issue 身份链：
 *   finding.id = review.issues[].id = checkbox data-review-issue-id = revision_selection.issue_id
 *     = revision_plan.finding_id = patch.issue_id = semantic_verification.issue_id
 *     = quality_audit_item.issue_id = UI 最终状态行 issue_id
 *
 * 边界（刻意写死）：
 *   · 只做归一化/绑定/校验，不做文学判断，不伪造证据；
 *   · 绑定顺序固定：显式 ID → 同序契约 → 失败关闭；绝不"按位置猜配"；
 *   · 旧报告保留可读（LEGACY-<review_id>-<n>），但如实标 evidence_status=legacy_missing，
 *     且最终结论不得超过 NEED_CONTEXT；
 *   · 同一份实现同时服务服务端与浏览器（仓库前端无构建步骤，两份代码必然漂移）。
 *
 * 为什么这里是唯一来源而不是 ai/editing/review-contract.mjs：
 *   `public/*.js` 是经典脚本（无构建、直接 <script> 加载），Node 侧用 `await import()` 读同一个
 *   UMD 文件即可拿到完全相同的函数。`ai/editing/review-contract.mjs` 只是把这份实现
 *   按 ESM 命名导出转出去，避免在两处各写一份判据。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelReviewContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const SCHEMA_VERSION = 'review.v3';
  const LEGACY_SCHEMA_VERSION = 'review.legacy';
  const NORMALIZATION_VERSION = 1;

  const LINK_MODES = ['explicit', 'position_contract', 'legacy'];

  /** 契约级错误码（与方案 §7.2 的服务端错误码同义）。 */
  const CODES = {
    OK: 'OK',
    DUPLICATE_ID: 'REVIEW_DUPLICATE_ID',
    ID_MAPPING_BROKEN: 'REVIEW_ID_MAPPING_BROKEN',
    FINDINGS_MISSING: 'REVIEW_FINDINGS_MISSING',
    SCHEMA_INVALID: 'REVIEW_SCHEMA_INVALID',
    SELECTION_MISSING_FINDING: 'REVIEW_SELECTION_MISSING_FINDING',
    LEGACY_NO_EVIDENCE: 'REVIEW_LEGACY_NO_EVIDENCE',
  };

  const EVIDENCE_ROLES = ['reference', 'candidate_edit'];
  const FINDING_TYPES = ['continuity', 'canon', 'repetition', 'style', 'causality', 'temporal', 'blueprint', 'character', 'world', 'other'];
  const SEVERITIES = ['high', 'medium', 'low'];

  const asString = (v) => String(v == null ? '' : v);
  const asArray = (v) => (Array.isArray(v) ? v : []);

  // ── 稳定 sha256（审稿报告指纹）──────────────────────────────────────────────
  // 为什么手写而不是用 crypto：浏览器经典脚本里没有同步的 sha256（crypto.subtle 是异步的），
  // 而 review_hash 必须能被"保存前 / 复核时"同步重算。这是 public domain 的紧凑实现。
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Hex(input) {
    const msg = typeof input === 'string' ? input : String(input == null ? '' : input);
    // UTF-8 编码（中文正文必须按字节哈希，不能按 UTF-16 码元）
    const bytes = [];
    for (let i = 0; i < msg.length; i += 1) {
      let cp = msg.codePointAt(i);
      if (cp > 0xffff) i += 1;
      else if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Array(64);
    const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i += 1) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i += 1) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  const sha256 = (s) => 'sha256:' + sha256Hex(s);

  /** 键序稳定的 JSON：同一份报告在任何序列化顺序下都得到同一个 hash。 */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }

  // ── 基础归一化 ──────────────────────────────────────────────────────────────
  function normalizeEvidence(rawList) {
    const list = asArray(rawList).length ? rawList : (rawList ? [rawList] : []);
    return asArray(list)
      .map((e) => {
        const src = e && typeof e === 'object' ? e : { quote: e };
        const quote = asString(src.quote != null ? src.quote : src.text).trim();
        return {
          span_id: asString(src.span_id).trim(),
          quote,
          role: EVIDENCE_ROLES.includes(asString(src.role)) ? asString(src.role) : 'candidate_edit',
          required: src.required !== false,
        };
      })
      .filter((e) => e.quote);
  }

  function normalizeAcceptance(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      rule: asString(src.rule).trim(),
      preserve: asArray(src.preserve).map((x) => asString(x).trim()).filter(Boolean),
      must_contain: asArray(src.must_contain).map((x) => asString(x).trim()).filter(Boolean),
      min_chars: Number.isFinite(Number(src.min_chars)) && Number(src.min_chars) > 0 ? Number(src.min_chars) : 0,
    };
  }

  /**
   * 归一化单条 finding。`index` 只用于**没有 id 时的兜底占位**（如 `R-0001` 推导），
   * 绝不用它替代业务身份：占位 id 会在 linkIssuesToFindings 里被显式标注。
   */
  function normalizeFinding(raw, index) {
    const f = raw && typeof raw === 'object' ? raw : {};
    const fallbackId = 'R-' + String(Number(index) + 1).padStart(4, '0');
    const idRaw = asString(f.id != null && f.id !== '' ? f.id : f.finding_id).trim();
    const type = asString(f.type).trim();
    return {
      id: idRaw || fallbackId,
      id_generated: !idRaw,
      title: asString(f.title || f.text).trim(),
      type: FINDING_TYPES.includes(type) ? type : 'other',
      severity: SEVERITIES.includes(asString(f.severity)) ? asString(f.severity) : 'medium',
      confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null,
      explanation: asString(f.explanation || f.detail).trim(),
      verdict: asString(f.verdict || 'unknown').trim() || 'unknown',
      counterevidence: asString(f.counterevidence).trim(),
      evidence: normalizeEvidence(f.evidence),
      acceptance: normalizeAcceptance(f.acceptance),
      legacy: false,
    };
  }

  /** @returns {{findings:Array, duplicates:string[]}} */
  function normalizeFindings(rawList) {
    const findings = asArray(rawList).map((f, i) => normalizeFinding(f, i));
    const seen = new Set();
    const duplicates = [];
    for (const f of findings) {
      if (seen.has(f.id)) duplicates.push(f.id);
      seen.add(f.id);
    }
    return { findings, duplicates };
  }

  /** issue 的稳定身份：只有**显式** id 才算身份，字符串/无 id 对象返回 ''（未知）。 */
  function reviewIssueId(issue) {
    if (issue && typeof issue === 'object' && issue.id != null && asString(issue.id).trim() !== '') return asString(issue.id).trim();
    return '';
  }

  function reviewIssueText(issue) {
    if (issue == null) return '';
    if (typeof issue === 'string') return issue.trim();
    if (typeof issue === 'object') return asString(issue.text || issue.title || issue.summary).trim();
    return asString(issue).trim();
  }

  /** 中文/英文通用：取 2-gram 集合，用于"同序文本明显不对应"的确定性判断。 */
  function bigrams(s) {
    const t = asString(s).replace(/[\s\p{P}]+/gu, '');
    const out = new Set();
    for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
    return out;
  }

  function obviouslyUnpaired(rawIssues, findings) {
    const pairs = rawIssues.map((issue, i) => {
      const it = reviewIssueText(issue);
      const f = findings[i] || {};
      const ft = asString(f.title || f.explanation).trim();
      if (!it || !ft) return true; // 任一为空：不作否定证据
      const a = bigrams(it);
      const b = bigrams(ft);
      for (const g of a) if (b.has(g)) return true;
      return false;
    });
    return pairs.length > 0 && pairs.every((ok) => !ok);
  }

  function integrityOf(code, extra = {}) {
    return {
      ok: code === CODES.OK || code === CODES.LEGACY_NO_EVIDENCE,
      code,
      // repairable 的语义是"能不能在**同一份报告**上继续精确修复"，不是"能不能重跑一次审稿"。
      // 缺 findings 的报告不能精确修复（必须重出结构化审稿），所以这里只有 OK 才是可修复的。
      repairable: code === CODES.OK,
      detail: asString(extra.detail),
      missing: asArray(extra.missing).map(String),
      duplicates: asArray(extra.duplicates).map(String),
      warnings: asArray(extra.warnings).map(String),
      legacy: code === CODES.LEGACY_NO_EVIDENCE,
    };
  }

  /**
   * 把 raw issues 绑定到结构化 findings（方案 §1.3.1 的固定绑定顺序）。
   *
   * @returns {{issues:Array, integrity:object, link_mode:string}}
   */
  function linkIssuesToFindings(rawIssues, findings) {
    const issuesIn = asArray(rawIssues);
    const fs = asArray(findings);
    const findingIds = fs.map((f) => asString(f && f.id).trim());
    const dupFindingIds = findingIds.filter((id, i) => id && findingIds.indexOf(id) !== i);

    if (dupFindingIds.length) {
      return {
        issues: [],
        integrity: integrityOf(CODES.DUPLICATE_ID, { duplicates: [...new Set(dupFindingIds)], detail: '结构化 findings 存在重复 ID，保存前拒绝' }),
        link_mode: 'none',
      };
    }
    if (!issuesIn.length) {
      return { issues: [], integrity: integrityOf(CODES.OK), link_mode: fs.length ? 'explicit' : 'none' };
    }

    const explicitAny = issuesIn.some((i) => reviewIssueId(i) !== '');
    if (explicitAny) {
      // 混合清单是**正常形态**：结构化 finding 有 id，模型额外写的 issues 行没有 id 也没有证据。
      // 只要"有 id 的那些"全部能在 findings 里找到，身份链就是完整的；没 id 的项如实标 legacy。
      const issues = issuesIn.map((i) => {
        const id = reviewIssueId(i);
        return {
          id,
          text: reviewIssueText(i),
          source: asString(i && i.source) || 'initial_review',
          link_mode: id ? 'explicit' : 'legacy',
          finding_id: id,
        };
      });
      const idSet = new Set(findingIds);
      const identified = issues.filter((x) => x.id);
      const missing = identified.filter((x) => !idSet.has(x.id)).map((x) => x.id);
      const unlinked = issues.filter((x) => !x.id).length;
      if (fs.length && missing.length) {
        return {
          issues,
          integrity: integrityOf(CODES.ID_MAPPING_BROKEN, { missing, detail: '显式 issue.id 在 findings 中找不到对应条目' }),
          link_mode: 'explicit',
        };
      }
      if (!fs.length) {
        // 身份链是完整的（每项都有稳定 id），只是没有证据 —— 这是 FINDINGS_MISSING，不是映射断裂。
        return {
          issues,
          integrity: integrityOf(CODES.FINDINGS_MISSING, { detail: '报告没有任何结构化 findings：可查看、可人工选择，但不能据此宣称精确修复' }),
          link_mode: 'explicit',
        };
      }
      return {
        issues,
        integrity: integrityOf(CODES.OK, {
          warnings: unlinked ? ['UNLINKED_ISSUES:' + unlinked + '（这些问题没有逐字证据，选中后不可精确修复）'] : [],
        }),
        link_mode: 'explicit',
      };
    }

    // 同序契约：issues 无 ID 但 findings 同序同量，且文本不是"明显不对应"。
    if (fs.length && fs.length === issuesIn.length && findingIds.every(Boolean)) {
      if (obviouslyUnpaired(issuesIn, fs)) {
        return {
          issues: [],
          integrity: integrityOf(CODES.ID_MAPPING_BROKEN, { detail: 'issues 与 findings 数量相同，但逐条文本明显不对应，拒绝按位置猜配' }),
          link_mode: 'position_contract',
        };
      }
      const issues = issuesIn.map((i, k) => ({
        id: findingIds[k],
        text: reviewIssueText(i),
        source: asString(i && i.source) || 'initial_review',
        link_mode: 'position_contract',
        finding_id: findingIds[k],
      }));
      return { issues, integrity: integrityOf(CODES.OK), link_mode: 'position_contract' };
    }

    if (!fs.length) {
      // 旧格式：issues 是纯字符串且没有 findings。保留可读，但不假装有身份/证据。
      const issues = issuesIn.map((i, k) => ({
        id: '',
        legacy_index: k + 1,
        text: reviewIssueText(i),
        source: 'legacy',
        link_mode: 'legacy',
        finding_id: '',
      }));
      return {
        issues,
        integrity: integrityOf(CODES.FINDINGS_MISSING, { detail: '旧报告没有结构化 findings：可查看，缺少逐字证据' }),
        link_mode: 'legacy',
      };
    }

    // 数量不一致 / findings 缺 id：不猜。
    return {
      issues: issuesIn.map((i, k) => ({
        id: reviewIssueId(i), text: reviewIssueText(i), source: asString(i && i.source) || 'initial_review',
        link_mode: 'explicit', finding_id: reviewIssueId(i), legacy_index: k + 1,
      })),
      integrity: integrityOf(CODES.ID_MAPPING_BROKEN, { detail: 'issues 与 findings 数量或编号不一致，无法建立稳定映射' }),
      link_mode: 'explicit',
    };
  }

  /** 整份报告的完整性校验（保存前、读取后、进入付费修稿前各跑一次）。 */
  function validateReviewIntegrity(report) {
    const r = report && typeof report === 'object' ? report : {};
    // 旧报告（review.legacy / 显式 legacy 标记）是**兼容形态**：issues 有 LEGACY id、findings 为空。
    // 这不是"身份链断裂"，而是"没有结构化证据"。把它判成 BROKEN 会让独立复核无法在存量章节上使用。
    if (r.schema_version === LEGACY_SCHEMA_VERSION || (r.integrity && r.integrity.legacy)) {
      return {
        ok: true, code: CODES.LEGACY_NO_EVIDENCE, repairable: false, legacy: true,
        errors: [], warnings: ['LEGACY_NO_EVIDENCE:旧报告缺少结构化证据，结论上限为待核验'],
        missing: [], duplicates: [],
      };
    }
    const errors = [];
    const warnings = asArray(r.integrity && r.integrity.warnings).map(String);
    const issues = asArray(r.issues);
    if (!issues.length && asArray(r.findings).length === 0) {
      return { ok: true, code: CODES.OK, repairable: true, errors, warnings, missing: [], duplicates: [] };
    }
    const ids = issues.map((i) => reviewIssueId(i));
    const dupIssueIds = ids.filter((id, i) => id && ids.indexOf(id) !== i);
    if (dupIssueIds.length) {
      errors.push(CODES.DUPLICATE_ID + ':' + [...new Set(dupIssueIds)].join(','));
      return { ok: false, code: CODES.DUPLICATE_ID, repairable: false, errors, warnings, missing: [], duplicates: [...new Set(dupIssueIds)] };
    }
    if (issues.some((i) => !reviewIssueId(i)) && r.schema_version === SCHEMA_VERSION) {
      // 没有 id 的 issue 不等于身份链断裂：这是"模型额外写的一行问题，没有逐字证据"。
      // 它如实保留为未链接项（选中后不可精确修复），但不能因此把整份报告判成不可用。
      warnings.push(CODES.FINDINGS_MISSING + ':存在没有稳定 id 的问题（无逐字证据）');
    }
    const findings = asArray(r.findings);
    const fids = findings.map((f) => asString(f && f.id).trim());
    const dupFindingIds = fids.filter((id, i) => id && fids.indexOf(id) !== i);
    if (dupFindingIds.length) {
      return { ok: false, code: CODES.DUPLICATE_ID, repairable: false, errors: [CODES.DUPLICATE_ID], warnings, missing: [], duplicates: [...new Set(dupFindingIds)] };
    }
    const missing = issues.map((i) => reviewIssueId(i)).filter((id) => id && !fids.includes(id));
    if (missing.length) {
      return { ok: false, code: CODES.ID_MAPPING_BROKEN, repairable: false, errors: [CODES.ID_MAPPING_BROKEN + ':' + missing.join(',')], warnings, missing, duplicates: [] };
    }
    if (!findings.length && issues.length) {
      return { ok: false, code: CODES.FINDINGS_MISSING, repairable: true, errors: [], warnings: warnings.concat(['REVIEW_FINDINGS_MISSING']), missing: [], duplicates: [] };
    }
    return { ok: true, code: CODES.OK, repairable: true, errors, warnings, missing: [], duplicates: [] };
  }

  /**
   * 主归一化入口：解析结果 → review.v3。
   * @param {object} rawReport 解析出的原始对象
   * @param {{stage?:'strict'|'salvaged'|'raw'|'legacy', reviewId?:number|string, normalizationWarnings?:string[]}} [options]
   */
  function normalizeReviewReport(rawReport, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const raw = rawReport && typeof rawReport === 'object' ? rawReport : {};
    const { findings, duplicates } = normalizeFindings(raw.findings);
    const linked = linkIssuesToFindings(raw.issues, findings);
    const integrity = duplicates.length
      ? integrityOf(CODES.DUPLICATE_ID, { duplicates })
      : linked.integrity;
    const stage = asString(opts.stage) || 'strict';
    const warnings = asArray(opts.normalizationWarnings).map(String);
    if (stage === 'salvaged') warnings.push('报告由抢救解析得到：字段可能不完整');
    if (stage === 'raw') warnings.push('报告无法解析：仅保留原文');
    return {
      schema_version: SCHEMA_VERSION,
      normalization_version: NORMALIZATION_VERSION,
      normalization_stage: stage,
      normalization_warnings: warnings,
      summary: asString(raw.summary),
      strengths: asArray(raw.strengths).map((x) => asString(typeof x === 'string' ? x : (x && x.text))).filter(Boolean),
      deferred: asArray(raw.deferred),
      issues: linked.issues,
      findings,
      integrity,
      evidence_status: integrity.code === CODES.OK ? 'structured' : 'legacy_missing',
      link_mode: linked.link_mode,
      base_text: asString(raw.base_text),
      base_hash: asString(raw.base_hash),
      review_hash: sha256(stableStringify({ issues: linked.issues, findings })),
    };
  }

  /**
   * 旧存量报告迁移（惰性）：生成 LEGACY-<review_id>-<n> 稳定 id，只允许查看与人工选择。
   * 不覆盖原始 payload —— 调用方负责把结果写进 normalized_report_json。
   */
  function migrateLegacyReviewReport(report, reviewId) {
    const raw = report && typeof report === 'object' ? report : {};
    const rid = reviewId == null || reviewId === '' ? 'unknown' : String(reviewId);
    const issuesIn = asArray(raw.issues);
    const findingsIn = asArray(raw.findings);
    const issues = issuesIn.map((it, k) => {
      const explicit = reviewIssueId(it);
      return {
        id: explicit || ('LEGACY-' + rid + '-' + (k + 1)),
        text: reviewIssueText(it),
        source: explicit ? 'initial_review' : 'legacy',
        link_mode: explicit ? 'legacy' : 'legacy',
        finding_id: '',
        legacy_index: k + 1,
      };
    });
    const findings = findingsIn.map((f, k) => normalizeFinding(f, k)).map((f) => ({ ...f, legacy: true, evidence_status: 'legacy_missing' }));
    return {
      schema_version: LEGACY_SCHEMA_VERSION,
      normalization_version: NORMALIZATION_VERSION,
      normalization_stage: 'legacy',
      normalization_warnings: ['旧报告：缺少结构化证据，不允许据此宣称精确修复完成'],
      summary: asString(raw.summary),
      strengths: asArray(raw.strengths).map((x) => asString(typeof x === 'string' ? x : (x && x.text))).filter(Boolean),
      deferred: asArray(raw.deferred),
      issues,
      findings,
      integrity: integrityOf(CODES.LEGACY_NO_EVIDENCE, { detail: '旧报告：缺少结构化证据' }),
      evidence_status: 'legacy_missing',
      link_mode: 'legacy',
      base_text: asString(raw.base_text),
      base_hash: asString(raw.base_hash),
      review_hash: sha256(stableStringify({ summary: asString(raw.summary), issues })),
    };
  }

  /** 报告里按稳定 id 查 finding。 */
  function findingById(report, id) {
    const target = asString(id).trim();
    if (!target) return null;
    const list = asArray(report && report.findings);
    for (const f of list) if (asString(f && f.id).trim() === target) return f;
    return null;
  }

  /** 按稳定 id 查 issue。 */
  function issueById(report, id) {
    const target = asString(id).trim();
    if (!target) return null;
    const list = asArray(report && report.issues);
    for (const it of list) if (reviewIssueId(it) === target) return it;
    return null;
  }

  /**
   * 进入付费修稿之前的映射完整性检查（fail-closed）。
   * @returns {{ok:boolean, code:string, missing:string[], legacy:boolean, evidence_status:string}}
   */
  function assertSelectionMappable(report, selectedIds) {
    const ids = asArray(selectedIds).map((x) => asString(x).trim()).filter(Boolean);
    if (!report || typeof report !== 'object') {
      return { ok: false, code: CODES.SCHEMA_INVALID, missing: [], legacy: false, evidence_status: 'missing' };
    }
    if (report.schema_version === LEGACY_SCHEMA_VERSION || !report.schema_version) {
      // 没有 schema_version 的对象就是**存量报告**（旧接口形状）。归入 legacy 兼容路径：
      // 可查看、可人工选择，但 evidence_status=legacy_missing，结论上限 NEED_CONTEXT。
      return { ok: true, code: CODES.LEGACY_NO_EVIDENCE, missing: [], legacy: true, evidence_status: 'legacy_missing' };
    }
    // 报告根本没有结构化 findings：这是"结构不完整"，不是"某一条选错了"。
    // 先判这一条，错误码才指向根因（否则会被逐条查找掩盖成 SELECTION_MISSING_FINDING）。
    if (!asArray(report.findings).length) {
      return {
        ok: ids.length === 0,
        code: ids.length ? CODES.FINDINGS_MISSING : CODES.OK,
        missing: [], legacy: false, evidence_status: 'missing',
      };
    }
    const missing = [];
    for (const id of ids) {
      const issue = issueById(report, id);
      const finding = findingById(report, id);
      if (!issue || !finding) missing.push(id);
    }
    if (missing.length) {
      return { ok: false, code: CODES.SELECTION_MISSING_FINDING, missing, legacy: false, evidence_status: 'missing' };
    }
    return { ok: true, code: CODES.OK, missing: [], legacy: false, evidence_status: 'structured' };
  }

  /** 本次修稿的选择记录（落 revision_selections 的载荷）。 */
  function selectionRecord(report, selectedIds, reviewId) {
    const ids = asArray(selectedIds).map((x) => asString(x).trim()).filter(Boolean);
    return {
      review_id: reviewId == null ? null : Number(reviewId) || null,
      selected_issue_ids: ids,
      selected_issues: ids.map((id) => ({ id, text: reviewIssueText(issueById(report, id)) })),
      review_hash: asString(report && report.review_hash),
      evidence_status: asString(report && report.evidence_status) || 'structured',
    };
  }

  /** 报告指纹（保存前算一次，读取时重算比对 -> 防"报告被改写但选择记录还是旧的"）。 */
  function hashReport(report) {
    const r = report && typeof report === 'object' ? report : {};
    return sha256(stableStringify({ issues: asArray(r.issues), findings: asArray(r.findings) }));
  }

  /** 供 UI 显示的"这一条问题"的行文案：对象/字符串都安全，永不出现 [object Object]。 */
  function issueLineText(issue) {
    const t = reviewIssueText(issue);
    return t || '（这条问题没有文本）';
  }

  /**
   * 把**任意来源**的报告收敛到可存储结构（服务端 saveReview / getLatestReview 共用）。
   *
   * 为什么要放在契约里而不是 server.js：三个入口（前端提交、长任务回填、库里存量）必须走
   * 同一套判定，否则身份链会在不同入口处分叉 —— 而这是本轮要根治的缺陷形态。
   * 它是纯函数：不碰数据库、不覆盖原始 payload，调用方负责写 normalized_report_json。
   */
  function normalizeStoredReviewReport(report, reviewId) {
    const raw = report && typeof report === 'object' ? report : {};
    if (raw.schema_version === SCHEMA_VERSION) {
      const integrity = validateReviewIntegrity(raw);
      return { ...raw, integrity, review_hash: hashReport(raw) };
    }
    if (raw.schema_version === LEGACY_SCHEMA_VERSION) return raw;
    if (asArray(raw.findings).length) {
      return normalizeReviewReport(raw, { stage: asString(raw.stage) || 'strict' });
    }
    if (asArray(raw.issues).length) {
      return migrateLegacyReviewReport(raw, reviewId);
    }
    return normalizeReviewReport(raw, { stage: 'raw' });
  }

  return {
    VERSION,
    SCHEMA_VERSION,
    LEGACY_SCHEMA_VERSION,
    NORMALIZATION_VERSION,
    LINK_MODES,
    CODES,
    EVIDENCE_ROLES,
    FINDING_TYPES,
    SEVERITIES,
    sha256,
    sha256Hex,
    stableStringify,
    normalizeEvidence,
    normalizeAcceptance,
    normalizeFinding,
    normalizeFindings,
    reviewIssueId,
    reviewIssueText,
    linkIssuesToFindings,
    validateReviewIntegrity,
    normalizeReviewReport,
    migrateLegacyReviewReport,
    findingById,
    issueById,
    assertSelectionMappable,
    selectionRecord,
    hashReport,
    issueLineText,
    normalizeStoredReviewReport,
  };
});
