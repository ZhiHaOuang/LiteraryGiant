import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { CatFocus, ContextBrowserProps } from '../../../src/client/components/browser'
import type { ContextHeaders } from '../../../src/shared/types'
import { click, flush, hover, mount, query, queryAll, surfaceNode, text, tipRows, unhover, type Mounted } from '../helpers/kit'
import { Browser, catRow, filterStat, kit, props, req, tl, typeToolSearch, withEpochContent } from './browserHarness'

describe('ContextBrowser DNA mode and the open-category bar pin', () => {
  const dnaHeaders: ContextHeaders = {
    headers: [{
      seq: 1, time: 1000, systemTokens: 100,
      tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 25 }],
    }],
  }
  const dnaData = tl({
    current: { system: 100, tools: 75, user: 20, inject: 10, skill: 0, assistant: 40, tool: 30, total: 275 },
    requests: [req({ seq: 20, turn: 1, step: 0, system: 100, tools: 75, user: 20, inject: 0, assistant: 40, tool: 30, total: 265 })],
    nodes: [
      surfaceNode({ seq: 2, tokens: 20, time: 2000, text: 'hi' }),
      surfaceNode({ seq: 3, cat: 'tool', tokens: 30, time: 3000, tool: 'bash' }),
      surfaceNode({ seq: 4, cat: 'assistant', tokens: 40 }),
      surfaceNode({ seq: 5, cat: 'inject', tokens: 10, form: 'notice' }),
    ],
  })

  function dnaButton(m: Mounted): HTMLElement {
    return query(m.container, '.lc-br-dna-ctl .lc-gran-btn')
  }

  function bands(m: Mounted): HTMLElement[] {
    return queryAll(m.container, '.lc-stacked-seg')
  }

  function flatRows(m: Mounted): HTMLElement[] {
    return queryAll(m.container, '.lc-br-flat > .lc-br-elem')
  }

  function flatRow(m: Mounted, label: string): HTMLElement {
    const row = flatRows(m).find(el => text(el).includes(label))
    assert.ok(row !== undefined, `flat row "${label}" not found`)
    return query(row, '.lc-br-elem-row')
  }

  function regionByHead(m: Mounted, label: string): HTMLElement {
    const region = queryAll(m.container, '.lc-map-cat')
      .find(r => queryAll(r, '.lc-map-cat-label').some(l => l.textContent === label))
    assert.ok(region !== undefined, `a map region headed "${label}"`)
    return region
  }

  test('the DNA toggle is parent-linked when both props arrive; a lone prop is ignored', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders, dna: true, onDnaChange: () => {} })))
    assert.equal(bands(m).length, 7)
    assert.ok(dnaButton(m).className.includes('lc-gran-on'))
    await m.update(h(Browser, props({ data: dnaData, headers: dnaHeaders, dna: true })))
    assert.equal(bands(m).length, 6, 'unlinked: the local toggle is off')
    const calls: boolean[] = []
    await m.update(h(Browser, props({
      data: dnaData, headers: dnaHeaders, dna: true,
      onDnaChange: (on) => { calls.push(on) },
    })))
    await click(dnaButton(m))
    assert.deepEqual(calls, [false])
    assert.equal(bands(m).length, 7, 'still on until the parent re-renders the prop')
    await m.unmount()
  })

  test('the toggle redraws the composition bar as one band per item, in prompt order', async () => {    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    const normal = bands(m).map(seg => seg.style.width)
    assert.deepEqual(normal, [100, 75, 20, 10, 40, 30].map(v => `${v / 275 * 100}%`))
    assert.ok(!bands(m)[0].className.includes('lc-stacked-seg-pick'))
    assert.ok(!query(m.container, '.lc-br-bar').className.includes('lc-br-bar-dna'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0)

    const btn = dnaButton(m)
    assert.equal(text(btn), 'DNA Mode')
    assert.equal(query(m.container, '.lc-br-dna-ctl').getAttribute('title'), kit.t('browser.dnaTip'))
    await click(btn)
    const segs = bands(m)
    assert.deepEqual(segs.map(seg => seg.style.width), [100, 50, 25, 20, 30, 40, 10].map(v => `${v / 275 * 100}%`))
    assert.ok(segs.every(seg => seg.className.includes('lc-stacked-seg-pick')))
    assert.ok(query(m.container, '.lc-br-bar').className.includes('lc-br-bar-dna'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 1, 'the per-item tooltip slot mounts')
    assert.ok(btn.className.includes('lc-gran-on'))

    await click(btn)
    assert.equal(bands(m).length, 6, 'toggling off restores the category composition')
    assert.ok(!btn.className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('band hover floats the per-item tooltip locally; a mirrored category key lights that category\'s bands', async () => {
    const hovers: (string | null)[] = []
    const wired = (hoverKey: string | null) => h(Browser, props({ data: dnaData, headers: dnaHeaders, hoverKey, onHoverKey: (k) => { hovers.push(k) } }))
    const m = await mount(wired(null))
    await click(dnaButton(m))

    await hover(bands(m)[3])
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), [`User Messages · ${kit.fmtTime(2000)}`, '≈20 · 7% of used context', null])
    assert.deepEqual(hovers, [], 'DNA hovers stay on the bar — the overview keeps showing the live category composition')
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    await hover(bands(m)[5])
    assert.deepEqual(tipRows(tip), ['Assistant Messages', '≈40 · 15% of used context', null])
    await unhover(query(m.container, '.lc-stacked'))
    assert.ok(!tip.className.includes('lc-bar-tip-on'))

    await m.update(wired('tool'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false, false])
    assert.ok(!query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    await m.update(wired('free'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')), "the overview's free key lights nothing here")
    await m.unmount()
  })

  test('band labels: skill tag, nameless tool result, formless injection; a header-less surface shows message bands only', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 40, skill: 0, assistant: 0, tool: 20, total: 60 },
      nodes: [
        surfaceNode({ seq: 1, cat: 'inject', tokens: 10, skill: 'code' }),
        surfaceNode({ seq: 2, cat: 'tool', tokens: 20 }),
        surfaceNode({ seq: 3, cat: 'inject', tokens: 30 }),
      ],
    })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(dnaButton(m))
    assert.equal(bands(m).length, 3)
    const tip = query(m.container, '.lc-bar-tip')
    await hover(bands(m)[0])
    assert.deepEqual(tipRows(tip), ['Skill · code', '≈10 · 17% of used context', null])
    await hover(bands(m)[1])
    assert.deepEqual(tipRows(tip), ['?', '≈20 · 33% of used context', null])
    await hover(bands(m)[2])
    assert.deepEqual(tipRows(tip), ['Context Injection', '≈30 · 50% of used context', null])
    await m.unmount()
  })

  test('clicking a band opens its exact row in the flat feed, revealed within the card only; a stale filter is cleared', async () => {
    const scrolls: unknown[] = []
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolls.push(arg) } as never
    try {
      const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
      await click(dnaButton(m))
      await click(bands(m)[4])
      const onRows = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(onRows.length, 1)
      assert.ok(text(onRows[0]).includes('bash'))
      assert.deepEqual(scrolls, [], 'the pick reveals inside the card — never a scrollIntoView that could drag the page')

      await typeToolSearch(m, 'zzz')
      assert.ok(text(query(m.container, '.lc-br-flat')).includes('No rows match'))
      await click(bands(m)[3])
      assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, '')
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 1)
      assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('hi'))

      await click(bands(m)[1])
      assert.ok(text(query(m.container, '.lc-br-content')).includes('token estimates only'))
      assert.ok(flatRow(m, 'Tool Schemas').closest('.lc-br-elem')?.className.includes('lc-br-elem-on'))
      await click(flatRow(m, 'Tool Schemas'))
      assert.equal(queryAll(m.container, '.lc-br-content').length, 0, 'the group closes with the schema row open')

      await click(bands(m)[0])
      assert.ok(text(query(m.container, '.lc-br-flat')).includes('token estimates only'))
      await m.unmount()
    } finally {
      Element.prototype.scrollIntoView = orig
    }
  })

  test('the DNA feed lays every item out in reverse reading order: newest message on top, header groups last', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    await click(dnaButton(m))
    assert.ok(query(m.container, '.lc-br-flat'))
    assert.equal(queryAll(m.container, '.lc-br-cat-row').length, 0, 'the accordion yields to the feed')
    const labels = flatRows(m).map(r => text(r))
    assert.ok(labels[0].includes('#4') && labels[0].includes('Injected Context') && labels[0].includes('Notice'))
    assert.ok(labels[1].includes('#3') && labels[1].includes('Assistant Messages'))
    assert.ok(labels[2].includes('#2') && labels[2].includes('bash'))
    assert.ok(labels[3].includes('#1') && labels[3].includes('User Messages') && labels[3].includes('hi'))
    assert.ok(labels[4].includes('Tool Schemas') && labels[4].includes('2 Items') && labels[4].includes('≈75'))
    assert.ok(labels[5].includes('System Prompt') && labels[5].includes('≈100'))

    await click(flatRow(m, 'Tool Schemas'))
    const toolRows = queryAll(m.container, '.lc-br-content .lc-br-elem-row')
    assert.equal(toolRows.length, 2)
    assert.ok(text(toolRows[0]).includes('bash') && text(toolRows[1]).includes('write'))
    assert.ok(flatRow(m, 'Tool Schemas').closest('.lc-br-elem')?.className.includes('lc-br-elem-on'))
    await click(flatRow(m, 'System Prompt'))
    assert.ok(text(query(m.container, '.lc-br-flat')).includes('token estimates only'))
    await m.unmount()
  })

  test('the DNA feed text lens filters message rows, the tools group, and the system row', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    await click(dnaButton(m))
    assert.equal(filterStat(m), '×6 ≈275')
    await typeToolSearch(m, 'bash')
    const rows = flatRows(m)
    assert.equal(rows.length, 2, 'the matching tool result and the tools group stay')
    assert.ok(text(rows[0]).includes('#2') && text(rows[1]).includes('Tool Schemas'))
    assert.equal(filterStat(m), '×2 ≈105')
    await typeToolSearch(m, 'zzz')
    assert.equal(filterStat(m), '×0 ≈0')
    assert.ok(text(query(m.container, '.lc-br-flat')).includes('No rows match'))
    await typeToolSearch(m, '')
    assert.equal(flatRows(m).length, 6)
    assert.equal(filterStat(m), '×6 ≈275')
    await m.unmount()

    const pluginHeaders: ContextHeaders = {
      headers: [{
        seq: 1, time: 1000, systemTokens: 100,
        tools: [{ name: 'bash', tokens: 50, plugin: 'dsh-shell' }, { name: 'write', tokens: 25 }],
      }],
    }
    const plugin = await mount(h(Browser, props({ data: dnaData, headers: pluginHeaders })))
    await click(dnaButton(plugin))
    await typeToolSearch(plugin, 'dsh-shell')
    const pluginRows = flatRows(plugin)
    assert.equal(pluginRows.length, 1, 'the tools group stays on a plugin-only match')
    assert.ok(text(pluginRows[0]).includes('Tool Schemas'))
    assert.equal(filterStat(plugin), '×1 ≈75')
    await plugin.unmount()
  })

  test('the flat system row degrades inside itself when the epoch carries no prompt text', async () => {
    const served = withEpochContent(dnaHeaders, { 1: { tools: [{ name: 'bash', description: 'run' }] } })
    const m = await mount(h(Browser, props({ data: dnaData, ...served })))
    await click(dnaButton(m))
    await click(flatRow(m, 'System Prompt'))
    assert.ok(text(query(m.container, '.lc-br-flat')).includes('carried no system prompt'))
    await m.unmount()
  })

  test('the DNA feed lens scans the served system prompt text, not just its preview', async () => {
    const served = withEpochContent(dnaHeaders, { 1: { system: 'You are an agent. DEEPSECRET clause.', tools: [{ name: 'bash', description: 'run' }] } })
    const m = await mount(h(Browser, props({ data: dnaData, ...served })))
    await click(dnaButton(m))
    await click(flatRow(m, 'System Prompt'))
    await flush()
    await typeToolSearch(m, 'deepsecret')
    const rows = flatRows(m)
    assert.equal(rows.length, 1, 'only the system row stays: the term sits past the 80-char preview')
    assert.ok(text(rows[0]).includes('System Prompt'))
    await m.unmount()
  })

  test('a category jump (catFocus) leaves the DNA feed for the accordion and opens that category', async () => {
    const Harness = () => {
      const [dna, setDna] = useState(true)
      const [focus, setFocus] = useState<CatFocus | null>({ cat: 'user' })
      return h(Browser, props({
        data: dnaData, headers: dnaHeaders,
        dna, onDnaChange: setDna,
        catFocus: focus, onCatFocusHandled: () => { setFocus(null) },
      }))
    }
    const m = await mount(h(Harness))
    assert.ok(!dnaButton(m).className.includes('lc-gran-on'), 'the jump drops DNA mode')
    assert.ok(query(m.container, '.lc-br-cats'))
    assert.ok(text(query(m.container, '.lc-br-body')).includes('hi'), 'the user category opened')
    await m.unmount()
  })

  test('the block map\'s category picks land on the feed\'s group rows; message categories have none to open', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    await click(dnaButton(m))
    await click(query(m.container, '.lc-br-map-btn'))
    await click(query(regionByHead(m, 'Tool Schemas'), '.lc-map-cat-head'))
    assert.ok(flatRow(m, 'Tool Schemas').closest('.lc-br-elem')?.className.includes('lc-br-elem-on'))
    await click(query(regionByHead(m, 'User Messages'), '.lc-map-cat-head'))
    assert.equal(queryAll(m.container, '.lc-br-content').length, 1)
    await click(query(regionByHead(m, 'System Prompt'), '.lc-map-cat-head'))
    assert.ok(flatRow(m, 'System Prompt').closest('.lc-br-elem')?.className.includes('lc-br-elem-on'))
    await m.unmount()
  })

  test('DNA feed rows and bands echo both ways: a row lights its band, a band echoes onto its row, groups included', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    await click(dnaButton(m))
    await hover(flatRows(m)[2].querySelector('.lc-br-elem-row')!)
    let on = bands(m).map(seg => seg.className.includes('lc-stacked-seg-on'))
    assert.deepEqual(on, [false, false, false, false, true, false, false], 'row #2 is the 5th band (n3)')
    assert.ok(query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    await unhover(flatRows(m)[2].querySelector('.lc-br-elem-row')!)
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    await hover(flatRow(m, 'Tool Schemas'))
    on = bands(m).map(seg => seg.className.includes('lc-stacked-seg-on'))
    assert.deepEqual(on, [false, true, true, false, false, false, false])
    assert.ok(!query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    await unhover(flatRow(m, 'Tool Schemas'))
    await hover(flatRow(m, 'System Prompt'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [true, false, false, false, false, false, false])
    await unhover(flatRow(m, 'System Prompt'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))

    await hover(bands(m)[4])
    assert.ok(flatRows(m)[2].className.includes('lc-br-elem-echo'))
    assert.ok(flatRows(m).every((r, i) => i === 2 || !r.className.includes('lc-br-elem-echo')))
    await unhover(bands(m)[4])
    assert.ok(flatRows(m).every(r => !r.className.includes('lc-br-elem-echo')))
    await hover(bands(m)[1])
    assert.ok(flatRow(m, 'Tool Schemas').closest('.lc-br-elem')?.className.includes('lc-br-elem-echo'))
    await unhover(bands(m)[1])
    await hover(bands(m)[0])
    assert.ok(flatRow(m, 'System Prompt').closest('.lc-br-elem')?.className.includes('lc-br-elem-echo'))
    await m.unmount()
  })

  test('a tiny item stays a hoverable filament (the minBand floor) while the tooltip reports the true share', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 2, inject: 0, skill: 0, assistant: 998, tool: 0, total: 1000 },
      nodes: [surfaceNode({ seq: 1, tokens: 2, text: 'ok' }), surfaceNode({ seq: 2, cat: 'assistant', tokens: 998 })],
    })
    const m = await mount(h(Browser, props({ data, headers: null })))
    await click(dnaButton(m))
    const segs = bands(m)
    assert.equal(segs.length, 2)
    assert.equal(segs[0].style.width, '0.35%')
    assert.ok(Math.abs(parseFloat(segs[1].style.width) - 99.65) < 0.001)
    await hover(segs[0])
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['User Messages', '≈2 · 0% of used context', null])
    await click(dnaButton(m))
    assert.deepEqual(bands(m).map(seg => seg.style.width), ['0.2%', '99.8%'])
    await m.unmount()
  })

  test('category mode: the open category stays lit; a pointer hover overrides the pin and the pin resumes on leave', async () => {
    const Harness = (p2: Omit<ContextBrowserProps, 'hoverKey' | 'onHoverKey'>) => {
      const [hoverKey, setHoverKey] = useState<string | null>(null)
      return h(Browser, props({ ...p2, hoverKey, onHoverKey: setHoverKey }))
    }
    const m = await mount(h(Harness, { data: dnaData, headers: dnaHeaders }))
    const stack = query(m.container, '.lc-stacked')
    assert.ok(!stack.className.includes('lc-stacked-dim'), 'nothing pinned while no category is open')
    await click(catRow(m, 'assistant'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false])
    assert.ok(stack.className.includes('lc-stacked-dim'))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0, 'category mode mounts no tooltip slot — the pin floats nothing')
    await hover(bands(m)[0])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [true, false, false, false, false, false])
    await unhover(stack)
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false])
    await click(catRow(m, 'assistant'))
    assert.ok(!stack.className.includes('lc-stacked-dim'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    await m.unmount()
  })

  test('DNA mode: the open tools group lights all its bands as a group (no tooltip); a band hover overrides, the pin resumes', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    await click(dnaButton(m))
    await click(flatRow(m, 'Tool Schemas'))
    const stack = query(m.container, '.lc-stacked')
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, true, true, false, false, false, false])
    assert.ok(stack.className.includes('lc-stacked-dim'))
    assert.ok(!query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'), 'the group pin exact-matches no band — no tooltip')
    await hover(bands(m)[4])
    assert.ok(query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false, false])
    await unhover(stack)
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, true, true, false, false, false, false])
    await click(flatRow(m, 'Tool Schemas'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!stack.className.includes('lc-stacked-dim'))
    await m.unmount()
  })

  test('a push dropping the hovered band does not dim the bar with nothing lit; the pin resumes underneath', async () => {
    const m = await mount(h(Browser, props({ data: dnaData, headers: dnaHeaders })))
    await click(dnaButton(m))
    await hover(bands(m)[3])
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    const pushed = tl({
      current: { ...dnaData.current, user: 0, total: 255 },
      requests: dnaData.requests,
      nodes: dnaData.nodes.filter(n => n.seq !== 2),
    })
    await m.update(h(Browser, props({ data: pushed, headers: dnaHeaders })))
    assert.ok(!query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'), 'the dead key floats no tooltip either')
    await click(bands(m)[4])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, false, true, false])
    await hover(bands(m)[3])
    assert.deepEqual(bands(m).map(seg => seg.className.includes('lc-stacked-seg-on')), [false, false, false, true, false, false])
    await m.unmount()
  })

  test('the pin drops while the previewed step holds nothing for the open category', async () => {
    const wired = (previewSeq: number | null) => h(Browser, props({ data: dnaData, headers: dnaHeaders, previewSeq, onHoverKey: () => {} }))
    const m = await mount(wired(null))
    await click(catRow(m, 'inject'))
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'), 'inject pins lit on the live surface')
    await m.update(wired(20))
    assert.ok(bands(m).every(seg => !seg.className.includes('lc-stacked-seg-on')))
    assert.ok(!query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    await m.update(wired(null))
    assert.ok(bands(m)[3].className.includes('lc-stacked-seg-on'), 'back on the live surface the pin returns')
    await m.unmount()
  })
})

