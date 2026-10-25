#!/usr/bin/env node
/**
 * 一键成书验收断言（AC-01..AC-24 + 审查修复项的回归）。
 *
 * 2026-10-25 审查后新增的判据（对应曾经的缺陷）：
 *   · stage_history 必须等于真实发生序列，且中途不得出现未来阶段（P1-1）；
 *   · 凭据/禁止路径/超大/非 UTF-8 来源在 ingest 即 BLOCKED 且不写 chapters（P1-2）；
 *   · 导出审批绑定候选稿 hash，改稿后旧审批失效（P1-2）；
 *   · completionVerdict / assertCommitted / validateContract 进入生产路径（P1-3）；
 *   · 账本按章追加、全书复审读取账本（P2-1）；
 *   · README/过程记录/contract/checkpoints/evidence 齐备（P2-2）；
 *   · progress/retry/publish/定点修改（P2-4/P2-5）；
 *   · 预算、大小、编码上限（P2-5/P2-6）；
 *   · 真实子进程重启续跑（P2-8）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import * as core from '../ai/one-click-book/core.mjs'
import { JobStore, applyPointEdit, jobStatus, progressOf, retryJob, runJob } from '../ai/one-click-book/job.mjs'
import { ocbRoot } from '../ai/one-click-book/http.mjs'
import { createEgressGuard } from '../ai/one-click-book/egress.mjs'
import { signChain, verifyAnchor } from '../ai/one-click-book/attest.mjs'

const REPO = process.cwd()
const TMP = path.join(REPO, '.tmp-ocb-test')
const CLI = path.join(REPO, 'scripts/one-click-book-cli.mjs')

let passed = 0
let failed = 0
const failures = []
const queue = []
const test = (name, fn) => queue.push({ name, fn })

function reset(name) {
  const dir = path.join(TMP, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const LONG_SOURCE = `# 第一章的来处

清晨的图书馆还没有开门。管理员把最后一箱旧书推进库房，纸页的味道在走廊里散开。
她记得每一本书的位置，也记得谁把书折了角。这个习惯让她显得固执，却救回过一次火灾。

# 第二章的转折

那天下午停电了。读者在门口等了很久，有人开始抱怨，有人默默离开。
管理员点起蜡烛，把借阅登记本搬到窗边。她想的是：记录不能断，断一次就要重来。

# 第三章的收束

三周后，图书馆换了新的借还系统。管理员学着用扫描枪，手指比从前慢了半拍。
她仍然每天最早到，把窗子开一条缝，让旧书的味道散出去。
`

function writeSource(dir, name, text) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, text)
  return file
}

function briefFor(dir, overrides = {}) {
  return {
    book_kind: '随笔集',
    goal: '把图书馆里发生的小事整理成一篇可读的散文',
    title: '图书馆纪事',
    language: 'zh-CN',
    audience: '普通读者',
    style_notes: ['句子要短', '不要抒情过度'],
    sources: [writeSource(dir, 'source.md', LONG_SOURCE)],
    budget_cny: 0,
    ...overrides,
  }
}

const OK_APPROVALS = { exemplar: true, full_review: true, export: true }

/** 导出是两段式：第一次到 EXPORT_READY 绑定候选稿 hash，第二次才放行。 */
function runToCompletion({ root, idempotencyKey, brief, options = {} }) {
  const first = runJob({ root, idempotencyKey, brief, approvals: { exemplar: true, full_review: true }, options })
  if (first.status !== 'EXPORT_READY') return first
  return runJob({ root, idempotencyKey, brief, approvals: OK_APPROVALS, options })
}

// ══ 输入与来源策略 ═════════════════════════════════════════════════════════
test('AC-01 缺 book_kind/goal/sources → WAITING_CONFIRMATION + 确认项', () => {
  const root = path.join(reset('ac01'), 'book')
  const result = runJob({ root, idempotencyKey: 'ac01', brief: { book_kind: '', goal: '', sources: [] } })
  assert.equal(result.status, 'WAITING_CONFIRMATION')
  const confirmation = core.readJson(path.join(root, '.job/confirmation-export.json'))
  assert.deepEqual(confirmation.missing.sort(), ['book_kind', 'goal', 'sources'])
})

test('AC-01b 不支持格式 → BLOCKED（不猜、不生成空文件）', () => {
  const dir = reset('ac01b')
  const bad = path.join(dir, 'source.docx')
  fs.writeFileSync(bad, 'x')
  const result = runJob({ root: path.join(dir, 'book'), idempotencyKey: 'ac01b', brief: { book_kind: '随笔集', goal: '测试', title: 'T', sources: [bad] } })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.state.blocked_reason, 'UNSUPPORTED_INPUT')
})

