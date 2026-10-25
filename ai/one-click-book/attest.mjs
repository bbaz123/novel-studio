#!/usr/bin/env node
/**
 * 证据锚定（attest）。
 *
 * 计划要求 `evidence.tamper_evident`、且导出/发布需要 hash_chain。本机没有任何第三方
 * 时间戳服务（RFC 3161 / OpenTimestamps 都要出站，而出口守卫默认拒绝），所以这里做两层：
 *
 *   1. **Ed25519 分离签名**：私钥放在仓库之外（`$HOME/.dsh/one-click-book-attest/`），
 *      只签证据链头与 chain_length —— 改任一环都会让链头变化、签名失效；
 *   2. **仓库锚（git）**：把锚点写入 `.dsh/anchors/anchor-log.jsonl` 并随提交进入 git 历史；
 *      git 的 append-only 历史 + 提交时间构成了**仓库之外**的第二时间边界（推送到远端后
 *      就是第三方可见的锚）。
 *
 * 明确不做的：不声称是第三方时间戳。TSA 状态记 `UNSUPPORTED`，要启用必须先把它加进出口
 * 白名单并取得一次授权——这是计划 §8 “缺证据链能力必须阻断导出”的对应处理。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto'

export function defaultKeyDir() {
  return path.join(os.homedir(), '.dsh', 'one-click-book-attest')
}

function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonicalOf))
  return JSON.stringify(canonicalOf(value))
}
function canonicalOf(value) {
  if (Array.isArray(value)) return value.map(canonicalOf)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalOf(value[key])
    return out
  }
  return value
}

export function loadOrCreateKey(keyDir = defaultKeyDir()) {
  fs.mkdirSync(keyDir, { recursive: true })
  const privFile = path.join(keyDir, 'ed25519.key.pem')
  const pubFile = path.join(keyDir, 'ed25519.pub.pem')
  if (!fs.existsSync(privFile)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }))
  }
  const privatePem = fs.readFileSync(privFile, 'utf8')
  const publicPem = fs.readFileSync(pubFile, 'utf8')
  const fingerprint = createHash('sha256').update(createPublicKey(publicPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32)
  return { privatePem, publicPem, fingerprint }
}

export function signChain({ chain, keyDir = defaultKeyDir(), meta = {} }) {
  const key = loadOrCreateKey(keyDir)
  const head = chain.length === 0 ? '' : chain[chain.length - 1].hash
  const payload = {
    chain_head: head,
    chain_length: chain.length,
    artifact_root_sha256: meta.artifact_root_sha256 ?? null,
    created_at: new Date().toISOString(),
    job_id: meta.job_id ?? null,
    key_fingerprint: key.fingerprint,
  }
  const signature = sign(null, Buffer.from(canonical(payload)), createPrivateKey(key.privatePem)).toString('base64')
  return {
    schema_version: '1.0.0',
    ...payload,
    public_key_pem: key.publicPem,
    signature,
    time_source: {
      local_clock: payload.created_at,
      git: meta.git ?? null,
      tsa: {
        state: 'UNSUPPORTED',
        reason: 'RFC3161/OpenTimestamps 需要出站，而 export 路径 exit 守卫默认拒绝；启用需先加入白名单并取得授权',
      },
    },
  }
}

export function verifyAnchor({ anchor, chain }) {
  const checks = { shape: true, chain_integrity: true, chain_head: false, chain_length: false, signature: false }
  const problems = []
  for (const field of ['schema_version', 'chain_head', 'chain_length', 'created_at', 'key_fingerprint', 'public_key_pem', 'signature']) {
    if (!(field in anchor)) {
      checks.shape = false
      problems.push(`缺字段 ${field}`)
    }
  }
  if (!checks.shape) return { ok: false, checks, problems }
  // 链内自校验：只比链头是不够的——改中间一环时链头不变，签名照样“验证通过”。
  let prev = ''
  for (const [i, entry] of chain.entries()) {
    if (entry.prev !== prev) { checks.chain_integrity = false; problems.push(`第 ${i} 环 prev 不连续`); break }
    const { hash, ...rest } = entry
    if (createHash('sha256').update(canonical(rest)).digest('hex') !== hash) {
      checks.chain_integrity = false
      problems.push(`第 ${i} 环哈希不匹配（条目被改动）`)
      break
    }
    prev = hash
  }
  const chainHead = chain.length === 0 ? '' : chain[chain.length - 1].hash
  checks.chain_head = chainHead === anchor.chain_head
  checks.chain_length = chain.length === anchor.chain_length
  if (!checks.chain_head) problems.push('证据链头与锚点不一致（链被改动或截断）')
  if (!checks.chain_length) problems.push('证据链长度与锚点不一致')
  const payload = {
    chain_head: anchor.chain_head,
    chain_length: anchor.chain_length,
    artifact_root_sha256: anchor.artifact_root_sha256 ?? null,
    created_at: anchor.created_at,
    job_id: anchor.job_id ?? null,
    key_fingerprint: anchor.key_fingerprint,
  }
  try {
    checks.signature = verify(null, Buffer.from(canonical(payload)), createPublicKey(anchor.public_key_pem), Buffer.from(anchor.signature, 'base64'))
    if (!checks.signature) problems.push('签名验证失败')
  } catch (e) {
    checks.signature = false
    problems.push(`签名异常：${String(e?.message || e)}`)
  }
  return { ok: Object.values(checks).every(Boolean), checks, problems }
}

export function appendAnchorLog(dir, anchor) {
  const file = path.join(dir, 'anchor-log.jsonl')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(file, JSON.stringify(anchor) + '\n')
  return file
}

export function readAnchorLog(dir) {
  const file = path.join(dir, 'anchor-log.jsonl')
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** 仓库锚：当前 HEAD 与提交时间，作为“证据之外的第二个时间边界”。 */
export function gitAnchorInfo(repoDir) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const committed = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''
    return { head, committed_at: committed, working_tree_dirty: dirty }
  } catch (e) {
    return { head: null, committed_at: null, error: String(e?.message || e) }
  }
}
