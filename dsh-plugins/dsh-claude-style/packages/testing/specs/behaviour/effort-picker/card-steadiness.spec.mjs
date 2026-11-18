/**
 * The effort card hangs from the seat box's right end — the edge the row holds
 * still — so a level's name changing width, or the card opening, moves nothing
 * the reader is pointing at.
 *
 * @capability effort-picker
 * @features effort
 * @risk The card slides sideways as levels change, so the slider moves under the pointer and the reader picks a level next to the one they aimed at.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/**
 * A frame-by-frame recording of the card's panel, the seat box, the level's slot
 * and its label; answers every frame it saw. The selectors are the surface
 * table's, handed in so the spec names no class of its own.
 */
function record(t, panel, seat, trigger, ms) {
  return t.page.evaluate(({ panelSelector, seatSelector, triggerSelector, duration }) => new Promise((resolve) => {
    const card = document.querySelector(panelSelector)
    const box = document.querySelector(seatSelector)
    const button = document.querySelector(triggerSelector)
    const label = button.firstElementChild
    const frames = []
    const until = performance.now() + duration
    const tick = () => {
      const text = document.createRange()
      text.selectNodeContents(label)
      const c = card.getBoundingClientRect()
      const s = box.getBoundingClientRect()
      const b = button.getBoundingClientRect()
      frames.push({
        cardLeft: Math.round(c.left * 10) / 10,
        cardRight: Math.round(c.right * 10) / 10,
        seatLeft: Math.round(s.left * 10) / 10,
        seatRight: Math.round(s.right * 10) / 10,
        buttonLeft: Math.round(b.left * 10) / 10,
        buttonRight: Math.round(b.right * 10) / 10,
        buttonWidth: Math.round(b.width * 10) / 10,
        labelRight: Math.round(text.getBoundingClientRect().right * 10) / 10,
        choice: label.textContent,
      })
      if (performance.now() < until) requestAnimationFrame(tick)
      else resolve(frames)
    }
    requestAnimationFrame(tick)
  }), { panelSelector: panel, seatSelector: seat, triggerSelector: trigger, duration: ms })
}

/** The value of `key` over every frame, deduplicated. */
const valuesOf = (frames, key) => [...new Set(frames.map((frame) => frame[key]))]

/** The stand-in page with the effort card open on the level it starts with. */
async function openCard(t) {
  const panel = t.surface('effort.popover')
  const seat = t.surface('model.seat')
  const trigger = t.surface('effort.trigger')
  await t.page.click(trigger)
  await t.settle()
  const frames = await record(t, panel, seat, trigger, 200)
  return { panel, seat, trigger, last: frames[frames.length - 1] }
}

export default spec({ page: 'effort' }, ({ test }) => {
  test('the card hangs from the seat box\'s right end, past the level\'s words', async (t) => {
    const { last } = await openCard(t)
    t.expectThat.equal(Math.abs(last.cardRight - last.seatRight) <= 1, true, `the card's right edge is the box's (${last.cardRight} against ${last.seatRight})`)
    // The level's own tail keeps its last glyph short of the box's edge, so a
    // card that hung from the words would stand inside the box rather than on it.
    t.expectThat.equal(last.seatRight - last.labelRight >= 1, true, `the words end inside the box (${last.labelRight} against ${last.seatRight})`)
  })

  test('a level change under the open card moves neither the card nor the box\'s right end', async (t) => {
    const { panel, seat, trigger } = await openCard(t)
    const track = await t.read.box(t.surface('effort.track'))
    const recording = record(t, panel, seat, trigger, 1600)
    await t.page.waitForTimeout(150)
    // The shortest name, then the widest: the slot takes each level's own width,
    // and the box grows leftward from an edge that does not move.
    await t.page.mouse.click(track.left + 2, track.top + track.height / 2)
    await t.page.waitForTimeout(350)
    await t.page.mouse.click(track.left + track.width * 0.33, track.top + track.height / 2)
    await t.page.waitForTimeout(350)
    await t.page.mouse.click(track.left + track.width * 0.97, track.top + track.height / 2)
    const frames = await recording
    t.expectThat.equal(valuesOf(frames, 'cardLeft').length, 1, `the card keeps one left edge (${valuesOf(frames, 'cardLeft').join(', ')})`)
    t.expectThat.equal(valuesOf(frames, 'seatRight').length, 1, `the box's right end holds (${valuesOf(frames, 'seatRight').join(', ')})`)
    t.expectThat.equal(valuesOf(frames, 'choice').length > 1, true, `the level changed (${valuesOf(frames, 'choice').join(' → ')})`)
  })
})
