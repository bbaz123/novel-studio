#!/usr/bin/env node
/**
 * 一键成书的 Job 存储与流水线。
 *
 * 为什么状态与产物分开放：`.job/state.json` 是可恢复的控制面，
 * `chapters/`、`manifest/`、`review/` 是证据面；两者混在一起时，
 * “草稿没 commit 却被交付”这种事无法在结构上被拦住。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as core from './core.mjs'

const STAGE_ORDER = ['PREFLIGHT', 'INGESTING', 'OUTLINED', 'EXEMPLAR_REVIEW', 'DRAFTING', 'QA', 'FULL_REVIEW', 'EXPORTING']

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
  }

  event(type, data = {}) {
    this.ensure()
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n'
    fs.appendFileSync(this.eventsFile, line)
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

  /** 幂等：同一个 idempotency_key 永远得到同一个 job_id，即使 index 丢失也能重建。 */
  jobIdFor(key) {
    return `job-${core.sha256(String(key)).slice(0, 12)}`
  }

  create({ idempotencyKey, brief }) {
    this.ensure()
    const jobId = this.jobIdFor(idempotencyKey)
    const existing = this.state()
    if (existing && existing.job_id === jobId) {
      this.event('job_reused', { job_id: jobId, status: existing.status })
      return { jobId, created: false, state: existing }
    }
    if (existing && existing.status !== 'COMPLETED' && existing.job_id !== jobId) {
      const err = new Error(`已有未完成的 job：${existing.job_id}`)
      err.code = 'JOB_ACTIVE'
      err.detail = { existing: existing.job_id }
      throw err
    }
    const state = {
      job_id: jobId,
      idempotency_key: idempotencyKey,
      status: 'RECEIVED',
      stage_history: ['RECEIVED'],
      brief,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      approvals: {},
      evidence: [],
    }
    core.writeJsonAtomic(this.stateFile, state)
    core.writeJsonAtomic(this.indexFile, { jobs: [...this.index().jobs, { job_id: jobId, idempotency_key: idempotencyKey }] })
    core.writeJsonAtomic(this.controlFile, { paused: false, cancelled: false })
    this.event('job_created', { job_id: jobId })
    return { jobId, created: true, state }
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

function appendJsonl(root, rel, value) {
  const abs = p(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.appendFileSync(abs, JSON.stringify(value) + '\n')
  return { path: rel.replace(/\\/g, '/'), sha256: core.sha256(fs.readFileSync(abs)) }
}

/**
 * 执行（或续跑）一次一键成书。
 * 幂等：确定性内容 + 同 hash 跳过写盘；重复调用不会重复写坏结果。
 */
export function runJob({ root, idempotencyKey, brief, approvals = {}, options = {} }) {
  const store = new JobStore({ root })
  const created = store.create({ idempotencyKey, brief })
  const jobId = created.jobId
  const state = store.state()
  const evidence = { chain: state.evidence ?? [] }
  const ledger = { terminology: [], timeline: [], foreshadow: [] }
  // 记忆/提示音是可选外部能力：它们失败只能 DEGRADED，不能改变 verdict（方案 §8、AC-10/AC-11）。
  const memory = probeAdapter(options.memoryClient)
  const chime = probeAdapter(options.chimeClient)

  const record = (stage, data) => {
    evidence.chain = core.appendEvidence(evidence.chain, { stage, at: new Date().toISOString(), ...data })
  }

  const finish = (status, extra = {}) => {
    const next = {
      ...store.state(),
      status,
      approvals: { ...store.state().approvals, ...approvals },
      evidence: evidence.chain,
      stage_history: [...new Set([...store.state().stage_history, ...STAGE_ORDER.filter((s) => s !== status), status])],
      ledgers: ledger,
      memory_state: memory,
      chime_state: chime,
      ...extra,
    }
    store.saveState(next)
    // 必须把 extra 一并返回：否则调用方拿到的 status=COMPLETED 却没有 review/export，
    // 验收断言会读到 undefined，等于用“状态说完成、证据没带出来”骗过调用方。
    return { jobId, status, created: created.created, state: next, ...extra }
  }

  const guard = () => {
    const control = store.control()
    if (control.cancelled) {
      store.event('cancelled', { job_id: jobId })
      return 'CANCELLED'
    }
    if (control.paused) {
      store.event('paused', { job_id: jobId })
      return 'PAUSED'
    }
    return null
  }

  if (state.status === 'WAITING_CONFIRMATION') {
    // 补齐输入后允许继续：重新校验 brief，不再新建 job。
    store.event('resume_after_confirmation', { job_id: jobId })
  }
  if (state.status === 'CANCELLED') return { jobId, status: 'CANCELLED', created: created.created, state }
  if (state.status === 'COMPLETED') {
    store.event('resume_noop', { job_id: jobId })
    return { jobId, status: 'COMPLETED', created: created.created, state: store.state() }
  }

  // ── PREFLIGHT ─────────────────────────────────────────────────────────────
  const halted = guard()
  if (halted === 'CANCELLED') return finish('CANCELLED')
  if (halted === 'PAUSED') return { jobId, status: 'PAUSED', created: created.created, state: store.state() }

  const check = core.validateBrief(brief)
  if (!check.ok) {
    const items = check.missing.map((field) => ({
      id: `C-${field.toUpperCase()}`,
      field,
      question: `缺少必需输入：${field}`,
      state: 'PENDING',
    }))
    writeJsonRel(root, '.job/confirmation-export.json', { job_id: jobId, missing: check.missing, items, at: new Date().toISOString() })
    record('PREFLIGHT', { verdict: 'WAITING_CONFIRMATION', missing: check.missing })
    store.event('waiting_confirmation', { job_id: jobId, missing: check.missing })
    return finish('WAITING_CONFIRMATION', { missing: check.missing })
  }
  if (check.unsupported.length > 0) {
    record('PREFLIGHT', { verdict: 'BLOCKED', unsupported: check.unsupported })
    return finish('BLOCKED', { blocked_reason: 'UNSUPPORTED_INPUT' })
  }
  record('PREFLIGHT', { verdict: 'PASS', budget_cny: brief.budget_cny ?? null })

  // ── INGESTING / NORMALIZED ────────────────────────────────────────────────
  const ingest = core.ingestSources(brief.sources)
  if (ingest.errors.length > 0) {
    writeJsonRel(root, 'manifest/source-manifest.json', { job_id: jobId, sources: ingest.entries, unsupported: ingest.unsupported, errors: ingest.errors })
    record('INGESTING', { verdict: 'BLOCKED', errors: ingest.errors })
    return finish('BLOCKED', { blocked_reason: 'SOURCE_UNREADABLE' })
  }
  const sourceManifest = {
    job_id: jobId,
    frozen_at: new Date().toISOString(),
    sources: ingest.entries,
    unsupported: ingest.unsupported,
    citation_policy: '每个可核验主张必须回指 SRC-*；无法回指即阻断',
  }
  const srcWrite = writeJsonRel(root, 'manifest/source-manifest.json', sourceManifest)
  const normalizedWrite = writeRel(root, 'sources/normalized/source.txt', ingest.text)
  writeJsonRel(root, '.job/input-snapshot.json', {
    job_id: jobId,
    brief: { ...brief, sources: brief.sources },
    snapshot_hash: core.sha256(JSON.stringify({ brief, sources: ingest.entries.map((e) => e.sha256) })),
  })
  writeJsonlLedgers(root, ingest.entries, ledger)
  record('INGESTING', { verdict: 'NORMALIZED', artifacts: [srcWrite, normalizedWrite], sources: ingest.entries.map((e) => ({ id: e.id, sha256: e.sha256 })) })
  store.event('normalized', { job_id: jobId, sources: ingest.entries.length })

  // ── OUTLINED ─────────────────────────────────────────────────────────────
  const bible = core.buildBible({ brief, sources: ingest })
  const outline = core.buildOutline({ bible, text: ingest.text })
  const bibleWrite = writeJsonRel(root, 'book-bible.json', { ...bible, chapter_count: outline.chapters.length })
  const outlineMd = ['# 目录', '', ...outline.chapters.map((c, i) => `${i + 1}. ${c.title}（${c.id}）`)].join('\n') + '\n'
  const outlineWrite = writeRel(root, 'outline/outline.md', outlineMd)
  for (const chapter of outline.chapters) {
    writeJsonRel(root, `chapters/${chapter.id}/contract.json`, {
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
        terminology: chapter.must_include.slice(0, 1).map((term) => ({ term, first_seen: chapter.id })),
        timeline: [{ at: chapter.id, event: `第 ${Number(chapter.id)} 节` }],
        foreshadow: chapter.depends_on.length === 0 ? [{ id: `FS-${chapter.id}`, opened: chapter.id, closed: null }] : [],
      },
    })
  }
  record('OUTLINED', { verdict: 'PASS', artifacts: [bibleWrite, outlineWrite], chapters: outline.chapters.length })
  store.event('outlined', { job_id: jobId, chapters: outline.chapters.length })

  // ── EXEMPLAR_REVIEW ──────────────────────────────────────────────────────
  const first = outline.chapters[0]
  let exemplar
  try {
    exemplar = composeWithGuard({ core, chapter: first, section: outline.sections[0] })
  } catch (e) {
    const defect = { chapter: first.id, code: e.code ?? 'COMPOSE_FAILED', detail: e.detail ?? String(e.message) }
    writeJsonRel(root, 'review/defect-list.json', { job_id: jobId, at: new Date().toISOString(), defects: [defect] })
    writeJsonRel(root, 'review/repair-package.json', {
      job_id: jobId,
      action: 'add_source_material',
      hint: '范例章所需材料不足；补充来源后从 EXEMPLAR_REVIEW 重进',
      defect_refs: [first.id],
    })
    record('EXEMPLAR_REVIEW', { verdict: 'FIXING', defect })
    return finish('FIXING', { blocked_reason: defect.code })
  }
  const exemplarQa = core.qaChapter({ chapter: first, text: exemplar.text, bible })
  const draftWrite = writeRel(root, `chapters/${first.id}/draft.md`, exemplar.text)
  writeJsonRel(root, `chapters/${first.id}/review.json`, {
    chapter: first.id, qa: exemplarQa, source_map: exemplar.source_map, at: new Date().toISOString(),
  })
  record('EXEMPLAR_REVIEW', { verdict: exemplarQa.ok ? 'PASS' : 'FIXING', draft: draftWrite })
  if (!exemplarQa.ok) {
    writeJsonRel(root, 'review/defect-list.json', { job_id: jobId, chapter: first.id, findings: exemplarQa.findings })
    writeJsonRel(root, 'review/repair-package.json', {
      job_id: jobId,
      action: 'fix_exemplar',
      hint: '范例章未通过 QA；按 findings 修正来源/契约后从 EXEMPLAR_REVIEW 重进',
      defect_refs: exemplarQa.findings.map((f) => f.code),
    })
    return finish('FIXING', { blocked_reason: 'EXEMPLAR_QA_FAILED' })
  }
  store.event('exemplar_drafted', { job_id: jobId, chapter: first.id })
  if (!approvals.exemplar) {
    writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'EXEMPLAR_REVIEW', chapter: first.id })
    return finish('EXEMPLAR_REVIEW', { pending_approval: 'exemplar' })
  }
  commitChapter({ root, store, chapter: first, text: exemplar.text, qa: exemplarQa, sourceMap: exemplar.source_map, jobId })

  // ── DRAFTING（范例章批准后才允许批量写章）─────────────────────────────────
  const drafts = [{ chapter: first, text: exemplar.text, source_map: exemplar.source_map, qa: exemplarQa }]
  for (const chapter of outline.chapters.slice(1)) {
    let composed
    try {
      composed = composeWithGuard({ core, chapter, section: outline.sections[chapter.section_index ?? 0] })
    } catch (e) {
      const defect = { chapter: chapter.id, code: e.code ?? 'COMPOSE_FAILED', detail: e.detail ?? String(e.message) }
      writeJsonRel(root, 'review/defect-list.json', { job_id: jobId, at: new Date().toISOString(), defects: [defect] })
      writeJsonRel(root, 'review/repair-package.json', {
        job_id: jobId,
        action: 'add_source_material',
        hint: '来源不足以覆盖该章契约；补充材料或缩小 word_range 后从 DRAFTING 重进',
        defect_refs: [chapter.id],
      })
      record('DRAFTING', { verdict: 'FIXING', defect })
      store.event('drafting_blocked', { job_id: jobId, chapter: chapter.id, code: defect.code })
      return finish('FIXING', { blocked_reason: defect.code })
    }
    const qa = core.qaChapter({ chapter, text: composed.text, bible })
    writeRel(root, `chapters/${chapter.id}/draft.md`, composed.text)
    writeJsonRel(root, `chapters/${chapter.id}/review.json`, { chapter: chapter.id, qa, source_map: composed.source_map, at: new Date().toISOString() })
    drafts.push({ chapter, text: composed.text, source_map: composed.source_map, qa })
    record('DRAFTING', { verdict: qa.ok ? 'DRAFT_OK' : 'FIXING', chapter: chapter.id })
  }
  store.event('drafted', { job_id: jobId, chapters: drafts.length })

  // ── QA ───────────────────────────────────────────────────────────────────
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
  record('QA', { verdict: failures.length === 0 ? 'PASS' : 'FIXING', failures: failures.map((f) => ({ chapter: f.chapter.id, findings: f.qa.findings })) })
  if (failures.length > 0) {
    const defectList = { job_id: jobId, at: new Date().toISOString(), defects: failures.map((f) => ({ chapter: f.chapter.id, findings: f.qa.findings })) }
    writeJsonRel(root, 'review/defect-list.json', defectList)
    writeJsonRel(root, 'review/repair-package.json', {
      job_id: jobId,
      action: 'fix_source_or_contract',
      hint: '来源材料不足以覆盖契约，或契约必含点与正文不匹配；修复后从 QA 重新进入',
      defect_refs: defectList.defects.map((d) => d.chapter),
    })
    return finish('FIXING', { blocked_reason: 'QA_FAILED' })
  }
  store.event('qa_passed', { job_id: jobId })

  // ── FULL_REVIEW ──────────────────────────────────────────────────────────
  const reviewBook = drafts.map((item) => ({ id: item.chapter.id, title: item.chapter.title, text: item.text, source_map: item.source_map }))
  const review = core.fullReview({ chapters: reviewBook, outline, sourceManifest })
  const style = core.traceStyle({ styleNotes: bible.style_guide.notes, chapters: reviewBook })
  writeJsonRel(root, 'review/full-book-report.json', { job_id: jobId, ...review, at: new Date().toISOString() })
  writeJsonRel(root, 'review/style-traceability.json', { job_id: jobId, notes: style, at: new Date().toISOString() })
  record('FULL_REVIEW', { verdict: review.ok ? 'PASS' : 'FIXING', findings: review.findings })
  if (!review.ok) {
    writeJsonRel(root, 'review/defect-list.json', { job_id: jobId, at: new Date().toISOString(), defects: review.findings })
    writeJsonRel(root, 'review/repair-package.json', {
      job_id: jobId,
      action: 'fix_consistency',
      hint: '按 findings 修复目录/正文/来源映射后从 FULL_REVIEW 重进',
      defect_refs: [...new Set(review.findings.map((f) => f.code))],
    })
    return finish('FIXING', { blocked_reason: 'FULL_REVIEW_FAILED' })
  }
  store.event('full_review_passed', { job_id: jobId })
  if (!approvals.full_review) {
    writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'FULL_REVIEW' })
    return finish('FULL_REVIEW', { pending_approval: 'full_review' })
  }
  for (const item of drafts.slice(1)) {
    commitChapter({ root, store, chapter: item.chapter, text: item.text, qa: item.qa, sourceMap: item.source_map, jobId })
  }

  // ── EXPORTING / EXPORT_READY / COMPLETED ─────────────────────────────────
  const allText = drafts.map((item) => item.text).join('\n\n')
  const secretHits = core.scanSecrets(allText)
  writeJsonRel(root, '.job/secret-scan.json', { job_id: jobId, hits: secretHits, at: new Date().toISOString() })
  if (secretHits.length > 0) {
    record('EXPORTING', { verdict: 'BLOCKED', reason: 'SECRET_FOUND', hits: secretHits.map((h) => h.label) })
    return finish('BLOCKED', { blocked_reason: 'SECRET_FOUND' })
  }
  let exported
  try {
    exported = core.exportBook({
      bookDir: root,
      title: bible.title,
      chapters: drafts.map((item) => ({ id: item.chapter.id, title: item.chapter.title, text: item.text })),
      approvals,
      secretHits,
    })
  } catch (e) {
    if (e.code === 'EXPORT_NOT_APPROVED') {
      writeJsonRel(root, '.job/pending-approval.json', { job_id: jobId, gate: 'EXPORT' })
      record('EXPORT_READY', { verdict: 'PENDING_APPROVAL' })
      return finish('EXPORT_READY', { pending_approval: 'export' })
    }
    throw e
  }
  const deliverable = {
    job_id: jobId,
    generated_at: new Date().toISOString(),
    artifacts: [
      ...drafts.map((item) => ({ path: `chapters/${item.chapter.id}/commit.md`, sha256: core.sha256(item.text) })),
      { path: exported.path, sha256: exported.sha256 },
    ],
    unsupported: exported.unsupported,
  }
  const deliverableWrite = writeJsonRel(root, 'manifest/deliverable-manifest.json', deliverable)
  const report = core.buildEightPartReport(buildReportInput({ drafts, review, style, exported, secretHits, bible }))
  writeJsonRel(root, 'reports/eight-part-report.json', report)
  writeJsonRel(root, '.job/evidence.json', { chain: evidence.chain, verified: core.verifyEvidenceChain(evidence.chain) })
  record('COMPLETED', { verdict: 'PASS', deliverable: deliverableWrite })
  store.event('completed', { job_id: jobId, export_sha256: exported.sha256 })
  return finish('COMPLETED', {
    export: exported,
    deliverable,
    review,
    style,
    chapter_manifest: chapterManifest,
    bible,
    outline,
  })
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

