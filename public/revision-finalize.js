/*
 * 修稿最终验收出口（revision-finalize）—— 纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么必须**只有一个**出口（v1.2.4 方案 §6.2 / P0C / Q-10 / Q-11 / Q-12）：
 *   修稿有两条生产候选的路径——单请求与分段。过去验收只挂在单请求那条路上：
 *   分段路径聚合完 `appliedCount / blocked / notes` 就直接弹差异预览，
 *   于是"没跑语义"在分段路径上被读成"改完了"，同一份素材换条路径就换一套结论。
 *   现在两条路径都必须经过 `finalizeRevisionCandidate()`：
 *
 *     候选结构归一 → 候选可否由补丁逐字重建 → 逐条终审 → 语义覆盖完备性
 *     → 闭环状态（补丁 ≠ 已解决 ≠ 已入库）→ 一致的 stage / next_action。
 *
 * 三条写死在实现里的纪律（对应 §4.1 / §4.3）：
 *   ① 未跑语义的条目只能停在 `AWAITING_SEMANTIC`，**永不**计入"通过"；
 *   ② `PATCH_APPLIED` 不蕴含 `ISSUE_VERIFIED`，`ISSUE_VERIFIED` 不蕴含 `PERSISTED_VERIFIED`；
 *   ③ 分段缺合并证明 / 覆盖不全 / 有片失败时不得产出 `VERIFIED_CANDIDATE`（fail-closed）。
 *
 * 本模块不写文件、不调用模型、不接触作者审批凭据；语义层结论由调用方注入。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionFinalize = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const VERSION = '1.2.4';
  const CANDIDATE_SCHEMA = 'revision-candidate/1.2.4';
  const RUN_SCHEMA = '1.2.4';

  /** 运行级阶段（方案 §4.1 的运行状态机，收敛成界面与回执共用的枚举）。 */
  const STAGE = {
    AWAITING_SEMANTIC: 'AWAITING_SEMANTIC',
    PARTIAL_CANDIDATE: 'PARTIAL_CANDIDATE',
    BLOCKED: 'BLOCKED',
    VERIFIED_CANDIDATE: 'VERIFIED_CANDIDATE',
    PERSISTED_VERIFIED: 'PERSISTED_VERIFIED',
  };

  /** 问题级终态（与 revision-closure / verifier 同名，避免第三套词汇）。 */
  const FINAL = {
    ISSUE_VERIFIED: 'ISSUE_VERIFIED',
    PARTIAL: 'PARTIAL',
    UNRESOLVED: 'UNRESOLVED',
    AWAITING_SEMANTIC: 'AWAITING_SEMANTIC',
    CANON_CONFLICT: 'CANON_CONFLICT',
    NOT_SELECTED: 'NOT_SELECTED',
  };

  /** 有"结论"的终态：出现这些才算这一条**被回答过**；AWAITING_SEMANTIC 不算。 */
  const CONCLUSIVE = new Set([FINAL.ISSUE_VERIFIED, FINAL.PARTIAL, FINAL.UNRESOLVED, FINAL.CANON_CONFLICT]);
  const COVERAGE_VERDICTS = new Set(['pass', 'fail', 'need_context']);

  const BLOCK_REASON = {
    VERIFIER_UNAVAILABLE: '验收模块未加载：无法逐条给出结论，本次不产生"已修好"结论',
    SAFETY_UNAVAILABLE: '安全门禁不可用：候选未产出（原文未改动），不能进入验收',
    SEGMENT_MERGE_INCOMPLETE: '分段合并未通过覆盖清单：候选不完整，不得进入验收',
    SEGMENT_MERGE_UNPROVEN: '调用方没有提供分段合并证明：按未验证处理（fail-closed）',
    SEGMENT_SEGMENT_FAILED: '存在失败/越界/过期的分段：整章候选不完整',
    BASE_STALE: '底稿已变化：旧候选不得复用于当前正文',
  };

  const textOf = (x) => String(x == null ? '' : x);
  const uniqueStrings = (list) => [...new Set((Array.isArray(list) ? list : []).map(textOf).filter(Boolean))];
  const idsOfPatch = (p) => (Array.isArray(p && p.issue_ids) ? p.issue_ids : []).map(String).filter(Boolean);

  /**
   * 内容指纹：优先注入的 sha256（Node 侧 / 服务端），否则用与 revision-patch 同口径的
   * FNV-1a 32 位 + UTF-16 长度，并**如实标注** `hash_alg` —— 不把工具函数冒充 sha256。
   */
  function contentHash(text, sha256) {
    const s = textOf(text);
    if (typeof sha256 === 'function') {
      try {
        const h = sha256(s);
        if (h) return { hash: `sha256:${h}`, hash_alg: 'sha256' };
      } catch (_) { /* 注入失败按本地指纹处理，不假装算过 */ }
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { hash: `fnv1a:${h.toString(16)}:${s.length}`, hash_alg: 'fnv1a32+len' };
  }

  /**
   * 语义覆盖完备性（方案 §4.3 的 `semanticCoverageComplete`）。
   *
   * 关键区别：`not_run` **不是**一个 verdict。它的意思是"这条还要验收"，
   * 既不能算通过，也不该被送去做定向复修（那会让模型在没核验的情况下瞎改）。
   * @returns {{complete:boolean, covered:string[], missing:string[], pending:string[], total:number, covered_count:number}}
   */
  function semanticCoverageComplete(selectedIds, verdicts) {
    const ids = uniqueStrings(selectedIds);
    const list = Array.isArray(verdicts)
      ? verdicts
      : (verdicts && typeof verdicts === 'object'
        ? Object.entries(verdicts).map(([k, v]) => (v && typeof v === 'object' ? { issue_id: k, ...v } : { issue_id: k, verdict: v }))
        : []);
    const map = new Map();
    for (const v of list) {
      if (!v || typeof v !== 'object') continue;
      const id = textOf(v.issue_id != null ? v.issue_id : v.id);
      if (!id) continue;
      map.set(id, v);
    }
    const covered = [];
    const missing = [];
    const pending = [];
    for (const id of ids) {
      const v = map.get(id);
      if (!v) { missing.push(id); continue; }
      const raw = textOf(v.verdict != null ? v.verdict : v.semantic_status).toLowerCase();
      if (COVERAGE_VERDICTS.has(raw)) covered.push(id);
      else pending.push(id);
    }
    return {
      complete: ids.length > 0 && covered.length === ids.length,
      covered, missing, pending,
      total: ids.length, covered_count: covered.length,
    };
  }

  /** findings 去重：分段/多入口可能带来同一 issue 的多份条目，最终只能有一个终审结论（Q-11）。 */
  function normalizeFindings(findings, selectedIds) {
    const list = Array.isArray(findings) ? findings : [];
    const wanted = new Set(selectedIds);
    const map = new Map();
    list.forEach((f, i) => {
      if (!f || typeof f !== 'object') return;
      const id = textOf(f.id != null ? f.id : i + 1);
      if (!id) return;
      if (wanted.size && !wanted.has(id)) return;
      const prev = map.get(id);
      // 保留证据更多的那一份（重复条目里通常只有一份带逐字 evidence）。
      const prevEv = prev && Array.isArray(prev.evidence) ? prev.evidence.length : -1;
      const curEv = Array.isArray(f.evidence) ? f.evidence.length : -1;
      if (!prev || curEv > prevEv) map.set(id, { ...f, id });
    });
    // 被勾选但没有任何 finding 的条目也要有行：否则"8 项全选"会静默变成 7 行。
    for (const id of selectedIds) {
      if (!map.has(id)) map.set(id, { id, text: '', explanation: '', type: 'other', severity: 'medium', evidence: [], acceptance: { rule: '', preserve: [] }, legacy: true });
    }
    return [...map.values()];
  }

  /**
   * 覆盖表合并（分段）：同一条 issue 横跨多片时只留一个最终处置。
   * 优先级取"更保守"的那一个——任何一片说 blocked/deferred/unaccounted 都不能被另一片的
   * patched 擦掉；只有全部片都说 patched 才敢记 patched。
   */
  const COVERAGE_RANK = { patched: 4, partially_resolved: 3, keep: 2, deferred: 2, needs_scope: 1, ambiguous_anchor: 1, authorization_missing: 1, refused: 1, blocked: 0, unaccounted: -1 };
  function mergeCoverageRows(lists, selectedIds) {
    const ids = selectedIds && selectedIds.length ? selectedIds : [];
    const acc = new Map();
    for (const rows of (Array.isArray(lists) ? lists : [])) {
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (!row || row.issue_id == null) continue;
        const id = String(row.issue_id);
        const prev = acc.get(id);
        const rank = COVERAGE_RANK[textOf(row.status)] == null ? -2 : COVERAGE_RANK[textOf(row.status)];
        if (!prev || rank < prev.rank) {
          acc.set(id, { issue_id: id, status: textOf(row.status), reason: textOf(row.reason), rank, target_count: Number(row.target_count) || 0, reference_count: Number(row.reference_count) || 0 });
        }
      }
    }
    const out = [...acc.values()].map(({ rank, ...row }) => row);
    // 勾选清单是权威：覆盖表没回答的条目要显式记 unaccounted（不能凭空消失在统计里）。
    const answered = new Set(out.map((r) => r.issue_id));
    for (const id of ids) if (!answered.has(id)) out.push({ issue_id: id, status: 'unaccounted', reason: '', target_count: 0, reference_count: 0 });
    return out;
  }

  /** 单条终态 → 覆盖 verdict（喂给 semanticCoverageComplete 的唯一口径）。 */
  function coverageVerdictOf(row) {
    const s = textOf(row && row.final_status);
    if (s === FINAL.ISSUE_VERIFIED) return 'pass';
    if (s === FINAL.UNRESOLVED) return 'fail';
    if (s === FINAL.CANON_CONFLICT) return 'need_context';
    if (s === FINAL.PARTIAL) return 'need_context';
    return 'not_run';
  }

  /** 候选规范（方案 §6.2）：分段只影响"怎么产出候选"，不影响验收字段。 */
  function normalizeCandidate(input = {}) {
    const originalText = textOf(input.originalText != null ? input.originalText : input.baseText);
    const candidateText = textOf(input.candidateText != null ? input.candidateText : input.revisedText);
    const oh = contentHash(originalText, input.sha256);
    const ch = contentHash(candidateText, input.sha256);
    const applied = (Array.isArray(input.applied) ? input.applied : []).map((p) => ({ ...p }));
    const blocked = (Array.isArray(input.blocked) ? input.blocked : []).map((p) => ({ ...p }));
    return {
      schema_version: CANDIDATE_SCHEMA,
      revision_run_id: textOf(input.revisionRunId) || `run:${oh.hash}:${ch.hash}`,
      work_id: input.workId == null ? '' : String(input.workId),
      chapter_id: input.chapterId == null ? '' : String(input.chapterId),
      review_id: input.reviewId == null ? '' : String(input.reviewId),
      mode: input.mode === 'segmented' ? 'segmented' : 'single',
      original_hash: oh.hash,
      candidate_hash: ch.hash,
      hash_alg: oh.hash_alg === ch.hash_alg ? oh.hash_alg : `${oh.hash_alg}/${ch.hash_alg}`,
      selected_issue_ids: uniqueStrings(input.selectedIssueIds),
      applied_patches: applied,
      blocked_patches: blocked,
      issue_coverage: Array.isArray(input.coverage) ? input.coverage.map((c) => ({ ...c })) : [],
      segment_count: Array.isArray(input.segments) ? input.segments.length : 0,
      safety: {
        available: input.safetyAvailable !== false,
        verified: input.safetyVerified === true,
        reasons: (Array.isArray(input.safetyReasons) ? input.safetyReasons : []).map(textOf),
      },
      merge: { complete: input.mergeComplete === true },
      original_chars: originalText.length,
      candidate_chars: candidateText.length,
    };
  }

  function segmentProof(segments, mergeComplete) {
    const list = Array.isArray(segments) ? segments : [];
    const failed = list.filter((s) => s && (s.proof_ok === false || s.status === 'failed' || s.status === 'violation' || s.status === 'stale'));
    if (!list.length) return { ok: false, code: 'SEGMENT_MERGE_UNPROVEN', failed: [] };
    if (mergeComplete !== true) return { ok: false, code: 'SEGMENT_MERGE_UNPROVEN', failed: [] };
    if (failed.length) return { ok: false, code: 'SEGMENT_SEGMENT_FAILED', failed: failed.map((s) => textOf(s.segment_id)) };
    return { ok: true, code: 'SEGMENT_PROOF_OK', failed: [] };
  }

  function summaryOf(rows, coverageState) {
    return {
      total: rows.length,
      verified: rows.filter((r) => r.final_status === FINAL.ISSUE_VERIFIED).length,
      unresolved: rows.filter((r) => r.final_status === FINAL.UNRESOLVED).length,
      awaiting_semantic: rows.filter((r) => r.final_status === FINAL.AWAITING_SEMANTIC).length,
      partial: rows.filter((r) => r.final_status === FINAL.PARTIAL).length,
      canon_conflict: rows.filter((r) => r.final_status === FINAL.CANON_CONFLICT).length,
      semantic_not_run: rows.filter((r) => r.semantic_status === 'not_run').length,
      patch_applied: rows.filter((r) => r.patch_count > 0).length,
      coverage_complete: coverageState.complete,
      coverage_missing: coverageState.missing.length,
      coverage_pending: coverageState.pending.length,
    };
  }

  function nextActionOf(stage, summary, coverageState) {
    if (stage === STAGE.BLOCKED) return { code: 'FIX_BLOCKER', label: '按阻塞原因修复后重跑（不得绕过门禁）' };
    if (stage === STAGE.PERSISTED_VERIFIED) return { code: 'DONE', label: '无（已入库并复核）' };
    if (stage === STAGE.VERIFIED_CANDIDATE) return { code: 'AWAIT_AUTHOR_COMMIT', label: '等待作者按现有审批流程合并到正文' };
    if (stage === STAGE.AWAITING_SEMANTIC) {
      return { code: 'RUN_SEMANTIC_VERIFY', label: `运行独立语义复验：${summary.awaiting_semantic} 条待验（未验不得算通过）` };
    }
    if (summary.canon_conflict) return { code: 'AWAIT_AUTHOR_DECISION', label: `${summary.canon_conflict} 条与蓝图/词条冲突，需作者裁决` };
    return { code: 'TARGETED_REPAIR', label: `只复修未通过项（${summary.unresolved} 条），仍限原授权范围` };
  }

  /**
   * 唯一出口。任何调用方（单请求 / 分段 / 接回进度 / 复验后）都必须走这里。
   * @returns {{status:string, rows:Array, summary:object, coverage:object, next_action:object,
   *            semantic:object, closure:object|null, candidate:object, parity:object, reasons:string[]}}
   */
  function finalizeRevisionCandidate(input = {}) {
    const SV = input.verifier || (root && root.NovelRevisionSemanticVerifier) || null;
    const CL = input.closure || (root && root.NovelRevisionClosure) || null;
    const mode = input.mode === 'segmented' ? 'segmented' : 'single';
    const selected = uniqueStrings(input.selectedIssueIds);
    const findings = normalizeFindings(input.findings, selected);
    const applied = (Array.isArray(input.applied) ? input.applied : []).map((p) => ({ ...p }));
    const blocked = (Array.isArray(input.blocked) ? input.blocked : []).map((p) => ({ ...p }));
    // segmentCoverage 既可能是"各片覆盖表组成的数组"，也可能是一张已合并的覆盖表：两种都认。
    const segCoverage = Array.isArray(input.segmentCoverage) ? input.segmentCoverage : [];
    const segLists = segCoverage.length && Array.isArray(segCoverage[0]) ? segCoverage : [segCoverage];
    const coverage = mergeCoverageRows(
      [Array.isArray(input.coverage) ? input.coverage : [], ...segLists],
      selected,
    );
    const candidate = normalizeCandidate({ ...input, mode, selectedIssueIds: selected, applied, blocked, coverage });
    const originalText = textOf(input.originalText != null ? input.originalText : input.baseText);
    const candidateText = textOf(input.candidateText != null ? input.candidateText : input.revisedText);
    const safetyAvailable = input.safetyAvailable !== false;
    const proof = mode === 'segmented' ? segmentProof(input.segments, input.mergeComplete) : { ok: true, code: 'SINGLE_OK', failed: [] };

    const blockers = [];
    if (!SV) blockers.push('VERIFIER_UNAVAILABLE');
    if (!safetyAvailable) blockers.push('SAFETY_UNAVAILABLE');
    if (!proof.ok) blockers.push(proof.code);

    // ── ① 逐条终审（verifier 不可用时不做"尽力而为"的猜测）─────────────────────
    let verified = null;
    let verifyError = '';
    if (SV && !blockers.includes('VERIFIER_UNAVAILABLE')) {
      try {
        verified = SV.verifyIssues({
          findings,
          baseText: originalText,
          revisedText: candidateText,
          applied,
          // 分段路径的补丁按片校准（全局偏移不存在），授权在逐片应用时已强制执行；
          // 因此这里不下发整章 plan，避免拿片内偏移去比整章热点（会误判越权）。
          plan: mode === 'segmented' ? null : (input.plan || null),
          coverage,
          invariants: input.invariants || { must_keep: [] },
          protectedSpans: input.protectedSpans || [],
          currentBaseHash: input.currentBaseHash,
          semanticByIssue: input.semanticByIssue || {},
          canonConflictIds: input.canonConflictIds || [],
          entryVersionsByIssue: input.entryVersionsByIssue || null,
          propChainsByIssue: input.propChainsByIssue || null,
          // 分段：合并证明由本模块给（逐片重建 + 合并拼接），verifier 不再自己拼全局偏移。
          reconstructProof: mode === 'segmented' ? { ok: proof.ok, code: proof.code } : null,
        });
      } catch (e) {
        verifyError = textOf(e && e.message) || 'verifier error';
        blockers.push('VERIFIER_UNAVAILABLE');
      }
    }
    const byId = new Map(((verified && Array.isArray(verified.issues)) ? verified.issues : []).map((i) => [String(i && i.issue_id), i]));

    // ── ② 逐条行（勾选清单是权威：每一条都必须出现，且有终态或"待验"）──────────
    let rows = selected.map((id) => {
      const v = byId.get(id) || null;
      const cov = coverage.find((c) => String(c.issue_id) === id) || null;
      const patches = applied.filter((p) => idsOfPatch(p).includes(id));
      const evidence = (findings.find((f) => String(f.id) === id) || {}).evidence;
      const canon = input.canonByIssue && typeof input.canonByIssue === 'object' ? input.canonByIssue[id] : null;
      return {
        issue_id: id,
        title: textOf(((findings.find((f) => String(f.id) === id) || {}).title)
          || ((findings.find((f) => String(f.id) === id) || {}).text)).slice(0, 60),
        selected: true,
        evidence_count: Array.isArray(evidence) ? evidence.length : 0,
        patch_count: patches.length,
        coverage_status: cov ? textOf(cov.status) : 'unaccounted',
        gate_status: patches.length ? 'PASS' : (cov && ['blocked', 'refused'].includes(cov.status) ? 'BLOCKED' : 'NOT_RUN'),
        authorized: cov ? cov.status === 'patched' || cov.status === 'partially_resolved' : false,
        target_count: cov ? Number(cov.target_count) || 0 : 0,
        reference_count: cov ? Number(cov.reference_count) || 0 : 0,
        semantic_status: v ? (textOf(v.semantic_status) || 'not_run') : 'not_run',
        verdict: v ? (textOf(v.verdict) || 'need_context') : 'need_context',
        final_status: v ? (textOf(v.final_status) || FINAL.AWAITING_SEMANTIC) : FINAL.AWAITING_SEMANTIC,
        reason_code: v ? textOf(v.reason_code) : 'SEMANTIC_NOT_RUN',
        reason: v ? textOf(v.reason) : '没有这一条的验收记录：不得算作已解决',
        repair_hint: v ? textOf(v.repair_hint) : '',
        checks: v && Array.isArray(v.checks) ? v.checks : [],
        // v1.2.4 P1：词条强弱归因（hard=交作者裁决 / soft=只作建议 / unknown=缺权威词条）
        canon: canon ? { strength: textOf(canon.strength), basis: textOf(canon.basis), reason: textOf(canon.reason), entry_id: canon.entry_id == null ? null : canon.entry_id, entry_title: textOf(canon.entry_title) } : null,
      };
    });

    // ── ③ 硬阻塞：任何一条都不许留在"看起来修好了"的状态 ────────────────────
    if (blockers.length) {
      const code = blockers[0];
      rows = rows.map((r) => ({
        ...r,
        final_status: FINAL.UNRESOLVED,
        verdict: 'fail',
        reason_code: code,
        reason: `${BLOCK_REASON[code] || code}${r.reason ? `；原始记录：${r.reason}` : ''}`,
      }));
    }

    const coverageState = semanticCoverageComplete(selected, rows.map((r) => ({ issue_id: r.issue_id, verdict: coverageVerdictOf(r) })));

    // ── ③b 分段跨边界联合证据（v1.2.4 P1）──────────────────────────────────
    // 一条问题的可编辑锚点可能分散在多个片里。**只改到其中一片不能证明这一项解决了**：
    // 之前我们只按"整章重建 + 逐条终审"间接发现它（锚点原句还在 → ANCHOR_NOT_EDITED），
    // 但没有任何地方**记录**"这条问题的证据跨了哪几片、哪一片没被处理"。
    // 现在把它算出来挂到行上并写进运行记录：界面能说清，回执能复核。
    const crossSegment = {};
    if (mode === 'segmented') {
      const segs = Array.isArray(input.segments) ? input.segments : [];
      for (const seg of segs) {
        const sid = textOf(seg && seg.segment_id);
        const ids = Array.isArray(seg && seg.evidence_editable_issue_ids) ? seg.evidence_editable_issue_ids.map(String) : [];
        for (const id of ids) {
          if (!crossSegment[id]) crossSegment[id] = { evidence_segments: [], patched_segments: [], untouched_segments: [] };
          if (!crossSegment[id].evidence_segments.includes(sid)) crossSegment[id].evidence_segments.push(sid);
        }
      }
      for (const p of applied) {
        const sid = textOf(p && p.segment_id);
        if (!sid) continue;
        for (const id of idsOfPatch(p)) {
          if (!crossSegment[id]) crossSegment[id] = { evidence_segments: [], patched_segments: [], untouched_segments: [] };
          if (!crossSegment[id].patched_segments.includes(sid)) crossSegment[id].patched_segments.push(sid);
        }
      }
      for (const info of Object.values(crossSegment)) {
        info.split = info.evidence_segments.length >= 2;
        info.untouched_segments = info.evidence_segments.filter((s) => !info.patched_segments.includes(s));
      }
    }
    rows = rows.map((r) => ({ ...r, cross_segment: crossSegment[r.issue_id] || null }));
    const summary = summaryOf(rows, coverageState);
    const allVerified = rows.length > 0 && summary.verified === rows.length;
    const persisted = input.persisted === true;
    const baseMatches = input.baseMatches;

    let status;
    const reasons = [];
    if (blockers.length) {
      status = STAGE.BLOCKED;
      reasons.push(...blockers.map((c) => BLOCK_REASON[c] || c));
    } else if (persisted && baseMatches === false) {
      status = STAGE.BLOCKED;
      reasons.push(BLOCK_REASON.BASE_STALE);
    } else if (persisted && allVerified) {
      status = STAGE.PERSISTED_VERIFIED;
      reasons.push('所有已选问题都通过语义验收，写回成功且保存后版本一致');
    } else if (allVerified) {
      status = STAGE.VERIFIED_CANDIDATE;
      reasons.push('所有已选问题都通过语义验收，但作者尚未批准写回：这是候选稿，不是已入库定稿');
    } else if (!coverageState.complete) {
      status = STAGE.AWAITING_SEMANTIC;
      reasons.push(`还有 ${coverageState.total - coverageState.covered_count} 条问题没有验收结论（待验 ≠ 通过）`);
    } else {
      status = STAGE.PARTIAL_CANDIDATE;
      reasons.push(`${summary.unresolved + summary.partial + summary.canon_conflict} 条已选问题未通过语义验收：候选稿不是"全部修好"`);
    }
    if (verifyError) reasons.push(`验收器异常：${verifyError}`);

    // ── ④ 闭环状态（补丁 / 门禁 / 语义 / 入库四件事分开记账）────────────────
    let closure = null;
    if (CL) {
      try {
        const closureIssues = CL.buildIssueStates({
          selectedIssueIds: selected,
          coverage,
          applied,
          verification: { issues: rows },
          blocked,
          safety_available: safetyAvailable,
        });
        const closureVerdict = CL.closureVerdict({ issues: closureIssues, safetyPassed: safetyAvailable && proof.ok, persisted, baseMatches });
        closure = CL.closureReport({
          issues: closureIssues,
          coverage,
          applied,
          safetyPassed: safetyAvailable && proof.ok,
          canonPassed: summary.canon_conflict > 0 ? false : true,
          persisted,
          baseMatches,
          verdict: closureVerdict,
        });
        closure.semantic_coverage_complete = coverageState.complete;
        closure.awaiting_semantic_ids = rows.filter((r) => r.final_status === FINAL.AWAITING_SEMANTIC).map((r) => r.issue_id);
        closure.required_unresolved_ids = rows.filter((r) => r.final_status !== FINAL.ISSUE_VERIFIED).map((r) => r.issue_id);
      } catch (_) { closure = null; }
    }

    const semantic = {
      issues: rows,
      global: verified && Array.isArray(verified.global) ? verified.global : [],
      summary: {
        ...summary,
        diff_ok: !!(verified && verified.summary && verified.summary.diff_ok),
        deterministic_failed: rows.filter((r) => textOf(r.reason_code).startsWith('DETERMINISTIC') || r.reason_code === 'DIFF_MISMATCH').length,
      },
      coverage_complete: coverageState.complete,
      status: status === STAGE.BLOCKED ? 'BLOCKED' : (allVerified ? 'VERIFIED_CANDIDATE' : 'PARTIAL_OR_AWAITING'),
    };

    const parity = {
      mode,
      key: [
        status === STAGE.PARTIAL_CANDIDATE || status === STAGE.AWAITING_SEMANTIC ? 'NOT_VERIFIED' : status,
        coverageState.complete ? 'complete' : 'incomplete',
        rows.map((r) => `${r.issue_id}:${r.final_status}:${r.reason_code}`).sort().join(','),
      ].join('|'),
    };

    return {
      schema_version: RUN_SCHEMA,
      status,
      stage: status,
      reasons,
      rows,
      summary,
      coverage: coverageState,
      next_action: nextActionOf(status, summary, coverageState),
      semantic,
      closure,
      candidate: { ...candidate, status, coverage_complete: coverageState.complete, proof_code: proof.code },
      parity,
    };
  }

  /**
   * 运行记录（方案 §3.3 的结构）：只放 hash / 计数 / 原因码，不放正文与提示词。
   * 供「修稿闭环回执」与 DSH 插件只读查询使用。
   */
  function runRecordOf(result, extra = {}) {
    const r = result || {};
    const rows = Array.isArray(r.rows) ? r.rows : [];
    const cand = r.candidate || {};
    return {
      schema_version: RUN_SCHEMA,
      revision_run_id: cand.revision_run_id || '',
      work_id: cand.work_id || '',
      chapter_id: cand.chapter_id || '',
      review_id: cand.review_id || '',
      base_hash: cand.original_hash || '',
      candidate_hash: cand.candidate_hash || '',
      hash_alg: cand.hash_alg || '',
      selected_issue_ids: cand.selected_issue_ids || [],
      mode: cand.mode || 'single',
      status: r.status || 'NOT_RUN',
      coverage_complete: !!(r.coverage && r.coverage.complete),
      summary: r.summary || null,
      issues: rows.map((row) => ({
        issue_id: String(row.issue_id || ''),
        evidence_count: Number(row.evidence_count) || 0,
        authorized_target_count: Number(row.target_count) || 0,
        patch_count: Number(row.patch_count) || 0,
        gate_status: row.gate_status || 'NOT_RUN',
        semantic_status: row.semantic_status || 'not_run',
        final_status: row.final_status || FINAL.AWAITING_SEMANTIC,
        reason_code: String(row.reason_code || ''),
        // v1.2.4 P1：证据跨片情况（分段运行才有；单段为 null）
        evidence_segments: row.cross_segment ? row.cross_segment.evidence_segments : null,
        untouched_segments: row.cross_segment ? row.cross_segment.untouched_segments : null,
      })),
      author_commit: extra.authorCommit === true ? 'COMMITTED' : 'NOT_RUN',
      persisted_hash: extra.persistedHash || null,
      verified_candidate_hash: null,
      last_update: extra.lastUpdate || '',
    };
  }

  return {
    VERSION,
    CANDIDATE_SCHEMA,
    RUN_SCHEMA,
    STAGE,
    FINAL,
    CONCLUSIVE,
    BLOCK_REASON,
    contentHash,
    semanticCoverageComplete,
    normalizeFindings,
    mergeCoverageRows,
    coverageVerdictOf,
    normalizeCandidate,
    finalizeRevisionCandidate,
    runRecordOf,
  };
});
