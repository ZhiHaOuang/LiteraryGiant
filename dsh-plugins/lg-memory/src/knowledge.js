import { text, integer, choice, row, document, sourceStatus, hash, now } from './common.js'

const kind = 'narrative_knowledge', schema = 'lg.narrative-knowledge.v1'
const topicKeys = ['audience', 'holder_document_id', 'key', 'from_position']
const statementKeys = ['content', 'stance', 'until_position', 'sources', 'rationale']
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('叙事认知字段不完整或含未知字段。')
}
function topic(value) {
  exact(value, topicKeys); choice(value.audience, ['character', 'reader']); text(value.key, '认知主题', 128)
  integer(value.from_position, -1e9, 1e9)
  if (value.audience === 'character') integer(value.holder_document_id)
  else if (value.holder_document_id !== null) throw new Error('读者认知不能指定人物。')
  return value
}
function statement(value, t, confirmed = false) {
  exact(value, confirmed ? [...statementKeys, 'proposal_version_id', 'proposal_version_number'] : statementKeys)
  text(value.content, '认知内容'); text(value.rationale, '依据', 4000); choice(value.stance, ['knows', 'believes', 'uncertain'])
  if (value.until_position !== null) {
    integer(value.until_position, -1e9, 1e9)
    if (value.until_position <= t.from_position) throw new Error('认知区间结束位置必须大于起点。')
  }
  if (!Array.isArray(value.sources) || value.sources.length > 32) throw new Error('认知来源最多 32 个。')
  const seen = new Set()
  for (const source of value.sources) {
    exact(source, ['document_id', 'version_id']); integer(source.document_id); integer(source.version_id)
    const key = `${source.document_id}:${source.version_id}`
    if (seen.has(key)) throw new Error('不能重复声明同一认知来源。')
    seen.add(key)
  }
  if (confirmed) { integer(value.proposal_version_id); integer(value.proposal_version_number) }
  return value
}
function payload(version) {
  if (typeof version.content !== 'string' || version.content.length > 128000) throw new Error('认知记录过大或无效。')
  const value = JSON.parse(version.content)
  exact(value, ['schema', 'operation', 'topic', 'proposal_version_number', 'proposal', 'confirmed', 'status'])
  if (value.schema !== schema) throw new Error('认知记录格式不受支持。')
  topic(value.topic); statement(value.proposal, value.topic); integer(value.proposal_version_number)
  choice(value.operation, ['propose', 'confirm', 'withdraw']); choice(value.status, ['unconfirmed', 'confirmed', 'withdrawn'])
  if ((value.status === 'confirmed') !== (value.confirmed !== null)) throw new Error('认知确认状态不一致。')
  if (value.confirmed !== null) statement(value.confirmed, value.topic, true)
  return value
}
function proposalVersion(db, doc, number) {
  const version = db.prepare('SELECT * FROM document_versions WHERE document_id=? AND version_number=?').get(doc.id, integer(number))
  if (!version) throw new Error('指定认知提案版本不存在。')
  const value = payload(version)
  if (value.operation !== 'propose' || value.proposal_version_number !== version.version_number) throw new Error('只能确认实际提案版本。')
  return { version, value }
}
export function knowledgeSources(db, sources) {
  const details = sources.map(item => ({ ...item, ...sourceStatus(db, item.document_id, item.version_id) }))
  const status = ['unavailable', 'stale', 'pending'].find(status => details.some(item => item.status === status)) ?? (details.length ? 'current' : 'unbound')
  return { status, details }
}
export function knowledge(db, id) {
  const doc = row(db, 'documents', id), version = row(db, 'document_versions', doc.active_version_id)
  if (doc.kind !== kind || version.document_id !== doc.id) throw new Error('认知文档或当前版本不一致。')
  const value = payload(version), original = proposalVersion(db, doc, value.proposal_version_number)
  if (doc.parent_id !== value.topic.holder_document_id || doc.sequence !== value.topic.from_position ||
    hash(original.value.topic) !== hash(value.topic) || hash(original.value.proposal) !== hash(value.proposal)) throw new Error('认知主题或提案身份不一致。')
  if (value.confirmed) {
    const confirmed = proposalVersion(db, doc, value.confirmed.proposal_version_number)
    const statement = Object.fromEntries(statementKeys.map(key => [key, value.confirmed[key]]))
    if (confirmed.version.id !== value.confirmed.proposal_version_id || hash(confirmed.value.topic) !== hash(value.topic) || hash(confirmed.value.proposal) !== hash(statement)) throw new Error('认知确认来源不一致。')
  }
  const sources = knowledgeSources(db, (value.confirmed ?? value.proposal).sources)
  return { document_id: doc.id, slug: doc.slug, title: doc.title, version_id: version.id, version_number: version.version_number,
    ...value, proposal_version_id: original.version.id, source_status: sources.status, source_details: sources.details,
    proposal_sources: knowledgeSources(db, value.proposal.sources) }
}
function peers(db, holder) {
  const values = db.prepare('SELECT id FROM documents WHERE kind=? AND parent_id IS ? ORDER BY id LIMIT 5001').all(kind, holder)
  if (values.length > 5000) throw new Error('认知主题超过当前单次校验上限。')
  return values
}
export function planKnowledge(db, input) {
  const action = input.action
  if (action === 'knowledge.propose') {
    const slug = text(input.slug, '文档标识', 200), title = text(input.title, '认知标题', 200)
    if (!/^[\p{L}\p{N}_-]+$/u.test(slug)) throw new Error('文档标识只能包含文字、数字、下划线和连字符。')
    const t = topic({ ...input.topic, key: text(input.topic?.key, '认知主题', 128) }), proposed = statement({ ...input.statement, rationale: input.rationale }, t)
    if (t.audience === 'character') document(db, t.holder_document_id, 'character')
    for (const source of proposed.sources) if (row(db, 'document_versions', source.version_id).document_id !== source.document_id) throw new Error('来源版本不属于此文档。')
    const doc = db.prepare('SELECT * FROM documents WHERE slug=?').get(slug), before = doc ? knowledge(db, doc.id) : null
    integer(input.expected_version_id, 0)
    if (input.expected_version_id !== (doc?.active_version_id ?? 0)) throw new Error('认知版本已经变化，请刷新。')
    if (before && (hash(before.topic) !== hash(t) || before.title !== title)) throw new Error('已有认知的主题与标题不能改变，请沿用其身份。')
    if (doc && ['archived', 'rejected'].includes(doc.state)) throw new Error('认知文档已归档或拒绝。')
    if (!doc && peers(db, t.holder_document_id).some(({ id }) => hash(knowledge(db, id).topic) === hash(t))) throw new Error('同一认知主题已存在，请更新原记录。')
    const number = doc ? db.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM document_versions WHERE document_id=?').get(doc.id).n : 1
    return { action, before, slug, title, after: { schema, operation: 'propose', topic: t, proposal_version_number: number,
      proposal: proposed, confirmed: before?.confirmed ?? null, status: before?.status ?? 'unconfirmed' }, sources: knowledgeSources(db, proposed.sources) }
  }
  const before = knowledge(db, input.id)
  document(db, before.document_id, kind)
  if (integer(input.expected_version_id) !== before.version_id) throw new Error('认知版本已经变化，请刷新。')
  const after = Object.fromEntries(['schema', 'operation', 'topic', 'proposal_version_number', 'proposal', 'confirmed', 'status'].map(key => [key, before[key]]))
  if (action === 'knowledge.withdraw') {
    if (!before.confirmed) throw new Error('没有可撤回的当前确认。')
    return { action, before, after: { ...after, operation: 'withdraw', confirmed: null, status: 'withdrawn' } }
  }
  if (action !== 'knowledge.confirm') throw new Error('未知叙事认知操作。')
  if (before.topic.audience === 'character') document(db, before.topic.holder_document_id, 'character')
  const proposed = proposalVersion(db, { id: before.document_id }, input.proposal_version_number)
  if (hash(proposed.value.topic) !== hash(before.topic)) throw new Error('提案不属于此认知主题。')
  const sources = knowledgeSources(db, proposed.value.proposal.sources)
  if (!['current', 'unbound'].includes(sources.status)) throw new Error('认知来源不是当前已采用版本，请先复核。')
  const confirmed = { ...proposed.value.proposal, proposal_version_id: proposed.version.id, proposal_version_number: proposed.version.version_number }
  if (hash(before.confirmed) === hash(confirmed)) throw new Error('此提案已经确认。')
  for (const { id } of peers(db, before.topic.holder_document_id)) {
    if (id === before.document_id) continue
    const other = knowledge(db, id)
    if (!other.confirmed || other.topic.audience !== before.topic.audience || other.topic.key !== before.topic.key) continue
    if ((confirmed.until_position === null || other.topic.from_position < confirmed.until_position) &&
      (other.confirmed.until_position === null || before.topic.from_position < other.confirmed.until_position)) throw new Error('已确认的认知区间重叠，请先修订或撤回旧确认。')
  }
  return { action, before, sources, after: { ...after, operation: 'confirm', confirmed, status: 'confirmed' } }
}
export function applyKnowledge(db, { before, after, slug, title }) {
  let id = before?.document_id
  if (!id) id = Number(db.prepare(`INSERT INTO documents(kind,slug,title,state,parent_id,sequence,metadata_json,created_at,updated_at) VALUES (?,?,?,'draft',?,?,'{}',?,?)`).run(kind, slug, title, after.topic.holder_document_id, after.topic.from_position, now(), now()).lastInsertRowid)
  const number = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM document_versions WHERE document_id=?').get(id).n
  const content = JSON.stringify(after), version = Number(db.prepare(`INSERT INTO document_versions(document_id,version_number,state,content,reason,metadata_json,created_at) VALUES (?,?,'draft',?,?,?,?)`).run(
    id, number, content, `Narrative knowledge: ${after.operation}; no world fact promotion`, JSON.stringify({ previous_version_id: before?.version_id ?? null }), now()).lastInsertRowid)
  db.prepare("UPDATE documents SET active_version_id=?,state='draft',updated_at=? WHERE id=?").run(version, now(), id)
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_fts'").get()) {
    const doc = row(db, 'documents', id), tagList = db.prepare("SELECT tag FROM entity_tags WHERE owner_type='document' AND owner_id=?").all(id).map(row => row.tag).join(' ')
    db.prepare('DELETE FROM document_fts WHERE rowid=?').run(id)
    db.prepare('INSERT INTO document_fts(rowid,slug,title,kind,content,tags) VALUES (?,?,?,?,?,?)').run(id, doc.slug, doc.title, kind, content, tagList)
  }
  return knowledge(db, id)
}
