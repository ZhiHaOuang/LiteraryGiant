/**
 * The context meter's three-band face: where the bands break, and the arc the
 * reading draws.
 *
 * @capability context-meter
 * @features context-stats
 * @risk The measured face turns yellow at 69 % or keeps blue at 90 %, or its arc shows a different share from the number beside it.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { contextBandAt, ringDash } from '@dsh-claude-style/client/pure'

/** The whole arc, as the ring's own geometry makes it. */
const CIRCUMFERENCE = 2 * Math.PI * 5.5

/** The two numbers a dash array carries. */
function dashOf(percent: number | null) {
  const [taken, whole] = ringDash(percent).split(' ').map(Number)
  if (whole === undefined || Number.isNaN(taken) || Number.isNaN(whole)) throw new Error(`not a dash array: ${ringDash(percent)}`)
  return { taken, whole }
}

test('the bands break at 70 and 90 percent', () => {
  expect(contextBandAt(0)).toBe('blue')
  expect(contextBandAt(69.9)).toBe('blue')
  expect(contextBandAt(70)).toBe('yellow')
  expect(contextBandAt(89.9)).toBe('yellow')
  expect(contextBandAt(90)).toBe('red')
  expect(contextBandAt(100)).toBe('red')
})

test('every reading takes the band the rule gives it', () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (percent) => {
    const expected = percent < 70 ? 'blue' : percent < 90 ? 'yellow' : 'red'
    expect(contextBandAt(percent)).toBe(expected)
  }))
})

test('the arc covers the reading, and the whole ring is the rest', () => {
  for (const percent of [0, 10, 35, 65, 90, 100]) {
    const { taken, whole } = dashOf(percent)
    expect(whole).toBeCloseTo(CIRCUMFERENCE, 2)
    expect(taken / whole).toBeCloseTo(percent / 100, 2)
  }
  expect(dashOf(null).taken).toBe(0)
})

test('a fuller context never draws a shorter arc', () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (a, b) => {
    const [low, high] = a <= b ? [a, b] : [b, a]
    expect(dashOf(high).taken).toBeGreaterThanOrEqual(dashOf(low).taken)
  }))
})
