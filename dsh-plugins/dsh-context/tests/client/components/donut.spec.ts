import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import type { DonutSegment } from '../../../src/client/components/donut'
import { hover, mount, query, queryAll, unhover } from '../helpers/kit'

function HoverHarness(props: { segments: DonutSegment[] }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  return h(Donut, { segments: props.segments, centerTop: 'x', hoverKey, onHoverKey: setHoverKey })
}

describe('Donut', () => {
  test('segments render one circle each, in order, with accumulating offsets', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 30 },
        { key: 'b', color: '#00ff00', value: 70 },
      ],
      centerTop: '2h 14m',
      centerSub: 'active time',
    }))
    const circles = queryAll(m.container, 'circle')
    assert.equal(circles.length, 2)
    const dash = (el: Element): string => el.getAttribute('stroke-dasharray') ?? ''
    const offset = (el: Element): number => Number(el.getAttribute('stroke-dashoffset'))
    assert.equal(dash(circles[0]), '29.5 70.5')
    assert.equal(offset(circles[0]), 124.75)
    assert.equal(dash(circles[1]), '69.5 30.5')
    assert.equal(offset(circles[1]), 94.75)
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '2h 14m')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'active time')
    await m.unmount()
  })

  test('non-positive and non-finite values are skipped; the surviving positive slice paints alone', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 0 },
        { key: 'b', color: '#00ff00', value: -5 },
        { key: 'c', color: '#0000ff', value: Number.NaN },
        { key: 'd', color: '#ffffff', value: 100 },
      ],
      centerTop: 'x',
    }))
    const circles = queryAll(m.container, 'circle')
    assert.equal(circles.length, 1)
    assert.equal(circles[0].style.stroke, 'rgb(255, 255, 255)')
    await m.unmount()
  })
})

describe('Donut slice divider', () => {
  const lenOf = (el: Element): number => Number((el.getAttribute('stroke-dasharray') ?? '').split(' ')[0])

  test('a lone slice keeps a full ring, and a sliver is cut a quarter per end', async () => {
    const lone = await mount(h(Donut, { segments: [{ key: 'a', color: '#ff0000', value: 42 }], centerTop: 'x' }))
    assert.equal(lenOf(query(lone.container, '.lc-donut-seg')), 100)
    await lone.unmount()

    const sliver = await mount(h(Donut, {
      segments: [
        { key: 'tiny', color: '#ff0000', value: 0.2 },
        { key: 'rest', color: '#00ff00', value: 99.8 },
      ],
      centerTop: 'x',
    }))
    const [tiny, rest] = queryAll(sliver.container, '.lc-donut-seg')
    assert.ok(Math.abs(lenOf(tiny) - 0.1) < 1e-9)
    assert.ok(Math.abs(lenOf(rest) - 99.3) < 1e-9)
    await sliver.unmount()
  })
})

describe('Donut entrance sweep', () => {
  test('segments carry the sweep-in stagger slot in paint order', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 30 },
        { key: 'b', color: '#00ff00', value: 70 },
      ],
      centerTop: 'x',
    }))
    const arcs = queryAll(m.container, '.lc-donut-seg')
    assert.equal((arcs[0] as HTMLElement).style.getPropertyValue('--lc-i'), '0')
    assert.equal((arcs[1] as HTMLElement).style.getPropertyValue('--lc-i'), '1')
    await m.unmount()
  })
})

describe('Donut hover link', () => {
  const SEGS: DonutSegment[] = [
    { key: 'a', color: '#ff0000', value: 30 },
    { key: 'b', color: '#00ff00', value: 70 },
  ]

  test('hovering an arc dims the ring and lights it; a ghost key or a relay-less ring stays at rest', async () => {
    const m = await mount(h(HoverHarness, { segments: SEGS }))
    const arcs = queryAll(m.container, '.lc-donut-seg')
    const cls = (el: Element): string => el.getAttribute('class') ?? ''
    await hover(arcs[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(cls(arcs[0]).includes('lc-donut-seg-on'))
    assert.ok(!cls(arcs[1]).includes('lc-donut-seg-on'))
    await unhover(query(m.container, '.lc-donut'))
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(!cls(arcs[0]).includes('lc-donut-seg-on'))
    await m.unmount()

    const ghost = await mount(h(Donut, { segments: SEGS, centerTop: 'x', hoverKey: 'ghost' }))
    assert.ok(!query(ghost.container, '.lc-donut').className.includes('lc-donut-dim'))
    await ghost.unmount()

    const inert = await mount(h(Donut, { segments: SEGS, centerTop: 'x' }))
    await hover(query(inert.container, '.lc-donut-seg'))
    await unhover(query(inert.container, '.lc-donut'))
    assert.ok(!query(inert.container, '.lc-donut').className.includes('lc-donut-dim'))
    await inert.unmount()
  })
})
