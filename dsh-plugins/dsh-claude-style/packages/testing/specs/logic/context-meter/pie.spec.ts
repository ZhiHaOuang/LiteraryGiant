/**
 * The context meter's pie: one image document whose two sectors, their radii
 * and the seam between them show how much of the context is taken.
 *
 * @capability context-meter
 * @features context-stats
 * @risk The context meter shows an empty or full pie for a half-used context, jumps by a pixel as the reading crosses half, or draws nothing because a coordinate came out NaN.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { contextPieImage } from '@dsh-claude-style/client/pure'

const TONE = 'rgb(1, 2, 3)'
const REST = 'rgba(4, 5, 6, 0.2)'
const BOX_RADIUS = 8
const SEAM = 1.2

/** The SVG document a pie value carries. */
function imageOf(percent: number) {
  const value = contextPieImage(percent, TONE, REST)
  const match = /^url\("data:image\/svg\+xml,(.*)"\)$/.exec(value)
  if (match === null) throw new Error(`not a background image: ${value}`)
  return decodeURIComponent(match[1])
}

/** The parsed document, as the browser reads it. */
function documentOf(percent: number) {
  const parsed = new DOMParser().parseFromString(imageOf(percent), 'image/svg+xml')
  expect(parsed.querySelector('parsererror')).toBeNull()
  return parsed
}

/** The radius of the arc drawn in one colour; each part is painted once. */
function radiusOf(percent: number, fill: string) {
  const path = documentOf(percent).querySelector(`path[fill="${fill}"]`)
  const match = /A ([\d.]+) [\d.]+ 0 \d 1 /.exec(path?.getAttribute('d') ?? '')
  if (match === null) throw new Error(`no arc in ${fill} at ${percent}%`)
  return Number(match[1])
}

/** Both seam strokes, in document order. */
function strokesOf(percent: number) {
  const widths = [...documentOf(percent).querySelectorAll('[stroke-width]')].map((element) => Number(element.getAttribute('stroke-width')))
  if (widths.length !== 2) throw new Error(`${widths.length} strokes at ${percent}%`)
  return widths
}

/** The colours the document paints, in paint order. */
const paintOrder = (percent: number) => [...documentOf(percent).querySelectorAll('[fill]')].map((element) => element.getAttribute('fill')).filter((fill) => fill === TONE || fill === REST)

test('a reading with nothing taken is one whole plate, cut nowhere', () => {
  expect(paintOrder(0)).toEqual([REST])
  expect(documentOf(0).querySelector('mask')).toBeNull()
})

test('a reading at its top is one whole plate in the occupied colour', () => {
  expect(paintOrder(100)).toEqual([TONE])
  expect(documentOf(100).querySelector('mask')).toBeNull()
})

test('an even split is two half discs of one radius, each cut from its own mask', () => {
  expect(documentOf(50).querySelectorAll('[mask]').length).toBe(2)
  expect(radiusOf(50, TONE)).toBe(BOX_RADIUS)
  expect(radiusOf(50, REST)).toBe(BOX_RADIUS)
  expect(strokesOf(50)).toEqual([SEAM, SEAM])
})

test('below the split the occupied sector keeps the box radius and the plate steps in', () => {
  // 20%: the pull is half the lift over 30 of the 35 points to the even split.
  const pull = 1.3 * 30 / 35
  expect(radiusOf(20, TONE)).toBe(BOX_RADIUS)
  expect(radiusOf(20, REST)).toBeCloseTo(BOX_RADIUS - pull, 2)
})

test('above the split the plate keeps the box radius and the occupied sector steps in', () => {
  const pull = 1.3 * 30 / 35
  expect(radiusOf(80, REST)).toBe(BOX_RADIUS)
  expect(radiusOf(80, TONE)).toBeCloseTo(BOX_RADIUS - pull, 2)
})

test('the two strokes share one seam by the split', () => {
  for (const percent of [10, 50, 90]) {
    const [grey, occupied] = strokesOf(percent)
    expect(grey + occupied).toBeCloseTo(SEAM * 2, 2)
  }
  expect(strokesOf(10)[0]).toBeCloseTo(SEAM * 2 * 0.9, 2)
  expect(strokesOf(10)[1]).toBeCloseTo(SEAM * 2 * 0.1, 2)
  expect(strokesOf(90)[0]).toBeCloseTo(SEAM * 2 * 0.1, 2)
  expect(strokesOf(90)[1]).toBeCloseTo(SEAM * 2 * 0.9, 2)
})

test('a reading crossing the even split moves no edge', () => {
  for (const fill of [TONE, REST]) expect(Math.abs(radiusOf(49.9, fill) - radiusOf(50.1, fill))).toBeLessThan(0.02)
  for (const stroke of [0, 1]) expect(Math.abs(strokesOf(49.9)[stroke] - strokesOf(50.1)[stroke])).toBeLessThan(0.02)
})

test('the part that stands out is painted last', () => {
  expect(paintOrder(20)).toEqual([REST, TONE])
  expect(paintOrder(80)).toEqual([TONE, REST])
})

test('every reading the meter can hold draws a well-formed image with no stray number', () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (percent) => {
    expect(imageOf(percent)).not.toMatch(/NaN|undefined|Infinity/)
    documentOf(percent)
  }))
})

test('a fuller context never draws a smaller occupied sector', () => {
  const span = (percent: number) => {
    // The occupied share, read the way the seam splits it.
    if (percent <= 0) return 0
    if (percent >= 100) return 1
    return strokesOf(percent)[1]! / (SEAM * 2)
  }
  fc.assert(fc.property(fc.double({ min: 0.5, max: 99.5, noNaN: true }), fc.double({ min: 0.5, max: 99.5, noNaN: true }), (a, b) => {
    const [low, high] = a <= b ? [a, b] : [b, a]
    expect(span(high)).toBeGreaterThanOrEqual(span(low) - 1e-9)
  }))
})
