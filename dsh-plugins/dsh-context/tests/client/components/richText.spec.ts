import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { jsonOf, makeRichText } from '../../../src/client/components/richText'
import type { RichMode } from '../../../src/client/components/richText'
import { click, hover, makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const { RichText, RichSwitch, useRichMode } = makeRichText(kit)

const SAMPLE = '# Title\n\nsome **bold** text'
const JSON_SAMPLE = '{"name": "dsh", "meta": {"tags": ["a", "b"], "ver": 2}}'

function rawText(container: ParentNode): string {
  return queryAll(container, '.lc-ts-line').map(line => line.textContent).join('\n')
}

function Harness(props: { text: string }) {
  const [mode, setMode, json] = useRichMode(props.text)
  return h('div', {}, h(RichSwitch, { mode, json, onPick: setMode }), h(RichText, { text: props.text, mode }))
}

describe('RichText', () => {
  test('md mode renders real markdown through the shared MarkdownText', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'md' }))
    const box = query(m.container, '.lc-ts-desc-md')
    assert.equal(query(box, 'h1').textContent, 'Title')
    assert.equal(query(box, 'strong').textContent, 'bold')
    await m.unmount()
  })

  test('raw mode renders one numbered line span per source line, dropping only a trailing newline row', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'raw' }))
    assert.equal(rawText(m.container), SAMPLE)
    assert.equal(queryAll(m.container, '.lc-ts-line').length, 3)
    assert.equal(queryAll(m.container, 'h1').length, 0)
    await m.unmount()

    const trailing = await mount(h(RichText, { text: 'a\n\nb\n', mode: 'raw' }))
    assert.deepEqual(queryAll(trailing.container, '.lc-ts-line').map(line => line.textContent), ['a', '', 'b'])
    await trailing.unmount()

    const empty = await mount(h(RichText, { text: '', mode: 'raw' }))
    assert.deepEqual(queryAll(empty.container, '.lc-ts-line').map(line => line.textContent), [''])
    await empty.unmount()
  })

  test('json mode renders the tree two levels deep and restores the previously focused element', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const m = await mount(h(RichText, { text: JSON_SAMPLE, mode: 'json' }))
    const tree = query(m.container, '.lc-ts-desc-json [role=tree]')
    assert.equal(tree.getAttribute('aria-label'), 'JSON Content')
    const rows = queryAll(m.container, '[role=treeitem]')
    assert.equal(rows.length, 4)
    assert.match(rows.map(r => r.textContent).join('|'), /tags/)
    assert.equal(document.activeElement, outside, 'the second-level auto-open never steals focus')
    await hover(rows[0])
    const copy = query(m.container, '[data-json-copy-button]')
    assert.equal(copy.getAttribute('title'), 'Copy value; right-click for copy options')
    outside.remove()
    await m.unmount()
  })

  test('json mode caps the second-level auto-open at 100 nodes', async () => {
    const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, { v: i }])))
    const m = await mount(h(RichText, { text: wide, mode: 'json' }))
    const open = queryAll(m.container, '[data-json-expander][aria-expanded=true]')
    assert.equal(open.length, 100)
    await m.unmount()
  })

  test('a data swap keeps a still-keyed node expanded without re-toggling it', async () => {
    const m = await mount(h(RichText, { text: '{"a": {"x": 1}}', mode: 'json' }))
    assert.equal(queryAll(m.container, '[role=treeitem]').length, 2)
    await m.update(h(RichText, { text: '{"a": {"y": 2}}', mode: 'json' }))
    const rows = queryAll(m.container, '[role=treeitem]')
    assert.equal(rows.length, 2, 'the swap did not collapse or double-toggle the keyed node')
    assert.match(rows[1].textContent ?? '', /y/)
    await m.unmount()
  })

  test('json mode on a text that no longer parses degrades to markdown', async () => {
    const m = await mount(h(RichText, { text: '{not json', mode: 'json' }))
    assert.ok(query(m.container, '.lc-ts-desc-md'))
    assert.equal(queryAll(m.container, '[role=tree]').length, 0)
    await m.unmount()
  })
})

