// 前端真实执行验证：用最小 DOM 桩在 Node 里加载并运行 public/app.js，
// 验证「🐞 运行追踪」页能真实渲染、开关能切换、客户端节点能产生并上报。
// 这不是替代人工点击，而是排除「运行时抛错 / 渲染为空 / 逻辑不通」这类硬故障。
import fs from 'node:fs';
import vm from 'node:vm';

const APP = 'C:/Users/a1941/Desktop/DeepSeek/novel-studio/public/app.js';
const src = fs.readFileSync(APP, 'utf8');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
};

// ---------- 最小 DOM 桩 ----------
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.id = '';
    this.className = '';
    this.classList = {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertAdjacentHTML(_pos, html) { this._html += String(html); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  getAttribute() { return null; }
  querySelector(sel) { return globalThis.__doc ? globalThis.__doc.querySelector(sel) : null; }
  querySelectorAll() { return []; }
  closest(sel) {
    // 只用于 e.target.closest('[data-action]')：桩元素自身带 dataset.action 时命中
    if (sel === '[data-action]' && this.dataset && this.dataset.action) return this;
    return null;
  }
  focus() {}
  click() {}
  contains() { return false; }
}

const registered = new Map();
function mkEl(idOrTag, tag = 'div') {
  const el = new El(tag);
  if (idOrTag) { el.id = idOrTag; registered.set(`#${idOrTag}`, el); }
  return el;
}

// 关键容器
const containers = {
  '#content': mkEl('content', 'main'),
  '#sidebar': mkEl('sidebar', 'aside'),
  '#trace-toggle': mkEl('trace-toggle', 'button'), // 桩不解析 innerHTML，单独登记顶栏按钮
  '#topbar-right': mkEl('topbar-right'),
  '#sidebar-nav': mkEl('sidebar-nav'),
  '#toast-root': mkEl('toast-root'),
  '#modal-root': mkEl('modal-root'),
  '#search-results': mkEl('search-results'),
  '#sidebar-title': mkEl('sidebar-title'),
  '#topbar-title': mkEl('topbar-title'),
  '#global-search': mkEl('global-search', 'input'),
  '#tooltip': mkEl('tooltip'),
  '#ai-task-progress': mkEl('ai-task-progress'),
  '#sidebar-toggle': mkEl('sidebar-toggle', 'button'),
  '#log-list': mkEl('log-list'),
  '#log-stats': mkEl('log-stats'),
  '#log-more': mkEl('log-more', 'button')
};

const doc = {
  getElementById: (id) => registered.get(`#${id}`) || null,
  querySelector: (sel) => containers[sel] || registered.get(sel) || null,
  querySelectorAll: () => [],
  createElement: (tag) => new El(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new El('body'),
  documentElement: new El('html'),
  hidden: false,
  visibilityState: 'visible'
};
globalThis.__doc = doc;

const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
};

// 记录所有出站请求，供断言客户端上报行为
const requests = [];
const fetchStub = async (url, opts = {}) => {
  requests.push({ url: String(url), method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  const u = String(url);
  let json = {};
  if (u.includes('/api/debug/state')) json = { ok: true, state: { recording: false }, config: {} };
  else if (u.includes('/api/debug/start')) json = { ok: true, recording: true, session_id: 'test-session' };
  else if (u.includes('/api/debug/stop')) json = { ok: true, recording: false, summary: { ops: 1, nodes: 3, prompt_tokens: 10, completion_tokens: 5 } };
  else if (u.includes('/api/debug/op')) json = { ok: true, summary: { opId: 'x' } };
  else if (u.includes('/api/debug/ops')) json = { ok: true, ops: [], tools: [], summary: {} };
  else if (u.includes('/api/debug/sessions')) json = { ok: true, sessions: [{ file: 'trace-a.jsonl', size: 1024, mtime: '2026-09-14T10:00:00.000Z', current: true }] };
  else if (u.includes('/api/works')) json = [];
  else if (u.includes('/api/api_configs')) json = [];
  return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(json), json: async () => json, blob: async () => ({}) };
};

const sandbox = {
  document: doc,
  window: { addEventListener: () => {}, removeEventListener: () => {}, location: { href: 'http://127.0.0.1:3738/' } },
  navigator: { sendBeacon: () => true, userAgent: 'node-stub' },
  location: { href: 'http://127.0.0.1:3738/', hash: '', pathname: '/' },
  localStorage: storage(),
  sessionStorage: storage(),
  fetch: fetchStub,
  performance: { now: () => Date.now() },
  console,
  JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Map, Set, WeakMap, WeakSet,
  Error, TypeError, RangeError, RegExp, Symbol, Proxy, Reflect, Intl,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  URL, URLSearchParams, Blob: class { constructor() {} }, AbortController: class { constructor() { this.signal = {}; } },
  AbortSignal: { timeout: () => ({}) },
  TextDecoder: class { decode() { return ''; } }, TextEncoder: class {},
  EventSource: class { constructor() {} close() {} },
  DOMParser: class { parseFromString() { return { body: new El('body') }; } },
  Node: { ELEMENT_NODE: 1 }, Element: El, HTMLElement: El,
  crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2, 10) },
  structuredClone: (x) => JSON.parse(JSON.stringify(x)),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  alert: () => {}, confirm: () => true, prompt: () => null
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// ---------- 运行 ----------
// 注意：app.js 里的 `const trace` / `function ...` 是脚本级词法绑定，不会挂到 vm 上下文对象上，
// 因此把「探针」拼进同一段脚本一起执行，由它把需要的引用导出到 globalThis.__probe。
const probeSrc = `
globalThis.__probe = {
  trace, goView, render, api, toast,
  traceToggle, traceStop, traceWrapHandler, traceHeaders, traceApiRecord,
  traceStart, traceStopStream, traceRenderTopbarButton, traceOpSummary, renderTraceList, traceShape, traceCallerLocation,
  traceUpsertOp, traceHandleStreamItem, traceFilteredOps, normalizeTraceSummary,
  extractReviewFromText, extractJSONFromText
};
`;
const ctx = vm.createContext(sandbox);
let runtimeError = null;
try {
  new vm.Script(src + probeSrc, { filename: 'app.js' }).runInContext(ctx, { timeout: 20000 });
} catch (e) {
  runtimeError = e;
}
check('1 app.js 在最小 DOM 环境下无顶层运行时错误', !runtimeError, runtimeError ? runtimeError.message : '');
if (runtimeError) {
  console.log('\n--- 栈 ---');
  console.log(runtimeError.stack);
  process.exit(1);
}
const P = sandbox.__probe;
check('1b 探针成功取出追踪模块引用', !!P && !!P.trace && typeof P.traceToggle === 'function');
if (!P) process.exit(1);

// init() 是异步的，等它跑完
await new Promise((r) => setTimeout(r, 800));

check('2 顶栏注入了运行追踪开关按钮', String(containers['#topbar-right'].innerHTML).includes('trace-toggle'));
check('3 追踪开关按钮带录制态样式钩子', String(containers['#topbar-right'].innerHTML).includes('trace-btn'));

// 切到追踪页并渲染
try {
  P.goView('trace');
  await P.render();
} catch (e) {
  check('4 打开追踪页渲染', false, e.message);
}
const contentHtml = String(containers['#content'].innerHTML);
check('4 追踪页渲染出工具栏与列表容器', contentHtml.includes('trace-page') && contentHtml.includes('trace-list') && contentHtml.includes('trace-toolbar'));
check('5 追踪页含开始/停止录制按钮', contentHtml.includes('data-action="trace-toggle"'));
check('6 追踪页含筛选与历史录制区', contentHtml.includes('trace-only-error') && contentHtml.includes('trace-sessions-list'));
check('7 追踪页说明了「不记正文」与慢通道边界', contentHtml.includes('不记录正文') || contentHtml.includes('不记录正文内容'));

// 开关：开启录制
P.traceToggle();
await new Promise((r) => setTimeout(r, 400));
check('8 点击开关后进入录制态', P.trace.on === true);
check('9 开启时向后端发起 /api/debug/start', requests.some((r) => r.url.includes('/api/debug/start')));
check('10 按钮切换为「录制中」', String(doc.getElementById('trace-toggle').textContent).includes('录制中'));

// 模拟一次被追踪的用户操作
requests.length = 0;
try {
  await P.traceWrapHandler('save-chapter', { dataset: { action: 'save-chapter' } }, async () => {
    await P.api('/works/1');
    return { ok: true, id: 1 };
  });
} catch (e) {
  check('11 追踪包装执行处理链', false, e.message);
}
await new Promise((r) => setTimeout(r, 500)); // 等待 scheduleOpFlush 的 150ms 收尾延迟
const reportReq = requests.find((r) => r.url.includes('/api/debug/op'));
check('11 处理链执行后回传客户端节点', !!reportReq);
if (reportReq) {
  const payload = JSON.parse(reportReq.body);
  check('12 上报内容含操作标题与节点', payload.title === '保存本章' && Array.isArray(payload.nodes) && payload.nodes.length >= 2, `title=${payload.title} nodes=${payload.nodes?.length}`);
  const kinds = (payload.nodes || []).map((n) => n.kind);
  check('13 节点含前端处理链与 API 调用', kinds.includes('fn') && kinds.includes('api'), `kinds=${kinds.join(',')}`);
  const apiNode = (payload.nodes || []).find((n) => n.kind === 'api');
  check('14 API 节点带代码位置与耗时', !!apiNode && Number.isFinite(apiNode.cost_ms) && !!apiNode.file, apiNode ? `${apiNode.file}:${apiNode.line}` : '');
  check('15 上报含渲染快照与状态', !!payload.render && payload.status === 'done', JSON.stringify(payload.render));
  const resultDump = JSON.stringify((payload.nodes || []).map((n) => n.result || {}));
  check('16 上报的形状摘要不含正文原文', !/小说正文|chapter content/i.test(resultDump), resultDump.slice(0, 80));
}
check('17 被追踪的 API 请求带 X-Trace-Op 头', requests.some((r) => r.headers && r.headers['X-Trace-Op']));

// ---- 回归：真实会话里「每个会话必崩」的记录格式（app.js:1174 op.nodes.push） ----
// 后端摘要里的 nodes 是「数量」，前端操作对象里的 nodes 是「数组」。
// 旧实现直接 { ...op, ...summary }，数组被计数覆盖成 number，下一条 SSE 节点帧必崩。
if (reportReq) {
  const payload = JSON.parse(reportReq.body);
  const opId = payload.op_id;
  // 复现真实时序：节点先到 → op-end 摘要到（旧实现此处把 nodes 变 number）→ 下一条节点帧
  const sum = { opId, title: '保存本章', status: 'done', cost_ms: 12, nodes: 4, errors: 0 };
  P.traceUpsertOp(sum);
  check('22 SSE 收到 op-end 摘要后 nodes 仍为数组', (() => {
    const o = P.trace.ops.find((x) => x.opId === opId);
    return !!o && Array.isArray(o.nodes);
  })());
  let crashed = '';
  try {
    P.traceHandleStreamItem({ type: 'node', opId, node: { kind: 'fn', name: '后到的节点', cost_ms: 1, status: 'ok' } });
  } catch (e) { crashed = e.message; }
  check('23 摘要之后到来的节点帧不再崩溃', crashed === '', crashed);
  check('24 摘要里的节点计数转入 nodeCount 且与数组长度并存', (() => {
    const s = P.traceOpSummary(P.trace.ops.find((x) => x.opId === opId));
    return s.nodes >= 1 && !!s.title;
  })(), `nodes=${P.traceOpSummary(P.trace.ops.find((x) => x.opId === opId)).nodes}`);
  check('25 合并服务端摘要不会清空本地已收节点', (() => {
    const o = P.trace.ops.find((x) => x.opId === opId);
    const before = o.nodes.length;
    P.traceUpsertOp({ opId, title: '保存本章', status: 'done', cost_ms: 12, nodes: 99, errors: 0 });
    const after = P.trace.ops.find((x) => x.opId === opId);
    return Array.isArray(after.nodes) && after.nodes.length === before && after.nodeCount === 99;
  })());
}

// ---- 回归：记录里有 error 节点，但摘要 errors: 0 / status: done（真实会话 blueprint-confirm / 取消节点） ----
P.trace.ops = [{
  opId: 'probe-err-op', title: 'error 节点未被计数', nodes: [], nodeCount: 0, updatedAt: Date.now(),
  summary: { opId: 'probe-err-op', title: 'error 节点未被计数', status: 'done', cost_ms: 6, nodes: 1, errors: 0 }
}];
P.traceHandleStreamItem({
  type: 'node', opId: 'probe-err-op',
  node: { kind: 'api', name: 'PUT /novel/chapter_blueprint', cost_ms: 6, status: 'error', error: { message: '蓝图内容不能为空' } }
});
check('26 列表级 errors 计入后到的 error 节点', P.traceOpSummary(P.trace.ops[0]).errors >= 1, `errors=${P.traceOpSummary(P.trace.ops[0]).errors}`);
P.trace.filters.onlyError = true;
check('27「只看错误」筛选能捞到这条操作', P.traceFilteredOps().some((o) => o.opId === 'probe-err-op'));
P.trace.filters.onlyError = false;

// ---- 回归：审稿报告 JSON 里多一个引号，绝不能再让整份报告作废 ----
// 样本取自 2026-09-14 真实事故：模型在 issues 值末尾多吐了一个引号，
// 形成 `…挪用。","},{"text":"…`，旧实现 JSON.parse 失败 → 3.6 分钟的审稿报告被整份丢弃。
{
  const broken = '{"summary":"本章完成度较高。","issues":[{"text":"第一条问题。”均与示例一字不差。","},{"text":"第二条问题：数字打架。"}],"strengths":[{"text":"反AI腔执行到位。"}]}';
  check('28 畸形 JSON 直接解析确实失败（样本有效性）', P.extractJSONFromText(broken) === null);
  const salvaged = P.extractReviewFromText(broken);
  check('29 畸形 JSON 仍能抢救出审稿报告', !!salvaged && salvaged.issues.length === 2, salvaged ? `issues=${salvaged.issues.length}` : 'null');
  check('30 抢救出的总评完整', !!salvaged && salvaged.summary === '本章完成度较高。', salvaged ? salvaged.summary : '');
  check('31 抢救出的优点未被丢弃', !!salvaged && salvaged.strengths.length === 1, salvaged ? `strengths=${salvaged.strengths.length}` : '');
  check('32 抢救出的问题文本未被截断', !!salvaged && salvaged.issues[0].includes('一字不差'), salvaged ? salvaged.issues[0].slice(-12) : '');
  check('32b 畸形尾巴的多余引号不残留在正文里', !!salvaged && !/["']$/.test(salvaged.issues[0]), salvaged ? JSON.stringify(salvaged.issues[0].slice(-6)) : '');
  // 合法 JSON 必须走严格解析、结果完全一致（不能被抢救逻辑改坏）
  const good = '{"summary":"总评","issues":[{"text":"A"}],"strengths":[{"text":"B"}]}';
  const strict = P.extractReviewFromText(good);
  check('33 合法 JSON 仍走严格解析且结果一致', !!strict && strict.summary === '总评' && strict.issues[0] === 'A' && strict.strengths[0] === 'B');
  check('34 完全不可解析时返回 null（交由上层存原文）', P.extractReviewFromText('这不是 JSON') === null);
}

// 停止录制
await P.traceStop();
check('18 停止后退出录制态', P.trace.on === false);
check('19 停止后按钮恢复未录制显示', String(doc.getElementById('trace-toggle').textContent).includes('运行追踪'));

P.traceStopStream();
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
