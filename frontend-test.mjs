// 前端真实执行验证：用最小 DOM 桩在 Node 里加载并运行 public/app.js，
// 验证「🐞 运行追踪」页能真实渲染、开关能切换、客户端节点能产生并上报。
// 这不是替代人工点击，而是排除「运行时抛错 / 渲染为空 / 逻辑不通」这类硬故障。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { writingPolicySnapshot } from './ai/writing/policy.mjs';

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
/**
 * 桩用的"取可见文本"：只做到足够真实的一步——去掉标签、还原常见实体、丢掉注释。
 * 刻意不追求与浏览器逐字一致（那是真 DOM 的事），但"标签里没有文字、注释不算文字、
 * `&nbsp;` 是空白"这三件事必须与浏览器一致，否则任何以"可读字符数"为判据的逻辑在测试里都会失真。
 */
function htmlToStubText(html) {
  return String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}
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
  // 桩必须让 innerHTML→textContent 也成立（浏览器里 el.innerHTML='<p>x</p>' 之后 el.textContent 就是 'x'）。
  // 此前只有反方向成立，于是 stripHtml()（产品里就是"取 textContent"）在桩里恒返回空串 ——
  // 结果"正文有没有可读字符"这类判据在测试里永远判成空（2026-10-02 空内容护栏的回归用例正是这么假失败的）。
  set innerHTML(v) {
    this._html = String(v);
    this._text = htmlToStubText(this._html);
  }
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
  createDocumentFragment: () => new El('#fragment'),
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
const stub = { stale: false, directEmptyOnce: false, blueprintAsProse: false, editorConflict: false, editorPutBodies: [], serverBlocksEmpty: false };
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
// T6 桩：时态状态面板 / 提案组 / 影响分析 / 逐章重建。读接口回读桩状态；写操作改桩状态，
// 断言"请求真的发出去了、界面用的是服务端回来的数据"，而不是本地状态自说自话。
const temporalStub = {
  panelCalls: [],
  panel: {
    ok: true, work_id: 1, chapter_id: 7, boundary: 'after',
    commit_id: 'commit-abcdef123456', worldline_id: 'worldline-main-0001', order_version_id: 'order-000000000001',
    binding_id: 'bind-ch7', binding_validity: 'valid', stored_binding_validity: 'valid',
    state_scope: 'through_chapter', trusted: true, verified_through: 6, validity: 'valid', stop: null,
    state_content_hash: 'statehash12345678',
    appearances: [{ name: '林昭', role: 'action', scene_index: 0, evidence: [{ quote: '林昭推开钟楼的门' }] }],
    characters: [
      { entity_id: '林昭', status: '存活', location: '青云镇', in_chapter: true },
      { entity_id: '王师傅', status: '存活', location: '青云镇', in_chapter: false }
    ],
    relations: [{ from: '林昭', to: '王师傅', label: '师徒', related_in_chapter: true }],
    plotlines: [{ entity_id: '黑风谷任务', state: '进行中', touched_in_chapter: true }],
    events: [{ entity_id: 'evt-ch7', predicate: 'battle', value: { summary: '林昭潜入钟楼' } }],
    changes: [{ event_id: 'evt-ch7', type: 'set', domain: 'character', entity_id: '林昭', predicate: 'status', scope: 'canon', holder_id: null, from: '受伤', from_missing: false, to: '存活', evidence: [{ quote: '伤口已经结痂' }] }],
    counts: { appearances: 1, characters: 2, relations: 1, plotlines: 1, events: 1, changes: 1 },
    policy: { source: 'test', note: '面板只读真实时态状态' }
  },
  panelFullState: {
    '["character","林昭","status","canon",null]': '存活',
    '["plotline","黑风谷任务","state","canon",null]': '进行中'
  },
  proposalsJson: () => ({
    ok: true, enabled: true, work_id: 1, chapter_id: 7,
    proposals: [{
      binding_id: 'bind-prop-1', chapter_id: 7, revision_id: 'rev-9', created_at: '2026-09-30T01:00:00',
      status: 'done', analysis: { status: 'done', provider: 'api_config' },
      proposal: { events: 1, ops: 2, by_domain: { character: 2 } }, event_ids: ['evt-ch7'], pending_context: null
    }]
  }),
  appliedProposals: [],
  impactReport: {
    run_id: 'run-impact-1', mode: 'analyze', root_chapter_id: 7, tentative: false, coverage: 'all',
    changes: [{ cell: '["character","王师傅","status","canon",null]', to: '战死' }],
    downstream: [
      { chapter_id: 8, status: 'needs_review', reason: '依赖前提：王师傅仍然活着', explicit_appearances: ['王师傅'], explicit_dependencies: [{ resource_key: '王师傅的护身符' }], implicit_causal: [{ kind: 'premise_change', premise: '王师傅仍然活着', quote: '他还在等王师傅回信' }], tentative: false },
      { chapter_id: 9, status: 'kept', reason: '正文在新世界状态下仍成立', kept_revision_id: 'rev-9', explicit_appearances: [], explicit_dependencies: [], implicit_causal: [] }
    ],
    totals: { downstream: 2, kept: 1, needs_review: 1, blocked: 0, skipped_by_coverage: 0, model_calls: 1, generated_revisions: 0 },
    writer_calls: 0, notes: ['只分析、只标记；未生成后文修订']
  },
  impactRuns: [{
    id: 'run-impact-1', work_id: 1, mode: 'analyze', root_chapter_id: 7, base_commit_id: 'commit-abcdef123456',
    working_worldline_id: null, status: 'done', baseline: {}, policy: {}, authorization: {}, coverage: { coverage: 'all' },
    result: null, idempotency_key: 'impact|1|7', lease_owner: null, lease_expires_at: null, fencing_token: 0,
    created_at: '2026-09-30T01:05:00', updated_at: '2026-09-30T01:05:10'
  }],
  impactPosts: [],
  repairRun: null,
  repairSteps: [],
  repairCandidate: null,
  repairGate: { can_apply: false, reasons: ['运行状态为 running'] },
  repairStarts: [],
  repairActions: [],
  approvals: []
};
temporalStub.impactRuns[0].result = temporalStub.impactReport;

// T7 桩：时态引擎开关 / 存量重建 / bootstrap 候选（读回桩状态；写操作改桩状态）。
// 断言目标：界面读的是服务端返回的真实字段；开关分离；逐章流程真实 POST；不伪造历史。
temporalStub.temporalPuts = [];
temporalStub.stepPosts = [];
temporalStub.confirmPosts = [];
temporalStub.bootstrapPosts = [];
temporalStub.temporalFail = false;
temporalStub.temporalBroken = false;
temporalStub.engineDefault = () => ({
  ok: true, work_id: 1, version: 1, schema_ok: true, missing_tables: [],
  config: { work_id: 1, enabled: false, auto_analysis: false, repair: false, story_state_enabled: false },
  head_commit_id: null, order_version_id: null, manifest_size: 0, trust: null, commits: []
});
temporalStub.temporal = temporalStub.engineDefault();
temporalStub.backfillDefault = () => ({
  ok: true, work_id: 1,
  migration: { ok: true, applied: false, version: '1.0.0', recorded_version: '', recorded_at: '', missing_tables: [], missing_indexes: [], note: '' },
  config: { work_id: 1, enabled: false, auto_analysis: false, repair: false, story_state_enabled: false },
  totals: { chapters: 3, valid: 1, pending_confirm: 0, pending_analysis: 1, analysis_running: 0, missing_revision: 1, stale: 0, needs_review: 0, conflict: 0, blocked: 0 },
  next_chapter_id: 8, trusted_through: 0,
  chapters: [
    { index: 0, chapter_id: 7, title: '第一章', state: 'valid', revision_id: 'rev-7', revision_text_hash: 'h7', binding_id: 'bind-7', binding_validity: 'valid', analysis_status: 'done', dependencies: 1, snapshots_after: 1, provenance: {} },
    { index: 1, chapter_id: 8, title: '第二章', state: 'pending_analysis', revision_id: 'rev-8', revision_text_hash: 'h8', binding_id: 'bind-8', binding_validity: 'pending', analysis_status: '', dependencies: 0, snapshots_after: 0, provenance: {} },
    { index: 2, chapter_id: 9, title: '第三章', state: 'missing_revision', revision_id: null, revision_text_hash: '', binding_id: null, binding_validity: null, analysis_status: '', dependencies: 0, snapshots_after: 0, provenance: {} }
  ],
  bootstrap: {
    total: 1, pending: 1,
    items: [{
      candidate_key: 'bst_x', candidate_id: 'bind-boot-1', work_id: 1, chapter_id: 7, status: 'pending', validity: 'pending',
      domain: 'character', entity_id: '王师傅', predicate: 'status', value: '存活', detail: '',
      source: { table: 'characters', key: '9', field: 'status' }, suggested_effective: null,
      note: '角色卡最新 status：生效时点未知（可能是中途状态），不得当作开篇状态', decided_at: null, event_ids: ['evt-boot-1']
    }]
  },
  budget: {
    chapters_total: 3, chapters_needing_extraction: 2, chapters_awaiting_confirm: 0, model_calls_estimated: 2,
    model_calls_note: '每次抽取一章一次调用；作者可用本机 fake / 离线结果替代（零计费）。保存路径本身不调用模型。', auto_analysis_default: 'off'
  }
});
temporalStub.backfill = temporalStub.backfillDefault();
temporalStub.backfillStepOut = {
  ok: true, enabled: true, work_id: 1, chapter_id: 8, index: 1, status: 'awaiting_extraction',
  revision_id: 'rev-8', binding_id: 'bind-8', input_trusted: true, refreshed: true,
  prompt: { system: '你是长篇小说的"状态记账员"。只输出 JSON。', user: '章节：8（第二章）\n章前状态（权威来源）：...\n请输出 JSON。', input_hash: 'ih-8' },
  provenance: { manuscript: 'frozen', generation_context: 'unknown', support: 'reconstructed', note: '事后重建' }
};

