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

  /** 工作区抽屉：coverage / 预算 / 运行状态 / 错误码。 */
  function drawerHtml(run, items) {
    if (!run) return '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const budget = run.budget || {};
    const rows = (Array.isArray(items) ? items : []).map((i) => `<li><b>${esc(i.issue_id)}</b> ${esc(issueLabel(i.final || i.verdict))}${i.reason ? ` — ${esc(i.reason)}` : ''}</li>`).join('');
    return `<div class="quality-audit-drawer">
      <div class="qa-run">${esc(runLabel(run.status))}（${esc(run.kind || '')}）</div>
      <div class="muted">base ${esc(String(run.base_hash || '').slice(0, 20))}${run.candidate_hash ? ` · candidate ${esc(String(run.candidate_hash).slice(0, 20))}` : ''}</div>
      <div class="muted">预算：授权 ¥${(Number(budget.authorized_microunits || 0) / 1e6).toFixed(2)} · 估算 ¥${(Number(budget.estimated_microunits || 0) / 1e6).toFixed(2)} · 实际 ¥${(Number(budget.charged_microunits || 0) / 1e6).toFixed(2)}</div>
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
        + `<td>${esc(i.final_reason || i.reason || '')}</td></tr>`;
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
   * @param {{run?:object|null, pluginReady?:boolean, hasStructuredReview?:boolean}} input
   */
  function auditEntryHtml({ run = null, pluginReady = true, hasStructuredReview = true } = {}) {
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const status = String((run && run.status) || '');
    const terminal = ['COMPLETED', 'MERGED', 'HOST_VERIFIED', 'RESULT_RECEIVED'].includes(status);
    const failing = ['FAILED_CONTRACT', 'FAILED_AUTH', 'FAILED_DSH', 'AUDIT_NOT_SUBMITTED', 'INTERRUPTED', 'STALE', 'CANCELLED'].includes(status);
    const running = ['DSH_STARTED', 'RUNNING', 'BLIND_SUBMITTED', 'COMPARE_RUNNING', 'INPUT_FROZEN', 'CREATED'].includes(status);
    let headline = '未做独立复核';
    let tone = 'idle';
    if (running) { headline = `独立复核进行中 · ${runLabel(status)}`; tone = 'busy'; }
    else if (terminal) { headline = `上次独立复核 · ${runLabel(status)}`; tone = 'ok'; }
    else if (failing) { headline = `上次独立复核失败 · ${runLabel(status)}`; tone = 'err'; }
    const disabled = !pluginReady || running;
    const btnLabel = running ? '复核进行中…' : (terminal ? '重新复核（盲审→对照）' : '开始独立复核（盲审→对照）');
    const hint = !pluginReady
      ? '审计插件未安装：点「安装插件」或到 AI 设置的依赖清单处理'
      : (!hasStructuredReview
        ? '当前是旧报告/缺 findings：可以复核，但结论上限是「待核验」'
        : '会启动一次独立的盲审 + 初审对照，消耗模型额度');
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

  return { RUN_LABELS, ISSUE_LABELS, runLabel, issueLabel, summaryLine, allDone, drawerHtml, revisionTableHtml, mergeAllowed, auditEntryHtml, missingDepsHtml };
});
