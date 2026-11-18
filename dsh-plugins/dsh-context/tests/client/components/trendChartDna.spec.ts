import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { CATS } from '../../../src/client/categories'
import type { TrendBand } from '../../../src/client/dna'
import type { SurfaceNode } from '../../../src/shared/types'
import { mount, query, queryAll, unhover } from '../helpers/kit'
import { CHART_H, TrendChart, kit, propsOf, req } from './trendChartHarness'

describe('TrendChart DNA mode', () => {
  const COLORS = Object.fromEntries(CATS.map(c => [c.key, c.color])) as Record<string, string>

  function dnaBands(spec: [string, string, number, SurfaceNode?][]): TrendBand[] {
    let off = 0
    return spec.map(([key, cat, tokens, node]) => {
      const band = (node !== undefined
        ? { key, cat, tokens, off, color: COLORS[cat], node }
        : { key, cat, tokens, off, color: COLORS[cat] }) as TrendBand
      off += tokens
      return band
    })
  }

  function stubBarRect(el: HTMLElement): void {
    el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 14, bottom: CHART_H, width: 14, height: CHART_H, x: 0, y: 0, toJSON: () => null }) as DOMRect
  }

  async function move(el: HTMLElement, clientY: number): Promise<void> {
    await act(async () => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY })) })
  }

  test('paints one coalesced gradient per bar — read order, proportional heights, zero bands dropped', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const r2 = req(2, { turn: 1, step: 1, total: 600 })
    const d1 = dnaBands([
      ['sys', 'system', 100],
      ['tool:bash', 'tools', 50],
      ['n1', 'assistant', 80, { seq: 1, cat: 'assistant', tokens: 80 }],
      ['n2', 'assistant', 70, { seq: 2, cat: 'assistant', tokens: 70 }],
    ])
    const d2 = dnaBands([
      ['sys', 'system', 200],
      ['n1', 'assistant', 80, { seq: 1, cat: 'assistant', tokens: 80 }],
      ['n3', 'user', 100, { seq: 3, cat: 'user', tokens: 100 }],
      ['n4', 'user', 0, { seq: 4, cat: 'user', tokens: 0 }],
      ['n5', 'tool', 220, { seq: 5, cat: 'tool', tokens: 220 }],
    ])
    const m = await mount(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2] })))
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 2)
    assert.equal(dnaDivs[0].style.height, `${Math.round(300 / 600 * CHART_H)}px`)
    assert.equal(dnaDivs[1].style.height, `${CHART_H}px`)
    const g1 = dnaDivs[0].style.background
    assert.ok(g1.startsWith('linear-gradient(to top, '), g1)
    assert.ok(g1.includes('var(--color-indigo-500) 0px, var(--color-indigo-500) 18px'), g1)
    assert.ok(g1.includes('var(--color-amber-500) 18px, var(--color-amber-500) 28px'), g1)
    assert.ok(g1.includes('var(--color-blue-500) 28px, var(--color-blue-500) 56px'), g1)
    const g2 = dnaDivs[1].style.background
    assert.ok(g2.includes('var(--color-indigo-500) 0px, var(--color-indigo-500) 38px'), g2)
    assert.ok(g2.includes('var(--color-blue-500) 38px, var(--color-blue-500) 52px'), g2)
    assert.ok(g2.includes('var(--color-green-500) 52px, var(--color-green-500) 70px'), g2)
    assert.ok(g2.includes('var(--color-teal-500) 70px, var(--color-teal-500) 112px'), g2)
    assert.equal(queryAll(m.container, '.lc-bar-stack').length, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    await act(async () => { dnaDivs[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await m.unmount()

    const r1b = req(1, { turn: 1, step: 0, total: 1, system: 1 })
    const r2b = req(2, { turn: 1, step: 1, total: 50000, system: 50000 })
    const tiny = await mount(h(TrendChart, propsOf([r1b, r2b], {
      dna: [dnaBands([['sys', 'system', 1]]), dnaBands([['sys', 'system', 50000]])],
    })))
    const tinyBars = queryAll<HTMLElement>(tiny.container, '.lc-bar-dna')
    assert.ok(tinyBars[0].style.background.length > 0)
    assert.ok(!tinyBars[0].style.background.includes('linear-gradient(to top, )'))
    assert.ok(tinyBars[0].style.background.includes('var(--color-indigo-500)'), 'a bar far below the shared scale keeps its colour')
    await tiny.unmount()

    const empty = await mount(h(TrendChart, propsOf([req(1, { turn: 1, step: 0, total: 0 }), req(2, { turn: 1, step: 1, total: 600 })], {
      dna: [dnaBands([['n1', 'user', 0, { seq: 1, cat: 'user', tokens: 0 }]]), dnaBands([['n2', 'user', 600, { seq: 2, cat: 'user', tokens: 600 }]])],
    })))
    assert.equal(queryAll(empty.container, '.lc-bar-dna').length, 1, 'a bar whose bands carry no tokens paints no DNA strip')
    await empty.unmount()

    const focused = await mount(h(TrendChart, propsOf(
      [req(1, { turn: 1, step: 0, total: 300 }), req(2, { turn: 1, step: 1, total: 600, user: 150 })],
      {
        dna: [
          dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
          dnaBands([['sys', 'system', 100], ['n2', 'user', 500, { seq: 2, cat: 'user', tokens: 500 }]]),
        ],
        focusCat: 'user',
      },
    )))
    const focusedBars = queryAll(focused.container, '.lc-bar-dna')
    assert.equal(focusedBars[0]!.style.height, `${Math.round(CHART_H * 300 / 600)}px`, 'full-context share, not the focused category share')
    assert.equal(focusedBars[1]!.style.height, `${CHART_H}px`)
    assert.ok(focusedBars[0]!.style.background.includes('var(--color-indigo-500)'), 'the system band is still painted')
    await focused.unmount()
  })

  test('a band click reports the picked item with the bar seq, for the Context browser reveal', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const d1 = dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]])
    const picks: [number, string][] = []
    const m = await mount(h(TrendChart, propsOf([r1], {
      dna: [d1],
      onPickBand: (seq, band) => { picks.push([seq, band.key]) },
    })))
    const dnaDiv = query(m.container, '.lc-bar-dna')
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 30 })) })
    assert.deepEqual(picks, [[1, 'sys']])
    await m.unmount()
  })

  test('hit-tests the pointer into a band; the same item lights its lifetime slice in every bar', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const r2 = req(2, { turn: 1, step: 1, total: 600 })
    const n1: SurfaceNode = { seq: 1, cat: 'user', tokens: 100, text: 'hello' }
    const d1 = dnaBands([['n1', 'user', 100, n1], ['n2', 'assistant', 200, { seq: 2, cat: 'assistant', tokens: 200 }]])
    const d2 = dnaBands([
      ['n1', 'user', 100, n1],
      ['n3', 'tool', 400, { seq: 3, cat: 'tool', tokens: 400, tool: 'bash' }],
      ['n4', 'user', 0, { seq: 4, cat: 'user', tokens: 0 }],
      ['n5', 'tool', 100, { seq: 5, cat: 'tool', tokens: 100, tool: 'write' }],
    ])
    const m = await mount(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2], hoveredSeq: 1 })))
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 2)
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''

    await move(dnaDivs[0], 40)
    let slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 2)
    assert.equal(slices[0].style.bottom, '0px')
    assert.equal(slices[0].style.height, `${Math.round(100 / 600 * CHART_H)}px`)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '100' })))

    stubBarRect(dnaDivs[0])
    stubBarRect(dnaDivs[1])
    await move(dnaDivs[0], CHART_H + 20)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '100' })))
    await move(dnaDivs[0], 0)
    slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 1)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('assistant'), n: '200' })))
    await m.update(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2], hoveredSeq: 2 })))
    await move(dnaDivs[1], -10)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: 'write', n: '100' })))

    await unhover(dnaDivs[1])
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    assert.ok(tipText().includes(kit.t('tip.total', { n: '600' })))

    await move(dnaDivs[0], 100)
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 2)
    await unhover(query(m.container, '.lc-chart'))
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    await m.unmount()
  })

  test('DNA + delta diffs each item against the previous bar — new items rise, removed items hang', async () => {
    const rs = [
      req(1, { turn: 1, step: 0, total: 300 }),
      req(2, { turn: 1, step: 1, total: 300 }),
      req(3, { turn: 1, step: 2, total: 600 }),
      req(4, { turn: 2, step: 0, total: 500 }),
      req(5, { turn: 2, step: 1, total: 300 }),
    ]
    const ds = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }], ['a1', 'assistant', 60, { seq: 2, cat: 'assistant', tokens: 60 }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }], ['a1', 'assistant', 90, { seq: 2, cat: 'assistant', tokens: 90 }], ['t1', 'tool', 120, { seq: 3, cat: 'tool', tokens: 120, tool: 'bash' }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }], ['u1', 'user', 40, { seq: 4, cat: 'user', tokens: 40 }], ['u2', 'user', 40, { seq: 5, cat: 'user', tokens: 40 }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }]]),
    ]
    const picks: [number, string][] = []
    const m = await mount(h(TrendChart, propsOf(rs, {
      dna: ds,
      mode: 'delta',
      hoveredSeq: 4,
      adaptive: true,
      onPickBand: (seq, band) => { picks.push([seq, band.key]) },
    })))
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 4, 'the first bar has no baseline and carries no strip')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+150')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-210')

    assert.equal(dnaDivs[0].style.height, '19px')
    assert.equal(dnaDivs[0].style.bottom, '65px')
    assert.ok(dnaDivs[0].style.background.includes('var(--color-blue-500) 0%, var(--color-blue-500) 100%'))

    assert.equal(dnaDivs[1].style.height, '47px')
    const g3 = dnaDivs[1].style.background
    assert.ok(g3.includes('var(--color-blue-500) 0%, var(--color-blue-500) 20%'), g3)
    assert.ok(g3.includes('var(--color-teal-500) 20%, var(--color-teal-500) 100%'), g3)

    assert.equal(dnaDivs[2].style.height, '90px')
    assert.equal(dnaDivs[2].style.bottom, '0px')
    assert.equal(dnaDivs[2].style.transformOrigin, '50% 72.41%')
    const g4 = dnaDivs[2].style.background
    assert.ok(g4.includes('var(--color-teal-500) 0%, var(--color-teal-500) 41.38%'), g4)
    assert.ok(g4.includes('var(--color-blue-500) 41.38%, var(--color-blue-500) 72.41%'), g4)
    assert.ok(g4.includes('var(--color-green-500) 72.41%, var(--color-green-500) 100%'), g4)

    assert.equal(dnaDivs[3].style.height, '25px')
    assert.equal(dnaDivs[3].style.bottom, '40px')

    await move(dnaDivs[2], 40)
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: 'bash', n: '-120' })))
    stubBarRect(dnaDivs[2])
    await move(dnaDivs[2], 0)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '+40' })), 'the very top is the last up band')
    await move(dnaDivs[2], 55)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('assistant'), n: '-90' })), 'the down arm walks read order from the zero line')
    await act(async () => { dnaDivs[2].dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 55 })) })
    assert.deepEqual(picks, [[4, 'a1']])

    stubBarRect(dnaDivs[1])
    await move(dnaDivs[1], 0)
    const slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 2)
    assert.equal(slices[0].style.bottom, `${Math.round(65 + 30 * 112 / 360)}px`)
    assert.equal(slices[0].style.height, `${Math.max(1, Math.round(120 * 112 / 360))}px`)
    assert.equal(slices[1].style.bottom, `${Math.round(65 - 210 * 112 / 360)}px`)
    assert.equal(slices[1].style.height, `${Math.max(1, Math.round(120 * 112 / 360))}px`)
    await unhover(dnaDivs[1])
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    await m.unmount()

    const downOnlyReqs = [req(1, { turn: 1, step: 0, total: 300 }), req(2, { turn: 1, step: 1, total: 260 })]
    const downOnlyBands = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
      dnaBands([['sys', 'system', 100]]),
    ]
    const downOnly = await mount(h(TrendChart, propsOf(downOnlyReqs, { dna: downOnlyBands, mode: 'delta', hoveredSeq: 2 })))
    const dnaDiv = query(downOnly.container, '.lc-bar-dna')
    stubBarRect(dnaDiv)
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 0 })) })
    await move(dnaDiv, 0)
    assert.ok((query(downOnly.container, '.lc-chart-tip').textContent ?? '').includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '-200' })))
    await downOnly.unmount()
  })

  test('combo hover off the arms keeps the delta row — the churn is never labeled a total (#96)', async () => {
    const rs = [
      req(1, { turn: 1, step: 0, total: 300 }),
      req(2, { turn: 1, step: 1, total: 260, tool: 20 }),
    ]
    const ds = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
      dnaBands([['sys', 'system', 100]]),
    ]
    const m = await mount(h(TrendChart, propsOf(rs, { dna: ds, mode: 'delta', hoveredSeq: 2 })))
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''
    assert.ok(tipText().includes(kit.t('tip.delta', { n: '-40' })))
    assert.ok(!tipText().includes(kit.t('tip.total', { n: '40' })))
    await m.unmount()
  })

})
