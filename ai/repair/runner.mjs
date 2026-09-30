/**
 * ai/repair/runner.mjs —— T4「按钮驱动的逐章候选重建」运行器（持久状态机）。
 *
 * 产品语义（任务书 §8 / 方案 §9）：
 *   · 启动必须消费一次性作者审批 `repair_run_start`（绑定根章节 / 基线提交 / 目标范围哈希），
 *     消费后形成**仅对该 run 有效**的持久授权；最终正式应用再取一次 `repair_run_apply`。
 *   · 逐章串行：每章先复核原正文；原文仍成立 → 保留同一 revision，只新增验证来源绑定；
 *     已证实冲突 → 生成最小修订候选（生成 → 根锁 → 抽取事件 → 前置条件 → 语义复核），
 *     有界重试（默认每章 3 次）；无法判断/受上游阻塞 → 明确暂停并保留证据。
 *   · 候选只进 repair 工作线：中间步骤绝不写正式后文内容、绝不改正式角色状态；
 *     正式切换只在 apply 的**一个同步事务**里发生（正文 + main HEAD + 投影 + 审批 + outbox）。
 *   · 可恢复：步骤断点持久化；lease + fencing token；取消在模型调用前/响应后/提交前复查；
 *     恢复不重置已消耗预算（调用上限 / token 上限 / 截止时间）。
 *
 * 本模块是唯一执行逐章重建的地方；server.js 只做路由、审批创建与 hooks 注入。
 */
import { db, withTransaction } from '../../db.js';
import { htmlToPlain } from '../../text-utils.js';
import { canonicalJson, cellKey, sha16 } from '../story-state/temporal/schema.mjs';
import { assertTemporalSchema, isTemporalEnabled } from '../story-state/temporal/config.mjs';
import {
  ensureMainCommit, ensureMainWorldline, getCommit, commitManifest, manifestOf, getWorldline,
} from '../story-state/temporal/worldline-store.mjs';
import {
  createBinding, getBinding, eventsOfBinding, insertEvents, copyTrustOverlay, supersedePendingBindings,
} from '../story-state/temporal/event-store.mjs';
import { recordRevision, getRevision, latestRevisionOf, revisionPlainText } from '../story-state/temporal/revision-store.mjs';
import { stateAt } from '../story-state/temporal/history.mjs';
import { saveSnapshot } from '../story-state/temporal/snapshot.mjs';
import { validateEventSet } from '../story-state/temporal/validation.mjs';
import { dependenciesOfBinding, recordDependencies } from '../story-state/temporal/dependencies.mjs';
import { markDownstreamStale } from '../story-state/temporal/impact.mjs';
import { cursorOfChapter, ensureOrderVersion } from '../story-state/temporal/order.mjs';
import { buildExtractionPrompt, parseExtractionResponse, sanitizeText } from '../story-state/temporal/extraction.mjs';
import { refreshCompatProjection } from '../story-state/temporal/compat.mjs';
import { textOfModelOutput } from '../story-state/temporal/analysis.mjs';
import { sha16 as hash16 } from '../story-state/temporal/schema.mjs';
import { hashEvent, hashJson } from '../story-state/temporal/schema.mjs';
import * as Runs from './store.mjs';
import * as Approvals from '../story-state/approval.mjs';
import {
  buildRevalidationInput, changesOfBinding, changedEntityNames, generationProvenanceOf,
  parseImpactVerdict, ensureWorkingWorldline, downstreamCoverage, IMPACT_LIMITS,
} from './analyzer.mjs';

export const REPAIR_RUNNER_VERSION = '1.0.0';
/** 起始默认值（任务书 §8.3：每章最多 3 次修订、最多 3 次最终回扫——统一策略、可测试）。 */
export const REPAIR_POLICY_DEFAULTS = Object.freeze({
  max_attempts_per_chapter: 3,
  max_final_sweeps: 3,
  max_model_calls: 60,
  max_total_tokens: 200000,
  call_timeout_ms: 120000,
  deadline_ms: 30 * 60 * 1000,
});
export const REPAIR_LIMITS = Object.freeze({
  max_scope_chapters: 200,
  max_text_chars: IMPACT_LIMITS.max_text_chars,
  max_candidate_chars: 20000,
  min_candidate_ratio: 0.4,
  max_candidate_ratio: 2.5,
  max_candidate_artifact_chars: 4000,
  max_state_lines: IMPACT_LIMITS.max_state_lines,
});

const nowIso = () => new Date().toISOString();
const strOf = (v) => (v === null || v === undefined ? '' : String(v));

function normalizePolicy(input = {}) {
  const p = { ...REPAIR_POLICY_DEFAULTS, ...(input || {}) };
  const clampInt = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || d));
  return {
    max_attempts_per_chapter: clampInt(p.max_attempts_per_chapter, REPAIR_POLICY_DEFAULTS.max_attempts_per_chapter, 1, 10),
    max_final_sweeps: clampInt(p.max_final_sweeps, REPAIR_POLICY_DEFAULTS.max_final_sweeps, 1, 10),
    max_model_calls: clampInt(p.max_model_calls, REPAIR_POLICY_DEFAULTS.max_model_calls, 1, 100000),
    max_total_tokens: clampInt(p.max_total_tokens, REPAIR_POLICY_DEFAULTS.max_total_tokens, 1, 100000000),
    call_timeout_ms: clampInt(p.call_timeout_ms, REPAIR_POLICY_DEFAULTS.call_timeout_ms, 1000, 30 * 60 * 1000),
    deadline_ms: clampInt(p.deadline_ms, REPAIR_POLICY_DEFAULTS.deadline_ms, 1000, 24 * 60 * 60 * 1000),
  };
}

