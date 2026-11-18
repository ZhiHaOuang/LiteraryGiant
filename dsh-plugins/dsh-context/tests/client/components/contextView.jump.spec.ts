import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, hover, mount, query, queryAll, text } from '../helpers/kit'
import { buttonByText, eventLink, makeView, mountInScroller, mountRich, overflowingScroller, projectionsFor, richTimeline, settingsWith, stubRevealRects, T0, timeline } from './contextViewHarness'

describe('ContextView — chat→Context jump', () => {
  test('the relay flips the chart to turn bars, pins the reply\'s turn, and consumes itself', async () => {
    requestContextFocus('sv-jump', 4)
    const m = await mountRich('sv-jump')
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'), 'granularity flips to turn')
    assert.equal(queryAll(m.container, '.lc-bar').length, 2, 'the chart renders turn aggregates')
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the reply\'s turn bar is pinned')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-jump'), null, 'the relay is one-shot')
    await m.unmount()
  })

  test('no session id: the relay stays pending — the loading view never takes it', async () => {
    requestContextFocus('sv-jumpnone', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
    assert.equal(takeContextFocus('sv-jumpnone'), 4, 'an absent session id skips leg 1')
    takeContextFocus('sv-jumpnone')
  })

  test('an empty history consumes the relay and pins nothing', async () => {
    requestContextFocus('sv-jumpempty', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-jumpempty', useProjection: projectionsFor(timeline()) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.equal(takeContextFocus('sv-jumpempty'), null)
    await m.unmount()
  })

  test('a turn-less reply routes to the turn-0 bar', async () => {
    requestContextFocus('sv-jump0', 6)
    const m = await mountRich('sv-jump0')
    assert.ok(query(m.container, '.lc-bar[data-seq="6"]').className.includes('lc-bar-selected'))
    assert.equal(takeContextFocus('sv-jump0'), null)
    await m.unmount()
  })

  test('a record landing after mount re-pins the mounted view (the sidebar repeat jump)', async () => {
    const m = await mountRich('sv-rejump')
    assert.ok(!query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'nothing pinned at mount')
    await act(async () => { requestContextFocus('sv-rejump', 4) })
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the later record re-pins')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-rejump'), null, 'the record was consumed')
    await m.unmount()
  })

  test('the jump reveals the Current Composition card even over a restored position', async () => {
    const View = makeView(new TestClientCtx())
    const props = { sessionId: 'sv-jumpscroll', useProjection: projectionsFor(richTimeline()) }

    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(h(View, props), scroller1)
    scroller1.scrollTop = 42
    await m1.unmount()

    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.hasAttribute('data-lc-current') ? 450 : 0
      return { top } as DOMRect
    })

    requestContextFocus('sv-jumpscroll', 4)
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    scroller2.style.overflowY = 'auto'
    Object.defineProperty(scroller2, 'scrollHeight', { value: 800 })
    Object.defineProperty(scroller2, 'clientHeight', { value: 300 })
    const m2 = await mountInScroller(h(View, props), scroller2)
    assert.equal(scroller2.scrollTop, 392, 'restore(42) overridden by the card reveal delta(350)')
    assert.ok(query(m2.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'))
    await m2.unmount()
    gBCR.mockRestore()
  })
})

