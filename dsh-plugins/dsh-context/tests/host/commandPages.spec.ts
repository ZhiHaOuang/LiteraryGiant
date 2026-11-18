import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { COMMANDS_ROUTE, watchCommandPageChannel } from '../../src/host/commandPages'
import { resolveBounds } from '../../src/host/config'
import type { TimelineEvent } from '../../src/host/foldState'
import { toolCall, toolResult } from './helpers/events'

const BOUNDS = resolveBounds({})

type RouteFetch = (request: Request) => Promise<Response>

interface Captured {
  path?: string
  fetch?: RouteFetch
}

interface CtxSpec {
  connection?: unknown
  sessionQuery?: unknown
  sessionPersistence?: unknown
}

function ctxOf(spec: CtxSpec): { ctx: Context; captured: Captured; disposers: (() => void)[] } {
  const captured: Captured = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  const ctx = {
    get: (name: string) => (name === 'sessionPersistence' ? spec.sessionPersistence : services.get(name)),
    effect(fn: () => unknown) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  const conn = spec.connection as { fetch?: { register?: unknown } } | undefined
  if (conn !== undefined && typeof conn.fetch?.register === 'function') {
    conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
      captured.path = route.path
      captured.fetch = route.fetch
      return () => {}
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

async function call(captured: Captured, body: unknown): Promise<unknown> {
  const request = new Request(`http://dsh.test${COMMANDS_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  return await captured.fetch!(request).then(r => r.json())
}

function bashCall(seq: number, callId: string, cmd: string): TimelineEvent {
  return toolCall(seq, { callId, name: 'bash', arguments: JSON.stringify({ command: cmd }) })
}

function bashResult(seq: number, callId: string, text: string): TimelineEvent {
  return toolResult(seq, { callId, content: [{ type: 'text', text }] })
}

function logOf(n: number): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (let i = 0; i < n; i++) {
    events.push(bashCall(2 * i + 1, `c${i}`, `cmd${i}`))
    events.push(bashResult(2 * i + 2, `c${i}`, 'ok'))
  }
  return events
}

function observationOf(events: readonly TimelineEvent[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'live',
    cursor: events.length === 0 ? -1 : events[events.length - 1].seq,
    events,
    [Symbol.dispose]: () => {},
    ...over,
  }
}

interface PageValue {
  ok: boolean
  value: { commands: Array<{ seq: number; cmd: string; status: string; resultSeq?: number }>; atStart: boolean; total: number } | null
  error?: { code: string }
}

function routeWith(
  observe: (id: string, options: unknown) => Promise<unknown>,
  persistence?: () => unknown,
): { captured: Captured; calls: unknown[] } {
  const calls: unknown[] = []
  const spec: CtxSpec = {
    connection: { fetch: { register: () => () => {} } },
    sessionQuery: {
      observeSession: (id: string, options: unknown) => {
        calls.push({ id, options })
        return observe(id, options)
      },
    },
  }
  if (persistence !== undefined) {
    Object.defineProperty(spec, 'sessionPersistence', { get: persistence, enumerable: true })
  }
  const { ctx, captured } = ctxOf(spec)
  watchCommandPageChannel(ctx, BOUNDS)
  return { captured, calls }
}

describe('watchCommandPageChannel gating', () => {
  test('the route stays unregistered without its faces or when the registry refuses', () => {
    const none = ctxOf({})
    watchCommandPageChannel(none.ctx, BOUNDS)
    assert.equal(none.captured.fetch, undefined)

    const connectionOnly = ctxOf({ connection: { fetch: { register: () => () => {} } } })
    watchCommandPageChannel(connectionOnly.ctx, BOUNDS)
    assert.equal(connectionOnly.captured.fetch, undefined)

    const noObserve = ctxOf({ connection: { fetch: { register: () => () => {} } }, sessionQuery: {} })
    watchCommandPageChannel(noObserve.ctx, BOUNDS)
    assert.equal(noObserve.captured.fetch, undefined)

    const rejecting = {
      get: (name: string) => (name === 'connection'
        ? { fetch: { register: () => { throw new Error('registration rejected') } } }
        : { observeSession: () => Promise.resolve(null) }),
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      inject(deps: string[], cb: (c: unknown) => unknown) {
        if (deps.every(d => d === 'connection' || d === 'sessionQuery')) cb(rejecting)
      },
    }
    assert.doesNotThrow(() => watchCommandPageChannel(rejecting as unknown as Context, BOUNDS))
  })

  test('registration opens the path and its effect disposer is collected', () => {
    const { ctx, captured, disposers } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { observeSession: () => Promise.resolve(null) },
    })
    watchCommandPageChannel(ctx, BOUNDS)
    assert.equal(captured.path, '/api/dsh-context/commands')
    assert.equal(disposers.length, 1)
    for (const d of disposers) d()
  })
})

describe('the command page route', () => {
  test('bad payloads fail with typed envelopes', async () => {
    const { captured } = routeWith(() => Promise.resolve(null))
    for (const body of [null, 42, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await call(captured, body) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `payload ${JSON.stringify(body)} rejected`)
      assert.equal(result.error?.code, 'dsh-context/bad-request')
    }
    const raw = await call(captured, 'not json') as { ok: boolean; error?: { code: string } }
    assert.equal(raw.error?.code, 'dsh-context/bad-request')
    for (const beforeSeq of [-1, 'later', Number.NaN, Infinity]) {
      const result = await call(captured, { sessionId: 's1', beforeSeq }) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `beforeSeq ${String(beforeSeq)} rejected`)
    }
  })

  test('a missing observation, an absent log and a skipped cold read all answer the typed null', async () => {
    const absent = routeWith(() => Promise.resolve(null))
    assert.deepEqual(await call(absent.captured, { sessionId: 's1' }), { ok: true, value: null })

    const noEvents = routeWith(() => Promise.resolve({ source: 'live', cursor: 0 }))
    assert.deepEqual(await call(noEvents.captured, { sessionId: 's1', beforeSeq: 5 }), { ok: true, value: null })

    const notAnObject = routeWith(() => Promise.resolve(42))
    assert.deepEqual(await call(notAnObject.captured, { sessionId: 's1' }), { ok: true, value: null })

    const noCursor = routeWith(() => Promise.resolve({ source: 'live' }))
    assert.deepEqual(((await call(noCursor.captured, { sessionId: 's1' })) as PageValue).value, { commands: [], atStart: true, total: 0 })

    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { observeSession: () => Promise.resolve(null) },
    })
    let admitted = 0
    watchCommandPageChannel(ctx, BOUNDS, {
      admit: <T>(_read: () => Promise<T>): Promise<T | undefined> => { admitted++; return Promise.resolve(undefined) },
    })
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
    assert.equal(admitted, 1)
  })

  test('a rejecting read answers the gateway error and the lease disposes', async () => {
    let disposed = 0
    const { captured } = routeWith(() => Promise.reject(new Error('persistence down')))
    const failed = await call(captured, { sessionId: 's1' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'gateway/internal')
    assert.equal(failed.error.message, 'persistence down')

    const lease = routeWith(() => Promise.resolve({
      ...observationOf(logOf(1)),
      [Symbol.dispose]: () => { disposed++ },
    }))
    const page = await call(lease.captured, { sessionId: 's1' }) as PageValue
    assert.equal(page.ok, true)
    assert.equal(disposed, 1, 'the observation lease disposed')
    const bare = routeWith(() => Promise.resolve({ source: 'live', cursor: 1, events: logOf(1) }))
    assert.equal(((await call(bare.captured, { sessionId: 's1' })) as PageValue).ok, true)

    const thrownString = routeWith(() => Promise.reject('persistence down'))
    const nonError = await call(thrownString.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(nonError.ok, false)
    assert.equal(nonError.error.message, 'persistence down')
  })

  test('pages walk backwards from the newest record and stop at the log head', async () => {
    const events = logOf(5)
    const { captured, calls } = routeWith(() => Promise.resolve(observationOf(events)))
    const newest = await call(captured, { sessionId: 's1', limit: 2 }) as PageValue
    assert.deepEqual(newest.value?.commands.map(c => c.seq), [7, 9])
    assert.equal(newest.value?.atStart, false)
    assert.equal(newest.value?.total, 5)
    assert.equal('call' in (newest.value?.commands[0] ?? {}), false, 'the pairing key stays off the wire')
    assert.deepEqual(calls, [{ id: 's1', options: { projectionMode: 'none' } }])

    const middle = await call(captured, { sessionId: 's1', beforeSeq: 7, limit: 2 }) as PageValue
    assert.deepEqual(middle.value?.commands.map(c => c.seq), [3, 5])
    assert.equal(middle.value?.atStart, false)

    const oldest = await call(captured, { sessionId: 's1', beforeSeq: 3, limit: 2 }) as PageValue
    assert.deepEqual(oldest.value?.commands.map(c => c.seq), [1])
    assert.equal(oldest.value?.atStart, true)

    const none = await call(captured, { sessionId: 's1', beforeSeq: 0 }) as PageValue
    assert.deepEqual(none.value, { commands: [], atStart: true, total: 5 })

    const all = await call(captured, { sessionId: 's1' }) as PageValue
    assert.deepEqual(all.value?.commands.map(c => c.seq), [1, 3, 5, 7, 9])
    assert.equal(all.value?.atStart, true)
  })

  test('the limit defaults to 400 and clamps to the 1..1000 range', async () => {
    const events = logOf(3)
    const { captured } = routeWith(() => Promise.resolve(observationOf(events)))
    const zero = await call(captured, { sessionId: 's1', limit: 0 }) as PageValue
    assert.equal(zero.value?.commands.length, 1)
    const string = await call(captured, { sessionId: 's1', limit: 'lots' }) as PageValue
    assert.equal(string.value?.commands.length, 3)
    const huge = await call(captured, { sessionId: 's1', limit: 50_000 }) as PageValue
    assert.equal(huge.value?.commands.length, 3)
  })

  test('a live log extends its cached fold without refolding the prefix', async () => {
    const events = logOf(2)
    let served: TimelineEvent[] = events.slice(0, 2)
    const { captured } = routeWith(() => Promise.resolve(observationOf(served)))
    const first = await call(captured, { sessionId: 's1' }) as PageValue
    assert.deepEqual(first.value?.commands.map(c => c.seq), [1])
    assert.equal(first.value?.total, 1)

    served = events
    const second = await call(captured, { sessionId: 's1' }) as PageValue
    assert.deepEqual(second.value?.commands.map(c => c.seq), [1, 3])
    assert.equal(second.value?.total, 2, 'the cached fold extended to the new cut')

    const same = await call(captured, { sessionId: 's1', beforeSeq: 3 }) as PageValue
    assert.deepEqual(same.value?.commands.map(c => c.seq), [1], 'an older page re-serves the cached fold')
  })

  test('a stored log re-serves a durable revision and refolds when it moves', async () => {
    const first = logOf(2)
    let events = first
    let revision = 'rev-1'
    const { captured } = routeWith(() => Promise.resolve(observationOf(events, { source: 'prepared', revision })))
    const a = await call(captured, { sessionId: 'cold1' }) as PageValue
    assert.deepEqual(a.value?.commands.map(c => c.seq), [1, 3])

    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 2, 'same revision reuses')

    events = logOf(1)
    revision = 'rev-2'
    const b = await call(captured, { sessionId: 'cold1' }) as PageValue
    assert.deepEqual(b.value?.commands.map(c => c.seq), [1])
    assert.equal(b.value?.total, 1, 'the moved revision refolded from the new log')
  })

  test('a swapped persistence identity never reuses a stored-log fold', async () => {
    let events = logOf(2)
    let backend: unknown = { name: 'a' }
    const { captured } = routeWith(
      () => Promise.resolve(observationOf(events, { source: 'prepared', revision: 'r1' })),
      () => backend,
    )
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 2)
    events = logOf(1)
    backend = { name: 'b' }
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 1, 'the swapped backend refolded')
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 1, 'the new identity reuses')
  })

  test('an unkeyed stored log refolds per read and a source switch never reuses a keyed fold', async () => {
    let events = logOf(1)
    const unkeyed = routeWith(() => Promise.resolve(observationOf(events, { source: 'prepared' })))
    assert.equal(((await call(unkeyed.captured, { sessionId: 's1' })) as PageValue).value?.total, 1)
    events = logOf(2)
    assert.equal(((await call(unkeyed.captured, { sessionId: 's1' })) as PageValue).value?.total, 2, 'unkeyed logs refold')

    for (const revision of ['', 42]) {
      const weird = routeWith(() => Promise.resolve(observationOf(logOf(1), { source: 'prepared', revision })))
      assert.equal(((await call(weird.captured, { sessionId: 's3' })) as PageValue).value?.total, 1, `revision ${String(revision)} is unkeyed`)
    }

    let served = logOf(2)
    let source: 'live' | 'prepared' = 'prepared'
    const keyed = routeWith(() => Promise.resolve(observationOf(served, { source, ...(source === 'prepared' ? { revision: 'r1' } : {}) })))
    assert.equal(((await call(keyed.captured, { sessionId: 's2' })) as PageValue).value?.total, 2)
    source = 'live'
    served = logOf(1)
    const live = await call(keyed.captured, { sessionId: 's2' }) as PageValue
    assert.equal(live.value?.total, 1, 'the live source rebuilt instead of reusing the prepared fold')
  })

  test('a cut that moves backwards or disagrees with the event array folds defensively', async () => {
    let events = logOf(2)
    const { captured } = routeWith(() => Promise.resolve(observationOf(events)))
    assert.equal(((await call(captured, { sessionId: 's1' })) as PageValue).value?.total, 2)
    events = logOf(1)
    assert.equal(((await call(captured, { sessionId: 's1' })) as PageValue).value?.total, 1, 'a shorter cut drops the cached fold')

    const overlong = routeWith(() => Promise.resolve({ source: 'live', cursor: 2, events: logOf(2) }))
    assert.equal(((await call(overlong.captured, { sessionId: 's1' })) as PageValue).value?.total, 2, 'the fold stops at the cursor')

    const truncated = routeWith(() => Promise.resolve({ source: 'live', cursor: 10, events: logOf(1) }))
    assert.equal(((await call(truncated.captured, { sessionId: 's1' })) as PageValue).value?.total, 1, 'a short array stops the fold')
  })

  test('three sessions trim the fold cache and a monster log yields per chunk', async () => {
    const events = logOf(1)
    const { captured } = routeWith(id => Promise.resolve(observationOf(events.slice(0, id === 'a' ? 0 : 2), { revision: `r-${id}` })))
    assert.equal(((await call(captured, { sessionId: 'a' })) as PageValue).value?.total, 0)
    assert.equal(((await call(captured, { sessionId: 'b' })) as PageValue).value?.total, 1)
    assert.equal(((await call(captured, { sessionId: 'c' })) as PageValue).value?.total, 1)

    const monster: TimelineEvent[] = []
    for (let seq = 1; seq <= 2_001; seq++) monster.push({ type: 'todo/write', seq, time: seq, data: {} })
    monster.push(bashCall(2_002, 'c1', 'echo hi'))
    monster.push(bashResult(2_003, 'c1', 'hi'))
    const big = routeWith(() => Promise.resolve(observationOf(monster)))
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const page = await call(big.captured, { sessionId: 'big' }) as PageValue
      assert.equal(page.value?.total, 1)
      const yields = timerSpy.mock.calls.filter(args => args[1] === 0).length
      assert.equal(yields, 2, 'two macrotask yields across 2,003 events')
    } finally {
      timerSpy.mockRestore()
    }
  })
})
