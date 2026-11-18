import { strToU8, zipSync } from 'fflate'

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rel = 'http://schemas.openxmlformats.org/package/2006/relationships'
const doc = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
const styles = { title: 'Title', heading: 'Heading1', subheading: 'Heading2', body: 'Normal' }
const marks = { title: '# ', heading: '## ', subheading: '### ', body: '' }

function xml(text) {
  if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(text)) {
    throw new Error('正文含 Word 无法表示的控制字符，请改用 TXT 或 Markdown。')
  }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function docx(blocks) {
  const paragraphs = []
  for (const { style, text } of blocks) {
    for (const line of text.split(/\r\n?|\n/u)) {
      if (paragraphs.length >= 100_000) throw new Error('Word 单份文档超过十万段，请改用文本格式。')
      const runs = xml(line).split('\t').map(part => '<w:t xml:space="preserve">' + part + '</w:t>').join('<w:tab/>')
      paragraphs.push('<w:p><w:pPr><w:pStyle w:val="' + styles[style] + '"/></w:pPr><w:r>' + runs + '</w:r></w:p>')
    }
  }
  const headingStyles = [['Title', 40], ['Heading1', 32], ['Heading2', 26]].map(([id, size]) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`).join('')
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="${doc}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${doc}.styles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${rel}"><Relationship Id="doc" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${w}"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${rel}"><Relationship Id="styles" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `<w:styles xmlns:w="${w}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="100" w:line="320" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:eastAsia="Songti SC"/><w:sz w:val="22"/></w:rPr></w:style>${headingStyles}</w:styles>`,
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
}

export function encode(blocks, format) {
  if (format === 'docx') return docx(blocks)
  const text = blocks.map(({ style, text }) => (format === 'md' ? marks[style] : '') + text).join('\n\n') + '\n'
  return Buffer.from(text, 'utf8')
}
