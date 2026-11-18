import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { COMPACT_HEADROOM_TOKENS, COMPACT_THRESHOLD_RATIO, reserveGeometry } from '../../src/client/reserve'

function triggerAtOrLeftOfMasks(reserve: NonNullable<ReturnType<typeof reserveGeometry>>, window: number): boolean {
  return reserve.threshold <= window - reserve.output - reserve.headroom
}

describe('reserveGeometry', () => {
  test('no positive window: no reserve', () => {
    assert.equal(reserveGeometry(undefined, 256_000), undefined)
    assert.equal(reserveGeometry(0, 256_000), undefined)
    assert.equal(reserveGeometry(-1_000, 256_000), undefined)
    assert.equal(reserveGeometry(Number.NaN, 256_000), undefined)
    assert.equal(reserveGeometry(Number.POSITIVE_INFINITY, 256_000), undefined)
  })

  test('the deepseek defaults bind the pressure budget when it is smaller; a small output cap leaves the ratio binding', () => {
    const reserve = reserveGeometry(1_000_000, 256_000)
    assert.deepEqual(reserve, { threshold: 678_464, headroom: COMPACT_HEADROOM_TOKENS, output: 256_000 })
    assert.ok(triggerAtOrLeftOfMasks(reserve!, 1_000_000))
    const ratio = reserveGeometry(1_000_000, 8_000)
    assert.deepEqual(ratio, { threshold: 800_000, headroom: COMPACT_HEADROOM_TOKENS, output: 8_000 })
    assert.equal(ratio!.threshold, Math.floor(1_000_000 * COMPACT_THRESHOLD_RATIO))
    assert.ok(triggerAtOrLeftOfMasks(ratio!, 1_000_000))
  })

  test('an unknown, non-positive, or non-finite output cap reserves no output', () => {
    const expected = { threshold: 800_000, headroom: COMPACT_HEADROOM_TOKENS, output: 0 }
    for (const cap of [undefined, 0, -8_000, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      assert.deepEqual(reserveGeometry(1_000_000, cap), expected, String(cap))
    }
    assert.deepEqual(reserveGeometry(1_000_000, 'junk' as unknown as number), expected)
  })

  test('a window too small to hold the headroom reserves nothing, as dsh refuses that route', () => {
    assert.equal(reserveGeometry(65_536, 0), undefined)
    assert.equal(reserveGeometry(65_535, 0), undefined)
    assert.equal(reserveGeometry(1_000, 200), undefined)
    assert.equal(reserveGeometry(1_000, 1_000), undefined)
    assert.equal(reserveGeometry(1_000, 5_000), undefined)
    const tight = reserveGeometry(65_537, 0)
    assert.deepEqual(tight, { threshold: 1, headroom: COMPACT_HEADROOM_TOKENS, output: 0 })
    assert.ok(triggerAtOrLeftOfMasks(tight!, 65_537))
  })
})
