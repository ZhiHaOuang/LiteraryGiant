import { currentMirrorSource, mirrorReceipt } from './mirror-queue.js'
import { openBook } from './read.js'
import { activate, refreshSearch } from './version-activation.js'
import { identity, digest } from './manuscript.js'
import { pendingImport, recordRecovery, recoveryIntent } from './chapter-file-recovery.js'
import { chapterPath, createFile, hash, maxBytes, parse, readText, refreshFile, render } from './chapter-file-format.js'

const docKeys = ['id', 'version', 'title', 'state', 'sequence']
const snapshot = rows => rows.map(row => Object.fromEntries(docKeys.map(key => [key, row[key]])))
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

function documents(db, chapter) {
  const rows = []
  let bytes = 0
  for (const row of db.prepare(`SELECT d.id,d.slug,d.title,d.state,d.sequence,d.kind,d.active_version_id AS version,
    v.content,v.state AS version_state FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id
    WHERE (d.id=? AND d.kind='chapter') OR (d.parent_id=? AND d.kind='scene')
    ORDER BY d.kind,COALESCE(d.sequence,999999),d.created_at,d.id`).iterate(chapter,chapter)) {
    if (row.content == null || row.content.length > 400_000) throw new Error('作品缺少可编辑的当前版本，或正文超长。')
    bytes += Buffer.byteLength(row.content) + Buffer.byteLength(row.title) + 80
    if (rows.length >= 1000 || bytes > maxBytes) throw new Error('章节文件超过编辑上限。')
    rows.push(row)
  }
  if (rows[0]?.id !== chapter || rows[0].kind !== 'chapter') throw new Error('章节不存在。')
  return rows
}

function baseline(book, chapter) {
  const path = name => chapterPath(book.root, ['.literarygiant','chapter-sync'], name)
  const raw = readText(path(chapter + '.json'), 2_000_000), legacy = raw === null ? null : hash(raw)
  const saved = hasTable(book.db,'lg_chapter_files') && book.db.prepare('SELECT * FROM lg_chapter_files WHERE chapter=?').get(chapter)
  if (saved && saved.legacy === legacy) return { data: JSON.parse(saved.baseline), legacy }
  if (raw === null) {
    if (saved) throw new Error('旧同步基线已移除，请检查作品历史。')
    return { data: null, legacy }
  }
  const data = JSON.parse(raw)
  if (data.schema !== 1 || data.project_id !== book.project.project_id || !/^[a-f0-9]{64}$/u.test(data.file_hash)
    || !Array.isArray(data.documents) || data.documents[0]?.id !== chapter
    || data.documents.some(row => !docKeys.every(key => Object.hasOwn(row,key)))) throw new Error('同步基线与作品或章节不符。')
  return { data: { documents:snapshot(data.documents), file_hash:data.file_hash }, legacy }
}

function inspect(book, chapter) {
  const rows = documents(book.db, chapter), file = rows[0].slug + '.md'
  const path = chapterPath(book.root, ['manuscript','chapters'], file)
  const source = readText(path), current = render(rows), { data, legacy } = baseline(book, chapter)
  const fileHash = source === null ? null : hash(source), heads = snapshot(rows)
  const dbChanged = data && digest(data.documents) !== digest(heads)
  const edited = data && fileHash !== data.file_hash
  let state = 'clean'
  if (source === null) state = 'missing'
  else if (!data) state = 'untracked'
  else if (dbChanged) state = edited ? 'conflict' : 'database-changed'
  else if (edited) state = 'file-edited'
  let parts, problem, blocked
  try { parts = parse(source ?? current, rows) } catch (error) { problem = error.message }
  const changes = parts ? rows.flatMap((row,i) => parts[i] === row.content ? [] :
    [{ document:row.id, title:row.title, version:row.version, before:row.content, after:parts[i] }]) : []
  if (changes.some(change => change.after.length > 400_000)) problem = '修改后的单段文档超过编辑上限。'
  if (rows.some(row => !['draft','accepted','final'].includes(row.state) || !['draft','accepted','final'].includes(row.version_state))) {
    blocked = '章节含候选、归档或已驳回的当前版本，请先在编辑台核对。'
  }
  try { parse(current, rows) } catch (error) { blocked = error.message }
  let action = null
  if (!blocked) {
    if (state === 'missing') action = 'create'
    if (state === 'database-changed') action = 'refresh'
    if (['untracked','conflict','database-changed'].includes(state) && current === source) action = 'track'
    if (state === 'file-edited' && !problem) action = 'import'
  }
  const resolutions = state === 'conflict' && !action && !blocked
    ? (problem ? ['keep-database'] : ['keep-file','keep-database']) : []
  const pending = pendingImport(book,chapter)
  if (pending) {
    const recovery = recoveryIntent(book.db,pending.entry,rows,data,fileHash,parts)
    state = recovery
    action = blocked || (recovery === 'recover-import' && problem) ? null : recovery
    resolutions.length = 0
  }
  const token = digest([book.project.project_id,chapter,file,heads,hash(current),fileHash,data,legacy,pending?.fingerprint])
  const view = { path, state, action, resolutions, token, changes:state === 'recover-committed' ? [] : changes, problem:blocked || (['database-changed','recover-committed'].includes(state) ? undefined : problem), ...(problem || ['missing','untracked','conflict','database-changed'].includes(state) ? { databaseText:current, fileText:source } : {}) }
  return { view, rows, current, file, fileHash, legacy, pending }
}

