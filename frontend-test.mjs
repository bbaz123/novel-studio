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

// document 级监听器按类型留档：app.js 的全局 keydown（Esc / 资料检索回车）走 document 委托，
// 留档后测试才能真的把键盘事件送进去（click 不模拟：点击路径已由 handleAction 直调覆盖）。
const docListeners = new Map();
const doc = {
  getElementById: (id) => registered.get(`#${id}`) || null,
  querySelector: (sel) => containers[sel] || registered.get(sel) || null,
  querySelectorAll: () => [],
  createElement: (tag) => new El(tag),
  addEventListener: (type, fn) => { const list = docListeners.get(type) || []; list.push(fn); docListeners.set(type, list); },
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
// R09 桩：作者样文 / 文风档案 / 三级意图。桩也维护"服务端状态"：
// 这样断言的是"请求真的发出去了、界面用的是服务端回来的数据"，而不是本地状态自说自话。
const styleStub = {
  samples: [{ id: 5, work_id: 1, title: '我的旧作片段', text: '他推开门。', chars: 73, content_hash: 'd388e1f8c16df052', enabled: true }],
  stale: true,
  profile: {
    profile_version: '1.0.0',
    sample_set: { count: 1, chars: 73, hash: 'set-a33f821832b2d3b6', ids: [5] },
    metrics: {
      sentence_length: { value: { count: 12, mean: 18.25, p50: 17, p90: 33, distribution: {} }, unit: 'char', how: '按句末标点切句；长度按字符数' },
      dialogue_rate: { value: { paragraphs: 3, dialogue_paragraphs: 1, ratio: 0.333 }, unit: 'ratio', how: '段落里含引号的占比' },
      narration_person: { value: { third: 3, first: 0, second: 0 }, unit: 'paragraphs', how: '按段首人称词计数' },
      punctuation_per_1000: { value: { comma: 5 }, unit: 'per_1000_chars', how: '每 1000 字符出现次数' },
      paragraph_length: { value: { count: 3, mean: 23, long_ratio: 0 }, unit: 'char', how: '段落按空行切分；长度按字符数' },
      rhetoric_per_1000: { value: { metaphor: 13.7, parallel_paragraphs: 0 }, unit: 'per_1000_chars', how: '比喻提示词与排比段每 1000 字符次数' },
      emotion_per_1000: { value: 0, unit: 'per_1000_chars', how: '情绪直陈词每 1000 字符次数' },
      suspense_tail: { value: { ends_with_ellipsis: false, ends_with_question: true, unterminated: false }, unit: 'bool', how: '章末悬疑标记' }
    },
    habits: { openings: ['他推开门，风从'], closings: ['像一枚旧邮票。'], keep: ['短句收尾'], avoid: ['滥用叹号'] }
  },
  intents: [{ id: 1, work_id: 1, chapter_id: 0, tier: 'long_term', text: '保持克制的叙述，不要直白抒情', hard: true }],
  conflicts: [{ long_term_id: 1, other_tier: 'stage', other_id: 2, other_text: '不再克制，改成直白抒情', reason: '可能静默取消长期硬约束' }]
};
// R10 桩：故事状态总览 + 披露派生视图（只读派生，桩给一份"三档都有内容"的最小样本）
const storyStub = {
  enabled: true,
  disclosure: {
    cursor: { chapter_index: 2, chapter_id: 7, scene_index: null },
    fingerprint: 'disclosure-abcdef0123456789',
    rules: { effective_window: '在窗口内 ⇔ effective_from ≤ 当前章下标 且（effective_to 为空 或 effective_to > 当前章下标）。', undetermined: '没有任何知识记录的条目是「未定义」：既不算知道也不算不知道。' },
    items: [],
    author: { truth: [{ id: 2, label: '林昭 其实是 卧底', scope: 'AUTHOR_KNOWLEDGE', state: 'known', tier: 'author_truth', evidence: { chapter_index: 0, written: true } }], plan: [], retracted: [] },
    reader: {
      disclosed: [{ id: 1, label: '林昭 身份 潮汐会记账人', scope: 'CANON_KNOWLEDGE', state: 'known', tier: 'reader_disclosed', evidence: { chapter_index: 0, written: true } }],
      not_yet: [{ id: 3, label: '碎钟 残片 被收进匣子', scope: 'CANON_KNOWLEDGE', state: 'known', tier: 'not_yet_disclosed', evidence: { chapter_index: 2, written: false } }],
      future: [], private_not_disclosed: [], beliefs: [], disclosed_ids: [1]
    },
    characters: [{
      character_id: 9, name: '林昭',
      known: [{ fact_id: 1, label: '林昭 身份 潮汐会记账人' }], known_ids: [1], actionable_ids: [1],
      unknown: [{ fact_key: '旧约的内容' }], suspected: [], false_beliefs: [],
      undetermined: { count: 1, sample: ['暗格 藏着 一封没有署名的信'], ids: [9] }
    }],
    unknown: { no_evidence_ids: [5] },
    counts: { facts: 5 }
  }
};
// R11 桩：剧情分支沙盘。桩维护"服务端状态"：断言请求真的发出去、界面用的是服务端回来的数据。
// stale_now=true 是服务端**现算**的（内容哈希变了），不是候选自己存的标记。
const branchStub = {
  sandboxes: [{ id: 21, work_id: 1, chapter_id: 7, requested: 3, status: 'open', deps: { hash: 'sandbox-1111222233334444' }, progress: { done: 2, requested: 3, missing: 1, complete: false } }],
  candidates: [
    { id: 101, work_id: 1, sandbox_id: 21, chapter_id: 7, ordinal: 1, title: '潜入钟楼', core_action: '林昭潜入潮汐钟楼夺取钥匙', conflict: '用偷窃解决通行问题', counts: { choices: 1, beats: 2, consequences: 2, risks: 1, required_setup: 1, relations_foreshadows: 1 }, intent_stance: 'follows', status: 'candidate', stale: false, stale_now: true, stale_changed: ['content'], created_by: 'agent', deps_hash: 'sandbox-1111222233334444' },
    { id: 102, work_id: 1, sandbox_id: 21, chapter_id: 7, ordinal: 2, title: '正面质问', core_action: '林昭在账房当面质问账房先生', conflict: '摊牌的时机与代价', counts: { choices: 1, beats: 3, consequences: 1, risks: 1, required_setup: 0, relations_foreshadows: 0 }, intent_stance: 'neutral', status: 'candidate', stale: false, stale_now: false, stale_changed: [], created_by: 'author', deps_hash: 'sandbox-1111222233334444' },
    { id: 103, work_id: 1, sandbox_id: 21, chapter_id: 7, ordinal: 3, title: '已被丢弃的方向', core_action: '无关方向', conflict: '无关', counts: { choices: 0, beats: 0, consequences: 0, risks: 0, required_setup: 0, relations_foreshadows: 0 }, intent_stance: 'neutral', status: 'discarded', stale: false, stale_now: false, stale_changed: [], created_by: 'author', deps_hash: 'sandbox-1111222233334444' }
  ],
  submitted: []
};
// R12 桩：导入后分析重建。桩维护"服务端状态"：批次状态/计数被写操作改变，读接口回读。
const rebuildStub = {
  run: { id: 31, work_id: 1, status: 'planned', extractor_version: '1.0.0', schema_version: '1.0.0', route: { model: 'default', reasoning_effort: 'default' }, batch_size: 2, note: '' },
  batches: [
    { batch_index: 0, chapter_ids: [7, 8], chapter_indexes: [0, 1], chars: 1234, baseline_hash: 'rb-0000111122223333', db_status: 'pending', state: 'pending', reason: '本批尚未抽取', result_hash: '', attempts: 0, proposals: 0, proposal_ids: [], error: '' },
    { batch_index: 1, chapter_ids: [9], chapter_indexes: [2], chars: 600, baseline_hash: 'rb-4444555566667777', db_status: 'extracted', state: 'reuse', reason: '基线与结果均在，直接复用', result_hash: 'rboldresult123456', attempts: 1, proposals: 2, proposal_ids: [], error: '' }
  ],
  counts: { reuse: 1, stale: 0, pending: 1 },
  recorded: [], confirmed: [], cancelled: false
};
const rebuildProgress = () => ({
  batches: rebuildStub.batches.length,
  pending: rebuildStub.batches.filter((b) => b.db_status === 'pending').length,
  extracted: rebuildStub.batches.filter((b) => b.db_status === 'extracted').length,
  confirmed: rebuildStub.batches.filter((b) => b.db_status === 'confirmed').length,
  stale: rebuildStub.batches.filter((b) => b.db_status === 'stale').length,
  failed: rebuildStub.batches.filter((b) => b.db_status === 'failed').length,
  chars: rebuildStub.batches.reduce((n, b) => n + b.chars, 0),
  proposals: rebuildStub.batches.reduce((n, b) => n + b.proposals, 0)
});

// P4 桩：共享资料库（跨作品写作参考资料）。桩维护"服务端状态"：写操作改桩状态、读接口回读；
// 断言的是"请求真的发出去了、界面用的是服务端回来的数据"，而不是本地状态自说自话。
const libraryStub = {
  enabled: false,
  ov: { disabled: false, semantic_enabled: true, connected: true, pending_ops: 0 },
  docs: [
    { id: 41, category: '设定', slug: 'tide-ledger', title: '潮汐会的记账规矩', chars: 1200, bytes: 2600, est_chunks: 3, status: 'active', indexed_at: '2026-09-28T03:00:00', source_path: 'D:/写作资料/设定/tide-ledger.md', rel: '设定/tide-ledger.md', uri: 'viking://user/default/resources/novel-studio-library/设定/tide-ledger.md' },
    { id: 42, category: '风格', slug: 'short-lines', title: '短句范例', chars: 800, bytes: 1700, est_chunks: 2, status: 'active', indexed_at: '2026-09-27T21:00:00', source_path: 'D:/写作资料/风格/short-lines.md', rel: '风格/short-lines.md', uri: 'viking://user/default/resources/novel-studio-library/风格/short-lines.md' }
  ],
  // 读原文按 offset/limit 切片（34 行）：用于验证「窗口按行计」与翻页按钮的禁用状态
  docLines: Array.from({ length: 34 }, (_, i) => `第 ${i + 1} 行：潮汐会的规矩写在总册扉页上。`),
  docReads: []
};
function libraryStatusJson(workId) {
  const active = libraryStub.docs.filter((d) => d.status === 'active');
  const cats = [];
  for (const d of libraryStub.docs) {
    const hit = cats.find((c) => c.category === d.category);
    if (hit) hit.n += 1; else cats.push({ category: d.category, n: 1 });
  }
  return {
    ok: true,
    root: 'viking://user/default/resources/novel-studio-library',
    work_id: workId || null,
    enabled: workId ? libraryStub.enabled : null,
    ov: { ...libraryStub.ov },
    index: { key: 'ov_indexed_at:library', last_indexed_at: '2026-09-28T03:00:00' },
    summary: {
      total: libraryStub.docs.length,
      active: active.length,
      marked_missing: libraryStub.docs.filter((d) => d.status === 'marked_missing').length,
      bytes: libraryStub.docs.reduce((n, d) => n + d.bytes, 0),
      chars: libraryStub.docs.reduce((n, d) => n + d.chars, 0),
      categories: cats, last_indexed_at: '2026-09-28T03:00:00', last_updated_at: '2026-09-28T03:00:00'
    },
    docs: active.map((d) => ({ id: d.id, category: d.category, slug: d.slug, title: d.title, chars: d.chars, bytes: d.bytes, est_chunks: d.est_chunks, status: d.status, indexed_at: d.indexed_at, source_path: d.source_path })),
    ingest: { version: '1.0.0', exts: ['.md', '.txt'], max_file_bytes: 2097152, max_files: 500, ignore_dirs: ['node_modules', '.git'], symlink: '不跟随（文件与目录都跳过）' }
  };
}

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
  // R07：编辑规则（目录 + 选择 + 规则块预览）与确定性扫描端点
  else if (u.includes('/api/novel/editing/scan')) json = {
    ok: true,
    findings: [{ rule_id: 'deterministic:ai-tell', layer: 'deterministic', severity: 'low', paragraph: 0, excerpt: '空气仿佛凝固了', message: '命中机械表达：「仿佛」式比喻', suggestion: '改为具体动作 / 感官细节 / 潜台词。' }],
    skipped: [], scanned: { paragraphs: 3, chars: 30, deterministic: true, abilities: ['fiction-humanizer'], genre: 'general', task: 'review' }
  };
  else if (u.includes('/api/novel/editing')) json = {
    ok: true,
    catalog: {
      version: '1.0.0',
      tiers: [{ id: 'light', name: '轻度润色', summary: '最小改动' }, { id: 'deai', name: '去 AI 腔', summary: '保持剧情' }, { id: 'deep', name: '深度修稿', summary: '较大调整' }],
      abilities: [{ id: 'fiction-humanizer', name: '去 AI 腔（Humanizer）', summary: '识别机械表达', tasks: ['write', 'review'], genre_affinity: [] }],
      genres: [{ id: 'general', name: '通用' }, { id: 'mystery', name: '悬疑' }]
    },
    selection: { enabled: false, tier: 'light', abilities: [], genre: 'general' },
    block: { text: '', hash: '0000000000000000', version: '1.0.0', decisions: [], sources: [] }
  };
  // R09：作者样文 / 文风档案 / 三级意图（写操作改桩状态，读操作回读桩状态）
  else if (u.includes('/api/novel/style/samples')) {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'POST') {
      const body = JSON.parse(String(opts.body || '{}'));
      const s = { id: 9, work_id: 1, title: body.title || '', text: body.text || '', chars: String(body.text || '').length, content_hash: 'aaaaaaaaaaaaaaaa', enabled: true };
      styleStub.samples = [...styleStub.samples, s];
      json = { ok: true, work_id: 1, sample: s, counts: { total: styleStub.samples.length, enabled: styleStub.samples.filter((x) => x.enabled).length, chars: 100, enabled_chars: 100 }, sample_set_hash: 'set-new' };
    } else if (method === 'PUT') {
      const body = JSON.parse(String(opts.body || '{}'));
      styleStub.samples = styleStub.samples.map((s) => (s.id !== body.id ? s : (body.enabled === undefined
        ? { ...s, title: body.title !== undefined ? body.title : s.title, text: body.text !== undefined ? body.text : s.text }
        : { ...s, enabled: !!body.enabled })));
      json = { ok: true, work_id: 1, sample: styleStub.samples.find((s) => s.id === body.id) || null, counts: { total: styleStub.samples.length, enabled: styleStub.samples.filter((x) => x.enabled).length, chars: 73, enabled_chars: 73 }, sample_set_hash: 'set-a33f821832b2d3b6' };
    } else if (method === 'DELETE') {
      const id = Number((u.match(/[?&]id=(\d+)/) || [])[1] || 0);
      styleStub.samples = styleStub.samples.filter((s) => s.id !== id);
      json = { ok: true, work_id: 1, counts: { total: styleStub.samples.length, enabled: styleStub.samples.filter((x) => x.enabled).length, chars: 0, enabled_chars: 0 }, sample_set_hash: 'set-0' };
    } else {
      json = { ok: true, work_id: 1, samples: styleStub.samples, limits: { per_sample_chars: 20000, max_samples: 20, total_chars: 200000, min_sample_chars: 20 }, counts: { total: styleStub.samples.length, enabled: styleStub.samples.filter((x) => x.enabled).length, chars: 73, enabled_chars: 73 }, sample_set_hash: 'set-a33f821832b2d3b6' };
    }
  }
  else if (u.includes('/api/novel/style/profile')) {
    if ((opts.method || 'GET').toUpperCase() === 'POST') json = { ok: true, work_id: 1, profile: styleStub.profile, profile_hash: 'style-eb6c0b732c46fd60', semantic_status: 'not_run', replaced_previous: false, notes: {} };
    else json = { ok: true, work_id: 1, profile: styleStub.profile, profile_hash: 'style-eb6c0b732c46fd60', analysis_version: '1.0.0', semantic_status: 'not_run', stale: styleStub.stale, notes: {}, limits: {} };
  }
  else if (u.includes('/api/novel/author_intent')) {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'PUT') {
      const body = JSON.parse(String(opts.body || '{}'));
      const chapterId = Number(body.chapter_id) || 0;
      const found = styleStub.intents.find((x) => x.tier === body.tier && x.chapter_id === chapterId);
      if (found) { found.text = body.text; found.hard = !!body.hard; }
      else styleStub.intents.push({ id: 20 + styleStub.intents.length, work_id: 1, chapter_id: chapterId, tier: body.tier, text: body.text, hard: !!body.hard });
      json = { ok: true, work_id: 1, chapter_id: chapterId, saved: styleStub.intents.find((x) => x.tier === body.tier && x.chapter_id === chapterId), intents: styleStub.intents, merged: { resolved: [], conflicts: styleStub.conflicts, priority: [], note: '' } };
    } else if (method === 'DELETE') {
      json = { ok: true, work_id: 1, chapter_id: Number((u.match(/chapter_id=(\d+)/) || [])[1] || 0) };
    } else {
      json = { ok: true, work_id: 1, chapter_id: 0, intents: styleStub.intents, merged: { resolved: [], conflicts: styleStub.conflicts, priority: ['confirmed_story_constraints', 'chapter_contract', 'author_intent', 'generic_editing_rules'], note: '' }, tiers: [], priority: ['confirmed_story_constraints', 'chapter_contract', 'author_intent', 'generic_editing_rules'], block: '', samples: [], profile: null, evidence: { text: '', chars: 0, truncated: false, sample_ids: [] }, limits: {} };
    }
  }
  else if (u.includes('/api/novel/story_state')) json = {
    ok: true, work_id: 1, enabled: storyStub.enabled, facts: 5, timeline: 2, knowledge: 3, entities: 1, contracts: 1,
    proposals_pending: 0, proposals_stale: 0, snapshots: 1, validations: 0, state_hash: 'abcdef0123456789', kernel_version: '1.0.0'
  };
  else if (u.includes('/api/novel/state/disclosure')) json = { ok: true, work_id: 1, chapter_id: 7, chapter_title: '第一章', state_enabled: true, ...storyStub.disclosure };
  // R11：剧情分支沙盘（沙盘/候选/采纳/丢弃/取消/恢复/比较；写操作改桩状态）
  else if (/\/api\/novel\/branch\/sandboxes\/\d+\/(cancel|reopen)/.test(u)) {
    const id = Number((u.match(/sandboxes\/(\d+)/) || [])[1]);
    const op = (u.match(/\/(cancel|reopen)/) || [])[1];
    branchStub.sandboxes = branchStub.sandboxes.map((s) => (s.id === id ? { ...s, status: op === 'cancel' ? 'cancelled' : 'open' } : s));
    json = { ok: true, sandbox: { ...(branchStub.sandboxes.find((s) => s.id === id) || {}), progress: { done: 2, requested: 3, missing: 1, complete: false } }, resume: op === 'reopen' };
  }
  else if (u.includes('/api/novel/branch/sandboxes')) {
    if ((opts.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(opts.body || '{}'));
      const sb = { id: 22, work_id: 1, chapter_id: body.chapter_id, requested: body.requested, status: 'open', deps: { hash: 'sandbox-newnewnewnew0000' }, progress: { done: 0, requested: body.requested, missing: body.requested, complete: false } };
      branchStub.sandboxes = [...branchStub.sandboxes, sb];
      json = { ok: true, sandbox: sb, progress: sb.progress, deps: sb.deps, cursor: { chapter_index: 2 }, limits: { min_candidates: 2, max_candidates: 5 }, boundary: { candidates_are_facts: false } };
    } else {
      json = { ok: true, work_id: 1, chapter_id: 7, sandboxes: branchStub.sandboxes, limits: { min_candidates: 2, max_candidates: 5 }, note: '沙盘运行可取消/恢复：取消后已产出的候选仍可阅读；恢复只继续未完成槽位，不重跑已完成候选。' };
    }
  }
  else if (/\/api\/novel\/branch\/candidates\/\d+\/(adopt|discard)/.test(u)) {
    const id = Number((u.match(/candidates\/(\d+)/) || [])[1]);
    const op = (u.match(/\/(adopt|discard)/) || [])[1];
    branchStub.candidates = branchStub.candidates.map((c) => (c.id === id ? { ...c, status: op === 'adopt' ? 'adopted' : 'discarded' } : c));
    const c = branchStub.candidates.find((x) => x.id === id);
    json = op === 'adopt'
      ? { ok: true, candidate_id: id, candidate: c, adopted: { blueprint_written: true, contract_saved: false }, contract_saved: false }
      : { ok: true, candidate_id: id, candidate: c };
  }
  else if (/\/api\/novel\/branch\/candidates\/\d+/.test(u)) {
    const id = Number((u.match(/candidates\/(\d+)/) || [])[1]);
    const c = branchStub.candidates.find((x) => x.id === id) || branchStub.candidates[0];
    json = {
      ok: true, candidate: { ...c, stale_now: true, stale_changed: ['content'] }, current_deps: {},
      adoption_plan: { blueprint: { scene_goal: c.core_action, plot_points: '摸清换班时刻' }, contract_suggestion: { note: `来自剧情候选 #${id}（第一章）` }, never_touched: ['chapters.content', 'story_facts', 'story_events', 'character_knowledge', 'characters'], disclaimer: '只写蓝图' },
      boundary: {}
    };
  }
  else if (u.includes('/api/novel/branch/candidates')) {
    if ((opts.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(opts.body || '{}'));
      branchStub.submitted.push(body);
      const created = (body.candidates || []).map((c, i) => ({ id: 200 + i, work_id: 1, sandbox_id: body.sandbox_id || 21, chapter_id: body.chapter_id, ordinal: i + 1, title: c.title, core_action: c.core_action, conflict: c.conflict, counts: { choices: (c.character_choices || []).length, beats: 0, consequences: (c.consequences || []).length, risks: 0, required_setup: 0, relations_foreshadows: 0 }, intent_stance: 'neutral', status: 'candidate', created_by: 'author' }));
      json = { ok: true, work_id: 1, chapter_id: body.chapter_id, sandbox: { id: body.sandbox_id || 21, requested: 3 }, progress: { done: 3, requested: 3, missing: 0, complete: true }, candidates: created, distinctness: { ok: true, report: [] }, knowledge: [{ index: 0, status: 'checked', warnings: [] }], deps: {}, boundary: { candidates_are_facts: false } };
    } else {
      json = { ok: true, work_id: 1, chapter_id: 7, status: null, candidates: branchStub.candidates, current_deps: {}, limits: {}, note: 'stale_now 表示保存候选时的依赖基线（状态/正文/契约/作者意图/披露指纹）与现在不一致：旧候选仍可阅读，重新采纳必须先复核或重新生成。' };
    }
  }
  else if (u.includes('/api/novel/branch/compare')) {
    const body = JSON.parse(String(opts.body || '{}'));
    const ids = body.ids || [];
    json = {
      ok: true, work_id: 1,
      candidates: ids.map((id) => branchStub.candidates.find((c) => c.id === id)),
      comparisons: [{ a: { id: ids[0], title: '潜入钟楼' }, b: { id: ids[1], title: '正面质问' }, dimensions: [{ key: 'core_action', label: '核心行动', a: '潜入', b: '质问', same: false }, { key: 'risks', label: '风险', a: '守卫换班延迟', b: '守卫换班延迟', same: true }], differences: ['core_action'], same_count: 1, note: '只并列差异，不替作者打分或排序。' }],
      note: '只并列差异，不替作者打分或排序；未采纳的候选不是本书事实。'
    };
  }
  // R12：导入后分析重建（状态/规划/记录/确认/取消；写操作改桩状态）
  else if (u.includes('/api/import/rebuild/status')) json = {
    ok: true, work_id: 1, run: rebuildStub.run, batches: rebuildStub.batches, counts: rebuildStub.counts,
    progress: rebuildProgress(), rules: { version: '1.0.0', batch: '整本书不得作为一次请求发送', resume: '基线一致才复用，变化标 stale' },
    limits: { max_chapters_per_batch: 6, max_chars_per_batch: 12000 }, categories: [{ key: 'entity', label: '人物/实体' }]
  };
  else if (u.includes('/api/import/rebuild/plan')) {
    const body = JSON.parse(String(opts.body || '{}'));
    json = {
      ok: true, work_id: body.work_id, run: rebuildStub.run, batches: rebuildStub.batches, counts: rebuildStub.counts,
      progress: rebuildProgress(), rules: { version: '1.0.0' }, limits: { max_chapters_per_batch: 6 }, categories: [],
      note: '抽取由调用方按批执行：挑 state=pending/stale 的批次逐批跑，再用 record 记录结果；不要整本一次请求。'
    };
  }
  else if (u.includes('/api/import/rebuild/record')) {
    const body = JSON.parse(String(opts.body || '{}'));
    rebuildStub.recorded.push(body);
    const items = (body.result && body.result.items) || [];
    rebuildStub.batches = rebuildStub.batches.map((b) => Number(b.batch_index) === Number(body.batch_index)
      ? { ...b, db_status: 'extracted', state: 'reuse', result_hash: 'rbnewresult654321', attempts: 1, proposals: items.length }
      : b);
    json = { ok: true, run_id: 31, batch_index: body.batch_index, status: 'extracted', result_hash: 'rbnewresult654321', stats: { items: items.length, valid: items.length, conflicts: 0 }, proposals: items.length, skipped: [], note: '候选已记录（未写入任何正式状态）' };
  }
  else if (u.includes('/api/import/rebuild/confirm')) {
    const body = JSON.parse(String(opts.body || '{}'));
    rebuildStub.confirmed.push(body);
    const idx = Array.isArray(body.batch_indexes) && body.batch_indexes.length ? Number(body.batch_indexes[0]) : 1;
    rebuildStub.batches = rebuildStub.batches.map((b) => Number(b.batch_index) === idx ? { ...b, db_status: 'confirmed', proposal_ids: [701, 702] } : b);
    json = {
      ok: true, applied: 1, proposals_created: 2, stale: 0, skipped: 1,
      results: [{ batch_index: idx, verdict: 'confirmed', proposal_ids: [701, 702], applied_ops: 3, snapshot_id: 9 }],
      progress: rebuildProgress(), rebuild_complete: false,
      assembled: { story_state_enabled: true, context_ready: false, synced: true, note: '仍有未确认/过期的批次：不得宣称已完整重建（状态端点可查看剩余批次）。' }
    };
  }
  else if (u.includes('/api/import/rebuild/cancel')) {
    const body = JSON.parse(String(opts.body || '{}'));
    rebuildStub.cancelled = true;
    rebuildStub.run = { ...rebuildStub.run, status: 'cancelled' };
    json = { ok: true, run: rebuildStub.run, progress: rebuildProgress(), note: '已取消：已记录的批次结果保留，恢复时用 plan 带 run_id 继续（基线不一致的批次会标 stale）。' };
  }
  // P4：共享资料库（列表 / 检索 / 读原文 / 开关 / 导入 plan+confirm / 标记与删除；写操作改桩状态）
  else if (u.includes('/api/novel/library/')) {
    if (u.includes('/library/status')) {
      const workId = Number((u.match(/[?&]work_id=(\d+)/) || [])[1] || 0);
      json = libraryStatusJson(workId);
    } else if (u.includes('/library/search')) {
      const q = decodeURIComponent((u.match(/[?&]q=([^&]*)/) || [])[1] || '');
      const category = decodeURIComponent((u.match(/[?&]category=([^&]*)/) || [])[1] || '');
      const docs = libraryStub.docs.filter((d) => d.status === 'active' && (!category || d.category === category));
      const matched = q ? docs.filter((d) => `${d.title} ${d.slug} ${d.source_path}`.includes(q)) : [];
      const mode = q && matched.length ? 'semantic' : 'keyword';
      json = {
        ok: true, q, category, mode, total: docs.length,
        hits: matched.map((d) => ({
          id: d.id, category: d.category, slug: d.slug, title: d.title, uri: d.uri,
          score: mode === 'semantic' ? 87 : undefined,
          abstract: mode === 'semantic' ? '潮汐会记账：先记账，再谈情。' : undefined
        }))
      };
    } else if (u.includes('/library/doc/')) {
      // DELETE /api/novel/library/doc/:id —— 默认只标记缺失；confirm=1 才真删
      const id = Number((u.match(/\/library\/doc\/(\d+)/) || [])[1] || 0);
      const doc = libraryStub.docs.find((d) => d.id === id) || null;
      if (!doc) { json = { error: '资料不存在' }; status = 404; }
      else if (u.includes('confirm=1')) {
        libraryStub.docs = libraryStub.docs.filter((d) => d.id !== id);
        json = { ok: true, removed: doc.uri, id };
      } else {
        doc.status = 'marked_missing';
        json = { ok: true, marked_missing: true, doc: { id, status: 'marked_missing' }, hint: '默认只标记缺失；确认删除请带 confirm=1（会同时从记忆库删除该文件并删登记行）' };
      }
    } else if (u.includes('/library/doc')) {
      // GET /api/novel/library/doc?id=&offset=&limit= —— 服务端按行切片
      const id = Number((u.match(/[?&]id=(\d+)/) || [])[1] || 0);
      const offset = Number((u.match(/[?&]offset=(\d+)/) || [])[1] || 0);
      const limit = Number((u.match(/[?&]limit=(\d+)/) || [])[1] || 30);
      const doc = libraryStub.docs.find((d) => d.id === id && d.status === 'active') || null;
      if (!doc) { json = { error: '资料不存在或已被移除' }; status = 404; }
      else {
        libraryStub.docReads.push({ id, offset, limit });
        json = {
          ok: true,
          doc: { id: doc.id, uri: doc.uri, rel: doc.rel, category: doc.category, slug: doc.slug, title: doc.title, total_chars: doc.chars, total_bytes: doc.bytes, status: doc.status, indexed_at: doc.indexed_at },
          text: libraryStub.docLines.slice(offset, offset + limit).join('\n')
        };
      }
    } else if (u.includes('/library/enabled')) {
      const body = JSON.parse(String(opts.body || '{}'));
      libraryStub.enabled = body.enabled === true;
      libraryStub.enabledFor = Number(body.work_id) || 0;
      json = { ok: true, work_id: Number(body.work_id) || 0, enabled: libraryStub.enabled };
    } else if (u.includes('/library/import/confirm')) {
      const body = JSON.parse(String(opts.body || '{}'));
      const dir = String(body.dir || '');
      const indexedAt = '2026-09-28T04:00:00';
      const updated = { id: 41, category: '设定', slug: 'tide-ledger', title: '潮汐会的记账规矩', chars: 1244, bytes: 2700, est_chunks: 3, status: 'active', indexed_at: indexedAt, source_path: `${dir}/设定/tide-ledger.md`, rel: '设定/tide-ledger.md', uri: 'viking://user/default/resources/novel-studio-library/设定/tide-ledger.md' };
      const added = { id: 43, category: '方法', slug: 'scene-notes', title: '场景描写笔记', chars: 900, bytes: 1800, est_chunks: 2, status: 'active', indexed_at: indexedAt, source_path: `${dir}/方法/scene-notes.md`, rel: '方法/scene-notes.md', uri: 'viking://user/default/resources/novel-studio-library/方法/scene-notes.md' };
      libraryStub.docs = libraryStub.docs.map((d) => (d.id === 41 ? updated : d)).concat([added]);
      json = {
        ok: true, executed: true, dir,
        written: [{ rel: updated.rel, uri: updated.uri, action: 'update', chars: updated.chars }, { rel: added.rel, uri: added.uri, action: 'add', chars: added.chars }],
        failed: [], skipped: [],
        summary: { files_scanned: 3, add: 1, update: 1, skip_unchanged: 1, skipped_files: 0, will_write: 2, bytes: 4500, chars: 2144, est_chunks: 5, written: 2, failed: 0 },
        index: { key: 'ov_indexed_at:library', at: indexedAt, wait: false, note: '异步索引：写后约 30 秒内可被召回' }
      };
    } else if (u.includes('/library/import')) {
      const body = JSON.parse(String(opts.body || '{}'));
      const dir = String(body.dir || '');
      // 与服务端同形：dry-run 返回 path.resolve 归一化后的目录（Windows 反斜杠、去尾斜杠）；
      // 桩若直接回显原输入，前端「归一化后再比对」的行为会被测成假绿。
      const resolvedDir = dir.replace(/\//g, '\\').replace(/\\+$/, '');
      json = {
        ok: true, dry_run: true, dir: resolvedDir,
        items: [
          { source_path: `${dir}/方法/scene-notes.md`, rel_path: '方法/scene-notes.md', uri: 'viking://user/default/resources/novel-studio-library/方法/scene-notes.md', rel: '方法/scene-notes.md', category: '方法', slug: 'scene-notes', title: '场景描写笔记', action: 'add', reason: '新入库', sha256: 'newsha1', bytes: 1800, chars: 900, est_chunks: 2, warnings: [] },
          { source_path: `${dir}/设定/tide-ledger.md`, rel_path: '设定/tide-ledger.md', uri: 'viking://user/default/resources/novel-studio-library/设定/tide-ledger.md', rel: '设定/tide-ledger.md', category: '设定', slug: 'tide-ledger', title: '潮汐会的记账规矩', action: 'update', reason: '内容有更新（sha256 变了）', sha256: 'newsha2', bytes: 2700, chars: 1244, est_chunks: 3, warnings: [] },
          { source_path: `${dir}/设定/old-notes.md`, rel_path: '设定/old-notes.md', uri: 'viking://user/default/resources/novel-studio-library/设定/old-notes.md', rel: '设定/old-notes.md', category: '设定', slug: 'old-notes', title: '旧笔记', action: 'skip', reason: '内容未变（sha256 相同）', sha256: 'same', bytes: 500, chars: 200, est_chunks: 1, warnings: [] }
        ],
        skipped: [{ path: '随笔.pdf', code: 'ext_not_allowed', reason: '扩展名不在白名单（.md / .txt）' }],
        truncated: false,
        summary: { files_scanned: 4, add: 1, update: 1, skip_unchanged: 1, skipped_files: 1, will_write: 2, bytes: 4500, chars: 2144, est_chunks: 5 },
        rules: { version: '1.0.0', exts: ['.md', '.txt'], max_file_bytes: 2097152, max_files: 500, ignore_dirs: ['node_modules', '.git'], symlink: '不跟随（文件与目录都跳过）', encoding: '严格 UTF-8（失败即跳过，不猜编码）', target: '<共享资料根>/<分类>/<slug>.md（分类一层目录）' }
      };
    } else { json = { error: '未知的资料库操作' }; status = 404; }
  }
  else if (u.includes('/api/novel/scan')) json = { ok: true, total: 1, hits: [{ kind: 'phrase', pattern: '嘴角勾起', note: '', count: 1, sample: '他嘴角勾起一抹笑' }] };
  else if (u.includes('/api/debug/state')) json = { ok: true, state: { recording: false }, config: {} };
  else if (u.includes('/api/debug/start')) json = { ok: true, recording: true, session_id: 'test-session' };
  else if (u.includes('/api/debug/stop')) json = { ok: true, recording: false, summary: { ops: 1, nodes: 3, prompt_tokens: 10, completion_tokens: 5 } };
  else if (u.includes('/api/debug/op')) json = { ok: true, summary: { opId: 'x' } };
  else if (u.includes('/api/debug/ops')) json = { ok: true, ops: [], tools: [], summary: {} };
  else if (u.includes('/api/debug/sessions')) json = { ok: true, sessions: [{ file: 'trace-a.jsonl', size: 1024, mtime: '2026-09-14T10:00:00.000Z', current: true }] };
  // 作品数据（编辑规则卡用例需要最小作品状态；其余用例不受影响：返回空集合）
  else if (/\/api\/works\/\d+/.test(u)) json = { id: Number(u.match(/\/api\/works\/(\d+)/)[1]), title: '编辑规则测试书', description: '', author_note: '' };
  else if (/\/(volumes|plotlines|chapters|categories|terms|characters|relations|plotline_characters|world_entries)\?work_id=/.test(u)) json = [];
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
  WRITING_DISCIPLINE, buildAIWritingBlueprintPrompt, buildAIWritingProsePrompt, buildAIReviewPrompt, buildRedlineScanText, showReviewDiff, mergeReviewDiff, revisionBaseArticle, chapterTitleOf, refineByChecklist, runArticleReview, batchGenerateChapters, aiContextTruncated, directAIWrite,
  continuityGuardSummaryHtml,
  streamAIDirectWrite,
  performToolbarAIWrite,
  loadAIContext,
  WRITING_DIRECTION_MAX_CHARS, normalizeWritingDirectionText, clipWritingDirectionText, buildWritingDirectionFromBlueprint, savedBlueprintForChapter, directionKeyHashOf,
  newWriteTiming,
  withThinkingHeadroom,
  verifyAIDraft,
  pollHarnessJob,
  ATTRIBUTIONS, renderThanks, AI_TABS,
  loadEditRules, renderEditRulesCard, collectEditSelection, saveEditRules, scanEditRules, renderEditScanHtml,
  loadAuthorStyle, renderAuthorStyleCard, authorIntentRow, openAuthorSampleModal, saveAuthorSample, toggleAuthorSample, deleteAuthorSample, analyzeAuthorProfile, saveAuthorIntents,
  loadStoryState, renderStoryStateCard, toggleStoryState, refreshDisclosure, disclosureListHtml,
  loadBranch, renderBranchCard, branchCandidateHtml, branchPromptText, branchTemplate, openBranchSandboxModal, branchCreateSandbox, openBranchSubmitModal, branchSubmitCandidates, branchView, branchCompareAll, branchAdopt, branchDiscard, branchCancel, branchReopen, openBranchConfirm,
  loadRebuild, renderRebuildCard, rebuildBatchById, rebuildPromptForBatch, rebuildPlan, rebuildExtractBatch, rebuildConfirm, rebuildCancel,
  loadLibrary, renderLibrary, renderLibraryDocCard, libraryDocRow, libraryHitRow, libraryPlanHtml, libraryImportResultHtml, libraryStatusChip, librarySkipLabel, LIBRARY_SKIP_LABEL,
  libraryRefresh, librarySearchRun, librarySetCategory, libraryViewDoc, libraryToggleEnabled, libraryPreviewImport, libraryConfirmImport, libraryMarkMissing, libraryDeleteDoc, libraryRenderSafely, handleAction,
  longTextEngine, longTextLimits, longTextPlanFor, longTextRunTask, longTextStatusHtml, longTextContextBlock,
  longTextKindMeta, longTextCancelRun, buildAIPolishMessages, buildAIExpandMessages, buildAIPersonalityMessages
};
`;
const ctx = vm.createContext(sandbox);
let runtimeError = null;
try {
  // R08：index.html 里 /long-text.js 先于 /app.js 加载；桩环境必须同序，
  // 否则 app.js 里的分段模块会缺失（而这个缺失本身是**故意**的硬失败，不是静默降级）。
  const longTextSrc = fs.readFileSync(path.join(repoRoot, 'public', 'long-text.js'), 'utf8');
  new vm.Script(longTextSrc, { filename: 'long-text.js' }).runInContext(ctx, { timeout: 10000 });
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
// 把 document 级 keydown 真的送到 app.js 的监听器（此前桩丢弃监听器 → 键盘路径不可测）
const fireDocKeydown = (event) => { for (const fn of docListeners.get('keydown') || []) fn({ preventDefault() {}, ...event }); };

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
check('54 用户点名的术语既写好了解释、也真的挂到了界面上', ['sillytavern', 'creation_context', 'chapter_note', 'plotline', 'outline', 'plotline_vs_outline'].every((k) => k in P.HELP_TEXT && usedKeys.has(k)));
check('55 帮助标记可悬停也可键盘聚焦', String(P.helpDot('sillytavern')).includes('data-help="sillytavern"') && String(P.helpDot('sillytavern')).includes('tabindex="0"'));
check('56 未知 key 不产生半个空标签', P.helpDot('not_a_real_key') === '' && P.fieldHelp('not_a_real_key') === '');
check('57 字段小字把说明写进了 DOM', String(P.fieldHelp('plotline_vs_outline')).includes('两种看法'));

// --- 5) 悬停气泡：帮助标记与词条链接共用同一个取值函数 ---
const bubble = P.tooltipHtmlFor({ classList: { contains: () => false }, dataset: { help: 'sillytavern' } });
check('58 悬停帮助标记能取到标题与解释', String(bubble).includes('创作上下文') && String(bubble).includes('tt-body'));
// --- R06：改名与首页「借鉴与致谢」 ---
// 命名纪律：用户面统一叫「创作上下文」；内部键 sillytavern / 视图 st / renderST 保留为兼容 alias
// （旧会话、旧 localStorage、旧帮助锚点不能失效）；历史来源在正文里说清，不假装它从没叫过 SillyTavern。
check('58a 用户面改名为创作上下文，且旧键仍可用（兼容 alias）',
  P.HELP_TEXT.sillytavern.title === '创作上下文' && P.HELP_TEXT.creation_context === P.HELP_TEXT.sillytavern
    && P.HELP_TEXT.sillytavern.body.includes('SillyTavern'),
  P.HELP_TEXT.sillytavern.title);
check('58b 菜单里不再出现旧名，AI 标签仍是内部键 st', P.AI_TABS.some(([k, l]) => k === 'st' && l.includes('创作上下文')) && !P.AI_TABS.some(([, l]) => l.includes('SillyTavern')), JSON.stringify(P.AI_TABS));
{
  const thanksEl = { innerHTML: '' };
  P.renderThanks(thanksEl);
  const thanks = String(thanksEl.innerHTML);
  const brackets = thanks.match(/target="_blank"/g) || [];
  const safe = thanks.match(/target="_blank" rel="noopener noreferrer"/g) || [];
  check('58c 借鉴与致谢页列出三类关系（运行组件 / 设计参考 / 实际资产）',
    thanks.includes('实际运行组件') && thanks.includes('设计 / 方法参考') && thanks.includes('实际引入的代码 / 规则 / 资产'));
  check('58d 每张外链卡都带 noopener noreferrer（外链安全）', brackets.length > 0 && brackets.length === safe.length, `${safe.length}/${brackets.length}`);
  check('58e 不显示 stars、不暗示官方合作/背书', !/stars/i.test(thanks) && !thanks.includes('官方合作伙伴') && thanks.includes('不表示与任何项目存在官方合作或背书'));
  check('58f 参考项目都带许可核验版本（日期 + 仓库@commit + LICENSE）',
    ['SillyTavern/SillyTavern', 'blader/humanizer', 'Narcooo/inkos', 'lingfengQAQ/webnovel-writer', 'zenstory-ai/oh-story-claudecode'].every((r) => thanks.includes(r))
      && /核验 2026-09-27/.test(thanks) && /LICENSE/.test(thanks));
  check('58g 未完成能力不写成已集成（状态字段如实标注“设计参考”）',
    P.ATTRIBUTIONS[1].cards.every((c) => c.status.startsWith('设计参考')));
}

// --- 6b) R07：编辑规则卡（三档编辑 / 七项能力 / 题材档）---
{
  // 渲染创作上下文页需要最小作品状态；跑完必须原样还原（后面的用例依赖当前 state）。
  const savedState = {
    workId: P.state.workId, chapters: P.state.chapters, characters: P.state.characters,
    worldEntries: P.state.worldEntries, work: P.state.work, currentChapterId: P.state.currentChapterId,
    view: P.state.view, editRules: P.state.editRules,
  };
  P.state.workId = 1;
  P.state.chapters = [];
  P.state.characters = [];
  P.state.worldEntries = [];
  P.state.work = { title: '编辑规则测试书', author_note: '' };
  P.state.editRules = null;
  P.state.currentChapterId = null;
  // AI 板块的子容器：renderAIBoard 把 renderST 的输出写进 #board-content（桩里必须先登记）。
  containers['#board-content'] = mkEl('board-content');
  P.goView('st');
  await P.render();
  const stHtml = String(containers['#content'].innerHTML);
  const stHtmlFull = stHtml + String(containers['#board-content'].innerHTML);
  check('58h 创作上下文页渲染出编辑规则卡（开关 / 档位 / 题材 / 能力 / 扫描 / 保存）',
    stHtmlFull.includes('id="edit-rules-enabled"') && stHtmlFull.includes('name="edit-tier"') && stHtmlFull.includes('id="edit-genre"')
      && stHtmlFull.includes('class="edit-ability"') && stHtmlFull.includes('data-action="scan-edit-rules"') && stHtmlFull.includes('data-action="save-edit-rules"'),
    stHtmlFull.includes('编辑规则') ? 'has-card' : 'no-card');
  check('58i 三档编辑都出现在界面上（轻度润色 / 去 AI 腔 / 深度修稿）',
    ['轻度润色', '去 AI 腔', '深度修稿'].every((t) => stHtmlFull.includes(t)));
  check('58j 能力卡带说明与适用任务（不是只有一个开关）',
    stHtmlFull.includes('识别机械表达') && stHtmlFull.includes('适用：'));
  // 保存：收集选择 → 真的发出 PUT（不是只改本地状态）
  registered.set('#edit-rules-enabled', { checked: true });
  registered.set('#edit-genre', { value: 'mystery' });
  const sel = P.collectEditSelection();
  check('58k 保存前收集作者选择（开关 / 档位 / 题材 / 能力列表）',
    sel.enabled === true && sel.genre === 'mystery' && Array.isArray(sel.abilities), JSON.stringify(sel));
  const beforePut = requests.length;
  try { await P.saveEditRules(); } catch (e) { check('58l 保存编辑规则不抛错', false, e.message); }
  const putReq = requests.slice(beforePut).find((r) => r.method === 'PUT' && r.url.includes('/api/novel/editing'));
  check('58l 保存真的发出 PUT /api/novel/editing（设置持久化走服务端）',
    !!putReq && JSON.parse(String(putReq.body)).enabled === true && JSON.parse(String(putReq.body)).genre === 'mystery',
    putReq ? String(putReq.body).slice(0, 80) : 'no-put');
  // 扫描：确定性结果渲染到卡片里（严重性 / 规则 / 摘录 / 建议）
  registered.set('#edit-rules-enabled', { checked: false });
  containers['#edit-rules-scan'] = mkEl('edit-rules-scan');
  P.state.currentChapterId = 7;
  await P.scanEditRules();
  const scanHtml = String(containers['#edit-rules-scan'].innerHTML);
  check('58m 扫描结果渲染出严重性 / 规则 id / 摘录 / 建议',
    scanHtml.includes('deterministic:ai-tell') && scanHtml.includes('空气仿佛凝固了') && scanHtml.includes('建议：') && scanHtml.includes('low'),
    scanHtml.slice(0, 90));
  delete containers['#edit-rules-scan'];
  registered.delete('#edit-rules-enabled');
  registered.delete('#edit-genre');
  Object.assign(P.state, savedState);
}
// --- R09 作者样文 / 文风档案 / 三级作者意图：卡片可读可写，写路径真的打到服务端 ---
{
  const savedR09State = {
    workId: P.state.workId, chapters: P.state.chapters, characters: P.state.characters,
    worldEntries: P.state.worldEntries, work: P.state.work, currentChapterId: P.state.currentChapterId,
    view: P.state.view, editRules: P.state.editRules, authorStyle: P.state.authorStyle,
  };
  P.state.workId = 1;
  P.state.chapters = [{ id: 7, title: '第一章' }];
  P.state.currentChapterId = 7;
  P.state.authorStyle = null;
  containers['#board-content'] = mkEl('board-content');
  P.goView('st');
  await P.render();
  const r09Html = String(containers['#content'].innerHTML) + String(containers['#board-content'].innerHTML);
  check('R09-1 创作上下文页渲染出作者样文卡（添加 / 启用开关 / 编辑 / 删除 / 样文行）',
    r09Html.includes('data-action="new-author-sample"') && r09Html.includes('data-action="toggle-author-sample"')
      && r09Html.includes('data-action="edit-author-sample"') && r09Html.includes('data-action="delete-author-sample"')
      && r09Html.includes('我的旧作片段'),
    r09Html.includes('作者样文') ? 'has-card' : 'no-card');
  check('R09-2 卡片写明样文是独立数据来源（不进入正典事实 / 人物 / 地点 / 事件）与上限',
    r09Html.includes('独立数据来源') && r09Html.includes('正典事实') && r09Html.includes('20000'));
  check('R09-3 文风档案区显示过期徽标 / 指标数字 / 计算口径',
    r09Html.includes('已过期') && r09Html.includes('18.25') && r09Html.includes('对白段占比') && r09Html.includes('口径：'));
  check('R09-4 三级意图三个输入框 + 硬约束复选框 + 冲突提请裁决都在界面上',
    r09Html.includes('id="author-intent-long_term"') && r09Html.includes('id="author-intent-stage"')
      && r09Html.includes('id="author-intent-chapter"') && r09Html.includes('id="author-intent-long_term-hard"')
      && r09Html.includes('需要你裁决') && r09Html.includes('不再克制'));
  {
    const beforeToggle = requests.length;
    await P.toggleAuthorSample('5', false);
    const req = requests.slice(beforeToggle).find((r) => r.method === 'PUT' && r.url.includes('/api/novel/style/samples'));
    check('R09-5 停用样文发出 PUT（enabled=false，走服务端而不是只改本地）',
      !!req && JSON.parse(String(req.body)).enabled === false && JSON.parse(String(req.body)).id === 5,
      req ? String(req.body).slice(0, 80) : 'no-put');
  }
  {
    const beforeAnalyze = requests.length;
    try { await P.analyzeAuthorProfile(); } catch (e) { check('R09-6 分析不抛错', false, e.message); }
    const reqs = requests.slice(beforeAnalyze);
    check('R09-6 分析 = POST /novel/style/profile（确定性计数，零模型调用）',
      reqs.some((r) => r.method === 'POST' && r.url.includes('/api/novel/style/profile'))
        && !reqs.some((r) => r.url.includes('/api/ai/')),
      JSON.stringify(reqs.map((r) => r.url.slice(0, 40))));
  }
  {
    registered.set('#author-intent-long_term', { value: '保持克制的叙述' });
    registered.set('#author-intent-long_term-hard', { checked: true });
    registered.set('#author-intent-stage', { value: '第二卷写决裂' });
    registered.set('#author-intent-stage-hard', { checked: false });
    registered.set('#author-intent-chapter', { value: '本章以雨夜追捕收尾' });
    registered.set('#author-intent-chapter-hard', { checked: false });
    const beforeSave = requests.length;
    try { await P.saveAuthorIntents(); } catch (e) { check('R09-7 保存意图不抛错', false, e.message); }
    const bodies = requests.slice(beforeSave)
      .filter((r) => r.method === 'PUT' && r.url.includes('/api/novel/author_intent'))
      .map((r) => JSON.parse(String(r.body)));
    check('R09-7 保存三级意图发出三条 PUT（层级 / 章节归属 / 硬约束正确）',
      bodies.length === 3 && bodies.find((b) => b.tier === 'long_term').hard === true
        && bodies.find((b) => b.tier === 'long_term').chapter_id === 0
        && bodies.find((b) => b.tier === 'chapter').chapter_id === 7
        && bodies.find((b) => b.tier === 'stage').text === '第二卷写决裂',
      JSON.stringify(bodies));
  }
  {
    registered.set('#author-intent-stage', { value: '' });
    const beforeDel = requests.length;
    await P.saveAuthorIntents();
    const dels = requests.slice(beforeDel).filter((r) => r.method === 'DELETE' && r.url.includes('tier=stage'));
    check('R09-8 清空某一档 → 删除该档意图（不是写空字符串）', dels.length === 1,
      JSON.stringify(requests.slice(beforeDel).map((r) => r.method + ' ' + r.url.slice(0, 70))));
  }
  {
    const beforeDelete = requests.length;
    try { await P.deleteAuthorSample('5'); } catch (e) { check('R09-9 删除样文不抛错', false, e.message); }
    const del = requests.slice(beforeDelete).find((r) => r.method === 'DELETE' && r.url.includes('/api/novel/style/samples'));
    check('R09-9 删除样文发出 DELETE 并带 work_id / id',
      !!del && del.url.includes('work_id=1') && del.url.includes('id=5'), del ? del.url : 'no-del');
  }
  check('R09-10 卡片内容来自服务端读回（GET style/samples + style/profile + author_intent）',
    requests.some((r) => r.method === 'GET' && r.url.includes('/api/novel/style/samples'))
      && requests.some((r) => r.method === 'GET' && r.url.includes('/api/novel/style/profile'))
      && requests.some((r) => r.method === 'GET' && r.url.includes('/api/novel/author_intent')));
  delete containers['#board-content'];
  Object.assign(P.state, savedR09State);
  for (const k of ['#author-intent-long_term', '#author-intent-long_term-hard', '#author-intent-stage', '#author-intent-stage-hard', '#author-intent-chapter', '#author-intent-chapter-hard']) registered.delete(k);
}
// --- R10 故事状态与披露视图：按当前章看"作者真相 / 读者已披露 / 角色掌握" ---
{
  const savedR10State = {
    workId: P.state.workId, chapters: P.state.chapters, characters: P.state.characters,
    worldEntries: P.state.worldEntries, work: P.state.work, currentChapterId: P.state.currentChapterId,
    view: P.state.view, editRules: P.state.editRules, authorStyle: P.state.authorStyle, storyState: P.state.storyState,
  };
  P.state.workId = 1;
  P.state.chapters = [{ id: 7, title: '第一章' }];
  P.state.currentChapterId = 7;
  P.state.authorStyle = null;
  P.state.storyState = null;
  containers['#board-content'] = mkEl('board-content');
  P.goView('st');
  await P.render();
  const r10Html = String(containers['#content'].innerHTML) + String(containers['#board-content'].innerHTML);
  check('R10-1 创作上下文页渲染出故事状态卡（开关 / 计数 / 状态哈希 / 重算入口）',
    r10Html.includes('data-action="toggle-story-state"') && r10Html.includes('data-action="refresh-disclosure"')
      && r10Html.includes('状态哈希') && r10Html.includes('abcdef012345'),
    r10Html.includes('故事状态') ? 'has-card' : 'no-card');
  check('R10-2 三档视图都在：作者真相（读者未披露）/ 读者已披露 / 未披露，且带证据章与"已写/未写"',
    r10Html.includes('作者真相（读者未披露）') && r10Html.includes('读者已披露') && r10Html.includes('尚未披露')
      && r10Html.includes('林昭 其实是 卧底') && r10Html.includes('汐会记账人') && r10Html.includes('（未写）'));
  check('R10-3 视图按当前章重算并给出指纹与口径（不是一句"读者已知"）',
    r10Html.includes('第 3 章') && r10Html.includes('disclosure-abcdef0123456789') && r10Html.includes('effective_from ≤'));
  check('R10-4 角色掌握分档显示：可行动 / 显式不知道 / 未定义（不得当成已知）',
    r10Html.includes('可行动 1 条') && r10Html.includes('显式不知道 1') && r10Html.includes('未定义（不得当成已知）')
      && r10Html.includes('暗格 藏着'));
  {
    const beforeToggle = requests.length;
    try { await P.toggleStoryState(); } catch (e) { check('R10-5 切换故事状态不抛错', false, e.message); }
    const put = requests.slice(beforeToggle).find((r) => r.method === 'PUT' && r.url.includes('/api/novel/story_state'));
    check('R10-5 开关真的发 PUT /novel/story_state（enabled=false，作者显式控制）',
      !!put && JSON.parse(String(put.body)).enabled === false && JSON.parse(String(put.body)).work_id === 1,
      put ? String(put.body).slice(0, 80) : 'no-put');
  }
  {
    const beforeRefresh = requests.length;
    try { await P.refreshDisclosure(); } catch (e) { check('R10-6 重算不抛错', false, e.message); }
    const reqs = requests.slice(beforeRefresh);
    check('R10-6 重算只读：再次 GET /novel/state/disclosure，且没有任何写请求',
      reqs.some((r) => r.method === 'GET' && r.url.includes('/api/novel/state/disclosure'))
        && !reqs.some((r) => ['PUT', 'POST', 'DELETE'].includes(r.method)),
      JSON.stringify(reqs.map((r) => r.method + ' ' + r.url.slice(0, 44))));
  }
  delete containers['#board-content'];
  Object.assign(P.state, savedR10State);
}
// --- R11 剧情分支沙盘：候选是提案，采纳/丢弃/取消/重开是作者动作 ---
{
  const savedR11State = {
    workId: P.state.workId, chapters: P.state.chapters, characters: P.state.characters, work: P.state.work,
    currentChapterId: P.state.currentChapterId, branch: P.state.branch, storyState: P.state.storyState,
    authorStyle: P.state.authorStyle, editRules: P.state.editRules, view: P.state.view, aiContext: P.state.aiContext
  };
  const savedBranchStub = JSON.parse(JSON.stringify(branchStub));
  P.state.workId = 1;
  P.state.chapters = [{ id: 7, title: '第一章' }];
  P.state.characters = [{ id: 9, name: '林昭' }];
  P.state.work = { title: '沙盘测试书' };
  P.state.currentChapterId = 7;
  P.state.branch = null;
  P.state.storyState = null;
  P.state.authorStyle = null;
  P.state.editRules = null;
  containers['#board-content'] = mkEl('board-content');
  P.goView('st');
  await P.render();
  const r11 = String(containers['#content'].innerHTML) + String(containers['#board-content'].innerHTML);
  check('R11-1 沙盘卡渲染出沙盘进度与候选（核心行动/冲突/计数/来源）',
    r11.includes('data-action="branch-open-sandbox"') && r11.includes('data-action="branch-submit"')
      && r11.includes('沙盘 #21') && r11.includes('候选 2/3') && r11.includes('还差 1 个')
      && r11.includes('林昭潜入潮汐钟楼夺取钥匙') && r11.includes('人物选择 1') && r11.includes('模型提交'),
    r11.includes('剧情分支沙盘') ? 'has-card' : 'no-card');
  check('R11-2 过期候选显式标"重新采纳必须先复核"，卡片写明"未采纳前不进正文…模型侧 403"',
    r11.includes('已过期') && r11.includes('重新采纳必须先复核')
      && r11.includes('未采纳前不进正文') && r11.includes('模型侧调用返回 403'));
  check('R11-3 只有未丢弃候选才有 采用/丢弃 按钮（已丢弃的只可查看）',
    (r11.match(/data-action="branch-adopt"/g) || []).length === 2
      && (r11.match(/data-action="branch-discard"/g) || []).length === 2
      && (r11.match(/data-action="branch-view"/g) || []).length === 3,
    'adopt=' + (r11.match(/data-action="branch-adopt"/g) || []).length);
  check('R11-4 「复制沙盘提示词」把 novel_branch 的用法复制给会话（复制本身不调模型）',
    r11.includes('data-action="copy-text"') && r11.includes('novel_branch') && r11.includes('disclosure')
      && r11.includes('action=open') && r11.includes('action=submit'));
  {
    const input = mkEl('branch-requested', 'input');
    input.value = '4';
    const before = requests.length;
    try { await P.branchCreateSandbox(); } catch (e) { check('R11-5 开沙盘不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/api/novel/branch/sandboxes'));
    const body = post ? JSON.parse(String(post.body)) : {};
    check('R11-5 开沙盘 = POST /novel/branch/sandboxes（work_id/chapter_id/requested 都来自界面）',
      !!post && body.requested === 4 && body.chapter_id === 7 && body.work_id === 1,
      post ? String(post.body) : 'no-post');
    registered.delete('#branch-requested');
  }
  {
    const ta = mkEl('branch-candidates-json', 'textarea');
    ta.value = P.branchTemplate();
    let templateOk = false;
    try { const x = JSON.parse(ta.value); templateOk = Array.isArray(x) && x.length >= 1 && !!x[0].core_action && Array.isArray(x[0].character_choices) && Array.isArray(x[0].consequences); } catch (_) { templateOk = false; }
    check('R11-6 「填入模板」给出可解析的候选 JSON（core_action/character_choices/consequences 齐）', templateOk, String(ta.value).slice(0, 80));
    const before = requests.length;
    try { await P.branchSubmitCandidates('21'); } catch (e) { check('R11-6 提交候选不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/api/novel/branch/candidates'));
    const body = post ? JSON.parse(String(post.body)) : {};
    check('R11-6 提交候选 = POST /novel/branch/candidates（解析成数组、带 sandbox_id，不是把 JSON 当字符串发）',
      Array.isArray(body.candidates) && body.candidates.length === 1 && Number(body.sandbox_id) === 21 && body.chapter_id === 7,
      post ? String(post.body).slice(0, 120) : 'no-post');
    registered.delete('#branch-candidates-json');
  }
  {
    const before = requests.length;
    try { await P.branchView(101); } catch (e) { check('R11-9 查看不抛错', false, e.message); }
    const get = requests.slice(before).find((r) => r.method === 'GET' && r.url.includes('/candidates/101'));
    const html = String(containers['#modal-root'].innerHTML);
    check('R11-9 查看 = GET 单条候选 + 采纳计划（只写蓝图；never_touched 明示）',
      !!get && html.includes('采纳计划（只写章节蓝图') && html.includes('chapters.content') && html.includes('复核并采用'),
      get ? 'GET 单条候选 + 采纳计划已渲染' : 'no-get');
  }  {
    const before = requests.length;
    try { await P.branchAdopt(101, false); } catch (e) { check('R11-7 采纳不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/candidates/101/adopt'));
    const body = post ? JSON.parse(String(post.body)) : {};
    check('R11-7 采纳 = POST …/adopt（recheck=false；作者通道不带 X-Novel-Agent）',
      !!post && body.recheck === false && body.work_id === 1 && !(post.headers && post.headers['X-Novel-Agent']),
      post ? String(post.body) : 'no-post');
  }
  {
    const before = requests.length;
    try { await P.branchAdopt(102, true); } catch (e) { check('R11-7 复核采纳不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/candidates/102/adopt'));
    check('R11-7 「复核并采用」= 同端点 recheck=true（过期候选不静默覆盖）',
      !!post && JSON.parse(String(post.body)).recheck === true, post ? String(post.body) : 'no-post');
  }
  {
    const before = requests.length;
    try { await P.branchCompareAll(); } catch (e) { check('R11-8 比较不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/api/novel/branch/compare'));
    const ids = post ? JSON.parse(String(post.body)).ids : [];
    const html = String(containers['#modal-root'].innerHTML);
    check('R11-8 比较 = POST /novel/branch/compare（≥2 个非丢弃候选），只列差异、不替作者打分',
      !!post && ids.length >= 2 && !ids.includes(103) && html.includes('差异') && html.includes('不替作者打分')
        && !/最好|推荐方向/.test(html),
      post ? JSON.stringify(ids) : 'no-post');
  }

  {
    const before = requests.length;
    try { await P.branchDiscard(102); } catch (e) { check('R11-10 丢弃不抛错', false, e.message); }
    try { await P.branchCancel(21); } catch (e) { check('R11-10 取消不抛错', false, e.message); }
    try { await P.branchReopen(21); } catch (e) { check('R11-10 恢复不抛错', false, e.message); }
    const reqs = requests.slice(before);
    check('R11-10 丢弃/取消/重启恢复分别打到对应端点（都是作者动作，不带模型标记）',
      reqs.some((r) => r.method === 'POST' && r.url.includes('/candidates/102/discard'))
        && reqs.some((r) => r.method === 'POST' && r.url.includes('/sandboxes/21/cancel'))
        && reqs.some((r) => r.method === 'POST' && r.url.includes('/sandboxes/21/reopen'))
        && !reqs.some((r) => r.headers && r.headers['X-Novel-Agent']),
      JSON.stringify(reqs.map((r) => r.method + ' ' + r.url.slice(0, 60))));
  }
  delete containers['#board-content'];
  Object.assign(P.state, savedR11State);
  Object.assign(branchStub, savedBranchStub);
}

// --- R12 导入后重建：分批抽取 / 基线复用 / 确认即原子应用 ---
{
  const savedR12State = { rebuild: P.state.rebuild, rebuildLoaded: P.state.rebuildLoaded, rebuildRunner: P.state.rebuildRunner, currentChapterId: P.state.currentChapterId, workId: P.state.workId };
  const savedR12Stub = JSON.parse(JSON.stringify({ run: rebuildStub.run, batches: rebuildStub.batches, counts: rebuildStub.counts, recorded: rebuildStub.recorded, confirmed: rebuildStub.confirmed, cancelled: rebuildStub.cancelled }));

  P.state.rebuild = null; P.state.rebuildLoaded = false;
  P.state.currentChapterId = 7;
  P.state.workId = 1;
  P.state.chapters = [
    { id: 7, title: '第一章', content: '<p>原文一句。</p>' },
    { id: 8, title: '第二章', content: '<p>第二章正文。</p>' },
    { id: 9, title: '第三章', content: '<p>第三章正文。</p>' }
  ];
  const r12Toasts = [];
  const savedToast = sandbox.toast;
  sandbox.toast = (m) => { r12Toasts.push(String(m)); };
  try { await P.loadRebuild(true); } catch (e) { check('R12-1 读取重建状态不抛错', false, e.message); }
  const card = String(P.renderRebuildCard());
  check('R12-1 重建卡渲染批次与状态（可复用/待抽取/候选数/基线指纹），并写明取舍口径',
    card.includes('导入后重建创作状态') && card.includes('批次 1/2') && card.includes('批次 2/2')
      && card.includes('待抽取') && card.includes('可复用')
      && card.includes('已过期') && card.includes('未确认前不进') && card.includes('会产生费用'),
    card.slice(0, 120));
  check('R12-2 只有已抽取未确认的批次显示「确认应用本批」，待抽取的显示「抽取本批」',
    card.includes('抽取本批') && /确认应用本批（2 条候选）/.test(card),
    card.slice(0, 200));

  {
    const before = requests.length;
    try { await P.rebuildPlan(); } catch (e) { check('R12-3 规划不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/api/import/rebuild/plan'));
    check('R12-3 「规划分析批次」= POST /import/rebuild/plan（带 work_id；不是把整本一次发给模型）',
      !!post && JSON.parse(String(post.body)).work_id === 1
        && !requests.slice(before).some((r) => /\/api\/ai\//.test(r.url) || /harness/.test(r.url)),
      post ? String(post.body).slice(0, 100) : 'no-post');
  }

  {
    let runnerCalls = 0;
    P.state.rebuildRunner = async ({ prompt, index }) => {
      runnerCalls += 1;
      if (!prompt.includes('【章节 #7') || !prompt.includes('evidence.quote')) throw new Error('提示词缺少本批章节或证据口径');
      return '先说明一下。\n' + '```json\n' + '{"items":[{"category":"entity","chapter_id":7,"chapter_index":0,"evidence":{"quote":"原文一句"},"data":{"name":"青雀"}}]}' + '\n```' + '\n以上。';
    };
    const before = requests.length;
    try { await P.rebuildExtractBatch(0); } catch (e) { check('R12-4 抽取本批不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/api/import/rebuild/record'));
    const body = post ? JSON.parse(String(post.body)) : null;
    check('R12-4 「抽取本批」按批请求（注入 runner，不触发真实模型），围栏 JSON 能解析后 record（带 run_id/batch_index/items）',
      runnerCalls === 1 && !!body && body.run_id === 31 && Number(body.batch_index) === 0
        && Array.isArray(body.result.items) && body.result.items.length === 1
        && !requests.slice(before).some((r) => /\/api\/ai\//.test(r.url))
        && !r12Toasts.some((m) => /本批抽取失败|规划失败/.test(m)),
      `runnerCalls=${runnerCalls} body=${post ? String(post.body).slice(0, 120) : 'no-post'} toast=${r12Toasts.join(' / ')}`);
  }

  {
    const before = requests.length;
    try { await P.rebuildConfirm([0]); } catch (e) { check('R12-5 确认不抛错', false, e.message); }
    const post = requests.slice(before).find((r) => r.method === 'POST' && r.url.includes('/api/import/rebuild/confirm'));
    const body = post ? JSON.parse(String(post.body)) : null;
    check('R12-5 「确认应用本批」= POST …/confirm（batch_indexes=[0]，作者通道不带模型标记）',
      !!body && JSON.stringify(body.batch_indexes) === '[0]' && body.run_id === 31
        && !(post.headers && post.headers['X-Novel-Agent']),
      post ? String(post.body).slice(0, 100) : 'no-post');
  }

  {
    const before = requests.length;
    try { await P.rebuildConfirm(null); } catch (e) { check('R12-6 确认全部不抛错', false, e.message); }
    try { await P.rebuildCancel(); } catch (e) { check('R12-6 取消不抛错', false, e.message); }
    const reqs = requests.slice(before);
    const all = reqs.find((r) => r.method === 'POST' && r.url.includes('/api/import/rebuild/confirm'));
    const cancel = reqs.find((r) => r.method === 'POST' && r.url.includes('/api/import/rebuild/cancel'));
    check('R12-6 「确认全部」不带 batch_indexes（整跑确认）+「取消」保留已记录结果（都走作者通道）',
      !!all && JSON.parse(String(all.body)).batch_indexes === undefined
        && !!cancel && JSON.parse(String(cancel.body)).run_id === 31
        && !reqs.some((r) => r.headers && r.headers['X-Novel-Agent']),
      JSON.stringify(reqs.map((r) => r.method + ' ' + r.url.slice(0, 50))));
  }

  sandbox.toast = savedToast;
  P.state.rebuildRunner = null;
  Object.assign(P.state, savedR12State);
  Object.assign(rebuildStub, savedR12Stub);
}

// --- P4 共享资料库：列表 / 检索 / 导入两段式 / 读原文 / 开关 / 标记与删除 ---
// 边界口径：导入是"先预览（从不写入）→ 作者确认才写"；删除是"先标记缺失 → 确认才真删"；
// 开关按作品、默认关闭；模型侧写操作一律 403（后端职责，此处断言界面不越权、不假装能写）。
{
  const savedLibState = {
    workId: P.state.workId, work: P.state.work, view: P.state.view, chapters: P.state.chapters,
    library: P.state.library, libraryLoaded: P.state.libraryLoaded, libraryKey: P.state.libraryKey, libraryDir: P.state.libraryDir,
    libraryCategory: P.state.libraryCategory, librarySearch: P.state.librarySearch,
    libraryDoc: P.state.libraryDoc, libraryPlan: P.state.libraryPlan, libraryImportResult: P.state.libraryImportResult
  };
  const savedLibStub = JSON.parse(JSON.stringify({ enabled: libraryStub.enabled, ov: libraryStub.ov, docs: libraryStub.docs, docReads: libraryStub.docReads }));
  const savedConfirm = sandbox.confirm;
  let confirmCalls = 0;
  sandbox.confirm = () => { confirmCalls += 1; return true; };
  P.state.workId = 1;
  P.state.work = { title: '资料库测试书' };
  P.state.library = null; P.state.libraryLoaded = false;
  P.state.libraryDir = ''; P.state.libraryCategory = ''; P.state.librarySearch = null;
  P.state.libraryDoc = null; P.state.libraryPlan = null; P.state.libraryImportResult = null;
  libraryStub.enabled = false; libraryStub.ov.disabled = false; libraryStub.docReads = [];

  P.goView('library');
  await P.render();
  let libHtml = String(containers['#content'].innerHTML);
  check('LIB-1 资料库页渲染：标题 / 开关卡 / 列表行（字数·块数·分类）/ 导入卡 / 帮助入口齐备',
    libHtml.includes('📎 资料库') && libHtml.includes('跨作品共享的写作参考资料')
      && libHtml.includes('data-help="library"') && libHtml.includes('资料层开关（本作品）')
      && libHtml.includes('data-action="library-import-preview"') && libHtml.includes('data-action="library-refresh"')
      && libHtml.includes('潮汐会的记账规矩') && libHtml.includes('短句范例')
      && libHtml.includes('设定（1）') && libHtml.includes('风格（1）') && libHtml.includes('预计 3 块')
      && libHtml.includes('先「扫描预览」，再「确认导入」') && libHtml.includes('不跟随符号链接'),
    libHtml.includes('📎 资料库') ? 'has-page' : 'no-page');

  // 未进入作品：开关按作品生效，不给开 / 关按钮（不假装可以全局开关）
  // 未进入作品：开关按作品生效，不给开 / 关按钮；缓存按作品为键——这里故意不清 libraryLoaded，
  // 验证退回作品列表后会重新取状态，而不是复用上一个作品的「开关」。
  P.state.workId = null;
  const beforeNoWork = requests.length;
  await P.render();
  const noWorkHtml = String(containers['#content'].innerHTML);
  check('LIB-2 未进入作品时开关卡只提示、不开按钮（开关按作品生效，默认关闭）',
    noWorkHtml.includes('还没进入作品') && !noWorkHtml.includes('data-action="library-toggle"')
      && requests.slice(beforeNoWork).some((r) => r.method === 'GET' && r.url.includes('/api/novel/library/status')),
    noWorkHtml.includes('还没进入作品') ? 'hint-only' : 'has-buttons');
  P.state.workId = 1; P.state.libraryLoaded = false;
  await P.render();
  const offPut = requests.filter((r) => r.method === 'PUT' && r.url.includes('/api/novel/library/enabled'));
  check('LIB-2b 渲染资料库页从不悄悄替作者开 / 关资料层（没有 PUT /library/enabled）', offPut.length === 0, String(offPut.length));
  // —— 异步竞态：过期响应不得覆盖新状态（作品切换 / 视图切走 / 快速连点）——
  {
    const realLibFetch = sandbox.fetch;
    const libInFlight = [];
    sandbox.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('/api/novel/library/status') || u.includes('/api/novel/library/doc?') || u.includes('/api/novel/library/search?')) {
        return new Promise((resolve) => { libInFlight.push({ u, resolve }); });
      }
      return realLibFetch(url, opts);
    };
    const takeLibReq = (frag) => {
      const idx = libInFlight.findIndex((p) => p.u.includes(frag));
      if (idx < 0) return null;
      return libInFlight.splice(idx, 1)[0];
    };
    const libReply = (json) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(json), json: async () => json });

    // 1) 等待期间切换作品：旧作品的 status 响应必须被丢弃
    P.state.library = null; P.state.libraryLoaded = true; P.state.libraryKey = 1; P.state.workId = 1;
    const pendingStatus = P.loadLibrary(true);
    await new Promise((r) => setTimeout(r, 0));
    P.state.workId = 2;
    const stReq = takeLibReq('/api/novel/library/status');
    if (!stReq) throw new Error('LIB-2c 桩未收到 library/status 请求');
    stReq.resolve(libReply(libraryStatusJson(1)));
    const staleOut = await pendingStatus;
    check('LIB-2c 等待期间切换作品：过期 status 被丢弃（不把作品 1 的开关贴到作品 2）',
      staleOut === null && P.state.library === null && P.state.libraryKey === 1,
      'library=' + (P.state.library ? 'stale-written' : 'null'));

    // 2) 等待期间切走视图：过期渲染不得覆盖新页面
    P.state.workId = 1; P.state.library = null; P.state.libraryLoaded = false; P.state.libraryKey = null;
    P.state.view = 'library';
    const pendingRender = P.render();
    await new Promise((r) => setTimeout(r, 0));
    const stReq2 = takeLibReq('/api/novel/library/status');
    if (!stReq2) throw new Error('LIB-2d 桩未收到 library/status 请求');
    P.state.view = 'works';
    containers['#content'].innerHTML = '<div id="works-marker">作品列表页</div>';
    stReq2.resolve(libReply(libraryStatusJson(1)));
    await pendingRender;
    check('LIB-2d 等待服务端期间切走视图：过期渲染不覆盖当前页面',
      String(containers['#content'].innerHTML).includes('works-marker'),
      String(containers['#content'].innerHTML).slice(0, 40));

    // 3) 快速连读两篇：迟到的旧响应不得覆盖新结果
    P.state.view = 'library'; P.state.libraryLoaded = true; P.state.libraryKey = 1; P.state.library = libraryStatusJson(1);
    P.state.libraryDoc = null;
    const readA = P.libraryViewDoc(41);
    const readB = P.libraryViewDoc(42);
    await new Promise((r) => setTimeout(r, 0));
    const reqA = takeLibReq('id=41');
    const reqB = takeLibReq('id=42');
    if (!reqA || !reqB) throw new Error('LIB-5c 桩未收到 doc 请求');
    const docReply = (id) => {
      const d = libraryStub.docs.find((x) => x.id === id) || {};
      return { ok: true, doc: { id: d.id, rel: d.rel, title: d.title, total_chars: d.chars }, text: libraryStub.docLines.slice(0, 30).join('\n') };
    };
    reqB.resolve(libReply(docReply(42)));
    await readB;
    reqA.resolve(libReply(docReply(41)));
    await readA;
    check('LIB-5c 快速连读两篇：迟到的旧响应不覆盖新结果（读原文请求序号）',
      P.state.libraryDoc && P.state.libraryDoc.doc && P.state.libraryDoc.doc.id === 42,
      'doc=' + (((P.state.libraryDoc || {}).doc || {}).id || ''));

    // 4) 连续检索：迟到的旧响应不得覆盖新结果
    P.state.libraryDoc = null;
    P.state.librarySearch = { q: '记账' };
    const searchA = P.librarySearchRun();
    P.state.librarySearch = { q: '短句' };
    const searchB = P.librarySearchRun();
    await new Promise((r) => setTimeout(r, 0));
    const sReqA = takeLibReq('q=' + encodeURIComponent('记账'));
    const sReqB = takeLibReq('q=' + encodeURIComponent('短句'));
    if (!sReqA || !sReqB) throw new Error('LIB-3e 桩未收到 search 请求');
    const searchReply = (q, mode) => ({ ok: true, q, mode, total: 2, hits: [{ id: 41, category: '设定', slug: 'tide-ledger', title: q === '短句' ? '短句范例' : '潮汐会的记账规矩' }] });
    sReqB.resolve(libReply(searchReply('短句', 'keyword')));
    await searchB;
    sReqA.resolve(libReply(searchReply('记账', 'semantic')));
    await searchA;
    check('LIB-3e 连续检索：迟到的旧响应不覆盖新结果（检索请求序号）',
      (P.state.librarySearch || {}).q === '短句',
      'q=' + ((P.state.librarySearch || {}).q || ''));

    sandbox.fetch = realLibFetch;
    P.state.view = 'library'; P.state.libraryLoaded = false; P.state.libraryKey = null; P.state.library = null;
    P.state.librarySearch = null; P.state.libraryDoc = null; P.state.workId = 1;
    await P.render();
  }

  // 检索：请求真的打到服务端，界面用服务端返回的 mode/hits
  const qInput = mkEl('library-q', 'input');
  qInput.value = '记账';
  const beforeSearch = requests.length;
  await P.librarySearchRun();
  const searchReq = requests.slice(beforeSearch).find((r) => r.method === 'GET' && r.url.includes('/api/novel/library/search'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-3 检索 = GET /novel/library/search（q 与 limit 来自界面），按服务端 mode/hits 渲染（语义 + 相关度）',
    !!searchReq && searchReq.url.includes('q=' + encodeURIComponent('记账')) && searchReq.url.includes('limit=20')
      && libHtml.includes('检索方式：语义') && libHtml.includes('相关度 87%')
      && libHtml.includes('潮汐会的记账规矩') && libHtml.includes('先记账，再谈情'),
    searchReq ? searchReq.url : 'no-get');
  qInput.value = '不存在的词';
  await P.librarySearchRun();
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-3b 没有命中时如实说明"语义与关键词都没找到"，并标出当前走的是关键词兜底',
    libHtml.includes('没有命中（语义与关键词都没找到）') && libHtml.includes('关键词兜底'),
    libHtml.includes('没有命中') ? 'empty-state' : 'no-empty');
  // 回车 = 点「检索」：键盘走 document 委托，只有 library-q 上的 Enter 才算
  qInput.value = '记账';
  const beforeEnter = requests.length;
  fireDocKeydown({ key: 'Enter', target: { id: 'global-search' } });
  fireDocKeydown({ key: 'Enter', isComposing: true, target: qInput }); // 输入法候选确认的回车：不算检索
  fireDocKeydown({ key: 'Enter', target: qInput });
  await new Promise((r) => setTimeout(r, 0));
  const enterReqs = requests.slice(beforeEnter).filter((r) => r.method === 'GET' && r.url.includes('/api/novel/library/search'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-3d 检索框回车 = 点「检索」（只在 library-q 上触发；结果按服务端返回渲染）',
    enterReqs.length === 1 && enterReqs[0].url.includes('q=' + encodeURIComponent('记账'))
      && libHtml.includes('检索方式：语义') && libHtml.includes('潮汐会的记账规矩'),
    'enterReqs=' + enterReqs.length);
  P.state.librarySearch = null;
  const beforeCat = requests.length;
  await P.librarySetCategory('风格');
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-3c 分类按钮来自服务端 summary.categories（含计数）；切到某类后列表只剩该类资料',
    libHtml.includes('data-action="library-category" data-category="设定"') && libHtml.includes('data-category="风格"')
      && libHtml.includes('全部分类')
      && libHtml.includes('短句范例') && !libHtml.includes('潮汐会的记账规矩')
      && !requests.slice(beforeCat).some((r) => ['POST', 'PUT', 'DELETE'].includes(r.method)),
    libHtml.includes('短句范例') ? 'filtered' : 'not-filtered');
  P.state.libraryCategory = '';
  await P.render();

  // 读原文：GET /novel/library/doc（按行窗口），翻页按钮走分派器
  const beforeRead = requests.length;
  await P.libraryViewDoc(41);
  const readReq = requests.slice(beforeRead).find((r) => r.method === 'GET' && r.url.includes('/api/novel/library/doc?'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-4 读原文 = GET /novel/library/doc（id/offset/limit 均为界面参数），服务端返回的正文真的渲染出来',
    !!readReq && readReq.url.includes('id=41') && readReq.url.includes('offset=0') && readReq.url.includes('limit=30')
      && libHtml.includes('读原文：潮汐会的记账规矩') && libHtml.includes('第 1 行：潮汐会的规矩')
      && libHtml.includes('data-offset="0" disabled') && libHtml.includes('data-offset="30" >'),
    readReq ? readReq.url : 'no-get');
  const beforePage = requests.length;
  await P.handleAction('library-doc-page', { dataset: { offset: '30' } });
  const pageReq = requests.slice(beforePage).find((r) => r.method === 'GET' && r.url.includes('/api/novel/library/doc?'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-5 分派 library-doc-page：用当前文档 id + 新 offset 再取一段；末段禁用「下一段」、可回退',
    !!pageReq && pageReq.url.includes('id=41') && pageReq.url.includes('offset=30')
      && libHtml.includes('data-offset="60" disabled') && libHtml.includes('data-offset="0" >')
      && (libraryStub.docReads[1] || {}).offset === 30 && (libraryStub.docReads[1] || {}).limit === 30,
    pageReq ? pageReq.url : 'no-get');
  await P.handleAction('library-doc-close', { dataset: {} });
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-5b 分派 library-doc-close：读原文卡收起（不残留）',
    P.state.libraryDoc === null && !libHtml.includes('读原文：潮汐会的记账规矩'));

  // 导入两段式：扫描预览（从不写入）→ 作者确认才写共享资料根
  const dirInput = mkEl('library-dir-input', 'input');
  dirInput.value = 'D:/写作资料';
  const docsBeforePlan = JSON.stringify(libraryStub.docs.map((d) => d.id).sort());
  const beforePlan = requests.length;
  await P.libraryPreviewImport();
  const planReq = requests.slice(beforePlan).find((r) => r.method === 'POST' && r.url.includes('/api/novel/library/import'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-6 「扫描预览」= POST /novel/library/import（绝不带 confirm、不写任何东西）',
    !!planReq && !planReq.url.includes('confirm') && JSON.parse(String(planReq.body)).dir === 'D:/写作资料'
      && JSON.stringify(libraryStub.docs.map((d) => d.id).sort()) === docsBeforePlan,
    planReq ? planReq.url : 'no-post');
  check('LIB-6b 预览渲染新增/更新/未变/跳过计数与跳过原因中文说明；「未变」条目不进待写入清单',
    libHtml.includes('<span class="chip">新增</span>') && libHtml.includes('<span class="chip">更新</span>')
      && libHtml.includes('新增 1') && libHtml.includes('更新 1') && libHtml.includes('未变 1') && libHtml.includes('跳过 1')
      && libHtml.includes('扩展名不在白名单') && libHtml.includes('确认导入 2 篇')
      && !libHtml.includes('旧笔记'),
    libHtml.includes('确认导入 2 篇') ? 'plan-rendered' : 'no-plan');
  dirInput.value = 'D:/另一个目录';
  const beforeBadConfirm = requests.length;
  await P.libraryConfirmImport();
  check('LIB-7 预览后目录被改 → 拒绝导入且不发确认请求（必须对新目录重新扫描）',
    P.state.libraryPlan !== null
      && !requests.slice(beforeBadConfirm).some((r) => r.method === 'POST' && r.url.includes('/import/confirm')),
    'plan=' + (P.state.libraryPlan ? 'kept' : 'lost'));
  dirInput.value = 'D:/写作资料/';
  const beforeConfirm = requests.length;
  await P.libraryConfirmImport();
  const confirmReq = requests.slice(beforeConfirm).find((r) => r.method === 'POST' && r.url.includes('/import/confirm'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-7b 「确认导入」先经作者确认框，再 POST /import/confirm；结果卡给出写入/未变/异步索引说明',
    confirmCalls === 1 && !!confirmReq && JSON.parse(String(confirmReq.body)).dir === 'D:/写作资料/'
      && libHtml.includes('已写入 2') && libHtml.includes('未变 1') && libHtml.includes('异步索引')
      && libraryStub.docs.length === 3,
    'confirmCalls=' + confirmCalls + ' docs=' + libraryStub.docs.length);

  // 开关：作者动作，PUT 按作品；界面状态以服务端回读为准
  const beforeToggle = requests.length;
  await P.handleAction('library-toggle', { dataset: { enabled: '1' } });
  const putReq = requests.slice(beforeToggle).find((r) => r.method === 'PUT' && r.url.includes('/api/novel/library/enabled'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-8 分派 library-toggle = PUT /novel/library/enabled（带 work_id），开启后以服务端回读显示「已开启」',
    !!putReq && JSON.parse(String(putReq.body)).work_id === 1 && JSON.parse(String(putReq.body)).enabled === true
      && libraryStub.enabled === true && libHtml.includes('已开启'),
    putReq ? String(putReq.body) : 'no-put');

  // 删除边界：默认只标记缺失；确认框取消则什么都不删；确认才带 confirm=1
  const beforeMark = requests.length;
  await P.libraryMarkMissing(42);
  const markReq = requests.slice(beforeMark).find((r) => r.method === 'DELETE' && r.url.includes('/api/novel/library/doc/42'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-9 「标记缺失」= DELETE 不带 confirm=1（记忆库文件与登记行都不删），列表随服务端状态刷新',
    !!markReq && !markReq.url.includes('confirm=1')
      && (libraryStub.docs.find((d) => d.id === 42) || {}).status === 'marked_missing'
      && !libHtml.includes('短句范例') && libHtml.includes('标记缺失 1'),
    markReq ? markReq.url : 'no-delete');
  sandbox.confirm = () => { confirmCalls += 1; return false; };
  const beforeAbort = requests.length;
  await P.libraryDeleteDoc(41);
  check('LIB-9b 「确认删除」点取消 → 不发删除请求（登记行与记忆库文件都不动）',
    confirmCalls === 2 && !requests.slice(beforeAbort).some((r) => r.method === 'DELETE'),
    'confirmCalls=' + confirmCalls);
  sandbox.confirm = () => { confirmCalls += 1; return true; };
  const beforeDel = requests.length;
  await P.handleAction('library-delete', { dataset: { id: '41' } });
  const delReq = requests.slice(beforeDel).find((r) => r.method === 'DELETE' && r.url.includes('/api/novel/library/doc/41'));
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-9c 分派 library-delete：确认后 DELETE 带 confirm=1，登记行随服务端回读消失',
    confirmCalls === 3 && !!delReq && delReq.url.includes('confirm=1')
      && !libraryStub.docs.some((d) => d.id === 41) && !libHtml.includes('潮汐会的记账规矩'),
    delReq ? delReq.url : 'no-delete');

  // 刷新：重取服务端状态（不是本地缓存回放）
  P.state.libraryLoaded = true; P.state.library = { ok: true, summary: {}, docs: [] };
  const beforeRefresh = requests.length;
  await P.handleAction('library-refresh', { dataset: {} });
  check('LIB-10 分派 library-refresh = 强制重取 GET /novel/library/status（刷新后以服务端最新状态渲染）',
    requests.slice(beforeRefresh).some((r) => r.method === 'GET' && r.url.includes('/api/novel/library/status'))
      && (((P.state.library || {}).docs) || []).length === libraryStub.docs.filter((d) => d.status === 'active').length,
    'docs=' + ((((P.state.library || {}).docs) || []).length));

  // 记忆库总闸关闭：如实说明能做什么、不能做什么（不假装能导入 / 删除）
  libraryStub.ov.disabled = true; P.state.libraryLoaded = false;
  await P.render();
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-11 记忆库总闸关闭时如实说明：可预览 / 关键词兜底，但确认导入与删除会被拒绝',
    libHtml.includes('记忆库总闸已关闭') && libHtml.includes('确认导入与删除会被拒绝'));
  libraryStub.ov.disabled = false;

  // 旧服务端（没有该接口）：如实显示不可用，不假装有资料库、不抛错
  P.state.library = null; P.state.libraryLoaded = true;
  await P.render();
  libHtml = String(containers['#content'].innerHTML);
  check('LIB-11b 旧服务端不提供该接口时如实提示重启，而不是空列表 / 报错',
    libHtml.includes('当前服务端不提供该接口') && libHtml.includes('重启 Novel Studio 后可用'));

  registered.delete('#library-q');
  registered.delete('#library-dir-input');
  sandbox.confirm = savedConfirm;
  Object.assign(P.state, savedLibState);
  libraryStub.enabled = savedLibStub.enabled;
  libraryStub.ov = savedLibStub.ov;
  libraryStub.docs = savedLibStub.docs;
  libraryStub.docReads = savedLibStub.docReads;
}
// --- R08 长正文：目标正文不再被 slice，分段处理必须有覆盖证明 ---
{
  const savedR08State = {
    longTextSettings: P.state.longTextSettings, longTextRunner: P.state.longTextRunner,
    longTextCancel: P.state.longTextCancel, longTextJobIds: P.state.longTextJobIds
  };
  const savedR08Store = sandbox.localStorage.getItem('ns_long_text_run');
  const fnBody = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\([^)]*\\)[\\s\\S]*?\\n}'));
    return m ? m[0] : '';
  };
  const targets = ['buildAIPolishMessages', 'buildAIExpandMessages', 'buildAIReviewPrompt', 'buildAIRevisionPrompt', 'buildAIRevisionPatchPrompt'];
  check('58n 五个目标正文入口都不再 slice(0, 6000/12000)', targets.every((n) => fnBody(n) && !/slice\(0,\s*(6000|12000)\)/.test(fnBody(n))),
    targets.filter((n) => !fnBody(n) || /slice\(0,\s*(6000|12000)\)/.test(fnBody(n))).join(','));
  check('58o 邻接段被显式标成 context-only（不许改、不许回吐）',
    fnBody('buildAIPolishMessages').includes('context-only')
    && P.longTextContextBlock({ context_before: '上文一句', context_after: null }).includes('禁止修改'));
  check('58p 长正文分段模块已加载（与 index.html 的脚本顺序一致）',
    !!P.longTextEngine() && P.longTextEngine().VERSION === '1.0.0' && P.longTextEngine() === sandbox.NovelLongText);

  const r08Chapter = Array.from({ length: 24 }, (_, i) => `第${i + 1}段：他推开门，雨点砸在台阶上。` + '这是一句用来凑长度的测试文本。'.repeat(4)).join('\n\n');
  P.state.longTextSettings = { request_chars: 1500, output_reserve_chars: 400, protocol_chars: 100, max_segment_chars: 600, min_segment_chars: 100 };
  const planShort = P.longTextPlanFor('polish', '短正文一段。', {});
  const planLong = P.longTextPlanFor('polish', r08Chapter, {});
  check('58q 短正文走单请求、超限正文自动分段（按最终序列化请求判定）',
    planShort.mode === 'single' && planLong.mode === 'segmented' && planLong.segments.length > 3,
    `${planShort.mode}/${planLong.mode}/${planLong.segments.length}`);
  const ids1 = planLong.segments.map((x) => x.segment_id).join(',');
  const ids2 = P.longTextPlanFor('polish', r08Chapter, {}).segments.map((x) => x.segment_id).join(',');
  check('58r 片号由内容 hash 得出且稳定（不含随前文漂移的字符 offset）', ids1 === ids2 && /seg-[0-9a-f]{10}/.test(ids1));
  const segMsg = P.buildAIPolishMessages(planLong.segments[1].target.text, '更口语化', { segment: planLong.segments[1], context: '作品背景' });
  check('58s 单片消息含该片全文与片号，邻接段带 context-only 围栏',
    segMsg[1].content.includes(planLong.segments[1].target.text) && segMsg[1].content.includes(planLong.segments[1].segment_id)
    && segMsg[1].content.includes('context-only') && segMsg[1].content.includes('禁止修改'));

  // 端到端（注入确定性 runner，不打电话）：跑完整章 → 覆盖清单通过 → 合并
  const calls = [];
  P.state.longTextRunner = async ({ segment }) => { calls.push(segment.segment_id); return segment.target.text + '（分段处理）'; };
  const run = await P.longTextRunTask('polish', { text: r08Chapter, instruction: '', chapterId: 107, currentText: () => r08Chapter });
  check('58t 分段跑完整章：每片恰好一次、覆盖清单通过、可合并',
    run.mode === 'segmented' && calls.length === planLong.segments.length && new Set(calls).size === calls.length
    && run.manifest.ok === true && typeof run.merged === 'string' && run.merged.split('（分段处理）').length - 1 === planLong.segments.length,
    `calls=${calls.length}/${planLong.segments.length} ok=${run.manifest && run.manifest.ok}`);
  check('58u 状态摘要含原文档位/片数/覆盖结论（UI 显示处理到哪儿）',
    run.statusHtml.includes('原文版本') && run.statusHtml.includes('覆盖') && run.statusHtml.includes('结论') && run.statusHtml.includes(String(planLong.segments.length)));

  // 部分失败：不合并、失败片点名；续跑只补失败片
  const calls2 = [];
  let failOnce = true;
  P.state.longTextRunner = async ({ segment }) => {
    calls2.push(segment.segment_id);
    if (segment.segment_id === planLong.segments[2].segment_id && failOnce) { failOnce = false; throw new Error('模拟网络失败'); }
    return segment.target.text + '（分段处理）';
  };
  const runFail = await P.longTextRunTask('polish', { text: r08Chapter, instruction: '', chapterId: 108, currentText: () => r08Chapter });
  check('58v 单片刻失败 → 不合并（merged=null），失败片可见并可点名',
    runFail.merged === null && runFail.resume.rerun.includes(planLong.segments[2].segment_id) && runFail.statusHtml.includes('失败'));
  const callsBefore = calls2.length;
  const runResume = await P.longTextRunTask('polish', { text: r08Chapter, instruction: '', chapterId: 108, currentText: () => r08Chapter });
  check('58w 续跑只补失败片（已成功且源版本一致的片不重复调用）',
    calls2.length === callsBefore + 1 && calls2[calls2.length - 1] === planLong.segments[2].segment_id
    && runResume.manifest.ok === true && runResume.merged !== null);

  // 越界拒绝
  P.state.longTextRunner = async ({ segment }) => (segment.context_before ? segment.context_before : segment.target.text + '（改）');
  const runCtx = await P.longTextRunTask('polish', { text: r08Chapter, instruction: '', chapterId: 109, currentText: () => r08Chapter });
  check('58x 模型回吐邻接段 → 判越界（violation）且拒绝合并', runCtx.merged === null && runCtx.manifest.violations.length >= 1);

  // 源版本在处理中被作者改动
  P.state.longTextRunner = async ({ segment }) => segment.target.text + '（改）';
  const runStale = await P.longTextRunTask('polish', { text: r08Chapter, instruction: '', chapterId: 110, currentText: () => r08Chapter + '\n\n作者又加了一段。' });
  check('58y 处理中源正文被改动 → 候选过期（stale）且拒绝合并', runStale.merged === null && runStale.manifest.stale === true && runStale.statusHtml.includes('过期'));

  // 分段审稿：报告合并后每条问题带片号
  P.state.longTextRunner = async ({ segment }) => JSON.stringify({ summary: `第${segment.ordinal}片总评`, issues: [{ text: '节奏偏慢' }], strengths: [{ text: '对白自然' }] });
  const runReview = await P.longTextRunTask('review', { text: r08Chapter, chapterId: 111, currentText: () => r08Chapter });
  check('58z 分段审稿：报告按片合并、每条问题带片号，形态与单请求一致',
    runReview.mode === 'segmented' && !!runReview.report && runReview.report.issues.length === planLong.segments.length
    && typeof runReview.report.issues[0] === 'string' && runReview.report.issues[0].includes(planLong.segments[0].segment_id));

  // 取消：片间生效、不产生可合并结果
  let cancelCalls = 0;
  P.state.longTextRunner = async ({ segment }) => { cancelCalls += 1; if (cancelCalls === 2) P.longTextCancelRun(); return segment.target.text + '（改）'; };
  const runCancel = await P.longTextRunTask('polish', { text: r08Chapter, instruction: '', chapterId: 112, currentText: () => r08Chapter });
  check('58aa 取消在片间生效：不再继续调用，且不产生可合并结果', runCancel.cancelled === true && runCancel.merged === null && cancelCalls === 2);

  // 状态摘要必须转义
  const escHtml = P.longTextStatusHtml({ plan: planLong, results: [], manifest: { ok: false, segments: [], unresolved: ['<script>alert(1)</script>'] } });
  check('58ab 状态摘要按 HTML 转义（正文/模型文本不会变成脚本）', escHtml.includes('&lt;script&gt;') && !escHtml.includes('<script>'));
  check('58ac 分段模块缺失时硬失败，拒绝用截断方式处理整章',
    /长正文分段模块未加载/.test(src) && /拒绝用截断方式处理整章/.test(src));

  // 单请求路径（不超限，不分段）：修稿解析不得依赖 segment；三类"调用方自己跑单请求"的任务
  // 不得在模块内先跑一遍再让调用方跑第二遍（同一份钱花两次）。
  const revBase = '雨点敲在窗上。陈默数着第七次雷声。';
  const revJSON = JSON.stringify({ patches: [{ issue: 1, anchor: revBase, revised: revBase + '他按住口袋里的芯片。' }] });
  let revParseErr = null; let revParsed = null;
  try { revParsed = P.longTextKindMeta('revision_patch', { text: revBase, issues: ['补动作'] }).parse(null, revJSON); }
  catch (e) { revParseErr = e; }
  check('58ad 修稿单请求路径可直接解析补丁（解析不得要求 segment）',
    !revParseErr && !!revParsed && revParsed.extra && revParsed.extra.applied === 1 && String(revParsed.output).includes('他按住口袋里的芯片'),
    revParseErr ? String(revParseErr.message) : JSON.stringify(revParsed && revParsed.extra));

  const singleCalls = [];
  P.state.longTextRunner = async ({ segment, kind }) => { singleCalls.push(kind + ':' + (segment ? segment.segment_id : 'single')); return '模块内单请求结果'; };
  let singleRev = null; let singleReview = null; let singleErr = null;
  try {
    singleRev = await P.longTextRunTask('revision_patch', { text: revBase, chapterId: 113, issues: ['补动作'], currentText: () => revBase, singleRunByCaller: true });
    singleReview = await P.longTextRunTask('review', { text: revBase, chapterId: 113, currentText: () => revBase, singleRunByCaller: true });
  } catch (e) { singleErr = e; }
  check('58ae 单请求路径交回调用方执行：模块内不再预跑一次模型（避免一次任务双倍计费）',
    !singleErr && !!singleRev && !!singleReview && singleRev.mode === 'single' && singleReview.mode === 'single' && singleCalls.length === 0 && singleRev.merged === null && singleReview.merged === null,
    singleErr ? String(singleErr.message) : 'calls=' + singleCalls.length);
  const singlePolish = await P.longTextRunTask('polish', { text: '短正文。', instruction: '', chapterId: 114, currentText: () => '短正文。' });
  check('58af 其它任务（润色）单请求路径行为不变：模块内执行并返回结果',
    singlePolish.mode === 'single' && singlePolish.merged === '模块内单请求结果' && singleCalls.length === 1);

  P.state.longTextSettings = savedR08State.longTextSettings;
  P.state.longTextRunner = savedR08State.longTextRunner;
  P.state.longTextCancel = savedR08State.longTextCancel;
  P.state.longTextJobIds = savedR08State.longTextJobIds;
  if (savedR08Store === null) sandbox.localStorage.removeItem('ns_long_text_run'); else sandbox.localStorage.setItem('ns_long_text_run', savedR08Store);
}

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
  // ⚠️ 2026-09-27 规格修正（R02.3）：空补丁是**合法的"无修改"**，不是解析失败。
  //    旧行为（返回 null → 调用方回退整章重写）会让一次"没有要改的"任务再花一次钱，
  //    还可能把整章改坏。现在的语义：ok + noop + 原文原样返回，调用方据此收尾。
  check('89 空补丁清单 = 合法"无修改"（ok+noop，不回退整章重写）', (() => {
    const r = P.tryApplyRevisionOutput('{"patches":[]}', article);
    return !!r && r.ok === true && r.noop === true && r.text === article && r.applied.length === 0 && r.unresolved.length === 0;
  })());
  check('90 补丁都定位不到时 ok=false（调用方据此回退）', (() => { const r = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ anchor: '不存在的段落。', revised: 'x' }] }), article); return !!r && r.ok === false && r.unresolved.length === 1; })());

  // R02.3（2026-09-27）：唯一性与重叠必须显式失败，不能静默改错段/吞补丁。
  const dupArticle = ['相同的话。', '第二段：别的。', '相同的话。'].join('\n\n');
  const dup = P.applyRevisionPatches(dupArticle, [{ issue: 1, anchor: '相同的话。', revised: '改后。' }]);
  check('90a 重复 anchor（逐字相同出现两段）拒绝改动并说明', dup.applied.length === 0 && dup.unresolved.length === 1 && /重复 anchor/.test(dup.unresolved[0].reason) && dup.text === dupArticle, JSON.stringify(dup.unresolved[0] && dup.unresolved[0].reason));
  const ambArticle = ['甲：他摸到一枚芯片，指尖一缩。', '乙：他摸到一枚芯片，指尖一缩，然后又缩了一下。'].join('\n\n');
  const amb = P.applyRevisionPatches(ambArticle, [{ issue: 2, anchor: '他摸到一枚芯片，指尖一缩', revised: '他摸到两枚芯片。' }]);
  check('90b 包含型 anchor 命中多段时拒绝（非唯一）', amb.applied.length === 0 && /非唯一/.test(amb.unresolved[0].reason), JSON.stringify(amb.unresolved[0] && amb.unresolved[0].reason));
  const overlap = P.applyRevisionPatches(article, [
    { issue: 1, anchor: '第一段：陈默走进雨里。', revised: '第一段：改甲。' },
    { issue: 2, anchor: '第一段：陈默走进雨里。', revised: '第一段：改乙。' },
  ]);
  check('90c 重叠补丁（同段两条）显式拒绝第二条、保留第一条', overlap.applied.length === 1 && overlap.unresolved.length === 1 && /重叠/.test(overlap.unresolved[0].reason) && overlap.text.includes('改甲。') && !overlap.text.includes('改乙。'), JSON.stringify(overlap.unresolved[0] && overlap.unresolved[0].reason));

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
  // 2026-09-22：篇幅的**权威口径**必须进提示词。此前模型只能自己挑尺子：AI 写作按本章目标
  // （3000）补足、审稿却按作品默认/风格区间（4000）判，于是 work#18 第 5、6 章被反复误报
  // 「篇幅不足」——一条由口径不一致制造、却被记成正文问题的假 issue。
  const withTarget = P.buildAIReviewPrompt('正文内容', '', '', 3000);
  check('98e 审稿提示词声明篇幅权威口径（本章目标字数）',
    withTarget.includes('篇幅口径：本章目标 3000 字') && withTarget.includes('不要据此报"篇幅不足"'));
  check('98f 拿不到目标字数时不编造数字（不出现空的篇幅口径段）',
    !P.buildAIReviewPrompt('正文内容').includes('篇幅口径'));
  // 2026-09-22 复盘（REV-1 / REV-2）：预检块的两条"如实性"——
  // 没给章号时只跑了作品级检查，不能写成"四项均未发现问题"；已忽略项要显示当初那句话，
  // 内部键（character:67 之类）作者看不懂，只配放在 title 里给排查用。
  const guardWithChapter = P.continuityGuardSummaryHtml(
    { findings: [], exempted: [], checked: { chapterLabel: '第五章' } }, 123);
  const guardNoChapter = P.continuityGuardSummaryHtml(
    { findings: [], exempted: [], checked: { chapterLabel: '' } }, null);
  check('98g 有章号时零命中照旧写"四项均未发现问题"', guardWithChapter.includes('均未发现问题'));
  check('98h 无章号时如实标注"未指定章节"（不谎称四项都通过）',
    guardNoChapter.includes('未指定章节') && !guardNoChapter.includes('均未发现问题'));
  const exemptedHtml = P.continuityGuardSummaryHtml({
    findings: [],
    exempted: [{ key: 'system_frequency:chapter:123', message: '系统出场 20 次，超过上限 15 次', severity: 'info' }],
    checked: { chapterLabel: '第五章' },
  }, 123);
  check('98i 已忽略项显示原话、键退到 title（作者看得懂忽略的是哪条）',
    exemptedHtml.includes('系统出场 20 次') && exemptedHtml.includes('title="system_frequency:chapter:123"'));
  check('98j 「恢复」按钮带章号（刷新必须与列表同口径）',
    exemptedHtml.includes('data-action="continuity-restore"') && exemptedHtml.includes('data-chapter-id="123"'));

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

  // S3：空回复 → 先保持原思考强度 + 更大上限重试一次（实测：思考会把 max_tokens 吃光）
  P.state.apiConfigs = [{ id: 1, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 4096 }];
  P.state.activeConfigId = 1;
  directCalls.length = 0;
  stub.directEmptyOnce = true;
  const reply = await P.directAIWrite([{ role: 'user', content: '写点东西' }], {});
  check('103 首次空回复后重试并拿到内容', reply === '重试后拿到的正文', String(reply));
  check('104 确实发生了两次调用', directCalls.length === 2, directCalls.length + ' 次');
  check('105 第一次空回复后先保持原思考强度重试（不降 low）', directCalls[1] && directCalls[1].reasoning_effort === undefined, JSON.stringify(directCalls[1] && directCalls[1].reasoning_effort));
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
    // R02.3：合并现在会先取当前正文比对指纹（原文被改就拒绝）。stub 必须回出与预览底稿一致的正文。
    sandbox.api = async (url, opts = {}) => {
      calls.push({ url: String(url), body: opts.body });
      if (String(url).includes('/chapters/107')) return { id: 107, content: '甲。' };
      return { ok: true };
    };
    sandbox.toast = (m) => { msgs.push(String(m)); };
    sandbox.applySelectedProposals = () => {};
    sandbox.loadWorkData = async () => {};
    sandbox.render = async () => {};
    sandbox.closeModal = () => {};
    // 差异预览（带生成时原文指纹）——合并闸门要能核到这一版底稿
    // R03：结果弹窗关闭时固化下来的勾选集合（真实流程里先于差异预览产生），
    // 差异预览会把它固化成「本次合并要采纳的提案」。
    P.state.pendingProposalSelection = { workId: 1, ids: [71, 72] };
    const realOpen2 = sandbox.openModal;
    sandbox.openModal = () => {};
    P.showReviewDiff('甲。', '乙。', { applied: 1, chapterId: 107 });
    sandbox.openModal = realOpen2;
    // R03：合并走 /novel/adopt 的整次采纳（正文 + 勾选提案同一事务），不再是 chapter_save + 另发提案请求
    await P.mergeReviewDiff();
    Object.assign(sandbox, saved);
    const mergeCall = calls.find((c) => c.url.includes('/novel/adopt'));
    check('107g 合并走整次采纳且写回的是修稿所属的那一章（不是当前打开的章）',
      !!mergeCall && Number(mergeCall.body && mergeCall.body.chapter_id) === 107
        && String(mergeCall.body.content || '').includes('乙'),
      JSON.stringify(mergeCall && mergeCall.body && mergeCall.body.chapter_id));
    check('107g2 整次采纳携带勾选提案 id 与稳定的幂等键 operation_key',
      !!mergeCall && Array.isArray(mergeCall.body.legacy_proposal_ids)
        && mergeCall.body.legacy_proposal_ids.join(',') === '71,72'
        && typeof mergeCall.body.operation_key === 'string' && mergeCall.body.operation_key.length >= 8,
      JSON.stringify(mergeCall && mergeCall.body && { ids: mergeCall.body.legacy_proposal_ids, key: mergeCall.body.operation_key }));
    check('107g3 不再出现"先正文后提案"的两次请求（旧路径必须消失）',
      !calls.some((c) => c.url.includes('/novel/chapter_save')) && !calls.some((c) => c.url.includes('/novel/proposals/apply')),
      calls.map((c) => c.url).join(','));
    check('107h 跨章合并后明确告知写到了哪一章', msgs.some((m) => m.includes('第107章')), msgs.join(' | ').slice(0, 70));

    // R02.3：预览期间原文被改 → 拒绝合并（绝不覆盖更新的正文）
    {
      const calls2 = [];
      const msgs2 = [];
      const saved2 = { api: sandbox.api, toast: sandbox.toast, closeModal: sandbox.closeModal, loadWorkData: sandbox.loadWorkData, render: sandbox.render, applySelectedProposals: sandbox.applySelectedProposals, openModal: sandbox.openModal };
      sandbox.api = async (url, opts = {}) => {
        calls2.push({ url: String(url), body: opts.body });
        if (String(url).includes('/chapters/107')) return { id: 107, content: '甲。作者又改过了。' };
        return { ok: true };
      };
      sandbox.toast = (m) => { msgs2.push(String(m)); };
      sandbox.closeModal = () => {};
      sandbox.loadWorkData = async () => {};
      sandbox.render = async () => {};
      sandbox.applySelectedProposals = () => {};
      sandbox.openModal = () => {};
      P.state.currentChapterId = 108;
      P.showReviewDiff('甲。', '乙。', { applied: 1, chapterId: 107 });
      await P.mergeReviewDiff();
      Object.assign(sandbox, saved2);
      check('107h2 原文在预览后被修改 → 拒绝合并且不写库',
        !calls2.some((c) => c.url.includes('/novel/adopt')) && msgs2.some((m) => /拒绝合并/.test(m)),
        msgs2.join(' | ').slice(0, 90));
    }

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
    // ⚠️ 第五轮重审抓到的第二个真缺陷：编辑器只在写作视图存在，切到总览/设定等视图后
    // `#editor-content` 被卸载；旧实现此时**静默返回空串**（违背"取不到就报错"的契约），
    // 而「接回进度」等待期间切视图正好命中 → 补丁全落空 → 把模型原始输出当修稿稿。
    {
      const savedEditor = containers['#editor-content'];
      // ⚠️ 只删 containers 不够：mkEl 会把元素同时登记进 `registered`，
      // 而 `$()` 的兜底顺序正是 containers → registered（第一版这里没删后者，于是编辑器照样被找到）。
      const savedRegistered = registered.get('#editor-content');
      delete containers['#editor-content'];
      registered.delete('#editor-content');
      const calls2 = [];
      const realApi3 = sandbox.api;
      sandbox.api = async (url) => { calls2.push(String(url)); return { id: 108, content: '<p>库里那一章的正文</p>' }; };
      const fallbackBase = await P.revisionBaseArticle(108); // 108 就是当前章，但编辑器不在 DOM
      sandbox.api = realApi3;
      containers['#editor-content'] = savedEditor;
      if (savedRegistered) registered.set('#editor-content', savedRegistered);
      check('107l 编辑器不在 DOM 时退回库里正文，而不是静默给空底稿',
        fallbackBase === P.editorPlainText('<p>库里那一章的正文</p>') && calls2.some((u) => u.includes('/chapters/108')),
        JSON.stringify({ fallbackBase, calls2 }));
    }
  }

  // 提案采纳：被零损失护栏拦下时必须**说明原因**（第 2 步新增的拒绝路径）。
  // 背景：AI 自压缩提案在作者点「采纳」时过实体完整性护栏，不通过就保留 pending。
  // 旧实现的 else 分支只说"提案已保留"——作者不知道是被拦了、还是自己没勾选，
  // 也就无从修正。这里用五条断言钉住全部分支（被拦 / 未拦 / 旧服务端缺字段 / 正常采纳 / 超长原因截断）。
  // ⚠️ 应用函数挂在 sandbox（真实 app.js 作用域）上，**不在** P（__probe 只挑了一部分）。
  {
    const saved = {
      api: sandbox.api, toast: sandbox.toast,
      qsa: sandbox.document.querySelectorAll, pending: P.state.pendingAIProposals
    };
    const msgs = [];
    sandbox.toast = (m) => { msgs.push(String(m)); };
    sandbox.document.querySelectorAll = () => [{ dataset: { proposalId: '7' } }];
    P.state.pendingAIProposals = { workId: 2 };

    // ① 被护栏拦下 → 必须报出条数与原因，而不是笼统的"已保留"
    //    夹具刻意用**很长的 reasons**：toast 可见文案在 240 字处截断（完整内容挂 title），
    //    所以断言要保证前缀（条数/原因标题）与缺失实体名都落在截断线内——否则等于没说。
    const longReasons = ['实体覆盖率 50% 低于下限 100%（丢失 1/2）：林晚（社里人称“晚姐”）'
      + '；' + '这项原因刻意写得很长'.repeat(20)];
    sandbox.api = async () => ({
      applied: { events: 0, memories: 0 },
      guard_failed: [{ proposal_id: 7, reasons: longReasons }]
    });
    await sandbox.applySelectedProposals();
    check('108h 被护栏拦下时说明原因（含缺失实体名），不再只说"已保留"',
      msgs.length === 1 && msgs[0].includes('零损失护栏') && msgs[0].includes('林晚'),
      msgs.join(' | ').slice(0, 90));
    check('108h2 超长原因被截断后，缺失实体名仍在可见文案内（不被前缀挤出截断线）',
      msgs.length === 1 && msgs[0].includes('林晚') && msgs[0].length < 300,
      `len=${msgs[0] ? msgs[0].length : 0}`);

    // ② 无被拦项（例如作者没勾选）→ 保持原有文案，不谎报护栏
    // ⚠️ 函数入口会把 state.pendingAIProposals 置空（防重复提交），所以每个用例都要重设，
    // 否则第二次调用直接 return，断言会"因为没跑到"而假失败。
    msgs.length = 0;
    P.state.pendingAIProposals = { workId: 2 };
    sandbox.api = async () => ({ applied: { events: 0, memories: 0 }, guard_failed: [] });
    await sandbox.applySelectedProposals();
    check('108i 没有提案被拦时保持原有提示（不误报护栏拦截）',
      msgs.length === 1 && msgs[0].includes('已保留') && !msgs[0].includes('护栏'),
      msgs.join(' | ').slice(0, 90));

    // ③ 旧服务端不返回 guard_failed → 不得因此报错或误报（向后兼容）
    msgs.length = 0;
    P.state.pendingAIProposals = { workId: 2 };
    sandbox.api = async () => ({ applied: { events: 0, memories: 0 } });
    await sandbox.applySelectedProposals();
    check('108j 旧服务端不返回 guard_failed 时不误报、不抛错',
      msgs.length === 1 && msgs[0].includes('已保留') && !msgs[0].includes('护栏'),
      msgs.join(' | ').slice(0, 90));

    // ④ 正常采纳 → 成功提示不受影响（回归）
    msgs.length = 0;
    P.state.pendingAIProposals = { workId: 2 };
    sandbox.api = async () => ({ applied: { events: 1, memories: 1 }, guard_failed: [] });
    await sandbox.applySelectedProposals();
    check('108k 正常采纳仍提示已采纳条数（成功路径未受影响）',
      msgs.length === 1 && msgs[0].includes('已采纳 2 条'), msgs.join(' | ').slice(0, 90));

    sandbox.api = saved.api;
    sandbox.toast = saved.toast;
    sandbox.document.querySelectorAll = saved.qsa;
    P.state.pendingAIProposals = saved.pending;
  }

  // 付费调用的前置校验：底稿为空时**一次调用都不许发**。
  // ⚠️ 这是第四轮改动引入的新可能：'接回进度 / 查看上次审稿'那条路上，
  // 取目标章正文失败会让 info.article 为空 —— 空底稿的审稿/修稿是"必花钱、必无用"。
  {
    const calls = { harness: 0, review: 0 };
    const msgs = [];
    const saved = {
      runHarnessJob: sandbox.runHarnessJob, toast: sandbox.toast, closeModal: sandbox.closeModal,
      querySelectorAll: sandbox.document.querySelectorAll, pendingReview: P.state.pendingReview
    };
    sandbox.runHarnessJob = async () => { calls.harness += 1; return { output: '' }; };
    sandbox.toast = (m) => { msgs.push(String(m)); };
    sandbox.closeModal = () => {};
    // 桩里 querySelectorAll 恒返回空 → 让「勾选清单」这一关先通过，才能测到"底稿为空"这一关
    sandbox.document.querySelectorAll = () => [{ dataset: { reviewIssue: '0' } }];

    P.state.pendingReview = { info: { article: '', chapterId: 107 }, review: { issues: ['问题一'] } };
    await P.refineByChecklist();
    check('108a 底稿为空时不发起修稿调用（空底稿必花钱必无用）', calls.harness === 0, `harness=${calls.harness}`);
    check('108b 底稿为空时明确告知原因', msgs.some((m) => m.includes('没有拿到这一章的正文')), msgs.join(' | ').slice(0, 60));

    // 同样地：审稿也不该在空正文上发起
    await P.runArticleReview({ article: '', chapterId: 107 });
    check('108c 正文为空时不发起审稿调用', calls.harness === 0, `harness=${calls.harness}`);
    check('108d 空正文审稿被拦下时给出可执行的提示', msgs.some((m) => m.includes('未发起审稿')), msgs.join(' | ').slice(0, 60));

    // 反证：有底稿时必须真的调用（否则上面两条可能只是"函数永远不动"）
    calls.harness = 0;
    P.state.pendingReview = { info: { article: '第一段：正文。', chapterId: 107 }, review: { issues: ['问题一'] } };
    sandbox.runHarnessJob = async () => { calls.harness += 1; return { output: '{"patches":[]}' }; };
    await P.refineByChecklist();
    check('108e 有底稿时正常发起修稿（证明 108a 不是"函数根本不会调用"）', calls.harness >= 1, `harness=${calls.harness}`);

    sandbox.runHarnessJob = saved.runHarnessJob;
    sandbox.toast = saved.toast;
    sandbox.closeModal = saved.closeModal;
    sandbox.document.querySelectorAll = saved.querySelectorAll;
    P.state.pendingReview = saved.pendingReview;
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
  const resultArgs = [];
  const applyArgs = [];
  const realShowResult = sandbox.showAIWritingResult;
  const realApply = sandbox.applyAIWritingArticle;
  const realToast = sandbox.toast;
  const toastMsgs = [];
  sandbox.showAIWritingResult = async (...a) => { resultOpened += 1; resultArgs.push(a); return null; };
  sandbox.applyAIWritingArticle = async (...a) => { applyArgs.push(a); };
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
  // ⚠️ 第五轮重审抓到的真缺陷：三处 showAIWritingResult 都没传 meta.chapterId，
  // 于是 pendingAIArticle.chapterId 取的是"弹窗出现那一刻打开的章"——写作要跑几分钟，
  // 期间切章就会让后续「先审稿再应用 → 修稿 → 合并」把这一章的稿写进另一章。
  // 这里断言结果弹窗拿到的是**入口捕获的章号**（本例 state.currentChapterId = 107）。
  const metaArg = resultArgs[0] && resultArgs[0][5];
  check('108f 结果弹窗拿到入口捕获的章号（不是弹窗出现时的当前章）',
    !!metaArg && Number(metaArg.chapterId) === 107, JSON.stringify(metaArg));
  // 成文耗时账本（口径 A）：结果弹窗还必须拿到**真实**的通道 / 模型 / 分轮耗时 ——
  // 2026-09-21 的真实库里这三项从来是空串与 0（4 行全部如此），这条断言钉的正是那个失效的测量口径。
  check('108h 结果弹窗拿到真实的通道/模型与分轮耗时账本（埋点不再记空串与 0）',
    !!metaArg && typeof metaArg.channel === 'string' && metaArg.channel !== ''
      && typeof metaArg.model === 'string' && metaArg.model !== ''
      && Number.isFinite(Number(metaArg.ms)) && Number(metaArg.ms) >= 0
      && !!metaArg.timing && Array.isArray(metaArg.timing.phases) && metaArg.timing.phases.length >= 1
      && Number.isFinite(metaArg.timing.total_ms),
    JSON.stringify(metaArg && { channel: metaArg.channel, model: metaArg.model, ms: metaArg.ms, phases: metaArg.timing && metaArg.timing.phases }));
  // 应用动作也必须写回同一章：让"写作期间切章"真的发生（在结果弹窗打开的那一刻改当前章），
  // 断言应用动作拿到的仍是入口捕获的 107 —— 这正是缺陷现场（旧实现会写 999）。
  {
    const beforeApply = applyArgs.length;
    P.state.currentChapterId = 107;   // 入口时还在 107
    sandbox.showAIWritingResult = async (...a) => {
      resultOpened += 1; resultArgs.push(a);
      P.state.currentChapterId = 999;  // 模拟：弹窗打开的这一刻，作者已经切到别的章
      return 'replace';
    };
    stub.blueprintAsProse = true;
    await P.performToolbarAIWrite('续写本章');
    stub.blueprintAsProse = false;
    const call = applyArgs[beforeApply];
    check('108g 写作期间切章后，应用动作仍写回发起写作的那一章',
      !!call && String(call[2]) === '107', JSON.stringify(call && call[2]));
    P.state.currentChapterId = 107;
  }
  sandbox.showAIWritingResult = realShowResult;
  sandbox.applyAIWritingArticle = realApply;
  sandbox.toast = realToast;
}

