/**
 * 时态故事状态 · 存量迁移与 bootstrap（T7，方案 §12）。
 *
 * 分工（复用既有设施，不另造平行体系）：
 *   · migrationStatus()          真实迁移链自检 + 版本登记：缺表 / 缺索引一律响亮说不，
 *                                迁移完成前禁止开启引擎（不吞错误继续跑）。
 *   · planBackfill()             存量正文按**真实叙事顺序**逐章规划：冻结修订 → 抽取 → 候选 →
 *                                作者确认 → 章节边界快照 → 事后依赖。旧稿没有生成时上下文 →
 *                                如实记 reconstructed / unknown，绝不伪造原始创作记录。
 *   · backfillStep()             单章一步：冻结不可变修订（不改写正文）+ 记候选（等作者确认）。
 *                                没有模型结果时只返回抽取请求（待分析任务保留，不生成假历史）。
 *   · confirmBackfillChapter()   作者逐章确认；可信前缀只在按序确认后前进。
 *   · planBootstrapCandidates()  旧字段（角色 status / 关系 / 已确立事实）的最新值 →
 *                                **待确认**开篇候选；不自动回填成"第 0 章就拥有最新状态"。
 *   · decideBootstrapCandidate() 作者决定：作为开篇设定（commit.manifest.initial_binding_id）
 *                                或按指定章生效（转为该章的普通待确认提案）；拒绝不写任何状态。
 *   · enableScope()              启用前告知预算与待重建范围（章数 / 预计模型调用 / 待确认候选）。
 *
 * 纪律：不改写导入正文；本模块不调用模型（抽取结果由调用方按批提供）；
 *       真实作品库不可作为试验场（测试走 NOVELSTUDIO_DATA_DIR 临时目录）。
 */
import { db, inTransaction, withTransaction } from '../../../db.js';
import { htmlToPlain } from '../../../text-utils.js';
import { hashJson, sha16 } from './schema.mjs';
import { listOrder, ensureOrderVersion } from './order.mjs';
import { latestRevisionOf } from './revision-store.mjs';
import {
  createBinding, createEvents, eventsOfBinding, getBinding, listBindings,
  setBindingValidity,
} from './event-store.mjs';
import { reduceBatch, stateContentHash, stateFromJson } from './reducer.mjs';
import { saveSnapshot } from './snapshot.mjs';
import { stateAt, stateBefore, trustReport } from './history.mjs';
import { commitManifest, ensureMainCommit, ensureMainWorldline, manifestOf } from './worldline-store.mjs';
import { refreshCompatProjection } from './compat.mjs';
import {
  analysisContext, analysisTarget, completeAnalysis, confirmBinding, recordContentSave, refreshPendingContext,
} from './service.mjs';
import { buildExtractionPrompt, parseExtractionResponse, summarizeProposalEvents } from './extraction.mjs';
import { getTemporalConfig, isTemporalEnabled } from './config.mjs';

export const TEMPORAL_MIGRATION_VERSION = '1.0.0';
const SETTING_KEY = 'temporal_migration';
const BOOTSTRAP_KIND = 'bootstrap_candidate';
const POST_HOC_NOTE = '旧稿没有生成时上下文：按事后重建记录依赖，不伪造原始创作记录';

export const REQUIRED_TABLES = Object.freeze([
  'story_chapter_order_versions', 'story_worldlines', 'story_commits', 'story_chapter_revisions',
  'story_state_events', 'chapter_state_snapshots', 'story_chapter_bindings', 'story_binding_trust',
  'story_chapter_dependencies', 'story_repair_runs', 'story_repair_steps',
]);
export const REQUIRED_INDEXES = Object.freeze([
  'idx_temporal_order_work', 'idx_temporal_commit_work', 'idx_temporal_revision_chapter',
  'idx_temporal_events_revision', 'idx_temporal_snapshot_work', 'idx_temporal_binding_chapter',
  'idx_temporal_binding_validity', 'idx_temporal_trust_commit', 'idx_temporal_dependency_resource',
  'idx_temporal_dependency_binding', 'idx_temporal_repair_work', 'idx_temporal_step_run',
]);

const now = () => new Date().toISOString();

/** 只读探针：必要表 / 索引是否齐备（缺一即 ok:false，调用方必须响亮拒绝）。 */
export function schemaProbe() {
  let names = [];
  try {
    names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all()
      .map((r) => String(r.name));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), missing_tables: [...REQUIRED_TABLES], missing_indexes: [...REQUIRED_INDEXES] };
  }
  const have = new Set(names);
  const missingTables = REQUIRED_TABLES.filter((t) => !have.has(t));
  const missingIndexes = REQUIRED_INDEXES.filter((i) => !have.has(i));
  return {
    ok: missingTables.length === 0 && missingIndexes.length === 0,
    total_objects: names.length, missing_tables: missingTables, missing_indexes: missingIndexes,
    note: missingTables.length || missingIndexes.length ? '缺少必要表/索引：迁移未完成前禁止开启时态引擎。' : '',
  };
}

