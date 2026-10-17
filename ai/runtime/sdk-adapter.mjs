/**
 * ai/runtime/sdk-adapter.mjs —— R01：把真实 DSH 子进程包成**业务可用的运行时适配器**。
 *
 * 与 S13 的差别（这才是 R01 要补的东西）：
 *
 *   S13 的 `dsh-sdk.mjs` 发完 `initialize` + `session/prompt` 就返回 "started"。
 *   **它根本没等响应，也没有终态** —— 于是"任务成功"只能靠猜。本模块把它补成闭环：
 *
 *     spawn → initialize(等响应) → session/prompt(等受理) → 收 session.event
 *           → 直到该 sessionId 的 turn/end → 归一化 → shutdown → 确认真实退出
 *
 * 四条硬规矩：
 *   ① **没等到 initialize 响应不许发 prompt**（否则是在跟一个还没准备好的进程说话）；
 *   ② **没等到终态不许报 done**；请求已发但结果不明 → `unknown`，**不自动重试**（避免二次计费）；
 *   ③ **事件只收本任务的 sessionId**；别的 session 的事件计入 `foreignEvents` 并丢弃（跨作品隔离）；
 *   ④ **进程没退出就不许新任务**（判据是 `handle.exited`，不是任务状态字符串）。
 *
 * 本模块**不碰数据库、不写正文**：它只产出结果对象，由上层决定怎么落盘/怎么呈现。
 */

import { buildChildEnv, resolveDshLaunch, spawnReal, terminateProcessTree, scanProcess } from './sdk-process.mjs';
import { createStdioTransport } from './sdk-stdio-transport.mjs';

export const SDK_ADAPTER_VERSION = 'sdk-adapter-v1';

/** 上游 wire 上稳定的运行时身份（`serverInfo.name`）。 */
export const SDK_SERVER_NAME = 'deepseek-harness-sdk-runtime';

/** 任务状态。`UNKNOWN` 单独一档：**"请求已发、结果不知"不是 failed，也不是 done。** */
export const SDKTASK = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  HANDSHAKING: 'handshaking',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

