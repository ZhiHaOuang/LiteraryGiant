import { setAttributeIfChanged } from '@dsh-claude-style/engine/dom'

/**
 * The context meter's face (features/context-stats/meter-ring.ts,
 * session-stats.ts, context-stats.settings.ts): the ring's geometry, its arc,
 * and the three-band rule the measured face takes.
 *
 * The ring is the host's own 14 px meter box: a 5.5 px radius and a 2 px
 * stroke for the drawn ring, and a 2.2 px stroke for the face measured from
 * the reference image — 2.2 / (2 × 5.5 + 2.2) = 16.7 %, the 4.5 / 27 the image
 * carries at twice the size. The three bands break at 70 % (blue below, the
 * reference image's #257DE0) and 90 % (gold from 70, the second image's
 * #FBB315, and red from 90, #DC3C3D); the stylesheet also darkens the number's
 * ink on a light canvas, where the measured gold would not carry a 12 px
 * reading.
 */

/** The ring's viewBox, and the radius every face draws on. */
export const METER_RING_SIZE = 14
export const METER_RING_RADIUS = 5.5
/** The arc's whole length. */
export const METER_RING_CIRCUMFERENCE = 2 * Math.PI * METER_RING_RADIUS
/** Two decimals: more is noise at 14 px. */
const RING_PRECISION = 100

/** The mark the three-band face writes on the meter it colours. */
export const CONTEXT_BAND_ATTR = 'data-dsh-claude-context-band'
export const CONTEXT_BAND_BLUE = 'blue'
export const CONTEXT_BAND_YELLOW = 'yellow'
export const CONTEXT_BAND_RED = 'red'
/** Where the three bands break, as the reference's rule states them. */
export const CONTEXT_BAND_YELLOW_FLOOR = 70
export const CONTEXT_BAND_RED_FLOOR = 90

/**
 * The band one reading falls in: blue below 70 %, yellow from 70 % to under
 * 90 %, red from 90 % on.
 *
 * @param percent - the occupancy the reader sees.
 * @returns the band's name.
 */
export function contextBandAt(percent: number) {
  if (percent >= CONTEXT_BAND_RED_FLOOR) return CONTEXT_BAND_RED
  if (percent >= CONTEXT_BAND_YELLOW_FLOOR) return CONTEXT_BAND_YELLOW
  return CONTEXT_BAND_BLUE
}

/**
 * Put one reading's band on an element, or take it off when no reading can be
 * taken. A band that did not move writes nothing: this runs on each projection
 * frame while a turn streams.
 *
 * @param element - the meter whose ring and number take the band's colour.
 * @param percent - the occupancy, or null.
 */
export function writeContextBand(element: HTMLElement, percent: number | null) {
  if (percent === null) {
    if (element.hasAttribute(CONTEXT_BAND_ATTR)) element.removeAttribute(CONTEXT_BAND_ATTR)
    return
  }
  setAttributeIfChanged(element, CONTEXT_BAND_ATTR, contextBandAt(percent))
}

/**
 * One reading's arc, as the dash array the ring's fill carries: the share
 * taken, then the whole circle, so the gap is the rest.
 *
 * @param percent - the occupancy, or null while none can be taken.
 * @returns the `stroke-dasharray` value.
 */
export function ringDash(percent: number | null) {
  const whole = Math.round(METER_RING_CIRCUMFERENCE * RING_PRECISION) / RING_PRECISION
  const taken = percent === null ? 0 : Math.round(METER_RING_CIRCUMFERENCE * percent) / RING_PRECISION
  return `${taken} ${whole}`
}
