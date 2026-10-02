/**
 * 作者审批记录（2026-09-27，R02.2）——「作者同意」的服务端执行边界。
 *
 * 为什么需要它：在此之前，模型侧工具（novel_chapter_save / novel_state_commit / rollback）
 * 写入的**唯一**约束是工具描述里那句「等作者同意」。那只是提示词纪律，不是可校验的边界：
 * 模型完全可以自行决定"作者已同意"然后直接写。本模块把这件事变成数据：
 *
 *   · 审批只能由**作者界面**创建（服务端拒绝带 X-Novel-Agent 标记的创建请求）；
 *   · 审批绑定：work_id / chapter_id / op / 基线 hash / 结构化绑定（提案 id+版本哈希、
 *     快照 id 等）/ 创建时间 / 有效期；
 *   · 模型只能**引用**已存在的审批（approval_id），不能创建、不能修改；
 *   · 默认**单次消费**：消费与实际写入在同一 SQLite 事务里，`UPDATE ... WHERE status='active'`
 *     的受影响行数就是并发抢用时的唯一裁决；
 *   · 已消费 / 已撤销 / 过期 / 基线变化 / 作品或章节不符 / 提案集合不符 → 一律拒绝。
 *
 * 保密纪律：审批 id 是不可预测的随机串（不是自增行号），且**不写入模型 Prompt**——
 * 模型侧通过工具参数引用它，宿主侧日志只记录 id 前缀用于排查。
 */
import { randomBytes } from 'node:crypto';
import { db } from '../../db.js';
import { sha16, stableStringify } from './hash.mjs';

export const APPROVAL_OPS = ['chapter_save', 'state_proposal_apply', 'proposal_apply', 'state_rollback', 'temporal_apply', 'temporal_correction', 'repair_run_start', 'repair_run_apply', 'foreshadow_status'];
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

