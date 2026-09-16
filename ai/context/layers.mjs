/**
 * 上下文分层规格 —— **唯一来源**。
 *
 * 在 P2 之前，同一份层规格存在于两个地方：`server.js` 的 `buildNovelContext`
 * （真实的 13 层）与 `docs` 里的散文描述；`.p1-baseline/context-floor.mjs` 是 P1 冻结的
 * **快照副本**，用于对照。本文件是「活」的那一份，装配器与预算核算都从这里读。
 *
 * 术语（P2 起明确化，见 docs/context-contract.md）：
 *   - `cap`      = **正文上限**（不含层标题与截断提示语）
 *   - `rendered` = 层标题 + 正文 + （被截断时的）提示语 = 该层在 assembled 中占用的真实字符数
 *   - 预算与收敛一律按 `rendered` 计算，因此 cap 不是「凭感觉」的数字，而是可核算的。
 *
 * `kind`：
 *   fixed   不参与收缩（零损失承诺的内容本身）
 *   flex    参与收缩，`floor` 为其正文收缩下限
 *   cond    条件层：数据缺失时整层不存在
 *   entity  层正文上限由构建函数决定（如角色卡的 5 级降级），此处声明其实际上限
 */

/**
 * 截断提示语：在不损失正文的前提下，让模型知道「这里被截断了」以及**用什么工具取回全文**。
 *
 * P5 更正：早先这句写死了「可用 novel_lookup 查证」——而 novel_lookup **覆盖不到长期记忆与
 * 事件账本**（它检索的是词条/章节/角色/剧情线/世界观/人物关系）。提示在误导模型：
 * 它照着去查只会一无所获。现在提示语由该层在 RETRIEVAL 里声明的工具生成；
 * 没有查回路径的层如实说明，不编一个查不到的工具名。
 */
export const truncationNotice = (originalLength, retrievalTool) =>
  `\n…（本层共 ${originalLength} 字，已按预算截断；${
    retrievalTool
      ? `如需精确内容可用 ${retrievalTool} 查证`
      : '被截掉的部分当前没有查回路径（已知缺口）'
  }）`;

/** 层标题渲染：`【label】\n` */
export const headerOf = (label) => `【${label}】\n`;

/** 空层占位（保持层的存在感，避免模型以为「没有这一类信息」与「这类信息为空」是一回事）。 */
export const EMPTY_PLACEHOLDER = '（无）';

/**
 * 层规格。顺序即渲染顺序。
 * `mode` 字段声明该层在哪些模式下出现；缺省表示所有模式。
 */
export const LAYERS = [
  { id: 'work', label: '作品', kind: 'fixed', cap: 900,
    source: 'works.title/description + 目标字数/总章数/结构/视角' },
  { id: 'outline', label: '卷/剧情线/章节进度（大纲）', kind: 'flex', cap: 2800, floor: 400,
    source: 'volumes + plotlines + chapters(title/summary)' },
  { id: 'memory', label: '长期记忆（已发生的故事摘要）', kind: 'fixed', cap: 2200,
    source: 'story_memories（版本化）' },
  { id: 'recall', label: '相关记忆检索（语义召回）', kind: 'cond', cap: 1400,
    source: 'OpenViking find（top-8 / 阈值 0.3 / 每段截 300 字）' },
  { id: 'events', label: '最近事件（事件账本）', kind: 'fixed', cap: 1800,
    source: 'story_events 近 30 条 × 每条 200 字' },
  { id: 'foreshadows', label: '未闭合伏笔（写作时必须照顾）', kind: 'fixed', cap: 1200,
    source: 'story_events kind=foreshadow 未回收 ≤20 × 160 字' },
  { id: 'scene', label: '当前场景', kind: 'cond', cap: 1200, skipInSettings: true,
    source: 'chapters（position/title/summary/author_note）' },
  { id: 'blueprint', label: '本章蓝图（写作必须遵守）', kind: 'cond', cap: 1500, skipInSettings: true,
    source: 'chapters.blueprint_json（5 字段各截 600 字）' },
  { id: 'story_tail', label: '前文衔接', kind: 'flex', cap: 1600, capContinuation: 4000, floor: 400,
    skipInSettings: true, source: 'chapters.content 尾部' },
  { id: 'characters', label: '出场角色卡', kind: 'entity', cap: Infinity, entityCap: 4000,
    entityCapNote: "buildCharacterCards(chars, entityCapOfId('characters'))：5 级字段降级 + 兜底提示语", source: 'characters（评分制选 ≤16）' },
  { id: 'relations', label: '人物关系', kind: 'cond', cap: 800,
    source: 'character_relations（仅出场角色之间）' },
  { id: 'world', label: '激活的世界观设定（优先级排列）', kind: 'flex', cap: 3000, floor: 400,
    source: 'world_entries（pinned/关键词命中 ≤30 × 每条 600 字）' },
  { id: 'redlines', label: '写作风格红线', kind: 'fixed', cap: 4000,
    source: 'writing_redlines + style_positive' },
];