// --- 12) 批量生成：红线自检结果必须**告知**作者（此前完全没读 scan，作者永远不知道命中多少） ---
// 关键点有两个：① 扫的是**成文 + 补足合并后**的全文（不是 harness 单次 job 的 output）；
//            ② 三种口径（命中 / 通过 / 不可用）要分别说得出口，不能含糊成一句"完成"。
{
  // 直连通道的可控桩：`directReply(prompt)` 返回内容 → 直连成功；返回 '' / null → 直连不可用（走回退）。
  // `truncated` 模拟"上下文被预算截断"（此时**不允许**走直连：只有慢通道能取回被裁掉的原文）。
  const runBatch = async ({
    scanTotal = 2, scanThrows = false,
    directReply = () => null, truncated = false
  } = {}) => {
    const toasts = [];
    const calls = [];
    const harnessPrompts = [];
    const directPrompts = [];
    const saved = {
      api: sandbox.api, toast: sandbox.toast, runHarnessJob: sandbox.runHarnessJob,
      loadWorkData: sandbox.loadWorkData, render: sandbox.render, reportClientLog: sandbox.reportClientLog,
      refreshProposalBadge: sandbox.refreshProposalBadge,
      directAIWrite: sandbox.directAIWrite, aiContextTruncated: sandbox.aiContextTruncated
    };
    P.state.workId = 2;
    P.state.work = { id: 2, title: '测试作品', default_chapter_words: 8 };
    P.state.currentChapterId = 107;
    P.state.chapters = [{ id: 107, title: '第107章', target_words: 8, content: '' }];
    containers['#editor-content'] = containers['#editor-content'] || mkEl('editor-content');
    sandbox.toast = (m) => { toasts.push(String(m)); };
    sandbox.aiContextTruncated = () => truncated;
    sandbox.directAIWrite = async (messages) => {
      const prompt = String((messages && messages[0] && messages[0].content) || '');
      directPrompts.push(prompt);
      return directReply(prompt);
    };
    sandbox.api = async (url, opts = {}) => {
      calls.push({ url: String(url), body: opts.body });
      if (String(url).includes('/novel/empty_chapters')) return { chapters: [{ id: 107, title: '第107章', target_words: 8 }] };
      if (String(url).includes('/novel/scan')) {
        if (scanThrows) throw new Error('扫描服务不可用');
        return { ok: true, total: scanTotal, hits: scanTotal ? [{ kind: 'phrase', pattern: '嘴角勾起', note: '', count: scanTotal }] : [] };
      }
      return { ok: true };
    };
    // harness 侧：蓝图一次 + 成文一次 + 补足一次（补足是为了验证"扫的是合并后的全文"）
    let harnessCalls = 0;
    sandbox.runHarnessJob = async (body) => {
      harnessCalls += 1;
      const prompt = String((body && body.prompt) || '');
      harnessPrompts.push(prompt);
      // ⚠️ 按**提示词特征**分派，不按调用序号：蓝图改走直连后，harness 的第一次调用就是"成文"，
      //    序号派发会让下面所有断言跟着错位（顺序一变就假通过）。
      if (isBlueprintPrompt(prompt)) return { output: '【蓝图】{"scene_goal":"开场","target_words":8}' };
      if (isContinuationPrompt(prompt)) return { output: '【成文】续写片段。' };
      return { output: '【成文】正文第一段。' };
    };
    sandbox.loadWorkData = async () => {};
    sandbox.render = async () => {};
    sandbox.refreshProposalBadge = async () => {};
    sandbox.reportClientLog = () => {};
    await P.batchGenerateChapters(1);
    Object.assign(sandbox, saved);
    const scanCall = calls.find((c) => c.url.includes('/novel/scan'));
    const finalToast = toasts[toasts.length - 1] || '';
    return { calls, toasts, finalToast, harnessCalls, harnessPrompts, directPrompts, scannedText: scanCall && scanCall.body && scanCall.body.text };
  };
  // 蓝图提示词与续写提示词的判别串（分别取自 buildAIWritingBlueprintPrompt 的 auto 分支与
  // buildAIWritingContinuationPrompt 的首行）——用结构特征而不是"第几次调用"，避免顺序一变就假通过。
  const isBlueprintPrompt = (p) => p.includes('【蓝图】') && p.includes('批量自动模式');
  const isContinuationPrompt = (p) => p.includes('继续写本章正文');

  const hit = await runBatch({ scanTotal: 2 });
  check('109a 批量生成会对**合并后的全文**跑红线自检（成文+补足都在）',
    String(hit.scannedText || '').includes('正文第一段') && String(hit.scannedText || '').includes('续写片段'),
    JSON.stringify(hit.scannedText));
  check('109b 命中时收尾 toast 如实报出命中数与章名',
    hit.finalToast.includes('红线自检命中 2 处') && hit.finalToast.includes('第107章'), hit.finalToast);
  check('109c 命中时仍保留提案去处指路', hit.finalToast.includes('待确认提案'), hit.finalToast);

  const clean = await runBatch({ scanTotal: 0 });
  check('109d 零命中时报"通过"，不谎报命中也不省略', clean.finalToast.includes('红线自检通过'), clean.finalToast);

  const broken = await runBatch({ scanThrows: true });
  check('109e 扫描不可用时如实说明，且不影响写回', broken.finalToast.includes('红线自检不可用') && broken.finalToast.includes('已写入正文'), broken.finalToast);
  check('109f 三种口径互斥（同一次运行只出现其中一种说法）', (() => {
    const markers = ['红线自检命中', '红线自检通过', '红线自检不可用'];
    const n = (t) => markers.filter((m) => t.includes(m)).length;
    // ⚠️ 不能用 `!clean.includes('命中')`：'未命中反 AI 腔词句' 里也含"命中"两个字（第一版就是这么假失败的）。
    return n(hit.finalToast) === 1 && n(clean.finalToast) === 1 && n(broken.finalToast) === 1
      && hit.finalToast.includes('红线自检命中') && clean.finalToast.includes('红线自检通过')
      && broken.finalToast.includes('红线自检不可用');
  })(), JSON.stringify([hit.finalToast.slice(0, 30), clean.finalToast.slice(0, 30), broken.finalToast.slice(0, 30)]));

  // --- 13) 批量生成的**通道策略**：中间产物走直连、成文轮保留精写内核 ---
  // 这一组的价值在于钉住"提速"本身：慢通道每任务固定开销 ≈17–18 秒（README 实测），
  // 把蓝图/小缺口补足搬出慢通道就是实打实的省时；同时钉住它**没有**顺手改掉成文轮
  // （成文轮承担事件/记忆入账与一致性核对，改直连等于悄悄降质量）。
  const directBlueprint = '【蓝图】{"scene_goal":"直连开场","plot_points":"一","hook":"钩"}';
  const blueprintViaDirect = await runBatch({
    scanTotal: 0,
    directReply: (p) => (isBlueprintPrompt(p) ? directBlueprint : null)
  });
  const blueprintFallback = await runBatch({ scanTotal: 0, directReply: () => null });
  // ⚠️ 断言用**相对口径**（比回退路径少一次慢通道任务），不写死绝对次数：补足轮会跑满 2 轮，
  //    绝对次数会随补足策略变化而漂移，那种断言会在无害改动后假失败。
  check('110a 蓝图走直连时**不再占用慢通道**（慢通道任务数比回退路径正好少一次）',
    !blueprintViaDirect.harnessPrompts.some(isBlueprintPrompt)
      && blueprintViaDirect.directPrompts.some(isBlueprintPrompt)
      && blueprintFallback.harnessCalls - blueprintViaDirect.harnessCalls === 1,
    JSON.stringify({ viaDirect: blueprintViaDirect.harnessCalls, fallback: blueprintFallback.harnessCalls }));
  check('110b 蓝图走直连时，蓝图内容仍然落库（直连产物被正常解析）',
    blueprintViaDirect.calls.some((c) => c.url.includes('/novel/chapter_blueprint')
      && c.body && c.body.blueprint && c.body.blueprint.scene_goal === '直连开场'),
    JSON.stringify(blueprintViaDirect.calls.filter((c) => c.url.includes('blueprint')).map((c) => c.body)));

  check('110c 直连不可用（空回复）时蓝图回退慢通道，且慢通道拿到的是蓝图提示词',
    blueprintFallback.harnessPrompts.some(isBlueprintPrompt) && blueprintFallback.harnessCalls === 4,
    JSON.stringify({ harness: blueprintFallback.harnessCalls }));

  const truncatedRun = await runBatch({ scanTotal: 0, truncated: true, directReply: () => directBlueprint });
  check('110d 上下文被预算截断时蓝图**不走直连**（只有慢通道能取回被裁掉的原文）',
    !truncatedRun.directPrompts.some(isBlueprintPrompt) && truncatedRun.harnessPrompts.some(isBlueprintPrompt),
    JSON.stringify({ direct: truncatedRun.directPrompts.length }));

  const contDirect = await runBatch({
    scanTotal: 0,
    directReply: (p) => (isBlueprintPrompt(p) ? directBlueprint : (isContinuationPrompt(p) ? '【成文】直连续写片段。' : null))
  });
  check('110e 小缺口补足走直连，且扫描的是"成文+直连续写"合并后的全文',
    !contDirect.harnessPrompts.some(isContinuationPrompt)
      && contDirect.directPrompts.some(isContinuationPrompt)
      && String(contDirect.scannedText || '').includes('直连续写片段'),
    JSON.stringify({ harnessPrompts: contDirect.harnessPrompts.length, scanned: String(contDirect.scannedText || '').slice(0, 40) }));

  check('110f 收尾 toast 报出本批实际耗时（让"提速有没有生效"当场可核对）',
    hit.finalToast.includes('用时') && hit.finalToast.includes('/章'), hit.finalToast);
}