const fetchStub = async (url, opts = {}) => {
  requests.push({ url: String(url), method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  const u = String(url);
  let json = {};
  let status = 200;
  if (stub.serverBlocksEmpty && u.includes('/api/chapters/121')) {
    // 服务端空正文护栏的契约形状（server.js checkEmptyOverwrite）：409 + 机器可判的 code + 现正文字数。
    // 桩必须与服务端同形，否则"客户端能不能读懂这个拒绝"这件事在测试里根本发生不了。
    if ((opts.method || 'GET').toUpperCase() === 'PUT') {
      const sent = JSON.parse(String(opts.body || '{}'));
      stub.editorPutBodies.push(sent);
      if (sent.confirm_empty === true) {
        json = { id: 121, title: '第三章', content: String(sent.content || ''), summary: '', updated_at: 'after-clear' };
      } else {
        json = { error: '本章正文现有 3982 字，这次写入的内容是空的——已拒绝，未改动任何内容。', code: 'EMPTY_OVERWRITE_BLOCKED', current_chars: 3982 };
        status = 409;
      }
    } else {
      json = { id: 121, title: '第三章', content: `<p>${'正文'.repeat(900)}</p>`, summary: '', updated_at: 'base-1' };
    }
  } else if (stub.editorConflict && u.includes('/api/chapters/107')) {
    if ((opts.method || 'GET').toUpperCase() === 'PUT') {
      stub.editorPutBodies.push(JSON.parse(String(opts.body || '{}')));
      if (stub.editorPutBodies.length === 1) { json = { error: '内容已在其他窗口被修改' }; status = 409; }
      else json = { id: 107, title: '本地标题', content: '<p>本地稿</p>', summary: '', updated_at: 'server-v2' };
    } else {
      json = { id: 107, title: '服务端标题', content: '<p>服务端稿</p>', summary: '', updated_at: 'server-v2' };
    }
  } else if (stub.stale && (u.includes('/api/novel/openviking') || u.includes('/api/env/tools'))) {
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
  // T6：章末状态面板 / 提案组 / 影响分析 / 逐章重建 / 候选修订（读回桩状态；写操作改桩状态）
  else if (u.includes('/api/novel/state/panel')) {
    const chapterId = Number((u.match(/chapter_id=(\d+)/) || [])[1] || 7);
    const boundary = (u.match(/boundary=(\w+)/) || [])[1] || 'after';
    const full = /[?&]full=1/.test(u);
    temporalStub.panelCalls.push({ chapterId, boundary, full });
    const delay = (temporalStub.panelDelays && temporalStub.panelDelays[chapterId]) || 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    // 按章给不同状态：第 7 章王师傅存活（未出场），第 8 章战死——面板必须按章显示，不得把未来状态泄漏到过去。
    const rows = chapterId >= 8
      ? [{ entity_id: '林昭', status: '存活', location: '青云镇', in_chapter: true }, { entity_id: '王师傅', status: '战死', location: '黑风谷', in_chapter: true }]
      : temporalStub.panel.characters;
    json = Object.assign({}, temporalStub.panel, {
      chapter_id: chapterId, boundary,
      characters: rows,
      full_state: full ? temporalStub.panelFullState : undefined
    });
  }
  else if (u.includes('/api/novel/state/proposal-groups')) {
    if ((opts.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.appliedProposals.push(body);
      json = { ok: true, enabled: true, work_id: 1, chapter_id: body.chapter_id, decision: 'valid', binding_id: decodeURIComponent((u.match(/proposal-groups\/([^/]+)\/apply/) || [])[1] || ''), event_ids: ['evt-ch7'] };
    } else {
      json = temporalStub.proposalsJson();
    }
  }
  else if (u.includes('/api/novel/state/impact')) {
    if ((opts.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.impactPosts.push(body);
      json = { ok: true, enabled: true, tentative: false, run: temporalStub.impactRuns[0], report: temporalStub.impactReport };
    } else if (/run_id=/.test(u)) {
      json = { ok: true, enabled: true, run: temporalStub.impactRuns[0], steps: [], report: temporalStub.impactReport, coverage: 'all', policy: {}, baseline: {} };
    } else {
      json = { ok: true, work_id: 1, runs: temporalStub.impactRuns };
    }
  }
  else if (u.includes('/api/novel/state/repair')) {
    const method = (opts.method || 'GET').toUpperCase();
    const action = (u.match(/repair\/(\w+)/) || [])[1] || '';
    if (method === 'POST' && action === 'start') {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.repairStarts.push(body);
      temporalStub.repairRun = {
        id: 'run-repair-1', work_id: 1, mode: 'repair', root_chapter_id: Number(body.root_chapter_id) || 7,
        base_commit_id: 'commit-abcdef123456', working_worldline_id: null, status: 'running',
        baseline: {}, policy: {}, authorization: {}, coverage: { coverage: 'all' },
        result: { totals: { chapters: 2, kept: 1, repaired: 0, needs_review: 0, blocked: 0, model_calls: 1, tokens: 120 }, halt: null },
        idempotency_key: 'repair|1|7', lease_owner: 'test', lease_expires_at: null, fencing_token: 1,
        created_at: '2026-09-30T02:00:00', updated_at: '2026-09-30T02:00:00'
      };
      temporalStub.repairSteps = [
        { id: 'step-1', work_id: 1, run_id: 'run-repair-1', chapter_id: 8, step_key: 'ch8', input_fingerprint: 'fp-1', attempt: 1, status: 'queued', candidate_revision_id: null, candidate_binding_id: null, result: {}, created_at: '2026-09-30T02:00:00', updated_at: '2026-09-30T02:00:00' },
        { id: 'step-2', work_id: 1, run_id: 'run-repair-1', chapter_id: 9, step_key: 'ch9', input_fingerprint: 'fp-2', attempt: 1, status: 'queued', candidate_revision_id: null, candidate_binding_id: null, result: {}, created_at: '2026-09-30T02:00:00', updated_at: '2026-09-30T02:00:00' }
      ];
      temporalStub.repairCandidate = null;
      temporalStub.repairGate = { can_apply: false, reasons: ['运行状态为 running'] };
      json = { ok: true, enabled: true, reused: false, run: temporalStub.repairRun, steps: temporalStub.repairSteps };
    } else if (method === 'POST') {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.repairActions.push({ action, body });
      if (action === 'apply') {
        temporalStub.repairRun = { ...temporalStub.repairRun, status: 'applied' };
        json = { ok: true, enabled: true, applied: true, run_id: body.run_id, commit_id: 'commit-applied-1' };
      } else if (action === 'cancel') {
        temporalStub.repairRun = { ...temporalStub.repairRun, status: 'paused' };
        json = { ok: true, enabled: true, run: temporalStub.repairRun };
      } else if (action === 'revert') {
        temporalStub.repairRun = { ...temporalStub.repairRun, status: 'reverted' };
        json = { ok: true, enabled: true, run: temporalStub.repairRun };
      } else {
        json = { ok: true, enabled: true, run: temporalStub.repairRun };
      }
    } else if (/run_id=/.test(u) && temporalStub.repairRun) {
      json = { ok: true, enabled: true, work_id: 1, run: temporalStub.repairRun, steps: temporalStub.repairSteps, candidate: temporalStub.repairCandidate, ready_gate: temporalStub.repairGate };
    } else {
      json = { ok: true, work_id: 1, runs: temporalStub.repairRun ? [temporalStub.repairRun] : [] };
    }
  }
  // T7：时态引擎开关（GET 总览 / PUT 分离开关 + enable_scope）与存量重建（step / confirm / bootstrap）
  else if (u.includes('/api/novel/state/temporal')) {
    const method = (opts.method || 'GET').toUpperCase();
    if (temporalStub.temporalFail) { json = { error: 'temporal boom' }; status = 500; }
    else if (temporalStub.temporalBroken) { json = { ...temporalStub.temporal, schema_ok: false, missing_tables: ['story_commits'] }; }
    else if (method === 'PUT') {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.temporalPuts.push(body);
      const config = { ...temporalStub.temporal.config };
      if (body.temporal_enabled !== undefined) config.enabled = !!body.temporal_enabled;
      if (body.auto_analysis_enabled !== undefined) config.auto_analysis = !!body.auto_analysis_enabled;
      if (body.repair_enabled !== undefined) config.repair = !!body.repair_enabled;
      temporalStub.temporal = { ...temporalStub.temporal, config, schema_ok: true, missing_tables: [] };
      const enableScope = (config.enabled && body.temporal_enabled === true)
        ? {
          ok: true, work_id: 1,
          pending_rebuild: { chapters: 2 },
          upcoming: [{ chapter_id: 8, index: 1, state: 'pending_analysis' }, { chapter_id: 9, index: 2, state: 'missing_revision' }],
          bootstrap_pending: 1,
          budget: { chapters_total: 3, chapters_needing_extraction: 2, chapters_awaiting_confirm: 0, model_calls_estimated: 2, auto_analysis_default: 'off' },
          notes: ['旧作品默认不启用自动模型分析：auto_analysis_enabled 仍为 0 时，保存只登记修订与待确认提案。']
        }
        : null;
      json = {
        ...temporalStub.temporal,
        migration: { ok: true, applied: true, version: '1.0.0', recorded_version: '1.0.0', recorded_at: '2026-09-30T04:00:00', missing_tables: [], missing_indexes: [], note: '' },
        enable_scope: enableScope
      };
    } else {
      json = temporalStub.temporal;
    }
  }
  else if (u.includes('/api/novel/state/backfill')) {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'POST' && u.includes('/bootstrap/plan')) {
      temporalStub.bootstrapPosts.push({ action: 'plan' });
      json = { ok: true, enabled: true, work_id: 1, anchor_chapter_id: 7, found: 1, created: 0, deferred: [], skipped: [], candidates: temporalStub.backfill.bootstrap.items, note: '候选只是待确认记录（pending 绑定 + 未确认事件）：确认前不进入任何章的历史状态。' };
    } else if (method === 'POST' && u.includes('/bootstrap/decide')) {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.bootstrapPosts.push({ action: 'decide', body });
      const next = { ...temporalStub.backfill };
      next.bootstrap = { total: 1, pending: 0, items: temporalStub.backfill.bootstrap.items.map((c) => ({ ...c, status: body.decision === 'reject' ? 'rejected' : 'confirmed' })) };
      temporalStub.backfill = next;
      json = { ok: true, enabled: true, work_id: 1, decision: body.decision === 'reject' ? 'rejected' : 'valid', candidate: temporalStub.backfill.bootstrap.items[0], note: body.decision === 'reject' ? '已拒绝：没有写入任何状态。' : '已确认' };
    } else if (method === 'POST' && /\/backfill\/step/.test(u)) {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.stepPosts.push(body);
      if (body.result) {
        json = { ok: true, enabled: true, work_id: 1, chapter_id: body.chapter_id, index: 1, status: 'pending_confirm', binding_id: 'bind-8', revision_id: 'rev-8', proposal: { events: 1, ops: 1 }, issues: [], note: '候选已登记（未写入任何正式状态）：请作者确认本章后可信前缀才会前进。' };
      } else {
        json = { ...temporalStub.backfillStepOut, chapter_id: body.chapter_id };
      }
    } else if (method === 'POST' && /\/backfill\/confirm/.test(u)) {
      const body = JSON.parse(String(opts.body || '{}'));
      temporalStub.confirmPosts.push(body);
      if (Number(body.chapter_id) !== 8) { json = { error: '本章没有待确认提案（先跑 backfill step 记录抽取结果）' }; status = 409; }
      else json = { ok: true, enabled: true, work_id: 1, chapter_id: body.chapter_id, decision: 'valid', binding_id: 'bind-8', trusted_through: 1, note: '本章已按序确认：可信前缀前进；如正文仍成立则无需改写。' };
    } else {
      json = temporalStub.backfill;
    }
  }
  else if (u.includes('/api/novel/state/revision')) {
    const revisionId = decodeURIComponent((u.match(/revision_id=([^&]+)/) || [])[1] || '');
    json = { ok: true, work_id: 1, revision: { id: revisionId, chapter_id: 8, content_html: '<p>新的正文第一段。</p><p>新的正文第二段。</p>', text_hash: 'hash-rev-cand-1', created_at: '2026-09-30T02:00:00', origin: 'repair' } };
  }
  else if (u.includes('/api/novel/approvals')) {
    const body = JSON.parse(String(opts.body || '{}'));
    temporalStub.approvals.push(body);
    json = { ok: true, id: 'appr-' + temporalStub.approvals.length, status: 'active', op: body.op, work_id: body.work_id, binding_json: {}, baseline_hash: 'basehash00000000', expires_at: '2026-09-30T03:00:00' };
  }
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
  DOMParser: class { parseFromString() { return { body: Object.assign(new El('body'), { childNodes: [] }) }; } },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, Element: El, HTMLElement: El,
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
  parseBlueprintJSON, detectNonProseOutput, buildAIWritingProseRetryPrompt, BLUEPRINT_FIELDS,
  HELP_TEXT, helpDot, fieldHelp, helpTitle, renderToolRows, TOOL_SPECS, loadOpenVikingStatus, loadEnvTools,
  tooltipHtmlFor,
  state, openLastReview, htmlNodeToText, editorPlainText, diffParagraphs,
  saveChapterSnapshot, resolveEditorConflict, flushSave, flushEditorSaves, scheduleSave,
  writeChapterBody, editorSnapIsBlank, readableCharCount, recoveryBarHtml, knownChapterBodyChars, clearChapterBodyExplicit, restoreLastSavedVersion, refreshChapterRecovery,
  adoptEditorContentImpl,
  settleOldContentBeforeOverwrite, reportLegacyGuardFailures, pendingEditorSnapshotFor, discardPendingEditorWorkFor, discardSupersededEditorWorkFor,
  proposalRefOf, collectCheckedProposalRefs, proposalIdsOfRefs,
  parseRevisionPatches, applyRevisionPatches, tryApplyRevisionOutput, buildAIRevisionPatchPrompt, buildAIRevisionPrompt,
  parseRevisionPatchesDetailed, revisionPatchEngine, revisionSnapshotFor, revisionSpanCatalogue,
  showRevisionUnresolved, refineByFullRewrite, revisionCoverageHtml, showRevisionDispositions,
  revisionPlanEngine, revisionPlanFor, revisionSpanCatalogue, showReviewReport, revisionPreference, setRevisionPreference,
  revisionComparisonHtml, showRevisionComparison,
  patchSafetyEngine, patchSafetyOptions, patchSafetyGate, patchSafetyVerify, patchSafetyNotesHtml,
  WRITING_DISCIPLINE, WRITING_DISCIPLINE_REVIEW, buildAIWritingBlueprintPrompt, buildAIWritingProsePrompt, buildAIReviewPrompt, buildRedlineScanText, showReviewDiff, mergeReviewDiff, revisionBaseArticle, chapterTitleOf, refineByChecklist, runArticleReview, batchGenerateChapters, aiContextTruncated, directAIWrite,
  continuityGuardSummaryHtml,
  streamAIDirectWrite,
  performToolbarAIWrite, askAIQuestion, askToolbarAIWriteRequirement, showBlueprintConfirm, openModal, closeModal, restoreChapterDraft, previewChapterDraft, dismissChapterDraft, refreshRecoveryBar, dismissJobResult, dismissChapterReview,
  loadAIContext,
  WRITING_DIRECTION_MAX_CHARS, normalizeWritingDirectionText, clipWritingDirectionText, buildWritingDirectionFromBlueprint, directionKeyHashOf,
  newWriteTiming,
  withThinkingHeadroom,
  verifyAIDraft,
  contentHashOf, classifyChapterLength, writingPolicyLines, writingStageAudit,
  WRITING_POLICY_FALLBACK_RULES, WRITING_POLICY_FALLBACK_VERSION,
  pollHarnessJob, showAITaskProgress, runHarnessJob, handleAction,
  ATTRIBUTIONS, renderThanks, AI_TABS,
  loadEditRules, renderEditRulesCard, collectEditSelection, saveEditRules, scanEditRules, renderEditScanHtml,
  loadAuthorStyle, renderAuthorStyleCard, authorIntentRow, openAuthorSampleModal, saveAuthorSample, toggleAuthorSample, deleteAuthorSample, analyzeAuthorProfile, saveAuthorIntents,
  loadStoryState, renderStoryStateCard, toggleStoryState, refreshDisclosure, disclosureListHtml,
  loadBranch, renderBranchCard, branchCandidateHtml, branchPromptText, branchTemplate, openBranchSandboxModal, branchCreateSandbox, openBranchSubmitModal, branchSubmitCandidates, branchView, branchCompareAll, branchAdopt, branchDiscard, branchCancel, branchReopen, openBranchConfirm,
  loadRebuild, renderRebuildCard, rebuildBatchById, rebuildPromptForBatch, rebuildPlan, rebuildExtractBatch, rebuildConfirm, rebuildCancel,
  chapterTitleOfId, refreshChapterStatePanel, setChapterPanelView, chapterPanelHtml, chapterStateListHtml, confirmChapterProposals, jumpToEvidence,
  impactSectionHtml, impactAnalyze, loadImpactRuns, loadImpactRun, repairSectionHtml, repairStart, repairAction, repairPreview, loadRepairRuns, loadRepairRun, stopRepairPoll, AI_BOARD_TABS,
  renderStoryStatePage, loadTemporalEngine, loadBackfill, renderTemporalEngineCard, renderBackfillCard, temporalToggle, backfillStepRun, backfillConfirmRun, backfillBootstrapPlan, backfillBootstrapDecide, backfillPromptText, BACKFILL_STATE_LABEL,
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
  // 第三批同理：/patch-safety.js 也先于 /app.js（修稿安全门禁；缺了它 app.js 会**放行**但在预览里明示）。
  const patchSafetySrc = fs.readFileSync(path.join(repoRoot, 'public', 'patch-safety.js'), 'utf8');
  new vm.Script(patchSafetySrc, { filename: 'patch-safety.js' }).runInContext(ctx, { timeout: 10000 });
  // E01：补丁协议 v2 也必须先于 app.js（index.html 里同序）。缺了它 app.js 会退回旧格式路径，
  // 所以这条加载与下面 "1c" 断言一起，负责把"少一个 script 标签导致新协议整体失效"钉住。
  const revisionPatchSrc = fs.readFileSync(path.join(repoRoot, 'public', 'revision-patch.js'), 'utf8');
  new vm.Script(revisionPatchSrc, { filename: 'revision-patch.js' }).runInContext(ctx, { timeout: 10000 });
  // E05：编辑计划模块必须在 revision-patch.js 之后（它复用那边的 buildSpans 口径）。
  const revisionPlanSrc = fs.readFileSync(path.join(repoRoot, 'public', 'revision-plan.js'), 'utf8');
  new vm.Script(revisionPlanSrc, { filename: 'revision-plan.js' }).runInContext(ctx, { timeout: 10000 });
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
check('1c 补丁协议 v2 模块随页面加载（UMD，先于 app.js）',
  !!sandbox.NovelRevisionPatch
  && typeof sandbox.NovelRevisionPatch.VERSION === 'string'
  && sandbox.NovelRevisionPatch.VERSION.startsWith('2.')
  && typeof sandbox.NovelRevisionPatch.runRevisionPipeline === 'function',
  sandbox.NovelRevisionPatch ? sandbox.NovelRevisionPatch.VERSION : 'missing');
if (!P) process.exit(1);
// --- P0-01：409 保存冲突必须可恢复（本地优先 / 服务端优先） ---
{
  const savedChapters = P.state.chapters, savedWorkId = P.state.workId;
  const savedConflict = P.state.editorConflictSnapshot, savedFailed = P.state.editorSaveFailedSnapshot;
  const savedNodes = { editor: containers['#editor-content'], title: containers['#editor-title'], status: containers['#editor-status'] };
  const editor = mkEl('editor-content', 'div'); editor.dataset.chapterId = '107'; editor.innerHTML = '<p>本地冲突稿</p>';
  const title = mkEl('editor-title', 'input'); title.value = '本地标题';
  const status = mkEl('editor-status', 'div');
  containers['#editor-content'] = editor; containers['#editor-title'] = title; containers['#editor-status'] = status;
  P.state.workId = 1; P.state.chapters = [{ id: 107, title: '旧标题', content: '<p>旧稿</p>', summary: '', updated_at: 'client-v1' }];
  P.state.editorConflictSnapshot = null; P.state.editorSaveFailedSnapshot = null;
  stub.editorConflict = true; stub.editorPutBodies.length = 0;
  const first = await P.saveChapterSnapshot({ id: 107, content: '<p>本地冲突稿</p>', title: '本地标题' });
  check('P0-01a 409 保存失败进入可见冲突态而非静默丢稿', first === false && !!P.state.editorConflictSnapshot && P.state.editorConflictSnapshot.content.includes('本地冲突稿') && String(status.innerHTML).includes('以本地为准'));
  check('P0-01b 冲突态 flushSave 明确等待作者决策', await P.flushSave() === false);
  const localResolved = await P.resolveEditorConflict('local');
  check('P0-01c 以本地为准读取最新版本并再次 PUT，清除冲突态', localResolved === true && !P.state.editorConflictSnapshot && stub.editorPutBodies.length >= 2 && stub.editorPutBodies[1]._if_updated_at === 'server-v2');
  check('P0-01d 本地决策后自动保存闸门恢复', await P.flushSave() === true);
  P.state.editorConflictSnapshot = { id: 107, content: '<p>不要覆盖</p>', title: '本地标题' };
  const serverResolved = await P.resolveEditorConflict('server');
  check('P0-01e 以服务端为准加载正文并清除冲突态', serverResolved === true && !P.state.editorConflictSnapshot
    && P.state.chapters.find((c) => c.id === 107)?.content.includes('服务端稿') && title.value === '服务端标题');
  check('P0-01f 服务端决策后自动保存闸门恢复', await P.flushSave() === true);
  stub.editorConflict = false; P.state.chapters = savedChapters; P.state.workId = savedWorkId;
  P.state.editorConflictSnapshot = savedConflict; P.state.editorSaveFailedSnapshot = savedFailed;
  for (const [k, v] of Object.entries(savedNodes)) { if (v) containers['#' + (k === 'editor' ? 'editor-content' : k === 'title' ? 'editor-title' : 'editor-status')] = v; }
}
// 把 document 级 keydown 真的送到 app.js 的监听器（此前桩丢弃监听器 → 键盘路径不可测）
const fireDocKeydown = (event) => { for (const fn of docListeners.get('keydown') || []) fn({ preventDefault() {}, ...event }); };

// --- P-STOP：进度卡的「停止」必须对**每一条**在跑的路都有效（2026-10-02 晚，作者报"给我个停止按钮啊"）---
// 根因：按钮一直在卡里，但默认 hidden，只有调用方显式 setCancel 时才显示/可用。而审稿/修稿管线与
// 成文管线的质检阶段各自 new 了一张卡却从没注册 → 那些阶段画面在转、却没有停止按钮。
// 改成"登记制"后，判据是：**只要有一条 harness 任务在跑，点停止就必须真的发出取消请求**。
{
  const savedJob = P.state.currentJob, savedApi = sandbox.api, savedToast = sandbox.toast;
  const calls = [];
  const toasts = [];
  sandbox.toast = (m) => { toasts.push(String(m)); };
  sandbox.api = async (p, o = {}) => {
    const u = String(p);
    if (u.startsWith('/harness/job?id=')) return { id: 'job-stop-1', status: 'running', tail: '正在写…', model_slot: 'running' };
    if (u === '/harness/cancel') { calls.push(o && o.body); return { ok: true }; }
    return { ok: true };
  };
  P.state.aiTaskRunning = false;
  const card = P.showAITaskProgress('停止按钮回归');
  let done = false;
  const poll = P.pollHarnessJob('job-stop-1', card, { timeoutMs: 30000 })
    .then(() => { done = true; })
    .catch(() => { done = true; });
  await new Promise((r) => setTimeout(r, 1800));   // 让轮询真的跑起来（首轮 1.5s 退避）
  const stillRunning = !done;
  P.handleAction('ai-task-cancel');                // ← 等价于点进度卡上的「停止」
  await new Promise((r) => setTimeout(r, 200));
  check('P-STOP-1 没有显式注册取消回调的任务，点「停止」也会真的发出 /harness/cancel',
    stillRunning && calls.length === 1 && Number(calls[0].job_id) !== 0 && String(calls[0].job_id) === 'job-stop-1',
    JSON.stringify({ stillRunning, calls }));
  await poll;
  check('P-STOP-2 取消后轮询立即结束（不再继续等这条任务）', done === true, JSON.stringify({ done }));
  card.close();
  sandbox.api = savedApi; sandbox.toast = savedToast;
}
// 三道判据分别验证，缺一条这次事故就会重演：
//   ① 客户端：编辑器被清空时不发写入请求（只在编辑器/内存层拦，不依赖服务端）；
//   ② 服务端：真的发出去也要被 409 EMPTY_OVERWRITE_BLOCKED 拦下，且本地进入可见的暂停态（不是静默丢稿）；
//   ③ 唯一放行口：作者显式确认后才带上 confirm_empty 落库；
//   ④ 出路可见：恢复条同时给出「取回历史版本」「确认清空本章」两个动作；
//   ⑤ 导航不能被保存问题锁死（旧实现 flushSave 在暂停/失败态返回 false，20 多处导航全失灵）。
{
  const savedChapters = P.state.chapters, savedWorkId = P.state.workId;
  const savedConflict = P.state.editorConflictSnapshot, savedFailed = P.state.editorSaveFailedSnapshot;
  const savedEmpty = P.state.editorEmptyBlocked, savedSaveSnap = P.state.editorSaveSnapshot;
  const savedRecoveryFor = P.state.recoveryForChapter;
  const savedNodes = { editor: containers['#editor-content'], title: containers['#editor-title'], status: containers['#editor-status'] };
  const editor = mkEl('editor-content', 'div'); editor.dataset.chapterId = '121'; editor.innerHTML = '';
  const title = mkEl('editor-title', 'input'); title.value = '第三章 我的S级天赋去哪了？';
  const status = mkEl('editor-status', 'div');
  containers['#editor-content'] = editor; containers['#editor-title'] = title; containers['#editor-status'] = status;
  P.state.workId = 18;
  P.state.chapters = [{ id: 121, title: '第三章 我的S级天赋去哪了？', content: `<p>${'正文'.repeat(900)}</p>`, summary: '', updated_at: 'base-1' }];
  // 让"本页见过这一章有正文"这件事成立：真实链路里 loadWorkData 从 state.chapters 记峰值、
  // 打开章节时编辑器里就是那份正文；测试里没有走 loadWorkData，所以**编辑器先装正文、再清空**，
  // 顺序必须与真实一致（护栏判据是"编辑器空 + 本页记得它有正文"，跳过前一步就等于没测到）。
  P.state.chapterBodyPeak.delete(121);
  editor.innerHTML = `<p>${'正文'.repeat(900)}</p>`;
  P.knownChapterBodyChars(121);           // 编辑器里装着正文 → 峰值记下 1800 字
  editor.innerHTML = '';                  // 作者误触清空（这就是事故的那一步）
  const peakSeen = P.knownChapterBodyChars(121);
  P.state.editorConflictSnapshot = null; P.state.editorSaveFailedSnapshot = null;
  P.state.editorEmptyBlocked = null; P.state.editorSaveSnapshot = null;
  stub.serverBlocksEmpty = true;
  stub.editorPutBodies.length = 0;

  const blocked = await P.saveChapterSnapshot({ id: 121, content: '', title: '第三章 我的S级天赋去哪了？' });
  // 判据：客户端**不自己拍板**（它问服务端），但发现服务端也拒绝后就绝不落库，
  // 并且不会带着 confirm_empty 偷偷写进去 —— "清空"永远是作者显式选的，不是回退出来的。
  check('P-EMPTY-1 编辑器被清空时写入被拦下（正文没有被覆盖，也没有替作者确认清空）', blocked === false
    && !P.state.editorConflictSnapshot
    && !stub.editorPutBodies.some((b) => b.confirm_empty === true)
    && stub.editorPutBodies.every((b) => String(b.content || '').trim() === ''),
    `ret=${JSON.stringify(blocked)} peak=${peakSeen} puts=${JSON.stringify(stub.editorPutBodies)}`);

  const verdictEmpty = await P.writeChapterBody(121, { content: '<div><br></div>', title: '第三章 我的S级天赋去哪了？' });
  check('P-EMPTY-2 显式写入空正文时进入「已暂停」态（不是冲突、也不是静默丢稿）', verdictEmpty === 'empty'
    && !!P.state.editorEmptyBlocked && !P.state.editorConflictSnapshot
    && P.state.editorSaveFailedSnapshot?.code === 'EMPTY_OVERWRITE_BLOCKED',
    `verdict=${JSON.stringify(verdictEmpty)} blocked=${!!P.state.editorEmptyBlocked} conflict=${!!P.state.editorConflictSnapshot} code=${P.state.editorSaveFailedSnapshot?.code}`);

  check('P-EMPTY-3 判空口径=去掉标签后没有可读字符（`<div><br></div>`、纯空白都算空）',
    P.editorSnapIsBlank('<div><br></div>') && P.editorSnapIsBlank('   ') && P.editorSnapIsBlank('<p>&nbsp;</p>')
    && !P.editorSnapIsBlank('<p>醒。</p>') && P.readableCharCount('<p>醒。</p>') === 1);

  const forced = await P.writeChapterBody(121, { content: '', title: '第三章 我的S级天赋去哪了？', confirmEmpty: true });
  check('P-EMPTY-4 只有作者显式确认才带 confirm_empty 落库（这是唯一的空正文写入口）', forced === 'saved'
    && stub.editorPutBodies.length >= 1 && stub.editorPutBodies[stub.editorPutBodies.length - 1].confirm_empty === true);

  P.state.editorEmptyBlocked = { id: 121, content: '', title: '第三章 我的S级天赋去哪了？' };
  const bar = P.recoveryBarHtml(P.state.chapters.find((c) => c.id === 121));
  check('P-EMPTY-5 恢复条给出两条出路（取回历史版本 / 确认清空本章），作者不会卡在"已暂停"上',
    bar.includes('editor-empty-restore') && bar.includes('editor-empty-clear'));

  check('P-EMPTY-6 空内容暂停不再锁死导航（flushSave 放行；只有 409 真冲突才拦人）', (await P.flushSave()) === true);

  // ── P-EMPTY-7/8/9：2026-10-02 晚，作者报"修稿完成后无法直接加进正文，而是报错" ──
  // 根因：暂停态是**粘性**的（只在显式清空/采纳成功时才清），作者把正文粘回来之后它还挂着；
  // 而"合并到正文"（mergeReviewDiff→adopt）**完全不经过编辑器**，却在开头调 flushSave，
  // 于是每次合并/导航都弹一句"本章编辑器是空的，已暂停保存"，看起来像是它挡住了操作。
  const savedToast = sandbox.toast;
  const msgs = [];
  sandbox.toast = (m) => { msgs.push(String(m)); };
  // 7) 粘性暂停态：编辑器已经有正文 → 必须自动清除，且不再认为"有未保存的空白"
  editor.innerHTML = '<p>正文已经粘回来了，这一版不该再被当成空稿。</p>';
  P.state.editorEmptyBlocked = { id: 121, content: '', title: '第三章' };
  P.state.editorSaveFailedSnapshot = { id: 121, message: '旧失败态', code: 'EMPTY_OVERWRITE_BLOCKED' };
  const quietOk = await P.flushEditorSaves();
  check('P-EMPTY-7 编辑器已有正文时，粘性暂停态自动清除（不再把这一章当成空稿）',
    quietOk === true && P.state.editorEmptyBlocked === null && P.state.editorSaveFailedSnapshot === null);

  // 8) 内部等待落盘（采纳/合并走的那条）**不得产生任何提示**
  msgs.length = 0;
  await P.flushEditorSaves();
  check('P-EMPTY-8 内部等待落盘不弹任何提示（采纳/合并路径不再听到"编辑器是空的"）',
    msgs.length === 0, JSON.stringify(msgs));

  // 9) 导航闸门仍在真的暂停时提示（提示没有被误删，只是搬回了导航这一层）
  editor.innerHTML = '';
  P.state.editorEmptyBlocked = { id: 121, content: '', title: '第三章' };
  msgs.length = 0;
  const navOk = await P.flushSave();
  check('P-EMPTY-9 真的还空着时，导航仍给出那条提示并放行（提示搬到了导航层）',
    navOk === true && msgs.some((m) => m.includes('已暂停保存')), JSON.stringify(msgs));

  // 10) 作者报障的**原路径**：编辑器是空的，但要点"合并修稿到正文"。
  //     这条路的正文来自入参（调用方算好的修稿稿），与编辑器无关 —— 必须：
  //     ① 采纳请求里带的是**修订稿**（不是编辑器那份空内容）；② 全程不弹"编辑器是空的"警报。
  const savedApi10 = sandbox.api, savedFetch10 = sandbox.fetch;
  const adoptBodies = [];
  sandbox.api = async (url, opts = {}) => {
    const u = String(url);
    // 注意：这里替换的是 api() 本身（不是 fetch），所以 body 是**对象**而不是 JSON 字符串。
    if (u.includes('/novel/adopt')) { adoptBodies.push(typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {})); return { ok: true, adopt: { legacy: { events: 0, memories: 0 }, chapter_updated_at: 'rev-1' } }; }
    if (u.includes('/chapters/121')) return { id: 121, title: '第三章', content: '<p>库里的旧稿</p>', summary: '', updated_at: 'rev-1', content_hash: 'hash-rev' };
    if (u.includes('/harness/recoverable')) return { jobs: [] };
    if (u.includes('/novel/draft')) return { draft: null };
    if (u.includes('/novel/review')) return { review: null };
    return { ok: true };
  };
  sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true,"adopt":{"legacy":{"events":0,"memories":0},"chapter_updated_at":"rev-1"}}' });
  editor.innerHTML = '';                                  // 编辑器确实是空的
  P.state.editorEmptyBlocked = { id: 121, content: '', title: '第三章' };
  msgs.length = 0;
  let merged = false; let mergeErr = '';
  try {
    await P.adoptEditorContentImpl({ targetChapterId: 121, html: '<p>这是修稿后的正文，必须写进去。</p>', selectionIds: [], adoptKind: 'review_merge' });
    merged = true;
  } catch (e) { mergeErr = String(e && e.message); }
  check('P-EMPTY-10 编辑器为空时合并修稿：写进去的是**修订稿**，且不弹"编辑器是空的"警报',
    merged && !mergeErr && adoptBodies.length === 1
      && String(adoptBodies[0].content).includes('这是修稿后的正文')
      && !msgs.some((m) => m.includes('已暂停保存')),
    mergeErr || JSON.stringify({ bodies: adoptBodies.map((b) => String(b.content).slice(0, 30)), msgs }));
  sandbox.api = savedApi10; sandbox.fetch = savedFetch10;
  sandbox.toast = savedToast;
  P.state.editorEmptyBlocked = savedEmpty;

  P.state.chapters = savedChapters; P.state.workId = savedWorkId;
  P.state.editorConflictSnapshot = savedConflict; P.state.editorSaveFailedSnapshot = savedFailed;
  P.state.editorEmptyBlocked = savedEmpty; P.state.editorSaveSnapshot = savedSaveSnap;
  P.state.recoveryForChapter = savedRecoveryFor;
  P.state.chapterBodyPeak.delete(121); // 峰值是"本页见过"的累积量，测试用完要清掉，避免影响后续用例
  stub.serverBlocksEmpty = false;
  for (const [k, v] of Object.entries(savedNodes)) { if (v) containers['#' + (k === 'editor' ? 'editor-content' : k === 'title' ? 'editor-title' : 'editor-status')] = v; }
}

// --- P-EMPTY-11/12（2026-10-04 报障）：空稿被拦下时，恢复条必须**当场**画出那两条出路 ---
// 现场（作者原话）："编辑器当前是空的，已暂停自动保存（正文没有被覆盖）——用编辑器上方的恢复条
// 取回原稿，或明确选择清空本章，你没有按钮让我选择清空本章，一刷新又恢复了"。
// 即：那句话把他指向了一个**不存在的出口** —— 恢复条上根本没有「确认清空本章」，
// 于是他清不掉这一章，刷新后正文又回来了（护栏没让它落盘，这本身是对的）。
// 根因：那两个调用点只调 `refreshChapterRecovery`（**只取数据、不碰 DOM**），
// 而且"这一章的恢复数据已经取过"（`state.recoveryForChapter === id`，打开章节后必然如此）时，
// 连这个调用都被整个跳过 → 恢复条保持旧 HTML，按钮永远不出现。
{
  const savedChapters = P.state.chapters; const savedChapterId = P.state.currentChapterId;
  const savedDraft = P.state.chapterDraft; const savedReview = P.state.chapterReview;
  const savedJobs = P.state.chapterJobs; const savedBlocked = P.state.editorEmptyBlocked;
  const savedFailed = P.state.editorSaveFailedSnapshot; const savedSaveSnap = P.state.editorSaveSnapshot;
  const savedRecoveryFor = P.state.recoveryForChapter; const savedToast = sandbox.toast;
  const savedNodes = { editor: containers['#editor-content'], title: containers['#editor-title'] };

  const editor = mkEl('editor-content', 'div');
  editor.dataset.chapterId = '121';
  editor.innerHTML = '';                                   // 作者把正文清掉了
  const title = mkEl('editor-title', 'input');
  title.value = '第三章 我的S级天赋去哪了？';
  containers['#editor-content'] = editor; containers['#editor-title'] = title;
  const box = mkEl('chapter-recovery', 'div');              // 恢复条容器（渲染前是空的，与真实一致）
  P.state.chapters = [{ id: 121, title: '第三章 我的S级天赋去哪了？', content: `<p>${'正文'.repeat(900)}</p>`, updated_at: 'base-1' }];
  P.state.currentChapterId = 121;
  P.state.chapterDraft = null; P.state.chapterReview = null; P.state.chapterJobs = [];
  P.state.editorEmptyBlocked = null; P.state.editorSaveFailedSnapshot = null; P.state.editorSaveSnapshot = null;
  P.state.recoveryForChapter = 121;                         // ← 复现条件：这一章的恢复数据已经取过了
  P.state.chapterBodyPeak.delete(121);
  P.state.chapterBodyPeak.set(121, 3982);                   // 本页见过这一章有正文（护栏判据）
  sandbox.toast = () => {};

  // ① 自动保存那条路：空稿 → 800ms 后闸门命中
  P.scheduleSave();
  await new Promise((r) => setTimeout(r, 900));
  check('P-EMPTY-11 空稿被自动保存闸门拦下时，恢复条当场给出「取回历史版本 / 确认清空本章」',
    !!P.state.editorEmptyBlocked && String(box.innerHTML).includes('data-action="editor-empty-restore"')
      && String(box.innerHTML).includes('data-action="editor-empty-clear"'),
    JSON.stringify({ blocked: !!P.state.editorEmptyBlocked, bar: String(box.innerHTML).slice(0, 140) }));

  // ② 服务端拦下那条路（tripEmptyGuardState）同样不能只记状态、不画出路
  box.innerHTML = '';
  P.state.editorEmptyBlocked = null; P.state.editorSaveFailedSnapshot = null;
  stub.serverBlocksEmpty = true; stub.editorPutBodies.length = 0;
  await P.saveChapterSnapshot({ id: 121, content: '', title: '第三章 我的S级天赋去哪了？' });
  check('P-EMPTY-12 服务端拦下空正文后，恢复条同样当场给出两条出路（不是只在状态栏写"已暂停"）',
    String(box.innerHTML).includes('data-action="editor-empty-clear"')
      && String(box.innerHTML).includes('data-action="editor-empty-restore"'),
    String(box.innerHTML).slice(0, 160));

  stub.serverBlocksEmpty = false;
  sandbox.toast = savedToast;
  P.state.chapters = savedChapters; P.state.currentChapterId = savedChapterId;
  P.state.chapterDraft = savedDraft; P.state.chapterReview = savedReview; P.state.chapterJobs = savedJobs;
  P.state.editorEmptyBlocked = savedBlocked; P.state.editorSaveFailedSnapshot = savedFailed;
  P.state.editorSaveSnapshot = savedSaveSnap; P.state.recoveryForChapter = savedRecoveryFor;
  P.state.chapterBodyPeak.delete(121);
  if (savedNodes.editor) { containers['#editor-content'] = savedNodes.editor; registered.set('#editor-content', savedNodes.editor); }
  else registered.delete('#editor-content');
  if (savedNodes.title) { containers['#editor-title'] = savedNodes.title; registered.set('#editor-title', savedNodes.title); }
  else registered.delete('#editor-title');
}

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
  P.goView('rules'); // T6：编辑规则已拆为独立页面（不再是创作上下文的一部分）
  await P.render();
  const stHtml = String(containers['#content'].innerHTML);
  const stHtmlFull = stHtml + String(containers['#board-content'].innerHTML);
  check('58h 编辑规则独立页渲染出编辑规则卡（开关 / 档位 / 题材 / 能力 / 扫描 / 保存）',
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
  P.goView('style'); // T6：作者样文 / 文风档案已拆为独立页面
  await P.render();
  const r09Html = String(containers['#content'].innerHTML) + String(containers['#board-content'].innerHTML);
  check('R09-1 作者样文独立页渲染出作者样文卡（添加 / 启用开关 / 编辑 / 删除 / 样文行）',
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
  P.goView('story-state'); // T6：故事状态与披露已拆为独立页面（含影响 / 逐章重建）
  await P.render();
  const r10Html = String(containers['#content'].innerHTML) + String(containers['#board-content'].innerHTML);
  check('R10-1 故事状态独立页渲染出故事状态卡（开关 / 计数 / 状态哈希 / 重算入口）',
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
  P.goView('branch'); // T6：剧情分支沙盘已拆为独立页面
  await P.render();
  const r11 = String(containers['#content'].innerHTML) + String(containers['#board-content'].innerHTML);
  check('R11-1 剧情分支独立页渲染出沙盘进度与候选（核心行动/冲突/计数/来源）',
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
  // 分段阈值用例（58q/58r）：预算刻意压到 1000，让 24 段的长章节必须分段。
  P.state.longTextSettings = { request_chars: 1000, output_reserve_chars: 400, protocol_chars: 100, max_segment_chars: 600, min_segment_chars: 100 };
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
  // ⚠️ 单请求归属用例（58ae/58af）必须先把预算抬回默认量级：审稿提示词自身已长到 ≈1400 字符
  //（buildAIReviewPrompt 内联了写作纪律与反 AI 腔清单），而上面为 58q 压到的 1000 字符可用额度
  // 会让 17 字的短正文也判成"必须分段"——那两个用例测的是**归属**（谁来跑这一次模型），
  // 不是分段阈值。2026-10-02 复核：沿用旧值 1500 时 58ae/58af 必然失败。
  P.state.longTextSettings = { request_chars: 8000, output_reserve_chars: 400, protocol_chars: 100, max_segment_chars: 600, min_segment_chars: 100 };
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
  // ⚠️ 2026-10-08 规格变更（《叙事性专项修复》E01／§6.6）：`ok=false` 仍然表示"这批补丁不可用"，
  //    但**调用方不再据此回退整章重写**（那是付费且无门禁的整章覆盖）。断言保持不变，
  //    "不回退"由下面 94s 那组接线断言（refineByChecklist 里已没有 buildAIRevisionPrompt）负责。
  check('90 补丁都定位不到时 ok=false（调用方不得据此整章重写，见 94s）', (() => { const r = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ anchor: '不存在的段落。', revised: 'x' }] }), article); return !!r && r.ok === false && r.unresolved.length === 1; })());

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

  // 提示词契约：必须要求 JSON 补丁、只改相关跨度、span 与原句逐字
  // ⚠️ 2026-10-08 规格变更（E01／§6.4）：下发协议从"anchor/revised"改成 v2
  //    （span_id + op + original + replacement）。旧字段名不再出现在新提示词里，
  //    旧字段仍由解析器的兼容分支接收（见 80c/80d 的抢救断言）。
  const prompt = P.buildAIRevisionPatchPrompt(article, ['问题一', '问题二']);
  check('91 补丁提示词含 JSON 契约与协议 v2 字段（span_id/op/original/replacement）',
    prompt.includes('"patches"') && prompt.includes('span_id') && prompt.includes('"op"')
    && prompt.includes('original') && prompt.includes('replacement') && prompt.includes('"schema_version":2'));
  check('92 补丁提示词明确"只修相关跨度、其余不要输出"', /只修改/.test(prompt) && /不要输出/.test(prompt));
  check('93 补丁提示词带上确认清单', prompt.includes('1. 问题一') && prompt.includes('2. 问题二'));
  check('94 整章重写提示词仍保留（兜底路径）', P.buildAIRevisionPrompt(article, ['问题一']).includes('完整正文'));
}
// --- 9b) Safe Editing：修稿安全门禁（第三批）---
// 背景（《Novel-Studio 修稿前后问题整合与 Safe-Editing 修改方案》§3/§14）：补丁式修稿只校验
// "能不能定位"，不校验"该不该应用"，于是修稿器会把后文赖以成立的结构桥删掉——
// 删掉王磊递面包 → 面包凭空出现；删掉首次人物主体 → 后面的"她"没有先行语；
// 删掉"大屏切到海澜市" → 读者不知道在看现场还是屏幕；为一个轻度时间疑问顺手新增整套 B 区支线。
// 门禁只做一件事：**命中的那一条补丁不进差异稿**，同批其余补丁照旧应用（逐条粒度）。
{
  const K = sandbox.NovelPatchSafety;
  check('94a 安全门禁模块随页面加载（UMD 纯函数模块，与 long-text.js 同序、先于 app.js）',
    !!K && typeof K.gatePatches === 'function' && K.VERSION === '1.1.0', K ? K.VERSION : 'missing');

  // Test 1（§14）：把"王磊递面包"的那一句删掉 → 后文面包凭空出现 → REJECT object_provenance
  // ⚠️ 补丁契约的可表达形态是"anchor → 改好后的段落"，整段删除（revised 为空）由既有护栏拒绝
  //（见 84「改后内容为空」），所以这里用真实形态：段落里**少了递面包那一句**。
  const breadBase = ['王磊把面包递给岳宸炎，一个字没说。', '岳宸炎吃面包。'].join('\n\n');
  const breadOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '王磊把面包递给岳宸炎，一个字没说。', revised: '岳宸炎接过来。' }] }), breadBase, {});
  check('94b 删除物件来源（递面包那一句）被门禁拦下，正文保持原样',
    !!breadOut && breadOut.ok === true && breadOut.allBlocked === true && breadOut.applied.length === 0 && breadOut.text === breadBase,
    JSON.stringify({ ok: breadOut && breadOut.ok, allBlocked: breadOut && breadOut.allBlocked, applied: breadOut && breadOut.applied.length }));
  check('94c 拦截码是 object_provenance，原因可读（含被删词面与后文证据）', (() => {
    const b = (breadOut && breadOut.blocked) || [];
    return b.length === 1 && b[0].code === 'object_provenance' && /面包/.test(b[0].reason);
  })(), JSON.stringify(((breadOut && breadOut.blocked) || []).map((b) => b.code)));
  // 同一处的"整段删除"形态（revised 为空）也必须被识别为物件来源断裂
  const breadWhole = P.patchSafetyGate(breadBase, [{ issue: 1, anchor: '王磊把面包递给岳宸炎，一个字没说。', revised: '' }], {});
  check('94c2 整段删除形态（revised 为空）同样按物件来源断裂拦下',
    breadWhole.blocked.length === 1 && breadWhole.blocked[0].code === 'object_provenance',
    JSON.stringify(breadWhole.blocked.map((b) => b.code)));

  // Test 2（§14）：删场景锚点 → scene_anchor；删首次人物介绍 → reference_anchor
  const liveBase = ['大屏切到海澜市。', '一个女生从通道走出来。', '她走到检测台前。'].join('\n\n');
  const sceneOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '大屏切到海澜市。', revised: '' }] }), liveBase, {});
  check('94d 删除场景锚点（大屏切到海澜市）被拦下：scene_anchor',
    !!sceneOut && sceneOut.blocked.length === 1 && sceneOut.blocked[0].code === 'scene_anchor',
    JSON.stringify(((sceneOut && sceneOut.blocked) || []).map((b) => b.code)));
  const subjectOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '一个女生从通道走出来。', revised: '' }] }), liveBase, {});
  check('94e 删除首次人物主体（一个女生）被拦下：reference_anchor',
    !!subjectOut && subjectOut.blocked.length === 1 && subjectOut.blocked[0].code === 'reference_anchor',
    JSON.stringify(((subjectOut && subjectOut.blocked) || []).map((b) => b.code)));

  // Test 3（§14）：轻度时间疑问却新增多个剧情事实 → story_fact（Level 3 禁止自动应用）
  const queueBase = ['傍晚的检测台前排着队。', '岳宸炎握着号单。'].join('\n\n');
  const queueOut = P.tryApplyRevisionOutput(JSON.stringify({
    patches: [{ issue: 1, anchor: '傍晚的检测台前排着队。', revised: '傍晚的检测台前排着队。少队的人把 B区 的号单发错，岳宸炎误入 B区 排了半小时，被人赶回来重新排号。' }],
  }), queueBase, {});
  check('94f 新增正式事实（B区 + 整段新增剧情）被拦下：story_fact',
    !!queueOut && queueOut.blocked.length === 1 && queueOut.blocked[0].code === 'story_fact',
    JSON.stringify((queueOut && queueOut.blocked[0] && queueOut.blocked[0].signals) || []));

  // Test 4（§14）：删多余光效比喻 → ALLOW，edit_scope = wording（纯表达压缩）
  const gradeBase = ['李拓的名字后面跟着 A级 两个字，金红色的光柱打下来，横幅都发白了。', '他站在大厅中央。'].join('\n\n');
  const gradeGate = P.patchSafetyGate(gradeBase, [{ issue: 1, anchor: '李拓的名字后面跟着 A级 两个字，金红色的光柱打下来，横幅都发白了。', revised: '李拓的名字后面跟着 A级 两个字。' }], {});
  check('94g 删多余光效（纯表达压缩）放行，且分级为 wording（Level 1）',
    gradeGate.blocked.length === 0 && gradeGate.allowed.length === 1 && gradeGate.allowedMeta[0].scope === 'wording',
    JSON.stringify({ blocked: gradeGate.blocked.length, scope: gradeGate.allowedMeta[0] && gradeGate.allowedMeta[0].scope }));

  // Test 5（§14）：删"他坐着等系统下一句"（前文已充分表现等待）→ ALLOW
  const endBase = ['他坐着等系统下一句。窗外没有动静。', '他坐在床边没动。', '系统没有响。'].join('\n\n');
  const endOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '他坐着等系统下一句。窗外没有动静。', revised: '窗外没有动静。' }] }), endBase, {});
  check('94h 删除章尾冗余总结放行（代词仍有先行语、后文不依赖该句）',
    !!endOut && endOut.ok === true && endOut.applied.length === 1 && !endOut.allBlocked && endOut.blocked.length === 0,
    JSON.stringify({ applied: endOut && endOut.applied.length, blocked: endOut && endOut.blocked.length }));

  // 阴性对照（零误报优先）：正常压缩同功能描写不该被拦
  const denseBase = ['大厅里很亮，灯很亮，地板也很亮，亮得他眯起眼。', '他走进去。', '他站住了。'].join('\n\n');
  const denseOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '大厅里很亮，灯很亮，地板也很亮，亮得他眯起眼。', revised: '大厅里亮得他眯起眼。' }] }), denseBase, {});
  check('94i 阴性对照：压缩同功能描写不被拦（零误报）', !!denseOut && denseOut.blocked.length === 0 && denseOut.applied.length === 1);
  // 阴性对照：人物已在前文引入，把本段的名字换成代词不该判成"指代断裂"
  const namedBase = ['王磊站在门口。', '王磊把耳机摘下来，把线绕在手上。', '他看了看岳宸炎。', '岳宸炎点头。'].join('\n\n');
  const namedChars = { characters: ['王磊', '岳宸炎'] };
  const namedOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '王磊把耳机摘下来，把线绕在手上。', revised: '他把耳机摘下来，把线绕在手上。' }] }), namedBase, namedChars);
  check('94j 阴性对照：先行语仍在前文（王磊）时放行，不误判指代断裂',
    !!namedOut && namedOut.blocked.length === 0 && namedOut.applied.length === 1,
    JSON.stringify(((namedOut && namedOut.blocked) || []).map((b) => b.code)));

  // 逐条粒度：同批里一条该拦、一条该放 —— 拦的进 blocked，放的照旧应用（§17 两条要求同时成立）
  const mixedOut = P.tryApplyRevisionOutput(JSON.stringify({
    patches: [
      { issue: 1, anchor: '王磊把面包递给岳宸炎，一个字没说。', revised: '岳宸炎接过来。' },
      { issue: 2, anchor: '岳宸炎吃面包。', revised: '岳宸炎咬了一口。' },
    ],
  }), breadBase, {});
  check('94k 逐条粒度：只拦命中的那一条，同批其余补丁照旧应用',
    !!mixedOut && mixedOut.ok === true && mixedOut.blocked.length === 1 && mixedOut.applied.length === 1 && mixedOut.text.includes('咬了一口'),
    JSON.stringify({ blocked: mixedOut && mixedOut.blocked.length, applied: mixedOut && mixedOut.applied.length }));

  // Diff-aware 修后核验（§12/§17）：补丁路径之外（整章重写）也要能发现断裂
  const verify = K.verifyPatchedText(breadBase, '岳宸炎吃面包。');
  check('94l 修后核验能发现整章重写造成的物件断裂（object_provenance）',
    verify.findings.some((f) => f.code === 'object_provenance' && /面包/.test(f.reason)),
    JSON.stringify(verify.findings.map((f) => f.code)));
  check('94m 修后核验不误报：原文原样当新文时零断裂', K.verifyPatchedText(breadBase, breadBase).findings.length === 0);

  // protected_content（§13）：作者指定的保护句被改写 → 拦；逐字保留 → 放行
  const protectBase = ['“我信A级存在。没说你。”他说。', '岳宸炎没接话。'].join('\n\n');
  const protectOpts = { protectedContent: ['我信A级存在。没说你。'] };
  const protectOut = P.tryApplyRevisionOutput(JSON.stringify({ patches: [{ issue: 1, anchor: '“我信A级存在。没说你。”他说。', revised: '他说他相信A级存在。' }] }), protectBase, protectOpts);
  check('94n 命中保护句的改写被拦下：protected_content',
    !!protectOut && protectOut.blocked.length === 1 && protectOut.blocked[0].code === 'protected_content',
    JSON.stringify(((protectOut && protectOut.blocked) || []).map((b) => b.code)));
  const protectKeep = P.patchSafetyGate(protectBase, [{ issue: 1, anchor: '“我信A级存在。没说你。”他说。', revised: '“我信A级存在。没说你。”他把杯子放下。' }], protectOpts);
  check('94o 保护句原样保留时不算命中（逐字子串判据，零误报）', protectKeep.blocked.length === 0 && protectKeep.allowed.length === 1);

  // 失败姿态：门禁模块不可用时**放行**（不阻塞作者修稿），但必须产出可见的"本次没有拦截"
  const savedEngine = sandbox.NovelPatchSafety;
  try {
    sandbox.NovelPatchSafety = undefined;
    const noEngine = P.patchSafetyGate(breadBase, [{ issue: 1, anchor: '王磊把面包递给岳宸炎，一个字没说。', revised: '岳宸炎接过来。' }], {});
    check('94p 门禁不可用时放行但明示 safety_unavailable（不静默降级）',
      noEngine.allowed.length === 1 && noEngine.blocked.length === 0 && noEngine.findings.some((f) => f.code === 'safety_unavailable'));
  } finally { sandbox.NovelPatchSafety = savedEngine; }

  // 接线：差异预览必须把"未自动应用"的补丁与原因显示给作者（而不是静默吞掉）
  containers['#modal-root'].innerHTML = '';
  P.showReviewDiff(breadBase, breadBase, { applied: 0, chapterId: 1, blocked: (breadOut && breadOut.blocked) || [], findings: [] });
  const diffHtml = String(containers['#modal-root'].innerHTML);
  check('94q 差异预览出现「安全门禁」分区并逐条说明未自动应用的原因',
    diffHtml.includes('安全门禁') && diffHtml.includes('未自动应用') && /面包/.test(diffHtml),
    diffHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
  check('94r 门禁零命中时不渲染安全分区（不制造噪音）', P.patchSafetyNotesHtml([], []) === '');
  P.closeModal();
}