/** fencing 校验：旧 worker 的 token 已过期 → 抛 FENCED（调用方不得继续任何写入）。 */
export function assertFence({ runId, fencingToken }) {
  const run = Runs.getRun(runId);
  if (!run) {
    const err = new Error('运行不存在');
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  if (fencingToken !== null && fencingToken !== undefined && Number(fencingToken) !== Number(run.fencing_token)) {
    const err = new Error(`FENCED：worker 的 fencing token=${fencingToken} 已过期（当前 ${run.fencing_token}），旧 worker 不得再写入`);
    err.code = 'FENCED';
    throw err;
  }
  return run;
}

function chapterTitleOf(chapterId) {
  try {
    const row = db.prepare('SELECT title FROM chapters WHERE id = ?').get(Number(chapterId) || 0);
    return row ? String(row.title || '') : '';
  } catch {
    return '';
  }
}

function manifestHashOf(commit) {
  return commit ? String(commit.manifest_hash || '') : '';
}

/** 重建范围计划：根章之后的下游章节（可截取连续前缀作为作者确认范围）。 */
export function planRepair({ workId, rootChapterId, chapterIds = null, maxChapters = REPAIR_LIMITS.max_scope_chapters } = {}) {
  const w = Number(workId) || 0;
  const root = Number(rootChapterId) || 0;
  if (!w || !root) return { ok: false, reason: '缺少 work_id / root_chapter_id' };
  const schema = assertTemporalSchema();
  if (!schema.ok) return { ok: false, reason: `TEMPORAL_SCHEMA_MISSING:${(schema.missing || []).join(',')}` };
  if (!isTemporalEnabled(w)) return { ok: false, reason: '该作品未开启时态故事状态引擎（零写入）' };
  const head = ensureMainCommit(w);
  const manifestChapters = manifestOf(head).chapters;
  const rootBindingId = manifestChapters[String(root)] || null;
  const rootBinding = rootBindingId ? getBinding(rootBindingId) : null;
  const rootRevision = latestRevisionOf(root);
  const rootConfirmed = !!(rootBinding && rootBinding.validity === 'valid' && rootRevision && String(rootBinding.revision_id) === String(rootRevision.id));
  if (!rootConfirmed) {
    return { ok: false, reason: '根章节的最新正文尚未确认（缺少 valid 绑定）：先确认根事实，再启动重建', head_commit_id: head.id };
  }
  const cov = downstreamCoverage({ workId: w, rootChapterId: root, commitId: head.id, coverage: 'all_downstream', maxChapters });
  if (!cov.ok) return { ok: false, reason: cov.reason || '无法计算下游范围' };
  const all = cov.chapters.map(Number);
  if (!all.length) return { ok: false, reason: '根章节之后没有下游章节：没有需要重建的目标' };
  let chosen = all;
  if (Array.isArray(chapterIds) && chapterIds.length) {
    const wanted = [...new Set(chapterIds.map(Number).filter((n) => n > 0))];
    let k = 0;
    while (k < wanted.length && k < all.length && wanted[k] === all[k]) k += 1;
    if (k !== wanted.length || k === 0) {
      return { ok: false, reason: '目标章清单必须是下游章节的连续前缀：状态沿叙事顺序流动，不能跳过中间章节' };
    }
    chosen = all.slice(0, k);
  }
  // 目标章必须已有**可回退的确认绑定与正文修订**：应用/撤销都要求基线可恢复（否则只能确认，不能重建）。
  const chapterIssues = [];
  for (const chapterId of chosen) {
    const bindingId = manifestChapters[String(chapterId)] || null;
    const binding = bindingId ? getBinding(bindingId) : null;
    const revision = binding ? getRevision(binding.revision_id) : null;
    const latest = latestRevisionOf(chapterId);
    if (!binding || binding.validity !== 'valid' || !revision) {
      chapterIssues.push({ chapter_id: chapterId, reason: 'no_valid_binding', detail: '该章还没有已确认的正文状态绑定' });
    } else if (latest && String(latest.id) !== String(revision.id)) {
      chapterIssues.push({ chapter_id: chapterId, reason: 'unconfirmed_newer_revision', detail: '存在未确认的新正文修订 ' + latest.id });
    }
  }
  const startable = chapterIssues.length === 0;
  const startableReason = startable ? '' : '以下章节还不能进入重建：' + chapterIssues.map((x) => '#' + x.chapter_id + '（' + x.reason + '）').join('，');
  if (!startable) {
    // 不可新启动，但仍返回范围计划：调用方先用幂等键复用既有运行（重复点击不得重复建运行）。
  }
  const changes = changesOfBinding(rootBinding);
  const scopeHash = sha16(canonicalJson({
    version: REPAIR_RUNNER_VERSION, work_id: w, root_chapter_id: root,
    base_commit_id: head.id, order_version_id: String(cov.order_version_id || ''),
    root_binding_id: rootBindingId, root_revision_id: String(rootRevision.id),
    chapters: chosen,
  }));
  return {
    ok: true, startable, reason: startableReason, chapter_issues: chapterIssues, work_id: w, root_chapter_id: root,
    base_commit_id: head.id, order_version_id: String(cov.order_version_id || ''),
    root_binding_id: rootBindingId, root_revision_id: String(rootRevision.id),
    changes, changed_entity_names: changedEntityNames(changes),
    all_chapters: all, chapters: chosen, scope_hash: scopeHash,
  };
}

/** 启动审批的范围/基线绑定（server 的审批创建端点用；客户端自报无效）。 */
export function repairStartBinding({ workId, rootChapterId, chapterIds = null } = {}) {
  const plan = planRepair({ workId, rootChapterId, chapterIds });
  if (!plan.ok) return plan;
  return {
    ok: true,
    baseline_hash: plan.scope_hash,
    binding: { root_chapter_id: plan.root_chapter_id, base_commit_id: plan.base_commit_id, scope_hash: plan.scope_hash },
    plan,
  };
}

/** 应用审批的候选清单绑定（server 的审批创建端点用）。 */
export function repairApplyBinding({ workId, runId } = {}) {
  const run = Runs.getRun(runId);
  if (!run || (Number(workId) || 0) !== Number(run.work_id)) return { ok: false, reason: '运行不存在或不属于该作品' };
  const workline = getWorldline(run.working_worldline_id);
  const candidateHeadId = workline ? workline.head_commit_id : null;
  if (!candidateHeadId) return { ok: false, reason: '运行还没有候选清单（尚未执行到 ready）' };
  const candidateHead = getCommit(candidateHeadId);
  const checkpoint = run.result && run.result.checkpoint ? run.result.checkpoint : {};
  return {
    ok: true,
    run_id: run.id, run_status: run.status,
    candidate_head_id: candidateHeadId,
    manifest_hash: manifestHashOf(candidateHead),
    ready: run.status === 'ready' && String(checkpoint.candidate_head_id || '') === String(candidateHeadId),
    baseline_hash: manifestHashOf(candidateHead),
    binding: { run_id: run.id, manifest_hash: manifestHashOf(candidateHead) },
  };
}

function baseReport({ run, plan }) {
  return {
    run_id: run.id, mode: 'repair', version: REPAIR_RUNNER_VERSION, at: nowIso(),
    work_id: Number(run.work_id), root_chapter_id: Number(run.root_chapter_id),
    scope_hash: String(plan.scope_hash || (run.baseline || {}).scope_hash || ''),
    base_commit_id: String(run.base_commit_id || ''),
    working_worldline_id: run.working_worldline_id || null,
    policy: run.policy || {},
    totals: { chapters: (run.coverage.chapters || []).length, kept: 0, repaired: 0, attempts: 0, needs_review: 0, blocked: 0, model_calls: 0, tokens: 0, sweeps: 0 },
    checkpoint: { last_chapter_id: null, output_commit_id: null, candidate_head_id: null, updated_at: nowIso() },
    halt: null,
    notes: [],
  };
}

/** 启动一次重建：消费 repair_run_start 审批（同一事务建运行），随后后台驱动。 */
export async function startRepairRun({
  workId, rootChapterId, approvalId, chapterIds = null,
  generate = null, provider = 'none', model = '', policy = {}, owner = 'repair-runner', hooks = null,
} = {}) {
  const w = Number(workId) || 0;
  const root = Number(rootChapterId) || 0;
  if (!w || !root) throw new Error('startRepairRun: 缺少 workId / rootChapterId');
  const plan = planRepair({ workId: w, rootChapterId: root, chapterIds });
  if (!plan.ok) return { ok: false, enabled: true, decision: 'rejected', reason: plan.reason, plan };
  // 幂等键与审批 id 无关：同一按钮重复点击（即使重新签发审批）复用同一运行（AC-22）。
  const key = `repair|${w}|${plan.scope_hash}`;
  const reusable = Runs.findReusableRun(w, key);
  if (reusable) return { ok: true, enabled: true, reused: true, run: reusable, plan, report: reusable.result };
  if (plan.startable === false) return { ok: false, enabled: true, decision: 'rejected', reason: plan.reason, plan };
  const pol = normalizePolicy(policy);
  let created = null;
  try {
    withTransaction(() => {
      const made = Runs.createRun({
        workId: w, mode: 'repair', rootChapterId: root, baseCommitId: plan.base_commit_id,
        baseline: {
          version: REPAIR_RUNNER_VERSION, scope_hash: plan.scope_hash,
          root_binding_id: plan.root_binding_id, root_revision_id: plan.root_revision_id,
          base_commit_id: plan.base_commit_id, order_version_id: plan.order_version_id,
          chapters: plan.chapters, changes: plan.changes,
        },
        policy: pol,
        authorization: { start_approval_id: strOf(approvalId), authorized_at: nowIso(), scope_hash: plan.scope_hash },
        coverage: {
          mode: 'button_repair', chapters: plan.chapters, all: plan.all_chapters,
          policy: '逐章串行：前章候选先入工作线，后一章输入从新前缀重建；本阶段不自动覆盖正式正文。',
        },
        idempotencyKey: key,
      });
      if (made.reused) { created = made.run; return; }
      created = made.run;
      const consumed = Approvals.consumeApproval(strOf(approvalId), {
        op: 'repair_run_start', workId: w, baselineHash: plan.scope_hash,
        binding: { root_chapter_id: root, base_commit_id: plan.base_commit_id, scope_hash: plan.scope_hash },
        by: 'author',
      });
      if (!consumed.ok) {
        const err = new Error(consumed.reason || '审批消费失败');
        err.approvalVerdict = consumed;
        throw err;
      }
      const workline = ensureWorkingWorldline({ workId: w, runId: created.id, baseCommitId: plan.base_commit_id });
      const report = baseReport({ run: { ...created, working_worldline_id: workline.id, coverage: { chapters: plan.chapters } }, plan });
      Runs.updateRun(created.id, { workingWorldlineId: workline.id, status: 'running', result: report });
    });
  } catch (e) {
    if (e && e.approvalVerdict) {
      return { ok: false, enabled: true, decision: 'rejected', reason: `审批消费失败：${e.approvalVerdict.reason || ''}`, code: e.approvalVerdict.code, plan };
    }
    throw e;
  }
  const run = Runs.getRun(created.id);
  if (run.status !== 'running') return { ok: true, enabled: true, reused: true, run, plan };
  const driving = driveRepairRun({ runId: run.id, owner, generate, provider, model, hooks });
  // 后台驱动：不 await；失败不回滚已消费的启动授权（运行留存，可 resume / cancel）。
  if (driving && typeof driving.catch === 'function') {
    driving.catch((e) => {
      try {
        const current = Runs.getRun(run.id);
        Runs.updateRun(run.id, { status: 'failed', result: { ...(current.result || {}), halt: { status: 'failed', reason: sanitizeText(String((e && e.message) || e), 300), at: nowIso() } } });
        Runs.releaseLease(run.id);
      } catch { /* 已无法记录：保留原状态 */ }
    });
  }
  return { ok: true, enabled: true, reused: false, run, plan, approval: { id: strOf(approvalId) } };
}

function haltRun({ run, report, status, reason, chapterId = null }) {
  report.halt = { status, reason: sanitizeText(String(reason || ''), 300), chapter_id: chapterId ? Number(chapterId) : null, at: nowIso() };
  report.notes.push(`暂停/停止：${report.halt.reason}`);
  Runs.updateRun(run.id, { status, result: report });
  Runs.releaseLease(run.id);
  return Runs.getRun(run.id);
}

/** 预算 / 取消 / fence / 主线基线 的统一检查（模型调用前、响应后、提交前复用）。 */
function guardCheck(ctx) {
  try {
    assertFence({ runId: ctx.run.id, fencingToken: ctx.fencingToken });
  } catch (e) {
    return { status: 'paused', fenced: e.code === 'FENCED', reason: e.code === 'FENCED' ? String(e.message) : `运行不可用：${String(e.message || e)}` };
  }
  const current = Runs.getRun(ctx.run.id);
  if (!current) return { status: 'paused', reason: '运行记录丢失' };
  if (current.status === 'cancelled') return { status: 'cancelled', reason: '作者已取消本次重建' };
  if (current.status !== 'running' && current.status !== 'queued') {
    return { status: String(current.status), reason: `运行状态已变为 ${current.status}：停止驱动` };
  }
  const mainHead = ensureMainCommit(ctx.workId);
  if (String(mainHead.id) !== String(ctx.run.base_commit_id)) {
    return { status: 'stale', reason: '正式主线已前进（确认/更正/应用了其它变更）：候选基线过期，请基于最新基线重新发起' };
  }
  if (ctx.counters.model_calls >= ctx.policy.max_model_calls) {
    return { status: 'paused', reason: `模型调用已达上限（${ctx.policy.max_model_calls}）：恢复不会重置已消耗预算，需要作者显式扩展额度` };
  }
  if (ctx.counters.tokens >= ctx.policy.max_total_tokens) {
    return { status: 'paused', reason: `token 用量已达上限（${ctx.policy.max_total_tokens}）` };
  }
  if (Date.now() > ctx.deadlineAt) {
    return { status: 'paused', reason: '已到运行截止时间：候选保留，可由作者扩展后恢复' };
  }
  return null;
}

/** 受控模型调用：预算/取消/fence 检查 + 超时 + 用量记账（恢复不重置）。 */
async function callModel(ctx, purpose, prompt) {
  const guard = guardCheck(ctx);
  if (guard) return { ok: false, halt: guard };
  if (typeof ctx.generate !== 'function') {
    return { ok: false, error: 'NO_MODEL_ADAPTER', detail: '没有可用的模型适配器' };
  }
  ctx.counters.model_calls += 1;
  const started = Date.now();
  try {
    const raw = await Promise.race([
      Promise.resolve(ctx.generate({
        system: prompt.system, user: prompt.user, model: ctx.model, purpose,
        work_id: ctx.workId, chapter_id: prompt.chapter_id || (prompt.meta && prompt.meta.chapter_id) || null, run_id: ctx.run.id,
      })),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`MODEL_TIMEOUT（${ctx.policy.call_timeout_ms}ms）`)), ctx.policy.call_timeout_ms);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    const usage = raw && typeof raw === 'object' && raw.usage ? raw.usage : null;
    if (usage) ctx.counters.tokens += Number(usage.total_tokens || 0) || 0;
    const after = guardCheck(ctx);
    if (after) return { ok: false, halt: after, ms: Date.now() - started };
    return { ok: true, text: textOfModelOutput(raw), ms: Date.now() - started, provider: (raw && raw.provider) || ctx.provider, model: (raw && raw.model) || ctx.model };
  } catch (e) {
    return { ok: false, error: 'PROVIDER_CALL_FAILED', detail: sanitizeText(String((e && e.message) || e), 300), ms: Date.now() - started };
  }
}

/** 候选修订的预览（不落库；全部校验通过后才记录正式修订行）。 */
function previewRevision({ workId, chapterId, html, run, attempt, provider, model }) {
  const contentHash = sha16(String(html || ''));
  const id = 'rev_' + sha16(`${workId}|${chapterId}|${contentHash}`);
  const plain = String(htmlToPlain(String(html || ''))).replace(/\r\n/g, '\n').trim();
  return {
    id, work_id: Number(workId), chapter_id: Number(chapterId),
    content_html: String(html), content_hash: contentHash, text_hash: sha16(plain),
    origin_json: JSON.stringify({
      kind: 'repair', actor: 'repair_runner', source: `repair:${run.id}`,
      extra: { generation: { kind: 'recorded', source: 'repair_runner', provider: String(provider || ''), model: String(model || ''), run_id: run.id, attempt, at: nowIso() } },
    }),
    created_at: nowIso(),
  };
}