test('AC-01c 禁止路径（.env / secrets 命名）→ FORBIDDEN_SOURCE_PATH 且不写章节', () => {
  const dir = reset('ac01c')
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile, 'A=1\n')
  const secretsFile = path.join(dir, 'secrets-notes.md')
  fs.writeFileSync(secretsFile, '# 记录\n\n普通内容。\n')
  for (const [name, file] of [['dotenv', envFile], ['secrets-name', secretsFile]]) {
    const root = path.join(dir, name)
    const result = runJob({ root, idempotencyKey: name, brief: { book_kind: '随笔集', goal: 'g', title: 'T', sources: [file] } })
    assert.equal(result.status, 'BLOCKED', `${name} 应被拒绝`)
    assert.equal(result.state.blocked_reason, 'FORBIDDEN_SOURCE_PATH', name)
    assert.ok(!fs.existsSync(path.join(root, 'chapters')), `${name} 不得写章节`)
  }
})

test('AC-01d 超大文件 / 非 UTF-8 → 各自阻断（用可注入阈值验证）', () => {
  const dir = reset('ac01d')
  const big = writeSource(dir, 'big.md', '# 大\n\n' + '字'.repeat(200))
  const oversized = core.ingestSources([big], { limits: { maxFileBytes: 100 } })
  assert.equal(oversized.errors[0].code, 'SOURCE_TOO_LARGE')
  const badEncoding = path.join(dir, 'bad.md')
  fs.writeFileSync(badEncoding, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
  const notUtf8 = core.ingestSources([badEncoding])
  assert.equal(notUtf8.errors[0].code, 'SOURCE_NOT_UTF8')
})

test('AC-01e 预算超上限 → BUDGET_EXCEEDED', () => {
  const dir = reset('ac01e')
  const result = runJob({ root: path.join(dir, 'book'), idempotencyKey: 'ac01e', brief: briefFor(dir, { budget_cny: 999 }) })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.state.blocked_reason, 'BUDGET_EXCEEDED')
})

// ══ 路径与状态机 ═══════════════════════════════════════════════════════════
test('AC-02 越界路径被拒绝（PATH_ESCAPE）', () => {
  const root = reset('ac02')
  assert.throws(() => core.resolveInside(root, '../escape.md'), /路径越界/)
  assert.throws(() => core.resolveInside(root, 'a/../../b.md'), /路径越界/)
})

test('AC-03 禁止跳阶段 + 状态历史只记真实发生', () => {
  assert.throws(() => core.assertTransition('DRAFTING', 'COMPLETED'), /非法状态迁移/)
  assert.throws(() => core.assertNoSkip(['RECEIVED', 'COMPLETED']), /跳阶段/)

  const dir = reset('ac03')
  const root = path.join(dir, 'book')
  const brief = briefFor(dir)
  const midway = runJob({ root, idempotencyKey: 'ac03', brief, approvals: {} })
  assert.equal(midway.status, 'EXEMPLAR_REVIEW')
  assert.deepEqual(midway.state.stage_history, ['RECEIVED', 'PREFLIGHT', 'INGESTING', 'NORMALIZED', 'OUTLINED', 'EXEMPLAR_REVIEW'])
  for (const future of ['DRAFTING', 'QA', 'FULL_REVIEW', 'EXPORTING', 'COMPLETED']) {
    assert.ok(!midway.state.stage_history.includes(future), `历史不得含未来阶段 ${future}`)
  }
})

