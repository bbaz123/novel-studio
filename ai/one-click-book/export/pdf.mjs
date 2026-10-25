#!/usr/bin/env node
/**
 * PDF 导出：用本机 Edge 无头打印（用户已确认接受这一依赖）。
 *
 * 为什么不自己写 PDF：中文 PDF 需要嵌入 CJK 字体，零依赖实现既重又容易产出乱码；
 * Edge 打印走系统字体栈，实测中文正常（2026-10-25 探针：`%PDF-`，35,989 字节）。
 *
 * 为什么要同步实现：一键成书的流水线是同步的（runJob 返回结果），
 * 异步 spawn 会把整条链改成 async 并影响所有调用方；这里用 execFileSync + 同步轮询。
 *
 * 诚实边界：渲染结果随浏览器版本变化——所以把浏览器标识写进 manifest；
 * 找不到 Edge 时抛 UNSUPPORTED_EXPORT，调用方把 pdf 标 UNSUPPORTED，绝不生成空文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { escapeXml } from './zip.mjs'

const CANDIDATES = [
  process.env.NOVELSTUDIO_EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

export function findEdge() {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 忽略不可读路径 */
    }
  }
  return null
}

function fileStamp(edgePath) {
  try {
    const stat = fs.statSync(edgePath)
    return `file-mtime:${stat.mtime.toISOString()};size:${stat.size}`
  } catch {
    return 'unknown'
  }
}

export function edgeIdentity(edgePath) {
  // `msedge --version` 在中文系统上会返回本地化提示而不是版本号（实测），
  // 所以只在输出看起来像版本号时采用，否则退回文件指纹——不编造版本。
  try {
    const output = execFileSync(edgePath, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (/^\d+\.\d+\.\d+/.test(output) || /Edge\/\d+/.test(output)) return output
  } catch {
    /* 落到文件指纹 */
  }
  return fileStamp(edgePath)
}

export function buildPrintHtml({ title, chapters, language = 'zh-CN' }) {
  const body = chapters.map((chapter) => {
    const paragraphs = String(chapter.text)
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeXml(line)}</p>`)
      .join('')
    return `<section><h2>${escapeXml(chapter.title)}</h2>${paragraphs}</section>`
  }).join('')
  return `<!DOCTYPE html><html lang="${escapeXml(language)}"><head><meta charset="utf-8"><title>${escapeXml(title)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: "SimSun", "Songti SC", serif; font-size: 12pt; line-height: 1.9; color: #111; }
  h1 { font-size: 22pt; text-align: center; margin: 0 0 28mm; }
  h2 { font-size: 15pt; margin: 10mm 0 4mm; page-break-after: avoid; }
  section { page-break-before: always; }
  section:first-of-type { page-break-before: avoid; }
  p { margin: 0 0 2mm; text-align: justify; }
</style></head><body><h1>${escapeXml(title)}</h1>${body}</body></html>`
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 实测：Edge 退出码 0 时 PDF 仍可能尚未落盘；必须同步轮询到大小稳定。 */
function waitForStableFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = -1
  while (Date.now() < deadline) {
    try {
      const size = fs.statSync(file).size
      if (size > 0 && size === last) return true
      last = size
    } catch {
      last = -1
    }
    sleepSync(200)
  }
  return false
}

/** @returns {{buffer: Buffer, tool_version: string}} */
export function renderPdf({ html, workDir, title = 'book' }) {
  const edge = findEdge()
  if (!edge) {
    const err = new Error('本机未找到 Edge，PDF 导出不可用')
    err.code = 'UNSUPPORTED_EXPORT'
    throw err
  }
  // 绝对路径是硬要求：相对路径会让 Edge “退出码 0 但没文件”（实测）。
  const absWorkDir = path.resolve(workDir)
  fs.mkdirSync(absWorkDir, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}`
  const htmlFile = path.join(absWorkDir, `print-${stamp}.html`)
  const pdfFile = path.join(absWorkDir, `print-${stamp}.pdf`)
  const profileDir = path.join(os.tmpdir(), `ocb-edge-profile-${stamp}`)
  fs.writeFileSync(htmlFile, html, 'utf8')
  try {
    execFileSync(edge, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pdf-header-footer',
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${pdfFile}`,
      pathToFileURL(htmlFile).href,
    ], { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    if (!waitForStableFile(pdfFile)) {
      const err = new Error('Edge 未产出 PDF 文件')
      err.code = 'PDF_RENDER_FAILED'
      throw err
    }
    const buffer = fs.readFileSync(pdfFile)
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      const err = new Error('PDF 头部校验失败（不是合法 PDF）')
      err.code = 'PDF_INVALID'
      throw err
    }
    return { buffer, tool_version: `edge ${edgeIdentity(edge)}` }
  } finally {
    for (const target of [htmlFile, pdfFile]) {
      try { fs.rmSync(target, { force: true }) } catch { /* 清理失败不影响结果 */ }
    }
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* Edge 可能仍持有目录 */ }
  }
}
