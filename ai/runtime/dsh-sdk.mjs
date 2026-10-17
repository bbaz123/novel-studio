/**
 * ai/runtime/dsh-sdk.mjs —— S13：SDK 子进程、任务会话与取消。
 *
 * ── 最重要的一条事实（决定了整个设计）────────────────────────────────────────
 * 锁定基线（DSH `dsh-v0.1.7-rc.1`）的 SDK JSON-RPC 协议面**只有三个请求方法**：
 *   · `initialize`      —— params: { cwd, provider, model, reasoningEffort?, maxTokens? }
 *   · `session/prompt`  —— params: { sessionId, contentBlocks }
 *   · `shutdown`        —— params: undefined
 * 通知方向只有 `session.event` / `session.status` / `subagent.started` / `subagent.finished`。
 * **没有 `session/cancel`，也没有 `session/new`。**
 *（出处：`deepseek-harness/packages/sdk/protocol/src/types.ts` 的
 *  `HarnessSdkRequestMap` / `HarnessSdkNotificationMap`。）
 *
 * 因此本模块的两条硬纪律：
 *   ① **绝不发明上游方法**：取消不是"发一个 cancel 请求"，而是**终止那个独占进程**；
 *      session 也不是"新建"，而是 `session/prompt` 里给一个未知 `sessionId`，由服务端惰性创建。
 *   ② **默认不池化**：只有当可信 session 上下文能贯通时才允许池化；否则
 *      `poolingDecision()` 明确返回"不安全"，关闭池化是方案允许的正确答案。
 *
 * 依赖注入：`spawn` 由调用方提供（测试用假 spawner，生产用真实子进程），
 * 于是生命周期逻辑可以**零进程泄漏**地被断言。
 *
 * ── R01 修正（2026-10-17）──────────────────────────────────────────────────────
 * S13 这里写的是 `cmd: 'dsh-sdk', args: ['--stdio']`。**那个命令不存在**——
 * 它是照"应该长这样"编的，从未被真实运行验证过。锁定基线的真实入口是
 *   `node <baseline>/apps/cli/lib/bin.js --profile sdk [--patch <yml>]`
 * （出处 `packages/sdk/client/src/launch.ts` 的 `resolveDshLaunch()`）。
 * 现在入口**只从 `vendor/dsh/runtime-manifest.json` 解析**，解析不通过就 fail-closed
 * 返回 `launch_refused`，**不再降级**成源码树/全局包/编出来的命令。
 * 完整传输闭环见 `sdk-adapter.mjs`（本文件的 `startTask` 仍是"发出去即返回"的薄壳）。
 */

import { buildChildEnv, resolveDshLaunch } from './sdk-process.mjs';

export const SDK_RUNTIME_VERSION = 'dsh-sdk-v1';
export const SDK_BASELINE_VERSION = '0.1.7-rc.1';

/**
 * 协议面白名单 —— **上游真实存在的方法**。
 * 任何"想调用但不在这里"的方法名都会被拒绝（fail-closed），
 * 这样"发明一个不存在的 API"会在本地立刻炸掉，而不是在生产里静默失败。
 */
export const SDK_PROTOCOL = Object.freeze({
  requests: Object.freeze(['initialize', 'session/prompt', 'shutdown']),
  notifications: Object.freeze(['session.event', 'session.status', 'subagent.started', 'subagent.finished']),
});

export const SDK_TASK_STATE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  CLOSING: 'closing',
  EXITED: 'exited',
  FAILED: 'failed',
});

export class SdkProtocolViolation extends Error {
  constructor(method) {
    super(`SDK_PROTOCOL_VIOLATION: 上游协议里没有 ${method}（不得发明 API）`);
    this.name = 'SdkProtocolViolation';
    this.code = 'SDK_PROTOCOL_VIOLATION';
    this.method = method;
  }
}

/** 断言某个方法名确实在上游协议面里（请求或通知）。 */
export function assertProtocolMethod(method) {
  const m = String(method || '');
  if (!SDK_PROTOCOL.requests.includes(m) && !SDK_PROTOCOL.notifications.includes(m)) {
    throw new SdkProtocolViolation(m);
  }
  return m;
}

