import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { blockSummaryOf, callNamesOf, callSummaryOf, summaryInArgs } from '../../src/client/callSummary'
import type { ConversationNodeLike } from '../../src/client/services'

function conv(over: Partial<ConversationNodeLike> = {}): ConversationNodeLike {
  return { kind: 'assistant', seq: 1, ...over }
}

describe('summaryInArgs', () => {
  test('the keys win in description, file_path, path, filePath order; unusable values skip', () => {
    assert.equal(summaryInArgs(null), null)
    assert.equal(summaryInArgs({ description: 'd', file_path: 'f', path: 'p', filePath: 'fp' }), 'd')
    assert.equal(summaryInArgs({ file_path: 'f', path: 'p', filePath: 'fp' }), 'f')
    assert.equal(summaryInArgs({ path: 'p', filePath: 'fp' }), 'p')
    assert.equal(summaryInArgs({ filePath: 'fp' }), 'fp')
    assert.equal(summaryInArgs({ description: '', file_path: 'f' }), 'f')
    assert.equal(summaryInArgs({ description: 42, path: 'p' }), 'p')
    assert.equal(summaryInArgs({ foo: 'bar' }), null)
  })
})

describe('callSummaryOf', () => {
  test('an undefined conversation, a missing call, or an unusable payload yields null; otherwise the call\'s args supply the summary', () => {
    assert.equal(callSummaryOf(undefined), null)
    assert.equal(callSummaryOf(conv()), null)
    assert.equal(callSummaryOf(conv({ call: null })), null)
    assert.equal(callSummaryOf(conv({ call: { name: 'bash', argsRaw: '{oops' } })), null)
    assert.equal(callSummaryOf(conv({ call: { name: 'edit', argsRaw: '{"file_path":"a.ts"}' } })), 'a.ts')
  })
})

describe('blockSummaryOf', () => {
  test('an undefined conversation or non-array blocks yield null; unusable entries skip and the first usable tool-call summary wins', () => {
    assert.equal(blockSummaryOf(undefined), null)
    assert.equal(blockSummaryOf(conv({ blocks: 'junk' as unknown as unknown[] })), null)
    const blocks = [
      null,
      42,
      { kind: 'text' },
      { kind: 'tool-call', argsRaw: '{oops' },
      { kind: 'tool-call', argsRaw: '{"foo":1}' },
      { kind: 'tool-call', argsRaw: '{"description":"first"}' },
      { kind: 'tool-call', argsRaw: '{"description":"second"}' },
    ]
    assert.equal(blockSummaryOf(conv({ blocks })), 'first')
    assert.equal(blockSummaryOf(conv({ blocks: [{ kind: 'tool-call', argsRaw: '{oops' }, null] })), null)
  })
})

describe('callNamesOf', () => {
  test('an undefined conversation or non-array blocks yield an empty list; mixed entries filter to names', () => {
    assert.deepEqual(callNamesOf(undefined), [])
    assert.deepEqual(callNamesOf(conv({ blocks: 'junk' as unknown as unknown[] })), [])
    const blocks = [
      null,
      42,
      { kind: 'text', name: 'not-a-call' },
      { kind: 'tool-call' },
      { kind: 'tool-call', name: 42 },
      { kind: 'tool-call', name: 'bash' },
      { kind: 'tool-call', name: 'read' },
    ]
    assert.deepEqual(callNamesOf(conv({ blocks })), ['bash', 'read'])
  })
})
