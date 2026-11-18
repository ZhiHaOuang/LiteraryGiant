import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings, overviewThresholdOf, type SettingsField, type SettingsScopeLike } from '../../src/client/settings'

class TestSettingsScope implements SettingsScopeLike {
  private snapshot: { status: string; value: unknown; writable: boolean }
  private readonly listeners = new Set<() => void>()
  readonly sets: { field: string; value: unknown }[] = []

  constructor(snapshot: { status: string; value: unknown; writable: boolean }) {
    this.snapshot = snapshot
  }

  getSnapshot(): { status: string; value: unknown; writable: boolean } {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  failSet = false

  set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value })
    return this.failSet ? Promise.reject(new Error('write failed')) : Promise.resolve()
  }

  emit(snapshot: { status: string; value: unknown; writable: boolean }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

describe('createContextSettings defaults', () => {
  test('starts loading with schema defaults and not writable', () => {
    const s = createContextSettings()
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'loading',
      placement: 'all',
      granularity: 'step',
      mode: 'total',
      deltaBase: 'step',
      toolSort: 'count',
      fileSort: 'lines',
      insightsEntry: 'show',
      durationCurve: 'show',
      overviewAutoSteps: '100',
      overviewRange: '30d',
      fleetTab: 'show',
      promptPrefix: '',
      promptSuffix: '',
      writable: false,
    })
  })
})

describe('overviewThresholdOf', () => {
  test('maps the numeric steps to a threshold and off to null', () => {
    assert.equal(overviewThresholdOf('100'), 100)
    assert.equal(overviewThresholdOf('200'), 200)
    assert.equal(overviewThresholdOf('300'), 300)
    assert.equal(overviewThresholdOf('off'), null)
  })
})

describe('store', () => {
  test('subscribers are notified on change and unsubscribe stops', () => {
    const s = createContextSettings()
    let calls = 0
    const unsubscribe = s.store.subscribe(() => { calls++ })
    s.set('defaultTrendMode', 'delta')
    assert.equal(calls, 1)
    assert.equal(s.store.getSnapshot().mode, 'delta')
    unsubscribe()
    s.set('defaultTrendMode', 'total')
    assert.equal(calls, 1)
  })
})

describe('set', () => {
  test('without attach it echoes locally; the hidden placement serves from the scope and a pick; no-ops stay silent', () => {
    const s = createContextSettings()
    s.set('defaultGranularity', 'turn')
    assert.equal(s.defaultGranularity(), 'turn')
    s.set('defaultPlacement', 'sidebar')
    assert.equal(s.defaultPlacement(), 'sidebar')
    s.set('defaultDeltaBase', 'turn')
    assert.equal(s.defaultDeltaBase(), 'turn')
    s.set('promptPrefix', 'Be terse.')
    assert.equal(s.store.getSnapshot().promptPrefix, 'Be terse.')
    s.set('overviewAutoSteps', 'off')
    assert.equal(s.overviewAutoSteps(), 'off')
    s.set('defaultOverviewRange', 'today')
    assert.equal(s.defaultOverviewRange(), 'today')
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultPlacement: 'hide' }, writable: true }))
    assert.equal(s.defaultPlacement(), 'hide')
    s.set('defaultPlacement', 'all')
    assert.equal(s.defaultPlacement(), 'all')
    s.set('defaultPlacement', 'hide')
    assert.equal(s.defaultPlacement(), 'hide')

    const unchanged = createContextSettings()
    let calls = 0
    unchanged.store.subscribe(() => { calls++ })
    unchanged.set('defaultGranularity', 'step')
    assert.equal(calls, 0)
    unchanged.set('defaultGranularity', 'bogus')
    assert.equal(unchanged.defaultGranularity(), 'step')
    assert.equal(calls, 0)
  })

  test('with attach it echoes locally and writes through the scope', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    s.set('defaultTrendMode', 'delta')
    assert.equal(s.defaultTrendMode(), 'delta')
    assert.deepEqual(scope.sets, [{ field: 'defaultTrendMode', value: 'delta' }])
  })

  test('a rejected scope write settles handled and rolls the echo back to the scope truth', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultTrendMode: 'total' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('defaultTrendMode', 'delta')
    assert.equal(s.defaultTrendMode(), 'delta', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.defaultTrendMode(), 'total', 'the echo rolls back to the scope truth')
  })

  test('a rejected gate write echoes first, then degrades without a scope truth or rolls back to one', async () => {
    const cases: [SettingsField, string, string | undefined, string, (s: ReturnType<typeof createContextSettings>) => string][] = [
      ['defaultPlacement', 'sidebar', undefined, 'all', s => s.defaultPlacement()],
      ['defaultPlacement', 'tab', 'sidebar', 'sidebar', s => s.defaultPlacement()],
      ['insightsEntry', 'hide', undefined, 'show', s => s.insightsEntry()],
      ['insightsEntry', 'show', 'hide', 'hide', s => s.insightsEntry()],
      ['fleetTab', 'hide', undefined, 'show', s => s.fleetTab()],
      ['fleetTab', 'show', 'hide', 'hide', s => s.fleetTab()],
    ]
    for (const [field, picked, truth, expected, read] of cases) {
      const s = createContextSettings()
      const scope = new TestSettingsScope({ status: 'ready', value: truth === undefined ? {} : { [field]: truth }, writable: true })
      s.attach(scope)
      scope.failSet = true
      s.set(field, picked)
      assert.equal(read(s), picked, `${field}: the optimistic echo lands first`)
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(read(s), expected, `${field}: the refused echo settles`)
    }
  })

  test('a rejected non-gate write keeps a preference the scope does not carry, or rolls back to its truth', async () => {
    const kept = createContextSettings()
    const emptyScope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    kept.attach(emptyScope)
    emptyScope.failSet = true
    kept.set('defaultFileSort', 'path')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(kept.defaultFileSort(), 'path', 'the in-session choice survives')

    const rolled = createContextSettings()
    const promptScope = new TestSettingsScope({ status: 'ready', value: { promptPrefix: 'kept' }, writable: true })
    rolled.attach(promptScope)
    promptScope.failSet = true
    rolled.set('promptPrefix', 'draft')
    assert.equal(rolled.store.getSnapshot().promptPrefix, 'draft', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(rolled.store.getSnapshot().promptPrefix, 'kept', 'the echo rolls back to the scope truth')
  })
})

