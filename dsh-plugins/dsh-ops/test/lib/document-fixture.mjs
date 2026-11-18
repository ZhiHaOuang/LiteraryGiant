/** Small deterministic OPC fixtures, with real ZIP headers/CRC and optional raw deflate. */
import { deflateRawSync } from 'node:zlib'
export const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const paragraph = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
export const document = body => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${word}"><w:body>${body}</w:body></w:document>`
export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
export function zip(entries, { deflate = false } = {}) {
  const locals = [], central = []; let offset = 0
  for (const [name, value] of entries) {
    const bytes = Buffer.from(value), filename = Buffer.from(name), packed = deflate ? deflateRawSync(bytes) : bytes
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4)
    header.writeUInt16LE(deflate ? 8 : 0, 8); header.writeUInt32LE(crc32(bytes), 14)
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6)
    header.copy(entry, 8, 6, 28); entry.writeUInt32LE(offset, 42)
    locals.push(header, filename, packed); central.push(entry, filename); offset += header.length + filename.length + packed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
export const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
export const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
export const parts = main => [['[Content_Types].xml', types], ['_rels/.rels', rels], ['word/document.xml', main]]
export const docx = (body, options) => zip(parts(document(body)), options)