/** 收缩顺序（按 id）。顺序即优先级：先压前文衔接，再压大纲，最后压世界观。 */
export const FLEX_ORDER = ['story_tail', 'outline', 'world'];

/** 收缩档位（正文 cap 的逐档下调）。 */
export const FLEX_CAPS = [2400, 1600, 800, 400];

/**
 * 每层的「查回路径」——契约 I4 的可断言形式：**凡被裁剪，必须能查回原文**。
 *
 * 这是零损失承诺唯一站得住的落地方式：装配器允许裁掉某层的一部分，前提是模型
 * 有工具能把那部分取回来。没有路径的层，其裁剪就是真实损失。
 *
 *   tool       模型侧工具名（null = 当前**没有**查回路径 → I4 缺口）
 *   endpoint   服务端端点（供 verify-retrieval.mjs 实测，而不是只看声明）
 *   full       true 表示该端点返回整份内容（用于「返回长度 ≥ 被裁长度」的断言）
 *   countable  可按条数核对的表/类型（用于「返回条数 ≥ 装配采用的条数」的断言）
 *   gap        已知的覆盖缺口（诚实标注，不假装完整）
 */
export const RETRIEVAL = {
  work:        { tool: 'novel_works', note: '作品元信息本身很小，实际不会被裁' },
  outline:     { tool: 'novel_lookup', note: '被省略的中间章节可用标题/摘要关键词检索到' },
  memory:      { tool: 'novel_memory_read', endpoint: '/api/story_memory', full: true },
  recall:      { tool: null, intrinsic: true, note: '本层自身就是检索结果，没有更上层原文可查（非缺口）' },
  events:      { tool: 'novel_events', endpoint: '/api/novel/events', countable: 'story_events' },
  foreshadows: { tool: 'novel_foreshadows', endpoint: '/api/novel/foreshadows?status=all', countable: 'foreshadow' },
  scene:       { tool: 'novel_lookup', note: '章节标题/摘要可检索' },
  blueprint:   { tool: 'novel_lookup', endpoint: '/api/search', note: 'P3 起 blueprint_json 纳入检索字段；章节结果本就带该行，模型可读回蓝图全文' },
  story_tail:  { tool: 'novel_lookup', note: '章节正文可检索（正文本身完整存在库里）' },
  characters:  { tool: 'novel_lookup', gap: '背景可检索，但 mes_example / system_prompt / appearance 不在检索字段内' },
  relations:   { tool: 'novel_lookup', endpoint: '/api/search', note: 'P3 起新增 relations 检索桶（含双方姓名与描述全文）' },
  world:       { tool: 'novel_lookup', endpoint: '/api/search', note: 'P3 新增 world_entries 检索桶' },
  redlines:    { tool: 'novel_style_contract', endpoint: '/api/novel/redlines', countable: 'writing_redlines',
                 gap: '端点返回红线规则全量；work.style_positive（正向风格契约）不在其中' },
};

