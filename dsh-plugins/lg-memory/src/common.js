import { createHash } from 'node:crypto'
export const now = () => new Date().toISOString()
export const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
export function text(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}需要 1–${max} 字。`)
  return value.trim()
}
export function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('标识或位置超出允许范围。')
  return value
}
export function choice(value, values) {
  if (!values.includes(value)) throw new Error('状态或类别无效。')
  return value
}
export function tags(value = []) {
  if (!Array.isArray(value) || value.length > 30) throw new Error('标签最多 30 个。')
  return [...new Set(value.map(tag => text(tag, '标签', 80)))]
}
export function row(db, table, id) {
  const result = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(integer(id))
  if (!result) throw new Error('记录不存在。')
  return result
}
export function document(db, id, kind) {
  const value = row(db, 'documents', id)
  if (kind && value.kind !== kind || ['archived', 'rejected'].includes(value.state)) throw new Error('文档类型或状态不允许此操作。')
  return value
}
export function sourceStatus(db, documentId, versionId) {
  if (documentId == null && versionId == null) return { status: 'unbound' }
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(documentId ?? null)
  const version = db.prepare('SELECT * FROM document_versions WHERE id=?').get(versionId ?? null)
  if (!doc || !version || version.document_id !== documentId) return { status: 'unavailable' }
  const base = { document: doc.id, version: version.id, activeVersion: doc.active_version_id, sha256: hash(version.content) }
  const states = [doc.state, version.state]
  const status = states.some(state => ['archived', 'rejected'].includes(state)) ? 'unavailable'
    : states.some(state => !['accepted', 'final'].includes(state)) ? 'pending' : doc.active_version_id !== versionId ? 'stale' : 'current'
  return { ...base, status }
}
export function source(db, input, canonical = false) {
  const documentId = input.source_document_id ?? null, versionId = input.source_version_id ?? null
  if ((documentId === null) !== (versionId === null)) throw new Error('来源必须同时指定文档 ID 和精确版本 ID。')
  if (documentId !== null) {
    integer(documentId); integer(versionId)
    if (row(db, 'document_versions', versionId).document_id !== documentId) throw new Error('来源版本不属于此文档。')
  }
  const status = sourceStatus(db, documentId, versionId)
  if (canonical && !['current', 'unbound'].includes(status.status)) throw new Error(`来源状态为 ${status.status}，不能确认正式记录。`)
  return { source_document_id: documentId, source_version_id: versionId, source: status }
}
export function linkedDocument(db, id) { return id == null ? null : document(db, id).id }
export const factStates = ['idea', 'canonical', 'archived', 'rejected']
export function decorated(db, value) {
  if (!value) return null
  const { tags_json, ...rest } = value
  return { ...rest, ...(tags_json ? { tags: JSON.parse(tags_json) } : {}),
    ...('source_version_id' in value ? { source: sourceStatus(db, value.source_document_id, value.source_version_id) } : {}) }
}
