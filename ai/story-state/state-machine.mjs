/**
 * 确定性故事状态内核 · 写作状态机（PHASE 4）。
 *
 * ⚠ 这一条最容易做错，所以先把纪律写清楚：
 *   **不建第二套宿主状态系统。** 宿主已经有 task/run（`/api/harness/job|run|cancel|
 *   recoverable|recovered|mark_applied` + `harness_jobs` 表）。本模块只做两件事：
 *     ① 用**纯函数**定义写作流程的 18 个相位与合法迁移（可在无宿主的情况下单元测试）；
 *     ② 把每个相位**映射回宿主状态词**（queued/running/done/failed/timeout/cancelled），
 *        使取消、恢复、轮询全部继续走宿主既有端点——插件不新增任务记录、不新增取消机制。
 *
 * 相位可以从**产物**推导（`derivePhase`），也可以由编排层显式推进（`advance(from, to)`）。
 * 两条路径共用同一张迁移表：`advance()` 在非法迁移上返回 `ok:false` 而不是抛异常，
 * 让调用方能把"流程走岔了"当成一条可上报的事件，而不是一次崩溃。
 *
 * ⚠️ 2026-10-08 订正：此处此前写的是 `nextPhase`，而**该符号从来不存在**
 * （缺点报告 P3-07 记的"注释与代码不符"之一，会误导维护者去找一个不存在的函数）。
 * 显式推进的入口就是 `advance`。
 * 另：本模块的迁移逻辑（`advance` / `derivePhase` / `hostStatusOf` / `PHASES_BY_HOST_STATUS`）
 * 目前仍是**零生产调用点**——只有 `PHASES` 词表经 server.js 下发。是否接进编排层属独立评估
 * （判定见 `docs/wiring-fix-20261008.md`），本次只订正注释，不改行为。
 */

const str = (v) => String(v || '');

/**
 * 18 个相位。词表**只增不改**（与宿主的状态词表同一条纪律）。
 * 顺序即正常流程顺序；`accepted` / `aborted` / `error` 是终态。
 */
export const PHASES = [
  'idle',              // 还没有开始
  'preflight_queued',  // 写前预检已排队
  'preflight_running', // 预检计算中
  'preflight_done',    // 预检完成（结论落库）
  'contract_ready',    // 章节契约已就位（用于装配上下文）
  'context_ready',     // 上下文已装配（assembled 就绪）
  'generating',        // 正在生成正文
  'retry_empty',       // 空回复重试（保持 reasoning effort，先抬 max_tokens）
  'generated',         // 正文已产出（尚未校验）
  'validating',        // 写后校验中
  'validation_failed', // 校验未通过（需要修复或作者决定）
  'repair_planned',    // 已产出定向修复计划
  'repaired',          // 修复后的正文已产出
  'proposal_prepared', // 状态变更提案已准备（等待复核/确认）
  'proposal_applied',  // 提案已原子应用（已落快照）
  'accepted',          // 作者确认（终态）
  'aborted',           // 主动中止 / 被取消（终态）
  'error',             // 出错（终态）
];

export const TERMINAL_PHASES = ['accepted', 'aborted', 'error'];

/** 相位 → 宿主状态词。取消/恢复/轮询因此完全复用宿主端点。 */
const HOST_STATUS = {
  idle: '',
  preflight_queued: 'queued',
  preflight_running: 'running',
  preflight_done: 'done',
  contract_ready: 'done',
  context_ready: 'running',
  generating: 'running',
  retry_empty: 'running',
  generated: 'done',
  validating: 'running',
  validation_failed: 'done',
  repair_planned: 'done',
  repaired: 'done',
  proposal_prepared: 'done',
  proposal_applied: 'done',
  accepted: 'done',
  aborted: 'cancelled',
  error: 'failed',
};

/** 宿主状态词 → 允许的相位（用于把宿主作业状态反解成相位，避免出现"宿主说 cancelled、相位说 generating"）。 */
export const PHASES_BY_HOST_STATUS = (() => {
  const out = { queued: [], running: [], done: [], failed: [], timeout: [], cancelled: [] };
  for (const p of PHASES) {
    const s = HOST_STATUS[p];
    if (s && out[s]) out[s].push(p);
  }
  return out;
})();

export function hostStatusOf(phase) {
  return HOST_STATUS[str(phase)] ?? '';
}

export function isTerminal(phase) {
  return TERMINAL_PHASES.includes(str(phase));
}

/**
 * 合法迁移表。刻意写得**窄**：允许跳步会让"预检没跑就生成"这类事故静默发生。
 * 需要跳步的场景（例如作者直接贴一段已有正文来校验）用 `allowAdopt` 显式开启，
 * 而不是放宽整张表。
 */