/** 某层的查回路径声明（缺省视为未声明）。 */
export function retrievalOf(layerId) {
  return RETRIEVAL[layerId] || { tool: null, note: '未声明查回路径' };
}

/**
 * 决策 D8-#5：语义召回"期望有却没拿到"的缺口原因（没有缺口则返回空串）。
 *
 * 为什么这条判据住在内核模块而不是 server.js 里：
 * 它同时决定**三件事**——装配时是否往上下文插显式占位层、`/api/novel/context` 与
 * `/api/ai_context` 是否向界面报告缺口。三处必须同源，否则会出现
 * "上下文里插了占位、界面却说一切正常"这种自相矛盾。放在这里还能被**离线单测**。
 *
 * 刻意**不**把这两种算作缺口：
 *   - `disabled`：配置主动停用（是意图，不是意外）；
 *   - `empty`：查询为空，本来就没有可检索的东西。
 * 给它们插占位只会让每轮上下文多一层噪声，而噪声会让真正重要的缺口提示被忽略。
 */
export const RECALL_GAP_CN = {
  'no-hits': '检索没有命中（可能索引还没建，或本作品确实没有相关内容）',
  unavailable: '记忆服务当前不可用',
  error: '检索过程出错',
};

/** @param {{enabled?:boolean,status?:string}} recall getSemanticRecall 的返回值 */
export function recallGapReason(recall) {
  return recall && recall.enabled === true ? (RECALL_GAP_CN[recall.status] || '') : '';
}

/** 总预算（正文+标题+提示语 的合计上界）。 */
export const TOTAL_BUDGET = { settings: 18000, default: 26000 };

/**
 * 某层在给定模式下的**正文 cap**。
 * 注意 entity 层返回的是 `cap`（= Infinity），不是 `entityCap`：角色卡的真实边界由
 * `buildCharacterCards` 内部保证，层渲染不再二次截断（否则会与既有输出不一致）。
 * `entityCap` 只用于预算核算与文档说明。
 */
export function capOf(layer, mode = 'full') {
  if (mode === 'continuation' && layer.capContinuation) return layer.capContinuation;
  return layer.cap;
}

/** 按 id 取层规格（单点来源的入口：调用方不要再抄一遍常量）。 */
export function layerById(layerId) {
  return LAYERS.find((l) => l.id === layerId) || null;
}

/** 按 id 取正文 cap；找不到该层时返回 Infinity（与本模块对未知层的既有态度一致）。 */
export function capOfId(layerId, mode = 'full') {
  const l = layerById(layerId);
  return l ? capOf(l, mode) : Infinity;
}

/**
 * 按 id 取**实体层**的正文上限（`entityCap`）。
 *
 * ⚠️ 存在的理由：这个上限不是装配器强制的，而是由**构建函数**保证的
 * （角色卡走 `buildCharacterCards(chars, cap)` 的 5 级降级）。此前 `server.js` 里
 * 另写了一份字面量 `buildCharacterCards(sceneCharacters, 4000)`，与这里的 `entityCap: 4000`
 * 构成**同一常量的两份拷贝**——改了这边、忘了那边，预算核算就会与实际渲染脱节，
 * 而契约里只留了一句"改动时要同步"的注释，没有任何检查。
 * 现在把取值收成单点：调用方必须用本函数拿值，`verify-layer-constants.mjs` 会拦住字面量。
 */
export function entityCapOfId(layerId) {
  const l = layerById(layerId);
  return l?.entityCap ?? Infinity;
}

/** 某层是否在给定模式下出现。 */
export function presentIn(layer, mode) {
  if (mode === 'settings' && layer.skipInSettings) return false;
  return true;
}

