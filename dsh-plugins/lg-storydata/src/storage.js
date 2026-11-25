import {readFileSync} from 'node:fs'
import {core, digest, fingerprint} from './contracts.js'

const schema = readFileSync(new URL('./schema.sql', import.meta.url),'utf8')
export const ensureSchema = db => db.exec(schema)
export const initialized = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_outline_heads'").get())
export const bookId = db => db.prepare("SELECT value FROM project_meta WHERE key='project_id'").get().value
export const heads = ' FROM lg_outline_heads h JOIN lg_outline_revisions r USING(id,module,revision) '
export function packList(db) {
  const extras = initialized(db) ? db.prepare('SELECT spec FROM lg_outline_packs ORDER BY id').all() : []
  return [core,...extras.map(row=>JSON.parse(row.spec))]
}

export function revision(db,id,module,number) {
  if (!number) return null
  const row = db.prepare('SELECT item FROM lg_outline_revisions WHERE id=? AND module=? AND revision=?').get(id,module,number)
  return row ? JSON.parse(row.item) : null
}

// Only current, active manuscript chapters/scenes can introduce new evidence.
// Cache each document version once per transaction, never between book requests.
export function sourceCheck(db) {
  const cache = new Map()
  const query = db.prepare(`SELECT d.id, d.active_version_id, d.kind, d.state, v.state AS version_state, v.content
    FROM document_versions v JOIN documents d ON v.document_id=d.id WHERE v.id=?`)
  return source => {
    if (!cache.has(source.version_id)) {
      const row = query.get(source.version_id)
      cache.set(source.version_id, row && {
        document:row.id, active:row.active_version_id, eligible:['chapter','scene'].includes(row.kind)
          && ['draft','accepted','final'].includes(row.state) && ['draft','accepted','final'].includes(row.version_state),
        hash:digest(row.content), lines:row.content.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean)
      })
    }
    const ref = cache.get(source.version_id)
    return Boolean(ref && ref.eligible && ref.document === source.document_id && ref.active === source.version_id
      && ref.hash === source.sha256 && ref.lines[source.paragraph-1]?.includes(source.quote))
  }
}

export function compareBatch(db, proposal) {
  const allowed = new Map()
  for (const pack of packList(db)) for (const [name, sections] of Object.entries(pack.modules)) {
    allowed.set(pack.id+'@'+pack.version+'.'+name, sections)
  }
  const dossiers = new Map()
  const find = db.prepare('SELECT r.section, json_extract(r.item,\'$.title\') AS title' + heads + 'WHERE h.id=? LIMIT 1')
  for (const item of proposal.changes) {
    const known = dossiers.get(item.id) ?? find.get(item.id)
    if (known && (known.section !== item.section || known.title !== item.title)) throw Error('同一档案 ID 的板块或名称不一致')
    dossiers.set(item.id,item)
  }
  const seen = new Set(), changed = [], check = sourceCheck(db)
  const current = db.prepare('SELECT r.item,h.revision' + heads + 'WHERE h.id=? AND h.module=?')
  for (const item of proposal.changes) {
    if (!allowed.get(item.module)?.includes(item.section)) throw Error('本书尚未为该板块启用此模块')
    const key = item.id + '/' + item.module
    if (seen.has(key)) throw Error('同一更新内重复的档案模块')
    seen.add(key)
    const prior = current.get(item.id,item.module)
    if ((prior?.revision ?? 0) !== item.expected_revision) throw Error('Main 版本已变化，请重新比较')
    if (!item.evidence.every(check)) throw Error('条目原文依据无效或已过期')
    for (const target of item.links) {
      if (target === item.id || !(dossiers.has(target) || find.get(target))) throw Error('关联目标无效 ' + target)
    }
    for (const entry of item.entries??[]) {
      for (const event of [entry.event_id,entry.related_event_id].filter(Boolean)) {
        if ((dossiers.get(event)??find.get(event))?.section!=='plot') throw Error('event_id 必须指向情节板块')
      }
      if (entry.target_id && (dossiers.get(entry.target_id)??find.get(entry.target_id))?.section!=='people') {
        const hasRecords=db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_story_data_records'").get()
        const character=hasRecords && db.prepare(`SELECT 1 FROM lg_story_data_records r
          JOIN lg_story_data_revisions v ON v.id=r.head WHERE r.id=? AND r.type='entity'
          AND json_extract(v.payload_json,'$.payload.entity_kind')='character'`).get(entry.target_id)
        if (!character) throw Error('找不到本书对应的人物引用')
      }
    }
    // New citations alone do not cause Main to grow. The reviewer compares meaning.
    const meaning = value => fingerprint([value.text.trim(),value.basis,[...value.links].sort(),
      value.entries?.map(({sources,tags,...fields})=>({...fields,tags:[...tags].sort()})).sort((a,b)=>a.key.localeCompare(b.key))])
    const previous = prior && JSON.parse(prior.item)
    if (!previous || meaning(previous) !== meaning(item) || !previous.evidence.every(check)) changed.push(item)
  }
  return changed
}

