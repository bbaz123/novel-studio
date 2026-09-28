/**
 * OpenViking 召回来源校验（2026-09-27，R04）——召回内容进入装配器之前的 fail-closed 闸门。
 *
 * 为什么需要：
 *   · 语义召回打在**跨作品共享**的记忆库上。查询用 target_uri 限制在作品子树，但命中结果
 *     本身不携带「属于哪本书 / 哪一章 / 是不是正典」的结构化元数据——一旦服务端布局变化、
 *     旧索引残留、或未来接入候选/草稿内容，跨书内容与未来章节就可能混进 assembled 的
 *     「相关记忆检索」层，而模型与作者都看不出来。
 *   · 任务书 §7.3 要求逐行核对 work/scope/canon/时间语义：证明不了来源的条目**拒绝进入**
 *     （fail-closed），而不是"看起来像就放行"；被拦下的条目必须留下可审计的原因。
 *   · 本模块是纯函数（零依赖、可离线单测）：召回生产方（openviking-sync.js）与宿主装配器
 *     （server.js 的再校验）共用同一实现——单点规则，不靠调用方各自记得。
 *
 * 布局事实（与 collectWorkOperations 同源，改布局必须同步这里）：
 *   <OV_ROOT>/<work_uri>/meta.md | long-memory.md | events.md | outline.md
 *   <OV_ROOT>/<work_uri>/settings/<term_id>.md | characters/<id>.md | world/<id>.md
 *   <OV_ROOT>/<work_uri>/chapters/<chapter_db_id>.md
 *
 * 2026-09-28（library）：资料根是作品命名空间的**兄弟根**（注册表见 ai/library/library-roots.mjs），
 * 不在这套同步布局内。validateRecallItem 增加资料分支：只证明「在注册根内」、canon 记
 * 'reference'（永不 canon）；未带 allowLibrary 的召回路径遇到资料条目一律拒绝（不混层）；
 * planRebuild 显式拒绝以资料根为删除范围（共享根绝不在删除集合内）。
 */

import { libraryRelOf, checkLibraryShape, isLibraryUri } from '../library/library-roots.mjs';

const normUri = (u) => String(u || '').trim().replace(/\/+$/, '');

/** 根级同步文件的类别（都在作品命名空间下，视为正典派生资料）。 */
const ROOT_FILES = {
  'meta.md': '作品',
  'long-memory.md': '长期记忆',
  'events.md': '事件账本',
  'outline.md': '大纲',
};

const DIR_KINDS = [
  ['chapters/', '章节正文'],
  ['settings/', '设定词条'],
  ['characters/', '角色卡'],
  ['world/', '世界观词条'],
];

/**
 * 候选/草稿子树：**永远不得**作为正典召回进入上下文。
 * 目前同步器不写这些前缀；它们是给后续「候选蓝图 / 分支沙盘 / 分析候选」预留的隔离位，
 * 一旦有人把候选内容同步进记忆库，这里会 fail-closed 拦下而不是让候选冒充已发生事实。
 */
const CANDIDATE_PREFIXES = ['candidates/', 'drafts/', 'proposals/', 'branches/'];

/** 相对路径 → 类别名（不在已知布局内返回空串）。 */
export function recallKindOfRel(rel) {
  const r = String(rel || '');
  if (ROOT_FILES[r]) return ROOT_FILES[r];
  for (const [prefix, kind] of DIR_KINDS) {
    if (r.startsWith(prefix) && r.length > prefix.length) return kind;
  }
  return '';
}

/** 相对路径 → 'canon' | 'candidate' | 'unknown'。unknown 一律按不安全处理（调用方 fail-closed）。 */
export function canonStatusOfRel(rel) {
  const r = String(rel || '');
  if (!r) return 'unknown';
  if (CANDIDATE_PREFIXES.some((p) => r.startsWith(p))) return 'candidate';
  if (ROOT_FILES[r] || recallKindOfRel(r)) return 'canon';
  return 'unknown';
}

/**
 * 解析召回 URI：只认「在作品命名空间内、且落在已知布局上」的条目。
 * @returns {{inScope:boolean, rel:string, kind:string, canon:string, chapterId:(string|null)}}
 */
export function parseRecallUri(uri, workUri) {
  const u = normUri(uri);
  const scope = normUri(workUri);
  const miss = { inScope: false, rel: '', kind: '', canon: 'unknown', chapterId: null };
  if (!u || !scope) return miss;
  if (u !== scope && !u.startsWith(`${scope}/`)) return miss;
  const rel = u === scope ? '' : u.slice(scope.length + 1);
  const m = /^chapters\/([^/]+)\.md$/.exec(rel);
  return { inScope: true, rel, kind: recallKindOfRel(rel), canon: canonStatusOfRel(rel), chapterId: m ? m[1] : null };
}

