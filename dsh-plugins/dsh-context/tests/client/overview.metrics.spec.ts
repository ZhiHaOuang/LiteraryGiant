import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  aggregateDays,
  billedOf,
  createdDayOf,
  DayAggregator,
  dayRangeWindow,
  kpisOf,
  timingSumOf,
  tokenPartsOf,
  turnsOf,
  usageTotalsOf,
  windowTotalsOf,
  type OverviewRow,
} from '../../src/client/overview'
import { priceIndexOf } from '../../src/client/cost'
import type { ContextActivity, ContextTimeline, SessionCostUsage } from '../../src/shared/types'
import { COST, rowOf } from './overview.fixtures'

describe('billedOf / turnsOf', () => {
  test('billed sums the team’s merged cost buckets; absent cost reads null', () => {
    assert.equal(billedOf(rowOf()), null)
    assert.equal(billedOf(rowOf({ familyCost: COST })), 200)
  })

  test('turns prefer the precomputed count and fall back to the records', () => {
    assert.equal(turnsOf(null), 0)
    assert.equal(turnsOf({ requests: [{}, {}] } as never), 2)
    assert.equal(turnsOf({ counts: { turns: 7 }, requests: [{}] } as never), 7)
  })
})

describe('createdDayOf', () => {
  const activity = { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 1, requests: 1 } } }

  test('the earliest ledger day stands in for the creation date; no ledger, no days record, or an empty one names none', () => {
    assert.equal(createdDayOf(activity as ContextActivity), '2026-09-10')
    assert.equal(
      createdDayOf({ days: { '2026-09-10': { tokens: 1, requests: 1 }, '2026-09-16': { tokens: 5, requests: 1 } } } as ContextActivity),
      '2026-09-10',
      'a later day never displaces the earliest',
    )
    assert.equal(createdDayOf(null), undefined)
    assert.equal(createdDayOf({} as ContextActivity), undefined)
    assert.equal(createdDayOf({ days: {} } as ContextActivity), undefined)
  })
})