// --- 14) 成文轮（正文写作的主链路）：① 内联写作纪律；② 空回复必须重试而不是白等/报错 ---
// 这两条都来自"正文写作"这条主链路，而不是批量/审稿等旁路。
{
  // ① 纪律内联：成文轮此前是唯一漏掉 WRITING_DISCIPLINE 的一轮（蓝图轮/审稿轮都有），
  //    于是直连成文既没有插件人设、也没有内联纪律 —— 只有上下文里的红线**词表**。
  const prosePrompt = P.buildAIWritingProsePrompt('需求文本', { scene_goal: '开场' }, 2000);
  check('111a 成文提示词内联了写作纪律（与蓝图轮/审稿轮同源，不再只有红线词表）',
    prosePrompt.includes('【写作纪律（务必遵守）】') && prosePrompt.includes('感官细节'),
    prosePrompt.slice(0, 120));

  // ② 空回复重试：/api/ai/write_stream 在"思考吃光 max_tokens"时会回 done + text:''，
  //    旧实现把空的 text 包成一个**真值对象**返回 → 调用方 `if (!proseData)` 判不出来 →
  //    既不重试也不回退，直接报"AI 没有返回正文内容"，整章白等。
  const savedFetch = sandbox.fetch;
  const savedTextDecoder = sandbox.TextDecoder;
  const savedReport = sandbox.reportClientLog;
  sandbox.TextDecoder = class { decode(bytes) { return bytes ? Buffer.from(bytes).toString('utf8') : ''; } };
  sandbox.reportClientLog = () => {};
  const sse = (frames) => {
    const bytes = Buffer.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), 'utf8');
    let sent = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })) }) },
      json: async () => ({}), text: async () => ''
    };
  };
  const runStream = async (script) => {
    const bodies = [];
    let i = 0;
    sandbox.fetch = async (url, opts = {}) => {
      bodies.push(JSON.parse(String(opts.body || '{}')));
      const frames = script[Math.min(i, script.length - 1)];
      i += 1;
      return String(url).includes('/api/ai/write_stream') ? sse(frames) : { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };
    P.state.aiTaskRunning = false;
    let outcome = null;
    try {
      outcome = { ok: true, value: await P.streamAIDirectWrite({ config_id: 1, messages: [{ role: 'user', content: 'x' }], max_tokens: 4096 }, '测试成文') };
    } catch (e) {
      outcome = { ok: false, error: e };
    }
    return { bodies, outcome };
  };

  const retried = await runStream([
    [{ done: true, text: '' }],
    [{ delta: '重试后拿到的正文' }, { done: true, text: '重试后拿到的正文' }]
  ]);
  check('111b 空回复会先保持原思考强度并放宽输出上限重试一次',
    retried.bodies.length === 2
      && retried.bodies[1].reasoning_effort === undefined
      && Number(retried.bodies[1].max_tokens) > Number(retried.bodies[0].max_tokens),
    JSON.stringify(retried.bodies.map((b) => ({ e: b.reasoning_effort, m: b.max_tokens }))));
  check('111c 重试成功时用重试结果交付（不再整章白等、也不再报错）',
    retried.outcome.ok && retried.outcome.value.text === '重试后拿到的正文',
    JSON.stringify(retried.outcome.ok ? retried.outcome.value : String(retried.outcome.error)));

  const alwaysEmpty = await runStream([[{ done: true, text: '' }]]);
  check('111d 保持原思考强度重试仍空后，再降 low 兜底；三次都空才抛错',
    !alwaysEmpty.outcome.ok && alwaysEmpty.outcome.error.emptyReply === true
      && alwaysEmpty.bodies.length === 3
      && alwaysEmpty.bodies[1].reasoning_effort === undefined
      && alwaysEmpty.bodies[2].reasoning_effort === 'low'
      && Number(alwaysEmpty.bodies[2].max_tokens) > Number(alwaysEmpty.bodies[0].max_tokens),
    JSON.stringify({ calls: alwaysEmpty.bodies.length, msg: String(alwaysEmpty.outcome.error && alwaysEmpty.outcome.error.message), bodies: alwaysEmpty.bodies.map((b) => ({ e: b.reasoning_effort, m: b.max_tokens })) }));

  const partial = await runStream([[{ delta: '半截正文' }]]);
  check('111e 半截流（有正文但没等到 done）仍抛错——绝不把残缺正文当成品交付',
    !partial.outcome.ok && /未收到完成信号/.test(String(partial.outcome.error && partial.outcome.error.message)),
    String(partial.outcome.error && partial.outcome.error.message));

  sandbox.fetch = savedFetch;
  sandbox.TextDecoder = savedTextDecoder;
  sandbox.reportClientLog = savedReport;
}

