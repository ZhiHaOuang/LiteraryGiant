import { targets } from './options.js'

const approved = state => state === 'accepted' || state === 'final'
const tags = row => JSON.parse(row.tags_json || '[]').join('、')

function manuscript(db, drafts, add) {
  // Emit chapters in story order with their own active prose, falling back to eligible scenes.
  const rows = db.prepare(`SELECT c.id AS chapter, c.title AS chapter_title, d.kind, d.title,
    d.state, d.active_version_id, v.state AS version_state, v.content, sc.status AS scene_status
    FROM documents c JOIN documents d ON d.id=c.id OR (d.kind='scene' AND d.parent_id=c.id)
    LEFT JOIN document_versions v ON v.document_id=d.id AND v.id=d.active_version_id
    LEFT JOIN scene_cards sc ON sc.document_id=d.id
    WHERE c.kind='chapter' AND c.state IN ('accepted','final','draft')
    ORDER BY c.sequence IS NULL,c.sequence,c.id,d.kind,d.sequence IS NULL,d.sequence,d.id`).iterate()
  let previous, heading, hasBody
  for (const row of rows) {
    if (row.chapter !== previous) {
      previous = row.chapter
      heading = row.chapter_title
      hasBody = false
    }
    if (hasBody) continue
    if (row.active_version_id != null && row.version_state == null) throw new Error('正文版本引用损坏。')
    const eligible = state => approved(state) || (drafts && state === 'draft')
    if (!eligible(row.state) || !eligible(row.version_state) || !row.content?.trim()) continue
    if (row.scene_status && (row.scene_status === 'archived' || (!drafts && !approved(row.scene_status)))) continue
    if (heading !== null) { add('heading', heading); heading = null }
    if (row.kind === 'scene') add('subheading', row.title)
    else hasBody = true
    add('body', row.content)
  }
}

const categories = {
  characters: /^(?:character|人物|角色)|^(?:relationship|arc|voice|关系|人物弧光|声线)$/iu,
  world: /^(?:world|世界)|^(?:location|faction|rule|history|resource|地点|势力|规则|历史|资源)$/iu,
}

function facts(db, target, drafts, add) {
  // A bound fact is current only while its accepted source is still active.
  const rows = db.prepare(`SELECT f.*, d.active_version_id, d.state AS doc_state, v.state AS version_state
    FROM story_facts f LEFT JOIN documents d ON d.id=f.source_document_id
    LEFT JOIN document_versions v ON v.id=f.source_version_id AND v.document_id=d.id
    WHERE f.state='canonical' OR (? AND f.state='idea') ORDER BY f.category,f.fact_key,f.id`).iterate(Number(drafts))
  let group
  for (const row of rows) {
    if (categories[target] && !categories[target].test(row.category)) continue
    const bound = row.source_document_id != null || row.source_version_id != null
    const outdated = bound && !(approved(row.doc_state) && approved(row.version_state) && row.source_version_id === row.active_version_id)
    if (outdated && !drafts) continue
    if (group !== row.category) { group = row.category; add('heading', group) }
    const note = [row.state === 'idea' && '构想', outdated && '来源待复核'].filter(Boolean).join('、')
    add('subheading', row.fact_key + (note ? '（' + note + '）' : ''))
    add('body', row.value)
    if (row.rationale) add('body', '依据：' + row.rationale)
    if (tags(row)) add('body', '标签：' + tags(row))
  }
}

export function collect(db, name, target, drafts) {
  const blocks = []
  let bytes = 0
  function add(style, text) {
    bytes += Buffer.byteLength(text)
    if (bytes > 16_000_000 || blocks.length >= 100_000) throw new Error('导出超过单份文件上限。')
    blocks.push({ style, text })
  }
  add('title', name + ' · ' + targets[target])
  if (target === 'manuscript') manuscript(db, drafts, add)
  else if (target === 'timeline') {
    for (const row of db.prepare("SELECT * FROM timeline_entries WHERE state='canonical' OR (? AND state='idea') ORDER BY sort_key,id").iterate(Number(drafts))) {
      add('heading', [row.sort_key, row.label].filter(Boolean).join(' · ') + (row.state === 'idea' ? '（构想）' : ''))
      add('body', row.event)
      if (tags(row)) add('body', '标签：' + tags(row))
    }
  } else if (target === 'foreshadowing') {
    for (const row of db.prepare('SELECT * FROM foreshadowing ORDER BY state,id').iterate()) {
      add('heading', row.title + '（' + row.state + '）')
      add('body', '埋设：' + row.setup_note)
      if (row.payoff_note) add('body', '回收：' + row.payoff_note)
      if (tags(row)) add('body', '标签：' + tags(row))
    }
  } else facts(db, target, drafts, add)
  if (blocks.length === 1) throw new Error('当前范围没有可导出的内容。')
  return blocks
}