function readMigrationRecord() {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY);
    if (!row) return null;
    return JSON.parse(String(row.value));
  } catch { return null; }
}

/** 迁移状态：schema 齐备 + 版本登记一致才算 applied（可直接用于功能开关门禁）。 */
export function migrationStatus() {
  const probe = schemaProbe();
  const recorded = readMigrationRecord();
  const recordedVersion = recorded ? String(recorded.version || '') : '';
  return {
    ok: probe.ok,
    applied: probe.ok && recordedVersion === TEMPORAL_MIGRATION_VERSION,
    version: TEMPORAL_MIGRATION_VERSION,
    recorded_version: recordedVersion,
    recorded_at: recorded ? String(recorded.at || '') : '',
    missing_tables: probe.missing_tables,
    missing_indexes: probe.missing_indexes,
    note: probe.ok ? '' : probe.note,
  };
}

/** 登记迁移版本（只在 schema 齐备时写入；不齐备一律失败，不制造"看起来已迁移"的记录）。 */
export function recordMigration({ note = '' } = {}) {
  const probe = schemaProbe();
  if (!probe.ok) {
    const err = new Error('TEMPORAL_MIGRATION_INCOMPLETE: 缺少 ' + probe.missing_tables.concat(probe.missing_indexes).join(', '));
    err.probe = probe;
    throw err;
  }
  const payload = { version: TEMPORAL_MIGRATION_VERSION, at: now(), note: String(note || '') };
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTING_KEY, JSON.stringify(payload));
  return migrationStatus();
}
// ── 存量重建（backfill）─────────────────────────────────────────────────────

function chapterRowOf(workId, chapterId) {
  return db.prepare('SELECT id, work_id, volume_id, parent_id, title, content, position FROM chapters WHERE id = ? AND work_id = ?')
    .get(Number(chapterId) || 0, Number(workId) || 0) || null;
}

function rootChapterOf(order, chapterId) {
  const id = Number(chapterId) || 0;
  if (order.indexById.has(id)) return id;
  const row = db.prepare('SELECT parent_id FROM chapters WHERE id = ?').get(id);
  if (row && row.parent_id !== null && row.parent_id !== undefined && order.indexById.has(Number(row.parent_id))) {
    return Number(row.parent_id);
  }
  return null;
}

/** 单章当前状态机（面板 / 计划 / 进度共用同一判定，避免界面自己猜）。 */
function chapterBackfillState(workId, chapterId) {
  // bootstrap 候选锚定在首章（仅为承载"开篇设定"事件），它的确认不是"本章正文已确认"：
  // 不能因此把该章标成 valid / pending（与 confirmBackfillChapter 的幂等判定同一口径）。
  const isChapterBinding = (b) => String(((b && b.contract_ref) || {}).kind) !== BOOTSTRAP_KIND;
  const revision = latestRevisionOf(chapterId);
  const valid = listBindings(workId, { chapterId, validity: 'valid', limit: 5 }).find(isChapterBinding) || null;
  const pending = listBindings(workId, { chapterId, validity: 'pending', limit: 5 }).find(isChapterBinding) || null;
  const analysis = pending ? ((pending.validation || {}).analysis || {}) : {};
  const deps = valid ? db.prepare('SELECT COUNT(*) n FROM story_chapter_dependencies WHERE binding_id = ?').get(valid.id).n : 0;
  const snapshots = db.prepare(`SELECT COUNT(*) n FROM chapter_state_snapshots
      WHERE work_id = ? AND chapter_id = ? AND cursor_json NOT LIKE '%boundary%'`)
    .get(Number(workId) || 0, Number(chapterId) || 0).n;
  let state = 'missing_revision';
  if (valid) state = 'valid';
  else if (pending) {
    const analysisStatus = String(analysis.status || '');
    state = analysisStatus === 'done' ? 'pending_confirm'
      : analysisStatus === 'running' ? 'analysis_running'
        : 'pending_analysis';
  } else if (revision) {
    const last = listBindings(workId, { chapterId, limit: 5 }).find(isChapterBinding) || null;
    state = last && ['stale', 'conflict', 'needs_review', 'blocked'].includes(last.validity) ? last.validity : 'pending_analysis';
  }
  return {
    state, revision_id: revision ? revision.id : null, revision_text_hash: revision ? revision.text_hash : '',
    binding_id: (valid || pending) ? (valid || pending).id : null,
    binding_validity: (valid || pending) ? (valid || pending).validity : null,
    analysis_status: String(analysis.status || ''),
    dependencies: Number(deps) || 0, snapshots_after: Number(snapshots) || 0,
  };
}
/**
 * 存量重建计划：按真实叙事顺序逐章给出状态与出处。
 * 只读（除确保章序版本这一条幂等写入）；不改写正文、不调用模型。
 */
