/**
 * 时态故事状态 · 唯一章序服务。
 *
 * 「第几章」只有一个来源：卷（position,id）→ 根章节（position,id）→ 未分卷根章节，
 * 场景作为章节的子树按 (position,id) 深度优先展开。与前端展示次序一致：
 * 前端 renderWriting / 目录树同样是「按卷分组 → 未分卷兜底 → 场景挂在章节下」。
 *
 * 为什么不用 chapters.position 直接当章序：宿主新建章节 position 默认 0，
 * 需要 (position,id) 二级排序才是稳定次序；且跨卷的全局排序必须按卷分组，
 * 否则「卷二的第 1 章」会跑到「卷一」前面。稳定 ID 是锚点，ID 大小不代表时间顺序。
 *
 * 章序版本（story_chapter_order_versions）是不可变记录：插章/删章/移动卷后生成新版本，
 * 旧提交继续引用旧版本（历史查询不得被新顺序改写）。
 */
import { db } from '../../../db.js';
import { prep } from './stmt.mjs';
import { hashJson, sha16 } from './schema.mjs';

const now = () => new Date().toISOString();

/** 计算作品的真实叙事顺序（纯查询，不写库）。 */
export function listOrder(workId) {
  const w = Number(workId) || 0;
  const volumes = prep('SELECT id, title, position FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(w);
  const chapters = prep('SELECT id, volume_id, parent_id, title, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(w);
  const volumeIds = new Set(volumes.map((v) => Number(v.id)));
  const roots = chapters.filter((c) => c.parent_id === null || c.parent_id === undefined);
  const scenesByParent = new Map();
  for (const c of chapters) {
    if (c.parent_id === null || c.parent_id === undefined) continue;
    const pid = Number(c.parent_id);
    if (!scenesByParent.has(pid)) scenesByParent.set(pid, []);
    scenesByParent.get(pid).push(Number(c.id));
  }
  const ordered = [];
  for (const v of volumes) {
    for (const c of roots) if (Number(c.volume_id) === Number(v.id)) ordered.push(Number(c.id));
  }
  for (const c of roots) {
    const vid = c.volume_id === null || c.volume_id === undefined ? null : Number(c.volume_id);
    if (vid === null || !volumeIds.has(vid)) ordered.push(Number(c.id));
  }
  const scenes = {};
  for (const [pid, ids] of scenesByParent.entries()) scenes[String(pid)] = ids;
  const scenesSerialized = {};
  for (const key of Object.keys(scenes).sort((a, b) => Number(a) - Number(b))) {
    const list = [];
    const walk = (cid) => {
      for (const child of scenes[String(cid)] || []) {
        list.push(child);
        walk(child);
      }
    };
    walk(Number(key));
    scenesSerialized[key] = list;
  }
  return {
    work_id: w,
    volumes: volumes.map((v) => Number(v.id)),
    chapters: ordered,
    scenes: scenesSerialized,
    byId: new Map(chapters.map((c) => [Number(c.id), c])),
    indexById: new Map(ordered.map((id, i) => [id, i])),
  };
}

/** 深比较两个顺序对象（章节序列 + 场景子树）；逐项比较，避免每次都对全量章序构建两个 JSON 字符串。 */
function sameOrder(a, b) {
  const ac = a.chapters || [];
  const bc = b.chapters || [];
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i += 1) if (ac[i] !== bc[i]) return false;
  const as = a.scenes || {};
  const bs = b.scenes || {};
  const keys = Object.keys(as);
  if (keys.length !== Object.keys(bs).length) return false;
  for (const key of keys) {
    const al = as[key] || [];
    const bl = bs[key];
    if (!Array.isArray(bl) || al.length !== bl.length) return false;
    for (let i = 0; i < al.length; i += 1) if (al[i] !== bl[i]) return false;
  }
  return true;
}

export function orderVersionJsonOf(order) {
  return { version: 1, chapters: order.chapters, scenes: order.scenes };
}

/**
 * 取（必要时创建）当前章序版本；顺序未变则复用既有版本（幂等，不重复建行）。
 *
 * `force:true`：**即使顺序没变也落一个新版本**。用途只有一个——P1-12 的章序变化检测：
 *   "写前取一次版本核心 → 写后再 force 落版本 → 两段逐位比较"。
 *   不 force 的话，重排后若内容恰好在别处触发了 `ensureOrderVersion`，写后取到的仍是旧行，
 *   检测就会**漏报**（而漏报的后果是下游状态静默错位）。
 *   反之 force 也不会造成重复行：`id = 'ord_' + sha16(workId|orderHash)` 是内容寻址，
 *   且 INSERT OR REPLACE —— 同一份章序只会有一行。
 */
export function ensureOrderVersion(workId, { force = false } = {}) {
  const w = Number(workId) || 0;
  const order = listOrder(w);
  const core = { chapters: order.chapters, scenes: order.scenes };
  const latest = prep('SELECT * FROM story_chapter_order_versions WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(w);
  if (latest && !force) {
    let prevCore = null;
    try { prevCore = JSON.parse(latest.order_json); } catch { prevCore = null; }
    if (prevCore && sameOrder({ chapters: prevCore.chapters || [], scenes: prevCore.scenes || {} }, core)) {
      return { ...latest, reused: true, order };
    }
  }
  // 只有确实要落新版本时才做全量规范化哈希（幂等命中时省掉每章一次 O(N) 哈希）。
  const orderHash = hashJson(core);
  const id = 'ord_' + sha16(`${w}|${orderHash}`);
  const orderJson = JSON.stringify({ version: 1, chapters: core.chapters, scenes: core.scenes, volumes: order.volumes });
  prep('INSERT OR REPLACE INTO story_chapter_order_versions (id, work_id, order_json, order_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, w, orderJson, orderHash, now());
  return {
    id, work_id: w, order_json: orderJson, order_hash: orderHash, created_at: now(),
    reused: false, order,
  };
}

export function getOrderVersion(orderVersionId) {
  const row = prep('SELECT * FROM story_chapter_order_versions WHERE id = ?').get(String(orderVersionId || ''));
  if (!row) return null;
  let parsed = null;
  try { parsed = JSON.parse(row.order_json); } catch { parsed = null; }
  return { ...row, parsed };
}

export function latestOrderVersion(workId) {
  const row = prep('SELECT * FROM story_chapter_order_versions WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(Number(workId) || 0);
  if (!row) return null;
  let parsed = null;
  try { parsed = JSON.parse(row.order_json); } catch { parsed = null; }
  return { ...row, parsed };
}

/** 叙事顺序中的章序下标（0 基）；场景归到其根章节，返回根的下标。 */
export function chapterOrderIndexOf(workId, chapterId) {
  const order = listOrder(workId);
  const cid = Number(chapterId);
  if (order.indexById.has(cid)) return order.indexById.get(cid);
  const row = order.byId.get(cid);
  if (row && row.parent_id !== null && row.parent_id !== undefined) {
    const pid = Number(row.parent_id);
    if (order.indexById.has(pid)) return order.indexById.get(pid);
  }
  return -1;
}

/** 章节在顺序版本中的顺序列表（历史查询用历史版本，不用当前顺序改写历史）。 */
export function chaptersOfOrderVersion(orderVersionId) {
  const v = getOrderVersion(orderVersionId);
  if (!v || !v.parsed) return null;
  return {
    chapters: Array.isArray(v.parsed.chapters) ? v.parsed.chapters.map(Number) : [],
    scenes: v.parsed.scenes || {},
  };
}
/**
 * 章节的叙事 cursor（章下标 + 场景下标）。
 * 场景归到父章节的章下标，并给出它在父章节场景序列中的下标；根章节 scene_index=null。
 * 章序版本用调用时的当前顺序（确认新事件时固化进事件 cursor）。
 */
export function cursorOfChapter(workId, chapterId, orderOverride = null) {
  // orderOverride：调用方刚算过的 listOrder 结果（同一事务内章序不会被本流程改写）——避免重复全量查询。
  const order = orderOverride || listOrder(Number(workId) || 0);
  const cid = Number(chapterId);
  if (order.indexById.has(cid)) {
    return { chapter_index: order.indexById.get(cid), scene_index: null, chapter_id: cid };
  }
  const row = order.byId.get(cid);
  if (row && row.parent_id !== null && row.parent_id !== undefined) {
    const pid = Number(row.parent_id);
    const chapterIndex = order.indexById.has(pid) ? order.indexById.get(pid) : -1;
    const sceneIndex = (order.scenes[String(pid)] || []).indexOf(cid);
    return { chapter_index: chapterIndex, scene_index: sceneIndex >= 0 ? sceneIndex : null, chapter_id: cid };
  }
  return { chapter_index: -1, scene_index: null, chapter_id: cid };
}
