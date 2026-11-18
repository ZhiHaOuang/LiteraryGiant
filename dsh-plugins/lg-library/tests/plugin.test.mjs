import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'

test('Cordis API and native DSH tools share book scope and unload together', async () => {
  const book = mkdtempSync(join(tmpdir(), 'lg-reference-host-'))
  mkdirSync(join(book, 'ReferenceLibrary')); writeFileSync(join(book, 'ReferenceLibrary/reference.txt'), '信任冲突需要人物动机支持。')
  let shared=''
  const ctx = new Context(), routes = new Map()
  const deps = ctx.plugin(c => {
    c.provide('literaryBooks', { list: () => [{ path: book }],libraryRoot:()=>shared })
    c.provide('workingDirectory', { ensure: async () => book })
    c.provide('systemPrompt', { tools() { return () => {} } })
    c.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  }); await deps.await()
  const registry = ctx.plugin(ToolsService, {}); await registry.await()
  const tools = ctx.get('tools')
  const fiber = ctx.plugin(plugin, {}); await fiber.await()
  try {
    assert.deepEqual(tools.schemas().map(schema => schema.name).sort(), ['literary_reference', 'literary_search'])
    const result = await tools.get('literary_search').execute({ query: '信任冲突' }, { agent: {}, signal: new AbortController().signal })
    assert.equal(result.hits.length, 1)
    const reference = await tools.get('literary_reference').execute({ citation: result.hits[0].citation }, { agent: {} })
    assert.match(reference.text, /人物动机/)
    await assert.rejects(tools.get('literary_search').execute({ query: '信任冲突' }, {}), /会话/)
    const route = routes.get('/api/lg/library')
    const call = body => route.fetch(new Request('http://localhost/api/lg/library', { method: 'POST', body: JSON.stringify(body) }))
    assert.equal((await (await call({ action: 'search', path: book, query: '信任冲突' })).json()).value.hits.length, 1)
    assert.equal((await call({ action: 'search', path: '/unregistered', query: '信任冲突' })).status, 400)
    shared=join(book,'Shared');mkdirSync(join(shared,'AbstractLibrary'),{recursive:true})
    writeFileSync(join(shared,'AbstractLibrary/pattern_index.jsonl'),JSON.stringify({pattern_id:'shared',summary:'共享节奏'})+'\n')
    assert.equal((await tools.get('literary_search').execute({query:'共享节奏'},{agent:{},signal:new AbortController().signal})).hits[0].id,'shared')
    assert.equal((await call({ action: 'write', path: book })).status, 400)
  } finally { await fiber.dispose() }
  assert.equal(ctx.get('literaryLibrary'), undefined); assert.equal(routes.size, 0); assert.equal(tools.definitions().length, 0)
  await registry.dispose(); await deps.dispose()
})
