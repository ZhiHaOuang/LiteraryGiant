import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createAgents } from '../../lg-agents/src/service.js'
import { Executor } from '../../lg-execution/src/run.js'
import { createContext } from '../src/service.js'
import { assemble, policy, bytes, excerpt } from '../src/policy.js'

function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-context-'))); createBook(path).db.close()
  const books = { list: () => [{ path }], readState: (p, fn) => accessState(p, false, fn), changeState: (p, fn) => accessState(p, true, fn),
    manuscript: readManuscript, candidate: (p, input, generation) => writeManuscript(p, { ...input, action: 'candidate' }, generation) }
  const memory = createMemory(books), context = createContext(books, memory)
  const apply = change => memory.apply(path, change, memory.preview(path, change).token, randomUUID())
  return { path, books, memory, context, apply, write: fn => books.changeState(path, fn) }
}
const cognition = (audience = 'character', position = 10) => ({ action: 'knowledge.propose', slug: `known-${audience}-${position}`, title: '来信认知', expected_version_id: 0,
  topic: { audience, holder_document_id: audience === 'character' ? 6 : null, key: 'letter-origin', from_position: position },
  statement: { content: '林澈相信信来自未来。', stance: 'believes', until_position: 30, sources: [{ document_id: 1, version_id: 1 }] },
  rationale: 'AUTHOR_SECRET: 真相是妹妹写的。' })
const confirm = v => ({ action: 'knowledge.confirm', id: v.document_id, expected_version_id: v.version_id, proposal_version_number: v.proposal_version_number })

