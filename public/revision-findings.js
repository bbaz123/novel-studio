/*
 * 审稿问题契约 v2（finding.v2）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要这一层（v1.2.1 审稿质量闭环方案 §1.2 缺口 A / §5.2-5.3）：
 *   旧审稿契约只要求 `issues:[{text}]`。一句"检测单开头两折、结尾一折"人读得懂，
 *   但下游修稿器需要的是：**稳定 ID + 逐字证据（可能不止一处）+ 成功判据**。
 *   没有这三样，"哪条问题改了哪里、到底解决没有"只能靠正则从自然语言里猜。
 *
 * 本模块只做**校验与归一化**，不做判断之外的事：
 *   · 绝不伪造证据：老报告没有 findings，就产出"待补证据"的条目并写明原因；
 *   · 绝不因为找不到原文就放宽授权：找不到就是 `QUOTE_NOT_FOUND` / `EVIDENCE_MISSING`；
 *   · 同一引文出现多处 → `AMBIGUOUS_ANCHOR`，不猜第一处（与 revision-plan 的口径一致）。
 *
 * 与 public/revision-plan.js 的分工：那边把"已定位的证据"编译成授权跨度；
 * 这边负责"这条 finding 到底能不能被编译、为什么不能"。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionFindings = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const CONTRACT_VERSION = 2;
  const FINDING_TYPES = ['continuity', 'canon', 'repetition', 'style', 'causality', 'other'];
  const SEVERITIES = ['high', 'medium', 'low'];
  const EVIDENCE_ROLES = ['reference', 'candidate_edit'];

  /**
   * 逐项原因码（方案 §4.2）：每个未完成项最终必须落到其中一个，而不是
   * "模型判断无需修改"这类无法复核的说法。这里同时给出**允许的下一步**，
   * 界面/报告直接转述，避免两处各写一份处置建议。
   */
  const REASON_CODES = {
    NOT_SELECTED: { label: '未被勾选', next: '不修改；不算本轮失败' },
    EVIDENCE_MISSING: { label: '缺少逐字证据', next: '等待作者指出原句，或等结构化审稿重出证据' },
    QUOTE_NOT_FOUND: { label: '证据原文不在底稿', next: '按 BASE_STALE 或证据失效处理，不套用旧跨度' },
    AMBIGUOUS_ANCHOR: { label: '引文位置不唯一', next: '由作者给出唯一 span/上下文，严禁猜第一处' },
    CROSS_SPAN_EVIDENCE_MISSING: { label: '跨位置问题缺少第二处证据', next: '只读证据可补；编辑目标仍须逐一授权' },
    MULTI_TARGET_INCOMPLETE: { label: '多目标只获得部分授权', next: '补充精确多热点授权，不扩大整章' },
    PROTECTED_SPAN: { label: '目标落在保护区', next: '保留原文；换其他获准跨度或等作者选择' },
    CONDENSE_DISABLED: { label: '局部压缩未获批准', next: '改用同跨度 replace；需要跨句压缩时先申请批准' },
    PATCH_FORMAT_INVALID: { label: '补丁格式不合法', next: '格式专用有界重试，不算语义失败' },
    GATE_BLOCKED: { label: '被安全门禁拦下', next: '按门禁原因精确重写补丁，不得绕过' },
    MODEL_KEEP: { label: '模型选择不修改', next: '核对是否与原目标冲突；冲突则报未解决，不静默算通过' },
    CANON_CONFLICT: { label: '审稿建议与蓝图/词条冲突', next: '保留蓝图，给替代候选；改核心方向须作者决定' },
    SEMANTIC_NOT_RUN: { label: '尚未独立验收', next: '启动复验；预算不足时明确挂起' },
    SEMANTIC_FAILED: { label: '独立复验未通过', next: '只在仍获准的热点里精准二次修复' },
    MERGE_NOT_APPROVED: { label: '候选已通过但未获写入批准', next: '保持为已验证候选，不得称为已入库定稿' },
    BASE_STALE: { label: '底稿已变化', next: '重新定位/重新授权，不套用旧跨度' },
    // ── 2026-10-21（六项审稿漏修）：把"改了但没解决"与"根本没改到目标"拆成可复核的原因码 ──
    ANCHOR_NOT_EDITED: { label: '原始证据原句仍在', next: '这条问题的目标段落没有被真正编辑；重新给出可编辑热点后再修' },
    REDUNDANT_EXPLANATION_REMAINS: { label: '重复解释仍然存在', next: '删的是别处：请针对原总结段本身处理，不要改不相关台词' },
    ISSUE_TARGET_NOT_ADDRESSED: { label: '改的不是问题本身', next: '补丁命中了别的片段：把整段相关证据一起给出后重做，不得自动判通过' },
    REPETITIVE_CONSOLATION_REMAINS: { label: '重复劝慰功能仍然存在', next: '按发声者的信息功能收敛，不要只删动作修饰语' },
    UNRELATED_CHANGE: { label: '疑似错误命中', next: '改动与问题证据没有交集：交复核，不得计入已修复' },
    PARTIAL_REFERENCE_AMBIGUITY_REMAINS: { label: '含糊指代可能仍在', next: '让指代落地（点名/引号/播报动作），或由语义层给出可消歧证据' },
    REQUIRED_CHARACTER_DECISION_MISSING: { label: '缺主角自己的取舍动作', next: '由主角做出可见的具体选择；旁人提一句不算' },
    EXTERNAL_CONTEXT_REQUIRED: { label: '需外部资料核验', next: '只读核对角色卡/词条的时点与含义；不改正文来凑数字' },
    NEEDS_AUTHOR_APPROVAL: { label: '需作者裁决', next: '把两种合法改法的代价说清，由作者选；不擅自改角色卡或设定' },
    NOT_APPLICABLE_WITH_EVIDENCE: { label: '经证据判定不适用', next: '保留裁定与依据；不当成一次成功的正文补丁' },
    SELECTED_DENOMINATOR_MISMATCH: { label: '勾选数与状态行数不一致', next: '补齐每一行的终态；禁止把没有状态的条目从分母删掉' },
    UNACCOUNTED: { label: '覆盖表没有回答这一条', next: '补一条处置（改/保留/阻塞），不得静默略过' },
  };

  const textOf = (x) => String(x == null ? '' : x);
  const clip = (s, n) => {
    const t = textOf(s);
    return t.length <= n ? t : `${t.slice(0, n)}…`;
  };

  /** 引文在正文里的全部出现位置；用于唯一性判定，绝不返回"第一处"就完事。 */
  function occurrencesOf(bodyText, quote) {
    const body = textOf(bodyText);
    const q = textOf(quote).trim();
    if (!q) return [];
    const out = [];
    for (let at = body.indexOf(q); at >= 0; at = body.indexOf(q, at + 1)) out.push(at);
    return out;
  }

  function normalizeRole(role) {
    const r = textOf(role).trim();
    return EVIDENCE_ROLES.includes(r) ? r : 'reference';
  }

  function normalizeEvidence(rawEvidence, bodyText) {
    const list = Array.isArray(rawEvidence) ? rawEvidence : (rawEvidence ? [rawEvidence] : []);
    const out = [];
    const diagnostics = [];
    list.forEach((e, i) => {
      if (e == null) return;
      const src = typeof e === 'string' ? { quote: e } : e;
      const quote = textOf(src.quote != null ? src.quote : src.text).trim();
      if (!quote) return;
      const role = normalizeRole(src.role);
      const required = src.required !== false;
      const occ = bodyText != null ? occurrencesOf(bodyText, quote) : null;
      const entry = {
        index: i,
        quote,
        role,
        required,
        span_id: textOf(src.span_id),
        // bodyText 没给时留 null：**不假装核验过**（null 与 0 的区别就是"没查"与"查了没有"）。
        occurrences: occ ? occ.length : null,
        unique: occ ? occ.length === 1 : null,
      };
      if (occ) {
        if (occ.length === 0) diagnostics.push({ code: 'QUOTE_NOT_FOUND', role, quote: clip(quote, 40), reason: '证据原文不在当前底稿里' });
        else if (occ.length > 1) diagnostics.push({ code: 'AMBIGUOUS_ANCHOR', role, quote: clip(quote, 40), occurrences: occ.length, reason: `证据原文出现 ${occ.length} 处：位置不唯一` });
      }
      out.push(entry);
    });
    return { evidence: out, diagnostics };
  }

  function normalizeAcceptance(raw, diagnostics, opts = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const rule = textOf(src.rule != null ? src.rule : (typeof raw === 'string' ? raw : '')).trim();
    const list = (x) => (Array.isArray(x) ? x.map(textOf).map((s) => s.trim()).filter(Boolean) : []);
    const preserve = list(src.preserve);
    // `acceptance.rule` 是给人读的判据；以下三项是**机器可判**的子条件（2026-10-21）。
    // 为什么必须一起归一化：丢了它们，验收层只能问模型"修好了吗"，于是"改了别处"也能算通过。
    const conditions = (Array.isArray(src.conditions) ? src.conditions : [])
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        id: textOf(c.id),
        kind: textOf(c.kind),
        terms: list(c.terms),
        marker: textOf(c.marker),
        severity: c.severity === 'risk' ? 'risk' : 'hard',
        note: textOf(c.note),
      }));
    const acceptance = {
      rule,
      preserve,
      must_contain: list(src.must_contain),
      min_chars: Number.isFinite(Number(src.min_chars)) && Number(src.min_chars) > 0 ? Number(src.min_chars) : 0,
      conditions,
      risk_terms: list(src.risk_terms),
    };
    // 外部资料类问题（角色卡/词条/时态）天然只需要**只读核验**，没有可落笔的正文跨度也合法。
    const external = opts.externalContext === true;
    if (!rule && !acceptance.conditions.length && !external) {
      diagnostics.push({ code: 'ACCEPTANCE_MISSING', reason: '没有可客观检查的成功判据（acceptance.rule）' });
    }
    return acceptance;
  }

  /**
   * 单条 finding 归一化。
   * @param {object|string} raw 原始 finding（字符串按旧 issues 处理）
   * @param {{index?:number, bodyText?:string, legacy?:boolean}} [opts]
   */
  function normalizeFinding(raw, opts = {}) {
    const index = Number.isFinite(Number(opts.index)) ? Number(opts.index) : 0;
    const src = typeof raw === 'string' ? { text: raw } : (raw && typeof raw === 'object' ? raw : {});
    const diagnostics = [];
    const explanation = textOf(src.explanation != null ? src.explanation : src.text).trim();
    const rawId = textOf(src.id).trim();
    const id = rawId || `R-${String(index + 1).padStart(4, '0')}`;
    // `type`（审稿—修稿契约分类）与 `kind`（review_v2 白名单）是两套词表：谁给了就用谁，
    // 只有一套时按固定映射补齐，**不丢分类**（丢分类会让工作区的筛选与统计失真）。
    const KIND_TO_TYPE = { fact: 'continuity', wording: 'style', narrative: 'causality', observation: 'other', deferred: 'other' };
    const typeSrc = textOf(src.type) || KIND_TO_TYPE[textOf(src.kind)] || '';
    const type = FINDING_TYPES.includes(typeSrc) ? typeSrc : 'other';
    const severity = SEVERITIES.includes(textOf(src.severity)) ? textOf(src.severity) : 'medium';
    const legacy = opts.legacy === true || src.legacy === true;
    // 外部资料类问题（Q05 形态）：合法终态是"已核对/待核对"，不是"正文改了什么"。
    const requiresExternal = src.requires_external_context === true || textOf(src.problem_type) === 'EXTERNAL_CARD';
    const ev = normalizeEvidence(src.evidence, opts.bodyText);
    diagnostics.push(...ev.diagnostics);
    const acceptance = normalizeAcceptance(src.acceptance, diagnostics, { externalContext: requiresExternal });
    const title = textOf(src.title).trim() || clip(explanation || '（无标题）', 40);

    // 跨位置问题：至少要有一处"可编辑目标"；若全部是 reference，修稿器没有落笔点。
    const targets = ev.evidence.filter((e) => e.role === 'candidate_edit');
    const references = ev.evidence.filter((e) => e.role !== 'candidate_edit');
    if (!legacy) {
      if (!ev.evidence.length) {
        // 外部资料类问题允许"零正文证据"：它的证据在角色卡/词条里，不在本章正文。
        if (!requiresExternal) diagnostics.push({ code: 'EVIDENCE_MISSING', reason: '没有逐字引文：无法定位，也不得据此扩大授权' });
      } else if (!targets.length && !requiresExternal) {
        diagnostics.push({ code: 'CROSS_SPAN_EVIDENCE_MISSING', reason: '证据全部是只读引用：缺少 candidate_edit 目标，修稿器没有可落笔的跨度' });
      }
      if (src.cross_span === true && targets.length < 2) {
        diagnostics.push({ code: 'CROSS_SPAN_EVIDENCE_MISSING', reason: '声明为跨位置问题，但可编辑目标少于 2 处' });
      }
    } else if (!ev.evidence.length) {
      diagnostics.push({ code: 'EVIDENCE_MISSING', reason: '旧报告只有自然语言问题描述：没有逐字证据，不能声称已取得精确定位' });
    }

    return {
      id,
      title,
      type,
      // `problem_type` 是更细的意图标签（LOCAL_PHRASE / REDUNDANCY / MULTI_SPEAKER_FUNCTION /
      // EXTERNAL_CARD / MISSING_CHARACTER_ACTION）：验收器按它选择判据，但**不因此放宽授权**。
      problem_type: textOf(src.problem_type).trim(),
      severity,
      explanation,
      // 计划层要用 `suggested_action` 决定允许的 op（replace/delete/insert…），丢了它只能一律按 replace。
      suggested_action: textOf(src.suggested_action).trim(),
      // 审稿协议的另几项：保留原文，不在这里重算（重算等于第二套判据）。
      kind: textOf(src.kind),
      verdict: textOf(src.verdict),
      rationale: textOf(src.rationale),
      reading_cost: textOf(src.reading_cost),
      counterevidence: textOf(src.counterevidence),
      shape_defects: Array.isArray(src.shape_defects) ? src.shape_defects.map(textOf) : [],
      evidence: ev.evidence,
      acceptance,
      requires_external_context: requiresExternal,
      legacy,
      cross_span: src.cross_span === true,
      reference_count: references.length,
      target_count: targets.length,
      diagnostics,
      // 稳定判据：一条 finding 只要没有**硬缺陷**，就值得进入计划阶段。
      // 这里不把 acceptance 缺失列为硬缺陷（旧报告全都没有），但它会被如实报告。
      actionable: !diagnostics.some((d) => ['EVIDENCE_MISSING', 'QUOTE_NOT_FOUND', 'AMBIGUOUS_ANCHOR', 'CROSS_SPAN_EVIDENCE_MISSING'].includes(d.code)),
    };
  }

  /**
   * 旧 `issues:[{text}]` → findings 适配器。
   *
   * 为什么必须保留它：历史报告只存了字符串清单，强行丢弃会让作者找不到以前的问题；
   * 但适配出来的条目**一律没有证据**，因此必须带 `legacy:true` 与 `EVIDENCE_MISSING`，
   * 让下游如实显示"这条等待指出原句"，而不是伪装成已定位。
   */
  function findingsFromIssues(issues, opts = {}) {
    return (Array.isArray(issues) ? issues : []).map((x, i) => normalizeFinding({
      id: String(i + 1),
      title: clip(textOf(typeof x === 'string' ? x : (x && (x.text || x.title))), 60),
      explanation: textOf(typeof x === 'string' ? x : (x && (x.text || x.title))),
      type: 'other',
      severity: 'medium',
    }, { index: i, bodyText: opts.bodyText, legacy: true }));
  }

  /**
   * 报告级归一化（唯一入口）。
   * @param {object} report 解析后的审稿报告（可能只有 issues）
   * @param {{bodyText?:string}} [opts]
   * @returns {{findings:Array, issues:Array, diagnostics:Array, legacy:boolean, contract_version:number}}
   */
  function normalizeReviewReport(report, opts = {}) {
    const src = report && typeof report === 'object' ? report : {};
    const rawFindings = Array.isArray(src.findings) ? src.findings : [];
    const legacyIssues = Array.isArray(src.issues) ? src.issues : [];
    const diagnostics = [];
    let findings = [];
    if (rawFindings.length) {
      const seen = new Map();
      findings = rawFindings.map((raw, i) => {
        const f = normalizeFinding(raw, { index: i, bodyText: opts.bodyText });
        const n = (seen.get(f.id) || 0) + 1;
        seen.set(f.id, n);
        if (n > 1) {
          // 重复 id 不能悄悄合并：两条不同问题共用一个编号，修稿与验收都会指错对象。
          // 这里给确定性的区分后缀（顺序稳定），并如实记录诊断。
          const original = f.id;
          f.id = `${original}#${n}`;
          f.diagnostics.push({ code: 'DUPLICATE_ID', reason: `finding id「${original}」重复出现：已按出现顺序改为 ${f.id}，请修稿模型改用唯一 id` });
        }
        return f;
      });
      diagnostics.push(...findings.flatMap((f) => f.diagnostics));
    } else if (legacyIssues.length) {
      findings = findingsFromIssues(legacyIssues, { bodyText: opts.bodyText });
      diagnostics.push({ code: 'LEGACY_REPORT', reason: '这份审稿没有 findings 数组：已按旧 issues 适配，逐字证据需要重新审稿或由作者指出' });
      diagnostics.push(...findings.flatMap((f) => f.diagnostics));
    }
    // issues 保持"给人看的自然语言清单"：新报告显式带就照抄，否则由 findings 派生。
    const issues = legacyIssues.length
      ? legacyIssues.map((x) => textOf(typeof x === 'string' ? x : (x && (x.text || x.title)))).filter(Boolean)
      : findings.map((f) => f.explanation || f.title);
    const legacy = !rawFindings.length && legacyIssues.length > 0;
    return {
      findings,
      issues,
      diagnostics,
      legacy,
      contract_version: CONTRACT_VERSION,
      counts: {
        findings: findings.length,
        with_evidence: findings.filter((f) => f.evidence.length > 0).length,
        actionable: findings.filter((f) => f.actionable).length,
        legacy: findings.filter((f) => f.legacy).length,
      },
    };
  }

  function findingById(findings, id) {
    const want = textOf(id);
    return (Array.isArray(findings) ? findings : []).find((f) => String(f && f.id) === want) || null;
  }

  /** 勾选状态标记：只标记，不改变 finding 本身（选择不是证据，也不改写授权）。 */
  function applySelection(findings, selectedIds) {
    const ids = new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String));
    return (Array.isArray(findings) ? findings : []).map((f) => ({ ...f, selected: ids.has(String(f.id)) }));
  }

  /** 面向计划/授权层的视图：references 只读、targets 可申请编辑。 */
  function evidencePlan(finding) {
    const f = finding || {};
    const ev = Array.isArray(f.evidence) ? f.evidence : [];
    return {
      references: ev.filter((e) => e.role !== 'candidate_edit'),
      targets: ev.filter((e) => e.role === 'candidate_edit'),
      acceptance: f.acceptance || { rule: '', preserve: [] },
    };
  }

  /** 汇总诊断：给界面/报告一份"哪几条缺什么"的清单，不重复实现判据。 */
  function diagnosticsSummary(findings) {
    const list = Array.isArray(findings) ? findings : [];
    const byCode = new Map();
    for (const f of list) {
      for (const d of (Array.isArray(f.diagnostics) ? f.diagnostics : [])) {
        if (!byCode.has(d.code)) byCode.set(d.code, []);
        byCode.get(d.code).push(String(f.id));
      }
    }
    return [...byCode.entries()].map(([code, ids]) => ({
      code,
      label: (REASON_CODES[code] && REASON_CODES[code].label) || code,
      issue_ids: ids,
      next: (REASON_CODES[code] && REASON_CODES[code].next) || '',
    }));
  }

  return {
    VERSION,
    CONTRACT_VERSION,
    FINDING_TYPES,
    SEVERITIES,
    EVIDENCE_ROLES,
    REASON_CODES,
    occurrencesOf,
    normalizeEvidence,
    normalizeFinding,
    normalizeReviewReport,
    findingsFromIssues,
    findingById,
    applySelection,
    evidencePlan,
    diagnosticsSummary,
  };
});