export function planBackfill({ workId, limit = 0 } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('planBackfill: 缺少 workId');
  const probe = schemaProbe();
  if (!probe.ok) return { ok: false, work_id: w, decision: 'blocked', reason: probe.note, schema: migrationStatus() };
  const order = listOrder(w);
  const orderVersion = ensureOrderVersion(w);
  const chapters = [];
  for (const [index, chapterId] of order.chapters.entries()) {
    const row = chapterRowOf(w, chapterId);
    const st = chapterBackfillState(w, chapterId);
    const scenes = ((order.scenes || {})[String(chapterId)] || []);
    chapters.push({
      index, chapter_id: Number(chapterId), title: row ? String(row.title || '') : '',
      scenes,
      ...st,
      // 出处：正文来源是既有手稿（冻结修订）；生成时上下文缺失 → 事后重建，未知不猜。
      provenance: {
        manuscript: st.revision_id ? 'frozen' : 'needs_freeze',
        generation_context: 'unknown',
        support: 'reconstructed',
        note: POST_HOC_NOTE,
      },
    });
  }
  const totals = { chapters: chapters.length, valid: 0, pending_confirm: 0, pending_analysis: 0, analysis_running: 0, missing_revision: 0, stale: 0, needs_review: 0, conflict: 0, blocked: 0 };
  for (const c of chapters) totals[c.state] = (totals[c.state] || 0) + 1;
  const next = chapters.find((c) => c.state !== 'valid') || null;
  const trust = trustReport({ workId: w });
  return {
    ok: true, work_id: w, order_version_id: orderVersion.id, order_version_reused: !!orderVersion.reused,
    chapters: limit > 0 ? chapters.slice(0, limit) : chapters,
    totals, next_chapter_id: next ? next.chapter_id : null,
    trusted_through: Number(trust.trusted_through) || 0,
    trust_totals: trust.totals || null,
    policy: {
      authority: 'story_commits.manifest + story_chapter_bindings + story_state_events',
      note: '逐章按序重建：冻结修订 → 抽取 → 作者确认 → 章边界快照 → 事后依赖；确认一章才推进可信前缀。',
    },
  };
}

/** 预计模型调用（一次抽取 = 一次调用；确定性路径零调用）：如实给出范围，不承诺毫秒/费用。 */
function budgetOf(plan) {
  const needExtract = (plan.chapters || []).filter((c) => ['missing_revision', 'pending_analysis', 'stale', 'needs_review', 'conflict'].includes(c.state)).length;
  const needConfirm = (plan.chapters || []).filter((c) => c.state === 'pending_confirm' || c.state === 'analysis_running').length;
  return {
    chapters_total: plan.totals.chapters,
    chapters_needing_extraction: needExtract,
    chapters_awaiting_confirm: needConfirm,
    model_calls_estimated: needExtract,
    model_calls_note: '每次抽取一章一次调用；作者可用本机 fake / 离线结果替代（零计费）。保存路径本身不调用模型。',
    auto_analysis_default: 'off',
  };
}

/** 存量重建进度（计划 + 预算 + bootstrap 摘要；界面与脚本共用）。 */
export function backfillStatus({ workId } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('backfillStatus: 缺少 workId');
  const plan = planBackfill({ workId: w });
  if (plan.ok === false) return plan;
  const candidates = listBootstrapCandidates({ workId: w });
  return {
    ok: true, work_id: w, migration: migrationStatus(), config: getTemporalConfig(w),
    totals: plan.totals, next_chapter_id: plan.next_chapter_id, trusted_through: plan.trusted_through,
    chapters: plan.chapters,
    bootstrap: { total: candidates.length, pending: candidates.filter((c) => c.status === 'pending').length, items: candidates },
    budget: budgetOf(plan),
  };
}

/** 启用前范围告知（AC-41：未启用作品不触发额外模型调用、不改变旧上下文）。 */
export function enableScope({ workId } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('enableScope: 缺少 workId');
  const plan = planBackfill({ workId: w });
  if (plan.ok === false) return plan;
  const candidates = listBootstrapCandidates({ workId: w });
  return {
    ok: true, work_id: w, schema: migrationStatus(), config: getTemporalConfig(w),
    pending_rebuild: plan.totals,
    upcoming: plan.chapters.filter((c) => c.state !== 'valid').slice(0, 20)
      .map((c) => ({ chapter_id: c.chapter_id, index: c.index, state: c.state })),
    bootstrap_pending: candidates.filter((c) => c.status === 'pending').length,
    budget: budgetOf(plan),
    notes: [
      '旧作品默认不启用自动模型分析：auto_analysis_enabled 仍为 0 时，保存只登记修订与待确认提案。',
      '逐章重建（含存量重建）由作者按钮 / 显式调用驱动，不后台自动跑全本。',
      '未启用作品：上下文装配与端点契约逐字节不变，不触发额外模型调用。',
    ],
  };
}
/**
 * 单章一步：冻结修订（不改写正文）→（有模型结果时）记候选。
 * @param {object} args
 * @param {number} args.workId
 * @param {number} args.chapterId
 * @param {object|string|null} [args.result] 抽取结果（缺省 = 只返回抽取请求，待分析任务保留）
 */
