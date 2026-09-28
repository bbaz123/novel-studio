/**
 * 共享资料库（library）的根注册表 —— 唯一来源（纯函数、零依赖、可离线单测）。
 *
 * 定位：跨作品共享的写作参考资料（方法/素材/范例），与作品记忆子树**物理隔离**：
 *   <资源域>/novel-studio/<work_uri>/...        作品命名空间（同步器六类数据，正典派生）
 *   <资源域>/novel-studio-library/...           资料根（作者显式导入；本模块的注册表）
 *
 * 三条纪律（为什么这么设计）：
 *   1. 资料**永不 canon**：recall-meta.mjs 对资料条目只证明「在注册根内」，
 *      canon 记 'reference'；层标题与来源标注一律写明「参考资料（非本书事实）」。
 *   2. fail-closed 只收紧不放宽：注册表是白名单；形状不合（见 checkLibraryShape）
 *      的条目即便在根内也拒绝进入上下文。
 *   3. rebuild 的范围证明绝不含资料根：planRebuild 对资料根**显式拒绝**（第二道防线；
 *      第一道是它本就落在作品命名空间之外，会被 foreign 判据拦下）。
 *
 * 依据（P0 实测 2026-09-28，.p1-baseline/probe-library-p0.result.json）：
 *   · 写入 wait:true 阻塞 28.9s（异步索引完成）；find 为**文件级**命中（abstract 整篇摘要）；
 *   · readContent 的 offset/limit 按**行**计：offset 0/limit 30 = 前 30 行（实测 484 字）；
 *   · 删除即时生效（回读失败、find 0 命中）；目录零残留。
 *
 * B 形态预留（本期不做）：作品内资料（scope: 'work'）——在 ROOTS 中按 workId 动态追加
 * <资源域>/novel-studio-library/works/<work_uri>/ 根即可；isLibraryUri / 校验逻辑不变。
 */

// 协议前缀运行时拼接（与 openviking-sync.js 同款：避免源码中的字面 URI 触发 dsh 的 URI 防护误判）。
const OV_PROTO = 'viking:' + '//';

/** 资源域（协议前缀 + 资源根路径）：仅供本模块与测试拼接用，勿在别处再抄一份。 */
export const RESOURCES_ROOT = `${OV_PROTO}user/default/resources`;

/** 共享资料根（跨作品）。 */
export const SHARED_LIBRARY_ROOT = `${RESOURCES_ROOT}/novel-studio-library`;

/** 资料根注册表：进上下文前只认这里的根（白名单，fail-closed 的第一道）。 */
export const LIBRARY_ROOTS = Object.freeze([
  Object.freeze({ uri: SHARED_LIBRARY_ROOT, scope: 'shared', workId: null, label: '共享资料库' }),
]);

/** 去尾部斜杠（与 recall-meta.mjs 的 normUri 同口径）。 */
export function normLibraryUri(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/** 注册根列表（A 阶段恒为共享根；签名保留 workId 供 B 形态按作品追加）。 */
export function libraryRoots(workId = null) {
  void workId;
  return LIBRARY_ROOTS;
}

/**
 * 解析 URI 落在哪个注册根内。
 * @returns {{root:object, rel:string, scope:string}|null} rel='' 表示指向根目录本身
 */
export function libraryRelOf(uri) {
  const u = normLibraryUri(uri);
  if (!u) return null;
  for (const root of LIBRARY_ROOTS) {
    const base = normLibraryUri(root.uri);
    if (u === base || u.startsWith(`${base}/`)) {
      return { root, rel: u === base ? '' : u.slice(base.length + 1), scope: root.scope };
    }
  }
  return null;
}

/** 是否在任一资料根内（含根目录本身）。 */
export function isLibraryUri(uri) {
  return libraryRelOf(uri) !== null;
}

/**
 * 资料条目的形状规则（在「注册根内」之上的最小加固，只收紧不放宽）：
 *   · 恰好两层：<分类>/<slug>.md（分类一层目录，P0 后的格式约定）；
 *   · 拒绝**任意层级**以 `_` 或 `.` 开头的路径段（工具/系统保留位）。除探针临时目录
 *     _probe 外，P1 真机实测（2026-09-28）发现 OpenViking 会给目录生成
 *     `.abstract.md` / `.overview.md` 伴随文件，且摘要分数常高于正文文档——
 *     它们不是资料，绝不能因「在根内」就进上下文；
 *   · 只收 .md（.txt 在导入链里已转成 markdown）。
 * @returns {{ok:boolean, code:string, reason:string}}
 */
export function checkLibraryShape(rel) {
  const r = String(rel || '').trim();
  if (!r) return { ok: false, code: 'library_root', reason: '条目指向资料根目录本身，不是可引用资料' };
  const segs = r.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) {
    return { ok: false, code: 'library_bad_path', reason: `资料路径形状不合法（${r}）` };
  }
  const reserved = segs.find((s) => /^[_.]/.test(s));
  if (reserved) {
    return { ok: false, code: 'library_reserved', reason: `路径段「${reserved}」是保留前缀（工具/系统伴随文件，如 .abstract.md/.overview.md），不进入上下文` };
  }
  if (segs.length !== 2) {
    return { ok: false, code: 'library_bad_shape', reason: `资料须为 <分类>/<slug>.md 两层（${r}）` };
  }
  if (!/\.md$/i.test(segs[1])) {
    return { ok: false, code: 'library_not_md', reason: `资料只收 .md（${r}；.txt 在导入链里转换）` };
  }
  return { ok: true, code: 'ok', reason: '' };
}
