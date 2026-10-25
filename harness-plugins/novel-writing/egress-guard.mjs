#!/usr/bin/env node
/**
 * 小说工坊的 DSH 宿主层出口守卫（插件半边）。
 *
 * 为什么在宿主层：模型能调用的出口不止业务代码里那一个 fetch —— `web_fetch`、`web_search`、
 * shell 工具里的 `curl`、`npm publish` 都绕开业务守卫。宿主层是这些调用的唯一汇合点，
 * 所以 deny-by-default 必须挂在这里（`tools/pre-execute` 留审计 + `ctx.tools.guard()` 单调拒绝）。
 *
 * 进程里的那一半在 `sandbox/egress-preload.mjs`：它拦 Node 内建的出站通道。
 * 两半合起来才是“插件 + sandbox”；单独任何一半都不完整，README 里写明了各自边界。
 */
import fs from 'node:fs'
import path from 'node:path'

export const EGRESS_POLICY_VERSION = '1.0.0'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])

const NETWORK_TOOLS = new Set([
  'web_fetch', 'web_search', 'browser_open', 'browser_click', 'browser_screenshot',
  'fetch_url', 'http_request', 'download',
])

const SHELL_TOOLS = new Set([
  'bash', 'sh', 'shell', 'command', 'exec', 'pwsh', 'powershell',
  'ops_bash', 'ops_run_background', 'run_command', 'spawn',
])

const NET_COMMAND_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ssh|scp|sftp|ftp|telnet|ncat|nc|npm\s+(install|i|add|publish)|pnpm\s+(add|install|publish)|yarn\s+add|git\s+(push|pull|fetch|clone|ls-remote)|docker\s+pull)\b/i
const URL_RE = /(?:https?|ftp|ssh):\/\/[^\s'"`|;)]+/gi

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return null
  }
}

function normalizeAllow(allowHosts = []) {
  return allowHosts.map((item) => String(item).toLowerCase())
}

function allowed(host, allowHosts) {
  if (!host) return false
  if (LOOPBACK.has(host)) return true
  return normalizeAllow(allowHosts).some((entry) => entry === host || entry === `${host}` || entry.split(':')[0] === host)
}

function argsText(args) {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args ?? {})
  } catch {
    return String(args)
  }
}

/**
 * 纯判定，不依赖 Cordis：便于离线断言。
 * @returns {{decision: 'allow'|'deny', channel: string, hosts: string[], reason: string|null}}
 */
export function classifyToolCall(exec, config = {}) {
  const name = String(exec?.name ?? exec?.tool ?? '')
  const allowHosts = config.allowHosts ?? []
  const text = argsText(exec?.arguments ?? exec?.args)

  if (NETWORK_TOOLS.has(name)) {
    const hosts = [...text.matchAll(URL_RE)].map((match) => hostOf(match[0])).filter(Boolean)
    const bad = hosts.filter((host) => !allowed(host, allowHosts))
    if (hosts.length === 0) {
      return { decision: 'deny', channel: name, hosts: [], reason: '网络工具未声明目标主机：默认拒绝' }
    }
    if (bad.length > 0) {
      return { decision: 'deny', channel: name, hosts: bad, reason: `目标主机不在白名单：${bad.join(',')}` }
    }
    return { decision: 'allow', channel: name, hosts, reason: null }
  }

  if (SHELL_TOOLS.has(name)) {
    if (!NET_COMMAND_RE.test(text)) return { decision: 'allow', channel: name, hosts: [], reason: null }
    const hosts = [...text.matchAll(URL_RE)].map((match) => hostOf(match[0])).filter(Boolean)
    const bad = hosts.filter((host) => !allowed(host, allowHosts))
    if (hosts.length === 0) {
      return { decision: 'deny', channel: name, hosts: [], reason: '命令含出站动作但无法解析目标主机：默认拒绝' }
    }
    if (bad.length > 0) {
      return { decision: 'deny', channel: name, hosts: bad, reason: `命令目标不在白名单：${bad.join(',')}` }
    }
    // 显式白名单里的主机放行，但记录一次“已知出站”。
    return { decision: 'allow', channel: name, hosts, reason: null }
  }

  return { decision: 'allow', channel: name || 'unknown', hosts: [], reason: null }
}

function auditLine(auditFile, entry) {
  if (!auditFile) return
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true })
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n')
  } catch {
    /* 审计失败不改变判定 */
  }
}

/**
 * 挂到 Cordis：`tools/pre-execute` 负责留痕，`ctx.tools.guard()` 负责单调拒绝
 * （守卫在管线里只会“拒绝或放行”，后注册的监听器无法把拒绝翻回允许）。
 */
export function installEgressGuard(ctx, config = {}) {
  if (config.enabled === false) return { installed: false, reason: 'disabled-by-config' }
  if (!ctx || typeof ctx.on !== 'function') return { installed: false, reason: 'no-cordis-context' }
  const allowHosts = Array.isArray(config.allowHosts) ? config.allowHosts : []
  const auditFile = config.auditFile || process.env.NOVELSTUDIO_EGRESS_AUDIT || null
  const denials = []

  const evaluate = (exec) => {
    const verdict = classifyToolCall(exec, { allowHosts })
    if (verdict.decision === 'deny') {
      denials.push({ at: new Date().toISOString(), tool: verdict.channel, hosts: verdict.hosts, reason: verdict.reason })
      auditLine(auditFile, { kind: 'egress-deny', ...denials[denials.length - 1] })
    }
    return verdict
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    evaluate(exec)
    return next()
  })

  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => {
      const verdict = evaluate(exec)
      return verdict.decision === 'deny' ? `novel-egress-guard：${verdict.reason}` : undefined
    }), 'novel-egress-guard: monotonic guard')
  }

  return {
    installed: true,
    policy: 'deny-by-default',
    allowHosts,
    auditFile,
    summary: () => ({ policy: 'deny-by-default', allowHosts, denials: denials.length }),
  }
}
