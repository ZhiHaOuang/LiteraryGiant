import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeAgentHeads, makeHeadFetcher } from '../../src/client/agentHeads'

function headResponse(model = 'deepseek-v4-flash'): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      value: { rev: 1, head: { ok: true, current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 0, total: 10 }, model } },
    }),
  }
}

describe('makeHeadFetcher', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('head-only bodies re-prove the served head; absent, failed, and malformed reads resolve null or reject', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return headResponse()
    })
    const head = await makeHeadFetcher('s1')!()
    assert.deepEqual(bodies, [{ sessionId: 's1', head: true }])
    assert.equal(head?.model, 'deepseek-v4-flash')
    assert.equal(head?.current.total, 10)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    assert.equal(await makeHeadFetcher('s1')!(), null)
    assert.equal(makeHeadFetcher(''), undefined)
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    await assert.rejects(makeHeadFetcher('s1')!())
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { rev: 1, head: 7 } }),
    }))
    await assert.rejects(makeHeadFetcher('s1')!(), /malformed/)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(makeHeadFetcher('s1')!())
  })
})

describe('makeAgentHeads', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('one read per id replays the cached promise; the map is bounded; a rejected read still caches', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return headResponse()
    })
    const heads = makeAgentHeads()
    const first = heads.headOf('s1')
    assert.ok(await first !== null)
    assert.ok(heads.headOf('s1') === first, 'the cached promise replays')
    assert.deepEqual(bodies, [{ sessionId: 's1', head: true }])
    for (let i = 0; i < 130; i++) void heads.headOf(`bounded-${i}`)
    const refetched: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      refetched.push((JSON.parse(init.body) as { sessionId: string }).sessionId)
      return headResponse()
    })
    await heads.headOf('bounded-129')
    await heads.headOf('bounded-0')
    assert.deepEqual(refetched, ['bounded-0'], 'only the demoted oldest id refetched')
    const newer = heads.headOf('bounded-129')
    assert.ok(newer === heads.headOf('bounded-129'), 'the newest stays cached')

    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      throw new Error('down')
    })
    const broken = makeAgentHeads()
    await broken.headOf('bad').catch(() => null)
    await broken.headOf('bad').catch(() => null)
    assert.equal(calls, 1, 'a broken session never hammers the route')
  })
})

import { act, createElement as h } from 'react'
import { useSessionsSnapshot } from '../../src/client/agentHeads'
import type { SessionsFaceLike } from '../../src/client/agentTree'
import { mount } from './helpers/kit'

describe('useSessionsSnapshot coalescing', () => {
  test('one trailing notification per window while the snapshot read stays latest-wins', async () => {
    vi.useFakeTimers()
    let snapshot: unknown = { ids: ['a'] }
    const listeners = new Set<() => void>()
    const face: SessionsFaceLike = {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      },
    }
    const box: { current: unknown } = { current: null }
    let renders = 0
    function Probe(): null {
      renders++
      box.current = useSessionsSnapshot(face, 50)
      return null
    }
    const m = await mount(h(Probe))
    assert.deepEqual(box.current, { ids: ['a'] })
    const before = renders
    snapshot = { ids: ['a', 'b'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.deepEqual(box.current, { ids: ['a'] }, 'the urgent render keeps the old snapshot')
    snapshot = { ids: ['a', 'b', 'c'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.equal(renders, before, 'notifications coalesce before the window')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    assert.deepEqual(box.current, { ids: ['a', 'b', 'c'] }, 'the trailing read serves the latest snapshot')
    await m.unmount()
    vi.useRealTimers()
  })

  test('an uncoalesced face notifies immediately; unmount clears an armed window', async () => {
    vi.useFakeTimers()
    let snapshot: unknown = { ids: [] }
    const listeners = new Set<() => void>()
    const face: SessionsFaceLike = {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      },
    }
    const box: { current: unknown } = { current: null }
    function Probe(props: { ms?: number }): null {
      box.current = useSessionsSnapshot(face, props.ms)
      return null
    }
    const m = await mount(h(Probe, null))
    snapshot = { ids: ['x'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.deepEqual(box.current, { ids: ['x'] })
    await m.update(h(Probe, { ms: 100 }))
    snapshot = { ids: ['y'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.deepEqual(box.current, { ids: ['x'] }, 'the window holds')
    await m.unmount()
    await vi.advanceTimersByTimeAsync(200)
    assert.equal(listeners.size, 0)
    vi.useRealTimers()
  })
})
