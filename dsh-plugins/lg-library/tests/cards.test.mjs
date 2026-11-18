import test from 'node:test'
import failedModel from './fixtures/reference-model-invalid.json' with { type: 'json' }
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createLibrary } from '../src/service.js'
import { contract, categories, validateAnalysis, analysisSnapshot } from '../src/contracts.js'
import { createAgents } from '../../lg-agents/src/service.js'

function fill(template) {
  if (Array.isArray(template)) return template.length ? [fill(template[0])] : ['可迁移的信任冲突方法']
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, key === 'chunk_id' ? 'r1:1' : fill(value)]))
  if (typeof template === 'number') return 1
  if (['1-5', '-2 to 2', '0 to 2'].includes(template)) return 1
  return template.includes('/') ? template.split('/')[0] : '来源支持的分析'
}
const output = category => JSON.stringify({ title: '信任冲突方法', summary: '用行动重建信任。', evidence: ['r1:1'],
  instance_card: { ...fill(contract(category).template), source_locked_details: ['SECRET ORIGINAL NAME'], implementation_details: ['PRIVATE IMPLEMENTATION'] } })
async function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-cards-'))); createBook(path).db.close()
  mkdirSync(join(path, 'ReferenceLibrary'), { recursive: true })
  const file = join(path, 'ReferenceLibrary/ref.jsonl'), put = text => writeFileSync(file, JSON.stringify({ id: 'source', summary: text }) + '\n')
  put('信任冲突：林澈交出钥匙。对方才答应同行。')
  const books = { list: () => [{ path }], readState: (p, fn) => { assert.equal(p, path); return accessState(path, false, fn) },
    changeState: (p, fn) => { assert.equal(p, path); return accessState(path, true, fn) } }
  const library = createLibrary(books, {}), citation = (await library.search(path, { query: '信任冲突' })).hits[0].citation
  const input = { category: 'EventsLibrary', references: [citation] }, snapshot = library.analysisSnapshot(path, input)
  const save = (operation = randomUUID()) => library.saveAnalysis(path, operation, 'request', 'signature', snapshot, output(input.category))
  const apply = (id, action) => { const change = { id, action, reason: '作者已核对' };return library.cardApply(path, change, library.cardPreview(path, change).token, randomUUID()) }
  return { path, books, library, input, snapshot, save, apply, put }
}
test('all five category contracts validate strict structures, ranges and exact evidence', () => {
  assert.equal(categories.length, 5)
  for (const category of categories) {
    const snapshot = { category, units: [{ id: 'r1:1', source: 0, start: 3, end: 5, text: '原句' }] }
    const parsed = validateAnalysis(output(category), snapshot)
    assert.equal(parsed.evidence[0].quote, '原句'); assert.equal(parsed.evidence[0].start, 3)
    assert.equal(parsed.instance_card.card_quality.semantic_grounding, 'author_review_required')
    for (const change of [v => v.extra = true, v => v.instance_card.extra = '', v => v.evidence = ['r9:9'], v => v.instance_card.portable_core = [9]]) {
      const value = JSON.parse(output(category));change(value);assert.throws(() => validateAnalysis(JSON.stringify(value), snapshot))
    }
  }
  const emotion = JSON.parse(output('EmotionRhythm')); emotion.instance_card.emotion_beats[0].intensity = 6
  assert.throws(() => validateAnalysis(JSON.stringify(emotion), { category: 'EmotionRhythm', units: [] }))
  const world = JSON.parse(output('Worldview')); world.instance_card.rule_application.event_examples[0].chunk_id = 'missing'
  assert.throws(() => validateAnalysis(JSON.stringify(world), { category: 'Worldview', units: [{ id: 'r1:1' }] }), /示例/)
})
test('analysis snapshots bound original sources, preserve Unicode and cover every excerpt character', () => {
  const text = 'a'.repeat(3999) + '🏮。', source = { text, id: 'a', sha256: 'hash', file: 'file' }
  const snapshot = analysisSnapshot('book', { category: 'EventsLibrary', references: ['original'] }, () => source)
  assert.equal(snapshot.sources[0].text.length, 3999); assert.equal(snapshot.sources[0].truncated, true)
  assert.equal(snapshot.units.map(unit => unit.text).join(''), snapshot.sources[0].text)
  for (const unit of snapshot.units) assert.equal(snapshot.sources[unit.source].text.slice(unit.start, unit.end), unit.text)
  for (const references of [[], ['lgc.card'], ['a', 'a'], ['a', 'b', 'c', 'd']]) assert.throws(() => analysisSnapshot('book', { category: 'EventsLibrary', references }, () => source))
})
test('proposals remain private until author approval; reusable references omit source-specific content', async () => {
  const s = await setup(), saved = s.save()
  assert.equal(saved.status, 'proposed'); assert.equal(s.library.cards(s.path).total, 1)
  assert.equal((await s.library.search(s.path, { query: '信任冲突' })).hits.some(hit => hit.tier === 'curated'), false)
  s.apply(saved.id, 'approve')
  const hit = (await s.library.search(s.path, { query: '信任冲突' })).hits.find(hit => hit.tier === 'curated')
  const ref = s.library.read(s.path, hit.citation)
  assert.match(ref.text, /可迁移/); assert.doesNotMatch(ref.text, /SECRET|PRIVATE/)
  assert.throws(() => s.library.cardReference('another', hit.citation), /不属于/)
  assert.throws(() => s.library.analysisSnapshot(s.path, { ...s.input, references: [hit.citation] }), /原始证据/)
  const withdrawn = s.apply(saved.id, 'withdraw'); assert.equal(withdrawn.history.length, 2)
  assert.throws(() => s.library.read(s.path, hit.citation), /撤回/)
})
test('approvals are version-bound, transactional, idempotent and stale sources fail closed', async () => {
  const s = await setup(), id = randomUUID(), saved = s.save(id), change = { id, action: 'approve', reason: '已核对' }
  const preview = s.library.cardPreview(s.path, change), operation = randomUUID()
  assert.throws(() => s.library.cardApply(s.path, change, 'wrong', operation), /变化/)
  assert.equal(s.library.card(s.path, id).status, 'proposed')
  const approved = s.library.cardApply(s.path, change, preview.token, operation)
  assert.deepEqual(s.library.cardApply(s.path, change, preview.token, operation), approved)
  assert.throws(() => s.library.cardApply(s.path, { ...change, reason: 'changed' }, preview.token, operation), /重复/)
  const hit = (await s.library.search(s.path, { query: '信任冲突' })).hits.find(hit => hit.tier === 'curated')
  const second = s.save(); s.put('新的信任冲突资料。')
  assert.throws(() => s.library.read(s.path, hit.citation), /变化/)
  assert.throws(() => s.apply(second.id, 'approve'), /过期/)
  assert.equal(s.apply(second.id, 'reject').status, 'rejected')
  assert.equal(s.library.analysisReplay(s.path, id, 'request', 'signature').stale, true)
  assert.equal(s.save(id).status, 'approved'); assert.equal(saved.status, 'proposed')
  assert.throws(() => s.save(), /变化/)
  assert.throws(() => s.library.analysisReplay(s.path, id, 'different', 'signature'), /变化/)
})
function agentSetup(s, answer = output('EventsLibrary'), onRun = () => {}) {
  let calls = 0;const runs = new Map()
  const execution = { preview: input => ({ request: input, inputBytes: Buffer.byteLength(input.system + input.input), micros: 1 }),
    status: id => runs.get(id), async run(id) { if (runs.has(id)) return runs.get(id);calls++;onRun();const run = { id, status: 'succeeded', result: { text: answer } };runs.set(id, run);return run } }
  const agents = createAgents(s.books, execution, { roles: [] }, () => s.library)
  const task = { ...s.input, path: s.path, task: 'analyze-reference', request: '分析可迁移的方法', operation: randomUUID() }
  return { agents, execution, task, calls: () => calls }
}
test('ReferenceAgent uses one call and replays persisted status after restart and source changes', async () => {
  const s = await setup(), a = agentSetup(s), plan = a.agents.preview(a.task)
  assert.equal(a.agents.roles().find(role => role.id === 'reference').enabled, true)
  assert.equal(JSON.parse(plan.modelInput.input).units.length, s.snapshot.units.length)
  const input = { ...a.task, signature: plan.signature }, result = await a.agents.run(input)
  assert.equal(result.status, 'reference-ready');assert.equal(result.card.status, 'proposed');assert.equal(a.calls(), 1)
  s.apply(result.card.id, 'approve');s.put('改变来源。')
  const restarted = createAgents(s.books, a.execution, { roles: [] }, () => createLibrary(s.books, {})), replay = await restarted.run(input)
  assert.equal(replay.replayed, true);assert.equal(replay.card.status, 'approved');assert.equal(replay.card.stale, true);assert.equal(a.calls(), 1)
})
test('ReferenceAgent rejects invalid output and preserves a result if source or service changes', async () => {
  const s = await setup(), a = agentSetup(s, '{bad'), plan = a.agents.preview(a.task)
  assert.equal((await a.agents.run({ ...a.task, signature: plan.signature })).status, 'invalid-output')
  let library = s.library; const b = agentSetup(s, output('EventsLibrary'), () => { library = undefined })
  const agents = createAgents(s.books, b.execution, { roles: [] }, () => library), p = agents.preview(b.task), input = { ...b.task, signature: p.signature }
  assert.equal((await agents.run(input)).status, 'reference-pending');library = s.library
  assert.equal((await agents.run(input)).status, 'reference-ready');assert.equal(b.calls(), 1)
  const c = agentSetup(s, output('EventsLibrary'), () => s.put('新的来源。')), pc = c.agents.preview(c.task)
  assert.equal((await c.agents.run({ ...c.task, signature: pc.signature })).status, 'reference-pending')
  const disabled = createAgents(s.books, a.execution, { roles: [{ id: 'reference', enabled: false }] }, () => s.library)
  assert.throws(() => disabled.preview(a.task), /停用/)
  assert.throws(() => createAgents(s.books, a.execution, { roles: [] }).preview(a.task), /lg-library/)
})

test('single JSON fence is tolerated, but actual model schema drift and extra prose remain rejected', () => {
  const snapshot = { category: 'EventsLibrary', units: [{ id: 'r1:1', source: 0, start: 0, end: 2, text: '原句' }] }
  assert.equal(validateAnalysis('```json\n' + output('EventsLibrary') + '\n```', snapshot).title, '信任冲突方法')
  assert.throws(() => validateAnalysis('解释\n```json\n' + output('EventsLibrary') + '\n```', snapshot))
  assert.throws(() => validateAnalysis(failedModel.text, snapshot), /字段/)
})