/** 修复提示词：最小修订、不得撤销根变更、保持其余成立内容。 */
function buildRepairPrompt({ workId, chapterId, chapterTitle, plainText, prefixView, changes, conflicts, constraints, model, attempt, maxAttempts }) {
  const stateLines = [];
  if (prefixView && prefixView.state instanceof Map) {
    for (const [key, value] of prefixView.state.entries()) {
      let label = String(key);
      try {
        const cell = JSON.parse(key);
        if (Array.isArray(cell)) label = `${cell[0]}|${cell[1]}|${cell[2]}|${cell[3]}${cell[4] == null ? '' : '|' + cell[4]}`;
      } catch { /* 保留原键 */ }
      stateLines.push(`${label} = ${canonicalJson(value)}`);
      if (stateLines.length >= REPAIR_LIMITS.max_state_lines) break;
    }
  }
  const changeLines = (changes || []).map((ch) => {
    let label = String(ch.resource_key);
    try {
      const cell = JSON.parse(ch.resource_key);
      if (Array.isArray(cell)) label = `${cell[0]}|${cell[1]}|${cell[2]}`;
    } catch { /* 保留原键 */ }
    return `- ${label}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}（已确认，不得撤销）`;
  });
  const conflictLines = (conflicts || []).map((c) => `- [${c.kind || 'conflict'}] ${c.premise || ''}${c.quote ? `（原句：${c.quote}）` : ''}`);
  const constraintLines = (constraints || []).slice(0, 30).map((c) => `- ${c.kind || 'rule'}：${c.pattern || ''}`);
  const system = [
    '你是长篇小说的连续性修订器：只输出 JSON，不要解释、不要 Markdown 代码块。',
    '任务：对给定章节做**最小必要修订**，使其在新世界线下成立；不得改写仍然成立的内容，不得引入新角色/新事件。',
    '硬约束：',
    '1) 已确认的根变更不得撤销（例如：确认过的死亡不能改回存活）；',
    '2) 只修冲突涉及处，其余段落保持原样（措辞尽量不变）；',
    '3) 不得引用章节原文之外才成立的信息（未来章节事实）；',
    '4) 输出完整修订后正文的纯文本（段落之间空一行），不是 diff、不是说明。',
    '严格输出：{"revised_text":"<修订后的整章纯文本>"}',
  ].join('\n');
  const user = [
    `作品 #${workId}，第 ${chapterId} 章《${chapterTitle || ''}》${model ? `（模型 ${model}）` : ''}，第 ${attempt}/${maxAttempts} 次修订尝试。`,
    '',
    '【根变更（已确认的新事实，绝对不得撤销）】',
    changeLines.length ? changeLines.join('\n') : '（无显式变化记录）',
    '',
    '【章前最新状态（截至本章；不得使用未来章节事实）】',
    stateLines.length ? stateLines.join('\n') : '（空）',
    '',
    '【已证实的冲突】',
    conflictLines.length ? conflictLines.join('\n') : '（未附冲突明细：请自行核对正文与状态）',
    constraintLines.length ? `作者约束：\n${constraintLines.join('\n')}` : '',
    '',
    '【本章正文（原文，需最小修订）】',
    sanitizeText(plainText, REPAIR_LIMITS.max_text_chars),
    '',
    '请输出 JSON。',
  ].filter((x) => x !== '').join('\n');
  return { system, user, chapter_id: Number(chapterId) || 0, attempt, max_attempts: maxAttempts };
}

/** 解析修复输出（严格 JSON；必须有非空 revised_text）。 */
export function parseRepairOutput(raw) {
  const text = textOfModelOutput(raw).slice(0, REPAIR_LIMITS.max_text_chars * 2);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let data = null;
  try {
    data = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } catch {
    return { ok: false, reason: 'MODEL_OUTPUT_INVALID_JSON' };
  }
  const revised = data && typeof data.revised_text === 'string' ? data.revised_text.trim() : '';
  if (!revised) return { ok: false, reason: 'REVISED_TEXT_MISSING' };
  return { ok: true, text: revised };
}