/**
 * 单条召回的来源裁决。
 * @param {{uri?:string, label?:string, score?:number, text?:string}} item
 * @param {{workUri:string, currentChapterOrder?:(number|null), chapterOrderById?:(Map<any,any>|Record<string,any>)}} ctx
 *   order 的语义 = 章序位次（position ASC, id ASC 的排名），不是原始 position 值：
 *   章节可能是按默认 position=0 批量创建的，只有位次才能正确表达"谁在未来"。
 * @returns {{ok:boolean, code:string, reason:string, meta?:object}}
 */
export function validateRecallItem(item, ctx = {}) {
  if (!item || !normUri(item.uri)) {
    return { ok: false, code: 'missing_uri', reason: '召回条目没有来源 URI（无法证明归属，拒不进入上下文）' };
  }
  // 资料条目（library 根内）：只在资料层放行。普通召回层遇到它一律拒绝——
  // 资料不是作品内容，混进「相关记忆检索」会冒充本书事实（fail-closed 只收紧）。
  const lib = libraryRelOf(item.uri);
  if (lib) {
    if (ctx.allowLibrary !== true) {
      return { ok: false, code: 'library_out_of_scope', reason: `资料条目（${normUri(item.uri)}）不得进入作品召回层——资料只在 library 层生效` };
    }
    const ownerId = ctx.libraryWorkId !== undefined ? ctx.libraryWorkId : ctx.workId;
    if (lib.root.workId !== null && ownerId !== undefined && String(ownerId) !== String(lib.root.workId)) {
      return { ok: false, code: 'library_other_work', reason: `资料条目属于其它作品的资料根（${normUri(item.uri)}）` };
    }
    const shape = checkLibraryShape(lib.rel);
    if (!shape.ok) return { ok: false, code: shape.code, reason: shape.reason };
    return {
      ok: true, code: 'ok', reason: '',
      meta: {
        uri: normUri(item.uri), rel: lib.rel, kind: '参考资料', canon: 'reference',
        library_scope: lib.scope, chapter_id: null, chapter_order: null,
      },
    };
  }
  // allowLibrary 模式（资料层）下只允许资料条目：作品子树或其它来源混进资料层同样是混层，拒绝。
  if (ctx.allowLibrary === true) {
    return { ok: false, code: 'not_library_item', reason: `library 层只允许资料根内的条目（${normUri(item.uri)}）` };
  }
  const parsed = parseRecallUri(item.uri, ctx.workUri);
  if (!parsed.inScope) {
    return { ok: false, code: 'out_of_scope', reason: `召回条目不在本作品命名空间内（${normUri(item.uri)}）` };
  }
  if (!parsed.rel) return { ok: false, code: 'scope_root', reason: '召回条目指向作品目录本身，不是可引用内容' };
  if (parsed.canon === 'candidate') {
    return { ok: false, code: 'non_canon', reason: `候选/草稿内容（${parsed.rel}）不得作为正典召回进入上下文` };
  }
  if (parsed.canon !== 'canon' || !parsed.kind) {
    return { ok: false, code: 'unknown_source', reason: `来源类别无法证明（${parsed.rel} 不在已知同步布局内）` };
  }
  let chapterOrder = null;
  if (parsed.chapterId !== null) {
    const table = ctx.chapterOrderById;
    const pos = table instanceof Map ? table.get(parsed.chapterId) : (table ? table[parsed.chapterId] : undefined);
    if (pos === undefined || pos === null || !Number.isFinite(Number(pos))) {
      return { ok: false, code: 'unknown_chapter', reason: `召回的章节 ${parsed.chapterId} 不在本作品中（索引残留？）` };
    }
    chapterOrder = Number(pos);
    const current = Number(ctx.currentChapterOrder);
    if (Number.isFinite(current) && chapterOrder > current) {
      return { ok: false, code: 'future_chapter', reason: `召回命中未来章节（第 ${chapterOrder + 1} 节 > 当前第 ${current + 1} 节），不得提前泄密` };
    }
  }
  return {
    ok: true,
    code: 'ok',
    reason: '',
    meta: {
      uri: normUri(item.uri),
      rel: parsed.rel,
      kind: parsed.kind,
      canon: parsed.canon,
      chapter_id: parsed.chapterId,
      chapter_order: chapterOrder,
    },
  };
}

/** 批量裁决：kept（附 meta）与 dropped（附 code/reason）分开返回，绝不静默丢弃。 */
export function filterRecallItems(items, ctx = {}) {
  const kept = [];
  const dropped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const verdict = validateRecallItem(item, ctx);
    if (verdict.ok) kept.push({ ...item, source_meta: verdict.meta });
    else dropped.push({ uri: normUri(item && item.uri), code: verdict.code, reason: verdict.reason });
  }
  return { kept, dropped };
}

/** 与召回生产方同格式的文本渲染（再校验后必须由 kept 重建，不能沿用旧 text）。 */
export function recallTextOf(hits) {
  return (Array.isArray(hits) ? hits : [])
    .filter((h) => h && h.text)
    .map((h) => `【${h.label || '记忆条目'}】（相关度 ${Number(h.score) || 0}%）\n${h.text}`)
    .join('\n\n');
}

