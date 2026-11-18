/** Small real classic-xref PDFs. Offsets/stream lengths count bytes; no external PDF package is needed. */
import { deflateSync } from 'node:zlib'
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1')
export function pdf(objects, { version = '1.4', trailer = '' } = {}) {
  const chunks = [Buffer.from('%PDF-' + version + '\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [0]
  let offset = chunks[0].length
  for (const [index, value] of objects.entries()) {
    offsets.push(offset)
    const item = Buffer.concat([Buffer.from(String(index + 1) + ' 0 obj\n'), bytes(value), Buffer.from('\nendobj\n')])
    chunks.push(item); offset += item.length
  }
  const xref = 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('')
  chunks.push(Buffer.from(xref + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R ' + trailer + ' >>\nstartxref\n' + offset + '\n%%EOF\n'))
  return Buffer.concat(chunks)
}
export function stream(content, { deflate = false, extra = '', length, packed } = {}) {
  const encoded = packed ?? (deflate ? deflateSync(bytes(content)) : bytes(content))
  return Buffer.concat([Buffer.from('<< /Length ' + (length ?? encoded.length) + (deflate ? ' /Filter /FlateDecode' : '') + ' ' + extra + ' >>\nstream\n'), encoded, Buffer.from('\nendstream')])
}
export function show(value) {
  let text = ''
  for (const byte of bytes(value)) text += byte < 32 || byte > 126 ? '\\' + byte.toString(8).padStart(3, '0') : [40, 41, 92].includes(byte) ? '\\' + String.fromCharCode(byte) : String.fromCharCode(byte)
  return 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET\n'
}
export function textPdf(pages, options = {}) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R ' + (options.catalogExtra ?? '') + ' >>',
    '<< /Type /Pages /Kids [' + pages.map((_, i) => String(4 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /' + (options.font ?? 'Helvetica') + (options.encoding === null ? '' : ' /Encoding /' + (options.encoding ?? 'WinAnsiEncoding')) + ' ' + (options.fontExtra ?? '') + ' >>',
  ]
  for (const [i, content] of pages.entries()) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + i * 2) + ' 0 R ' + (options.pageExtra ?? '') + ' >>')
    objects.push(stream(content, options))
  }
  return pdf(objects, options)
}
