#!/usr/bin/env node
/**
 * 一键成书的 Job 存储与流水线。
 *
 * 2026-10-25 审查修复（P1/P2）后的事实约束，代码里每条都对应一个曾经的缺陷：
 *   · `stage_history` 只记真实发生的阶段（不再用并集拼，历史里不会出现“未来”）；
 *   · 来源先过路径策略/大小/编码/凭据扫描，命中即 BLOCKED，且**不写任何章节**；
 *   · 契约生成即按 schema 校验；完成前必须过 completionVerdict；导出前必须 assertCommitted；
 *   · 账本按章追加，全书复审读取账本；
 *   · 导出审批绑定候选稿 hash（改稿后旧审批自动失效）；
 *   · 每个阶段写 checkpoint，交付物带 README/过程记录/contract/evidence。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as core from './core.mjs'
import { createEgressGuard } from './egress.mjs'
import { signChain, verifyAnchor, appendAnchorLog, gitAnchorInfo, defaultKeyDir } from './attest.mjs'

const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'ROLLED_BACK', 'WAITING_CONFIRMATION'])
const PHASES = ['PREFLIGHT', 'INGESTING', 'NORMALIZED', 'OUTLINED', 'EXEMPLAR_REVIEW', 'DRAFTING', 'QA', 'FULL_REVIEW', 'EXPORT_READY', 'EXPORTING', 'COMPLETED']
const BUDGET_MAX_CNY = 2

export class JobStore {
  constructor({ root }) {
    this.root = path.resolve(root)
    this.jobDir = path.join(this.root, '.job')
    this.stateFile = path.join(this.jobDir, 'state.json')
    this.indexFile = path.join(this.jobDir, 'index.json')
    this.eventsFile = path.join(this.jobDir, 'events.jsonl')
    this.controlFile = path.join(this.jobDir, 'control.json')
  }

  ensure() {
    fs.mkdirSync(this.jobDir, { recursive: true })
  }

  index() {
    return core.readJson(this.indexFile, { jobs: [] })
  }

  state() {
    return core.readJson(this.stateFile, null)
  }

  saveState(state) {
    state.updated_at = new Date().toISOString()
    core.writeJsonAtomic(this.stateFile, state)
    return state
  }

  event(type, data = {}) {
    this.ensure()
    fs.appendFileSync(this.eventsFile, JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n')
  }

  control() {
    return core.readJson(this.controlFile, { paused: false, cancelled: false })
  }

  setControl(patch) {
    this.ensure()
    const next = { ...this.control(), ...patch }
    core.writeJsonAtomic(this.controlFile, next)
    return next
  }

  jobIdFor(key) {
    return `job-${core.sha256(String(key)).slice(0, 12)}`
  }

  /** 幂等 + 单活跃 job：输入未齐（WAITING_CONFIRMATION）不占位，可以换 key 重来。 */
  create({ idempotencyKey, brief }) {
    this.ensure()
    const jobId = this.jobIdFor(idempotencyKey)
    const existing = this.state()
    if (existing && existing.job_id === jobId) {
      this.event('job_reused', { job_id: jobId, status: existing.status })
      return { jobId, created: false, state: existing }
    }
    if (existing && !TERMINAL_STATUSES.has(existing.status)) {
      const err = new Error(`已有未完成的 job：${existing.job_id}（先完成/取消，或沿用同一 idempotency_key）`)
      err.code = 'JOB_ACTIVE'
      err.detail = { existing: existing.job_id, status: existing.status }
      throw err
    }
    if (existing) {
      const index = this.index()
      index.jobs.push({ job_id: existing.job_id, idempotency_key: existing.idempotency_key, status: existing.status, archived_at: new Date().toISOString() })
      core.writeJsonAtomic(this.indexFile, index)
    }
    const state = {
      job_id: jobId,
      idempotency_key: idempotencyKey,
      status: 'RECEIVED',
      stage_history: ['RECEIVED'],
      brief,
      approvals: {},
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      evidence: [],
    }
    core.writeJsonAtomic(this.stateFile, state)
    core.writeJsonAtomic(this.controlFile, { paused: false, cancelled: false })
    this.event('job_created', { job_id: jobId })
    return { jobId, created: true, state }
  }

  jobs() {
    const state = this.state()
    return {
      current: state ? { job_id: state.job_id, status: state.status, key: state.idempotency_key } : null,
      history: this.index().jobs.slice(-20),
    }
  }
}

function p(root, rel) {
  return core.resolveInside(root, rel)
}

function writeRel(root, rel, content) {
  const abs = p(root, rel)
  core.writeAtomic(abs, content)
  return { path: rel.replace(/\\/g, '/'), sha256: core.sha256(content), bytes: Buffer.byteLength(content) }
}

function writeJsonRel(root, rel, value) {
  return writeRel(root, rel, JSON.stringify(value, null, 2) + '\n')
}

function appendJsonl(root, rel, rows) {
  if (rows.length === 0) return
  const abs = p(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.appendFileSync(abs, rows.map((row) => JSON.stringify(row) + '\n').join(''))
}

/** 账本追加必须幂等：两段导出/续跑会重入同一阶段，重复追加会把“行数=章节数”的判据弄坏。 */
function appendLedgerOnce(root, rel, rows) {
  const existing = readJsonl(root, rel)
  const seen = new Set(existing.map((row) => `${row.kind}:${row.chapter}:${row.id ?? ''}`))
  const fresh = rows.filter((row) => !seen.has(`${row.kind}:${row.chapter}:${row.id ?? ''}`))
  appendJsonl(root, rel, fresh)
}

export function listArtifacts(root) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.job' || entry.name === 'node_modules') continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      out.push({ path: rel, sha256: core.sha256(fs.readFileSync(abs)), bytes: fs.statSync(abs).size })
    }
  }
  walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function progressOf(state) {
  const total = state?.chapter_manifest?.chapters?.length ?? 0
  const done = Array.isArray(state?.committed) ? state.committed.length : 0
  return {
    stage: state?.status ?? 'NONE',
    chapters_done: done,
    chapters_total: total,
    blocked_reason: state?.blocked_reason ?? null,
    next_action: nextActionOf(state),
  }
}