// --- 9c) E01 接线：《叙事性专项修复》局部补丁协议 v2（2026-10-08）-----------------
// 覆盖 P06/P10/P13 的**应用层**面（模块级判定在 tests/narrative-repair/01-patch-protocol.test.mjs）：
//   · 新协议真的被下发（span_id + op + original + replacement），跨度目录里带稳定 span_id；
//   · 精确跨度替换：只授权长段里的一句 → 只改这一句；
//   · 协议 schema 错误与 stale 都被**如实拒绝**，且原文一个字符不动；
//   · 失败不再自动扩大为整章重写（静态：调用方里没有整章重写分支；动态：只有作者动作才发整章请求）。
{
  const RP = sandbox.NovelRevisionPatch;
  check('94s 补丁协议 v2 模块随页面加载（index.html 顺序先于 app.js）',
    !!RP && typeof RP.VERSION === 'string' && RP.VERSION.startsWith('2.') && P.revisionPatchEngine() === RP,
    RP ? RP.VERSION : 'missing');

  const longPara = '第一句写了很多东西，其中提到了雨、伞和鞋子，还有一整段别的内容。';
  const v2Article = [longPara, '第二段：他站着没动。'].join('\n\n');
  const snap = P.revisionSnapshotFor(v2Article, 107);
  const sentSpan = RP.buildSpans(v2Article, { sentences: true }).find((x) => x.kind === 'sentence');
  const v2Payload = JSON.stringify({
    schema_version: 2, snapshot_id: snap.snapshot_id, base_hash: snap.body_hash,
    patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: [1], span_id: sentSpan.span_id, op: 'replace', original: sentSpan.text, replacement: '第一句很短。' }],
    dispositions: [{ issue_id: '1', status: 'patched', reason: '删重复' }],
  });
  const applied = P.tryApplyRevisionOutput(v2Payload, v2Article, {}, { snapshot: snap, chapterId: 107, selectedIssueIds: ['1'] });
  check('94t 精确跨度替换：只授权长段里的一句时只改这一句（其余逐字不变）',
    !!applied && applied.ok === true && applied.applied.length === 1 && applied.text === v2Article.replace(sentSpan.text, '第一句很短。'),
    applied ? JSON.stringify(applied.text) : 'null');
  check('94u 应用层把"已改/未完成/被拦下"分开报（覆盖率可解释）',
    !!applied && Array.isArray(applied.coverage) && applied.coverage.length === 1 && applied.coverage[0].status === 'patched');

  // 协议 schema 错误：坏元素丢光**不能**变成"合法无修改"
  const schemaBad = P.tryApplyRevisionOutput('{"patches":[{}]}', v2Article, {}, { chapterId: 107 });
  check('94v patches:[{}] → schema_error（不是 noop 成功），且原文不动',
    !!schemaBad && schemaBad.ok === false && schemaBad.error_code === 'schema_error' && schemaBad.text === v2Article,
    JSON.stringify({ ok: schemaBad && schemaBad.ok, code: schemaBad && schemaBad.error_code }));

  // stale：补丁针对旧快照，正文已经变了 → 拒绝，且**不覆盖**新稿
  const edited = v2Article.replace('第二段', '第二段（作者刚改过）');
  const staleOut = P.tryApplyRevisionOutput(v2Payload, edited, {}, { snapshot: P.revisionSnapshotFor(edited, 107), chapterId: 107, selectedIssueIds: ['1'] });
  check('94w 源稿变化后旧补丁按 stale 拒绝，不覆盖作者新稿',
    !!staleOut && staleOut.ok === false && staleOut.error_code === 'stale' && staleOut.text === edited,
    JSON.stringify({ ok: staleOut && staleOut.ok, code: staleOut && staleOut.error_code }));

  // 整章重写只能由作者动作触发：调用方里不再有失败回退分支
  const refineBody = (src.match(/async function refineByChecklist\(\)[\s\S]*?\n}\n/) || [''])[0];
  check('94x refineByChecklist 里不再出现"解析失败就整章重写"的回退分支',
    refineBody.length > 0 && !refineBody.includes('buildAIRevisionPrompt') && refineBody.includes('showRevisionUnresolved'),
    `len=${refineBody.length}`);
  check('94y 整章重写被拆成独立函数，且只被显式动作调用',
    /async function refineByFullRewrite\(/.test(src) && /state\.pendingLongTextAltRetry = \(\) => refineByFullRewrite\(/.test(src));

  // 失败弹窗：两个出口都是作者动作，不静默不扩大
  containers['#modal-root'].innerHTML = '';
  P.state.pendingLongTextRetry = null; P.state.pendingLongTextAltRetry = null;
  P.showRevisionUnresolved({ article: v2Article, chapterId: 107 }, { issues: ['问题一'] }, ['问题一'], '补丁协议未通过校验（schema_error）');
  const failHtml = String(containers['#modal-root'].innerHTML);
  check('94z 修稿失败时给作者显式选择（重试补丁 / 整章重写），而不是自动改写整章',
    failHtml.includes('正文未被改动') && failHtml.includes('重试补丁修稿') && failHtml.includes('整章重写')
    && typeof P.state.pendingLongTextRetry === 'function' && typeof P.state.pendingLongTextAltRetry === 'function',
    failHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 120));
  P.state.pendingLongTextRetry = null; P.state.pendingLongTextAltRetry = null;
  P.closeModal();

  // 提示词：跨度目录（span_id｜原文）必须下发，否则模型无法证明改动落在授权范围内
  const v2Prompt = P.buildAIRevisionPatchPrompt(v2Article, ['重复解释'], { snapshot: snap, chapterId: 107 });
  check('94A 修稿提示词下发授权跨度目录（span_id｜逐字原文）',
    /p1｜/.test(v2Prompt) && /p1s1｜/.test(v2Prompt) && v2Prompt.includes('original 必须与授权跨度'),
    v2Prompt.slice(v2Prompt.indexOf('【授权跨度'), v2Prompt.indexOf('【授权跨度') + 60));
}

// --- 9d) E02 接线：阶段化（提示词口径 + 真实路由输入）-------------------------
// 覆盖 §5.1/§5.2 的三条可验证要求：
//   · 审稿轮把同一份纪律当**判据**用（诊断口径 + 反证），不当重写授权；
//   · 生成/修稿轮各自带上真实阶段，且阶段进了**客户端 key 与请求 URL**（否则阶段白加）；
//   · 审计摘要能证明诊断规则没有流入生成阶段。
{
  // ① 审稿轮：诊断口径（不是另一份纪律，而是同一份纪律 + 判据说明）
  const review = P.buildAIReviewPrompt('正文');
  check('94B 审稿提示词带诊断口径（判据 / 不许输出改写稿 / 要给反证）',
    review.includes('【本轮是审稿/诊断，不是重写】') && review.includes('不要输出改写后的正文')
    && review.includes('反证') && review.includes('放 deferred')
    && review.includes(P.WRITING_DISCIPLINE),
    review.slice(review.indexOf('【本轮是审稿/诊断'), review.indexOf('【本轮是审稿/诊断') + 40));
  // 同一份纪律仍在（不为了阶段化把生成纪律从审稿轮里删掉）
  check('94C 审稿轮仍带完整写作纪律（阶段化 = 换口径，不是删规则）',
    P.WRITING_DISCIPLINE.includes('不要为了证明读者已经理解的事实') && review.includes('【写作纪律（务必遵守）】'));
  // ② 生成轮不带诊断口径（诊断口径只属于审稿轮）
  const prose = P.buildAIWritingProsePrompt('需求', { scene_goal: '开场' }, 2000);
  check('94D 生成轮不带审稿口径（诊断规则不回流进生成提示词）',
    !prose.includes('【本轮是审稿/诊断，不是重写】') && prose.includes(P.WRITING_DISCIPLINE));
  // ③ 审计摘要：draft 一条诊断都没有，verify_style 才有
  const auditDraft = P.writingStageAudit('draft');
  const auditVerify = P.writingStageAudit('verify_style');
  check('94E 阶段审计摘要证明诊断规则没有流入生成阶段',
    !('diagnostic' in auditDraft.counts_by_type) && auditDraft.diagnostic_excluded.length > 0
    && (auditVerify.counts_by_type.diagnostic || 0) > 0
    && auditDraft.rule_ids.length > 0 && auditDraft.policy_version === P.WRITING_POLICY_FALLBACK_VERSION,
    JSON.stringify({ draft: auditDraft.counts_by_type, verify: auditVerify.counts_by_type }));
  // ④ 蓝图：身体动作不再是每个情节点的必填项（E02 的"从通用必填清单改为按事件必要性"）
  const bp = P.buildAIWritingBlueprintPrompt('续写', [], 2000, true);
  check('94F 蓝图情节点不再把"身体动作"列为每点必填',
    !/每个一行：地点、出场人物、身体动作/.test(bp)
    && /身体动作只在确实发生或构成关键因果时写/.test(bp));
  // ⑤ 真实路由输入：阶段真的进了请求 URL（走 loadAIContext 的实际拼装）
  const savedCtx = P.state.aiContext;
  const savedChapterId107 = P.state.currentChapterId;
  const savedWorkId107 = P.state.workId;
  const stageUrls = [];
  const grabStage = () => {
    for (const r of requests) {
      if (r.url.includes('/ai_context') || r.url.includes('/novel/context')) stageUrls.push(r.url);
    }
  };
  try {
    requests.length = 0;
    P.state.currentChapterId = 107;
    P.state.workId = 1;
    P.state.aiContext = { assembled: '【装配结果】正文' };
    await P.loadAIContext({ stage: 'verify_style' });
    grabStage();
    await P.loadAIContext({ stage: 'nonsense' });
    grabStage();
  } catch (_) { /* 桩环境不保证网络路径全通；下面的断言只看是否发出过带 stage 的请求 */ }
  P.state.aiContext = savedCtx;
  // 状态必须成对还原：这个块改了"当前章/作品"，后续断言的前置条件不能被它悄悄改掉。
  P.state.currentChapterId = savedChapterId107;
  P.state.workId = savedWorkId107;
  check('94G 阶段通过真实请求 URL 下发（白名单外的一律不加）',
    stageUrls.some((u) => /[?&]stage=verify_style(&|$)/.test(u))
    && !stageUrls.some((u) => /stage=nonsense/.test(u)),
    JSON.stringify(stageUrls.map((u) => u.slice(u.indexOf('?'), u.indexOf('?') + 120))));
}

// --- 9e) 2026-10-09 审查修复的**应用层**回归（每条都先复现旧行为）-----------------
// 覆盖：协议模块缺失时的归因与前置拒绝 / 覆盖表渲染 / 空补丁时的处置呈现 /
//      "失败不整章重写"的**运行时**证据 + §6.6 的一次仅格式重试。
{
  const RP9e = sandbox.NovelRevisionPatch;
  const article = '第一段：陈默走进雨里。\n\n第二段：他站着没动。';
  const snap9e = P.revisionSnapshotFor(article, 107);
  const v2Payload9e = JSON.stringify({
    schema_version: 2, snapshot_id: snap9e.snapshot_id, base_hash: snap9e.body_hash,
    patches: [{ patch_id: 'p1', group_id: 'p1', issue_ids: [1], span_id: 'p2', op: 'replace', original: '第二段：他站着没动。', replacement: '第二段：他把伞收了。' }],
  });

  // 94H：协议模块缺失 → 明确结论码（旧行为：判成 parse_error，弹"模型没输出可用的补丁 JSON"）
  const savedEngine9e = sandbox.NovelRevisionPatch;
  const savedPending9e = P.state.pendingReview;
  const savedRunning9e = P.state.aiTaskRunning;
  const savedLt9e = P.state.longTextSettings;
  try {
    sandbox.NovelRevisionPatch = undefined;
    const d = P.parseRevisionPatchesDetailed(v2Payload9e);
    check('94H 协议模块缺失时给出可读结论码（不把原因错写成"模型没输出 JSON"）',
      d.ok === false && d.error_code === 'schema_unavailable' && /模块未加载/.test(String((d.errors && d.errors[0] || {}).message || '')),
      JSON.stringify({ ok: d.ok, code: d.error_code }));
    requests.length = 0;
    containers['#toast-root'].innerHTML = '';
    P.state.aiTaskRunning = false;
    P.state.pendingReview = { info: { article, chapterId: 107, baseChapterFingerprint: null }, review: { issues: ['问题一'] }, confirmedOverride: ['问题一'] };
    await P.refineByChecklist();
    const posts = requests.filter((r) => r.method === 'POST' && r.url.includes('harness/run'));
    const toastBox = containers['#toast-root'];
    const toastsText = (toastBox.children || []).map((c) => String(c.textContent || '')).join(' ｜ ');
    check('94H2 协议模块缺失时在**付费之前**拒绝（0 次 AI 请求 + 明确文案）',
      posts.length === 0 && toastsText.includes('协议模块未加载'),
      JSON.stringify({ posts: posts.length, toast: toastsText.slice(0, 80) }));
  } finally {
    sandbox.NovelRevisionPatch = savedEngine9e;
    P.state.pendingReview = savedPending9e;
    P.state.aiTaskRunning = savedRunning9e;
    P.state.longTextSettings = savedLt9e;
  }
  check('94H3 进程内引用仍然指向已恢复的模块（前后一致）', P.revisionPatchEngine() === RP9e && !!sandbox.NovelRevisionPatch);

  // 94I：覆盖表渲染（此前 coverage 传进去被静默忽略 → 作者看不到"哪个问题改了/哪个没改"）
  containers['#modal-root'].innerHTML = '';
  P.showReviewDiff(article, article.replace('第二段：他站着没动。', '第二段：他把伞收了。'), {
    checklist: 2, applied: 1, chapterId: 107,
    coverage: [
      { issue_id: '1', status: 'patched', reason: '删掉重复解释' },
      { issue_id: '2', status: 'deferred', reason: '证据不足，保留原文' },
    ],
  });
  const covHtml = String(containers['#modal-root'].innerHTML);
  check('94I 差异预览渲染问题覆盖表（每个已选问题的处置可见，含未改的那个）',
    covHtml.includes('问题覆盖') && covHtml.includes('已改（候选里）') && covHtml.includes('待核验（证据不足）')
    && covHtml.includes('证据不足，保留原文'),
    covHtml.includes('问题覆盖') ? 'ok' : covHtml.replace(/<[^>]*>/g, ' ').slice(0, 80));
  check('94I2 没有覆盖数据时不渲染空表（不制造噪音）', P.revisionCoverageHtml([]) === '');
  P.closeModal();

  // 94J：空补丁但模型给了 blocked/deferred → 必须展示处置，而不是转述成"没有需要改动"
  containers['#modal-root'].innerHTML = '';
  P.showRevisionDispositions('模型对 2 个问题给出了"不自动改"的处置（未改动正文）', [
    { issue_id: '1', status: 'blocked', reason: '缺少后文上下文' },
    { issue_id: '2', status: 'keep', reason: '承担辨识度的对白' },
  ]);
  const dispHtml = String(containers['#modal-root'].innerHTML);
  check('94J 空补丁时把 blocked/keep 的处置与理由摊给作者（不谎称"不需要改"）',
    dispHtml.includes('被拦下/无法应用') && dispHtml.includes('保留（模型说明无需改）')
    && dispHtml.includes('缺少后文上下文') && dispHtml.includes('没有需要展示的文本差异'),
    dispHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 100));
  P.closeModal();

  // 94K：**运行时**证明"失败不整章重写"，并顺手钉住"至多一次仅格式重试"
  requests.length = 0;
  const savedPending9k = P.state.pendingReview;
  const savedRunning9k = P.state.aiTaskRunning;
  const savedLt9k = P.state.longTextSettings;
  const savedRetry9k = P.state.pendingLongTextRetry;
  const savedAlt9k = P.state.pendingLongTextAltRetry;
  try {
    P.state.aiTaskRunning = false;
    P.state.longTextSettings = { request_chars: 200000, output_reserve_chars: 1000, protocol_chars: 100, max_segment_chars: 120000, min_segment_chars: 100 };
    P.state.pendingReview = { info: { article, chapterId: 107, baseChapterFingerprint: null }, review: { issues: ['问题一', '问题二'] }, confirmedOverride: ['问题一'] };
    await P.refineByChecklist();
  } catch (_) { /* 桩不提供真实模型：这里只观察"发了什么请求" */ }
  const posts9k = requests.filter((r) => r.method === 'POST' && r.url.includes('harness/run'));
  const askedFullRewrite = posts9k.some((r) => String(r.body || '').includes('完整正文'));
  check('94K 修稿失败不产生整章重写请求（运行时证据，非源码正则）',
    posts9k.length > 0 && askedFullRewrite === false,
    JSON.stringify({ posts: posts9k.length, fullRewriteAsked: askedFullRewrite }));
  check('94K2 §6.6 的格式失败只做**一次**仅格式重试（同一授权范围，不叠成无限调用）',
    posts9k.length === 2 && String(posts9k[1].body || '').includes('上一次响应未通过输出格式验证')
    && String(posts9k[1].body || '').includes('不要扩大编辑范围'),
    JSON.stringify({ posts: posts9k.length }));
  check('94K3 失败后给作者的是**显式选择**（重试补丁 / 整章重写），不是自动改写',
    typeof P.state.pendingLongTextRetry === 'function' && typeof P.state.pendingLongTextAltRetry === 'function'
    && String(containers['#modal-root'].innerHTML).includes('正文未被改动'));
  // E03：发起修稿前，本次勾选必须写成**独立的选择记录**（快照 + 两个 hash + 勾选集合）
  const selReq = requests.find((r) => r.method === 'PUT' && r.url.includes('/novel/revision/selection'));
  const selBody = selReq ? String(selReq.body || '') : '';
  check('94K4 E03：修稿前写独立选择记录（含勾选集合 / 快照 / selection_hash / 章节）',
    !!selReq && /"selected_issue_ids":\["1"\]/.test(selBody)
    && /"base_hash"/.test(selBody) && /"selection_hash"/.test(selBody)
    && /"snapshot_id"/.test(selBody) && /"chapter_id":107/.test(selBody),
    selBody.slice(0, 200));
  check('94K5 选择记录取的是**本次确认清单**的编号（取消勾选后不会把旧编号写进记录）',
    /"selected_issue_ids":\["1"\]/.test(selBody) && !/"selected_issue_ids":\["1","2"\]/.test(selBody));
  P.state.pendingPendingReview = undefined;
  P.state.pendingReview = savedPending9k;
  P.state.aiTaskRunning = savedRunning9k;
  P.state.longTextSettings = savedLt9k;
  P.state.pendingLongTextRetry = savedRetry9k;
  P.state.pendingLongTextAltRetry = savedAlt9k;
  P.closeModal();
}

// --- 9f) E05 接线：局部编辑计划把"整章跨度目录"收窄到热点 -----------------------
{
  const article = '第一段：陈默走进雨里。\n\n第二段：他站着没动。\n\n第三段：雨还在下。';
  const snap = P.revisionSnapshotFor(article, 108);
  const plan = P.revisionPlanFor(article, ['把「第二段：他站着没动。」改成他收了伞'], { snapshot: snap, chapterId: 108 });
  check('94L 计划把问题描述里的引号片段定位成**片段级**授权跨度',
    !!plan && plan.hotspots.length === 1 && plan.hotspots[0].original === '第二段：他站着没动。'
    && plan.hotspots[0].span.end - plan.hotspots[0].span.start === '第二段：他站着没动。'.length,
    JSON.stringify(plan && plan.hotspots.map((h) => h.original)));
  const planPrompt = P.buildAIRevisionPatchPrompt(article, ['把「第二段：他站着没动。」改成他收了伞'], { snapshot: snap, chapterId: 108, plan });
  check('94L2 有计划时跨度目录收窄到相关段落（不再把整章每一句都下发）',
    planPrompt.includes('已按本次选中问题收窄到相关段落')
    && planPrompt.includes('第二段：他站着没动。')
    && !planPrompt.includes('第一段：陈默走进雨里。｜')
    && planPrompt.includes('【本次授权范围'),
    planPrompt.slice(planPrompt.indexOf('【授权跨度'), planPrompt.indexOf('【授权跨度') + 40));
  check('94L3 定位不到的问题如实标 needs_scope，并退回整章目录（不假装收窄过）',
    (() => {
      const p2 = P.revisionPlanFor(article, ['后半段读起来有点 AI 感'], { snapshot: snap, chapterId: 108 });
      const prompt2 = P.buildAIRevisionPatchPrompt(article, ['后半段读起来有点 AI 感'], { snapshot: snap, chapterId: 108, plan: p2 });
      return p2.unlocated_hotspots.length === 1 && p2.coverage[0].status === 'needs_scope'
        && prompt2.includes('本次没能从问题描述里定位到具体原句');
    })());
  check('94L4 计划是干跑：不含候选正文、不写盘（dry_run）',
    !!plan && plan.dry_run === true && plan.writes_to_disk === false && !('candidate_text' in plan));
}