describe('attach', () => {
  test('syncs a ready snapshot with parsed preferences', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: {
        defaultPlacement: 'sidebar',
        defaultGranularity: 'turn',
        defaultTrendMode: 'delta',
        defaultDeltaBase: 'turn',
        defaultToolSort: 'name',
        defaultFileSort: 'path',
        insightsEntry: 'hide',
        defaultDurationCurve: 'hide',
        overviewAutoSteps: '300',
        defaultOverviewRange: '7d',
        fleetTab: 'hide',
        promptPrefix: 'Be terse.',
        promptSuffix: 'Sign as Atlas.',
      },
      writable: true,
    })
    s.attach(scope)
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      placement: 'sidebar',
      granularity: 'turn',
      mode: 'delta',
      deltaBase: 'turn',
      toolSort: 'name',
      fileSort: 'path',
      insightsEntry: 'hide',
      durationCurve: 'hide',
      overviewAutoSteps: '300',
      overviewRange: '7d',
      fleetTab: 'hide',
      promptPrefix: 'Be terse.',
      promptSuffix: 'Sign as Atlas.',
      writable: true,
    })
    const defaults = createContextSettings()
    defaults.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'all', defaultGranularity: 'step', defaultTrendMode: 'total', defaultDeltaBase: 'step', defaultToolSort: 'count', defaultFileSort: 'lines', insightsEntry: 'show', overviewAutoSteps: '200', defaultOverviewRange: 'all' },
      writable: false,
    }))
    assert.equal(defaults.defaultPlacement(), 'all')
    assert.equal(defaults.defaultGranularity(), 'step')
    assert.equal(defaults.defaultTrendMode(), 'total')
    assert.equal(defaults.defaultDeltaBase(), 'step')
    assert.equal(defaults.defaultToolSort(), 'count')
    assert.equal(defaults.defaultFileSort(), 'lines')
    assert.equal(defaults.insightsEntry(), 'show')
    assert.equal(defaults.overviewAutoSteps(), '200')
    assert.equal(defaults.defaultOverviewRange(), 'all')
  })

  test('an unavailable snapshot keeps parsed preferences; any other status reads as loading', () => {
    const unavailable = createContextSettings()
    unavailable.attach(new TestSettingsScope({ status: 'unavailable', value: {}, writable: false }))
    assert.equal(unavailable.store.getSnapshot().status, 'unavailable')
    const pending = createContextSettings()
    pending.attach(new TestSettingsScope({ status: 'pending', value: {}, writable: false }))
    assert.equal(pending.store.getSnapshot().status, 'loading')
  })

  test('null/non-object section values keep the defaults', () => {
    for (const value of [null, 42]) {
      const s = createContextSettings()
      s.attach(new TestSettingsScope({ status: 'ready', value, writable: false }))
      assert.deepEqual(s.store.getSnapshot(), {
        status: 'ready',
        placement: 'all',
        granularity: 'step',
        mode: 'total',
        deltaBase: 'step',
        toolSort: 'count',
        fileSort: 'lines',
        insightsEntry: 'show',
        durationCurve: 'show',
        overviewAutoSteps: '100',
        overviewRange: '30d',
        fleetTab: 'show',
        promptPrefix: '',
        promptSuffix: '',
        writable: false,
      })
    }
  })

  test('invalid preference values keep the defaults', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'window', defaultGranularity: 'bogus', defaultTrendMode: 7, defaultDeltaBase: 'bogus', defaultToolSort: 'alpha', defaultFileSort: 'alpha', insightsEntry: 42, defaultDurationCurve: 'always', overviewAutoSteps: 200, defaultOverviewRange: 'week', fleetTab: 7, promptPrefix: 9, promptSuffix: {} },
      writable: false,
    }))
    assert.equal(s.defaultPlacement(), 'all')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultDeltaBase(), 'step')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'lines')
    assert.equal(s.insightsEntry(), 'show')
    assert.equal(s.defaultDurationCurve(), 'show')
    assert.equal(s.overviewAutoSteps(), '100')
    assert.equal(s.defaultOverviewRange(), '30d')
    assert.equal(s.fleetTab(), 'show')
    assert.equal(s.store.getSnapshot().promptPrefix, '', 'a non-string prompt value degrades to the empty default')
    assert.equal(s.store.getSnapshot().promptSuffix, '')
  })

  test('an invalid scope value degrades a gate to its default instead of keeping the current one', () => {
    const cases: [SettingsField, string, unknown, string, () => string][] = [
      ['defaultPlacement', 'tab', 42, 'all', () => s.defaultPlacement()],
      ['insightsEntry', 'hide', 'visible', 'show', () => s.insightsEntry()],
      ['defaultDurationCurve', 'hide', 'always', 'show', () => s.defaultDurationCurve()],
      ['overviewAutoSteps', '200', '50', '100', () => s.overviewAutoSteps()],
      ['defaultOverviewRange', '7d', 'quarter', '30d', () => s.defaultOverviewRange()],
    ]
    let s = createContextSettings()
    for (const [field, prior, invalid, expected, read] of cases) {
      s = createContextSettings()
      s.set(field, prior)
      assert.notEqual(read(), expected, field)
      s.attach(new TestSettingsScope({ status: 'ready', value: { [field]: invalid }, writable: false }))
      assert.equal(read(), expected, field)
    }
  })

  test('missing fields keep the current state', () => {
    const s = createContextSettings()
    s.set('defaultPlacement', 'tab')
    s.set('defaultToolSort', 'size')
    s.set('insightsEntry', 'hide')
    s.set('defaultDurationCurve', 'hide')
    s.set('overviewAutoSteps', '100')
    s.set('defaultOverviewRange', 'today')
    s.set('promptPrefix', 'drafted')
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultFileSort: 'latest' }, writable: false }))
    assert.equal(s.defaultPlacement(), 'tab', 'the in-session choice survives a section without the field')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultToolSort(), 'size', 'the in-session tool sort survives a section without the field')
    assert.equal(s.defaultFileSort(), 'latest')
    assert.equal(s.insightsEntry(), 'hide', 'the in-session entry choice survives a section without the field')
    assert.equal(s.defaultDurationCurve(), 'hide', 'the in-session curve choice survives a section without the field')
    assert.equal(s.overviewAutoSteps(), '100', 'the in-session auto-overview choice survives a section without the field')
    assert.equal(s.defaultOverviewRange(), 'today', 'the in-session overview range survives a section without the field')
    assert.equal(s.store.getSnapshot().promptPrefix, 'drafted', 'the in-session prompt text survives a section without the field')
  })

  test('scope updates republish to subscribers', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    assert.equal(calls, 1)
    assert.equal(s.defaultGranularity(), 'turn')
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultTrendMode: 'delta' }, writable: true })
    assert.equal(calls, 2)
    assert.equal(s.defaultTrendMode(), 'delta')
    scope.emit({ status: 'ready', value: { defaultFileSort: 'path' }, writable: false })
    assert.equal(calls, 3)
    assert.equal(s.store.getSnapshot().writable, false)
    scope.emit({ status: 'ready', value: { defaultFileSort: 'name' }, writable: false })
    assert.equal(calls, 4)
    assert.equal(s.defaultFileSort(), 'name')
  })

  test('an identical scope snapshot does not notify listeners', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: { defaultGranularity: 'turn', defaultFileSort: 'latest' },
      writable: true,
    })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultFileSort: 'latest' }, writable: true })
    assert.equal(calls, 0)
  })

  test('the disposer detaches its scope subscription; a later set never reaches the dead scope; a superseded attach keeps the newer scope', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detach = s.attach(scope)
    detach()
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    assert.equal(calls, 0)
    assert.equal(s.defaultGranularity(), 'step')
    s.set('defaultTrendMode', 'delta')
    assert.deepEqual(scope.sets, [])

    const first = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const second = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detachFirst = s.attach(first)
    s.attach(second)
    detachFirst()
    s.set('defaultFileSort', 'path')
    assert.deepEqual(first.sets, [])
    assert.deepEqual(second.sets, [{ field: 'defaultFileSort', value: 'path' }])
  })

  test('a snapshot value that throws on property access keeps the current state', () => {
    const s = createContextSettings()
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    s.attach(new TestSettingsScope({ status: 'ready', value: hostile, writable: true }))
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      placement: 'all',
      granularity: 'step',
      mode: 'total',
      deltaBase: 'step',
      toolSort: 'count',
      fileSort: 'lines',
      insightsEntry: 'show',
      durationCurve: 'show',
      overviewAutoSteps: '100',
      overviewRange: '30d',
      fleetTab: 'show',
      promptPrefix: '',
      promptSuffix: '',
      writable: true,
    })
  })
})