describe('ContextView — the stats board\'s pill jumps', () => {
  function jumpTimeline(): ReturnType<typeof timeline> {
    return timeline({
      humanInputs: 1,
      requests: [{ seq: 2, turn: 1, step: 1, time: T0, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 0, total: 60 }],
      nodes: [{ seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 }],
      fileOps: [
        { seq: 3, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0, read: { start: 1, count: 3 } },
        { seq: 4, path: '/src/a.ts', kind: 'write', tool: 'edit', err: false, added: 2, removed: 1 },
      ],
    })
  }

  test('the session figures scroll the trend card into view', async () => {
    const scroller = overflowingScroller(900)
    const gBCR = stubRevealRects(scroller, el => (el.hasAttribute('data-lc-trend') ? 450 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-trendjump', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      await click(query(m.container, '.lc-core-kv-turns.lc-core-kv-btn'))
      await flush()
      assert.equal(scroller.scrollTop, 350, 'the turn figure lands on the trend card')
      scroller.scrollTop = 0
      await click(query(m.container, '.lc-core-kv-steps.lc-core-kv-btn'))
      await flush()
      assert.equal(scroller.scrollTop, 350, 'the step figure lands on the same card')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('a session-figure jump ignores the hover its own scroll leaves under the pointer', async () => {
    const scroller = overflowingScroller(900)
    const gBCR = stubRevealRects(scroller, el => (el.hasAttribute('data-lc-trend') ? 450 : 0))
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-hoverlock', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      await click(query(m.container, '.lc-core-kv-steps.lc-core-kv-btn'))
      await flush()
      const bar = query(m.container, '.lc-bar')
      const turn = query(m.container, '.lc-turn')
      now.mockReturnValue(1_100)
      await hover(turn)
      assert.equal(queryAll(m.container, '.lc-chart-dim').length, 0, 'the landing turn hover is swallowed')
      now.mockReturnValue(1_200)
      await hover(bar)
      assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0, 'the landing bar hover is swallowed')
      now.mockReturnValue(1_400)
      await hover(turn)
      assert.equal(queryAll(m.container, '.lc-chart-dim').length, 1, 'a later turn hover dims as usual')
      now.mockReturnValue(1_500)
      await hover(bar)
      assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1, 'a later bar hover shows the tip')
      await m.unmount()
    } finally {
      now.mockRestore()
      gBCR.mockRestore()
    }
  })

  test('the input pill opens the browser\'s user messages; a file pill picks the card\'s kind chip and scrolls it in', async () => {
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 900 })
    Object.defineProperty(scroller, 'clientHeight', { value: 300 })
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-col-browser') ? 450
      : el.classList.contains('lc-fa-card') ? 700 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-pilljump', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      const pill = (label: string): HTMLElement => {
        const hit = queryAll(m.container, '.lc-ledger-in-chips .lc-ledger-chip').find(el => text(el).startsWith(label))
        if (hit === undefined) throw new Error(`pill not found: ${label}`)
        return hit
      }
      const fileCard = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
      assert.ok(fileCard !== undefined)
      const chip = (label: string): HTMLElement => {
        const hit = queryAll(fileCard, '.lc-fa-chips .lc-gran-btn').find(b => text(b).startsWith(label))
        if (hit === undefined) throw new Error(`chip not found: ${label}`)
        return hit
      }

      await click(pill(DICT_EN['stats.user']))
      await flush()
      const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes(DICT_EN['cat.user']), 'the user category opens')
      assert.ok(text(open[0].parentElement as HTMLElement).includes('hello there'), 'its messages show')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')

      await click(pill(DICT_EN['files.kind.read']))
      await flush()
      assert.ok(chip(DICT_EN['files.kind.read']).className.includes('lc-gran-on'))
      assert.equal(queryAll(fileCard, '.lc-fa-row').length, 1, 'the read filter narrows the list')
      assert.equal(scroller.scrollTop, 600, 'the File Activity card scrolled to the scrollport top')

      await click(pill(DICT_EN['stats.fileWrite']))
      await flush()
      assert.ok(chip(DICT_EN['files.kind.write']).className.includes('lc-gran-on'))
      assert.ok(!chip(DICT_EN['files.kind.read']).className.includes('lc-gran-on'), 'the previous jump is replaced')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })
})

