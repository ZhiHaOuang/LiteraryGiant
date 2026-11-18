import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import type { SurfaceNode } from '../../../src/shared/types'
import type { UseChatLike } from '../../../src/client/services'
import { TestClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, queryAll } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, settingsWith, T0, timeline } from './contextViewHarness'

const kit = makeKit()

function makeViewNoAutoOverview() {
  return makeView(new TestClientCtx(), settingsWith({ overviewAutoSteps: 'off' }))
}

function bigTimeline() {
  const requests = Array.from({ length: 600 }, (_, i) => ({
    time: T0 + i * 1_000,
    seq: i + 1,
    turn: 1 + Math.floor(i / 100),
    step: i % 100,
    system: 10,
    tools: 20,
    user: 5,
    inject: 0,
    assistant: 15,
    tool: 5,
    total: 55,
    activeMs: 1_000 + i,
  }))
  const nodes: SurfaceNode[] = Array.from({ length: 200 }, (_, i) => ({
    seq: i + 1, cat: 'assistant', tokens: 10, text: `reply ${i}`,
  })) as SurfaceNode[]
  return timeline({ requests, nodes })
}

function mountBig(sessionId: string) {
  const View = makeViewNoAutoOverview()
  return mount(h(View, {
    sessionId,
    useProjection: projectionsFor(bigTimeline()),
    useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
  }))
}

describe('ContextView lazy DNA bands', () => {
  test('a long log assembles DNA bands only for the rendered window, in total and delta mode', async () => {
    const m = await mountBig('sv-lazy-dna')
    try {
      await act(async () => { buttonByText(m.container, kit.t('trend.dna')).click() })
      await flush()
      const dnaBars = queryAll(m.container, '.lc-bar-dna')
      assert.ok(dnaBars.length > 0, 'DNA bars render from the lazy accessor')
      assert.ok(dnaBars.length < 600, `only the window is assembled (${dnaBars.length})`)
      assert.equal(queryAll(m.container, '.lc-cat-seg').length, 0)

      await act(async () => { buttonByText(m.container, kit.t('gran.delta')).click() })
      await flush()
      const deltaBars = queryAll(m.container, '.lc-bar-dna')
      assert.ok(deltaBars.length > 0)
      assert.ok(deltaBars.length < 600, `only the window paints a band (${deltaBars.length})`)
    } finally {
      await m.unmount()
    }
  })
})
