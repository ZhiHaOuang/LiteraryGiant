import { createHash } from 'node:crypto'
import { digest, identity } from './manuscript.js'

export function ensureOperationTable(db, withMirrors) {
  db.exec(`CREATE TABLE IF NOT EXISTS lg_plugin_operations
    (id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL)`)
  if (withMirrors) db.exec(`CREATE INDEX IF NOT EXISTS lg_pending_chapter_mirrors
    ON lg_plugin_operations(json_extract(result,'$.chapter')) WHERE json_extract(result,'$.sync')='mirror-pending'`)
}

function structureStamp(db, chapter) {
  const hash = createHash('sha256')
  for (const row of db.prepare(`SELECT id,kind,slug,title,state,parent_id,sequence,active_version_id FROM documents
    WHERE (kind='chapter' AND id=?) OR (kind='scene' AND parent_id=?) ORDER BY id`).iterate(chapter,chapter)) {
    hash.update(JSON.stringify(row))
  }
  return hash.digest('hex')
}

// Called by the trusted planning service inside its own structural write transaction.
export function queueStructureMirror(db, chapter, planningOperation) {
  identity(chapter)
  const signature = digest(['structure-mirror',planningOperation,chapter]), operation = 'plan-mirror-' + signature
  const saved = {operation,chapter,action:'structure-mirror',structureStamp:structureStamp(db,chapter),sync:'mirror-pending'}
  ensureOperationTable(db,true)
  db.prepare('INSERT INTO lg_plugin_operations VALUES(?,?,?,?)').run(operation,signature,JSON.stringify(saved),new Date().toISOString())
  return {chapter,operation}
}

export function currentMirrorSource(db, saved) {
  if (saved.action === 'structure-mirror') return saved.structureStamp === structureStamp(db,saved.chapter)
  const head = db.prepare('SELECT active_version_id,kind,parent_id FROM documents WHERE id=?').get(saved.document)
  return head?.active_version_id === saved.version && (head.kind !== 'scene' || head.parent_id === saved.chapter)
}

export function mirrorReceipt(db, chapter, operation) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_plugin_operations'").get()
  const row = exists && db.prepare('SELECT result FROM lg_plugin_operations WHERE id=?').get(operation)
  const saved = row && JSON.parse(row.result)
  if (!saved || saved.chapter !== chapter || (!saved.changesManuscript && saved.action !== 'structure-mirror')) throw new Error('找不到本章的保存收据。')
  return saved
}
