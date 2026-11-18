import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as preflight from '../index.js'

class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'fixture response' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture response' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function harness(t, enabled, parameters) {
  const ctx = new Context(), adapter = new Adapter()
  t.after(() => ctx.fiber.dispose())
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.tools.register({ name: 'lg_read_chapter', description: 'fixture', parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { return {} } })
  if (enabled) await ctx.plugin(preflight, { toolNames: ['lg_read_chapter'] })
  const agent = await ctx.agentLoop.create(SessionId('preflight-host'), { provider: 'fixture', model: 'fixture' })
  const idle = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { release(); reject(new Error('fixture did not settle')) }, 5000)
    const release = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { clearTimeout(timer); release(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'analyze fixture' }], source: { kind: 'user' } }))
  await idle
  return { ctx, agent, adapter }
}
const invalid = { chapter: { type: 'integer', required: true } }
const valid = { type: 'object', properties: { chapter: { type: 'integer' } }, required: ['chapter'], additionalProperties: false }

test('actual loop records a typed refusal without provider dispatch; baseline exposes malformed schema', async t => {
  const baseline = await harness(t, false, invalid)
  assert.equal(baseline.adapter.requests.length, 1)
  const guarded = await harness(t, true, invalid)
  assert.equal(guarded.adapter.requests.length, 0)
  const ending = guarded.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
  assert.equal(ending.data.reason.kind, 'error')
  assert.equal(ending.data.reason.error.code, 'TOOL_PARAMETER_SCHEMA_INVALID')
  assert.equal(guarded.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
})

test('actual loop with a valid contract completes once and preserves the logged request schema', async t => {
  const { agent, adapter } = await harness(t, true, valid)
  assert.equal(adapter.requests.length, 1)
  assert.deepEqual(adapter.requests[0].tools[0].parameters, valid)
  const ending = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
  assert.equal(ending.data.reason.kind, 'completed')
})

test('complete prompt suppresses independent system guidance but retains schemas and dynamic context', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Literary coordinator' })
  ctx.systemPrompt.section({ name: 'ops-fixture', order: 3200, text: 'Use the job wait tool for existing jobs.' })
  ctx.systemPrompt.context({ name: 'permissions', order: 100, required: true, text: 'Read only.' })
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'lg_read_chapter', description: 'fixture', parameters: valid }] }))
  const release = ctx.systemPrompt.section({ name: 'literary', order: 200, complete: true, text: 'Exact literary prompt.' })
  const complete = await ctx.systemPrompt.assemble()
  assert.equal(renderPrompt(complete), 'Exact literary prompt.')
  assert.equal(complete.tools.length, 1)
  assert.match(renderContextSnapshot(complete), /Read only/)
  release()
  const composed = renderPrompt(await ctx.systemPrompt.assemble())
  assert.match(composed, /Literary coordinator/); assert.match(composed, /job wait/)
})
