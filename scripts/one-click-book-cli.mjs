#!/usr/bin/env node
/**
 * 一键成书的命令行入口（离线、零模型调用）。
 *
 * 为什么需要 CLI：UI 与 HTTP 都是“能跑起来”的证据，但验收需要可重复、可脚本化的
 * 一条命令。它同时是 `scripts/test-one-click-book.mjs` 的集成前置。
 *
 * 用法:
 *   node scripts/one-click-book-cli.mjs --root book-project --brief fixtures/ocb/brief.json \
 *     --sources fixtures/ocb/source.md --approve-exemplar --approve-full --approve-export
 *   node scripts/one-click-book-cli.mjs --root book-project --status
 */
import fs from 'node:fs'
import path from 'node:path'
import { JobStore, jobStatus, runJob } from '../ai/one-click-book/job.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i += 1 }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root ?? 'book-project')
const store = new JobStore({ root })

if (args.status) {
  const status = jobStatus({ root })
  process.stdout.write(JSON.stringify({ ok: true, status: status.job?.status ?? null, job: status.job, events: status.events.length, artifacts: status.artifacts.length }, null, 2) + '\n')
  process.exit(0)
}
if (args.pause) { store.setControl({ paused: true }); process.stdout.write(JSON.stringify({ ok: true, paused: true }) + '\n'); process.exit(0) }
if (args.resume) { store.setControl({ paused: false }); process.stdout.write(JSON.stringify({ ok: true, paused: false }) + '\n'); process.exit(0) }
if (args.cancel) { store.setControl({ cancelled: true }); process.stdout.write(JSON.stringify({ ok: true, cancelled: true }) + '\n'); process.exit(0) }

if (!args.brief) {
  process.stderr.write('缺少 --brief <json 文件>\n')
  process.exit(2)
}
const brief = JSON.parse(fs.readFileSync(path.resolve(args.brief), 'utf8'))
if (args.sources) brief.sources = String(args.sources).split(',').map((item) => path.resolve(item.trim()))
const idempotencyKey = args.key ?? `cli-${brief.title ?? brief.goal ?? 'book'}`
const baseApprovals = {
  exemplar: Boolean(args['approve-exemplar']),
  full_review: Boolean(args['approve-full']),
}

// 导出走两段：先跑到 EXPORT_READY 拿到候选稿 hash，再用同一次“批准”放行。
// 这样审批天然绑定到具体候选稿；CLI 也顺便把“无 hash 的批准”挡在门外。
let result = runJob({ root, idempotencyKey, brief, approvals: baseApprovals })
if (args['approve-export'] && result.status === 'EXPORT_READY') {
  const hash = result.state?.pending_export_hash
  if (!hash) {
    process.stderr.write('EXPORT_READY 但没有 pending_export_hash，拒绝自动批准\n')
    process.exit(3)
  }
  result = runJob({ root, idempotencyKey, brief, approvals: { ...baseApprovals, export: true } })
}
process.stdout.write(JSON.stringify({
  ok: result.status === 'COMPLETED',
  job_id: result.jobId,
  status: result.status,
  stage_history: result.state?.stage_history ?? null,
  pending_export_hash: result.state?.pending_export_hash ?? null,
  export: result.export ?? null,
  deliverable: result.deliverable ?? null,
  review: result.review ?? null,
  ledger: result.ledger ?? null,
  completion: result.completion ?? null,
}, null, 2) + '\n')
process.exit(result.status === 'COMPLETED' ? 0 : 1)
