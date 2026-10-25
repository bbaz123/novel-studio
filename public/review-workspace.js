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
    // 2026-10-22：部分合并（跑过复验、仍有未通过项）不能落到上面那一档——
    // "未做语义复验"是假的，作者明明验过、而且知道还差两条。措辞必须说清"仍带未通过项"。
    PERSISTED_PARTIAL: { text: '已合并 · 仍带未通过项', tone: 'warn' },
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

  /** 「改在哪」独立轴（2026-10-23）：补丁打偏与"没改"必须分开显示。 */
  const TARGET_LABEL = {
    NO_EDIT: '未改动',
    ON_TARGET: '改在证据上',
    WRONG_TARGET: '改错位置',
    UNPROVEN: '位置未证实',
  };

  const textOf = (x) => String(x == null ? '' : x);

  function statusOf(status) {
    return STATUS_LABEL[textOf(status)] || { text: textOf(status) || '未知', tone: 'muted' };
  }

  /** 顶部统计：只数有结论的条目。 */
  /**
   * 统一取"终态"：终审行用 `final_status`，左侧显示行用 `status`（见 `filterRows` 的说明）。
   * 只认一个的后果是**统计静默全 0**：界面会显示"已选 8 · 0 条已独立验证"，
   * 看起来像"一条都没过"，实际是字段名没对上。这里两种形状都认。
   */
  const finalStatusOf = (r) => textOf(r && (r.final_status || r.status));

  function countsOf(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return {
      selected: list.length,
      verified: list.filter((r) => finalStatusOf(r) === 'ISSUE_VERIFIED').length,
      unresolved: list.filter((r) => finalStatusOf(r) === 'UNRESOLVED').length,
      pending: list.filter((r) => finalStatusOf(r) === 'AWAITING_SEMANTIC').length,
      partial: list.filter((r) => finalStatusOf(r) === 'PARTIAL').length,
      canon: list.filter((r) => finalStatusOf(r) === 'CANON_CONFLICT').length,
      patched: list.filter((r) => Number(r && r.patch_count) > 0).length,
    };
  }

  /**
   * 问题三维状态（方案 §4.2）：授权态 / 操作态 / 验证态。
   *
   * 为什么必须分开：旧界面只给一个"已修复/未修复"徽记，读者无法判断这一项到底是
   * "没被选中"、"选错范围"、"补丁没应用"、"应用了但语义没跑"，还是"跑了但没过"。
   * 这三类失败的处理方式完全不同（补授权 / 重新定位 / 复验 / 定向复修）。
   */
  function dimensionsOf(row) {
    const r = row && typeof row === 'object' ? row : {};
    const cov = textOf(r.coverage_status);
    const authorized = r.authorized === true || ['patched', 'partially_resolved'].includes(cov);
    const authorization = authorized
      ? { code: 'AUTHORIZED', text: '已选·已授权' }
      : (['blocked', 'refused'].includes(cov)
        ? { code: 'PROTECTED', text: '受保护/被拒' }
        : (cov === 'keep' || cov === 'deferred'
          ? { code: 'SELECTED_NO_EDIT', text: '已选·未改' }
          : { code: 'NEEDS_SCOPE', text: '范围待补' }));
    const operation = Number(r.patch_count) > 0
      ? { code: 'PATCH_APPLIED', text: `候选已应用${Number(r.patch_count) > 1 ? `（${Number(r.patch_count)} 处）` : ''}` }
      : (['blocked', 'refused'].includes(cov)
        ? { code: 'PATCH_REJECTED', text: '补丁被拒' }
        : { code: 'NO_PATCH', text: '未产生补丁' });
    const final = textOf(r.final_status);
    const sem = textOf(r.semantic_status);
    let verification;
    if (final === 'ISSUE_VERIFIED') verification = { code: 'PASS', text: '独立复验通过' };
    else if (final === 'PARTIAL') verification = { code: 'PARTIAL', text: '部分通过' };
    else if (final === 'CANON_CONFLICT') verification = { code: 'CANON', text: '蓝图冲突' };
    else if (sem === 'not_run' || final === 'AWAITING_SEMANTIC') verification = { code: 'NOT_RUN', text: '未语义复验' };
    else verification = { code: 'FAIL', text: '未通过' };
    return { authorization, operation, verification };
  }

  /**
   * 摘要恒等式（方案 §4.5）：`N = P + F + U + B`，四类互斥。
   *  - P 独立复验通过；F 未通过（含 PARTIAL）；U 未验证（未跑/证据不足）；B 其他阻塞（蓝图冲突/受阻）。
   * 任何未知终态一律计入 B，**不得**为了凑等式丢掉条目。
   */
  function summaryFormulaOf(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let p = 0; let f = 0; let u = 0; let b = 0; let unknown = 0;
    for (const r of list) {
      const s = finalStatusOf(r);
      if (s === 'ISSUE_VERIFIED') p += 1;
      else if (s === 'UNRESOLVED' || s === 'PARTIAL') f += 1;
      else if (s === 'AWAITING_SEMANTIC') u += 1;
      else if (s === 'CANON_CONFLICT') b += 1;
      // 未知/空终态单独计数：不能把它悄悄并进 B 来让等式永远成立。
      else unknown += 1;
    }
    return {
      total: list.length, pass: p, fail: f, unverified: u, blocked: b, unknown,
      balanced: p + f + u + b + unknown === list.length && unknown === 0,
      covered: p + f + u + b + unknown,
    };
  }

  /**
   * 四阶段（方案 §4.1）：审稿清单 → 生成修稿 → 逐项验收 → 审阅与合并。
   * 阶段只表达"现在在哪一步"，不是成功指示器；进入第 4 阶段不等于全部通过。
   */
  function stagesOf(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const stage = textOf(input.stage) || 'AWAITING_SEMANTIC';
    const patched = Number(input.patchedCount) || 0;
    const selected = rows.length;
    const allVerified = selected > 0 && rows.every((r) => textOf(r && r.final_status) === 'ISSUE_VERIFIED');
    const coverageComplete = input.coverageComplete === true;
    const merged = ['PERSISTED_VERIFIED', 'PERSISTED_UNVERIFIED', 'PERSISTED_PARTIAL'].includes(stage);
    const st = (id, label, state) => ({ id, label, state });
    return [
      st('review', '审稿清单', selected > 0 ? 'done' : 'active'),
      st('generate', '生成修稿', patched > 0 ? 'done' : (selected > 0 ? 'active' : 'pending')),
      st('verify', '逐项验收', allVerified ? 'done' : (patched > 0 || coverageComplete ? 'active' : 'pending')),
      st('commit', '审阅与合并', merged ? 'done' : (allVerified ? 'active' : 'pending')),
    ];
  }

  /**
   * 统一**阶段梯**（§6）：把「独立复核」与「逐项验收」放进同一条梯子，而不是两个互不相干的标签。
   *
   * 为什么要合：作者看到的现状是——审稿报告顶部一个"上次独立复核 · 结果待主机校验"，
   * 工作区头部另一个"逐项验收 · 4/6"，两套词、两处位置，谁也说不清"我现在到底卡在哪一步"。
   * 合成分档之后，任何一个界面都只需要回答"第几步、什么状态、下一步是什么"。
   *
   * 判据来源（全部是既有状态，不新增推断）：
   *   · 独立复核那一步来自审计 run 的状态机（RESULT_RECEIVED 与 HOST_VERIFIED 必须分开显示）；
   *   · 逐项验收那一步来自终审的 stage（AWAITING_SEMANTIC / PARTIAL / VERIFIED）。
   *
   * @param {{audit?:{kind?:string,status?:string}|null, verifyStage?:string, merged?:boolean, selected?:number, patchedCount?:number}} input
   * @returns {{steps:Array<{id:string,label:string,state:string,tone:string,note:string}>, current:string, line:string}}
   */
  function stageLadderOf(input = {}) {
    const audit = input.audit && typeof input.audit === 'object' ? input.audit : null;
    const status = textOf(audit && audit.status).toUpperCase();
    const verifyStage = textOf(input.verifyStage) || 'AWAITING_SEMANTIC';
    const selected = Number(input.selected) || 0;
    const patched = Number(input.patchedCount) || 0;
    const merged = input.merged === true || ['PERSISTED_VERIFIED', 'PERSISTED_UNVERIFIED', 'PERSISTED_PARTIAL'].includes(verifyStage);

    // ② 独立复核：待主机校验 ≠ 已复核（这是两件事，必须分档）。
    const auditStep = (() => {
      if (!status) return { state: 'pending', label: '独立复核（未做 · 可选）', tone: 'muted', note: '还没跑独立复核：可选，但旧报告的结论上限是"待核验"' };
      if (['INPUT_FROZEN', 'DSH_STARTED', 'RUNNING', 'BLIND_SUBMITTED', 'COMPARE_RUNNING', 'CREATED'].includes(status)) {
        return { state: 'active', label: '独立复核（进行中）', tone: 'wait', note: '盲审→对照进行中：完成后还要过主机校验' };
      }
      if (status === 'RESULT_RECEIVED') {
        return { state: 'active', label: '独立复核（结果待主机校验）', tone: 'wait', note: '结果已收到但**未**通过主机校验：还不能作为完整凭据，也不能据此合并' };
      }
      if (['HOST_VERIFIED', 'MERGED', 'COMPLETED'].includes(status)) {
        return { state: 'done', label: '独立复核（已复核）', tone: 'ok', note: '已通过主机校验：结论可用' };
      }
      return { state: 'blocked', label: '独立复核（未通过）', tone: 'bad', note: '审计失败或未结构化提交：结论不可用，需重跑' };
    })();

    // ③ 修稿候选 / ④ 逐项验收
    const candidateState = patched > 0 ? 'done' : (selected > 0 || status ? 'active' : 'pending');
    const verifyStep = (() => {
      if (['VERIFIED_CANDIDATE', 'PERSISTED_VERIFIED'].includes(verifyStage)) {
        return { state: 'done', label: '逐项验收（全部通过）', tone: 'ok', note: '每一条都已逐项验证' };
      }
      if (['PARTIAL_CANDIDATE', 'PERSISTED_PARTIAL'].includes(verifyStage)) {
        return { state: 'active', label: '逐项验收（存在未通过项）', tone: 'warn', note: '已跑复验但还有未通过项：可定向复修或带标签合并' };
      }
      if (['PERSISTED_UNVERIFIED', 'BLOCKED', 'NEEDS_SCOPE'].includes(verifyStage)) {
        return { state: 'blocked', label: '逐项验收（未完成）', tone: 'bad', note: '候选已入库但**没有**完整验收结论：不能显示"已完成"' };
      }
      return { state: patched > 0 ? 'active' : 'pending', label: '逐项验收（待复验）', tone: 'wait', note: '还没有逐条结论：补丁已应用 ≠ 验收通过' };
    })();

    const steps = [
      { id: 'review', label: '审稿与选择', state: selected > 0 ? 'done' : 'active', tone: selected > 0 ? 'ok' : 'wait', note: selected > 0 ? `已选 ${selected} 条` : '先勾选要处理的问题' },
      { id: 'audit', ...auditStep },
      { id: 'candidate', label: '生成修稿候选', state: candidateState, tone: candidateState === 'done' ? 'ok' : 'wait', note: patched > 0 ? `已应用 ${patched} 处` : '还没有候选稿' },
      { id: 'verify', ...verifyStep },
      { id: 'commit', label: merged ? '已合并到正文' : '审阅与合并', state: merged ? 'done' : (verifyStep.state === 'done' || verifyStep.state === 'active' ? 'active' : 'pending'), tone: merged ? 'ok' : 'muted', note: merged ? '正文已是这一版' : '合并前会核对基线（正文变过会先要你确认）' },
    ];
    // "当前步骤" = 第一个**正在发生或卡住**的；没有就退到第一个未完成的（跳过"可选且未做"的独立复核）。
    // 为什么不能简单取"第一个非 done"：没跑独立复核时那一步永远是 pending，
    // 于是作者明明在逐项验收，梯子却指向"独立复核未做"——那是在指错路。
    const stuck = steps.find((x) => x.state === 'active' || x.state === 'blocked');
    const todo = steps.find((x) => x.state !== 'done' && x.state !== 'pending');
    const current = (stuck || todo || steps[steps.length - 1]).id;
    const line = steps.map((x) => `${x.state === 'done' ? '✓' : (x.state === 'active' ? '▶' : (x.state === 'blocked' ? '✗' : '·'))} ${x.label}`).join('  →  ');
    return { steps, current, line };
  }

  /**
   * 写作台单行入口（方案 §3.1）。四种真实状态各一句话，**绝不在**未复验时写"完成"。
   * @returns {{tone:string, text:string, action:string}|null} null = 没有相关任务，不显示
   */
  function entryLineOf(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const selected = Number(input.selected) || rows.length;
    if (!selected) return null;
    const c = countsOf(rows);
    if (input.running === true) {
      const round = Math.max(1, Number(input.runningRound) || 1);
      return { tone: 'wait', text: `审稿与修稿 · 正在复验第 ${round} 轮`, action: '查看' };
    }
    if (Number(input.semanticRuns) === 0 && Number(input.patchedCount) > 0) {
      return { tone: 'wait', text: '修稿已生成 · 尚未语义复验', action: '查看' };
    }
    if (c.verified === selected) {
      return { tone: 'ok', text: '修稿验收 · 已选项全部通过（尚未合并）', action: '查看差异' };
    }
    const pending = c.pending + c.unresolved + c.partial + c.canon;
    return { tone: pending ? 'warn' : 'muted', text: `修稿验收 · ${pending}/${selected} 待处理`, action: '查看' };
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
    // 独立复核给出的**子条件**（§5）按 issue_id 并进工作区行。
    // 为什么不各自渲染一套：闭环自己的 condition_results 与审计的 acceptance_checks
    // 说的是同一件事（"这条还差哪个判据"），两套各画一遍，作者要对照两份清单才知道差什么。
    const auditByIssue = new Map();
    for (const a of (Array.isArray(input.auditChecks) ? input.auditChecks : [])) {
      const id = textOf(a && a.issue_id);
      if (!id) continue;
      const checks = Array.isArray(a && a.acceptance_checks) ? a.acceptance_checks : [];
      if (!checks.length) continue;
      auditByIssue.set(id, {
        checks: checks.map((c) => ({
          key: textOf(c && c.key),
          kind: textOf(c && c.kind) || 'soft',
          status: textOf(c && c.status).toUpperCase() || 'UNKNOWN',
          evidence: textOf(c && c.evidence),
        })).filter((c) => c.key),
        verdict: textOf(a && (a.verdict || a.final)),
        verdict_declared: textOf(a && a.verdict_declared),
        verdict_derived: a && a.verdict_derived === true,
      });
    }
    return rows.map((r, i) => {
      const st = statusOf(r.final_status);
      // 「改错位置」不是"没通过"的同义词：作者需要一眼看出补丁打偏了，而不是以为没修。
      const target = textOf(r.target_verdict);
      const stShown = (target === 'WRONG_TARGET' && textOf(r.final_status) === 'UNRESOLVED')
        ? { text: '改错位置（未通过）', tone: 'bad' }
        : st;
      const id = textOf(r.issue_id);
      const dims = dimensionsOf(r);
      return {
        index: i + 1,
        issue_id: id,
        // 显示编号沿用审稿报告的原始序号（稳定编号），不按当前顺序重新编号。
        ordinal: /^\d+$/.test(id) ? String(Number(id)) : String(i + 1),
        title: textOf(r.title) || `问题 ${id}`,
        status: r.final_status,
        status_text: stShown.text,
        tone: stShown.tone,
        target_verdict: target,
        target_text: TARGET_LABEL[target] || '',
        reason_code: textOf(r.reason_code),
        reason: textOf(r.reason),
        // 详情抽屉需要的字段必须原样透传：列表投影曾把它们裁掉，导致抽屉里
        // 「检查项 / 词条归因 / 跨片证据 / 下一步」永远为空。
        checks: Array.isArray(r.checks) ? r.checks : [],
        canon: r.canon && typeof r.canon === 'object' ? r.canon : null,
        cross_segment: r.cross_segment && typeof r.cross_segment === 'object' ? r.cross_segment : null,
        repair_hint: textOf(r.repair_hint),
        evidence_count: Number(r.evidence_count) || 0,
        patch_count: Number(r.patch_count) || 0,
        // 三维状态：列表只显示主状态（验证态），详情抽屉展示完整三维。
        dimensions: dims,
        dimensions_text: `${dims.authorization.text}｜${dims.operation.text}｜${dims.verification.text}`,
        // "需作者决定"= 蓝图冲突、需要补范围、外部资料待核验；都不是系统能自己修的。
        needs_author: r.final_status === 'CANON_CONFLICT'
          || ['NEEDS_SCOPE', 'AUTHORIZATION_MISSING', 'PROTECTED_SPAN', 'CANON_CONFLICT',
            'EXTERNAL_CONTEXT_REQUIRED', 'NOT_APPLICABLE_WITH_EVIDENCE', 'NEEDS_AUTHOR_APPROVAL'].includes(textOf(r.reason_code)),
        // 2026-10-21（六项审稿漏修）：作者要能看出"这条还差哪一个子条件"以及
        // "这条是不是根本不该由正文修稿器处理（角色卡/词条/时点）"。
        // 注意：SKIP 不是 PASS；外部待核验也**不计入通过**。
        condition_results: Array.isArray(r.condition_results) ? r.condition_results.map((c) => ({
          id: textOf(c && c.id),
          kind: textOf(c && c.kind),
          severity: textOf(c && c.severity),
          status: textOf(c && c.status),
          code: textOf(c && c.code),
          evidence: Array.isArray(c && c.evidence) ? c.evidence.map(textOf) : [],
        })) : [],
        unresolved_conditions: Array.isArray(r.unresolved_conditions) ? r.unresolved_conditions.map(textOf) : [],
        external_context: r.external_context && typeof r.external_context === 'object' ? {
          required: r.external_context.required === true,
          resolved: r.external_context.resolved === true,
          code: textOf(r.external_context.code),
          source: textOf(r.external_context.source),
          evidence: Array.isArray(r.external_context.evidence) ? r.external_context.evidence.map(textOf) : [],
        } : null,
        matched_by: textOf(r.matched_by),
        // 审计子条件（没有就是空：不接受"没跑审计"被画成"全部通过"）。
        audit_checks: (auditByIssue.get(id) || {}).checks || [],
        audit_verdict: (auditByIssue.get(id) || {}).verdict || '',
        audit_verdict_declared: (auditByIssue.get(id) || {}).verdict_declared || '',
        audit_verdict_derived: Boolean((auditByIssue.get(id) || {}).verdict_derived),
      };
    });
  }

  /**
   * 「候选与正式正文的版本关系」（§6）。
   *
   * 为什么必须说出来：差异预览里的候选是**几分钟前**的整章重写，而正文可能已经被编辑/自动保存推进过。
   * 旧界面两处（候选与正文）都看不出"它们是不是同一版"，作者点合并前无从判断会不会盖掉自己刚写的。
   * 这里只做陈述，不替作者决定：普通合并会在基线不一致时停下来要他确认（见 mergeReviewDiff）。
   *
   * @param {{merged?:boolean, previewBaseUpdatedAt?:string, chapterUpdatedAt?:string}} input
   * @returns {string} 空串 = 没有可比较的版本信息（不猜）
   */
  function versionLineOf(input = {}) {
    if (input.merged === true) return '正文：这份候选已经合并进正文（上面看到的就是正文那一版）';
    const base = textOf(input.previewBaseUpdatedAt);
    const cur = textOf(input.chapterUpdatedAt);
    if (!base || !cur) return '';
    if (base === cur) return '正文：与打开预览时同一版（合并会直接写入）';
    return '正文：在打开预览之后更新过（合并前会先让你确认是否覆盖那一版）';
  }

  /** 子条件/外部资料的一段人话摘要（详情抽屉与回执用；没有就不出现）。 */
  function conditionLineOf(row) {
    const r = row && typeof row === 'object' ? row : {};
    const parts = [];
    const ext = r.external_context;
    if (ext && ext.required) {
      parts.push(ext.resolved
        ? `外部资料：已核对（${ext.code || 'NOT_APPLICABLE_WITH_EVIDENCE'}）——不是正文补丁，交作者裁决`
        : '外部资料：待核验（角色卡/词条/时点），不能靠改正文凑');
    }
    const conds = Array.isArray(r.condition_results) ? r.condition_results : [];
    const failed = conds.filter((c) => textOf(c && c.status) === 'FAIL');
    const skipped = conds.filter((c) => textOf(c && c.status) === 'SKIP');
    if (failed.length) {
      parts.push(`未达成子条件 ${failed.length} 条：${failed.map((c) => `${c.id || c.kind}`).join('、')}`);
    }
    if (skipped.length) parts.push(`未求值子条件 ${skipped.length} 条（跳过 ≠ 通过）`);
    // 独立复核的子条件（§5）：与上面那套并列显示，并说明"模型原判被降级"。
    const ac = Array.isArray(r.audit_checks) ? r.audit_checks : [];
    if (ac.length) {
      const pass = ac.filter((c) => textOf(c && c.status) === 'PASS').length;
      const bad = ac.filter((c) => textOf(c && c.status) !== 'PASS');
      parts.push(`审计子条件 ${pass}/${ac.length} 通过`
        + (bad.length ? `（未达成：${bad.map((c) => textOf(c && c.key)).join('、')}）` : ''));
      if (r.audit_verdict_derived && r.audit_verdict_declared && r.audit_verdict_declared !== r.audit_verdict) {
        parts.push(`审计原判 ${r.audit_verdict_declared}，按子条件降为 ${r.audit_verdict}`);
      }
    }
    return parts.join('；');
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

  /**
   * 证据命中段落：把"当前这条问题的逐字引文"映射回差异块。
   *
   * 为什么要单独一个函数（2026-10-21 作者报「切相关段落和点问题都没反应」）：
   *   旧实现里「相关段落」直接落到 `changedBlocks`，与「差异」逐字相同 —— 切了等于没切；
   *   而点左侧问题时中间对照区完全不参考当前问题，只有左栏高亮会变。
   *   两件事其实是同一份判据（"这条问题的证据落在哪几段"），所以放在这里一处算完，
   *   视图筛选与点击定位共用，避免两处各算一套、各说一套。
   *
   * 命中不到就返回空数组：界面必须如实降级成"改过的段 + 一句说明"，
   * 不能拿"改过的段"冒充"相关段落"（那正是作者以为切换失效的原因之一）。
   */
  function hitIndexesOf(blocks, quotes) {
    const list = Array.isArray(blocks) ? blocks : [];
    const qs = (Array.isArray(quotes) ? quotes : []).map((q) => textOf(q).trim()).filter(Boolean);
    if (!qs.length) return [];
    const out = [];
    for (const b of list) {
      const hay = `${textOf(b && b.before)}\n${textOf(b && b.after)}`;
      if (qs.some((q) => hay.includes(q))) out.push(b.index);
    }
    return out;
  }

  /**
   * 该显示哪些块：
   *   - `full`    全文（含未改动的段）；
   *   - `context` 只给当前问题证据命中的段落（命中不到 → 如实回落成改过的段）；
   *   - `diff`    改过的段。
   * `opts.hitIndexes` 由 `hitIndexesOf()` 算好传进来，本函数不自己判断"什么是证据"。
   */
  function visibleBlocks(blocks, mode, opts = {}) {
    const list = Array.isArray(blocks) ? blocks : [];
    const m = textOf(mode);
    if (m === 'full') return list;
    if (m === 'context') {
      const hits = Array.isArray(opts.hitIndexes) ? opts.hitIndexes : [];
      const picked = list.filter((b) => hits.includes(b.index));
      if (picked.length) return picked;
    }
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
      pushArchive(out, input);
      return out;
    }
    // 2026-10-18：跳过复验就合并的那一档，**不能是死路** —— 作者要能再点一次复验（反悔机会），
    // 也要能从历史版本回到任何一份存档。所以这里给"补跑复验 + 存档入口 + 返回"，不给合并。
    // 2026-10-22：部分合并（PERSISTED_PARTIAL）走同一条自救通道——它同样允许补验一次、可回退。
    if (stage === 'PERSISTED_UNVERIFIED' || stage === 'PERSISTED_PARTIAL') {
      const partialMerged = stage === 'PERSISTED_PARTIAL';
      // 2026-10-21 修：原来这里用 `semanticRuns >= 1` 判禁用，于是"合并前跑过一次但零结论"的稿子
      // 合并后**再也补验不了**，与下面 runRevisionSemanticVerify 的 postMergeRetry 口径相反
      // （动作允许、按钮禁用 = 入口形同虚设）。现在只认"合并后已经补验过"这一件事。
      const retriedAfterMerge = input.reverifiedAfterMerge === true;
      out.push({
        action: 'semantic-verify',
        label: busy ? '正在复验…（请勿关闭）' : '对已合并的候选运行语义复验（一次付费调用）',
        primary: true,
        disabled: busy || retriedAfterMerge,
        help: 'review_semantic_verify',
        note: retriedAfterMerge
          ? '这份候选合并后已经补验过一次；要再验请重新发起审稿修稿'
          : (partialMerged
            ? '合并时它仍有未通过项：补跑一次复验可以拿到"合并后"的逐条结论'
            : '合并已完成，但逐条结论还没有：补跑一次就知道哪几条真修好了'),
      });
      pushArchive(out, input);
      out.push({
        action: 'back', label: '返回写作台', primary: true,
        note: partialMerged ? '已合并到正文；其中仍有未通过项（已知遗留，不是全修好）' : '已合并到正文；本次没有跑语义复验',
      });
      if (busy) for (const a of out) a.disabled = true;
      return out;
    }
    if (stage === 'AWAITING_SEMANTIC') {
      // 复验额度是一次性的（同一份候选不重复付费），但**没有结论 ≠ 验过**：
      // 额度用完了必须还有一条作者能自己拍板的路，否则就是死锁。
      const exhausted = semanticRuns >= 1;
      out.push({
        action: 'semantic-verify',
        label: busy ? '正在复验…（请勿关闭）' : '运行独立语义复验（一次付费调用）',
        primary: true,
        disabled: busy || exhausted,
        help: 'review_semantic_verify',
        note: exhausted
          ? '这次复验没有得出逐条结论（额度已用过）：要结论就重新审稿再验，要落稿就用下面的作者确认合并'
          : '未复验的条目不算通过',
      });
      // 2026-10-21 作者报「AI 都跑完了，没有验收按钮和合并按钮」，实测根因就是这里：
      // 旧条件 `semanticRuns < 1` 会在"验过一次但零结论"时把**唯一的出口**一起收走，
      // 界面只剩导出/返回。没有结论与没验过等价，所以作者确认合并必须一直可用；
      // 后果文案仍只有一处（forcedMergeWarning），不虚报"通过"。
      if (!busy) {
        out.push({
          action: 'merge-forced',
          label: exhausted ? '作者确认：跳过复验直接合并' : '跳过复验直接合并',
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
      const repair = input.repair && typeof input.repair === 'object' ? input.repair : null;
      const left = input.leftovers && typeof input.leftovers === 'object' ? input.leftovers : null;
      // 2026-10-22 作者报「未通过的两条既不能 AI 再修、也改不了」：这一档原来只有合并/导出/返回，
      // 而统一出口给出的下一步恰恰是 TARGETED_REPAIR —— 承诺了下一步却没有入口。
      // 复修的判据（目标/轮次/预算）全部来自 revision-closure，这里只翻译成按钮，不另算一套。
      const targets = repair && Array.isArray(repair.targets) ? repair.targets : [];
      const blockedList = repair && Array.isArray(repair.blocked) ? repair.blocked : [];
      if (repair && repair.ok && targets.length) {
        const roundsLeft = Number(repair.roundsLeft);
        const budgetLeft = Number(repair.budgetLeftCents);
        const estimate = Number(repair.estimateCents);
        const noRounds = Number.isFinite(roundsLeft) && roundsLeft <= 0;
        const noBudget = Number.isFinite(budgetLeft) && Number.isFinite(estimate) && estimate > budgetLeft;
        const why = noRounds ? '本轮复修轮次已用尽' : (noBudget ? `预估 ${formatCents(estimate)} 超出剩余 ${formatCents(budgetLeft)}` : '');
        out.push({
          action: 'repair-partial',
          label: `只复修未通过项（${targets.length} 条，一次付费调用）`,
          primary: true,
          disabled: busy || noRounds || noBudget,
          help: 'review_repair_partial',
          note: why || '按复验结论只重写这几处；仍受原授权跨度、保护区与组合门禁约束',
        });
        const widening = repair.widening && typeof repair.widening === 'object' ? repair.widening : null;
        if (widening && widening.any) {
          const byAuthor = Number(widening.paragraphs) > 0;
          out.push({
            action: 'repair-partial-widened',
            label: byAuthor
              ? `按已批准范围再修（${Number(widening.paragraphs)} 段）`
              : '按复验剩余证据扩范围再修',
            primary: false,
            disabled: busy || noRounds || noBudget,
            help: 'review_repair_widened',
            note: byAuthor
              ? '用你刚刚点"允许改"的段落作为本次可改目标（同一批问题，不新增问题编号）'
              : '模型上一轮说"这些文字还在"：把它们一并纳入本次可改范围',
          });
        }
      } else {
        // 没有可修目标时不能只留一个灰按钮：把"为什么不能修"写出来（硬阻塞项要人处理）。
        const reason = repair && repair.reason ? String(repair.reason) : 'NO_TARGETS';
        const why = {
          ROUND_LIMIT: '本次运行的复修轮次已用尽（不无限重试）',
          BUDGET_EXCEEDED: '剩余预算不够再修一轮',
          COST_UNKNOWN: '费用无法可靠核价（不拿"大概不到 2 元"当授权）',
          NO_PLAN: '这次运行是从本地记录恢复的：没有可用的授权跨度，请重新发起修稿',
          MERGED: '已经合并到正文：候选与正文是同一份，要继续修请重新审稿（不要直接改库里的正文）',
          NO_TARGETS: blockedList.length
            ? `${blockedList.length} 条属于人处理项（蓝图冲突/保护区/授权外），自动复修不得碰`
            : '没有可自动复修的条目',
        }[reason] || reason;
        out.push({
          action: 'repair-partial',
          label: '只复修未通过项（当前不可用）',
          primary: false,
          disabled: true,
          help: 'review_repair_partial',
          note: why,
        });
      }
      // C1：把"我知道它没修"变成可审计的决定，而不是每次审稿再被报一遍。
      if (left && Array.isArray(left.pending) && left.pending.length) {
        out.push({
          action: 'accept-leftovers',
          label: `接受 ${left.pending.length} 条为已知遗留`,
          primary: false,
          help: 'review_accept_leftovers',
          note: '不改正文、不判通过：只把这批编号记进运行记录与本机台账，合并时如实带出',
        });
      }
      out.push({
        action: 'merge-partial', label: `合并到正文（仍有 ${remain} 条未通过）`, primary: false,
        note: '部分合并必须明确知道剩余未通过项；不宣称全部修好',
      });
    }
    pushArchive(out, input);
    out.push({ action: 'export', label: '导出待处理清单', primary: false, note: '只导出编号/原因码/理由，不含正文' });
    out.push({ action: 'back', label: '返回写作台（保留候选）', primary: false, note: '关闭工作区不删候选、不写库' });
    // 复验在跑：其余动作一律置灰（复验结果落地前，任何"下一步"都是在读旧状态）。
    // 想中断请用右下角进度卡上的「停止」——那条通道不经过工作区。
    if (busy) for (const a of out) a.disabled = true;
    return out;
  }

  /** 存档入口：有存档才给（没有就给一个点了也没东西的按钮，等于骗人）。 */
  function pushArchive(out, input = {}) {
    const n = Number(input.archiveCount) || 0;
    if (!(n > 0)) return out;
    out.push({
      action: 'archive',
      label: `修稿存档 ${n} 份 · 查看/回退`,
      primary: false,
      note: '审稿前原文 / 未复验候选 / 已复验候选都在「历史版本」里：可逐条查看，也可恢复任意一份',
    });
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
      // 复验跑过但没有一条结论：不能再说"尚未语义复验"（那是没跑过的措辞），也不能说通过。
      if (Number(input.semanticRuns) >= 1) {
        return `${c.pending} 条没有结论（这次复验没给出逐条判定，不算修好也不算失败）：`
          + '要结论就重新审稿再验；要落稿请用「作者确认：跳过复验直接合并」，合并档位会如实写"未做语义复验"';
      }
      return `${c.pending} 条尚未语义复验：现在既不能算修好，也不该直接合并`;
    }
    if (stage === 'PARTIAL_CANDIDATE') {
      const ids = rows.filter((r) => r.final_status !== 'ISSUE_VERIFIED').map((r) => `#${r.issue_id}`).join('、');
      const repair = input.repair && typeof input.repair === 'object' ? input.repair : null;
      const n = repair && Array.isArray(repair.targets) ? repair.targets.length : 0;
      const left = input.leftovers && typeof input.leftovers === 'object' ? input.leftovers : null;
      const accepted = left && Array.isArray(left.ids) ? left.ids.filter((id) => !(left.pending || []).includes(id)) : [];
      // 只报"哪几条没过"不够：作者下一个问题必然是"那我现在点哪个"。
      const next = n > 0
        ? `；可「只复修未通过项」再修 ${n} 条（一次付费调用）`
        : '；这几条需要人工处理或放宽授权范围（自动复修不得碰）';
      const acceptedNote = accepted.length ? `；其中 ${accepted.length} 条已记为已知遗留` : '';
      return `未通过：${ids}（这些条目仍有问题，不能宣称"全部修好"）${next}${acceptedNote}`;
    }
    if (stage === 'VERIFIED_CANDIDATE') return '全部已选问题通过语义验收；候选尚未合并到正文';
    if (stage === 'PERSISTED_VERIFIED') return '已入库并复核';
    // 跳过复验就合并的那条路：正文已经写进去了，但"哪几条真修好"是未知的 —— 说出来，别让人以为验过。
    // 同时说清"还能自救"：可以补跑复验，也可以从历史版本回到任意一份存档。
    if (stage === 'PERSISTED_UNVERIFIED') {
      return '已合并到正文（本次跳过语义复验）：哪些问题真的解决了没有结论；可以补跑一次复验，'
        + '也能在「历史版本」/ 修稿存档里恢复到审稿前原文或另一份候选';
    }
    if (stage === 'PERSISTED_PARTIAL') {
      const ids = rows.filter((r) => r.final_status !== 'ISSUE_VERIFIED').map((r) => `#${r.issue_id}`).join('、');
      return `已合并到正文，但仍有未通过项（${ids || '见覆盖表'}）：正文里带着这些已知问题；`
        + '重新审稿（只勾这几条）可以继续修，或在「历史版本」里回退';
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
    dimensionsOf,
    summaryFormulaOf,
    stagesOf,
    entryLineOf,
    summaryLine,
    issueRowsOf,
    conditionLineOf,
    versionLineOf,
    stageLadderOf,
    filterRows,
    stepIssue,
    locateQuote,
    evidenceOf,
    diffBlocks,
    changedBlocks,
    diffSummary,
    hitIndexesOf,
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
