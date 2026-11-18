/**
 * A segmented control's highlight sits exactly under the chosen segment — the
 * one assistive technology reports as checked — at the page's own scale and
 * under the reader's page zoom alike.
 *
 * @capability segmented-control
 * @features permissions, shared
 * @risk The highlight on the access-mode switch sits under a different choice than the one in force, so the reader believes the agent runs read-only while it has full access.
 */
import { spec } from '../../fixtures/behaviour.mjs'
import { boxOf } from '../../fixtures/boxes.mjs'

/**
 * The box the control's highlight paints, read off its computed style: the
 * pseudo-element is placed at the control's padding edge and moved by its
 * transform.
 */
function highlightBox(group) {
  return group.evaluate((control) => {
    const style = getComputedStyle(control, '::before')
    if (style.content === 'none' || style.content === 'normal') return null
    const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
    const box = control.getBoundingClientRect()
    const zoom = box.width / control.offsetWidth
    const left = box.left + (control.clientLeft + matrix.m41) * zoom
    const top = box.top + (control.clientTop + matrix.m42) * zoom
    return { left, top, right: left + parseFloat(style.width) * zoom, bottom: top + parseFloat(style.height) * zoom, width: parseFloat(style.width) * zoom, height: parseFloat(style.height) * zoom }
  })
}

/** The checked segment's own box. */
async function checkedBox(page) {
  return boxOf(page.getByRole('radio', { checked: true }))
}

/** Two boxes the same to a pixel on every edge. */
function sameBox(t, actual, expected, label) {
  t.expectThat.visible(actual, `${label}: the highlight is drawn`)
  t.expectThat.boxWithin(actual, expected, label, 1)
  t.expectThat.boxWithin(expected, actual, label, 1)
}

export default spec({ page: 'automode-hero' }, ({ test }) => {
  test('the highlight sits under the checked choice', async (t) => {
    const group = t.page.getByRole('radiogroup')
    sameBox(t, await highlightBox(group), await checkedBox(t.page), 'the highlight covers the checked segment')
  })

  test('under page zoom the highlight still sits under the checked choice', async (t) => {
    await t.prefs({ pageZoom: '1.5' })
    // The zoom is what the two readings below are about, so it is judged too:
    // a preference that never reached the page would leave both readings at
    // 100% and the comparison would pass over a capability nothing exercised.
    t.expectThat.equal(await t.read.attribute('body', t.surface.attribute('skin.page-zoom')), '1.5', 'the page is drawn at 150%')
    const group = t.page.getByRole('radiogroup')
    sameBox(t, await highlightBox(group), await checkedBox(t.page), 'the highlight covers the checked segment at 150%')
    await t.prefs({ pageZoom: '0.8' })
    t.expectThat.equal(await t.read.attribute('body', t.surface.attribute('skin.page-zoom')), '0.8', 'the page is drawn at 80%')
    sameBox(t, await highlightBox(group), await checkedBox(t.page), 'the highlight covers the checked segment at 80%')
  })
})
