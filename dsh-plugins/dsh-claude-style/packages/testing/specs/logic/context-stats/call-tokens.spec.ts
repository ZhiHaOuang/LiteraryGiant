/**
 * The tokens one tool call adds to the written-back figure: the tool's own price,
 * and the median of every call for a tool the table does not name.
 *
 * @capability context-stats
 * @features context-stats
 * @risk A step that only calls a tool streams no text, so the written-back figure prices its call rows alone; one count for every tool overprices a read and underprices a write, and a tool the host adds later would add nothing at all.
 */
import { expect, test } from 'vitest'
import { callTokens } from '@dsh-claude-style/client/pure'

test('a tool the table names costs its own figure', () => {
  expect(callTokens('read')).toBe(85)
  expect(callTokens('write')).toBe(605)
})

test('the same tool under another agent costs that agent\'s figure', () => {
  expect(callTokens('Bash')).toBeGreaterThan(callTokens('bash'))
  expect(callTokens('Write')).toBeGreaterThan(callTokens('write'))
})

test('a call that writes costs several times a call that reads', () => {
  expect(callTokens('write')).toBeGreaterThan(callTokens('read') * 3)
})

test('an unnamed tool costs what a call costs on the median', () => {
  expect(callTokens('a-tool-the-host-added-later')).toBe(callTokens(null))
})

test('the prototype does not answer for a tool name', () => {
  expect(callTokens('constructor')).toBe(callTokens(null))
})
