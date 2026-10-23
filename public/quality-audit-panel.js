/*
 * 质量审计面板（dsh-novel-quality-auditor）—— 纯函数 + 一个受控的发起动作。
 *
 * 界面纪律（方案 §11）：
 *   · 写作台只显示**一行**状态入口，不压缩正文列宽；
 *   · "补丁已应用"绝不显示成"验收通过"；
 *   · 任一已选项 PARTIAL/FAIL/NEED_CONTEXT/BLOCKED/STALE → 不得显示"全部完成"。
 *
 * 这里不直接改 DOM（app.js 负责渲染），只产出可断言的字符串/状态对象。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelQualityAuditPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const RUN_LABELS = {
    CREATED: '已创建', INPUT_FROZEN: '输入已冻结', DSH_STARTED: '审计进程已启动', RUNNING: '审计进行中',
    BLIND_SUBMITTED: '盲审已提交', COMPARE_RUNNING: '初审对照中', RESULT_RECEIVED: '结果待主机校验',
    HOST_VERIFIED: '主机校验通过', MERGED: '已合并', COMPLETED: '已完成',
    FAILED_CONTRACT: '失败：契约不合法', FAILED_AUTH: '失败：鉴权', FAILED_DSH: '失败：DSH 不可用',
    AUDIT_NOT_SUBMITTED: '失败：未结构化提交', INTERRUPTED: '中断（可重跑）', CANCELLED: '已取消', STALE: '已过期（候选稿变了）',
  };

  const ISSUE_LABELS = {
    PASS: '验收通过', PARTIAL: '部分修复', FAIL: '复验失败', NEED_CONTEXT: '缺少上下文',
    BLOCKED_SCOPE: '越权/保护区', STALE: '已过期', AWAITING_AUDIT: '等待独立审计',
    // 审计员说"作者判错了"、但反例与主张不是同一件事 → 这里既不写"通过"也不写"被驳倒"。
    ADVISORY_NEEDS_REVIEW: '反例待人工判断',
    COVERED: '已覆盖', DISPUTED: '存在反驳（反例相关）', INVALID_EVIDENCE: '证据不成立',
  };

  function runLabel(status) { return RUN_LABELS[String(status || '')] || String(status || '未开始'); }
  function issueLabel(v) { return ISSUE_LABELS[String(v || '').toUpperCase()] || String(v || '未知'); }

  /**
   * 写作台的一行状态。没有审计运行时返回 ''（不占位）。
   * @param {object|null} run {status, kind, counts:{pass,total,...}}
   */
  function summaryLine(run) {
    if (!run || !run.status) return '';
    const label = runLabel(run.status);
    const counts = run.counts || {};
    if (run.kind === 'revision' && Number(counts.selected) > 0) {
      const pass = Number(counts.pass) || 0;
      const total = Number(counts.selected) || 0;
      const unresolved = total - pass;
      const tail = unresolved > 0 ? ` · ${unresolved} 项未通过` : ' · 全部通过（仍需作者合并）';
      return `修稿验收 · ${pass}/${total} 已通过${tail}     [打开审稿工作区]`;
    }
    if (run.kind === 'review') return `独立复核 · ${label}     [打开审稿工作区]`;
    return `质量审计 · ${label}`;
  }

  /**
   * 是否允许显示"全部完成"。只有"所有已选项 PASS 且 run 已 COMPLETED"才为真。
   * @param {object} run
   * @param {Array<{final?:string, verdict?:string}>} issues
   */
  function allDone(run, issues) {
    if (!run || String(run.status) !== 'COMPLETED') return false;
    const list = Array.isArray(issues) ? issues : [];
    if (!list.length) return false;
    return list.every((i) => String((i && (i.final || i.verdict)) || '').toUpperCase() === 'PASS');
  }

  /**
   * 「实际花了多少」的显示口径。
   *
   * 为什么要有它：审计的真实计费发生在 dsh 侧，本服务看不到 token 用量，
   * 而旧实现把"没记账"显示成 `实际 ¥0.00` —— 一次真实跑完的审计在界面上等于免费，
   * 那是谎报（2026-10-22 真实联网演练实测）。现在只有**确知**金额时才算钱，
   * 其余一律写"未知"，让作者知道"这笔钱记不到账上"。
   */
  function chargeText(budget) {
    const b = budget && typeof budget === 'object' ? budget : {};
    const known = b.charge_known === true || (Number(b.charged_microunits) > 0);
    if (!known) return '实际费用未知（dsh 侧未回传用量，不作 0 元记账）';
    const mu = Number(b.charged_microunits) || 0;
    if (b.charge_source === 'not_billed_yet') return '实际 ¥0.00（尚未走到付费阶段）';
    return `实际 ¥${(mu / 1e6).toFixed(2)}`;
  }

  /** 工作区抽屉：coverage / 预算 / 运行状态 / 错误码。 */
  function drawerHtml(run, items) {
    if (!run) return '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const budget = run.budget || {};
    const rows = (Array.isArray(items) ? items : []).map((i) => `<li><b>${esc(i.issue_id)}</b> ${esc(issueLabel(i.final || i.verdict))}${i.reason ? ` — ${esc(i.reason)}` : ''}</li>`).join('');
    return `<div class="quality-audit-drawer">
      <div class="qa-run">${esc(runLabel(run.status))}（${esc(run.kind || '')}）</div>
      <div class="muted">base ${esc(String(run.base_hash || '').slice(0, 20))}${run.candidate_hash ? ` · candidate ${esc(String(run.candidate_hash).slice(0, 20))}` : ''}</div>
      <div class="muted">预算：授权 ¥${(Number(budget.authorized_microunits || 0) / 1e6).toFixed(2)} · 估算 ¥${(Number(budget.estimated_microunits || 0) / 1e6).toFixed(2)} · ${chargeText(budget)}</div>
      ${run.error_code ? `<div class="qa-error">错误码：${esc(run.error_code)} ${esc(run.error_detail || '')}</div>` : ''}
      ${rows ? `<ul class="qa-items">${rows}</ul>` : '<div class="muted">尚无逐项结论</div>'}
    </div>`;
  }


  /**
   * 修稿逐项终验表：每条已选项一个终态 + 失败原因 + 定向复修提示。
   * 为什么单独一张表：修稿结果最容易"看起来都改完了"。这张表把
   * PASS / PARTIAL / FAIL / NEED_CONTEXT / BLOCKED / STALE 并排摆出来，
   * 让"补丁已应用"不能冒充"验收通过"。
   */
  function revisionTableHtml(merged) {
    if (!merged) return '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const issues = Array.isArray(merged.issues) ? merged.issues : [];
    if (!issues.length) return '<div class="muted">尚无逐项终验结论</div>';
    const rows = issues.map((i) => {
      const verdict = String(i.final || i.verdict || '');
      const cls = verdict === 'PASS' ? 'ok' : (verdict === 'PARTIAL' || verdict === 'NEED_CONTEXT') ? 'warn' : 'bad';
      return `<tr class="qa-row ${cls}"><td>${esc(i.issue_id)}</td><td>${esc(issueLabel(verdict))}</td>`
        + `<td>${esc(i.final_reason || i.reason || '')}${acceptanceLine(i)}</td></tr>`;
    }).join('');
    const c = merged.counts || {};
    const summary = `已选 ${Number(c.selected) || issues.length} · 通过 ${Number(c.pass) || 0} · 部分 ${Number(c.partial) || 0}`
      + ` · 失败 ${Number(c.fail) || 0} · 待核验 ${Number(c.need_context) || 0} · 越权 ${Number(c.blocked) || 0} · 过期 ${Number(c.stale) || 0}`;
    const targets = Array.isArray(merged.repair_targets) ? merged.repair_targets : [];
    return `<div class="qa-revision"><div class="qa-summary">${esc(summary)}</div>`
      + `<table class="qa-table"><thead><tr><th>问题</th><th>终态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`
      + (targets.length ? `<div class="qa-repair">可定向复修：${esc(targets.join('、'))}</div>` : '')
      + `<div class="muted">"补丁已应用"不等于"验收通过"；只有全部 PASS 才显示完成。</div></div>`;
  }

  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * 单条终验的**子条件**摘要（§5）。
   *
   * 为什么要显示："只解决局部"如果只写原因，作者没法判断"还差哪一条"。
   * 子条件是逐条判据（群众重复已压缩 / 主角状态可见…），一条不达成就是 PARTIAL——
   * 把它们列出来，"为什么没通过"才是可执行的，而不是一句形容词。
   */
  function acceptanceLine(issue) {
    const checks = Array.isArray(issue && issue.acceptance_checks) ? issue.acceptance_checks : [];
    if (!checks.length) return '';
    const pass = checks.filter((c) => c && c.status === 'PASS').length;
    const bad = checks.filter((c) => c && c.status !== 'PASS');
    const declared = String((issue && issue.verdict_declared) || '');
    const final = String((issue && (issue.final || issue.verdict)) || '');
    // 模型说 PASS 但子条件不成立 → 必须写明"它的话被降级了"，否则作者会以为是系统算错。
    const downgrade = (issue && issue.verdict_derived === true && declared && declared !== final)
      ? `<div class="muted">模型原判 ${escHtml(issueLabel(declared))}，按子条件降为 ${escHtml(issueLabel(final))}</div>`
      : '';
    const list = checks.map((c) => `<li>${c.status === 'PASS' ? '✓' : (c.status === 'FAIL' ? '✗' : '?')} `
      + `${escHtml(c.key)}${c.evidence ? ` — ${escHtml(c.evidence)}` : ''}</li>`).join('');
    return `<div class="qa-checks"><div class="muted">子条件 ${pass}/${checks.length} 通过`
      + `${bad.length ? `（未达成：${bad.map((c) => escHtml(c.key)).join('、')}）` : ''}</div>`
      + `<ul class="qa-check-list">${list}</ul>${downgrade}</div>`;
  }

  /**
   * 缺字段台账（§3.2）：一行一条，含 finding / 字段 / 期望与实际 / 能不能免费修。
   *
   * 为什么不做成一句"6 条缺字段"：那样作者既不知道缺在哪，也不知道该不该再花一次钱。
   * 「免费重解析」与「需要模型重新生成」是两种完全不同的处置。
   */
  function defectTableHtml(defects, summary) {
    const list = Array.isArray(defects) ? defects : [];
    if (!list.length) return '';
    const resolutionLabel = { FREE_REPARSE: '可免费补齐', PAID_REGENERATE: '需模型重新生成', AUTHOR_CONFIRM: '需作者确认' };
    const rows = list.map((d) => `<tr class="qa-defect ${d.severity === 'blocker' ? 'bad' : 'warn'}">`
      + `<td>${escHtml(d.finding_id || '—')}</td><td>${escHtml(d.field_path)}</td>`
      + `<td>${escHtml(d.expected_type)}</td><td>${escHtml(d.actual_type)}</td>`
      + `<td>${escHtml(resolutionLabel[d.resolution_path] || d.resolution_path || '')}</td></tr>`).join('');
    const s = summary || {};
    const head = s.total
      ? `<div class="qa-summary">共 ${Number(s.total) || list.length} 处（阻断 ${Number(s.blockers) || 0}）`
        + `${s.by_resolution ? '：' + Object.entries(s.by_resolution).map(([k, v]) => `${escHtml(resolutionLabel[k] || k)} ${v}`).join(' · ') : ''}</div>`
      : '';
    return `<div class="qa-defects">${head}`
      + `<table class="qa-table"><thead><tr><th>问题</th><th>字段</th><th>期望</th><th>实际</th><th>怎么修</th></tr></thead>`
      + `<tbody>${rows}</tbody></table>`
      + `<div class="muted">结构问题不会变成正式修稿问题：补齐这些字段之前，这份结果不进逐项验收。</div></div>`;
  }

  /**
   * 反例相关性降级台账（§3.1）：审计员说"作者判错了"，但反例与主张不是同一件事时，
   * 如实显示"这次不算驳倒"，并给出共享词证据 —— 不悄悄删、也不装作没发生。
   */
  function relevanceTableHtml(downgrades) {
    const list = Array.isArray(downgrades) ? downgrades : [];
    if (!list.length) return '';
    const rows = list.map((d) => `<li><b>${escHtml(d.issue_id)}</b> `
      + `${d.verdict === 'INVALID_RELEVANCE' ? '反例与主张不相干' : '反例与主张关联太弱'}`
      + `${Array.isArray(d.overlap) && d.overlap.length ? `（共享词：${escHtml(d.overlap.join('、'))}）` : '（无共享词）'}`
      + `${d.reasons && d.reasons.length ? ` — ${escHtml(d.reasons.join('；'))}` : ''}</li>`).join('');
    return `<div class="qa-relevance"><div class="qa-summary">这 ${list.length} 条不改判为"作者判错"（按待人工判断处理）</div>`
      + `<ul>${rows}</ul></div>`;
  }

  /**
   * 是否允许合并正文。BLOCKED_SCOPE / STALE 是硬阻塞（越权或候选已过期）；
   * PARTIAL 允许作者带"部分完成"标签合并（方案 §10.3 的终态），但不能显示"全部修复"。
   */
  function mergeAllowed(merged) {
    if (!merged) return false;
    const issues = Array.isArray(merged.issues) ? merged.issues : [];
    return !issues.some((i) => ['BLOCKED_SCOPE', 'STALE'].includes(String(i.final || i.verdict || '')));
  }


  /**
   * 审稿报告里的"独立复核"入口条（三态 + 主按钮）。
   * 为什么要单独一块：旧入口只是底部一枚 secondary 小按钮，作者根本注意不到。
   * 这里同时说清"会调用模型、消耗额度"与"需要结构化审稿"两个前提。
   *
   * `articleEmpty`（2026-10-22）：独立复核的正文只从**库内本章正文**取，编辑器里有字
   * 但正文没保存（草稿链「先审稿再应用」）时，点下去必然被服务端拒绝。所以空正文时
   * 不再给一个"点了才失败"的按钮，而是直接说明出路 —— 少一次付费往返，也少一次误解。
   * @param {{run?:object|null, pluginReady?:boolean, hasStructuredReview?:boolean, articleEmpty?:boolean}} input
   */
  function auditEntryHtml({ run = null, pluginReady = true, hasStructuredReview = true, articleEmpty = false } = {}) {
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const status = String((run && run.status) || '');
    const terminal = ['COMPLETED', 'MERGED', 'HOST_VERIFIED', 'RESULT_RECEIVED'].includes(status);
    const failing = ['FAILED_CONTRACT', 'FAILED_AUTH', 'FAILED_DSH', 'AUDIT_NOT_SUBMITTED', 'INTERRUPTED', 'STALE', 'CANCELLED'].includes(status);
    const running = ['DSH_STARTED', 'RUNNING', 'BLIND_SUBMITTED', 'COMPARE_RUNNING', 'INPUT_FROZEN', 'CREATED'].includes(status);
    const emptyBody = articleEmpty === true;
    let headline = '未做独立复核';
    let tone = 'idle';
    if (emptyBody && !running) { headline = '本章正文为空，暂时不能独立复核'; tone = 'err'; }
    else if (running) { headline = `独立复核进行中 · ${runLabel(status)}`; tone = 'busy'; }
    else if (terminal) { headline = `上次独立复核 · ${runLabel(status)}`; tone = 'ok'; }
    else if (failing) { headline = `上次独立复核失败 · ${runLabel(status)}`; tone = 'err'; }
    const disabled = !pluginReady || running || emptyBody;
    const btnLabel = emptyBody
      ? '正文为空，先保存本章'
      : (running ? '复核进行中…' : (terminal ? '重新复核（盲审→对照）' : '开始独立复核（盲审→对照）'));
    const hint = emptyBody
      ? '独立复核只读已保存的正文：先在编辑器保存本章，或从「有未应用的生成稿」取回后再复核（编辑器里没保存的文字不算正文）'
      : (!pluginReady
        ? '审计插件未安装：点「安装插件」或到 AI 设置的依赖清单处理'
        : (!hasStructuredReview
          ? '当前是旧报告/缺 findings：可以复核，但结论上限是「待核验」'
          : '会启动一次独立的盲审 + 初审对照，消耗模型额度'));
    return `<div class="qa-entry ${esc(tone)}">
      <div class="qa-entry-main"><b>🔍 ${esc(headline)}</b><div class="muted">${esc(hint)}</div></div>
      <div class="qa-entry-actions">
        ${pluginReady ? '' : '<button class="btn small secondary" data-action="install-audit-plugin">安装插件</button>'}
        <button class="btn small${terminal ? ' secondary' : ''}" data-action="quality-audit-review" data-chapter="${esc(String((run && run.chapter_id) || ''))}"${disabled ? ' disabled' : ''}>${esc(btnLabel)}</button>
      </div>
    </div>`;
  }

  /**
   * 缺依赖弹窗的内容（纯函数）：每个缺失项给出"缺什么/为什么/命令/跳转"。
   * 命令放在 <code> 里并带复制按钮；仓库内路径给"打开目录"动作，http 给外链。
   */
  function missingDepsHtml(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '';
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = list.map((it) => {
      const cmd = it && it.cmd ? `<div class="env-cmd"><code>${esc(it.cmd)}</code><button class="btn small secondary" data-action="copy-text" data-copy="${esc(it.cmd)}">复制</button></div>` : '';
      const open = it && it.action === 'install_audit_plugin'
        ? `<button class="btn small" data-action="install-audit-plugin">一键安装插件</button>`
        : (it && it.url
          ? (String(it.url).startsWith('http')
            ? `<a class="btn small secondary" href="${esc(it.url)}" target="_blank" rel="noreferrer noopener">打开下载页</a>`
            : `<button class="btn small secondary" data-action="open-repo-path" data-path="${esc(it.url)}">打开目录</button>`)
          : '');
      return `<div class="qa-missing"><div><b>${esc(it.name || it.code || '缺少依赖')}</b><div class="muted">${esc(it.why || '')}</div>${cmd}</div><div>${open}</div></div>`;
    }).join('');
    return `<div class="qa-missing-list">${rows}</div><div class="muted">安装后不用重启服务：点「重新检测」即可刷新状态。</div>`;
  }

  return { RUN_LABELS, ISSUE_LABELS, runLabel, issueLabel, summaryLine, allDone, drawerHtml, revisionTableHtml, mergeAllowed, auditEntryHtml, missingDepsHtml, acceptanceLine, defectTableHtml, relevanceTableHtml, chargeText };
});