describe('jsonOf', () => {
  test('parses whole-text objects and arrays; rejects non-bracket leads, broken payloads, and trailing garbage', () => {
    assert.deepEqual(jsonOf('{"a": 1}'), { a: 1 })
    assert.deepEqual(jsonOf('  [1, "x"]\n'), [1, 'x'])
    assert.deepEqual(jsonOf('{}'), {})
    assert.equal(jsonOf('plain text'), null)
    assert.equal(jsonOf('"quoted"'), null)
    assert.equal(jsonOf('{not json'), null)
    assert.equal(jsonOf('{"a": 1} extra'), null)
  })
})

describe('RichSwitch', () => {
  test('two segments with titles; the active mode carries the on class; clicks report the pick', async () => {
    const picks: RichMode[] = []
    const m = await mount(h(RichSwitch, { mode: 'md', onPick: m2 => picks.push(m2) }))
    const buttons = queryAll(m.container, '.lc-gran-btn')
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].textContent, 'Raw')
    assert.equal(buttons[0].getAttribute('title'), 'View Raw Text')
    assert.ok(!buttons[0].className.includes('lc-gran-on'))
    assert.equal(buttons[1].textContent, 'Markdown')
    assert.equal(buttons[1].getAttribute('title'), 'View as Markdown')
    assert.ok(buttons[1].className.includes('lc-gran-on'))
    await click(buttons[0])
    await click(buttons[1])
    assert.deepEqual(picks, ['raw', 'md'])
    await m.unmount()

    const json = await mount(h(RichSwitch, { mode: 'json', json: true, onPick: () => {} }))
    const jsonButtons = queryAll(json.container, '.lc-gran-btn')
    assert.deepEqual(jsonButtons.map(b => b.textContent), ['Raw', 'JSON'])
    assert.equal(jsonButtons[1].getAttribute('title'), 'View as JSON Tree')
    assert.ok(jsonButtons[1].className.includes('lc-gran-on'))
    await json.unmount()
  })
})

