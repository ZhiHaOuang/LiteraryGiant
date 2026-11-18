/**
 * The skin's keyboard focus ring stands in only where nothing else draws one:
 * a field that declares `outline: none` for itself — what another plugin's
 * capsule input does — keeps its own edge, while a control with no focus rule
 * of its own still gets the ink ring.
 *
 * @capability focus-ring
 * @features shared
 * @risk The skin's fallback ring outranks an input's own `outline: none`, so a rounded plugin field gains a square grey box the moment the reader clicks into it.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** The ring a field shows when the keyboard has it and the field draws none itself. */
async function suppressedRing(t) {
  return t.page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = '.dsh-test-capsule-input { border: none; outline: none; background: transparent; }'
    document.head.append(style)
    const capsule = document.createElement('div')
    capsule.style.cssText = 'position:fixed;left:-9999px;top:0;border-radius:999px;padding:8px'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'dsh-test-capsule-input'
    capsule.append(input)
    document.body.append(capsule)
    input.focus({ focusVisible: true })
    const outline = getComputedStyle(input).outlineStyle
    capsule.remove()
    style.remove()
    return outline
  })
}

/** The ring a plain control shows, and the ink the skin states for it. */
async function fallbackRing(t) {
  return t.page.evaluate(() => {
    const button = document.createElement('button')
    button.textContent = 'ring'
    button.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.append(button)
    button.focus({ focusVisible: true })
    const style = getComputedStyle(button)
    const outline = { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor }
    const ink = getComputedStyle(document.body).getPropertyValue('--dsw-focus-ring-color').trim()
    button.remove()
    return { outline, ink }
  })
}

/** A colour as its channels, so the same ink spelled two ways compares equal. */
function channels(colour) {
  const numbers = colour.match(/[\d.]+/g)
  if (numbers === null) throw new Error(`not a colour: ${colour}`)
  return numbers.map(Number).join(',')
}

export default spec({ page: 'chat-fold' }, ({ test }) => {
  test('a field that suppresses its own outline keeps it', async (t) => {
    const ring = await suppressedRing(t)
    t.expectThat.equal(ring, 'none', 'the field keeps the edge its own stylesheet draws')
  })

  test('a control with no focus rule of its own gets the skin\'s ink ring', async (t) => {
    const { outline, ink } = await fallbackRing(t)
    t.expectThat.equal(outline.style, 'solid', 'a control nothing else styles shows a ring')
    t.expectThat.equal(outline.width, '2px', 'the ring is two pixels wide')
    t.expectThat.equal(channels(outline.color), channels(ink), `the ring paints the skin's own ink (${outline.color})`)
  })
})