// --- 12b) 成文耗时账本落地：埋点必须真的收到通道/模型/耗时，并留下可核对的分轮明细 ---
// 依据是真实库实测（2026-09-21）：ai_eval_events 共 4 行，**全部** ms=0、channel/model 为空串 ——
// 三处 showAIWritingResult 调用从来没把 meta.channel/model/ms 传进来过。
// 只断言"参数传进去了"不算证明：必须断言**落库请求**里就是真值，否则等于没修。
{
  const posts = [];
  const timingLogs = [];
  const savedApi = sandbox.api;
  const savedToast = sandbox.toast;
  const savedReport = sandbox.reportClientLog;
  const savedContext = P.state.aiContext;
  sandbox.api = async (p, o = {}) => { if (p === '/ai/eval') posts.push(o.body); return {}; };
  sandbox.toast = () => {};
  sandbox.reportClientLog = (o) => { timingLogs.push(o); return savedReport && savedReport(o); };
  P.state.aiContext = { assembled: '上下文', context_stats: { length: 1234 } };
  const t = P.newWriteTiming();
  t.round('blueprint', 1200, { via: 'direct' });
  t.round('prose', 30500, { via: 'direct', ttft_ms: 2100, chars: 8000 });
  const sum = t.summary();
  const pending = sandbox.showAIWritingResult('正文', null, null, 3000, null,
    { chapterId: 107, channel: 'direct', model: 'deepseek-flash', ms: sum.total_ms, timing: sum });
  const gen = posts[0] || {};
  check('112a 成文埋点写入了真实通道/模型/上下文规模（不再是空串与 0）',
    gen.action === 'generate' && gen.channel === 'direct' && gen.model === 'deepseek-flash' && Number(gen.chars_in) === 1234,
    JSON.stringify(gen));
  const tl = timingLogs.find((l) => l.kind === 'ai_write_timing');
  check('112b 每次成文留下分轮耗时账（总时长 / 首字 / 直连与慢通道分量可核对）',
    !!tl && tl.context.total_ms === sum.total_ms && tl.context.ttft_ms === 2100
      && tl.context.direct_ms === 31700 && tl.context.phases.length === 2 && tl.context.draft_key === gen.draft_key,
    JSON.stringify(tl && tl.context));
  P.state.pendingAIFinal('insert');
  await pending;
  const adopt = posts.find((p) => p.action === 'adopt');
  check('112c 采纳行与生成行共用 draft_key（口径 B 交付时间 = 两行时间之差，可直接算出来）',
    !!adopt && adopt.draft_key === gen.draft_key && String(adopt.draft_key || '') !== '',
    JSON.stringify(posts.map((p) => ({ a: p.action, k: p.draft_key }))));
  sandbox.api = savedApi;
  sandbox.toast = savedToast;
  sandbox.reportClientLog = savedReport;
  P.state.aiContext = savedContext;
}

