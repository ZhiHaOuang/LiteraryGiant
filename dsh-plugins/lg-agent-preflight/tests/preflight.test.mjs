import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

const valid = { name: 'lg_read_chapter', description: 'Read selected chapter', parameters: { type: 'object', properties: { chapter: { type: 'integer' } }, required: ['chapter'], additionalProperties: false } }
const invalid = { ...valid, parameters: { chapter: { type: 'integer', required: true } } }
const chunks = [{ type: 'text-delta', index: 0, text: 'fixture' }, { type: 'finish', reason: { kind: 'stop' } }]
async function drain(stream) { const output = []; for await (const chunk of stream) output.push(chunk); return output }
async function fixture(t) {
  const ctx = new Context(), requests = []
  const service = ctx.plugin(c => c.provide('llm', { stream(options) {
    return c.waterfall(this, 'llm/stream', options, async function* () { requests.push(options); yield* chunks })
  } }))
  await service.await()
  t.after(() => ctx.fiber.dispose())
  return { ctx, requests }
}
async function mount(ctx) { const fiber = ctx.plugin(plugin, { toolNames: ['lg_read_chapter'] }); await fiber.await(); return fiber }

test('old shorthand reaches a provider without the plugin, then is refused before dispatch', async t => {
  const { ctx, requests } = await fixture(t)
  const request = { provider: 'fixture', model: 'fixture', tools: [invalid], messages: [] }
  await drain(ctx.llm.stream(request)); assert.equal(requests.length, 1)
  const fiber = await mount(ctx)
  await assert.rejects(drain(ctx.llm.stream(request)), error => error.code === 'TOOL_PARAMETER_SCHEMA_INVALID')
  assert.equal(requests.length, 1)
  await fiber.dispose()
  await drain(ctx.llm.stream(request)); assert.equal(requests.length, 2)
})

test('valid frozen requests and stream chunks pass through by identity for main and member', async t => {
  const { ctx, requests } = await fixture(t); await mount(ctx)
  const tool = structuredClone(valid)
  Object.freeze(tool.parameters.properties.chapter); Object.freeze(tool.parameters.properties)
  Object.freeze(tool.parameters.required); Object.freeze(tool.parameters); Object.freeze(tool)
  for (const sessionId of ['main', 'member']) {
    const request = Object.freeze({ sessionId, tools: Object.freeze([tool]), messages: Object.freeze([]) })
    const output = await drain(ctx.llm.stream(request))
    assert.equal(requests.at(-1), request); assert.equal(output[0], chunks[0]); assert.deepEqual(output, chunks)
  }
})

test('nested invalid declarations are refused, while missing and unselected tools delegate', async t => {
  const { ctx, requests } = await fixture(t); await mount(ctx)
  const bad = [
    { type: 'array' },
    { type: 'object', properties: { chapter: { type: 'integer', required: true } } },
    { type: 'object', properties: {}, required: ['missing'] },
  ]
  for (const parameters of bad) await assert.rejects(drain(ctx.llm.stream({ tools: [{ ...valid, parameters }] })))
  assert.equal(requests.length, 0)
  await drain(ctx.llm.stream({ tools: [{ ...invalid, name: 'external_tool' }] }))
  await drain(ctx.llm.stream({ tools: [] })); await drain(ctx.llm.stream({}))
  assert.equal(requests.length, 3)
})

test('reused request mutations are rechecked and invalid configuration fails at load', async t => {
  const { ctx, requests } = await fixture(t); await mount(ctx)
  const request = { tools: [structuredClone(valid)] }
  await drain(ctx.llm.stream(request))
  request.tools[0].parameters = invalid.parameters
  await assert.rejects(drain(ctx.llm.stream(request)))
  assert.equal(requests.length, 1)
  for (const toolNames of [[], ['x', 'x'], [' '], [' x']]) assert.throws(() => plugin.apply({ on() {} }, { toolNames }), /unique, nonempty/)
})
