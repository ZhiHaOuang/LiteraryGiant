import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings } from '../../../src/client/settings'
import { TestClientCtx } from '../helpers/harness'
import { click, mount, query, queryAll, text } from '../helpers/kit'
import { makeView, projectionsFor, richTimeline } from './contextViewHarness'

function selfOnly() {
  const snapshot = { byId: { 'sv-self': { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

const TIMING = { wallMs: 387_000, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }

describe('ContextView — the agent network card\'s own session', () => {
  test("the panel's active time and step count fill the current card's footer, or just the steps without timing", async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', host: 'sidebar', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(text(self).includes('Main Agent'), true)
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    await m.unmount()

    const m2 = await mount(h(View, { sessionId: 'sv-self', host: 'sidebar', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(query(m2.container, '.lc-agent-self .lc-agent-meta-text').textContent, '3 steps')
    await m2.unmount()
  })

  test('the center Context tab hands the card to the Fleet tab; only the sidebar host keeps it inline', async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    assert.equal(queryAll(m.container, '.lc-agents').length, 0, 'no agent network on the Context tab')
    await m.unmount()
  })

  test("the stats board's Fleet section opens the Fleet tab, else the panel that keeps the card", async () => {
    const bar = document.createElement('div')
    const tab = (label: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', 'false')
      b.textContent = label
      bar.appendChild(b)
      return b
    }
    const fleet = tab('Fleet')
    let fleetClicks = 0
    fleet.addEventListener('click', () => { fleetClicks++ })
    document.body.appendChild(bar)
    try {
      const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
      const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
      await click(query(m.container, '.lc-ledger-team-head'))
      assert.equal(fleetClicks, 1, 'the served Fleet tab is activated')
      await m.unmount()
      fleet.remove()
    } finally {
      bar.remove()
    }
  })

  test('a hidden Fleet tab falls back to the right Sidebar panel, and to nothing when that is gone too', async () => {
    const opened: string[] = []
    const sidebar = { openTab: (kind: string): void => { opened.push(kind) } }
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly(), sidebarRight: sidebar } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    await click(query(m.container, '.lc-ledger-team-head'))
    assert.deepEqual(opened, ['dsh-context'], 'the sidebar panel whose Context tab holds the card')
    await m.unmount()

    const bare = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m2 = await mount(h(bare, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    await click(query(m2.container, '.lc-ledger-team-head'))
    await m2.unmount()

    const settings = createContextSettings()
    settings.set('defaultPlacement', 'tab')
    settings.set('fleetTab', 'hide')
    const plainView = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }), settings)
    const plain = await mount(h(plainView, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    const cell = query(plain.container, '.lc-ledger-team-head')
    assert.equal(cell.getAttribute('role'), null)
    assert.equal(cell.getAttribute('tabindex'), null)
    await plain.unmount()
  })
})
