/* 长正文分段处理（R08）——纯函数模块，浏览器与 Node 测试共用。
 *
 * 为什么需要它：润色/扩写/审稿/整章修稿/补丁修稿此前都把**目标正文**直接
 * `slice(0, 6000)` / `slice(0, 12000)`，于是"处理整章"实际只处理了前半章，
 * 而且没有任何地方能发现这件事（没有覆盖清单、没有片号、没有版本）。
 *
 * 这里只做三件事，全部可离线复验：
 *   1. 计划：按**最终序列化请求**的量决定"单请求"还是"分段"，并切出稳定片号；
 *   2. 执行：逐片跑（runner 由调用方注入），片结果先落候选，不碰正式正文；
 *   3. 证明：覆盖清单（首/尾/章尾哨兵/唯一/顺序/缺片/重复/context-only 未被改）
 *      通过、且源版本仍匹配，才允许合并给作者做差异预览。
 *
 * 量纲说明：这里用的是"最终序列化请求的字符数"（`JSON.stringify(messages).length`），
 * 不是正文字符数——JSON 转义、角色包装、工具 schema 都会进最终请求。它是**分段阈值**，
 * 不是模型上下文预算；预算常量（TOTAL_BUDGET 等）不因本模块改变。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelLongText = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const DEFAULTS = Object.freeze({
    request_chars: 48000,
    output_reserve_chars: 12000,
    protocol_chars: 1500,
    max_segment_chars: 8000,
    min_segment_chars: 400,
    neighbor_chars: 800,
    sentinel_chars: 60,
  });
  const REASON_TEXT = {
    'empty-output': '模型返回空内容',
    'echoed-context': '把 context-only 邻接段原样吐回（越界编辑）',
    'replaced-by-context': '输出等于邻接段而不是 target（越界编辑）',
    'echoed-context-marker': '输出里出现 context-only 标记',
    'no-segment': '片不存在',
  };

  function limits(overrides) { return Object.assign({}, DEFAULTS, overrides || {}); }
  function normalizeText(text) { return String(text == null ? '' : text).replace(/\r\n?/g, '\n'); }
  function reasonText(reason) { return REASON_TEXT[reason] || String(reason || '未知原因'); }

  /** 稳定内容 hash：同输入同输出，跨进程一致（不依赖 crypto/随机数）。 */
  function hashText(text, hexLen) {
    const s = normalizeText(text);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2 + c + 1, 2246822519) ^ (h2 >>> 13)) >>> 0;
    }
    const full = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    const want = Math.max(4, Math.min(Number(hexLen) || 16, full.length));
    return full.slice(0, want);
  }

  /** 段落切分：只在空行处切，保留字符偏移（偏移只用于本次运行内定位，片号不依赖它）。 */
  function paragraphSpans(text) {
    const s = normalizeText(text);
    const spans = [];
    const push = (from, to) => {
      const raw = s.slice(from, to);
      const trimmed = raw.replace(/^\s+|\s+$/g, '');
      if (!trimmed) return;
      const lead = raw.length - raw.replace(/^\s+/, '').length;
      spans.push({ text: trimmed, start: from + lead, end: from + lead + trimmed.length });
    };
    const re = /\n[ \t]*\n/g;
    let index = 0;
    let m;
    while ((m = re.exec(s))) { push(index, m.index); index = m.index + m[0].length; }
    push(index, s.length);
    if (!spans.length && s.trim()) spans.push({ text: s.trim(), start: s.indexOf(s.trim()), end: s.indexOf(s.trim()) + s.trim().length });
    return spans;
  }

  /** 超长单段：先按句末标点切（零宽切分，拼回等于原文），再退化为硬切。 */
  function splitOversize(span, maxChars) {
    const pieces = span.text.split(/(?<=[。！？!?…])/);
    const parts = [];
    if (pieces.length > 1) {
      let buf = '';
      for (const p of pieces) {
        if (buf && buf.length + p.length > maxChars) { parts.push(buf); buf = ''; }
        buf += p;
        while (buf.length >= maxChars) { parts.push(buf.slice(0, maxChars)); buf = buf.slice(maxChars); }
      }
      if (buf) parts.push(buf);
    } else {
      for (let i = 0; i < span.text.length; i += maxChars) parts.push(span.text.slice(i, i + maxChars));
    }
    const out = [];
    let off = span.start;
    for (const t of parts) { out.push({ text: t, start: off, end: off + t.length }); off += t.length; }
    return out;
  }

  function tailOf(text, n) { const s = normalizeText(text); return s.length <= n ? s : s.slice(s.length - n); }
  function headOf(text, n) { const s = normalizeText(text); return s.length <= n ? s : s.slice(0, n); }

  /** 切片：片号 = 内容 hash（重复内容加序号），前文编辑不会让片号漂移。 */
  function buildSegments(text, options) {
    const opt = limits(options);
    const s = normalizeText(text);
    const units = [];
    for (const p of paragraphSpans(s)) {
      if (p.text.length > opt.max_segment_chars) units.push(...splitOversize(p, opt.max_segment_chars));
      else units.push(p);
    }
    const groups = [];
    let cur = null;
    for (const u of units) {
      if (cur && cur.text.length + u.text.length + 2 <= opt.max_segment_chars) {
        cur = { text: cur.text + '\n\n' + u.text, start: cur.start, end: u.end };
      } else {
        if (cur) groups.push(cur);
        cur = { text: u.text, start: u.start, end: u.end };
      }
    }
    if (cur) groups.push(cur);
    if (groups.length > 1 && groups[groups.length - 1].text.length < opt.min_segment_chars) {
      const last = groups.pop();
      const prev = groups[groups.length - 1];
      prev.text = prev.text + '\n\n' + last.text;
      prev.end = last.end;
    }
    const seen = new Map();
    const segments = groups.map((g, i) => {
      const h = hashText(g.text, 10);
      const n = (seen.get(h) || 0) + 1;
      seen.set(h, n);
      return {
        segment_id: n === 1 ? 'seg-' + h : 'seg-' + h + '-' + n,
        ordinal: i + 1,
        is_first: i === 0,
        is_last: i === groups.length - 1,
        target: { start: g.start, end: g.end, chars: g.text.length, hash: hashText(g.text, 16), text: g.text },
        context_before: i > 0 ? tailOf(groups[i - 1].text, opt.neighbor_chars) : null,
        context_after: i + 1 < groups.length ? headOf(groups[i + 1].text, opt.neighbor_chars) : null,
      };
    });
    return {
      source_version: hashText(s, 16),
      source_chars: s.length,
      sentinel: tailOf(s, opt.sentinel_chars),
      segments,
      segmented: segments.length > 1,
    };
  }

  /** 最终序列化请求的字符数（量的口径：真正发出去的那串）。 */
  function serializedChars(messages) {
    try { return JSON.stringify(messages).length; } catch (e) { return Infinity; }
  }

  /**
   * 任务计划：先按"整篇放进最终请求"估算，超出可用预算才分段。
   * probeMessages 必须是**与真实请求同形**的消息（由调用方用同一 builder 生成）。
   */
  function planTask(input) {
    const opt = limits(input && input.limits);
    const s = normalizeText(input && input.text);
    const built = buildSegments(s, opt);
    const usable = Math.max(1000, opt.request_chars - opt.output_reserve_chars - opt.protocol_chars);
    const singleChars = input && input.probeMessages ? serializedChars(input.probeMessages) : s.length;
    const fits = singleChars <= usable;
    return {
      mode: fits ? 'single' : 'segmented',
      kind: (input && input.kind) || 'task',
      source_version: built.source_version,
      source_chars: built.source_chars,
      sentinel: built.sentinel,
      segments: fits ? [] : built.segments,
      budget: {
        request_chars: opt.request_chars,
        reserve: opt.output_reserve_chars + opt.protocol_chars,
        usable,
        single_request_chars: singleChars,
        fits,
      },
      limits: opt,
    };
  }

  /**
   * 单片消息：target 与 context-only 显式分离并命名——模型能读懂"邻接段不许改"，
   * 覆盖阶段也能机械验证"邻接段确实没被改"。
   */
  function segmentMessages(spec) {
    const { system, context, instruction, segment, kind, taskPrompt } = spec || {};
    const parts = ['任务类型：' + (kind || 'text')];
    if (instruction) parts.push('作者要求：' + instruction);
    const ctx = [];
    if (segment && segment.context_before) ctx.push('上文结尾（context-only，禁止修改）：\n' + segment.context_before);
    if (segment && segment.context_after) ctx.push('下文开头（context-only，禁止修改）：\n' + segment.context_after);
    if (context) ctx.push('作品背景（context-only）：\n' + context);
    if (ctx.length) parts.push('', '【上下文（仅供衔接参考，禁止修改、禁止出现在输出里）】', ctx.join('\n\n'));
    parts.push('', '【本片目标（target ' + segment.segment_id + '，第 ' + segment.ordinal + ' 片）】只处理这一段：', segment.target.text, '');
    parts.push(taskPrompt || '输出规则：只输出 target 文本的处理结果；不要输出 context-only 内容，不要输出解释、编号或小标题。');
    return [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: parts.join('\n') },
    ];
  }

  function normalizeForCompare(t) { return normalizeText(t).replace(/\s+/g, ''); }

  function stripFences(text) {
    let t = String(text == null ? '' : text).trim();
    const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (m) t = m[1].trim();
    return t;
  }

  /** 单片输出验证：只允许改 target，邻接段原样出现即判越界。 */
  function verifySegmentOutput(spec) {
    const { segment, output } = spec || {};
    if (!segment) return { ok: false, cleaned: '', reasons: ['no-segment'] };
    const cleaned = stripFences(output);
    if (!cleaned) return { ok: false, cleaned: '', reasons: ['empty-output'] };
    const reasons = [];
    const cleanedN = normalizeForCompare(cleaned);
    for (const c of [segment.context_before, segment.context_after]) {
      if (!c) continue;
      const cN = normalizeForCompare(c);
      if (cN.length < 24) continue;
      if (cleanedN.includes(cN)) { reasons.push('echoed-context'); continue; }
      if (cleanedN.length >= Math.max(24, Math.floor(cN.length * 0.6)) && cN.includes(cleanedN)) reasons.push('replaced-by-context');
    }
    if (/context-only/i.test(cleaned) || cleaned.includes('【上下文')) reasons.push('echoed-context-marker');
    return { ok: reasons.length === 0, cleaned, reasons, target_unchanged: cleanedN === normalizeForCompare(segment.target.text) };
  }

  /** 覆盖清单：这是"整章真的处理完了"的唯一证明，不是装饰。 */
  function buildCoverageManifest(input) {
    const { source, plan, results, current_version: currentVersion } = input || {};
    const s = normalizeText(source);
    const list = Array.isArray(results) ? results : [];
    const byId = new Map();
    const duplicates = [];
    const versionMismatch = [];
    for (const r of list) {
      if (!r || !r.segment_id) continue;
      if (byId.has(r.segment_id)) duplicates.push(r.segment_id);
      else byId.set(r.segment_id, r);
      if (r.source_version && plan && r.source_version !== plan.source_version) versionMismatch.push(r.segment_id);
    }
    const missing = [];
    const violations = [];
    const orderMismatch = [];
    const rows = [];
    const segs = (plan && plan.segments) || [];
    segs.forEach((seg, i) => {
      const r = byId.get(seg.segment_id);
      const recStatus = (r && r.status) || 'pending';
      if (!r || !r.output) {
        if (recStatus === 'violation') violations.push({ segment_id: seg.segment_id, reasons: (r && r.verification && r.verification.reasons) || [] });
        else missing.push(seg.segment_id);
        rows.push({ segment_id: seg.segment_id, ordinal: seg.ordinal, chars: seg.target.chars, status: recStatus });
        return;
      }
      if (recStatus !== 'done') {
        // 越界（violation）与失败（failed）必须分开记账：前者是"改错了地方"，后者是"没跑成"。
        if (recStatus === 'violation') violations.push({ segment_id: seg.segment_id, reasons: (r.verification && r.verification.reasons) || [] });
        else missing.push(seg.segment_id);
        rows.push({ segment_id: seg.segment_id, ordinal: seg.ordinal, chars: seg.target.chars, status: recStatus });
        return;
      }
      const v = r.verification && typeof r.verification.ok === 'boolean'
        ? r.verification
        : verifySegmentOutput({ segment: seg, output: r.output });
      if (!v.ok) violations.push({ segment_id: seg.segment_id, reasons: v.reasons || [] });
      if (Number(r.ordinal) && Number(r.ordinal) !== seg.ordinal) orderMismatch.push(seg.segment_id);
      rows.push({ segment_id: seg.segment_id, ordinal: seg.ordinal, chars: seg.target.chars, status: v.ok ? 'done' : 'violation', output_hash: r.output_hash || null });
    });
    const first = segs[0] || null;
    const last = segs[segs.length - 1] || null;
    const first_ok = !!first && first.target.start === 0;
    const tail_ok = !!last && last.target.end === s.length;
    const sentinel_ok = !plan || !plan.sentinel || (!!last && last.target.text.includes(plan.sentinel));
    const order_ok = orderMismatch.length === 0;
    const stale = !!(currentVersion && plan && currentVersion !== plan.source_version);
    const unresolved = [];
    for (const id of missing) unresolved.push(id + '（缺片或未成功）');
    for (const id of duplicates) unresolved.push(id + '（重复片）');
    for (const v of violations) unresolved.push(v.segment_id + '（' + v.reasons.map(reasonText).join('、') + '）');
    for (const id of versionMismatch) unresolved.push(id + '（源版本不匹配）');
    for (const id of orderMismatch) unresolved.push(id + '（顺序与计划不符）');
    if (!first_ok) unresolved.push('首段未覆盖正文开头');
    if (!tail_ok) unresolved.push('尾段未覆盖正文结尾');
    if (!sentinel_ok) unresolved.push('章尾哨兵不在最后一片里');
    if (stale) unresolved.push('源正文已变化（候选过期，必须对当前版本重跑）');
    return {
      ok: unresolved.length === 0,
      source_version: plan && plan.source_version,
      source_chars: s.length,
      segments: rows,
      missing, duplicates, violations, version_mismatch: versionMismatch, order_mismatch: orderMismatch,
      order_ok, first_ok, tail_ok, sentinel_ok, stale, unresolved,
    };
  }

  /** 合并：只有覆盖清单通过才输出合并正文；否则原样不动。 */
  function mergeResults(input) {
    const { source, plan, results, current_version: currentVersion } = input || {};
    const manifest = buildCoverageManifest({ source, plan, results, current_version: currentVersion });
    if (!manifest.ok) return { ok: false, manifest, merged: null, reasons: manifest.unresolved };
    const ordered = plan.segments.map((seg) => (results || []).find((r) => r.segment_id === seg.segment_id));
    return { ok: true, manifest, merged: ordered.map((r) => stripFences(r.output).trim()).join('\n\n') };
  }

  function segmentStatuses(plan, results, currentVersion) {
    const list = Array.isArray(results) ? results : [];
    return ((plan && plan.segments) || []).map((seg) => {
      const r = list.find((x) => x && x.segment_id === seg.segment_id);
      let status = 'pending';
      if (r && r.status === 'done') status = 'done';
      else if (r && r.status) status = r.status;
      if (status === 'done' && currentVersion && r.source_version && r.source_version !== currentVersion) status = 'stale';
      return { segment_id: seg.segment_id, ordinal: seg.ordinal, chars: seg.target.chars, status, output_hash: (r && r.output_hash) || null, error: (r && r.error) || null };
    });
  }

  /** 断点续跑：只重跑"缺片 / 失败片 / 越界片 / 版本不匹配片"，成功且仍匹配的片不重跑（不重复计费）。 */
  function resumeSegments(plan, results, currentVersion) {
    const rows = segmentStatuses(plan, results, currentVersion);
    const reuse = rows.filter((r) => r.status === 'done').map((r) => r.segment_id);
    const rerun = rows.filter((r) => r.status !== 'done').map((r) => r.segment_id);
    return { reuse, rerun, rows };
  }

  /**
   * 执行循环：runner 注入（生产=runHarnessFromMessages，测试=确定性假 runner）。
   * 逐片落候选；失败只标记该片，已成功的片保持原样；取消在片间生效。
   */
  async function runSegmentedTask(spec) {
    const { plan, messagesFor, runner, signal, onProgress } = spec || {};
    const out = Array.isArray(spec && spec.results) ? spec.results.slice() : [];
    const usable = new Set(resumeSegments(plan, out, plan.source_version).reuse);
    const pending = (plan.segments || []).filter((seg) => !usable.has(seg.segment_id));
    const cancelled = () => !!(signal && signal.cancelled);
    const verifyFn = spec && typeof spec.verify === 'function' ? spec.verify : ((seg, rawOut) => verifySegmentOutput({ segment: seg, output: rawOut }));
    for (const seg of pending) {
      if (cancelled()) return { results: out, cancelled: true };
      const idx = out.findIndex((r) => r && r.segment_id === seg.segment_id);
      let rec;
      try {
        const messages = messagesFor(seg);
        const raw = await runner(seg, messages);
        const v = verifyFn(seg, raw) || { ok: false, reasons: ['no-verifier-result'] };
        const cleaned = typeof v.cleaned === 'string' ? v.cleaned : stripFences(raw);
        rec = {
          segment_id: seg.segment_id, ordinal: seg.ordinal, source_version: plan.source_version,
          status: v.ok ? 'done' : 'violation', output: cleaned, output_hash: hashText(cleaned, 16),
          error: v.ok ? null : v.reasons.map(reasonText).join('、'),
          verification: { ok: !!v.ok, reasons: v.reasons || [] }, at: Date.now(),
        };
      } catch (e) {
        // ⚠️ P1-08：取消必须**中断整次任务**，不能被吞成"本片失败"再继续跑下一片。
        // 旧实现把所有异常一律记成 `status:'failed'` 并继续循环：用户在进度卡上点「停止」，
        // 抛出的 cancelledErr 被这里吞掉，于是后续每一片照常发起（分钟级 + 计费），
        // 而界面还提示"已取消" —— 取消按钮的真实语义变成了"跳过这一片"。
        // 现在：带 cancelled 标记（或 AbortError）的异常直接返回 cancelled，不再启动后续片。
        if (e && (e.cancelled === true || e.name === 'AbortError')) {
          return { results: out, cancelled: true };
        }
        rec = {
          segment_id: seg.segment_id, ordinal: seg.ordinal, source_version: plan.source_version,
          status: 'failed', output: '', output_hash: null, error: String((e && e.message) || e),
          verification: null, at: Date.now(),
        };
      }
      if (idx >= 0) out[idx] = rec; else out.push(rec);
      if (onProgress) onProgress({ results: out, segment_id: seg.segment_id, done: out.filter((r) => r.status === 'done').length, total: (plan.segments || []).length });
    }
    return { results: out, cancelled: cancelled() };
  }

  /** 语义审稿的分片报告合并：每条问题都带片号，作者能在"哪一片、哪一句"上定位。
   *  输出形态与单请求审稿一致（issues/strengths 是字符串数组），另有 attribution 记录片号归属。 */
  function mergeReviewReports(spec) {
    const { plan, results } = spec || {};
    const summary = [];
    const issues = [];
    const strengths = [];
    const attribution = [];
    const segments = [];
    for (const seg of (plan && plan.segments) || []) {
      const r = (results || []).find((x) => x && x.segment_id === seg.segment_id);
      const report = r && r.report;
      segments.push({ segment_id: seg.segment_id, ordinal: seg.ordinal, ok: !!(r && r.status === 'done') });
      if (!report) continue;
      const where = '（' + seg.segment_id + ' 第 ' + seg.ordinal + ' 片）';
      if (report.summary) summary.push(report.summary + where);
      for (const it of report.issues || []) { attribution.push({ kind: 'issue', index: issues.length, segment_id: seg.segment_id }); issues.push(String((it && it.text) || it) + where); }
      for (const st of report.strengths || []) { attribution.push({ kind: 'strength', index: strengths.length, segment_id: seg.segment_id }); strengths.push(String((st && st.text) || st) + where); }
    }
    return { summary: summary.join(' '), issues, strengths, segments, attribution };
  }

  /** UI 摘要：原文版本、目标范围、片数、完成/失败/过期、覆盖结果、未解决项。 */
  function summaryText(spec) {
    const { plan, results, manifest, running } = spec || {};
    if (!plan || plan.mode === 'single' || !(plan.segments && plan.segments.length)) {
      const b = (plan && plan.budget) || {};
      return [
        '全文单请求处理（无需分片）',
        '原文版本 ' + String((plan && plan.source_version) || '').slice(0, 12) + '…（' + ((plan && plan.source_chars) || 0) + ' 字）',
        '最终序列化请求 ' + b.single_request_chars + ' 字 / 可用 ' + b.usable + ' 字',
      ];
    }
    const rows = manifest && manifest.segments ? manifest.segments : segmentStatuses(plan, results, plan && plan.source_version);
    const done = rows.filter((r) => r.status === 'done').length;
    const failed = rows.filter((r) => r.status === 'failed' || r.status === 'violation').length;
    const stale = rows.filter((r) => r.status === 'stale').length;
    const total = (plan && plan.segments ? plan.segments.length : 0);
    const ids = (plan && plan.segments) || [];
    const range = ids.length ? ids[0].segment_id + ' → ' + ids[ids.length - 1].segment_id : '（整篇）';
    const lines = [];
    lines.push('原文版本 ' + String((plan && plan.source_version) || '').slice(0, 12) + '…（' + ((plan && plan.source_chars) || 0) + ' 字）');
    lines.push('目标范围：' + range + '（' + total + ' 片）');
    lines.push('完成 ' + done + ' / 失败 ' + failed + ' / 过期 ' + stale + (running ? '（进行中）' : ''));
    if (manifest) {
      const flags = ['首段 ' + (manifest.first_ok ? '✓' : '✗'), '尾段 ' + (manifest.tail_ok ? '✓' : '✗'), '章尾哨兵 ' + (manifest.sentinel_ok ? '✓' : '✗')].join(' · ');
      lines.push('覆盖：' + flags + ' · 结论 ' + (manifest.ok ? '通过（可合并）' : '不通过（不得合并）'));
      if (manifest.unresolved.length) lines.push('未解决：' + manifest.unresolved.join('；'));
    }
    return lines;
  }

  return {
    VERSION,
    DEFAULTS,
    limits,
    hashText,
    normalizeText,
    paragraphSpans,
    splitOversize,
    buildSegments,
    serializedChars,
    planTask,
    segmentMessages,
    stripFences,
    verifySegmentOutput,
    buildCoverageManifest,
    mergeResults,
    segmentStatuses,
    resumeSegments,
    runSegmentedTask,
    mergeReviewReports,
    summaryText,
    reasonText,
  };
});