// --- 13) 空回复阶梯与「思考 + 正文」额度：非流式直连路径 ---
// 依据（真实库 + 真实日志，2026-09-21）：7 次空回复**全部**来自非流式路径（成文流式 0 次），
// 其中同一天两条完整失败链，每次都是「1500 被思考吃光 → 8192 又被吃光 → 换 low + 8192 还是被吃光
// → 回退精写内核」，一个 gap≈250 字的补足白等 2–6 分钟。
// 另据本函数头注释：它一直写着"放宽输出上限再试一次；只有仍为空时才降思考预算兜底"，
// 但实现在 budgetExhausted 时**跳过**了保持原强度的那次重试 —— 实现与自己的描述自相矛盾。
{
  const savedApi = sandbox.api;
  const savedReport = sandbox.reportClientLog;
  const savedConfigs = P.state.apiConfigs;
  const savedActive = P.state.activeConfigId;
  const savedToast = sandbox.toast;
  const bodies = [];
  const logs = [];
  sandbox.api = async (p, o = {}) => {
    if (String(p).startsWith('/ai/write')) {
      bodies.push(o.body);
      return {
        reply: '',
        raw: {
          choices: [{ finish_reason: 'length' }],
          usage: { completion_tokens: 1500, completion_tokens_details: { reasoning_tokens: 1500 } }
        }
      };
    }
    return {};
  };
  sandbox.reportClientLog = (o) => { logs.push(o); return savedReport && savedReport(o); };
  sandbox.toast = () => {};
  P.state.apiConfigs = [{ id: 7, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 393216 }];
  P.state.activeConfigId = 7;

  const empty = await P.directAIWrite([{ role: 'user', content: '续写' }], { model: 'deepseek-flash', maxTokens: 1500 });
  check('113a 预算被思考吃光时也走完整的 3 次阶梯（不再跳过"保强度"的那次重试）',
    empty === null && bodies.length === 3,
    JSON.stringify(bodies.map((b) => ({ e: b.reasoning_effort, m: b.max_tokens }))));
  check('113b 第一次重试保持原思考强度、只放宽输出上限（不拿降强度换速度）',
    bodies.length === 3 && bodies[0].reasoning_effort === undefined && bodies[1].reasoning_effort === undefined
      && Number(bodies[1].max_tokens) > Number(bodies[0].max_tokens),
    JSON.stringify(bodies.map((b) => ({ e: b.reasoning_effort, m: b.max_tokens }))));
  check('113c 只有第三次才允许受控降级到 low（前两次都是原强度）',
    bodies.length === 3 && bodies[2].reasoning_effort === 'low' && Number(bodies[2].max_tokens) === Number(bodies[1].max_tokens),
    JSON.stringify(bodies.map((b) => ({ e: b.reasoning_effort, m: b.max_tokens }))));
  const ladderLog = logs.find((l) => l.kind === 'ai_empty_ladder');
  check('113d 整条失败阶梯留一条可诊断的结构化日志（每次的额度 / 结束原因 / 思考 token 都在）',
    !!ladderLog && !!ladderLog.context && Array.isArray(ladderLog.context.attempts)
      && ladderLog.context.attempts.length === 3
      && ladderLog.context.attempts[0].reasoning_tokens === 1500
      && Number(ladderLog.context.base_max) === 1500 && Number(ladderLog.context.larger_max) === 8192,
    JSON.stringify(ladderLog && ladderLog.context));

  bodies.length = 0;
  logs.length = 0;
  sandbox.api = async (p, o = {}) => {
    if (String(p).startsWith('/ai/write')) {
      bodies.push(o.body);
      return { reply: '{"verdict":"pass"}', raw: { choices: [{ finish_reason: 'stop' }], usage: {} } };
    }
    return {};
  };
  const verdict = await P.verifyAIDraft(null, '正文正文', 3000);
  check('113e 质检轮的额度带上了思考余量（不再是连思考都不够的 1500）',
    !!verdict && bodies.length === 1 && Number(bodies[0].max_tokens) === P.withThinkingHeadroom(1500)
      && Number(bodies[0].max_tokens) >= 8192 + 1500,
    JSON.stringify({ v: verdict && verdict.pass, m: bodies.map((b) => b.max_tokens) }));
  check('113f 思考余量函数本身：只抬上限、封顶 16384（不凭空产生 token）',
    P.withThinkingHeadroom(1500) === 9692 && P.withThinkingHeadroom(8000) === 16192 && P.withThinkingHeadroom(100000) === 16384 && P.withThinkingHeadroom(0) === 8192,
    [P.withThinkingHeadroom(1500), P.withThinkingHeadroom(8000), P.withThinkingHeadroom(100000), P.withThinkingHeadroom(0)].join(','));
  check('113g 两个补足点（交互 + 批量）都换成了带思考余量的额度，且旧写法已不存在',
    (src.split('withThinkingHeadroom(Math.ceil(gap * 2 + 1000))').length - 1) === 2
      && src.indexOf('maxTokens: Math.min(16384, Math.ceil(gap * 2 + 1000))') === -1,
    'hit=' + (src.split('withThinkingHeadroom(Math.ceil(gap * 2 + 1000))').length - 1));

  sandbox.api = savedApi;
  sandbox.reportClientLog = savedReport;
  sandbox.toast = savedToast;
  P.state.apiConfigs = savedConfigs;
  P.state.activeConfigId = savedActive;
}

