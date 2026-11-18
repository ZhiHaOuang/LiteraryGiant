import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { afterEach, describe, test, vi } from 'vitest'
import type { UseChatLike } from '../../../src/client/services'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, mount, queryAll, text } from '../helpers/kit'
import { DICT_EN } from '../../../src/client/i18n'
import { makeView, projectionsFor, timeline } from './contextViewHarness'

type ObserverCallback = IntersectionObserverCallback

function stubIntersection(): { callbacks: ObserverCallback[] } {
  const callbacks: ObserverCallback[] = []
  class FakeObserver {
    constructor(callback: ObserverCallback) { callbacks.push(callback) }
    observe = (): void => {}
    disconnect = (): void => {}
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  return { callbacks }
}

describe('ContextView below-fold lazy mount', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('keeps the skeletons until the rows near the viewport, then mounts every card', async () => {
    const observer = stubIntersection()
    const idle: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return 1 })
    vi.stubGlobal('cancelIdleCallback', () => {})
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-lazy',
      useProjection: projectionsFor(timeline({
        events: [{ seq: 1, time: 1, kind: 'inject', tokens: 1 }],
        fileOps: [{ seq: 2, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
      })),
      useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
    }))
    try {
      assert.equal(queryAll(m.container, '.lc-deferred-skeleton').length, 4)
      assert.equal(queryAll(m.container, '.lc-fa-card').length, 0)
      await act(async () => {
        for (const callback of observer.callbacks) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
      assert.equal(idle.length, 3)
      await act(async () => { for (const run of idle) run() })
      await flush()
      assert.equal(queryAll(m.container, '.lc-deferred-skeleton').length, 0)
      assert.equal(queryAll(m.container, '.lc-fa-card').length, 1)
      assert.equal(queryAll(m.container, '.lc-cmd-card').length, 1)

      await m.unmount()
      const second = await mount(h(View, {
        sessionId: 'sv-lazy-jump',
        useProjection: projectionsFor(timeline({
          fileOps: [{ seq: 2, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
        })),
        useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
      }))
      const pill = queryAll(second.container, '.lc-ledger-in-chips .lc-ledger-chip').find(el => text(el).startsWith(DICT_EN['files.kind.read']))
      assert.ok(pill !== undefined)
      await click(pill)
      await flush()
      assert.equal(queryAll(second.container, '.lc-fa-card').length, 1, 'the jump mounts the lazy card')
      await second.unmount()
    } finally {
      await m.unmount()
    }
  })
})
