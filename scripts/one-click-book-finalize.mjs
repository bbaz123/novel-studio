#!/usr/bin/env node
/**
 * 一键成书的收尾：把本轮真实证据固化成方案要求的契约、门禁与恢复测试记录。
 *
 * 2026-10-25 审查修复后：
 *   · 验收清单从 core.PLAN_ACCEPTANCE 取（唯一来源，脚本与文档不再各写一份）；
 *   · 证据路径按方案落到 book-project/contract、.dsh/checkpoints、.dsh/evidence；
 *   · 恢复测试覆盖“真重启”（子进程）+ 两段式导出，不再只测同进程 pause/resume。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as core from '../ai/one-click-book/core.mjs'
import { JobStore, jobStatus, runJob } from '../ai/one-click-book/job.mjs'

const REPO = process.cwd()
const ROOT = path.join(REPO, 'book-project')
const WRITE = (rel, value) => {
  const abs = path.join(REPO, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(value, null, 2) + '\n')
  return abs
}

const status = jobStatus({ root: ROOT })
if (!status.job || status.job.status !== 'COMPLETED') {
  process.stderr.write(`book-project 尚未完成：${status.job?.status ?? 'missing'}（先跑 scripts/one-click-book-cli.mjs）\n`)
  process.exit(1)
}

const brief = status.job.brief ?? {}
const bible = core.readJson(path.join(ROOT, 'book-bible.json'))
const sourceManifest = core.readJson(path.join(ROOT, 'manifest/source-manifest.json'))
const chapterManifest = core.readJson(path.join(ROOT, 'manifest/chapter-manifest.json'))
const deliverable = core.readJson(path.join(ROOT, 'manifest/deliverable-manifest.json'))
const evidence = core.readJson(path.join(ROOT, '.job/evidence.json'))
const attestationRec = core.readJson(path.join(ROOT, '.job/attestation.json'), null)
const fullReport = core.readJson(path.join(ROOT, 'review/full-book-report.json'))
const ledgerCounts = Object.fromEntries(
  ['facts', 'terminology', 'timeline', 'foreshadow'].map((name) => {
    const file = path.join(ROOT, 'ledgers', `${name}.jsonl`)
    return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0]
  }),
)

// ── 1. 契约（唯一来源：core.PLAN_ACCEPTANCE）─────────────────────────────────
const taskContract = core.readJson(path.join(ROOT, 'contract/task-contract.json'), null)
const contractErrors = taskContract ? core.validateContract('task-contract', taskContract) : ['missing-book-project-contract']
WRITE('docs/one-click-book/task-contract.json', {
  ...(taskContract ?? {}),
  mirrored_from: 'book-project/contract/task-contract.json',
  amendment: {
    by: 'owner (a1941)',
    at: '2026-10-25T12:57:28+08:00',
    change: '取消 agent_contract.allowed_paths 白名单；其余门禁、证据与审批要求不变',
  },
  acceptance_errors: contractErrors,
})
WRITE('docs/one-click-book/book-requirements.json', core.readJson(path.join(ROOT, 'contract/book-requirements.json'), {}))

// ── 2. 插件清单与冻结方案快照 ───────────────────────────────────────────────
const inventory = core.readJson(path.join(REPO, '.dsh/plugin-inventory.json'), null)
const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop')
const planFiles = [path.join(desktop, 'dsh-one-click-book-plan.md'), path.join(desktop, 'dsh-one-click-book.plan.yaml')]
WRITE('.dsh/plugin-inventory.json', inventory ?? { note: '缺少 P0 探测快照' })
WRITE('.dsh/frozen-plan.json', {
  plan_id: 'plan-52d26b8b5f43',
  snapshot_sha256: '71f2e038d66a691a06b3381d9075308b6d06c2fcfd03d5e36b02efde7297e57d',
  source_files: planFiles.map((file) => ({ path: file, exists: fs.existsSync(file), sha256: fs.existsSync(file) ? core.sha256(fs.readFileSync(file)) : null })),
  frozen_at: new Date().toISOString(),
})

// ── 3. 质量门禁：真实退出码 + 变异报告 + 出口/锚/账本 ────────────────────────
const testsExit = Number.parseInt(process.env.OCB_TESTS_EXIT ?? '', 10)
const mutationReport = core.readJson(path.join(REPO, 'reports/quality-gates-mutation.json'), null)
const testsOk = Number.isFinite(testsExit) && testsExit === 0
const secretScan = core.scanSecrets(fs.readFileSync(path.join(ROOT, 'export/book.md'), 'utf8'))
const attestationOk = attestationRec?.verification?.ok === true
const egressRec = status.job.egress ?? null
const egressOk = egressRec?.policy === 'deny-by-default' && Array.isArray(egressRec?.allowlist) && egressRec.allowlist.length === 0
const ledgerOk = ledgerCounts.terminology === chapterManifest.chapters.length && ledgerCounts.timeline === chapterManifest.chapters.length
const gates = core.evaluateQualityGates({
  mutationRan: mutationReport?.mutation_ran === true,
  mutationScore: mutationReport?.score ?? 0,
  testsPassed: testsOk,
  securityPassed: secretScan.length === 0 && attestationOk && egressOk,
  evidenceChainOk: core.verifyEvidenceChain(evidence?.chain ?? []).ok,
})
WRITE('reports/quality-gates.json', {
  schema_version: '1.0.0',
  generated_at: new Date().toISOString(),
  tests: {
    command: 'node scripts/test-one-click-book.mjs',
    exit_code: Number.isFinite(testsExit) ? testsExit : null,
    ok: testsOk,
    note: '由执行器 shell 真实运行并传入退出码；本脚本内 spawn 被沙箱拒绝（EPERM），不伪造',
  },
  egress: { policy: egressRec?.policy ?? null, allowlist: egressRec?.allowlist ?? null, attempts: egressRec?.attempts ?? null, ok: egressOk },
  attestation: {
    ok: attestationOk,
    chain_head: attestationRec?.anchor?.chain_head ?? null,
    chain_length: attestationRec?.anchor?.chain_length ?? null,
    checks: attestationRec?.verification?.checks ?? null,
    tsa: attestationRec?.anchor?.time_source?.tsa?.state ?? null,
    git_anchor: attestationRec?.anchor?.time_source?.git ?? null,
  },
  ledger: { counts: ledgerCounts, ok: ledgerOk },
  contracts: { task_contract_errors: contractErrors, chapter_contracts: chapterManifest.chapters.length },
  mutation: { command: 'node scripts/one-click-book-mutation.mjs', passed: mutationReport?.pass === true, score: mutationReport?.score ?? null, killed: mutationReport?.killed ?? null, mutants: mutationReport?.mutants ?? null },
  secret_scan: { hits: secretScan.length },
  export_formats: {
    produced: deliverable.artifacts.filter((artifact) => artifact.kind).map((artifact) => ({ kind: artifact.kind, producer: artifact.producer, tool_version: artifact.tool_version })),
    unsupported: deliverable.unsupported ?? [],
    ok: ['docx', 'epub'].every((kind) => deliverable.artifacts.some((artifact) => artifact.kind === kind)),
  },
  evidence_chain: { length: evidence?.chain?.length ?? 0, verified: core.verifyEvidenceChain(evidence?.chain ?? []).ok },
  verdict: gates,
})

// ── 4. 恢复测试：真子进程重启 + 两段式导出 + 取消 ───────────────────────────
const tmp = path.join(REPO, '.tmp-ocb-recovery')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const source = path.join(REPO, 'fixtures/ocb/source.md')
const briefFile = path.join(tmp, 'brief.json')
fs.writeFileSync(briefFile, JSON.stringify({ ...brief, title: '恢复测试', sources: [source], budget_cny: 0 }, null, 2))
const recRoot = path.join(tmp, 'book')
const cli = path.join(REPO, 'scripts/one-click-book-cli.mjs')
const runCli = (args) => {
  try {
    execFileSync(process.execPath, [cli, '--root', recRoot, '--brief', briefFile, ...args], { cwd: REPO, stdio: 'pipe', timeout: 120_000 })
    return { exit: 0 }
  } catch (e) {
    return { exit: e.status ?? 1 }
  }
}
const step1 = runCli(['--approve-exemplar'])
const midway = new JobStore({ root: recRoot }).state()
const step2 = runCli(['--approve-exemplar', '--approve-full'])
const ready = new JobStore({ root: recRoot }).state()
const step3 = runCli(['--approve-exemplar', '--approve-full', '--approve-export'])
const done = new JobStore({ root: recRoot }).state()
const cancelRun = (() => {
  const cancelRoot = path.join(tmp, 'cancel')
  runJob({ root: cancelRoot, idempotencyKey: 'cancel', brief: { book_kind: '随笔集', goal: 'g', title: '取消', sources: [source], budget_cny: 0 }, approvals: {} })
  new JobStore({ root: cancelRoot }).setControl({ cancelled: true })
  return runJob({ root: cancelRoot, idempotencyKey: 'cancel', brief: { book_kind: '随笔集', goal: 'g', title: '取消', sources: [source], budget_cny: 0 }, approvals: {} }).status
})()
const recovery = {
  schema_version: '1.0.0',
  generated_at: new Date().toISOString(),
  steps: {
    process_1_stop: { exit: step1.exit, status: midway.status },
    process_2_resume: { exit: step2.exit, status: ready.status },
    process_3_complete: { exit: step3.exit, status: done.status },
    cancelled: { status: cancelRun },
    replay_idempotent: { stage_history: done.stage_history, committed: done.committed?.length ?? 0 },
  },
  ok: step1.exit !== 0 && midway.status === 'FULL_REVIEW' && step2.exit !== 0 && ready.status === 'EXPORT_READY' && step3.exit === 0 && done.status === 'COMPLETED' && cancelRun === 'CANCELLED',
}
WRITE('reports/recovery-test.json', recovery)
fs.rmSync(tmp, { recursive: true, force: true })

// ── 5. 完成状态 ────────────────────────────────────────────────────────────
WRITE('.dsh/completion.json', {
  plan_id: 'plan-52d26b8b5f43',
  completed_at: new Date().toISOString(),
  job_id: status.job.job_id,
  status: status.job.status,
  stage_history: status.job.stage_history,
  acceptance: core.PLAN_ACCEPTANCE.length,
  chapter_count: chapterManifest.chapters.length,
  export: deliverable.artifacts.find((artifact) => artifact.path === 'export/book.md') ?? null,
  export_approval: deliverable.export_approval ?? null,
  gates: gates.ok,
  ledger: ledgerCounts,
  recovery: recovery.ok,
  attestation: { ok: attestationOk, chain_head: attestationRec?.anchor?.chain_head ?? null },
  unsupported_exports: deliverable.unsupported,
  capabilities: {
    egress_deny_default: { state: egressOk ? 'PASS' : 'FAILED', policy: egressRec?.policy ?? null, allowlist: egressRec?.allowlist ?? null },
    evidence_attest: {
      state: attestationOk ? 'PASS_LOCAL_ANCHOR' : 'FAILED',
      signature: attestationRec?.verification?.checks?.signature ?? null,
      git_anchor: attestationRec?.anchor?.time_source?.git ?? null,
      tsa: attestationRec?.anchor?.time_source?.tsa ?? null,
    },
    export_formats: {
      state: ['docx', 'epub'].every((kind) => deliverable.artifacts.some((artifact) => artifact.kind === kind)) ? 'PASS' : 'FAILED',
      produced: deliverable.artifacts.filter((artifact) => artifact.kind).map((artifact) => artifact.kind),
      pdf: deliverable.artifacts.some((artifact) => artifact.kind === 'pdf') ? 'edge-headless-print' : 'UNSUPPORTED',
    },
    publish: { state: 'LOCAL_FOLDER_READY', dest: 'NOVELSTUDIO_PUBLISH_DIR 或 book-project/publish/<时间戳>', approval: 'publish_hash 绑定交付物根 hash' },
  },
  degraded: { egress: 'UNSUPPORTED_ONLY_TSA', attest: 'LOCAL_SIGNED_PLUS_GIT_ANCHOR' },
})

const formatsOk = ['docx', 'epub'].every((kind) => deliverable.artifacts.some((artifact) => artifact.kind === kind))
const overallOk = gates.ok && recovery.ok && contractErrors.length === 0 && ledgerOk && formatsOk

process.stdout.write(JSON.stringify({
  ok: overallOk,
  acceptance: core.PLAN_ACCEPTANCE.length,
  gates: gates.ok,
  ledger: ledgerOk,
  formats: formatsOk,
  recovery: recovery.ok,
  contracts: contractErrors.length,
  tests_exit: Number.isFinite(testsExit) ? testsExit : null,
  mutation_score: mutationReport?.score ?? null,
  chapters: chapterManifest.chapters.length,
}, null, 2) + '\n')
process.exit(overallOk ? 0 : 1)
