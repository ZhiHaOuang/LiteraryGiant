import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import { describe, test } from 'vitest'
import { INSIGHT_PANEL_ID, INSIGHT_PANEL_ORDER, watchInsightPage } from '../../src/client/insightPage'
import { createContextSettings } from '../../src/client/settings'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { makeKit } from './helpers/kit'

const NS = 'dsh-context'

function page(_props: { sessionId?: string } & Record<string, unknown>): null {
  return null
}

describe('watchInsightPage', () => {
  test("the default 'show' mounts both registrations under one identity", () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)

    const main = ctx.slots.of('main')
    assert.equal(main.length, 1, 'the page rides the keyed main seat')
    assert.equal(main[0].registration.name, 'main')
    assert.equal(main[0].registration.key, INSIGHT_PANEL_ID)
    assert.equal(main[0].registration.locale, NS)
    assert.equal(main[0].component, page, 'the page component registered verbatim')

    const entries = ctx.slots.of('sidebar.panellist')
    assert.equal(entries.length, 1, 'the entry rides the sidebar panel list')
    assert.equal(entries[0].registration.name, 'sidebar.panellist')
    assert.equal(entries[0].registration.id, INSIGHT_PANEL_ID, 'the entry id addresses the main panel')
    assert.equal(entries[0].registration.order, INSIGHT_PANEL_ORDER)
    assert.equal(entries[0].registration.locale, NS)
    assert.equal(entries[0].registration.label?.(), 'Context Insights', 'the label thunk resolves the page title')
    const iconEl = entries[0].component({ size: 16 }) as ReactElement
    assert.equal((iconEl.type as { name: string }).name, 'InsightPanelIcon', 'the entry glyph component')
    const defaults = entries[0].component({}) as ReactElement
    assert.equal((defaults.type as { name: string }).name, 'InsightPanelIcon', 'the size seat defaults')
    dispose()
  })

  test("'hide' unwinds both registrations and 'show' remounts them; a 'hide' start mounts nothing; the disposer unwinds once and is repeat-safe", () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)
    assert.equal(ctx.slots.of('main').length, 1)

    settings.set('insightsEntry', 'hide')
    assert.equal(ctx.slots.of('main').length, 0, 'hiding the entry unwinds the page')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0, 'hiding unwinds the entry')

    settings.set('insightsEntry', 'show')
    assert.equal(ctx.slots.of('main').length, 1, 'showing remounts the pair')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)

    settings.set('defaultGranularity', 'turn')
    assert.equal(ctx.slots.of('main').length, 1)
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)
    dispose()

    const hidden = new TestClientCtx()
    const hiddenSettings = createContextSettings()
    hiddenSettings.set('insightsEntry', 'hide')
    const disposeHidden = watchInsightPage(asClientCtx(hidden), hiddenSettings, page, t, NS)
    assert.equal(hidden.slots.of('main').length, 0)
    assert.equal(hidden.slots.of('sidebar.panellist').length, 0)
    disposeHidden()
    hiddenSettings.set('insightsEntry', 'show')
    assert.equal(hidden.slots.of('main').length, 0)

    const live = new TestClientCtx()
    const liveSettings = createContextSettings()
    const disposeLive = watchInsightPage(asClientCtx(live), liveSettings, page, t, NS)
    disposeLive()
    assert.equal(live.slots.of('main').length, 0, 'the disposer unwinds the live mount')
    assert.equal(live.slots.of('sidebar.panellist').length, 0)
    assert.doesNotThrow(disposeLive, 'the disposer is safe to repeat')
  })

  test('a slots face returning no disposer is tolerated across flips and dispose', () => {
    const bare = {
      slots: {
        inject: (_name: string, cb: () => unknown) => { cb(); return undefined },
        register: () => undefined,
      },
    }
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(bare as never, settings, page, t, NS)
    assert.doesNotThrow(() => { settings.set('insightsEntry', 'hide') })
    assert.doesNotThrow(() => { settings.set('insightsEntry', 'show') })
    assert.doesNotThrow(dispose)
  })
})