const TRANSITIONS = {
  idle: ['preflight_queued', 'preflight_running', 'context_ready', 'generating', 'aborted', 'error'],
  preflight_queued: ['preflight_running', 'aborted', 'error'],
  preflight_running: ['preflight_done', 'aborted', 'error'],
  preflight_done: ['contract_ready', 'context_ready', 'aborted', 'error'],
  contract_ready: ['context_ready', 'generating', 'aborted', 'error'],
  context_ready: ['generating', 'aborted', 'error'],
  generating: ['generated', 'retry_empty', 'aborted', 'error'],
  retry_empty: ['generating', 'generated', 'aborted', 'error'],
  generated: ['validating', 'proposal_prepared', 'aborted', 'error'],
  validating: ['validation_failed', 'proposal_prepared', 'generated', 'aborted', 'error'],
  validation_failed: ['repair_planned', 'proposal_prepared', 'aborted', 'error'],
  repair_planned: ['generating', 'repaired', 'aborted', 'error'],
  repaired: ['validating', 'proposal_prepared', 'aborted', 'error'],
  proposal_prepared: ['proposal_applied', 'aborted', 'error'],
  proposal_applied: ['accepted', 'aborted', 'error'],
  accepted: [],
  aborted: [],
  error: [],
};

export function canAdvance(from, to, opts = {}) {
  const a = str(from) || 'idle';
  const b = str(to);
  if (!PHASES.includes(b)) return { ok: false, reason: `未知相位 ${b}` };
  if (a === b) return { ok: true, reason: '同相位（幂等）' };
  if (TERMINAL_PHASES.includes(a)) return { ok: false, reason: `${a} 是终态，不能再迁移到 ${b}` };
  const allowed = TRANSITIONS[a] || [];
  if (allowed.includes(b)) return { ok: true, reason: '' };
  if (opts.allowAdopt === true && (b === 'generated' || b === 'validating')) {
    return { ok: true, reason: `allowAdopt：允许从 ${a} 直接进入 ${b}（作者直接提供正文的场景）` };
  }
  return { ok: false, reason: `${a} → ${b} 不是合法迁移（允许：${allowed.join('/') || '无'}）` };
}

/**
 * 推进相位。
 * @returns {{ok:boolean, phase:string, from:string, reason:string, host_status:string}}
 */
export function advance(from, to, opts = {}) {
  const verdict = canAdvance(from, to, opts);
  const fromPhase = str(from) || 'idle';
  if (!verdict.ok) {
    return { ok: false, phase: fromPhase, from: fromPhase, reason: verdict.reason, host_status: hostStatusOf(fromPhase) };
  }
  return { ok: true, phase: str(to), from: fromPhase, reason: verdict.reason, host_status: hostStatusOf(to) };
}

/**
 * 从**已有产物**推导相位。
 *
 * 为什么要有这条路径：宿主作业可能因为服务重启而丢失内存态，但产物（预检结论、契约、
 * 校验记录、提案、快照）都落库了。相位必须能从落库的产物重新算出来——
 * 否则"恢复"就只能靠再跑一遍（重复计费）。
 *
 * 优先级从"离用户最近的状态"往回想：已确认 > 已应用 > 已准备 > 已修 > 待修 >
 * 已验证/失败 > 已产出 > 生成中 > 上下文就绪 > 契约就绪 > 预检完成 …
 */
export function derivePhase(facts = {}) {
  const job = facts.job || null;
  if (job && (job.status === 'cancelled')) return 'aborted';
  if (job && job.status === 'failed') return 'error';
  if (job && job.status === 'timeout') return 'error';
  if (facts.acceptedAt) return 'accepted';
  if (facts.appliedProposalCount > 0) return 'proposal_applied';
  if (facts.pendingProposalCount > 0) return 'proposal_prepared';
  if (facts.repaired) return 'repaired';
  if (facts.repairPlan) return 'repair_planned';
  if (facts.validation && facts.validation.passed === false) return 'validation_failed';
  if (facts.validation && facts.validation.passed === true) return 'proposal_prepared';
  if (job && job.status === 'running') return facts.draft ? 'validating' : 'generating';
  if (facts.draft) return 'generated';
  if (facts.contextReady) return 'context_ready';
  if (facts.contractReady) return 'contract_ready';
  if (facts.preflight) return 'preflight_done';
  if (job && job.status === 'queued') return 'preflight_queued';
  return 'idle';
}

/** 相位的中文标签（给界面/日志用；不参与任何判定）。 */
export const PHASE_LABELS = {
  idle: '未开始',
  preflight_queued: '预检已排队',
  preflight_running: '预检计算中',
  preflight_done: '预检完成',
  contract_ready: '契约已就位',
  context_ready: '上下文已装配',
  generating: '正在生成',
  retry_empty: '空回复重试',
  generated: '正文已产出',
  validating: '校验中',
  validation_failed: '校验未通过',
  repair_planned: '已出修复计划',
  repaired: '修复稿已产出',
  proposal_prepared: '提案待确认',
  proposal_applied: '提案已应用',
  accepted: '作者已确认',
  aborted: '已中止',
  error: '出错',
};

/**
 * 一次流程的里程碑记录（纯数据，不落库）。
 * 调用方把它挂在宿主作业的 `stage` 字段上即可——**不新增任务表**。
 */
export function timelineOf(steps = []) {
  return steps.map((s) => ({ phase: str(s.phase), at: s.at || null, note: str(s.note) }));
}