// 前端真实执行验证：用最小 DOM 桩在 Node 里加载并运行 public/app.js，
// 验证「🐞 运行追踪」页能真实渲染、开关能切换、客户端节点能产生并上报。
// 这不是替代人工点击，而是排除「运行时抛错 / 渲染为空 / 逻辑不通」这类硬故障。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'app.js');
const src = fs.readFileSync(APP, 'utf8');
// 跨文件契约断言要用到仓库根（server.js 的响应形状）。由本文件位置反推，
// 不写死作者机器的绝对路径——README 让所有用户跑这个脚本，写死路径换台机器就 ENOENT。
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

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
  // 桩必须让 textContent 与 innerHTML 互见：浏览器里 el.textContent='x' 之后 innerHTML 就是 'x'。
  // 早先两者各存各的，于是"产品用 textContent 写状态"的路径在断言里永远是空的（假失败/假绿都可能）。
  get textContent() { return this._text || ''; }
  set textContent(v) { this._text = String(v); this._html = String(v); }
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
  '#log-more': mkEl('log-more', 'button'),
  // AI 设置页「工具与记忆库」三张卡：卡内状态区由异步加载回填，
  // 因此必须在这里登记，否则 renderOpenVikingStatus/renderEnvTools 找不到容器、
  // 直接 return —— 断言会变成"永远为空"的假绿。
  '#ov-status': mkEl('ov-status'),
  '#dsh-status': mkEl('dsh-status'),
  '#tools-list': mkEl('tools-list'),
  '#ov-endpoint-input': mkEl('ov-endpoint-input', 'input'),
  '#ov-key-input': mkEl('ov-key-input', 'input'),
  '#dsh-repo-input': mkEl('dsh-repo-input', 'input'),
  '#stale-banner': mkEl('stale-banner')
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
// 可切换的桩状态：stale = 模拟「页面是新版、服务进程还是旧代码」→ 新接口一律 404 API not found
// directEmptyOnce = 模拟实测现象「思考 token 吃光 max_tokens → 空回复」；blueprintAsProse = 模拟模型跳过蓝图直接给正文
const stub = { stale: false, directEmptyOnce: false, blueprintAsProse: false };
const directCalls = []; // /api/ai/write 的请求体（用于断言"空回复重试"真的换了参数）
const fetchStub = async (url, opts = {}) => {
  requests.push({ url: String(url), method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  const u = String(url);
  let json = {};
  let status = 200;
  if (stub.stale && (u.includes('/api/novel/openviking') || u.includes('/api/env/tools'))) {
    json = { error: 'API not found' };
    status = 404;
  } else
  if (u.includes('/api/ai/write')) {
    directCalls.push(JSON.parse(String(opts.body || '{}')));
    if (stub.directEmptyOnce && directCalls.length === 1) json = { reply: '' }; // 思考吃光预算 → 空回复
    else if (stub.blueprintAsProse) json = { reply: '这是没有蓝图标记的正文。\n\n第二段。' }; // 降级路径
    else json = { reply: '重试后拿到的正文' };
  }
  // ⚠️ 桩必须与服务端契约同形：/api/novel/scan 返回的是 { kind, pattern, note, count, sample }，
  // **没有 word**。此前桩里写的是 { word: … }，于是"前端读错字段名"这个真实缺陷被桩掩盖了。
  else if (u.includes('/api/novel/scan')) json = { ok: true, total: 1, hits: [{ kind: 'phrase', pattern: '嘴角勾起', note: '', count: 1, sample: '他嘴角勾起一抹笑' }] };
  else if (u.includes('/api/debug/state')) json = { ok: true, state: { recording: false }, config: {} };
  else if (u.includes('/api/debug/start')) json = { ok: true, recording: true, session_id: 'test-session' };
  else if (u.includes('/api/debug/stop')) json = { ok: true, recording: false, summary: { ops: 1, nodes: 3, prompt_tokens: 10, completion_tokens: 5 } };
  else if (u.includes('/api/debug/op')) json = { ok: true, summary: { opId: 'x' } };
  else if (u.includes('/api/debug/ops')) json = { ok: true, ops: [], tools: [], summary: {} };
  else if (u.includes('/api/debug/sessions')) json = { ok: true, sessions: [{ file: 'trace-a.jsonl', size: 1024, mtime: '2026-09-14T10:00:00.000Z', current: true }] };
  else if (u.includes('/api/works')) json = [];
  else if (u.includes('/api/api_configs')) json = [];
  else if (u.includes('/api/novel/openviking')) {
    json = {
      ok: true,
      endpoint: 'http://127.0.0.1:1933',
      endpoint_source: 'default',
      endpoint_source_label: '默认值',
      api_key_source: 'cli',
      api_key_source_label: '~/.openviking/ovcli.conf',
      has_api_key: true,
      config_paths: { cli: 'C:/Users/x/.openviking/ovcli.conf', conf: 'C:/Users/x/.openviking/ov.conf' },
      workshop: { endpoint: '', api_key_mask: '', has_api_key: false },
      semantic: { setting_enabled: true, effective_enabled: true },
      healthy: true,
      pending: 0,
      work_root: 'viking://user/default/resources/novel-studio'
    };
  } else if (u.includes('/api/env/tools')) {
    json = {
      ok: true,
      node: { version: 'v24.19.0', sqlite_ok: true, note: '' },
      server: { port: 3738, pid: 1, data_dir: 'C:/tmp/ns/data', log_dir: 'C:/tmp/ns/data/logs' },
      dsh: {
        dir: 'C:/fake/deepseek-harness', source: 'sibling', found: true, built: true, looks_like_dsh: true,
        checked: [{ source: 'sibling', label: '工坊仓库同级的 deepseek-harness', dir: 'C:/fake/deepseek-harness', ok: true }],
        override: '', profile: 'novel', settings_file: 'C:/fake/.dsh-novel/settings.yaml',
        task_home: { home: 'C:/fake/.dsh-novel', path: 'C:/fake/.dsh-novel', ambient: '', overridesAmbient: false },
        plugin: {
          dir: 'C:/repo/harness-plugins/novel-writing', exists: true,
          installs: [{ home: 'C:/fake/.dsh-novel', profile: 'novel', path: 'C:/fake/.dsh-novel/profiles/novel/node_modules/novel-writing', exists: true, points_here: true, is_link: true }],
          installed: true,
          gui_preset: { path: 'C:/fake/.dsh/.agent-presets/novel-writing', exists: false }
        }
      },
      openviking: {
        endpoint: 'http://127.0.0.1:1933', endpoint_source: 'default', endpoint_source_label: '默认值',
        api_key_source: 'cli', api_key_source_label: '~/.openviking/ovcli.conf', has_api_key: true,
        config_paths: { cli: 'C:/Users/x/.openviking/ovcli.conf', conf: '' },
        setting_enabled: true, effective_enabled: true, pending: 0
      }
    };
  }
  return { ok: status === 200, status, headers: new Map(), text: async () => JSON.stringify(json), json: async () => json, blob: async () => ({}) };
};

const sandbox = {
  document: doc,
  // getSelection 必须有：`buildAIWritingInitialRequest` 会调它，缺了会抛错并被上层的 catch 吞掉——
  // 结果是"测试跑到了函数、但根本没走到被测分支"（第一版第 11 段的假绿就是这么来的）。
  window: { addEventListener: () => {}, removeEventListener: () => {}, getSelection: () => null, location: { href: 'http://127.0.0.1:3738/' } },
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
  extractReviewFromText, extractJSONFromText,
  HELP_TEXT, helpDot, fieldHelp, helpTitle, renderToolRows, TOOL_SPECS, loadOpenVikingStatus, loadEnvTools,
  tooltipHtmlFor,
  state, openLastReview, htmlNodeToText, editorPlainText, diffParagraphs,
  parseRevisionPatches, applyRevisionPatches, tryApplyRevisionOutput, buildAIRevisionPatchPrompt, buildAIRevisionPrompt,
  WRITING_DISCIPLINE, buildAIWritingBlueprintPrompt, buildAIReviewPrompt, buildRedlineScanText, showReviewDiff, mergeReviewDiff, revisionBaseArticle, chapterTitleOf, aiContextTruncated, directAIWrite,
  performToolbarAIWrite
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

// ==================== 新手引导：AI 设置页三张卡 + 界面内帮助 ====================
// 背景：刚下载仓库的人不知道 OpenViking / dsh 是什么、装在哪，也不知道 SillyTavern、
// 章节作者注、剧情线和大纲分别是什么关系。这一段把"界面上真的能看到""数据真的接到了
// 渲染点"钉住——只写接口不接线，测试全绿也等于没交付（2026-09-14 的教训）。

// --- 1) AI 设置页渲染出三张卡与关键控件 ---
try {
  P.goView('ai');
  await P.render();
} catch (e) {
  check('35 打开 AI 设置页', false, e.message);
}
const aiHtml = String(containers['#content'].innerHTML);
check('35 AI 设置页渲染出 OpenViking 记忆库卡', aiHtml.includes('id="ov-card"') && aiHtml.includes('id="ov-endpoint-input"') && aiHtml.includes('id="ov-key-input"'));
check('36 AI 设置页渲染出 dsh 创作内核卡', aiHtml.includes('id="dsh-card"') && aiHtml.includes('id="dsh-repo-input"'));
check('37 AI 设置页渲染出工具与环境清单卡', aiHtml.includes('id="tools-card"') && aiHtml.includes('id="tools-list"'));
check('38 卡片操作按钮齐备', ['save-ov-config', 'write-ov-global', 'clear-ov-key', 'save-dsh-repo', 'refresh-env-tools', 'open-folder', 'test-ov-connection'].every((a) => aiHtml.includes(`data-action="${a}"`)));
check('39 页面标题上真的挂了帮助标记', aiHtml.includes('class="help-dot"') && aiHtml.includes('data-help="model_policy"'));
// ⚠️ 「版本不一致横幅」此前只断言了桩元素（containers['#stale-banner']）被写入——
// 而那个元素在桩里是**预注册**的：把 app.js 里渲染它的那行删掉，63/64 依然全绿，
// 真机上横幅却永不出现（典型的"桩里有、真机没有"）。这里补上"HTML 里真的有它"。
check('39b AI 设置页真的渲染了横幅容器（不只是桩里存在）', aiHtml.includes('id="stale-banner"'));

// --- 2) 异步加载真的把状态回填到状态区（"改了要能看到"） ---
await new Promise((r) => setTimeout(r, 400));
const ovStatusHtml = String(containers['#ov-status'].innerHTML);
check('40 OpenViking 卡回填了生效地址与来源', ovStatusHtml.includes('127.0.0.1:1933') && ovStatusHtml.includes('默认值'), ovStatusHtml.slice(0, 90));
check('41 OpenViking 卡回填了连接状态', ovStatusHtml.includes('服务在线'));
check('42 Key 输入框给出「留空则沿用」的提示', String(containers['#ov-key-input'].placeholder).includes('留空'), String(containers['#ov-key-input'].placeholder).slice(0, 60));
const toolsHtml = String(containers['#tools-list'].innerHTML);
check('43 工具清单渲染出四类工具', ['Node.js', 'DeepSeek Harness', 'novel-writing', 'OpenViking'].every((n) => toolsHtml.includes(n)));
check('44 工具清单状态来自检测结果（版本号来自接口）', toolsHtml.includes('已安装 v24.19.0'), toolsHtml.slice(0, 60));
check('45 插件行报告真实安装位置', toolsHtml.includes('已装到 C:/fake/.dsh-novel'));
check('46 清单带安装地址与可复制命令', toolsHtml.includes('nodejs.org') && toolsHtml.includes('data-action="copy-text"') && toolsHtml.includes('git clone'));
const dshStatusHtml = String(containers['#dsh-status'].innerHTML);
check('47 dsh 卡回填路径来源与实际路径', dshStatusHtml.includes('工坊仓库隔壁的 deepseek-harness') && dshStatusHtml.includes('C:/fake/deepseek-harness'), dshStatusHtml.slice(0, 90));

// --- 3) 清单状态是**推导**的，不是写死的文案 ---
const envStub = (dsh) => ({ dsh: { checked: [], plugin: { exists: false, installs: [] }, ...dsh } });
check('48 dsh 未找到时清单显示「未找到」', P.renderToolRows(envStub({ found: false, built: false }), null).includes('未找到'));
check('49 找到了但不是 dsh 仓库时如实提示', P.renderToolRows(envStub({ found: true, looks_like_dsh: false, built: false }), null).includes('不像 dsh 仓库'));
const readyRows = P.renderToolRows(envStub({ found: true, looks_like_dsh: true, built: true, dir: 'X:/dsh', plugin: { exists: true, installs: [{ home: 'H', profile: 'novel', exists: true, points_here: true }] } }), { healthy: true, has_api_key: true, endpoint: 'http://x' });
check('50 全就绪时清单显示「已就绪」并报出安装位置', readyRows.includes('已就绪') && readyRows.includes('已装到 H'));
check('51 清单状态里掺入的 HTML 被转义', (() => {
  const html = P.renderToolRows(envStub({ found: true, looks_like_dsh: true, built: true, dir: '<img src=x onerror=alert(1)>' }), null);
  return !html.includes('<img') && html.includes('&lt;img');
})());

// --- 4) 帮助文案：没有死条目、没有拼错的 key ---
// 死条目判据与"导出符号 → 外部引用数"是同一条纪律：HELP_TEXT 里每个 key 都必须能在
// app.js 里找到真实调用点，否则它就是一段永远不会被任何人看到的文案。
const helpKeys = Object.keys(P.HELP_TEXT);
const usedKeys = new Set();
for (const m of src.matchAll(/helpDot\('([a-z_]+)'\)|fieldHelp\('([a-z_]+)'|helpTitle\('([a-z_]+)'\)/g)) {
  usedKeys.add(m[1] || m[2] || m[3]);
}
check('52 没有永远不会显示的帮助文案（死条目）', helpKeys.every((k) => usedKeys.has(k)), helpKeys.filter((k) => !usedKeys.has(k)).join(','));
check('53 helpDot/fieldHelp 的 key 都真实存在（拼错不会静默变空白）', [...usedKeys].every((k) => k in P.HELP_TEXT), [...usedKeys].filter((k) => !(k in P.HELP_TEXT)).join(','));
check('54 用户点名的术语既写好了解释、也真的挂到了界面上', ['sillytavern', 'chapter_note', 'plotline', 'outline', 'plotline_vs_outline'].every((k) => k in P.HELP_TEXT && usedKeys.has(k)));
check('55 帮助标记可悬停也可键盘聚焦', String(P.helpDot('sillytavern')).includes('data-help="sillytavern"') && String(P.helpDot('sillytavern')).includes('tabindex="0"'));
check('56 未知 key 不产生半个空标签', P.helpDot('not_a_real_key') === '' && P.fieldHelp('not_a_real_key') === '');
check('57 字段小字把说明写进了 DOM', String(P.fieldHelp('plotline_vs_outline')).includes('两种看法'));

// --- 5) 悬停气泡：帮助标记与词条链接共用同一个取值函数 ---
const bubble = P.tooltipHtmlFor({ classList: { contains: () => false }, dataset: { help: 'sillytavern' } });
check('58 悬停帮助标记能取到标题与解释', String(bubble).includes('SillyTavern 设置') && String(bubble).includes('tt-body'));
check('59 未知帮助 key 不产生空气泡', P.tooltipHtmlFor({ classList: { contains: () => false }, dataset: { help: 'nope' } }) === '');
check('60 词条链接没有缓存时不产生空气泡', P.tooltipHtmlFor({ classList: { contains: (c) => c === 'term-link' }, dataset: { termId: '999999' } }) === '');

// --- 6) 服务端还在跑旧代码时，界面必须说人话（这次真实踩到过：404 "API not found"） ---
// 症状：页面文件来自磁盘（新版），进程是重启前启动的（旧代码）→ 新接口一律 404。
// 新手看到 "API not found" 只会以为软件坏了；它其实只有一个动作：重启服务。
stub.stale = true;
await P.loadEnvTools();
await P.loadOpenVikingStatus();
check('61 旧服务端时清单给出可执行的提示（而不是 API not found）', String(containers['#tools-list'].innerHTML).includes('重启') && !String(containers['#tools-list'].innerHTML).includes('API not found'), String(containers['#tools-list'].innerHTML).slice(0, 70));
check('62 OpenViking 卡同样翻译成可执行提示', String(containers['#ov-status'].innerHTML).includes('重启'));
check('63 页面顶部出现版本不一致横幅', containers['#stale-banner'].hidden === false && String(containers['#stale-banner'].innerHTML).includes('重启'));
stub.stale = false;
await P.loadEnvTools();
await P.loadOpenVikingStatus();
check('64 服务端恢复正常后横幅自动消失', containers['#stale-banner'].hidden === true && String(containers['#tools-list'].innerHTML).includes('Node.js'));

// --- 7) 审稿路径的 HTML→纯文本：必须保留段落（用户点「查看上次审稿」真实报过 plainText is not defined） ---
{
  const el = (tag, children) => ({ nodeType: 1, tagName: tag, childNodes: children });
  const tx = (v) => ({ nodeType: 3, nodeValue: v });
  const p = (v) => el('P', [tx(v)]);

  const two = P.htmlNodeToText(el('DIV', [p('第一段'), p('第二段')]));
  check('65 段落之间保留空行（差异比对据此分段）', two === '第一段\n\n第二段', JSON.stringify(two));
  check('66 该文本能被 diffParagraphs 切成多段', P.diffParagraphs(two, two).length >= 2, `tokens=${P.diffParagraphs(two, two).length}`);
  check('67 行内 <br> 只断一行、不制造新段落', P.htmlNodeToText(el('DIV', [el('P', [tx('上'), el('BR', []), tx('下')])])) === '上\n下');
  check('68 块内多余空白折叠、首尾去空', P.htmlNodeToText(el('DIV', [el('P', [tx('  前   后  ')])])) === '前 后');
  check('69 script/style 内容不进正文', P.htmlNodeToText(el('DIV', [el('SCRIPT', [tx('alert(1)')]), el('STYLE', [tx('p{}')]), p('正文')])) === '正文');
  check('70 空输入给空串，不制造假正文', P.htmlNodeToText(null) === '' && P.editorPlainText('') === '');
  check('71 解析器不可用时原样返回（而不是静默交空白给 AI）', P.editorPlainText('<p>x</p>', () => null) === '<p>x</p>');
  check('72 走完整解析路径（注入解析器）', P.editorPlainText('<p>甲</p><p>乙</p>', () => ({ querySelector: () => el('DIV', [p('甲'), p('乙')]) })) === '甲\n\n乙');

  // 用户真实路径：点「查看」打开上次审稿，不能抛错，报告要真的渲染出来
  P.state.chapterReview = { chapter_id: 1, parsed: true, report: { summary: '总评', issues: ['问题一'], strengths: ['优点一'] } };
  let reviewErr = '';
  try { await P.openLastReview(); } catch (e) { reviewErr = e.message; }
  check('73 打开「上次审稿」不再抛错', reviewErr === '', reviewErr);
  check('74 审稿报告真的渲染进了弹窗', String(containers['#modal-root'].innerHTML).includes('AI 审稿报告') && String(containers['#modal-root'].innerHTML).includes('总评'));
}

// --- 9) 修稿改为"只改被勾选的问题段"：补丁解析 + 逐段写回（①） ---
// 背景：整章重写要让模型把 5000+ 字原样吐一遍（2026-09-18 实测一条修稿 8 分 25 秒仍在生成）。
// 补丁式把它降到几百字。代价是引入"定位"，所以这里把三条底线钉死：
// 能解析、只改命中的段、**定位不到必须进 unresolved（可见）**。
{
  const article = ['第一段：陈默走进雨里。', '第二段：他摸到一枚芯片。', '第三段：芯片开口说话。'].join('\n\n');
  const strict = JSON.stringify({
    patches: [
      { issue: 1, anchor: '第二段：他摸到一枚芯片。', revised: '第二段：他在积水中摸到一枚发烫的芯片。' },
      { issue: 2, anchor: '第三段：芯片开口说话。', revised: '第三段：芯片忽然开口，声音像旧收音机。' }
    ]
  });
  const parsed = P.parseRevisionPatches(strict);
  check('77 严格 JSON 补丁可解析', Array.isArray(parsed) && parsed.length === 2, `patches=${parsed && parsed.length}`);
  const applied = P.applyRevisionPatches(article, parsed);
  check('78 只改命中的段落，未涉及的段落一字不动', applied.text.includes('第一段：陈默走进雨里。') && applied.text.includes('发烫的芯片') && applied.applied.length === 2);
  check('79 段落仍以空行分隔（差异预览按 \\n{2,} 分段）', applied.text.split(/\n{2,}/).length === 3, JSON.stringify(applied.text.split(/\n{2,}/).length));
  check('80 该结果能被 diffParagraphs 正确切成 3 段', P.diffParagraphs(article, applied.text).length >= 3, `tokens=${P.diffParagraphs(article, applied.text).length}`);

  // 畸形引号：与审稿报告同一类瑕疵（模型在字符串值末尾多吐一个引号）——必须仍能抢救
  const broken = '{"patches":[{"issue":1,"anchor":"第二段：他摸到一枚芯片。","revised":"第二段：他在积水中摸到芯片。”"},{"issue":2,"anchor":"第三段：芯片开口说话。","revised":"第三段：芯片开口了。"}]}';
  // ⚠️ 诚实标注（第四轮重审 + 独立复核）：这条载荷**是合法的严格 JSON**（值里的 `”` 只是普通字符），
  // 所以 81/82 测的是"值里带全角引号不影响解析"，**不是**抢救路径——
  // 独立复核质疑"删掉抢救代码 81/82 仍绿"，成立；抢救层的覆盖见下面 80c/80d（新增）。
  // 前提断言把这件事钉住：载荷若变成非严格 JSON，这里会立刻报警提示改标注。
  let strictOk = true;
  try { JSON.parse(broken); } catch { strictOk = false; }
  check('80b 前提：这条载荷是合法严格 JSON（故 81/82 只覆盖"全角引号"，不覆盖抢救）', strictOk === true);
  const salvaged = P.parseRevisionPatches(broken);
  check('81 值里带全角引号（”）仍能正常解析', Array.isArray(salvaged) && salvaged.length === 2, `patches=${salvaged && salvaged.length}`);
  check('82 该结果里的 anchor 仍可用于定位', !!salvaged && P.applyRevisionPatches(article, salvaged).applied.length === 2);

  // 第三层：抢救分支。载荷里的裸引号（值中间的引号）会让"修引号重试"也失败 ——
  // 这正是真实模型会吐出的形态（对话里的引号没转义）。前两层都失败才会走到这里。
  const brokenSalvage = '{"patches":[{"issue":1,"anchor":"第二段：他摸到一枚芯片。","revised":"第二段：他说"芯片"两个字。"},{"issue":2,"anchor":"第三段：芯片开口说话。","revised":"第三段：芯片开口了。"}]}';
  check('80c 前提：这条载荷连"修引号重试"都救不回（才会落到抢救分支）',
    P.extractJSONFromText(brokenSalvage) === null);
  const salvagedDeep = P.parseRevisionPatches(brokenSalvage);
  check('80d 抢救分支真的能从裸引号里取出 anchor/revised（删掉它这组必红）',
    Array.isArray(salvagedDeep) && salvagedDeep.length === 2
    && P.applyRevisionPatches(article, salvagedDeep).applied.length === 2,
    `patches=${salvagedDeep && salvagedDeep.length}`);

  // 定位不到 / 内容为空：必须进 unresolved，绝不静默丢弃
  const miss = P.applyRevisionPatches(article, [{ issue: 3, anchor: '第四段：这段在正文里根本不存在。', revised: '第四段：改后。' }]);
  check('83 定位不到的改动进 unresolved 且不改正文', miss.applied.length === 0 && miss.unresolved.length === 1 && miss.text === article, JSON.stringify(miss.unresolved[0] && miss.unresolved[0].reason));
  const emptyRevised = P.applyRevisionPatches(article, [{ issue: 4, anchor: '第一段：陈默走进雨里。', revised: '   ' }]);
  check('84 改后内容为空的补丁被拒并说明原因', emptyRevised.applied.length === 0 && /revised/.test(emptyRevised.unresolved[0].reason), emptyRevised.unresolved[0].reason);
  // 模糊退让只对足够长的 anchor 生效（避免误改）。真实场景：模型漏抄了段末句号。
  const longPara = '第二段：他摸到一枚芯片，指尖被烫得一缩。';
  const fuzzyArticle = ['第一段：陈默走进雨里。', longPara, '第三段：芯片开口说话。'].join('\n\n');
  const fuzzy = P.applyRevisionPatches(fuzzyArticle, [{ issue: 5, anchor: '他摸到一枚芯片，指尖被烫得一缩', revised: '第二段：他摸到两枚芯片，指尖被烫得一缩。' }]);
  check('85 长 anchor 允许"包含"式退让命中（模型漏抄尾标点）', fuzzy.applied.length === 1 && fuzzy.text.includes('两枚芯片'), `applied=${fuzzy.applied.length}`);
  const tooShort = P.applyRevisionPatches(article, [{ issue: 6, anchor: '芯片', revised: '晶片' }]);
  check('86 过短的 anchor 不参与模糊匹配（防误改）', tooShort.applied.length === 0 && tooShort.unresolved.length === 1);

  // 统一入口：ok / 回退 / 空补丁
  const okOut = P.tryApplyRevisionOutput(strict, article);
  check('87 tryApplyRevisionOutput：补丁可用时返回 ok', !!okOut && okOut.ok === true && okOut.applied.length === 2);
  check('88 解析不出补丁时返回 null（调用方回退整章重写）', P.tryApplyRevisionOutput('这不是 JSON', article) === null);
  check('89 空补丁清单也走回退（不假装成功）', P.tryApplyRevisionOutput('{"patches":[]}', article) === null);
  check('90 补丁都定位不到时 ok=false（调用方据此回退）', (() => { const r = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ anchor: '不存在的段落。', revised: 'x' }] }), article); return !!r && r.ok === false && r.unresolved.length === 1; })());

  // 提示词契约：必须要求 JSON 补丁、只改相关段落、anchor 逐字
  const prompt = P.buildAIRevisionPatchPrompt(article, ['问题一', '问题二']);
  check('91 补丁提示词含 JSON 契约与 anchor/revised 字段', prompt.includes('"patches"') && prompt.includes('anchor') && prompt.includes('revised'));
  check('92 补丁提示词明确"只改相关段落、其余不要输出"', /只修改/.test(prompt) && /不要输出/.test(prompt));
  check('93 补丁提示词带上确认清单', prompt.includes('1. 问题一') && prompt.includes('2. 问题二'));
  check('94 整章重写提示词仍保留（兜底路径）', P.buildAIRevisionPrompt(article, ['问题一']).includes('完整正文'));
}
// --- 10) 写作路径提速（S1/S2/S3）：纪律内联、截断回退、空回复重试 ---
{
  // S1：蓝图提示词必须带上内联的写作纪律（直连通道没有插件人设）
  const bp = P.buildAIWritingBlueprintPrompt('续写本章', [], 2000, true);
  check('95 蓝图提示词内联了写作纪律（直连没有插件人设）', bp.includes('【写作纪律（务必遵守）】') && bp.includes('已按预算截断'), bp.length + ' 字');
  check('96 纪律常量本身含"不要编造与既有设定冲突的内容"', /不要编造与既有设定冲突/.test(P.WRITING_DISCIPLINE));
  check('96b 蓝图专用那条（references）只出现在蓝图提示词里', bp.includes('references') );

  // S2：审稿提示词内联确定性红线扫描（慢通道的工具优势被抵消）
  const withScan = P.buildAIReviewPrompt('正文内容', '命中 1 处：嘴角勾起×1');
  const withoutScan = P.buildAIReviewPrompt('正文内容');
  check('97 审稿提示词带确定性红线扫描结果', withScan.includes('【确定性红线扫描结果') && withScan.includes('嘴角勾起'));
  check('98 扫描不可用时不出现空标题（不编造"零命中"）', !withoutScan.includes('【确定性红线扫描结果'));
  check('98b 审稿提示词不带蓝图专用字段（references 对不上审稿的 JSON 契约）', !withoutScan.includes('写进 references'));

  // ⚠️ 第四轮重审抓到的真缺陷：S2 的扫描文本用了 `h.word`，而服务端返回的是 `pattern`
  // —— 提示词里实际是「命中 6 处：undefined×3」，模型拿到的是噪声（却还被要求"与扫描一致"）。
  // 下面三条：① 渲染必须用真实字段；② 零命中不编造；③ 字段名与服务端契约同源（跨文件）。
  const scanText = P.buildRedlineScanText({
    total: 2,
    hits: [
      { kind: 'phrase', pattern: '嘴角勾起', note: '', count: 2, sample: '' },
      { kind: 'word', pattern: '微微', note: '', count: 1, sample: '' }
    ]
  });
  check('98c 扫描文本按服务端字段渲染，不出现 undefined',
    scanText.includes('嘴角勾起×2') && scanText.includes('微微×1') && !scanText.includes('undefined'), scanText);
  check('98d 零命中时不编造命中项', P.buildRedlineScanText({ total: 0, hits: [] }) === '零命中（这篇正文没有触发任何红线词句）');
  {
    // 跨文件字段契约（这类"字段名对不上"已栽过三次：plainText、trace.nodes、scan.word）。
    // 前提断言：两侧都必须真读到东西，否则"都没读到"会伪装成"一致"。
    //
    // ⚠️ 扫描前**必须剥掉注释**：app.js 里恰恰有一行注释写着「这里曾读 `h.word`」——
    // 不剥注释就会把反面教材当成真实缺陷，报出 `缺=[word]` 的假红
    // （仓库里已有同款教训：verify-all.mjs 的视图路由扫描也因此先剥注释）。
    const stripComments = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    const appCode = stripComments(src);
    const srvSrc = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
    const pushM = srvSrc.match(/hits\.push\(\{([^}]*)\}\)/);
    const srvFields = pushM ? pushM[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean) : [];
    const appReads = [...new Set([...appCode.matchAll(/\bh\.(pattern|word|note|count|sample|kind)\b/g)].map((m) => m[1]))];
    const missing = appReads.filter((f) => !srvFields.includes(f));
    check('98e 扫描命中字段名与服务端契约一致（防 h.word 这类错位）',
      srvFields.length >= 5 && appReads.length > 0 && missing.length === 0,
      `服务端=[${srvFields.join(',')}] 前端读=[${appReads.join(',')}] 缺=[${missing.join(',') || '无'}]`);
  }

  // S1 的截断判据：只在"上下文完整"时才允许走直连
  P.state.aiContext = null;
  check('99 取不到上下文时保守判为截断（宁可慢）', P.aiContextTruncated() === true);
  P.state.aiContext = { context_manifest: [{ label: 'a', truncated: false, dropped: 0 }], context_stats: { truncatedLayers: 0 } };
  check('100 无截断时允许走直连', P.aiContextTruncated() === false);
  P.state.aiContext = { context_manifest: [{ label: 'a', truncated: true, dropped: 680 }] };
  check('101 有截断层时回退慢通道（工具能取回被截断原文）', P.aiContextTruncated() === true);
  P.state.aiContext = { context_overflow: { dropped: 10 } };
  check('102 溢出同样判为截断', P.aiContextTruncated() === true);

  // S3：空回复 → 用「低思考预算 + 更大上限」重试一次（实测：思考会把 max_tokens 吃光）
  P.state.apiConfigs = [{ id: 1, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 4096 }];
  P.state.activeConfigId = 1;
  directCalls.length = 0;
  stub.directEmptyOnce = true;
  const reply = await P.directAIWrite([{ role: 'user', content: '写点东西' }], {});
  check('103 首次空回复后重试并拿到内容', reply === '重试后拿到的正文', String(reply));
  check('104 确实发生了两次调用', directCalls.length === 2, directCalls.length + ' 次');
  check('105 重试时压低思考预算为 low', directCalls[1] && directCalls[1].reasoning_effort === 'low', JSON.stringify(directCalls[1] && directCalls[1].reasoning_effort));
  check('106 重试时放宽输出上限（≥8192）', directCalls[1] && Number(directCalls[1].max_tokens) >= 8192, String(directCalls[1] && directCalls[1].max_tokens));
  stub.directEmptyOnce = false;

  // 修稿差异预览的**计数口径**：一次修稿只有一个事实，标题与正文不许给出两个互斥的数。
  // 第四轮重审抓到的形态：接回进度时标题写「按 0 条清单修改」（把 applied 当成清单条数），
  // 而同一弹窗正文写「有 2 条改动没能自动定位」。顺带钉住正文里不再泄漏 Markdown 的 `**`。
  {
    const opened = [];
    const realOpenModal = sandbox.openModal;
    sandbox.openModal = (o) => { opened.push({ title: String((o && o.title) || ''), body: String((o && o.body) || '') }); };
    P.showReviewDiff('第一段。\n\n第二段。', '第一段改。\n\n第二段。', { applied: 2, notes: ['anchor 未找到：某某段'] });
    P.showReviewDiff('甲段。', '乙段。', { checklist: 3, applied: 2 });
    sandbox.openModal = realOpenModal;
    check('107a 只知"改好几处"时标题不借用"按 N 条清单"口径',
      opened[0].title.includes('实际改好 2 处') && !opened[0].title.includes('清单'), opened[0].title);
    check('107b 正常流程同时给出清单条数与实际改好处数',
      opened[1].title.includes('按 3 条清单修改') && opened[1].title.includes('实际改好 2 处'), opened[1].title);
    check('107c 未定位提示不再泄漏 Markdown 字面量（**）', !opened[0].body.includes('**'));
    check('107d 未定位条数与正文一致（不再出现标题/正文互斥）',
      opened[0].body.includes('有 1 条改动没能自动定位'), '');
  }

  // 跨章归属（第四轮重审的遗留项）：修稿要跑几分钟，期间切章是正常操作。
  // 旧实现按"当前打开的章"合并 → 把 A 章的修稿稿整篇写进 B 章（B 章原文只剩历史版本）。
  {
    P.state.chapters = [{ id: 107, title: '第107章' }, { id: 108, title: '第108章' }];
    P.state.currentChapterId = 108;
    const modals = [];
    const realOpen = sandbox.openModal;
    sandbox.openModal = (o) => { modals.push({ title: String(o.title || ''), body: String(o.body || '') }); };
    P.showReviewDiff('甲。', '乙。', { applied: 1, chapterId: 107 });
    sandbox.openModal = realOpen;
    check('107e 差异预览把章号绑定到"修稿那一章"（不是当前打开的章）',
      Number(P.state.pendingReviewDiff && P.state.pendingReviewDiff.chapterId) === 107,
      String(P.state.pendingReviewDiff && P.state.pendingReviewDiff.chapterId));
    check('107f 看的不是那一章时，弹窗明确说明会写回哪一章',
      modals[0].body.includes('第107章') && modals[0].body.includes('第108章'),
      modals[0].body.slice(0, 70));

    // 合并：必须写回 107（当前打开的是 108）
    const calls = [];
    const msgs = [];
    const saved = {
      api: sandbox.api, toast: sandbox.toast, applySelectedProposals: sandbox.applySelectedProposals,
      loadWorkData: sandbox.loadWorkData, render: sandbox.render, closeModal: sandbox.closeModal
    };
    sandbox.api = async (url, opts = {}) => { calls.push({ url: String(url), body: opts.body }); return { ok: true }; };
    sandbox.toast = (m) => { msgs.push(String(m)); };
    sandbox.applySelectedProposals = () => {};
    sandbox.loadWorkData = async () => {};
    sandbox.render = async () => {};
    sandbox.closeModal = () => {};
    P.state.pendingReviewDiff = { newText: '乙。', chapterId: 107 };
    await P.mergeReviewDiff();
    Object.assign(sandbox, saved);
    const mergeCall = calls.find((c) => c.url.includes('/novel/chapter_save'));
    check('107g 合并写回的是修稿所属的那一章（不是当前打开的章）',
      !!mergeCall && Number(mergeCall.body && mergeCall.body.chapter_id) === 107,
      JSON.stringify(mergeCall && mergeCall.body && mergeCall.body.chapter_id));
    check('107h 跨章合并后明确告知写到了哪一章', msgs.some((m) => m.includes('第107章')), msgs.join(' | ').slice(0, 70));

    // 底稿按章取：目标章 ≠ 当前章 → 取那一章已保存的正文；相等 → 用编辑器（不额外请求）
    const editor = mkEl('editor-content');
    editor.innerHTML = '<p>当前章正文</p>';
    containers['#editor-content'] = editor;
    const fetchCalls = [];
    const realApi2 = sandbox.api;
    sandbox.api = async (url) => { fetchCalls.push(String(url)); return { id: 107, content: '<p>目标章正文</p>' }; };
    const otherBase = await P.revisionBaseArticle(107);
    const sameBase = await P.revisionBaseArticle(108);
    sandbox.api = realApi2;
    check('107i 目标章不是当前章时：取那一章已保存的正文当补丁底稿',
      otherBase === P.editorPlainText('<p>目标章正文</p>') && fetchCalls.some((u) => u.includes('/chapters/107')),
      JSON.stringify({ otherBase, fetchCalls }));
    check('107j 目标章就是当前章时：用编辑器正文（含未保存改动），不发多余请求',
      sameBase === P.editorPlainText(editor.innerHTML) && !fetchCalls.some((u) => u.includes('/chapters/108')),
      JSON.stringify({ sameBase }));
    check('107k 章节标题查不到时退回 #id（不显示 undefined）',
      P.chapterTitleOf(999) === '#999' && P.chapterTitleOf(107) === '第107章',
      `${P.chapterTitleOf(999)} / ${P.chapterTitleOf(107)}`);
  }
}

