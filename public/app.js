// Novel Studio - vanilla SPA
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// 模型分工策略 —— **真源在服务端 `ai/policy.mjs`**，经 GET /api/ai/policy 下发，
// 由下面的 policyModel()/policyEffort()/policyEffortForTier() 在调用时解析。本文件不再写死模型字面量。
//
//   fast（DEFAULT_AI_MODEL）—— 快而省的环节：提问/澄清、质检轮、入账整理、润色/扩写/
//                              细纲/性格校对、**章节正文成文**、批量生成、创作工作台三档。
//   quality（QUALITY_AI_MODEL）—— 结果会喂给之后每一章的环节：AI 审稿、AI 修稿、
//                              **设定生成的成文轮**、AI 自动创建小说、长期记忆压缩（后者在 server.js）。
//
// ⚠️ 2026-09-18：两档**模型相同**（都是 V4.1 Flash = `deepseek-flash`），差别改由**思考强度**表达
//    （`effort_by_tier.quality = 'high'`）。所以质量档的调用点必须同时带上 reasoning_effort，
//    否则它就和快档毫无区别 —— 那不是"质量优先"，只是"少花算力"。详见 ai/policy.mjs 文件头。
//
// ⚠️ 注释更正（P4）：此前这里写的是「QUALITY 管成文轮」，与实现不符——
//    **章节正文成文实际走 fast**（见 performToolbarAIWrite / streamAIDirectWrite）。
//    走 quality 的只有「设定生成」的成文轮（runGenAskLoop 的 harness 分支）。
//
// 该分工只作用于已显式固定模型的功能；API 配置里的 model 仅对未固定模型的功能生效
// （当前为连接测试，以及仅供 API 调用的 /api/ai/generate_novel）。
//
// 下面两个常量退化为**策略快照未就绪时的兜底值**——正常路径不会用到它们。
const DEFAULT_AI_MODEL = 'deepseek-flash';
const QUALITY_AI_MODEL = 'deepseek-flash';
// 兜底：策略快照未就绪时质量档的思考强度（与 policy.mjs 的 EFFORT_BY_TIER.quality 一致）
const QUALITY_AI_EFFORT = 'high';
// 兜底：长 AI 任务超时（与 policy.mjs 的 LONG_AI_TIMEOUT_MS 一致）
const LONG_AI_TIMEOUT_FALLBACK_MS = 30 * 60 * 1000;

// 档位 → 模型名。优先用服务端下发的策略；未就绪/取不到时退回兜底常量。
function policyModel(tier) {
  const models = state.aiPolicy && state.aiPolicy.models;
  if (models && models[tier]) return models[tier];
  return tier === 'quality' ? QUALITY_AI_MODEL : DEFAULT_AI_MODEL;
}

// 档位 → 思考强度（质量档的"质量优先"就靠它）。返回空串表示不下发该字段。
function policyEffortForTier(tier) {
  const table = state.aiPolicy && state.aiPolicy.effort_by_tier;
  if (table && Object.prototype.hasOwnProperty.call(table, tier)) return table[tier];
  return tier === 'quality' ? QUALITY_AI_EFFORT : '';
}

// 长 AI 任务的统一超时（审稿/修稿/创建小说/流水线/记忆压缩）。快照未就绪时退回同一档兜底值。
function longAiTimeout() {
  const v = Number(state.aiPolicy && state.aiPolicy.long_ai_timeout_ms);
  return Number.isFinite(v) && v > 0 ? v : LONG_AI_TIMEOUT_FALLBACK_MS;
}

// 工作台档位 → 思考强度，同样以服务端策略为准。
function policyEffort(mode) {
  const table = state.aiPolicy && state.aiPolicy.pipeline_effort_by_mode;
  if (table && table[mode]) return table[mode];
  return PIPELINE_EFFORT_BY_MODE[mode] || PIPELINE_EFFORT_BY_MODE.balanced;
}

const state = {
  aiPolicy: null, // GET /api/ai/policy 的策略快照（P4）：模型档位与档位→强度表的唯一来源
  writingPolicy: null, // GET /api/ai/writing-policy 的策略快照（去 AI 味 P0）：写作规则单点真源
  works: [],
  // 作品库卡片的轻量派生信息（章节数、最近章节、字数）。不写回服务端，
  // 作品数据刷新时清空，避免把旧作品的恢复位置误显示到新卡片上。
  workMeta: new Map(),
  worksQuery: '',
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
  apiTestResults: {}, // N-07：连接测试结果驻留显示（config_id → {ok, at, msg}）
  ovStatus: null, // AI 设置页「OpenViking 记忆库」卡的状态（GET /novel/openviking）
  envTools: null, // AI 设置页「工具与环境清单」卡的检测结果（GET /env/tools）
  // 专项 A：默认两栏（编辑器更宽、参考面板收起，需要时再切三栏）
  editorLayout: localStorage.getItem('ns_editor_layout') || 'two',
  // 参考面板：当前页签 + 词条预览默认折叠为标题（专项 A）
  refTab: 'terms',
  refPreview: localStorage.getItem('ns_ref_preview') === '1',
  outlineMode: localStorage.getItem('ns_outline_mode') || 'mind',
  settingsTab: 'terms',
  aiTab: 'ai',
  aiCreateHomeTab: localStorage.getItem('ns_ai_create_tab') || 'auto',
  // T6：章末状态面板（编辑器正文下方；真实后端时态状态，不进入正文与字数统计）
  chapterPanel: null,        // GET /novel/state/panel 的最近一次结果
  chapterPanelSeq: 0,        // 切章/切页竞态防护：只有最新一次请求可以写 DOM
  chapterPanelView: 'cast',  // cast=本章出场 | visible=截至本章全部可见角色 | all=全部故事状态
  chapterPanelFull: null,    // 第三档的完整状态（full=1 时才取，取到后缓存）
  chapterProposals: null,    // 本章待确认提案组（GET /novel/state/proposal-groups）
  // T6：影响分析与逐章重建（真实 API；运行中就绪与否由服务端判定）
  impactRuns: null,
  impactRun: null,
  impactRootId: null,
  repairRuns: null,
  repairRun: null,
  repairPoll: null,
  repairPreview: null,
  // T7：时态引擎开关 / 存量重建（迁移门禁 + 启用预算告知 + 逐章状态机；后端 API 已就绪）
  temporalEngine: null,        // GET /novel/state/temporal（config / schema / 可信前缀 / 提交）
  temporalEngineEnable: null,  // 最近一次"首次启用"返回的 enable_scope（预算 + 待重建范围）
  backfill: null,              // GET /novel/state/backfill（逐章计划 + 预算 + bootstrap 候选）
  backfillStep: null,          // 最近一次 step 返回（抽取请求 / 待确认提案摘要；按章记录）
  backfillRunner: null,        // 离线测试/探针注入点：生产环境不设置（设置后不会真实调用模型）
  currentChapterId: null,
  currentTermId: null,
  currentCharacterId: null,
  currentPlotlineId: null,
  currentCategoryId: 'all',
  searchTimer: null,
  editorSaveTimer: null,
  editorSaveSnapshot: null, // F-01：自动保存的内容快照，切章/切视图时 flushSave 直接落盘
  editorSaveInFlight: new Map(), // 发送中的章节保存请求；导航时等待，避免只清定时器却丢回包
  editorConflictSnapshot: null, // 409 时保留本地稿，先让作者处理冲突，不静默覆盖
  editorSaveFailedSnapshot: null,
  // 空内容保存护栏（2026-10-02）：正文本来有内容、编辑器却被清空时，暂停自动保存并让作者确认。
  // 存的是"被拦下的空快照"；作者确认后才放行写入（见 scheduleSave / flushSave）。
  editorEmptyBlocked: null,
  // ---------- 保存层的总口径（2026-10-05 作者明确要求）----------
  // 作者原话："用户所做的一切为最高优先级，不论是否保存，未保存的弹窗提醒保存，并帮用户自动保存，
  // 不得影响用户的所有操作。" 落成三条，都写在这里、由下面几个函数共同保证：
  //   ① 保存态**永远不拦操作**：切章 / 切视图 / 开面板 / AI 工具一律照走（flushSave 恒返回 true）；
  //   ② 有未保存内容 → 可见提醒 + 一键保存，并在后台**自动重试**（下面的 retry 计时器）；
  //   ③ 只有"会把已有正文清空"这一件事仍然不自动做（数据可靠性的硬要求），它也不拦人，
  //      只提醒 + 给两条出路（取回原稿 / 明确清空本章）。
  editorSaveRetryTimer: null,   // 自动重试计时器
  editorSaveRetryStep: 0,       // 退避档位（见 EDITOR_SAVE_RETRY_DELAYS）
  editorUnsavedNoticeAt: 0,     // 上次弹"有未保存内容"的时间（只做记录/诊断）
  editorUnsavedNoticeKey: '',   // 已经提醒过的那一次"未保存"（同一次只提醒一遍，绝不刷屏）
  // 每章一份"作者手里还没落盘"的稿子。为什么不能只用一个槽：切章随时可能发生（这正是"不得影响操作"
  // 的前提），而单槽会被新章的快照覆盖 —— 被覆盖的那一份就再也没人替它落盘了。
  editorPendingByChapter: new Map(),
  // 本页为每一章见过的**最大正文字数**（只增不减）。空内容护栏的判据用它，而不是用
  // state.chapters[].content —— 后者会被任何一次刷新或他处写入改成空/变短，
  // 于是"正文曾经有 3982 字、现在编辑器是空的"这个事实就再也判不出来了（2026-10-02 事故的根因之一）。
  chapterBodyPeak: new Map(),
  // 采纳冲突（2026-10-02）：服务端正文在本次采纳期间真的变了，等作者选择如何处理。
  pendingAdoptConflict: null,
  // 「旧内容是否保存？」（F3 · 2026-10-06）：正文即将被新内容覆盖，而这一章还有一版没落盘时，
  // 等作者在是/否之间选一个（两个答案都会继续写入新内容，它不是操作闸门）。
  pendingOldContent: null,
  editorComposing: false,
  imeComposing: false,
  aiTaskRunning: false, // F-43：harness 任务互斥锁（单个 harness 任务用；成文管线有自己的一把，见下）
  // 「AI 写本章」整条管线的互斥（2026-10-02）：**必须与 aiTaskRunning 分开**。
  // 理由：管线内部会调用 runHarnessJob / streamAIDirectWrite，它们各自会在结束时把
  // aiTaskRunning 置回 false —— 用同一个标志位做入口锁，蓝图轮一结束锁就没了；
  // 反过来用深度计数去护住它，又会把"某个内层任务留下的残留标志"误当成"管线仍在跑"。
  // 独立标志位只由 performToolbarAIWrite 自己置位/释放，语义单一。
  aiWritePipelineRunning: false,
  demoStatusLoaded: false, // F-30：示例状态缓存，避免每次渲染都请求 /demo/status
  demoStatus: null,
  savedRange: null,
  // 弹窗「未保存内容」判据（点遮罩关闭前的闸）：
  //   modalBaseline  = openModal 那一刻的表单快照（只含 [name] 字段）
  //   modalProtected = 这个弹窗点外部**一律不关**（AI 交互弹窗：点外部等于取消，
  //                    而取消只能靠 ✕ / 取消按钮——误触一次就丢掉提问/结果，代价不对称）
  modalBaseline: null,
  modalProtected: false,
  modalReturnFocus: null,
  pendingAIApply: null,
  pendingAIInstruction: null,
  pendingAIQuestion: null,
  pendingAIFinal: null,
  // R03：结果弹窗里勾选的提案必须在**关弹窗前**固化（旧实现关窗后才读 DOM → 永远读到空集合）
  pendingProposalSelection: null,
  pendingGenResult: null,
  genSelected: [],
  genSubmit: null,
  pipelinePaused: false,
  pipelineStopped: false,
  pipelineResume: null,
  aiContext: null,
  editRules: null, // R07：编辑规则目录与作者选择（GET /novel/editing）
  authorStyle: null, // R09：作者样文 / 文风档案 / 三级意图（GET /novel/style/* + /novel/author_intent）
  storyState: null, // R10：故事状态开关/总览 + 按当前章的披露派生视图
  branch: null, // R11：剧情分支沙盘（沙盘列表 + 本章候选；stale 由服务端现算）
  rebuild: null, // R12：导入后重建（run + 批次状态；由服务端现算 stale）
  rebuildLoaded: false,
  rebuildRunner: null, // 离线测试/探针注入点：生产环境不设置（设置后不会真实调用模型）
  // P4：共享资料库（跨作品写作参考资料）——列表 / 检索 / 导入计划 / 读原文 / 开关
  library: null,
  libraryLoaded: false,
  libraryKey: null, // 资料状态缓存对应的 work_id（开关按作品：换作品 / 退回作品列表即失效）
  libraryDir: '',
  libraryCategory: '',
  librarySearch: null, // { q, mode, hits, total }；q 为空表示列表模式
  libraryDoc: null, // { doc, text, offset, limit }
  libraryPlan: null, // dry-run 计划；改目录或确认导入后作废
  libraryImportResult: null,
  termsCache: new Map(),
  charsCache: new Map(),
  // 生成稿草稿 / 上次审稿 / 未收尾长任务：按章节缓存，供编辑器顶部「取回」条使用。
  chapterDraft: null,
  chapterReview: null,
  chapterJobs: [],
  // 已保存的章节蓝图（每章最多 2 份，最新在前）：与上面三项同一处展示（2026-10-06 作者要求）。
  chapterBlueprints: [],
  chapterBlueprintLimit: 2,
  recoveryForChapter: null,
  commandPalette: { open: false, query: '', items: [], active: 0, seq: 0, visibleItems: [], returnFocus: null, status: 'idle', error: '' },
  lastRenderedRoute: null,
  sidebarCollapsed: (() => { try { const saved = localStorage.getItem('ns_sidebar_collapsed'); return saved === '1' || (saved === null && typeof window !== 'undefined' && window.innerWidth <= 720); } catch (_) { return typeof window !== 'undefined' && window.innerWidth <= 720; } })()
};

// 合并后的侧栏板块：小说设定 / AI创造板块（进入作品后）
// 初始页（未进入作品）另有顶层视图：works（我的作品）、ai-create（✨ AI 创作）、ai（AI 设置）
const SETTINGS_VIEWS = ['plot', 'outline', 'terms', 'characters', 'memory'];
// T6：AI 板块拆分为独立页面后，这些 route key 都能直接定位（st 为创作上下文的兼容别名）。
const AI_VIEWS = ['ai-create', 'ai', 'st', 'rules', 'style', 'story-state', 'branch', 'rebuild'];
const HOME_AI_VIEWS = ['ai-create', 'ai'];

// 统一跳转：把旧子页面视图映射到对应的板块；未进入作品时按初始页视图分流。
function goView(view) {
  if (SETTINGS_VIEWS.includes(view)) {
    state.settingsTab = view;
    state.view = 'settings';
  } else if (AI_VIEWS.includes(view)) {
    if (!state.workId) {
      // 初始页：仅 AI 创作 / AI 设置 两个顶层视图可用（创作上下文页依赖作品数据，必须在作品内使用）
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
// 前端 → 服务端统一日志上报（/api/logs，fire-and-forget，绝不影响业务逻辑）。
function reportClientLog(entry) {
  try {
    const body = JSON.stringify({ layer: 'frontend', level: 'error', ...entry });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/logs', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch (_) { /* 上报失败静默 */ }
}

// 非 JSON 错误响应（如 HTML 报错页）→ 剥标签取可读文本并截断 200 字，统一错误格式（F-15）。
function extractReadableError(text, status) {
  if (!text) return `请求失败 (${status})`;
  const plain = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return `请求失败 (${status})`;
  return plain.length > 200 ? plain.slice(0, 200) + '…' : plain;
}

async function api(path, options = {}) {
  const started = performance.now();
  // F-45：统一超时（默认 60s）。同步长任务（AI 创作/直连生成/压缩记忆/导入等）由调用方传更大的 timeout 覆盖。
  const { timeout = 60000, ...rest } = options;
  const opts = { ...rest, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  // 🐞 运行追踪：把这次请求归属到当前用户操作（后端据此把前后端节点合成同一条记录）。
  const traceH = typeof traceHeaders === 'function' ? traceHeaders() : null;
  if (traceH) Object.assign(opts.headers, traceH);
  let traceStatus = 0;
  let traceResult = null;
  let traceErr = null;
  try {
    const res = await fetch('/api' + path, { ...opts, signal: AbortSignal.timeout(timeout) });
    traceStatus = res.status;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    traceResult = data;
    if (!res.ok) {
      const err = new Error((data && data.error) || extractReadableError(text, res.status));
      err.status = res.status;
      // 服务端给的机器可判标记（如 EMPTY_OVERWRITE_BLOCKED）随错误对象一起带出去：
      // 调用方要据此给出"怎么补救"的具体动作，而不是把那句中文再拿去做正则匹配。
      // 纯附加字段，普通错误对象上没有这些键，行为不变。
      if (data && typeof data === 'object') {
        for (const k of ['code', 'current_chars']) {
          if (data[k] !== undefined) err[k] = data[k];
        }
      }
      throw err;
    }
    return data ?? {};
  } catch (e) {
    traceErr = e;
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const err = new Error(`请求超时（${path}，超过 ${Math.round(timeout / 1000)}s）`);
      err.status = 0;
      traceErr = err;
      throw err;
    }
    throw e;
  } finally {
    // 慢 API 监测：界面侧感知的「不流畅」上报日志库。
    // N-07：AI 请求（直连 /ai/ 与慢通道 /harness）天然秒级起步，用更高的阈值，避免日志被「慢请求」刷屏。
    const slowMs = (path.startsWith('/ai/') || path.startsWith('/harness')) ? 10000 : 800;
    const ms = performance.now() - started;
    if (ms > slowMs && !path.startsWith('/logs')) {
      reportClientLog({
        level: 'slow', kind: 'slow_api',
        message: `API ${path} 耗时 ${Math.round(ms)}ms（阈值 ${slowMs}ms）`,
        context: { path, duration_ms: Math.round(ms) }
      });
    }
    // 🐞 运行追踪：记录这次前后端往返（形状摘要，不含正文）。
    if (typeof traceApiRecord === 'function' && traceH && !path.startsWith('/debug')) {
      traceApiRecord(path, opts.method || 'GET', ms, traceStatus, traceErr ? undefined : traceResult, traceErr);
    }
  }
}

// ---------- 前端全局异常与卡顿监测 ----------
// 主线程滞后采样：页面卡顿（阻塞）检测，30 秒内同一次卡顿只报一条。
//
// 2026-09-14 出现过一条 46636ms 的 ui_block，事后无法判断它到底是
// 「浏览器把定时器节流了」还是「主线程真的被占住 46 秒」——因为原实现只记了 lag_ms，
// 而这两种成因产生**完全相同的数字**。更早的 N-06 也踩过同一个坑（59s 误报）。
// 现在把测量降级为「只报无歧义的卡顿」，并把判据一起写进日志：
//   · 两次采样之间只要页面曾经进入 hidden，就不报（节流/切走，不是卡顿）；
//   · 上报时带上采样间隔、前一次采样距今、页面状态、活跃视图、DOM 节点数、可用堆，
//     让下一条记录本身就能自证成因，不必再靠猜。
(function startClientLagMonitor() {
  let lastTick = performance.now();
  let lastReportAt = 0;
  let hiddenSinceLastTick = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || document.visibilityState === 'hidden') hiddenSinceLastTick = true;
  });
  setInterval(() => {
    if (document.hidden || document.visibilityState === 'hidden') {
      lastTick = performance.now();
      hiddenSinceLastTick = true; // 记下「这段间隔里页面确实被切走过」
      return;
    }
    const nowMs = performance.now();
    const sinceLastTick = nowMs - lastTick;
    const lag = sinceLastTick - 1000;
    const wasHidden = hiddenSinceLastTick;
    hiddenSinceLastTick = false;
    lastTick = nowMs;
    // 页面在两次采样之间曾隐藏：这 1000ms 的间隔不可信（浏览器会节流后台/遮挡页面的定时器），
    // 上报它只会制造无法归因的假象 —— 直接跳过。
    if (wasHidden) return;
    if (lag >= 400 && nowMs - lastReportAt >= 30000) {
      lastReportAt = nowMs;
      reportClientLog({
        level: lag >= 1500 ? 'error' : 'warn', kind: 'ui_block',
        message: `页面主线程阻塞 ${Math.round(lag)}ms（界面卡顿）`,
        context: {
          lag_ms: Math.round(lag),
          since_last_tick_ms: Math.round(sinceLastTick),
          // 以下为诊断字段：用来把「真卡顿」与「定时器被节流」彻底分开
          visible_throughout: true,
          view: (typeof state !== 'undefined' && state && state.view) ? String(state.view) : '',
          dom_nodes: (typeof document.getElementsByTagName === 'function') ? document.getElementsByTagName('*').length : null,
          heap_mb: (performance.memory && Number.isFinite(performance.memory.usedJSHeapSize))
            ? Math.round(performance.memory.usedJSHeapSize / 1048576)
            : null
        }
      });
    }
  }, 1000);
})();

// 运行时错误（含资源脚本错误）
window.addEventListener('error', (e) => {
  if (e.target && e.target !== window && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK' || e.target.tagName === 'IMG')) {
    return; // 资源加载失败交给网络面板，避免日志噪音
  }
  reportClientLog({
    level: 'error', kind: 'frontend_error',
    message: e.message || '页面运行时错误',
    code_file: e.filename || '', code_line: e.lineno || undefined, code_func: '',
    stack: e.error?.stack || '',
    context: { location: String(location.href).slice(0, 300) }
  });
}, true);

// 未处理的 Promise 拒绝
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  reportClientLog({
    level: 'error', kind: 'frontend_error',
    message: `未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`,
    stack: reason instanceof Error ? (reason.stack || '') : '',
    context: { location: String(location.href).slice(0, 300) }
  });
});

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- XSS 白名单清洗器（F-03） ----------
// 编辑器正文本身就是 HTML：消毒只剥危险标签/属性，正常段落/粗斜体/列表/词条链接必须保留。
// 用浏览器原生 DOMParser 解析后再重建，天然免疫 <script>、on* 事件、javascript: 等注入。
const EDITOR_ALLOWED_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'H2', 'H3', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'DIV', 'SPAN']);
const EDITOR_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'IMG', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'TEMPLATE']);

function sanitizeEditorHtml(html = '') {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const sanitizeNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
    if (node.nodeType !== Node.ELEMENT_NODE) return null; // 注释等直接丢弃
    const tag = node.tagName.toUpperCase();
    if (EDITOR_DROP_TAGS.has(tag)) return null; // 危险标签整体丢弃
    let el;
    if (EDITOR_ALLOWED_TAGS.has(tag)) {
      el = document.createElement(tag);
      if (tag === 'A') {
        // 只保留词条链接（data-term-id）：重建为安全、规范化的词条链接，去掉任意 href/事件。
        const termId = node.getAttribute('data-term-id');
        if (termId) {
          el.setAttribute('data-term-id', termId);
          el.setAttribute('class', 'term-link');
          el.setAttribute('contenteditable', 'false');
        }
      }
    } else {
      // 白名单外标签：解包（保留子节点与文本），不保留标签本身
      el = document.createDocumentFragment();
    }
    for (const child of Array.from(node.childNodes)) {
      const c = sanitizeNode(child);
      if (c) el.appendChild(c);
    }
    return el;
  };
  const out = document.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) {
    const c = sanitizeNode(child);
    if (c) out.appendChild(c);
  }
  const wrap = document.createElement('div');
  wrap.appendChild(out);
  return wrap.innerHTML;
}

// F-11：语义召回相关度——兼容两种量纲并防御 NaN。
// N-05：服务端已把 OpenViking 的 0-1 分数换算成 0-100 后下发，这里再 ×100 会出现「8800%」；
// 统一按「≤1 视为小数×100，否则原样」处理，两种来源都正确。
function recallPercent(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n <= 1 ? n * 100 : n);
}

// D5：剧情线标题展示时剥离与 kind 重复的“主线：/支线：”前缀（兼容旧数据里已带前缀的标题）
function plotlineDisplayTitle(p) {
  return String(p?.title || '').replace(/^(?:主线|支线)\s*[:：]\s*/, '').trim() || '未命名';
}

// F-44：记录最近 toast 用于短时间去重（同文案 3 秒内只弹一次）。
let toastRecent = [];

function toast(message, type = '') {
  // D6/D14：压缩空白、限制长度，避免多行堆栈/超长文案直接糊到用户脸上；
  // 时长随内容长度缩放（最少 3 秒、最多 9 秒），完整内容放 title 悬停查看。
  const full = String(message ?? '').replace(/\s+/g, ' ').trim();
  const now = Date.now();
  toastRecent = toastRecent.filter((x) => now - x.time < 3000);
  if (toastRecent.some((x) => x.full === full)) return; // F-44：相同 message 短时间去重
  toastRecent.push({ full, time: now });
  const short = full.length > 240 ? full.slice(0, 240) + '…' : full;
  // 🐞 运行追踪：记录本次操作引发的界面提示（第 9 题：代码响应的一部分）。
  if (typeof trace !== 'undefined' && trace.on) trace.toasts.push({ text: short.slice(0, 120), type: type || '' });
  const root = $('#toast-root');
  while (root.children.length >= 3) root.firstChild.remove(); // F-44：同显上限 3 条，超出移除最旧
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = short;
  if (short !== full) el.title = full;
  root.appendChild(el);
  const ms = Math.min(9000, 3000 + full.length * 40);
  setTimeout(() => el.remove(), ms);
}

// ---------- 界面内帮助文案（唯一来源） ----------
// 为什么集中成一张表：同一段解释往往要在"标题旁的小字""悬停气泡""设置卡说明"三处出现，
// 抄三份必然分叉（P0–P6 复盘里 F8：常量被抄三份，改一处漏两处，且不会报错）。
// 用法：
//   helpDot('creation_context') → 标题旁的小问号，鼠标悬停/键盘聚焦显示解释
//   fieldHelp('chapter_note') → 字段下方的一行小字（不悬停也能看到）
//   HELP_TEXT[key].body → 需要更完整解释的地方直接取用
const HELP_TEXT = {
  // R06：用户面命名统一为「创作上下文」。键名 `sillytavern` 是历史名，保留为兼容别名
  // （旧会话、旧帮助锚点、旧文档里的 helpDot('sillytavern') 不失效），语义见 `creation_context`。
  sillytavern: {
    title: '创作上下文',
    body: '这里管理喂给 AI 的角色卡、世界观词条与作者注（角色人设、说话口吻示例、系统提示、世界观条目）。'
      + '这套"把角色与世界观素材组织成可复用上下文"的做法，设计上借鉴了开源项目 SillyTavern——那是历史叫法，本页与 SillyTavern 本体无关，也不需要安装它（来源与许可见首页「借鉴与致谢」）。'
      + '设置只影响 AI 写作时喂给模型的素材，不影响你的正文和作品数据。'
  },
  chapter_note: {
    title: '章节作者注',
    body: '只对本章生效的写作指示（例如"这一章节奏要快，别写景"）。它会随本章的上下文一起交给 AI，不写也不影响使用；跨章通用的要求请写在"作品作者注"里。'
  },
  work_note: {
    title: '作品作者注',
    body: '整本书通用的写作指示（例如"全程第一人称、不用网络流行语"）。每一章的 AI 写作都会带上它。'
  },
  author_style: {
    title: '作者样文与文风档案',
    body: '样文是你自己的（或你有权使用的）文字片段，用来让 AI 贴着你的笔法走：句长与变化、对白与旁白、标点、段落、修辞、情绪表现、开场与段尾习惯都会做确定性计数，并写明计算口径（不是模型猜的）。'
      + '样文与「三级作者意图」都是独立数据来源：不会变成本书的人物、地点、事件或正典事实，也不会改变 AI 能做什么；它们只在写作为你所用时按预算进入请求。'
      + '改过样文后档案会标"已过期"，重新分析即可；本章意图可以覆盖较泛偏好，但与你设为长期硬约束的要求冲突时会在这里提示你裁决，不会自动取舍。'
  },
  disclosure: {
    title: '故事状态与读者披露',
    body: '按"当前章"把作品里的信息分三档看：作者真相（只有你知道，读者还没读到）、读者已披露（已经写在正文里、且生效时点已到）、各角色掌握（谁在什么时候知道了什么）。'
      + '判断依据是确定性的：事实挂在哪一章、那一章有没有写、effective_from/effective_to 的窗口是否包含当前章、角色知识的"学到于第几章"。'
      + '作者知道不等于角色知道：写某个角色的行动理由时只能用他"已知"的条目；没有任何记录的条目是"未定义"，既不算知道也不算不知道。'
      + '视图每次按当前数据重算（不缓存）：章节重排、回滚、改设定或删事实后，再看就是新的结论。',
  },
  impact_analysis: {
    title: '影响分析（前文修改后的增量失效）',
    body: '把某一章当作「根变更」，沿依赖图检查它之后**全部**下游章节：显式出场与显式依赖只是解释与排序，'
      + '不会用来排除隐性因果——即使后文没有出现角色名字，只要它的行动前提依赖旧状态（等待某人回来、某资源仍在、某承诺未失效），也会进入复核。'
      + '复核结果分四类：保留原文（正文仍成立，只需重建依赖与状态）、需要复核（无法判断，留给作者）、冲突（显式或因果前提失效）、阻塞（前缀被截断，跨不过冲突）。'
      + '本页只分析、只标记：不会因为检测到冲突就改写后文；逐章重建必须由你另行点击并确认范围。'
      + '根章节最新正文尚未确认时，报告只做试探性覆盖提示（不调用模型、不建候选）。',
  },
  repair_run: {
    title: '逐章重建（按钮授权）',
    body: '点「重建受影响章节」后会签发一次性审批并启动运行：按叙事顺序**逐章串行**处理——第 N 章先复核，'
      + '正文仍成立就保留原文、重建依赖与状态；不成立才生成最小修订候选。候选只进工作线，**正式正文在应用前逐字节不变**。'
      + '第 N 章的结果会成为第 N+1 章的输入，上一章的新剧情会改变后续章节的正确修复方式，所以不能一次把全部章节批量交给模型。'
      + '重建第 N 章时只能看到截至第 N 章的状态（不会读取未来章节才成立的死亡、关系、伏笔结果）。'
      + '运行可暂停、可恢复（预算不重置）、可取消；就绪后仍需你签发一次应用审批，才会把候选原子切换到正式稿（旧稿保留、可撤销）。'
      + '若运行期间你改了后文或章序，旧运行会转为过期/暂停，不会覆盖你的新编辑。',
  },
  temporal_engine: {
    title: '时态状态引擎（迁移与开关）',
    body: '长篇小说要能回答"截至第 5 章，王师傅还活着吗"，就不能只保存角色卡上那一个"最新状态"。这个引擎用不可变修订、必须带前置条件的事件、提交清单和章序版本，保存每一章"当时"的故事状态。'
      + '三个开关分离且默认关闭：① 时态故事状态引擎（权威状态来源）；② 保存后自动分析（开启后保存正文会生成待确认提案，会用到模型）；③ 逐章重建（允许「重建受影响章节」按钮签发运行）。'
      + '旧作品默认全部关闭：不开启时不会触发任何额外模型调用，上下文装配与旧端点契约逐字节不变；开启时会先告诉你待重建范围与预计模型调用次数（每次抽取一章一次调用）。'
      + '数据库缺少必要表或索引时不允许开启（服务端直接拒绝，不会吞错误继续跑）；启用同时登记迁移版本，便于核对与回退说明。'
      + '回退：应用回滚（撤销重建的恢复提交）与数据库版本回退是两件事——都不删除新历史；不要用"把新表删掉"当回滚。',
  },
  backfill: {
    title: '存量重建（逐章按叙事顺序）',
    body: '给已经在写、或导入进来的作品补建时态状态。按真实叙事顺序逐章走：冻结不可变修订（不改写正文）→ 生成抽取请求 → 作者记录/确认 → 章边界快照与事后依赖 → 可信前缀前进一章。'
      + '生成抽取请求本身不调用模型：可以复制给 dsh 会话，也可以点「记录本机结果」用当前模型配置跑一次（会产生费用，零计费验收用本机假模型）。'
      + '旧稿生成时的上下文已经不存在：出处如实记为"事后重建 / 生成上下文未知"，不伪造当时的创作记录；第一章之前的设定只能由你显式确认为"开篇设定"。'
      + '旧字段（角色卡最新 status、人物关系、已确立事实）只会变成**待确认候选**：默认建议作为开篇设定或转为某章提案，绝不在你确认前自动回填成第 0 章状态——"第 10 章死亡"不会被当作开篇已死亡。'
      + '确认必须按顺序：跳章确认会被服务端拒绝（上游不可信），补齐前面章节后即可继续；重复确认是幂等的，不会重复推进事件。',
  },
  import_rebuild: {
    title: '导入后重建创作状态',
    body: '把已导入的作品**分批**重新读一遍，抽出人物/别名/关系/地点设定/时间线/事件/伏笔/角色状态/披露知识，形成候选提案。'
      + '每个批次都记录基线指纹（章节正文 hash、抽取器与 schema 版本、模型路由与思考档位、结果 hash）：正文或配置一变，对应批次立刻标「已过期」，旧结果只能读、不能复用——恢复时也不会重跑已完成且基线一致的批次。'
      + '整本书绝不塞进一次请求：批次有章数与字符上限，逐批抽取、逐批记录。'
      + '抽取项必须带原文证据：quote 要能在该章正文里原样找到，定位不到就整批拒绝（防止编造），修正后有限重试。'
      + '候选默认**不写**任何正式状态；作者点「确认应用」才在一个短事务里整批原子生效（失败整体回滚），未确认前不进正文、不进事实/事件/角色知识。'
      + '模型侧不能确认（带 X-Novel-Agent 的请求返回 403）。',
  },
  branch_sandbox: {
    title: '剧情分支沙盘',
    body: '写不下去时，先要"几条不同的路"，而不是让模型替你决定走哪条。沙盘固定以具体章节为时点，给出 2—5 个候选方向：核心行动、冲突选择、人物选择、剧情节拍、可能后果、关系/伏笔影响、风险、必要铺垫、与作者意图的关系。'
      + '候选之间必须有实质差异：只改措辞、换同义表达不算多个候选（宿主会按核心行动判重并整批拒绝）。'
      + '角色边界按"当前章该角色能知道什么"判定：人物选择的理由要用该角色可行动的事实 id 或已知键，新角色要显式声明；作者真相与读者披露都不等于角色知道——不能因为模型看见了秘密就让角色提前知道。'
      + '后果分 certainty：established 才是已发生，planned/possible/uncertain 是计划与推测，未来计划不得冒充已发生。'
      + '候选只是提案：未采纳前不进正文、不进正典事实/事件/角色知识/上下文层，也不触发记忆同步；进入会话历史不等于获准成为本书事实。'
      + '沙盘会记住形成候选时的依赖基线（状态/正文/契约/作者意图/披露指纹）：任一变化即标"已过期"，旧候选仍可阅读，但重新采纳必须先复核或重新生成。'
      + '采纳（作者动作）只写章节蓝图与契约建议——正文、正典事实、角色状态一律不动；也可以丢弃候选、取消沙盘或重启恢复到未完成槽位。',
  },
  library: {
    title: '共享资料库（跨作品参考资料）',
    body: '跨作品共用的写作参考资料（方法 / 素材 / 范例）：不止一本书能用，写任何作品时都可被检索到。'
      + '导入分两步：先「扫描预览」列出要新增 / 更新 / 跳过什么（这一步绝不写入），你确认后才写进共享资料根，由记忆库本地向量化（写入后约 30 秒内可被召回）。'
      + '只读你显式指定的目录：白名单 .md / .txt、单文件上限、单批上限、不跟随符号链接、严格 UTF-8（不猜编码）。'
      + '资料不是本书事实：它只以「参考资料（非本书事实）」层进入写作上下文（top-4、单条 300 字、独立预算），永不进入事实 / 事件 / 角色知识，也不会自动改写正文。'
      + '资料层按作品开关（默认关闭）；删除默认只「标记缺失」，你确认后才同时删记忆库文件与登记行。开关 / 导入 / 删除都是作者动作，模型侧一律 403。'
  },
  plotline: {
    title: '剧情线',
    body: '按"故事里的一条线"来组织章节：主线一条、支线若干。看的是"这条线走到哪了"。适合追踪多线并行、谁和谁的故事在推进。'
  },
  outline: {
    title: '大纲',
    body: '把卷、章、剧情线摆成一棵树（思维导图），看的是"整本书的结构长什么样"。'
  },
  plotline_vs_outline: {
    title: '剧情线和大纲是什么关系？',
    body: '两者是同一批章节的两种看法，不是两套数据：剧情线 = 按"线索"横着看（这条线走到哪了），大纲 = 按"卷/章"竖着看（整本书的结构）。同一章可以既属于某条剧情线、又挂在某个卷下。改一边不会丢另一边。'
  },
  long_memory: {
    title: '长期记忆（故事摘要）',
    body: '写给 AI 看的"前情提要"：已经发生过什么、人物状态变成什么样。写新章节时 AI 会参考它。它可以由你手写，也可以让 AI 起草或自动压缩旧章节。'
  },
  event_ledger: {
    title: '事件账本 / 伏笔',
    body: '按时间记的事件流水：谁在哪一章做了什么。伏笔是其中的特殊事件，可以标"已埋下 / 已回收"，用来防止写着写着忘了收。它和长期记忆的分工：账本是明细，长期记忆是提炼后的摘要。'
  },
  blueprint: {
    title: '章节蓝图',
    body: 'AI 动笔前先跟你确认的一份"本章要写什么"的计划（场景、出场人物、要达到的效果）。确认后 AI 才按它成文，避免一次性跑偏整章。'
  },
  redline: {
    title: '红线（反 AI 腔规则）',
    body: '你设定的禁用表达/句式清单。AI 成文后会自动扫一遍并报告命中，是确定性的检查，不依赖模型自觉。'
  },
  context_preview: {
    title: '上下文',
    body: 'AI 这次动笔前"实际看到的全部资料"。本工具会按用途分层装配（设定 / 角色 / 伏笔 / 语义召回…），并给出预算与裁剪清单——命中与相关度都能在这里核对。'
  },
  direct_channel: {
    title: '直连通道',
    body: '直接调用你在 AI 设置里配置的模型 API，秒级响应。润色、扩写、细纲、性格校对这类单轮短任务走它。'
  },
  slow_channel: {
    title: '慢通道（走创作内核）',
    body: '通过 DeepSeek Harness（dsh）跑的多阶段创作任务：会读角色卡、世界观、红线，先出蓝图再成文。较慢，但更完整。需要在「本地创作内核」卡里配好 dsh。'
  },
  openviking: {
    title: 'OpenViking 记忆库',
    body: '一个可选的本地记忆服务：把作品数据向量化，让 AI 能"语义召回"很久以前写过的设定与情节。不装、不开都不影响手动写作，AI 写作也只是少一层召回。'
  },
  openviking_key: {
    title: '这里的 Key 是什么？',
    body: '是 OpenViking 服务自己的访问令牌（它默认监听本机 127.0.0.1:1933，多数本地安装并不校验），不是模型服务商的 Key。填在工坊里只对工坊生效；要让 dsh 侧的写作任务也用同一份，点右边的"写入全局配置"。'
  },
  dsh: {
    title: 'DeepSeek Harness（dsh）',
    body: '驱动"AI 创作内核"的程序，是 AI 写作 / 创作工作台 / 自动创建小说的运行环境。它是可选的：不装也能手动写作，只是这些功能用不了。'
  },
  dsh_repo: {
    title: '为什么要填 dsh 仓库路径？',
    body: '工坊要调用 dsh 来完成深度创作，就得知道它装在哪。按顺序自动找：环境变量 NOVELSTUDIO_DSH_REPO → 这里填的路径 → 环境变量 DSH_HOME → 工坊仓库隔壁的 deepseek-harness。找不到时填一次即可，下次启动仍然有效。'
  },
  tool_list: {
    title: '这张清单是什么？',
    body: '本工坊的完整能力由几个互相独立的本机工具拼成。这张表逐项告诉你：它是干什么的、你现在装没装（真的去磁盘看了）、不装会少什么功能、去哪儿装。只有 Node.js 是必需的。'
  },
  model_policy: {
    title: '为什么改这里的模型名有时不生效？',
    body: '成文、审稿、设定生成等关键环节用的是程序内置策略（快而省的环节用 flash，质量优先的环节用 v4-pro），不受这里的模型下拉影响；下拉只对连接测试等少数功能生效。要调整分工需改 ai/policy.mjs。'
  }
};

// 标题旁的小问号：悬停或键盘聚焦（Tab 到）都能看到解释。
// R06 兼容别名：内部键 `sillytavern` 是历史名，语义上它就是「创作上下文」。
HELP_TEXT.creation_context = HELP_TEXT.sillytavern;

function helpDot(key) {
  const item = HELP_TEXT[key];
  if (!item) return '';
  return `<span class="help-dot" data-help="${esc(key)}" data-help-title="${esc(item.title)}" tabindex="0" role="note" aria-label="说明：${esc(item.title)}">?</span>`;
}

// 字段下方的小字（不悬停也看得见的一句话说明）。
function fieldHelp(key, text) {
  const item = HELP_TEXT[key];
  const body = text || (item ? item.body : '');
  if (!body) return '';
  return `<div class="field-help"${item ? ` data-help="${esc(key)}"` : ''}>${esc(body)}</div>`;
}

// 给任意元素套原生 title（悬停提示），文案同样取自 HELP_TEXT —— 不另抄一份。
function helpTitle(key) {
  const item = HELP_TEXT[key];
  return item ? ` title="${esc(item.title + '：' + item.body)}"` : '';
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

/**
 * 打开弹窗。
 *
 * `protectedBackdrop` 现在**默认为 true**（2026-10-04，作者第二轮报障后定稿）：
 * 点遮罩不关闭，只提示"请用右上角 ✕ 或按钮关闭"。
 *
 * 为什么从"逐个加保护"改成"默认全保护"：这个开关先只挂在采纳冲突框上，作者随后连续撞到
 * 三处同类缺口 —— 提问窗口、蓝图确认框、AI 写作需求框（"我鼠标不小心点到窗口外面就关了"）。
 * 逐个补是在追着报障跑；而**误触关闭的代价是不对称的**（丢掉输入 / 取消一次正在跑的付费任务），
 * 所以默认应该是安全的那个方向。
 *
 * 仍要"点外面就关"的弹窗（纯信息/预览类）显式传 `protectedBackdrop: false` ——
 * 关闭判定见全局 click 处理器里的 data-modal-backdrop 分支。
 */
function openModal({ title, body, footer = '', large = false, protectedBackdrop = true } = {}) {
  const root = $('#modal-root');
  state.modalReturnFocus = document.activeElement;
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
  // 点遮罩关闭前的闸：记下此刻的表单快照，供"脏了就不关"判定（见 modalDirty）。
  // 只读弹窗没有 [name] 字段 → 快照为空 → 永远判为"不脏" → 行为与从前完全一致。
  state.modalBaseline = JSON.stringify(collectModalData(root));
  state.modalProtected = protectedBackdrop === true;
  enhanceModalGenFill();
  const first = root.querySelector('[data-close-modal], input, textarea, select, button');
  if (first && typeof first.focus === 'function') setTimeout(() => first.focus(), 0);
}

/**
 * 弹窗里有没有**未保存的输入**。
 * 判据用"与打开时的快照逐字段比较"，而不是监听 input —— 后者要覆盖动态生成的字段、
 * 程序性赋值（reopenEntityModal / setModalField 会直接改 .value）与撤销修改后回到原值，
 * 比较快照天然都覆盖，且不会因为"改了又改回来"误判为脏。
 */
function modalDirty() {
  const root = $('#modal-root');
  if (!root || !root.innerHTML) return false;
  try { return JSON.stringify(collectModalData(root)) !== state.modalBaseline; } catch (_) { return false; }
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
  // N6：这两个此前漏在 closeModal 之外——取消后残留闭包（pendingAIApply 还攥着已脱离文档的 editor）。
  // 所有 pending* 都必须在同一个边界收口，否则"某条路径忘了清"就变成长期泄漏。
  state.pendingAIApply = null;
  state.pendingReviewDiff = null;
  // 采纳冲突确认框被 ✕ / 点遮罩关掉时，等在那里的 Promise 必须有个结局，
  // 否则这条采纳流程会永远挂着（作者看不到任何后续提示）。按"先不写"处理。
  if (state.pendingAdoptConflict) {
    const pendingConflict = state.pendingAdoptConflict;
    state.pendingAdoptConflict = null;
    try { if (pendingConflict.resolve) pendingConflict.resolve(false); } catch (_) { /* 收口失败不影响关弹窗 */ }
  }
  // F3（2026-10-06）「旧内容是否保存？」同一个道理：被 ✕ 关掉时也必须有个结局，
  // 否则这次正文写入会永远挂着（作者看到的是"点了却没反应"）。
  // 默认按**「是，先保存」**收口：误触关闭时最不该发生的事，就是把作者手里那一版弄丢。
  if (state.pendingOldContent) {
    const pendingOld = state.pendingOldContent;
    state.pendingOldContent = null;
    try { if (pendingOld.resolve) pendingOld.resolve(true); } catch (_) { /* 收口失败不影响关弹窗 */ }
  }
  // 弹窗关闭闸的状态同理：必须在同一处清空，否则下一个弹窗会继承上一个的快照/保护位。
  state.modalBaseline = null;
  state.modalProtected = false;
  const returnFocus = state.modalReturnFocus;
  state.modalReturnFocus = null;
  $('#modal-root').innerHTML = '';
  if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
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

// ---------- 编辑器 HTML → 纯文本（保留段落边界） ----------
// 与上面的 stripHtml 分工不同，**不要互相替换**：
//   stripHtml  → 只用来数字数（段落塌成一行无所谓）
//   editorPlainText → 用来当"正文文本"交给 AI 或做差异比对（段落边界是语义的一部分）
// 为什么必须保留段落：修稿的差异预览按段落切分（diffParagraphs 用 /\n{2,}/ 分段），
// 一旦把段落压成一行，整章会变成"一个段落"，差异比对随即失去意义。
//
// 为什么用 DOMParser：实体解码（&nbsp; &amp; 中文标点）交给浏览器原生解析器，比正则剥标签
// 更准；也不引第三方库（与本文件 F-03 的消毒器同一思路）。
const TEXT_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION', 'HR', 'ADDRESS', 'DD', 'DT']);
const TEXT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// 纯函数：吃任何形如 {nodeType, tagName, childNodes, nodeValue} 的节点树（因此可离线断言）。
function htmlNodeToText(root) {
  if (!root || !root.childNodes) return '';
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.push(String(child.nodeValue || '').replace(/\s+/g, ' ')); continue; }
      if (child.nodeType !== 1) continue; // 注释等一律丢弃
      const tag = String(child.tagName || '').toUpperCase();
      if (TEXT_SKIP_TAGS.has(tag)) continue;
      if (tag === 'BR') { out.push('\n'); continue; }
      walk(child);
      if (TEXT_BLOCK_TAGS.has(tag)) out.push('\n\n');
    }
  };
  walk(root);
  return out.join('')
    .replace(/[ \t]*\n[ \t]*/g, '\n') // 行首行尾空格
    .replace(/\n{3,}/g, '\n\n')       // 至多留一个空行（diffParagraphs 按 \n{2,} 分段）
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function defaultParseHtml(src) {
  if (typeof DOMParser === 'undefined') return null;
  return new DOMParser().parseFromString(src, 'text/html');
}

/**
 * 把编辑器里的 HTML 转成纯文本。
 * parseHtml 可注入：DOM 桩里没有真的 HTML 解析器，注入一个假解析器才能把这条路径真正测到。
 * 解析器不可用时**原样返回**而不是给空串——空串会让审稿/修稿静默对着空白跑。
 */
function editorPlainText(html = '', parseHtml = defaultParseHtml) {
  const raw = String(html || '');
  if (!raw.trim()) return '';
  const doc = parseHtml ? parseHtml(`<div data-ns-root="1">${raw}</div>`) : null;
  const root = doc && doc.querySelector ? doc.querySelector('[data-ns-root="1"]') : null;
  return root ? htmlNodeToText(root) : raw;
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

// F-29：章节字数缓存——wordCount 需剥标签并解析全章，大纲/目录渲染会频繁调用；
// 按章节内容缓存计数，内容字符串变化即自动失效（loadWorkData 全量重建时也会整体清空）。
const chapterWordCountCache = new Map();
function chapterWordCount(chapter) {
  if (!chapter) return 0;
  const cached = chapterWordCountCache.get(chapter.id);
  if (cached && cached.content === chapter.content) return cached.count;
  const count = wordCount(chapter.content);
  chapterWordCountCache.set(chapter.id, { content: chapter.content, count });
  return count;
}

/** 内存里该章的正文（没有则空串）。空内容护栏的"这一章原本有没有正文"判据用它。 */
function chapterContentOf(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return '';
  const row = (state.chapters || []).find((c) => Number(c.id) === id);
  return row && typeof row.content === 'string' ? row.content : '';
}

function setSidebar(show) {
  const sidebar = $('#sidebar');
  // F-13：侧栏折叠改用 .collapsed（margin-left 动画），不再用 .hidden（display:none 会吞掉动画）。
  sidebar.classList.remove('hidden');
  if (show) {
    // render() 会被大量交互调用，不能每次重置作者刚刚折叠的侧栏。
  sidebar.classList.toggle('collapsed', !!state.sidebarCollapsed);
  } else {
    state.sidebarCollapsed = true;
    sidebar.classList.add('collapsed');
  }
  updateSidebarToggleIcon();
  const backdrop = $('#sidebar-backdrop');
  if (backdrop) backdrop.classList.toggle('visible', show && !state.sidebarCollapsed && window.innerWidth <= 720);
}

function setEditorComposition(composing) {
  state.editorComposing = !!composing;
  state.imeComposing = !!composing;
  if (composing) {
    clearTimeout(state.editorSaveTimer);
    state.editorSaveTimer = null;
  } else if (state.editorSaveSnapshot) {
    scheduleSave();
  }
}

function setTopbarTitle(text) {
  $('#topbar-title').textContent = text;
  const context = $('#topbar-context');
  if (!context) return;
  const chapter = state.currentChapterId ? state.chapters.find((c) => Number(c.id) === Number(state.currentChapterId)) : null;
  const work = state.work && state.work.title ? state.work.title : '';
  const parts = [work, chapter && chapter.title].filter(Boolean);
  context.textContent = parts.length ? parts.join('  /  ') : '';
}

// 主题只改变呈现，不触发作品数据刷新或编辑器重建；偏好是轻量 UI 状态。
function applyTheme(theme, { persist = true } = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  if (persist) {
    try { localStorage.setItem('ns_theme', next); } catch (_) { /* 存储不可用时仅本次会话生效 */ }
  }
  const button = $('#theme-toggle');
  if (button) {
    button.textContent = next === 'dark' ? '☼ 浅色' : '☾ 深色';
    button.title = next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    button.setAttribute('aria-label', button.title);
  }
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
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
    if (force) state.workMeta.clear();
  }
  return state.works;
}

// 作品库使用现有 /chapters 与 /stats 接口做轻量派生，不修改后端返回契约。
// 失败时保留卡片本身可用，避免统计接口故障阻断“继续写作”。
async function loadWorkMeta(workId, { force = false } = {}) {
  const id = Number(workId) || 0;
  if (!id) return null;
  if (!force && state.workMeta.has(id)) return state.workMeta.get(id);
  try {
    // /stats 只提供计数，且 total_chapters 是计划值而非完成度；章节列表已经
    // 包含作品卡需要的真实数量与最近编辑信息，避免为每张卡再发一条请求。
    const chapters = await api(`/chapters?work_id=${id}`);
    const rows = Array.isArray(chapters) ? chapters : [];
    const recent = [...rows].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0] || null;
    const meta = {
      chapters: rows.length,
      words: rows.reduce((sum, chapter) => sum + chapterWordCount(chapter), 0),
      recentTitle: recent?.title || '',
      recentId: recent?.id || null,
      recentUpdatedAt: recent?.updated_at || recent?.created_at || '',
      status: 'ok'
    };
    state.workMeta.set(id, meta);
    return meta;
  } catch (_) {
    const meta = { chapters: null, words: null, recentTitle: '', recentId: null, recentUpdatedAt: '', status: 'error' };
    state.workMeta.set(id, meta);
    return meta;
  }
}

function formatWorkTime(ts) {
  if (!ts) return '尚未编辑';
  try {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return String(ts).replace('T', ' ').slice(0, 16);
    const now = Date.now();
    const delta = Math.max(0, now - d.getTime());
    if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.floor(delta / 60000))} 分钟前`;
    if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)} 小时前`;
    if (delta < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(delta / 86400000)} 天前`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch (_) { return String(ts || '').replace('T', ' ').slice(0, 16) || '尚未编辑'; }
}

function workStatusLabel(work, meta) {
  if (meta?.status === 'error') return { label: '信息暂不可用', cls: 'quiet' };
  const count = Number(meta?.chapters);
  if (!Number.isFinite(count)) return { label: '信息暂不可用', cls: 'quiet' };
  if (!(Number(meta?.words) > 0)) return { label: '尚未动笔', cls: 'quiet' };
  return { label: '已有正文', cls: 'active' };
}

async function loadWorkData(force = false) {
  // 读取新页面之前尽力把本页待落的稿子写完，但**绝不因为保存态中断任何操作**。
  // ⚠️ 2026-10-05（作者要求"不得影响用户的所有操作"）：这里原先会 `throw new Error('本地内容尚未保存…')`，
  // 于是"某一次保存没落地"会被升级成**整页操作失败**（典型现象：合并/取回已经成功，界面却报
  // "合并失败：本地内容尚未保存，请先处理保存冲突"）。现在只尽力落盘，结论由 flushSave 的提醒与重试承担。
  await flushSave();
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
  // F-02：并行加载期间作品可能已切换，丢弃过期结果，避免旧作品数据覆盖新作品状态。
  if (state.workId !== workId) return;
  Object.assign(state, {
    work, volumes, plotlines, chapters, categories, terms,
    characters, relations, plotlineCharacters, worldEntries, apiConfigs,
    loadedWorkId: workId
  });
  state.libraryLoaded = false; // P4：资料层的「按作品开关」随作品切换失效，下次进资料库页时重新取
  chapterWordCountCache.clear(); // F-29：章节全量重建，字数缓存失效
  // 空内容护栏的"该章曾经有多少字"：**按最大值累积，绝不因为某次载入变短就下调**。
  // 只在服务端确认过的正文比记忆里更长时才上调；本页自己写空/写短时服务端也会有这一版，
  // 但那是"已知的破坏结果"，不该拿来把护栏的判据冲淡（事故正是这样发生的）。
  for (const c of state.chapters) {
    const n = readableCharCount(c.content);
    if (n > (Number(state.chapterBodyPeak.get(c.id)) || 0)) state.chapterBodyPeak.set(c.id, n);
  }
  state.terms.forEach((t) => state.termsCache.set(t.id, t));
  state.characters.forEach((c) => state.charsCache.set(c.id, c));
  if (!state.activeConfigId && apiConfigs.length) state.activeConfigId = apiConfigs[0].id;
}

// 所有会替换编辑器或作品上下文的入口共用这一闸门。
// ⚠️ 2026-10-05（作者要求"用户所做的一切为最高优先级……不得影响用户的所有操作"）：
// **这个闸门不再拦人**。旧实现有两条会返回 false（输入法组字中 / 409 真冲突），于是 20 多处
// 导航调用全部失灵 —— 而"保存没成功"从来不是"不许你继续操作"的理由。现在它只做两件事：
// 尽力把本页稿子落盘、发现有未保存内容就给提醒并安排自动重试，然后**一律放行**。
// （保留函数与签名，是为了让 20+ 个调用点不必改；调用点的 `if (!(await …)) return;` 现在是恒假分支。）
async function ensureSavedBeforeNavigation() {
  await flushSave();
  return true;
}

// ---------- render dispatch ----------
function updateNavVisibility() {
  $$('#sidebar-nav button[data-view]').forEach((b) => {
    const v = b.dataset.view;
    if (v === 'works' || v === 'ai-create' || v === 'thanks') {
      // 「我的作品」「✨ AI 创作」「🙏 借鉴与致谢」只在未进入作品时显示
      b.classList.toggle('hidden', !!state.workId);
    } else if (v === 'logs' || v === 'trace' || v === 'library') {
      // 日志页 / 运行追踪页 / 资料库在作品内外都可访问：调试工具与跨作品资料都不属于某个作品
      b.classList.remove('hidden');
    } else {
      b.classList.toggle('hidden', !state.workId);
    }
  });
  $$('.nav-section-label').forEach((label) => {
    const section = label.dataset.navSection;
    const visible = section === 'global' ? !state.workId : section === 'workspace' ? !!state.workId : true;
    label.classList.toggle('hidden', !visible);
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
  if (state.view !== 'logs') {
    // F-31：离开日志页时清理自动刷新定时器，避免在其它页面空轮询。
    if (logsAutoTimer) { clearInterval(logsAutoTimer); logsAutoTimer = null; }
  }
  if (state.view !== 'trace' && typeof trace !== 'undefined' && trace.renderTimer) {
    // 🐞 运行追踪：离开追踪页时清掉待执行的列表重绘，避免在别的页面上空转。
    clearTimeout(trace.renderTimer);
    trace.renderTimer = null;
  }
  if (!state.workId) {
    setSidebar(true);
    updateNavVisibility();
    // 日志页与运行追踪页：作品内外均可访问，不依赖作品数据
    if (state.view === 'logs') {
      setActiveNav();
      updateSidebarTitle();
      setTopbarTitle('🧾 日志');
      return renderLogs(content);
    }
    if (state.view === 'trace') {
      setActiveNav();
      updateSidebarTitle();
      setTopbarTitle('🐞 运行追踪');
      return renderTrace(content);
    }
    // R06：借鉴与致谢是首页独占视图（进入作品后入口隐藏，见 updateNavVisibility）
    if (state.view === 'thanks') {
      setActiveNav();
      updateSidebarTitle();
      setTopbarTitle('🙏 借鉴与致谢');
      return renderThanks(content);
    }
    // P4：资料库是跨作品视图（作品内外都可用；每个作品的开关在页内单独操作）
    if (state.view === 'library') {
      setActiveNav();
      updateSidebarTitle();
      setTopbarTitle('📎 资料库');
      return renderLibrary(content);
    }
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
    // F-35：goView 已将 plot/outline/terms/characters/memory 统一映射到 settings、ai-create/ai/st 映射到 ai-board，
    // 且 restoreSession 也会把旧会话的旧视图名归一化，因此这里只保留合并后的板块分支。
    switch (state.view) {
      case 'settings':
        return renderSettingsBoard(content, state.settingsTab);
      case 'ai-board':
        return renderAIBoard(content, state.aiTab);
      case 'writing': return renderWriting(content);
      case 'overview': return renderOverview(content);
      case 'library': return renderLibrary(content);
      case 'works': return renderWorks();
      case 'logs': return renderLogs(content);
      case 'trace': return renderTrace(content);
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
  // R06：未进入作品时也记住首页视图（我的作品 / AI 创作 / 借鉴与致谢），刷新后回到原处。
  if (!state.workId) {
    try { sessionStorage.setItem('ns_home_view', state.view || 'works'); } catch (_) { /* 存储不可用时静默 */ }
  }
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('ns_session') || 'null');
    if (!saved || !Number(saved.workId)) return;
    state.workId = Number(saved.workId);
    state.loadedWorkId = null;
    // 视图归一化（F-35）：旧会话可能直接存了子视图名（plot/terms/st 等），统一映射到合并后的板块视图，
    // 初始页视图（works/ai-create/ai）在作品内没有意义，恢复为总览。
    const savedView = saved.view || 'overview';
    const tabSettings = SETTINGS_VIEWS.includes(saved.settingsTab) ? saved.settingsTab : 'terms';
    const tabAi = AI_BOARD_TABS.includes(saved.aiTab) ? saved.aiTab : 'ai';
    if (HOME_AI_VIEWS.includes(savedView) || savedView === 'works' || savedView === 'thanks') {
      state.view = 'overview';
      state.settingsTab = tabSettings;
      state.aiTab = tabAi;
    } else if (SETTINGS_VIEWS.includes(savedView)) {
      state.view = 'settings';
      state.settingsTab = savedView; // 旧会话的 view 本身就是 tab
      state.aiTab = tabAi;
    } else if (AI_VIEWS.includes(savedView)) {
      state.view = 'ai-board';
      state.aiTab = AI_BOARD_TABS.includes(savedView) ? savedView : 'ai';
      state.settingsTab = tabSettings;
    } else {
      state.view = savedView;
      state.settingsTab = tabSettings;
      state.aiTab = tabAi;
    }
    state.aiCreateHomeTab = ['auto', 'pipeline', 'history'].includes(saved.aiCreateHomeTab) ? saved.aiCreateHomeTab : 'auto';
    state.currentChapterId = Number(saved.currentChapterId) || null;
    state.currentPlotlineId = Number(saved.currentPlotlineId) || null;
    state.currentTermId = Number(saved.currentTermId) || null;
    state.currentCharacterId = Number(saved.currentCharacterId) || null;
  } catch (_) { /* 解析失败按全新会话处理 */ }
}

// ---------- 日志面板 ----------
let logsAutoTimer = null;
const logsState = { level: '', layer: '', q: '', beforeId: null, loading: false };
const debouncedLogSearch = debounce(() => refreshLogs(true), 300);

const LOG_LEVEL_LABELS = { error: '错误', warn: '警告', slow: '慢', info: '信息', debug: '调试' };

function fmtLogTime(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return String(ts || ''); }
}

function renderLogRow(l) {
  const ctx = (l.context && typeof l.context === 'object') ? l.context : {};
  const hasExtra = l.stack || Object.keys(ctx).length;
  const extraText = [l.stack, JSON.stringify(ctx, null, 2)].filter(Boolean).join('\n');
  const loc = l.code_file ? `${l.code_file}:${l.code_line ?? ''}` : '';
  const locShort = l.code_file ? `${l.code_file.split(/[\\/]/).pop()}:${l.code_line ?? ''}` : '';
  return `
    <div class="log-row log-${esc(l.level)}">
      <div class="log-head">
        <span class="log-time">${fmtLogTime(l.ts)}</span>
        <span class="log-badge log-badge-${esc(l.level)}">${esc(LOG_LEVEL_LABELS[l.level] || l.level)}</span>
        <span class="log-badge log-badge-layer" title="技术栈层级">${esc(l.layer)}</span>
        <span class="log-kind">${esc(l.kind)}</span>
        <span class="log-msg">${esc(l.message)}</span>
      </div>
      ${loc ? `<div class="log-loc" title="文件地址：${esc(loc)}">📄 ${esc(locShort)}${l.code_func ? ' · ' + esc(l.code_func) : ''}</div>` : ''}
      ${hasExtra ? `<details class="log-details"><summary>堆栈 / 上下文</summary><pre>${esc(extraText)}</pre></details>` : ''}
    </div>`;
}

async function refreshLogs(reset = false) {
  const listEl = $('#log-list');
  if (!listEl || logsState.loading) return;
  if (reset) logsState.beforeId = null;
  logsState.loading = true;
  try {
    const params = new URLSearchParams();
    if (logsState.level) params.set('level', logsState.level);
    if (logsState.layer) params.set('layer', logsState.layer);
    if (logsState.q.trim()) params.set('q', logsState.q.trim());
    if (logsState.beforeId) params.set('before_id', String(logsState.beforeId));
    params.set('limit', '200');
    const data = await api('/logs?' + params.toString());
    const entries = data.entries || [];
    const stats = data.stats || {};
    const statsEl = $('#log-stats');
    if (statsEl) {
      const b = stats.by_level || {};
      statsEl.textContent = `共 ${stats.total ?? entries.length} 条 · 错误 ${b.error || 0} · 警告 ${b.warn || 0} · 慢 ${b.slow || 0} · 信息 ${b.info || 0}`;
    }
    if (reset) listEl.innerHTML = '';
    if (!entries.length && reset) {
      listEl.innerHTML = '<div class="empty">暂无日志</div>';
    } else {
      listEl.insertAdjacentHTML('beforeend', entries.map(renderLogRow).join(''));
      if (entries.length) logsState.beforeId = entries[entries.length - 1].id;
    }
    const moreBtn = $('#log-more');
    if (moreBtn) moreBtn.hidden = entries.length < 200;
  } catch (e) {
    const el = $('#log-list');
    if (el) el.innerHTML = `<div class="empty">日志加载失败：${esc(e.message)}</div>`;
  } finally {
    logsState.loading = false;
  }
}

function renderLogs(content) {
  if (logsAutoTimer) { clearInterval(logsAutoTimer); logsAutoTimer = null; }
  content.innerHTML = `
    <div class="logs-page">
      <div class="logs-toolbar">
        <select id="log-level">
          <option value="">全部级别</option>
          <option value="error">错误</option>
          <option value="warn">警告</option>
          <option value="slow">慢</option>
          <option value="info">信息</option>
        </select>
        <select id="log-layer">
          <option value="">全部层级</option>
          <option value="server">server</option>
          <option value="db">db</option>
          <option value="harness">harness</option>
          <option value="ai">ai</option>
          <option value="openviking">openviking</option>
          <option value="sync">sync</option>
          <option value="plugin">plugin</option>
          <option value="frontend">frontend</option>
          <option value="process">process</option>
        </select>
        <input type="search" id="log-q" placeholder="搜索消息…">
        <button class="btn small" data-action="logs-refresh">刷新</button>
        <button class="btn small danger" data-action="logs-clear" title="清空数据库中的全部日志记录">清空</button>
        <span class="log-stats" id="log-stats"></span>
      </div>
      <div class="log-list" id="log-list"></div>
      <button class="btn secondary" id="log-more" data-action="logs-more" hidden>加载更多</button>
    </div>`;
  const levelSel = $('#log-level');
  const layerSel = $('#log-layer');
  const qInput = $('#log-q');
  if (levelSel) levelSel.value = logsState.level;
  if (layerSel) layerSel.value = logsState.layer;
  if (qInput) qInput.value = logsState.q;
  refreshLogs(true);
  // 页面停留期间每 5 秒自动刷新
  logsAutoTimer = setInterval(() => refreshLogs(), 5000);
}

async function render() {
  // ⚠️ 2026-10-05（作者要求"不得影响用户的所有操作"）：**不再因为保存态而拒绝渲染**。
  // 旧实现在这里是 `if (!(await flushSave())) { …; return false; }`，于是"编辑器是空的 / 409 冲突 /
  // 组字中"会让**整页停止更新**（视图切不动、内容不刷新）—— 那是最彻底的一种"保存影响操作"。
  // 现在只尽力把本页稿子落盘；落没落盘由 flushSave 的提醒 + 自动重试承担，渲染一律继续。
  await flushSave();
  document.body.classList.remove('writing-focus-active');
  await renderView();
  state.lastRenderedRoute = Object.fromEntries(['workId', 'work', 'loadedWorkId', 'view', 'settingsTab', 'aiTab', 'currentChapterId'].map((key) => [key, state[key]]));
  persistSession();
  // 编辑器在 DOM 里时才刷新「生成稿 / 上次审稿」条（异步，不阻塞渲染）。
  const editor = typeof document !== 'undefined' ? document.getElementById('editor-content') : null;
  const chapterId = Number(editor && editor.dataset ? editor.dataset.chapterId : 0);
  if (chapterId && state.recoveryForChapter !== chapterId) {
    refreshChapterRecovery(chapterId)
      .then(() => {
        const box = document.getElementById('chapter-recovery');
        const cur = state.chapters.find((c) => c.id === chapterId);
        if (box && cur) box.innerHTML = recoveryBarHtml(cur);
      })
      .catch(() => { /* 恢复条失败不影响写作 */ });
  }
}

// ---------- 生成稿草稿 / 上次审稿：编辑器顶部的「取回」条 ----------
// 背景：AI 成文结果此前只活在结果弹窗的 state 里，用户点「先审稿再应用」或「取消」
// 关掉弹窗，这版稿子就静默消失；审稿报告解析失败也会整份丢弃。现在生成稿在弹窗出现时
// 即落成草稿、审稿报告一律落库，这里负责把它们重新暴露给用户。

// 每章保留的蓝图份数（服务端 BLUEPRINT_HISTORY_LIMIT 的同名口径）。服务端返回 limit 时以它为准，
// 这里只是拿不到响应时的兜底显示值（"1/2" 里那个 2）。
const BLUEPRINT_LIMIT_FALLBACK = 2;
// 蓝图六字段的用户面标签（`查看`/确认框共用；顺序即展示顺序）。
const BLUEPRINT_FIELD_LABELS = [
  ['scene_goal', '场景目标'],
  ['plot_points', '情节点'],
  ['conflicts', '冲突与转折'],
  ['character_changes', '出场角色状态变化'],
  ['hook', '下一章钩子'],
  ['references', '参考设定（需要回扣的设定/伏笔）']
];

/** 蓝图一行摘要：优先场景目标，其次情节点 / 钩子；都没有就明说"没有可读内容"。 */
function blueprintLineSummary(bp) {
  const one = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return one(bp?.scene_goal, 46) || one(bp?.plot_points, 46) || one(bp?.hook, 46) || '（这份蓝图没有可读内容）';
}

/**
 * 这一行长任务记录是不是"蓝图轮"。
 * 新记录看 kind（蓝图轮落库时明确写 kind='blueprint'）；历史遗留行看服务端的 is_blueprint
 * —— 那些行早年与成文轮共用 kind='prose'，只能按产出内容判定（server.js looksLikeBlueprintOutput）。
 */
function isBlueprintJob(job) {
  return job?.kind === 'blueprint' || job?.is_blueprint === true;
}

/** 蓝图完整内容（供「查看」弹窗）：按六字段顺序拼成带小标题的纯文本段落。 */
function blueprintFullText(bp) {
  const b = bp && typeof bp === 'object' ? bp : {};
  const blocks = BLUEPRINT_FIELD_LABELS
    .map(([key, label]) => {
      const v = String(b[key] || '').trim();
      return v ? `【${label}】\n${v}` : '';
    })
    .filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : '（这份蓝图没有可读内容）';
}

function recoveryBarHtml(current) {
  const d = state.chapterDraft;
  const r = state.chapterReview;
  const draftOk = d && Number(d.chapter_id) === Number(current.id);
  // r.dismissed：作者已经把「上次审稿」这条提示关掉（2026-10-04）——审稿记录照旧可查，
  // 但这一行不再显示。判据放在这里而不是服务端过滤：关闭是关于"提示"的，
  // 别的入口（例如从审稿页回看）不该因此查不到报告。
  const reviewOk = r && Number(r.chapter_id) === Number(current.id) && !r.dismissed;
  const jobs = Array.isArray(state.chapterJobs) ? state.chapterJobs : [];
  // 已保存的蓝图（每章最多 2 份）：只认本章那一批 —— 与草稿/审稿同一条判据。
  const bps = (Array.isArray(state.chapterBlueprints) ? state.chapterBlueprints : [])
    .filter((b) => Number(b.chapter_id) === Number(current.id));
  const saveFailed = state.editorSaveFailedSnapshot && Number(state.editorSaveFailedSnapshot.id) === Number(current.id);
  // 「编辑器被清空、自动保存已暂停」也是这一条恢复条要说话的状态：两条出路（取回原稿 / 明确清空）
  // 都只有这里能提供。事故复盘：旧实现只把暂停写进状态栏，作者看到"暂停了"却没有任何可点的动作。
  const bodyEmpty = state.editorEmptyBlocked && Number(state.editorEmptyBlocked.id) === Number(current.id);
  // "有改动还没落盘"也要有出路（作者要求：未保存的提醒里必须带"保存"这个动作）。
  // 已被 saveFailed / bodyEmpty 覆盖的情况不重复列，避免同一条恢复条出现两行说同一件事。
  const pendingUnsaved = !saveFailed && !bodyEmpty
    && ((state.editorSaveSnapshot && Number(state.editorSaveSnapshot.id) === Number(current.id))
      || state.editorPendingByChapter.has(Number(current.id))
      || state.editorSaveInFlight.has(Number(current.id)));
  if (!draftOk && !reviewOk && !jobs.length && !bps.length && !saveFailed && !bodyEmpty && !pendingUnsaved) return '';
  const items = [];
  if (bodyEmpty) {
    const held = knownChapterBodyChars(current.id);
    items.push(`<span class="recovery-item">🛡 本章编辑器是空的，<b>自动保存已暂停</b>（正文没有被覆盖${held ? `：库里仍有 ${held} 字` : ''}）
      <button class="btn small" data-action="editor-empty-restore">取回历史版本</button>
      <button class="btn small secondary" data-action="editor-empty-clear">确认清空本章</button></span>`);
  }
  if (saveFailed) {
    // 空正文被服务端拦下时"重试保存"只会再被拦一次；先给能走通的那两步。
    const blocked = state.editorSaveFailedSnapshot.code === 'EMPTY_OVERWRITE_BLOCKED';
    items.push(`<span class="recovery-item">⚠ 正文${blocked ? '空内容写入被服务端拦下，正文未被改动' : `保存失败：${esc(state.editorSaveFailedSnapshot.message || '请重试')}`}
      ${blocked
        ? '<button class="btn small" data-action="editor-empty-restore">取回历史版本</button><button class="btn small secondary" data-action="editor-empty-clear">确认清空本章</button>'
        : '<button class="btn small" data-action="manual-save-chapter">重试保存</button>'}</span>`);
  }
  if (pendingUnsaved) {
    items.push(`<span class="recovery-item">💾 这一章的改动还没保存 <button class="btn small" data-action="editor-save-now">立即保存</button>
      <span class="muted" style="font-size:12px">（后台已在自动重试，不会打断你现在的操作）</span></span>`);
  }
  // 已保存的蓝图：**每一份都要显示出来**（作者 2026-10-06 要求），每条带「生成」「查看」「删除」。
  // 为什么放在长任务之前：它是这一章"接下来要怎么行文"的现行计划，比"某次任务跑完了没"更该先看见。
  if (bps.length) {
    const limit = Number(state.chapterBlueprintLimit) || BLUEPRINT_LIMIT_FALLBACK;
    bps.forEach((b, i) => {
      const head = i === 0 ? `📐 已保存蓝图 ${i + 1}/${limit}（最新）` : `📐 蓝图 ${i + 1}/${limit}`;
      items.push(`<span class="recovery-item bp-item">${head} · ${esc(blueprintLineSummary(b.blueprint))}
        <span class="muted" style="font-size:12px">${esc(fmtTraceTime(b.created_at))}</span>
        <button class="btn small" data-action="bp-generate" data-id="${Number(b.id)}" title="按这份蓝图生成正文：先打开蓝图确认框（可改），点「按此蓝图成文」后才开始生成">生成</button>
        <button class="btn small secondary" data-action="bp-view" data-id="${Number(b.id)}" title="查看这份蓝图的完整内容">查看</button>
        <button class="btn small secondary" data-action="bp-delete" data-id="${Number(b.id)}" title="删除这一份蓝图（只删蓝图，不动正文）">✕ 删除</button></span>`);
    });
  }
  // 长任务：刷新/重启后仍要看得出「还在跑」还是「跑完了没应用」。
  for (const j of jobs.slice(0, 4)) {
    const st = jobStatusLabel(j);
    // 蓝图轮**不是**「AI 写作」：整条写作管线里它的产物是一份计划，不是正文（作者 2026-10-06 要求
    // 「蓝图生成的显示成『蓝图』，而不是『AI 写作』」）。历史遗留行由服务端 is_blueprint 兜住。
    const isBp = isBlueprintJob(j);
    const what = isBp ? '📐 蓝图' : (j.stage || (j.kind === 'review' ? 'AI 审稿' : j.kind === 'revision' ? 'AI 修稿' : 'AI 写作'));
    const actions = [];
    if (st.canResume) actions.push(`<button class="btn small" data-action="resume-job" data-id="${esc(j.id)}">接回进度</button>`);
    // ⚠️ 蓝图不提供「取回结果并应用」：那会把一份【蓝图】JSON 当成正文写进章节（2026-10-01 /
    // 2026-10-04 两次真实事故的同一形状）。蓝图的正路是下面的「已保存蓝图」块 →「生成」。
    if (st.canFetch && !isBp) actions.push(`<button class="btn small" data-action="fetch-job" data-id="${esc(j.id)}">取回结果并应用</button>`);
    // 「关闭」只出现在**已经结束**的任务上（2026-10-04：作者截图里三条「已完成，结果待应用」同样没有出口，
    // 那些结果他永远不想要，提示却一直挂着）。判据直接用 canResume —— 还在跑的行只能停止/接回：
    // 把一条还在跑的任务"关掉"，等于把"它还在跑"这件事藏起来，那是误导，不是关闭。
    if (!st.canResume) actions.push(`<button class="btn small secondary" data-action="dismiss-job" data-id="${esc(j.id)}" title="这条结果不要了：以后不再提示（任务记录与产出仍留在库里，正文不受影响）">✕ 关闭</button>`);
    items.push(`<span class="recovery-item">${st.cls === 'err' ? '⚠️' : '⏳'} ${esc(what)}：<b class="recovery-${st.cls}">${st.text}</b>
      ${j.output_chars ? `· 产出 ${j.output_chars} 字符` : ''}
      ${j.error ? `· ${esc(String(j.error).slice(0, 60))}` : ''}
      ${actions.join(' ')}</span>`);
  }
  if (draftOk) {
    items.push(`<span class="recovery-item">🗂 有未应用的生成稿（${Number(d.chars) || 0} 字，${fmtTraceTime(d.created_at)}）
      <button class="btn small" data-action="restore-draft">取回生成稿</button>
      <button class="btn small secondary" data-action="preview-draft">预览</button>
      <button class="btn small secondary" data-action="dismiss-draft" title="这一版不要了：以后不再提示（不会改动正文，内容也不删除）">✕ 关闭</button></span>`);
  }
  if (reviewOk) {
    const label = r.parsed
      ? `🔍 上次审稿（${Number(r.issue_count) || 0} 个问题，${fmtTraceTime(r.created_at)}）`
      : `🔍 上次审稿格式异常，已存原文（${fmtTraceTime(r.created_at)}）`;
    items.push(`<span class="recovery-item">${label}
      <button class="btn small secondary" data-action="open-last-review">查看</button>
      <button class="btn small secondary" data-action="dismiss-review" data-id="${Number(r.id) || 0}" title="这条提示不要了：以后不再提示（审稿报告仍留在库里，正文不受影响）">✕ 关闭</button></span>`);
  }
  return `<div class="recovery-bar">${items.join('')}</div>`;
}

/**
 * 就地重画恢复条（不整页 render）。
 * 为什么不用 render()：它会重建编辑器节点，正在写的人会丢光标与撤销栈；
 * 而恢复条只是一段提示，自己重画即可。
 *
 * `chapterId` 可显式指定（护栏那几条路拿得到编辑器上的章号）；不传时按
 * 当前章 → 编辑器 dataset 的顺序取。顺序不能倒过来：编辑器节点在切章的一瞬间可能还挂着
 * 上一章的 dataset，而"当前章"是我们真正要画的那一条（渲染路径自己会用 dataset 取数）。
 */
function refreshRecoveryBar(chapterId = 0) {
  if (typeof document === 'undefined') return false;
  const box = document.getElementById('chapter-recovery');
  if (!box) return false;
  const editor = document.getElementById('editor-content');
  const id = Number(chapterId) || Number(state.currentChapterId) || Number(editor?.dataset?.chapterId) || 0;
  const cur = state.chapters.find((c) => c.id === id);
  if (!cur) return false;
  // 每条自己会核对 chapter_id（recoveryBarHtml 里逐条比对），所以这里不存在"画错章的提示"。
  box.innerHTML = recoveryBarHtml(cur);
  return true;
}

/**
 * 拉取当前章节的草稿与最近审稿状态（失败静默：这只是辅助提示，不该影响写作）。
 *
 * ⚠️ 末尾**必须**就地重画一次恢复条（2026-10-04 事故）：本函数是"让恢复条反映最新状态"的
 * 主入口，而取数据与画界面此前被拆在两处（画的那句写在 render() 的 .then 里）。
 * 于是"调了 refreshChapterRecovery 就等于界面会更新"这个假设是错的 —— 空稿护栏那三条路
 * 正是这么调的，作者看到"用恢复条取回原稿，或明确选择清空本章"，恢复条上却什么都没有。
 */
async function refreshChapterRecovery(chapterId) {
  const id = Number(chapterId);
  if (!id) {
    state.chapterDraft = null;
    state.chapterReview = null;
    state.chapterBlueprints = [];
    refreshRecoveryBar();
    return;
  }
  state.recoveryForChapter = id;
  try {
    const [draft, review, jobs, bps] = await Promise.all([
      api(`/novel/draft?chapter_id=${id}`).catch(() => null),
      api(`/novel/review?chapter_id=${id}`).catch(() => null),
      api(`/harness/recoverable?chapter_id=${id}`).catch(() => null),
      api(`/novel/chapter_blueprints?chapter_id=${id}`).catch(() => null)
    ]);
    if (state.recoveryForChapter !== id) return; // 已切章：丢弃过期结果
    state.chapterDraft = draft?.draft || null;
    state.chapterReview = review?.review || null;
    // 已保存的蓝图：**全部**列出来（服务端已按"最新在前、每章最多 limit 份"返回）。
    state.chapterBlueprints = Array.isArray(bps?.blueprints) ? bps.blueprints : [];
    state.chapterBlueprintLimit = Number(bps?.limit) || BLUEPRINT_LIMIT_FALLBACK;
    // 只留还有意义的：能续接的、有产出可取回的、或失败/中断需要告知的。
    // 「已完成且未应用」只对写作类任务提供「取回结果」按钮 —— pipeline 等其它 kind
    // 的产出是内部流程数据，用户取回后只会被当正文打开，纯属误导。
    const APPLYABLE_KINDS = new Set(['prose', 'review', 'revision', 'write']);
    state.chapterJobs = (jobs?.jobs || []).filter((j) => {
      if (j.resumable) return true;
      if (['failed', 'timeout', 'interrupted'].includes(j.status)) return true;
      // 蓝图轮**已完成的产出不是可应用的结果**（把蓝图 JSON 当正文写进章节是两次真实事故的形状）：
      // 它已经在上面「已保存蓝图」块里以可操作的形式显示，这里不再重复列成「AI 写作：结果待应用」。
      // 还在跑 / 失败的蓝图轮仍要显示（能停止、能看到失败原因），所以这两个分支在它前面。
      if (isBlueprintJob(j)) return false;
      return !!(j.has_output && APPLYABLE_KINDS.has(j.kind));
    });
  } catch (_) {
    state.chapterDraft = null;
    state.chapterReview = null;
    state.chapterJobs = [];
    state.chapterBlueprints = [];
  }
  refreshRecoveryBar(id);
}

/**
 * 标记长任务产出已应用——服务端与本地**同步**完成：
 * - 服务端：kind 追加 ':applied' 后缀，恢复条查询（kind NOT LIKE '%:applied'）据此排除；
 * - 本地：立即把该任务从 state.chapterJobs 移除并刷新恢复条。
 *
 * 只写服务端、不动本地列表的话，恢复条会一直挂着「已完成，结果待应用」
 * 直到下次切章重新拉取——上一轮就犯过这种「标记与展示不同步」的错。
 */
function markJobApplied(jobId) {
  if (!jobId) return;
  api('/harness/mark_applied', { method: 'POST', body: { job_id: jobId } }).catch(() => { /* 标记失败只影响恢复条 */ });
  const jobs = Array.isArray(state.chapterJobs) ? state.chapterJobs : [];
  if (jobs.some((j) => j.id === jobId)) {
    state.chapterJobs = jobs.filter((j) => j.id !== jobId);
    const box = document.getElementById('chapter-recovery');
    const cur = state.chapters.find((c) => c.id === state.currentChapterId);
    if (box && cur) box.innerHTML = recoveryBarHtml(cur);
  }
}

/** 长任务状态 → 界面文案与可用动作。 */
function jobStatusLabel(job) {
  if (job.status === 'running' || job.status === 'queued') return { text: '进行中', cls: 'run', canResume: true, canFetch: false };
  if (job.status === 'done') return { text: '已完成，结果待应用', cls: 'ok', canResume: false, canFetch: true };
  if (job.status === 'interrupted') return { text: '服务重启后已中断', cls: 'err', canResume: false, canFetch: false };
  if (job.status === 'cancelled') return { text: '已取消', cls: 'warn', canResume: false, canFetch: false };
  if (job.status === 'timeout') return { text: '超时', cls: 'warn', canResume: false, canFetch: !!job.has_output };
  return { text: '失败', cls: 'err', canResume: false, canFetch: !!job.has_output };
}

// ---------- 🐞 运行追踪（客户端侧） ----------
// 录制开关打开后，把「一次用户操作」实际执行的前端代码路径记录下来：
//   操作分组（opId） → 处理链耗时 → 该操作触发的 API 调用 → 界面渲染 / toast / 报错
// 通过 X-Trace-Op 头与后端关联，前端节点与后端节点在同一个操作里按时间排序展示。
// 硬约束：只记代码位置、耗时、状态与结果的「形状」，绝不记录编辑器里的正文内容。
const trace = {
  on: false,
  sessionId: '',
  ops: [], // 界面上的操作列表（按时间倒序展示）
  opId: '', // 当前操作（点击触发的处理链）
  opTitle: '',
  opNodes: [],
  opStartedAt: 0,
  longOpId: '', // 长流程操作（AI 写作等，带空闲窗口）
  longTitle: '',
  longNodes: [],
  longStartedAt: 0,
  longLastAt: 0,
  toasts: [],
  flushTimer: null,
  pingTimer: null,
  stream: null,
  streamRetry: null,
  pending: new Map(),
  filters: { onlyError: false, onlyAi: false, slowMs: 0, q: '' },
  detailCache: new Map(),
  detailOpId: '',
  renderTimer: null,
  sessionEnded: false
};

const TRACE_LONG_IDLE_MS = 120000; // 长流程空闲窗口：超过则收尾，避免把无关操作并进来
const TRACE_MAX_CLIENT_NODES = 120; // 单次操作的前端节点上限（与后端的硬上限同思路）

// 操作语义名映射：把 data-action 翻成一眼能懂的业务名（第 8 题：按业务动作归并）。
const TRACE_ACTION_LABELS = {
  'go-view': '切换视图',
  'back-works': '返回作品列表',
  'board-tab': '切换板块',
  'save-chapter': '保存本章',
  'save-work': '保存作品',
  'save-term': '保存设定词条',
  'save-character': '保存角色',
  'save-plotline': '保存剧情线',
  'save-volume': '保存分卷',
  'save-category': '保存分类',
  'save-world-entry': '保存世界观词条',
  'save-relation': '保存人物关系',
  'save-api-config': '保存模型配置',
  'test-api-config': '测试模型连接',
  'set-active-config': '切换当前模型配置',
  'new-chapter': '新建章节',
  'delete-chapter': '删除章节',
  'delete-work': '删除作品',
  'ai-write': 'AI 写本章',
  'ai-write-stream': 'AI 写本章',
  'ai-polish': 'AI 润色',
  'ai-expand': 'AI 扩写',
  'ai-outline': 'AI 生成大纲',
  'ai-consistency': 'AI 一致性核对',
  'ai-personality': 'AI 生成角色设定',
  'ai-generate-novel': 'AI 自动创建小说',
  'install-demo': '导入示例小说',
  'remove-demo': '删除示例小说',
  'global-search': '全局搜索',
  'chapter-save': '保存章节正文',
  'save-memory': '保存长期记忆',
  'compress-memory': '压缩长期记忆',
  'import-work': '导入作品',
  'export-work': '导出作品',
  'shutdown-server': '关闭服务'
};

function traceActionLabel(action, el) {
  const base = TRACE_ACTION_LABELS[action] || action || '操作';
  const sub = el && el.dataset ? (el.dataset.view || el.dataset.tab || '') : '';
  if ((action === 'go-view' || action === 'board-tab') && sub) return `${base}：${sub}`;
  return base;
}

function traceNewId(prefix) {
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch (_) { /* 降级 */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function traceNow() {
  return new Date().toISOString();
}

/** 结果形状摘要：与后端 shapeOf 同思路，长文本只留长度。 */
function traceShape(v, depth = 0) {
  if (v === null || v === undefined) return { type: String(v) };
  const t = typeof v;
  if (t === 'string') return v.length <= 160 ? { type: 'string', len: v.length, value: v } : { type: 'string', len: v.length, omitted: true };
  if (t === 'number' || t === 'boolean') return { type: t, value: v };
  if (t === 'function') return { type: 'function', name: String(v.name || '').slice(0, 60) };
  if (v instanceof Error) return { type: 'error', name: v.name, message: String(v.message || '').slice(0, 500) };
  if (Array.isArray(v)) {
    const out = { type: 'array', len: v.length };
    if (depth < 4 && v.length) out.sample = v.slice(0, 3).map((x) => traceShape(x, depth + 1));
    return out;
  }
  if (t === 'object') {
    const out = { type: 'object', keys: Object.keys(v).slice(0, 20) };
    const critical = {};
    for (const k of ['id', 'work_id', 'chapter_id', 'ok', 'status', 'error', 'count', 'total', 'view', 'path', 'method', 'tokens', 'usage', 'accepted']) {
      if (k in v) critical[k] = traceShape(v[k], 4);
    }
    if (Object.keys(critical).length) out.critical = critical;
    return out;
  }
  return { type: t };
}

/** 取调用栈里第一个业务帧（跳过追踪辅助函数自身与浏览器内部帧）。 */
function traceCallerLocation() {
  try {
    const lines = String(new Error().stack || '').split('\n');
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || line.indexOf(' at ') < 0) continue;
      if (/trace[A-Z]/.test(line)) continue;
      const text = line.trim().replace(/^at\s+/, '');
      const withFn = text.match(/^(.*?)\s*\((.*?):(\d+):(\d+)\)$/);
      const bare = withFn ? null : text.match(/^(.*?):(\d+):(\d+)$/);
      if (!withFn && !bare) continue;
      const file = withFn ? withFn[2] : bare[1];
      const ln = Number(withFn ? withFn[3] : bare[2]);
      return {
        file: String(file).replace(/^https?:\/\/[^/]+/, '').slice(0, 160),
        line: Number.isFinite(ln) ? ln : null,
        func: withFn ? String(withFn[1]).slice(0, 80) : ''
      };
    }
  } catch (_) { /* 忽略 */ }
  return { file: 'public/app.js', line: null, func: '' };
}

/** 前端节点统一入口：调用时间 + 代码位置 + 耗时 + 结果形状。 */
function traceClientNode(kind, name, costMs, status, result, extra = {}) {
  if (!trace.on) return;
  const scopeLong = trace.longOpId && (Date.now() - trace.longLastAt <= TRACE_LONG_IDLE_MS);
  const list = scopeLong ? trace.longNodes : trace.opNodes;
  if (!scopeLong && !trace.opId) return; // 既无当前操作也无长流程：不记（避免污染）
  if (list.length >= TRACE_MAX_CLIENT_NODES) return;
  const loc = extra.code || traceCallerLocation();
  list.push({
    at: traceNow(),
    kind,
    name,
    file: loc.file,
    line: loc.line,
    func: loc.func,
    cost_ms: Math.round(Number(costMs) || 0),
    status: status === 'error' ? 'error' : 'ok',
    result: result === undefined ? undefined : traceShape(result),
    error: extra.error ? { name: extra.error.name || 'Error', message: String(extra.error.message || '').slice(0, 500) } : undefined
  });
  if (scopeLong) trace.longLastAt = Date.now();
}

function traceSnapshotView() {
  return {
    view: state.view,
    work_id: state.workId || null,
    chapter_id: state.currentChapterId || null,
    settings_tab: state.settingsTab || null,
    ai_tab: state.aiTab || null
  };
}

/** 开一次操作（点击触发的处理链）。 */
function traceBegin(action, el, kind = 'ui') {
  if (!trace.on) return '';
  traceFlushOp('done'); // 上一条还没收尾的先落地
  trace.opId = traceNewId('ui');
  trace.opTitle = traceActionLabel(action, el);
  trace.opNodes = [];
  trace.opStartedAt = performance.now();
  traceClientNode(kind, `点击：${action || '操作'}`, 0, 'ok', undefined);
  return trace.opId;
}

/** 开/续一次长流程操作（AI 写作这类跨多次交互的链路）。 */
function traceLongOp(title) {
  if (!trace.on) return '';
  // AI 长流程启动时，把未收尾的点击操作先落地：它只是「发起者」，
  // 真正的阶段请求（上下文装配/AI 调用/扫描）都要归到长流程操作上。
  if (trace.opId) traceFlushOp('done');
  const fresh = !trace.longOpId || Date.now() - trace.longLastAt > TRACE_LONG_IDLE_MS;
  if (fresh) {
    traceFlushLong('done');
    trace.longOpId = traceNewId('task');
    trace.longTitle = title || 'AI 任务';
    trace.longNodes = [];
    trace.longStartedAt = performance.now();
  }
  trace.longLastAt = Date.now();
  return trace.longOpId;
}

function traceFlushOp(status) {
  if (!trace.opId) return;
  const opId = trace.opId;
  const nodes = trace.opNodes.slice();
  const title = trace.opTitle;
  const cost = Math.round(performance.now() - trace.opStartedAt);
  trace.opId = '';
  trace.opNodes = [];
  if (nodes.length) {
    nodes.push({ at: traceNow(), kind: 'ui', name: '界面渲染结果', ...traceCallerLocation(), cost_ms: cost, status: status === 'error' ? 'error' : 'ok', result: traceSnapshotView() });
  }
  traceSendOp(opId, title, nodes, status, cost);
}

function traceFlushLong(status) {
  if (!trace.longOpId) return;
  const opId = trace.longOpId;
  const nodes = trace.longNodes.slice();
  const title = trace.longTitle;
  const cost = Math.round(performance.now() - trace.longStartedAt);
  trace.longOpId = '';
  trace.longNodes = [];
  if (nodes.length) {
    nodes.push({ at: traceNow(), kind: 'ui', name: '流程结束', ...traceCallerLocation(), cost_ms: cost, status: status === 'error' ? 'error' : 'ok', result: traceSnapshotView() });
  }
  traceSendOp(opId, title, nodes, status, cost);
}

/** 一次操作收尾：前端节点 + 渲染结果 + toast 一起回传后端合流。 */
function traceSendOp(opId, title, nodes, status, costMs) {
  if (!opId) return;
  const payload = {
    op_id: opId,
    title: title || '前端操作',
    status: status || 'done',
    cost_ms: costMs,
    render: traceSnapshotView(),
    toast: trace.toasts.slice(0, 5),
    nodes: nodes.map((n) => ({
      at: n.at, kind: n.kind, name: n.name,
      file: n.file, line: n.line, func: n.func,
      cost_ms: n.cost_ms, status: n.status, result: n.result, error: n.error
    }))
  };
  trace.toasts = [];
  trace.pending.set(opId, payload);
  traceSendPending();
}

function traceSendPending(force = false) {
  // force=true：停录收尾场景——trace.on 即将被置 false，但 pending 里的最后一批操作
  // 必须发出去，否则它们会永远留在内存里（后端已封卷时由后端幂等/封卷闸门兜底）。
  if ((!trace.on && !force) || !trace.pending.size) return;
  for (const [opId, payload] of Array.from(trace.pending.entries())) {
    trace.pending.delete(opId);
    fetch('/api/debug/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (data && data.summary) traceUpsertOp(data.summary);
    }).catch(() => { /* 上报失败不积压 */ });
  }
}

/** 收尾判定：处理链可能在 await 之后才真正结束。 */
function traceScheduleOpFlush() {
  if (!trace.on || trace.flushTimer) return;
  trace.flushTimer = setTimeout(() => {
    trace.flushTimer = null;
    if (trace.opId) traceFlushOp('done');
  }, 150);
}

/** 包装一次用户操作的处理链：记录耗时、失败与前端调用链。 */
function traceWrapHandler(action, el, fn) {
  if (!trace.on) return fn();
  traceBegin(action, el);
  const t0 = performance.now();
  let out;
  try {
    out = fn();
  } catch (e) {
    traceClientNode('fn', `处理链：${action || '操作'}`, performance.now() - t0, 'error', undefined, { error: e });
    traceScheduleOpFlush();
    throw e;
  }
  if (out && typeof out.then === 'function') {
    return out.then(
      (v) => {
        traceClientNode('fn', `处理链：${action || '操作'}`, performance.now() - t0, 'ok', v);
        traceScheduleOpFlush();
        return v;
      },
      (e) => {
        traceClientNode('fn', `处理链：${action || '操作'}`, performance.now() - t0, 'error', undefined, { error: e });
        traceScheduleOpFlush();
        throw e;
      }
    );
  }
  traceClientNode('fn', `处理链：${action || '操作'}`, performance.now() - t0, 'ok', out);
  traceScheduleOpFlush();
  return out;
}

/** fetch 层的追踪记录（由 api() 与直连 fetch 调用）。 */
function traceApiRecord(path, method, costMs, status, result, err) {
  if (!trace.on) return;
  const hasLong = trace.longOpId && Date.now() - trace.longLastAt <= TRACE_LONG_IDLE_MS;
  if (!trace.opId && !hasLong) {
    // 没有操作上下文（自动保存、轮询等）：单独起一条「后台请求」操作，避免漏记。
    trace.opId = traceNewId('bg');
    trace.opTitle = `后台请求：${path}`;
    trace.opNodes = [];
    trace.opStartedAt = performance.now() - costMs;
  }
  traceClientNode('api', `${method || 'GET'} ${path}`, costMs, err ? 'error' : 'ok', result, { error: err });
}

/** 当前操作上下文：供 api() 注入 X-Trace-Op / X-Trace-Title 头。 */
function traceHeaders() {
  if (!trace.on) return null;
  const hasLong = trace.longOpId && Date.now() - trace.longLastAt <= TRACE_LONG_IDLE_MS;
  if (!trace.opId && !hasLong) return null;
  // 点击操作优先：AI 长流程启动时（traceLongOp）已把未收尾的点击操作落地，
  // 这里不会出现「点击操作抢占 AI 阶段请求」的情况；而长流程只应在没有点击操作
  // 在途时接管请求归属（例如长流程内部的后续阶段）。
  const opId = trace.opId || trace.longOpId;
  const title = trace.opId ? trace.opTitle : trace.longTitle;
  return {
    'X-Trace-Op': opId,
    'X-Trace-Title': encodeURIComponent(title || '前端操作')
  };
}

// ---------- SSE 实时流 ----------
function traceStartStream() {
  if (trace.stream) return;
  try {
    const es = new EventSource('/api/debug/stream');
    trace.stream = es;
    es.onmessage = (ev) => {
      let item;
      try {
        item = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      // 逐帧隔离：单帧结构异常（例如历史遗留的 numbers/array 混用）绝不能逃逸成
      // 未捕获异常 —— 那会让整条 SSE 流静默失效，而且追踪器自己看不到（它不在请求链路上）。
      try {
        traceHandleStreamItem(item);
      } catch (e) {
        reportClientLog({
          level: 'error', layer: 'frontend', kind: 'trace_stream_item_failed',
          message: `追踪流单帧处理失败：${e.message}`,
          error: e,
          context: { item_type: item && item.type, op_id: item && item.opId, end: 'stream-item' }
        });
      }
    };
    es.onerror = () => {
      // ⚠️ 重连策略只能有一条：自己重连。
      // 之前按 readyState 分叉（CONNECTING 时"交给浏览器自动重试"），但代码前面已经
      // es.close() 了 —— 连接被我们自己关掉，浏览器根本不会再自动重试，
      // 结果是「录制中」状态下既没有浏览器重连、也没有自己的重连：流永久死亡。
      try { es.close(); } catch (_) {}
      trace.stream = null;
      if (!trace.on) return;
      if (!trace.streamRetry) {
        trace.streamRetry = setTimeout(() => { trace.streamRetry = null; traceStartStream(); }, 3000);
      }
    };
  } catch (_) {
    trace.stream = null;
  }
}

function traceStopStream() {
  if (trace.streamRetry) { clearTimeout(trace.streamRetry); trace.streamRetry = null; }
  if (trace.stream) {
    try { trace.stream.close(); } catch (_) {}
    trace.stream = null;
  }
}

function traceHandleStreamItem(item) {
  if (!item || !item.type) return;
  if (item.type === 'op-start') {
    const existing = trace.ops.find((o) => o.opId === item.opId);
    if (!existing) {
      trace.ops.unshift({ opId: item.opId, title: item.title || '操作', nodes: [], summary: null, nodeCount: 0, updatedAt: Date.now() });
      trace.ops = trace.ops.slice(0, 200);
    }
  } else if (item.type === 'node' && item.node) {
    const op = trace.ops.find((o) => o.opId === item.opId);
    if (op) {
      if (!Array.isArray(op.nodes)) op.nodes = []; // 类型兜底：任何来源都不该让这一帧抛错
      // 列表级错误计数：摘要里的 errors 只代表「建摘要那一刻」的事实，
      // 收尾之后才到的 error 节点（真实会话里 blueprint-confirm 的 400、被取消的 harness 节点）
      // 不在其中，只信摘要会让「只看错误」筛选漏掉这些操作。
      op.nodes.push(item.node);
      op.nodeCount = op.nodes.length;
      op.updatedAt = Date.now();
    }
  } else if (item.type === 'op-end' && item.summary) {
    traceUpsertOp(item.summary);
  } else if (item.type === 'op-truncated') {
    const op = trace.ops.find((o) => o.opId === item.opId);
    if (op) op.truncated = true;
  } else if (item.type === 'session-end') {
    trace.sessionEnded = true;
  }
  traceMaybeRender();
}

/** 把服务端摘要整理成「可与本地操作对象安全合并」的形状。
 *
 * 后端摘要里的 `nodes` 是**节点数量**，而前端操作对象里的 `nodes` 是**节点数组**。
 * 直接 `{ ...op, ...summary }` 会让数组被计数覆盖成 number，随后
 * `traceHandleStreamItem` 的 `op.nodes.push(...)` 必抛
 * `TypeError: op.nodes.push is not a function`（每个会话稳定复现，实测最短间隔 10.2 秒）。
 * 这里统一改名：计数 → nodeCount，数组 → nodes，并保留本地已有节点，避免打开追踪页
 * 拉一次 /debug/ops 就把实时收到的节点清空。
 */
function normalizeTraceSummary(summary, existing) {
  if (!summary || typeof summary !== 'object') return {};
  const { nodes: nodeCount, ...rest } = summary;
  const prevNodes = Array.isArray(existing?.nodes) ? existing.nodes : [];
  return {
    ...rest,
    nodes: prevNodes,
    nodeCount: Number.isFinite(Number(nodeCount)) ? Number(nodeCount) : prevNodes.length
  };
}

function traceUpsertOp(summary) {
  if (!summary || !summary.opId) return;
  const idx = trace.ops.findIndex((o) => o.opId === summary.opId);
  if (idx >= 0) {
    const merged = normalizeTraceSummary(summary, trace.ops[idx]);
    trace.ops[idx] = { ...trace.ops[idx], ...merged, summary, updatedAt: Date.now() };
  } else {
    trace.ops.unshift({ ...normalizeTraceSummary(summary), summary, updatedAt: Date.now() });
    trace.ops = trace.ops.slice(0, 200);
  }
  traceMaybeRender();
}

function traceMaybeRender() {
  if (state.view !== 'trace') return;
  if (trace.renderTimer) return;
  trace.renderTimer = setTimeout(() => {
    trace.renderTimer = null;
    if (state.view === 'trace') renderTraceList();
  }, 320);
}

// ---------- 开关 ----------
function traceRenderTopbarButton() {
  const btn = $('#trace-toggle');
  if (!btn) return;
  btn.classList.toggle('recording', !!trace.on);
  btn.textContent = trace.on ? '● 录制中' : '🐞 运行追踪';
  btn.title = trace.on
    ? '正在记录每一次操作的代码运行路径；再次点击停止并保存'
    : '开始记录：你接下来的每一次操作跑了哪些代码、花了多久、调了什么 AI';
}

function traceStart() {
  if (trace.on) return;
  trace.opId = ''; trace.opNodes = [];
  trace.longOpId = ''; trace.longNodes = [];
  trace.toasts = []; trace.pending.clear();
  trace.ops = []; trace.ops.length = 0;
  if (trace.detailCache) trace.detailCache.clear();
  trace.detailOpId = '';
  trace.sessionEnded = false;
  trace.on = true;
  traceRenderTopbarButton();
  traceStartStream();
  trace.pingTimer = setInterval(() => {
    fetch('/api/debug/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
    if (trace.opId) traceFlushOp('done');
    if (trace.longOpId && Date.now() - trace.longLastAt > TRACE_LONG_IDLE_MS) traceFlushLong('done');
    traceSendPending();
  }, 10000);
  try { sessionStorage.setItem('ns_trace_on', '1'); } catch (_) { /* 忽略 */ }
}

async function traceStop() {
  if (!trace.on) return;
  // ⚠️ 顺序关键：先把在途操作/长流程冲洗出去（此时 trace.on 仍为 true，
  // traceFlushOp → traceSendOp → traceSendPending 的「未录制不发送」闸门才放行），再关录制。
  if (trace.pingTimer) { clearInterval(trace.pingTimer); trace.pingTimer = null; }
  if (trace.flushTimer) { clearTimeout(trace.flushTimer); trace.flushTimer = null; }
  if (trace.opId) traceFlushOp('done');
  if (trace.longOpId) traceFlushLong('done');
  traceSendPending();
  // 收尾兜底：pending 里若还有尚未发出的操作（例如停录瞬间在途请求补挂的），
  // 用 force 再冲一次，保证最后一批前端节点能到达后端内存（后端封卷闸门会兜住文件结构）。
  traceSendPending(true);
  trace.on = false;
  traceStopStream();
  traceRenderTopbarButton();
  try { sessionStorage.removeItem('ns_trace_on'); } catch (_) { /* 忽略 */ }
}

async function traceToggle() {
  if (trace.on) {
    await traceStop();
    try {
      const res = await api('/debug/stop', { method: 'POST', body: {} });
      const s = res.summary || {};
      toast(`运行追踪已停止：${s.ops || 0} 个操作 / ${s.nodes || 0} 个节点 / ${(s.prompt_tokens || 0) + (s.completion_tokens || 0)} tokens`, 'success');
    } catch (e) {
      toast('停止失败：' + e.message, 'error');
    }
    if (state.view === 'trace') await render();
    return;
  }
  try {
    const res = await api('/debug/start', { method: 'POST', body: { from: 'ui', work_id: state.workId || null } });
    trace.sessionId = res.session_id || '';
    traceStart();
    toast('运行追踪已开启：现在开始记录你的每一次操作', 'success');
  } catch (e) {
    toast('开启失败：' + e.message, 'error');
  }
  if (state.view === 'trace') await render();
}

/** 会话恢复：刷新页面后若后端仍在录制，自动接上（避免「界面显示未录制却一直在记」）。 */
async function traceRestore() {
  try {
    const st = await api('/debug/state');
    const s = st.state || {};
    if (s.recording) {
      trace.sessionId = s.session_id || '';
      traceStart();
    } else {
      traceRenderTopbarButton();
    }
  } catch (_) { /* 后端不可用时不阻塞界面 */ }
}

// ---------- 界面：🐞 运行追踪 ----------
const TRACE_KIND_LABELS = { fn: '函数', api: 'API', ai: 'AI', db: 'SQL', harness: '慢通道', ui: '界面', http: '外部', note: '标注', op: '操作' };

function fmtTraceTime(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch (_) {
    return String(ts || '');
  }
}

function fmtCost(ms) {
  const n = Math.round(Number(ms) || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n}ms`;
}

function traceOpSummary(op) {
  const s = op.summary || op;
  return {
    opId: op.opId || s.opId,
    title: s.title || op.title || '操作',
    status: s.status || 'running',
    cost_ms: s.cost_ms || 0,
    nodes: s.nodes ?? op.nodeCount ?? (op.nodes ? op.nodes.length : 0),
    // 错误数取「摘要值」与「本地实际收到的 error 节点数」的较大者：
    // 摘要只代表建摘要那一刻的事实，收尾之后才到的 error 节点不在其中
    //（真实会话里 blueprint-confirm 的 400、被取消的 harness 节点都是这种情况），
    // 只信摘要会让「只看错误」筛选漏掉这些操作。
    errors: Math.max(
      Number(s.errors) || 0,
      Array.isArray(op.nodes) ? op.nodes.filter((n) => n && n.status === 'error').length : 0
    ),
    truncated: !!(s.truncated || op.truncated),
    dropped_nodes: s.dropped_nodes || 0,
    prompt_tokens: s.prompt_tokens || 0,
    completion_tokens: s.completion_tokens || 0,
    ai_calls: s.ai_calls || 0,
    slowest: s.slowest || null,
    started_at: s.started_at || '',
    http_status: s.http_status,
    // 可信度标记：界面必须能区分「真跑了这么久」和「记录是补出来的」。
    auto_closed: !!(s.auto_closed || op.auto_closed),
    cost_untrusted: !!(s.cost_untrusted || op.cost_untrusted),
    tool_kinds: s.tool_kinds || 0
  };
}

function traceFilteredOps() {
  const f = trace.filters;
  return trace.ops.filter((op) => {
    const s = traceOpSummary(op);
    if (f.onlyError && !(s.errors > 0 || s.status === 'error')) return false;
    if (f.onlyAi && !(s.ai_calls > 0)) return false;
    if (f.slowMs > 0 && !(s.cost_ms >= f.slowMs)) return false;
    if (f.q && !String(s.title || '').toLowerCase().includes(f.q.toLowerCase())) return false;
    return true;
  });
}

function traceSessionTotals() {
  let ops = trace.ops.length;
  let nodes = 0;
  let errors = 0;
  let prompt = 0;
  let completion = 0;
  let aiCalls = 0;
  let truncated = 0;
  let autoClosed = 0;
  let untrusted = 0;
  for (const op of trace.ops) {
    const s = traceOpSummary(op);
    nodes += s.nodes || 0;
    errors += s.errors || 0;
    prompt += s.prompt_tokens || 0;
    completion += s.completion_tokens || 0;
    aiCalls += s.ai_calls || 0;
    if (s.truncated) truncated += 1;
    if (s.auto_closed) autoClosed += 1;
    if (s.cost_untrusted) untrusted += 1;
  }
  return { ops, nodes, errors, prompt, completion, aiCalls, truncated, autoClosed, untrusted };
}

function renderTraceList() {
  const listEl = $('#trace-list');
  if (!listEl) return;
  const ops = traceFilteredOps();
  const t = traceSessionTotals();
  const statsEl = $('#trace-stats');
  if (statsEl) {
    statsEl.textContent = `${t.ops} 个操作 · ${t.nodes} 个节点 · ${t.errors} 个错误 · ${t.aiCalls} 次 AI · ${t.prompt + t.completion} tokens${t.truncated ? ` · ${t.truncated} 个操作被截断` : ''}${t.autoClosed ? ` · ${t.autoClosed} 个自动收尾(耗时不代表业务耗时)` : ''}${t.untrusted ? ` · ${t.untrusted} 个耗时不可信` : ''}`;
  }
  if (!ops.length) {
    listEl.innerHTML = `<div class="empty">${trace.on ? '录制中：在界面上做任何操作，这里会实时出现调用链。' : '还没有记录。点上方「开始录制」，然后在界面上正常操作即可。'}</div>`;
    return;
  }
  listEl.innerHTML = ops.map((op) => {
    const s = traceOpSummary(op);
    const open = s.opId === trace.detailOpId;
    const tokens = s.prompt_tokens + s.completion_tokens;
    const badge = s.errors > 0 || s.status === 'error'
      ? '<span class="trace-badge err">有错误</span>'
      : (s.status === 'running' ? '<span class="trace-badge run">进行中</span>' : '');
    return `
      <div class="trace-op ${open ? 'open' : ''}" data-action="trace-open" data-id="${esc(s.opId)}">
        <div class="trace-op-head">
          <span class="trace-time">${fmtTraceTime(s.started_at)}</span>
          <span class="trace-title">${esc(s.title)}</span>
          ${badge}
          ${s.truncated ? `<span class="trace-badge warn" title="节点数超过上限，后续节点被丢弃">已截断(${s.dropped_nodes})</span>` : ''}
          ${s.auto_closed ? '<span class="trace-badge warn" title="这条操作没有正常收尾，是追踪器在空闲/停录时补的收尾记录：耗时与结束时间不代表业务真实耗时">⏱ 自动收尾</span>' : ''}
          ${s.cost_untrusted ? '<span class="trace-badge err" title="操作内存在跨时钟域算出的耗时（|耗时| 超过 1 天），本行耗时与「最慢节点」都不可用于性能判断">耗时不可信</span>' : ''}
          <span class="trace-grow"></span>
          ${tokens ? `<span class="trace-tokens" title="本次操作的 AI 用量">↑${s.prompt_tokens} ↓${s.completion_tokens} tok</span>` : ''}
          ${s.http_status ? `<span class="trace-http">HTTP ${s.http_status}</span>` : ''}
          <span class="trace-cost">${fmtCost(s.cost_ms)}</span>
          <span class="trace-nodes">${s.nodes} 节点</span>
          <span class="trace-caret">${open ? '▾' : '▸'}</span>
        </div>
        ${s.slowest ? `<div class="trace-slow" title="最慢节点">最慢：${esc(s.slowest.name)} ${fmtCost(s.slowest.cost_ms)}${s.slowest.file ? ' · ' + esc(String(s.slowest.file).split(/[\\/]/).pop()) + ':' + (s.slowest.line ?? '') : ''}</div>` : ''}
      </div>
      ${open ? `<div class="trace-detail" id="trace-detail">${renderTraceDetail(s.opId, op)}</div>` : ''}`;
  }).join('');
}

function renderTraceDetail(opId, op) {
  const cached = trace.detailCache.get(opId);
  const nodes = (cached && cached.nodes) || op.nodes || [];
  const tools = (cached && cached.tools) || null;
  if (!nodes.length) return '<div class="empty small">暂无节点明细（可能已被会话淘汰或尚未收到）</div>';
  const maxCost = nodes.reduce((m, n) => Math.max(m, Number(n.cost_ms) || 0), 1);
  const rows = nodes.map((n) => {
    const pct = Math.max(2, Math.round(((Number(n.cost_ms) || 0) / maxCost) * 100));
    const file = n.code && n.code.file ? String(n.code.file).split(/[\\/]/).pop() : '';
    const line = n.code && n.code.line ? `:${n.code.line}` : '';
    const fn = n.code && n.code.func ? n.code.func : '';
    const side = n.side === 'frontend' ? '前端' : '后端';
    const usage = n.usage ? `↑${n.usage.prompt_tokens} ↓${n.usage.completion_tokens} tok（${n.model || ''}${n.usage.prompt_cache_hit_tokens ? ` · 缓存命中 ${n.usage.prompt_cache_hit_tokens}` : ''}）` : '';
    const noUsage = n.usage_unavailable_reason ? `<span class="muted small">${esc(n.usage_unavailable_reason)}</span>` : '';
    const detail = {
      args: n.args, result: n.result, error: n.error, db: n.db, stack: n.stack,
      usage: n.usage, model: n.model, endpoint: n.endpoint, job_id: n.job_id, messages: n.args && n.args.messages
    };
    const hasDetail = Object.values(detail).some((v) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length));
    return `
      <div class="trace-node ${n.status === 'error' ? 'err' : ''} ${n.kind === 'ai' ? 'ai' : ''}">
        <span class="trace-node-side">${side}</span>
        <span class="trace-node-kind k-${esc(n.kind)}">${esc(TRACE_KIND_LABELS[n.kind] || n.kind)}</span>
        <span class="trace-node-name" title="${esc(n.name)}">${esc(n.name)}</span>
        <span class="trace-node-cost"><i style="width:${pct}%"></i><b>${fmtCost(n.cost_ms)}</b></span>
        ${file ? `<span class="trace-node-loc" title="${esc(n.code.file)}">📄 ${esc(file)}${line}${fn ? ' · ' + esc(fn) : ''}</span>` : ''}
        ${usage ? `<span class="trace-node-usage">${esc(usage)}</span>` : ''}
        ${noUsage}
        ${hasDetail ? `<details class="trace-node-detail"><summary>详情</summary><pre>${esc(JSON.stringify(detail, (k, v) => (v === undefined ? undefined : v), 2))}</pre></details>` : ''}
      </div>`;
  }).join('');
  const toolLine = tools && tools.length
    ? `<div class="trace-tools">高频工具函数（合并计数）：${tools.map((t) => `${esc(t.name)} ×${t.count} / ${fmtCost(t.cost_ms)}`).join(' · ')}</div>`
    : '';
  return `${toolLine}${rows}`;
}

async function loadTraceDetail(opId) {
  if (!opId) return;
  try {
    const data = await api(`/debug/op?op_id=${encodeURIComponent(opId)}`);
    trace.detailCache.set(opId, {
      nodes: data.nodes || [],
      tools: data.tool_calls ? Object.entries(data.tool_calls).map(([name, v]) => ({ name, count: v.count, cost_ms: v.costMs })) : null
    });
  } catch (_) {
    // 内存里没有 → 尝试从当前会话文件读
    try {
      const sessions = await api('/debug/sessions');
      const cur = (sessions.sessions || [])[0];
      if (cur) {
        const s = await api(`/debug/session?file=${encodeURIComponent(cur.file)}`);
        const found = (s.ops || []).find((o) => o.opId === opId);
        if (found) trace.detailCache.set(opId, { nodes: found.nodes || [], tools: null });
      }
    } catch (_) { /* 忽略 */ }
  }
  renderTraceList();
}

function renderTrace(content) {
  content.innerHTML = `
    <div class="trace-page">
      <div class="trace-toolbar">
        <button class="btn ${trace.on ? 'danger' : 'primary'}" data-action="trace-toggle">${trace.on ? '■ 停止录制' : '● 开始录制'}</button>
        <label class="trace-check"><input type="checkbox" id="trace-only-error" ${trace.filters.onlyError ? 'checked' : ''}> 只看有错误</label>
        <label class="trace-check"><input type="checkbox" id="trace-only-ai" ${trace.filters.onlyAi ? 'checked' : ''}> 只看含 AI</label>
        <select id="trace-slow-filter">
          <option value="0">全部耗时</option>
          <option value="100">≥ 100ms</option>
          <option value="500">≥ 500ms</option>
          <option value="2000">≥ 2s</option>
        </select>
        <input type="search" id="trace-q" placeholder="按操作名搜索…" value="${esc(trace.filters.q)}">
        <span class="trace-stats" id="trace-stats"></span>
      </div>
      <div class="trace-hint">
        录制中：你每一次点击/保存/AI 调用都会记录「跑了哪些代码、在哪一行、花了多久、调了什么 AI（tokens）」。
        <b>不记录正文内容</b>，长文本只记长度。慢通道（harness 子进程）只到任务级，Token 不可得。
      </div>
      <div class="trace-list" id="trace-list"></div>
      <div class="trace-tools-panel" id="trace-tools-panel" hidden></div>
      <div class="trace-sessions">
        <div class="trace-sessions-head">
          <b>历史录制</b>
          <button class="btn small" data-action="trace-sessions-refresh">刷新</button>
          <button class="btn small danger" data-action="trace-purge" title="删除全部录制文件">清空历史</button>
        </div>
        <div id="trace-sessions-list" class="trace-sessions-list"></div>
      </div>
    </div>`;
  const slowSel = $('#trace-slow-filter');
  if (slowSel) slowSel.value = String(trace.filters.slowMs || 0);
  renderTraceList();
  refreshTraceSessions();
  refreshTraceTools();
}

/** 会话级「高频函数累计表」：分层追踪里被合并计数的那部分（不逐条展开，但必须可见）。 */
async function refreshTraceTools() {
  const el = $('#trace-tools-panel');
  if (!el) return;
  try {
    const data = await api('/debug/ops');
    // 顺带补全操作列表：SSE 断线重连会丢事件，打开追踪页时从后端拉一次全量列表兜底。
    const serverOps = data.ops || [];
    if (serverOps.length) {
      for (const s of serverOps) {
        const idx = trace.ops.findIndex((o) => o.opId === s.opId);
        if (idx >= 0) {
          // 以服务端为准合并摘要；本地已收到的节点保留在 nodes 里供展开。
          const merged = normalizeTraceSummary(s, trace.ops[idx]);
          trace.ops[idx] = { ...trace.ops[idx], ...merged, summary: s, updatedAt: Date.now() };
        } else {
          trace.ops.unshift({ ...normalizeTraceSummary(s), summary: s, updatedAt: Date.now() });
        }
      }
      trace.ops = trace.ops.slice(0, 200);
      renderTraceList();
    }
    const tools = data.tools || [];
    if (!tools.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const total = tools.reduce((s, t) => s + t.count, 0);
    el.hidden = false;
    el.innerHTML = `
      <details class="trace-node-detail">
        <summary>高频函数累计（合并计数，不逐条展开）：${tools.length} 类 / 共 ${total} 次</summary>
        <pre>${esc(tools.map((t) => `${t.name}  ×${t.count}  合计 ${fmtCost(t.cost_ms)}`).join('\n'))}</pre>
      </details>`;
  } catch (_) {
    el.hidden = true;
  }
}

async function refreshTraceSessions() {
  const el = $('#trace-sessions-list');
  if (!el) return;
  try {
    const data = await api('/debug/sessions');
    const sessions = data.sessions || [];
    if (!sessions.length) {
      el.innerHTML = '<div class="muted small">暂无录制文件</div>';
      return;
    }
    el.innerHTML = sessions.map((s) => `
      <div class="trace-session-row">
        <span class="trace-session-file">${esc(s.file)}${s.current ? ' <span class="trace-badge run">当前</span>' : ''}</span>
        <span class="muted small">${(s.size / 1024).toFixed(1)} KB · ${fmtLogTime(s.mtime)}</span>
        <span class="trace-grow"></span>
        <button class="btn small" data-action="trace-open-session" data-file="${esc(s.file)}">查看摘要</button>
        <button class="btn small" data-action="trace-export-session" data-file="${esc(s.file)}">导出</button>
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<div class="muted small">读取失败：${esc(e.message)}</div>`;
  }
}

async function openTraceSession(file) {
  try {
    const s = await api(`/debug/session?file=${encodeURIComponent(file)}`);
    const ops = s.ops || [];
    trace.ops = ops.map((o) => ({ opId: o.opId, summary: o.summary, nodes: o.nodes || [], nodeCount: (o.nodes || []).length, updatedAt: Date.now() }));
    trace.detailCache.clear();
    trace.detailOpId = '';
    renderTraceList();
    const head = s.session_end || s.session_start || {};
    const sum = head.summary || {};
    toast(`已载入 ${file}：${ops.length} 个操作${sum.nodes ? ` / ${sum.nodes} 个节点` : ''}`, 'success');
  } catch (e) {
    toast('载入失败：' + e.message, 'error');
  }
}

async function exportTraceSession(file) {
  try {
    const s = await api(`/debug/session?file=${encodeURIComponent(file)}`);
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.replace(/\.jsonl$/, '') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出 ' + a.download, 'success');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}



async function renderWorks() {
  const content = $('#content');
  await loadWorks();
  const works = state.works;
  // F-30：示例状态缓存到 state，安装/删除时失效，避免每次渲染都请求 /demo/status。
  let demo = state.demoStatusLoaded ? state.demoStatus : null;
  if (!state.demoStatusLoaded) {
    try { demo = await api('/demo/status'); state.demoStatus = demo; } catch (_) { /* 旧服务端无此接口时静默 */ }
    state.demoStatusLoaded = true;
  }
  const demoExists = !!(demo && demo.exists);
  // D9：示例小说已在下方「🧪 示例小说」区块展示，作品列表里排除它，避免同一本书出现两次。
  // F-41：demo.work_id 可能是字符串，比较前 Number() 归一化，避免类型不一致导致示例书重复出现。
  const demoWorkId = demoExists && demo.work_id ? Number(demo.work_id) : null;
  const visibleWorks = demoWorkId ? works.filter((w) => w.id !== demoWorkId) : works;
  // 作品卡需要真实字数时才读章节正文；限制并发，避免作品库打开瞬间把所有长章节
  // 一起搬进内存。每张卡仍独立失败，不阻断其它作品。
  const queue = [...visibleWorks];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) await loadWorkMeta(queue.shift().id).catch(() => null);
  });
  await Promise.all(workers);
  const sortedWorks = [...visibleWorks].sort((a, b) => {
    const aTime = String(a.updated_at || a.created_at || '');
    const bTime = String(b.updated_at || b.created_at || '');
    return bTime.localeCompare(aTime);
  });
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">我的作品</h1>
        <div class="page-sub">最近编辑的作品排在前面，快速回到最近编辑章节继续写作</div>
      </div>
      <div class="page-actions">
        <input id="works-filter" class="works-filter" type="search" placeholder="筛选作品…" value="${esc(state.worksQuery)}" aria-label="筛选作品">
        <button class="btn secondary" data-action="import-work">📥 导入作品</button>
        <button class="btn" data-action="new-work">＋ 新建作品</button>
      </div>
      <input type="file" id="import-file" accept=".txt,.md,.epub" hidden>
    </div>
    ${visibleWorks.length ? '' : demoWorkId
      ? '<div class="empty">还没有你自己的作品：《雾都缝匠》是下方示例数据，可直接打开体验；点击右上角“新建作品”或在左侧「✨ AI 创作」用 AI 一键生成，开始你自己的创作。</div>'
      : '<div class="empty">还没有作品：可点击右上角“新建作品”手动创建，或在左侧「✨ AI 创作」用 AI 一键生成，也可导入下方示例小说体验。</div>'}
    ${sortedWorks.length ? `<div class="works-grid">
      ${sortedWorks.map((w, index) => {
        const meta = state.workMeta.get(Number(w.id)) || {};
        const status = workStatusLabel(w, meta);
        return `
        <article class="card work-card work-card-rich" data-work-search="${esc(`${w.title || ''} ${w.description || ''}`.toLowerCase())}"${state.worksQuery && !`${w.title || ''} ${w.description || ''}`.toLowerCase().includes(state.worksQuery.trim().toLowerCase()) ? ' hidden' : ''}>
          <div class="work-spine" aria-hidden="true"><span>${String(index + 1).padStart(2, '0')}</span></div>
          <div class="work-card-content">
            <div class="work-card-topline">
              <span class="work-status ${esc(status.cls)}">${esc(status.label)}</span>
              <span class="muted work-updated">${esc(formatWorkTime(w.updated_at || w.created_at))}</span>
            </div>
            <button class="work-card-main" data-action="open-work" data-id="${w.id}" aria-label="打开《${esc(w.title)}》">
              <h2 class="work-card-title">${esc(w.title)}</h2>
              <div class="desc">${esc(w.description || '暂无简介')}</div>
            </button>
            <div class="work-meta-row">
              <span>章节 <b>${Number.isFinite(Number(meta.chapters)) ? esc(meta.chapters) : '—'}</b></span>
              <span>字数 <b>${Number.isFinite(Number(meta.words)) ? esc(Number(meta.words).toLocaleString()) : '—'}</b></span>
            </div>
            <div class="work-recent"><span class="muted">最近编辑章节</span><b>${esc(meta.recentTitle || (meta.status === 'error' ? '信息暂不可用' : '尚未开始写作'))}</b></div>
            <div class="work-card-actions">
              <button class="btn" data-action="continue-work" data-id="${w.id}">${meta.recentId ? '继续写作' : '打开作品'}</button>
              <button class="btn small secondary" data-action="edit-work" data-id="${w.id}">编辑</button>
              <button class="btn small danger" data-action="delete-work" data-id="${w.id}">删除</button>
            </div>
          </div>
        </article>`;
      }).join('')}
    </div>` : ''}
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
    </div>
    <div class="card mt-12">
      <div class="card-head">
        <span class="card-title">🙏 借鉴与致谢</span>
        <span class="muted" style="font-size:12px">实际运行组件与设计参考的来源、作用、许可核验记录</span>
      </div>
      <div class="muted">本工坊实际运行的开源组件（DeepSeek Harness / OpenViking / 本地向量模型）、设计 / 方法参考来源，以及确实随仓库分发的资产。只写真实关系，不显示会过期的人气计数，也不暗示官方合作或背书。</div>
      <div style="margin-top:10px"><button class="btn small secondary" data-action="go-view" data-view="thanks">查看详情</button></div>
    </div>`;
}

// ---------- 首页：借鉴与致谢（R06） ----------
// 事实与许可核验记录同步维护在 `THIRD-PARTY-NOTICES.md` 与本数组（核验日期 2026-09-27，上游 commit 见卡片）。
// 写卡纪律（任务书 §9/§16）：设计参考就写“设计参考”，没引入代码就不暗示“已集成”，也不声称“完全不含某项目源码”
// （只写本轮实际做过的来源检索范围）；不显示随时过期的 stars；不暗示官方合作/背书；外链一律 noopener noreferrer。
const ATTRIBUTIONS = [
  {
    group: '实际运行组件（工坊真的在用）',
    note: '这些组件不随本仓库分发，安装与使用遵循它们各自的许可证；版本以你本机实际安装/连接为准。',
    cards: [
      {
        name: 'DeepSeek Harness（dsh）',
        role: '创作内核宿主：需要 Agent / 工具循环的任务由它执行',
        here: '「AI 设置 → 创作内核」中，需要 Agent / Tool Loop 的任务通过 DSH 执行；原有轻量直连路径继续由工坊现有 AI Client 执行，具体路由由现有 AI 策略决定。小说 bundle 通过 DSH/Cordis 原生插件机制注册人设、规则与工具',
        status: '实际运行；本机核验版本 0.1.7-rc.1（上游 master 当前 0.1.7-rc.2，实际以本机安装为准）',
        license: 'MIT · deepseek-ai/deepseek-harness · 本机版本 0.1.7-rc.1；第三方依赖另见其上游 THIRD_PARTY_NOTICES',
        url: 'https://github.com/deepseek-ai/deepseek-harness',
      },
      {
        name: 'OpenViking',
        role: '语义记忆与检索后端：作品派生资源、语义召回与 DSH 会话记忆',
        here: '宿主将已确认作品资料通过现有同步链投影为 OpenViking 资源，并把限定范围的语义召回结果送入上下文；DSH 侧另通过实际启用的 OpenViking memory bundle 管理会话记忆。正式正文、作者维护的长期记忆与 Canon Story State 仍以工坊宿主数据为准',
        status: '实际运行组件；可用性与作品/会话隔离以工坊自检和运行证据为准',
        license: '以本机实际安装版本为准；当前上游主项目为 AGPL-3.0（volcengine/OpenViking，默认分支 main，核验 2026-09-27），部分子组件许可证不同',
        url: 'https://github.com/volcengine/OpenViking',
      },
      {
        name: '本地向量模型 bge-small-zh-v1.5（GGUF）',
        role: '中文向量化（512 维），供记忆库检索使用',
        here: '随仓库分发在 vendor/ 目录，由记忆库侧的 llama.cpp 加载',
        status: '随本仓库原样分发（字节数与 SHA256 见 THIRD-PARTY-NOTICES.md §1）',
        license: 'MIT（BAAI/bge-small-zh-v1.5 模型卡）；实际随仓库分发的是 CompendiumLabs 的 GGUF 转换件——原模型与转换件两处来源均在 THIRD-PARTY-NOTICES.md §1 记录',
      },
    ],
  },
  {
    group: '设计 / 方法参考（借用思路；本轮来源审计未发现直接引入其源码）',
    note: '以下项目是本轮功能需求与设计的方法来源。工坊内的对应实现为本项目自行编写；这些项目多为 GPL/AGPL，按任务书约定不复制其实现或大段文本。',
    cards: [
      {
        name: 'SillyTavern',
        role: '角色卡 / 世界书 / 作者注的组织方式',
        here: '「创作上下文」页：角色卡（人设、对话示例、系统提示）、世界观词条、作品与章节作者注',
        status: '设计参考（本轮来源审计未发现直接引入其源码；该页与 SillyTavern 本体无关，无需安装它）',
        license: 'AGPL-3.0 · 核验 2026-09-27 · SillyTavern/SillyTavern @ 06bde939fb1e（默认分支 release）· LICENSE',
        url: 'https://github.com/SillyTavern/SillyTavern',
      },
      {
        name: 'Humanizer',
        role: '表达问题识别、保留原意、作者样文、修改后复查',
        here: 'R07 三档编辑（轻度润色 / 去 AI 腔 / 深度修稿）的编辑保护规则与「七项能力」规则包',
        status: '设计参考（规则文本为本项目自行撰写，非上游摘抄）',
        license: 'MIT · 核验 2026-09-27 · blader/humanizer @ 9862685f575c（默认分支 main）· LICENSE',
        url: 'https://github.com/blader/humanizer',
      },
      {
        name: 'InkOS',
        role: '语义审稿、三级意图、未来候选、协同提交',
        here: 'R07 结构化审稿建议、R09 三级作者意图、R11 分支沙盘与「采用只形成候选」纪律',
        status: '设计参考（本轮来源审计未发现直接引入其源码）',
        license: 'AGPL-3.0-only · 核验 2026-09-27 · Narcooo/inkos @ 8fc2ae57080b（默认分支 master；该仓库 package 声明 AGPL-3.0-only）· LICENSE',
        url: 'https://github.com/Narcooo/inkos',
      },
      {
        name: 'webnovel-writer v8',
        role: '候选 / 正式内容边界、流程纪律、可恢复投影',
        here: 'R03 整次采纳原子事务与投影 outbox、R04 replay/rebuild、R08 分片候选与覆盖清单',
        status: '设计参考（本轮来源审计未发现直接引入其源码）',
        license: 'GPL-3.0 · 核验 2026-09-27 · lingfengQAQ/webnovel-writer v8 @ b226c87b36743492f1ba2ec38bef66568259a903 · LICENSE',
        url: 'https://github.com/lingfengQAQ/webnovel-writer',
      },
      {
        name: 'Oh Story',
        role: '按时点的知识披露、有限上下文、小说导入分析、题材方法',
        here: 'R10 读者已披露派生视图、R12 导入后的分批分析与确认后原子应用、R07 题材档',
        status: '设计参考（本轮来源审计未发现直接引入其源码）',
        license: 'MIT · 核验 2026-09-27 · zenstory-ai/oh-story-claudecode @ 4a50d5583590（默认分支 main）· LICENSE',
        url: 'https://github.com/zenstory-ai/oh-story-claudecode',
      },
    ],
  },
  {
    group: '实际引入的代码 / 规则 / 资产（真的在本仓库里）',
    note: '这一组只列确实随本仓库分发或由本项目编写的内容；没有引入的东西不会写在这里。',
    cards: [
      {
        name: '编辑规则与能力规则文本（R07）',
        role: '规则 / 提示词资产',
        here: '编辑保护规则、三档编辑、七项能力与题材档（本项目自行撰写；由宿主设置与 DSH bundle 一起消费）',
        status: '按本轮来源审计，未发现直接复制上述参考项目源码或大段规则文本；R07 规则由本项目结合自身架构编写',
        license: '本项目 MIT',
      },
      {
        name: '向量模型文件 vendor/models/bge-…-f16.gguf',
        role: '检索用向量模型（唯一随仓库分发的第三方二进制资产）',
        here: '记忆库检索；校验命令 node scripts/fetch-embedding-model.mjs --verify-only',
        status: '原样分发，字节与 SHA256 记录在 THIRD-PARTY-NOTICES.md §1',
        license: 'MIT（模型卡）；转换件来源 CompendiumLabs/bge-small-zh-v1.5-gguf',
      },
      {
        name: '上游源码检索结论',
        role: '来源核验记录（不是资产）',
        here: '本轮以仓库全文检索（SillyTavern / humanizer / inkos / webnovel / oh-story 等关键词）未发现上述参考项目的源码文件或大段文本；关键词检索是辅助证据，不能绝对排除改名 / 去项目名 / 翻译 / 拆分文件后的复制',
        status: '结论仅覆盖本轮检索范围与检索日期；如需更强结论需做逐文件来源比对；后续若引入上游规则文本，必须在此更新许可',
        license: '—',
      },
    ],
  },
];

function renderThanks(content) {
  const card = (c) => `
    <div class="card">
      <div class="card-title">${esc(c.name)}</div>
      <div class="desc">${esc(c.role)}</div>
      <div class="muted" style="font-size:12px;margin-top:8px">工坊中的对应实现：${esc(c.here)}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">状态：${esc(c.status)}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">许可：${esc(c.license)}</div>
      ${c.url ? `<div style="margin-top:10px"><a class="btn small secondary" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">打开上游仓库 ↗</a></div>` : ''}
    </div>`;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🙏 借鉴与致谢</h1>
        <div class="page-sub">本工坊实际用到的开源组件、设计参考与方法来源（许可核验日期 2026-09-27）</div>
      </div>
      <div class="page-actions"><button class="btn secondary" data-action="go-view" data-view="works">← 返回我的作品</button></div>
    </div>
    <div class="muted" style="margin:6px 0 12px">
      这里区分三类关系：<b>实际运行组件</b>（工坊真的在调用）、<b>设计 / 方法参考</b>（借用思路，未搬运代码）、
      <b>实际引入的代码 / 规则 / 资产</b>（真的在本仓库里）。不显示随时会过期的人气计数，也不表示与任何项目存在官方合作或背书。
    </div>
    ${ATTRIBUTIONS.map((g) => `
      <div class="card mt-12">
        <div class="card-head"><span class="card-title">${esc(g.group)}</span></div>
        <div class="muted" style="font-size:12px">${esc(g.note)}</div>
        <div class="grid cols-3" style="margin-top:10px">${g.cards.map(card).join('')}</div>
      </div>`).join('')}`;
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
        ${fieldHelp('plotline_vs_outline')}
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
// AI 创作已迁移到初始页（见 renderAICreateHome / renderAIHome）。
// 2026-09-30（T6）：原先「创作上下文」一页里塞着编辑规则 / 作者样文 / 故事状态 / 剧情分支 /
// 导入重建五块内容，且打开一次要同时加载五份数据。现在拆成**同级独立页面**：
// 每页有稳定 route key、独立 load / render / 空态 / 错误态，刷新（sessionStorage）后回到原页；
// 旧路由键 `st` 保留为「创作上下文」的兼容别名（旧会话、旧链接、旧帮助锚点不失效）。
const AI_TABS = [
  ['ai', '⚙️ AI 设置'],
  ['st', '🧩 创作上下文'],
  ['rules', '📐 编辑规则'],
  ['style', '🖋️ 作者样文与文风'],
  ['story-state', '🧭 故事状态与披露'],
  ['branch', '🌿 剧情分支沙盘'],
  ['rebuild', '📥 导入后重建']
];
const AI_BOARD_TABS = AI_TABS.map(([key]) => key);

async function renderAIBoard(content, tab) {
  if (!AI_BOARD_TABS.includes(tab)) tab = 'ai';
  state.aiTab = tab;
  state.view = 'ai-board';
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🤖 AI创造板块</h1>
        <div class="page-sub">各页面独立加载：打开一页不会连带读取其余页面</div>
      </div>
    </div>
    <div class="board-tabs">
      ${AI_TABS.map(([key, label]) => `<button class="board-tab ${tab === key ? 'active' : ''}" data-action="board-tab" data-board="ai" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <div id="board-content" class="board-content"></div>`;
  const target = $('#board-content');
  switch (tab) {
    case 'ai': return renderAI(target);
    case 'st': return renderST(target);
    case 'rules': return renderEditRulesPage(target);
    case 'style': return renderAuthorStylePage(target);
    case 'story-state': return renderStoryStatePage(target);
    case 'branch': return renderBranchPage(target);
    case 'rebuild': return renderRebuildPage(target);
    default: return renderAI(target);
  }
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
      <div class="card stat-card"><div class="num">${stats.chapters ?? 0}</div><div class="label">章节/场景</div></div>
      <div class="card stat-card"><div class="num">${stats.terms ?? 0}</div><div class="label">设定词条</div></div>
      <div class="card stat-card"><div class="num">${stats.characters ?? 0}</div><div class="label">角色</div></div>
      <div class="card stat-card"><div class="num">${stats.plotlines ?? 0}</div><div class="label">剧情线</div></div>
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
          <h3 style="margin:0">剧情线 ${helpDot('plotline')}</h3>
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

// F-12/F-27：一次 O(N) 预构建章节索引（parentId→children 与 volumeId→根章节），
// 渲染时 O(1) 查询，避免每节点对 state.chapters 全量 filter 造成 O(N²)。
function buildChapterIndex() {
  const byParent = new Map(); // parentId(或null) -> [chapters]
  const rootsOfVolume = new Map(); // volumeId(或null) -> [根章节]
  for (const c of state.chapters) {
    const p = c.parent_id || null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(c);
    if (!c.parent_id) {
      const v = c.volume_id || null;
      if (!rootsOfVolume.has(v)) rootsOfVolume.set(v, []);
      rootsOfVolume.get(v).push(c);
    }
  }
  return { byParent, rootsOfVolume };
}

function renderOutlineList(content) {
  const volumes = state.volumes;
  const { byParent, rootsOfVolume } = buildChapterIndex();
  const childrenOf = (parentId) => byParent.get(parentId || null) || [];
  const rootsOfVolumeFn = (vid) => rootsOfVolume.get(vid) || [];
  const unassigned = rootsOfVolume.get(null) || [];
  const renderNode = (c, depth = 0) => `
    <li>
      <div class="tree-item" data-action="open-chapter" data-id="${c.id}" style="padding-left:${8 + depth * 14}px">
        <span>📄</span> <span class="grow">${esc(c.title)}</span>
        <span class="muted" style="font-size:12px">${chapterWordCount(c)}字</span>
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
          ${rootsOfVolumeFn(v.id).length ? rootsOfVolumeFn(v.id).map((c) => renderNode(c)).join('') : '<li class="muted" style="padding:6px 10px">本卷还没有章节</li>'}
        </ul>
      </div>
    `).join('') : '<div class="empty">还没有卷。可以创建卷来组织大纲。</div>'}
    <div class="card">
      <div class="card-head"><span class="card-title">未分卷章节</span><button class="btn small" data-action="new-chapter">＋ 新建</button></div>
      <ul class="tree">${unassigned.length ? unassigned.map((c) => renderNode(c)).join('') : '<li class="muted" style="padding:6px 10px">暂无未分卷章节</li>'}</ul>
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
              <span class="muted" style="font-size:12px">${chapterWordCount(c)}字</span>
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
        <h1 class="page-title">大纲 ${helpDot('outline')}</h1>
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
  setTopbarTitle(state.work ? state.work.title : '作品');
  // F-27：预构建索引，避免每个卷/未分卷节点都全量 filter chapters（O(N²)→O(N)）。
  const { rootsOfVolume } = buildChapterIndex();
  const rootsOfVolumeFn = (vid) => rootsOfVolume.get(vid) || [];
  const unassigned = rootsOfVolume.get(null) || [];

  const treeHTML = `
    <div class="row mb-8">
      <b>目录 / 大纲</b>
      <div class="grow"></div>
      <button class="btn small" data-action="new-chapter">＋</button>
    </div>
    ${volumes.length ? volumes.map((v) => `
      <div class="muted" style="padding:6px 8px">📚 ${esc(v.title)}</div>
      <ul class="tree">
        ${rootsOfVolumeFn(v.id).length ? rootsOfVolumeFn(v.id).map((c) => `
          <li><div class="tree-item ${current && current.id === c.id ? 'active' : ''}" data-action="open-chapter" data-id="${c.id}">📄 ${esc(c.title)}</div></li>
        `).join('') : '<li class="muted" style="padding:2px 8px">空</li>'}
      </ul>
    `).join('') : ''}
    <div class="muted" style="padding:6px 8px">未分卷</div>
    <ul class="tree">
      ${unassigned.map((c) => `
        <li><div class="tree-item ${current && current.id === c.id ? 'active' : ''}" data-action="open-chapter" data-id="${c.id}">📄 ${esc(c.title)}</div></li>
      `).join('') || '<li class="muted" style="padding:2px 8px">暂无章节</li>'}
    </ul>`;

  content.innerHTML = `
    <div class="writing-head page-head">
      <div>
        <div class="writing-breadcrumb"><span>写作台</span><span aria-hidden="true">/</span><b>${esc(current ? current.title : '未选择章节')}</b></div>
        <div class="page-sub">正文保存与故事状态分开显示；参考资料按需展开</div>
      </div>
      <div class="page-actions">
        <div class="row" style="gap:4px">
          <button class="btn small ${state.editorLayout === 'single' ? '' : 'secondary'}" data-action="set-layout" data-layout="single">单栏</button>
          <button class="btn small ${state.editorLayout === 'two' ? '' : 'secondary'}" data-action="set-layout" data-layout="two">两栏</button>
          <button class="btn small ${state.editorLayout === 'three' ? '' : 'secondary'}" data-action="set-layout" data-layout="three">三栏</button>
        </div>
        <button class="btn small secondary" data-action="focus-mode">专注模式</button>
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
            <button class="btn small" data-action="toolbar-ai-write"${helpTitle('slow_channel')}>✍️ AI 写作</button>
            <button class="btn small secondary" data-action="toolbar-ai-polish"${helpTitle('direct_channel')}>✨ 润色</button>
            <button class="btn small secondary" data-action="toolbar-ai-expand"${helpTitle('direct_channel')}>📖 扩写</button>
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
        <div id="chapter-recovery">${recoveryBarHtml(current)}</div>
        <div id="editor-content" class="editor-content" contenteditable="true" data-chapter-id="${current.id}">${sanitizeEditorHtml(editorDraftHtmlFor(current))}</div>
        <div class="editor-status" id="editor-status"><span>已加载</span> · <span id="editor-count">${wordCount(current.content)}</span> 字</div>
        <div id="chapter-state-panel" class="chapter-state-panel" data-chapter-id="${current.id}" data-boundary="after"><div class="muted">正在读取本章状态…</div></div>
      </div>
      <div class="panel panel-reference">
        <div class="reference-tabs reference-groups">
          <button class="active" data-action="ref-tab" data-tab="terms">参考</button>
          <button data-action="ref-tab" data-tab="context"${helpTitle('context_preview')}>上下文</button>
          <button data-action="ref-tab" data-tab="ai">AI 工具</button>
          <span class="grow"></span>
          <button class="btn small secondary" data-action="ref-preview-toggle" title="展开/收起设定词条的内容预览">${state.refPreview ? '收起预览' : '展开预览'}</button>
        </div>
        <div class="reference-subtabs" aria-label="参考类别">
          <button class="active" data-action="ref-tab" data-tab="terms">设定</button>
          <button data-action="ref-tab" data-tab="characters">角色</button>
          <button data-action="ref-tab" data-tab="foreshadows"${helpTitle('event_ledger')}>伏笔</button>
          <button data-action="ref-tab" data-tab="redlines"${helpTitle('redline')}>红线</button>
        </div>
        <div class="reference-list" id="reference-list"></div>
      </div>
    </div>
    `}`;
  if (current) {
    renderReference('terms');
    bindEditorEvents();
    // T6：章末状态面板独立异步加载（不阻塞编辑器；迟到响应由 seq 防护拦下）。
    refreshChapterStatePanel(current.id);
  }
}

function bindEditorEvents() {
  const editor = $('#editor-content');
  if (!editor) return;
  const beginComposition = () => setEditorComposition(true);
  const endComposition = () => setEditorComposition(false);
  editor.addEventListener('compositionstart', beginComposition);
  editor.addEventListener('compositionend', endComposition);
  const title = $('#editor-title');
  if (title) {
    title.addEventListener('input', scheduleSave);
    title.addEventListener('compositionstart', beginComposition);
    title.addEventListener('compositionend', endComposition);
  }
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

// ---------- T6：章末状态面板（正文编辑区域之外；不进入正文导出与字数统计） ----------
// 数据一律读真实后端时态状态（GET /novel/state/panel）；本次不缓存跨章结果。
// 竞态防护：每次加载带自增 seq，只有最新一次请求允许写 DOM（快速切章不会把 A 章状态画到 B 章）。
const PANEL_VALIDITY_LABEL = { valid: '已确认（正式稿）', pending: '待确认（候选稿）', stale: '待验证', conflict: '冲突', missing: '无历史绑定', blocked: '被截断', needs_review: '待复核', superseded: '已被新稿取代', no_commit: '尚无提交' };
const PANEL_ROLE_LABEL = { action: '实际行动', dialogue: '对话', mention: '提及', memory: '回忆', recollection: '回忆', flashback: '回忆' };
// 提案组状态：分析中 / 未分析 / 失败必须有独立文案，不能都显示成"暂无"。
const PANEL_PROPOSAL_LABEL = { running: '分析中', pending: '未分析', done: '已分析（待你确认）', failed: '分析失败', not_run: '未运行（无模型）' };

/** 章节标题（面板/影响/重建共用；找不到时回退 #id，绝不猜内容）。 */
function chapterTitleOfId(id) {
  const c = state.chapters.find((x) => Number(x.id) === Number(id));
  return c ? c.title : `#${id}`;
}

async function refreshChapterStatePanel(chapterId, { boundary = 'after', force = false } = {}) {
  const panel = typeof document !== 'undefined' ? document.getElementById('chapter-state-panel') : null;
  if (!panel) return;
  const cid = Number(chapterId) || Number(panel.dataset.chapterId) || 0;
  if (!cid) { panel.innerHTML = '<div class="muted">先在左侧选择一个章节。</div>'; return; }
  const sameTarget = state.chapterPanel && Number(state.chapterPanel.chapter_id) === cid && state.chapterPanel.boundary === boundary;
  if (force || !sameTarget) {
    state.chapterPanel = null;
    state.chapterPanelFull = null;
    state.chapterProposals = null;
    state.chapterPanelView = state.chapterPanelView || 'cast';
  }
  const seq = ++state.chapterPanelSeq;
  panel.dataset.chapterId = String(cid);
  panel.dataset.boundary = boundary;
  if (!state.chapterPanel) panel.innerHTML = '<div class="muted">正在读取本章状态…</div>';
  const wantFull = state.chapterPanelView === 'all';
  try {
    const view = await api(`/novel/state/panel?work_id=${state.workId}&chapter_id=${cid}&boundary=${boundary}${wantFull ? '&full=1' : ''}`);
    if (seq !== state.chapterPanelSeq) return; // 迟到的旧响应：丢弃，不画到当前章
    state.chapterPanel = view;
    if (wantFull && view && view.full_state) state.chapterPanelFull = view.full_state;
  } catch (e) {
    if (seq !== state.chapterPanelSeq) return;
    state.chapterPanel = { ok: false, enabled: true, error: String((e && e.message) || e), chapter_id: cid, boundary };
  }
  try {
    const groups = await api(`/novel/state/proposal-groups?work_id=${state.workId}&chapter_id=${cid}`);
    if (seq !== state.chapterPanelSeq) return;
    state.chapterProposals = groups;
  } catch (_) {
    state.chapterProposals = null; // 接口不可用：面板如实少显示这一块，不冒充"没有待确认"
  }
  if (seq !== state.chapterPanelSeq) return;
  panel.innerHTML = chapterPanelHtml();
}

async function setChapterPanelView(view) {
  const next = ['cast', 'visible', 'all'].includes(view) ? view : 'cast';
  const changed = state.chapterPanelView !== next;
  state.chapterPanelView = next;
  const panel = typeof document !== 'undefined' ? document.getElementById('chapter-state-panel') : null;
  if (panel) panel.innerHTML = chapterPanelHtml();
  if (next === 'all' && !state.chapterPanelFull) {
    const cid = state.chapterPanel ? Number(state.chapterPanel.chapter_id) : Number(state.currentChapterId) || 0;
    if (cid) await refreshChapterStatePanel(cid, { boundary: (state.chapterPanel && state.chapterPanel.boundary) || 'after' });
  } else if (changed && panel) {
    panel.innerHTML = chapterPanelHtml();
  }
}

function panelEvidenceHtml(evidence) {
  const list = Array.isArray(evidence) ? evidence.filter((x) => x && x.quote) : [];
  if (!list.length) return '';
  return `<div class="muted" style="font-size:12px">原文证据：${list.slice(0, 2).map((x) => `“${esc(String(x.quote).slice(0, 60))}”<button class="btn small secondary" data-action="panel-jump" data-quote="${esc(String(x.quote))}" title="在正文里定位这段证据">定位</button>`).join('；')}</div>`;
}

/** 证据定位：在正文编辑器里选中并滚动到证据引文；找不到就如实提示，不做假跳转。 */
function jumpToEvidence(quote) {
  const q = String(quote || '').trim();
  if (!q) { toast('该证据没有可定位的引文', 'error'); return; }
  const editor = typeof document !== 'undefined' ? document.getElementById('editor-content') : null;
  if (!editor || typeof editor.querySelectorAll !== 'function') { toast('当前不在正文编辑视图，无法定位证据', 'error'); return; }
  let hit = null;
  for (const node of Array.from(editor.querySelectorAll('p, li, blockquote, div, h2, h3'))) {
    if (node && node.children && node.children.length) continue;
    if (String(node.textContent || '').includes(q)) { hit = node; break; }
  }
  if (!hit) { toast('当前正文里没有找到这段证据（正文可能已被修改或尚未加载）', 'error'); return; }
  try {
    if (typeof window !== 'undefined' && window.getSelection && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(hit);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (_) { /* 选择失败不阻塞定位 */ }
  if (typeof hit.scrollIntoView === 'function') hit.scrollIntoView({ block: 'center' });
}

function chapterStateListHtml(fullState) {
  const rows = Object.entries(fullState || {}).map(([key, value]) => {
    let cell = null;
    try { cell = JSON.parse(key); } catch { cell = null; }
    const [domain, entityId, predicate, scope, holderId] = Array.isArray(cell) ? cell : ['unknown', key, '', '', null];
    return { domain: String(domain), entityId: String(entityId), predicate: String(predicate), scope: String(scope), holderId, value };
  });
  const byDomain = new Map();
  for (const r of rows) { if (!byDomain.has(r.domain)) byDomain.set(r.domain, []); byDomain.get(r.domain).push(r); }
  const show = (v) => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  return [...byDomain.entries()].map(([domain, list]) => `
    <div class="mt-8"><b style="font-size:13px">${esc(domain)}（${list.length}）</b>
      ${list.slice(0, 40).map((r) => `<div class="muted" style="font-size:12px">${esc(r.entityId)}${r.holderId ? `（持有：${esc(String(r.holderId))}）` : ''} · ${esc(r.predicate)} = ${esc(show(r.value).slice(0, 120))}</div>`).join('')}
      ${list.length > 40 ? `<div class="muted" style="font-size:12px">…其余 ${list.length - 40} 条（导出/接口可见）</div>` : ''}
    </div>`).join('') || '<div class="muted">（无状态条目）</div>';
}

function chapterPanelHtml() {
  const p = state.chapterPanel;
  if (!p) return '<div class="muted">正在读取本章状态…</div>';
  if (p.enabled === false) {
    return `<div class="muted">该作品未开启时态故事状态引擎：可在「🧭 故事状态与披露」页开启（开启后新保存的章节才会建立历史状态）。</div>`;
  }
  if (p.error || p.ok === false) {
    return `<div class="redline-scan warn">本章状态读取失败：${esc(String(p.error || p.reason || '未知原因'))}。为避免误导，这里不显示推测内容。</div>`;
  }
  const boundary = String(p.boundary || 'after');
  const validity = String(p.binding_validity || 'missing');
  const label = PANEL_VALIDITY_LABEL[validity] || validity;
  const trustedText = p.trusted ? `可信前缀：截至第 ${Number(p.verified_through || 0) + 1} 章` : '可信前缀：未建立（本章或前文还有未确认内容）';
  const chapterNo = (() => { const c = state.chapters.find((x) => Number(x.id) === Number(p.chapter_id)); return c ? c.title : `#${p.chapter_id}`; })();
  const characters = Array.isArray(p.characters) ? p.characters : [];
  const inChapter = characters.filter((c) => c.in_chapter);
  const relations = Array.isArray(p.relations) ? p.relations : [];
  const plotlines = Array.isArray(p.plotlines) ? p.plotlines : [];
  const changes = Array.isArray(p.changes) ? p.changes : [];
  const view = state.chapterPanelView;
  const rows = view === 'cast' ? inChapter : characters;
  const charCard = (c) => {
    const myChanges = changes.filter((x) => String(x.entity_id) === String(c.entity_id));
    const fmtSide = (v, opType, missing) => {
      if (missing) return '（此前未登记）';
      if (v === null || v === undefined) return opType === 'unset' ? '（清除）' : '（空）';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    };
    return `<div class="st-character-item">
      <div class="row"><b>${esc(String(c.entity_id))}</b>
        ${c.in_chapter ? '<span class="chip">本章出场</span>' : ''}
        <span class="muted" style="font-size:12px">${esc(String(c.status || ''))}${c.location ? `｜${esc(String(c.location))}` : ''}</span>
      </div>
      ${myChanges.map((x) => `<div style="font-size:12px">${esc(fmtSide(x.from, x.type, x.from_missing))} → <b>${esc(fmtSide(x.to, x.type, false))}</b>（${esc(String(x.predicate || ''))}）</div>${panelEvidenceHtml(x.evidence)}`).join('')}
    </div>`;
  };
  const appearanceRows = (p.appearances || []).map((a) => {
    const role = a.role || a.kind || a.type;
    const roleLabel = role ? (PANEL_ROLE_LABEL[String(role)] || String(role)) : '出场';
    return `<div class="st-character-item"><div class="row"><b>${esc(String(a.name || a.entity_id || ''))}</b><span class="chip">${esc(roleLabel)}</span>${a.scene_index !== undefined && a.scene_index !== null ? `<span class="muted" style="font-size:12px">场景 ${esc(String(a.scene_index))}</span>` : ''}</div>${panelEvidenceHtml(a.evidence)}</div>`;
  }).join('');
  const relRows = relations.filter((r) => view !== 'cast' || r.related_in_chapter).slice(0, 20)
    .map((r) => `<div class="muted" style="font-size:12px">${esc(String(r.from))} ↔ ${esc(String(r.to))}：${esc(String(r.label || ''))}${r.description ? `（${esc(String(r.description).slice(0, 60))}）` : ''}</div>`).join('');
  const plotRows = plotlines.filter((x) => view !== 'cast' || x.touched_in_chapter).slice(0, 20)
    .map((x) => `<div class="muted" style="font-size:12px">${esc(String(x.entity_id))}：${esc(String(x.state || '（未登记状态）'))}${x.summary ? `｜${esc(String(x.summary).slice(0, 60))}` : ''}</div>`).join('');
  const proposals = (state.chapterProposals && Array.isArray(state.chapterProposals.proposals)) ? state.chapterProposals.proposals : null;
  // 服务端 listProposalGroups 只返回 pending 绑定（即"尚未确认"）；这里再排除仍在分析中的组，
  // 避免确认按钮出现在分析未完成的组上（半成品不得被确认）。
  const pendingProposals = proposals ? proposals.filter((x) => String(x.status || '') !== 'running') : [];
  const proposalHtml = proposals === null
    ? ''
    : (proposals.length ? `
      <div class="mt-8">
        <b style="font-size:13px">本章待确认提案（${proposals.length}）</b>
        <div class="muted" style="font-size:12px">候选值不会渲染成正式值；确认后才进入正式状态并触发下游复核。</div>
        ${proposals.map((g) => `<div class="st-character-item"><div class="row"><span class="chip">${esc(PANEL_PROPOSAL_LABEL[String(g.status || 'pending')] || String(g.status || 'pending'))}</span><span class="muted" style="font-size:12px">事件 ${esc(String((g.proposal || {}).events ?? 0))} · 操作 ${esc(String((g.proposal || {}).ops ?? 0))}｜${esc(String(((g.analysis || {}).provider) || '未分析'))}</span></div></div>`).join('')}
        ${pendingProposals.length ? '<div class="mt-8"><button class="btn small" data-action="panel-confirm-proposals">一次确认本章提案</button></div>' : ''}
      </div>` : '<div class="muted mt-8" style="font-size:12px">本章没有待确认提案（旧稿已确认或尚未分析）。</div>');
  const tabs = `<div class="row mt-8" style="gap:6px;flex-wrap:wrap">
    <button class="btn small ${view === 'cast' ? '' : 'secondary'}" data-action="panel-view" data-view="cast">本章出场（${inChapter.length}）</button>
    <button class="btn small ${view === 'visible' ? '' : 'secondary'}" data-action="panel-view" data-view="visible">截至本章全部可见角色（${characters.length}）</button>
    <button class="btn small ${view === 'all' ? '' : 'secondary'}" data-action="panel-view" data-view="all">全部故事状态</button>
  </div>`;
  return `
    <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
      <b>—— 本章状态 ——</b>
      <span class="chip">${esc(chapterNo)}</span>
      <span class="chip">${boundary === 'after' ? '章后状态' : '章前状态'}</span>
      <span class="chip">${esc(label)}</span>
      ${p.worldline_id ? `<span class="chip">世界线 ${esc(String(p.worldline_id).slice(0, 10))}</span>` : ''}
      <span class="muted" style="font-size:12px">${esc(trustedText)}${p.commit_id ? `｜提交 ${esc(String(p.commit_id).slice(0, 12))}` : ''}${p.order_version_id ? `｜章序 ${esc(String(p.order_version_id).slice(0, 10))}` : ''}</span>
    </div>
    ${p.stop && Number(p.stop.chapter_id) === Number(p.chapter_id) ? `<div class="redline-scan warn mt-8">本章在可信前缀处停止：${esc(String(p.stop.detail || p.stop.reason || ''))}（显示的是此前已确认的状态，不是本章新稿）</div>` : ''}
    ${tabs}
    ${view === 'all' ? `<div class="mt-8">${state.chapterPanelFull ? chapterStateListHtml(state.chapterPanelFull) : '<div class="muted">正在读取完整状态…</div>'}</div>` : `
      ${view === 'cast' && appearanceRows ? `<div class="mt-8"><b style="font-size:13px">出场记录</b>${appearanceRows}</div>` : ''}
      <div class="mt-8"><b style="font-size:13px">${view === 'cast' ? '出场角色状态' : '截至本章的可见角色'}</b>
        ${rows.length ? rows.map(charCard).join('') : '<div class="muted">本章没有登记出场角色（可能尚未分析或未确认）。</div>'}
      </div>
      ${relRows ? `<div class="mt-8"><b style="font-size:13px">相关人物关系</b>${relRows}</div>` : ''}
      ${plotRows ? `<div class="mt-8"><b style="font-size:13px">相关剧情线</b>${plotRows}</div>` : ''}
      ${(p.events || []).length ? `<div class="mt-8"><b style="font-size:13px">本章事件（${(p.events || []).length}）</b>${(p.events || []).slice(0, 10).map((e) => `<div class="muted" style="font-size:12px">${esc(String(e.entity_id))}: ${esc(String((e.value && e.value.summary) || e.predicate || ''))}</div>`).join('')}</div>` : ''}
    `}
    ${proposalHtml}
  `;
}

/** 本章提案一次确认（原子组；模型不能确认自己的抽取，这里是作者动作）。 */
async function confirmChapterProposals() {
  const groups = state.chapterProposals;
  const list = groups && Array.isArray(groups.proposals) ? groups.proposals : [];
  if (!list.length) { toast('本章没有待确认提案', 'error'); return; }
  const chapterId = state.chapterPanel ? Number(state.chapterPanel.chapter_id) : Number(state.currentChapterId) || 0;
  if (!confirm(`确认本章 ${list.length} 个提案组？确认后事件进入正式状态，并触发下游一致性复核（只分析）。`)) return;
  try {
    for (const g of list) {
      const r = await api(`/novel/state/proposal-groups/${encodeURIComponent(String(g.binding_id))}/apply`, {
        method: 'POST', body: { work_id: state.workId, chapter_id: chapterId },
      });
      if (!r || r.ok !== true) { toast(`确认失败：${(r && r.reason) || '未知原因'}`, 'error'); break; }
    }
    toast('已确认：状态与投影一次更新', 'success');
    await refreshChapterStatePanel(chapterId, { force: true, boundary: (state.chapterPanel && state.chapterPanel.boundary) || 'after' });
    if (typeof renderReference === 'function') renderReference(state.refTab);
  } catch (e) { toast(`确认失败：${e.message}`, 'error'); }
}

function renderReference(tab = 'terms') {
  const list = $('#reference-list');
  if (!list) return;
  state.refTab = tab;
  $$('.reference-tabs button[data-action="ref-tab"], .reference-subtabs button[data-action="ref-tab"]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
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
  // OpenViking 语义召回层：状态 + 命中来源（写入 AI 上下文的新增分层）。
  const recall = ctx.semantic_recall || {};
  const recallStatusText = {
    ok: '✓ 已召回', unavailable: '⚠ 记忆库不可用（不阻塞写作）', disabled: '已关闭',
    'no-hits': '无命中（阈值 0.3）', empty: '暂无查询内容', error: '召回出错', unknown: '—'
  }[recall.status] || '—';
  const recallHits = (recall.hits || []).map((h) => `
    <div class="reference-item">
      <div class="ref-title">${esc(h.label)} <span class="muted" style="font-size:11px">${esc(h.kind || '')} · 相关度 ${recallPercent(h.score)}%</span></div>
      <div class="ref-desc muted">${esc(h.text || '')}</div>
    </div>`).join('');
  const recallHtml = `
    <div class="ref-group-title">相关记忆检索（语义召回）· ${recallStatusText} · <label class="row" style="display:inline-flex;gap:4px"><input type="checkbox" data-action="semantic-toggle" ${recall.enabled === false ? '' : 'checked'}> 启用</label></div>
    ${recallHits || '<div class="muted" style="padding:2px 4px">本次装配暂无召回命中（写入前可先保存章节/长期记忆，供记忆库向量化）</div>'}`;
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
    ${recallHtml}
    <div class="ref-group-title">装配结果（${(ctx.assembled || '').length} 字，超层预算的截断会在文中注明）</div>
    <pre class="context-preview">${esc(ctx.assembled || '')}</pre>`;
}

// F-01：自动保存用闭包快照捕获当时的章节与内容，800ms 后触发时不再重查 DOM，
// 避免定时器在编辑器已被替换（切章/切视图）后才触发而把新章节内容写回旧章节或丢字。
//
// ── 空内容保存护栏的三个判据（2026-10-02 事故后重做，与旧实现的口径差别写清）──
/** 正文"有内容"的判据下限：低于这些可读字符的稿子不再算"值得保护的正文章节"。 */
const EMPTY_SAVE_MIN_CHARS = 50;
/**
 * 可读字符数（汉字/字母/数字；不含标点与空白）。
 * 与 wordCount（去空白后计长）分工不同：只有标点、空行、零宽字符的稿子救不回来，
 * 不该用"长度"去冒充"内容"—— 服务端 checkEmptyOverwrite 用的是同一口径，两侧必须一致。
 */
function readableCharCount(text) {
  const t = typeof stripHtml === 'function' ? stripHtml(String(text == null ? '' : text)) : String(text == null ? '' : text);
  const m = t.match(/[\p{Script=Han}\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}
/** 快照是不是"空正文"（去标签后无任何可读字符；`<div><br></div>` 也算空）。 */
function editorSnapIsBlank(html) {
  return readableCharCount(html) === 0;
}
/** 本页为某章见过的最大正文可读字数（只增不减，切章/刷新都不会把它变小）。 */
function knownChapterBodyChars(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return 0;
  const prior = Number(state.chapterBodyPeak.get(id)) || 0;
  let known = prior;
  try {
    const snap = state.editorSaveSnapshot;
    if (snap && Number(snap.id) === id) known = Math.max(known, readableCharCount(snap.content));
  } catch (_) { /* 读快照失败不影响已记住的峰值 */ }
  try {
    const editor = $('#editor-content');
    if (editor && Number(editor.dataset.chapterId) === id) known = Math.max(known, readableCharCount(editor.innerHTML));
  } catch (_) { /* 无编辑器节点时只用已记住的峰值 */ }
  if (known > prior) state.chapterBodyPeak.set(id, known);
  return known;
}
function setEditorEmptyHoldStatus(reason) {
  const status = $('#editor-status');
  if (!status) return;
  const n = Number(state.editorSaveFailedSnapshot?.chapter_chars)
    || (state.editorEmptyBlocked ? knownChapterBodyChars(state.editorEmptyBlocked.id) : 0);
  status.innerHTML = `<span class="err">⏸ ${esc(reason)}：已暂停保存，正文未被覆盖</span>` + (n ? ` · <span>原正文 ${n} 字仍在</span>` : '');
}

function scheduleSave() {
  clearTimeout(state.editorSaveTimer);
  const editor = $('#editor-content');
  const title = $('#editor-title');
  // 单槽会被新章的快照覆盖：切章留下的那一份先转存到"每章一份"的暂存区，否则它**再也没人落盘**。
  //（"不得影响用户的操作"意味着作者可以随时切章，所以这一条必须成立。）
  const pendingId = editor ? Number(editor.dataset.chapterId) : 0;
  if (state.editorSaveSnapshot && Number(state.editorSaveSnapshot.id) !== pendingId) holdPendingEditorSnapshot(state.editorSaveSnapshot);
  state.editorSaveSnapshot = {
    id: editor ? Number(editor.dataset.chapterId) : null,
    content: editor ? editor.innerHTML : '',
    title: title ? title.value : ''
  };
  // 每敲一次就把"本页见过的该章最大正文"记一遍：护栏的判据因此不依赖任何会被刷新改小的状态。
  if (state.editorSaveSnapshot.id) knownChapterBodyChars(state.editorSaveSnapshot.id);
  if (!state.editorComposing) state.editorSaveTimer = setTimeout(() => {
    state.editorSaveTimer = null;
    const snap = state.editorSaveSnapshot;
    state.editorSaveSnapshot = null;
    // 🛡 空内容保存护栏（2026-10-02 事故后重做）：正文本来有内容、编辑器却空了 —— 一次误触
    // （全选删除 / 误按替换 / 另一条写通道把内容换掉了）就会在 800ms 后把整章覆盖成空白。
    //
    // 与旧实现的区别（事故复盘）：旧版在这里弹 confirm 让作者确认，而**判据是内存里的
    // state.chapters[].content**。那一份内存稿一旦已经是空的（例如此前发生过一次空写、
    // 或该章是从别处被改空的），护栏就永久失效并继续放行；而且它只看得见这条自动保存通道。
    // 现在：① 判据用"本页见过的最长正文"（只增不减，不受刷新/他处写入影响）；
    //       ② 交互改成**只暂停，不弹窗**——写入永远不经作者之外的手落到空稿上；
    //       ③ 服务端另有一道以库里现正文为准的权威护栏（EMPTY_OVERWRITE_BLOCKED）。
    // 判据只用"编辑器可见文本 + 该章正文长度"，不参与任何生成决策。
    if (snap && editorSnapIsBlank(snap.content) && knownChapterBodyChars(snap.id) > EMPTY_SAVE_MIN_CHARS) {
      state.editorEmptyBlocked = snap;
      setEditorEmptyHoldStatus('编辑器为空');
      toast('编辑器当前是空的，已暂停自动保存（正文没有被覆盖）——用编辑器上方的恢复条取回原稿，或明确选择清空本章', 'error');
      // 必须**当场**把恢复条画出来：两条出路（取回原稿 / 确认清空）都在那里，
      // 否则作者只看到一句"用恢复条…"却找不到任何按钮（2026-10-04 报障原文：
      // "你没有按钮让我选择清空本章，一刷新又恢复了"）。
      // ⚠️ 只调 refreshChapterRecovery 不够：它以前只取数据不碰 DOM，而且"该章数据已取过"
      // （state.recoveryForChapter === snap.id，打开章节后必然如此）时连这个调用都会被跳过。
      refreshRecoveryBar(snap.id);
      if (snap.id && state.recoveryForChapter !== snap.id) refreshChapterRecovery(snap.id).catch(() => { /* 提示层失败不影响写作 */ });
      return;
    }
    if (snap && !state.editorConflictSnapshot) saveChapterSnapshot(snap);
    else if (snap) state.editorSaveSnapshot = snap;
  }, 800);
  const status = $('#editor-status');
  if (status) {
    const count = editor ? wordCount(editor.innerText || '') : 0;
    status.innerHTML = `<span>编辑中...</span> · <span id="editor-count">${count}</span> 字`;
  }
}

// F-01：立即落盘——清掉待执行的定时器并把最新快照同步保存（幂等：无待保存快照时为空操作）。
// 在所有「切换章节 / 离开写作视图 / 切换作品 / 手动·批量保存前」路径调用，确保 800ms 内切章不丢字。
//
// 🚦 导航闸门的口径（2026-10-02 事故后修正）：**正文永远不会因为导航而丢**，所以"保存有问题"
// 只该给出提示与出路，不该把作者锁在原地。旧实现只要存在未解决的空内容暂停 / 保存失败快照
// 就返回 false，而它被 20 多处导航调用 —— 于是任何一次保存异常都会让切章、开面板、AI 工具
// 全部失灵，"保存问题影响正常操作"的最大来源正是这里。
// 现在只有两种状态仍然拦人：**正在输入法组字**（拦一下不会丢任何东西）和**409 真冲突**
// （作者必须明确选一版，服务端那一版与本地这一版不可能自动合并）。
/**
 * 保存层的总闸门（2026-10-05 作者明确要求：不得影响用户的所有操作）。
 *
 * 返回值仍是"这一轮还留着没落盘的冲突吗"（沿用旧语义，便于诊断），但**没有任何调用方可以拿它拦人**：
 * 导航（ensureSavedBeforeNavigation）与渲染（render）都不再据此中断 —— 保存没成功只产生两件事：
 * ① 一条可见提醒（同一次未保存只提醒一遍，见 notifyUnsavedEditorWork）；
 * ② 一次自动重试（退避，见 scheduleEditorSaveRetry）。
 * 空内容暂停只提醒 —— 正文永远不会被自动清空，这是数据可靠性的硬要求，不是操作闸门。
 */
async function flushSave() {
  let clean = true;
  try { clean = await flushEditorSaves(); } catch (_) { clean = false; /* 落盘失败不拦操作 */ }
  if (hasUnsavedEditorWork()) {
    notifyUnsavedEditorWork(true);   // 作者当下正在操作：如实说一遍（不拦操作，重复措辞由 toast 去重）
    scheduleEditorSaveRetry();
  } else {
    // 全部落盘了：把"提醒过的那一次"归零，下一次真的又没保存上才会再提醒。
    state.editorUnsavedNoticeKey = '';
    state.editorSaveRetryStep = 0;
  }
  return clean;
}

/**
 * 把编辑器"待写的稿子"落盘（flushSave 的核心，**无界面副作用**）。
 * 依次处理：待写快照 → 每章暂存稿 → 在途写入；任何一步失败就停（稿子留着，交给自动重试）。
 * @returns {boolean} true = 当前没有 409 冲突；false = 有冲突（**调用方不得据此拦人**）
 */
async function flushEditorSaves() {
  if (state.editorComposing || state.editorConflictSnapshot) return false;
  clearEditorEmptyBlockIfStale();
  clearTimeout(state.editorSaveTimer);
  state.editorSaveTimer = null;
  // 等待时作者仍可能输入。循环处理最新快照，而不是把旧请求成功当作最新稿成功。
  while (state.editorSaveSnapshot || state.editorSaveInFlight.size || state.editorPendingByChapter.size) {
    if (state.editorComposing || state.editorConflictSnapshot) return false;
    const snap = state.editorSaveSnapshot || takeOldestPendingEditorSnapshot();
    const fromPending = Boolean(snap) && state.editorSaveSnapshot !== snap;
    state.editorSaveSnapshot = null;
    const results = await Promise.all([
      ...(snap ? [saveChapterSnapshot(snap)] : []),
      ...state.editorSaveInFlight.values()
    ]);
    if (snap && fromPending && results[0] === true) state.editorPendingByChapter.delete(Number(snap.id));
    if (!results.every(Boolean)) break;
    clearTimeout(state.editorSaveTimer);
    state.editorSaveTimer = null;
  }
  return !state.editorConflictSnapshot;
}

// ---------- 未保存提醒 + 自动保存重试（2026-10-05 作者要求）----------
/** 自动重试的退避档位（毫秒）；最后一档一直重复，直到保存成功或作者自己处理。 */
const EDITOR_SAVE_RETRY_DELAYS = [3000, 8000, 20000, 30000];

/** 暂存"作者手里还没落盘"的稿子（见 state.editorPendingByChapter 的注释）。 */
function holdPendingEditorSnapshot(snap) {
  if (!snap || !snap.id) return;
  state.editorPendingByChapter.set(Number(snap.id), snap);
}
/** 取出最早暂存的一份稿子：先来先服务，越早留下的越容易被后来的操作顶掉。 */
function takeOldestPendingEditorSnapshot() {
  for (const [id, snap] of state.editorPendingByChapter) {
    state.editorPendingByChapter.delete(id);
    return snap;
  }
  return null;
}
/**
 * 重渲染编辑器时该显示哪一版正文。
 *
 * 优先显示"**作者手里还没落盘那一版**"，而不是服务端那一版。为什么必须有：不再拦导航之后，
 * 切走再切回来会用服务端正文重建编辑器 —— 作者会看到自己刚写的字"消失"（稿子其实还在暂存区、
 * 还会被自动保存）。让作者看到自己那一版，才符合"用户所做的一切为最高优先级"。
 * 例外：被空内容护栏暂停的空白稿**不**顶上来（那等于把服务端正文在界面上抹掉，
 * 而"清空本章"必须是作者显式确认的动作，恢复条上就有那个按钮）。
 */
function editorDraftHtmlFor(current) {
  const id = Number(current && current.id) || 0;
  if (!id) return (current && current.content) || '';
  const mine = (snap) => (snap && Number(snap.id) === id ? snap : null);
  const held = mine(state.editorSaveSnapshot) || mine(state.editorPendingByChapter.get(id))
    || mine(state.editorConflictSnapshot) || mine(state.editorSaveFailedSnapshot);
  if (held && typeof held.content === 'string' && held.content) return held.content;
  return (current && current.content) || '';
}
/** 作者手里还有没有没落盘的稿子（只看本页状态，不依赖任何服务端口径）。 */
function hasUnsavedEditorWork() {
  if (!state.workId) return false;
  if (state.editorSaveSnapshot || state.editorSaveInFlight.size) return true;
  if (state.editorPendingByChapter.size) return true;
  return Boolean(state.editorSaveFailedSnapshot || state.editorConflictSnapshot || state.editorEmptyBlocked);
}
/** 没落盘的内容属于哪一章（决定提醒条画在哪一章上）。 */
function unsavedEditorWorkChapterId() {
  for (const c of [state.editorConflictSnapshot, state.editorSaveFailedSnapshot, state.editorEmptyBlocked, state.editorSaveSnapshot]) {
    if (c && c.id) return Number(c.id);
  }
  for (const [id] of state.editorPendingByChapter) return Number(id);
  const editor = $('#editor-content');
  return (editor ? Number(editor.dataset.chapterId) : 0) || Number(state.currentChapterId) || 0;
}
/** 未保存内容的一句话说明；没有未保存内容时返回 null。
 *  顺序有讲究：空内容暂停排最前 —— 它是唯一"程序不能替你决定"的状态（清空 or 取回），
 *  文案必须原样点出"已暂停保存"，否则作者会以为只是普通保存失败。 */
function unsavedEditorWorkLabel() {
  if (state.editorEmptyBlocked) return '编辑器是空的，已暂停保存以免覆盖正文';
  if (state.editorConflictSnapshot) return '这一章在别处被改过，你手上这一版还没保存';
  if (state.editorSaveFailedSnapshot) return '这一章的改动还没保存成功';
  if (state.editorSaveSnapshot || state.editorPendingByChapter.size || state.editorSaveInFlight.size) return '这一章的改动还没落盘';
  return null;
}

/**
 * 该章"只在编辑器里、还没落盘"的那一版内容（没有则 null）。
 *
 * F3（2026-10-06 作者要求）：把新内容写进正文之前，如果作者手里还压着一版没落盘的旧内容，
 * 必须先问一句「旧内容是否保存？」—— 既不静默替作者落盘，也不静默丢掉。
 */
function pendingEditorSnapshotFor(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return null;
  const mine = (snap) => (snap && Number(snap.id) === id ? snap : null);
  return mine(state.editorSaveSnapshot)
    || mine(state.editorPendingByChapter.get(id))
    || mine(state.editorConflictSnapshot)
    || mine(state.editorSaveFailedSnapshot)
    || null;
}

/**
 * 作者明确选择"旧内容不保存"时，把该章手里那一版**丢掉**。
 *
 * 为什么必须真的丢：留着它，自动重试随后还会把它落盘 —— 而那已经是"新内容写完之后"了，
 * 旧稿会反过来盖掉刚写进去的新正文。作者选「否」就是选了不要它。
 */
function discardPendingEditorWorkFor(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return;
  const keep = (snap) => (snap && Number(snap.id) === id ? null : snap);
  state.editorSaveSnapshot = keep(state.editorSaveSnapshot);
  state.editorPendingByChapter.delete(id);
  state.editorConflictSnapshot = keep(state.editorConflictSnapshot);
  state.editorSaveFailedSnapshot = keep(state.editorSaveFailedSnapshot);
  state.editorEmptyBlocked = keep(state.editorEmptyBlocked);
  state.editorUnsavedNoticeKey = '';
  if (!hasUnsavedEditorWork()) {
    clearTimeout(state.editorSaveRetryTimer);
    state.editorSaveRetryTimer = null;
    state.editorSaveRetryStep = 0;
  }
}

/**
 * 采纳写成功后，丢掉该章**已被取代**的旧在途稿子。
 *
 * 为什么必要：作者选了「是，先保存」但那一版没存上（409/空稿暂停）时，它仍然留在手里；
 * 之后自动重试把它落盘，就会把刚采纳的新正文**倒回旧稿**。判据是确定性的 ——
 * 与本次写入的 html 不逐字相同，就一定是采纳前那一版（被覆盖的那一版服务端已存历史版本，不会丢）。
 */
function discardSupersededEditorWorkFor(chapterId, html) {
  const id = Number(chapterId) || 0;
  if (!id) return;
  const superseded = (snap) => (snap && Number(snap.id) === id && String(snap.content) !== String(html) ? null : snap);
  state.editorSaveSnapshot = superseded(state.editorSaveSnapshot);
  const pending = state.editorPendingByChapter.get(id);
  if (pending && String(pending.content) !== String(html)) state.editorPendingByChapter.delete(id);
  state.editorConflictSnapshot = superseded(state.editorConflictSnapshot);
  state.editorSaveFailedSnapshot = superseded(state.editorSaveFailedSnapshot);
}

/**
 * 「旧内容是否保存？」（F3 · 2026-10-06 作者要求）。
 *
 * 返回 true = 先保存旧内容；false = 不保存旧内容，直接写入新内容。
 * **两个答案都不拦操作**：无论选哪个，紧接着的新内容写入都必须完成 ——
 * 这个框问的是"旧那一版怎么处理"，不是"要不要继续"。
 * 遮罩点击不关闭：这个答案决定旧内容存不存，误触关闭等于把选择丢掉（作者明确要求过的口径）。
 */
function askSaveOldContent(chapterId, chars) {
  return new Promise((resolve) => {
    state.pendingOldContent = { chapterId: Number(chapterId) || 0, resolve };
    openModal({
      title: '旧内容是否保存？',
      body: `<div class="muted">这一章还有 <b>${Number(chars) || 0} 字</b>只在编辑器里、还没保存。接下来会把新内容写进这一章。</div>
        <div class="muted mt-8">选「是」：先把这一版存进本章历史版本，再写入新内容。<br>
        选「否」：不为这一版额外留档，直接写入新内容。<br>
        两种选择都会把新内容完整写进正文，不会中断你的操作。覆盖前把库里那一版另存为历史版本是服务端的固定安全底线，两者都保留。</div>`,
      footer: `<button class="btn secondary" data-action="save-old-content-no">否，不保存直接写入</button>
        <button class="btn" data-action="save-old-content-yes">是，先保存旧内容</button>`,
      protectedBackdrop: true
    });
  });
}

/**
 * 把"作者手里那一版还没落盘的旧内容"存成一条**历史版本**（不改正文）。
 *
 * 为什么用 chapter_versions 而不是先 flush 写正文：正文马上就会被新内容替换，
 * 先写正文再覆盖只会多绕一圈、还会把采纳的并发基线推来推去；而"保存旧内容"这件事
 * 本来就等于"这一版要能找回来"，历史版本正是它该去的地方。
 */
async function snapshotOldContentAsVersion(chapterId, snap) {
  const id = Number(chapterId) || 0;
  if (!id || !snap) return false;
  const chapter = (state.chapters || []).find((c) => Number(c.id) === id);
  try {
    await api('/chapter_versions', {
      method: 'POST',
      body: {
        chapter_id: id,
        title: snap.title || chapter?.title || '未命名章节',
        summary: chapter?.summary || '',
        content: sanitizeEditorHtml(snap.content)   // 与其它历史版本写入同一条消毒路径
      }
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * F3 的统一入口：正文即将被覆盖时，处理"这一章手里那一版没落盘的旧内容"。
 *
 * @returns {'save'|'discard'|''} 作者的选择（'' = 本来就没有未保存内容，不必问）
 *
 * 无论选哪个，都会把那一版从"本地待保存队列"里撤下来：正文马上要被作者自己的这一版新内容替换，
 * 留着一份更旧的稿子在队列里，只会在自动重试时把刚写进去的新正文**倒回旧稿**。
 * 选「否」＝不要这一版；选「是」＝它已经进历史版本、可以放心撤下来。
 * 若采纳随后失败，编辑器会被还原成 beforeHtml，作者的字仍在眼前，不会凭空消失。
 */
async function settleOldContentBeforeOverwrite(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return '';
  // 写入在途 = 这一版正在落盘，等同"保存"，不必打扰。
  if (state.editorSaveInFlight.has(id)) return 'save';
  const snap = pendingEditorSnapshotFor(id);
  const chars = snap ? readableCharCount(snap.content) : 0;
  if (!snap || chars <= 0) return '';
  const keep = await askSaveOldContent(id, chars);
  if (keep) {
    const saved = await snapshotOldContentAsVersion(id, snap);
    discardPendingEditorWorkFor(id);
    if (saved) toast('旧内容已存进本章历史版本，接着写入新内容', 'success');
    else toast('旧内容这一版没能存进历史版本（保存在编辑器里的那一版仍在，采纳失败时会还原到编辑器）；仍会继续写入新内容', 'error');
    return 'save';
  }
  discardPendingEditorWorkFor(id);
  return 'discard';
}
/**
 * 有未保存内容时提醒。
 *
 * - `force = true`（导航/渲染这类"作者正在做事"的时刻）：每次都说出当前状态。这正是作者要的
 *   "未保存的弹窗提醒保存"；它只是提示，**不拦任何操作**，而重复的措辞由 toast 层自带的
 *   3 秒同文案去重兜住，不会变成刷屏。
 * - 默认（后台自动重试）：同一次未保存（章号 + 原因）只提醒一遍，免得程序自己在后台反复弹。
 * 保存成功（不再有未保存内容）时 key 清空，下一次真的又没保存上还会再提醒。
 */
function notifyUnsavedEditorWork(force = false) {
  const label = unsavedEditorWorkLabel();
  if (!label) { state.editorUnsavedNoticeKey = ''; return; }
  const key = `${unsavedEditorWorkChapterId()}|${label}`;
  if (!force && state.editorUnsavedNoticeKey === key) return;
  state.editorUnsavedNoticeKey = key;
  state.editorUnsavedNoticeAt = Date.now();
  toast(`${label}：正在为你自动保存；也可以点编辑器上方的「立即保存」马上存一次（不会打断你现在的操作）`, 'error');
  refreshRecoveryBar(unsavedEditorWorkChapterId());
}
/** 安排一次自动重试（退避）；已有计时器就不重复安排。 */
function scheduleEditorSaveRetry() {
  if (state.editorSaveRetryTimer) return;
  if (!hasUnsavedEditorWork()) { state.editorSaveRetryStep = 0; return; }
  const idx = Math.min(Number(state.editorSaveRetryStep || 0), EDITOR_SAVE_RETRY_DELAYS.length - 1);
  state.editorSaveRetryTimer = setTimeout(() => {
    state.editorSaveRetryTimer = null;
    retryUnsavedEditorSaves().catch(() => { /* 重试失败：下面继续排下一档 */ });
  }, EDITOR_SAVE_RETRY_DELAYS[idx]);
}
/**
 * 自动重试一次"把作者手里的稿子落盘"。
 *
 * 409 的处置顺序不能反：**先给服务端那一版留一条历史版本，再用最新基线写入作者这一版** ——
 * 反过来（先覆盖再备份）等于把别人那一版直接抹掉，不可回退。
 * 空内容暂停**不写**（硬要求：不得自动清空已有正文），只保持提醒与两条出路。
 */
async function retryUnsavedEditorSaves() {
  if (state.editorComposing) { scheduleEditorSaveRetry(); return; }      // 组字中不写半成品，等组字结束再试
  if (state.editorEmptyBlocked) { notifyUnsavedEditorWork(); return; }   // 空稿只能由作者决定：清空 / 取回
  const conflict = state.editorConflictSnapshot;
  if (conflict && conflict.id) {
    let fresh = null;
    try { fresh = await api(`/chapters/${Number(conflict.id)}`); } catch (_) { fresh = null; }
    if (!fresh || !fresh.updated_at) { scheduleEditorSaveRetry(); return; }
    try {
      await api('/chapter_versions', {
        method: 'POST',
        body: {
          chapter_id: Number(conflict.id), title: fresh.title || conflict.title || '',
          summary: fresh.summary || '', content: String(fresh.content || '')
        }
      });
      const idx = state.chapters.findIndex((c) => Number(c.id) === Number(conflict.id));
      if (idx >= 0) state.chapters[idx] = fresh;
      state.editorConflictSnapshot = null;
      // 不传 confirmEmpty：自动路径**不替作者确认清空**，空内容仍然会被护栏拦下。
      const ok = (await writeChapterBody(Number(conflict.id), { content: conflict.content, title: conflict.title })) === 'saved';
      if (ok) {
        state.editorSaveFailedSnapshot = null;
        state.editorPendingByChapter.delete(Number(conflict.id));
        state.editorSaveRetryStep = 0;
        toast('已自动保存：之前冲突的那一版也存进历史版本了，随时可回退', 'success');
        refreshRecoveryBar(Number(conflict.id));
        return;
      }
    } catch (_) { /* 落到下面统一排下一档重试 */ }
    scheduleEditorSaveRetry();
    return;
  }
  try { await flushEditorSaves(); } catch (_) { /* 忽略：按结果决定是否再排 */ }
  if (hasUnsavedEditorWork()) {
    state.editorSaveRetryStep = Number(state.editorSaveRetryStep || 0) + 1;
    notifyUnsavedEditorWork();
    scheduleEditorSaveRetry();
  } else {
    state.editorSaveRetryStep = 0;
    state.editorUnsavedNoticeKey = '';
  }
}

/**
 * 清掉**已经过期**的空内容暂停态。
 *
 * 为什么必须有（2026-10-02 晚，作者报"修稿完成后无法加进正文"）：暂停态是一个**粘性标记**，
 * 只在"作者显式清空"或"采纳成功"时才被清。作者把正文粘回编辑器（或那段空稿本来就是另一章/
 * 另一时刻的）之后，标记还挂着，于是**之后每一次保存/导航都继续按"编辑器是空的"处理**，
 * 反复弹出那条与当下无关的提示。判据：编辑器此刻**不是空的**、且**装的正是被拦下的那一章**。
 */
function clearEditorEmptyBlockIfStale() {
  const blocked = state.editorEmptyBlocked;
  if (!blocked) return false;
  const editor = $('#editor-content');
  if (!editor) return false;
  if (blocked.id && Number(editor.dataset.chapterId) !== Number(blocked.id)) return false;
  if (editorSnapIsBlank(editor.innerHTML)) return false;   // 真的还是空的：保留暂停态
  state.editorEmptyBlocked = null;
  state.editorSaveFailedSnapshot = null;
  // 恢复条上那条「🛡 编辑器是空的，自动保存已暂停」此刻已经过期（正文回来了）：
  // 不刷新的话它会一直挂着，比不提示更误导。刷新失败不影响保存本身。
  const box = typeof document !== 'undefined' ? document.getElementById('chapter-recovery') : null;
  const cur = (state.chapters || []).find((c) => Number(c.id) === Number(blocked.id));
  if (box && cur) box.innerHTML = recoveryBarHtml(cur);
  return true;
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

// 保存章节核心：接收闭包快照 { id, content, title }，负责 PUT + 乐观锁 + 状态刷新。
// F-07：PUT /chapters/:id 是部分更新——未传字段保持不变（后端 updateRow 仅更新 data[f]!==undefined 的字段），
// 因此这里每次显式传 title/content/summary；summary 保持不变也从本地回读补上，避免被部分更新清空。
// F-08：body 带 _if_updated_at 乐观锁，冲突（409）时提示并重载。
//
// 实现已收敛到 writeChapterBody（唯一写入出口）：本函数只保留"同一章同一时刻只有一个写入在途"
// 的登记（flushSave / beforeunload 依赖这个 Map 判断"还有稿子没落库"），以及布尔返回值。
// 空内容判据、409 冲突态、失败留稿这三件事因此不可能再与手动保存走出两套语义。
async function saveChapterSnapshot({ id, content, title }) {
  if (!id) return true;
  const request = (async () => {
    const verdict = await writeChapterBody(id, { content, title });
    return verdict === 'saved';
  })();
  state.editorSaveInFlight.set(Number(id), request);
  try { return await request; } finally { if (state.editorSaveInFlight.get(Number(id)) === request) state.editorSaveInFlight.delete(Number(id)); }
}

// 409 冲突不是终止态：作者必须能明确选择保留哪一版，且选择后自动保存闸门恢复。
function showEditorConflictActions() {
  const status = $('#editor-status');
  if (!status) return;
  status.innerHTML = '<span class="err">保存冲突：本地内容已保留</span> '
    + '<button class="btn small" data-action="editor-conflict-local">以本地为准</button> '
    + '<button class="btn small secondary" data-action="editor-conflict-server">以服务端为准</button>';
}

async function resolveEditorConflict(choice) {
  const conflict = state.editorConflictSnapshot;
  if (!conflict) return false;
  const id = Number(conflict.id);
  if (!id) return false;
  if (choice === 'server') {
    try {
      const latest = await api(`/chapters/${id}`);
      const idx = state.chapters.findIndex((c) => c.id === id);
      if (idx >= 0) state.chapters[idx] = latest;
      const editor = $('#editor-content');
      const title = $('#editor-title');
      if (editor && Number(editor.dataset.chapterId) === id) editor.innerHTML = sanitizeEditorHtml(latest.content || '');
      if (title && Number(editor?.dataset.chapterId) === id) title.value = latest.title || '';
      state.editorConflictSnapshot = null;
      state.editorSaveSnapshot = null;
      state.editorSaveFailedSnapshot = null;
      const status = $('#editor-status');
      if (status) status.innerHTML = '<span class="ok">✔ 已采用服务端版本，自动保存已恢复</span>';
      return true;
    } catch (e) {
      toast('读取服务端最新版本失败：' + e.message, 'error');
      showEditorConflictActions();
      return false;
    }
  }
  if (choice === 'local') {
    // 先取最新 updated_at，再以本地快照重试；不能关闭乐观锁或复用旧锁值。
    let latest;
    try { latest = await api(`/chapters/${id}`); } catch (e) {
      toast('读取服务端最新版本失败：' + e.message, 'error');
      showEditorConflictActions();
      return false;
    }
    const snapshot = { id, content: conflict.content, title: conflict.title };
    const idx = state.chapters.findIndex((c) => c.id === id);
    if (idx >= 0) state.chapters[idx] = latest;
    state.editorConflictSnapshot = null;
    // 冲突已由作者选了"以本地为准"→ 这一次写入是明确的作者意图，不再次询问空内容。
    const ok = (await writeChapterBody(id, { ...snapshot, confirmEmpty: true })) === 'saved';
    if (!ok) return false;
    state.editorSaveSnapshot = null;
    const status = $('#editor-status');
    if (status) status.innerHTML = '<span class="ok">✔ 已采用本地版本，自动保存已恢复</span>';
    return true;
  }
  return false;
}

async function saveCurrentChapter() {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  if (!editor || !title) return false;
  return saveChapterSnapshot({ id: Number(editor.dataset.chapterId), content: editor.innerHTML, title: title.value });
}

// ---------- manual save / version history ----------
// F-16：写通道注释——PUT /chapters/:id = 编辑器保存（自动/手动，乐观锁 + 白名单消毒）；
// 另有 POST /novel/chapter_save = 审稿合并 / 批量生成写回（走 textToParagraphsHtml，旧稿自动存历史版本）。
//
// ⚠️ 手动保存空正文的护栏（2026-10-02 事故后补）：手动保存**不是**空正文的旁路。
// 事故形状：手动保存这条路只经过 saveCurrentChapter（没有任何空内容判据），而它的孪生调用方
// applyAIReply 在"应用 AI 结果"前正是用它做备份 —— 于是"编辑器被清空"这件事既没有护栏
// 也没有提示，一路写到库里。现在它与自动保存共用同一条判据，共享同一个显式出口。
async function manualSaveChapter() {
  const editor = $('#editor-content');
  const title = $('#editor-title');
  if (!editor || !title) return;
  const id = Number(editor.dataset.chapterId);
  if (!id) return;
  // F-01：取消待执行的自动保存定时器，避免与本次手动 PUT 重复写入（乐观锁下会误判 409）。
  // ⚠️ 待写快照不能直接丢：它可能就是**别的章**还没落盘的那一份（作者刚切过来就点了手动保存）。
  // 属于本章的可以直接丢——本次 PUT 写的就是编辑器里同一份内容。
  if (state.editorSaveTimer) { clearTimeout(state.editorSaveTimer); state.editorSaveTimer = null; }
  if (state.editorSaveSnapshot && Number(state.editorSaveSnapshot.id) !== id) holdPendingEditorSnapshot(state.editorSaveSnapshot);
  state.editorSaveSnapshot = null;
  try {
    const ok = await saveCurrentChapterChecked(id);
    if (!ok) return; // 空内容 / 409 冲突：都不该再往下创建历史版本，也不该静默通过
    const version = await api('/chapter_versions', {
      method: 'POST',
      body: {
        chapter_id: id,
        title: title.value || '未命名章节',
        summary: state.chapters.find((c) => c.id === id)?.summary || '',
        content: sanitizeEditorHtml(editor.innerHTML) // F-03：历史版本同样白名单消毒
      }
    });
    toast(`已手动保存：${version.created_at || ''}`, 'success');
  } catch (e) {
    toast('手动保存失败：' + e.message, 'error');
  }
}

/**
 * 编辑器正文写入的唯一出口（自动保存 / 手动保存 / 确认清空 / 取回历史版本共用）。
 *
 * 为什么要收敛成一个出口：此前"编辑器保存"分散在三处（scheduleSave 的定时器、
 * flushSave 的等待循环、manualSaveChapter / saveCurrentChapter），每一处各自决定
 * "要不要拦空内容、要不要弹确认、失败后怎么办" —— 结果就是同一件事在三条路径上语义不同。
 *
 * @param {number} chapterId
 * @param {object} opts
 *   · content/title   要写入的内容（默认取当前编辑器）
 *   · confirmEmpty    作者已明确"就是要清空本章"；缺省时**不做任何交互**——
 *                     判据命中就返回 'empty'，把"要不要清空"留给调用方去问、去显示出路。
 *   · onEmptyConfirm  判据命中且未确认时的回调（由调用方决定交互方式）
 * @returns {'saved'|'empty'|'conflict'|'error'}
 */
async function writeChapterBody(chapterId, { content = null, title = null, summary = undefined, confirmEmpty = false, onEmptyConfirm = null } = {}) {
  const id = Number(chapterId) || 0;
  if (!id) return 'error';
  const editor = $('#editor-content');
  const titleEl = $('#editor-title');
  const html = content !== null ? content : (editor ? editor.innerHTML : '');
  const useTitle = title !== null ? title : (titleEl ? titleEl.value : '');
  const chapter = state.chapters.find((c) => c.id === id);
  // ① 只在"本页见过该章有正文、而这次要写空"时介入。判据是**只增不减**的峰值，
  //    不是 state.chapters[].content —— 后者可以被刷新/他处写入改成空，护栏会因此永久失效。
  if (!confirmEmpty && editorSnapIsBlank(html) && knownChapterBodyChars(id) > EMPTY_SAVE_MIN_CHARS) {
    // 先把服务端意见问出来（它才是权威；服务端认为该章正文不多就会放行）。
    try {
      await api(`/chapters/${id}`, { method: 'PUT', body: buildChapterWriteBody(id, html, useTitle, summary) });
      return 'saved';
    } catch (e) {
      if (e.code === 'EMPTY_OVERWRITE_BLOCKED') {
        // 两条拒绝路径（探针被拦 / 正常写入被拦）必须收敛到**同一套状态**：暂停态、可见出路、
        // 状态栏说明。此前探针这条路只返回 'empty'，界面于是"什么都没发生"——
        // 作者既看不到暂停提示，也没有恢复条上的两个出路按钮（回归用例抓到的正是这个不对称）。
        tripEmptyGuardState(e, id, html, useTitle);
        if (typeof onEmptyConfirm === 'function') onEmptyConfirm(e);
        return 'empty';
      }
      return handleChapterWriteError(e, id, html, useTitle);
    }
  }
  try {
    const body = buildChapterWriteBody(id, html, useTitle, summary);
    if (confirmEmpty) body.confirm_empty = true;
    const updated = await api(`/chapters/${id}`, { method: 'PUT', body });
    const idx = state.chapters.findIndex((c) => c.id === id);
    if (idx >= 0) state.chapters[idx] = updated;
    if (state.workId) state.workMeta.delete(Number(state.workId));
    state.editorSaveFailedSnapshot = null;
    // 真的写进去了：把"这一章还没落盘的稿子"从暂存区删掉（否则它会一直被当成未保存内容：
    // 反复重试 + 关页面时无意义地弹提醒），并让"提醒过的那一次未保存"归零。
    state.editorPendingByChapter.delete(Number(id));
    state.editorUnsavedNoticeKey = '';
    const status = $('#editor-status');
    if (status) status.innerHTML = '<span class="ok">✔ ' + (confirmEmpty ? '已按确认清空本章' : '已自动保存') + '</span> · <span>' + wordCount(html) + '</span> 字';
    return 'saved';
  } catch (e) {
    return handleChapterWriteError(e, id, html, useTitle);
  }
}

/** PUT /chapters/:id 的请求体（F-07 部分更新语义：显式带上 title/summary，避免被清空）。 */
function buildChapterWriteBody(chapterId, html, title, summary = undefined) {
  const chapter = state.chapters.find((c) => c.id === Number(chapterId));
  const body = {
    title: title || '未命名章节',
    content: sanitizeEditorHtml(html), // F-03：保存前白名单消毒
    summary: summary !== undefined ? summary : (chapter?.summary || '')
  };
  if (chapter?.updated_at) body._if_updated_at = chapter.updated_at;
  return body;
}

/**
 * 空正文被拒之后的统一收口：把"已暂停、稿子还在、有两个出路"这件事记进状态并显示出来。
 * 三条拒绝路径（客户端探针、直接写入、服务端主动拦截）都走这里，界面不会出现"同名状态、两样表现"。
 */
function tripEmptyGuardState(err, id, html, title) {
  state.editorEmptyBlocked = { id, content: html, title };
  state.editorSaveFailedSnapshot = { id, content: html, title, message: err.message || '保存失败', code: err.code || 'EMPTY_OVERWRITE_BLOCKED' };
  setEditorEmptyHoldStatus('服务端拦下了空正文写入');
  // 先**同步**画一次恢复条（不等网络）：出路必须与"已暂停"这句话同时出现，
  // 否则作者面对的就是一个"被告知有按钮、却看不到按钮"的界面。
  refreshRecoveryBar(id);
  refreshChapterRecovery(id).catch(() => { /* 提示层失败不影响写作 */ });
  // 提醒一句（节流）：作者要求"未保存的弹窗提醒保存"。这里**不排自动重试** ——
  // 空稿不该由程序自动写回去（不得自动清空已有正文），作者继续输入非空内容后保存会自动恢复。
  notifyUnsavedEditorWork();
}

/** 写入失败的两个分支（409 冲突 / 其它错误）走同一条"保留稿子 + 记状态"的路。 */
function handleChapterWriteError(e, id, html, title) {
  const chapter = state.chapters.find((c) => c.id === Number(id));
  if (e.status === 409 && e.code !== 'EMPTY_OVERWRITE_BLOCKED') {
    state.editorConflictSnapshot = { id, content: html, title, serverUpdatedAt: chapter?.updated_at || null };
    toast('检测到其他窗口的修改，本地内容已保留；正在为你自动保存（先把服务端那一版存进历史版本，再写入你这一版）', 'error');
    showEditorConflictActions();
    // 自动处置：先把服务端那一版留成历史版本，再用最新基线写入作者这一版（见 retryUnsavedEditorSaves）。
    scheduleEditorSaveRetry();
    return 'conflict';
  }
  const status = $('#editor-status');
  if (status) status.innerHTML = `<span class="err">保存失败：${esc(e.message)}</span>`;
  if (e.code === 'EMPTY_OVERWRITE_BLOCKED') {
    tripEmptyGuardState(e, id, html, title);
  } else {
    state.editorSaveFailedSnapshot = { id, content: html, title, message: e.message || '保存失败', code: e.code || '' };
    refreshRecoveryBar(id);   // 同上：失败提示与"重试保存"按钮必须同时出现，不能只写状态
    refreshChapterRecovery(id).catch(() => { /* 提示层失败不影响写作 */ });
    // 保存失败不拦任何操作：后台按退避自动重试，直到写成功（见 scheduleEditorSaveRetry）。
    scheduleEditorSaveRetry();
  }
  return e.code === 'EMPTY_OVERWRITE_BLOCKED' ? 'empty' : 'error';
}

/**
 * 当前编辑器正文写入（手动保存用）。返回 boolean。
 * 空内容**不在这一层做交互**：判据命中就停在 'empty'，由恢复条上的「确认清空本章」
 * 承担"明确清空"这个动作 —— 同一件事只有一个入口，不会出现"两处都能清空、行为还不一样"。
 */
async function saveCurrentChapterChecked(chapterId) {
  const id = Number(chapterId) || Number($('#editor-content')?.dataset.chapterId) || 0;
  if (!id) return false;
  const editor = $('#editor-content');
  const title = $('#editor-title');
  if (!editor || !title) return false;
  const verdict = await writeChapterBody(id, { content: editor.innerHTML, title: title.value });
  if (verdict === 'empty') {
    toast('编辑器是空的：已暂停写入以免覆盖正文。确实要清空本章，请点编辑器上方的「确认清空本章」', 'error');
    return false;
  }
  if (verdict !== 'saved') return false;
  state.editorEmptyBlocked = null;
  state.editorSaveFailedSnapshot = null;
  state.editorSaveSnapshot = null;
  clearTimeout(state.editorSaveTimer);
  state.editorSaveTimer = null;
  return true;
}

/** 明确选择"清空本章正文"：先确认，再带 confirm_empty 写入（服务端唯一接受空稿的方式）。 */
async function clearChapterBodyExplicit() {
  const editor = $('#editor-content');
  const id = Number(editor?.dataset.chapterId) || Number(state.editorEmptyBlocked?.id) || 0;
  if (!id) { toast('没有正在编辑的章节', 'error'); return false; }
  if (typeof confirm === 'function'
      && !confirm('要把本章正文清空吗？\n\n当前正文会先存为一条历史版本（可在「历史版本」里恢复），然后本章正文变为空。')) {
    return false;
  }
  const title = $('#editor-title');
  const verdict = await writeChapterBody(id, {
    content: editor ? editor.innerHTML : '',
    title: title ? title.value : '',
    confirmEmpty: true
  });
  if (verdict !== 'saved') { toast('清空未完成：内容没有被改动', 'error'); return false; }
  state.editorEmptyBlocked = null;
  state.editorSaveFailedSnapshot = null;
  const box = document.getElementById('chapter-recovery');
  const cur = state.chapters.find((c) => c.id === id);
  if (box && cur) box.innerHTML = recoveryBarHtml(cur);
  toast('已清空本章正文（原正文已存为历史版本，可随时恢复）', 'success');
  return true;
}

/** 空内容暂停时的一键救济：取回本页之外最近一次保存过的正文。 */
async function restoreLastSavedVersion() {
  const editor = $('#editor-content');
  const id = Number(editor?.dataset.chapterId) || Number(state.editorEmptyBlocked?.id) || 0;
  if (!id) { toast('没有正在编辑的章节', 'error'); return false; }
  let list = [];
  try {
    list = await api(`/chapter_versions?chapter_id=${id}`);
  } catch (e) {
    toast('读取历史版本失败：' + e.message, 'error');
    return false;
  }
  const usable = (Array.isArray(list) ? list : []).filter((v) => readableCharCount(v.content) > 0);
  if (!usable.length) { toast('这一章还没有可恢复的历史版本', 'error'); return false; }
  const latest = usable[0];
  if (typeof confirm === 'function'
      && !confirm(`取回最近一次保存过的正文吗？\n\n版本时间：${String(latest.created_at || '').replace('T', ' ').slice(0, 16)} · ${readableCharCount(latest.content)} 字\n当前正文会先自动备份为一条历史版本。`)) {
    return false;
  }
  return restoreSaveVersion(latest.id);
}

// ---------- 版本基线的同步（2026-10-02）----------
/**
 * 本页之外有通道写了某一章正文之后，把**本地基线**（state.chapters[].updated_at / content）
 * 拉回服务端真值。
 *
 * 为什么必须有：编辑器保存用的是乐观锁 `_if_updated_at`，而批量生成写回、取回生成稿、
 * 确认清空、历史版本恢复这几条通道都不经编辑器 —— 它们写完正文就会推进 updated_at，
 * 本地那一行却还停在旧值。于是**下一次自动保存必然 409**，作者看到的是"保存冲突"，
 * 而冲突的另一方其实就是他自己刚刚做的那个动作（真实事故的形状，服务端注释里也记过一次）。
 *
 * 什么时候**不**同步：编辑器里还有未保存的稿子、或有写入在途。那正是乐观锁要保护的场景，
 * 此时同步等于替作者把"别人改过"这件事抹掉 —— 真冲突仍然必须由作者选一版。
 * 拉取失败静默返回 null：它只是为了让下一次保存更顺，不该阻塞任何主流程。
 */
async function refreshChapterBaselineAfterForeignWrite(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return null;
  const sameChapter = (snap) => snap && Number(snap.id) === id;
  if (state.editorConflictSnapshot || sameChapter(state.editorSaveSnapshot) || sameChapter(state.editorEmptyBlocked)) return null;
  const editor = $('#editor-content');
  if (editor && Number(editor.dataset.chapterId) === id && state.editorSaveInFlight.has(id)) return null;
  try {
    const row = await api(`/chapters/${id}`);
    if (!row || Number(row.id) !== id) return null;
    const idx = state.chapters.findIndex((c) => c.id === id);
    if (idx >= 0) state.chapters[idx] = row;
    else state.chapters.push(row);
    return row;
  } catch (_) {
    return null; // 拉不到就保持现状：宁可下一次保存再撞一次乐观锁，也不假装基线已同步
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
  // 空快照要看得懂：正文为空的历史版本只可能来自"当时编辑器是空的"（多为清空后自动保存），
  // 它是合法记录、不该删，但也不该让作者以为"这一版有内容可以恢复"（2026-10-02 实测遇到）。
  const isEmptySnapshot = (v) => wordCount(v.content) === 0;
  const body = versions.length ? versions.map((v) => `
    <div class="version-item">
      <div class="row">
        <b>${esc(v.title || '未命名章节')}</b>
        <span class="muted grow" style="font-size:12px">${esc((v.created_at || '').replace('T', ' ').slice(0, 16))}</span>
        ${isEmptySnapshot(v)
          ? '<span class="muted" style="font-size:12px" title="这一版正文为空（当时编辑器没有文字，通常是清空后自动保存留下的）">空快照</span>'
          : `<span class="muted" style="font-size:12px">${wordCount(v.content)}字</span>`}
        <button class="btn small secondary" data-action="view-version" data-id="${v.id}">查看</button>
        ${isEmptySnapshot(v)
          ? '<button class="btn small" disabled title="这一版正文为空，恢复它等于清空本章正文">恢复</button>'
          : `<button class="btn small" data-action="restore-version" data-id="${v.id}">恢复</button>`}
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

async function viewSaveVersion(id) {  const editor = $('#editor-content');
  const chapterId = editor ? Number(editor.dataset.chapterId) : state.currentChapterId;
  const versions = await api(`/chapter_versions?chapter_id=${chapterId}`);
  const v = versions.find((x) => x.id === Number(id));
  if (!v) return;
  // 空快照的预览要说清它是什么，而不是只给一句"（空内容）"——否则作者不知道这是故障还是记录。
  const empty = wordCount(v.content) === 0;
  openModal({
    title: `历史版本 · ${v.title || '未命名章节'}`,
    body: empty
      ? '<div class="muted">（空快照：这一版正文是空的。通常是当时编辑器被清空后由自动保存留下的记录，不是正文丢失。）</div>'
      : `<div class="version-preview">${sanitizeEditorHtml(v.content)}</div>`,
    footer: `<button class="btn secondary" data-close-modal>关闭</button>${empty ? '' : `<button class="btn" data-action="restore-version" data-id="${v.id}">恢复此版本</button>`}`,
    large: true
  });
}

async function restoreSaveVersion(id) {
  if (!confirm('确定恢复该历史版本吗？当前内容会自动备份为一条新的历史记录。')) return false;

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
    // 恢复是"从历史换回正文"：被换掉的正文已经备份，残留的暂停/失败/冲突态随之失效，
    // 否则下一次自动保存仍会以为自己处在"待处理"状态。
    state.editorEmptyBlocked = null;
    state.editorSaveFailedSnapshot = null;
    state.editorConflictSnapshot = null;
    state.editorSaveSnapshot = null;
    clearTimeout(state.editorSaveTimer);
    state.editorSaveTimer = null;
    closeModal();
    await render();
    // 恢复这条通道直接改了正文：把本地基线拉回服务端真值（含推进后的 updated_at），
    // 否则紧接着的第一次编辑保存会因为标记过期而误报冲突 —— 冲突的另一方就是刚做的恢复。
    await refreshChapterBaselineAfterForeignWrite(updated.id);
    toast('已恢复历史版本', 'success');
    return true;
  } catch (e) {
    toast('恢复失败：' + e.message, 'error');
    return false;
  }
}

// ---------- 生成稿草稿 / 上次审稿的取回 ----------
function previewChapterDraft() {
  const d = state.chapterDraft;
  if (!d) return;
  openModal({
    title: '未应用的生成稿草稿',
    body: `<div class="muted" style="margin-bottom:6px">生成于 ${esc(String(d.created_at || '').replace('T', ' ').slice(0, 16))} · ${Number(d.chars) || 0} 字 · 尚未写入正文</div>
      <div class="version-preview">${sanitizeEditorHtml(d.content || '')}</div>`,
    footer: `<button class="btn secondary" data-close-modal>关闭</button>
      <button class="btn" data-action="restore-draft">取回到正文</button>`,
    large: true
  });
}

/** 把草稿写回正文：走 POST /novel/chapter_save（旧稿自动存历史版本，可再撤回）。 */
async function restoreChapterDraft() {
  const d = state.chapterDraft;
  const chapterId = Number(d?.chapter_id) || state.currentChapterId;
  if (!d || !chapterId) return;
  if (!confirm('取回这版生成稿并覆盖当前正文吗？（当前正文会自动存为一条历史版本）')) return;
  try {
    // ⚠️ 必须转成段落 HTML 再写回（2026-10-01 实测缺陷）：草稿来自 AI 成文的**纯文本**，
    // 直接当 HTML 写进正文会让浏览器把全部换行折叠掉——正文变成一整段，看起来"取回后没重新排版"。
    // 服务端已在写入/读取两侧归一化，这里再兜一层：任何来源的草稿都不会再以裸文本进正文。
    // 已含 <p>/<br> 的草稿原样写回（不会被二次包装）。
    const isHtml = /<\/?(p|br|div|h[1-6]|blockquote|ul|ol|li|b|strong|i|em|u|span|a)\b[^>]*>/i.test(String(d.content || ''));
    const content = isHtml ? d.content : textToParagraphsHtml(d.content || '');
    await api('/novel/chapter_save', { method: 'POST', body: { chapter_id: chapterId, content } });
    // 这份草稿的内容已经进正文了：标记为已应用，恢复条不再把它当成"未应用的生成稿"
    // （2026-10-02：正文与草稿逐字相同、界面却还在提示未应用）。标记失败只影响提示，不影响写入。
    await api('/novel/draft/consume', { method: 'POST', body: { chapter_id: chapterId, draft_id: Number(d.id) || 0 } }).catch(() => { /* 提示层，失败可忽略 */ });
    state.chapterDraft = null;
    state.loadedWorkId = null;
    closeModal();
    // 取回这条通道自己推进了该章 updated_at：**先**把本地基线拉回服务端真值，再做整页刷新。
    // loadWorkData 里会 flushSave（把本页待落盘的稿子写完），而那份稿子用的正是这一行的
    // updated_at —— 旧实现把同步放在 loadWorkData **之后**，于是任何一份待落盘稿子都会撞上
    // 乐观锁，界面报「取回失败：本地内容尚未保存，请先处理保存冲突」，而正文其实早就取回成功了。
    await refreshChapterBaselineAfterForeignWrite(chapterId);
    await loadWorkData(true);
    await render();
    toast('已取回生成稿（旧稿已存历史版本）', 'success');
  } catch (e) {
    toast('取回失败：' + e.message, 'error');
  }
}

/**
 * 关闭一份生成稿的提示：作者明确表示"这一版我不要了"。
 * 只做一件事——让这条提示以后不再出现；正文一个字都不动，内容也不删除
 * （服务端只打标记，见 dismissDraft）。因此它不属于任何写路径，失败也不影响写作。
 */
async function dismissChapterDraft() {
  const d = state.chapterDraft;
  const chapterId = Number(d?.chapter_id) || Number(state.currentChapterId) || 0;
  if (!d || !chapterId) return;
  if (!confirm('关闭这份生成稿的提示吗？\n\n· 正文不会改动；\n· 这一版以后不再出现在编辑器上方；\n· 内容不会被删除，但界面上也不再提供取回入口。')) return;
  try {
    const res = await api('/novel/draft/dismiss', {
      method: 'POST',
      body: { chapter_id: chapterId, draft_id: Number(d.id) || 0 }
    });
    // 本地与服务端同步：服务端返回"关掉之后还剩的那一份"（可能是更早的未应用草稿，也可能没有）。
    // 只改服务端、不动本地的话，这条提示会一直挂在屏幕上直到切章 —— 上一轮就犯过
    // 「标记与展示不同步」的错（见 markJobApplied 的注释）。
    state.chapterDraft = res?.draft || null;
    refreshRecoveryBar();
    toast(res?.draft ? '已关闭这一版；这一章还有更早的一份未应用生成稿' : '已关闭这份生成稿的提示', 'success');
  } catch (e) {
    toast('关闭失败：' + e.message, 'error');
  }
}

/**
 * 关闭一条长任务的结果提示（作者："这些结果我永远也不想要了"）。
 *
 * 复用既有机制：服务端 `POST /harness/mark_applied` 把该行 kind 追加 ':applied'，
 * 恢复条查询（`kind NOT LIKE '%:applied'`）据此排除。它与"结果已应用"共用同一个开关，
 * 因为两者对界面的意义相同：**这条产出不用再提示了**。产出内容不删除（仍在 harness_jobs.output），
 * 正文一个字都不动。
 *
 * 与自动标记 markJobApplied 的唯一差别：**先等服务端确认，再收起本地那一行**。
 * 自动路径是"打开弹窗顺手标一下"，失败无所谓；而作者亲手点的关闭若只改本地，
 * 刷新后那条提示会自己回来 —— 那比不关更糟。
 */
async function dismissJobResult(jobId) {
  const id = String(jobId || '');
  if (!id) return;
  const job = (Array.isArray(state.chapterJobs) ? state.chapterJobs : []).find((j) => String(j.id) === id);
  const what = job?.stage || '这次 AI 产出';
  if (!confirm(`关闭「${what}」这条结果提示吗？\n\n· 本章正文不会改动；\n· 以后不再提示这条结果；\n· 任务记录与产出内容仍留在库里（不会被删除）。`)) return;
  try {
    await api('/harness/mark_applied', { method: 'POST', body: { job_id: id } });
  } catch (e) {
    // 服务端没记下来就绝不移除本地那一行：否则作者看到"关掉了"，刷新后它又回来。
    toast('关闭失败：' + e.message, 'error');
    return;
  }
  state.chapterJobs = (Array.isArray(state.chapterJobs) ? state.chapterJobs : []).filter((j) => String(j.id) !== id);
  refreshRecoveryBar();
  toast('已关闭这条结果提示', 'success');
}

/**
 * 关闭「上次审稿」那条提示（2026-10-04，与草稿/任务两处同一个形状：那一行也只有"要它"的出口）。
 *
 * 只做一个标记：服务端把该条 review 标 dismissed=1，恢复条不再显示它。
 * **不删审稿报告**（GET /novel/review 照常返回该行），也不动正文 —— 这个动作只关于提示。
 * 与 dismissJobResult 同理：等服务端确认再收起本地那一行，失败就保留并报错。
 */
async function dismissChapterReview() {
  const r = state.chapterReview;
  const chapterId = Number(r?.chapter_id) || Number(state.currentChapterId) || 0;
  if (!r || !chapterId) return;
  if (!confirm('关闭「上次审稿」这条提示吗？\n\n· 正文不会改动；\n· 以后不再提示这一份审稿；\n· 报告内容不会被删除，仍留在库里。')) return;
  try {
    const res = await api('/novel/review/dismiss', {
      method: 'POST',
      body: { chapter_id: chapterId, review_id: Number(r.id) || 0 }
    });
    // 服务端返回的是"关闭之后的真值"（同一份记录，dismissed=1）：本地照它更新，
    // 恢复条那一条随即消失（判据是 reviewOk 里的 !r.dismissed），不必自己猜。
    state.chapterReview = res?.review || null;
    refreshRecoveryBar();
    toast('已关闭「上次审稿」的提示', 'success');
  } catch (e) {
    toast('关闭失败：' + e.message, 'error');
  }
}

/** 打开最近一次审稿报告；解析失败时展示原文，保证几分钟的等待一定有产物可看。 */async function openLastReview() {
  const chapterId = Number(state.chapterReview?.chapter_id) || state.currentChapterId;
  if (!chapterId) return;
  let review = state.chapterReview;
  try {
    const data = await api(`/novel/review?chapter_id=${chapterId}`);
    review = data.review || review;
    state.chapterReview = review;
  } catch (_) { /* 用缓存兜底 */ }
  if (!review) {
    toast('这一章还没有审稿记录', 'error');
    return;
  }
  const report = review.report || {};
  if (!review.parsed) {
    openModal({
      title: '上次审稿 · 原文（格式异常未能解析）',
      body: `<div class="muted" style="margin-bottom:6px">${esc(String(review.created_at || '').replace('T', ' ').slice(0, 16))} · 报告原文如下，可直接阅读</div>
        <pre class="raw-review">${esc(String(report.raw_text || '（无原文）').slice(0, 20000))}</pre>`,
      footer: `<button class="btn secondary" data-close-modal>关闭</button>`,
      large: true
    });
    return;
  }
  // 结构化报告：复用正常审稿弹窗。
  // ⚠️ 底稿与绑定都用**函数自己算出的 chapterId**（来自 review.chapter_id），而不是 state.currentChapterId：
  // 报告是"按章"读出来的，以它为准才不会张冠李戴；两者若不同，由 revisionBaseArticle 去取
  // 那一章已保存的正文（取不到就把底稿留空，让「按清单修稿」被前置校验拦下，而不是拿错章的正文去修）。
  let article = '';
  try {
    article = await revisionBaseArticle(chapterId);
  } catch (e) {
    toast('取不到该章正文，报告仍可查看，但不能按清单修稿：' + e.message, 'error');
  }
  state.pendingReview = {
    info: { article, scan: null, proposals: null, targetWords: resolveTargetWords(), chapterId },
    review: report
  };
  showReviewReport(report);
}

// ---------- 长任务：接回进度 / 取回结果 ----------
/**
 * 刷新页面后接着盯同一条 harness 任务。
 *
 * 背景：一次成文/审稿要跑几分钟，此前 job_id 只活在页面内存里 ——
 * 刷新页面就等于失联，任务照跑但再也拿不回结果（2026-09-14 真实事故的放大器）。
 * 现在任务 id 与状态落在库里，这里把它接回来，并在完成时按 kind 落地。
 */
async function resumeHarnessJob(jobId) {
  if (!jobId) return;
  if (state.aiTaskRunning) {
    toast('已有 AI 任务进行中，请等它结束再接入其它任务', 'error');
    return;
  }
  // ⚠️ 检查之后立即置位：与 runHarnessJob 同一条规则——检查与置位之间只要隔着一个
  // await（这里原本隔着 /harness/recovered 的 GET），两次点击就能同时穿过互斥检查。
  state.aiTaskRunning = true;
  try {
    let job = null;
    try {
      const data = await api(`/harness/recovered?id=${encodeURIComponent(jobId)}`);
      job = data.job;
    } catch (e) {
      toast('读取任务失败：' + e.message, 'error');
      return;
    }
    if (!job) return;
    if (!job.resumable) {
      toast(job.restart_lost
        ? '这条任务在服务重启后已中断，无法接回；可点「取回结果」看是否留有产出'
        : '这条任务已经结束，请直接点「取回结果」', 'error');
      return;
    }
    const label = isBlueprintJob(job)
      ? '📐 蓝图'
      : (job.stage || (job.kind === 'review' ? 'AI 审稿' : job.kind === 'revision' ? 'AI 修稿' : 'AI 写作'));
    if (typeof traceLongOp === 'function') traceLongOp(label);
    const progress = showAITaskProgress(`${label} · 已接回进度，正在等待完成…`);
    try {
      const result = await pollHarnessJob(jobId, progress, { timeoutMs: 3600000 });
      await finalizeHarnessOutput({
        ...result,
        kind: result.kind || job.kind,
        chapter_id: result.chapter_id || job.chapter_id,
        // 服务端按产出内容判定过"这是不是蓝图"（历史行的 kind 与成文轮同为 prose）。
        is_blueprint: job.is_blueprint === true
      });
    } catch (e) {
      if (e.interrupted) {
        toast(e.message, 'error');
      } else if (!e.cancelled) {
        toast('接回失败：' + e.message, 'error');
      }
      await refreshChapterRecovery(state.currentChapterId);
      await render();
    } finally {
      progress.close();
    }
  } finally {
    // ⚠️ 无条件释放互斥锁：pollHarnessJob 会再次置位，但收尾只发生在 runHarnessJob
    // 的 finally 里 —— 「接回进度」这条路不走它。这里不释放的话，一次失败/成功的
    // 接回（包括上面提前 return 的路径）都会让所有 AI 任务被永久锁死，直到刷新页面。
    state.aiTaskRunning = false;
  }
}

/** 取回一条已完成但没被应用的产出（刷新页面或重启服务之后仍然可用）。 */
async function fetchHarnessJobResult(jobId) {
  if (!jobId) return;
  let job = null;
  try {
    const data = await api(`/harness/recovered?id=${encodeURIComponent(jobId)}`);
    job = data.job;
  } catch (e) {
    toast('读取任务失败：' + e.message, 'error');
    return;
  }
  if (!job || !job.output) {
    toast('这条任务没有可取回的产出', 'error');
    return;
  }
  // 蓝图不是正文：即使通过旧界面/历史入口走到这里，也绝不把它当稿子应用
  //（"一份【蓝图】JSON 被写进章节正文"是 2026-10-01 / 2026-10-04 两次真实事故的形状）。
  if (isBlueprintJob(job)) {
    toast('这是章节蓝图（写作计划），不是正文：请在编辑器上方的「已保存蓝图」里点「生成」按它成文', 'error');
    await refreshChapterRecovery(state.currentChapterId);
    return;
  }
  await finalizeHarnessOutput({
    output: job.output,
    kind: job.kind,
    stage: job.stage,
    chapter_id: job.chapter_id,
    job_id: job.id,
    is_blueprint: job.is_blueprint === true
  });
}

/**
 * 生成差异预览 / 审稿用的**底稿正文**。
 *
 * 为什么要按章取：修稿要跑几分钟，作者完全可能在这期间切到别的章，
 * 而"接回进度 / 取回结果"是按**章**归属的。用"当前编辑器正文"当底稿会有两个后果：
 *   ① 拿 B 章的段落去匹配 A 章的补丁 —— anchor 全落空，或更糟：在同文库的其它章里
 *      恰好命中相同段落，于是差异预览显示的是别处的改动；
 *   ② 合并时把 A 章的修稿稿写进 B 章（B 章原文只留在历史版本里）。
 * 规则：目标章 == 当前打开的章 → 用编辑器（含未保存改动，最准）；
 *       否则用**库里那一章已保存的正文**（取不到就抛错，由调用方明确告知，不猜）。
 */
async function revisionBaseArticle(chapterId) {
  const target = Number(chapterId) || null;
  const current = Number(state.currentChapterId) || null;
  const editor = $('#editor-content');
  if (!target) return editor ? editorPlainText(editor.innerHTML) : '';
  // 目标章就是当前章**且编辑器在 DOM 里** → 用编辑器（含未保存改动，最准）。
  // ⚠️ 编辑器只在写作视图存在：切到总览/设定/日志等视图后 `#editor-content` 被卸载，
  // 此时若还走编辑器分支就会**静默拿到空串**（契约是"取不到就抛错，由调用方明确告知，不猜"）——
  // 「接回进度」等待期间切视图正好命中这条路（第五轮重审抓到）。所以这里退回库里的正文。
  if (target === current && editor) return editorPlainText(editor.innerHTML);
  const row = await api(`/chapters/${target}`);
  // ⚠️ "读不到这一章"与"这一章没有正文"必须**分开**（本函数头注释的契约：取不到就抛错，不猜）：
  // 下游（合并闸门）按指纹判断"正文有没有被动过"，而空正文是**合法**的底稿（AI 写作草稿链
  // 合并的就是一个空章）。这里若把"取不到行"也返回空串，两者就再也分不出来，
  // 闸门只能二选一：要么永远拦住空章（2026-10-06 报障的形状），要么把读失败当"正文没变"放行。
  if (!row) throw new Error('读不到这一章的正文');
  return row.content ? editorPlainText(row.content) : '';
}

// 章节标题查询（差异预览与提示文案用）。查不到时退回 `#id`，绝不显示 undefined。
function chapterTitleOf(id) {
  const n = Number(id) || null;
  if (!n) return '';
  return state.chapters.find((c) => c.id === n)?.title || `#${n}`;
}

/**
 * 把一条 harness 产出按语义落地。
 * - 成文类：**落成章节草稿**并打开「AI 写作结果」弹窗，绝不自动覆盖正文；
 * - 审稿：解析后存 chapter_reviews 并打开审稿报告弹窗；
 * - 修稿：解析正文后直接走差异预览。
 * @param {{output:string, kind?:string, stage?:string, chapter_id?:number, job_id?:string}} r
 */
async function finalizeHarnessOutput(r) {
  const kind = String(r.kind || 'harness');
  const output = String(r.output || '');
  // 蓝图轮不是成文轮（见 isBlueprintJob）：它的产出是一份计划，把它当稿子应用就是事故。
  // 这里再兜一层 —— 历史入口（旧页面、接回进度）不该有能力把蓝图写进正文。
  if (kind === 'blueprint' || isBlueprintJob({ kind, is_blueprint: r.is_blueprint })) {
    toast('这是章节蓝图（写作计划），不是正文：请在编辑器上方的「已保存蓝图」里点「生成」按它成文', 'error');
    await refreshChapterRecovery(Number(r.chapter_id) || state.currentChapterId);
    return;
  }
  if (!output.trim()) {
    toast('任务产出为空，无法应用', 'error');
    return;
  }
  const chapterId = Number(r.chapter_id) || state.currentChapterId;

  if (kind === 'review') {
    const { stage: rstage, report } = parseReviewText(output);
    try {
      await api('/novel/finalize', {
        method: 'POST',
        body: { kind: 'review', chapter_id: chapterId, output, job_id: r.job_id }
      });
    } catch (_) { /* 落库失败仍然把报告显示出来，不让用户白等 */ }
    // 服务端 finalize 已把任务标记 applied；本地同步移除，恢复条立即刷新（markJobApplied）。
    markJobApplied(r.job_id);
    if (!report) {
      toast('审稿报告格式异常，已保存原文（可在章节里点「查看上次审稿」）', 'error');
      await refreshChapterRecovery(chapterId);
      await render();
      return;
    }
    if (rstage === 'salvaged') toast('审稿报告格式有瑕疵，已尽力抢救出可读部分（可能少一两条）', 'error');
    // 底稿按任务自带的 chapter_id 取：作者可能是"看着 B 章取回 A 章的审稿"，
    // 用当前编辑器正文会让随后的「修稿」拿着 B 章的段落去套 A 章的清单。
    let article = '';
    try {
      article = await revisionBaseArticle(chapterId);
    } catch (e) {
      toast('取不到该章正文，审稿报告仍可查看，但「按清单修稿」会被拦下（切到该章后重试即可）：' + e.message, 'error');
    }
    state.pendingReview = {
      info: { article, scan: null, proposals: null, targetWords: resolveTargetWords(), chapterId },
      review: report
    };
    showReviewReport(report);
    await refreshChapterRecovery(chapterId);
    await render();
    return;
  }

  if (kind === 'revision') {
    // 补丁的 anchor 是对着**某一章**的正文生成的，所以底稿必须取自那一章（见 revisionBaseArticle）。
    // 注：这里曾经有个 `fallbackArticle` 参数，但两个调用点都传空串、没有任何生产者 ——
    // 一个"看起来能传底稿"的死字段比没有更糟（第五轮重审删掉，底稿一律按章取）。
    let base = '';
    try {
      base = await revisionBaseArticle(chapterId);
    } catch (e) {
      toast('取不到该章正文，无法生成差异预览（可切到该章后重试取回）：' + e.message, 'error');
      return;
    }
    // 底稿为空就到此为止：空底稿下补丁一条也命中不了，而"回退整章重写"会把模型输出
    // （补丁式时就是那段 JSON）当成正文展示并允许合并 —— 宁可什么都不做。
    if (!base.trim()) {
      toast('这一章还没有正文，无法生成修稿差异预览（先写入正文再重试取回）', 'error');
      return;
    }
    // 修稿产出有两种形态：补丁式（新的默认，输出 JSON）与整章重写（兜底/历史任务）。
    // 这里必须两种都认——否则刷新后接回进度，会把 JSON 当成正文塞进差异预览。
    const patched = tryApplyRevisionOutput(output, base, patchSafetyOptions(chapterId));
    let revised = '';
    let notes = [];
    let safetyBlocked = [];
    let safetyFindings = [];
    if (patched && patched.ok) {
      // 空补丁 = 合法"无修改"：不展示差异预览（没有差异），如实告知并收尾。
      if (patched.noop) {
        toast('这份修稿任务没有产生任何改动（补丁为空，正文保持原样）', 'success');
        markJobApplied(r.job_id);
        await refreshChapterRecovery(chapterId);
        await render();
        return;
      }
      revised = patched.text;
      notes = patched.unresolved.map((u) => u.reason + '：' + (u.anchor || '').slice(0, 40));
      safetyBlocked = patched.blocked || [];
      safetyFindings = patched.findings || [];
      // 全部补丁被拦 = 正文原样保留（**不回退整章重写**：那是一次付费且无门禁的整章覆盖）。
      if (patched.allBlocked) toast('这一版修稿的高风险改动全部被安全门禁拦下（未写入正文），原因见差异预览', 'error');
    } else {
      revised = parseAIWritingOutput(output).finalText || output;
    }
    if (!revised.trim()) {
      toast('修稿结果为空，无法应用', 'error');
      return;
    }
    // 接回进度这条路径**不知道**作者勾选了几条（任务元数据里没存清单），只知道实际改好了几处。
    // 所以只传 applied，让标题按「实际改好 N 处」措辞——不再借用"按 N 条清单修改"的口径。
    // chapterId：把差异预览绑定到任务自带的章号，合并时不再依赖"当前打开的章"。
    // 补丁路径已经报过门禁结论；整章重写路径（没有补丁可查）在这里补一次修后核验。
    if (!safetyBlocked.length && !safetyFindings.length) safetyFindings = patchSafetyVerify(base, revised, patchSafetyOptions(chapterId));
    showReviewDiff(base, revised, { applied: (patched && patched.applied ? patched.applied.length : 0), notes, chapterId, blocked: safetyBlocked, findings: safetyFindings });
    // 修稿结果已交付（差异预览已打开），标记任务已应用，恢复条不再重复提示。
    markJobApplied(r.job_id);
    await refreshChapterRecovery(chapterId);
    await render();
    return;
  }

  // 成文类：解析出正文 → 交给统一的结果弹窗。
  // 注意不要在这里再 POST /novel/finalize：结果弹窗自己会落草稿（showAIWritingResult），
  // 这里再落一份就是重复草稿；任务标记改由弹窗里的 mark_applied 完成。
  const article = parseAIWritingOutput(output).finalText || output;
  if (!article.trim()) {
    toast('成文结果为空，无法应用', 'error');
    return;
  }
  await refreshChapterRecovery(chapterId);
  await render();
  const mode = await showAIWritingResult(article, null, null, resolveTargetWords(), r.job_id, { chapterId });
  // 取回场景下的模式处理要显式：applyAIWritingArticle 只处理 insert/replace/append，
  // 'regenerate'/'null' 在这里是静默 no-op —— 用户点了按钮却没反应，等于丢输入。
  if (mode === null) return; // 用户取消
  if (mode === 'regenerate') {
    toast('请从「AI 写作」重新发起生成；本版结果已存为草稿，可随时取回', 'info');
    return;
  }
  await applyAIWritingArticle(mode, article, chapterId);
}

// ---------- terms view ----------
async function renderTerms(content) {
  const categories = state.categories;
  const terms = state.terms;
  const activeCat = state.currentCategoryId;
  const filtered = terms.filter((t) => activeCat === 'all' || t.category_id === activeCat);
  const selected = state.currentTermId ? terms.find((t) => t.id === state.currentTermId) || null : null;
  // F-28：分类计数预建 Map，避免每个分类都对 terms 全量 filter。
  const countByCat = new Map();
  for (const t of terms) countByCat.set(t.category_id, (countByCat.get(t.category_id) || 0) + 1);

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
            <span class="muted">(${countByCat.get(c.id) || 0})</span>
            <button class="btn small danger" data-action="delete-category" data-id="${c.id}">删</button>
          </div>
        `).join('')}
        <div class="mt-12" style="display:flex;gap:6px"><button class="btn small secondary" data-action="new-term">＋ 新建词条</button><button class="btn small secondary" data-action="ai-gen-terms-new" title="AI 生成词条（可一次生成多条）">✨ AI 词条</button></div>
      </div>
      <div class="panel terms-list">
        <div class="mb-8"><input id="term-search" placeholder="搜索词条..." value=""></div>
        <div id="term-list">
          ${filtered.length ? filtered.map((t) => `
            <div class="term-item ${selected && selected.id === t.id ? 'active' : ''}" data-action="select-term" data-id="${t.id}">
              <b>${esc(t.title)}</b>
              <span class="muted grow" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.tags || '')}</span>
            </div>
          `).join('') : '<div class="muted">暂无词条</div>'}
        </div>
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
  // F-28：预建 (plotline_id,character_id)→记录 Map，渲染剧情线级状态时 O(1) 查询。
  const pcByKey = new Map();
  for (const p of state.plotlineCharacters) pcByKey.set(`${p.plotline_id}_${p.character_id}`, p);

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
              const pc = pcByKey.get(`${p.id}_${selected.id}`);
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

// ---------- 创作上下文（历史名 SillyTavern 设置；R06 只改用户面命名，内部 st/renderST 保持不变） ----------
// R07：编辑规则卡（三档编辑 / 七项能力 / 题材档）。这一块只负责**作者意图**的读写与预览：
// 规则块本身由宿主装配器产出（/novel/editing 返回目录与选择），打开后真的进入 assembled。
async function loadEditRules(force = false) {
  if (state.editRules && !force) return state.editRules;
  try {
    const data = await api('/novel/editing');
    state.editRules = { catalog: data.catalog, selection: data.selection };
  } catch (_) {
    state.editRules = null; // 旧服务端没有该接口：如实显示"不可用"，不假装有开关
  }
  return state.editRules;
}

function renderEditRulesCard() {
  const er = state.editRules;
  if (!er) {
    return `<div class="card mb-12"><div class="card-head"><span class="card-title">编辑规则（三档编辑 / 创作能力 / 题材）</span></div>
      <div class="muted">当前服务端不提供该接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  const sel = er.selection || {};
  const abilities = (er.catalog && er.catalog.abilities) || [];
  const tiers = (er.catalog && er.catalog.tiers) || [];
  const genres = (er.catalog && er.catalog.genres) || [];
  const picked = new Set(sel.abilities || []);
  return `
    <div class="card mb-12">
      <div class="card-head">
        <span class="card-title">编辑规则（三档编辑 / 创作能力 / 题材）</span>
        <button class="btn small secondary" data-action="scan-edit-rules" title="按已启用能力对当前章节做确定性检查（不调用模型、不花额度）">🔍 扫描本章</button>
        <button class="btn small" data-action="save-edit-rules">保存编辑规则</button>
      </div>
      <div class="muted" style="font-size:12px">默认关闭；关闭时这些规则**不进入**发给模型的提示词（旧作品行为不变）。打开后规则块进入上下文，并在「运行追踪 / 上下文贡献记录」里留下版本与内容 hash。</div>
      <label class="row mt-8"><input type="checkbox" id="edit-rules-enabled" ${sel.enabled ? 'checked' : ''}> 启用编辑规则块（会进入写作请求）</label>
      <div class="row mt-8" style="flex-wrap:wrap;gap:18px;align-items:flex-start">
        <div>
          <b style="font-size:13px">编辑档位</b>
          ${tiers.map((t) => `<label class="row" style="font-weight:400"><input type="radio" name="edit-tier" value="${esc(t.id)}" ${sel.tier === t.id ? 'checked' : ''}> ${esc(t.name)}<span class="muted" style="font-size:12px">（${esc(t.summary)}）</span></label>`).join('')}
        </div>
        <div>
          <b style="font-size:13px">题材档</b>
          <div><select id="edit-genre">${genres.map((g) => `<option value="${esc(g.id)}" ${sel.genre === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
        </div>
      </div>
      <div class="mt-8">
        <b style="font-size:13px">创作能力（默认关闭；只加载任务/题材适用的）</b>
        <div class="st-character-list">
          ${abilities.map((a) => `
            <div class="st-character-item">
              <label class="row" style="font-weight:400">
                <input type="checkbox" class="edit-ability" value="${esc(a.id)}" ${picked.has(a.id) ? 'checked' : ''}>
                <b>${esc(a.name)}</b>
                <span class="muted" style="font-size:12px">${esc(a.summary)}｜适用：${esc((a.tasks || []).join(' / '))}${a.genre_affinity && a.genre_affinity.length ? `｜题材：${esc(a.genre_affinity.join(' / '))}` : '｜不限题材'}</span>
              </label>
            </div>`).join('')}
        </div>
      </div>
      <div class="muted mt-8" style="font-size:12px">规则版本 v${esc((er.catalog && er.catalog.version) || '')}｜当前档位 ${esc(sel.tier || '')}｜题材 ${esc(sel.genre || '')}｜已启用能力 ${(sel.abilities || []).length} 项</div>
      <div id="edit-rules-scan" class="mt-8">${renderEditScanHtml(state.editScan)}</div>
    </div>`;
}

function collectEditSelection() {
  const enabledEl = $('#edit-rules-enabled');
  const tierEl = $$('input[name="edit-tier"]').find((el) => el.checked);
  const genreEl = $('#edit-genre');
  const abilities = $$('.edit-ability').filter((el) => el.checked).map((el) => el.value);
  return {
    enabled: !!(enabledEl && enabledEl.checked),
    tier: tierEl ? tierEl.value : 'light',
    genre: genreEl ? genreEl.value : 'general',
    abilities,
  };
}

async function saveEditRules() {
  const selection = collectEditSelection();
  const data = await api('/novel/editing', { method: 'PUT', body: selection });
  state.editRules = { catalog: state.editRules ? state.editRules.catalog : null, selection: data.selection };
  state.aiContext = null; // 规则块变了：下次写作重新装配（不能用旧上下文）
  toast(`已保存编辑规则（${selection.enabled ? '已启用' : '已关闭'}）`, 'success');
  await render();
}

function renderEditScanHtml(data) {
  if (!data) return '';
  const findings = data.findings || [];
  if (!findings.length) return '<div class="muted">确定性检查没有发现问题。</div>';
  return `<div class="muted" style="font-size:12px">确定性检查命中 ${findings.length} 条（规则/位置/摘录/建议；语义问题仍走「审稿」的模型链，不在这里下结论）</div>
    <div class="st-character-list">
      ${findings.map((f) => `
        <div class="st-character-item">
          <div class="row"><span class="chip">${esc(f.severity)}</span><b>${esc(f.message)}</b><span class="muted grow" style="font-size:12px">${f.paragraph === null || f.paragraph === undefined ? '' : `第 ${f.paragraph + 1} 段`}</span></div>
          <div class="muted" style="font-size:12px">规则 ${esc(f.rule_id)}：${esc(f.excerpt)}</div>
          <div class="muted" style="font-size:12px">建议：${esc(f.suggestion)}</div>
        </div>`).join('')}
    </div>`;
}

async function scanEditRules() {
  const box = $('#edit-rules-scan');
  if (!state.currentChapterId) { if (box) box.innerHTML = '<div class="muted">先在「正文写作」里选一个章节。</div>'; return; }
  if (box) box.innerHTML = '<div class="muted">扫描中…（确定性检查，不调用模型）</div>';
  try {
    const data = await api('/novel/editing/scan', { method: 'POST', body: { work_id: state.workId, chapter_id: state.currentChapterId } });
    state.editScan = data;
    if (box) box.innerHTML = renderEditScanHtml(data);
  } catch (e) {
    if (box) box.innerHTML = `<div class="muted">扫描失败：${esc(e.message)}</div>`;
  }
}

// ---------- R09：作者样文 / 文风档案 / 三级作者意图 ----------
// 边界：样文与意图是**风格证据与作者偏好**，不是本书事实；本卡只读写作者侧这 3 组端点。
async function loadAuthorStyle(force = false) {
  if (state.authorStyle && !force) return state.authorStyle;
  try {
    const samples = await api(`/novel/style/samples?work_id=${state.workId}`);
    const profile = await api(`/novel/style/profile?work_id=${state.workId}`);
    const intents = await api(`/novel/author_intent?work_id=${state.workId}&chapter_id=${state.currentChapterId || 0}`);
    state.authorStyle = { samples, profile, intents };
  } catch (_) {
    state.authorStyle = null; // 旧服务端没有这些接口：如实显示"不可用"，不假装有
  }
  return state.authorStyle;
}

function authorIntentRow(tier) {
  const a = state.authorStyle;
  const intents = (a && a.intents && a.intents.intents) || [];
  const chapterId = state.currentChapterId || 0;
  return intents.find((x) => x.tier === tier && (tier === 'chapter' ? x.chapter_id === chapterId : x.chapter_id === 0)) || null;
}

function renderAuthorStyleCard() {
  const a = state.authorStyle;
  if (!a) {
    return `<div class="card mb-12"><div class="card-head"><span class="card-title">作者样文与文风档案</span></div>
      <div class="muted">当前服务端不提供该接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  const samples = (a.samples && a.samples.samples) || [];
  const counts = (a.samples && a.samples.counts) || {};
  const limits = (a.samples && a.samples.limits) || {};
  const prof = (a.profile && a.profile.profile) || null;
  const stale = !!(a.profile && a.profile.stale);
  const m = prof && prof.metrics ? prof.metrics : null;
  const merged = (a.intents && a.intents.merged) || { conflicts: [] };
  const conflicts = merged.conflicts || [];
  const tierDefs = [['long_term', '长期方向（整本书）'], ['stage', '当前阶段重点（整本书）'], ['chapter', '本章意图（当前章）']];
  return `
    <div class="card mb-12">
      <div class="card-head">
        <span class="card-title">作者样文与文风档案${helpDot('author_style')}</span>
        <button class="btn small secondary" data-action="new-author-sample">＋ 添加样文</button>
        <button class="btn small secondary" data-action="analyze-author-profile" title="确定性计数：不调用模型、不花额度">📊 分析样文</button>
      </div>
      <div class="muted" style="font-size:12px">样文是**独立数据来源**：只用于文风分析与风格证据（按预算选择后进入请求），<b>不会</b>变成本书的人物/地点/事件/正典事实，也不会改变工具授权。单篇 ≤ ${esc(String(limits.per_sample_chars || 20000))} 字、整书 ≤ ${esc(String(limits.total_chars || 200000))} 字 / ${esc(String(limits.max_samples || 20))} 篇。</div>
      <div class="st-character-list mt-8">
        ${samples.length ? samples.map((s) => `
          <div class="st-character-item">
            <div class="row">
              <label class="row" style="font-weight:400"><input type="checkbox" data-action="toggle-author-sample" data-id="${s.id}" ${s.enabled ? 'checked' : ''}> <b>${esc(s.title || '未命名样文')}</b></label>
              <span class="muted grow" style="font-size:12px">${esc(String(s.chars))} 字｜hash ${esc(String(s.content_hash || '').slice(0, 10))}${s.enabled ? '' : '｜已停用（不参与分析与证据）'}</span>
              <button class="btn small secondary" data-action="edit-author-sample" data-id="${s.id}">编辑</button>
              <button class="btn small secondary" data-action="delete-author-sample" data-id="${s.id}">删除</button>
            </div>
          </div>`).join('') : '<div class="muted">还没有样文。添加作者自己的、或有权使用的片段（可以是旧作，也可以是别人的——须有权使用）。</div>'}
        <div class="muted" style="font-size:12px">合计 ${esc(String(counts.total || 0))} 篇（启用 ${esc(String(counts.enabled || 0))}）｜${esc(String(counts.chars || 0))} 字</div>
      </div>
      <div class="mt-8">
        <b style="font-size:13px">文风档案</b>
        ${prof ? `
          <span class="chip">${stale ? '已过期（样文有改动，请重新分析）' : '有效'}</span>
          <span class="muted" style="font-size:12px">hash ${esc(String((a.profile && a.profile.profile_hash) || '').slice(0, 12))}｜分析版本 ${esc(String((a.profile && a.profile.analysis_version) || ''))}｜语义状态 ${esc(String((a.profile && a.profile.semantic_status) || 'not_run'))}（当前只做确定性计数，未跑模型）</span>
          ${m ? `<div class="muted" style="font-size:12px">平均句长 ${esc(String(m.sentence_length.value.mean))} 字（p50 ${esc(String(m.sentence_length.value.p50))}／p90 ${esc(String(m.sentence_length.value.p90))}）｜对白段占比 ${esc(String(m.dialogue_rate.value.ratio))}｜段均 ${esc(String(m.paragraph_length.value.mean))} 字（长段占比 ${esc(String(m.paragraph_length.value.long_ratio))}）｜每千字比喻 ${esc(String(m.rhetoric_per_1000.value.metaphor))}／排比段 ${esc(String(m.rhetoric_per_1000.value.parallel_paragraphs))}｜每千字情绪词 ${esc(String(m.emotion_per_1000.value))}｜章尾悬疑标记 ${m.suspense_tail.value.ends_with_ellipsis || m.suspense_tail.value.ends_with_question || m.suspense_tail.value.unterminated ? '有' : '无'}</div>
            <div class="muted" style="font-size:12px">口径：${esc(m.sentence_length.how)}；${esc(m.dialogue_rate.how)}；${esc(m.rhetoric_per_1000.how)}</div>` : ''}
          <div class="muted" style="font-size:12px">习惯片段：开头 ${esc((prof.habits.openings || []).join(' / ') || '（样本不足）')}｜结尾 ${esc((prof.habits.closings || []).join(' / ') || '（样本不足）')}｜保留 ${esc((prof.habits.keep || []).join('、') || '（未填）')}｜避免 ${esc((prof.habits.avoid || []).join('、') || '（未填）')}</div>
        ` : '<div class="muted" style="font-size:12px">还没有分析过。点「分析样文」做确定性计数（句长/对白/标点/段落/修辞/情绪/章尾习惯 + 计算口径），不调用模型。</div>'}
      </div>
      <div class="mt-8">
        <b style="font-size:13px">三级作者意图</b>
        <div class="muted" style="font-size:12px">优先级：已确认故事约束与编辑保真 &gt; 当前有效章节契约 &gt; 作者具体风格与意图 &gt; 通用编辑规则。本章意图可覆盖较泛偏好，但**不会**静默取消你设为长期硬约束的要求——冲突会在这里请你裁决。</div>
        ${tierDefs.map(([tier, label]) => {
          const row = authorIntentRow(tier);
          const id = `author-intent-${tier}`;
          return `
          <div class="mt-8">
            <label class="row" style="font-weight:400" for="${id}"><b>${esc(label)}</b>${row && row.hard ? '<span class="chip">硬约束</span>' : ''}${tier === 'chapter' && !state.currentChapterId ? '<span class="muted" style="font-size:12px">（先在「正文写作」里选章节）</span>' : ''}</label>
            <textarea id="${id}" rows="2" placeholder="${tier === 'long_term' ? '整本书都要遵守的方向（例如：叙述克制，不直白抒情）' : tier === 'stage' ? '当前阶段的重点（例如：第二卷写主角与旧友的决裂）' : '本章的特殊要求（可覆盖较泛偏好）'}">${esc(row ? row.text : '')}</textarea>
            <label class="row" style="font-weight:400"><input type="checkbox" id="${id}-hard" ${row && row.hard ? 'checked' : ''}> 设为硬约束（更具体的档位不得静默取消它，冲突必须提请裁决）</label>
          </div>`;
        }).join('')}
        <div class="row mt-8">
          <div class="grow muted" style="font-size:12px">${conflicts.length
            ? `⚠ 需要你裁决：${conflicts.map((c) => `${esc(c.other_tier)}「${esc(c.other_text)}」可能抵消长期方向`).join('；')}`
            : '没有检测到跨档冲突。'}</div>
          <button class="btn small" data-action="save-author-intents">保存三级意图</button>
        </div>
      </div>
    </div>`;
}

function openAuthorSampleModal(sample = null) {
  openModal({
    title: sample ? `编辑样文 · ${sample.title || ''}` : '添加作者样文',
    body: `
      <div class="form-grid">
        <div class="field"><label>标题</label><input id="author-sample-title" value="${esc(sample?.title || '')}" placeholder="例如：我的旧作片段"></div>
        <div class="field"><label>样文正文</label><textarea id="author-sample-text" rows="10" placeholder="粘贴作者自己的、或有权使用的文字（只用于文风分析与风格证据，不会被当作本书设定）">${esc(sample?.text || '')}</textarea></div>
      </div>
      <div class="muted" style="font-size:12px">样文绝不进入正典事实 / 事件账本 / 角色知识；超限（太短/太长/篇数或总量超限）会在保存时报出明确原因。</div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-author-sample" data-id="${sample?.id || ''}">保存样文</button>`,
  });
}

async function saveAuthorSample(id) {
  const title = $('#author-sample-title')?.value || '';
  const text = $('#author-sample-text')?.value || '';
  try {
    if (id) await api('/novel/style/samples', { method: 'PUT', body: { work_id: state.workId, id: Number(id), title, text } });
    else await api('/novel/style/samples', { method: 'POST', body: { work_id: state.workId, title, text } });
    closeModal();
    state.authorStyle = null; // 样文变了：档案可能过期，下次渲染必须重新读服务端
    state.aiContext = null;
    toast('样文已保存（档案需重新分析才会更新；上下文已作废重装）', 'success');
    await render();
  } catch (e) {
    toast(`样文保存失败：${e.message}`, 'error');
  }
}

async function toggleAuthorSample(id, enabled) {
  try {
    await api('/novel/style/samples', { method: 'PUT', body: { work_id: state.workId, id: Number(id), enabled } });
    state.authorStyle = null; state.aiContext = null;
    await render();
  } catch (e) { toast(`切换失败：${e.message}`, 'error'); }
}

async function deleteAuthorSample(id) {
  if (!confirm('删除这篇样文？（只删样文，不影响正文与作品数据）')) return;
  try {
    await api(`/novel/style/samples?work_id=${state.workId}&id=${Number(id)}`, { method: 'DELETE' });
    state.authorStyle = null; state.aiContext = null;
    toast('样文已删除', 'success');
    await render();
  } catch (e) { toast(`删除失败：${e.message}`, 'error'); }
}

async function analyzeAuthorProfile() {
  try {
    const data = await api('/novel/style/profile', { method: 'POST', body: { work_id: state.workId } });
    state.authorStyle = null; state.aiContext = null;
    toast(`文风分析完成（确定性计数，未调用模型）：档案 hash ${String(data.profile_hash || '').slice(0, 12)}`, 'success');
    await render();
  } catch (e) { toast(`分析失败：${e.message}`, 'error'); }
}

async function saveAuthorIntents() {
  const tiers = [['long_term', 0], ['stage', 0], ['chapter', state.currentChapterId || 0]];
  try {
    for (const [tier, chapterId] of tiers) {
      const text = ($(`#author-intent-${tier}`)?.value || '').trim();
      const hard = !!($(`#author-intent-${tier}-hard`)?.checked);
      if (!text) {
        await api(`/novel/author_intent?work_id=${state.workId}&chapter_id=${chapterId}&tier=${tier}`, { method: 'DELETE' }).catch(() => null);
        continue;
      }
      await api('/novel/author_intent', { method: 'PUT', body: { work_id: state.workId, chapter_id: chapterId, tier, text, hard } });
    }
    state.authorStyle = null; state.aiContext = null;
    toast('已保存三级作者意图（下一次写作请求生效）', 'success');
    await render();
  } catch (e) { toast(`保存意图失败：${e.message}`, 'error'); }
}

// ---------- R10：故事状态与披露视图（作者真相 / 读者已披露 / 各角色掌握） ----------
// 只读派生：不新增状态体系、不做前端缓存；每次按当前章重算，指纹可直接核对"是否已失效"。
async function loadStoryState(force = false) {
  if (state.storyState && !force) return state.storyState;
  try {
    const overview = await api(`/novel/story_state?work_id=${state.workId}`);
    let disclosure = null;
    if (state.currentChapterId) {
      disclosure = await api(`/novel/state/disclosure?work_id=${state.workId}&chapter_id=${state.currentChapterId}`);
    }
    state.storyState = { overview, disclosure };
  } catch (_) {
    state.storyState = null; // 旧服务端没有这些接口：如实显示"不可用"
  }
  return state.storyState;
}

function disclosureListHtml(title, items, note) {
  return `<div style="min-width:260px;flex:1">
    <b style="font-size:13px">${esc(title)}</b><span class="muted" style="font-size:12px">（${items.length}）</span>
    <div class="muted" style="font-size:12px">${esc(note || '')}</div>
    <div class="st-character-list">
      ${items.length ? items.slice(0, 12).map((x) => `<div class="st-character-item">
        <span class="chip">${esc(x.scope)}</span>${esc(x.label)}
        <span class="muted" style="font-size:12px">｜${esc(x.tier)}${x.evidence && x.evidence.chapter_index !== null && x.evidence.chapter_index !== undefined ? `｜第 ${x.evidence.chapter_index + 1} 章${x.evidence.written ? '（已写）' : '（未写）'}` : ''}</span>
      </div>`).join('') : '<div class="muted">（无）</div>'}
    </div>
  </div>`;
}

function renderStoryStateCard() {
  const s = state.storyState;
  if (!s) {
    return `<div class="card mb-12"><div class="card-head"><span class="card-title">故事状态与读者披露</span></div>
      <div class="muted">当前服务端不提供该接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  const o = s.overview || {};
  const d = s.disclosure;
  const chars = (d && d.characters) || [];
  return `
    <div class="card mb-12">
      <div class="card-head">
        <span class="card-title">故事状态与读者披露${helpDot('disclosure')}</span>
        <button class="btn small secondary" data-action="refresh-disclosure" title="按当前章重算（只读，不改任何状态）">🔄 按当前章重算</button>
        <button class="btn small ${o.enabled ? 'secondary' : ''}" data-action="toggle-story-state">${o.enabled ? '关闭故事状态' : '开启故事状态'}</button>
      </div>
      <div class="muted" style="font-size:12px">机制${o.enabled ? '已开启' : '未开启'}｜正典事实 ${esc(String(o.facts ?? 0))}｜时间线 ${esc(String(o.timeline ?? 0))}｜角色知识 ${esc(String(o.knowledge ?? 0))}｜待确认提案 ${esc(String(o.proposals_pending ?? 0))}｜状态哈希 ${esc(String(o.state_hash || '').slice(0, 12))}</div>
      ${d ? `
        <div class="muted mt-8" style="font-size:12px">时点：第 ${(d.cursor?.chapter_index ?? 0) + 1} 章｜视图指纹 ${esc(String(d.fingerprint || ''))}｜每次请求重算（不缓存，重排/回滚/改写后必然变）</div>
        <div class="muted" style="font-size:12px">口径：${esc(d.rules.effective_window)}${esc(d.rules.undetermined)}</div>
        <div class="row mt-8" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
          ${disclosureListHtml('作者真相（读者未披露）', d.author.truth, '作者知道 ≠ 读者知道：只用于审稿与伏笔一致性。')}
          ${disclosureListHtml('读者已披露', d.reader.disclosed, '以已写章节 + 生效时点（effective_from/to）为证据。')}
          ${disclosureListHtml('尚未披露 / 未到时点 / 角色私有', [...d.reader.not_yet, ...d.reader.future, ...d.reader.private_not_disclosed], '这些都不算读者已知。')}
        </div>
        <div class="mt-8">
          <b style="font-size:13px">各角色掌握</b>
          <div class="muted" style="font-size:12px">写某个角色的行动理由时只能用「已知」里的条目；「未定义」既不算知道也不算不知道。POV 护栏：作者真相与读者披露都不构成角色可行动知识。</div>
          ${chars.map((c) => `
            <div class="st-character-item">
              <div class="row"><b>${esc(c.name)}</b><span class="muted" style="font-size:12px">可行动 ${c.actionable_ids.length} 条｜已知 ${c.known.length}｜显式不知道 ${c.unknown.length}｜怀疑 ${c.suspected.length}｜误信 ${c.false_beliefs.length}｜未定义 ${c.undetermined.count}</span></div>
              ${c.known.length ? `<div class="muted" style="font-size:12px">已知：${c.known.slice(0, 6).map((k) => esc(k.label || k.fact_key)).join('；')}</div>` : ''}
              ${c.undetermined.count ? `<div class="muted" style="font-size:12px">未定义（不得当成已知）：${c.undetermined.sample.slice(0, 4).map((x) => esc(x)).join('；')}</div>` : ''}
            </div>`).join('') || '<div class="muted">该作品还没有角色。</div>'}
        </div>
      ` : '<div class="muted mt-8">先在「正文写作」里选一个章节，才能按"当前章"判断读者已披露与角色掌握。</div>'}
    </div>`;
}

async function toggleStoryState() {
  const enabled = !(state.storyState && state.storyState.overview && state.storyState.overview.enabled);
  try {
    await api('/novel/story_state', { method: 'PUT', body: { work_id: state.workId, enabled } });
    state.storyState = null; state.aiContext = null;
    toast(`故事状态内核已${enabled ? '开启' : '关闭'}（上下文装配随之变化）`, 'success');
    await render();
  } catch (e) { toast(`切换失败：${e.message}`, 'error'); }
}

async function refreshDisclosure() {
  state.storyState = null; // 服务端本来就每次重算；这里只是强制重读
  state.aiContext = null;
  await render();
}

// ---------- T6：影响分析（只分析、只标记）与逐章重建（按钮 + 一次性审批） ----------
// 影响：GET /api/novel/state/impact 读报告（历史运行可回看）；POST 由作者显式发起 / 刷新。
// 重建：作者点「重建受影响章节」→ 签发一次性审批 repair_run_start → POST /start → 轮询 GET 进度 →
//       就绪后签发 repair_run_apply → POST /apply；cancel / resume / revert 同页可用。
// 纪律：运行就绪 ≠ 已应用（主稿与候选分开显示）；候选预览读只读端点 /state/revision，不猜内容；
// 没有报告/没有运行就如实显示空态，不画假进度。
const IMPACT_ENTRY_LABEL = { kept: '保留原文', valid: '通过', needs_review: '需要复核', blocked: '阻塞（前缀被截断）', conflict: '冲突', skipped: '超出范围', tentative: '仅试探（根未确认）', pending: '未检查' };
const REPAIR_RUN_LABEL = { queued: '排队中', running: '运行中', paused: '已暂停', stale: '基线过期', ready: '待应用', applied: '已应用', failed: '失败', cancelled: '已取消', needs_review: '待复核', reverted: '已撤销' };
const REPAIR_STEP_LABEL = { queued: '未开始', validating: '复核中', kept: '保留原文', repairing: '修订中', repaired: '已生成修订', blocked: '阻塞', needs_review: '待复核', failed: '失败', cancelled: '已取消', stale: '过期', valid: '有效', conflict: '冲突' };

async function loadImpactRuns(force = false) {
  if (state.impactRuns && !force) return state.impactRuns;
  try {
    const data = await api(`/novel/state/impact?work_id=${state.workId}`);
    state.impactRuns = Array.isArray(data.runs) ? data.runs : [];
    const latest = state.impactRuns[0];
    if (latest && (!state.impactRun || String((state.impactRun.run || {}).id) !== String(latest.id))) {
      state.impactRootId = Number(latest.root_chapter_id) || state.impactRootId;
      await loadImpactRun(latest.id);
    }
  } catch (_) {
    state.impactRuns = null; // null = 接口不可用：如实显示，不冒充"没有报告"
  }
  return state.impactRuns;
}

async function loadImpactRun(runId) {
  try {
    const view = await api(`/novel/state/impact?work_id=${state.workId}&run_id=${encodeURIComponent(String(runId))}`);
    state.impactRun = view && view.ok ? view : null;
  } catch (_) { state.impactRun = null; }
  return state.impactRun;
}

/** 作者显式发起 / 刷新影响分析（POST；只分析、只标记，绝不改写后文）。 */
async function impactAnalyze() {
  const rootId = Number(($('#impact-root-chapter') || {}).value) || Number(state.impactRootId) || 0;
  if (!rootId) { toast('先选择一个「根变更」章节', 'error'); return; }
  state.impactRootId = rootId;
  try {
    const result = await api('/novel/state/impact', { method: 'POST', body: { work_id: state.workId, chapter_id: rootId, refresh: true } });
    if (result && result.report) state.impactRun = { ok: true, run: result.run, report: result.report, steps: [], ready_gate: null };
    await loadImpactRuns(true);
    toast(result && result.tentative
      ? '根章节的最新正文尚未确认：本次只给出试探性覆盖提示（未调用模型、未建候选）'
      : '影响分析完成：只标记与解释，不会自动改写后文（重建需另行点击）', 'info');
    await render();
  } catch (e) { toast(`影响分析失败：${e.message}`, 'error'); }
}

function impactEntryHtml(entry) {
  const e = entry || {};
  const conflicts = [...(e.explicit_conflicts || []), ...(e.implicit_causal || [])];
  const deps = (e.explicit_dependencies || []).map((d) => d.resource_key || d).filter(Boolean);
  const casts = e.explicit_appearances || [];
  // 每条都能展开看原因与证据（默认收起，避免长报告把关键章节挤下去）；摘要行只留状态与章名。
  const details = [
    e.reason ? `<div class="muted" style="font-size:12px">原因：${esc(e.reason)}</div>` : '',
    casts.length ? `<div class="muted" style="font-size:12px">显式出场：${casts.map((x) => esc(String(x))).join('、')}</div>` : '',
    deps.length ? `<div class="muted" style="font-size:12px">显式依赖：${deps.map((x) => esc(String(x))).join('、')}</div>` : '',
    conflicts.length ? `<div style="font-size:12px;color:#b45309">冲突证据：${conflicts.map((c) => `${esc(String(c.kind || ''))}｜前提：${esc(String(c.premise || ''))}${c.quote ? `｜原文：“${esc(String(c.quote))}”` : ''}`).join('；')}</div>` : '',
  ].filter(Boolean).join('');
  return `<div class="st-character-item">
    <div class="row"><b>第 ${esc(String(chapterTitleOfId(e.chapter_id)))}</b>
      <span class="chip">${esc(IMPACT_ENTRY_LABEL[e.status] || String(e.status || '未检查'))}</span>
      ${e.tentative ? '<span class="chip">试探</span>' : ''}
      ${e.kept_revision_id ? `<span class="muted" style="font-size:12px">保留原修订 ${esc(String(e.kept_revision_id).slice(0, 12))}</span>` : ''}
    </div>
    ${details ? `<details class="mt-4"><summary class="muted" style="font-size:12px;cursor:pointer">展开原因与证据</summary>${details}</details>` : ''}
  </div>`;
}

function impactSectionHtml() {
  const runs = state.impactRuns;
  const view = state.impactRun;
  const report = view && view.report ? view.report : null;
  const rootId = Number(state.impactRootId) || (report && Number(report.root_chapter_id)) || 0;
  const options = state.chapters.map((c) => `<option value="${c.id}" ${Number(rootId) === Number(c.id) ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
  const groups = { kept: [], needs_review: [], blocked: [], conflict: [], other: [] };
  for (const d of (report && report.downstream) || []) {
    const key = ['kept', 'needs_review', 'blocked', 'conflict'].includes(String(d.status)) ? String(d.status) : 'other';
    groups[key].push(d);
  }
  const totals = (report && report.totals) || {};
  const groupHtml = (label, list) => list.length
    ? `<div class="mt-8"><b style="font-size:13px">${label}（${list.length}）</b>${list.map(impactEntryHtml).join('')}</div>`
    : '';
  return `
    <div class="card mb-12" id="impact-card">
      <div class="card-head">
        <span class="card-title">影响分析（前文修改后的增量失效）${helpDot('impact_analysis')}</span>
        <select id="impact-root-chapter" title="选择根变更章节">${options || '<option value="">（没有章节）</option>'}</select>
        <button class="btn small" data-action="impact-analyze" ${state.chapters.length ? '' : 'disabled'}>分析影响</button>
      </div>
      <div class="muted" style="font-size:12px">只分析、只标记：给出显式出场与隐性因果的受影响章节、证据与处理结果，<b>不会</b>自动改写后文。重建必须由你另行点击并确认范围。</div>
      ${runs === null ? '<div class="muted mt-8">当前服务端不提供影响分析接口（可能是重启前的旧进程）：重启后可用。</div>' : ''}
      ${report ? `
        <div class="muted mt-8" style="font-size:12px">根变更：第 ${esc(String(chapterTitleOfId(report.root_chapter_id)))} 章｜覆盖 ${esc(String(totals.downstream ?? 0))} 章（跳过 ${esc(String(totals.skipped_by_coverage ?? 0))}${Number(totals.skipped_by_limit ?? 0) > 0 ? `｜<b>因上限未复核 ${esc(String(totals.skipped_by_limit))} 章，从第 ${esc(String(totals.truncated_at_chapter ?? '?'))} 章起</b>` : ''}）｜保留 ${esc(String(totals.kept ?? 0))}｜待复核 ${esc(String(totals.needs_review ?? 0))}｜阻塞 ${esc(String(totals.blocked ?? 0))}｜生成修订 ${esc(String(totals.generated_revisions ?? 0))}（本阶段不生成后文修订）｜模型调用 ${esc(String(totals.model_calls ?? 0))}</div>
        ${report.tentative ? '<div class="redline-scan warn mt-8">根章节的最新正文尚未确认：本报告只做试探性覆盖提示（未调用模型、未写任何候选状态）。</div>' : ''}
        ${(report.notes || []).map((n) => `<div class="muted" style="font-size:12px">· ${esc(n)}</div>`).join('')}
        ${groupHtml('需要复核（隐性因果）', groups.needs_review)}
        ${groupHtml('阻塞（前缀被截断）', groups.blocked)}
        ${groupHtml('冲突', groups.conflict)}
        ${groupHtml('保留原文', groups.kept)}
        ${groups.other.length ? `<div class="muted mt-8" style="font-size:12px">其余 ${groups.other.length} 章：${groups.other.map((d) => esc(String(chapterTitleOfId(d.chapter_id)))).join('、')}</div>` : ''}
      ` : (runs && runs.length ? `<div class="muted mt-8">已有 ${runs.length} 次历史运行；点「分析影响」刷新当前范围。</div>` : '<div class="muted mt-8">还没有影响分析报告。</div>')}
    </div>`;
}

// ---- 逐章重建（T4 运行的真实前端接线） ----
async function loadRepairRuns(force = false) {
  if (state.repairRuns && !force) return state.repairRuns;
  try {
    const data = await api(`/novel/state/repair?work_id=${state.workId}`);
    state.repairRuns = Array.isArray(data.runs) ? data.runs : [];
    const latest = state.repairRuns[0];
    if (latest && !state.repairRun) await loadRepairRun(latest.id);
    // 页面重新打开时，若最新运行仍在进行，接回轮询（真实进度，不是本地假进度）。
    const cur = state.repairRun && state.repairRun.run ? state.repairRun.run : null;
    if (cur && ['queued', 'running'].includes(String(cur.status))) scheduleRepairPoll(cur.id);
  } catch (_) {
    state.repairRuns = null; // 接口不可用：如实显示
  }
  return state.repairRuns;
}

async function loadRepairRun(runId) {
  try {
    const view = await api(`/novel/state/repair?work_id=${state.workId}&run_id=${encodeURIComponent(String(runId))}`);
    state.repairRun = view && view.ok ? view : null;
  } catch (_) { state.repairRun = null; }
  const st = state.repairRun && state.repairRun.run ? state.repairRun.run.status : '';
  if (!['queued', 'running'].includes(st)) stopRepairPoll();
  return state.repairRun;
}

function stopRepairPoll() {
  if (state.repairPoll) { clearTimeout(state.repairPoll); state.repairPoll = null; }
}

/** 运行期间轮询真实进度（3s）；到终态即停。只更新本页区块，不整页重绘。 */
function scheduleRepairPoll(runId) {
  stopRepairPoll();
  const tick = async () => {
    state.repairPoll = null;
    const view = await loadRepairRun(runId);
    const box = typeof document !== 'undefined' ? document.getElementById('repair-section') : null;
    if (box) box.innerHTML = repairSectionHtml();
    const st = view && view.run ? view.run.status : '';
    if (['queued', 'running'].includes(st)) state.repairPoll = setTimeout(tick, 3000);
  };
  state.repairPoll = setTimeout(tick, 3000);
}

function repairStepHtml(step) {
  const s = step || {};
  const st = String(s.status || '');
  const list = (state.repairRun && Array.isArray(state.repairRun.steps)) ? state.repairRun.steps : [];
  const idx = list.findIndex((x) => String(x.id) === String(s.id));
  return `<div class="st-character-item">
    <div class="row"><b>第 ${esc(String(chapterTitleOfId(s.chapter_id)))}</b>
      <span class="chip">${esc(REPAIR_STEP_LABEL[st] || st || '未开始')}</span>
      ${Number(s.attempt) > 1 ? `<span class="muted" style="font-size:12px">尝试 ${esc(String(s.attempt))} 次</span>` : ''}
      ${s.candidate_revision_id && idx >= 0 ? `<button class="btn small secondary" data-action="repair-preview" data-idx="${esc(String(idx))}">预览候选</button>` : ''}
    </div>
    ${s.result && s.result.reason ? `<div class="muted" style="font-size:12px">${esc(String(s.result.reason))}</div>` : ''}
  </div>`;
}

function repairPreviewHtml() {
  const p = state.repairPreview;
  if (!p) return '';
  const ops = diffParagraphs(p.oldText || '', p.newText || '');
  const body = ops.map((op) => {
    if (op.t === 'same') return `<div class="diff-p">${esc(op.x)}</div>`;
    if (op.t === 'del') return `<div class="diff-p diff-del">${esc(op.x)}</div>`;
    return `<div class="diff-p diff-add">${esc(op.x)}</div>`;
  }).join('');
  return `<div class="diff-view">${body || '<div class="muted">无差异</div>'}</div>`;
}

function repairSectionHtml() {
  const runs = state.repairRuns;
  const view = state.repairRun;
  const run = view && view.run ? view.run : null;
  const steps = (view && view.steps) || [];
  const totals = (run && run.result && run.result.totals) || {};
  const halt = run && run.result ? run.result.halt : null;
  const readyGate = (view && view.ready_gate) || null;
  const rootId = Number(state.impactRootId) || (run && Number(run.root_chapter_id)) || 0;
  const options = state.chapters.map((c) => `<option value="${c.id}" ${Number(rootId) === Number(c.id) ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
  const canStart = state.chapters.length > 0;
  return `
    <div class="card mb-12" id="repair-card">
      <div class="card-head">
        <span class="card-title">逐章重建（按钮授权）${helpDot('repair_run')}</span>
        <select id="repair-root-chapter" title="重建的根变更章节">${options || '<option value="">（没有章节）</option>'}</select>
        <button class="btn small" data-action="repair-start" ${canStart ? '' : 'disabled'}>重建受影响章节</button>
      </div>
      <div class="muted" style="font-size:12px">按叙事顺序**逐章**复核：仍成立→保留原文并重建依赖；不成立→生成最小修订候选（只进工作线，<b>不覆盖正文</b>）。就绪后仍需你签发一次应用审批，才会原子切换正式稿。</div>
      ${runs === null ? '<div class="muted mt-8">当前服务端不提供重建接口（可能是重启前的旧进程）：重启后可用。</div>' : ''}
      ${!run ? (runs && runs.length ? `<div class="muted mt-8">已有 ${runs.length} 次历史运行；从上面点「重建受影响章节」开始新的运行。</div>` : '<div class="muted mt-8">还没有重建运行。</div>') : `
        <div class="row mt-8">
          <span class="chip">${esc(REPAIR_RUN_LABEL[run.status] || run.status)}</span>
          <span class="muted" style="font-size:12px">运行 ${esc(String(run.id).slice(0, 14))}｜根章：第 ${esc(String(chapterTitleOfId(run.root_chapter_id)))} 章｜基线 ${esc(String(run.base_commit_id || '').slice(0, 12))}</span>
        </div>
        ${run.status === 'applied' ? '<div class="redline-scan warn mt-8">本运行已应用到正式稿（旧稿保留在历史版本里，可撤销恢复）。</div>' : ''}
        <div class="muted mt-8" style="font-size:12px">覆盖 ${esc(String(totals.chapters ?? steps.length))} 章｜保留 ${esc(String(totals.kept ?? 0))}｜已生成修订 ${esc(String(totals.repaired ?? 0))}｜待复核 ${esc(String(totals.needs_review ?? 0))}｜阻塞 ${esc(String(totals.blocked ?? 0))}｜模型调用 ${esc(String(totals.model_calls ?? 0))}${totals.tokens ? `｜tokens ${esc(String(totals.tokens))}` : ''}</div>
        ${halt && halt.reason ? `<div class="redline-scan warn mt-8">已停止：${esc(String(halt.reason))}</div>` : ''}
        ${readyGate && !readyGate.can_apply && run.status === 'ready' ? `<div class="muted" style="font-size:12px">尚不可应用：${esc((readyGate.reasons || []).join('；'))}</div>` : ''}
        <div class="row mt-8" style="gap:6px;flex-wrap:wrap">
          ${['queued', 'running'].includes(run.status) ? `<button class="btn small secondary" data-action="repair-cancel">取消</button>` : ''}
          ${['paused', 'failed', 'needs_review', 'stale'].includes(run.status) ? `<button class="btn small secondary" data-action="repair-resume">恢复运行</button>` : ''}
          ${run.status === 'ready' && readyGate && readyGate.can_apply ? `<button class="btn small" data-action="repair-apply">应用候选（需一次性审批）</button>` : ''}
          ${run.status === 'applied' ? `<button class="btn small secondary" data-action="repair-revert">撤销本轮重建</button>` : ''}
          <button class="btn small secondary" data-action="repair-refresh">刷新进度</button>
        </div>
        ${steps.length ? `<div class="mt-8"><b style="font-size:13px">逐章进度</b>${steps.map(repairStepHtml).join('')}</div>` : ''}
        <div id="repair-preview" class="mt-8">${repairPreviewHtml()}</div>
      `}
    </div>`;
}

async function repairStart() {
  const rootId = Number(($('#repair-root-chapter') || {}).value) || Number(state.impactRootId) || 0;
  if (!rootId) { toast('先选择重建的根章节', 'error'); return; }
  if (!confirm(`将从「第 ${chapterTitleOfId(rootId)} 章」开始，按叙事顺序逐章复核其后的受影响章节，并生成候选修订（候选不覆盖正文；就绪后仍需你签发一次应用审批）。继续？`)) return;
  try {
    const approval = await api('/novel/approvals', { method: 'POST', body: { work_id: state.workId, op: 'repair_run_start', root_chapter_id: rootId, note: '作者界面：按钮式逐章重建' } });
    const result = await api('/novel/state/repair/start', { method: 'POST', body: { work_id: state.workId, root_chapter_id: rootId, approval_id: approval.id } });
    if (!result || result.ok !== true) {
      toast(`重建未启动：${(result && result.reason) || '未知原因'}`, 'error');
      await loadRepairRuns(true);
      await render();
      return;
    }
    state.repairRun = { ok: true, run: result.run, steps: result.steps || [], ready_gate: null };
    state.repairRuns = null;
    await loadRepairRun(result.run.id);
    scheduleRepairPoll(result.run.id);
    toast(result.reused ? '已有同范围的重建运行：已接回进度（审批不重复消费）' : '重建已启动：逐章进行，可随时取消', 'success');
    await render();
  } catch (e) { toast(`重建启动失败：${e.message}`, 'error'); }
}

async function repairAction(action) {
  const view = state.repairRun;
  const runId = view && view.run ? view.run.id : '';
  if (!runId) { toast('没有可操作的运行', 'error'); return; }
  try {
    if (action === 'cancel') {
      const r = await api('/novel/state/repair/cancel', { method: 'POST', body: { work_id: state.workId, run_id: runId } });
      if (!r || r.ok !== true) { toast(`取消失败：${(r && r.reason) || '未知原因'}`, 'error'); }
      else toast('已请求取消：断点保留，可稍后恢复', 'info');
    } else if (action === 'resume') {
      const r = await api('/novel/state/repair/resume', { method: 'POST', body: { work_id: state.workId, run_id: runId } });
      if (!r || r.ok !== true) { toast(`恢复失败：${(r && r.reason) || '未知原因'}`, 'error'); }
      else toast('已恢复：从断点继续', 'success');
    } else if (action === 'apply') {
      if (!confirm('应用会把候选修订原子切换到正式正文（旧稿保留在历史版本，可撤销）。继续？')) return;
      const approval = await api('/novel/approvals', { method: 'POST', body: { work_id: state.workId, op: 'repair_run_apply', run_id: runId, note: '作者界面：应用逐章重建候选' } });
      const r = await api('/novel/state/repair/apply', { method: 'POST', body: { work_id: state.workId, run_id: runId, approval_id: approval.id } });
      if (!r || r.ok !== true) { toast(`应用失败：${(r && r.reason) || '未知原因'}`, 'error'); }
      else toast('已应用：正式正文 / 绑定 / HEAD 一次原子切换', 'success');
    } else if (action === 'revert') {
      if (!confirm('撤销会创建恢复提交，把正文恢复到重建前的版本（不会删除历史）。继续？')) return;
      const r = await api('/novel/state/repair/revert', { method: 'POST', body: { work_id: state.workId, run_id: runId } });
      if (!r || r.ok !== true) { toast(`撤销失败：${(r && r.reason) || '未知原因'}`, 'error'); }
      else toast('已撤销：恢复提交已创建', 'success');
    }
    state.repairRuns = null;
    await loadRepairRun(runId);
    await loadRepairRuns(true);
    await render();
  } catch (e) { toast(`操作失败：${e.message}`, 'error'); }
}

/** 候选预览：读只读端点 /novel/state/revision，与当前正文逐段 diff；不改任何状态。 */
async function repairPreview(idx) {
  const view = state.repairRun;
  const step = view && Array.isArray(view.steps) ? view.steps[Number(idx)] : null;
  if (!step || !step.candidate_revision_id) { toast('该章没有可预览的候选修订', 'error'); return; }
  try {
    const data = await api(`/novel/state/revision?work_id=${state.workId}&revision_id=${encodeURIComponent(String(step.candidate_revision_id))}`);
    const chapter = state.chapters.find((c) => Number(c.id) === Number(step.chapter_id)) || {};
    state.repairPreview = {
      chapter_id: step.chapter_id, revision_id: step.candidate_revision_id,
      oldText: editorPlainText(chapter.content || ''), newText: editorPlainText((data.revision || {}).content_html || ''),
    };
    const box = typeof document !== 'undefined' ? document.getElementById('repair-preview') : null;
    if (box) box.innerHTML = repairPreviewHtml();
    else await render();
  } catch (e) { toast(`候选预览失败：${e.message}`, 'error'); }
}

async function repairRefresh() {
  const view = state.repairRun;
  const runId = view && view.run ? view.run.id : '';
  if (runId) await loadRepairRun(runId);
  await loadRepairRuns(true);
  await render();
}

// ---------- T7：时态引擎开关（迁移门禁 + 预算告知）与存量重建（逐章按序） ----------
// 纪律：三个开关分离、旧作品默认关闭；未启用作品不触发额外模型调用、不改变旧上下文。
// 存量重建复用「冻结修订 → 抽取请求 → 作者确认」状态机：
//   生成抽取请求不调用模型；记录结果走本机管线（与导入重建同一模式）；确认一章才推进可信前缀。
//   跳章确认由服务端 409 拒绝——界面如实转述，不自己放宽顺序；重复确认幂等。
const BACKFILL_STATE_LABEL = {
  valid: '已确认', pending_confirm: '待确认', analysis_running: '分析中', pending_analysis: '待分析',
  missing_revision: '未冻结修订', stale: '已过期', needs_review: '待复核', conflict: '冲突', blocked: '阻塞',
};

async function loadTemporalEngine(force = false) {
  if (state.temporalEngine && !force) return state.temporalEngine;
  try {
    const overview = await api(`/novel/state/temporal?work_id=${state.workId}`);
    state.temporalEngine = overview && overview.ok === false ? null : overview;
  } catch (e) {
    // 接口不可用 ≠ 未开启：保留失败原因，界面如实显示（不冒充"没有此功能"）
    state.temporalEngine = { ok: false, interface_error: e.message };
  }
  return state.temporalEngine;
}

async function loadBackfill(force = false) {
  if (state.backfill && !force) return state.backfill;
  try {
    // ok:false 也要保留：它带 schema 阻塞原因（缺表/缺索引），界面按它禁用操作并显示原因
    state.backfill = await api(`/novel/state/backfill?work_id=${state.workId}`);
  } catch (e) {
    state.backfill = { ok: false, interface_error: e.message };
  }
  return state.backfill;
}

function backfillPromptText(step) {
  const p = (step && step.prompt) || {};
  return [p.system, p.user].filter(Boolean).join('\n\n');
}

function temporalFlagRow(label, note, flag, enabled, canToggle) {
  return `<div class="st-character-item">
    <div class="row"><b>${label}</b>
      <span class="chip">${enabled ? '已开启' : '未开启'}</span>
      <span class="muted grow" style="font-size:12px">${note}</span>
      <button class="btn small ${enabled ? 'secondary' : ''}" data-action="temporal-toggle" data-flag="${flag}" data-value="${enabled ? 'false' : 'true'}" ${canToggle ? '' : 'disabled'}>${enabled ? '关闭' : '开启'}</button>
    </div>
  </div>`;
}

function renderTemporalEngineCard() {
  const e = state.temporalEngine;
  if (e === null) {
    return `<div class="card mb-12" id="temporal-engine-card"><div class="card-head"><span class="card-title">时态状态引擎（迁移与开关）</span></div>
      <div class="muted">当前服务端不提供时态引擎接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  if (e.interface_error) {
    return `<div class="card mb-12" id="temporal-engine-card"><div class="card-head"><span class="card-title">时态状态引擎（迁移与开关）</span></div>
      <div class="redline-scan warn">读取失败：${esc(String(e.interface_error))}（不显示推测内容；可点刷新重试）</div></div>`;
  }
  const config = e.config || {};
  const canEnable = e.schema_ok === true;
  const trust = e.trust || null;
  const budget = (state.backfill && state.backfill.ok) ? (state.backfill.budget || {}) : {};
  const bootstrapPending = (state.backfill && state.backfill.ok && state.backfill.bootstrap) ? Number(state.backfill.bootstrap.pending || 0) : 0;
  const migration = e.migration || null;
  const scope = state.temporalEngineEnable;
  const trustedText = trust
    ? (Number(trust.trusted_through) >= 0 ? `截至第 ${Number(trust.trusted_through) + 1} 章` : '未建立')
    : '';
  return `
    <div class="card mb-12" id="temporal-engine-card">
      <div class="card-head">
        <span class="card-title">时态状态引擎（迁移与开关）${helpDot('temporal_engine')}</span>
        <button class="btn small secondary" data-action="temporal-refresh">刷新</button>
      </div>
      <div class="muted" style="font-size:12px">表与索引${canEnable ? '齐备' : '缺失：' + esc((e.missing_tables || []).join('、'))}${migration ? `｜迁移登记${migration.applied ? '已完成' : '未完成'}（版本 ${esc(String(migration.version || e.version || ''))}）` : ''}${trust ? `｜可信前缀：${esc(trustedText)}（已确认 ${esc(String((trust.totals || {}).valid ?? 0))} 章）` : ''}${e.head_commit_id ? `｜提交 ${esc(String(e.head_commit_id).slice(0, 12))}｜章序 ${esc(String(e.order_version_id || '').slice(0, 10))}｜清单 ${esc(String(e.manifest_size ?? 0))} 章` : ''}</div>
      ${temporalFlagRow('时态故事状态引擎', '唯一权威状态来源：不可变修订 + 已确认事件 + 提交清单 + 章序版本', 'temporal_enabled', config.enabled === true, canEnable)}
      ${temporalFlagRow('保存后自动分析', '开启后保存正文会生成待确认提案（用模型）；旧作品默认关闭', 'auto_analysis_enabled', config.auto_analysis === true, config.enabled === true)}
      ${temporalFlagRow('逐章重建', '允许「重建受影响章节」按钮签发运行；候选不覆盖正文', 'repair_enabled', config.repair === true, config.enabled === true)}
      ${!config.enabled ? `
        <div class="redline-scan warn mt-8">旧作品默认不启用：未启用前不触发任何额外模型调用，上下文装配与旧端点契约逐字节不变。</div>
        ${budget.chapters_total !== undefined ? `<div class="mt-8" style="font-size:12px">启用后的待重建范围：共 ${esc(String(budget.chapters_total))} 章｜需要抽取 ${esc(String(budget.chapters_needing_extraction ?? 0))} 章｜等待确认 ${esc(String(budget.chapters_awaiting_confirm ?? 0))} 章｜预计模型调用 ${esc(String(budget.model_calls_estimated ?? 0))} 次（每次抽取一章一次调用）｜扫描旧字段待确认 ${esc(String(bootstrapPending))} 条</div>` : ''}
      ` : ''}
      ${scope ? `<div class="muted mt-8" style="font-size:12px">启用范围（本次启用时告知）：待重建 ${esc(String((scope.pending_rebuild || {}).chapters ?? 0))} 章；即将处理：${(scope.upcoming || []).slice(0, 6).map((c) => `第 ${Number(c.index) + 1} 章`).join('、') || '无'}</div>` : ''}
      ${!canEnable ? '<div class="redline-scan warn mt-8">缺少必要表/索引：迁移未完成前不允许开启（服务端同样拒绝，不吞错误继续跑）。</div>' : ''}
    </div>`;
}

function backfillChapterRowHtml(c) {
  const st = String(c.state || '');
  const label = BACKFILL_STATE_LABEL[st] || st;
  const step = (state.backfillStep && Number(state.backfillStep.chapter_id) === Number(c.chapter_id)) ? state.backfillStep : null;
  const isNext = Number((state.backfill || {}).next_chapter_id) === Number(c.chapter_id);
  return `<div class="st-character-item">
    <div class="row">
      <b>第 ${Number(c.index) + 1} 章${c.title ? `（${esc(String(c.title))}）` : ''}</b>
      <span class="chip">${esc(label)}</span>
      ${isNext ? '<span class="chip">下一章</span>' : ''}
      <span class="muted" style="font-size:12px">依赖 ${esc(String(c.dependencies ?? 0))}｜章后快照 ${esc(String(c.snapshots_after ?? 0))}${c.revision_id ? `｜修订 ${esc(String(c.revision_id).slice(0, 10))}` : ''}${st === 'missing_revision' ? '｜正文未冻结' : ''}</span>
      <div class="grow"></div>
      ${st === 'pending_confirm'
        ? `<button class="btn small" data-action="backfill-confirm" data-id="${c.chapter_id}">确认本章</button>`
        : (st === 'valid' ? '' : `<button class="btn small secondary" data-action="backfill-step" data-id="${c.chapter_id}">冻结并生成抽取请求</button>`)}
    </div>
    ${step && step.prompt ? `<div class="row mt-8" style="gap:6px;flex-wrap:wrap">
      <span class="muted" style="font-size:12px">已生成抽取请求（未调用模型）</span>
      <button class="btn small secondary" data-action="copy-text" data-copy="${esc(backfillPromptText(step))}">复制抽取请求</button>
      <button class="btn small" data-action="backfill-record" data-id="${c.chapter_id}">记录本机结果（可能产生费用）</button>
    </div>` : ''}
    ${step && step.status === 'pending_confirm' ? `<div class="muted" style="font-size:12px">候选已登记（未写正式状态）：事件 ${esc(String((step.proposal || {}).events ?? 0))} · 操作 ${esc(String((step.proposal || {}).ops ?? 0))}；确认后可信前缀才会前进。</div>` : ''}
    ${step && step.ok === false && step.reason ? `<div class="muted" style="font-size:12px">${esc(String(step.reason))}</div>` : ''}
  </div>`;
}

function backfillBootstrapHtml() {
  const bf = state.backfill;
  const b = (bf && bf.ok) ? (bf.bootstrap || null) : null;
  const items = b && Array.isArray(b.items) ? b.items : [];
  const pending = items.filter((x) => String(x.status) === 'pending');
  const decided = items.filter((x) => String(x.status) !== 'pending');
  const show = (v) => (v && typeof v === 'object') ? JSON.stringify(v) : String(v);
  return `<div class="mt-8">
    <div class="row">
      <b style="font-size:13px">开篇设定候选（旧字段扫描）</b>
      <span class="muted" style="font-size:12px">共 ${items.length}｜待确认 ${pending.length}</span>
      <div class="grow"></div>
      <button class="btn small secondary" data-action="backfill-bootstrap-plan">扫描旧字段建立候选</button>
    </div>
    <div class="muted" style="font-size:12px">旧字段的「最新值」生效时点未知：不会自动回填。确认才会写入初始状态（或转为某章待确认提案）；拒绝不写任何状态。"第 10 章死亡"不会被当作开篇已死亡。</div>
    ${pending.map((c) => `<div class="st-character-item">
      <div class="row"><b>${esc(String(c.entity_id))}</b><span class="chip">${esc(String(c.domain))}</span>
        <span class="muted" style="font-size:12px">${esc(String(c.predicate))} = ${esc(show(c.value))}${c.source ? `｜来源 ${esc(String(c.source.table))}.${esc(String(c.source.field))}` : ''}${c.detail ? `｜${esc(String(c.detail))}` : ''}</span>
      </div>
      ${c.note ? `<div class="muted" style="font-size:12px">${esc(String(c.note))}</div>` : ''}
      <div class="row mt-8" style="gap:6px;flex-wrap:wrap">
        <button class="btn small" data-action="backfill-bootstrap-decide" data-id="${esc(String(c.candidate_id))}" data-decision="confirm" data-effective="opening">作为开篇设定</button>
        <button class="btn small secondary" data-action="backfill-bootstrap-decide" data-id="${esc(String(c.candidate_id))}" data-decision="reject">拒绝</button>
        <select id="bf-boot-ch-${esc(String(c.candidate_id))}" title="指定生效章节（转为该章待确认提案）">${state.chapters.map((ch) => `<option value="${ch.id}">${esc(ch.title)}</option>`).join('')}</select>
        <button class="btn small secondary" data-action="backfill-bootstrap-decide" data-id="${esc(String(c.candidate_id))}" data-decision="confirm" data-effective="chapter">转为该章提案</button>
      </div>
    </div>`).join('')}
    ${decided.length ? `<div class="muted mt-8" style="font-size:12px">已决定 ${decided.length} 条（保留为审计记录）：${decided.slice(0, 8).map((c) => `${esc(String(c.entity_id))}（${esc(String(c.status))}）`).join('、')}${decided.length > 8 ? '…' : ''}</div>` : ''}
  </div>`;
}

function renderBackfillCard() {
  const bf = state.backfill;
  if (bf === null) {
    return `<div class="card mb-12" id="backfill-card"><div class="card-head"><span class="card-title">存量重建（逐章按叙事顺序）</span></div>
      <div class="muted">当前服务端不提供存量重建接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  if (bf.interface_error) {
    return `<div class="card mb-12" id="backfill-card"><div class="card-head"><span class="card-title">存量重建（逐章按叙事顺序）</span></div>
      <div class="redline-scan warn">读取失败：${esc(String(bf.interface_error))}（不显示推测内容；可点刷新重试）</div></div>`;
  }
  if (bf.ok === false) {
    return `<div class="card mb-12" id="backfill-card"><div class="card-head"><span class="card-title">存量重建（逐章按叙事顺序）${helpDot('backfill')}</span></div>
      <div class="redline-scan warn">迁移未完成：${esc(String(bf.reason || '缺少必要表或索引'))}（不吞错误继续跑；补齐迁移后本卡自动可用）</div></div>`;
  }
  const totals = bf.totals || {};
  const budget = bf.budget || {};
  const chapters = Array.isArray(bf.chapters) ? bf.chapters : [];
  const queue = chapters.filter((c) => String(c.state) !== 'valid');
  const show = queue.slice(0, 12);
  const nextId = Number(bf.next_chapter_id) || 0;
  const anchor = chapters.find((c) => Number(c.chapter_id) === nextId) || null;
  const trustedText = Number(bf.trusted_through) >= 0 ? `截至第 ${Number(bf.trusted_through) + 1} 章` : '未建立';
  const pendingConfirm = chapters.filter((c) => String(c.state) === 'pending_confirm');
  return `
    <div class="card mb-12" id="backfill-card">
      <div class="card-head">
        <span class="card-title">存量重建（逐章按叙事顺序）${helpDot('backfill')}</span>
        <button class="btn small secondary" data-action="backfill-refresh">刷新进度</button>
      </div>
      <div class="muted" style="font-size:12px">逐章走：冻结不可变修订（不改写正文）→ 生成抽取请求（不调用模型）→ 记录/确认 → 章边界快照与事后依赖 → 可信前缀前进。跳章确认会被服务端拒绝；重复确认幂等。</div>
      <div class="muted mt-8" style="font-size:12px">共 ${esc(String(totals.chapters ?? 0))} 章｜已确认 ${esc(String(totals.valid ?? 0))}｜待确认 ${esc(String(totals.pending_confirm ?? 0))}｜待分析 ${esc(String(totals.pending_analysis ?? 0))}｜分析中 ${esc(String(totals.analysis_running ?? 0))}｜未冻结修订 ${esc(String(totals.missing_revision ?? 0))}｜已过期 ${esc(String(totals.stale ?? 0))}｜待复核 ${esc(String(totals.needs_review ?? 0))}｜冲突 ${esc(String(totals.conflict ?? 0))}｜阻塞 ${esc(String(totals.blocked ?? 0))}</div>
      <div class="muted mt-8" style="font-size:12px">可信前缀：${esc(trustedText)}｜下一章：${anchor ? `第 ${Number(anchor.index) + 1} 章` : '（没有待处理章节）'}｜预计模型调用 ${esc(String(budget.model_calls_estimated ?? 0))} 次（${esc(String(budget.model_calls_note || '每次抽取一章一次调用'))}）｜自动分析默认 ${esc(String(budget.auto_analysis_default || 'off'))}</div>
      ${show.length ? `<div class="mt-8"><b style="font-size:13px">待处理章节（${queue.length}）</b>${show.map(backfillChapterRowHtml).join('')}</div>` : '<div class="muted mt-8">全部章节已确认：可信前缀覆盖全书。</div>'}
      ${queue.length > show.length ? `<div class="muted" style="font-size:12px">…其余 ${queue.length - show.length} 章未展开（按叙事顺序处理即可）</div>` : ''}
      ${pendingConfirm.length ? `<div class="muted mt-8" style="font-size:12px">待确认：${pendingConfirm.slice(0, 8).map((c) => `第 ${Number(c.index) + 1} 章`).join('、')}</div>` : ''}
      ${backfillBootstrapHtml()}
    </div>`;
}

/** 开关切换：只发一个 flag（PUT 支持部分更新）；首次启用时展示服务端返回的 enable_scope。 */
async function temporalToggle(flag, value) {
  try {
    const out = await api('/novel/state/temporal', { method: 'PUT', body: { work_id: state.workId, [flag]: value } });
    state.temporalEngine = out && out.ok === false ? null : out;
    if (out && out.enable_scope) state.temporalEngineEnable = out.enable_scope;
    state.backfill = null; // 开关一变，计划与预算必须重读（服务端现算）
    if (flag === 'temporal_enabled' && value === true && out && out.enable_scope) {
      const scope = out.enable_scope;
      toast(`已启用：待重建 ${(scope.pending_rebuild || {}).chapters ?? 0} 章，预计 ${((scope.budget || {}).model_calls_estimated) ?? 0} 次模型调用（保存后自动分析仍未开启）`, 'success');
    } else {
      const name = flag === 'temporal_enabled' ? '时态故事状态引擎' : flag === 'auto_analysis_enabled' ? '保存后自动分析' : '逐章重建';
      toast(`${name}已${value ? '开启' : '关闭'}`, 'success');
    }
    await render();
  } catch (e) { toast(`切换失败：${e.message}`, 'error'); }
}

/** 单章一步：无 result = 只冻结并生成抽取请求（不调用模型）；record=true = 本机跑一次并记回候选。 */
async function backfillStepRun(chapterId, { record = false } = {}) {
  const ch = state.chapters.find((c) => Number(c.id) === Number(chapterId)) || null;
  const label = ch ? ch.title : ('#' + chapterId);
  try {
    if (!record) {
      const out = await api('/novel/state/backfill/step', { method: 'POST', body: { work_id: state.workId, chapter_id: chapterId, provider: 'author_ui' } });
      state.backfillStep = { chapter_id: chapterId, ...out };
      if (out && out.status === 'awaiting_extraction') toast(`已冻结「${label}」并生成抽取请求（未调用模型）：可复制给 dsh，或点「记录本机结果」`, 'success');
      else toast(`「${label}」：${(out && (out.note || out.reason || out.status)) || '未产生结果'}`, out && out.ok === false ? 'warn' : 'success');
      state.backfill = null;
      await loadBackfill(true);
      await render();
      return;
    }
    const step = state.backfillStep;
    if (!step || Number(step.chapter_id) !== Number(chapterId) || !step.prompt) { toast('先为本章生成抽取请求', 'error'); return; }
    const promptText = backfillPromptText(step);
    const runner = typeof state.backfillRunner === 'function'
      ? state.backfillRunner
      : (({ prompt: p, label: l }) => runPipelineStage(p, { stageLabel: l }));
    const raw = await runner({ chapter_id: chapterId, label: `存量重建·${label}`, prompt: promptText });
    let payload = String(raw || '').trim();
    const fence = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) payload = fence[1].trim();
    const start = payload.indexOf('{'); const end = payload.lastIndexOf('}');
    const result = JSON.parse(payload.slice(start, end + 1)); // 解析失败交给 record 的校验口径报错
    const out = await api('/novel/state/backfill/step', {
      method: 'POST',
      body: { work_id: state.workId, chapter_id: chapterId, result, provider: 'author_ui_local', input_hash: (step.prompt && step.prompt.input_hash) || '' },
    });
    state.backfillStep = { chapter_id: chapterId, ...out };
    toast(out && out.status === 'pending_confirm' ? `「${label}」候选已登记（未写正式状态）：请确认本章` : `「${label}」：${(out && (out.reason || out.note || out.status)) || '未产生候选'}`, out && out.status === 'pending_confirm' ? 'success' : 'warn');
    state.backfill = null;
    await loadBackfill(true);
    await render();
  } catch (e) { toast(`本章处理失败：${e.message}`, 'error'); }
}

/** 作者确认一章：可信前缀前进一章；上游不可信时服务端 409，界面如实报错。 */
async function backfillConfirmRun(chapterId) {
  const ch = state.chapters.find((c) => Number(c.id) === Number(chapterId)) || null;
  const label = ch ? ch.title : ('#' + chapterId);
  try {
    const out = await api('/novel/state/backfill/confirm', { method: 'POST', body: { work_id: state.workId, chapter_id: chapterId } });
    const through = Number(out && out.trusted_through);
    toast(`「${label}」已确认：可信前缀前进${Number.isFinite(through) && through >= 0 ? `（截至第 ${through + 1} 章）` : ''}`, 'success');
    state.backfill = null;
    state.backfillStep = null;
    await loadBackfill(true);
    await render();
  } catch (e) { toast(`确认失败：${e.message}`, 'error'); }
}

async function backfillBootstrapPlan() {
  try {
    const out = await api('/novel/state/backfill/bootstrap/plan', { method: 'POST', body: { work_id: state.workId } });
    toast(`旧字段扫描：发现 ${(out && out.found) ?? 0} 条，新建待确认候选 ${(out && out.created) ?? 0} 条${out && Array.isArray(out.deferred) && out.deferred.length ? `；${out.deferred.length} 条待条件满足` : ''}`, 'success');
    state.backfill = null;
    await loadBackfill(true);
    await render();
  } catch (e) { toast(`扫描失败：${e.message}`, 'error'); }
}

async function backfillBootstrapDecide(candidateId, decision, effective = 'opening', chapterId = null) {
  try {
    const out = await api('/novel/state/backfill/bootstrap/decide', {
      method: 'POST',
      body: { work_id: state.workId, candidate_id: candidateId, decision, effective, chapter_id: chapterId },
    });
    const decisionLabel = (out && out.decision) || decision;
    toast(decision === 'reject' ? '已拒绝该候选（不写任何状态）' : `已确认（${esc(String(decisionLabel))}）：以服务端返回为准`, 'success');
    state.backfill = null;
    await loadBackfill(true);
    await render();
  } catch (e) { toast(`决定失败：${e.message}`, 'error'); }
}

// ---------- R11：剧情分支沙盘（候选是提案；采纳/丢弃/取消/重开是作者动作） ----------
// 服务端每次现算依赖基线与 stale；前端不做缓存、不替作者排序（比较只列差异）。
async function loadBranch(force = false) {
  if (state.branch && !force) return state.branch;
  try {
    const chapterId = state.currentChapterId || 0;
    const sandboxes = await api(`/novel/branch/sandboxes?work_id=${state.workId}${chapterId ? `&chapter_id=${chapterId}` : ''}`);
    let candidates = null;
    if (chapterId) candidates = await api(`/novel/branch/candidates?work_id=${state.workId}&chapter_id=${chapterId}`);
    state.branch = { sandboxes, candidates };
  } catch (_) {
    state.branch = null; // 旧服务端没有这些接口：如实显示"不可用"，不假装有沙盘
  }
  return state.branch;
}

/** 给 dsh 会话用的沙盘提示词（只复制到剪贴板，不自动发起任何模型调用）。 */
function branchPromptText() {
  const ch = state.chapters.find((c) => c.id === state.currentChapterId);
  return [
    `请用 novel_branch 工具为《${state.work?.title || ''}》「${ch ? ch.title : '当前章'}」开一个剧情分支沙盘（action=open），`,
    '然后提出 3 个**实质不同**的候选方向（action=submit）：每个候选给出 core_action / conflict / character_choices / beats / consequences / relations_foreshadows / risks / required_setup / intent_relation。',
    '人物选择必须引用该角色当前可行动的事实（先用 novel_state 的 status=disclosure 查 basis_ids）：不能因为你看得见作者真相就让角色提前知道秘密；后果里 certainty=established 只能用于已发生的事，未来计划不得冒充已发生。',
    '候选只是提案：不要采纳、不要改正文或故事状态（采纳/丢弃由作者在界面上决定）。',
  ].join('');
}

function branchCandidateHtml(c) {
  const counts = c.counts || {};
  const stale = c.stale_now || c.stale;
  return `<div class="st-character-item">
    <div class="row"><b>#${esc(String(c.id))} ${esc(c.title || '(无标题)')}</b>
      <span class="chip">${esc(String(c.status || ''))}</span>
      <span class="muted" style="font-size:12px">第 ${esc(String(c.ordinal ?? ''))} 个｜来源 ${c.created_by === 'agent' ? '模型提交' : '作者/界面'}${c.deps_hash ? `｜基线 ${esc(String(c.deps_hash).slice(0, 12))}` : ''}</span>
    </div>
    <div style="font-size:13px">核心行动：${esc(c.core_action || '')}</div>
    <div class="muted" style="font-size:12px">冲突：${esc(c.conflict || '')}｜人物选择 ${esc(String(counts.choices ?? 0))}｜节拍 ${esc(String(counts.beats ?? 0))}｜后果 ${esc(String(counts.consequences ?? 0))}｜风险 ${esc(String(counts.risks ?? 0))}｜必要铺垫 ${esc(String(counts.required_setup ?? 0))}｜关系/伏笔 ${esc(String(counts.relations_foreshadows ?? 0))}｜与意图 ${esc(c.intent_stance || 'neutral')}</div>
    ${stale ? `<div style="font-size:12px;color:#b45309">⚠ 已过期（${esc((c.stale_changed || []).join('、') || '依赖基线已变化')}）：旧候选仍可阅读；重新采纳必须先复核。</div>` : ''}
    <div class="row mt-8" style="gap:6px">
      <button class="btn small secondary" data-action="branch-view" data-id="${esc(String(c.id))}">查看</button>
      ${c.status === 'candidate' ? `
        <button class="btn small" data-action="branch-adopt" data-id="${esc(String(c.id))}" title="只写章节蓝图与契约建议；正文/事实/角色状态一律不动">采用</button>
        <button class="btn small secondary" data-action="branch-discard" data-id="${esc(String(c.id))}">丢弃</button>` : ''}
    </div>
  </div>`;
}

function renderBranchCard() {
  const b = state.branch;
  if (!b) {
    return `<div class="card mb-12"><div class="card-head"><span class="card-title">剧情分支沙盘</span></div>
      <div class="muted">当前服务端不提供该接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  const sandboxes = (b.sandboxes && b.sandboxes.sandboxes) || [];
  const candidates = (b.candidates && b.candidates.candidates) || [];
  const active = candidates.filter((c) => c.status !== 'discarded');
  return `
    <div class="card mb-12">
      <div class="card-head">
        <span class="card-title">剧情分支沙盘${helpDot('branch_sandbox')}</span>
        <button class="btn small secondary" data-action="branch-submit" ${state.currentChapterId ? '' : 'disabled'} title="提交候选（JSON）：宿主会做形状/知识边界/差异/查重四道校验">提交候选</button>
        <button class="btn small secondary" data-action="branch-open-sandbox" ${state.currentChapterId ? '' : 'disabled'}>开沙盘</button>
        <button class="btn small secondary" data-action="branch-compare" ${active.length >= 2 ? '' : 'disabled'} title="并列比较只列差异，不替作者打分">比较全部候选</button>
        <button class="btn small secondary" data-action="copy-text" data-copy="${esc(branchPromptText())}" title="复制给 dsh 会话用（复制本身不调用模型）">复制沙盘提示词</button>
      </div>
      <div class="muted" style="font-size:12px">候选是<b>提案</b>：未采纳前不进正文、不进正典事实/事件/角色知识/上下文层，也不触发记忆同步。采纳只写章节蓝图与契约建议——正文与角色状态一律不动。采纳/丢弃/取消/重开是作者动作（模型侧调用返回 403）。</div>
      ${state.currentChapterId ? '' : '<div class="muted mt-8">先在「正文写作」里选一个章节：沙盘必须以具体章节为时点（角色知识边界按当前章判定）。</div>'}
      ${sandboxes.length ? `
        <div class="mt-8">
          <b style="font-size:13px">沙盘</b>
          ${sandboxes.map((sb) => `
            <div class="st-character-item">
              <div class="row"><b>沙盘 #${esc(String(sb.id))}</b>
                <span class="chip">${esc(String(sb.status || ''))}</span>
                <span class="muted" style="font-size:12px">章节 #${esc(String(sb.chapter_id ?? ''))}｜候选 ${esc(String((sb.progress || {}).done ?? 0))}/${esc(String(sb.requested ?? '?'))}${(sb.progress || {}).complete ? '（已满）' : `（还差 ${esc(String((sb.progress || {}).missing ?? '?'))} 个）`}｜基线 ${esc(String((sb.deps || {}).hash || '').slice(0, 12))}</span>
              </div>
              <div class="row mt-8" style="gap:6px">
                <button class="btn small secondary" data-action="branch-cancel" data-id="${esc(String(sb.id))}">取消（保留已产出候选）</button>
                <button class="btn small secondary" data-action="branch-reopen" data-id="${esc(String(sb.id))}">重启恢复（只补未完成槽位）</button>
              </div>
            </div>`).join('')}
        </div>` : ''}
      <div class="mt-8">
        <b style="font-size:13px">候选（${candidates.length}）</b>
        <div class="muted" style="font-size:12px">${esc((b.candidates && b.candidates.note) || '')}</div>
        ${candidates.length ? candidates.map(branchCandidateHtml).join('') : '<div class="muted">这一章还没有候选：点「开沙盘」定基线，再用「提交候选」提交 2—5 个方向；也可以把「复制沙盘提示词」发给 dsh 会话，让它用 novel_branch 提交。</div>'}
      </div>
    </div>`;
}

function openBranchSandboxModal() {
  if (!state.currentChapterId) { toast('先在「正文写作」里选一个章节（沙盘以章节为时点）', 'error'); return; }
  openModal({
    title: '开一个剧情分支沙盘',
    body: `<div class="field"><label>想要几个候选方向（2—5）</label><input id="branch-requested" type="number" min="2" max="5" value="3"></div>
      <div class="muted">沙盘会先固定依赖基线（故事状态 / 正文 / 契约 / 作者意图 / 披露指纹）：之后任何一项变化，旧候选都会标「已过期」，重新采纳前必须先复核。</div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="branch-do-open">开沙盘</button>`
  });
}

async function branchCreateSandbox() {
  try {
    const el = $('#branch-requested');
    const requested = Number(el && el.value) || 3;
    await api('/novel/branch/sandboxes', { method: 'POST', body: { work_id: state.workId, chapter_id: state.currentChapterId, requested } });
    closeModal();
    state.branch = null;
    toast('沙盘已开：接下来提交 2—5 个实质不同的候选方向', 'success');
    await render();
  } catch (e) { toast(`开沙盘失败：${e.message}`, 'error'); }
}

function branchTemplate() {
  const ch = state.chapters.find((c) => c.id === state.currentChapterId);
  const char = (state.characters || [])[0];
  const name = char ? char.name : '主角';
  return JSON.stringify([
    {
      title: '方向一（示例：请替换成真实方向）',
      core_action: `${name}在${ch ? ch.title : '本章'}做出第一个关键选择`,
      conflict: '这个选择与当前处境的核心矛盾正面相撞',
      character_choices: [{ character_id: char ? char.id : null, name, choice: '选择 A 而不是 B（写清理由）', basis_ids: [], basis_keys: [], basis_note: '该角色此刻能知道的信息（没有事实 id 时必须写清依据）' }],
      beats: ['节拍一', '节拍二', '节拍三'],
      consequences: [{ text: '可能发生的后果（计划/推测）', certainty: 'possible' }],
      relations_foreshadows: [{ kind: 'foreshadow', text: '推进或埋下哪条伏笔' }],
      risks: ['这样写的风险'],
      required_setup: ['要让读者信服，需要提前铺垫什么'],
      intent_relation: { text: '与作者意图的关系（沿用/扩展/冲突）', stance: 'neutral' }
    }
  ], null, 2);
}

function openBranchSubmitModal() {
  if (!state.currentChapterId) { toast('先在「正文写作」里选一个章节', 'error'); return; }
  const sb = ((state.branch && state.branch.sandboxes && state.branch.sandboxes.sandboxes) || []).find((x) => x.status === 'open');
  openModal({
    title: '提交候选（宿主四道校验）',
    large: true,
    body: `<div class="muted" style="font-size:12px">每个候选至少要有 core_action / conflict / character_choices / consequences。既有角色的行动理由必须引用该角色当前可行动的事实 id（basis_ids）或已知键（basis_keys），或写清 basis_note；新角色要写 new_character:true。宿主会校验形状、角色知识边界、候选差异与查重：不合法或与已有候选实质重复会<b>整批拒绝</b>（一个都不写）。</div>
      <textarea id="branch-candidates-json" rows="14" placeholder='[{"title":"...","core_action":"...","conflict":"...","character_choices":[{"character_id":1,"choice":"...","basis_ids":[1]}],"consequences":[{"text":"...","certainty":"possible"}]}]'></textarea>
      <div class="row mt-8"><button class="btn small secondary" data-action="branch-fill-template">填入模板</button>
      <span class="muted" style="font-size:12px">沙盘：${sb ? `#${esc(String(sb.id))}（${esc(String((sb.progress || {}).done ?? 0))}/${esc(String(sb.requested))}${(sb.progress || {}).complete ? '，已满' : ''}）` : '还没有打开的沙盘——提交时会按本章基线自动开一个'}</span></div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="branch-do-submit" data-sandbox-id="${sb ? esc(String(sb.id)) : ''}">提交</button>`
  });
}

async function branchSubmitCandidates(sandboxId) {
  const ta = $('#branch-candidates-json');
  const raw = ta ? String(ta.value || '').trim() : '';
  if (!raw) { toast('请先粘贴候选 JSON（可点「填入模板」）', 'error'); return; }
  let candidates;
  try { candidates = JSON.parse(raw); } catch (e) { toast(`候选 JSON 不合法：${e.message}`, 'error'); return; }
  if (!Array.isArray(candidates) || !candidates.length) { toast('候选必须是非空数组（一次 2—5 个不同方向）', 'error'); return; }
  try {
    const out = await api('/novel/branch/candidates', {
      method: 'POST',
      body: { work_id: state.workId, chapter_id: state.currentChapterId, sandbox_id: sandboxId || undefined, candidates }
    });
    closeModal();
    state.branch = null;
    const warn = (out.knowledge || []).filter((k) => k.status !== 'checked');
    toast(`已提交 ${(out.candidates || []).length} 个候选（沙盘 #${(out.sandbox || {}).id}：${(out.progress || {}).done ?? 0}/${(out.progress || {}).requested ?? '?'}）${warn.length ? `；${warn.length} 条知识约束提示见下` : ''}`, 'success');
    await render();
  } catch (e) { toast(`提交被拒（整批未写入）：${e.message}`, 'error'); }
}

async function branchView(id) {
  try {
    const data = await api(`/novel/branch/candidates/${id}`);
    const c = data.candidate || {};
    const plan = data.adoption_plan || {};
    const bp = plan.blueprint || {};
    const li = (x) => `<li>${esc(x)}</li>`;
    openModal({
      title: `候选 #${c.id} ${c.title || ''}`,
      large: true,
      body: `
        <div class="muted" style="font-size:12px">章节 #${esc(String(c.chapter_id))}｜沙盘 #${esc(String(c.sandbox_id))}｜状态 ${esc(String(c.status))}｜来源 ${c.created_by === 'agent' ? '模型提交' : '作者/界面'}｜基线 ${esc(String(c.deps_hash || '').slice(0, 16))}</div>
        ${c.stale_now ? `<div style="color:#b45309">⚠ 已过期（${esc((c.stale_changed || []).join('、'))}）：旧候选仍可阅读；重新采纳必须先复核。${c.status === 'candidate' ? '（可用下方「复核并采用」）' : ''}</div>` : '<div class="muted">依赖基线仍一致。</div>'}
        <div class="mt-8"><b>核心行动</b>：${esc(c.core_action || '')}</div>
        <div><b>冲突</b>：${esc(c.conflict || '')}</div>
        <div class="mt-8"><b>人物选择</b><ul>${(c.character_choices || []).map((x) => li(`${x.name || '#' + x.character_id}：${x.choice}（依据 ${(x.basis_ids || []).join('、') || (x.basis_keys || []).join('、') || x.basis_note || '—'}）`)).join('') || '<li>（无）</li>'}</ul></div>
        <div><b>剧情节拍</b><ul>${(c.beats || []).map((b) => li(b.text)).join('') || '<li>（无）</li>'}</ul></div>
        <div><b>可能后果</b><ul>${(c.consequences || []).map((x) => li(`${x.text}〔${x.certainty}〕`)).join('') || '<li>（无）</li>'}</ul></div>
        <div><b>关系/伏笔</b><ul>${(c.relations_foreshadows || []).map((x) => li(`[${x.kind}] ${x.text}`)).join('') || '<li>（无）</li>'}</ul></div>
        <div><b>风险</b><ul>${(c.risks || []).map((x) => li(x.text)).join('') || '<li>（无）</li>'}</ul></div>
        <div><b>必要铺垫</b><ul>${(c.required_setup || []).map((x) => li(x.text)).join('') || '<li>（无）</li>'}</ul></div>
        <div><b>与作者意图</b>：${esc((c.intent_relation || {}).stance || 'neutral')}｜${esc((c.intent_relation || {}).text || '')}</div>
        <div class="mt-8 muted" style="font-size:12px">采纳计划（只写章节蓝图 + 可选契约建议；正文/事实/角色状态一律不动）：场景目标 = ${esc(bp.scene_goal || '')}${(plan.contract_suggestion || {}).note ? `；${esc(plan.contract_suggestion.note)}` : ''}</div>
        <div class="muted" style="font-size:12px">只读边界：${esc((plan.never_touched || []).join('、'))}</div>`,
      footer: `${c.status === 'candidate' ? `<button class="btn secondary" data-action="branch-discard" data-id="${esc(String(c.id))}">丢弃</button>
        <button class="btn secondary" data-action="branch-adopt-force" data-id="${esc(String(c.id))}" title="基线已变时先复核再采纳">复核并采用</button>
        <button class="btn" data-action="branch-adopt" data-id="${esc(String(c.id))}">采用</button>` : '<span class="muted">已采纳/已丢弃：不再提供操作</span>'}
        <button class="btn secondary" data-close-modal>关闭</button>`
    });
  } catch (e) { toast(`读取候选失败：${e.message}`, 'error'); }
}

async function branchCompareAll() {
  try {
    const list = ((state.branch && state.branch.candidates && state.branch.candidates.candidates) || []).filter((c) => c.status !== 'discarded');
    if (list.length < 2) { toast('至少要有 2 个候选才能比较', 'error'); return; }
    const out = await api('/novel/branch/compare', { method: 'POST', body: { work_id: state.workId, ids: list.map((c) => c.id).slice(0, 5) } });
    const blocks = (out.comparisons || []).map((cmp) => `
      <div class="mt-8"><b>候选 #${cmp.a.id} ${esc(cmp.a.title || '')} ↔ #${cmp.b.id} ${esc(cmp.b.title || '')}</b>
        <div class="muted" style="font-size:12px">差异 ${cmp.differences.length}/9 维：${esc(cmp.differences.join('、') || '（无差异）')}</div>
        <ul>${(cmp.dimensions || []).filter((d) => !d.same).map((d) => `<li>${esc(d.label)}：#${cmp.a.id} ${esc(String(d.a))} ↔ #${cmp.b.id} ${esc(String(d.b))}</li>`).join('')}</ul>
      </div>`).join('');
    openModal({
      title: '并列比较（只列差异，不替作者打分或排序）',
      large: true,
      body: `<div class="muted" style="font-size:12px">${esc(out.note || '')}</div>${blocks || '<div class="muted">没有可比较的差异。</div>'}`,
      footer: '<button class="btn secondary" data-close-modal>关闭</button>'
    });
  } catch (e) { toast(`比较失败：${e.message}`, 'error'); }
}

async function branchAdopt(id, recheck = false) {
  try {
    const out = await api(`/novel/branch/candidates/${id}/adopt`, { method: 'POST', body: { work_id: state.workId, recheck: !!recheck } });
    closeModal();
    state.branch = null;
    state.aiContext = null;
    if (out.already_adopted) toast(`候选 #${id} 之前已经采纳过（没有重复写）`, 'success');
    else toast(`已采纳候选 #${id}：只写章节蓝图${out.contract_saved ? '与契约建议' : ''}；正文/事实/角色状态未动`, 'success');
    await render();
  } catch (e) {
    if (/过期/.test(String(e.message)) && !recheck) {
      toast(`候选已过期（${e.message}）：旧候选仍可读；点「复核并采用」先复核再写蓝图`, 'error');
    } else {
      toast(`采纳失败：${e.message}`, 'error');
    }
  }
}

function openBranchConfirm(kind, id) {
  const isDiscard = kind === 'discard';
  openModal({
    title: isDiscard ? `丢弃候选 #${id}` : `取消沙盘 #${id}`,
    body: `<div>${isDiscard ? '丢弃后该候选不能再采纳（行保留、状态改为 discarded，可复盘）。' : '取消后已产出的候选仍可阅读；恢复只继续未完成槽位，不重跑已完成候选。'}</div>`,
    footer: `<button class="btn secondary" data-close-modal>再想想</button>
      <button class="btn" data-action="${isDiscard ? 'branch-do-discard' : 'branch-do-cancel'}" data-id="${esc(String(id))}">${isDiscard ? '丢弃' : '取消沙盘'}</button>`
  });
}

async function branchDiscard(id) {
  try {
    await api(`/novel/branch/candidates/${id}/discard`, { method: 'POST', body: { work_id: state.workId } });
    closeModal(); state.branch = null;
    toast(`候选 #${id} 已丢弃（未采纳的候选本来就不是本书事实）`, 'success');
    await render();
  } catch (e) { toast(`丢弃失败：${e.message}`, 'error'); }
}

async function branchCancel(id) {
  try {
    await api(`/novel/branch/sandboxes/${id}/cancel`, { method: 'POST', body: { work_id: state.workId } });
    closeModal(); state.branch = null;
    toast(`沙盘 #${id} 已取消：已产出的候选保留可读`, 'success');
    await render();
  } catch (e) { toast(`取消失败：${e.message}`, 'error'); }
}

async function branchReopen(id) {
  try {
    const out = await api(`/novel/branch/sandboxes/${id}/reopen`, { method: 'POST', body: { work_id: state.workId } });
    state.branch = null;
    const p = out.sandbox && out.sandbox.progress;
    toast(`沙盘 #${id} 已恢复（${p ? `${p.done}/${p.requested}` : ''}）：只补未完成槽位，不重跑已有候选`, 'success');
    await render();
  } catch (e) { toast(`恢复失败：${e.message}`, 'error'); }
}
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
        <div class="field full"><label>别名/称呼（逗号分隔，用于上下文命中）</label><input name="aliases" value="${esc(character?.aliases || '')}" placeholder="例如：云仔、李队"><div class="muted mt-4" style="font-size:12px">留空 = 正文里只认主名。填了简称/绰号，改稿或续写时用简称提到他也能被认出（别名参与出场判定与一致性核对）。</div></div>
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

// ---------- R12：导入后分析重建（分批抽取 / 基线 / 恢复；作者确认 = 逐批原子应用） ----------
// 分工：抽取由本前端**按批**请求模型（离线测试注入 state.rebuildRunner），宿主只做校验、记账与确认；
// 候选未确认前不进任何正式状态；确认在一个短事务里批量原子应用（服务端 applyProposalsBatch）。
const REBUILD_STATE_LABEL = { reuse: '可复用', stale: '已过期', pending: '待抽取' };

async function loadRebuild(force = false) {
  if (state.rebuildLoaded && !force) return state.rebuild;
  try {
    const data = await api(`/import/rebuild/status?work_id=${state.workId}`);
    state.rebuild = data && data.ok ? data : null;
  } catch (_) {
    state.rebuild = null; // 旧服务端没有该接口：如实显示不可用，不假装有重建流程
  }
  state.rebuildLoaded = true;
  return state.rebuild;
}

function rebuildBatchById(index) {
  const r = state.rebuild;
  if (!r || !Array.isArray(r.batches)) return null;
  return r.batches.find((x) => Number(x.batch_index) === Number(index)) || null;
}

/** 一批的抽取提示词：只带本批章节（整本书绝不进一次请求）。 */
function rebuildPromptForBatch(batch) {
  const byId = new Map(state.chapters.map((c) => [Number(c.id), c]));
  const parts = [
    '你是小说资料抽取器。只输出 JSON（不要解释、不要在代码块之外写说明）。',
    'JSON 形状：{"items":[{"category":"...","chapter_id":123,"chapter_index":0,"evidence":{"quote":"原文中的一段话","location":"出现位置"},"data":{...}}]}',
    'category 只能取：entity / alias / relation / location / timeline / event / foreshadow / character_state / disclosure。',
    '规则：',
    '1) 每个 item 必须带 evidence.quote，且 quote 必须能在该章正文里**原样找到**（不许改写、不许编造、不许跨章引用）。',
    '2) 不得替作者发明尚未揭示的秘密：正文没写的不要推断成事实。',
    '3) 互相矛盾的候选都要保留（加 "conflict": true），不要自行裁决。',
    '4) data 给最小字段：entity/alias/location → {name|canonical_name, kind, aliases}；relation → {subject, relation, value}；timeline → {story_time, relative_time, label, seq}；event → {summary}；foreshadow → {summary}；character_state → {character, state}；disclosure → {character, fact}。',
    '',
    `本批共 ${(batch.chapter_ids || []).length} 章，逐章抽取：`,
  ];
  for (const cid of (batch.chapter_ids || [])) {
    const ch = byId.get(Number(cid));
    if (!ch) continue;
    const text = String(ch.content || '').replace(/<[^>]*>/g, '').slice(0, 6000);
    parts.push(`【章节 #${cid}｜${ch.title || ''}】`, text, '');
  }
  return parts.join('\n');
}

function renderRebuildCard() {
  const r = state.rebuild;
  if (r === null) {
    return `<div class="card mb-12"><div class="card-head"><span class="card-title">导入后重建创作状态</span></div>
      <div class="muted">当前服务端不提供该接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>`;
  }
  const run = r.run;
  const batches = Array.isArray(r.batches) ? r.batches : [];
  const counts = r.counts || {};
  const progress = r.progress || {};
  const label = (x) => REBUILD_STATE_LABEL[x] || String(x || '');
  const titlesOf = (ids) => (ids || []).map((id) => { const c = state.chapters.find((x) => Number(x.id) === Number(id)); return c ? c.title : ('#' + id); }).join('、');
  return `
    <div class="card mb-12">
      <div class="card-head">
        <span class="card-title">导入后重建创作状态${helpDot('import_rebuild')}</span>
        <button class="btn small" data-action="rebuild-plan">${run ? '按当前正文重新规划' : '规划分析批次'}</button>
        <button class="btn small secondary" data-action="rebuild-refresh">刷新进度</button>
        ${run && run.status === 'cancelled' ? '<button class="btn small secondary" data-action="rebuild-resume">恢复（复用未过期批次）</button>' : ''}
      </div>
      <div class="muted" style="font-size:12px">可选的「分析并重建创作状态」：分批抽取 → 作者确认 → 逐批<b>原子</b>写入既有提案设施（确认即应用，失败整批回滚）。候选未确认前不进正文、不进事实/事件/角色知识；正文或抽取配置变化会让旧结果标「已过期」，必须重跑；恢复不会重跑已完成且基线一致的批次。</div>
      ${run ? `
        <div class="mt-8" style="font-size:12px">
          <span class="chip">运行 #${esc(String(run.id))}</span>
          <span class="chip">${esc(String(run.status))}</span>
          <span class="muted">批次 ${esc(String(batches.length))}｜可复用 ${esc(String(counts.reuse || 0))}｜过期 ${esc(String(counts.stale || 0))}｜待抽取 ${esc(String(counts.pending || 0))}｜已抽取待确认 ${esc(String(progress.extracted || 0))}｜已确认 ${esc(String(progress.confirmed || 0))}｜失败 ${esc(String(progress.failed || 0))}｜候选 ${esc(String(progress.proposals || 0))}</span>
        </div>
        ${batches.map((b) => `
          <div class="st-character-item">
            <div class="row"><b>批次 ${esc(String(Number(b.batch_index) + 1))}/${esc(String(batches.length))}</b>
              <span class="chip">${esc(label(b.state))}</span>
              <span class="muted" style="font-size:12px">${esc(titlesOf(b.chapter_ids))}｜${esc(String(b.chars))} 字｜基线 ${esc(String(b.baseline_hash || '').slice(0, 12))}${b.result_hash ? `｜结果 ${esc(String(b.result_hash).slice(0, 12))}` : ''}${b.attempts ? `｜尝试 ${esc(String(b.attempts))}` : ''}</span>
            </div>
            ${b.reason ? `<div class="muted" style="font-size:12px">${esc(b.reason)}</div>` : ''}
            <div class="row mt-8" style="gap:6px">
              ${b.state !== 'reuse' && b.db_status !== 'confirmed' ? `<button class="btn small secondary" data-action="rebuild-extract" data-index="${esc(String(b.batch_index))}">抽取本批</button>` : ''}
              ${b.db_status === 'extracted' ? `<button class="btn small" data-action="rebuild-confirm" data-index="${esc(String(b.batch_index))}">确认应用本批（${esc(String(b.proposals))} 条候选）</button>` : ''}
            </div>
          </div>`).join('')}
        <div class="row mt-8" style="gap:6px">
          <button class="btn small secondary" data-action="rebuild-confirm-all" ${batches.some((b) => b.db_status === 'extracted') ? '' : 'disabled'}>确认全部已抽取批次</button>
          <button class="btn small secondary" data-action="rebuild-cancel" ${run.status === 'cancelled' ? 'disabled' : ''}>取消（保留已记录结果）</button>
          <button class="btn small secondary" data-action="copy-text" data-copy="${esc(rebuildPromptForBatch(batches[0] || { chapter_ids: [] }))}" title="复制给 dsh 会话用（复制本身不调用模型）">复制抽取提示词（首批）</button>
        </div>
        <div class="muted mt-8" style="font-size:12px">「抽取本批」会用当前模型配置按批请求一次（<b>会产生费用</b>）；也可以复制提示词交给 dsh 会话，再把返回的 JSON 记回（record 接口）。</div>
      ` : '<div class="muted mt-8">还没有重建运行：点「规划分析批次」把作品切成有上限的批次（整本书绝不会塞进一次请求）。</div>'}
    </div>`;
}

/** 渲染失败不得掩盖"动作已成功"的结论：单独兜底并如实记录客户端日志。 */
async function rebuildRenderSafely() {
  try { await render(); }
  catch (e) { reportClientLog({ level: 'warn', kind: 'rebuild_render_failed', message: `[导入重建] 渲染失败（动作已生效）：${e.message}` }); }
}

async function rebuildPlan() {
  try {
    const r = state.rebuild;
    const body = { work_id: state.workId };
    if (r && r.run && r.run.status !== 'confirmed') body.run_id = r.run.id;
    const out = await api('/import/rebuild/plan', { method: 'POST', body });
    state.rebuild = null; state.rebuildLoaded = false;
    await loadRebuild(true);
    const c = out.counts || {};
    toast(`已规划 ${(out.batches || []).length} 个批次（可复用 ${c.reuse || 0} / 过期 ${c.stale || 0} / 待抽取 ${c.pending || 0}）`, 'success');
    await rebuildRenderSafely();
  } catch (e) { toast(`规划失败：${e.message}`, 'error'); }
}

async function rebuildExtractBatch(index) {
  const b = rebuildBatchById(index);
  if (!b) { toast('批次不存在', 'error'); return; }
  if (!state.rebuild || !state.rebuild.run) { toast('还没有重建运行：先规划批次', 'error'); return; }
  try {
    const prompt = rebuildPromptForBatch(b);
    const runner = typeof state.rebuildRunner === 'function'
      ? state.rebuildRunner
      : (({ prompt: p, label }) => runPipelineStage(p, { stageLabel: label }));
    const raw = await runner({ index: b.batch_index, label: `导入重建·批次 ${Number(b.batch_index) + 1}`, prompt });
    let payload = String(raw || '').trim();
    const fence = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) payload = fence[1].trim();
    const start = payload.indexOf('{'); const end = payload.lastIndexOf('}');
    const result = JSON.parse(payload.slice(start, end + 1)); // 解析失败交给 record 的校验口径报错
    const out = await api('/import/rebuild/record', { method: 'POST', body: { run_id: state.rebuild.run.id, batch_index: b.batch_index, result } });
    state.rebuild = null; state.rebuildLoaded = false;
    await loadRebuild(true);
    toast(`批次 ${Number(b.batch_index) + 1} 已记录：${out.proposals} 条候选待确认`, 'success');
    await rebuildRenderSafely();
  } catch (e) { toast(`本批抽取失败：${e.message}`, 'error'); }
}

async function rebuildConfirm(indexes) {
  if (!state.rebuild || !state.rebuild.run) { toast('还没有重建运行', 'error'); return; }
  try {
    const body = { run_id: state.rebuild.run.id };
    if (Array.isArray(indexes) && indexes.length) body.batch_indexes = indexes;
    const out = await api('/import/rebuild/confirm', { method: 'POST', body });
    state.rebuild = null; state.rebuildLoaded = false;
    await loadRebuild(true);
    toast(`已确认 ${out.applied} 批：登记并原子应用 ${out.proposals_created} 条提案${out.stale ? `；${out.stale} 批已过期需重跑` : ''}`, out.stale ? 'warn' : 'success');
    await rebuildRenderSafely();
  } catch (e) { toast(`确认失败：${e.message}`, 'error'); }
}

async function rebuildCancel() {
  if (!state.rebuild || !state.rebuild.run) { toast('还没有重建运行', 'error'); return; }
  try {
    await api('/import/rebuild/cancel', { method: 'POST', body: { run_id: state.rebuild.run.id } });
    state.rebuild = null; state.rebuildLoaded = false;
    await loadRebuild(true);
    toast('已取消：已记录的批次结果保留，恢复时只补未完成/过期的批次', 'success');
    await rebuildRenderSafely();
  } catch (e) { toast(`取消失败：${e.message}`, 'error'); }
}
async function renderST(content) {
  const currentChapter = state.chapters.find((c) => c.id === state.currentChapterId) || null;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🧩 创作上下文 ${helpDot('creation_context')}</h1>
        <div class="page-sub">管理角色卡、世界观词条和作者注（本页只加载这三类素材；长期记忆在“小说设定 → 长期记忆”）</div>
      </div>
    </div>
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">作品作者注 ${helpDot('work_note')}</span><button class="btn small secondary" data-action="ai-gen-work-note" title="AI 起草作品作者注">✨ AI 起草</button><button class="btn small" data-action="save-st-work-note">保存作品作者注</button></div>
      <textarea id="st-work-author-note" rows="3" placeholder="整部作品通用的 AI 提示，支持 {title} {work} {characters} {summary}">${esc(state.work?.author_note || '')}</textarea>
    </div>
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">章节作者注 ${helpDot('chapter_note')}</span></div>
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
      <div class="muted" style="font-size:12px;margin-bottom:6px">角色卡 / 世界观词条 / 作者注都是喂给 AI 的素材（不影响正文与作品数据）</div>
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
      <div class="muted mb-8" style="font-size:12px">世界观词条独立于「小说设定 → 设定库」：设定库词条用于正文选中后关联与悬停预览；世界观词条（可固定、设优先级）会随 AI 写作上下文激活。</div>
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

// ---------- T6：五组独立页面（各自独立 load / render / 空态 / 错误态） ----------
// 独立路由：state.aiTab 即 route key（见 AI_TABS），随会话持久化（刷新后回到原页）；
// 每页只调用自己的 loader——「创作上下文」不再连带加载这五页（旧行为：打开一次全量加载五份数据）。

function aiSubPageHead(title, helpKey, note) {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">${title}${helpKey ? ' ' + helpDot(helpKey) : ''}</h1>
        <div class="page-sub">${esc(note)}</div>
      </div>
      <div class="page-actions">
        <button class="btn secondary" data-action="go-view" data-view="st">← 创作上下文</button>
      </div>
    </div>`;
}

async function renderEditRulesPage(content) {
  await loadEditRules();
  content.innerHTML = aiSubPageHead('📐 编辑规则', 'edit_rules', '三档编辑 / 创作能力 / 题材；独立读取、保存与生效预览')
    + renderEditRulesCard();
}

async function renderAuthorStylePage(content) {
  await loadAuthorStyle();
  content.innerHTML = aiSubPageHead('🖋️ 作者样文与文风档案', 'author_style', '样文 / 文风档案 / 作者意图与版本；样文变化只使风格派生数据失效')
    + renderAuthorStyleCard();
}

async function renderStoryStatePage(content) {
  await loadStoryState();
  await Promise.all([loadImpactRuns(), loadRepairRuns(), loadTemporalEngine(), loadBackfill()]);
  content.innerHTML = aiSubPageHead('🧭 故事状态与读者披露', 'disclosure', '时间轴 / 知识视图 / 审批 / 影响与逐章重建；可按章前 / 章后查询')
    + renderStoryStateCard()
    + renderTemporalEngineCard()
    + `<div id="impact-section">${impactSectionHtml()}</div>`
    + `<div id="repair-section">${repairSectionHtml()}</div>`
    + renderBackfillCard();
}

async function renderBranchPage(content) {
  await loadBranch();
  content.innerHTML = aiSubPageHead('🌿 剧情分支沙盘', 'branch_sandbox', '规划候选比较与采用蓝图；沙盘候选与正典隔离')
    + renderBranchCard();
}

async function renderRebuildPage(content) {
  await loadRebuild();
  content.innerHTML = aiSubPageHead('📥 导入后重建创作状态', 'import_rebuild', '导入分析、分批复核与恢复进度；与日常改稿重建共享底层抽取')
    + renderRebuildCard();
}

// 小说设定 → 长期记忆 / 故事摘要
async function renderMemory(content) {
  const currentChapter = state.chapters.find((c) => c.id === state.currentChapterId) || null;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">🧠 长期记忆 / 故事摘要 ${helpDot('long_memory')}</h1>
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
      <div class="card-head"><span class="card-title">章节作者注（联动） ${helpDot('chapter_note')}</span></div>
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
    title: '📥 待审核提案（候选）',
    body: list.length
      ? `<div class="muted mb-8">以下内容仍是候选，不会自动修改正文或故事状态。请核对来源、时间和影响后再采纳：</div>
         <div class="proposal-box">${list.map(proposalItemHtml).join('')}</div>`
      : '<div class="muted">当前没有待审核提案。AI 写作完成后的收尾入账会先以候选状态出现在这里。</div>',
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
  const refs = collectCheckedProposalRefs(modalEl || document);
  const checked = proposalIdsOfRefs(refs);
  try {
    const data = await api(`/novel/proposals/${action}`, { method: 'POST', body: { work_id: workId, ids: checked, refs } });
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
    // D8-#4：走作业入口而不是同步端点——于是有了进度、可取消、落库与"可恢复任务"。
    // 注意 body 是 { kind, work_id }，产出在 result.summary 上（不再是顶层的 summary）。
    const data = await runHarnessJob(
      { kind: 'compress', work_id: state.workId, timeout: longAiTimeout() },
      '压缩长期记忆',
      '/harness/job');
    el.value = data.result?.summary || '';
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

// F-23：LCS 差异核心——对已切分的 token 数组做最长公共子序列对齐，返回 [{t:'same'|'del'|'add', x}]。
function diffTokens(a, b) {
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

// 句子级差异（记忆摘要通常是一整段，按句末标点切分后做 LCS）。
function diffSentences(oldText, newText) {
  const split = (s) => String(s || '').match(/[^。！？!?…\n]*[。！？!?…\n]|[^。！？!?…\n]+$/g)
    ?.map((x) => x.trim()).filter(Boolean) || [];
  return diffTokens(split(oldText), split(newText));
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
// ---------- 工具与环境清单（内容在此处编写，装没装由后端真去磁盘看） ----------
// 纪律：**清单条目的文案**是作者写的文档，**状态**一律来自 GET /api/env/tools 的真实检测；
// 两者分开，界面才不会出现"文档说装了、其实没装"。
const TOOL_SPECS = [
  {
    key: 'node',
    name: 'Node.js',
    required: true,
    why: '运行本工坊的底座。没有它服务根本起不来；版本门槛 v22.13+（node:sqlite 能力）。',
    url: 'https://nodejs.org',
    urlLabel: 'nodejs.org（下载 LTS 版）',
    cmd: 'node -v',
    status: (env) => (env && env.node
      ? { ok: true, text: `已安装 ${env.node.version}` }
      : { ok: null, text: '未检测' })
  },
  {
    key: 'dsh',
    name: 'DeepSeek Harness（dsh）',
    required: false,
    why: 'AI 写作 / 创作工作台 / 自动创建小说的运行内核。不装也能手动写作，只是这些 AI 功能用不了。',
    url: 'https://github.com/deepseek-ai/deepseek-harness',
    urlLabel: 'github.com/deepseek-ai/deepseek-harness',
    cmd: 'git clone https://github.com/deepseek-ai/deepseek-harness.git',
    status: (env) => {
      const d = env && env.dsh;
      if (!d) return { ok: null, text: '未检测' };
      if (!d.found) return { ok: false, text: '未找到（在下面「dsh 仓库路径」里填一次即可）' };
      if (d.looks_like_dsh === false) return { ok: false, text: `找到了 ${d.dir}，但它不像 dsh 仓库（请填正确路径）` };
      if (!d.built) return { ok: false, text: '已找到仓库，但缺少构建产物（首次任务会自动构建）' };
      return { ok: true, text: `已就绪 · ${d.dir}` };
    }
  },
  {
    key: 'plugin',
    name: '创作插件 novel-writing',
    required: false,
    why: '给 dsh 装上"写小说"的能力（角色卡 / 世界观 / 红线 / 蓝图流程）。源码就在本仓库里，不需要另外下载。',
    url: 'harness-plugins/novel-writing/',
    urlLabel: '本仓库 harness-plugins/novel-writing/',
    cmd: 'powershell -ExecutionPolicy Bypass -File .\\harness-plugins\\novel-writing\\install.ps1 -Profile novel',
    status: (env) => {
      const p = env && env.dsh && env.dsh.plugin;
      if (!p) return { ok: null, text: '未检测' };
      if (!p.exists) return { ok: false, text: '本仓库缺少插件源码（harness-plugins/novel-writing）' };
      const hit = (p.installs || []).find((i) => i.exists && i.points_here);
      if (hit) return { ok: true, text: `已装到 ${hit.home}（profile：${hit.profile}）` };
      const anywhere = (p.installs || []).find((i) => i.exists);
      if (anywhere) return { ok: false, text: `dsh 里有一份同名插件，但不是指向本仓库（${anywhere.path}）——建议重跑安装脚本` };
      return { ok: false, text: '尚未装进 dsh（复制下面的命令运行一次即可）' };
    }
  },
  {
    key: 'openviking',
    name: 'OpenViking 记忆库',
    required: false,
    why: '可选的本地语义记忆服务：把作品数据向量化，让 AI 能召回很久以前写过的设定与情节。不装不影响写作。',
    url: 'https://github.com/volcengine/OpenViking',
    urlLabel: 'github.com/volcengine/OpenViking',
    cmd: '',
    status: (env, ov) => {
      if (!ov) return { ok: null, text: '未检测' };
      if (ov.error) return { ok: null, text: `未检测（${ov.error}）` };
      const online = ov.healthy === null ? '未测试' : ov.healthy ? '服务在线' : '服务未响应';
      return { ok: ov.healthy === true, text: `${online} · ${ov.has_api_key ? '已配置令牌' : '未配置令牌'} · ${ov.endpoint}` };
    }
  }
];

function statusChip(ok, text) {
  const cls = ok === true ? 'ok' : ok === false ? 'err' : 'warn';
  return `<span class="env-chip ${cls}">${esc(text)}</span>`;
}

function renderToolRows(env, ov) {
  return TOOL_SPECS.map((t) => {
    const st = t.status(env, ov);
    const link = t.url
      ? (String(t.url).startsWith('http')
        ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer noopener">${esc(t.urlLabel || t.url)}</a>`
        : `<code>${esc(t.urlLabel || t.url)}</code>`)
      : '';
    const cmd = t.cmd
      ? `<div class="env-cmd"><code>${esc(t.cmd)}</code><button class="btn small secondary" data-action="copy-text" data-copy="${esc(t.cmd)}">复制</button></div>`
      : '';
    return `
      <div class="env-row">
        <div class="env-head">
          ${statusChip(st.ok, st.text)}
          <b>${esc(t.name)}</b>
          <span class="chip">${t.required ? '必需' : '可选'}</span>
        </div>
        <div class="muted">${esc(t.why)}</div>
        ${link ? `<div class="muted">安装地址：${link}</div>` : ''}
        ${cmd}
      </div>`;
  }).join('');
}

function toolListCardHtml() {
  return `
    <div class="card mt-12" id="tools-card">
      <div class="card-head">
        <span class="card-title">📦 工具与环境清单 ${helpDot('tool_list')}</span>
        <button class="btn small secondary" data-action="refresh-env-tools">重新检测</button>
      </div>
      <div id="tools-list" class="env-list"><div class="empty">检测中…</div></div>
    </div>`;
}

function openVikingCardHtml() {
  return `
    <div class="card mt-12" id="ov-card">
      <div class="card-head">
        <span class="card-title">🧠 OpenViking 记忆库 ${helpDot('openviking')}</span>
        <button class="btn small secondary" data-action="test-ov-connection">测试连接</button>
      </div>
      <div class="field">
        <label>服务地址</label>
        <input id="ov-endpoint-input" type="text" autocomplete="off" placeholder="加载中…">
        <div class="field-help">一般不用改：默认 http://127.0.0.1:1933（本机服务）。</div>
      </div>
      <div class="field">
        <label>访问令牌 / API Key ${helpDot('openviking_key')}</label>
        <input id="ov-key-input" type="password" autocomplete="new-password" placeholder="加载中…">
      </div>
      <div id="ov-status" class="field-help">加载中…</div>
      <div class="row mt-8">
        <button class="btn small" data-action="save-ov-config">保存并生效</button>
        <button class="btn small secondary" data-action="write-ov-global">写入全局配置（让 dsh 也用）</button>
        <button class="btn small danger" data-action="clear-ov-key">清除已保存的 Key</button>
      </div>
    </div>`;
}

function dshCardHtml() {
  return `
    <div class="card mt-12" id="dsh-card">
      <div class="card-head">
        <span class="card-title">🛠 本地创作内核（dsh） ${helpDot('dsh')}</span>
        <button class="btn small secondary" data-action="open-folder" data-target="dsh_repo">📂 打开目录</button>
      </div>
      <div class="field">
        <label>dsh 仓库路径 ${helpDot('dsh_repo')}</label>
        <input id="dsh-repo-input" type="text" autocomplete="off" placeholder="加载中…">
        <div class="field-help">留空 = 不带这里的覆盖。完整顺序（前者优先）：环境变量 NOVELSTUDIO_DSH_REPO → 本页填写 → 环境变量 DSH_HOME → 工坊隔壁的 deepseek-harness。不确定填什么，先点「重新检测」看它找到了哪里。</div>
      </div>
      <div id="dsh-status" class="field-help">加载中…</div>
      <div class="row mt-8">
        <button class="btn small" data-action="save-dsh-repo">保存路径</button>
        <button class="btn small secondary" data-action="refresh-env-tools">重新检测</button>
        <button class="btn small secondary" data-action="open-folder" data-target="plugin">📂 插件源码</button>
        <button class="btn small secondary" data-action="open-folder" data-target="data">📂 数据目录</button>
      </div>
    </div>`;
}

// dsh 路径来源标签（与 harness.js 的 harnessDirCandidates 一一对应）。
const DSH_SOURCE_LABELS = {
  env: '环境变量 NOVELSTUDIO_DSH_REPO',
  workshop: '本页填写',
  dsh_home: '环境变量 DSH_HOME',
  sibling: '工坊仓库隔壁的 deepseek-harness'
};

function dshSourceLabel(source) {
  const key = String(source || '').replace(/:missing$/, '');
  return (DSH_SOURCE_LABELS[key] || key || '未知') + (String(source || '').endsWith(':missing') ? '（没找到）' : '');
}

// 只刷新状态文本，不动输入框内容——否则刚敲进去的路径会被一次轮询抹掉。
function renderOpenVikingStatus() {
  const s = state.ovStatus;
  const box = $('#ov-status');
  if (!box) return;
  if (!s || s.error) {
    box.textContent = `读取失败：${(s && s.error) || '未知错误'}`;
    return;
  }
  const epInput = $('#ov-endpoint-input');
  if (epInput) {
    epInput.value = s.workshop.endpoint || '';
    epInput.placeholder = `留空则沿用：${s.endpoint}（来自 ${s.endpoint_source_label}）`;
  }
  const keyInput = $('#ov-key-input');
  if (keyInput) {
    keyInput.value = '';
    keyInput.placeholder = s.workshop.has_api_key
      ? `已保存 ${s.workshop.api_key_mask}；留空=不改动（服务端当前用：${s.api_key_source_label}）`
      : `留空则沿用：${s.api_key_source_label}${s.has_api_key ? '（已配置）' : '（未配置）'}`;
  }
  const health = s.healthy === null ? '未测试' : s.healthy ? '✅ 服务在线' : '⚠ 服务未响应（不影响手动写作）';
  box.innerHTML = [
    `生效地址：<b>${esc(s.endpoint)}</b>（来源：${esc(s.endpoint_source_label)}）`,
    `Key：${s.has_api_key ? '已配置' : '未配置'}（来源：${esc(s.api_key_source_label)}）`,
    `连接：${health}`,
    `语义召回：${s.semantic.effective_enabled ? '已启用' : '未启用'}`,
    `待重放：${s.pending} 条`
  ].join(' · ');
}

function renderEnvTools() {
  const t = state.envTools;
  const list = $('#tools-list');
  if (list) {
    list.innerHTML = (!t || t.error)
      ? `<div class="empty">检测失败：${esc((t && t.error) || '未知错误')}</div>`
      : renderToolRows(t, state.ovStatus);
  }
  const box = $('#dsh-status');
  if (!box) return;
  if (!t || t.error) {
    box.textContent = `检测失败：${(t && t.error) || '未知错误'}`;
    return;
  }
  const d = t.dsh || {};
  const input = $('#dsh-repo-input');
  if (input) {
    input.value = d.override || '';
    input.placeholder = `留空则用自动探测结果：${d.dir || '（没找到）'}`;
  }
  const checked = (d.checked || []).map((c) => `<div class="muted">${c.ok ? '✅' : '—'} ${esc(c.label)}：<code>${esc(c.dir)}</code></div>`).join('');
  const home = d.task_home || {};
  box.innerHTML = [
    statusChip(Boolean(d.found && d.looks_like_dsh !== false), d.found
      ? (d.looks_like_dsh === false ? '找到了路径，但不像 dsh 仓库' : (d.built ? '已找到并已构建' : '已找到，缺构建产物'))
      : '未找到'),
    statusChip(null, `路径来源：${dshSourceLabel(d.source)}`),
    statusChip(null, `profile：${esc(d.profile || '')}`),
    `<div class="muted mt-8">实际使用：<code>${esc(d.dir || '')}</code></div>`,
    `<div class="muted">写作任务的 DSH_HOME：<code>${esc(home.home || home.path || '')}</code>${home.home ? '' : '（专用 home 不可用，退回共享 home）'}</div>`,
    `<div class="muted">settings.yaml：<code>${esc(d.settings_file || '')}</code></div>`,
    checked ? `<details class="env-details"><summary>它按顺序找过这些位置（共 ${(d.checked || []).length} 处）</summary>${checked}</details>` : ''
  ].join(' ');
}

async function loadOpenVikingStatus() {
  try {
    state.ovStatus = await api('/novel/openviking');
  } catch (e) {
    state.ovStatus = { error: isStaleServerError(e) ? STALE_SERVER_HINT : (e.message || '读取失败') };
  }
  renderOpenVikingStatus();
  renderStaleBanner();
  // 清单里 OpenViking 那一行读的是同一份状态（单一来源，避免两处各判一次）。
  if (state.envTools) renderEnvTools();
}

async function loadEnvTools() {
  try {
    state.envTools = await api('/env/tools');
  } catch (e) {
    state.envTools = { error: isStaleServerError(e) ? STALE_SERVER_HINT : (e.message || '检测失败') };
  }
  renderEnvTools();
  renderStaleBanner();
}

// ---------- 「服务端还是旧代码」的识别与翻译 ----------
// 症状：页面文件来自磁盘（已是新版），而服务进程是**重启前**启动的 → 新接口一律
// 404 {"error":"API not found"}。新手看到这句话只会以为软件坏了，而它其实只有一个动作：
// 重启服务。所以这里把症状翻成动作，并在页面上给一条常驻提示。
const STALE_SERVER_HINT = '服务端仍在运行旧代码（这个接口要重启工坊之后才会出现）。重启方法：关掉那个黑色服务窗口（或在窗口里按 Ctrl+C），再双击 start-novel-studio.cmd，然后刷新本页（Ctrl+F5）。';

function isStaleServerError(e) {
  return Number(e && e.status) === 404 && /API not found/i.test(String((e && e.message) || ''));
}

function renderStaleBanner() {
  const box = $('#stale-banner');
  if (!box) return;
  const stale = [state.ovStatus, state.envTools].some((s) => s && s.error === STALE_SERVER_HINT);
  box.hidden = !stale;
  box.innerHTML = stale ? `⚠ ${esc(STALE_SERVER_HINT)}` : '';
}

async function renderAI(content) {
  const configs = state.apiConfigs;
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">AI 设置 ${helpDot('model_policy')}</h1>
        <div class="page-sub">API 配置 · OpenViking 记忆库 · 本地创作内核（dsh）· 工具清单</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="new-api-config">＋ 新建 API 配置</button>
      </div>
    </div>
    <div id="stale-banner" class="stale-banner" hidden></div>
    <div class="card mb-12">
      <div class="muted">当前使用：<b>${configs.find((c) => c.id === state.activeConfigId)?.name || '未选择'}</b></div>
      <div class="muted mt-8">API Key 只保存在本机 SQLite 数据库中，不会上传到任何第三方服务器（除你配置的 AI 服务商）。</div>
    </div>
    <div class="grid cols-2">
      ${configs.map((c) => {
        const t = state.apiTestResults[c.id];
        const testLine = t
          ? `<div class="muted mt-8" style="font-size:12px">上次测试：<span style="color:${t.ok ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)'}">${t.ok ? '✓ 连接成功' : '✗ 连接失败'}</span> · ${esc(t.at || '')}${t.msg ? `（${esc(t.msg)}）` : ''}</div>`
          : '';
        return `
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
          ${testLine}
          <div class="row mt-8">
            <button class="btn small secondary" data-action="test-api-config" data-id="${c.id}">测试连接</button>
            <button class="btn small secondary" data-action="edit-api-config" data-id="${c.id}">编辑</button>
            <button class="btn small danger" data-action="delete-api-config" data-id="${c.id}">删除</button>
          </div>
        </div>`;
      }).join('') || '<div class="empty">还没有 API 配置</div>'}
    </div>
    ${openVikingCardHtml()}
    ${dshCardHtml()}
    ${toolListCardHtml()}
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
  // 两张新卡各自异步加载：慢/失败都不阻塞页面渲染（失败也只在自己卡里显示原因）。
  loadOpenVikingStatus();
  loadEnvTools();
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
// 当前进度卡对象（含 runCancel）：取消动作**不再依赖"某条路径注册过回调"**，见下面的 track。
let currentProgressCard = null;
/**
 * 「谁在跑谁登记」的取消句柄集合（2026-10-02 晚）。
 *
 * 为什么需要：进度卡里的「停止」按钮原本只在调用方显式 setCancel 时才显示，
 * 而审稿/修稿管线与质检阶段各自 new 了卡却从没注册 —— 那些阶段卡片在转、却没有停止按钮
 * （作者原话："给我个停止按钮啊"）。现在改成登记制：任何在跑的活儿（harness job / 直连流式 /
 * 管线里的某一步）把自己的取消动作登记进来，卡片据此显示按钮并调用。
 */
const trackRunnerCancel = { handles: new Set() };
/** 登记"这段活儿可取消"；返回注销函数（调用方放 finally）。 */
function trackAICancel(cancelFn) {
  return currentProgressCard && typeof currentProgressCard.track === 'function'
    ? currentProgressCard.track(cancelFn)
    : () => {};
}

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

  // ── 「停止」按钮的可见性：只要当前有**任何**在跑的活儿，它就该出现 ──────────────
  //
  // 2026-10-02 晚（作者报"给我个停止按钮啊"）：按钮一直在卡片里，但默认 hidden，只有调用方
  // **显式** setCancel 时才显示 —— 而注册的只有 runHarnessJob 与直连流式两条路；
  // 审稿/修稿管线与成文管线里的质检阶段各自 new 了一张卡却从没注册，于是那些阶段
  // **卡片在转、却没有停止按钮**（作者撞到的正是这个）。
  // 现在改成"登记制"：谁在跑谁登记（job id 或 abort 句柄），卡片据此显示按钮；
  // setCancel 仍然可用（它表达的是"这条主路径自己的取消动作"），两者取或。
  let explicitCancel = null;
  const refreshStop = () => {
    if (!stopBtn) return;
    stopBtn.hidden = !(explicitCancel || trackRunnerCancel.handles.size > 0);
  };
  const runAllTracks = () => {
    for (const fn of [...trackRunnerCancel.handles]) {
      try { fn(); } catch (_) { /* 单个句柄取消失败不影响其它 */ }
    }
  };

  // 计时器与卡片必须在同一个生命周期里收：close() 之外被替换的卡（新 stage 覆盖旧卡）也会 clearInterval。
  const card = {
    seq,
    update(tail, extraLabel) {
      if (aiTaskSeq !== seq) return; // 已被更新任务卡替换，旧任务不再写屏
      if (extraLabel && labelEl) labelEl.textContent = extraLabel;
      if (!tail || !tailEl) return;
      // 进度卡显示最近 6 行并自动滚到底：用户能看到「读上下文→想蓝图→写正文」的真实进展，不再只剩最后一行。
      const lines = String(tail).split(/\r?\n/).map(sanitizeAITailLine).filter(Boolean).slice(-6);
      if (lines.length) {
        tailEl.textContent = lines.map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l)).join('\n');
        tailEl.scrollTop = tailEl.scrollHeight;
      }
    },
    note(msg) {
      if (aiTaskSeq === seq && tailEl) tailEl.textContent = msg;
    },
    setCancel(fn) {
      explicitCancel = fn || null;
      if (aiTaskSeq === seq) activeAITask = fn ? { seq, cancel: runCancel } : null;
      refreshStop();
    },
    /** 登记一个"在跑的活儿"（job id 或 abort 句柄）；返回注销函数，调用方在 finally 里调它。 */
    track(cancelFn) {
      if (typeof cancelFn !== 'function') return () => {};
      trackRunnerCancel.handles.add(cancelFn);
      refreshStop();
      return () => { trackRunnerCancel.handles.delete(cancelFn); refreshStop(); };
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

  function runCancel() {
    if (explicitCancel) { explicitCancel(); return; }
    runAllTracks();
  }

  card.runCancel = runCancel;
  currentProgressCard = card;
  refreshStop();
  return card;
}

// 提交 harness 任务并轮询状态直到结束。返回 { output, scan }。
// `endpoint` 默认为 /harness/run（自由提示词）；命名任务（生成小说 / 记忆压缩）走 /harness/job，
// 结果落在 result 上——D8-#4 把这两条"同步旁路"并进了作业设施，于是它们也有了
// 进度、取消、落库与「可恢复任务」列表。
async function runHarnessJob(body, stageLabel, endpoint = '/harness/run') {
  // F-43：互斥锁——同一时刻只允许一个 harness 任务运行，避免并发任务互相覆盖进度卡与取消回调。
  if (state.aiTaskRunning) {
    toast('已有 AI 任务进行中，请等待其完成或先点「停止」', 'error');
    const err = new Error('已有任务进行中');
    err.busy = true;
    throw err;
  }
  // ⚠️ 检查之后立即置位：旧实现把置位放在 pollHarnessJob 里（它在 POST /harness/run 的
  // await 之后才执行），两次快速点击可以同时穿过检查 —— 互斥锁在那个窗口里形同虚设。
  state.aiTaskRunning = true;
  // 🐞 运行追踪：AI 长任务归属到一条独立的长流程操作（含它触发的上下文装配与多次 API）。
  if (typeof traceLongOp === 'function') traceLongOp(stageLabel || 'AI 任务（慢通道）');
  const progress = showAITaskProgress(stageLabel);
  // ⏱ 客户端观测耗时（入队 + 轮询 + 服务端执行）。服务端另记 dsh 的 duration_ms，
  // 两者相减就是「轮询与入队的净开销」—— 这段与模型能力无关，是可以直接省掉的时间。
  const clientStartedAt = Date.now();
  try {
    const started = await api(endpoint, { method: 'POST', body });
    if (!started.job_id) {
      // 兼容旧服务端：直接返回同步结果（无取消通道，停止按钮不出现）
      return { output: started.output || '', scan: started.scan || null, proposals: started.proposals || null, result: started, ms: Date.now() - clientStartedAt };
    }
    const job = await pollHarnessJob(started.job_id, progress, { timeoutMs: Number(body?.timeout || longAiTimeout()) + 120000 });
    return { ...job, ms: Date.now() - clientStartedAt };
  } finally {
    progress.close();
    state.aiTaskRunning = false;
  }
}

/**
 * 轮询一条 harness 任务直到终态（runHarnessJob 与「接回进度」共用同一条路径）。
 * 抽出来的原因：刷新页面后要能接着盯同一条任务；若各写一份，
 * 迟早出现「重新跑的能取消、接回来的不能取消」这类不一致。
 */
async function pollHarnessJob(jobId, progress, { timeoutMs = 720000 } = {}) {
  state.aiTaskRunning = true;
  let cancelled = false;
  const cancelledErr = () => {
    const err = new Error('任务已取消');
    err.cancelled = true;
    return err;
  };
  // D7：注册停止按钮 → 服务端杀掉 dsh 子进程，轮询循环随即结束
  progress.setCancel(() => {
    cancelled = true;
    progress.note('正在取消任务…');
    api('/harness/cancel', { method: 'POST', body: { job_id: jobId } }).catch(() => { /* 服务端取消失败时轮询仍会读到终态 */ });
  });
  // 2026-10-02 晚：**再登记一次**（登记制，与上面那条显式回调并存且等价）。
  // 为什么要两条：显式回调只对"这张卡"生效，而审稿/修稿管线与成文管线的质检阶段各自 new 了
  // 一张卡（`showAITaskProgress` 在 11121/11236/11406 附近），它们没有 setCancel ——
  // 于是那些阶段**画面在转、却没有停止按钮**（作者报的正是这个）。
  // 登记是**进程级**的：任何在跑的 harness job 都会把自己挂进这张表，当前可见的那张卡
  // 一按「停止」就会把表里所有句柄都调一遍，因此"哪张卡在显示"不再决定"能不能停"。
  const untrackJob = trackAICancel(() => {
    cancelled = true;
    progress.note('正在取消任务…');
    api('/harness/cancel', { method: 'POST', body: { job_id: jobId } }).catch(() => { /* 同上 */ });
  });
  // F-10：轮询总超时 = 任务 timeout + 固定余量（120s）；轮询间隔做简单退避（1.5s 起）。
  //
  // ⏱ 上限 3s（2026-09-25 从 10s 收紧）。为什么是"收紧一个常量"而不是"新增 SSE 推送端点"：
  //   发现延迟 ≈ 下一个轮询时刻 − 任务真正完成的时刻 —— **上界就是轮询间隔上限**，与任务时长无关。
  //   按本文件这段退避推算：中位 65s 的任务在 10s 上限下平均晚 **4.5–5s** 才被发现，
  //   3s 上限下平均晚约 **1.5s**；p90 169s、max 567s 的长任务同样是这个绝对差（间隔早已触顶）。
  //   代价只有请求数 ×3 —— 每次回包 `job.tail.slice(-600)`（最多 600 字，见 server.js），
  //   服务端只读内存里的任务表、不碰数据库，在本机是免费的。
  //   而新增推送端点相对这条只多回收约 1.5s/轮，却要引入断线重连语义与双路径兼容 —— 不值得。
  //   进度"像卡死"那一半也不成立：本函数已经用 `job.tail` 在刷进度卡（下面 progress.update）。
  //   回退办法：把下面两个数字改回 10000 即可，没有别的耦合。
  const startedAt = Date.now();
  let pollDelay = 1500;
  try {
  for (;;) {
    await new Promise((r) => setTimeout(r, pollDelay));
    pollDelay = Math.min(3000, pollDelay + 1000);
    if (cancelled) throw cancelledErr(); // 用户已点停止：即使任务刚巧完成也不再采纳结果
    if (Date.now() - startedAt > timeoutMs) {
      const err = new Error(`任务轮询超时（已等待超过 ${Math.round(timeoutMs / 1000)}s，可在进度卡点「停止」取消）`);
      err.timeout = true;
      progress.note('任务超过预期时间，可点击右上「停止」取消');
      throw err;
    }
    let job;
    try {
      job = await api(`/harness/job?id=${encodeURIComponent(jobId)}`);
    } catch (e) {
      // 服务重启后内存里的任务没了：如实告知，别让用户以为还在跑。
      if (e.status === 404) {
        const err = new Error('这条任务在服务重启后已中断，无法接回；可在「取回结果」里看是否留有产出');
        err.interrupted = true;
        throw err;
      }
      if (cancelled) throw cancelledErr();
      throw new Error(`任务状态查询失败：${e.message}`);
    }
    if (cancelled) throw cancelledErr();
    // 决策 D4：任务被"模型切换互斥"挡在门外时，如实显示「在排队」。
    // 排队期间不会有任何新输出（tail 是静止的），此前界面看起来就像卡死。
    // 提示放在**最后一行**，这样在"只显示最近 6 行"的窗口里它始终可见。
    // 判定用服务端的结构化字段 model_slot，不去正则匹配中文文案。
    const ahead = Number(job.model_waiters) > 1 ? Number(job.model_waiters) - 1 : 0;
    const waiting = job.model_slot === 'waiting'
      ? `⏳ 等待模型槽位${ahead > 0 ? `（前面还有 ${ahead} 个任务）` : ''}…模型切换是串行的，前面的任务跑完会自动开始`
      : '';
    progress.update([job.tail, waiting].filter(Boolean).join('\n'));
    if (job.status === 'done') {
      return { job_id: jobId, output: job.output || '', scan: job.scan || null, proposals: job.proposals || null, kind: job.kind, stage: job.stage, chapter_id: job.chapter_id, result: job.result ?? null };
    }
    if (job.status === 'cancelled') throw cancelledErr();
    if (job.status === 'failed' || job.status === 'timeout') {
      const err = new Error(job.error || (job.status === 'timeout' ? '任务超时' : '任务失败'));
      if (job.tail) err.tail = job.tail;
      throw err;
    }
  }
  } finally {
    // 无论成功、失败、取消还是超时，都要把这条 job 从"可取消句柄"表里摘掉，
    // 否则停下来的任务会一直让后面那张卡显示一个按了没用的「停止」。
    untrackJob();
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
            // 显式下传模型/强度覆盖：此前直连分支只带 config_id，导致调用方指定的
            // model 只对 harness 回退路径生效，直连主路径仍用配置里存的旧模型。
            model: options.model || undefined,
            reasoning_effort: options.reasoningEffort || undefined,
            messages,
            temperature: config.temperature,
            max_tokens: config.max_tokens
          },
          timeout: longAiTimeout() // F-45：直连长生成（write/polish/expand 等），覆盖默认 60s
        });
        const reply = (data.reply || '').trim();
        if (reply) return reply;
        // 思考型模型偶发“长思考但 content 为空”，视为失败并回退 harness
        reportClientLog({ level: 'warn', kind: 'ai_direct_empty', message: '[AI] 直连通道返回空内容，回退 harness' });
      } catch (e) {
        // 直连失败（Key 无效/网络异常等）自动回退 harness，保证功能可用
        reportClientLog({ level: 'warn', kind: 'ai_direct_fallback', message: `[AI] 直连通道失败，回退 harness：${e.message}` });
      }
    }
  }
  const prompt = (messages || []).map((m) => {
    const role = m.role === 'system' ? '【系统设定】' : '【用户请求】';
    return `${role}\n${m.content}`;
  }).join('\n\n');
  // 超时按任务类型分级：整章写作（write）用统一的长任务超时；单轮短任务 3 分钟即可，
  // 避免回退 harness 时让用户为一次润色白白等满长任务档。
  const tieredTimeout = options.timeout || (action === 'write' ? longAiTimeout() : 180000);
  const data = await runHarnessJob({
    prompt, timeout: tieredTimeout, model: options.model || undefined, action,
    reasoning_effort: options.reasoningEffort || undefined,
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: state.currentChapterId || undefined,
    mode: options.mode || undefined
  }, `${AI_ACTION_LABELS[action] || 'AI 任务'}执行中…`);
  return data.output || '';
}

// ---------- 成文直连流式（质量优先模式）----------
// 取当前生效的 API 配置（与直连通道共用规则）；无可用配置返回 null。
async function getActiveAIConfig() {
  if (!state.apiConfigs?.length) {
    try { await ensureApiConfigs(true); } catch (_) { /* 取不到就回退 harness */ }
  }
  return state.apiConfigs?.find((c) => c.id === state.activeConfigId) || state.apiConfigs?.[0] || null;
}

// 🧠 思考余量（2026-09-25 修，真实事故驱动）：
// 思考型模型的 max_tokens 是「思考 + 正文」的**总**预算，不是正文额度。只按正文需要给额度，
// 思考就会把整份预算吃光、content 返回空（finish_reason=length）。
// 真实链路（2026-09-21，同一天两条完整失败链）：一次小缺口补足只给了 1500 ——
//   第 1 次 思考 1500/1500 吃光、正文 0 字；第 2 次 8192/8192 又吃光；
//   第 3 次 换 low 思考强度 + 8192 仍然 8192/8192 全吃光 → 回退精写内核，白等 2–6 分钟。
// 所以凡是"要模型产出 X 字"的地方，额度必须是 X 的额度**再加一份思考余量**。
// 取 8192 不是拍脑袋：它就是上面那次实测里被思考吃光的量（此前只出现在 largerMax 里）。
// 这**不是**降思考强度、也不是抬模型能力 —— 上限抬高不会凭空产生 token，只是别把预算卡在思考下面。
//
// ⚠️ 只给"按正文长度定额度"的非流式调用（补足 / 质检 / 提问轮）；**成文流式路径不动**：
// 真实库里 7 次空回复**全部**来自非流式路径，成文流式（ai_write_stream_empty_retry）0 次，
// 且成文轮的额度本来就已有约 2 倍余量。没有证据的地方不改。
const THINKING_HEADROOM_TOKENS = 8192;
function withThinkingHeadroom(outputTokens, cap = 16384) {
  const need = Math.max(0, Math.ceil(Number(outputTokens) || 0));
  return Math.min(cap, need + THINKING_HEADROOM_TOKENS);
}

// 非流式直连单次调用（flash 质检/小缺口补足/蓝图 用）；失败或无配置返回 null，调用方回退 harness。
//
// ⚠️ 2026-09-18 实测（真实调用，用户授权）：**长提示词下 flash 的思考 token 会把 max_tokens 吃光**，
// 返回 content 为空（`out` 正好等于 max_tokens、`finish_reason=length`）。9k 输入 + max_tokens=4096
// 与 8192 两次都空手而归。所以这里不是"重试碰运气"，而是**放宽输出上限**再试一次；只有仍为空时
// 才降思考预算兜底，优先保住生成质量。仍为空才交给调用方回退慢通道。
async function directAIWrite(messages, opts = {}) {
  const config = await getActiveAIConfig();
  if (!config || !config.api_key) return null;
  const baseMax = Number(opts.maxTokens ?? config.max_tokens) || 4096;
  const metaFrom = (data) => {
    const choice = data?.raw?.choices?.[0] || {};
    const usage = data?.raw?.usage || {};
    return {
      finishReason: choice.finish_reason || null,
      completionTokens: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : null,
      reasoningTokens: Number.isFinite(Number(usage.completion_tokens_details?.reasoning_tokens))
        ? Number(usage.completion_tokens_details.reasoning_tokens)
        : null,
      // 输入侧两项：prompt 规模与**缓存命中**。空回复事故里"思考吃光预算"与"前缀没命中"是两种
      // 完全不同的成因，只记输出侧就永远分不开。
      promptTokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : null,
      cachedTokens: Number.isFinite(Number(usage.prompt_cache_hit_tokens)) ? Number(usage.prompt_cache_hit_tokens) : null
    };
  };
  const attempt = async (overrides = {}) => {
    const data = await api('/ai/write', {
      method: 'POST',
      body: {
        config_id: config.id,
        messages,
        model: opts.model || undefined,
        temperature: opts.temperature ?? config.temperature,
        max_tokens: overrides.maxTokens ?? baseMax,
        reasoning_effort: overrides.reasoningEffort || opts.reasoningEffort || undefined
      },
      timeout: longAiTimeout() // 与直连长生成同档（F-45）
    });
    return { text: String(data.reply || '').trim(), meta: metaFrom(data) };
  };
  const emptyContext = (meta, maxTokens) => ({
    max_tokens: maxTokens,
    finish_reason: meta.finishReason,
    completion_tokens: meta.completionTokens,
    reasoning_tokens: meta.reasoningTokens,
    prompt_tokens: meta.promptTokens,
    cached_tokens: meta.cachedTokens
  });
  // 🧾 整条阶梯的留痕：此前每次空回复只留一句各自为政的日志（2026-09-14 那两条连 context 都是空的），
  // 事后根本回答不了"到底试了几次、每次给了多少额度、思考吃掉了多少"。现在统一收在一条 ai_empty_ladder 里。
  const ladder = [];
  try {
    const first = await attempt();
    if (first.text) return first.text;
    const largerMax = Math.min(16384, Math.max(8192, baseMax * 2));
    const budgetExhausted = first.meta.finishReason === 'length' &&
      (first.meta.completionTokens === null || first.meta.completionTokens >= baseMax);
    ladder.push({ step: 1, ...emptyContext(first.meta, baseMax) });
    reportClientLog({
      level: 'warn',
      kind: 'ai_direct_empty',
      message: budgetExhausted
        ? `[AI] 直连通道返回空内容（max_tokens=${baseMax}，finish_reason=length，思考吃光预算）；先保持原思考强度、放宽上限到 ${largerMax} 重试一次`
        : `[AI] 直连通道返回空内容（max_tokens=${baseMax}，疑似思考吃光预算）；先保持原思考强度并放宽上限到 ${largerMax} 重试一次`,
      context: emptyContext(first.meta, baseMax)
    });
    // 第一次重试**一律保持原思考强度**，只放宽输出上限。为什么不再按 budgetExhausted 直接跳到 low（2026-09-25 修）：
    //   ① 本函数头注释本来就写着"放宽输出上限再试一次；只有仍为空时才降思考预算兜底"——实现此前与它自相矛盾；
    //   ② 纪律要求"第一重试优先保持当前 reasoning effort，仍为空时才允许受控降级"，与成文流式路径同一条；
    //   ③ 降思考强度换速度正是被明令禁止的取舍。
    // 而这条改动**只在上一轮产出 0 字时才会被触发**，因此它不可能降低任何一次成功生成的正文质量；
    // 最坏情况只是失败路径上多花一轮直连。
    const sameEffortRetry = await attempt({ maxTokens: largerMax });
    if (sameEffortRetry.text) return sameEffortRetry.text;
    ladder.push({ step: 2, ...emptyContext(sameEffortRetry.meta, largerMax) });
    reportClientLog({
      level: 'warn',
      kind: 'ai_direct_empty',
      message: '[AI] 保持原思考强度重试后仍为空，改为低思考预算 + 更大上限兜底一次',
      context: emptyContext(sameEffortRetry.meta, largerMax)
    });
    const lowEffortRetry = await attempt({ reasoningEffort: 'low', maxTokens: largerMax });
    if (lowEffortRetry.text) return lowEffortRetry.text;
    ladder.push({ step: 3, ...emptyContext(lowEffortRetry.meta, largerMax) });
    reportClientLog({
      level: 'warn',
      kind: 'ai_direct_empty',
      message: '[AI] 直连通道重试后仍为空，调用方将回退慢通道',
      context: emptyContext(lowEffortRetry.meta, largerMax)
    });
    reportClientLog({
      level: 'warn',
      kind: 'ai_empty_ladder',
      message: `[AI] 直连 ${ladder.length} 次都只有思考、没有正文（输出预算被思考吃光），交给调用方回退慢通道`,
      context: { base_max: baseMax, larger_max: largerMax, attempts: ladder }
    });
    return null;
  } catch (e) {
    reportClientLog({ level: 'warn', kind: 'ai_direct_fallback', message: `[AI] 直连通道失败：${e.message}` });
    return null;
  }
}

// SSE 流式直连成文：边收 token 边更新进度卡（正文逐字可见），返回 { text, scan, proposals:null, via:'direct' }。
// 失败抛错（调用方回退 harness 精写）。占用 AI 任务互斥锁与取消通道，可点「停止」。
async function streamAIDirectWrite(body, stageLabel) {
  if (state.aiTaskRunning) {
    toast('已有 AI 任务进行中，请等待其完成或先点「停止」', 'error');
    const err = new Error('已有任务进行中');
    err.busy = true;
    throw err;
  }
  // 🐞 运行追踪：直连成文是分钟级长任务，必须开长流程操作——否则 150ms 的点击收尾定时器
  // 会把它过早标记成「已完成」，操作耗时与 Token 汇总全部失真（慢通道 runHarnessJob 有同款处理）。
  if (typeof traceLongOp === 'function') traceLongOp(stageLabel || 'AI 写作（直连流式）');
  state.aiTaskRunning = true;
  const progress = showAITaskProgress(stageLabel);
  // ⏱ 本轮墙钟起点与首字延迟（TTFT）。TTFT 把「模型想多久」和「吐字多久」分成两段 ——
  // 这两段的优化手段完全不同（前者靠上下文/前缀缓存，后者靠输出长度），混成一个总时长就分不清该改哪。
  const startedAt = Date.now();
  let ttftMs = null;
  // 思考期起点（首次收到 phase:'thinking' 时置位）：只用于把"已思考 Ns"显示出来，
  // 服务端每次心跳都自带 elapsed_ms，所以它只是本地兜底。
  let thinkingStartedAt = 0;
  let cancelled = false;
  // 🔁 已经收到的正文（逐字追加）。取消 / 超时 / 断流时，界面此前把这部分**连同进度卡一起丢掉**——
  // 错误文案自己都写着"白等"，而这是口径 B（点击 → 拿到能用的稿子）上最贵的一种损失。
  // 现在把它绑在抛出的错误上，由调用方落草稿兜底。只搬运，不参与任何生成决策。
  let partial = '';
  const withPartial = (err) => {
    err.partialText = partial;
    return err;
  };
  const cancelledErr = () => {
    const err = withPartial(new Error('任务已取消'));
    err.cancelled = true;
    return err;
  };
  const controller = new AbortController();
  // ⚠️ 登记句柄必须在 try 之外声明：finally 里要调它，而 try 块内声明的 const 在 finally 里
  // 是不可见的（旧写法曾把它写在 try 内，于是 finally 抛 ReferenceError，把"取消"整条路带崩）。
  let untrackStream = () => {};
  try {
    progress.setCancel(() => {
      cancelled = true;
      progress.note('正在停止生成…');
      controller.abort();
    });
    // 再登记一次（登记制）：这条是**流式**请求，没有 job id 可取消，所以登记的是 abort 句柄。
    // 好处是"停止"不再依赖这张卡是不是当前卡 —— 管线换了卡、或卡片被后一阶段覆盖，按钮照样停得掉。
    untrackStream = trackAICancel(() => {
      cancelled = true;
      progress.note('正在停止生成…');
      controller.abort();
    });
    // 单次流式尝试。**不发 done 时不抛错**，而是返回 complete:false —— 由下面决定
    // "能不能重试"与"该不该回退"，这样空回复重试与"半截流"是两条不同的出口。
    const attempt = async (reqBody) => {
      const attemptStartedAt = Date.now();
      const resp = await fetch('/api/ai/write_stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(traceHeaders() || {}) },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      });
      if (!resp.ok || !resp.body) {
        let msg = `直连通道请求失败（${resp.status}）`;
        try { const d = await resp.json(); msg = d?.error || d?.message || msg; } catch (_) { /* 保留默认 */ }
        throw new Error(msg);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let full = '';
      let lastPaint = 0;
      const paint = () => {
        const now = Date.now();
        if (now - lastPaint < 250) return; // 节流：250ms 刷一次进度卡，避免高频重排
        lastPaint = now;
        progress.update(full.slice(-600), `AI 写作（2/3 成文）· 正在生成正文（已 ${plainLength(full)} 字）…`);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (typeof evt.delta === 'string') {
            // 首字时刻只取第一次：服务端下发的 delta 是**正文**增量（reasoning_content 不在此列），
            // 所以这个数字就是"模型思考结束、开始写正文"的真实时刻。
            if (ttftMs === null) ttftMs = Date.now() - attemptStartedAt;
            full += evt.delta; partial = full; paint();
          }
          else if (evt.phase === 'thinking') {
            // 模型在思考、正文还没开始吐。此前这段时间客户端一帧都收不到，进度卡上一直是"已 0 字"，
            // 长时间思考（10–30s）看起来就是卡死。这里把这一秒真正在做的事说出来。
            // 纯展示：不改额度、不改思考强度、不改任何生成参数。
            //
            // 2026-10-02：服务端现在会在思考期每 2.5s 发一次心跳（heartbeat=true，带
            // elapsed_ms / reasoning_chars）。文案因此升级为"已思考 Ns / 思考 M 字"——
            // 否则 25 秒的首字延迟里，卡片上"模型正在思考…"是静止的，仍然像卡死。
            if (evt.heartbeat) {
              thinkingStartedAt = thinkingStartedAt || Date.now();
              const secs = Math.max(1, Math.round((Number(evt.elapsed_ms) || (Date.now() - thinkingStartedAt)) / 1000));
              const rChars = Number(evt.reasoning_chars) || 0;
              progress.update(
                `模型正在思考（正文还没开始输出）…已思考 ${secs}s${rChars ? ` · 思考已写 ${rChars} 字` : ''}`,
                `AI 写作（2/3 成文）· 模型正在思考（${secs}s）…`);
            } else {
              progress.update('模型正在思考（正文还没开始输出）…', 'AI 写作（2/3 成文）· 模型正在思考…');
            }
          }
          else if (evt.done) {
            if (cancelled) throw cancelledErr(); // 用户已点停止：即使任务刚巧完成也不再采纳结果
            // usage 是服务端随 done 下发的附加用量（缓存命中 / 思考 token）；老服务端没有它就记 null。
            return { text: String(evt.text || full), scan: evt.scan || null, complete: true, usage: evt.usage || null };
          } else if (evt.error) throw new Error(evt.error);
        }
      }
      if (cancelled) throw cancelledErr();
      return { text: full, scan: null, complete: false };
    };

    let result = await attempt(body);
    if (cancelled) throw cancelledErr();
    // 空回复重试（与 directAIWrite 同一条纪律、同一份实测依据，见 directAIWrite 上方注释）：
    // 长提示词下 flash 的**思考 token 会把 max_tokens 吃光**、content 返回空（finish_reason=length）。
    // 成文轮是全链路最长的一次生成，恰恰最容易撞上。此前这里**直接报错**，而且报得很隐蔽：
    // 调用方拿到的是一个 `text` 为空但**真值**的对象，`if (!proseData)` 判不出来，
    // 于是"可恢复的空回复"变成"整章白等 + 报错"，连回退精写内核都走不到。
    // 现在先保持原思考强度 + 放宽输出上限重试一次；仍为空才降思考预算兜底，
    // 尽可能不牺牲首轮重试的正文质量；再为空才抛错，让调用方的既有回退分支接管。
    if (!String(result.text || '').trim()) {
      const baseMax = Number(body.max_tokens) || 4096;
      const largerMax = Math.min(16384, Math.max(8192, baseMax * 2));
      reportClientLog({ level: 'warn', kind: 'ai_write_stream_empty_retry', message: `[AI] 成文流式直连返回空内容（思考可能吃光输出预算），先保持原思考强度 + 更大上限到 ${largerMax} 重试一次` });
      result = await attempt({
        ...body,
        max_tokens: largerMax
      });
      if (cancelled) throw cancelledErr();
      if (!String(result.text || '').trim()) {
        reportClientLog({ level: 'warn', kind: 'ai_write_stream_empty_retry', message: '[AI] 成文流式直连保持原思考强度重试后仍为空，改为低思考预算 + 更大上限兜底一次' });
        result = await attempt({
          ...body,
          reasoning_effort: 'low',
          max_tokens: largerMax
        });
        if (cancelled) throw cancelledErr();
      }
    }
    if (!String(result.text || '').trim()) {
      const err = withPartial(new Error(result.complete
        ? '直连通道返回空内容（思考可能吃光了输出预算），已重试两次仍为空'
        : '流式连接中断，未收到完成信号（可重试或改用精写内核）'));
      err.emptyReply = true;
      throw err;
    }
    // 半截流（收到了正文但没等到 done）**保持原语义**：抛错，绝不把残缺正文当成品交付。
    // 「不当作成品交付」与「就地销毁」是两件事：前者是质量纪律，后者只是白白扔掉作者的等待。
    if (!result.complete) throw withPartial(new Error('流式连接中断，未收到完成信号（可重试或改用精写内核）'));
    // ⏱ ms 是本轮流式直连的墙钟总耗时（含重试），ttftMs 是首字延迟，usage 是服务端随 done 下发的用量。
    // 三者都只是测量值，调用方不拿它们做任何判断。
    return { text: result.text, scan: result.scan, proposals: null, via: 'direct', ms: Date.now() - startedAt, ttftMs, usage: result.usage || null };
  } catch (e) {
    if (e.name === 'AbortError') throw cancelled ? cancelledErr() : withPartial(new Error('流式生成连接中断'));
    // 其余异常（网络层 TypeError、读取中断等）同样带上已收到的正文 ——
    // 「断流」和「超时」与「点停止」是同一种损失，没有理由只保住其中一种。
    // ⚠️ 这不放松任何质量纪律：函数仍然抛错、仍然不把残缺正文当成品返回，只是不再把它销毁。
    throw withPartial(e);
  } finally {
    untrackStream();
    progress.close();
    state.aiTaskRunning = false;
  }
}

// 取消 / 超时 / 断流时，把"已经拿到的正文"落成草稿（**只保存，绝不自动应用**）。
// 为什么值得单独做一件事：这些路径此前把几分钟的产出连同进度卡一起丢掉，作者手里什么都不剩 ——
// 口径 B（点击 → 真正拿到能用的稿子）上这是最贵的一种损失，而它本可以只损失"未完成的部分"。
// 两条纪律：
//   ① 只保存、不应用：正文永远由作者自己点「应用到正文」写回，这里不碰正文一个字；
//   ② 低于门槛的碎片不存：getLatestDraft 只取最新一份，一次误点「停止」不该把上一份好稿
//      从「取回生成稿」里顶掉（200 字是"已经写出了一段"而不是"刚点了下按钮"的分界）。
const MIN_SALVAGE_CHARS = 200;
async function saveInterruptedDraft(text, chapterId) {
  const clean = String(text || '').trim();
  if (!chapterId || clean.length < MIN_SALVAGE_CHARS) return 0;
  try {
    const r = await api('/novel/draft', { method: 'POST', body: { chapter_id: chapterId, content: clean }, timeout: 5000 });
    // 落库成功即刷新恢复条：中断/失败后作者最需要马上看到"这些字还在哪"
    //（此前要手动刷新整页才出现，见 2026-10-02 事故）。
    await refreshChapterRecovery(chapterId).catch(() => { /* 只是提示层 */ });
    return Number(r && r.chars) || clean.length;
  } catch (_) {
    // 兜底落库失败不影响主流程（与结果弹窗的草稿落库同一条纪律），只是这次真的没保住。
    return 0;
  }
}
// 只标记硬伤，轻微瑕疵放行；通道不可用时不阻塞交付。
// 质检提示词（从 verifyAIDraft 里抽出来，便于分段路径与测试直接核对）。
// 目标正文**不截断**：超过单请求安全上限时 verifyAIDraft 会显式跳过质检并说明原因，
// 而不是把半章正文当整章核对（半章质检比不质检更危险：它会把"没看到的部分"判成没问题）。
function buildAIWriteQualityPrompt(article, blueprint, opts = {}) {
  const segment = opts.segment || null;
  const bpText = blueprint
    ? [
        blueprint.scene_goal && `场景目标：${blueprint.scene_goal}`,
        blueprint.plot_points && `情节点：\n${blueprint.plot_points}`,
        blueprint.conflicts && `冲突与转折：${blueprint.conflicts}`,
        blueprint.character_changes && `出场角色状态变化：${blueprint.character_changes}`,
        blueprint.hook && `下一章钩子：${blueprint.hook}`,
        blueprint.references && `需要回扣的设定/伏笔：${blueprint.references}`
      ].filter(Boolean).join('\n')
    : '（无蓝图）';
  const prompt = [
    '你是严格的小说质检员。请核对下面这篇刚生成的章节正文，输出 JSON 对象（不要 Markdown 代码块）：',
    '{"verdict":"pass 或 issues 或 unknown","issues":["硬伤描述，逐条可执行"],"deferred":[{"type":"possible_foreshadowing","text":"疑似伏笔或暂未解释的异常（引用正文具体位置）","recheck_within_chapters":5}],"coverage":{"story_state":true,"space":true,"timeline":true,"world_rules":true,"chapter_boundary":true,"style_structure":true}}',
    'deferred 是“待后续核验”通道：疑似伏笔、未知等级、暂未解释的异常、可能故意留下的缺口，一律写进 deferred，不要写进 issues，也不要为了给出结论而判成硬伤。deferred 不计入 verdict——它有内容时 verdict 仍可以是 pass；拿不准“是伏笔还是假神秘”时同样放这里，不要建议删除。',
    'verdict 三态，必须如实：pass=已经检查且所查范围内没有发现硬伤；issues=找到有证据的硬伤（issues 必须非空）；unknown=无法判断、覆盖不全或证据不足（issues 可为空）。拿不准时写 unknown，不要为了给出结论而臆造硬伤，也不要在未完成检查时写 pass。',
    '只标记真正的硬伤：与本章蓝图要点明显不符/重要情节点遗漏、与最近事件或未闭合伏笔冲突、角色状态矛盾、大段 AI 腔模板句（万能比喻、「不是X。是Y。」式短语判断、连续三短句总结、为呼应而呼应）、提前消费未来章内容（大纲中标注【未来章·禁止写入】或后续章节摘要的内容）、新增未登记的具名角色/地点/妖兽、场景缺少空间与身体动作。轻微瑕疵不判 issues。',
    '',
    '【本章蓝图 · 写作必须遵守】',
    bpText,
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    ...(segment ? ['【本片上文/下文（context-only，仅供参考，不要核它们的文字）】', longTextContextBlock(segment), ''] : []),
    '【待核正文】',
    String(article || ''),
    '',
    '只输出 JSON。'
  ].join('\n');
  return prompt;
}

async function verifyAIDraft(blueprint, article, targetWords) {
  const text = String(article || '');
  // 质检是只读判断：超过单请求安全上限时显式跳过（带原因），不把半章当整章核对。
  const plan = longTextPlanFor('quality_gate', text, { blueprint });
  if (plan.mode === 'unavailable') {
    return { pass: false, verdict: 'unknown', skipped: true, reason: 'long_text_engine_unavailable' };
  }
  if (plan.mode === 'segmented') {
    return { pass: false, verdict: 'unknown', skipped: true, reason: 'over_single_request_limit', plan };
  }
  const prompt = buildAIWriteQualityPrompt(text, blueprint);
  const reply = await directAIWrite([{ role: 'user', content: prompt }], {
    model: policyModel('fast'),
    // 质检要读 1.2 万字正文再出结论，1500 的总额度连思考都不够 —— 思考吃光就返回空，
    // 而空回复在这里等价于"质检静默跳过"（下面的 skipped 分支），质量门会无声消失。
    maxTokens: withThinkingHeadroom(1500),
    reasoningEffort: 'low',
    temperature: 0.2
  });
  // 三态判定（2026-10-06，P0-2）：解析异常/覆盖不全/结论不明一律 unknown，绝不静默当 pass。
  // 旧写法 `String(parsed.verdict) !== 'issues' || issues.length === 0` 会把空对象、未知结论、
  // "有问题但问题列表为空"全部判成通过——质量门形同虚设。
  const REQUIRED_COVERAGE = ['story_state', 'space', 'timeline', 'world_rules', 'chapter_boundary', 'style_structure'];
  // 文本归一化：issue 与 deferred 共用（字符串 / {text} 两种形态都接受）。
  const textsOf = (arr) => (Array.isArray(arr)
    ? arr.map((x) => (typeof x === 'string' ? x : String(x?.text || ''))).filter(Boolean)
    : []);
  const judge = (parsed) => {
    const issues = textsOf(parsed.issues);
    // deferred = 待后续核验通道（疑似伏笔 / 未知设定 / 暂未解释的异常）。它**不**计入 verdict：
    // 放进 deferred 就是明确表示“现在不判它”，不能因为 deferred 非空把它算成 issues。
    const deferred = Array.isArray(parsed.deferred)
      ? parsed.deferred.map((x) => (x && typeof x === 'object'
        ? { text: String(x.text || ''), type: String(x.type || ''), recheck_within_chapters: Number(x.recheck_within_chapters) || 0 }
        : { text: String(x || ''), type: '', recheck_within_chapters: 0 })).filter((d) => d.text)
      : [];
    const raw = String(parsed.verdict || '').trim().toLowerCase();
    let verdict = ['pass', 'issues', 'unknown'].includes(raw) ? raw : 'unknown';
    // issues 结论却没有证据 → 视为未完成判断
    if (verdict === 'issues' && issues.length === 0) verdict = 'unknown';
    // 覆盖声明里明确为 false 的必需项 → 视为未完成判断
    const cov = parsed.coverage;
    if (verdict !== 'issues' && cov && typeof cov === 'object'
        && REQUIRED_COVERAGE.some((k) => cov[k] === false)) verdict = 'unknown';
    const blocked = issues.some((x) => /未来章|禁止写入|未登记|具名角色|具名地点|妖兽/.test(x));
    return { pass: verdict === 'pass', verdict, issues, deferred, skipped: false, blocked };
  };
  // 质检通道不可用：不阻塞成文交付（但**必须带 reason**，否则调用侧的告警分支不会触发）。
  if (!reply) return { pass: false, verdict: 'unknown', skipped: true, reason: 'channel_unavailable' };
  const parsed = extractJSONFromText(reply);
  if (parsed) return judge(parsed);
  // ── P1-01：调用成功但输出**不满足结构化契约**，这与"通道不可用"是两件事 ──────────
  // 旧实现把它和"通道不可用"合并成 `{pass:true, skipped:true}`（且不带 reason），而调用侧
  // 只处理"带 reason 的 skipped"（见 performToolbarAIWrite 的 verdict.skipped && verdict.reason 分支）
  // —— 于是模型一旦持续吐非 JSON（例如把解释写在前、被 max_tokens 截成半段、或包了 Markdown 代码块），
  // **质量门永久静默失效**，界面上却看起来"已质检通过"。这是典型的"看似在做事、实际被旁路"。
  // 处置：① 如实记一条 unparsed 日志（供复盘，不落作者正文）；② 只做**一次**契约修复重试；
  //       ③ 仍失败则返回带 reason 的 skipped，让调用侧的告警分支生效（作者会看到"本次未完成质检"）。
  reportClientLog({
    level: 'warn',
    kind: 'quality_gate_unparsed',
    message: `[写作] 质检返回无法解析为契约 JSON（${String(reply).length} 字），本次视为未质检`,
    context: { chars: String(reply).length, head: String(reply).slice(0, 200) }
  });
  let repaired = null;
  {
    const fix = await directAIWrite([
      { role: 'system', content: '你是 JSON 修复器：把用户给的内容整理成一个 JSON 对象。只输出 JSON 本身，不要解释、不要 Markdown 代码块。' },
      { role: 'user', content: `把下面内容整理为 {"verdict":"pass"或"issues"或"unknown","issues":["硬伤描述",…],"deferred":[{"type":"possible_foreshadowing","text":"待后续核验的疑点"}]}，不要新增未出现的问题，无法判断时用 "unknown"：\n${String(reply).slice(0, 4000)}` }
    ], { model: policyModel('fast'), maxTokens: 512, temperature: 0, reasoningEffort: 'low' });
    repaired = fix ? extractJSONFromText(fix) : null;
  }
  if (repaired) return judge(repaired);
  return { pass: false, verdict: 'unknown', skipped: true, reason: 'unparsed', raw_head: String(reply).slice(0, 200) };
}

// 质检不过时走 harness 精写内核修复：保留大部分正文、只修硬伤；
// 内核同时做一致性/红线自检与事件/记忆入账提案（提案稍后在界面确认）。
function buildAIWriteRepairPrompt(article, issues, blueprint, targetWords, opts = {}) {
  const segment = opts.segment || null;
  const bpText = blueprint
    ? [
        blueprint.scene_goal && `场景目标：${blueprint.scene_goal}`,
        blueprint.plot_points && `情节点：\n${blueprint.plot_points}`,
        blueprint.conflicts && `冲突与转折：${blueprint.conflicts}`,
        blueprint.character_changes && `出场角色状态变化：${blueprint.character_changes}`,
        blueprint.hook && `下一章钩子：${blueprint.hook}`,
        blueprint.references && `需要回扣的设定/伏笔：${blueprint.references}`
      ].filter(Boolean).join('\n')
    : '（无）';
  return [
    '请修复下面这篇章节正文中质检发现的硬伤，输出修复后的完整正文（不要输出【成文】等前缀，不要解释）。',
    `整章正文以纯文本计不少于 ${targetWords} 字；修复时其余内容尽量保持原样，不要推倒重写。`,
    '',
    '【质检发现的硬伤】',
    (issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）',
    '',
    '【本章蓝图 · 写作必须遵守】',
    bpText,
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    ...(segment ? ['【本片上文/下文（context-only，禁止修改、禁止出现在输出里）】', longTextContextBlock(segment), ''] : []),
    '【待修复正文】',
    String(article || ''),
    ...(segment ? ['', `只输出本片（target ${segment.segment_id}）修复后的完整正文；不要输出 context-only 内容。`] : [])
  ].join('\n');
}

// 入账异步化：正文被作者确认采纳后，后台用 flash 整理事件/记忆提案（不阻塞交付；
// 提案落 pending，作者稍后在界面确认）。直连成文不再有代理现场入账，这里补回账本闭环。
async function scheduleLedgerProposalJob(article) {
  const workId = state.workId || state.work?.id || null;
  if (!workId || !state.currentChapterId || !String(article || '').trim()) return;
  const prompt = [
    '本章正文已被作者确认采纳。请阅读下面的章节正文，按创作纪律整理入账：',
    '用 novel_event_add 记录本章关键剧情/伏笔/状态变化（新埋伏笔 kind=foreshadow，回收旧伏笔传 resolves_event_id，角色状态变化用 kind=character + payload={"character_id":角色id}）；',
    '再用 novel_memory_update 把本章进展并入长期记忆。当前为提案模式，各调用一次即可，不要重复提交；不要输出正文。',
    '',
    '【本章正文】',
    // 合法保留的裁剪（R08 例外清单）：这是**内部入账摘要**任务的输入上限，
    // 不是"目标正文编辑"路径；入账走提案，作者逐条确认，截断不影响正文事实。
    String(article).slice(0, 12000)
  ].join('\n');
  try {
    const started = await api('/harness/run', {
      method: 'POST',
      body: {
        prompt,
        timeout: longAiTimeout(),
        model: policyModel('fast'),
        action: 'ledger',
        work_id: workId,
        chapter_id: state.currentChapterId,
        mode: 'full'
      }
    });
    if (started.job_id) {
      reportClientLog({ level: 'info', kind: 'ledger_job_scheduled', message: `[AI] 入账整理任务已后台启动（job ${started.job_id}）` });
    }
  } catch (e) {
    reportClientLog({ level: 'warn', kind: 'ledger_job_failed', message: `[AI] 入账整理任务启动失败：${e.message}` });
  }
}

// ---------- Harness 深度创作流水线 ----------
// 创作策略模式：快速 / 均衡 / 深度精修
const PIPELINE_MODE_HINTS = {
  fast: '请用简洁高效的方式输出核心内容，避免冗余，优先保证速度和可读性。',
  balanced: '请保持内容完整、结构清晰、质量稳定。',
  deep: '请进行深度思考，输出尽可能丰富、细致、高质量的内容，追求创作天花板。'
};

// 流水线统一使用 deepseek-flash（DeepSeek-V4.1-Flash）。
// 原先按档位切 deepseek-v4-pro 的「重要环节用旗舰模型」思路在 V4.1 这代已不成立：
// 官方基准显示 V4.1 Flash 在推理/Agentic 任务上反超 V4 Pro，且输入缓存命中价低 7.5 倍、
// 输出价低约 3.4 倍。继续按老路由反而把大纲/正文/审查降级到了上一代模型。
// 因此模型不再随档位变化，三档策略改由「思考强度」区分。
// 模型：调用时由 policyModel('fast') 解析（真源 ai/policy.mjs）；此处不再固定常量。

// 档位 → 思考强度（DeepSeek 取值：off | low | high | max，默认 high）。
// fast 用 low 而非 off：保留思考、只压缩思考预算，不为提速牺牲成文质量。
const PIPELINE_EFFORT_BY_MODE = {
  fast: 'low',
  balanced: 'high',
  deep: 'max'
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

async function runPipelineStage(prompt, { model, reasoningEffort, stageLabel, timeout = longAiTimeout() }) {
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
          reasoning_effort: reasoningEffort,
          messages: [PIPELINE_SYSTEM, { role: 'user', content: userContent }],
          max_tokens: 16384
        },
        timeout: longAiTimeout() // F-45：直连长生成，覆盖默认 60s
      });
      return (data.reply || '').trim();
    };
    let reply = '';
    try { reply = await tryDirect(prompt); } catch (e) { reportClientLog({ level: 'warn', kind: 'ai_direct_fallback', message: `[AI] 工作台直连失败：${e.message}` }); }
    if (!reply) {
      // 空回复（思考型模型偶发）：追加“直接输出”指令重试一次
      try { reply = await tryDirect(prompt + '\n\n（请直接输出最终结果内容，不要任何思考与解释。）'); }
      catch (e) { reportClientLog({ level: 'warn', kind: 'ai_direct_fallback', message: `[AI] 工作台直连重试失败：${e.message}` }); }
    }
    if (reply) return reply;
    reportClientLog({ level: 'warn', kind: 'ai_direct_empty', message: '[AI] 工作台直连返回空内容，回退 harness' });
  }
  try {
    const data = await runHarnessJob({ prompt, timeout, model, reasoning_effort: reasoningEffort, action: 'pipeline' }, stageLabel);
    const output = (data.output || '').trim();
    if (!output) throw new Error('AI 未返回内容');
    return output;
  } catch (e) {
    // 超时降级：换用压缩篇幅的精简版指令重试一次，避免整个流水线卡死在一个阶段
    if (/超时/.test(e.message || '')) {
      const data = await runHarnessJob({
        prompt: `${prompt}\n\n（重要：上一轮因超时未完成。请直接输出精简版结果，篇幅压缩到一半以内，不要遗漏要点。）`,
        timeout, model, reasoning_effort: reasoningEffort, action: 'pipeline'
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
        model: policyModel('fast'),
        reasoningEffort: policyEffort(mode),
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
        <div class="field"><label>每章目标字数</label><input name="default_chapter_words" type="number" min="500" max="20000" step="100" value="${Number(work?.default_chapter_words) || 2000}" title="AI 写作据此把握篇幅（只是范围参考，不是必须填满的配额；不会为凑字数在章尾自动续写）"></div>
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
        <div class="field full"><label>别名/称呼（逗号分隔，用于上下文命中）</label><input name="aliases" value="${esc(character?.aliases || '')}" placeholder="例如：云仔、李队"><div class="muted mt-4" style="font-size:12px">留空 = 正文里只认主名。填了简称/绰号，改稿或续写时用简称提到他也能被认出（别名参与出场判定与一致性核对）。</div></div>
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
    // F-42：优先用事件自带的 character_id 精确匹配；否则用 \b 词边界（仅 ASCII 名有意义）兜底；
    // 中文名无 \b 语义，退回 contains 子串匹配（可能误命中含同名字段的事件，属可接受权衡）。
    let nameRe = null;
    try { nameRe = new RegExp(`\\b${String(character.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'); } catch (_) {}
    rows = events.filter((e) => {
      if (e.character_id != null) return Number(e.character_id) === Number(character.id);
      if (nameRe && /^[\x00-\x7F]+$/.test(character.name)) return nameRe.test(String(e.summary || ''));
      return String(e.summary || '').includes(character.name);
    }).slice(0, 12);
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

// 模型选择下拉：只列当前在售的 DeepSeek 模型，默认推荐 deepseek-flash；
// 若配置里存的是列表外的自定义模型（其他 OpenAI 兼容服务商），额外显示为“当前使用”选项。
//
// 已剔除的历史模型（选中即报错，勿再加回）：
//   deepseek-chat / deepseek-reasoner —— 官方已于 2026-07-24 停止服务；
//   deepseek-v4-flash / deepseek-v4-flash-vision-exp —— 模型已下线，
//     旧名仍会被服务端路由到 V4.1 Flash，但无需再作为独立选项暴露；
//   deepseek-v4-pro —— 2026-09-18 起质量档并入 V4.1 Flash（质量改由思考强度表达，
//     见 ai/policy.mjs 文件头），存量配置由启动迁移改写；**不要再加回下拉**，
//     否则会出现两个指向同一模型的选项（2026-09-13 踩过 value 重复的坑）。
const KNOWN_AI_MODELS = [
  ['deepseek-flash', 'deepseek-flash（V4.1 · 推荐：能力最强、成本最低、支持图像理解）']
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
        <div class="field"><label>API Key</label><input name="api_key" value="" placeholder="${config ? '留空则保持当前密钥不变' : 'sk-...'}"></div>
        <div class="field"><label>模型</label>${modelSelectHtml(config?.model || DEFAULT_AI_MODEL)}</div>
        <div class="field"><label>温度</label><input name="temperature" type="number" step="0.1" min="0" max="2" value="${config?.temperature ?? 0.8}"></div>
        <div class="field"><label>最大 Token（单次输出字数上限，1 token ≈ 0.6 个汉字）</label><input name="max_tokens" type="number" min="1" value="${config?.max_tokens ?? 4096}"></div>
      </div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="save-api-config" data-id="${config?.id || ''}">保存</button>`
  });
}

// ---------- AI functions ----------
// 加载当前章节的 AI 上下文：角色卡、激活的世界观词条、作者注。
// C3/C4：可选 { direction, directionSource, libraryRecallPhase }——
//   · libraryRecallPhase: default | defer | direction（服务器 ai/direction.mjs 同口径）；
//   · direction 只影响资料召回与索引候选发现，不改变正典查询；
//   · 本函数自身不缓存：每次调用都向服务器发起请求（或命中服务器侧带方向/版本判据的装配缓存），
//     相同阶段+方向的并发请求共用一个 in-flight Promise，不同方向/阶段各有各的键。
let aiContextInflight = null; // 同一 (workId:chapterId:phase:directionHash) 的并发请求复用
async function loadAIContext(options = {}) {
  const chapterId = state.currentChapterId;
  const workId = state.workId || state.work?.id || 0;
  if (!chapterId) {
    state.aiContext = null;
    return null;
  }
  const direction = normalizeWritingDirectionText(options.direction || '');
  const libraryRecallPhase = ['default', 'defer', 'direction'].includes(options.libraryRecallPhase)
    ? options.libraryRecallPhase
    : 'default';
  const directionHash = direction ? directionKeyHashOf(direction) : '';
  // 规划轮跳层（2026-10-04）：`omitLayers: ['blueprint']` = 这一轮是在**重新规划**，
  // 上下文里不要带上一版蓝图（层标题「本章蓝图（写作必须遵守）」会让模型复述旧计划）。
  // 进 key 是必需的：规划轮与成文轮的 assembled 不同，不进 key 就会命中同一份缓存。
  const omitLayers = Array.isArray(options.omitLayers) ? options.omitLayers.filter((s) => typeof s === 'string' && s) : [];
  const omitSuffix = omitLayers.length ? `:omit=${[...omitLayers].sort().join('+')}` : '';
  const key = `${workId}:${chapterId}:${libraryRecallPhase}:${directionHash || '-'}${omitSuffix}`;
  if (aiContextInflight && aiContextInflight.key === key) return aiContextInflight.promise;
  const fresh = () => state.currentChapterId === chapterId && (state.workId || state.work?.id || 0) === workId;
  // GET 参数一律走 URLSearchParams（direction 可能含中文/空格；上限 400 码点由规范化保证）。
  const queryOf = (path) => {
    const qs = new URLSearchParams({ chapter_id: String(chapterId) });
    if (direction) qs.set('direction', direction);
    if (libraryRecallPhase !== 'default') qs.set('library_recall_phase', libraryRecallPhase);
    if (direction && options.directionSource) qs.set('direction_source', String(options.directionSource));
    if (omitLayers.length) qs.set('omit_layers', omitLayers.join(','));
    // P1-07：直连通道的请求体里**没有 tools**，模型调不到任何工具。而截断提示语默认会写
    // "可用 novel_lookup 查证" —— 那条提示在直连通道上是指向一个不存在的工具（模型照着查会一无所获）。
    // 因此装配时如实声明本次通道没有工具，装配器会把提示语降级为"当前没有查回路径（已知缺口）"。
    // 慢通道（harness）自己会另取一份带工具的上下文，不受这里影响。
    qs.set('tools', '0');
    return `${path}?${qs.toString()}`;
  };
  const promise = (async () => {
    try {
      let ctx = await api(queryOf('/ai_context'));
      if (!fresh()) return state.aiContext;
      // P2 契约：提示词正文只应来自服务端 assembled。旧接口若未返回 assembled，
      // 回退到唯一装配器 /novel/context，避免前端再次启用无预算的旧拼装。
      if (ctx && !(typeof ctx.assembled === 'string' && ctx.assembled) && workId) {
        try {
          // 同一组方向/阶段参数 → 与 /ai_context 命中**同一份服务器缓存**，不会二次召回（C3）。
          const qs = new URLSearchParams({ work_id: String(workId), chapter_id: String(chapterId), mode: 'full', tools: '0' });
          if (direction) qs.set('direction', direction);
          if (libraryRecallPhase !== 'default') qs.set('library_recall_phase', libraryRecallPhase);
          if (direction && options.directionSource) qs.set('direction_source', String(options.directionSource));
          if (omitLayers.length) qs.set('omit_layers', omitLayers.join(','));
          const assembledCtx = await api(`/novel/context?${qs.toString()}`);
          ctx = assembledCtx || ctx;
        } catch (_) { /* 回退失败时保留 /ai_context 的结构化字段供界面预览 */ }
      }
      if (fresh()) state.aiContext = ctx;
    } catch (_) {
      if (fresh()) state.aiContext = null;
    }
    return state.aiContext;
  })();
  aiContextInflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (aiContextInflight && aiContextInflight.key === key) aiContextInflight = null;
  }
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
  const terms = ctx.terms?.length
    ? ctx.terms.map((t) => `<div>【${esc(t.title)}】${esc((t.content || '').slice(0, 80))}</div>`).join('')
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
    <div class="ai-context-section"><b>设定词条</b><div>${terms}</div></div>
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
  // P2：提示词文本改由服务端**唯一装配器**产出（分层预算 + 裁剪清单 + 溢出标记）。
  // 旧前端拼装没有预算，且历史上会绕过服务端装配器喂入约 7.4 万字；
  // 这里不再保留该兜底：loadAIContext 会在缺少 assembled 时回退 /novel/context。
  return typeof ctx.assembled === 'string' ? ctx.assembled : '';
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

// 显示 AI 结果预览，确认后执行 onApply。metaHtml 用于长正文分段的覆盖证据（R08）。
function showAIApplyPreview(title, reply, onApply, metaHtml = '') {
  state.pendingAIApply = { onApply };
  openModal({
    title,
    body: `${metaHtml || ''}<div class="ai-apply-preview">${esc(reply).replace(/\n/g, '<br>')}</div>`,
    footer: `<button class="btn secondary" data-close-modal>取消</button><button class="btn" data-action="confirm-ai-apply">确认应用</button>`,
    large: true
  });
}

// 用编辑器当前文本做"源版本是否被作者改过"的判据（与入口处取文本用的是同一条路径，避免假阳性）。
function longTextLiveEditorText(fallback) {
  const editor = $('#editor-content');
  if (!editor) return String(fallback == null ? '' : fallback);
  try {
    const sel = getEditorSelection(editor);
    const text = String((sel && sel.text) || editor.innerText || '').trim();
    return text || String(fallback == null ? '' : fallback);
  } catch (e) { return String(fallback == null ? '' : fallback); }
}

// 长正文分段未通过覆盖清单：**不提供"部分采纳"**——正文一个字都不动，只提供补跑入口。
function showLongTextIncomplete(label, run, retry, alt) {
  state.pendingLongTextRetry = retry || null;
  state.pendingLongTextAltRetry = (alt && alt.handler) || null;
  openModal({
    title: `${label}未完成（正文未被改动）`,
    body: `${run.statusHtml || ''}<div class="muted">已完成的候选片按源版本保留：再次处理只会补跑未完成的片，成功且源版本一致的片不会重复计费。</div>`,
    footer: `<button class="btn secondary" data-close-modal>知道了</button>${alt && alt.handler ? `<button class="btn secondary" data-action="long-text-retry-alt">${esc(alt.label)}</button>` : ''}${retry ? '<button class="btn" data-action="long-text-retry">补跑未完成的片</button>' : ''}`,
    large: true
  });
}

// 应用润色/扩写结果：先备份当前版本，再替换原文。
// ⚠️ 空产出必须在这里就被拦住（2026-10-02 事故复盘补的一道）：一次"模型返回空串/只有标签"
// 的结果如果被照直替换进编辑器，编辑器随即变空 —— 而 800ms 后就是自动保存。
// 现在：空产出直接报错、编辑器一个字都不动，绝不把"空"当成一次可应用的 AI 结果。
async function applyAIReply(editor, reply, range) {
  if (editorSnapIsBlank(reply)) {
    toast('AI 这次没有产出任何正文：编辑器未被改动（可重试或在结果弹窗里查看原文）', 'error');
    return false;
  }
  await manualSaveChapter();
  replaceEditorContent(editor, textToParagraphsHtml(reply), range);
  scheduleSave();
  toast('已应用 AI 结果', 'success');
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// R08 长正文处理：目标正文不再被 slice(0, 6000 / 12000)
//
// 旧链路自称"整章润色/扩写/审稿/修稿"，实现却把**目标正文**截到前 6000 / 12000 字，
// 于是"处理整章"实际只处理了前半章，而且没有任何地方能看出这件事（无片号、无覆盖清单、无版本）。
// 现在：先按**最终序列化请求**的量估算（含 system/上下文/输出预留/协议开销），
// 能单请求就整篇进；超限则按段落切成稳定片（片号由内容 hash 得出，不随前文编辑漂移），
// 逐片落候选 → 覆盖清单通过且源版本仍匹配 → 才给作者差异预览/采纳。
// 合法保留的裁剪不在本模块内：预览摘要、日志脱敏、安全上限、上下文层自身的预算裁剪。
// ══════════════════════════════════════════════════════════════════════════════
const LONG_TEXT_STORE_KEY = 'ns_long_text_run';

function longTextEngine() {
  return (typeof globalThis !== 'undefined' && globalThis.NovelLongText) || null;
}

// 分段阈值（字符，按最终序列化请求计）。默认值刻意保守：按中文 ≈1 字/token 的常见口径，
// 48000 字整包 + 12000 输出预留 + 1500 协议预留仍明显低于模型上下文窗口。
// 这是"何时分段"的工程阈值，**不是**宿主上下文预算；TOTAL_BUDGET / 各层 cap 不因它改变。
function longTextLimits() {
  const s = state.longTextSettings || {};
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    request_chars: num(s.request_chars, 48000),
    output_reserve_chars: num(s.output_reserve_chars, 12000),
    protocol_chars: num(s.protocol_chars, 1500),
    max_segment_chars: num(s.max_segment_chars, 8000),
    min_segment_chars: num(s.min_segment_chars, 400),
    neighbor_chars: num(s.neighbor_chars, 800),
    sentinel_chars: 60
  };
}

// context-only 邻接文本的显式围栏：模型读得懂"这段不许改"，覆盖阶段也能机械验证。
function longTextContextBlock(segment) {
  if (!segment) return '';
  const lines = [];
  if (segment.context_before) lines.push('上文结尾（context-only，禁止修改）：\n' + segment.context_before);
  if (segment.context_after) lines.push('下文开头（context-only，禁止修改）：\n' + segment.context_after);
  return lines.join('\n\n');
}

function longTextPlanFor(kind, text, opts = {}) {
  const K = longTextEngine();
  const limits = longTextLimits();
  const source = String(text == null ? '' : text);
  if (!K) return { mode: 'unavailable', kind, source_version: '', source_chars: source.length, segments: [], budget: {}, limits };
  const meta = longTextKindMeta(kind, opts);
  const probe = meta.probe ? meta.probe(source, null) : [{ role: 'user', content: source }];
  return K.planTask({ text: source, kind, limits, probeMessages: probe });
}

function longTextSaveRun(kind, chapterId, plan, results) {
  try {
    const payload = { v: 1, kind, chapter_id: chapterId || null, at: Date.now(), source_version: plan.source_version, source_chars: plan.source_chars, results };
    const encoded = JSON.stringify(payload);
    // 候选要能跨刷新续跑；超大数据不硬塞 localStorage（宁可不持久化，也不让浏览器抛配额异常）。
    if (encoded.length > 400000) {
      reportClientLog({ level: 'warn', kind: 'long_text_store_skipped', message: `[长正文] 候选体积 ${encoded.length} 字，超过本地持久化上限，本次不落本地（刷新后需重跑）` });
      return;
    }
    localStorage.setItem(LONG_TEXT_STORE_KEY, encoded);
  } catch (e) { /* 持久化失败不阻塞本次处理 */ }
}

function longTextLoadRun(kind, chapterId, sourceVersion) {
  try {
    const payload = JSON.parse(localStorage.getItem(LONG_TEXT_STORE_KEY) || 'null');
    if (!payload || payload.kind !== kind) return null;
    if (String(payload.chapter_id || '') !== String(chapterId || '')) return null;
    if (payload.source_version !== sourceVersion) return null;
    return payload;
  } catch (e) { return null; }
}

function longTextClearRun() {
  try { localStorage.removeItem(LONG_TEXT_STORE_KEY); } catch (e) {}
}

function longTextCancelRun() {
  if (state.longTextCancel) state.longTextCancel.cancelled = true;
}

// UI 摘要：原文版本 / 目标范围 / 片数 / 完成·失败·过期 / 覆盖结论 / 未解决项。
function longTextStatusHtml(run) {
  const K = longTextEngine();
  if (!K || !run || !run.plan) return '';
  const lines = K.summaryText({ plan: run.plan, results: run.results, manifest: run.manifest });
  const resume = run.resume && run.resume.rerun && run.resume.rerun.length
    ? '<div class="muted">再次点击同一操作会自动续跑未完成的片（已完成且源版本一致的片不重跑）</div>' : '';
  return `<div class="long-text-status"><div class="ref-group-title">分段处理</div><ul class="long-text-lines">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${resume}</div>`;
}

// 每种任务的差异都在这一张表里：探测消息（量最终请求）、单片消息/提示词、输出解析、验证策略。
function longTextKindMeta(kind, opts) {
  const o = opts || {};
  const instruction = String(o.instruction || '');
  switch (kind) {
    case 'polish':
      return {
        label: '润色', tier: 'fast',
        probe: (text) => buildAIPolishMessages(text, instruction),
        messages: (text) => buildAIPolishMessages(text, instruction),
        segmentMessages: (seg) => buildAIPolishMessages(seg.target.text, instruction, { segment: seg, context: aiContextBlock() })
      };
    case 'expand':
      return {
        label: '扩写', tier: 'fast',
        probe: (text) => buildAIExpandMessages(text, instruction),
        messages: (text) => buildAIExpandMessages(text, instruction),
        segmentMessages: (seg) => buildAIExpandMessages(seg.target.text, instruction, { segment: seg, context: aiContextBlock() })
      };
    case 'review':
      return {
        label: '审稿', tier: 'quality', job: true, reports: true,
        probe: (text) => [{ role: 'user', content: buildAIReviewPrompt(text, o.redlineScanText || '', o.continuityGuardText || '', o.targetWords || 0) }],
        prompt: (text, seg) => buildAIReviewPrompt(text, o.redlineScanText || '', o.continuityGuardText || '', o.targetWords || 0, seg ? { segment: seg } : {}),
        parse: (seg, raw) => {
          const parsed = parseReviewText(raw);
          if (!parsed.report) throw new Error('审稿 JSON 解析失败（该片将标为失败并可续跑）');
          return { output: raw, report: parsed.report };
        },
        // 审稿是只读任务：它可以引用/复述正文，因此不做"回显邻接段"判定；只要求非空。
        verify: (seg, raw) => (String(raw == null ? '' : raw).trim() ? { ok: true, cleaned: String(raw), reasons: [] } : { ok: false, cleaned: '', reasons: ['empty-output'] })
      };
    case 'revision_patch':
      return {
        label: '修稿（按段）', tier: 'quality', job: true,
        probe: (text) => [{ role: 'user', content: buildAIRevisionPatchPrompt(text, o.issues || []) }],
        prompt: (text, seg) => buildAIRevisionPatchPrompt(text, o.issues || [], seg ? { segment: seg } : {}),
        parse: (seg, raw) => {
          // 单请求路径（未分段）没有 segment：底稿是整篇正文（o.text 为调用方传入的待修文本）。
          const base = seg ? seg.target.text : String(o.text == null ? '' : o.text);
          // 安全门禁按**本片底稿**判定：命中的补丁不进本片结果，由 upper 层在差异预览里逐条说明。
          const patched = tryApplyRevisionOutput(raw, base, patchSafetyOptions(o.chapterId));
          if (!patched || !patched.ok) throw new Error('补丁未能定位到本片段落（该片将标为失败并可续跑）');
          const blocked = patched.blocked || [];
          return {
            output: patched.text,
            extra: {
              applied: patched.applied.length,
              unresolved: patched.unresolved.length,
              noop: !!patched.noop,
              blocked: blocked.length,
              // extra 会随分段结果落 localStorage：只带前 5 条、只带展示所需字段。
              blockedList: blocked.slice(0, 5).map((b) => ({ code: b.code, reason: b.reason, anchor: String(b.anchor || '').slice(0, 40) })),
              findings: (patched.findings || []).slice(0, 5),
            },
          };
        }
      };
    case 'revision_full':
      return {
        label: '修稿（整片重写）', tier: 'quality', job: true,
        probe: (text) => [{ role: 'user', content: buildAIRevisionPrompt(text, o.issues || []) }],
        prompt: (text, seg) => buildAIRevisionPrompt(text, o.issues || [], seg ? { segment: seg } : {}),
        parse: (seg, raw) => {
          const finalText = parseAIWritingOutput(raw).finalText || '';
          if (!finalText.trim()) throw new Error('修稿结果为空（该片将标为失败并可续跑）');
          return { output: finalText };
        }
      };
    case 'repair_full':
      return {
        label: '修复硬伤', tier: 'quality', job: true,
        probe: (text) => [{ role: 'user', content: buildAIWriteRepairPrompt(text, o.issues || [], o.blueprint, o.targetWords || 0) }],
        prompt: (text, seg) => buildAIWriteRepairPrompt(text, o.issues || [], o.blueprint, o.targetWords || 0, seg ? { segment: seg } : {}),
        parse: (seg, raw) => {
          const finalText = parseAIWritingOutput(raw).finalText || '';
          if (!finalText.trim()) throw new Error('修复结果为空（该片将标为失败并可续跑）');
          return { output: finalText };
        }
      };
    case 'quality_gate':
      return {
        label: '质检', tier: 'fast',
        probe: (text) => [{ role: 'user', content: buildAIWriteQualityPrompt(text, o.blueprint) }],
        prompt: (text, seg) => buildAIWriteQualityPrompt(text, o.blueprint, seg ? { segment: seg } : {}),
        messages: (text) => [{ role: 'user', content: buildAIWriteQualityPrompt(text, o.blueprint) }],
        parse: () => ({ output: '' }),
        verify: (seg, raw) => ({ ok: true, cleaned: String(raw || ''), reasons: [] })
      };
    case 'personality':
      return {
        label: '角色一致性', tier: 'fast',
        probe: (text) => buildAIPersonalityMessages(o.characterId, text) || [{ role: 'user', content: text }],
        messages: (text) => buildAIPersonalityMessages(o.characterId, text) || [{ role: 'user', content: text }],
        segmentMessages: (seg) => buildAIPersonalityMessages(o.characterId, seg.target.text, { segment: seg }) || [{ role: 'user', content: seg.target.text }]
      };
    default:
      throw new Error('未知的长正文任务类型：' + kind);
  }
}

async function longTextCallModel(kind, meta, ctx) {
  // 离线测试/探针注入点：生产环境不设置 state.longTextRunner（见 docs/enhancement-acceptance.md）。
  if (typeof state.longTextRunner === 'function') {
    return state.longTextRunner({ kind, label: meta.label, segment: ctx.segment || null, messages: ctx.messages || null, prompt: ctx.prompt || null });
  }
  if (meta.job) {
    const stageLabel = meta.label + (ctx.segment ? ` · ${ctx.segment.segment_id}（第 ${ctx.segment.ordinal} 片）` : '');
    const data = await runHarnessJob({
      timeout: longAiTimeout(),
      model: policyModel(meta.tier),
      reasoning_effort: policyEffortForTier(meta.tier) || undefined,
      action: 'write',
      work_id: state.workId || state.work?.id || undefined,
      chapter_id: ctx.chapterId || undefined,
      mode: 'full',
      prompt: ctx.prompt,
      kind: ctx.segment ? 'long_text_segment' : kind,
      stage: stageLabel
    }, stageLabel + ' · 正在处理…');
    if (data && data.job_id) state.longTextJobIds = (state.longTextJobIds || []).concat([data.job_id]);
    return String((data && data.output) || '');
  }
  return runHarnessFromMessages(ctx.messages, {
    model: policyModel(meta.tier),
    action: kind === 'polish' || kind === 'expand' ? kind : 'write',
    chapter_id: ctx.chapterId || undefined
  });
}

/**
 * 长正文统一入口：单请求能装下就整篇处理；装不下就分段跑 + 覆盖清单 + 合并。
 * 返回值：{ mode, plan, results, manifest, merged, report, reasons, resume, statusHtml }。
 * merged === null 表示"不得采纳"（缺片/重复/越界/源版本变化/取消），正文一个字都不会被动。
 */
async function longTextRunTask(kind, opts) {
  const K = longTextEngine();
  const options = opts || {};
  const text = String(options.text == null ? '' : options.text);
  if (!K) throw new Error('长正文分段模块未加载（public/long-text.js）——拒绝用截断方式处理整章');
  const meta = longTextKindMeta(kind, options);
  const plan = longTextPlanFor(kind, text, options);
  const chapterId = Number(options.chapterId || state.currentChapterId) || null;
  state.longTextJobIds = [];
  if (plan.mode !== 'segmented') {
    // 单请求路径的两种归属：
    //   · 默认（润色/扩写/整片重写）——模块内直接调用模型并把结果返回给调用方；
    //   · singleRunByCaller —— 调用方有一条更完整的单请求老路径（审稿要保留"解析失败仍存原文"的容错、
    //     修稿要带回退整章重写、精修要接写作流水线）：模块只回计划，不预跑模型。
    //     否则同一次任务会真实调用模型两遍——同一份钱花两次，还白等一倍时间。
    if (options.singleRunByCaller) {
      return {
        kind, plan, mode: 'single', results: [], manifest: null, cancelled: false,
        merged: null, report: null, extra: null, reasons: [],
        resume: { reuse: [], rerun: [], rows: [] },
        statusHtml: longTextStatusHtml({ plan })
      };
    }
    const raw = await longTextCallModel(kind, meta, {
      segment: null, chapterId,
      messages: meta.messages ? meta.messages(text) : null,
      prompt: meta.prompt ? meta.prompt(text, null) : null
    });
    const parsed = meta.parse ? meta.parse(null, raw) : { output: raw };
    for (const id of state.longTextJobIds) markJobApplied(id);
    state.longTextJobIds = [];
    return {
      kind, plan, mode: 'single', results: [], manifest: null, cancelled: false,
      merged: parsed.output, report: parsed.report || null, extra: parsed.extra || null,
      reasons: [], resume: { reuse: [], rerun: [], rows: [] },
      statusHtml: longTextStatusHtml({ plan })
    };
  }
  // 断点续跑：同章、同源版本的已完成候选可以被复用（失败/缺片只补跑那几片）。
  const prior = longTextLoadRun(kind, chapterId, plan.source_version);
  const results = prior && Array.isArray(prior.results) ? prior.results.slice() : [];
  const signal = { cancelled: false };
  state.longTextCancel = signal;
  // ── P1-08：把「停止」接进分段编排层 ──────────────────────────────────────────────
  // 旧实现的三个问题叠在一起，使"停止"变成"跳过当前片"：
  //   ① `longTextCancelRun()` 全仓无调用点（孤儿函数，只有定义）；
  //   ② 分段进度条（`#ai-task-progress`）没有取消按钮 —— 用户能点到的「停止」只有**片内**
  //      慢通道进度卡上的那一个；
  //   ③ 那个按钮抛出的是 cancelledErr，而 `long-text.js` 的逐片 catch 把**任何**异常
  //      都记成"本片失败"并继续下一片。
  // 现在：分段任务自己在共享进度条上装取消按钮，并按"先置取消位、再尽力取消在途作业"处理。
  // 后续片是否发起只由取消位决定，因此在途取消失败也不会让任务继续跑下去。
  const cancelInflight = () => {
    longTextCancelRun();
    const ids = Array.isArray(state.longTextJobIds) ? state.longTextJobIds.slice() : [];
    for (const id of ids) {
      // 尽力取消在途作业；失败不影响"后续片不再发起"这一保证。
      api('/harness/cancel', { method: 'POST', body: { job_id: id } }).catch(() => { /* 忽略 */ });
    }
  };
  const wireCancelButton = () => {
    const el = document.getElementById('ai-task-progress');
    if (!el) return null;
    el.hidden = false;
    el.innerHTML = `<span class="muted">长正文分段处理准备中…</span>`
      + `<button class="btn secondary btn-xs" data-action="long-text-cancel">停止</button>`;
    const btn = el.querySelector('[data-action="long-text-cancel"]');
    if (btn) btn.addEventListener('click', (ev) => { ev.preventDefault(); cancelInflight(); });
    return el;
  };
  const cancelCtl = wireCancelButton();
  let run = null;
  const parsedBySegment = new Map();
  try {
    if (typeof options.onStart === 'function') options.onStart(plan, results);
    run = await K.runSegmentedTask({
      plan, results, signal,
      verify: meta.verify || undefined,
      messagesFor: (seg) => (meta.segmentMessages
        ? meta.segmentMessages(seg)
        : K.segmentMessages({ system: '你是资深中文小说编辑。', context: aiContextBlock() || '无', instruction: options.instruction, segment: seg, kind: meta.label })),
      runner: async (seg, messages) => {
        const raw = await longTextCallModel(kind, meta, {
          segment: seg, chapterId, messages, prompt: meta.prompt ? meta.prompt(seg.target.text, seg) : null
        });
        const parsed = meta.parse ? meta.parse(seg, raw) : { output: raw };
        parsedBySegment.set(seg.segment_id, parsed);
        return parsed.output;
      },
      onProgress: (p) => {
        longTextSaveRun(kind, chapterId, plan, p.results);
        if (typeof options.onProgress === 'function') options.onProgress(plan, p.results);
      }
    });
  } catch (e) {
    // 取消是"用户意图"，不是失败：如实上抛，由调用方按 e.cancelled 分支处理（不弹错误 toast）。
    if ((e && e.cancelled === true) || signal.cancelled) {
      const err = new Error('任务已取消');
      err.cancelled = true;
      err.partial = run && Array.isArray(run.results) ? run.results : results;
      throw err;
    }
    throw e;
  } finally {
    if (cancelCtl) { cancelCtl.hidden = true; cancelCtl.innerHTML = ''; }
    state.longTextCancel = null;
  }
  for (const rec of run.results) {
    const parsed = parsedBySegment.get(rec.segment_id);
    if (parsed && rec.status === 'done') { rec.report = parsed.report || null; rec.extra = parsed.extra || null; }
  }
  for (const id of state.longTextJobIds) markJobApplied(id);
  state.longTextJobIds = [];
  longTextSaveRun(kind, chapterId, plan, run.results);
  const current = typeof options.currentText === 'function' ? String(options.currentText() == null ? '' : options.currentText()) : text;
  const currentVersion = K.hashText(current, 16);
  const manifest = K.buildCoverageManifest({ source: text, plan, results: run.results, current_version: currentVersion });
  const merged = K.mergeResults({ source: text, plan, results: run.results, current_version: currentVersion });
  const resume = K.resumeSegments(plan, run.results, currentVersion);
  const statusHtml = longTextStatusHtml({ plan, results: run.results, manifest, resume });
  if (!manifest.ok) {
    reportClientLog({ level: 'warn', kind: 'long_text_incomplete', message: `[${meta.label}] 分段未通过覆盖清单：${manifest.unresolved.join('；')}` });
  }
  return {
    kind, plan, mode: 'segmented', results: run.results, manifest,
    cancelled: run.cancelled, reasons: merged.ok ? [] : merged.reasons,
    merged: merged.ok && !run.cancelled ? merged.merged : null,
    report: meta.reports ? K.mergeReviewReports({ plan, results: run.results }) : null,
    resume, statusHtml
  };
}

function buildAIPolishMessages(text, instruction = '', opts = {}) {
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const system = '你是资深中文网络小说润色编辑。请在不改变原意和剧情的前提下，优化语句通顺度、节奏感和表现力。只输出润色后的正文，不要输出解释。';
  const head = `当前作品：${state.work?.title || ''}
当前章节：${chapter.title || ''}
${instruction ? `润色要求：${instruction}` : ''}`;
  // 分段路径：只把本片 target 交给模型，邻接段明确标成 context-only（不许改、不许回吐）。
  if (opts.segment) {
    const contextOnly = opts.context !== undefined ? opts.context : aiContextBlock();
    const user = `${head}

AI 上下文（角色卡 / 世界观 / 作者注）：
${contextOnly || '无'}

${longTextContextBlock(opts.segment)}

需要润色的内容（target ${opts.segment.segment_id}，第 ${opts.segment.ordinal} 片 · 全文，未截断）：
${text}

请直接输出这一片润色后的完整内容；不要输出上文/下文（context-only）的任何文字，不要输出解释或标题。`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }
  const user = `${head}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}

需要润色的内容（全文，未截断）：
${text}

请直接输出润色后的完整内容。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function buildAIExpandMessages(text, instruction = '', opts = {}) {
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const system = '你是资深中文网络小说扩写助手。请在保留原有内容的基础上，合理扩充细节、动作、心理、环境描写，让情节更丰满。只输出扩写后的完整正文，不要输出解释。扩写后整体正文建议不少于 2000 字（若原文已超过则保持自然增长即可）。';
  const head = `当前作品：${state.work?.title || ''}
当前章节：${chapter.title || ''}
${instruction ? `扩写要求：${instruction}` : ''}`;
  if (opts.segment) {
    const contextOnly = opts.context !== undefined ? opts.context : aiContextBlock();
    const user = `${head}

AI 上下文（角色卡 / 世界观 / 作者注）：
${contextOnly || '无'}

${longTextContextBlock(opts.segment)}

需要扩写的内容（target ${opts.segment.segment_id}，第 ${opts.segment.ordinal} 片 · 全文，未截断）：
${text}

请直接输出这一片扩写后的完整内容；不要输出上文/下文（context-only）的任何文字，不要输出解释或标题。`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  }
  const user = `${head}

AI 上下文（角色卡 / 世界观 / 作者注）：
${aiContextBlock() || '无'}

需要扩写的内容（全文，未截断）：
${text}

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

// ── 统一写作策略源（去 AI 味 P0）──────────────────────────────────────────────
// 真源在服务端 `ai/writing/policy.mjs`，经 GET /api/ai/writing-policy 下发。
// 浏览器脚本无法 import 模块、且本仓库没有构建步骤，因此这里保留**同文兜底**；
// frontend-test.mjs 有断言逐条比对两侧文本，只改一侧会直接测试失败（防漂移）。
const WRITING_POLICY_FALLBACK_VERSION = '2026-10-06.2';
const WRITING_POLICY_FALLBACK_RULES = [
  { id: 'length_is_advisory', type: 'preference', scopes: ['blueprint', 'draft', 'expand', 'rewrite'], priority: 70, text: '目标字数是范围参考，不是配额。篇幅不足但剧情已经完整时，允许按已成立的章尾收笔，不要为凑字数强行往下续写。' },
  { id: 'scene_count_no_quota', type: 'preference', scopes: ['blueprint', 'draft'], priority: 65, text: '场面数量按剧情需要决定：可以只有一个值得展开的场面，也可以有多个；不要靠增加场景或情节点凑字数，也不要把篇幅平均分配给每个场面。' },
  { id: 'avoid_repeated_full_mechanism', type: 'preference', scopes: ['draft', 'rewrite', 'expand'], priority: 60, text: '同一机制已经完整展示过后，再次出现时优先写差异、结果或人物反应，不要自动完整复现一遍。' },
  { id: 'system_airtime_no_quota', type: 'preference', scopes: ['draft'], priority: 55, text: '系统按本章剧情需要出场，不设次数配额；每次发言都应带来新信息或改变人物处境，纯播报式【】不要占多数。' },
  { id: 'allow_omission', type: 'preference', scopes: ['blueprint', 'draft'], priority: 50, text: '存在一个事件不等于必须形成完整场景；存在一个情绪不等于必须配一个动作；存在群众不等于必须给群众反应；存在重要角色不等于登场时必须突出。允许略写、跳过、沉默与突然结束。' },
  { id: 'scene_detail_budget', type: 'preference', scopes: ['blueprint', 'draft'], priority: 63, text: '动笔前先回答“这个场景值得把叙述资源花在哪里”：先定它的主要功能（建立哪条信息、哪段关系、哪种处境），次要项可以略写或跳过；不设细节数量、字数比例或固定配比。' },
  { id: 'protect_high_identity', type: 'preference', scopes: ['rewrite'], priority: 68, text: '修稿只做最小改动：优先删除或合并低价值的重复证据、去掉含义已由动作或对白表达之后的总结句，不要全文重写；承担多项功能、有辨识度的人物选择与对白（例如从安慰自然转到“饭吃了没有”）保持原样，不要润色成更完整、更煽情或更工整的版本。' },
  { id: 'diag_state_regression', type: 'diagnostic', scopes: ['verify_fact'], priority: 80, text: '已完成的任务/移动/持有物，是否在没有任何新事件的情况下回退成"未完成"？' },
  { id: 'diag_space_gap', type: 'diagnostic', scopes: ['verify_fact'], priority: 60, text: '人物是否从一个地点直接出现在另一个地点而缺少必要过渡？当前视点是否看得见所描写的东西？' },
  { id: 'diag_world_boundary', type: 'diagnostic', scopes: ['verify_fact'], priority: 55, text: '新出现的等级/术语/制度，与既有设定是"冲突"还是"未知"？没有明确闭集证据时只标记待核对，不要自行补设定。' },
  { id: 'diag_repeated_mechanism', type: 'diagnostic', scopes: ['verify_style'], priority: 60, text: '同一种流程是否被完整复现第二次，而新增信息主要来自人物反应？' },
  { id: 'diag_over_explanation', type: 'diagnostic', scopes: ['verify_style'], priority: 55, text: '含义已经由动作/对白/结果表达之后，是否又补了一句总结或解释？' },
  { id: 'diag_crowd_rotation', type: 'diagnostic', scopes: ['verify_style'], priority: 50, text: '是否存在连续多段只承担布景任务、不改变任何人物路线或信息的匿名群众反应？' },
  { id: 'diag_voice_convergence', type: 'diagnostic', scopes: ['verify_style'], priority: 45, text: '去掉姓名后，不同人物的对白是否还能区分？情绪是否总靠小动作翻译？' },
  { id: 'diag_information_saturation', type: 'diagnostic', scopes: ['verify_style'], priority: 62, text: '某项信息是否已经被足够强的证据建立，后面还在用功能相同的细节继续证明（例如住宅老旧已由“六层无电梯 + 外墙掉瓷砖”建立，之后接连写多个坏灯）？只提示疑点，不规定同一信息最多出现几次——高潮、恐怖、压迫、喜剧都可能故意累积。' },
  { id: 'diag_functional_redundancy', type: 'diagnostic', scopes: ['verify_style'], priority: 61, text: '句子虽然不同，是否承担完全相同的叙事功能（有人摇头 / 有人议论 / 有人惋惜，都在证明“大家觉得可惜”）？按功能判断，不要只查重复句式。' },
  { id: 'diag_false_foreshadow', type: 'diagnostic', scopes: ['verify_fact'], priority: 58, text: '疑似伏笔、未知等级、暂未解释的异常，是“有意留白”还是“为显得神秘而塞入、却没有后续意义”？本章判不出来就归入 deferred 待后续章节核验，不要写成硬伤、也不要当作设定冲突。' },
  { id: 'diag_negative_explanation', type: 'diagnostic', scopes: ['verify_style'], priority: 52, text: '“没说 / 没问 / 没解释 / 没有别的 / 没再看”这类否定式短句，是否连续承担“作者不直接总结、但仍在解释人物心理”的功能？只在明显重复时提示，不设禁词。' },
  { id: 'diag_detail_function_density', type: 'diagnostic', scopes: ['verify_style'], priority: 48, text: '这个细节除了当前作用，是否还有第二作用（同时推进人物、关系或处境）？只有“功能单一且已被别处证明”的细节才提示为可删或可合并，不要机械打分。' }
];

// 取规则：优先用服务端快照，取不到时退回同文兜底。规则里 `text` 是唯一展示源。
function writingPolicyRules() {
  const snap = state.writingPolicy;
  if (snap && Array.isArray(snap.rules) && snap.rules.length) return snap.rules;
  return WRITING_POLICY_FALLBACK_RULES;
}

// 编译某阶段的规则文本（type: preference=要遵守 / diagnostic=要检查 / fact=硬约束）。
// 优先用服务端已编译好的分区（与 ai/writing/compile.mjs 同源）；没有才本地按规则编译，
// 本地也没有（离线直连）就用上面同文兜底规则。
function writingPolicyLines(scope, type = 'preference') {
  const snap = state.writingPolicy;
  const precompiled = snap && snap.compiled && snap.compiled[type] && snap.compiled[type][scope];
  if (Array.isArray(precompiled)) return precompiled.slice();
  return writingPolicyRules()
    .filter((r) => r && Array.isArray(r.scopes) && r.scopes.includes(scope) && r.type === type)
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((r) => `- ${r.text}`);
}

// 直连通道没有插件人设（慢通道人设 agent.cordis.yml 里含这些纪律）。把与蓝图/审稿相关的几条
// **内联进提示词**，两条通道的"写作纪律"就对齐了 —— 这是"改走直连又不掉质量"的前提。
// 依据：2026-09-18 实测慢通道每次多花 ≈17 秒固定开销（dsh 冷启动 + 智能体循环），
// 而插件人设第 17 行自己写着「提示词已内联提供时不必重复调用 novel_context」。
const WRITING_DISCIPLINE = [
  '【写作纪律（务必遵守）】',
  '1. 上面的【当前小说上下文】就是你的资料。若某处标注「已按预算截断」，只依据现有信息作答，并在相应字段注明不确定；不要编造与既有设定冲突的内容。',
  '2. 严格避开【写作风格红线】里的词句：用具体动作、感官细节、对话潜台词替代「嘴角勾起一抹冷笑」式的万能模板；克制形容词与排比，保留网文节奏但拒绝 AI 腔。',
  // 2026-10-02：下面三条针对**词表测不到的三类密度型痕迹**（红线 0 命中、读者仍判成 AI 的那部分）。
  // 依据是 work#18 第三章实测：短句占比 27.5%、"三秒"复现 11 次、几乎每个前文元素都被二次利用，
  // 以及作者逐句指认的「不是轻。是没有重量。」「把那句话放在桌面上，让它自己立住。」这类句式。
  '3. 不要写"金句化"的短语判断：禁止「不是 X。是 Y。」这种先否定、再给一个更精准说法的收束，也不要连续用三个短句当总结（例如"条款成立。协议有效。他自己签的字。"）。该说清楚的地方，用正常句子说完。',
  '4. 不要给抽象判断配一个视觉化动作或比喻（例如"把那句话放在桌面上，让它自己立住"）；比喻只在真正有力时用一次，不要保持均匀的比喻密度——大多数段落应该是普通叙述，而不是每段都有一句漂亮的比喻。',
  '5. 回扣前文元素要有叙事必要：不要为了让出现过的意象、数字、颜色或口头禅再出现一次而写。允许有些细节全章只出现一次，也允许人物的想法在章内没有想通——不要每次都给出完整的认知闭环。',
  '5b. 不要把普通场景写成分镜脚本：除非叙事确实处在转播/拍摄视角，否则少用“镜头、画面、远景、切回、推到”等调度词。也不要用“像……或者只是……”或“其实……根本……”替读者反复校正你刚写的画面；选定人物此刻真正看到的一件东西即可。',
  // 2026-10-02（作者第三轮逐句意见）：下面四条针对**词表测不到的另一类痕迹**——不是用词问题，
  // 而是"叙述者在场"与"场景自洽"的问题。前三类在旧纪律里**完全没有对应项**（旧纪律只管
  // "仿佛/似乎/淡淡的"这类词面），这正是它们会被稳定反复写出来的直接原因。
  // ⚠️ 加这些是**给模型避坑**，不是要求把文字写得更"素"：作者明确说过，再往"去 AI 化"方向改
  // 很容易把已经建立起来的节奏弄平，接下来要做的是编辑意义上的精修（删重复、校逻辑、控信息释放）。
  '6. 叙述者不要越界（两类）：不要写"这句话/这个念头在他心里怎么被磨到能说出口"（如"他在心里把这句话转了很多遍，转顺了，顺到张嘴就能说出来"）——直接给那句话或那个念头本身；也不要让叙述者站到人物外面替他按年龄/常理解释（"这个年纪遇到这种事…""换了谁都会…""正常人都会…"），改成他此刻的动作，或让他自己把那句话说出口。',
  '7. 过渡动作（慢慢点头 / 沉默片刻 / 深吸一口气 / 皱眉 / 苦笑这一级）本身没错，但不能当节拍器用：一需要"停一下"就来一个，节奏会显得是按模板补拍的。同一个动作在本章写到第二遍基本不再提供新信息；要保留两处，第二处换一件与当下目标有关的具体事，而不是换个副词。判断法：删掉它，读者得到的信息没有减少、只是少了一次停顿——那它就是填充。',
  '7b. 身体小动作不是情绪词库：手、嘴、眼、后颈、裤腿等部位不要轮流各来一次。一个动作只有在改变信息、关系或选择时才保留；否则直接写结果或潜台词。',
  '8. 物件方位要自洽：一件道具在章内只允许有一个明确位置（哪个包、哪一层、哪个口袋）。写了"再往里摸 / 更深的地方"，就要先交代那一层是什么（例如"主袋里侧还有个夹层"），后文一律按这个位置说，不要在两层之间漂移。',
  '9. 细节经济：同一个编号/纸条/道具不要被反复"调出来用"。首次出现可以写足（材质、笔画、毛边都行），之后每次回想只保留**关键连接**（"纸条上那四个数字，和短信前面那四个一样"就够了），不要重新描述一遍外观。'
].join('\n');

// 蓝图专用的一条：`references` 是蓝图 JSON 的字段，审稿报告的字段集里没有它 ——
// 重审发现早先把它并进通用纪律，于是审稿提示词里出现"需要回扣的写进 references"这种对不上的指示。
const BLUEPRINT_EXTRA_DISCIPLINE = '3. 与既有设定/伏笔保持一致；只在叙事必须时回扣（本章 references 最多 1～2 条），没有依据就留空——不要为了呼应而呼应，也不要罗列所有还能再出现的元素。';

function buildAIWritingBlueprintPrompt(initial, history, targetWords, auto = false) {
  const lines = [];
  lines.push(`你是资深中文网络小说创作助手。你熟悉网文爽点、节奏、人物塑造和世界观设定。`);
  if (auto) {
    lines.push(`批量自动模式：不要提问，直接输出【蓝图】。`);
  } else {
    lines.push(AI_WRITING_CLARIFY_PROMPT);
  }
  lines.push('');
  lines.push(WRITING_DISCIPLINE);
  lines.push(BLUEPRINT_EXTRA_DISCIPLINE);
  lines.push(``);
  lines.push(`对话输出规则：
- ${auto ? '直接输出，不需要提问。' : '如果还需要了解我的需求，第一行必须严格是【提问】，随后只输出一个问题，不要输出其他内容。'}
- 第一行必须严格是【蓝图】，随后只输出一个 JSON 对象（不要 Markdown 代码块、不要解释），字段如下：
{
  "scene_goal": "本场景目标（一句话）",
  "plot_points": "本章关键情节点，每个一行：地点、出场人物、身体动作、冲突/转折（数量按剧情需要，不设配额）",
  "conflicts": "冲突与转折",
  "character_changes": "出场角色状态变化",
  "hook": "下一章钩子（收尾悬念）",
  "references": "本章确实必须回扣的既有设定/伏笔（最多 1～2 条；没有就留空字符串）。这不是呼应清单：不要罗列所有还能再出现的意象、数字或口头禅"
}
- ${auto ? '直接输出【蓝图】。' : '每轮最多只能问一个问题。'}`);
  lines.push(``);
  lines.push(`蓝图容量要求：本章目标字数 ${targetWords} 字（只作区间参考，不设配额）。只覆盖“一章”的容量，不要规划成多章内容。`);
  // 场面数量/篇幅等偏好来自统一写作策略源（ai/writing/policy.mjs），不再硬编码在提示词里。
  writingPolicyLines('blueprint').forEach((l) => lines.push(l));
  // 2026-09-21：补章节边界。此前只有“不要规划成多章”这一句，它禁止的是**一次规划多章**，
  // 并不禁止为后续章节做动机前置——实测第 5 章的蓝图里就写着“为第七章转学海澜市做动机前置”，
  // 把第 7 章的转学动机、第 10 章的测试题材、第 46～50 章的身份曝光线索提前消费掉了。
  lines.push(`章节边界（硬约束，必须遵守）：`);
  lines.push(`- 本章只允许写"本章摘要 + 本蓝图情节点"覆盖的内容。`);
  lines.push(`- 不得为后续章节做动机前置；不得提前释放后续章节的悬念、身份曝光类线索或设定升级（例如妖兽阶位、组织介入、城市危机等级）。`);
  lines.push(`- 不得引入未登记的具名角色/地点/妖兽。确需新名字时，只能写进 references 并标注"待作者确认的提案"，不得直接写进情节点。`);
  lines.push(`- 大纲里标注【未来章·禁止写入】的条目只用于规划与避免矛盾，正文不得提前消费其中任何一条。`);
  // 2026-10-02：回扣从"越多越好"改成"能少则少"——第三章蓝图的 references 列了 6 条回扣，
  // 成文时被逐条兑现，读起来像"作者在检查前文元素有没有被再次利用"。
  lines.push(`- references 只列本章确实必须回扣的 1～2 条；不要求"每个前文元素都再出现一次"，本章允许有只出现一次、之后不再被利用的细节。`);
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
    // 2026-09-18：**成文轮此前漏了内联写作纪律**（蓝图轮 5643 / 审稿轮 6104 都有，只有成文轮没有）。
    // 后果是不对称的：慢通道成文靠插件人设补齐纪律，而直连成文（交互路径的默认通道）既没有人设、
    // 也没有内联纪律 —— 只有装配上下文里的【写作风格红线】**词表**，"用具体动作/感官细节/对话
    // 潜台词替代模板句"这条**行为**纪律根本没进提示词。README 说的"两条通道纪律对齐"因此
    // 只在蓝图轮与审稿轮成立。这里补上，两条通道才真正同源（同一份常量，不另写一份）。
    WRITING_DISCIPLINE,
    ``,
    `【本章蓝图 · 写作必须遵守】`,
    bpText || '（未提供蓝图，按用户需求自由成文）',
    ``,
    // 2026-09-21：删掉“推进情节”。它是越界许可证——第 5 章只有一条摘要事件，目标 4000 字的
    // 压力加上这句授权，模型就去借第 7 章的转学动机与第 46～50 章的身份曝光钩子来填篇幅。
    // 缺料只允许在已有情节点内部补细节，不允许新增情节。
    `【篇幅要求（重要）】整章正文以纯文本计约 ${targetWords} 字（区间 ${Math.max(2000, targetWords - 1000)}～${targetWords + 1000} 字，只作区间参考，不设配额）；把蓝图里的场面写完整：每个场面必须有明确地点、出场人物、身体动作和冲突/转折，再在场面内部补环境、动作、心理、对话与节奏（用具体动作、感官细节替换模板句）。**不得为凑字数新增场景或情节点**，不得引入后续章节的动机、悬念或身份曝光线索，不得新增未登记的具名角色/地点/妖兽；不要提前收尾，也不要注水。`,
    // 篇幅/场面等偏好来自统一写作策略源（ai/writing/policy.mjs），不再硬编码在提示词里。
    ...writingPolicyLines('draft'),
    ``,
    `【章节边界（硬约束）】只写"本章摘要 + 本章蓝图"覆盖的内容。大纲里标注【未来章·禁止写入】的条目只用于避免矛盾，正文不得提前消费其中任何一条。`,
    ``,
    `【本章自检（写完后逐项自查，未通过就改）】`,
    `① 对手/妖兽的阶位必须与本章摘要一致；本章内不得无依据升级对手强度。`,
    `② 系统按本章剧情需要出场，不设次数配额；每次发言都应带来新信息或改变人物处境，纯播报式【】不要占多数。`,
    `③ 若出现未登记的具名角色/地点/妖兽，先停下并报告作者，不要直接写进正文。`,
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

// ── C1：写作方向（direction）的确定性提取与规范化 ────────────────────────────
// 与服务器 ai/direction.mjs 的 normalizeDirection 同口径（浏览器脚本无法 import 模块；
// 由 frontend-test.mjs 逐用例对照两侧）。硬边界：
//   · 纯函数：不调用模型、不写库、不产生副作用；相同输入输出完全相同；
//   · 只输出纯文本（不含 UI 控制字段、不输出完整 JSON）；≤400 个 Unicode 码点；
//   · 截断尽量落在字段或句子边界；direction 是**检索数据**，不是新批准的设定。
const WRITING_DIRECTION_MAX_CHARS = 400;
const WRITING_DIRECTION_FIELD_ORDER = ['references', 'scene_goal', 'conflicts', 'plot_points', 'character_changes', 'hook'];

function normalizeWritingDirectionText(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const chars = Array.from(s);
  if (chars.length > WRITING_DIRECTION_MAX_CHARS) s = chars.slice(0, WRITING_DIRECTION_MAX_CHARS).join('');
  return s;
}

// 截断尽量落在句子边界（句末标点）；找不到就在额度处硬截。
function clipWritingDirectionText(text, maxChars) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= maxChars) return chars.join('');
  let cut = maxChars;
  for (let i = maxChars - 1; i >= Math.max(0, maxChars - 80); i -= 1) {
    if (/[。！？!?；;]/.test(chars[i])) { cut = i + 1; break; }
  }
  return chars.slice(0, cut).join('');
}

/**
 * 从已确认/已保存的章节蓝图提取写作方向（纯文本）。
 * 优先级：references → scene_goal → conflicts → plot_points → character_changes → hook → fallback。
 * fallback 为本次用户要求或章节标题；两者都为空时返回空串（调用方走原召回规则）。
 */
function buildWritingDirectionFromBlueprint(blueprint, fallback = '') {
  const b = (blueprint && typeof blueprint === 'object' && !Array.isArray(blueprint)) ? blueprint : {};
  const pieces = [];
  let used = 0;
  for (const key of WRITING_DIRECTION_FIELD_ORDER) {
    const raw = b[key];
    if (raw === undefined || raw === null) continue;
    const text = String(Array.isArray(raw) ? raw.join('；') : raw).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const budget = WRITING_DIRECTION_MAX_CHARS - used - (pieces.length ? 1 : 0);
    if (budget <= 0) break;
    const clipped = clipWritingDirectionText(text, budget);
    pieces.push(clipped);
    used += Array.from(clipped).length + (pieces.length > 1 ? 1 : 0);
    if (Array.from(clipped).length < Array.from(text).length) break; // 已被截断：不再拼后续字段
  }
  if (!pieces.length) {
    const f = normalizeWritingDirectionText(fallback);
    if (f) pieces.push(f);
  }
  return normalizeWritingDirectionText(pieces.join(' '));
}

// 说明（2026-10-04）：这里原有 `savedBlueprintForChapter()` —— 写作入口用它判断"本章已有蓝图"
// 并据此**跳过蓝图轮**。作者报障后这条捷径被整个移除（每次点「AI 写作」都要先出蓝图），
// 函数随之删除，而不是留成无人调用的死代码（要回看这段历史见
// docs/blueprint-regenerate-20261004.md）。

// in-flight 键用的轻量方向哈希（FNV-1a，仅前端去重用；服务器缓存键用 sha256 前 16 位）。
function directionKeyHashOf(text) {
  const chars = Array.from(String(text || ''));
  let h = 2166136261;
  for (let i = 0; i < chars.length; i += 1) {
    h ^= chars[i].codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 说明（2026-10-06）：这里原有 `buildAIWritingContinuationPrompt` —— 成文不足目标字数时在
// **章尾**续写补足。作者反馈"AI 味"后复盘确认：按字数自动续写会把已经成立的章尾继续写下去，
// 是填充式 AI 腔的直接来源；真实漏写由质检 issues 驱动修复（改已有正文），不靠末尾追加。
// 函数随之删除，而不是留成无人调用的死代码。回归见 frontend-test.mjs「不再按字数自动补足」一组。

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
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch (_) { /* 走修复重试 */ }
  // 修复重试：模型常在字符串值末尾多吐一个引号，形成 `…文本。","},{"text":"…`
  // 这种非法 JSON。把「引号紧跟 , } ]」里的多余那一个去掉再试一次。
  const repaired = slice
    .replace(/"\s*,\s*"/g, '","')
    .replace(/"\s*,\s*([}\]])/g, '"$1');
  try { return JSON.parse(repaired); } catch (_) { return null; }
}

// 蓝图六个字段。判定"这是不是蓝图"与"抢救蓝图 JSON"都用同一份清单，
// 两处各写一份必然漂移（漂移的后果：抢救回来了、闸门却认不出）。
const BLUEPRINT_FIELDS = WRITING_DIRECTION_FIELD_ORDER;

/**
 * 章节蓝图解析（唯一入口）：先严格 JSON，失败再逐字段抢救。
 *
 * 为什么必须抢救（2026-10-01 真实事故）：模型在蓝图 JSON 的**字符串值里直接写了 ASCII 引号**
 * （`…却被告知自己是"符合条件的"——读者知道…`），严格解析必然失败；旧实现只做"多一个引号"的
 * 修引号重试，救不回这种情况，于是在调用点被当成"成文"整篇写进了章节正文
 * （第一章正文 1589 字全是 `【蓝图】{…}`，而 chapters.blueprint_json 反而为空）。
 *
 * 与审稿报告的 parseReviewText 同一条纪律：**结构化产物解析失败时不许降级成正文**，
 * 要么按字段抢救成对象，要么交由调用方报错，绝不落到"把 JSON 当小说"。
 *
 * @returns {{blueprint: object|null, stage: 'strict'|'salvaged'|'none'}}
 */
function parseBlueprintJSON(text) {
  const s = String(text || '').trim();
  if (!s) return { blueprint: null, stage: 'none' };
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const strict = extractJSONFromText(s.slice(start, end + 1));
    if (strict && typeof strict === 'object' && !Array.isArray(strict)) return { blueprint: strict, stage: 'strict' };
  }
  const body = start >= 0 ? s.slice(start) : s;
  const salvaged = {};
  for (const key of BLUEPRINT_FIELDS) {
    const val = salvageJSONString(body, key);
    if (val) salvaged[key] = val;
  }
  if (Object.keys(salvaged).length) return { blueprint: salvaged, stage: 'salvaged' };
  return { blueprint: null, stage: 'none' };
}

/**
 * 成文轮交付闸门（纯函数）：判定模型这次输出到底是"章节正文"还是"写作规划/蓝图"。
 *
 * 存在理由（2026-10-01 真实事故）：蓝图 JSON 解析失败时，parseAIWritingOutput 会把整篇
 * 蓝图原文兜底成 finalText，界面照常弹出「AI 写作结果」、点一下就把蓝图插进正文 ——
 * 全链路没有一处说"这不像正文"。更糟的是这条兜底路径**连蓝图的保存机会都跳过了**
 * （蓝图分支才 PUT chapter_blueprint），于是正文被污染、蓝图却是空的。
 *
 * 判据刻意收窄，只在"肯定不是正文"时拦：① 仍带着【蓝图】/【提问】过程头（正文里不会出现）；
 * ② 命中 ≥2 个蓝图专属字段名（`"scene_goal"` 这类 JSON 片段）。单个字段名可能是正文里的
 * 技术描写或引用，不构成拒绝理由 —— 宁可漏拦，不可误拦一篇真正文。
 *
 * @returns {string} 空串 = 通过；非空 = 拒绝原因（可直接展示给作者）
 */
function detectNonProseOutput(text) {
  const s = String(text || '');
  if (!s.trim()) return '输出为空';
  const head = s.trimStart().slice(0, 40);
  if (/^【(蓝图|提问)】/.test(head)) return '输出仍以【蓝图】/【提问】过程头开头，不是章节正文';
  if (/(^|\n)\s*【(蓝图|提问)】/.test(s.slice(0, 600))) return '输出里仍带着【蓝图】/【提问】过程头，不是章节正文';
  const hits = BLUEPRINT_FIELDS.filter((k) => s.includes(`"${k}"`) || s.includes(`「${k}」`) || s.includes(`${k}：`));
  if (hits.length >= 2) return `输出含蓝图字段（${hits.slice(0, 3).join('、')}）而非章节正文`;
  return '';
}

/**
 * 成文被闸门拦下后的一次重试提示词：把边界说到底，不给"再规划一遍"的空间。
 * 首行禁止以【开头，是为了让模型彻底离开"过程头 + 规划"的输出形态。
 */
function buildAIWritingProseRetryPrompt(reason, targetWords) {
  return [
    `你上一次的输出不是章节正文，而是写作规划：${reason}。`,
    `请**只输出本章正文本身**：不要【蓝图】/【提问】/【成文】等任何过程标记，不要输出任何 JSON、字段名、场景清单或写作说明；`,
    `第一个字就是正文的第一个字（可以是人物动作、对话或环境描写）。`,
    ``,
    `【篇幅要求】整章正文以纯文本计约 ${targetWords} 字（区间 ${Math.max(2000, targetWords - 1000)}～${targetWords + 1000} 字），把场景写足，不要交提纲或摘要。`
  ].join('\n');
}

/** 取一个 JSON 字符串值：value 内的裸引号不终止取值（以 `"` 后紧跟 , } ] 或 `"key":` 判定结束）。 */
function salvageJSONString(src, key) {
  const at = String(src).indexOf(`"${key}"`);
  if (at < 0) return '';
  let i = src.indexOf(':', at) + 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== '"') return '';
  i += 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i += 2;
      continue;
    }
    if (c === '"') {
      const rest = src.slice(i + 1).replace(/^[\s,]+/, '');
      // 结束判定：后面是 } 或 ]，或后面是 `"key":`（说明这个引号其实是分隔符）。
      // 形如 `…文本。","}` 的畸形尾巴里，这个引号是多余的 —— 丢掉它而不是收进正文。
      if (rest.startsWith('}') || rest.startsWith(']') || /^"[A-Za-z_]+"\s*:/.test(rest)) break;
      // 下一个非空字符又是引号：当前这个也是多余的，跳过。
      const next = src[i + 1];
      if (next === '"') { i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.trim().replace(/["']+$/, '');
}

/** 取某个数组字段下所有 {"text":"…"} 的文本；括号配对定界，不依赖严格 JSON。 */
function salvageJSONList(src, key) {
  const at = String(src).indexOf(`"${key}"`);
  if (at < 0) return [];
  const open = src.indexOf('[', at);
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end < 0 ? src.length : end);
  const out = [];
  let cursor = 0;
  for (;;) {
    const t = body.indexOf('"text"', cursor);
    if (t < 0) break;
    const val = salvageJSONString(body.slice(Math.max(0, t - 1)), 'text');
    if (val && !out.includes(val)) out.push(val);
    cursor = t + 6;
  }
  return out;
}

/**
 * 审稿报告解析（唯一入口）：先严格 JSON，失败再逐字段抢救。
 *
 * 为什么必须抢救：一轮审稿要跑几分钟，模型返回的 JSON 里只要多一个引号，
 * 严格解析就会失败、整份报告被丢弃（2026-09-14 真实事故：3.6 分钟的审稿报告
 * 因为 `…挪用。","},{"text":…` 里的多余引号而完全不可见）。
 *
 * @returns {{report: {summary,issues,strengths}|null, stage: 'strict'|'salvaged'|'raw'}}
 */
// 审稿报告里的 deferred（待后续核验）归一化：疑似伏笔/未知设定只提示、不判 issue，
// 因此它不是 issues 的一部分，也不会进入修稿清单（见 showReviewReport 的独立分区）。
function reviewDeferredItems(arr) {
  return (Array.isArray(arr) ? arr : []).map((x) => (x && typeof x === 'object'
    ? { text: String(x.text || ''), type: String(x.type || ''), recheck_within_chapters: Number(x.recheck_within_chapters) || 0 }
    : { text: String(x || ''), type: '', recheck_within_chapters: 0 })).filter((d) => d.text);
}

function parseReviewText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    let obj = null;
    try { obj = JSON.parse(slice); } catch (_) {
      // 修复重试：模型常在字符串值末尾多吐一个引号，形成 `…文本。","},{"text":"…`
      try { obj = JSON.parse(slice.replace(/"\s*,\s*"/g, '","').replace(/"\s*,\s*([}\]])/g, '"$1')); } catch (_) { obj = null; }
    }
    if (obj && (String(obj.summary || '').trim() || Array.isArray(obj.issues))) {
      return {
        stage: 'strict',
        report: {
          summary: String(obj.summary || ''),
          issues: Array.isArray(obj.issues) ? obj.issues.map((x) => String(typeof x === 'string' ? x : (x?.text || ''))).filter(Boolean) : [],
          strengths: Array.isArray(obj.strengths) ? obj.strengths.map((x) => String(typeof x === 'string' ? x : (x?.text || ''))).filter(Boolean) : [],
          deferred: reviewDeferredItems(obj.deferred)
        }
      };
    }
  }
  const body = start >= 0 ? s.slice(start) : s;
  const salvaged = {
    summary: salvageJSONString(body, 'summary'),
    issues: salvageJSONList(body, 'issues'),
    strengths: salvageJSONList(body, 'strengths'),
    deferred: reviewDeferredItems(salvageJSONList(body, 'deferred'))
  };
  if (salvaged.summary || salvaged.issues.length) return { stage: 'salvaged', report: salvaged };
  return { stage: 'raw', report: null };
}

/** 只要结构化报告对象（救不回来返回 null）。前端测试与外部调用用它，正常界面路径直接用 parseReviewText。 */
function extractReviewFromText(text) {
  return parseReviewText(text).report;
}

// 纯文本字数：与 wordCount 统一口径（都先剥 HTML 标签再去空白计数），避免成文长度与保存提示口径不一致（F-26）。
function plainLength(text) {
  return wordCount(text);
}

// 正文版本指纹（FNV-1a + 长度）：用于把"检查结果"绑到"具体哪份稿"。
// 只做版本同一性判断，不做安全哈希；任何字符改动都应导致指纹变化。
function contentHashOf(text) {
  const s = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${s.length}`;
}

// 篇幅状态（P0-1）：只诊断，不驱动生成。
//   ok                  —— 达到目标字数（或不设目标）。
//   short_but_complete  —— 比目标短，但没有"漏写必要情节"的证据：保留短稿。
//   missing_content     —— 比目标短，且质检明确指出漏写：交给作者决定是否扩写（不自动在章尾追加）。
function classifyChapterLength(article, targetWords, verdict) {
  const chars = plainLength(article);
  const target = Number(targetWords) || 0;
  if (!target || chars >= target) return { status: 'ok', chars, target, gap: 0 };
  const issues = (verdict && Array.isArray(verdict.issues)) ? verdict.issues : [];
  const missed = issues.some((x) => /遗漏|缺失|未写|未出现|未交代|漏掉|漏写|没有交代/.test(String(x)));
  return { status: missed ? 'missing_content' : 'short_but_complete', chars, target, gap: target - chars };
}

// 当前章节生效的目标字数：章节覆盖 > 作品默认 > 2000。
// `chapterId` 可显式传入：审稿/修稿这类流程在**入口**就把章号定死了（期间作者切章很正常），
// 现读 state.currentChapterId 会把别章的篇幅目标算进来。
function resolveTargetWords(chapterId = state.currentChapterId) {
  const chapter = state.chapters.find((c) => c.id === chapterId) || {};
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

// F-24：弹窗询问 AI 的一次追问（写作/生成共用的单函数，title/placeholder 参数化）。
function askAIQuestion(question, title = 'AI · 需要向你确认', placeholder = '直接回答 AI 的问题，它会继续追问，直到理解你的需求') {
  return new Promise((resolve) => {
    state.pendingAIQuestion = resolve;
    openModal({
      title,
      body: `
        <div class="ai-writing-question">${esc(question).replace(/\n/g, '<br>')}</div>
        <div class="field mt-12">
          <label>你的回答</label>
          <textarea id="ai-writing-answer" rows="3" placeholder="${esc(placeholder)}"></textarea>
        </div>`,
      footer: `
        <button class="btn secondary" data-close-modal>取消</button>
        <button class="btn secondary" data-action="ai-writing-skip">跳过提问直接生成</button>
        <button class="btn" data-action="ai-writing-answer">提交回答</button>`,
      // ⚠️ 点遮罩不关（2026-10-04 作者报障）：提问窗口里正等着他回答，鼠标一滑点到窗口外面就会
      // 被当成"取消"——整次写作随即中断（pending 被 resolve 成 null），而他什么都没表达。
      // 这类框的关闭必须走明确动作：右上角 ✕、或「取消」按钮。
      protectedBackdrop: true
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

// 确定性连续性预检的结果渲染（2026-09-22 报告 · 第 1 步）。
// 与上面的红线自检并列：两者都是**零 token**算出来的东西——红线管"词句"，
// 这里管"设定/篇幅/剧情线"。它不替代 AI 审稿，只是先把机器能判定的部分算掉。
// ⚠️ finding.key 由服务端算好随响应下发，前端**不重复实现键的拼法**：
//    两处实现必然漂移，而漂移的后果是"豁免点了不管用"（界面上看不出来）。
function continuityGuardSummaryHtml(guard, chapterId = null) {
  if (!guard) return '';
  const findings = Array.isArray(guard.findings) ? guard.findings : [];
  const exempted = Array.isArray(guard.exempted) ? guard.exempted : [];
  // ⚠️ 没给章号时只跑作品级的「剧情线推进」——不能写成"四项均未发现问题"，
  //    那是"缺判据却假装零命中"（坏预检比不跑更糟）。
  const chapterScoped = !!(guard.checked && guard.checked.chapterLabel);
  if (!findings.length && !exempted.length) {
    return chapterScoped
      ? '<div class="redline-scan ok">🔎 连续性预检通过：角色卡时点 / 系统出场 / 篇幅 / 剧情线均未发现问题</div>'
      : '<div class="redline-scan ok">🔎 连续性预检通过（未指定章节：本次只检查了剧情线推进）</div>';
  }
  const workId = Number(state.workId) || '';
  const chId = Number(chapterId) || '';
  const findingRow = (f) => `<div class="muted mt-4">· <span class="chip ${f.severity === 'warning' ? 'warn' : ''}">${esc(String(f.severity || 'info'))}</span> `
    + `${esc(String(f.message || ''))}`
    + `${f.suggestion ? `<div class="muted">建议：${esc(String(f.suggestion))}</div>` : ''}`
    + `<button class="btn small secondary" data-action="continuity-exempt" data-work-id="${workId}" data-chapter-id="${chId}"`
    + ` data-key="${esc(String(f.key || ''))}" title="记下「这是故意的」——改措辞或换章都不会让它复活">这是故意的</button></div>`;
  // 显示**当初那条话**（键只是内部标识，作者看不懂 `character:67`）；message 缺失时才退回键。
  // 恢复按钮同样带章号：刷新必须与列表同一口径，否则会算出别的章/空章号的条目（2026-09-22 复盘实测）。
  const exRows = exempted.map((f) => `<div class="muted mt-4">· 已忽略：${esc(String(f.message || f.key || ''))}`
    + `<button class="btn small secondary" data-action="continuity-restore" data-work-id="${workId}" data-chapter-id="${chId}"`
    + ` data-key="${esc(String(f.key || ''))}" title="${esc(String(f.key || ''))}">恢复</button></div>`).join('');
  const head = findings.length
    ? `<div class="redline-scan warn">🔎 连续性预检命中 ${findings.length} 条（零 token 算出，供参考；不必逐条改）：</div>`
    : (chapterScoped
      ? '<div class="redline-scan ok">🔎 连续性预检：本次正文没有新问题</div>'
      : '<div class="redline-scan ok">🔎 连续性预检：本次正文没有新问题（未指定章节：只检查了剧情线推进）</div>');
  return head + findings.map(findingRow).join('')
    + (exempted.length ? `<div class="muted mt-4">已忽略 ${exempted.length} 条：</div>${exRows}` : '');
}

/** 取一次预检结果（只读端点）。失败返回 null——**绝不阻塞**写作与审稿，只是少一层提示。 */
async function loadContinuityGuard(chapterId, text) {
  const workId = state.workId || (state.work && state.work.id) || null;
  if (!workId) return null;
  try {
    // text 传空串 = "用库里这一章的正文"（服务端口径：空串按没传处理）
    return await api('/novel/continuity_guard', {
      method: 'POST',
      body: { work_id: workId, chapter_id: Number(chapterId) || null, text: String(text == null ? '' : text) }
    });
  } catch (e) {
    reportClientLog({ level: 'warn', kind: 'continuity_guard_failed', message: `[预检] 不可用：${e.message}` });
    return null;
  }
}

/** 把预检结果渲染成**给 AI 审稿用的一段**（与红线扫描那段并排）。
 *  拿不到结果时返回空串 → 提示词里不会出现这一段（缺判据时不假装"零命中"）。 */
function buildContinuityGuardText(guard) {
  const findings = guard && Array.isArray(guard.findings) ? guard.findings : [];
  if (!guard) return '';
  if (!findings.length) return '零命中（角色卡时点 / 系统出场 / 篇幅 / 剧情线都没有算出问题）';
  return findings.slice(0, 12)
    .map((f) => `- [${f.severity}] ${f.message}${f.suggestion ? `（建议：${f.suggestion}）` : ''}`)
    .join('\n');
}

// 入账提案（headless 任务里 AI 提交的事件/记忆，未写入作品账本）渲染。
/**
 * 提案的**带类型引用**（2026-10-06）。
 *
 * 事件提案与长期记忆提案是两张表、各自独立的 id 序列，都从 1 开始 —— 只写裸 id 时，
 * "事件 #1"与"记忆 #1"在界面上、在请求体里都是同一个数字，服务端无从知道作者勾的是哪一条。
 * 真实事故：结果弹窗里 13 条事件提案 + 同号的 2 条记忆提案一起被卷进一次采纳，
 * 计数变成"达标 14/13"自相矛盾的值，整次采纳被回滚、**正文一个字都没写进去**。
 * 所以界面从源头就带上来源类型。
 */
function proposalRefOf(p) {
  const type = p && p.type === 'memory' ? 'memory' : 'event';
  const id = Number(p && p.id) || 0;
  return id ? `${type}:${id}` : '';
}

/** 勾选集合里的带类型引用（界面唯一读取点，三处调用共用）。 */
function collectCheckedProposalRefs(scope) {
  const root = scope || document;
  return [...root.querySelectorAll('.proposal-box [data-proposal-ref]:checked')]
    .map((el) => String(el.dataset.proposalRef || ''))
    .filter((r) => /^(event|memory):\d+$/.test(r));
}

/** 由带类型引用取裸 id 集合（让 legacy_proposal_ids 这条旧字段继续可用）。 */
function proposalIdsOfRefs(refs) {
  return [...new Set((Array.isArray(refs) ? refs : [])
    .map((r) => Number(String(r).split(':')[1]))
    .filter((n) => Number.isInteger(n) && n > 0))];
}

function proposalItemHtml(p) {
  const icon = p.type === 'memory' ? '🧠' : (p.kind === 'foreshadow' ? '🎯' : '📌');
  const kindLabel = p.type === 'memory' ? '长期记忆' : (p.kind === 'foreshadow' ? '伏笔' : '事件');
  const text = p.type === 'memory' ? (p.summary || p.delta || '') : p.summary || '';
  const source = p.type === 'memory' ? '记忆提案' : '事件提案';
  const impact = p.note || (p.type === 'memory' ? '会更新长期记忆摘要' : '会写入事件账本');
  const created = p.created_at ? formatWorkTime(p.created_at) : '时间未知';
  // data-proposal-ref 是新口径（带来源类型）；data-proposal-id 保留给旧断言/旧代码读。
  return `<label class="proposal-item"><input type="checkbox" data-proposal-id="${Number(p.id)}" data-proposal-ref="${proposalRefOf(p)}" checked>
    <span class="proposal-item-copy"><span><b>${icon} ${kindLabel}</b> <span class="chip">待确认</span></span>
      <span>${esc(String(text).slice(0, 180))}</span>
      <small class="muted">来源：${esc(source)} · 创建于 ${esc(created)} · 影响：${esc(impact)}</small>
    </span></label>`;
}

function proposalsSummaryHtml(proposals) {
  if (!Array.isArray(proposals) || !proposals.length) return '';
  return `<div class="proposal-box">
    <div class="proposal-head">📥 候选提案 · ${proposals.length} 条（尚未写入作品账本，需你逐条确认）：</div>
    ${proposals.map(proposalItemHtml).join('')}
    <div class="muted mt-4">取消勾选可暂时保留，稍后在「小说设定 → 长期记忆」页处理。</div>
  </div>`;
}

// 成文长度提示：只诊断，不再承诺"已自动补足"（P0-1 取消机械补字后必须如实）。
function articleLengthHint(article, targetWords, lengthStatus = null) {
  const n = plainLength(article);
  const target = Number(targetWords) || 2000;
  if (n >= target) {
    return `<div class="redline-scan ok">📏 成文 ${n} 字，达到目标 ${target} 字${n > target + 1000 ? '（略超，可自行精简）' : ''}</div>`;
  }
  const gap = target - n;
  const status = (lengthStatus && lengthStatus.status) || 'short_but_complete';
  if (status === 'missing_content') {
    return `<div class="redline-scan warn">⚠️ 成文 ${n} 字，距目标 ${target} 字还差 ${gap} 字，且质检指出有情节遗漏：建议用「扩写」补齐必要内容（改已有段落），不要靠章尾续写凑字数。</div>`;
  }
  return `<div class="redline-scan warn">📏 成文 ${n} 字，未达目标 ${target} 字（短 ${gap} 字）。已按"剧情完整即收笔"保留短稿，不再自动续写；如需加长，请点「扩写」并指明要展开的场面。</div>`;
}

// 待后续核验（deferred）：只告知作者"这里留了疑点/疑似伏笔，留给后面章节看"，
// **不**算问题、不进修复清单、不驱动任何改写——把疑似伏笔当问题删掉，正是第二轮要消除的失误。
function deferredNoteHtml(deferred) {
  const items = Array.isArray(deferred) ? deferred : [];
  const texts = items.map((d) => (typeof d === 'string' ? d : String((d && d.text) || ''))).filter(Boolean);
  if (!texts.length) return '';
  const shown = texts.slice(0, 5);
  return `<div class="redline-scan"><b>🕒 待后续核验（${texts.length} 条，不算问题、不驱动改写）</b><ul class="muted" style="margin:6px 0 0 18px">`
    + shown.map((x) => `<li>${esc(x)}</li>`).join('')
    + (texts.length > shown.length ? `<li>…等共 ${texts.length} 条</li>` : '')
    + '</ul></div>';
}

// 弹窗展示最终文章，让用户选择如何应用。
// jobId：这版文章来自哪条 harness 长任务。弹窗一打开就代表结果已经交到用户手里，
// 顺手把任务标记为已应用，恢复条才不会永远挂着「已完成，结果待应用」。
// ---------- 成文耗时账本（先测量后优化） ----------
// 为什么需要它：一次成文由「蓝图 → 成文 → 质检 → 补足」多轮模型往返组成，
// 只记一个总时长回答不了"时间到底花在哪一轮"，而"先测量后优化"要求分轮记账。
//
// ★ 两个口径必须分开看（混在一起就会得出错误结论）：
//   A 机器时间 = 点「AI 写本章」→ 草稿出现在结果弹窗（本对象的 total_ms）
//   B 交付时间 = 点「AI 写本章」→ 作者点「应用到正文」采纳
//                （= ai_eval_events 里同 draft_key 的 adopt.created_at − generate.created_at，
//                  由埋点表天然记下，不需要额外测量代码）
//
// 纪律：只测量、不干预。全部是 Date.now() 差值，不参与任何决策；
// 任何异常都在内部吞掉，绝不影响创作（与埋点同一条纪律）。
function newWriteTiming() {
  const startedAt = Date.now();
  const phases = [];
  const int = (v) => Math.max(0, Math.round(Number(v) || 0));
  return {
    /** 记一轮模型往返。extra 只放能自证成因的字段（通道 / 轮次 / TTFT / 字数）。 */
    round(name, ms, extra = {}) {
      try { phases.push({ name, ms: int(ms), ...extra }); } catch (_) { /* 测量失败静默 */ }
    },
    summary() {
      const byVia = (via) => phases.filter((p) => p.via === via).reduce((sum, p) => sum + p.ms, 0);
      const prose = phases.find((p) => p.name === 'prose' && p.ttft_ms != null);
      return {
        total_ms: Date.now() - startedAt,
        ttft_ms: prose ? prose.ttft_ms : null,
        rounds: phases.length,
        direct_ms: byVia('direct'),
        harness_ms: byVia('harness'),
        phases
      };
    }
  };
}

// ---------- AI 效果埋点（P5） ----------
// 契约的结构化不变量只能回答「预算有没有超、内容能不能查回」，回答不了
// 「上下文质量到底有没有变好」——那只能靠作者的真实行为：一次成文用不用得上、
// 要不要重生成、送进去多少字。这里只记行为与规模，**不记正文内容**。
// 埋点失败绝不影响创作（fire-and-forget）。
function recordAIEval(payload) {
  try {
    api('/ai/eval', { method: 'POST', body: payload }).catch(() => { /* 埋点失败静默 */ });
  } catch (_) { /* 同上 */ }
}

/** 本次生成送进模型的上下文字数（来自装配器的 context_stats）。 */
function aiEvalContextSize() {
  const ctx = state.aiContext;
  if (ctx && ctx.context_stats && Number.isFinite(ctx.context_stats.length)) return ctx.context_stats.length;
  return ctx && typeof ctx.assembled === 'string' ? ctx.assembled.length : 0;
}

function showAIWritingResult(article, scan, proposals, targetWords, jobId, meta = {}) {
  return new Promise((resolve) => {
    // 🗂 先落草稿再开弹窗：这版稿子此前只活在弹窗 state 里，
    // 用户点「先审稿再应用」或「取消」关闭弹窗就等于静默销毁（2026-09-14 真实事故）。
    // 落库后可在章节里「取回上一版生成稿」，关闭弹窗不再是丢失。
    // ⚠️ 章号优先取 meta.chapterId（任务自带的 chapter_id）：取回"别的章"的结果时，
    // 用 state.currentChapterId 会把草稿落到当前打开的那一章 —— 而「取回生成稿」是覆盖式写回，
    // 落错章等于给另一章埋了一颗地雷（2026-09-18 重审发现并修正）。
    const draftChapterId = Number(meta.chapterId) || state.currentChapterId;

    // ── P5 埋点：这次「生成」的规模与上下文成本 ──────────────────────────
    // 契约的结构化不变量回答不了「上下文质量有没有变好」，只有作者的真实行为能回答。
    // 只记行为与规模，不记正文内容。draftKey 把本次生成与它的采纳/丢弃串起来。
    const draftKey = `c${draftChapterId || 0}-${Date.now().toString(36)}`;
    const draftLen = String(article || '').length;
    const evalBase = { work_id: state.workId || null, chapter_id: draftChapterId || null, draft_key: draftKey };
    recordAIEval({
      ...evalBase, action: 'generate',
      channel: meta.channel || '', model: meta.model || '',
      chars_in: aiEvalContextSize(), chars_out: draftLen, ms: Number(meta.ms) || 0
    });
    // ⏱ 分轮耗时账（口径 A）：只记数字与枚举，不记正文（与埋点表同一条纪律）。
    // 口径 B（交付时间）不需要新增代码 —— 上面那条埋点的 draft_key 会和随后的
    // adopt 行配上，两个 created_at 相减就是"点了生成到采纳"的真实交付时间。
    if (meta.timing) {
      reportClientLog({
        level: 'info', kind: 'ai_write_timing',
        message: `[AI] 成文耗时 ${(meta.timing.total_ms / 1000).toFixed(1)}s`
          + `（${meta.timing.rounds} 轮模型往返：直连 ${(meta.timing.direct_ms / 1000).toFixed(1)}s / 慢通道 ${(meta.timing.harness_ms / 1000).toFixed(1)}s`
          + (meta.timing.ttft_ms != null ? `，首字 ${(meta.timing.ttft_ms / 1000).toFixed(1)}s` : '') + '）',
        context: {
          draft_key: draftKey,
          work_id: evalBase.work_id,
          chapter_id: evalBase.chapter_id,
          channel: meta.channel || '',
          model: meta.model || '',
          chars_in: aiEvalContextSize(),
          chars_out: draftLen,
          ...meta.timing
        }
      });
    }

    if (draftChapterId && String(article || '').trim()) {
      // 草稿落库是异步兜底，但**恢复条要跟着刷新**（2026-10-02 事故：草稿早在库里，
      // 界面却要手动刷新整页才显示"有未应用的生成稿"——render() 里的拉取有"每章只拉一次"闸门）。
      // 落库失败不影响主流程；恢复条刷新失败同样只影响提示。
      Promise.resolve(api('/novel/draft', { method: 'POST', body: { chapter_id: draftChapterId, content: article } }))
        .then(() => refreshChapterRecovery(draftChapterId))
        .catch(() => { /* 草稿落库失败不影响主流程，但会少一层兜底 */ });
    }
    if (jobId) {
      markJobApplied(jobId);
    }
    state.pendingAIFinal = (action) => {
      // 采纳 / 丢弃信号：三个「应用到正文」的动作算采纳；重新生成算丢弃。
      // 「先审稿再应用」不在此列——它会走审稿闭环，本次生成暂无结论（不计入采纳率分子）。
      const adopted = action === 'insert' || action === 'replace' || action === 'append';
      recordAIEval({
        ...evalBase,
        action: adopted ? 'adopt' : 'discard',
        channel: adopted ? action : (action === 'regenerate' ? 'regenerate' : 'closed'),
        chars_out: draftLen
      });
      resolve(action);
    };
    // chapterId 一起带上：随后可能的「先审稿再应用」→ 审稿 → 按清单修稿 → 差异合并，
    // 全链路都按这一章归属；否则作者在慢任务期间切章，修订稿会被合并进别的章。
    state.pendingAIArticle = { article, scan, proposals, targetWords, chapterId: draftChapterId };
    state.pendingAIProposals = Array.isArray(proposals) && proposals.length
      ? { workId: state.workId || state.work?.id || null, proposals }
      : null;
    // 新一轮结果 = 新一次勾选：清掉上一轮可能的暂存，避免"上一轮勾的提案"被本轮采纳。
    state.pendingProposalSelection = null;
    openModal({
      title: 'AI 写作结果',
      body: `
        <div class="ai-candidate-banner"><span class="chip">Candidate · 待确认</span><span class="muted">这份内容只是一版候选草稿，不会自动写入正文或故事状态。</span></div>
        <div class="ai-apply-preview">${esc(article).replace(/\n/g, '<br>')}</div>
        ${articleLengthHint(article, targetWords, meta.lengthStatus)}
        ${deferredNoteHtml(meta.deferred)}
        ${redlineScanSummaryHtml(scan)}
        <div id="continuity-guard-slot"></div>
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
    // 确定性连续性预检：正文还没落盘，所以把草稿文本传过去让服务端装配判据。
    // 与红线扫描同一处置口径——**失败不影响主流程**，只是少一层提示。
    // 异步填充而不是 await：预检是本地 SQLite 查询，通常几十毫秒，
    // 但不该让"能不能弹出结果"取决于预检可不可用。
    loadContinuityGuard(draftChapterId, article).then((guard) => {
      const slot = $('#continuity-guard-slot');
      if (slot && guard) slot.innerHTML = continuityGuardSummaryHtml(guard, draftChapterId);
    });
  });
}

// 把当前结果弹窗里勾选的提案提交为“采纳”；未勾选的保留待处理。
// R03：读取勾选集合必须发生在**弹窗还开着**的时候；结果弹窗关闭前会用
// captureProposalSelection() 把它固化到 state.pendingProposalSelection（供整次采纳使用）。
function captureProposalSelection() {
  const info = state.pendingAIProposals;
  if (!info || !info.workId) return null;
  const refs = collectCheckedProposalRefs(document);
  return { workId: Number(info.workId) || 0, refs, ids: proposalIdsOfRefs(refs) };
}

async function applySelectedProposals() {
  const info = state.pendingAIProposals;
  if (!info || !info.workId) return;
  state.pendingAIProposals = null;
  const refs = collectCheckedProposalRefs(document);
  const checked = proposalIdsOfRefs(refs);
  try {
    const data = await api('/novel/proposals/apply', { method: 'POST', body: { work_id: info.workId, ids: checked, refs } });
    const count = (data.applied?.events || 0) + (data.applied?.memories || 0);
    if (count) toast(`已采纳 ${count} 条入账提案`, 'success');
    else {
      // 零损失护栏拦下的提案必须说明**为什么**，否则作者只看到"提案没入账"，
      // 而提案仍留在待处理里——不知道原因就无从修正（第 2 步新增的拒绝路径）。
      // ⚠️ 字段可能不存在（旧服务端 / 未被拦）：只在真的有被拦项时才走这条分支。
      // ⚠️ toast 可见文案在 240 字处截断（完整内容挂在 title 悬停）——而 `reasons` 可能很长，
      //    所以先截原因再拼前缀，避免"缺失名单"被前缀挤到截断线之外，等于没说。
      const blocked = Array.isArray(data.guard_failed) ? data.guard_failed : [];
      if (blocked.length) {
        const why = blocked.map((g) => (g.reasons || []).join('；')).filter(Boolean).join(' ／ ');
        toast(`有 ${blocked.length} 条记忆提案未通过零损失护栏（已保留待处理，可修正后再采纳）：${why.slice(0, 180)}`, 'error');
      } else {
        toast('提案已保留，可稍后在「长期记忆」页处理');
      }
    }
  } catch (e) {
    toast('提案采纳失败：' + e.message, 'error');
  }
}

// ---------- 审稿 → 确认清单 → 修稿 → 差异合并 ----------
// S2（2026-09-18）：审稿**保持慢通道**，但把两样东西内联进提示词，抵消"慢通道才有"的优势：
//   ① 写作纪律（与人设同源，见 WRITING_DISCIPLINE）；
//   ② **确定性红线扫描结果**（/api/novel/scan）。实测慢通道的审稿报告里会出现「红线扫描零命中」
//      ——那是它调用 novel_scan 工具得到的确定性结论；直连通道没有工具，所以必须**预先算好喂进去**，
//      否则一旦改直连就会丢掉这条确定性判据（实测：直连审稿因思考吃光预算两次返回空，本就没跑通）。
// 把 `POST /api/novel/scan` 的结果渲染成提示词里的一段。
// ⚠️ 字段名以**服务端契约**为准：server.js 的 scanAgainstRedlines 返回
// `hits: [{ kind, pattern, note, count, sample }]` —— 没有 `word`。
// 2026-09-18 第四轮重审抓到的真实缺陷：这里曾读 `h.word`，于是提示词里出现
// 「命中 6 处：undefined×3、undefined×2」：模型拿不到任何真实红线词，却同时被要求
// "必须与扫描结果一致"——比不内联这段更糟（会诱导它编造）。同文件既有 UI
// （redlineScanSummaryHtml）用的就是 h.pattern，两处口径本应一致。
function buildRedlineScanText(scan) {
  const hits = (scan && Array.isArray(scan.hits)) ? scan.hits : [];
  const total = Number(scan && scan.total) || 0;
  if (!(total > 0) || !hits.length) return '零命中（这篇正文没有触发任何红线词句）';
  return `命中 ${total} 处：` + hits.slice(0, 12)
    .map((h) => `${h.pattern || h.note || '(未命名红线)'}×${h.count}`)
    .join('、');
}

function buildAIReviewPrompt(article, redlineScanText = '', continuityGuardText = '', targetWords = 0, opts = {}) {
  const segment = opts.segment || null;
  return [
    '你是严格的中文网络小说审稿编辑。请审读下面这篇章节正文，并对照小说上下文，输出 JSON 对象（不要 Markdown 代码块）：',
    '{"summary":"总评（两三句）","issues":[{"text":"问题描述，含位置（如：中段冲突部分）与理由，逐条可执行"}],"deferred":[{"text":"待后续核验的疑点（含位置）","type":"possible_foreshadowing","recheck_within_chapters":5}],"strengths":[{"text":"写得好的地方"}]}',
    'issues 覆盖：剧情逻辑/与既有设定冲突/人物言行一致/AI 腔与模板句/节奏与钩子/篇幅；strengths 1-3 条。',
    'deferred 是“待后续核验”通道：疑似伏笔、未知等级、暂未解释的异常、可能故意留下的缺口，写进 deferred，不要写进 issues；判不出“是伏笔还是假神秘”时也放这里，不要擅自判成问题、更不要建议删除。deferred 不会进入修稿清单。',
    // 叙述诊断项来自统一写作策略源（ai/writing/policy.mjs）。它们是**疑点提示**，不是正文禁令：
    // 只有能引用正文具体位置、且属于上面 issues 覆盖范围的问题才写进 issues。
    '叙述诊断项（只提示疑点，必须引用正文具体位置；判断不成立就不要写进 issues）：',
    ...writingPolicyLines('verify_fact', 'diagnostic'),
    ...writingPolicyLines('verify_style', 'diagnostic'),
    ...(segment ? [`本片范围：这是整章分段审稿的第 ${segment.ordinal} 片（target ${segment.segment_id}），只审这一片；` +
      '问题描述里的位置要写"本片第几段/哪一句"，不要报本片之外的判断。'] : []),
    // 2026-09-22：把篇幅的**权威口径**写进提示词（在此之前模型只能自己挑一把尺子，于是
    // work#18 第 5、6 章被反复报「篇幅不足」——AI 写作按本章目标 3000 字补足，审稿却按
    // 作品默认 4000 / 风格区间判）。这里给的是**与写作路径同源**的取值：章节覆盖 > 作品默认。
    ...(Number(targetWords) > 0 ? [`篇幅口径：本章目标 ${Number(targetWords)} 字（与写作路径同源）。`
      + '作品默认字数与风格文本里的区间只作参考——三者不一致时不要据此报"篇幅不足"，'
      + '只报相对本章目标的实际缺口或明显超出。'] : []),
    '',
    WRITING_DISCIPLINE,
    ...(redlineScanText ? ['', '【确定性红线扫描结果（工具给出，与你的判断并列）】', redlineScanText,
      '要求：AI 腔相关的问题必须与上面的扫描结果一致——扫描命中的要写进 issues 并指出位置；扫描零命中就不要臆造"存在 AI 腔命中"。'] : []),
    // 2026-09-22 报告 · 第 4 步：findings 作为**起始上下文**。
    // 与红线那段同一形态，但判据不同：红线管词句，这里管设定/篇幅/剧情线（零 token 算出来的）。
    // 措辞上把它定义成"已知事实"而不是"必须报"：模型可以否决（判据是字面统计，
    // 而作者要的是"有效出场"这类概念），但不该对此一无所知——这正是它作为起始上下文的价值。
    ...(continuityGuardText ? ['', '【确定性连续性预检结果（零 token 算出的已知事实，与你的判断并列）】', continuityGuardText,
      '要求：上面每一条都当作**已知事实**看待——你确认成立的，写进 issues 并指出它在正文的位置；'
      + '你判断不成立的（例如字面统计与"有效出场"的差异），不必写进 issues，但要在 summary 里用一句话说明为什么。'] : []),
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    ...(segment ? ['【本片上文/下文（context-only，仅供参考，不要审它们、也不要在 issues 里引用它们的文字）】',
      longTextContextBlock(segment), ''] : []),
    '【待审正文】',
    String(article || ''),
    '',
    '只输出 JSON。'
  ].join('\n');
}

// ⚠️ 下面是**整章重写**的提示词：输出≈整章长度，是修稿慢的主因（2026-09-18 实测 8 分 25 秒仍在生成）。
// 现在默认走 buildAIRevisionPatchPrompt（只输出要改的段落）；这个函数保留为**兜底路径**：
// 补丁解析失败或一条都没命中时回退到它，保证"改不动"和"改坏"之间还有一条熟路。
function buildAIRevisionPrompt(article, issues, opts = {}) {
  const segment = opts.segment || null;
  const list = (issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）';
  return [
    '你是资深中文网络小说修稿编辑。请按下面的“作者确认的问题清单”逐条修改正文；清单之外的内容尽量保持原样，不要擅自大改。',
    '只做最小改动：优先删除或合并低价值的重复证据、去掉含义已由动作或对白表达之后的总结句；高辨识度段落（人物独特的应答方式、从安慰自然转到日常关心的对白等）保持原样，不要改写成更完整、更煽情或更工整的版本。',
    '',
    '【作者确认的问题清单】',
    list,
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    ...(segment ? ['【本片上文/下文（context-only，禁止修改、禁止出现在输出里）】',
      longTextContextBlock(segment), ''] : []),
    '【待修正文】',
    String(article || ''),
    '',
    segment
      ? `请直接输出本片（target ${segment.segment_id}）修改后的完整正文（不要解释、不要输出前缀、不要输出 context-only 内容）。`
      : '请直接输出修改后的完整正文（不要解释、不要输出前缀）。'
  ].join('\n');
}

// 段落级 diff（LCS）：返回 [{t:'same'|'del'|'add', x}]，供差异预览渲染。
function diffParagraphs(oldText, newText) {
  const a = String(oldText || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const b = String(newText || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return diffTokens(a, b);
}

// 审稿主流程：审稿报告 → 确认清单 → 修稿 → 差异预览 → 合并。
async function runArticleReview(info) {
  // ⚠️ 章号在**入口**就定下来：后面每一步（审稿任务、报告落库、按清单修稿、差异合并）
  // 都用它，而不是每次现读 state.currentChapterId —— 审稿+修稿合计几分钟，
  // 期间作者切章是完全正常的操作，现读会把后续所有写操作挪到另一章上。
  const reviewChapterId = Number(info && info.chapterId) || Number(state.currentChapterId) || null;
  // 空正文不审稿：审查一篇空章是"必花钱、必无意义"（报告只会是"未发现问题"），
  // 而"接回进度"这条路上 info.article 可能因为取不到正文而为空（第四轮改动引入的新可能）。
  if (!String(info && info.article || '').trim()) {
    toast('没有拿到这一章的正文，未发起审稿：请切到该章确认正文已保存后重试', 'error');
    return;
  }
  // R08 草稿链（AI 写作结果 →「先审稿再应用」）：差异里的"原文"是草稿，不是章节正文。
  // 合并闸门保护的对象始终是章节正文 —— 所以在这里先固化一份正文指纹，
  // 合并时核对"正文在整个审稿/修稿期间没被动过"；拿草稿去和正文比指纹永远不相等。
  let baseChapterFingerprint = null;
  if (info && info.fromDraft && reviewChapterId) {
    try { baseChapterFingerprint = textFingerprint(await revisionBaseArticle(reviewChapterId)); } catch (_) { baseChapterFingerprint = null; }
  }
  const jobBase = {
    timeout: longAiTimeout(),
    // 质量优先：审稿报告决定后续修稿方向。2026-09-18 起"质量优先"由思考强度表达
    // （模型与快档同为 V4.1 Flash，见 ai/policy.mjs 文件头决策）。
    model: policyModel('quality'),
    reasoning_effort: policyEffortForTier('quality') || undefined,
    action: 'write',
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: reviewChapterId || undefined,
    mode: 'full',
    // 归属标记：刷新/重启后据此把产出送回正确的「审稿」处理路径。
    kind: 'review',
    stage: 'AI 审稿'
  };
  try {
    // S2：先把**确定性红线扫描**算出来（与 harness 的 novel_scan 工具同源，都是服务端 scanAgainstRedlines），
    // 再连同写作纪律一起内联进审稿提示词。扫描失败不阻塞审稿（只是少一条判据，且提示词里不会出现该段）。
    let redlineScanText = '';
    try {
      const scan = await api('/novel/scan', {
        method: 'POST',
        body: { work_id: state.workId || state.work?.id || null, text: info.article, skip_dialogue: true }
      });
      redlineScanText = buildRedlineScanText(scan);
    } catch (e) {
      reportClientLog({ level: 'warn', kind: 'redline_scan_failed', message: `[审稿] 红线扫描不可用：${e.message}` });
    }
    // 第二条零 token 判据（报告第 1 步 + 第 4 步）：连续性预检的结果与红线扫描并排进提示词。
    // 顺序有讲究：**先算免费的，再交给付费的**——审稿一次要等几分钟且计费，
    // 让模型去数"系统出现几次""这章多少字"既是浪费，也不可靠（它会算错）。
    const guard = await loadContinuityGuard(reviewChapterId, info.article);
    const continuityGuardText = buildContinuityGuardText(guard);
    // 篇幅的权威口径随章一起定下来（章号在入口已定死，这里按同一个章号解析目标字数）。
    const reviewTargetWords = resolveTargetWords(reviewChapterId);
    // R08：整章审稿不再截断到 12000 字。超限按片审、合并报告（每条问题带片号），
    // 覆盖清单不通过就不出报告（缺片/解析失败可见、可续跑）。
    const reviewRun = await longTextRunTask('review', {
      text: info.article, chapterId: reviewChapterId, targetWords: reviewTargetWords,
      redlineScanText, continuityGuardText, singleRunByCaller: true,
      currentText: () => (Number(state.currentChapterId) === Number(reviewChapterId)
        ? longTextLiveEditorText(info.article)
        : info.article),
      onProgress: (plan, results) => {
        const el = $('#ai-task-progress');
        if (el) { el.hidden = false; el.textContent = `长正文分段审稿：${results.filter((r) => r.status === 'done').length} / ${plan.segments.length} 片完成…`; }
      }
    });
    if (reviewRun.mode === 'segmented') {
      const el = $('#ai-task-progress');
      if (el) el.hidden = true;
      if (!reviewRun.merged || !reviewRun.report) {
        showLongTextIncomplete('审稿', reviewRun, () => runArticleReview(info));
        return;
      }
      const mergedReport = reviewRun.report;
      if (reviewChapterId) {
        try {
          const saved = await api('/novel/review', {
            method: 'PUT',
            body: { chapter_id: reviewChapterId, report: mergedReport, raw_text: '', status: 'parsed' }
          });
          mergedReport.review_id = saved.review_id;
        } catch (_) { /* 保存失败不阻塞审稿流程 */ }
      }
      state.pendingReview = { info: { ...info, chapterId: reviewChapterId, baseChapterFingerprint }, review: mergedReport };
      showReviewReport(mergedReport);
      toast(`整章分 ${reviewRun.plan.segments.length} 片审完：覆盖清单通过（首段/尾段/章尾哨兵齐全，问题均带片号）`, 'success');
      return;
    }
    const reviewData = await runHarnessJob(
      { ...jobBase, prompt: buildAIReviewPrompt(info.article, redlineScanText, continuityGuardText, reviewTargetWords), kind: 'review', stage: 'AI 审稿' },
      'AI 审稿 · 正在通读全文并生成审稿报告…'
    );
    const rawOutput = String(reviewData.output || '');
    // 容错解析：模型返回的 JSON 常有裸引号等瑕疵，严格解析失败不再等于整份报告作废。
    let { stage, report } = parseReviewText(rawOutput);
    if (!report) {
      const alt = parseReviewText(parseAIWritingOutput(rawOutput).finalText || '');
      stage = alt.stage;
      report = alt.report;
    }
    const parsedOK = !!report;
    if (!report) report = { summary: '', issues: [], strengths: [] };
    if (reviewChapterId) {
      try {
        // 解析成功存结构化报告；解析失败把原文一起存下（状态 raw），保证几分钟的等待一定有产物可回看。
        const saved = await api('/novel/review', {
          method: 'PUT',
          body: {
            chapter_id: reviewChapterId,
            report,
            raw_text: parsedOK ? '' : rawOutput.slice(0, 200000),
            status: parsedOK ? 'parsed' : 'raw'
          }
        });
        report.review_id = saved.review_id;
      } catch (_) { /* 保存失败不阻塞审稿流程 */ }
    }
    if (!parsedOK) {
      toast('审稿报告格式异常，已保存原文供回看（可在章节里点「查看上次审稿」）', 'error');
      // 解析失败也已在 chapter_reviews 存了原文，任务产出已归档 → 标记已应用，恢复条不再重复提示。
      markJobApplied(reviewData && reviewData.job_id);
      return;
    }
    // 抢救出来的报告要主动说明，避免用户以为 AI 真的漏报了几条。
    if (stage === 'salvaged') toast('审稿报告格式有瑕疵，已尽力抢救出可读部分（可能少一两条）', 'error');
    markJobApplied(reviewData && reviewData.job_id);
    state.pendingReview = { info: { ...info, chapterId: reviewChapterId, baseChapterFingerprint }, review: report };
    showReviewReport(report);
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
      ${(review.deferred || []).length ? '<div class="ref-group-title">待后续核验（不算问题，不会进入修稿清单）</div>' + review.deferred.map((d) => {
        const text = String((d && d.text) || d);
        const type = String((d && d.type) || '');
        const recheck = Number(d && d.recheck_within_chapters) || 0;
        return '<div class="review-item muted">🕒 ' + esc(text)
          + (type ? ' <span class="chip">' + esc(type) + '</span>' : '')
          + (recheck ? ' <span class="muted">建议 ' + recheck + ' 章内核验</span>' : '')
          + '</div>';
      }).join('') : ''}
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
  // ⚠️ 一条都没勾选就**不要发起任何调用**：重审发现早先这一检查放在"补丁调用之后"的回退分支里，
  // 于是作者把勾全取消后，仍然先跑了一次付费的修稿调用，再告诉他"没有勾选任何问题"。
  // 付费动作之前必须先做前置校验（与"AI 写作"先弹确认框同一条纪律）。
  if (!confirmed.length) {
    closeModal();
    toast('没有勾选任何问题，未发起修稿', 'error');
    return;
  }
  // ⚠️ 底稿为空同样不能发起调用（第四轮改动引入的新可能：'接回进度/查看上次审稿'这条路上，
  // 取目标章正文失败会让 info.article 为空）。空底稿的修稿是"必花钱、必无用"——
  // 模型拿不到待修正文，anchor 一条也命中不了，只会白等几分钟。
  if (!String(info && info.article || '').trim()) {
    closeModal();
    toast('没有拿到这一章的正文，未发起修稿：请切到该章确认正文已保存后重试', 'error');
    return;
  }
  closeModal();
  // 章号跟着**审稿那一章**走（info.chapterId 由 runArticleReview 写入）：
  // 修稿跑几分钟，期间切章不该改变这次修稿的归属。
  const revisionChapterId = Number(info && info.chapterId) || Number(state.currentChapterId) || null;
  const jobBase = {
    timeout: longAiTimeout(),
    // 质量优先：这一步直接产出修好的正文，是交付物本身 —— 由思考强度表达（同 V4.1 Flash）。
    model: policyModel('quality'),
    reasoning_effort: policyEffortForTier('quality') || undefined,
    action: 'write',
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: revisionChapterId || undefined,
    mode: 'full'
  };
  try {
    // R08：整章修稿不再截断到 12000 字；超限按片改（补丁锚点只能取自本片），
    // 覆盖清单通过且源版本匹配才进入差异预览。任一必需片失败 → 不出部分结果。
    const revisionRun = await longTextRunTask('revision_patch', {
      text: info.article, chapterId: revisionChapterId, issues: confirmed, singleRunByCaller: true,
      currentText: () => (Number(state.currentChapterId) === Number(revisionChapterId)
        ? longTextLiveEditorText(info.article)
        : info.article),
      onProgress: (plan, results) => {
        const el = $('#ai-task-progress');
        if (el) { el.hidden = false; el.textContent = `长正文分段修稿：${results.filter((r) => r.status === 'done').length} / ${plan.segments.length} 片完成…`; }
      }
    });
    if (revisionRun.mode === 'segmented') {
      const el = $('#ai-task-progress');
      if (el) el.hidden = true;
      const retryPatch = () => { state.pendingReview = { info, review }; refineByChecklist(); };
      if (!revisionRun.merged) {
        showLongTextIncomplete('修稿（按段）', revisionRun, retryPatch, {
          label: '改用整片重写（更慢、更贵）',
          handler: () => refineLongTextFull(info, review)
        });
        return;
      }
      const unresolvedNotes = (revisionRun.results || [])
        .filter((r) => r.extra && r.extra.unresolved)
        .map((r) => `${r.segment_id}：${r.extra.unresolved} 处未能定位`);
      const appliedCount = (revisionRun.results || []).reduce((n, r) => n + ((r.extra && r.extra.applied) || 0), 0);
      // 安全门禁的分片结论：被拦下的补丁**不在** merged 里，这里把它们收集起来交给差异预览。
      const blockedAll = (revisionRun.results || []).flatMap((r) => (r.extra && Array.isArray(r.extra.blockedList) ? r.extra.blockedList : []));
      const blockedCount = (revisionRun.results || []).reduce((n, r) => n + ((r.extra && r.extra.blocked) || 0), 0);
      const findingsAll = (revisionRun.results || []).flatMap((r) => (r.extra && Array.isArray(r.extra.findings) ? r.extra.findings : []));
      if (appliedCount === 0 && !unresolvedNotes.length) {
        toast(blockedCount
          ? `本次有 ${blockedCount} 处改动被安全门禁拦下（未自动应用），正文保持原样`
          : '模型判断这份清单没有需要改动的段落（本次未改动正文，也未回退整章重写）', blockedCount ? 'error' : 'success');
        longTextClearRun();
        return;
      }
      showReviewDiff(info.article, revisionRun.merged, {
        baseFingerprint: info.baseChapterFingerprint || null,
        checklist: confirmed.length,
        applied: appliedCount,
        notes: unresolvedNotes,
        chapterId: revisionChapterId,
        blocked: blockedAll,
        findings: findingsAll
      });
      toast(`整章分 ${revisionRun.plan.segments.length} 片改稿：共改 ${appliedCount} 处${unresolvedNotes.length ? `；${unresolvedNotes.length} 片有未能定位的问题` : ''}`,
        unresolvedNotes.length ? 'error' : 'success');
      longTextClearRun();
      return;
    }
    const refinedData = await runHarnessJob(
      { ...jobBase, prompt: buildAIRevisionPatchPrompt(info.article, confirmed), kind: 'revision', stage: 'AI 修稿' },
      'AI 修稿 · 正在按确认清单逐段修改…'
    );
    const raw = refinedData.output || '';
    // 首选补丁式（只改相关段落，快）；解析不到/一条都没命中 → 回退整章重写（慢但熟路）。
    const patched = tryApplyRevisionOutput(raw, info.article, patchSafetyOptions(revisionChapterId));
    if (patched && patched.ok) {
      // 空补丁 = 合法的"无修改"：不弹差异预览、**不回退整章重写**（不再多花一次钱）。
      if (patched.noop) {
        toast('模型判断这份清单没有需要改动的段落（本次未改动正文，也未回退整章重写）', 'success');
        markJobApplied(refinedData && refinedData.job_id);
        return;
      }
      // 全部被安全门禁拦下：正文原样保留，并且**不回退整章重写**（那是一次付费且无门禁的整章覆盖）。
      if (patched.allBlocked) toast('这一版修稿的高风险改动全部被安全门禁拦下（未改动正文），原因见差异预览', 'error');
      showReviewDiff(info.article, patched.text, {
        baseFingerprint: info.baseChapterFingerprint || null,
        checklist: confirmed.length,
        applied: patched.applied.length,
        notes: patched.unresolved.map((u) => u.reason + '：' + (u.anchor || '').slice(0, 40)),
        chapterId: revisionChapterId,
        blocked: patched.blocked,
        findings: patched.findings
      });
      markJobApplied(refinedData && refinedData.job_id);
      if (!patched.allBlocked) {
        toast(patched.unresolved.length ? `已改 ${patched.applied.length} 处；${patched.unresolved.length} 处未能定位` : `已按清单改好 ${patched.applied.length} 处`, patched.unresolved.length ? 'error' : 'success');
      }
      return;
    }
    // 回退：整章重写（已确认清单非空，前面统一校验过）。
    // ⚠️ 这条路径没有补丁可以过门禁，所以改成**修后核验**（只报告）：把删出来的结构断裂如实列给作者。
    toast('按段修改没能解析出可用补丁，已回退整章重写（会慢一些）', 'error');
    const fullData = await runHarnessJob(
      { ...jobBase, prompt: buildAIRevisionPrompt(info.article, confirmed), kind: 'revision', stage: 'AI 修稿（整章）' },
      'AI 修稿 · 正在按确认清单修改…'
    );
    const revised = parseAIWritingOutput(fullData.output || '').finalText || '';
    if (!revised.trim()) throw new Error('修稿结果为空');
    showReviewDiff(info.article, revised, {
      checklist: confirmed.length, chapterId: revisionChapterId, baseFingerprint: info.baseChapterFingerprint || null,
      findings: patchSafetyVerify(info.article, revised, patchSafetyOptions(revisionChapterId)),
    });
    markJobApplied(fullData && fullData.job_id);
  } catch (e) {
    if (!e.cancelled) toast('修稿失败：' + e.message, 'error');
  }
}

// ---------- 修稿（补丁式）：只改被勾选的问题涉及的段落 ----------
// 为什么改成补丁式：整章重写要让模型把 5000+ 字原样吐一遍，输出长度≈章节长度，
// 时间与费用都花在"抄写没问题的段落"上。补丁式只输出需要改的段落（通常几百字）。
// 代价是引入"定位"这一步——所以设计上强制：**定位不到必须可见**（进 unresolved 清单），
// 且解析失败时回退整章重写（见 refineByChecklist）。
function buildAIRevisionPatchPrompt(article, issues, opts = {}) {
  const segment = opts.segment || null;
  const list = (issues || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）';
  return [
    '你是资深中文网络小说修稿编辑。**只修改下面「作者确认的问题清单」涉及的段落**，其它段落一个字都不要动、也不要输出。',
    '',
    '【作者确认的问题清单】',
    list,
    '',
    '【当前小说上下文】',
    aiContextBlock() || '无',
    '',
    ...(segment ? ['【本片上文/下文（context-only，禁止修改、禁止出现在输出里）】',
      longTextContextBlock(segment), ''] : []),
    '【待修正文】',
    String(article || ''),
    '',
    '只输出一个 JSON 对象，不要 Markdown 代码块、不要解释、不要任何前后缀：',
    '{"patches":[{"issue":1,"anchor":"原文段落（逐字照抄，含标点，不要改动一个字）","revised":"改好后的段落"}]}',
    '规则：',
    '1. 一处改动一条 patch；同一段落有多条问题时合并为一条。',
    '2. anchor 必须能在【待修正文】里**原样找到**（逐字复制整段），否则这条修改会作废。',
    '3. revised 只写改后的段落本身，不要编号、不要解释、不要引号包裹。',
    '4. 某条问题不需要改动就不必为它输出 patch；没有要改的就输出 {"patches":[]}。',
    '5. 只做最小改动：优先删除或合并低价值的重复证据、去掉含义已由动作或对白表达之后的总结句，不要顺手润色高辨识度段落（人物独特的应答方式、从安慰自然转到日常关心的对白等），也不要把它们改写成更完整、更煽情或更工整的版本。',
    ...(segment ? ['6. patch 的 anchor 只能在【待修正文】（target ' + segment.segment_id + '）里取；不要把上文/下文（context-only）的段落当成 anchor。'] : [])
  ].join('\n');
}

/** 解析补丁输出：严格 JSON → 抢救（沿用审稿报告的引号容错思路）→ 失败返回 null。 */
function parseRevisionPatches(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const pick = (obj) => {
    const arr = Array.isArray(obj && obj.patches) ? obj.patches : null;
    if (!arr) return null;
    const patches = [];
    for (const p of arr) {
      const anchor = String((p && (p.anchor ?? p.original ?? p.old)) || '').trim();
      const revised = String((p && (p.revised ?? p.replacement ?? p.new)) || '').trim();
      if (anchor) patches.push({ issue: Number(p && p.issue) || 0, anchor, revised });
    }
    return patches;
  };
  const strict = extractJSONFromText(text);
  const viaStrict = strict ? pick(strict) : null;
  if (viaStrict) return viaStrict;
  // 抢救：模型常在字符串值末尾多吐一个引号（`…文本。","next"`）——与审稿报告同一类瑕疵。
  // 按 "anchor" 出现位置切块，块内用与审稿报告同源的 salvageJSONString 取值。
  const patches = [];
  const idxs = [];
  for (let i = text.indexOf('"anchor"'); i >= 0; i = text.indexOf('"anchor"', i + 1)) idxs.push(i);
  for (let k = 0; k < idxs.length; k++) {
    const seg = text.slice(idxs[k], k + 1 < idxs.length ? idxs[k + 1] : text.length);
    const anchor = salvageJSONString(seg, 'anchor').trim();
    const revised = salvageJSONString(seg, 'revised').trim();
    if (anchor) patches.push({ issue: 0, anchor, revised });
  }
  return patches.length ? patches : null;
}

/**
 * 把补丁应用到正文。逐段匹配（先精确、再"包含"退让），**命中才改**。
 * 返回 { text, applied, unresolved }：unresolved 必须展示给作者，绝不静默丢弃。
 *
 * 2026-09-27 边界加固（R02.3）：
 *   · **唯一性**：同一 anchor 在正文里逐字相等出现多段时，拒绝改动（旧实现静默命中第一处，
 *     可能把补丁打到错误的段落上）；包含式退让同样要求唯一命中。
 *   · **重叠**：两条补丁指向同一段时显式进 unresolved（旧实现被 `used` 静默跳过，
 *     作者只看到"改好了 1 处"，不知道另一条被吞掉）。
 */
function applyRevisionPatches(article, patches) {
  // ⚠️ 定位一律在**原始段落**上做：补丁的 anchor 是对着生成时那一版正文写的，
  // 若在"已被前一条补丁改过的中间态"上继续找，第二条重叠补丁就会得到
  // "找不到原文"这种误导性结论（应为"与前面的补丁指向同一段"）。
  const paras = String(article || '').split(/\n{2,}/);
  const original = paras.slice();
  const used = new Set();
  const applied = [];
  const unresolved = [];
  const norm = (s) => String(s || '').trim();
  for (const p of patches || []) {
    const anchor = norm(p.anchor);
    const revised = norm(p.revised);
    if (!anchor || !revised) {
      unresolved.push({ issue: p.issue, anchor, reason: !anchor ? '缺 anchor（无法定位）' : '缺 revised（改后内容为空）' });
      continue;
    }
    // ① 精确匹配：收集**全部**逐字相等的段落 —— 唯一才允许改。
    const exact = [];
    for (let i = 0; i < original.length; i++) {
      if (norm(original[i]) === anchor) exact.push(i);
    }
    let idx = -1;
    if (exact.length === 1) {
      idx = exact[0];
    } else if (exact.length > 1) {
      unresolved.push({
        issue: p.issue, anchor,
        reason: `重复 anchor：正文里有 ${exact.length} 段完全相同，无法唯一确定要改哪一段（已保持原样，请手工处理）`,
        duplicateCount: exact.length,
      });
      continue;
    } else if (anchor.length >= 8) {
      // ② 退让一步：模型可能多抄/少抄了首尾标点。只在 anchor 足够长时才允许，且**必须唯一命中**。
      const candidates = [];
      for (let i = 0; i < original.length; i++) {
        if (norm(original[i]).includes(anchor)) candidates.push(i);
      }
      if (candidates.length === 1) idx = candidates[0];
      else if (candidates.length > 1) {
        unresolved.push({
          issue: p.issue, anchor,
          reason: `包含型 anchor 命中 ${candidates.length} 段（非唯一），拒绝猜测要改哪一段`,
          ambiguousCount: candidates.length,
        });
        continue;
      }
    }
    if (idx < 0) { unresolved.push({ issue: p.issue, anchor, reason: '在正文里找不到这段原文' }); continue; }
    // ③ 重叠：同一段被两条补丁认领 → 显式报告，不做二次覆盖。
    if (used.has(idx)) {
      unresolved.push({
        issue: p.issue, anchor,
        reason: `与前面的补丁指向同一段（第 ${idx + 1} 段）——重叠补丁已拒绝，未做二次覆盖`,
        overlap: true,
      });
      continue;
    }
    used.add(idx);
    paras[idx] = revised;
    applied.push({ issue: p.issue, anchor, revised, paraIndex: idx });
  }
  return { text: paras.join('\n\n'), applied, unresolved };
}

/**
 * 修稿安全门禁的接入层（Safe Editing，第三批）。
 *
 * 为什么需要：applyRevisionPatches 只回答"这条补丁**能不能定位**"，不回答"**该不该自动应用**"。
 * 于是"删掉王磊递面包 → 后文面包凭空出现""删掉首次人物主体 → 后面的'她'没有先行语"
 * "删掉'大屏切到海澜市' → 读者不知道在看现场还是屏幕""为一个轻度时间疑问顺手新增整套 B 区支线"
 * 这些改动会被原样应用——每一处单看都更简洁，合起来把原本成立的小说修坏。
 *
 * 分工写在两处：
 *   · 判据与词表全在 public/patch-safety.js（纯函数、零依赖、浏览器与 Node 测试共用，同 long-text.js）；
 *   · 本层只做接线（取参数 / 调用 / 出错时放行并说明）+ 把结论交给差异预览。
 * 失败姿态是**放行**：门禁模块缺失或抛错时绝不阻塞作者的正常修稿，但会在预览里明说
 * "本次没有任何补丁被拦截"——静默降级才是真正危险的那种失败。
 */
function patchSafetyEngine() {
  return (typeof globalThis !== 'undefined' && globalThis.NovelPatchSafety) || null;
}

/** 本章生效的门禁参数：人物名（先行语判定用）+ 作者指定的保护句。 */
function patchSafetyOptions(chapterId) {
  const opts = { protectedContent: [] };
  try {
    const names = (state.characters || []).map((c) => String((c && c.name) || '').trim()).filter(Boolean);
    if (names.length) opts.characters = names;
  } catch (_) { /* 没有人物卡时只按通用主体名词判定 */ }
  // 保护句（文档 §13）：作者可写 localStorage —— 作品级 `ns_protected_content:<workId>`、
  // 章节级 `ns_protected_content:<workId>:<chapterId>`，值形如 ["我信A级存在。没说你。", …]。
  // 本批不新增界面入口（授权范围只有确定性安全层），但机制是真的、能生效、有回归覆盖。
  try {
    const cid = Number(chapterId) || Number(state.currentChapterId) || 0;
    const wid = Number(state.workId || (state.work && state.work.id)) || 0;
    const read = (key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
    };
    opts.protectedContent = [...read(`ns_protected_content:${wid}`), ...read(`ns_protected_content:${wid}:${cid}`)];
  } catch (_) { opts.protectedContent = []; }
  return opts;
}

/** 门禁：把不可自动应用的补丁摘出来（不修改调用方传入的任何数据）。 */
function patchSafetyGate(baseArticle, patches, safetyOpts) {
  const K = patchSafetyEngine();
  const all = Array.isArray(patches) ? patches : [];
  if (!K || typeof K.gatePatches !== 'function') {
    return {
      allowed: all,
      allowedMeta: all.map((p, index) => ({ index, issue: Number(p && p.issue) || 0, scope: null, risks: [] })),
      blocked: [],
      findings: [{ index: -1, issue: 0, code: 'safety_unavailable', reason: '安全门禁模块未加载：本次没有任何补丁被拦截（这一版需要人工复核）' }],
    };
  }
  try {
    const g = K.gatePatches(baseArticle, all, safetyOpts || {});
    return {
      allowed: Array.isArray(g.allowed) ? g.allowed : all,
      allowedMeta: Array.isArray(g.allowedMeta) ? g.allowedMeta : [],
      blocked: Array.isArray(g.blocked) ? g.blocked : [],
      findings: Array.isArray(g.findings) ? g.findings : [],
    };
  } catch (e) {
    return {
      allowed: all,
      allowedMeta: all.map((p, index) => ({ index, issue: Number(p && p.issue) || 0, scope: null, risks: [] })),
      blocked: [],
      findings: [{ index: -1, issue: 0, code: 'safety_unavailable', reason: `安全门禁执行出错（${e && e.message ? e.message : e}）：本次没有任何补丁被拦截` }],
    };
  }
}

/** Diff-aware 修后核验（文档 §12）：这一版新文里还剩哪些结构断裂——只报告，不拦阻。 */
function patchSafetyVerify(baseArticle, patchedArticle, safetyOpts) {
  const K = patchSafetyEngine();
  if (!K || typeof K.verifyPatchedText !== 'function') return [];
  try {
    const v = K.verifyPatchedText(baseArticle, patchedArticle, safetyOpts || {});
    return (v && Array.isArray(v.findings)) ? v.findings : [];
  } catch (_) { return []; }
}

/** 差异预览里的"安全门禁"分区：被拦下的补丁（含原因与被拦原文）+ 修后核验的断裂。 */
function patchSafetyNotesHtml(blocked, findings) {
  const bs = Array.isArray(blocked) ? blocked : [];
  const fs = Array.isArray(findings) ? findings : [];
  if (!bs.length && !fs.length) return '';
  const blockedHtml = bs.map((b) => `<div class="review-item issue">⛔ 未自动应用：${esc(String((b && b.reason) || ''))}`
    + `<div class="muted">被拦下的原文：${esc(String((b && b.anchor) || '').slice(0, 50))}</div></div>`).join('');
  const findHtml = fs.map((f) => `<div class="review-item muted">⚠️ ${esc(String((f && f.reason) || ''))}</div>`).join('');
  return `<div class="ref-group-title">安全门禁（这些改动没有进这一版正文）</div>${blockedHtml}${findHtml}`;
}

/**
 * 修稿产出的统一入口：先按补丁解析，成功就返回改好的正文；否则返回 null（调用方回退整章重写）。
 * 抽出来是因为这条路径有**两个**调用点：正常流程 refineByChecklist 与刷新后的"接回进度"。
 *
 * 2026-09-27（R02.3）：`{"patches":[]}` 是**合法的"无修改"**，必须返回 ok+noop，
 * 而不是 null —— 旧实现把它当解析失败，触发一次整章重写（多花一次钱，还可能改坏原文）。
 *
 * 2026-10-07（Safe Editing）：补丁在写回前先过安全门禁。命中的**那一条**不进差异稿，
 * 其余照旧应用（文档 §17 要求"能压缩李拓多余 A 级光效"与"绝不删除王磊递面包"同时成立）。
 * ⚠️ 全部补丁都被拦时返回 `ok + allBlocked`，**不是** ok=false：ok=false 会让调用方回退
 * 整章重写——那是一次付费、且**没有门禁**的整章覆盖，正好会重犯同一处错误。
 */
function tryApplyRevisionOutput(output, baseArticle, safetyOpts) {
  const patches = parseRevisionPatches(output);
  if (!patches) return null;
  const opts = safetyOpts || patchSafetyOptions(Number(state.currentChapterId) || null);
  if (!patches.length) {
    return { ok: true, noop: true, text: String(baseArticle || ''), applied: [], unresolved: [], blocked: [], findings: [] };
  }
  const gate = patchSafetyGate(baseArticle, patches, opts);
  const result = applyRevisionPatches(baseArticle, gate.allowed);
  if (result.applied.length) {
    return { ...result, ok: true, noop: false, blocked: gate.blocked, findings: gate.findings };
  }
  if (gate.blocked.length) {
    return { ...result, ok: true, noop: false, allBlocked: true, text: String(baseArticle || ''), blocked: gate.blocked, findings: gate.findings };
  }
  return { ...result, ok: false, noop: false, blocked: [], findings: gate.findings };
}

// ⚠️ 第 3 个参数是**带标签的对象**，不是一个裸数字：
//    checklist = 作者勾选的问题条数；applied = 实际改好的处数；notes = 没能定位的条目。
//    blocked = 被安全门禁拦下的补丁（含原因，**没有**进这一版正文）；findings = 修后核验发现的断裂。
//    两条路径给出的数不同（正常流程知道清单条数；"接回进度"只知道改好几处），
//    用一个参数位表达两种量，必然出现「标题说按 0 条清单修改、正文说 2 条没定位」这种自相矛盾
//    （2026-09-18 第四轮重审抓到）。
// 轻量内容指纹（FNV-1a 32 位 + 长度）：只用于「预览期间原文是否被动过」的本地比对，
// 不是安全哈希、不上传、不落库；同一浏览器会话内比对足够。
function textFingerprint(text) {
  const s = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16)}:${s.length}`;
}

function showReviewDiff(oldText, newText, { checklist = null, applied = null, notes = [], chapterId = null, proposalIds = null, proposalRefs = null, baseFingerprint = null, blocked = [], findings = [] } = {}) {
  // ⚠️ 绑定"这份修稿属于哪一章"。差异预览开着的期间作者可能已经切了章，
  // 而旧实现按"当前打开的章"合并 —— 会把 A 章的修稿稿整篇写进 B 章（B 章原文只剩历史版本）。
  const targetChapterId = Number(chapterId) || Number(state.currentChapterId) || null;
  // R03：整次采纳要用到的两样东西，都在**弹窗打开时**固化：
  //   · proposalRefs / proposalIds —— 结果弹窗里勾选的入账提案（弹窗关掉后 DOM 就没了）。
  //     refs 带来源类型（event:/memory:）是权威形式；只有裸 id 的旧调用点按"事件优先"补 refs
  //     （与服务端对裸 id 的解析顺序一致）。
  //   · operationKey（见下）—— 幂等键：重复点击「合并到正文」不会重复写库/重复计费
  const keptSelection = (() => {
    const sel = state.pendingProposalSelection || {};
    const pickedRefs = (Array.isArray(proposalRefs) ? proposalRefs : (Array.isArray(sel.refs) ? sel.refs : []))
      .map((r) => String(r)).filter((r) => /^(event|memory):\d+$/.test(r));
    const pickedIds = (Array.isArray(proposalIds) ? proposalIds.map(Number) : (Array.isArray(sel.ids) ? sel.ids.map(Number) : []))
      .filter((n) => n > 0);
    return {
      proposalRefs: pickedRefs.length ? pickedRefs : pickedIds.map((n) => `event:${n}`),
      proposalIds: pickedIds.length ? pickedIds : proposalIdsOfRefs(pickedRefs),
    };
  })();
  // R02.3（语义已于 2026-10-06 修订）：绑定**生成这份差异时的原文指纹**。
  // ⚠️ 它现在只用于**观测/告知**（"这一章正文在预览之后变过吗"），**不再是合并的拦阻条件** ——
  // 作者点「合并到正文」就必须写进正文（见 mergeReviewDiff 的长注释）。
  state.pendingReviewDiff = {
    newText, chapterId: targetChapterId,
    // 默认按差异"原文"取指纹；草稿链由调用方传入"章节正文在审稿启动时"的指纹（见 runArticleReview）。
    baseFingerprint: baseFingerprint || textFingerprint(oldText),
    baseExcerpt: String(oldText || '').trim().slice(0, 60),
    proposalRefs: keptSelection.proposalRefs,
    proposalIds: keptSelection.proposalIds,
    operationKey: `merge-${targetChapterId || 0}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  // 勾选集合已转存进 pendingReviewDiff（本次差异预览的一部分）；清掉暂存，避免串到下一次操作。
  state.pendingProposalSelection = null;
  const viewingOther = Boolean(targetChapterId) && Number(state.currentChapterId) !== targetChapterId;
  const ops = diffParagraphs(oldText, newText);
  const body = ops.map((op) => {
    if (op.t === 'same') return `<div class="diff-p">${esc(op.x)}</div>`;
    if (op.t === 'del') return `<div class="diff-p diff-del">${esc(op.x)}</div>`;
    return `<div class="diff-p diff-add">${esc(op.x)}</div>`;
  }).join('');
  const title = checklist != null
    ? `🆚 修稿差异预览（按 ${checklist} 条清单修改${applied != null ? `，实际改好 ${applied} 处` : ''}）`
    : `🆚 修稿差异预览（实际改好 ${applied ?? 0} 处）`;
  openModal({
    title,
    body: `
      <div class="muted mb-8"><span class="diff-add-inline">绿色</span>=修稿新增/改写，<span class="diff-del-inline">红色</span>=旧稿被删改。确认无误后合并到正文。</div>
      ${viewingOther ? `<div class="redline-scan warn">⚠️ 这份修稿属于《${esc(chapterTitleOf(targetChapterId))}》，你现在打开的是《${esc(chapterTitleOf(state.currentChapterId))}》。点「合并到正文」会写回《${esc(chapterTitleOf(targetChapterId))}》——当前这一章不会被改动。</div>` : ''}
      ${notes.length ? `<div class="redline-scan warn">⚠️ 有 ${notes.length} 条改动没能自动定位，已保持原样、需要你手工处理：${notes.map((n) => esc(String(n).slice(0, 60))).join('；')}</div>` : ''}
      ${patchSafetyNotesHtml(blocked, findings)}
      <div class="diff-view">${body || '<div class="muted">无差异</div>'}</div>`,
    footer: `
      <button class="btn secondary" data-close-modal>放弃修改</button>
      <button class="btn" data-action="diff-merge">合并到正文</button>`,
    large: true
  });
}

async function mergeReviewDiff() {
  const pending = state.pendingReviewDiff;
  const { newText, chapterId, baseFingerprint, proposalIds, proposalRefs, operationKey } = pending || {};
  // 合并目标 = 差异预览绑定的那一章（不再是"当前打开的章"）。
  const targetChapterId = Number(chapterId) || Number(state.currentChapterId) || null;
  if (!newText || !targetChapterId) return;
  const elsewhere = Number(state.currentChapterId) !== targetChapterId;
  // ⚠️ 这份修稿稿是"审稿 + 修稿"几分钟的全部产出，**只有真的写进库之后**才消费它。
  // 旧实现在任何校验之前就把它清成 null：一次被拒（原文动过）或一次失败之后，差异预览弹窗还开着、
  // 「合并到正文」按钮还在，可再点它什么都不会发生 —— 作者看到的就是"修稿没法合并进正文"，
  // 于是手工把预览里的文字抄进编辑器（预览是"旧段落 + 新段落"并排的，抄进去正文立刻变成两份叠在一起）。
  const consumePendingDiff = () => { if (state.pendingReviewDiff === pending) state.pendingReviewDiff = null; };
  const mergedHtml = textToParagraphsHtml(newText);
  // 合并**之前**先把本页待落盘的稿子按"合并前"的基线写完（无任何界面提示，与 adoptEditorContentImpl
  // 第 1 步同一条纪律）。顺序本身就是修复：合并会推进该章的 updated_at，落盘若发生在合并**之后**，
  // 就会撞上乐观锁并弹出"检测到其他窗口的修改"——而冲突的另一方其实是作者刚点的这次合并；
  // 放在合并之前还让"旧稿进历史版本"这一步真的能兜住作者手里那一版（否则只备份到服务端那一版）。
  // 只处理**被合并这一章**：编辑器开着别的章时，那一章与本次合并无关，一个字节都不动它
  //（待落盘快照的章号恒等于编辑器当前章，所以这个判据就是"这份稿子属于被合并的这一章"）。
  // 它也不参与合并的成败判定：正文来自 newText，与编辑器无关。
  // F3（2026-10-06 作者要求）：合并会把这一章正文整段换掉 —— 作者手里若还压着一版没落盘的旧内容，
  // 先问「旧内容是否保存？」（是/否），而不是静默替作者落盘或静默丢掉。两个答案都继续合并。
  const oldContentDecision = await settleOldContentBeforeOverwrite(targetChapterId).catch(() => '');
  const editorForMerge = $('#editor-content');
  const editorIsTarget = Boolean(editorForMerge) && Number(editorForMerge.dataset.chapterId) === targetChapterId;
  // 作者选了「是」→ 必须真的把那一版落盘；选「否」→ 手里那一版已被丢掉，这次 flush 对它无操作。
  if (oldContentDecision || editorIsTarget || state.editorSaveInFlight.has(targetChapterId)) {
    try { await flushEditorSaves(); } catch (_) { /* 落盘失败不阻塞合并 */ }
  }
  try {
    // ⚠️ 作者裁决（2026-10-06，第二次明确要求）：「合并到正文」**没有任何拦阻** ——
    // 只要作者点了它，正文就必须写进去（`无论什么时候，只要是用户执行，就直接强制合并到正文`）。
    // 与 F3「旧内容是否保存？」同一条纪律：可以**告知**、可以**留档**，但绝不**拦操作**。
    // 被替换掉的那一版由服务端在采纳事务里存进本章历史版本（固定安全底线）→ "覆盖"是可回退的，不是不可逆的。
    //
    // 历史（为什么这里曾经会拒绝）：R02.3 曾按"原文指纹不一致就拒绝合并"实现（防止拿旧差异稿覆盖更新的正文）。
    // 实际代价是作者点了也进不去 —— 空正文的章节必然被误拒（2026-10-06 21:47 报障），
    // 作者最后只能手工把预览里的段落抄进编辑器，那比"覆盖"更坏：抄写会把旧段落和新段落叠在一起，
    // 还绕过了"旧稿进历史版本"这条兜底。所以这里只保留**观测**，不再做任何拒绝判断。
    let baseChanged = false;
    let baseUnreadable = false;
    if (baseFingerprint) {
      try {
        const current = await revisionBaseArticle(targetChapterId);
        baseChanged = textFingerprint(current) !== baseFingerprint;
      } catch (_) { baseUnreadable = true; }
    }
    if (baseChanged || baseUnreadable) {
      // 如实留痕：这条路径会整段替换正文，事后排查必须看得到"这一次覆盖了什么原因"。
      reportClientLogSafe({
        level: 'warn',
        kind: 'review_merge_overwrite',
        message: baseUnreadable
          ? '[修稿合并] 合并前读不到这一章正文，仍按作者操作强制写入（覆盖前那一版由服务端存进历史版本）'
          : '[修稿合并] 本章正文在差异预览之后变过，仍按作者操作强制写入（覆盖前那一版已存进历史版本）',
        context: { work_id: state.workId || null, chapter_id: targetChapterId, base_unreadable: baseUnreadable }
      });
    }
    // R03：正文 + 本次勾选的入账提案走**一次**原子采纳（/novel/adopt）：
    // 同一 SQLite 事务里写历史版本、写正文、入账提案、落投影 outbox；任一步失败整次回滚。
    // 旧实现是 chapter_save 之后再发一次 proposals/apply —— 两次请求之间没有原子性，
    // 中途失败会留下"正文已换、提案没入账"的半套状态。
    const res = await api('/novel/adopt', {
      method: 'POST',
      body: {
        work_id: state.workId || state.work?.id || null,
        chapter_id: targetChapterId,
        content: mergedHtml,
        legacy_proposal_ids: Array.isArray(proposalIds) ? proposalIds : [],
        legacy_proposal_refs: Array.isArray(proposalRefs) ? proposalRefs : [],
        operation_key: operationKey || `merge-${targetChapterId}-${Date.now().toString(36)}`,
        adopt_kind: 'review_merge',
      }
    });
    const adoptedCount = ((res && res.adopt && res.adopt.legacy && (res.adopt.legacy.events || 0) + (res.adopt.legacy.memories || 0)) || 0);
    consumePendingDiff();   // 采纳真的落地了，这份修稿稿才算消费掉
    // 采纳是"外来写入"：本地那一行（正文 + 版本标记）必须在这里拉回服务端真值，
    // 否则紧接着的第一次编辑器保存必然 409，而"冲突的另一方"就是作者刚点的这次合并。
    // ⚠️ 收口失败**不等于写入失败**：正文此刻已经在库里。旧实现把它留在同一个 try 里，
    // 一旦它抛错就会被下面的 catch 报成「合并失败（正文未被改动）」——那是在谎报事实
    //（与 2026-10-05 "把刷新失败报成合并失败" 同一形状，见下面 loadWorkData 那段注释）。
    let settleNote = '';
    try {
      await settleReviewMergeLocally(targetChapterId, mergedHtml, res && res.adopt ? res.adopt : null);
    } catch (e) {
      settleNote = '；本地界面基线没同步完（正文已在库里，刷新页面即可看到）';
      reportClientLogSafe({
        level: 'warn', kind: 'review_merge_settle_failed',
        message: '[修稿合并] 正文已写入，但合并后的本地收口失败：' + (e && e.message ? e.message : e),
        context: { work_id: state.workId || null, chapter_id: targetChapterId }
      });
    }
    closeModal();
    // 本次是"强制合并"：正文若在预览之后变过（或读不到），必须如实说出来 —— 不拦，但绝不静默。
    const overwriteNote = baseUnreadable
      ? '；⚠️ 合并前没能读到这一章正文，被覆盖的那一版可在「历史版本」里找回'
      : (baseChanged ? '；⚠️ 这一章正文在差异预览之后被改过，这次用它覆盖了它 —— 覆盖前的那一版已存进本章历史版本' : '');
    toast(elsewhere
      ? `已合并到《${chapterTitleOf(targetChapterId)}》（你当前看的是另一章，它没有被改动；旧稿已存历史版本${adoptedCount ? `；同时入账 ${adoptedCount} 条提案` : ''}${overwriteNote}${settleNote}）`
      : `审稿修稿已合并到正文（旧稿已存历史版本${adoptedCount ? `；同时入账 ${adoptedCount} 条提案` : ''}${overwriteNote}${settleNote}）`, 'success');
    // 整页刷新与"合并有没有成功"是两件事：正文此刻已经在库里了。旧实现把刷新和采纳放在同一个
    // try 里，于是刷新途中任何一次 flushSave 失败都会被报成「合并失败：本地内容尚未保存，请先处理
    // 保存冲突」——作者以为没合并，其实早就写进去了（2026-10-05 报障的形状）。
    try {
      await loadWorkData(true);
      await render();
    } catch (e) {
      toast('修稿已经合并到正文；界面刷新没走完：' + e.message + '（刷新页面即可看到最新正文）', 'error');
    }
  } catch (e) {
    toast('合并失败（正文未被改动，这份修稿仍在，可再次点「合并到正文」重试）：' + e.message, 'error');
  }
}

/**
 * 「合并到正文」成功之后的本地收口。
 *
 * 与 adoptEditorContentImpl 的 afterAdoptApplied 是**同族但不同口径**：合并这条路的正文来自
 * newText（与编辑器无关），所以**编辑器里别的章**的待落盘稿子一个字都不能碰；只有"正开着被合并
 * 的这一章"时，那一版（连同它上面的暂停态/失败态/冲突态）才被这次合并取代 —— 随后的
 * loadWorkData + render 会用合并后的正文重建编辑器，留在旧版上只会让作者看不到合并结果。
 *
 * 基线（updated_at）必须在这里同步：编辑器保存的乐观锁比的就是它，不同步的话合并之后
 * 第一次保存必然 409，而冲突的另一方就是作者刚点的这次合并。
 *
 * @param {number} targetChapterId 被合并的那一章
 * @param {string} html 本次真正写进库的正文（与服务端存的一致）
 * @param {object|null} adoptResult 服务端回包里的 `adopt` 段；null = 回包没有采纳结果
 */
async function settleReviewMergeLocally(targetChapterId, html, adoptResult = null) {
  const id = Number(targetChapterId) || 0;
  if (!id) return;
  // 版本标记只认服务端回包里的那一个（不是本地 new Date()）：它与编辑保存的乐观锁同一口径。
  const newUpdatedAt = adoptResult ? String(adoptResult.chapter_updated_at || '') : '';
  const editor = $('#editor-content');
  const editorShowsTarget = Boolean(editor) && Number(editor.dataset.chapterId) === id;
  const mine = (snap) => Boolean(snap) && Number(snap.id) === id;
  if (editorShowsTarget) {
    clearTimeout(state.editorSaveTimer);
    state.editorSaveTimer = null;
    state.editorSaveSnapshot = null;
  }
  // 空内容暂停 / 保存失败 / 409 冲突都是**按章**记的：属于被合并这一章的一律作废
  //（正文刚刚被这次合并填满/换掉，那些状态描述的是合并前的那一版）。
  if (mine(state.editorEmptyBlocked)) state.editorEmptyBlocked = null;
  if (mine(state.editorSaveFailedSnapshot)) state.editorSaveFailedSnapshot = null;
  if (mine(state.editorConflictSnapshot)) state.editorConflictSnapshot = null;
  // F3 补充（2026-10-06）：与本次写入不一致的该章在途稿子都是**合并前那一版**，一并撤下 ——
  // 否则自动重试随后会把它落盘，把刚合并进来的正文倒回旧稿（与 afterAdoptApplied 同一条理由）。
  discardSupersededEditorWorkFor(id, html);
  const chapter = (state.chapters || []).find((c) => Number(c.id) === id);
  if (chapter) {
    chapter.content = html;
    if (newUpdatedAt) chapter.updated_at = newUpdatedAt;
  }
  // 只有"服务端确实回了采纳结果、却没带版本标记"（老服务端 / 异常回包）才补读一次：
  // 本地若停在旧标记，下一次保存仍会 409。正常回包带着标记，就不多打一次请求，
  // 更不会用一次整行替换把本地这一行（标题等）冲掉。
  if (adoptResult && !newUpdatedAt) await refreshChapterBaselineAfterForeignWrite(id);
  state.chapterDraft = null;
  await refreshChapterRecovery(id).catch(() => { /* 恢复条刷新失败不影响已成功的写入 */ });
}

// ---------- 导出 ----------
async function downloadExport(path, fallbackName) {
  try {
    const res = await fetch('/api' + path, { headers: { ...(traceHeaders() || {}) } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(extractReadableError(text, res.status)); // F-15：与 api() 统一非 JSON 错误格式
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

// ---------- P4：共享资料库（跨作品写作参考资料） ----------
// 界面只做作者动作的入口，服务端口径原样呈现：
//   · 导入先 dry-run 预览（该端点从不写入）→ 作者确认才写共享资料根；
//   · 删除先「标记缺失」→「确认删除」才删记忆库文件与登记行；
//   · 开关按作品（library_enabled:<workId>），默认关闭；资料永不 canon、只作参考。
const LIBRARY_ACTION_LABEL = { add: '新增', update: '更新', skip: '未变' };
const LIBRARY_SKIP_LABEL = {
  ext_not_allowed: '扩展名不在白名单（只收 .md / .txt）',
  hidden: '隐藏项（. 或 _ 开头）',
  ignored_dir: '忽略目录（依赖 / 系统目录不深入）',
  too_large: '超过单文件上限（2MB）',
  bad_encoding: '不是合法 UTF-8（安全失败，不猜编码）',
  symlink: '符号链接（不跟随）',
  limit: '超过单批篇数上限',
  duplicate_target: '与另一篇映射到同一入库路径',
  bad_target: '入库路径形状不合'
};
const librarySkipLabel = (code) => LIBRARY_SKIP_LABEL[code] || String(code || '');
const libraryTimeLabel = (t) => (t ? String(t).replace('T', ' ').slice(0, 16) : '—');
const libraryLines = (text) => String(text || '').split('\n').length;
// 服务端 plan.dir 是 path.resolve 归一化后的路径（Windows 反斜杠、去尾斜杠）：比对前同口径归一，
// 避免「其实没改目录、只是写法不同」被误判为「目录已改」。大小写仍严格：宁可多拒一次，不可少拒。
const normalizeLibraryDir = (s) => String(s || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
// P4：资料库异步请求序号（快速翻页 / 连续检索时只认最后一次响应，过期响应一律丢弃）
let libraryDocSeq = 0;
let librarySearchSeq = 0;

async function loadLibrary(force = false) {
  const key = state.workId || null; // 缓存以作品为键，避免把上一个作品的「按作品开关」串到下一个作品
  if (!force && state.libraryLoaded && state.libraryKey === key) return state.library;
  try {
    const data = await api(`/novel/library/status${state.workId ? `?work_id=${state.workId}` : ''}`);
    if ((state.workId || null) !== key) return state.library; // 等待期间作品已切换：丢弃过期结果（F-02 同口径）
    state.library = data && data.ok ? data : null;
  } catch (_) {
    if ((state.workId || null) !== key) return state.library;
    state.library = null; // 旧服务端没有该接口：如实显示不可用，不假装有资料库
  }
  state.libraryKey = key;
  state.libraryLoaded = true;
  return state.library;
}

function libraryStatusChip(d) {
  return d.status === 'active' ? '<span class="chip">有效</span>' : '<span class="chip">标记缺失</span>';
}

function libraryDocRow(d) {
  const buttons = d.status === 'active'
    ? `<button class="btn small secondary" data-action="library-view" data-id="${esc(String(d.id))}">读原文</button>
       <button class="btn small secondary" data-action="library-mark" data-id="${esc(String(d.id))}">标记缺失</button>
       <button class="btn small secondary" data-action="library-delete" data-id="${esc(String(d.id))}">确认删除…</button>`
    : `<button class="btn small secondary" data-action="library-delete" data-id="${esc(String(d.id))}">确认删除…</button>`;
  return `<div class="st-character-item">
      <div class="row"><b>${esc(d.title || d.slug || '')}</b>
        <span class="chip">${esc(d.category || '未分类')}</span>${libraryStatusChip(d)}
        <span class="muted" style="font-size:12px">${esc(String(d.chars || 0))} 字｜预计 ${esc(String(d.est_chunks || 0))} 块｜索引 ${esc(libraryTimeLabel(d.indexed_at))}</span>
      </div>
      <div class="row mt-8" style="gap:6px">${buttons}</div>
    </div>`;
}

function libraryHitRow(h) {
  const score = typeof h.score === 'number' ? `<span class="chip">相关度 ${esc(String(h.score))}%</span>` : '';
  return `<div class="st-character-item">
      <div class="row"><b>${esc(h.title || h.slug || '')}</b>
        <span class="chip">${esc(h.category || '未分类')}</span>${score}
        <span class="muted" style="font-size:12px">${esc(h.category || '未分类')} / ${esc(h.slug || '')}</span>
      </div>
      ${h.abstract ? `<div class="muted" style="font-size:12px">${esc(String(h.abstract).slice(0, 200))}</div>` : ''}
      <div class="row mt-8" style="gap:6px"><button class="btn small secondary" data-action="library-view" data-id="${esc(String(h.id))}">读原文</button></div>
    </div>`;
}

function libraryPlanHtml() {
  const plan = state.libraryPlan;
  if (!plan) return '';
  const s = plan.summary || {};
  const items = (plan.items || []).filter((i) => i.action !== 'skip');
  const skipped = plan.skipped || [];
  return `
    <div class="mt-8">
      <div style="font-size:12px">
        <span class="chip">新增 ${esc(String(s.add || 0))}</span>
        <span class="chip">更新 ${esc(String(s.update || 0))}</span>
        <span class="chip">未变 ${esc(String(s.skip_unchanged || 0))}</span>
        <span class="chip">跳过 ${esc(String(s.skipped_files || 0))}</span>
        <span class="muted">目录：${esc(plan.dir || state.libraryDir)}｜预计写入 ${esc(String(s.will_write || 0))} 篇 / ${esc(String(s.chars || 0))} 字</span>
      </div>
      ${items.length ? `<div class="mt-8">${items.map((i) => `
        <div class="st-character-item">
          <div class="row"><b>${esc(i.title || i.slug || '')}</b>
            <span class="chip">${esc(LIBRARY_ACTION_LABEL[i.action] || i.action)}</span>
            <span class="muted" style="font-size:12px">${esc(i.rel || '')}｜${esc(String(i.chars || 0))} 字｜${esc(String(i.bytes || 0))} 字节｜预计 ${esc(String(i.est_chunks || 0))} 块</span>
          </div>
          ${(i.warnings || []).map((w) => `<div class="muted" style="font-size:12px">提示：${esc(w.message)}</div>`).join('')}
        </div>`).join('')}</div>` : '<div class="muted mt-8" style="font-size:12px">没有需要写入的新增 / 更新（全部未变或跳过）。</div>'}
      ${skipped.length ? `<details class="mt-8"><summary class="muted" style="font-size:12px;cursor:pointer">跳过清单（${esc(String(skipped.length))} 条，不写入）</summary>
        ${skipped.slice(0, 50).map((k) => `<div class="muted" style="font-size:12px">· ${esc(k.path || '')} —— ${esc(k.reason || librarySkipLabel(k.code))}</div>`).join('')}
        ${skipped.length > 50 ? `<div class="muted" style="font-size:12px">……其余 ${esc(String(skipped.length - 50))} 条略</div>` : ''}
      </details>` : ''}
      ${Number(s.will_write || 0) > 0 ? `<div class="row mt-8" style="gap:6px"><button class="btn small" data-action="library-import-confirm">确认导入 ${esc(String(s.will_write))} 篇</button><span class="muted" style="font-size:12px">写入的是共享资料根（所有作品可检索）；这一步才会真正写记忆库。</span></div>` : ''}
    </div>`;
}

function libraryImportResultHtml() {
  const r = state.libraryImportResult;
  if (!r) return '';
  const s = r.summary || {};
  const failed = r.failed || [];
  return `<div class="mt-8" style="font-size:12px">
      <span class="chip">已写入 ${esc(String(s.written || 0))}</span>
      <span class="chip">失败 ${esc(String(s.failed || 0))}</span>
      <span class="chip">未变 ${esc(String(s.skip_unchanged || 0))}</span>
      <span class="muted">${esc((r.index && r.index.note) || '异步索引：写后约 30 秒内可被召回')}</span>
      ${failed.map((f) => `<div class="muted" style="font-size:12px">写入失败：${esc(f.rel || '')} —— ${esc(f.error || '')}</div>`).join('')}
    </div>`;
}

function renderLibraryDocCard() {
  const view = state.libraryDoc;
  if (!view) return '';
  const d = view.doc || {};
  const text = String(view.text || '');
  const limit = Number(view.limit || 30);
  const lines = libraryLines(text);
  return `
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">读原文：${esc(d.title || d.slug || '')}</span>
        <span class="muted" style="font-size:12px">${esc(d.rel || '')}｜共 ${esc(String(d.total_chars || 0))} 字</span>
        <button class="btn small secondary" data-action="library-doc-close">关闭</button></div>
      ${text ? `<pre style="white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;font-size:13px;line-height:1.6;margin:8px 0 0">${esc(text)}</pre>`
        : '<div class="muted mt-8">没读到这一段正文：可能已读到最后一行，或记忆库暂不可用（离线 / 总闸关闭）——登记信息仍在，不会丢。</div>'}
      <div class="row mt-8" style="gap:6px">
        <button class="btn small secondary" data-action="library-doc-page" data-offset="${Math.max(0, view.offset - limit)}" ${view.offset > 0 ? '' : 'disabled'}>上一段</button>
        <button class="btn small secondary" data-action="library-doc-page" data-offset="${view.offset + limit}" ${lines >= limit ? '' : 'disabled'}>下一段（30 行）</button>
        <span class="muted" style="font-size:12px">当前从第 ${esc(String(view.offset + 1))} 行起，本段 ${esc(String(lines))} 行（窗口按行计）</span>
      </div>
    </div>`;
}

async function renderLibrary(content) {
  await loadLibrary();
  if (state.view !== 'library') return; // 等待服务端期间视图已切走：过期渲染不得覆盖新页面
  const lib = state.library;
  const summary = (lib && lib.summary) || {};
  const docs = (lib && lib.docs) || [];
  const categories = Array.isArray(summary.categories) ? summary.categories : [];
  const filtered = docs.filter((d) => !state.libraryCategory || d.category === state.libraryCategory);
  const search = state.librarySearch;
  const enabled = Boolean(lib && lib.enabled);
  const ovDisabled = Boolean(lib && lib.ov && lib.ov.disabled);
  const rows = search && search.q
    ? ((search.hits || []).length ? search.hits.map(libraryHitRow).join('') : '<div class="empty">没有命中（语义与关键词都没找到）。</div>')
    : (filtered.length ? filtered.map(libraryDocRow).join('') : '<div class="empty">还没有资料：在下面的「导入资料」里先扫描预览、再确认写入。</div>');
  content.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">📎 资料库</h1>
        <div class="page-sub">跨作品共享的写作参考资料（方法 / 素材 / 范例）：先预览再导入；资料只作参考，不是本书事实</div>
        ${helpDot('library')}
      </div>
      <div class="page-actions"><button class="btn secondary" data-action="library-refresh">刷新</button></div>
    </div>
    ${lib === null ? '<div class="card mb-12"><div class="card-head"><span class="card-title">资料库</span></div><div class="muted">当前服务端不提供该接口（可能是重启前的旧进程）：重启 Novel Studio 后可用。</div></div>' : ''}
    ${lib ? `
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">资料层开关（本作品）${helpDot('library')}</span>
        <span class="chip">${enabled ? '已开启' : '未开启'}</span></div>
      ${state.workId ? `
        <div class="muted" style="font-size:12px">开启后，写《${esc(state.work ? state.work.title : '当前作品')}》时上下文才会多出「参考资料（非本书事实）」层（top-4、阈值 0.40、单条 300 字、独立预算 1200 字）。未开启的作品与接入前逐字节一致；资料永不进入事实 / 事件 / 角色知识。</div>
        <div class="row mt-8" style="gap:6px">
          <button class="btn small" data-action="library-toggle" data-enabled="1" ${enabled ? 'disabled' : ''}>开启本作品资料层</button>
          <button class="btn small secondary" data-action="library-toggle" data-enabled="0" ${enabled ? '' : 'disabled'}>关闭</button>
          <span class="muted" style="font-size:12px">开关 / 导入 / 删除都是作者动作，模型侧一律 403。</span>
        </div>`
      : '<div class="muted mt-8">还没进入作品：开关按作品生效，进入某个作品后再开 / 关。</div>'}
      ${ovDisabled ? '<div class="muted mt-8" style="font-size:12px">记忆库总闸已关闭（NOVELSTUDIO_OV_DISABLED=1）：可以本地扫描预览与检索兜底，但确认导入与删除会被拒绝（不写任何东西）。</div>' : ''}
    </div>` : ''}
    ${lib ? `
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">资料列表${search && search.q ? '（检索结果）' : ''}</span>
        <span class="muted" style="font-size:12px">共 ${esc(String(summary.total || 0))} 篇（有效 ${esc(String(summary.active || 0))}${summary.marked_missing ? `、标记缺失 ${esc(String(summary.marked_missing))}` : ''}）｜最近索引 ${esc(libraryTimeLabel(summary.last_indexed_at))}</span></div>
      <div class="row mt-8" style="gap:6px;flex-wrap:wrap">
        <input id="library-q" value="${esc(search && search.q ? search.q : '')}" placeholder="按关键词检索资料（回车或点「检索」）" style="flex:1;min-width:220px" />
        <button class="btn small" data-action="library-search">检索</button>
        <button class="btn small secondary" data-action="library-search-clear">清空</button>
      </div>
      <div class="row mt-8" style="gap:6px;flex-wrap:wrap">
        <button class="btn small ${state.libraryCategory ? 'secondary' : ''}" data-action="library-category" data-category="">全部分类</button>
        ${categories.map((c) => `<button class="btn small ${state.libraryCategory === c.category ? '' : 'secondary'}" data-action="library-category" data-category="${esc(c.category)}">${esc(c.category)}（${esc(String(c.n))}）</button>`).join('')}
      </div>
      ${search && search.q ? `<div class="muted mt-8" style="font-size:12px">检索方式：${search.mode === 'semantic' ? '语义（记忆库命中，已按相关度排序）' : '关键词兜底（语义不可用或没有命中）'}${search.total ? `｜资料总数 ${esc(String(search.total))}` : ''}</div>` : ''}
      <div class="mt-8">${rows}</div>
    </div>` : ''}
    ${renderLibraryDocCard()}
    <div class="card mb-12">
      <div class="card-head"><span class="card-title">导入资料${helpDot('library')}</span></div>
      <div class="muted" style="font-size:12px">只读你在这里显式指定的目录：白名单 <b>.md / .txt</b>、单文件 ≤2MB、单批 ≤500 篇、隐藏与依赖目录不深入、<b>不跟随符号链接</b>、严格 UTF-8（不猜编码）。<b>先「扫描预览」，再「确认导入」</b>；写入的是跨作品共享资料根，由记忆库本地向量化（写入后约 30 秒内可被召回）。</div>
      <div class="row mt-8" style="gap:6px">
        <input id="library-dir-input" value="${esc(state.libraryDir)}" placeholder="资料目录的路径，例如 D:\\写作资料" style="flex:1;min-width:260px" />
        <button class="btn small" data-action="library-import-preview">扫描预览（不写入）</button>
      </div>
      ${libraryPlanHtml()}
      ${libraryImportResultHtml()}
    </div>`;
}

async function libraryRenderSafely() {
  try { await render(); }
  catch (e) { reportClientLog({ level: 'warn', kind: 'library_render_failed', message: `[资料库] 渲染失败（动作已生效）：${e.message}` }); }
}

async function libraryRefresh() {
  await loadLibrary(true);
  await libraryRenderSafely();
}

async function librarySearchRun() {
  const input = $('#library-q');
  const q = String((input && input.value) || (state.librarySearch && state.librarySearch.q) || '').trim();
  const seq = ++librarySearchSeq; // 每次调用（含清空）都作废更早的在途检索
  if (!q) { state.librarySearch = null; await libraryRenderSafely(); return; }
  try {
    const cat = state.libraryCategory ? `&category=${encodeURIComponent(state.libraryCategory)}` : '';
    const data = await api(`/novel/library/search?q=${encodeURIComponent(q)}&limit=20${cat}`);
    if (seq !== librarySearchSeq) return; // 已有更新的检索：丢弃过期响应
    state.librarySearch = { q, mode: data.mode || 'keyword', hits: data.hits || [], total: data.total || 0 };
  } catch (e) {
    if (seq !== librarySearchSeq) return;
    toast('检索失败：' + e.message, 'error');
    return;
  }
  await libraryRenderSafely();
}

async function librarySetCategory(category) {
  state.libraryCategory = category || '';
  if (state.librarySearch && state.librarySearch.q) { await librarySearchRun(); return; }
  await libraryRenderSafely();
}

async function libraryViewDoc(id, offset = 0) {
  if (!id) return;
  const seq = ++libraryDocSeq; // 快速翻页 / 连读两篇：只认最后一次
  try {
    const limit = 30;
    const data = await api(`/novel/library/doc?id=${encodeURIComponent(id)}&offset=${offset}&limit=${limit}`);
    if (seq !== libraryDocSeq) return; // 已有更新的读原文请求：丢弃过期响应
    state.libraryDoc = { doc: data.doc || {}, text: data.text || '', offset, limit };
  } catch (e) {
    if (seq !== libraryDocSeq) return;
    toast('读取失败：' + e.message, 'error');
    return;
  }
  await libraryRenderSafely();
}

async function libraryToggleEnabled(enabled) {
  if (!state.workId) { toast('先进入一个作品再开 / 关资料层', 'error'); return; }
  try {
    await api('/novel/library/enabled', { method: 'PUT', body: { work_id: state.workId, enabled } });
    toast(enabled ? '已开启本作品的资料层' : '已关闭本作品的资料层', 'success');
  } catch (e) {
    toast('开关失败：' + e.message, 'error');
    return;
  }
  await loadLibrary(true);
  await libraryRenderSafely();
}

async function libraryPreviewImport() {
  const input = $('#library-dir-input');
  const dir = String((input && input.value) || '').trim();
  if (!dir) { toast('先填资料目录（本机路径）', 'error'); return; }
  try {
    const plan = await api('/novel/library/import', { method: 'POST', body: { dir } });
    state.libraryDir = dir;
    state.libraryPlan = plan;
    state.libraryImportResult = null;
  } catch (e) {
    toast('扫描失败：' + e.message, 'error');
    return;
  }
  await libraryRenderSafely();
}

async function libraryConfirmImport() {
  const plan = state.libraryPlan;
  if (!plan) { toast('先「扫描预览」再确认导入', 'error'); return; }
  const input = $('#library-dir-input');
  const dir = String((input && input.value) || '').trim();
  // 归一化后比对：覆盖 Windows 反斜杠 / 尾斜杠 / 相对路径写法；真的改了目录才拒绝。
  const dirNorm = normalizeLibraryDir(dir);
  if (dirNorm !== normalizeLibraryDir(plan.dir) && dirNorm !== normalizeLibraryDir(state.libraryDir)) {
    toast('目录已改：请对新目录重新「扫描预览」', 'error'); return;
  }
  if (!confirm(`确认把 ${Number((plan.summary || {}).will_write || 0)} 篇资料写入共享资料根？写入后所有作品都可检索到它们。`)) return;
  try {
    const out = await api('/novel/library/import/confirm', { method: 'POST', body: { dir } });
    state.libraryImportResult = out;
    state.libraryPlan = null;
    const failed = (out.failed || []).length;
    toast(`导入完成：写入 ${Number((out.summary || {}).written || 0)} 篇${failed ? `，失败 ${failed} 篇` : ''}`, failed ? 'error' : 'success');
  } catch (e) {
    toast('导入失败：' + e.message, 'error');
    return;
  }
  await loadLibrary(true);
  await libraryRenderSafely();
}

async function libraryMarkMissing(id) {
  try {
    await api(`/novel/library/doc/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('已标记缺失（未删文件与登记行；确认删除后才会真正移除）', 'success');
  } catch (e) {
    toast('标记失败：' + e.message, 'error');
    return;
  }
  await loadLibrary(true);
  await libraryRenderSafely();
}

async function libraryDeleteDoc(id) {
  if (!confirm('确认删除这篇资料？会同时从记忆库删除该文件并删掉登记行（删除后无法从这里恢复）。')) return;
  try {
    const out = await api(`/novel/library/doc/${encodeURIComponent(id)}?confirm=1`, { method: 'DELETE' });
    toast(out.removed ? '已删除：' + out.removed : '已删除', 'success');
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
    return;
  }
  if (state.libraryDoc && Number(state.libraryDoc.doc && state.libraryDoc.doc.id) === Number(id)) {
    state.libraryDoc = null;
    libraryDocSeq += 1; // 在途的「读原文」响应不得把已删资料再贴回来
  }
  await loadLibrary(true);
  await libraryRenderSafely();
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
  // F-40：限制导入文件大小（50MB），避免超大文件把主线程/内存打爆。
  const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
  if (file.size > MAX_IMPORT_BYTES) {
    toast('导入文件过大（超过 50MB），请拆分后再导入', 'error');
    const input = $('#import-file');
    if (input) input.value = '';
    return;
  }
  const isEpub = /\.epub$/i.test(file.name);
  const title = file.name.replace(/\.(txt|md|markdown|epub)$/i, '').trim();
  toast('正在读取文件…');
  try {
    let body = { title };
    if (isEpub) {
      const buf = new Uint8Array(await file.arrayBuffer());
      body.base64 = bytesToBase64(buf);
    } else {
      body.text = await file.text();
    }
    const r = await api('/import', { method: 'POST', body, timeout: 300000 });
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

/**
 * 采纳（/novel/adopt）的并发基线：**现读服务端**，不读内存里的章节行（2026-10-02 事故）。
 *
 * 为什么必须现读：`state.chapters[].updated_at` 只在 loadWorkData / 编辑保存成功后更新，
 * 而"替换当前正文"这条路会先 manualSaveChapter（把 AI 正文直接写进库、推进 updated_at）、
 * 再发采纳 —— 采纳拿着旧标记去对账，必然被判成"其它窗口改过"而整次回滚，
 * 界面于是弹出"写入失败"，而作者看到的正文其实已经写进去了（真实事故的形状）。
 *
 * 拿的是服务端给的 `content_hash`（存库原文的指纹，口径见 Approvals.chapterBaselineHash）：
 * 内容没变（只是时间戳被本页自己推进）→ 闸门放行；内容真被改过 → 仍然拒绝。
 * 失败时返回 null：调用方如实处理，绝不假装"基线已知"。
 */
async function readChapterBaseline(chapterId) {
  const id = Number(chapterId) || 0;
  if (!id) return null;
  try {
    const row = await api(`/chapters/${id}`);
    if (!row || Number(row.id) !== id) return null;
    return { content_hash: String(row.content_hash || ''), updated_at: String(row.updated_at || '') };
  } catch (_) {
    return null;
  }
}

/** 采纳成功之后的本地收口：清掉待保存快照 / 反映新版本 / 收起草稿提示 / 刷新恢复条。 */
async function afterAdoptApplied(targetChapterId, html, newUpdatedAt = '') {
  clearTimeout(state.editorSaveTimer);
  state.editorSaveTimer = null;
  const id = Number(targetChapterId) || 0;
  // ⚠️ 只清**这一章**的槽位：单槽里的快照可能属于作者刚切过去的另一章，
  // 无条件清掉等于把那一章还没落盘的字丢掉（这些槽位是"作者的东西"，不是本次采纳的附属品）。
  const keepOther = (snap) => (snap && Number(snap.id) === id ? null : snap);
  state.editorSaveSnapshot = keepOther(state.editorSaveSnapshot);
  state.editorEmptyBlocked = keepOther(state.editorEmptyBlocked);
  state.editorSaveFailedSnapshot = keepOther(state.editorSaveFailedSnapshot);
  state.editorConflictSnapshot = keepOther(state.editorConflictSnapshot);
  // F3 补充（2026-10-06）：这一章任何"与本次写入不一致"的在途稿子都是采纳前那一版。
  // 不撤掉它，自动重试随后会把它落盘，把刚采纳的新正文倒回旧稿 ——
  // 作者点的这一次写入必须**留在**正文里（覆盖掉的那些服务端已存历史版本，不会丢内容）。
  discardSupersededEditorWorkFor(id, html);
  const chapter = (state.chapters || []).find((c) => Number(c.id) === Number(targetChapterId));
  if (chapter) {
    chapter.content = html;
    // 用服务端回包里的真实版本标记（不是本地 new Date()）：编辑保存的乐观锁
    //（_if_updated_at）以它为准，本地时钟与服务端不同口径会让下一次保存白白 409。
    if (newUpdatedAt) chapter.updated_at = newUpdatedAt;
  }
  state.chapterDraft = null;
  await refreshChapterRecovery(targetChapterId).catch(() => { /* 恢复条刷新失败不影响已成功的写入 */ });
}

/**
 * 真并发冲突时给作者一个明确的出口（旧实现只有一句 toast + 编辑器回滚）。
 * 返回 true = 以编辑器当前内容覆盖服务端那一版；false/null = 这次不写。
 * 安全前提：覆盖时服务端会把被覆盖的正文存成一条历史版本，所以不是不可逆操作。
 */
function showAdoptConflictDialog(chapterId, serverHash) {
  return new Promise((resolve) => {
    state.pendingAdoptConflict = { chapterId: Number(chapterId) || 0, serverHash: String(serverHash || ''), resolve };
    openModal({
      title: '这一章在别处被改过了',
      body: `<div class="muted">这一章的正文在我确认之后发生了变化，为避免静默覆盖更新的内容，本次采纳已被拒绝（你的编辑器内容仍在，没有被清掉）。</div>
        <div class="muted mt-8">选择「以我的当前内容覆盖」会把服务端那一版存成一条历史版本后再写入；选择「先不写」可以稍后手动重试。</div>`,
      footer: `<button class="btn secondary" data-action="adopt-conflict-cancel">先不写</button>
        <button class="btn" data-action="adopt-conflict-force">以我的当前内容覆盖</button>`,
      // 点遮罩不关：这个框的答案决定"要不要覆盖正文"，误触关闭等于把选择丢掉。
      protectedBackdrop: true
    });
  });
}

/**
 * 采纳被拒时，什么才算"真的并发冲突"（见 handleAdoptFailure）。
 * 服务端这几句才是并发/基线冲突：正文基线 hash 不一致、版本标记已推进、提案在采纳过程中被改。
 * 其它拒绝（完整性、护栏、空正文…）有各自的原因，不该被塞进"这一章在别处被改过了"这个框里。
 */
const ADOPT_CONFLICT_RE = /基线|版本已推进|在采纳过程中被修改|在界面确认后发生了变化|并发/;

/**
 * F2（2026-10-06）：被零损失护栏拦下的记忆提案必须**说出来**。
 *
 * 正文此刻已经写进去了，所以这句只讲"哪条记忆提案没入账、为什么"——不假装整次失败，
 * 也不让作者以为"什么都没发生"。提案仍留在待处理里，可修正后再采纳。
 */
function reportLegacyGuardFailures(guardFailed) {
  const list = Array.isArray(guardFailed) ? guardFailed : [];
  if (!list.length) return;
  const why = list.map((g) => (g.reasons || []).join('；')).filter(Boolean).join(' ／ ');
  toast(`正文已写入；有 ${list.length} 条长期记忆提案未通过零损失护栏（已保留待处理，可修正后再采纳）：${why.slice(0, 180)}`, 'error');
}

/**
 * 采纳的失败出口：真并发 409 走确认框，其余按原文案报错。
 * 被拒绝的那一次**什么都没写**（服务端整次事务回滚），所以这里只需要如实告知 + 让作者选。
 */
async function handleAdoptFailure(e, chapterId, contextText) {
  const msg = String((e && e.message) || '未知错误');
  // ⚠️ 只有**真的并发/基线冲突**才进"以我的当前内容覆盖"那个框。旧判据是"409 + 文案含『采纳失败』"，
  // 于是任何被服务端拒绝的采纳（此前正是零损失护栏那条）都被报成"这一章在别处被改过了"；
  // 作者点「覆盖」再失败一次，看到的仍是同一句「覆盖仍未成功（正文没有被改动）」
  //（2026-10-06 报障的形状：一条护栏错误被包装成并发冲突，把作者引到错误的出口上）。
  if (e && e.status === 409 && /采纳失败/.test(msg) && ADOPT_CONFLICT_RE.test(msg)) {
    const fresh = await readChapterBaseline(chapterId);
    if (await showAdoptConflictDialog(chapterId, fresh && fresh.content_hash)) return 'retry';
    toast('已取消本次采纳：正文没有被改动（编辑器内容仍保留）', 'error');
    return 'cancel';
  }
  toast(`${contextText}：${msg}`, 'error');
  return 'cancel';
}

/**
 * 把编辑器当前内容（+ 本次勾选的入账提案）作为**一次**原子采纳提交给服务端。
 *
 * 时序（2026-10-02 事故驱动的修正，顺序本身就是修复的一部分）：
 *   1) await flushSave()：本页待落的编辑器快照先落库 —— 否则服务端的版本标记会被
 *      "稍后才到的自动保存"推进，采纳随即撞上版本闸门（真实事故：同一秒内先保存后采纳）；
 *   2) 现读服务端权威基线（content_hash）—— 不再用内存里可能过期的 updated_at；
 *   3) POST /novel/adopt：正文 + 提案 + 历史版本 + 投影 outbox 同一事务；
 *   4) 成功后才清定时器/快照（旧实现顺序相同，但没有第 1、2 步），并收起草稿提示。
 *
 * 真并发（第 2 步之后别人写了正文）→ 服务端 409 → 由调用方弹确认框，让作者显式选择覆盖。
 * 返回 { adopted, draftAppliedId, guardFailed }；抛出的错误带 .status 供调用方区分冲突与普通失败。
 */
async function adoptEditorContentImpl(options = {}) {
  const { targetChapterId, html, selectionIds = [], selectionRefs = [], forceContentHash = '', adoptKind = 'ai_result' } = options;
  const opKey = `aw-${targetChapterId || 0}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 1) 先落本页待保存的内容（只等待落盘，**不弹任何提示**）。
  // ⚠️ 这里刻意用 flushEditorSaves 而不是 flushSave（2026-10-02 晚）：采纳/合并这条路的正文
  // 来自 `html` 参数（调用方算好的最终稿），**不依赖编辑器**；而 flushSave 会在编辑器为空时
  // 弹出"本章编辑器是空的，已暂停保存"——作者看到的却是"修稿无法合并到正文"（真实报障）。
  // 提示只属于导航，不属于任何"内部等待落盘"的调用点。
  await flushEditorSaves();
  // 2) 权威基线：content_hash 优先（服务端口径），拿不到就退回读取到的 updated_at
  const baseline = forceContentHash
    ? { content_hash: forceContentHash, updated_at: '' }
    : await readChapterBaseline(targetChapterId);
  const expected = {};
  if (baseline && baseline.content_hash) expected.content_hash = baseline.content_hash;
  else if (baseline && baseline.updated_at) expected.updated_at = baseline.updated_at;
  const res = await api('/novel/adopt', {
    method: 'POST',
    body: {
      work_id: state.workId || state.work?.id || null,
      chapter_id: targetChapterId,
      content: html,
      legacy_proposal_ids: Array.isArray(selectionIds) ? selectionIds : [],
      // 带来源类型的引用才是权威形式（见 proposalRefOf）：裸 id 在两表同号时，
      // 服务端会把作者没勾的那几条一起卷进来。
      legacy_proposal_refs: Array.isArray(selectionRefs) ? selectionRefs : [],
      operation_key: opKey,
      adopt_kind: adoptKind,
      expected,
    }
  });
  await afterAdoptApplied(targetChapterId, html, res && res.adopt ? String(res.adopt.chapter_updated_at || '') : '');
  // 服务端没带回版本标记时（老服务端/异常回包）**补读一次**：采纳已经把正文与 updated_at
  // 都推进了，本地若还停在旧标记，下一次编辑保存必然 409 —— 而"冲突的另一方"就是本人刚做的采纳。
  await refreshChapterBaselineAfterForeignWrite(targetChapterId);
  const legacy = (res && res.adopt && res.adopt.legacy) ? res.adopt.legacy : null;
  const adopted = legacy ? (Number(legacy.events || 0) + Number(legacy.memories || 0)) : 0;
  // F2（2026-10-06）：被零损失护栏拦下的记忆提案不再让整次采纳失败 —— 它留在 pending 待作者修正，
  // 原因随回包上来，由调用方如实告知。正文已经写进去了。
  const guardFailed = (legacy && Array.isArray(legacy.guard_failed)) ? legacy.guard_failed : [];
  const draftAppliedId = res && res.adopt ? (Number(res.adopt.draft_applied_id) || null) : null;
  return { adopted, draftAppliedId, guardFailed };
}

async function applyAIWritingArticle(mode, article, chapterId = null) {
  // 空产出不是"可以应用的结果"（2026-10-02 事故复盘补）：替换/追加一条空产出会让编辑器变空，
  // 而 800ms 后就是自动保存。这里在动编辑器**之前**就拦下，正文一个字都不动。
  if (mode !== 'insert' && editorSnapIsBlank(article)) {
    toast('AI 这次没有产出任何正文：正文未被改动（结果仍留在弹窗/草稿里，可重试）', 'error');
    return;
  }
  const editor = $('#editor-content');
  if (!editor) {
    // N1：此前这里直接 return —— 结果弹窗关掉、什么都不发生、也没有任何提示，
    // 用户会以为"已经插入/替换成功"。非写作视图（总览/设定等）取回结果时就会撞上。
    // 现在把产出留成草稿并说明去哪找，绝不静默吞掉一次几分钟的等待。
    // 章号同样优先用调用方给的（任务自带），避免把草稿落到"当前恰好打开的那一章"。
    const targetChapterId = Number(chapterId) || state.currentChapterId;
    try {
      if (targetChapterId) {
        // 与 showAIWritingResult 落草稿时同一写法（content 存原文，取回走 /novel/chapter_save）
        await api('/novel/draft', { method: 'POST', body: { chapter_id: targetChapterId, content: article } });
        await refreshChapterRecovery(targetChapterId);
      }
    } catch (_) { /* 落草稿失败也要把话说清楚 */ }
    toast('当前不在正文写作页，未直接写入；结果已存为本章草稿——回到「正文写作」页顶部的取回条即可应用', 'error');
    return;
  }
  // R03：正文与应用到正文的提案是**一次操作**。旧实现是"编辑器改动 → 800ms 自动保存（PUT）"，
  // 提案由弹窗另发一次请求——两处写库没有原子性。现在改成：先把最终 HTML 算出来，
  // 用 /novel/adopt 一次提交（正文 + 本次勾选提案 + 历史版本 + 投影 outbox），成功后才取消定时保存。
  const selection = state.pendingProposalSelection;
  state.pendingProposalSelection = null;
  const targetChapterId = Number(chapterId) || Number(state.currentChapterId) || null;
  const beforeHtml = editor.innerHTML;
  const selectionIds = (selection && Array.isArray(selection.ids)) ? selection.ids : [];
  const selectionRefs = (selection && Array.isArray(selection.refs)) ? selection.refs : [];
  // F3（2026-10-06 作者要求）：替换当前正文 = 把这一章正文整段换掉。作者手里若还压着一版
  // **没落盘**的旧内容，先问「旧内容是否保存？」（是/否），而不是静默替作者落盘。
  // ⚠️ 必须问在 applyAIReply 之前：它会先 manualSaveChapter（把旧内容静默写库）再替换编辑器，
  // 到采纳那一步再问，状态槽里已经是新内容 —— 分不清新旧，也来不及。
  // 两个答案都继续写入：它问的是旧那一版怎么处理，不是"要不要继续"。
  if (mode === 'replace') {
    await settleOldContentBeforeOverwrite(targetChapterId).catch(() => '');
  }
  const adoptEditorContent = async (forceContentHash = '') => {
    return adoptEditorContentImpl({ targetChapterId, html: editor.innerHTML, selectionIds, selectionRefs, forceContentHash });
  };
  // 采纳失败收敛到一处：409 由作者在确认框里决定（覆盖 / 先不写），其余如实报错。
  // 无论哪种结局都要刷新恢复条：服务端此时可能已经有一份新草稿（这条路径此前完全不刷新，
  // 于是"有未应用的生成稿"要等手动刷新页面才出现）。
  const settleAdoptFailure = async (e) => {
    const verdict = await handleAdoptFailure(e, targetChapterId, '写入失败（已还原编辑器内容，库中未改动）');
    if (verdict === 'retry') {
      try {
        const baseline = await readChapterBaseline(targetChapterId);
        const again = await adoptEditorContent(baseline && baseline.content_hash ? baseline.content_hash : '');
        toast(again.adopted ? `已按你的选择覆盖服务端版本，并采纳 ${again.adopted} 条提案` : '已按你的选择覆盖服务端版本', 'success');
        reportLegacyGuardFailures(again.guardFailed);
        return again;
      } catch (e2) {
        toast('覆盖仍未成功（正文没有被改动）：' + e2.message, 'error');
      }
    }
    // 先不写 / 覆盖失败：保留编辑器现状，让作者看得到"还有一份未应用的生成稿"。
    editor.innerHTML = beforeHtml;
    await refreshChapterRecovery(targetChapterId).catch(() => { /* 辅助提示失败不影响写作 */ });
    return null;
  };
  if (mode === 'insert') {
    insertHtmlAtCursor(editor, textToParagraphsHtml(article));
    try {
      const { adopted, guardFailed } = await adoptEditorContent();
      toast(adopted ? `已插入 AI 写作内容，并采纳 ${adopted} 条提案` : '已插入 AI 写作内容', 'success');
      reportLegacyGuardFailures(guardFailed);
    } catch (e) {
      await settleAdoptFailure(e);
    }
  } else if (mode === 'replace') {
    const sel = getEditorSelection(editor);
    await applyAIReply(editor, article, sel?.range || null);
    try {
      const { adopted, guardFailed } = await adoptEditorContent();
      if (adopted) toast(`已采纳 ${adopted} 条提案`, 'success');
      reportLegacyGuardFailures(guardFailed);
    } catch (e) {
      await settleAdoptFailure(e);
    }
  } else if (mode === 'append') {
    editor.focus();
    editor.insertAdjacentHTML('beforeend', textToParagraphsHtml(article));
    try {
      const { adopted, guardFailed } = await adoptEditorContent();
      toast(adopted ? `已追加 AI 写作内容，并采纳 ${adopted} 条提案` : '已追加 AI 写作内容', 'success');
      reportLegacyGuardFailures(guardFailed);
    } catch (e) {
      await settleAdoptFailure(e);
    }
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

// ---------- 已保存蓝图：生成 / 查看 / 删除（历史条上的三个按钮，2026-10-06 作者要求）----------
// 作者原话：「已保存的蓝图必须全部显示出来，并增加按钮"生成"：按照此蓝图生成正文；
// 增加按钮"删除"：删除当前蓝图」。三者的行为边界：
//   · 生成 —— 必**先**进入「📐 章节蓝图 · 请确认或修改」界面（作者明确要求），确认后才成文；
//   · 查看 —— 只读，按六字段看全文（历史条那一行只放 46 字摘要）；
//   · 删除 —— 只删蓝图，**不动正文与历史版本**。

/** 在本地缓存里按 id 找一份已保存蓝图（找不到返回 null）。 */
function savedBlueprintById(id) {
  return (state.chapterBlueprints || []).find((b) => Number(b.id) === Number(id)) || null;
}

/**
 * 「生成」：按这份已保存蓝图生成正文。
 *
 * 为什么不在这里直接调成文接口：作者要求"点生成先进入确认界面"。把蓝图交给 AI 写作管线
 * （opts.blueprint）即可 —— 管线会先弹确认框（可改、可跳过、可取消），点「按此蓝图成文」后
 * **跳过向模型要蓝图的那一轮**，直接装配上下文并成文。这样成文、质检、结果弹窗、草稿落库
 * 全部复用同一条已验证的链路，不存在第二套成文实现。
 */
async function generateFromSavedBlueprint(id) {
  const row = savedBlueprintById(id);
  if (!row) { toast('这份蓝图已经不在了（可能已被删除）：刷新后再试', 'error'); return; }
  if (!Object.values(row.blueprint || {}).some((v) => String(v || '').trim())) {
    toast('这份蓝图没有可读内容：换一份，或直接点「✍️ AI 写作」重新规划', 'error');
    return;
  }
  if (state.aiWritePipelineRunning) {
    toast('本次写作还在进行中：请等它结束，或先点进度卡上的「停止」', 'error');
    return;
  }
  // requirement 传 null：方向由这份蓝图本身承担（与"作者刚确认蓝图"那条路径同一语义）。
  await performToolbarAIWrite(null, { blueprint: row.blueprint });
}

/** 「查看」：只读弹窗，按六字段展示这份蓝图的完整内容。 */
function viewSavedBlueprint(id) {
  const row = savedBlueprintById(id);
  if (!row) { toast('这份蓝图已经不在了（可能已被删除）：刷新后再试', 'error'); return; }
  const when = String(row.created_at || '').replace('T', ' ').slice(0, 16);
  openModal({
    title: '📐 已保存蓝图（只读）',
    body: `<div class="muted" style="margin-bottom:6px">保存于 ${esc(when)}${Number(row.target_words) ? ` · 目标 ${Number(row.target_words)} 字` : ''}</div>
      <div class="bp-view">${esc(blueprintFullText(row.blueprint)).replace(/\n/g, '<br>')}</div>`,
    footer: `<button class="btn" data-action="bp-generate" data-id="${Number(row.id)}">按此蓝图生成正文</button>
      <button class="btn secondary" data-close-modal>关闭</button>`,
    large: true,
    // 纯只读内容：点遮罩就关（与 openModal 的默认保护相反，信息类弹窗可显式例外）。
    protectedBackdrop: false
  });
}

/**
 * 「删除」：删掉这一份已保存蓝图（只删蓝图，正文与历史版本都不动）。
 * 服务端返回删除后的**真值**列表，界面照它重画——不自己算"还剩几份 / 最新是哪一份"。
 */
async function deleteSavedBlueprint(id) {
  const row = savedBlueprintById(id);
  const chapterId = Number(state.currentChapterId) || 0;
  if (!row || !chapterId) { toast('找不到这份蓝图：刷新后再试', 'error'); return; }
  if (!confirm('删除这一份已保存的蓝图吗？\n\n· 只删蓝图：正文与历史版本都不动；\n· 删除后不能再按它生成正文。')) return;
  try {
    const res = await api('/novel/chapter_blueprints', {
      method: 'DELETE',
      body: { chapter_id: chapterId, blueprint_id: Number(row.id) }
    });
    state.chapterBlueprints = Array.isArray(res.blueprints) ? res.blueprints : [];
    if (Number(res.limit)) state.chapterBlueprintLimit = Number(res.limit);
    refreshRecoveryBar(chapterId);
    toast('已删除这一份蓝图（正文未改动）', 'success');
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

// 蓝图确认弹窗：字段可编辑；resolve 蓝图对象 / {skip:true}（跳过蓝图直接成文）/ null（取消）。
function showBlueprintConfirm(blueprint) {
  return new Promise((resolve) => {
    state.pendingBlueprint = resolve;
    const b = blueprint || {};
    openModal({
      title: '📐 章节蓝图 · 请确认或修改',
      body: `
        <div class="muted mb-8">AI 根据本章需求生成了蓝图，写作将严格围绕它展开；可修改后再「按此蓝图成文」，蓝图会保存到章节并参与后续上下文与一致性核对。${helpDot('blueprint')}</div>
        <div id="bp-empty-hint" class="redline-scan warn" hidden>⬆ 六个字段不能全为空：请至少填写一项，或改用「跳过蓝图直接成文」。</div>
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
      large: true,
      // 点遮罩不关（2026-10-04 作者报障同一类）：这是一个要填/要改的表单，而且"关掉"等于
      // 放弃这次写作。误触遮罩不该等同于"我不写了"——要么改完点「按此蓝图成文」，要么明确点「取消」。
      protectedBackdrop: true
    });
  });
}

// 上下文是否被预算截断/溢出。
// 用途：慢通道能"用工具取回被截断的原文"，直连不能 —— 所以**截断时不用直连**。
// 取不到上下文元数据时保守返回 true（宁可慢，不要基于残缺资料生成蓝图）。
function aiContextTruncated() {
  const ctx = state.aiContext;
  if (!ctx) return true;
  if (ctx.context_overflow) return true;
  const manifest = Array.isArray(ctx.context_manifest) ? ctx.context_manifest : [];
  if (manifest.some((m) => m && (m.truncated || Number(m.dropped) > 0))) return true;
  const stats = ctx.context_stats || {};
  return Number(stats.truncatedLayers) > 0;
}

/**
 * 给"装配上下文"这类**没有进度出口**的服务端往返配一张进度卡（2026-10-02）。
 *
 * 为什么必须补：点「按此蓝图成文」之后，界面要等 `loadAIContext` 返回才开始弹成文进度卡。
 * 那次装配是 10–30 秒的服务端往返，期间界面上**什么都没有**——作者看到的就是"点了没反应"。
 * 卡上只显示阶段文案 + 每秒计时（由 showAITaskProgress 自带），不伪造百分比。
 * 完成后再补一行"装配完成（用时 Ns）"，让作者知道刚才那段时间花在哪。
 */
async function withContextProgress(work, label) {
  const card = showAITaskProgress(label);
  const t0 = Date.now();
  try {
    const r = await work();
    const ms = Math.round((Date.now() - t0) / 1000);
    card.note(`上下文装配完成（用时 ${ms}s），正在进入下一步…`);
    return r;
  } catch (e) {
    card.note(`上下文装配失败（用时 ${Math.round((Date.now() - t0) / 1000)}s）：${e && e.message ? e.message : e}`);
    throw e;
  } finally {
    // 留 400ms 让"完成/失败"那行能被看见：这张卡马上会被下一步（蓝图或成文）的卡替换。
    setTimeout(() => card.close(), 400);
  }
}

/**
 * 「重写本章」跳层集合（作者 2026-10-04 决定）。
 *
 * 点「AI 写作」= 把这一章重写一遍：**本章既有记录一概不看** —— 上一版蓝图、本章摘要
 * （当前场景）、长期记忆、事件账本、未闭合伏笔、本作章节的语义召回。保留的是"这本书的设定"：
 * 作品简介、角色卡、世界观、词条、大纲与剧情线、写作纪律/编辑规则。
 *
 * 为什么成文轮（PROSE）少一项 blueprint：规划轮要的是"重新规划"，所以旧蓝图必须不可见；
 * 而成文轮发生在作者**确认新蓝图之后**，那一层此时装的就是新蓝图 —— 留着它才对。
 * 两张表都由服务端白名单校验（见 server.js 的 OMITTABLE_LAYERS），拼错的名字会被忽略而不是报错。
 */
const REWRITE_OMIT_LAYERS = ['blueprint', 'scene', 'memory', 'events', 'foreshadows', 'recall'];
const REWRITE_OMIT_LAYERS_PROSE = REWRITE_OMIT_LAYERS.filter((x) => x !== 'blueprint');

/**
 * 记一条客户端日志，**但绝不让日志本身影响业务**（2026-10-04）。
 * 为什么要这个包装：失败路径里加日志时，我第一版把 `proseRoute`（它声明在更里层的块里）写进了
 * context → catch 块自己抛 `ReferenceError` → **错误弹窗与"落草稿"整段被跳过**，
 * 表现为"任务失败但什么都没显示"。日志是旁路，它绝不能有能力改变被记录的那件事；
 * 同步异常与 promise 拒绝都要吞掉。加日志后必须重跑回归（这次的 108q/115e 就是它抓到的）。
 */
function reportClientLogSafe(payload) {
  try { Promise.resolve(reportClientLog(payload)).catch(() => { /* 日志失败只影响可观测性 */ }); }
  catch (_) { /* 同上 */ }
}

/**
 * 本条写作管线。
 *
 * @param requirement 作者在需求框里写的方向（可空）。
 * @param opts.blueprint 「按已保存蓝图生成正文」入口（2026-10-06 历史条上的「生成」按钮）：
 *   传一份已保存的蓝图时，**跳过向模型要蓝图的那一轮**，直接把它交给确认弹窗（作者要求：
 *   点「生成」必须先进入「章节蓝图 · 请确认或修改」界面），确认后走同一条成文链路。
 */
async function performToolbarAIWrite(requirement, opts = {}) {
  // 本次是否"蓝图已经定了"：只有从历史条「生成」进来时才为真。
  const preseededBlueprint = (opts && typeof opts.blueprint === 'object' && opts.blueprint) ? opts.blueprint : null;
  const editor = $('#editor-content');
  if (!editor) return;
  // F-43 同款互斥：**入口就置位**。旧实现直到蓝图轮才由 runHarnessJob 置位，而入口的
  // 上下文装配是十几秒的静默期 —— 那段时间连点两次会真的发起两次写作（付费 + 双份草稿）。
  // 入口互斥（2026-10-02）：旧实现直到蓝图轮才由 runHarnessJob 置位，而入口的上下文装配
  // 是十几秒的静默期 —— 那段时间连点两次会真的发起两次写作（付费 + 双份草稿）。
  // 用**管线专用**标志位，不复用 aiTaskRunning（见 state 里的说明）。
  if (state.aiWritePipelineRunning) {
    // 这条静默 return 同样要留痕：它表现为"点了没反应"，事后没有任何线索（2026-10-04）。
    reportClientLogSafe({
      level: 'warn', kind: 'ai_write_rejected_busy',
      message: '[AI] 写作入口被拒：上一次写作仍在进行中（管线互斥）',
      context: { work_id: state.workId || null, chapter_id: Number(state.currentChapterId) || null }
    });
    toast('本次写作还在进行中，请等它结束或先点进度卡上的「停止」', 'error');
    return;
  }
  state.aiWritePipelineRunning = true;
  // 本次写作的章节标题（`buildWritingDirectionFromBlueprint` 的兜底文案要用它）：
  // 在**入口**读一次，之后切章也不影响这一轮（与 writeChapterId 同一个理由）。
  const currentChapterTitle = (state.chapters || []).find((c) => Number(c.id) === Number(state.currentChapterId))?.title || '';
  // 🧭 入口装配：**每次点「AI 写作」都先出蓝图**（作者 2026-10-04 要求）。
  //
  // 旧实现在"本章已有 blueprint_json"时静默沿用旧蓝图、跳过蓝图轮：作者因为前文改动、
  // 或对上一版蓝图不满意而再点一次（包括结果弹窗里的「重新生成」）时，AI 仍按那份旧蓝图
  // 写正文，界面上只留一句"检测到本章已有蓝图" —— 他既没有机会改，也看不出为什么没重新规划。
  //
  // 现在一律 phase=defer（不查资料、不插占位），并显式带上「重写本章」跳层集合：
  // 上一版蓝图与"前面发生过什么"（记忆/事件/伏笔/召回/本章摘要）**都不进这一轮上下文**。
  // 必要性有实测依据 —— 蓝图层标题是「本章蓝图（写作必须遵守）」，留着它，模型会把
  // "重新规划"做成"复述旧计划"；其余几层则是它拿旧事实来反问作者的来源
  // （证据见 docs/blueprint-regenerate-20261004.md）。作者确认新蓝图后再做唯一一次方向召回。
  await withContextProgress(
    () => loadAIContext({ libraryRecallPhase: 'defer', omitLayers: REWRITE_OMIT_LAYERS }),
    'AI 写作（0/3 准备）· 正在装配上下文（资料召回 + 分层装配，通常 10–30 秒）…');
  const btn = $('[data-action="toolbar-ai-write"]');
  if (btn) btn.disabled = true;
  // 🐞 运行追踪：记录本次写作是被取消还是正常结束，用于收尾时的操作状态。
  let traceWriteCancelled = false;
  // ⚠️ 章号在**入口**定下来，并一路传给结果弹窗与"应用"动作。
  // 一次 AI 写作 2–6 分钟（蓝图→成文→质检→补足多轮），期间切章是正常操作；
  // 而结果弹窗打开时若现读 state.currentChapterId，就会把"这一章写出来的稿子"记成另一章的，
  // 后面的「先审稿再应用 → 按清单修稿 → 合并到正文」会把 A 章的稿整篇写进 B 章（旧稿只进历史版本）。
  // （第五轮重审抓到：三处 showAIWritingResult 都没传 meta.chapterId。）
  const writeChapterId = Number(state.currentChapterId) || null;
  const jobBase = {
    timeout: longAiTimeout(),
    model: policyModel('fast'),
    action: 'write',
    work_id: state.workId || state.work?.id || undefined,
    chapter_id: writeChapterId || undefined,
    mode: 'continuation',
    // 归属标记：刷新/重启后据此把产出当「成文」处理（落草稿 + 打开结果弹窗）。
    kind: 'prose',
    stage: 'AI 写作'
  };
  // 🔁 成文轮流式中断时已经收到的正文。**为什么必须记在这一层**：成文流一出问题就回退慢通道
  // 从头重新生成（质量优先下的正确选择），于是 streamAIDirectWrite 抛的那个错误会被换成
  // 慢通道自己的错误 —— 不在管线层接住，那段正文就随着被替换掉的错误一起消失了。
  // 只在整条管线最终失败时才落草稿：慢通道成功就不需要它，免得顶掉「取回生成稿」里的好稿。
  let interruptedPartial = '';
  try {
    const initial = buildAIWritingInitialRequest(requirement || '');
    const history = [];
    const targetWords = resolveTargetWords();
    let maxTurns = 10;
    // ⏱ 成文耗时账本（口径 A：点击 → 草稿进结果弹窗）。只测量，不参与任何决策。
    const timing = newWriteTiming();

    // 阶段 A：澄清 → 章节蓝图
    // 每一次写作都从这里开始：不再有"沿用已保存蓝图"的分支（2026-10-04）。
    while (maxTurns-- > 0) {
      let jobMeta = null;
      let parsed;
      // 🧭 「按已保存蓝图生成正文」：蓝图已经定好了，这一轮**不再向模型要蓝图**
      // （作者 2026-10-06 要求：点「生成」先进入「章节蓝图 · 请确认或修改」界面）。
      // 只在第一轮生效：弹窗里的「跳过蓝图直接成文 / 取消」与后续任何一轮都照常走规划轮。
      const usePreseeded = !!preseededBlueprint && history.length === 0;
      const lastMsg = history.length ? history[history.length - 1] : null;
      const stageLabel = !history.length
        ? 'AI 写作（1/3 蓝图）· 正在阅读章节与设定，准备提问…'
        : (lastMsg?.content || '').includes('【提问】')
          ? 'AI 写作（1/3 蓝图）· 已收到回答，正在生成章节蓝图…'
          : 'AI 写作（1/3 蓝图）· 正在按反馈重新规划蓝图…';
      const blueprintPrompt = usePreseeded ? '' : buildAIWritingBlueprintPrompt(initial, history, targetWords);
      // S1（2026-09-18 实测驱动）：蓝图轮优先走**直连**——省掉慢通道每次 ≈17 秒的固定开销
      // （实测：微型任务 直连 0.6s vs 慢通道 17.9s；同一条真实蓝图提示词 19.1s vs 47.3s，
      //   两者都产出 `【蓝图】` 首行 + 6/6 字段）。
      // 两道保险：① 上下文被预算截断时不用直连（慢通道能取回被截断的原文）；
      //           ② 直连失败/空回复 → 自动回退慢通道（directAIWrite 内部已对"思考吃光预算"重试过一次）。
      let raw = '';
      // ⏱ 这一轮蓝图（直连 + 可能的慢通道回退）的墙钟耗时
      const blueprintStartedAt = Date.now();
      // 慢通道那条路的结果（scan / proposals / job_id）——直连时为 null。
      // ⚠️ jobMeta 在**循环体顶部**声明：下面两个降级分支要用它，且不能随本 else 块消失。
      // 重审抓到过一版把它写成 if 块内的 `const data`，块外引用即 ReferenceError（node --check 查不出来）。
      if (!usePreseeded && !aiContextTruncated()) {
        // 直连也要出进度卡：否则界面会静默十几秒（用户以为是卡死）。
        // 进度卡自带每秒计时，正好补上"直连没有 stage 推送"这个短板。
        const card = showAITaskProgress(stageLabel);
        try {
          const viaDirect = await directAIWrite([{ role: 'user', content: blueprintPrompt }], {
            model: policyModel('fast'), maxTokens: 8192
          });
          if (viaDirect) raw = viaDirect;
        } finally {
          card.close();
        }
      }
      if (!usePreseeded && !raw.trim()) {
        // 🧭 规划轮的慢通道任务带上「本次是重新规划」标记（2026-10-04）：
        // 慢通道的模型**带着检索工具**（novel_context / novel_lookup），那两条路会各自
        // 去服务端取上下文与搜索结果 —— 不带这个标记，工具就能把上一版蓝图原文端出来，
        // 于是"重新规划"又变成"照着旧计划提问/复述"。环境变量透传到子进程，插件按标记
        // 追加 omit_layers 并跳过检索结果里的蓝图摘要（见 harness-plugins/novel-writing/novel-tools.mjs）。
        // 成文轮**不带**这个标记：那时新蓝图已确认，必须能被查到。
        jobMeta = await runHarnessJob(
          {
            ...jobBase,
            // 🏷 蓝图轮**不是**「成文」：kind 单独标出来。恢复条据此把它显示成「📐 蓝图」，
            // 并且不再提供「取回结果并应用」—— 把一份【蓝图】JSON 当正文写进章节，
            // 正是 2026-10-01 / 2026-10-04 两次真实事故的形状（作者 2026-10-06 报障同一处）。
            kind: 'blueprint',
            stage: '蓝图',
            prompt: blueprintPrompt,
            env: { ...(jobBase.env || {}), NOVEL_OMIT_LAYERS: REWRITE_OMIT_LAYERS.join(',') }
          },
          stageLabel
        );
        raw = jobMeta.output || '';
      }
      if (!usePreseeded && !raw.trim()) {
        // N-02：把原始输出挂到错误上，供错误弹窗回显（此前失败只有瞬态 toast，用户看不到任何原因）。
        const err = new Error('AI 没有返回内容');
        err.rawOutput = '（AI 任务输出为空）';
        throw err;
      }
      if (usePreseeded) {
        // 蓝图由作者从「已保存蓝图」里选定：没有模型输出可解析，直接把它交给确认弹窗。
        // 字数同样用本次的目标字数（与规划轮确认后的口径一致），不沿用这份蓝图当初存下的值。
        parsed = { blueprint: { ...preseededBlueprint } };
      } else {
        // ⏱ 记这一轮蓝图：via 是**实际**用到的通道（直连失败回退慢通道时记 harness）
        timing.round('blueprint', Date.now() - blueprintStartedAt, { via: jobMeta ? 'harness' : 'direct' });
        // 蓝图走**抢救式**解析：模型在 JSON 值里写裸引号（2026-10-01 事故）时，
        // 严格解析必然失败；旧路径会把整篇蓝图兜底成「成文」，于是蓝图既没进弹窗、也没进
        // chapters.blueprint_json，而是被当成正文写进了章节。
        const bpParsed = parseBlueprintJSON(raw);
        if (bpParsed.blueprint) {
          if (bpParsed.stage === 'salvaged') {
            reportClientLog({
              level: 'warn', kind: 'blueprint_json_salvaged',
              message: `[写作] 蓝图 JSON 严格解析失败，已按字段抢救出 ${Object.keys(bpParsed.blueprint).length}/${BLUEPRINT_FIELDS.length} 个字段（原样回显，请作者确认后成文）`,
              context: { work_id: state.workId || null, chapter_id: writeChapterId, chars: String(raw).length }
            });
          }
          parsed = { blueprint: bpParsed.blueprint };
        } else {
          parsed = parseAIWritingOutput(raw);
        }
      }

      if (parsed.blueprint) {
        // 目标字数一律用本次的值（不再有"沿用旧蓝图自带字数"这条分支）。
        parsed.blueprint.target_words = targetWords;
        // 每一次都让作者确认：这正是"先出蓝图"的意义 —— 他能改、能重规划、也能跳过。
        const confirmed = await showBlueprintConfirm(parsed.blueprint);
        if (confirmed === null) return; // 作者取消
        let blueprintSaved = false;
        if (!confirmed.skip && state.currentChapterId) {
          try {
            await api('/novel/chapter_blueprint', {
              method: 'PUT',
              body: { chapter_id: state.currentChapterId, blueprint: confirmed, target_words: Number(confirmed.target_words) || 0 }
            });
            blueprintSaved = true;
            toast('章节蓝图已保存', 'success');
          } catch (e) {
            toast('蓝图保存失败：' + e.message, 'error');
          }
        }
        // 蓝图没存上也要让用户知道：否则后续上下文与一致性核对都拿不到这份蓝图，
        // 而界面上看起来一切正常（2026-09-14 真实事故里 blueprint_json 就是空的）。
        if (!confirmed.skip && !blueprintSaved) {
          toast('注意：本章蓝图未保存，后续上下文与一致性核对不会包含它', 'error');
        }
        const target = Number(confirmed.target_words) || targetWords;
        const blueprintForProse = confirmed.skip ? null : confirmed;
        // 作者刚确认的蓝图 = 本次写作方向。生成正文前执行一次方向相关刷新
        //（这是本次唯一的真实资料召回；defer 阶段不搜索资料，规划轮也不带旧蓝图层）。
        //
        // 2026-10-02：这次装配此前是**静默**的（点完「按此蓝图成文」后界面十几秒没有任何反馈），
        // 现在用 withContextProgress 配进度卡，并把这段耗时单独记进成文账本（此前账本里根本没有它）。
        {
          const confirmedDirection = buildWritingDirectionFromBlueprint(blueprintForProse, requirement || currentChapterTitle);
          const ctxStartedAt = Date.now();
          // 「重写本章」同样作用于成文轮：这一轮的上下文也不带"前面发生过什么"。
          // 唯一区别是不跳 blueprint 层 —— 它现在装的是**作者刚确认的新蓝图**（PROSE 集合少一项）。
          const proseOmit = { omitLayers: REWRITE_OMIT_LAYERS_PROSE };
          try {
            if (confirmedDirection) {
              await withContextProgress(
                () => loadAIContext({ direction: confirmedDirection, directionSource: confirmed.skip ? 'fallback' : 'confirmed_blueprint', libraryRecallPhase: 'direction', ...proseOmit }),
                'AI 写作（2/3 准备）· 正在按确认蓝图装配上下文（资料召回 + 分层装配，通常 10–30 秒）…');
            } else {
              await withContextProgress(
                () => loadAIContext({ libraryRecallPhase: 'default', ...proseOmit }),
                'AI 写作（2/3 准备）· 正在装配上下文（资料召回 + 分层装配，通常 10–30 秒）…');
            }
          } catch (_) { /* 方向刷新失败不阻断写作：使用已取得正典上下文，资料层视为暂时不可用 */ }
          timing.round('context', Date.now() - ctxStartedAt, { via: 'assembler' });
        }
        const prosePrompt = buildAIWritingProsePrompt(initial, blueprintForProse, target);
        // 阶段 B（2/3）：按蓝图成文——质量优先模式：直连流式（快，正文逐字可见）+ flash 质检轮（保质量）。
        // 直连不可用或质检发现硬伤时自动回退 harness 精写内核。
        let proseData = null;
        // ⏱ 成文轮（含可能的慢通道回退）—— 一次成文里最长的一段，单独记账
        const proseStartedAt = Date.now();
        let proseRoute = 'direct';
        const maxTokens = Math.min(16384, Math.ceil(target * 2 + 2000)); // 目标字数×2+余量，防长文截断
        const activeConfig = await getActiveAIConfig();
        if (activeConfig && activeConfig.api_key) {
          try {
            proseData = await streamAIDirectWrite({
              config_id: activeConfig.id,
              model: policyModel('fast'),
              messages: [{ role: 'user', content: prosePrompt }],
              max_tokens: maxTokens,
              work_id: state.workId || state.work?.id || undefined,
              scan: true
            }, 'AI 写作（2/3 成文）· 正在流式生成正文…');
          } catch (e) {
            if (e.cancelled) throw e;
            // 回退慢通道是对的（质量优先），但这段已经写出来的正文不该跟着这个错误一起消失。
            interruptedPartial = String(e.partialText || '');
            reportClientLog({ level: 'warn', kind: 'ai_write_stream_fallback', message: `[AI] 成文流式直连失败，回退 harness：${e.message}` });
            proseData = null;
          }
        }
        if (!proseData) {
          proseRoute = 'harness';
          // 成文轮走慢通道时也带「重写本章」标记（少 blueprint 一项：新蓝图此刻应可见）。
          proseData = await runHarnessJob(
            { ...jobBase, prompt: prosePrompt, env: { ...(jobBase.env || {}), NOVEL_OMIT_LAYERS: REWRITE_OMIT_LAYERS_PROSE.join(',') } },
            'AI 写作（2/3 成文）· 精写内核生成中（这一步最慢，通常 2–6 分钟）…'
          );
        }
        let article = parseAIWritingOutput(proseData.text ?? proseData.output ?? '').finalText || '';
        // ⏱ 成文轮如实记账：TTFT 只有流式直连测得出来，慢通道记 null（不假装有数）。
        // token 明细（缓存命中 / 思考占比）同样只有流式直连才有 usage；慢通道拿不到就不编。
        const proseUsage = proseData.usage || null;
        const proseTokens = proseUsage ? {
          prompt_tokens: Number(proseUsage.prompt_tokens) || 0,
          cached_tokens: Number(proseUsage.prompt_cache_hit_tokens) || 0,
          completion_tokens: Number(proseUsage.completion_tokens) || 0,
          reasoning_tokens: Number(proseUsage.completion_tokens_details?.reasoning_tokens) || 0
        } : {};
        timing.round('prose', Date.now() - proseStartedAt, { via: proseRoute, ttft_ms: Number.isFinite(proseData.ttftMs) ? proseData.ttftMs : null, chars: article.length, ...proseTokens });
        if (!article.trim()) {
          const err = new Error('AI 没有返回正文内容');
          err.rawOutput = String(proseData.output ?? proseData.text ?? '').slice(-2000) || '（AI 任务输出为空）';
          throw err;
        }
        // 🚦 交付闸门（2026-10-01 事故）：成文轮回来的东西可能是"写作规划"而不是小说正文。
        // 旧路径对这种输出没有任何检查——只要不是空串，就会弹结果弹窗、一点就写进章节，
        // 于是【蓝图】JSON 成了第一章的正文。这里先判定一次，判定不通过就用纠正提示词重生成一次。
        let proseReject = detectNonProseOutput(article);
        if (proseReject) {
          reportClientLog({
            level: 'warn', kind: 'prose_output_rejected',
            message: `[写作] 成文轮返回的不是正文（${proseReject}），已用纠正提示词重生成一次`,
            context: { work_id: state.workId || null, chapter_id: writeChapterId, via: proseRoute, chars: article.length, head: article.slice(0, 80) }
          });
          proseData = await runHarnessJob(
            { ...jobBase, prompt: buildAIWritingProseRetryPrompt(proseReject, target) },
            'AI 写作（2/3 成文）· 上次返回的是规划不是正文，正在重新成文…'
          );
          proseRoute = 'harness';
          article = parseAIWritingOutput(proseData.output || '').finalText || '';
          proseReject = detectNonProseOutput(article);
          if (proseReject) {
            const err = new Error(`AI 连续两次返回的不是章节正文（${proseReject}）：已停止写入，未改动本章正文`);
            err.rawOutput = String(proseData.output || '').slice(-2000);
            throw err;
          }
        }
        // 直连路径没有代理现场入账 → 交付后后台补提案；harness 路径已按纪律入账。
        // ⚠️ 「重写本章」**不**在这里强行补入账（写这一行时先想当然加过，随后撤掉）：
        // 慢通道的精写内核本来就会调 novel_event_add / novel_memory_update 提交入账提案
        //（见下方"修复走 harness → needsLedger=false"那条注释），直连通道才需要前端补一次。
        // 强行在重写模式下置 true，会让走慢通道的那一轮**提交两套提案**，作者得逐条去重。
        let needsLedger = proseData.via === 'direct';
        let blockedDraft = false;
        // 质检结论提到外层：篇幅诊断（classifyChapterLength）在直连块之外也要用；
        // 走 harness 成文时没有独立质检轮，这里保持 null。
        let verdict = null;
        if (proseData.via === 'direct') {
          // flash 轻量质检轮：核对蓝图达成与一致性硬伤（秒级，替代部分 novel_consistency 职责）
          //
          // 2026-10-02：这一轮此前**既没有进度卡、也没有耗时记账**——成文轮结束后界面会静默
          // 十几到几十秒（账本里 225.6s 中有约 85s 无法归因，这就是其中一段）。现在配卡 + 记一笔。
          const verifyStartedAt = Date.now();
          const verifyCard = showAITaskProgress('AI 写作（2/3 质检）· 正在核对蓝图达成与一致性…');
          let verifiedHash = '';
          try {
            verdict = await verifyAIDraft(blueprintForProse, article, target);
          } finally {
            verifyCard.close();
          }
          // 记下"被检查的是哪份稿"：后续任何文本改动都会让这个指纹失配，触发复验（P0-1/P0-2）。
          verifiedHash = contentHashOf(article);
          timing.round('verify', Date.now() - verifyStartedAt, {
            pass: !!verdict.pass,
            skipped: !!verdict.skipped,
            // 只记"有几条硬伤"这个规模量，不记硬伤内容（与其它埋点同一条纪律）。
            issues: Math.min(99, Array.isArray(verdict.issues) ? verdict.issues.length : 0),
            deferred: Math.min(99, Array.isArray(verdict.deferred) ? verdict.deferred.length : 0),
            reason: verdict.skipped ? String(verdict.reason || '') : ''
          });
          if (verdict.skipped && verdict.reason) {
            // 显式说出"这次没质检"，并说明是体积原因——不冒充"已核对"。
            const why = verdict.reason === 'over_single_request_limit'
              ? '本章正文超过单请求质检上限（未分段质检）'
              : '长正文分段模块不可用';
            toast(`质检修略：${why}，本次未做质检核对（可在审稿页按清单人工/分段审）`, 'error');
            reportClientLog({ level: 'warn', kind: 'quality_gate_skipped', message: `[写作] ${why}（正文 ${String(article || '').length} 字）` });
          } else if (verdict.verdict === 'unknown') {
            // 三态里的 unknown：完成了调用但没得出可靠结论 —— 明确说"未完成可靠检查"，不冒充通过。
            toast('质检未得出可靠结论（unknown），本次不算“检查通过”', 'info');
            reportClientLog({ level: 'warn', kind: 'quality_gate_unknown', message: '[写作] 质检返回 unknown：无法判断或覆盖不全，本次不算通过' });
          }
          if (!verdict.pass && (verdict.issues || []).length) {
            blockedDraft = verdict.blocked;
            toast('质检发现硬伤，自动改用精写内核修复…', 'info');
            // 修复同样不截断：超过单请求上限时按片修复（覆盖清单通过才采用）。
            const repairStartedAt = Date.now();
            const repairRun = await longTextRunTask('repair_full', {
              text: article, chapterId: writeChapterId, issues: verdict.issues,
              blueprint: blueprintForProse, targetWords: target, singleRunByCaller: true,
              currentText: () => longTextLiveEditorText(article)
            });
            if (repairRun.mode === 'segmented') {
              if (repairRun.merged) { proseData = { output: repairRun.merged, via: 'harness' }; }
              else {
                reportClientLog({ level: 'warn', kind: 'repair_segmented_incomplete', message: `[写作] 分段修复未通过覆盖清单：${(repairRun.reasons || []).join('；')}` });
                toast('分段修复未通过覆盖清单，已保留原稿（未写入半套结果）', 'error');
              }
            } else {
            // ⏱ 质检不合格 → 精写内核返工：这是「一次成文没写对」的真实代价，必须单独记一笔
            proseData = await runHarnessJob(
              { ...jobBase, prompt: buildAIWriteRepairPrompt(article, verdict.issues, blueprintForProse, target) },
              'AI 写作（2/3 成文）· 精写内核修复硬伤中…'
            );
            }
            const repaired = parseAIWritingOutput(proseData.output || '').finalText || '';
            timing.round('repair', Date.now() - repairStartedAt, { via: 'harness', issues: (verdict.issues || []).length, accepted: !!repaired.trim() });
            if (repaired.trim()) {
              // 最终交付的正文来自精写内核：埋点的 channel 要如实反映**交付来源**，不能停留在"首选通道"
              proseRoute = 'harness';
              article = repaired;
              needsLedger = false; // 修复走 harness：内核已做一致性/红线自检并提交入账提案
              blockedDraft = false;
            } else if (blockedDraft) {
              toast('检测到章节边界或未登记实体硬伤，且自动修复未返回正文：已停止写入，请人工修改后重试。', 'error');
              return;
            }
          }
          // ── 最终复验（P0-1/P0-2）：把"检查的是哪份稿"绑到最后一次文本修改之后 ──
          // 只要修复真的改动了正文（contentHash 变化），上一次质检就已失效，必须重查一次；
          // "检查的是版本 A、交付的是 A+修复 B"正是这次改造要消除的隐蔽漏洞。最多一次，不成环。
          if (contentHashOf(article) !== verifiedHash) {
            const reverifyCard = showAITaskProgress('AI 写作（2/3 质检）· 修复后复验…');
            try {
              verdict = await verifyAIDraft(blueprintForProse, article, target);
            } finally {
              reverifyCard.close();
            }
            verifiedHash = contentHashOf(article);
            if (!verdict.pass && (verdict.issues || []).length) {
              // 复验仍有硬伤：不再自动改写，如实告知并把决定权交回作者。
              reportClientLog({
                level: 'warn', kind: 'final_reverify_issues',
                message: `[写作] 修复后复验仍发现 ${(verdict.issues || []).length} 条硬伤（已交付当前稿，未再自动改写）`
              });
              toast(`修复后复验仍发现 ${(verdict.issues || []).length} 条硬伤，已保留当前稿交你判断`, 'error');
            } else if (verdict.verdict === 'unknown') {
              toast('修复后复验未得出可靠结论（unknown），本次不算“检查通过”', 'info');
            }
          }
        }
        // ── P0-1：篇幅只做诊断，不再驱动生成 ────────────────────────────────
        // 旧逻辑 `while (plainLength(article) < target && rounds < 2)` 只要比目标短就在**章尾**
        // 继续追加——这是 AI 味最直接的来源之一，也会把已经成立的章尾（沉默/动作/悬而未决的
        // 对白）继续写下去。真实"漏写必要情节"由上面的质检 issues 表达并走修复；篇幅短但剧情
        // 完整时保留短稿，只提示作者，不自动续写。
        const lengthStatus = classifyChapterLength(article, target, verdict);
        timing.round('length', 0, { status: lengthStatus.status, chars: lengthStatus.chars, target: lengthStatus.target });
        // 全文确定性红线扫描（成文定稿后）：本地正则零成本，覆盖直连路径与修复后的段落。
        try {
          const fullScan = await api('/novel/scan', {
            method: 'POST',
            body: { work_id: state.workId || state.work?.id || undefined, text: article }
          });
          proseData.scan = { enabled: true, total: fullScan.total || 0, hits: fullScan.hits || [] };
        } catch (_) { /* 扫描失败不阻塞交付 */ }
        // ⏱ 收口：把这一轮的真实通道/模型/耗时交给埋点（口径 A 的终点就在这里）。
        // 此前这三项从来没被传进来过，于是 ai_eval_events 里 ms 恒为 0、channel/model 恒为空串 ——
        // 测量口径失效，"提速有没有生效"就永远无法被证明。
        const writeTiming = timing.summary();
        const mode = await showAIWritingResult(article, proseData.scan, proseData.proposals, target, proseData && proseData.job_id, {
          chapterId: writeChapterId,
          channel: proseRoute,
          model: policyModel('fast'),
          ms: writeTiming.total_ms,
          timing: writeTiming,
          lengthStatus,
          deferred: (verdict && verdict.deferred) || []
        });
        if (mode === null) {
          // 作者自己关掉了结果弹窗：不是失败，但**必须留痕**——否则日志里这次写作就等于
          // "消失了"，事后无法区分"他没看"和"系统没给"（2026-10-04 静默失败排查）。
          reportClientLogSafe({
            level: 'info', kind: 'ai_write_result_closed',
            message: '[AI] 结果弹窗被关闭，未写入正文（作者自己关的）',
            context: { work_id: state.workId || null, chapter_id: writeChapterId, chars: String(article || raw || '').length }
          });
          return;
        }
        if (mode === 'regenerate') return performToolbarAIWrite(requirement);
        await applyAIWritingArticle(mode, article, writeChapterId);
        if (needsLedger) scheduleLedgerProposalJob(article); // 不阻塞交付，后台整理提案
        return;
      }

      if (parsed.finalText) {
        // 模型跳过蓝图直接给了正文（降级路径，兼容旧行为）
        // 🚦 但"跳过蓝图"不等于"跳过校验"：这条路径同样可能收到规划/蓝图（2026-10-01 事故
        // 就是从这里进了章节正文）。此处只拦不重试——蓝图轮还没走过确认，重生成一次更划算的是
        // 让作者直接用「重试」；这里先保证绝不把规划当正文弹窗并写回。
        const skippedReject = detectNonProseOutput(parsed.finalText);
        if (skippedReject) {
          const err = new Error(`AI 这次返回的不是章节正文（${skippedReject}）：未写入任何内容，请重试`);
          err.rawOutput = String(parsed.finalText).slice(-2000);
          throw err;
        }
        const writeTiming = timing.summary();
        const mode = await showAIWritingResult(parsed.finalText, jobMeta && jobMeta.scan, jobMeta && jobMeta.proposals, targetWords, jobMeta && jobMeta.job_id, {
          chapterId: writeChapterId,
          channel: jobMeta ? 'harness' : 'direct',
          model: policyModel('fast'),
          ms: writeTiming.total_ms,
          timing: writeTiming
        });
        if (mode === null) return;
        if (mode === 'regenerate') return performToolbarAIWrite(requirement);
        await applyAIWritingArticle(mode, parsed.finalText, writeChapterId);
        return;
      }

      if (parsed.question) {
        // ⚠️ 提问轮的**产出是一句问句，不是稿子**：问句已经被下面这个弹窗展示给作者了，
        // 这一轮任务就算交付完毕 —— 必须立刻标记已应用，否则它会一直挂在恢复条上显示
        // 「AI 写作：已完成，结果待应用 · 产出 144 字符」+「取回结果并应用」，
        // 点下去取回的是一句问句（2026-10-04 作者截图报障："任务完成但是没显示？"）。
        if (jobMeta && jobMeta.job_id) markJobApplied(jobMeta.job_id);
        const answer = await askAIQuestion(parsed.question, 'AI 写作 · 需要向你确认');
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
      const writeTiming = timing.summary();
      const mode = await showAIWritingResult(raw, jobMeta && jobMeta.scan, jobMeta && jobMeta.proposals, targetWords, jobMeta && jobMeta.job_id, {
        chapterId: writeChapterId,
        channel: jobMeta ? 'harness' : 'direct',
        model: policyModel('fast'),
        ms: writeTiming.total_ms,
        timing: writeTiming
      });
      if (mode === null) return;
      if (mode === 'regenerate') return performToolbarAIWrite(requirement);
      await applyAIWritingArticle(mode, raw, writeChapterId);
      return;
    }

    reportClientLogSafe({
      level: 'warn', kind: 'ai_write_question_limit',
      message: '[AI] 追问次数已达上限（10 轮），本次写作结束且没有产出正文',
      context: { work_id: state.workId || null, chapter_id: writeChapterId }
    });
    toast('AI 追问次数已达上限，请重试', 'error');
  } catch (e) {
    if (e.cancelled) {
      traceWriteCancelled = true;
      // 已生成的正文此前连同进度卡一起丢掉 —— 作者白等几分钟、手里什么都没有。
      // 现在够长就落成草稿（**只保存、不应用**），并如实告诉作者去哪里取。
      const kept = await saveInterruptedDraft(e.partialText || interruptedPartial, writeChapterId);
      toast(kept
        ? `已取消 AI 写作；已生成的 ${kept} 字已存为草稿，可在章节里「取回生成稿」`
        : '已取消 AI 写作', 'success');
    } else {
      // N-02：失败必须可见。弹窗说明原因并回显 AI 原始输出尾部，替代此前一闪而过的 toast。
      const detail = e.rawOutput || e.tail || e.message || '未知错误';
      // 📝 失败也要进日志（2026-10-04 作者报障："这种报错弹窗为什么日志不记录，要去记录"）：
      // 那次 19:41 的空产出在日志里只留下"任务完成"，事后完全查不出失败发生在哪一环。
      // 这条日志把「哪一章 / 哪一环 / 什么错误 / 拿到了多少字 / 原始输出开头」一次记全。
      reportClientLogSafe({
        level: 'error', kind: 'ai_write_failed',
        message: `[AI] 写作管线失败：${String(e.message || '未知错误').slice(0, 160)}`,
        context: {
          work_id: state.workId || state.work?.id || null,
          chapter_id: writeChapterId,
          stage: 'write', chars: Number(e.chars) || 0,
          head: String(detail).slice(0, 120)
        }
      });
      // 断流/超时同理：已经写出来的部分不销毁，只说清它在哪里（弹窗仍然照旧弹出、原因仍照旧展示）。
      //
      // ⚠️ 顺序与兜底（2026-10-04「静默失败」排查）：**落草稿是一次网络写入，它自己会失败** ——
      // 旧写法是 `const kept = await saveInterruptedDraft(...)` 直接接 `openModal(...)`，
      // 于是这次写入一旦抛错，**弹窗永远不会打开**：作者看到的是"任务结束但什么都没显示"，
      // 日志里也只有"任务完成"。现在把副作用包起来：失败也要照样弹窗，并在弹窗里如实说明。
      let kept = 0;
      let keptFailed = false;
      try {
        kept = await saveInterruptedDraft(e.partialText || interruptedPartial, writeChapterId);
      } catch (saveErr) {
        keptFailed = true;
        reportClientLogSafe({
          level: 'error', kind: 'ai_write_draft_save_failed',
          message: `[AI] 失败后保存中断草稿也失败了：${String(saveErr && saveErr.message || saveErr).slice(0, 120)}`,
          context: { work_id: state.workId || null, chapter_id: writeChapterId, chars: Number(e.partialText && e.partialText.length) || 0 }
        });
      }
      const keptNote = kept
        ? `已经写出来的 ${kept} 字没有丢：已存为草稿，可在章节里「取回生成稿」。`
        : (keptFailed ? '（想把这半截存成草稿时失败了 —— 它只存在于内存里，若需要请立刻截图或复制下面的原文）' : '');
      // 失败**原因**必须原文进弹窗，不能被"常见原因"那种泛化清单盖掉：交付闸门拦下"返回的是规划
      // 而不是正文"时（2026-10-01 事故），作者唯一能看懂的就是这句话本身；只给通用清单等于没说。
      openModal({
        title: '⚠️ AI 写作未完成',
        body: `
          <div class="mb-8"><b>${esc(String(e.message || '未知错误'))}</b></div>
          <div class="muted mb-8">常见原因：AI 拒绝执行、创作内核通道异常（如中文需求在传输中被损坏）、或返回内容无法解析。下方是原始输出尾部，可复制反馈排查：</div>
          ${keptNote ? `<div class="muted mb-8">${esc(keptNote)}</div>` : ''}
          <pre style="white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;background:rgba(0,0,0,.25);padding:10px;border-radius:6px;font-size:12px">${esc(String(detail).slice(-2000))}</pre>`,
        footer: '<button class="btn" data-close-modal>知道了</button>'
      });
    }
  } finally {
    if (btn) btn.disabled = false;
    state.aiWritePipelineRunning = false; // 入口互斥的释放点（只由本函数置位，见 state 里的说明）
    // 🐞 运行追踪：整条「AI 写本章」管线（蓝图→成文→质检→补足）收尾时，
    // 才把长流程操作关闭——阶段函数内不 flush，否则多阶段管线会被切碎成多条操作。
    if (typeof traceFlushLong === 'function') traceFlushLong(traceWriteCancelled ? 'cancelled' : 'done');
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
        <div class="muted mb-8">从第一个还没有正文的章节开始，依次自动生成（每章先出蓝图再成文；目标字数只是范围参考，不会为凑字数在章尾续写）。已有正文的章节会跳过；随时可点进度卡上的「停止」。</div>
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
  // F-01：批量生成前先落盘当前编辑器，避免长时间任务结束时丢失未保存内容。
  // ⚠️ 必须 await：紧接着要查"哪些章节还是空的"（server 侧判据是 content IS NULL OR content=''），
  // 正在写、还没落盘的新章会被判成空章 → 被选成生成目标，然后你的未保存内容被覆盖。
  if (!(await ensureSavedBeforeNavigation())) return;
  let empty;
  try {
    empty = await api(`/novel/empty_chapters?work_id=${state.workId}`);
  } catch (e) {
    return toast('查询空章节失败：' + e.message, 'error');
  }
  const targets = (empty.chapters || []).slice(0, count);
  if (!targets.length) return toast('没有空章节可生成（可先在正文写作页新建章节）', 'error');
  const jobBase = {
    timeout: longAiTimeout(),
    model: policyModel('fast'),
    action: 'write',
    work_id: state.workId,
    mode: 'full',
    // 批量生成同样是分钟级任务，标记归属以便刷新/重启后能接回。
    kind: 'prose',
    stage: '批量生成'
  };
  let done = 0;
  // 每章的**全文**红线自检结果（成文 + 补足合并后），最后汇总给作者。
  // 为什么不用 harness 任务自带的 job.scan：那是对**单次 job 的 output** 算的
  // （成文 job 只有正文本体、补足 job 只有续写片段），而写回的是合并后的全文 ——
  // 交互路径正是因此自己重扫一次。扫描是本地正则，零 AI 成本。
  // 缺失它时，批量生成的章节命中了多少反 AI 腔词句，作者永远不知道（红线自检没有别的展示面）。
  const scanRows = [];
  // 每章的实际耗时：收尾如实报出"这一批到底跑了多久"，让"提速有没有生效"当场可核对
  // （而不是只能事后翻日志猜——日志里长任务此前根本不会被打成 slow，见 logger.js 的阈值口径）。
  const chapterMs = [];
  // 批量生成的通道策略（与交互路径 performToolbarAIWrite 同一条纪律）：
  //   **中间产物走直连，成文轮保留精写内核**。
  // ⚠️ 成文轮**刻意不改直连**，即使那样每章还能再省 ≈17 秒：它同时承担事件/记忆入账与一致性核对
  //   （精写内核的 novel_* 工具），批量时没有人在旁边盯着；改直连就必须另造一条入账链路，
  //   而那条链路会与下一章的作业抢服务端的 2 个并发槽（抢不到就是 429，提案静默丢失）。
  //   在"不影响质量"的前提下，这里的取舍是只把中间产物搬出慢通道，质量链路一个字节不动。
  for (const ch of targets) {
    done += 1;
    const label = `批量生成 · 第 ${done}/${targets.length} 章（${ch.title}）`;
    const chapterStartedAt = Date.now();
    try {
      // 切到该章上下文（AI 上下文/角色卡/世界观）
      state.currentChapterId = ch.id;
      await loadAIContext();
      const target = resolveTargetWords();
      const initial = buildAIWritingInitialRequest(`根据作品大纲与剧情推进，撰写本章完整正文（不需要提问，直接按蓝图成文）`);
      // 1) 自动蓝图（不弹确认，直接落库）：**直连优先**，与交互路径同一条纪律。
      //    依据是本项目自己的实测（README「写作路径提速（实测驱动）」）：慢通道每个任务多花
      //    ≈17–18 秒冷启动固定开销（同一条真实蓝图提示词 19.1s vs 47.3s）。蓝图是中间产物，
      //    随后会作为【本章蓝图】内联进成文提示词，因此搬出慢通道不改变成文质量。
      //    两种必须回退的情况：① 上下文被预算截断——只有慢通道能用 novel_lookup 取回被裁掉的原文；
      //    ② 直连不可用/空回复（directAIWrite 内部已对"思考吃光 max_tokens"重试过一次）。
      const blueprintPrompt = buildAIWritingBlueprintPrompt(initial, [], target, true);
      let bpRaw = '';
      if (!aiContextTruncated()) {
        bpRaw = (await directAIWrite([{ role: 'user', content: blueprintPrompt }], {
          model: policyModel('fast'), maxTokens: 8192
        })) || '';
        if (!bpRaw.trim()) {
          reportClientLog({ level: 'warn', kind: 'batch_blueprint_direct_fallback', message: `[批量生成] ${ch.title} 蓝图直连不可用，回退精写内核` });
        }
      }
      if (!bpRaw.trim()) {
        // 与交互路径同一条归属标记：蓝图轮落库时 kind='blueprint'（不是可应用的「AI 写作」产出）。
        const bpData = await runHarnessJob({ ...jobBase, chapter_id: ch.id, kind: 'blueprint', stage: '蓝图', prompt: blueprintPrompt }, `${label} · 蓝图`);
        bpRaw = bpData.output || '';
      }
      let bp = parseAIWritingOutput(bpRaw).blueprint || null;
      if (bp && Object.keys(bp).length) {
        try {
          await api('/novel/chapter_blueprint', { method: 'PUT', body: { chapter_id: ch.id, blueprint: bp, target_words: 0 } });
        } catch (_) { /* 蓝图保存失败不阻塞 */ }
      }
      // 2) 成文
      const proseData = await runHarnessJob({ ...jobBase, chapter_id: ch.id, prompt: buildAIWritingProsePrompt(initial, bp, target) }, `${label} · 成文`);
      let article = parseAIWritingOutput(proseData.output || '').finalText || '';
      if (!article.trim()) throw new Error('AI 没有返回正文内容');
      // 🚦 与交互路径同一条交付闸门：规划/蓝图不是正文，宁可不写回也不污染章节。
      // 批量生成没有人在旁边看着，这道闸门尤其重要（一次跑 N 章，污染会跟着写回 N 章）。
      const batchReject = detectNonProseOutput(article);
      if (batchReject) throw new Error(`AI 返回的不是章节正文（${batchReject}），本章未写回`);
      // 3) 篇幅诊断（P0-1）：不按字数自动续写。
      //    旧逻辑在章尾继续追加内容来补足字数，会把已经成立的章尾写穿，也是 AI 味的直接来源。
      //    批量写入没有人在旁边看，更要如实交付"模型写了什么"，而不是"补到目标字数为止"。
      const lengthStatus = classifyChapterLength(article, target, null);
      reportClientLog({
        level: 'info', kind: 'batch_length_status',
        message: `[批量生成] ${ch.title} 篇幅 ${lengthStatus.status}（${lengthStatus.chars}/${lengthStatus.target} 字）`,
        context: { chapter_id: ch.id, status: lengthStatus.status, chars: lengthStatus.chars, target: lengthStatus.target }
      });
      // 4) 全文确定性红线扫描（本地正则、零成本）：结果只做**告知**，不改变写回内容。
      // ⚠️ 失败不阻塞写回（与交互路径同一条纪律）。
      try {
        const fullScan = await api('/novel/scan', {
          method: 'POST',
          body: { work_id: state.workId, text: article, skip_dialogue: true }
        });
        const total = Number(fullScan.total) || 0;
        scanRows.push({ title: ch.title, total });
        reportClientLog({
          level: total > 0 ? 'warn' : 'info',
          kind: 'batch_redline_scan',
          message: `[批量生成] ${ch.title} 红线自检命中 ${total} 处`
            + (total > 0 ? `：${(fullScan.hits || []).slice(0, 3).map((h) => `${h.pattern}×${h.count}`).join('、')}` : '')
        });
      } catch (e) {
        reportClientLog({ level: 'warn', kind: 'batch_redline_scan_failed', message: `[批量生成] ${ch.title} 红线自检不可用：${e.message}` });
      }
      // 5) 写回章节（旧稿自动存历史版本）
      await api('/novel/chapter_save', {
        method: 'POST',
        body: { chapter_id: ch.id, content: textToParagraphsHtml(article), summary: (bp?.scene_goal || '').slice(0, 200) }
      });
      // 写回推进了该章的 updated_at：把本地基线拉回来，否则这一轮结束后打开该章编辑，
      // 第一次自动保存会因为"本地标记过期"而误报冲突（本人刚做的写回被当成别人改的）。
      await refreshChapterBaselineAfterForeignWrite(ch.id);
      toast(`第 ${done}/${targets.length} 章已写入：${ch.title}`, 'success');
      chapterMs.push(Date.now() - chapterStartedAt);
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
  // 收尾：耗时 + 红线自检结果如实报出来（命中/通过/不可用三种口径，不要含糊成一句"完成"）。
  // 耗时口径说明：`totalMs` 含本章的上下文装配、直连/慢通道往返与写回，是这个批量函数**真实**的墙钟耗时；
  // 报出来是为了让"提速有没有生效"当场可核对，而不是只能事后翻日志猜。
  const totalMs = chapterMs.reduce((n, ms) => n + ms, 0);
  const mmss = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : `${Math.round(ms / 1000)} 秒`);
  const timeLine = chapterMs.length
    ? `用时 ${mmss(totalMs)}（平均 ${mmss(Math.round(totalMs / chapterMs.length))}/章）`
    : '';
  // 提案去哪儿的指路保持不变（提案按设计要作者逐条确认，且 `/novel/proposals` 是该作品的全部待确认项，
  // 逐章展示只会重复同一份清单）。
  const scannedTotal = scanRows.reduce((n, r) => n + r.total, 0);
  let scanLine;
  if (!scanRows.length) {
    scanLine = '红线自检不可用（不影响正文，可在参考面板「红线」里手工核对）';
  } else if (scannedTotal === 0) {
    scanLine = `红线自检通过（${scanRows.length} 章均未命中反 AI 腔词句）`;
  } else {
    const detail = scanRows.filter((r) => r.total > 0).slice(0, 3).map((r) => `${r.title} ${r.total} 处`).join('、');
    const more = scanRows.filter((r) => r.total > 0).length > 3 ? ' 等' : '';
    scanLine = `红线自检命中 ${scannedTotal} 处（${detail}${more}）`;
  }
  toast(`批量生成完成：${done} 章已写入正文${timeLine ? `，${timeLine}` : ''}。${scanLine}。AI 提交的事件/记忆提案可在「长期记忆 → 待确认提案」处理`,
    scannedTotal > 0 ? 'error' : 'success');
  await refreshProposalBadge(); // 本批可能新增提案：角标立刻反映，别等下次进那个面板
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
    const range = sel?.range || null;
    // R08：整章（或整段选区）一律整篇处理；超限自动分段，覆盖清单不通过就不给采纳。
    const run = await longTextRunTask('polish', {
      text: source, instruction: instruction.trim(), chapterId: state.currentChapterId,
      currentText: () => ((getEditorSelection(editor)?.text || editor.innerText || '').trim()),
      onProgress: (plan, results) => {
        const el = $('#ai-task-progress');
        if (el) { el.hidden = false; el.textContent = `长正文分段润色：${results.filter((r) => r.status === 'done').length} / ${plan.segments.length} 片完成…`; }
      }
    });
    if (!run.merged) {
      if (run.mode === 'single') throw new Error('AI 没有返回内容');
      showLongTextIncomplete('润色', run, () => runToolbarAIPolish());
      return;
    }
    const title = run.mode === 'segmented' ? `润色结果 · 分段处理（${run.plan.segments.length} 片）` : '润色结果';
    showAIApplyPreview(title, run.merged, () => applyAIReply(editor, run.merged, range), run.statusHtml);
  } catch (e) {
    if (e.cancelled) toast('已取消 AI 润色', 'success');
    else toast('AI 润色失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    const el = $('#ai-task-progress');
    if (el) el.hidden = true;
  }
}

// 分段修稿的备选路径：整片重写。只在作者显式选择时走——**不自动回退**，
// 避免"按段改已经花过钱、又整章重写再花一次"的隐性双倍消费。
async function refineLongTextFull(info, review, confirmedIssues) {
  const confirmed = (confirmedIssues || review?.issues || []).slice();
  if (!confirmed.length) { toast('没有可用的确认清单', 'error'); return; }
  const revisionChapterId = Number(info && info.chapterId) || Number(state.currentChapterId) || null;
  try {
    const run = await longTextRunTask('revision_full', {
      text: info.article, chapterId: revisionChapterId, issues: confirmed,
      currentText: () => (Number(state.currentChapterId) === Number(revisionChapterId)
        ? longTextLiveEditorText(info.article)
        : info.article),
      onProgress: (plan, results) => {
        const el = $('#ai-task-progress');
        if (el) { el.hidden = false; el.textContent = `长正文分段修稿（整片重写）：${results.filter((r) => r.status === 'done').length} / ${plan.segments.length} 片完成…`; }
      }
    });
    const el = $('#ai-task-progress');
    if (el) el.hidden = true;
    if (run.mode === 'single') {
      const revised = String(run.merged || '');
      if (!revised.trim()) throw new Error('修稿结果为空');
      showReviewDiff(info.article, revised, { checklist: confirmed.length, chapterId: revisionChapterId, baseFingerprint: info.baseChapterFingerprint || null, findings: patchSafetyVerify(info.article, revised, patchSafetyOptions(revisionChapterId)) });
      return;
    }
    if (!run.merged) {
      showLongTextIncomplete('修稿（整片重写）', run, () => refineLongTextFull(info, review, confirmed));
      return;
    }
    showReviewDiff(info.article, run.merged, { checklist: confirmed.length, chapterId: revisionChapterId, baseFingerprint: info.baseChapterFingerprint || null, findings: patchSafetyVerify(info.article, run.merged, patchSafetyOptions(revisionChapterId)) });
    toast(`整章分 ${run.plan.segments.length} 片重写完成（覆盖清单通过）`, 'success');
    longTextClearRun();
  } catch (e) {
    toast('修稿失败：' + e.message, 'error');
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
    const range = sel?.range || null;
    const run = await longTextRunTask('expand', {
      text: source, instruction: instruction.trim(), chapterId: state.currentChapterId,
      currentText: () => ((getEditorSelection(editor)?.text || editor.innerText || '').trim()),
      onProgress: (plan, results) => {
        const el = $('#ai-task-progress');
        if (el) { el.hidden = false; el.textContent = `长正文分段扩写：${results.filter((r) => r.status === 'done').length} / ${plan.segments.length} 片完成…`; }
      }
    });
    if (!run.merged) {
      if (run.mode === 'single') throw new Error('AI 没有返回内容');
      showLongTextIncomplete('扩写', run, () => runToolbarAIExpand());
      return;
    }
    const title = run.mode === 'segmented' ? `扩写结果 · 分段处理（${run.plan.segments.length} 片）` : '扩写结果';
    showAIApplyPreview(title, run.merged, () => applyAIReply(editor, run.merged, range), run.statusHtml);
  } catch (e) {
    if (e.cancelled) toast('已取消 AI 扩写', 'success');
    else toast('AI 扩写失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    const el = $('#ai-task-progress');
    if (el) el.hidden = true;
  }
}

function buildAIPersonalityMessages(characterId, contentOverride, opts = {}) {
  const editor = $('#editor-content');
  const chapter = state.chapters.find((c) => c.id === state.currentChapterId) || {};
  const content = String(contentOverride != null ? contentOverride : stripHtml(editor?.innerHTML || chapter.content || ''));
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

${opts.segment ? `${longTextContextBlock(opts.segment)}\n\n本片为分段处理的第 ${opts.segment.ordinal} 片（target ${opts.segment.segment_id}），只判断本片正文。\n` : ''}
当前正文：
${content}

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
    const reply = await runHarnessFromMessages(messages, { model: policyModel('fast'), action: 'personality' });
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
    const reply = await runHarnessFromMessages(buildAIOutlineMessages(), { model: policyModel('fast'), action: 'outline' });
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

// 设定词条按需选取：按请求关键词对标题/标签/内容打分排序（标题×3 / 标签×2 / 内容×1），
// 无关键词命中时保持原顺序。零损失：未被选中的条目由 novel_lookup 查证原文，不靠压缩。
const TERM_SELECT_LIMIT = 12;

// 中文通用二字组合停用词。长句按 2 字滑窗切分后，「一个/我们/可以」这类词几乎在任何请求里
// 都出现，会让 scoreTermsByRequest 的打分被噪声主导、top-12 选取接近随机，故先行剔除。
// 刻意不含领域词（角色/设定/剧情/世界/大纲/伏笔/记忆…），那些正是要用来定位词条的信号。
const CN_KEYWORD_STOPWORDS = new Set([
  '一个', '我们', '你们', '他们', '她们', '它们', '自己', '这个', '那个', '这些', '那些',
  '什么', '怎么', '可以', '需要', '要求', '进行', '以及', '或者', '但是', '因为', '所以',
  '如果', '虽然', '然后', '现在', '时候', '已经', '应该', '能够', '通过', '对于', '关于',
  '其中', '并且', '而且', '不是', '没有', '就是', '还是', '一样', '这样', '那样', '一些',
  '很多', '全部', '所有', '每个', '各种', '相关', '主要', '重要', '不同', '相同', '内容',
  '生成', '根据', '请根', '如下', '以下', '上面', '下面', '同时', '另外', '此外', '例如',
  '比如', '包括', '其他', '其它', '之间', '之后', '之前', '目前', '当前', '尽量', '必须',
  '不要', '保持', '输出', '提供', '使用', '实现', '存在', '出现', '开始', '继续', '完整'
]);

function extractKeywords(text) {
  const s = String(text || '').toLowerCase();
  const freq = new Map();
  const add = (word) => {
    if (word.length < 2 || CN_KEYWORD_STOPWORDS.has(word)) return;
    freq.set(word, (freq.get(word) || 0) + 1);
  };

  // 英文/数字标识符整词保留（命中即强信号）。
  for (const m of s.matchAll(/[a-z0-9_]{3,}/g)) add(m[0]);

  // 中文：2-4 字的短片段整段保留（更具体）；长句按 2 字滑窗切分。
  // 扫完全文而非凑够 N 个就 break——旧实现在长请求里只覆盖到前 ~60 字，
  // 导致请求后半段完全参与不到打分。
  for (const run of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = run[0];
    if (seg.length < 2) continue;
    if (seg.length <= 4) { add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) add(seg.slice(i, i + 2));
  }

  // 高频优先（反复出现的概念更能代表请求），同频时长词优先（更具体）。
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 80)
    .map(([word]) => word);
}
function scoreTermsByRequest(terms, requestText) {
  const kw = extractKeywords(requestText);
  if (!kw.length) return terms.slice();
  const scoreText = (text) => {
    const s = String(text || '').toLowerCase();
    let n = 0;
    for (const k of kw) if (k.length >= 2 && s.includes(k)) n += 1;
    return n;
  };
  return terms
    .map((term) => ({ term, score: scoreText(term.title) * 3 + scoreText(term.tags) * 2 + scoreText(term.content) * 1 }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.term);
}

// 从服务器取“ST 式分层上下文”（mode=settings：设定类生成专用轻量装配，
// 不含当前场景/蓝图/前文衔接），再补上按需选取的设定词条库与轻量全局信息。
async function genWorkContextBlock(requestText = '') {
  let ctx = '';
  try {
    const data = await api(`/novel/context?work_id=${state.workId}&mode=settings`);
    if (data && data.assembled) ctx = data.assembled;
  } catch (_) { /* 内核不可用时退化为本地组装 */ }
  const extra = [];
  if (state.terms.length) {
    // 标题级去重：只在「世界观层实际渲染片段」内比对（两个已知层头之间；红线恒为末层）。
    // 曾用 ctx.includes() 整块比对——角色卡层同样用【名称】格式，词条标题与角色名撞名时会被
    // 误删（词条正文丢失，违反零损失）；若改用 API 响应的 world_entries 全量标题，又会对
    // 被预算截断而未实际渲染的条目去重，导致词条「既不在上下文、又不在词条库」。
    const wStart = ctx.indexOf('【激活的世界观设定（优先级排列）】');
    let worldBlock = '';
    if (wStart >= 0) {
      const wEnd = ctx.indexOf('\n【写作风格红线】', wStart);
      worldBlock = ctx.slice(wStart, wEnd >= 0 ? wEnd : undefined);
    }
    const candidates = scoreTermsByRequest(state.terms, requestText).filter((t) => !worldBlock.includes(`【${t.title}】`));
    const chosen = candidates.slice(0, TERM_SELECT_LIMIT);
    const omitted = candidates.slice(TERM_SELECT_LIMIT);
    // 可发现性：只写「其余 N 条可查证」模型无从下手——它不会去索要自己不知道存在的条目。
    // 因此把未选入条目的**标题**一并列出（每条约 5–10 字，成本可忽略），
    // 「按需查原文」的零损失承诺才真正成立。
    const OMITTED_TITLE_CAP = 80;
    // 计数必须自洽：state.terms 里有一部分因「已在上文其它层出现」被去重掉，
    // 若只报「共 N 条 / 选取 M 条」再列未选入清单，三个数加起来对不上，
    // 模型会以为剩下那些条目不存在。故把去重掉的那部分也一并交代。
    const dedupedCount = state.terms.length - candidates.length;
    const omittedHint = omitted.length
      ? `\n（设定词条库共 ${state.terms.length} 条：${dedupedCount} 条已在上文其它层出现，`
        + `${chosen.length} 条按关键词选入本次上下文，其余 ${omitted.length} 条未选入。`
        + `未选入条目标题：${omitted.slice(0, OMITTED_TITLE_CAP).map((t) => t.title).join('、')}`
        + `${omitted.length > OMITTED_TITLE_CAP ? ` …等共 ${omitted.length} 条` : ''}。`
        + '需要其中任何一条的原文时用 novel_lookup 查证，不要凭空编造。）'
      : '';
    // 全部条目都已被上文其它层覆盖时不再输出空标题，避免制造无内容的分层噪音。
    if (chosen.length || omittedHint) {
      extra.push('【设定词条库（按需选取）】\n' + chosen.map((t) => `【${t.title}】${String(t.content || '').slice(0, 400)}${t.tags ? `（标签：${t.tags}）` : ''}`).join('\n') + omittedHint);
    }
  }
  if (state.categories.length) {
    extra.push('【设定分类】\n' + state.categories.map((c) => c.name).join('、'));
  }
  if (state.relations.length) {
    const nameOf = (id) => state.characters.find((c) => c.id === id)?.name || `#${id}`;
    const relationLines = state.relations.slice(0, 120).map((r) => `${nameOf(r.from_character_id)} —${r.relation || '相关'}→ ${nameOf(r.to_character_id)}${r.description ? `（${String(r.description).slice(0, 120)}）` : ''}`);
    const omitted = state.relations.length - relationLines.length;
    extra.push('【人物关系（全）】\n' + relationLines.join('\n') + (omitted > 0 ? `\n（关系共 ${state.relations.length} 条，仅列出前 120 条；其余可用 novel_lookup 查证）` : ''));
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

// 提问轮极简上下文：澄清需求不需要整套设定，只给作品身份（省 ~2 万 tokens/轮）。
function genQuestionContext() {
  const w = state.work || {};
  if (!w.title) return '（当前作品暂无可参考的设定内容）';
  return `作品：《${w.title}》${w.description ? `\n简介：${String(w.description).slice(0, 150)}` : ''}`;
}

function genDialoguePrompt(system, context, initial, history, forceQuestion = false) {
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
  lines.push(forceQuestion
    ? '这是本轮对话的第一步：无论你是否已经理解需求，都请先只问一个最关键的问题（第一行必须严格是【提问】，一次只问一个问题，不要输出最终内容）。等我回答后，再在下一轮输出【成文】。'
    : '请决定下一步：需要澄清就先输出【提问】并只问一个问题；已经理解就直接输出【成文】并给出全部内容。');
  return lines.join('\n');
}



// 多轮【提问】→【成文】生成循环，返回最终文本；用户中途取消返回 null。
// 首轮强制一问（forceQuestion）优先走直连通道秒级出题，直连失败/空回复回退 Harness；
// 成文轮（用户回答后）仍走 Harness 创作内核保证设定质量与上下文一致。
// 模型分工：提问轮 = 快档（直连，澄清问题只需一个问句）；成文轮 = 质量档。
// ⚠️ 2026-09-18 起两档**模型名相同**（都是 V4.1 Flash = `deepseek-flash`），
//    「质量优先」由 reasoning_effort 表达（policyEffortForTier('quality') = 'high'）。
//    这里的历史注释写的是 `deepseek-v4-pro`——那已是上一代模型，**不要再照它改回去**：
//    详见 ai/policy.mjs 文件头的决策记录。
// 注：直连失败/空回复回退 Harness 时，提问轮也会跟着走同一次 harness 调用（质量档）——
// 该回退分支历史性地与成文轮共用同一次调用（极少触发，可接受）；若要严格分离需按 forceQuestion 再分支。
async function runGenAskLoop({ system, initial }) {
  const history = [];
  // 成文轮上下文：settings 轻量装配 + 词条按需选取；整个循环只装配一次，
  // 轮间字节一致，利于多轮请求命中前缀缓存。
  const context = await genWorkContextBlock(initial);
  let turns = 10;
  while (turns-- > 0) {
    const forceQuestion = history.length === 0;
    // 提问轮极简上下文：澄清需求不需要整套设定，避免每轮全量重发
    const turnContext = forceQuestion ? genQuestionContext() : context;
    const prompt = genDialoguePrompt(system, turnContext, initial, history, forceQuestion);
    let output = null;
    if (forceQuestion) {
      // 直连提问轮：固定 flash，秒级、成本低；仅在需要澄清的首轮使用。
      // 提问轮只要几十字的产出，但额度同样要覆盖思考：1500 的总额度一旦被思考吃光，
      // 澄清问题就变成"直连空手而归 → 回退慢通道"，用户为一句提问等 2–6 分钟。
      output = await directAIWrite([{ role: 'user', content: prompt }], { model: policyModel('fast'), maxTokens: withThinkingHeadroom(1500) });
    }
    if (!output) {
      // 无可用 API 配置 / 直连失败 / 空回复：回退 Harness 慢通道（含后续成文轮）。
      const data = await runHarnessJob({
        prompt,
        timeout: longAiTimeout(),
        // 质量优先：成文轮产出正式设定，与提问轮分工不同 —— 由思考强度表达（同 V4.1 Flash）。
        model: policyModel('quality'),
        reasoning_effort: policyEffortForTier('quality') || undefined,
        action: 'settings-gen',
        work_id: state.workId,
        chapter_id: state.currentChapterId || undefined,
        mode: 'settings'
      }, '小说设定 AI 生成 · 正在分析作品与需求…');
      output = data.output || '';
    }
    const parsed = parseAIWritingOutput(output);
    if (parsed.finalText) return parsed.finalText;
    if (parsed.question) {
      const answer = await askAIQuestion(parsed.question, 'AI 生成 · 需要向你确认');
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
  ['position', 'volume_id', 'plotline_id', 'category_id', 'work_id', 'from_character_id', 'to_character_id', 'character_id', 'default_chapter_words', 'total_chapters'].forEach((k) => {
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
    // D8-#4：走作业入口。此前这条是同步请求——浏览器要挂着一个 HTTP 长连接等几分钟，
    // 刷新即丢、也无法取消；现在与其它 AI 任务同构（进度卡 + 停止 + 可恢复）。
    const job = await runHarnessJob(
      {
        kind: 'generate_novel',
        prompt,
        model: policyModel('quality'),
        reasoning_effort: policyEffortForTier('quality') || undefined,
        timeout: longAiTimeout()
      },
      'AI 自动创建小说',
      '/harness/job');
    const data = job.result || {};
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

// ---------- 编辑器格式（F-36：替代已弃用的 document.execCommand） ----------
// 行内格式（加粗/斜体/下划线）用 Selection/Range 手动包裹；块级格式（H2/引用）替换选区所在块。
function applyInlineFormat(tag) {
  const editor = $('#editor-content');
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount !== 1 || !sel.toString().trim()) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  const wrap = document.createElement(tag);
  try {
    wrap.appendChild(range.extractContents());
    range.insertNode(wrap);
  } catch (_) { /* 跨块选区无法包裹时静默忽略 */ }
  sel.removeAllRanges();
  sel.addRange(range);
}

function applyBlockFormat(tag) {
  const editor = $('#editor-content');
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount !== 1) return;
  const range = sel.getRangeAt(0);
  const anc = range.commonAncestorContainer;
  const block = (anc.nodeType === Node.ELEMENT_NODE ? anc : anc.parentElement)?.closest('p, div, blockquote, h2, h3, li');
  const newEl = document.createElement(tag);
  if (block && editor.contains(block) && block !== editor) {
    while (block.firstChild) newEl.appendChild(block.firstChild);
    block.replaceWith(newEl);
  } else {
    try {
      newEl.appendChild(range.extractContents());
      range.insertNode(newEl);
    } catch (_) { /* 选区异常时静默忽略 */ }
  }
  sel.removeAllRanges();
  sel.addRange(range);
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
    // 刻意只拦"点遮罩"这一条路径：点 ✕ / 点"取消"**仍然立即关闭**。
    // 理由：那两个动作本身就是明确的"放弃修改"，再拦一次等于把决定权又丢回给用户；
    // 而点遮罩更可能是误触（尤其长表单里想滚页面/点空白处），代价不对称。
    //
    // 2026-10-04：默认**全部**弹窗都走这条路（openModal 的 protectedBackdrop 默认 true）。
    // 起因是作者连续撞到三处同类缺口（提问窗口 / 蓝图确认框 / AI 写作需求框）：
    // 一次误触就丢掉正在填的需求或取消一次付费生成 —— 这是不对称代价，默认该偏安全侧。
    if (state.modalProtected) {
      // 关闭这类弹窗等于：把 pending* resolve 成 null（取消任务/丢弃输入）。
      // 因此只提示、不关闭 —— 作者若真想取消，走 ✕（明确表达意图）。
      toast('点窗口外面不会关闭：请用右上角 ✕ 或「取消」按钮', 'error');
      return;
    }
    if (modalDirty()) {
      // 有未保存输入：不关，并说明怎么继续。静默不关会让人以为界面卡住了。
      toast('有未保存的修改，已取消关闭；要放弃请点「取消」', 'error');
      return;
    }
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

  // 🐞 运行追踪：录制中时把整条处理链包起来，记录「点了什么 → 跑了哪些代码 → 多久 → 结果」。
  if (typeof trace !== 'undefined' && trace.on && typeof traceWrapHandler === 'function') {
    await traceWrapHandler(action, actionEl, () => handleAction(action, actionEl, e));
    return;
  }
  await handleAction(action, actionEl, e);
});

async function handleAction(action, actionEl, e) {
  try {
    switch (action) {
      case 'back-works':
        if (!(await ensureSavedBeforeNavigation())) break;
        state.workId = null;
        state.loadedWorkId = null;
        state.work = null;
        state.view = 'works';
        await render();
        break;

      case 'toggle-theme':
        toggleTheme();
        break;

      case 'open-command-palette':
        openCommandPalette();
        break;

      case 'focus-mode': {
        const layout = $('#writing-layout');
        if (!layout) break;
        const active = layout.classList.toggle('focus-mode');
        document.body.classList.toggle('writing-focus-active', active);
        actionEl.textContent = active ? '退出专注' : '专注模式';
        actionEl.setAttribute('aria-pressed', String(active));
        break;
      }

      case 'go-view':
        if (!(await ensureSavedBeforeNavigation())) break;
        goView(actionEl.dataset.view);
        await render();
        break;

      case 'board-tab': {
        if (!(await ensureSavedBeforeNavigation())) break;
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
        if (!(await ensureSavedBeforeNavigation())) break;
        state.workId = Number(actionEl.dataset.id);
        state.loadedWorkId = null;
        state.view = 'overview';
        state.currentChapterId = null;
        await render();
        break;
      }

      case 'continue-work': {
        if (!(await ensureSavedBeforeNavigation())) break;
        const workId = Number(actionEl.dataset.id);
        state.workId = workId;
        state.loadedWorkId = null;
        state.currentChapterId = Number(state.workMeta.get(workId)?.recentId) || null;
        state.view = 'writing';
        // 只使用已从服务端读到的真实最近章节；没有章节时进入写作台的空状态。
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
        // F-33：复用 castNums 把数字字段 Number 化，避免表单字符串落库导致类型不一致。
        const data = castNums(collectModalData(modal));
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
          const r = await api('/demo/install', { method: 'POST', body: { force: !!reinstall }, timeout: 300000 });
          // F-14：先设置状态，再用可选链兜底拼接提示文案，避免 r.counts 缺失时抛 TypeError。
          state.workId = r.work_id;
          state.loadedWorkId = null;
          state.work = null;
          state.view = 'overview';
          state.currentChapterId = null;
          const c = r.counts || {};
          // N-08：设定库词条（terms）与世界规则词条（world_entries）是两个体系，
          // 之前 toast 只报 world_entries 数量，与总览的「设定词条」统计口径不一致，新人会以为数据丢了。
          toast(`已导入示例《${r.title || '雾都缝匠'}》：${c.chapters ?? 0} 章 / ${c.characters ?? 0} 角色 / ${c.terms ?? 0} 设定词条 / ${c.world_entries ?? 0} 世界观词条 / ${c.events ?? 0} 事件`, 'success');
          state.demoStatusLoaded = false; // F-30：示例状态变更，缓存失效
          state.demoStatus = null;
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
        await api('/demo/remove', { method: 'POST', timeout: 120000 });
        toast('示例数据已删除', 'success');
        if (state.workId && state.work?.title === '雾都缝匠') {
          state.workId = null;
          state.work = null;
          state.loadedWorkId = null;
          state.view = 'works';
          state.currentChapterId = null;
        }
        state.demoStatusLoaded = false; // F-30：示例状态变更，缓存失效
        state.demoStatus = null;
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
        if (!(await ensureSavedBeforeNavigation())) break;
        state.currentChapterId = Number(actionEl.dataset.id);
        state.view = 'writing';
        await render();
        break;
      }

      case 'set-layout': {
        // 布局切换会重绘写作台，先保存正文；selection/undo 属于编辑器 DOM，
        // 在此处只切布局，不把布局状态误当成正文变更。
        if (!(await ensureSavedBeforeNavigation())) break;
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
        // 取消目标 = **当前**进度卡（不再依赖 activeAITask 是否被某条路径 setCancel 过）：
        // 卡片自己知道该调谁（显式回调优先，否则调所有已登记的句柄）。
        const card = currentProgressCard;
        if (card && typeof card.runCancel === 'function') {
          if (actionEl) { actionEl.disabled = true; actionEl.textContent = '停止中…'; }
          card.runCancel();
        } else if (activeAITask && activeAITask.cancel) {
          if (actionEl) { actionEl.disabled = true; actionEl.textContent = '停止中…'; }
          activeAITask.cancel();
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

      // 采纳冲突的两个出口（2026-10-02）：先不写 / 以我的当前内容覆盖。
      // 覆盖时由调用方重取服务端权威基线再提交一次，被覆盖的那一版仍会进历史版本。
      case 'adopt-conflict-force': {
        const pending = state.pendingAdoptConflict;
        state.pendingAdoptConflict = null;
        closeModal();
        if (pending?.resolve) pending.resolve(true);
        break;
      }

      case 'adopt-conflict-cancel': {
        const pending = state.pendingAdoptConflict;
        state.pendingAdoptConflict = null;
        closeModal();
        if (pending?.resolve) pending.resolve(false);
        break;
      }

      // F3（2026-10-06）「旧内容是否保存？」的两个出口：都继续写入新内容，只是旧那一版怎么处理不同。
      case 'save-old-content-yes': {
        const pending = state.pendingOldContent;
        state.pendingOldContent = null;
        closeModal();
        if (pending?.resolve) pending.resolve(true);
        break;
      }

      case 'save-old-content-no': {
        const pending = state.pendingOldContent;
        state.pendingOldContent = null;
        closeModal();
        if (pending?.resolve) pending.resolve(false);
        break;
      }

      case 'long-text-retry': {
        const retry = state.pendingLongTextRetry;
        state.pendingLongTextRetry = null;
        state.pendingLongTextAltRetry = null;
        closeModal();
        if (retry) await retry();
        break;
      }

      case 'long-text-retry-alt': {
        const alt = state.pendingLongTextAltRetry;
        state.pendingLongTextRetry = null;
        state.pendingLongTextAltRetry = null;
        closeModal();
        if (alt) await alt();
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
        // R03：勾选集合必须在 closeModal() 之前固化（关窗后 DOM 已被清空）
        state.pendingProposalSelection = captureProposalSelection();
        closeModal();
        if (resolve) resolve('insert');
        break;
      }

      case 'ai-writing-replace': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        state.pendingProposalSelection = captureProposalSelection();
        closeModal();
        if (resolve) resolve('replace');
        break;
      }

      case 'ai-writing-append': {
        const resolve = state.pendingAIFinal;
        state.pendingAIFinal = null;
        state.pendingProposalSelection = captureProposalSelection();
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

      case 'ai-writing-review': {
        // 草稿链标记：这份审稿/修稿的"原文"是 AI 写作草稿，不是章节正文（合并闸门要以正文为基准）。
        const info = state.pendingAIArticle ? { ...state.pendingAIArticle, fromDraft: true } : null;
        state.pendingAIFinal = null;
        state.pendingAIArticle = null;
        // 先审稿再应用：勾选集合要活着穿过 审稿 → 清单 → 修稿 → 差异合并，最后随合并在同一事务里采纳
        state.pendingProposalSelection = captureProposalSelection();
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
        // 客户端先校验：服务端对「六个字段全空」返回 400，而旧实现会关掉弹窗、
        // 打印一句 toast 后照样继续成文 —— 结果是「蓝图没存上、成文却跑了」，
        // 章节的 blueprint_json 留下空白（2026-09-14 真实事故）。
        const bp = {
          scene_goal: $('#bp-scene-goal')?.value?.trim() || '',
          plot_points: $('#bp-plot-points')?.value?.trim() || '',
          conflicts: $('#bp-conflicts')?.value?.trim() || '',
          character_changes: $('#bp-char-changes')?.value?.trim() || '',
          hook: $('#bp-hook')?.value?.trim() || '',
          references: $('#bp-references')?.value?.trim() || '',
          target_words: Number($('#bp-target-words')?.value) || resolveTargetWords()
        };
        // ⚠️ 只校验六个文本字段：target_words 有默认值（2000），永远为真，
        // 把它算进 `Object.values(bp).some(...)` 会让这道校验被永久短路 ——
        // 六个字段全空也能通过（2026-09-14 事故后此校验曾被这样写废）。
        const textFields = [bp.scene_goal, bp.plot_points, bp.conflicts, bp.character_changes, bp.hook, bp.references];
        if (!textFields.some((v) => String(v || '').trim())) {
          const hint = document.getElementById('bp-empty-hint');
          if (hint) hint.hidden = false;
          toast('蓝图内容不能全为空：至少填一项（或点「跳过蓝图直接成文」）', 'error');
          break;
        }
        state.pendingBlueprint = null;
        closeModal();
        if (resolve) resolve(bp);
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

      // 「立即保存」（2026-10-05）：未保存提醒条上的一键出口。它只是**立刻**把作者手里那一版写一次，
      // 不弹确认、不拦操作；写不成也照常返回（后台重试继续）。
      case 'editor-save-now': {
        await retryUnsavedEditorSaves();
        if (!hasUnsavedEditorWork()) toast('已保存', 'success');
        break;
      }

      // 空内容暂停的两条出路（见 recoveryBarHtml 的 🛡 条）：都必须是**一次点击**能走完的动作，
      // 否则作者只会看到"暂停了"而没有出口（2026-10-02 事故复盘）。
      case 'editor-empty-restore':
        await restoreLastSavedVersion();
        break;

      case 'editor-empty-clear':
        await clearChapterBodyExplicit();
        break;

      case 'editor-conflict-local':
        await resolveEditorConflict('local');
        break;

      case 'editor-conflict-server':
        await resolveEditorConflict('server');
        break;

      case 'open-save-history':
        await openSaveHistory();
        break;

      case 'view-version':
        await viewSaveVersion(actionEl.dataset.id);
        break;

      case 'restore-draft':
        await restoreChapterDraft();
        break;

      case 'preview-draft':
        previewChapterDraft();
        break;

      case 'dismiss-draft':
        await dismissChapterDraft();
        break;

      case 'open-last-review':
        await openLastReview();
        break;

      case 'dismiss-review':
        await dismissChapterReview();
        break;

      // 已保存蓝图：按它生成正文 / 只读查看 / 删除（历史条上的三个按钮，2026-10-06）。
      case 'bp-generate':
        await generateFromSavedBlueprint(actionEl.dataset.id);
        break;

      case 'bp-view':
        viewSavedBlueprint(actionEl.dataset.id);
        break;

      case 'bp-delete':
        await deleteSavedBlueprint(actionEl.dataset.id);
        break;

      case 'resume-job':
        await resumeHarnessJob(actionEl.dataset.id);
        break;

      case 'fetch-job':
        await fetchHarnessJobResult(actionEl.dataset.id);
        break;

      case 'dismiss-job':
        await dismissJobResult(actionEl.dataset.id);
        break;

      case 'restore-version':
        await restoreSaveVersion(actionEl.dataset.id);
        break;

      case 'refresh-ai-errors':
        await loadAIErrors();
        break;

      case 'shutdown-server': {
        // N-10：确认文案口语化，说明后果（此前「释放端口」对新手无意义，误点就关掉整个服务）。
        if (!confirm('确定要关闭 Novel Studio 服务吗？\n\n关闭后本页面将无法继续使用，需要重新启动服务（运行 start-novel-studio.cmd 或 node server.js）才能恢复。')) break;
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
        const format = actionEl.dataset.format;
        // F-36：bold/italic/underline 用 Range 包裹，H2/引用用 Range 整块替换；列表结构复杂，
        // 浏览器 execCommand 处理最稳，保留为兜底（其余格式已迁移到 Selection/Range）。
        if (format === 'bold') applyInlineFormat('B');
        else if (format === 'italic') applyInlineFormat('I');
        else if (format === 'underline') applyInlineFormat('U');
        else if (format === 'formatBlock') applyBlockFormat(actionEl.dataset.value === 'h2' ? 'H2' : 'BLOCKQUOTE');
        else if (format === 'insertUnorderedList' || format === 'insertOrderedList') {
          editor.focus();
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

      // 确定性连续性预检：把某条 finding 记成「这是故意的」/ 恢复（2026-09-22 报告 · 第 1 步）。
      // 为什么要有这个按钮：预检是**字面判据**（"系统"出现几次、字数多少、卡上写的哪一卷），
      // 作者知道哪些是刻意的。没有豁免入口，重复出现的提示会让人对整个预检脱敏——
      // 那比不检查更糟。豁免键不含措辞与章节，所以改稿、换章都不会让它复活。
      case 'continuity-exempt':
      case 'continuity-restore': {
        const workId = Number(actionEl.dataset.workId) || Number(state.workId) || null;
        const key = actionEl.dataset.key || '';
        if (!workId || !key) break;
        const restoring = action === 'continuity-restore';
        try {
          await api('/novel/continuity_exemption', {
            method: 'POST',
            body: { work_id: workId, key, action: restoring ? 'restore' : 'exempt' }
          });
          toast(restoring ? '已恢复这条预检提示' : '已记为「这是故意的」，这条以后不再重复报', 'success');
          // 就地刷新预检块（章节内容没变，不必整页重渲染）
          const slot = $('#continuity-guard-slot');
          if (slot) {
            const chapterId = Number(actionEl.dataset.chapterId) || null;
            const draft = (state.pendingAIArticle && state.pendingAIArticle.article) || '';
            const fresh = await loadContinuityGuard(chapterId, draft);
            if (fresh) slot.innerHTML = continuityGuardSummaryHtml(fresh, chapterId);
          }
        } catch (e) {
          toast('操作失败：' + e.message, 'error');
        }
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
        state.termsCache.delete(id); // F-32：同步删除缓存，避免词条链接/悬浮提示读到已删词条
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
          // N-07：结果驻留显示在配置卡上（此前只有 2.5s 的瞬态 toast，容易错过）。
          state.apiTestResults[id] = { ok: true, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), msg: '' };
          toast('连接成功', 'success');
        } catch (e) {
          state.apiTestResults[id] = { ok: false, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), msg: e.message };
          toast('连接失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '测试连接';
          await render();
        }
        break;
      }

      // ---------- AI 设置页：OpenViking 记忆库卡 ----------
      case 'save-ov-config': {
        const endpointEl = $('#ov-endpoint-input');
        const keyEl = $('#ov-key-input');
        if (!endpointEl) break;
        const body = { endpoint: String(endpointEl.value || '').trim() };
        // 空 Key = 不改动（要清除请按「清除已保存的 Key」）——与后端 PUT 的字段契约一致。
        const typedKey = String(keyEl?.value || '').trim();
        if (typedKey) body.api_key = typedKey;
        const btn = actionEl;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '保存中…';
        try {
          state.ovStatus = await api('/novel/openviking', { method: 'PUT', body });
          renderOpenVikingStatus();
          if (state.envTools) renderEnvTools();
          const healthy = state.ovStatus.healthy === true;
          toast(healthy ? '已保存，OpenViking 连接正常' : '已保存，但 OpenViking 目前没有响应（不影响手动写作）', healthy ? 'success' : 'error');
        } catch (e) {
          toast('保存失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
        break;
      }

      case 'test-ov-connection': {
        const btn = actionEl;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '测试中…';
        try {
          state.ovStatus = await api('/novel/openviking');
          renderOpenVikingStatus();
          if (state.envTools) renderEnvTools();
          const healthy = state.ovStatus.healthy === true;
          toast(healthy ? 'OpenViking 连接成功' : 'OpenViking 没有响应：确认服务已启动，地址/端口是否填对', healthy ? 'success' : 'error');
        } catch (e) {
          toast('测试失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
        break;
      }

      case 'clear-ov-key': {
        if (!confirm('清除工坊内保存的 OpenViking Key？\n\n清除后会回到配置文件 / 环境变量里的凭证。')) break;
        try {
          state.ovStatus = await api('/novel/openviking', { method: 'PUT', body: { clear_api_key: true } });
          renderOpenVikingStatus();
          if (state.envTools) renderEnvTools();
          toast('已清除工坊内保存的 Key', 'success');
        } catch (e) {
          toast('清除失败：' + e.message, 'error');
        }
        break;
      }

      case 'write-ov-global': {
        if (!confirm('把当前生效的 OpenViking 地址与 Key 写入全局配置文件？\n\n• 目标：~/.openviking/ovcli.conf\n• 只改 url / api_key 两个字段，其它字段原样保留\n• 写入前自动备份原文件\n\n这一步是为了让 dsh 侧（GUI 会话 / AI 写作任务）也用同一份凭证。')) break;
        try {
          const out = await api('/novel/openviking/global_config', { method: 'POST', body: {} });
          renderOpenVikingStatus();
          const changed = (out.changed || []).join('、');
          toast(changed ? `已写入全局配置：${changed}` : (out.message || '无需改动'), 'success');
          // 备份路径与还原方法必须**看得见、能复制**：写的是作者主目录下的文件，
          // 只在 toast 里闪一下不够（toast 会消失，路径又长）。
          if (typeof alert === 'function') {
            alert(`全局配置已处理\n\n文件：${out.path}\n改动：${changed || '无'}\n备份：${out.backup || '（写入前不存在该文件）'}\n${out.restore_hint || ''}\n\n${out.note || ''}`);
          }
        } catch (e) {
          toast('写入失败：' + e.message, 'error');
        }
        break;
      }

      // ---------- AI 设置页：本地创作内核（dsh）卡 ----------
      case 'save-dsh-repo': {
        const input = $('#dsh-repo-input');
        if (!input) break;
        const dir = String(input.value || '').trim();
        const btn = actionEl;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '保存中…';
        try {
          const out = await api('/env/dsh_repo', { method: 'PUT', body: { dir } });
          toast(out.dsh && out.dsh.found ? '已保存，dsh 已找到' : '已保存，但仍未找到 dsh（检查路径）', out.dsh && out.dsh.found ? 'success' : 'error');
          await loadEnvTools();
        } catch (e) {
          // 填了一个不是 dsh 仓库的目录时后端会明确拒绝，这里原样把原因显示出来。
          toast('保存失败：' + e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
        break;
      }

      case 'refresh-env-tools': {
        const btn = actionEl;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '检测中…';
        try {
          await loadEnvTools();
          await loadOpenVikingStatus();
          toast('已重新检测', 'success');
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
        break;
      }

      case 'open-folder': {
        const target = actionEl.dataset.target || '';
        try {
          const out = await api('/env/open_folder', { method: 'POST', body: { target } });
          toast(`已在文件管理器打开：${out.label || target}`, 'success');
        } catch (e) {
          toast('打开失败：' + e.message, 'error');
        }
        break;
      }

      case 'copy-text': {
        const text = actionEl.dataset.copy || '';
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            toast('已复制到剪贴板', 'success');
          } else {
            throw new Error('浏览器不支持剪贴板接口');
          }
        } catch (e) {
          toast('复制失败，请手动选中命令复制：' + e.message, 'error');
        }
        break;
      }

      case 'save-api-config': {
        const modal = $('.modal');
        const data = collectModalData(modal);
        data.temperature = Number(data.temperature);
        data.max_tokens = Number(data.max_tokens);
        const id = actionEl.dataset.id;
        // 编辑且未填新 key：传 null 表示保持原密钥（后端跳过 api_key 更新，避免回写掩码覆盖真实密钥）。
        if (id && !String(data.api_key || '').trim()) data.api_key = null;
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

      case 'save-edit-rules':
        await saveEditRules();
        break;

      case 'scan-edit-rules':
        await scanEditRules();
        break;

      // R09：作者样文 / 文风档案 / 三级意图
      case 'new-author-sample':
        openAuthorSampleModal();
        break;

      case 'edit-author-sample': {
        const sample = ((state.authorStyle && state.authorStyle.samples && state.authorStyle.samples.samples) || [])
          .find((s) => s.id === Number(actionEl.dataset.id));
        openAuthorSampleModal(sample || null);
        break;
      }

      case 'save-author-sample':
        await saveAuthorSample(actionEl.dataset.id || null);
        break;

      case 'toggle-author-sample':
        await toggleAuthorSample(actionEl.dataset.id, !!actionEl.checked);
        break;

      case 'delete-author-sample':
        await deleteAuthorSample(actionEl.dataset.id);
        break;

      case 'analyze-author-profile':
        await analyzeAuthorProfile();
        break;

      case 'save-author-intents':
        await saveAuthorIntents();
        break;

      // R10：故事状态与披露视图
      case 'toggle-story-state':
        await toggleStoryState();
        break;

      case 'refresh-disclosure':
        await refreshDisclosure();
        break;

      // T6：章末状态面板（三档视图 + 本章提案一次确认）
      case 'panel-view':
        await setChapterPanelView(actionEl.dataset.view);
        break;

      case 'panel-jump':
        jumpToEvidence(actionEl.dataset.quote);
        break;

      case 'panel-confirm-proposals':
        await confirmChapterProposals();
        break;

      // T6：影响分析（只分析、只标记）
      case 'impact-analyze':
        await impactAnalyze();
        break;

      // T6：逐章重建（按钮授权：start / 进度 / 取消 / 恢复 / 应用 / 撤销 / 候选预览）
      case 'repair-start':
        await repairStart();
        break;

      case 'repair-refresh':
        await repairRefresh();
        break;

      case 'repair-cancel':
        await repairAction('cancel');
        break;

      case 'repair-resume':
        await repairAction('resume');
        break;

      case 'repair-apply':
        await repairAction('apply');
        break;

      case 'repair-revert':
        await repairAction('revert');
        break;

      case 'repair-preview':
        await repairPreview(Number(actionEl.dataset.idx));
        break;

      // T7：时态引擎开关（迁移门禁 / 预算告知）与存量重建（逐章按钮流程）
      case 'temporal-refresh':
        state.temporalEngine = null; state.backfill = null;
        await render();
        break;

      case 'temporal-toggle':
        await temporalToggle(actionEl.dataset.flag, actionEl.dataset.value === 'true');
        break;

      case 'backfill-refresh':
        state.backfill = null;
        await render();
        break;

      case 'backfill-step':
        await backfillStepRun(Number(actionEl.dataset.id));
        break;

      case 'backfill-record':
        await backfillStepRun(Number(actionEl.dataset.id), { record: true });
        break;

      case 'backfill-confirm':
        await backfillConfirmRun(Number(actionEl.dataset.id));
        break;

      case 'backfill-bootstrap-plan':
        await backfillBootstrapPlan();
        break;

      case 'backfill-bootstrap-decide': {
        let chapterId = null;
        if (actionEl.dataset.decision === 'confirm' && actionEl.dataset.effective === 'chapter') {
          const sel = document.getElementById(`bf-boot-ch-${actionEl.dataset.id}`);
          chapterId = Number(sel && sel.value) || null;
        }
        await backfillBootstrapDecide(actionEl.dataset.id, actionEl.dataset.decision || 'confirm', actionEl.dataset.effective || 'opening', chapterId);
        break;
      }

      // R12：导入后分析重建（分批抽取；确认即逐批原子应用）
      case 'rebuild-plan':
      case 'rebuild-resume':
        await rebuildPlan();
        break;

      case 'rebuild-refresh': {
        state.rebuild = null; state.rebuildLoaded = false;
        await loadRebuild(true);
        await render();
        break;
      }

      case 'rebuild-extract':
        await rebuildExtractBatch(Number(actionEl.dataset.index));
        break;

      case 'rebuild-confirm':
        await rebuildConfirm([Number(actionEl.dataset.index)]);
        break;

      case 'rebuild-confirm-all':
        await rebuildConfirm(null);
        break;

      case 'rebuild-cancel':
        await rebuildCancel();
        break;

      // P4：共享资料库（作者动作入口；导入 / 删除都先预览、再确认）
      case 'library-refresh':
        await libraryRefresh();
        break;

      case 'library-search':
        await librarySearchRun();
        break;

      case 'library-search-clear':
        librarySearchSeq += 1; // 清空后，在途检索响应不得再把结果贴回来
        state.librarySearch = null;
        await libraryRenderSafely();
        break;

      case 'library-category':
        await librarySetCategory(actionEl.dataset.category || '');
        break;

      case 'library-view':
        await libraryViewDoc(Number(actionEl.dataset.id));
        break;

      case 'library-toggle':
        await libraryToggleEnabled(actionEl.dataset.enabled === '1');
        break;

      case 'library-import-preview':
        await libraryPreviewImport();
        break;

      case 'library-import-confirm':
        await libraryConfirmImport();
        break;

      case 'library-mark':
        await libraryMarkMissing(Number(actionEl.dataset.id));
        break;

      case 'library-delete':
        await libraryDeleteDoc(Number(actionEl.dataset.id));
        break;

      case 'library-doc-page':
        await libraryViewDoc(
          Number(state.libraryDoc && state.libraryDoc.doc && state.libraryDoc.doc.id),
          Math.max(0, Number(actionEl.dataset.offset) || 0)
        );
        break;

      case 'library-doc-close':
        libraryDocSeq += 1; // 关闭后，在途的「读原文」响应不得再把卡贴回来
        state.libraryDoc = null;
        await libraryRenderSafely();
        break;

      // R11：剧情分支沙盘（候选是提案；采纳/丢弃/取消/重开是作者动作）
      case 'branch-open-sandbox':
        openBranchSandboxModal();
        break;

      case 'branch-do-open':
        await branchCreateSandbox();
        break;

      case 'branch-submit':
        openBranchSubmitModal();
        break;

      case 'branch-fill-template': {
        const ta = $('#branch-candidates-json');
        if (ta) ta.value = branchTemplate();
        break;
      }

      case 'branch-do-submit':
        await branchSubmitCandidates(actionEl.dataset.sandboxId || '');
        break;

      case 'branch-view':
        await branchView(Number(actionEl.dataset.id));
        break;

      case 'branch-compare':
        await branchCompareAll();
        break;

      case 'branch-adopt':
        await branchAdopt(Number(actionEl.dataset.id), false);
        break;

      case 'branch-adopt-force':
        await branchAdopt(Number(actionEl.dataset.id), true);
        break;

      case 'branch-discard':
        openBranchConfirm('discard', Number(actionEl.dataset.id));
        break;

      case 'branch-do-discard':
        await branchDiscard(Number(actionEl.dataset.id));
        break;

      case 'branch-cancel':
        openBranchConfirm('cancel', Number(actionEl.dataset.id));
        break;

      case 'branch-do-cancel':
        await branchCancel(Number(actionEl.dataset.id));
        break;

      case 'branch-reopen':
        await branchReopen(Number(actionEl.dataset.id));
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
        // D6（2026-09-18）：这条入口此前走的是**另一套**一次性管线（buildAIWriteMessages 自己拼上下文，
        // 然后一次 runHarnessFromMessages）——没有蓝图、没有目标字数补足、没有质检轮、也没有采纳率埋点；
        // 同一个「AI 写作」在工具栏与参考面板行为完全不同，且走这条路的成文在后续一致性核对里缺蓝图锚点。
        // 现在统一到工具栏那条管线：需求确认 → 蓝图（直连优先）→ 成文 → 质检 → 补足。
        toast('已改用与工具栏「✍️ AI 写作」相同的流程（需求 → 蓝图 → 成文）', 'success');
        await performToolbarAIWrite($('#ai-prompt')?.value?.trim() || '');
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

      case 'ai-insert': {
        // F-04/F-25：删除 insertAIDraft 的重复实现，统一走 insertHtmlAtCursor + textToParagraphsHtml（已转义）。
        const draft = state.aiDraft;
        const editor = $('#editor-content');
        if (!draft || !editor) break;
        insertHtmlAtCursor(editor, textToParagraphsHtml(draft));
        scheduleSave();
        toast('已插入 AI 内容', 'success');
        break;
      }

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

      case 'logs-refresh':
        await refreshLogs(true);
        break;

      case 'logs-more':
        await refreshLogs(false);
        break;

      case 'logs-clear': {
        if (!confirm('确定清空全部日志记录？此操作不可撤销。')) break;
        await api('/logs', { method: 'DELETE' });
        await refreshLogs(true);
        toast('日志已清空');
        break;
      }

      // ---------- 🐞 运行追踪 ----------
      case 'trace-toggle':
        await traceToggle();
        break;

      case 'trace-open': {
        const id = actionEl.dataset.id;
        trace.detailOpId = trace.detailOpId === id ? '' : id;
        if (trace.detailOpId && !trace.detailCache.has(id)) await loadTraceDetail(id);
        renderTraceList();
        break;
      }

      case 'trace-sessions-refresh':
        await refreshTraceSessions();
        break;

      case 'trace-open-session':
        await openTraceSession(actionEl.dataset.file || '');
        break;

      case 'trace-export-session':
        await exportTraceSession(actionEl.dataset.file || '');
        break;

      case 'trace-purge': {
        if (!confirm('确定删除全部录制文件？此操作不可撤销（当前录制中的会话也会被清空文件）。')) break;
        await api('/debug/purge', { method: 'DELETE' });
        await refreshTraceSessions();
        toast('录制文件已清空');
        break;
      }

      default:
        break;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

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

// ---------- Command Palette ----------
// 命令面板只复用现有 goView()/search API，不引入新的业务入口或后端接口。
// 搜索结果始终是候选导航；AI、正文和 Story State 都不会因打开面板而自动执行。
const PALETTE_COMMANDS = [
  { kind: 'command', id: 'works', icon: '📚', title: '我的作品', hint: '返回作品库', run: () => { state.workId = null; state.loadedWorkId = null; state.work = null; state.view = 'works'; return render(); } },
  { kind: 'command', id: 'writing', icon: '✍', title: '写作台', hint: '打开当前作品的正文编辑器', run: () => { if (!state.workId) { toast('请先打开一部作品', 'error'); return; } state.view = 'writing'; return render(); } },
  { kind: 'command', id: 'overview', icon: '▦', title: '作品总览', hint: '查看统计与最近更新', run: () => { if (!state.workId) { toast('请先打开一部作品', 'error'); return; } state.view = 'overview'; return render(); } },
  { kind: 'command', id: 'outline', icon: '☷', title: '大纲', hint: '卷、章节与剧情结构', run: () => { if (!state.workId) { toast('请先打开一部作品', 'error'); return; } goView('outline'); return render(); } },
  { kind: 'command', id: 'terms', icon: '◇', title: '设定词条', hint: '管理世界设定与资料', run: () => { if (!state.workId) { toast('请先打开一部作品', 'error'); return; } goView('terms'); return render(); } },
  { kind: 'command', id: 'characters', icon: '♙', title: '角色档案', hint: '人物、关系与状态', run: () => { if (!state.workId) { toast('请先打开一部作品', 'error'); return; } goView('characters'); return render(); } },
  { kind: 'command', id: 'story-state', icon: '◈', title: '故事状态', hint: '查看经过确认的故事事实', run: () => { if (!state.workId) { toast('请先打开一部作品', 'error'); return; } goView('story-state'); return render(); } },
  { kind: 'command', id: 'ai', icon: '✦', title: '提案与 AI 工具', hint: '打开长期记忆与待确认提案', run: async () => { if (!state.workId) { state.view = 'ai'; return render(); } if (!(await ensureSavedBeforeNavigation())) return; goView('memory'); return render(); } },
  { kind: 'command', id: 'theme', icon: '☾', title: '切换主题', hint: '在浅色与深色之间切换', run: () => toggleTheme() },
  { kind: 'command', id: 'global-search', icon: '⌕', title: '全局搜索', hint: '搜索章节、人物、设定与世界观', run: () => { const input = $('#global-search'); if (input) { input.focus(); input.select(); } } }
];

function paletteQuery() {
  return String(state.commandPalette.query || '').trim().toLowerCase();
}

function paletteMatches(item, q) {
  if (!q) return true;
  const haystack = `${item.title || ''} ${item.hint || ''} ${item.snippet || ''}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((part) => haystack.includes(part));
}

function paletteResultItems(data, q) {
  const rows = [];
  const add = (type, icon, items, titleOf, hintOf) => (items || []).slice(0, 8).forEach((x) => rows.push({
    kind: 'result', type, icon, id: x.id, workId: x.work_id || state.workId || null,
    title: titleOf(x), hint: hintOf(x), snippet: x.snippet || x.summary || x.content || x.identity || ''
  }));
  add('chapter', '§', data?.chapters, (x) => x.title, (x) => x.snippet || stripHtml(x.summary || x.content || '').slice(0, 80));
  add('character', '♙', data?.characters, (x) => x.name, (x) => x.identity || '角色档案');
  add('term', '◇', data?.terms, (x) => x.title, (x) => x.snippet || stripHtml(x.content || '').slice(0, 80));
  add('world_entry', '⌂', data?.world_entries, (x) => x.title, (x) => x.snippet || stripHtml(x.content || '').slice(0, 80));
  add('plotline', '↝', data?.plotlines, (x) => plotlineDisplayTitle(x), (x) => x.snippet || x.summary || '剧情线');
  return rows.filter((x) => !q || paletteMatches(x, q)).slice(0, 24);
}

function paletteCommandItems(q) {
  return PALETTE_COMMANDS.filter((x) => paletteMatches(x, q));
}

function renderCommandPalette() {
  const root = $('#command-palette-root');
  if (!root) return;
  if (!state.commandPalette.open) { root.innerHTML = ''; return; }
  const q = paletteQuery();
  const commands = paletteCommandItems(q);
  const items = [...commands, ...(state.commandPalette.items || [])];
  state.commandPalette.visibleItems = items;
  if (state.commandPalette.active >= items.length) state.commandPalette.active = Math.max(0, items.length - 1);
  let list = $('#command-palette-list');
  if (!list) {
    root.innerHTML = `<div class="command-palette-backdrop" data-palette-backdrop>
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="command-palette-head"><span class="command-palette-mark">⌘</span><input id="command-palette-input" type="search" autocomplete="off" placeholder="搜索命令、章节、人物、设定…" aria-controls="command-palette-list"><kbd>Esc</kbd></div>
        <div class="command-palette-status muted" id="command-palette-status" aria-live="polite"></div>
        <div class="command-palette-list" id="command-palette-list" role="listbox"></div>
        <div class="command-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>打开</span><span><kbd>Esc</kbd>关闭</span></div>
      </section></div>`;
    list = $('#command-palette-list');
    const input = $('#command-palette-input');
    if (input) {
      input.value = state.commandPalette.query;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  if (list) list.innerHTML = items.length ? items.map((item, i) => `<button class="command-item ${i === state.commandPalette.active ? 'active' : ''}" data-palette-index="${i}" role="option" aria-selected="${i === state.commandPalette.active}"><span class="command-item-icon">${esc(item.icon || '⌕')}</span><span class="command-item-copy"><b>${highlightTerms(item.title, q)}</b><small>${highlightTerms(item.hint || '', q)}</small></span><span class="command-item-key">${item.kind === 'result' ? '结果' : ''}</span></button>`).join('') : '<div class="command-empty">没有匹配内容</div>';
  const status = $('#command-palette-status');
  if (status) status.textContent = state.commandPalette.status === 'loading'
    ? '正在搜索…'
    : state.commandPalette.status === 'error'
      ? state.commandPalette.error
      : (q ? '搜索范围：章节、人物、设定、世界观、剧情线；Story State 请从命令进入' : '输入关键词搜索作品内容或命令');
}

function closeCommandPalette() {
  const returnFocus = state.commandPalette.returnFocus;
  state.commandPalette.open = false;
  state.commandPalette.query = '';
  state.commandPalette.items = [];
  state.commandPalette.active = 0;
  state.commandPalette.visibleItems = [];
  state.commandPalette.status = 'idle';
  state.commandPalette.error = '';
  state.commandPalette.returnFocus = null;
  renderCommandPalette();
  if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
}

function openCommandPalette(initial = '') {
  if (state.commandPalette.open) return;
  state.commandPalette.open = true;
  state.commandPalette.query = String(initial || '');
  state.commandPalette.items = [];
  state.commandPalette.active = 0;
  state.commandPalette.status = 'idle';
  state.commandPalette.error = '';
  state.commandPalette.returnFocus = document.activeElement;
  renderCommandPalette();
  refreshCommandPaletteResults();
}

let paletteSearchTimer = null;
async function refreshCommandPaletteResults() {
  const q = String(state.commandPalette.query || '').trim();
  const seq = ++state.commandPalette.seq;
  if (!q) { state.commandPalette.items = []; state.commandPalette.status = 'idle'; renderCommandPalette(); return; }
  clearTimeout(paletteSearchTimer);
  paletteSearchTimer = setTimeout(() => refreshCommandPaletteResultsNow(q, seq), 180);
}

async function refreshCommandPaletteResultsNow(q, seq) {
  if (!state.commandPalette.open || seq !== state.commandPalette.seq) return;
  state.commandPalette.status = 'loading';
  state.commandPalette.error = '';
  renderCommandPalette();
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}${state.workId ? `&work_id=${state.workId}` : ''}`);
    if (!state.commandPalette.open || seq !== state.commandPalette.seq) return;
    state.commandPalette.items = paletteResultItems(data, q);
    state.commandPalette.status = 'idle';
    state.commandPalette.active = Math.min(state.commandPalette.active, Math.max(0, paletteCommandItems(q).length + state.commandPalette.items.length - 1));
    renderCommandPalette();
  } catch (e) {
    if (seq === state.commandPalette.seq) { state.commandPalette.items = []; state.commandPalette.status = 'error'; state.commandPalette.error = `搜索失败：${e.message || '请稍后重试'}`; renderCommandPalette(); }
  }
}

async function executePaletteItem(item) {
  if (!item) return;
  if (!(await ensureSavedBeforeNavigation())) return;
  closeCommandPalette();
  if (item.kind === 'command') return item.run();
  return navigateSearchResult(item.type, item.id, item.workId);
}

async function navigateSearchResult(type, id, workId) {
  if (!(await ensureSavedBeforeNavigation())) return;
  const numericId = Number(id);
  const targetWork = Number(workId) || null;
  const crossing = targetWork && targetWork !== state.workId;
  if (crossing) {
    state.workId = targetWork; state.loadedWorkId = null; state.currentChapterId = null;
    state.currentPlotlineId = null; state.currentTermId = null; state.currentCharacterId = null;
  }
  if (type === 'term') { goView('terms'); state.currentTermId = numericId; }
  else if (type === 'chapter') { state.currentChapterId = numericId; state.view = 'writing'; }
  else if (type === 'character') { goView('characters'); state.currentCharacterId = numericId; }
  else if (type === 'plotline') { goView('plot'); state.currentPlotlineId = numericId; }
  else if (type === 'world_entry') goView('st');
  await render();
  if (crossing) toast('已进入对应作品并定位到搜索结果', 'success');
}

// F-09：全局搜索请求序号——仅最新一次请求的结果允许写 DOM，避免慢响应覆盖新结果。
let searchSeq = 0;

const debouncedSearch = debounce(async () => {
  const q = $('#global-search').value.trim();
  const box = $('#search-results');
  if (!q) { box.hidden = true; return; }
  const seq = ++searchSeq;
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}${state.workId ? `&work_id=${state.workId}` : ''}`);
    if (seq !== searchSeq) return; // 已被更新的请求取代，丢弃过期结果
    const group = (label, items, fn) => items.length ? `
      <div class="search-group-title">${label}（${items.length}）</div>
      ${items.map(fn).join('')}` : '';
    box.innerHTML = group('设定词条', data.terms, (t) => `<div class="search-item" data-action="search-go" data-type="term" data-id="${t.id}" data-work-id="${t.work_id || ''}"><div class="title">${highlightTerms(t.title, q)}</div><div class="snippet">${highlightTerms(t.snippet || stripHtml(t.content || '').slice(0, 60), q)}</div></div>`)
      + group('章节/正文', data.chapters, (c) => `<div class="search-item" data-action="search-go" data-type="chapter" data-id="${c.id}" data-work-id="${c.work_id || ''}"><div class="title">${highlightTerms(c.title, q)}</div><div class="snippet">${highlightTerms(c.snippet || stripHtml(c.summary || c.content || '').slice(0, 60), q)}</div></div>`)
      + group('角色', data.characters, (c) => `<div class="search-item" data-action="search-go" data-type="character" data-id="${c.id}" data-work-id="${c.work_id || ''}"><div class="title">${highlightTerms(c.name, q)}</div><div class="snippet">${highlightTerms(c.identity || '', q)}</div></div>`)
      + group('剧情线', data.plotlines, (p) => `<div class="search-item" data-action="search-go" data-type="plotline" data-id="${p.id}" data-work-id="${p.work_id || ''}"><div class="title">${highlightTerms(plotlineDisplayTitle(p), q)}</div><div class="snippet">${highlightTerms(p.snippet || p.summary || '', q)}</div></div>`)
      + group('世界观', data.world_entries, (w) => `<div class="search-item" data-action="search-go" data-type="world_entry" data-id="${w.id}" data-work-id="${w.work_id || ''}"><div class="title">${highlightTerms(w.title, q)}</div><div class="snippet">${highlightTerms(w.snippet || stripHtml(w.content || '').slice(0, 60), q)}</div></div>`)
      + group('🧠 语义相关（共享记忆库）', data.semantic?.hits || [], (s) => `<div class="search-item"><div class="title">${highlightTerms(s.label || '记忆条目', q)} <span class="muted" style="font-size:11px">${esc(s.kind || '')} · 相关度 ${recallPercent(s.score)}%</span></div><div class="snippet">${highlightTerms(s.text || '', q)}</div></div>`);
    if (!box.innerHTML) box.innerHTML = '<div class="muted search-empty">未找到与「' + esc(q) + '」相关的内容</div>';
    box.hidden = false;
  } catch (_) {
    if (seq === searchSeq) box.hidden = true;
  }
}, 300);

document.addEventListener('change', async (e) => {
  if (e.target.matches('[data-action="semantic-toggle"]')) {
    try {
      await api('/novel/semantic', { method: 'PUT', body: { enabled: e.target.checked } });
      await renderContextTab($('#reference-list'));
    } catch (_) { /* 开关失败忽略，下次刷新可见 */ }
    return;
  }
  if (e.target.id === 'import-file') {
    handleImportFile(e.target.files?.[0]);
    return;
  }
  if (e.target.id === 'st-chapter-select') {
    if (!(await ensureSavedBeforeNavigation())) return;
    state.currentChapterId = Number(e.target.value);
    await render();
  }
  // D15：单栏布局下的章节切换器
  if (e.target.id === 'chapter-switcher') {
    if (!(await ensureSavedBeforeNavigation())) return;
    state.currentChapterId = Number(e.target.value);
    await render();
    persistSession();
  }
  // 日志面板筛选
  if (e.target.id === 'log-level') {
    logsState.level = e.target.value;
    refreshLogs(true);
  }
  if (e.target.id === 'log-layer') {
    logsState.layer = e.target.value;
    refreshLogs(true);
  }
  // 🐞 运行追踪筛选
  if (e.target.id === 'trace-only-error') {
    trace.filters.onlyError = e.target.checked;
    renderTraceList();
  }
  if (e.target.id === 'trace-only-ai') {
    trace.filters.onlyAi = e.target.checked;
    renderTraceList();
  }
  if (e.target.id === 'trace-slow-filter') {
    trace.filters.slowMs = Number(e.target.value) || 0;
    renderTraceList();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'works-filter') {
    state.worksQuery = String(e.target.value || '');
    const q = state.worksQuery.trim().toLowerCase();
    $$('.work-card[data-work-search]').forEach((card) => { card.hidden = !!q && !String(card.dataset.workSearch || '').includes(q); });
    return;
  }
  if (e.target.id === 'global-search') {
    debouncedSearch();
  }
  if (e.target.id === 'log-q') {
    logsState.q = e.target.value;
    debouncedLogSearch();
  }
  if (e.target.id === 'trace-q') {
    trace.filters.q = e.target.value;
    renderTraceList();
  }
  if (e.target.id === 'link-term-search') {
    const q = e.target.value.trim().toLowerCase();
    const list = $('#link-term-list');
    if (!list) return;
    const items = state.terms.filter((t) => !q || t.title.toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q) || (t.tags || '').toLowerCase().includes(q));
    list.innerHTML = items.map((t) => `<div class="term-item" data-action="insert-term-link" data-id="${t.id}"><b>${esc(t.title)}</b><span class="muted grow">${esc((t.content || '').slice(0, 50))}</span></div>`).join('') || '<div class="muted">无匹配词条</div>';
  }
  if (e.target.id === 'term-search') {
    // F-06：input 常驻，只重建「词条列表子容器」#term-list，避免重建 input 自身导致焦点丢失。
    const q = e.target.value.trim().toLowerCase();
    const items = state.terms.filter((t) => !q || t.title.toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q) || (t.tags || '').toLowerCase().includes(q));
    const list = $('#term-list');
    if (list) {
      list.innerHTML = items.map((t) => `<div class="term-item ${state.currentTermId === t.id ? 'active' : ''}" data-action="select-term" data-id="${t.id}"><b>${esc(t.title)}</b><span class="muted grow" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.tags || '')}</span></div>`).join('') || '<div class="muted">暂无词条</div>';
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
  await navigateSearchResult(type, id, workId);
});

// 命令面板交互使用委托，面板重绘不会丢失焦点或键盘导航。
document.addEventListener('input', (e) => {
  if (e.target.id !== 'command-palette-input') return;
  state.commandPalette.query = e.target.value;
  state.commandPalette.active = 0;
  renderCommandPalette();
  refreshCommandPaletteResults();
});

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-palette-backdrop]') && !e.target.closest('.command-palette')) {
    closeCommandPalette();
    return;
  }
  const row = e.target.closest('[data-palette-index]');
  if (!row || !state.commandPalette.open) return;
  const item = (state.commandPalette.visibleItems || [])[Number(row.dataset.paletteIndex)];
  await executePaletteItem(item);
});

// tooltip
// 两用：① 正文里的词条链接（.term-link）→ 词条摘要；
//       ② 帮助标记（[data-help]：标题旁的小问号、字段小字）→ HELP_TEXT 里的解释。
// 合成一个 handler：定位/跟随/隐藏这些边界条件只维护一处（早先只认 .term-link，
// 于是"标题旁边加个小字提示"这件事没有现成通道，只能各自用原生 title——不可样式化、
// 触屏与键盘也看不到）。
function tooltipHtmlFor(el) {
  if (el.classList && el.classList.contains('term-link')) {
    const term = state.termsCache.get(Number(el.dataset.termId));
    if (!term) return '';
    return `<div class="tt-title">${esc(term.title)}</div><div class="tt-body">${esc((term.content || '').slice(0, 140))}</div>`;
  }
  const item = el.dataset && el.dataset.help ? HELP_TEXT[el.dataset.help] : null;
  if (!item) return '';
  return `<div class="tt-title">${esc(item.title)}</div><div class="tt-body">${esc(item.body)}</div>`;
}

function openTooltip(anchor, html, pos) {
  const tip = $('#tooltip');
  if (!tip) return;
  tip.innerHTML = html;
  tip.hidden = false;
  const place = (x, y) => {
    const maxLeft = Math.max(0, (window.innerWidth || 1200) - 360);
    tip.style.left = Math.min(x + 14, maxLeft) + 'px';
    tip.style.top = (y + 14) + 'px';
  };
  if (pos) place(pos.x, pos.y);
  else {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, bottom: 0 };
    place(r.left, r.bottom);
  }
  const onMove = (ev) => place(ev.clientX, ev.clientY);
  const onOut = () => {
    tip.hidden = true;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseout', onOut);
    document.removeEventListener('focusin', onFocusOut);
  };
  const onFocusOut = (ev) => { if (!anchor.contains(ev.target)) onOut(); };
  if (pos) document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseout', onOut);
  document.addEventListener('focusin', onFocusOut);
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest && e.target.closest('.term-link, [data-help]');
  if (!el) return;
  const html = tooltipHtmlFor(el);
  if (!html) return;
  openTooltip(el, html, { x: e.clientX, y: e.clientY });
});

// 键盘可达：Tab 聚焦到帮助标记时同样能看到解释（也顺便覆盖没有 hover 的触屏）。
document.addEventListener('focusin', (e) => {
  const el = e.target.closest && e.target.closest('[data-help]');
  if (!el) return;
  const html = tooltipHtmlFor(el);
  if (html) openTooltip(el, html, null);
});

// sidebar toggle
document.addEventListener('click', (e) => {
  if (e.target.closest('#sidebar-toggle')) {
    const sidebar = $('#sidebar');
    sidebar.classList.remove('hidden'); // F-13：折叠改用 .collapsed，避免 .hidden 的 display:none 吞掉动画
    state.sidebarCollapsed = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
    try { localStorage.setItem('ns_sidebar_collapsed', state.sidebarCollapsed ? '1' : '0'); } catch (_) {}
    updateSidebarToggleIcon();
    const backdrop = $('#sidebar-backdrop');
    if (backdrop) backdrop.classList.toggle('visible', !state.sidebarCollapsed && window.innerWidth <= 720);
  }
  if (e.target.closest('#sidebar-backdrop')) {
    state.sidebarCollapsed = true;
    $('#sidebar')?.classList.add('collapsed');
    $('#sidebar-backdrop')?.classList.remove('visible');
    try { localStorage.setItem('ns_sidebar_collapsed', '1'); } catch (_) {}
    updateSidebarToggleIcon();
  }
});

// sidebar nav
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#sidebar-nav button[data-view]');
  if (!btn) return;
  if (!(await ensureSavedBeforeNavigation())) return;
  state.view = btn.dataset.view;
  await render();
});

// keyboard: hide search on Escape
document.addEventListener('keydown', (e) => {
  const imeActive = !!(e.isComposing || state.imeComposing);
  if ((state.commandPalette.open || $('#modal-root').innerHTML) && e.key === 'Tab' && !imeActive) {
    const container = state.commandPalette.open ? $('.command-palette') : $('.modal');
    const selector = state.commandPalette.open
      ? 'button, input, [tabindex]:not([tabindex="-1"])'
      : 'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';
    const focusables = container ? $$(selector, container).filter((el) => !el.disabled && el.offsetParent !== null) : [];
    if (focusables.length) {
      const index = focusables.indexOf(document.activeElement);
      const next = focusables[(index + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length];
      e.preventDefault();
      next.focus();
    }
    return;
  }
  // 浏览器快捷键只在非输入法组合状态下接管；中文候选确认的 Enter 不应触发保存或导航。
  if (!imeActive && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    const editor = $('#editor-content');
    if (editor) {
      e.preventDefault();
      manualSaveChapter();
      return;
    }
  }
  if (!imeActive && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (state.commandPalette.open) closeCommandPalette();
    else openCommandPalette();
    return;
  }
  if (state.commandPalette.open && !imeActive) {
    const target = e.target && e.target.id === 'command-palette-input';
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = state.commandPalette.visibleItems || [];
      if (items.length) {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        state.commandPalette.active = (state.commandPalette.active + delta + items.length) % items.length;
        renderCommandPalette();
      }
      return;
    }
    if (e.key === 'Enter' && target) {
      e.preventDefault();
      executePaletteItem((state.commandPalette.visibleItems || [])[state.commandPalette.active]);
      return;
    }
  }
  if (e.key === 'Escape' && !imeActive) {
    if (!imeActive && window.innerWidth <= 720 && !state.commandPalette.open && !$('#modal-root').innerHTML && !state.sidebarCollapsed) {
      state.sidebarCollapsed = true;
      $('#sidebar')?.classList.add('collapsed');
      $('#sidebar-backdrop')?.classList.remove('visible');
      updateSidebarToggleIcon();
      return;
    }
    if (state.commandPalette.open) {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    const box = $('#search-results');
    if (box) box.hidden = true;
    if ($('#modal-root').innerHTML) closeModal();
  }
  // P4：资料检索框的回车 = 点「检索」（输入框随重绘换新元素，用 document 委托）
  // （isComposing：中文输入法候选确认的回车不算检索）
  if (e.key === 'Enter' && !imeActive && e.target && e.target.id === 'library-q') {
    e.preventDefault();
    librarySearchRun();
  }
});

// ---------- init ----------
// D11：侧栏折叠按钮图标随状态切换（◀=可收起 / ▶=可展开），不再用误导性的 ☰
function updateSidebarToggleIcon() {
  const icon = $('#sidebar-toggle');
  if (!icon) return;
  const collapsed = $('#sidebar').classList.contains('collapsed');
  icon.textContent = collapsed ? '▶' : '◀';
  // N-11：「◀」形似返回按钮，新人误以为能回到作品列表；加 title 说明实际行为。
  icon.title = collapsed ? '展开侧栏' : '收起侧栏（返回作品列表请点左上角图标）';
}

window.addEventListener('resize', () => {
  const backdrop = $('#sidebar-backdrop');
  if (!backdrop) return;
  backdrop.classList.toggle('visible', !state.sidebarCollapsed && window.innerWidth <= 720);
});

window.addEventListener('beforeunload', (e) => {
  // editorEmptyBlocked 也算"未保存内容"：它是被空内容护栏暂停的一版稿子，
  // 直接放行离开等于让护栏白做（刷新后那版被清空的编辑就真没了）。
  // 2026-10-05：加上"每章暂存稿"（切章留下的那一版）—— 关页面是唯一会把它们真的丢掉的动作，
  // 所以这里恰恰**要**提醒（这是作者要的"未保存的弹窗提醒"，不是操作闸门：站内任何操作都不拦）。
  if (state.editorSaveSnapshot || state.editorSaveInFlight.size || state.editorPendingByChapter.size
      || state.editorConflictSnapshot || state.editorSaveFailedSnapshot || state.editorEmptyBlocked) {
    e.preventDefault();
    e.returnValue = '当前章节还有未保存内容';
  }
});

async function init() {
  // P4：先取 AI 策略快照（模型档位 / 档位→强度表），让后续所有 AI 调用按同一份策略解析。
  // 失败不阻塞启动——policyModel/policyEffort 会退回本文件顶部的兜底常量。
  try {
    state.aiPolicy = await api('/ai/policy');
  } catch (_) {
    state.aiPolicy = null;
  }
  // 去 AI 味 P0：取写作规则快照（真源 ai/writing/policy.mjs）。失败不阻塞启动——
  // writingPolicyLines() 会退回同文兜底常量（与服务器同文，frontend-test 有防漂移断言）。
  try {
    state.writingPolicy = await api('/ai/writing-policy');
  } catch (_) {
    state.writingPolicy = null;
  }
  $('#global-search').addEventListener('focus', () => {
    const q = $('#global-search').value.trim();
    if (q) debouncedSearch();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) $('#search-results').hidden = true;
  });
  const topbarRight = $('#topbar-right');
  if (topbarRight) {
    topbarRight.innerHTML = `<button class="btn small secondary" data-action="open-command-palette" title="打开命令面板（Ctrl/Cmd+K）">⌘ K</button>
      <button class="btn small secondary" id="theme-toggle" data-action="toggle-theme" aria-label="切换主题"></button>
      <button class="btn small trace-btn" id="trace-toggle" data-action="trace-toggle" title="开始记录：你接下来的每一次操作跑了哪些代码、花了多久、调了什么 AI">⌁ 追踪</button>
      <button class="btn small danger" data-action="shutdown-server" title="关闭 Novel Studio 服务（关闭后本页面将失效）">关闭服务</button>`;
    applyTheme(document.documentElement.dataset.theme || 'light', { persist: false });
  }
  updateSidebarToggleIcon();
  // 🐞 运行追踪：刷新后若后端仍在录制则自动接上；否则只更新按钮显示。
  traceRestore();
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
  if (!state.workId) {
    // R06：首页视图（含「借鉴与致谢」）刷新后恢复；没有记录或记录非法时回到「我的作品」。
    let homeView = '';
    try { homeView = sessionStorage.getItem('ns_home_view') || ''; } catch (_) { /* 存储不可用时静默 */ }
    state.view = ['works', 'ai-create', 'ai', 'thanks', 'library'].includes(homeView) ? homeView : 'works';
  }
  await render();
}

init().catch((e) => toast(e.message, 'error'));
