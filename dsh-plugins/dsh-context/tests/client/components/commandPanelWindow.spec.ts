import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeCommandPanel } from '../../../src/client/components/commandPanel'
import { rowWindowFor } from '../../../src/client/components/useRowWindow'
import type { Command } from '../../../src/client/commands'
import { click, fireScroll, makeKit, mount, query, queryAll, settle, text, typeText, until } from '../helpers/kit'

const Panel = makeCommandPanel(makeKit())

const PITCH = 43
const GAP = 2
const T0 = 1_700_000_000_000
let mixedRows = false
let zeroRows = false
let originals: [string, PropertyDescriptor | undefined][] = []

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe = (): void => {}
    disconnect = (): void => {}
  })
  originals = (['clientHeight', 'getBoundingClientRect'] as const)
    .map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as [string, PropertyDescriptor | undefined])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('lc-cmd-list')) return 320
      const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get
      return own === undefined ? 0 : own.call(this)
    },
  })
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as () => DOMRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.classList.contains('lc-cmd-item')) {
        const items = [...(this.parentElement?.querySelectorAll('.lc-cmd-item') ?? [])]
        const i = items.indexOf(this)
        const heightOf = (j: number): number => (zeroRows ? 0 : (mixedRows && j % 7 === 0 ? PITCH + 20 : PITCH) - GAP)
        let top = 0
        for (let j = 0; j < i; j++) top += heightOf(j) + GAP
        return { left: 0, top, width: 500, height: heightOf(i), right: 500, bottom: top + heightOf(i), x: 0, y: top, toJSON: () => ({}) } as DOMRect
      }
      return rect.call(this) as DOMRect
    },
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  for (const [name, desc] of originals) {
    if (desc === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, desc)
  }
})

function commandsOf(count: number): Command[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    time: T0 + i * 1000,
    tool: 'bash',
    cmd: `echo item-${i}`,
    description: `run item-${i}`,
    start: T0 + i * 1000,
    end: T0 + i * 1000 + 100,
    status: 'completed' as const,
    err: false,
  }))
}

describe('CommandPanel row windowing', () => {
  test('renders a measured window with full-height pads and follows the scroll', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'the list windows after measuring')
      const start = rowWindowFor(0, 320, PITCH, 120)
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, start.to - start.from + 1)
      const [bottomOnly] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(bottomOnly.style.height, `${(119 - start.to) * PITCH - GAP}px`)

      list.scrollTop = 900
      await settle(40)
      await fireScroll(list)
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
      const mid = rowWindowFor(900, 320, PITCH, 120)
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, mid.to - mid.from + 1)
      const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(topPad.style.height, `${mid.from * PITCH - GAP}px`)
      assert.equal(bottomPad.style.height, `${(119 - mid.to) * PITCH - GAP}px`)

      list.scrollTop = 100_000
      list.dispatchEvent(new Event('scroll'))
      await until(() => {
        const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
        return pads.length === 1 && Number.parseFloat(pads[0].style.height) > 1000
      }, 'the tail window drops its bottom pad')
      assert.ok(text(m.container).includes('item-0'), 'the oldest row is reachable')
    } finally {
      await m.unmount()
    }
  })

  test('mixed row heights or an unlaid-out list keep the full list so the scroll geometry stays truthful', async () => {
    for (const arrange of [() => { mixedRows = true }, () => { zeroRows = true }]) {
      arrange()
      const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
      try {
        await settle(40)
        assert.equal(queryAll(m.container, '.lc-cmd-item').length, 120)
        assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
      } finally {
        mixedRows = false
        zeroRows = false
        await m.unmount()
      }
    }
  })

  test('an open row keeps the full list — opened above or below the measuring threshold — and closing re-windows', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    const list = query<HTMLElement>(m.container, '.lc-cmd-list')
    await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
    list.scrollTop = 900
    await settle(40)
    await fireScroll(list)
    await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'scrolled mid-list')
    await click(query<HTMLElement>(m.container, '.lc-cmd-row'))
    await until(() => queryAll(m.container, '.lc-cmd-item').length === 120, 'the expanded row shows the full list')
    await click(query<HTMLElement>(m.container, '.lc-cmd-item-on .lc-cmd-row'))
    await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'closing the row re-windows')
    await m.unmount()

    const early = await mount(h(Panel, { commands: commandsOf(4), workspace: '/repo' }))
    await click(query<HTMLElement>(early.container, '.lc-cmd-row'))
    await until(() => early.container.querySelector('.lc-cmd-detail') !== null, 'the row expands')
    await early.update(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    await settle(30)
    assert.equal(queryAll(early.container, '.lc-cmd-item').length, 120, 'no windowing while a row is open')
    assert.equal(queryAll(early.container, '.lc-row-pad').length, 0)
    const openRow = queryAll<HTMLElement>(early.container, '.lc-cmd-row')
      .find(row => query<HTMLElement>(row, '.lc-cmd-cmd').textContent?.endsWith('item-3') === true)
    assert.ok(openRow !== undefined)
    await click(openRow)
    await until(() => queryAll(early.container, '.lc-cmd-item').length < 120, 'closing the row measures and windows')
    await early.unmount()
  })

  test('a filter below the threshold puts every match back in the DOM', async () => {
    const commands = commandsOf(120).map((rec, i) => ({ ...rec, cmd: `${i % 2 === 0 ? 'echo alpha' : 'echo beta'}-${i}` }))
    const m = await mount(h(Panel, { commands, workspace: '/repo' }))
    await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
    await typeText(query<HTMLInputElement>(m.container, 'input.lc-fa-search'), 'alpha')
    await until(() => queryAll(m.container, '.lc-cmd-item').length === 60, 'all sixty matches render')
    assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
    await typeText(query<HTMLInputElement>(m.container, 'input.lc-fa-search'), '')
    await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'clearing restores the window')
    await m.unmount()
  })

  test('zebra parity follows the absolute row index through a window shift', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    const list = query<HTMLElement>(m.container, '.lc-cmd-list')
    await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
    const check = (from: number): void => {
      const rows = queryAll<HTMLElement>(m.container, '.lc-cmd-item')
      for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].classList.contains('lc-cmd-item-alt'), (from + i) % 2 === 1, `row ${from + i}`)
      }
    }
    check(rowWindowFor(0, 320, PITCH, 120).from)
    list.scrollTop = PITCH * 21
    await settle(40)
    await fireScroll(list)
    await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'scrolled past the overscan')
    check(rowWindowFor(PITCH * 21, 320, PITCH, 120).from)
    await m.unmount()
  })

  test('a shrinking result set under a stale window still renders its rows', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    const list = query<HTMLElement>(m.container, '.lc-cmd-list')
    await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
    list.scrollTop = 3000
    await settle(40)
    await fireScroll(list)
    await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'scrolled mid-list')
    await typeText(query<HTMLInputElement>(m.container, 'input.lc-fa-search'), 'item-119')
    await until(() => queryAll(m.container, '.lc-cmd-item').length === 1, 'the one match renders')
    assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
    await m.unmount()
  })
})
