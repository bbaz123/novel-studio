#!/usr/bin/env node
/**
 * 一键成书核心域逻辑（零依赖）。
 *
 * 为什么放在一个文件里：这些函数全是纯函数，测试可以整体 import 后逐条断言；
 * 拆成十几个小文件时，跨文件的不变量（状态机 / 证据链 / 契约）反而更难核对。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// ── 状态机（方案 §2.1 核心状态）──────────────────────────────────────────────
export const STATES = [
  'RECEIVED', 'PREFLIGHT', 'INGESTING', 'NORMALIZED', 'OUTLINED',
  'EXEMPLAR_REVIEW', 'DRAFTING', 'QA', 'FULL_REVIEW',
  'EXPORT_READY', 'EXPORTING', 'COMPLETED',
  'BLOCKED', 'FAILED', 'FIXING', 'ROLLED_BACK', 'CANCELLED',
]

export const FAILURE_STATES = ['BLOCKED', 'FAILED', 'CANCELLED', 'ROLLED_BACK']

export const TRANSITIONS = [
  ['RECEIVED', 'PREFLIGHT'],
  ['PREFLIGHT', 'INGESTING'],
  ['INGESTING', 'NORMALIZED'],
  ['NORMALIZED', 'OUTLINED'],
  ['OUTLINED', 'EXEMPLAR_REVIEW'],
  ['EXEMPLAR_REVIEW', 'DRAFTING'],
  ['DRAFTING', 'QA'],
  ['QA', 'FULL_REVIEW'],
  ['FULL_REVIEW', 'EXPORT_READY'],
  ['EXPORT_READY', 'EXPORTING'],
  ['EXPORTING', 'COMPLETED'],
]

/** 允许所有“进入失败态”的迁移：失败不能伪装成通过，但必须能进失败态。 */
export function canTransition(from, to) {
  if (from === to) return true
  if (FAILURE_STATES.includes(to)) return true
  return TRANSITIONS.some(([a, b]) => a === from && b === to)
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`非法状态迁移：${from} → ${to}`)
    err.code = 'ILLEGAL_TRANSITION'
    throw err
  }
  return true
}

/** 快进检测：DRAFTING 直接到 COMPLETED 这类“跳阶段”必须被拒。 */
export function assertNoSkip(visited) {
  const order = ['RECEIVED', 'PREFLIGHT', 'INGESTING', 'NORMALIZED', 'OUTLINED',
    'EXEMPLAR_REVIEW', 'DRAFTING', 'QA', 'FULL_REVIEW', 'EXPORT_READY', 'EXPORTING', 'COMPLETED']
  const known = visited.filter((state) => order.includes(state))
  for (let i = 1; i < known.length; i += 1) {
    if (!canTransition(known[i - 1], known[i])) {
      const err = new Error(`状态回退或跳阶段：${known[i - 1]} → ${known[i]}`)
      err.code = 'STAGE_SKIP'
      throw err
    }
  }
  return true
}

// ── 基础工具 ────────────────────────────────────────────────────────────────
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file))
}

/** 白名单边界的最后一道：任何相对路径都必须落在 root 内，否则抛 PATH_ESCAPE。 */
export function resolveInside(root, rel) {
  const abs = path.resolve(root, rel)
  const base = path.resolve(root)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    const err = new Error(`路径越界：${rel}`)
    err.code = 'PATH_ESCAPE'
    throw err
  }
  return abs
}

export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

export function writeJsonAtomic(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// ── 防篡改证据链（方案 ledger.hash_chain）────────────────────────────────────
export function appendEvidence(chain, record) {
  const prev = chain.length === 0 ? '' : chain[chain.length - 1].hash
  const body = canonical({ ...record, prev })
  const entry = { ...record, prev, hash: sha256(body) }
  return [...chain, entry]
}

export function verifyEvidenceChain(chain) {
  if (!Array.isArray(chain)) return { ok: false, index: -1, reason: 'not-an-array' }
  let prev = ''
  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i]
    if (entry.prev !== prev) return { ok: false, index: i, reason: 'prev-mismatch' }
    const { hash, ...rest } = entry
    if (sha256(canonical(rest)) !== hash) return { ok: false, index: i, reason: 'hash-mismatch' }
    prev = hash
  }
  return { ok: true, index: chain.length }
}

