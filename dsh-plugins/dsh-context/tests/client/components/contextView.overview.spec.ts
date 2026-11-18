
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { act, createElement as h } from 'react'
import { DICT_EN } from '../../../src/client/i18n'
import type { OverviewAutoSteps } from '../../../src/shared/types'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, mount, pinRect, query, queryAll, text } from '../helpers/kit'
import { buttonByText, makeView, mountRich, projectionsFor, settingsWith, T0, timeline } from './contextViewHarness'

function stepsTimeline(n: number) {
  return timeline({
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    requests: Array.from({ length: n }, (_, i) => ({
      seq: (i + 1) * 2,
      turn: Math.floor(i / 2) + 1,
      step: (i % 2) + 1,
      time: T0 + i * 1000,
      system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0,
      total: 330,
    })),
  })
}

function viewWith(value: OverviewAutoSteps, sessionId: string, steps: number) {
  const View = makeView(new TestClientCtx(), settingsWith({ overviewAutoSteps: value }))
  return { View, props: { sessionId, useProjection: projectionsFor(stepsTimeline(steps)) } }
}

describe('ContextView — overview face', () => {
  test('the Overview chip rides right of Duration and clears DNA/Adaptive on activation', async () => {
    const m = await mountRich('sv-overview-chip')
    const mods = buttonByText(m.container, DICT_EN['trend.dna']).parentElement as HTMLElement
    const last = (mods.lastElementChild as HTMLElement).textContent
    assert.equal(last, DICT_EN['trend.overview'], 'Overview is the mods group\'s last chip')

    const overview = () => buttonByText(m.container, DICT_EN['trend.overview'])
    const dna = () => buttonByText(m.container, DICT_EN['trend.dna'])
    const adaptive = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    await click(dna())
    assert.ok(dna().className.includes('lc-gran-on'))
    await click(overview())
    assert.ok(overview().className.includes('lc-gran-on'))
    assert.equal(dna().className.includes('lc-gran-on'), false)
    await click(dna())
    assert.equal(overview().className.includes('lc-gran-on'), false)
    assert.ok(dna().className.includes('lc-gran-on'))
    await click(adaptive())
    assert.ok(dna().className.includes('lc-gran-on'))
    assert.ok(adaptive().className.includes('lc-gran-on'))
    await click(overview())
    assert.equal(dna().className.includes('lc-gran-on'), false)
    assert.equal(adaptive().className.includes('lc-gran-on'), false)
    assert.ok(overview().className.includes('lc-gran-on'))
    await click(overview())
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    await m.unmount()
  })

  test('the overview face swaps the bars for a full-width ribbon with the same detail flow', async () => {
    const m = await mountRich('sv-overview-ribbon')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.match(query(m.container, '.lc-chart-scroll').className, /lc-chart-fit/)
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 2 112')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '420')
    assert.deepEqual(queryAll(m.container, '.lc-trend-flag-label').map(f => f.textContent), ['2', '3'])
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['1', '0'])

    await click(query(m.container, '.lc-turn'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.match(query(m.container, '.lc-fit-cursor').className, /lc-fit-pin/)
    assert.ok(text(m.container).includes(DICT_EN['detail.turn'].replace('{t}', '1').replace('{n}', '2')))
    await m.unmount()
  })

  test('clicking a ribbon band opens that category in the browser and focuses the chart on it', async () => {
    const m = await mountRich('sv-overview-band-open')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    const surface = query(m.container, '.lc-chart')
    pinRect(surface, 400, 130)
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 60 }))
    })
    await flush()
    const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes(DICT_EN['cat.tools']), 'the tools category opens')
    const polys = queryAll(m.container, '.lc-fit-svg polygon')
    assert.equal(polys.length, 1)
    assert.equal(polys[0].getAttribute('data-cat'), 'tools')
    assert.equal(query(m.container, '.lc-fit-pin').style.left, '50%')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    await m.unmount()
  })

  test('the configured step count mounts on the ribbon face; crossing it switches once, and a manual toggle-off sticks', async () => {
    const atThreshold = viewWith('100', 'sv-overview-auto', 100)
    const direct = await mount(h(atThreshold.View, atThreshold.props))
    assert.equal(queryAll(direct.container, '.lc-bar').length, 0)
    assert.ok(query(direct.container, '.lc-fit-svg'))
    assert.ok(buttonByText(direct.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'))
    await direct.unmount()

    const { View, props } = viewWith('100', 'sv-overview-auto-grow', 99)
    const m = await mount(h(View, props))
    assert.equal(queryAll(m.container, '.lc-bar').length, 99)
    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    await m.update(h(View, { ...props, useProjection: projectionsFor(stepsTimeline(100)) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.ok(buttonByText(m.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'))
    assert.equal(buttonByText(m.container, DICT_EN['trend.dna']).className.includes('lc-gran-on'), false)
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 100)
    await m.update(h(View, { ...props, useProjection: projectionsFor(stepsTimeline(101)) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 101)
    await m.unmount()
  })

  test('a higher threshold or the off choice keeps the bars', async () => {
    for (const [choice, steps] of [['300', 100], ['off', 300]] as const) {
      const { View, props } = viewWith(choice, `sv-overview-auto-${choice}`, steps)
      const m = await mount(h(View, props))
      assert.ok(queryAll(m.container, '.lc-bar').length > 0, `${choice} leaves the bars face on`)
      assert.equal(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-fit'), false)
      await m.unmount()
    }
  })

  test('a manual toggle-off survives a session round trip out of an auto-opened session', async () => {
    const { View, props } = viewWith('100', 'sv-overview-auto-sticky', 100)
    const m = await mount(h(View, props))
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 100)
    await m.update(h(View, { ...props, sessionId: 'sv-overview-auto-other', useProjection: projectionsFor(stepsTimeline(3)) }))
    assert.ok(queryAll(m.container, '.lc-bar').length > 0)
    await m.update(h(View, props))
    assert.equal(queryAll(m.container, '.lc-bar').length, 100)
    await m.unmount()
  })
})