export function backfillStep({ workId, chapterId, result = null, provider = 'author_ui', model = '', inputHash = '' } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('backfillStep: 缺少 workId / chapterId');
  if (!isTemporalEnabled(w)) {
    return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎（先显式启用）' };
  }
  const probe = schemaProbe();
  if (!probe.ok) return { ok: false, enabled: true, work_id: w, chapter_id: c, decision: 'blocked', reason: probe.note };
  const order = listOrder(w);
  const rootId = rootChapterOf(order, c);
  if (rootId === null) return { ok: false, enabled: true, work_id: w, chapter_id: c, decision: 'blocked', reason: '章节不在该作品的章序里：先导入正文 / 建立章节' };
  const row = chapterRowOf(w, c);
  if (!row) return { ok: false, enabled: true, work_id: w, chapter_id: c, decision: 'blocked', reason: '章节不存在' };
  const index = order.indexById.get(rootId);
  return withTransaction(() => {
    // ① 冻结不可变修订：内容寻址、同一内容幂等；正文本身一行都不改。
    const frozen = recordContentSave({
      workId: w, chapterId: c, contentHtml: String(row.content || ''),
      origin: {
        kind: 'import_backfill', actor: 'author', source: 'manuscript',
        extra: { post_hoc: true, generation_context: 'unknown', order_index: index, note: POST_HOC_NOTE },
      },
    });
    if (!frozen.enabled) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: frozen.reason };
    const target = analysisTarget({ workId: w, chapterId: c });
    if (target.status === 'no_content') {
      return { ok: true, enabled: true, work_id: w, chapter_id: c, index, status: 'empty_chapter', revision_id: frozen.revision_id, note: '空章节：已冻结空修订；没有可抽取的正文（不生成假事件）' };
    }
    if (target.status === 'up_to_date') {
      return { ok: true, enabled: true, work_id: w, chapter_id: c, index, status: 'up_to_date', revision_id: frozen.revision_id, note: '本章没有待确认提案（已是最新）' };
    }
    const binding = target.binding;
    if (!result) {
      // 待分析任务保留：刷新输入绑定（按当前可信前缀）+ 返回抽取请求；模型不可用时不许编造历史。
      const refreshed = refreshPendingContext({ workId: w, chapterId: c, bindingId: binding.id });
      const context = analysisContext({ workId: w, chapterId: c });
      if (context.ok === false) {
        return { ok: false, enabled: true, work_id: w, chapter_id: c, index, decision: 'blocked', reason: context.reason || '章前状态不可用', binding_id: binding.id };
      }
      const revision = latestRevisionOf(c);
      const prompt = buildExtractionPrompt({
        chapterId: c, chapterTitle: String(row.title || ''), revision,
        plainText: htmlToPlain(String(row.content || '')),
        stateBeforeJson: context.state_json || {},
        known: context.known || {},
      });
      return {
        ok: true, enabled: true, work_id: w, chapter_id: c, index, status: 'awaiting_extraction',
        revision_id: revision ? revision.id : null, binding_id: binding.id,
        input_trusted: !!context.trusted, refreshed: !!refreshed.ok,
        prompt,
        provenance: { manuscript: 'frozen', generation_context: 'unknown', support: 'reconstructed', note: POST_HOC_NOTE },
      };
    }
    // ② 有模型结果：先走本地结构校验（唯一校验器），再把候选挂到待确认提案上（不写正式状态）。
    const revision = latestRevisionOf(c);
    const parsed = parseExtractionResponse(result, { workId: w, chapterId: c, revisionId: revision ? revision.id : '', plainText: htmlToPlain(String(row.content || '')) });
    if (!parsed.events.length) {
      return {
        ok: false, enabled: true, work_id: w, chapter_id: c, index, decision: 'needs_review', binding_id: binding.id,
        reason: '抽取结果没有可用事件：待分析任务保留（不会写入假历史）', issues: parsed.issues,
      };
    }
    const done = completeAnalysis({
      workId: w, chapterId: c, bindingId: binding.id,
      events: parsed.events, assumptions: parsed.assumptions || [],
      provider, model, inputHash, resultHash: hashJson({ issues: parsed.issues.length, events: parsed.events.length }),
      issues: parsed.issues,
    });
    return {
      ok: !!done.ok, enabled: true, work_id: w, chapter_id: c, index,
      status: done.ok ? 'pending_confirm' : String(done.decision || 'rejected'),
      reason: done.reason || '', binding_id: binding.id, revision_id: revision ? revision.id : null,
      proposal: done.proposal || summarizeProposalEvents(parsed.events), issues: parsed.issues,
      note: '候选已登记（未写入任何正式状态）：请作者确认本章后可信前缀才会前进。',
    };
  });
}

