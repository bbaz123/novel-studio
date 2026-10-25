#!/usr/bin/env node
/**
 * 一键成书的 HTTP 端口。
 *
 * 2026-10-25 审查修复（P2-4）：补齐 progress / retry / publish / 定点修改 / 多 job 列表；
 * EXPORT 审批改为**必须带候选稿 hash**（没有 hash 的“批准”一律 400），
 * 这样“改稿后拿旧审批放行”在协议层就不成立。
 */
import path from 'node:path'
import { readBody, sendJSON, sendError } from '../http/respond.mjs'
import { JobStore, applyPointEdit, jobStatus, listArtifacts, progressOf, publishJob, retryJob, runJob } from './job.mjs'

export function ocbRoot(env = process.env) {
  const configured = env.NOVELSTUDIO_OCB_ROOT
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'book-project')
}

function fail(res, error, fallbackStatus = 500) {
  const map = {
    JOB_ACTIVE: 409,
    NO_JOB: 409,
    CHAPTER_NOT_COMMITTED: 409,
    APPROVAL_HASH_MISMATCH: 409,
    APPROVAL_HASH_REQUIRED: 400,
    UNKNOWN_APPROVAL: 400,
    NOT_RETRYABLE: 409,
    PUBLISH_DISABLED: 403,
    PUBLISH_UNSUPPORTED: 501,
    NOT_COMPLETED: 409,
  }
  return sendError(res, map[error?.code] ?? fallbackStatus, String(error?.message || error), {
    code: error?.code || 'OCB_ERROR',
    detail: error?.detail ?? null,
  })
}

export async function handleOneClickBookAPI(req, res, segments, query, method) {
  const action = segments[0] ?? ''
  const sub = segments[1] ?? ''
  const third = segments[2] ?? ''
  const root = ocbRoot()
  try {
    if (method === 'GET' && (action === '' || action === 'status')) return sendJSON(res, 200, jobStatus({ root }))
    if (method === 'GET' && action === 'artifacts') return sendJSON(res, 200, { ok: true, root, artifacts: listArtifacts(root) })
    if (method === 'GET' && action === 'jobs') return sendJSON(res, 200, { ok: true, ...new JobStore({ root }).jobs() })

    if (method === 'GET' && action === 'chapters' && third === 'impact') {
      const state = new JobStore({ root }).state()
      if (!state) return fail(res, Object.assign(new Error('没有可查询的 job'), { code: 'NO_JOB' }))
      return sendJSON(res, 200, { ok: true, chapter: sub, impact: state.impact_graph ?? null, status: state.status, approvals: state.approvals })
    }

    if (method === 'POST' && action === 'start') {
      const body = await readBody(req)
      const brief = body?.brief
      const idempotencyKey = String(body?.idempotency_key ?? brief?.idempotency_key ?? 'ui-one-click')
      const result = runJob({ root, idempotencyKey, brief, approvals: body?.approvals ?? {} })
      return sendJSON(res, 200, { ok: true, ...result, progress: progressOf(result.state) })
    }
    if (method === 'POST' && action === 'approve') {
      const body = await readBody(req)
      const kind = String(body?.kind ?? '')
      if (!['exemplar', 'full_review', 'export'].includes(kind)) {
        return fail(res, Object.assign(new Error(`未知审批类型：${kind}`), { code: 'UNKNOWN_APPROVAL' }))
      }
      const store = new JobStore({ root })
      const state = store.state()
      if (!state) return fail(res, Object.assign(new Error('没有可审批的 job'), { code: 'NO_JOB' }))
      if (kind === 'export') {
        const hash = String(body?.hash ?? '')
        if (!hash) return fail(res, Object.assign(new Error('EXPORT 审批必须带候选稿 hash'), { code: 'APPROVAL_HASH_REQUIRED' }))
        if (hash !== state.pending_export_hash) {
          return fail(res, Object.assign(new Error('候选稿 hash 与待审批 hash 不一致（改稿后旧审批失效）'), { code: 'APPROVAL_HASH_MISMATCH', detail: { expected: state.pending_export_hash, got: hash } }))
        }
      }
      store.saveState({ ...state, approvals: { ...state.approvals, [kind]: true }, pending_approval: null })
      store.event('approval_granted', { job_id: state.job_id, kind, hash: body?.hash ?? null })
      const result = runJob({ root, idempotencyKey: state.idempotency_key, brief: state.brief, approvals: store.state().approvals })
      return sendJSON(res, 200, { ok: true, ...result, progress: progressOf(result.state) })
    }
    if (method === 'POST' && ['pause', 'resume', 'cancel'].includes(action)) {
      const store = new JobStore({ root })
      const patch = action === 'pause' ? { paused: true } : action === 'resume' ? { paused: false } : { cancelled: true }
      const control = store.setControl(patch)
      store.event(`control_${action}`, { paused: control.paused, cancelled: control.cancelled })
      return sendJSON(res, 200, { ok: true, control })
    }
    if (method === 'POST' && action === 'retry') {
      const body = await readBody(req).catch(() => ({}))
      const result = retryJob({ root, approvals: body?.approvals ?? {} })
      return sendJSON(res, 200, { ok: true, ...result, progress: progressOf(result.state) })
    }
    if (method === 'POST' && action === 'publish') {
      const body = await readBody(req).catch(() => ({}))
      const result = publishJob({ root, approvals: body?.approvals ?? {} })
      return sendJSON(res, 200, { ok: true, ...result })
    }
    if (method === 'POST' && action === 'chapters' && third === 'edit') {
      const body = await readBody(req)
      if (typeof body?.text !== 'string' || body.text.trim() === '') {
        return sendError(res, 400, '修改必须提供非空 text', { code: 'EMPTY_EDIT' })
      }
      const result = applyPointEdit({ root, chapterId: sub, text: body.text, reason: body?.reason ?? 'point-edit' })
      return sendJSON(res, 200, result)
    }
    return sendError(res, 404, `未知的一键成书端点：${segments.join('/')}`, { code: 'UNKNOWN_ENDPOINT' })
  } catch (e) {
    return fail(res, e)
  }
}
