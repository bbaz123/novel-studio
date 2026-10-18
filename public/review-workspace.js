/*
 * 审稿工作区（review-workspace）—— 纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么把"视图逻辑"单独拆出来（v1.2.4 方案 §8 / P0E）：
 *   旧界面把"8 项进度 + 图表 + 问题全文 + 差异全文"一次性堆进一个大弹窗，
 *   于是正文宽度被挤、状态被埋在长文里，作者无法回答"现在到底哪几条没过"。
 *   工作区需要的判据都是**纯计算**：顶部那一行统计、左侧问题行、每个问题的证据定位、
 *   可见差异块、以及"现在该点哪个按钮"。这些判据必须可离线复验（不能只靠截图）。
 *
 * 三条纪律（写死在实现里）：
 *   ① 顶部统计只数**有结论**的条目：`verified / unresolved / pending`，绝不用
 *      "已应用 N 个补丁"冒充"已修好 N 条"；
 *   ② 未跑语义 = `AWAITING_SEMANTIC`（待复验），既不算通过也不算失败；
 *   ③ 每条问题必须能定位到**具体证据引文**；定位不到就如实显示"证据不足"，
 *      不假装高亮。
 *
 * 本模块不碰 DOM、不发请求、不写存储。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.2.4';

  /** 问题级终态 → 界面标签。颜色只是辅助，文字必须能独立读（a11y）。 */
  const STATUS_LABEL = {
    ISSUE_VERIFIED: { text: '已解决', tone: 'ok' },
    PARTIAL: { text: '只解决局部', tone: 'warn' },
    UNRESOLVED: { text: '未通过', tone: 'bad' },
    AWAITING_SEMANTIC: { text: '待复验', tone: 'wait' },
    CANON_CONFLICT: { text: '蓝图冲突', tone: 'warn' },
    NOT_SELECTED: { text: '未勾选', tone: 'muted' },
  };

  /** 运行级阶段 → 一行状态 + 该谁动。与 revision-finalize 的 STAGE 一一对应。 */
  const STAGE_LABEL = {
    AWAITING_SEMANTIC: { text: '候选已生成 · 尚未语义复验', tone: 'wait' },
    PARTIAL_CANDIDATE: { text: '候选未通过全部验收', tone: 'bad' },
    BLOCKED: { text: '候选受阻（门禁/蓝图/底稿）', tone: 'bad' },
    VERIFIED_CANDIDATE: { text: '全部通过 · 等待作者合并', tone: 'ok' },
    PERSISTED_VERIFIED: { text: '已入库并复核', tone: 'ok' },
    // 2026-10-18 作者授权：允许"跳过语义复验直接合并"。合并是发生了，但"哪几条真修好"没有结论，
    // 所以这一档必须是**warn**且措辞写明"未做语义复验"，不能混进 PERSISTED_VERIFIED 冒充复核过。
    PERSISTED_UNVERIFIED: { text: '已合并 · 未做语义复验', tone: 'warn' },
  };

  const FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'pending', label: '待处理' },
    { id: 'verified', label: '已验证' },
    { id: 'author', label: '需作者决定' },
  ];

  /** 视图模式：差异 / 相关段落 / 全文。默认差异（避免每次排三四千字两列）。 */
  const MODES = [
    { id: 'diff', label: '差异' },
    { id: 'context', label: '相关段落' },
    { id: 'full', label: '全文' },
  ];

  const textOf = (x) => String(x == null ? '' : x);

  function statusOf(status) {
    return STATUS_LABEL[textOf(status)] || { text: textOf(status) || '未知', tone: 'muted' };
  }

  /** 顶部统计：只数有结论的条目。 */
  function countsOf(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return {
      selected: list.length,
      verified: list.filter((r) => r && r.final_status === 'ISSUE_VERIFIED').length,
      unresolved: list.filter((r) => r && r.final_status === 'UNRESOLVED').length,
      pending: list.filter((r) => r && r.final_status === 'AWAITING_SEMANTIC').length,
      partial: list.filter((r) => r && r.final_status === 'PARTIAL').length,
      canon: list.filter((r) => r && r.final_status === 'CANON_CONFLICT').length,
      patched: list.filter((r) => r && Number(r.patch_count) > 0).length,
    };
  }

  /** 顶部一行（方案 §8.2 / §8.5）：`第一章 · 已选8 · 已验证2 · 待复验6`。 */
  function summaryLine(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const c = countsOf(rows);
    const chapter = textOf(input.chapterTitle) || '本章';
    const parts = [`已选 ${c.selected}`];
    // 未跑语义时**不能**出现"通过"，只报"已应用补丁 + 待复验"（§8.5 第一条模式）。
    if (c.verified) parts.push(`已验证 ${c.verified}`);
    if (input.patchedCount != null && !c.verified) parts.push(`已应用 ${Number(input.patchedCount) || 0} 补丁`);
    if (c.unresolved) parts.push(`未通过 ${c.unresolved}`);
    if (c.partial) parts.push(`局部 ${c.partial}`);
    if (c.canon) parts.push(`蓝图冲突 ${c.canon}`);
    if (c.pending) parts.push(`待复验 ${c.pending}`);
    if (!c.verified && !c.unresolved && !c.partial && !c.canon && !c.pending) parts.push('0 条已独立验证');
    return `${chapter} · ${parts.join(' · ')}`;
  }

  /** 左侧问题行：两行以内；`#03 母亲行程矛盾` + 状态。 */
  function issueRowsOf(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    return rows.map((r, i) => {
      const st = statusOf(r.final_status);
      const id = textOf(r.issue_id);
      return {
        index: i + 1,
        issue_id: id,
        // 显示编号沿用审稿报告的原始序号（稳定编号），不按当前顺序重新编号。
        ordinal: /^\d+$/.test(id) ? String(Number(id)) : String(i + 1),
        title: textOf(r.title) || `问题 ${id}`,
        status: r.final_status,
        status_text: st.text,
        tone: st.tone,
        reason_code: textOf(r.reason_code),
        reason: textOf(r.reason),
        evidence_count: Number(r.evidence_count) || 0,
        patch_count: Number(r.patch_count) || 0,
        // "需作者决定"= 蓝图冲突或需要补范围；不是系统能自己修的。
        needs_author: r.final_status === 'CANON_CONFLICT'
          || ['NEEDS_SCOPE', 'AUTHORIZATION_MISSING', 'PROTECTED_SPAN', 'CANON_CONFLICT'].includes(textOf(r.reason_code)),
      };
    });
  }

  function filterRows(rows, filter) {
    const list = Array.isArray(rows) ? rows : [];
    // 同时接受"终审行"（final_status）与"左侧显示行"（status）：两处用的是同一套枚举，
    // 但字段名不同。只认一个会让"待处理"筛出空列表（看起来像没有待办，实际全是待办）。
    const st = (r) => textOf(r && (r.status || r.final_status));
    switch (textOf(filter)) {
      case 'verified': return list.filter((r) => st(r) === 'ISSUE_VERIFIED');
      case 'pending': return list.filter((r) => ['AWAITING_SEMANTIC', 'UNRESOLVED', 'PARTIAL'].includes(st(r)));
      case 'author': return list.filter((r) => r && r.needs_author);
      default: return list.slice();
    }
  }

  /** 下一条/上一条问题：只读切换，不调用模型、不计费。 */
  function stepIssue(rows, currentId, delta) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    const at = list.findIndex((r) => textOf(r.issue_id) === textOf(currentId));
    const from = at < 0 ? 0 : at;
    const next = (from + (Number(delta) || 1) + list.length) % list.length;
    return list[next];
  }

  /**
   * 证据定位：把一条逐字引文映射成"前后各 radius 字的片段"。
   * 找不到就返回 `found:false` —— 界面必须显示"证据不足"，不能假装高亮。
   */
  function locateQuote(body, quote, radius = 120) {
    const b = textOf(body);
    const q = textOf(quote).trim();
    if (!q) return { found: false, reason: '没有逐字引文' };
    const at = b.indexOf(q);
    if (at < 0) return { found: false, reason: '这条引文不在当前正文里' };
    const second = b.indexOf(q, at + 1);
    const from = Math.max(0, at - radius);
    const to = Math.min(b.length, at + q.length + radius);
    return {
      found: true,
      ambiguous: second >= 0,
      offset: at,
      occurrence: second >= 0 ? '多处出现（界面不默认第一处）' : '唯一出现',
      before: b.slice(from, at),
      hit: q,
      after: b.slice(at + q.length, to),
      body: `…${b.slice(from, at)}【${q}】${b.slice(at + q.length, to)}…`,
    };
  }

  /** 一条问题要显示的所有证据（按 role 分可编辑锚点/只读引用）。 */
  function evidenceOf(finding, oldText, newText, radius = 120) {
    const ev = finding && Array.isArray(finding.evidence) ? finding.evidence : [];
    return ev.map((e, i) => {
      const quote = textOf(e && e.quote).trim();
      return {
        index: i + 1,
        role: textOf(e && e.role) || 'reference',
        quote,
        editable: textOf(e && e.role) === 'candidate_edit',
        before: locateQuote(oldText, quote, radius),
        after: locateQuote(newText, quote, radius),
      };
    });
  }

  /**
   * 分段差异块：按段落配对（同索引同文本 = 未变）。
   * 为什么不做字符级 LCS：工作区要的是"哪几段变了、跳过去看"，不是逐字高亮；
   * 逐字比对会在长章上退化成 O(n²) 且让整页闪烁。
   */
  function diffBlocks(oldText, newText) {
    const split = (t) => textOf(t).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    const a = split(oldText);
    const b = split(newText);
    const blocks = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const before = a[i] == null ? '' : a[i];
      const after = b[i] == null ? '' : b[i];
      let kind = 'same';
      if (before && !after) kind = 'del';
      else if (!before && after) kind = 'add';
      else if (before !== after) kind = 'change';
      blocks.push({ index: i, id: `p${i + 1}`, kind, before, after });
    }
    return blocks;
  }

  function changedBlocks(blocks) {
    return (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.kind !== 'same');
  }

  function diffSummary(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const changed = list.filter((b) => b.kind !== 'same').length;
    return { total: list.length, changed, unchanged: list.length - changed };
  }

  /** 金额格式（整数分 → ¥x.xx）。非有限值一律"未知"，不显示 ¥0.00。 */
  function formatCents(cents) {
    const n = Number(cents);
    if (!Number.isFinite(n) || n < 0) return '未知';
    return `¥${(n / 100).toFixed(2)}`;
  }

  /**
   * 费用三栏（v1.2.4 P1「修稿输入预算预检与调用/已扣费分离」）。
   *
   * 为什么必须分三栏：旧界面只有一个"预计费用"，于是三件事被混成一件：
   *   ① **预计上界**（调用前估算，可能高估）；② **已授权**（作者批准的额度）；
   *   ③ **已扣费**（真实账单）。三者不相等是常态，而把"未知"显示成 0 会被读成"没花钱"。
   * 本函数只做展示口径，不做计费判定（判定在 `planAutoRepair`/`createClosureBudget`）。
   */
  function costOf(input = {}) {
    const estimate = Number.isFinite(Number(input.estimateCents)) ? Number(input.estimateCents) : null;
    const authorized = Number.isFinite(Number(input.authorizedCents)) ? Number(input.authorizedCents) : null;
    // 只认**显式**的已扣费；null / undefined 一律"未知"，绝不当 0
    const charged = (input.chargedCents == null) ? null : (Number.isFinite(Number(input.chargedCents)) ? Number(input.chargedCents) : null);
    return {
      estimateCents: estimate,
      authorizedCents: authorized,
      chargedCents: charged,
      estimateText: estimate == null ? '未知（没有可信计价）' : `≤ ${formatCents(estimate)}`,
      authorizedText: authorized == null ? '未授权' : formatCents(authorized),
      chargedText: charged == null ? '未知（不当作 0）' : formatCents(charged),
      overBudget: estimate != null && authorized != null && estimate > authorized,
    };
  }

  /** 一行费用说明（界面与导出共用，避免两处措辞漂移）。 */
  function costLine(input = {}) {
    const c = costOf(input);
    return `预计上界：${c.estimateText} · 已授权：${c.authorizedText} · 已扣费：${c.chargedText}${c.overBudget ? ' · ⚠️ 预计已超过已授权额度' : ''}`;
  }

  /** 该显示哪些块：差异模式只给改过的段，全文模式给全部。 */
  function visibleBlocks(blocks, mode) {
    const list = Array.isArray(blocks) ? blocks : [];
    if (textOf(mode) === 'full') return list;
    return changedBlocks(list);
  }

  /**
   * 底栏按钮（方案 §8.7）：只给**当前状态真的能执行**的动作。
   * 不把"确认要修"当成"确认永久写回"，也不给"再验一次"这种同一份候选重复付费的入口。
   *
   * `busy`（一次付费复验正在跑）：所有按钮置灰，主按钮文案改成"正在复验…"。
   * 为什么不给"边跑边点别的"：复验结果会重写候选与终审行，中途切筛选/合并会把旧状态当新状态用。
   */
  function actionsOf(input = {}) {
    const stage = textOf(input.stage) || 'AWAITING_SEMANTIC';
    const counts = countsOf(input.rows);
    const semanticRuns = Number(input.semanticRuns) || 0;
    const busy = input.busy === true;
    const out = [];
    if (stage === 'BLOCKED') {
      out.push({ action: 'back', label: '返回写作台', primary: true, note: '先按阻塞原因处理（门禁/蓝图/底稿），不要绕过' });
      return out;
    }
    if (stage === 'PERSISTED_VERIFIED') {
      out.push({ action: 'back', label: '返回写作台', primary: true, note: '已入库并复核' });
      return out;
    }
    // 2026-10-18：作者授权"跳过复验直接合并"。只给返回按钮 —— 正文已经合并过了，
    // 再点合并只会把同一份候选再写一次，没有任何意义。
    if (stage === 'PERSISTED_UNVERIFIED') {
      out.push({ action: 'back', label: '返回写作台', primary: true, note: '已合并到正文；本次没有跑语义复验' });
      return out;
    }
    if (stage === 'AWAITING_SEMANTIC') {
      out.push({
        action: 'semantic-verify',
        label: busy ? '正在复验…（请勿关闭）' : '运行独立语义复验（一次付费调用）',
        primary: true,
        disabled: busy || semanticRuns >= 1,
        help: 'review_semantic_verify',
        note: semanticRuns >= 1 ? '同一份候选只复验一次；要再验必须先改候选' : '未复验的条目不算通过',
      });
      // 作者明确要求：不给"直接合并"就等于把作者锁在付费动作后面。所以给一个**并列的**
      // 次按钮，鼠标放上去就把跳过的后果说清楚（后果文案只有一处：forcedMergeWarning()）。
      if (!busy && semanticRuns < 1) {
        out.push({
          action: 'merge-forced',
          label: '跳过复验直接合并',
          primary: false,
          danger: true,
          help: 'review_merge_forced',
          note: '跳过语义复验：只证明字符变了，不证明问题解决了；旧稿存历史版本可回退',
        });
      }
    }
    if (stage === 'VERIFIED_CANDIDATE') {
      out.push({ action: 'merge', label: '申请合并正文（仍走作者批准）', primary: true, note: '合并是作者动作，系统不会自己写库' });
    }
    if (stage === 'PARTIAL_CANDIDATE') {
      const remain = counts.unresolved + counts.partial + counts.canon;
      out.push({
        action: 'merge-partial', label: `合并到正文（仍有 ${remain} 条未通过）`, primary: false,
        note: '部分合并必须明确知道剩余未通过项；不宣称全部修好',
      });
    }
    out.push({ action: 'export', label: '导出待处理清单', primary: false, note: '只导出编号/原因码/理由，不含正文' });
    out.push({ action: 'back', label: '返回写作台（保留候选）', primary: false, note: '关闭工作区不删候选、不写库' });
    // 复验在跑：其余动作一律置灰（复验结果落地前，任何"下一步"都是在读旧状态）。
    // 想中断请用右下角进度卡上的「停止」——那条通道不经过工作区。
    if (busy) for (const a of out) a.disabled = true;
    return out;
  }

  /**
   * 「跳过复验直接合并」的后果文案（**唯一来源**：按钮 title、悬停帮助、测试都读这里）。
   *
   * 为什么必须写死"没有结论"而不是"可能没修好"：跳过之后真的没有任何逐条判定，
   * 既不能说修好了，也不能说没修好。用户要能凭这句话决定"先付费复验"还是"直接合并"。
   */
  function forcedMergeWarning() {
    return {
      title: '跳过语义复验，直接合并到正文',
      body: '确定性检查只能证明"字符变了"，不能证明"问题真的解决了"。跳过复验会失去三样东西：'
        + '① 这 8 条里到底几条修好了，**没有任何结论**（界面不会替你宣称通过，也不会记成已验证）；'
        + '② 合并是整章替换正文，被换掉的那一版存进本章「历史版本」，可以回退；'
        + '③ 这份候选合并后就从界面消费掉，**之后不能再对它做语义复验**（要验只能重新审稿、重新修稿）。'
        + '想要"每条是否修好"的证据，请先点「运行独立语义复验（一次付费调用）」。',
    };
  }

  /** 底部提示：把"为什么现在不能合并"说清楚，而不是只禁一个灰按钮。 */
  function blockerText(input = {}) {
    const stage = textOf(input.stage);
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const c = countsOf(rows);
    if (stage === 'BLOCKED') {
      const reason = textOf(input.reason) || '门禁/蓝图/底稿未通过';
      return `候选受阻：${reason}`;
    }
    if (stage === 'AWAITING_SEMANTIC') {
      // busy 时把"正在跑什么"说出来：以前只有按钮变灰，作者看不出后台有没有在干活。
      if (input.busy === true) {
        return `正在跑一次付费语义复验（${c.pending} 条待验）：进度见下方进度条，中断请用右下角进度卡的「停止」`;
      }
      return `${c.pending} 条尚未语义复验：现在既不能算修好，也不该直接合并`;
    }
    if (stage === 'PARTIAL_CANDIDATE') {
      const ids = rows.filter((r) => r.final_status !== 'ISSUE_VERIFIED').map((r) => `#${r.issue_id}`).join('、');
      return `未通过：${ids}（这些条目仍有问题，不能宣称"全部修好"）`;
    }
    if (stage === 'VERIFIED_CANDIDATE') return '全部已选问题通过语义验收；候选尚未合并到正文';
    if (stage === 'PERSISTED_VERIFIED') return '已入库并复核';
    // 跳过复验就合并的那条路：正文已经写进去了，但"哪几条真修好"是未知的 —— 说出来，别让人以为验过。
    if (stage === 'PERSISTED_UNVERIFIED') {
      return '已合并到正文（本次跳过语义复验）：哪些问题真的解决了没有结论；被替换的那一版在「历史版本」里可回退';
    }
    return '';
  }

  /**
   * 复验进行中的进度（2026-10-18 作者报：「点了复验，除了按钮点不动，没有任何明显在跑的样子」）。
   *
   * 一次付费调用是**不可分割的黑盒等待**：模型内部跑到第几条拿不到，所以这里
   * ① 给不确定进度条（来回跑动，不是假的百分比）② 如实报已用时间与阶段
   * ③ 明说"界面拿不到模型内部进度"，不编造剩余时间。
   */
  function progressOf(input = {}) {
    const startedAt = Number(input.startedAt) || 0;
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
    const sec = Math.floor(elapsed / 1000);
    const clock = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const count = Number(input.count) || 0;
    const phase = sec < 8
      ? '正在启动模型引擎'
      : (sec < 45 ? '模型正在逐条复验' : '仍在等待模型返回（长章可能超过 1 分钟）');
    const parts = [`${phase}…`];
    if (count > 0) parts.push(`${count} 条问题`);
    parts.push(`已用 ${clock}`);
    parts.push('一次付费调用，界面拿不到模型内部进度');
    return {
      running: true,
      // 不编造百分比：调用不可分割，给数字就是撒谎。界面据此画不确定进度条。
      percent: null,
      indeterminate: true,
      elapsedMs: elapsed,
      clock,
      phase,
      text: parts.join(' · '),
    };
  }

  /** 导出待处理清单（纯文本；不含正文，避免把作者稿子带出界面）。 */
  function pendingChecklistText(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const head = textOf(input.summaryLine);
    const lines = [head || `已选 ${rows.length}`, ''];
    rows.forEach((r, i) => {
      const st = statusOf(r.final_status);
      lines.push(`${i + 1}. #${textOf(r.issue_id)} ${textOf(r.title) || ''} — ${st.text}${r.reason_code ? `（${r.reason_code}）` : ''}`);
      if (r.reason) lines.push(`   理由：${textOf(r.reason).slice(0, 200)}`);
      if (r.repair_hint) lines.push(`   下一步：${textOf(r.repair_hint).slice(0, 200)}`);
    });
    return lines.join('\n');
  }

  function stageOf(status) {
    return STAGE_LABEL[textOf(status)] || { text: textOf(status) || '未知', tone: 'muted' };
  }

  return {
    VERSION,
    STATUS_LABEL,
    STAGE_LABEL,
    FILTERS,
    MODES,
    statusOf,
    stageOf,
    countsOf,
    summaryLine,
    issueRowsOf,
    filterRows,
    stepIssue,
    locateQuote,
    evidenceOf,
    diffBlocks,
    changedBlocks,
    diffSummary,
    visibleBlocks,
    formatCents,
    costOf,
    costLine,
    actionsOf,
    forcedMergeWarning,
    progressOf,
    blockerText,
    pendingChecklistText,
  };
});