/** 提示语长度的核算样本：取 6 位数字 + **所有层里最长的查回工具名**，作为安全上界。 */
const NOTICE_SAMPLE_LENGTH = 999999;
export const noticeSampleLength = () => {
  // ⚠️ 不能写死某个工具名当"最长"——早先写死 `novel_memory_read`(17)，
  // 而 `novel_style_contract`(20)、`novel_foreshadow_update`(23) 更长，
  // 导致红线层的真实渲染长度**超出核算上界**（单元测试抓到的）。
  // 现在从 RETRIEVAL 派生，新增工具时自动跟上。
  const longest = Object.values(RETRIEVAL).reduce((n, r) => Math.max(n, (r.tool || '').length), 0);
  return truncationNotice(NOTICE_SAMPLE_LENGTH, 'x'.repeat(longest)).length;
};
/** 提示语的字面前缀（`…（本层共 `），供对照工具按结构归一提示语，避免手写正则踩字符差异。 */
export const noticePrefix = () => truncationNotice(1, 'X').slice(0, truncationNotice(1, 'X').indexOf('1'));

/**
 * **预算核算**用的「该层正文上限」。
 * 与 capOf 的区别：entity 层的 `cap` 是 Infinity（层渲染不做二次截断），
 * 但预算必须按它声明的实体上限（entityCap）计，否则下限会算成 Infinity。
 *
 * ⚠️ 这里依赖一个**跨模块约定**：entity 层的正文确实不超过 entityCap，
 * 而那个边界由**构建函数**保证（`buildCharacterCards(chars, entityCapOfId('characters'))`），
 * 不是由装配器保证的。该取值已是**单点**（构建函数从本模块取），
 * 由 `.p1-baseline/verify-layer-constants.mjs` 拦住任何在别处重写的字面量。
 */
export function budgetCapOf(layer, mode = 'full') {
  if (layer.kind === 'entity') return layer.entityCap ?? Infinity;
  return capOf(layer, mode);
}

/**
 * 可执行下限：所有不收缩层的正文上限 + 收缩层下限 + 标题开销 + 层间分隔 + 截断提示语开销。
 * 规则来自历史失误 1：凡设预算常量，先算「可执行下限」，再定值。
 */
export function computeFloor(mode = 'full') {
  const present = LAYERS.filter((l) => presentIn(l, mode));
  const headerTotal = present.reduce((n, l) => n + headerOf(l.label).length, 0);
  const separatorTotal = Math.max(0, present.length - 1) * 2;
  let fixedBody = 0;
  let flexFloorBody = 0;
  let noticeTotal = 0;
  for (const l of present) {
    if (l.kind === 'flex') {
      flexFloorBody += l.floor;
      noticeTotal += noticeSampleLength(); // 压到下限必然触发提示语
    } else {
      fixedBody += budgetCapOf(l, mode);
    }
  }
  return { mode, headerTotal, separatorTotal, fixedBody, flexFloorBody, noticeTotal,
    floor: headerTotal + separatorTotal + fixedBody + flexFloorBody + noticeTotal };
}

/** 层的渲染上界（正文 cap + 标题 + 提示语）：这才是「该层在 assembled 里最多占多少」。 */
export function renderedCapOf(layer, mode = 'full') {
  // entity 层**没有层级上界**：它的正文由构建函数产生（角色卡走 buildCharacterCards 的
  // 5 级降级 + 4000 上限），而装配器按 cap=Infinity 不截断（P2 已按此实测等价）。
  // 这里如实返回 Infinity，而不是拿 entityCap 冒充一个该层并未强制的上界——
  // 早先那样做会被单元测试判为「上界被突破」，因为那个上界本来就不存在。
  if (layer.kind === 'entity') return Infinity;
  const cap = capOf(layer, mode);
  if (!Number.isFinite(cap)) return Infinity;
  return headerOf(layer.label).length + cap + noticeSampleLength();
}
