import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewCard } from '../../../src/client/components/overviewCard'
import { DICT_EN } from '../../../src/client/i18n'
import type { OverviewRow } from '../../../src/client/overview'
import type { ContextActivity, ContextTimeline, SessionCostUsage } from '../../../src/shared/types'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const Card = makeOverviewCard(kit)
const NOW = new Date(2026, 8, 16, 12).getTime()

function rowOf(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id: 's1',
    title: 'refactor the parser',
    updatedAt: NOW - 3 * 3_600_000,
    running: false,
    current: false,
    archived: false,
    timeline: null,
    activity: null,
    family: [over.timeline ?? null],
    familyCost: null,
    ...over,
  }
}

const FAMILY_COST: SessionCostUsage = { deepseek: { m: { peak: { uncached: 1000, cacheRead: 500, cacheWrite: 0, output: 250 } } } }

const TIMELINE = {
  current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
  contextWindow: 1000,
  requests: [{}, {}],
  counts: { turns: 9, steps: 12, injects: 1, compactions: 0, prunes: 0 },
  cost: FAMILY_COST,
} as unknown as ContextTimeline

describe('OverviewCard', () => {
  test('a folded session renders the donut, occupancy, and figures; without a window it shows the total and dashes', async () => {
    const opened: string[] = []
    const m = await mount(h(Card, { row: rowOf({ timeline: TIMELINE, familyCost: FAMILY_COST }), costLabel: '$0.02', now: NOW, onOpen: id => { opened.push(id) } }))
    const card = query(m.container, 'button.lc-ov-session')
    assert.ok(!card.className.includes('lc-ov-session-current'))
    assert.equal(query(m.container, '.lc-ov-session-title').textContent, 'refactor the parser')
    assert.equal(query(m.container, '.lc-ov-session-time').textContent, '3h ago')
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '500')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, '50.0%')
    const labels = queryAll(m.container, '.lc-ov-mini-label').map(el => el.textContent)
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.deepEqual(labels, ['Turns', 'Total Tokens', 'Total Est. Cost'])
    assert.deepEqual(values, ['9 turns · 12 steps', '1.8k', '$0.02'])
    await click(card)
    assert.deepEqual(opened, ['s1'], 'clicking relays the session id')
    await m.unmount()

    const bare = { current: TIMELINE.current, requests: [{}] } as unknown as ContextTimeline
    const windowless = await mount(h(Card, { row: rowOf({ timeline: bare }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(windowless.container, '.lc-donut-center b').textContent, '500')
    assert.equal(queryAll(windowless.container, '.lc-donut-center span').length, 0, 'no occupancy without the window')
    assert.deepEqual(queryAll(windowless.container, '.lc-ov-mini-value').map(el => el.textContent), ['1', '—', '—'])
    await windowless.unmount()
  })

  test('the created line shows the first active day; absent without a ledger', async () => {
    const ledger = { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 1, requests: 1 } } } as ContextActivity
    const withLedger = await mount(h(Card, { row: rowOf({ activity: ledger }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(withLedger.container, '.lc-ov-session-time').textContent, '3h ago')
    assert.equal(query(withLedger.container, '.lc-ov-session-created').textContent, '2026-09-10', 'the earliest day, not the latest')
    await withLedger.unmount()
    const noLedger = await mount(h(Card, { row: rowOf(), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(noLedger.container, '.lc-ov-session-created').length, 0)
    await noLedger.unmount()
  })

  test('running and current markers render', async () => {
    const m = await mount(h(Card, { row: rowOf({ running: true, current: true }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.ok(query(m.container, '.lc-ov-running'))
    assert.equal(query(m.container, '.lc-ov-current').textContent, 'current')
    assert.ok(query(m.container, 'button.lc-ov-session').className.includes('lc-ov-session-current'))
    const zh = await mount(h(makeOverviewCard(makeKit('zh')), { row: rowOf({ current: true }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(zh.container, '.lc-ov-current').textContent, '当前')
    await zh.unmount()
    let opened = 0
    const archived = await mount(h(Card, { row: rowOf({ archived: true }), costLabel: '—', now: NOW, onOpen: () => { opened += 1 } }))
    assert.ok(text(archived.container).includes(DICT_EN['ov.card.archived']))
    await click(query(archived.container, 'button.lc-ov-session'))
    assert.equal(opened, 0, 'an archived card never opens')
    await archived.unmount()
    await m.unmount()
  })

  test('a session with no timeline degrades to the metadata-only note', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/repo/app', title: 'plain' }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.ok(text(m.container).includes('No context data yet'))
    assert.equal(queryAll(m.container, '.lc-donut').length, 0)
    await m.unmount()
  })

  test('the breadcrumb shows group and project, deduping a same-named workspace and degrading per part', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'workspace-one',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    const crumb = query(m.container, '.lc-ov-session-crumb')
    assert.equal(crumb.getAttribute('title'), '/Users/bw/dev/dsh-context')
    assert.equal(query(m.container, '.lc-ov-crumb-group').textContent, 'workspace-one')
    assert.equal(query(m.container, '.lc-ov-crumb-sep').textContent, '/')
    assert.equal(query(m.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await m.unmount()

    const same = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'dsh-context',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(queryAll(same.container, '.lc-ov-crumb-group').length, 0)
    assert.equal(queryAll(same.container, '.lc-ov-crumb-sep').length, 0)
    assert.equal(query(same.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await same.unmount()

    const groupOnly = await mount(h(Card, { row: rowOf(), group: 'workspace-one', costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(groupOnly.container, '.lc-ov-crumb-group').textContent, 'workspace-one')
    assert.equal(queryAll(groupOnly.container, '.lc-ov-crumb-project').length, 0)
    await groupOnly.unmount()

    const bare = await mount(h(Card, { row: rowOf(), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(bare.container, '.lc-ov-session-crumb').length, 0)
    await bare.unmount()
  })

  test('the last-user-message footer renders the labeled preview with the full text on the tip; absent stays absent', async () => {
    const withPreview = await mount(h(Card, {
      row: rowOf({ timeline: { ...TIMELINE, lastUser: 'fix the flaky spec' } as unknown as ContextTimeline }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    const preview = query(withPreview.container, '.lc-ov-session-preview')
    assert.equal(preview.getAttribute('title'), 'fix the flaky spec')
    assert.equal(query(withPreview.container, '.lc-ov-session-preview-label').textContent, 'Last message')
    assert.equal(query(withPreview.container, '.lc-ov-session-preview-text').textContent, 'fix the flaky spec')
    await withPreview.unmount()
    const bare = await mount(h(Card, { row: rowOf({ timeline: TIMELINE }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(bare.container, '.lc-ov-session-preview').length, 0, 'no preview line without the fold field')
    await bare.unmount()
  })
})