describe('usageTotalsOf', () => {
  test('absent or empty usage reads null; buckets sum per bucket and in total', () => {
    assert.equal(usageTotalsOf(null), null)
    assert.equal(usageTotalsOf(undefined), null)
    assert.equal(usageTotalsOf({}), null)
    assert.equal(usageTotalsOf({ deepseek: {} }), null)
    assert.equal(usageTotalsOf({ deepseek: { m: {} } }), null)
    const totals = usageTotalsOf({
      deepseek: { a: { peak: { uncached: 10, cacheRead: 5, cacheWrite: 2, output: 3 }, off: { uncached: 4, cacheRead: 1, cacheWrite: 1, output: 1 } } },
      other: { b: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    })
    assert.deepEqual(totals, { input: 15, cacheRead: 6, cacheWrite: 3, output: 6, total: 30 })
  })
})

describe('timingSumOf', () => {
  const SUM = {
    wallMs: 150, ttftMs: 15, genMs: 90, calls: 3, toolsMs: 40, toolCalls: 4,
    tools: { read: { calls: 3, ms: 25 }, write: { calls: 1, ms: 10 } },
  }

  test('no timing anywhere reads null; otherwise the required fields sum and per-tool tallies merge untouched', () => {
    assert.equal(timingSumOf([]), null)
    assert.equal(timingSumOf([rowOf()]), null)
    assert.equal(timingSumOf([rowOf({ timeline: { requests: [] } as unknown as ContextTimeline })]), null)
    const a = { wallMs: 100, ttftMs: 10, genMs: 60, calls: 2, toolsMs: 30, toolCalls: 3, tools: { read: { calls: 2, ms: 20 } } }
    const b = { wallMs: 50, ttftMs: 5, genMs: 30, calls: 1, toolsMs: 10, toolCalls: 1, tools: { read: { calls: 1, ms: 5 }, write: { calls: 1, ms: 10 } } }
    const sum = timingSumOf([
      rowOf({ timeline: { timing: a } as unknown as ContextTimeline }),
      rowOf({ timeline: { timing: b } as unknown as ContextTimeline }),
    ])
    assert.deepEqual(sum, SUM)
    assert.deepEqual(a.tools.read, { calls: 2, ms: 20 })
  })

  test('folds every family member — a null self and the dispatched subagents alike', () => {
    const self = { wallMs: 100, ttftMs: 10, genMs: 60, calls: 2, toolsMs: 30, toolCalls: 3, tools: { read: { calls: 2, ms: 20 } } }
    const kid = { wallMs: 50, ttftMs: 5, genMs: 30, calls: 1, toolsMs: 10, toolCalls: 1, tools: { read: { calls: 1, ms: 5 }, write: { calls: 1, ms: 10 } } }
    const sum = timingSumOf([rowOf({ family: [null, { timing: self }, { timing: kid }] as unknown as ContextTimeline[] })])
    assert.deepEqual(sum, SUM)
  })

  test('the additive-optional fields sum their carriers only', () => {
    const split = {
      wallMs: 1, ttftMs: 1, genMs: 10, calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
      reasoningMs: 4, reasoningBlocks: 2, textMs: 5, textBlocks: 1, toolBusyMs: 3, idleMs: 7, speedTokens: 100, speedMs: 2_000,
    }
    const preSplit = { wallMs: 1, ttftMs: 1, genMs: 10, calls: 1, toolsMs: 0, toolCalls: 0, tools: {} }
    const rowsOf = (timings: unknown[]): OverviewRow[] =>
      timings.map(timing => rowOf({ timeline: { timing } as unknown as ContextTimeline }))
    const sum = timingSumOf(rowsOf([split, preSplit]))
    const reverse = timingSumOf(rowsOf([preSplit, split]))
    for (const merged of [sum, reverse]) {
      assert.equal(merged?.genMs, 20, 'the generation window sums every row')
      assert.equal(merged?.reasoningMs, 4)
      assert.equal(merged?.reasoningBlocks, 2)
      assert.equal(merged?.textMs, 5)
      assert.equal(merged?.textBlocks, 1)
      assert.equal(merged?.toolArgMs, undefined, 'no row carries a tool-arg split')
      assert.equal(merged?.toolBusyMs, undefined, 'a pre-field member makes the busy union unknowable')
      assert.equal(merged?.idleMs, 7)
      assert.equal(merged?.speedTokens, 100)
      assert.equal(merged?.speedMs, 2_000)
    }
    const both = timingSumOf(rowsOf([split, { ...split, reasoningMs: 6, toolBusyMs: 6, idleMs: 5, speedTokens: 50 }]))
    assert.equal(both?.reasoningMs, 10)
    assert.equal(both?.toolBusyMs, 9)
    assert.equal(both?.idleMs, 12)
    assert.equal(both?.speedTokens, 150)
  })
})

describe('tokenPartsOf', () => {
  const STANDARD_CURRENT = { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 }
  const TINY_CURRENT = { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 }

  test('nothing billed reads null; otherwise each session\'s billedParts estimate folds by category and totals stay billed-exact', () => {
    assert.equal(tokenPartsOf([]), null)
    assert.equal(tokenPartsOf([rowOf()]), null)
    assert.equal(
      tokenPartsOf([rowOf({ timeline: { current: STANDARD_CURRENT, requests: [] } as unknown as ContextTimeline })]),
      null,
      'a composition without billed buckets contributes nothing',
    )
    const rows = [
      rowOf({ timeline: { current: STANDARD_CURRENT, cost: COST, requests: [] } as unknown as ContextTimeline }),
      rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, requests: [] } as unknown as ContextTimeline }),
    ]
    const folded = tokenPartsOf(rows)
    assert.deepEqual(folded, {
      total: 210,
      parts: [
        { key: 'system', color: 'var(--color-indigo-500)', value: 42 },
        { key: 'tools', color: 'var(--color-amber-500)', value: 16 },
        { key: 'user', color: 'var(--color-green-500)', value: 10 },
        { key: 'inject', color: 'var(--color-purple-500)', value: 3 },
        { key: 'skill', color: 'var(--color-orange-500)', value: 3 },
        { key: 'toolCalls', color: 'var(--color-teal-500)', value: 136 },
      ],
    })
  })

  test('the members\' reasoning shares fold into one thinking part, and reasoning-only output stays on thinking', () => {
    const reasoningCurrent = { ...STANDARD_CURRENT, assistantReasoning: 150 }
    const rows = [
      rowOf({ timeline: { current: reasoningCurrent, cost: COST, generatedReasoning: 12, requests: [] } as unknown as ContextTimeline }),
      rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, requests: [] } as unknown as ContextTimeline }),
    ]
    assert.deepEqual(tokenPartsOf(rows), {
      total: 210,
      parts: [
        { key: 'system', color: 'var(--color-indigo-500)', value: 42 },
        { key: 'tools', color: 'var(--color-amber-500)', value: 16 },
        { key: 'user', color: 'var(--color-green-500)', value: 10 },
        { key: 'inject', color: 'var(--color-purple-500)', value: 3 },
        { key: 'skill', color: 'var(--color-orange-500)', value: 3 },
        { key: 'toolCalls', color: 'var(--color-teal-500)', value: 32 },
        { key: 'thinking', color: 'var(--color-violet-500)', value: 104 },
      ],
    })
  })

  test('the aggregate keeps the ring order, so Answers closes whatever member contributes first', () => {
    const member = (over: Record<string, number>): OverviewRow => rowOf({
      timeline: {
        current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 100, ...over, tool: 0, total: 100 },
        cost: { deepseek: { m: { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
        requests: [],
      } as unknown as ContextTimeline,
    })
    const answersOnly = member({ assistantAnswerTokens: 100 })
    const callsOnly = member({ assistantCallTokens: 100 })
    for (const rows of [[answersOnly, callsOnly], [callsOnly, answersOnly]]) {
      assert.deepEqual(tokenPartsOf(rows)?.parts.map(p => [p.key, p.value]), [['toolCalls', 100], ['answers', 100]])
    }
  })

  test('a non-finite composition estimate drops whole instead of poisoning the sums', () => {
    const hostile = rowOf({
      timeline: {
        current: { system: Number.NaN, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: Number.NaN },
        cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
        requests: [],
      } as unknown as ContextTimeline,
    })
    const plain = rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m2: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } } } as unknown as ContextTimeline })
    assert.deepEqual(tokenPartsOf([hostile]), { parts: [], total: 0 })
    assert.deepEqual(tokenPartsOf([hostile, plain]), {
      total: 10,
      parts: [{ key: 'system', color: 'var(--color-indigo-500)', value: 10 }],
    })
  })

  test('a scoped split folds only the daily ledger days inside the window', () => {
    const member = { current: STANDARD_CURRENT, cost: COST, requests: [] } as unknown as ContextTimeline
    const activity: ContextActivity = {
      days: {
        '2026-09-16': { tokens: 5, requests: 1, cost: COST },
        '2026-09-17': { tokens: 9, requests: 1, cost: COST },
      },
    }
    const row = rowOf({ timeline: member, family: [member], familyActivity: [activity] })
    const scope = dayRangeWindow({ from: '2026-09-16', to: '2026-09-16' })
    assert.ok(scope !== null)
    assert.equal(tokenPartsOf([row], scope)?.total, 200, 'one admitted day of COST, not both')
    const orphan = rowOf({ timeline: { current: STANDARD_CURRENT, cost: COST, requests: [] } as unknown as ContextTimeline, family: [member], familyActivity: [null] })
    assert.equal(tokenPartsOf([orphan], scope), null, 'a member without a ledger contributes no scoped usage')
    const noLedger = rowOf({ timeline: member })
    assert.equal(tokenPartsOf([noLedger], scope), null, 'a row without a family ledger contributes nothing to a scoped split')
  })
})