/** 作者确认一章（按叙事顺序；上游不可信 / 正文已变一律拒绝，绝不强接）。 */
export function confirmBackfillChapter({ workId, chapterId, bindingId = null, note = '' } = {}) {
  const w = Number(workId) || 0;
  const c = Number(chapterId) || 0;
  if (!w || !c) throw new Error('confirmBackfillChapter: 缺少 workId / chapterId');
  if (!isTemporalEnabled(w)) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: '该作品未开启时态故事状态引擎' };
  const target = analysisTarget({ workId: w, chapterId: c });
  if (!target.enabled) return { ok: false, enabled: false, work_id: w, chapter_id: c, reason: target.reason };
  const binding = bindingId ? getBinding(bindingId) : target.binding;
  if (!binding) {
    // 幂等回执：本章已确认过（候选类绑定不算章节确认）。
    const valid = listBindings(w, { chapterId: c, validity: 'valid', limit: 5 })
      .find((b) => String((b.contract_ref || {}).kind) !== BOOTSTRAP_KIND) || null;
    if (valid) {
      return {
        ok: true, enabled: true, reused: true, decision: 'valid', work_id: w, chapter_id: c,
        binding_id: valid.id, revision_id: valid.revision_id,
        note: '本章已确认（幂等回执）：没有重复写入任何状态。',
      };
    }
    return { ok: false, enabled: true, work_id: w, chapter_id: c, decision: 'blocked', reason: '本章没有待确认提案（先跑 backfill step 记录抽取结果）' };
  }
  const res = confirmBinding({ workId: w, chapterId: c, bindingId: binding.id, source: 'import_rebuild', author: 'author' });
  if (!res.ok) return { ...res, enabled: true, work_id: w, chapter_id: c };
  // 事后重建依赖：如实记录"生成时上下文未知"，不伪造原始 context（AC-39）。
  const resourceKey = 'generation_input:' + c;
  db.prepare(`INSERT OR IGNORE INTO story_chapter_dependencies
      (id, work_id, binding_id, kind, resource_key, expected_hash, dependency_json, created_at)
      VALUES (?, ?, ?, 'unknown', ?, '', ?, ?)`)
    .run('dep_' + sha16(w + '|' + binding.id + '|' + resourceKey + '|post_hoc'), w, binding.id, resourceKey,
      JSON.stringify({ status: 'unknown', provenance: 'reconstructed', note: POST_HOC_NOTE, chapter_id: c, at: now() }), now());
  const after = stateAt({ workId: w, chapterId: c, boundary: 'after' });
  const plan = planBackfill({ workId: w });
  return {
    ...res, enabled: true, work_id: w, chapter_id: c, provenance: { generation_context: 'unknown', support: 'reconstructed' },
    note: String(note || '') || '本章已按序确认：可信前缀前进；如正文仍成立则无需改写。',
    trusted_through: Number(plan.trusted_through) || 0, next_chapter_id: plan.next_chapter_id,
    verified_through: after ? after.verified_through : null,
  };
}
// ── bootstrap 候选（旧字段最新值 → 待确认，绝不自动回填）────────────────────

function legacyCandidatesOf(workId) {
  const w = Number(workId) || 0;
  const out = [];
  for (const row of db.prepare('SELECT id, name, status FROM characters WHERE work_id = ? AND TRIM(status) <> \'\' ORDER BY id ASC').all(w)) {
    out.push({
      source: { table: 'characters', key: String(row.id), field: 'status' },
      domain: 'character', entity_id: String(row.name || ''), predicate: 'status', scope: 'canon', holder_id: null,
      value: String(row.status || ''),
      note: '角色卡最新 status：生效时点未知（可能是中途状态），不得当作开篇状态',
    });
  }
  for (const row of db.prepare(`SELECT r.id, a.name AS from_name, b.name AS to_name, r.relation, r.description
      FROM character_relations r
      JOIN characters a ON a.id = r.from_character_id
      JOIN characters b ON b.id = r.to_character_id
      WHERE r.work_id = ? AND TRIM(r.relation) <> '' ORDER BY r.id ASC`).all(w)) {
    out.push({
      source: { table: 'character_relations', key: String(row.id), field: 'relation' },
      domain: 'relation', entity_id: String(row.from_name || '') + '|' + String(row.to_name || ''), predicate: 'relation', scope: 'canon', holder_id: null,
      value: String(row.relation || ''),
      detail: String(row.description || ''),
      note: '人物关系最新值：生效时点未知（关系可能中途变化）',
    });
  }
  for (const row of db.prepare(`SELECT id, subject, predicate, value, scope, effective_from, chapter_id
      FROM story_facts WHERE work_id = ? AND status = 'established' AND superseded_by IS NULL
        AND TRIM(subject) <> '' AND TRIM(predicate) <> '' ORDER BY id ASC`).all(w)) {
    const scopeRaw = String(row.scope || '');
    const scope = scopeRaw === 'CHARACTER_KNOWLEDGE' ? 'character' : 'canon';
    out.push({
      source: { table: 'story_facts', key: String(row.id), field: 'value' },
      domain: 'world_fact', entity_id: String(row.subject || ''), predicate: String(row.predicate || ''), scope, holder_id: null,
      value: String(row.value || ''),
      suggested_effective: Number(row.effective_from) > 0 ? { chapter_index: Number(row.effective_from) } : null,
      skip_reason: scope === 'character' ? 'character 知识需要持有者：先人工确认持有点' : '',
      note: '已确立事实：生效点是记录值（effective_from），不是"当前最新"',
    });
  }
  return out;
}

