/*
 * 逐条修稿验收器（revision-semantic-verifier）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么必须先有确定性层（v1.2.1 质量闭环方案 §5.4 / 缺口 C、D）：
 *   “旧引文从正文里消失了”只证明**字符变了**，不证明**问题解决了**。
 *   反过来，“补丁安全通过”也只证明改动没有越过授权，不证明审稿意见被满足。
 *   本模块把两件事拆开并各自要求证据：
 *     · 确定性层：证据是否按角色变化、必须保留项是否还在、授权外字符是否逐字未动、
 *       模型声称已改是否真有对应 diff、底稿是否已经变了；
 *     · 语义层：由**模型**对"这条问题是否真的解决"给出严格结构结论（外部注入）。
 *
 * 结论纪律（写死在实现里）：
 *   ① semantic 未运行 → 最多 `need_context`，**永不** pass；
 *   ② 语义层 pass 不能覆盖确定性 fail（冲突一律 needs_review，而不是择一看运气）；
 *   ③ 没有实际补丁却声称已改 → fail（不允许用自述代替 diff）。
 *
 * 本模块不写任何文件、不调用模型；语义层结果由调用方（app.js / closure 服务）注入。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionSemanticVerifier = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const VERSION = '1.2.0';
  // 方案 §7.2：逐项结论必须是 PASS / PARTIAL / FAIL / UNVERIFIED / BLOCKED 这五类之一。
  // 旧实现只有 pass/fail/need_context，于是模型说"只修好一部分"时会被归一成 not_run，
  // 系统就把"部分修复"记成"待复验"——这一项既没有结论，也不会进入定向复修队列。
  // 这里把 PARTIAL 提升为**一等结论**；UNVERIFIED / BLOCKED 仍归到 need_context
  // （它们同样不携带"已通过"，但原因码不同，界面与回执要能区分）。
  const VERDICT = { PASS: 'pass', PARTIAL: 'partial', FAIL: 'fail', NEED_CONTEXT: 'need_context' };
  const SEMANTIC_STATUSES = ['pass', 'partial', 'fail', 'need_context', 'unverified', 'blocked'];
  const FINAL = {
    ISSUE_VERIFIED: 'ISSUE_VERIFIED',
    PARTIAL: 'PARTIAL',
    UNRESOLVED: 'UNRESOLVED',
    AWAITING_SEMANTIC: 'AWAITING_SEMANTIC',
    CANON_CONFLICT: 'CANON_CONFLICT',
    NOT_SELECTED: 'NOT_SELECTED',
  };

  const textOf = (x) => String(x == null ? '' : x);
  const clip = (s, n) => {
    const t = textOf(s);
    return t.length <= n ? t : `${t.slice(0, n)}…`;
  };
  const countOf = (body, quote) => {
    const b = textOf(body);
    const q = textOf(quote).trim();
    if (!q) return 0;
    let n = 0;
    for (let at = b.indexOf(q); at >= 0; at = b.indexOf(q, at + 1)) n += 1;
    return n;
  };

  const COVERAGE_REASON = {
    blocked: 'GATE_BLOCKED',
    keep: 'MODEL_KEEP',
    deferred: 'MODEL_KEEP',
    partially_resolved: 'SEMANTIC_FAILED',
    needs_scope: 'EVIDENCE_MISSING',
    ambiguous_anchor: 'AMBIGUOUS_ANCHOR',
    authorization_missing: 'AUTHORIZATION_MISSING',
    refused: 'PROTECTED_SPAN',
    unaccounted: 'UNACCOUNTED',
    planned: 'SEMANTIC_NOT_RUN',
    patched: 'SEMANTIC_NOT_RUN',
  };

  /** 把已应用的补丁按**原稿偏移倒序**重建目标文本；任何一处原文不匹配 → BASE_STALE。 */
  function reconstruct(baseText, applied) {
    const base = textOf(baseText);
    const list = (Array.isArray(applied) ? applied : []).filter((p) => p && Number.isFinite(Number(p.start)) && Number.isFinite(Number(p.end)));
    const sorted = list.slice().sort((a, b) => Number(b.start) - Number(a.start));
    let out = base;
    for (const p of sorted) {
      const start = Number(p.start);
      const end = Number(p.end);
      const original = textOf(p.original);
      if (base.slice(start, end) !== original) {
        return { ok: false, code: 'BASE_STALE', span_id: p.span_id || '' };
      }
      out = out.slice(0, start) + (p.op === 'delete' ? '' : textOf(p.replacement)) + out.slice(end);
    }
    return { ok: true, text: out };
  }

  /**
   * 锚点被改到什么程度（2026-10-21，Q01/Q03 的"只改半个问题"判据）。
   *
   * 为什么不能只问"原句还在不在"：
   *   · 只删掉原句里的一个分句（Q03 删「颜色越亮…」）时，整句不再逐字出现 → 旧判据会误判 PASS，
   *     但读者看到的重复解释几乎全在；
   *   · 一条问题有**两处**互相矛盾的证据（Q01 的「四行字」+「那四个字」）时，只改一处是**进展**，
   *     既不是"全没动"（FAIL），也不是"已解决"（PASS）。
   * 判据用**真实补丁跨度覆盖了锚点多少**（不看模型自称、也不看字面相似度 —— 重写时保留的
   * 专有名词会让相似度虚高）：
   *   · 锚点原文仍在候选里 → intact（没改）；
   *   · 原文不在了：补丁覆盖 ≥90% → gone（整段被改写）；0<覆盖<90% → partial（只动了一部分）；
   *     补丁完全没碰到它 → gone（字面确实消失；无记录改动另有全局 DIFF_MISMATCH 把关）。
   */
  function patchCoverageOf(issuePatches, baseText, quote) {
    const spans = spansOf(baseText, quote);
    if (!spans.length) return null;
    const sp = spans[0];
    const len = sp.end - sp.start;
    if (len <= 0) return null;
    let covered = 0;
    for (const p of (Array.isArray(issuePatches) ? issuePatches : [])) {
      const start = Math.max(sp.start, Number(p && p.start));
      const end = Math.min(sp.end, Number(p && p.end));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) covered += (end - start);
    }
    return Math.min(1, covered / len);
  }

  function anchorStatus(baseText, revisedText, quote, issuePatches) {
    const q = textOf(quote).trim();
    if (!q) return { status: 'empty', coverage: 0 };
    const present = countOf(revisedText, q) > 0;
    const coverage = patchCoverageOf(issuePatches, baseText, q);
    const cov = coverage == null ? 0 : coverage;
    if (present) return { status: cov > 0.15 ? 'partial' : 'intact', coverage: cov, present: true };
    return { status: cov > 0 && cov < 0.9 ? 'partial' : 'gone', coverage: cov, present: false };
  }

  function pushCheck(checks, criterion, passed, evidence, extra = {}) {
    checks.push({ criterion, passed: passed === true, evidence: Array.isArray(evidence) ? evidence : (evidence ? [String(evidence)] : []), ...extra });
    return passed === true;
  }

  /** 某段引文在底本里的**全部**区间（用于判断补丁有没有真的落在证据上）。 */
  function spansOf(body, quote) {
    const b = textOf(body);
    const q = textOf(quote).trim();
    const out = [];
    if (!q) return out;
    for (let at = b.indexOf(q); at >= 0; at = b.indexOf(q, at + 1)) out.push({ start: at, end: at + q.length });
    return out;
  }

  /**
   * 补丁有没有落在证据上（2026-10-21，Q04「改错位置」的确定性判据）。
   *
   * 只证明"字符变了"是不够的：把「看了一眼他的表情」删掉，补丁确实非空、`actual_change=true`，
   * 可它和这条问题的证据（三个发声者的重复劝慰）**没有任何交集**。这种改动必须标成
   * `UNRELATED_CHANGE`，且**不得**计入已修复 —— 这正是前一轮把"改错地方"读成"已处理"的漏洞。
   */
  function overlapsEvidence(patch, baseText, quotes) {
    const start = Number(patch && patch.start);
    const end = Number(patch && patch.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    for (const q of quotes) {
      for (const sp of spansOf(baseText, q)) {
        // 零宽 insert 落在引文区间内也算命中；replace/delete 与引文区间相交才算。
        if (start === end) { if (start >= sp.start && start <= sp.end) return true; continue; }
        if (start < sp.end && end > sp.start) return true;
      }
    }
    return false;
  }

  /**
   * 结构化子条件求值（`acceptance.conditions`）。
   *
   * 为什么不把子条件写成一句自然语言：模型对"改好了吗"的回答会让"改了别处"也算通过。
   * 这里只求值**能确定性判定**的几种（字面缺失/残留/必要动作标记），其余如实记为 `SKIP`
   * 留给语义层 —— 不猜、不把 SKIP 当 PASS。
   * @returns {{results:Array, failed:Array}}
   */
  function evalConditions(input = {}) {
    const finding = input.finding || {};
    const baseText = textOf(input.baseText);
    const revisedText = textOf(input.revisedText);
    const acc = finding.acceptance && typeof finding.acceptance === 'object' ? finding.acceptance : {};
    const declared = Array.isArray(acc.conditions) ? acc.conditions.filter((c) => c && typeof c === 'object') : [];
    const results = [];
    const failed = [];
    const push = (row) => {
      results.push(row);
      if (row.status === 'FAIL') failed.push(row);
    };
    // 声明里没有子条件时，`risk_terms` / `must_contain` 仍按各自语义求值（兼容旧报告）。
    const riskTerms = (Array.isArray(acc.risk_terms) ? acc.risk_terms : []).map(textOf).map((s) => s.trim()).filter(Boolean);
    if (riskTerms.length) {
      const hit = riskTerms.filter((t) => countOf(revisedText, t) > 0);
      push({
        id: 'risk_terms', kind: 'residual_terms_absent', severity: 'risk',
        status: hit.length ? 'FAIL' : 'PASS',
        evidence: hit.length
          ? [`候选里仍有：${hit.map((t) => clip(t, 16)).join('、')}`]
          : ['候选里已无风险字面'],
        code: 'PARTIAL_REFERENCE_AMBIGUITY_REMAINS',
        note: '命中只形成风险断言：语境可能已经消歧，需语义层确认；但不得据此自动判通过',
      });
    }
    for (const c of declared) {
      const kind = textOf(c.kind).trim();
      const id = textOf(c.id).trim() || kind || `cond-${results.length + 1}`;
      const severity = c.severity === 'risk' ? 'risk' : 'hard';
      const terms = (Array.isArray(c.terms) ? c.terms : []).map(textOf).map((s) => s.trim()).filter(Boolean);
      if (kind === 'must_contain') {
        const missing = terms.filter((t) => countOf(revisedText, t) === 0);
        push({
          id, kind, severity, status: missing.length ? 'FAIL' : 'PASS',
          evidence: missing.length ? [`候选缺少：${missing.map((t) => clip(t, 16)).join('、')}`] : ['必需字面都在候选里'],
          code: 'REQUIRED_TEXT_MISSING',
        });
        continue;
      }
      if (kind === 'preserve_terms') {
        const lost = terms.filter((t) => countOf(baseText, t) > 0 && countOf(revisedText, t) === 0);
        push({
          id, kind, severity, status: lost.length ? 'FAIL' : 'PASS',
          evidence: lost.length ? [`修前有、候选已丢：${lost.map((t) => clip(t, 16)).join('、')}`] : ['保留项都还在'],
          code: 'PRESERVE_LOST',
        });
        continue;
      }
      if (kind === 'residual_terms_absent') {
        const hit = terms.filter((t) => countOf(revisedText, t) > 0);
        push({
          id, kind, severity, status: hit.length ? 'FAIL' : 'PASS',
          evidence: hit.length ? [`候选里仍有：${hit.map((t) => clip(t, 16)).join('、')}`] : ['残留字面已清除'],
          code: textOf(c.code) || 'PARTIAL_REFERENCE_AMBIGUITY_REMAINS',
        });
        continue;
      }
      if (kind === 'required_action') {
        // 主角自己的取舍动作：只在"全章一个字面标记都没有"时判失败（宁可交语义复核，不机械判死）。
        const markers = terms.length ? terms : (textOf(c.marker) ? [textOf(c.marker)] : []);
        const present = markers.filter((t) => countOf(revisedText, t) > 0);
        push({
          id, kind, severity, status: present.length ? 'PASS' : 'FAIL',
          evidence: markers.length
            ? [present.length ? `出现动作标记：${present.map((t) => clip(t, 12)).join('、')}` : `候选里没有任何动作标记（${markers.map((t) => clip(t, 12)).join('、')}）`]
            : ['没有给出可判定的动作标记：交语义复核'],
          code: 'REQUIRED_CHARACTER_DECISION_MISSING',
        });
        continue;
      }
      // 不认识的子条件：如实记为 SKIP，绝不当作 PASS（跳过 ≠ 通过）。
      push({ id, kind, severity, status: 'SKIP', evidence: [`未实现确定性求值：${kind || '（空 kind）'}`], code: 'CONDITION_NOT_EVALUATED' });
    }
    return { results, failed };
  }

  /**
   * 外部资料核验门（Q05 形态：角色卡/词条/时态与正文不一致）。
   *
   * 为什么必须是**门**而不是一条检查：这类问题的合法终态是"核对过 / 待核对"，
   * 不是"正文改了什么"。旧实现里它要么被当成普通正文任务派给修稿器（默认允许改章节），
   * 要么因为"没有可编辑证据"被判成待复核从而消失。两种都不对。
   * 现在：没有外部核验结论 → 待核验（`EXTERNAL_CONTEXT_REQUIRED`）；有结论 → 如实带出，
   * 且**仍然不是 PASS**（"经证据判定不适用"不是一次成功的正文补丁）。
   */
  function externalContextGate(input = {}) {
    const finding = input.finding || {};
    const required = finding.requires_external_context === true;
    if (!required) return { required: false, resolved: false, code: '', evidence: [] };
    const ext = input.externalContext && typeof input.externalContext === 'object' ? input.externalContext : null;
    if (!ext || ext.resolved !== true) {
      return {
        required: true, resolved: false, code: 'EXTERNAL_CONTEXT_REQUIRED',
        verdict: 'not_applicable',
        evidence: [ext && ext.note ? textOf(ext.note) : '还没有角色卡/词条/时点的只读核对结论：本条不能按正文补丁处理'],
      };
    }
    const verdict = textOf(ext.verdict) || 'not_applicable_with_evidence';
    return {
      required: true, resolved: true, code: 'NOT_APPLICABLE_WITH_EVIDENCE',
      verdict,
      evidence: [textOf(ext.note) || '已取得外部资料核对结论', textOf(ext.evidence_ref)].filter(Boolean),
      source: textOf(ext.source),
    };
  }

  /**
   * 确定性检查（不需要模型）。
   * @param {object} input
   *   · finding、baseText、revisedText、applied（补丁）、plan、coverage（该 issue 的覆盖行）、
   *     invariants、protectedSpans、canonConflict
   * @returns {{checks:Array, failed:Array, needContext:Array}}
   */
  function deterministicChecks(input = {}) {
    const finding = input.finding || {};
    const baseText = textOf(input.baseText);
    const revisedText = textOf(input.revisedText);
    const applied = Array.isArray(input.applied) ? input.applied : [];
    const checks = [];
    const needContext = [];
    const id = String(finding.id == null ? '' : finding.id);
    const issuePatches = applied.filter((p) => (Array.isArray(p.issue_ids) ? p.issue_ids : []).map(String).includes(id));
    const ev = Array.isArray(finding.evidence) ? finding.evidence : [];
    const problemType = textOf(finding.problem_type).toUpperCase();

    /** 锚点原句仍在时，按问题类型给出更准确的原因码（Q03 重复解释 / Q04 重复劝慰功能）。 */
    const anchorCode = () => {
      if (problemType === 'REDUNDANCY') return 'REDUNDANT_EXPLANATION_REMAINS';
      if (problemType === 'MULTI_SPEAKER_FUNCTION') return 'REPETITIVE_CONSOLATION_REMAINS';
      return 'ANCHOR_NOT_EDITED';
    };

    // ① 证据按角色变化：可编辑锚点应消失；只读引用应保留（它是"对比的另一头"）。
    //    2026-10-21：改成三档判定 —— 全部未动才是硬 FAIL；只动了其中一处/删了一半是 PARTIAL 级
    //    未完成条件（硬判 PASS 会让"只改半个问题"混过去，硬判 FAIL 又会把真实进展抹成零）。
    const anchorRows = [];
    for (const e of ev) {
      const quote = textOf(e && e.quote).trim();
      if (!quote) continue;
      const before = countOf(baseText, quote);
      const after = countOf(revisedText, quote);
      if (e.role === 'candidate_edit') {
        if (!before) { needContext.push({ criterion: 'editable_anchor_present_before', quote: clip(quote, 30) }); continue; }
        anchorRows.push({ quote, before, after, ...anchorStatus(baseText, revisedText, quote, issuePatches) });
        continue;
      }
      if (!before) { needContext.push({ criterion: 'reference_present_before', quote: clip(quote, 30) }); continue; }
      pushCheck(checks, `只读证据仍完整：${clip(quote, 24)}`, after > 0,
        [`只读证据在修前 ${before} 次、修后 ${after} 次（对比基准不能被改掉）`], { role: 'reference', quote, code: 'REFERENCE_LOST', hard: true });
    }
    // 先算整体进度，再决定每处锚点的检查是 hard 还是 soft：
    //   · 一处都没动（gone/partial 均为 0）→ 这是"没修"，hard FAIL；
    //   · 有的动了、有的没闭环 → 这是"只修了一半"，soft（结论落到 PARTIAL 级，绝不 PASS）。
    const anchorsGone = anchorRows.filter((r) => r.status === 'gone').length;
    const anchorsTouched = anchorRows.filter((r) => r.status !== 'intact').length;
    const anyProgress = anchorsTouched > 0;
    for (const r of anchorRows) {
      if (r.status === 'gone') {
        pushCheck(checks, `可编辑锚点已消失：${clip(r.quote, 24)}`, true,
          [`修前出现 ${r.before} 次 → 修后 ${r.after} 次`], { role: 'candidate_edit', quote: r.quote, code: anchorCode(), hard: false });
        continue;
      }
      const intact = r.status === 'intact';
      pushCheck(checks, intact
        ? `可编辑锚点已消失：${clip(r.quote, 24)}`
        : `可编辑锚点只改了一部分：${clip(r.quote, 24)}`,
      false,
      [`修前出现 ${r.before} 次 → 修后 ${r.after} 次；补丁覆盖该锚点 ${Math.round((r.coverage || 0) * 100)}%`],
      { role: 'candidate_edit', quote: r.quote, code: anchorCode(), hard: !anyProgress });
    }
    // 多锚点问题的"部分完成"：有一处真改过而整条还没闭环 → 明确记一条未完成条件。
    if (anchorRows.length > 1 && anyProgress && anchorsGone < anchorRows.length) {
      pushCheck(checks, '多证据问题必须逐处闭环（只改其中一处不算解决）', false,
        [`共 ${anchorRows.length} 处可编辑证据，整段改写的只有 ${anchorsGone} 处`],
        { code: 'INCOMPLETE_CONDITION', hard: false });
    }

    // ② 必须保留项（作者/契约给的硬约束 + 蓝图/伏笔）不得因为这次修改而丢失。
    const invariants = input.invariants && typeof input.invariants === 'object' ? input.invariants : {};
    const preserve = [...new Set([
      ...(Array.isArray(invariants.must_keep) ? invariants.must_keep : []),
      ...(finding.acceptance && Array.isArray(finding.acceptance.preserve) ? finding.acceptance.preserve : []),
      ...(Array.isArray(input.protectedSpans) ? input.protectedSpans : []),
    ].map(textOf).map((s) => s.trim()).filter((s) => s.length >= 2))];
    for (const keep of preserve) {
      const before = countOf(baseText, keep);
      if (!before) continue;
      const after = countOf(revisedText, keep);
      pushCheck(checks, `必须保留项仍在：${clip(keep, 24)}`, after > 0,
        [`修前 ${before} 次 → 修后 ${after} 次`], { preserve: keep, code: 'PRESERVE_LOST', hard: true });
    }

    // ②b 必须**出现**的字面（v1.2.4）：纪年锚点、回执编号这类"缺了就说明没修"的硬约束
    //    （方案 §5.2 的 `world_time_anchor` / §2.2 的 B07）。
    //    为什么必须有这一层：这类问题的证据在**修前**天然不存在（正是"漏了"），
    //    只靠"旧引文消失"的判据永远判不出通过/不通过 —— 模型说 pass 就会假通过。
    const mustContain = (finding.acceptance && Array.isArray(finding.acceptance.must_contain)
      ? finding.acceptance.must_contain : []).map(textOf).map((s) => s.trim()).filter(Boolean);
    for (const needle of mustContain) {
      pushCheck(checks, `硬约束字面必须出现：${clip(needle, 24)}`, countOf(revisedText, needle) > 0,
        [`候选里出现 ${countOf(revisedText, needle)} 次（修前 ${countOf(baseText, needle)} 次）`], { code: 'REQUIRED_TEXT_MISSING', needle, hard: true });
    }
    // ②c 篇幅硬目标（v1.2.4）：HARD 目标不够字数就是没达成（方案 §5.2 的 `target_length` / B08）。
    //    SOFT 目标由作者签收，不在这里硬判 —— 因此只有显式声明 min_chars 才算硬约束。
    const minChars = Number(finding.acceptance && finding.acceptance.min_chars);
    if (Number.isFinite(minChars) && minChars > 0) {
      const plain = (s) => textOf(s).replace(/\s+/g, '').length;
      pushCheck(checks, `篇幅硬目标：不少于 ${minChars} 字`, plain(revisedText) >= minChars,
        [`候选 ${plain(revisedText)} 字 / 目标 ${minChars} 字`], { code: 'TARGET_LENGTH_MISSED', hard: true });
    }

    // ②d 时序结构化（v1.2.4 P1）：只对 `temporal_consistency` 类问题跑，且只收**确定性**判定的项。
    //     为什么必须结构化：B-02/B-03 这类缺陷用字符串判据永远分不清（把 10:23 改成"刚发的"
    //     就能骗过"旧引文消失"），必须把时刻抽出来算间隔与先后。
    //     字面要求（纪年等）已经由上面的 must_contain 处理，这里传空数组避免重复计费同一条检查。
    const TL = (root && root.NovelRevisionTimeline) || (typeof globalThis !== 'undefined' ? globalThis.NovelRevisionTimeline : null);
    if (TL && typeof TL.detectTemporalIssues === 'function' && textOf(finding.type) === 'temporal_consistency') {
      let tl = null;
      try { tl = TL.detectTemporalIssues(revisedText, { requiredTerms: [] }); } catch (_) { tl = null; }
      if (tl && Array.isArray(tl.issues)) {
        for (const it of tl.issues) {
          pushCheck(checks, it.criterion || '时间线自洽', false, [it.detail || ''], { code: it.code || 'TIMELINE_CONFLICT', hard: it.hard !== false, timeline: true });
        }
      }
    }

    // ②e 分段跨边界联合证据（v1.2.4 P1）：同一 issue 的可编辑锚点分布在多片、而其中一片没被处理。
    //     这是**软**检查：锚点原文若真还在，硬检查必然已经失败；这里额外把它变成可读的原因码，
    //     让语义层与作者看到"哪一片没被处理"，而不是只有一句 ANCHOR_NOT_EDITED。
    const crossSegment = input.crossSegment && typeof input.crossSegment === 'object' ? input.crossSegment : null;
    if (crossSegment && crossSegment.split === true && Array.isArray(crossSegment.untouched_segments) && crossSegment.untouched_segments.length) {
      pushCheck(checks, `可编辑锚点跨 ${crossSegment.evidence_segments.length} 片，仍有片未处理：${crossSegment.untouched_segments.join('、')}`, false,
        [JSON.stringify({ evidence: crossSegment.evidence_segments, patched: crossSegment.patched_segments, untouched: crossSegment.untouched_segments })],
        { code: 'EVIDENCE_SPLIT_UNTOUCHED', hard: false });
    }

    // ③ 声称已改但没有实际 diff（R-17）：覆盖表说 patched，却没有任何补丁落在本 issue 上。
    const coverage = input.coverage && typeof input.coverage === 'object' ? input.coverage : null;
    const status = textOf(coverage && coverage.status) || '';
    if (status === 'patched' || status === 'partially_resolved') {
      pushCheck(checks, '声称已处理的条目必须有实际补丁（无 diff 不算已改）',
        issuePatches.length > 0, [`applied=${issuePatches.length}`], { code: 'NO_DIFF', hard: true });
    }
    if (status === 'unaccounted') {
      pushCheck(checks, '覆盖表必须回答每一条已选问题', false, ['unaccounted：模型没有给出处置'], { code: 'UNACCOUNTED', hard: true });
    }

    // ③b 补丁是否落在**本问题的证据**上（Q04「改错位置」）。
    //     只证明"字符变了"不够：删掉一句与问题无关的动作修饰语，diff 非空、actual_change=true，
    //     却和三个重复劝慰的证据没有任何交集。那种改动不得计入已修复。
    //
    //     ⚠️ 只在**能证明补丁落在哪**的时候判：跨度必须真的等于它声称改的原文
    //     （`baseText.slice(start,end) === patch.original`）；零宽 insert 与占位偏移（0,0）不参与。
    //     否则分段路径（补丁按片内偏移校准）与只给占位的调用方会被误判成"改错地方"——
    //     test-1025 FZ-01 与 test-1026 TL-12 就是这么撞出来的（把改对判成改错）。
    const editableQuotes = ev.filter((e) => e && e.role === 'candidate_edit')
      .map((e) => textOf(e.quote).trim()).filter(Boolean);
    const locatedPatches = issuePatches.filter((p) => {
      if (!p) return false;
      const s = Number(p.start);
      const e = Number(p.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
      return baseText.slice(s, e) === textOf(p.original);
    });
    if (editableQuotes.length && issuePatches.length && locatedPatches.length === issuePatches.length) {
      const hit = locatedPatches.filter((p) => overlapsEvidence(p, baseText, editableQuotes));
      pushCheck(checks, '补丁必须落在本问题的证据上（改动不是无关片段）', hit.length > 0,
        [`补丁 ${locatedPatches.length} 处，命中证据的 ${hit.length} 处`],
        { code: 'UNRELATED_CHANGE', hard: true });
    }

    // ③c 结构化子条件（`acceptance.conditions`）：逐条求值，细粒度落库。
    const cond = evalConditions({ finding, baseText, revisedText });
    for (const r of cond.results) {
      const isFail = r.status === 'FAIL';
      pushCheck(checks, `子条件 ${r.kind || r.id}：${r.id}`, r.status === 'PASS', r.evidence, {
        code: r.code || 'CONDITION_FAILED',
        // 只有"硬子条件未通过"才是字面事实；risk 类子条件失败只形成风险断言（交语义层/作者）。
        hard: isFail && r.severity === 'hard',
        condition: { id: r.id, kind: r.kind, severity: r.severity, status: r.status },
      });
    }

    // ④ 授权边界：补丁跨度必须落在该 issue 的热点内（多热点各自狭窄授权，不是整段放开）。
    const plan = input.plan && typeof input.plan === 'object' ? input.plan : null;
    if (plan) {
      const hotspots = (Array.isArray(plan.hotspots) ? plan.hotspots : [])
        .filter((h) => String(h && h.issue_id) === id && h.span)
        .map((h) => ({ start: Number(h.span.start), end: Number(h.span.end) }));
      if (hotspots.length) {
        for (const p of issuePatches) {
          const inside = hotspots.some((h) => Number(p.start) >= h.start && Number(p.end) <= h.end);
          pushCheck(checks, `补丁落在授权热点内：${clip(p.original, 20)}`, inside,
            [`补丁 ${p.start}-${p.end} vs 热点 ${hotspots.map((h) => `${h.start}-${h.end}`).join(',')}`], { code: 'OUT_OF_SCOPE', hard: true });
        }
      }
    }

    // ⑤ 底稿版本：调用方给了当前哈希时才判（没给就不假装核验过）。
    if (input.currentBaseHash != null && plan && plan.base_hash) {
      pushCheck(checks, '底稿与计划快照一致', String(input.currentBaseHash) === String(plan.base_hash),
        [String(input.currentBaseHash), String(plan.base_hash)], { code: 'BASE_STALE', hard: true });
    }

    // ⑥ 词条版本（v1.2.2 P1-1）：引用版本 ≠ 当前版本时，不得按旧口径判冲突。
    // 这一步是确定性的：只要调用方给出了"这条 finding 引用的是哪一版词条"，版本对不上就不再是"语义分歧"。
    const entryVersions = input.entryVersions && typeof input.entryVersions === 'object' ? input.entryVersions : null;
    const vs = entryVersions && finding && entryVersions[String(finding.id)];
    if (vs && vs.entry_id != null && vs.referenced_version != null && vs.current_version != null) {
      pushCheck(checks, `词条版本与验收基准一致（#${vs.entry_id}）`,
        Number(vs.referenced_version) === Number(vs.current_version),
        [`引用 v${vs.referenced_version} / 当前 v${vs.current_version}`], { code: 'ENTRY_VERSION_STALE' });
    }

    // ⑦ 道具状态链（v1.2.2 P1-2）：最终状态与预期不符、或状态证据在候选里丢失 → 确定性失败。
    const propChains = input.propChains && typeof input.propChains === 'object' ? input.propChains : null;
    const pc = propChains && finding && propChains[String(finding.id)];
    if (pc) {
      const rows = Array.isArray(pc.chain) ? pc.chain : [];
      const latestRow = rows.length ? rows[rows.length - 1] : null;
      if (!latestRow) {
        pushCheck(checks, `道具状态链已登记（${pc.prop_key || '?'}）`, false, ['没有登记任何状态'], { code: 'PROP_NOT_REGISTERED' });
      } else {
        if (pc.expected_state) {
          pushCheck(checks, `道具最终状态一致（${pc.prop_key || '?'}）`, String(latestRow.state) === String(pc.expected_state),
            [`最新「${latestRow.state}」/ 预期「${pc.expected_state}」`], { code: 'PROP_STATE_MISMATCH' });
        }
        if (latestRow.evidence_quote) {
          pushCheck(checks, `道具状态证据仍在候选正文（${pc.prop_key || '?'}）`, countOf(revisedText, latestRow.evidence_quote) > 0,
            [String(latestRow.evidence_quote)], { code: 'PROP_EVIDENCE_LOST' });
        }
      }
    }

    return { checks, failed: checks.filter((c) => !c.passed), needContext, conditionResults: cond.results };
  }

  /** 语义层结果归一化：接受字符串、`{status}` 或 `{verdict}`，其余一律 not_run（不猜通过）。 */
  function normalizeSemantic(raw) {
    const base = { status: 'not_run', checks: [], reason: '', reason_code: '', repair_hint: '', confidence: 'medium', remaining_evidence: [] };
    if (raw == null) return base;
    const mapStatus = (s) => {
      const v = textOf(s).toLowerCase();
      if (v === 'pass' || v === 'passed' || v === 'ok') return 'pass';
      if (v === 'partial' || v === 'partially_fixed' || v === 'partly' || v === 'partially_resolved') return 'partial';
      if (v === 'fail' || v === 'failed') return 'fail';
      if (v === 'unverified' || v === 'unknown') return 'unverified';
      if (v === 'blocked') return 'blocked';
      if (v === 'need_context' || v === 'needs_context') return 'need_context';
      return 'not_run';
    };
    if (typeof raw === 'string') return { ...base, status: mapStatus(raw) };
    if (typeof raw !== 'object') return base;
    const status = mapStatus(raw.status != null ? raw.status : raw.verdict);
    // 原因码只接受稳定枚举形状（大写+下划线），自由文本一律不写入原因码字段。
    const reasonCode = /^[A-Z][A-Z0-9_]{2,60}$/.test(textOf(raw.reason_code || raw.reasonCode)) ? textOf(raw.reason_code || raw.reasonCode) : '';
    return {
      status,
      checks: Array.isArray(raw.checks) ? raw.checks : [],
      reason: textOf(raw.reason),
      reason_code: reasonCode,
      repair_hint: textOf(raw.repair_hint),
      confidence: ['high', 'medium', 'low'].includes(textOf(raw.confidence)) ? textOf(raw.confidence) : 'medium',
      remaining_evidence: (Array.isArray(raw.remaining_evidence) ? raw.remaining_evidence : []).map(textOf).filter(Boolean),
    };
  }

  /**
   * 单条问题裁决（确定性 + 语义）。
   * @param {object} input 见 deterministicChecks，另加：
   *   · semantic —— 语义核验结果（缺省 = not_run）
   *   · canonConflict —— 是否与蓝图/词条冲突（true 时 final=CANON_CONFLICT）
   */
  function verifyIssue(input = {}) {
    const d = deterministicChecks(input);
    const sem = normalizeSemantic(input.semantic);
    const checks = d.checks.slice();
    for (const s of sem.checks) {
      if (!s || typeof s !== 'object') continue;
      checks.push({
        criterion: textOf(s.criterion) || '语义检查',
        passed: s.passed === true,
        evidence: Array.isArray(s.evidence) ? s.evidence.map(textOf) : [],
        layer: 'semantic',
      });
    }
    const finding = input.finding || {};
    const baseText = textOf(input.baseText);
    const revisedText = textOf(input.revisedText);
    const applied = Array.isArray(input.applied) ? input.applied : [];
    const id = String(finding.id == null ? '' : finding.id);
    const issuePatches = applied.filter((p) => (Array.isArray(p.issue_ids) ? p.issue_ids : []).map(String).includes(id));
    // 方案 §7.1：「完全未修改」与「改动了但问题仍存在」必须能分开。
    // 旧实现只有补丁条数；补丁存在但 before === after（或根本没命中）时读起来像"改过"。
    const changedPatch = (p) => {
      const op = textOf(p && p.op) || 'replace';
      const before = textOf(p && p.original);
      const after = op === 'delete' ? '' : textOf(p && p.replacement);
      return before !== after;
    };
    const actualChange = issuePatches.some(changedPatch);
    const evidenceRows = (Array.isArray(finding.evidence) ? finding.evidence : []).map((e, i) => ({
      id: textOf(e && (e.id || e.span_id)) || `E${i + 1}`,
      role: textOf(e && e.role) || 'reference',
      quote: textOf(e && e.quote).trim(),
    }));
    const remainingEvidenceAll = [
      ...evidenceRows
        .filter((e) => e.quote && countOf(revisedText, e.quote) > 0)
        .map((e) => ({ evidence_id: e.id, role: e.role, quote: clip(e.quote, 40) })),
      ...sem.remaining_evidence.map((q) => ({ evidence_id: '', role: 'semantic', quote: clip(q, 40) })),
    ];
    const deterministicFailed = d.failed.length > 0;
    // **硬事实**与**软判断**要分开（v1.2.4 §2.3 的"强/弱验收"）：
    //   · 硬事实（锚点原句还在 / 必须保留的被删 / 该出现的字面没出现 / 字数硬目标没到 /
    //     声称改了却没有 diff / 越过授权 / 底稿变了）是**字面事实**，模型说"我改了"不能覆盖它；
    //   · 软判断（模板句是否仍有伤害、篇幅是否可接受）与语义结论冲突时，仍然交人复核。
    const hardFailed = d.failed.filter((c) => c && c.hard === true);
    const semanticFailed = sem.status === 'fail';
    const semanticPassed = sem.status === 'pass';
    const semanticPartial = sem.status === 'partial';
    // 外部资料门（Q05）：它**先于**语义结论生效 —— 没核对过角色卡/词条时，语义层说 pass 也不算数。
    const external = externalContextGate(input);
    const problemType = textOf(finding.problem_type).toUpperCase();
    let verdict;
    let reasonCode;
    let reason;
    if (external.required) {
      // 这类问题的合法终态是"待核对 / 经证据判定不适用"，都不是 PASS，也不该被派给正文修稿器。
      verdict = VERDICT.NEED_CONTEXT;
      reasonCode = external.resolved ? 'NOT_APPLICABLE_WITH_EVIDENCE' : 'EXTERNAL_CONTEXT_REQUIRED';
      reason = external.resolved
        ? `已取得外部资料核对结论（${external.evidence.join('；')}）：这条不按正文补丁计为通过，交由作者裁决`
        : `这条问题需要外部资料（角色卡/词条/时点）核对后才能判定：${external.evidence.join('；')}`
          + '。不得往正文生硬补写来凑数字，也不得直接改角色卡数据库';
    } else if (hardFailed.length) {
      verdict = VERDICT.FAIL;
      // Q04 形态：既有"锚点没动"又有"改到别处"时，报告真正的原因是**改错了位置**。
      const unrelated = hardFailed.find((c) => c.code === 'UNRELATED_CHANGE');
      reasonCode = (unrelated && problemType === 'MULTI_SPEAKER_FUNCTION')
        ? 'UNRELATED_CHANGE'
        : (hardFailed[0].code || 'DETERMINISTIC_FAILED');
      reason = `确定性硬检查未通过：${hardFailed.map((c) => c.criterion).slice(0, 3).join('；')}`
        + (semanticPassed ? '（语义层判通过，但这是字面事实，不能覆盖）' : '');
    } else if (deterministicFailed && (semanticPassed || semanticPartial)) {
      // 两层冲突：不选"看起来更好"的那一层，交人复核（方案 §5.4）。
      // 语义说"部分修复"时，确定性软失败也在说"没全好"，两者方向一致但都不能算 PASS。
      verdict = semanticPartial ? VERDICT.PARTIAL : VERDICT.NEED_CONTEXT;
      const riskCode = (d.failed.find((c) => c && c.code === 'PARTIAL_REFERENCE_AMBIGUITY_REMAINS') || {}).code;
      reasonCode = semanticPartial ? (sem.reason_code || riskCode || 'SEMANTIC_PARTIAL') : 'LAYER_CONFLICT';
      reason = semanticPartial
        ? `确定性层仍有未通过项（${d.failed.map((c) => c.criterion).slice(0, 2).join('；')}），语义层判部分修复`
        : `确定性层未通过（${d.failed.map((c) => c.criterion).slice(0, 2).join('；')}），语义层却判通过：结论冲突，按待复核处理`;
    } else if (deterministicFailed) {
      verdict = VERDICT.FAIL;
      const first = d.failed[0];
      reasonCode = (first && first.code) || 'DETERMINISTIC_FAILED';
      reason = `确定性检查未通过：${d.failed.map((c) => c.criterion).slice(0, 3).join('；')}`;
    } else if (semanticFailed) {
      verdict = VERDICT.FAIL;
      reasonCode = sem.reason_code || 'SEMANTIC_FAILED';
      reason = sem.reason || '语义核验判定未通过';
    } else if (semanticPartial) {
      // 「只解决局部」必须是一个**结论**，而不是"没跑"：它保留未解决子条件，
      // 进入定向复修队列，并在界面显示"部分完成"，绝不显示为已通过。
      verdict = VERDICT.PARTIAL;
      reasonCode = sem.reason_code || 'SEMANTIC_PARTIAL';
      reason = sem.reason || '语义核验判定：只解决了部分验收条件（未解决项保留在证据里）';
    } else if (semanticPassed) {
      verdict = VERDICT.PASS;
      reasonCode = 'ISSUE_VERIFIED';
      reason = sem.reason || '确定性检查与语义核验均通过';
    } else {
      verdict = VERDICT.NEED_CONTEXT;
      reasonCode = sem.reason_code
        || (sem.status === 'unverified' ? 'SEMANTIC_UNVERIFIED' : (sem.status === 'blocked' ? 'SEMANTIC_BLOCKED' : 'SEMANTIC_NOT_RUN'));
      reason = d.needContext.length
        ? `语义核验不可用（${sem.status}），且确定性层缺少可比对证据（${d.needContext.map((x) => x.criterion).join('；')}）：不得判为已解决`
        : '语义核验未运行或无法判定：确定性层只能证明"字符变了"，不能证明"问题解决了"';
    }
    // 蓝图/词条冲突是**结论性**的：不能因为模型说"我按审稿意见改了"就当成通过。
    // 统一收敛成 need_context + 单一原因码，避免出现"final_status=CANON_CONFLICT 但 reason_code=ISSUE_VERIFIED"这种自相矛盾的行。
    if (input.canonConflict === true) {
      verdict = VERDICT.NEED_CONTEXT;
      reasonCode = 'CANON_CONFLICT';
      reason = `审稿建议与固定蓝图/词条冲突，需作者裁决：${reason}`;
    }
    let finalStatus;
    if (input.canonConflict === true) finalStatus = FINAL.CANON_CONFLICT;
    else if (verdict === VERDICT.PASS) finalStatus = FINAL.ISSUE_VERIFIED;
    else if (verdict === VERDICT.PARTIAL) finalStatus = FINAL.PARTIAL;
    else if (verdict === VERDICT.FAIL) finalStatus = FINAL.UNRESOLVED;
    else finalStatus = FINAL.AWAITING_SEMANTIC;
    return {
      issue_id: id,
      verdict,
      final_status: finalStatus,
      reason_code: reasonCode,
      reason,
      checks,
      semantic_status: sem.status,
      confidence: sem.confidence || 'medium',
      // §7.1/§7.3：机器可读的"到底动没动"与"剩余证据"，供工作区与回执复核。
      actual_change: actualChange,
      patch_ids: issuePatches.map((p, i) => textOf(p.patch_id || p.span_id) || `P${i + 1}`),
      evidence_ids: evidenceRows.map((e) => e.id),
      // 2026-10-21：细粒度子条件结果（PASS/FAIL/SKIP）——"这条问题还差哪一个条件"必须可读，
      // 不能只剩一句"没通过"。SKIP 不是 PASS。
      condition_results: (d.conditionResults || []).map((r) => ({
        id: r.id, kind: r.kind, severity: r.severity, status: r.status,
        evidence: r.evidence, code: r.code,
      })),
      unresolved_conditions: (d.conditionResults || []).filter((r) => r.status === 'FAIL').map((r) => r.id),
      external_context: external.required
        ? { required: true, resolved: external.resolved === true, code: external.code, source: external.source || '', evidence: external.evidence }
        : null,
      // PASS 时只保留语义层显式列出的"剩余证据"（通常为空）；只读引用天然会留在候选里，
      // 把它们全列成"剩余证据"会让通过项看起来像还有未解决矛盾。
      remaining_evidence: verdict === VERDICT.PASS
        ? sem.remaining_evidence.map((q) => ({ evidence_id: '', role: 'semantic', quote: clip(q, 40) }))
        : remainingEvidenceAll,
      repair_hint: external.required
        ? (external.resolved
          ? '外部资料已有结论：把裁定与依据交给作者，不要改正文'
          : '先只读核对角色卡/词条的时点与含义；需要改卡时向作者要最小权限，不得派给正文修稿器')
        : (sem.repair_hint || (verdict === VERDICT.FAIL || verdict === VERDICT.PARTIAL
          ? '只在仍获准的热点内重写补丁；需要新增跨度时先回到授权界面，不得扩大改写范围'
          : '')),
      // 外部资料项不进自动复修：它不是"补丁没写好"，是"还缺一份资料核对"。
      targeted_repair: !external.required
        && ((verdict === VERDICT.FAIL && sem.status === 'fail') || (verdict === VERDICT.PARTIAL && sem.status === 'partial')),
    };
  }

  /**
   * 批量裁决 + 全局 diff 校验。
   *
   * 全局校验的意义：所有 issue 的补丁都"各自合法"，但拼起来是否等于候选稿？
   * 若不等，说明有改动没有对应的补丁记录（例如模型输出与执行器结果错位），
   * 这时**任何一条**都不该被判为已解决。
   */
  function verifyIssues(input = {}) {
    const findings = Array.isArray(input.findings) ? input.findings : [];
    const applied = Array.isArray(input.applied) ? input.applied : [];
    const baseText = textOf(input.baseText);
    const revisedText = textOf(input.revisedText);
    const coverageRows = Array.isArray(input.coverage) ? input.coverage : [];
    const coverageById = new Map(coverageRows.map((c) => [String(c && c.issue_id), c]));
    const semanticByIssue = input.semanticByIssue && typeof input.semanticByIssue === 'object' ? input.semanticByIssue : {};
    const canonIds = new Set((Array.isArray(input.canonConflictIds) ? input.canonConflictIds : []).map(String));

    // 分段路径的补丁是按**片内偏移**校准的（全局偏移不存在），全章重建必须由
    // 调用方（revision-finalize）用"逐片重建 + 合并拼接"证明后注入；这里不自己猜。
    const proof = input.reconstructProof && typeof input.reconstructProof === 'object' ? input.reconstructProof : null;
    const rebuilt = proof
      ? { ok: proof.ok === true, code: String(proof.code || 'SEGMENT_PROOF'), text: null }
      : reconstruct(baseText, applied);
    const global = [];
    global.push({
      criterion: proof
        ? '候选稿可由各片补丁逐字重建并完整拼接（分段证明）'
        : '候选稿可以由已记录补丁逐字重建（不存在无记录的改动）',
      passed: proof ? rebuilt.ok : (rebuilt.ok && rebuilt.text === revisedText),
      evidence: [
        proof
          ? (rebuilt.ok ? '分段重建与拼接证明通过' : `分段证明失败：${rebuilt.code}`)
          : (rebuilt.ok ? '补丁重建成功' : `补丁重建失败：${rebuilt.code}`),
        `diff=${revisedText === baseText ? 'none' : 'yes'}`,
      ],
    });
    const globalFailed = global.some((c) => !c.passed);

    const issues = findings.map((finding) => {
      const id = String(finding && finding.id);
      const one = verifyIssue({
        finding,
        baseText,
        revisedText,
        applied,
        plan: input.plan,
        coverage: coverageById.get(id) || null,
        invariants: input.invariants,
        protectedSpans: input.protectedSpans,
        canonConflict: canonIds.has(id),
        semantic: semanticByIssue[id],
        entryVersions: input.entryVersionsByIssue && typeof input.entryVersionsByIssue === 'object'
          ? { [id]: input.entryVersionsByIssue[id] } : undefined,
        propChains: input.propChainsByIssue && typeof input.propChainsByIssue === 'object'
          ? { [id]: input.propChainsByIssue[id] } : undefined,
        currentBaseHash: input.currentBaseHash,
        crossSegment: input.crossSegmentByIssue && typeof input.crossSegmentByIssue === 'object' ? input.crossSegmentByIssue[id] : null,
        // Q05：外部资料核对结论按 issue 注入（缺省 = 还没核对，见 externalContextGate）。
        externalContext: input.externalContextByIssue && typeof input.externalContextByIssue === 'object'
          ? input.externalContextByIssue[id] : null,
      });
      if (globalFailed) {
        return {
          ...one,
          verdict: VERDICT.FAIL,
          final_status: FINAL.UNRESOLVED,
          reason_code: 'DIFF_MISMATCH',
          reason: `全局 diff 校验失败：候选稿与"已记录补丁的重建结果"不一致 —— ${one.reason}`,
          checks: [...one.checks, ...global],
        };
      }
      // 覆盖表给的是"处置"，最终结论仍以本裁决为准；但 blocked/refused 等必须如实带出原因码。
      const cov = coverageById.get(id);
      const covCode = cov && COVERAGE_REASON[cov.status] ? COVERAGE_REASON[cov.status] : '';
      if (one.verdict !== VERDICT.PASS && !one.reason_code && covCode) {
        return { ...one, reason_code: covCode };
      }
      if (one.verdict !== VERDICT.PASS && covCode && one.reason_code === 'SEMANTIC_NOT_RUN') {
        return { ...one, reason_code: covCode };
      }
      return one;
    });

    const summary = {
      total: issues.length,
      verified: issues.filter((i) => i.verdict === VERDICT.PASS).length,
      partial: issues.filter((i) => i.verdict === VERDICT.PARTIAL).length,
      unresolved: issues.filter((i) => i.verdict === VERDICT.FAIL).length,
      awaiting_semantic: issues.filter((i) => i.verdict === VERDICT.NEED_CONTEXT).length,
      canon_conflict: issues.filter((i) => i.final_status === FINAL.CANON_CONFLICT).length,
      semantic_not_run: issues.filter((i) => i.semantic_status === 'not_run').length,
      semantic_unverified: issues.filter((i) => ['unverified', 'blocked'].includes(i.semantic_status)).length,
      deterministic_failed: issues.filter((i) => i.reason_code === 'DETERMINISTIC_FAILED').length,
      diff_ok: !globalFailed,
    };
    return { issues, global, summary, verdict: closureStatusOf(issues), reconstructed: rebuilt.ok ? rebuilt.text : null };
  }

  /** 由逐条结论汇总整体状态（单一实现，界面与服务端都读它）。 */
  function closureStatusOf(issues) {
    const list = Array.isArray(issues) ? issues : [];
    if (!list.length) return 'NOT_RUN';
    if (list.some((i) => i.final_status === FINAL.CANON_CONFLICT)) return 'CANON_CONFLICT';
    // PARTIAL 是"有结论，但不是通过"：既不进 NEEDS_REVIEW，也绝不能进 VERIFIED_CANDIDATE。
    if (list.some((i) => i.verdict === VERDICT.FAIL || i.verdict === VERDICT.PARTIAL)) return 'PARTIAL_OR_FAILED';
    if (list.some((i) => i.verdict === VERDICT.NEED_CONTEXT)) return 'NEEDS_REVIEW';
    return 'VERIFIED_CANDIDATE';
  }

  return {
    VERSION,
    VERDICT,
    FINAL,
    SEMANTIC_STATUSES,
    COVERAGE_REASON,
    reconstruct,
    deterministicChecks,
    evalConditions,
    externalContextGate,
    overlapsEvidence,
    normalizeSemantic,
    verifyIssue,
    verifyIssues,
    closureStatusOf,
  };
});