/** 纯文本 → 本应用正文 HTML（段落 = 空行分隔；只做转义，不做样式）。 */
export function textToChapterHtml(plain) {
  const blocks = String(plain || '').replace(/\r\n/g, '\n').split(/\n{2,}/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean).join('\n'))
    .filter(Boolean);
  if (!blocks.length) return '';
  return blocks.map((block) => `<p>${block.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('\n');
}

/** 根锁：候选事件不得把已确认的根变更改回旧值。 */
export function checkRootLock({ changes = [], events = [] } = {}) {
  const roots = new Map();
  for (const ch of changes || []) {
    if (!ch || !ch.resource_key) continue;
    roots.set(String(ch.resource_key), { from: ch.from, to: ch.to });
  }
  const violations = [];
  for (const event of events || []) {
    for (const op of event.ops || []) {
      let key = op._key;
      if (!key) { try { key = cellKey(op.cell); } catch { continue; } }
      const root = roots.get(String(key));
      if (!root) continue;
      const attempted = op.type === 'unset' ? 'missing' : op.value;
      if (canonicalJson(attempted) === canonicalJson(root.from)) {
        violations.push({ cell: String(key), reason: 'candidate_reverts_root_change', old_value: root.from, attempted });
      }
    }
  }
  return violations;
}

/** 稳定的事件 id（与 event-store.insertEvents 同口径；用于校验而不落库）。 */
function eventIdOf(event, { workId, chapterId, revisionId }) {
  const eventHash = hashEvent(event);
  return 'evt_' + hash16(`${Number(workId) || 0}|${Number(chapterId) || 0}|${String(revisionId)}|${hashJson(event.ops.map((op) => ({ type: op.type, cell: op.cell, expected: op.expected, value: op.value ?? null })))}|${eventHash}`);
}

function authorConstraintsOf(workId) {
  try {
    const rows = db.prepare(`SELECT kind, pattern FROM writing_redlines WHERE work_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 30`)
      .all(Number(workId) || 0);
    return (rows || []).map((r) => ({ kind: String(r.kind || ''), pattern: sanitizeText(String(r.pattern || ''), 200) }));
  } catch {
    return [];
  }
}
// ── 逐章处理（工作线内推进；中间步骤不碰正式正文/正式状态）─────────────────────

/** 章节当前最新步骤快照（恢复用；同章多条时取最后一条）。 */
function latestStepsOf(runId) {
  const map = new Map();
  for (const step of Runs.listSteps(runId)) map.set(Number(step.chapter_id), step);
  return map;
}

function stateJsonOf(prefixView) {
  const out = {};
  if (prefixView && prefixView.state instanceof Map) {
    for (const [key, value] of prefixView.state.entries()) out[key] = value;
  }
  return out;
}

/** 出场角色（与 service.appearancesOfEvents 同口径：character 域实体名）。 */
function appearancesOfEvents(events = []) {
  const names = new Set();
  for (const event of events || []) {
    for (const op of event.ops || []) {
      const cell = op.cell || {};
      if (String(cell.domain) !== 'character') continue;
      const name = String(cell.entityId || '').trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** 事件触及的 cell（失效计划用）。 */
function cellsOfEvents(events = []) {
  const cells = [];
  for (const event of events || []) {
    for (const op of event.ops || []) {
      let key = op._key;
      if (!key) { try { key = cellKey(op.cell); } catch { continue; } }
      if (key) cells.push(String(key));
    }
  }
  return [...new Set(cells)];
}

/** 章前状态哈希（最终回扫的漂移检测用；不注入模型、不读取未来章节）。 */
function prefixHashAt({ workId, chapterId, commitId }) {
  try {
    const view = stateAt({ workId, chapterId, boundary: 'before', commitId });
    return { ok: !!(view && view.ok !== false), hash: String((view && view.state_content_hash) || ''), trusted: !!(view && view.trusted) };
  } catch (e) {
    return { ok: false, hash: '', trusted: false, error: sanitizeText(String((e && e.message) || e), 200) };
  }
}

/** 运行策略 + 作者显式扩展（恢复不重置已消耗预算，只能追加）。 */
function effectivePolicy(run) {
  const base = normalizePolicy(run.policy || {});
  const exts = Array.isArray((run.authorization || {}).extensions) ? run.authorization.extensions : [];
  let calls = 0;
  let tokens = 0;
  let seconds = 0;
  for (const e of exts) {
    calls += Math.max(0, Number(e && e.calls) || 0);
    tokens += Math.max(0, Number(e && e.tokens) || 0);
    seconds += Math.max(0, Number(e && e.seconds) || 0);
  }
  return {
    ...base,
    max_model_calls: base.max_model_calls + calls,
    max_total_tokens: base.max_total_tokens + tokens,
    deadline_ms: base.deadline_ms + seconds * 1000,
  };
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = String(code);
  return err;
}

/**
 * 单章复核：确定性前置条件（既有事件集能否归约）+ 注入式语义复核（隐性因果）。
 * 与 T3 分析器同口径；只读，不改写任何正文或正式状态。
 * @returns {Promise<{ok:true,decision:'valid'|'conflict'|'needs_review'|'blocked',...}|{ok:false,halt:object}>}
 */
async function verifyChapter(ctx, { chapterId, workingHeadId }) {
  const workId = ctx.workId;
  const title = chapterTitleOf(chapterId);
  const headCommit = getCommit(workingHeadId);
  if (!headCommit) return { ok: false, decision: 'blocked', reason: '工作线提交不存在（运行记录与工作线不一致）' };
  const bindingId = manifestOf(headCommit).chapters[String(Number(chapterId))] || null;
  const binding = bindingId ? getBinding(bindingId) : null;
  const revision = binding ? getRevision(binding.revision_id) : null;
  if (!binding || !revision) {
    return { ok: true, decision: 'blocked', reason: '该章还没有已确认的正文修订：先保存并确认正文，再重建', binding_id: bindingId, revision_id: null };
  }
  const latest = latestRevisionOf(chapterId);
  if (latest && String(latest.id) !== String(revision.id)) {
    return { ok: true, decision: 'blocked', reason: `该章存在未确认的新正文修订（${latest.id}）：先确认或回退，再启动重建`, binding_id: binding.id, revision_id: revision.id };
  }
  const plainText = revisionPlainText(revision);
  // ── 章前状态：只从工作线 head 归约（前章候选已经入线；绝不读取未来章节）──
  let prefixView = null;
  let prefixError = '';
  try {
    const view = stateAt({ workId, chapterId, boundary: 'before', commitId: workingHeadId });
    if (view && view.state instanceof Map) {
      prefixView = {
        commit_id: workingHeadId, state: view.state,
        state_content_hash: view.state_content_hash || '', trusted: !!view.trusted,
        stop: view.stop || null, rows: Array.isArray(view.chapters) ? view.chapters : [],
      };
    } else if (view && view.ok === false) {
      prefixError = sanitizeText(String(view.reason || '章前状态不可用'), 200);
    }
  } catch (e) {
    prefixError = sanitizeText(String((e && e.message) || e), 200);
  }
  const prefixBroken = !prefixView || !prefixView.trusted;
  const blockedByPrefix = prefixBroken || !!prefixError;
  const deps = bindingId ? dependenciesOfBinding(bindingId) : [];
  const explicitHits = deps.filter((d) => ctx.changedResources.has(String(d.resource_key)));
  const appearanceNames = ctx.changedNames.filter((name) => plainText.includes(name));
  // ── 确定性检查：既有事件集在新章前状态下是否仍可归约 ──
  let det = null;
  let detError = '';
  let events = [];
  try {
    events = (binding.event_ids || []).length ? eventsOfBinding(binding) : [];
    if (events.length && prefixView && prefixView.trusted) {
      det = validateEventSet({ workId, chapterId, revision, events, inputState: prefixView.state, upstreamTrusted: true });
    }
  } catch (e) {
    detError = sanitizeText(String((e && e.message) || e), 200);
  }
  // ── 语义复核（注入式；本模块不生成正文）──
  let verdict = null;
  const providerIssues = [];
  if (!blockedByPrefix) {
    if (typeof ctx.generate === 'function') {
      const prompt = buildRevalidationInput({
        workId, runId: ctx.run.id, chapterId, chapterTitle: title, revision, plainText, binding,
        prefixView, changes: ctx.changes, deps, explicitHits, appearanceNames, constraints: ctx.constraints, model: ctx.model,
      });
      const call = await callModel(ctx, 'repair_verify', prompt);
      if (call.halt) return { ok: false, halt: call.halt };
      if (!call.ok) providerIssues.push({ code: call.error, message: call.detail });
      else {
        verdict = parseImpactVerdict(call.text);
        if (verdict && verdict.ok === false) providerIssues.push(...(verdict.issues || []));
      }
    } else {
      providerIssues.push({ code: 'NO_MODEL_ADAPTER', message: '没有可用的模型适配器：无法语义复核（如实标 needs_review，不冒充通过）' });
    }
  }
  const detConflicts = det ? (det.conflicts || []) : [];
  const modelConflicts = verdict && verdict.ok ? verdict.conflicts : [];
  const modelDecision = verdict && verdict.ok ? verdict.decision : null;
  let decision;
  if (blockedByPrefix) decision = 'blocked';
  else if (detConflicts.length || modelDecision === 'conflict') decision = 'conflict';
  else if (detError || (det && det.decision !== 'valid') || !(verdict && verdict.ok && modelDecision === 'valid')) decision = 'needs_review';
  else decision = 'valid';
  return {
    ok: true, decision, chapter_id: Number(chapterId), chapter_title: title,
    binding, binding_id: binding.id, revision, revision_id: revision.id, plain_text: plainText,
    prefix_view: prefixView || { commit_id: workingHeadId, state: new Map(), state_content_hash: '', trusted: false, stop: null, rows: [] },
    prefix_error: prefixError,
    deterministic: det, deterministic_error: detError,
    verdict, provider_issues: providerIssues,
    explicit_hits: explicitHits, appearance_names: appearanceNames, deps,
    conflicts: [...detConflicts, ...modelConflicts],
  };
}
/** 原文成立：保留同一 revision，只新增验证来源绑定（候选只进工作线）。 */
function commitKeptChapter(ctx, { chapterId, v, workingHeadId, stepId }) {
  const workId = ctx.workId;
  const run = ctx.run;
  let out = null;
  withTransaction(() => {
    const pre = guardCheck(ctx);
    if (pre) { out = { guard: pre }; return; }
    const orderVersion = ensureOrderVersion(workId);
    const cursor = cursorOfChapter(workId, chapterId);
    const beforeSnap = saveSnapshot({
      workId, chapterId, orderVersionId: orderVersion.id,
      cursor: { chapter_index: cursor.chapter_index, scene_index: cursor.scene_index, boundary: 'before' },
      state: v.prefix_view.state, commitId: workingHeadId,
    });
    const outputState = v.deterministic && v.deterministic.output_state instanceof Map ? v.deterministic.output_state : v.prefix_view.state;
    const outSnap = saveSnapshot({
      workId, chapterId, orderVersionId: orderVersion.id, cursor,
      state: outputState, commitId: workingHeadId,
      revisionIds: [v.revision.id], eventHashes: (v.binding.event_ids || []).map(String),
    });
    const binding = createBinding({
      workId, chapterId, revisionId: v.revision.id, eventIds: v.binding.event_ids || [], validity: 'valid',
      inputSnapshotId: beforeSnap.id, outputSnapshotId: outSnap.id,
      validation: {
        decision: 'valid',
        repair_keep: {
          source: 'repair_runner', version: REPAIR_RUNNER_VERSION, run_id: run.id, at: nowIso(),
          base_binding_id: v.binding.id, base_revision_id: v.revision.id,
          input: {
            commit_id: workingHeadId, state_content_hash: v.prefix_view.state_content_hash || '',
            order_version_id: orderVersion.id, upstream_trusted: !!v.prefix_view.trusted,
          },
          output_state_content_hash: outSnap.state_content_hash,
          checked: v.verdict && v.verdict.ok ? v.verdict.checked : [],
          provider_issues: v.provider_issues || [],
          note: '重建复核：正文在新世界线下仍然成立 → 保留原文，只新增验证来源（T4 不重写）。',
        },
        generation_provenance: generationProvenanceOf(v.revision),
        assumptions: (v.binding.validation && v.binding.validation.assumptions) || [],
      },
      appearances: v.binding.appearances || [],
      contractRef: { ...(v.binding.contract_ref || {}), kind: 'repair_keep', run_id: run.id, base_binding_id: v.binding.id },
    });
    const { commit } = commitManifest({
      workId, worldlineId: run.working_worldline_id, parentCommitId: workingHeadId,
      orderVersionId: orderVersion.id, chapters: { [String(chapterId)]: binding.id },
      note: `repair_keep:${run.id}:${chapterId}`, expectedHead: workingHeadId,
    });
    copyTrustOverlay({ workId, fromCommitId: workingHeadId, toCommitId: commit.id, exceptBindingIds: [binding.id] });
    markDownstreamStale({ workId, fromChapterId: chapterId, commitId: commit.id, reason: 'repair_keep:upstream_verified' });
    const stepResult = {
      chapter_id: Number(chapterId), status: 'kept', decision: 'valid',
      base_binding_id: v.binding.id, base_revision_id: v.revision.id,
      revision_id: v.revision.id, candidate_binding_id: binding.id,
      candidate_commit_id: commit.id, kept: true, repaired: false,
      input_state_content_hash: v.prefix_view.state_content_hash || '',
      output_state_content_hash: outSnap.state_content_hash,
      revision_unchanged: String((latestRevisionOf(chapterId) || {}).id || '') === String(v.revision.id),
      provider_issues: v.provider_issues || [],
      note: '原文保留：未改写任何正文。',
    };
    const step = Runs.updateStep(stepId, { status: 'kept', candidateRevisionId: v.revision.id, candidateBindingId: binding.id, result: stepResult });
    out = { commit_id: commit.id, binding, step };
  });
  if (out && out.guard) return { status: 'halt', halt: out.guard, workingHeadId };
  return { status: 'kept', commit_id: out.commit_id, revision_id: v.revision.id, binding_id: out.binding.id, step: out.step, workingHeadId: out.commit_id };
}

/** 修订候选通过全部校验后落工作线（单事务：修订 + 事件 + 快照 + 绑定 + 提交 + 依赖 + 断点）。 */
function landRepair(ctx, { chapterId, candidate, workingHeadId, stepId, attempt }) {
  const workId = ctx.workId;
  const run = ctx.run;
  let out = null;
  withTransaction(() => {
    const pre = guardCheck(ctx);
    if (pre) { out = { guard: pre }; return; }
    const { revision } = recordRevision({
      workId, chapterId, contentHtml: candidate.revision.content_html,
      origin: { kind: 'repair', actor: 'repair_runner', source: `repair:${run.id}`, extra: { generation: { kind: 'recorded', source: 'repair_runner', provider: ctx.provider, model: ctx.model, run_id: run.id, attempt } } },
    });
    if (String(revision.id) !== String(candidate.revision.id)) {
      throw codedError('REVISION_ID_MISMATCH', `记录的修订 id（${revision.id}）与候选预览不一致（${candidate.revision.id}）`);
    }
    const events = insertEvents(candidate.events.map((e) => ({ ...e, revision_id: revision.id })));
    const orderVersion = ensureOrderVersion(workId);
    const cursor = cursorOfChapter(workId, chapterId);
    const beforeSnap = saveSnapshot({
      workId, chapterId, orderVersionId: orderVersion.id,
      cursor: { chapter_index: cursor.chapter_index, scene_index: cursor.scene_index, boundary: 'before' },
      state: candidate.prefix_view.state, commitId: workingHeadId,
    });
    const outSnap = saveSnapshot({
      workId, chapterId, orderVersionId: orderVersion.id, cursor,
      state: candidate.deterministic.output_state, commitId: workingHeadId,
      revisionIds: [revision.id], eventHashes: events.map((e) => e.event_hash),
    });
    const binding = createBinding({
      workId, chapterId, revisionId: revision.id, eventIds: events.map((e) => e.id), validity: 'valid',
      inputSnapshotId: beforeSnap.id, outputSnapshotId: outSnap.id,
      validation: {
        decision: 'valid',
        repair: {
          source: 'repair_runner', version: REPAIR_RUNNER_VERSION, run_id: run.id, at: nowIso(),
          attempt: Number(attempt) || 1,
          base_binding_id: candidate.verdict_binding_id || null,
          input: {
            commit_id: workingHeadId, state_content_hash: candidate.prefix_view.state_content_hash || '',
            order_version_id: orderVersion.id, upstream_trusted: !!candidate.prefix_view.trusted,
          },
          output_state_content_hash: outSnap.state_content_hash,
          conflicts_repaired: candidate.conflicts || [],
          checked: candidate.verdict && candidate.verdict.ok ? candidate.verdict.checked : [],
          root_lock: candidate.root_lock || [],
          note: '重建修订：最小必要修订 + 根锁 + 事件前置条件 + 语义复核全部通过。',
        },
        generation_provenance: { status: 'recorded', kind: 'repair', source: 'repair_runner' },
        assumptions: (candidate.assumptions || []).slice(0, 40),
      },
      appearances: appearancesOfEvents(events),
      contractRef: {
        kind: 'repair_revision', run_id: run.id, base_binding_id: candidate.base_binding_id || null,
        revision_text_hash: revision.text_hash, state_content_hash: outSnap.state_content_hash,
      },
    });
    const { commit } = commitManifest({
      workId, worldlineId: run.working_worldline_id, parentCommitId: workingHeadId,
      orderVersionId: orderVersion.id, chapters: { [String(chapterId)]: binding.id },
      note: `repair_revision:${run.id}:${chapterId}:${binding.id}`, expectedHead: workingHeadId,
    });
    copyTrustOverlay({ workId, fromCommitId: workingHeadId, toCommitId: commit.id, exceptBindingIds: [binding.id] });
    markDownstreamStale({ workId, fromChapterId: chapterId, commitId: commit.id, reason: 'repair_revision:upstream_changed', changedCells: cellsOfEvents(events) });
    const deps = recordDependencies({ workId, bindingId: binding.id, events });
    const stepResult = {
      chapter_id: Number(chapterId), status: 'repaired', decision: 'valid',
      base_binding_id: candidate.base_binding_id || null, base_revision_id: candidate.base_revision_id || null,
      revision_id: revision.id, candidate_binding_id: binding.id, candidate_commit_id: commit.id,
      kept: false, repaired: true, attempt: Number(attempt) || 1,
      input_state_content_hash: candidate.prefix_view.state_content_hash || '',
      output_state_content_hash: outSnap.state_content_hash,
      revision_unchanged: String((latestRevisionOf(chapterId) || {}).id || '') === String(revision.id),
      conflicts_repaired: candidate.conflicts || [],
      dependencies: deps.slice(0, 40).map((d) => d.resource_key),
      extraction_issues: candidate.extraction_issues || [],
      note: '最小修订候选已进入工作线；正式正文不变，等待应用审批。',
    };
    const step = Runs.updateStep(stepId, { status: 'repaired', candidateRevisionId: revision.id, candidateBindingId: binding.id, result: stepResult });
    out = { commit_id: commit.id, binding, revision, step };
  });
  if (out && out.guard) return { guard: out.guard };
  return out;
}

/** 一次修订尝试：生成 → 边界 → 抽取 → 根锁 → 事件前置条件 → 语义复核。 */
async function attemptRepair(ctx, { chapterId, v, workingHeadId, attempt }) {
  const workId = ctx.workId;
  const run = ctx.run;
  const title = v.chapter_title;
  const maxAttempts = Math.max(1, ctx.policy.max_attempts_per_chapter);
  const gen = await callModel(ctx, 'repair_generate', buildRepairPrompt({
    workId, chapterId, chapterTitle: title, plainText: v.plain_text, prefixView: v.prefix_view,
    changes: ctx.changes, conflicts: v.conflicts, constraints: ctx.constraints, model: ctx.model,
    attempt, maxAttempts,
  }));
  if (gen.halt) return { halt: gen.halt };
  if (!gen.ok) return { ok: false, reason: gen.error, detail: gen.detail };
  const parsed = parseRepairOutput(gen.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const html = textToChapterHtml(parsed.text);
  const plain = String(htmlToPlain(html) || '').replace(/\r\n/g, '\n').trim();
  const originalLen = String(v.plain_text || '').length;
  const candidateLen = plain.length;
  if (!candidateLen) return { ok: false, reason: 'CANDIDATE_EMPTY' };
  if (candidateLen > REPAIR_LIMITS.max_candidate_chars) return { ok: false, reason: 'CANDIDATE_TOO_LONG', detail: `${candidateLen} > ${REPAIR_LIMITS.max_candidate_chars}` };
  if (originalLen && candidateLen < Math.floor(originalLen * REPAIR_LIMITS.min_candidate_ratio)) {
    return { ok: false, reason: 'CANDIDATE_TOO_SHORT', detail: `${candidateLen} < ${Math.floor(originalLen * REPAIR_LIMITS.min_candidate_ratio)}（原文 ${originalLen}）` };
  }
  if (originalLen && candidateLen > Math.ceil(originalLen * REPAIR_LIMITS.max_candidate_ratio)) {
    return { ok: false, reason: 'CANDIDATE_TOO_LONG', detail: `${candidateLen} > ${Math.ceil(originalLen * REPAIR_LIMITS.max_candidate_ratio)}（原文 ${originalLen}）` };
  }
  const revision = previewRevision({ workId, chapterId, html, run, attempt, provider: ctx.provider, model: ctx.model });
  const extractionPrompt = buildExtractionPrompt({
    chapterId, chapterTitle: title, revision, plainText: plain,
    stateBeforeJson: stateJsonOf(v.prefix_view), known: {},
    targetWords: Math.max(300, Math.min(4000, candidateLen)),
  });
  extractionPrompt.chapter_id = Number(chapterId) || 0;
  const ex = await callModel(ctx, 'repair_extract', extractionPrompt);
  if (ex.halt) return { halt: ex.halt };
  if (!ex.ok) return { ok: false, reason: ex.error, detail: ex.detail };
  const extracted = parseExtractionResponse(ex.text, { workId, chapterId, revisionId: revision.id, plainText: plain });
  if (!extracted.ok) return { ok: false, reason: 'EXTRACTION_FAILED', issues: extracted.issues };
  const events = extracted.events;
  // validateEventSet 与 insertEvents 同口径：先按「作品|章节|修订|ops|事件哈希」标出稳定 id（不落库），
  // 否则前置条件检查会把合法事件误判为 EVENT_ID_MISSING。
  for (const ev of events) ev.id = eventIdOf(ev, { workId, chapterId, revisionId: revision.id });
  const rootLock = checkRootLock({ changes: ctx.changes, events });
  if (rootLock.length) return { ok: false, reason: 'ROOT_LOCK_VIOLATION', violations: rootLock };
  let det = null;
  let detDetail = '';
  try {
    det = validateEventSet({ workId, chapterId, revision, events, inputState: v.prefix_view.state, upstreamTrusted: !!v.prefix_view.trusted });
  } catch (e) {
    detDetail = sanitizeText(String((e && e.message) || e), 200);
  }
  if (!det || det.decision !== 'valid') {
    return {
      ok: false, reason: 'PRECONDITION_FAILED',
      detail: detDetail || (det ? (det.conflicts || []).map((c) => c.code).join(',') : 'validateEventSet 不可用'),
      deterministic: det ? { decision: det.decision, conflicts: det.conflicts, unresolved: det.unresolved } : null,
    };
  }
  const verify = await callModel(ctx, 'repair_verify', buildRevalidationInput({
    workId, runId: run.id, chapterId, chapterTitle: title, revision, plainText: plain, binding: v.binding,
    prefixView: v.prefix_view, changes: ctx.changes, deps: v.deps, explicitHits: v.explicit_hits,
    appearanceNames: v.appearance_names, constraints: ctx.constraints, model: ctx.model,
  }));
  if (verify.halt) return { halt: verify.halt };
  if (!verify.ok) return { ok: false, reason: verify.error, detail: verify.detail };
  const verdict = parseImpactVerdict(verify.text);
  if (verdict.ok === false) return { ok: false, reason: 'VERDICT_INVALID', issues: verdict.issues };
  if (verdict.decision !== 'valid') {
    return { ok: false, reason: 'CANDIDATE_REJECTED_BY_REVIEW', conflicts: verdict.conflicts, verdict_decision: verdict.decision };
  }
  return {
    ok: true, revision, plain, events, assumptions: extracted.assumptions,
    deterministic: det, verdict, extraction_issues: extracted.issues,
    conflicts: v.conflicts, root_lock: rootLock,
    base_binding_id: v.binding.id, base_revision_id: v.revision.id,
    prefix_view: v.prefix_view, verdict_binding_id: v.binding.id,
  };
}
/** 有界重试（默认每章 3 次）；重复冲突指纹 → 停止，不空转烧预算。 */
async function repairChapter(ctx, { chapterId, v, workingHeadId, stepId }) {
  const maxAttempts = Math.max(1, ctx.policy.max_attempts_per_chapter);
  const attempts = [];
  const seen = new Set();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    Runs.updateStep(stepId, {
      status: 'repairing', attempt,
      result: { chapter_id: Number(chapterId), status: 'repairing', decision: 'conflict', attempt, max_attempts: maxAttempts, conflicts: v.conflicts },
    });
    const out = await attemptRepair(ctx, { chapterId, v, workingHeadId, attempt });
    if (out.halt) return { status: 'halt', halt: out.halt, workingHeadId };
    ctx.counters.attempts += 1;
    if (out.ok) {
      const landed = landRepair(ctx, { chapterId, candidate: out, workingHeadId, stepId, attempt });
      if (landed && landed.guard) return { status: 'halt', halt: landed.guard, workingHeadId };
      return { status: 'repaired', commit_id: landed.commit_id, revision_id: landed.revision.id, binding_id: landed.binding.id, step: landed.step, workingHeadId: landed.commit_id, attempts };
    }
    attempts.push({ attempt, reason: out.reason, detail: out.detail || '', issues: out.issues || null, conflicts: out.conflicts || null, violations: out.violations || null });
    const fingerprint = sha16(canonicalJson({ reason: out.reason, detail: out.detail || '', conflicts: (out.conflicts || []).map((c) => c.premise), violations: out.violations || [] }));
    if (seen.has(fingerprint)) {
      const step = Runs.updateStep(stepId, {
        status: 'needs_review', attempt,
        result: { chapter_id: Number(chapterId), status: 'needs_review', decision: 'conflict', attempt, attempts, reason: `重复冲突指纹（${out.reason}）：停止重试，留给作者复核`, revision_unchanged: true },
      });
      return { status: 'needs_review', reason: `第 ${chapterId} 章重复出现同一冲突（${out.reason}）：已停止重试`, step, workingHeadId, attempts };
    }
    seen.add(fingerprint);
  }
  const last = attempts[attempts.length - 1] || { reason: 'unknown' };
  const step = Runs.updateStep(stepId, {
    status: 'needs_review', attempt: maxAttempts,
    result: { chapter_id: Number(chapterId), status: 'needs_review', decision: 'conflict', attempt: maxAttempts, attempts, reason: `修订尝试 ${maxAttempts} 次仍未通过（最后原因：${last.reason}）`, revision_unchanged: true },
  });
  return { status: 'needs_review', reason: `第 ${chapterId} 章修订 ${maxAttempts} 次未收敛（最后：${last.reason}）`, step, workingHeadId, attempts };
}

/** 单章顺序推进：复核 → 保留 / 修订 / 暂停。返回下一次的工作线 head。 */
async function processChapter(ctx, { chapterId, workingHeadId }) {
  const step = Runs.addStep({
    runId: ctx.run.id, workId: ctx.workId, chapterId, stepKey: 'repair', status: 'validating',
    inputFingerprint: sha16(canonicalJson({ run: ctx.run.id, chapter: chapterId, head: workingHeadId })),
    result: { chapter_id: Number(chapterId), status: 'validating' },
  });
  const v = await verifyChapter(ctx, { chapterId, workingHeadId });
  if (v.ok === false && v.halt) return { status: 'halt', halt: v.halt, workingHeadId };
  if (v.decision === 'blocked') {
    const updated = Runs.updateStep(step.id, {
      status: 'blocked',
      result: {
        chapter_id: Number(chapterId), status: 'blocked', reason: v.reason,
        binding_id: v.binding_id || null, revision_id: v.revision_id || null,
        revision_unchanged: String((latestRevisionOf(chapterId) || {}).id || '') === String(v.revision_id || ''),
      },
    });
    return { status: 'blocked', reason: v.reason, step: updated, workingHeadId };
  }
  if (v.decision === 'valid') return commitKeptChapter(ctx, { chapterId, v, workingHeadId, stepId: step.id });
  if (v.decision === 'conflict') return repairChapter(ctx, { chapterId, v, workingHeadId, stepId: step.id });
  const updated = Runs.updateStep(step.id, {
    status: 'needs_review',
    result: {
      chapter_id: Number(chapterId), status: 'needs_review', decision: 'needs_review',
      reason: v.deterministic_error || '语义复核无法判定（不自动改写）',
      deterministic: v.deterministic ? { decision: v.deterministic.decision, unresolved: v.deterministic.unresolved } : null,
      provider_issues: v.provider_issues || [], conflicts: v.conflicts || [],
      revision_unchanged: String((latestRevisionOf(chapterId) || {}).id || '') === String(v.revision_id || ''),
    },
  });
  return { status: 'needs_review', reason: `第 ${chapterId} 章无法判定（needs_review）`, step: updated, workingHeadId };
}

/**
 * 最终覆盖扫查：逐章比较「记录的章前输入哈希」与当前工作线归约出的章前哈希。
 * 漂移章节按序重跑；直到无漂移或达到策略上限。
 */
async function finalSweep(ctx, { scope, workingHeadId }) {
  const report = ctx.report;
  const policy = ctx.policy;
  let head = workingHeadId;
  let drift = null;
  for (let sweep = 1; sweep <= policy.max_final_sweeps; sweep += 1) {
    const guard = guardCheck(ctx);
    if (guard) return { halt: guard, workingHeadId: head };
    const steps = latestStepsOf(ctx.run.id);
    const drifted = [];
    for (const chapterId of scope) {
      const step = steps.get(Number(chapterId));
      if (!step || !['kept', 'repaired'].includes(step.status)) {
        drifted.push({ chapter_id: Number(chapterId), reason: 'step_not_complete' });
        continue;
      }
      const recorded = String((step.result && step.result.input_state_content_hash) || '');
      const now = prefixHashAt({ workId: ctx.workId, chapterId, commitId: head });
      if (!recorded || !now.ok || !now.trusted || now.hash !== recorded) {
        drifted.push({ chapter_id: Number(chapterId), reason: 'input_state_drift', recorded, current: now.hash, trusted: now.trusted, error: now.error || '' });
      }
    }
    report.totals.sweeps = sweep;
    report.checkpoint.updated_at = nowIso();
    Runs.updateRun(ctx.run.id, { result: report });
    if (!drifted.length) return { workingHeadId: head, sweeps: sweep, drift: null };
    drift = drifted;
    if (sweep >= policy.max_final_sweeps) break;
    for (const item of drifted) {
      const g = guardCheck(ctx);
      if (g) return { halt: g, workingHeadId: head };
      const out = await processChapter(ctx, { chapterId: item.chapter_id, workingHeadId: head });
      if (out.status === 'halt') return { halt: out.halt, workingHeadId: head };
      if (out.status === 'blocked' || out.status === 'needs_review') {
        return { halt: { status: out.status === 'blocked' ? 'paused' : 'needs_review', reason: `最终回扫重跑第 ${item.chapter_id} 章失败：${out.reason}` }, workingHeadId: head };
      }
      head = out.commit_id;
      pushChapterEntry(ctx, { chapter_id: item.chapter_id, status: out.status, commit_id: out.commit_id, step_id: out.step ? out.step.id : null });
      Runs.updateRun(ctx.run.id, { result: report });
    }
  }
  return { workingHeadId: head, drift, sweeps: policy.max_final_sweeps };
}

/** 报告里的逐章条目：同章只保留最新一条（回扫重跑不重复计数）。 */
function pushChapterEntry(ctx, entry) {
  const report = ctx.report;
  if (!Array.isArray(report.downstream)) report.downstream = [];
  const index = report.downstream.findIndex((row) => Number(row.chapter_id) === Number(entry.chapter_id));
  if (index >= 0) report.downstream[index] = entry;
  else report.downstream.push(entry);
}
/** 汇总报告计数（以最新步骤为准；回扫重跑不重复计数）。 */
function syncTotals(ctx) {
  const steps = latestStepsOf(ctx.run.id);
  const scope = (ctx.run.coverage && Array.isArray(ctx.run.coverage.chapters) ? ctx.run.coverage.chapters : []).map(Number);
  let kept = 0;
  let repaired = 0;
  for (const chapterId of scope) {
    const step = steps.get(Number(chapterId));
    if (step && step.status === 'kept') kept += 1;
    else if (step && step.status === 'repaired') repaired += 1;
  }
  ctx.report.totals.chapters = scope.length;
  ctx.report.totals.kept = kept;
  ctx.report.totals.repaired = repaired;
  ctx.report.totals.model_calls = ctx.counters.model_calls;
  ctx.report.totals.tokens = ctx.counters.tokens;
  ctx.report.totals.attempts = ctx.counters.attempts;
  return ctx.report.totals;
}

/** 后台驱动：严格按叙事顺序逐章；第 N 章候选先入工作线，第 N+1 章的输入从新前缀重建。 */
export async function driveRepairRun({ runId, owner = 'repair-runner', generate = null, provider = 'none', model = '', hooks = null, fencingToken = null } = {}) {
  const run0 = Runs.getRun(runId);
  if (!run0) return { ok: false, reason: '运行不存在' };
  let token = fencingToken === null || fencingToken === undefined ? null : Number(fencingToken);
  if (token === null) {
    const lease = Runs.acquireLease({ runId, owner: String(owner || 'repair-runner'), ttlMs: 10 * 60 * 1000 });
    if (lease.ok !== true) return { ok: false, reason: lease.reason || '运行已被其他执行者持有', run: run0 };
    token = Number(lease.fencing_token);
  } else {
    const cur = Runs.getRun(runId);
    if (!cur || Number(cur.fencing_token) !== token) return { ok: false, reason: 'FENCED：fencing token 已过期（旧 worker 不得继续写入）', run: cur };
  }
  const current = Runs.getRun(runId);
  if (current.status === 'queued') Runs.updateRun(runId, { status: 'running' });
  const workId = Number(run0.work_id);
  const policy = effectivePolicy(run0);
  const report = { ...(run0.result || {}) };
  report.run_id = run0.id; report.mode = 'repair'; report.version = REPAIR_RUNNER_VERSION;
  report.work_id = workId; report.root_chapter_id = Number(run0.root_chapter_id);
  report.base_commit_id = String(run0.base_commit_id || '');
  report.working_worldline_id = run0.working_worldline_id || null;
  report.policy = run0.policy || {};
  report.totals = { chapters: 0, kept: 0, repaired: 0, attempts: 0, needs_review: 0, blocked: 0, model_calls: 0, tokens: 0, sweeps: 0, ...(report.totals || {}) };
  report.checkpoint = { last_chapter_id: null, output_commit_id: null, candidate_head_id: null, manifest_hash: '', updated_at: nowIso(), ...(report.checkpoint || {}) };
  report.halt = null;
  report.downstream = Array.isArray(report.downstream) ? report.downstream : [];
  report.notes = Array.isArray(report.notes) ? report.notes : [];
  const changes = Array.isArray(run0.baseline && run0.baseline.changes) ? run0.baseline.changes : [];
  const ctx = {
    run: run0, report, workId, generate, provider, model, policy, hooks, fencingToken: token,
    counters: { model_calls: Number(report.totals.model_calls) || 0, tokens: Number(report.totals.tokens) || 0, attempts: Number(report.totals.attempts) || 0 },
    deadlineAt: (Date.parse(run0.created_at) || Date.now()) + policy.deadline_ms,
    changes, changedResources: new Set(changes.map((c) => String(c.resource_key))),
    changedNames: changedEntityNames(changes), constraints: authorConstraintsOf(workId),
  };
  const scope = (run0.coverage && Array.isArray(run0.coverage.chapters) ? run0.coverage.chapters : []).map(Number).filter((n) => n > 0);
  if (!scope.length) return haltRun({ run: Runs.getRun(run0.id), report, status: 'needs_review', reason: '运行范围为空：没有需要重建的章节' });
  let workingHeadId = String((getWorldline(run0.working_worldline_id) || {}).head_commit_id || run0.base_commit_id || '');
  if (!workingHeadId) return haltRun({ run: Runs.getRun(run0.id), report, status: 'failed', reason: '工作线未建立：无法推进候选' });
  const headManifest = manifestOf(getCommit(workingHeadId)).chapters;
  const doneSteps = latestStepsOf(run0.id);
  let startIndex = 0;
  for (let i = 0; i < scope.length; i += 1) {
    const step = doneSteps.get(scope[i]);
    const done = step && (step.status === 'kept' || step.status === 'repaired');
    if (!done || String(headManifest[String(scope[i])] || '') !== String(step.candidate_binding_id || '')) break;
    startIndex = i + 1;
  }
  for (let i = startIndex; i < scope.length; i += 1) {
    const guard = guardCheck(ctx);
    if (guard) {
      if (guard.fenced) return { ok: false, reason: guard.reason, run: Runs.getRun(run0.id) };
      return haltRun({ run: Runs.getRun(run0.id), report, status: guard.status || 'paused', reason: guard.reason, chapterId: scope[i] });
    }
    const chapterId = scope[i];
    const out = await processChapter(ctx, { chapterId, workingHeadId });
    if (out.status === 'halt') {
      if (out.halt && out.halt.fenced) return { ok: false, reason: out.halt.reason, run: Runs.getRun(run0.id) };
      return haltRun({ run: Runs.getRun(run0.id), report, status: (out.halt && out.halt.status) || 'paused', reason: out.halt ? out.halt.reason : '驱动停止', chapterId });
    }
    if (out.status === 'blocked') return haltRun({ run: Runs.getRun(run0.id), report, status: 'paused', reason: out.reason, chapterId });
    if (out.status === 'needs_review') return haltRun({ run: Runs.getRun(run0.id), report, status: 'needs_review', reason: out.reason, chapterId });
    workingHeadId = out.commit_id;
    pushChapterEntry(ctx, { chapter_id: chapterId, status: out.status, commit_id: out.commit_id, step_id: out.step ? out.step.id : null });
    report.checkpoint.last_chapter_id = chapterId;
    report.checkpoint.output_commit_id = workingHeadId;
    report.checkpoint.updated_at = nowIso();
    syncTotals(ctx);
    Runs.updateRun(run0.id, { result: report });
  }
  const sweep = await finalSweep(ctx, { scope, workingHeadId });
  if (sweep.halt) {
    if (sweep.halt.fenced) return { ok: false, reason: sweep.halt.reason, run: Runs.getRun(run0.id) };
    return haltRun({ run: Runs.getRun(run0.id), report, status: sweep.halt.status || 'paused', reason: sweep.halt.reason });
  }
  workingHeadId = sweep.workingHeadId;
  if (sweep.drift && sweep.drift.length) {
    report.drift = sweep.drift;
    return haltRun({ run: Runs.getRun(run0.id), report, status: 'needs_review', reason: `最终回扫 ${sweep.sweeps} 轮后仍存在输入漂移（不收敛，未标记 ready）` });
  }
  const finalSteps = latestStepsOf(run0.id);
  const missing = scope.filter((chapterId) => {
    const step = finalSteps.get(Number(chapterId));
    return !step || !['kept', 'repaired'].includes(step.status);
  });
  if (missing.length) return haltRun({ run: Runs.getRun(run0.id), report, status: 'needs_review', reason: `仍有章节未完成复核：${missing.join('、')}` });
  syncTotals(ctx);
  report.downstream = scope.map((chapterId) => {
    const step = finalSteps.get(Number(chapterId));
    return { chapter_id: Number(chapterId), status: step.status, commit_id: (step.result || {}).candidate_commit_id || null, step_id: step.id };
  });
  const candidateHead = getCommit(workingHeadId);
  report.checkpoint.candidate_head_id = workingHeadId;
  report.checkpoint.manifest_hash = manifestHashOf(candidateHead);
  report.checkpoint.updated_at = nowIso();
  report.receipt = {
    chapters: scope.map((chapterId) => {
      const step = finalSteps.get(Number(chapterId));
      const r = step.result || {};
      return {
        chapter_id: Number(chapterId), status: step.status,
        base_binding_id: r.base_binding_id || null, base_revision_id: r.base_revision_id || null,
        revision_id: r.revision_id || null, binding_id: r.candidate_binding_id || null,
        changed: step.status === 'repaired',
      };
    }),
  };
  report.notes.push('候选重建完成：全部章节已复核；正式正文仍未改动，等待作者应用审批。');
  const updated = Runs.updateRun(run0.id, { status: 'ready', result: report });
  Runs.releaseLease(run0.id);
  return { ok: true, run: updated, report };
}

/** 恢复被暂停/失败/待复核的运行（断点继续；预算只增不减）。 */
export async function resumeRepairRun({ workId, runId, owner = '', generate = null, provider = 'none', model = '', hooks = null, extendCalls = 0, extendTokens = 0, extendSeconds = 0 } = {}) {
  const run = Runs.getRun(runId);
  if (!run || Number(run.work_id) !== (Number(workId) || 0)) return { ok: false, reason: '运行不存在或不属于该作品' };
  if (['applied', 'reverted', 'cancelled'].includes(run.status)) return { ok: false, reason: `运行状态为 ${run.status}：不可恢复` };
  if (run.status === 'ready') return { ok: false, reason: '运行已就绪：请直接应用或撤销（无需恢复）' };
  if (run.status === 'stale') return { ok: false, reason: '运行基线已过期：请基于最新主线重新发起重建（不静默重基）' };
  const lease = Runs.acquireLease({ runId: run.id, owner: String(owner || `resume-${Date.now()}`), ttlMs: 10 * 60 * 1000 });
  if (lease.ok !== true) return { ok: false, reason: lease.reason || '运行仍被其他执行者持有' };
  const extensions = [...(Array.isArray((run.authorization || {}).extensions) ? run.authorization.extensions : [])];
  if (extendCalls || extendTokens || extendSeconds) {
    extensions.push({ at: nowIso(), calls: Number(extendCalls) || 0, tokens: Number(extendTokens) || 0, seconds: Number(extendSeconds) || 0 });
  }
  const result = { ...(run.result || {}) };
  result.halt = null;
  result.notes = [...(Array.isArray(result.notes) ? result.notes : []), `恢复：${nowIso()}（不重置已消耗预算）`];
  const updated = Runs.updateRun(run.id, { status: 'queued', result, authorization: { ...(run.authorization || {}), extensions } });
  const driving = driveRepairRun({ runId: run.id, owner: String(owner || 'resume'), generate, provider, model, hooks, fencingToken: lease.fencing_token });
  if (driving && typeof driving.catch === 'function') {
    driving.catch((e) => {
      try {
        const cur = Runs.getRun(run.id);
        Runs.updateRun(run.id, { status: 'failed', result: { ...(cur.result || {}), halt: { status: 'failed', reason: sanitizeText(String((e && e.message) || e), 300), at: nowIso() } } });
        Runs.releaseLease(run.id);
      } catch { /* 保留原状态 */ }
    });
  }
  return { ok: true, run: updated, driving: true };
}

/** 取消：幂等；工作进程在下一次模型调用前/响应后/提交前的 guard 检查中停止。 */
export function cancelRepairRun({ workId = 0, runId, by = 'author' } = {}) {
  const run = Runs.getRun(runId);
  if (!run) return { ok: false, reason: '运行不存在' };
  if (workId && Number(run.work_id) !== Number(workId)) return { ok: false, reason: '运行不属于该作品' };
  if (['applied', 'reverted'].includes(run.status)) return { ok: false, reason: `运行状态为 ${run.status}：已终结，不能取消` };
  if (run.status === 'cancelled') return { ok: true, already: true, run };
  const report = { ...(run.result || {}) };
  report.halt = { status: 'cancelled', reason: `作者取消（${String(by || 'author')}）`, at: nowIso() };
  report.notes = [...(Array.isArray(report.notes) ? report.notes : []), '作者取消：已完成章节的候选断点保留（不会标记为重建完成）。'];
  const updated = Runs.updateRun(run.id, { status: 'cancelled', result: report });
  Runs.releaseLease(run.id);
  return { ok: true, already: false, run: updated };
}

/** 运行视图（作者界面/插件查询）：运行 + 步骤 + 应用门槛（门槛一律服务端重算）。 */
export function repairRunView({ workId = 0, runId } = {}) {
  const run = Runs.getRun(runId);
  if (!run || Number(run.work_id) !== (Number(workId) || 0)) return { ok: false, reason: '运行不存在或不属于该作品' };
  const steps = Runs.listSteps(run.id);
  const mainHead = ensureMainCommit(run.work_id);
  const candidate = repairApplyBinding({ workId: run.work_id, runId: run.id });
  const reasons = [];
  if (run.status !== 'ready') reasons.push(`运行状态为 ${run.status}`);
  if (String(mainHead.id) !== String(run.base_commit_id)) reasons.push('正式主线已前进：候选基线过期，需重新发起');
  if (!candidate.ok) reasons.push(candidate.reason || '候选清单未就绪');
  else if (!candidate.ready) reasons.push('候选清单与运行断点不一致（尚未就绪）');
  return {
    ok: true, enabled: true, work_id: run.work_id, run, steps,
    candidate: candidate.ok ? { head_commit_id: candidate.candidate_head_id, manifest_hash: candidate.manifest_hash } : null,
    ready_gate: { can_apply: reasons.length === 0, reasons },
  };
}

/** 列出该作品的重建运行（作者界面用；按创建时间倒序）。 */
export function listRepairRuns({ workId = 0, limit = 10 } = {}) {
  const w = Number(workId) || 0;
  if (!w) return { ok: false, reason: '缺少 work_id' };
  return { ok: true, work_id: w, runs: Runs.listRuns(w, { mode: 'repair', limit: Math.max(1, Math.min(Number(limit) || 10, 50)) }) };
}
/**
 * 应用：一个同步事务把候选正文/绑定/HEAD/投影/审批/outbox 一起切换；重复 apply 返回同一回执。
 * 半套应用是不允许的：任一步失败 → 整事务回滚（正文、HEAD、审批全部保持原样）。
 */
export function applyRepairRun({ workId = 0, runId, approvalId = '', by = 'author', hooks = null } = {}) {
  const w = Number(workId) || 0;
  const run = Runs.getRun(runId);
  if (!run || Number(run.work_id) !== w) return { ok: false, reason: '运行不存在或不属于该作品' };
  if (run.status === 'applied') {
    const receipt = run.result && run.result.apply;
    return receipt ? { ...receipt, reused: true } : { ok: false, reason: '运行已应用，但缺少回执' };
  }
  if (run.status !== 'ready') return { ok: false, reason: `运行状态为 ${run.status}：只有 ready 的运行可以应用到正式主线` };
  const candidate = repairApplyBinding({ workId: w, runId: run.id });
  if (!candidate.ok) return { ok: false, reason: candidate.reason || '候选清单未就绪' };
  if (!candidate.ready) return { ok: false, reason: '候选清单与运行断点不一致：拒绝应用（不信任客户端报 ready）' };
  const mainHead = ensureMainCommit(w);
  if (String(mainHead.id) !== String(run.base_commit_id)) {
    const result = { ...(run.result || {}), halt: { status: 'stale', reason: '正式主线已前进：候选基于旧基线', at: nowIso() } };
    Runs.updateRun(run.id, { status: 'stale', result });
    return { ok: false, rejected: 'stale', reason: '正式主线已前进：候选基于旧基线，拒绝静默合并' };
  }
  const candidateCommit = getCommit(candidate.candidate_head_id);
  const candidateManifest = manifestOf(candidateCommit).chapters;
  const baseCommit = getCommit(run.base_commit_id);
  const baseManifest = baseCommit ? manifestOf(baseCommit).chapters : {};
  const scope = (run.coverage && Array.isArray(run.coverage.chapters) ? run.coverage.chapters : []).map(Number);
  const steps = latestStepsOf(run.id);
  const plan = [];
  for (const chapterId of scope) {
    const step = steps.get(Number(chapterId));
    if (!step || !['kept', 'repaired'].includes(step.status)) return { ok: false, reason: `第 ${chapterId} 章尚未完成复核：拒绝应用半套候选` };
    const bindingId = candidateManifest[String(chapterId)] || null;
    if (!bindingId || String(bindingId) !== String(step.candidate_binding_id || '')) return { ok: false, reason: `第 ${chapterId} 章候选清单与运行记录不一致` };
    const binding = getBinding(bindingId);
    const rev = binding ? getRevision(binding.revision_id) : null;
    if (!binding || !rev) return { ok: false, reason: `第 ${chapterId} 章候选修订缺失` };
    const baseBindingId = baseManifest[String(chapterId)] || null;
    const baseBinding = baseBindingId ? getBinding(baseBindingId) : null;
    const baseRev = baseBinding ? getRevision(baseBinding.revision_id) : null;
    if (!baseRev) return { ok: false, reason: `第 ${chapterId} 章在基线上没有可恢复的正文修订：不能应用（撤销将无法恢复）` };
    plan.push({
      chapter_id: Number(chapterId), binding_id: bindingId, revision_id: rev.id,
      base_binding_id: baseBindingId, base_revision_id: baseRev.id,
      changed: String(baseRev.id) !== String(rev.id),
      base_content: String(baseRev.content_html), candidate_content: String(rev.content_html),
    });
  }
  let receipt = null;
  let failure = null;
  try {
    withTransaction(() => {
      const consumed = Approvals.consumeApproval(String(approvalId || ''), {
        op: 'repair_run_apply', workId: w, baselineHash: candidate.manifest_hash,
        binding: { run_id: run.id, manifest_hash: candidate.manifest_hash }, by: String(by || 'author'),
      });
      if (!consumed.ok) {
        const err = new Error(consumed.reason || '审批消费失败');
        err.approvalVerdict = consumed;
        throw err;
      }
      const at = nowIso();
      for (const item of plan) {
        const row = db.prepare('SELECT id, work_id, title, summary, content FROM chapters WHERE id = ?').get(item.chapter_id);
        if (!row || Number(row.work_id) !== w) { const e = codedError('CHAPTER_MISSING', `章节 #${item.chapter_id} 不存在`); e.chapters = [item.chapter_id]; throw e; }
        if (item.changed && String(row.content ?? '') !== item.base_content) {
          const e = codedError('CONTENT_CAS_MISMATCH', `第 ${item.chapter_id} 章正文在运行期间被修改：拒绝覆盖（请重新发起重建）`);
          e.chapters = [item.chapter_id];
          throw e;
        }
      }
      for (const item of plan) {
        if (!item.changed) continue;
        const row = db.prepare('SELECT id, title, summary, content FROM chapters WHERE id = ?').get(item.chapter_id);
        if (hooks && typeof hooks.saveChapterVersion === 'function') hooks.saveChapterVersion(item.chapter_id, row.title, row.summary, row.content, 'manual');
        const info = db.prepare('UPDATE chapters SET content = ?, updated_at = ? WHERE id = ? AND content = ?')
          .run(item.candidate_content, at, item.chapter_id, String(row.content ?? ''));
        if (Number(info.changes) !== 1) { const e = codedError('CONTENT_CAS_MISMATCH', `第 ${item.chapter_id} 章正文写入时被并发修改：已整体回滚`); e.chapters = [item.chapter_id]; throw e; }
        supersedePendingBindings(w, item.chapter_id, { exceptId: item.binding_id });
      }
      const { commit } = commitManifest({
        workId: w, worldlineId: ensureMainWorldline(w).id, parentCommitId: mainHead.id,
        orderVersionId: manifestOf(candidateCommit).order_version_id,
        chapters: Object.fromEntries(plan.map((item) => [String(item.chapter_id), item.binding_id])),
        note: `repair_apply:${run.id}`, expectedHead: mainHead.id,
      });
      copyTrustOverlay({ workId: w, fromCommitId: mainHead.id, toCommitId: commit.id, exceptBindingIds: plan.map((item) => item.binding_id) });
      const lastChapter = plan[plan.length - 1];
      const after = stateAt({ workId: w, chapterId: lastChapter.chapter_id, boundary: 'after', commitId: commit.id });
      const compat = refreshCompatProjection({ workId: w, state: after.state, commitId: commit.id });
      let projection = null;
      if (hooks && typeof hooks.enqueueProjectionInTx === 'function') {
        projection = hooks.enqueueProjectionInTx(w, {
          chapterId: lastChapter.chapter_id, kind: 'ov_work_sync',
          payload: { reason: 'repair_apply', run_id: run.id, chapters: plan.map((item) => item.chapter_id) },
          dedupKey: `repair_apply:${run.id}`,
        });
      }
      receipt = {
        ok: true, applied: true, at, run_id: run.id, commit_id: commit.id, applied_by: String(by || 'author'),
        chapters: plan.map((item) => ({
          chapter_id: item.chapter_id, binding_id: item.binding_id, revision_id: item.revision_id,
          base_binding_id: item.base_binding_id, base_revision_id: item.base_revision_id,
          changed: item.changed, backup: item.changed ? 'chapter_save_versions(manual)' : null,
        })),
        compat, projection,
        state_content_hash: after.state_content_hash || '',
        trusted: !!after.trusted,
        note: '候选已原子应用于正式主线；被替换的旧正文保留在版本历史，可撤销。',
      };
      Runs.updateRun(run.id, { status: 'applied', result: { ...(run.result || {}), apply: receipt } });
    });
  } catch (e) { failure = e; }
  if (failure) {
    if (failure.approvalVerdict) {
      return { ok: false, rejected: true, reason: `应用审批未通过（${failure.approvalVerdict.code}）：${failure.approvalVerdict.reason}`, code: failure.approvalVerdict.code };
    }
    if (failure.code === 'CONTENT_CAS_MISMATCH' || failure.code === 'CHAPTER_MISSING') {
      return { ok: false, rejected: 'cas_conflict', reason: failure.message, chapters: failure.chapters || [] };
    }
    return { ok: false, reason: sanitizeText(String((failure && failure.message) || failure), 300) };
  }
  return receipt;
}

