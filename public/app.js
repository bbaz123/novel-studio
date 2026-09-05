// Novel Studio - vanilla SPA
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  works: [],
  workId: null,
  work: null,
  loadedWorkId: null,
  view: 'works',
  chapters: [],
  volumes: [],
  plotlines: [],
  terms: [],
  categories: [],
  characters: [],
  relations: [],
  plotlineCharacters: [],
  worldEntries: [],
  apiConfigs: [],
  activeConfigId: Number(localStorage.getItem('ns_active_config')) || null,
  // 专项 A：默认两栏（编辑器更宽、参考面板收起，需要时再切三栏）
  editorLayout: localStorage.getItem('ns_editor_layout') || 'two',
  // 参考面板：当前页签 + 词条预览默认折叠为标题（专项 A）
  refTab: 'terms',
  refPreview: localStorage.getItem('ns_ref_preview') === '1',
  outlineMode: localStorage.getItem('ns_outline_mode') || 'mind',
  settingsTab: 'terms',
  aiTab: 'ai',
  aiCreateHomeTab: localStorage.getItem('ns_ai_create_tab') || 'auto',
  currentChapterId: null,
  currentTermId: null,
  currentCharacterId: null,
  currentPlotlineId: null,
  currentCategoryId: 'all',
  searchTimer: null,
  editorSaveTimer: null,
  savedRange: null,
  pendingAIApply: null,
  pendingAIInstruction: null,
  pendingAIQuestion: null,
  pendingAIFinal: null,
  pendingGenResult: null,
  genSelected: [],
  genSubmit: null,
  genContextCache: '',
  pipelinePaused: false,
  pipelineStopped: false,
  pipelineResume: null,
  aiContext: null,
  termsCache: new Map(),
  charsCache: new Map()
};

// 合并后的侧栏板块：小说设定 / AI创造板块（进入作品后）
// 初始页（未进入作品）另有顶层视图：works（我的作品）、ai-create（✨ AI 创作）、ai（AI 设置）
const SETTINGS_VIEWS = ['plot', 'outline', 'terms', 'characters', 'memory'];
const AI_VIEWS = ['ai-create', 'ai', 'st'];
const HOME_AI_VIEWS = ['ai-create', 'ai'];

function isSettingsView(view) {
  return view === 'settings' || SETTINGS_VIEWS.includes(view);
}

function isAIView(view) {
  return view === 'ai-board' || AI_VIEWS.includes(view);
}

// 统一跳转：把旧子页面视图映射到对应的板块；未进入作品时按初始页视图分流。
function goView(view) {
  if (SETTINGS_VIEWS.includes(view)) {
    state.settingsTab = view;
    state.view = 'settings';
  } else if (AI_VIEWS.includes(view)) {
    if (!state.workId) {
      // 初始页：仅 AI 创作 / AI 设置 两个顶层视图可用（SillyTavern 依赖作品数据）
      state.view = HOME_AI_VIEWS.includes(view) ? view : 'ai-create';
    } else if (view === 'ai-create') {
      // 作品内的 AI创造板块已不再包含 AI 创作，回退到 AI 设置
      state.aiTab = 'ai';
      state.view = 'ai-board';
    } else {
      state.aiTab = view;
      state.view = 'ai-board';
    }
  } else {
    state.view = view;
  }
}

