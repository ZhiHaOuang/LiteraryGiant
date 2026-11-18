import { MOTION } from 'virtual:dsh-claude-style/generated'

/**
 * The motion tokens as the browser half reads them (D9): the values come from
 * packages/client/src/theme/tokens.json through a generated module, so a
 * duration or a curve written here and one written in a stylesheet cannot
 * drift. A name the token table does not carry throws where it is read — a
 * misspelt name is a bug, not a fallback (D12).
 *
 * Timers that wait for something other than an animation (a poll interval, a
 * grace period since the last mutation) are not motion and are declared beside
 * the feature that keeps them.
 */

export function motionValue(token: string): string {
  const value = MOTION[token]
  if (value === undefined) throw new Error(`shared/motion: the token table carries no ${token}`)
  return value
}

/** A motion token as a number of milliseconds, for `duration` and `setTimeout`. */
export function motionMs(token: string): number {
  const value = motionValue(token).trim()
  const match = /^([\d.]+)(ms|s)$/.exec(value)
  if (match === null) throw new Error(`shared/motion: ${token} is "${value}", not a duration`)
  return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1])
}

/** A motion token as an easing curve, for `easing`. */
export function motionEase(token: string): string {
  const value = motionValue(token)
  if (!value.startsWith('cubic-bezier(') && !['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear'].includes(value)) {
    throw new Error(`shared/motion: ${token} is "${value}", not an easing curve`)
  }
  return value
}

/** The curves already parsed, by token: a curve is read at most once per token. */
const CURVES = new Map<string, readonly [number, number, number, number]>()

/** A cubic-bezier token's four control points, in the form the CSS function takes them. */
function curveOf(token: string): readonly [number, number, number, number] {
  const held = CURVES.get(token)
  if (held !== undefined) return held
  const value = motionEase(token)
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value)
  const parts = match === null ? [] : match[1].split(',').map(part => Number(part.trim()))
  const [x1, y1, x2, y2] = parts
  if (parts.length !== 4 || x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined
    || ![x1, y1, x2, y2].every(Number.isFinite)) {
    throw new Error(`shared/motion: ${token} is "${value}", which has no control points to evaluate`)
  }
  const points = [x1, y1, x2, y2] as const
  CURVES.set(token, points)
  return points
}

/** One coordinate of a cubic bezier whose ends are 0 and 1. */
function bezierAt(t: number, first: number, second: number) {
  const rest = 1 - t
  return 3 * rest * rest * t * first + 3 * rest * t * t * second + t * t * t
}

/**
 * How far along a cubic-bezier token's own curve a linear progress stands: the
 * value the browser paints for an animation whose easing is that token.
 *
 * `x(t) = progress` is solved on the curve and the answer is `y(t)`. Bisection
 * assumes x rises with t, which is what the curves this table carries do; the
 * two sides have to agree, or a slide restarted from this reading would start
 * where the frame before it did not stand.
 *
 * @param token - the curve's token name.
 * @param progress - the linear share of the animation's duration, 0 to 1.
 */
export function motionEaseAt(token: string, progress: number): number {
  const [x1, y1, x2, y2] = curveOf(token)
  let low = 0
  let high = 1
  // 24 halvings put the answer within a ten-millionth, past what a pixel of
  // any of these travels can show, at a fixed cost.
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2
    if (bezierAt(middle, x1, x2) < progress) low = middle
    else high = middle
  }
  return bezierAt((low + high) / 2, y1, y2)
}
