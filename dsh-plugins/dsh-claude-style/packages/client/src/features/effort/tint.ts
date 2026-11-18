import { effortTint } from './ladder'
import type { EffortStep } from './ladder'

/** The mark a tinted level carries, shared by the trigger and the slider. */
export const EFFORT_TINT_ATTR = 'data-tint'
/** The level's place on the ramp, in percent, as the stylesheet reads it. */
const TINT_PROPERTY = '--dsh-claude-effort-tint'

/**
 * Paint one level's place on the effort ramp onto an element. The trigger and
 * the open card's text both read the same property, so the reader sees one
 * colour in the composer and in the card. A level with no place on the ramp
 * takes the mark and the property off and keeps the resting ink.
 *
 * @param element - the element the stylesheet reads the tint from.
 * @param steps - the ladder in force.
 * @param index - the rung whose colour is wanted, or a negative index for none.
 */
export function paintEffortTint(element: HTMLElement, steps: readonly EffortStep[], index: number) {
  const tint = effortTint(steps, index)
  if (tint === null) {
    if (element.hasAttribute(EFFORT_TINT_ATTR)) element.removeAttribute(EFFORT_TINT_ATTR)
    if (element.style.getPropertyValue(TINT_PROPERTY) !== '') element.style.removeProperty(TINT_PROPERTY)
    return
  }
  if (!element.hasAttribute(EFFORT_TINT_ATTR)) element.setAttribute(EFFORT_TINT_ATTR, '')
  const percent = String(Math.round(tint * 100))
  if (element.style.getPropertyValue(TINT_PROPERTY) !== percent) element.style.setProperty(TINT_PROPERTY, percent)
}