// ---------- helpers ----------
async function api(path, options = {}) {
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const res = await fetch('/api' + path, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// D5：剧情线标题展示时剥离与 kind 重复的“主线：/支线：”前缀（兼容旧数据里已带前缀的标题）
function plotlineDisplayTitle(p) {
  return String(p?.title || '').replace(/^(?:主线|支线)\s*[:：]\s*/, '').trim() || '未命名';
}

function toast(message, type = '') {
  // D6/D14：压缩空白、限制长度，避免多行堆栈/超长文案直接糊到用户脸上；
  // 时长随内容长度缩放（最少 3 秒、最多 9 秒），完整内容放 title 悬停查看。
  const full = String(message ?? '').replace(/\s+/g, ' ').trim();
  const short = full.length > 240 ? full.slice(0, 240) + '…' : full;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = short;
  if (short !== full) el.title = full;
  $('#toast-root').appendChild(el);
  const ms = Math.min(9000, 3000 + full.length * 40);
  setTimeout(() => el.remove(), ms);
}

// 小说设定各实体弹窗的保存动作 → AI 生成回填类型映射。
const GEN_FILL_KIND_BY_ACTION = {
  'save-plotline': 'plotline',
  'save-volume': 'volume',
  'save-chapter': 'chapter',
  'save-term': 'term',
  'save-character': 'character',
  'save-relation': 'relation',
  'save-plotline-char': 'pstate'
};

// 在可生成实体的新建/编辑弹窗页脚自动插入「✨ AI 填充」按钮。
function enhanceModalGenFill() {
  const foot = $('.modal-foot');
  if (!foot) return;
  const saveBtn = foot.querySelector('[data-action^="save-"]');
  if (!saveBtn) return;
  const kind = GEN_FILL_KIND_BY_ACTION[saveBtn.dataset.action];
  if (!kind) return;
  if (foot.querySelector('[data-action="gen-fill"]')) return;
  const btn = document.createElement('button');
  btn.className = 'btn secondary';
  btn.dataset.action = 'gen-fill';
  btn.dataset.kind = kind;
  btn.textContent = '✨ AI 填充';
  btn.title = 'AI 先提问澄清后生成并回填该表单，可再修改后保存';
  foot.insertBefore(btn, saveBtn);
}

function openModal({ title, body, footer = '', large = false, onMount } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal ${large ? 'large' : ''}">
        <div class="modal-head">
          <div class="modal-title">${esc(title)}</div>
          <button class="icon-btn" data-close-modal>✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  if (onMount) onMount($('.modal-body'));
  enhanceModalGenFill();
}

function closeModal() {
  if (state.pendingAIInstruction) {
    const resolve = state.pendingAIInstruction;
    state.pendingAIInstruction = null;
    resolve(null);
  }
  if (state.pendingAIQuestion) {
    const resolve = state.pendingAIQuestion;
    state.pendingAIQuestion = null;
    resolve(null);
  }
  if (state.pendingAIFinal) {
    const resolve = state.pendingAIFinal;
    state.pendingAIFinal = null;
    resolve(null);
  }
  if (state.pendingGenResult) {
    const resolve = state.pendingGenResult;
    state.pendingGenResult = null;
    resolve(null);
  }
  if (state.pendingToolbarAIWrite) {
    const resolve = state.pendingToolbarAIWrite;
    state.pendingToolbarAIWrite = null;
    resolve(null);
  }
  $('#modal-root').innerHTML = '';
}

function collectModalData(modalEl) {
  const data = {};
  $$('[name]', modalEl).forEach((el) => {
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else data[el.name] = el.value;
  });
  return data;
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function stripHtml(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

// 把服务端返回的最新记录更新到本地 state，减少不必要的全量重新拉取，提升操作速度。
function upsertState(key, row) {
  const list = state[key];
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx >= 0) list[idx] = row;
  else list.push(row);
}

// 字数统计统一按“纯文本”口径：HTML 先剥标签再统计，与保存提示的 editor.innerText 一致（D1）。
// 避免正文含格式（加粗/H2/引用）时出现“保存说 298、加载变 431”的跳变。
function wordCount(text = '') {
  return stripHtml(text).replace(/\s/g, '').length;
}

function setSidebar(show) {
  $('#sidebar').classList.toggle('hidden', !show);
  updateSidebarToggleIcon();
}

function setTopbarTitle(text) {
  $('#topbar-title').textContent = text;
}

function updateSidebarTitle() {
  let text = state.work ? state.work.title : '我的作品';
  if (!state.workId && (state.view === 'ai-create' || state.view === 'ai')) text = 'AI 创作';
  $('#sidebar-title').textContent = text;
}

// ---------- data ----------
async function loadWorks(force = false) {
  if (force || !state.works.length) {
    state.works = await api('/works');
  }
  return state.works;
}

async function loadWorkData(force = false) {
  if (!state.workId) return;
  if (!force && state.loadedWorkId === state.workId) return;
  const workId = state.workId;
  const [work, volumes, plotlines, chapters, categories, terms, characters, relations, plotlineCharacters, worldEntries, apiConfigs] = await Promise.all([
    api(`/works/${workId}`),
    api(`/volumes?work_id=${workId}`),
    api(`/plotlines?work_id=${workId}`),
    api(`/chapters?work_id=${workId}`),
    api(`/categories?work_id=${workId}`),
    api(`/terms?work_id=${workId}`),
    api(`/characters?work_id=${workId}`),
    api(`/relations?work_id=${workId}`),
    api(`/plotline_characters?work_id=${workId}`),
    api(`/world_entries?work_id=${workId}`),
    api('/api_configs')
  ]);
  Object.assign(state, {
    work, volumes, plotlines, chapters, categories, terms,
    characters, relations, plotlineCharacters, worldEntries, apiConfigs,
    loadedWorkId: workId
  });
  state.terms.forEach((t) => state.termsCache.set(t.id, t));
  state.characters.forEach((c) => state.charsCache.set(c.id, c));
  if (!state.activeConfigId && apiConfigs.length) state.activeConfigId = apiConfigs[0].id;
}

// ---------- render dispatch ----------
function updateNavVisibility() {
  $$('#sidebar-nav button[data-view]').forEach((b) => {
    const v = b.dataset.view;
    if (v === 'works' || v === 'ai-create') {
      // 「我的作品」与「✨ AI 创作」只在未进入作品时显示
      b.classList.toggle('hidden', !!state.workId);
    } else {
      b.classList.toggle('hidden', !state.workId);
    }
  });
}

function setActiveNav() {
  $$('#sidebar-nav button').forEach((b) => {
    const v = b.dataset.view;
    let active = v === state.view;
    if (v === 'settings' && (state.view === 'settings' || SETTINGS_VIEWS.includes(state.view))) active = true;
    if (v === 'ai-board' && (state.view === 'ai-board' || AI_VIEWS.includes(state.view))) active = true;
    if (v === 'ai-create' && !state.workId && (state.view === 'ai-create' || state.view === 'ai')) active = true;
    b.classList.toggle('active', active);
  });
}

async function renderView() {
  const content = $('#content');
  if (!state.workId) {
    setSidebar(true);
    updateNavVisibility();
    // 初始页：我的作品（works）与首页 AI 视图（ai-create / ai）可切换
    if (HOME_AI_VIEWS.includes(state.view)) {
      setActiveNav();
      updateSidebarTitle();
      setTopbarTitle(state.view === 'ai-create' ? '✨ AI 创作' : 'AI 设置');
      try {
        await ensureApiConfigs();
        if (state.view === 'ai-create') return renderAICreateHome(content);
        return renderAIHome(content);
      } catch (e) {
        content.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
        return;
      }
    }
    state.view = 'works';
    updateSidebarTitle();
    setTopbarTitle('Novel Studio');
    setActiveNav();
    return renderWorks();
  }
  setSidebar(true);
  setActiveNav();
  updateNavVisibility();
  try {
    await loadWorkData();
    updateSidebarTitle();
    setTopbarTitle(state.work ? state.work.title : '作品');
    switch (state.view) {
      case 'settings':
        return renderSettingsBoard(content, state.settingsTab);
      case 'ai-board':
        return renderAIBoard(content, state.aiTab);
      case 'plot':
      case 'outline':
      case 'terms':
      case 'characters':
      case 'memory':
        return renderSettingsBoard(content, state.view);
      case 'ai-create':
      case 'ai':
      case 'st':
        return renderAIBoard(content, state.view);
      case 'writing': return renderWriting(content);
      case 'overview': return renderOverview(content);
      case 'works': return renderWorks();
      default: return renderOverview(content);
    }
  } catch (e) {
    // D13：会话记忆里的作品可能已被删除——回到初始页而不是停留在报错页。
    if (state.workId && (e.message === 'Not found' || /不存在/.test(e.message))) {
      state.workId = null;
      state.loadedWorkId = null;
      state.view = 'works';
      persistSession();
      return renderWorks();
    }
    content.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

// D13：把当前会话位置（作品/页面/当前章节等）写入 sessionStorage，刷新后自动恢复，
// 避免“写作中误刷新直接退回初始页”。
function persistSession() {
  try {
    sessionStorage.setItem('ns_session', JSON.stringify({
      workId: state.workId,
      view: state.view,
      settingsTab: state.settingsTab,
      aiTab: state.aiTab,
      aiCreateHomeTab: state.aiCreateHomeTab,
      currentChapterId: state.currentChapterId,
      currentPlotlineId: state.currentPlotlineId,
      currentTermId: state.currentTermId,
      currentCharacterId: state.currentCharacterId
    }));
  } catch (_) { /* 存储不可用时静默 */ }
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('ns_session') || 'null');
    if (!saved || !Number(saved.workId)) return;
    state.workId = Number(saved.workId);
    state.loadedWorkId = null;
    // 初始页视图在作品内没有意义，恢复为总览
    state.view = HOME_AI_VIEWS.includes(saved.view) || saved.view === 'works' ? 'overview' : (saved.view || 'overview');
    state.settingsTab = SETTINGS_VIEWS.includes(saved.settingsTab) ? saved.settingsTab : 'terms';
    state.aiTab = ['ai', 'st'].includes(saved.aiTab) ? saved.aiTab : 'ai';
    state.aiCreateHomeTab = ['auto', 'pipeline', 'history'].includes(saved.aiCreateHomeTab) ? saved.aiCreateHomeTab : 'auto';
    state.currentChapterId = Number(saved.currentChapterId) || null;
    state.currentPlotlineId = Number(saved.currentPlotlineId) || null;
    state.currentTermId = Number(saved.currentTermId) || null;
    state.currentCharacterId = Number(saved.currentCharacterId) || null;
  } catch (_) { /* 解析失败按全新会话处理 */ }
}

async function render() {
  await renderView();
  persistSession();
}

async function renderWorks() {
  const content = $('#content');
  await loadWorks();
  const works = state.works;
  let demo = null;
  try { demo = await api('/demo/status'); } catch (_) { /* 旧服务端无此接口时静默 */ }
  const demoExists = !!(demo && demo.exists);
  // D9：示例小说已在下方「🧪 示例小说」区块展示，作品列表里排除它，避免同一本书出现两次。
  const demoWorkId = demoExists && demo.work_id ? demo.work_id : null;
  const visibleWorks = demoWorkId ? works.filter((w) => w.id !== demoWorkId) : works;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">我的作品</h1>
        <div class="page-sub">管理你的所有小说项目</div>
      </div>
      <div class="page-actions">
        <button class="btn secondary" data-action="import-work">📥 导入作品</button>
        <button class="btn" data-action="new-work">＋ 新建作品</button>
      </div>
      <input type="file" id="import-file" accept=".txt,.md,.epub" hidden>
    </div>
    ${visibleWorks.length ? '' : demoWorkId
      ? '<div class="empty">还没有你自己的作品：《雾都缝匠》是下方示例数据，可直接打开体验；点击右上角“新建作品”或在左侧「✨ AI 创作」用 AI 一键生成，开始你自己的创作。</div>'
      : '<div class="empty">还没有作品：可点击右上角“新建作品”手动创建，或在左侧「✨ AI 创作」用 AI 一键生成，也可导入下方示例小说体验。</div>'}
    <div class="grid cols-3">
      ${visibleWorks.map((w) => `
        <div class="card work-card">
          <div class="work-card-main" data-action="open-work" data-id="${w.id}">
            <div class="card-title">${esc(w.title)}</div>
            <div class="desc">${esc(w.description || '暂无简介')}</div>
            <div class="muted" style="font-size:12px;margin-top:8px">更新于 ${esc((w.updated_at || '').replace('T', ' ').slice(0, 16))}</div>
          </div>
          <div class="work-card-actions">
            <button class="btn small secondary" data-action="edit-work" data-id="${w.id}">编辑</button>
            <button class="btn small danger" data-action="delete-work" data-id="${w.id}">删除</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="card mt-12">
      <div class="card-head">
        <span class="card-title">🧪 示例小说</span>
        <span class="muted" style="font-size:12px">演示 dsh 创作内核：世界观词条激活 / 角色卡 / 长期记忆 / 事件账本 / 反 AI 腔红线</span>
      </div>
      <div class="muted">《雾都缝匠》：织忆师沈砚的都市奇幻（2 卷 3 线 6 章：前 4 章含正文、后 2 章留空可续写；4 张角色卡、5 条世界观词条、伏笔与状态事件）。可随时删除。</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        ${demoExists
          ? `
            <button class="btn" data-action="demo-open" data-id="${demo.work_id}">打开《雾都缝匠》</button>
            <button class="btn small secondary" data-action="demo-reinstall" title="删除后重新导入，覆盖示例数据">重新导入</button>
            <button class="btn small danger" data-action="demo-remove">删除示例数据</button>`
          : `<button class="btn" data-action="demo-install">✨ 一键导入示例小说《雾都缝匠》</button>`}
      </div>
    </div>`;
}

// ---------- 合并板块：小说设定 ----------
const SETTINGS_TABS = [
  ['plot', '🛤️ 剧情线'],
  ['outline', '📋 大纲'],
  ['terms', '📚 设定库'],
  ['characters', '👥 角色'],
  ['memory', '🧠 长期记忆']
];

async function renderSettingsBoard(content, tab) {
  if (!SETTINGS_VIEWS.includes(tab)) tab = 'terms';
  state.settingsTab = tab;
  state.view = 'settings';
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">📘 小说设定</h1>
        <div class="page-sub">剧情线、大纲、设定、角色与长期记忆都在这里集中管理</div>
      </div>
    </div>
    <div class="board-tabs">
      ${SETTINGS_TABS.map(([key, label]) => `<button class="board-tab ${tab === key ? 'active' : ''}" data-action="board-tab" data-board="settings" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <div id="board-content" class="board-content"></div>`;
  const target = $('#board-content');
  if (tab === 'plot') await renderPlot(target);
  else if (tab === 'outline') await renderOutline(target);
  else if (tab === 'terms') await renderTerms(target);
  else if (tab === 'characters') await renderCharacters(target);
  else await renderMemory(target);
}

// ---------- 合并板块：AI创造板块（进入作品后） ----------
// AI 创作已迁移到初始页（见 renderAICreateHome / renderAIHome），这里只保留 AI 设置与 SillyTavern 设置。
const AI_TABS = [
  ['ai', '⚙️ AI 设置'],
  ['st', '🧩 SillyTavern 设置']
];

async function renderAIBoard(content, tab) {
  if (tab === 'ai-create' || !['ai', 'st'].includes(tab)) tab = 'ai';
  state.aiTab = tab;
  state.view = 'ai-board';
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🤖 AI创造板块</h1>
        <div class="page-sub">API 设置与 SillyTavern 角色/世界观设置已合并到这里</div>
      </div>
    </div>
    <div class="board-tabs">
      ${AI_TABS.map(([key, label]) => `<button class="board-tab ${tab === key ? 'active' : ''}" data-action="board-tab" data-board="ai" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <div id="board-content" class="board-content"></div>`;
  const target = $('#board-content');
  if (tab === 'ai') await renderAI(target);
  else await renderST(target);
}

// ---------- 初始页 AI 视图（未进入作品） ----------
// AI 创作从作品内的 AI创造板块迁移到初始页：创建全新作品不依赖任何已打开的作品。
// 作品内 AI创造板块不再出现 AI 创作标签。
async function ensureApiConfigs(force = false) {
  if (force || !state.apiConfigs.length) {
    state.apiConfigs = await api('/api_configs');
  }
  if (!state.activeConfigId && state.apiConfigs.length) state.activeConfigId = state.apiConfigs[0].id;
}

async function renderAICreateHome(content) {
  await ensureApiConfigs();
  return renderAICreate(content);
}

async function renderAIHome(content) {
  await ensureApiConfigs();
  await renderAI(content);
  const actions = content.querySelector('.page-head .page-actions');
  if (actions) {
    actions.insertAdjacentHTML('afterbegin', `<button class="btn secondary" data-action="go-view" data-view="ai-create">← 返回 AI 创作</button>`);
  }
}

// ---------- overview ----------
async function renderOverview(content) {
  const workId = state.workId;
  const stats = await api(`/stats?work_id=${workId}`);
  const mainPlotlines = state.plotlines.filter((p) => p.kind === 'main');
  const sidePlotlines = state.plotlines.filter((p) => p.kind === 'side');
  const recentChapters = [...state.chapters].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 8);
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(state.work.title)}</h1>
        <div class="page-sub">${esc(state.work.description || '暂无简介')}</div>
      </div>
      <div class="page-actions">
        <button class="btn secondary" data-action="export-work-txt" title="整书导出为 TXT">📤 TXT</button>
        <button class="btn secondary" data-action="export-work-md" title="整书导出为 Markdown">📤 MD</button>
        <button class="btn secondary" data-action="batch-generate">⚡ 批量生成</button>
        <button class="btn secondary" data-action="edit-work" data-id="${workId}">编辑信息</button>
        <button class="btn danger" data-action="delete-work" data-id="${workId}">删除作品</button>
        <button class="btn" data-action="new-chapter">＋ 新建章节</button>
      </div>
    </div>
    <div class="grid cols-4 mb-12">
      <div class="card stat-card"><div class="num">${stats.chapters}</div><div class="label">章节/场景</div></div>
      <div class="card stat-card"><div class="num">${stats.terms}</div><div class="label">设定词条</div></div>
      <div class="card stat-card"><div class="num">${stats.characters}</div><div class="label">角色</div></div>
      <div class="card stat-card"><div class="num">${stats.plotlines}</div><div class="label">剧情线</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <div class="card-head"><span class="card-title">剧情线</span><button class="btn small secondary" data-action="go-view" data-view="plot">管理</button></div>
        <div class="muted">主线：${mainPlotlines.map((p) => esc(plotlineDisplayTitle(p))).join('、') || '未设置'}</div>
        <div class="muted mt-8">支线：${sidePlotlines.map((p) => esc(plotlineDisplayTitle(p))).join('、') || '未设置'}</div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">最近更新</span><button class="btn small secondary" data-action="go-view" data-view="writing">去写作</button></div>
        ${recentChapters.length ? recentChapters.map((c) => `<div class="tree-item" data-action="open-chapter" data-id="${c.id}">${esc(c.title)}</div>`).join('') : '<div class="muted">暂无正文</div>'}
      </div>
    </div>`;
}

// ---------- plot view ----------
async function renderPlot(content) {
  const workId = state.workId;
  const plotlines = state.plotlines;
  if (!state.currentPlotlineId && plotlines.length) state.currentPlotlineId = plotlines[0].id;
  const selected = plotlines.find((p) => p.id === state.currentPlotlineId) || null;
  const nodes = state.chapters.filter((c) => selected && c.plotline_id === selected.id);
  content.innerHTML = `
    <div class="plot-container">
      <div class="panel plot-list-panel">
        <div class="row mb-8">
          <h3 style="margin:0">剧情线</h3>
          <div class="grow"></div>
          <button class="btn small secondary" data-action="ai-gen-plotlines-new" title="AI 生成剧情线（可一次生成多条）">✨ AI</button>
          <button class="btn small" data-action="new-plotline">＋</button>
        </div>
        ${plotlines.length ? plotlines.map((p) => `
          <div class="card plotline-card ${selected && selected.id === p.id ? 'active' : ''} mb-8" data-action="select-plotline" data-id="${p.id}">
            <div class="row">
              <span class="chip ${p.kind === 'side' ? 'warn' : ''}">${p.kind === 'main' ? '主线' : '支线'}</span>
              <b class="grow">${esc(plotlineDisplayTitle(p))}</b>
            </div>
            <div class="muted" style="font-size:12px">${esc(p.summary || '暂无简介')}</div>
            <div class="row mt-8">
              <button class="btn small secondary" data-action="edit-plotline" data-id="${p.id}">编辑</button>
              <button class="btn small danger" data-action="delete-plotline" data-id="${p.id}">删除</button>
            </div>
          </div>
        `).join('') : '<div class="empty">还没有剧情线：点击本列表右上角的 ＋ 新建第一条剧情线</div>'}
      </div>
      <div class="plot-main">
        <div class="card mb-12">
          <div class="row">
            <h3 style="margin:0">${selected ? esc(plotlineDisplayTitle(selected)) : '全局预览'}</h3>
            <div class="grow"></div>
            <button class="btn small secondary" data-action="new-chapter-with-plot" data-id="${selected ? selected.id : ''}">在此线新增章节</button>
          </div>
          <div class="muted mt-8">${selected ? esc(selected.summary || '暂无剧情简介') : (plotlines.length ? '选择左侧剧情线查看节点' : '新建剧情线后，这里会展示该线的章节节点')}</div>
        </div>
        ${!selected ? (plotlines.length ? '<div class="empty">请选择一条剧情线</div>' : '<div class="empty">还没有剧情线：点击左侧「剧情线」列表右上角的 ＋ 新建第一条剧情线</div>') : nodes.length ? `
          <div class="timeline">
            ${nodes.map((c, i) => `
              <div class="card timeline-node ${selected.kind === 'side' ? 'side' : ''}" data-action="open-chapter" data-id="${c.id}">
                <div class="row">
                  <b>${i + 1}. ${esc(c.title)}</b>
                  <span class="chip">${esc(c.volume_id ? (state.volumes.find((v) => v.id === c.volume_id)?.title || '未分卷') : '未分卷')}</span>
                </div>
                <div class="muted">${esc(c.summary || '暂无大纲摘要')}</div>
              </div>
            `).join('')}
          </div>
        ` : '<div class="empty">这条剧情线还没有节点，点击右上角新增。</div>'}
      </div>
    </div>`;
}

// ---------- outline view ----------
// 思维导图根节点：优先使用“卷”，没有卷时使用“剧情线”，最后补充未关联章节节点。
function outlineRoots() {
  const roots = [];
  if (state.volumes.length) {
    roots.push(...state.volumes.map((v) => ({ ...v, type: 'volume' })));
  } else if (state.plotlines.length) {
    roots.push(...state.plotlines.map((p) => ({ ...p, type: 'plotline' })));
  }
  const hasUnassigned = state.volumes.length
    ? state.chapters.some((c) => !c.volume_id && !c.parent_id)
    : state.plotlines.length
      ? state.chapters.some((c) => !c.plotline_id && !c.parent_id)
      : state.chapters.some((c) => !c.parent_id);
  if (hasUnassigned) {
    roots.push({ id: 'unassigned', type: 'unassigned', title: '未分卷 / 未关联', summary: '没有关联到卷或剧情线的章节' });
  }
  return roots;
}

// 获取某个根节点下的细分剧情（章节/场景）。
function outlineChildrenOf(root) {
  if (root.type === 'volume') {
    return state.chapters.filter((c) => c.volume_id === root.id && !c.parent_id);
  }
  if (root.type === 'plotline') {
    return state.chapters.filter((c) => c.plotline_id === root.id && !c.parent_id);
  }
  if (root.type === 'unassigned') {
    if (state.volumes.length) return state.chapters.filter((c) => !c.volume_id && !c.parent_id);
    return state.chapters.filter((c) => !c.plotline_id && !c.parent_id);
  }
  return [];
}

function renderOutlineList(content) {
  const volumes = state.volumes;
  const chapters = state.chapters;
  const childrenOf = (parentId) => chapters.filter((c) => (c.parent_id || null) === (parentId || null));
  const rootsOfVolume = (vid) => chapters.filter((c) => c.volume_id === vid && !c.parent_id);
  const renderNode = (c, depth = 0) => `
    <li>
      <div class="tree-item" data-action="open-chapter" data-id="${c.id}" style="padding-left:${8 + depth * 14}px">
        <span>📄</span> <span class="grow">${esc(c.title)}</span>
        <span class="muted" style="font-size:12px">${wordCount(c.content)}字</span>
        <span class="tree-actions">
          <button class="btn small secondary" data-action="edit-chapter" data-id="${c.id}">编辑</button>
          <button class="btn small danger" data-action="delete-chapter" data-id="${c.id}">删</button>
        </span>
      </div>
      ${childrenOf(c.id).length ? `<ul>${childrenOf(c.id).map((x) => renderNode(x, depth + 1)).join('')}</ul>` : ''}
    </li>`;
  content.innerHTML = `
    ${volumes.length ? volumes.map((v) => `
      <div class="card mb-12">
        <div class="card-head">
          <div>
            <span class="card-title">📚 ${esc(v.title)}</span>
            <div class="card-sub">${esc(v.summary || '暂无卷简介')}</div>
          </div>
          <div class="row">
            <button class="btn small secondary" data-action="edit-volume" data-id="${v.id}">编辑</button>
            <button class="btn small danger" data-action="delete-volume" data-id="${v.id}">删除</button>
            <button class="btn small" data-action="new-chapter-in-volume" data-id="${v.id}">＋ 章节</button>
          </div>
        </div>
        <ul class="tree">
          ${rootsOfVolume(v.id).length ? rootsOfVolume(v.id).map((c) => renderNode(c)).join('') : '<li class="muted" style="padding:6px 10px">本卷还没有章节</li>'}
        </ul>
      </div>
    `).join('') : '<div class="empty">还没有卷。可以创建卷来组织大纲。</div>'}
    <div class="card">
      <div class="card-head"><span class="card-title">未分卷章节</span><button class="btn small" data-action="new-chapter">＋ 新建</button></div>
      <ul class="tree">${chapters.filter((c) => !c.volume_id && !c.parent_id).length ? chapters.filter((c) => !c.volume_id && !c.parent_id).map((c) => renderNode(c)).join('') : '<li class="muted" style="padding:6px 10px">暂无未分卷章节</li>'}</ul>
    </div>`;
}

function renderOutlineMind(content) {
  const roots = outlineRoots();
  if (!roots.length) {
    content.innerHTML = '<div class="empty">还没有卷或剧情线。先新建卷或剧情线，思维导图会自动组织章节。</div>';
    return;
  }
  content.innerHTML = `<div class="mindmap">${roots.map((root) => {
    const children = outlineChildrenOf(root);
    return `
      <div class="mind-node" data-node-id="${root.id}" data-node-type="${root.type}">
        <div class="mind-node-head" data-action="toggle-mind-node" data-node-id="${root.id}" data-node-type="${root.type}">
          <span class="mind-node-icon">${root.type === 'volume' ? '📚' : root.type === 'unassigned' ? '📂' : '🛤️'}</span>
          <span class="grow">
            <b>${esc(root.title)}</b>
            <span class="muted" style="display:block;font-size:12px">${esc(root.summary || (root.type === 'volume' ? '卷简介' : '剧情线简介'))}</span>
          </span>
          <span class="chip">${children.length} 个细分剧情</span>
          <span class="mind-toggle">▸</span>
          <span class="tree-actions">
            ${root.type === 'unassigned' ? `
              <button class="btn small" data-action="new-chapter">＋ 新建章节</button>
            ` : `
              <button class="btn small secondary" data-action="${root.type === 'volume' ? 'edit-volume' : 'edit-plotline'}" data-id="${root.id}">编辑</button>
              <button class="btn small danger" data-action="${root.type === 'volume' ? 'delete-volume' : 'delete-plotline'}" data-id="${root.id}">删</button>
              <button class="btn small" data-action="${root.type === 'volume' ? 'new-chapter-in-volume' : 'new-chapter-with-plot'}" data-id="${root.id}">＋ 章节</button>
            `}
          </span>
        </div>
        <div class="mind-children">
          ${children.length ? children.map((c) => `
            <div class="mind-child" data-action="open-chapter" data-id="${c.id}">
              <span>📄</span>
              <span class="grow">${esc(c.title)}</span>
              <span class="muted" style="font-size:12px">${wordCount(c.content)}字</span>
              <span class="tree-actions">
                <button class="btn small secondary" data-action="edit-chapter" data-id="${c.id}">编辑</button>
                <button class="btn small danger" data-action="delete-chapter" data-id="${c.id}">删</button>
              </span>
            </div>
          `).join('') : '<div class="muted" style="padding:8px 12px">还没有细分剧情</div>'}
        </div>
      </div>`;
  }).join('')}</div>`;
}

async function renderOutline(content) {
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">大纲</h1>
        <div class="page-sub">思维导图式查看重要节点与细分剧情，点击节点展开</div>
      </div>
      <div class="page-actions">
        <button class="btn small ${state.outlineMode === 'mind' ? '' : 'secondary'}" data-action="set-outline-mode" data-mode="mind">思维导图</button>
        <button class="btn small ${state.outlineMode === 'list' ? '' : 'secondary'}" data-action="set-outline-mode" data-mode="list">列表</button>
        <button class="btn secondary" data-action="ai-gen-outline">✨ AI 大纲（整卷）</button>
        <button class="btn secondary" data-action="new-volume">＋ 新建卷</button>
        <button class="btn" data-action="new-chapter">＋ 新建章节/场景</button>
      </div>
    </div>
    <div id="outline-content"></div>`;
  const target = $('#outline-content');
  if (state.outlineMode === 'list') renderOutlineList(target);
  else renderOutlineMind(target);
}

// ---------- writing view ----------
async function renderWriting(content) {
  const chapters = state.chapters;
  const volumes = state.volumes;
  if (!state.currentChapterId && chapters.length) state.currentChapterId = chapters[0].id;
  const current = state.currentChapterId ? chapters.find((c) => c.id === state.currentChapterId) : null;
  const childrenOf = (parentId) => chapters.filter((c) => (c.parent_id || null) === (parentId || null));
  const rootsOfVolume = (vid) => chapters.filter((c) => c.volume_id === vid && !c.parent_id);

  const treeHTML = `
    <div class="row mb-8">
      <b>目录 / 大纲</b>
      <div class="grow"></div>
      <button class="btn small" data-action="new-chapter">＋</button>
    </div>
    ${volumes.length ? volumes.map((v) => `
      <div class="muted" style="padding:6px 8px">📚 ${esc(v.title)}</div>
      <ul class="tree">
        ${rootsOfVolume(v.id).length ? rootsOfVolume(v.id).map((c) => `
          <li><div class="tree-item ${current && current.id === c.id ? 'active' : ''}" data-action="open-chapter" data-id="${c.id}">📄 ${esc(c.title)}</div></li>
        `).join('') : '<li class="muted" style="padding:2px 8px">空</li>'}
      </ul>
    `).join('') : ''}
    <div class="muted" style="padding:6px 8px">未分卷</div>
    <ul class="tree">
      ${chapters.filter((c) => !c.volume_id && !c.parent_id).map((c) => `
        <li><div class="tree-item ${current && current.id === c.id ? 'active' : ''}" data-action="open-chapter" data-id="${c.id}">📄 ${esc(c.title)}</div></li>
      `).join('') || '<li class="muted" style="padding:2px 8px">暂无章节</li>'}
    </ul>`;

  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">正文写作</h1>
        <div class="page-sub">选择章节，专注写作；可随时切换单栏 / 两栏 / 三栏</div>
      </div>
      <div class="page-actions">
        <div class="row" style="gap:4px">
          <button class="btn small ${state.editorLayout === 'single' ? '' : 'secondary'}" data-action="set-layout" data-layout="single">单栏</button>
          <button class="btn small ${state.editorLayout === 'two' ? '' : 'secondary'}" data-action="set-layout" data-layout="two">两栏</button>
          <button class="btn small ${state.editorLayout === 'three' ? '' : 'secondary'}" data-action="set-layout" data-layout="three">三栏</button>
        </div>
        <button class="btn secondary" data-action="go-view" data-view="outline">大纲</button>
        <button class="btn" data-action="new-chapter">＋ 新章节</button>
      </div>
    </div>
    ${!current ? '<div class="empty">还没有章节，请先新建一个章节。</div>' : `
    <div class="writing-layout ${state.editorLayout}" id="writing-layout">
      <div class="panel panel-outline">${treeHTML}</div>
      <div class="panel panel-editor">
        <div class="editor-toolbar">
          <div class="toolbar-group" title="格式">
            <button class="btn secondary small" data-action="format" data-format="bold"><b>B</b></button>
            <button class="btn secondary small" data-action="format" data-format="italic"><i>I</i></button>
            <button class="btn secondary small" data-action="format" data-format="underline"><u>U</u></button>
            <button class="btn secondary small" data-action="format" data-format="formatBlock" data-value="h2">H2</button>
            <button class="btn secondary small" data-action="format" data-format="formatBlock" data-value="blockquote">引用</button>
            <button class="btn secondary small" data-action="format" data-format="insertUnorderedList">列表</button>
            <button class="btn secondary small" data-action="format" data-format="insertOrderedList">编号</button>
          </div>
          <span class="toolbar-sep"></span>
          <div class="toolbar-group" title="AI 生成">
            <button class="btn small" data-action="toolbar-ai-write">✍️ AI 写作</button>
            <button class="btn small secondary" data-action="toolbar-ai-polish">✨ 润色</button>
            <button class="btn small secondary" data-action="toolbar-ai-expand">📖 扩写</button>
          </div>
          <span class="toolbar-sep"></span>
          <div class="toolbar-group" title="文档操作">
            <button class="btn small" data-action="manual-save-chapter">💾 手动保存</button>
            <button class="btn small secondary" data-action="open-save-history">🕘 历史版本</button>
            <button class="btn small" data-action="link-term-modal">🔗 关联设定</button>
            <button class="btn small secondary" data-action="export-chapter-txt" data-id="${current.id}" title="导出本章为 TXT">📤 本章</button>
            ${state.editorLayout === 'single' ? `<select id="chapter-switcher" title="单栏布局下目录被隐藏，用这里切换章节" style="max-width:200px">${chapters.map((c) => `<option value="${c.id}" ${c.id === current.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}</select>` : ''}
          </div>
        </div>
        <div class="editor-meta">
          <input id="editor-title" value="${esc(current.title)}" placeholder="章节/场景标题">
        </div>
        <div id="editor-content" class="editor-content" contenteditable="true" data-chapter-id="${current.id}">${current.content || ''}</div>
        <div class="editor-status" id="editor-status"><span>已加载</span> · <span id="editor-count">${wordCount(current.content)}</span> 字</div>
      </div>
      <div class="panel panel-reference">
        <div class="reference-tabs">
          <button class="active" data-action="ref-tab" data-tab="terms">设定</button>
          <button data-action="ref-tab" data-tab="characters">角色</button>
          <button data-action="ref-tab" data-tab="foreshadows">伏笔</button>
          <button data-action="ref-tab" data-tab="redlines">红线</button>
          <button data-action="ref-tab" data-tab="context">上下文</button>
          <button data-action="ref-tab" data-tab="ai">AI</button>
          <span class="grow"></span>
          <button class="btn small secondary" data-action="ref-preview-toggle" title="展开/收起设定词条的内容预览">${state.refPreview ? '收起预览' : '展开预览'}</button>
        </div>
        <div class="reference-list" id="reference-list"></div>
      </div>
    </div>
    `}`;
  if (current) {
    renderReference('terms');
    bindEditorEvents();
  }
}

function bindEditorEvents() {
  const editor = $('#editor-content');
  if (!editor) return;
  editor.addEventListener('input', () => {
    const count = wordCount(editor.innerText || '');
    const el = $('#editor-count');
    if (el) el.textContent = count;
    scheduleSave();
  });
  editor.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.toString().trim()) {
      try { state.savedRange = sel.getRangeAt(0).cloneRange(); } catch (_) {}
    }
  });
  editor.addEventListener('keyup', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.toString().trim()) {
      try { state.savedRange = sel.getRangeAt(0).cloneRange(); } catch (_) {}
    }
  });
}

function renderReference(tab = 'terms') {
  const list = $('#reference-list');
  if (!list) return;
  state.refTab = tab;
  $$('.reference-tabs button[data-action="ref-tab"]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'terms') {
    // 专项 A：词条默认折叠为标题（一行一条），需要预览时点右上角「展开预览」
    list.innerHTML = `
      <div class="muted" style="padding:4px 2px">点击词条查看详情；写作时可选中文字后点“关联设定”</div>
      ${state.terms.slice(0, 50).map((t) => `
        <div class="reference-item" data-action="open-term" data-id="${t.id}">
          <div class="ref-title">${esc(t.title)}</div>
          ${state.refPreview ? `<div class="ref-desc">${esc((t.content || '').slice(0, 60))}</div>` : ''}
        </div>
      `).join('') || '<div class="muted">暂无设定词条</div>'}`;
  } else if (tab === 'characters') {
    list.innerHTML = `
      <div class="muted" style="padding:4px 2px">当前作品角色档案</div>
      ${state.characters.map((c) => `
        <div class="reference-item" data-action="open-character" data-id="${c.id}">
          <div class="ref-title">${esc(c.name)}</div>
          <div class="ref-desc">${esc(c.identity || c.personality || '暂无简介')}</div>
        </div>
      `).join('') || '<div class="muted">暂无角色</div>'}`;
  } else if (tab === 'foreshadows') {
    renderForeshadowTab(list);
  } else if (tab === 'redlines') {
    renderRedlineTab(list);
  } else if (tab === 'context') {
    renderContextTab(list);
  } else if (tab === 'ai') {
    list.innerHTML = `
      <div class="ai-panel">
        <label class="muted">写作指令 / 补充要求（可留空）</label>
        <textarea id="ai-prompt" placeholder="例如：写出主角第一次觉醒天赋的场景，节奏先缓后急"></textarea>
        <div class="row">
          <button class="btn small grow" data-action="ai-write">✍️ 续写/生成</button>
        </div>
        <div class="row">
          <button class="btn small secondary grow" data-action="ai-outline">📋 生成细纲</button>
          <button class="btn small secondary grow" data-action="ai-personality">🎭 性格校对</button>
        </div>
        <div id="ai-output" class="ai-output">AI 结果会显示在这里</div>
        <button class="btn small secondary" data-action="ai-insert" id="ai-insert-btn" style="display:none">插入到光标处</button>
      </div>`;
  }
}

// 参考面板「上下文」页签（v0.8.0）：预览本次实际装配的分层上下文与出场角色名单，
// 作者可勾选角色强制带入（章节级覆盖，存 chapters.context_character_ids）。
async function renderContextTab(list) {
  list.innerHTML = '<div class="muted" style="padding:4px 2px">加载中…</div>';
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || null;
  let ctx;
  try {
    ctx = await api(`/novel/context?work_id=${state.workId}${chapter ? `&chapter_id=${chapter.id}` : ''}&mode=full`);
  } catch (e) {
    list.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const sceneIds = new Set((ctx.scene_characters || []).map((c) => c.id));
  const forcedSet = new Set((ctx.scene_characters || []).filter((c) => c.forced).map((c) => c.id));
  const charRows = state.characters.map((c) => {
    const inScene = sceneIds.has(c.id);
    const forced = forcedSet.has(c.id);
    return `<label class="row tree-item context-char-row" style="gap:6px">
      <input type="checkbox" data-action="context-char-toggle" data-id="${c.id}" ${forced ? 'checked' : ''}>
      <span>${esc(c.name)}</span>
      <span class="grow muted" style="font-size:11px">${inScene ? (forced ? '👤 强制带入' : '✓ 已自动带入') : '未带入'}</span>
    </label>`;
  }).join('');
  list.innerHTML = `
    <div class="muted" style="padding:4px 2px">上下文预览：AI 实际收到的分层装配与出场角色</div>
    <div class="row mb-8" style="gap:6px">
      <button class="btn small grow" data-action="context-refresh">🔄 重新装配</button>
    </div>
    <div class="ref-group-title">出场角色（${(ctx.scene_characters || []).length}）· 勾选 = 强制带入本章</div>
    <div class="context-char-list">${charRows || '<div class="muted" style="padding:2px 4px">暂无角色</div>'}</div>
    <div class="ref-group-title">装配结果（${(ctx.assembled || '').length} 字，超层预算的截断会在文中注明）</div>
    <pre class="context-preview">${esc(ctx.assembled || '')}</pre>`;
}

function scheduleSave() {
  clearTimeout(state.editorSaveTimer);
  state.editorSaveTimer = setTimeout(saveCurrentChapter, 800);
  const status = $('#editor-status');
  if (status) status.innerHTML = '<span>编辑中...</span>';
}

// 参考面板「伏笔」页签：未闭合/已回收/已废弃分组，可跳转章节、标记状态。
async function renderForeshadowTab(list) {
  list.innerHTML = '<div class="muted" style="padding:4px 2px">加载中…</div>';
  let rows = [];
  try {
    const data = await api(`/novel/foreshadows?work_id=${state.workId}&status=all`);
    rows = data.foreshadows || [];
  } catch (e) {
    list.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const chName = (id) => state.chapters.find((c) => c.id === Number(id))?.title || '';
  const groups = [
    { label: '未闭合', items: rows.filter((f) => f.foreshadow_status !== 'resolved' && f.foreshadow_status !== 'dropped'), cls: 'open' },
    { label: '已回收', items: rows.filter((f) => f.foreshadow_status === 'resolved'), cls: 'resolved' },
    { label: '已废弃', items: rows.filter((f) => f.foreshadow_status === 'dropped'), cls: 'dropped' }
  ];
  let html = '<div class="muted" style="padding:4px 2px">伏笔账本：写作时必须照顾的“欠账”</div>';
  for (const g of groups) {
    html += `<div class="ref-group-title">${g.label}（${g.items.length}）</div>`;
    if (!g.items.length) { html += '<div class="muted" style="padding:2px 4px">无</div>'; continue; }
    for (const f of g.items) {
      const buttons = g.cls === 'open'
        ? `<button class="btn small" data-action="foreshadow-status" data-id="${f.id}" data-status="resolved">已回收</button>
           <button class="btn small secondary" data-action="foreshadow-status" data-id="${f.id}" data-status="dropped">废弃</button>`
        : `<button class="btn small secondary" data-action="foreshadow-status" data-id="${f.id}" data-status="open">恢复未闭合</button>`;
      const goto = f.chapter_id
        ? `<button class="btn small secondary" data-action="foreshadow-goto" data-id="${f.chapter_id}">跳转</button>`
        : '';
      html += `
        <div class="reference-item foreshadow-item">
          <div class="ref-title">${esc(f.summary || '（无描述）')}</div>
          <div class="ref-desc muted">埋设：${esc(chName(f.chapter_id) || '未知章节')}${f.resolves_event_id ? ' · 回收事件 #' + f.resolves_event_id : ''}</div>
          <div class="row mt-4">${goto}${buttons}</div>
        </div>`;
    }
  }
  list.innerHTML = html;
}

// 参考面板「红线」页签：当前生效的风格契约 + 管理入口。
async function renderRedlineTab(list) {
  list.innerHTML = '<div class="muted" style="padding:4px 2px">加载中…</div>';
  let rows = [];
  try {
    const data = await api(`/novel/redlines?work_id=${state.workId}`);
    rows = data.redlines || [];
  } catch (e) {
    list.innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
    return;
  }
  let html = '<div class="muted" style="padding:4px 2px">写作时必须避开的词句（反 AI 腔）</div>';
  if (!rows.length) html += '<div class="muted" style="padding:2px 4px">当前未启用任何红线规则</div>';
  for (const r of rows) {
    const kindName = r.kind === 'regex' ? '句式模式' : r.kind === 'word' ? '慎用词' : '慎用句式';
    const exceptions = (r.exceptions || []).length
      ? `<div class="ref-desc muted">豁免：${esc((r.exceptions || []).join('、'))}</div>`
      : '';
    html += `
      <div class="reference-item">
        <div class="ref-title">[${kindName}] ${esc(r.pattern)}${r.note ? `（${esc(r.note)}）` : ''}</div>
        ${exceptions}
      </div>`;
  }
  html += `<div class="row mt-8"><button class="btn small grow" data-action="redline-manage">⚙️ 管理红线</button></div>`;
  list.innerHTML = html;
}

// 红线管理弹窗：编辑当前生效清单（保存为本作品级红线，覆盖全局默认）。
function redlineRowHtml(r = {}) {
  const kindOpts = ['word', 'phrase', 'regex'].map((k) =>
    `<option value="${k}" ${(r.kind || 'phrase') === k ? 'selected' : ''}>${k === 'word' ? '慎用词' : k === 'phrase' ? '慎用句式' : '句式模式'}</option>`).join('');
  return `
    <div class="redline-row" data-redline-row>
      <div class="row">
        <select data-r-kind>${kindOpts}</select>
        <label class="muted nowrap"><input type="checkbox" data-r-enabled ${r.enabled === false ? '' : 'checked'}> 启用</label>
        <button class="btn small secondary" data-action="redline-del-row">删除</button>
      </div>
      <input data-r-pattern placeholder="词 / 句式 / 正则模式" value="${esc(r.pattern || '')}">
      <input data-r-note placeholder="说明（可选）" value="${esc(r.note || '')}">
      <input data-r-exceptions placeholder="豁免词（逗号分隔，如：眼眸,回眸,眸色）" value="${esc((r.exceptions || []).join(','))}">
    </div>`;
}

async function openRedlineManager() {
  const workId = state.workId || state.work?.id;
  if (!workId) { toast('请先进入一部作品'); return; }
  let rows = [];
  try {
    const data = await api(`/novel/redlines?work_id=${workId}`);
    rows = data.redlines || [];
  } catch (e) {
    toast('读取红线失败：' + e.message, 'error');
    return;
  }
  openModal({
    title: '⚙️ 写作红线管理',
    body: `
      <div class="muted mb-8">反 AI 腔扫描按此清单执行；豁免词用于「单字慎用词」的整词放行（如 眸 → 豁免 眼眸/回眸/眸色）。保存后成为本作品的红线清单（覆盖全局默认）。</div>
      <div id="redline-rows">${rows.map((r) => redlineRowHtml(r)).join('') || '<div class="muted" id="redline-empty">暂无红线，点下方按钮添加</div>'}</div>
      <div class="row mt-8"><button class="btn small secondary" data-action="redline-add-row">＋ 添加一条</button></div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="redline-save">保存清单</button>`,
    large: true
  });
}

function collectRedlineRows() {
  const box = $('#redline-rows');
  if (!box) return [];
  return [...box.querySelectorAll('[data-redline-row]')].map((row) => ({
    kind: row.querySelector('[data-r-kind]').value,
    pattern: row.querySelector('[data-r-pattern]').value.trim(),
    note: row.querySelector('[data-r-note]').value.trim(),
    exceptions: row.querySelector('[data-r-exceptions]').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean),
    enabled: row.querySelector('[data-r-enabled]').checked
  })).filter((r) => r.pattern);
}

async function saveRedlines() {
  const workId = state.workId || state.work?.id;
  if (!workId) return;
  try {
    await api('/novel/redlines', { method: 'PUT', body: { work_id: workId, entries: collectRedlineRows() } });
    closeModal();
    toast('红线清单已保存', 'success');
    if (state.refTab === 'redlines') renderReference('redlines');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function saveCurrentChapter() {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  if (!editor || !title) return;
  const id = Number(editor.dataset.chapterId);
  const body = {
    title: title.value || '未命名章节',
    content: editor.innerHTML,
    summary: state.chapters.find((c) => c.id === id)?.summary || ''
  };
  try {
    const updated = await api(`/chapters/${id}`, { method: 'PUT', body });
    const idx = state.chapters.findIndex((c) => c.id === id);
    if (idx >= 0) state.chapters[idx] = updated;
    const status = $('#editor-status');
    if (status) status.innerHTML = '<span class="ok">✔ 已自动保存</span> · <span>' + wordCount(editor.innerText || '') + '</span> 字';
  } catch (e) {
    const status = $('#editor-status');
    if (status) status.innerHTML = `<span class="err">保存失败：${esc(e.message)}</span>`;
  }
}

// ---------- manual save / version history ----------
async function manualSaveChapter() {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  if (!editor || !title) return;
  const id = Number(editor.dataset.chapterId);
  if (!id) return;
  try {
    await saveCurrentChapter();
    const version = await api('/chapter_versions', {
      method: 'POST',
      body: {
        chapter_id: id,
        title: title.value || '未命名章节',
        summary: state.chapters.find((c) => c.id === id)?.summary || '',
        content: editor.innerHTML
      }
    });
    toast(`已手动保存：${version.created_at || ''}`, 'success');
  } catch (e) {
    toast('手动保存失败：' + e.message, 'error');
  }
}

async function openSaveHistory() {
  const editor = $('#editor-content');
  const id = editor ? Number(editor.dataset.chapterId) : state.currentChapterId;
  if (!id) return;
  let versions = [];
  try {
    versions = await api(`/chapter_versions?chapter_id=${id}`);
  } catch (e) {
    toast('读取历史失败：' + e.message, 'error');
    return;
  }
  const body = versions.length ? versions.map((v) => `
    <div class="version-item">
      <div class="row">
        <b>${esc(v.title || '未命名章节')}</b>
        <span class="muted grow" style="font-size:12px">${esc((v.created_at || '').replace('T', ' ').slice(0, 16))}</span>
        <span class="muted" style="font-size:12px">${wordCount(v.content)}字</span>
        <button class="btn small secondary" data-action="view-version" data-id="${v.id}">查看</button>
        <button class="btn small" data-action="restore-version" data-id="${v.id}">恢复</button>
      </div>
      <div class="muted" style="font-size:12px;padding-top:4px">${esc(v.summary || '暂无摘要')}</div>
    </div>
  `).join('') : '<div class="empty">还没有手动保存记录</div>';
  openModal({
    title: '历史保存记录',
    body: `<div class="version-list">${body}</div>`,
    footer: `<button class="btn secondary" data-close-modal>关闭</button>`,
    large: false
  });
}

async function viewSaveVersion(id) {
  const editor = $('#editor-content');
  const chapterId = editor ? Number(editor.dataset.chapterId) : state.currentChapterId;
  const versions = await api(`/chapter_versions?chapter_id=${chapterId}`);
  const v = versions.find((x) => x.id === Number(id));
  if (!v) return;
  openModal({
    title: `历史版本 · ${v.title || '未命名章节'}`,
    body: `<div class="version-preview">${v.content || '<span class="muted">（空内容）</span>'}</div>`,
    footer: `<button class="btn secondary" data-close-modal>关闭</button>${v.content ? `<button class="btn" data-action="restore-version" data-id="${v.id}">恢复此版本</button>` : ''}`,
    large: true
  });
}

async function restoreSaveVersion(id) {
  if (!confirm('确定恢复该历史版本吗？当前内容会自动备份为一条新的历史记录。')) return;
  try {
    const data = await api(`/chapter_versions/${id}/restore`, {
      method: 'POST',
      body: { backup_current: true }
    });
    const updated = data.chapter;
    const idx = state.chapters.findIndex((c) => c.id === updated.id);
    if (idx >= 0) state.chapters[idx] = updated;
    state.currentChapterId = updated.id;
    state.loadedWorkId = null;
    closeModal();
    await render();
    toast('已恢复历史版本', 'success');
  } catch (e) {
    toast('恢复失败：' + e.message, 'error');
  }
}

// ---------- terms view ----------
async function renderTerms(content) {
  const categories = state.categories;
  const terms = state.terms;
  const activeCat = state.currentCategoryId;
  const filtered = terms.filter((t) => activeCat === 'all' || t.category_id === activeCat);
  const selected = state.currentTermId ? terms.find((t) => t.id === state.currentTermId) || null : null;

  content.innerHTML = `
    <div class="terms-layout">
      <div class="panel">
        <div class="row mb-8">
          <b>分类</b>
          <div class="grow"></div>
          <button class="btn small" data-action="new-category">＋</button>
        </div>
        <div class="category-item ${activeCat === 'all' ? 'active' : ''}" data-action="select-category" data-id="all">全部 <span class="muted">(${terms.length})</span></div>
        ${categories.map((c) => `
          <div class="category-item ${activeCat === c.id ? 'active' : ''}" data-action="select-category" data-id="${c.id}">
            <span class="category-dot" style="background:${esc(c.color)}"></span>
            <span class="grow">${esc(c.name)}</span>
            <span class="muted">(${terms.filter((t) => t.category_id === c.id).length})</span>
            <button class="btn small danger" data-action="delete-category" data-id="${c.id}">删</button>
          </div>
        `).join('')}
        <div class="mt-12" style="display:flex;gap:6px"><button class="btn small secondary" data-action="new-term">＋ 新建词条</button><button class="btn small secondary" data-action="ai-gen-terms-new" title="AI 生成词条（可一次生成多条）">✨ AI 词条</button></div>
      </div>
      <div class="panel terms-list">
        <div class="mb-8"><input id="term-search" placeholder="搜索词条..." value=""></div>
        ${filtered.length ? filtered.map((t) => `
          <div class="term-item ${selected && selected.id === t.id ? 'active' : ''}" data-action="select-term" data-id="${t.id}">
            <b>${esc(t.title)}</b>
            <span class="muted grow" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.tags || '')}</span>
          </div>
        `).join('') : '<div class="muted">暂无词条</div>'}
      </div>
      <div class="panel terms-detail">
        ${selected ? `
          <div class="row mb-8">
            <h3 style="margin:0">${esc(selected.title)}</h3>
            <div class="grow"></div>
            <button class="btn small secondary" data-action="edit-term" data-id="${selected.id}">编辑</button>
            <button class="btn small danger" data-action="delete-term" data-id="${selected.id}">删除</button>
          </div>
          <div class="muted mb-8">标签：${selected.tags ? selected.tags.split(',').map((t) => `<span class="chip">${esc(t.trim())}</span>`).join(' ') : '无'}</div>
          <div class="card">${esc(selected.content || '暂无详细介绍')}</div>
        ` : '<div class="empty">选择左侧词条查看详情</div>'}
      </div>
    </div>`;
}

async function openTermDetail(termId) {
  goView('terms');
  state.currentTermId = termId;
  setActiveNav();
  await render();
}

// ---------- characters view ----------
async function renderCharacters(content) {
  const characters = state.characters;
  const selected = state.currentCharacterId ? characters.find((c) => c.id === state.currentCharacterId) || null : null;
  const relations = state.relations.filter((r) => selected && (r.from_character_id === selected.id || r.to_character_id === selected.id));
  const plotlineStates = state.plotlineCharacters.filter((p) => selected && p.character_id === selected.id);

  content.innerHTML = `
    <div class="characters-layout">
      <div class="panel characters-list">
        <div class="row mb-8">
          <b>角色</b>
          <div class="grow"></div>
          <button class="btn small secondary" data-action="ai-gen-characters-new" title="AI 生成角色（完整档案，可一次生成多个）">✨ AI</button>
          <button class="btn small" data-action="new-character">＋</button>
        </div>
        <input id="character-search" placeholder="搜索角色..." class="mb-8">
        <div id="character-list">
          ${characters.map((c) => `
            <div class="character-card ${selected && selected.id === c.id ? 'active' : ''}" data-action="select-character" data-id="${c.id}">
              <span class="avatar" style="background:${esc(c.avatar_color || '#8b5cf6')}">${esc((c.name || '?').slice(0, 1))}</span>
              <div class="grow">
                <div><b>${esc(c.name)}</b></div>
                <div class="muted" style="font-size:12px">${esc(c.identity || '')}</div>
              </div>
            </div>
          `).join('') || '<div class="muted">暂无角色</div>'}
        </div>
      </div>
      <div class="panel">
        ${selected ? `
          <div class="row mb-12">
            <h3 style="margin:0">${esc(selected.name)}</h3>
            <div class="grow"></div>
            <button class="btn secondary small" data-action="edit-character" data-id="${selected.id}">编辑档案</button>
            <button class="btn secondary small" data-action="char-status-events" data-id="${selected.id}" title="查看该角色相关事件，一键同步为当前状态">⏱ 状态事件</button>
            <button class="btn small" data-action="add-relation">＋ 关系</button>
            <button class="btn small danger" data-action="delete-character" data-id="${selected.id}">删除</button>
          </div>
          <div class="grid cols-2 mb-12">
            <div class="card"><div class="muted">身份</div><div>${esc(selected.identity || '未填写')}</div></div>
            <div class="card"><div class="muted">当前状态</div><div>${esc(selected.status || '未填写')}</div></div>
          </div>
          <div class="card mb-12"><div class="muted mb-8">外貌</div><div>${esc(selected.appearance || '未填写')}</div></div>
          <div class="card mb-12"><div class="muted mb-8">性格</div><div>${esc(selected.personality || '未填写')}</div></div>
          <div class="card mb-12"><div class="muted mb-8">背景</div><div>${esc(selected.background || '未填写')}</div></div>
          <div class="card mb-12">
            <div class="card-head"><span class="card-title">人物关系</span></div>
            ${relations.length ? relations.map((r) => {
              const otherId = r.from_character_id === selected.id ? r.to_character_id : r.from_character_id;
              const other = state.characters.find((c) => c.id === otherId);
              return `<div class="row tree-item">
                <span>${esc(selected.name)}</span>
                <span class="chip">${esc(r.relation || '相关')}</span>
                <span>${esc(other ? other.name : '未知')}</span>
                <span class="grow muted">${esc(r.description || '')}</span>
                <button class="btn small danger" data-action="delete-relation" data-id="${r.id}">删</button>
              </div>`;
            }).join('') : '<div class="muted">暂无关系</div>'}
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">剧情线级状态</span></div>
            ${state.plotlines.length ? state.plotlines.map((p) => {
              const pc = state.plotlineCharacters.find((x) => x.plotline_id === p.id && x.character_id === selected.id);
              return `<div class="row tree-item">
                <span class="chip ${p.kind === 'side' ? 'warn' : ''}">${esc(p.title)}</span>
                <span class="grow muted">${esc(pc ? (pc.status + (pc.notes ? ' — ' + pc.notes : '')) : '未记录')}</span>
                <button class="btn small secondary" data-action="edit-plotline-char" data-char="${selected.id}" data-plot="${p.id}">${pc ? '编辑' : '添加'}</button>
              </div>`;
            }).join('') : '<div class="muted">暂无剧情线</div>'}
          </div>
        ` : '<div class="empty">选择左侧角色查看详情</div>'}
      </div>
    </div>`;
}

// ---------- SillyTavern 设置 ----------
function openSTCharacterModal(character = null) {
  openModal({
    title: character ? `编辑角色卡 · ${character.name}` : '新建角色卡',
    body: `
      <div class="form-grid">
        <div class="field"><label>姓名</label><input name="name" value="${esc(character?.name || '')}" placeholder="角色名"></div>
        <div class="field"><label>身份</label><input name="identity" value="${esc(character?.identity || '')}" placeholder="身份/职业/地位"></div>
        <div class="field"><label>外貌</label><input name="appearance" value="${esc(character?.appearance || '')}" placeholder="外貌描述"></div>
        <div class="field"><label>性格</label><textarea name="personality" rows="3">${esc(character?.personality || '')}</textarea></div>
        <div class="field full"><label>背景</label><textarea name="background" rows="3">${esc(character?.background || '')}</textarea></div>
        <div class="field"><label>当前状态</label><input name="status" value="${esc(character?.status || '')}" placeholder="当前状态"></div>
        <div class="field"><label>标签（逗号分隔）</label><input name="tags" value="${esc(character?.tags || '')}" placeholder="主角, 天才"></div>
        <div class="field full"><label>别名/称呼（逗号分隔，用于上下文命中）</label><input name="aliases" value="${esc(character?.aliases || '')}" placeholder="例如：云仔、李队"></div>
        <div class="field full"><label>对话示例 mes_example</label><textarea name="mes_example" rows="4" placeholder="用于教 AI 该角色怎么说话">${esc(character?.mes_example || '')}</textarea></div>
        <div class="field full"><label>系统提示 / 全局指令</label><textarea name="system_prompt" rows="4" placeholder="该角色专属的额外系统提示">${esc(character?.system_prompt || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
        <input type="hidden" name="avatar_color" value="${esc(character?.avatar_color || '#8b5cf6')}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-st-character" data-id="${character?.id || ''}">保存</button>`
  });
}

function openWorldEntryModal(entry = null) {
  openModal({
    title: entry ? `编辑世界观词条 · ${entry.title}` : '新建世界观词条',
    body: `
      <div class="form-grid">
        <div class="field full"><label>词条名</label><input name="title" value="${esc(entry?.title || '')}" placeholder="例如：灵气复苏"></div>
        <div class="field full"><label>内容</label><textarea name="content" rows="6">${esc(entry?.content || '')}</textarea></div>
        <div class="field full"><label>触发关键词（逗号分隔）</label><input name="keywords" value="${esc(entry?.keywords || '')}" placeholder="灵气, 复苏, 灵根"></div>
        <div class="field"><label>固定词条</label><label class="row"><input type="checkbox" name="is_pinned" ${Number(entry?.is_pinned) ? 'checked' : ''}> 始终带入 AI 上下文</label></div>
        <div class="field"><label>排序</label><input name="position" type="number" value="${entry?.position ?? state.worldEntries.length}"></div>
        <input type="hidden" name="work_id" value="${state.workId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-world-entry" data-id="${entry?.id || ''}">保存</button>`
  });
}

async function renderST(content) {
  const currentChapter = state.chapters.find((c) => c.id === state.currentChapterId) || null;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🧩 SillyTavern 设置</h1>
        <div class="page-sub">管理角色卡、世界观词条和作者注；长期记忆已移到“小说设定 → 长期记忆”</div>
      </div>
    </div>
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">作品作者注</span><button class="btn small secondary" data-action="ai-gen-work-note" title="AI 起草作品作者注">✨ AI 起草</button><button class="btn small" data-action="save-st-work-note">保存作品作者注</button></div>
      <textarea id="st-work-author-note" rows="3" placeholder="整部作品通用的 AI 提示，支持 {title} {work} {characters} {summary}">${esc(state.work?.author_note || '')}</textarea>
    </div>
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">章节作者注</span></div>
      ${state.chapters.length ? `
        <select id="st-chapter-select" class="mb-8">
          ${state.chapters.map((ch) => `<option value="${ch.id}" ${currentChapter?.id === ch.id ? 'selected' : ''}>${esc(ch.title)}</option>`).join('')}
        </select>
        <textarea id="st-chapter-author-note" rows="3" placeholder="当前章节额外的 AI 提示">${esc(currentChapter?.author_note || '')}</textarea>
        <div class="row mt-8">
          <span class="muted">章节级作者注会追加在作品作者注之后</span>
          <div class="grow"></div>
          <button class="btn small secondary" data-action="ai-gen-chapter-note" title="AI 起草当前章节作者注">✨ AI 起草</button>
          <button class="btn small" data-action="save-st-chapter-note" data-id="${currentChapter?.id || ''}">保存章节作者注</button>
        </div>
      ` : '<div class="muted">当前作品还没有章节</div>'}
    </div>
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">角色卡</span><button class="btn small" data-action="new-st-character">＋ 新建角色卡</button></div>
      <div class="st-character-list">
        ${state.characters.length ? state.characters.map((c) => `
          <div class="st-character-item">
            <div class="row">
              <b>${esc(c.name)}</b>
              ${c.tags ? c.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('') : ''}
              <span class="muted grow" style="font-size:12px">${esc(c.identity || '')}</span>
              <button class="btn small secondary" data-action="edit-st-character" data-id="${c.id}">编辑</button>
            </div>
            ${c.mes_example ? `<div class="muted" style="font-size:12px;padding-top:4px">对话示例：${esc(c.mes_example.slice(0, 80))}</div>` : ''}
            ${c.system_prompt ? `<div class="muted" style="font-size:12px">系统提示：${esc(c.system_prompt.slice(0, 80))}</div>` : ''}
          </div>
        `).join('') : '<div class="muted">暂无角色</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-title">世界观词条</span><button class="btn small" data-action="new-world-entry">＋ 新建词条</button></div>
      <div class="st-world-list">
        ${state.worldEntries.length ? state.worldEntries.map((w) => `
          <div class="st-world-item">
            <div class="row">
              <b>${esc(w.title)}</b>
              ${Number(w.is_pinned) ? '<span class="chip">固定</span>' : ''}
              <span class="muted grow" style="font-size:12px">${esc(w.keywords || '无关键词')}</span>
              <button class="btn small secondary" data-action="edit-world-entry" data-id="${w.id}">编辑</button>
              <button class="btn small danger" data-action="delete-world-entry" data-id="${w.id}">删</button>
            </div>
            <div class="muted" style="font-size:12px;padding-top:4px">${esc((w.content || '').slice(0, 120))}</div>
          </div>
        `).join('') : '<div class="muted">暂无世界观词条</div>'}
      </div>
    </div>`;
}

// 小说设定 → 长期记忆 / 故事摘要
async function renderMemory(content) {
  const currentChapter = state.chapters.find((c) => c.id === state.currentChapterId) || null;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🧠 长期记忆 / 故事摘要</h1>
        <div class="page-sub">记录已经发生的重要剧情、伏笔、角色状态变化，AI 写作时会自动带入，用于长篇小说记忆与上下文压缩</div>
      </div>
    </div>
    <div class="card mb-12">
      <div class="card-head">
        <span class="card-title">📚 故事记忆</span>
        <div class="row">
          <button class="btn small secondary" data-action="open-proposal-confirm" title="AI 生成任务里提交的事件/记忆提案，确认后才会写入账本">📥 待确认提案</button>
          <button class="btn small secondary" data-action="ai-gen-memory" title="AI 起草/更新长期记忆">✨ AI 起草记忆</button>
          <button class="btn small secondary" data-action="compress-story-memory">🧠 自动压缩记忆</button>
          <button class="btn small secondary" data-action="open-memory-versions" title="每次保存记忆都会留版本快照，可回滚/对比">🕘 历史版本</button>
          <button class="btn small" data-action="save-story-memory">保存记忆</button>
        </div>
      </div>
      <textarea id="story-memory-input" rows="8" placeholder="记录已经发生的重要剧情、伏笔、角色状态变化，AI 写作时会自动带入。"></textarea>
      <div class="muted mt-8">💡 这条记忆与正文写作、AI 上下文联动，保存后会在 AI 写作时作为长期记忆传入。</div>
    </div>
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">章节作者注（联动）</span></div>
      ${state.chapters.length ? `
        <select id="st-chapter-select" class="mb-8">
          ${state.chapters.map((ch) => `<option value="${ch.id}" ${currentChapter?.id === ch.id ? 'selected' : ''}>${esc(ch.title)}</option>`).join('')}
        </select>
        <textarea id="st-chapter-author-note" rows="3" placeholder="当前章节额外的 AI 提示">${esc(currentChapter?.author_note || '')}</textarea>
        <div class="row mt-8">
          <span class="muted">章节级作者注会与作品作者注一起进入 AI 上下文</span>
          <div class="grow"></div>
          <button class="btn small secondary" data-action="ai-gen-chapter-note" title="AI 起草当前章节作者注">✨ AI 起草</button>
          <button class="btn small" data-action="save-st-chapter-note" data-id="${currentChapter?.id || ''}">保存章节作者注</button>
        </div>
      ` : '<div class="muted">当前作品还没有章节</div>'}
    </div>`;
  loadStoryMemory();
}

async function loadStoryMemory() {
  const el = $('#story-memory-input');
  if (!el) return;
  try {
    const data = await api(`/story_memory?work_id=${state.workId}`);
    el.value = data.summary || '';
  } catch (_) { /* 忽略加载失败 */ }
  refreshProposalBadge();
}

// 更新「待确认提案」按钮上的数量角标（无提案时显示 0）。
async function refreshProposalBadge() {
  const btn = $('[data-action="open-proposal-confirm"]');
  if (!btn || !state.workId) return;
  try {
    const data = await api(`/novel/proposals?work_id=${state.workId}`);
    const n = (data.proposals || []).length;
    btn.textContent = n ? `📥 待确认提案（${n}）` : '📥 待确认提案';
  } catch (_) { /* 忽略 */ }
}

// 弹出提案确认框：逐条勾选采纳/忽略（事件、伏笔与记忆提案统一处理）。
async function openProposalConfirm() {
  const workId = state.workId || state.work?.id;
  if (!workId) { toast('请先进入一部作品'); return; }
  let list;
  try {
    const data = await api(`/novel/proposals?work_id=${workId}`);
    list = data.proposals || [];
  } catch (e) {
    toast('读取提案失败：' + e.message, 'error');
    return;
  }
  openModal({
    title: '📥 待确认入账提案',
    body: list.length
      ? `<div class="muted mb-8">以下内容是 AI 生成任务中提交的事件/记忆，确认后才会写入作品账本：</div>
         <div class="proposal-box">${list.map(proposalItemHtml).join('')}</div>`
      : '<div class="muted">当前没有待确认的提案。AI 写作完成后的收尾入账会先出现在这里。</div>',
    footer: list.length
      ? `<button class="btn secondary" data-close-modal>稍后处理</button>
         <button class="btn secondary" data-action="proposal-reject-selected">忽略所选</button>
         <button class="btn" data-action="proposal-apply-selected">采纳所选</button>`
      : '<button class="btn" data-close-modal>关闭</button>'
  });
}

async function settleProposalsFromModal(action) {
  const workId = state.workId || state.work?.id;
  if (!workId) return;
  const modalEl = document.querySelector('.modal');
  const checked = [...(modalEl ? modalEl.querySelectorAll('.proposal-box [data-proposal-id]:checked') : [])]
    .map((el) => Number(el.dataset.proposalId));
  try {
    const data = await api(`/novel/proposals/${action}`, { method: 'POST', body: { work_id: workId, ids: checked } });
    closeModal();
    const n = action === 'apply'
      ? ((data.applied?.events || 0) + (data.applied?.memories || 0))
      : ((data.rejected?.events || 0) + (data.rejected?.memories || 0));
    toast(action === 'apply' ? `已采纳 ${n} 条提案` : `已忽略 ${n} 条提案`, 'success');
    refreshProposalBadge();
  } catch (e) {
    toast('操作失败：' + e.message, 'error');
  }
}

async function saveStoryMemory() {
  const el = $('#story-memory-input');
  if (!el) return;
  try {
    await api('/story_memory', { method: 'PUT', body: { work_id: state.workId, summary: el.value } });
    toast('长期记忆已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

// 调用 Harness 自动把作品内容压缩成长期记忆摘要。
async function compressStoryMemory() {
  const el = $('#story-memory-input');
  if (!el) return;
  const btn = $('[data-action="compress-story-memory"]');
  if (btn) btn.disabled = true;
  try {
    const data = await api('/story_memory/compress', {
      method: 'POST',
      body: { work_id: state.workId }
    });
    el.value = data.summary || '';
    toast('长期记忆已自动压缩', 'success');
  } catch (e) {
    toast('压缩失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 记忆版本历史：列表 / 回滚 / 与当前摘要的差异预览。
async function openMemoryVersions() {
  const workId = state.workId || state.work?.id;
  if (!workId) { toast('请先进入一部作品'); return; }
  let versions = [];
  try {
    const data = await api(`/story_memory/versions?work_id=${workId}`);
    versions = data.versions || [];
  } catch (e) {
    toast('读取版本失败：' + e.message, 'error');
    return;
  }
  openModal({
    title: '🕘 记忆版本历史',
    body: versions.length
      ? `<div class="muted mb-8">每次保存/回滚都会留一份快照；回滚会把该版本写回当前记忆（并自动再记一条回滚快照）。</div>
         <div class="proposal-box">${versions.map((v) => `
           <div class="review-item">
             <div class="ref-title">版本 #${v.id} · ${esc(v.source || 'manual')}${v.note ? `（${esc(v.note)}）` : ''}</div>
             <div class="ref-desc muted">${esc(v.created_at || '')} · ${(v.summary || '').length} 字</div>
             <div class="ref-desc">${esc(String(v.summary || '').slice(0, 80))}${(v.summary || '').length > 80 ? '…' : ''}</div>
             <div class="row mt-4">
               <button class="btn small secondary" data-action="memory-version-diff" data-id="${v.id}">对比当前</button>
               <button class="btn small" data-action="memory-version-rollback" data-id="${v.id}">回滚到此版本</button>
             </div>
           </div>`).join('')}</div>`
      : '<div class="muted">还没有记忆版本。保存一次记忆后会自动留快照。</div>',
    footer: '<button class="btn" data-close-modal>关闭</button>',
    large: true
  });
}

async function rollbackMemoryVersion(id) {
  const workId = state.workId || state.work?.id;
  if (!workId) return;
  if (!confirm(`确定回滚到记忆版本 #${id} 吗？当前记忆会自动备份为一条新的历史版本。`)) return;
  try {
    const data = await api('/story_memory/rollback', { method: 'POST', body: { version_id: id } });
    toast(`已回滚（新版本 #${data.version_id}）`, 'success');
    closeModal();
    await loadStoryMemory();
  } catch (e) {
    toast('回滚失败：' + e.message, 'error');
  }
}

// 句子级差异（记忆摘要通常是一整段，按句末标点切分后做 LCS）。
function diffSentences(oldText, newText) {
  const split = (s) => String(s || '').match(/[^。！？!?…\n]*[。！？!?…\n]|[^。！？!?…\n]+$/g)
    ?.map((x) => x.trim()).filter(Boolean) || [];
  const a = split(oldText), b = split(newText);
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  if (n * m > 60000) {
    const out = [];
    for (let i = 0; i < Math.max(n, m); i++) {
      if (i < n && i < m) {
        out.push(a[i] === b[i] ? { t: 'same', x: a[i] } : { t: 'del', x: a[i] }, { t: 'add', x: b[i] });
      } else if (i < n) out.push({ t: 'del', x: a[i] });
      else out.push({ t: 'add', x: b[i] });
    }
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'same', x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', x: a[i] }); i++; }
    else { ops.push({ t: 'add', x: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: 'del', x: a[i] }); i++; }
  while (j < m) { ops.push({ t: 'add', x: b[j] }); j++; }
  return ops;
}

async function showMemoryVersionDiff(id) {
  const workId = state.workId || state.work?.id;
  if (!workId) return;
  let versions = [];
  let current = '';
  try {
    const data = await api(`/story_memory/versions?work_id=${workId}`);
    versions = data.versions || [];
    const cur = await api(`/story_memory?work_id=${workId}`);
    current = cur.summary || '';
  } catch (e) {
    toast('读取失败：' + e.message, 'error');
    return;
  }
  const v = versions.find((x) => x.id === Number(id));
  if (!v) { toast('版本不存在', 'error'); return; }
  const ops = diffSentences(v.summary, current);
  const body = ops.map((op) => {
    if (op.t === 'same') return `<div class="diff-p">${esc(op.x)}</div>`;
    if (op.t === 'del') return `<div class="diff-p diff-del">${esc(op.x)}</div>`;
    return `<div class="diff-p diff-add">${esc(op.x)}</div>`;
  }).join('');
  openModal({
    title: `🆚 记忆差异 · 版本 #${v.id} → 当前`,
    body: `<div class="muted mb-8"><span class="diff-add-inline">绿色</span>=当前新增，<span class="diff-del-inline">红色</span>=该版本有而当前没有。确认要恢复请关闭后点「回滚到此版本」。</div>
      <div class="diff-view">${body || '<div class="muted">无差异</div>'}</div>`,
    footer: '<button class="btn" data-close-modal>关闭</button>',
    large: true
  });
}

async function saveSTWorkNote() {
  const el = $('#st-work-author-note');
  if (!el) return;
  try {
    const updated = await api(`/works/${state.workId}`, { method: 'PUT', body: { author_note: el.value } });
    state.work = { ...state.work, ...updated };
    toast('作品作者注已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function saveSTChapterNote() {
  const el = $('#st-chapter-author-note');
  const id = Number($('[data-action="save-st-chapter-note"]')?.dataset.id);
  if (!el || !id) return;
  try {
    const updated = await api(`/chapters/${id}`, { method: 'PUT', body: { author_note: el.value } });
    upsertState('chapters', updated);
    toast('章节作者注已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function saveSTCharacter() {
  const modal = $('.modal');
  const data = collectModalData(modal);
  const id = $('[data-action="save-st-character"]')?.dataset.id;
  try {
    const saved = id
      ? await api(`/characters/${id}`, { method: 'PUT', body: data })
      : await api('/characters', { method: 'POST', body: data });
    upsertState('characters', saved);
    state.characters.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    state.charsCache.set(saved.id, saved);
    closeModal();
    await render();
    toast('角色卡已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function saveWorldEntry() {
  const modal = $('.modal');
  const data = collectModalData(modal);
  data.work_id = Number(data.work_id);
  data.is_pinned = data.is_pinned ? 1 : 0;
  data.position = Number(data.position || 0);
  const id = $('[data-action="save-world-entry"]')?.dataset.id;
  try {
    const saved = id
      ? await api(`/world_entries/${id}`, { method: 'PUT', body: data })
      : await api('/world_entries', { method: 'POST', body: data });
    upsertState('worldEntries', saved);
    closeModal();
    await render();
    toast('世界观词条已保存', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function deleteWorldEntry(id) {
  if (!confirm('确定删除该世界观词条？')) return;
  try {
    await api(`/world_entries/${id}`, { method: 'DELETE' });
    state.worldEntries = state.worldEntries.filter((w) => w.id !== Number(id));
    await render();
    toast('已删除', 'success');
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

// ---------- AI settings ----------
async function renderAI(content) {
  const configs = state.apiConfigs;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">AI 设置</h1>
        <div class="page-sub">管理 DeepSeek / OpenAI 兼容 API 配置</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="new-api-config">＋ 新建 API 配置</button>
      </div>
    </div>
    <div class="card mb-12">
      <div class="muted">当前使用：<b>${configs.find((c) => c.id === state.activeConfigId)?.name || '未选择'}</b></div>
      <div class="muted mt-8">API Key 只保存在本机 SQLite 数据库中，不会上传到任何第三方服务器（除你配置的 AI 服务商）。</div>
    </div>
    <div class="grid cols-2">
      ${configs.map((c) => `
        <div class="card">
          <div class="row">
            <b>${esc(c.name)}</b>
            ${state.activeConfigId === c.id ? '<span class="chip">当前</span>' : ''}
            <div class="grow"></div>
            <button class="btn small secondary" data-action="set-active-config" data-id="${c.id}">设为当前</button>
          </div>
          <div class="muted mt-8">Base URL：${esc(c.base_url)}</div>
          <div class="muted">模型：${esc(c.model)}</div>
          <div class="muted" title="最大 token 是单次生成的字数上限（1 token ≈ 0.6 个汉字），普通写作保持默认即可">温度：${c.temperature} · 最大 token：${c.max_tokens}（单次输出上限）</div>
          <div class="muted">API Key：${c.api_key ? '••••••' + esc(String(c.api_key).slice(-4)) : '未填写'}</div>
          <div class="row mt-8">
            <button class="btn small secondary" data-action="test-api-config" data-id="${c.id}">测试连接</button>
            <button class="btn small secondary" data-action="edit-api-config" data-id="${c.id}">编辑</button>
            <button class="btn small danger" data-action="delete-api-config" data-id="${c.id}">删除</button>
          </div>
        </div>
      `).join('') || '<div class="empty">还没有 API 配置</div>'}
    </div>
    <div class="card mt-12">
      <div class="card-title">提示</div>
      <div class="muted">DeepSeek 默认 Base URL：https://api.deepseek.com；兼容 OpenAI Chat Completions 格式。若使用其他服务商，可填写对应的 OpenAI 兼容地址。AI 写作/润色等任务现在优先走直连通道（秒级响应），只有需要调用创作内核（角色卡/世界观/红线）的任务才会经过 Harness。</div>
    </div>
    <div class="card mt-12">
      <div class="card-head">
        <span class="card-title">AI 报错历史（仅记录最近 5 条，重复错误自动合并）</span>
        <button class="btn small secondary" data-action="refresh-ai-errors">刷新</button>
      </div>
      <div id="ai-error-history" class="ai-error-history"><span class="muted">加载中...</span></div>
    </div>`;
  loadAIErrors();
}

const AI_ACTION_LABELS = {
  generate_novel: 'AI 自动创建小说',
  write: 'AI 写作/续写',
  polish: 'AI 润色',
  expand: 'AI 扩写',
  outline: 'AI 细纲',
  personality: 'AI 性格校对',
  chat: 'AI 对话',
  test: '连接测试',
  harness: 'Harness 深度创作',
  pipeline: '创作工作台流水线',
  'settings-gen': '小说设定 AI 生成'
};

// 拉取最近 AI 报错并渲染到 AI 设置页。
// D3：只显示一行可读错误，堆栈折叠在 details 里；同 action+message 的重复记录前端再兜底去重。
async function loadAIErrors() {
  const box = $('#ai-error-history');
  if (!box) return;
  try {
    const errors = await api('/ai_errors');
    if (!errors.length) {
      box.innerHTML = '<div class="empty">暂无 AI 报错记录</div>';
      return;
    }
    const seen = new Set();
    const rows = [];
    for (const e of errors) {
      const key = `${e.action}|${e.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(e);
    }
    box.innerHTML = rows.map((e) => `
      <div class="error-item">
        <div class="row">
          <span class="chip">${esc(AI_ACTION_LABELS[e.action] || e.action || '未知')}</span>
          <span class="muted grow" style="font-size:12px">${esc((e.created_at || '').replace('T', ' ').slice(0, 16))}</span>
          ${e.error_code ? `<span class="chip warn">${esc(e.error_code)}</span>` : ''}
        </div>
        <div class="error-message">${esc(e.message || '未知错误')}</div>
        ${e.stack ? `<details class="error-stack"><summary>查看代码位置 / 堆栈</summary><pre>${esc(e.stack)}</pre></details>` : ''}
      </div>
    `).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">加载报错历史失败：${esc(e.message || '未知错误')}</div>`;
  }
}

async function renderAICreate(content) {
  const config = state.apiConfigs.find((c) => c.id === state.activeConfigId) || state.apiConfigs[0] || null;
  const tab = state.aiCreateHomeTab;
  const sectionHidden = (key) => (key === tab ? '' : 'hidden');
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">✨ AI 创作</h1>
        <div class="page-sub">输入一段描述，AI 自动完善设定并创建一本新小说；也可以进入工作台分阶段深度创作</div>
      </div>
      <div class="page-actions">
        <button class="btn secondary" data-action="go-view" data-view="ai">🤖 AI 设置</button>
      </div>
    </div>
    <div class="board-tabs">
      <button class="board-tab ${tab === 'auto' ? 'active' : ''}" data-action="ai-create-tab" data-tab="auto">✨ 自动创建小说</button>
      <button class="board-tab ${tab === 'pipeline' ? 'active' : ''}" data-action="ai-create-tab" data-tab="pipeline">🚀 创作工作台</button>
      <button class="board-tab ${tab === 'history' ? 'active' : ''}" data-action="ai-create-tab" data-tab="history">📜 任务历史</button>
    </div>
    <div class="ai-create-section" data-section="auto" ${sectionHidden('auto')}>
      <div class="card mb-12">
        <div class="mb-8"><b>输入一段关于小说的描述</b></div>
        <textarea id="ai-create-prompt" rows="8" placeholder="例如：主角穿越到修仙世界，天生没有灵根，却意外觉醒了可以吞噬万物天赋。他从一个小家族开始，一步步走向巅峰……"></textarea>
        <div class="row mt-8">
          <span class="muted">当前 AI 配置：${config ? esc(config.name) : '未配置'}</span>
          <div class="grow"></div>
          <button class="btn" data-action="ai-create-submit" id="ai-create-submit">✨ AI 自动创建小说</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title mb-8">生成进度</div>
        <div id="ai-create-progress" class="muted">等待开始...</div>
      </div>
    </div>
    <div class="ai-create-section" data-section="pipeline" ${sectionHidden('pipeline')}>
      <div class="card">
        <div class="card-head">
          <span class="card-title">🚀 AI 创作工作台</span>
          <div class="row">
            <button class="btn secondary" data-action="pipeline-save">💾 保存为作品</button>
            <button class="btn secondary" data-action="pipeline-pause-toggle">⏸ 暂停</button>
            <button class="btn danger small" data-action="pipeline-stop">⏹ 停止</button>
            <button class="btn" data-action="harness-pipeline-start">开始深度创作</button>
          </div>
        </div>
        <div class="field mb-8"><label>创作需求</label><textarea id="pipeline-prompt" rows="4" placeholder="例如：主角穿越到修仙世界，天生没有灵根，却意外觉醒了可以吞噬万物的天赋，从一个小家族开始走向巅峰。"></textarea></div>
        <div class="row mb-8">
          <label class="muted">创作策略</label>
          <select id="pipeline-mode">
            <option value="fast">⚡ 快速</option>
            <option value="balanced" selected>⚖️ 均衡</option>
            <option value="deep">🔥 深度精修</option>
          </select>
        </div>
        <div id="pipeline-stages" class="pipeline-stages">
          ${[
            ['worldview', '🌍 世界观'],
            ['characters', '👥 角色卡'],
            ['outline', '📋 分卷/章节大纲'],
            ['chapters', '📄 正文草稿'],
            ['review', '🔍 一致性审查']
          ].map(([key, label], i) => `
            <div class="pipeline-stage" data-stage="${key}">
              <div class="row">
                <b>${i + 1}. ${label}</b>
                <span class="pipeline-status muted">等待</span>
                <span class="grow"></span>
                <button class="btn small secondary" data-action="pipeline-restart-stage" data-stage="${key}">从此重跑</button>
                <button class="btn small secondary" data-action="pipeline-copy" data-stage="${key}">复制</button>
              </div>
              <textarea class="pipeline-output" data-stage-output="${key}" rows="4" placeholder="生成结果会出现在这里，可手动修改"></textarea>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    <div class="ai-create-section" data-section="history" ${sectionHidden('history')}>
      <div class="card">
        <div class="card-head"><span class="card-title">📜 创作任务历史</span><button class="btn small secondary" data-action="refresh-creation-tasks">刷新</button></div>
        <div id="creation-task-list" class="muted">加载中...</div>
      </div>
    </div>`;
  loadCreationTasks();
}

function setAICreateProgress(steps, activeIndex, error = '') {
  const box = $('#ai-create-progress');
  if (!box) return;
  box.innerHTML = steps.map((s, i) => {
    const stateCls = i < activeIndex ? 'ok' : (i === activeIndex ? 'active' : '');
    const icon = i < activeIndex ? '✔' : (i === activeIndex ? '…' : '○');
    return `<div class="ai-step ${stateCls}"><span class="ai-step-icon">${icon}</span> ${esc(s)}</div>`;
  }).join('') + (error ? `<div class="ai-step error">✖ ${esc(error)}</div>` : '');
}

// 在进度框上追加实时耗时（D1：自动创建小说是同步长任务，至少让用户看到时间在走）
function startElapsedTicker(el, prefix = '已用时') {
  if (!el) return () => {};
  const start = Date.now();
  const span = document.createElement('span');
  span.className = 'ai-elapsed muted';
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    span.textContent = `${prefix} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  el.appendChild(span);
  return () => { clearInterval(timer); span.remove(); };
}

// ---------- AI 任务进度（D1） ----------
// harness 任务可能要跑几分钟到十几分钟：启动时弹出一张悬浮进度卡，
// 显示阶段文案、实时耗时与任务最近输出，任务结束后自动收起。
// D6：内核 stdout 先清洗再展示（过滤协议/红线等内部提示词）。
// D7：提供「停止」按钮，可中止正在运行的 harness 任务。
let aiTaskSeq = 0;
let activeAITask = null; // { seq, cancel } —— 当前进度卡对应的中止回调

// 把 dsh 内核原始输出行清洗成人话：去 ANSI 转义、盒线字符，过滤协议片段与内部提示词（D6）。
function sanitizeAITailLine(raw) {
  const line = String(raw)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[│├└─]/g, '')
    .trim();
  if (!line) return '';
  if (/[【】]/.test(line)) return ''; // 【提问】【成文】【写作风格红线】等协议/内部文本
  if (/(红线|反AI腔|redline)/i.test(line)) return '';
  return line;
}

function showAITaskProgress(stageLabel) {
  const box = $('#ai-task-progress');
  if (!box) return { update() {}, close() {}, setCancel() {}, note() {} };
  const seq = ++aiTaskSeq;
  if (activeAITask && activeAITask.seq !== seq) activeAITask = null;
  box.innerHTML = `
    <div class="ai-progress-head"><span class="spinner"></span><b>${esc(stageLabel)}</b><span class="ai-progress-time">0:00</span><button class="btn small danger ai-progress-stop" data-action="ai-task-cancel" hidden>停止</button></div>
    <div class="ai-progress-tail muted">正在启动 AI 引擎（首次运行可能需要 15–30 秒）…</div>`;
  box.hidden = false;
  const start = Date.now();
  const timeEl = box.querySelector('.ai-progress-time');
  const labelEl = box.querySelector('b');
  const tailEl = box.querySelector('.ai-progress-tail');
  const stopBtn = box.querySelector('.ai-progress-stop');
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    if (timeEl) timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  return {
    seq,
    update(tail, extraLabel) {
      if (aiTaskSeq !== seq) return; // 已被更新任务卡替换，旧任务不再写屏
      if (extraLabel && labelEl) labelEl.textContent = extraLabel;
      if (!tail || !tailEl) return;
      const lastLine = String(tail).split(/\r?\n/).map(sanitizeAITailLine).filter(Boolean).slice(-1)[0];
      if (lastLine) tailEl.textContent = lastLine.length > 160 ? lastLine.slice(0, 160) + '…' : lastLine;
    },
    note(msg) {
      if (aiTaskSeq === seq && tailEl) tailEl.textContent = msg;
    },
    setCancel(fn) {
      if (aiTaskSeq === seq) activeAITask = fn ? { seq, cancel: fn } : null;
      if (stopBtn) stopBtn.hidden = !fn;
    },
    close() {
      clearInterval(timer);
      if (activeAITask && activeAITask.seq === seq) activeAITask = null;
      if (aiTaskSeq === seq && box) {
        box.hidden = true;
        box.innerHTML = ''; // 隐藏的同时清空内容，避免残留旧任务文案
      }
    }
  };
}

// 提交 harness 任务并轮询状态直到结束。返回 { output, scan }。
async function runHarnessJob(body, stageLabel) {
  const progress = showAITaskProgress(stageLabel);
  let cancelled = false;
  const cancelledErr = () => {
    const err = new Error('任务已取消');
    err.cancelled = true;
    return err;
  };
  try {
    const started = await api('/harness/run', { method: 'POST', body });
    if (!started.job_id) {
      // 兼容旧服务端：直接返回同步结果（无取消通道，停止按钮不出现）
      return { output: started.output || '', scan: started.scan || null, proposals: started.proposals || null };
    }
    // D7：注册停止按钮 → 服务端杀掉 dsh 子进程，轮询循环随即结束
    progress.setCancel(() => {
      cancelled = true;
      progress.note('正在取消任务…');
      api('/harness/cancel', { method: 'POST', body: { job_id: started.job_id } }).catch(() => { /* 服务端取消失败时轮询仍会读到终态 */ });
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelled) throw cancelledErr(); // 用户已点停止：即使任务刚巧完成也不再采纳结果
      let job;
      try {
        job = await api(`/harness/job?id=${encodeURIComponent(started.job_id)}`);
      } catch (e) {
        if (cancelled) throw cancelledErr();
        throw new Error(`任务状态查询失败：${e.message}`);
      }
      if (cancelled) throw cancelledErr();
      progress.update(job.tail);
      if (job.status === 'done') return { output: job.output || '', scan: job.scan || null, proposals: job.proposals || null };
      if (job.status === 'cancelled') throw cancelledErr();
      if (job.status === 'failed' || job.status === 'timeout') {
        const err = new Error(job.error || (job.status === 'timeout' ? '任务超时' : '任务失败'));
        if (job.tail) err.tail = job.tail;
        throw err;
      }
    }
  } finally {
    progress.close();
  }
}

// 单轮短任务可直接走直连通道（<1s 级），不必为润色 62 个字等 60 秒。
const DIRECT_AI_ACTIONS = new Set(['polish', 'expand', 'personality', 'outline', 'chat', 'write']);

// 把 OpenAI 风格 messages 提交给 AI：优先直连通道（毫秒级），
// 没有可用 API 配置或直连失败时回退 Harness 慢通道（D9）。
async function runHarnessFromMessages(messages, options = {}) {
  const action = options.action || 'harness';
  if (DIRECT_AI_ACTIONS.has(action)) {
    if (!state.apiConfigs.length) {
      try { await ensureApiConfigs(true); } catch (_) { /* 取不到配置就回退 harness */ }
    }
    const config = state.apiConfigs.find((c) => c.id === state.activeConfigId) || state.apiConfigs[0] || null;
    if (config && config.api_key) {
      try {
        const data = await api(`/ai/${action}`, {
          method: 'POST',
          body: {
            config_id: config.id,
            messages,
            temperature: config.temperature,
            max_tokens: config.max_tokens
          }
        });
        const reply = (data.reply || '').trim();
        if (reply) return reply;
        // 思考型模型偶发“长思考但 content 为空”，视为失败并回退 harness
        console.warn('[AI] 直连通道返回空内容，回退 harness');
      } catch (e) {
        // 直连失败（Key 无效/网络异常等）自动回退 harness，保证功能可用
        console.warn(`[AI] 直连通道失败，回退 harness：${e.message}`);
      }
    }
  }
  const prompt = (messages || []).map((m) => {
    const role = m.role === 'system' ? '【系统设定】' : '【用户请求】';
    return `${role}\n${m.content}`;
  }).join('\n\n');
  // 超时按任务类型分级：整章写作（write）保留 10 分钟；单轮短任务 3 分钟即可，
  // 避免回退 harness 时让用户为一次润色白白等满 10 分钟。
  const tieredTimeout = options.timeout || (action === 'write' ? 600000 : 180000);
  const data = await runHarnessJob({
    prompt, timeout: tieredTimeout, model: options.model || undefined, action,
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: state.currentChapterId || undefined,
    mode: options.mode || undefined
  }, `${AI_ACTION_LABELS[action] || 'AI 任务'}执行中…`);
  return data.output || '';
}

// ---------- Harness 深度创作流水线 ----------
// 创作策略模式：快速 / 均衡 / 深度精修
const PIPELINE_MODE_HINTS = {
  fast: '请用简洁高效的方式输出核心内容，避免冗余，优先保证速度和可读性。',
  balanced: '请保持内容完整、结构清晰、质量稳定。',
  deep: '请进行深度思考，输出尽可能丰富、细致、高质量的内容，追求创作天花板。'
};

// 不同创作策略对应不同 DeepSeek 模型，实现真正的多模型路由。
const PIPELINE_MODEL_BY_MODE = {
  fast: {
    worldview: 'deepseek-v4-flash',
    characters: 'deepseek-v4-flash',
    outline: 'deepseek-v4-flash',
    chapters: 'deepseek-v4-flash',
    review: 'deepseek-v4-flash'
  },
  balanced: {
    worldview: 'deepseek-v4-flash',
    characters: 'deepseek-v4-flash',
    outline: 'deepseek-v4-pro',
    chapters: 'deepseek-v4-pro',
    review: 'deepseek-v4-pro'
  },
  deep: {
    worldview: 'deepseek-v4-pro',
    characters: 'deepseek-v4-pro',
    outline: 'deepseek-v4-pro',
    chapters: 'deepseek-v4-pro',
    review: 'deepseek-v4-pro'
  }
};

const PIPELINE_STAGES = [
  {
    key: 'worldview',
    label: '世界观',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位资深小说世界观架构师。请根据以下创作需求生成完整的世界观设定，包括力量体系、势力、地理、历史、核心冲突等。要求结构清晰、可直接用于小说创作。\n\n${prev}`
  },
  {
    key: 'characters',
    label: '角色卡',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位小说角色设计师。请根据以下世界观和创作需求，生成 3-6 个主要角色卡，每个角色包含姓名、身份、外貌、性格、背景、当前状态、对话示例、标签。\n\n${prev}`
  },
  {
    key: 'outline',
    label: '分卷/章节大纲',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位小说大纲策划师。请根据以下世界观和角色，设计分卷结构与每章大纲：3 卷、每卷 2-4 章（共不超过 12 章），每章用一句话（20 字内）写清核心情节。只输出大纲，不要展开正文。\n\n${prev}`
  },
  {
    key: 'chapters',
    label: '正文草稿',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位中文网络小说作家。请根据以下大纲，生成前两章的正文草稿，每章 2000-3000 字，语言流畅有网文节奏，场景、动作、心理、对话都要写足。直接输出正文，不要解释。\n\n${prev}`
  },
  {
    key: 'review',
    label: '一致性审查',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位严格的小说编辑。请检查以上世界观、角色、大纲和正文之间是否存在矛盾，只列出问题清单与修改建议（每条一行），不要重写全文。\n\n${prev}`
  }
];

function getPipelineOutput(key) {
  return $(`[data-stage-output="${key}"]`)?.value?.trim() || '';
}

function setPipelineStatus(key, text) {
  const el = $(`.pipeline-stage[data-stage="${key}"] .pipeline-status`);
  if (el) el.textContent = text;
}

function setPipelineOutput(key, text) {
  const el = $(`[data-stage-output="${key}"]`);
  if (el) el.value = text;
}

// 工作台单阶段任务：自包含的单轮文本生成（不依赖 novel 工具），优先直连通道（秒级）；
// 无可用 API 配置或直连失败/返回空内容时回退 harness，回退后若超时再自动降级重试一次精简版（D1/D9）。
// 注意：flash 等思考型模型偶发“长思考但 content 为空”，必须把空回复视为失败而不是完成。
const PIPELINE_SYSTEM = { role: 'system', content: '你是小说创作执行助手：直接输出用户要求的最终内容，不要输出思考过程、解释或开场白。' };

async function runPipelineStage(prompt, { model, stageLabel, timeout = 600000 }) {
  if (!state.apiConfigs.length) {
    try { await ensureApiConfigs(true); } catch (_) { /* 取不到配置就回退 harness */ }
  }
  const config = state.apiConfigs.find((c) => c.id === state.activeConfigId) || state.apiConfigs[0] || null;
  if (config && config.api_key) {
    const tryDirect = async (userContent) => {
      const data = await api('/ai/pipeline', {
        method: 'POST',
        body: {
          config_id: config.id,
          model,
          messages: [PIPELINE_SYSTEM, { role: 'user', content: userContent }],
          max_tokens: 16384
        }
      });
      return (data.reply || '').trim();
    };
    let reply = '';
    try { reply = await tryDirect(prompt); } catch (e) { console.warn(`[AI] 工作台直连失败：${e.message}`); }
    if (!reply) {
      // 空回复（思考型模型偶发）：追加“直接输出”指令重试一次
      try { reply = await tryDirect(prompt + '\n\n（请直接输出最终结果内容，不要任何思考与解释。）'); }
      catch (e) { console.warn(`[AI] 工作台直连重试失败：${e.message}`); }
    }
    if (reply) return reply;
    console.warn('[AI] 工作台直连返回空内容，回退 harness');
  }
  try {
    const data = await runHarnessJob({ prompt, timeout, model, action: 'pipeline' }, stageLabel);
    const output = (data.output || '').trim();
    if (!output) throw new Error('AI 未返回内容');
    return output;
  } catch (e) {
    // 超时降级：换用压缩篇幅的精简版指令重试一次，避免整个流水线卡死在一个阶段
    if (/超时/.test(e.message || '')) {
      const data = await runHarnessJob({
        prompt: `${prompt}\n\n（重要：上一轮因超时未完成。请直接输出精简版结果，篇幅压缩到一半以内，不要遗漏要点。）`,
        timeout, model, action: 'pipeline'
      }, `${stageLabel}（超时重试 · 精简版）`);
      const output = (data.output || '').trim();
      if (!output) throw new Error('AI 未返回内容');
      return output;
    }
    throw e;
  }
}

// 按阶段依次调用 Harness，自动推进完整创作流水线。
function pipelineWaitIfPaused() {
  if (!state.pipelinePaused && !state.pipelineStopped) return Promise.resolve();
  return new Promise((resolve) => {
    state.pipelineResume = resolve;
  });
}

function togglePipelinePause() {
  state.pipelinePaused = !state.pipelinePaused;
  const btn = $('[data-action="pipeline-pause-toggle"]');
  if (btn) btn.textContent = state.pipelinePaused ? '▶ 继续' : '⏸ 暂停';
  if (!state.pipelinePaused && state.pipelineResume) {
    const resolve = state.pipelineResume;
    state.pipelineResume = null;
    resolve();
  }
}

function stopPipeline() {
  state.pipelineStopped = true;
  state.pipelinePaused = false;
  if (state.pipelineResume) {
    const resolve = state.pipelineResume;
    state.pipelineResume = null;
    resolve();
  }
  const btn = $('[data-action="pipeline-pause-toggle"]');
  if (btn) btn.textContent = '⏸ 暂停';
}

async function runHarnessPipeline(startIndex = 0) {
  const input = $('#pipeline-prompt')?.value?.trim();
  if (!input) {
    toast('请输入创作需求', 'error');
    return;
  }
  const mode = $('#pipeline-mode')?.value || 'balanced';
  state.pipelinePaused = false;
  state.pipelineStopped = false;
  state.pipelineResume = null;
  const btn = $('[data-action="harness-pipeline-start"]');
  if (btn) btn.disabled = true;
  let taskId = null;
  try {
    const task = await api('/creation_tasks', {
      method: 'POST',
      body: { prompt: input, status: 'running', stages_json: '{}' }
    });
    taskId = task.id;

    const stages = {};
    let previous = `创作需求：\n${input}\n`;
    for (let i = 0; i < startIndex; i++) {
      const output = getPipelineOutput(PIPELINE_STAGES[i].key);
      if (output) {
        stages[PIPELINE_STAGES[i].key] = output;
        previous += `\n【${PIPELINE_STAGES[i].label}】\n${output}\n`;
      }
    }

    for (let i = startIndex; i < PIPELINE_STAGES.length; i++) {
      if (state.pipelineStopped) break;
      const stage = PIPELINE_STAGES[i];
      setPipelineStatus(stage.key, '运行中...');
      const output = await runPipelineStage(stage.build(input, previous, mode), {
        model: PIPELINE_MODEL_BY_MODE[mode]?.[stage.key] || undefined,
        stageLabel: `创作工作台 · ${stage.label}（${i + 1}/${PIPELINE_STAGES.length}）`
      });
      setPipelineOutput(stage.key, output);
      setPipelineStatus(stage.key, state.pipelineStopped ? '已停止' : (state.pipelinePaused ? '已暂停' : '完成 ✔'));
      stages[stage.key] = output;
      previous += `\n【${stage.label}】\n${output}\n`;
      await api(`/creation_tasks/${taskId}`, {
        method: 'PUT',
        body: {
          status: state.pipelineStopped ? 'stopped' : 'running',
          stages_json: JSON.stringify(stages),
          result_json: JSON.stringify(stages)
        }
      });
      await pipelineWaitIfPaused();
      if (state.pipelineStopped) break;
    }

    const finalStatus = state.pipelineStopped ? 'stopped' : 'completed';
    await api(`/creation_tasks/${taskId}`, {
      method: 'PUT',
      body: { status: finalStatus, stages_json: JSON.stringify(stages), result_json: JSON.stringify(stages) }
    });

    if (state.pipelineStopped) toast('已停止', 'success');
    else toast('深度创作完成', 'success');
  } catch (e) {
    toast(e.cancelled ? '已取消创作任务' : '创作失败：' + e.message, e.cancelled ? 'success' : 'error');
    if (taskId) {
      try {
        await api(`/creation_tasks/${taskId}`, {
          method: 'PUT',
          body: { status: 'failed', error: e.message }
        });
      } catch (_) { /* 忽略记录失败 */ }
    }
    const active = PIPELINE_STAGES.find((s) => $(`.pipeline-stage[data-stage="${s.key}"] .pipeline-status`)?.textContent === '运行中...');
    if (active) setPipelineStatus(active.key, '失败 ✖');
  } finally {
    state.pipelinePaused = false;
    state.pipelineStopped = false;
    state.pipelineResume = null;
    if (btn) btn.disabled = false;
    const pauseBtn = $('[data-action="pipeline-pause-toggle"]');
    if (pauseBtn) pauseBtn.textContent = '⏸ 暂停';
  }
}

// 加载创作任务历史列表。
async function loadCreationTasks() {
  const box = $('#creation-task-list');
  if (!box) return;
  try {
    const tasks = await api('/creation_tasks');
    box.innerHTML = tasks.length ? tasks.map((t) => `
      <div class="creation-task-item">
        <div class="row">
          <span class="chip ${t.status === 'failed' ? 'warn' : ''}">${esc(t.status || '')}</span>
          <span class="muted grow" style="font-size:12px">${esc((t.created_at || '').replace('T', ' ').slice(0, 16))}</span>
          <span class="muted" style="font-size:12px">${esc((t.prompt || '').slice(0, 60))}</span>
        </div>
        ${t.error ? `<div class="muted" style="color:var(--danger);font-size:12px">${esc(t.error)}</div>` : ''}
      </div>
    `).join('') : '<div class="muted">暂无创作任务</div>';
  } catch (_) {
    box.innerHTML = '<div class="muted">加载失败</div>';
  }
}

// 从某个阶段开始重新生成，并清空该阶段及之后的内容。
async function restartPipelineFromStage(key) {
  const index = PIPELINE_STAGES.findIndex((s) => s.key === key);
  if (index < 0) return;
  for (let i = index; i < PIPELINE_STAGES.length; i++) {
    setPipelineOutput(PIPELINE_STAGES[i].key, '');
    setPipelineStatus(PIPELINE_STAGES[i].key, '等待');
  }
  await runHarnessPipeline(index);
}

// 把工作台生成的成果保存为 Novel Studio 作品。
async function savePipelineToWork() {
  const worldview = getPipelineOutput('worldview');
  const outline = getPipelineOutput('outline');
  const chapters = getPipelineOutput('chapters');
  const prompt = $('#pipeline-prompt')?.value?.trim() || '';
  if (!worldview && !chapters) {
    toast('请先生成创作内容再保存', 'error');
    return;
  }
  // 作品标题：取大纲/正文第一行，剥离 markdown 标记与“卷X：/第X章：”前缀（复测发现标题会泄漏 “### 卷一：哑沙回声”）
  const cleanTitleLine = (s) => String(s)
    .replace(/^#+\s*/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  let firstLine = (outline || chapters || '').split('\n').map(cleanTitleLine).find((s) => s.length > 1) || '';
  firstLine = firstLine.replace(/^(?:第[一二三四五六七八九十百0-9]+[卷部章节]|[卷章])[：:]\s*/, '');
  const title = (firstLine || prompt.slice(0, 12) || '工作台创作成果').slice(0, 30);
  // D4：简介取“可读摘要”（剥 Markdown 标记，取第一个非空段落），不要把整篇世界观原文塞进作品简介。
  const markdownSnippet = (text = '') => {
    const plain = String(text || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_`~]/g, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const first = plain.find((p) => p.length > 0) || '';
    return first.length > 160 ? first.slice(0, 160) + '…' : first;
  };
  const description = markdownSnippet(worldview || chapters || '');
  try {
    const work = await api('/works', { method: 'POST', body: { title, description } });
    if (outline) {
      await api('/volumes', { method: 'POST', body: { work_id: work.id, title: '第一卷', summary: outline.slice(0, 300), position: 0 } });
    }
    if (chapters) {
      await api('/chapters', {
        method: 'POST',
        body: {
          work_id: work.id,
          title: '创作工作台成果',
          summary: (outline || '').slice(0, 200),
          content: chapters,
          position: 0
        }
      });
    }
    toast('已保存为作品', 'success');
    await loadWorks(true);
    state.workId = work.id;
    state.loadedWorkId = null;
    state.view = 'overview';
    await render();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

// ---------- modals / forms ----------
function openWorkModal(work = null) {
  const structOpts = ['', '三幕结构', '起承转合', '英雄之旅', '网文式升级流'];
  const povOpts = ['', '第一人称', '第三人称有限视角', '第三人称全知视角', '多视角切换'];
  openModal({
    title: work ? '编辑作品' : '新建作品',
    body: `
      <div class="form-grid">
        <div class="field full"><label>作品名称</label><input name="title" value="${esc(work?.title || '')}" placeholder="例如：我的第一本小说"></div>
        <div class="field full"><label>简介</label><textarea name="description" rows="4" placeholder="作品简介、核心卖点等">${esc(work?.description || '')}</textarea></div>
        <div class="field"><label>每章目标字数</label><input name="default_chapter_words" type="number" min="500" max="20000" step="100" value="${Number(work?.default_chapter_words) || 2000}" title="AI 写作按此字数生成整章，成文不足会自动续写补足"></div>
        <div class="field"><label>总章数（0=未规划）</label><input name="total_chapters" type="number" min="0" max="5000" value="${Number(work?.total_chapters) || 0}" title="供大纲与蓝图生成参考"></div>
        <div class="field"><label>故事结构</label>
          <select name="story_structure">${structOpts.map((s) => `<option value="${esc(s)}" ${(work?.story_structure || '') === s ? 'selected' : ''}>${esc(s || '（未设置）')}</option>`).join('')}</select>
        </div>
        <div class="field"><label>叙事视角</label>
          <select name="narrative_pov">${povOpts.map((s) => `<option value="${esc(s)}" ${(work?.narrative_pov || '') === s ? 'selected' : ''}>${esc(s || '（未设置）')}</option>`).join('')}</select>
        </div>
        <div class="field full"><label>正向风格要求（可选）</label><textarea name="style_positive" rows="3" placeholder="例如：白描克制、长镜头感、对话留白——会随写作红线一起进入 AI 写作上下文">${esc(work?.style_positive || '')}</textarea></div>
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-work" data-id="${work?.id || ''}">保存</button>`
  });
}

function openVolumeModal(volume = null, workId = state.workId) {
  openModal({
    title: volume ? '编辑卷' : '新建卷',
    body: `
      <div class="form-grid">
        <div class="field full"><label>卷名</label><input name="title" value="${esc(volume?.title || '')}" placeholder="第一卷：启程"></div>
        <div class="field full"><label>卷简介</label><textarea name="summary" rows="4">${esc(volume?.summary || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${workId}">
        <input type="hidden" name="position" value="${volume?.position ?? state.volumes.length}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-volume" data-id="${volume?.id || ''}">保存</button>`
  });
}

function openPlotlineModal(plotline = null) {
  openModal({
    title: plotline ? '编辑剧情线' : '新建剧情线',
    body: `
      <div class="form-grid">
        <div class="field full"><label>名称</label><input name="title" value="${esc(plotline?.title || '')}" placeholder="例如：少年觉醒（无需输入“主线/支线”前缀）"></div>
        <div class="field"><label>类型</label>
          <select name="kind">
            <option value="main" ${plotline?.kind === 'main' ? 'selected' : ''}>主线</option>
            <option value="side" ${plotline?.kind === 'side' ? 'selected' : ''}>支线</option>
          </select>
        </div>
        <div class="field"><label>排序</label><input name="position" type="number" value="${plotline?.position ?? state.plotlines.length}"></div>
        <div class="field full"><label>简介</label><textarea name="summary" rows="4">${esc(plotline?.summary || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-plotline" data-id="${plotline?.id || ''}">保存</button>`
  });
}

function openChapterModal(chapter = null, defaults = {}) {
  const volumes = state.volumes;
  const plotlines = state.plotlines;
  openModal({
    title: chapter ? '编辑章节/场景' : '新建章节/场景',
    body: `
      <div class="form-grid">
        <div class="field full"><label>标题</label><input name="title" value="${esc(chapter?.title || '')}" placeholder="章节/场景标题"></div>
        <div class="field"><label>所属卷</label>
          <select name="volume_id">
            <option value="">未分卷</option>
            ${volumes.map((v) => `<option value="${v.id}" ${String(chapter?.volume_id ?? defaults.volume_id ?? '') === String(v.id) ? 'selected' : ''}>${esc(v.title)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>剧情线</label>
          <select name="plotline_id">
            <option value="">不关联</option>
            ${plotlines.map((p) => `<option value="${p.id}" ${String(chapter?.plotline_id ?? defaults.plotline_id ?? '') === String(p.id) ? 'selected' : ''}>${esc(plotlineDisplayTitle(p))}</option>`).join('')}
          </select>
        </div>
        <div class="field full"><label>大纲摘要</label><textarea name="summary" rows="4">${esc(chapter?.summary || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
        <input type="hidden" name="position" value="${chapter?.position ?? state.chapters.length}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-chapter" data-id="${chapter?.id || ''}">保存</button>`
  });
}

function openCategoryModal() {
  openModal({
    title: '新建分类',
    body: `
      <div class="form-grid">
        <div class="field"><label>分类名</label><input name="name" placeholder="例如：能力体系"></div>
        <div class="field"><label>颜色</label><input name="color" type="color" value="#6366f1"></div>
        <input type="hidden" name="work_id" value="${state.workId}">
        <input type="hidden" name="position" value="${state.categories.length}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-category">保存</button>`
  });
}

function openTermModal(term = null) {
  openModal({
    title: term ? '编辑词条' : '新建词条',
    body: `
      <div class="form-grid">
        <div class="field"><label>词条名</label><input name="title" value="${esc(term?.title || '')}" placeholder="例如：天赋"></div>
        <div class="field"><label>分类</label>
          <select name="category_id">
            <option value="">未分类</option>
            ${state.categories.map((c) => `<option value="${c.id}" ${term?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field full"><label>标签（逗号分隔）</label><input name="tags" value="${esc(term?.tags || '')}" placeholder="力量, 设定, 天赋"></div>
        <div class="field full"><label>详细介绍</label><textarea name="content" rows="12">${esc(term?.content || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-term" data-id="${term?.id || ''}">保存</button>`
  });
}

function openCharacterModal(character = null) {
  openModal({
    title: character ? '编辑角色档案' : '新建角色',
    body: `
      <div class="form-grid">
        <div class="field"><label>姓名</label><input name="name" value="${esc(character?.name || '')}" placeholder="角色名"></div>
        <div class="field"><label>头像颜色</label><input name="avatar_color" type="color" value="${esc(character?.avatar_color || '#8b5cf6')}"></div>
        <div class="field full"><label>身份</label><input name="identity" value="${esc(character?.identity || '')}" placeholder="身份/职业/地位"></div>
        <div class="field full"><label>外貌</label><textarea name="appearance" rows="3">${esc(character?.appearance || '')}</textarea></div>
        <div class="field full"><label>性格</label><textarea name="personality" rows="4">${esc(character?.personality || '')}</textarea></div>
        <div class="field full"><label>背景</label><textarea name="background" rows="5">${esc(character?.background || '')}</textarea></div>
        <div class="field full"><label>当前状态</label><textarea name="status" rows="2">${esc(character?.status || '')}</textarea></div>
        <div class="field full"><label>标签（逗号分隔）</label><input name="tags" value="${esc(character?.tags || '')}" placeholder="主角, 天才"></div>
        <div class="field full"><label>别名/称呼（逗号分隔，用于上下文命中）</label><input name="aliases" value="${esc(character?.aliases || '')}" placeholder="例如：云仔、李队"></div>
        <div class="field full"><label>对话示例 mes_example</label><textarea name="mes_example" rows="3">${esc(character?.mes_example || '')}</textarea></div>
        <div class="field full"><label>系统提示 / 全局指令</label><textarea name="system_prompt" rows="3">${esc(character?.system_prompt || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-character" data-id="${character?.id || ''}">保存</button>`
  });
}

// 角色状态事件（v0.8.0）：列出与该角色相关的事件账本记录，一键把某条事件同步为角色卡“当前状态”。
async function openCharStatusEvents(characterId) {
  const character = state.characters.find((c) => c.id === characterId);
  if (!character) return;
  let rows = [];
  try {
    const data = await api(`/novel/events?work_id=${state.workId}&limit=100`);
    const events = data.events || [];
    rows = events.filter((e) => String(e.summary || '').includes(character.name)).slice(0, 12);
  } catch (e) {
    toast('加载失败：' + e.message, 'error');
    return;
  }
  openModal({
    title: `状态事件 · ${character.name}`,
    large: true,
    body: rows.length ? `<div>${rows.map((e) => `
      <div class="row tree-item">
        <div class="grow">
          <div>[${esc(e.kind)}] ${esc(e.summary)}</div>
          <div class="muted" style="font-size:11px">${esc(e.created_at || '')}</div>
        </div>
        <button class="btn small" data-action="char-status-sync" data-char="${character.id}" data-event="${e.id}">同步为当前状态</button>
      </div>`).join('')}</div>`
      : '<div class="muted">该角色暂时没有相关事件记录。成文后让 AI 用 novel_event_add(kind="character") 记录状态变化，再回来一键同步。</div>',
    footer: '<button class="btn secondary" data-close-modal>关闭</button>'
  });
}

function openRelationModal(characterId) {
  const others = state.characters.filter((c) => c.id !== characterId);
  openModal({
    title: '添加人物关系',
    body: `
      <div class="form-grid">
        <div class="field"><label>当前角色</label><input value="${esc(state.characters.find((c) => c.id === characterId)?.name || '')}" disabled></div>
        <div class="field"><label>关联角色</label>
          <select name="to_character_id">
            ${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') || '<option value="">无其他角色</option>'}
          </select>
        </div>
        <div class="field full"><label>关系</label><input name="relation" placeholder="例如：师徒 / 宿敌 / 恋人"></div>
        <div class="field full"><label>描述</label><textarea name="description" rows="3"></textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
        <input type="hidden" name="from_character_id" value="${characterId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-relation">保存</button>`
  });
}

function openPlotlineCharModal(characterId, plotlineId) {
  const existing = state.plotlineCharacters.find((p) => p.character_id === characterId && p.plotline_id === plotlineId);
  const plotline = state.plotlines.find((p) => p.id === plotlineId);
  openModal({
    title: `剧情线状态 · ${plotline?.title || ''}`,
    body: `
      <div class="form-grid">
        <div class="field full"><label>状态</label><input name="status" value="${esc(existing?.status || '')}" placeholder="例如：初入宗门、实力觉醒期"></div>
        <div class="field full"><label>备注</label><textarea name="notes" rows="4">${esc(existing?.notes || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
        <input type="hidden" name="plotline_id" value="${plotlineId}">
        <input type="hidden" name="character_id" value="${characterId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-plotline-char" data-id="${existing?.id || ''}">保存</button>`
  });
}

// 模型选择下拉：提供 DeepSeek 全部已知模型，默认推荐 deepseek-v4-pro；
// 若配置里存的是列表外的自定义模型（其他 OpenAI 兼容服务商），额外显示为“当前使用”选项。
const KNOWN_AI_MODELS = [
  ['deepseek-v4-pro', 'deepseek-v4-pro（推荐 · 质量最高）'],
  ['deepseek-v4-flash', 'deepseek-v4-flash（快速 · 成本低）'],
  ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision-exp（视觉实验版）'],
  ['deepseek-chat', 'deepseek-chat（V3 通用对话）'],
  ['deepseek-reasoner', 'deepseek-reasoner（R 深度推理）']
];

function modelSelectHtml(currentModel) {
  const cur = String(currentModel || '').trim().toLowerCase();
  const hasCustom = cur && !KNOWN_AI_MODELS.some(([v]) => v === cur);
  const options = KNOWN_AI_MODELS
    .map(([v, label]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  const custom = hasCustom
    ? `<option value="${esc(currentModel)}" selected>${esc(currentModel)}（当前使用 · 自定义）</option>`
    : '';
  return `<select name="model">${custom}${options}</select>`;
}

function openApiConfigModal(config = null) {
  openModal({
    title: config ? '编辑 API 配置' : '新建 API 配置',
    body: `
      <div class="form-grid">
        <div class="field full"><label>配置名称</label><input name="name" value="${esc(config?.name || '')}" placeholder="例如：DeepSeek 主账号"></div>
        <div class="field full"><label>Base URL</label><input name="base_url" value="${esc(config?.base_url || 'https://api.deepseek.com')}" placeholder="https://api.deepseek.com"></div>
        <div class="field"><label>API Key</label><input name="api_key" value="${esc(config?.api_key || '')}" placeholder="sk-..."></div>
        <div class="field"><label>模型</label>${modelSelectHtml(config?.model || 'deepseek-v4-pro')}</div>
        <div class="field"><label>温度</label><input name="temperature" type="number" step="0.1" min="0" max="2" value="${config?.temperature ?? 0.8}"></div>
        <div class="field"><label>最大 Token（单次输出字数上限，1 token ≈ 0.6 个汉字）</label><input name="max_tokens" type="number" min="1" value="${config?.max_tokens ?? 4096}"></div>
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-api-config" data-id="${config?.id || ''}">保存</button>`
  });
}

// ---------- AI functions ----------
// 加载当前章节的 AI 上下文：角色卡、激活的世界观词条、作者注。
async function loadAIContext() {
  if (!state.currentChapterId) {
    state.aiContext = null;
    return null;
  }
  try {
    state.aiContext = await api(`/ai_context?chapter_id=${state.currentChapterId}`);
  } catch (_) {
    state.aiContext = null;
  }
  return state.aiContext;
}

// 渲染 AI 上下文预览 HTML。
function renderAIContextPreview() {
  const ctx = state.aiContext;
  if (!ctx) return '<div class="muted">暂无 AI 上下文</div>';
  const chars = ctx.characters?.length
    ? ctx.characters.map((c) => `<div>【${esc(c.name)}】${esc(c.identity || '')}${c.mes_example ? ` <span class="muted">对话示例：${esc(c.mes_example.slice(0, 50))}</span>` : ''}</div>`).join('')
    : '<span class="muted">无</span>';
  const worlds = ctx.world_entries?.length
    ? ctx.world_entries.map((w) => `<div>【${esc(w.title)}】${esc((w.content || '').slice(0, 80))}</div>`).join('')
    : '<span class="muted">无</span>';
  const notes = [ctx.work_author_note, ctx.chapter_author_note].filter(Boolean).map((n) => `<div>${esc(n.slice(0, 120))}</div>`).join('') || '<span class="muted">无</span>';
  const bp = ctx.chapter?.blueprint && Object.keys(ctx.chapter.blueprint).length
    ? `<div>【场景目标】${esc(ctx.chapter.blueprint.scene_goal || '—').slice(0, 120)}</div>
       <div>【情节点】${esc((ctx.chapter.blueprint.plot_points || '—').slice(0, 160))}</div>
       <div>【钩子】${esc((ctx.chapter.blueprint.hook || '—').slice(0, 120))}</div>`
    : '<span class="muted">无（AI 写作时自动生成）</span>';
  return `
    <div class="ai-context-section"><b>本章蓝图 · 目标 ${ctx.chapter?.target_words || ctx.work?.default_chapter_words || 2000} 字</b><div>${bp}</div></div>
    <div class="ai-context-section"><b>角色卡</b><div>${chars}</div></div>
    <div class="ai-context-section"><b>世界观</b><div>${worlds}</div></div>
    <div class="ai-context-section"><b>作者注</b><div>${notes}</div></div>`;
}

// 弹出 AI 指令输入框，同时展示本次将带入的上下文。
function askAIInstruction(title, placeholder) {
  return new Promise((resolve) => {
    state.pendingAIInstruction = resolve;
    openModal({
      title,
      body: `
        <div class="ai-context-preview">${renderAIContextPreview()}</div>
        <div class="field mt-12"><label>额外要求（可留空）</label><textarea id="ai-instruction-input" rows="3" placeholder="${esc(placeholder)}"></textarea></div>`,
      footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="confirm-ai-instruction">开始</button>`
    });
  });
}

// 把 AI 上下文格式化成可读文本，注入到 AI 消息中。
function aiContextBlock() {
  const ctx = state.aiContext;
  if (!ctx) return '';
  const parts = [];
  if (ctx.characters?.length) {
    const charText = ctx.characters.map((c) => {
      let s = `【${c.name}】身份：${c.identity || ''}；性格：${c.personality || ''}；背景：${c.background || ''}；当前状态：${c.status || ''}`;
      if (c.mes_example) s += `\n对话示例：${c.mes_example}`;
      if (c.system_prompt) s += `\n角色系统提示：${c.system_prompt}`;
      return s;
    }).join('\n');
    parts.push(`角色卡：\n${charText}`);
  }
  if (ctx.world_entries?.length) {
    const worldText = ctx.world_entries.map((w) => `【${w.title}】${w.content}`).join('\n');
    parts.push(`世界观设定：\n${worldText}`);
  }
  if (ctx.story_memory) {
    parts.push(`长期记忆/故事摘要：\n${ctx.story_memory}`);
  }
  const notes = [ctx.work_author_note, ctx.chapter_author_note].filter(Boolean).join('\n');
  if (notes) parts.push(`作者注：\n${notes}`);
  // 本章蓝图与目标字数（写作的常驻锚点）
  const bp = ctx.chapter?.blueprint;
  if (bp && Object.keys(bp).length) {
    const bpText = [
      bp.scene_goal && `场景目标：${bp.scene_goal}`,
      bp.plot_points && `情节点：${bp.plot_points}`,
      bp.conflicts && `冲突与转折：${bp.conflicts}`,
      bp.character_changes && `出场角色状态变化：${bp.character_changes}`,
      bp.hook && `下一章钩子：${bp.hook}`,
      bp.references && `参考设定：${bp.references}`
    ].filter(Boolean).join('\n');
    if (bpText) parts.push(`【本章蓝图 · 写作必须遵守】\n${bpText}`);
  }
  parts.push(`每章目标字数：${ctx.chapter?.target_words || ctx.work?.default_chapter_words || 2000} 字（成文不足时请主动写满，不要输出残章）`);
  if (ctx.work?.story_structure) parts.push(`故事结构：${ctx.work.story_structure}`);
  if (ctx.work?.narrative_pov) parts.push(`叙事视角：${ctx.work.narrative_pov}`);
  // 创作内核注入：前文衔接 + 最近事件 + 反 AI 腔红线（若服务端已提供）
  if (ctx.story_tail) parts.push(`前文衔接（上一节/当前节尾部）：\n${ctx.story_tail.slice(0, 1500)}`);
  if (ctx.recent_events?.length) {
    parts.push(`最近发生的事件：\n${ctx.recent_events.slice(0, 12).map((e) => `- [${e.kind}] ${e.summary.slice(0, 150)}`).join('\n')}`);
  }
  if (ctx.style_contract) parts.push(ctx.style_contract);
  return parts.join('\n\n');
}

function buildAIWriteMessages(extraPrompt = '') {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  const chapterId = state.currentChapterId;
  const chapter = state.chapters.find((c) => c.id === chapterId) || {};
  const content = editor?.innerHTML || chapter.content || '';
  const plain = stripHtml(content);
  const linkedTermIds = Array.from(new Set(Array.from(content.matchAll(/data-term-id="(\d+)"/g)).map((m) => Number(m[1]))));
  const terms = linkedTermIds.map((id) => state.termsCache.get(id)).filter(Boolean);
  const chars = state.characters.slice(0, 12);
  const panelPrompt = $('#ai-prompt')?.value?.trim() || '';
  const prompt = extraPrompt || panelPrompt;
  const customPrompt = prompt ? `\n写作指令：${prompt}` : '';

  const system = `你是资深中文网络小说创作助手。你熟悉网文爽点、节奏、人物塑造和世界观设定。请输出自然流畅的中文小说正文或细纲，不要输出解释性前言。`;
  const user = `
当前作品：${state.work?.title || ''}
当前章节/场景：${title?.value || chapter.title || ''}
大纲摘要：${chapter.summary || '无'}
当前正文（前文）：
${plain.slice(-4000)}

相关设定词条：
${terms.map((t) => `【${t.title}】${t.content}`).join('\n') || '无'}

主要角色档案：
${chars.map((c) => `【${c.name}】身份：${c.identity}；性格：${c.personality}；当前状态：${c.status}`).join('\n') || '无'}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}
${customPrompt}

请结合以上上下文，生成符合故事走向的正文内容。如果用户要求续写，请紧接前文；如果要求生成新段落，请单独起一段。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

async function runAIWrite() {
  await loadAIContext();
  const out = $('#ai-output');
  const btn = $('[data-action="ai-write"]');
  if (out) out.textContent = 'AI 正在写作，请稍候...';
  if (btn) btn.disabled = true;
  try {
    const reply = await runHarnessFromMessages(buildAIWriteMessages(), { model: 'deepseek-v4-flash', action: 'write' });
    if (out) out.textContent = reply;
    state.aiDraft = reply;
    const insertBtn = $('#ai-insert-btn');
    if (insertBtn) insertBtn.style.display = state.aiDraft ? '' : 'none';
  } catch (e) {
    if (out) out.textContent = 'AI 请求失败：' + e.message;
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 工具栏 AI 写作 / 润色 / 扩写 ----------
// 把 AI 返回的纯文本转成段落 HTML，保留换行。
function textToParagraphsHtml(text = '') {
  return String(text)
    .split(/\n{2,}/)
    .map((block) => esc(block.trim()))
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// 获取编辑器内的选中文字和 Range；没有有效选中时返回 null。
// 点击工具栏会丢失实时选区，因此优先用实时选区，其次用编辑器事件保存的 savedRange。
function getEditorSelection(editor) {
  const sel = window.getSelection();
  let range = null;
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
  } else if (state.savedRange && editor.contains(state.savedRange.commonAncestorContainer)) {
    range = state.savedRange;
  }
  if (!range) return null;
  const text = range.toString().trim();
  return text ? { text, range } : null;
}

// 在光标处插入 HTML 内容；优先使用实时光标，其次使用保存的光标位置。
function insertHtmlAtCursor(editor, html) {
  editor.focus();
  const sel = window.getSelection();
  let range = null;
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
  } else if (state.savedRange && editor.contains(state.savedRange.commonAncestorContainer)) {
    range = state.savedRange;
  }
  if (range) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (div.firstChild) frag.appendChild(div.firstChild);
    range.deleteContents();
    range.insertNode(frag);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.insertAdjacentHTML('beforeend', html);
  }
}

// 替换选中区域；没有选中区域时替换整章正文。
function replaceEditorContent(editor, html, range) {
  editor.focus();
  if (range && editor.contains(range.commonAncestorContainer)) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (div.firstChild) frag.appendChild(div.firstChild);
    range.deleteContents();
    range.insertNode(frag);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.innerHTML = html;
  }
}

// 显示 AI 结果预览，确认后执行 onApply。
function showAIApplyPreview(title, reply, onApply) {
  state.pendingAIApply = { onApply };
  openModal({
    title,
    body: `<div class="ai-apply-preview">${esc(reply).replace(/\n/g, '<br>')}</div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="confirm-ai-apply">确认应用</button>`,
    large: true
  });
}

// 应用润色/扩写结果：先备份当前版本，再替换原文。
async function applyAIReply(editor, reply, range) {
  await manualSaveChapter();
  replaceEditorContent(editor, textToParagraphsHtml(reply), range);
  scheduleSave();
  toast('已应用 AI 结果', 'success');
}

function buildAIPolishMessages(text, instruction = '') {
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const system = '你是资深中文网络小说润色编辑。请在不改变原意和剧情的前提下，优化语句通顺度、节奏感和表现力。只输出润色后的正文，不要输出解释。';
  const user = `
当前作品：${state.work?.title || ''}
当前章节：${chapter.title || ''}
${instruction ? `润色要求：${instruction}` : ''}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}

需要润色的内容：
${text.slice(0, 6000)}

请直接输出润色后的完整内容。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function buildAIExpandMessages(text, instruction = '') {
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const system = '你是资深中文网络小说扩写助手。请在保留原有内容的基础上，合理扩充细节、动作、心理、环境描写，让情节更丰满。只输出扩写后的完整正文，不要输出解释。扩写后整体正文建议不少于 2000 字（若原文已超过则保持自然增长即可）。';
  const user = `
当前作品：${state.work?.title || ''}
当前章节：${chapter.title || ''}
${instruction ? `扩写要求：${instruction}` : ''}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}

需要扩写的内容：
${text.slice(0, 6000)}

请直接输出扩写后的完整内容。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

// AI 写作：先提问、一次一问、理解到位后再成文。
const AI_WRITING_CLARIFY_PROMPT = `请你在回答前先向我提问
要求一次只问一个问题
请根据我的回答继续追问
直到你有95%的信心，
完全理解我的真实需求和目标时
再给出最终方案。`;

function buildAIWritingBlueprintPrompt(initial, history, targetWords, auto = false) {
  const lines = [];
  lines.push(`你是资深中文网络小说创作助手。你熟悉网文爽点、节奏、人物塑造和世界观设定。`);
  if (auto) {
    lines.push(`批量自动模式：不要提问，直接输出【蓝图】。`);
  } else {
    lines.push(AI_WRITING_CLARIFY_PROMPT);
  }
  lines.push(``);
  lines.push(`对话输出规则：
- ${auto ? '直接输出，不需要提问。' : '如果还需要了解我的需求，第一行必须严格是【提问】，随后只输出一个问题，不要输出其他内容。'}
- 第一行必须严格是【蓝图】，随后只输出一个 JSON 对象（不要 Markdown 代码块、不要解释），字段如下：
{
  "scene_goal": "本场景目标（一句话）",
  "plot_points": "情节点，3-8 条，每条一行，足以撑起整章篇幅",
  "conflicts": "冲突与转折",
  "character_changes": "出场角色状态变化",
  "hook": "下一章钩子（收尾悬念）",
  "references": "需要回扣的既有设定/伏笔（没有就留空字符串）"
}
- ${auto ? '直接输出【蓝图】。' : '每轮最多只能问一个问题。'}`);
  lines.push(``);
  lines.push(`蓝图容量要求：本章目标字数 ${targetWords} 字，蓝图的情节点与冲突要足以展开到这个篇幅，同时只覆盖“一章”的容量，不要规划成多章内容。`);
  lines.push(``);
  lines.push(`【当前小说上下文】`);
  lines.push(aiContextBlock() || '无');
  lines.push(``);
  lines.push(`【用户最初请求】`);
  lines.push(initial);
  if (history.length) {
    lines.push(``);
    lines.push(`【已进行的对话】`);
    history.forEach((m) => {
      if (m.role === 'assistant') lines.push(`助手：${m.content}`);
      else lines.push(`用户：${m.content}`);
    });
  }
  lines.push(``);
  lines.push(auto
    ? '请直接输出【蓝图】并给出 JSON。'
    : '请根据以上内容决定下一步：若需澄清，先输出【提问】并只问一个问题；若已理解需求，先输出【蓝图】并给出 JSON。');
  return lines.join('\n');
}

// 按确认后的蓝图生成整章正文。
function buildAIWritingProsePrompt(initial, blueprint, targetWords) {
  const bpText = blueprint
    ? [
        blueprint.scene_goal && `场景目标：${blueprint.scene_goal}`,
        blueprint.plot_points && `情节点：\n${blueprint.plot_points}`,
        blueprint.conflicts && `冲突与转折：${blueprint.conflicts}`,
        blueprint.character_changes && `出场角色状态变化：${blueprint.character_changes}`,
        blueprint.hook && `下一章钩子：${blueprint.hook}`,
        blueprint.references && `需要回扣的设定/伏笔：${blueprint.references}`
      ].filter(Boolean).join('\n')
    : '';
  return [
    `你是资深中文网络小说创作助手。请根据已确认的章节蓝图，输出本章完整正文。`,
    `【本章蓝图 · 写作必须遵守】`,
    bpText || '（未提供蓝图，按用户需求自由成文）',
    ``,
    `【篇幅要求（重要）】整章正文以纯文本计不少于 ${targetWords} 字（上限 ${targetWords + 1000} 字左右）；把蓝图里的每个情节点写足，环境、动作、心理、对话、转折都要展开；篇幅不足时补细节与节奏、推进情节，不要提前收尾，也不要注水。`,
    ``,
    `【当前小说上下文】`,
    aiContextBlock() || '无',
    ``,
    `【用户最初请求】`,
    initial,
    ``,
    `请直接输出完整正文（不要输出【成文】等前缀，不要解释）。`
  ].join('\n');
}

// 成文不足目标字数时续写补足。
function buildAIWritingContinuationPrompt(article, targetWords) {
  const have = plainLength(article);
  const remain = Math.max(0, targetWords - have);
  return [
    `继续写本章正文。前面已写 ${have} 字（目标 ${targetWords} 字，还差约 ${remain} 字）。`,
    `请接着已写内容往下写，自然衔接，补齐剩余情节点，直到整章达到目标字数；不要重复已写内容。`,
    ``,
    `【已写内容末尾】`,
    String(article).slice(-1500),
    ``,
    `【当前小说上下文】`,
    aiContextBlock() || '无',
    ``,
    `直接输出续写正文（不要输出任何前缀、标题或解释）。`
  ].join('\n');
}

function buildAIWritingInitialRequest(requirement = '') {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  const chapterId = state.currentChapterId;
  const chapter = state.chapters.find((c) => c.id === chapterId) || {};
  const plain = stripHtml(editor?.innerHTML || chapter.content || '');
  const sel = getEditorSelection(editor);
  const selected = sel?.text?.trim() || '';
  const panelPrompt = $('#ai-prompt')?.value?.trim() || '';
  const reqText = String(requirement || '').trim();
  return `
当前作品：${state.work?.title || ''}
当前章节/场景：${title?.value || chapter.title || ''}
大纲摘要：${chapter.summary || '无'}
${selected ? `你希望围绕的选中内容：\n${selected}\n` : plain ? `当前正文末尾：\n${plain.slice(-1200)}\n` : ''}
${reqText ? `用户写作需求：${reqText}` : panelPrompt ? `用户补充需求：${panelPrompt}` : '请通过提问了解我真正想要的写作方向、风格和内容（长度未指定时按作品配置的每章目标字数成文，默认 2000 字以上）。'}
`.trim();
}

// 从混杂文本里提取第一个 {...} JSON 对象（蓝图解析用）；失败返回 null。
function extractJSONFromText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

// 纯文本字数（去空白）。
function plainLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

// 当前章节生效的目标字数：章节覆盖 > 作品默认 > 2000。
function resolveTargetWords() {
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  return Number(chapter.target_words) > 0 ? Number(chapter.target_words)
    : Number(state.work?.default_chapter_words) > 0 ? Number(state.work.default_chapter_words)
    : 2000;
}

function parseAIWritingOutput(raw) {
  const text = String(raw || '').trim();
  const blueprintHead = text.match(/^【蓝图】\s*([\s\S]*)$/);
  if (blueprintHead) {
    const bp = extractJSONFromText(blueprintHead[1]);
    if (bp) return { blueprint: bp };
    return { finalText: text }; // 蓝图 JSON 解析失败：按原文兜底
  }
  const finalHead = text.match(/^【成文】\s*([\s\S]*)$/);
  if (finalHead) return { finalText: finalHead[1].trim() };
  const questionHead = text.match(/^【提问】\s*([\s\S]*)$/);
  if (questionHead) return { question: questionHead[1].trim() };

  const anyFinal = text.match(/【成文】\s*([\s\S]*)/);
  const anyQuestion = text.match(/【提问】\s*([\s\S]*)/);
  if (anyFinal && !anyQuestion) return { finalText: anyFinal[1].trim() };
  if (anyQuestion && !anyFinal) return { question: anyQuestion[1].trim() };

  // 极简兜底：很短的问句当作提问，其他内容当作成文。
  const looksLikeQuestion = text.length < 120 && /[?？]$/.test(text) && !/[。！]/.test(text);
  if (looksLikeQuestion) return { question: text };
  return { finalText: text };
}

// 弹窗询问 AI 的一次追问。
function askAIWritingQuestion(question) {
  return new Promise((resolve) => {
    state.pendingAIQuestion = resolve;
    openModal({
      title: 'AI 写作 · 需要向你确认',
      body: `
        <div class="ai-writing-question">${esc(question).replace(/\n/g, '<br>')}</div>
        <div class="field mt-12">
          <label>你的回答</label>
          <textarea id="ai-writing-answer" rows="3" placeholder="直接回答 AI 的问题，它会继续追问，直到理解你的需求"></textarea>
        </div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="ai-writing-skip">跳过提问直接生成</button>
        <button class="btn" data-action="ai-writing-answer">提交回答</button>`
    });
    const input = $('#ai-writing-answer');
    if (input) input.focus();
  });
}

// D17：红线自检结果可视化——让“反 AI 腔”卖点可感知。
function redlineScanSummaryHtml(scan) {
  if (!scan || !scan.enabled) return '';
  if (!scan.total) {
    return '<div class="redline-scan ok">✅ 红线自检通过：本次成文未命中反 AI 腔词句</div>';
  }
  const samples = (scan.hits || []).slice(0, 3)
    .map((h) => `<span class="chip warn">${esc(h.pattern)} ×${h.count}</span>`).join(' ');
  return `<div class="redline-scan warn">⚠️ 红线自检命中 ${scan.total} 处反 AI 腔词句：${samples || '—'}。已提示模型规避，如需改写可在预览中手动调整。</div>`;
}

// 入账提案（headless 任务里 AI 提交的事件/记忆，未写入作品账本）渲染。
function proposalItemHtml(p) {
  const icon = p.type === 'memory' ? '🧠' : (p.kind === 'foreshadow' ? '🎯' : '📌');
  const kindLabel = p.type === 'memory' ? '长期记忆' : (p.kind === 'foreshadow' ? '伏笔' : '事件');
  const text = p.type === 'memory' ? (p.summary || p.delta || '') : p.summary || '';
  return `<label class="proposal-item"><input type="checkbox" data-proposal-id="${Number(p.id)}" checked>
    <span>${icon} ${kindLabel}：${esc(String(text).slice(0, 120))}</span></label>`;
}

function proposalsSummaryHtml(proposals) {
  if (!Array.isArray(proposals) || !proposals.length) return '';
  return `<div class="proposal-box">
    <div class="proposal-head">📥 AI 提交了 ${proposals.length} 条入账提案（尚未写入作品账本，随正文采纳一起生效）：</div>
    ${proposals.map(proposalItemHtml).join('')}
    <div class="muted mt-4">取消勾选可暂时保留，稍后在「小说设定 → 长期记忆」页处理。</div>
  </div>`;
}

// 成文长度提示：与目标字数对比（不足时给出可执行的补救建议）。
function articleLengthHint(article, targetWords) {
  const n = plainLength(article);
  const target = Number(targetWords) || 2000;
  if (n >= target) {
    return `<div class="redline-scan ok">📏 成文 ${n} 字，达到目标 ${target} 字${n > target + 1000 ? '（略超，可自行精简）' : ''}</div>`;
  }
  const gap = target - n;
  if (gap <= 300) {
    return `<div class="redline-scan warn">📏 成文 ${n} 字，距目标 ${target} 字还差 ${gap} 字：可直接应用后继续「AI 写作」续写，或点「重新生成」。</div>`;
  }
  return `<div class="redline-scan warn">⚠️ 成文 ${n} 字，距目标 ${target} 字还差 ${gap} 字。已尝试自动续写补足；仍不足时建议点「重新生成」，或在需求里强调篇幅。</div>`;
}

// 弹窗展示最终文章，让用户选择如何应用。
function showAIWritingResult(article, scan, proposals, targetWords) {
  return new Promise((resolve) => {
    state.pendingAIFinal = resolve;
    state.pendingAIArticle = { article, scan, proposals, targetWords };
    state.pendingAIProposals = Array.isArray(proposals) && proposals.length
      ? { workId: state.workId || state.work?.id || null, proposals }
      : null;
    openModal({
      title: 'AI 写作结果',
      body: `
        <div class="ai-apply-preview">${esc(article).replace(/\n/g, '<br>')}</div>
        ${articleLengthHint(article, targetWords)}
        ${redlineScanSummaryHtml(scan)}
        ${proposalsSummaryHtml(proposals)}
        <div class="muted mt-8">请选择如何应用到正文：</div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="ai-writing-review">🔍 先审稿再应用</button>
        <button class="btn secondary" data-action="ai-writing-regenerate">重新生成</button>
        <button class="btn secondary" data-action="ai-writing-replace">替换当前正文/选中</button>
        <button class="btn secondary" data-action="ai-writing-append">追加到文末</button>
        <button class="btn" data-action="ai-writing-insert">插入光标处</button>`,
      large: true
    });
  });
}

// 把当前结果弹窗里勾选的提案提交为“采纳”；未勾选的保留待处理。
async function applySelectedProposals() {
  const info = state.pendingAIProposals;
  if (!info || !info.workId) return;
  state.pendingAIProposals = null;
  const checked = [...document.querySelectorAll('.proposal-box [data-proposal-id]:checked')]
    .map((el) => Number(el.dataset.proposalId));
  try {
    const data = await api('/novel/proposals/apply', { method: 'POST', body: { work_id: info.workId, ids: checked } });
    const count = (data.applied?.events || 0) + (data.applied?.memories || 0);
    if (count) toast(`已采纳 ${count} 条入账提案`, 'success');
    else toast('提案已保留，可稍后在「长期记忆」页处理');
  } catch (e) {
    toast('提案采纳失败：' + e.message, 'error');
  }
}

// ---------- 审稿 → 确认清单 → 修稿 → 差异合并 ----------
function buildAIReviewPrompt(article) {
  return [
    '你是严格的中文网络小说审稿编辑。请审读下面这篇章节正文，并对照小说上下文，输出 JSON 对象（不要 Markdown 代码块）：',
    '{"summary":"总评（两三句）","issues":[{"text":"问题描述，含位置（如：中段冲突部分）与理由，逐条可执行"}],"strengths":[{"text":"写得好的地方"}]}',
    'issues 覆盖：剧情逻辑/与既有设定冲突/人物言行一致/AI 腔与模板句/节奏与钩子/篇幅；strengths 1-3 条。',
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    '【待审正文】',
    String(article || '').slice(0, 12000),
    '',
    '只输出 JSON。'
  ].join('\n');
}

function buildAIRevisionPrompt(article, issues) {
  const list = (issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）';
  return [
    '你是资深中文网络小说修稿编辑。请按下面的“作者确认的问题清单”逐条修改正文；清单之外的内容尽量保持原样，不要擅自大改。',
    '',
    '【作者确认的问题清单】',
    list,
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    '【待修正文】',
    String(article || '').slice(0, 12000),
    '',
    '请直接输出修改后的完整正文（不要解释、不要输出前缀）。'
  ].join('\n');
}

// 段落级 diff（LCS）：返回 [{t:'same'|'del'|'add', x}]，供差异预览渲染。
function diffParagraphs(oldText, newText) {
  const a = String(oldText || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const b = String(newText || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  if (n * m > 60000) {
    // 超大文本退化为逐段对齐（前 n 段按位置比较）
    const out = [];
    for (let i = 0; i < Math.max(n, m); i++) {
      if (i < n && i < m) {
        out.push(a[i] === b[i] ? { t: 'same', x: a[i] } : { t: 'del', x: a[i] }, { t: 'add', x: b[i] });
      } else if (i < n) out.push({ t: 'del', x: a[i] });
      else out.push({ t: 'add', x: b[i] });
    }
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'same', x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', x: a[i] }); i++; }
    else { ops.push({ t: 'add', x: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: 'del', x: a[i] }); i++; }
  while (j < m) { ops.push({ t: 'add', x: b[j] }); j++; }
  return ops;
}

// 审稿主流程：审稿报告 → 确认清单 → 修稿 → 差异预览 → 合并。
async function runArticleReview(info) {
  const jobBase = {
    timeout: 600000,
    model: 'deepseek-v4-pro',
    action: 'write',
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: state.currentChapterId || undefined,
    mode: 'full'
  };
  try {
    const reviewData = await runHarnessJob({ ...jobBase, prompt: buildAIReviewPrompt(info.article) }, 'AI 审稿 · 正在通读全文并生成审稿报告…');
    let review = extractJSONFromText(reviewData.output || '');
    if (!review) review = extractJSONFromText(parseAIWritingOutput(reviewData.output || '').finalText || '');
    if (!review) throw new Error('审稿报告解析失败，请重试');
    review.summary = String(review.summary || '');
    review.issues = Array.isArray(review.issues) ? review.issues.map((x) => String(typeof x === 'string' ? x : (x?.text || ''))).filter(Boolean) : [];
    review.strengths = Array.isArray(review.strengths) ? review.strengths.map((x) => String(typeof x === 'string' ? x : (x?.text || ''))).filter(Boolean) : [];
    if (state.currentChapterId) {
      try {
        const saved = await api('/novel/review', { method: 'PUT', body: { chapter_id: state.currentChapterId, report: review } });
        review.review_id = saved.review_id;
      } catch (_) { /* 保存失败不阻塞审稿流程 */ }
    }
    state.pendingReview = { info, review };
    showReviewReport(review);
  } catch (e) {
    if (!e.cancelled) toast('审稿失败：' + e.message, 'error');
  }
}

function showReviewReport(review) {
  const issues = review.issues || [];
  openModal({
    title: '🔍 AI 审稿报告',
    body: `
      <div class="review-summary">${esc(review.summary || '（无总评）')}</div>
      ${(review.strengths || []).length ? `<div class="ref-group-title">优点</div>${review.strengths.map((s) => `<div class="review-item strength">✓ ${esc(s)}</div>`).join('')}` : ''}
      <div class="ref-group-title">问题（勾选 = 确认修稿；取消勾选 = 忽略）</div>
      ${issues.length ? issues.map((x, i) => `
        <label class="review-item issue"><input type="checkbox" data-review-issue="${i}" checked>
          <span>${i + 1}. ${esc(x)}</span></label>`).join('')
        : '<div class="muted">未发现问题</div>'}`,
    footer: `
      <button class="btn secondary" data-close-modal>取消</button>
      <button class="btn" data-action="review-confirm">按确认清单修稿</button>`,
    large: true
  });
}

async function refineByChecklist() {
  const { info, review } = state.pendingReview || {};
  state.pendingReview = null;
  if (!info || !review) return;
  const confirmed = [];
  document.querySelectorAll('[data-review-issue]:checked').forEach((el) => {
    confirmed.push((review.issues || [])[Number(el.dataset.reviewIssue)]);
  });
  closeModal();
  const jobBase = {
    timeout: 600000,
    model: 'deepseek-v4-pro',
    action: 'write',
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: state.currentChapterId || undefined,
    mode: 'full'
  };
  try {
    const refinedData = await runHarnessJob({ ...jobBase, prompt: buildAIRevisionPrompt(info.article, confirmed) }, 'AI 修稿 · 正在按确认清单修改…');
    const revised = parseAIWritingOutput(refinedData.output || '').finalText || '';
    if (!revised.trim()) throw new Error('修稿结果为空');
    showReviewDiff(info.article, revised, confirmed.length);
  } catch (e) {
    if (!e.cancelled) toast('修稿失败：' + e.message, 'error');
  }
}

function showReviewDiff(oldText, newText, confirmedCount) {
  state.pendingReviewDiff = { newText };
  const ops = diffParagraphs(oldText, newText);
  const body = ops.map((op) => {
    if (op.t === 'same') return `<div class="diff-p">${esc(op.x)}</div>`;
    if (op.t === 'del') return `<div class="diff-p diff-del">${esc(op.x)}</div>`;
    return `<div class="diff-p diff-add">${esc(op.x)}</div>`;
  }).join('');
  openModal({
    title: `🆚 修稿差异预览（按 ${confirmedCount} 条清单修改）`,
    body: `
      <div class="muted mb-8"><span class="diff-add-inline">绿色</span>=修稿新增/改写，<span class="diff-del-inline">红色</span>=旧稿被删改。确认无误后合并到正文。</div>
      <div class="diff-view">${body || '<div class="muted">无差异</div>'}</div>`,
    footer: `
      <button class="btn secondary" data-close-modal>放弃修改</button>
      <button class="btn" data-action="diff-merge">合并到正文</button>`,
    large: true
  });
}

async function mergeReviewDiff() {
  const { newText } = state.pendingReviewDiff || {};
  state.pendingReviewDiff = null;
  if (!newText || !state.currentChapterId) return;
  try {
    await api('/novel/chapter_save', {
      method: 'POST',
      body: { chapter_id: state.currentChapterId, content: textToParagraphsHtml(newText) }
    });
    applySelectedProposals();
    closeModal();
    toast('审稿修稿已合并到正文（旧稿已存历史版本）', 'success');
    await loadWorkData(true);
    await render();
  } catch (e) {
    toast('合并失败：' + e.message, 'error');
  }
}

// ---------- 导出 ----------
async function downloadExport(path, fallbackName) {
  try {
    const res = await fetch('/api' + path);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text.slice(0, 200));
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

// ---------- 导入（TXT/Markdown/EPUB → 新建作品自动拆章） ----------
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function handleImportFile(file) {
  if (!file) return;
  const isEpub = /\.epub$/i.test(file.name);
  const title = file.name.replace(/\.(txt|md|markdown|epub)$/i, '').trim();
  try {
    let body = { title };
    if (isEpub) {
      const buf = new Uint8Array(await file.arrayBuffer());
      body.base64 = bytesToBase64(buf);
      toast('正在导入 EPUB…', 'success');
    } else {
      body.text = await file.text();
    }
    const r = await api('/import', { method: 'POST', body });
    toast(`已导入《${r.title}》：${r.chapters} 章`, 'success');
    await loadWorks(true);
    await render();
  } catch (e) {
    toast('导入失败：' + e.message, 'error');
  } finally {
    const input = $('#import-file');
    if (input) input.value = '';
  }
}

async function applyAIWritingArticle(mode, article) {
  const editor = $('#editor-content');
  if (!editor) return;
  if (mode === 'insert') {
    insertHtmlAtCursor(editor, textToParagraphsHtml(article));
    scheduleSave();
    toast('已插入 AI 写作内容', 'success');
  } else if (mode === 'replace') {
    const sel = getEditorSelection(editor);
    await applyAIReply(editor, article, sel?.range || null);
  } else if (mode === 'append') {
    editor.focus();
    editor.insertAdjacentHTML('beforeend', textToParagraphsHtml(article));
    scheduleSave();
    toast('已追加 AI 写作内容', 'success');
  }
}

// D5：正文「✍️ AI 写作」先弹需求确认框，用户确认后才发起付费调用；
// 「直接开始」走默认“先提问澄清”流程，与设定类 AI 生成的体验保持一致。
function askToolbarAIWriteRequirement() {
  return new Promise((resolve) => {
    state.pendingToolbarAIWrite = resolve;
    openModal({
      title: '✍️ AI 写作 · 写点什么？',
      body: `
        <div class="muted">AI 会结合当前章节与设定先向你提问澄清，确认需求后开始生成（此过程会消耗 AI 调用额度）。</div>
        <div class="field mt-12">
          <label>你的写作需求（可留空，AI 会先提问了解）</label>
          <textarea id="toolbar-ai-write-req" rows="4" placeholder="例如：续写本章，主角发现电台接到一通来自 14 年前的电话…（未指定长度时按作品配置的每章目标字数成文）"></textarea>
        </div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="toolbar-ai-write-direct">直接开始</button>
        <button class="btn" data-action="toolbar-ai-write-confirm">✨ 开始生成</button>`
    });
    const input = $('#toolbar-ai-write-req');
    if (input) input.focus();
  });
}

async function runToolbarAIWrite() {
  const editor = $('#editor-content');
  if (!editor) return;
  const req = await askToolbarAIWriteRequirement();
  if (req === null) return; // 用户取消
  await performToolbarAIWrite(String(req || '').trim() || null);
}

// 蓝图确认弹窗：字段可编辑；resolve 蓝图对象 / {skip:true}（跳过蓝图直接成文）/ null（取消）。
function showBlueprintConfirm(blueprint) {
  return new Promise((resolve) => {
    state.pendingBlueprint = resolve;
    const b = blueprint || {};
    openModal({
      title: '📐 章节蓝图 · 请确认或修改',
      body: `
        <div class="muted mb-8">AI 根据本章需求生成了蓝图，写作将严格围绕它展开；可修改后再「按此蓝图成文」，蓝图会保存到章节并参与后续上下文与一致性核对。</div>
        <div class="form-grid">
          <div class="field full"><label>场景目标</label><input id="bp-scene-goal" value="${esc(b.scene_goal || '')}" placeholder="本场景要达成什么"></div>
          <div class="field full"><label>情节点（每行一条，3-8 条）</label><textarea id="bp-plot-points" rows="5">${esc(b.plot_points || '')}</textarea></div>
          <div class="field full"><label>冲突与转折</label><textarea id="bp-conflicts" rows="3">${esc(b.conflicts || '')}</textarea></div>
          <div class="field full"><label>出场角色状态变化</label><textarea id="bp-char-changes" rows="3">${esc(b.character_changes || '')}</textarea></div>
          <div class="field full"><label>下一章钩子</label><textarea id="bp-hook" rows="2">${esc(b.hook || '')}</textarea></div>
          <div class="field full"><label>参考设定（需要回扣的设定/伏笔）</label><textarea id="bp-references" rows="2">${esc(b.references || '')}</textarea></div>
          <div class="field"><label>目标字数</label><input id="bp-target-words" type="number" min="500" max="20000" step="100" value="${Number(b.target_words) || resolveTargetWords()}"></div>
        </div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="blueprint-skip-prose">跳过蓝图直接成文</button>
        <button class="btn" data-action="blueprint-confirm">按此蓝图成文</button>`,
      large: true
    });
  });
}

async function performToolbarAIWrite(requirement) {
  const editor = $('#editor-content');
  if (!editor) return;
  await loadAIContext();
  const btn = $('[data-action="toolbar-ai-write"]');
  if (btn) btn.disabled = true;
  const jobBase = {
    timeout: 600000,
    model: 'deepseek-v4-flash',
    action: 'write',
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: state.currentChapterId || undefined,
    mode: 'continuation'
  };
  try {
    const initial = buildAIWritingInitialRequest(requirement || '');
    const history = [];
    const targetWords = resolveTargetWords();
    let maxTurns = 10;

    // 阶段 A：澄清 → 章节蓝图
    while (maxTurns-- > 0) {
      const lastMsg = history.length ? history[history.length - 1] : null;
      const stageLabel = !history.length
        ? 'AI 写作 · 正在阅读章节与设定，准备提问…'
        : (lastMsg?.content || '').includes('【提问】')
          ? 'AI 写作 · 已收到回答，正在生成章节蓝图…'
          : 'AI 写作 · 正在按反馈重新规划蓝图…';
      const data = await runHarnessJob({ ...jobBase, prompt: buildAIWritingBlueprintPrompt(initial, history, targetWords) }, stageLabel);
      const raw = data.output || '';
      if (!raw.trim()) throw new Error('AI 没有返回内容');
      const parsed = parseAIWritingOutput(raw);

      if (parsed.blueprint) {
        parsed.blueprint.target_words = targetWords;
        const confirmed = await showBlueprintConfirm(parsed.blueprint);
        if (confirmed === null) return; // 作者取消
        if (!confirmed.skip && state.currentChapterId) {
          try {
            await api('/novel/chapter_blueprint', {
              method: 'PUT',
              body: { chapter_id: state.currentChapterId, blueprint: confirmed, target_words: Number(confirmed.target_words) || 0 }
            });
            toast('章节蓝图已保存', 'success');
          } catch (e) {
            toast('蓝图保存失败：' + e.message, 'error');
          }
        }
        const target = Number(confirmed.target_words) || targetWords;
        // 阶段 B：按蓝图成文
        const proseData = await runHarnessJob(
          { ...jobBase, prompt: buildAIWritingProsePrompt(initial, confirmed.skip ? null : confirmed, target) },
          'AI 写作 · 正在按蓝图成文（这一步最慢，通常 2–6 分钟）…'
        );
        let article = parseAIWritingOutput(proseData.output || '').finalText || '';
        if (!article.trim()) throw new Error('AI 没有返回正文内容');
        // 阶段 C：篇幅不足自动续写补足（最多 2 轮，拼稿后一并交付）
        let rounds = 0;
        while (plainLength(article) < target && rounds < 2) {
          rounds += 1;
          const cont = await runHarnessJob(
            { ...jobBase, prompt: buildAIWritingContinuationPrompt(article, target) },
            `AI 写作 · 篇幅不足，正在续写补足（${rounds}/2）…`
          );
          const more = parseAIWritingOutput(cont.output || '').finalText || '';
          if (!more.trim()) break;
          article = `${article}\n\n${more}`;
        }
        const mode = await showAIWritingResult(article, proseData.scan, proseData.proposals, target);
        if (mode === null) return;
        if (mode === 'regenerate') return performToolbarAIWrite(requirement);
        await applyAIWritingArticle(mode, article);
        return;
      }

      if (parsed.finalText) {
        // 模型跳过蓝图直接给了正文（降级路径，兼容旧行为）
        const mode = await showAIWritingResult(parsed.finalText, data.scan, data.proposals, targetWords);
        if (mode === null) return;
        if (mode === 'regenerate') return performToolbarAIWrite(requirement);
        await applyAIWritingArticle(mode, parsed.finalText);
        return;
      }

      if (parsed.question) {
        const answer = await askAIWritingQuestion(parsed.question);
        if (answer === null) return;
        if (answer.type === 'skip') {
          history.push({ role: 'user', content: '请不要再提问，直接给出章节蓝图。' });
          continue;
        }
        history.push({ role: 'assistant', content: `【提问】${parsed.question}` });
        history.push({ role: 'user', content: answer.value || '（未填写）' });
        continue;
      }

      // 兜底：按最终结果处理
      const mode = await showAIWritingResult(raw, data.scan, data.proposals, targetWords);
      if (mode === null) return;
      if (mode === 'regenerate') return performToolbarAIWrite(requirement);
      await applyAIWritingArticle(mode, raw);
      return;
    }

    toast('AI 追问次数已达上限，请重试', 'error');
  } catch (e) {
    if (e.cancelled) toast('已取消 AI 写作', 'success');
    else toast('AI 写作失败：' + e.message + (e.tail ? '（查看报错历史可了解细节）' : ''), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 批量章节生成 ----------
// 从第一个无正文的章节开始顺序生成 N 章：每章自动蓝图 → 成文 → 字数补足 → 写回；
// 暂停/取消/失败即停（已完成的章节保留）。事件/记忆入账走提案模式，结束统一提示确认。
function askBatchGenerate() {
  return new Promise((resolve) => {
    state.pendingBatchCount = resolve;
    openModal({
      title: '⚡ 批量生成章节',
      body: `
        <div class="muted mb-8">从第一个还没有正文的章节开始，依次自动生成（每章先出蓝图再成文，按作品配置的目标字数补足）。已有正文的章节会跳过；随时可点进度卡上的「停止」。</div>
        <div class="field"><label>生成章节数（1-10）</label><input id="batch-count" type="number" min="1" max="10" value="3"></div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn" data-action="batch-start">开始批量生成</button>`
    });
  });
}

async function batchGenerateChapters(count) {
  count = Math.min(10, Math.max(1, Number(count) || 3));
  if (!state.workId) return toast('请先进入一部作品', 'error');
  let empty;
  try {
    empty = await api(`/novel/empty_chapters?work_id=${state.workId}`);
  } catch (e) {
    return toast('查询空章节失败：' + e.message, 'error');
  }
  const targets = (empty.chapters || []).slice(0, count);
  if (!targets.length) return toast('没有空章节可生成（可先在正文写作页新建章节）', 'error');
  const jobBase = {
    timeout: 600000,
    model: 'deepseek-v4-flash',
    action: 'write',
    work_id: state.workId,
    mode: 'full'
  };
  let done = 0;
  for (const ch of targets) {
    done += 1;
    const label = `批量生成 · 第 ${done}/${targets.length} 章（${ch.title}）`;
    try {
      // 切到该章上下文（AI 上下文/角色卡/世界观）
      state.currentChapterId = ch.id;
      await loadAIContext();
      const target = resolveTargetWords();
      const initial = buildAIWritingInitialRequest(`根据作品大纲与剧情推进，撰写本章完整正文（不需要提问，直接按蓝图成文）`);
      // 1) 自动蓝图（不弹确认，直接落库）
      const bpData = await runHarnessJob({ ...jobBase, chapter_id: ch.id, prompt: buildAIWritingBlueprintPrompt(initial, [], target, true) }, `${label} · 蓝图`);
      let bp = parseAIWritingOutput(bpData.output || '').blueprint || null;
      if (bp && Object.keys(bp).length) {
        try {
          await api('/novel/chapter_blueprint', { method: 'PUT', body: { chapter_id: ch.id, blueprint: bp, target_words: 0 } });
        } catch (_) { /* 蓝图保存失败不阻塞 */ }
      }
      // 2) 成文
      const proseData = await runHarnessJob({ ...jobBase, chapter_id: ch.id, prompt: buildAIWritingProsePrompt(initial, bp, target) }, `${label} · 成文`);
      let article = parseAIWritingOutput(proseData.output || '').finalText || '';
      if (!article.trim()) throw new Error('AI 没有返回正文内容');
      // 3) 字数补足
      let rounds = 0;
      while (plainLength(article) < target && rounds < 2) {
        rounds += 1;
        const cont = await runHarnessJob({ ...jobBase, chapter_id: ch.id, prompt: buildAIWritingContinuationPrompt(article, target) }, `${label} · 补足（${rounds}/2）`);
        const more = parseAIWritingOutput(cont.output || '').finalText || '';
        if (!more.trim()) break;
        article = `${article}\n\n${more}`;
      }
      // 4) 写回章节（旧稿自动存历史版本）
      await api('/novel/chapter_save', {
        method: 'POST',
        body: { chapter_id: ch.id, content: textToParagraphsHtml(article), summary: (bp?.scene_goal || '').slice(0, 200) }
      });
      toast(`第 ${done}/${targets.length} 章已写入：${ch.title}`, 'success');
    } catch (e) {
      if (e.cancelled) {
        toast(`批量生成已停止：完成 ${done - 1}/${targets.length} 章（已完成的章节保留）`, 'success');
      } else {
        toast(`批量生成在第 ${done} 章失败：${e.message}（已完成章节保留）`, 'error');
      }
      await loadWorkData(true);
      await render();
      return;
    }
  }
  toast(`批量生成完成：${done} 章已写入正文。AI 提交的事件/记忆提案可在「长期记忆 → 待确认提案」处理`, 'success');
  await loadWorkData(true);
  await render();
}

async function runToolbarAIPolish() {
  const editor = $('#editor-content');
  if (!editor) return;
  await loadAIContext();
  const sel = getEditorSelection(editor);
  const source = (sel?.text || editor.innerText || '').trim();
  if (!source) {
    toast('当前没有可润色的内容', 'error');
    return;
  }
  const instruction = await askAIInstruction('润色', '例如：更口语化 / 更有画面感');
  if (instruction === null) return;
  const btn = $('[data-action="toolbar-ai-polish"]');
  if (btn) btn.disabled = true;
  try {
    const reply = await runHarnessFromMessages(buildAIPolishMessages(source, instruction.trim()), { model: 'deepseek-v4-pro', action: 'polish' });
    if (!reply) throw new Error('AI 没有返回内容');
    const range = sel?.range || null;
    showAIApplyPreview('润色结果', reply, () => applyAIReply(editor, reply, range));
  } catch (e) {
    if (e.cancelled) toast('已取消 AI 润色', 'success');
    else toast('AI 润色失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runToolbarAIExpand() {
  const editor = $('#editor-content');
  if (!editor) return;
  await loadAIContext();
  const sel = getEditorSelection(editor);
  const source = (sel?.text || editor.innerText || '').trim();
  if (!source) {
    toast('当前没有可扩写的内容', 'error');
    return;
  }
  const instruction = await askAIInstruction('扩写', '例如：增加心理描写和环境细节');
  if (instruction === null) return;
  const btn = $('[data-action="toolbar-ai-expand"]');
  if (btn) btn.disabled = true;
  try {
    const reply = await runHarnessFromMessages(buildAIExpandMessages(source, instruction.trim()), { model: 'deepseek-v4-pro', action: 'expand' });
    if (!reply) throw new Error('AI 没有返回内容');
    const range = sel?.range || null;
    showAIApplyPreview('扩写结果', reply, () => applyAIReply(editor, reply, range));
  } catch (e) {
    if (e.cancelled) toast('已取消 AI 扩写', 'success');
    else toast('AI 扩写失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function buildAIPersonalityMessages(characterId) {
  const editor = $('#editor-content');
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const content = stripHtml(editor?.innerHTML || chapter.content || '');
  const character = state.characters.find((c) => c.id === characterId) || state.characters[0];
  if (!character) return null;
  const plotlineStates = state.plotlineCharacters.filter((p) => p.character_id === character.id);
  const system = `你是小说角色一致性审核专家。请严格根据角色的设定档案和当前剧情线状态，判断其在给定正文中的行为、语言、情绪是否符合人设，并给出具体建议。`;
  const user = `
角色名：${character.name}
身份：${character.identity}
性格设定：${character.personality}
背景：${character.background}
当前状态：${character.status}
剧情线状态：${plotlineStates.map((p) => `${state.plotlines.find((x) => x.id === p.plotline_id)?.title || ''}：${p.status} ${p.notes}`).join('；') || '无'}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}

当前正文：
${content.slice(0, 6000)}

请输出：
1. 符合人设的方面
2. 可能偏离人设的地方（如果没有就写无）
3. 对后续写作的调整建议`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

async function runAIPersonality() {
  await loadAIContext();
  const chars = state.characters;
  if (!chars.length) {
    toast('请先创建角色', 'error');
    goView('characters');
    return render();
  }
  const characterId = state.aiCharacterId || chars[0].id;
  const messages = buildAIPersonalityMessages(characterId);
  if (!messages) return;
  const out = $('#ai-output');
  const btn = $('[data-action="ai-personality"]');
  if (out) out.textContent = 'AI 正在校对角色性格，请稍候...';
  if (btn) btn.disabled = true;
  try {
    const reply = await runHarnessFromMessages(messages, { model: 'deepseek-v4-pro', action: 'personality' });
    if (out) out.textContent = reply;
    state.aiDraft = reply;
    const insertBtn = $('#ai-insert-btn');
    if (insertBtn) insertBtn.style.display = 'none';
  } catch (e) {
    if (out) out.textContent = 'AI 请求失败：' + e.message;
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function buildAIOutlineMessages() {
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const editor = $('#editor-content');
  const content = stripHtml(editor?.innerHTML || chapter.content || '');
  const terms = state.terms.slice(0, 20);
  const chars = state.characters.slice(0, 10);
  const system = `你是资深小说大纲策划助手。请根据设定与当前进度，生成清晰、可执行的细纲，不要写正文。`;
  const user = `
当前章节/场景：${chapter.title || ''}
大纲摘要：${chapter.summary || '无'}
当前正文梗概：${content.slice(0, 2000) || '无'}

相关设定：${terms.map((t) => `【${t.title}】${(t.content || '').slice(0, 120)}`).join('\n') || '无'}
角色：${chars.map((c) => `${c.name}（${c.identity || ''}）`).join('、') || '无'}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}

请生成：
- 本场景目标
- 情节点拆解（3-8 个步骤）
- 冲突与转折
- 出场角色状态变化
- 下一场景钩子`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

async function runAIOutline() {
  await loadAIContext();
  const out = $('#ai-output');
  const btn = $('[data-action="ai-outline"]');
  if (out) out.textContent = 'AI 正在生成细纲，请稍候...';
  if (btn) btn.disabled = true;
  try {
    const reply = await runHarnessFromMessages(buildAIOutlineMessages(), { model: 'deepseek-v4-pro', action: 'outline' });
    if (out) out.textContent = reply;
    state.aiDraft = reply;
    const insertBtn = $('#ai-insert-btn');
    if (insertBtn) insertBtn.style.display = 'none';
  } catch (e) {
    if (out) out.textContent = 'AI 请求失败：' + e.message;
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- AI 生成器：小说设定各实体（通用） ----------
// 参考 novel-writing-plugin 创作内核（deepseek-harness）：
// 上下文采用 ST 式分层装配（novel/context 的 assembled），纪律为“一次只问一个问题”，
// 结构化产出用【提问】/【成文】协议 + “字段名：值”行 + “=====” 分隔多项。

const GEN_KEYS = {
  plotline: {
    label: '剧情线',
    keys: [
      { key: 'title', als: ['名称', '剧情线名称'], label: '名称' },
      { key: 'kind', als: ['类型'], label: '类型（主线/支线）' },
      { key: 'summary', als: ['简介', '剧情简介'], label: '简介' }
    ],
    rules: '类型只填“主线”或“支线”。若为“完整规划多条线”请一次生成 1-4 条（主线 + 支线）。'
  },
  volume: {
    label: '卷',
    keys: [
      { key: 'title', als: ['卷名', '名称'], label: '卷名' },
      { key: 'summary', als: ['卷简介', '简介'], label: '卷简介' }
    ],
    rules: ''
  },
  chapter: {
    label: '章节/场景',
    keys: [
      { key: 'title', als: ['章节标题', '标题', '名称'], label: '标题' },
      { key: 'summary', als: ['大纲摘要', '摘要'], label: '摘要' }
    ],
    rules: '只生成标题与大纲摘要（细纲），不要生成正文。'
  },
  term: {
    label: '设定词条',
    keys: [
      { key: 'title', als: ['词条名', '名称'], label: '词条名' },
      { key: 'category', als: ['分类', '建议分类'], label: '分类' },
      { key: 'tags', als: ['标签'], label: '标签（逗号分隔）' },
      { key: 'content', als: ['详细介绍', '内容'], label: '详细介绍' }
    ],
    rules: '内容要具体、可被正文直接引用；分类尽量使用现有分类名，若必须新分类再给新分类名。'
  },
  character: {
    label: '角色',
    keys: [
      { key: 'name', als: ['姓名', '名称'], label: '姓名' },
      { key: 'identity', als: ['身份'], label: '身份' },
      { key: 'appearance', als: ['外貌'], label: '外貌' },
      { key: 'personality', als: ['性格'], label: '性格' },
      { key: 'background', als: ['背景'], label: '背景' },
      { key: 'status', als: ['当前状态', '状态'], label: '当前状态' },
      { key: 'tags', als: ['标签'], label: '标签（逗号分隔）' },
      { key: 'mes_example', als: ['对话示例'], label: '对话示例' },
      { key: 'system_prompt', als: ['系统提示'], label: '系统提示' }
    ],
    rules: '完整角色卡一次生成：姓名/身份/外貌/性格/背景/当前状态/标签/对话示例(mes_example，示范该角色说话口吻)/系统提示(system_prompt，角色专属全局指令)。'
  },
  relation: {
    label: '人物关系',
    keys: [
      { key: 'to_character', als: ['关联角色', '对方角色'], label: '关联角色姓名' },
      { key: 'relation', als: ['关系'], label: '关系' },
      { key: 'description', als: ['描述'], label: '描述' }
    ],
    rules: '关联角色必须是当前作品里已存在的角色姓名；关系如：师徒/宿敌/恋人/君臣。'
  },
  pstate: {
    label: '剧情线级角色状态',
    keys: [
      { key: 'status', als: ['状态'], label: '状态' },
      { key: 'notes', als: ['备注', '说明'], label: '备注' }
    ],
    rules: ''
  }
};

function genKeysListText(spec) {
  return spec.keys.map((k) => k.als[0] + (k.als.length > 1 ? `（${k.als.slice(1).join('/')}）` : '')).join('、');
}

function buildGenSystem(label, plural, extra = '') {
  const spec = GEN_KEYS[label] || { keys: [], rules: '' };
  const keysText = genKeysListText(spec);
  const multi = plural ? `
- 若这次需要生成多个候选项：每个候选项按上面的“字段名：值”逐行输出，候选项之间用单独一行“=====”分隔；不要用 Markdown 列表或代码围栏。` : `
- 本次只需要生成一项：按上面的“字段名：值”逐行输出（第一行“字段名：值”开始，不要输出任何前言）。`;
  return `你是资深中文网络小说创作与设定策划助手（服务 novel-studio，遵循 deepseek-harness novel-writing 创作内核纪律）。你负责为当前作品生成/完善「${spec.label}」。

【输出协议】
- 若还需要澄清需求才能达到 95% 信心：第一行必须严格是【提问】，并且一次只问一个问题，不要输出其他内容。
- 若已能理解需求：第一行必须严格是【成文】，随后直接输出内容，不要解释、不要客套。
- 【成文】输出时：${multi}
- 需要输出的字段：${keysText}。
- ${spec.rules || '保持与既有设定一致，不冲突、不重复。'}
${extra}`;
}

// 从服务器取“ST 式分层上下文”（参考 novel-writing-plugin 的 novel_context 装配），
// 再补上内核未覆盖的小说设定内容：设定词条库 / 分类 / 全量人物关系 / 剧情线级状态 / 作者注。
async function genWorkContextBlock() {
  let ctx = '';
  try {
    const data = await api(`/novel/context?work_id=${state.workId}&mode=full`);
    if (data && data.assembled) ctx = data.assembled;
  } catch (_) { /* 内核不可用时退化为本地组装 */ }
  const extra = [];
  if (state.terms.length) {
    extra.push('【设定词条库】\n' + state.terms.slice(0, 60).map((t) => `【${t.title}】${String(t.content || '').slice(0, 400)}${t.tags ? `（标签：${t.tags}）` : ''}`).join('\n'));
  }
  if (state.categories.length) {
    extra.push('【设定分类】\n' + state.categories.map((c) => c.name).join('、'));
  }
  if (state.relations.length) {
    const nameOf = (id) => state.characters.find((c) => c.id === id)?.name || `#${id}`;
    extra.push('【人物关系（全）】\n' + state.relations.map((r) => `${nameOf(r.from_character_id)} —${r.relation || '相关'}→ ${nameOf(r.to_character_id)}${r.description ? `（${String(r.description).slice(0, 200)}）` : ''}`).join('\n'));
  }
  if (state.plotlineCharacters.length) {
    const pName = (id) => state.plotlines.find((p) => p.id === id)?.title || `#${id}`;
    const cName = (id) => state.characters.find((c) => c.id === id)?.name || `#${id}`;
    extra.push('【剧情线级角色状态】\n' + state.plotlineCharacters.map((p) => `${cName(p.character_id)}｜${pName(p.plotline_id)}｜${p.status || '未记录'}${p.notes ? ' — ' + p.notes : ''}`).join('\n'));
  }
  if (state.work?.author_note) extra.push('【作品作者注】\n' + state.work.author_note.slice(0, 800));
  const context = [];
  if (ctx) context.push(ctx);
  if (extra.length) context.push(extra.join('\n\n'));
  return context.join('\n\n') || '（当前作品暂无可参考的设定内容）';
}

function genDialoguePrompt(system, context, initial, history) {
  const lines = [];
  lines.push(system);
  lines.push('');
  lines.push('【当前小说上下文】');
  lines.push(context);
  lines.push('');
  lines.push('【用户最初请求】');
  lines.push(initial);
  if (history.length) {
    lines.push('');
    lines.push('【已进行的对话】');
    history.forEach((m) => lines.push(m.role === 'assistant' ? `助手：${m.content}` : `用户：${m.content}`));
  }
  lines.push('');
  lines.push('请决定下一步：需要澄清就先输出【提问】并只问一个问题；已经理解就直接输出【成文】并给出全部内容。');
  return lines.join('\n');
}

// 弹窗询问 AI 的一次追问（小说设定生成版，按钮协议与正文 AI 写作一致）。
function askAIGenQuestion(question) {
  return new Promise((resolve) => {
    state.pendingAIQuestion = resolve;
    openModal({
      title: 'AI 生成 · 需要向你确认',
      body: `
        <div class="ai-writing-question">${esc(question).replace(/\n/g, '<br>')}</div>
        <div class="field mt-12">
          <label>你的回答</label>
          <textarea id="ai-writing-answer" rows="3" placeholder="直接回答 AI 的问题，它会继续追问，直到理解你的需求"></textarea>
        </div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="ai-writing-skip">跳过提问直接生成</button>
        <button class="btn" data-action="ai-writing-answer">提交回答</button>`
    });
    const input = $('#ai-writing-answer');
    if (input) input.focus();
  });
}

// 多轮【提问】→【成文】生成循环，返回最终文本；用户中途取消返回 null。
async function runGenAskLoop({ system, initial }) {
  const history = [];
  const context = await genWorkContextBlock();
  let turns = 10;
  while (turns-- > 0) {
    const data = await runHarnessJob({
      prompt: genDialoguePrompt(system, context, initial, history),
      timeout: 600000,
      model: 'deepseek-v4-pro',
      action: 'settings-gen',
      work_id: state.workId,
      chapter_id: state.currentChapterId || undefined,
      mode: 'full'
    }, '小说设定 AI 生成 · 正在分析作品与需求…');
    const parsed = parseAIWritingOutput(data.output || '');
    if (parsed.finalText) return parsed.finalText;
    if (parsed.question) {
      const answer = await askAIGenQuestion(parsed.question);
      if (answer === null) return null;
      if (answer.type === 'skip') {
        history.push({ role: 'user', content: '请不要再提问，直接给出最终结果。' });
        continue;
      }
      history.push({ role: 'assistant', content: `【提问】${parsed.question}` });
      history.push({ role: 'user', content: answer.value || '（未填写）' });
      continue;
    }
    throw new Error('AI 返回内容无法识别，请重试');
  }
  throw new Error('对话轮次过多，已停止');
}

function genSplitItems(text) {
  return String(text || '')
    .split(/\n\s*(?:={5,}|-{5,}|—{4,})\s*\n/)
    .map((s) => s.replace(/^\s*(?:={5,}|-{5,}|—{4,})/, '').trim())
    .filter(Boolean);
}

// D3：清理 AI 输出字段的脏前后缀（多余的全角/半角冒号、首尾空白），入库/回填前统一调用。
function cleanGenField(v) {
  return String(v ?? '').replace(/^[\s:：]+/, '').replace(/[\s:：]+$/, '').trim();
}

// 按“字段名：值”逐行解析一块文本为对象。
function genParseOne(text, spec) {
  const obj = {};
  const lines = String(text || '').split(/\r?\n/);
  let cur = null;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let hit = null;
    for (const f of (spec.keys || [])) {
      for (const al of f.als) {
        if (new RegExp('^' + escRe(al) + '\\s*[:：]').test(line)) { hit = f; break; }
      }
      if (hit) break;
    }
    if (hit) {
      cur = hit.key;
      const clean = line
        .replace(new RegExp('^' + hit.als.map((a) => escRe(a)).join('|') + '\\s*[:：]'), '')
        // D3：AI 偶发输出“字段名：：值”，把残留的第二个冒号一并剥掉
        .replace(/^[\s:：]+/, '')
        .trim();
      obj[cur] = ((obj[cur] || '') + ' ' + clean).trim();
    } else if (cur) {
      obj[cur] = (obj[cur] || '') + '\n' + line;
    }
  }
  Object.keys(obj).forEach((k) => { obj[k] = String(obj[k]).trim(); });
  return obj;
}

let genResultItems = [];

// 展示生成结果：多项→勾选列表；单项/纯文本→预览。
function showGenResultModal(title, text, items) {
  return new Promise((resolve) => {
    state.pendingGenResult = resolve;
    genResultItems = items || [];
    const multi = items && items.length > 1;
    const body = multi
      ? `<div class="muted mb-8">AI 生成了 ${items.length} 项，勾选要导入的：</div>
         ${items.map((it, i) => `<label class="gen-item-row"><input type="checkbox" class="gen-item-cb" data-i="${i}" checked><span class="grow gen-item-text">${esc(genItemPreview(it))}</span></label>`).join('')}`
      : `<div class="ai-apply-preview">${esc(text).replace(/\n/g, '<br>')}</div>
         ${items && items.length === 1 ? `<div class="muted mt-8">将按上面的字段回填（可稍后再编辑）。</div>` : ''}`;
    openModal({
      title: `✨ AI 生成结果 · ${title}`,
      body,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="gen-regen">重新生成</button>
        <button class="btn" data-action="gen-apply">${multi ? '导入勾选项' : '确认使用'}</button>`,
      large: true
    });
  });
}

function genItemPreview(it) {
  if (!it) return '';
  const rows = [];
  Object.entries(it).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length) rows.push(`${k}：共 ${v.length} 项`);
      return;
    }
    const s = String(v || '').trim();
    if (s) rows.push(`${k}：${s.length > 120 ? s.slice(0, 120) + '…' : s}`);
  });
  return rows.join('\n') || '（空项）';
}

// 统一“需求输入 → 先问答 → 结果(勾选/确认) → 回调”的驱动。
async function genDialog(cfg) {
  let initial = cfg.initial || `请根据当前作品设定，为「${cfg.label}」生成内容。`;
  for (;;) {
    let text;
    try {
      text = await runGenAskLoop({ system: buildGenSystem(cfg.label, !!cfg.plural, cfg.extra), initial });
    } catch (e) {
      toast(e.cancelled ? '已取消' : 'AI 生成失败：' + e.message, e.cancelled ? 'success' : 'error');
      return false;
    }
    if (text === null) return false;
    let items = null;
    if (cfg.customParse) items = cfg.customParse(text);
    else if (cfg.parseItems !== false) {
      items = cfg.plural
        ? genSplitItems(text).map((b) => genParseOne(b, GEN_KEYS[cfg.label]))
        : [genParseOne(text, GEN_KEYS[cfg.label] || { keys: [] })];
    }
    const act = await showGenResultModal(cfg.label, text, items);
    if (act === 'regen') {
      initial = initial + '\n（用户点击了“重新生成”：请换一种思路/结构与表述重新完整输出。）';
      continue;
    }
    if (act === 'apply') {
      const sel = state.genSelected && state.genSelected.length ? state.genSelected : (items || []);
      await cfg.onApply(sel, text);
      return true;
    }
    return false;
  }
}

// 纯文本类生成（长期记忆 / 作者注）：不走字段解析。
async function genTextDialog(cfg) {
  let initial = cfg.initial || '请生成内容。';
  for (;;) {
    let text;
    try {
      text = await runGenAskLoop({ system: cfg.system, initial });
    } catch (e) {
      toast(e.cancelled ? '已取消' : 'AI 生成失败：' + e.message, e.cancelled ? 'success' : 'error');
      return false;
    }
    if (text === null) return false;
    const act = await showGenResultModal(cfg.label, text, null);
    if (act === 'regen') {
      initial = initial + '\n（用户点击了“重新生成”：请换一种思路重新完整输出。）';
      continue;
    }
    if (act === 'apply') {
      await cfg.onApply(text);
      return true;
    }
    return false;
  }
}

// 需求输入弹窗（各“AI 生成新…”入口共用）。
function openGenRequester(opts) {
  state.genSubmit = opts.onSubmit;
  openModal({
    title: `✨ ${opts.title}`,
    body: `
      <div class="field">
        <label>你想生成什么？一句话即可，AI 会先提问澄清</label>
        <textarea id="gen-req-input" rows="4" placeholder="${esc(opts.placeholder || '例如：…')}"></textarea>
      </div>
      <div class="muted">${opts.hint ? opts.hint : ''} 生成过程会先向你提问（可跳过），结果出来后确认/勾选再入库。</div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="gen-run">✨ 开始生成</button>`
  });
}

async function genRefresh() {
  await loadWorkData(true);
  await render();
}

// 清理标签：中英文逗号/顿号分隔，去空、限量。
function cleanCsv(v, limit = 12) {
  return String(v || '').split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean).slice(0, limit).join(',');
}

function pickColor() {
  const colors = ['#8b5cf6', '#f43f5e', '#10b981', '#3b82f6', '#f59e0b', '#14b8a6', '#ef4444', '#6366f1'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function matchCategoryId(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const c = state.categories.find((x) => x.name === n);
  return c ? c.id : null;
}

// ---------- 各实体：批量新建（页签头部入口） ----------
function genQuickPlotlines() {
  openGenRequester({
    title: 'AI 生成剧情线',
    placeholder: '例如：生成 1 条主线 + 2 条支线，修仙争霸背景下，主线和支线彼此交织',
    hint: '生成多条时可直接勾选需要入库的线。',
    onSubmit: async (req) => {
      if (!req.trim()) { toast('请先描述需求', 'error'); return; }
      const ok = await genDialog({
        label: 'plotline', plural: true, initial: req,
        onApply: async (items) => {
          let n = 0;
          for (const it of items) {
            const title = String(it.title || '').trim();
            if (!title) continue;
            const kind = /支线|side/i.test(it.kind || '') ? 'side' : 'main';
            await api('/plotlines', { method: 'POST', body: { work_id: state.workId, title, kind, summary: it.summary || '', position: state.plotlines.length + n } });
            n++;
          }
          toast(n ? `已新建 ${n} 条剧情线` : '没有可导入的剧情线', n ? 'success' : 'error');
          await genRefresh();
        }
      });
      void ok;
    }
  });
}

// 解析“卷名/卷简介/章节N：标题|摘要”格式的一个卷块（含其章节树）。
function genParseVolumeBlock(text) {
  const block = { title: '', summary: '', chapters: [] };
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^卷名\s*[:：]\s*(.+)$/);
    if (m) { block.title = m[1].trim(); continue; }
    m = line.match(/^卷简介\s*[:：]\s*([\s\S]*)$/);
    if (m) { block.summary = m[1].trim(); continue; }
    m = line.match(/^章节\s*\d+\s*[:：]\s*(.*)$/);
    if (m) {
      const [t, s] = m[1].trim().split(/[|｜]/).map((x) => x.trim());
      block.chapters.push({ title: t || `第${block.chapters.length + 1}章`, summary: s || '' });
      continue;
    }
    if (block.summary) block.summary += '\n' + line;
  }
  return block;
}

function genQuickOutline() {
  openGenRequester({
    title: 'AI 生成整卷大纲',
    placeholder: '例如：写第一卷“少年觉醒”，7-9 章，从废材觉醒到初露锋芒',
    hint: 'AI 会一次生成 1-3 卷，每卷含若干章（标题+摘要）。勾选要导入的卷，确认后自动创建卷与章节框架（只建标题与摘要，不生成正文）。',
    onSubmit: async (req) => {
      if (!req.trim()) { toast('请先描述需求', 'error'); return; }
      const ok = await genDialog({
        label: 'volume', plural: true, initial: req,
        extra: '整卷大纲的格式要求：每个候选项代表“一卷”。先输出“卷名：…”和“卷简介：…”，随后逐行输出“章节N：标题|摘要”（N 从 1 开始，每卷建议 3-10 章；摘要为一句话大纲）。不同卷之间用单独一行“=====”分隔。只给出卷与章节的标题/摘要（细纲），不要生成正文。',
        customParse: (text) => genSplitItems(text).map((b) => genParseVolumeBlock(b)).filter((v) => v.title),
        onApply: async (volumes) => {
          if (!volumes.length) { toast('没有可导入的卷', 'error'); return; }
          let count = 0;
          for (const v of volumes) {
            const vol = await api('/volumes', { method: 'POST', body: { work_id: state.workId, title: String(v.title || '').slice(0, 60), summary: v.summary || '', position: state.volumes.length } });
            const chs = (v.chapters || []).slice(0, 30);
            for (let i = 0; i < chs.length; i++) {
              const ch = chs[i];
              if (!ch.title) continue;
              await api('/chapters', { method: 'POST', body: { work_id: state.workId, volume_id: vol.id, title: String(ch.title).slice(0, 80), summary: ch.summary || '', position: i } });
              count++;
            }
          }
          toast(`已创建 ${volumes.length} 卷、${count} 个章节`, 'success');
          await genRefresh();
        }
      });
      void ok;
    }
  });
}

function genQuickTerms() {
  openGenRequester({
    title: 'AI 生成设定词条',
    placeholder: '例如：为修仙世界生成 5 条词条：灵根、功法、丹药、门派、境界体系',
    hint: '一次生成多条词条，勾选后批量入库；分类会优先匹配现有分类，缺失时自动新建。',
    onSubmit: async (req) => {
      if (!req.trim()) { toast('请先描述需求', 'error'); return; }
      const ok = await genDialog({
        label: 'term', plural: true, initial: req,
        onApply: async (items) => {
          const createdCats = {};
          let n = 0;
          for (const it of items) {
            const title = String(it.title || '').trim();
            if (!title) continue;
            const catName = String(it.category || '').trim();
            let category_id = matchCategoryId(catName);
            if (category_id === null && catName && catName !== '未分类') {
              if (!createdCats[catName]) {
                const cat = await api('/categories', { method: 'POST', body: { work_id: state.workId, name: catName.slice(0, 20), color: pickColor(), position: state.categories.length } });
                createdCats[catName] = cat.id;
              }
              category_id = createdCats[catName];
            }
            await api('/terms', { method: 'POST', body: { work_id: state.workId, category_id: category_id || null, title, content: it.content || '', tags: cleanCsv(it.tags) } });
            n++;
          }
          toast(n ? `已新建 ${n} 个词条` : '没有可导入的词条', n ? 'success' : 'error');
          await genRefresh();
        }
      });
      void ok;
    }
  });
}

function genQuickCharacters() {
  openGenRequester({
    title: 'AI 生成角色',
    placeholder: '例如：生成 3 个主要角色：天才剑修女主、腹黑商贾男主、忠犬护卫，包含完整档案',
    hint: '每个角色生成完整档案（含对话示例与系统提示）；生成多条时勾选需要入库的角色。',
    onSubmit: async (req) => {
      if (!req.trim()) { toast('请先描述需求', 'error'); return; }
      const ok = await genDialog({
        label: 'character', plural: true, initial: req,
        onApply: async (items) => {
          let n = 0;
          for (const it of items) {
            // D3：入库前逐字段清洗，防止“：周屿”这类脏前缀落库
            const name = cleanGenField(it.name);
            if (!name) continue;
            await api('/characters', { method: 'POST', body: { work_id: state.workId, name, identity: cleanGenField(it.identity), appearance: cleanGenField(it.appearance), personality: cleanGenField(it.personality), background: cleanGenField(it.background), status: cleanGenField(it.status), avatar_color: pickColor(), mes_example: cleanGenField(it.mes_example), tags: cleanCsv(it.tags), system_prompt: cleanGenField(it.system_prompt) } });
            n++;
          }
          toast(n ? `已新建 ${n} 个角色` : '没有可导入的角色', n ? 'success' : 'error');
          await genRefresh();
        }
      });
      void ok;
    }
  });
}

function genMemorySystem() {
  return `你是资深小说编辑（deepseek-harness novel-writing 创作内核）。为当前作品起草/更新「长期记忆 / 故事摘要」。

长期记忆用于记录“已经发生的重要剧情、伏笔、角色状态变化”，供后续正文写作与 AI 上下文自动带入。

【输出协议】
- 需要澄清时第一行【提问】并一次只问一个问题；能理解后第一行【成文】直接输出。
- 【成文】输出一段 200-800 字的中文摘要草稿（纯文本，无需字段格式），内容基于【当前小说上下文】里的既有记忆与事件，把你想补充/调整的进展自然地合并进去。`;
}

function genNoteSystem(scope) {
  const target = scope === 'work' ? '整部作品通用的 AI 提示（作品作者注）' : '当前章节的 AI 提示（章节作者注）';
  return `你是资深小说编辑（deepseek-harness novel-writing 创作内核）。为当前作品起草${target}。

作者注是写给写作 AI 的“幕后指令/风格提醒/剧情备忘”，会随正文写作带入 AI 上下文。它应短小、具体、可执行。

【输出协议】
- 需要澄清时第一行【提问】并一次只问一个问题；能理解后第一行【成文】直接输出。
- 【成文】输出一段 50-300 字的中文作者注草稿（纯文本，无需字段格式）。`;
}

function genTextAreaFlow(label, system, placeholder, hint, onApply) {
  openGenRequester({
    title: label,
    placeholder,
    hint,
    onSubmit: async (req) => {
      if (!req.trim()) { toast('请先描述需求', 'error'); return; }
      const ok = await genTextDialog({ label, system, initial: req, onApply });
      void ok;
    }
  });
}

// ---------- 编辑弹窗内的 AI 回填 ----------
function genFillFromModal(kind) {
  const spec = GEN_KEYS[kind];
  if (!spec) return;
  const modalEl = $('.modal');
  if (!modalEl) return;
  const saveBtn = modalEl.querySelector('[data-action^="save-"]');
  const id = saveBtn ? saveBtn.dataset.id : '';
  const draft = collectModalData(modalEl);
  const baseOf = () => {
    if (!id) return {};
    if (kind === 'plotline') return state.plotlines.find((p) => p.id === Number(id)) || {};
    if (kind === 'volume') return state.volumes.find((v) => v.id === Number(id)) || {};
    if (kind === 'chapter') return state.chapters.find((c) => c.id === Number(id)) || {};
    if (kind === 'term') return state.terms.find((t) => t.id === Number(id)) || {};
    if (kind === 'character') return state.characters.find((c) => c.id === Number(id)) || {};
    return {};
  };
  // 取消/失败时按用户当前表单内容恢复，避免丢失已填内容。
  const restoreDraft = () => reopen(mergeParsedEntity(kind, baseOf(), draft, {}));
  const reopen = (obj) => reopenEntityModal(kind, obj, id, draft);
  closeModal();

  openGenRequester({
    title: `AI 生成「${spec.label}」并填入表单`,
    placeholder: '描述你想生成的内容，AI 会先提问澄清',
    hint: spec.rules ? spec.rules : '',
    onSubmit: async (req) => {
      if (!req.trim()) { toast('请先描述需求', 'error'); restoreDraft(); return; }
      const base = baseOf();
      try {
        const ok = await genDialog({
          label: kind, plural: false, initial: req,
          onApply: async (items) => {
            const parsed = items && items.length ? items[0] : {};
            const merged = mergeParsedEntity(kind, base, draft, parsed);
            reopen(merged);
            toast('AI 结果已回填表单，请确认后保存', 'success');
          }
        });
        if (!ok) restoreDraft();
      } catch (e) {
        toast('AI 生成失败：' + e.message, 'error');
        restoreDraft();
      }
    }
  });
}

function castNums(obj) {
  const out = { ...obj };
  ['position', 'volume_id', 'plotline_id', 'category_id', 'work_id', 'from_character_id', 'to_character_id', 'character_id'].forEach((k) => {
    if (out[k] !== undefined && out[k] !== null && out[k] !== '') {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = n;
    }
  });
  return out;
}

function mergeParsedEntity(kind, base, draft, parsed) {
  const merged = { ...(base || {}), ...castNums(draft) };
  if (!merged.work_id && state.workId) merged.work_id = state.workId;
  if (kind === 'plotline') {
    if (parsed.title) merged.title = String(parsed.title).trim();
    if (parsed.kind) merged.kind = /支线|side/i.test(parsed.kind) ? 'side' : 'main';
    if (parsed.summary) merged.summary = String(parsed.summary).trim();
  } else if (kind === 'volume') {
    if (parsed.title) merged.title = String(parsed.title).trim();
    if (parsed.summary) merged.summary = String(parsed.summary).trim();
  } else if (kind === 'chapter') {
    if (parsed.title) merged.title = String(parsed.title).trim();
    if (parsed.summary) merged.summary = String(parsed.summary).trim();
  } else if (kind === 'term') {
    if (parsed.title) merged.title = String(parsed.title).trim();
    if (parsed.content) merged.content = String(parsed.content).trim();
    if (parsed.tags) merged.tags = cleanCsv(parsed.tags);
    const cid = matchCategoryId(parsed.category);
    if (cid !== null) merged.category_id = cid;
  } else if (kind === 'character') {
    ['name', 'identity', 'appearance', 'personality', 'background', 'status'].forEach((f) => { if (parsed[f]) merged[f] = String(parsed[f]).trim(); });
    if (parsed.tags) merged.tags = cleanCsv(parsed.tags);
    if (parsed.mes_example) merged.mes_example = String(parsed.mes_example).trim();
    if (parsed.system_prompt) merged.system_prompt = String(parsed.system_prompt).trim();
  } else if (kind === 'relation') {
    if (parsed.relation) merged.relation = String(parsed.relation).trim();
    if (parsed.description) merged.description = String(parsed.description).trim();
    if (parsed.to_character) merged.to_character = String(parsed.to_character).trim();
  } else if (kind === 'pstate') {
    if (parsed.status) merged.status = String(parsed.status).trim();
    if (parsed.notes) merged.notes = String(parsed.notes).trim();
  }
  return merged;
}

function reopenEntityModal(kind, obj, id, draft) {
  const entity = { ...obj };
  if (id && id !== '') entity.id = Number(id);
  if (kind === 'plotline') openPlotlineModal(entity);
  else if (kind === 'volume') openVolumeModal(entity);
  else if (kind === 'chapter') openChapterModal(entity);
  else if (kind === 'term') openTermModal(entity);
  else if (kind === 'character') openCharacterModal(entity);
  else if (kind === 'relation') {
    const fromId = Number(draft.from_character_id || entity.from_character_id || 0);
    openRelationModal(fromId);
    setModalField('relation', obj.relation);
    setModalField('description', obj.description);
    setModalField('to_character_id', obj.to_character);
  } else if (kind === 'pstate') {
    const charId = Number(draft.character_id || entity.character_id || 0);
    const plotId = Number(draft.plotline_id || entity.plotline_id || 0);
    openPlotlineCharModal(charId, plotId);
    setModalField('status', obj.status);
    setModalField('notes', obj.notes);
  }
}

function setModalField(name, value) {
  const el = $('.modal')?.querySelector(`[name="${name}"]`);
  if (!el || value === undefined || value === null) return;
  const s = String(value).trim();
  if (!s) return;
  if (el.tagName === 'SELECT') {
    const opt = Array.from(el.options).find((o) => o.text === s || o.value === s);
    if (opt) el.value = opt.value;
  } else {
    el.value = s;
  }
}

async function runAICreateNovel() {
  const promptEl = $('#ai-create-prompt');
  const prompt = (promptEl?.value || '').trim();
  if (!prompt) {
    toast('请输入一段小说描述', 'error');
    return;
  }
  const steps = [
    'AI 正在理解你的描述',
    'AI 正在完善设定、角色、剧情线与大纲',
    '正在创建作品并写入各栏目',
    '创建完成'
  ];
  const btn = $('#ai-create-submit');
  if (btn) btn.disabled = true;
  setAICreateProgress(steps, 0);
  let stopTick = null;
  try {
    setAICreateProgress(steps, 1);
    await new Promise((r) => setTimeout(r, 100));
    stopTick = startElapsedTicker($('#ai-create-progress'), '生成中，已用时');
    const data = await api('/harness/generate_novel', {
      method: 'POST',
      body: { prompt, model: 'deepseek-v4-pro' }
    });
    if (stopTick) stopTick();
    setAICreateProgress(steps, 2);
    await new Promise((r) => setTimeout(r, 200));
    setAICreateProgress(steps, 3);
    toast(`已创建《${data.title || '未命名作品'}》`, 'success');
    await loadWorks(true);
    state.workId = data.work_id;
    state.loadedWorkId = null;
    state.view = 'overview';
    state.currentChapterId = null;
    await render();
  } catch (e) {
    setAICreateProgress(steps, -1, e.message);
    toast(e.message, 'error');
  } finally {
    if (stopTick) stopTick();
    if (btn) btn.disabled = false;
  }
}

function insertAIDraft() {
  const draft = state.aiDraft;
  const editor = $('#editor-content');
  if (!draft || !editor) return;
  editor.focus();
  const paragraphs = draft.split(/\n{2,}/).map((p) => p.replace(/\n/g, '<br>'));
  const html = paragraphs.map((p) => `<p>${p}</p>`).join('');
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const div = document.createElement('div');
      div.innerHTML = html;
      const frag = document.createDocumentFragment();
      while (div.firstChild) frag.appendChild(div.firstChild);
      range.deleteContents();
      range.insertNode(frag);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.insertAdjacentHTML('beforeend', html);
    }
    scheduleSave();
    toast('已插入 AI 内容', 'success');
  } catch (e) {
    toast('插入失败：' + e.message, 'error');
  }
}

// ---------- term linking ----------
function openTermLinkModal() {
  const editor = $('#editor-content');
  const sel = window.getSelection();
  if (sel && sel.rangeCount && sel.toString().trim()) {
    try { state.savedRange = sel.getRangeAt(0).cloneRange(); } catch (_) {}
  }
  const text = sel?.toString().trim() || '';
  openModal({
    title: '关联设定词条',
    body: `
      <div class="mb-8">选中文本：<b>${esc(text || '（未选中文本，将使用词条名）')}</b></div>
      <input id="link-term-search" placeholder="搜索词条..." class="mb-8" style="width:100%">
      <div id="link-term-list">
        ${state.terms.map((t) => `<div class="term-item" data-action="insert-term-link" data-id="${t.id}"><b>${esc(t.title)}</b><span class="muted grow">${esc((t.content || '').slice(0, 50))}</span></div>`).join('') || '<div class="muted">暂无词条，请先到设定库创建</div>'}
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button>`
  });
}

function insertTermLink(termId) {
  const term = state.termsCache.get(Number(termId));
  if (!term) return;
  const editor = $('#editor-content');
  let range = state.savedRange;
  if (!range && editor) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) range = sel.getRangeAt(0);
  }
  const text = range ? range.toString().trim() : '';
  const label = text || term.title;
  const a = document.createElement('a');
  a.className = 'term-link';
  a.contentEditable = 'false';
  a.dataset.termId = term.id;
  a.textContent = label;
  if (range && editor) {
    range.deleteContents();
    range.insertNode(a);
    range.setStartAfter(a);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else if (editor) {
    editor.insertAdjacentHTML('beforeend', `<p><a class="term-link" data-term-id="${term.id}" contenteditable="false">${esc(label)}</a></p>`);
  }
  state.savedRange = null;
  closeModal();
  scheduleSave();
  toast(`已关联：${term.title}`, 'success');
}

// ---------- global click handler ----------
document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  const closeBtn = e.target.closest('[data-close-modal]');
  const backdrop = e.target.closest('[data-modal-backdrop]');

  if (closeBtn) {
    closeModal();
    return;
  }
  if (backdrop && e.target === backdrop) {
    closeModal();
    return;
  }

  // term link inside editor
  const termLink = e.target.closest('.term-link');
  if (termLink) {
    e.preventDefault();
    e.stopPropagation();
    const id = Number(termLink.dataset.termId);
    if (id) await openTermDetail(id);
    return;
  }

  if (!actionEl) return;
  const action = actionEl.dataset.action;

  try {
    switch (action) {
      case 'back-works':
        state.workId = null;
        state.loadedWorkId = null;
        state.work = null;
        state.view = 'works';
        await render();
        break;

      case 'go-view':
        goView(actionEl.dataset.view);
        await render();
        break;

      case 'board-tab': {
        const tab = actionEl.dataset.tab;
        const board = actionEl.dataset.board;
        if (board === 'settings') {
          state.settingsTab = tab;
          state.view = 'settings';
        } else {
          state.aiTab = tab;
          state.view = 'ai-board';
        }
        await render();
        break;
      }

      // D7：AI 创作页分页签（自动创建 / 工作台 / 历史），切换时只切换区块显隐，保留工作台内容
      case 'ai-create-tab': {
        state.aiCreateHomeTab = actionEl.dataset.tab;
        try { localStorage.setItem('ns_ai_create_tab', state.aiCreateHomeTab); } catch (_) {}
        $$('.board-tabs .board-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.aiCreateHomeTab));
        $$('.ai-create-section').forEach((s) => { s.hidden = s.dataset.section !== state.aiCreateHomeTab; });
        if (state.aiCreateHomeTab === 'history') await loadCreationTasks();
        break;
      }

      case 'new-work':
        openWorkModal();
        break;

      case 'import-work': {
        const input = $('#import-file');
        if (input) input.click();
        break;
      }

      case 'batch-generate':
        askBatchGenerate();
        break;

      case 'batch-start': {
        const resolve = state.pendingBatchCount;
        if (resolve) {
          const n = Number($('#batch-count')?.value) || 3;
          state.pendingBatchCount = null;
          closeModal();
          resolve(n);
          batchGenerateChapters(n);
        }
        break;
      }

      case 'export-work-txt':
        if (state.workId) downloadExport(`/export/txt?work_id=${state.workId}`, `${state.work?.title || 'novel'}.txt`);
        break;

      case 'export-work-md':
        if (state.workId) downloadExport(`/export/md?work_id=${state.workId}`, `${state.work?.title || 'novel'}.md`);
        break;

      case 'export-chapter-txt': {
        const id = Number(actionEl.dataset.id);
        const ch = state.chapters.find((c) => c.id === id);
        if (id) downloadExport(`/export/txt?chapter_id=${id}`, `${ch?.title || 'chapter'}.txt`);
        break;
      }

      case 'open-work': {
        state.workId = Number(actionEl.dataset.id);
        state.loadedWorkId = null;
        state.view = 'overview';
        state.currentChapterId = null;
        await render();
        break;
      }

      case 'edit-work': {
        const work = state.works.find((w) => w.id === Number(actionEl.dataset.id)) || state.work;
        openWorkModal(work);
        break;
      }

      case 'save-work': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        // D4：作品名称必填（前端拦截 + 服务端兜底）
        if (!String(data.title || '').trim()) {
          toast('作品名称不能为空', 'error');
          const titleInput = modal.querySelector('input[name="title"]');
          if (titleInput) titleInput.focus();
          break;
        }
        const id = actionEl.dataset.id;
        if (id) {
          await api(`/works/${id}`, { method: 'PUT', body: data });
          toast('作品已更新', 'success');
        } else {
          await api('/works', { method: 'POST', body: data });
          toast('作品已创建', 'success');
        }
        closeModal();
        await loadWorks(true);
        if (!state.workId) await render();
        else { await loadWorkData(true); await render(); }
        break;
      }

      case 'delete-work': {
        const id = Number(actionEl.dataset.id);
        const work = state.works.find((w) => w.id === id) || state.work;
        if (!confirm(`确定删除作品《${work?.title || ''}》？\n该作品下的卷、剧情线、章节、设定、角色等全部内容都会一起删除。`)) break;
        await api(`/works/${id}`, { method: 'DELETE' });
        toast('作品已删除', 'success');
        if (state.workId === id) {
          state.workId = null;
          state.loadedWorkId = null;
          state.work = null;
          state.view = 'works';
          state.currentChapterId = null;
        }
        await loadWorks(true);
        await render();
        break;
      }

      case 'demo-install':
      case 'demo-reinstall': {
        const btn = actionEl;
        const reinstall = action === 'demo-reinstall';
        if (btn) btn.disabled = true;
        try {
          const r = await api('/demo/install', { method: 'POST', body: { force: !!reinstall } });
          toast(`已导入示例《${r.title || '雾都缝匠'}》：${r.counts.chapters} 章 / ${r.counts.characters} 角色 / ${r.counts.world_entries} 世界观词条 / ${r.counts.events} 事件`, 'success');
          state.workId = r.work_id;
          state.loadedWorkId = null;
          state.work = null;
          state.view = 'overview';
          state.currentChapterId = null;
        } catch (e) {
          toast('导入失败：' + e.message, 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
        await render();
        break;
      }

      case 'demo-remove': {
        if (!confirm('删除示例作品《雾都缝匠》？\n其卷、剧情线、章节、角色、设定、记忆与事件会全部删除。')) break;
        await api('/demo/remove', { method: 'POST' });
        toast('示例数据已删除', 'success');
        if (state.workId && state.work?.title === '雾都缝匠') {
          state.workId = null;
          state.work = null;
          state.loadedWorkId = null;
          state.view = 'works';
          state.currentChapterId = null;
        }
        await loadWorks(true);
        await render();
        break;
      }

      case 'demo-open': {
        state.workId = Number(actionEl.dataset.id);
        state.loadedWorkId = null;
        state.work = null;
        state.view = 'overview';
        state.currentChapterId = null;
        await render();
        break;
      }

      case 'new-volume':
        openVolumeModal();
        break;

      case 'edit-volume':
        openVolumeModal(state.volumes.find((v) => v.id === Number(actionEl.dataset.id)));
        break;

      case 'delete-volume': {
        const id = Number(actionEl.dataset.id);
        if (!confirm(`确定删除卷“${state.volumes.find((v) => v.id === id)?.title || ''}”？`)) break;
        await api(`/volumes/${id}`, { method: 'DELETE' });
        toast('已删除', 'success');
        await loadWorkData(true);
        await render();
        break;
      }

      case 'save-volume': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        data.volume_id = undefined;
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/volumes/${id}`, { method: 'PUT', body: data })
          : await api('/volumes', { method: 'POST', body: data });
        upsertState('volumes', saved);
        closeModal();
        await render();
        break;
      }

      case 'new-plotline':
        openPlotlineModal();
        break;

      case 'edit-plotline':
        openPlotlineModal(state.plotlines.find((p) => p.id === Number(actionEl.dataset.id)));
        break;

      case 'delete-plotline': {
        const id = Number(actionEl.dataset.id);
        if (!confirm('确定删除该剧情线？')) break;
        await api(`/plotlines/${id}`, { method: 'DELETE' });
        if (state.currentPlotlineId === id) state.currentPlotlineId = null;
        await loadWorkData(true);
        await render();
        break;
      }

      case 'select-plotline':
        state.currentPlotlineId = Number(actionEl.dataset.id);
        await render();
        break;

      case 'save-plotline': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        // D5：用户手动输入“主线：/支线：”前缀时存储前剥离，显示层按 kind 统一加前缀
        if (data.title) data.title = data.title.replace(/^(?:主线|支线)\s*[:：]\s*/, '').trim();
        if (!data.title) { toast('剧情线名称不能为空', 'error'); break; }
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/plotlines/${id}`, { method: 'PUT', body: data })
          : await api('/plotlines', { method: 'POST', body: data });
        upsertState('plotlines', saved);
        closeModal();
        await render();
        break;
      }

      case 'new-chapter':
      case 'new-chapter-in-volume': {
        openChapterModal(null, { volume_id: actionEl.dataset.id || '' });
        break;
      }

      case 'new-chapter-with-plot': {
        openChapterModal(null, { plotline_id: actionEl.dataset.id || '' });
        break;
      }

      case 'edit-chapter': {
        const ch = state.chapters.find((c) => c.id === Number(actionEl.dataset.id));
        openChapterModal(ch);
        break;
      }

      case 'delete-chapter': {
        const id = Number(actionEl.dataset.id);
        const ch = state.chapters.find((c) => c.id === id);
        if (!confirm(`确定删除“${ch?.title || ''}”？`)) break;
        await api(`/chapters/${id}`, { method: 'DELETE' });
        if (state.currentChapterId === id) state.currentChapterId = null;
        await loadWorkData(true);
        await render();
        break;
      }

      case 'save-chapter': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/chapters/${id}`, { method: 'PUT', body: data })
          : await api('/chapters', { method: 'POST', body: data });
        upsertState('chapters', saved);
        closeModal();
        state.currentChapterId = saved.id;
        state.view = 'writing';
        await render();
        break;
      }

      case 'open-chapter': {
        state.currentChapterId = Number(actionEl.dataset.id);
        state.view = 'writing';
        await render();
        break;
      }

      case 'set-layout': {
        state.editorLayout = actionEl.dataset.layout;
        localStorage.setItem('ns_editor_layout', state.editorLayout);
        await render();
        break;
      }

      case 'set-outline-mode': {
        state.outlineMode = actionEl.dataset.mode;
        localStorage.setItem('ns_outline_mode', state.outlineMode);
        await render();
        break;
      }

      case 'toggle-mind-node': {
        const node = actionEl.closest('.mind-node');
        if (node) node.classList.toggle('open');
        break;
      }

      case 'toolbar-ai-write':
        await runToolbarAIWrite();
        break;

      // D5：AI 写作需求确认框的两个按钮
      case 'toolbar-ai-write-confirm': {
        const resolve = state.pendingToolbarAIWrite;
        const req = $('#toolbar-ai-write-req')?.value?.trim() || '';
        state.pendingToolbarAIWrite = null;
        closeModal();
        if (resolve) resolve(req);
        break;
      }

      case 'toolbar-ai-write-direct': {
        const resolve = state.pendingToolbarAIWrite;
        state.pendingToolbarAIWrite = null;
        closeModal();
        if (resolve) resolve('');
        break;
      }

      // D7：取消当前正在运行的 AI 任务（harness 慢通道）
      case 'ai-task-cancel': {
        const task = activeAITask;
        if (task && task.cancel) {
          if (actionEl) { actionEl.disabled = true; actionEl.textContent = '停止中…'; }
          task.cancel();
        }
        break;
      }

      case 'toolbar-ai-polish':
        await runToolbarAIPolish();
        break;

      case 'toolbar-ai-expand':
        await runToolbarAIExpand();
        break;

      case 'confirm-ai-instruction': {
        const resolve = state.pendingAIInstruction;
        const instruction = $('#ai-instruction-input')?.value?.trim() || '';
        state.pendingAIInstruction = null;
        closeModal();
        if (resolve) resolve(instruction);
        break;
      }

      case 'confirm-ai-apply': {
        const pending = state.pendingAIApply;
        state.pendingAIApply = null;
        closeModal();
        if (pending?.onApply) await pending.onApply();
        break;
      }

      case 'ai-writing-answer': {
        const resolve = state.pendingAIQuestion;
        const answer = $('#ai-writing-answer')?.value?.trim() || '';
        state.pendingAIQuestion = null;
        closeModal();
        if (resolve) resolve({ type: 'answer', value: answer });
        break;
      }

      case 'ai-writing-skip': {
        const resolve = state.pendingAIQuestion;
        state.pendingAIQuestion = null;
        closeModal();
        if (resolve) resolve({ type: 'skip' });
        break;
      }

      case 'ai-writing-insert': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        closeModal();
        applySelectedProposals();
        if (resolve) resolve('insert');
        break;
      }

      case 'ai-writing-replace': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        closeModal();
        applySelectedProposals();
        if (resolve) resolve('replace');
        break;
      }

      case 'ai-writing-append': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        closeModal();
        applySelectedProposals();
        if (resolve) resolve('append');
        break;
      }

      case 'ai-writing-regenerate': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        closeModal();
        if (resolve) resolve('regenerate');
        break;
      }

      case 'ai-writing-review': {
        const info = state.pendingAIArticle;
        state.pendingAIFinal = null;
        state.pendingAIArticle = null;
        closeModal();
        if (info) runArticleReview(info);
        break;
      }

      case 'review-confirm':
        await refineByChecklist();
        break;

      case 'diff-merge':
        await mergeReviewDiff();
        break;

      case 'blueprint-confirm': {
        const resolve = state.pendingBlueprint;
        state.pendingBlueprint = null;
        closeModal();
        if (resolve) resolve({
          scene_goal: $('#bp-scene-goal')?.value?.trim() || '',
          plot_points: $('#bp-plot-points')?.value?.trim() || '',
          conflicts: $('#bp-conflicts')?.value?.trim() || '',
          character_changes: $('#bp-char-changes')?.value?.trim() || '',
          hook: $('#bp-hook')?.value?.trim() || '',
          references: $('#bp-references')?.value?.trim() || '',
          target_words: Number($('#bp-target-words')?.value) || resolveTargetWords()
        });
        break;
      }

      case 'blueprint-skip-prose': {
        const resolve = state.pendingBlueprint;
        state.pendingBlueprint = null;
        closeModal();
        if (resolve) resolve({ skip: true });
        break;
      }

      case 'open-proposal-confirm':
        await openProposalConfirm();
        break;

      case 'proposal-apply-selected':
        await settleProposalsFromModal('apply');
        break;

      case 'proposal-reject-selected':
        await settleProposalsFromModal('reject');
        break;

      case 'manual-save-chapter':
        await manualSaveChapter();
        break;

      case 'open-save-history':
        await openSaveHistory();
        break;

      case 'view-version':
        await viewSaveVersion(actionEl.dataset.id);
        break;

      case 'restore-version':
        await restoreSaveVersion(actionEl.dataset.id);
        break;

      case 'refresh-ai-errors':
        await loadAIErrors();
        break;

      case 'shutdown-server': {
        if (!confirm('确定关闭 Novel Studio 并释放端口吗？')) break;
        try {
          await api('/shutdown', { method: 'POST' });
          toast('服务已关闭，可以关闭此页面', 'success');
        } catch (e) {
          toast('关闭请求失败：' + e.message, 'error');
        }
        break;
      }

      case 'format': {
        const editor = $('#editor-content');
        if (!editor) break;
        editor.focus();
        const format = actionEl.dataset.format;
        if (format === 'formatBlock') {
          document.execCommand('formatBlock', false, actionEl.dataset.value);
        } else {
          document.execCommand(format, false, null);
        }
        scheduleSave();
        break;
      }

      case 'ref-tab':
        renderReference(actionEl.dataset.tab);
        break;

      case 'context-refresh':
        renderReference('context');
        break;

      case 'context-char-toggle': {
        const chapter = state.chapters.find((c) => c.id === state.currentChapterId);
        if (!chapter) break;
        const id = Number(actionEl.dataset.id);
        const ids = String(chapter.context_character_ids || '').split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
        const has = ids.includes(id);
        if (actionEl.checked && !has) ids.push(id);
        if (!actionEl.checked && has) ids.splice(ids.indexOf(id), 1);
        try {
          const saved = await api(`/chapters/${chapter.id}`, { method: 'PUT', body: { context_character_ids: ids.join(',') } });
          upsertState('chapters', saved);
          toast('已更新本章强制带入角色', 'success');
        } catch (e) {
          toast('保存失败：' + e.message, 'error');
        }
        renderReference('context');
        break;
      }

      case 'foreshadow-goto': {
        state.currentChapterId = Number(actionEl.dataset.id);
        await render();
        break;
      }

      case 'foreshadow-status': {
        const id = Number(actionEl.dataset.id);
        const status = actionEl.dataset.status;
        try {
          await api(`/novel/foreshadows/${id}/status`, { method: 'POST', body: { status } });
          toast(status === 'resolved' ? '已标记为回收' : status === 'dropped' ? '已标记为废弃' : '已恢复未闭合', 'success');
          renderReference('foreshadows');
        } catch (e) {
          toast('操作失败：' + e.message, 'error');
        }
        break;
      }

      // 专项 A：词条预览展开/收起（默认折叠为标题）
      case 'ref-preview-toggle': {
        state.refPreview = !state.refPreview;
        try { localStorage.setItem('ns_ref_preview', state.refPreview ? '1' : '0'); } catch (_) { /* 存储不可用时仅本次会话生效 */ }
        actionEl.textContent = state.refPreview ? '收起预览' : '展开预览';
        renderReference(state.refTab);
        break;
      }

      case 'new-category':
        openCategoryModal();
        break;

      case 'delete-category': {
        const id = Number(actionEl.dataset.id);
        if (!confirm('删除该分类？词条不会被删除。')) break;
        await api(`/categories/${id}`, { method: 'DELETE' });
        await loadWorkData(true);
        await render();
        break;
      }

      case 'save-category': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        const saved = await api('/categories', { method: 'POST', body: data });
        upsertState('categories', saved);
        closeModal();
        await render();
        break;
      }

      case 'new-term':
        openTermModal();
        break;

      case 'select-term':
        state.currentTermId = Number(actionEl.dataset.id);
        await render();
        break;

      case 'select-category':
        state.currentCategoryId = actionEl.dataset.id === 'all' ? 'all' : Number(actionEl.dataset.id);
        await render();
        break;

      case 'edit-term':
        openTermModal(state.terms.find((t) => t.id === Number(actionEl.dataset.id)));
        break;

      case 'delete-term': {
        const id = Number(actionEl.dataset.id);
        if (!confirm('删除该词条？正文中的关联会变成普通文本。')) break;
        await api(`/terms/${id}`, { method: 'DELETE' });
        state.currentTermId = null;
        await loadWorkData(true);
        await render();
        break;
      }

      case 'save-term': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/terms/${id}`, { method: 'PUT', body: data })
          : await api('/terms', { method: 'POST', body: data });
        upsertState('terms', saved);
        state.termsCache.set(saved.id, saved);
        state.terms.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
        closeModal();
        await render();
        break;
      }

      case 'new-character':
        openCharacterModal();
        break;

      case 'select-character':
        state.currentCharacterId = Number(actionEl.dataset.id);
        await render();
        break;

      case 'edit-character':
        openCharacterModal(state.characters.find((c) => c.id === Number(actionEl.dataset.id)));
        break;

      case 'char-status-events':
        await openCharStatusEvents(Number(actionEl.dataset.id || state.currentCharacterId));
        break;

      case 'char-status-sync': {
        const charId = Number(actionEl.dataset.char);
        const eventId = Number(actionEl.dataset.event);
        try {
          const data = await api(`/novel/events?work_id=${state.workId}&limit=100`);
          const ev = (data.events || []).find((e) => e.id === eventId);
          if (!ev) throw new Error('事件不存在');
          const saved = await api(`/characters/${charId}`, { method: 'PUT', body: { status: String(ev.summary || '') } });
          upsertState('characters', saved);
          state.charsCache.set(saved.id, saved);
          closeModal();
          toast('已同步为当前状态', 'success');
          await render();
        } catch (e) {
          toast('同步失败：' + e.message, 'error');
        }
        break;
      }

      case 'delete-character': {
        const id = Number(actionEl.dataset.id);
        if (!confirm('删除该角色？关联关系也会删除。')) break;
        await api(`/characters/${id}`, { method: 'DELETE' });
        state.currentCharacterId = null;
        await loadWorkData(true);
        await render();
        break;
      }

      case 'save-character': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/characters/${id}`, { method: 'PUT', body: data })
          : await api('/characters', { method: 'POST', body: data });
        upsertState('characters', saved);
        state.charsCache.set(saved.id, saved);
        state.characters.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
        closeModal();
        await render();
        break;
      }

      case 'add-relation':
        openRelationModal(Number(actionEl.dataset.id || state.currentCharacterId));
        break;

      case 'save-relation': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        if (!data.to_character_id) { toast('请选择关联角色', 'error'); break; }
        const saved = await api('/relations', { method: 'POST', body: { ...data, to_character_id: Number(data.to_character_id), from_character_id: Number(data.from_character_id) } });
        upsertState('relations', saved);
        closeModal();
        await render();
        break;
      }

      case 'delete-relation': {
        const id = Number(actionEl.dataset.id);
        await api(`/relations/${id}`, { method: 'DELETE' });
        await loadWorkData(true);
        await render();
        break;
      }

      case 'edit-plotline-char':
        openPlotlineCharModal(Number(actionEl.dataset.char), Number(actionEl.dataset.plot));
        break;

      case 'save-plotline-char': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        data.work_id = Number(data.work_id);
        data.plotline_id = Number(data.plotline_id);
        data.character_id = Number(data.character_id);
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/plotline_characters/${id}`, { method: 'PUT', body: data })
          : await api('/plotline_characters', { method: 'POST', body: data });
        upsertState('plotlineCharacters', saved);
        closeModal();
        await render();
        break;
      }

      case 'open-character':
        state.currentCharacterId = Number(actionEl.dataset.id);
        goView('characters');
        await render();
        break;

      case 'open-term':
        await openTermDetail(Number(actionEl.dataset.id));
        break;

      case 'new-api-config':
        openApiConfigModal();
        break;

      case 'edit-api-config':
        openApiConfigModal(state.apiConfigs.find((c) => c.id === Number(actionEl.dataset.id)));
        break;

      case 'delete-api-config': {
        const id = Number(actionEl.dataset.id);
        if (!confirm('删除该 API 配置？')) break;
        await api(`/api_configs/${id}`, { method: 'DELETE' });
        if (state.activeConfigId === id) state.activeConfigId = null;
        if (state.workId) await loadWorkData(true);
        else await ensureApiConfigs(true);
        await render();
        break;
      }

      case 'set-active-config': {
        state.activeConfigId = Number(actionEl.dataset.id);
        localStorage.setItem('ns_active_config', String(state.activeConfigId));
        toast('已设为当前配置', 'success');
        await render();
        break;
      }

      case 'test-api-config': {
        const id = Number(actionEl.dataset.id);
        const btn = actionEl;
        btn.disabled = true;
        btn.textContent = '测试中...';
        try {
          await api('/ai/test', { method: 'POST', body: { config_id: id } });
          toast('连接成功', 'success');
        } catch (e) {
          toast('连接失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '测试连接';
        }
        break;
      }

      case 'save-api-config': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        data.temperature = Number(data.temperature);
        data.max_tokens = Number(data.max_tokens);
        const id = actionEl.dataset.id;
        const saved = id
          ? await api(`/api_configs/${id}`, { method: 'PUT', body: data })
          : await api('/api_configs', { method: 'POST', body: data });
        upsertState('apiConfigs', saved);
        closeModal();
        await render();
        break;
      }

      case 'new-st-character':
        openSTCharacterModal();
        break;

      case 'edit-st-character': {
        const character = state.characters.find((c) => c.id === Number(actionEl.dataset.id));
        openSTCharacterModal(character);
        break;
      }

      case 'save-st-character':
        await saveSTCharacter();
        break;

      case 'save-story-memory':
        await saveStoryMemory();
        break;

      case 'compress-story-memory':
        await compressStoryMemory();
        break;

      case 'open-memory-versions':
        await openMemoryVersions();
        break;

      case 'memory-version-rollback':
        await rollbackMemoryVersion(Number(actionEl.dataset.id));
        break;

      case 'memory-version-diff':
        await showMemoryVersionDiff(Number(actionEl.dataset.id));
        break;

      case 'redline-manage':
        await openRedlineManager();
        break;

      case 'redline-save':
        await saveRedlines();
        break;

      case 'redline-add-row': {
        const box = $('#redline-rows');
        if (box) {
          const empty = $('#redline-empty');
          if (empty) empty.remove();
          box.insertAdjacentHTML('beforeend', redlineRowHtml());
        }
        break;
      }

      case 'redline-del-row': {
        const row = actionEl.closest('[data-redline-row]');
        if (row) {
          row.remove();
          const box = $('#redline-rows');
          if (box && !box.querySelector('[data-redline-row]')) {
            box.innerHTML = '<div class="muted" id="redline-empty">暂无红线，点下方按钮添加</div>';
          }
        }
        break;
      }

      case 'save-st-work-note':
        await saveSTWorkNote();
        break;

      case 'save-st-chapter-note':
        await saveSTChapterNote();
        break;

      case 'new-world-entry':
        openWorldEntryModal();
        break;

      case 'edit-world-entry': {
        const entry = state.worldEntries.find((w) => w.id === Number(actionEl.dataset.id));
        openWorldEntryModal(entry);
        break;
      }

      case 'save-world-entry':
        await saveWorldEntry();
        break;

      case 'delete-world-entry':
        await deleteWorldEntry(actionEl.dataset.id);
        break;

      case 'link-term-modal':
        openTermLinkModal();
        break;

      case 'insert-term-link':
        insertTermLink(Number(actionEl.dataset.id));
        break;

      case 'ai-write':
        await runAIWrite();
        break;

      case 'ai-create-submit':
        await runAICreateNovel();
        break;

      case 'harness-pipeline-start':
        await runHarnessPipeline();
        break;

      case 'pipeline-save':
        await savePipelineToWork();
        break;

      case 'pipeline-pause-toggle':
        togglePipelinePause();
        break;

      case 'pipeline-stop':
        stopPipeline();
        break;

      case 'pipeline-restart-stage':
        await restartPipelineFromStage(actionEl.dataset.stage);
        break;

      case 'refresh-creation-tasks':
        await loadCreationTasks();
        break;

      case 'pipeline-copy': {
        const key = actionEl.dataset.stage;
        const text = $(`[data-stage-output="${key}"]`)?.value;
        if (!text) { toast('该阶段还没有内容', 'error'); break; }
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制到剪贴板', 'success');
        } catch (_) {
          toast('复制失败', 'error');
        }
        break;
      }

      case 'ai-outline':
        await runAIOutline();
        break;

      case 'ai-personality': {
        const chars = state.characters;
        if (!chars.length) { toast('请先创建角色', 'error'); break; }
        const labels = chars.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
        const pick = prompt(`选择要校对的角色（输入序号）：\n${labels}`);
        if (pick === null) break;
        const idx = Number(pick) - 1;
        if (chars[idx]) state.aiCharacterId = chars[idx].id;
        await runAIPersonality();
        break;
      }

      case 'ai-insert':
        insertAIDraft();
        break;

      // ---------- 小说设定 AI 生成 ----------
      case 'ai-gen-plotlines-new':
        genQuickPlotlines();
        break;

      case 'ai-gen-outline':
        genQuickOutline();
        break;

      case 'ai-gen-terms-new':
        genQuickTerms();
        break;

      case 'ai-gen-characters-new':
        genQuickCharacters();
        break;

      case 'ai-gen-memory':
        genTextAreaFlow('AI 起草长期记忆', genMemorySystem(), '例如：把最近几章确认发生的事件、新伏笔与角色状态变化整理进长期记忆', '生成的是草稿，会写入上方记忆框，你仍可修改后点“保存记忆”。', async (text) => {
          const el = $('#story-memory-input');
          if (el) { el.value = text; toast('已写入记忆草稿，可修改后保存', 'success'); }
        });
        break;

      case 'ai-gen-work-note':
        genTextAreaFlow('AI 起草作品作者注', genNoteSystem('work'), '例如：整部作品保持“冷幽默、快节奏、少描写多对话”的风格', '草稿会写入“作品作者注”输入框，可修改后保存。', async (text) => {
          const el = $('#st-work-author-note');
          if (el) { el.value = text; toast('已写入作品作者注草稿', 'success'); }
        });
        break;

      case 'ai-gen-chapter-note': {
        const sel = $('#st-chapter-select');
        const chId = sel ? Number(sel.value) : state.currentChapterId;
        const ch = state.chapters.find((c) => c.id === chId) || null;
        const noteInfo = ch ? `当前章节：${ch.title}${ch.summary ? `\n大纲摘要：${ch.summary.slice(0, 300)}` : ''}` : '';
        genTextAreaFlow('AI 起草章节作者注', genNoteSystem('chapter'), '例如：本章需要让读者感受到主角的动摇与抉择', noteInfo ? `关联章节：\n${noteInfo}` : '生成时请结合当前章节情况。', async (text) => {
          const el = $('#st-chapter-author-note');
          if (el) { el.value = text; toast('已写入章节作者注草稿', 'success'); }
        });
        break;
      }

      case 'gen-fill':
        genFillFromModal(actionEl.dataset.kind);
        break;

      case 'gen-run': {
        const req = ($('#gen-req-input')?.value || '').trim();
        const submit = state.genSubmit;
        if (!req) { toast('请先描述需求', 'error'); break; }
        state.genSubmit = null;
        closeModal();
        if (submit) await submit(req);
        break;
      }

      case 'gen-regen': {
        const resolve = state.pendingGenResult;
        state.pendingGenResult = null;
        closeModal();
        if (resolve) resolve('regen');
        break;
      }

      case 'gen-apply': {
        const resolve = state.pendingGenResult;
        state.pendingGenResult = null;
        const selected = genResultItems.length
          ? genResultItems.filter((_, i) => {
              const cb = $(`.gen-item-cb[data-i="${i}"]`);
              return !cb || cb.checked;
            })
          : [];
        state.genSelected = selected;
        closeModal();
        if (resolve) resolve('apply');
        break;
      }

      default:
        break;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- global input events ----------
// 搜索关键词高亮：先转义 HTML，再把查询词（按空白拆分）包进 <mark>。
function highlightTerms(text, q) {
  const safe = esc(String(text || ''));
  const kws = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 5)
    .map((k) => esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!kws.length) return safe;
  const re = new RegExp(`(${kws.join('|')})`, 'gi');
  return safe.replace(re, '<mark class="search-hit">$1</mark>');
}

const debouncedSearch = debounce(async () => {
  const q = $('#global-search').value.trim();
  const box = $('#search-results');
  if (!q) { box.hidden = true; return; }
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}${state.workId ? `&work_id=${state.workId}` : ''}`);
    const group = (label, items, fn) => items.length ? `
      <div class="search-group-title">${label}（${items.length}）</div>
      ${items.map(fn).join('')}` : '';
    box.innerHTML = group('设定词条', data.terms, (t) => `<div class="search-item" data-action="search-go" data-type="term" data-id="${t.id}" data-work-id="${t.work_id || ''}"><div class="title">${highlightTerms(t.title, q)}</div><div class="snippet">${highlightTerms(t.snippet || stripHtml(t.content || '').slice(0, 60), q)}</div></div>`)
      + group('章节/正文', data.chapters, (c) => `<div class="search-item" data-action="search-go" data-type="chapter" data-id="${c.id}" data-work-id="${c.work_id || ''}"><div class="title">${highlightTerms(c.title, q)}</div><div class="snippet">${highlightTerms(c.snippet || stripHtml(c.summary || c.content || '').slice(0, 60), q)}</div></div>`)
      + group('角色', data.characters, (c) => `<div class="search-item" data-action="search-go" data-type="character" data-id="${c.id}" data-work-id="${c.work_id || ''}"><div class="title">${highlightTerms(c.name, q)}</div><div class="snippet">${highlightTerms(c.identity || '', q)}</div></div>`)
      + group('剧情线', data.plotlines, (p) => `<div class="search-item" data-action="search-go" data-type="plotline" data-id="${p.id}" data-work-id="${p.work_id || ''}"><div class="title">${highlightTerms(plotlineDisplayTitle(p), q)}</div><div class="snippet">${highlightTerms(p.snippet || p.summary || '', q)}</div></div>`);
    if (!box.innerHTML) box.innerHTML = '<div class="muted search-empty">未找到与「' + esc(q) + '」相关的内容</div>';
    box.hidden = false;
  } catch (_) {
    box.hidden = true;
  }
}, 300);

document.addEventListener('change', async (e) => {
  if (e.target.id === 'import-file') {
    handleImportFile(e.target.files?.[0]);
    return;
  }
  if (e.target.id === 'st-chapter-select') {
    state.currentChapterId = Number(e.target.value);
    render();
  }
  // D15：单栏布局下的章节切换器
  if (e.target.id === 'chapter-switcher') {
    state.currentChapterId = Number(e.target.value);
    await render();
    persistSession();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'global-search') {
    debouncedSearch();
  }
  if (e.target.id === 'link-term-search') {
    const q = e.target.value.trim().toLowerCase();
    const list = $('#link-term-list');
    if (!list) return;
    const items = state.terms.filter((t) => !q || t.title.toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q) || (t.tags || '').toLowerCase().includes(q));
    list.innerHTML = items.map((t) => `<div class="term-item" data-action="insert-term-link" data-id="${t.id}"><b>${esc(t.title)}</b><span class="muted grow">${esc((t.content || '').slice(0, 50))}</span></div>`).join('') || '<div class="muted">无匹配词条</div>';
  }
  if (e.target.id === 'term-search') {
    const q = e.target.value.trim().toLowerCase();
    const items = state.terms.filter((t) => !q || t.title.toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q) || (t.tags || '').toLowerCase().includes(q));
    const list = $('.terms-list');
    if (list) {
      const oldDetail = list.innerHTML;
      list.innerHTML = `<div class="mb-8"><input id="term-search" placeholder="搜索词条..." value="${esc(e.target.value)}"></div>` + (items.map((t) => `<div class="term-item ${state.currentTermId === t.id ? 'active' : ''}" data-action="select-term" data-id="${t.id}"><b>${esc(t.title)}</b><span class="muted grow" style="font-size:12px">${esc(t.tags || '')}</span></div>`).join('') || '<div class="muted">暂无词条</div>');
      void oldDetail;
    }
  }
  if (e.target.id === 'character-search') {
    const q = e.target.value.trim().toLowerCase();
    const items = state.characters.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.identity || '').toLowerCase().includes(q) || (c.personality || '').toLowerCase().includes(q));
    const list = $('#character-list');
    if (list) {
      list.innerHTML = items.map((c) => `
        <div class="character-card ${state.currentCharacterId === c.id ? 'active' : ''}" data-action="select-character" data-id="${c.id}">
          <span class="avatar" style="background:${esc(c.avatar_color || '#8b5cf6')}">${esc((c.name || '?').slice(0, 1))}</span>
          <div class="grow"><div><b>${esc(c.name)}</b></div><div class="muted" style="font-size:12px">${esc(c.identity || '')}</div></div>
        </div>`).join('') || '<div class="muted">无匹配角色</div>';
    }
  }
});

// search result click
// D2：初始页点击跨作品搜索结果时，自动进入对应作品再定位，不再静默丢弃用户意图。
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-action="search-go"]');
  if (!go) return;
  e.preventDefault();
  const type = go.dataset.type;
  const id = Number(go.dataset.id);
  const workId = Number(go.dataset.workId) || null;
  $('#global-search').value = '';
  $('#search-results').hidden = true;
  const crossing = workId && workId !== state.workId;
  if (crossing) {
    // 跨作品跳转：先进入目标作品
    state.workId = workId;
    state.loadedWorkId = null;
    state.currentChapterId = null;
    state.currentPlotlineId = null;
    state.currentTermId = null;
    state.currentCharacterId = null;
  }
  if (type === 'term') {
    goView('terms');
    state.currentTermId = id;
    await render();
  } else if (type === 'chapter') {
    state.currentChapterId = id;
    state.view = 'writing';
    await render();
  } else if (type === 'character') {
    goView('characters');
    state.currentCharacterId = id;
    await render();
  } else if (type === 'plotline') {
    goView('plot');
    state.currentPlotlineId = id;
    await render();
  }
  if (crossing) toast('已进入对应作品并定位到搜索结果', 'success');
});

// tooltip
document.addEventListener('mouseover', (e) => {
  const link = e.target.closest('.term-link');
  const tip = $('#tooltip');
  if (!link || !tip) return;
  const id = Number(link.dataset.termId);
  const term = state.termsCache.get(id);
  if (!term) return;
  tip.innerHTML = `<div class="tt-title">${esc(term.title)}</div><div class="tt-body">${esc((term.content || '').slice(0, 140))}</div>`;
  tip.hidden = false;
  const move = (ev) => {
    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 320) + 'px';
    tip.style.top = (ev.clientY + 14) + 'px';
  };
  move(e);
  const onMove = (ev) => move(ev);
  const onOut = () => {
    tip.hidden = true;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseout', onOut);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseout', onOut);
});

// sidebar toggle
document.addEventListener('click', (e) => {
  if (e.target.closest('#sidebar-toggle')) {
    $('#sidebar').classList.toggle('hidden');
    updateSidebarToggleIcon();
  }
});

// sidebar nav
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#sidebar-nav button[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  await render();
});

// keyboard: hide search on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const box = $('#search-results');
    if (box) box.hidden = true;
    if ($('#modal-root').innerHTML) closeModal();
  }
});

// ---------- init ----------
// D11：侧栏折叠按钮图标随状态切换（◀=可收起 / ▶=可展开），不再用误导性的 ☰
function updateSidebarToggleIcon() {
  const icon = $('#sidebar-toggle');
  if (icon) icon.textContent = $('#sidebar').classList.contains('hidden') ? '▶' : '◀';
}

async function init() {
  $('#global-search').addEventListener('focus', () => {
    const q = $('#global-search').value.trim();
    if (q) debouncedSearch();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) $('#search-results').hidden = true;
  });
  const topbarRight = $('#topbar-right');
  if (topbarRight) {
    topbarRight.innerHTML = `<button class="btn small danger" data-action="shutdown-server" title="关闭服务并释放端口">⏻ 关闭</button>`;
  }
  updateSidebarToggleIcon();
  // D13：恢复上次会话位置；作品已被删除时安全回退到初始页
  restoreSession();
  if (state.workId) {
    try {
      await loadWorks(true);
      if (!state.works.some((w) => w.id === state.workId)) {
        state.workId = null;
        state.loadedWorkId = null;
        state.view = 'works';
      }
    } catch (_) {
      state.workId = null;
      state.view = 'works';
    }
  }
  if (!state.workId) state.view = 'works';
  await render();
}

init().catch((e) => toast(e.message, 'error'));