function candidateIdOf(workId, candidate) {
  return 'bst_' + sha16([workId, candidate.source.table, candidate.source.key, candidate.source.field, hashJson(candidate.value)].join('|'));
}

function candidateViewOf(binding) {
  const validation = binding.validation || {};
  const candidate = validation.bootstrap || {};
  return {
    // 内容键：与候选来源 + 值一一对应（幂等去重用）；candidate_id 是绑定 id（作者操作用）。
    candidate_key: candidate && candidate.source
      ? 'bst_' + sha16([binding.work_id, candidate.source.table, candidate.source.key, candidate.source.field, hashJson(candidate.value)].join('|'))
      : '',
    candidate_id: binding.id, work_id: binding.work_id, chapter_id: binding.chapter_id,
    status: String(validation.decision || (binding.validity === 'valid' ? 'confirmed' : binding.validity === 'rejected' ? 'rejected' : 'pending')),
    validity: binding.validity,
    domain: candidate.domain || '', entity_id: candidate.entity_id || '', predicate: candidate.predicate || '',
    value: candidate.value === undefined ? null : candidate.value,
    detail: candidate.detail || '',
    source: candidate.source || null,
    suggested_effective: candidate.suggested_effective || null,
    note: candidate.note || '', decided_at: validation.decided_at || null,
    event_ids: binding.event_ids || [],
  };
}

function requireBinding(id) {
  const b = getBinding(id);
  if (!b) throw new Error('BINDING_NOT_FOUND:' + id);
  return b;
}

/** 已有 bootstrap 候选（含已决定的历史；默认全部返回）。 */
export function listBootstrapCandidates({ workId } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('listBootstrapCandidates: 缺少 workId');
  const rows = db.prepare(`SELECT * FROM story_chapter_bindings
      WHERE work_id = ? AND contract_ref_json LIKE ? ORDER BY created_at ASC, id ASC`)
    .all(w, '%"kind":"' + BOOTSTRAP_KIND + '"%');
  return rows.map((row) => candidateViewOf(requireBinding(row.id)));
}
/**
 * 扫描旧字段 → 建立（幂等）待确认候选。已有同值的候选不会重复建；
 * 已确认 / 已拒绝的候选保留为审计记录。
 */
export function planBootstrapCandidates({ workId } = {}) {
  const w = Number(workId) || 0;
  if (!w) throw new Error('planBootstrapCandidates: 缺少 workId');
  if (!isTemporalEnabled(w)) return { ok: false, enabled: false, work_id: w, reason: '该作品未开启时态故事状态引擎' };
  const probe = schemaProbe();
  if (!probe.ok) return { ok: false, enabled: true, work_id: w, decision: 'blocked', reason: probe.note };
  const order = listOrder(w);
  const anchor = order.chapters.length ? Number(order.chapters[0]) : null;
  const anchorRevision = anchor ? latestRevisionOf(anchor) : null;
  const found = legacyCandidatesOf(w);
  const existing = new Map(listBootstrapCandidates({ workId: w }).map((c) => [c.candidate_key, c]));
  const created = [];
  const deferred = [];
  const skipped = [];
  const write = () => {
    for (const candidate of found) {
      const candidateKey = candidateIdOf(w, candidate);
      if (existing.has(candidateKey)) continue;
      if (candidate.skip_reason) { skipped.push({ source: candidate.source, reason: candidate.skip_reason }); continue; }
      if (!anchor || !anchorRevision) {
        deferred.push({ source: candidate.source, reason: anchor ? '第一章还没有冻结修订：先跑存量重建 step（冻结正文）再建候选' : '作品还没有章节：先导入正文' });
        continue;
      }
      const events = createEvents([{
        ops: [{ type: 'set', cell: { domain: candidate.domain, entityId: candidate.entity_id, predicate: candidate.predicate, scope: candidate.scope, holderId: candidate.holder_id }, expected: { kind: 'missing' }, value: candidate.value }],
        evidence: [{
          narrative: 'unknown', quote: '',
          note: 'legacy_field:' + candidate.source.table + '.' + candidate.source.field + '#' + candidate.source.key,
        }],
        cursor: { chapter_index: 0 },
        extractor: { name: 'legacy_field', version: '1', method: 'deterministic' },
      }], { workId: w, chapterId: anchor, revisionId: anchorRevision.id });
      const binding = createBinding({
        workId: w, chapterId: anchor, revisionId: anchorRevision.id, eventIds: events.map((e) => e.id), validity: 'pending',
        validation: {
          kind: BOOTSTRAP_KIND, decision: 'pending', created_at: now(),
          bootstrap: {
            domain: candidate.domain, entity_id: candidate.entity_id, predicate: candidate.predicate,
            value: candidate.value, detail: candidate.detail || '', source: candidate.source,
            suggested_effective: candidate.suggested_effective || null, note: candidate.note || '',
          },
          reason: '旧字段生效时点未知：需要作者确认"作为开篇设定"或指定生效章',
        },
        contractRef: { kind: BOOTSTRAP_KIND, source: 'legacy_scan', anchor_chapter_id: anchor, created_by: 'author' },
      });
      created.push(candidateViewOf(binding));
      existing.set(candidateKey, candidateViewOf(binding));
    }
  };
  if (inTransaction()) write(); else withTransaction(write);
  return {
    ok: true, enabled: true, work_id: w, anchor_chapter_id: anchor,
    found: found.length, created: created.length, deferred, skipped,
    candidates: listBootstrapCandidates({ workId: w }),
    note: '候选只是待确认记录（pending 绑定 + 未确认事件）：确认前不进入任何章的历史状态。',
  };
}
/**
 * 作者对候选做决定。
 *   decision='confirm' + effective='opening'（默认）→ 作为开篇设定写入提交清单 initial_binding_id。
 *   decision='confirm' + effective='chapter'  → 转成该章的待确认提案（走普通确认路径）。
 *   decision='reject'                          → 记录拒绝，不写任何状态。
 */