/**
 * 宿主装配器使用的**再校验**入口：不信任生产方已过滤（meta_validated 只作为标注，不作为放行依据）。
 * 全部被拦下时把 status 改成 'filtered'，让 recallGapReason 生成显式缺口说明——
 * 「本该有召回、但全部来源不可信」必须让模型与作者看见，而不是变成一次安静的 no-hits。
 */
export function revalidateRecallPayload(payload, ctx = {}) {
  if (!payload || payload.status !== 'ok' || !Array.isArray(payload.hits) || !payload.hits.length) {
    return { payload, dropped: [], changed: false };
  }
  const { kept, dropped } = filterRecallItems(payload.hits, ctx);
  const oldText = String(payload.text || '');
  const nextText = kept.length ? recallTextOf(kept) : '';
  const changed = dropped.length > 0;
  const next = {
    ...payload,
    hits: kept,
    text: nextText,
    omitted: [...(Array.isArray(payload.omitted) ? payload.omitted : []), ...dropped],
  };
  if (!kept.length && Array.isArray(payload.hits) && payload.hits.length) next.status = 'filtered';
  return { payload: next, dropped, changed: changed || nextText !== oldText };
}

/**
 * 重建（rebuild）删除范围的**范围证明**：仅凭 URI 前缀猜测归属是不够的。
 * 规则：
 *   1) 实际列出的条目必须全部落在本作品命名空间内——出现任何域外条目 → 拒绝执行；
 *   2) 命名空间内每个条目要么是「本次同步会生成的文件」/其目录祖先，要么**形状**符合已知
 *      同步布局（chapters|settings|characters|world/<名字>.md 或四个根文件）——旧版本留下的
 *      过期文件仍然可删（rebuild 本来就要清它），但形状不明的条目（可能是别的写入者、
 *      候选子树、任意文件）一律拒绝执行；
 *   3) 通过后返回可审计的 deletable 集合（**只含文件条目**；目录单列在 actualDirs 里只用于验形状，
 *      不参与删除——对目录做非递归删除会失败，递归删除又会越出已证明的集合）。
 * @returns {{ok:boolean, code:string, reason:string, deletable:string[], foreign:string[], unexpected:string[]}}
 */
export function planRebuild({ workUri, expectedUris, actualUris, actualDirs = [] } = {}) {
  const scope = normUri(workUri);
  const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, deletable: [], foreign: [], unexpected: [], ...extra });
  if (!scope) return fail('no_work_uri', '缺少作品命名空间，无法证明删除范围');
  // 资料根（共享根或未来的作品资料根）绝不在重建删除范围内——即使有人误把范围传成资料根，
  // 也在这里显式拒绝，而不是把整个资料库当成"本作品命名空间"清掉。
  if (isLibraryUri(scope)) return fail('library_scope', '资料根不在重建删除范围内（共享资料根与作品资料根一律排除）');
  const within = (u) => u === scope || u.startsWith(`${scope}/`);
  const files = [...new Set((Array.isArray(actualUris) ? actualUris : []).map(normUri).filter(Boolean))];
  const dirs = [...new Set((Array.isArray(actualDirs) ? actualDirs : []).map(normUri).filter(Boolean))];
  const actual = [...new Set([...files, ...dirs])];
  const foreign = actual.filter((u) => !within(u));
  if (foreign.length) {
    return fail('foreign_entries', `命名空间外发现 ${foreign.length} 个条目，拒绝执行任何删除（范围无法证明安全）`, { foreign });
  }
  const expected = new Set((Array.isArray(expectedUris) ? expectedUris : []).map(normUri).filter(Boolean));
  const allowed = new Set(expected);
  for (const u of expected) {
    // 目录祖先（如 <scope>/chapters）视为允许存在——ls 是否返回目录条目取决于服务端实现。
    let cur = u;
    while (cur.includes('/') && normUri(cur) !== scope) {
      cur = cur.slice(0, cur.lastIndexOf('/'));
      if (normUri(cur) !== scope) allowed.add(normUri(cur));
    }
  }
  const knownShape = (u) => {
    const rel = u === scope ? '' : u.slice(scope.length + 1);
    if (!rel || rel.includes('/') === false) return Object.prototype.hasOwnProperty.call(ROOT_FILES, rel);
    const slash = rel.indexOf('/');
    const dir = `${rel.slice(0, slash)}/`;
    const name = rel.slice(slash + 1);
    if (!DIR_KINDS.some(([prefix]) => prefix === dir)) return false;
    return name.length > 0 && !name.includes('/') && name.endsWith('.md');
  };
  const unexpected = actual.filter((u) => u !== scope && !allowed.has(u) && !knownShape(u));
  if (unexpected.length) {
    return fail('unexpected_entries', `命名空间内发现 ${unexpected.length} 个形状不明的条目，拒绝删除（可能有其它写入者）`, { unexpected });
  }
  return { ok: true, code: 'ok', reason: '', deletable: files.filter((u) => u !== scope), foreign: [], unexpected: [] };
}
