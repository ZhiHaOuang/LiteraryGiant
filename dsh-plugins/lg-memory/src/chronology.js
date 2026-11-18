import { text, tags, row, choice, linkedDocument, decorated, factStates, now } from './common.js'

export function planChronology(db, input) {
  const action = input.action, timeline = action.startsWith('timeline.')
  const before = ['timeline.update', 'foreshadow.resolve'].includes(action) ? row(db, timeline ? 'timeline_entries' : 'foreshadowing', input.id) : null
  if (['timeline.add', 'timeline.update'].includes(action)) {
    const value = { ...before, ...input }
    if (typeof (value.sort_key ?? '') !== 'string' || (value.sort_key ?? '').length > 128) throw new Error('时间排序键最多 128 字。')
    return { action, before: decorated(db, before), after: { label: text(value.label, '时间标签', 200), event: text(value.event, '事件'),
      sort_key: value.sort_key ?? '', state: choice(value.state ?? 'idea', factStates), tags: tags(input.tags ?? (before ? JSON.parse(before.tags_json) : [])),
      source_document_id: linkedDocument(db, value.source_document_id) } }
  }
  if (action === 'foreshadow.add') return { action, before: null, after: { title: text(input.title, '伏笔标题', 200), setup_note: text(input.setup_note, '埋设说明'),
    setup_document_id: linkedDocument(db, input.setup_document_id), state: choice(input.state ?? 'open', ['open', 'planned']), tags: tags(input.tags) } }
  if (action === 'foreshadow.resolve') {
    if (!['open', 'planned'].includes(before.state)) throw new Error('伏笔已经处理，请刷新。')
    return { action, before: decorated(db, before), after: { payoff_note: text(input.payoff_note, '回收或放弃说明'),
      payoff_document_id: linkedDocument(db, input.payoff_document_id), state: choice(input.state ?? 'paid', ['paid', 'abandoned']) } }
  }
  throw new Error('未知时间线或伏笔操作。')
}
export function applyChronology(db, { action, before, after: a }) {
  let id = before?.id
  if (action.startsWith('timeline.')) {
    const args = [a.label, a.sort_key, a.event, a.state, JSON.stringify(a.tags), a.source_document_id, now()]
    if (id) db.prepare('UPDATE timeline_entries SET label=?,sort_key=?,event=?,state=?,tags_json=?,source_document_id=?,updated_at=? WHERE id=?').run(...args, id)
    else id = Number(db.prepare('INSERT INTO timeline_entries(label,sort_key,event,state,tags_json,source_document_id,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(...args, now()).lastInsertRowid)
    return decorated(db, row(db, 'timeline_entries', id))
  }
  if (action === 'foreshadow.add') id = Number(db.prepare(`INSERT INTO foreshadowing(title,setup_note,setup_document_id,payoff_note,payoff_document_id,state,tags_json,created_at,updated_at) VALUES (?,?,?,'',NULL,?,?,?,?)`).run(a.title, a.setup_note, a.setup_document_id, a.state, JSON.stringify(a.tags), now(), now()).lastInsertRowid)
  else db.prepare('UPDATE foreshadowing SET payoff_note=?,payoff_document_id=?,state=?,updated_at=? WHERE id=?').run(a.payoff_note, a.payoff_document_id, a.state, now(), id)
  return decorated(db, row(db, 'foreshadowing', id))
}