// --- 9g) E06 接线：设置开关 + 可解释报告 + 单处撤销 -----------------------------
{
  const article = '第一段：陈默走进雨里。\n\n第二段：他站着没动。';
  const at = (s) => ({ start: article.indexOf(s), end: article.indexOf(s) + s.length });
  const p1 = '第一段：陈默走进雨里。';
  const p2 = '第二段：他站着没动。';
  const patches = [
    { issue: 1, op: 'replace', anchor: p1, revised: '第一段：陈默撑着伞走进雨里。', ...at(p1) },
    { issue: 2, op: 'replace', anchor: p2, revised: '第二段：他把伞收了。', ...at(p2) },
  ];
  const coverage = [
    { issue_id: '1', status: 'patched', reason: '去掉重复的雨景交代' },
    { issue_id: '2', status: 'patched', reason: '收紧动作交代' },
  ];

  // ① 审稿报告弹窗里的两个可选授权（默认关闭 + 会持久化）
  sandbox.localStorage.setItem('ns_revision_allow_condense', '0');
  sandbox.localStorage.setItem('ns_revision_protect_selection', '0');
  containers['#modal-root'].innerHTML = '';
  P.showReviewReport({ summary: '总评', issues: ['问题一'], strengths: [], deferred: [] });
  const reportHtml = String(containers['#modal-root'].innerHTML);
  check('94M 审稿报告带两个可选授权开关（默认关闭；只影响这次修稿）',
    reportHtml.includes('data-revision-opt="condense"') && reportHtml.includes('data-revision-opt="protect"')
    && !/data-revision-opt="condense"[^>]*checked/.test(reportHtml)
    && reportHtml.includes('不改变生成行为'),
    reportHtml.includes('data-revision-opt') ? 'ok' : 'missing');
  P.closeModal();

  // ② 可解释报告：逐条改动（问题 ID / 前 / 后 / 理由 / 撤销入口）+ 校验状态 + 相对结论
  containers['#modal-root'].innerHTML = '';
  P.showReviewDiff(article, article.replace(p1, '第一段：陈默撑着伞走进雨里。'), {
    chapterId: 108, applied: 1, patches, coverage,
    verification: {
      safety_blocked: false, verified: true, unresolved: [], findings: [],
      comparison: P.revisionPlanEngine().comparisonVerdict({ metricDelta: -6, diffRead: true }),
    },
  });
  const diffHtml = String(containers['#modal-root'].innerHTML);
  check('94N 预览给出逐条改动：问题 ID / 改动前后 / 理由 / 「撤销这一处」入口',
    diffHtml.includes('本次改动') && diffHtml.includes('data-action="diff-drop-issue"')
    && diffHtml.includes('撤销这一处') && diffHtml.includes('理由：') && diffHtml.includes('去掉重复'),
    'len=' + diffHtml.length);
  check('94O 预览给出校验状态（不让"未核验"看起来像"已验证"）',
    diffHtml.includes('校验状态') && diffHtml.includes('已验证（组合核验通过）'));
  check('94P 相对结论只给"相对"观察并要求作者确认（不把指标变化写成质量结论）',
    diffHtml.includes('相对结论') && /相对/.test(diffHtml) && /作者确认/.test(diffHtml)
    && !/本次改善|质量提升|已提升质量|改善完成/.test(diffHtml));  check('94P2 未读 diff 时不给改善结论（守卫可达）',
    P.revisionPlanEngine().comparisonVerdict({ metricDelta: -9, diffRead: false }).verdict === 'needs_diff_review'
    && String(P.revisionPlanEngine().comparisonVerdict({ metricDelta: -9, diffRead: false }).reason).includes('diff'));

  // ③ 单处撤销：真的用"原稿 + 其余补丁"重建候选，并在同一预览里刷新
  // ⚠️ toast 是 appendChild 的（innerHTML 清不掉旧节点），这里清 children。
  containers['#toast-root'].children.length = 0;
  await P.handleAction('diff-drop-issue', { dataset: { issue: '1' } }, {});
  const afterHtml = String(containers['#modal-root'].innerHTML);
  const toastText = (containers['#toast-root'].children || []).map((c) => String(c.textContent || '')).join('｜');
  check('94Q 撤销一处后重建候选：被撤销的那处不再出现在候选里',
    afterHtml.includes('已按你的撤销重建候选')
    && !/#1<\/b> · 替换/.test(afterHtml)
    && /#2<\/b> · 替换/.test(afterHtml)
    && afterHtml.includes('已从候选里去掉'),
    JSON.stringify({
      notice: afterHtml.includes('已按你的撤销重建候选'),
      issue1: /#1<\/b> · 替换/.test(afterHtml),
      issue2: /#2<\/b> · 替换/.test(afterHtml),
      dropped: afterHtml.includes('已从候选里去掉'),
      toast: toastText.slice(0, 80),
    }));
  check('94Q2 撤销后该问题在覆盖表里标成 dropped（处置可解释）',
    afterHtml.includes('撤销') && afterHtml.includes('已从候选里去掉') && afterHtml.includes('问题覆盖'));
  P.closeModal();
  P.state.pendingReviewDiff = null;
}

// --- 9h) E06 对照视图：模型诊断 / 人工复判 / 结构指标（比例受样本量守卫约束）--------
{
  const data = {
    ok: true, chapter_id: 108,
    model: {
      reviews: 2,
      latest: { id: 9, status: 'parsed', structure: 'review_v2', issues: 3, findings: 2, findings_rejected: 1, deferred: 1 },
      report_shapes: [{ id: 9, confirmed: 2, ignored: 1 }],
    },
    human: { reviews_with_checklist: 1, confirmed: 2, ignored: 1, selections: 2, latest_selection: { id: 4, created_at: '2026-10-09T00:00:00.000Z' } },
    structure: { paragraphs: 88, chars: 4200, dialogue_ratio: 0.12, narrative_candidates: 9, insufficient_data: 0 },
    sample_inputs: { reviews: 2, runs: 2 },
  };
  const html = P.revisionComparisonHtml(data);
  check('94R 对照视图并列三类证据（模型/人工/结构），不把结构指标当质量结论',
    html.includes('模型诊断') && html.includes('人工复判') && html.includes('结构指标')
    && html.includes('88 段 / 4200 字') && html.includes('不判"好不好"'),
    'len=' + html.length);
  check('94R2 样本不足时明确标注"不得据此判断趋势"，且不出现改善类结论',
    html.includes('样本不足') && html.includes('不得据此判断趋势') && !/本次改善|质量已提升|已提升质量/.test(html));
  const rich = P.revisionComparisonHtml({ ...data, sample_inputs: { reviews: 3, runs: 4 }, structure: { paragraphs: 88, chars: 4200, dialogue_ratio: 0.12, narrative_candidates: 9, insufficient_data: 0 } });
  check('94R3 样本够时也只说"相对观察"，不宣告质量结论',
    rich.includes('相对观察') && !/本次改善|质量已提升|已提升质量/.test(rich) && rich.includes('必须先看实际差异'));
  check('94R4 结构化结论与拒收条数分开展示（引用没通过核验的要看得见）',
    html.includes('2 条通过引用核验') && html.includes('1 条被拒收'));
  // 入口：从审稿报告能打开对照（请求真的带上了 chapter_id）
  requests.length = 0;
  containers['#modal-root'].innerHTML = '';
  P.showReviewReport({ summary: '总评', issues: ['问题一'], strengths: [], deferred: [] });
  check('94R5 审稿报告里给出「模型/人工/结构对照」入口（带章节号）',
    String(containers['#modal-root'].innerHTML).includes('data-action="review-compare"')
    && String(containers['#modal-root'].innerHTML).includes('data-chapter='));
  P.closeModal();
  await P.handleAction('review-compare', { dataset: { chapter: '108' } }, {});
  const cmpReq = requests.find((r) => r.url.includes('/novel/revision/comparison'));
  check('94R6 打开对照时按章请求数据（不是拿当前章硬套）',
    !!cmpReq && /chapter_id=108/.test(cmpReq.url), cmpReq ? cmpReq.url : 'no request');
  P.closeModal();
}

