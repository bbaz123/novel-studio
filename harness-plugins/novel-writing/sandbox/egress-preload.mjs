#!/usr/bin/env node
/**
 * 进程级出口沙箱（preload）。
 *
 * 为什么放在宿主编排层而不是业务代码里：业务层的守卫只能管“走它自己的调用”，
 * 管不住谁直接 new 一个 socket。这个 preload 用 `node --import` 在**子进程加载业务代码之前**
 * 打补丁，拦的是 Node 内建的出站通道本身。
 *
 * 默认策略：本机回环允许，其余一律拒绝。白名单来自 `NOVELSTUDIO_EGRESS_ALLOW`
 * （逗号分隔，支持 `host` 与 `host:port`）。拒绝时抛 `EGRESS_DENIED`，附带主机名。
 *
 * 边界（如实写）：只覆盖 Node 进程内的 net/tls/http/https/dns/fetch；不拦外部的
 * curl.exe / 浏览器；不拦原生扩展里自建的 socket。那是操作系统防火墙的事。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export class EgressDeniedError extends Error {
  constructor(host, channel) {
    super(`出口沙箱拒绝：${host || '(未知主机)'} via ${channel}`)
    this.code = 'EGRESS_DENIED'
    this.host = host || null
    this.channel = channel
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

export function parseAllowlist(raw) {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function normalize(host) {
  if (!host) return ''
  return String(host).toLowerCase().replace(/^\[|\]$/g, '')
}

/**
 * @param {string} host 目标主机
 * @param {string[]} allow 白名单（host 或 host:port）
 * @param {number|string} [port]
 */
export function isAllowed(host, allow, port) {
  const h = normalize(host)
  if (h === '' || LOOPBACK.has(h)) return true
  const withPort = port === undefined ? null : `${h}:${port}`
  return allow.some((entry) => entry === h || (withPort !== null && entry === withPort))
}

function extractTarget(args) {
  // net.Socket#connect 的几种签名：options | (port, host) | (path)
  const first = args[0]
  if (first && typeof first === 'object') {
    return { host: first.host ?? first.hostname ?? null, port: first.port ?? null }
  }
  if (typeof first === 'string' && args.length === 1) {
    // unix socket 路径：本机 Unix domain socket，不是出站。
    return { host: null, port: null, unix: true }
  }
  const port = typeof first === 'number' ? first : null
  const host = typeof args[1] === 'string' ? args[1] : null
  return { host, port }
}

export function installEgressSandbox(options = {}) {
  const allow = options.allow ?? parseAllowlist(process.env.NOVELSTUDIO_EGRESS_ALLOW)
  const audit = options.audit ?? (process.env.NOVELSTUDIO_EGRESS_AUDIT || null)
  const denials = []

  const record = (channel, host) => {
    const row = { at: new Date().toISOString(), pid: process.pid, channel, host: host ?? null }
    denials.push(row)
    if (audit) {
      try {
        require('node:fs').appendFileSync(audit, JSON.stringify(row) + '\n')
      } catch {
        /* 审计写失败不改变拒绝事实 */
      }
    }
  }

  const enforce = (channel, args) => {
    const target = extractTarget(args)
    if (target.unix) return
    if (isAllowed(target.host, allow, target.port)) return
    record(channel, target.host)
    throw new EgressDeniedError(target.host, channel)
  }

  const net = require('node:net')
  const originalConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function connect(...args) {
    enforce('net.Socket.connect', args)
    return originalConnect.apply(this, args)
  }
  net.Socket.prototype.connect.__novelEgress = 'net.Socket.connect'
  // 实测（Node 24）：`net.connect(80, host)` 不经过原型方法，必须同时包一层导出函数，
  // 否则“直接调 net.connect”会绕过沙箱。这不是洁癖——EG-09 就是被它漏过去的。
  for (const fnName of ['connect', 'createConnection']) {
    const original = net[fnName]
    if (typeof original !== 'function') continue
    net[fnName] = function guardedConnect(...args) {
      enforce(`net.${fnName}`, args)
      return original.apply(this, args)
    }
  }

  const tls = require('node:tls')
  const originalTlsConnect = tls.connect
  tls.connect = function connect(...args) {
    enforce('tls.connect', args)
    return originalTlsConnect.apply(this, args)
  }

  const dns = require('node:dns')
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    const original = dns[name]
    if (typeof original !== 'function') continue
    dns[name] = function guarded(...args) {
      const host = typeof args[0] === 'string' ? args[0] : args[0]?.hostname
      if (!isAllowed(host, allow)) {
        record(`dns.${name}`, host)
        const err = new EgressDeniedError(host, `dns.${name}`)
        if (typeof args[args.length - 1] === 'function') {
          process.nextTick(() => args[args.length - 1](err))
          return undefined
        }
        throw err
      }
      return original.apply(this, args)
    }
  }

  for (const modName of ['node:http', 'node:https']) {
    const mod = require(modName)
    for (const name of ['request', 'get']) {
      const original = mod[name]
      if (typeof original !== 'function') continue
      mod[name] = function guarded(...args) {
        const first = args[0]
        let host = null
        if (typeof first === 'string') {
          try {
            host = new URL(first).hostname
          } catch {
            host = null
          }
        } else if (first && typeof first === 'object') {
          host = first.hostname ?? first.host ?? null
        }
        if (!isAllowed(host, allow)) {
          record(`${modName}.${name}`, host)
          throw new EgressDeniedError(host, `${modName}.${name}`)
        }
        return original.apply(this, args)
      }
    }
  }

  const originalFetch = globalThis.fetch
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      let host = null
      try {
        host = new URL(String(input instanceof Request ? input.url : input)).hostname
      } catch {
        host = null
      }
      if (!isAllowed(host, allow)) {
        record('global.fetch', host)
        const err = new EgressDeniedError(host, 'global.fetch')
        return Promise.reject(err)
      }
      return originalFetch.call(this, input, init)
    }
  }

  return {
    allow,
    denials: () => denials.slice(),
    summary: () => ({ policy: 'deny-by-default(process)', allow, denials: denials.length }),
  }
}