function canonical(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

// ── 迷你 JSON Schema 校验（附加能力 contract.schema_validator 的等价实现）──────
export function validateSchema(schema, value, at = '$') {
  const errors = []
  walk(schema, value, at, errors)
  return errors
}

function walk(schema, value, at, errors) {
  if (schema === true) return
  if (schema === false) {
    errors.push(`${at}: 不允许出现`)
    return
  }
  if (!schema || typeof schema !== 'object') return
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${at}: 必须等于 ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: 不在枚举 ${JSON.stringify(schema.enum)} 内`)
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    errors.push(`${at}: 类型应为 ${types.join('|')}`)
    return
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: 不匹配 ${schema.pattern}`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: 必填缺失`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) walk(sub, value[key], `${at}.${key}`, errors)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${at}.${key}: 未声明字段`)
      }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${at}: 元素少于 ${schema.minItems}`)
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${at}: 元素多于 ${schema.maxItems}`)
    }
    if (schema.items) value.forEach((item, i) => walk(schema.items, item, `${at}[${i}]`, errors))
  }
}

function typeMatches(type, value) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'null': return value === null
    default: return typeof value === type
  }
}

/** acceptance ids 唯一 + 需求映射完整（G1 两项检查）。 */
export function validateAcceptance(acceptance) {
  const errors = []
  const seen = new Set()
  for (const [i, item] of (acceptance ?? []).entries()) {
    if (!item || typeof item.id !== 'string' || item.id === '') errors.push(`acceptance[${i}].id 缺失`)
    if (seen.has(item.id)) errors.push(`acceptance id 重复：${item.id}`)
    seen.add(item.id)
    for (const key of ['requirement', 'test', 'evidence']) {
      if (!item[key] || (Array.isArray(item[key]) && item[key].length === 0)) errors.push(`acceptance ${item.id}: 缺 ${key}`)
    }
  }
  return errors
}

// ── 输入校验（AC-01）─────────────────────────────────────────────────────────
export const REQUIRED_INPUTS = ['book_kind', 'goal', 'sources']
export const SUPPORTED_SOURCE_EXT = ['.md', '.txt']

export function validateBrief(brief) {
  const missing = []
  if (!brief || typeof brief !== 'object') return { ok: false, missing: [...REQUIRED_INPUTS], unsupported: [], state: 'WAITING_CONFIRMATION' }
  if (typeof brief.book_kind !== 'string' || brief.book_kind.trim() === '') missing.push('book_kind')
  if (typeof brief.goal !== 'string' || brief.goal.trim() === '') missing.push('goal')
  const sources = Array.isArray(brief.sources) ? brief.sources.filter((item) => typeof item === 'string' && item.trim() !== '') : []
  if (sources.length === 0) missing.push('sources')
  const unsupported = []
  for (const source of sources) {
    const ext = path.extname(source).toLowerCase()
    if (!SUPPORTED_SOURCE_EXT.includes(ext)) unsupported.push({ path: source, ext })
  }
  return {
    ok: missing.length === 0,
    missing,
    unsupported,
    state: missing.length === 0 ? 'PREFLIGHT' : 'WAITING_CONFIRMATION',
  }
}

// ── 凭据扫描（AC-12 / security.secrets）──────────────────────────────────────
/**
 * 扫描口径按“真实运维写入习惯”扩展：审计里 `API_TOKEN=abcd1234efgh5678` 这一行
 * 在旧版 4 条规则下零命中、被原样导出（2026-10-25 审查 P1-2）。这里加两类判据：
 *   1. 带 TOKEN/KEY/CREDENTIAL 字样的赋值；
 *   2. 高熵串（长度 ≥32、同时含大写/小写/数字），覆盖无关键字的随机凭据。
 */
