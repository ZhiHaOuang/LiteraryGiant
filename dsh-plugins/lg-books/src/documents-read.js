import { digest, identity } from './manuscript.js'
export const editableKinds = ['book','part','outline','world','character','timeline','style','note','research']
export const readableKinds = [...editableKinds,'chapter','scene']
export const states = ['draft','candidate','accepted','final','archived','rejected']
export function field(value, label, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) throw new Error(`${label}格式无效或超过 ${max} 字。`)
  return value
}
export function readDocument(db, id, selectedId) {
  const row = db.prepare('SELECT * FROM documents WHERE id=?').get(identity(id))
  if (!row || !readableKinds.includes(row.kind)) throw new Error('文档不存在或需要专用的方向／认知入口。')
  if (row.metadata_json.length > 16000) throw new Error('文档元数据超过读取上限。')
  const version = versionId => {
    const value = db.prepare('SELECT *,length(content) AS size FROM document_versions WHERE document_id=? AND id=?').get(id, identity(versionId))
    if (!value || value.size > 400000 || value.metadata_json.length > 32000) throw new Error('文档版本不存在、身份不一致或过大。')
    return { ...value, metadata: JSON.parse(value.metadata_json), metadata_json: undefined, size: undefined }
  }
  const current = version(row.active_version_id), selected = selectedId == null || selectedId === current.id ? current : version(selectedId)
  const tags = db.prepare("SELECT tag FROM entity_tags WHERE owner_type='document' AND owner_id=? ORDER BY tag").all(id).map(row => row.tag)
  const document = { ...row, metadata_json: undefined, metadata: JSON.parse(row.metadata_json), tags }
  const token = digest({ document, content: digest(current.content), state: current.state })
  const versions = db.prepare('SELECT id,version_number,state,reason,created_at FROM document_versions WHERE document_id=? ORDER BY version_number DESC LIMIT 100').all(id)
  return { document, current, selected, versions, token, editable: editableKinds.includes(row.kind) }
}
export function listDocuments(db, input = {}) {
  const limit = input.limit ?? 30, offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error('资料分页范围无效。')
  const kinds = input.kind ? [input.kind] : editableKinds
  if (kinds.some(kind => !readableKinds.includes(kind))) throw new Error('此文档类型需要专用入口。')
  const params = [...kinds], clauses = [`d.kind IN (${kinds.map(() => '?').join(',')})`]
  if (input.state) { if (!states.includes(input.state)) throw new Error('文档状态无效。'); clauses.push('d.state=?'); params.push(input.state) }
  else clauses.push("d.state NOT IN ('archived','rejected')")
  if (input.parent_id != null) { clauses.push('d.parent_id=?'); params.push(identity(input.parent_id)) }
  if (input.query) { field(input.query,'检索词',200); clauses.push("instr(lower(d.slug||' '||d.title||' '||substr(COALESCE(v.content,''),1,400000)),lower(?))>0"); params.push(input.query) }
  if (!Array.isArray(input.tags ?? []) || (input.tags ?? []).length > 30) throw new Error('标签格式无效。')
  for (const tag of input.tags ?? []) { clauses.push("EXISTS(SELECT 1 FROM entity_tags t WHERE t.owner_type='document' AND t.owner_id=d.id AND t.tag=?)"); params.push(field(tag,'标签',100)) }
  const from = ' FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE ' + clauses.join(' AND ')
  const total = db.prepare('SELECT COUNT(*) AS n' + from).get(...params).n
  const items = db.prepare('SELECT d.id,d.kind,d.slug,d.title,d.state,d.parent_id,d.sequence,d.active_version_id,v.version_number,substr(v.content,1,200) AS excerpt' + from + ' ORDER BY d.kind,d.sequence IS NULL,d.sequence,d.id LIMIT ? OFFSET ?').all(...params,limit,offset)
  return { items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null }
}