/** 撤销：产生恢复提交；应用后被再次编辑 → 报告 CAS 冲突并保留恢复候选（绝不覆盖）。 */
export function revertRepairRun({ workId = 0, runId, by = 'author', hooks = null } = {}) {
  const w = Number(workId) || 0;
  const run = Runs.getRun(runId);
  if (!run || Number(run.work_id) !== w) return { ok: false, reason: '运行不存在或不属于该作品' };
  if (run.status !== 'applied') return { ok: false, reason: `运行状态为 ${run.status}：只有 applied 可以撤销` };
  const receipt = run.result && run.result.apply;
  if (!receipt || !Array.isArray(receipt.chapters)) return { ok: false, reason: '缺少应用回执：无法确定恢复基线' };
  const changed = receipt.chapters.filter((item) => item.changed);
  const conflicts = [];
  for (const item of changed) {
    const row = db.prepare('SELECT id, content FROM chapters WHERE id = ?').get(item.chapter_id);
    const rev = getRevision(item.revision_id);
    if (!row) conflicts.push({ chapter_id: item.chapter_id, reason: 'chapter_missing' });
    else if (!rev) conflicts.push({ chapter_id: item.chapter_id, reason: 'candidate_revision_missing' });
    else if (String(row.content ?? '') !== String(rev.content_html)) conflicts.push({ chapter_id: item.chapter_id, reason: 'content_edited_after_apply' });
  }
  if (conflicts.length) {
    const result = { ...(run.result || {}), recovery: { at: nowIso(), cas_conflict: conflicts, note: '应用后正文已被再次编辑：不覆盖作者新改动，恢复候选保留。' } };
    Runs.updateRun(run.id, { result });
    return { ok: false, rejected: 'cas_conflict', reason: '应用后本章正文已被再次编辑：撤销被拒绝（不覆盖）', conflicts };
  }
  let out = null;
  let failure = null;
  try {
    withTransaction(() => {
      const head = ensureMainCommit(w);
      if (String(head.id) !== String(receipt.commit_id || '')) throw codedError('MAIN_HEAD_MOVED', '正式主线在应用之后又前进了：撤销需要人工处理');
      const at = nowIso();
      for (const item of changed) {
        const row = db.prepare('SELECT id, title, summary, content FROM chapters WHERE id = ?').get(item.chapter_id);
        const base = getRevision(item.base_revision_id);
        if (!base) throw codedError('BASE_REVISION_MISSING', `第 ${item.chapter_id} 章的基线修订不存在`);
        if (hooks && typeof hooks.saveChapterVersion === 'function') hooks.saveChapterVersion(item.chapter_id, row.title, row.summary, row.content, 'manual');
        const info = db.prepare('UPDATE chapters SET content = ?, updated_at = ? WHERE id = ? AND content = ?')
          .run(String(base.content_html), at, item.chapter_id, String(row.content ?? ''));
        if (Number(info.changes) !== 1) { const e = codedError('CONTENT_CAS_MISMATCH', `撤销第 ${item.chapter_id} 章时正文被并发修改：已整体回滚`); e.chapters = [item.chapter_id]; throw e; }
      }
      const { commit } = commitManifest({
        workId: w, worldlineId: ensureMainWorldline(w).id, parentCommitId: head.id,
        orderVersionId: head.order_version_id,
        chapters: Object.fromEntries(receipt.chapters.map((item) => [String(item.chapter_id), item.base_binding_id])),
        note: `repair_revert:${run.id}`, expectedHead: head.id,
      });
      copyTrustOverlay({ workId: w, fromCommitId: head.id, toCommitId: commit.id });
      let compat = null;
      const rootChapterId = Number(run.root_chapter_id) || 0;
      if (rootChapterId) {
        try {
          const view = stateAt({ workId: w, chapterId: rootChapterId, boundary: 'after', commitId: commit.id });
          if (view && view.state instanceof Map) {
            compat = { ...refreshCompatProjection({ workId: w, state: view.state, commitId: commit.id }), truncated_at_chapter: rootChapterId, note: '撤销后仅投影到根章节的可信状态；其后章节等待重新重建。' };
          }
        } catch (e) { compat = { ok: false, reason: sanitizeText(String((e && e.message) || e), 200) }; }
      }
      let projection = null;
      if (hooks && typeof hooks.enqueueProjectionInTx === 'function') {
        projection = hooks.enqueueProjectionInTx(w, {
          chapterId: changed.length ? changed[changed.length - 1].chapter_id : null, kind: 'ov_work_sync',
          payload: { reason: 'repair_revert', run_id: run.id }, dedupKey: `repair_revert:${run.id}`,
        });
      }
      const revertReceipt = {
        ok: true, reverted: true, at, run_id: run.id, commit_id: commit.id, reverted_by: String(by || 'author'),
        chapters: changed.map((item) => ({ chapter_id: item.chapter_id, restored_revision_id: item.base_revision_id })),
        compat, projection,
        note: '已产生恢复提交：正文回到重建前版本（被替换的候选正文保留在版本历史）。',
      };
      Runs.updateRun(run.id, { status: 'reverted', result: { ...(run.result || {}), revert: revertReceipt } });
      out = revertReceipt;
    });
  } catch (e) { failure = e; }
  if (failure) {
    if (failure.code === 'CONTENT_CAS_MISMATCH' || failure.code === 'MAIN_HEAD_MOVED') {
      const result = { ...(run.result || {}), recovery: { at: nowIso(), cas_conflict: [{ reason: failure.code, message: failure.message }], note: '撤销未执行：不覆盖作者新改动。' } };
      Runs.updateRun(run.id, { result });
      return { ok: false, rejected: 'cas_conflict', reason: failure.message };
    }
    return { ok: false, reason: sanitizeText(String((failure && failure.message) || failure), 300) };
  }
  return out;
}
