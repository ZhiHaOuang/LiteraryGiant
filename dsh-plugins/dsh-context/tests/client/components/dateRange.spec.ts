import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import {
  makeDateRange,
  monthLabelOf,
  type DateRangeProps,
} from '../../../src/client/components/dateRange'
import type { DayRange } from '../../../src/client/overview'
import { click, hover, keydown, makeKit, mount, query, queryAll, text, type Mounted } from '../helpers/kit'

const TODAY = '2026-10-09'

const DateRange = makeDateRange(makeKit())

const mounted: Mounted[] = []

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lc-dp-panel')
}

function trigger(m: Mounted): HTMLElement {
  return query(m.container, '.lc-dp-trigger')
}

function cell(m: Mounted, key: string): HTMLElement {
  const found = queryAll(document.body, '.lc-dp-cell').find(el => el.getAttribute('aria-label') === key)
  if (found === undefined) throw new Error(`no day cell: ${key}`)
  return found
}

async function fireWindow(ev: Event): Promise<void> {
  await act(async () => { window.dispatchEvent(ev) })
}

interface Harness {
  m: Mounted
  changes: (DayRange | null)[]
  set: (next: Partial<DateRangeProps>) => Promise<void>
}

async function open(over: Partial<DateRangeProps> = {}): Promise<Harness> {
  const changes: (DayRange | null)[] = []
  let props: DateRangeProps = {
    value: null,
    picked: false,
    onChange: (range) => { changes.push(range) },
    today: TODAY,
    locale: 'en',
    ...over,
  }
  const m = await mount(h(DateRange, props))
  mounted.push(m)
  return {
    m,
    changes,
    async set(next) {
      props = { ...props, ...next }
      await m.update(h(DateRange, props))
    },
  }
}

async function toggle(m: Mounted): Promise<void> {
  await click(trigger(m))
}

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.unmount()
})

describe('monthLabelOf', () => {
  test('the panel header names the month in the active locale', () => {
    assert.match(monthLabelOf('2026-10', 'en'), /2026/)
    assert.match(monthLabelOf('2026-10', 'zh'), /2026/)
    assert.equal(monthLabelOf('not-a-month', 'en'), 'not-a-month', 'a key that will not convert falls back to itself')
  })
})

describe('the trigger', () => {
  test('carries the scope’s two ends, or the two placeholders', async () => {
    const { m, set } = await open()
    const halves = () => queryAll(m.container, '.lc-dp-half').map(el => el.textContent)
    assert.deepEqual(halves(), ['Start date', 'End date'], 'an unbounded scope has no span to print')
    assert.match(query(m.container, '.lc-dp-trigger').getAttribute('aria-label') ?? '', /custom date range/)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
    await toggle(m)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'true')
    assert.ok(panel() !== null, 'the panel is portaled to the body')

    await set({ value: { from: '2026-09-10', to: '2026-10-09' } })
    assert.deepEqual(halves(), ['2026-09-10', '2026-10-09'])
    assert.ok(!trigger(m).className.includes('lc-dp-trigger-on'))
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 0, 'nothing to clear while a preset is in charge')

    await set({ picked: true })
    assert.match(trigger(m).className, /lc-dp-trigger-on/)
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 1, 'a pick grows the way back')

    await toggle(m)
    assert.ok(panel() === null, 'a press while open closes it again')
  })
})