export const SECRET_PATTERNS = [
  { label: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { label: 'openai-style-key', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { label: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: 'password-assignment', re: /(?:password|passwd|secret)\s*[:=]\s*['"]?[^'"\s]{6,}/gi },
  { label: 'token-assignment', re: /\b[A-Z0-9_]*(?:TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)\b\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/g },
]

const ENTROPY_TOKEN_RE = /[A-Za-z0-9_-]{32,}/g

export function looksHighEntropy(token) {
  if (typeof token !== 'string' || token.length < 32) return false
  const hasUpper = /[A-Z]/.test(token)
  const hasLower = /[a-z]/.test(token)
  const hasDigit = /[0-9]/.test(token)
  return hasUpper && hasLower && hasDigit
}

export function scanSecrets(text) {
  const hits = []
  const source = String(text ?? '')
  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(source)) !== null) {
      hits.push({ label, sample: `${match[0].slice(0, 8)}…`, index: match.index })
      if (hits.length > 50) return hits
    }
  }
  ENTROPY_TOKEN_RE.lastIndex = 0
  let token
  while ((token = ENTROPY_TOKEN_RE.exec(source)) !== null) {
    if (!looksHighEntropy(token[0])) continue
    hits.push({ label: 'high-entropy-token', sample: `${token[0].slice(0, 8)}…`, index: token.index })
    if (hits.length > 50) return hits
  }
  return hits
}

// ── 来源策略：禁止读取凭据类文件（方案 forbidden_paths）───────────────────────
const FORBIDDEN_SEGMENTS = new Set(['secrets', 'secret', 'credentials', 'credential', '.env', 'private'])

export function forbiddenSourceReason(filePath) {
  const base = path.basename(String(filePath))
  if (base.startsWith('.')) return 'dotfile'
  const segments = String(filePath).split(/[\\/]/).map((part) => part.toLowerCase())
  if (segments.some((part) => FORBIDDEN_SEGMENTS.has(part))) return 'forbidden-segment'
  if (/(secret|credential|passwd|password|apikey|api[-_]key|token)/i.test(base)) return 'forbidden-name'
  return null
}

export const SOURCE_LIMITS = { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 }

// ── 来源导入与规范化（AC-07 / BOOK-BASE-002）────────────────────────────────
export function ingestSources(sourcePaths, options = {}) {
  const limits = { ...SOURCE_LIMITS, ...(options.limits ?? {}) }
  const entries = []
  const unsupported = []
  const errors = []
  const credentialHits = []
  const parts = []
  let totalBytes = 0
  for (const [i, sourcePath] of sourcePaths.entries()) {
    const ext = path.extname(sourcePath).toLowerCase()
    const id = `SRC-${String(i + 1).padStart(3, '0')}`
    const forbidden = forbiddenSourceReason(sourcePath)
    if (forbidden) {
      errors.push({ id, path: sourcePath, code: 'FORBIDDEN_SOURCE_PATH', reason: forbidden })
      continue
    }
    if (!SUPPORTED_SOURCE_EXT.includes(ext)) {
      unsupported.push({ id, path: sourcePath, ext, state: 'UNSUPPORTED' })
      continue
    }
    let size = 0
    try {
      size = fs.statSync(sourcePath).size
    } catch (e) {
      errors.push({ id, path: sourcePath, code: 'READ_FAILED', detail: String(e?.message || e) })
      continue
    }
    if (size > limits.maxFileBytes) {
      errors.push({ id, path: sourcePath, code: 'SOURCE_TOO_LARGE', detail: `${size} > ${limits.maxFileBytes}` })
      continue
    }
    totalBytes += size
    if (totalBytes > limits.maxTotalBytes) {
      errors.push({ id, path: sourcePath, code: 'SOURCE_TOTAL_TOO_LARGE', detail: `${totalBytes} > ${limits.maxTotalBytes}` })
      continue
    }
    let buffer
    try {
      buffer = fs.readFileSync(sourcePath)
    } catch (e) {
      errors.push({ id, path: sourcePath, code: 'READ_FAILED', detail: String(e?.message || e) })
      continue
    }
    let raw
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      errors.push({ id, path: sourcePath, code: 'SOURCE_NOT_UTF8' })
      continue
    }
    const hits = scanSecrets(raw)
    if (hits.length > 0) {
      // 关键顺序：先扫再写正文。旧实现把扫描放在导出前，敏感内容已经进了草稿（审查 P1-2）。
      credentialHits.push(...hits.map((hit) => ({ ...hit, source: id })))
      errors.push({ id, path: sourcePath, code: 'CREDENTIAL_IN_SOURCE', detail: hits.map((h) => h.label).join(',') })
      continue
    }
    const normalized = normalizeText(raw)
    entries.push({
      id,
      title: firstHeading(normalized) ?? path.basename(sourcePath, ext),
      path: sourcePath,
      sha256: sha256(raw),
      bytes: Buffer.byteLength(raw),
      fetched_at: new Date().toISOString(),
      location: 'whole-document',
      parse_errors: normalized === raw.trim() ? [] : ['line-ending-or-blank-lines-normalized'],
    })
    parts.push(`<!-- ${id} -->\n${normalized}`)
  }
  return {
    entries,
    unsupported,
    errors,
    credential_hits: credentialHits,
    text: parts.join('\n\n'),
    normalized_state: errors.length === 0 ? 'NORMALIZED' : 'BLOCKED',
  }
}

