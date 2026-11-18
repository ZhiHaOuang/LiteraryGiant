import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeOverviewTokens } from '../../../src/client/components/overviewTokens'
import type { TokenPartTotal } from '../../../src/client/overview'
import { makeKit, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()
const Tokens = makeOverviewTokens(kit, Donut)

const PARTS: TokenPartTotal[] = [
  { key: 'system', color: 'var(--color-indigo-500)', value: 42 },
  { key: 'tools', color: 'var(--color-amber-500)', value: 16 },
  { key: 'user', color: 'var(--color-green-500)', value: 10 },
  { key: 'inject', color: 'var(--color-purple-500)', value: 3 },
  { key: 'skill', color: 'var(--color-orange-500)', value: 3 },
  { key: 'toolCalls', color: 'var(--color-teal-500)', value: 96 },
  { key: 'thinking', color: 'var(--color-violet-500)', value: 20 },
  { key: 'answers', color: 'var(--color-pink-500)', value: 20 },
]
const TOKENS = { parts: PARTS, total: 210 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('OverviewTokens', () => {
  test('the donut center is the billed total; rows carry the Context tab\'s categories and ≈ estimates', async () => {
    const m = await mount(h(Tokens, { tokens: TOKENS }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '210')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    const expected = [
      { pct: '20.0%', label: 'System Prompt', count: '≈42' },
      { pct: '7.6%', label: 'Tool Schemas', count: '≈16' },
      { pct: '4.8%', label: 'User Messages', count: '≈10' },
      { pct: '1.4%', label: 'Injected Context', count: '≈3' },
      { pct: '1.4%', label: 'Skill Injections', count: '≈3' },
      { pct: '45.7%', label: 'Tool Calls', count: '≈96' },
      { pct: '9.5%', label: 'Reasoning', count: '≈20' },
      { pct: '9.5%', label: 'Answers', count: '≈20' },
    ]
    expected.forEach((row, i) => assert.deepEqual(rowOf(m.container, i), row))
    await m.unmount()

    const sparse = {
      parts: [
        { key: 'system', color: 'var(--color-indigo-500)', value: 300 },
        { key: 'tools', color: 'var(--color-amber-500)', value: 0 },
        { key: 'user', color: 'var(--color-green-500)', value: 90 },
        { key: 'thinking', color: 'var(--color-violet-500)', value: 50 },
      ],
      total: 440,
    }
    const sparseMount = await mount(h(Tokens, { tokens: sparse }))
    assert.equal(query(sparseMount.container, '.lc-donut-center b').textContent, '440')
    assert.equal(queryAll(sparseMount.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(sparseMount.container, 0), { pct: '68.2%', label: 'System Prompt', count: '≈300' })
    assert.deepEqual(rowOf(sparseMount.container, 1), { pct: '20.5%', label: 'User Messages', count: '≈90' })
    assert.deepEqual(rowOf(sparseMount.container, 2), { pct: '11.4%', label: 'Reasoning', count: '≈50' })
    await sparseMount.unmount()
  })

  test('nothing billed in the range renders the empty note, no ring', async () => {
    for (const tokens of [null, { parts: [{ key: 'system', color: 'x', value: 5 }], total: 0 }]) {
      const m = await mount(h(Tokens, { tokens }))
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      assert.ok(text(m.container).includes('No billed tokens in this range'))
      await m.unmount()
    }
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(Tokens, { tokens: TOKENS }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[1]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(rows[1].className.includes('lc-sl-row-on'))
    await unhover(rows[1])
    assert.ok(!rows[1].className.includes('lc-sl-row-on'))
    await m.unmount()
  })
})
