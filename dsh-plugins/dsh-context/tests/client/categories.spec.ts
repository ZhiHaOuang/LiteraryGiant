import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { anchoredParts, billedParts, officialParts, partsOf, type PartsPart } from '../../src/client/categories'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../src/shared/types'

function current(over: Partial<Snapshot['current']> = {}): Snapshot['current'] {
  return { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0, ...over }
}

function values(parts: PartsPart[]): Record<string, number> {
  return Object.fromEntries(parts.map(p => [p.key, p.value]))
}

function part(value: number, raw?: number): PartsPart {
  return raw === undefined ? { key: 'k', color: '#000', value } : { key: 'k', color: '#000', value, raw }
}

describe('partsOf', () => {
  test('reads all seven categories in CATS order with their colors; missing keys fall back to zero', () => {
    const parts = partsOf(current({ system: 1, tools: 2, user: 3, inject: 4, skill: 5, assistant: 6, tool: 7 }))
    assert.deepEqual(parts.map(p => [p.key, p.color, p.value]), [
      ['system', 'var(--color-indigo-500)', 1],
      ['tools', 'var(--color-amber-500)', 2],
      ['user', 'var(--color-green-500)', 3],
      ['inject', 'var(--color-purple-500)', 4],
      ['skill', 'var(--color-orange-500)', 5],
      ['assistant', 'var(--color-blue-500)', 6],
      ['tool', 'var(--color-teal-500)', 7],
    ])
    assert.deepEqual(values(partsOf({ system: 5, user: 10 } as unknown as Snapshot['current'])), { system: 5, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0 })
  })
})

describe('officialParts', () => {
  test('without a breakdown the fold sums serve as-is; a breakdown supplies system/tools/messages, falling back per field', () => {
    const cur = current({ system: 5, tools: 7, user: 10, assistant: 30, tool: 60, total: 112 })
    assert.deepEqual(values(officialParts(cur, null)), { system: 5, tools: 7, user: 10, inject: 0, skill: 0, assistant: 30, tool: 60 })
    const partial = officialParts(current({ system: 1, tools: 2, user: 10, total: 13 }), { systemTokens: 9 } as unknown as ContextBreakdown)
    assert.deepEqual(values(partial), { system: 9, tools: 2, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0 })
    const delivered = officialParts(current({ system: 1, tools: 2, user: 50, assistant: 50, total: 102 }), { systemTokens: 100, toolsTokens: 200, messageTokens: 20 })
    assert.deepEqual(values(delivered), { system: 100, tools: 200, user: 10, inject: 0, skill: 0, assistant: 10, tool: 0 })
  })

  test('rounding residue lands on the largest category, a negative residue clamps to zero, and an empty surface yields zero message shares', () => {
    const residue = officialParts(current({ system: 1, tools: 2, user: 33, assistant: 33, tool: 34, total: 103 }), { systemTokens: 0, toolsTokens: 0, messageTokens: 10 })
    assert.deepEqual(values(residue), { system: 0, tools: 0, user: 3, inject: 0, skill: 0, assistant: 3, tool: 4 })
    const clamped = officialParts(current({ user: 25, inject: 25, assistant: 25, tool: 25, total: 100 }), { systemTokens: 0, toolsTokens: 0, messageTokens: 2 })
    assert.deepEqual(values(clamped), { system: 0, tools: 0, user: 0, inject: 1, skill: 0, assistant: 1, tool: 1 })
    const empty = officialParts(current(), { systemTokens: 1, toolsTokens: 2, messageTokens: 100 })
    assert.deepEqual(values(empty), { system: 1, tools: 2, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 })
  })
})

describe('anchoredParts', () => {
  test('a null or non-positive target, or a zero raw total, returns the parts unchanged with raw defaulted', () => {
    assert.deepEqual(anchoredParts([part(100), part(50, 20)], null), [
      { key: 'k', color: '#000', value: 100, raw: 100 },
      { key: 'k', color: '#000', value: 50, raw: 20 },
    ])
    assert.deepEqual(anchoredParts([part(100)], 0), [{ key: 'k', color: '#000', value: 100, raw: 100 }])
    assert.deepEqual(anchoredParts([part(0), part(0)], 100), [
      { key: 'k', color: '#000', value: 0, raw: 0 },
      { key: 'k', color: '#000', value: 0, raw: 0 },
    ])
  })

  test('a target equal to the raw total rewrites value to raw; otherwise values scale by the raw ratios', () => {
    assert.deepEqual(anchoredParts([part(10, 60), part(90, 40)], 100).map(p => [p.value, p.raw]), [[60, 60], [40, 40]])
    assert.deepEqual(anchoredParts([part(0, 20), part(0, 50)], 40).map(p => p.value), [11, 29])
  })
})