export function createSdkRuntimeAdapter({
  launch,
  spawn = spawnReal,
  now = Date.now,
  terminate = terminateProcessTree,
  handshakeTimeoutMs = 12_000,
  turnTimeoutMs = 120_000,
  shutdownTimeoutMs = 8_000,
  exitTimeoutMs = 8_000,
} = {}) {
  if (!launch || launch.ok !== true) {
    const reason = (launch && launch.reason) || 'NO_LAUNCH';
    throw new TypeError(`SDK_LAUNCH_UNRESOLVED:${reason}`);
  }

  const tasks = new Map();
  const history = [];
  const record = (entry) => { history.push(Object.freeze({ at: Number(now()), ...entry })); return entry; };

  const liveTasks = () => [...tasks.values()].filter((t) => t.handle && t.handle.exited === false);

  function assertSingleOwner() {
    const live = liveTasks();
    if (live.length === 0) return null;
    return { ok: false, terminal: 'not_run', error: 'ANOTHER_TASK_ACTIVE', active: live.map((t) => t.taskId) };
  }

  /**
   * 跑一个任务（一次提示、一个独占进程）。
   *
   * @param taskId   任务标识（用于日志与单活跃判定）
   * @param sessionId SDK 侧 session id（必须由调用方给出**带作用范围**的值）
   * @param prompt   用户提示（文本块）
   * @param provider/model 真实路由：必须是 DSH 已配置的 provider 名与模型名
   * @param envAllow 允许交给子进程的额外环境键（例如 `DEEPSEEK_BASE_URL`）
   */
  async function runTask({
    taskId,
    sessionId,
    prompt = '',
    provider = '',
    model = '',
    cwd = process.cwd(),
    envAllow = [],
    envExtra = {},
    maxTokens = undefined,
    reasoningEffort = undefined,
    turnTimeoutMs: turnTimeout = turnTimeoutMs,
  } = {}) {
    const id = String(taskId || '');
    if (!id) throw new TypeError('MISSING_TASK_ID');
    if (!sessionId) throw new TypeError('MISSING_SESSION_ID');
    if (!provider || !model) return { ok: false, terminal: 'not_run', error: 'MISSING_PROVIDER_OR_MODEL' };

    const busy = assertSingleOwner();
    if (busy) { record({ type: 'refused', taskId: id, reason: busy.error }); return busy; }

    const { env, passed, withheld } = buildChildEnv({ allow: envAllow, extra: envExtra });
    const handle = spawn({ command: launch.command, args: launch.args, cwd, env });

    const t = {
      taskId: id, sessionId: String(sessionId), state: SDKTASK.STARTING,
      handle, provider, model, startedAt: Number(now()),
      events: [], eventTypes: [], foreignEvents: 0, text: '', usage: null,
      terminal: null, terminalReason: null, errors: [], transport: null, exitCode: null,
    };
    tasks.set(id, t);
    handle.onExit((code, sig) => {
      t.exitCode = code;
      t.handleSignal = sig;
    });

    // ① spawn 失败要立刻结算 —— 否则会等到超时，把"起不来"误记成"跑很慢"
    if (handle.spawnError) {
      t.state = SDKTASK.FAILED;
      t.terminal = 'failed';
      record({ type: 'spawn_failed', taskId: id, error: handle.spawnError });
      return {
        ok: false, terminal: 'failed', error: `SPAWN_FAILED:${handle.spawnError}`,
        pid: 0, envPassed: passed, envWithheld: withheld, taskId: id, sessionId: t.sessionId,
      };
    }

    const transport = createStdioTransport({ input: handle.stdoutStream, output: handle.stdinStream, now });
    t.transport = transport;

    // 事件订阅：只认本 sessionId
    const unsubscribe = transport.onNotification((method, params) => {
      const sid = params && params.sessionId !== undefined ? String(params.sessionId) : '';
      if (sid && sid !== t.sessionId) { t.foreignEvents += 1; return; }
      t.events.push({ method, ...(params && params.event ? { type: String(params.event.type || '') } : {}) });
      if (method === 'session.event' && params && params.event) {
        const type = String(params.event.type || '');
        t.eventTypes.push(type);
        absorbEvent(t, params.event);
      }
    });

    try {
      // ② 握手：必须等到**有效响应**才继续
      t.state = SDKTASK.HANDSHAKING;
      const initParams = { cwd, provider, model };
      if (reasoningEffort !== undefined) initParams.reasoningEffort = reasoningEffort;
      if (maxTokens !== undefined) initParams.maxTokens = Number(maxTokens);
      const init = await transport.request('initialize', initParams, { timeoutMs: handshakeTimeoutMs });
      const serverInfo = (init && init.serverInfo) || {};
      if (serverInfo.name !== SDK_SERVER_NAME) {
        throw new Error(`HANDSHAKE_MISMATCH: serverInfo.name=${String(serverInfo.name)}`);
      }
      t.serverInfo = { name: String(serverInfo.name), version: String(serverInfo.version || '') };

      // ③ 受理：拿不到 messageId 就不算受理
      const promptResult = await transport.request('session/prompt', {
        sessionId: t.sessionId,
        contentBlocks: [{ type: 'text', text: String(prompt || '') }],
      }, { timeoutMs: handshakeTimeoutMs });
      if (!promptResult || typeof promptResult.messageId !== 'string' || !promptResult.messageId) {
        throw new Error('PROMPT_NOT_ACCEPTED');
      }
      t.messageId = promptResult.messageId;
      t.state = SDKTASK.RUNNING;

      // ④ 等终态（只信本 session 的 turn/end）
      const settled = await waitForTerminal(t, turnTimeout);
      if (!settled) {
        // 被用户取消：进程已被我们杀掉，这不是"结果不明"，而是明确的取消
        if (t.cancelledByUser) {
          t.state = SDKTASK.CANCELLED;
          record({ type: 'cancelled_settled', taskId: id });
          return {
            ok: false, terminal: 'cancelled', error: 'CANCELLED_BY_USER',
            taskId: id, sessionId: t.sessionId, pid: handle.pid, exitCode: handle.exitCode,
            text: t.text, eventTypes: t.eventTypes.slice(), foreignEvents: t.foreignEvents,
            envPassed: passed, envWithheld: withheld,
          };
        }
        // 请求已发、结果不知：如实进 unknown，并**杀掉进程**避免占着独占槽
        t.state = SDKTASK.UNKNOWN;
        t.terminal = 'unknown';
        const killed = await closeProcess(t, terminate, exitTimeoutMs);
        record({ type: 'unknown', taskId: id, killed: killed.ok });
        return {
          ok: false, terminal: 'unknown', error: 'NO_TERMINAL_STATE',
          taskId: id, sessionId: t.sessionId, pid: handle.pid, exitCode: handle.exitCode,
          text: t.text, eventTypes: t.eventTypes.slice(), foreignEvents: t.foreignEvents,
          envPassed: passed, envWithheld: withheld,
        };
      }

      // ⑤ 正常收尾：shutdown → 确认退出
      const finish = await shutdownAndWait(t, transport, handle, shutdownTimeoutMs, exitTimeoutMs, terminate);
      const ok = t.terminal === 'done';
      t.state = ok ? SDKTASK.DONE : SDKTASK.FAILED;
      record({ type: 'settled', taskId: id, terminal: t.terminal, exitCode: handle.exitCode });
      return {
        ok,
        terminal: t.terminal,
        error: ok ? '' : `TURN_ENDED_WITH:${String(t.terminalReason || 'unknown')}`,
        text: t.text,
        usage: t.usage,
        taskId: id,
        sessionId: t.sessionId,
        messageId: t.messageId,
        pid: handle.pid,
        exitCode: handle.exitCode,
        serverInfo: t.serverInfo || null,
        eventTypes: t.eventTypes.slice(),
        foreignEvents: t.foreignEvents,
        envPassed: passed,
        envWithheld: withheld,
        exitedCleanly: finish.exited,
        shutdownRequested: finish.shutdownRequested,
      };
    } catch (e) {
      const message = String((e && e.message) || e);
      t.errors.push(message);
      // ⚠️ 用户取消时，杀进程会让挂起请求以 SDK_TRANSPORT_INPUT_CLOSED 失败。
      // 若不先看 cancelledByUser，取消就会被归一化成 `failed` —— UI 会显示"失败"，
      // 实际是作者自己停的。这不是文案问题：failed 会触发重试策略，cancelled 不会。
      if (t.cancelledByUser) {
        t.state = SDKTASK.CANCELLED;
        t.terminal = 'cancelled';
        record({ type: 'cancelled_settled', taskId: id, during: 'request' });
        return {
          ok: false, terminal: 'cancelled', error: 'CANCELLED_BY_USER',
          taskId: id, sessionId: t.sessionId, pid: handle.pid, exitCode: handle.exitCode,
          text: t.text, eventTypes: t.eventTypes.slice(), foreignEvents: t.foreignEvents,
          envPassed: passed, envWithheld: withheld,
        };
      }
      t.state = SDKTASK.FAILED;
      t.terminal = 'failed';
      await closeProcess(t, terminate, exitTimeoutMs);
      record({ type: 'failed', taskId: id, error: message });
      return {
        ok: false, terminal: 'failed', error: message,
        taskId: id, sessionId: t.sessionId, pid: handle.pid, exitCode: handle.exitCode,
        text: t.text, eventTypes: t.eventTypes.slice(), foreignEvents: t.foreignEvents,
        envPassed: passed, envWithheld: withheld,
      };
    } finally {
      try { unsubscribe(); } catch { /* 订阅已随传输关闭 */ }
      try { transport.close('ADAPTER_SETTLED'); } catch { /* 已关闭 */ }
    }
  }

  /** 取消 = 终止独占进程（上游没有 session/cancel），并**等到真退出**才回报。 */
  async function cancelTask({ taskId, reason = 'user_cancel' } = {}) {
    const t = tasks.get(String(taskId || ''));
    if (!t) return record({ type: 'cancel_skipped', taskId: String(taskId || ''), reason: 'UNKNOWN_TASK' });
    if (!t.handle || t.handle.exited) return record({ type: 'cancel_skipped', taskId: t.taskId, reason: 'ALREADY_EXITED' });
    t.state = SDKTASK.CANCELLED;
    t.cancelledByUser = true;
    const closed = await closeProcess(t, terminate, exitTimeoutMs);
    if (!closed.exited) {
      t.state = SDKTASK.FAILED;
      return record({ type: 'cancel_failed', taskId: t.taskId, reason: 'PROCESS_DID_NOT_EXIT', pid: t.handle.pid });
    }
    return record({ type: 'cancelled', taskId: t.taskId, pid: t.handle.pid, reason, via: 'kill_process_tree', steps: closed.steps });
  }

  /** 动作 4：故障后先确认旧进程确实退出，再决定能否新建。 */
  function canStartNewTask() {
    const live = liveTasks();
    return { ok: live.length === 0, active: live.map((t) => t.taskId) };
  }

  /** 泄漏检查：活着却没在跑、或已结算但进程还在 —— 两种都算泄漏。 */
  function detectLeaks() {
    const leaks = [];
    for (const t of tasks.values()) {
      const running = t.state === SDKTASK.RUNNING || t.state === SDKTASK.HANDSHAKING || t.state === SDKTASK.STARTING;
      if (t.handle && t.handle.exited === false && !running) leaks.push({ taskId: t.taskId, kind: 'PROCESS_ALIVE_AFTER_SETTLE', pid: t.handle.pid });
      if (t.handle && t.handle.exited === true && running) leaks.push({ taskId: t.taskId, kind: 'EXITED_WHILE_RUNNING', pid: t.handle.pid });
    }
    return leaks;
  }

  /** 进程探针：给验证脚本做孤儿扫描用（只报事实）。 */
  function probeProcess(taskId) {
    const t = tasks.get(String(taskId || ''));
    if (!t || !t.handle) return { checked: false, alive: null, detail: 'NO_TASK' };
    return { ...scanProcess(t.handle.pid), pid: t.handle.pid, exited: t.handle.exited === true, exitCode: t.handle.exitCode };
  }

  return {
    version: SDK_ADAPTER_VERSION,
    launch,
    runTask,
    cancelTask,
    canStartNewTask,
    detectLeaks,
    probeProcess,
    liveTasks,
    get: (taskId) => tasks.get(String(taskId || '')) || null,
    history: () => history.slice(),
  };
}

