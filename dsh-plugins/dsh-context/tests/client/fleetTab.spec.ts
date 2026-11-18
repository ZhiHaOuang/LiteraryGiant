import { createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { watchFleetTab } from '../../src/client/fleetTab'
import { createContextSettings } from '../../src/client/settings'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { mount, query, text } from './helpers/kit'

const NS = 'dsh-context'

function view(): ReactElement {
  return h('div', { className: 'fleet-view' }, 'fleet')
}

function wire(ctx: TestClientCtx, settings = createContextSettings()): { dispose: () => void; settings: ReturnType<typeof createContextSettings> } {
  const t = ctx.locale.bind(NS)
  const dispose = watchFleetTab(asClientCtx(ctx), settings, view, t, NS)
  return { dispose, settings }
}

describe('watchFleetTab — the Fleet tab\'s own gate', () => {
  test('show (the default) registers the tab right of the Context tab', async () => {
    const ctx = new TestClientCtx()
    const { dispose } = wire(ctx)
    const entries = ctx.slots.of('conversation.view')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.view')
    assert.equal(registration.id, 'fleet')
    assert.equal(registration.order, 30, 'right of the Context tab (20)')
    assert.equal(registration.locale, NS)
    assert.equal(registration.label?.(), 'Fleet')
    const m = await mount(component({ sessionId: 's-1' }) as ReactElement)
    assert.equal(text(query(m.container, '.fleet-view')), 'fleet')
    await m.unmount()
    dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [], 'the watcher dispose unwinds the tab')
    ctx.dispose()

    const bare = new TestClientCtx()
    ;(bare.slots as unknown as { register: () => unknown }).register = () => undefined
    const guarded = wire(bare)
    guarded.settings.set('fleetTab', 'hide')
    guarded.settings.set('fleetTab', 'show')
    guarded.dispose()
    assert.deepEqual(bare.slots.of('conversation.view'), [], 'a no-disposer registry never throws')
    bare.dispose()
  })

  test('hide unwinds it live and show brings it back, with no churn in between', () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const scope = {
      getSnapshot: () => ({ status: 'ready', value: { fleetTab: 'hide' }, writable: true }),
      subscribe: () => () => {},
      set: () => Promise.resolve(),
    }
    settings.attach(scope)
    assert.equal(settings.fleetTab(), 'hide')
    const { dispose } = wire(ctx, settings)
    assert.deepEqual(ctx.slots.of('conversation.view'), [], 'a hidden tab never registers')

    settings.set('defaultGranularity', 'turn')
    assert.deepEqual(ctx.slots.of('conversation.view'), [])

    settings.set('fleetTab', 'show')
    assert.equal(ctx.slots.of('conversation.view').length, 1)
    assert.equal(ctx.slots.of('conversation.view')[0].registration.id, 'fleet')
    settings.set('fleetTab', 'hide')
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    dispose()
    settings.set('fleetTab', 'show')
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    ctx.dispose()
  })

  test('the Context panel\'s placement never gates the tab', () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    settings.set('defaultPlacement', 'sidebar')
    const { dispose } = wire(ctx, settings)
    assert.equal(ctx.slots.of('conversation.view').length, 1, 'a sidebar-only Context panel leaves the tab served')
    settings.set('defaultPlacement', 'all')
    assert.equal(ctx.slots.of('conversation.view').length, 1)
    settings.set('defaultPlacement', 'tab')
    assert.equal(ctx.slots.of('conversation.view').length, 1, 'no placement churn')
    settings.set('defaultPlacement', 'hide')
    assert.equal(ctx.slots.of('conversation.view').length, 1, 'a hidden panel entry leaves the tab served')
    dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    ctx.dispose()
  })
})
