import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { watchPromptInjection, type SystemPromptFace } from '../../src/host/promptInjection'

type RegisteredSection = {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

function fakeSystemPrompt(): SystemPromptFace & { registered: RegisteredSection[] } {
  const registered: RegisteredSection[] = []
  return {
    registered,
    section(section: RegisteredSection): () => void {
      registered.push(section)
      return () => {}
    },
    getSectionOrder(name: string): number {
      const orders: Record<string, number> = { HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_SUFFIX: 10200 }
      return orders[name] ?? 0
    },
  }
}

function ctxWith(systemPrompt: unknown): Context {
  return {
    inject: (_names: unknown, cb: (inner: unknown) => void) => { cb({ systemPrompt }) },
  } as unknown as Context
}

function ref(box: { value: unknown }): { get: () => unknown } {
  return { get: () => box.value }
}

function textOf(section: RegisteredSection | undefined): string {
  return typeof section?.text === 'function' ? section.text(undefined) : ''
}

describe('watchPromptInjection', () => {
  test('registers both sections outside every allocated slot, with literal text', () => {
    const face = fakeSystemPrompt()
    watchPromptInjection(ctxWith(face), { promptPrefix: 'FIRST', promptSuffix: 'LAST' } as never)
    assert.deepEqual(face.registered.map(section => section.name), [
      'dsh-context:prompt-prefix',
      'dsh-context:prompt-suffix',
    ])
    const [prefix, suffix] = face.registered
    assert.equal(prefix.order, -2000, 'ahead of HARNESS_IDENTITY, anchored through the harness registry')
    assert.equal(suffix.order, 11200, 'behind DEPLOYMENT_PERSONA_SUFFIX')
    assert.equal(textOf(prefix), 'FIRST')
    assert.equal(textOf(suffix), 'LAST')
    assert.ok(face.registered.every(section => section.interpolate === false), 'the text is literal, never variable-interpolated')
  })

  test('a volatile reference is read at each assembly; a plain string stays static; non-strings and blanks read empty', () => {
    const face = fakeSystemPrompt()
    const box = { value: 'before' as unknown }
    watchPromptInjection(ctxWith(face), { promptPrefix: ref(box), promptSuffix: '' } as never)
    const prefix = face.registered[0]
    assert.equal(textOf(prefix), 'before')
    box.value = 'after'
    assert.equal(textOf(prefix), 'after', 'the loader rewrites the reference in place; the next assembly reads it')

    const staticFace = fakeSystemPrompt()
    watchPromptInjection(ctxWith(staticFace), { promptPrefix: 'static', promptSuffix: 42 } as never)
    const [staticPrefix, staticSuffix] = staticFace.registered
    assert.equal(textOf(staticPrefix), 'static')
    assert.equal(textOf(staticSuffix), '')
    const refFace = fakeSystemPrompt()
    const nonString = { value: 7 }
    watchPromptInjection(ctxWith(refFace), { promptPrefix: ref(nonString), promptSuffix: ref(nonString) } as never)
    assert.equal(textOf(refFace.registered[0]), '', 'a reference carrying a non-string reads as empty')

    const blankFace = fakeSystemPrompt()
    watchPromptInjection(ctxWith(blankFace), { promptPrefix: '  \n\t ', promptSuffix: '\nline one\n\nline two\n' } as never)
    const [blank, suffix] = blankFace.registered
    assert.equal(textOf(blank), '', 'a blank prompt contributes nothing')
    assert.equal(textOf(suffix), '\nline one\n\nline two\n', 'the configured bytes are preserved')
  })

  test('an absent or malformed prompt registry degrades to a no-op', () => {
    assert.doesNotThrow(() => watchPromptInjection(ctxWith(undefined), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith({}), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith({ section: () => {} }), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith({ getSectionOrder: () => 0 }), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith(null), {} as never))
  })

  test('the deferred inject rides the real cordis: early, late, and never-provided compositions', async () => {
    const { Context } = await import('@deepseek-ai/cordis')

    const early = new Context()
    early.provide('systemPrompt', fakeSystemPrompt())
    await new Promise(resolve => setTimeout(resolve, 10))
    watchPromptInjection(early, { promptPrefix: 'P' } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((early.reflect.get('systemPrompt') as unknown as { registered: RegisteredSection[] }).registered.length, 2, 'the service first: both sections register')

    const late = new Context()
    watchPromptInjection(late, { promptPrefix: 'P' } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    const lateFace = fakeSystemPrompt()
    late.provide('systemPrompt', lateFace)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(lateFace.registered.length, 2, 'the service later: the pending inject fires on the provide')

    const never = new Context()
    assert.doesNotThrow(() => watchPromptInjection(never, {} as never))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})