function nextActionOf(state) {
  switch (state?.status) {
    case 'WAITING_CONFIRMATION': return `补齐输入：${(state.missing ?? []).join(', ')}`
    case 'EXEMPLAR_REVIEW': return '批准范例章后继续（approve kind=exemplar）'
    case 'FULL_REVIEW': return '批准全书复审后继续（approve kind=full_review）'
    case 'EXPORT_READY': return '批准导出（approve kind=export，需与候选稿 hash 绑定）'
    case 'FIXING': return '按 defect-list 修复后重试（POST /retry）'
    case 'BLOCKED': return '按 blocked_reason 修复后重试（POST /retry）'
    case 'COMPLETED': return '导出物已生成；如需发布请单独审批（默认关闭）'
    default: return state ? '继续执行' : '先 POST /start 创建任务'
  }
}

/**
 * 执行（或续跑）一次一键成书。
 */
export function runJob({ root, idempotencyKey, brief, approvals = {}, options = {} }) {
  const store = new JobStore({ root })
  const created = store.create({ idempotencyKey, brief })
  const jobId = created.jobId
  const state = store.state()
  const evidence = { chain: state.evidence ?? [] }
  const memory = probeAdapter(options.memoryClient)
  const chime = probeAdapter(options.chimeClient)
  const egress = createEgressGuard({
    allowlist: Array.isArray(brief?.allow_hosts) ? brief.allow_hosts : [],
    auditFile: path.join(root, '.job/egress.jsonl'),
  })

  const record = (stage, data = {}) => {
    evidence.chain = core.appendEvidence(evidence.chain, { stage, at: new Date().toISOString(), ...data })
    // 历史只追加真实发生的阶段（P1-1 修复点）。
    if (!state.stage_history.includes(stage)) state.stage_history.push(stage)
    state.status = stage
    return state
  }

  // 观测类记录（出口摘要等）只进证据链，不进阶段历史——它不是方案里的阶段。
  const recordEvidence = (stage, data = {}) => {
    evidence.chain = core.appendEvidence(evidence.chain, { stage, at: new Date().toISOString(), ...data })
  }

  const checkpoint = (stage) => {
    const content = {
      schema_version: '1.0.0',
      job_id: jobId,
      stage,
      at: new Date().toISOString(),
      artifacts: listArtifacts(root).map(({ path: rel, sha256 }) => ({ path: rel, sha256 })),
    }
    return writeJsonRel(root, `.dsh/checkpoints/${String(PHASES.indexOf(stage) + 1).padStart(2, '0')}-${stage}.json`, content)
  }

  const finish = (status, extra = {}) => {
    const next = {
      ...store.state(),
      status,
      stage_history: state.stage_history,
      committed: state.committed ?? [],
      chapter_manifest: state.chapter_manifest ?? store.state().chapter_manifest,
      approvals: { ...store.state().approvals, ...approvals },
      evidence: evidence.chain,
      memory_state: memory,
      chime_state: chime,
      progress: progressOf({ ...store.state(), status, committed: state.committed, chapter_manifest: state.chapter_manifest ?? store.state().chapter_manifest }),
      ...extra,
    }
    store.saveState(next)
    return { jobId, status, created: created.created, state: next, ...extra }
  }

  const guard = () => {
    const control = store.control()
    if (control.cancelled) return 'CANCELLED'
    if (control.paused) return 'PAUSED'
    return null
  }

  if (state.status === 'COMPLETED') {
    store.event('resume_noop', { job_id: jobId })
    return { jobId, status: 'COMPLETED', created: created.created, state: store.state() }
  }
  if (state.status === 'CANCELLED') return { jobId, status: 'CANCELLED', created: created.created, state }

  const retrying = ['FIXING', 'BLOCKED', 'FAILED'].includes(state.status)
  if (retrying) {
    state.stage_history = ['RECEIVED']
    state.blocked_reason = null
    state.attempts = (state.attempts ?? 0) + 1
    core.writeJsonAtomic(store.stateFile, state)
    store.event('retry', { job_id: jobId, attempt: state.attempts })
  }

  const halted = guard()
  if (halted === 'CANCELLED') return finish('CANCELLED')
  if (halted === 'PAUSED') return { jobId, status: 'PAUSED', created: created.created, state: store.state() }

  // ── PREFLIGHT：输入 + 预算 ────────────────────────────────────────────────
  const check = core.validateBrief(brief)
  if (!check.ok) {
    const items = check.missing.map((field) => ({ id: `C-${field.toUpperCase()}`, field, question: `缺少必需输入：${field}`, state: 'PENDING' }))
    writeJsonRel(root, '.job/confirmation-export.json', { job_id: jobId, missing: check.missing, items, at: new Date().toISOString() })
    record('PREFLIGHT', { verdict: 'WAITING_CONFIRMATION', missing: check.missing })
    store.event('waiting_confirmation', { job_id: jobId, missing: check.missing })
    return finish('WAITING_CONFIRMATION', { missing: check.missing })
  }
  const forbiddenSources = (brief.sources ?? []).map((source) => ({ source, reason: core.forbiddenSourceReason(source) })).filter((item) => item.reason)
  if (forbiddenSources.length > 0) {
    record('PREFLIGHT', { verdict: 'BLOCKED', reason: 'FORBIDDEN_SOURCE_PATH', sources: forbiddenSources })
    writeJsonRel(root, 'manifest/source-manifest.json', { job_id: jobId, sources: [], forbidden: forbiddenSources, errors: forbiddenSources.map((item) => ({ path: item.source, code: 'FORBIDDEN_SOURCE_PATH', reason: item.reason })) })
    return finish('BLOCKED', { blocked_reason: 'FORBIDDEN_SOURCE_PATH' })
  }
  if (check.unsupported.length > 0) {
    record('PREFLIGHT', { verdict: 'BLOCKED', unsupported: check.unsupported })
    return finish('BLOCKED', { blocked_reason: 'UNSUPPORTED_INPUT' })
  }
  const budget = brief.budget_cny
  if (budget !== undefined && budget !== null) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
      record('PREFLIGHT', { verdict: 'BLOCKED', reason: 'INVALID_BUDGET' })
      return finish('BLOCKED', { blocked_reason: 'INVALID_BUDGET' })
    }
    if (budget > BUDGET_MAX_CNY) {
      record('PREFLIGHT', { verdict: 'BLOCKED', reason: 'BUDGET_EXCEEDED', budget })
      return finish('BLOCKED', { blocked_reason: 'BUDGET_EXCEEDED' })
    }
  }
  record('PREFLIGHT', { verdict: 'PASS', budget_cny: budget ?? null })
  checkpoint('PREFLIGHT')

  // ── INGESTING：路径策略 + 大小 + 编码 + 凭据扫描，全部先于任何正文写盘 ──────
  const ingest = core.ingestSources(brief.sources)
  record('INGESTING', {
    verdict: ingest.errors.length === 0 ? 'PASS' : 'BLOCKED',
    sources: ingest.entries.map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
    errors: ingest.errors,
    credential_hits: ingest.credential_hits.map((hit) => hit.label),
  })
  if (ingest.errors.length > 0) {
    writeJsonRel(root, 'manifest/source-manifest.json', {
      job_id: jobId,
      sources: ingest.entries,
      unsupported: ingest.unsupported,
      errors: ingest.errors,
      credential_hits: ingest.credential_hits,
    })
    const first = ingest.errors[0]
    return finish('BLOCKED', { blocked_reason: first.code })
  }
  const sourceManifest = {
    job_id: jobId,
    frozen_at: new Date().toISOString(),
    sources: ingest.entries,
    unsupported: ingest.unsupported,
    citation_policy: '每个可核验主张必须回指 SRC-*；无法回指即阻断',
  }
  writeJsonRel(root, 'manifest/source-manifest.json', sourceManifest)
  writeRel(root, 'sources/normalized/source.txt', ingest.text)
  writeJsonRel(root, '.job/input-snapshot.json', {
    job_id: jobId,
    brief: { ...brief, sources: brief.sources },
    snapshot_hash: core.sha256(JSON.stringify({ brief, sources: ingest.entries.map((entry) => entry.sha256) })),
  })
  record('NORMALIZED', { verdict: 'PASS', bytes: ingest.text.length })
  checkpoint('NORMALIZED')
  if (guard() === 'CANCELLED') return finish('CANCELLED')

  // ── OUTLINED：bible / 目录 / 章契约 / 任务契约（生成即校验）───────────────
  const bible = core.buildBible({ brief, sources: ingest })
  const outline = core.buildOutline({ bible, text: ingest.text })
  writeJsonRel(root, 'book-bible.json', { ...bible, chapter_count: outline.chapters.length })
  writeRel(root, 'outline/outline.md', ['# 目录', '', ...outline.chapters.map((chapter, i) => `${i + 1}. ${chapter.title}（${chapter.id}）`)].join('\n') + '\n')

  const taskContract = {
    schema_version: '1.0.0',
    plan_id: 'plan-52d26b8b5f43',
    job_id: jobId,
    generated_at: new Date().toISOString(),
    acceptance: core.PLAN_ACCEPTANCE,
    accepted_paths: 'owner 于 2026-10-25T12:57+08:00 取消白名单；实现落点受 resolveInside 约束',
    forbidden_actions: ['modify_acceptance_criteria', 'delete_or_weaken_assertions', 'claim_pass_without_exit_code', 'publish_without_approval', 'read_or_emit_credentials', 'bypass_a_gate_or_ledger'],
    budgets: { max_cost_cents: 200, actual_cost_cents: 0 },
    source_policy: { forbidden: ['dotfile', 'secrets/', 'credentials/', '.env'], credential_scan: 'ingest-time' },
  }
  const contractErrors = core.validateContract('task-contract', taskContract)
  if (contractErrors.length > 0) {
    record('OUTLINED', { verdict: 'BLOCKED', reason: 'CONTRACT_INVALID', errors: contractErrors })
    return finish('BLOCKED', { blocked_reason: 'CONTRACT_INVALID' })
  }
  writeJsonRel(root, 'contract/task-contract.json', taskContract)
  writeJsonRel(root, 'contract/book-requirements.json', {
    schema_version: '1.0.0',
    job_id: jobId,
    brief,
    book_bible: bible,
    sources: sourceManifest.sources,
    requirement_to_acceptance: {
      one_click_job: ['AC-04', 'AC-09'],
      input_confirmation: ['AC-01'],
      exemplar_gate: ['AC-05'],
      full_review_gate: ['AC-06'],
      provenance: ['AC-07'],
      draft_commit_separation: ['AC-08'],
      evidence_chain: ['AC-14', 'AC-19'],
      mutation_gate: ['AC-15'],
      style_traceability: ['AC-16'],
      impact_rollback: ['AC-17'],
      export_approval_secret_scan: ['AC-12'],
      degraded_external: ['AC-10', 'AC-11'],
      failure_repair_loop: ['AC-20'],
    },
  })

  for (const chapter of outline.chapters) {
    const contract = {
      schema_version: '1.0.0',
      job_id: jobId,
      id: chapter.id,
      title: chapter.title,
      goal: chapter.goal,
      must_include: chapter.must_include,
      source_refs: chapter.source_refs,
      word_range: chapter.word_range,
      depends_on: chapter.depends_on,
      ledger_delta: {
        terminology: [{ term: chapter.must_include[0].slice(0, 20) }],
        timeline: [{ event: `第 ${Number(chapter.id)} 节` }],
        foreshadow: chapter.id === '001' ? [{ id: 'FS-001', opened: '001' }] : chapter.id === outline.chapters.at(-1).id ? [{ id: 'FS-001', closed: chapter.id }] : [],
      },
    }
    const errors = core.validateContract('chapter-contract', contract)
    if (errors.length > 0) {
      record('OUTLINED', { verdict: 'BLOCKED', reason: 'CONTRACT_INVALID', chapter: chapter.id, errors })
      return finish('BLOCKED', { blocked_reason: 'CONTRACT_INVALID' })
    }
    writeJsonRel(root, `chapters/${chapter.id}/contract.json`, contract)
  }
  // 目录一生成就把“章节总数”暴露给进度：等到 QA 才写清单会让 UI 一直显示 0/0。
  state.chapter_manifest = {
    job_id: jobId,
    chapters: outline.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, qa_ok: null, source_refs: chapter.source_refs })),
  }
  writeRel(root, 'README.md', buildReadme({ bible, outline, brief }))
  writeRel(root, '过程记录.md', buildProcessLog({ jobId, brief, outline, createdAt: state.created_at }))
  record('OUTLINED', { verdict: 'PASS', chapters: outline.chapters.length })
  checkpoint('OUTLINED')
  if (guard() === 'CANCELLED') return finish('CANCELLED')

  // ── EXEMPLAR_REVIEW ───────────────────────────────────────────────────────
  const first = outline.chapters[0]
  let exemplar
  try {
    exemplar = core.composeChapter({ chapter: first, section: outline.sections[0] })
  } catch (e) {
    writeDefects(root, jobId, [{ chapter: first.id, code: e.code ?? 'COMPOSE_FAILED', detail: e.detail ?? String(e.message) }], 'add_source_material')
    record('EXEMPLAR_REVIEW', { verdict: 'FIXING', code: e.code ?? 'COMPOSE_FAILED' })
    return finish('FIXING', { blocked_reason: e.code ?? 'COMPOSE_FAILED' })
  }
  const exemplarQa = core.qaChapter({ chapter: first, text: exemplar.text, bible })
  writeRel(root, `chapters/${first.id}/draft.md`, exemplar.text)
  writeJsonRel(root, `chapters/${first.id}/review.json`, { chapter: first.id, qa: exemplarQa, source_map: exemplar.source_map, at: new Date().toISOString() })
  if (!exemplarQa.ok) {
    writeDefects(root, jobId, exemplarQa.findings.map((finding) => ({ chapter: first.id, ...finding })), 'fix_exemplar')
    record('EXEMPLAR_REVIEW', { verdict: 'FIXING', chapter: first.id })
    return finish('FIXING', { blocked_reason: 'EXEMPLAR_QA_FAILED' })
  }
  checkpoint('EXEMPLAR_REVIEW')
  record('EXEMPLAR_REVIEW', { verdict: exemplarQa.ok ? 'PASS' : 'FIXING', chapter: first.id })
  if (!approvals.exemplar) {
    writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'EXEMPLAR_REVIEW', chapter: first.id })
    return finish('EXEMPLAR_REVIEW', { pending_approval: 'exemplar' })
  }
  commitChapter({ root, store, jobId, chapter: first, text: exemplar.text, qa: exemplarQa, sourceMap: exemplar.source_map })
  state.committed = [...(state.committed ?? []), first.id]

  // ── DRAFTING：逐章生成（每章检查控制面）+ 账本增量 ─────────────────────────
  const drafts = [{ chapter: first, ...exemplar, qa: exemplarQa }]
  for (const chapter of outline.chapters.slice(1)) {
    const paused = guard()
    if (paused === 'CANCELLED') return finish('CANCELLED')
    if (paused === 'PAUSED') {
      record('DRAFTING', { verdict: 'PAUSED', chapter: chapter.id })
      return { jobId, status: 'PAUSED', created: created.created, state: store.state() }
    }
    let composed
    try {
      composed = core.composeChapter({ chapter, section: outline.sections[chapter.section_index ?? 0] })
    } catch (e) {
      writeDefects(root, jobId, [{ chapter: chapter.id, code: e.code ?? 'COMPOSE_FAILED', detail: e.detail ?? String(e.message) }], 'add_source_material')
      record('DRAFTING', { verdict: 'FIXING', chapter: chapter.id })
      return finish('FIXING', { blocked_reason: e.code ?? 'COMPOSE_FAILED' })
    }
    const qa = core.qaChapter({ chapter, text: composed.text, bible })
    writeRel(root, `chapters/${chapter.id}/draft.md`, composed.text)
    writeJsonRel(root, `chapters/${chapter.id}/review.json`, { chapter: chapter.id, qa, source_map: composed.source_map, at: new Date().toISOString() })
    drafts.push({ chapter, ...composed, qa })
  }
  record('DRAFTING', { verdict: 'PASS', chapters: drafts.length })
  checkpoint('DRAFTING')

  // ── QA ────────────────────────────────────────────────────────────────────
  const failures = drafts.filter((item) => !item.qa.ok)
  const chapterManifest = {
    job_id: jobId,
    chapters: drafts.map((item) => ({
      id: item.chapter.id,
      title: item.chapter.title,
      draft_sha256: core.sha256(item.text),
      qa_ok: item.qa.ok,
      findings: item.qa.findings.length,
      source_refs: item.chapter.source_refs,
    })),
  }
  writeJsonRel(root, 'manifest/chapter-manifest.json', chapterManifest)
  state.chapter_manifest = chapterManifest
  record('QA', { verdict: failures.length === 0 ? 'PASS' : 'FIXING' })
  if (failures.length > 0) {
    writeDefects(root, jobId, failures.flatMap((item) => item.qa.findings.map((finding) => ({ chapter: item.chapter.id, ...finding }))), 'fix_source_or_contract')
    return finish('FIXING', { blocked_reason: 'QA_FAILED' })
  }
  checkpoint('QA')

  // 账本按章追加（不是只在 ingest 写两行）；重入时按 kind:chapter:id 去重。
  for (const item of drafts) {
    appendLedgerOnce(root, 'ledgers/terminology.jsonl', [{ chapter: item.chapter.id, kind: 'terminology', term: item.chapter.must_include[0].slice(0, 20), form: item.chapter.must_include[0].slice(0, 20) }])
    appendLedgerOnce(root, 'ledgers/timeline.jsonl', [{ chapter: item.chapter.id, kind: 'timeline', event: `第 ${Number(item.chapter.id)} 节` }])
    appendLedgerOnce(root, 'ledgers/facts.jsonl', [{ chapter: item.chapter.id, kind: 'fact', source: item.chapter.source_refs[0] ?? null }])
  }
  appendLedgerOnce(root, 'ledgers/foreshadow.jsonl', [
    { chapter: '001', kind: 'foreshadow_open', id: 'FS-001' },
    { chapter: drafts.at(-1).chapter.id, kind: 'foreshadow_close', id: 'FS-001' },
  ])

  // ── FULL_REVIEW：一致性 + 来源 + 账本 ─────────────────────────────────────
  const reviewChapters = drafts.map((item) => ({ id: item.chapter.id, title: item.chapter.title, text: item.text, source_map: item.source_map }))
  const review = core.fullReview({ chapters: reviewChapters, outline, sourceManifest })
  const ledgerEvents = readJsonl(root, 'ledgers/foreshadow.jsonl').concat(readJsonl(root, 'ledgers/timeline.jsonl'), readJsonl(root, 'ledgers/terminology.jsonl'))
  const ledgerReview = core.reviewLedgers({ chapters: reviewChapters, events: ledgerEvents })
  const findings = [...review.findings, ...ledgerReview.findings]
  const reviewOk = review.ok && ledgerReview.ok
  const style = core.traceStyle({ styleNotes: bible.style_guide.notes, chapters: reviewChapters })
  writeJsonRel(root, 'review/full-book-report.json', { job_id: jobId, ok: reviewOk, checks: review.checks, ledger: { ok: ledgerReview.ok, chapters: ledgerReview.chapters, events: ledgerReview.events }, findings, at: new Date().toISOString() })
  writeJsonRel(root, 'review/style-traceability.json', { job_id: jobId, notes: style, at: new Date().toISOString() })
  record('FULL_REVIEW', { verdict: reviewOk ? 'PASS' : 'FIXING', ledger_events: ledgerReview.events })
  if (!reviewOk) {
    writeDefects(root, jobId, findings, 'fix_consistency')
    return finish('FIXING', { blocked_reason: 'FULL_REVIEW_FAILED' })
  }
  checkpoint('FULL_REVIEW')
  if (!approvals.full_review) {
    writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'FULL_REVIEW' })
    return finish('FULL_REVIEW', { pending_approval: 'full_review' })
  }
  for (const item of drafts.slice(1)) {
    commitChapter({ root, store, jobId, chapter: item.chapter, text: item.text, qa: item.qa, sourceMap: item.source_map })
    state.committed = [...(state.committed ?? []), item.chapter.id]
  }

  // ── EXPORT_READY / EXPORTING：审批绑定候选稿 hash ──────────────────────────
  const allText = drafts.map((item) => item.text).join('\n\n')
  const secretHits = core.scanSecrets(allText)
  writeJsonRel(root, '.job/secret-scan.json', { job_id: jobId, hits: secretHits, at: new Date().toISOString() })
  if (secretHits.length > 0) return finish('BLOCKED', { blocked_reason: 'SECRET_FOUND' })
  core.assertCommitted({ bookDir: root, chapterIds: drafts.map((item) => item.chapter.id) })
  const candidate = core.buildMarkdown({ title: bible.title, chapters: drafts.map((item) => ({ id: item.chapter.id, title: item.chapter.title, text: item.text })) })
  const candidateHash = core.sha256(candidate)
  // 先读盘上已有候选稿再覆盖：否则“改完候选稿”会被本次重新生成抹平，旧审批就又对上了。
  const candidatePath = p(root, 'export/candidate.md')
  const existingCandidateHash = fs.existsSync(candidatePath) ? core.sha256(fs.readFileSync(candidatePath)) : null
  if (state.pending_export_hash && existingCandidateHash && existingCandidateHash !== state.pending_export_hash) {
    record('EXPORTING', { verdict: 'BLOCKED', reason: 'APPROVAL_HASH_MISMATCH', detail: '候选稿被改动' })
    return finish('BLOCKED', { blocked_reason: 'APPROVAL_HASH_MISMATCH' })
  }
  writeRel(root, 'export/candidate.md', candidate)
  if (!state.pending_export_hash) {
    state.pending_export_hash = candidateHash
    core.writeJsonAtomic(store.stateFile, state)
    record('EXPORT_READY', { verdict: 'PENDING_APPROVAL', candidate_hash: candidateHash })
    checkpoint('EXPORT_READY')
    writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'EXPORT', candidate_hash: candidateHash })
    return finish('EXPORT_READY', { pending_approval: 'export', candidate_hash: candidateHash })
  }
  if (state.pending_export_hash !== candidateHash) {
    record('EXPORTING', { verdict: 'BLOCKED', reason: 'APPROVAL_HASH_MISMATCH' })
    return finish('BLOCKED', { blocked_reason: 'APPROVAL_HASH_MISMATCH' })
  }
  if (!approvals.export) {
    writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'EXPORT', candidate_hash: candidateHash })
    return finish('EXPORT_READY', { pending_approval: 'export', candidate_hash: candidateHash })
  }
  const exported = { path: 'export/book.md', sha256: candidateHash, bytes: Buffer.byteLength(candidate), unsupported: ['docx', 'pdf', 'epub'], unsupported_reason: '本机无对应导出适配器（方案 §8：标 UNSUPPORTED）' }
  writeRel(root, exported.path, candidate)
  const approvalRecord = { kind: 'EXPORT', hash: candidateHash, at: new Date().toISOString(), job_id: jobId }
  writeJsonRel(root, '.job/export-approval.json', approvalRecord)
  record('EXPORTING', { verdict: 'PASS', export_hash: candidateHash })

  // ── 完成判定：证据齐备 + 门禁通过（AC-14/AC-19 真正接线）──────────────────
  const artifacts = listArtifacts(root).filter((artifact) => !artifact.path.startsWith('.dsh/'))
  const gates = [
    { id: 'full_review', ok: reviewOk },
    { id: 'secret_scan', ok: secretHits.length === 0 },
    { id: 'export_approval', ok: approvalRecord.hash === candidateHash },
  ]
  const completion = core.completionVerdict({ evidenceRefs: artifacts.map((artifact) => `file:${artifact.path}`), gates, chain: evidence.chain })
  if (!completion.ok) {
    record('EXPORTING', { verdict: 'BLOCKED', reason: 'COMPLETION_EVIDENCE_MISSING', missing: completion.missing })
    return finish('BLOCKED', { blocked_reason: 'COMPLETION_EVIDENCE_MISSING' })
  }

  const deliverable = {
    schema_version: '1.0.0',
    job_id: jobId,
    generated_at: new Date().toISOString(),
    artifacts: [
      ...drafts.map((item) => ({ path: `chapters/${item.chapter.id}/commit.md`, sha256: core.sha256(item.text) })),
      { path: exported.path, sha256: exported.sha256 },
      { path: 'manifest/source-manifest.json', sha256: core.sha256(fs.readFileSync(p(root, 'manifest/source-manifest.json'))) },
    ],
    unsupported: exported.unsupported,
    export_approval: approvalRecord,
  }
  const deliverableErrors = core.validateContract('deliverable', deliverable)
  if (deliverableErrors.length > 0) return finish('BLOCKED', { blocked_reason: 'DELIVERABLE_INVALID', deliverable_errors: deliverableErrors })
  writeJsonRel(root, 'manifest/deliverable-manifest.json', deliverable)

  const egressSummary = egress.summary()
  recordEvidence('EGRESS', egressSummary)
  writeJsonRel(root, 'reports/eight-part-report.json', core.buildEightPartReport(buildReportInput({ drafts, review, style, exported, secretHits, bible, egress: egressSummary, ledgerReview })))
  record('COMPLETED', { verdict: 'PASS', export_hash: candidateHash })
  writeJsonRel(root, '.job/evidence.json', { chain: evidence.chain, verified: core.verifyEvidenceChain(evidence.chain) })
  writeJsonRel(root, '.dsh/evidence/run.json', { job_id: jobId, chain_length: evidence.chain.length, chain_head: evidence.chain.at(-1)?.hash ?? null, artifacts })
  writeJsonRel(root, '.dsh/completion.json', { job_id: jobId, status: 'COMPLETED', acceptance: core.PLAN_ACCEPTANCE.length, gates, completion, export: { path: exported.path, sha256: exported.sha256 } })

  const keyDir = options.attestKeyDir ?? process.env.OCB_ATTEST_KEYDIR ?? defaultKeyDir()
  const anchor = signChain({ chain: evidence.chain, keyDir, meta: { job_id: jobId, artifact_root_sha256: core.sha256(JSON.stringify(deliverable)), git: gitAnchorInfo(root) } })
  writeJsonRel(root, `.dsh/anchors/${anchor.chain_head.slice(0, 16)}.json`, anchor)
  appendAnchorLog(path.join(root, '.dsh/anchors'), anchor)
  const attestation = verifyAnchor({ anchor, chain: evidence.chain })
  writeJsonRel(root, '.job/attestation.json', { anchor, verification: attestation })

  store.event('completed', { job_id: jobId, export_sha256: exported.sha256, anchor: anchor.chain_head })
  return finish('COMPLETED', {
    export: exported,
    deliverable,
    review,
    ledger: ledgerReview,
    style,
    chapter_manifest: core.readJson(p(root, 'manifest/chapter-manifest.json')),
    bible,
    outline,
    egress: egressSummary,
    attestation: { anchor, verification: attestation },
    completion,
  })
}