describe('windowTotalsOf', () => {
  test('folds only admitted days; a cost-less day leaves the usage null', () => {
    const scope = dayRangeWindow({ from: '2026-09-16', to: '2026-09-16' })
    assert.ok(scope !== null)
    assert.deepEqual(windowTotalsOf(null, scope), { turns: 0, usage: null })
    assert.deepEqual(
      windowTotalsOf({
        days: {
          '2026-09-16': { tokens: 1, requests: 1, turns: 1, toolCalls: 2, toolsMs: 3, wallMs: 4 },
          '2026-09-17': { tokens: 9, requests: 9, cost: COST },
        },
      }, scope),
      { turns: 1, usage: null },
      'the day after the window contributes nothing',
    )
    assert.deepEqual(
      windowTotalsOf({ days: { '2026-09-16': { tokens: 1, requests: 1, cost: COST } } }, scope).usage,
      COST,
    )
  })

  test('the per-ledger memo returns the same totals for the same boundary day keys, and does not grow per minute', () => {
    const activity = { days: { '2026-09-16': { tokens: 1, requests: 1, turns: 1 } } }
    const scope = dayRangeWindow({ from: '2026-09-16', to: '2026-09-16' })
    assert.ok(scope !== null)
    const first = windowTotalsOf(activity, scope)
    assert.ok(windowTotalsOf(activity, scope) === first, 'the same window reuses the cached totals')
    const drifted = { start: (scope.start ?? 0) + 60_000, end: scope.end }
    assert.ok(windowTotalsOf(activity, drifted) === first, 'a minute-shifted floor hits the same day-key entry')
    const wider = dayRangeWindow({ from: '2026-09-15', to: '2026-09-16' })
    assert.ok(wider !== null)
    assert.notEqual(windowTotalsOf(activity, wider), first)
    assert.deepEqual(windowTotalsOf(activity, wider), { turns: 1, usage: null })
  })
})

