import { chapterPath, hash, readText } from './chapter-file-format.js'

const fingerprintPattern = /^[a-f0-9]{64}$/u
const isHash = value => typeof value === 'string' && fingerprintPattern.test(value)
const invalid = () => new Error('旧版待恢复日志与作品、章节或版本记录不符，请核对原始记录。')

export function pendingImport(book, chapter) {
  const path = chapterPath(book.root, ['.literarygiant','chapter-sync'], chapter + '.import.json')
  const raw = readText(path, 2_000_000)
  if (raw === null) return null
  const entry = JSON.parse(raw)
  if (entry?.schema !== 1 || entry.project_id !== book.project.project_id || entry.chapter_id !== chapter) throw invalid()
  if (entry.state === 'complete') return null
  if (entry.state !== 'pending' || !/^chapter-file:[a-f0-9]{32}$/u.test(entry.origin) ||
      !isHash(entry.file_hash) || !Array.isArray(entry.before) ||
      !Array.isArray(entry.changed) || !entry.contents || typeof entry.contents !== 'object' || Array.isArray(entry.contents)) throw invalid()

  const fingerprint = hash(raw)
  if (book.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_chapter_recoveries'").get()) {
    const saved = book.db.prepare('SELECT fingerprint FROM lg_chapter_recoveries WHERE origin=?').get(entry.origin)
    if (saved && saved.fingerprint !== fingerprint) throw invalid()
    if (saved) return null
  }
  return { entry, fingerprint }
}

export function recoveryIntent(db, entry, rows, baseline, fileHash, parts) {
  const changed = new Set(entry.changed)
  if (!baseline || entry.before.length !== rows.length || Object.keys(entry.contents).length !== rows.length ||
      changed.size !== entry.changed.length || entry.changed.some(id => !Number.isSafeInteger(id))) throw invalid()
  const beforeMatches = (before, head) => before?.id === head.id && before.title === head.title &&
    before.state === head.state && before.sequence === head.sequence
  const historical = db.prepare('SELECT content FROM document_versions WHERE id=? AND document_id=?')
  const metadata = db.prepare('SELECT metadata_json FROM document_versions WHERE id=? AND document_id=?')
  let allBefore = true, allCommitted = true, changedCount = 0
  for (const [index,row] of rows.entries()) {
    const before = entry.before[index], expected = entry.contents[row.id]
    if (!beforeMatches(before,row) || !Number.isSafeInteger(before.version) || before.version < 1 ||
        !isHash(expected)) throw invalid()
    const sameHead = before.version === row.version
    const previous = sameHead ? row.content : historical.get(before.version,row.id)?.content
    if (typeof previous !== 'string' || (hash(previous) !== expected) !== changed.has(row.id)) throw invalid()
    if (changed.has(row.id)) changedCount++
    allBefore &&= sameHead
    let committed = hash(row.content) === expected
    if (changed.has(row.id) && !sameHead) {
      const info = JSON.parse(metadata.get(row.version,row.id).metadata_json)
      committed &&= info?.origin === entry.origin && info.previous_version_id === before.version && row.version_state === row.state
    } else committed &&= sameHead && !changed.has(row.id)
    allCommitted &&= committed
  }
  if (changedCount !== changed.size) throw invalid()
  const matchesBaseline = versions => baseline.documents.length === rows.length &&
    baseline.documents.every((head,i) => beforeMatches(versions[i],head) && head.version === versions[i].version)
  if (!(matchesBaseline(entry.before) || (allCommitted && matchesBaseline(rows) && baseline.file_hash === entry.file_hash))) throw invalid()
  const sameFile = fileHash === entry.file_hash
  if (sameFile && (!parts || parts.some((part,i) => hash(part) !== entry.contents[rows[i].id]))) throw invalid()
  if (allCommitted) return 'recover-committed'
  if (allBefore && sameFile) {
    // A later restoration can point the book back to the original heads.
    const earlierCommit = db.prepare(`SELECT 1 FROM document_versions WHERE document_id=?
      AND (CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.origin') END)=? LIMIT 1`)
    for (const id of changed) if (earlierCommit.get(id,entry.origin)) throw invalid()
    return 'recover-import'
  }
  throw new Error('中断后文件或作品版本已变化，无法证明原导入可以继续。请核对文件和版本历史。')
}

export function recordRecovery(db, pending) {
  db.exec('CREATE TABLE IF NOT EXISTS lg_chapter_recoveries(origin TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)')
  db.prepare('INSERT INTO lg_chapter_recoveries VALUES(?,?)').run(pending.entry.origin,pending.fingerprint)
}
