import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import * as books from '../../lg-books/index.js'
import * as memory from '../../lg-memory/index.js'
import * as context from '../index.js'

test('Cordis API and real ToolsService expose bounded context and release registrations on reload', async () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-context-host-'))); createBook(path).db.close()
  const ctx = new Context(), routes = new Map()
  const deps = ctx.plugin(c => {
    c.provide('systemPrompt', { tools() { return () => {} } })
    c.provide('workingDirectory', { ensure: async () => path })
    c.provide('configEditor', { edit() { throw new Error('Unexpected mutation') } })
    c.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  }); await deps.await()
  const registry = ctx.plugin(ToolsService, {}); await registry.await()
  const b = ctx.plugin(books, { projects: [path] }); await b.await()
  const m = ctx.plugin(memory); await m.await()
  let c = ctx.plugin(context); await c.await()
  const api = async data => (await routes.get('/api/lg/context').fetch(new Request('http://localhost/api/lg/context', {
    method: 'POST', body: JSON.stringify({ path, ...data }),
  }))).json()
  try {
    const options = { audience: 'author', documents: [6] }, result = await api({ action: 'build', options })
    assert.equal(result.ok, true); assert.equal(result.value.payload.items[0].id, 6)
    assert.equal((await api({ action: 'documents' })).value.length, 7)
    assert.equal((await api({ action: 'build', path: '/unregistered', options })).ok, false)
    assert.equal(ctx.get('tools').schemas().find(t => t.name === 'literary_context').parameters.required.includes('options'), true)
    const toolResult = await ctx.get('tools').get('literary_context').execute({ options }, { agent: {}, signal: new AbortController().signal })
    assert.deepEqual(toolResult.receipt, result.value.receipt)
    await c.dispose(); assert.equal(ctx.get('literaryContext'), undefined); assert.equal(routes.has('/api/lg/context'), false)
    assert.equal(ctx.get('tools').get('literary_context'), undefined)
    c = ctx.plugin(context); await c.await()
    assert.equal(ctx.get('literaryContext').verify(path, result.value.receipt), true)
  } finally { await c.dispose(); await m.dispose(); await b.dispose(); await registry.dispose(); await deps.dispose() }
  assert.equal(routes.size, 0)
})
