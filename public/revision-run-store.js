/*
 * 修稿运行记录的本地存储与恢复（revision-run-store）—— 纯函数 + 注入式 storage（UMD）。
 *
 * 为什么需要它（v1.2.4 方案 §8.8 / P1「可恢复的审稿运行记录」/ 验收项 Q-15）：
 *   旧实现里"这次修稿的候选、逐条结论、复验额度"只活在内存的 `state.pendingRevisionClosure`：
 *   一次刷新（或误关标签页）就等于候选全丢 —— 而重新修稿是**又花一次钱**。
 *   更危险的是相反方向：如果刷新后无条件"复活"上一轮候选，就等于把
 *   "当时那份底稿 + 那次授权"重新当成有效权限（方案 §11.2「不能自行复活失效权限」）。
 *
 * 因此这里的设计是**三件事分开**：
 *   ① 候选与逐条语义结论存本地（可恢复）；
 *   ② 恢复前必须核对 `base_hash`：底稿变了就是 `STALE`，**只提示、不复用候选**；
 *   ③ 已用掉的付费复验额度一起恢复（`semanticRuns`）——刷新不给新的额度。
 *
 * 本模块不碰 DOM、不读全局 localStorage：storage 由调用方注入，便于离线单测。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionRunStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const KEY_PREFIX = 'ns_revision_run';
  /** 单个记录的字符上限：超过就不落本地（宁可不持久化，也不让浏览器配额异常）。 */
  const MAX_CHARS = 512 * 1024;

  const textOf = (x) => String(x == null ? '' : x);

  function storageKey(workId, chapterId, runId) {
    const base = `${KEY_PREFIX}:${Number(workId) || 0}:${Number(chapterId) || 0}`;
    return runId ? `${base}:${textOf(runId)}` : base;
  }

  /** 轻量索引键：只放"有哪条记录、什么时候、什么状态"，避免每次渲染都去解析几百 KB 的候选。 */
  function indexKey(workId, chapterId) {
    return `${KEY_PREFIX}_idx:${Number(workId) || 0}:${Number(chapterId) || 0}`;
  }

  /**
   * 归一化一条运行记录（只保留可恢复所需的最小事实）。
   * @param {object} input {runId, workId, chapterId, reviewId, baseHash, baseText?, candidateText,
   *                        patches, semanticByIssue, semanticRuns, status, rows, at}
   */
  function serialize(input = {}) {
    const patches = Array.isArray(input.patches) ? input.patches : [];
    const rows = Array.isArray(input.rows) ? input.rows : [];
    return {
      v: 1,
      run_id: textOf(input.runId),
      work_id: Number(input.workId) || 0,
      chapter_id: Number(input.chapterId) || 0,
      review_id: input.reviewId == null ? null : Number(input.reviewId),
      base_hash: textOf(input.baseHash),
      candidate_text: textOf(input.candidateText),
      patches: patches.map((p) => ({
        issue_ids: Array.isArray(p && p.issue_ids) ? p.issue_ids.map(String) : [],
        span_id: textOf(p && p.span_id),
        op: textOf(p && p.op) || 'replace',
        original: textOf(p && p.original),
        replacement: textOf(p && p.replacement),
        start: Number(p && p.start) || 0,
        end: Number(p && p.end) || 0,
        segment_id: p && p.segment_id ? textOf(p.segment_id) : undefined,
      })),
      semantic_by_issue: input.semanticByIssue && typeof input.semanticByIssue === 'object' ? input.semanticByIssue : {},
      semantic_runs: Number(input.semanticRuns) || 0,
      status: textOf(input.status),
      rows: rows.map((r) => ({
        issue_id: textOf(r && r.issue_id),
        final_status: textOf(r && r.final_status),
        reason_code: textOf(r && r.reason_code),
      })),
      at: textOf(input.at),
    };
  }

  function save(storage, record) {
    if (!storage || typeof storage.setItem !== 'function') return { ok: false, reason: 'NO_STORAGE' };
    const rec = record && typeof record === 'object' ? record : null;
    if (!rec || !rec.chapter_id) return { ok: false, reason: 'BAD_RECORD' };
    let json = '';
    try { json = JSON.stringify(rec); } catch (_) { return { ok: false, reason: 'SERIALIZE_FAILED' }; }
    if (json.length > MAX_CHARS) return { ok: false, reason: 'TOO_LARGE', chars: json.length, limit: MAX_CHARS };
    try {
      storage.setItem(storageKey(rec.work_id, rec.chapter_id), json);
      // 索引与正文分开写：渲染写作台时只读索引（几百字节），不解析整份候选。
      try {
        storage.setItem(indexKey(rec.work_id, rec.chapter_id), JSON.stringify({
          at: textOf(rec.at),
          status: textOf(rec.status),
          run_id: textOf(rec.run_id),
          issues: Array.isArray(rec.rows) ? rec.rows.length : 0,
        }));
      } catch (_) { /* 索引写不进去不影响恢复（只是界面少一个入口） */ }
      return { ok: true, chars: json.length, key: storageKey(rec.work_id, rec.chapter_id) };
    } catch (_) { return { ok: false, reason: 'QUOTA' }; }
  }

  /** 读索引（不存在返回 null）。 */
  function loadIndex(storage, workId, chapterId) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      const raw = storage.getItem(indexKey(workId, chapterId));
      if (!raw) return null;
      const idx = JSON.parse(raw);
      return idx && typeof idx === 'object' ? idx : null;
    } catch (_) { return null; }
  }

  function load(storage, workId, chapterId) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      const raw = storage.getItem(storageKey(workId, chapterId));
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!rec || rec.v !== 1 || Number(rec.chapter_id) !== (Number(chapterId) || 0)) return null;
      return rec;
    } catch (_) { return null; }
  }

  function clear(storage, workId, chapterId) {
    if (!storage || typeof storage.removeItem !== 'function') return false;
    try {
      storage.removeItem(storageKey(workId, chapterId));
      storage.removeItem(indexKey(workId, chapterId));
      return true;
    } catch (_) { return false; }
  }

  /**
   * 恢复判定。**底稿变了就不复用候选**（fail-closed），但把"为什么不能恢复"说清楚。
   * @param {object} record load() 的结果
   * @param {{currentText:string, hashOf:Function}} ctx
   * @returns {{ok:boolean, stale?:boolean, reason?:string, candidate?:string, patches?:Array,
   *            semanticByIssue?:object, semanticRuns?:number, runId?:string, status?:string, rows?:Array}}
   */
  function restore(record, ctx = {}) {
    if (!record) return { ok: false, reason: 'NO_RECORD' };
    const candidate = textOf(record.candidate_text);
    if (!candidate) return { ok: false, reason: 'NO_CANDIDATE' };
    const hashOf = typeof ctx.hashOf === 'function' ? ctx.hashOf : null;
    if (!hashOf) return { ok: false, reason: 'NO_HASH_FN' };
    const currentHash = textOf(hashOf(ctx.currentText));
    if (!record.base_hash || !currentHash) return { ok: false, reason: 'HASH_UNAVAILABLE' };
    if (record.base_hash !== currentHash) {
      // 底稿变了：旧候选与旧授权一律作废（方案 §11.2）。**不返回 candidate**。
      return { ok: false, stale: true, reason: 'BASE_STALE', recorded_hash: record.base_hash, current_hash: currentHash };
    }
    return {
      ok: true,
      runId: textOf(record.run_id),
      candidate,
      patches: Array.isArray(record.patches) ? record.patches : [],
      semanticByIssue: record.semantic_by_issue && typeof record.semantic_by_issue === 'object' ? record.semantic_by_issue : {},
      // 已用掉的付费复验额度跟着回来：刷新不该等于"再送一次免费复验"。
      semanticRuns: Number(record.semantic_runs) || 0,
      status: textOf(record.status),
      rows: Array.isArray(record.rows) ? record.rows : [],
      at: textOf(record.at),
    };
  }

  return { VERSION, KEY_PREFIX, MAX_CHARS, storageKey, indexKey, serialize, save, load, loadIndex, clear, restore };
});
