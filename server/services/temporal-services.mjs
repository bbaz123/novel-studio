/**
 * server/services/temporal-services.mjs —— 时态写作的四个**应用用例**（S03）。
 *
 * ── 这个文件为什么存在 ──────────────────────────────────────────────────────
 * 改造前，保存 / 分析 / 确认 / 状态查询四类用例的**参数校验与业务裁决**直接写在
 * `server.js` 的 `if` 链里。后果有两个，都是实测撞到的：
 *   ① 想验证"缺少 chapter_id 会怎样"只能起一个真服务、发 HTTP 请求（慢，而且多数离线门禁跑不动）；
 *   ② 同一类判据（例如"章节必须属于该作品"）在每个分支各写一遍，写法一旦漂移，
 *      就会出现"某个入口放行了别的入口拒绝的请求"。
 *
 * 因此这里把**用例决策**抽出来，做成"输入纯数据 → 输出结构化结论"的函数：
 *   · 不 import `server.js`，不 import `db.js` 的连接，**不启动服务、不发网络请求、不调用模型**；
 *     一切对存储与内核的访问都通过 `deps` 注入（见下），因此可以在单元测试里用假 deps 精确断言；
 *   · 每个入口返回 `{ ok:false, status, message, code? }` 或 `{ ok:true, ... }`，
 *     由 `server.js` 负责 `sendJSON/sendError` —— **HTTP 细节留在路由层，用例判据留在这一层**。
 *
 * ⚠️ 平权纪律（S03 的验收项）：本文件**只搬运现有的判据，不新增、不放宽、不收紧**。
 * 因此每个函数都逐条对着原 `server.js` 分支写，并在注释里标出原行为；
 * `tests/nsdsh/save-service-parity.test.mjs` 负责钉住"结论与改造前逐字一致"。
 */

/**
 * 依赖注入的契约（调用方 = `server.js`）。
 * @typedef {object} TemporalDeps
 * @property {(sql: string) => any} prepare   预编译语句（与 server.js 同一套）
 * @property {(workId: number) => boolean} workExists
 * @property {(chapterId: number) => object|null} getChapter
 * @property {(workId: number) => object} temporal  时态内核门面（StoryState.Temporal）
 */

/** 结构化失败：交给路由层决定怎么写成 HTTP。 */
function bad(status, message, code = null) {
  return code ? { ok: false, status, message, code } : { ok: false, status, message };
}

/** 从请求体里取 work_id（与 server.js 的 workIdOf 同一口径）。 */
export function workIdOf(v) {
  return Number(v) || 0;
}

/**
 * 校验"作品存在 + 章节存在 + 章节属于该作品"这组**共用前置条件**。
 *
 * 为什么单独抽出来：同一条判据原先在 `confirm` / `apply` / `analyze` / `contract` 四个分支里
 * 各写了一遍，措辞还略微不同（"章节不存在或不属于该作品" vs 分两句报 404/400）。
 * 这里统一成一条，顺序与原始 `confirm` 分支一致：**先 400 缺参 → 404 作品 → 404 章节 → 400 跨作品**。
 *
 * @returns {{ok:true, workId:number, chapter:object} | {ok:false, status:number, message:string}}
 */
export function resolveChapterScope(deps, { workId, chapterId, requireChapter = true } = {}) {
  const w = workIdOf(workId);
  const c = Number(chapterId) || 0;
  if (!w) return bad(400, '缺少 work_id');
  if (!deps.workExists(w)) return bad(404, '作品不存在');
  if (!requireChapter) return { ok: true, workId: w, chapter: null };
  if (!c) return bad(400, '缺少 chapter_id');
  const ch = deps.getChapter(c);
  if (!ch || Number(ch.work_id) !== w) return bad(404, '章节不存在或不属于该作品');
  return { ok: true, workId: w, chapter: ch };
}

/**
 * 调内核并把"带 HTTP 语义的错误"交回路由层（S03 的 D3 修复靠它保住）。
 *
 * 为什么要这一层：内核在 HEAD CAS 冲突时**抛** `HEAD_CAS_MISMATCH`，而"冲突该回 409"是
 * **HTTP 语义**，按本文件的分工不该由服务层决定。所以服务层只负责把异常**原样交给**路由层
 * 提供的 `onKernelError`；路由层若把它映射成响应，就返回该结果，否则继续抛出。
 * 这样既能保持"服务层不知道 HTTP 状态码"，又不会把 D3 的 409 映射丢掉
 *（第一版把内核调用搬进来时正是丢掉了它——路由里那条 try/catch 不再包围真正的调用点）。
 */
function callKernel(fn, onKernelError) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (typeof onKernelError === 'function') {
      const mapped = onKernelError(e);
      if (mapped !== undefined && mapped !== null) return { ok: false, mapped };
    }
    throw e;
  }
}

/**
 * 用例 1：**确认清单**（`POST /novel/story_state/confirm`）。
 *
 * 原分支的判据（逐条搬运）：
 *   · 模型通道 403（`X-Novel-Agent` 不能确认自己的抽取）；
 *   · 缺 work_id 400 / 缺 chapter_id 400 / 章节不存在或跨作品 404；
 *   · `events` 必须是非空数组，否则 400「events 不能为空（确认清单必须带具体操作）」；
 *   · 然后调内核 `applyChapterEvents`，结果原样回给调用方（`ok` 与否由内核决定）。
 *
 * @param {object} [opts.onKernelError] 内核抛错时的 HTTP 映射钩子；返回非空即被采用（见 callKernel）。
 */
