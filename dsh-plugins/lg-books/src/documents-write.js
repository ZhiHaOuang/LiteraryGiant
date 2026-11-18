import { digest } from './manuscript.js'
import { readDocument, editableKinds, field } from './documents-read.js'
const now = () => new Date().toISOString()
const protectedKeys = key => /^(generation|generation_sources|generation_output_sha256|required_decision|base_version_id|source_version_id|story_index|lg_)/u.test(key)
function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 16000 || Object.keys(value).some(protectedKeys)) throw new Error('自定义元数据格式无效或使用了保留字段。')
  return value
}
function tags(values) {
  if (!Array.isArray(values) || values.length > 30) throw new Error('标签最多 30 项。')
  return [...new Set(values.map(value => field(value,'标签',100).trim()))].sort()
}
function approvalMetadata(value) {
  if (value.required_decision || value.generation_sources || value.generation_output_sha256) throw new Error('此版本的旧审批／来源规则尚未迁移，请使用原流程。')
}
export function planDocument(db, input) {
  if (!input || typeof input.action !== 'string' || JSON.stringify(input).length > 500000) throw new Error('资料变更格式或大小无效。')
  const reason = field(input.reason ?? '', '修改说明', 2000)
  if (input.action === 'create') {
    if (!editableKinds.includes(input.kind)) throw new Error('正文、方向与认知文档请使用专用入口。')
    const slug = field(input.slug,'文档标识',200), title = field(input.title,'标题',200).trim()
    if (!/^[\p{L}\p{N}_-]+$/u.test(slug) || db.prepare('SELECT 1 FROM documents WHERE slug=?').get(slug)) throw new Error('文档标识无效或已存在。')
    const after = { kind: input.kind, slug, title, content: field(input.content ?? '','内容',400000,true), tags: tags(input.tags ?? []), metadata: metadata(input.metadata ?? {}) }
    return { action: input.action, before: null, after, reason }
  }
  const before = readDocument(db, input.id, input.version)
  if (!before.editable) throw new Error('章节与场景正文必须使用文学编辑台的正文入口。')
  if (input.expected_token !== before.token) throw new Error('资料或当前版本已变化，请刷新。')
  if (before.document.state === 'archived' && input.action !== 'reopen') throw new Error('请先恢复已归档资料。')
  if (['edit','candidate','restore'].includes(input.action)) {
    if (input.action === 'restore') approvalMetadata(before.selected.metadata)
    const content = input.action === 'restore' ? before.selected.content : field(input.content,'内容',400000,true)
    return { action: input.action, before, after: { content, state: input.action === 'edit' ? before.document.state : 'candidate',
      ...(input.action === 'restore' && before.selected.metadata.generation ? { generation: before.selected.metadata.generation } : {}) }, reason }
  }
  if (input.action === 'update') {
    const custom = input.metadata === undefined ? before.document.metadata : { ...metadata(input.metadata), ...Object.fromEntries(Object.entries(before.document.metadata).filter(([key]) => protectedKeys(key))) }
    return { action: input.action, before, after: { title: input.title === undefined ? before.document.title : field(input.title,'标题',200).trim(), tags: input.tags === undefined ? before.document.tags : tags(input.tags), metadata: custom }, reason }
  }
  if (input.action === 'accept') {
    const selected = before.selected; approvalMetadata(selected.metadata)
    if (selected.state === 'candidate') {
      if (selected.metadata.schema !== 'lg.document-candidate.v1' || selected.metadata.base_version_id !== before.current.id || selected.metadata.source_token !== before.token) throw new Error('资料候选来源已变化或审批规则未知，请重新修订。')
    } else if (selected.id !== before.current.id || !['draft','accepted','final'].includes(selected.state)) throw new Error('历史资料需先恢复为新候选，再审阅采用。')
    if (input.final !== undefined && typeof input.final !== 'boolean') throw new Error('定稿标记必须是布尔值。')
    return { action: input.action, before, after: { version: selected.id, state: input.final ? 'final' : 'accepted' }, reason }
  }
  if (input.action === 'reject') {
    if (before.selected.id === before.current.id || before.selected.state !== 'candidate') throw new Error('只能拒绝尚未采用的资料候选。')
    return { action: input.action, before, after: { version: before.selected.id, state: 'rejected' }, reason }
  }
  if (input.action === 'reopen' && before.document.state !== 'archived') throw new Error('仅已归档资料可以恢复。')
  if (input.action === 'archive' || input.action === 'reopen') return { action: input.action, before,
    after: { state: input.action === 'archive' ? 'archived' : before.current.state }, reason }
  throw new Error('未知资料变更。')
}
function index(db, id) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_fts'").get()) return
  const value = readDocument(db,id)
  db.prepare('DELETE FROM document_fts WHERE rowid=?').run(id)
  db.prepare('INSERT INTO document_fts(rowid,slug,title,kind,content,tags) VALUES (?,?,?,?,?,?)').run(id,value.document.slug,value.document.title,value.document.kind,value.current.content,value.document.tags.join(' '))
}
function setTags(db, id, values) {
  db.prepare("DELETE FROM entity_tags WHERE owner_type='document' AND owner_id=?").run(id)
  for (const value of values) db.prepare("INSERT INTO entity_tags(owner_type,owner_id,tag) VALUES ('document',?,?)").run(id,value)
}
export function applyDocument(db, value, verifyGeneration = null) {
  const { before, after, action, reason } = value; let id = before?.document.id, version = before?.current.id
  if (action === 'create') {
    id = Number(db.prepare("INSERT INTO documents(kind,slug,title,state,metadata_json,created_at,updated_at) VALUES (?,?,?,'draft',?,?,?)").run(after.kind,after.slug,after.title,JSON.stringify(after.metadata),now(),now()).lastInsertRowid)
    setTags(db,id,after.tags)
  }
  if (['create','edit','candidate','restore'].includes(action)) {
    const number = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM document_versions WHERE document_id=?').get(id).n
    const state = action === 'create' ? 'draft' : after.state
    const meta = before ? { schema: 'lg.document-candidate.v1', base_version_id: before.current.id, source_version_id: before.selected.id, source_token: before.token,
      ...(action === 'restore' ? { restored_from_version: before.selected.version_number } : {}), ...(after.generation ? { generation: after.generation } : {}) } : {}
    version = Number(db.prepare('INSERT INTO document_versions(document_id,version_number,state,content,reason,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)').run(id,number,state,after.content,reason,JSON.stringify(meta),now()).lastInsertRowid)
    if (action === 'create' || action === 'edit') db.prepare('UPDATE documents SET active_version_id=?,state=?,updated_at=? WHERE id=?').run(version,state,now(),id)
  } else if (action === 'update') {
    db.prepare('UPDATE documents SET title=?,metadata_json=?,updated_at=? WHERE id=?').run(after.title,JSON.stringify(after.metadata),now(),id);setTags(db,id,after.tags)
  } else if (action === 'accept' || action === 'reject') {
    version = after.version
    if (action === 'accept') {
      if (before.selected.metadata.generation) {
        if (!verifyGeneration) throw new Error('候选来源校验服务不可用。')
        verifyGeneration(before.selected.metadata.generation)
      }
      db.prepare('UPDATE documents SET active_version_id=?,state=?,updated_at=? WHERE id=?').run(version,after.state,now(),id)
    }
    db.prepare('UPDATE document_versions SET state=? WHERE id=?').run(after.state,version)
  } else db.prepare('UPDATE documents SET state=?,updated_at=? WHERE id=?').run(after.state,now(),id)
  index(db,id)
  return { id, version, action, changesActive: !['candidate','restore','reject'].includes(action) }
}
export function documentOperation(db, operation, signature, apply) {
  if (typeof operation !== 'string' || !/^[\w-]{16,80}$/u.test(operation)) throw new Error('资料操作标识无效。')
  db.exec('CREATE TABLE IF NOT EXISTS lg_document_operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL)')
  const previous = db.prepare('SELECT * FROM lg_document_operations WHERE id=?').get(operation)
  if (previous) { if (previous.signature !== signature) throw new Error('重复资料操作的内容发生变化。'); return JSON.parse(previous.result) }
  const result = apply();db.prepare('INSERT INTO lg_document_operations VALUES (?,?,?,?)').run(operation,signature,JSON.stringify(result),now());return result
}