export function normalizeText(raw) {
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstHeading(text) {
  const match = /^#{1,3}\s+(.+)$/m.exec(text)
  return match ? match[1].trim() : null
}

// ── book bible / 目录 / 章节契约（BOOK-PLUS-001）─────────────────────────────
export function buildBible({ brief, sources }) {
  const noteList = Array.isArray(brief.style_notes) ? brief.style_notes : []
  return {
    schema_version: '1.0.0',
    title: brief.title?.trim() || autoTitle(brief, sources),
    book_kind: brief.book_kind,
    goal: brief.goal,
    language: brief.language || 'zh-CN',
    audience: brief.audience || '通用读者',
    style_guide: { notes: noteList, must_not_write: brief.must_not_write || [] },
    must_write: brief.must_write || [],
    created_at: new Date().toISOString(),
  }
}

function autoTitle(brief, sources) {
  const heading = sources.entries[0]?.title
  if (heading) return heading
  const goal = String(brief.goal || '').trim()
  return goal.length > 24 ? goal.slice(0, 24) : goal || '未命名书稿'
}

/** 把规范化文本按标题或空行切成若干段，再合成章节契约。 */
export function buildOutline({ bible, text }) {
  const sections = splitSections(text)
  const wanted = Math.max(1, Math.min(sections.length || 1, 8))
  const chapters = []
  for (let i = 0; i < wanted; i += 1) {
    const section = sections[i]
    const sentences = splitSentences(section.body)
    const total = sentences.reduce((sum, s) => sum + charCount(s), 0)
    // 下限必须 ≤ 该节可用材料：否则“来源不足”会被误报成契约违约，无法区分是材料问题还是生成问题。
    const min = Math.min(total, Math.max(40, Math.round(total * 0.6)))
    // 必含点取正文首句：标题不在正文里，用它当必含点会让 QA 永远报 MUST_INCLUDE_MISSING。
    const firstSentence = sentences[0] ?? section.title
    chapters.push({
      id: String(i + 1).padStart(3, '0'),
      title: section.title,
      goal: `${bible.goal}（第 ${i + 1} 节）`,
      must_include: [firstSentence.slice(0, 40)],
      source_refs: section.sourceIds,
      word_range: [min, Math.round(total * 1.25) + 80],
      depends_on: i === 0 ? [] : [String(i).padStart(3, '0')],
      section_index: i,
    })
  }
  return { chapters, sections }
}

function splitSections(text) {
  const lines = text.split('\n')
  const sections = []
  let current = null
  let currentSource = null
  const push = () => {
    if (current && current.body.trim() !== '') sections.push(current)
  }
  for (const line of lines) {
    const srcMatch = /^<!--\s*(SRC-\d+)\s*-->$/.exec(line.trim())
    if (srcMatch) { currentSource = srcMatch[1]; continue }
    const head = /^#{1,3}\s+(.+)$/.exec(line)
    if (head) {
      push()
      current = { title: head[1].trim(), body: '', keyPoints: [head[1].trim()], sourceIds: currentSource ? [currentSource] : [] }
      continue
    }
    if (!current) {
      if (line.trim() === '') continue
      current = { title: '开篇', body: '', keyPoints: ['开篇'], sourceIds: currentSource ? [currentSource] : [] }
    }
    current.body += line + '\n'
    if (currentSource && !current.sourceIds.includes(currentSource)) current.sourceIds.push(currentSource)
  }
  push()
  return sections.length > 0 ? sections : [{ title: '开篇', body: text, keyPoints: ['开篇'], sourceIds: [] }]
}

export function splitSentences(text) {
  return String(text)
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export function charCount(text) {
  return String(text).replace(/\s+/g, '').length
}

// ── 章节正文合成（确定性、无模型调用）────────────────────────────────────────
/**
 * 为什么是抽取式：预算里没有模型调用额度（max_cost_cents=200 且无付费授权），
 * 所以“生成”必须是可离线复现的确定性组装；它不会比来源材料多出事实，
 * 这正是增强层“每个可核验主张必须回指来源”的前提。
 */
export function composeChapter({ chapter, section }) {
  const sentences = splitSentences(section.body)
  const picked = []
  for (const must of chapter.must_include) {
    const hit = sentences.find((s) => s.includes(must))
    if (hit && !picked.includes(hit)) picked.push(hit)
  }
  for (const sentence of sentences) {
    if (picked.includes(sentence)) continue
    if (charCount(picked.join('')) >= chapter.word_range[0]) break
    picked.push(sentence)
  }
  let body = picked.join('')
  if (charCount(body) < chapter.word_range[0]) {
    const err = new Error(`来源材料不足：章节 ${chapter.id} 只有 ${charCount(body)} 字，需要 ${chapter.word_range[0]}`)
    err.code = 'INSUFFICIENT_SOURCE'
    err.detail = { chapterId: chapter.id, available: charCount(body), required: chapter.word_range[0] }
    throw err
  }
  if (charCount(body) > chapter.word_range[1]) {
    const trimmed = []
    for (const sentence of picked) {
      if (trimmed.length > 0 && charCount(trimmed.join('')) + charCount(sentence) > chapter.word_range[1]) break
      trimmed.push(sentence)
    }
    body = trimmed.join('')
  }
  const refs = chapter.source_refs.map((id) => ({ id, location: 'whole-document' }))
  return { text: `# ${chapter.title}\n\n${body.trim()}\n`, source_map: refs }
}

// ── 章节 QA（BOOK-BASE-004 / BOOK-PLUS-003）─────────────────────────────────
const PLACEHOLDER_RE = /(\{\{|TODO|TBD|待补|待填写|占位|xxx|lorem ipsum)/i

export function qaChapter({ chapter, text, bible }) {
  const findings = []
  const plain = text.replace(/^#.*$/gm, '').trim()
  const count = charCount(plain)
  if (count < chapter.word_range[0]) findings.push({ code: 'WORD_TOO_SHORT', severity: 'high', detail: `${count} < ${chapter.word_range[0]}` })
  if (count > chapter.word_range[1]) findings.push({ code: 'WORD_TOO_LONG', severity: 'high', detail: `${count} > ${chapter.word_range[1]}` })
  const head = /^#\s+(.+)$/m.exec(text)
  if (!head || head[1].trim() !== chapter.title) findings.push({ code: 'TITLE_MISMATCH', severity: 'high', detail: '正文标题与契约不符' })
  if (PLACEHOLDER_RE.test(text)) findings.push({ code: 'PLACEHOLDER', severity: 'critical', detail: '出现占位符/未完成标记' })
  for (const must of chapter.must_include) {
    if (!plain.includes(must)) findings.push({ code: 'MUST_INCLUDE_MISSING', severity: 'high', detail: must })
  }
  const paragraphs = plain.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const seen = new Map()
  for (const paragraph of paragraphs) {
    const key = sha256(paragraph)
    if (seen.has(key)) findings.push({ code: 'DUPLICATE_PARAGRAPH', severity: 'medium', detail: paragraph.slice(0, 24) })
    seen.set(key, true)
  }
  for (const banned of bible?.style_guide?.must_not_write ?? []) {
    if (banned && plain.includes(banned)) findings.push({ code: 'BANNED_CONTENT', severity: 'high', detail: banned })
  }
  for (const [i, paragraph] of paragraphs.entries()) {
    if (paragraph.length < 8) findings.push({ code: 'EMPTY_PARAGRAPH', severity: 'low', detail: `第 ${i + 1} 段过短` })
  }
  return { ok: findings.length === 0, findings, char_count: count }
}

// ── 全书复审（BOOK-PLUS-003）─────────────────────────────────────────────────
export function fullReview({ chapters, outline, sourceManifest }) {
  const findings = []
  const known = new Set((sourceManifest?.sources ?? []).map((s) => s.id))
  const titles = outline.chapters.map((c) => c.title)
  const actualTitles = chapters.map((c) => c.title)
  const tocMatch = JSON.stringify(titles) === JSON.stringify(actualTitles)
  if (!tocMatch) findings.push({ code: 'TOC_MISMATCH', severity: 'high', detail: '目录与正文标题不一致' })
  const covered = new Set()
  for (const chapter of chapters) {
    for (const ref of chapter.source_map ?? []) {
      if (!known.has(ref.id)) findings.push({ code: 'PROVENANCE_BROKEN', severity: 'critical', detail: `${chapter.id} → ${ref.id}` })
      covered.add(ref.id)
    }
  }
  for (const source of known) {
    if (!covered.has(source)) findings.push({ code: 'SOURCE_UNUSED', severity: 'low', detail: source })
  }
  const sentenceOwners = new Map()
  for (const chapter of chapters) {
    const text = chapter.text.replace(/^#.*$/gm, '')
    for (const sentence of splitSentences(text)) {
      const key = sha256(sentence)
      if (sentenceOwners.has(key)) {
        findings.push({ code: 'CROSS_CHAPTER_DUPLICATE', severity: 'medium', detail: `${chapter.id} 与 ${sentenceOwners.get(key)}` })
      } else {
        sentenceOwners.set(key, chapter.id)
      }
    }
    if (!/[。！？!?]$/.test(chapter.text.trim())) {
      findings.push({ code: 'DANGLING_ENDING', severity: 'medium', detail: `${chapter.id} 结尾未收束` })
    }
  }
  return {
    ok: findings.filter((f) => f.severity !== 'low').length === 0,
    checks: { toc_match: tocMatch, provenance_covered: covered.size === known.size },
    findings,
  }
}

// ── 风格意见追踪（AC-16）────────────────────────────────────────────────────
export function traceStyle({ styleNotes, chapters }) {
  return (styleNotes ?? []).map((note) => {
    const located = chapters.filter((chapter) => chapter.text.includes(note)).map((chapter) => chapter.id)
    return located.length > 0
      ? { note, chapters: located, reason: null, ok: true }
      : { note, chapters: [], reason: '未采用：来源材料中没有对应表述，强行改写会引入无来源主张', ok: true }
  })
}

// ── 影响图 + 版本保留（AC-17）───────────────────────────────────────────────
export function impactGraph({ chapterId, chapters }) {
  const index = chapters.findIndex((c) => c.id === chapterId)
  const downstream = index < 0 ? [] : chapters.slice(index + 1).map((c) => c.id)
  return {
    target: chapterId,
    downstream,
    rebuild: ['FULL_REVIEW', 'EXPORT'],
    rollback: '保留旧版本于 versions/，10 分钟内可撤销',
  }
}

// ── 导出（BOOK-BASE-007 / AC-12）────────────────────────────────────────────
export function buildMarkdown({ title, chapters }) {
  const body = chapters.map((chapter) => chapter.text.trim()).join('\n\n')
  return `# ${title}\n\n## 目录\n\n${chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n')}\n\n${body}\n`
}

export function exportBook({ bookDir, title, chapters, approvals, secretHits }) {
  if (!approvals?.export) {
    const err = new Error('导出需要 EXPORT 审批')
    err.code = 'EXPORT_NOT_APPROVED'
    throw err
  }
  if (secretHits && secretHits.length > 0) {
    const err = new Error(`导出被拒绝：检出疑似凭据 ${secretHits.map((h) => h.label).join(',')}`)
    err.code = 'SECRET_FOUND'
    err.detail = secretHits
    throw err
  }
  const markdown = buildMarkdown({ title, chapters })
  const rel = path.join('export', 'book.md')
  const abs = resolveInside(bookDir, rel)
  writeAtomic(abs, markdown)
  return {
    path: rel.replace(/\\/g, '/'),
    sha256: sha256(markdown),
    bytes: Buffer.byteLength(markdown),
    unsupported: ['docx', 'pdf', 'epub'],
    unsupported_reason: '本机无对应导出适配器（方案 §8：标 UNSUPPORTED，不生成空文件）',
  }
}

// ── 账本一致性（PS-27 / AC-04）──────────────────────────────────────────────
/**
 * 旧实现的账本只有两行“来源登记”，`timeline.jsonl`/`foreshadow.jsonl` 是 0 字节——
 * 每章 contract 里写着的 ledger_delta 从未落账（2026-10-25 审查 P2-1）。
 * 这里把“账本 → 审查结论”的判据固定下来，章节提交后按 delta 追加事件，再统一复核。
 */
export function reviewLedgers({ chapters = [], events = [], minEventsPerChapter = 1 } = {}) {
  const findings = []
  const byChapter = new Map()
  for (const event of events) {
    const key = event.chapter ?? 'unknown'
    if (!byChapter.has(key)) byChapter.set(key, [])
    byChapter.get(key).push(event)
  }
  for (const chapter of chapters) {
    const rows = byChapter.get(chapter.id) ?? []
    if (rows.length < minEventsPerChapter) {
      findings.push({ code: 'LEDGER_EMPTY_CHAPTER', severity: 'high', detail: `${chapter.id} 只有 ${rows.length} 条账本事件` })
    }
  }
  const open = new Map()
  for (const event of events) {
    if (event.kind === 'foreshadow_open' && event.id) open.set(event.id, event.chapter)
    if (event.kind === 'foreshadow_close' && event.id) open.delete(event.id)
  }
  for (const [id, chapter] of open) {
    findings.push({ code: 'FORESHADOW_UNRESOLVED', severity: 'medium', detail: `${id} 在 ${chapter} 打开后未回收` })
  }
  const timeline = events.filter((event) => event.kind === 'timeline').map((event) => Number(event.chapter)).filter(Number.isFinite)
  for (let i = 1; i < timeline.length; i += 1) {
    if (timeline[i] < timeline[i - 1]) {
      findings.push({ code: 'TIMELINE_INVERTED', severity: 'high', detail: `${timeline[i - 1]} → ${timeline[i]}` })
      break
    }
  }
  const formsByTerm = new Map()
  for (const event of events) {
    if (event.kind !== 'terminology' || !event.term) continue
    const form = event.form ?? event.term
    if (formsByTerm.has(event.term) && formsByTerm.get(event.term) !== form) {
      findings.push({ code: 'TERM_DRIFT', severity: 'high', detail: `${event.term}: ${formsByTerm.get(event.term)} vs ${form}` })
    }
    formsByTerm.set(event.term, form)
  }
  return { ok: findings.filter((f) => f.severity !== 'low').length === 0, findings, chapters: chapters.length, events: events.length }
}

// ── 验收清单（唯一来源：脚本与文档都从这里取，防止两处写法漂移）────────────────
export const PLAN_ACCEPTANCE = [
  ['AC-01', '缺 book_kind/goal/source 只能 WAITING_CONFIRMATION', 'missing-input negative test', ['confirmation-export.json', 'state=WAITING_CONFIRMATION']],
  ['AC-02', '越过 allowed_paths 的写入被拒绝并回滚', 'path escape probe', ['PATH_ESCAPE 断言', 'resolveInside']],
  ['AC-03', '前置 gate 未通过不能推进', 'state transition negative tests', ['stage_history 真实序列断言', 'assertTransition/assertNoSkip']],
  ['AC-04', '每章都有契约/正文/摘要/来源映射/账本增量/验证回执', 'chapter completeness', ['chapter-manifest.json', 'commit.json', 'ledgers/*.jsonl']],
  ['AC-05', '范例章批准前不得批量写章', 'exemplar lock', ['EXEMPLAR_REVIEW 状态断言', '无 chapters/002/draft.md']],
  ['AC-06', '全章 review 未完成不得 finalize/export', 'full-review lock', ['FULL_REVIEW 状态断言', '无 export/book.md']],
  ['AC-07', '来源缺失、事实冲突、引用断裂必须 BLOCK', 'provenance and contradiction probes', ['PROVENANCE_BROKEN', 'TOC_MISMATCH']],
  ['AC-08', 'draft 与 commit 分离，未 commit 不得交付', 'staging-vs-commit', ['assertCommitted 生产调用', 'deliverable-manifest.json']],
  ['AC-09', '重启可恢复且不重复写入', 'crash/restart replay', ['resume_noop 事件', 'commit hash 不变', '子进程重启测试']],
  ['AC-10', 'OpenViking 不可用只能 DEGRADED', 'service outage', ['memory_state=DEGRADED']],
  ['AC-11', 'turn-chime 失败不影响 verdict', 'chime failure injection', ['chime_state=DEGRADED', 'review.ok 不变']],
  ['AC-12', 'EXPORT/PUBLISH 必须审批且秘密扫描通过', 'approval/hash mismatch and secret injection', ['EXPORT_READY 断言', 'SECRET_FOUND', 'APPROVAL_HASH_MISMATCH']],
  ['AC-13', '插件变更先 DPIP 且版本/commit pin', 'plugin lifecycle negative tests', ['模块不触碰插件生命周期', 'HTTP 无插件端点', '宿主 DPIP 外部证据']],
  ['AC-14', '缺 diff/命令/退出码/快照/审批/trace 证据不得 DONE', 'evidence completeness', ['completionVerdict 生产调用', 'verifyEvidenceChain']],
  ['AC-15', 'mutation/adversarial gate 未运行即失败', 'gate bypass', ['reports/quality-gates-mutation.json']],
  ['AC-16', '每条风格意见有章节落点或未采用理由', 'style traceability', ['review/style-traceability.json']],
  ['AC-17', '定点修改显示下游影响、保留旧版并可回滚', 'impact and rollback', ['POST /chapters/:id/edit', 'impact graph', 'versions/']],
  ['AC-18', '八部分报告、交付清单、hash 完整一致', 'delivery manifest', ['reports/eight-part-report.json', 'deliverable hash 复核']],
  ['AC-19', '模型自报、普通日志和 OpenViking 记忆不算完成证据', 'self-report spoof', ['completionVerdict 拒绝无证据完成']],
  ['AC-20', '失败必须产生修复包并回到对应 gate', 'failure-repair loop', ['defect-list.json', 'repair-package.json']],
  ['AC-21', '出口默认拒绝：无白名单时出站被拒且留审计', 'egress deny probe', ['egress.summary policy=deny-by-default', '.job/egress.jsonl']],
  ['AC-22', '被拒时不发起底层请求（不是先发后拦）', 'egress fetch spy', ['fetchImpl 调用次数 0']],
  ['AC-23', '证据链签名可验证，改链或改签名即被检出', 'attest tamper probe', ['.job/attestation.json', 'verifyAnchor checks']],
  ['AC-24', '完整 job 产出可验证锚与锚点日志（TSA 记 UNSUPPORTED）', 'attest e2e', ['.dsh/anchors/anchor-log.jsonl']],
].map(([id, requirement, test, evidence]) => ({ id, requirement, test, evidence }))

export const SCHEMAS = {
  'task-contract': {
    type: 'object',
    additionalProperties: true,
    required: ['schema_version', 'plan_id', 'acceptance'],
    properties: {
      schema_version: { type: 'string' },
      plan_id: { type: 'string' },
      acceptance: {
        type: 'array',
        minItems: 20,
        items: {
          type: 'object',
          additionalProperties: true,
          required: ['id', 'requirement', 'test', 'evidence'],
          properties: {
            id: { type: 'string', pattern: '^AC-\\d+$' },
            requirement: { type: 'string' },
            test: { type: 'string' },
            evidence: { type: 'array', minItems: 1 },
          },
        },
      },
    },
  },
  'chapter-contract': {
    type: 'object',
    additionalProperties: true,
    required: ['schema_version', 'id', 'title', 'goal', 'must_include', 'source_refs', 'word_range'],
    properties: {
      schema_version: { type: 'string' },
      id: { type: 'string', pattern: '^\\d{3}$' },
      title: { type: 'string' },
      goal: { type: 'string' },
      must_include: { type: 'array', minItems: 1 },
      source_refs: { type: 'array' },
      word_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
    },
  },
  'deliverable': {
    type: 'object',
    additionalProperties: true,
    required: ['schema_version', 'artifacts'],
    properties: {
      schema_version: { type: 'string' },
      artifacts: { type: 'array', minItems: 1, items: { type: 'object', required: ['path', 'sha256'] } },
    },
  },
}


// ── 八部分报告（PS-32..PS-39 / AC-18）───────────────────────────────────────
export const REPORT_SECTIONS = ['scope', 'design', 'changes', 'tests', 'security', 'performance', 'cost', 'risks_and_handoff']

export function buildEightPartReport(input) {
  const report = { schema_version: '1.0.0', generated_at: new Date().toISOString() }
  for (const section of REPORT_SECTIONS) {
    report[section] = input?.[section] ?? { state: 'NOT_PROVIDED', note: '本轮未采集到该部分证据' }
  }
  return report
}

// ── 质量门禁（PS-14 / AC-15）──────────────────────────────────────────────
/**
 * mutation gate 未运行即失败：这是方案写死的判据（missing_run_is_failure: true），
 * 不能用“覆盖率很高”替代——覆盖率证明代码被执行过，不证明断言能抓住错误。
 */
export function evaluateQualityGates({ mutationRan, mutationScore, testsPassed, securityPassed, evidenceChainOk }) {
  const failures = []
  if (mutationRan !== true) failures.push({ code: 'MUTATION_GATE_NOT_RUN', severity: 'critical' })
  else if (!(Number.isFinite(mutationScore) && mutationScore >= 0.5)) failures.push({ code: 'MUTATION_SCORE_LOW', severity: 'high', detail: String(mutationScore) })
  if (testsPassed !== true) failures.push({ code: 'TESTS_FAILED', severity: 'critical' })
  if (securityPassed !== true) failures.push({ code: 'SECURITY_FAILED', severity: 'critical' })
  if (evidenceChainOk !== true) failures.push({ code: 'EVIDENCE_CHAIN_BROKEN', severity: 'critical' })
  return { ok: failures.length === 0, failures }
}

// ── 完成判定（AC-14 / AC-19：模型自报不算证据）───────────────────────────────
export function completionVerdict({ evidenceRefs, gates, chain }) {
  const missing = []
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) missing.push('no-observed-evidence')
  if (!Array.isArray(gates) || gates.length === 0) missing.push('no-gates')
  else if (gates.some((gate) => gate?.ok !== true)) missing.push('gate-not-passed')
  const chainCheck = verifyEvidenceChain(chain ?? [])
  if (!chainCheck.ok) missing.push('evidence-chain-invalid')
  return { ok: missing.length === 0, missing }
}

// ── 导出前的完成闸（未 commit 不得交付）──────────────────────────────────────
export function assertCommitted({ bookDir, chapterIds }) {
  const notCommitted = []
  for (const id of chapterIds) {
    const rel = `chapters/${id}/commit.md`
    const abs = resolveInside(bookDir, rel)
    if (!fs.existsSync(abs)) notCommitted.push(id)
  }
  if (notCommitted.length > 0) {
    const err = new Error(`未 commit 的章节不能交付：${notCommitted.join(',')}`)
    err.code = 'DRAFT_NOT_COMMITTED'
    err.detail = { notCommitted }
    throw err
  }
  return true
}

/** G1 契约校验入口：schema 来自本文件 SCHEMAS，生成即校验。 */
export function validateContract(name, value) {
  const schema = SCHEMAS[name]
  if (!schema) return [`unknown-schema:${name}`]
  return validateSchema(schema, value)
}