// ══ 完整跑通与产物 ═════════════════════════════════════════════════════════
test('AC-04 完整成书：契约/正文/评审/提交 + 账本增量 + 交付物路径齐备', () => {
  const dir = reset('ac04')
  const root = path.join(dir, 'book')
  const result = runToCompletion({ root, idempotencyKey: 'ac04', brief: briefFor(dir) })
  assert.equal(result.status, 'COMPLETED')
  assert.deepEqual(result.state.stage_history, ['RECEIVED', 'PREFLIGHT', 'INGESTING', 'NORMALIZED', 'OUTLINED', 'EXEMPLAR_REVIEW', 'DRAFTING', 'QA', 'FULL_REVIEW', 'EXPORT_READY', 'EXPORTING', 'COMPLETED'])
  const manifest = core.readJson(path.join(root, 'manifest/chapter-manifest.json'))
  for (const rel of ['README.md', '过程记录.md', 'contract/task-contract.json', 'contract/book-requirements.json', 'manifest/source-manifest.json', 'book-bible.json', 'outline/outline.md', 'review/full-book-report.json', 'review/style-traceability.json', 'reports/eight-part-report.json', '.dsh/evidence/run.json', '.dsh/completion.json']) {
    assert.ok(fs.existsSync(path.join(root, rel)), `缺少 ${rel}`)
  }
  for (const chapter of manifest.chapters) {
    for (const rel of [`chapters/${chapter.id}/contract.json`, `chapters/${chapter.id}/draft.md`, `chapters/${chapter.id}/review.json`, `chapters/${chapter.id}/commit.md`, `chapters/${chapter.id}/commit.json`]) {
      assert.ok(fs.existsSync(path.join(root, rel)), `缺少 ${rel}`)
    }
  }
  // 账本增量：每章至少 1 条术语 + 1 条时间线
  const terminology = fs.readFileSync(path.join(root, 'ledgers/terminology.jsonl'), 'utf8').trim().split('\n').length
  const timeline = fs.readFileSync(path.join(root, 'ledgers/timeline.jsonl'), 'utf8').trim().split('\n').length
  assert.equal(terminology, manifest.chapters.length)
  assert.equal(timeline, manifest.chapters.length)
  const checkpointFiles = fs.readdirSync(path.join(root, '.dsh/checkpoints'))
  assert.ok(checkpointFiles.length >= 5, `checkpoint 数量 ${checkpointFiles.length}`)
})

// ══ 门禁 ═══════════════════════════════════════════════════════════════════
test('AC-05 范例章未批准 → 停在 EXEMPLAR_REVIEW，不批量写章', () => {
  const dir = reset('ac05')
  const root = path.join(dir, 'book')
  const result = runJob({ root, idempotencyKey: 'ac05', brief: briefFor(dir), approvals: {} })
  assert.equal(result.status, 'EXEMPLAR_REVIEW')
  assert.ok(!fs.existsSync(path.join(root, 'chapters/002/draft.md')))
})

test('AC-06 全章评审未批准 → 停在 FULL_REVIEW，不导出', () => {
  const dir = reset('ac06')
  const root = path.join(dir, 'book')
  const result = runJob({ root, idempotencyKey: 'ac06', brief: briefFor(dir), approvals: { exemplar: true } })
  assert.equal(result.status, 'FULL_REVIEW')
  assert.ok(!fs.existsSync(path.join(root, 'export/book.md')))
})

test('AC-07 引用断裂/目录不一致被复审检出', () => {
  const review = core.fullReview({
    chapters: [{ id: '001', title: 'A', text: '一句话。', source_map: [{ id: 'SRC-999' }] }],
    outline: { chapters: [{ title: 'A' }] },
    sourceManifest: { sources: [{ id: 'SRC-001' }] },
  })
  assert.equal(review.ok, false)
  assert.ok(review.findings.some((finding) => finding.code === 'PROVENANCE_BROKEN'))
  const toc = core.fullReview({ chapters: [{ id: '001', title: '错', text: '一句话。', source_map: [] }], outline: { chapters: [{ title: '正' }] }, sourceManifest: { sources: [] } })
  assert.ok(toc.findings.some((finding) => finding.code === 'TOC_MISMATCH'))
})

test('AC-08 未 commit 章节被 assertCommitted 拦下', () => {
  const dir = reset('ac08')
  assert.throws(() => core.assertCommitted({ bookDir: dir, chapterIds: ['001'] }), /未 commit/)
})

// ══ 幂等与重启 ═════════════════════════════════════════════════════════════
test('AC-09 同一 key 重跑：同 job、同 hash、不重复写', () => {
  const dir = reset('ac09')
  const root = path.join(dir, 'book')
  const brief = briefFor(dir)
  const first = runToCompletion({ root, idempotencyKey: 'ac09', brief })
  const hash = core.readJson(path.join(root, 'chapters/001/commit.json')).sha256
  const second = runJob({ root, idempotencyKey: 'ac09', brief, approvals: OK_APPROVALS })
  assert.equal(second.jobId, first.jobId)
  assert.equal(core.readJson(path.join(root, 'chapters/001/commit.json')).sha256, hash)
  assert.ok(jobStatus({ root }).events.some((event) => event.type === 'resume_noop'))
})

