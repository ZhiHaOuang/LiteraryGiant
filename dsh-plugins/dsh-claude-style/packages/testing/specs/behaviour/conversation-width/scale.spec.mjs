/**
 * @capability conversation-width
 * @features conversation-width, composer
 * @risk A scaled column leaves the composer or the messages' column at the host's width, scales the card's margin with it, or keeps the scale after the full width is picked again.
 */
import { spec } from '../../fixtures/behaviour.mjs'
import { hostFrame, mountConversation } from '../../fixtures/host-frame.mjs'

/**
 * A line in the scroller stands for the messages' column: the host draws it to
 * the column's width, and the composer card to that plus the host's margin.
 */
async function seatMessages(t) {
  await t.page.evaluate(([cardSelector, scrollSelector, columnWidth]) => {
    const scroller = document.querySelector(cardSelector).closest(scrollSelector)
    const line = document.createElement('div')
    line.id = 'messages-column'
    line.style.width = `var(${columnWidth})`
    scroller.prepend(line)
  }, [t.host('composer.card'), t.host('chat.scroller'), t.host('chat.content-width')])
  await t.settle()
}

/** The host's own column and the card's widest, as drawn, before any scale. */
async function hostWidths(t) {
  return t.page.evaluate(([cardSelector, lineSelector]) => ({
    column: document.querySelector(lineSelector).getBoundingClientRect().width,
    card: document.querySelector(cardSelector).getBoundingClientRect().width,
  }), [t.host('composer.card'), '#messages-column'])
}

/** The same two boxes, rounded to the pixels a reader sees. */
async function widths(t) {
  const read = await hostWidths(t)
  return { column: Math.round(read.column), card: Math.round(read.card) }
}

/** Whether every child of the conversation body but the scroller resolves the column the scroller does. */
async function bodyColumns(t) {
  return t.page.evaluate(([contentSelector, scrollSelector, columnWidth]) => {
    const content = document.querySelector(contentSelector)
    const scroller = content.querySelector(scrollSelector)
    const resolved = (element) => getComputedStyle(element).getPropertyValue(columnWidth).trim()
    const column = resolved(scroller)
    const others = [...content.children].filter((child) => child !== scroller)
    return { count: others.length, same: others.every((child) => resolved(child) === column) }
  }, [t.host('chat.content'), t.host('chat.scroller'), t.host('chat.content-width')])
}

export default spec({ page: 'composer' }, ({ test }) => {
  test('each scale draws the column and the composer at that share of the host’s width, keeping the card’s margin', async t => {
    await mountConversation(t)
    await seatMessages(t)
    const host = await hostWidths(t)
    const handles = hostFrame().conversation.siblings.length
    const share = (factor) => ({
      column: Math.round(host.column * factor),
      card: Math.round(host.card - host.column * (1 - factor)),
    })
    t.expectThat.equal(await widths(t), share(1), 'the full width is the host’s own')
    t.expectThat.equal(await bodyColumns(t), { count: handles, same: true }, 'the full width reaches the width handles beside the scroller')
    await t.prefs({ conversationWidth: '0.75' })
    t.expectThat.equal(await widths(t), share(0.75), 'three quarters scales the column and keeps the card’s margin')
    t.expectThat.equal(await bodyColumns(t), { count: handles, same: true }, 'three quarters reaches the scroller and the width handles alike')
    await t.prefs({ conversationWidth: '0.5' })
    t.expectThat.equal(await widths(t), share(0.5), 'a half scales the column and keeps the card’s margin')
    await t.prefs({ conversationWidth: '1' })
    t.expectThat.equal(await widths(t), share(1), 'going back to the full width hands the column back to the host')
  })
})
