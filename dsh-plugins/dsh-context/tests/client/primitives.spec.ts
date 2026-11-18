import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { FileTypeGlyph, resolveFileGlyph, resolveIcon, IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown } from '../../src/client/primitives'

describe('resolveIcon', () => {
  const icon = function SomeIcon(): null { return null }

  test('a present export resolves to the component; a non-component, a missing name, or a hostile read renders nothing', () => {
    assert.equal(resolveIcon('icon', { icon }), icon)
    assert.equal(resolveIcon('icon', { icon: 42 })({}), null, 'a non-component export')
    assert.equal(resolveIcon('IconGhostOutlineRegular', {})({}), null, 'a future rename')
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    assert.equal(resolveIcon('IconBranchOutlineRegular', hostile)({}), null)
  })

  test('the module-level exports resolve against the pinned generation', () => {
    for (const icon of [IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown]) {
      assert.equal(typeof icon, 'function', 'every seam resolves to a component')
    }
    assert.equal(typeof FileTypeGlyph, 'function', 'the file-type glyph resolves too')
  })
})

describe('resolveFileGlyph', () => {
  const glyph = function SomeGlyph(): null { return null }

  test('a present export resolves; a missing, non-component, or hostile read renders nothing', () => {
    assert.equal(resolveFileGlyph({ FileTypeIcon: glyph }), glyph)
    assert.equal(resolveFileGlyph({ FileTypeIcon: 42 })({}), null)
    assert.equal(resolveFileGlyph({})({}), null)
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    assert.equal(resolveFileGlyph(hostile)({}), null)
  })
})
