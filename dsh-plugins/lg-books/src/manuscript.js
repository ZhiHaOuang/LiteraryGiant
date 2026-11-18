import { createHash } from 'node:crypto'
import { openBook } from './read.js'

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function identity(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('文档或版本标识无效。')
  return value
}
export function document(db, id) {
  const row = db.prepare(`SELECT d.*, v.content, v.version_number FROM documents d
    JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.id=?`).get(identity(id))
  if (!row || !['chapter', 'scene'].includes(row.kind) || ['archived', 'rejected', 'candidate'].includes(row.state)) {
    throw new Error('请选择具有当前正文版本的章节或场景。')
  }
  if (row.content.length > 400_000) throw new Error('正文超过编辑器读取上限。')
  return row
}
export function version(db, docId, id) {
  const row = db.prepare('SELECT * FROM document_versions WHERE document_id=? AND id=?').get(docId, identity(id))
  if (!row || row.content.length > 400_000) throw new Error('版本不存在或超过读取上限。')
  return { ...row, metadata: JSON.parse(row.metadata_json) }
}
export function chapterSnapshot(db, doc) {
  const chapter = doc.kind === 'chapter' ? doc : document(db, doc.parent_id)
  if (chapter.kind !== 'chapter') throw new Error('场景的章节引用无效。')
  const rows = db.prepare(`SELECT d.id,d.slug,d.title,d.kind,d.state,d.active_version_id,d.sequence,v.content
    FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id
    WHERE d.id=? OR (d.parent_id=? AND d.kind='scene') ORDER BY d.id LIMIT 1001`).all(chapter.id, chapter.id)
  if (rows.length > 1000 || rows.some(row => row.content == null || row.content.length > 400_000)) {
    throw new Error('整章快照不完整或超过读取上限。')
  }
  const parts = rows.map(({ content, ...row }) => ({ ...row, sha256: digest(content) }))
  return { parts, token: digest(parts) }
}
export function readManuscript(path, id, selectedId) {
  const book = openBook(path)
  try {
    const doc = document(book.db, id)
    const selected = version(book.db, id, selectedId ?? doc.active_version_id)
    const versions = book.db.prepare(`SELECT id,version_number,state,reason,created_at FROM document_versions
      WHERE document_id=? ORDER BY version_number DESC LIMIT 100`).all(id)
    if (!versions.some(item=>item.id===selected.id)) {
      const {id,version_number,state,reason,created_at}=selected
      versions.push({id,version_number,state,reason,created_at})
    }
    const snapshot = chapterSnapshot(book.db, doc)
    book.verify()
    return { document: { id: doc.id, title: doc.title, kind: doc.kind, state: doc.state,
      activeVersion: doc.active_version_id, content: doc.content }, selected, versions, ...snapshot }
  } finally { book.close() }
}
