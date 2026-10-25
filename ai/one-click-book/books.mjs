#!/usr/bin/env node
/**
 * 多书工作区：`books/<book_id>/` 下每一本都是**标准书根**（现有流水线零改动）。
 *
 * 为什么不改流水线内部布局：改内部会牵连所有产物路径、门禁与历史证据；
 * 在书根之上加一层工作区，锁自然变成“书级锁”，迁移风险也最低。
 */
import fs from 'node:fs'
import path from 'node:path'

export const BOOK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function booksDirFromEnv(env = process.env) {
  const configured = env.NOVELSTUDIO_OCB_BOOKS_DIR
  return configured ? path.resolve(configured) : null
}

export function isValidBookId(id) {
  return typeof id === 'string' && BOOK_ID_RE.test(id) && id !== '.' && id !== '..'
}

export function bookRootOf(booksDir, id) {
  if (!isValidBookId(id)) {
    const err = new Error(`非法 book_id：${id}`)
    err.code = 'INVALID_BOOK_ID'
    throw err
  }
  const root = path.resolve(booksDir, id)
  const base = path.resolve(booksDir)
  if (root !== base && !root.startsWith(base + path.sep)) {
    const err = new Error(`book 路径越界：${id}`)
    err.code = 'PATH_ESCAPE'
    throw err
  }
  return root
}

export function createBook(booksDir, id) {
  const root = bookRootOf(booksDir, id)
  fs.mkdirSync(path.join(root, '.job'), { recursive: true })
  return root
}

export function listBooks(booksDir) {
  let entries = []
  try {
    entries = fs.readdirSync(booksDir, { withFileTypes: true })
  } catch {
    return []
  }
  const books = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isValidBookId(entry.name)) continue
    const root = path.join(booksDir, entry.name)
    let state = null
    try {
      state = JSON.parse(fs.readFileSync(path.join(root, '.job/state.json'), 'utf8'))
    } catch {
      state = null
    }
    books.push({
      book_id: entry.name,
      status: state?.status ?? 'EMPTY',
      job_id: state?.job_id ?? null,
      chapters: state?.chapter_manifest?.chapters?.length ?? 0,
      committed: state?.committed?.length ?? 0,
      updated_at: state?.updated_at ?? null,
    })
  }
  return books.sort((a, b) => String(a.book_id).localeCompare(String(b.book_id)))
}