export function decideBootstrapCandidate({ workId, candidateId, decision = 'confirm', effective = 'opening', chapterId = null, note = '' } = {}) {
  const w = Number(workId) || 0;
  if (!w || !candidateId) throw new Error('decideBootstrapCandidate: 缺少 workId / candidateId');
  if (!isTemporalEnabled(w)) return { ok: false, enabled: false, work_id: w, reason: '该作品未开启时态故事状态引擎' };
  const binding = getBinding(candidateId);
  if (!binding || Number(binding.work_id) !== w) return { ok: false, enabled: true, decision: 'rejected', reason: '候选不存在或不属于该作品' };
  if (String((binding.contract_ref || {}).kind) !== BOOTSTRAP_KIND) return { ok: false, enabled: true, decision: 'rejected', reason: '该绑定不是 bootstrap 候选' };
  const run = () => {
    const current = candidateViewOf(binding);
    if (binding.validity !== 'pending') {
      if (binding.validity === 'valid' && decision === 'confirm') return { ok: true, enabled: true, decision: 'valid', reused: true, candidate: current };
      if (binding.validity === 'rejected' && decision === 'reject') return { ok: true, enabled: true, decision: 'rejected', reused: true, candidate: current };
      return { ok: false, enabled: true, decision: 'rejected', reason: '候选已 ' + binding.validity + '：不能重复决定' };
    }
    if (decision === 'reject') {
      const updated = setBindingValidity(binding.id, 'rejected', {
        validation: { ...(binding.validation || {}), decision: 'rejected', decided_at: now(), note: String(note || '') || '作者拒绝：不进入初始状态' },
      });
      return { ok: true, enabled: true, decision: 'rejected', candidate: candidateViewOf(updated), note: '已拒绝：没有写入任何状态。' };
    }
    const candidate = (binding.validation || {}).bootstrap || {};
    const order = listOrder(w);
    if (effective === 'chapter') {
      const targetChapter = Number(chapterId) || 0;
      const targetRoot = targetChapter ? rootChapterOf(order, targetChapter) : null;
      if (!targetRoot) return { ok: false, enabled: true, decision: 'blocked', reason: 'effective=chapter 需要给出作品内的有效 chapter_id' };
      const revision = latestRevisionOf(targetRoot);
      if (!revision) return { ok: false, enabled: true, decision: 'blocked', reason: '目标章还没有冻结修订：先跑该章的重建 step' };
      const pending = createBinding({
        workId: w, chapterId: targetRoot, revisionId: revision.id, eventIds: binding.event_ids, validity: 'pending',
        validation: {
          kind: 'proposal_group', decision: 'pending', revision_text_hash: revision.text_hash,
          pending_context: { ...((binding.validation || {}).pending_context || {}) },
          bootstrap: candidate, note: '由 bootstrap 候选转为该章待确认提案（作者仍需按序确认）',
        },
        contractRef: { kind: 'save_proposal', source: 'bootstrap_candidate', from_candidate_id: binding.id },
      });
      const refreshed = refreshPendingContext({ workId: w, chapterId: targetRoot, bindingId: pending.id });
      setBindingValidity(binding.id, 'superseded', {
        validation: { ...(binding.validation || {}), decision: 'converted', decided_at: now(), target_binding_id: pending.id, note: String(note || '') },
      });
      return {
        ok: true, enabled: true, decision: 'pending_chapter_confirmation', chapter_id: targetRoot,
        binding_id: pending.id, refreshed: !!refreshed.ok, candidate: candidateViewOf(requireBinding(binding.id)),
        note: '已转为该章待确认提案：用普通确认（proposal-groups apply / backfill confirm）按序确认。',
      };
    }
    // effective === 'opening'：写开篇设定（initial_binding_id）。已有开篇设定时合并（重新锚定到当前修订）。
    const anchor = order.chapters.length ? Number(order.chapters[0]) : null;
    if (!anchor) return { ok: false, enabled: true, decision: 'blocked', reason: '作品还没有章节：不能建立开篇设定' };
    const anchorRevision = latestRevisionOf(anchor);
    if (!anchorRevision) return { ok: false, enabled: true, decision: 'blocked', reason: '第一章还没有冻结修订：先跑存量重建 step' };
    const head = ensureMainCommit(w);
    const manifest = manifestOf(head);
    const prevInitial = manifest.initial_binding_id ? getBinding(manifest.initial_binding_id) : null;
    const carry = prevInitial ? eventsOfBinding(prevInitial) : [];
    const newEvents = eventsOfBinding(binding);
    const asRaw = (e, method) => ({
      ops: e.ops.map((op) => ({ type: op.type, cell: op.cell, expected: op.expected, value: op.value })),
      evidence: e.evidence, cursor: { chapter_index: 0 },
      extractor: { name: method, version: '1', method: 'deterministic' },
    });
    const raw = [
      ...carry.map((e) => asRaw(e, 'legacy_field')),
      ...newEvents.map((e) => asRaw(e, 'legacy_field')),
    ];
    const normEvents = createEvents(raw, { workId: w, chapterId: anchor, revisionId: anchorRevision.id });
    // 逐步归约：前置条件必须成立（expected=missing 只允许在尚未建立时生效）。
    let state = stateFromJson('{}');
    try {
      for (let i = 0; i < carry.length; i += 1) state = reduceBatch(state, [normEvents[i]]);
      for (let i = carry.length; i < normEvents.length; i += 1) state = reduceBatch(state, [normEvents[i]]);
    } catch (e) {
      return { ok: false, enabled: true, decision: 'conflict', reason: '开篇设定的前置条件不成立：' + e.message, candidate: current };
    }
    const orderVersion = ensureOrderVersion(w);
    const inputSnap = saveSnapshot({ workId: w, chapterId: anchor, orderVersionId: orderVersion.id, cursor: { chapter_index: 0, boundary: 'initial' }, state: stateFromJson('{}'), commitId: head ? head.id : '' });
    const outputSnap = saveSnapshot({ workId: w, chapterId: anchor, orderVersionId: orderVersion.id, cursor: { chapter_index: 0 }, state, commitId: head ? head.id : '', revisionIds: [anchorRevision.id], eventHashes: normEvents.map((e) => e.event_hash) });
    setBindingValidity(binding.id, 'valid', {
      outputSnapshotId: outputSnap.id,
      validation: {
        ...(binding.validation || {}), kind: BOOTSTRAP_KIND, decision: 'confirmed', decided_at: now(), effective: 'opening',
        input_state_hash: stateContentHash(stateFromJson('{}')), state_content_hash: stateContentHash(state), note: String(note || ''),
      },
      // 候选身份保持不变（kind 仍是 bootstrap_candidate），"已作为开篇设定应用"记在 applied_as。
      contractRef: { ...(binding.contract_ref || {}), kind: BOOTSTRAP_KIND, applied_as: 'initial_binding', confirmed_at: now() },
    });
    const { commit } = commitManifest({
      workId: w, worldlineId: ensureMainWorldline(w).id, parentCommitId: head ? head.id : null,
      orderVersionId: orderVersion.id, chapters: {}, initialBindingId: binding.id,
      note: 'bootstrap_initial:' + binding.id,
    });
    void inputSnap;
    // 兼容视图只从**已确认状态前缀**投影：整本可信时刷新，否则跳过并如实说明。
    const last = order.chapters.length ? Number(order.chapters[order.chapters.length - 1]) : anchor;
    const tail = stateAt({ workId: w, chapterId: last, boundary: 'after' });
    let compat = { skipped: 'prefix_not_trusted' };
    if (tail && tail.trusted === true && tail.ok !== false) {
      compat = refreshCompatProjection({ workId: w, state: tail.state, commitId: commit.id });
    }
    return {
      ok: true, enabled: true, decision: 'confirmed', effective: 'opening', commit_id: commit.id,
      candidate: candidateViewOf(requireBinding(binding.id)), compat,
      note: '已作为开篇设定写入：第 1 章章前状态起可见（引擎不设"第 0 章"槽位，开篇 = 第一章章前）。',
    };
  };
  return inTransaction() ? run() : withTransaction(run);
}

/** 内部辅助导出（测试 / 只读检查用）。 */
export const __internal = { chapterBackfillState, legacyCandidatesOf, candidateIdOf, POST_HOC_NOTE, BOOTSTRAP_KIND };
