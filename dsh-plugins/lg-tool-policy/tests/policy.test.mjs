import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import * as policy from '../index.js'

async function fixture() {
  const ctx = new Context()
  const prompt = ctx.plugin(c => c.provide('systemPrompt', { tools() { return () => {} } }))
  await prompt.await()
  const tools = ctx.plugin(Tools)
  await tools.await()
  const definitions = ctx.plugin({ inject: ['tools'], apply(c) {
    for (const name of ['read', 'edit', 'bash']) c.effect(() => c.tools.register({
      name, description: name, parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: text => [{ type: 'text', text }] },
      execute: async () => ({ content: [{ type: 'text', text: name }] }),
    }), `fixture ${name}`)
  } })
  await definitions.await()
  const agents = []
  const agent = () => {
    const a = {}, scope = createScope(ctx, a)
    a.ctx = scope.ctx; agents.push(scope)
    return a
  }
  const step = a => ctx.serial(scopeTarget(a, a), 'agent/created', { agent: a })
  const close = async () => { for (const s of agents) await s.dispose(); await definitions.dispose(); await tools.dispose(); await prompt.dispose() }
  return { ctx, agent, step, close }
}

test('default-disabled policy leaves inherited tools available', async () => {
  const f = await fixture(), a = f.agent(), p = f.ctx.plugin(policy, {})
  await p.await()
  try { await f.step(a); assert.ok(f.ctx.get('tools').get('bash', a)) }
  finally { await p.dispose(); await f.close() }
})

test('allowlist restricts only created agents, intersects other restrictions and restores on unload', async () => {
  const f = await fixture(), a = f.agent(), b = f.agent(), p = f.ctx.plugin(policy, { enabled: true, allow: ['read', 'edit'] })
  await p.await()
  const other = a.ctx.get('tools').restrict({ deny: ['edit'] })
  try {
    await f.step(a); await f.step(a)
    assert.ok(f.ctx.get('tools').get('read', a)); assert.equal(f.ctx.get('tools').get('bash', a), undefined)
    assert.equal(f.ctx.get('tools').get('edit', a), undefined); assert.ok(f.ctx.get('tools').get('bash', b))
    await p.dispose()
    assert.ok(f.ctx.get('tools').get('bash', a)); assert.equal(f.ctx.get('tools').get('edit', a), undefined)
  } finally { other(); await p.dispose(); await f.close() }
})

test('disposal releases one agent and empty allowlist intentionally hides inherited tools', async () => {
  const f = await fixture(), a = f.agent(), b = f.agent(), p = f.ctx.plugin(policy, { enabled: true, allow: [] })
  await p.await()
  try {
    await f.step(a); await f.step(b)
    assert.equal(f.ctx.get('tools').get('read', a), undefined)
    await f.ctx.serial(scopeTarget(a, a), 'agent/disposed', { agent: a })
    assert.ok(f.ctx.get('tools').get('read', a)); assert.equal(f.ctx.get('tools').get('read', b), undefined)
  } finally { await p.dispose(); await f.close() }
})

test('unknown tools fail Agent initialization', async () => {
  const f = await fixture(), a = f.agent(), p = f.ctx.plugin(policy, { enabled: true, allow: ['missing'] })
  await p.await()
  try { await assert.rejects(f.step(a), /unknown global tool/); assert.ok(f.ctx.get('tools').get('read', a)) }
  finally { await p.dispose(); await f.close() }
})

test('agent-local tools remain visible under the host restriction semantics', async () => {
  const f = await fixture(), a = f.agent(), p = f.ctx.plugin(policy, { enabled: true, allow: ['edit'] })
  await p.await()
  const unregister = a.ctx.get('tools').register({ name: 'local_read', description: 'local',
    parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: text => [{ type: 'text', text }] },
    execute: async () => 'local',
  })
  try {
    await f.step(a)
    assert.ok(f.ctx.get('tools').get('local_read', a)); assert.ok(f.ctx.get('tools').get('edit', a))
    assert.equal(f.ctx.get('tools').get('bash', a), undefined)
  } finally { unregister(); await p.dispose(); await f.close() }
})