function readJsonl(root, rel) {
  try {
    return fs.readFileSync(p(root, rel), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function writeDefects(root, jobId, defects, action) {
  writeJsonRel(root, 'review/defect-list.json', { job_id: jobId, at: new Date().toISOString(), defects })
  writeJsonRel(root, 'review/repair-package.json', {
    job_id: jobId,
    action,
    hint: '按 defects 修复来源/契约/内容后 POST /retry（会从 PREFLIGHT 重入并保留旧证据）',
    defect_refs: [...new Set(defects.map((defect) => defect.code ?? defect.chapter))],
  })
}

function commitChapter({ root, store, jobId, chapter, text, qa, sourceMap }) {
  const rel = `chapters/${chapter.id}/commit.md`
  const abs = p(root, rel)
  const existing = core.readJson(p(root, `chapters/${chapter.id}/commit.json`), null)
  const hash = core.sha256(text)
  if (existing && existing.sha256 === hash && fs.existsSync(abs)) {
    store.event('chapter_unchanged', { job_id: jobId, chapter: chapter.id, sha256: hash })
    return { skipped: true, sha256: hash }
  }
  if (fs.existsSync(abs)) {
    fs.mkdirSync(p(root, 'versions'), { recursive: true })
    fs.copyFileSync(abs, p(root, `versions/${chapter.id}-${core.sha256(fs.readFileSync(abs))}.md`))
  }
  writeRel(root, rel, text)
  writeJsonRel(root, `chapters/${chapter.id}/commit.json`, { chapter: chapter.id, sha256: hash, qa_ok: qa.ok, source_map: sourceMap, approved_at: new Date().toISOString(), job_id: jobId })
  store.event('chapter_committed', { job_id: jobId, chapter: chapter.id, sha256: hash })
  return { skipped: false, sha256: hash }
}

function probeAdapter(client) {
  if (!client) return 'ABSENT'
  try {
    const verdict = typeof client.health === 'function' ? client.health() : true
    return verdict === false ? 'DEGRADED' : 'OK'
  } catch {
    return 'DEGRADED'
  }
}

/**
 * 定点修改：保留旧版本、产出影响图、并把门禁退回到 FULL_REVIEW。
 * 没有这一步，AC-17 只是“函数存在”（审查 P1-3）。
 */
export function applyPointEdit({ root, chapterId, text, reason = 'point-edit' }) {
  const store = new JobStore({ root })
  const state = store.state()
  if (!state) {
    const err = new Error('没有可编辑的 job')
    err.code = 'NO_JOB'
    throw err
  }
  const abs = p(root, `chapters/${chapterId}/commit.md`)
  if (!fs.existsSync(abs)) {
    const err = new Error(`章节不存在或未 commit：${chapterId}`)
    err.code = 'CHAPTER_NOT_COMMITTED'
    throw err
  }
  const oldText = fs.readFileSync(abs, 'utf8')
  const oldHash = core.sha256(oldText)
  fs.mkdirSync(p(root, 'versions'), { recursive: true })
  fs.copyFileSync(abs, p(root, `versions/${chapterId}-${oldHash}.md`))
  writeRel(root, `chapters/${chapterId}/commit.md`, text)
  writeRel(root, `chapters/${chapterId}/draft.md`, text)
  writeJsonRel(root, `chapters/${chapterId}/commit.json`, { chapter: chapterId, sha256: core.sha256(text), edited_at: new Date().toISOString(), reason, previous_sha256: oldHash })
  const manifest = core.readJson(p(root, 'manifest/chapter-manifest.json'), { chapters: [] })
  const graph = core.impactGraph({ chapterId, chapters: manifest.chapters.map((chapter) => ({ id: chapter.id })) })
  writeJsonRel(root, '.job/impact-graph.json', { at: new Date().toISOString(), chapter: chapterId, reason, previous_sha256: oldHash, ...graph })
  store.saveState({
    ...state,
    status: 'FULL_REVIEW',
    pending_export_hash: null,
    approvals: { ...state.approvals, full_review: false, export: false },
    progress: progressOf({ ...state, status: 'FULL_REVIEW' }),
  })
  store.event('point_edit', { job_id: state.job_id, chapter: chapterId, previous_sha256: oldHash })
  return { ok: true, graph, requires: ['FULL_REVIEW', 'EXPORT'], rollback: `versions/${chapterId}-${oldHash}.md` }
}

/** 完成后的发布通道：默认关闭，需要单独审批（方案 publish_default: false）。 */
export function publishJob({ root, approvals = {} }) {
  if (approvals.publish !== true) {
    const err = new Error('PUBLISH 默认关闭：需要单独的发布审批（approvals.publish=true 且由作者发起）')
    err.code = 'PUBLISH_DISABLED'
    throw err
  }
  const store = new JobStore({ root })
  const state = store.state()
  if (!state || state.status !== 'COMPLETED') {
    const err = new Error('只有 COMPLETED 的 job 才能发布')
    err.code = 'NOT_COMPLETED'
    throw err
  }
  const err = new Error('本机没有发布适配器：不生成空发布记录（方案 §8 UNSUPPORTED）')
  err.code = 'PUBLISH_UNSUPPORTED'
  throw err
}

export function jobStatus({ root }) {
  const store = new JobStore({ root })
  const state = store.state()
  const control = store.control()
  const events = (() => {
    try {
      return fs.readFileSync(store.eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  })()
  return {
    job: state,
    progress: progressOf(state),
    control,
    jobs: store.jobs(),
    events,
    artifacts: listArtifacts(root),
    pending_approval: state?.pending_approval ?? null,
  }
}

export function retryJob({ root, approvals = {} }) {
  const store = new JobStore({ root })
  const state = store.state()
  if (!state) {
    const err = new Error('没有可重试的 job')
    err.code = 'NO_JOB'
    throw err
  }
  if (!['FIXING', 'BLOCKED', 'FAILED'].includes(state.status)) {
    const err = new Error(`当前状态不可重试：${state.status}`)
    err.code = 'NOT_RETRYABLE'
    throw err
  }
  // 统一走 runJob 的重试分支：它负责 attempts+1 与 stage_history 重置，避免两处各自计数。
  store.saveState({ ...state, status: 'FIXING', blocked_reason: null })
  store.event('retry_requested', { job_id: state.job_id, previous_status: state.status })
  return runJob({ root, idempotencyKey: state.idempotency_key, brief: state.brief, approvals: { ...state.approvals, ...approvals } })
}

function buildReadme({ bible, outline, brief }) {
  return [
    `# ${bible.title}`,
    '',
    `- 书籍类型：${bible.book_kind}`,
    `- 目标：${bible.goal}`,
    `- 语言/受众：${bible.language} / ${bible.audience}`,
    `- 章节数：${outline.chapters.length}`,
    `- 来源：${(brief.sources ?? []).join('、')}`,
    '',
    '## 目录',
    '',
    ...outline.chapters.map((chapter, i) => `${i + 1}. ${chapter.title}（${chapter.id}）`),
    '',
    '## 产物说明',
    '',
    '- `contract/`：任务契约与需求映射（生成即 schema 校验）',
    '- `manifest/`：来源、章节、交付物清单（每项带 sha256）',
    '- `chapters/<id>/`：contract / draft / review / commit 四件套',
    '- `ledgers/`：术语、事实、时间线、伏笔账本（按章追加）',
    '- `review/`：全书复审与风格追踪',
    '- `reports/`：八部分报告',
    '- `export/book.md`：已提交内容的导出（审批 hash 绑定）',
    '',
  ].join('\n')
}

function buildProcessLog({ jobId, brief, outline, createdAt }) {
  return [
    '# 过程记录',
    '',
    `- job_id：${jobId}`,
    `- 创建时间：${createdAt}`,
    `- 触发方式：一次触发（idempotency_key 幂等）`,
    `- 书籍类型：${brief.book_kind}`,
    `- 目标：${brief.goal}`,
    '',
    '## 阶段事实',
    '',
    '1. PREFLIGHT：校验必填输入与预算上限；缺输入只进入 WAITING_CONFIRMATION。',
    '2. INGESTING：来源路径策略、大小上限、UTF-8 校验、凭据扫描全部先于正文写盘。',
    '3. NORMALIZED：规范化文本并登记来源 hash。',
    `4. OUTLINED：生成 book bible、目录与 ${outline.chapters.length} 份章节契约，契约过 schema。`,
    '5. EXEMPLAR_REVIEW：范例章先审后批，批准前不批量写章。',
    '6. DRAFTING/QA：逐章生成与检查，写账本增量。',
    '7. FULL_REVIEW：全书一致性 + 来源 + 账本复核，需逐章口径的批准。',
    '8. EXPORT_READY/EXPORTING：候选稿 hash 与审批绑定，未绑定不放行。',
    '9. COMPLETED：证据链校验 + Ed25519 锚 + 仓库锚后才写完成态。',
    '',
  ].join('\n')
}

function buildReportInput({ drafts, review, style, exported, secretHits, bible, egress, ledgerReview }) {
  return {
    scope: {
      what: '一键成书核心流水线 + 增强层（确定性离线生成）',
      not_included: ['远程模型生成', 'docx/pdf/epub 导出', '外部发布'],
      title: bible.title,
      chapters: drafts.length,
    },
    design: {
      state_machine: 'RECEIVED→PREFLIGHT→INGESTING→NORMALIZED→OUTLINED→EXEMPLAR_REVIEW→DRAFTING→QA→FULL_REVIEW→EXPORT_READY→EXPORTING→COMPLETED',
      forbidden: '禁止 DRAFTING→COMPLETED 直跳；失败只能进 FIXING/BLOCKED',
      generation: '抽取式组装（不调用模型，零计费，可离线复现）',
      history: 'stage_history 只追加真实发生的阶段（P1-1 修复）',
    },
    changes: { files: ['ai/one-click-book/core.mjs', 'ai/one-click-book/job.mjs', 'ai/one-click-book/http.mjs', 'ai/one-click-book/egress.mjs', 'ai/one-click-book/attest.mjs', 'public/one-click-book.js', 'server.js', 'public/index.html'] },
    tests: { verifier: 'scripts/test-one-click-book.mjs', acceptance: `AC-01..AC-${core.PLAN_ACCEPTANCE.length}` },
    security: {
      secret_scan: { hits: secretHits.length, ingest_time: true, patterns: ['aws-access-key', 'openai-style-key', 'private-key-block', 'password-assignment', 'token-assignment', 'high-entropy-token'] },
      source_policy: '拒绝 dotfile / secrets / credentials / .env 命名，单文件 8MB、总量 32MB，非 UTF-8 阻断',
      egress: { policy: egress?.policy ?? 'deny-by-default', allowlist: egress?.allowlist ?? [], attempts: egress?.attempts ?? 0, denied: egress?.denied ?? 0 },
      attestation: 'Ed25519 分离签名 + 仓库锚；第三方 TSA 记 UNSUPPORTED',
      approval: 'EXPORT 审批与候选稿 sha256 绑定',
    },
    performance: { mode: 'offline', model_calls: 0, chapters: drafts.length },
    cost: { cny: 0, note: '零模型调用；仅本地 CPU' },
    risks_and_handoff: {
      full_review_ok: review.ok,
      ledger_ok: ledgerReview.ok,
      ledger_events: ledgerReview.events,
      style_notes_traced: style.length,
      export: { path: exported.path, sha256: exported.sha256, unsupported: exported.unsupported },
      rollback: '删除 book-project/ 或从 versions/ 还原章节；job 状态可 retry',
    },
  }
}
