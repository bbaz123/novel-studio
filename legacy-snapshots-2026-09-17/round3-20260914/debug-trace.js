// 运行追踪（🐞 运行追踪 / 调试开关）引擎：把「一次用户操作实际跑了哪些代码」记下来。
//
// 设计约束（与产品需求逐条对应）：
//   1. 零依赖：只用 Node 内置模块（node:async_hooks）。
//   2. 关录制时零开销：采集函数在未开启时走直通分支，不构造对象、不取栈。
//   3. 不记正文：函数参数与返回值一律转成「形状摘要」（类型/长度/字段名/关键 id），
//      长文本只留长度，绝不落盘小说正文或提示词正文。
//   4. 分层深度：主干函数用 traceFn 显式埋点、全量记节点；高频工具函数用 bumpTool 只累计
//      「次数 + 合计耗时」，不逐条展开。
//   5. 硬上限 + 丢尾：单次操作节点数超过上限后停止采集并在该操作上标「已截断」，
//      同时按类别累计被丢弃的节点数，保证用户知道丢了什么。
//   6. 自身排除：/api/debug/*、/api/logs、/api/harness/job 等轮询/自省接口不参与追踪，
//      避免「记录行为本身」放大数据量与负载。
//
// 异步链路关联用 AsyncLocalStorage：前端给每次操作生成 opId 并通过 X-Trace-Op 头下发，
// 后端在 http 'request' 事件最外层建立上下文，之后整条 await 链自动归属同一个操作。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
const MAX_NODES_PER_OP = Number(process.env.NOVELSTUDIO_TRACE_MAX_NODES) > 0
  ? Math.floor(Number(process.env.NOVELSTUDIO_TRACE_MAX_NODES))
  : 2000; // 单次操作节点硬上限（超出即截断）
const MAX_OPS_IN_MEMORY = 500; // 内存中保留的最近操作数（明细始终全量落 JSONL）
const MAX_SHAPE_KEYS = 24; // 形状摘要里保留的字段名个数
const SHORT_TEXT_KEEP = 160; // 短于该长度的字符串视为「短标识」（路径/id/枚举）原样保留
const MAX_IDENT_LEN = 160;
const MAX_ERROR_TEXT = 2000;
const MAX_DEPTH = 12; // 形状摘要递归深度
const STREAM_FLUSH_MS = 250; // SSE 批量冲刷间隔
const TOOL_KIND_LIMIT = 40; // 工具函数累计表容量上限

// 不参与追踪的路径：追踪自身接口 + 界面轮询类接口（防自我放大）。
const TRACE_EXCLUDE_PREFIXES = ['/api/debug', '/api/logs'];
const TRACE_EXCLUDE_EXACT = new Set(['/api/stats', '/api/harness/job']);

export function isExcludedPath(pathname) {
  const p = String(pathname || '');
  if (TRACE_EXCLUDE_EXACT.has(p)) return true;
  return TRACE_EXCLUDE_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

// ---------- 状态 ----------
const als = new AsyncLocalStorage();

const state = {
  recording: false,
  sessionClosed: true, // 会话文件是否已写 session-end：关闭后拒绝任何迟到写入，避免 JSONL 结构被污染
  sessionId: '',
  startedAt: 0,
  lastPingAt: 0,
  ops: new Map(), // opId -> 操作记录
  opOrder: [], // opId 顺序（用于淘汰）
  seq: 0, // 节点全局序号（时间线排序用）
  totalNodes: 0,
  totals: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, aiCalls: 0 },
  truncatedOps: 0,
  droppedNodes: 0,
  lastAiAt: 0,
  lastAiTokens: null,
  listeners: new Set(),
  streamBuf: [],
  streamTimer: null
};

let sessionCounter = 0;

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function resolveDataDir() {
  const env = process.env.NOVELSTUDIO_DATA_DIR;
  if (env) {
    return path.isAbsolute(env) ? path.resolve(env) : path.resolve(path.join(process.cwd(), env));
  }
  return path.join(__dirname, 'data');
}

export const DEBUG_DIR = path.join(resolveDataDir(), 'debug');
const KEEP_SESSIONS = Number(process.env.NOVELSTUDIO_TRACE_KEEP) > 0
  ? Math.floor(Number(process.env.NOVELSTUDIO_TRACE_KEEP))
  : 20;

function ensureDir() {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  } catch (_) { /* 目录创建失败不影响主流程 */ }
}

function sessionFileName(sessionId) {
  const stamp = String(sessionId || 'session').replace(/[^0-9A-Za-z._-]/g, '-');
  return path.join(DEBUG_DIR, `trace-${stamp}.jsonl`);
}

// ---------- 形状摘要（「不记正文」的落地核心） ----------
const CRITICAL_KEYS = new Set([
  'id', 'work_id', 'chapter_id', 'volume_id', 'plotline_id', 'character_id', 'config_id',
  'model', 'tokens', 'usage', 'prompt_tokens', 'completion_tokens', 'total_tokens',
  'prompt_cache_hit_tokens', 'cache_hit_tokens', 'cached_tokens', 'reasoning_tokens',
  'duration_ms', 'cost_ms', 'ms', 'status', 'status_code', 'ok', 'error', 'code',
  'rows', 'changes', 'truncated', 'timeout_ms', 'job_id', 'kind', 'path', 'method',
  'endpoint', 'url', 'action'
]);

