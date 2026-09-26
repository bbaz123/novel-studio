/**
 * 确定性故事状态内核 · 提案事务 / 陈旧检查 / 快照 / 回滚（PHASE 6）。
 *
 * 一条不可协商的纪律：**任何状态变更都必须走
 * 提案 → 复核 → 陈旧检查 → 快照 → 原子应用**。
 * 没有例外，包括"显然是正确"的变更——例外一旦开口，就再也没人知道库里哪一条没走过流程。
 *
 * 为什么陈旧检查是这条链上最关键的一环：
 *   作者看到提案、想了一会儿、点了确认。这中间的几分钟里，另一个任务（或作者本人）
 *   可能已经改过同一处状态。若此时照着提案里的**意图**去写，就会**覆盖**那份新状态。
 *   所以每个提案都记 `base_state_hash`，提交前重算 `current_state_hash`；
 *   不一致就是 `STALE`：**不覆盖任何东西**，把提案标成过期，请作者重新确认。
 *
 * 本模块只做**纯计算**（可离线单元测试）：产出声明式的 `ops`，
 * 真正的 SQL 执行在 store.mjs（单事务、失败必回滚）。
 */

import { stateHashOf, stateHashDetail, stableStringify } from './hash.mjs';

const str = (v) => String(v || '');
const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

/** 提案种类 → 影响的表与字段。**声明式**，让 store 的执行是薄薄一层。 */
export const PROPOSAL_KINDS = {
  canon_fact: { table: 'story_facts', label: '正典事实', destructive: false },
  character_knowledge: { table: 'character_knowledge', label: '角色知识', destructive: false },
  timeline_entry: { table: 'story_timeline_entries', label: '时间线条目', destructive: false },
  foreshadow: { table: 'story_events', label: '伏笔', destructive: false },
  entity_create: { table: 'story_entities', label: '新建实体', destructive: false },
  entity_rename: { table: 'story_entities', label: '实体改名', destructive: false },
  entity_merge: { table: 'story_entities', label: '实体合并', destructive: true },
  entity_split: { table: 'story_entities', label: '实体拆分', destructive: true },
  chapter_status: { table: 'chapters', label: '章节状态', destructive: false },
  memory: { table: 'story_memories', label: '长期记忆', destructive: false },
  event: { table: 'story_events', label: '事件', destructive: false },
};

export const PROPOSAL_STATES = ['pending', 'applied', 'rejected', 'stale', 'superseded'];

export function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(PROPOSAL_KINDS, str(kind));
}

export function isDestructiveKind(kind) {
  const spec = PROPOSAL_KINDS[str(kind)];
  return !!(spec && spec.destructive);
}

/**
 * 构造一份提案（纯数据，不落库）。
 * `base_state_hash` 必填——缺失意味着调用方没有做陈旧检查的打算，直接拒绝构造。
 */
export function buildProposal({
  workId, chapterId = null, kind, payload = {}, state, contextHash = '', contractHash = '', note = '', dedupKey = '',
} = {}) {
  if (!isKnownKind(kind)) throw new Error(`buildProposal: 未知提案种类 ${kind}`);
  if (!state) throw new Error('buildProposal: 必须传入当前状态以计算 base_state_hash（不做无基线的提案）');
  const baseStateHash = stateHashOf(state);
  return {
    work_id: workId ?? null,
    chapter_id: chapterId,
    kind: str(kind),
    payload_json: stableStringify(payload),
    base_state_hash: baseStateHash,
    context_hash: str(contextHash),
    contract_hash: str(contractHash),
    state: 'pending',
    conflict_level: 'info',
    auto_fixable: 0,
    requires_author: isDestructiveKind(kind) ? 1 : 0,
    note: str(note),
    dedup_key: str(dedupKey),
  };
}

/**
 * 陈旧检查。
 *
 * @returns {{stale:boolean, reason:string, base:string, current:string, parts?:object}}
 *   注意返回的是**判定**，不是异常：陈旧是正常业务事件（并发写作本来就会发生），
 *   不该让流程崩掉，而该让作者看到"这条要重新确认"。
 */
