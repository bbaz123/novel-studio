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
  editorLayout: localStorage.getItem('ns_editor_layout') || 'three',
  outlineMode: localStorage.getItem('ns_outline_mode') || 'mind',
  settingsTab: 'terms',
  aiTab: 'ai-create',
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
  pipelinePaused: false,
  pipelineStopped: false,
  pipelineResume: null,
  aiContext: null,
  termsCache: new Map(),
  charsCache: new Map()
};

// 合并后的侧栏板块：小说设定 / AI创造板块
const SETTINGS_VIEWS = ['plot', 'outline', 'terms', 'characters', 'memory'];
const AI_VIEWS = ['ai-create', 'ai', 'st'];

function isSettingsView(view) {
  return view === 'settings' || SETTINGS_VIEWS.includes(view);
}

function isAIView(view) {
  return view === 'ai-board' || AI_VIEWS.includes(view);
}

// 统一跳转：把旧子页面视图映射到新的合并板块。
function goView(view) {
  if (SETTINGS_VIEWS.includes(view)) {
    state.settingsTab = view;
    state.view = 'settings';
  } else if (AI_VIEWS.includes(view)) {
    state.aiTab = view;
    state.view = 'ai-board';
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

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 2600);
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

function wordCount(text = '') {
  return text.replace(/\s/g, '').length;
}

function setSidebar(show) {
  $('#sidebar').classList.toggle('hidden', !show);
}

function setTopbarTitle(text) {
  $('#topbar-title').textContent = text;
}

function updateSidebarTitle() {
  $('#sidebar-title').textContent = state.work ? state.work.title : '我的作品';
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
    if (v === 'works') {
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
    b.classList.toggle('active', active);
  });
}

