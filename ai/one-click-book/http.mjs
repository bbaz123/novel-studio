#!/usr/bin/env node
/**
 * 一键成书的 HTTP 端口。
 *
 * 为什么单独一个模块：`server.js` 已经一万多行，把 Job 生命周期塞进去会让
 * “状态机 / 审批 / 产物”三件事混在 HTTP 分支里；这里只做协议转换与错误码映射。
 */
import path from 'node:path'
import { readBody, sendJSON, sendError } from '../http/respond.mjs'
import { JobStore, jobStatus, listArtifacts, runJob } from './job.mjs'

export function ocbRoot(env = process.env) {
  const configured = env.NOVELSTUDIO_OCB_ROOT
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'book-project')
}

export async function handleOneClickBookAPI(req, res, segments, query, method) {
  const action = segments[0] ?? ''
  const root = ocbRoot()
  try {
    if (method === 'GET' && (action === '' || action === 'status')) {
      return sendJSON(res, 200, jobStatus({ root }))
    }
    if (method === 'GET' && action === 'artifacts') {
      return sendJSON(res, 200, { ok: true, root, artifacts: listArtifacts(root) })
    }
    if (method === 'POST' && action === 'start') {
      const body = await readBody(req)
      const brief = body?.brief
      const idempotencyKey = String(body?.idempotency_key ?? brief?.idempotency_key ?? 'ui-one-click')
      const result = runJob({ root, idempotencyKey, brief, approvals: body?.approvals ?? {} })
      return sendJSON(res, 200, { ok: true, ...result })
    }
    if (method === 'POST' && action === 'approve') {
      const body = await readBody(req)
      const kind = String(body?.kind ?? '')
      if (!['exemplar', 'full_review', 'export'].includes(kind)) {
        return sendError(res, 400, `未知审批类型：${kind}`, { code: 'UNKNOWN_APPROVAL' })
      }
      const store = new JobStore({ root })
      const state = store.state()
      if (!state) return sendError(res, 409, '没有可审批的 job', { code: 'NO_JOB' })
      store.saveState({ ...state, approvals: { ...state.approvals, [kind]: true } })
      store.event('approval_granted', { job_id: state.job_id, kind })
      const result = runJob({
        root,
        idempotencyKey: state.idempotency_key,
        brief: state.brief,
        approvals: store.state().approvals,
      })
      return sendJSON(res, 200, { ok: true, ...result })
    }
    if (method === 'POST' && ['pause', 'resume', 'cancel'].includes(action)) {
      const store = new JobStore({ root })
      const patch = action === 'pause' ? { paused: true } : action === 'resume' ? { paused: false } : { cancelled: true }
      const control = store.setControl(patch)
      store.event(`control_${action}`, { paused: control.paused, cancelled: control.cancelled })
      return sendJSON(res, 200, { ok: true, control })
    }
    return sendError(res, 404, `未知的一键成书端点：${action}`, { code: 'UNKNOWN_ENDPOINT' })
  } catch (e) {
    return sendError(res, e?.code === 'JOB_ACTIVE' ? 409 : 500, String(e?.message || e), {
      code: e?.code || 'OCB_ERROR',
      detail: e?.detail ?? null,
    })
  }
}