describe('picking a range', () => {
  test('a hover previews nothing before the anchor and the end after it; the second click commits the sorted pair', async () => {
    const { m, changes } = await open()
    await toggle(m)
    assert.match(text(query(panel()!, '.lc-dp-hint')), /start date/)
    const untouched = cell(m, '2026-10-07').className
    await hover(cell(m, '2026-10-07'))
    assert.equal(cell(m, '2026-10-07').className, untouched, 'a hover before any anchor previews nothing')
    await click(cell(m, '2026-10-03'))
    assert.deepEqual(changes, [], 'the first click only anchors')
    assert.match(text(query(panel()!, '.lc-dp-hint')), /end date/)
    assert.match(cell(m, '2026-10-03').className, /lc-dp-edge/, 'the anchor is the start until the end lands')
    assert.match(text(query(m.container, '.lc-dp-half')), /2026-10-03/, 'the head reads the anchor as it lands')

    await hover(cell(m, '2026-10-09'))
    assert.match(text(queryAll(m.container, '.lc-dp-half')[1]), /2026-10-09/, 'the head previews the end under the cursor')
    assert.match(cell(m, '2026-10-05').className, /lc-dp-in/, 'the band runs to the hovered day')
    assert.match(cell(m, '2026-10-09').className, /lc-dp-edge/, 'the hovered day previews where the end would land')
    await hover(cell(m, '2026-10-01'))
    assert.match(cell(m, '2026-10-02').className, /lc-dp-in/, 'hovering back past the anchor previews the swapped band')
    assert.match(cell(m, '2026-10-01').className, /lc-dp-edge/, 'the swap moves the previewed end to the near side')
    await click(cell(m, '2026-10-09'))
    assert.deepEqual(changes, [{ from: '2026-10-03', to: '2026-10-09' }])
    assert.ok(panel() === null, 'the pick answers the page immediately')
  })

  test('a reversed pair sorts, and the same day twice is a one-day range', async () => {
    const reversed = await open()
    await toggle(reversed.m)
    await click(cell(reversed.m, '2026-10-09'))
    await click(cell(reversed.m, '2026-10-03'))
    assert.deepEqual(reversed.changes, [{ from: '2026-10-03', to: '2026-10-09' }])

    const same = await open()
    await toggle(same.m)
    await click(cell(same.m, '2026-10-05'))
    await click(cell(same.m, '2026-10-05'))
    assert.deepEqual(same.changes, [{ from: '2026-10-05', to: '2026-10-05' }])
  })

  test('the live scope opens highlighted; a future day and a blank pad are inert', async () => {
    const live = await open({ value: { from: '2026-10-03', to: '2026-10-06' }, picked: true })
    await toggle(live.m)
    assert.match(cell(live.m, '2026-10-04').className, /lc-dp-in/)
    assert.match(cell(live.m, '2026-10-03').className, /lc-dp-edge/)
    assert.match(cell(live.m, '2026-10-06').className, /lc-dp-edge/)
    assert.match(cell(live.m, '2026-10-09').className, /lc-dp-today/)
    assert.match(cell(live.m, '2026-10-07').textContent ?? '', /^7$/, 'each cell prints its own day of the month')
    await click(cell(live.m, '2026-10-08'))
    assert.equal(cell(live.m, '2026-10-04').className.includes('lc-dp-in'), false)
    assert.match(text(query(panel()!, '.lc-dp-hint')), /end date/)
    await live.m.unmount()

    const future = await open()
    await toggle(future.m)
    const futureDay = cell(future.m, '2026-10-10')
    assert.match(futureDay.className, /lc-dp-future/)
    assert.equal(futureDay.getAttribute('aria-disabled'), 'true')
    await click(futureDay)
    assert.deepEqual(future.changes, [])
    assert.match(text(query(panel()!, '.lc-dp-hint')), /start date/, 'the future day did not anchor')
    await hover(futureDay)
    assert.ok(queryAll(panel()!, '.lc-dp-blank').length > 0, 'the month pads its weeks')
    await future.m.unmount()
  })

  test('the clear button hands the scope back to the presets', async () => {
    const { m, changes } = await open({ value: { from: '2026-10-03', to: '2026-10-06' }, picked: true })
    await toggle(m)
    await click(query(panel()!, '.lc-dp-clear'))
    assert.deepEqual(changes, [null])
  })
})

describe('the month nav', () => {
  test('steps a month at a time, stops at this month, and reopens on this month rather than the browsed one', async () => {
    const { m } = await open()
    await toggle(m)
    assert.match(query(panel()!, '.lc-dp-month').textContent ?? '', /2026/)
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), true, 'the panel opens on this month, so next is spent')

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), false, 'back a month, next serves again')
    await click(queryAll(panel()!, '.lc-dp-navbtn')[1])
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), true, 'no month past this one')
    assert.equal(queryAll(panel()!, '.lc-dp-cell').length, 42, 'a six-week grid, the trailing all-blank week included')

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    const away = query(panel()!, '.lc-dp-month').textContent
    await toggle(m)
    await toggle(m)
    assert.notEqual(query(panel()!, '.lc-dp-month').textContent, away, 'the panel came back on today, not the browsed month')
    await m.unmount()

    const early = await open({ today: '1970-01-05' })
    await toggle(early.m)
    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.match(query(panel()!, '.lc-dp-month').textContent ?? '', /1970/)
  })

  test('a malformed today opens no panel and claims no expansion', async () => {
    const { m } = await open({ today: 'garbage' })
    await toggle(m)
    assert.ok(panel() === null)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'false', 'nothing rendered, so nothing reported as open')
  })
})