/** 把一条 session 事件吸收进任务记录（只保留判定所需的最小信息）。 */
function absorbEvent(t, event) {
  const type = String(event && event.type || '');
  const data = (event && event.data) || {};
  if (type === 'assistant/message') {
    const text = textOfMessage(data.message);
    if (text) t.text += (t.text ? '\n' : '') + text;
    if (data.usage && typeof data.usage === 'object') t.usage = normalizeUsage(data.usage);
  } else if (type === 'turn/end') {
    const reasonKind = data && data.reason && typeof data.reason === 'object' ? String(data.reason.kind || '') : String(data.reason || '');
    t.terminalReason = reasonKind || 'unknown';
    t.terminal = reasonKind === 'completed' ? 'done' : 'failed';
  }
}

function textOfMessage(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 归一化 token 用量。
 *
 * ⚠️ 上游 session 事件里用的是 **camelCase**（`TokenUsage.inputTokens / outputTokens /
 * totalTokens`，出处 `packages/llm/llm/src/types.ts`），而 broker 契约用 snake_case。
 * 第一版只读 snake_case，于是真实运行时报出 `{0,0,0}` —— **数字没有错，是读错了字段**。
 * 这里同时接受两套命名；**一个可识别字段都没有时返回 null**，绝不凭空报 0。
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const p = pick('prompt_tokens', 'input_tokens', 'inputTokens');
  const c = pick('completion_tokens', 'output_tokens', 'outputTokens');
  const t = pick('total_tokens', 'totalTokens');
  if (p === undefined && c === undefined && t === undefined) return null;
  const prompt = p ?? 0;
  const completion = c ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: t ?? prompt + completion };
}