/**
 * 会话作用域：**一个任务的 sessionId 只属于它的 (work, chapter, task)**。
 * 这样"把旧 session 内容带到新作品"在命名层面就不可能发生 ——
 * 服务端对未知 sessionId 是惰性建新会话，不会复用别的作品的会话。
 */
export function sessionIdFor({ workId = 0, chapterId = 0, taskId = '' } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  const t = String(taskId || '').trim() || 'adhoc';
  return `ns:${w}:${c}:${t}`;
}

/**
 * 池化决策（动作 5/6）。
 * 只有**可信 session 上下文贯通**时才允许池化；否则如实说"不安全"。
 * 本阶段没有把那套上下文贯通能力建起来，所以**默认关闭池化**——
 * 方案验收明确："无法安全池化时，关闭池化是允许的正确结果"。
 */
export function poolingDecision({ trustedSessionContext = false, wantsPool = false } = {}) {
  if (!wantsPool) return { enabled: false, reason: 'POOLING_NOT_REQUESTED' };
  if (!trustedSessionContext) {
    return {
      enabled: false,
      reason: 'UNTRUSTED_SESSION_CONTEXT',
      detail: '任务之间没有可信的 session 上下文隔离，池化会让上一个任务的会话内容泄漏到下一个任务；保持每任务新进程',
    };
  }
  return { enabled: false, reason: 'POOLING_NOT_IMPLEMENTED', detail: '上下文已可信，但池化实现留到后续阶段；当前保守关闭' };
}

/**
 * 创建 SDK 运行时。
 *
 * @param spawn   ({ command, args, env, cwd }) => { pid, onExit(cb), send(msg), kill(signal), exited }
 *                测试注入假实现；生产注入 `sdk-process.mjs` 的 `spawnReal`。
 * @param launch  已解析的启动描述（`resolveDshLaunch()` 的返回值）。
 *                省略时按 `manifestPath`（默认 `<repo>/vendor/dsh/runtime-manifest.json`）现场解析。
 * @param now     时钟（测试可注入）
 */
