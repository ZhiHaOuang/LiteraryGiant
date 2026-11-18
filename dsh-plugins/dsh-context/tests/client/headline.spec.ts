import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { headlineOf, occupancyPercent } from '../../src/client/headline'
import type { ContextTimeline, RequestRecord } from '../../src/shared/types'

function timeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 10, tools: 20, user: 30, inject: 0, skill: 0, assistant: 40, tool: 0, total: 100 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

function req(over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq: 5, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 80, ...over }
}

describe('headlineOf occupancy', () => {
  test('the projection anchors first, then the derived request/`last` anchor, then the heuristic total', () => {
    const h = headlineOf(timeline(), { projectedTokens: 200, contextWindow: 1000 })
    assert.equal(h.tokens, 200)
    assert.equal(h.window, 1000)
    assert.equal(h.pct, 20)
    assert.equal(headlineOf(timeline({ requests: [req({ prompt: 150 })] }), { projectedTokens: 200 }).tokens, 200)
    const data = timeline({ requests: [req({ prompt: 150 })] })
    assert.equal(headlineOf(data, { projectedTokens: 'junk' as unknown as number }).tokens, 170)
    assert.equal(headlineOf(data, { pressureTokens: 'junk' as unknown as number }).tokens, 170)
    const sample = headlineOf(data, { pressureTokens: 150, contextWindow: 1000 })
    assert.equal(sample.tokens, 150, 'the bare provider sample serves when the projection carries no forward value')
    assert.equal(sample.pct, 15)
    assert.equal(headlineOf(timeline({ requests: [req({ prompt: 150, total: 80 })] }), null).tokens, 170)
    assert.equal(headlineOf(timeline({ last: { seq: 9, total: 80, prompt: 150 } }), null).tokens, 170)
    assert.equal(headlineOf(timeline(), null).tokens, 100, 'empty requests yield no anchor')
    assert.equal(headlineOf(timeline({ requests: [req()] }), null).tokens, 100, 'a request without a numeric prompt yields no anchor')
    assert.equal(headlineOf(timeline({ last: { seq: 9, total: 80 } }), null).tokens, 100, 'a `last` without a numeric prompt yields no anchor')
    assert.equal(headlineOf(timeline()).tokens, 100, 'no anchor anywhere')
  })
})

describe('headlineOf window and pct', () => {
  test("the pressure window wins over the timeline one; pct uses the plugin's 0.1 grid, not the kernel's whole-percent rounding; no or non-positive windows yield a null pct; pct clamps", () => {
    assert.equal(headlineOf(timeline({ contextWindow: 1000 }), { contextWindow: 500 }).window, 500)
    assert.equal(headlineOf(timeline({ contextWindow: 1000 }), { contextWindow: 500 }).pct, 20)
    const fallback = headlineOf(timeline({ contextWindow: 200 }), { contextWindow: 'junk' as unknown as number })
    assert.equal(fallback.window, 200)
    assert.equal(fallback.pct, 50)
    const bare = headlineOf(timeline(), null)
    assert.equal(bare.window, undefined)
    assert.equal(bare.pct, null)
    assert.equal(headlineOf(timeline({ contextWindow: 0 }), null).pct, null)
    assert.equal(headlineOf(timeline(), { projectedTokens: 200, contextWindow: 300 }).pct, 66.7)
    assert.equal(headlineOf(timeline(), { projectedTokens: 1, contextWindow: 1_000_000 }).pct, 0)
    assert.equal(headlineOf(timeline(), { projectedTokens: 250, contextWindow: 100 }).pct, 100)
    assert.equal(occupancyPercent(400, 300), 100)
  })
})

describe('headlineOf reserve', () => {
  test('the window and output cap resolve the two masks; no cap leaves the headroom mask; no window leaves no reserve', () => {
    const h = headlineOf(timeline({ contextWindow: 1_000_000, maxOutputTokens: 256_000 }), null)
    assert.deepEqual(h.reserve, { threshold: 678_464, headroom: 65_536, output: 256_000 })
    const pressured = headlineOf(timeline({ maxOutputTokens: 256_000 }), { contextWindow: 1_000_000 })
    assert.deepEqual(pressured.reserve, { threshold: 678_464, headroom: 65_536, output: 256_000 })
    const uncapped = headlineOf(timeline({ contextWindow: 1_000_000 }), null)
    assert.deepEqual(uncapped.reserve, { threshold: 800_000, headroom: 65_536, output: 0 })
    const hostile = headlineOf(timeline({ contextWindow: 1_000_000, maxOutputTokens: 'junk' as unknown as number }), null)
    assert.deepEqual(hostile.reserve, { threshold: 800_000, headroom: 65_536, output: 0 })
    const zero = headlineOf(timeline({ contextWindow: 1_000_000, maxOutputTokens: 0 }), null)
    assert.deepEqual(zero.reserve, { threshold: 800_000, headroom: 65_536, output: 0 })
    assert.equal(headlineOf(timeline({ maxOutputTokens: 256_000 }), null).reserve, undefined)
  })
})

describe('headlineOf parts', () => {
  test('a positive occupancy anchors the parts to it; without one they stay unanchored (value equals raw)', () => {
    assert.deepEqual(headlineOf(timeline(), { projectedTokens: 200 }).parts.map(p => [p.key, p.value, p.raw]), [
      ['system', 20, 10],
      ['tools', 40, 20],
      ['user', 60, 30],
      ['inject', 0, 0],
      ['skill', 0, 0],
      ['assistant', 80, 40],
      ['tool', 0, 0],
    ])
    assert.deepEqual(headlineOf(timeline(), null).parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [0, 0], [40, 40], [0, 0],
    ])
    const zero = headlineOf(timeline(), { projectedTokens: 0 })
    assert.equal(zero.tokens, 0)
    assert.deepEqual(zero.parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [0, 0], [40, 40], [0, 0],
    ])
  })
})
