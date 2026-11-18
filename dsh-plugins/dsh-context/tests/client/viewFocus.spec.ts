import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { activateViewTab, openContextSidebar, requestContextFocus, subscribeContextFocus, takeContextFocus } from '../../src/client/viewFocus'
import { asClientCtx, TestClientCtx } from './helpers/harness'

describe('context focus relay', () => {
  test('one request survives until taken; a fresh request replaces it and sessions are isolated', () => {
    requestContextFocus('sv-relay', 42)
    assert.equal(takeContextFocus('sv-relay'), 42)
    assert.equal(takeContextFocus('sv-relay'), null, 'one-shot: a second take finds nothing')
    requestContextFocus('sv-race', 7)
    requestContextFocus('sv-race', 9)
    assert.equal(takeContextFocus('sv-race'), 9, 'the latest click wins')
    requestContextFocus('sv-other', 1)
    assert.equal(takeContextFocus('sv-other'), 1)
    assert.equal(takeContextFocus('sv-unknown'), null)
  })
})

describe('context focus subscription', () => {
  test('every record wakes the subscriber; the unsubscribe stops delivery', () => {
    let hits = 0
    const off = subscribeContextFocus(() => { hits++ })
    requestContextFocus('sv-a', 1)
    assert.equal(hits, 1)
    requestContextFocus('sv-b', 2)
    assert.equal(hits, 2, 'other-session records wake the view too — it takes only its own entry')
    off()
    requestContextFocus('sv-a', 3)
    assert.equal(hits, 2, 'the detached listener hears nothing')
    takeContextFocus('sv-a')
    takeContextFocus('sv-b')
  })

  test('a listener unsubscribing another mid-notify skips it (later records do not re-run it)', () => {
    let late = 0
    let offLate: () => void = () => {}
    const offRemover = subscribeContextFocus(() => { offLate() })
    offLate = subscribeContextFocus(() => { late++ })
    requestContextFocus('sv-mid', 1)
    assert.equal(late, 0, 'an element removed before iteration reaches it never runs')
    requestContextFocus('sv-mid', 2)
    assert.equal(late, 0, 'and it stays detached')
    offRemover()
    takeContextFocus('sv-mid')
  })
})

describe('openContextSidebar', () => {
  test('opens the registered kind through the sidebarRight face; absent or verb-less faces report false', () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openTab: (kind: string) => { opened.push(kind) } } } })
    assert.equal(openContextSidebar(asClientCtx(ctx)), true)
    assert.deepEqual(opened, ['dsh-context'])

    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx())), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: {} } }))), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: null } }))), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: 'x' } }))), false)
  })

  test('a hostile face — throwing read or openTab — reports false, never throws', () => {
    const throwingRead = {
      get(_name: string): unknown { throw new Error('boom') },
    } as unknown as TestClientCtx
    assert.equal(openContextSidebar(asClientCtx(throwingRead)), false)
    const ctx = new TestClientCtx({ services: {
      sidebarRight: { openTab: () => { throw new Error('no session surface mounted') } },
    } })
    assert.equal(openContextSidebar(asClientCtx(ctx)), false)
  })
})

describe('activateViewTab', () => {
  test('clicks the inactive tab matching the label, skips the active one, and reports misses', () => {
    type Counted = HTMLElement & { __clicks: () => number }
    const bar = document.createElement('div')
    const mk = (label: string, selected: boolean): Counted => {
      const b = document.createElement('button')
      b.setAttribute('role', 'tab')
      if (selected) b.setAttribute('aria-selected', 'true')
      b.textContent = label
      let clicks = 0
      b.addEventListener('click', () => { clicks++ })
      const counted = Object.assign(b, { __clicks: () => clicks })
      bar.appendChild(counted)
      return counted
    }
    const chat = mk('Chat', true)
    const context = mk('Context', false)
    const trajectory = mk('Trajectory', false)
    document.body.appendChild(bar)
    try {
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 1)
      assert.equal(chat.__clicks(), 0)

      context.setAttribute('aria-selected', 'true')
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 1)

      context.setAttribute('aria-selected', 'false')
      context.textContent = '  Context '
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 2)

      assert.equal(activateViewTab('Missing'), false)
      assert.equal(trajectory.__clicks(), 0)
    } finally {
      bar.remove()
    }
  })
})