export function staleCheck(proposal, state) {
  const base = str(proposal && proposal.base_state_hash);
  if (!base) return { stale: true, reason: '提案没有记录 base_state_hash，无法确认基线（按陈旧处理）', base, current: '' };
  if (!state) return { stale: true, reason: '无法读取当前状态，拒绝在不确定的状态上应用', base, current: '' };
  const current = stateHashOf(state);
  if (current === base) return { stale: false, reason: '', base, current };
  const d = stateHashDetail(state);
  return {
    stale: true,
    reason: '当前状态与提案的基线不一致：期间有其它变更写入，应用会覆盖它们',
    base, current,
    parts: d.parts,
  };
}

/**
 * 快照：应用前落盘的状态镜像（回滚的唯一依据）。
 * 只存**内核管的**状态，不镜像宿主既有表——宿主表有自己的版本机制（chapter_save_versions 等），
 * 复制两份会让"回滚到哪一份"变成新的歧义。
 */
export function makeSnapshot(state, { reason = '', label = '', chapterId = null, workId = null } = {}) {
  return {
    work_id: workId,
    chapter_id: chapterId,
    reason: str(reason),
    label: str(label),
    state_hash: stateHashOf(state),
    snapshot_json: stableStringify(state),
  };
}

export function parseSnapshot(row) {
  try {
    return JSON.parse(str(row && row.snapshot_json) || '{}');
  } catch (_) {
    return null;
  }
}

/**
 * 声明式应用计划。
 *
 * 每种提案产出 `{op:'insert'|'update', table, values, where?}` 的列表；
 * store.mjs 在一个事务里按序执行，任一步失败即整体回滚。
 * **没有任何 op 会 DELETE 行**——删除历史会让正文里的引用失去解析目标。
 */