describe('useRichMode', () => {
  test('defaults to markdown and flips to raw via the switch', async () => {
    const m = await mount(h(Harness, { text: SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-md'))
    const buttons = queryAll(m.container, '.lc-gran-btn')
    await click(buttons[0])
    assert.equal(rawText(m.container), SAMPLE)
    await click(queryAll(m.container, '.lc-gran-btn')[1])
    assert.equal(query(m.container, '.lc-ts-desc-md h1').textContent, 'Title')
    await m.unmount()
  })

  test('a JSON body opens on the tree, markdown unoffered; raw stays one click away', async () => {
    const m = await mount(h(Harness, { text: JSON_SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-json [role=tree]'))
    const buttons = queryAll(m.container, '.lc-gran-btn')
    assert.deepEqual(buttons.map(b => b.textContent), ['Raw', 'JSON'])
    await click(buttons[0])
    assert.equal(rawText(m.container), JSON_SAMPLE)
    await click(queryAll(m.container, '.lc-gran-btn')[1])
    assert.ok(query(m.container, '.lc-ts-desc-json [role=tree]'))
    await m.unmount()
  })

  test('a stale json pick falls back to markdown when the body stops parsing', async () => {
    const m = await mount(h(Harness, { text: JSON_SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-json'))
    await m.update(h(Harness, { text: SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-md'), 'the explicit json pick did not survive a non-JSON body')
    assert.deepEqual(queryAll(m.container, '.lc-gran-btn').map(b => b.textContent), ['Raw', 'Markdown'])
    await m.unmount()
  })
})

describe('RichCopy', () => {
  const { RichCopy } = makeRichText(kit)

  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
  }

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window.navigator, 'clipboard')
  })

  test('an accepted write flips to the check glyph, ignores a repeat click, then resets', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    stubClipboard(async (text) => { writes.push(text) })
    const m = await mount(h(RichCopy, { text: SAMPLE }))
    const button = query(m.container, '.lc-rich-copy')
    assert.ok(!button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copy Raw Text')
    await click(button)
    assert.deepEqual(writes, [SAMPLE], 'the exact source text reached the clipboard host')
    assert.ok(button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copied')
    await click(button)
    assert.deepEqual(writes, [SAMPLE])
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    assert.ok(!button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copy Raw Text')
    await m.unmount()
  })

  test('a rejected host write claims no success (no clipboard in jsdom)', async () => {
    const m = await mount(h(RichCopy, { text: SAMPLE }))
    const button = query(m.container, '.lc-rich-copy')
    await click(button)
    assert.ok(!button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copy Raw Text')
    await m.unmount()
  })
})

describe('useRichFind', () => {
  const { useRichFind } = makeRichText(kit)

  afterEach(() => {
    vi.useRealTimers()
  })

  function FindHarness(props: { text: string; mode?: RichMode }) {
    const find = useRichFind(props.text, props.mode ?? 'raw')
    return h('div', {},
      find.button,
      find.bar,
      h('div', { key: find.bodyKey, ref: find.bodyRef },
        h(RichText, { text: props.text, mode: props.mode ?? 'raw' })))
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function openFind(container: HTMLElement): Promise<HTMLInputElement> {
    await click(query(container, '.lc-find-btn'))
    return query<HTMLInputElement>(container, '.lc-find-input')
  }

  async function settle(): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  }

  function barButtons(container: HTMLElement): HTMLElement[] {
    return queryAll(query(container, '.lc-find'), '.lc-find-btn')
  }

  test('the toggle opens the bar with the input focused; the close button folds it back', async () => {
    const m = await mount(h(FindHarness, { text: SAMPLE }))
    const toggle = query(m.container, '.lc-find-btn')
    assert.equal(toggle.getAttribute('title'), 'Find in Text')
    assert.equal(queryAll(m.container, '.lc-find').length, 0)
    await click(toggle)
    const input = query<HTMLInputElement>(m.container, '.lc-find-input')
    assert.equal(document.activeElement, input, 'the input takes focus on open')
    assert.equal(input.placeholder, 'Find…')
    assert.ok(toggle.className.includes('lc-find-btn-on'))
    const close = barButtons(m.container)[2]
    assert.equal(close.getAttribute('title'), 'Close Find')
    await click(close)
    assert.equal(queryAll(m.container, '.lc-find').length, 0)
    assert.ok(!query(m.container, '.lc-find-btn').className.includes('lc-find-btn-on'))
    await m.unmount()
  })

  test('a settled query highlights case-insensitive matches and counts the active one', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'Alpha beta ALPHA other' }))
    const input = await openFind(m.container)
    await type(input, 'alpha')
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 0, 'no scan before the debounce settles')
    await settle()
    const marks = queryAll(m.container, '.lc-find-mark')
    assert.deepEqual(marks.map(x => x.textContent), ['Alpha', 'ALPHA'])
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/2')
    assert.ok(marks[0].className.includes('lc-find-mark-on'))
    assert.equal(queryAll(m.container, '.lc-find-mark-on').length, 1)
    await m.unmount()

    const rapid = await mount(h(FindHarness, { text: 'alpha alphabet beta' }))
    const rapidInput = await openFind(rapid.container)
    await type(rapidInput, 'a')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    await type(rapidInput, 'al')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    assert.equal(queryAll(rapid.container, '.lc-find-mark').length, 0, 'keystrokes inside the window never scanned')
    await type(rapidInput, 'alp')
    await settle()
    assert.deepEqual(queryAll(rapid.container, '.lc-find-mark').map(x => x.textContent), ['alp', 'alp'])
    await rapid.unmount()
  })

  test('Enter and Shift+Enter cycle the active match with wraparound; the chevrons do the same', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'one two one two one' }))
    const input = await openFind(m.container)
    await type(input, 'one')
    await settle()
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/3')
    const enter = (shift: boolean) => act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }))
    })
    await enter(false)
    assert.equal(query(m.container, '.lc-find-count').textContent, '2/3')
    await enter(false)
    await enter(false)
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/3', 'Enter wraps past the last match')
    await enter(true)
    assert.equal(query(m.container, '.lc-find-count').textContent, '3/3', 'Shift+Enter walks backwards')
    const [prev, next] = barButtons(m.container)
    assert.equal(prev.getAttribute('title'), 'Previous Match')
    assert.equal(next.getAttribute('title'), 'Next Match')
    await click(next)
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/3')
    await click(prev)
    assert.equal(query(m.container, '.lc-find-count').textContent, '3/3')
    assert.ok(queryAll(m.container, '.lc-find-mark')[2].className.includes('lc-find-mark-on'))
    await m.unmount()
  })

  test('Escape clears the query and marks first, then folds the bar; the body text is byte-identical afterwards', async () => {
    vi.useFakeTimers()
    const source = 'Alpha beta ALPHA other'
    const m = await mount(h(FindHarness, { text: source }))
    const input = await openFind(m.container)
    await type(input, 'alpha')
    await settle()
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 2)
    assert.equal(rawText(m.container), source, 'marks never alter the copyable source text')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, 'alpha', 'a modified Escape does not clear')
    assert.equal(queryAll(m.container, '.lc-find').length, 1, 'nor does it fold the bar')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, '', 'the typed query is cleared first')
    assert.equal(queryAll(m.container, '.lc-find').length, 1, 'the bar stays open for a fresh query')
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 0)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(queryAll(m.container, '.lc-find').length, 0, 'an empty field folds the bar')
    assert.equal(rawText(m.container), source, 'the restore rebuilt the exact original text nodes')
    await m.unmount()
  })

  test('a match spanning two text nodes is marked across both, and the restore rebuilds them', async () => {
    vi.useFakeTimers()
    const Body = () => h('div', {},
      h('span', { style: { color: 'red' } }, 'alpha '),
      h('span', {}, 'beta gamma'))
    function SplitHarness() {
      const find = useRichFind('alpha beta gamma', 'raw')
      return h('div', {}, find.button, find.bar,
        h('div', { key: find.bodyKey, ref: find.bodyRef, className: 'split-body' }, h(Body, {})))
    }
    const m = await mount(h(SplitHarness, {}))
    const input = await openFind(m.container)
    await type(input, 'alpha beta')
    await settle()
    const marks = queryAll(m.container, '.lc-find-mark')
    assert.deepEqual(marks.map(x => x.textContent), ['alpha ', 'beta'], 'one mark per text node the match covers')
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/1', 'the pieces count as one match')
    assert.ok(marks.every(mark => mark.className.includes('lc-find-mark-on')), 'every piece of the active match carries the active tone')
    await type(input, '')
    const body = query(m.container, '.split-body')
    assert.equal(queryAll(body, '.lc-find-mark').length, 0)
    assert.deepEqual(queryAll(body, 'span').map(span => span.textContent), ['alpha ', 'beta gamma'], 'the split nodes are back in one piece each')
    await m.unmount()
  })

  test('deleting the whole query clears the marks at once, without the debounce', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'alpha beta' }))
    const input = await openFind(m.container)
    await type(input, 'alpha')
    await settle()
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 1)
    await type(input, '')
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 0, 'an empty query applies immediately')
    assert.equal(queryAll(m.container, '.lc-find-count').length, 0)
    await m.unmount()
  })

  test('zero matches shows 0/0 and disables the chevrons; stray keys and Enter are harmless', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'alpha beta' }))
    const input = await openFind(m.container)
    await type(input, 'zzz')
    await settle()
    assert.equal(query(m.container, '.lc-find-count').textContent, '0/0')
    const [prev, next] = barButtons(m.container)
    assert.ok((prev as HTMLButtonElement).disabled)
    assert.ok((next as HTMLButtonElement).disabled)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(query(m.container, '.lc-find-count').textContent, '0/0')
    await m.unmount()
  })

  test('a body swap under a live lens clamps the active index onto the shorter match list', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'one one one' }))
    const input = await openFind(m.container)
    await type(input, 'one')
    await settle()
    const [, next] = barButtons(m.container)
    await click(next)
    await click(next)
    assert.equal(query(m.container, '.lc-find-count').textContent, '3/3')
    await m.update(h(FindHarness, { text: 'one two' }))
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/1', 'the active match fell back onto the last survivor')
    assert.equal(queryAll(m.container, '.lc-find-mark-on').length, 1)
    assert.equal(rawText(m.container), 'one two', 'the new body renders its exact source')
    await m.unmount()
  })

  test('matches beyond the cap stop at 500 rendered marks and the counter admits it', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: Array(600).fill('x').join(' ') }))
    const input = await openFind(m.container)
    await type(input, 'x')
    await settle()
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 500)
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/500+')
    await m.unmount()
  })

  test('markdown mode marks the rendered body too', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: SAMPLE, mode: 'md' }))
    const input = await openFind(m.container)
    await type(input, 'bold')
    await settle()
    const marks = queryAll(query(m.container, '.lc-ts-desc-md'), '.lc-find-mark')
    assert.deepEqual(marks.map(x => x.textContent), ['bold'])
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/1')
    await m.unmount()
  })
})