describe('the keyboard cursor', () => {
  test('arrows walk the shown month and Enter picks the day under them', async () => {
    const { m, changes } = await open()
    await toggle(m)
    const grid = query(panel()!, '.lc-dp-grid')
    assert.equal(grid.getAttribute('aria-activedescendant'), 'lc-dp-day')
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/, 'the cursor opens on the month’s first day')

    await keydown('ArrowRight', grid)
    assert.match(cell(m, '2026-10-02').className, /lc-dp-cursor/)
    await keydown('ArrowDown', grid)
    assert.match(cell(m, '2026-10-09').className, /lc-dp-cursor/)
    await keydown('ArrowUp', grid)
    assert.match(cell(m, '2026-10-02').className, /lc-dp-cursor/)
    await keydown('ArrowLeft', grid)
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/)

    await keydown('Enter', grid)
    await keydown(' ', grid)
    assert.deepEqual(changes, [{ from: '2026-10-01', to: '2026-10-01' }], 'Enter anchors, Space closes the pair')
  })

  test('the cursor never leaves the shown month or enters the future', async () => {
    const { m } = await open()
    await toggle(m)
    const grid = () => query(panel()!, '.lc-dp-grid')
    await keydown('ArrowUp', grid())
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/, 'the cursor stays inside the shown month')
    for (let i = 0; i < 40; i++) await keydown('ArrowRight', grid())
    assert.match(cell(m, TODAY).className, /lc-dp-cursor/)
    await keydown('ArrowRight', grid())
    assert.match(cell(m, TODAY).className, /lc-dp-cursor/)

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.match(cell(m, '2026-09-01').className, /lc-dp-cursor/, 'a month step re-seats the cursor on the 1st')
    await keydown('ArrowDown', grid())
    assert.match(cell(m, '2026-09-08').className, /lc-dp-cursor/)
    await keydown('ArrowDown', grid())
    assert.match(cell(m, '2026-09-15').className, /lc-dp-cursor/)
    await keydown('Tab', grid())
    await keydown('a', grid())
    assert.match(cell(m, '2026-09-15').className, /lc-dp-cursor/)
  })
})

describe('the panel seat', () => {
  test('sits under its trigger, inside the viewport, and flips when it would fall off', async () => {
    const size = { w: 240, h: 300 }
    const own = (name: string): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    const width = own('offsetWidth')
    const height = own('offsetHeight')
    const restore = (name: string, was: PropertyDescriptor | undefined): void => {
      if (was === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
      else Object.defineProperty(HTMLElement.prototype, name, was)
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => size.w })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => size.h })
    try {
      const { m } = await open()
      const rect = { left: 800, right: 900, top: 680, bottom: 700 }
      query(m.container, '.lc-dp').getBoundingClientRect = () =>
        ({ ...rect, x: rect.left, y: rect.top, width: 100, height: 20, toJSON: () => '' }) as DOMRect

      await toggle(m)
      const seated = panel()!
      assert.equal(seated.style.visibility, '', 'measured before paint, so no hidden stage is left')
      assert.notEqual(seated.style.left, '0px')
      assert.equal(seated.style.left, '660px', 'right-aligned to the trigger')
      assert.equal(seated.style.top, '374px', 'flipped above: below the trigger there is no room for 300px')

      rect.left = 10
      rect.right = 110
      await toggle(m)
      await toggle(m)
      const clamped = panel()!
      assert.equal(clamped.style.left, '8px', 'clamped inside the viewport')
      assert.equal(clamped.style.top, '374px')
    } finally {
      restore('offsetWidth', width)
      restore('offsetHeight', height)
    }
  })
})

describe('leaving the panel', () => {
  test('Escape closes it and puts focus back on the trigger', async () => {
    const { m } = await open()
    await toggle(m)
    trigger(m).focus()
    await keydown('Escape')
    assert.ok(panel() === null)
    assert.equal(document.activeElement?.className, trigger(m).className, 'focus comes back to the trigger')
  })

  test('a press outside closes it; presses inside the trigger tree or the panel, and a targetless event, do not', async () => {
    const { m } = await open()
    await toggle(m)
    await act(async () => { query(m.container, '.lc-dp').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null, 'the tree the panel was opened from stays open')
    await m.unmount()
    const inside = await open()
    await toggle(inside.m)
    await act(async () => { cell(inside.m, '2026-10-03').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null, 'a press inside the portaled panel is not an outside press')
    await inside.m.unmount()
    const targetless = await open()
    await toggle(targetless.m)
    await fireWindow(new MouseEvent('mousedown'))
    assert.ok(panel() !== null, 'an event with no node target is ignored')
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() === null)
    await targetless.m.unmount()
  })

  test('a scroll or a resize retracts it rather than floating off the anchor', async () => {
    const { m } = await open()
    await toggle(m)
    await fireWindow(new Event('scroll'))
    assert.ok(panel() === null)

    await toggle(m)
    await fireWindow(new Event('resize'))
    assert.ok(panel() === null)
  })
})
