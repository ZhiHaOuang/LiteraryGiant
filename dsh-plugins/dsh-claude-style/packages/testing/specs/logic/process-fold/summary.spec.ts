/**
 * A process group's header names what the group holds: thoughts, outputs, tool
 * calls and records, counted from the body's own rows, in a sentence while it
 * fits and in compact figures when it does not.
 *
 * @capability process-fold
 * @features chat-fold
 * @risk A folded process group claims the wrong number of thoughts or tool calls, counts a tool's inner calls twice, or overflows its header with a sentence that does not fit.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { countProcessItems, summaryForm, summaryParts, summarySeparator, summaryText } from '@dsh-claude-style/client/pure'
import { ASSISTANT_STEP_KIND, CHAT_GROUP_PART_ATTRIBUTE, CHAT_GROUP_PART_REASONING, FLOW_KIND_ATTRIBUTE, TOOL_CALL_KIND } from '@dsh-claude-style/contracts/dom'

/** One flow row of a group body, of one kind and optionally one step part. */
function flowRow(kind: string, part?: string) {
  const row = document.createElement('div')
  row.setAttribute(FLOW_KIND_ATTRIBUTE, kind)
  if (part !== undefined) row.setAttribute(CHAT_GROUP_PART_ATTRIBUTE, part)
  return row
}

test('a body counts its own rows: thoughts and outputs by their part, tool calls, and everything else as records', () => {
  const body = document.createElement('div')
  const tool = flowRow(TOOL_CALL_KIND)
  tool.append(flowRow(TOOL_CALL_KIND))
  body.append(
    flowRow(ASSISTANT_STEP_KIND, CHAT_GROUP_PART_REASONING),
    tool,
    flowRow(ASSISTANT_STEP_KIND, CHAT_GROUP_PART_REASONING),
    flowRow(ASSISTANT_STEP_KIND, 'response'),
    flowRow('command'),
    document.createElement('div'),
  )
  expect(countProcessItems(body)).toEqual({ thinking: 2, output: 1, tool: 1, record: 1 })
})

test('the figures read in order and the empty ones are left out', () => {
  const sentence = summaryParts({ thinking: 2, output: 0, tool: 3, record: 0 }, 'full')
  expect(sentence.map(part => part.figure)).toEqual(['thinking', 'tool'])
  expect(summaryText(sentence, 'full')).toBe('2 thoughts, 3 tool calls')
  expect(summaryText(summaryParts({ thinking: 2, output: 0, tool: 3, record: 0 }, 'compact'), 'compact')).toBe('Thinking×2 · Tools×3')
})

test('a count of one reads in the singular', () => {
  expect(summaryText(summaryParts({ thinking: 1, output: 1, tool: 1, record: 1 }, 'full'), 'full'))
    .toBe('1 thought, 1 output, 1 tool call, 1 record')
  expect(summarySeparator('full')).toBe(', ')
})

test('a group with nothing counted has no summary', () => {
  expect(summaryParts({ thinking: 0, output: 0, tool: 0, record: 0 }, 'full')).toEqual([])
})

test('every figure the line shows is a count the group holds, in either wording', () => {
  const counts = fc.record({ thinking: fc.nat(40), output: fc.nat(40), tool: fc.nat(40), record: fc.nat(40) })
  fc.assert(fc.property(counts, fc.constantFrom('full' as const, 'compact' as const), (held, form) => {
    const parts = summaryParts(held, form)
    expect(parts.map(part => part.count)).toEqual(Object.values(held).filter(count => count > 0))
    const text = summaryText(parts, form)
    for (const part of parts) expect(text).toContain(`${part.before}${part.count}${part.after}`)
  }))
})

test('the sentence stands while it fits, the compact figures take over when it does not', () => {
  expect(summaryForm(120, 200)).toBe('full')
  expect(summaryForm(200, 200)).toBe('full')
  expect(summaryForm(201, 200)).toBe('compact')
})
