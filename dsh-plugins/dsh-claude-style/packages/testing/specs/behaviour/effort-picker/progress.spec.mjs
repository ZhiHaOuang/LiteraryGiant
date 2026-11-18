/**
 * The effort slider's name swap is driven by the knob's own travel: the old
 * name leaves in the direction of the pointer, the incoming name waits on the
 * side the knob comes from, and pulling the knob back rewinds the same two
 * layers. A name that changes at a fixed midpoint, or that always leaves
 * upward, tells the reader the wrong direction while they drag.
 *
 * @capability effort-picker
 * @features effort
 * @risk A reader dragging between two levels cannot tell which way the level is moving, so they release on a weaker or stronger effort than the one the animation promised.
 */
import { spec } from '../../fixtures/behaviour.mjs'
import { openSlider, stopX } from '../../fixtures/effort-slider.mjs'

/** Let the skin's queued animation-frame write apply the pointer's last position. */
function nextFrames(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** The swap's state as the reader sees it: the preview's opacity is the progress. */
function swapState(t, previewSelector, valueSelector) {
  return t.page.evaluate(([preview, value]) => {
    const previewEl = document.querySelector(preview)
    const valueEl = document.querySelector(value)
    const matrix = new DOMMatrixReadOnly(getComputedStyle(previewEl).transform)
    return {
      base: valueEl.textContent,
      preview: previewEl.textContent,
      baseOpacity: Number(getComputedStyle(valueEl).opacity),
      previewOpacity: Number(getComputedStyle(previewEl).opacity),
      previewY: matrix.m42,
    }
  }, [t.surface('effort.value-preview'), t.surface('effort.value')])
}

export default spec({ page: 'effort' }, ({ test }) => {
  test('the name follows the knob and rewinds when the knob comes back', async (t) => {
    const { track, knob, y, segment } = await openSlider(t, 4)

    await t.page.mouse.click(stopX(track, knob, 0), y)
    await t.settle()
    const low = await t.read.text(t.surface('effort.value'))

    await t.page.mouse.move(stopX(track, knob, 0), y)
    await t.page.mouse.down()
    await t.page.mouse.move(stopX(track, knob, 0) + segment * 0.45, y, { steps: 8 })
    await nextFrames(t.page)
    const forward = await swapState(t, t.surface('effort.value-preview'), t.surface('effort.value'))
    t.expectThat.equal(forward.base, low, 'the name on show is still the level the knobs left')
    t.expectThat.equal(forward.preview !== low, true, `the incoming name is the next level (${forward.preview})`)
    t.expectThat.equal(forward.previewOpacity > 0.1 && forward.previewOpacity < 1, true, `the incoming name is partway in (${forward.previewOpacity})`)
    t.expectThat.equal(forward.previewY > 0, true, `moving toward stronger brings the name up from below (${forward.previewY}px)`)

    await t.page.mouse.move(stopX(track, knob, 0) + segment * 0.8, y, { steps: 8 })
    await nextFrames(t.page)
    const further = await swapState(t, t.surface('effort.value-preview'), t.surface('effort.value'))
    t.expectThat.equal(further.previewOpacity > forward.previewOpacity, true, `further travel is further through the swap (${forward.previewOpacity} → ${further.previewOpacity})`)

    await t.page.mouse.move(stopX(track, knob, 0) + segment * 0.45, y, { steps: 8 })
    await nextFrames(t.page)
    const backward = await swapState(t, t.surface('effort.value-preview'), t.surface('effort.value'))
    t.expectThat.equal(backward.base, further.preview, 'the name that was arriving becomes the name that leaves')
    t.expectThat.equal(backward.preview, low, 'the incoming name is the weaker level again')
    t.expectThat.equal(backward.previewY < 0, true, `moving toward weaker brings the name down from above (${backward.previewY}px)`)

    await t.page.mouse.up()
    await t.settle()
    t.expectThat.equal(await t.read.text(t.surface('effort.value')), low, 'the release keeps the level under the pointer')
    t.expectThat.visible(await t.read.box(t.surface('effort.card')), 'the card stays open for a release inside it')
  })

  test('a click with one pixel of movement keeps the knob glide', async (t) => {
    const { track, knob, y } = await openSlider(t, 4)
    await t.page.mouse.move(stopX(track, knob, 0), y)
    await t.page.mouse.down()
    await t.page.mouse.move(stopX(track, knob, 0) + 1, y)
    await nextFrames(t.page)
    const transition = await t.page.evaluate(selector => getComputedStyle(document.querySelector(selector)).transitionProperty, t.surface('effort.knob'))
    t.expectThat.equal(transition.includes('translate'), true, `a click's incidental movement leaves the knob easing (${transition})`)
    await t.page.mouse.up()
    await t.settle()
  })

  test('the finished name settles without a second entrance', async (t) => {
    const { track, knob, y } = await openSlider(t, 4)
    const preview = t.surface('effort.value-preview')
    await t.page.mouse.click(stopX(track, knob, 0), y)
    await t.settle()
    await t.page.evaluate(selector => {
      window.__effortSwapRuns = []
      document.querySelector(selector).addEventListener('transitionrun', event => {
        window.__effortSwapRuns.push(event.propertyName)
      })
    }, preview)
    await t.page.mouse.click(stopX(track, knob, 0.97), y)
    await t.settle()
    await t.page.waitForTimeout(80)
    const runs = await t.page.evaluate(() => window.__effortSwapRuns)
    for (const property of ['opacity', 'transform', 'filter']) {
      t.expectThat.equal(runs.filter(name => name === property).length, 1, `the settled name runs its ${property} transition once (${runs.join(', ')})`)
    }
  })
})