export function confirmEvents(deps, { workId, chapterId, events, source = 'author_confirm', expectedHead = null, contentHtml = null, requireAuthor = true, modelRequest = false, onKernelError = null } = {}) {
  if (requireAuthor && modelRequest) {
    return bad(403, '状态确认只能由作者发起：模型侧不能确认自己的抽取（该请求带 X-Novel-Agent 标记）');
  }
  const scope = resolveChapterScope(deps, { workId, chapterId });
  if (!scope.ok) return scope;
  if (!Array.isArray(events) || !events.length) {
    return bad(400, 'events 不能为空（确认清单必须带具体操作）');
  }
  const called = callKernel(() => deps.temporal.applyChapterEvents({
    workId: scope.workId, chapterId: Number(chapterId), events,
    source: source || 'author_confirm',
    author: 'author',
    expectedHead: expectedHead === undefined || expectedHead === null ? null : String(expectedHead),
    contentHtml: contentHtml === undefined ? null : contentHtml,
  }), onKernelError);
  if (!called.ok) return { ok: true, applied: false, handedToRoute: called.mapped };
  return { ok: true, applied: true, result: called.value };
}

/**
 * 用例 2：**确认提案组**（`POST /novel/story_state/proposal-groups/:id/apply`）。
 *
 * 原分支的判据（逐条搬运）：
 *   · 模型通道 403；
 *   · 缺 work_id 400 / 缺 chapter_id 400 / 章节不存在或跨作品 404；
 *   · 缺 `bindingId`（或字面量 `'undefined'`）400「缺少提案组 id」；
 *   · **原子组不得拆开采纳**：带 `events` / `event_ids` 一律 400
 *     （否则前端提交子集就能把"要么全确认、要么全拒绝"的组拆开）；
 *   · 再调内核 `confirmBinding`。
 */
export function confirmProposalGroup(deps, { workId, chapterId, bindingId, events, eventIds, approvalId = null, expectedHead = null, modelRequest = false, onKernelError = null } = {}) {
  if (modelRequest) {
    return bad(403, '确认提案只能由作者发起：模型侧不能确认自己的抽取（该请求带 X-Novel-Agent 标记）');
  }
  const scope = resolveChapterScope(deps, { workId, chapterId });
  if (!scope.ok) return scope;
  const id = String(bindingId == null ? '' : bindingId);
  if (!id || id === 'undefined') return bad(400, '缺少提案组 id');
  // AC-45：提案组要么整体确认，要么拒绝；不接受客户端提交事件子集，避免原子组被拆开。
  if (Array.isArray(events) || Array.isArray(eventIds)) {
    return bad(400, '提案组必须整体确认：不接受 events / event_ids 子集（原子组不能拆开采纳）');
  }
  const called = callKernel(() => deps.temporal.confirmBinding({
    workId: scope.workId, chapterId: Number(chapterId), bindingId: id,
    author: 'author',
    approvalId: approvalId ? String(approvalId) : null,
    expectedHead: expectedHead === undefined || expectedHead === null ? null : String(expectedHead),
  }), onKernelError);
  if (!called.ok) return { ok: true, applied: false, handedToRoute: called.mapped };
  return { ok: true, applied: true, result: called.value };
}

/**
 * 用例 3：**发起分析**（`POST /novel/story_state/analyze`）。
 *
 * 原分支的判据：模型通道 403；缺 work_id 400；**作品必须存在**；缺 chapter_id 400；
 * 章节不存在或跨作品 404。注意这里**不**要求 events（分析本来就没有事件）。
 */
export function analyzeChapterUseCase(deps, { workId, chapterId, modelRequest = false } = {}) {
  if (modelRequest) {
    return bad(403, '状态分析由作者发起：模型侧不能自行触发抽取（该请求带 X-Novel-Agent 标记）');
  }
  const scope = resolveChapterScope(deps, { workId, chapterId });
  if (!scope.ok) return scope;
  return { ok: true, workId: scope.workId, chapter: scope.chapter, chapterId: Number(chapterId) };
}

/**
 * 用例 4：**状态查询**（`GET /novel/story_state` 与 `GET /novel/state`）。
 *
 * 原分支的判据：缺 work_id 400；作品不存在 404；章节 id 给了就必须属于该作品（404）。
 * 查询**不要求**开启时态引擎——未开启时内核自己会回 `enabled:false`，路由不做二次裁决。
 */
export function queryStoryState(deps, { workId, chapterId = null } = {}) {
  const w = workIdOf(workId);
  if (!w) return bad(400, '缺少 work_id');
  if (!deps.workExists(w)) return bad(404, '作品不存在');
  let c = null;
  if (chapterId) {
    c = Number(chapterId) || 0;
    const ch = deps.getChapter(c);
    if (!ch || Number(ch.work_id) !== w) return bad(404, '章节不存在或不属于该作品');
  }
  return { ok: true, workId: w, chapterId: c };
}

/**
 * 从真实存储构造 `TemporalDeps`。**这是唯一接触数据库的地方**，
 * 而且它接收 `prepare` 与内核门面作为参数 —— 本模块自身不 import 任何生产模块，
 * 因此"import 领域模块会启动服务 / 打开数据库 / 调用模型"这件事在结构上不可能发生。
 */
export function makeTemporalDeps({ prepare, temporal }) {
  return {
    prepare,
    temporal,
    workExists: (workId) => !!prepare('SELECT id FROM works WHERE id = ?').get(Number(workId) || 0),
    getChapter: (chapterId) => prepare('SELECT id, work_id, title, summary, content FROM chapters WHERE id = ?').get(Number(chapterId) || 0) || null,
  };
}