describe('kpisOf', () => {
  const prices = { prices: { deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }

  test('aggregates sessions, tokens, turns, cost, and cache hit across the range', () => {
    const rows = [
      rowOf({
        timeline: {
          cost: COST,
          counts: { turns: 3 },
          current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
          requests: [],
          timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolCalls: 7, tools: {} },
        } as unknown as ContextTimeline,
        familyCost: COST,
      }),
      rowOf({
        timeline: {
          requests: [{}, {}],
          timing: { wallMs: 30_000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
        } as unknown as ContextTimeline,
      }),
    ]
    const kpi = kpisOf(rows, prices, 'usd')
    assert.equal(kpi.sessions, 2)
    assert.equal(kpi.tokens, 200)
    assert.equal(kpi.turns, 5)
    assert.ok(kpi.cost !== null && Math.abs(kpi.cost - 390e-6) < 1e-12, 'the DeepSeek peak bucket doubles: 2 × (50×0.1 + 100×1 + 10×1 + 40×2) per 1M')
    assert.equal(kpi.cacheHit, '31.25', '50 reads of 160 billed input, truncated')
    assert.equal(kpi.costSessions, 1, 'only the priced session counts toward the cost cell')
    assert.equal(kpi.usageSessions, 1, 'only the billed session feeds the cache-hit rate')
    assert.equal(kpi.tokenParts?.total, 200)
    assert.deepEqual(kpi.tokenParts?.parts.find(p => p.key === 'system'), { key: 'system', color: 'var(--color-indigo-500)', value: 32 })
    assert.deepEqual(kpi.timing, { wallMs: 120_000, ttftMs: 1_000, genMs: 30_000, calls: 6, toolsMs: 20_000, toolCalls: 7, tools: {} })
  })

  test('an unbounded scope folds the whole family’s lifetime timing (self and subagents)', () => {
    const self = {
      counts: { turns: 3 },
      timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolCalls: 7, tools: {} },
    }
    const kid = {
      counts: { turns: 2 },
      timing: { wallMs: 30_000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
    }
    const row = rowOf({
      family: [self, kid] as unknown as ContextTimeline[],
      familyCost: COST,
      activity: { days: { '2026-09-16': { tokens: 5, requests: 1, cost: COST, turns: 9, wallMs: 999 } } },
    })
    const kpi = kpisOf([row], prices, 'usd')
    assert.equal(kpi.turns, 5)
    assert.equal(kpi.tokens, 200, 'usage rides familyCost without a scope and the ledger under the All preset')
    assert.deepEqual(kpi.timing, { wallMs: 120_000, ttftMs: 1_000, genMs: 30_000, calls: 6, toolsMs: 20_000, toolCalls: 7, tools: {} })
    assert.deepEqual(kpisOf([row], prices, 'usd', { start: null, end: null }), kpi, 'the All preset reads the same family timing')
  })

  test('a bounded scope scopes the volume by day but keeps the timing on the family heads', () => {
    const member = {
      cost: COST,
      counts: { turns: 9 },
      current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
      requests: [],
      timing: { wallMs: 120_000, ttftMs: 1_000, genMs: 30_000, calls: 5, toolsMs: 40_000, toolCalls: 6, tools: {} },
    } as unknown as ContextTimeline
    const kid = {
      timing: { wallMs: 30_000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 5_000, toolCalls: 2, tools: {} },
    } as unknown as ContextTimeline
    const activity: ContextActivity = {
      days: {
        '2026-09-16': { tokens: 5, requests: 1, cost: COST, turns: 1, toolCalls: 2, toolsMs: 30, wallMs: 100 },
        '2026-09-17': { tokens: 7, requests: 3, cost: COST, turns: 1, toolCalls: 4, toolsMs: 50, wallMs: 300 },
      },
    }
    const row = rowOf({ timeline: member, family: [member, kid], familyActivity: [activity, null], activity, familyCost: COST })
    const bare = rowOf({ activity: { days: { '2026-09-16': { tokens: 1, requests: 1 } } } })
    const scope = dayRangeWindow({ from: '2026-09-16', to: '2026-09-16' })
    assert.ok(scope !== null)
    const kpi = kpisOf([row, bare], prices, 'usd', scope)
    assert.equal(kpi.sessions, 2)
    assert.equal(kpi.tokens, 200, 'one admitted COST, not two')
    assert.equal(kpi.costSessions, 1)
    assert.equal(kpi.usageSessions, 1)
    assert.equal(kpi.turns, 1, 'the out-of-window turn is not counted')
    assert.equal(kpi.tokenParts?.total, 200)
    assert.equal(kpi.timing?.wallMs, 150_000)
    assert.equal(kpi.timing?.calls, 7)
    assert.equal(kpi.timing?.toolsMs, 45_000)
    assert.equal(kpi.timing?.toolCalls, 8)
  })

  test('a session with usage the book cannot price feeds the cache-hit rate but prices to nothing', () => {
    const rows = [
      rowOf({ timeline: { cost: COST, current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 }, requests: [] } as unknown as ContextTimeline, familyCost: COST }),
      rowOf({
        timeline: {
          cost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 1, output: 2 } } } },
          current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
          requests: [],
        } as unknown as ContextTimeline,
        familyCost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 1, output: 2 } } } },
      }),
      rowOf(),
    ]
    const kpi = kpisOf(rows, prices, 'usd')
    assert.equal(kpi.costSessions, 1, 'only the priced session counts toward the cost cell')
    assert.equal(kpi.usageSessions, 2, 'both billed sessions feed the cache-hit rate')
    assert.ok(kpi.cost !== null && Math.abs(kpi.cost - 390e-6) < 1e-12, 'the unpriced session adds nothing to the estimate')
    assert.equal(kpi.tokenParts?.total, 218, 'both sessions\' billed totals fold into the split')
    assert.equal(kpi.timing, null)
    const unbilled = kpisOf([rowOf()], null, 'cny')
    assert.equal(unbilled.tokens, 0)
    assert.equal(unbilled.turns, 0)
    assert.equal(unbilled.cost, null)
    assert.equal(unbilled.cacheHit, null)
    assert.equal(unbilled.costSessions, 0)
    assert.equal(unbilled.usageSessions, 0)
    assert.equal(unbilled.tokenParts, null)
    assert.equal(unbilled.timing, null, 'no timing aggregates to null, so the band dashes and the card shows its empty state')
  })

})

