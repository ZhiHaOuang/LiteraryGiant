import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BACKFILL_ROUTE, watchActivityBackfill } from '../../src/host/backfill'
import { arm, captureLogs, coldFaces, connectionOf, fakeState, trigger, unsupportedFormatError, until } from './helpers/backfill'
import type { RouteBox } from './helpers/backfill'

const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('watchActivityBackfill', () => {
  test('without a connection route, or with a half that never registers, the pass stays unarmed', async () => {
    const bare = new Context()
    const bareState = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    coldFaces(bare, bareState)
    const disposeBare = watchActivityBackfill(bare)
    await settle()
    disposeBare()
    assert.deepEqual(bareState.coldReads, [], 'no trigger route — no cold read')
    for (const connection of [
      { notFetch: true },
      { fetch: { notRegister: true } },
      { fetch: { register: () => { throw new Error('registry hostile') } } },
    ]) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      ctx.provide('connection', connection)
      coldFaces(ctx, state)
      const dispose = watchActivityBackfill(ctx)
      await settle()
      dispose()
      assert.deepEqual(state.coldReads, [], 'a route half that never registers leaves the pass unarmed')
    }
  })

  test('incomplete faces are re-proved away — an armed request waits, then never launches', async () => {
    for (const [label, overrides] of [
      ['query without listSessions', { sessionQuery: { notListSessions: true } }],
      ['cache without cachedSnapshot', { sessionProjectionCache: { coldSnapshot: () => ({}) } }],
      ['cache without coldSnapshot', { sessionProjectionCache: { cachedSnapshot: () => undefined } }],
      ['persistence without open', { sessionPersistence: { notOpen: true } }],
      ['non-record faces', { sessionQuery: 7, sessionProjectionCache: 7, sessionPersistence: 7 }],
    ] as const) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      const route: RouteBox = {}
      ctx.provide('connection', connectionOf(route))
      coldFaces(ctx, state, overrides)
      const dispose = watchActivityBackfill(ctx)
      await trigger(route)
      await settle(20)
      dispose()
      assert.deepEqual(state.coldReads, [], label)
    }
  })

  test('the probe passes its keys: a served row skips the cold read while a version-stale activity-only row refolds', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'b', cwd: '/repo/b' } },
      { header: { id: 'stale', cwd: '/repo/stale' } },
    ])
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: (header: { id: string }, keys?: unknown) => {
          assert.ok(Array.isArray(keys), 'the probe passes the keys as the second argument')
          if (header.id === 'b') return { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
          if (header.id === 'stale') return { asOfSeq: 0, values: { contextActivity: { days: {} } } }
          return undefined
        },
        coldSnapshot: (header: { id: string }) => {
          state.coldSnapshots.push(header.id)
          return {}
        },
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the stale session refolded')
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads, ['stale'], 'the served row skips the cold read; the version-stale timeline row does not')
    assert.deepEqual(state.coldSnapshots, ['stale'])
  })

  test('a non-array listing ends the run without work', async () => {
    const ctx = new Context()
    const state = fakeState({ not: 'an array' })
    let listed = 0
    const route = arm(ctx, state, {
      sessionQuery: { listSessions: async () => { listed++; return state.listed } },
    })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed === 1 ? true : undefined), 'the corpus was listed')
    await settle()
    dispose()
    assert.deepEqual(state.coldReads, [])
    assert.deepEqual(state.coldSnapshots, [])
    assert.deepEqual(lines.filter(l => l.text.includes('backfilled')), [], 'a non-list answer ends the pass without a fold line')
  })

  test('a fully-served corpus folds nothing and logs no backfilled line', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    state.served.add('a')
    let listed = 0
    const route = arm(ctx, state, {
      sessionQuery: { listSessions: async () => { listed++; return state.listed } },
    })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed === 1 ? true : undefined), 'the corpus was listed')
    await settle(60)
    dispose()
    assert.deepEqual(state.coldReads, [], 'nothing was read')
    assert.deepEqual(state.coldSnapshots, [], 'nothing was folded')
    assert.deepEqual(lines.filter(l => l.text.includes('backfilled')), [], 'the served row suppresses the fold count line')
  })

  test('an admission refused from the first read folds nothing and logs exactly one heap-pressure line', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'b', cwd: '/repo/b' } },
    ])
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx, { admit: () => Promise.resolve(undefined) })
    await trigger(route)
    await until(() => (lines.some(l => l.text.includes('heap pressure')) ? true : undefined), 'the early-stop line')
    await settle(20)
    dispose()
    assert.deepEqual(state.coldReads, [], 'nothing was read')
    assert.deepEqual(state.coldSnapshots, [], 'nothing was folded')
    assert.equal(lines.filter(l => l.text.includes('heap pressure')).length, 1, 'one line, not one per session')
    assert.deepEqual(lines.filter(l => l.text.includes('backfilled')), [], 'no fold, no fold count line')
  })

  test('a throwing cachedSnapshot probe reads as not-served and backfills a hostile read answer', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: () => { throw new Error('identity mismatch') },
        coldSnapshot: (header: { id: string }) => {
          state.coldSnapshots.push(header.id)
          return {}
        },
      },
      sessionPersistence: {
        open: async (id: string) => ({
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: 'garbage' }),
          close: async () => {},
        }),
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the fold ran')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('sessions missing their row get one cold read each; served, live, and malformed ones skip', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'e' } },
      { header: { id: '' } },
      { header: 7 },
      null,
      { header: { id: 'b', cwd: '/repo/b' } },
      { header: { id: 'd', cwd: '/repo/d' } },
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'c', cwd: '/repo/c' } },
    ])
    state.served.add('b')
    state.live.add('d')
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length >= 2 ? true : undefined), 'two cold folds')
    await settle(60)
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['a', 'c'])
    assert.deepEqual(state.coldSnapshots.sort(), ['a', 'c'])
  })

  test('failures stay per-session: a generic error and a hostile error warn, migration refusals drop to ONE debug summary', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'bad', cwd: '/repo/bad' } },
      { header: { id: 'legacy-1', cwd: '/repo/legacy-1' } },
      { header: { id: 'legacy-2', cwd: '/repo/legacy-2' } },
      { header: { id: 'hostile', cwd: '/repo/hostile' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    state.failReads.set('bad', new Error('no such session bad'))
    state.failReads.set('legacy-1', unsupportedFormatError('SessionFormatUnsupportedError'))
    state.failReads.set('legacy-2', unsupportedFormatError('SessionFormatUnsupportedMigrationError'))
    state.failReads.set('hostile', {
      get name(): string { throw new Error('no name for you') },
      toString(): string { throw new Error('no string for you') },
    })
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    await until(() => (lines.filter(l => l.level === 'info').length >= 2 ? true : undefined), 'the summary lines landed')
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['bad', 'good', 'hostile', 'legacy-1', 'legacy-2'])
    assert.deepEqual(state.coldSnapshots, ['good'])
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 2, 'the generic and the hostile failure each keep their own warn')
    assert.ok(warns.some(w => /"bad"/.test(w.text)))
    assert.ok(warns.some(w => /unprintable error/.test(w.text)))
    assert.deepEqual(lines.filter(l => l.level === 'warn').filter(l => /legacy/.test(l.text)), [], 'a migration refusal never warns')
    const debugs = lines.filter(l => l.level === 'debug')
    assert.equal(debugs.length, 2, 'each refused session keeps a debug detail')
    const infos = lines.filter(l => l.level === 'info')
    assert.equal(infos.length, 2, 'the folded count and ONE skip summary for the whole pass')
    assert.match(infos[0].text, /backfilled for 1 session\(s\)/)
    assert.match(infos[1].text, /skipped 2 session\(s\)/)
    assert.match(infos[1].text, /sources left unchanged/)
  })

  test('a mid-read failure closes the handle (a close failure adds nothing) and the run continues', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'torn', cwd: '/repo/torn' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    let closes = 0
    const route = arm(ctx, state, {
      sessionPersistence: {
        open: async (id: string) => ({
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: id === 'torn'
            ? async () => { throw new Error('torn tail') }
            : async () => ({ events: [] }),
          close: async () => {
            closes++
            if (id === 'torn') throw new Error('close failed too')
          },
        }),
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    dispose()
    assert.equal(closes, 2, 'both handles closed — the torn one before the error propagated')
    assert.deepEqual(state.coldSnapshots, ['good'])
  })

  test('the route answers ok and every hit after the first is a no-op (one pass per process)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    let listed = 0
    const route = arm(ctx, state, {
      sessionQuery: {
        listSessions: async () => {
          listed++
          return state.listed
        },
      },
    })
    const dispose = watchActivityBackfill(ctx)
    const first = await trigger(route)
    assert.equal(route.path, BACKFILL_ROUTE)
    assert.deepEqual(await first.json(), { ok: true })
    await until(() => (listed === 1 ? true : undefined), 'the first pass listed the corpus')
    const second = await trigger(route)
    assert.deepEqual(await second.json(), { ok: true })
    await settle()
    assert.equal(listed, 1, 'the second POST is a no-op')
    assert.deepEqual(state.coldReads, ['a'])
    dispose()
  })

  test('a route hit BEFORE the cold-path faces compose still launches the pass (either half first)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    coldFaces(ctx, state)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the delayed pass ran')
    dispose()
    assert.deepEqual(state.coldReads, ['a'])
  })

  test('dispose aborts the pass mid-loop', async () => {
    const ctx = new Context()
    const many = Array.from({ length: 50 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/repo' } }))
    const state = fakeState(many)
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldReads.length >= 1 ? true : undefined), 'the run started')
    dispose()
    const seen = state.coldReads.length
    await settle()
    assert.ok(state.coldReads.length <= seen + 1, 'no further sessions read after abort')
  })

  test('a missing sessions face folds, while a throwing live probe skips conservatively', async () => {
    for (const [label, sessions, folded] of [
      ['present-but-undefined', undefined, true],
      ['throwing get', { get: () => { throw new Error('registry broken') } }, false],
    ] as const) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      const route: RouteBox = {}
      ctx.provide('connection', connectionOf(route))
      coldFaces(ctx, state, { sessions })
      const dispose = watchActivityBackfill(ctx)
      await trigger(route)
      if (folded) await until(() => (state.coldSnapshots.length === 1 ? true : undefined), label)
      else await settle(80)
      dispose()
      assert.deepEqual(state.coldReads, folded ? ['a'] : [], label)
    }
  })

  test('a listing rejection is contained; after dispose it stays silent', async () => {
    const liveCtx = new Context()
    const liveRoute: RouteBox = {}
    let listed = 0
    liveCtx.provide('connection', connectionOf(liveRoute))
    coldFaces(liveCtx, fakeState([]), {
      sessionQuery: {
        listSessions: async () => {
          listed++
          throw new Error('corpus down')
        },
      },
    })
    const liveLines = captureLogs(liveCtx)
    const disposeLive = watchActivityBackfill(liveCtx)
    await trigger(liveRoute)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    await settle()
    disposeLive()
    assert.ok(liveLines.some(l => l.level === 'warn' && /stopped early/.test(l.text)), 'an unarmed rejection warns')

    const abortCtx = new Context()
    const abortRoute: RouteBox = {}
    let started = false
    let rejectListed: (error: Error) => void = () => {}
    abortCtx.provide('connection', connectionOf(abortRoute))
    coldFaces(abortCtx, fakeState([]), {
      sessionQuery: {
        listSessions: async () => new Promise((_resolve, reject) => {
          started = true
          rejectListed = reject
        }),
      },
    })
    const abortLines = captureLogs(abortCtx)
    const disposeAbort = watchActivityBackfill(abortCtx)
    await trigger(abortRoute)
    await until(() => (started ? true : undefined), 'the run listed the corpus')
    disposeAbort()
    rejectListed(new Error('corpus down'))
    await settle(20)
    assert.deepEqual(abortLines.filter(l => l.level === 'warn'), [], 'the unload owns the silence')
  })

  test('every cold read runs through the shared gate, and a skip stops the pass early', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'b', cwd: '/repo/b' } },
      { header: { id: 'c', cwd: '/repo/c' } },
    ])
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    let admitted = 0
    const dispose = watchActivityBackfill(ctx, {
      admit: <T>(read: () => Promise<T>): Promise<T | undefined> => {
        admitted++
        return admitted === 1 ? read() : Promise.resolve(undefined)
      },
    })
    await trigger(route)
    await until(() => (lines.some(l => l.text.includes('heap pressure')) ? true : undefined), 'the early-stop line')
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads, ['a'], 'the pass stopped at the first skip')
    assert.deepEqual(state.coldSnapshots, ['a'], 'the folded session kept its row')
    assert.equal(admitted, 2, 'one run plus one skip — the loop did not hammer the gate')
    assert.ok(lines.some(l => l.level === 'info' && l.text.includes('backfilled for 1 session(s)')), 'the folded count still reports')
    assert.ok(lines.some(l => l.level === 'info' && l.text.includes('stopped early under heap pressure')), 'the early stop reports once')
  })
})
