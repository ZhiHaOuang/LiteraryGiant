import { createHash } from 'node:crypto'
export const now = () => new Date().toISOString()
export const sha = text => createHash('sha256').update(text).digest('hex')
export const hash = value => sha(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item))
export function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('规划标识、顺序或上限无效。')
  return value
}
export function text(value, label, max = 12000, empty = false) {
  if (typeof value !== 'string' || !empty && !value.trim() || value.length > max) throw new Error(`${label}格式无效或超过 ${max} 字。`)
  return value
}
export function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('规划记录字段无效。')
  return value
}
export function doc(db, id, kind) {
  const value = db.prepare('SELECT * FROM documents WHERE id=?').get(integer(id))
  if (!value || kind && value.kind !== kind || ['archived', 'rejected'].includes(value.state)) throw new Error('规划目标文档不存在或类型／状态无效。')
  return value
}
export function sourceState(db, sources) {
  const details = sources.map(source => {
    const value = db.prepare(`SELECT d.active_version_id,d.state,v.document_id AS owner,v.state AS version_state,
      length(v.content) AS size,substr(v.content,1,400001) AS content FROM documents d LEFT JOIN document_versions v ON v.id=? WHERE d.id=?`).get(source.version_id, source.document_id)
    const current = value && value.owner === source.document_id && value.active_version_id === source.version_id &&
      ![value.state, value.version_state].some(state => ['archived', 'rejected'].includes(state)) && value.size <= 400000
    return { ...source, status: current ? 'current' : 'stale', active_version_id: value?.active_version_id ?? null,
      document_state: value?.state ?? null, version_state: value?.version_state ?? null, sha256: current ? sha(value.content) : null }
  })
  return { status: details.some(item => item.status !== 'current') ? 'stale' : sources.length ? 'current' : 'unbound', details }
}
export function requireSources(db, sources) {
  const state = sourceState(db, sources)
  if (state.status === 'stale') throw new Error('规划来源已变化或不可用，请先复核。')
  return state
}
export function writeVersion(db, id, content, reason) {
  const before = doc(db, id), number = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM document_versions WHERE document_id=?').get(id).n
  const version = Number(db.prepare(`INSERT INTO document_versions(document_id,version_number,state,content,reason,metadata_json,created_at) VALUES (?,?,'draft',?,?,?,?)`).run(id, number, content, reason, JSON.stringify({ previous_version_id: before.active_version_id }), now()).lastInsertRowid)
  db.prepare("UPDATE documents SET active_version_id=?,state='draft',updated_at=? WHERE id=?").run(version, now(), id)
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_fts'").get()) {
    const tags = db.prepare("SELECT tag FROM entity_tags WHERE owner_type='document' AND owner_id=?").all(id).map(row => row.tag).join(' ')
    db.prepare('DELETE FROM document_fts WHERE rowid=?').run(id)
    db.prepare('INSERT INTO document_fts(rowid,slug,title,kind,content,tags) VALUES (?,?,?,?,?,?)').run(id, before.slug, before.title, before.kind, content, tags)
  }
  return version
}
export function createDocument(db, { kind, slug, title, parent_id = null, sequence = null, tags = [] }, content = '') {
  text(slug, '文档标识', 200); text(title, '标题', 200)
  if (!/^[\p{L}\p{N}_-]+$/u.test(slug)) throw new Error('文档标识只能包含文字、数字、下划线和连字符。')
  const id = Number(db.prepare(`INSERT INTO documents(kind,slug,title,state,parent_id,sequence,metadata_json,created_at,updated_at) VALUES (?,?,?,'draft',?,?,'{}',?,?)`).run(kind, slug, title.trim(), parent_id, sequence, now(), now()).lastInsertRowid)
  if (!Array.isArray(tags) || tags.length > 30) throw new Error('标签最多 30 个。')
  for (const tag of new Set(tags.map(tag => text(tag, '标签', 100).trim()))) db.prepare("INSERT INTO entity_tags(owner_type,owner_id,tag) VALUES ('document',?,?)").run(id, tag)
  writeVersion(db, id, content, 'Created planning document')
  return id
}
