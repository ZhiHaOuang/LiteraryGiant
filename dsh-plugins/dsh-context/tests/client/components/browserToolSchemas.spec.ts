import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { UNKNOWN_TOOL_SOURCE, type ContextHeaders, type HeaderEpochContent } from '../../../src/shared/types'
import { click, flush, mount, query, queryAll, surfaceNode, text, type Mounted } from '../helpers/kit'
import { Browser, catRow, elemRows, filterStat, pickStep, props, req, settings, tl, typeToolSearch } from './browserHarness'

describe('ContextBrowser tool schemas', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, systemTokens: 3,
      tools: [
        { name: 'omega', tokens: 5, plugin: 'mcp:github' },
        { name: 'rho', tokens: 6 },
        { name: 'theta', tokens: 8 },
        { name: 'zeta', tokens: 10 },
        { name: 'epsilon', tokens: 20 },
        { name: 'delta', tokens: 30 },
        { name: 'gamma', tokens: 40 },
        { name: 'beta', tokens: 50 },
        { name: 'mega', tokens: 100 },
      ],
    }],
  }
  const content: HeaderEpochContent = {
    system: 'SYS',
    tools: [
      { name: 'omega', schema: {} },
      { name: 'rho', schema: 'nope' },
      { name: 'theta', schema: { type: 'object', properties: null } },
      { name: 'zeta', schema: { type: 'object' } },
      { name: 'epsilon', schema: { type: 'object', properties: { z: { type: 'integer' } } } },
      { name: 'delta', schema: { parameters: 'junk', input_schema: { properties: { y: { type: 'integer' } } } } },
      { name: 'gamma', schema: { inputSchema: { properties: 'nope' } } },
      { name: 'beta', schema: { input_schema: { properties: { x: { type: 'string' } } } } },
      {
        name: 'mega', description: 'does everything',
        schema: { name: 'mega', parameters: {
          type: 'object',
          properties: {
            a: { type: 'string', description: 'the a param' },
            b: { type: 'object', properties: { x: {}, y: {} } },
            c: { type: 'array', items: { type: 'number' } },
            d: { type: 'array' },
            d2: { type: 'array', items: null },
            e: { type: 'string', enum: ['x', 'y'] },
            e2: { type: 'string', enum: [] },
            f: { enum: [1, 2] },
            g: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            h: { oneOf: [{ type: 'boolean' }] },
            i: { anyOf: [null, { type: 'string' }] },
            j: { anyOf: [] },
            k: { anyOf: [42, null] },
            l: { type: 'object', properties: {} },
            m: { type: 'object', properties: null },
            n: { type: 'object', properties: 42 },
            o: 'not-an-object',
            p: { description: 42 },
            q: { description: '' },
          },
          required: ['a', 42],
        } },
      },
    ],
  }
  const data = tl({ current: { system: 10, tools: 248, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 258 } })
  const lazyProps = () => props({ data, headers, fetchHeader: () => Promise.resolve(content) })

  test('rows rank by token price; the schema narrowing matrix renders', async () => {
    settings.set('defaultToolSort', 'size')
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const rows = elemRows(m)
    assert.deepEqual(rows.map(r => text(query(r, '.lc-br-preview'))),
      ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])

    await click(rows[0])
    const body = query(m.container, '.lc-br-content')
    assert.ok(text(body).includes('does everything'), 'description section renders')
    const paramRows = queryAll(body, '.lc-ts-param-row')
    assert.equal(paramRows.length, 18, 'one row per object-valued property')
    const byName = (n: string) => paramRows.find(r => text(query(r, '.lc-ts-param-name')) === n)
    const typeOf = (n: string) => text(query(byName(n) as HTMLElement, '.lc-ts-param-type'))
    assert.equal(typeOf('a'), 'string')
    assert.equal(typeOf('b'), 'object{2}')
    assert.equal(typeOf('c'), 'array<number>')
    assert.equal(typeOf('d'), 'array')
    assert.equal(typeOf('d2'), 'array')
    assert.equal(typeOf('e'), 'string (enum)')
    assert.equal(typeOf('e2'), 'string')
    assert.equal(typeOf('f'), '(enum)')
    assert.equal(typeOf('g'), 'string | number')
    assert.equal(typeOf('h'), 'boolean')
    assert.equal(typeOf('i'), 'string')
    assert.equal(typeOf('j'), 'unknown')
    assert.equal(typeOf('k'), 'unknown')
    assert.equal(typeOf('l'), 'object')
    assert.equal(typeOf('m'), 'object')
    assert.equal(typeOf('n'), 'object')
    assert.equal(typeOf('p'), 'unknown')
    assert.equal(text(query(byName('a') as HTMLElement, '.lc-ts-param-req')), '✓')
    assert.equal(text(query(byName('b') as HTMLElement, '.lc-ts-param-req-off')), '·')
    assert.ok(text(byName('a') as HTMLElement).includes('the a param'))
    assert.equal(queryAll(byName('p') as HTMLElement, '.lc-ts-param-desc').length, 0, 'non-string description hidden')
    assert.equal(queryAll(byName('q') as HTMLElement, '.lc-ts-param-desc').length, 0, 'empty description hidden')

    const toggle = query(body, '.lc-ts-json-toggle')
    assert.ok(text(toggle).includes('View Raw JSON'))
    await click(toggle)
    assert.ok(text(query(body, '.lc-ts-desc-body')).includes('"parameters"'))
    assert.ok(text(query(body, '.lc-ts-json-toggle')).includes('Collapse'))
    await click(query(body, '.lc-ts-json-toggle'))
    assert.equal(queryAll(body, 'pre').length, 0)
    await click(elemRows(m)[0])
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0)

    const open = async (name: string) => {
      const row = rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement
      await click(row)
      return query(m.container, '.lc-br-content')
    }
    const close = async (name: string) => {
      await click(rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement)
    }
    let nested = await open('beta')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 1)
    assert.ok(!text(nested).includes('Description'), 'no description section without one')
    await close('beta')
    nested = await open('gamma')
    assert.ok(text(nested).includes('(no parameters)'))
    await close('gamma')
    nested = await open('delta')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 1)
    await close('delta')
    nested = await open('epsilon')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 1)
    assert.ok(text(nested).includes('integer'))
    await close('epsilon')
    nested = await open('zeta')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 0)
    assert.ok(!text(nested).includes('(no parameters)'))
    assert.ok(queryAll(nested, '.lc-ts-json-toggle').length === 1, 'raw JSON still available')
    await close('zeta')
    nested = await open('theta')
    assert.ok(text(nested).includes('(no parameters)'))
    await close('theta')
    nested = await open('rho')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 0)
    await click(query(nested, '.lc-ts-json-toggle'))
    assert.ok(text(query(nested, 'pre')).includes('"nope"'))
    await close('rho')
    nested = await open('omega')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 0)
    assert.ok(!text(nested).includes('does everything'))
    assert.ok(queryAll(nested, '.lc-ts-json-toggle').length === 1)
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('a text filter and the size/name sort narrow and re-rank the rows', async () => {
    settings.set('defaultToolSort', 'size')
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by name, description, or parameters…')
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    assert.equal(sortBtns.length, 3)
    assert.ok(sortBtns[0].className.includes('lc-gran-on'), 'size is the default sort')
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.equal(filterStat(m), '×9 ≈248')

    await typeToolSearch(m, 'gamma')
    assert.deepEqual(names(), ['gamma'])
    assert.equal(filterStat(m), '×1 ≈37')
    await typeToolSearch(m, 'everything')
    assert.deepEqual(names(), ['mega'])
    assert.equal(filterStat(m), '×1 ≈92')
    await typeToolSearch(m, 'the a param')
    assert.deepEqual(names(), ['mega'])
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    assert.equal(filterStat(m), '×1 ≈5')
    await typeToolSearch(m, 'properties')
    assert.equal(elemRows(m).length, 6)
    assert.equal(filterStat(m), '×6 ≈229')
    await typeToolSearch(m, ':')
    assert.deepEqual(names(), ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'omega'])
    assert.equal(filterStat(m), '×8 ≈242', 'a larger subset reports a larger share of the block total')
    await typeToolSearch(m, 'e')
    assert.equal(elemRows(m).length, 9)
    assert.equal(filterStat(m), '×9 ≈248', 'a query that keeps the whole set still mirrors the block total')
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.equal(filterStat(m), '×0 ≈0')
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 9)
    assert.equal(filterStat(m), '×9 ≈248')

    await click(sortBtns[2])
    assert.ok(sortBtns[2].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    await click(sortBtns[1])
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    await click(sortBtns[0])
    assert.deepEqual(names(), ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('count sort ranks by call hits on the shown surface; collapsed rows carry the tally', async () => {
    settings.set('defaultToolSort', 'size')
    const hitHeaders: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'alpha', tokens: 100 },
      { name: 'beta', tokens: 10 },
      { name: 'gamma', tokens: 30 },
      { name: 'delta', tokens: 20 },
    ] }] }
    const data = tl({
      current: { system: 10, tools: 160, user: 0, inject: 0, skill: 0, assistant: 10, tool: 80, total: 260 },
      requests: [req({ seq: 4, turn: 1, step: 0 })],
      nodes: [
        surfaceNode({ seq: 2, cat: 'assistant', tokens: 10 }),
        surfaceNode({ seq: 3, cat: 'tool', tool: 'beta', tokens: 20 }),
        surfaceNode({ seq: 5, cat: 'tool', tool: 'beta', tokens: 20 }),
        surfaceNode({ seq: 6, cat: 'tool', tool: 'gamma', tokens: 20 }),
        surfaceNode({ seq: 7, cat: 'tool', tool: 'delta', tokens: 20 }),
        surfaceNode({ seq: 8, cat: 'tool', tokens: 20 }),
      ],
    })
    const m = await mount(h(Browser, props({ data, headers: hitHeaders, fetchHeader: () => Promise.resolve({ tools: [] }) })))
    await click(catRow(m, 'tools'))
    await flush()
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    const hits = () => elemRows(m).map(r => text(query(r, '.lc-br-hits')))
    assert.deepEqual(names(), ['alpha', 'gamma', 'delta', 'beta'])
    assert.deepEqual(hits(), ['×0', '×1', '×1', '×2'])
    assert.equal(query(m.container, '.lc-br-hits').title, 'Times this tool was called and answered within the shown step’s context')
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    await click(sortBtns[1])
    assert.deepEqual(names(), ['beta', 'delta', 'gamma', 'alpha'])
    assert.deepEqual(hits(), ['×2', '×1', '×1', '×0'])
    await pickStep(m, '4')
    await click(catRow(m, 'tools'))
    await flush()
    assert.deepEqual(names(), ['beta', 'alpha', 'delta', 'gamma'])
    assert.deepEqual(hits(), ['×1', '×0', '×0', '×0'])
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('the mount-time default tool sort comes from the plugin settings', async () => {
    const pair: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'zzz', tokens: 1 },
      { name: 'aaa', tokens: 100 },
    ] }] }
    const data = tl({
      current: { system: 10, tools: 101, user: 0, inject: 0, skill: 0, assistant: 0, tool: 10, total: 121 },
      nodes: [surfaceNode({ seq: 2, cat: 'tool', tool: 'zzz', tokens: 10 })],
    })
    const names = (m: Mounted) => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    const sortBtns = (container: ParentNode) => queryAll(container, '.lc-br-toolctl .lc-gran-btn')
    const mountWith = async (sort: string) => {
      settings.set('defaultToolSort', sort)
      const m = await mount(h(Browser, props({ data, headers: pair, fetchHeader: () => Promise.resolve({ tools: [] }) })))
      await click(catRow(m, 'tools'))
      return m
    }

    for (const [sort, idx, order] of [
      ['count', 1, ['zzz', 'aaa']],
      ['size', 0, ['aaa', 'zzz']],
      ['name', 2, ['aaa', 'zzz']],
    ] as const) {
      const m = await mountWith(sort)
      assert.ok(sortBtns(m.container)[idx].className.includes('lc-gran-on'))
      assert.deepEqual(names(m), order)
      await m.unmount()
    }

    const m = await mountWith('count')
    await click(sortBtns(m.container)[0])
    assert.equal(settings.store.getSnapshot().toolSort, 'count')
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('before the epoch content loads, the filter scans names and plugins only', async () => {
    const m = await mount(h(Browser, props({ data, headers, fetchHeader: () => new Promise(() => {}) })))
    await click(catRow(m, 'tools'))
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    await typeToolSearch(m, 'everything')
    assert.equal(names().length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await m.unmount()

    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic['self'] = cyclic
    const hostile: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'loop', tokens: 3 }, { name: 'nully', tokens: 1 }, { name: 'plain', tokens: 2 },
    ] }] }
    const hostileContent: HeaderEpochContent = { system: 'SYS', tools: [
      { name: 'loop', schema: cyclic }, { name: 'nully', schema: null }, { name: 'plain', schema: {} },
    ] }
    const hostileMount = await mount(h(Browser, props({ data, headers: hostile, fetchHeader: () => Promise.resolve(hostileContent) })))
    await click(catRow(hostileMount, 'tools'))
    await flush()
    assert.equal(elemRows(hostileMount).length, 3)
    await typeToolSearch(hostileMount, 'loop')
    assert.deepEqual(elemRows(hostileMount).map(r => text(query(r, '.lc-br-preview'))), ['loop'])
    await typeToolSearch(hostileMount, 'properties')
    assert.equal(elemRows(hostileMount).length, 0)
    assert.ok(text(hostileMount.container).includes('No tools match the current filter'))
    await hostileMount.unmount()

    const partial: HeaderEpochContent = { system: 'SYS', tools: [{ name: 'other', schema: {} }] }
    const missing = await mount(h(Browser, props({ data, headers, fetchHeader: () => Promise.resolve(partial) })))
    await click(catRow(missing, 'tools'))
    await flush()
    await click(elemRows(missing).find(r => text(query(r, '.lc-br-preview')) === 'mega') as HTMLElement)
    assert.ok(text(query(missing.container, '.lc-br-content')).includes('not in the session log'))
    await missing.unmount()
  })

  test('tool rows tag the registering plugin when attribution exists', async () => {
    settings.set('defaultToolSort', 'size')
    const attributed: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
        { name: 'write', tokens: 5, plugin: '@deepseek-ai/dsh-tool-fs' },
        { name: 'mcp__github__get_issue', tokens: 3, plugin: 'mcp:github' },
        { name: 'agent_teams_add_member', tokens: 2 },
        { name: 'claim_files', tokens: 2, plugin: UNKNOWN_TOOL_SOURCE },
      ] }],
    }
    const data = tl({ current: { system: 0, tools: 10, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 } })
    const m = await mount(h(Browser, props({ data, headers: attributed })))
    await click(catRow(m, 'tools'))
    const rows = elemRows(m)
    assert.equal(rows.length, 4)
    const chips = queryAll(m.container, '.lc-br-tool-plugin')
    assert.equal(chips.length, 3, 'only attributed tools chip')
    assert.ok(text(chips[0]).includes('@deepseek-ai/dsh-tool-fs'))
    assert.ok(text(chips[1]).includes('mcp:github'))
    assert.ok((chips[0] as HTMLElement).title.includes('The registering plugin of this tool'), 'the chip carries the i18n tooltip')
    assert.ok(!text(rows[2]).includes('@'), 'unattributed tools stay untagged')
    assert.equal(chips[2].textContent, 'Unknown plugin')
    assert.ok((chips[2] as HTMLElement).title.includes('registered before the context plugin loaded'), 'unknown chips explain the boot gap')
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'write', 'tool name leads')
    const chip = chips[0] as HTMLElement
    assert.equal(chip.previousElementSibling, query(rows[0], '.lc-br-preview'), 'plugin chip sits right after the tool name')
    assert.ok(chip.parentElement!.classList.contains('lc-br-elem-row'), 'plugin chip is a single frame, a direct row child')
    assert.equal(queryAll(chip, '.lc-br-tag').length, 0, 'no nested tag wrapper')
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('a single-tool category opens its schema row with the category; multi stays collapsed', async () => {
    const lone: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
        { name: 'only', tokens: 5 },
      ] }],
    }
    const loneContent: HeaderEpochContent = {
      system: 'SYS',
      tools: [{ name: 'only', schema: { type: 'object', properties: { x: { type: 'string' } } } }],
    }
    const data = tl({ current: { system: 10, tools: 5, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 15 } })
    const m = await mount(h(Browser, props({ data, headers: lone, fetchHeader: () => Promise.resolve(loneContent) })))
    await click(catRow(m, 'tools'))
    await flush()
    assert.equal(elemRows(m).length, 1)
    const content = queryAll(m.container, '.lc-br-content')
    assert.equal(content.length, 1, 'the lone tool schema is already expanded')
    assert.equal(queryAll(content[0], '.lc-ts-param-row').length, 1, 'the schema body renders directly')
    await click(catRow(m, 'tools'))
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0, 'toggling shut closes the row too')
    await m.unmount()

    const pair: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'a', tokens: 2 }, { name: 'b', tokens: 1 }] }],
    }
    const m2 = await mount(h(Browser, props({ data, headers: pair })))
    await click(catRow(m2, 'tools'))
    assert.equal(elemRows(m2).length, 2)
    assert.equal(queryAll(m2.container, '.lc-br-content').length, 0, 'multi-tool categories open collapsed')
    await m2.unmount()
  })
})

