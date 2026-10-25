#!/usr/bin/env node
/**
 * 出口守卫（deny-by-default）。
 *
 * 为什么产品层还要再做一层：DSH 沙箱只约束文件效果（`packages/sandbox/sandbox/README.md:167`
 * 明确写了 network 不在它的策略词汇里）。方案要求 `security.network = deny_default`，
 * 所以这条约束必须由功能自身持有：没有显式 allowlist，任何出站都抛 EGRESS_DENIED 并留审计。
 *
 * 它不声称能拦住“代码自己 new 一个 net.Socket”——那是进程级隔离的事；
 * 它保证的是：本功能里所有走守卫的出站路径默认拒绝、可审计、可断言。
 */
import fs from 'node:fs'
import path from 'node:path'

export class EgressDeniedError extends Error {
  constructor(target, reason = 'not-in-allowlist') {
    super(`出站被拒绝：${target}（${reason}）`)
    this.code = 'EGRESS_DENIED'
    this.target = String(target)
    this.reason = reason
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])

function hostOf(target) {
  if (target instanceof URL) return target.hostname.toLowerCase()
  const text = String(target)
  try {
    return new URL(text).hostname.toLowerCase()
  } catch {
    return text.toLowerCase().replace(/:\d+$/, '')
  }
}

/**
 * @param {{allowlist?: string[], auditFile?: string|null, fetchImpl?: Function}} options
 */
export function createEgressGuard(options = {}) {
  const allowlist = [...new Set((options.allowlist ?? []).map((host) => String(host).toLowerCase()))]
  const allowed = new Set(allowlist)
  const auditFile = options.auditFile ?? null
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const records = []

  const record = (entry) => {
    const row = { at: new Date().toISOString(), ...entry }
    records.push(row)
    if (auditFile) {
      try {
        // 审计是追加式：不覆盖旧记录；写失败不改变“已经拒绝”这个事实。
        fs.mkdirSync(path.dirname(auditFile), { recursive: true })
        fs.appendFileSync(auditFile, JSON.stringify(row) + '\n')
      } catch {
        /* 审计写入失败不应掩盖拒绝本身 */
      }
    }
    return row
  }

  return {
    allowlist,
    policy: 'deny-by-default',
    /** 只判定，不发起请求；被拒即抛。 */
    check(target) {
      const host = hostOf(target)
      // 本机回环始终放行：工坊自己的服务就在 127.0.0.1，把它拦掉等于把产品打死。
      const ok = LOOPBACK.has(host) || allowed.has(host)
      record({ kind: 'check', host, ok })
      if (!ok) throw new EgressDeniedError(host)
      return true
    },
    /** 唯一允许的出站入口：先过 check，再交给底层 fetch。 */
    async fetch(url, init) {
      this.check(url)
      record({ kind: 'fetch', host: hostOf(url) })
      if (typeof fetchImpl !== 'function') {
        const err = new Error('没有可用的 fetch 实现')
        err.code = 'EGRESS_NO_FETCH'
        throw err
      }
      return fetchImpl(url, init)
    },
    summary() {
      return {
        policy: 'deny-by-default',
        allowlist,
        attempts: records.filter((row) => row.kind === 'check').length,
        allowed: records.filter((row) => row.kind === 'check' && row.ok).length,
        denied: records.filter((row) => row.kind === 'check' && row.ok === false).length,
      }
    },
    audit() {
      return records.slice()
    },
  }
}