test('author selection is explicit, labels provisional records and binds only delivered excerpts', () => {
  const s = setup()
  s.apply({ action: 'fact.add', category: 'world', key: 'guard', value: '灯塔有人看守。', state: 'canonical', rationale: '确认' })
  s.apply({ action: 'fact.add', category: 'idea', key: 'storm', value: '也许会有暴风雨。', rationale: '备选' })
  const empty = s.context.build(s.path, {})
  assert.equal(empty.payload.items.length, 0)
  const result = s.context.build(s.path, { documents: [6, 7], facts: true, ideas: true, maxBytes: 8000 })
  assert.deepEqual(result.sources.map(v => v.kind), ['document', 'document', 'fact', 'idea'])
  assert.match(result.payload.items[1].label, /draft/)
  assert.match(result.payload.items[3].label, /未确认/)
  assert.doesNotMatch(JSON.stringify(result.payload), /林澈关上灯/)
  assert.equal(result.payload.items.length, result.receipt.sources.length)
  assert.equal(s.context.verify(s.path, result.receipt), true)
})
test('cognition excludes author rationale, world truth, pending revisions, future and other audience', () => {
  const s = setup(), proposed = s.apply(cognition()), confirmed = s.apply(confirm(proposed))
  s.apply({ ...cognition(), expected_version_id: confirmed.version_id, statement: { ...cognition().statement, content: 'PENDING_SECRET' } })
  s.apply({ action: 'fact.add', category: 'world', key: 'truth', value: 'WORLD_SECRET', state: 'canonical', rationale: '确认' })
  const result = s.context.build(s.path, { audience: 'character', position: 15, holder_document_id: 6 })
  assert.match(JSON.stringify(result.payload), /信来自未来/)
  assert.doesNotMatch(JSON.stringify(result), /AUTHOR_SECRET|PENDING_SECRET|WORLD_SECRET/)
  assert.equal(s.context.build(s.path, { audience: 'character', position: 5, holder_document_id: 6 }).payload.items.length, 0)
  assert.equal(s.context.build(s.path, { audience: 'reader', position: 15 }).payload.items.length, 0)
  assert.equal(s.context.build(s.path, { audience: 'character', position: 30, holder_document_id: 6 }).payload.items.length, 0)
  assert.throws(() => s.context.build(s.path, { audience: 'character', position: 15, holder_document_id: 6, notes: true }), /混入/)
})
test('receipt detects full source changes outside excerpt, source withdrawal and another book', () => {
  const s = setup()
  s.write(db => db.prepare('UPDATE document_versions SET content=? WHERE id=6').run('前文。'.repeat(1000) + '旧结尾'))
  const result = s.context.build(s.path, { documents: [6] })
  assert.equal(result.payload.items[0].truncated, true)
  s.write(db => db.prepare('UPDATE document_versions SET content=? WHERE id=6').run('前文。'.repeat(1000) + '新结尾'))
  assert.throws(() => s.context.verify(s.path, result.receipt), /已变化/)
  const another = setup(); assert.throws(() => another.context.verify(another.path, result.receipt), /已变化/)
  const known = s.apply(confirm(s.apply(cognition()))), view = s.context.build(s.path, { audience: 'character', position: 15, holder_document_id: 6 })
  s.apply({ action: 'knowledge.withdraw', id: known.document_id, expected_version_id: known.version_id, rationale: '撤回' })
  assert.throws(() => s.context.verify(s.path, view.receipt), /已变化/)
})
test('UTF-8 and JSON escaping fit strict serialized payload budget and omit untouched sources', () => {
  const items = Array.from({ length: 20 }, (_, id) => ({ kind: 'test', id, label: '材料', text: '😀中文\n"\\'.repeat(800), identity: { id }, sourceHash: 'x' }))
  for (const maxBytes of [1000, 2000, 4000]) {
    const result = assemble(policy({ maxBytes }), items, [])
    assert.ok(bytes(result.payload) <= maxBytes); assert.ok(result.omitted.length > 0)
    assert.equal(result.sources.length, result.payload.items.length)
    assert.doesNotMatch(JSON.stringify(result.payload), /�/)
  }
  assert.deepEqual(excerpt('😀中', 3), { text: '', truncated: true })
})
test('fixed notes are bounded and cannot follow symlinks or read raw corpus', () => {
  const s = setup(), note = join(s.path, 'ReferenceLibrary/bible/STORY_BIBLE.md')
  writeFileSync(note, '作者笔记，不是 Canonical。')
  mkdirSync(join(s.path, 'TaciturnRaw')); writeFileSync(join(s.path, 'TaciturnRaw/raw.txt'), 'RAW_SECRET')
  mkdirSync(join(s.path, '.learnings')); writeFileSync(join(s.path, '.learnings/a.md'), '避免重复解释。')
  const result = s.context.build(s.path, { notes: true })
  assert.equal(result.sources.length, 2); assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/)
  writeFileSync(note, '新笔记'); assert.throws(() => s.context.verify(s.path, result.receipt), /已变化/)
  symlinkSync(join(s.path, 'TaciturnRaw/raw.txt'), join(s.path, 'ReferenceLibrary/bible/STYLE_GUIDE.md'))
  assert.throws(() => s.context.build(s.path, { notes: true }), /符号链接/)
  const big = setup(); writeFileSync(join(big.path, 'ReferenceLibrary/bible/STORY_BIBLE.md'), 'x'.repeat(262145))
  assert.throws(() => big.context.build(big.path, { notes: true }), /过大/)
})
test('invalid selectors, malformed asset manifest and dedicated decision documents fail closed', () => {
  const s = setup()
  for (const options of [{ audience: 'bad' }, { maxBytes: 999 }, { documents: [0] }, { facts: 'yes' }, { audience: 'reader' }, { unknown: true }]) {
    assert.throws(() => s.context.build(s.path, options))
  }
  s.write(db => db.prepare("UPDATE documents SET kind='creative_decision' WHERE id=7").run())
  assert.throws(() => s.context.build(s.path, { documents: [7] }), /专用/)
  writeFileSync(join(s.path, '.literarygiant/assets.json'), '{"schema":"lg.assets.v1","status":"pending"}')
  assert.throws(() => s.context.build(s.path, { notes: true }), /未完成/)
})
function agentSetup(during = () => {}) {
  const s = setup(); let calls = 0
  const execution = { preview: input => new Executor(null, null, { provider: 'test', model: 'fixture', inputCnyPerMillion: 1, outputCnyPerMillion: 2, maxOutputTokens: 4096, maxInputBytes: 16000 }).preview(input),
    async run(id) { calls++; during(s); return { id, status: 'succeeded', result: { text: JSON.stringify({ replacement: '林澈缓缓关上灯。', notes: '放缓节奏。' }) } } } }
  const agents = createAgents(s.books, execution, { roles: [] }, undefined, () => s.context)
  const input = { task: 'polish', path: s.path, document: 1, version: 1, start: 0, end: 6, token: readManuscript(s.path, 1).token,
    request: '保留情节，调整节奏。', context: { documents: [6] }, operation: randomUUID() }
  return { ...s, agents, input, calls: () => calls }
}
test('context changes after preview prevent billing; changes during generation retain output without candidate', async () => {
  const s = agentSetup(), preview = s.agents.preview(s.input)
  s.write(db => db.prepare("UPDATE document_versions SET content='人物修改了' WHERE id=6").run())
  await assert.rejects(s.agents.run({ ...s.input, signature: preview.signature }), /重新预览/); assert.equal(s.calls(), 0)
  const t = agentSetup(s => s.write(db => db.prepare("UPDATE document_versions SET content='人物修改了' WHERE id=6").run()))
  const result = await t.agents.run({ ...t.input, signature: t.agents.preview(t.input).signature })
  assert.equal(result.status, 'candidate-pending'); assert.match(result.candidateError, /上下文/)
  assert.ok(result.output.replacement); assert.equal(result.candidate, undefined)
})
test('candidate adoption requires context service and exact current source receipt', async () => {
  const s = agentSetup(), plan = s.agents.preview(s.input)
  const result = await s.agents.run({ ...s.input, signature: plan.signature })
  const candidate = readManuscript(s.path, 1, result.candidate.version)
  assert.deepEqual(candidate.selected.metadata.generation.context, plan.context.receipt)
  const input = { action: 'accept', document: 1, version: result.candidate.version, token: s.input.token, operation: randomUUID() }
  assert.throws(() => writeManuscript(s.path, input), /lg-context/)
  s.write(db => db.prepare("UPDATE document_versions SET content='人物修改了' WHERE id=6").run())
  assert.throws(() => writeManuscript(s.path, input, null, null, receipt => s.context.verify(s.path, receipt)), /已变化/)
  assert.equal(readManuscript(s.path, 1).document.activeVersion, 1)
  s.write(db => db.prepare("UPDATE document_versions SET content='守灯人。承诺等最后一艘船返港。' WHERE id=6").run())
  assert.equal(writeManuscript(s.path, input, null, null, receipt => s.context.verify(s.path, receipt)).changesManuscript, true)
})
