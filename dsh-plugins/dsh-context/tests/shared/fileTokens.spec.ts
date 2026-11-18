import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateFileTokens } from '../../src/shared/fileTokens'

const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function file(over: { name?: string; bytes?: number; attachmentId?: string } = {}) {
  return { attachmentId: DIGEST, name: 'notes.md', bytes: 120, ...over }
}

describe('estimateFileTokens', () => {
  test('the price is the harness handle priced as one text block', () => {
    const handle = '[File "notes.md" (120 bytes, sha256:01234567) was uploaded, but the current execution'
      + ' environment cannot access a readable path. Report that limitation if its contents are needed;'
      + ' do not claim to have read it.]'
    assert.equal(estimateFileTokens(file()), Math.ceil(handle.length / 4) + 4)
    assert.equal(estimateFileTokens(file({ bytes: 778_285 })), 58, 'only the name and digest prefix reach the handle')
    assert.equal(estimateFileTokens(file({ attachmentId: `sha256:${'f'.repeat(64)}` })), 57)
  })

  test('a name or a byte size the log does not prove prices nothing', () => {
    assert.equal(estimateFileTokens(file({ name: undefined })), null)
    assert.equal(estimateFileTokens(file({ bytes: undefined })), null)
  })
})