function publishMirror(book, chapter, inspection, intent) {
  const {view,file,current} = inspection
  if (intent === 'create') createFile(chapterPath(book.root,['manuscript','chapters'],file,true),current)
  if (intent === 'refresh' || intent === 'keep-database') return refreshFile(book.root,chapter,view.path,view.fileText,current)
}

function saveBaseline(db, chapter, rows, fileHash, legacy) {
  db.exec('CREATE TABLE IF NOT EXISTS lg_chapter_files(chapter INTEGER PRIMARY KEY, baseline TEXT NOT NULL, legacy TEXT)')
  const saved = {documents:snapshot(rows),file_hash:fileHash}
  db.prepare('INSERT OR REPLACE INTO lg_chapter_files VALUES(?,?,?)').run(chapter,JSON.stringify(saved),legacy)
}

/** Complete only an already committed author save. A replay can never republish an older version. */
export function retryChapterMirror(directory, chapter, operation) {
  identity(chapter)
  const book = openBook(directory,{write:true}), db = book.db
  try {
    const saved = mirrorReceipt(db,chapter,operation)
    if (saved.sync !== 'mirror-pending') return saved
    if (!currentMirrorSource(db,saved)) {
      saved.sync = 'superseded'
    } else {
      const inspection = inspect(book,chapter), {view,rows,current,legacy} = inspection
      saved.mirrorPath = view.path
      if (view.state === 'clean') saved.sync = 'synchronized'
      else if (view.action === 'create' || view.action === 'refresh' || (view.state !== 'untracked' && view.action === 'track')) {
        const backup = publishMirror(book,chapter,inspection,view.action)
        if (backup) saved.backup = backup
        saveBaseline(db,chapter,rows,hash(current),legacy)
        saved.sync = 'synchronized'
      } else {
        saved.sync = 'mirror-review'
        saved.mirrorState = view.state
      }
    }
    db.prepare('UPDATE lg_plugin_operations SET result=? WHERE id=?').run(JSON.stringify(saved),operation)
    book.verify(); db.exec('COMMIT')
    return saved
  } finally { book.close() }
}

export function chapterFile(directory, input) {
  const chapter = identity(input.document), write = input.action === 'chapter-file-apply'
  const book = openBook(directory, { write })
  try {
    if (!write) {
      const { view } = inspect(book, chapter)
      if (hasTable(book.db,'lg_plugin_operations')) {
        view.pendingOperation = book.db.prepare(`SELECT id FROM lg_plugin_operations WHERE json_extract(result,'$.sync')='mirror-pending'
          AND json_extract(result,'$.chapter')=? ORDER BY rowid DESC LIMIT 1`).get(chapter)?.id
      }
      book.verify()
      return view
    }
    if (typeof input.operation !== 'string' || !/^[\w-]{16,80}$/u.test(input.operation)) throw new Error('操作收据标识无效。')
    const db = book.db, signature = digest([chapter,input.intent,input.token])
    db.exec('CREATE TABLE IF NOT EXISTS lg_chapter_file_receipts(id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL)')
    const old = db.prepare('SELECT * FROM lg_chapter_file_receipts WHERE id=?').get(input.operation)
    if (old) {
      if (old.signature !== signature) throw new Error('操作编号已用于另一份预览。')
      return JSON.parse(old.result)
    }
    const inspection = inspect(book,chapter)
    const { view, rows, current, fileHash, legacy, pending } = inspection
    const intent = input.intent
    if (!intent || (view.action !== intent && !view.resolutions.includes(intent)) || view.token !== input.token) throw new Error('作品或外部文件已变化，请重新比较。')
    const versions = []
    const overwrite = intent === 'refresh' || intent === 'keep-database'
    const backup = publishMirror(book,chapter,inspection,intent)
    for (const change of ['import','keep-file','recover-import'].includes(intent) ? view.changes : []) {
      const row = rows.find(row => row.id === change.document)
      const metadata = { origin:pending?.entry.origin ?? 'chapter-file:' + input.operation, previous_version_id:row.version, source_file_hash:fileHash }
      row.version = Number(db.prepare(`INSERT INTO document_versions(document_id,version_number,state,content,reason,metadata_json,created_at)
        SELECT ?,COALESCE(MAX(version_number),0)+1,?,?,?, ?,? FROM document_versions WHERE document_id=?`)
        .run(row.id,row.state,change.after,'作者确认导入章节文件',JSON.stringify(metadata),new Date().toISOString(),row.id).lastInsertRowid)
      activate(db,row,row.version,row.state,{ updateSceneStatus:false })
      versions.push({ document:row.id, version:row.version })
    }
    if (intent === 'recover-committed') {
      for (const id of pending.entry.changed) {
        const row = rows.find(row => row.id === id)
        refreshSearch(db,row,row.version)
      }
    }
    if (pending) recordRecovery(db,pending)
    saveBaseline(db,chapter,rows,pending?.entry.file_hash ?? (overwrite ? hash(current) : fileHash ?? hash(current)),legacy)
    const result = { action:intent, versions, path:view.path, ...(backup ? { backup } : {}) }
    db.prepare('INSERT INTO lg_chapter_file_receipts VALUES(?,?,?)').run(input.operation,signature,JSON.stringify(result))
    book.verify(); db.exec('COMMIT')
    return result
  } finally { book.close() }
}