describe('billedParts', () => {
  const USAGE: TokenUsage = { uncachedInputTokens: 300, outputTokens: 60, cacheReadTokens: 100, cacheWriteTokens: 0 }

  test('the billed input splits by the estimated ratios, the assistant rest joins tool results, and the split scales when billed input differs', () => {
    const cur = current({ system: 50, tools: 50, user: 100, inject: 0, assistant: 100, tool: 100, total: 400 })
    assert.deepEqual(billedParts(cur, null, USAGE).map(p => [p.key, p.color, p.value]), [
      ['system', 'var(--color-indigo-500)', 50],
      ['tools', 'var(--color-amber-500)', 50],
      ['user', 'var(--color-green-500)', 100],
      ['inject', 'var(--color-purple-500)', 0],
      ['skill', 'var(--color-orange-500)', 0],
      ['toolCalls', 'var(--color-teal-500)', 260],
      ['thinking', 'var(--color-violet-500)', 0],
      ['answers', 'var(--color-pink-500)', 0],
    ])
    const scaled = billedParts(current({ system: 100, user: 100, total: 200 }), null, { ...USAGE, uncachedInputTokens: 400, cacheReadTokens: 0, outputTokens: 0 })
    assert.deepEqual(values(scaled), { system: 200, tools: 0, user: 200, inject: 0, skill: 0, toolCalls: 0, answers: 0, thinking: 0 })
  })

  test('a delivered breakdown supplies the split ratios; a zero billed input zeroes the prompt split but keeps the output remainder', () => {
    const cur = current({ user: 150, assistant: 150, total: 300 })
    const split = billedParts(cur, { systemTokens: 100, toolsTokens: 100, messageTokens: 200 }, { ...USAGE, uncachedInputTokens: 800, cacheReadTokens: 0 })
    assert.deepEqual(values(split), { system: 200, tools: 200, user: 200, inject: 0, skill: 0, toolCalls: 260, answers: 0, thinking: 0 })
    const zero = billedParts(current({ system: 100, user: 100, total: 200 }), null, { uncachedInputTokens: 0, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.deepEqual(values(zero), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 25, answers: 0, thinking: 0 })
  })

  test('the assistant bucket splits by content ratios, and the same ratios split the generated output', () => {
    const cur = current({ system: 100, assistant: 100, assistantReasoning: 60, assistantCallTokens: 40, total: 200 })
    const parts = billedParts(cur, null, { uncachedInputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { reasoning: 20, calls: 60 })
    assert.deepEqual(values(parts), { system: 100, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 70, answers: 0, thinking: 80 })
    assert.deepEqual(parts.map(p => p.value).reduce((a, b) => a + b, 0), 250, 'the parts still total the chat line')
  })

  test('reply text splits out of the assistant bucket and output, and a text-only session never lands a token on Tool Calls', () => {
    const cur = current({ assistant: 100, assistantReasoning: 60, assistantAnswerTokens: 20, total: 100 })
    const parts = billedParts(cur, null, { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { reasoning: 20, answers: 10 })
    assert.deepEqual(values(parts), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 55, thinking: 95 })
    assert.deepEqual(parts.map(p => p.value).reduce((a, b) => a + b, 0), 150, 'the parts still total the chat line')
  })

  test('reasoning and answers never exceed their source buckets: hostile shares clamp to the assistant and output remainders', () => {
    const reasoned = billedParts(
      current({ assistant: 100, assistantReasoning: 200, total: 100 }),
      null,
      { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: 999 },
    )
    assert.deepEqual(values(reasoned), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 0, thinking: 110 })
    const answered = billedParts(
      current({ assistant: 100, assistantReasoning: 80, assistantAnswerTokens: 90, total: 100 }),
      null,
      { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: 10, answers: 999 },
    )
    assert.deepEqual(values(answered), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 20, thinking: 90 })
  })

  test('generated reasoning and answers need no live subset, and a zero billed input still splits the output remainder', () => {
    const cur = current({ assistant: 200, total: 200 })
    const parts = billedParts(cur, null, { uncachedInputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { reasoning: 20 })
    assert.deepEqual(values(parts), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 200, answers: 0, thinking: 50 })
    const noInput = billedParts(
      current({ assistant: 100, total: 100 }),
      null,
      { uncachedInputTokens: 0, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: 10, answers: 5 },
    )
    assert.deepEqual(values(noInput), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 15, thinking: 10 })
  })

  test('an all-zero composition leaves the billed input unattributed, and hostile buckets never yield negative parts', () => {
    assert.deepEqual(values(billedParts(current(), null, USAGE)), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 60, answers: 0, thinking: 0 })
    const hostile = billedParts(
      current({ system: 100, assistantReasoning: -5, assistantAnswerTokens: -7, total: 100 }),
      null,
      { uncachedInputTokens: -10, outputTokens: -5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: -10, answers: -20 },
    )
    assert.deepEqual(values(hostile), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 0, thinking: 0 })
  })
})
