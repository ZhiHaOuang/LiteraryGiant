import { verifyProposalEvidence, proposalEvidence } from './evidence.js'
import { text, tags, row, choice, source, decorated, factStates, now } from './common.js'

export function planFact(db, input) {
  const action = input.action
  if (['fact.add', 'fact.set', 'fact.propose'].includes(action)) {
    const state = action === 'fact.propose' ? 'idea' : choice(input.state ?? 'idea', factStates)
    const fields = { category: text(input.category, '分类', 128), fact_key: text(input.key, '事实键', 200), value: text(input.value, '事实内容'),
      state, tags: tags(input.tags), rationale: text(input.rationale, '依据', 4000), ...source(db, input, state === 'canonical') }
    const before = action === 'fact.set' ? db.prepare(`SELECT * FROM story_facts WHERE category=? AND fact_key=? AND state=? ORDER BY updated_at DESC,id DESC LIMIT 1`).get(fields.category, fields.fact_key, state) ?? null : null
    return { action, before: decorated(db, before), after: fields }
  }
  if (['fact.promote', 'fact.archive'].includes(action)) {
    const before = row(db, 'story_facts', input.id), state = action === 'fact.promote' ? 'canonical' : 'archived'
    if (before.state === state) throw new Error('记录已经处于目标状态。')
    return { action, before: decorated(db, before), after: { state, rationale: text(input.rationale, '操作原因', 4000), ...(state === 'canonical' ? source(db, before, true) : {}) } }
  }
  if (['proposal.accept', 'proposal.reject'].includes(action)) {
    const before = row(db, 'fact_proposals', input.id)
    if (before.status !== 'proposed') throw new Error('提案已经处理，请刷新。')
    if (action === 'proposal.accept') verifyProposalEvidence(db, before)
    const state = choice(input.state ?? 'canonical', factStates)
    const sources = action === 'proposal.accept' ? source(db, before, state === 'canonical') : {}
    const replacement = action === 'proposal.accept' ? db.prepare(`SELECT * FROM story_facts WHERE category=? AND fact_key=? AND state=? ORDER BY updated_at DESC,id DESC LIMIT 1`).get(before.category, before.fact_key, state) ?? null : null
    return { action, before: { ...decorated(db, before), extraction: proposalEvidence(db, before) }, replacement: decorated(db, replacement), after: {
      ...(action === 'proposal.accept' ? { state, status: 'accepted' } : { status: 'rejected' }),
      rationale: `${action === 'proposal.accept' ? 'Accepted' : 'Rejected'} proposal ${before.id}: ${text(input.rationale, '处理理由', 4000)}`, ...sources } }
  }
  throw new Error('未知事实操作。')
}
function saveFact(db, fields, existing) {
  const stamp = now(), args = [fields.value, JSON.stringify(fields.tags), fields.source_document_id, fields.source_version_id, fields.rationale, stamp]
  let id = existing?.id
  if (existing) db.prepare('UPDATE story_facts SET value=?,tags_json=?,source_document_id=?,source_version_id=?,rationale=?,updated_at=? WHERE id=?').run(...args, id)
  else id = Number(db.prepare(`INSERT INTO story_facts(category,fact_key,state,value,tags_json,source_document_id,source_version_id,rationale,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(fields.category, fields.fact_key, fields.state, ...args, stamp).lastInsertRowid)
  db.prepare('INSERT INTO fact_history(fact_id,action,old_value,new_value,rationale,created_at) VALUES (?,?,?,?,?,?)').run(id, existing ? 'updated' : 'created', existing?.value ?? null, fields.value, fields.rationale, stamp)
  return decorated(db, row(db, 'story_facts', id))
}
export function applyFact(db, plan) {
  const { action, before, after } = plan
  if (action === 'fact.propose') {
    const id = Number(db.prepare(`INSERT INTO fact_proposals(category,fact_key,value,tags_json,source_document_id,source_version_id,status,rationale,created_at) VALUES (?,?,?,?,?,?,'proposed',?,?)`).run(
      after.category, after.fact_key, after.value, JSON.stringify(after.tags), after.source_document_id, after.source_version_id, after.rationale, now()).lastInsertRowid)
    return decorated(db, row(db, 'fact_proposals', id))
  }
  if (['fact.add', 'fact.set'].includes(action)) return saveFact(db, after, before)
  if (['fact.promote', 'fact.archive'].includes(action)) {
    db.prepare('UPDATE story_facts SET state=?,updated_at=? WHERE id=?').run(after.state, now(), before.id)
    db.prepare('INSERT INTO fact_history(fact_id,action,old_value,new_value,rationale,created_at) VALUES (?,?,?,?,?,?)').run(before.id, 'state:' + after.state, before.value, before.value, after.rationale, now())
    return decorated(db, row(db, 'story_facts', before.id))
  }
  const result = action === 'proposal.accept' ? saveFact(db, { ...before, ...after }, plan.replacement) : null
  db.prepare('UPDATE fact_proposals SET status=?,resolved_at=? WHERE id=?').run(action === 'proposal.accept' ? 'accepted' : 'rejected', now(), before.id)
  return { proposal: decorated(db, row(db, 'fact_proposals', before.id)), fact: result }
}
