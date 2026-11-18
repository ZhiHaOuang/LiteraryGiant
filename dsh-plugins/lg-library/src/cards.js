import { randomUUID } from 'node:crypto'
import { contract, categories, hash, analysisSnapshot, validateAnalysis, finalizeCard } from './contracts.js'
import { flatten, terms } from './text.js'

const exists = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_library_cards'").get()
const idCheck = id => { if (typeof id !== 'string' || !/^[\w-]{16,80}$/u.test(id)) throw new Error('分析卡标识无效。'); return id }
const stamp = () => new Date().toISOString()
export function createCards(books, read) {
  const verify = (path, snapshot) => {
    if (contract(snapshot.category).fingerprint !== snapshot.contract) throw new Error('分析方法已变化，请重新分析。')
    for (const source of snapshot.sources) if (read(path, source.citation).sha256 !== source.sha256) throw new Error('分析来源已变化。')
  }
  const decorate = (path, row) => {
    if (!row) throw new Error('分析卡不存在。')
    const snapshot = JSON.parse(row.sources), analysis = JSON.parse(row.analysis)
    let stale = false; try { verify(path, snapshot) } catch { stale = true }
    return { id: row.id, category: row.category, status: row.status, analysis, sources: snapshot.sources,
      stale, created_at: row.created_at, updated_at: row.updated_at, token: hash({ row, stale }), history: JSON.parse(row.history) }
  }
  const row = (db, id) => exists(db) ? db.prepare('SELECT * FROM lg_library_cards WHERE id=?').get(idCheck(id)) : null
  const referenceToken = (path, value) => 'lgc.' + Buffer.from(JSON.stringify({ book: hash(path), id: value.id, token: value.token })).toString('base64url')
  const preview = (path, value, change) => {
      const allowed = { proposed: ['approve', 'reject'], approved: ['withdraw'], rejected: [], withdrawn: [] }
      if (!allowed[value.status]?.includes(change.action)) throw new Error('此分析卡不能执行该操作。')
      if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 2000) throw new Error('请填写审阅理由（最多2000字）。')
      if (change.action === 'approve' && (value.stale || !value.analysis.instance_card.portable_core.some(s => s.trim()))) throw new Error('来源过期或缺少可迁移方法，不能批准使用。')
      return { value, change, token: hash({ path, value: value.token, change }) }
  }
  return {
    finalizeChapterCard:(category,card,evidence)=>finalizeCard(category,card,evidence,true),
    contracts: () => categories.map(contract),
    analysisSnapshot: (path, input) => analysisSnapshot(path, input, read),
    validateAnalysis,
    analysisReplay(path, operation, request, signature) {
      return books.readState(path, db => {
        const previous = row(db, operation)
        if (!previous) return null
        if (previous.request !== request || previous.signature !== signature) throw new Error('重复分析的输入已经变化。')
        return decorate(path, previous)
      })
    },
    saveAnalysis(path, operation, request, signature, snapshot, raw) {
      idCheck(operation)
      return books.changeState(path, db => {
        const previous = row(db, operation)
        if (previous) {
          if (previous.request !== request || previous.signature !== signature) throw new Error('重复分析的输入已经变化。')
          return decorate(path, previous)
        }
        verify(path, snapshot)
        const analysis = validateAnalysis(raw, snapshot)
        db.exec(`CREATE TABLE IF NOT EXISTS lg_library_cards (id TEXT PRIMARY KEY, category TEXT NOT NULL, status TEXT NOT NULL, analysis TEXT NOT NULL,
          sources TEXT NOT NULL, request TEXT NOT NULL, signature TEXT NOT NULL, history TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
        db.prepare("INSERT INTO lg_library_cards VALUES (?,?,'proposed',?,?,?,?,?,?,?)").run(operation, snapshot.category, JSON.stringify(analysis), JSON.stringify(snapshot), request, signature, '[]', stamp(), stamp())
        return decorate(path, row(db, operation))
      })
    },
    card(path, id) { return books.readState(path, db => decorate(path, row(db, id))) },
    cards(path, input = {}) {
      const offset = input.offset ?? 0, limit = input.limit ?? 20
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('分析卡分页无效。')
      if (input.status && !['proposed', 'approved', 'rejected', 'withdrawn'].includes(input.status)) throw new Error('分析卡状态无效。')
      return books.readState(path, db => {
        if (!exists(db)) return { items: [], total: 0, offset, nextOffset: null }
        const where = input.status ? ' WHERE status=?' : '', args = input.status ? [input.status] : []
        const total = db.prepare('SELECT count(*) AS n FROM lg_library_cards' + where).get(...args).n
        const items = db.prepare('SELECT * FROM lg_library_cards' + where + ' ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(...args, limit, offset).map(row => decorate(path, row))
        return { items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null }
      })
    },
    cardPreview(path, change) {
      return preview(path, this.card(path, change?.id), change)
    },
    cardApply(path, change, token, operation) {
      idCheck(operation)
      return books.changeState(path, db => {
        db.exec('CREATE TABLE IF NOT EXISTS lg_library_actions (id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL)')
        const signature = hash({ change, token }), previous = db.prepare('SELECT * FROM lg_library_actions WHERE id=?').get(operation)
        if (previous) { if (previous.signature !== signature) throw new Error('重复操作内容已变化。'); return JSON.parse(previous.result) }
        // The write transaction serializes card state; reference files are rechecked before the commit.
        const value = decorate(path, row(db, change?.id)), prepared = preview(path, value, change)
        if (prepared.value.token !== value.token || token !== prepared.token) throw new Error('分析卡或来源已变化，请重新预览。')
        const state = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn' }[change.action]
        const history = [...value.history, { id: randomUUID(), from: value.status, to: state, reason: change.reason.trim(), at: stamp() }]
        db.prepare('UPDATE lg_library_cards SET status=?,history=?,updated_at=? WHERE id=?').run(state, JSON.stringify(history), stamp(), value.id)
        const result = decorate(path, row(db, value.id));db.prepare('INSERT INTO lg_library_actions VALUES (?,?,?)').run(operation, signature, JSON.stringify(result));return result
      })
    },
    cardReference(path, token) {
      if (typeof token !== 'string' || token.length > 2048 || !/^lgc\.[\w-]+$/u.test(token)) throw new Error('分析卡引用无效。')
      let ref; try { ref = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString()) } catch { throw new Error('分析卡引用无效。') }
      if (ref.book !== hash(path)) throw new Error('分析卡引用不属于此作品。')
      const value = this.card(path, ref.id)
      if (value.status !== 'approved' || value.stale || ref.token !== value.token) throw new Error('分析卡未批准、已撤回或来源已变化。')
      const text = flatten({ title: value.analysis.title, portable_core: value.analysis.instance_card.portable_core, fusion_hooks: value.analysis.instance_card.fusion_hooks })
      return { citation: token, id: value.analysis.title, tier: 'curated', file: `analysis:${value.id}`, sha256: hash(value), excerpt: text.slice(0, 900), text }
    },
    searchCards(path, input) {
      const query = terms(input.query)
      return books.readState(path, db => {
        if (!exists(db)) return { hits: [], examined: 0, truncated: false }
        const rows = db.prepare("SELECT * FROM lg_library_cards WHERE status='approved' ORDER BY created_at DESC,id LIMIT 101").all(), hits = []
        for (const item of rows.slice(0, 100)) {
          const value = decorate(path, item)
          if (value.stale) continue
          const text = flatten({ title: value.analysis.title, portable_core: value.analysis.instance_card.portable_core, fusion_hooks: value.analysis.instance_card.fusion_hooks })
          const matched = query.filter(term => text.toLowerCase().includes(term))
          if (matched.length) hits.push({ tier: 'curated', id: value.analysis.title, file: `analysis:${value.id}`, position: 0, excerpt: text.slice(0, 900), matched,
            score: matched.length, sha256: hash(value), citation: referenceToken(path, value) })
        }
        return { hits: hits.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 5), examined: Math.min(rows.length, 100), truncated: rows.length > 100 }
      })
    },
  }
}
