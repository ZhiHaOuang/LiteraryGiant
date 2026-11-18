import { act, createElement as h, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ClearableInput } from '../../../src/client/components/clearableInput'
import { click, keydown, mount, press, query, typeText } from '../helpers/kit'

function Field(props: {
  initial?: string
  type?: 'search' | 'text'
  onKeyDown?: (ev: ReactKeyboardEvent<HTMLInputElement>) => void
}): ReactElement {
  const [value, setValue] = useState(props.initial ?? '')
  return h(ClearableInput, {
    value,
    onChange: setValue,
    className: 'lc-fa-search',
    placeholder: 'Filter…',
    clearLabel: 'Clear input',
    ...(props.type !== undefined ? { type: props.type } : {}),
    ...(props.onKeyDown !== undefined ? { onKeyDown: props.onKeyDown } : {}),
  })
}

describe('ClearableInput', () => {
  test('an empty field shows no clear control until typing fills it', async () => {
    const m = await mount(h(Field, {}))
    const box = query(m.container, '.lc-searchbox')
    assert.equal(box.className, 'lc-searchbox')
    assert.equal(m.container.querySelector('.lc-searchbox-x'), null)
    const input = query<HTMLInputElement>(m.container, 'input')
    assert.equal(input.className, 'lc-fa-search')
    assert.equal(input.getAttribute('data-lc-clearable'), '')
    assert.equal(input.type, 'text')
    assert.equal(input.getAttribute('aria-label'), 'Filter…', 'the placeholder names the field')
    await typeText(input, 'worker')
    assert.equal(input.value, 'worker')
    assert.equal(box.className, 'lc-searchbox lc-searchbox-on')
    assert.equal(query<HTMLButtonElement>(m.container, '.lc-searchbox-x').getAttribute('aria-label'), 'Clear input')
    await m.unmount()

    const seen: string[] = []
    const ref = { current: null as HTMLInputElement | null }
    function Bound(): ReactElement {
      return h(ClearableInput, {
        value: 'x',
        onChange: () => {},
        className: 'lc-ov-search',
        placeholder: 'Search',
        clearLabel: 'Clear input',
        type: 'search',
        inputRef: ref,
        onKeyDown: (ev: ReactKeyboardEvent<HTMLInputElement>) => { seen.push(ev.key) },
      })
    }
    const bound = await mount(h(Bound, {}))
    const boundInput = query<HTMLInputElement>(bound.container, 'input')
    assert.equal(boundInput.type, 'search')
    assert.equal(ref.current, boundInput)
    await keydown('Enter', boundInput)
    assert.deepEqual(seen, ['Enter'])
    await bound.unmount()
  })

  test('the clear control empties the field and keeps focus in the input', async () => {
    const m = await mount(h(Field, { initial: 'worker' }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const clear = query<HTMLButtonElement>(m.container, '.lc-searchbox-x')
    assert.equal(clear.type, 'button')
    assert.equal(clear.title, 'Clear input')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { clear.dispatchEvent(down) })
    assert.equal(down.defaultPrevented, true, 'the press never steals focus from the input')
    await click(clear)
    assert.equal(input.value, '')
    assert.equal(document.activeElement, input)
    assert.equal(m.container.querySelector('.lc-searchbox-x'), null)
    await m.unmount()
  })

  test('Escape clears typed content and stays away from the host overlay', async () => {
    const m = await mount(h(Field, { initial: 'worker' }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const { ev, reachedDocument } = await press(input, { key: 'Escape' })
    assert.equal(input.value, '')
    assert.equal(ev.defaultPrevented, true)
    assert.equal(reachedDocument, false, 'the overlay must not also close')
    await m.unmount()
  })

  test('Escape leaves an empty, composing, or modifier-held field to the host', async () => {
    const empty = await mount(h(Field, {}))
    const emptyInput = query<HTMLInputElement>(empty.container, 'input')
    const emptyEsc = await press(emptyInput, { key: 'Escape' })
    assert.equal(emptyEsc.ev.defaultPrevented, false)
    assert.equal(emptyEsc.reachedDocument, true)
    await empty.unmount()

    const filled = await mount(h(Field, { initial: 'x' }))
    const input = query<HTMLInputElement>(filled.container, 'input')
    const composing = await press(input, { key: 'Escape', isComposing: true })
    assert.equal(input.value, 'x', 'Escape during IME composition stays with the IME')
    assert.equal(composing.ev.defaultPrevented, false)
    assert.equal(composing.reachedDocument, true)
    const modifiers: KeyboardEventInit[] = [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]
    for (const init of modifiers) {
      const { ev, reachedDocument } = await press(input, { key: 'Escape', ...init })
      assert.equal(input.value, 'x')
      assert.equal(ev.defaultPrevented, false)
      assert.equal(reachedDocument, true)
    }
    await filled.unmount()
  })

  test("a caller's preventDefault wins over Escape clearing", async () => {
    const m = await mount(h(Field, {
      initial: 'x',
      onKeyDown: (ev: ReactKeyboardEvent<HTMLInputElement>) => { if (ev.key === 'Escape') ev.preventDefault() },
    }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const { ev, reachedDocument } = await press(input, { key: 'Escape' })
    assert.equal(input.value, 'x')
    assert.equal(ev.defaultPrevented, true)
    assert.equal(reachedDocument, true, 'the caller only prevented the default action')
    await m.unmount()
  })
})
