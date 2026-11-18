/**
 * The colour band a statistics reading falls in: the segment and the position
 * inside it are what the browser mixes the figure's colour from.
 *
 * @capability context-stats
 * @features context-stats
 * @risk A cache-hit or context figure is painted in the colour of the wrong band, so a nearly full context reads as healthy or the colour jumps where it should glide.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { CACHE_HIT_STOPS, CONTEXT_STOPS, RAMP_SPAN_HIGH, RAMP_SPAN_LOW, rampPosition } from '@dsh-claude-style/client/pure'

test('a reading below the first stop saturates at the low end', () => {
  expect(rampPosition(89.9, CACHE_HIT_STOPS)).toEqual({ span: RAMP_SPAN_LOW, mix: '0%' })
  expect(rampPosition(0, CONTEXT_STOPS)).toEqual({ span: RAMP_SPAN_LOW, mix: '0%' })
})

test('a reading on a stop belongs to the segment that stop opens', () => {
  expect(rampPosition(92, CACHE_HIT_STOPS)).toEqual({ span: '1', mix: '0%' })
  expect(rampPosition(40, CONTEXT_STOPS)).toEqual({ span: '0', mix: '0%' })
})

test('a reading inside a segment lands part way along it, to a tenth of a percent', () => {
  expect(rampPosition(91, CACHE_HIT_STOPS)).toEqual({ span: '0', mix: '50%' })
  expect(rampPosition(78, CONTEXT_STOPS)).toEqual({ span: '4', mix: '75%' })
  expect(rampPosition(75, CONTEXT_STOPS)).toEqual({ span: '4', mix: '37.5%' })
})

test('a reading at or past the last stop saturates at the high end', () => {
  expect(rampPosition(99, CACHE_HIT_STOPS)).toEqual({ span: RAMP_SPAN_HIGH, mix: '0%' })
  expect(rampPosition(100, CACHE_HIT_STOPS)).toEqual({ span: RAMP_SPAN_HIGH, mix: '0%' })
  expect(rampPosition(80, CONTEXT_STOPS)).toEqual({ span: RAMP_SPAN_HIGH, mix: '0%' })
})

/** Where a position stands on the whole band, as one number to compare. */
function along(position: ReturnType<typeof rampPosition>, stops: readonly number[]) {
  if (position.span === RAMP_SPAN_LOW) return -1
  if (position.span === RAMP_SPAN_HIGH) return stops.length
  return Number(position.span) + parseFloat(position.mix) / 100
}

test('a higher reading never stands earlier on the band', () => {
  for (const stops of [CACHE_HIT_STOPS, CONTEXT_STOPS]) {
    fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), (a, b) => {
      const [low, high] = a <= b ? [a, b] : [b, a]
      expect(along(rampPosition(high, stops), stops)).toBeGreaterThanOrEqual(along(rampPosition(low, stops), stops))
    }))
  }
})

test('every mix is a percentage the browser accepts', () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (value) => {
    const { mix } = rampPosition(value, CONTEXT_STOPS)
    expect(CSS.supports('color', `color-mix(in srgb, red ${mix}, blue)`)).toBe(true)
  }))
})
