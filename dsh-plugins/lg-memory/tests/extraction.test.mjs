import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { createMemory } from '../src/service.js'
import { createAgents } from '../../lg-agents/src/service.js'

const output = JSON.stringify({ facts: [{ category: '事件', key: '林澈关灯', value: '林澈关上了灯。', evidence: [1] }] })
function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-extraction-'))); createBook(path).db.close()
  const read = fn => accessState(path, false, fn), write = fn => accessState(path, true, fn)
  const books = { readState: (_path, fn) => read(fn), changeState: (_path, fn) => write(fn) }, memory = createMemory(books)
  const source = memory.extractionSource(path, 1), target = { document: 1, version: 1, token: source.token, start: 0, end: source.text.length }
  const snapshot = memory.extractionSnapshot(path, target)
  const save = (raw = output, operation = randomUUID()) => memory.saveExtraction(path, operation, 'request', 'signature', snapshot, raw)
  const apply = change => memory.apply(path, change, memory.preview(path, change).token, randomUUID())
  return { path, books, memory, read, write, target, snapshot, save, apply }
}
test('extraction binds accepted current manuscript, exact selection and UTF-16 boundaries', () => {
  const s = setup()
  for (const id of [3, 4, 6]) assert.throws(() => s.memory.extractionSource(s.path, id), /已采纳/)
  assert.throws(() => s.memory.extractionSnapshot(s.path, { ...s.target, version: 8 }), /版本/)
  assert.throws(() => s.memory.extractionSnapshot(s.path, { ...s.target, end: 999 }), /范围/)
  s.write(db => db.prepare('UPDATE document_versions SET content=? WHERE id=1').run('灯🏮亮着。海风停了。'))
  assert.throws(() => s.save(), /变化/)
  const source = s.memory.extractionSource(s.path, 1), target = { ...s.target, token: source.token, start: 2, end: 5 }
  assert.throws(() => s.memory.extractionSnapshot(s.path, target), /边界/)
  const selected = s.memory.extractionSnapshot(s.path, { ...target, start: 3, end: source.text.length })
  assert.equal(selected.units[0].start, 3); assert.equal(selected.units[0].text, '亮着。')
})
test('model evidence is bounded and copied from source; malformed batches persist nothing', () => {
  const s = setup(), first = JSON.parse(output).facts[0]
  for (const facts of [[{ ...first, evidence: [] }], [{ ...first, evidence: [9] }], [{ ...first, category: '未知' }], [{ ...first, state: 'canonical' }], [first, first], Array(9).fill(first)]) {
    assert.throws(() => s.save(JSON.stringify({ facts })))
  }
  assert.equal(s.memory.list(s.path, 'proposals').total, 0)
  const saved = s.save(); assert.equal(saved.proposals[0].extraction.evidence[0].quote, '林澈关上灯。')
  assert.equal(saved.proposals[0].extraction.evidence[0].end, 6)
  assert.equal(s.memory.list(s.path, 'facts').total, 0)
  assert.deepEqual(s.memory.record(s.path, 'proposals', saved.proposals[0].id).extraction, saved.proposals[0].extraction)
})
test('extracted proposals survive restart, replay idempotently and require explicit author confirmation', () => {
  const s = setup(), operation = randomUUID(), saved = s.save(output, operation), again = createMemory(s.books)
  assert.deepEqual(again.extracted(s.path, operation, 'request', 'signature'), saved)
  assert.deepEqual(s.save(output, operation), saved)
  assert.throws(() => again.extracted(s.path, operation, 'changed', 'signature'), /输入发生变化/)
  assert.equal(again.list(s.path, 'proposals').total, 1)
  const accepted = s.apply({ action: 'proposal.accept', id: saved.proposals[0].id, rationale: '作者核对原文。' })
  assert.equal(accepted.fact.state, 'canonical'); assert.equal(s.memory.world(s.path).facts.length, 1)
  assert.equal(again.record(s.path, 'proposals', saved.proposals[0].id).extraction.stale, false)
  assert.equal(again.extracted(s.path, operation, 'request', 'signature').proposals[0].status, 'accepted')
  assert.equal(s.save('{"facts":[]}').proposals.length, 0)
})
test('changed source or altered proposal blocks adoption while stale evidence and rejection remain available', () => {
  const s = setup(), first = s.save().proposals[0]
  s.write(db => db.prepare('UPDATE fact_proposals SET value=? WHERE id=?').run('没有原文依据的改动。', first.id))
  assert.throws(() => s.apply({ action: 'proposal.accept', id: first.id, rationale: '确认' }), /提案内容已变化/)
  assert.equal(s.memory.record(s.path, 'proposals', first.id).extraction.stale, true)
  s.apply({ action: 'proposal.reject', id: first.id, rationale: '拒绝改动' })
  const second = s.save().proposals[0]
  s.write(db => { db.exec("UPDATE document_versions SET state='accepted' WHERE id=8; UPDATE documents SET active_version_id=8 WHERE id=1") })
  assert.throws(() => s.apply({ action: 'proposal.accept', id: second.id, rationale: '确认' }), /证据/)
  const retained = s.memory.list(s.path, 'proposals').items[0]
  assert.equal(retained.extraction.stale, true); assert.equal(retained.extraction.evidence[0].quote, '林澈关上灯。')
  assert.equal(s.memory.list(s.path, 'facts').total, 0)
})
function agentSetup(s, answer = output, onRun = () => {}) {
  let calls = 0; const runs = new Map()
  const execution = { preview: input => ({ request: input, inputBytes: Buffer.byteLength(input.system + input.input), micros: 1 }),
    status: id => runs.get(id), async run(id) { if (runs.has(id)) return runs.get(id); calls++; onRun(); const run = { id, status: 'succeeded', result: { text: answer } }; runs.set(id, run); return run } }
  const agents = createAgents(s.books, execution, { roles: [] }, undefined, undefined, undefined, undefined, () => s.memory)
  const task = { path: s.path, task: 'extract-memory', target: s.target, request: '提取明确事实', operation: randomUUID() }
  return { agents, execution, task, calls: () => calls }
}
test('MemoryAgent runs one bounded request, exposes full input and replays saved extraction after source changes', async () => {
  const s = setup(), a = agentSetup(s), p = a.agents.preview(a.task)
  assert.equal(a.agents.roles().find(r => r.id === 'memory').enabled, true)
  assert.equal(a.agents.roles().find(r => r.id === 'reference').enabled, false)
  assert.match(p.modelInput.system, /人物谎言/); assert.equal(JSON.parse(p.modelInput.input).units[0].text, '林澈关上灯。')
  const input = { ...a.task, signature: p.signature }, result = await a.agents.run(input)
  assert.equal(result.status, 'memory-ready'); assert.equal(a.calls(), 1)
  s.write(db => db.exec("UPDATE documents SET state='archived' WHERE id=1"))
  const replay = await a.agents.run(input)
  assert.equal(replay.replayed, true); assert.equal(replay.extraction.proposals[0].extraction.stale, true); assert.equal(a.calls(), 1)
  assert.equal(s.memory.list(s.path, 'facts').total, 0)
})
test('a failed second insertion rolls back the entire extraction and its operation receipt', () => {
  const s = setup(), operation = randomUUID()
  s.write(db => db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON fact_proposals WHEN NEW.fact_key='风' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"))
  const facts = [...JSON.parse(output).facts, { category: '事件', key: '风', value: '海风停了。', evidence: [2] }]
  assert.throws(() => s.save(JSON.stringify({ facts }), operation), /synthetic failure/)
  assert.equal(s.memory.list(s.path, 'proposals').total, 0)
  assert.equal(s.memory.extracted(s.path, operation, 'request', 'signature'), null)
})
test('disabling memory during a model call preserves its result without claiming invalid output', async () => {
  const s = setup(); let service = s.memory
  const a = agentSetup(s, output, () => { service = undefined })
  const agents = createAgents(s.books, a.execution, { roles: [] }, undefined, undefined, undefined, undefined, () => service)
  const plan = agents.preview(a.task), result = await agents.run({ ...a.task, signature: plan.signature })
  assert.equal(result.status, 'memory-pending'); assert.equal(result.run.result.text, output)
  assert.match(result.candidateError, /已停用/); assert.equal(s.memory.list(s.path, 'proposals').total, 0)
  service = s.memory
  const saved = await agents.run({ ...a.task, signature: plan.signature })
  assert.equal(saved.status, 'memory-ready'); assert.equal(a.calls(), 1)
})
test('MemoryAgent refuses disabled roles, invalid model output and changes during the request', async () => {
  const s = setup(), a = agentSetup(s, '{bad'), p = a.agents.preview(a.task)
  assert.equal((await a.agents.run({ ...a.task, signature: p.signature })).status, 'invalid-output')
  const b = agentSetup(s, output, () => s.write(db => db.exec("UPDATE documents SET state='archived' WHERE id=1"))), plan = b.agents.preview(b.task)
  assert.equal((await b.agents.run({ ...b.task, signature: plan.signature })).status, 'memory-pending')
  assert.equal(s.memory.list(s.path, 'proposals').total, 0)
  const disabled = createAgents(s.books, a.execution, { roles: [{ id: 'memory', enabled: false }] }, undefined, undefined, undefined, undefined, () => s.memory)
  assert.throws(() => disabled.preview(a.task), /停用/)
  assert.throws(() => createAgents(s.books, a.execution, { roles: [] }).preview(a.task), /lg-memory/)
})
