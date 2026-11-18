import { realpathSync } from 'node:fs'
import { sha, contextReferences, legacyReferences } from './receipts.js'

const positive = value => Number.isSafeInteger(value) && value > 0
const maxRows = 5000
const maxBytes = 16 * 1024 * 1024

export function inspect(db, path, document, version, offset, readManaged) {
  if (!positive(document) || version !== null && !positive(version)) throw new Error('文档或版本编号无效。')
  const subject = db.prepare('SELECT id,title,kind,state,active_version_id FROM documents WHERE id=?').get(document)
  if (!subject) throw new Error('文档不存在。')
  const owned = db.prepare('SELECT id,state,version_number FROM document_versions WHERE document_id=? AND id=?')
  if (version !== null && !owned.get(document, version)) throw new Error('所选版本不属于此文档。')
  const book = sha(JSON.stringify(realpathSync(path)))
  const stats = { scanned: {}, limited: [], invalid: 0, indexOnly: 0, unsupported: 0, unrecorded: 0 }
  const items = [], known = new Set(), versions = new Map()
  let discovered = 0, bytes = 0

  function scan(name, query, visit, ...params) {
    let count = 0
    for (const row of db.prepare(query + ' LIMIT 5001').iterate(...params)) {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (count === maxRows || bytes + size > maxBytes) {
        stats.limited.push(name)
        break
      }
      count++
      bytes += size
      visit(row)
    }
    stats.scanned[name] = count
  }
  function add(item, owner, sourceVersion, relation) {
    if (owner !== document || version !== null && sourceVersion !== version) return
    let status = '仅登记文档'
    if (sourceVersion !== null) {
      if (!positive(sourceVersion)) { stats.invalid++; return }
      if (!versions.has(sourceVersion)) versions.set(sourceVersion, owned.get(document, sourceVersion))
      const source = versions.get(sourceVersion)
      if (!source) { stats.invalid++; return }
      if (['archived','rejected'].includes(subject.state) || ['archived','rejected'].includes(source.state)) status = '已归档或拒绝'
      else if (source.id === subject.active_version_id) status = '当前版本'
      else status = source.state === 'candidate' ? '候选版本' : '历史版本'
    }
    const key = JSON.stringify([item.kind,item.id,sourceVersion,relation])
    if (known.has(key)) return
    known.add(key)
    if (discovered++ >= offset && items.length < 50) items.push({ ...item, sourceVersion, relation, status })
  }

  for (const [table, kind, state] of [['story_facts','作品事实','state'],['fact_proposals','事实提案','status']]) {
    scan(table, `SELECT id,fact_key AS title,${state} AS state,source_version_id FROM ${table} WHERE source_document_id=? ORDER BY id`,
      row => {
        if (!positive(row.source_version_id)) { stats.invalid++; return }
        add({ kind, id: row.id, title: row.title, state: row.state }, document, row.source_version_id, '声明来源')
      }, document)
  }
  if (version === null) {
    scan('timeline', 'SELECT id,label,state FROM timeline_entries WHERE source_document_id=? ORDER BY id', row =>
      add({ kind:'时间记录',id:row.id,title:row.label,state:row.state },document,null,'关联正文'), document)
    scan('foreshadowing', 'SELECT id,title,state,setup_document_id,payoff_document_id FROM foreshadowing WHERE setup_document_id=? OR payoff_document_id=? ORDER BY id', row => {
      const item = { kind:'伏笔',id:row.id,title:row.title,state:row.state }
      add(item,row.setup_document_id,null,'埋设位置')
      add(item,row.payoff_document_id,null,'回收位置')
    }, document, document)
  }
  // Read version metadata in one consistent SQLite snapshot. Load prose only for output-bound old receipts.
  const body = db.prepare('SELECT CASE WHEN length(CAST(content AS BLOB))<=2097152 THEN content END AS content FROM document_versions WHERE id=?')
  scan('versions', `SELECT v.id,v.document_id,v.state,v.version_number,d.title,d.kind,d.active_version_id,
    CASE WHEN length(CAST(v.metadata_json AS BLOB))<=1048576 THEN v.metadata_json END AS raw
    FROM document_versions v JOIN documents d ON d.id=v.document_id ORDER BY v.id DESC`, row => {
    let metadata
    try { metadata = JSON.parse(row.raw) } catch {}
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) { stats.invalid++; return }
    const item = {kind:'文档版本',id:row.id,document:row.document_id,number:row.version_number,title:row.title,state:row.state}
    const link = (owner, id, relation) => add(item, owner, id, relation)
    for (const field of ['base_version_id','previous_version_id','source_version_id']) {
      if (positive(metadata[field])) link(row.document_id, metadata[field], '编辑依据')
    }
    const generation = metadata.generation
    if (generation?.source) link(generation.source.document, generation.source.version, '生成来源版本')
    contextReferences(generation?.context, book, link, stats)
    if (metadata.generation_sources) {
      const output = body.get(row.id).content
      bytes += typeof output === 'string' ? Buffer.byteLength(output) : 0
      if (bytes > maxBytes) { stats.limited.push('legacy-receipts'); return }
      legacyReferences(metadata, output, link, stats)
    } else if (!generation) stats.unrecorded++

    if (row.id !== row.active_version_id || !['creative_decision','narrative_knowledge'].includes(row.kind)) return
    try {
      const record = readManaged?.(path,row.kind,row.document_id)
      if (!record || record.version_id !== row.id) { stats.unsupported++; return }
      const selected = record.selection ?? record.confirmed
      for (const source of selected?.sources ?? []) link(source.document_id,source.version_id,
        row.kind === 'creative_decision' ? '已选方向依据' : '已确认认知依据')
    } catch { stats.invalid++ }
  })
  scan('scenePlans', `SELECT s.document_id,d.title,s.status,s.plan_state,
    CASE WHEN length(CAST(s.metadata_json AS BLOB))<=1048576 THEN s.metadata_json END AS raw
    FROM scene_cards s JOIN documents d ON d.id=s.document_id ORDER BY s.document_id`, row => {
    let metadata
    try { metadata = JSON.parse(row.raw) } catch {}
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) { stats.invalid++; return }
    for (const [kind, generation] of [['待审场景计划',metadata.lg_plan_proposal?.generation],[row.plan_state === 'approved' ? '已批准场景计划' : '前次批准的场景计划',metadata.lg_plan_generation]]) {
      contextReferences(generation?.context, book, (owner,id,relation) =>
        add({ kind, id:row.document_id,title:row.title,state:row.status },owner,id,relation), stats)
    }
  })
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_review_runs'").get()) {
    scan('reviews', 'SELECT id,CASE WHEN length(CAST(source_json AS BLOB))<=1048576 THEN source_json END AS raw FROM lg_review_runs ORDER BY rowid DESC', row => {
      let source
      try { source = JSON.parse(row.raw) } catch {}
      if (!source?.target) { stats.invalid++; return }
      const item = {kind:'审阅报告',id:row.id,title:'审阅报告',state:null}
      if (source.target.section === 'manuscript') add(item, source.target.id, source.target.version_id, '审阅对象')
      contextReferences(source.context?.receipt, book, (owner,id,relation) => add(item,owner,id,relation), stats)
    })
  }
  return { subject, version, items, discovered, nextOffset: offset + items.length < discovered ? offset + items.length : null, stats }
}