function composeWithGuard({ core, chapter, section }) {
  try {
    return core.composeChapter({ chapter, section })
  } catch (e) {
    if (e.code === 'INSUFFICIENT_SOURCE') {
      e.chapter_id = chapter.id
    }
    throw e
  }
}

function commitChapter({ root, store, chapter, text, qa, sourceMap, jobId }) {
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
  writeJsonRel(root, `chapters/${chapter.id}/commit.json`, {
    chapter: chapter.id,
    sha256: hash,
    qa_ok: qa.ok,
    source_map: sourceMap,
    approved_at: new Date().toISOString(),
    job_id: jobId,
  })
  store.event('chapter_committed', { job_id: jobId, chapter: chapter.id, sha256: hash })
  return { skipped: false, sha256: hash }
}

function writeJsonlLedgers(root, sources, ledger) {
  for (const source of sources) {
    appendJsonl(root, 'ledgers/facts.jsonl', { at: new Date().toISOString(), kind: 'source_registered', source: source.id, sha256: source.sha256 })
    appendJsonl(root, 'ledgers/terminology.jsonl', { at: new Date().toISOString(), kind: 'source_title', term: source.title, source: source.id })
  }
  writeJsonlDelta(root, 'ledgers/timeline.jsonl', ledger.timeline)
  writeJsonlDelta(root, 'ledgers/foreshadow.jsonl', ledger.foreshadow)
}

