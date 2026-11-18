import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { createLibrary } from '../../lg-library/src/service.js'
import { Executor } from '../../lg-execution/src/run.js'
import { createAgents } from '../src/service.js'

async function setup(duringRun = () => {}) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-task-references-'))); createBook(path).db.close()
  mkdirSync(join(path, 'ReferenceLibrary'), { recursive: true }); const file = join(path, 'ReferenceLibrary/style.txt')
  writeFileSync(file, '文风：通过具体动作体现犹豫，避免直接解释情绪。')
  const books = { list: () => [{ path }], manuscript: readManuscript,
    candidate: (path, input, generation) => writeManuscript(path, { ...input, action: 'candidate' }, generation) }
  const library = createLibrary(books, {}), citation = (await library.search(path, { query: '文风' })).hits[0].citation
  const config = { provider: 'fixture', model: 'fixture', inputCnyPerMillion: 1, outputCnyPerMillion: 2, maxOutputTokens: 4096, maxInputBytes: 16000 }
  let calls = 0
  const execution = { preview: input => new Executor(null, null, config).preview(input), async run(id) {
    calls++; duringRun(file)
    return { id, status: 'succeeded', result: { text: JSON.stringify({ replacement: '他伸手，又停了。', notes: '通过动作呈现犹豫。' }) } }
  } }
  const agents = createAgents(books, execution, { roles: [] }, () => library), snapshot = books.manuscript(path, 1)
  const input = { task: 'polish', path, document: 1, version: 1, token: snapshot.token, start: 0, end: 6,
    request: '保留事件，调整文风。', references: [citation], operation: randomUUID() }
  return { path, file, library, agents, input, calls: () => calls, books, execution }
}
test('selected references enter exact preview, signature and candidate metadata', async () => {
  const s = await setup(), plan = s.agents.preview(s.input)
  assert.match(JSON.parse(plan.modelInput.input).references[0].text, /具体动作/)
  assert.notEqual(s.agents.preview({ ...s.input, references: [] }).signature, plan.signature)
  await assert.rejects(s.agents.run({ ...s.input, references: [], signature: plan.signature }), /重新预览/)
  assert.equal(s.calls(), 0)
  const result = await s.agents.run({ ...s.input, signature: plan.signature })
  assert.equal(result.status, 'candidate-ready')
  const candidate = readManuscript(s.path, 1, result.candidate.version)
  assert.deepEqual(candidate.selected.metadata.generation.references, plan.references)
  const accept = { action: 'accept', operation: randomUUID(), document: 1, token: s.input.token, version: result.candidate.version }
  assert.throws(() => writeManuscript(s.path, accept), /lg-library/)
  writeFileSync(s.file, '参考资料已经修改。')
  const verify = refs => refs.forEach(ref => s.library.read(s.path, ref.citation))
  assert.throws(() => writeManuscript(s.path, accept, null, verify), /变化/)
  assert.equal(readManuscript(s.path, 1).document.activeVersion, 1)
  writeFileSync(s.file, '文风：通过具体动作体现犹豫，避免直接解释情绪。')
  writeManuscript(s.path, accept, null, verify)
  assert.equal(readManuscript(s.path, 1).document.activeVersion, result.candidate.version)
})
test('reference change before dispatch prevents model call', async () => {
  const s = await setup(), plan = s.agents.preview(s.input)
  writeFileSync(s.file, '来源改变。')
  await assert.rejects(s.agents.run({ ...s.input, signature: plan.signature }), /变化/)
  assert.equal(s.calls(), 0)
})
test('reference change during generation retains output without creating a candidate', async () => {
  const s = await setup(file => writeFileSync(file, '来源改变。')), plan = s.agents.preview(s.input)
  const result = await s.agents.run({ ...s.input, signature: plan.signature })
  assert.equal(result.status, 'candidate-pending'); assert.match(result.candidateError, /参考资料/)
  assert.equal(result.candidate, undefined); assert.equal(readManuscript(s.path, 1).versions.length, 2)
})
test('reference and request bounds fail before dispatch; library remains optional', async () => {
  const s = await setup()
  assert.throws(() => s.agents.preview({ ...s.input, request: '字'.repeat(2001) }), /2000/)
  assert.throws(() => s.agents.preview({ ...s.input, references: [...s.input.references, ...s.input.references] }), /不重复/)
  const noLibrary = createAgents(s.books, s.execution, { roles: [] })
  assert.throws(() => noLibrary.preview(s.input), /启用/)
  assert.equal(noLibrary.preview({ ...s.input, references: [] }).references.length, 0)
  assert.equal(s.calls(), 0)
})
