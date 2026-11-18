/**
 * The model's name and the reasoning level still share one row item, but each
 * has its own part and its own hover plate: pointing at one does not paint the
 * other, so the two decisions read as two controls without leaving the
 * composer's single seat.
 *
 * @capability effort-picker
 * @features model, effort
 * @risk The reader cannot tell which of the two seat texts a hover or a press belongs to, and opens or changes the wrong one.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** Whether the element paints a plate rather than a transparent background. */
function paintedPlate(t, selector) {
  return t.page.evaluate((s) => {
    const colour = getComputedStyle(document.querySelector(s)).backgroundColor
    return colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent'
  }, selector)
}

export default spec({ page: 'effort' }, ({ test }) => {
  test('the name and the level answer the pointer separately', async (t) => {
    await t.prefs({ autoPopover: false })
    const seat = t.surface('model.seat')
    const model = t.surface('model.seat-model')
    const effort = t.surface('model.seat-effort')

    const structure = await t.page.evaluate(([outerSelector, modelSelector, effortSelector, modelButton, effortButton]) => {
      const outer = document.querySelector(outerSelector)
      const modelPart = document.querySelector(modelSelector)
      const effortPart = document.querySelector(effortSelector)
      return modelPart !== null && effortPart !== null && outer !== null &&
        modelPart.parentElement === outer && effortPart.parentElement === outer &&
        modelPart.querySelector(modelButton) !== null && effortPart.querySelector(effortButton) !== null
    }, [seat, model, effort, t.surface('model.trigger'), t.surface('effort.trigger')])
    t.expectThat.equal(structure, true, 'one seat holds two parts, one button each')

    await t.page.hover(model)
    await t.settle()
    t.expectThat.equal(await paintedPlate(t, model) && !(await paintedPlate(t, effort)), true, 'the name plate answers alone')

    await t.page.hover(effort)
    await t.settle()
    t.expectThat.equal(await paintedPlate(t, effort) && !(await paintedPlate(t, model)), true, 'the level plate answers alone')
  })
})