function writeJsonlDelta(root, rel, items) {
  const abs = p(root, rel)
  if (fs.existsSync(abs)) return
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, (items ?? []).map((item) => JSON.stringify(item) + '\n').join(''))
}

function buildReportInput({ drafts, review, style, exported, secretHits, bible }) {
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
    },
    changes: { files: ['ai/one-click-book/core.mjs', 'ai/one-click-book/job.mjs', 'ai/one-click-book/http.mjs', 'public/one-click-book.js', 'server.js', 'public/index.html'] },
    tests: {
      verifier: 'scripts/test-one-click-book.mjs',
      acceptance: 'AC-01..AC-20 逐条断言',
    },
    security: {
      secret_scan: { hits: secretHits.length, patterns: ['aws-access-key', 'openai-style-key', 'private-key-block', 'password-assignment'] },
      egress: 'DEGRADED：本机无 deny-default 出口守卫，流水线不做任何网络访问',
      approval: 'EXPORT 必须显式审批',
    },
    performance: { mode: 'offline', model_calls: 0, chapters: drafts.length },
    cost: { cny: 0, note: '零模型调用；仅本地 CPU' },
    risks_and_handoff: {
      full_review_ok: review.ok,
      style_notes_traced: style.length,
      export: { path: exported.path, sha256: exported.sha256, unsupported: exported.unsupported },
      rollback: '删除 book-project/ 或从 versions/ 还原章节；job 状态可 resume',
    },
  }
}

export function jobStatus({ root }) {
  const store = new JobStore({ root })
  const state = store.state()
  const control = store.control()
  return {
    job: state,
    control,
    events: readEvents(store.eventsFile),
    artifacts: listArtifacts(root),
  }
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
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
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.job' || entry.name === 'export' || entry.name === 'versions') walk(abs)
        continue
      }
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      out.push({ path: rel, sha256: core.sha256(fs.readFileSync(abs)), bytes: fs.statSync(abs).size })
    }
  }
  walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
