import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { catalog, search, readCitation } from './search.js'
import { createCards } from './cards.js'

export function createLibrary(books, config) {
  const registered = path => {
    const book = books.list().find(book => !book.error && book.path === path)
    if (!book) throw new Error('请先在控制台添加此作品。')
    return book.path
  }
  const read = (path, citation) => readCitation(registered(path), citation, config)
  const cards = books.readState && books.changeState ? createCards(books, read) : null
  return {
    ...cards,
    catalog(path) { return catalog(registered(path), config) },
    async search(path, input, signal) {
      const result = await search(registered(path), input, config, signal)
      if (!cards) return result
      signal?.throwIfAborted()
      const curated = cards.searchCards(path, input), rank = { abstract: 0, curated: 1, custom: 2, bridge: 3 }
      return { ...result, hits: [...result.hits, ...curated.hits].sort((a, b) => rank[a.tier] - rank[b.tier] || b.score - a.score).slice(0, input.limit ?? 5),
        stats: { ...result.stats, cards: curated.examined, truncated: result.stats.truncated || curated.truncated } }
    },
    read(path, citation) {
      registered(path)
      return typeof citation === 'string' && citation.startsWith('lgc.') && cards ? cards.cardReference(path, citation) : read(path, citation)
    },
    forDirectory(path) {
      const cwd = realpathSync(path)
      const matches = books.list().filter(book => {
        if (book.error) return false
        const rel = relative(realpathSync(book.path), cwd)
        return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep)
      }).sort((a, b) => b.path.length - a.path.length)
      if (!matches.length) throw new Error('请把会话工作目录设为已登记作品目录。')
      return matches[0].path
    },
  }
}