describe('ContextView — the stats board\'s lower-lane jumps', () => {
  function commandTimeline(): ReturnType<typeof timeline> {
    return timeline({
      commands: [
        { seq: 10, time: T0, tool: 'bash', cmd: 'python3 a.py && python3 b.py', start: T0, end: T0 + 100, status: 'completed', err: false },
        { seq: 11, time: T0, tool: 'bash', cmd: 'python3 build.py', start: T0, end: T0 + 100, status: 'completed', err: false },
        { seq: 12, time: T0 + 1000, tool: 'bash', cmd: 'git status --short', start: T0 + 1000, end: T0 + 1100, status: 'completed', err: false },
        { seq: 13, time: T0 + 2000, tool: 'bash', cmd: 'node --version', start: T0 + 2000, end: T0 + 2100, status: 'completed', err: false },
        { seq: 14, time: T0 + 3000, tool: 'bash', cmd: 'npm --version', start: T0 + 3000, end: T0 + 3100, status: 'completed', err: false },
      ],
    })
  }

  test('a command chip mounts the lazy card, seeds its lens, and scrolls it in', async () => {
    const scroller = overflowingScroller(1200)
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-cmd-card') ? 700 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-cmdjump', useProjection: projectionsFor(commandTimeline()) }), scroller)
      assert.ok(queryAll(m.container, '.lc-ledger-in-body2 .lc-ledger-chip').some(el => text(el).startsWith('npm')), 'the whole program tally reaches the stats board')
      const chip = queryAll(m.container, '.lc-ledger-in-body2 .lc-ledger-chip').find(el => text(el).startsWith('python3'))
      assert.ok(chip !== undefined)
      assert.equal(text(chip), 'python33', 'the lane counts INVOCATIONS, including repeats within one record')
      await click(chip)
      await flush()
      const card = query(m.container, '.lc-cmd-card')
      assert.equal(query<HTMLInputElement>(card, 'input.lc-fa-search').value, 'python3', 'the seeded lens shows in the box')
      assert.equal(queryAll(card, '.lc-cmd-row').length, 2, 'the lens narrows to the records running the program')
      assert.equal(scroller.scrollTop, 600, 'the command card scrolled to the scrollport top')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('the folded "+N" tails jump: tools open every result, commands reveal the card without a lens', async () => {
    const data = timeline({
      commands: ['git status', 'pnpm test', 'node x.js', 'grep -n x src', 'tail -5 log']
        .map((cmd, i) => ({ seq: 20 + i, time: T0 + i, tool: 'bash', cmd, start: T0, end: T0 + 10, status: 'completed' as const, err: false })),
      nodes: ['read', 'edit', 'bash', 'grep', 'write']
        .map((tool, i) => ({ seq: 30 + i, cat: 'tool' as const, tokens: 5, tool })),
    })
    const scroller = overflowingScroller(1400)
    const rect = (w: number, top: number): DOMRect => ({ width: w, height: 0, top, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-conversation-scroll')) return rect(0, 100)
      if (this.classList.contains('lc-ledger-chips')) return rect(260, 0)
      if (this.classList.contains('lc-ledger-chip')) return rect(this.classList.contains('lc-ledger-chip-more') ? 40 : 100, 0)
      const top = this.classList.contains('lc-col-browser') ? 450 : this.classList.contains('lc-cmd-card') ? 700 : 0
      return rect(0, top - scroller.scrollTop)
    })
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-morejump', useProjection: projectionsFor(data) }), scroller)
      const toolMore = query(m.container, '.lc-ledger-out-chips .lc-ledger-chip-more')
      const cmdMore = query(m.container, '.lc-ledger-in-body2 .lc-ledger-chip-more')
      assert.equal(toolMore.getAttribute('title'), DICT_EN['stats.toolsMoreTip'])
      assert.equal(toolMore.getAttribute('role'), 'button')
      assert.equal(cmdMore.getAttribute('title'), DICT_EN['stats.commandsMoreTip'])
      await click(toolMore)
      await flush()
      const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes(DICT_EN['cat.tool']), 'every tool result opens')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled into view')
      await click(cmdMore)
      await flush()
      const card = query(m.container, '.lc-cmd-card')
      assert.equal(query<HTMLInputElement>(card, 'input.lc-fa-search').value, '', 'no program lens is seeded')
      assert.equal(scroller.scrollTop, 600, 'the command card scrolled into view')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('a tool chip opens the bucket its results are filed in, seeding the name only in Tool Results', async () => {
    const base = richTimeline()
    const skill = { seq: 7, cat: 'skill' as const, tool: 'skill', skill: 'code-review', tokens: 30, text: 'Skill instructions' }
    const cases = [
      { tool: 'bash', data: base, cat: DICT_EN['cat.tool'], lens: 'bash' },
      { tool: 'skill', data: richTimeline({ nodes: [...base.nodes, skill] }), cat: DICT_EN['cat.skill'], lens: '' },
    ]
    for (const c of cases) {
      const scroller = overflowingScroller(1200)
      const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-col-browser') ? 450 : 0))
      try {
        const View = makeView(new TestClientCtx())
        const m = await mountInScroller(h(View, { sessionId: 'sv-tooljump-' + c.tool, useProjection: projectionsFor(c.data) }), scroller)
        const chip = queryAll(m.container, '.lc-ledger-out-chips .lc-ledger-chip').find(el => text(el).startsWith(c.tool))
        assert.ok(chip !== undefined)
        await click(chip)
        await flush()
        const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
        assert.equal(open.length, 1)
        assert.ok(text(open[0]).includes(c.cat), 'the bucket holding the results opens')
        const lens = open[0].parentElement?.querySelector<HTMLInputElement>('.lc-br-tool-search')
        assert.ok(lens !== null && lens !== undefined)
        assert.equal(lens.value, c.lens)
        assert.equal(queryAll(m.container, '.lc-br-elem-row').length, 1, 'the tool result is listed, never an empty lens')
        assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')
        await m.unmount()
      } finally {
        gBCR.mockRestore()
      }
    }
  })

  test('the whole tile reveals the events card as-is; a kind narrows it and scrolls it in', async () => {
    const scroller = overflowingScroller(1200)
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-events-card') ? 700 : 0))
    try {
      const data = richTimeline({
        events: [
          ...richTimeline().events,
          { seq: 7, time: T0 + 6000, kind: 'model', from: 'a', to: 'b' },
        ],
      })
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-eventsjump', useProjection: projectionsFor(data) }), scroller)
      await click(query(m.container, '.lc-core-kv-events'))
      await flush()
      const card = query(m.container, '.lc-events-card')
      assert.equal(queryAll(card, '.lc-gran-on').length, 5, 'every kind stays picked')
      assert.equal(queryAll(card, '.lc-event').length, 3, 'the unfiltered list keeps every row')
      assert.equal(scroller.scrollTop, 600, 'the events card scrolled to the scrollport top')

      const entry = query(m.container, '.lc-core-kv-event[data-kind="compaction"]')
      assert.equal(entry.getAttribute('role'), 'button')
      await click(entry)
      await flush()
      assert.deepEqual(
        queryAll(card, '.lc-gran-on').map(el => el.getAttribute('data-kind')),
        ['compaction'],
        'the picked kind is the only active lens',
      )
      assert.equal(queryAll(card, '.lc-event').length, 1, 'only the compaction row survives')
      assert.ok(text(card).includes(DICT_EN['kind.compaction']))
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })
})

describe('ContextView — the events card\'s boundary rows', () => {
  function compactionLink(container: ParentNode): HTMLElement {
    return eventLink(container, DICT_EN['ev.compaction'].replace('{n}', '2'))
  }

  test('a click pins the step the compaction landed on, aligns the browser, and reveals the trend card', async () => {
    const scroller = overflowingScroller(1200)
    const gBCR = stubRevealRects(scroller, el => (el.hasAttribute('data-lc-trend') ? 450 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, {
        sessionId: 'sv-compactjump',
        useProjection: projectionsFor(richTimeline()),
      }), scroller)
      assert.equal(queryAll(m.container, '.lc-bar-selected').length, 0, 'nothing is pinned before the click')

      await click(compactionLink(m.container))
      assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the landed-on step is pinned')
      assert.equal(query<HTMLElement>(m.container, '.lc-chart-scroll').scrollLeft, 1 * 16 + 7, 'the trend scrolled to the landed bar')
      assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4', 'the browser aligns to the same step')
      assert.equal(scroller.scrollTop, 350, 'the trend card scrolled to the scrollport top')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }

    const pruneData = richTimeline({
      events: [{ seq: 3, time: T0 + 2000, kind: 'prune', tokens: 500, turn: 1, step: 2, fromTurn: 1, fromStep: 1 }],
    })
    const pruneView = makeView(new TestClientCtx())
    const prune = await mount(h(pruneView, { sessionId: 'sv-prunejump', useProjection: projectionsFor(pruneData) }))
    await click(eventLink(prune.container, DICT_EN['ev.prune']))
    assert.ok(query(prune.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the pruned step is pinned')
    assert.equal(query<HTMLSelectElement>(prune.container, 'select.lc-br-pick').value, '4')
    await prune.unmount()
  })

  test('a click leaves the overview face and flips turn granularity to the exact step', async () => {
    const View = makeView(new TestClientCtx(), settingsWith({ defaultGranularity: 'turn' }))
    const m = await mount(h(View, { sessionId: 'sv-compactoverview', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2, 'one aggregate bar per turn at mount')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.ok(buttonByText(m.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'))

    await click(compactionLink(m.container))
    assert.ok(!buttonByText(m.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'), 'the overview yields to the bar face')
    assert.ok(buttonByText(m.container, DICT_EN['gran.step']).className.includes('lc-gran-on'), 'step granularity is on')
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'))
    await m.unmount()
  })

  test('a compaction past the retained log has no landing step, so its row stays a plain label', async () => {
    const data = richTimeline({ events: [{ seq: 99, time: T0 + 9000, kind: 'compaction', count: 2, tokens: 100 }] })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-compactpast', useProjection: projectionsFor(data) }))
    const row = queryAll(m.container, '.lc-event').find(r => text(r).includes(DICT_EN['ev.compaction'].replace('{n}', '2')))
    assert.ok(row !== undefined, 'the compaction row is listed')
    assert.equal(row.querySelector('.lc-event-jump'), null, 'a jump it cannot make is not offered as a link')
    assert.equal(query(row, '.lc-event-label').tagName, 'SPAN')
    assert.equal(queryAll(m.container, '.lc-bar-selected').length, 0)
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
    await m.unmount()
  })
})
