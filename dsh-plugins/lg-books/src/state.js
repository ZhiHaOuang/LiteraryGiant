import { openBook } from './read.js'

/** Trusted Cordis plugins share the registered book's one transaction boundary. */
export function accessState(path, write, callback) {
  const book = openBook(path, { write })
  try {
    const result = callback(book.db)
    if (result?.then) throw new Error('作品事务回调必须同步完成。')
    book.verify()
    if (write) book.db.exec('COMMIT')
    return result
  } finally { book.close() }
}
