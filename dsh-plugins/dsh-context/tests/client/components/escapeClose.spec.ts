import { createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { useEscapeClose } from '../../../src/client/components/escapeClose'
import { keydown, mount, press } from '../helpers/kit'

function Overlay(props: { active: boolean; onClose: () => void }): ReactElement {
  useEscapeClose(props.active, props.onClose)
  return h('div', { className: 'overlay' })
}

function field(tag: 'input' | 'textarea', marked: boolean, value: string): HTMLInputElement | HTMLTextAreaElement {
  const el = document.createElement(tag)
  if (marked) el.dataset.lcClearable = ''
  el.value = value
  document.body.append(el)
  return el
}

describe('useEscapeClose', () => {
  test('Escape yields to a marked field with typed content', async () => {
    const closes: string[] = []
    const m = await mount(h(Overlay, { active: true, onClose: () => closes.push('close') }))
    const markedInput = field('input', true, 'x')
    const filled = await press(markedInput, { key: 'Escape' })
    assert.deepEqual(closes, [], 'the field keeps the key so it can clear itself')
    assert.equal(filled.ev.defaultPrevented, false, 'the field handler owns preventDefault, not the overlay')
    assert.equal(filled.reachedDocument, true)

    markedInput.value = ''
    const empty = await press(markedInput, { key: 'Escape' })
    assert.deepEqual(closes, ['close'], 'an empty field lets the overlay close')
    assert.equal(empty.reachedDocument, false, 'the overlay consumes the close it performs')

    const plainInput = field('input', false, 'x')
    await press(plainInput, { key: 'Escape' })
    assert.equal(closes.length, 2, 'an unmarked field never withholds the overlay close')

    const markedArea = field('textarea', true, 'x')
    await press(markedArea, { key: 'Escape' })
    assert.equal(closes.length, 2, 'a marked textarea with content keeps the key too')

    markedInput.value = 'x'
    const modified = await press(markedInput, { key: 'Escape', shiftKey: true })
    assert.equal(closes.length, 2, 'a modified Escape is not the dismiss gesture')
    assert.equal(modified.reachedDocument, true)

    const composing = await press(markedInput, { key: 'Escape', isComposing: true })
    assert.equal(closes.length, 2, 'composition keeps Escape with the IME')
    assert.equal(composing.ev.defaultPrevented, false, 'the IME default action survives')
    assert.equal(composing.reachedDocument, false, 'the overlay does not let the key leak to the harness')

    await keydown('Escape')
    assert.equal(closes.length, 3, 'a window-level Escape still closes')

    markedInput.remove()
    plainInput.remove()
    markedArea.remove()
    await m.unmount()
  })
})
