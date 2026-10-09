/*
 * 局部编辑计划（EditPlan / E05）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要它（《叙事性专项修复》§6.3 + §7 E05）：
 *   选中问题之后、发给模型之前，Host 必须先把"**允许改哪里**"编译出来：
 *   热点（hotspot）、每一处的**确切目标原文**、只读上下文、必须保留的信息、禁止新增的信息、
 *   操作类型（replace / delete / condense）与依赖组。否则模型只能拿整章正文自由发挥，
 *   "少量定位文字授权替换整段"与"顺手通读全部再优化"都会从这里漏出去。
 *
 * 三条纪律（写在实现里，可离线复核）：
 *   ① **不扩大授权**：热点跨度只等于"能逐字指出的那段原文"。定位不到就如实标 `needs_scope`，
 *      由作者补引用或由 Host **显式**扩大授权 —— 本模块**从不自动放宽**（§6.3/§6.5）。
 *   ② **不写任何东西**：计划是候选的输入，不是候选；`dry_run` 恒为 true，模块不触碰文件/数据库。
 *   ③ **上下文预算不够就举手**：超出预算时返回 `needs_explicit_widening`（含候选范围与所需体量），
 *      而不是截断正文或悄悄扩大跨度。
 *
 * 与 public/revision-patch.js 的分工：那边是**协议与执行**（跨度偏移、写回、组合核验）；
 * 这边是**计划**（把问题变成受约束的跨度与不变量）。跨度口径复用那边的 `buildSpans`，
 * 不另写一份偏移逻辑（两处各写一份必然漂移）。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const VERSION = '1.0.0';
  /** 只支持这三种操作：不做"全章移动段落"这类结构调整（§7 E05 明写）。 */
  const PLAN_OPS = ['replace', 'delete', 'condense'];
  /** 引用里可能夹带的成对引号（模型给的问题描述里常带原文片段）。 */
  const QUOTE_PAIRS = [['「', '」'], ['“', '”'], ['‘', '’'], ['"', '"'], ['《', '》']];

  const sha16 = (s) => {
    // 与仓库其它 hash 同口径的轻量指纹（FNV-1a 32 位 + 长度）；只用于版本同一性，不做安全用途。
    let h = 0x811c9dc5;
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${h.toString(16).padStart(8, '0')}${str.length.toString(16)}`.slice(0, 16);
  };

  function engineOf(engine) {
    if (engine) return engine;
    return (root && root.NovelRevisionPatch) || null;
  }

  /** 从一段自由文本里抽出被引号包住的片段（取最长的一个）：模型描述问题时常把原文抄进引号。 */
  function extractQuotedFragments(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    for (const [open, close] of QUOTE_PAIRS) {
      let i = s.indexOf(open);
      while (i >= 0) {
        const j = s.indexOf(close, i + open.length);
        if (j < 0) break;
        const frag = s.slice(i + open.length, j).trim();
        if (frag.length >= 4) out.push(frag);
        i = s.indexOf(open, j + close.length);
      }
    }
    return out.sort((a, b) => b.length - a.length);
  }

  /** 在正文学里找片段：优先"整句恰好等于"，其次"句子包含"，最后"段落包含"；**再把范围收紧到片段本身**。 */
  function locateFragment(text, fragment, spans) {
    const body = String(text == null ? '' : text);
    const frag = String(fragment == null ? '' : fragment).trim();
    if (!frag) return null;
    const sentence = spans.find((sp) => sp.kind === 'sentence' && sp.text === frag);
    if (sentence) return { start: sentence.start, end: sentence.end, span_id: sentence.span_id, paragraph_index: sentence.paragraph_index, exact: true };
    const containing = spans
      .filter((sp) => (sp.kind === 'sentence' || sp.kind === 'paragraph') && sp.text.includes(frag))
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (!containing) return null;
    // 收紧：只授权片段本身，而不是它所在的那一句/那一段。
    const rel = containing.text.indexOf(frag);
    if (rel < 0) return null;
    return {
      start: containing.start + rel,
      end: containing.start + rel + frag.length,
      span_id: `${containing.span_id}~${rel}`,
      paragraph_index: containing.paragraph_index,
      exact: containing.text === frag,
    };
  }

  const clip = (s, n) => {
    const t = String(s == null ? '' : s);
    return t.length <= n ? t : `${t.slice(0, n)}…`;
  };

  /**
   * 把已选问题编译成受约束的局部编辑计划。
   *
   * @param {object} input
   *   · snapshot：{ body_text, body_hash, snapshot_id, chapter_id }
   *   · findings：已选问题 `[{ id, text, quote?, evidence?:[{quote}], suggested_action?, kind? }]`
   *   · invariants：`{ must_keep?: string[], do_not_add?: string[] }`（作者/契约给的硬约束）
   *   · protectedSpans：不得作为改动对象的跨度 id 或原文片段
   *   · contextChars：本次请求可用的上下文预算（字符）。超出**不截断**，而是举手。
   *   · engine：注入 public/revision-patch.js（默认取 globalThis）
   * @returns {object} plan（含 hotspots / groups / coverage / needs_explicit_widening / 指纹）
   */
  function buildRevisionPlan(input = {}) {
    const snapshot = input.snapshot || {};
    const text = String(snapshot.body_text == null ? '' : snapshot.body_text);
    const engine = engineOf(input.engine);
    const findings = Array.isArray(input.findings) ? input.findings.filter(Boolean) : [];
    // 「允许对已选问题局部压缩」开关：默认关闭时不放行 condense（见下面对 op 的处理）。
    const allowCondense = input.allowCondense === true;
    const invariants = {
      must_keep: Array.isArray(input.invariants && input.invariants.must_keep) ? input.invariants.must_keep.map(String).filter(Boolean) : [],
      do_not_add: Array.isArray(input.invariants && input.invariants.do_not_add) ? input.invariants.do_not_add.map(String).filter(Boolean) : [],
    };
    const protectedList = Array.isArray(input.protectedSpans) ? input.protectedSpans.map(String).filter(Boolean) : [];
    const contextChars = Number(input.contextChars) > 0 ? Number(input.contextChars) : 0;

    const spans = engine && typeof engine.buildSpans === 'function'
      ? engine.buildSpans(text, { sentences: true, chapter_id: snapshot.chapter_id })
      : [];
    const hotspots = [];
    const coverage = [];
    const unlocated = [];

    for (const f of findings) {
      const id = String(f.id == null ? '' : f.id) || `#${coverage.length + 1}`;
      const wanted = String(f.suggested_action || '').trim();
      const op = PLAN_OPS.includes(wanted) ? wanted : 'replace';
      // 目标原文优先级：结构化引用 > 显式 quote > 问题描述里的引号片段。
      const candidates = [
        ...(Array.isArray(f.evidence) ? f.evidence.map((e) => String((e && e.quote) || '')).filter(Boolean) : []),
        String(f.quote || ''),
        ...extractQuotedFragments(f.text),
      ].filter(Boolean);
      let hit = null;
      let usedFragment = '';
      for (const frag of candidates) {
        const found = locateFragment(text, frag, spans);
        if (found) { hit = found; usedFragment = frag; break; }
      }
      if (!hit) {
        coverage.push({ issue_id: id, status: 'needs_scope', reason: '问题里没有可逐字定位的原文引用：要么请作者指出原句，要么由 Host 显式扩大授权范围（本模块不自动放宽）' });
        unlocated.push({ issue_id: id, text: clip(f.text, 80) });
        continue;
      }
      const original = text.slice(hit.start, hit.end);
      if (protectedList.some((p) => (p.length >= 4 ? original.includes(p) || p.includes(original) : p === hit.span_id))) {
        coverage.push({ issue_id: id, status: 'refused', reason: `目标落在受保护范围内（${clip(original, 20)}）：不得作为改动对象` });
        continue;
      }
      if (wanted === 'condense' && !allowCondense) {
        // §7 E06：「允许对已选问题局部压缩」默认**关闭** —— 关闭时 condense 一律拒绝（而不是静默降级）。
        coverage.push({ issue_id: id, status: 'refused', reason: '「允许对已选问题局部压缩」开关未打开：condense 不参与本次计划（可在审稿清单弹窗里勾选后重来）' });
        continue;
      }
      if (wanted === 'condense' && !hit.exact && !f.merged_span_approved) {
        // condense 只允许作用在**已批准**的连续跨度上（§7 E05）：句内压缩用 replace 表达。
        coverage.push({ issue_id: id, status: 'refused', reason: 'condense 需要 Host 显式批准的连续跨度（merged_span_approved）；句内压缩请用 replace' });
        continue;
      }
      // 只读上下文：同一段里除目标以外的文字（截断到预算的一半），供模型判断前后关系。
      const para = spans.find((sp) => sp.kind === 'paragraph' && sp.paragraph_index === hit.paragraph_index) || null;
      const readOnlyBefore = para ? clip(text.slice(para.start, hit.start), contextChars ? Math.ceil(contextChars / 2) : 120) : '';
      const readOnlyAfter = para ? clip(text.slice(hit.end, para.end), contextChars ? Math.ceil(contextChars / 2) : 120) : '';
      hotspots.push({
        issue_id: id,
        op,
        span: { start: hit.start, end: hit.end, span_id: hit.span_id, exact: hit.exact },
        original,
        paragraph_index: hit.paragraph_index,
        read_only: { before: readOnlyBefore, after: readOnlyAfter },
        must_keep: invariants.must_keep.slice(),
        do_not_add: invariants.do_not_add.slice(),
        group_id: `hotspot-${hotspots.length + 1}`,
        source_fragment: clip(usedFragment, 60),
      });
      coverage.push({ issue_id: id, status: 'planned', span_id: hit.span_id, op });
    }

    // 依赖组 / 共享上下文（§7 E05）：同一段内的热点、或只读上下文窗口互相重叠的热点，合成一组
    // ——它们必须**一起**验证（组合门禁），也共享同一份上下文；但每一处的**授权跨度不变**。
    let groups = hotspots.map((h) => ({ group_id: h.group_id, issue_ids: [h.issue_id], shared_context: false, context_span: { start: h.span.start, end: h.span.end } }));
    for (let i = 0; i < hotspots.length; i += 1) {
      for (let j = i + 1; j < hotspots.length; j += 1) {
        const a = hotspots[i];
        const b = hotspots[j];
        const samePara = a.paragraph_index === b.paragraph_index;
        const overlapContext = a.read_only.before.length + a.read_only.after.length > 0
          && b.span.start <= a.span.end + 200 && a.span.start <= b.span.end + 200;
        if (!samePara && !overlapContext) continue;
        const ga = groups.find((g) => g.group_id === a.group_id);
        const gb = groups.find((g) => g.group_id === b.group_id);
        if (!ga || !gb || ga === gb) continue;
        ga.issue_ids = [...new Set([...ga.issue_ids, ...gb.issue_ids])];
        ga.shared_context = true;
        ga.context_span = { start: Math.min(ga.context_span.start, gb.context_span.start), end: Math.max(ga.context_span.end, gb.context_span.end) };
        // 组成员统一 group_id（原子应用：同组一条失败则整组不进候选）。
        hotspots.forEach((h) => { if (h.group_id === gb.group_id) h.group_id = ga.group_id; });
        groups = groups.filter((g) => g !== gb);
      }
    }
    for (const g of groups) {
      g.issue_ids = [...new Set(g.issue_ids)].sort();
      // 组的原子性说明写进计划本身：修稿器与门禁都按它执行。
      g.atomic = true;
      g.note = '同组补丁原子应用：其中一条失败则该组不进入本次候选';
    }

    // 上下文预算：算的是**这一轮请求里要带的计划文本量**（热点原文 + 只读上下文 + 不变量）。
    const planChars = hotspots.reduce((n, h) => n + h.original.length + h.read_only.before.length + h.read_only.after.length + 80, 0)
      + (invariants.must_keep.join('').length + invariants.do_not_add.join('').length);
    const overBudget = contextChars > 0 && planChars > contextChars;
    const needsWidening = overBudget
      ? {
        reason: `计划所需的上下文 ${planChars} 字 > 本次预算 ${contextChars} 字：需要**显式扩大授权**或分片，不能自动扩大跨度、也不能截断正文`,
        needed_chars: planChars,
        budget_chars: contextChars,
        candidate_ranges: groups.map((g) => ({
          group_id: g.group_id,
          issue_ids: g.issue_ids,
          span: g.context_span,
          chars: g.context_span.end - g.context_span.start,
        })),
      }
      : null;

    const selectionHash = sha16(findings.map((f) => String(f.id == null ? '' : f.id)).sort().join('|'));
    const plan = {
      schema_version: 1,
      plan_version: VERSION,
      snapshot_id: String(snapshot.snapshot_id || ''),
      base_hash: String(snapshot.body_hash || ''),
      chapter_id: snapshot.chapter_id == null ? '' : String(snapshot.chapter_id),
      hotspots,
      groups,
      invariants,
      protected_spans: protectedList,
      coverage,
      unlocated_hotspots: unlocated,
      needs_explicit_widening: needsWidening,
      // 计划只描述"允许改哪里"：它不含候选正文，也从不写任何东西。
      dry_run: true,
      writes_to_disk: false,
      selection_hash: selectionHash,
      coverage_complete: coverage.every((c) => c.status !== 'dropped'),
    };
    plan.plan_hash = sha16(JSON.stringify({
      snapshot: plan.snapshot_id, base: plan.base_hash, sel: selectionHash,
      hotspots: hotspots.map((h) => `${h.issue_id}:${h.span.start}-${h.span.end}:${h.op}:${h.group_id}`),
      invariants,
    }));
    return plan;
  }

  /** 作者改了勾选 → 旧计划（以及由它产出的候选）一律作废（§7 E05 通过条件）。 */
  function isPlanStale(plan, { selectionHash, snapshotId } = {}) {
    if (!plan) return { stale: true, reason: '没有计划' };
    if (selectionHash && String(selectionHash) !== String(plan.selection_hash)) {
      return { stale: true, reason: '勾选集合变化：旧计划与旧候选都不得复用' };
    }
    if (snapshotId && String(snapshotId) !== String(plan.snapshot_id)) {
      return { stale: true, reason: '源稿快照变化：旧计划不得套用到新稿' };
    }
    return { stale: false };
  }

  /** 把计划渲染成提示词片段：只列**授权跨度**与不变量，不含"通读全部"的暗示。 */
  function buildRevisionPatchPromptFromPlan(plan, opts = {}) {
    const p = plan || {};
    const hotspots = Array.isArray(p.hotspots) ? p.hotspots : [];
    const lines = [];
    lines.push('【本次授权范围（只有下面这些跨度允许改，其余一个字都不许动）】');
    if (!hotspots.length) {
      lines.push('（没有可定位的热点：请在 dispositions 里逐条说明为什么无法定位，不要改动任何文字）');
    } else {
      for (const h of hotspots) {
        lines.push(`- issue ${h.issue_id}｜span_id ${h.span.span_id}｜操作 ${h.op}`);
        lines.push(`  原文：${h.original}`);
        if (h.read_only.before) lines.push(`  只读上文（不要改、不要出现在输出里）：…${h.read_only.before}`);
        if (h.read_only.after) lines.push(`  只读下文（不要改、不要出现在输出里）：${h.read_only.after}…`);
        if (h.must_keep.length) lines.push(`  必须保留：${h.must_keep.join('；')}`);
        if (h.do_not_add.length) lines.push(`  禁止新增：${h.do_not_add.join('；')}`);
        lines.push(`  依赖组：${h.group_id}（同组原子应用）`);
      }
    }
    const inv = p.invariants || {};
    if ((inv.must_keep || []).length || (inv.do_not_add || []).length) {
      lines.push('', '【本轮不变量（硬约束）】');
      for (const x of inv.must_keep || []) lines.push(`- 必须保留：${x}`);
      for (const x of inv.do_not_add || []) lines.push(`- 禁止新增：${x}`);
    }
    if (p.needs_explicit_widening) {
      lines.push('', '⚠️ 本次计划超出上下文预算：**只处理上面列出的热点**，不要自行扩大范围；'
        + `如需更大范围，请回报 blocked（原因：${p.needs_explicit_widening.reason}）`);
    }
    if (opts.contextOnlyBlock) lines.push('', String(opts.contextOnlyBlock));
    return lines.join('\n');
  }

  /** 问题覆盖表（§6.7）：与界面/报告共用同一份结构，避免两处各写一份。 */
  function planCoverageTable(plan) {
    const rows = Array.isArray(plan && plan.coverage) ? plan.coverage : [];
    return rows.map((c) => ({
      issue_id: c.issue_id,
      selected: true,
      patch_planned: c.status === 'planned',
      status: c.status,
      reason: c.reason || '',
      span_id: c.span_id || '',
    }));
  }

  /**
   * 单独撤销一处（§7 E06 通过条件：每个补丁带问题 ID 且能单独撤销）。
   * 纯函数：从"原稿 + 已应用的补丁"里去掉某个问题的补丁，按位置从后往前写回。
   *
   * 为什么不用 JSON patch / 中间态：补丁的位置是相对**原稿**的（协议要求），
   * 所以只要按 start 倒序重建，就不会互相影响；任何一条缺位置信息时**如实失败**，
   * 不猜、不部分应用（否则"撤销一处"会变成"改坏另一处"）。
   */
  function candidateWithoutIssue(baseText, applied, issueId) {
    const base = String(baseText == null ? '' : baseText);
    const list = Array.isArray(applied) ? applied : [];
    const drop = String(issueId);
    const keep = list.filter((a) => String(a && a.issue) !== drop);
    const dropped = list.length - keep.length;
    if (!dropped) return { ok: false, reason: `没有找到该问题的补丁（issue ${drop}）`, dropped: 0 };
    const sorted = keep.slice().sort((a, b) => Number(b.start) - Number(a.start));
    for (const p of sorted) {
      if (!Number.isFinite(Number(p.start)) || !Number.isFinite(Number(p.end))) {
        return { ok: false, reason: '有补丁缺少位置信息（start/end）：拒绝部分重建，避免改坏别处', dropped: 0 };
      }
    }
    let out = base;
    for (const p of sorted) {
      const start = Number(p.start);
      const end = Number(p.end);
      // 兼容两种键名：协议层给的是 original/replacement，前端补丁对象给的是 anchor/revised。
      const orig = String(p.original != null ? p.original : (p.anchor != null ? p.anchor : ''));
      const repl = String(p.replacement != null ? p.replacement : (p.revised != null ? p.revised : ''));
      if (base.slice(start, end) !== orig) {
        return { ok: false, reason: '补丁位置与原稿不一致（源稿已变化）：拒绝重建', dropped: 0 };
      }
      out = out.slice(0, start) + (p.op === 'delete' ? '' : repl) + out.slice(end);
    }
    return { ok: true, text: out, dropped, remaining: keep.length };
  }

  /**
   * 相对改善结论的守卫（§7 E06："相对改善结论必须先读实际 diff，不能只比指标"）。
   * 没有读过 diff 时**不允许**给出"改善/变差"的结论，只返回"需要先看 diff"。
   */
  function comparisonVerdict({ metricDelta = null, diffRead = false, diffEmpty = false } = {}) {
    const delta = Number(metricDelta);
    if (diffEmpty) return { verdict: 'no_change', reason: '本次没有任何文本差异：不构成"改善"也不构成"变差"' , metric_delta: Number.isFinite(delta) ? delta : null };
    if (!diffRead) {
      return {
        verdict: 'needs_diff_review',
        reason: '指标变化必须先与实际 diff 对照才能下结论：未读 diff 时不得写"改善"',
        metric_delta: Number.isFinite(delta) ? delta : null,
      };
    }
    if (!Number.isFinite(delta) || delta === 0) return { verdict: 'consistent_no_metric_change', reason: '已读 diff，但指标没有变化：不要用指标缺席充当"改善"', metric_delta: Number.isFinite(delta) ? delta : null };
    return {
      verdict: delta < 0 ? 'metric_improved_needs_author_confirmation' : 'metric_worsened_needs_author_confirmation',
      reason: '指标与 diff 都读了：这仍只是**相对**观察，需要作者确认是否真的更好；不得写成"质量已提升"',
      metric_delta: delta,
    };
  }

  /**
   * 样本量守卫（§7 E06："对比三类证据，避免小样本过拟合"）。
   * 只有"份数/次数"够时才允许看比例与趋势；否则只允许看单次明细。
   */
  function revisionSampleGuard({ runs = 0, reviews = 0 } = {}) {
    const r = Math.max(0, Number(runs) || 0);
    const v = Math.max(0, Number(reviews) || 0);
    const enough = r >= 3 && v >= 2;
    return {
      enough, runs: r, reviews: v,
      note: enough
        ? `样本量：${v} 份审稿 / ${r} 次修稿选择（可以看比例，但样本仍小、只是相对观察，不能据此宣告质量结论）`
        : `样本不足（${v} 份审稿 / ${r} 次修稿选择）：只能看单次明细，不得据此判断趋势、也不得宣告改善`,
    };
  }

  return {
    VERSION,
    PLAN_OPS,
    buildRevisionPlan,
    buildRevisionPatchPromptFromPlan,
    isPlanStale,
    planCoverageTable,
    candidateWithoutIssue,
    comparisonVerdict,
    revisionSampleGuard,
    // 导出给离线测试单独验（"引号抽取对不对"这类缺陷只走整条链路会被掩盖）。
    extractQuotedFragments,
    locateFragment,
    sha16,
  };
});