describe('aggregateDays', () => {
  const book = { prices: { deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }
  const FEE: SessionCostUsage = { deepseek: { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 50, cacheWrite: 0, output: 40 } } } }

  test('merges every row’s ledger, skipping rows without one', () => {
    const rows = [
      rowOf({ activity: { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-15': { tokens: 2, requests: 2 } } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 7, requests: 3 } } } }),
      rowOf(),
    ]
    assert.deepEqual(aggregateDays(rows, book, 'usd'), {
      '2026-09-16': { tokens: 12, requests: 4, sessions: 2, cost: null },
      '2026-09-15': { tokens: 2, requests: 2, sessions: 1, cost: null },
    })
    const zeroed = [
      rowOf({ activity: { days: { '2026-09-16': { tokens: 0, requests: 0 }, '2026-09-15': { tokens: 3, requests: 1 } } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 1, requests: 1 } } } }),
    ]
    assert.deepEqual(aggregateDays(zeroed, book, 'usd'), {
      '2026-09-16': { tokens: 1, requests: 1, sessions: 1, cost: null },
      '2026-09-15': { tokens: 3, requests: 1, sessions: 1, cost: null },
    }, 'a zeroed day entry is no activity: no session counted, no day made')
  })

  test('each day’s pricing records merge and price off the book; unpriced days and a missing book stay null', () => {
    const rows = [
      rowOf({ activity: { days: {
        '2026-09-16': { tokens: 5, requests: 1, cost: FEE },
        '2026-09-15': { tokens: 2, requests: 2 },
      } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 7, requests: 3, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 1 } } } } } } } }),
      rowOf({ activity: { days: { '2026-09-14': { tokens: 9, requests: 1, cost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 1 } } } } } } } }),
    ]
    const days = aggregateDays(rows, book, 'usd')
    assert.ok(Math.abs((days['2026-09-16'].cost ?? 0) - 376e-6) < 1e-12)
    assert.equal(days['2026-09-15'].cost, null, 'a day without pricing records prices to nothing')
    assert.equal(days['2026-09-14'].cost, null, 'a model the book cannot price prices to nothing')
    assert.equal(aggregateDays([rows[0]], null, 'cny')['2026-09-16'].cost, null, 'a day with no book prices to null')
  })
})

