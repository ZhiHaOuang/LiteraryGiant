import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSystemContent, estimateSystemTokens } from '../../src/shared/estimate'

describe('estimateSystemTokens', () => {
  test('prices text density plus role framing', () => {
    assert.equal(estimateSystemTokens('abcdefgh'), 2 + 4)
    assert.equal(estimateSystemTokens('abcde'), 2 + 4, 'partial tokens round up')
  })

  test('absent, empty, and non-string input prices 0', () => {
    assert.equal(estimateSystemTokens(undefined), 0)
    assert.equal(estimateSystemTokens(null), 0)
    assert.equal(estimateSystemTokens(''), 0)
    assert.equal(estimateSystemTokens(42), 0)
    assert.equal(estimateSystemTokens({ text: 'x' }), 0)
  })
})

describe('estimateSystemContent', () => {
  test('prices every text block with no per-block overhead; no content prices 0', () => {
    assert.equal(estimateSystemContent([{ type: 'text', text: 'abcdefgh' }]), 2 + 4)
    assert.equal(
      estimateSystemContent([{ type: 'text', text: 'abcd' }, { type: 'text', text: 'efgh' }]),
      2 + 4,
      'blocks are summed before the density divide, exactly like the harness estimator',
    )
    assert.equal(estimateSystemContent([]), 0)
    assert.equal(estimateSystemContent(undefined), 0)
    assert.equal(estimateSystemContent('text'), 0)
  })

  test('a non-text element falls back to its JSON length; hostile elements degrade instead of throwing', () => {
    const block = { type: 'image', attachment: { width: 1, height: 1 } }
    assert.equal(estimateSystemContent([block]), Math.ceil(JSON.stringify(block).length / 4) + 4)
    assert.equal(estimateSystemContent([7]), Math.ceil('7'.length / 4) + 4)
    assert.equal(estimateSystemContent([undefined]), 0 + 4)
    assert.equal(estimateSystemContent([{ type: 'text', text: 42 }]), Math.ceil('{"type":"text","text":42}'.length / 4) + 4)
    const cyclic: Record<string, unknown> = { type: 'weird' }
    cyclic.self = cyclic
    assert.equal(estimateSystemContent([cyclic]), 4, 'role framing survives, content prices 0')
  })
})
