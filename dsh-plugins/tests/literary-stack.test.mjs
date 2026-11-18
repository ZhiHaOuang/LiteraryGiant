import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as books from '../lg-books/index.js'
import * as execution from '../lg-execution/index.js'
import * as agents from '../lg-agents/index.js'
import { createBook } from '../lg-books/tests/fixture.mjs'
import { createLibrary } from '../lg-library/src/service.js'

test('Cordis literary stack: preview, bounded generation, candidate API and plugin disposal', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lg-stack-'))); createBook(join(root, 'book')).db.close()
  const referenceFile = join(root, 'book/ReferenceLibrary/style.txt'), referenceText = '节奏：通过人物动作放缓叙事。'
  writeFileSync(referenceFile, referenceText)
  const ctx = new Context(), routes = new Map()
  let calls = 0
  const deps = ctx.plugin(c => {
    c.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
    c.provide('configEditor', { edit() { throw new Error('Unexpected config edit') } })
    c.provide('llm', { async prepareCall(config) { return { config, async *stream() {
      calls++
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ replacement: '林澈慢慢关上灯。', notes: '放缓动作。' }) } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } })
  }); await deps.await()
  const b = ctx.plugin(books, { projects: [join(root, 'book')] }); await b.await()
  const library = createLibrary(ctx.get('literaryBooks'), {})
  const referenceService = ctx.plugin(c => { c.provide('literaryLibrary', library) }); await referenceService.await()
  const citation = (await library.search(join(root, 'book'), { query: '节奏' })).hits[0].citation
  const e = ctx.plugin(execution, { provider: 'fixture', model: 'fixture', ledgerPath: join(root, 'budget.sqlite3'),
    budgetCny: 1, inputCnyPerMillion: 1, outputCnyPerMillion: 2, maxInputBytes: 16000, maxOutputTokens: 4096, timeoutMs: 3000 }); await e.await()
  const a = ctx.plugin(agents, { roles: [] }); await a.await()
  const api = async input => (await routes.get('/api/lg/agents').fetch(new Request('http://localhost/api/lg/agents', {
    method: 'POST', body: JSON.stringify(input),
  }))).json()
  const snapshot = ctx.get('literaryBooks').manuscript(join(root, 'book'), 1)
  const input = { task: 'polish', path: join(root, 'book'), document: 1, version: 1, token: snapshot.token,
    start: 0, end: 6, request: '放缓动作，保留事件', references: [citation], operation: randomUUID() }
  try {
    const plan = await api({ action: 'preview', ...input }); assert.equal(plan.ok, true)
    const result = await api({ action: 'run', ...input, signature: plan.value.signature })
    assert.equal(result.ok, true); assert.equal(result.value.run.status, 'succeeded')
    assert.equal(result.value.candidate.changesManuscript, false)
    assert.equal(ctx.get('literaryBooks').manuscript(input.path, 1).document.activeVersion, 1)
    assert.equal((await api({ action: 'run', ...input, signature: plan.value.signature })).value.candidate.version, result.value.candidate.version)
    assert.equal(calls, 1)
    assert.equal((await api({ action: 'accept', ...input })).ok, false)
    const accept = { action: 'accept', path: input.path, document: 1, version: result.value.candidate.version,
      token: input.token, operation: randomUUID() }
    const authorApi = async () => (await routes.get('/api/lg/books').fetch(new Request('http://localhost/api/lg/books', {
      method: 'POST', body: JSON.stringify(accept),
    }))).json()
    writeFileSync(referenceFile, '参考资料已改变。')
    assert.equal((await authorApi()).ok, false)
    assert.equal(ctx.get('literaryBooks').manuscript(input.path, 1).document.activeVersion, 1)
    writeFileSync(referenceFile, referenceText)
    assert.equal((await authorApi()).ok, true)
  } finally { await a.dispose(); await e.dispose(); await referenceService.dispose(); await b.dispose(); await deps.dispose() }
  assert.equal(ctx.get('literaryAgents'), undefined)
  assert.equal(ctx.get('literaryExecution'), undefined)
  assert.equal(routes.size, 0)
})
