import { integer, choice, document, hash } from './common.js'
import { knowledge } from './knowledge.js'

export function knowledgeView(db, input) {
  const audience = choice(input.audience, ['character', 'reader']), position = integer(input.position, -1e9, 1e9)
  const holder = input.holder_document_id ?? null, limit = integer(input.limit ?? 50, 1, 200)
  if (audience === 'character') document(db, integer(holder), 'character')
  else if (holder !== null) throw new Error('读者视角不能指定人物。')
  const where = "kind='narrative_knowledge' AND parent_id IS ? AND sequence<=? AND state NOT IN ('archived','rejected')"
  const rows = db.prepare('SELECT id FROM documents WHERE ' + where + ' ORDER BY sequence DESC,id LIMIT 5001').all(holder, position)
  const result = { view: { audience, axis: audience === 'character' ? 'story' : 'reading', position, holder_document_id: holder,
    scope: 'registered_records_only', model_input_isolation: false }, statements: [], withheld: [], invalid: 0, truncated: rows.length > 5000,
    coverage: 'unknown', note: '只投影已登记且确认的认知；位置由作者定义。来源是依据，不证明命题客观为真。此接口不隔离会话历史或其他工具。' }
  let bytes = 0
  for (const { id } of rows.slice(0, 5000)) {
    let value
    try { value = knowledge(db, id) } catch { result.invalid++; continue }
    const t = value.topic, confirmed = value.confirmed
    if (t.audience !== audience || t.holder_document_id !== holder || !confirmed || confirmed.until_position !== null && position >= confirmed.until_position) continue
    if (!['current', 'unbound'].includes(value.source_status)) {
      if (result.withheld.length < limit) result.withheld.push({ record_id: id, source_status: value.source_status })
      else result.truncated = true
      continue
    }
    const visible = Object.fromEntries(['proposal_version_id', 'proposal_version_number', 'content', 'stance', 'until_position', 'sources'].map(key => [key, confirmed[key]]))
    const item = { record_id: id, topic: t, ...visible, source_status: value.source_status }
    bytes += JSON.stringify(item).length
    if (result.statements.length >= limit || bytes > 50000) { result.truncated = true; continue }
    result.statements.push(item)
  }
  result.coverage = result.statements.length ? 'partial' : 'unknown'
  return { ...result, fingerprint: hash(result) }
}