export function planApply(proposal, ctx = {}) {
  const kind = str(proposal && proposal.kind);
  if (!isKnownKind(kind)) return { ok: false, ops: [], reason: `未知提案种类 ${kind}` };
  let payload;
  try {
    payload = typeof proposal.payload_json === 'string' ? JSON.parse(proposal.payload_json || '{}') : (proposal.payload_json || {});
  } catch (e) {
    return { ok: false, ops: [], reason: `提案负载不是合法 JSON：${e.message}` };
  }
  const workId = proposal.work_id ?? null;
  const chapterId = proposal.chapter_id ?? null;
  const ops = [];
  const now = ctx.now || null;

  switch (kind) {
    case 'canon_fact': {
      const items = Array.isArray(payload.facts) ? payload.facts : [payload];
      for (const f of items) {
        if (!str(f.subject) && !f.entity_id) return { ok: false, ops: [], reason: 'canon_fact 需要 subject 或 entity_id' };
        if (!str(f.predicate)) return { ok: false, ops: [], reason: 'canon_fact 需要 predicate' };
        ops.push({
          op: 'insert', table: 'story_facts',
          values: {
            work_id: workId,
            chapter_id: f.chapter_id ?? chapterId,
            entity_id: f.entity_id ?? null,
            subject: str(f.subject), predicate: str(f.predicate), value: str(f.value),
            scope: str(f.scope || 'CANON_KNOWLEDGE'), state: str(f.state || 'known'),
            status: str(f.status || 'established'),
            holder_id: f.holder_id ?? null,
            effective_from: num(f.effective_from, chapterOf(ctx)),
            effective_to: f.effective_to === null || f.effective_to === undefined ? null : num(f.effective_to),
            story_time: str(f.story_time), source_event_id: f.source_event_id ?? null,
            confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : 1,
            dedup_key: str(f.dedup_key), payload: stableStringify(f.payload || {}),
            created_at: now, updated_at: now,
          },
        });
      }
      // 取代关系：payload.supersedes 列出被取代的事实 id，改成 superseded 而不是删除
      for (const id of (payload.supersedes || [])) {
        ops.push({ op: 'update', table: 'story_facts', where: { id: num(id) }, values: { status: 'superseded', updated_at: now } });
      }
      break;
    }
    case 'character_knowledge': {
      const items = Array.isArray(payload.knowledge) ? payload.knowledge : [payload];
      for (const k of items) {
        if (k.character_id === undefined || k.character_id === null) return { ok: false, ops: [], reason: 'character_knowledge 需要 character_id' };
        if (!str(k.fact_key)) return { ok: false, ops: [], reason: 'character_knowledge 需要 fact_key' };
        ops.push({
          // ⚠ 冲突目标必须**重复**部分唯一索引的谓词（SQLite 规则）：character_knowledge 上的唯一索引是
          // `... ON (work_id, character_id, fact_key) WHERE fact_key != ''`。少了这句，任何 character_knowledge
          // 提案都会以 ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint 失败——
          // 也就是说「角色知识边界」这条路整条是死的（第五步 Golden Novel 联合回归实测抓到，此前无测试覆盖）。
          op: 'upsert', table: 'character_knowledge', conflictKeys: ['work_id', 'character_id', 'fact_key'], conflictWhere: "fact_key != ''",
          values: {
            work_id: workId, character_id: num(k.character_id), fact_id: k.fact_id ?? null,
            fact_key: str(k.fact_key), state: str(k.state || 'known'),
            learned_chapter_id: k.learned_chapter_id ?? chapterId,
            learned_chapter_index: num(k.learned_chapter_index, chapterOf(ctx)),
            learned_scene_index: num(k.learned_scene_index),
            story_time: str(k.story_time), source: str(k.source), note: str(k.note),
            created_at: now,
          },
        });
      }
      break;
    }
    case 'timeline_entry': {
      const items = Array.isArray(payload.entries) ? payload.entries : [payload];
      for (const t of items) {
        ops.push({
          op: 'insert', table: 'story_timeline_entries',
          values: {
            work_id: workId, chapter_id: t.chapter_id ?? chapterId, event_id: t.event_id ?? null,
            chapter_index: num(t.chapter_index, chapterOf(ctx)), scene_index: num(t.scene_index),
            seq: num(t.seq), story_time: str(t.story_time), relative_time: str(t.relative_time),
            day_offset: t.day_offset === null || t.day_offset === undefined ? null : Number(t.day_offset),
            effective_from: num(t.effective_from, num(t.chapter_index, chapterOf(ctx))),
            effective_to: t.effective_to === null || t.effective_to === undefined ? null : num(t.effective_to),
            before_event_id: t.before_event_id ?? null, after_event_id: t.after_event_id ?? null,
            kind: str(t.kind || 'event'), label: str(t.label), payload: stableStringify(t.payload || {}),
            source: str(t.source || 'proposal'), created_at: now, updated_at: now,
          },
        });
      }
      break;
    }
    case 'foreshadow': {
      const t = payload.foreshadow || payload;
      if (t.id === undefined || t.id === null) return { ok: false, ops: [], reason: 'foreshadow 需要 id（指向既有 story_events 行）' };
      const values = {};
      if (t.foreshadow_status !== undefined) values.foreshadow_status = str(t.foreshadow_status);
      if (t.resolves_event_id !== undefined) values.resolves_event_id = t.resolves_event_id === null ? null : num(t.resolves_event_id);
      if (!Object.keys(values).length) return { ok: false, ops: [], reason: 'foreshadow 没有任何要改的字段' };
      ops.push({ op: 'update', table: 'story_events', where: { id: num(t.id), work_id: workId }, values });
      break;
    }
    case 'entity_create': {
      if (!str(payload.canonical_name)) return { ok: false, ops: [], reason: 'entity_create 需要 canonical_name' };
      ops.push({
        op: 'insert', table: 'story_entities',
        values: {
          work_id: workId, kind: str(payload.kind || 'character'), canonical_name: str(payload.canonical_name),
          status: 'active', ref_table: str(payload.ref_table), ref_id: payload.ref_id ?? null,
          note: str(payload.note), created_at: now, updated_at: now,
        },
        returnId: 'entity_id',
      });
      for (const a of (payload.aliases || [])) {
        ops.push({ op: 'insert_alias', table: 'story_entity_aliases', aliasOf: 'entity_id', values: { alias: str(a.alias || a), kind: str(a.kind || 'alias') } });
      }
      break;
    }
    case 'entity_rename': {
      const id = num(payload.entity);
      if (!id) return { ok: false, ops: [], reason: 'entity_rename 需要 entity' };
      ops.push({ op: 'update', table: 'story_entities', where: { id, work_id: workId }, values: { canonical_name: str(payload.to_name), updated_at: now } });
      ops.push({
        op: 'insert', table: 'story_entity_aliases',
        values: {
          work_id: workId, entity_id: id, alias: str(payload.from_name),
          normalized: '', kind: 'historical', valid_to: payload.at_chapter_index === null || payload.at_chapter_index === undefined ? null : num(payload.at_chapter_index),
          created_at: now,
        },
      });
      break;
    }
    case 'entity_merge': {
      const into = num(payload.into);
      const from = (payload.from || []).map(num).filter(Boolean);
      if (!into || !from.length) return { ok: false, ops: [], reason: 'entity_merge 需要 into 与 from' };
      ops.push({ op: 'move_aliases', table: 'story_entity_aliases', fromEntityIds: from, intoEntityId: into, workId });
      for (const id of from) {
        ops.push({ op: 'update', table: 'story_entities', where: { id, work_id: workId }, values: { status: 'merged', merged_into: into, updated_at: now } });
      }
      ops.push({ op: 'repoint_facts', table: 'story_facts', fromEntityIds: from, intoEntityId: into, workId });
      break;
    }
    case 'entity_split': {
      const src = num(payload.from);
      if (!src) return { ok: false, ops: [], reason: 'entity_split 需要 from' };
      ops.push({
        op: 'insert', table: 'story_entities',
        values: {
          work_id: workId, kind: str(payload.kind || 'character'), canonical_name: str(payload.new_name),
          status: 'active', split_from: src, note: str(payload.note), created_at: now, updated_at: now,
        },
        returnId: 'new_entity_id',
      });
      ops.push({
        op: 'move_aliases_named', table: 'story_entity_aliases', fromEntityId: src, intoEntityRef: 'new_entity_id',
        names: (payload.aliases || []).map(str), workId,
      });
      ops.push({ op: 'repoint_facts', table: 'story_facts', fromEntityIds: [src], intoEntityRef: 'new_entity_id', factIds: (payload.fact_ids || []).map(num).filter(Boolean), workId });
      break;
    }
    case 'chapter_status': {
      if (!chapterId) return { ok: false, ops: [], reason: 'chapter_status 需要 chapter_id' };
      const values = {};
      for (const k of ['summary', 'author_note', 'target_words', 'blueprint_json']) {
        if (payload[k] !== undefined) values[k] = k === 'target_words' ? num(payload[k]) : str(payload[k]);
      }
      if (!Object.keys(values).length) return { ok: false, ops: [], reason: 'chapter_status 没有可改字段' };
      values.updated_at = now;
      ops.push({ op: 'update', table: 'chapters', where: { id: chapterId, work_id: workId }, values });
      break;
    }
    case 'memory': {
      ops.push({ op: 'insert', table: 'memory_versions', values: { work_id: workId, summary: str(payload.summary), source: str(payload.source || 'proposal'), note: str(payload.note), created_at: now } });
      ops.push({ op: 'upsert', table: 'story_memories', conflictKeys: ['work_id'], values: { work_id: workId, summary: str(payload.summary), updated_at: now } });
      break;
    }
    case 'event': {
      if (!str(payload.summary)) return { ok: false, ops: [], reason: 'event 需要 summary' };
      ops.push({
        op: 'insert', table: 'story_events',
        values: {
          work_id: workId, chapter_id: chapterId, kind: str(payload.kind || 'event'), summary: str(payload.summary),
          payload: stableStringify(payload.payload || {}), foreshadow_status: str(payload.foreshadow_status || ''),
          resolves_event_id: payload.resolves_event_id ?? null, dedup_key: str(payload.dedup_key), created_at: now,
        },
        returnId: 'event_id',
      });
      break;
    }
    default:
      return { ok: false, ops: [], reason: `未实现的应用计划：${kind}` };
  }
  return { ok: true, ops, reason: '' };
}

