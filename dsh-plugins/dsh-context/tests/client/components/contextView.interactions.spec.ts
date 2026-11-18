import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { UseChatLike } from '../../../src/client/services'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'
import { buttonByText, makeView, mountRich, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — interactions', () => {
  test('the browser column caps at the left cards\' full extent, flush with the column, live', async () => {
    const orig = Element.prototype.getBoundingClientRect
    let cardH = 100
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const box = orig.call(this)
      const parent = this.parentElement
      if (!this.classList.contains('lc-card') || parent === null
        || !parent.classList.contains('lc-col') || parent.classList.contains('lc-col-browser')) return box
      const top = 100 + [...parent.children].indexOf(this) * (cardH + 7)
      return { ...box, top, bottom: top + cardH }
    } as never
    try {
      const View = makeView(new TestClientCtx())
      const el = () => h(View, {
        sessionId: 'sv-cap',
        useProjection: projectionsFor(richTimeline(), {
          contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }] },
        }),
        useChat: (sel => sel({ legacy: { nodes: [] } })) as UseChatLike,
      })
      const m = await mount(el())
      const col = query<HTMLElement>(m.container, '.lc-col-browser')
      assert.equal(col.style.maxHeight, '207px', 'two 100px cards and their 7px gap')
      assert.equal(col.style.overflowY, '')
      assert.ok(query(m.container, '.lc-br-scroll') !== null)
      cardH = 150
      await m.update(el())
      assert.equal(col.style.maxHeight, '307px', 'the cap follows the grown cards on the next render')
      await m.unmount()
    } finally {
      Element.prototype.getBoundingClientRect = orig
    }
  })

  test('bar hover previews in the browser; a turn-less bar highlights nothing; hover loss on a granularity switch falls back', async () => {
    const m = await mountRich('sv-hover')
    const chart = query(m.container, '.lc-chart')
    const bar2 = query(m.container, '.lc-bar[data-seq="2"]')
    await hover(bar2)
    assert.ok(bar2.className.includes('lc-bar-hovered'))
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.equal(queryAll(m.container, '.lc-bar-hovered').length, 0)
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)

    const bar6 = query(m.container, '.lc-bar[data-seq="6"]')
    await hover(bar6)
    assert.ok(bar6.className.includes('lc-bar-hovered'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await m.unmount()
  })

  test('turn strip hover dims, strip click focuses the turn in turn granularity', async () => {
    const m = await mountRich('sv-strip')
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    await hover(turns[0])
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await unhover(query(m.container, '.lc-turns'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    await click(turns[0])
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    await m.unmount()
  })

  test('pinning a bar selects its step in the browser; unpinning returns to live', async () => {
    const m = await mountRich('sv-pin')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, 'live')

    const bar4 = query(m.container, '.lc-bar[data-seq="4"]')
    await click(bar4)
    assert.ok(bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, '4')
    assert.ok(query(m.container, '.lc-detail').textContent?.includes('✂') === true)

    await click(bar4)
    assert.ok(!bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, 'live')
    await m.unmount()
  })

  test('brief rows locate their node in the browser (input, mid response, live response)', async () => {
    const m = await mountRich('sv-brief')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    await click(query(m.container, '.lc-bar[data-seq="4"]'))
    const briefRows = queryAll(m.container, '.lc-brief-row')
    assert.equal(briefRows.length, 3)

    const inRow = briefRows.find(r => text(r).includes(DICT_EN['brief.input']))
    assert.ok(inRow !== undefined)
    await click(inRow)
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))

    const replyRow = briefRows.find(r => text(r).includes('reply two'))
    assert.ok(replyRow !== undefined)
    await click(replyRow)
    assert.equal(pick.value, '6')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply two'))

    await click(query(m.container, '.lc-bar[data-seq="6"]'))
    const lastReply = queryAll(m.container, '.lc-brief-row').find(r => text(r).includes('reply three'))
    assert.ok(lastReply !== undefined)
    await click(lastReply)
    assert.equal(pick.value, 'live')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply three'))
    await m.unmount()
  })

  test('category hover links the composition legend, browser rows, trend segments, and detail chips', async () => {
    const m = await mountRich('sv-link-trend')
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined)

    const compChip = query(comp, '.lc-legend .lc-chip')
    await hover(compChip)
    assert.ok(query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await unhover(compChip)
    assert.ok(!query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))

    const toolsRow = queryAll(m.container, '.lc-br-cat-row')[1]
    await hover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    const detailBar = query(m.container, '.lc-detail .lc-stacked')
    assert.ok(detailBar.className.includes('lc-stacked-dim'))
    assert.ok(queryAll(detailBar, '.lc-stacked-seg-on').length === 1)
    assert.ok(queryAll(m.container, '.lc-detail .lc-chip-on').length === 1, 'the matching detail chip lights too')

    await unhover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))

    await hover(query(m.container, '.lc-stacked-free'))
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))
    await unhover(query(m.container, '.lc-stacked-free'))

    const detailChip = queryAll(m.container, '.lc-detail .lc-legend .lc-chip')[1]
    await hover(detailChip)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    assert.equal(queryAll(comp, '.lc-legend .lc-chip-on').length, 1, 'the composition legend chip lights with it')
    await unhover(detailChip)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    await m.unmount()
  })

  test('expanding a browser category focuses the trend bars on it; collapsing restores all', async () => {
    const m = await mountRich('sv-focus')
    assert.equal(text(query(m.container, '.lc-axis-top')), '420', 'unfocused: the axis tops at the largest whole-bar total')
    assert.equal(queryAll(m.container, '.lc-bar[data-seq="4"] .lc-bar-stack > .lc-cat-seg').length, 5)

    await click(queryAll(m.container, '.lc-br-cat-row')[5])
    assert.equal(text(query(m.container, '.lc-axis-top')), '80')
    const segs = queryAll(m.container, '.lc-bar .lc-bar-stack > .lc-cat-seg')
    assert.equal(segs.length, 3)
    for (const s of segs) assert.equal(s.getAttribute('data-cat'), 'assistant')

    await click(queryAll(m.container, '.lc-br-cat-row')[5])
    assert.equal(text(query(m.container, '.lc-axis-top')), '420')
    assert.equal(queryAll(m.container, '.lc-bar[data-seq="4"] .lc-bar-stack > .lc-cat-seg').length, 5)
    await m.unmount()
  })

  test('the duration toggle overlays the active-time curve with a right-hand quartile axis; Adaptive toggles mount-locally', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-ms-curve',
      useProjection: projectionsFor(timeline({
        requests: [
          { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, activeMs: 1000 },
          { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400, activeMs: 2000 },
        ],
      })),
    }))

    const msBtn = () => buttonByText(m.container, DICT_EN['trend.duration'])
    assert.ok(msBtn().className.includes('lc-gran-on'), 'on at mount (the settings default)')
    assert.equal(queryAll(m.container, '.lc-duration polyline:not(.lc-dur-halo)').length, 1)
    assert.equal(text(query(m.container, '.lc-axis-r .lc-axis-top')), '2.0s')
    assert.equal(text(query(m.container, '.lc-axis-r .lc-axis-mid')), '1.0s')

    await click(msBtn())
    assert.equal(queryAll(m.container, '.lc-duration').length, 0)
    assert.equal(queryAll(m.container, '.lc-axis-r').length, 0)
    await click(msBtn())
    assert.equal(queryAll(m.container, '.lc-duration polyline:not(.lc-dur-halo)').length, 1)

    const adaptive = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    assert.ok(!adaptive().className.includes('lc-gran-on'), 'off at mount')
    await click(adaptive())
    assert.ok(adaptive().className.includes('lc-gran-on'))
    await click(adaptive())
    assert.ok(!adaptive().className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('the trend card\'s DNA toggle fingerprints the bars, combinable with Delta', async () => {
    const m = await mountRich('sv-trend-dna')
    const dnaBtn = () => buttonByText(m.container, DICT_EN['trend.dna'])
    assert.ok(!dnaBtn().className.includes('lc-gran-on'), 'off at mount')
    const dnaGroup = dnaBtn().parentElement as HTMLElement
    assert.ok(dnaGroup.className.includes('lc-trend-mods'))
    assert.equal(dnaBtn().getAttribute('title'), DICT_EN['trend.dnaTip'])
    assert.equal(dnaBtn().nextElementSibling, buttonByText(m.container, DICT_EN['trend.adaptive']), 'DNA rides left of the adaptive switch')

    await click(dnaBtn())
    assert.ok(dnaBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 3)

    const g = query(m.container, '.lc-bar[data-seq="4"] .lc-bar-dna').style.background
    const amberAt = g.indexOf('color-amber-500')
    const greenAt = g.indexOf('color-green-500')
    const blueAt = g.indexOf('color-blue-500')
    const tealAt = g.indexOf('color-teal-500')
    assert.ok(amberAt >= 0 && greenAt > amberAt && blueAt > greenAt && tealAt > blueAt, g)

    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 2)
    assert.ok(text(query(m.container, '.lc-axis-mid')).includes('0'), 'the delta zero line label rides the axis')

    await click(dnaBtn())
    assert.ok(!dnaBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 0)
    assert.ok(queryAll(m.container, '.lc-bar-up').length > 0, 'delta arms are back')

    const browserDna = () => query(m.container, '.lc-br-dna-ctl .lc-gran-btn')
    await click(dnaBtn())
    assert.ok(browserDna().className.includes('lc-gran-on'), 'the browser follows the trend toggle')
    assert.equal(queryAll(m.container, '.lc-br-bar-dna').length, 1)
    await click(browserDna())
    assert.ok(!dnaBtn().className.includes('lc-gran-on'), 'the trend follows the browser toggle')
    assert.equal(queryAll(m.container, '.lc-br-bar-dna').length, 0)
    await m.unmount()
  })

  test('clicking a DNA band reveals that item in the Context browser', async () => {    const m = await mountRich('sv-dna-reveal')
    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    const dnaDiv = query(m.container, '.lc-bar[data-seq="4"] .lc-bar-dna')
    dnaDiv.getBoundingClientRect = () => ({ top: 0, left: 0, right: 14, bottom: 112, width: 14, height: 112, x: 0, y: 0, toJSON: () => null }) as DOMRect
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 0 })) })
    await flush()
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))
    await m.unmount()
  })

  test('delta mode pairs the detail with the previous record; first bar has none', async () => {
    const m = await mountRich('sv-delta')
    const chart = query(m.container, '.lc-chart')
    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    assert.ok(query(m.container, '.lc-bar[data-seq="2"]').className.includes('lc-bar-hovered'))
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await m.unmount()
  })

  test('event-kind filter narrows, unions, drops, and resets', async () => {
    const m = await mountRich('sv-kinds')
    const countEvents = () => queryAll(m.container, '.lc-event').length
    const kindBtn = (k: string) => query(m.container, `.lc-kinds [data-kind="${k}"]`) as HTMLElement
    assert.equal(countEvents(), 2)
    assert.deepEqual(
      queryAll(m.container, '.lc-kinds .lc-kind-n').map(el => text(el)),
      ['1', '1', '0'],
    )

    await click(kindBtn('inject'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 2)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('inject'))
    assert.equal(countEvents(), 2)
    await m.unmount()
  })
})