// --- 11) 回归：AI 写作"降级路径"必须真的能跑通（重审抓到的 ReferenceError） ---
// 背景：把蓝图轮改成"直连优先 + 慢通道回退"时，慢通道那条路的结果被写进了 if 块内的 `const data`，
// 而两个降级分支（模型跳过蓝图直接给正文 / 兜底按原文交付）在**块外**引用它 → 运行时 ReferenceError，
// 而 node --check 完全看不见。这条测试就是让那个分支真的被执行一次。
{
  P.state.aiContext = { assembled: '上下文', context_manifest: [], context_stats: { truncatedLayers: 0 } };
  P.state.apiConfigs = [{ id: 1, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 4096 }];
  P.state.activeConfigId = 1;
  P.state.currentChapterId = 107;
  P.state.workId = 2;
  P.state.work = { id: 2, title: '测试作品' };
  P.state.chapters = [{ id: 107, title: '第107章', content: '<p>原文</p>' }];
  containers['#editor-content'] = mkEl('editor-content');
  containers['#editor-content'].innerHTML = '<p>原文</p>';
  containers['#editor-content'].dataset = { chapterId: '107' };
  let resultOpened = 0;
  const realShowResult = sandbox.showAIWritingResult;
  const realApply = sandbox.applyAIWritingArticle;
  const realToast = sandbox.toast;
  const toastMsgs = [];
  sandbox.showAIWritingResult = async () => { resultOpened += 1; return null; };
  sandbox.applyAIWritingArticle = async () => {};
  sandbox.toast = (m, t) => { toastMsgs.push(String(m)); return realToast(m, t); };
  const clientLogs = [];
  const realReport = sandbox.reportClientLog;
  sandbox.reportClientLog = (o) => { clientLogs.push(String(o && o.message || '')); return realReport && realReport(o); };
  const realCardFn = sandbox.showAITaskProgress;
  let cardInv = 0;
  sandbox.showAITaskProgress = (...a) => { cardInv += 1; return realCardFn(...a); };
  const realDirectFn = sandbox.directAIWrite;
  let directInv = 0;
  sandbox.directAIWrite = async (...a) => { directInv += 1; return realDirectFn(...a); };
  stub.blueprintAsProse = true;
  containers['#modal-root'].innerHTML = ''; // 清干净：下面要断言"没有出现错误框"
  let degradeErr = '';
  try { await P.performToolbarAIWrite('续写本章'); } catch (e) { degradeErr = e.message; }
  stub.blueprintAsProse = false;
  // ⚠️ 只断言"没往外抛"是不够的：这条 bug 的 ReferenceError 会被 performToolbarAIWrite 自己的 catch
  // 吞掉并弹「AI 写作未完成」错误框（变异测试实测：只查抛错的断言在 bug 面前照样绿）。
  // 所以这里必须同时查"没有错误框"，与 108 一起才算真的钉住。
  const errModalShown = String(containers['#modal-root'].innerHTML).includes('AI 写作未完成');
  check('107 模型跳过蓝图直接给正文时既不抛错、也不弹错误框', degradeErr === '' && !errModalShown,
    `err=${degradeErr} errModal=${errModalShown} toasts=${JSON.stringify(toastMsgs.slice(0, 2))}`);
  check('108 该降级路径确实走到了结果弹窗', resultOpened === 1,
    `opened=${resultOpened} cardInv=${cardInv} directInv=${directInv} directCalls=${directCalls.length} logs=${JSON.stringify(clientLogs.slice(0, 2))} trunc=${P.aiContextTruncated()} ctx=${JSON.stringify(P.state.aiContext).slice(0, 60)}`);
  sandbox.showAIWritingResult = realShowResult;
  sandbox.applyAIWritingArticle = realApply;
  sandbox.toast = realToast;
}

