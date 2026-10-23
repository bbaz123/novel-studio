/*
 * 修稿存档（revision-archive）—— 纯函数 + 注入式 storage（UMD）。
 *
 * 为什么需要它（2026-10-18 作者要求）：
 *   "跳过语义复验直接合并之后，我还要有反悔的机会；正文至少留三份：审稿前、未复验候选、已复验候选，
 *    无论我选哪条路都要有记录。"
 *
 * 三份存档不是"多存点东西"，而是三个**不同事实**，混起来就没法反悔：
 *   ① `base`       审稿前原文 —— 作者发起这次修稿之前真正读到的正文；
 *   ② `unverified` 未复验候选 —— 跳过语义复验写进正文的那一版（哪些问题真修好**没有结论**）；
 *   ③ `verified`   已复验候选 —— 逐条语义复验后写进正文的那一版（有逐条结论）。
 *   同一个槽只保留"与槽位语义相符"的那一版：把未复验版塞进 verified 槽，
 *   就等于给"没验过的稿子"盖了一个"验过"的章 —— 那比不存更危险。
 *
 * 与既有机制的分工：
 *   - **正文侧**：三份都落服务端的 `chapter_save_versions`（带标题标记），
 *     作者在「🕘 历史版本」里就能逐条查看 / 恢复 —— 反悔走已有的恢复通道，不新增正文写入路径。
 *   - **本模块**：只记"这一章存过哪些槽、内容指纹是什么"，用来**去重**（同一份内容不重复存第二遍）
 *     与在界面上如实显示"已有几份存档"。它不写库、不碰 DOM。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionArchive = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';
  const KEY_PREFIX = 'ns_revision_archive';
  /** 单条记录上限：只存槽位索引（不含正文），给足余量即可。 */
  const MAX_CHARS = 64 * 1024;

  /** 三个槽位。`title` 直接进 `chapter_save_versions.title`，作者在历史版本面板里看到的就是它。 */
  const SLOTS = [
    {
      id: 'base',
      title: '修稿存档 · 审稿前原文',
      summary: '发起这次修稿之前的正文（合并前留存，随时可恢复）',
    },
    {
      id: 'unverified',
      title: '修稿存档 · 候选（未语义复验）',
      summary: '跳过语义复验直接合并的那一版：哪些问题真的修好，没有结论',
    },
    {
      id: 'verified',
      title: '修稿存档 · 候选（已语义复验）',
      summary: '逐条语义复验后合并的那一版：逐条结论见审稿工作区',
    },
  ];

  const textOf = (x) => String(x == null ? '' : x);

  function slotOf(id) {
    const key = textOf(id);
    return SLOTS.find((s) => s.id === key) || null;
  }

  /**
   * 内容指纹：只用于"同一槽位是否已存过同一份内容"的去重判据。
   * 不做密码学用途，选 FNV-1a 32 位 + 长度（短、稳、无依赖）。
   */
  function hashOf(text) {
    const s = textOf(text);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${h.toString(16)}-${s.length}`;
  }

  /**
   * 该存哪几个槽。
   * @param {object} input {article, candidateText, verified, merged}
   *   - `article`：审稿前正文（来自工作区的 `ctx.article`）
   *   - `candidateText`：要存档的候选正文（合并写进库的那一份）
   *   - `verified`：这份候选**是否跑完并通过**逐条语义复验
   * @returns {{id:string,title:string,summary:string,content:string,hash:string,chars:number}[]}
   */
  function buildSlots(input = {}) {
    const out = [];
    const push = (id, content) => {
      const slot = slotOf(id);
      const text = textOf(content);
      if (!slot || !text.trim()) return;
      out.push({
        id: slot.id,
        title: slot.title,
        summary: slot.summary,
        content: text,
        hash: hashOf(text),
        chars: text.length,
      });
    };
    push('base', input.article);
    // 只要给了候选就落一个候选槽；**按是否验过决定进哪个槽**，绝不跨槽冒充。
    if (input.merged !== false) push(input.verified === true ? 'verified' : 'unverified', input.candidateText);
    return out;
  }

  function storageKey(chapterId) {
    return `${KEY_PREFIX}:${Number(chapterId) || 0}`;
  }

  /** 读该章的存档索引：`{base:{hash,version_id,at}, unverified:{…}, verified:{…}}`。 */
  function load(storage, chapterId) {
    if (!storage || typeof storage.getItem !== 'function') return {};
    try {
      const raw = storage.getItem(storageKey(chapterId));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && parsed.slots && typeof parsed.slots === 'object'
        ? parsed.slots : {};
    } catch (_) {
      return {};
    }
  }

  /** 同一槽位是否已经存过**同一份内容**（不同内容允许各存一份，历史版本面板里能看出差异）。 */
  function hasSlot(records, slotId, hash) {
    const rec = (records || {})[slotId];
    return Boolean(rec) && textOf(rec.hash) === textOf(hash);
  }

  /** 记下"这个槽位已经存进历史版本"，附带服务端版本 id 便于直接跳转。 */
  function remember(storage, chapterId, slotId, rec = {}) {
    if (!storage || typeof storage.setItem !== 'function') return load(storage, chapterId);
    const slots = load(storage, chapterId);
    slots[textOf(slotId)] = {
      hash: textOf(rec.hash),
      version_id: rec.versionId == null ? null : Number(rec.versionId),
      at: textOf(rec.at) || new Date().toISOString(),
      // §6：验收结论**跟着候选走**，不跟着槽位走。
      // 槽位只是"这份属于哪一类（原文/未复验/已复验）"，判定的是**那一份 hash 的文本**；
      // 候选一变，旧结论就只属于历史，不能拿来说"当前这份已经验过"。
      verdict: textOf(rec.verdict),
      pass: Number.isFinite(Number(rec.pass)) ? Number(rec.pass) : null,
      total: Number.isFinite(Number(rec.total)) ? Number(rec.total) : null,
      verified_hash: textOf(rec.hash),
    };
    try {
      const payload = JSON.stringify({ v: 1, slots });
      if (payload.length <= MAX_CHARS) storage.setItem(storageKey(chapterId), payload);
      else storage.removeItem(storageKey(chapterId));
    } catch (_) { /* 配额满：不影响正文与历史版本，只丢去重索引 */ }
    return slots;
  }

  function clear(storage, chapterId) {
    try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(storageKey(chapterId)); } catch (_) { /* 清不掉只影响去重 */ }
    return {};
  }

  /**
   * 「这份存档的验收结论属于谁」（§6）。
   *
   * 修稿候选会一代代换：当前候选、上一版、上上一版。验收结论绑定的是**那一版文本的 hash**，
   * 所以同一份存档的结论**不能**因为"它躺在 verified 槽里"就继承给后来那一版。
   *
   * @param {object} records 存档索引
   * @param {string} slotId 槽位（base / unverified / verified）
   * @param {string} currentHash 当前候选的 hash（空 = 不知道当前是哪一版）
   * @returns {{found:boolean, own:boolean, verdict:string, line:string}}
   */
  function acceptanceOf(records, slotId, currentHash) {
    const rec = (records && typeof records === 'object' ? records[textOf(slotId)] : null) || null;
    const cur = textOf(currentHash);
    if (!rec) return { found: false, own: false, verdict: '', line: '这份存档不存在（没存过或已清理）' };
    const mine = textOf(rec.verified_hash || rec.hash);
    const own = Boolean(cur) && mine === cur;
    const verdict = textOf(rec.verdict) || (textOf(rec.slot || slotId) === 'base' ? 'ORIGINAL' : 'UNKNOWN');
    const passInfo = rec.total != null ? `（逐条通过 ${Number(rec.pass) || 0}/${Number(rec.total) || 0}）` : '';
    if (own) {
      return { found: true, own: true, verdict, line: `这份就是当前候选${passInfo}：验收结论适用于它` };
    }
    if (!cur) {
      return { found: true, own: false, verdict, line: `历史候选${passInfo}：当前候选未确定，结论不适用于别处` };
    }
    return {
      found: true, own: false, verdict,
      line: `历史候选${passInfo}：它的结论只属于 ${mine.slice(0, 22)}，「不继承」给当前候选`,
    };
  }

  /** 一行摘要（界面与测试共用；不足 3 份时如实说少哪一份，不吹成"已全部存档"）。 */
  function summaryOf(records) {
    const slots = records && typeof records === 'object' ? records : {};
    const have = SLOTS.filter((s) => slots[s.id]);
    const missing = SLOTS.filter((s) => !slots[s.id]);
    if (!have.length) return { count: 0, line: '本章还没有修稿存档', missing: missing.map((s) => s.id) };
    const names = have.map((s) => {
      if (s.id === 'base') return '审稿前原文';
      if (s.id === 'unverified') return '未复验候选';
      return '已复验候选';
    });
    return {
      count: have.length,
      line: `本章已存 ${have.length} 份修稿存档（${names.join(' / ')}）${missing.length ? `；还没有：${missing.map((s) => (s.id === 'base' ? '审稿前原文' : s.id === 'unverified' ? '未复验候选' : '已复验候选')).join('、')}` : ''}`,
      missing: missing.map((s) => s.id),
    };
  }

  return {
    VERSION,
    SLOTS,
    MAX_CHARS,
    slotOf,
    hashOf,
    buildSlots,
    load,
    hasSlot,
    remember,
    acceptanceOf,
    clear,
    summaryOf,
    storageKey,
  };
});