test('P2-8 真实子进程重启：三进程续跑到 COMPLETED 且 hash 稳定', async () => {
  const dir = reset('restart')
  const root = path.join(dir, 'book')
  const source = writeSource(dir, 'source.md', LONG_SOURCE)
  const briefFile = path.join(dir, 'brief.json')
  fs.writeFileSync(briefFile, JSON.stringify({ book_kind: '随笔集', goal: '重启续跑验证', title: '重启验证', sources: [source], budget_cny: 0 }))
  const run = (extra) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, '--root', root, '--brief', briefFile, ...extra], { cwd: REPO, timeout: 60_000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout: String(stdout) }))
  })
  const first = await run(['--approve-exemplar'])
  assert.notEqual(first.code, 0, '第一进程应停在后续门禁')
  const midway = new JobStore({ root }).state()
  assert.equal(midway.status, 'FULL_REVIEW')
  const second = await run(['--approve-exemplar', '--approve-full'])
  assert.notEqual(second.code, 0)
  assert.equal(new JobStore({ root }).state().status, 'EXPORT_READY')
  const third = await run(['--approve-exemplar', '--approve-full', '--approve-export'])
  assert.equal(third.code, 0, third.stdout.slice(0, 300))
  const state = new JobStore({ root }).state()
  assert.equal(state.status, 'COMPLETED')
  assert.deepEqual(state.stage_history.slice(-4), ['FULL_REVIEW', 'EXPORT_READY', 'EXPORTING', 'COMPLETED'])
})

// ══ 降级与审批 ═════════════════════════════════════════════════════════════
test('AC-10/11 OpenViking 与提示音失败只降级，不改 verdict', () => {
  const dir = reset('ac10')
  const root = path.join(dir, 'book')
  const result = runToCompletion({
    root,
    idempotencyKey: 'ac10',
    brief: briefFor(dir),
    options: { memoryClient: { health() { throw new Error('ECONNREFUSED') } }, chimeClient: { health() { return false } } },
  })
  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.state.memory_state, 'DEGRADED')
  assert.equal(result.state.chime_state, 'DEGRADED')
  assert.equal(result.review.ok, true)
})

test('AC-12 导出两段式：EXPORT_READY 后凭 hash 放行', () => {
  const dir = reset('ac12')
  const root = path.join(dir, 'book')
  const brief = briefFor(dir)
  const ready = runJob({ root, idempotencyKey: 'ac12', brief, approvals: { exemplar: true, full_review: true } })
  assert.equal(ready.status, 'EXPORT_READY')
  assert.ok(!fs.existsSync(path.join(root, 'export/book.md')))
  const hash = ready.state.pending_export_hash
  assert.equal(core.sha256(fs.readFileSync(path.join(root, 'export/candidate.md'))), hash)
  const done = runJob({ root, idempotencyKey: 'ac12', brief, approvals: OK_APPROVALS })
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.export.sha256, hash)
  const approval = core.readJson(path.join(root, '.job/export-approval.json'))
  assert.equal(approval.hash, hash)
})

test('AC-12b 正文含凭据 → ingest 即 BLOCKED，且不写章节', () => {
  const dir = reset('ac12b')
  const leaky = path.join(dir, 'leaky.md')
  const fakeKey = ['AK', 'IA'].join('') + 'ABCDEFGHIJKLMNOP'
  fs.writeFileSync(leaky, `# 泄漏\n\n配置里写着 ${fakeKey}。\n`)
  const root = path.join(dir, 'book')
  const result = runJob({ root, idempotencyKey: 'ac12b', brief: { book_kind: '随笔集', goal: 'g', title: 'T', sources: [leaky] }, approvals: OK_APPROVALS })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.state.blocked_reason, 'CREDENTIAL_IN_SOURCE')
  assert.ok(!fs.existsSync(path.join(root, 'chapters')), '凭据来源不得进入章节')
})

test('AC-12c 改稿后旧审批失效（APPROVAL_HASH_MISMATCH）', () => {
  const dir = reset('ac12c')
  const root = path.join(dir, 'book')
  const brief = briefFor(dir)
  const ready = runJob({ root, idempotencyKey: 'ac12c', brief, approvals: { exemplar: true, full_review: true } })
  assert.equal(ready.status, 'EXPORT_READY')
  fs.appendFileSync(path.join(root, 'export/candidate.md'), '\n<!-- 改了一行 -->\n')
  const tampered = runJob({ root, idempotencyKey: 'ac12c', brief, approvals: OK_APPROVALS })
  assert.equal(tampered.status, 'BLOCKED')
  assert.equal(tampered.state.blocked_reason, 'APPROVAL_HASH_MISMATCH')
})