function repr(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'object') return Array.isArray(v) ? 'array' : 'object';
  return t;
}

function shapeOfError(v) {
  if (!v || typeof v !== 'object') return { type: 'error', message: String(v ?? '').slice(0, MAX_ERROR_TEXT) };
  const stack = typeof v.stack === 'string' ? v.stack : '';
  return {
    type: 'error',
    name: String(v.name || 'Error').slice(0, 80),
    message: String(v.message ?? '').slice(0, MAX_ERROR_TEXT),
    code: v.code === undefined ? null : String(v.code).slice(0, 60),
    status: Number.isFinite(Number(v.status)) ? Number(v.status) : null
  };
}

function errorStackOf(v) {
  return v && typeof v.stack === 'string' ? v.stack.slice(0, 4000) : '';
}

function shapeOf(v, depth = 0) {
  if (v === null || v === undefined) return { type: repr(v) };
  const t = typeof v;
  if (t === 'string') {
    const len = v.length;
    // 短字符串（路径、id、枚举、标题）原样保留；长字符串只留长度，绝不落正文。
    if (len <= SHORT_TEXT_KEEP) return { type: 'string', len, value: v };
    return { type: 'string', len, omitted: true };
  }
  if (t === 'number' || t === 'boolean') return { type: t, value: v };
  if (t === 'bigint') return { type: 'bigint', value: Number(v) };
  if (t === 'function') return { type: 'function', name: String(v.name || '').slice(0, 80) };
  if (v instanceof Error) return shapeOfError(v);
  if (v instanceof Date) return { type: 'date', value: v.toISOString() };
  if (v instanceof Map) return { type: 'map', len: v.size };
  if (v instanceof Set) return { type: 'set', len: v.size };
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return { type: 'buffer', len: v.byteLength ?? v.length ?? 0 };
  if (Array.isArray(v)) {
    const out = { type: 'array', len: v.length };
    // 只采样前 3 个元素：上下文装配会返回上百条记录，全量遍历会拖慢录制本身。
    if (depth < MAX_DEPTH && v.length) out.sample = v.slice(0, 3).map((item) => shapeOf(item, depth + 1));
    return out;
  }
  if (t === 'object') {
    let keys;
    try {
      keys = Object.keys(v);
    } catch (_) {
      return { type: 'object', keys: [] };
    }
    const out = { type: 'object', keys: keys.slice(0, MAX_SHAPE_KEYS) };
    if (keys.length > MAX_SHAPE_KEYS) out.more_keys = keys.length - MAX_SHAPE_KEYS;
    if (depth < MAX_DEPTH) {
      const critical = {};
      let hit = 0;
      // 关键 id / 用量字段直通保留（复盘最需要，且不含正文）。
      for (const k of keys) {
        if (hit >= 16) break;
        if (!CRITICAL_KEYS.has(k)) continue;
        critical[k] = shapeOf(v[k], MAX_DEPTH); // 关键值不再递归展开
        hit += 1;
      }
      if (hit) out.critical = critical;
      // messages 数组特例：只留角色与字符数（AI 提示词正文绝不落盘）。
      if (Array.isArray(v.messages)) {
        out.messages = v.messages.slice(0, 40).map((m) => ({
          role: m && typeof m.role === 'string' ? m.role : '',
          chars: m && typeof m.content === 'string' ? m.content.length : 0
        }));
      }
    }
    return out;
  }
  return { type: t };
}

/** 参数摘要：只记字段名 + 关键值，不记正文。 */
function shapeOfArgs(args) {
  const list = Array.from(args || []);
  if (!list.length) return [];
  return list.slice(0, 6).map((a) => shapeOf(a, MAX_DEPTH - 4));
}

// 代码位置解析：跳过 node 内部帧与追踪引擎自身帧，取第一个「业务代码」帧。
// 注意 ESM 顶层 await 的栈形如 ... → processTicksAndRejections(node:internal) → 业务函数，
// 内部帧会排在业务帧之前，因此必须按内容过滤而不是按「第 N 帧」计数。
const STACK_SKIP = /(?:^|[/\\])debug-trace\.js|node:|internal\/|processTicksAndRejections|task_queues/;

