/**
 * harness-plugins/novel-writing/capabilities.mjs —— S09：小说工具的**机器可检查能力表**（修 F11）。
 *
 * 为什么需要它：工具是"模型能主动调用的执行器"。在它之前，权限只存在于
 * 服务端各端点各自的判断里 —— 模型侧看不到边界，测试也没法枚举"哪些工具会改状态"。
 * 本文件是**唯一事实来源**：每个工具属于哪一类、是否需要作者审批、能否被模型调用。
 *
 * 三类能力（S09 动作 1）：
 *   · READ_ONLY     —— 只读，模型可随时调用；
 *   · PROPOSAL      —— 只产出**候选/草稿**，不推进正式状态，模型可调用；
 *   · AUTHOR_CONFIRM—— 会改**正式状态**，必须带作者在界面生成的一次性 `approval_id`。
 *
 * 关键纪律（S09 动作 2/5）：
 *   · **失败关闭**：表里没有的工具名一律拒绝（`UNKNOWN_TOOL`），不猜、不默认放行；
 *   · 审批 id 只能来自作者通道，插件**不得**自行生成或缓存；
 *   · 工具请求必须绑定 task/work/revision：`work_id` 与绑定的作品不一致即拒绝，
 *     防止"伪造工作 ID"或"用 A 作品的上下文改 B 作品"。
 *
 * 本文件不 import 任何运行时模块（纯数据 + 纯函数），因此可以同时被插件与离线测试使用。
 */

export const CAPABILITY = Object.freeze({
  READ_ONLY: 'read_only',
  PROPOSAL: 'proposal',
  AUTHOR_CONFIRM: 'author_confirm',
});

export const CAPABILITY_VALUES = Object.freeze([
  CAPABILITY.READ_ONLY,
  CAPABILITY.PROPOSAL,
  CAPABILITY.AUTHOR_CONFIRM,
]);

/** 需要作者审批的 op（与服务端 author_approvals.op 对齐）。 */
export const APPROVAL_OP = Object.freeze({
  chapter_save: 'chapter_save',
  state_commit: 'state_proposal_apply',
  proposal_apply: 'proposal_apply',
  state_rollback: 'state_rollback',
});

/**
 * 能力表。**逐条对应 novel-tools.mjs 里真实注册的工具**，
 * 分类依据是"它实际做什么"（是否写库、写的是候选还是正式状态），不是名字听起来像什么。
 */
export const TOOL_CAPABILITIES = Object.freeze({
  // ── 只读（含"POST 但只做分析、不落正式状态"的查询类） ──────────────────────
  novel_works: CAPABILITY.READ_ONLY,
  novel_context: CAPABILITY.READ_ONLY,
  novel_lookup: CAPABILITY.READ_ONLY,
  novel_foreshadows: CAPABILITY.READ_ONLY,
  novel_events: CAPABILITY.READ_ONLY,
  novel_state: CAPABILITY.READ_ONLY,
  novel_approvals: CAPABILITY.READ_ONLY,        // 只列出作者已创建的审批；不得代作者创建
  // v1.2.1 质量闭环：只读"这一章修稿到底修好了几条"；不触发复修、不改正文、不需要审批。
  novel_revision_status: CAPABILITY.READ_ONLY,
  novel_library: CAPABILITY.READ_ONLY,
  novel_memory_read: CAPABILITY.READ_ONLY,
  novel_style_contract: CAPABILITY.READ_ONLY,
  novel_consistency: CAPABILITY.READ_ONLY,      // POST 传参，但只读分析
  novel_scan: CAPABILITY.READ_ONLY,
  novel_preflight: CAPABILITY.READ_ONLY,
  novel_validate: CAPABILITY.READ_ONLY,
  novel_review: CAPABILITY.READ_ONLY,           // 产出审稿结论，不改正式状态

  // ── 提案（写候选/草稿/记录，不推进正式状态） ──────────────────────────────
  novel_event_add: CAPABILITY.PROPOSAL,
  novel_foreshadow_update: CAPABILITY.PROPOSAL,
  novel_memory_update: CAPABILITY.PROPOSAL,
  novel_blueprint: CAPABILITY.PROPOSAL,
  novel_contract: CAPABILITY.PROPOSAL,
  novel_state_propose: CAPABILITY.PROPOSAL,
  novel_branch: CAPABILITY.PROPOSAL,

  // ── 作者确认（改正式状态，必须带 approval_id） ────────────────────────────
  novel_chapter_save: CAPABILITY.AUTHOR_CONFIRM,
  novel_state_commit: CAPABILITY.AUTHOR_CONFIRM,
  novel_snapshot: CAPABILITY.AUTHOR_CONFIRM,
  novel_write_pipeline: CAPABILITY.AUTHOR_CONFIRM,
});

