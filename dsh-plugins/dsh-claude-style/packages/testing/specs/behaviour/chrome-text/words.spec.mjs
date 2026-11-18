/**
 * The window's chrome is not text: a drag that starts on the sidebar's rows
 * paints no selection, while the same drag across the transcript still selects
 * the words the reader came to copy.
 *
 * @capability chrome-text
 * @features shared
 * @risk Dragging the window by the sidebar turns into word selection: the labels the pointer crosses stay washed blue, and the words the reader never meant to copy are the ones a paste carries.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** The words a drag from one box to another leaves selected, with the selection dropped again. */
async function dragAcross(t, from, to) {
  const start = await from.boundingBox()
  const end = await to.boundingBox()
  if (start === null || end === null) throw new Error('the drag needs two drawn boxes')
  await t.page.mouse.move(start.x + 6, start.y + start.height / 2)
  await t.page.mouse.down()
  await t.page.mouse.move(end.x + end.width - 6, end.y + end.height / 2, { steps: 12 })
  await t.page.mouse.up()
  const selected = await t.page.evaluate(() => window.getSelection()?.toString() ?? '')
  await t.page.evaluate(() => window.getSelection()?.removeAllRanges())
  return selected
}

export default spec({ page: 'chat-fold' }, ({ test }) => {
  test('a drag across the sidebar\'s rows paints no selection', async (t) => {
    const rows = t.page.locator(`${t.host('shell.sidebar-slot')} [role="treeitem"]`)
    const selected = await dragAcross(t, rows.first(), rows.last())
    t.expectThat.equal(selected, '', 'the sidebar\'s own words are not text the reader selects')
  })

  test('a drag across the transcript still selects its words', async (t) => {
    await t.page.evaluate((flow) => {
      const paragraph = document.createElement('p')
      paragraph.setAttribute('data-test-copyable', '')
      paragraph.textContent = 'A sentence the reader wants to copy.'
      document.querySelector(flow).append(paragraph)
      // The transcript is taller than the window: the drag happens where the reader can see the words.
      paragraph.scrollIntoView({ block: 'center' })
    }, t.host('chat.flow'))
    await t.settle()
    const paragraph = t.page.locator('[data-test-copyable]')
    const selected = await dragAcross(t, paragraph, paragraph)
    t.expectThat.equal(selected.includes('copy'), true, `the transcript keeps its own selection (${JSON.stringify(selected)})`)
  })
})