const stmtCache = new Map();
function prepare(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const nowIso = () => new Date().toISOString();
const str = (v) => (v === null || v === undefined ? '' : String(v));

/** 章节正文的基线哈希口径（宿主唯一口径：存库的原始 content 字段）。 */
export function chapterBaselineHash(content) {
  return sha16(str(content));
}

/** 提案集合的基线：按 id 排序的 (id, 行内容指纹) 列表。 */
export function proposalsBaselineHash(rows) {
  const list = (rows || [])
    .map((r) => ({ id: Number(r.id) || 0, fp: sha16(stableStringify({
      kind: str(r.kind), payload: str(r.payload_json ?? r.payload), state: str(r.state), base: str(r.base_state_hash),
    })) }))
    .sort((a, b) => a.id - b.id);
  return sha16(stableStringify(list));
}

/** 每条提案当前内容的指纹（用于"引用时仍与审批时的版本一致"）。 */
export function proposalHash(row) {
  return sha16(stableStringify({
    kind: str(row.kind), payload: str(row.payload_json ?? row.payload), state: str(row.state), base: str(row.base_state_hash),
  }));
}

/** 旧提案（story_event_proposals / story_memory_proposals）的内容指纹。 */
export function legacyProposalHash(row) {
  return sha16(stableStringify({
    summary: str(row.summary), delta: str(row.delta), payload: str(row.payload),
    note: str(row.note), guard: str(row.guard), status: str(row.status),
  }));
}

/** 旧提案集合的基线哈希。 */
export function legacyProposalsBaselineHash(rows) {
  const list = (rows || []).map((r) => ({ id: Number(r.id) || 0, fp: legacyProposalHash(r) })).sort((a, b) => a.id - b.id);
  return sha16(stableStringify(list));
}

/**
 * 创建审批（只应由作者界面调用；调用方负责拒绝 X-Novel-Agent 请求）。
 * baseline/binding 由**服务端**计算后传入，不接受客户端自报。
 */
export function createApproval({ workId, chapterId = null, op, baselineHash = '', binding = {}, note = '', ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!APPROVAL_OPS.includes(str(op))) throw new Error(`createApproval: 未知操作 ${op}`);
  const id = 'apv_' + randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS)).toISOString();
  prepare(`
    INSERT INTO author_approvals (id, work_id, chapter_id, op, baseline_hash, binding_json, note, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, Number(workId) || 0, chapterId ? Number(chapterId) : null, str(op), str(baselineHash), stableStringify(binding || {}), str(note), expiresAt);
  return getApproval(id);
}

export function getApproval(id) {
  const row = prepare('SELECT * FROM author_approvals WHERE id = ?').get(str(id));
  return row || null;
}

/** 列表：默认只回未过期、未消费的 active 审批（作者界面与只读工具共用）。 */
export function listApprovals(workId, { status = 'active', limit = 50 } = {}) {
  const rows = prepare('SELECT * FROM author_approvals WHERE work_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(Number(workId) || 0, Math.min(200, Math.max(1, Number(limit) || 50)));
  const now = nowIso();
  return rows
    .filter((r) => (status === 'all' ? true : r.status === status))
    .map((r) => ({ ...r, expired: r.status === 'active' && r.expires_at <= now }));
}

export function revokeApproval(id, { by = 'author' } = {}) {
  const info = prepare(`UPDATE author_approvals SET status = 'revoked', consumed_at = ?, consumed_by = ? WHERE id = ? AND status = 'active'`)
    .run(nowIso(), str(by), str(id));
  return { ok: Number(info.changes) === 1, id: str(id) };
}

/** 绑定校验（导出给宿主在**事务外预检**：换章/越界提案/换快照必须在任何写入之前就拒绝）。 */
export function checkBinding(op, want, got) {
  if (op === 'chapter_save') {
    const wantChapter = Number(want.chapter_id) || 0;
    const gotChapter = Number(got.chapter_id) || 0;
    if (wantChapter !== gotChapter) return `审批绑定的章节是 #${wantChapter}，本次写入的是 #${gotChapter}`;
    return '';
  }
  if (op === 'state_proposal_apply' || op === 'proposal_apply') {
    const wantIds = (want.proposals || want.ids || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    // 调用方（宿主路由）传的是 { proposals: [...] }，早期只读 got.ids 导致**任何**带审批的
    // 提案应用都会以「本次没有给出要应用的提案 id」失败——即整条授权链是死的（本轮 HTTP 级测试抓到）。
    const gotIds = ((got.proposals || got.ids) || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    if (!gotIds.length) return '本次没有给出要应用的提案 id';
    const missing = gotIds.filter((n) => !wantIds.includes(n));
    if (missing.length) return `提案 ${missing.join('、')} 不在审批范围内（审批只覆盖 ${wantIds.join('、') || '（空）'}）`;
    const wantHashes = want.hashes || {};
    const gotHashes = got.hashes || {};
    for (const id of gotIds) {
      if (wantHashes[String(id)] && gotHashes[String(id)] && wantHashes[String(id)] !== gotHashes[String(id)]) {
        return `提案 #${id} 的内容在审批之后发生了变化（版本哈希不一致），请作者重新确认`;
      }
    }
    return '';
  }
  if (op === 'state_rollback') {
    return Number(want.snapshot_id) === Number(got.snapshot_id) ? '' : `审批绑定的快照是 #${want.snapshot_id}，本次回滚的是 #${got.snapshot_id}`;
  }
  // 时态引擎（T2/T4）：一次性授权精确绑定到提案组 / 修正集 / 重建运行（服务器端计算绑定，模型不能自报）。
  if (op === 'temporal_apply') {
    if (want.binding_id && String(want.binding_id) !== String(got.binding_id || '')) {
      return `审批绑定的提案组是 ${want.binding_id}，本次确认的是 ${got.binding_id || '（缺失）'}`;
    }
    if (want.revision_id && String(want.revision_id) !== String(got.revision_id || '')) {
      return '提案引用的正文修订在审批之后发生了变化（revision 不一致）';
    }
    if (want.payload_hash && got.payload_hash && String(want.payload_hash) !== String(got.payload_hash)) {
      return '提案载荷在审批之后发生了变化（payload hash 不一致），请作者重新确认';
    }
    return '';
  }
  if (op === 'temporal_correction') {
    if (want.corrections_hash && got.corrections_hash && String(want.corrections_hash) !== String(got.corrections_hash)) {
      return '修正内容在审批之后发生了变化（hash 不一致）';
    }
    return '';
  }
  if (op === 'repair_run_start') {
    if (want.root_chapter_id && Number(want.root_chapter_id) !== Number(got.root_chapter_id)) {
      return `审批的根章节是 #${want.root_chapter_id}，本次启动的是 #${got.root_chapter_id}`;
    }
    if (want.base_commit_id && String(want.base_commit_id) !== String(got.base_commit_id || '')) {
      return '审批绑定的基线提交已变化（请重新发起重建授权）';
    }
    if (want.scope_hash && got.scope_hash && String(want.scope_hash) !== String(got.scope_hash)) {
      return '重建目标范围已变化（scope 不一致）';
    }
    return '';
  }
  if (op === 'repair_run_apply') {
    if (want.run_id && String(want.run_id) !== String(got.run_id || '')) {
      return `审批绑定的是重建运行 ${want.run_id}，本次应用的是 ${got.run_id || '（缺失）'}`;
    }
    if (want.manifest_hash && got.manifest_hash && String(want.manifest_hash) !== String(got.manifest_hash)) {
      return '候选清单在审批之后发生了变化（manifest hash 不一致）';
    }
    return '';
  }
  // P1-09：伏笔状态是**直接改账本**的写入（没有提案表），因此模型通道必须持作者审批，
  // 且审批要精确绑定到"哪一条伏笔"与"改成什么状态"——否则一次授权可以改任意伏笔。
  if (op === 'foreshadow_status') {
    if (Number(want.event_id) !== Number(got.event_id)) {
      return `审批绑定的伏笔是 #${want.event_id}，本次修改的是 #${got.event_id}`;
    }
    if (str(want.status) !== str(got.status)) {
      return `审批绑定的状态是 ${want.status}，本次提交的是 ${got.status}`;
    }
    return '';
  }
  return '';
}

/**
 * 在**调用方的事务内**校验并消费审批。返回 { ok, reason, code }。
 * 调用纪律：必须在写入的同一个 SQLite 事务里调用，消费与写入同生共死。
 */
export function consumeApproval(id, { op, workId, chapterId = null, baselineHash = '', binding = {}, by = 'agent' } = {}) {
  const row = getApproval(id);
  if (!row) return { ok: false, code: 'not_found', reason: '审批记录不存在（可能已被清理，或从未创建）' };
  if (row.status === 'consumed') return { ok: false, code: 'consumed', reason: `审批已在 ${row.consumed_at} 被消费（默认单次使用），请作者重新确认` };
  if (row.status === 'revoked') return { ok: false, code: 'revoked', reason: '审批已被作者撤销' };
  if (row.status !== 'active') return { ok: false, code: 'not_active', reason: `审批状态为 ${row.status}，不可用` };
  if (row.expires_at <= nowIso()) {
    prepare(`UPDATE author_approvals SET status = 'expired' WHERE id = ? AND status = 'active'`).run(row.id);
    return { ok: false, code: 'expired', reason: `审批已于 ${row.expires_at} 过期，请作者重新确认` };
  }
  if (str(op) !== str(row.op)) return { ok: false, code: 'op_mismatch', reason: `审批用于 ${row.op}，本次是 ${op}（不能互相顶替）` };
  if (Number(workId) !== Number(row.work_id)) return { ok: false, code: 'work_mismatch', reason: '审批属于另一部作品（跨作品审批无效）' };
  if (row.chapter_id !== null && Number(chapterId) !== Number(row.chapter_id)) {
    return { ok: false, code: 'chapter_mismatch', reason: `审批绑定的是第 #${row.chapter_id} 章，本次是 #${chapterId ?? '（无）'}` };
  }
  if (str(baselineHash) !== str(row.baseline_hash)) {
    return { ok: false, code: 'baseline_mismatch', reason: '审批的基线已变化（期间有其它修改写入），审批失效——请作者重新确认' };
  }
  let want = {};
  try { want = JSON.parse(row.binding_json || '{}'); } catch { want = {}; }
  const problem = checkBinding(str(row.op), want, binding || {});
  if (problem) return { ok: false, code: 'binding_mismatch', reason: problem };
  // 单次消费的原子裁决：只有 status='active' 的那一次 UPDATE 会成功。
  const info = prepare(`UPDATE author_approvals SET status = 'consumed', consumed_at = ?, consumed_by = ? WHERE id = ? AND status = 'active'`)
    .run(nowIso(), str(by), row.id);
  if (Number(info.changes) !== 1) return { ok: false, code: 'raced', reason: '审批在本次消费前已被另一处使用（单次消费）' };
  return { ok: true, reason: '', approval: row };
}

/** 维护用：把已过期的 active 审批标成 expired（只影响状态字，不删行）。 */
export function expireStaleApprovals() {
  const info = prepare(`UPDATE author_approvals SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`).run(nowIso());
  return Number(info.changes) || 0;
}