function chapterOf(ctx) {
  return num(ctx && ctx.chapterIndex);
}

/**
 * 回滚计划：把快照里的状态**重新投影**成一组 op。
 *
 * 关键取舍：回滚**不是**"把库还原成快照的样子"（那需要删掉快照之后新增的行，
 * 而删除会让正文引用悬空）。回滚的语义是：把快照里那些被改过/被取代的条目**改回去**，
 * 快照之后新增的行**保留但标记为 superseded**——历史永远不丢。
 */
export function planRollback(snapshotState, currentState) {
  const before = snapshotState || {};
  const now = currentState || {};
  const ops = [];
  const keyOf = (f) => str(f.dedup_key) || `${str(f.subject)}::${str(f.predicate)}::${str(f.value)}`;

  const beforeFacts = new Map((before.facts || []).map((f) => [keyOf(f), f]));
  const currentFacts = new Map((now.facts || []).map((f) => [keyOf(f), f]));

  // 快照里有、当前没有（被删或改了键）→ 以 insert 复活
  for (const [k, f] of beforeFacts) {
    if (!currentFacts.has(k)) {
      ops.push({ op: 'restore', table: 'story_facts', key: k, values: f });
    }
  }
  // 当前有、快照里没有（快照之后新增）→ 标记 superseded（不删除）
  for (const [k, f] of currentFacts) {
    if (!beforeFacts.has(k)) {
      ops.push({ op: 'update', table: 'story_facts', where: { id: num(f.id) }, values: { status: 'superseded' } });
    }
  }
  // 两边都有但内容不同 → 改回快照里的取值
  for (const [k, f] of beforeFacts) {
    const cur = currentFacts.get(k);
    if (!cur) continue;
    const patch = {};
    for (const field of ['value', 'state', 'status', 'scope', 'effective_from', 'effective_to', 'story_time']) {
      if (stableStringify(f[field]) !== stableStringify(cur[field])) patch[field] = f[field];
    }
    if (Object.keys(patch).length) ops.push({ op: 'update', table: 'story_facts', where: { id: num(cur.id) }, values: patch });
  }

  // 知识边界：按 (character_id, fact_key) 对齐，语义同上
  const kKey = (x) => `${str(x.character_id)}::${str(x.fact_key)}`;
  const bK = new Map((before.knowledge || []).map((x) => [kKey(x), x]));
  const cK = new Map((now.knowledge || []).map((x) => [kKey(x), x]));
  for (const [k, x] of bK) {
    const cur = cK.get(k);
    if (!cur) ops.push({ op: 'restore', table: 'character_knowledge', key: k, values: x });
    else if (str(cur.state) !== str(x.state) || num(cur.learned_chapter_index) !== num(x.learned_chapter_index)) {
      ops.push({ op: 'update', table: 'character_knowledge', where: { id: num(cur.id) }, values: { state: x.state, learned_chapter_index: x.learned_chapter_index, learned_scene_index: x.learned_scene_index } });
    }
  }

  // 实体状态：合并 / 拆分的回滚（把 status 改回，merged_into 清空）
  const eKey = (x) => str(x.canonical_name) || `#${x.id}`;
  const bE = new Map((before.entities || []).map((x) => [eKey(x), x]));
  for (const [k, x] of bE) {
    const cur = (now.entities || []).find((y) => eKey(y) === k);
    if (cur && (str(cur.status) !== str(x.status) || stableStringify(cur.merged_into) !== stableStringify(x.merged_into))) {
      ops.push({ op: 'update', table: 'story_entities', where: { id: num(cur.id) }, values: { status: str(x.status || 'active'), merged_into: x.merged_into ?? null } });
    }
  }

  return { ok: true, ops, note: '回滚保留快照之后新增的历史（标记 superseded），不删除任何行。' };
}

/** 提案可否应用：陈旧 / 种类 / 计划三步都要过。 */
export function reviewProposal(proposal, state, ctx = {}) {
  const stale = staleCheck(proposal, state);
  if (stale.stale) {
    return { ok: false, decision: 'stale', reason: stale.reason, stale, plan: null };
  }
  const plan = planApply(proposal, ctx);
  if (!plan.ok) return { ok: false, decision: 'invalid', reason: plan.reason, stale, plan: null };
  return { ok: true, decision: 'applicable', reason: '', stale, plan };
}