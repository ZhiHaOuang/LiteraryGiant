import { inspect } from './inspect.js'

function offsetValue(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error('分页位置无效。')
  return offset
}
function page(rows, offset) {
  return { items: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null }
}
export function createImpact(books, readManaged) {
  return {
    documents(path, query = '', offset = 0) {
      offsetValue(offset)
      if (typeof query !== 'string' || query.length > 200) throw new Error('搜索词最多 200 字。')
      return books.readState(path, db => page(db.prepare(
        'SELECT id,title,kind,active_version_id FROM documents WHERE instr(title,?) OR instr(slug,?) ORDER BY id LIMIT 51 OFFSET ?'
      ).all(query, query, offset), offset))
    },
    versions(path, document, offset = 0) {
      offsetValue(offset)
      if (!Number.isSafeInteger(document) || document < 1) throw new Error('文档编号无效。')
      return books.readState(path, db => page(db.prepare(
        'SELECT id,version_number,state FROM document_versions WHERE document_id=? ORDER BY version_number DESC LIMIT 51 OFFSET ?'
      ).all(document, offset), offset))
    },
    inspect(path, document, version = null, offset = 0) {
      offsetValue(offset)
      return books.readState(path, db => inspect(db, path, document, version, offset, readManaged))
    },
  }
}