/** 等本任务的 `turn/end`（真终态）。超时返回 false —— 绝不"猜它大概完成了"。 */
async function waitForTerminal(t, timeoutMs) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  while (Date.now() < deadline) {
    if (t.terminal) return true;
    if (t.handle && t.handle.exited === true) {
      // 进程自己退了：如果有终态就用终态，没有就是"退得太早"
      return t.terminal !== null;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return t.terminal !== null;
}

/** shutdown（尽力）+ 等真实退出；退不掉就升级为进程树清理。 */
async function shutdownAndWait(t, transport, handle, shutdownTimeoutMs, exitTimeoutMs, terminate) {
  let shutdownRequested = false;
  try {
    await transport.request('shutdown', undefined, { timeoutMs: shutdownTimeoutMs });
    shutdownRequested = true;
  } catch {
    // shutdown 失败不是任务失败：正文已经拿到了。但它会降低"干净退出"的评级
    shutdownRequested = false;
  }
  let exited = await handle.waitExit(exitTimeoutMs);
  if (!exited) {
    terminate(handle);
    exited = await handle.waitExit(exitTimeoutMs);
  }
  return { exited, shutdownRequested };
}

async function closeProcess(t, terminate, exitTimeoutMs) {
  const handle = t && t.handle;
  if (!handle) return { ok: false, exited: false, steps: ['NO_HANDLE'] };
  if (handle.exited) return { ok: true, exited: true, steps: ['ALREADY_EXITED'] };
  const r = terminate(handle);
  const exited = await handle.waitExit(exitTimeoutMs);
  return { ok: exited, exited, steps: r.steps };
}

export { resolveDshLaunch, buildChildEnv, spawnReal };
