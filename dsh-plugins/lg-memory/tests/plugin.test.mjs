import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import * as books from '../../lg-books/index.js'
import * as memory from '../index.js'

test('real DSH tools propose only; author API previews confirmation; state survives plugin reload', async () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-memory-host-'))); createBook(path).db.close()
  const ctx = new Context(), routes = new Map()
  const deps = ctx.plugin(c => {
    c.provide('systemPrompt', { tools() { return () => {} } })
    c.provide('workingDirectory', { ensure: async () => path })
    c.provide('configEditor', { edit() { throw new Error('Unexpected configuration mutation') } })
    c.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  }); await deps.await()
  const registry = ctx.plugin(ToolsService, {}); await registry.await()
  const book = ctx.plugin(books, { projects: [path] }); await book.await()
  let plugin = ctx.plugin(memory); await plugin.await()
  const api = async data => (await routes.get('/api/lg/memory').fetch(new Request('http://localhost/api/lg/memory', { method: 'POST', body: JSON.stringify({ path, ...data }) }))).json()
  try {
    const tools = ctx.get('tools'), exec = { agent: {}, signal: new AbortController().signal }
    assert.deepEqual(tools.schemas().map(tool => tool.name).sort(), ['literary_memory', 'literary_remember'])
    const proposal = await tools.get('literary_remember').execute({ operation: randomUUID(), proposal: { action: 'fact.propose', category: 'world', key: 'letter', value: '灯塔收到一封来信。', rationale: '作品中的候选事实。', source_document_id: 1, source_version_id: 1 } }, exec)
    assert.equal(proposal.status, 'proposed')
    assert.equal((await tools.get('literary_memory').execute({ audience: 'author', section: 'proposals', id: proposal.id }, exec)).status, 'proposed')
    assert.equal((await api({ action: 'record', section: 'proposals', id: proposal.id })).value.id, proposal.id)
    assert.equal((await tools.get('literary_memory').execute({ audience: 'world' }, exec)).facts.length, 0)
    const change = { action: 'proposal.accept', id: proposal.id, rationale: '作者核对确认。' }, preview = await api({ action: 'preview', change })
    assert.equal(preview.ok, true)
    assert.equal((await api({ action: 'apply', change, token: 'wrong', operation: randomUUID() })).ok, false)
    assert.equal((await api({ action: 'apply', change, token: preview.value.token, operation: randomUUID() })).value.fact.state, 'canonical')
    assert.equal((await tools.get('literary_memory').execute({ audience: 'world' }, exec)).facts.length, 1)
    await assert.rejects(tools.get('literary_remember').execute({ operation: randomUUID(), proposal: { action: 'knowledge.confirm' } }, exec), /模型只能/)
    assert.equal((await api({ action: 'list', path: '/unregistered', section: 'facts' })).ok, false)
    await plugin.dispose(); assert.equal(ctx.get('tools').definitions().length, 0); assert.equal(routes.has('/api/lg/memory'), false)
    plugin = ctx.plugin(memory); await plugin.await()
    assert.equal((await api({ action: 'list', section: 'facts' })).value.items[0].state, 'canonical')
  } finally { await plugin.dispose(); await book.dispose(); await registry.dispose(); await deps.dispose() }
  assert.equal(routes.size, 0)
})
