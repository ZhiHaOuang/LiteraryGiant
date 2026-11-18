import { extractionService } from './extraction.js'
import { proposalEvidence } from './evidence.js'
import { realpathSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { decorated, hash, integer, row, now, text, choice, tags, factStates } from './common.js'
import { planFact, applyFact } from './facts.js'
import { planChronology, applyChronology } from './chronology.js'
import { planKnowledge, applyKnowledge, knowledge } from './knowledge.js'
import { knowledgeView } from './view.js'

const sections = { facts: ['story_facts', 'category,fact_key,id'], proposals: ['fact_proposals', 'id DESC'],
  timeline: ['timeline_entries', 'sort_key,id'], foreshadowing: ['foreshadowing', 'id'], knowledge: ['documents', 'id'] }
function plan(db, change) {
  if (!change || typeof change !== 'object' || typeof change.action !== 'string' || JSON.stringify(change).length > 80000) throw new Error('记忆变更格式或大小无效。')
  if (/^(fact|proposal)\./u.test(change.action)) return planFact(db, change)
  if (/^(timeline|foreshadow)\./u.test(change.action)) return planChronology(db, change)
  if (change.action.startsWith('knowledge.')) return planKnowledge(db, change)
  throw new Error('未知记忆操作。')
}
function commit(db, prepared) {
  if (/^(fact|proposal)\./u.test(prepared.action)) return applyFact(db, prepared)
  if (prepared.action.startsWith('knowledge.')) return applyKnowledge(db, prepared)
  return applyChronology(db, prepared)
}
function receipt(db, operation, signature, write) {
  if (typeof operation !== 'string' || !/^[\w-]{16,80}$/u.test(operation)) throw new Error('操作收据标识无效。')
  db.exec('CREATE TABLE IF NOT EXISTS lg_memory_operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL)')
  const previous = db.prepare('SELECT * FROM lg_memory_operations WHERE id=?').get(operation)
  if (previous) {
    if (previous.signature !== signature) throw new Error('重复操作的内容发生变化。')
    return JSON.parse(previous.result)
  }
  const result = write()
  db.prepare('INSERT INTO lg_memory_operations VALUES (?,?,?,?)').run(operation, signature, JSON.stringify(result), now())
  return result
}
export function createMemory(books) {
  if (!books.readState || !books.changeState) throw new Error('请更新 lg-books 以提供作品事务接口。')
  const preview = (path, change) => books.readState(path, db => {
    const value = plan(db, change)
    return { token: hash({ path, value }), value }
  })
  return {
    ...extractionService(books, receipt),
    preview,
    apply(path, change, token, operation) {
      return books.changeState(path, db => receipt(db, operation, hash({ change, token }), () => {
        const value = plan(db, change)
        if (typeof token !== 'string' || token !== hash({ path, value })) throw new Error('预览、记录或来源已变化，请重新预览。')
        return commit(db, value)
      }))
    },
    propose(path, change, operation) {
      if (!['fact.propose', 'knowledge.propose'].includes(change?.action)) throw new Error('模型只能保存事实或叙事认知提案。')
      return books.changeState(path, db => receipt(db, operation, hash({ modelProposal: change }), () => commit(db, plan(db, change))))
    },
    list(path, section, options = {}) {
      if (!Object.hasOwn(sections, section)) throw new Error('未知记忆分类。')
      const [table, order] = sections[section], offset = integer(options.offset ?? 0, 0, 1000000), limit = integer(options.limit ?? 30, 1, 100)
      return books.readState(path, db => {
        const clauses = section === 'knowledge' ? ["kind='narrative_knowledge'"] : [], params = []
        if (section === 'proposals') {
          const status = options.status ?? 'proposed'
          if (status) { clauses.push('status=?'); params.push(choice(status, ['proposed', 'accepted', 'rejected'])) }
        } else if (options.state && section !== 'knowledge') {
          clauses.push('state=?'); params.push(choice(options.state, section === 'foreshadowing' ? ['open', 'planned', 'paid', 'abandoned'] : factStates))
        }
        if (options.category && ['facts', 'proposals'].includes(section)) { clauses.push('category=?'); params.push(text(options.category, '分类', 128)) }
        if (options.query) {
          const columns = { facts: 'category||fact_key||value', proposals: 'category||fact_key||value', timeline: 'label||event', foreshadowing: 'title||setup_note||payoff_note', knowledge: 'title||slug' }
          clauses.push(`instr(lower(${columns[section]}),lower(?))>0`); params.push(text(options.query, '检索词', 500))
        }
        if (section !== 'knowledge') for (const tag of tags(options.tags)) {
          clauses.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END) WHERE value=?)"); params.push(tag)
        }
        const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
        const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get(...params).n
        const rows = db.prepare(`SELECT * FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset)
        const items = []; let size = 0
        for (const value of rows) {
          let item
          try { item = section === 'knowledge' ? knowledge(db, value.id) : decorated(db, value); if (section === 'proposals') item.extraction = proposalEvidence(db, value) }
          catch { item = { id: value.id, error: '记录格式或来源身份无效，请复核旧数据。' } }
          size += JSON.stringify(item).length
          if (size > 200000) { if (!items.length) items.push({ id: value.id, error: '此记录超过面板读取上限。' }); break }
          items.push(item)
        }
        return { section, items, offset, total, nextOffset: offset + items.length < total ? offset + items.length : null,
          truncated: items.length < rows.length }
      })
    },
    history(path, id, options = {}) { return books.readState(path, db => { row(db, 'story_facts', id); return db.prepare('SELECT * FROM fact_history WHERE fact_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(id, integer(options.limit ?? 100, 1, 1000), integer(options.offset ?? 0, 0, 1000000)) }) },
    record(path, section, id) {
      if (!Object.hasOwn(sections, section)) throw new Error('未知记忆分类。')
      return books.readState(path, db => {
        if (section === 'knowledge') return knowledge(db, id)
        const value = row(db, sections[section][0], id)
        return { ...decorated(db, value), ...(section === 'proposals' ? { extraction: proposalEvidence(db, value) } : {}) }
      })
    },
    documents(path) { return books.readState(path, db => db.prepare(`SELECT id,title,kind,state,active_version_id FROM documents WHERE kind!='narrative_knowledge' AND state NOT IN ('archived','rejected') ORDER BY id LIMIT 1000`).all()) },
    view(path, input) { return books.readState(path, db => knowledgeView(db, input)) },
    world(path, limit = 30) {
      integer(limit, 1, 100)
      return books.readState(path, db => {
        const result = []; let considered = 0, size = 0
        for (const value of db.prepare("SELECT * FROM story_facts WHERE state='canonical' ORDER BY category,fact_key,id LIMIT 1001").iterate()) {
          considered++; if (considered > 1000) break
          const item = decorated(db, value)
          if (!['current', 'unbound'].includes(item.source.status)) continue
          size += JSON.stringify(item).length
          if (result.length >= limit || size > 40000) break
          result.push(item)
        }
        return { audience: 'world', facts: result, truncated: considered > result.length || size > 40000,
          note: '作者确认的世界事实；不代表任何人物或读者已经知道。来源过期的事实不在本次结果中。' }
      })
    },
    forDirectory(path) {
      const cwd = realpathSync(path), booksInScope = books.list().filter(book => {
        if (book.error) return false
        const rel = relative(realpathSync(book.path), cwd)
        return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep)
      }).sort((a, b) => b.path.length - a.path.length)
      if (!booksInScope.length) throw new Error('请将会话工作目录设为已登记作品。')
      return booksInScope[0].path
    },
  }
}
