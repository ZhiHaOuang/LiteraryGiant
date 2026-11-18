import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { createContextSettings } from '../../../src/client/settings'
import { click, fireScroll, makeKit, mount, query, queryAll, settle, until } from '../helpers/kit'

const kit = makeKit()
const FileCard = makeFileCard(kit, createContextSettings())

const PITCH = 41
const GAP = 2
const T0 = 1700000000000
let wrapRows = false
let originals: [string, PropertyDescriptor | undefined][] = []

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe = (): void => {}
    disconnect = (): void => {}
  })
  originals = (['clientWidth', 'clientHeight', 'getBoundingClientRect'] as const)
    .map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as [string, PropertyDescriptor | undefined])
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('lc-fa-list')) return 500
      const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get
      return own === undefined ? 0 : own.call(this)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('lc-fa-list')) return 320
      const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get
      return own === undefined ? 0 : own.call(this)
    },
  })
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as () => DOMRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.classList.contains('lc-fa-list')) {
        return { left: 0, top: 0, width: 500, height: 320, right: 500, bottom: 320, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
      if (this.classList.contains('lc-fa-item')) {
        const items = [...(this.parentElement?.querySelectorAll('.lc-fa-item') ?? [])]
        const i = items.indexOf(this)
        const heightOf = (j: number): number => (wrapRows && j % 7 === 0 ? PITCH + 20 : PITCH) - GAP
        let top = 0
        for (let j = 0; j < i; j++) top += heightOf(j) + GAP
        return {
          left: 0, top, width: 500, height: heightOf(i),
          right: 500, bottom: top + heightOf(i), x: 0, y: top, toJSON: () => ({}),
        } as DOMRect
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

function entry(index: number): FileEntry {
  const op: FileOp = { seq: index, kind: 'read', tool: 'read', time: T0 + index, err: false, added: 0, removed: 0, path: '' }
  return { path: `/src/file-${String(index).padStart(3, '0')}.ts`, form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, ops: [op] }
}

function activityOf(count: number): FileActivity {
  return {
    entries: Array.from({ length: count }, (_, i) => entry(i)),
    totals: {
      read: { files: count, ops: count }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 },
      added: 0, removed: 0,
    },
  }
}

const props = { activity: activityOf(60), state: 'ready' as const, onRetry: undefined }

describe('FileCard row windowing', () => {
  test('renders a measured window with full-height pads and follows the scroll', async () => {
    const m = await mount(h(FileCard, props))
    const list = query<HTMLElement>(m.container, '.lc-fa-list')
    await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'the list windows after measuring')
    const rendered = queryAll(m.container, '.lc-fa-item').length
    assert.ok(rendered < 60 && rendered > 8)
    const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
    assert.equal(pads.length, 1)
    assert.ok(Number.parseFloat(pads[0].style.height) > 0)
    assert.equal(list.clientHeight, 320)
    list.scrollTop = 900
    await settle(40)
    await fireScroll(list)
    await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
    const afterScroll = queryAll(m.container, '.lc-fa-item').length
    assert.ok(afterScroll < 60 && afterScroll >= 8)
    const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
    assert.equal(topPad.style.height, `${13 * PITCH - GAP}px`)
    assert.equal(bottomPad.style.height, `${21 * PITCH - GAP}px`)
    await m.unmount()
  })

  test('mixed wrapped row heights keep the full list so the scroll geometry stays truthful', async () => {
    wrapRows = true
    const m = await mount(h(FileCard, props))
    try {
      await until(() => queryAll(m.container, '.lc-fa-item').length === 60, 'the full list renders')
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0, 'no spacers on a non-uniform list')
    } finally {
      wrapRows = false
      await m.unmount()
    }
  })

  test('an expanded row falls back to the full list, then windows again when closed', async () => {
    const m = await mount(h(FileCard, props))
    await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'windowed')
    const first = query<HTMLElement>(m.container, '.lc-fa-row')
    await click(first)
    await until(() => queryAll(m.container, '.lc-fa-item').length === 60, 'expanded row shows the full list')
    await click(first)
    await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'closing the row re-windows')
    await m.unmount()
  })
})