describe('DayAggregator', () => {
  test('incremental updates match a fresh pass through adds, changes, removals, and a book switch', () => {
    const book = { prices: { deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }
    const fee: SessionCostUsage = { deepseek: { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 50, cacheWrite: 0, output: 40 } } } }
    const a = rowOf({ activity: { days: { '2026-09-16': { tokens: 5, requests: 1, cost: fee }, '2026-09-15': { tokens: 2, requests: 2 } } } })
    const b = rowOf({ activity: { days: { '2026-09-16': { tokens: 7, requests: 3 } } } })
    const agg = new DayAggregator()
    const same = [a, b]
    const first = agg.aggregate(same, book, 'usd')
    assert.deepEqual(first, aggregateDays([a, b], book, 'usd'))
    assert.equal(agg.aggregate(same, book, 'usd'), first, 'the same inputs return the same object')
    const b2 = rowOf({ activity: { days: { '2026-09-16': { tokens: 9, requests: 4 } } } })
    const next = agg.aggregate([a, b2], book, 'usd')
    assert.deepEqual(next, aggregateDays([a, b2], book, 'usd'))
    const removed = agg.aggregate([b2], book, 'usd')
    assert.deepEqual(removed, aggregateDays([b2], book, 'usd'))
    const noBook = agg.aggregate([b2], null, 'usd')
    assert.deepEqual(noBook, aggregateDays([b2], null, 'usd'))
    const cny = agg.aggregate([b2], null, 'cny')
    assert.deepEqual(cny, aggregateDays([b2], null, 'cny'))
  })
})

