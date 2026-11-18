import { createHash } from 'node:crypto'

// Legacy fingerprints use Python json.dumps(sort_keys=True, ensure_ascii=False), including spaces.
function pythonJson(value,space=' ') {
  if (JSON.isRawJSON(value)) return value.rawJSON
  if (Array.isArray(value)) return '[' + value.map(v=>pythonJson(v,space)).join(','+space) + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(key => JSON.stringify(key) + ':'+space + pythonJson(value[key],space)).join(','+space) + '}'
  return JSON.stringify(value)
}
export const legacyFingerprint = value => createHash('sha256').update(pythonJson(value)).digest('hex')
export const compactFingerprint = value => createHash('sha256').update(pythonJson(value,'')).digest('hex')

// Report digests distinguish Python floats (0.0) from integers (0), even when their values compare equal.
export function parseReportIdentity(raw) {
  return JSON.parse(raw,(_key,value,context)=>{
    if (typeof value!=='number') return value
    const source=context.source
    if (!/[.eE]/u.test(source)) return JSON.rawJSON(BigInt(source).toString())
    if (!Number.isFinite(value)) throw new Error('报告含有无法核对的小数。')
    const size=Math.abs(value)
    if (size!==0&&(size<1e-4||size>=1e16)) {
      const [mantissa,exponent]=value.toExponential().split('e')
      return JSON.rawJSON(mantissa+'e'+exponent[0]+exponent.slice(1).padStart(2,'0'))
    }
    return JSON.rawJSON(Object.is(value,-0)?'-0.0':String(value)+(Number.isInteger(value)?'.0':''))
  })
}

function boundedRows(statement,...params) {
  const rows = []
  let bytes = 0
  for (const row of statement.iterate(...params)) {
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (rows.length >= 999 || bytes > 32_000_000) throw new Error('章节或正式设定超过旧报告快照上限。')
    rows.push(row)
  }
  return rows
}

export function analysisSnapshots(book, readDecision) {
  const db = book.db
  const facts = boundedRows(db.prepare(`SELECT id,category,fact_key AS key,value,state,tags_json,source_document_id,source_version_id,rationale,created_at,updated_at
    FROM story_facts WHERE state='canonical' ORDER BY category,fact_key,id LIMIT 1000`))
  const canonical = facts.map(({tags_json,...fact}) => ({...fact,tags:JSON.parse(tags_json)}))
  const prefix = facts => createHash('sha256').update('{"canonical": ' + pythonJson(facts))
  const full = prefix(canonical), source = prefix([])
  const decisions = []
  for (const row of db.prepare("SELECT d.id,v.content FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.kind='creative_decision' ORDER BY d.id").iterate()) {
    const payload = JSON.parse(row.content)
    if (!payload || payload.schema !== 'lg.creative-decision.v1' || !Object.hasOwn(payload,'selection')) throw new Error('创作方向记录无效。')
    if (payload.selection === null) continue
    decisions.push({id:row.id,topic:payload.topic})
  }
  function selectedDecision(row) {
    if (!row.value) {
      if (!readDecision) throw new Error('请启用新版 lg-planning 以核对已选创作方向。')
      const item = readDecision(db,row.id)
      const { request,...selection } = item.selection
      row.value = {document_id:row.id,topic:item.topic,selection,source_status:item.source_status,
        source_details:item.source_details.map(({sha256,...detail}) => detail)}
    }
    return row.value
  }
  return chapter => {
    const documents = boundedRows(db.prepare(`SELECT d.id,d.active_version_id AS version_id,d.title,COALESCE(v.content,'') AS content,d.state
      FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id
      WHERE d.id=? OR (d.kind='scene' AND d.parent_id=?) ORDER BY d.kind,COALESCE(d.sequence,999999),d.created_at,d.id LIMIT 1000`),chapter.id,chapter.id)
    const selected = decisions.filter(({topic}) => topic.scope === 'work' || (topic.scope === 'part' && topic.document_id === chapter.parent_id)
      || (topic.scope === 'chapter' && topic.document_id === chapter.id)).map(selectedDecision)
    if (selected.length >= 1000) throw new Error('章节超过旧报告快照上限。')
    const body = {project_id:book.project.project_id,chapter:chapter.slug,documents}
    if (selected.length) body.creative_decisions = selected
    const suffix = ', ' + pythonJson(body).slice(1)
    const references = new Map(documents.map(doc => [doc.id,{...doc,kind:'manuscript'}]))
    for (const item of selected) references.set(item.document_id,{id:item.document_id,version_id:item.selection.options_version_id,
      content:item.selection.content,title:item.selection.title,kind:'selected-plan',source_status:item.source_status})
    return {fingerprint:full.copy().update(suffix).digest('hex'),sourceFingerprint:source.copy().update(suffix).digest('hex'),
      references,facts:canonical,hasPlans:selected.length>0}
  }
}