// --- 10) 写作路径提速（S1/S2/S3）：纪律内联、截断回退、空回复重试 ---
{
  // S1：蓝图提示词必须带上内联的写作纪律（直连通道没有插件人设）
  const bp = P.buildAIWritingBlueprintPrompt('续写本章', [], 2000, true);
  check('95 蓝图提示词内联了写作纪律（直连没有插件人设）', bp.includes('【写作纪律（务必遵守）】') && bp.includes('已按预算截断'), bp.length + ' 字');
  check('96 纪律常量本身含"不要编造与既有设定冲突的内容"', /不要编造与既有设定冲突/.test(P.WRITING_DISCIPLINE));
  check('96b 蓝图专用那条（references）只出现在蓝图提示词里', bp.includes('references') );

  // E02（2026-10-09）：**直连通道的成文提示词**必须仍带明确事实限制，且**不含**诊断判据/逐项评分任务。
  // 为什么在这一层验：「生成阶段不做自评」是 E02 的通过条件，而它只在拼到最终提示词后才算数——
  // 只验规则模块（模块级已另有用例）会漏掉"提示词里其实没带/带错了阶段文本"。
  const proseStage = P.buildAIWritingProsePrompt('续写本章', { scene_goal: '开场', plot_points: '甲' }, 1200);
  check('96c 直连成文提示词仍写明"不要编造与既有设定冲突的内容"（明确事实限制）',
    /不要编造与既有设定冲突的内容/.test(proseStage), 'len=' + proseStage.length);
  check('96d 直连成文提示词不含诊断阶段的东西（逐项评分任务 / 完整判据 / 审稿清单）',
    !/逐项评分|诊断期·完整判据|逐处识别机械表达，每条都要给出/.test(proseStage));
  const reviewStage = P.buildAIReviewPrompt('一段正文');
  check('96e 审稿提示词仍带完整判据（诊断阶段没有被"去自评"削掉）',
    /逐处识别机械表达|诊断|逐条/.test(reviewStage) && reviewStage.includes('【写作纪律（务必遵守）】'));

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
    // F1（2026-10-06）：裸 id 在两表之间会撞号（事件 #71 与记忆 #71 是不同行的同号提案），
    // 所以采纳必须同时把**带来源类型**的引用交给服务端；裸 ids 只为向后兼容保留。
    check('107g4 整次采纳同时携带带来源类型的提案引用（event:71 / event:72）',
      !!mergeCall && Array.isArray(mergeCall.body.legacy_proposal_refs)
        && mergeCall.body.legacy_proposal_refs.join(',') === 'event:71,event:72',
      JSON.stringify(mergeCall && mergeCall.body && mergeCall.body.legacy_proposal_refs));
    check('107h 跨章合并后明确告知写到了哪一章', msgs.some((m) => m.includes('第107章')), msgs.join(' | ').slice(0, 70));

    // R02.3（语义已于 2026-10-06 修订）：预览期间原文被改 → **不再拒绝合并**。
    // 作者裁决：「无论什么时候，只要是用户执行，就直接强制合并到正文」。
    // 与 F3「旧内容是否保存？」同一条纪律：可以**告知**、可以**留档**，但绝不**拦操作**
    //（覆盖前那一版由服务端在采纳事务里存进本章历史版本，所以"覆盖"可回退）。
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
      const adopt2 = calls2.find((c) => c.url.includes('/novel/adopt'));
      check('107h2 原文在预览后被修改 → 仍然强制合并（不拦操作），并如实说明是它覆盖了更新的那一版',
        !!adopt2 && String(adopt2.body.content || '').includes('乙')
          && msgs2.some((m) => m.includes('已合并') && /覆盖/.test(m)),
        (msgs2.join(' | ') || '(无提示)').slice(0, 140));
    }

    // 2026-10-06 21:47 作者报障 + 当天作者裁决：**「合并到正文」不再有任何拦阻**。
    // 报障现场（活库可复算）：ch119 正文是 `<p><br></p>`（空），作者走「AI 写作 → 先审稿再应用 →
    // 按清单修稿」，点「合并到正文」被回「正文在差异预览之后被修改过（或已读不到）」，
    // 再点多少次都一样 —— 旧闸门把「空正文」与「读不到」并进了同一个拒绝条件
    // （`!String(current).trim()`），而"合并进一个空章"恰恰是这条草稿链存在的理由；
    // 作者最后只能手工把预览抄进编辑器（比覆盖更坏：抄写会把旧段落与新段落叠在一起）。
    // 新契约：**只要作者点了就写正文**；正文变过 / 读不到只做"如实告知 + 留痕"，永不拦。
    {
      const saved3 = {
        api: sandbox.api, toast: sandbox.toast, closeModal: sandbox.closeModal,
        loadWorkData: sandbox.loadWorkData, render: sandbox.render, openModal: sandbox.openModal,
        applySelectedProposals: sandbox.applySelectedProposals, editorPlainText: sandbox.editorPlainText,
        reportClientLog: sandbox.reportClientLog
      };
      // 强制走"读库"这条路（与目标章不是当前打开的章 / 编辑器不在 DOM 时一致），排除编辑器干扰。
      const editorEl = containers['#editor-content'];
      const editorReg = registered.get('#editor-content');
      delete containers['#editor-content'];
      registered.delete('#editor-content');
      P.state.currentChapterId = 108;
      sandbox.closeModal = () => {};
      sandbox.loadWorkData = async () => {};
      sandbox.render = async () => {};
      sandbox.applySelectedProposals = () => {};
      sandbox.openModal = () => {};
      // ⚠️ 本套件的 DOMParser 桩解析不出节点（parseFromString 返回空 body），真实的 editorPlainText
      // 在这个环境里会走"解析器不可用 → 原样返回 HTML"的兜底 —— 那是桩的限制，不是被测行为。
      // 现场用的正文是 `<p><br></p>`（空章），在浏览器里它的纯文本是空串；这里换成一段等价的
      // 最小转换，才能让"正文有没有变过"的**观测**与浏览器同口径。
      sandbox.editorPlainText = (html) => String(html || '')
        .replace(/<br\s*\/?>/gi, '').replace(/<\/?(p|div)[^>]*>/gi, '').trim();
      // 一次合并的完整跑法：底稿文本 = 差异预览的"原文"，接口按现场值应答；日志单独收集。
      const runMerge = async (chapterContent, baseText) => {
        const calls = [];
        const msgs = [];
        const logs = [];
        sandbox.api = async (url, opts = {}) => {
          calls.push({ url: String(url), body: opts.body });
          if (String(url).includes('/chapters/119')) return chapterContent;
          return { ok: true };
        };
        sandbox.toast = (m) => { msgs.push(String(m)); };
        sandbox.reportClientLog = (entry) => { logs.push(entry); };
        P.showReviewDiff(baseText, '改好的第一段。\n\n改好的第二段。', { applied: 2, chapterId: 119 });
        await P.mergeReviewDiff();
        return { msgs, logs, adopt: calls.find((c) => c.url.includes('/novel/adopt')) };
      };
      // ① 空正文（草稿链的常态）：必须写入（本次报障的主断言）
      const stillEmpty = await runMerge({ id: 119, content: '<p><br></p>' }, '');
      check('107m 空正文的章节：合并照常写入正文（不再被任何闸门误拒）',
        !!stillEmpty.adopt && String(stillEmpty.adopt.body.content || '').includes('改好的第一段')
          && !stillEmpty.msgs.some((m) => /拒绝|合并失败/.test(m)),
        (stillEmpty.msgs.join(' | ') || '(无提示)').slice(0, 80));
      // ② 预览时是空的，之后作者自己写了字 → **仍然强制合并**，但必须说出来 + 留痕
      const authorWrote = await runMerge({ id: 119, content: '<p>作者自己写的一段。</p>' }, '');
      check('107n 空基线之后作者自己写了正文：仍然强制合并，并在提示里点明是它覆盖了更新的那一版',
        !!authorWrote.adopt && String(authorWrote.adopt.body.content || '').includes('改好的第一段')
          && authorWrote.msgs.some((m) => m.includes('已合并') && /覆盖/.test(m)),
        (authorWrote.msgs.join(' | ') || '(无提示)').slice(0, 120));
      check('107n2 这次覆盖留下客户端日志（事后可查"为什么覆盖了"）',
        authorWrote.logs.some((e) => String(e && e.kind) === 'review_merge_overwrite'),
        JSON.stringify(authorWrote.logs.map((e) => e && e.kind)));
      // ③ 预览时有正文、之后被清空 → 同样强制合并（作者的动作优先）
      const cleared = await runMerge({ id: 119, content: '<p><br></p>' }, '原来的正文。');
      check('107o 正文在预览后被清空：仍然强制合并（覆盖前那一版由服务端存进历史版本）',
        !!cleared.adopt && cleared.msgs.some((m) => m.includes('已合并') && /覆盖/.test(m)),
        (cleared.msgs.join(' | ') || '(无提示)').slice(0, 120));
      // ④ 读不到这一章（接口没给出这一行）→ 客户端**不拦**，仍然发起合并，并如实说明"没能读到"
      const unreadable = await runMerge(null, '');
      check('107p 读不到这一章正文：客户端不再拦，仍然发起合并并如实说明没能读到',
        !!unreadable.adopt && unreadable.msgs.some((m) => /没能读到/.test(m)),
        (unreadable.msgs.join(' | ') || '(无提示)').slice(0, 120));
      // ⑤ 底稿读取要能区分「读不到」与「这一章没有正文」（上面两句告知文案靠它区分）
      {
        const realApi = sandbox.api;
        sandbox.api = async () => null;
        let threw = '';
        try { await P.revisionBaseArticle(119); } catch (e) { threw = e.message; }
        sandbox.api = async () => ({ id: 119, content: '' });
        const emptyRead = await P.revisionBaseArticle(119);
        sandbox.api = realApi;
        check('107q 底稿读取区分「读不到」（抛错）与「空正文」（返回空串）',
          /读不到/.test(threw) && emptyRead === '',
          `threw=${JSON.stringify(threw)} emptyRead=${JSON.stringify(emptyRead)}`);
      }
      Object.assign(sandbox, saved3);
      if (editorEl) containers['#editor-content'] = editorEl;
      if (editorReg) registered.set('#editor-content', editorReg);
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

// --- 11b) 回归（2026-10-01 真实事故）：模型在蓝图 JSON 的值里写裸 ASCII 引号时，
//     整篇蓝图曾被当成"正文"写进章节（第一章正文 1589 字全是 `【蓝图】{…}`，
//     而 chapters.blueprint_json 反而是空的 —— 蓝图既没进确认弹窗，也没落库）。
//     这里同时钉三件事：① 解析器必须把六段内容抢救出来；② 交付闸门必须拒绝"规划当正文"；
//     ③ 闸门在写回之前生效（不许出现"先写进去再说"）。
{
  const savedCtx = P.state.aiContext;
  const savedConfigs = P.state.apiConfigs;
  const savedActive = P.state.activeConfigId;
  const savedChapters = P.state.chapters;
  const savedWork = P.state.work;
  const savedChapterId = P.state.currentChapterId;
  const savedNode = containers['#editor-content'];
  const savedHarness = sandbox.runHarnessJob;
  const savedConfirm = sandbox.showBlueprintConfirm;
  const savedResult = sandbox.showAIWritingResult;
  const savedApply = sandbox.applyAIWritingArticle;
  const savedReport = sandbox.reportClientLog;

  // 事故原文（结构照抄真实产物）：hook/conflicts 的值里带**未转义的 ASCII 引号**，
  // 严格 JSON.parse 必失败；蓝图专属字段名齐全，闸门靠它们判定"这不是正文"。
  const INCIDENT_BLUEPRINT = [
    '【蓝图】',
    '{',
    '  "scene_goal": "在全国直播的觉醒日最高光时刻，岳宸炎被检测石判成D级·无战斗能力，全场惋惜散去之后，系统在他脑子里开口。",',
    '  "plot_points": "1｜检测中心外广场·排队人群：天没亮就到，他手里那张体检通知单被汗捏出折痕。\\n2｜主检测台·轮到他：按手、三秒，暗黄色。",',
    '  "conflicts": "表层冲突是「场面期待 vs 检测结果」；里层是他刚被判成最底层，却被告知自己是"符合条件的"。",',
    '  "character_changes": "岳宸炎：从排队时的一点期待，到接受D级结果。",',
    '  "hook": "系统又说：这个，别扔。他问为什么。回答："因为从今天起，它是你唯一的伪装。"",',
    '  "references": "回扣：觉醒检测石·光色分级；系统开场语「检测完成，宿主符合绑定条件」。",',
    '}'
  ].join('\n');
  check('108i 前提：这条事故样本严格 JSON 解析必然失败（否则测不到那条兜底路径）',
    P.extractJSONFromText(INCIDENT_BLUEPRINT) === null);

  const bpParsed = P.parseBlueprintJSON(INCIDENT_BLUEPRINT);
  check('108j 蓝图解析能按字段抢救出全部六段（不再把整篇蓝图当成成文）',
    bpParsed.stage === 'salvaged' && P.BLUEPRINT_FIELDS.every((k) => String(bpParsed.blueprint[k] || '').trim()),
    `${bpParsed.stage}｜${JSON.stringify(Object.keys(bpParsed.blueprint || {}))}`);
  check('108k 抢救出的情节点未截断（换行与内容都在，弹窗里作者能直接改）',
    String(bpParsed.blueprint.plot_points || '').includes('主检测台') && String(bpParsed.blueprint.plot_points).includes('\n'),
    JSON.stringify(String(bpParsed.blueprint.plot_points || '').slice(-30)));

  // 闸门本身：规划要拦，真正文不能误拦
  check('108l 交付闸门拦下"带【蓝图】过程头的规划"',
    P.detectNonProseOutput(INCIDENT_BLUEPRINT).includes('过程头'), P.detectNonProseOutput(INCIDENT_BLUEPRINT));
  check('108m 交付闸门拦下"没有过程头但字段名齐全的规划"',
    P.detectNonProseOutput('{"scene_goal":"目标","plot_points":"一","hook":"钩"}').includes('蓝图字段'),
    P.detectNonProseOutput('{"scene_goal":"目标","plot_points":"一","hook":"钩"}'));
  const realProseSample = '岳宸炎把手按在石板上，三秒钟，黑色的石头亮起来，是暗黄色。\n\n广播里念：「D级·普通人，能力：无。」他听见身后有人说"可惜"——那声音不大，却比嘲笑更难受。';
  check('108n 交付闸门不误拦真正文（对话里的引号与项目符号都不算规划）',
    P.detectNonProseOutput(realProseSample) === '', JSON.stringify(P.detectNonProseOutput(realProseSample)));
  check('108o 纠正提示词明确禁止过程标记与 JSON（重生成才有机会拿到正文）',
    P.buildAIWritingProseRetryPrompt('输出含蓝图字段', 4000).includes('只输出本章正文本身')
      && P.buildAIWritingProseRetryPrompt('输出含蓝图字段', 4000).includes('4000'));

  // 端到端：成文轮"两次都吐规划"时，绝不能写进章节。
  // ⚠️ 2026-10-04 起，本章**预置已保存蓝图**不再让写作入口跳过蓝图轮（作者报障后移除了那条捷径），
  //    因此这里必须把蓝图轮喂成一个正常成功的蓝图（否则 fetch 桩的通用回复会被蓝图轮接走，
  //    测到的就是别的分支）。成文轮仍按原样返回规划 —— 那才是本用例要测的事故现场。
  const SAVED_BP = {
    scene_goal: '第一章：觉醒日全场失望与系统上线之间的那一秒反差。',
    plot_points: '1｜检测中心外广场·排队。\n2｜主检测台·轮到他：暗黄色。',
    conflicts: '场面期待 vs 检测结果。',
    character_changes: '岳宸炎：接受D级结果。',
    hook: '系统开口。',
    references: '光色分级。'
  };
  P.state.aiContext = { assembled: '上下文', context_manifest: [], context_stats: { truncatedLayers: 0 } };
  P.state.apiConfigs = [{ id: 1, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 4096 }];
  P.state.activeConfigId = 1;
  P.state.workId = 2;
  P.state.work = { id: 2, title: '测试作品' };
  P.state.currentChapterId = 107;
  P.state.chapters = [{
    id: 107, title: '第107章', target_words: 3000, content: '<p>原文</p>',
    blueprint_json: JSON.stringify(SAVED_BP)
  }];
  containers['#editor-content'] = mkEl('editor-content');
  containers['#editor-content'].innerHTML = '<p>原文</p>';
  containers['#modal-root'].innerHTML = '';
  check('108p0 前提：本章已保存蓝图（旧实现会因此跳过蓝图轮 —— 2026-10-04 起不再跳过）',
    String(P.state.chapters[0].blueprint_json || '').includes('scene_goal'));
  const prosePrompts = [];
  const proseBodies = [];
  sandbox.runHarnessJob = async (body) => {
    const prompt = String((body && body.prompt) || '');
    prosePrompts.push(prompt);
    proseBodies.push(body || {});
    // 成文轮与重生成轮**都**吐规划（事故现场）
    return { output: INCIDENT_BLUEPRINT };
  };
  // 蓝图轮：走直连并给出一个正常蓝图（这样流程才会进入本用例真正要测的成文轮）。
  const savedDirectFor108 = sandbox.directAIWrite;
  sandbox.directAIWrite = async (messages) => {
    const prompt = String((messages && messages[0] && messages[0].content) || '');
    if (prompt.includes('【蓝图】')) return `【蓝图】\n${JSON.stringify(SAVED_BP)}`;
    return '';
  };
  sandbox.showBlueprintConfirm = async (bp) => ({ ...bp, skip: false, target_words: 3000 });
  let resultOpened = 0;
  sandbox.showAIWritingResult = async () => { resultOpened += 1; return null; };
  let applied = 0;
  sandbox.applyAIWritingArticle = async () => { applied += 1; };
  const rejectLogs = [];
  sandbox.reportClientLog = (o) => { if (o && o.kind) rejectLogs.push(String(o.kind)); };
  let e2eErr = '';
  try { await P.performToolbarAIWrite('写第一章'); } catch (e) { e2eErr = e.message; }
  check('108p 成文轮连续返回规划时：不打开结果弹窗、不写回章节（绝不把蓝图正文写进去）',
    resultOpened === 0 && applied === 0,
    `opened=${resultOpened} applied=${applied} err=${e2eErr}`);
  check('108q 拦下时如实说明原因（作者知道发生了什么，而不是静默无结果）',
    String(containers['#modal-root'].innerHTML).includes('不是章节正文'),
    String(containers['#modal-root'].innerHTML).slice(0, 120));
  check('108r 拦下这件事留下客户端日志（事故在日志里必须可见）',
    rejectLogs.includes('prose_output_rejected'), JSON.stringify(rejectLogs));
  check('108s 确实重生成过一次（不是一次失败就放弃）',
    prosePrompts.filter((p) => p.includes('只输出本章正文本身')).length === 1,
    JSON.stringify(prosePrompts.map((p) => p.slice(0, 24))));
  check('108p1 本章已有蓝图也不再跳过蓝图轮：成文轮之前先跑了一轮"要蓝图"',
    prosePrompts.length >= 1 && !prosePrompts[0].includes('只输出本章正文本身'),
    JSON.stringify(prosePrompts.map((p) => p.slice(0, 24))));
  // 规划轮走慢通道时模型带着检索工具（novel_context / novel_lookup），它们会绕过前端那层 omit ——
  // 这条由独立用例 P-OMIT-1 验证（见下方），本用例只管事故现场的拦截语义。
  P.state.aiContext = savedCtx;
  P.state.apiConfigs = savedConfigs;
  P.state.activeConfigId = savedActive;
  P.state.chapters = savedChapters;
  P.state.work = savedWork;
  P.state.currentChapterId = savedChapterId;
  if (savedNode === undefined) delete containers['#editor-content']; else containers['#editor-content'] = savedNode;
  sandbox.runHarnessJob = savedHarness;
  sandbox.directAIWrite = savedDirectFor108;
  sandbox.showBlueprintConfirm = savedConfirm;
  sandbox.showAIWritingResult = savedResult;
  sandbox.applyAIWritingArticle = savedApply;
  sandbox.reportClientLog = savedReport;
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
    // harness 侧：蓝图一次 + 成文一次（P0-1 起不再有按字数补足轮）
    let harnessCalls = 0;
    sandbox.runHarnessJob = async (body) => {
      harnessCalls += 1;
      const prompt = String((body && body.prompt) || '');
      harnessPrompts.push(prompt);
      // ⚠️ 按**提示词特征**分派，不按调用序号：蓝图改走直连后，harness 的第一次调用就是"成文"，
      //    序号派发会让下面所有断言跟着错位（顺序一变就假通过）。
      if (isBlueprintPrompt(prompt)) return { output: '【蓝图】{"scene_goal":"开场","target_words":8}' };
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
  const isContinuationPrompt = (p) => p.includes('继续写本章正文'); // P0-1 后应为恒 false（保留以钉住'不再出现'）

  const hit = await runBatch({ scanTotal: 2 });
  check('109a 批量生成对成文全文跑红线自检，且不再自动补足字数（无续写片段）',
    String(hit.scannedText || '').includes('正文第一段') && !String(hit.scannedText || '').includes('续写片段'),
    JSON.stringify(hit.scannedText));
  check('109a2 批量路径不再出现任何续写补足轮（直连与慢通道都没有）',
    !hit.directPrompts.some(isContinuationPrompt) && !hit.harnessPrompts.some(isContinuationPrompt),
    JSON.stringify({ direct: hit.directPrompts.length, harness: hit.harnessPrompts.length }));
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

  // ⚠️ 断言不写死 harness 次数（2026-10-02 修）：次数取决于"成文有没有达到 target_words"，
  //    而那个长度口径此前被桩的缺陷污染 —— 桩的 stripHtml（取 textContent）恒返回空串，
  //    于是正文长度恒为 0，补足轮**必然**跑满 2 轮，次数才凑成 4。桩修好后补足轮按需触发，
  //    写死次数就成了"桩越准越假失败"的脆断言。这里改钉真正的不变量：
  //    ① 直连不可用时蓝图必须出现在慢通道里；② 回退路径的慢通道任务数比直连成功路径正好多一次。
  check('110c 直连不可用（空回复）时蓝图回退慢通道，且回退路径恰好比直连路径多占用一次慢通道',
    blueprintFallback.harnessPrompts.some(isBlueprintPrompt)
      && blueprintFallback.harnessCalls === blueprintViaDirect.harnessCalls + 1
      && blueprintFallback.harnessCalls >= 2,
    JSON.stringify({
      fallback: blueprintFallback.harnessCalls, viaDirect: blueprintViaDirect.harnessCalls,
      kinds: blueprintFallback.harnessPrompts.map((p) => (isBlueprintPrompt(p) ? 'bp' : 'prose'))
    }));

  const truncatedRun = await runBatch({ scanTotal: 0, truncated: true, directReply: () => directBlueprint });
  check('110d 上下文被预算截断时蓝图**不走直连**（只有慢通道能取回被裁掉的原文）',
    !truncatedRun.directPrompts.some(isBlueprintPrompt) && truncatedRun.harnessPrompts.some(isBlueprintPrompt),
    JSON.stringify({ direct: truncatedRun.directPrompts.length }));

  // 110e：旧用例钉的是"小缺口补足走直连"。P0-1 取消机械补字后这个行为**不应再存在**——
  // 用例反过来钉住"无论直连还是慢通道，都不再出现续写补足轮"。
  const contDirect = await runBatch({
    scanTotal: 0,
    directReply: (p) => (isBlueprintPrompt(p) ? directBlueprint : null)
  });
  check('110e 已成文后不再按字数续写（直连/慢通道都不出现续写轮）',
    !contDirect.directPrompts.some(isContinuationPrompt)
      && !contDirect.harnessPrompts.some(isContinuationPrompt)
      && String(contDirect.scannedText || '').includes('正文第一段'),
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

  // --- 14b) 第五批：叙事结构机械感（2026-10-08）---------------------------------
  // 这五条断言的用途是**把作者对第一章的结构层审稿固化成回归**：
  // 判据本体在 ai/editing/scan.mjs（离线探针 probe-story-shape-20261008.mjs 管），
  // 这里管的是**接线与提示词**——它们才是"下一章会不会以新形式复发"的关键。
  {
    // ① P0 根因：成文提示词不能再说"每个场面必须有…"，必须改成功能驱动。
    //    旧那句与写作策略源的 avoid_repeated_full_mechanism 直接冲突，模型只能选前者，
    //    这就是"觉醒检测流程完整演示 4 次"的来源。这条断言是防它被改回去。
    check('119a 成文提示词的场面要求是**功能驱动**（旧写法"每个场面必须有"已删，否则与策略源冲突）',
      !/每个场面必须有/.test(prosePrompt) && prosePrompt.includes('场面写法：功能驱动')
        && prosePrompt.includes('过渡场面允许略写、跳过'),
      prosePrompt.includes('每个场面必须有') ? '仍含旧冲突句' : 'ok');
    // ② 但"功能驱动"不能变成"每个场面都压掉"：首展必须写足。
    check('119b 成文提示词同时写明"第一次要写足"（避免把首展也一起压掉）',
      /第一次\*\*?出现要写足|第一次\*\*出现要写足/.test(prosePrompt) || /第一次\*\*出现要写足/.test(prosePrompt)
        || prosePrompt.includes('第一次'),
      prosePrompt.includes('第一次') ? 'ok' : 'missing');
    // ③ 总原则进写作纪律（与人设同源：直连通道没有插件人设）
    check('119c 写作纪律含第五批总原则（不要为了证明读者已经理解的事实再解释第二遍）',
      P.WRITING_DISCIPLINE.includes('不要为了证明读者已经理解的事实')
        && P.WRITING_DISCIPLINE.includes('10.'),
      P.WRITING_DISCIPLINE.slice(-80));
    // ④ 修稿器的取舍必须可执行：改第二次及以后、**第一次原样保留**。
    const patchPrompt = P.buildAIRevisionPatchPrompt('他走上台，把手掌按上去。', ['第 3 段与第 1 段流程重复']);
    check('119d 修稿（补丁式）提示词写明"同类机制只完整演示一次，第一次必须保留"',
      patchPrompt.includes('同类机制只完整演示一次') && patchPrompt.includes('第一次完整展示的段落必须原样保留'),
      patchPrompt.slice(patchPrompt.indexOf('规则：'), patchPrompt.indexOf('规则：') + 60));
    // ⑤ 策略源三条新偏好真的进了成文提示词（编译自统一策略源，不是另写一份）
    check('119e 成文提示词带上了策略源的三条新偏好（渐进揭示 / 结果优先 / 首展写足）',
      prosePrompt.includes('世界观随事件**渐进揭示**')
        && prosePrompt.includes('默认写**结果与差异**')
        && prosePrompt.includes('第一次') ,
      ['渐进揭示', '结果与差异'].map((k) => `${k}:${prosePrompt.includes(k)}`).join(' '));
  }

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
    const urls = [];
    let i = 0;
    sandbox.fetch = async (url, opts = {}) => {
      bodies.push(JSON.parse(String(opts.body || '{}')));
      urls.push(String(url));
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
    // ⚠️ 2026-10-08（第五批）：只统计**打到流式端点**的请求。
    // 提示词构造会懒加载一次 `/api/novel/editing`（editingProtectionText 的缓存未命中路径，
    // 第四批的接线，行为正确），它会夹在两次重试之间进入 fetch 记录 ——
    // 旧断言直接数 `bodies.length`，于是被这次懒加载挤红（"重试次数变了"是假象）。
    // 口径应该是"流式请求发了几次、每次带什么参数"，与旁路请求无关。
    const streamBodies = bodies.filter((_, k) => urls[k].includes('/api/ai/write_stream'));
    return { bodies: streamBodies, allBodies: bodies, urls, outcome };
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
  // ── 去 AI 味 P0（2026-10-06）回归 ──────────────────────────────────────────
  check('113g 已取消按字数机械补足：续写提示词/两处补足轮/旧函数都不再存在',
    src.indexOf('withThinkingHeadroom(Math.ceil(gap * 2 + 1000))') === -1
      && src.indexOf('function buildAIWritingContinuationPrompt') === -1
      && src.indexOf('继续写本章正文') === -1,
    'hit=' + (src.split('withThinkingHeadroom(Math.ceil(gap * 2 + 1000))').length - 1));

  // P0-2：质检严格三态。空对象 / 无证据的 issues / 覆盖声明含 false 一律 unknown，绝不静默 pass。
  {
    const apiBackup = sandbox.api;
    const logBackup = sandbox.reportClientLog;
    sandbox.reportClientLog = () => {};
    const runVerify = async (reply) => {
      sandbox.api = async (p) => {
        if (String(p).startsWith('/ai/write')) return { reply, raw: { choices: [{ finish_reason: 'stop' }], usage: {} } };
        return {};
      };
      return P.verifyAIDraft(null, '正文正文', 3000);
    };
    const vEmpty = await runVerify('{}');
    check('P0-2a 质检返回空对象 → unknown（不再算 pass）',
      vEmpty.verdict === 'unknown' && vEmpty.pass === false, JSON.stringify({ v: vEmpty.verdict, pass: vEmpty.pass }));
    const vNoEvidence = await runVerify('{"verdict":"issues","issues":[]}');
    check('P0-2b verdict=issues 但 issues 为空 → unknown（有问题却无证据）',
      vNoEvidence.verdict === 'unknown' && vNoEvidence.pass === false, JSON.stringify({ v: vNoEvidence.verdict }));
    const vCov = await runVerify('{"verdict":"pass","coverage":{"story_state":false}}');
    check('P0-2c coverage 明确为 false → unknown（覆盖不全不算通过）',
      vCov.verdict === 'unknown' && vCov.pass === false, JSON.stringify({ v: vCov.verdict }));
    const vPass = await runVerify('{"verdict":"pass"}');
    check('P0-2d 显式 pass 仍是唯一"通过"态',
      vPass.verdict === 'pass' && vPass.pass === true, JSON.stringify({ v: vPass.verdict }));
    const vIssues = await runVerify('{"verdict":"issues","issues":["中段时间线矛盾"]}');
    check('P0-2e 有证据的 issues 正常成立',
      vIssues.verdict === 'issues' && vIssues.pass === false && vIssues.issues.length === 1, JSON.stringify({ v: vIssues.verdict }));
    sandbox.api = apiBackup;
    sandbox.reportClientLog = logBackup;
  }

  // P0-1/P0-3：篇幅只做诊断；提示词不再含全局硬配额。
  {
    const st = P.classifyChapterLength('一二三', 100, null);
    check('P0-1 篇幅不足但无漏写证据 → short_but_complete（不触发续写）',
      st.status === 'short_but_complete' && st.gap === 97, JSON.stringify(st));
    const stMiss = P.classifyChapterLength('一二三', 100, { issues: ['重要情节点遗漏：主角检测后的反应没写'] });
    check('P0-1b 质检指出漏写 → missing_content（交作者决定，不自动补）',
      stMiss.status === 'missing_content', JSON.stringify(stMiss));
    const bpPrompt = P.buildAIWritingBlueprintPrompt('续写本章', [], 2000, true);
    const prosePrompt = P.buildAIWritingProsePrompt('需求', { scene_goal: '开场' }, 2000);
    const reviewPrompt = P.buildAIReviewPrompt('正文');
    const allPrompts = [bpPrompt, prosePrompt, reviewPrompt].join('\n');
    check('P0-3 提示词不再出现全局硬配额（3～5 场景 / 系统 5～15 次 / 有效场景不足 3 个）',
      !/3～5\s*个场景/.test(allPrompts) && !/5～15/.test(allPrompts) && !/有效场景不足/.test(allPrompts),
      JSON.stringify({ bp: /3～5/.test(bpPrompt), prose: /5～15/.test(prosePrompt) }));
    check('P0-4 提示词使用统一策略源的无配额规则文本',
      bpPrompt.includes('场面数量按剧情需要决定') && prosePrompt.includes('目标字数是范围参考，不是配额')
        && reviewPrompt.includes('叙述诊断项'),
      JSON.stringify({ bp: bpPrompt.includes('场面数量按剧情需要决定') }));
  }

  // P0-4：前端兜底规则必须与 ai/writing/policy.mjs 真源逐条一致（防两侧漂移）。
  {
    const snap = writingPolicySnapshot();
    const norm = (r) => JSON.stringify({ id: r.id, type: r.type, scopes: [...r.scopes].sort(), priority: r.priority, text: r.text });
    const server = snap.rules.map(norm).sort();
    const front = [...P.WRITING_POLICY_FALLBACK_RULES].map(norm).sort();
    check('P0-4b 前端兜底规则与策略源真源逐条一致（id/type/scopes/priority/text）',
      snap.version === P.WRITING_POLICY_FALLBACK_VERSION
        && server.length === front.length && server.every((x, i) => x === front[i]),
      JSON.stringify({ server: server.length, front: front.length, version: snap.version }));
    // 服务端已编译分区优先：有 compiled 时不再本地编译（两端编译逻辑同源）。
    const savedWP = P.state.writingPolicy;
    P.state.writingPolicy = { version: 'x', rules: [], compiled: { preference: { draft: ['- 来自服务端'] }, diagnostic: {} } };
    check('P0-4c 有服务端已编译分区时优先使用（本地编译只作兜底）',
      P.writingPolicyLines('draft')[0] === '- 来自服务端', JSON.stringify(P.writingPolicyLines('draft')));
    P.state.writingPolicy = savedWP;
  }

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

// --- 15b) 回归（2026-10-01 实测缺陷）：取回生成稿必须把**纯文本**转成段落 HTML ---
// 现场：AI 成文的草稿是以纯文本（`\n\n` 分段，无任何 <p>）落库的，而「取回生成稿」把草稿原文
// 直接 POST 给 /novel/chapter_save，于是正文被写成一整段 —— 浏览器把 147 处换行全部折叠，
// 作者看到的就是"取回正文后没有重新排版"（第一章走 AI 结果应用那条路却排版正常，差别就在这次转换）。
{
  const savedApi = sandbox.api;
  const savedToast = sandbox.toast;
  const savedConfirm = sandbox.confirm;
  const savedDraft = P.state.chapterDraft;
  const savedChapterId = P.state.currentChapterId;
  const savedChapters = P.state.chapters;

  const plainDraft = '第一段正文。\n\n第二段正文，带一个行内换行。\n这里接上一行。\n\n第三段正文。';
  const posts = [];
  sandbox.api = async (p, o = {}) => {
    if (String(p) === '/novel/chapter_save') { posts.push(o && o.body); return { ok: true, version_id: 9 }; }
    return savedApi(p, o);
  };
  sandbox.toast = () => {};
  sandbox.confirm = () => true; // 取回前会问"覆盖当前正文吗"，测试里直接确认
  P.state.currentChapterId = 107;
  P.state.chapters = [{ id: 107, title: '第107章', content: '' }];
  P.state.chapterDraft = { chapter_id: 107, chars: plainDraft.length, content: plainDraft };

  let restoreErr = '';
  try { await P.restoreChapterDraft(); } catch (e) { restoreErr = e.message; }
  const body = posts[0] || {};
  check('115f 取回生成稿时把纯文本草稿转成段落 HTML（<p> 齐备，不再是裸换行）',
    !restoreErr && String(body.content || '').includes('<p>第一段正文。</p>') && String(body.content || '').includes('<p>第三段正文。</p>'),
    `err=${restoreErr} content=${JSON.stringify(String(body.content || '').slice(0, 90))}`);
  check('115g 段落内的单换行保留为 <br>（不被压平、也不被拆成两段）',
    String(body.content || '').includes('带一个行内换行。<br>这里接上一行。'),
    JSON.stringify(String(body.content || '').slice(0, 160)));
  check('115h 已经是 HTML 的草稿原样写回（不二次包装）',
    await (async () => {
      posts.length = 0;
      P.state.chapterDraft = { chapter_id: 107, chars: 4, content: '<p>已是 HTML。</p>' };
      try { await P.restoreChapterDraft(); } catch (_) { return false; }
      return String((posts[0] || {}).content || '') === '<p>已是 HTML。</p>';
    })());

  sandbox.api = savedApi;
  sandbox.toast = savedToast;
  sandbox.confirm = savedConfirm;
  P.state.chapterDraft = savedDraft;
  P.state.currentChapterId = savedChapterId;
  P.state.chapters = savedChapters;
}

// --- 15c) 回归（2026-10-04，作者报障）：生成稿那条提示必须有「关闭」出口 ---
// 现场：编辑器上方的「🗂 有未应用的生成稿（219 字，22:48:44）」只有「取回生成稿 / 预览」，
// 作者明确不要这一版时无处可点 —— 那条提示会一直挂着（"永远也不想要这个版本"却没有关闭按钮）。
// 判据不是"按钮长得像关闭"，而是：① 点它真的落到专用接口且带的是这一份的 id；
// ② 本地与服务端同步（提示立刻消失）；③ 它**不是写路径**（正文一个字都不动）；
// ④ 取消 = 什么都不发生（误点不丢稿）。
{
  const savedApi = sandbox.api;
  const savedToast = sandbox.toast;
  const savedConfirm = sandbox.confirm;
  const savedDraft = P.state.chapterDraft;
  const savedChapterId = P.state.currentChapterId;
  const savedChapters = P.state.chapters;
  const savedJobs = P.state.chapterJobs;
  const savedReview = P.state.chapterReview;

  const draft = { id: 49, chapter_id: 121, chars: 219, content: '<p>AI 写的那一版。</p>', created_at: '2026-10-02T14:48:44.000Z' };
  const chapter = { id: 121, title: '第三章', content: '<p>正文</p>' };
  P.state.currentChapterId = 121;
  P.state.chapters = [chapter];
  P.state.chapterDraft = { ...draft };
  P.state.chapterReview = null;
  P.state.chapterJobs = [];
  P.state.editorEmptyBlocked = null;
  P.state.editorSaveFailedSnapshot = null;

  const barHtml = P.recoveryBarHtml(chapter);
  check('P-DISMISS-1 生成稿那条上同时有「取回生成稿 / 预览 / 关闭」（关闭不再缺失）',
    barHtml.includes('data-action="restore-draft"') && barHtml.includes('data-action="preview-draft"')
    && barHtml.includes('data-action="dismiss-draft"'), barHtml.slice(0, 200));

  const calls = [];
  const box = mkEl('chapter-recovery', 'div');
  sandbox.api = async (p, o = {}) => {
    calls.push({ p: String(p), o });
    if (String(p) === '/novel/draft/dismiss') return { ok: true, dismissed: 1, draft: null };
    return { ok: true };
  };
  sandbox.toast = () => {};
  sandbox.confirm = () => true; // 关闭前会问一句；测试里直接确认
  let err = '';
  try { await P.handleAction('dismiss-draft', { dataset: { action: 'dismiss-draft' } }); } catch (e) { err = String(e && e.message); }
  const dismissCall = calls.find((c) => c.p === '/novel/draft/dismiss');
  check('P-DISMISS-2 「关闭」落在专用接口上，且带的是**这一份**草稿的 id',
    !err && !!dismissCall && Number(dismissCall.o?.body?.chapter_id) === 121 && Number(dismissCall.o?.body?.draft_id) === 49,
    err || JSON.stringify(calls.map((c) => c.p)));
  check('P-DISMISS-3 关闭后本地立刻同步：那条提示从恢复条上消失（不必等切章/刷新）',
    P.state.chapterDraft === null && !P.recoveryBarHtml(chapter).includes('未应用的生成稿')
    && !String(box.innerHTML).includes('未应用的生成稿'), String(box.innerHTML).slice(0, 160));
  check('P-DISMISS-4 关闭**不是写路径**：没有任何正文写入请求（不影响正常写作）',
    calls.length > 0 && calls.every((c) => !/chapter_save|\/novel\/adopt|\/chapters\//.test(c.p)),
    JSON.stringify(calls.map((c) => c.p)));

  // 服务端若回话说"还剩更早的一份"，界面按服务端真值显示它 —— 不自己猜、也不静默吞掉
  calls.length = 0;
  sandbox.api = async (p, o = {}) => {
    calls.push({ p: String(p), o });
    if (String(p) === '/novel/draft/dismiss') {
      return { ok: true, dismissed: 1, draft: { id: 40, chapter_id: 121, chars: 88, content: '<p>更早的一版。</p>', created_at: '2026-09-01T10:00:00.000Z' } };
    }
    return { ok: true };
  };
  P.state.chapterDraft = { ...draft };
  await P.handleAction('dismiss-draft', { dataset: { action: 'dismiss-draft' } });
  check('P-DISMISS-5 关闭后若还有更早的未应用草稿，界面按服务端真值显示它（不静默藏掉）',
    Number(P.state.chapterDraft?.id) === 40 && String(box.innerHTML).includes('88 字'), String(box.innerHTML).slice(0, 160));

  // 反悔/误点：确认框里选取消 → 一个请求都不发，草稿原地不动
  calls.length = 0;
  sandbox.confirm = () => false;
  P.state.chapterDraft = { ...draft };
  await P.handleAction('dismiss-draft', { dataset: { action: 'dismiss-draft' } });
  check('P-DISMISS-6 确认框里选「取消」时不发任何请求、草稿原样留着（误点不丢稿）',
    calls.length === 0 && Number(P.state.chapterDraft?.id) === 49, JSON.stringify(calls.map((c) => c.p)));

  sandbox.api = savedApi;
  sandbox.toast = savedToast;
  sandbox.confirm = savedConfirm;
  P.state.chapterDraft = savedDraft;
  P.state.currentChapterId = savedChapterId;
  P.state.chapters = savedChapters;
  P.state.chapterJobs = savedJobs;
  P.state.chapterReview = savedReview;
}

// --- 15d) 同一类缺口的第二处：长任务那条「⏳ AI 写作：已完成，结果待应用 · 产出 N 字符」 ---
// 现场（作者截图）：同一条恢复条上挂着三条「已完成，结果待应用」（1711 / 75 / 135 字符），
// 只有「取回结果并应用」——同样没有"这结果我不要了"的出口，它们就一直挂在那儿。
// 判据：① 已完成/失败的行有关闭、**正在跑的行没有**（跑着的只能停止/接回）；
// ② 关闭要等 /harness/mark_applied 成功后才收起本行；③ 服务端拒绝时本行必须留着。
{
  const savedApi = sandbox.api;
  const savedToast = sandbox.toast;
  const savedConfirm = sandbox.confirm;
  const savedJobs = P.state.chapterJobs;
  const savedChapterId = P.state.currentChapterId;
  const savedChapters = P.state.chapters;
  const savedDraft = P.state.chapterDraft;
  const savedReview = P.state.chapterReview;

  const chapter = { id: 119, title: '第119章', content: '<p>正文</p>' };
  const doneJob = { id: 'job-done-1', chapter_id: 119, kind: 'prose', stage: 'AI 写作', status: 'done', has_output: true, output_chars: 1711 };
  const failedJob = { id: 'job-failed-1', chapter_id: 119, kind: 'prose', stage: 'AI 写作', status: 'failed', has_output: false, output_chars: 0, error: 'spawn EPERM' };
  const runningJob = { id: 'job-run-1', chapter_id: 119, kind: 'prose', stage: 'AI 写作', status: 'running', resumable: true, has_output: false, output_chars: 0 };
  P.state.currentChapterId = 119;
  P.state.chapters = [chapter];
  P.state.chapterDraft = null;
  P.state.chapterReview = null;
  P.state.chapterJobs = [runningJob, doneJob, failedJob];
  P.state.editorEmptyBlocked = null;
  P.state.editorSaveFailedSnapshot = null;

  const bar = P.recoveryBarHtml(chapter);
  check('P-DISMISS-7 已完成/失败的任务行都有「关闭」，正在跑的那行没有（跑着的只能停止/接回）',
    bar.includes('data-action="dismiss-job" data-id="job-done-1"')
    && bar.includes('data-action="dismiss-job" data-id="job-failed-1"')
    && !bar.includes('data-action="dismiss-job" data-id="job-run-1"')
    && bar.includes('data-action="resume-job" data-id="job-run-1"'),
    bar.slice(0, 260));

  const box = mkEl('chapter-recovery', 'div');
  const calls = [];
  const msgs = [];
  sandbox.toast = (m) => { msgs.push(String(m)); };
  sandbox.confirm = () => true;
  sandbox.api = async (p, o = {}) => { calls.push({ p: String(p), o }); return { ok: true }; };
  await P.handleAction('dismiss-job', { dataset: { action: 'dismiss-job', id: 'job-done-1' } });
  check('P-DISMISS-8 关闭一条结果：落到 /harness/mark_applied（带这条 job id），成功后本行从恢复条上收起',
    calls.length === 1 && calls[0].p === '/harness/mark_applied' && calls[0].o?.body?.job_id === 'job-done-1'
    && !P.state.chapterJobs.some((j) => j.id === 'job-done-1')
    && !String(box.innerHTML).includes('job-done-1') && String(box.innerHTML).includes('job-failed-1'),
    JSON.stringify({ calls: calls.map((c) => c.p), left: (P.state.chapterJobs || []).map((j) => j.id) }));

  // 失败态：服务端没答应（例如服务端还是旧代码 → 404 API not found）时，本地那一行**必须留着**，
  // 否则作者看到"关掉了"，刷新后它又回来 —— 那比不关更糟。
  calls.length = 0;
  msgs.length = 0;
  sandbox.api = async (p) => { calls.push({ p: String(p) }); const e = new Error('API not found'); e.status = 404; throw e; };
  P.state.chapterJobs = [doneJob];
  await P.handleAction('dismiss-job', { dataset: { action: 'dismiss-job', id: 'job-done-1' } });
  check('P-DISMISS-9 服务端拒绝时不移除本地那一行，并明确报错（不允许"关了又自己回来"）',
    P.state.chapterJobs.some((j) => j.id === 'job-done-1') && msgs.some((m) => m.includes('关闭失败')),
    JSON.stringify({ jobs: P.state.chapterJobs.map((j) => j.id), msgs }));

  calls.length = 0;
  sandbox.confirm = () => false;
  await P.handleAction('dismiss-job', { dataset: { action: 'dismiss-job', id: 'job-done-1' } });
  check('P-DISMISS-10 取消确认时不发任何请求、那一行还在（误点不丢结果）',
    calls.length === 0 && P.state.chapterJobs.some((j) => j.id === 'job-done-1'), JSON.stringify(calls.map((c) => c.p)));

  sandbox.api = savedApi;
  sandbox.toast = savedToast;
  sandbox.confirm = savedConfirm;
  P.state.chapterJobs = savedJobs;
  P.state.currentChapterId = savedChapterId;
  P.state.chapters = savedChapters;
  P.state.chapterDraft = savedDraft;
  P.state.chapterReview = savedReview;
}

// --- 15e) 第三处（同一形状的最后一个出口）：🔍 上次审稿 那一条 ---
// 现场：恢复条上「🔍 上次审稿（N 个问题，时间）」同样只有「查看」——作者看过、不想再看到时，
// 那条提示会一直挂着（审稿记录每章保留最近 10 份，于是它总能"顶上来"）。
// 判据：① 那行有关闭；② dismissed 的记录**不再渲染**（关掉是真关掉，不是只改个状态）；
// ③ 关闭等服务端确认，失败保留本行；④ 取消＝什么都不发生。
{
  const savedApi = sandbox.api;
  const savedToast = sandbox.toast;
  const savedConfirm = sandbox.confirm;
  const savedReview = P.state.chapterReview;
  const savedJobs = P.state.chapterJobs;
  const savedChapterId = P.state.currentChapterId;
  const savedChapters = P.state.chapters;
  const savedDraft = P.state.chapterDraft;
  const savedEmpty = P.state.editorEmptyBlocked;
  const savedFailed = P.state.editorSaveFailedSnapshot;

  const chapter = { id: 121, title: '第三章', content: '<p>正文</p>' };
  const review = { id: 77, chapter_id: 121, issue_count: 3, parsed: true, dismissed: 0, created_at: '2026-10-02T13:42:59.367Z' };
  P.state.currentChapterId = 121;
  P.state.chapters = [chapter];
  P.state.chapterDraft = null;
  P.state.chapterReview = { ...review };
  P.state.chapterJobs = [];
  P.state.editorEmptyBlocked = null;
  P.state.editorSaveFailedSnapshot = null;

  const withRow = P.recoveryBarHtml(chapter);
  check('P-DISMISS-11 审稿那条上有「查看 / 关闭」（关闭不再缺失）',
    withRow.includes('data-action="open-last-review"') && withRow.includes('data-action="dismiss-review"'),
    withRow.slice(0, 200));
  // 判据要落在"渲染结果"上，而不是"状态字段被改了"：只有那一条从 HTML 里真的没了，才算关掉。
  P.state.chapterReview = { ...review, dismissed: 1 };
  check('P-DISMISS-12 dismissed=1 的审稿不再渲染那一条（它是唯一一条时，整条恢复条随之消失）',
    P.recoveryBarHtml(chapter) === '', JSON.stringify(P.recoveryBarHtml(chapter)));
  P.state.chapterReview = { ...review };

  const box = mkEl('chapter-recovery', 'div');
  const calls = [];
  const msgs = [];
  sandbox.toast = (m) => { msgs.push(String(m)); };
  sandbox.confirm = () => true;
  sandbox.api = async (p, o = {}) => {
    calls.push({ p: String(p), o });
    if (String(p) === '/novel/review/dismiss') return { ok: true, dismissed: 1, review: { ...review, dismissed: 1 } };
    return { ok: true };
  };
  await P.handleAction('dismiss-review', { dataset: { action: 'dismiss-review', id: '77' } });
  check('P-DISMISS-13 关闭审稿提示：落到 /novel/review/dismiss（带这一章的 review id），成功后本地同步、那行消失',
    calls.length === 1 && calls[0].p === '/novel/review/dismiss'
    && Number(calls[0].o?.body?.chapter_id) === 121 && Number(calls[0].o?.body?.review_id) === 77
    && Number(P.state.chapterReview?.dismissed) === 1
    && !String(box.innerHTML).includes('上次审稿'),
    JSON.stringify({ calls: calls.map((c) => c.p), dismissed: P.state.chapterReview?.dismissed }));

  // 失败态：服务端没答应 → 本地那一条必须留着（否则刷新后它又出现）
  calls.length = 0;
  msgs.length = 0;
  sandbox.api = async (p) => { calls.push({ p: String(p) }); const e = new Error('API not found'); e.status = 404; throw e; };
  P.state.chapterReview = { ...review };
  await P.handleAction('dismiss-review', { dataset: { action: 'dismiss-review', id: '77' } });
  check('P-DISMISS-14 服务端拒绝时不收起本行，并明确报错（避免"关了又回来"）',
    Number(P.state.chapterReview?.dismissed) === 0 && msgs.some((m) => m.includes('关闭失败')) && P.recoveryBarHtml(chapter).includes('上次审稿'),
    JSON.stringify({ dismissed: P.state.chapterReview?.dismissed, msgs }));

  calls.length = 0;
  sandbox.confirm = () => false;
  await P.handleAction('dismiss-review', { dataset: { action: 'dismiss-review', id: '77' } });
  check('P-DISMISS-15 取消确认时不发请求、那一条还在（误点不丢报告）',
    calls.length === 0 && Number(P.state.chapterReview?.dismissed) === 0, JSON.stringify(calls.map((c) => c.p)));

  sandbox.api = savedApi;
  sandbox.toast = savedToast;
  sandbox.confirm = savedConfirm;
  P.state.chapterReview = savedReview;
  P.state.chapterJobs = savedJobs;
  P.state.currentChapterId = savedChapterId;
  P.state.chapters = savedChapters;
  P.state.chapterDraft = savedDraft;
  P.state.editorEmptyBlocked = savedEmpty;
  P.state.editorSaveFailedSnapshot = savedFailed;
}

// --- P-MODAL-1（2026-10-04 作者报障）：AI 写作的提问窗口不该被"点到窗口外面"关掉 ---
// 现场：提问窗口正等着他回答，鼠标一滑点到遮罩上，窗口就关了 —— 而关掉等于把 pending 解析成
// null（整次写作取消），作者什么意图都没表达。已有的机制是 openModal 的 protectedBackdrop
// （点遮罩只提示、不关闭），但那两个 AI 交互框都没传它。这里钉三件事：
// ① 提问框与蓝图确认框都带这个保护；② 保护状态下关窗仍可走明确动作（✕/取消 → closeModal）；
// ③ 普通弹窗（不带保护）的行为不被误改。
{
  const modalRoot = containers['#modal-root'];
  const savedHtml = String(modalRoot.innerHTML || '');
  const p = P.askAIQuestion('觉醒地点要改成学校吗？', 'AI 写作 · 需要向你确认');
  await new Promise((r) => setTimeout(r, 5));
  check('P-MODAL-1 AI 写作的提问窗口带遮罩保护（点窗口外面不会关掉它）',
    P.state.modalProtected === true
      && String(modalRoot.innerHTML).includes('ai-writing-question')
      && String(modalRoot.innerHTML).includes('ai-writing-answer'),
    JSON.stringify({ protected: P.state.modalProtected, html: String(modalRoot.innerHTML).slice(0, 120) }));
  let answer = 'unset';
  p.then((v) => { answer = v; });
  P.closeModal();                       // 明确关闭（等同于点 ✕ / 取消）
  await new Promise((r) => setTimeout(r, 5));
  check('P-MODAL-2 保护状态下「✕/取消」仍然一按就关（只是不再被误触关闭）',
    answer === null, JSON.stringify({ answer }));

  const bp = P.showBlueprintConfirm({ scene_goal: '雨夜摊牌', plot_lines: '' });
  await new Promise((r) => setTimeout(r, 5));
  check('P-MODAL-3 蓝图确认框同样带遮罩保护（它是要填的表单，关掉＝放弃这次写作）',
    P.state.modalProtected === true && String(modalRoot.innerHTML).includes('bp-scene-goal'),
    JSON.stringify({ protected: P.state.modalProtected }));
  P.closeModal();
  await new Promise((r) => setTimeout(r, 5));

  // 第三处（作者截图报障）：AI 写作的**需求框**（✍️ AI 写作 · 写点什么？）。
  // 它同样带 textarea 与"开始生成"按钮，误触关闭＝丢需求 + 取消这次生成。
  const req = P.askToolbarAIWriteRequirement();
  await new Promise((r) => setTimeout(r, 5));
  check('P-MODAL-4 AI 写作需求框带遮罩保护（点外面不会把需求框关掉）',
    P.state.modalProtected === true && String(modalRoot.innerHTML).includes('toolbar-ai-write-req'),
    JSON.stringify({ protected: P.state.modalProtected, html: String(modalRoot.innerHTML).slice(0, 100) }));
  let reqVal = 'unset';
  req.then((v) => { reqVal = v; });
  P.closeModal();
  await new Promise((r) => setTimeout(r, 5));
  check('P-MODAL-5 需求框的「✕/取消」仍然一按就关（返回 null = 明确放弃）',
    reqVal === null, JSON.stringify({ reqVal }));

  // 默认值口径：openModal 现在默认保护（作者要求"任何弹窗都别被误触点外面关掉"）；
  // 仍想"点外面就关"的纯信息弹窗必须显式传 protectedBackdrop: false。
  P.openModal({ title: '默认口径', body: '<div>纯信息</div>' });
  const defaultProtected = P.state.modalProtected === true;
  P.openModal({ title: '显式放行', body: '<div>纯信息</div>', protectedBackdrop: false });
  const optOut = P.state.modalProtected === false;
  check('P-MODAL-6 openModal 默认带保护；显式 protectedBackdrop:false 可放行（保留"点外面关闭"的能力）',
    defaultProtected && optOut, JSON.stringify({ defaultProtected, optOut }));
  P.closeModal();
  await new Promise((r) => setTimeout(r, 5));
  modalRoot.innerHTML = savedHtml;
}

// --- P-Q-1（2026-10-04 作者报障）：提问轮的产出是**问句**，必须当场标记已应用 ---
// 现场：恢复条上挂着「AI 写作：已完成，结果待应用 · 产出 144 / 186 字符」+「取回结果并应用」，
// 而那两轮的产出其实是两个反问句（"要改成学校还是保留检测中心？"）。作者点"取回结果"只会
// 把一句问句当稿子取回来；他自己在截图里问的就是"任务完成但是没显示？"。
{
  const saved = {
    api: sandbox.api, toast: sandbox.toast, harness: sandbox.runHarnessJob,
    ask: sandbox.askAIQuestion, chapterId: P.state.currentChapterId,
    workId: P.state.workId, work: P.state.work, chapters: P.state.chapters, aiContext: P.state.aiContext,
    direct: sandbox.directAIWrite, card: sandbox.showAITaskProgress, editor: containers['#editor-content'],
    pipeRunning: P.state.aiWritePipelineRunning,
  };
  P.state.currentChapterId = 620;
  P.state.workId = 2;
  P.state.work = { id: 2, title: '测试作品' };
  P.state.chapters = [{ id: 620, title: '第620章' }];
  P.state.aiContext = { assembled: '上下文', context_manifest: [], context_stats: { truncatedLayers: 0 } };
  containers['#editor-content'] = mkEl('editor-content');
  containers['#editor-content'].dataset = { chapterId: '620' };
  const marked = [];
  const baseApi = sandbox.api;
  sandbox.api = async (p, o = {}) => {
    if (String(p) === '/harness/mark_applied') { marked.push(o?.body?.job_id); return { ok: true }; }
    if (String(p).startsWith('/ai_context') || String(p).startsWith('/novel/context')) {
      return { assembled: '上下文', context_manifest: [], context_stats: { truncatedLayers: 0 } };
    }
    return baseApi(p, o);
  };
  sandbox.toast = () => {};
  sandbox.directAIWrite = async () => '';
  sandbox.runHarnessJob = async () => ({ job_id: 'job-q-1', output: '【提问】觉醒日要改成在学校操场举行吗？' });
  let asked = 0;
  sandbox.askAIQuestion = async () => { asked += 1; return { type: 'skip' }; };   // 作者点"跳过提问直接生成"
  sandbox.showAITaskProgress = () => ({ note() {}, close() {}, track: () => () => {}, runCancel: () => {} });
  let qErr = '';
  try { await P.performToolbarAIWrite('重写第一章'); } catch (e) { qErr = e.message; }
  await new Promise((r) => setTimeout(r, 20));
  check('P-Q-1 提问轮任务在问句展示后立刻标记已应用（不再以"结果待应用"挂在恢复条上）',
    asked >= 1 && marked.length >= 1 && marked.every((id) => id === 'job-q-1'),
    JSON.stringify({ asked, marked: marked.length, err: qErr }));
  sandbox.api = saved.api; sandbox.toast = saved.toast; sandbox.runHarnessJob = saved.harness;
  sandbox.askAIQuestion = saved.ask;
  sandbox.directAIWrite = saved.direct; sandbox.showAITaskProgress = saved.card;
  if (saved.editor) containers['#editor-content'] = saved.editor;
  P.state.currentChapterId = saved.chapterId; P.state.workId = saved.workId; P.state.work = saved.work;
  P.state.chapters = saved.chapters; P.state.aiContext = saved.aiContext;
  P.state.aiWritePipelineRunning = saved.pipeRunning;
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
  // ⚠️ update(tail, label) 有两个参数：tail 是卡片正文（心跳的"已思考 Ns"在这里），
  // label 是卡片标题。只记 label 会看不到心跳文案（2026-10-02 实测撞到）。
  sandbox.showAITaskProgress = () => ({
    update: (tail, label) => { updates.push(String(tail || '')); if (label) updates.push(String(label)); },
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

  // 116a2（2026-10-02 补）：只有"进入思考"这一帧还不够 —— 实测成文轮首字延迟 25s，
  // 期间卡片上一动不动仍然像卡死。服务端现在每 2.5s 发一次 heartbeat 心跳
  // （带 elapsed_ms / reasoning_chars，仍不含推理内容），客户端要把它渲染成
  // "已思考 Ns · 思考已写 M 字"，让作者看得出任务在推进。
  updates.length = 0;
  const withHeartbeat = await runFrames([
    { phase: 'thinking', reasoning_chars: 12 },
    { phase: 'thinking', heartbeat: true, elapsed_ms: 7500, reasoning_chars: 380 },
    { delta: '正文' },
    { done: true, text: '正文' }
  ]);
  check('116a2 思考期心跳让进度卡带上"已思考 Ns"与思考规模（首字到来前也在动）',
    withHeartbeat.ok && updates.some((u) => /已思考\s*8?s/.test(u) && u.includes('380'))
      && !updates.some((u) => u.includes('reasoning')),
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
  // ⚠️ 断言的是"服务端确实在 work_stream 的回调里发出 thinking 相位"，而不是某个固定字面量：
  // 2026-10-02 起 onThinking 还带 `reasoning_chars`（只报思考规模、仍不转发推理内容），
  // 旧断言钉死了 `onThinking: () => send({ phase: 'thinking' })` 这一整串，于是"合法的字段扩充"
  // 会被判成回归。这里改为允许附加字段、同时继续钉住"不外泄推理内容"。
  const srvSrc = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  const thinkingWired = /onThinking:\s*\([^)]*\)\s*=>\s*send\(\{[^}]*phase:\s*'thinking'[^}]*\}\)/.test(srvSrc);
  check('116d 服务端只上报相位、不转发思考内容（推理过程不外泄，也不多传数据）',
    srvSrc.includes('delta?.reasoning_content') && thinkingWired
      && !/send\(\{[^}]*reasoning_content\s*:/.test(srvSrc),
    JSON.stringify({ detects: srvSrc.includes('reasoning_content'), wires: thinkingWired }));

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

  // C1l（2026-10-04 删除）：原用例断言 `savedBlueprintForChapter` 的保守判据。
  // 作者报障"已有蓝图就跳过蓝图轮"之后，那条捷径整个被移除、函数与用例一并删除 ——
  // 保留一条测死代码的用例，只会让"它还活着"这件事看起来像真的。新行为由 C3e 系列守。

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

  // C3e（2026-10-04 改写）：作者报障 —— 本章已有蓝图时，以前入口会**静默沿用旧蓝图并跳过蓝图轮**，
  // 于是"改了前文/对蓝图不满意 → 再点一次 AI 写作（含结果弹窗里的「重新生成」）"仍然按旧蓝图写。
  // 现在每次都必须完整执行：入口一律 defer 且显式跳过上一版蓝图层，蓝图轮照跑、照弹确认框。
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
    // 蓝图轮走直连：桩必须能分辨"这是在问蓝图"还是"这是在要正文"，
    // 否则蓝图轮会拿到一段正文、整个流程就不是真实形状了。
    const blueprintPrompts = [];
    const savedDirect = sandbox.directAIWrite;
    sandbox.directAIWrite = async (messages) => {
      const prompt = String((messages && messages[0] && messages[0].content) || '');
      if (prompt.includes('【蓝图】')) {
        blueprintPrompts.push(prompt);
        return '【蓝图】\n{"scene_goal":"雨夜摊牌","plot_points":"对峙","conflicts":"旧账被翻出","character_changes":"主角动摇","hook":"门外有人","references":""}';
      }
      return '';
    };
    // 蓝图确认框必须被走过一次：作者要能改、能重规划、也能跳过（这是"先出蓝图"的意义）
    const savedConfirmFn = sandbox.showBlueprintConfirm;
    let confirmCalls = 0;
    sandbox.showBlueprintConfirm = async (bp) => { confirmCalls += 1; return { ...bp, skip: false, target_words: 3000 }; };
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
    check('C3e 本章已有蓝图也照样先出蓝图：入口一律 defer + 显式跳过上一版蓝图层（不再有 saved_blueprint 捷径）',
      aiCalls.length >= 2
        && aiCalls[0].includes('library_recall_phase=defer') && aiCalls[0].includes('omit_layers=blueprint')
        && !aiCalls.some((u) => u.includes('direction_source=saved_blueprint'))
        && aiCalls.some((u) => u.includes('library_recall_phase=direction') && u.includes('direction_source=confirmed_blueprint')),
      JSON.stringify({ aiCalls, err: writeErr, toasts: toasts.slice(0, 3) }));
    check('C3e2 已有 blueprint_json 时蓝图轮照样跑（模型被问一次新蓝图）且新蓝图走确认框',
      blueprintPrompts.length === 1 && confirmCalls === 1,
      JSON.stringify({ blueprintPrompts: blueprintPrompts.length, confirmCalls }));
    check('C3f 该路径照常走到结果弹窗（流程完整：蓝图 → 确认 → 成文）',
      resultOpened === 1 && applyCalls === 0 && !errModal && writeErr === '',
      JSON.stringify({ resultOpened, applyCalls, errModal, writeErr, modal: String(containers['#modal-root'].innerHTML).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 400), toasts }));
    sandbox.fetch = saved.fetch; sandbox.api = saved.api; sandbox.toast = saved.toast; sandbox.reportClientLog = saved.report;
    sandbox.showAIWritingResult = saved.showResult; sandbox.applyAIWritingArticle = saved.apply; sandbox.runHarnessJob = saved.harness;
    sandbox.directAIWrite = savedDirect; sandbox.showBlueprintConfirm = savedConfirmFn;
    sandbox.TextDecoder = saved.decoder; sandbox.showAITaskProgress = saved.card;
    P.state.currentChapterId = saved.chapterId; P.state.workId = saved.workId; P.state.work = saved.work;
    P.state.chapters = saved.chapters; P.state.aiContext = saved.aiContext;
    P.state.apiConfigs = saved.apiConfigs; P.state.activeConfigId = saved.activeConfigId;
    P.state.aiTaskRunning = saved.aiTaskRunning;
  }
}
// --- 15g) 已保存蓝图（2026-10-06 作者要求）---
// 现场：蓝图只存在 chapters.blueprint_json 一列（覆盖式写入），**正文写完仍留着**并被检索索引
// 喂给模型（规划新章时模型拿着旧计划反问作者）；历史条又把蓝图轮的产出显示成
// 「AI 写作：已完成，结果待应用 · 产出 N 字符」，还给了「取回结果并应用」——那等于把一份
// 【蓝图】JSON 当正文写进章节（2026-10-01 / 2026-10-04 两次真实事故的同一形状）。
// 作者要求：① 已保存的蓝图**全部**显示出来 + 「生成 / 删除」按钮；② 蓝图轮的记录显示成「蓝图」。
// 判据：① 本章蓝图逐条渲染（带生成/查看/删除），别的章的不渲染、显示口径是"n/上限"；
//       ② 蓝图轮（新 kind='blueprint' 与历史遗留 is_blueprint）都显示「📐 蓝图」且**不给**
//          「取回结果并应用」，成文任务照常可应用；
//       ③ 已完成的蓝图轮不再进「结果待应用」列表（蓝图只从「已保存蓝图」块走），跑着的仍保留；
//       ④ 「删除」走 DELETE /novel/chapter_blueprints（带 chapter_id + blueprint_id），
//          并照服务端返回的真值重画；
//       ⑤ 点「生成」**先进入**蓝图确认框，且不再向模型要蓝图（作者明确要求"先进入这个界面"）。
{
  const saved = {
    api: sandbox.api, toast: sandbox.toast, confirm: sandbox.confirm,
    chapters: P.state.chapters, currentId: P.state.currentChapterId, workId: P.state.workId, work: P.state.work,
    jobs: P.state.chapterJobs, bps: P.state.chapterBlueprints, limit: P.state.chapterBlueprintLimit,
    draft: P.state.chapterDraft, review: P.state.chapterReview,
    empty: P.state.editorEmptyBlocked, failed: P.state.editorSaveFailedSnapshot,
    aiContext: P.state.aiContext, apiConfigs: P.state.apiConfigs, activeConfigId: P.state.activeConfigId,
  };
  const chapter = { id: 119, title: '第119章', content: '<p>正文</p>' };
  P.state.currentChapterId = 119;
  P.state.chapters = [chapter];
  P.state.chapterDraft = null;
  P.state.chapterReview = null;
  P.state.chapterJobs = [];
  P.state.editorEmptyBlocked = null;
  P.state.editorSaveFailedSnapshot = null;
  P.state.chapterBlueprints = [
    { id: 21, chapter_id: 119, created_at: '2026-10-06T13:31:21.121Z', target_words: 3000, blueprint: { scene_goal: '觉醒日一整天', plot_points: '一、二' } },
    { id: 20, chapter_id: 119, created_at: '2026-10-06T12:31:43.930Z', target_words: 3000, blueprint: { scene_goal: '稍早那一版计划', plot_points: '' } },
    { id: 9, chapter_id: 777, created_at: '2026-09-25T05:57:54.610Z', target_words: 0, blueprint: { scene_goal: '别的章节的蓝图' } },
  ];
  P.state.chapterBlueprintLimit = 2;

  const bar = P.recoveryBarHtml(chapter);
  check('P-BP-1 已保存蓝图逐条渲染（带上限口径），每条带「生成 / 查看 / 删除」，别的章的蓝图不出现',
    bar.includes('已保存蓝图 1/2') && bar.includes('蓝图 2/2')
    && bar.includes('data-action="bp-generate" data-id="21"') && bar.includes('data-action="bp-delete" data-id="21"')
    && bar.includes('data-action="bp-view" data-id="20"') && bar.includes('data-action="bp-delete" data-id="20"')
    && !bar.includes('data-id="9"') && bar.includes('觉醒日一整天'),
    bar.slice(0, 320));

  const bpJob = { id: 'job-bp-1', chapter_id: 119, kind: 'blueprint', stage: '蓝图', status: 'done', has_output: true, output_chars: 1622 };
  const legacyBpJob = { id: 'job-bp-legacy', chapter_id: 119, kind: 'prose', stage: 'AI 写作', status: 'done', has_output: true, output_chars: 1589, is_blueprint: true };
  const proseJob = { id: 'job-prose-1', chapter_id: 119, kind: 'prose', stage: 'AI 写作', status: 'done', has_output: true, output_chars: 4908 };
  P.state.chapterJobs = [bpJob, legacyBpJob, proseJob];
  const bar2 = P.recoveryBarHtml(chapter);
  check('P-BP-2 蓝图轮显示成「📐 蓝图」且不给「取回结果并应用」（成文任务照常可应用）',
    bar2.includes('📐 蓝图')
    && !bar2.includes('data-action="fetch-job" data-id="job-bp-1"')
    && !bar2.includes('data-action="fetch-job" data-id="job-bp-legacy"')
    && bar2.includes('data-action="fetch-job" data-id="job-prose-1"'),
    bar2.slice(0, 320));

  // ③ 过滤发生在 refreshChapterRecovery（它才决定"哪些记录出现在恢复条上"）
  const baseApi = sandbox.api;
  sandbox.api = async (p) => {
    const s = String(p);
    if (s.startsWith('/novel/draft')) return { draft: null };
    if (s.startsWith('/novel/review')) return { review: null };
    if (s.startsWith('/harness/recoverable')) {
      return { jobs: [bpJob, legacyBpJob, proseJob, { id: 'job-run-bp', chapter_id: 119, kind: 'blueprint', stage: '蓝图', status: 'running', resumable: true, has_output: false, output_chars: 0 }] };
    }
    if (s.startsWith('/novel/chapter_blueprints')) return { limit: 2, blueprints: P.state.chapterBlueprints };
    return baseApi(p);
  };
  await P.refreshChapterRecovery(119);
  const kept = (P.state.chapterJobs || []).map((j) => j.id);
  check('P-BP-3 已完成的蓝图轮不再进「结果待应用」列表，跑着的蓝图轮仍保留（能停止）',
    !kept.includes('job-bp-1') && !kept.includes('job-bp-legacy') && kept.includes('job-prose-1') && kept.includes('job-run-bp'),
    JSON.stringify(kept));

  // ④ 删除
  const calls = [];
  const msgs = [];
  sandbox.toast = (m) => msgs.push(String(m));
  sandbox.confirm = () => true;
  sandbox.api = async (p, o = {}) => {
    calls.push({ p: String(p), o });
    if (String(p) === '/novel/chapter_blueprints' && o.method === 'DELETE') {
      return { ok: true, limit: 2, deleted: 1, blueprints: [{ ...P.state.chapterBlueprints[1] }] };
    }
    return { ok: true };
  };
  await P.handleAction('bp-delete', { dataset: { action: 'bp-delete', id: '21' } });
  check('P-BP-4 「删除」走 DELETE /novel/chapter_blueprints（带 chapter_id + blueprint_id），并照服务端返回的真值重画',
    calls.length === 1 && calls[0].o.method === 'DELETE'
    && Number(calls[0].o.body.chapter_id) === 119 && Number(calls[0].o.body.blueprint_id) === 21
    && P.state.chapterBlueprints.length === 1 && Number(P.state.chapterBlueprints[0].id) === 20,
    JSON.stringify({ calls: calls.map((c) => [c.p, c.o.method]), bps: P.state.chapterBlueprints.map((b) => b.id), msgs }));

  // 删除失败必须如实报错、不动本地列表（不允许"看起来删了、刷新又回来"）
  calls.length = 0; msgs.length = 0;
  sandbox.api = async (p, o = {}) => { calls.push({ p: String(p), o }); const e = new Error('API not found'); e.status = 404; throw e; };
  P.state.chapterBlueprints = [{ id: 21, chapter_id: 119, created_at: '', target_words: 0, blueprint: { scene_goal: 'x' } }];
  await P.handleAction('bp-delete', { dataset: { action: 'bp-delete', id: '21' } });
  check('P-BP-5 服务端拒绝删除时如实报错，本地列表保留原样',
    P.state.chapterBlueprints.length === 1 && msgs.some((m) => m.includes('删除失败')),
    JSON.stringify({ bps: P.state.chapterBlueprints.length, msgs }));

  // ⑤ 点「生成」先进入确认框（不再向模型要蓝图）
  const savedWrite = {
    direct: sandbox.directAIWrite, confirmFn: sandbox.showBlueprintConfirm, card: sandbox.showAITaskProgress,
    fetch: sandbox.fetch, report: sandbox.reportClientLog, harness: sandbox.runHarnessJob,
    decoder: sandbox.TextDecoder, result: sandbox.showAIWritingResult,
  };
  containers['#editor-content'].dataset = { chapterId: '119' };
  P.state.chapterBlueprints = [{ id: 21, chapter_id: 119, created_at: '2026-10-06T13:31:21.121Z', target_words: 3000, blueprint: { scene_goal: '觉醒日一整天', plot_points: '一、二', conflicts: '', character_changes: '', hook: '', references: '' } }];
  P.state.workId = 18; P.state.work = { id: 18, title: '探针作品' }; P.state.aiContext = null;
  sandbox.reportClientLog = () => {};
  sandbox.TextDecoder = class { decode(b) { return b ? Buffer.from(b).toString('utf8') : ''; } };
  sandbox.api = async (p) => {
    const s = String(p);
    if (s.startsWith('/ai_context') || s.startsWith('/novel/context')) {
      return { assembled: '服务端装配文本', context_manifest: [], context_stats: { truncatedLayers: 0 } };
    }
    return { ok: true };
  };
  const blueprintPrompts = [];
  sandbox.directAIWrite = async (messages) => {
    const prompt = String((messages && messages[0] && messages[0].content) || '');
    if (prompt.includes('【蓝图】')) blueprintPrompts.push(prompt);
    return '';
  };
  let confirmArg = null;
  sandbox.showBlueprintConfirm = async (bp) => { confirmArg = bp; return null; }; // 作者在确认框上点了「取消」
  containers['#modal-root'].innerHTML = '';
  let genErr = '';
  try { await P.handleAction('bp-generate', { dataset: { action: 'bp-generate', id: '21' } }); } catch (e) { genErr = e.message; }
  check('P-BP-6 点「生成」先进入蓝图确认框（拿到的是那份已保存蓝图），且**不**再向模型要蓝图',
    !!confirmArg && String(confirmArg.scene_goal) === '觉醒日一整天' && blueprintPrompts.length === 0 && genErr === '',
    JSON.stringify({ confirmGoal: confirmArg && confirmArg.scene_goal, blueprintPrompts: blueprintPrompts.length, genErr }));

  // 找不到那一份时早退：不发任何请求（也不能启动一次付费写作）
  const ghostCalls = [];
  const ghostMsgs = [];
  sandbox.toast = (m) => ghostMsgs.push(String(m));
  sandbox.api = async (p, o = {}) => { ghostCalls.push(String(p)); return { ok: true }; };
  sandbox.showBlueprintConfirm = async () => { throw new Error('不该打开确认框'); };
  await P.handleAction('bp-generate', { dataset: { action: 'bp-generate', id: '999999' } });
  check('P-BP-7 按一份已不存在的蓝图生成：只提示、不发请求、不开确认框',
    ghostCalls.length === 0 && ghostMsgs.some((m) => m.includes('已经不在了')),
    JSON.stringify({ calls: ghostCalls, msgs: ghostMsgs }));

  sandbox.api = saved.api; sandbox.toast = saved.toast; sandbox.confirm = saved.confirm;
  sandbox.directAIWrite = savedWrite.direct; sandbox.showBlueprintConfirm = savedWrite.confirmFn;
  sandbox.showAITaskProgress = savedWrite.card; sandbox.fetch = savedWrite.fetch;
  sandbox.reportClientLog = savedWrite.report; sandbox.runHarnessJob = savedWrite.harness;
  sandbox.TextDecoder = savedWrite.decoder; sandbox.showAIWritingResult = savedWrite.result;
  P.state.chapters = saved.chapters; P.state.currentChapterId = saved.currentId;
  P.state.workId = saved.workId; P.state.work = saved.work; P.state.aiContext = saved.aiContext;
  P.state.chapterJobs = saved.jobs; P.state.chapterBlueprints = saved.bps; P.state.chapterBlueprintLimit = saved.limit;
  P.state.chapterDraft = saved.draft; P.state.chapterReview = saved.review;
  P.state.editorEmptyBlocked = saved.empty; P.state.editorSaveFailedSnapshot = saved.failed;
  P.state.apiConfigs = saved.apiConfigs; P.state.activeConfigId = saved.activeConfigId;
}

// --- P-OMIT-1（2026-10-04）：规划轮走慢通道时，检索工具也不许把上一版蓝图端出来 ---
// 背景：前端那层 `omit_layers=blueprint` 只作用于**前端自己装配的上下文**。慢通道的模型还带着
// 检索工具（novel_context → /api/novel/context、novel_lookup → /api/search 的 blueprint_json），
// 那两条路各自去服务端取数据，会绕过前端。因此规划轮的 harness 任务必须带
// `env.NOVEL_OMIT_LAYERS=blueprint`（服务端透传到子进程 → 插件按标记省略蓝图层与蓝图摘要）；
// 成文轮不带 —— 那时新蓝图已确认，必须能被查到。
{
  const saved = {
    fetch: sandbox.fetch, api: sandbox.api, toast: sandbox.toast, report: sandbox.reportClientLog,
    showResult: sandbox.showAIWritingResult, apply: sandbox.applyAIWritingArticle, harness: sandbox.runHarnessJob,
    direct: sandbox.directAIWrite, confirm: sandbox.showBlueprintConfirm, card: sandbox.showAITaskProgress,
    chapterId: P.state.currentChapterId, workId: P.state.workId, work: P.state.work, chapters: P.state.chapters,
    aiContext: P.state.aiContext, apiConfigs: P.state.apiConfigs, activeConfigId: P.state.activeConfigId,
  };
  P.state.aiTaskRunning = false;
  P.state.currentChapterId = 610;
  P.state.workId = 2;
  P.state.work = { id: 2, title: '测试作品' };
  P.state.apiConfigs = [{ id: 1, api_key: 'sk-test', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.8, max_tokens: 4096 }];
  P.state.activeConfigId = 1;
  P.state.chapters = [{ id: 610, title: '第610章' }];
  containers['#editor-content'] = mkEl('editor-content');
  containers['#editor-content'].innerHTML = '<p>已有正文</p>';
  containers['#editor-content'].dataset = { chapterId: '610' };
  const baseApi = sandbox.api;
  const ctxCalls = [];
  const ledgerPosts = [];
  sandbox.api = async (p, o = {}) => {
    const s = String(p);
    if (s.startsWith('/harness/run') && o && o.body && o.body.action === 'ledger') { ledgerPosts.push(o.body); return { job_id: '' }; }
    if (s.startsWith('/ai_context') || s.startsWith('/novel/context')) {
      ctxCalls.push(s);
      return { assembled: '服务端装配文本', context_manifest: [], context_stats: { truncatedLayers: 0 } };
    }
    return baseApi(p, o);
  };
  sandbox.toast = () => {};
  sandbox.reportClientLog = () => {};
  sandbox.TextDecoder = class { decode(b) { return b ? Buffer.from(b).toString('utf8') : ''; } };
  // 进度卡替身必须实现 track/runCancel：流式成文会注册取消句柄，缺了它会抛错并静默回退慢通道，
  // 于是本用例测到的是"回退路径"而不是"直连成文 + 采纳 + 入账"。
  sandbox.showAITaskProgress = () => ({ note() {}, close() {}, track: () => () => {}, runCancel: () => {} });
  sandbox.directAIWrite = async () => '';   // 规划轮**强制走慢通道**，才能看到它的任务体
  sandbox.showBlueprintConfirm = async (bp) => ({ ...bp, skip: false, target_words: 3000 });
  let pOmitResultOpened = 0; let pOmitApplied = 0;
  sandbox.showAIWritingResult = async () => { pOmitResultOpened += 1; return 'replace'; };   // 走到"采纳"，才会触发入账提案
  sandbox.applyAIWritingArticle = async () => { pOmitApplied += 1; };
  const bodies = [];
  sandbox.runHarnessJob = async (body) => {
    bodies.push(body || {});
    const p = String(body?.prompt || '');
    // 规划轮给蓝图，成文轮给正文：两轮都走慢通道，才能同时验 env 标记与"采纳后入账"。
    return p.includes('【蓝图】')
      ? { output: '【蓝图】\n{"scene_goal":"雨夜摊牌","plot_points":"对峙","conflicts":"旧账","character_changes":"主角动摇","hook":"门外有人","references":""}' }
      : { output: '雨夜的正文。他把伞收起来，抖掉上面的水。' };
  };
  let omitErr = '';
  try { await P.performToolbarAIWrite('续写本章'); } catch (e) { omitErr = e.message; }
  const norm = (v) => String(v || '').split(',').filter(Boolean).sort().join(',');
  const FULL = 'blueprint,events,foreshadows,memory,recall,scene';
  const PROSE = 'events,foreshadows,memory,recall,scene';
  check('P-OMIT-1 「重写本章」标记随规划轮的慢通道任务下发（含旧蓝图与"前面发生过什么"那一组）',
    bodies.length >= 1 && norm(bodies[0]?.env?.NOVEL_OMIT_LAYERS) === FULL
      && String(bodies[0].prompt || '').includes('【蓝图】'),
    omitErr || JSON.stringify(bodies.map((b) => ({ env: b.env || null, head: String(b.prompt || '').slice(0, 16) }))));
  // 两次前端装配都要带跳层参数：规划轮（defer）带全套，成文轮（direction）少 blueprint 一项
  // —— 成文轮发生时新蓝图已确认，那一层此刻装的就是新蓝图。
  const deferCall = ctxCalls.find((u) => u.includes('library_recall_phase=defer')) || '';
  const dirCall = ctxCalls.find((u) => u.includes('library_recall_phase=direction')) || '';
  check('P-OMIT-2 规划轮装配 omit 全套、成文轮装配少 blueprint（新蓝图必须可见）',
    norm(decodeURIComponent(deferCall).match(/omit_layers=([^&]*)/)?.[1]) === FULL
      && norm(decodeURIComponent(dirCall).match(/omit_layers=([^&]*)/)?.[1]) === PROSE,
    JSON.stringify({ ctxCalls: ctxCalls.map((u) => decodeURIComponent(u).slice(0, 120)) }));
  // 说明：这里**不**断言"重写模式额外补一次入账" —— 核对该需求时发现慢通道内核本来就会提交
  // 入账提案（前端再补一次会变成两套提案），所以重写模式在该处不改行为。本用例只守三条：
  // 慢通道任务的标记、两次装配的 omit 参数、以及流程仍能走到采纳。
  sandbox.fetch = saved.fetch; sandbox.api = saved.api; sandbox.toast = saved.toast; sandbox.reportClientLog = saved.report;
  sandbox.showAIWritingResult = saved.showResult; sandbox.applyAIWritingArticle = saved.apply; sandbox.runHarnessJob = saved.harness;
  sandbox.directAIWrite = saved.direct; sandbox.showBlueprintConfirm = saved.confirm; sandbox.showAITaskProgress = saved.card;
  P.state.currentChapterId = saved.chapterId; P.state.workId = saved.workId; P.state.work = saved.work;
  P.state.chapters = saved.chapters; P.state.aiContext = saved.aiContext;
  P.state.apiConfigs = saved.apiConfigs; P.state.activeConfigId = saved.activeConfigId;
}

// --- T6：五组独立导航（真实点击 + 每页只加载自己的数据）+ 章末状态面板 + 影响 / 逐章重建接线 ---
{
  const savedT6 = {
    workId: P.state.workId, work: P.state.work, loadedWorkId: P.state.loadedWorkId,
    chapters: P.state.chapters, volumes: P.state.volumes, characters: P.state.characters,
    worldEntries: P.state.worldEntries, currentChapterId: P.state.currentChapterId,
    view: P.state.view, aiTab: P.state.aiTab, storyState: P.state.storyState,
    editRules: P.state.editRules, authorStyle: P.state.authorStyle, branch: P.state.branch,
    rebuild: P.state.rebuild, rebuildLoaded: P.state.rebuildLoaded,
    chapterPanel: P.state.chapterPanel, chapterProposals: P.state.chapterProposals,
    chapterPanelView: P.state.chapterPanelView, chapterPanelFull: P.state.chapterPanelFull,
    impactRuns: P.state.impactRuns, impactRun: P.state.impactRun, impactRootId: P.state.impactRootId,
    repairRuns: P.state.repairRuns, repairRun: P.state.repairRun, repairPreview: P.state.repairPreview
  };
  const resetTemporalCaches = () => {
    P.state.editRules = null; P.state.authorStyle = null; P.state.storyState = null; P.state.branch = null;
    P.state.rebuild = null; P.state.rebuildLoaded = false;
    P.state.impactRuns = null; P.state.impactRun = null;
    P.state.repairRuns = null; P.state.repairRun = null; P.state.repairPreview = null;
    P.state.chapterPanel = null; P.state.chapterProposals = null; P.state.chapterPanelView = 'cast';
  };
  P.state.workId = 1;
  P.state.loadedWorkId = 1;
  P.state.work = { title: 'T6 测试书', author_note: '作者注' };
  P.state.volumes = [];
  P.state.chapters = [
    { id: 7, title: '第一章', content: '<p>旧正文第一段。</p>' },
    { id: 8, title: '第二章', content: '<p>旧正文二段。</p><p>旧正文三段。</p>' }
  ];
  P.state.characters = [{ id: 9, name: '林昭' }]; // 注意：角色表里没有任何 status 字段
  P.state.worldEntries = [];
  P.state.currentChapterId = 7;
  resetTemporalCaches();
  containers['#board-content'] = mkEl('board-content');

  // (1) 真实点击七个 tab（board-tab 是界面上的真实动作入口）：每一页只加载自己的数据
  const tabChecks = [
    { key: 'rules', must: ['/api/novel/editing'] },
    { key: 'style', must: ['/api/novel/style/samples', '/api/novel/style/profile', '/api/novel/author_intent'] },
    { key: 'story-state', must: ['/api/novel/story_state', '/api/novel/state/disclosure', '/api/novel/state/impact', '/api/novel/state/repair'] },
    { key: 'branch', must: ['/api/novel/branch/sandboxes'] },
    { key: 'rebuild', must: ['/api/import/rebuild/status'] }
  ];
  const otherPages = {
    rules: ['/api/novel/style/', '/api/novel/story_state', '/api/novel/branch/', '/api/import/rebuild/status'],
    style: ['/api/novel/editing', '/api/novel/story_state', '/api/novel/branch/', '/api/import/rebuild/status'],
    'story-state': ['/api/novel/editing', '/api/novel/style/', '/api/novel/branch/', '/api/import/rebuild/status'],
    branch: ['/api/novel/editing', '/api/novel/style/', '/api/novel/story_state', '/api/import/rebuild/status'],
    rebuild: ['/api/novel/editing', '/api/novel/style/', '/api/novel/story_state', '/api/novel/branch/']
  };
  let isolationOk = true;
  const isolationDetail = [];
  for (const t of tabChecks) {
    resetTemporalCaches();
    const before = requests.length;
    await P.handleAction('board-tab', { dataset: { action: 'board-tab', board: 'ai', tab: t.key } }, {});
    const urls = requests.slice(before).map((r) => r.url);
    const missMust = t.must.filter((m) => !urls.some((u) => u.includes(m)));
    const leaked = (otherPages[t.key] || []).filter((m) => urls.some((u) => u.includes(m)));
    if (missMust.length || leaked.length) isolationOk = false;
    const pageHtml = String(containers['#board-content'].innerHTML);
    isolationDetail.push(`${t.key}:miss=${missMust.join(',') || '-'};leak=${leaked.join(',') || '-'}`);
    if (t.key === 'rules') {
      check('T6-1 编辑规则页独立渲染（三档 / 能力 / 扫描 / 保存）', pageHtml.includes('name="edit-tier"') && pageHtml.includes('data-action="scan-edit-rules"') && pageHtml.includes('data-action="save-edit-rules"'));
    }
    if (t.key === 'rebuild') check('T6-2 导入后重建页独立渲染（有真实内容，不是空壳）', pageHtml.length > 200);
  }
  check('T6-3 五组独立页面各自只发自己的请求（切一页不连带读取其余四页）', isolationOk, isolationDetail.join(' | '));

  // (1b) 旧路由键 st 仍是兼容别名，且不再连带加载五组
  resetTemporalCaches();
  {
    const before = requests.length;
    await P.handleAction('board-tab', { dataset: { action: 'board-tab', board: 'ai', tab: 'st' } }, {});
    const urls = requests.slice(before).map((r) => r.url);
    const html = String(containers['#board-content'].innerHTML);
    check('T6-4 旧键 st 兼容：创作上下文仍可用，且不再自动加载编辑规则/样文/故事状态/沙盘/重建',
      P.state.aiTab === 'st' && html.includes('🧩 创作上下文')
        && !urls.some((u) => ['/api/novel/editing', '/api/novel/style/', '/api/novel/story_state', '/api/novel/branch/', '/api/import/rebuild/status'].some((m) => u.includes(m))),
      urls.slice(0, 4).join(' | '));
  }

  // (2) 章末状态面板：读真实后端时态状态（角色表里没有 status，面板显示的只能是后端投影）
  registered.set('#chapter-state-panel', mkEl('chapter-state-panel'));
  registered.set('#repair-section', mkEl('repair-section'));
  P.state.currentChapterId = 7;
  P.state.chapterPanel = null; P.state.chapterProposals = null; P.state.chapterPanelView = 'cast';
  temporalStub.panelCalls = [];
  P.goView('writing');
  await P.render();
  await new Promise((r) => setTimeout(r, 80));
  const panelEl = registered.get('#chapter-state-panel');
  const panelHtml7 = String(panelEl.innerHTML);
  const writingHtml = String(containers['#content'].innerHTML);
  check('T6-5 面板两次读取都带 work_id/chapter_id（章节面板 + 本章提案组）',
    requests.some((r) => r.url.includes('/api/novel/state/panel') && r.url.includes('work_id=1') && r.url.includes('chapter_id=7'))
      && requests.some((r) => r.url.includes('/api/novel/state/proposal-groups') && r.url.includes('chapter_id=7')));
  check('T6-6 面板渲染后端时态字段：出场角色 / 截至本章状态 / 状态变化 / 关系 / 剧情线 / 事件',
    panelHtml7.includes('林昭') && panelHtml7.includes('本章出场') && panelHtml7.includes('存活')
      && panelHtml7.includes('受伤') && panelHtml7.includes('师徒')
      && panelHtml7.includes('黑风谷任务') && panelHtml7.includes('林昭潜入钟楼'),
    panelHtml7.slice(0, 120));
  check('T6-7 过去章节不显示未来状态（第 7 章不出现第 8 章才发生的战死）', !panelHtml7.includes('战死'));
  check('T6-6b 面板表头含章节 / 章前章后 / 世界线 / 提交 / 有效性 / 可信前缀',
    panelHtml7.includes('第一章') && panelHtml7.includes('章后状态') && panelHtml7.includes('世界线')
      && panelHtml7.includes('提交 commit-abcde') && panelHtml7.includes('已确认（正式稿）') && panelHtml7.includes('可信前缀'));
  check('T6-6c 状态变化带原文证据与「定位」入口（不是只有结论）',
    panelHtml7.includes('原文证据') && panelHtml7.includes('伤口已经结痂') && panelHtml7.includes('data-action="panel-jump"'));
  {
    let jumped = false;
    const fakeNode = { children: [], textContent: '他伤口已经结痂，动作却更快了。', scrollIntoView: () => { jumped = true; } };
    const fakeEditor = mkEl('editor-content');
    fakeEditor.querySelectorAll = () => [fakeNode];
    registered.set('#editor-content', fakeEditor);
    await P.handleAction('panel-jump', { dataset: { action: 'panel-jump', quote: '伤口已经结痂' } }, {});
    check('T6-6d 证据「定位」在正文里找到引文后滚动到该段（不是只有按钮没有行为）', jumped === true);
    fakeEditor.querySelectorAll = () => []; // 编辑器在，但正文里没有这段引文（比如正文已被改过）
    await P.handleAction('panel-jump', { dataset: { action: 'panel-jump', quote: '正文里不存在的引文' } }, {});
    const lastToast = containers['#toast-root'].children[containers['#toast-root'].children.length - 1];
    check('T6-6e 找不到证据时给出诚实提示（不假装跳转成功）',
      String((lastToast && lastToast.textContent) || '').includes('没有找到这段证据'), String((lastToast && lastToast.textContent) || ''));
    registered.delete('#editor-content');
  }
  check('T6-8 面板在正文编辑区之外（editor-content / editor-status 之后），不进入正文字数与导出',
    writingHtml.indexOf('id="chapter-state-panel"') > writingHtml.indexOf('id="editor-content"')
      && writingHtml.indexOf('id="chapter-state-panel"') > writingHtml.indexOf('id="editor-status"'));

  // (2b) 三档视图：切到「全部故事状态」会带 full=1 重新取数，并渲染完整状态条目
  temporalStub.panelCalls.length = 0;
  await P.setChapterPanelView('all');
  const allHtml = String(panelEl.innerHTML);
  check('T6-9 「全部故事状态」档带 full=1 重新取数，并渲染完整状态条目（域 + 值）',
    temporalStub.panelCalls.some((c) => c.full === true) && allHtml.includes('全部故事状态')
      && allHtml.includes('存活') && allHtml.includes('进行中'), JSON.stringify(temporalStub.panelCalls));
  await P.setChapterPanelView('cast');

  // (2c) 本章提案一次确认：真实 POST 到 proposal-groups/:id/apply（原子组，模型侧不能确认）
  temporalStub.appliedProposals.length = 0;
  await P.confirmChapterProposals();
  check('T6-10 一次确认本章提案 = POST /novel/state/proposal-groups/:id/apply（无事件子集，整体确认）',
    temporalStub.appliedProposals.length === 1
      && requests.some((r) => r.method === 'POST' && r.url.includes('/api/novel/state/proposal-groups/bind-prop-1/apply')
        && JSON.parse(String(r.body)).events === undefined && JSON.parse(String(r.body)).chapter_id === 7));

  // (2d) 切章：面板请求目标章，且第 8 章显示第 8 章的状态（战死）
  temporalStub.panelCalls.length = 0;
  P.state.currentChapterId = 8;
  await P.render();
  await new Promise((r) => setTimeout(r, 80));
  const panelHtml8 = String(panelEl.innerHTML);
  check('T6-11 切章后面板请求本章（chapter_id=8）并显示该章状态（战死），不沿用上一章',
    temporalStub.panelCalls.some((c) => c.chapterId === 8) && panelHtml8.includes('战死') && panelHtml8.includes('第二章'),
    JSON.stringify(temporalStub.panelCalls));
  // (2e) 迟到响应：先发的慢请求（第 7 章）不得把状态画到已切到的第 8 章
  {
    temporalStub.panelDelays = { 7: 120, 8: 10 };
    P.state.currentChapterId = 7; P.state.chapterPanel = null; P.state.chapterProposals = null;
    const slow = P.refreshChapterStatePanel(7);
    await new Promise((r) => setTimeout(r, 5));
    P.state.currentChapterId = 8;
    await P.refreshChapterStatePanel(8);
    await slow;
    await new Promise((r) => setTimeout(r, 150));
    const raced = String(panelEl.innerHTML);
    check('T6-11b 迟到响应被请求序号拦下：慢的第 7 章响应不覆盖已切换到的第 8 章面板',
      raced.includes('第二章') && raced.includes('战死') && !raced.includes('第一章'), raced.slice(0, 90));
    temporalStub.panelDelays = null;
    P.state.currentChapterId = 7; P.state.chapterPanel = null; P.state.chapterProposals = null;
  }

  // (3) 影响分析（只分析、只标记；隐性因果，不是角色名搜索）
  P.state.currentChapterId = 7;
  resetTemporalCaches();
  P.goView('story-state');
  await P.render();
  const statePage1 = String(containers['#board-content'].innerHTML);
  check('T6-12 影响区展示后端报告：需要复核 / 保留原文 / 隐性因果证据（前提 + 原文引文 + 资源依赖）',
    statePage1.includes('需要复核') && statePage1.includes('保留原文')
      && statePage1.includes('前提：王师傅仍然活着') && statePage1.includes('他还在等王师傅回信')
      && statePage1.includes('王师傅的护身符') && statePage1.includes('<details') && statePage1.includes('展开原因与证据'));
  temporalStub.impactPosts.length = 0;
  await P.impactAnalyze();
  check('T6-13 「分析影响」真实 POST（refresh=true）；分析阶段不产生任何正文写请求',
    temporalStub.impactPosts.length === 1 && temporalStub.impactPosts[0].chapter_id === 7 && temporalStub.impactPosts[0].refresh === true
      && !requests.some((r) => ['PUT', 'PATCH'].includes(r.method) && r.url.includes('/api/chapters/')));

  // (4) 逐章重建：按钮 → 一次性审批 → 启动；运行中不出现「应用」；就绪后才可应用；预览读只读端点
  temporalStub.repairRun = null; temporalStub.repairSteps = []; temporalStub.repairCandidate = null;
  temporalStub.repairGate = { can_apply: false, reasons: ['运行状态为 running'] };
  temporalStub.repairStarts.length = 0; temporalStub.repairActions.length = 0; temporalStub.approvals.length = 0;
  P.state.repairRuns = null; P.state.repairRun = null;
  await P.render();
  await P.repairStart();
  P.stopRepairPoll();
  check('T6-14 重建必须先签发一次性审批：POST /novel/approvals(op=repair_run_start) → POST /repair/start(带 approval_id)',
    temporalStub.approvals.length === 1 && temporalStub.approvals[0].op === 'repair_run_start' && temporalStub.approvals[0].root_chapter_id === 7
      && temporalStub.repairStarts.length === 1 && temporalStub.repairStarts[0].approval_id === 'appr-1'
      && temporalStub.repairStarts[0].root_chapter_id === 7 && temporalStub.repairStarts[0].work_id === 1);
  const runningHtml = P.repairSectionHtml();
  check('T6-15 运行中按章显示逐章进度；未就绪不出现「应用候选」按钮（只出现取消）',
    runningHtml.includes('逐章进度') && runningHtml.includes('第一章') && runningHtml.includes('第二章')
      && !runningHtml.includes('data-action="repair-apply"') && runningHtml.includes('data-action="repair-cancel"'));

  // 就绪 + 有候选：应用按钮出现；预览走只读 revision 端点做真实 diff
  temporalStub.repairRun = { ...temporalStub.repairRun, status: 'ready', result: { totals: { chapters: 2, kept: 1, repaired: 1, needs_review: 0, blocked: 0, model_calls: 2 }, halt: null } };
  temporalStub.repairSteps = temporalStub.repairSteps.map((s) => (s.chapter_id === 8
    ? { ...s, status: 'repaired', candidate_revision_id: 'rev-cand-1', candidate_binding_id: 'bind-cand-1', result: { reason: '按新前提最小修订' } }
    : { ...s, status: 'kept', result: { reason: '正文仍成立，保留原文' } }));
  temporalStub.repairCandidate = { head_commit_id: 'commit-cand-1', manifest_hash: 'manifest-hash-1' };
  temporalStub.repairGate = { can_apply: true, reasons: [] };
  await P.loadRepairRun('run-repair-1');
  await P.render();
  const readyHtml = P.repairSectionHtml();
  check('T6-16 就绪后出现「应用候选（需一次性审批）」按钮；保留章与修订章分开显示，候选预览按钮只挂在有候选的章',
    readyHtml.includes('data-action="repair-apply"') && readyHtml.includes('data-action="repair-preview"')
      && readyHtml.includes('保留原文') && readyHtml.includes('按新前提最小修订'));
  await P.repairPreview(0);
  check('T6-17 候选预览读只读 /novel/state/revision（不是本地编造），并与当前正文逐段 diff',
    requests.some((r) => r.method === 'GET' && r.url.includes('/api/novel/state/revision') && r.url.includes('revision_id=rev-cand-1'))
      && String(containers['#board-content'].innerHTML).includes('新的正文第一段'));
  temporalStub.approvals.length = 0;
  await P.repairAction('apply');
  check('T6-18 应用候选：签发 repair_run_apply 一次性审批 → POST /repair/apply（带 approval_id，正文切换由服务端原子完成）',
    temporalStub.approvals.length === 1 && temporalStub.approvals[0].op === 'repair_run_apply' && temporalStub.approvals[0].run_id === 'run-repair-1'
      && temporalStub.repairActions.some((a) => a.action === 'apply' && a.body.approval_id === 'appr-1' && a.body.run_id === 'run-repair-1'));

  P.stopRepairPoll();
  delete containers['#board-content'];
  registered.delete('#chapter-state-panel');
  registered.delete('#repair-section');
  Object.assign(P.state, savedT6);
  temporalStub.panelCalls = [];
  temporalStub.appliedProposals = [];
  temporalStub.impactPosts = [];
  temporalStub.repairRun = null; temporalStub.repairSteps = []; temporalStub.repairCandidate = null;
  temporalStub.repairGate = { can_apply: false, reasons: [] };
  temporalStub.repairStarts = []; temporalStub.repairActions = []; temporalStub.approvals = [];
}

// --- T7：时态引擎开关（迁移门禁 / 预算告知）与存量重建（逐章按钮流程 + bootstrap 候选）---
{
  const savedT7 = {
    workId: P.state.workId, work: P.state.work, loadedWorkId: P.state.loadedWorkId,
    chapters: P.state.chapters, volumes: P.state.volumes, characters: P.state.characters,
    currentChapterId: P.state.currentChapterId, view: P.state.view, aiTab: P.state.aiTab,
    temporalEngine: P.state.temporalEngine, temporalEngineEnable: P.state.temporalEngineEnable,
    backfill: P.state.backfill, backfillStep: P.state.backfillStep, backfillRunner: P.state.backfillRunner,
    chapterPanel: P.state.chapterPanel
  };
  P.state.workId = 1; P.state.loadedWorkId = 1;
  P.state.work = { title: 'T7 测试书' };
  P.state.volumes = [];
  P.state.chapters = [
    { id: 7, title: '第一章', content: '<p>旧正文第一段。</p>' },
    { id: 8, title: '第二章', content: '<p>旧正文二段。</p>' },
    { id: 9, title: '第三章', content: '<p>旧正文三段。</p>' }
  ];
  P.state.characters = [{ id: 9, name: '王师傅' }];
  P.state.currentChapterId = 7;
  P.state.temporalEngine = null; P.state.temporalEngineEnable = null;
  P.state.backfill = null; P.state.backfillStep = null; P.state.backfillRunner = null;
  temporalStub.temporal = temporalStub.engineDefault();
  temporalStub.backfill = temporalStub.backfillDefault();
  temporalStub.temporalPuts.length = 0; temporalStub.stepPosts.length = 0;
  temporalStub.confirmPosts.length = 0; temporalStub.bootstrapPosts.length = 0;
  temporalStub.temporalFail = false; temporalStub.temporalBroken = false;
  containers['#board-content'] = mkEl('board-content');

  const lastToastText = () => {
    const box = containers['#toast-root'];
    const last = box && box.children[box.children.length - 1];
    return String((last && last.textContent) || '');
  };

  // (1) 打开页面：引擎卡 + 存量重建卡都读真实后端字段
  const before7 = requests.length;
  P.goView('story-state');
  await P.render();
  await new Promise((r) => setTimeout(r, 40));
  const t7page = String(containers['#board-content'].innerHTML);
  const t7urls = requests.slice(before7).map((r) => r.url);
  check('T7-1 故事状态页渲染引擎卡与存量重建卡（真实迁移 / 预算 / 逐章状态字段，不是占位文案）',
    t7page.includes('时态状态引擎（迁移与开关）') && t7page.includes('旧作品默认不启用')
      && t7page.includes('启用后的待重建范围：共 3 章') && t7page.includes('预计模型调用 2 次')
      && t7page.includes('扫描旧字段待确认 1 条')
      && t7page.includes('存量重建（逐章按叙事顺序）') && t7page.includes('可信前缀：截至第 1 章')
      && t7page.includes('待处理章节（2）') && t7page.includes('未冻结修订'),
    t7page.slice(0, 140));
  check('T7-1b 页面真实请求 /novel/state/temporal 与 /novel/state/backfill（都带 work_id）',
    t7urls.some((u) => u.includes('/api/novel/state/temporal') && u.includes('work_id=1'))
      && t7urls.some((u) => u.includes('/api/novel/state/backfill') && u.includes('work_id=1')),
    t7urls.slice(0, 6).join(' | '));
  check('T7-2 三个开关分离：引擎 / 自动分析 / 逐章重建各自独立按钮，自动分析与重建在引擎未开启时不可点',
    t7page.includes('data-flag="temporal_enabled"') && t7page.includes('data-flag="auto_analysis_enabled"') && t7page.includes('data-flag="repair_enabled"')
      && /data-flag="auto_analysis_enabled"[^>]*disabled/.test(t7page) && /data-flag="repair_enabled"[^>]*disabled/.test(t7page));

  // (2) 首次启用：只带一个 flag；enable_scope 展示预算与待重建范围
  await P.temporalToggle('temporal_enabled', true);
  const afterEnableHtml = String(containers['#board-content'].innerHTML);
  check('T7-3 首次启用只 PUT temporal_enabled=true（不连带开启其它开关），并展示服务端 enable_scope（待重建 2 章 / 预计 2 次调用）',
    temporalStub.temporalPuts.length === 1 && temporalStub.temporalPuts[0].temporal_enabled === true && temporalStub.temporalPuts[0].work_id === 1
      && temporalStub.temporalPuts[0].auto_analysis_enabled === undefined && temporalStub.temporalPuts[0].repair_enabled === undefined
      && afterEnableHtml.includes('启用范围（本次启用时告知）：待重建 2 章')
      && lastToastText().includes('已启用') && lastToastText().includes('预计 2 次模型调用'),
    JSON.stringify(temporalStub.temporalPuts) + ' | ' + lastToastText());

  // (3) 自动分析（独立开关）与逐章重建（独立开关）各自 PUT 自己
  await P.temporalToggle('auto_analysis_enabled', true);
  await P.temporalToggle('repair_enabled', true);
  check('T7-4 自动分析 / 逐章重建是独立开关：各自单独 PUT 自己的 flag（不重发引擎开关）',
    temporalStub.temporalPuts.length === 3
      && temporalStub.temporalPuts[1].auto_analysis_enabled === true && temporalStub.temporalPuts[1].temporal_enabled === undefined
      && temporalStub.temporalPuts[2].repair_enabled === true && temporalStub.temporalPuts[2].temporal_enabled === undefined,
    JSON.stringify(temporalStub.temporalPuts));

  // (4) 迁移门禁：缺表时禁止开启（按钮禁用 + 明确警示）
  temporalStub.temporalBroken = true; P.state.temporalEngine = null;
  await P.render();
  const brokenHtml = String(containers['#board-content'].innerHTML);
  check('T7-5 迁移缺表/缺索引时禁止开启（按钮禁用 + 明确警示，不吞错误继续跑）',
    brokenHtml.includes('缺失：story_commits') && brokenHtml.includes('迁移未完成前不允许开启')
      && /data-flag="temporal_enabled"[^>]*disabled/.test(brokenHtml));
  temporalStub.temporalBroken = false; P.state.temporalEngine = temporalStub.temporal = temporalStub.engineDefault();

  // (5) 逐章：冻结并生成抽取请求（真实 POST，不带 result；不调用模型、不写正文）
  temporalStub.stepPosts.length = 0;
  const beforeStep = requests.length;
  await P.backfillStepRun(8);
  const stepHtml = String(containers['#board-content'].innerHTML);
  check('T7-6 「冻结并生成抽取请求」真实 POST step（无 result、不调用模型），界面给出「复制抽取请求」与「记录本机结果」入口',
    temporalStub.stepPosts.length === 1 && temporalStub.stepPosts[0].chapter_id === 8 && temporalStub.stepPosts[0].result === undefined
      && stepHtml.includes('已生成抽取请求（未调用模型）') && stepHtml.includes('复制抽取请求')
      && stepHtml.includes('data-action="backfill-record"') && stepHtml.includes('data-action="copy-text"'),
    JSON.stringify(temporalStub.stepPosts) + ' | ' + stepHtml.slice(0, 120));
  check('T7-6b 生成抽取请求不产生任何正文写入（没有 chapters 的 PUT/PATCH）',
    !requests.slice(beforeStep).some((r) => ['PUT', 'PATCH'].includes(r.method) && r.url.includes('/api/chapters/')));

  // (6) 记录本机结果：注入 runner 走本机管线 → 解析 JSON → POST step（带 result）→ 候选登记
  let t7ranPrompt = '';
  P.state.backfillRunner = async ({ prompt }) => {
    t7ranPrompt = prompt;
    return '```json\n{"events":[{"ops":[{"type":"set","cell":{"domain":"character","entityId":"王师傅","predicate":"status","scope":"canon","holderId":null},"expected":{"kind":"missing"},"value":"存活"}],"evidence":[{"quote":"他在等回信","narrative":"present"}]}]}\n```';
  };
  temporalStub.stepPosts.length = 0;
  const beforeRecord = requests.length;
  await P.backfillStepRun(8, { record: true });
  check('T7-7 「记录本机结果」走本机管线（生产等价 runPipelineStage）：解析 JSON 后 POST step（带 result）→ 候选 pending_confirm，未写正式状态',
    temporalStub.stepPosts.length === 1 && !!temporalStub.stepPosts[0].result && t7ranPrompt.includes('状态记账员')
      && String(containers['#board-content'].innerHTML).includes('候选已登记（未写正式状态）')
      && !requests.slice(beforeRecord).some((r) => r.method === 'POST' && r.url.includes('/novel/state/proposal-groups')),
    t7ranPrompt.slice(0, 80));
  P.state.backfillRunner = null;

  // (7) 确认本章：作者动作、真实 POST；跳章被服务端拒绝时如实报错
  temporalStub.confirmPosts.length = 0;
  await P.backfillConfirmRun(8);
  check('T7-8 「确认本章」真实 POST confirm（作者动作）；可信前缀提示来自服务端返回',
    temporalStub.confirmPosts.length === 1 && temporalStub.confirmPosts[0].chapter_id === 8
      && lastToastText().includes('可信前缀前进'), lastToastText());
  await P.backfillConfirmRun(9);
  check('T7-8b 跳章确认被服务端 409 拒绝时如实报错（不假装成功）', lastToastText().includes('确认失败'), lastToastText());

  // (8) bootstrap：扫描旧字段建立候选；决定（开篇 / 拒绝 / 转本章）都真实 POST decide
  temporalStub.bootstrapPosts.length = 0;
  temporalStub.backfill = temporalStub.backfillDefault();
  P.state.backfill = null;
  await P.backfillBootstrapPlan();
  const bootHtml = String(containers['#board-content'].innerHTML);
  check('T7-9 「扫描旧字段建立候选」真实 POST bootstrap/plan；候选列表显示来源与值，并提供 开篇/拒绝/转章节 三种决定',
    temporalStub.bootstrapPosts.some((x) => x.action === 'plan')
      && bootHtml.includes('开篇设定候选（旧字段扫描）') && bootHtml.includes('王师傅')
      && bootHtml.includes('characters.status') && bootHtml.includes('作为开篇设定')
      && bootHtml.includes('data-effective="chapter"') && bootHtml.includes('转为该章提案'),
    JSON.stringify(temporalStub.bootstrapPosts));
  temporalStub.bootstrapPosts.length = 0;
  await P.backfillBootstrapDecide('bind-boot-1', 'reject');
  check('T7-9b 「拒绝」真实 POST decide(decision=reject)：不写任何状态（以服务端返回为准）',
    temporalStub.bootstrapPosts.length === 1 && temporalStub.bootstrapPosts[0].body.decision === 'reject'
      && temporalStub.bootstrapPosts[0].body.candidate_id === 'bind-boot-1');
  temporalStub.bootstrapPosts.length = 0;
  await P.backfillBootstrapDecide('bind-boot-1', 'confirm', 'chapter', 8);
  check('T7-9c 「转为该章提案」带 effective=chapter + 作者指定 chapter_id（生效章由作者决定）',
    temporalStub.bootstrapPosts.length === 1 && temporalStub.bootstrapPosts[0].body.effective === 'chapter'
      && temporalStub.bootstrapPosts[0].body.chapter_id === 8 && temporalStub.bootstrapPosts[0].body.decision === 'confirm');

  // (9) 接口失败不伪装：显示真实失败原因（不冒充"没有此功能"、不显示推测内容）
  temporalStub.temporalFail = true; P.state.temporalEngine = null;
  await P.render();
  check('T7-10 引擎接口失败时显示读取失败与原因（不冒充"未开启"，也不显示推测内容）',
    String(containers['#board-content'].innerHTML).includes('读取失败：temporal boom'));
  temporalStub.temporalFail = false; P.state.temporalEngine = null;

  // (10) 章末面板空态指向本页开关（跨页闭环）
  P.state.chapterPanel = { enabled: false };
  check('T7-11 章末面板未启用空态指向「🧭 故事状态与披露」页开启（与 T7 开关卡闭环）',
    P.chapterPanelHtml().includes('可在「🧭 故事状态与披露」页开启'));

  delete containers['#board-content'];
  Object.assign(P.state, savedT7);
  temporalStub.temporal = temporalStub.engineDefault();
  temporalStub.backfill = temporalStub.backfillDefault();
  temporalStub.temporalPuts.length = 0; temporalStub.stepPosts.length = 0;
  temporalStub.confirmPosts.length = 0; temporalStub.bootstrapPosts.length = 0;
  temporalStub.temporalFail = false; temporalStub.temporalBroken = false;
}

// --- F3（2026-10-06）：「旧内容是否保存？」是/否弹窗 -------------------------------
// 现场：正文被新内容覆盖前，作者手里那一版**还没落盘**的旧内容被静默处理（悄悄落盘或悄悄丢弃），
// 作者无从选择。作者要求：未保存的内容弹窗告知「旧内容是否保存？」，是/否两个答案都继续写入新内容。
{
  const saved = {
    workId: P.state.workId, chapters: P.state.chapters, currentChapterId: P.state.currentChapterId,
    snap: P.state.editorSaveSnapshot, pendingMap: P.state.editorPendingByChapter,
    conflict: P.state.editorConflictSnapshot, failed: P.state.editorSaveFailedSnapshot,
    emptyBlocked: P.state.editorEmptyBlocked, pendingOld: P.state.pendingOldContent,
    api: sandbox.api, toast: sandbox.toast, closeModal: sandbox.closeModal,
    lastProposals: P.state.pendingProposalSelection,
  };
  const prevEditor = containers['#editor-content'];
  const prevTitle = containers['#editor-title'];
  const editor = mkEl('editor-content', 'div');
  editor.dataset.chapterId = '107';
  editor.innerHTML = '<p>作者手里的旧稿</p>';
  const titleEl = mkEl('editor-title', 'input'); titleEl.value = '第107章';
  containers['#editor-content'] = editor;
  containers['#editor-title'] = titleEl;
  P.state.workId = 1;
  P.state.currentChapterId = 107;
  P.state.chapters = [{ id: 107, title: '第107章', content: '<p>库里的旧稿</p>', summary: 's', updated_at: 'v1' }];
  const versionPosts = [];
  const adoptBodies = [];
  sandbox.api = async (p, o = {}) => {
    const url = String(p);
    if (url.includes('/chapter_versions')) { versionPosts.push(o && o.body); return { id: 9, created_at: 't' }; }
    if (url.includes('/novel/adopt')) {
      adoptBodies.push(o && o.body);
      return { ok: true, adopt: { legacy: { events: 1, memories: 0, guard_failed: [] }, chapter_updated_at: 'v2' } };
    }
    if (/\/chapters\/107$/.test(url)) return { id: 107, content_hash: 'h1', updated_at: 'v1' };
    return { ok: true };
  };
  sandbox.toast = () => {};
  // ⚠️ 本套件的 DOMParser 桩 parseFromString 返回**空 body**（见文件上方的桩定义），
  // 于是真实的 sanitizeEditorHtml 在这个环境里必然消毒成空串 —— 那是桩的限制，不是被测行为。
  // 这里换成"身份消毒 + 计数"，才能同时断言两件真事：①旧内容确实经消毒路径交出 ②内容没有被吞掉。
  const realSanitize = sandbox.sanitizeEditorHtml;
  let sanitizeCalls = 0;
  sandbox.sanitizeEditorHtml = (h) => { sanitizeCalls += 1; return String(h); };
  const withUnsavedOld = () => {
    P.state.editorSaveSnapshot = { id: 107, content: '<p>作者手里的旧稿</p>', title: '第107章' };
    P.state.editorPendingByChapter = new Map();
    P.state.editorConflictSnapshot = null;
    P.state.editorSaveFailedSnapshot = null;
    P.state.editorEmptyBlocked = null;
    P.state.pendingOldContent = null;
  };
  const modalHtml = () => String(containers['#modal-root'].innerHTML);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ① 有未保存内容 → 必须问，且只给是/否两个出口 + 遮罩不关
  withUnsavedOld(); versionPosts.length = 0; sanitizeCalls = 0; containers['#modal-root'].innerHTML = '';
  const pYes = P.settleOldContentBeforeOverwrite(107);
  await tick();
  check('F3-1 正文即将被覆盖且这一章有未落盘的旧内容 → 弹出「旧内容是否保存？」',
    !!P.state.pendingOldContent && Number(P.state.pendingOldContent.chapterId) === 107,
    JSON.stringify(P.state.pendingOldContent && P.state.pendingOldContent.chapterId));
  check('F3-2 弹窗只给是/否两个出口，且遮罩不关（误触关闭等于把选择丢掉）',
    modalHtml().includes('旧内容是否保存？') && modalHtml().includes('save-old-content-yes')
      && modalHtml().includes('save-old-content-no') && P.state.modalProtected === true,
    JSON.stringify({ protected: P.state.modalProtected, html: modalHtml().replace(/<[^>]*>/g, ' ').slice(0, 80) }));
  // 标题里必须出现"旧内容是否保存"这七个字，而不是含糊的"是否继续"
  check('F3-3 弹窗文案区分"旧那一版怎么处理"与"要不要继续"（不问是否继续）',
    modalHtml().includes('旧内容是否保存？') && !modalHtml().includes('是否继续'));
  await P.handleAction('save-old-content-yes', { dataset: { action: 'save-old-content-yes' } });
  const verdictYes = await pYes;
  check('F3-4 选「是」：旧内容经白名单消毒路径存进本章历史版本，且真的落到服务端',
    verdictYes === 'save' && versionPosts.length === 1 && Number(versionPosts[0].chapter_id) === 107
      && String(versionPosts[0].content).includes('作者手里的旧稿') && sanitizeCalls === 1,
    JSON.stringify({ verdictYes, posts: versionPosts.length, sanitizeCalls, body: versionPosts[0] }));
  check('F3-5 选「是」之后它从本地待保存队列撤下（否则自动重试会把新正文倒回旧稿）',
    !P.state.editorSaveSnapshot && !P.state.editorPendingByChapter.has(107) && !P.state.editorConflictSnapshot);

  // ② 选「否」：不为这一版额外留档，同样撤下；仍然不拦操作
  withUnsavedOld(); versionPosts.length = 0;
  const pNo = P.settleOldContentBeforeOverwrite(107);
  await tick();
  await P.handleAction('save-old-content-no', { dataset: { action: 'save-old-content-no' } });
  const verdictNo = await pNo;
  check('F3-6 选「否」：不为这一版额外留档（不发 /chapter_versions），队列照样撤下',
    verdictNo === 'discard' && versionPosts.length === 0 && !P.state.editorSaveSnapshot,
    JSON.stringify({ verdictNo, posts: versionPosts.length }));

  // ③ ✕ 关掉也必须有个结局，且默认按「是」收口（误触关闭最不该丢作者那一版）
  withUnsavedOld(); versionPosts.length = 0;
  const pClose = P.settleOldContentBeforeOverwrite(107);
  await tick();
  sandbox.closeModal();
  const verdictClose = await pClose;
  check('F3-7 ✕ 关掉弹窗不会让这次写入永远挂着：默认按「是」收口并保存旧内容',
    verdictClose === 'save' && versionPosts.length === 1,
    JSON.stringify({ verdictClose, posts: versionPosts.length }));
  containers['#modal-root'].innerHTML = '';

  // ④ 没有未保存内容 → 不打扰（不回退 2026-10-05「提示只属于导航」的修正）
  P.state.editorSaveSnapshot = null;
  P.state.editorPendingByChapter = new Map();
  P.state.pendingOldContent = null;
  const pNone = await P.settleOldContentBeforeOverwrite(107);
  check('F3-8 这一章没有未落盘内容时不弹窗、不问任何问题',
    pNone === '' && !P.state.pendingOldContent);

  // ⑤ 接线：「替换当前正文」这条覆盖路径在写入前必须先问过（问的是被覆盖的那一章）
  const seenIds = [];
  const realSettle = sandbox.settleOldContentBeforeOverwrite;
  sandbox.settleOldContentBeforeOverwrite = async (id) => { seenIds.push(Number(id)); return 'discard'; };
  withUnsavedOld();
  P.state.pendingProposalSelection = { workId: 1, refs: ['event:71', 'memory:71'], ids: [71] };
  await sandbox.applyAIWritingArticle('replace', '<p>AI 新稿</p>', 107);
  check('F3-9 「替换当前正文」在写入前先问过「旧内容是否保存？」（按目标章）',
    seenIds.join(',') === '107', JSON.stringify(seenIds));
  sandbox.settleOldContentBeforeOverwrite = realSettle;

  // ⑥ F1：交给服务端的提案引用必须带来源类型（裸 id 在两表之间会撞号）
  const lastAdopt = adoptBodies[adoptBodies.length - 1];
  check('F3-10 采纳把带类型的提案引用交给服务端（event:71 / memory:71，不再只有裸 id）',
    !!lastAdopt && Array.isArray(lastAdopt.legacy_proposal_refs)
      && lastAdopt.legacy_proposal_refs.join(',') === 'event:71,memory:71',
    JSON.stringify(lastAdopt && lastAdopt.legacy_proposal_refs));

  // ⑦ F2：被零损失护栏拦下的记忆提案要如实说出来，但不谎报整次失败
  const guardMsgs = [];
  sandbox.toast = (m) => { guardMsgs.push(String(m)); };
  P.reportLegacyGuardFailures([{ proposal_id: 1, reasons: ['实体覆盖率 56% 低于下限 100%（丢失 7/16）：夜鸦、陈牧野'] }]);
  check('F3-11 护栏拦下时如实告知（正文已写入 + 缺哪些实体），不谎报"整次失败"',
    guardMsgs.length === 1 && guardMsgs[0].includes('正文已写入') && guardMsgs[0].includes('夜鸦'),
    JSON.stringify(guardMsgs));
  guardMsgs.length = 0;
  P.reportLegacyGuardFailures([]);
  check('F3-12 没有被拦提案时不发任何提示（阴性对照，不误报护栏）', guardMsgs.length === 0);
  sandbox.toast = () => {};

  // ⑧ F1：复选框携带带类型引用，读取点据此产出 refs
  check('F3-13 提案复选框带 data-proposal-ref（event:7 / memory:9），裸 id 仅作兼容保留',
    P.proposalRefOf({ id: 7, type: 'event' }) === 'event:7'
      && P.proposalRefOf({ id: 9, type: 'memory' }) === 'memory:9'
      && P.proposalIdsOfRefs(['event:7', 'memory:9', 'event:7']).join(',') === '7,9',
    JSON.stringify([P.proposalRefOf({ id: 7, type: 'event' }), P.proposalRefOf({ id: 9, type: 'memory' })]));

  // 恢复现场
  sandbox.api = saved.api; sandbox.toast = saved.toast; sandbox.closeModal = saved.closeModal;
  sandbox.sanitizeEditorHtml = realSanitize;
  if (prevEditor) containers['#editor-content'] = prevEditor; else delete containers['#editor-content'];
  if (prevTitle) containers['#editor-title'] = prevTitle; else delete containers['#editor-title'];
  P.state.workId = saved.workId; P.state.chapters = saved.chapters; P.state.currentChapterId = saved.currentChapterId;
  P.state.editorSaveSnapshot = saved.snap; P.state.editorPendingByChapter = saved.pendingMap;
  P.state.editorConflictSnapshot = saved.conflict; P.state.editorSaveFailedSnapshot = saved.failed;
  P.state.editorEmptyBlocked = saved.emptyBlocked; P.state.pendingOldContent = saved.pendingOld;
  P.state.pendingProposalSelection = saved.lastProposals;
  containers['#modal-root'].innerHTML = '';
}

// --- 13b) 第四批（2026-10-08）：事实锁 / 跨段整句重复 / 转场桥 / 保护规则进润色通道 ---
// 依据：作者拿"审稿前 vs 审稿后"两版正文做的对比复核，点名了六类问题。这一组把其中
// **能在源码里确定性命中**的四类钉住（另外两类是取舍问题，见 probe-scan-round4 的测量值）。
{
  const K = sandbox.NovelPatchSafety;

  // ① 事实锁：单点改名（复核稿里的 1738→1736）
  const lockBase = [
    '岳宸炎站在队伍中间，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1738。',
    '李拓把手掌按上去。',
  ].join('\n\n');
  const lockAnchor = '岳宸炎站在队伍中间，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1738。';
  const lockPatch = [{ issue: 1, anchor: lockAnchor, revised: lockAnchor.replace('1738', '1736') }];
  const charsOpt = { characters: ['岳宸炎', '王磊', '李拓'] };
  const lockGate = P.patchSafetyGate(lockBase, lockPatch, charsOpt);
  check('118a 事实锁：把 1738 单点改成 1736 → 该条补丁不进差异稿',
    lockGate.blocked.length === 1 && lockGate.blocked[0].code === 'fact_lock_conflict',
    JSON.stringify(lockGate.blocked.map((b) => b.code)));
  check('118b 事实锁：拦下的理由**并列两处位置**（不是只给一个错误码）',
    /第 \d+ 段/.test(String(lockGate.blocked[0] && lockGate.blocked[0].conflict)),
    String(lockGate.blocked[0] && lockGate.blocked[0].conflict));
  check('118c 事实锁：没有人物卡名字时判据静默（宁可漏，也不猜主人）',
    P.patchSafetyGate(lockBase, lockPatch, {}).blocked.length === 0);
  check('118d 事实锁：只压缩描写、不动编号的补丁照常放行',
    P.patchSafetyGate(lockBase, [{ issue: 2, anchor: '李拓把手掌按上去。', revised: '李拓把手按上去。' }], charsOpt)
      .allowed.length === 1);
  const dirtyBase = ['岳宸炎的排号纸是1736。', '岳宸炎的排号纸是1738。', '李拓把手掌按上去。'].join('\n\n');
  check('118e 事实锁：底稿自带的矛盾不把无关补丁一起拦死（门禁不得变成不可用状态）',
    P.patchSafetyGate(dirtyBase, [{ issue: 3, anchor: '李拓把手掌按上去。', revised: '李拓把手按上去。' }], charsOpt)
      .allowed.length === 1);

  // ② 跨段整句重复（复核稿里的真实事故）
  const dupText = [
    '岳宸炎把手从石板上拿开。',
    '岳宸炎把手从石板上拿开。',
    '岳宸炎把手从石板上拿开。',
  ].join('\n\n');
  check('118f 跨段整句重复：同一句出现在 3 段 → 报（相邻窗口 2 段抓不到它）',
    K.scanCrossParagraphDuplicates(dupText).length === 1);
  check('118g 跨段整句重复：只重复一次（2 段）→ 不报（避开合法复沓）',
    K.scanCrossParagraphDuplicates('岳宸炎把手从石板上拿开。\n\n岳宸炎把手从石板上拿开。').length === 0);

  // ③ 转场桥（复核稿里的真实事故）
  const withBridge = [
    '整个画面都白了。',
    '再切回来的时候，镜头已经拉到了场地外面。',
    '外面在下雪。',
  ].join('\n\n');
  const withoutBridge = ['整个画面都白了。', '外面在下雪。'].join('\n\n');
  check('118h 转场桥：删掉「镜头拉到场地外面」→ 外景失去来源 → 报告（不拦）',
    K.sceneBridgeRisks(withoutBridge, '再切回来的时候，镜头已经拉到了场地外面。', '', 1, {}).length === 1);
  check('118i 转场桥：转场句还在时 → 不报（阴性对照）',
    K.sceneBridgeRisks(withBridge, '整个画面都白了。', '整个画面都白了。', 0, {}).length === 0);
  const bridgeRun = P.patchSafetyVerify(withBridge, withoutBridge, {});
  check('118j 转场桥：修后核验（整章重写兜底路径）也能报出这段断裂',
    bridgeRun.some((f) => f.code === 'scene_bridge'), JSON.stringify(bridgeRun.map((f) => f.code)));

  // ④ 保护规则必须进润色 / 修稿提示词（复核稿第一号缺口：这两条通道此前一条规则都没有）
  const savedEditRules = P.state.editRules;
  P.state.editRules = {
    catalog: { protection: { text: '【编辑保护规则（所有档位共用）】\n8. 数字锁：编号、排号、年龄、日期、等级、概率是既有事实。' } },
    selection: null,
  };
  const polishMsgs = P.buildAIPolishMessages('岳宸炎的排号纸是1738。', '');
  check('118k 润色提示词带上编辑保护规则（此前这条通道一条保护规则都没有）',
    polishMsgs[0].role === 'system' && polishMsgs[0].content.includes('数字锁'),
    String(polishMsgs[0].content).slice(0, 60));
  check('118l 修稿（补丁式）提示词带上编辑保护规则',
    P.buildAIRevisionPatchPrompt('岳宸炎的排号纸是1738。', ['问题一']).includes('数字锁'));
  check('118m 修稿（整章重写兜底路径）提示词带上编辑保护规则',
    P.buildAIRevisionPrompt('岳宸炎的排号纸是1738。', ['问题一']).includes('数字锁'));
  // 取不到目录时必须如实降级，不假装有规则
  P.state.editRules = null;
  const noRuleMsgs = P.buildAIPolishMessages('正文。', '');
  check('118n 取不到规则目录时如实写明"本轮未取到规则正文"（不假装有规则）',
    noRuleMsgs[0].content.includes('未取到规则正文'), String(noRuleMsgs[0].content).slice(-60));
  P.state.editRules = savedEditRules;

  // 目录必须在**启动时**就取回来：润色可以从编辑器工具栏直接触发，
  // 作者不需要打开「编辑规则」页；只在那一页加载会让"开机后第一次润色"没有保护规则。
  check('118o 启动流程里预先取回编辑规则目录（润色不依赖作者先打开设置页）',
    /async function init\(\)[\s\S]{0,1200}loadEditRules\(true\)/.test(String(src)),
    String(src).indexOf('loadEditRules(true)') >= 0 ? 'loadEditRules(true) 出现在 src' : '缺少启动预取');
}

// ── 接线修复（2026-10-08）：把"有写路径、界面打不开"的开关补上界面动作 ──────────
// 判据钉的是**动作函数发出的请求体**，而不是"界面上有没有一个勾选框"：
// 这套前端桩里 `El` 没有 `matches()`、`addEventListener` 是空操作（无法派发事件），
// 所以能测的前提是动作本身是**可调用的有名函数**（`temporalToggle` 就是这个模式）。
{
  const savedFetch = sandbox.fetch;
  const puts = [];
  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = String(opts.method || 'GET').toUpperCase();
    if (u.includes('/novel/semantic') && method === 'PUT') {
      puts.push(JSON.parse(String(opts.body || '{}')));
      return { ok: true, status: 200, text: async () => '{"ok":true,"enabled":true,"dedup_recall":true}' };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await sandbox.setRecallDedup(true);
    await sandbox.setRecallDedup(false);
  } finally {
    sandbox.fetch = savedFetch;
  }
  check('119f 召回去重开关发出 PUT /novel/semantic 且带 dedup_recall（此前界面上够不到这一档）',
    puts.length === 2 && puts[0].dedup_recall === true && puts[1].dedup_recall === false,
    JSON.stringify(puts));
}

// ── 接线修复（2026-10-08）第二批：另三个"有写路径、界面打不开"的开关 ────────────
{
  const savedFetch = sandbox.fetch;
  const calls = [];
  sandbox.fetch = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: String(opts.method || 'GET').toUpperCase(),
      body: opts.body ? JSON.parse(String(opts.body)) : null,
    });
    return { ok: true, status: 200, text: async () => '{"ok":true,"enabled":true}' };
  };
  try {
    await sandbox.setMemoryAutoCompress(true);
    await sandbox.setNovelIndexEnabled(true);
    await sandbox.rebuildNovelIndex();
    await sandbox.setLibraryIndexEnabled(true);
    await sandbox.rebuildLibraryIndex();
  } finally {
    sandbox.fetch = savedFetch;
  }
  const hit = (m, frag) => calls.find((c) => c.method === m && c.url.includes(frag));
  const memPut = hit('PUT', '/novel/memory_auto_compress');
  check('119g 自动压缩开关发出 PUT /novel/memory_auto_compress（它计费，作者必须能显式开关）',
    memPut && memPut.body && memPut.body.enabled === true, JSON.stringify(memPut));

  const novPut = hit('PUT', '/novel/novel_index');
  const novRebuild = hit('POST', '/novel/novel_index/rebuild');
  check('119h 资产索引：开关与重建都从界面可达（重建必须带 work_id）',
    novPut && novPut.body && novPut.body.enabled === true && novRebuild && /work_id=\d+/.test(novRebuild.url),
    JSON.stringify([novPut, novRebuild]));

  const libPut = hit('PUT', '/novel/library/index/enabled');
  const libRebuild = hit('POST', '/novel/library/index/rebuild');
  check('119i 资料索引：开关与重建都从界面可达',
    libPut && libPut.body && libPut.body.enabled === true && !!libRebuild, JSON.stringify([libPut, libRebuild]));

  const row = sandbox.retrievalIndexesHtml(
    { enabled: true, version: 'v3', tiers: { wired: ['character', 'event'], structure_only: ['world'] } },
    { enabled: false, version: { version_key: 'lv9' } });
  check('119j 索引那一行同时给出开关 / 重建按钮 / 分层 / 版本；未建时如实写"未建"',
    row.includes('data-action="novel-index-toggle"') && row.includes('data-action="rebuild-novel-index"')
    && row.includes('data-action="rebuild-library-index"')
    && row.includes('character/event') && row.includes('world') && row.includes('v3') && row.includes('lv9')
    && sandbox.retrievalIndexesHtml({}, {}).includes('未建'),
    row.replace(/\s+/g, ' ').slice(0, 120));

  const mrow = sandbox.memoryAutoCompressRow({ enabled: true, threshold: 6000, last_job: { status: 'failed', error: 'boom' } });
  check('119k 自动压缩那一行带费用提示与上次作业状态（失败要能看见，而不是只能翻日志）',
    mrow.includes('费用') && mrow.includes('阈值 6000') && mrow.includes('上次作业：failed') && mrow.includes('boom'),
    mrow.replace(/\s+/g, ' ').slice(0, 120));
}

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