export function createSdkRuntime({ spawn, launch = null, manifestPath = null, repoRoot = null, profile = 'sdk', now = Date.now } = {}) {
  if (typeof spawn !== 'function') throw new TypeError('MISSING_SPAWN');

  /** taskId → 记录 */
  const tasks = new Map();
  const history = [];

  let resolvedLaunch = launch;
  /**
   * 解析真实入口（只解析一次）。
   * **解析失败不抛异常、也不降级**：返回 `ok:false`，由 startTask 如实记成 `launch_refused`。
   */
  function launchOrResolve() {
    if (resolvedLaunch) return resolvedLaunch;
    const here = repoRoot || process.cwd();
    const mp = manifestPath || `${here}/vendor/dsh/runtime-manifest.json`;
    try {
      resolvedLaunch = resolveDshLaunch({ manifestPath: mp, repoRoot: here, profile });
    } catch (e) {
      resolvedLaunch = { ok: false, reason: 'LAUNCH_RESOLVE_THREW', detail: String((e && e.message) || e) };
    }
    return resolvedLaunch;
  }

  function record(entry) {
    history.push(Object.freeze({ at: Number(now()), ...entry }));
    return entry;
  }

  function get(taskId) {
    return tasks.get(String(taskId)) || null;
  }

  /**
   * 是否有仍然活着的任务（单进程单活跃任务的判据）。
   *
   * ⚠️ 判据是**进程是否退出**（`exited`），不是任务状态。
   * 反例（真实踩过）：取消失败时进程没退出，但状态被标成 `FAILED`；
   * 若把 `FAILED` 当成"不活跃"，就会在旧进程还活着时允许新建任务 —— 正是方案动作 4
   * 明令禁止的情形（"故障后验证旧进程确实退出，再决定能否新建"）。
   */
  function liveTasks() {
    return [...tasks.values()].filter((t) => t.exited !== true);
  }

  /**
   * 启动一个任务：spawn → initialize → session/prompt。
   *
   * 动作 3/4：**默认单进程单活跃任务**；上一个进程必须**确认已退出**才能新建。
   */
  async function startTask({ taskId, workId = 0, chapterId = 0, prompt = '', provider = '', model = '', cwd = process.cwd(), budget = {}, envAllow = [], envExtra = {} } = {}) {
    const id = String(taskId || '');
    if (!id) throw new TypeError('MISSING_TASK_ID');

    const live = liveTasks();
    if (live.length) {
      // 单活跃任务：必须先显式 cancel/finish，不能悄悄并行
      return record({ type: 'refused', taskId: id, reason: 'ANOTHER_TASK_ACTIVE', active: live.map((t) => t.task_id) });
    }

    // 入口必须来自 manifest 解析结果；解析不通过就**不起进程**（不是降级启动）
    const launch = launchOrResolve();
    if (!launch || launch.ok !== true) {
      return record({
        type: 'launch_refused', taskId: id,
        reason: (launch && launch.reason) || 'LAUNCH_UNRESOLVED',
        detail: (launch && launch.detail) || '',
      });
    }

    const sessionId = sessionIdFor({ workId, chapterId, taskId: id });
    // 环境**显式枚举**：不整体展开 process.env（敏感键必须写进 envAllow）
    const built = buildChildEnv({
      allow: ['NOVELSTUDIO_SESSION', ...envAllow],
      extra: { ...envExtra, NOVELSTUDIO_SESSION: sessionId },
    });
    const child = spawn({
      command: launch.command, args: launch.args,
      env: built.env,
      cwd,
    });
    const t = {
      task_id: id, session_id: sessionId, work_id: Number(workId) || 0, chapter_id: Number(chapterId) || 0,
      state: SDK_TASK_STATE.STARTING, pid: child && child.pid, child,
      started_at_ms: Number(now()), exited: false, exit_code: null, sent: [], max_tokens: Number(budget.maxTokens) || undefined,
      launch: Object.freeze({ entry: launch.entryPath, profile: launch.profile }),
      env_passed: built.passed, env_withheld: built.withheld,
    };
    tasks.set(id, t);
    if (child && typeof child.onExit === 'function') {
      child.onExit((code) => { t.exited = true; t.exit_code = code; t.state = SDK_TASK_STATE.EXITED; });
    }

    // ① initialize —— 用**上游真实的** params 形状
    assertProtocolMethod('initialize');
    t.sent.push({ method: 'initialize', params: { cwd, provider, model, ...(t.max_tokens ? { maxTokens: t.max_tokens } : {}) } });
    if (child && typeof child.send === 'function') {
      child.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: t.sent[0].params });
    }

    // ② session/prompt —— sessionId 由本任务作用域决定（未知 id 由服务端惰性建会话）
    assertProtocolMethod('session/prompt');
    const promptParams = { sessionId, contentBlocks: [{ type: 'text', text: String(prompt || '') }] };
    t.sent.push({ method: 'session/prompt', params: promptParams });
    if (child && typeof child.send === 'function') {
      child.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: promptParams });
    }
    t.state = SDK_TASK_STATE.RUNNING;
    return record({ type: 'started', taskId: id, sessionId, pid: t.pid, sent: t.sent.map((s) => s.method) });
  }

  /**
   * 取消：**终止独占进程**（不是发一个不存在的 cancel 请求）。
   * 返回前等待"确认已退出"，避免"以为取消了其实还在跑"。
   */
  async function cancelTask({ taskId, reason = 'user_cancel' } = {}) {
    const t = get(taskId);
    if (!t) return record({ type: 'cancel_skipped', taskId: String(taskId), reason: 'UNKNOWN_TASK' });
    if (t.state === SDK_TASK_STATE.EXITED) return record({ type: 'cancel_skipped', taskId: t.task_id, reason: 'ALREADY_EXITED' });
    t.state = SDK_TASK_STATE.CLOSING;
    // 显式断言：我们**不**调用任何 cancel 协议方法（上游没有）
    if (SDK_PROTOCOL.requests.includes('session/cancel')) {
      throw new SdkProtocolViolation('session/cancel');
    }
    if (t.child && typeof t.child.kill === 'function') t.child.kill('SIGTERM');
    // 等待退出确认（真实实现里等 process 'exit'；假实现同步回调）
    await waitForExit(t, { timeoutMs: 2000, now });
    if (!t.exited) {
      t.state = SDK_TASK_STATE.FAILED;
      return record({ type: 'cancel_failed', taskId: t.task_id, reason: 'PROCESS_DID_NOT_EXIT', pid: t.pid });
    }
    t.state = SDK_TASK_STATE.EXITED;
    return record({ type: 'cancelled', taskId: t.task_id, pid: t.pid, reason, via: 'kill_process' });
  }

  /** 正常结束：发 `shutdown`（上游真实存在），再确认退出。 */
  async function finishTask({ taskId } = {}) {
    const t = get(taskId);
    if (!t) return record({ type: 'finish_skipped', taskId: String(taskId), reason: 'UNKNOWN_TASK' });
    assertProtocolMethod('shutdown');
    if (t.child && typeof t.child.send === 'function') {
      t.child.send({ jsonrpc: '2.0', id: 3, method: 'shutdown' });
    }
    await waitForExit(t, { timeoutMs: 2000, now });
    t.state = t.exited ? SDK_TASK_STATE.EXITED : SDK_TASK_STATE.FAILED;
    return record({ type: 'finished', taskId: t.task_id, exited: t.exited, exit_code: t.exit_code });
  }

  /** 动作 4：故障后先确认旧进程确实退出，再决定能否新建。 */
  function canStartNewTask() {
    const live = liveTasks();
    return { ok: live.length === 0, active: live.map((t) => t.task_id) };
  }

  /** 验收：无进程泄漏 —— 活着却没在跑任务、或任务结束了进程还在，都算泄漏。 */
  function detectLeaks() {
    const leaks = [];
    for (const t of tasks.values()) {
      const running = t.state === SDK_TASK_STATE.RUNNING || t.state === SDK_TASK_STATE.STARTING || t.state === SDK_TASK_STATE.CLOSING;
      if (running && t.exited) leaks.push({ task_id: t.task_id, kind: 'EXITED_BUT_STATE_RUNNING' });
      if (!running && !t.exited && t.state === SDK_TASK_STATE.FAILED) leaks.push({ task_id: t.task_id, kind: 'FAILED_BUT_PROCESS_ALIVE' });
    }
    return leaks;
  }

  /** 结果归属校验：结果必须回给启动它的那个任务/会话（防跨任务混淆）。 */
  function resolveResult({ taskId, sessionId, text = '' } = {}) {
    const t = get(taskId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TASK', accepted: false };
    if (String(sessionId || '') !== t.session_id) {
      return { ok: false, reason: 'SESSION_MISMATCH', accepted: false, expected: t.session_id, got: String(sessionId || '') };
    }
    return { ok: true, accepted: true, task_id: t.task_id, work_id: t.work_id, chapter_id: t.chapter_id, text: String(text || ''), session_id: t.session_id };
  }

  return { startTask, cancelTask, finishTask, canStartNewTask, detectLeaks, resolveResult, get, liveTasks, history: () => history.slice() };
}

/** 等待进程退出（假 spawner 会同步标记 exited，因此这里通常一次就满足）。 */
async function waitForExit(t, { timeoutMs = 2000, now = Date.now } = {}) {
  const deadline = Number(now()) + timeoutMs;
  while (!t.exited && Number(now()) < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    if (!t.exited) {
      // 假 spawner 可能只在 kill 时同步置位；真实实现由 'exit' 事件置位
      if (t.child && t.child.exited === true) t.exited = true;
      else break; // 不无限等待：交给调用方判 PROCESS_DID_NOT_EXIT
    }
  }
  if (t.child && t.child.exited === true) t.exited = true;
  return t.exited;
}