/** 工具 → 需要的审批 op（只有 AUTHOR_CONFIRM 才有）。 */
export const TOOL_APPROVAL_OPS = Object.freeze({
  novel_chapter_save: APPROVAL_OP.chapter_save,
  novel_state_commit: APPROVAL_OP.state_commit,
  novel_snapshot: APPROVAL_OP.state_rollback,
  novel_write_pipeline: APPROVAL_OP.proposal_apply,
});

/**
 * **按 action 细化**的能力覆盖表。
 *
 * 为什么必须有它：能力不是纯按工具划分的 —— 同一个工具可以既是只读又是写入。
 *   · `novel_state_commit` 缺省 action 是 `review`（**只读**看提案），只有 `apply` 才推进正式状态；
 *   · `novel_snapshot` 缺省 action 是 `create`（**非破坏**地留一份快照），只有 `rollback` 才改状态。
 * 若一刀切把整个工具判成 author_confirm，就会把"只读审阅"和"留快照"也挡在审批后面 ——
 * 那是**误伤**，不是收紧（实测：会让 write-boundary 的三条断言失败）。
 *
 * 未列出的 action → 回落到工具的**基础能力**（保守），因此新增 action 不会自动绕过审批。
 */
export const ACTION_CAPABILITY_OVERRIDES = Object.freeze({
  novel_state_commit: Object.freeze({
    '': CAPABILITY.READ_ONLY,        // 缺省 = review（只读）
    review: CAPABILITY.READ_ONLY,
    reject: CAPABILITY.PROPOSAL,     // 拒绝提案：不推进正式状态
    apply: CAPABILITY.AUTHOR_CONFIRM,
  }),
  novel_snapshot: Object.freeze({
    '': CAPABILITY.PROPOSAL,         // 缺省 = create（留快照，非破坏）
    create: CAPABILITY.PROPOSAL,
    rollback: CAPABILITY.AUTHOR_CONFIRM,
  }),
  novel_write_pipeline: Object.freeze({
    '': CAPABILITY.PROPOSAL,         // 缺省 = 只产稿/提案
    propose: CAPABILITY.PROPOSAL,
    commit: CAPABILITY.AUTHOR_CONFIRM,
  }),
});

/** 取能力；表里没有 → null（调用方必须按失败关闭处理）。 */
export function capabilityOf(toolName) {
  const n = String(toolName == null ? '' : toolName).trim();
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITIES, n) ? TOOL_CAPABILITIES[n] : null;
}

/**
 * 结合 `action` 求本次调用的**有效能力**。
 * 未知工具 → null；已知工具但 action 未在覆盖表里 → 回落到基础能力（保守）。
 */
export function effectiveCapability(toolName, args = {}) {
  const base = capabilityOf(toolName);
  if (base === null) return null;
  const n = String(toolName == null ? '' : toolName).trim();
  const overrides = Object.prototype.hasOwnProperty.call(ACTION_CAPABILITY_OVERRIDES, n)
    ? ACTION_CAPABILITY_OVERRIDES[n]
    : null;
  if (!overrides) return base;
  const hasAction = args && args.action !== undefined && args.action !== null && String(args.action).trim() !== '';
  const raw = hasAction ? String(args.action).trim() : '';
  // ⚠️ 只有**空 action** 才允许用 '' 的登记值（"缺省行为"）；
  // 非空但**未登记**的 action 一律回落到工具的**基础能力**（保守）。
  // 否则 `action: 'apply;drop'` 这种畸形输入会被当成"缺省只读"，等于给出一个绕过口。
  if (hasAction && !Object.prototype.hasOwnProperty.call(overrides, raw)) return base;
  const eff = overrides[raw];
  return eff === undefined ? base : eff;
}