// --- 8) 派生式护栏：浏览器脚本不得调用"只存在于服务端"的函数 ---
// 它来自一个真实缺陷：v0.9.3 的提交里 public/app.js 有三处 `plainText(editor.innerHTML)`，
// 而那个提交从未在任何地方定义 plainText（前端从来没有过这个函数）→ 点「查看上次审稿」
// 必抛 ReferenceError。node --check、接口套件、当时的前端断言**全都看不见**它：
// 语法合法、路径没被断言覆盖。所以这里把判据做成**派生**的：
// 收集仓库根目录（服务端文件）里的所有函数名，凡 app.js 也在调用、却在自己文件里找不到
// 定义的，就是这类"幽灵调用"。
{
  // ⚠️ APP 在 public/ 下，服务端文件在它的**上一级**。第一版这里写的是 path.dirname(APP)，
  // 于是只读到了 app.js 自己 → 服务端函数名一个都没收集到 → 判据恒为空、护栏永远绿。
  // 这是变异测试抓出来的（把 plainText 调用放回去，护栏居然照样 PASS）。
  // 现在改成"往上找，直到看见 server.js"，并加一条前提断言：连已知样本都看不见就直接红。
  let ROOT_DIR = path.dirname(APP);
  if (!fs.existsSync(path.join(ROOT_DIR, 'server.js'))) ROOT_DIR = path.dirname(ROOT_DIR);
  const serverFiles = fs.readdirSync(ROOT_DIR).filter((f) => f.endsWith('.js'));
  const serverSrc = serverFiles.map((f) => fs.readFileSync(path.join(ROOT_DIR, f), 'utf8')).join('\n');
  const fnNames = (s) => new Set([...s.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const serverFns = fnNames(serverSrc);
  // 阴性对照 / 护栏自检：plainText 是服务端真实存在的函数，用它证明"确实读到了服务端源码"。
  check('75 护栏前提成立：读到了服务端函数名（以 plainText 为已知样本）', serverFns.has('plainText') && serverFiles.length >= 3, `${ROOT_DIR} 文件=${serverFiles.length} 函数名=${serverFns.size}`);
  const appDefined = new Set([
    ...fnNames(src),
    ...[...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    // 解构声明也算定义：`const { readZip } = await import(...)` 这种写法此前被判成幽灵调用
    // （插件侧的 readZip 就是这样被误报的）。宁可多收（`{a: b}` 会把 a、b 都算定义），
    // 也不能漏收——假红会磨损红灯信任。
    ...[...src.matchAll(/(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]\s*=/g)]
      .flatMap((m) => [...m[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]))
  ]);
  const ghosts = [...serverFns].filter((n) => !appDefined.has(n) && new RegExp('\\b' + n + '\\s*\\(').test(src));
  check('76 没有"只存在于服务端"的幽灵调用', ghosts.length === 0, ghosts.join(','));
}

// 停止录制
await P.traceStop();
check('18 停止后退出录制态', P.trace.on === false);
check('19 停止后按钮恢复未录制显示', String(doc.getElementById('trace-toggle').textContent).includes('运行追踪'));

P.traceStopStream();
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
