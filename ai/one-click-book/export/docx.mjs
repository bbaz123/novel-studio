#!/usr/bin/env node
/**
 * DOCX 导出（最小可用 WordprocessingML，零依赖）。
 *
 * 取舍：不生成 styles.xml 的完整样式表，标题用 run 级别的加粗+字号表达。
 * 这样 Word/WPS/LibreOffice 都能打开，且不依赖模板文件；代价是“标题样式”不是语义 Heading。
 */
import { createZip, escapeXml } from './zip.mjs'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

function paragraph(text, { bold = false, size = 24 } = {}) {
  const runProps = bold || size !== 24
    ? `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rFonts w:eastAsia="SimSun"/></w:rPr>`
    : '<w:rPr><w:rFonts w:eastAsia="SimSun"/></w:rPr>'
  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/**
 * @param {{title: string, chapters: {id: string, title: string, text: string}[], language?: string}} input
 * @returns {Buffer}
 */
export function buildDocx({ title, chapters, language = 'zh-CN' }) {
  const body = []
  body.push(paragraph(title, { bold: true, size: 36 }))
  for (const [index, chapter] of chapters.entries()) {
    if (index > 0) body.push('<w:p/>')
    body.push(paragraph(chapter.title, { bold: true, size: 30 }))
    for (const line of String(chapter.text).split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim()
      if (trimmed === '') continue
      body.push(paragraph(trimmed))
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  return createZip([
    {
      path: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      path: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    { path: 'word/document.xml', data: document },
    {
      path: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title><dc:language>${escapeXml(language)}</dc:language></cp:coreProperties>`,
    },
  ])
}
