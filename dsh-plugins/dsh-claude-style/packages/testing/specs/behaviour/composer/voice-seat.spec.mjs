/**
 * The composer's activity slot is where a plugin mounts an entry of its own: the
 * built-in voice input puts the microphone there, and the host hands that plugin
 * the seat's width by expanding the seat around the slot. The skin stands the
 * seat down while the slot is empty and leaves it standing once something is in
 * it, so the reader's microphone is on screen in the row and an idle row keeps
 * no gap where the empty seat would stand.
 *
 * @capability composer
 * @features composer
 * @risk The microphone a reader mounts through the activity slot never appears in the composer row, or the row keeps a gap for an empty seat that holds nothing.
 */
import { spec, host } from '../../fixtures/behaviour.mjs'

/** The slot the host mounts a plugin's entry in; the seat is the box around it. */
const SLOT = host('composer.activity-slot')

export default spec({ page: 'composer' }, ({ test }) => {
  test('the entry a plugin mounts in the activity slot is on screen', async (t) => {
    /** Whether the seat stands, and the width the entry in its slot is drawn at. */
    const seat = () => t.page.evaluate((slotSelector) => {
      const slot = document.querySelector(slotSelector)
      const box = slot === null ? null : slot.parentElement
      if (box === null) return null
      const entry = slot.firstElementChild
      return {
        display: getComputedStyle(box).display,
        width: entry === null ? null : Math.round(entry.getBoundingClientRect().width),
      }
    }, SLOT)

    const empty = await seat()
    t.expectThat.equal([empty.display, empty.width], ['none', null], 'an empty activity seat takes no room in the row')

    await t.page.evaluate((slotSelector) => {
      const microphone = document.createElement('button')
      microphone.setAttribute('aria-label', 'Start recording')
      document.querySelector(slotSelector).append(microphone)
    }, SLOT)
    await t.settle()
    const filled = await seat()
    t.expectThat.equal([filled.display !== 'none', filled.width > 0], [true, true], 'the seat holding the reader\'s microphone stands in the row, the entry drawn')

    await t.page.evaluate((slotSelector) => {
      document.querySelector(slotSelector).replaceChildren()
    }, SLOT)
    await t.settle()
    const emptied = await seat()
    t.expectThat.equal([emptied.display, emptied.width], ['none', null], 'the seat stands down again once the entry leaves')
  })
})
