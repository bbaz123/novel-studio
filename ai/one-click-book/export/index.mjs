#!/usr/bin/env node
/**
 * 导出总入口（同步）：Markdown 由 core 负责，DOCX/EPUB 必出，PDF 视 Edge 能力。
 * 每种产物都记录 producer 与工具标识——渲染结果随工具版本变化，这是可复核的前提。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../core.mjs'
import { buildDocx } from './docx.mjs'
import { buildEpub } from './epub.mjs'
import { buildPrintHtml, renderPdf } from './pdf.mjs'

export function exportAllFormats({ bookDir, title, chapters, language = 'zh-CN' }) {
  const absBook = path.resolve(bookDir)
  fs.mkdirSync(path.join(absBook, 'export'), { recursive: true })
  const formats = []
  const unsupported = []
  const write = (rel, buffer, producer, toolVersion) => {
    const abs = path.join(absBook, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buffer)
    const record = {
      kind: rel.split('.').pop(),
      path: rel.replace(/\\/g, '/'),
      sha256: sha256(buffer),
      bytes: Buffer.byteLength(buffer),
      producer,
      tool_version: toolVersion,
    }
    formats.push(record)
    return record
  }

  write('export/book.docx', buildDocx({ title, chapters, language }), 'zero-dep-ooxml', 'novel-studio/one-click-book docx v1')
  write('export/book.epub', buildEpub({ title, chapters, language }), 'zero-dep-epub', 'novel-studio/one-click-book epub v1')

  try {
    const pdf = renderPdf({ html: buildPrintHtml({ title, chapters, language }), workDir: path.join(absBook, '.job/pdf-work'), title })
    write('export/book.pdf', pdf.buffer, 'edge-headless-print', pdf.tool_version)
  } catch (error) {
    if (error?.code !== 'UNSUPPORTED_EXPORT') throw error
    unsupported.push({ kind: 'pdf', reason: 'EDGE_NOT_FOUND' })
  }
  return { formats, unsupported }
}