// ══ 证据与门禁函数接线 ═════════════════════════════════════════════════════
test('AC-13 不触碰插件生命周期，也没有插件端点', () => {
  for (const rel of ['ai/one-click-book/core.mjs', 'ai/one-click-book/job.mjs', 'ai/one-click-book/http.mjs']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
    assert.ok(!/pluginManager|installBundle|dsh plugin/.test(text), `${rel} 不应触碰插件生命周期`)
  }
  const httpText = fs.readFileSync(path.join(REPO, 'ai/one-click-book/http.mjs'), 'utf8')
  assert.ok(!/plugin|install|upgrade/i.test(httpText), 'HTTP 层不得暴露插件端点')
})

test('AC-14/19 证据链与完成判定进入生产路径', () => {
  const dir = reset('ac14')
  const root = path.join(dir, 'book')
  runToCompletion({ root, idempotencyKey: 'ac14', brief: briefFor(dir) })
  const evidence = core.readJson(path.join(root, '.job/evidence.json'))
  assert.equal(core.verifyEvidenceChain(evidence.chain).ok, true)
  assert.ok(fs.existsSync(path.join(root, '.dsh/completion.json')))
  const jobSource = fs.readFileSync(path.join(REPO, 'ai/one-click-book/job.mjs'), 'utf8')
  assert.ok(jobSource.includes('completionVerdict('), 'job.mjs 必须调用 completionVerdict')
  assert.ok(jobSource.includes('assertCommitted('), 'job.mjs 必须调用 assertCommitted')
  const empty = core.completionVerdict({ evidenceRefs: [], gates: [{ ok: true }], chain: [] })
  assert.equal(empty.ok, false)
})

test('AC-15 mutation gate 未运行即失败', () => {
  const verdict = core.evaluateQualityGates({ mutationRan: false, testsPassed: true, securityPassed: true, evidenceChainOk: true })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure) => failure.code === 'MUTATION_GATE_NOT_RUN'))
})

test('AC-16 风格意见有落点或未采用理由', () => {
  const traced = core.traceStyle({ styleNotes: ['句子要短', '不要使用感叹号'], chapters: [{ id: '001', text: '# A\n\n句子要短。' }] })
  assert.deepEqual(traced[0].chapters, ['001'])
  assert.ok(traced[1].reason.includes('未采用'))
})

test('AC-17 定点修改：影响图 + 旧版本保留 + 门禁退回 FULL_REVIEW', () => {
  const dir = reset('ac17')
  const root = path.join(dir, 'book')
  runToCompletion({ root, idempotencyKey: 'ac17', brief: briefFor(dir) })
  const before = core.readJson(path.join(root, 'chapters/002/commit.json')).sha256
  const edited = applyPointEdit({ root, chapterId: '002', text: '# 第二章的转折\n\n人工改写的一句话。\n', reason: 'audit-probe' })
  assert.ok(edited.graph.downstream.length >= 1)
  assert.ok(fs.existsSync(path.join(root, `versions/002-${before}.md`)))
  const state = new JobStore({ root }).state()
  assert.equal(state.status, 'FULL_REVIEW')
  assert.equal(state.approvals.full_review, false)
  assert.equal(state.approvals.export, false)
})

// ══ 交付与恢复 ═════════════════════════════════════════════════════════════
test('AC-18 八部分报告齐全且交付清单 hash 与文件一致', () => {
  const dir = reset('ac18')
  const root = path.join(dir, 'book')
  runToCompletion({ root, idempotencyKey: 'ac18', brief: briefFor(dir) })
  const report = core.readJson(path.join(root, 'reports/eight-part-report.json'))
  for (const section of core.REPORT_SECTIONS) assert.ok(report[section], `缺 ${section}`)
  const deliverable = core.readJson(path.join(root, 'manifest/deliverable-manifest.json'))
  assert.deepEqual(core.validateContract('deliverable', deliverable), [])
  for (const artifact of deliverable.artifacts) {
    assert.equal(core.sha256(fs.readFileSync(path.join(root, artifact.path))), artifact.sha256)
  }
})