describe('DayAggregator — hostile cost shapes and partial removals', () => {
  test('malformed cost branches drop and a partial removal keeps the surviving bucket', () => {
    const book = { prices: { deepseek: { m: { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { m: { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }
    const junkCost = { bad: 'x', deepseek: { m: 'bad' } } as unknown as SessionCostUsage
    const junk = rowOf({ activity: { days: { '2026-09-16': { tokens: 1, requests: 1, cost: junkCost } } } })
    const agg = new DayAggregator()
    assert.equal(agg.aggregate([junk], book, 'usd')['2026-09-16'].cost, null)
    const feeA: SessionCostUsage = { deepseek: { a: { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const feeB: SessionCostUsage = { deepseek: { b: { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const one = rowOf({ activity: { days: { '2026-09-16': { tokens: 2, requests: 1, cost: feeA } } } })
    const two = rowOf({ activity: { days: { '2026-09-16': { tokens: 3, requests: 1, cost: feeB } } } })
    const both = agg.aggregate([one, two], book, 'usd')
    assert.deepEqual(both, aggregateDays([one, two], book, 'usd'))
    const removed = agg.aggregate([two], book, 'usd')
    assert.deepEqual(removed, aggregateDays([two], book, 'usd'))
    assert.deepEqual(agg.aggregate([rowOf()], book, 'usd'), {})
  })
})

describe('DayAggregator — activity replacement and multi-period costs', () => {
  test('a replaced row subtracts its old ledger and a surviving period keeps the model branch', () => {
    const book = { prices: { deepseek: { m: { hit: 0.1, miss: 1, write: 1, out: 2 } } }, index: priceIndexOf({ deepseek: { m: { hit: 0.1, miss: 1, write: 1, out: 2 } } }, {}) }
    const actA = { days: { '2026-09-16': { tokens: 2, requests: 1 } } }
    const actB = { days: { '2026-09-16': { tokens: 5, requests: 2 } } }
    const r1 = rowOf({ activity: actA })
    const r2 = rowOf({ activity: actB })
    const agg = new DayAggregator()
    assert.deepEqual(agg.aggregate([r1], book, 'usd'), aggregateDays([r1], book, 'usd'))
    assert.deepEqual(agg.aggregate([r2], book, 'usd'), aggregateDays([r2], book, 'usd'))
    const peakAndOff: SessionCostUsage = { deepseek: { m: {
      peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 },
      off: { uncached: 50, cacheRead: 0, cacheWrite: 0, output: 0 },
    } } }
    const partial: SessionCostUsage = { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const full = rowOf({ activity: { days: { '2026-09-16': { tokens: 2, requests: 1, cost: peakAndOff } } } })
    const half = rowOf({ activity: { days: { '2026-09-16': { tokens: 3, requests: 1, cost: partial } } } })
    const both = agg.aggregate([full, half], book, 'usd')
    assert.deepEqual(both, aggregateDays([full, half], book, 'usd'))
    assert.deepEqual(agg.aggregate([half], book, 'usd'), aggregateDays([half], book, 'usd'))
  })
})

describe('DayAggregator — a reused row object with a new ledger', () => {
  test('the old ledger is subtracted before the new one is added', () => {
    const mutable = rowOf({ activity: { days: { '2026-09-16': { tokens: 2, requests: 1 } } } })
    const agg = new DayAggregator()
    agg.aggregate([mutable], null, 'usd')
    mutable.activity = { days: { '2026-09-16': { tokens: 5, requests: 2 } } }
    assert.deepEqual(agg.aggregate([mutable], null, 'usd'), { '2026-09-16': { tokens: 5, requests: 2, sessions: 1, cost: null } })
  })
})
