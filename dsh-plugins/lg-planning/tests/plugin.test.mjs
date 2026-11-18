import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import * as books from '../../lg-books/index.js'
import * as planning from '../index.js'

test('native DSH tools propose only; author API selects exact option and reload retains choice', async () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-planning-host-'))); createBook(path).db.close()
  const ctx = new Context(), routes = new Map()
  const deps = ctx.plugin(c => {
    c.provide('systemPrompt', { tools() { return () => {} } })
    c.provide('workingDirectory', { ensure: async () => path })
    c.provide('configEditor', { edit() { throw new Error('Unexpected mutation') } })
    c.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  }); await deps.await()
  const tools = ctx.plugin(ToolsService, {}); await tools.await()
  const b = ctx.plugin(books, { projects: [path] }); await b.await()
  let p = ctx.plugin(planning); await p.await()
  const api = async data => (await routes.get('/api/lg/planning').fetch(new Request('http://localhost/api/lg/planning', { method: 'POST', body: JSON.stringify({ path, ...data }) }))).json()
  try {
    const exec = { agent: {}, signal: new AbortController().signal }, registry = ctx.get('tools')
    assert.deepEqual(registry.schemas().map(v => v.name).sort(), ['literary_plan', 'literary_propose_plan'])
    const change = { action: 'decision.options', slug: 'host-choice', title: '主线方向', topic: { scope: 'work', document_id: null, key: 'main' }, expected_version_id: 0, sources: [], request: '作者提供的合成需求。',
      options: ['a','b','c'].map(id => ({ id, title: '方案'+id, content: '路线'+id })) }
    const operation = randomUUID(), value = await registry.get('literary_propose_plan').execute({ operation, change }, exec)
    assert.equal(value.selection, null)
    assert.deepEqual(await registry.get('literary_propose_plan').execute({ operation, change }, exec), value)
    const select = { action: 'decision.select', id: value.document_id, expected_version_id: value.version_id, options_version_number: 1, option_id: 'b' }
    await assert.rejects(registry.get('literary_propose_plan').execute({ operation: randomUUID(), change: select }, exec), /模型只能/)
    const preview = await api({ action: 'preview', change: select }); assert.equal(preview.ok, true)
    assert.equal((await api({ action: 'apply', change: select, token: 'wrong', operation: randomUUID() })).ok, false)
    const result = await api({ action: 'apply', change: select, token: preview.value.token, operation: randomUUID() }); assert.equal(result.value.selection.option_id, 'b')
    assert.equal((await api({ action: 'documents' })).value.length, 7)
    assert.equal((await api({ action: 'list', section: 'decisions', path: '/unregistered' })).ok, false)
    assert.equal((await registry.get('literary_plan').execute({ action: 'context' }, exec)).items[0].selection.option_id, 'b')
    await p.dispose(); assert.equal(routes.has('/api/lg/planning'), false); assert.equal(registry.get('literary_plan'), undefined)
    p = ctx.plugin(planning); await p.await()
    assert.equal((await api({ action: 'read', section: 'decisions', id: value.document_id })).value.selection.option_id, 'b')
  } finally { await p.dispose(); await b.dispose(); await tools.dispose(); await deps.dispose() }
  assert.equal(routes.size, 0)
})