function parseFrame(line) {
  const text = String(line).trim().replace(/^at\s+/, '');
  const withFn = text.match(/^(.*?)\s*\((.*?):(\d+):(\d+)\)$/);
  if (withFn) {
    return { file: withFn[2].replace(/^file:\/\/\//, '').slice(0, MAX_IDENT_LEN), line: Number(withFn[3]) || null, func: withFn[1].slice(0, 120) };
  }
  const bare = text.match(/^(.*?):(\d+):(\d+)$/);
  if (bare) return { file: bare[1].replace(/^file:\/\/\//, '').slice(0, MAX_IDENT_LEN), line: Number(bare[2]) || null, func: '' };
  return { file: '', line: null, func: '' };
}

function captureLocation() {
  const lines = String(new Error().stack || '').split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.indexOf(' at ') < 0) continue;
    if (STACK_SKIP.test(line)) continue;
    return parseFrame(line);
  }
  return { file: '', line: null, func: '' };
}

// ---------- 操作与上下文 ----------
function sanitizeOpId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // 只接受短标识形态，避免外部塞入超长或带控制字符的值。
  return /^[0-9A-Za-z._:-]{1,80}$/.test(s) ? s : '';
}

/**
 * @param {boolean} force 忽略「正在录制」判断，强制建记录。
 *   用于前端在录制刚停止时上报的收尾数据：这些节点属于已经录过的操作，
 *   丢掉会留下一条没有前端调用链的残缺记录，因此允许补建。
 */
function beginOp(opId, title, meta = {}, force = false) {
  if (!state.recording && !force) return null;
  const id = sanitizeOpId(opId) || `anon-${++sessionCounter}-${nowMs().toString(36)}`;
  const existing = state.ops.get(id);
  if (existing) return existing; // 同一次操作触发的多个 API 并入同一条记录
  const op = {
    opId: id,
    title: String(title || '').slice(0, 120),
    source: String(meta.source || 'client').slice(0, 20),
    startedAt: new Date().toISOString(),
    t0: nowMs(),
    costMs: 0,
    nodes: [],
    toolCalls: {},
    errors: 0,
    status: 'running',
    httpStatus: null,
    truncated: false,
    droppedNodes: 0,
    droppedByKind: {},
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    aiCalls: 0,
    endedAt: ''
  };
  state.ops.set(id, op);
  state.opOrder.push(id);
  if (state.opOrder.length > MAX_OPS_IN_MEMORY) {
    const oldest = state.opOrder.shift();
    if (oldest && oldest !== id) state.ops.delete(oldest);
  }
  pushStream({ type: 'op-start', opId: id, title: op.title, at: op.startedAt });
  return op;
}

/**
 * 当前异步链归属的操作（仅内部使用）。
 * 注意：这里不检查 state.recording —— 停录瞬间仍在途的请求（其上下文已绑定操作）
 * 需要把收尾节点补完；而新请求不会再有上下文，因此不会凭空产生新操作。
 */
function currentOp() {
  return als.getStore() || null;
}

function recordTool(name, costMs) {
  const op = currentOp();
  if (!op) return;
  const key = String(name || 'anon').slice(0, 80);
  const entry = op.toolCalls[key];
  if (entry) {
    entry.count += 1;
    entry.costMs += costMs;
    return;
  }
  if (Object.keys(op.toolCalls).length >= TOOL_KIND_LIMIT) return;
  op.toolCalls[key] = { count: 1, costMs };
}

function recordNode(node) {
  const op = currentOp();
  if (!op) return;
  if (op.nodes.length >= MAX_NODES_PER_OP) {
    if (!op.truncated) {
      op.truncated = true;
      state.truncatedOps += 1;
      pushStream({ type: 'op-truncated', opId: op.opId, limit: MAX_NODES_PER_OP });
    }
    op.droppedNodes += 1;
    state.droppedNodes += 1;
    const kind = String(node.kind || 'other');
    op.droppedByKind[kind] = (op.droppedByKind[kind] || 0) + 1;
    return;
  }
  state.seq += 1;
  state.totalNodes += 1;
  const full = { seq: state.seq, opId: op.opId, ...node };
  op.nodes.push(full);
  appendNode(op.opId, full);
  if (full.status === 'error') op.errors += 1;
  if (full.kind === 'ai') {
    op.aiCalls += 1;
    state.totals.aiCalls += 1;
    const p = Number(full.usage?.prompt_tokens) || 0;
    const c = Number(full.usage?.completion_tokens) || 0;
    const hit = Number(full.usage?.prompt_cache_hit_tokens) || 0;
    op.promptTokens += p;
    op.completionTokens += c;
    op.cacheHitTokens += hit;
    state.totals.promptTokens += p;
    state.totals.completionTokens += c;
    state.totals.cacheHitTokens += hit;
    state.lastAiAt = Date.now();
    state.lastAiTokens = { prompt_tokens: p, completion_tokens: c, model: full.model || '' };
  }
  pushStream({ type: 'node', opId: op.opId, node: full });
}

// ---------- SSE 推送 ----------
function pushStream(item) {
  if (!state.listeners.size) return;
  state.streamBuf.push(item);
  if (state.streamBuf.length > 500) state.streamBuf.splice(0, state.streamBuf.length - 500);
  if (state.streamTimer) return;
  state.streamTimer = setTimeout(() => {
    state.streamTimer = null;
    const batch = state.streamBuf;
    state.streamBuf = [];
    if (!batch.length) return;
    for (const send of state.listeners) {
      try {
        send(batch);
      } catch (_) { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }, STREAM_FLUSH_MS);
  if (typeof state.streamTimer.unref === 'function') state.streamTimer.unref();
}

export function subscribeStream(send) {
  state.listeners.add(send);
  return () => state.listeners.delete(send);
}

// ---------- 录制开关 ----------
function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${process.pid.toString(36)}`;
}

export function startTracing(meta = {}) {
  if (state.recording) return { ok: true, already: true, ...traceState() };
  state.recording = true;
  state.sessionClosed = false; // 打开新会话：允许写入
  state.sessionId = newSessionId();
  state.startedAt = Date.now();
  state.lastPingAt = Date.now();
  state.ops.clear();
  state.opOrder = []; // 必须与 ops 同步清空，否则 listOperations 会返回上一会话的幽灵条目
  state.seq = 0;
  state.totalNodes = 0;
  state.truncatedOps = 0;
  state.droppedNodes = 0;
  state.totals = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, aiCalls: 0 };
  state.lastAiAt = 0;
  state.lastAiTokens = null;
  ensureDir();
  appendLine({ type: 'session-start', sessionId: state.sessionId, at: new Date().toISOString(), pid: process.pid, meta: shapeOf(meta, MAX_DEPTH - 4) });
  pruneSessions();
  return { ok: true, already: false, ...traceState() };
}

export function stopTracing(reason = 'user') {
  if (!state.recording) return { ok: true, already: false, ...traceState() };
  const endedAt = new Date().toISOString();
  state.recording = false;
  // 未显式结束的操作补齐收尾信息，并写入 op-end 行，
  // 让录制文件自描述（回看时不必依赖内存快照即可还原每条操作）。
  for (const op of state.ops.values()) {
    if (op.status === 'running') {
      op.status = op.errors ? 'error' : 'done';
      op.costMs = Math.max(op.costMs, nowMs() - op.t0);
      op.endedAt = endedAt;
      appendLine({ type: 'op-end', opId: op.opId, summary: opSummary(op), render: null, toast: null, auto_closed: true });
    }
  }
  // 摘要必须在自动收尾循环之后计算：操作状态/耗时此刻才定稿（否则 ops=0/errors 偏小）。
  const summary = sessionSummary();
  state.sessionClosed = true; // 封卷：之后 op-end / node 一律不再写文件（session-end 自身除外）
  appendLine({ type: 'session-end', sessionId: state.sessionId, at: endedAt, reason: String(reason).slice(0, 40), summary });
  flushNodeBuf();
  pushStream({ type: 'session-end', sessionId: state.sessionId, summary });
  return { ok: true, already: true, summary, ...traceState() };
}

/**
 * 前端心跳：页面关闭后由心跳超时自动停录制，避免忘关。
 *
 * 超时值必须显著大于前端 ping 间隔（10s）：浏览器会把**后台标签页**的定时器节流到
 * 约 1 次/分钟，余量太小会导致用户切到别的标签页时录制被误判为「页面已关闭」而中断。
 * 这里取 90s（9× ping 间隔），只用于兜住「页面真的关了」这种情况。
 */
export function pingTracing() {
  state.lastPingAt = Date.now();
}

export function checkStaleTracing(timeoutMs = 90000) {
  if (!state.recording || !state.lastPingAt) return false;
  if (Date.now() - state.lastPingAt <= timeoutMs) return false;
  stopTracing('stale');
  return true;
}

export function traceState() {
  return {
    recording: state.recording,
    session_id: state.sessionId,
    started_at: state.startedAt ? new Date(state.startedAt).toISOString() : '',
    ops: state.ops.size,
    nodes: state.totalNodes,
    truncated_ops: state.truncatedOps,
    dropped_nodes: state.droppedNodes,
    errors: Array.from(state.ops.values()).reduce((s, op) => s + op.errors, 0),
    totals: { ...state.totals },
    last_ai: state.lastAiTokens ? { ...state.lastAiTokens, at: state.lastAiAt } : null,
    file: state.sessionId ? path.basename(sessionFileName(state.sessionId)) : '',
    limits: {
      max_nodes_per_op: MAX_NODES_PER_OP,
      max_ops_in_memory: MAX_OPS_IN_MEMORY,
      keep_sessions: KEEP_SESSIONS
    }
  };
}

export function sessionSummary() {
  let nodes = 0;
  let errors = 0;
  let truncated = 0;
  for (const op of state.ops.values()) {
    nodes += op.nodes.length;
    errors += op.errors;
    if (op.truncated) truncated += 1;
  }
  const first = state.opOrder.length ? state.ops.get(state.opOrder[0]) : null;
  const last = state.opOrder.length ? state.ops.get(state.opOrder[state.opOrder.length - 1]) : null;
  return {
    session_id: state.sessionId,
    ops: state.ops.size,
    nodes,
    errors,
    truncated_ops: truncated,
    dropped_nodes: state.droppedNodes,
    duration_ms: state.startedAt ? Date.now() - state.startedAt : 0,
    prompt_tokens: state.totals.promptTokens,
    completion_tokens: state.totals.completionTokens,
    cache_hit_tokens: state.totals.cacheHitTokens,
    ai_calls: state.totals.aiCalls,
    first_title: first ? first.title : '',
    last_title: last ? last.title : ''
  };
}

// ---------- 操作生命周期 ----------
/**
 * 建立/获取一条操作记录。
 * @param {string} opId 操作 id（前端 X-Trace-Op 头传入）
 * @param {string} title 操作语义名
 * @param {{ source?: string, force?: boolean }} [meta]
 *   source 标记来源（client / server）；force=true 时忽略「正在录制」判断强制建记录，
 *   供 /api/debug/op 在录制刚停止时补建，避免丢掉前端调用链。
 */
export function beginOperation(opId, title, meta = {}) {
  return beginOp(opId, title, meta, meta.force === true);
}

export function finishOperation(opId, extra = {}) {
  const op = state.ops.get(sanitizeOpId(opId));
  if (!op) return null;
  op.costMs = Math.max(op.costMs, nowMs() - op.t0);
  op.endedAt = new Date().toISOString();
  op.status = extra.status ? String(extra.status).slice(0, 20) : (op.errors ? 'error' : 'done');
  const summary = opSummary(op);
  appendLine({
    type: 'op-end',
    opId: op.opId,
    summary,
    render: extra.render === undefined ? null : shapeOf(extra.render, MAX_DEPTH - 6),
    toast: extra.toast === undefined ? null : shapeOf(extra.toast, MAX_DEPTH - 6)
  });
  pushStream({ type: 'op-end', opId: op.opId, summary });
  return summary;
}

/** 前端节点回传：与后端节点合流到同一条操作记录（时间线按 seq 排序）。 */
export function attachClientNodes(opId, nodes) {
  const id = sanitizeOpId(opId);
  const op = id ? state.ops.get(id) : null;
  if (!op || !Array.isArray(nodes)) return null;
  let accepted = 0;
  for (const raw of nodes.slice(0, 200)) {
    if (op.nodes.length >= MAX_NODES_PER_OP) {
      if (!op.truncated) op.truncated = true;
      op.droppedNodes += 1;
      state.droppedNodes += 1;
      continue;
    }
    state.seq += 1;
    state.totalNodes += 1;
    const node = {
      seq: state.seq,
      opId: op.opId,
      at: String(raw.at || new Date().toISOString()).slice(0, 40),
      side: 'frontend',
      kind: String(raw.kind || 'fn').slice(0, 20),
      name: String(raw.name || '').slice(0, 120),
      code: {
        file: String(raw.file || '').slice(0, MAX_IDENT_LEN),
        line: Number.isFinite(Number(raw.line)) ? Number(raw.line) : null,
        func: String(raw.func || '').slice(0, 120)
      },
      cost_ms: Number(raw.cost_ms) || 0,
      status: raw.status === 'error' ? 'error' : 'ok',
      result: raw.result === undefined ? null : shapeOf(raw.result, MAX_DEPTH - 4),
      error: raw.error ? shapeOfError(raw.error) : null
    };
    if (node.status === 'error') op.errors += 1;
    op.nodes.push(node);
    appendNode(op.opId, node);
    pushStream({ type: 'node', opId: op.opId, node });
    accepted += 1;
  }
  return { accepted };
}

function opSummary(op) {
  let slowest = null;
  for (const n of op.nodes) {
    const c = Number(n.cost_ms) || 0;
    if (!slowest || c > (Number(slowest.cost_ms) || 0)) slowest = n;
  }
  return {
    opId: op.opId,
    title: op.title,
    source: op.source,
    status: op.status,
    http_status: op.httpStatus,
    cost_ms: Math.round(op.costMs),
    nodes: op.nodes.length,
    errors: op.errors,
    truncated: op.truncated,
    dropped_nodes: op.droppedNodes,
    dropped_by_kind: op.droppedByKind,
    tool_kinds: Object.keys(op.toolCalls).length,
    prompt_tokens: op.promptTokens,
    completion_tokens: op.completionTokens,
    cache_hit_tokens: op.cacheHitTokens,
    ai_calls: op.aiCalls,
    slowest: slowest ? { name: slowest.name, kind: slowest.kind, cost_ms: Math.round(Number(slowest.cost_ms) || 0), file: slowest.code?.file || '', line: slowest.code?.line ?? null } : null,
    started_at: op.startedAt,
    ended_at: op.endedAt
  };
}

export function listOperations() {
  return state.opOrder.map((id) => state.ops.get(id)).filter(Boolean).map(opSummary);
}

export function getOperation(opId, { withNodes = true } = {}) {
  const op = state.ops.get(sanitizeOpId(opId));
  if (!op) return null;
  const summary = opSummary(op);
  if (!withNodes) return { summary };
  return { summary, tool_calls: op.toolCalls, nodes: op.nodes };
}

export function listToolCalls() {
  const agg = new Map();
  for (const op of state.ops.values()) {
    for (const [name, v] of Object.entries(op.toolCalls)) {
      const cur = agg.get(name) || { name, count: 0, cost_ms: 0 };
      cur.count += v.count;
      cur.cost_ms += v.costMs;
      agg.set(name, cur);
    }
  }
  return Array.from(agg.values())
    .map((v) => ({ ...v, cost_ms: Math.round(v.cost_ms) }))
    .sort((a, b) => b.cost_ms - a.cost_ms)
    .slice(0, 100);
}

// ---------- 埋点 API ----------
/** 主干函数包装：记录「调用时间 / 代码位置 / 耗时 / 返回形状 / 错误」。 */
export function traceFn(name, fn, opts = {}) {
  if (typeof fn !== 'function') return fn;
  const kind = String(opts.kind || 'fn').slice(0, 20);
  const slowMs = Number(opts.slowMs) > 0 ? Number(opts.slowMs) : 0;
  const label = String(name || fn.name || 'anonymous').slice(0, 120);
  const traced = function tracedFunction(...args) {
    const op = currentOp();
    if (!op) return fn.apply(this, args);
    const t0 = nowMs();
    const code = captureLocation();
    const argsShape = shapeOfArgs(args);
    const settle = (status, extra) => {
      const cost = nowMs() - t0;
      recordNode({
        at: new Date().toISOString(),
        side: 'backend',
        kind,
        name: label,
        code,
        args: argsShape,
        cost_ms: cost,
        status,
        slow: slowMs > 0 ? cost >= slowMs : false,
        ...extra
      });
    };
    let result;
    try {
      result = fn.apply(this, args);
    } catch (e) {
      settle('error', { error: shapeOfError(e), stack: errorStackOf(e) });
      throw e;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          settle('ok', { result: shapeOf(value, MAX_DEPTH - 4) });
          return value;
        },
        (e) => {
          settle('error', { error: shapeOfError(e), stack: errorStackOf(e) });
          throw e;
        }
      );
    }
    settle('ok', { result: shapeOf(result, MAX_DEPTH - 4) });
    return result;
  };
  try {
    Object.defineProperty(traced, 'name', { value: fn.name || name || 'tracedFunction', configurable: true });
  } catch (_) { /* 忽略 */ }
  return traced;
}

/** 高频工具函数：只累计次数与总耗时（分层追踪）。 */
export function bumpTool(name, costMs) {
  if (!state.recording) return;
  recordTool(name, costMs);
}

/** 通用节点：路由出口、渲染、外部调用等非函数包装场景。 */
export function traceEvent(kind, name, data = {}) {
  if (!state.recording || !als.getStore()) return;
  const { code, ...rest } = data || {};
  recordNode({
    at: new Date().toISOString(),
    side: data.side || 'backend',
    kind: String(kind || 'note').slice(0, 20),
    name: String(name || '').slice(0, 120),
    code: code || captureLocation(),
    ...rest
  });
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const prompt = num(raw.prompt_tokens ?? raw.input_tokens);
  const completion = num(raw.completion_tokens ?? raw.output_tokens);
  const cached = num(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_tokens ?? raw.cached_tokens);
  const reasoning = num(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens);
  const totalRaw = Number(raw.total_tokens);
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : prompt + completion;
  if (!prompt && !completion && !total) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_cache_hit_tokens: cached,
    reasoning_tokens: reasoning
  };
}

/** AI 调用节点：把 provider 返回的 usage 归一化后挂上（Token 采集）。 */
export function traceAI(name, data = {}) {
  if (!state.recording || !als.getStore()) return;
  const startedAt = Number(data.t0) || 0;
  const cost = startedAt ? nowMs() - startedAt : (Number(data.cost_ms) || 0);
  recordNode({
    at: new Date().toISOString(),
    side: 'backend',
    kind: 'ai',
    name: String(name || 'callAI').slice(0, 120),
    code: data.code || captureLocation(),
    model: String(data.model || '').slice(0, 80),
    endpoint: String(data.endpoint || '').slice(0, 200),
    stream: data.stream === true,
    attempt: Number(data.attempt) || 1,
    args: data.messageStats || [],
    cost_ms: cost,
    status: data.status === 'error' ? 'error' : 'ok',
    usage: normalizeUsage(data.usage),
    usage_unavailable_reason: data.usage_unavailable_reason ? String(data.usage_unavailable_reason).slice(0, 300) : null,
    result: data.result === undefined ? null : shapeOf(data.result, MAX_DEPTH - 4),
    error: data.error ? shapeOfError(data.error) : null,
    stack: data.error ? errorStackOf(data.error) : ''
  });
}

/** 慢通道（harness 子进程）节点：只到进程边界，Token 按产品决策标注为不可得。 */
export function traceHarness(name, data = {}) {
  if (!state.recording || !als.getStore()) return;
  const startedAt = Number(data.t0) || 0;
  const cost = startedAt ? nowMs() - startedAt : (Number(data.cost_ms) || 0);
  recordNode({
    at: new Date().toISOString(),
    side: 'backend',
    kind: 'harness',
    name: String(name || 'harness').slice(0, 120),
    code: data.code || captureLocation(),
    model: String(data.model || '').slice(0, 80),
    job_id: data.job_id === undefined || data.job_id === null ? null : String(data.job_id).slice(0, 60),
    cost_ms: cost,
    status: data.status === 'error' ? 'error' : (data.status === 'timeout' ? 'timeout' : 'ok'),
    usage: null,
    usage_unavailable_reason: '慢通道 Token 不可得：dsh-headless 显式丢弃 usage 事件（case "usage": return），stdout 只输出正文',
    result: data.result === undefined ? null : shapeOf(data.result, MAX_DEPTH - 4),
    error: data.error ? shapeOfError(data.error) : null,
    stack: data.error ? errorStackOf(data.error) : ''
  });
}

// ---------- SQL 追踪：包住预编译语句，记「操作类型 / 表名 / 行数 / 耗时」，不记 SQL 里的值 ----------
export function prepareTraced(prepareFn) {
  return function tracedPrepare(sql) {
    const stmt = prepareFn.call(this, sql);
    if (typeof stmt?.run !== 'function') return stmt;
    return wrapStatement(stmt, sql);
  };
}

const SQL_METHODS = ['run', 'get', 'all', 'iterate'];

function sqlKindOf(sql) {
  const m = String(sql || '').trim().match(/^(\w+)/);
  return m ? m[1].toUpperCase() : 'SQL';
}

function sqlTableOf(sql) {
  const m = String(sql || '').match(/^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|FROM)\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i);
  return m ? m[1] : '';
}

// 绑定值只留形状：字符串记长度、数字/布尔/null 原样。
// 这是「不记正文」的关键一环——写作入参通常是正文，绝不能落盘，
// 但「这次写入了多长的内容」是复盘时最有用的信息之一。
function argShapes(args) {
  if (!Array.isArray(args) || !args.length) return [];
  return args.slice(0, 8).map((a) => {
    if (typeof a === 'string') return { type: 'string', len: a.length };
    if (a === null || a === undefined) return { type: repr(a) };
    if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return { type: typeof a, value: a };
    if (Buffer.isBuffer(a) || ArrayBuffer.isView(a)) return { type: 'buffer', len: a.byteLength ?? a.length ?? 0 };
    return { type: repr(a) };
  });
}

// node:sqlite 的 StatementSync 方法都在原型上，因此用「显式覆盖 + 原型兜底」的方式包装：
// 显式属性覆盖 run/get/all/iterate，其余方法（columns 等）与实例属性走原型链自然落到原语句。
function wrapStatement(stmt, sql) {
  const kind = sqlKindOf(sql);
  const table = sqlTableOf(sql);
  const isWrite = kind === 'INSERT' || kind === 'UPDATE' || kind === 'DELETE' || kind === 'REPLACE';
  const wrapper = Object.create(stmt);
  for (const m of SQL_METHODS) {
    if (typeof stmt[m] !== 'function') continue;
    const original = stmt[m].bind(stmt);
    Object.defineProperty(wrapper, m, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function tracedStatementMethod(...args) {
        if (!state.recording && !als.getStore()) return original(...args);
        const t0 = nowMs();
        let out;
        try {
          out = original(...args);
        } catch (e) {
          traceEvent('db', `${kind} ${table || 'sql'}`, {
            cost_ms: nowMs() - t0,
            status: 'error',
            db: { sql_kind: kind, table, method: m, bound_shapes: argShapes(args) },
            error: shapeOfError(e)
          });
          throw e;
        }
        const cost = nowMs() - t0;
        let rows = null;
        if (m === 'run' && out && typeof out === 'object') rows = Number(out.changes) || 0;
        else if (Array.isArray(out)) rows = out.length;
        else if (m === 'get') rows = out === undefined ? 0 : 1;
        traceEvent('db', `${kind} ${table || 'sql'}`, {
          cost_ms: cost,
          status: 'ok',
          db: {
            sql_kind: kind,
            table,
            method: m,
            rows,
            // 写入语句记入参形状 = 「这次到底写了多大的数据」；读取语句只记参数个数。
            bound_shapes: isWrite ? argShapes(args) : (Array.isArray(args) ? args.length : 0)
          }
        });
        return out;
      }
    });
  }
  return wrapper;
}

// ---------- JSONL 落盘 ----------
// 明细节点量大（一次操作可达上千条），走「内存行缓冲 + 定期批量追加」：
// 既避免每条节点一次同步 I/O 阻塞事件循环，也保证崩溃时最多丢 1 秒的数据。
const NODE_FLUSH_MS = 1000;
let nodeBuf = [];
let lastNodeFlushAt = 0;

function appendNode(opId, node) {
  // 会话文件已关闭（已写 session-end）后拒绝任何迟到写入：
  // 停录瞬间在途请求的收尾节点只进内存供界面查看，不再追加到已封卷的 JSONL，
  // 否则「node 行出现在 session-end 之后」会把自描述文件的结构破坏掉。
  if (state.sessionClosed) return;
  if (!state.recording && !als.getStore()) return;
  try {
    nodeBuf.push(JSON.stringify({ type: 'node', opId, at: node.at, node }, jsonSafeReplacer));
  } catch (_) {
    return; // 序列化失败（循环引用等）直接跳过该节点
  }
  if (nodeBuf.length >= 200 || nowMs() - lastNodeFlushAt >= NODE_FLUSH_MS) flushNodeBuf();
}

function flushNodeBuf() {
  lastNodeFlushAt = nowMs();
  if (!nodeBuf.length) return;
  const payload = nodeBuf.join('\n') + '\n';
  nodeBuf = [];
  try {
    ensureDir();
    fs.appendFileSync(sessionFileName(state.sessionId || 'session'), payload);
  } catch (_) { /* 落盘失败不影响业务 */ }
}

/** 公开的落盘入口：把内存里的节点缓冲刷到 JSONL（会话结束、进程退出前调用）。 */
export function flushTraceFile() {
  flushNodeBuf();
}

// 录制中的定期落盘：保证长录制期间数据持续在盘上（崩溃最多丢 1 秒）。
const nodeFlushTimer = setInterval(() => {
  if (state.recording || nodeBuf.length) flushNodeBuf();
}, NODE_FLUSH_MS);
if (typeof nodeFlushTimer.unref === 'function') nodeFlushTimer.unref();

// 会话级记录（session-start / op-end / session-end）走得很少，直接同步追加，
// 保证 JSONL 里「节点行」与「操作摘要行」的相对顺序稳定、且会话结束时数据已在盘上。
function appendLine(record) {
  // session-end 是唯一允许写在关闭之后的记录（它就是关闭动作本身）。
  if (state.sessionClosed && record.type !== 'session-end') return;
  try {
    flushNodeBuf(); // 先落节点，保证同一操作内节点在摘要行之前
    ensureDir();
    const line = JSON.stringify(record, jsonSafeReplacer) + '\n';
    fs.appendFileSync(sessionFileName(state.sessionId || 'session'), line);
  } catch (_) { /* 落盘失败不影响业务 */ }
}

// JSON 序列化兜底：BigInt 与函数不让整条记录写失败。
function jsonSafeReplacer(key, value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  return value;
}

/** 保留策略：只留最近 KEEP_SESSIONS 个会话文件。 */
export function pruneSessions(keep = KEEP_SESSIONS) {
  try {
    ensureDir();
    const files = fs.readdirSync(DEBUG_DIR)
      .filter((f) => f.startsWith('trace-') && f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(DEBUG_DIR, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch (_) { /* 忽略 */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    let removed = 0;
    for (const f of files.slice(keep)) {
      try {
        fs.unlinkSync(f.full);
        removed += 1;
      } catch (_) { /* 忽略 */ }
    }
    return { total: files.length, removed };
  } catch (_) {
    return { total: 0, removed: 0 };
  }
}

export function listSessions() {
  try {
    ensureDir();
    const current = path.basename(sessionFileName(state.sessionId));
    return fs.readdirSync(DEBUG_DIR)
      .filter((f) => f.startsWith('trace-') && f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(DEBUG_DIR, f);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch (_) { /* 忽略 */ }
        return { file: f, size, mtime: mtime ? new Date(mtime).toISOString() : '', current: f === current };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch (_) {
    return [];
  }
}

/** 读某个会话文件（回看用）：返回会话头尾与按操作分组的节点。 */
export function readSession(file, { nodeLimit = 0 } = {}) {
  const safe = String(file || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!safe || !/^trace-.+\.jsonl$/.test(safe)) return null;
  const full = path.join(DEBUG_DIR, safe);
  if (!path.resolve(full).startsWith(path.resolve(DEBUG_DIR))) return null;
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (_) {
    return null;
  }
  const ops = new Map();
  let sessionStart = null;
  let sessionEnd = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (rec.type === 'session-start') {
      sessionStart = rec;
    } else if (rec.type === 'session-end') {
      sessionEnd = rec;
    } else if (rec.type === 'op-end') {
      const cur = ops.get(rec.opId) || { opId: rec.opId, summary: null, nodes: [] };
      cur.summary = rec.summary;
      if (rec.render) cur.render = rec.render;
      if (rec.toast) cur.toast = rec.toast;
      ops.set(rec.opId, cur);
    } else if (rec.type === 'node' && rec.node) {
      const cur = ops.get(rec.opId) || { opId: rec.opId, summary: null, nodes: [] };
      if (!nodeLimit || cur.nodes.length < nodeLimit) cur.nodes.push(rec.node);
      ops.set(rec.opId, cur);
    }
  }
  return {
    file: safe,
    session_start: sessionStart,
    session_end: sessionEnd,
    ops: Array.from(ops.values())
  };
}

export function purgeSessions() {
  nodeBuf = []; // 丢弃未落盘缓冲，避免清空后又写回旧数据
  try {
    ensureDir();
    let removed = 0;
    for (const f of fs.readdirSync(DEBUG_DIR)) {
      if (!f.startsWith('trace-') || !f.endsWith('.jsonl')) continue;
      try {
        fs.unlinkSync(path.join(DEBUG_DIR, f));
        removed += 1;
      } catch (_) { /* 忽略 */ }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function traceConfigInfo() {
  return {
    dir: DEBUG_DIR,
    max_nodes_per_op: MAX_NODES_PER_OP,
    max_ops_in_memory: MAX_OPS_IN_MEMORY,
    keep_sessions: KEEP_SESSIONS,
    exclude_prefixes: TRACE_EXCLUDE_PREFIXES,
    exclude_exact: Array.from(TRACE_EXCLUDE_EXACT)
  };
}

// ---------- HTTP 集成 ----------
function pathnameOf(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch (_) {
    return String(req.url || '').split('?')[0];
  }
}

function headerValue(req, name) {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * 为一次 HTTP 请求建立追踪上下文。
 *
 * 实测约束：AsyncLocalStorage 的上下文只在 als.run() 的回调**及其派生的异步链**里有效，
 * 无法用 enterWith 从别的监听器「跨界」注入。因此必须由请求回调自己调用本函数，
 * 并让它的回调返回「整段请求处理链」：
 *
 *   server.on('request', (req, res) => traceRequest(req, res, () => handleRequest(req, res)));
 *
 * 未录制、或被排除的路径（/api/debug、/api/logs 等）→ 直接执行 fn，零开销。
 */
export function traceRequest(req, res, fn) {
  if (!state.recording) return fn();
  const pathname = pathnameOf(req);
  if (isExcludedPath(pathname)) return fn();
  const opId = sanitizeOpId(headerValue(req, 'x-trace-op'));
  let title = '';
  const rawTitle = headerValue(req, 'x-trace-title');
  if (rawTitle) {
    try {
      title = decodeURIComponent(String(rawTitle)).slice(0, 120);
    } catch (_) {
      title = String(rawTitle).slice(0, 120);
    }
  }
  if (!title) title = `${req.method} ${pathname}`;
  const op = beginOp(opId, title, { source: opId ? 'client' : 'server' });
  op.pendingRequests = (op.pendingRequests || 0) + 1;
  return als.run(op, () => {
    // res 的 finish/close 在本次 run 的上下文内注册，因此能正确落到这条操作上。
    res.on('finish', () => {
      op.pendingRequests = Math.max(0, (op.pendingRequests || 0) - 1);
      // 一次操作可能触发多个 HTTP 请求：保留「最糟糕」的状态码（max），
      // 避免后续的 200 把先前某个 500 覆盖掉，掩盖操作里的失败请求。
      op.httpStatus = Number.isFinite(op.httpStatus) ? Math.max(op.httpStatus, res.statusCode) : res.statusCode;
    });
    res.on('close', () => {
      if (res.writableFinished) return;
      op.httpStatus = Number.isFinite(op.httpStatus) ? Math.max(op.httpStatus, res.statusCode || 499) : (res.statusCode || 499);
    });
    return fn();
  });
}