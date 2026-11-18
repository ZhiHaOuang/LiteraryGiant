import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeNodeText } from '../../../src/client/components/nodes'
import { makeKit } from '../helpers/kit'

const kit = makeKit()
const nodeText = makeNodeText(kit)

describe('makeNodeText', () => {
  test('tool results name the tool; failures carry the warning glyph; a skill tag leads only off the tool arm', () => {
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash' }), 'Tool Result ← bash')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1 }), 'Tool Result')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash', err: true }), 'Tool Result ← bash ⚠')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, skill: 'code-review' }), 'Tool Result')
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, skill: 'code-review' }), 'Skill: code-review')
  })

  test('assistant replies show text, a calls breadcrumb, or the empty marker', () => {
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1, text: 'hi' }), 'hi')
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1, calls: ['bash', 'read'] }), 'Calls bash, read')
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1 }), '(empty reply)')
  })

  test('snapshot-form text gets the snapshot prefix; plain text shows as-is', () => {
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, form: 'snapshot', text: 'a, b' }), 'Snapshot: a, b')
    assert.equal(nodeText({ seq: 1, cat: 'user', tokens: 1, text: 'plain' }), 'plain')
  })

  test('textless injects label their form; anything else is a non-text message', () => {
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, form: 'notice' }), 'Notice')
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1 }), 'Context Injection')
    assert.equal(nodeText({ seq: 1, cat: 'user', tokens: 1 }), '(non-text message)')
  })
})
