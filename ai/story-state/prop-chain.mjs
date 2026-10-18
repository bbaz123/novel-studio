/**
 * 道具状态链（P1-2，v1.2.2）——轻量事件链：谁/什么道具在第几章处于什么状态，证据逐字可查。
 *
 * 为什么需要它（《v1.2.1 审稿闭环方案》§9.1(1)）："检测单开头两折、结尾一折"这类问题，
 * 自然语言模型能发现，但没有结构化状态就无法**确定性**核验"最终状态与动作链是否相符"。
 * 本模块只做三件事：
 *   · 登记一次状态迁移（必须带正文逐字证据，且证据在当章唯一）；
 *   · 按作品+道具读回有序链（章序 → 同章登记顺序）；
 *   · 给修稿验收提供确定性判据：最新状态是否符合预期、证据是否还在候选里。
 *
 * 纪律：不推断、不自动补状态；没有证据就拒绝登记（返回原因），绝不写"看起来合理"的状态。
 */

export const PROP_CHAIN_VERSION = 1;

const text = (v) => String(v == null ? '' : v);
const countOf = (body, quote) => {
  const b = text(body);
  const q = text(quote).trim();
  if (!q) return 0;
  let n = 0;
  for (let at = b.indexOf(q); at >= 0; at = b.indexOf(q, at + 1)) n += 1;
  return n;
};

export function createPropChain({ db, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('prop-chain 需要 sqlite 连接');

  /**
   * 登记一次状态迁移。
   * @param {object} input
   *   · workId / chapterId / propKey 必填；state 必填；
   *   · evidenceQuote 必填且必须在 chapterText 里**唯一**出现（没给 chapterText 视为无法核验，拒绝）。
   * @returns {{ok:true,id:number,occurrences:number}|{ok:false,code:string,reason:string}}
   */
  function record(input = {}) {
    const workId = Number(input.workId);
    const chapterId = Number(input.chapterId);
    const propKey = text(input.propKey).trim();
    const state = text(input.state).trim();
    const quote = text(input.evidenceQuote).trim();
    if (!Number.isInteger(workId) || workId <= 0) return { ok: false, code: 'WORK_REQUIRED', reason: '缺少 work_id' };
    if (!Number.isInteger(chapterId) || chapterId <= 0) return { ok: false, code: 'CHAPTER_REQUIRED', reason: '道具状态必须绑定章节（章序是链的一部分）' };
    if (!propKey) return { ok: false, code: 'PROP_REQUIRED', reason: '缺少 prop_key' };
    if (!state) return { ok: false, code: 'STATE_REQUIRED', reason: '缺少 state' };
    if (!quote) return { ok: false, code: 'EVIDENCE_REQUIRED', reason: '状态迁移必须有正文逐字证据' };
    if (typeof input.chapterText !== 'string') {
      return { ok: false, code: 'EVIDENCE_UNVERIFIABLE', reason: '没有拿到本章正文：无法核验证据，拒绝登记' };
    }
    const occurrences = countOf(input.chapterText, quote);
    if (occurrences === 0) return { ok: false, code: 'EVIDENCE_NOT_FOUND', reason: `证据「${quote.slice(0, 30)}」不在本章正文里` };
    if (occurrences > 1) return { ok: false, code: 'EVIDENCE_AMBIGUOUS', reason: `证据出现 ${occurrences} 处：无法确定指的是哪一处` };
    const info = db.prepare(`INSERT INTO story_prop_states
      (work_id, chapter_id, prop_key, prop_name, state, evidence_quote, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(workId, chapterId, propKey, text(input.propName).trim() || propKey, state, quote, text(input.source).trim() || 'author', now());
    return { ok: true, id: Number(info.lastInsertRowid), occurrences };
  }

  function chain(workId, propKey) {
    const key = text(propKey).trim();
    return db.prepare(`SELECT id, work_id, chapter_id, prop_key, prop_name, state, evidence_quote, source, created_at
      FROM story_prop_states WHERE work_id = ? AND prop_key = ? ORDER BY chapter_id ASC, id ASC`)
      .all(Number(workId), key)
      .map((r) => ({ ...r, id: Number(r.id), chapter_id: Number(r.chapter_id) }));
  }

  function latest(workId, propKey) {
    const rows = chain(workId, propKey);
    return rows.length ? rows[rows.length - 1] : null;
  }

  /**
   * 修稿验收判据：最新状态是否符合预期、证据是否仍在候选正文里。
   * @returns {{ok:boolean, code:string, reason:string, latest?:object}}
   */
  function verifyState({ workId, propKey, expectedState = '', text: bodyText = null } = {}) {
    const row = latest(workId, propKey);
    if (!row) return { ok: false, code: 'PROP_NOT_REGISTERED', reason: `道具「${text(propKey)}」还没有登记过状态链` };
    if (expectedState && String(row.state) !== String(expectedState)) {
      return { ok: false, code: 'PROP_STATE_MISMATCH', reason: `最新状态是「${row.state}」，与预期「${expectedState}」不符`, latest: row };
    }
    if (bodyText != null && row.evidence_quote && countOf(bodyText, row.evidence_quote) === 0) {
      return { ok: false, code: 'PROP_EVIDENCE_LOST', reason: `状态证据「${text(row.evidence_quote).slice(0, 30)}」在候选正文里不见了`, latest: row };
    }
    return { ok: true, code: 'PROP_STATE_OK', reason: `最新状态「${row.state}」与证据一致`, latest: row };
  }

  return { record, chain, latest, verifyState };
}

/** 纯函数：从有序链里取最终状态并判断是否满足预期（浏览器/Node 共用，不依赖 DB）。 */
export function propChainVerdict({ chain: rows = [], expectedState = '', text: bodyText = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, code: 'PROP_NOT_REGISTERED', reason: '状态链为空' };
  const latestRow = list[list.length - 1];
  if (expectedState && String(latestRow.state) !== String(expectedState)) {
    return { ok: false, code: 'PROP_STATE_MISMATCH', reason: `最新状态「${latestRow.state}」≠ 预期「${expectedState}」`, latest: latestRow };
  }
  if (bodyText != null && latestRow.evidence_quote && countOf(bodyText, latestRow.evidence_quote) === 0) {
    return { ok: false, code: 'PROP_EVIDENCE_LOST', reason: '状态证据在候选正文里不见了', latest: latestRow };
  }
  return { ok: true, code: 'PROP_STATE_OK', reason: `最终状态「${latestRow.state}」自洽`, latest: latestRow };
}
