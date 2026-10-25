#!/usr/bin/env node
/**
 * 一键成书的 HTTP 端口。
 *
 * 结构：`handleBookRequest` 只认“一个书根”，单书与多书（/books/:id/...）共用同一套逻辑，
 * 避免两套路由各自漂移。审批规则不变：EXPORT / PUBLISH 都必须带 hash。
 */
import path from 'node:path'
import { readBody, sendJSON, sendError } from '../http/respond.mjs'
import {
  JobStore, applyPointEdit, jobStatus, listArtifacts, progressOf, publishJob, retryJob, runJob,
} from './job.mjs'
import { bookRootOf, booksDirFromEnv, createBook, isValidBookId, listBooks } from './books.mjs'

export function ocbRoot(env = process.env) {
  const configured = env.NOVELSTUDIO_OCB_ROOT
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'book-project')
}

const ERROR_STATUS = {
  JOB_ACTIVE: 409,
  NO_JOB: 409,
  CHAPTER_NOT_COMMITTED: 409,
  APPROVAL_HASH_MISMATCH: 409,
  APPROVAL_HASH_REQUIRED: 400,
  UNKNOWN_APPROVAL: 400,
  NOT_RETRYABLE: 409,
  PUBLISH_DISABLED: 403,
  PUBLISH_HASH_REQUIRED: 400,
  PUBLISH_HASH_MISMATCH: 409,
  NOT_COMPLETED: 409,
  INVALID_BOOK_ID: 400,
  BOOKS_DISABLED: 400,
}

function fail(res, error, fallback = 500) {
  return sendError(res, ERROR_STATUS[error?.code] ?? fallback, String(error?.message || error), {
    code: error?.code || 'OCB_ERROR',
    detail: error?.detail ?? null,
  })
}

export async function handleOneClickBookAPI(req, res, segments, query, method) {
  const action = segments[0] ?? ''
  try {
    if (action === 'books') {
      const dir = booksDirFromEnv()
      if (!dir) return sendError(res, 400, '未启用多书工作区：设置 NOVELSTUDIO_OCB_BOOKS_DIR', { code: 'BOOKS_DISABLED' })
      const sub = segments[1] ?? ''
      if (!sub) {
        if (method === 'GET') return sendJSON(res, 200, { ok: true, books: listBooks(dir) })
        if (method === 'POST') {
          const body = await readBody(req)
          const id = String(body?.book_id ?? body?.id ?? '')
          if (!isValidBookId(id)) return sendError(res, 400, `非法 book_id：${id}`, { code: 'INVALID_BOOK_ID' })
          const root = createBook(dir, id)
          return sendJSON(res, 200, { ok: true, book_id: id, root })
        }
        return sendError(res, 404, '未知的 /books 方法', { code: 'UNKNOWN_ENDPOINT' })
      }
      const root = bookRootOf(dir, sub)
      return handleBookRequest({ req, res, root, segments: segments.slice(2), method })
    }
    return handleBookRequest({ req, res, root: ocbRoot(), segments, method })
  } catch (error) {
    return fail(res, error)
  }
}

async function handleBookRequest({ req, res, root, segments, method }) {
  const action = segments[0] ?? ''
  const sub = segments[1] ?? ''
  const third = segments[2] ?? ''
  try {
    if (method === 'GET' && (action === '' || action === 'status')) return sendJSON(res, 200, jobStatus({ root }))
    if (method === 'GET' && action === 'artifacts') return sendJSON(res, 200, { ok: true, root, artifacts: listArtifacts(root) })
    if (method === 'GET' && action === 'jobs') return sendJSON(res, 200, { ok: true, ...new JobStore({ root }).jobs() })
    if (method === 'GET' && action === 'chapters' && third === 'impact') {
      const state = new JobStore({ root }).state()
      if (!state) return fail(res, Object.assign(new Error('没有可查询的 job'), { code: 'NO_JOB' }))
      return sendJSON(res, 200, { ok: true, chapter: sub, impact: state.impact_graph ?? null, status: state.status })
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
      const body = await readBody(req)
      const result = publishJob({
        root,
        dest: body?.dest,
        approvals: { publish: body?.publish === true, publish_hash: body?.hash },
      })
      return sendJSON(res, 200, { ok: true, ...result })
    }
    if (method === 'POST' && action === 'chapters' && third === 'edit') {
      const body = await readBody(req)
      if (typeof body?.text !== 'string' || body.text.trim() === '') {
        return sendError(res, 400, '修改必须提供非空 text', { code: 'EMPTY_EDIT' })
      }
      return sendJSON(res, 200, applyPointEdit({ root, chapterId: sub, text: body.text, reason: body?.reason ?? 'point-edit' }))
    }
    return sendError(res, 404, `未知的一键成书端点：${segments.join('/')}`, { code: 'UNKNOWN_ENDPOINT' })
  } catch (error) {
    return fail(res, error)
  }
}