export function isKnownTool(toolName) {
  return capabilityOf(toolName) !== null;
}

/** 是否改正式状态（需要作者审批）。未知工具**不当成**可调用。 */
export function requiresAuthorApproval(toolName) {
  return capabilityOf(toolName) === CAPABILITY.AUTHOR_CONFIRM;
}

/** 审批 op（未知工具返回 null）。 */
export function approvalOpOf(toolName) {
  const n = String(toolName == null ? '' : toolName).trim();
  return Object.prototype.hasOwnProperty.call(TOOL_APPROVAL_OPS, n) ? TOOL_APPROVAL_OPS[n] : null;
}

/** 统一拒绝结果（所有拒绝都带机器可读 code，便于测试与前端提示）。 */
export function deny(code, detail = '') {
  return { ok: false, code, detail };
}

export function allow(extra = {}) {
  return { ok: true, code: 'ALLOWED', detail: '', ...extra };
}

/**
 * 模型侧调用判定：这是**唯一入口**，插件里所有工具执行前都要过它。
 *
 * @param toolName 工具名
 * @param approvalId 若该工具需要审批，这里必须是作者通道给的一次性 id
 * @param args 工具入参（用于取 work_id 做绑定校验）
 * @param scope { workId, taskId, revisionId } —— 本次会话被绑定到的上下文
 */
export function assertModelCallable(toolName, { approvalId = '', args = {}, scope = {} } = {}) {
  const cap = capabilityOf(toolName);
  // ① 失败关闭：未知工具一律拒绝（隐藏工具名之后也拿不到执行器）
  if (cap === null) return deny('UNKNOWN_TOOL', `工具 ${toolName} 不在能力表里（失败关闭）`);

  // ② 跨作品：请求里的 work_id 必须与绑定 scope 一致
  const bound = scope && scope.workId !== undefined && scope.workId !== null ? String(scope.workId) : '';
  const requested = args && args.work_id !== undefined && args.work_id !== null ? String(args.work_id) : '';
  if (bound && requested && requested !== bound) {
    return deny('WORK_SCOPE_MISMATCH', `工具请求的 work_id=${requested} 与本次绑定 scope=${bound} 不一致`);
  }

  // ③ 有效能力要**结合 action**：同一个工具可能既是只读又是写入（见 ACTION_CAPABILITY_OVERRIDES）
  const eff = effectiveCapability(toolName, args) || cap;
  if (eff === CAPABILITY.AUTHOR_CONFIRM) {
    const id = String(approvalId == null ? '' : approvalId).trim();
    if (!id) {
      const op = approvalOpOf(toolName);
      return deny('APPROVAL_REQUIRED', `模型侧写入需要作者审批：请作者在界面确认生成一次性审批（op=${op}）后带 approval_id 重试`);
    }
  }
  return allow({ capability: eff, base_capability: cap });
}

/** 只读工具是否真的只读（供测试反向核对能力表分类是否正确）。 */
export function isReadOnly(toolName) {
  return capabilityOf(toolName) === CAPABILITY.READ_ONLY;
}

/** 能力表自检：每个 AUTHOR_CONFIRM 工具必须有审批 op。 */
export function selfCheckCapabilities() {
  const problems = [];
  for (const name of Object.keys(TOOL_CAPABILITIES)) {
    const cap = TOOL_CAPABILITIES[name];
    if (!CAPABILITY_VALUES.includes(cap)) problems.push({ tool: name, problem: `INVALID_CAPABILITY:${cap}` });
    if (cap === CAPABILITY.AUTHOR_CONFIRM && !approvalOpOf(name)) {
      problems.push({ tool: name, problem: 'AUTHOR_CONFIRM_WITHOUT_APPROVAL_OP' });
    }
    if (cap !== CAPABILITY.AUTHOR_CONFIRM && approvalOpOf(name)) {
      problems.push({ tool: name, problem: 'APPROVAL_OP_ON_NON_CONFIRM_TOOL' });
    }
  }
  for (const name of Object.keys(TOOL_APPROVAL_OPS)) {
    if (!TOOL_CAPABILITIES[name]) problems.push({ tool: name, problem: 'APPROVAL_OP_FOR_UNKNOWN_TOOL' });
  }
  return problems;
}
