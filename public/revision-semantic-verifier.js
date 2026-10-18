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

  const VERSION = '1.0.0';
  const VERDICT = { PASS: 'pass', FAIL: 'fail', NEED_CONTEXT: 'need_context' };
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

  function pushCheck(checks, criterion, passed, evidence, extra = {}) {
    checks.push({ criterion, passed: passed === true, evidence: Array.isArray(evidence) ? evidence : (evidence ? [String(evidence)] : []), ...extra });
    return passed === true;
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

    // ① 证据按角色变化：可编辑锚点应消失；只读引用应保留（它是"对比的另一头"）。
    for (const e of ev) {
      const quote = textOf(e && e.quote).trim();
      if (!quote) continue;
      const before = countOf(baseText, quote);
      const after = countOf(revisedText, quote);
      if (e.role === 'candidate_edit') {
        if (!before) { needContext.push({ criterion: 'editable_anchor_present_before', quote: clip(quote, 30) }); continue; }
        pushCheck(checks, `可编辑锚点已消失：${clip(quote, 24)}`, after === 0,
          [`修前出现 ${before} 次 → 修后 ${after} 次`], { role: 'candidate_edit', quote });
      } else {
        if (!before) { needContext.push({ criterion: 'reference_present_before', quote: clip(quote, 30) }); continue; }
        pushCheck(checks, `只读证据仍完整：${clip(quote, 24)}`, after > 0,
          [`只读证据在修前 ${before} 次、修后 ${after} 次（对比基准不能被改掉）`], { role: 'reference', quote });
      }
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
        [`修前 ${before} 次 → 修后 ${after} 次`], { preserve: keep });
    }

    // ③ 声称已改但没有实际 diff（R-17）：覆盖表说 patched，却没有任何补丁落在本 issue 上。
    const coverage = input.coverage && typeof input.coverage === 'object' ? input.coverage : null;
    const status = textOf(coverage && coverage.status) || '';
    if (status === 'patched' || status === 'partially_resolved') {
      pushCheck(checks, '声称已处理的条目必须有实际补丁（无 diff 不算已改）',
        issuePatches.length > 0, [`applied=${issuePatches.length}`], { code: 'NO_DIFF' });
    }
    if (status === 'unaccounted') {
      pushCheck(checks, '覆盖表必须回答每一条已选问题', false, ['unaccounted：模型没有给出处置'], { code: 'UNACCOUNTED' });
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
            [`补丁 ${p.start}-${p.end} vs 热点 ${hotspots.map((h) => `${h.start}-${h.end}`).join(',')}`], { code: 'OUT_OF_SCOPE' });
        }
      }
    }

    // ⑤ 底稿版本：调用方给了当前哈希时才判（没给就不假装核验过）。
    if (input.currentBaseHash != null && plan && plan.base_hash) {
      pushCheck(checks, '底稿与计划快照一致', String(input.currentBaseHash) === String(plan.base_hash),
        [String(input.currentBaseHash), String(plan.base_hash)], { code: 'BASE_STALE' });
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

    return { checks, failed: checks.filter((c) => !c.passed), needContext };
  }

  /** 语义层结果归一化：接受字符串、`{status}` 或 `{verdict}`，其余一律 not_run（不猜通过）。 */
  function normalizeSemantic(raw) {
    const base = { status: 'not_run', checks: [], reason: '', repair_hint: '', confidence: 'medium' };
    if (raw == null) return base;
    if (typeof raw === 'string') {
      const s = raw.toLowerCase();
      return { ...base, status: s === 'pass' || s === 'passed' || s === 'ok' ? 'pass' : (s === 'fail' || s === 'failed' ? 'fail' : 'not_run') };
    }
    if (typeof raw !== 'object') return base;
    const s = textOf(raw.status != null ? raw.status : raw.verdict).toLowerCase();
    const status = s === 'pass' || s === 'passed' || s === 'ok' ? 'pass' : (s === 'fail' || s === 'failed' ? 'fail' : 'not_run');
    return {
      status,
      checks: Array.isArray(raw.checks) ? raw.checks : [],
      reason: textOf(raw.reason),
      repair_hint: textOf(raw.repair_hint),
      confidence: ['high', 'medium', 'low'].includes(textOf(raw.confidence)) ? textOf(raw.confidence) : 'medium',
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
    const deterministicFailed = d.failed.length > 0;
    const semanticFailed = sem.status === 'fail';
    const semanticPassed = sem.status === 'pass';
    let verdict;
    let reasonCode;
    let reason;
    if (deterministicFailed && semanticPassed) {
      // 两层冲突：不选"看起来更好"的那一层，交人复核（方案 §5.4）。
      verdict = VERDICT.NEED_CONTEXT;
      reasonCode = 'LAYER_CONFLICT';
      reason = `确定性层未通过（${d.failed.map((c) => c.criterion).slice(0, 2).join('；')}），语义层却判通过：结论冲突，按待复核处理`;
    } else if (deterministicFailed) {
      verdict = VERDICT.FAIL;
      const first = d.failed[0];
      reasonCode = (first && first.code) || 'DETERMINISTIC_FAILED';
      reason = `确定性检查未通过：${d.failed.map((c) => c.criterion).slice(0, 3).join('；')}`;
    } else if (semanticFailed) {
      verdict = VERDICT.FAIL;
      reasonCode = 'SEMANTIC_FAILED';
      reason = sem.reason || '语义核验判定未通过';
    } else if (semanticPassed) {
      verdict = VERDICT.PASS;
      reasonCode = 'ISSUE_VERIFIED';
      reason = sem.reason || '确定性检查与语义核验均通过';
    } else {
      verdict = VERDICT.NEED_CONTEXT;
      reasonCode = 'SEMANTIC_NOT_RUN';
      reason = d.needContext.length
        ? `语义核验未运行，且确定性层缺少可比对证据（${d.needContext.map((x) => x.criterion).join('；')}）：不得判为已解决`
        : '语义核验未运行：确定性层只能证明"字符变了"，不能证明"问题解决了"';
    }
    if (input.canonConflict === true && verdict !== VERDICT.PASS) {
      verdict = VERDICT.NEED_CONTEXT;
      reasonCode = 'CANON_CONFLICT';
      reason = `审稿建议与固定蓝图/词条冲突：${reason}`;
    }
    let finalStatus;
    if (input.canonConflict === true) finalStatus = FINAL.CANON_CONFLICT;
    else if (verdict === VERDICT.PASS) finalStatus = FINAL.ISSUE_VERIFIED;
    else if (verdict === VERDICT.FAIL) finalStatus = FINAL.UNRESOLVED;
    else finalStatus = FINAL.AWAITING_SEMANTIC;
    return {
      issue_id: String(input.finding && input.finding.id == null ? '' : (input.finding && input.finding.id)),
      verdict,
      final_status: finalStatus,
      reason_code: reasonCode,
      reason,
      checks,
      semantic_status: sem.status,
      confidence: sem.confidence || 'medium',
      repair_hint: sem.repair_hint || (verdict === VERDICT.FAIL
        ? '只在仍获准的热点内重写补丁；需要新增跨度时先回到授权界面，不得扩大改写范围'
        : ''),
      targeted_repair: verdict === VERDICT.FAIL && sem.status === 'fail',
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

    const rebuilt = reconstruct(baseText, applied);
    const global = [];
    global.push({
      criterion: '候选稿可以由已记录补丁逐字重建（不存在无记录的改动）',
      passed: rebuilt.ok && rebuilt.text === revisedText,
      evidence: [rebuilt.ok ? '补丁重建成功' : `补丁重建失败：${rebuilt.code}`, `diff=${revisedText === baseText ? 'none' : 'yes'}`],
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
      unresolved: issues.filter((i) => i.verdict === VERDICT.FAIL).length,
      awaiting_semantic: issues.filter((i) => i.verdict === VERDICT.NEED_CONTEXT).length,
      canon_conflict: issues.filter((i) => i.final_status === FINAL.CANON_CONFLICT).length,
      semantic_not_run: issues.filter((i) => i.semantic_status === 'not_run').length,
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
    if (list.some((i) => i.verdict === VERDICT.FAIL)) return 'PARTIAL_OR_FAILED';
    if (list.some((i) => i.verdict === VERDICT.NEED_CONTEXT)) return 'NEEDS_REVIEW';
    return 'VERIFIED_CANDIDATE';
  }

  return {
    VERSION,
    VERDICT,
    FINAL,
    COVERAGE_REASON,
    reconstruct,
    deterministicChecks,
    normalizeSemantic,
    verifyIssue,
    verifyIssues,
    closureStatusOf,
  };
});
