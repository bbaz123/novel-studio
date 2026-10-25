#!/usr/bin/env node
/**
 * EPUB 2.0 导出（零依赖）。
 *
 * 关键约束：`mimetype` 必须是 ZIP 的第一个条目且不压缩，否则阅读器拒绝打开。
 * 章节拆成独立 XHTML 文件，toc.ncx 与 content.opf 同步生成。
 */
import { createZip, escapeXml } from './zip.mjs'

function xhtmlDocument(title, inner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head><body>${inner}</body></html>`
}

export function buildEpub({ title, chapters, language = 'zh-CN', author = 'Novel Studio' }) {
  const files = []
  const manifestItems = []
  const spineItems = []
  const navPoints = []
  chapters.forEach((chapter, index) => {
    const id = `chapter-${String(index + 1).padStart(3, '0')}`
    const file = `OEBPS/${id}.xhtml`
    const paragraphs = String(chapter.text)
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeXml(line)}</p>`)
      .join('')
    files.push({ path: file, data: xhtmlDocument(chapter.title, `<h1>${escapeXml(chapter.title)}</h1>${paragraphs}`) })
    manifestItems.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`)
    spineItems.push(`<itemref idref="${id}"/>`)
    navPoints.push(`<navPoint id="nav-${id}" playOrder="${index + 1}"><navLabel><text>${escapeXml(chapter.title)}</text></navLabel><content src="${id}.xhtml"/></navPoint>`)
  })

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(title)}</dc:title><dc:language>${escapeXml(language)}</dc:language><dc:creator>${escapeXml(author)}</dc:creator><dc:identifier id="BookId">urn:uuid:${escapeXml(hashish(title))}</dc:identifier>
</metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${manifestItems.join('')}</manifest>
<spine toc="ncx">${spineItems.join('')}</spine>
</package>`

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${escapeXml(hashish(title))}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${navPoints.join('')}</navMap></ncx>`

  return createZip([
    { path: 'mimetype', data: 'application/epub+zip', compress: false },
    {
      path: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { path: 'OEBPS/content.opf', data: opf },
    { path: 'OEBPS/toc.ncx', data: ncx },
    ...files,
  ])
}

function hashish(text) {
  let hash = 0
  for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return `${hash.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}