// --- 14b) 流式成文的用量回传：把「预算到底花在哪了」变成可实测的数字 ---
// 依据（真实代码，先测量后优化）：server.js 的 callAIStream 早就把流式最后一个 chunk 的 usage
// 收进了 streamUsage（server.js:834 定义 / 880 赋值），却**从来没有向外传过**。于是两个直接决定
// 成文耗时的问题一直只能靠猜：
//   ① 前缀缓存命不命中（prompt_cache_hit_tokens）—— 长上下文的重复发送是成文时间的大头；
//   ② 思考吃掉了多少输出预算（reasoning_tokens）—— 空回复事故的根因就在这里（见上面 113 组）。
// 不把这两个数测出来，任何"提速"改动都无法证明自己真的省了时间、也没有多烧 token。
// 这一组钉住三段链路：服务端随 done 下发 → 客户端透传到返回值 → 落进成文耗时账本的成文轮。
{
  const savedFetch = sandbox.fetch;
  const savedTextDecoder = sandbox.TextDecoder;
  const savedReport = sandbox.reportClientLog;
  sandbox.TextDecoder = class { decode(bytes) { return bytes ? Buffer.from(bytes).toString('utf8') : ''; } };
  sandbox.reportClientLog = () => {};
  const sse = (frames) => {
    const bytes = Buffer.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), 'utf8');
    let sent = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })) }) },
      json: async () => ({}), text: async () => ''
    };
  };
  const runOnce = async (frames) => {
    sandbox.fetch = async (url) => (String(url).includes('/api/ai/write_stream')
      ? sse(frames)
      : { ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
    P.state.aiTaskRunning = false;
    try {
      return { ok: true, value: await P.streamAIDirectWrite({ config_id: 1, messages: [{ role: 'user', content: 'x' }], max_tokens: 4096 }, '测试成文') };
    } catch (e) {
      return { ok: false, error: e };
    }
  };
  const liveUsage = {
    prompt_tokens: 12980, prompt_cache_hit_tokens: 11520,
    completion_tokens: 4210, completion_tokens_details: { reasoning_tokens: 1830 }
  };
  const withUsage = await runOnce([{ delta: '正文一句' }, { done: true, text: '正文一句', usage: liveUsage }]);
  check('114a 服务端随 done 下发的用量被如实透传（缓存命中 / 思考 token 都留得下来）',
    withUsage.ok && !!withUsage.value.usage
      && withUsage.value.usage.prompt_cache_hit_tokens === 11520
      && withUsage.value.usage.completion_tokens_details.reasoning_tokens === 1830,
    JSON.stringify(withUsage.ok ? withUsage.value.usage : String(withUsage.error)));
  // 阴性对照：旧服务端（done 帧不带 usage）必须记 null —— 宁可"这次没数"，也不能编一个看起来正常的数。
  const noUsage = await runOnce([{ delta: '旧服务端正文' }, { done: true, text: '旧服务端正文' }]);
  check('114b 旧服务端不下发用量时记 null（不编造、不拿 0 冒充实测值）',
    noUsage.ok && noUsage.value.usage === null && noUsage.value.text === '旧服务端正文',
    JSON.stringify(noUsage.ok ? noUsage.value.usage : String(noUsage.error)));

  // 跨文件契约：DOM 桩只能证明"收到 usage 会透传"，证明不了服务端真的发了 —— 所以这里直接读 server.js。
  // 三处缺一不可：① 流式收尾把 usage 交给调用方；② 路由注册回调；③ done 帧带上它。
  const serverSrc = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  check('114c 服务端确实把流式用量随 done 下发（回流 + 回调 + 下发三处齐全）',
    serverSrc.includes('if (streamUsage && typeof options.onUsage === \'function\') options.onUsage(streamUsage);')
      && serverSrc.includes('onUsage: (u) => { usage = u; }')
      && serverSrc.includes('send({ done: true, text, scan, usage });'),
    JSON.stringify({
      emit: serverSrc.includes('options.onUsage(streamUsage)'),
      wire: serverSrc.includes('onUsage: (u) => { usage = u; }'),
      frame: serverSrc.includes('send({ done: true, text, scan, usage });')
    }));

  // 成文耗时账本：拿到了 usage 还必须真的记下来，否则"测到了"等于白测。
  const measured = P.newWriteTiming();
  measured.round('prose', 1234, { via: 'direct', ttft_ms: 900, chars: 3000, prompt_tokens: 12980, cached_tokens: 11520, completion_tokens: 4210, reasoning_tokens: 1830 });
  const prosePhase = measured.summary().phases.find((p) => p.name === 'prose') || {};
  check('114d 成文轮的账本保留 token 明细（缓存命中与思考占比能逐轮核对）',
    prosePhase.cached_tokens === 11520 && prosePhase.reasoning_tokens === 1830 && prosePhase.prompt_tokens === 12980,
    JSON.stringify(prosePhase));
  check('114e 前端接线完整：成文轮把 usage 展开进账本，非流式留痕也带上输入侧用量',
    src.includes('const proseUsage = proseData.usage || null;')
      && src.includes('...proseTokens')
      && src.includes('promptTokens: Number.isFinite(Number(usage.prompt_tokens))')
      && src.includes('cachedTokens: Number.isFinite(Number(usage.prompt_cache_hit_tokens))')
      && src.includes('prompt_tokens: meta.promptTokens')
      && src.includes('cached_tokens: meta.cachedTokens'),
    '');

  sandbox.fetch = savedFetch;
  sandbox.TextDecoder = savedTextDecoder;
  sandbox.reportClientLog = savedReport;
}

// --- 15) 取消 / 超时不再丢已生成的正文（P0-3） ---
// 背景：一次成文要跑 30s–6min。此前点「停止」或连接中断时，**已经写出来的正文连同进度卡一起被丢掉**，
// 错误文案自己都写着"白等" —— 而这是口径 B（点击 → 真正拿到能用的稿子）上最贵的一种损失：
// 机器时间白烧了，作者手里还什么都没有。
// 现在的口径：够长就落成草稿（**只保存、不应用**，正文永远由作者自己决定要不要写回），
// 并如实告诉作者去哪里取；碎片段不存 —— getLatestDraft 只取最新一份，一次误点「停止」
// 不该把上一份好稿从「取回生成稿」里顶掉。
{
  const savedFetch = sandbox.fetch;
  const savedDecoder = sandbox.TextDecoder;
  const savedReport = sandbox.reportClientLog;
  const savedToast = sandbox.toast;
  const savedApi = sandbox.api;
  const savedConfirm = sandbox.showBlueprintConfirm;
  const savedCardFn = sandbox.showAITaskProgress;
  const savedDirect = sandbox.directAIWrite;
  const savedApply = sandbox.applyAIWritingArticle;
  // ⚠️ 全局 DOM 桩的 AbortController 只有 signal、没有 abort()：真实浏览器里点「停止」会调用
  // controller.abort()，在这套桩里直接 TypeError（本测试第一版就崩在 app.js:4740）。
  // 只在本段换成"有 abort() 的最小实现"，不碰全局桩 —— 其他段不走取消路径，改全局是没必要的面。
  const savedAbort = sandbox.AbortController;
  const drafts = [];
  let capturedCancel = null;
  let lastToasts = [];
  let applyCalls = 0;

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

  sandbox.TextDecoder = class { decode(b) { return b ? Buffer.from(b).toString('utf8') : ''; } };
  sandbox.reportClientLog = () => {};
  sandbox.toast = (m) => { lastToasts.push(String(m)); };
  // 蓝图轮直连返回一份合法蓝图，并跳过确认弹窗 —— 这样才走得到成文轮（被测的那一轮）。
  sandbox.directAIWrite = async () => '【蓝图】{"scene_goal":"取消测试","plot_points":"一","hook":"钩"}';
  sandbox.showBlueprintConfirm = async (bp) => ({ ...bp, skip: false });
  sandbox.api = async (p, o = {}) => {
    if (p === '/novel/draft') { drafts.push(o && o.body); return { ok: true, chars: String((o && o.body && o.body.content) || '').length }; }
    return savedApi(p, o);
  };
  sandbox.applyAIWritingArticle = async (...a) => { applyCalls += 1; return savedApply(...a); };
  sandbox.AbortController = class { constructor() { this.signal = {}; this.aborted = false; } abort() { this.aborted = true; } };
  sandbox.showAITaskProgress = (label) => {
    const c = savedCardFn(label);
    const orig = c.setCancel;
    c.setCancel = (fn) => { if (fn) capturedCancel = fn; return orig.call(c, fn); };
    return c;
  };
  // 卡住的 SSE：先吐一段正文，然后**一直不结束** —— 直到测试替作者点「停止」，或模拟断线。
  const heldStream = (firstChunk, mode) => {
    let release = null;
    const gate = new Promise((r) => { release = r; });
    let sent = false;
    return {
      release,
      resp: {
        ok: true, status: 200,
        body: { getReader: () => ({ read: async () => {
          if (!sent) { sent = true; return { done: false, value: Buffer.from('data: ' + JSON.stringify({ delta: firstChunk }) + '\n\n', 'utf8') }; }
          await gate;
          const err = new Error(mode === 'abort' ? 'aborted' : 'socket hang up');
          err.name = mode === 'abort' ? 'AbortError' : 'TypeError';
          throw err;
        } }) },
        json: async () => ({}), text: async () => ''
      }
    };
  };
  const runHeld = async (held, cancelIt) => {
    containers['#modal-root'].innerHTML = '';
    sandbox.fetch = async (url, opts) => (String(url).includes('/api/ai/write_stream') ? held.resp : savedFetch(url, opts));
    capturedCancel = null;
    lastToasts = [];
    const p = P.performToolbarAIWrite('续写本章').catch(() => {});
    // 等成文轮真的挂上取消回调（蓝图轮不注册取消，所以拿到的一定是成文轮那一个）
    for (let i = 0; i < 400 && !capturedCancel; i += 1) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40)); // 让第一段正文真的进到账本
    if (cancelIt && capturedCancel) capturedCancel();
    held.release();
    await p;
  };

  const heldA = heldStream('甲'.repeat(260), 'abort');
  await runHeld(heldA, true);
  check('115a 点「停止」后已生成的正文不再被销毁（落成草稿，且只保存、不应用）',
    drafts.length === 1 && Number(drafts[0].chapter_id) === 107 && String(drafts[0].content).length >= 260 && applyCalls === 0,
    JSON.stringify({ n: drafts.length, ch: drafts[0] && drafts[0].chapter_id, len: drafts[0] && String(drafts[0].content).length, apply: applyCalls }));
  check('115b 取消提示如实告诉作者去哪里取回（不再只有一句"已取消"）',
    lastToasts.some((t) => t.includes('已取消 AI 写作') && t.includes('取回生成稿')),
    JSON.stringify(lastToasts));
  check('115c 取消仍然是"取消"语义：不弹错误框',
    capturedCancel !== null && !String(containers['#modal-root'].innerHTML).includes('AI 写作未完成'),
    JSON.stringify({ cancelHooked: capturedCancel !== null, modal: String(containers['#modal-root'].innerHTML).slice(0, 60) }));

  const heldB = heldStream('乙'.repeat(20), 'abort');
  drafts.length = 0;
  await runHeld(heldB, true);
  check('115d 误点「停止」产生的碎片不落草稿（否则会顶掉「取回生成稿」里的上一份好稿）',
    drafts.length === 0 && lastToasts.some((t) => t === '已取消 AI 写作'),
    JSON.stringify({ drafts: drafts.length, toast: lastToasts }));

  const heldC = heldStream('丙'.repeat(260), 'broken');
  drafts.length = 0;
  await runHeld(heldC, false);
  check('115e 断流/超时同样保住已写出的部分，且错误弹窗说明草稿去处',
    drafts.length === 1 && String(containers['#modal-root'].innerHTML).includes('AI 写作未完成')
      && String(containers['#modal-root'].innerHTML).includes('取回生成稿'),
    JSON.stringify({ drafts: drafts.length, modal: String(containers['#modal-root'].innerHTML).replace(/<[^>]*>/g, ' ').slice(0, 120) }));

  sandbox.fetch = savedFetch;
  sandbox.TextDecoder = savedDecoder;
  sandbox.reportClientLog = savedReport;
  sandbox.toast = savedToast;
  sandbox.api = savedApi;
  sandbox.showBlueprintConfirm = savedConfirm;
  sandbox.showAITaskProgress = savedCardFn;
  sandbox.directAIWrite = savedDirect;
  sandbox.applyAIWritingArticle = savedApply;
  sandbox.AbortController = savedAbort;
}

