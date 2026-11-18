import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeStatsTokens } from '../../../src/client/components/statsTokens'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, hover, unhover } from '../helpers/kit'

const kit = makeKit()
const StatsTokens = makeStatsTokens(kit, Donut)

const CURRENT: Snapshot['current'] = { system: 200, tools: 100, user: 300, inject: 100, skill: 0, assistant: 200, tool: 100, total: 1000 }
const USAGE: TokenUsage = { uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('StatsTokens', () => {
  test('the donut center is the chat line total; rows split it by composition', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '450')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 5)
    const expected = [
      { pct: '17.8%', label: 'System Prompt', count: '≈80' },
      { pct: '8.9%', label: 'Tool Schemas', count: '≈40' },
      { pct: '26.7%', label: 'User Messages', count: '≈120' },
      { pct: '8.9%', label: 'Injected Context', count: '≈40' },
      { pct: '37.8%', label: 'Tool Calls', count: '≈170' },
    ]
    expected.forEach((row, i) => assert.deepEqual(rowOf(m.container, i), row))
    await m.unmount()

    const zh = await mount(h(makeStatsTokens(makeKit('zh'), Donut), { usage: USAGE, current: CURRENT, breakdown: null }))
    assert.equal(query(zh.container, '.lc-card-title-text').textContent, 'Token 统计')
    await zh.unmount()

    const sparse: Snapshot['current'] = { system: 100, tools: 0, user: 300, inject: 0, skill: 0, assistant: 0, tool: 0, total: 400 }
    const sparseMount = await mount(h(StatsTokens, { usage: USAGE, current: sparse, breakdown: null }))
    assert.equal(queryAll(sparseMount.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(sparseMount.container, 0), { pct: '22.2%', label: 'System Prompt', count: '≈100' })
    assert.deepEqual(rowOf(sparseMount.container, 1), { pct: '66.7%', label: 'User Messages', count: '≈300' })
    assert.deepEqual(rowOf(sparseMount.container, 2), { pct: '11.1%', label: 'Tool Calls', count: '≈50' })
    await sparseMount.unmount()
  })

  test('the Tool Calls and Answers rows explain their scope in the tooltip', async () => {
    const toolTip = 'What Tool Calls counts:\n• Call names and arguments, replayed in the prompt and generated in the output\n• Tool results: everything the tools returned\nExcludes model replies and reasoning; tool schemas are counted separately.'
    const answersTip = 'What Answers counts:\n• Reply prose replayed in the prompt\n• Reply prose generated in the output\nExcludes reasoning, tool-call arguments, and tool results.'
    const zhToolTip = '工具调用统计的内容：\n• 调用名称与参数：提示词中重放的 + 输出中生成的\n• 工具结果：工具返回的全部内容\n不含模型回复正文与模型思考；工具定义单独统计。'
    const zhAnswersTip = '模型回复统计的内容：\n• 提示词中重放的模型回复正文\n• 输出中生成的模型回复正文\n不含模型思考、工具调用参数与工具结果。'
    const withAnswers: Snapshot['current'] = { ...CURRENT, assistantAnswerTokens: 50 }

    for (const [kitFor, labels, tips, answerRow] of [
      [kit, ['Tool Calls', 'Answers'], [toolTip, answersTip], { pct: '28.9%', label: 'Answers', count: '≈130' }],
      [makeKit('zh'), ['工具调用', '模型回复'], [zhToolTip, zhAnswersTip], { pct: '28.9%', label: '模型回复', count: '≈130' }],
    ] as [ReturnType<typeof makeKit>, string[], string[], { pct: string; label: string; count: string }][]) {
      const Tokens = makeStatsTokens(kitFor, Donut)
      const m = await mount(h(Tokens, { usage: USAGE, current: withAnswers, breakdown: null, generatedAnswerTokens: 10 }))
      const rows = queryAll(m.container, '.lc-sl-row')
      for (const [i, label] of labels.entries()) {
        const row = rows.find(r => r.querySelector('.lc-sl-label')?.textContent === label)
        assert.equal(row?.getAttribute('title'), tips[i])
        assert.equal(row?.querySelector('.lc-sl-label')?.getAttribute('title'), tips[i])
      }
      assert.deepEqual(rowOf(m.container, 5), answerRow)
      await m.unmount()
    }
  })

  test('the thinking slice splits the assistant bucket and the generated output, in both locales', async () => {
    const current: Snapshot['current'] = { system: 100, tools: 0, user: 0, inject: 0, skill: 0, assistant: 100, assistantReasoning: 60, assistantCallTokens: 40, tool: 0, total: 200 }
    const usage: TokenUsage = { uncachedInputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage, current, breakdown: null, generatedReasoning: 40, generatedCallTokens: 60 }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '300')
    assert.deepEqual(rowOf(m.container, 1), { pct: '33.3%', label: 'Tool Calls', count: '≈100' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '33.3%', label: 'Reasoning', count: '≈100' })
    await m.unmount()

    const zh = await mount(h(makeStatsTokens(makeKit('zh'), Donut), { usage, current, breakdown: null, generatedReasoning: 40, generatedCallTokens: 60 }))
    assert.deepEqual(rowOf(zh.container, 2), { pct: '33.3%', label: '模型思考', count: '≈100' })
    await zh.unmount()
  })

  test('a delivered breakdown drives the prompt-side split ratios', async () => {
    const current: Snapshot['current'] = { system: 0, tools: 0, user: 150, inject: 0, skill: 0, assistant: 150, tool: 0, total: 300 }
    const breakdown: ContextBreakdown = { systemTokens: 100, toolsTokens: 100, messageTokens: 200 }
    const usage: TokenUsage = { uncachedInputTokens: 800, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage, current, breakdown }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '840')
    assert.deepEqual(rowOf(m.container, 0), { pct: '23.8%', label: 'System Prompt', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.8%', label: 'Tool Schemas', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '23.8%', label: 'User Messages', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '28.6%', label: 'Tool Calls', count: '≈240' })
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[0]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(rows[0].className.includes('lc-sl-row-on'))
    await unhover(rows[0])
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await m.unmount()
  })

  test('null or zero usage degrades to the matching center and zero rows with dash shares', async () => {
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const [usage, center] of [[null, '—'], [zero, '0']] as [TokenUsage | null, string][]) {
      const m = await mount(h(StatsTokens, { usage, current: CURRENT, breakdown: null }))
      assert.equal(query(m.container, '.lc-donut-center b').textContent, center)
      assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 8)
      for (const row of queryAll(m.container, '.lc-sl-row')) {
        assert.equal(row.querySelector('.lc-sl-pct')?.textContent, '—')
      }
      const counts = queryAll(m.container, '.lc-sl-sub').map(n => n.textContent)
      assert.deepEqual(counts, ['≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '≈0'])
      assert.ok(query(m.container, '.lc-donut-track'), 'an all-zero ring draws the neutral track')
      await m.unmount()
    }
  })
})

describe('StatsTokens — the cache-hit corner figure', () => {
  test('a billed session shows its cache-hit share; an unbilled or unreported session renders no figure', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, 'Cache Hit 25.00%', '100 reads over the 400 billed')
    assert.ok(rate?.getAttribute('title')?.includes('Cumulative cache-read share'))
    await m.unmount()

    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const usage of [null, zero] as (TokenUsage | null)[]) {
      const bare = await mount(h(StatsTokens, { usage, current: CURRENT, breakdown: null }))
      assert.equal(queryAll(bare.container, '.lc-card-rate').length, 0, JSON.stringify(usage))
      await bare.unmount()
    }
  })
})
