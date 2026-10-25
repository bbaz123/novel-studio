/* 一键成书面板（零构建、独立脚本，避免动 public/app.js 这个超大文件）。
 *
 * 设计取舍：面板只做“一次触发 + 生命周期按钮”，所有判定留在服务端；
 * 前端不缓存状态，每次操作后重新拉 status，避免 UI 与服务端状态机漂移。
 */
(function () {
  'use strict'

  const API = '/api/one-click-book'
  let timer = null
  let root = null

  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    if (attrs) for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') node.textContent = value
      else if (key === 'style') node.setAttribute('style', value)
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value)
    }
    for (const child of children || []) node.appendChild(child)
    return node
  }

  async function call(path, options) {
    const response = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...(options || {}) })
    const data = await response.json().catch(() => ({ error: '响应不是 JSON' }))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }

  function log(message) {
    const box = document.getElementById('ocb-log')
    if (!box) return
    const line = el('div', { text: `[${new Date().toLocaleTimeString()}] ${message}` })
    box.prepend(line)
    while (box.childElementCount > 40) box.lastElementChild.remove()
  }

  function stateLine(job) {
    if (!job) return '状态：未开始'
    const pending = job.pending_approval ? `｜待审批：${job.pending_approval}` : ''
    return `状态：${job.status}｜job ${job.job_id}${pending}`
  }

  async function refresh() {
    try {
      const data = await call('/status')
      const line = document.getElementById('ocb-state')
      if (line) line.textContent = stateLine(data.job)
      const artifacts = document.getElementById('ocb-artifacts')
      if (artifacts) {
        artifacts.textContent = data.artifacts.length === 0
          ? '产物：无'
          : `产物：${data.artifacts.length} 个（最近：${data.artifacts.slice(-1)[0].path}）`
      }
      return data
    } catch (e) {
      log(`状态刷新失败：${e.message}`)
      return null
    }
  }

  async function start() {
    const brief = {
      book_kind: document.getElementById('ocb-kind').value,
      goal: document.getElementById('ocb-goal').value,
      title: document.getElementById('ocb-title').value,
      language: 'zh-CN',
      sources: document.getElementById('ocb-sources').value.split('\n').map((s) => s.trim()).filter(Boolean),
    }
    try {
      const data = await call('/start', { method: 'POST', body: JSON.stringify({ brief, approvals: {} }) })
      log(`已提交：${data.status}`)
      await refresh()
    } catch (e) {
      log(`提交失败：${e.message}`)
    }
  }

  async function approve(kind) {
    try {
      const data = await call('/approve', { method: 'POST', body: JSON.stringify({ kind }) })
      log(`已批准 ${kind}：${data.status}`)
      await refresh()
    } catch (e) {
      log(`审批失败：${e.message}`)
    }
  }

  async function control(action) {
    try {
      const data = await call('/' + action, { method: 'POST', body: '{}' })
      log(`${action}：paused=${data.control.paused} cancelled=${data.control.cancelled}`)
      await refresh()
    } catch (e) {
      log(`${action} 失败：${e.message}`)
    }
  }

  function build() {
    if (document.getElementById('ocb-toggle')) return
    const toggle = el('button', { id: 'ocb-toggle', text: '一键成书', title: '打开一键成书面板（Alt+B）', style: 'position:fixed;right:18px;bottom:18px;z-index:9999;padding:10px 14px;border-radius:10px;border:1px solid #3a3a3a;background:#1f6feb;color:#fff;font-size:14px;cursor:pointer' })
    toggle.addEventListener('click', () => {
      const panel = document.getElementById('ocb-panel')
      if (panel) { panel.remove(); if (timer) { clearInterval(timer); timer = null } return }
      open()
    })
    document.body.appendChild(toggle)
    document.addEventListener('keydown', (event) => {
      if (event.altKey && (event.key === 'b' || event.key === 'B')) toggle.click()
    })
  }

  function open() {
    const panel = el('div', { id: 'ocb-panel', style: 'position:fixed;right:18px;bottom:70px;z-index:9999;width:360px;max-height:70vh;overflow:auto;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:12px;padding:12px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5)' }, [
      el('div', { text: '一键成书（离线确定性模式）', style: 'font-weight:600;margin-bottom:8px' }),
      el('input', { id: 'ocb-title', placeholder: '书名（可留空自动命名）', style: 'width:100%;margin:4px 0;padding:6px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px' }),
      el('input', { id: 'ocb-kind', placeholder: '书籍类型（必填，如：随笔集）', style: 'width:100%;margin:4px 0;padding:6px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px' }),
      el('input', { id: 'ocb-goal', placeholder: '目标（必填）', style: 'width:100%;margin:4px 0;padding:6px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px' }),
      el('textarea', { id: 'ocb-sources', placeholder: '来源文件绝对路径，一行一个（.md/.txt）', rows: '3', style: 'width:100%;margin:4px 0;padding:6px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px' }),
      el('div', { id: 'ocb-state', text: '状态：未开始', style: 'margin:8px 0;color:#9da7b3' }),
      el('div', { id: 'ocb-artifacts', text: '产物：无', style: 'margin-bottom:8px;color:#9da7b3' }),
      el('div', {}, [
        el('button', { text: '开始', onclick: start, style: 'margin:2px;padding:6px 10px' }),
        el('button', { text: '批准范例章', onclick: () => approve('exemplar'), style: 'margin:2px;padding:6px 10px' }),
        el('button', { text: '批准全书复审', onclick: () => approve('full_review'), style: 'margin:2px;padding:6px 10px' }),
        el('button', { text: '批准导出', onclick: () => approve('export'), style: 'margin:2px;padding:6px 10px' }),
      ]),
      el('div', {}, [
        el('button', { text: '暂停', onclick: () => control('pause'), style: 'margin:2px;padding:6px 10px' }),
        el('button', { text: '恢复', onclick: () => control('resume'), style: 'margin:2px;padding:6px 10px' }),
        el('button', { text: '取消', onclick: () => control('cancel'), style: 'margin:2px;padding:6px 10px' }),
      ]),
      el('div', { id: 'ocb-log', style: 'margin-top:8px;max-height:140px;overflow:auto;color:#8b949e;font-size:12px' }),
    ])
    document.body.appendChild(panel)
    if (timer) clearInterval(timer)
    timer = setInterval(refresh, 3000)
    refresh()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build)
  else build()
  void root
})()