async function render() {
  const content = $('#content');
  if (!state.workId) {
    state.view = 'works';
    setSidebar(true);
    updateSidebarTitle();
    setTopbarTitle('Novel Studio');
    updateNavVisibility();
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
    content.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function renderWorks() {
  const content = $('#content');
  await loadWorks();
  const works = state.works;
  let demo = null;
  try { demo = await api('/demo/status'); } catch (_) { /* 旧服务端无此接口时静默 */ }
  const demoExists = !!(demo && demo.exists);
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">我的作品</h1>
        <div class="page-sub">管理你的所有小说项目</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="new-work">＋ 新建作品</button>
      </div>
    </div>
    ${works.length ? '' : '<div class="empty">还没有作品，可以点击右上角“新建作品”开始创作，或一键导入下方示例小说体验。</div>'}
    <div class="grid cols-3">
      ${works.map((w) => `
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

// ---------- 合并板块：AI创造板块 ----------
const AI_TABS = [
  ['ai-create', '✨ AI 创作'],
  ['ai', '⚙️ AI 设置'],
  ['st', '🧩 SillyTavern 设置']
];

async function renderAIBoard(content, tab) {
  if (!AI_VIEWS.includes(tab)) tab = 'ai-create';
  state.aiTab = tab;
  state.view = 'ai-board';
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🤖 AI创造板块</h1>
        <div class="page-sub">AI 创作、API 设置与 SillyTavern 角色/世界观设置已合并到这里</div>
      </div>
    </div>
    <div class="board-tabs">
      ${AI_TABS.map(([key, label]) => `<button class="board-tab ${tab === key ? 'active' : ''}" data-action="board-tab" data-board="ai" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <div id="board-content" class="board-content"></div>`;
  const target = $('#board-content');
  if (tab === 'ai-create') await renderAICreate(target);
  else if (tab === 'ai') await renderAI(target);
  else await renderST(target);
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
        <div class="muted">主线：${mainPlotlines.map((p) => esc(p.title)).join('、') || '未设置'}</div>
        <div class="muted mt-8">支线：${sidePlotlines.map((p) => esc(p.title)).join('、') || '未设置'}</div>
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
          <button class="btn small" data-action="new-plotline">＋</button>
        </div>
        ${plotlines.length ? plotlines.map((p) => `
          <div class="card plotline-card ${selected && selected.id === p.id ? 'active' : ''} mb-8" data-action="select-plotline" data-id="${p.id}">
            <div class="row">
              <span class="chip ${p.kind === 'side' ? 'warn' : ''}">${p.kind === 'main' ? '主线' : '支线'}</span>
              <b class="grow">${esc(p.title)}</b>
            </div>
            <div class="muted" style="font-size:12px">${esc(p.summary || '暂无简介')}</div>
            <div class="row mt-8">
              <button class="btn small secondary" data-action="edit-plotline" data-id="${p.id}">编辑</button>
              <button class="btn small danger" data-action="delete-plotline" data-id="${p.id}">删除</button>
            </div>
          </div>
        `).join('') : '<div class="empty">还没有剧情线</div>'}
      </div>
      <div class="plot-main">
        <div class="card mb-12">
          <div class="row">
            <h3 style="margin:0">${selected ? esc(selected.title) : '全局预览'}</h3>
            <div class="grow"></div>
            <button class="btn small secondary" data-action="new-chapter-with-plot" data-id="${selected ? selected.id : ''}">在此线新增章节</button>
          </div>
          <div class="muted mt-8">${selected ? esc(selected.summary || '暂无剧情简介') : '选择左侧剧情线查看节点'}</div>
        </div>
        ${!selected ? '<div class="empty">请选择一条剧情线</div>' : nodes.length ? `
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
          <button class="btn secondary small" data-action="format" data-format="bold"><b>B</b></button>
          <button class="btn secondary small" data-action="format" data-format="italic"><i>I</i></button>
          <button class="btn secondary small" data-action="format" data-format="underline"><u>U</u></button>
          <button class="btn secondary small" data-action="format" data-format="formatBlock" data-value="h2">H2</button>
          <button class="btn secondary small" data-action="format" data-format="formatBlock" data-value="blockquote">引用</button>
          <button class="btn secondary small" data-action="format" data-format="insertUnorderedList">列表</button>
          <button class="btn secondary small" data-action="format" data-format="insertOrderedList">编号</button>
          <button class="btn small" data-action="toolbar-ai-write">✍️ AI 写作</button>
          <button class="btn small secondary" data-action="toolbar-ai-polish">✨ 润色</button>
          <button class="btn small secondary" data-action="toolbar-ai-expand">📖 扩写</button>
          <button class="btn small" data-action="manual-save-chapter">💾 手动保存</button>
          <button class="btn small secondary" data-action="open-save-history">🕘 历史版本</button>
          <button class="btn small" data-action="link-term-modal">🔗 关联设定</button>
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
          <button data-action="ref-tab" data-tab="ai">AI</button>
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
  $$('.reference-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'terms') {
    list.innerHTML = `
      <div class="muted" style="padding:4px 2px">点击词条查看详情；写作时可选中文字后点“关联设定”</div>
      ${state.terms.slice(0, 50).map((t) => `
        <div class="reference-item" data-action="open-term" data-id="${t.id}">
          <div class="ref-title">${esc(t.title)}</div>
          <div class="ref-desc">${esc((t.content || '').slice(0, 60))}</div>
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

function scheduleSave() {
  clearTimeout(state.editorSaveTimer);
  state.editorSaveTimer = setTimeout(saveCurrentChapter, 800);
  const status = $('#editor-status');
  if (status) status.innerHTML = '<span>编辑中...</span>';
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
        <div class="mt-12"><button class="btn small secondary" data-action="new-term">＋ 新建词条</button></div>
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
      <div class="card-head"><span class="card-title">作品作者注</span><button class="btn small" data-action="save-st-work-note">保存作品作者注</button></div>
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
          <button class="btn small secondary" data-action="compress-story-memory">🧠 自动压缩记忆</button>
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
          <div class="muted">温度：${c.temperature} · 最大 token：${c.max_tokens}</div>
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
      <div class="card-head">
        <span class="card-title">AI 报错历史</span>
        <button class="btn small secondary" data-action="refresh-ai-errors">刷新</button>
      </div>
      <div id="ai-error-history" class="ai-error-history"><span class="muted">加载中...</span></div>
    </div>
    <div class="card mt-12">
      <div class="card-title">提示</div>
      <div class="muted">DeepSeek 默认 Base URL：https://api.deepseek.com；兼容 OpenAI Chat Completions 格式。若使用其他服务商，可填写对应的 OpenAI 兼容地址。</div>
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
  pipeline: '创作工作台流水线'
};

// 拉取最近 AI 报错并渲染到 AI 设置页。
async function loadAIErrors() {
  const box = $('#ai-error-history');
  if (!box) return;
  try {
    const errors = await api('/ai_errors');
    if (!errors.length) {
      box.innerHTML = '<div class="empty">暂无 AI 报错记录</div>';
      return;
    }
    box.innerHTML = errors.map((e) => `
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
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">✨ AI 创作</h1>
        <div class="page-sub">输入一段描述，AI 自动完善设定并创建一本新小说</div>
      </div>
      <div class="page-actions">
        <button class="btn secondary" data-action="go-view" data-view="ai">🤖 AI 设置</button>
      </div>
    </div>
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
    <div class="card mt-12">
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
    <div class="card mt-12">
      <div class="card-head"><span class="card-title">📜 创作任务历史</span><button class="btn small secondary" data-action="refresh-creation-tasks">刷新</button></div>
      <div id="creation-task-list" class="muted">加载中...</div>
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

// 把 OpenAI 风格 messages 转换成 Harness headless 的单段任务文本，并执行。
async function runHarnessFromMessages(messages, options = {}) {
  const prompt = (messages || []).map((m) => {
    const role = m.role === 'system' ? '【系统设定】' : '【用户请求】';
    return `${role}\n${m.content}`;
  }).join('\n\n');
  const data = await api('/harness/run', {
    method: 'POST',
    body: {
      prompt, timeout: options.timeout || 600000, model: options.model || undefined, action: options.action || 'harness',
      work_id: state.workId || state.work?.id || undefined,
      chapter_id: state.currentChapterId || undefined,
      mode: options.mode || undefined
    }
  });
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
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位小说大纲策划师。请根据以下世界观和角色，设计分卷结构和每章大纲，建议 3-5 卷、每卷 3-6 章。\n\n${prev}`
  },
  {
    key: 'chapters',
    label: '正文草稿',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位中文网络小说作家。请根据以下大纲，生成前三章的完整正文草稿，每章 800-1500 字，语言流畅有网文节奏。\n\n${prev}`
  },
  {
    key: 'review',
    label: '一致性审查',
    build: (input, prev, mode) => `${PIPELINE_MODE_HINTS[mode] || PIPELINE_MODE_HINTS.balanced}\n\n你是一位严格的小说编辑。请检查以上世界观、角色、大纲和正文之间是否存在矛盾，列出问题并给出修改后的最终版本。\n\n${prev}`
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
      const data = await api('/harness/run', {
        method: 'POST',
        body: {
          prompt: stage.build(input, previous, mode),
          timeout: 600000,
          model: PIPELINE_MODEL_BY_MODE[mode]?.[stage.key] || undefined,
          action: 'pipeline'
        }
      });
      const output = data.output || '';
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
    toast('创作失败：' + e.message, 'error');
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
  const firstLine = (outline || chapters || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const title = (firstLine || prompt || '未命名作品').slice(0, 30);
  const description = (worldview || chapters || '').slice(0, 500);
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
  openModal({
    title: work ? '编辑作品' : '新建作品',
    body: `
      <div class="form-grid">
        <div class="field full"><label>作品名称</label><input name="title" value="${esc(work?.title || '')}" placeholder="例如：我的第一本小说"></div>
        <div class="field full"><label>简介</label><textarea name="description" rows="4" placeholder="作品简介、核心卖点等">${esc(work?.description || '')}</textarea></div>
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
        <div class="field full"><label>名称</label><input name="title" value="${esc(plotline?.title || '')}" placeholder="主线：少年觉醒"></div>
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
            ${plotlines.map((p) => `<option value="${p.id}" ${String(chapter?.plotline_id ?? defaults.plotline_id ?? '') === String(p.id) ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
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
        <div class="field full"><label>对话示例 mes_example</label><textarea name="mes_example" rows="3">${esc(character?.mes_example || '')}</textarea></div>
        <div class="field full"><label>系统提示 / 全局指令</label><textarea name="system_prompt" rows="3">${esc(character?.system_prompt || '')}</textarea></div>
        <input type="hidden" name="work_id" value="${state.workId}">
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-character" data-id="${character?.id || ''}">保存</button>`
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

function openApiConfigModal(config = null) {
  openModal({
    title: config ? '编辑 API 配置' : '新建 API 配置',
    body: `
      <div class="form-grid">
        <div class="field full"><label>配置名称</label><input name="name" value="${esc(config?.name || '')}" placeholder="例如：DeepSeek 主账号"></div>
        <div class="field full"><label>Base URL</label><input name="base_url" value="${esc(config?.base_url || 'https://api.deepseek.com')}" placeholder="https://api.deepseek.com"></div>
        <div class="field"><label>API Key</label><input name="api_key" value="${esc(config?.api_key || '')}" placeholder="sk-..."></div>
        <div class="field"><label>模型</label><input name="model" value="${esc(config?.model || 'deepseek-chat')}" placeholder="deepseek-chat"></div>
        <div class="field"><label>温度</label><input name="temperature" type="number" step="0.1" min="0" max="2" value="${config?.temperature ?? 0.8}"></div>
        <div class="field"><label>最大 Token</label><input name="max_tokens" type="number" min="1" value="${config?.max_tokens ?? 4096}"></div>
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
  return `
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
  const system = '你是资深中文网络小说扩写助手。请在保留原有内容的基础上，合理扩充细节、动作、心理、环境描写，让情节更丰满。只输出扩写后的完整正文，不要输出解释。';
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

function buildAIWritingDialoguePrompt(initial, history) {
  const lines = [];
  lines.push(`你是资深中文网络小说创作助手。你熟悉网文爽点、节奏、人物塑造和世界观设定。`);
  lines.push(AI_WRITING_CLARIFY_PROMPT);
  lines.push(``);
  lines.push(`对话输出规则：
- 如果还需要了解我的需求，第一行必须严格是【提问】，随后只输出一个问题，不要输出其他内容。
- 如果已经达到 95% 信心，第一行必须严格是【成文】，随后直接输出完整的中文小说正文，不要解释。
- 每轮最多只能问一个问题。`);
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
  lines.push(`请根据以上内容决定下一步：若需澄清，先输出【提问】并只问一个问题；若已理解需求，先输出【成文】并给出正文。`);
  return lines.join('\n');
}

function buildAIWritingInitialRequest() {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  const chapterId = state.currentChapterId;
  const chapter = state.chapters.find((c) => c.id === chapterId) || {};
  const plain = stripHtml(editor?.innerHTML || chapter.content || '');
  const sel = getEditorSelection(editor);
  const selected = sel?.text?.trim() || '';
  const panelPrompt = $('#ai-prompt')?.value?.trim() || '';
  return `
当前作品：${state.work?.title || ''}
当前章节/场景：${title?.value || chapter.title || ''}
大纲摘要：${chapter.summary || '无'}
${selected ? `你希望围绕的选中内容：\n${selected}\n` : plain ? `当前正文末尾：\n${plain.slice(-1200)}\n` : ''}
${panelPrompt ? `用户补充需求：${panelPrompt}` : '请通过提问了解我真正想要的写作方向、风格、长度和内容。'}
`.trim();
}

function parseAIWritingOutput(raw) {
  const text = String(raw || '').trim();
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

// 弹窗展示最终文章，让用户选择如何应用。
function showAIWritingResult(article) {
  return new Promise((resolve) => {
    state.pendingAIFinal = resolve;
    openModal({
      title: 'AI 写作结果',
      body: `
        <div class="ai-apply-preview">${esc(article).replace(/\n/g, '<br>')}</div>
        <div class="muted mt-8">请选择如何应用到正文：</div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="ai-writing-regenerate">重新生成</button>
        <button class="btn secondary" data-action="ai-writing-replace">替换当前正文/选中</button>
        <button class="btn secondary" data-action="ai-writing-append">追加到文末</button>
        <button class="btn" data-action="ai-writing-insert">插入光标处</button>`,
      large: true
    });
  });
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

async function runToolbarAIWrite() {
  const editor = $('#editor-content');
  if (!editor) return;
  await loadAIContext();
  const btn = $('[data-action="toolbar-ai-write"]');
  if (btn) btn.disabled = true;
  try {
    const initial = buildAIWritingInitialRequest();
    const history = [];
    let maxTurns = 10;

    while (maxTurns-- > 0) {
      const data = await api('/harness/run', {
        method: 'POST',
        body: {
          prompt: buildAIWritingDialoguePrompt(initial, history),
          timeout: 600000,
          model: 'deepseek-v4-flash',
          action: 'write',
          work_id: state.workId || state.work?.id || undefined,
          chapter_id: state.currentChapterId || undefined,
          mode: 'continuation'
        }
      });
      const raw = data.output || '';
      if (!raw.trim()) throw new Error('AI 没有返回内容');
      const parsed = parseAIWritingOutput(raw);

      if (parsed.finalText) {
        const mode = await showAIWritingResult(parsed.finalText);
        if (mode === null) return;
        if (mode === 'regenerate') {
          history.push({ role: 'assistant', content: `【成文】${parsed.finalText}` });
          history.push({ role: 'user', content: '请根据上一版重新生成一版更符合我需求的完整文章。' });
          continue;
        }
        await applyAIWritingArticle(mode, parsed.finalText);
        return;
      }

      if (parsed.question) {
        const answer = await askAIWritingQuestion(parsed.question);
        if (answer === null) return;
        if (answer.type === 'skip') {
          history.push({ role: 'user', content: '请不要再提问，直接给出最终文章。' });
          continue;
        }
        history.push({ role: 'assistant', content: `【提问】${parsed.question}` });
        history.push({ role: 'user', content: answer.value || '（未填写）' });
        continue;
      }

      // 兜底：按最终结果处理
      const mode = await showAIWritingResult(raw);
      if (mode === null) return;
      if (mode === 'regenerate') {
        history.push({ role: 'assistant', content: `【成文】${raw}` });
        history.push({ role: 'user', content: '请根据上一版重新生成一版更符合我需求的完整文章。' });
        continue;
      }
      await applyAIWritingArticle(mode, raw);
      return;
    }

    toast('AI 追问次数已达上限，请重试', 'error');
  } catch (e) {
    toast('AI 写作失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
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
    toast('AI 润色失败：' + e.message, 'error');
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
    toast('AI 扩写失败：' + e.message, 'error');
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
  try {
    setAICreateProgress(steps, 1);
    await new Promise((r) => setTimeout(r, 100));
    const data = await api('/harness/generate_novel', {
      method: 'POST',
      body: { prompt, model: 'deepseek-v4-pro' }
    });
    setAICreateProgress(steps, 2);
    await new Promise((r) => setTimeout(r, 200));
    setAICreateProgress(steps, 3);
    toast(`已创建《${data.title || '未命名作品'}》`, 'success');
    state.workId = data.work_id;
    state.loadedWorkId = null;
    state.view = 'overview';
    state.currentChapterId = null;
    await render();
  } catch (e) {
    setAICreateProgress(steps, -1, e.message);
    toast(e.message, 'error');
  } finally {
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

      case 'new-work':
        openWorkModal();
        break;

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
        if (resolve) resolve('insert');
        break;
      }

      case 'ai-writing-replace': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        closeModal();
        if (resolve) resolve('replace');
        break;
      }

      case 'ai-writing-append': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        closeModal();
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
        await loadWorkData(true);
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

      default:
        break;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- global input events ----------
const debouncedSearch = debounce(async () => {
  const q = $('#global-search').value.trim();
  const box = $('#search-results');
  if (!q) { box.hidden = true; return; }
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}${state.workId ? `&work_id=${state.workId}` : ''}`);
    const group = (label, items, fn) => items.length ? `
      <div class="search-group-title">${label}</div>
      ${items.map(fn).join('')}` : '';
    box.innerHTML = group('设定词条', data.terms, (t) => `<div class="search-item" data-action="search-go" data-type="term" data-id="${t.id}"><div class="title">${esc(t.title)}</div><div class="snippet">${esc((t.content || '').slice(0, 60))}</div></div>`)
      + group('章节/正文', data.chapters, (c) => `<div class="search-item" data-action="search-go" data-type="chapter" data-id="${c.id}"><div class="title">${esc(c.title)}</div><div class="snippet">${esc((c.summary || c.content || '').slice(0, 60))}</div></div>`)
      + group('角色', data.characters, (c) => `<div class="search-item" data-action="search-go" data-type="character" data-id="${c.id}"><div class="title">${esc(c.name)}</div><div class="snippet">${esc(c.identity || '')}</div></div>`)
      + group('剧情线', data.plotlines, (p) => `<div class="search-item" data-action="search-go" data-type="plotline" data-id="${p.id}"><div class="title">${esc(p.title)}</div><div class="snippet">${esc(p.summary || '')}</div></div>`);
    box.hidden = !box.innerHTML;
  } catch (_) {
    box.hidden = true;
  }
}, 300);

document.addEventListener('change', (e) => {
  if (e.target.id === 'st-chapter-select') {
    state.currentChapterId = Number(e.target.value);
    render();
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
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-action="search-go"]');
  if (!go) return;
  e.preventDefault();
  const type = go.dataset.type;
  const id = Number(go.dataset.id);
  $('#global-search').value = '';
  $('#search-results').hidden = true;
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
  state.view = 'works';
  await render();
}

init().catch((e) => toast(e.message, 'error'));
