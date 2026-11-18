import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { isNewerVersion } from '../../src/client/latestVersion'
import { flush, mount } from './helpers/kit'

const HOUR_MS = 60 * 60 * 1000

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

async function freshModule(): Promise<typeof import('../../src/client/latestVersion')> {
  vi.resetModules()
  return await import('../../src/client/latestVersion')
}

describe('fetchLatestVersion', () => {
  test('an ok response carries a string version; missing/non-string versions and rejected fetches resolve null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }))
    let { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '9.9.9')

    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }))
    ;({ fetchLatestVersion } = await freshModule())
    assert.equal(await fetchLatestVersion(), null)
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: 9 }) }))
    ;({ fetchLatestVersion } = await freshModule())
    assert.equal(await fetchLatestVersion(), null)
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    ;({ fetchLatestVersion } = await freshModule())
    assert.equal(await fetchLatestVersion(), null)
  })

  test('a second call within the TTL does not refetch; a call after it expires refetches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches++
      return { ok: true, json: async () => ({ version: '1.0.' + String(fetches) }) }
    })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '1.0.1')
    vi.setSystemTime(1_000_000 + HOUR_MS - 1)
    assert.equal(await fetchLatestVersion(), '1.0.1')
    assert.equal(fetches, 1)
    vi.setSystemTime(1_000_000 + HOUR_MS)
    assert.equal(await fetchLatestVersion(), '1.0.2')
    assert.equal(fetches, 2)
  })

  test('falls back to npmmirror on an official failure, and resolves null when every source fails', async () => {
    const cases: { official: () => { ok: boolean; json: () => Promise<unknown> }; mirror: unknown; expected: string | null }[] = [
      { official: () => ({ ok: false, json: async () => ({}) }), mirror: { ok: true, json: async () => ({ version: '2.0.0' }) }, expected: '2.0.0' },
      { official: () => { throw new Error('offline') }, mirror: { ok: true, json: async () => ({ version: '3.0.0' }) }, expected: '3.0.0' },
      { official: () => ({ ok: false, json: async () => ({}) }), mirror: { ok: false, json: async () => ({}) }, expected: null },
    ]
    for (const { official, mirror, expected } of cases) {
      const urls: string[] = []
      vi.stubGlobal('fetch', async (input: unknown) => {
        const url = String(input)
        urls.push(url)
        if (url.startsWith('https://registry.npmjs.org/')) return official()
        return mirror
      })
      const { fetchLatestVersion } = await freshModule()
      assert.equal(await fetchLatestVersion(), expected)
      assert.deepEqual(urls, [
        'https://registry.npmjs.org/dsh-context/latest',
        'https://registry.npmmirror.com/dsh-context/latest',
      ])
    }
  })
})

describe('isNewerVersion', () => {
  test('segments compare numerically, ignoring a v prefix, pre-release suffixes, padding, and garbage', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.2'), true)
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false)
    assert.equal(isNewerVersion('1.2.2', '1.2.3'), false)
    assert.equal(isNewerVersion('v1.3.0', '1.2.9'), true)
    assert.equal(isNewerVersion('1.3.0-rc.1', '1.3.0'), false)
    assert.equal(isNewerVersion('1.3.0-rc.1', '1.2.0'), true)
    assert.equal(isNewerVersion('1.2', '1.2.1'), false)
    assert.equal(isNewerVersion('1.2.1', '1.2'), true)
    assert.equal(isNewerVersion('x.y', '0.0.0'), false)
  })
})

async function renderUseNewerVersion(version?: string): Promise<{ settled: () => string; unmount: () => Promise<void> }> {
  vi.resetModules()
  if (version === undefined) delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
  else (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__ = version
  const { useNewerVersion } = await import('../../src/client/latestVersion')
  const seen: string[] = []
  function Probe(): null {
    seen.push(useNewerVersion() ?? '')
    return null
  }
  const m = await mount(h(Probe, {}))
  await flush()
  return { settled: () => seen[seen.length - 1], unmount: () => m.unmount() }
}

describe('useNewerVersion', () => {
  test('serves a newer version, skips dev builds, stays null for same/failed reads, and drops a late answer after unmount', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '1.1.0' }) }))
    const newer = await renderUseNewerVersion('1.0.0')
    assert.equal(newer.settled(), '1.1.0')
    await newer.unmount()

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const dev = await renderUseNewerVersion()
    assert.equal(fetchMock.mock.calls.length, 0, 'a dev build never checks the registry')
    assert.equal(dev.settled(), '')
    await dev.unmount()

    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '1.0.0' }) }))
    const same = await renderUseNewerVersion('1.0.0')
    assert.equal(same.settled(), '')
    await same.unmount()
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({}) }))
    const failed = await renderUseNewerVersion('1.0.0')
    assert.equal(failed.settled(), '')
    await failed.unmount()

    let resolveFetch: ((res: { ok: boolean; json: () => Promise<{ version: string }> }) => void) | null = null
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve })))
    const late = await renderUseNewerVersion('1.0.0')
    await late.unmount()
    resolveFetch!({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
    await flush()
    assert.equal(late.settled(), '', 'the late result is dropped')
  })
})
