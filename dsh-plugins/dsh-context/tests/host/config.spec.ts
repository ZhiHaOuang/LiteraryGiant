import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { Config, DEFAULT_BOUNDS, resolveBounds, volatileField } from '../../src/host/config'

function deref(value: unknown): unknown {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
}

describe('Config validator (cordis Standard Schema face)', () => {
  test('an absent config resolves to defaults; each bounds field overrides independently', () => {
    const resolved = Config(undefined) as unknown as Record<string, unknown>
    const resolvedPrefs = Object.fromEntries(
      Object.entries(resolved).map(([key, value]) => [key, deref(value)]),
    )
    assert.deepEqual(resolvedPrefs, {
      ...DEFAULT_BOUNDS,
      defaultPlacement: 'all',
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultDeltaBase: 'step',
      defaultToolSort: 'count',
      defaultFileSort: 'lines',
      insightsEntry: 'show',
      defaultDurationCurve: 'show',
      overviewAutoSteps: '100',
      defaultOverviewRange: '30d',
      fleetTab: 'show',
      promptPrefix: '',
      promptSuffix: '',
    })
    assert.deepEqual(resolveBounds(undefined), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds({}), DEFAULT_BOUNDS)
    assert.equal(resolveBounds({ maxRequestSteps: 7 }).maxRequestSteps, 7)
    assert.equal(resolveBounds({ maxKeptTurns: 7 }).maxKeptTurns, 7)
    assert.equal(resolveBounds({ maxEvents: 7 }).maxEvents, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxNodes, 7)
    assert.equal(resolveBounds({ maxArchiveNodes: 7 }).maxArchiveNodes, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxEvents, DEFAULT_BOUNDS.maxEvents)
  })

  test('rejects bounds below 1, non-integers, and non-numbers', () => {
    assert.throws(() => Config({ maxRequestSteps: 0 }))
    assert.throws(() => Config({ maxNodes: -1 }))
    assert.throws(() => Config({ maxEvents: 1.5 }))
    assert.throws(() => Config({ maxKeptTurns: '300' } as unknown as Config))
  })

  test('unknown keys merge through (schemastery objects are not key-strict)', () => {
    assert.equal(deref(Config({ unknown: 1 } as unknown as Config).maxEvents), DEFAULT_BOUNDS.maxEvents)
  })
})

describe('preference fields (the Config-form generation surface)', () => {
  test('every preference is volatile-marked; the bounds are not', () => {
    const dict = Config.dict ?? {}
    for (const pref of ['defaultPlacement', 'defaultGranularity', 'defaultTrendMode', 'defaultDeltaBase', 'defaultToolSort', 'defaultFileSort', 'insightsEntry', 'defaultDurationCurve', 'overviewAutoSteps', 'defaultOverviewRange', 'fleetTab', 'promptPrefix', 'promptSuffix']) {
      assert.equal((dict[pref] as z['dict'] extends undefined ? never : { meta?: { volatile?: boolean } }).meta?.volatile, true, pref)
    }
    for (const bound of ['maxRequestSteps', 'maxKeptTurns', 'maxEvents', 'maxNodes', 'maxArchiveNodes', 'maxFileOps']) {
      assert.notEqual((dict[bound] as { meta?: { volatile?: boolean } }).meta?.volatile, true, bound)
    }
  })

  test('preferences resolve to defaults, stale values degrade, and stored values survive', () => {
    const resolved = Config({ defaultGranularity: 'bogus', overviewAutoSteps: '50', defaultOverviewRange: 'bogus', promptPrefix: 7, promptSuffix: {} } as unknown as Config)
    assert.equal(deref(resolved.defaultGranularity), 'step')
    assert.equal(deref(resolved.overviewAutoSteps), '100')
    assert.equal(deref(resolved.defaultOverviewRange), '30d')
    assert.equal(deref(resolved.promptPrefix), '', 'a non-string prompt value degrades to the empty default')
    assert.equal(deref(resolved.promptSuffix), '')
    const stored = Config({ defaultPlacement: 'hide', defaultFileSort: 'count', insightsEntry: 'hide', overviewAutoSteps: 'off', defaultOverviewRange: '7d', fleetTab: 'hide', promptPrefix: 'Be terse.', promptSuffix: 'Sign as Atlas.' }) as unknown as Record<string, unknown>
    assert.deepEqual(
      ['defaultPlacement', 'defaultFileSort', 'insightsEntry', 'overviewAutoSteps', 'defaultOverviewRange', 'fleetTab', 'promptPrefix', 'promptSuffix'].map(key => deref(stored[key])),
      ['hide', 'count', 'hide', 'off', '7d', 'hide', 'Be terse.', 'Sign as Atlas.'],
    )
  })
})

describe('volatileField', () => {
  test('marks the field where schemastery ships the modifier; returns it unchanged on an older schemastery', () => {
    assert.equal(volatileField(z.union(['a', 'b']).default('a')).meta?.volatile, true)
    const plain = z.union(['a', 'b']).default('a')
    const legacy = { meta: plain.meta } as typeof plain
    assert.equal(volatileField(legacy), legacy)
    assert.equal(legacy.meta?.volatile, undefined)
  })
})
