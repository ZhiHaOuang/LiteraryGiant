/**
 * The effort picker's strongest rung shows an animated matrix of dots. It
 * plays only while its card is open and the reader lets the skin move, and
 * holds no animation at all the moment they ask for reduced motion — whether
 * they asked before opening the card or while the rung is on screen.
 *
 * @capability effort-picker
 * @features effort
 * @risk A reader who asked for reduced motion (for vestibular or seizure reasons) still gets a pulsing or strobing dot matrix when they pick the strongest thinking effort.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** Ask for reduced motion the way the settings page does, and see it reach the page. */
async function reduceMotion(t) {
  await t.prefs({ motion: 'reduced' })
  t.expectThat.equal(await t.read.attribute('body', t.surface.attribute('skin.motion')), 'reduced', 'the reduced choice reached the page')
}

/** Open the effort card from its trigger beside the model name. */
async function openCard({ page, surface, settle }) {
  await page.click(surface('effort.trigger'))
  await settle()
}

export default spec({ page: 'effort' }, ({ test }) => {
  test('the closed card runs no matrix animation', async (t) => {
    t.expectThat.absent(await t.read.animations(t.surface('effort.particle')), 'no matrix dot animates while the card is closed')
    await openCard(t)
    t.expectThat.moving(await t.read.animations(t.surface('effort.particle')), 'the matrix dots animate once the card opens')
  })

  test('the strongest rung animates its matrix while motion plays', async (t) => {
    await openCard(t)
    t.expectThat.visible(await t.read.box(t.surface('effort.card')), 'the effort card is open')
    t.expectThat.moving(await t.read.animations(t.surface('effort.particle')), 'the matrix dots animate')
  })

  test('under reduced motion the strongest rung stands still', async (t) => {
    await reduceMotion(t)
    await openCard(t)
    t.expectThat.visible(await t.read.box(t.surface('effort.card')), 'the effort card is open')
    t.expectThat.absent(await t.read.animations(t.surface('effort.particle')), 'no matrix dot carries an animation')
  })

  test('asking for reduced motion while the strongest rung shows stills it at once', async (t) => {
    await openCard(t)
    t.expectThat.moving(await t.read.animations(t.surface('effort.particle')), 'the matrix dots animate before the change')
    await reduceMotion(t)
    t.expectThat.absent(await t.read.animations(t.surface('effort.particle')), 'no matrix dot carries an animation after the change')
  })
})
