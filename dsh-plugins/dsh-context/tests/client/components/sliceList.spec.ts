import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { SliceList } from '../../../src/client/components/sliceList'
import type { SliceRow } from '../../../src/client/components/sliceList'
import { hover, mount, query, queryAll, unhover } from '../helpers/kit'

function HoverHarness(props: { rows: SliceRow[] }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  return h(SliceList, { rows: props.rows, hoverKey, onHoverKey: setHoverKey })
}

describe('SliceList', () => {
  test('rows render the primary line and the secondary count line in order', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '84%', count: '204.9k' },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '<1%', count: '3m 20s · 9 runs' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].querySelector('.lc-sl-pct')?.textContent, '84%')
    assert.equal(rows[0].querySelector('.lc-sl-dot')?.getAttribute('style'), 'background: rgb(255, 0, 0);')
    assert.equal(rows[0].querySelector('.lc-sl-label')?.textContent, 'Alpha')
    assert.equal(rows[0].querySelector('.lc-sl-sub')?.textContent, '204.9k')
    assert.equal(rows[1].querySelector('.lc-sl-pct')?.textContent, '<1%')
    assert.equal(rows[1].querySelector('.lc-sl-sub')?.textContent, '3m 20s · 9 runs')
    await m.unmount()
  })

  test('a row tip overrides the label tooltip and rides the row; a tipless row keeps the label title', async () => {
    const tip = 'Line one\n• Line two'
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '1%', count: '1', tip },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '1%', count: '1' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.equal(rows[0].getAttribute('title'), tip)
    assert.equal(rows[0].querySelector('.lc-sl-label')?.getAttribute('title'), tip)
    assert.equal(rows[1].getAttribute('title'), null)
    assert.equal(rows[1].querySelector('.lc-sl-label')?.getAttribute('title'), 'Beta')
    await m.unmount()
  })

  test('a zero-figure row dims; an empty count renders no secondary line', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '0%', count: '—', dim: true },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '—', count: '' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.ok(rows[0].className.includes('lc-sl-row-dim'))
    assert.ok(!rows[1].className.includes('lc-sl-row-dim'))
    assert.equal(queryAll(m.container, '.lc-sl-sub').length, 1)
    assert.equal(queryAll(m.container, '.lc-sl-pct').length, 2)
    await m.unmount()
  })

  test('hovering a row lights it; leaving the list clears it; without a relay hovers stay inert', async () => {
    const rowsIn: SliceRow[] = [
      { key: 'a', color: '#ff0000', label: 'Alpha', pct: '84%', count: '204.9k' },
      { key: 'b', color: '#00ff00', label: 'Beta', pct: '<1%', count: '3m 20s · 9 runs' },
    ]
    const m = await mount(h(HoverHarness, { rows: rowsIn }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(rows[1].className.includes('lc-sl-row-on'))
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await unhover(query(m.container, '.lc-sl'))
    assert.ok(!rows[1].className.includes('lc-sl-row-on'))
    await m.unmount()

    const inert = await mount(h(SliceList, { rows: [{ key: 'a', color: '#ff0000', label: 'Alpha', pct: '1%', count: '1' }] }))
    await hover(query(inert.container, '.lc-sl-row'))
    await unhover(query(inert.container, '.lc-sl'))
    assert.equal(queryAll(inert.container, '.lc-sl-row-on').length, 0)
    await inert.unmount()
  })
})
