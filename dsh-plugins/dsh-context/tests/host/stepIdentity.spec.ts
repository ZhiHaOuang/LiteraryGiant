import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { identifiedMessages, watchStepIdentity, type PreStepDecision } from '../../src/host/stepIdentity'

function identified(id = 'm-1'): Record<string, unknown> {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
}

describe('identifiedMessages', () => {
  test('an all-identified list returns undefined and copies nothing', () => {
    const messages = [identified('a'), identified('b')]
    assert.equal(identifiedMessages(messages), undefined)
  })

  test('a missing, empty, null, or non-string id is minted; untouched entries keep their references', () => {
    const broken = [
      { role: 'user', source: { kind: 'user' }, content: [] },
      { id: '', role: 'user' },
      { id: null },
      { id: 42 },
    ]
    const fixed = identifiedMessages(broken)
    assert.ok(fixed !== undefined)
    assert.equal(fixed.length, broken.length)
    for (const [index, message] of fixed.entries()) {
      assert.match((message as { id: string }).id, /^dshctx-[0-9a-f-]{36}$/, `entry ${index} minted`)
    }
    assert.deepEqual(
      fixed.map(message => ({ ...(message as object), id: undefined })),
      broken.map(message => ({ ...(message as object), id: undefined })),
      'every non-id field passes through',
    )
    const good = identified('keep')
    const mixed = identifiedMessages([good, {}, good])
    assert.ok(mixed !== undefined)
    assert.equal(mixed[0], good)
    assert.equal(mixed[2], good)
    assert.notEqual((mixed[1] as { id: string }).id, (mixed[0] as { id: string }).id)
    const tailGood = identified('head')
    const fixedTail = identifiedMessages([tailGood, tailGood, { role: 'user' }])
    assert.ok(fixedTail !== undefined)
    assert.equal(fixedTail[0], tailGood)
    assert.equal(fixedTail[1], tailGood)
    assert.match((fixedTail[2] as { id: string }).id, /^dshctx-/)
  })

  test('non-object entries stay verbatim (unfixable without inventing a container)', () => {
    const messages = [null, 42, 'x']
    assert.equal(identifiedMessages(messages), undefined)
  })
})

describe('watchStepIdentity', () => {
  async function drive(inner: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const ctx = new Context()
    watchStepIdentity(ctx)
    return ctx.waterfall('agent/pre-step', { agent: {}, messages: [], signal: new AbortController().signal, step: 1, turn: 1 }, inner)
  }

  test('an enter decision with an unidentified message comes back minted', async () => {
    const decision: PreStepDecision = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
    const result = await drive(() => Promise.resolve(decision))
    assert.equal(result.kind, 'enter')
    assert.match((result.messages![0] as { id: string }).id, /^dshctx-/)
    assert.equal((result.messages![0] as { role: string }).role, 'user', 'the rest of the message survives')
  })

  test('a decision the guard cannot improve passes through by reference', async () => {
    const identifiedDecision = { kind: 'enter', messages: [identified('m-9')] }
    assert.equal(await drive(() => Promise.resolve(identifiedDecision)), identifiedDecision)
    const reject = { kind: 'reject' }
    assert.equal(await drive(() => Promise.resolve(reject)), reject)
    const enter = { kind: 'enter' }
    assert.equal(await drive(() => Promise.resolve(enter)), enter)
  })

  test('a hostile decision or entry fails the guard open, verbatim', async () => {
    const hostileDecision = {
      get kind(): string { throw new Error('hostile decision') },
    }
    assert.equal(await drive(() => Promise.resolve(hostileDecision)), hostileDecision)
    const hostileMessages = {
      kind: 'enter',
      get messages(): unknown[] { throw new Error('hostile messages') },
    }
    assert.equal(await drive(() => Promise.resolve(hostileMessages)), hostileMessages)
  })

  test('the guard rides outermost: it post-processes what later listeners returned', async () => {
    const ctx = new Context()
    const order: string[] = []
    watchStepIdentity(ctx)
    ctx.on('agent/pre-step', async (_input, next) => {
      order.push('inner-pre')
      const decision = await next()
      order.push('inner-post')
      return decision
    })
    const result = await ctx.waterfall(
      'agent/pre-step',
      { agent: {}, messages: [], signal: new AbortController().signal, step: 1, turn: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [{ role: 'user' }] } as PreStepDecision),
    )
    assert.deepEqual(order, ['inner-pre', 'inner-post'])
    assert.match(((result.messages as unknown[])[0]! as { id: string }).id, /^dshctx-/, 'the message the loop would append is identified')
  })
})
