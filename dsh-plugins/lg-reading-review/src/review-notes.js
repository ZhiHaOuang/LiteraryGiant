// Coordinates use JavaScript string offsets in the immutable source version.
export function reviewNotes(books, input) {
  const { path, document, version, action } = input
  if (![document, version].every(id => Number.isSafeInteger(id) && id > 0)) throw Error('Choose a chapter and version.')
  if (!['list', 'create', 'update'].includes(action)) throw Error('Unknown note action.')
  const read = action === 'list'
  return books[read ? 'readState' : 'changeState'](path, db => {
    const source = db.prepare(`SELECT v.content FROM document_versions v JOIN documents d ON d.id=v.document_id
      WHERE d.id=? AND v.id=? AND d.kind IN ('chapter','scene')`).get(document, version)
    if (!source) throw Error('Manuscript version not found.')
    if (read && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_reading_notes'").get()) return []
    if (!read) {
      db.exec(`CREATE TABLE IF NOT EXISTS lg_reading_notes (
        id TEXT PRIMARY KEY, document_id INTEGER NOT NULL, version_id INTEGER NOT NULL,
        start INTEGER NOT NULL, end INTEGER NOT NULL, quote TEXT NOT NULL, note TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);
        CREATE INDEX IF NOT EXISTS lg_reading_notes_scope ON lg_reading_notes(document_id,version_id)`)
      const { id, note } = input
      if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid note ID.')
      if (typeof note !== 'string' || !note.trim() || note.length > 4000) throw Error('Enter a note of 1 to 4,000 characters.')
      const existing = db.prepare('SELECT * FROM lg_reading_notes WHERE id=?').get(id)
      const sameVersion = existing?.document_id === document && existing?.version_id === version
      if (action === 'create') {
        const { start, end, quote } = input
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
            end > source.content.length || end - start > 4000 || (start === end && start !== 0) ||
            source.content.slice(start, end) !== quote) throw Error('The passage does not match this version. Select it again (up to 4,000 characters).')
        if (!existing) db.prepare(`INSERT INTO lg_reading_notes(id,document_id,version_id,start,end,quote,note)
          VALUES(?,?,?,?,?,?,?)`).run(id,document,version,start,end,quote,note.trim())
        else if (!sameVersion || existing.start !== start || existing.end !== end || existing.note !== note.trim())
          throw Error('This note ID is already in use. Reload notes.')
      } else {
        if (!sameVersion || typeof input.resolved !== 'boolean' || !Number.isSafeInteger(input.revision)) throw Error('Invalid note record.')
        if (existing.revision === input.revision) db.prepare(`UPDATE lg_reading_notes SET note=?,resolved=?,revision=revision+1 WHERE id=?`)
          .run(note.trim(), Number(input.resolved), id)
        else if (existing.note !== note.trim() || existing.resolved !== Number(input.resolved))
          throw Error('This note was changed in another window. Keep your draft and reload before trying again.')
      }
    }
    return db.prepare(`SELECT id,start,end,quote,note,resolved,revision FROM lg_reading_notes
      WHERE document_id=? AND version_id=? ORDER BY rowid DESC`).all(document,version)
  })
}
