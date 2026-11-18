/**
 * A drag on the effort slider that overshoots an end stop keeps following the
 * pointer: running the pointer past the track's edge is how the knob reaches
 * that stop, so clamping the travel there must not end the gesture.
 *
 * @capability effort-picker
 * @features effort
 * @risk A reader who drags to the strongest (or weakest) level cannot drag back without releasing, so the slider sticks at the extreme and the open card reads as frozen.
 */
import { spec } from '../../fixtures/behaviour.mjs'
import { openSlider } from '../../fixtures/effort-slider.mjs'

/** Let the skin's queued animation-frame write apply the pointer's last position. */
function nextFrames(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** The middle of a box, across. */
const centre = (box) => (box.left + box.right) / 2

export default spec({ page: 'effort' }, ({ test }) => {
  test('a drag past an end stop follows the pointer back', async (t) => {
    const { track, knob, y } = await openSlider(t, 4)
    await t.page.mouse.move(knob.left + knob.width / 2, y)
    await t.page.mouse.down()
    await t.page.mouse.move(track.right + 30, y, { steps: 8 })
    await nextFrames(t.page)
    const atEnd = await t.read.box(t.surface('effort.knob'))
    const endGap = Math.round(centre(atEnd) - (track.right - knob.width / 2))
    t.expectThat.equal(Math.abs(endGap) <= 1, true, `the knob reaches the end stop (${endGap}px off)`)
    t.expectThat.equal(await t.read.text(t.surface('effort.value')), 'Max', 'the name reaches the strongest level')
    await t.page.mouse.move(track.left + track.width / 2, y, { steps: 8 })
    await nextFrames(t.page)
    const back = await t.read.box(t.surface('effort.knob'))
    const backGap = Math.round(centre(back) - (track.left + track.width / 2))
    t.expectThat.equal(Math.abs(backGap) <= 1, true, `the knob comes back with the pointer (${backGap}px off)`)
    t.expectThat.equal(await t.read.text(t.surface('effort.value')), 'High', 'the name comes back with the knob')
    await t.page.mouse.up()
    await t.settle()
    t.expectThat.equal(await t.read.text(t.surface('effort.value')), 'High', 'the release commits the level under the pointer')
    t.expectThat.visible(await t.read.box(t.surface('effort.card')), 'the card stays open for a release inside it')
  })
})
