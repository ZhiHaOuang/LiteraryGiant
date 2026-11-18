import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createMemory } from '../src/service.js'

export function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-memory-'))); createBook(path).db.close()
  const read = callback => accessState(path, false, callback), write = callback => accessState(path, true, callback)
  const books = { list: () => [{ path }], readState: (_path, fn) => read(fn), changeState: (_path, fn) => write(fn) }
  const memory = createMemory(books), apply = change => memory.apply(path, change, memory.preview(path, change).token, randomUUID())
  return { path, books, read, write, memory, apply }
}
const fact = extra => ({ action: 'fact.propose', category: 'world', key: 'lighthouse', value: '灯塔由林澈看守。', rationale: '作者提供的设定。', ...extra })
export const cognition = extra => ({ action: 'knowledge.propose', slug: 'lin-letter', title: '林澈对来信的认识', expected_version_id: 0,
  topic: { audience: 'character', holder_document_id: 6, key: 'letter-origin', from_position: 10 },
  statement: { content: '林澈相信信来自未来。', stance: 'believes', until_position: 30, sources: [{ document_id: 1, version_id: 1 }] },
  rationale: '人物可以误信，这不是世界事实。', ...extra })
export const confirm = value => ({ action: 'knowledge.confirm', id: value.document_id, expected_version_id: value.version_id,
  proposal_version_number: value.proposal_version_number })