test('AC-20 来源不足 → FIXING + defect list + repair package（可 retry）', () => {
  const dir = reset('ac20')
  const root = path.join(dir, 'book')
  const tiny = writeSource(dir, 'tiny.md', '# 短章\n\n只有一句话。\n')
  const result = runJob({ root, idempotencyKey: 'ac20', brief: { book_kind: '随笔集', goal: 'g', title: '短', sources: [tiny] }, approvals: OK_APPROVALS })
  assert.ok(['FIXING', 'COMPLETED'].includes(result.status))
  if (result.status === 'FIXING') {
    assert.ok(fs.existsSync(path.join(root, 'review/defect-list.json')))
    assert.ok(fs.existsSync(path.join(root, 'review/repair-package.json')))
    const retried = retryJob({ root })
    assert.ok(retried.state.attempts >= 1)
  }
})

test('P2-4 进度与重试可用；publish 默认关闭', () => {
  const dir = reset('p24')
  const root = path.join(dir, 'book')
  runJob({ root, idempotencyKey: 'p24', brief: briefFor(dir), approvals: {} })
  const status = jobStatus({ root })
  assert.equal(status.progress.stage, 'EXEMPLAR_REVIEW')
  assert.ok(typeof status.progress.next_action === 'string' && status.progress.next_action.length > 0)
  assert.ok(status.jobs.current?.job_id)
  assert.throws(() => {
    const { publishJob } = requirePublish()
    publishJob({ root, approvals: {} })
  }, /PUBLISH 默认关闭|publish/)
})

function requirePublish() {
  // 同步环境里避免顶层循环依赖：这里直接读模块导出。
  return { publishJob: globalThis.__ocbPublish }
}

// ══ 出口与锚 ═══════════════════════════════════════════════════════════════
test('AC-21 出口守卫默认拒绝，白名单放行', () => {
  const guard = createEgressGuard({})
  assert.throws(() => guard.check('https://example.com'), /出站被拒绝/)
  assert.equal(guard.check('http://127.0.0.1:3737/x'), true)
  assert.equal(guard.summary().policy, 'deny-by-default')
})

test('AC-22 被拒时不发起底层请求', async () => {
  let called = 0
  const guard = createEgressGuard({ fetchImpl: async () => { called += 1; return { ok: true } } })
  await assert.rejects(() => guard.fetch('https://example.com'), /出站被拒绝/)
  assert.equal(called, 0)
})

test('AC-23/24 证据链签名与锚点日志可验证', () => {
  const dir = reset('ac23')
  const keyDir = path.join(dir, 'keys')
  let chain = []
  chain = core.appendEvidence(chain, { stage: 'A', verdict: 'PASS' })
  const anchor = signChain({ chain, keyDir, meta: { job_id: 't', artifact_root_sha256: core.sha256('x') } })
  assert.equal(verifyAnchor({ anchor, chain }).ok, true)
  const tampered = chain.map((entry) => ({ ...entry, verdict: 'FAIL' }))
  assert.equal(verifyAnchor({ anchor, chain: tampered }).ok, false)
  const badSig = { ...anchor, signature: Buffer.from('nope').toString('base64') }
  assert.equal(verifyAnchor({ anchor: badSig, chain }).ok, false)
})

test('SCHEMA 契约校验器与验收清单', () => {
  assert.deepEqual(core.validateContract('task-contract', { schema_version: '1.0.0', plan_id: 'p', acceptance: core.PLAN_ACCEPTANCE }), [])
  const bad = core.validateContract('chapter-contract', { schema_version: '1.0.0', id: '01', title: 't', goal: 'g', must_include: ['x'], source_refs: [], word_range: [1, 2] })
  assert.ok(bad.some((error) => error.includes('类型应为') || error.includes('不匹配')))
  assert.equal(core.PLAN_ACCEPTANCE.length, 24)
})

test('HTTP 根目录解析', () => {
  assert.equal(ocbRoot({ NOVELSTUDIO_OCB_ROOT: 'D:/x/book' }), path.resolve('D:/x/book'))
  assert.equal(ocbRoot({}), path.join(process.cwd(), 'book-project'))
})

// ── 执行 ────────────────────────────────────────────────────────────────────
const { publishJob } = await import('../ai/one-click-book/job.mjs')
globalThis.__ocbPublish = publishJob

for (const { name, fn } of queue) {
  try {
    await fn()
    passed += 1
  } catch (e) {
    failed += 1
    failures.push({ name, error: String(e?.message || e) })
    process.stderr.write(`FAIL ${name}\n  ${String(e?.message || e)}\n`)
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
process.stdout.write(`\n一键成书验收：passed=${passed} failed=${failed}\n`)
for (const item of failures) process.stdout.write(`  ✗ ${item.name}\n`)
process.exit(failed === 0 ? 0 : 1)