// --- 16) 「模型正在思考」相位：把长时间思考从"像卡死"变成看得见的进展 ---
// 背景：DeepSeek 的思考以 `delta.reasoning_content` 逐片下发，正文之前**可能持续十几秒**。
// 此前这些帧被整个忽略，客户端在这段时间里一帧都收不到 —— 进度卡上一直写着"已 0 字"，
// 作者看到的与一个卡死的界面完全一样。而作者一旦以为卡死，就会点「停止」或「重新生成」，
// 口径 B（交付时间）直接变差 —— 所以这条不是"好看"，它保护的是作者不去白烧一轮。
// 现在的口径：服务端只在**进入思考**时下一次 `{ phase: 'thinking' }`，不转发思考内容本身；
// 客户端把进度卡换成"模型正在思考…"。纯展示，不改任何生成参数。
{
  const savedFetch = sandbox.fetch;
  const savedDecoder = sandbox.TextDecoder;
  const savedReport = sandbox.reportClientLog;
  const savedCardFn = sandbox.showAITaskProgress;
  const updates = [];
  sandbox.TextDecoder = class { decode(b) { return b ? Buffer.from(b).toString('utf8') : ''; } };
  sandbox.reportClientLog = () => {};
  // 用记账替身而不是真进度卡：真卡片的 label 节点在 DOM 桩里取不到，断言会变成永久假绿/假红。
  sandbox.showAITaskProgress = () => ({
    update: (tail, label) => { updates.push(String(label || tail)); },
    note: () => {}, close: () => {}, setCancel: () => {}
  });
  const sse = (frames) => {
    const bytes = Buffer.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), 'utf8');
    let sent = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })) }) },
      json: async () => ({}), text: async () => ''
    };
  };
  const runFrames = async (frames) => {
    sandbox.fetch = async (url) => (String(url).includes('/api/ai/write_stream')
      ? sse(frames)
      : { ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
    P.state.aiTaskRunning = false;
    try { return { ok: true, value: await P.streamAIDirectWrite({ config_id: 1, messages: [{ role: 'user', content: 'x' }], max_tokens: 4096 }, '测试成文') }; }
    catch (e) { return { ok: false, error: e }; }
  };

  updates.length = 0;
  const withPhase = await runFrames([
    { phase: 'thinking' },
    { delta: '正文' },
    { done: true, text: '正文' }
  ]);
  check('116a 进入思考时进度卡改说"模型正在思考"（十几秒的思考不再看起来像卡死）',
    withPhase.ok && updates.some((u) => u.includes('思考')),
    JSON.stringify(updates));
  check('116b 思考相位不影响正文：交付的正文仍然只有模型写出的那部分',
    withPhase.ok && withPhase.value.text === '正文',
    JSON.stringify(withPhase.ok ? withPhase.value.text : String(withPhase.error)));

  updates.length = 0;
  const noPhase = await runFrames([{ delta: '正文' }, { done: true, text: '正文' }]);
  check('116c 老服务端不发思考相位时一切照旧（兼容，且不误报"正在思考"）',
    noPhase.ok && !updates.some((u) => u.includes('思考')),
    JSON.stringify(updates));

  // 跨文件契约：DOM 桩看不出服务端到底怎么处理思考帧，直接读 server.js。
  const srvSrc = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  check('116d 服务端只上报相位、不转发思考内容（推理过程不外泄，也不多传数据）',
    srvSrc.includes('delta?.reasoning_content') && srvSrc.includes("onThinking: () => send({ phase: 'thinking' })"),
    JSON.stringify({ detects: srvSrc.includes('reasoning_content'), wires: srvSrc.includes("send({ phase: 'thinking' })") }));

  sandbox.fetch = savedFetch;
  sandbox.TextDecoder = savedDecoder;
  sandbox.reportClientLog = savedReport;
  sandbox.showAITaskProgress = savedCardFn;
}

// --- 17) 慢通道轮询：发现延迟的上限从 10s 收到 3s（P0-2 主体里"便宜的那一半"） ---
// 依据（先算账再决定）：发现延迟 ≈ 下一个轮询时刻 − 任务真正完成的时刻，**上界就是轮询间隔上限**，
// 与任务时长无关。按这段退避推算，中位 65s 的任务在 10s 上限下平均晚 4.5–5s 才被发现；
// 3s 上限下平均晚约 1.5s。代价只有请求数 ×3（每次回包最多 600 字、服务端只读内存任务表）。
// 而新增 SSE 推送端点相对这条只多回收约 1.5s/轮，却要引入断线重连与双路径兼容 —— 不值得，
// 所以这里钉住的是"收紧常量"而不是"新增端点"。
{
  const realSetTimeout = sandbox.setTimeout;
  const savedApi = sandbox.api;
  const waits = [];
  // 把 setTimeout 换成"记下间隔、立即执行"：轮询节奏可以被精确观察，测试也不必真的等十几秒。
  sandbox.setTimeout = (fn, ms) => { waits.push(Number(ms) || 0); return realSetTimeout(fn, 0); };
  let calls = 0;
  sandbox.api = async () => {
    calls += 1;
    return calls < 13 ? { status: 'running', tail: '输出中…' } : { status: 'done', output: '正文成品', tail: '' };
  };
  let out = null;
  let err = null;
  try {
    out = await P.pollHarnessJob(7, { setCancel() {}, note() {}, update() {} }, { timeoutMs: 600000 });
  } catch (e) { err = e; }
  sandbox.api = savedApi;
  sandbox.setTimeout = realSetTimeout;
  const intervals = waits.filter((w) => w > 0);
  check('117a 轮询间隔上限是 3s（发现延迟从平均约 5s 降到约 1.5s，且不必新增推送端点）',
    intervals.length >= 6 && Math.max(...intervals) === 3000 && intervals[0] === 1500,
    JSON.stringify(intervals.slice(0, 8)));
  check('117b 收窄上限后轮询照常收尾（任务完成立即返回产出，不改变语义）',
    !!out && out.output === '正文成品' && !err && calls === 13,
    JSON.stringify({ out: out && out.output, calls, err: err && err.message }));
}

// --- 8) 派生式护栏：浏览器脚本不得调用"只存在于服务端"的函数 ---// 它来自一个真实缺陷：v0.9.3 的提交里 public/app.js 有三处 `plainText(editor.innerHTML)`，
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
// --- 21) C1/C3：写作方向（纯函数）与「方向化装配」的前端纪律 ---
// 为什么单独测：direction 在前端要同时满足三件事——与服务端同口径的规范化/截断、
// 只从"已保存蓝图"保守提取、以及一次写作任务**最多一次**方向化资料召回（无蓝图时先 defer）。
// 纯函数部分与服务器 ai/direction.mjs 同口径（服务端侧由 test-direction-retrieval.mjs 验证）；
// 这里钉住前端镜像不会漂移，以及请求参数真的带上方向/阶段。
{
  check('C1a 方向规范化：非字符串一律视为未提供',
    P.normalizeWritingDirectionText(null) === '' && P.normalizeWritingDirectionText(42) === '' && P.normalizeWritingDirectionText({}) === '');
  check('C1b 方向规范化：控制字符折叠为空格、连续空白压平、首尾去空',
    P.normalizeWritingDirectionText('  \u0007第一段\n\n第二段\t  ') === '第一段 第二段');
  check('C1c 方向规范化：超长按 400 Unicode 码点截断（代理对不撕裂）',
    P.WRITING_DIRECTION_MAX_CHARS === 400 && Array.from(P.normalizeWritingDirectionText('🀄'.repeat(500))).length === 400);
  check('C1d 方向规范化：同输入同输出、不同输入可区分（纯函数）',
    P.normalizeWritingDirectionText('甲 乙') === P.normalizeWritingDirectionText('甲 乙')
      && P.normalizeWritingDirectionText('甲') !== P.normalizeWritingDirectionText('乙'));
  const sentenceText = '甲'.repeat(330) + '。' + '乙'.repeat(200);
  check('C1e 截断尽量落在句子边界（句末标点处收口）',
    Array.from(P.clipWritingDirectionText(sentenceText, 400)).length === 331 && P.clipWritingDirectionText(sentenceText, 400).endsWith('。'));
  check('C1f 找不到句子边界时按额度硬截', Array.from(P.clipWritingDirectionText('丙'.repeat(500), 400)).length === 400);

  const bp = { hook: '钩子内容', plot_points: ['情节点一', '情节点二'], conflicts: '冲突内容', scene_goal: '场景目标', references: '参考内容', character_changes: '角色变化' };
  const dirFromBp = P.buildWritingDirectionFromBlueprint(bp);
  check('C1g 蓝图→方向按字段优先级拼装（references 最前、hook 最后；数组用；连接）',
    dirFromBp.startsWith('参考内容') && dirFromBp.includes('场景目标') && dirFromBp.includes('情节点一；情节点二')
      && dirFromBp.indexOf('冲突内容') < dirFromBp.indexOf('角色变化') && dirFromBp.indexOf('钩子内容') > dirFromBp.indexOf('角色变化'));
  check('C1h 蓝图→方向是纯文本（不夹带 JSON 结构/换行）', !/[{}]/.test(dirFromBp) && !dirFromBp.includes('\n'));
  check('C1i 蓝图无有效字段时回退到 fallback；两者都空则为空串',
    P.buildWritingDirectionFromBlueprint({}, '用户要求') === '用户要求'
      && P.buildWritingDirectionFromBlueprint({ unknown_field: 'x' }, '') === ''
      && P.buildWritingDirectionFromBlueprint(null, '') === '');
  const hugeDir = P.buildWritingDirectionFromBlueprint({ references: '甲'.repeat(500), scene_goal: '不应出现的目标' }, '');
  check('C1j 蓝图→方向仍受 400 码点硬上限；被截断后不再拼后续字段（不产生半句）',
    Array.from(hugeDir).length === 400 && !hugeDir.includes('不应出现的目标'));
  check('C1k 前端方向哈希稳定、可区分（仅用于 in-flight 去重）',
    /^[0-9a-f]{8}$/.test(P.directionKeyHashOf('甲')) && P.directionKeyHashOf('甲') === P.directionKeyHashOf('甲')
      && P.directionKeyHashOf('甲') !== P.directionKeyHashOf('乙'));

  const savedChaptersForBp = P.state.chapters;
  P.state.chapters = [
    { id: 901, blueprint_json: JSON.stringify({ scene_goal: '目标' }) },
    { id: 902, blueprint_json: '{坏 JSON' },
    { id: 903, blueprint_json: JSON.stringify({ other: 'x' }) },
    { id: 904, blueprint_json: JSON.stringify(['a']) },
    { id: 905, blueprint_json: '' },
  ];
  check('C1l savedBlueprintForChapter 保守判据：可解析且有已知字段才算；坏 JSON/数组/未知字段/空都不算',
    !!P.savedBlueprintForChapter(901) && P.savedBlueprintForChapter(902) === null && P.savedBlueprintForChapter(903) === null
      && P.savedBlueprintForChapter(904) === null && P.savedBlueprintForChapter(905) === null && P.savedBlueprintForChapter(0) === null);
  P.state.chapters = savedChaptersForBp;

  // C3：loadAIContext 的方向/阶段进请求；in-flight 去重按「方向+阶段」分键
  {
    const saved = { api: sandbox.api, aiContext: P.state.aiContext, chapterId: P.state.currentChapterId, workId: P.state.workId, work: P.state.work };
    P.state.currentChapterId = 601; P.state.workId = 2; P.state.work = { id: 2, title: '测试作品' };
    const seen = [];
    sandbox.api = async (p) => {
      seen.push(String(p));
      if (String(p).startsWith('/ai_context')) return { assembled: '服务端装配文本', context_manifest: [], context_stats: { truncatedLayers: 0 } };
      return {};
    };
    await P.loadAIContext({ direction: '方向甲', directionSource: 'saved_blueprint', libraryRecallPhase: 'direction' });
    const dirUrl = seen[0] || '';
    check('C3a 方向化装配：direction / phase / source 全部进请求（中文已编码；用服务端 assembled）',
      dirUrl.startsWith('/ai_context?') && decodeURIComponent(dirUrl).includes('direction=方向甲')
        && dirUrl.includes('library_recall_phase=direction') && dirUrl.includes('direction_source=saved_blueprint')
        && !!P.state.aiContext && P.state.aiContext.assembled === '服务端装配文本',
      JSON.stringify({ dirUrl, ctx: P.state.aiContext && P.state.aiContext.assembled }));
    seen.length = 0;
    await P.loadAIContext({ libraryRecallPhase: 'defer' });
    const deferUrl = seen[0] || '';
    check('C3b defer 装配：带 library_recall_phase=defer 且不带 direction',
      deferUrl.includes('library_recall_phase=defer') && !decodeURIComponent(deferUrl).includes('direction='));
    seen.length = 0;
    let release = null;
    sandbox.api = async (p) => { seen.push(String(p)); await new Promise((r) => { release = r; }); return { assembled: 'x', context_manifest: [] }; };
    const p1 = P.loadAIContext({ direction: '方向乙', libraryRecallPhase: 'direction' });
    const p2 = P.loadAIContext({ direction: '方向乙', libraryRecallPhase: 'direction' });
    await new Promise((r) => setTimeout(r, 0));
    const inflightCount = seen.length;
    if (release) release();
    await Promise.all([p1, p2]);
    check('C3c 相同方向+相同阶段的并发装配只发一次请求（in-flight 去重）', inflightCount === 1 && seen.length === 1, JSON.stringify(seen));
    seen.length = 0;
    const releases = [];
    sandbox.api = async (p) => { seen.push(String(p)); await new Promise((r) => { releases.push(r); }); return { assembled: 'y', context_manifest: [] }; };
    const g1 = P.loadAIContext({ direction: '方向丙', libraryRecallPhase: 'direction' });
    const g2 = P.loadAIContext({ direction: '方向丁', libraryRecallPhase: 'direction' });
    await new Promise((r) => setTimeout(r, 0));
    check('C3d 不同方向/阶段各发各的请求（不互相顶掉或误命中）', seen.length === 2, JSON.stringify(seen));
    releases.forEach((r) => r());
    await Promise.all([g1, g2]);
    sandbox.api = saved.api;
    P.state.aiContext = saved.aiContext; P.state.currentChapterId = saved.chapterId; P.state.workId = saved.workId; P.state.work = saved.work;
  }

  // C3e：已保存蓝图 → 入口按蓝图方向做唯一一次 direction 装配，不再走 defer（也不产生第二次召回）
  {
    const saved = {
      fetch: sandbox.fetch, api: sandbox.api, toast: sandbox.toast, report: sandbox.reportClientLog,
      showResult: sandbox.showAIWritingResult, apply: sandbox.applyAIWritingArticle, harness: sandbox.runHarnessJob,
      decoder: sandbox.TextDecoder, card: sandbox.showAITaskProgress,
      chapterId: P.state.currentChapterId, workId: P.state.workId, work: P.state.work, chapters: P.state.chapters,
      aiContext: P.state.aiContext, apiConfigs: P.state.apiConfigs, activeConfigId: P.state.activeConfigId,
      aiTaskRunning: P.state.aiTaskRunning,
    };
    P.state.aiTaskRunning = false; // 干净起点：前面用例可能留着"任务进行中"标志（否则本次写作直接拒绝启动）
    P.state.currentChapterId = 601;
    P.state.workId = 2;
    P.state.work = { id: 2, title: '测试作品' };
    P.state.apiConfigs = [{ id: 1, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 4096 }];
    P.state.activeConfigId = 1;
    P.state.chapters = [{ id: 601, title: '第601章', blueprint_json: JSON.stringify({ scene_goal: '主角在雨夜摊牌', conflicts: '旧账被翻出', plot_points: ['对峙', '证据出现'], hook: '门外有人' }) }];
    containers['#editor-content'] = mkEl('editor-content');
    containers['#editor-content'].innerHTML = '<p>已有正文</p>';
    containers['#editor-content'].dataset = { chapterId: '601' };
    const aiCalls = [];
    const baseApi = sandbox.api;
    sandbox.api = async (p, o = {}) => {
      const s = String(p);
      if (s.startsWith('/ai_context') || s.startsWith('/novel/context')) {
        aiCalls.push(s);
        return { assembled: '服务端装配文本', context_manifest: [], context_stats: { truncatedLayers: 0 } };
      }
      return baseApi(p, o);
    };
    const toasts = [];
    sandbox.toast = (m) => { toasts.push(String(m)); };
    sandbox.reportClientLog = () => {};
    sandbox.TextDecoder = class { decode(b) { return b ? Buffer.from(b).toString('utf8') : ''; } };
    sandbox.runHarnessJob = async () => ({ output: '' });
    let resultOpened = 0;
    sandbox.showAIWritingResult = async () => { resultOpened += 1; return null; };
    let applyCalls = 0;
    sandbox.applyAIWritingArticle = async () => { applyCalls += 1; };
    const sse = (frames) => {
      const bytes = Buffer.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), 'utf8');
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })) }) }, json: async () => ({}), text: async () => '' };
    };
    sandbox.fetch = async (url, opts) => (String(url).includes('/api/ai/write_stream')
      ? sse([{ delta: '雨夜的正文。' }, { done: true, text: '雨夜的正文。' }])
      : saved.fetch(url, opts));
    containers['#modal-root'].innerHTML = '';
    let writeErr = '';
    try { await P.performToolbarAIWrite('续写本章'); } catch (e) { writeErr = e.message; }
    const errModal = String(containers['#modal-root'].innerHTML).includes('AI 写作未完成');
    check('C3e 已保存蓝图：入口直接做唯一一次 direction 装配（不出现 defer、来源=saved_blueprint）',
      aiCalls.length === 1 && decodeURIComponent(aiCalls[0]).includes('library_recall_phase=direction')
        && aiCalls[0].includes('direction_source=saved_blueprint')
        && !aiCalls.some((u) => u.includes('library_recall_phase=defer')),
      JSON.stringify({ aiCalls, err: writeErr, toasts: toasts.slice(0, 2) }));
    check('C3e2 已保存蓝图路径不再自相矛盾地提示"本章蓝图未保存"（它本来就在库里）',
      !toasts.some((t) => t.includes('本章蓝图未保存')), JSON.stringify(toasts));
    check('C3f 该路径照常走到结果弹窗（跳过蓝图生成轮不代表流程中断）',
      resultOpened === 1 && applyCalls === 0 && !errModal && writeErr === '',
      JSON.stringify({ resultOpened, applyCalls, errModal, writeErr, modal: String(containers['#modal-root'].innerHTML).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 400), toasts }));
    sandbox.fetch = saved.fetch; sandbox.api = saved.api; sandbox.toast = saved.toast; sandbox.reportClientLog = saved.report;
    sandbox.showAIWritingResult = saved.showResult; sandbox.applyAIWritingArticle = saved.apply; sandbox.runHarnessJob = saved.harness;
    sandbox.TextDecoder = saved.decoder; sandbox.showAITaskProgress = saved.card;
    P.state.currentChapterId = saved.chapterId; P.state.workId = saved.workId; P.state.work = saved.work;
    P.state.chapters = saved.chapters; P.state.aiContext = saved.aiContext;
    P.state.apiConfigs = saved.apiConfigs; P.state.activeConfigId = saved.activeConfigId;
    P.state.aiTaskRunning = saved.aiTaskRunning;
  }
}
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