test('fact proposal, author acceptance, history and archive remain separate', () => {
  const s = setup(), proposed = s.memory.propose(s.path, fact(), randomUUID())
  assert.equal(s.memory.list(s.path, 'facts').total, 0)
  const accepted = s.apply({ action: 'proposal.accept', id: proposed.id, rationale: '核对后确认。' })
  assert.equal(accepted.fact.state, 'canonical'); assert.equal(accepted.proposal.status, 'accepted')
  const updated = s.apply(fact({ action: 'fact.set', state: 'canonical', value: '灯塔由林澈及其妹妹轮流看守。' }))
  assert.equal(updated.id, accepted.fact.id); assert.equal(s.memory.history(s.path, updated.id).length, 2)
  s.apply({ action: 'fact.archive', id: updated.id, rationale: '设定撤出当前方案。' })
  assert.equal(s.memory.world(s.path).facts.length, 0); assert.equal(s.memory.history(s.path, updated.id).length, 3)
})
test('pending and stale source cannot become canonical; stored author confirmation is not silently withdrawn', () => {
  const s = setup(), pending = s.apply(fact({ source_document_id: 4, source_version_id: 4 }))
  assert.throws(() => s.apply({ action: 'proposal.accept', id: pending.id, rationale: '确认' }), /pending/)
  const accepted = s.apply(fact({ action: 'fact.add', state: 'canonical', source_document_id: 1, source_version_id: 1 }))
  s.write(db => { db.prepare("UPDATE document_versions SET state='accepted' WHERE id=8").run(); db.prepare('UPDATE documents SET active_version_id=8 WHERE id=1').run() })
  const item = s.memory.list(s.path, 'facts').items.find(item => item.id === accepted.id)
  assert.equal(item.state, 'canonical'); assert.equal(item.source.status, 'stale'); assert.equal(s.memory.world(s.path).facts.length, 0)
  s.apply({ action: 'proposal.reject', id: pending.id, rationale: '来源未采用，拒绝。' })
})
test('preview locks current record and source; failed changes roll back; retries are idempotent', () => {
  const s = setup(), change = fact({ action: 'fact.add' }), preview = s.memory.preview(s.path, change), operation = randomUUID()
  const first = s.memory.apply(s.path, change, preview.token, operation)
  assert.deepEqual(s.memory.apply(s.path, change, preview.token, operation), first)
  assert.throws(() => s.memory.apply(s.path, { ...change, value: '不同内容' }, preview.token, operation), /重复/)
  const promote = { action: 'fact.promote', id: first.id, rationale: '确认设定' }, old = s.memory.preview(s.path, promote)
  s.apply(fact({ action: 'fact.set', value: '已变更的设定。' }))
  assert.throws(() => s.memory.apply(s.path, promote, old.token, randomUUID()), /预览/)
  assert.equal(s.memory.list(s.path, 'facts').items[0].state, 'idea')
  assert.throws(() => s.write(db => { db.exec("UPDATE story_facts SET state='canonical'"); throw new Error('rollback') }), /rollback/)
  assert.equal(s.memory.list(s.path, 'facts').items[0].state, 'idea')
  assert.throws(() => s.read(db => db.exec("UPDATE story_facts SET state='canonical'")), /readonly/)
})
test('model proposal entry cannot confirm facts or change chronology', () => {
  const s = setup()
  for (const action of ['fact.add', 'fact.promote', 'proposal.accept', 'knowledge.confirm', 'timeline.add', 'foreshadow.resolve']) {
    assert.throws(() => s.memory.propose(s.path, { action }, randomUUID()), /模型只能/)
  }
  s.memory.propose(s.path, fact({ state: 'canonical' }), randomUUID())
  assert.equal(s.memory.list(s.path, 'facts').total, 0)
})
test('timeline sort keys are explicit and foreshadowing payoff is a separate author decision', () => {
  const s = setup(), late = s.apply({ action: 'timeline.add', label: '夜晚', event: '来信抵达。', sort_key: '020' })
  s.apply({ action: 'timeline.add', label: '清晨', event: '船只离港。', sort_key: '010', source_document_id: 1 })
  assert.deepEqual(s.memory.list(s.path, 'timeline').items.map(item => item.label), ['清晨', '夜晚'])
  s.apply({ action: 'timeline.update', id: late.id, label: '午后', sort_key: '015' })
  const seed = s.apply({ action: 'foreshadow.add', title: '缺角的信封', setup_note: '信封右上角缺损。', setup_document_id: 1, state: 'planned' })
  const paid = s.apply({ action: 'foreshadow.resolve', id: seed.id, payoff_note: '缺角与灯塔抽屉中的残片吻合。', payoff_document_id: 3 })
  assert.equal(paid.state, 'paid'); assert.equal(paid.setup_document_id, 1)
  assert.throws(() => s.apply({ action: 'foreshadow.resolve', id: seed.id, payoff_note: '重复处理' }), /已经处理/)
})
test('confirmed character belief is not a world fact; edits retain prior confirmation until author confirms', () => {
  const s = setup(), proposed = s.apply(cognition()), confirmed = s.apply(confirm(proposed))
  assert.equal(confirmed.status, 'confirmed'); assert.equal(s.memory.list(s.path, 'facts').total, 0)
  const amended = s.apply(cognition({ expected_version_id: confirmed.version_id,
    statement: { ...cognition().statement, content: '林澈怀疑信由妹妹伪造。', stance: 'uncertain' } }))
  assert.equal(amended.confirmed.content, cognition().statement.content)
  const revised = s.apply(confirm(amended)); assert.match(revised.confirmed.content, /妹妹/)
  const withdrawn = s.apply({ action: 'knowledge.withdraw', id: revised.document_id, expected_version_id: revised.version_id })
  assert.equal(withdrawn.status, 'withdrawn')
  assert.equal(s.memory.view(s.path, { audience: 'character', holder_document_id: 6, position: 15 }).statements.length, 0)
})
test('cognition confirmation checks head, exact proposal, source and interval overlap', () => {
  const s = setup(), first = s.apply(cognition()), confirmed = s.apply(confirm(first))
  assert.throws(() => s.apply(confirm(first)), /版本已经变化/)
  assert.throws(() => s.apply({ ...confirm(confirmed), proposal_version_number: confirmed.version_number }), /实际提案/)
  const second = s.apply(cognition({ slug: 'lin-letter-later', title: '稍后的认识', topic: { ...cognition().topic, from_position: 20 } }))
  assert.throws(() => s.apply(confirm(second)), /区间重叠/)
  assert.throws(() => s.apply(cognition({ slug: 'duplicate' })), /主题已存在/)
  const pending = s.apply(cognition({ slug: 'other-topic', topic: { ...cognition().topic, key: 'pending' },
    statement: { ...cognition().statement, sources: [{ document_id: 4, version_id: 4 }] } }))
  assert.throws(() => s.apply(confirm(pending)), /当前已采用/)
})
test('character and reader views use separate axes, exclude future/unconfirmed/stale records, and do not disclose hidden text', () => {
  const s = setup(); s.apply(confirm(s.apply(cognition())))
  const reader = s.apply(cognition({ slug: 'reader-letter', title: '读者获知', topic: { audience: 'reader', holder_document_id: null, key: 'origin', from_position: 50 },
    statement: { content: 'READER SECRET', stance: 'knows', until_position: null, sources: [] } }))
  s.apply(confirm(reader))
  const characterView = s.memory.view(s.path, { audience: 'character', holder_document_id: 6, position: 15 })
  assert.equal(characterView.view.axis, 'story'); assert.equal(characterView.statements.length, 1)
  assert.doesNotMatch(JSON.stringify(characterView), /READER SECRET/)
  assert.equal(s.memory.view(s.path, { audience: 'reader', position: 49 }).statements.length, 0)
  assert.equal(s.memory.view(s.path, { audience: 'reader', position: 50 }).view.axis, 'reading')
  assert.equal(s.memory.view(s.path, { audience: 'character', holder_document_id: 6, position: 30 }).statements.length, 0)
  s.write(db => db.exec("UPDATE documents SET state='archived' WHERE id=1"))
  const stale = s.memory.view(s.path, { audience: 'character', holder_document_id: 6, position: 15 })
  assert.equal(stale.statements.length, 0); assert.equal(stale.withheld.length, 1)
  assert.doesNotMatch(JSON.stringify(stale), /信来自未来/)
  assert.equal(s.memory.list(s.path, 'knowledge').items[0].status, 'confirmed')
})
test('corrupt cognition identity is excluded without exposing its contents', () => {
  const s = setup(), value = s.apply(confirm(s.apply(cognition())))
  s.write(db => db.prepare('UPDATE documents SET sequence=0 WHERE id=?').run(value.document_id))
  const view = s.memory.view(s.path, { audience: 'character', holder_document_id: 6, position: 15 })
  assert.equal(view.invalid, 1); assert.equal(view.statements.length, 0); assert.doesNotMatch(JSON.stringify(view), /信来自未来/)
})
test('view excludes author rationale and pending revisions; author can confirm an exact historical proposal', () => {
  const s = setup(), first = s.apply(cognition({ rationale: 'AUTHOR_SECRET: 实际由妹妹寄出。' })), confirmed = s.apply(confirm(first))
  const amended = s.apply(cognition({ expected_version_id: confirmed.version_id,
    statement: { ...cognition().statement, content: 'PENDING_SECRET: 人物后来识破来信。' } }))
  const view = s.memory.view(s.path, { audience: 'character', holder_document_id: 6, position: 15 })
  assert.doesNotMatch(JSON.stringify(view), /AUTHOR_SECRET|PENDING_SECRET/)
  const secondConfirmation = s.apply(confirm(amended))
  const restored = s.apply({ ...confirm(secondConfirmation), proposal_version_number: first.proposal_version_number })
  assert.equal(restored.confirmed.content, first.proposal.content)
  assert.equal(restored.proposal.content, amended.proposal.content)
  assert.equal(restored.confirmed.proposal_version_id, first.proposal_version_id)
})
test('author filters, exact tags, proposal status and history paging remain available', () => {
  const s = setup(), a = s.apply(fact({ action: 'fact.add', state: 'canonical', tags: ['人物', '灯塔'] }))
  s.apply(fact({ action: 'fact.add', category: 'character', key: 'promise', value: '林澈守诺。', tags: ['人物设定'] }))
  assert.equal(s.memory.list(s.path, 'facts', { state: 'canonical', category: 'world', query: '守', tags: ['人物'] }).total, 1)
  assert.equal(s.memory.list(s.path, 'facts', { tags: ['人物'] }).items[0].id, a.id)
  assert.equal(s.memory.list(s.path, 'facts', { query: "' OR 1=1 --" }).total, 0)
  s.apply(fact({ action: 'fact.set', state: 'canonical', value: '守灯人换班。' }))
  assert.equal(s.memory.history(s.path, a.id, { offset: 1, limit: 1 })[0].action, 'created')
  const proposal = s.apply(fact()); s.apply({ action: 'proposal.reject', id: proposal.id, rationale: '拒绝' })
  assert.equal(s.memory.list(s.path, 'proposals').total, 0)
  assert.equal(s.memory.list(s.path, 'proposals', { status: 'rejected' }).total, 1)
})
