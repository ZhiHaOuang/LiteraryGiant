import { version } from './manuscript.js'

export function activate(db, doc, target, state, { updateSceneStatus = true } = {}) {
  db.prepare('UPDATE document_versions SET state=? WHERE id=?').run(state, target)
  db.prepare('UPDATE documents SET active_version_id=?,state=?,updated_at=? WHERE id=?')
    .run(target, state, new Date().toISOString(), doc.id)
  if (updateSceneStatus && doc.kind === 'scene') db.prepare('UPDATE scene_cards SET status=?,updated_at=? WHERE document_id=?')
    .run(state, new Date().toISOString(), doc.id)
  refreshSearch(db,doc,target)
}

export function refreshSearch(db,doc,target) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_fts'").get()) {
    const tags = db.prepare("SELECT tag FROM entity_tags WHERE owner_type='document' AND owner_id=?").all(doc.id).map(row => row.tag).join(' ')
    db.prepare('DELETE FROM document_fts WHERE rowid=?').run(doc.id)
    db.prepare('INSERT INTO document_fts(rowid,slug,title,kind,content,tags) VALUES (?,?,?,?,?,?)')
      .run(doc.id, doc.slug, doc.title, doc.kind, version(db, doc.id, target).content, tags)
  }
}
